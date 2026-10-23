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
    // A Close (X) prompt the Companion has not answered yet.
    pending_close_prompt: Option<u64>,
    // Retain the exact native handles, never just reusable window labels.
    hidden_secondary: Vec<HiddenSecondary>,
    next_token: u64,
    pending_quit: Option<u64>,
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
        if !self.ready || !self.minimize_to_tray || self.hidden || self.transitioning || self.pending_quit.is_some() {
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
    let hidden_secondary = {
        let mut policy = state.policy.lock().map_err(|e| e.to_string())?;
        if policy.transitioning { return Ok(()); }
        policy.transitioning = true;
        std::mem::take(&mut policy.hidden_secondary)
    };
    // Never hold a policy lock across window APIs: these can dispatch events.
    let result = (|| {
        // Restore the access path first, even when a secondary window fails.
        let main = app.get_webview_window("main").ok_or("Companion window is unavailable")?;
        main.show().map_err(|e| e.to_string())?;
        main.unminimize().map_err(|e| e.to_string())?;
        crate::webview_resources::set_background(&main, false)?;
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
    if result.is_err() { policy.hidden_secondary = hidden_secondary; }
    result
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
        let main = app.get_webview_window("main").ok_or("Companion window is unavailable")?;
        crate::webview_resources::set_background(&main, true)?;
        main.hide().map_err(|e| e.to_string())
    })();
    if let Ok(mut policy) = state.policy.lock() {
        policy.hidden = result.is_ok();
        policy.hidden_secondary = hidden_secondary;
        policy.transitioning = false;
    }
    if let Err(error) = result {
        let restore_error = restore(app).err();
        report(app, format!("Unable to hide to tray: {error}{}", restore_error.map(|e| format!("; restore failed: {e}")).unwrap_or_default()));
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
    let _syncing = state.syncing.lock().map_err(|e| e.to_string())?;
    if labels.open.trim().is_empty() || labels.quit.trim().is_empty() || labels.tooltip.trim().is_empty() {
        return Err("Tray labels must not be empty".into());
    }
    let open = MenuItem::with_id(&app, OPEN, labels.open, true, None::<&str>).map_err(|e| e.to_string())?;
    let quit = MenuItem::with_id(&app, QUIT, labels.quit, true, None::<&str>).map_err(|e| e.to_string())?;
    let menu = Menu::with_items(&app, &[&open, &quit]).map_err(|e| e.to_string())?;
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
        tray.set_tooltip(Some(labels.tooltip)).map_err(|e| e.to_string())?;
    } else {
        let icon = app.default_window_icon().ok_or("Companion tray icon is unavailable")?.clone();
        TrayIconBuilder::with_id(TRAY_ID)
            .icon(icon).tooltip(labels.tooltip).menu(&menu).show_menu_on_left_click(false)
            .on_menu_event(|app, event| match event.id.as_ref() {
                OPEN => { if let Err(error) = restore(app) { report(app, error); } }
                QUIT => request_quit(app),
                _ => {}
            })
            .on_tray_icon_event(|tray, event| {
                if matches!(event, TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. }) {
                    if let Err(error) = restore(tray.app_handle()) { report(tray.app_handle(), error); }
                }
            })
            .build(&app).map_err(|e| e.to_string())?;
    }
    let was_hidden = {
        let mut policy = state.policy.lock().map_err(|e| e.to_string())?;
        policy.ready = true;
        policy.close_action = close_action;
        policy.minimize_to_tray = minimize_to_tray;
        policy.hidden
    };
    if !minimize_to_tray && was_hidden { restore(&app)?; }
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
    use super::{CloseAction, CloseOutcome, Policy, QuitRequest};

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
