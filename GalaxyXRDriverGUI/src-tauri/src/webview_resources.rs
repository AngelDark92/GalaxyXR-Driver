//! Hidden Companion views release reclaimable caches without suspending scripts.
//! Quit/flush IPC and the native OFXR arm event remain alive while in the tray.
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Webview, WebviewWindow};

#[derive(Clone, Copy, PartialEq)]
struct Request {
    background: bool,
    revision: u64,
}

#[derive(Default)]
struct Targets {
    revision: u64,
    requested: HashMap<String, Request>,
    warned: HashSet<String>,
}

impl Targets {
    fn request(&mut self, label: &str, background: bool) -> Option<Request> {
        // Newly created WebViews already use Normal. Do not issue a COM call
        // for every foreground resize or repeated restore action.
        if self.requested.get(label).map(|r| r.background).unwrap_or(false) == background {
            return None;
        }
        self.revision = self.revision.wrapping_add(1);
        let request = Request { background, revision: self.revision };
        self.requested.insert(label.to_string(), request);
        Some(request)
    }

    fn current(&self, label: &str, request: Request) -> bool {
        self.requested.get(label) == Some(&request)
    }
}

#[derive(Default)]
pub struct Resources {
    targets: Mutex<Targets>,
    background_views: Mutex<HashMap<String, bool>>,
}

/// Invalidate deferred work before a window label can be reused.
pub fn forget(app: &AppHandle, label: &str) {
    if let Ok(mut targets) = app.state::<Resources>().targets.lock() {
        targets.requested.remove(label);
        targets.warned.remove(label);
    }
    if let Ok(mut background) = app.state::<Resources>().background_views.lock() { background.remove(label); }
}

/// WebviewWindow::hide only hides the top-level native window. Also tell the
/// embedded WebView it is hidden, so document.visibilityState and the existing
/// frontend hidden-view guards work even with native occlusion detection off.
pub fn set_background(window: &WebviewWindow, background: bool) -> Result<(), String> {
    let resources = window.state::<Resources>();
    let previous = resources.background_views.lock().map_err(|e| e.to_string())?
        .get(window.label()).copied().unwrap_or(false);
    if previous == background { return Ok(()); }
    let webview: &Webview = window.as_ref();
    if background {
        webview.hide().map_err(|e| e.to_string())?;
        request_memory(window, true);
    } else {
        // Normal is explicitly restored: WebView2 does not do this itself.
        request_memory(window, false);
        webview.show().map_err(|e| e.to_string())?;
    }
    resources.background_views.lock().map_err(|e| e.to_string())?
        .insert(window.label().to_string(), background);
    Ok(())
}

#[cfg(windows)]
fn warn_once(app: &AppHandle, label: &str, error: impl std::fmt::Display) {
    let should_warn = app.state::<Resources>().targets.lock()
        .map(|mut targets| targets.warned.insert(label.to_string())).unwrap_or(false);
    if should_warn { log::warn!("WebView memory hint unavailable for {label}: {error}"); }
}

#[cfg(windows)]
fn request_memory(window: &WebviewWindow, background: bool) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL, ICoreWebView2_19,
    };
    use windows_core::Interface;

    let app = window.app_handle().clone();
    let label = window.label().to_string();
    let request = app.state::<Resources>().targets.lock().ok()
        .and_then(|mut targets| targets.request(&label, background));
    let Some(request) = request else { return; };
    let callback_app = app.clone();
    let callback_label = label.clone();
    // with_webview marshals COM access to its owning thread. Never block that
    // thread waiting on a channel, and never use TrySuspend (which pauses JS).
    if let Err(error) = window.with_webview(move |platform| {
        let current = callback_app.state::<Resources>().targets.lock()
            .map(|targets| targets.current(&callback_label, request)).unwrap_or(false);
        if !current { return; }
        let result = (|| -> windows_core::Result<()> {
            let core = unsafe { platform.controller().CoreWebView2()? };
            let memory = core.cast::<ICoreWebView2_19>()?;
            let level = COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL(if request.background { 1 } else { 0 });
            unsafe { memory.SetMemoryUsageTargetLevel(level) }
        })();
        if let Err(error) = result { warn_once(&callback_app, &callback_label, error); }
    }) {
        warn_once(&app, &label, error);
    }
}

#[cfg(not(windows))]
fn request_memory(_window: &WebviewWindow, _background: bool) {}

#[cfg(test)]
mod tests {
    use super::Targets;

    #[test]
    fn stale_hidden_hint_cannot_overwrite_restore_or_a_recreated_window() {
        let mut targets = Targets::default();
        assert!(targets.request("main", false).is_none());
        let hidden = targets.request("main", true).unwrap();
        assert!(targets.request("main", true).is_none());
        let restored = targets.request("main", false).unwrap();
        assert!(!targets.current("main", hidden));
        assert!(targets.current("main", restored));
        targets.requested.remove("main");
        let rehidden = targets.request("main", true).unwrap();
        assert!(!targets.current("main", hidden));
        assert!(!targets.current("main", restored));
        assert!(targets.current("main", rehidden));
    }
}
