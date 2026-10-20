use tauri::{command, WebviewWindow};

/// Interface scale (2026-10-19): native webview page zoom for the Companion
/// window. The frontend owns the slider range (30-150 %); this guard only
/// rejects factors the platform cannot represent, so a bad call never
/// silently does nothing. Windows maps this to WebView2's ZoomFactor, which
/// keeps layout, popups and getBoundingClientRect in one coordinate space —
/// CSS zoom does not.
#[command]
pub fn set_webview_zoom(window: WebviewWindow, scale: f64) -> Result<(), String> {
    if !scale.is_finite() || !(0.25..=5.0).contains(&scale) {
        return Err(format!("unsupported webview zoom factor: {scale}"));
    }
    window.set_zoom(scale).map_err(|error| error.to_string())
}
