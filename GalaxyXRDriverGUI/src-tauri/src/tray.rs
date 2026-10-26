//! Companion-only lifecycle. Hiding never exits or disarms OFXR.
use serde::Deserialize;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State, WebviewWindow, WindowEvent,
};

const TRAY_ID: &str = "companion";
const OPEN: &str = "companion-open";
const QUIT: &str = "companion-quit";
const QUIT_TIMEOUT: Duration = Duration::from_secs(15);
const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
// A close prompt that never gets answered must not leave an unclosable window:
// after this delay the request falls back to the settings-flush quit.
const CLOSE_PROMPT_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone)]
struct HiddenSecondary {
    window: WebviewWindow,
    minimized: bool,
}

#[derive(Default)]
struct Policy {
    // Frontend listeners exist as soon as sync enters, even if native tray
    // creation fails. Saving on quit must not depend on tray availability.
    frontend_ready: bool,
    ready: bool,
    minimize_to_tray: bool,
    close_action: CloseAction,
    hidden: bool,
    transitioning: bool,
    restore_requested: bool,
    // A duplicate manual launch can arrive while WebView2 construction pumps
    // native messages, before Tauri registers the configured main window.
    restore_when_ready: bool,
    startup: Startup,
    // A Close (X) prompt the Companion has not answered yet.
    pending_close_prompt: Option<u64>,
    // Retain the exact native handles, never just reusable window labels.
    hidden_secondary: Vec<HiddenSecondary>,
    next_token: u64,
    pending_quit: Option<u64>,
}

#[derive(Debug, Default, PartialEq, Eq)]
enum Startup {
    #[default]
    Inactive,
    Pending,
    Hidden,
}

#[derive(Debug, PartialEq, Eq)]
enum StartupOutcome {
    Ignore,
    KeepHidden,
    Reveal,
}

#[derive(Debug, PartialEq)]
enum QuitRequest {
    Exit,
    Flush(u64),
    Pending,
}

/// Title-bar Close (X) behaviour, owned by the app settings (gui-settings.json)
/// and synchronized with the tray preferences. The window's Minimize button is
/// separate: it always minimizes and hides to tray when `minimize_to_tray` is on.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CloseAction {
    /// Ask in the Companion, defaulting to closing the app.
    #[default]
    Ask,
    /// Close (quit) without asking.
    Close,
    /// Hide to the tray; a non-tray build minimizes instead.
    Minimise,
}

/// What a CloseRequested event does, decided without touching window APIs so it
/// stays unit-testable.
#[derive(Debug, PartialEq)]
enum CloseOutcome {
    Ask,
    Quit,
    Hide,
    Minimise,
}

impl Policy {
    fn new(start_in_tray: bool) -> Self {
        Self {
            startup: if start_in_tray { Startup::Pending } else { Startup::Inactive },
            hidden: start_in_tray,
            ..Self::default()
        }
    }

    fn complete_startup(&mut self) -> StartupOutcome {
        if self.startup != Startup::Pending || self.restore_when_ready { return StartupOutcome::Ignore; }
        if !self.ready || self.pending_quit.is_some() {
            self.startup = Startup::Inactive;
            return StartupOutcome::Reveal;
        }
        self.startup = Startup::Hidden;
        self.transitioning = true;
        StartupOutcome::KeepHidden
    }

    fn cancel_pending_startup(&mut self) -> bool {
        if self.startup != Startup::Pending { return false; }
        self.startup = Startup::Inactive;
        true
    }

    fn begin_restore(&mut self, main_ready: bool) -> bool {
        if !main_ready {
            self.restore_when_ready = true;
            return false;
        }
        self.restore_when_ready = false;
        // Cancel before checking the transaction guard: an Open during hide
        // must be honored after that hide, and late startup success is inert.
        self.startup = Startup::Inactive;
        if self.transitioning {
            self.restore_requested = true;
            return false;
        }
        self.transitioning = true;
        self.restore_requested = false;
        true
    }

    fn take_deferred_restore(&mut self) -> bool {
        std::mem::take(&mut self.restore_when_ready)
    }

    fn sync_preferences(&mut self, close_action: CloseAction, minimize_to_tray: bool) -> bool {
        let reveal = self.hidden && self.minimize_to_tray && !minimize_to_tray;
        self.ready = true;
        self.close_action = close_action;
        self.minimize_to_tray = minimize_to_tray;
        reveal
    }

    /// Close-button decision. Before the frontend registers its listeners there
    /// is nobody to ask, so a CloseRequested exits exactly as it did before.
    fn close_outcome(&self) -> CloseOutcome {
        if !self.frontend_ready { return CloseOutcome::Quit; }
        match self.close_action {
            CloseAction::Ask => CloseOutcome::Ask,
            CloseAction::Close => CloseOutcome::Quit,
            CloseAction::Minimise if self.ready && self.minimize_to_tray => CloseOutcome::Hide,
            CloseAction::Minimise => CloseOutcome::Minimise,
        }
    }

    fn begin_hide(&mut self) -> bool {
        if !self.ready || !self.minimize_to_tray || self.hidden || self.transitioning || self.pending_quit.is_some() || self.startup == Startup::Pending {
            return false;
        }
        self.transitioning = true;
        true
    }

    fn begin_quit(&mut self) -> Option<u64> {
        if self.pending_quit.is_some() { return None; }
        self.next_token = self.next_token.wrapping_add(1).max(1);
        self.pending_quit = Some(self.next_token);
        self.pending_quit
    }

    /// Opens a Close prompt. A second X press while one is open is ignored.
    fn begin_close_prompt(&mut self) -> Option<u64> {
        if self.pending_close_prompt.is_some() { return None; }
        self.next_token = self.next_token.wrapping_add(1).max(1);
        self.pending_close_prompt = Some(self.next_token);
        self.pending_close_prompt
    }

    /// Retires a prompt token; stale answers from an older prompt return false.
    fn finish_close_prompt(&mut self, token: u64) -> bool {
        if self.pending_close_prompt != Some(token) { return false; }
        self.pending_close_prompt = None;
        true
    }

    fn request_quit(&mut self) -> QuitRequest {
        if !self.frontend_ready { return QuitRequest::Exit; }
        match self.begin_quit() {
            Some(token) => QuitRequest::Flush(token),
            None => QuitRequest::Pending,
        }
    }

    fn finish_quit(&mut self, token: u64) -> bool {
        if self.pending_quit != Some(token) { return false; }
        self.pending_quit = None;
        true
    }
}

#[derive(Default)]
pub struct Lifecycle {
    policy: Mutex<Policy>,
    // Serialize IPC synchronization only. Event callbacks never take this lock.
    syncing: Mutex<()>,
}

impl Lifecycle {
    pub fn new(start_in_tray: bool) -> Self {
        Self { policy: Mutex::new(Policy::new(start_in_tray)), syncing: Mutex::new(()) }
    }
}

/// Match a complete argument only; similarly named options cannot hide a
/// manually launched Companion. Both initial and duplicate launches use this.
pub fn start_in_tray_argument<I, S>(arguments: I) -> bool
where I: IntoIterator<Item = S>, S: AsRef<std::ffi::OsStr> {
    arguments.into_iter().any(|argument| argument.as_ref() == std::ffi::OsStr::new("--start-in-tray"))
}

#[derive(Deserialize)]
pub struct Labels {
    open: String,
    quit: String,
    tooltip: String,
}

fn require_main(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" { Ok(()) } else { Err("Only the Companion can change its lifecycle".into()) }
}

fn report(app: &AppHandle, error: String) {
    log::error!("Companion lifecycle: {error}");
    let _ = app.emit_to("main", "companion-lifecycle-error", error);
}

fn restore(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<Lifecycle>();
    let main = app.get_webview_window("main");
    let hidden_secondary = {
        let mut policy = state.policy.lock().map_err(|e| e.to_string())?;
        if !policy.begin_restore(main.is_some()) { return Ok(()); }
        std::mem::take(&mut policy.hidden_secondary)
    };
    // Never hold a policy lock across window APIs: these can dispatch events.
    let result = (|| {
        // Restore the access path first, even when a secondary window fails.
        let main = main.as_ref().ok_or("Companion window is unavailable")?;
        main.show().map_err(|e| e.to_string())?;
        main.unminimize().map_err(|e| e.to_string())?;
        crate::webview_resources::set_background(main, false)?;
        main.set_focus().map_err(|e| e.to_string())?;
        for hidden in &hidden_secondary {
            if app.get_webview_window(hidden.window.label()).is_some() {
                crate::webview_resources::set_background(&hidden.window, hidden.minimized)?;
                hidden.window.show().map_err(|e| e.to_string())?;
                if hidden.minimized { hidden.window.minimize() } else { hidden.window.unminimize() }.map_err(|e| e.to_string())?;
            }
        }
        main.set_focus().map_err(|e| e.to_string())
    })();
    let mut policy = state.policy.lock().map_err(|e| e.to_string())?;
    policy.hidden = false;
    policy.transitioning = false;
    policy.restore_requested = false;
    if result.is_err() { policy.hidden_secondary = hidden_secondary; }
    result
}

/// Tray Open and manual duplicate launches share the complete restore path.
pub fn open_companion(app: &AppHandle) {
    if let Err(error) = restore(app) { report(app, error); }
}

/// Application setup runs after configured windows are registered. Honor an
/// earlier manual launch before deciding whether startup still needs a timer.
pub fn restore_deferred_open(app: &AppHandle) {
    let deferred = app.state::<Lifecycle>().policy.lock()
        .map(|mut policy| policy.take_deferred_restore()).unwrap_or(false);
    if deferred { open_companion(app); }
}

fn recover_startup(app: &AppHandle, reason: String) -> Result<(), String> {
    let restore_error = restore(app).err();
    let error = format!("{reason}{}", restore_error.map(|e| format!("; restore failed: {e}")).unwrap_or_default());
    report(app, error.clone());
    Err(error)
}

pub fn start_startup_watchdog(app: &AppHandle) {
    let pending = app.state::<Lifecycle>().policy.lock()
        .map(|policy| policy.startup == Startup::Pending).unwrap_or(false);
    if !pending { return; }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(STARTUP_TIMEOUT);
        let timeout_app = app.clone();
        if let Err(error) = app.run_on_main_thread(move || {
            let timed_out = timeout_app.state::<Lifecycle>().policy.lock()
                .map(|mut policy| policy.cancel_pending_startup()).unwrap_or(false);
            if timed_out {
                let _ = recover_startup(&timeout_app, "Background startup timed out before the Companion finished initializing.".into());
            }
        }) {
            report(&app, format!("Unable to schedule background startup recovery: {error}"));
        }
    });
}

/// The frontend acknowledges only after mounting the shell, validating its
/// persisted preferences and restoring OFXR. Never suspend startup scripts.
#[tauri::command]
pub fn complete_companion_startup(window: WebviewWindow, app: AppHandle, error: Option<String>) -> Result<(), String> {
    require_main(&window)?;
    if let Some(error) = error {
        return recover_startup(&app, format!("Companion startup failed: {error}"));
    }
    let outcome = app.state::<Lifecycle>().policy.lock().map_err(|e| e.to_string())?.complete_startup();
    match outcome {
        StartupOutcome::Ignore => Ok(()),
        StartupOutcome::Reveal => recover_startup(&app, "Background startup cannot continue because the tray is not ready or a quit is pending.".into()),
        StartupOutcome::KeepHidden => {
            // The top-level window was created invisible, but its WebView was
            // left active until initialization and OFXR restoration completed.
            let result = crate::webview_resources::set_background(&window, true);
            let restore_requested = {
                let state = app.state::<Lifecycle>();
                let mut policy = state.policy.lock().map_err(|e| e.to_string())?;
                policy.transitioning = false;
                policy.restore_requested
            };
            if let Err(error) = result { return recover_startup(&app, format!("Unable to finish background startup: {error}")); }
            if restore_requested { restore(&app)?; }
            Ok(())
        }
    }
}

fn hide(app: &AppHandle) {
    let state = app.state::<Lifecycle>();
    let should_hide = state.policy.lock().map(|mut p| p.begin_hide()).unwrap_or(false);
    if !should_hide { return; }
    let mut hidden_secondary = Vec::new();
    let result: Result<(), String> = (|| {
        for label in [crate::curve_preview::PREVIEW_LABEL, crate::bitrate_monitor::WINDOW_LABEL] {
            if let Some(window) = app.get_webview_window(label) {
                if window.is_visible().map_err(|e| e.to_string())? {
                    let minimized = window.is_minimized().map_err(|e| e.to_string())?;
                    hidden_secondary.push(HiddenSecondary { window: window.clone(), minimized });
                    crate::webview_resources::set_background(&window, true)?;
                    window.hide().map_err(|e| e.to_string())?;
                }
            }
        }
        // Hiding the Companion must also stop the monitor's telemetry and ADB
        // server; do not rely on a WebView visibility event alone.
        crate::bitrate_monitor::suspend(app);
        let main = app.get_webview_window("main").ok_or("Companion window is unavailable")?;
        crate::webview_resources::set_background(&main, true)?;
        main.hide().map_err(|e| e.to_string())
    })();
    let restore_requested = if let Ok(mut policy) = state.policy.lock() {
        policy.hidden = result.is_ok();
        policy.hidden_secondary = hidden_secondary;
        policy.transitioning = false;
        policy.restore_requested
    } else { false };
    if let Err(error) = result {
        let restore_error = restore(app).err();
        report(app, format!("Unable to hide to tray: {error}{}", restore_error.map(|e| format!("; restore failed: {e}")).unwrap_or_default()));
    } else if restore_requested {
        open_companion(app);
    }
}

fn abort_quit(app: &AppHandle, token: u64, error: String) {
    let aborted = app.state::<Lifecycle>().policy.lock().map(|mut p| p.finish_quit(token)).unwrap_or(false);
    if !aborted { return; }
    // Release the frontend editing gate even if its writer is still stalled.
    // Its eventual completion must not acknowledge this retired token.
    let _ = app.emit_to("main", "companion-quit-aborted", token);
    let restore_error = restore(app).err();
    report(app, format!("{error}{}", restore_error.map(|e| format!("; restore failed: {e}")).unwrap_or_default()));
}

fn request_quit(app: &AppHandle) {
    let state = app.state::<Lifecycle>();
    let request = match state.policy.lock() {
        Ok(mut policy) => policy.request_quit(),
        Err(error) => { report(app, error.to_string()); return; }
    };
    let token = match request {
        // No frontend listener exists before synchronization starts.
        QuitRequest::Exit => { app.exit(0); return; }
        QuitRequest::Pending => return,
        QuitRequest::Flush(token) => token,
    };
    if let Err(error) = app.emit_to("main", "companion-quit-requested", token) {
        abort_quit(app, token, error.to_string());
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(QUIT_TIMEOUT);
        let timeout_app = app.clone();
        let _ = app.run_on_main_thread(move || abort_quit(&timeout_app, token, "Settings did not finish saving before the quit timeout. The Companion is still running.".into()));
    });
}

// Async IPC avoids blocking the WebView2 event loop while native menus marshal
// their creation to the main thread (Tauri 2.12).
#[tauri::command]
pub async fn sync_companion_lifecycle(window: WebviewWindow, app: AppHandle, state: State<'_, Lifecycle>, close_action: CloseAction, minimize_to_tray: bool, labels: Labels) -> Result<(), String> {
    require_main(&window)?;
    state.policy.lock().map_err(|e| e.to_string())?.frontend_ready = true;
    let result = sync_tray(&app, &state, close_action, minimize_to_tray, labels);
    if let Err(error) = result {
        let startup_hidden = {
            let mut policy = state.policy.lock().map_err(|e| e.to_string())?;
            policy.ready = false;
            policy.startup != Startup::Inactive
        };
        if startup_hidden { return recover_startup(&app, format!("Background startup tray synchronization failed: {error}")); }
        return Err(error);
    }
    Ok(())
}

fn sync_tray(app: &AppHandle, state: &Lifecycle, close_action: CloseAction, minimize_to_tray: bool, labels: Labels) -> Result<(), String> {
    let _syncing = state.syncing.lock().map_err(|e| e.to_string())?;
    if labels.open.trim().is_empty() || labels.quit.trim().is_empty() || labels.tooltip.trim().is_empty() {
        return Err("Tray labels must not be empty".into());
    }
    let open = MenuItem::with_id(app, OPEN, labels.open, true, None::<&str>).map_err(|e| e.to_string())?;
    let quit = MenuItem::with_id(app, QUIT, labels.quit, true, None::<&str>).map_err(|e| e.to_string())?;
    let menu = Menu::with_items(app, &[&open, &quit]).map_err(|e| e.to_string())?;
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
        tray.set_tooltip(Some(labels.tooltip)).map_err(|e| e.to_string())?;
    } else {
        let icon = app.default_window_icon().ok_or("Companion tray icon is unavailable")?.clone();
        TrayIconBuilder::with_id(TRAY_ID)
            .icon(icon).tooltip(labels.tooltip).menu(&menu).show_menu_on_left_click(false)
            .on_menu_event(|app, event| match event.id.as_ref() {
                OPEN => open_companion(app),
                QUIT => request_quit(app),
                _ => {}
            })
            .on_tray_icon_event(|tray, event| {
                if matches!(event, TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. }) {
                    open_companion(tray.app_handle());
                }
            })
            .build(app).map_err(|e| e.to_string())?;
    }
    let reveal = {
        let mut policy = state.policy.lock().map_err(|e| e.to_string())?;
        policy.sync_preferences(close_action, minimize_to_tray)
    };
    if reveal { restore(app)?; }
    Ok(())
}

#[tauri::command]
pub fn complete_companion_quit(window: WebviewWindow, app: AppHandle, state: State<'_, Lifecycle>, token: u64, error: Option<String>) -> Result<(), String> {
    require_main(&window)?;
    if let Some(error) = error {
        abort_quit(&app, token, error);
        return Ok(());
    }
    let accepted = state.policy.lock().map_err(|e| e.to_string())?.finish_quit(token);
    if !accepted { return Err("Quit request is no longer pending".into()); }
    app.exit(0);
    Ok(())
}

/// Emits the Close prompt with a token and guarantees an answer path: a prompt
/// that is never answered (listener gone or wedged) falls back to the normal
/// settings-flush quit, so the X can never become a silent no-op.
fn ask_to_close(app: &AppHandle) {
    let token = match app.state::<Lifecycle>().policy.lock() {
        Ok(mut policy) => policy.begin_close_prompt(),
        Err(error) => { report(app, error.to_string()); return; }
    };
    // None means a prompt is already open; the second X press is ignored.
    let Some(token) = token else { return; };
    if let Err(error) = app.emit_to("main", "companion-close-requested", token) {
        report(app, error.to_string());
        if let Ok(mut policy) = app.state::<Lifecycle>().policy.lock() { policy.finish_close_prompt(token); }
        request_quit(app);
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(CLOSE_PROMPT_TIMEOUT);
        let timeout_app = app.clone();
        let _ = app.run_on_main_thread(move || {
            let unanswered = timeout_app.state::<Lifecycle>().policy.lock()
                .map(|mut policy| policy.finish_close_prompt(token))
                .unwrap_or(false);
            if unanswered { request_quit(&timeout_app); }
        });
    });
}

/// The Companion's own close confirmation resolves a `companion-close-requested`
/// event through this command; it reuses the settings-flush quit path.
#[tauri::command]
pub fn request_companion_quit(window: WebviewWindow, app: AppHandle, state: State<'_, Lifecycle>, token: u64) -> Result<(), String> {
    require_main(&window)?;
    if !state.policy.lock().map_err(|e| e.to_string())?.finish_close_prompt(token) {
        return Err("Close request is no longer pending".into());
    }
    request_quit(&app);
    Ok(())
}

/// Cancelling the Close prompt retires its token so the timeout cannot quit later.
#[tauri::command]
pub fn dismiss_companion_close(window: WebviewWindow, state: State<'_, Lifecycle>, token: u64) -> Result<(), String> {
    require_main(&window)?;
    state.policy.lock().map_err(|e| e.to_string())?.finish_close_prompt(token);
    Ok(())
}

pub fn window_event(app: &AppHandle, label: &str, event: &WindowEvent) {
    if matches!(event, WindowEvent::Destroyed) { crate::webview_resources::forget(app, label); }
    // Visibility changes can produce nested resize notifications. Complete the
    // hide/restore transaction before interpreting another visibility change.
    if matches!(event, WindowEvent::Resized(_))
        && app.state::<Lifecycle>().policy.lock().map(|p| p.transitioning).unwrap_or(false) { return; }
    if label == crate::curve_preview::PREVIEW_LABEL || label == crate::bitrate_monitor::WINDOW_LABEL {
        if matches!(event, WindowEvent::Destroyed) {
            // A subsequent window using this label is not the one we hid.
            if let Ok(mut policy) = app.state::<Lifecycle>().policy.lock() {
                policy.hidden_secondary.retain(|hidden| hidden.window.label() != label);
            }
        }
        if matches!(event, WindowEvent::Resized(_)) {
            if let Some(window) = app.get_webview_window(label) {
                if let Ok(minimized) = window.is_minimized() {
                    let hidden = !window.is_visible().unwrap_or(true);
                    if let Err(error) = crate::webview_resources::set_background(&window, minimized || hidden) { report(app, error); }
                }
            }
        }
        return;
    }
    if label != "main" { return; }
    match event {
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let outcome = app.state::<Lifecycle>().policy.lock()
                .map(|policy| policy.close_outcome())
                .unwrap_or(CloseOutcome::Quit);
            match outcome {
                // The Companion asks in its own dialog and answers with
                // request_companion_quit; a missing listener (window gone) still exits.
                CloseOutcome::Ask => ask_to_close(app),
                CloseOutcome::Quit => request_quit(app),
                CloseOutcome::Hide => hide(app),
                CloseOutcome::Minimise => {
                    if let Some(window) = app.get_webview_window("main") {
                        if let Err(error) = window.minimize() { report(app, error.to_string()); }
                    }
                }
            }
        }
        WindowEvent::Resized(_) => {
            if let Some(window) = app.get_webview_window("main") {
                // Invisible startup is only a native-window state until the
                // frontend has completed its readiness handshake.
                let startup_pending = app.state::<Lifecycle>().policy.lock()
                    .map(|policy| policy.startup == Startup::Pending).unwrap_or(false);
                if startup_pending { return; }
                if let Ok(minimized) = window.is_minimized() {
                    if minimized { hide(app); }
                    // Also reduce ordinary taskbar-minimized views when tray
                    // behavior is disabled, and restore Normal on activation.
                    let hidden = !window.is_visible().unwrap_or(true);
                    if let Err(error) = crate::webview_resources::set_background(&window, minimized || hidden) { report(app, error); }
                }
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::{start_in_tray_argument, CloseAction, CloseOutcome, Policy, QuitRequest, Startup, StartupOutcome};

    #[test]
    fn background_launch_matches_only_the_exact_argument() {
        assert!(start_in_tray_argument(["Companion.exe", "--start-in-tray"]));
        assert!(start_in_tray_argument(vec![String::from("--start-in-tray")]));
        assert!(!start_in_tray_argument(["Companion.exe"]));
        assert!(!start_in_tray_argument(["--start-in-tray=true", "--start-in-tray-other", "--START-IN-TRAY"]));
    }

    #[test]
    fn startup_hidden_is_independent_of_persisted_minimize_preference() {
        let mut policy = Policy::new(true);
        assert!(policy.hidden);
        assert_eq!(policy.startup, Startup::Pending);
        assert!(!policy.sync_preferences(CloseAction::Ask, false));
        assert_eq!(policy.complete_startup(), StartupOutcome::KeepHidden);
        policy.transitioning = false;
        assert_eq!(policy.startup, Startup::Hidden);
        assert!(!policy.minimize_to_tray);
        assert!(!policy.sync_preferences(CloseAction::Ask, false));
        assert!(policy.hidden);
        assert!(!policy.cancel_pending_startup());
        assert_eq!(policy.complete_startup(), StartupOutcome::Ignore);
        assert!(!policy.sync_preferences(CloseAction::Ask, true));
        // An explicit later opt-out still restores an already hidden window.
        assert!(policy.sync_preferences(CloseAction::Ask, false));
    }

    #[test]
    fn manual_launch_never_enters_startup_hiding() {
        let mut policy = Policy::new(false);
        assert!(!policy.hidden);
        assert_eq!(policy.startup, Startup::Inactive);
        assert!(!policy.cancel_pending_startup());
        policy.sync_preferences(CloseAction::Ask, true);
        assert_eq!(policy.complete_startup(), StartupOutcome::Ignore);
        assert!(!policy.hidden);
    }

    #[test]
    fn timeout_or_failed_startup_retires_late_success() {
        let mut policy = Policy::new(true);
        policy.sync_preferences(CloseAction::Ask, true);
        assert!(policy.cancel_pending_startup());
        assert!(!policy.cancel_pending_startup());
        assert_eq!(policy.complete_startup(), StartupOutcome::Ignore);
        assert!(policy.begin_restore(true));
        assert_eq!(policy.startup, Startup::Inactive);

        // No tray readiness (including failed synchronization) cannot leave
        // the background window hidden after a frontend success response.
        let mut failed = Policy::new(true);
        assert_eq!(failed.complete_startup(), StartupOutcome::Reveal);
        assert_eq!(failed.complete_startup(), StartupOutcome::Ignore);
        assert!(!failed.cancel_pending_startup());
    }

    #[test]
    fn manual_open_cancels_pending_startup_and_late_watchdog() {
        let mut policy = Policy::new(true);
        policy.sync_preferences(CloseAction::Ask, false);
        assert!(policy.begin_restore(true));
        assert_eq!(policy.startup, Startup::Inactive);
        assert_eq!(policy.complete_startup(), StartupOutcome::Ignore);
        assert!(!policy.cancel_pending_startup());
    }

    #[test]
    fn manual_open_during_startup_or_tray_hide_is_queued() {
        let mut startup = Policy::new(true);
        startup.sync_preferences(CloseAction::Ask, false);
        assert_eq!(startup.complete_startup(), StartupOutcome::KeepHidden);
        assert!(!startup.begin_restore(true));
        assert!(startup.restore_requested);
        assert_eq!(startup.startup, Startup::Inactive);
        startup.transitioning = false;
        assert!(startup.begin_restore(true));
        assert!(!startup.restore_requested);
        assert_eq!(startup.complete_startup(), StartupOutcome::Ignore);

        let mut tray = Policy::new(false);
        tray.sync_preferences(CloseAction::Ask, true);
        assert!(tray.begin_hide());
        assert!(!tray.begin_restore(true));
        assert!(tray.restore_requested);
        tray.transitioning = false;
        assert!(tray.begin_restore(true));
    }

    #[test]
    fn manual_open_before_main_exists_waits_for_setup_without_disarming_startup() {
        let mut policy = Policy::new(true);
        assert!(!policy.begin_restore(false));
        assert!(!policy.begin_restore(false));
        assert!(policy.restore_when_ready);
        assert!(policy.hidden);
        assert!(!policy.transitioning);
        assert_eq!(policy.startup, Startup::Pending);
        policy.sync_preferences(CloseAction::Ask, false);
        // Even readiness arriving before setup cannot hide against Open.
        assert_eq!(policy.complete_startup(), StartupOutcome::Ignore);
        assert_eq!(policy.startup, Startup::Pending);
        // Setup drains the one deferred intent after main is registered.
        assert!(policy.take_deferred_restore());
        assert!(!policy.take_deferred_restore());
        assert!(policy.begin_restore(true));
        assert_eq!(policy.startup, Startup::Inactive);
        assert!(!policy.restore_when_ready);
        assert!(!policy.cancel_pending_startup());
        assert_eq!(policy.complete_startup(), StartupOutcome::Ignore);
    }

    #[test]
    fn missing_main_also_defers_manual_startup_and_keeps_timeout_recovery_available() {
        let mut manual = Policy::new(false);
        assert!(!manual.begin_restore(false));
        assert_eq!(manual.startup, Startup::Inactive);
        assert!(!manual.hidden);
        assert!(manual.take_deferred_restore());
        assert!(manual.begin_restore(true));

        let mut background = Policy::new(true);
        assert!(!background.begin_restore(false));
        assert!(background.cancel_pending_startup());
        assert!(background.restore_when_ready);
        assert_eq!(background.complete_startup(), StartupOutcome::Ignore);
    }

    #[test]
    fn pending_startup_cannot_hide_again_or_bypass_quit_in_progress() {
        let mut policy = Policy::new(true);
        policy.sync_preferences(CloseAction::Ask, true);
        assert!(!policy.begin_hide());
        policy.begin_quit();
        assert_eq!(policy.complete_startup(), StartupOutcome::Reveal);
        assert_eq!(policy.startup, Startup::Inactive);
        assert_eq!(policy.complete_startup(), StartupOutcome::Ignore);
    }

    #[test]
    fn close_prompt_tokens_ignore_repeats_and_stale_answers() {
        let mut policy = Policy::default();
        let token = policy.begin_close_prompt().unwrap();
        // A second X press while the prompt is open is ignored.
        assert!(policy.begin_close_prompt().is_none());
        // An answer for another prompt cannot retire this one.
        assert!(!policy.finish_close_prompt(token + 1));
        assert_eq!(policy.pending_close_prompt, Some(token));
        assert!(policy.finish_close_prompt(token));
        assert_eq!(policy.pending_close_prompt, None);
        assert!(!policy.finish_close_prompt(token));
        // A retired prompt never blocks the settings-flush quit behind it.
        // The prompt already consumed token 1, so the quit request is next.
        policy.frontend_ready = true;
        assert_eq!(policy.request_quit(), QuitRequest::Flush(2));
    }

    #[test]
    fn close_button_action_decides_ask_close_hide_or_minimise() {
        let mut policy = Policy::default();
        // Before the frontend listens there is nobody to ask.
        assert_eq!(policy.close_outcome(), CloseOutcome::Quit);
        policy.frontend_ready = true;
        assert_eq!(policy.close_action, CloseAction::Ask);
        assert_eq!(policy.close_outcome(), CloseOutcome::Ask);
        policy.close_action = CloseAction::Close;
        assert_eq!(policy.close_outcome(), CloseOutcome::Quit);
        policy.close_action = CloseAction::Minimise;
        // No usable tray yet: minimize instead of hiding an unreachable window.
        assert_eq!(policy.close_outcome(), CloseOutcome::Minimise);
        policy.minimize_to_tray = true;
        assert_eq!(policy.close_outcome(), CloseOutcome::Minimise);
        policy.ready = true;
        assert_eq!(policy.close_outcome(), CloseOutcome::Hide);
        policy.minimize_to_tray = false;
        assert_eq!(policy.close_outcome(), CloseOutcome::Minimise);
    }

    #[test]
    fn early_close_exits_but_tray_failure_still_flushes_frontend_settings() {
        let mut policy = Policy::default();
        assert_eq!(policy.request_quit(), QuitRequest::Exit);
        assert_eq!(policy.pending_quit, None);
        // The sync entry marks the frontend ready before tray creation; a
        // failed icon/menu build leaves hide readiness false.
        policy.frontend_ready = true;
        policy.minimize_to_tray = true;
        assert!(!policy.ready);
        assert!(!policy.begin_hide());
        assert_eq!(policy.request_quit(), QuitRequest::Flush(1));
        assert_eq!(policy.request_quit(), QuitRequest::Pending);
        assert!(policy.finish_quit(1));
        assert_eq!(policy.request_quit(), QuitRequest::Flush(2));
    }

    #[test]
    fn hiding_requires_synchronized_settings_and_explicit_opt_in() {
        let mut policy = Policy::default();
        assert!(!policy.begin_hide());
        policy.minimize_to_tray = true;
        assert!(!policy.begin_hide());
        policy.ready = true;
        assert!(policy.begin_hide());
        assert!(!policy.begin_hide());
        policy.transitioning = false;
        policy.hidden = true;
        assert!(!policy.begin_hide());
        policy.hidden = false;
        policy.minimize_to_tray = false;
        assert!(!policy.begin_hide());
    }

    #[test]
    fn duplicate_quit_and_stale_ack_cannot_complete_a_later_request() {
        let mut policy = Policy::default();
        policy.ready = true;
        policy.minimize_to_tray = true;
        let first = policy.begin_quit().unwrap();
        assert!(policy.begin_quit().is_none());
        assert!(!policy.begin_hide());
        assert!(!policy.finish_quit(first + 1));
        assert!(policy.finish_quit(first));
        let second = policy.begin_quit().unwrap();
        assert_ne!(first, second);
        assert!(!policy.finish_quit(first));
        assert_eq!(policy.pending_quit, Some(second));
        assert!(policy.finish_quit(second));
    }
}
