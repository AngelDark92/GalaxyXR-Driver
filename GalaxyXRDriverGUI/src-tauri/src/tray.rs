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

#[derive(Clone)]
struct HiddenPreview {
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
    hidden: bool,
    transitioning: bool,
    // Retain the exact native handle, never just a reusable window label.
    hidden_preview: Option<HiddenPreview>,
    next_token: u64,
    pending_quit: Option<u64>,
}

#[derive(Debug, PartialEq)]
enum QuitRequest {
    Exit,
    Flush(u64),
    Pending,
}

impl Policy {
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
    let hidden_preview = {
        let mut policy = state.policy.lock().map_err(|e| e.to_string())?;
        if policy.transitioning { return Ok(()); }
        policy.transitioning = true;
        policy.hidden_preview.take()
    };
    // Never hold a policy lock across window APIs: these can dispatch events.
    let result = (|| {
        // Restore the access path first, even when the secondary window fails.
        let main = app.get_webview_window("main").ok_or("Companion window is unavailable")?;
        main.show().map_err(|e| e.to_string())?;
        main.unminimize().map_err(|e| e.to_string())?;
        crate::webview_resources::set_background(&main, false)?;
        main.set_focus().map_err(|e| e.to_string())?;
        if let Some(preview) = hidden_preview.as_ref() {
            if app.get_webview_window(crate::curve_preview::PREVIEW_LABEL).is_some() {
                crate::webview_resources::set_background(&preview.window, preview.minimized)?;
                preview.window.show().map_err(|e| e.to_string())?;
                if preview.minimized { preview.window.minimize() } else { preview.window.unminimize() }.map_err(|e| e.to_string())?;
            }
        }
        main.set_focus().map_err(|e| e.to_string())
    })();
    let mut policy = state.policy.lock().map_err(|e| e.to_string())?;
    policy.hidden = false;
    policy.transitioning = false;
    if result.is_err() { policy.hidden_preview = hidden_preview; }
    result
}

fn hide(app: &AppHandle) {
    let state = app.state::<Lifecycle>();
    let should_hide = state.policy.lock().map(|mut p| p.begin_hide()).unwrap_or(false);
    if !should_hide { return; }
    let mut hidden_preview = None;
    let result: Result<(), String> = (|| {
        if let Some(preview) = app.get_webview_window(crate::curve_preview::PREVIEW_LABEL) {
            if preview.is_visible().map_err(|e| e.to_string())? {
                let minimized = preview.is_minimized().map_err(|e| e.to_string())?;
                hidden_preview = Some(HiddenPreview { window: preview.clone(), minimized });
                crate::webview_resources::set_background(&preview, true)?;
                preview.hide().map_err(|e| e.to_string())?;
            }
        }
        let main = app.get_webview_window("main").ok_or("Companion window is unavailable")?;
        crate::webview_resources::set_background(&main, true)?;
        main.hide().map_err(|e| e.to_string())
    })();
    if let Ok(mut policy) = state.policy.lock() {
        policy.hidden = result.is_ok();
        policy.hidden_preview = hidden_preview;
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
pub async fn sync_companion_lifecycle(window: WebviewWindow, app: AppHandle, state: State<'_, Lifecycle>, minimize_to_tray: bool, labels: Labels) -> Result<(), String> {
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

pub fn window_event(app: &AppHandle, label: &str, event: &WindowEvent) {
    if matches!(event, WindowEvent::Destroyed) { crate::webview_resources::forget(app, label); }
    // Visibility changes can produce nested resize notifications. Complete the
    // hide/restore transaction before interpreting another visibility change.
    if matches!(event, WindowEvent::Resized(_))
        && app.state::<Lifecycle>().policy.lock().map(|p| p.transitioning).unwrap_or(false) { return; }
    if label == crate::curve_preview::PREVIEW_LABEL {
        if matches!(event, WindowEvent::Destroyed) {
            // A subsequent preview using this label is not the window we hid.
            if let Ok(mut policy) = app.state::<Lifecycle>().policy.lock() { policy.hidden_preview = None; }
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
            let hide_enabled = app.state::<Lifecycle>().policy.lock().map(|p| p.ready && p.minimize_to_tray).unwrap_or(false);
            if hide_enabled { hide(app); } else { request_quit(app); }
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
    use super::{Policy, QuitRequest};

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
