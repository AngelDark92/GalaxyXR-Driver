//! On-demand, read-only preview. No file polling, worker process or hidden window.
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const PREVIEW_LABEL: &str = "curve-preview";
pub const CHANGED: &str = "curve-preview-changed";

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CurvePreviewState {
    pub curve: f64,
    pub constancy_pct: f64,
    pub ceiling_mbit: f64,
    pub clamp_mbit: f64,
    /// 2026-10-20: 'No fallback' fixes the streamer request at the clamp, so
    /// the curve is not applied; the window marks the fixed operating point.
    #[serde(default)]
    pub fallback_disabled: bool,
}

#[derive(Default)]
pub struct Preview {
    opening: Mutex<()>,
    snapshot: Mutex<Option<CurvePreviewState>>,
}

fn require_main(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" { Ok(()) } else { Err("Only the Companion can publish a preview".into()) }
}

// Tauri 2.12 / wry 0.57: synchronous commands run on the event loop and
// WebView2 creation can deadlock there. Async commands execute off that loop.
#[tauri::command]
pub async fn open_curve_preview(app: AppHandle, window: WebviewWindow, preview: State<'_, Preview>, locale: String, snapshot: CurvePreviewState) -> Result<(), String> {
    require_main(&window)?;
    // Serialize double clicks without holding the snapshot lock during build.
    let _opening = preview.opening.lock().map_err(|e| e.to_string())?;
    *preview.snapshot.lock().map_err(|e| e.to_string())? = Some(snapshot);
    if let Some(window) = app.get_webview_window(PREVIEW_LABEL) {
        window.emit(CHANGED, snapshot).map_err(|e| e.to_string())?;
        window.unminimize().map_err(|e| e.to_string())?;
        window.show().map_err(|e| e.to_string())?;
        return window.set_focus().map_err(|e| e.to_string());
    }
    let locale = match locale.as_str() { "ja" => "ja", "zh-Hant" => "zh-Hant", _ => "en-US" };
    let builder = WebviewWindowBuilder::new(&app, PREVIEW_LABEL, WebviewUrl::App(format!("{locale}/curve.html").into()))
        .title("Bitrate Curve")
        .inner_size(760.0, 520.0)
        .min_inner_size(480.0, 320.0)
        .resizable(true)
        .closable(true);
    // The main window has custom browser arguments. Sharing a WebView2
    // environment with different arguments can hang creation; use a separate
    // profile, created only on Open. No hidden webview is kept after close.
    #[cfg(windows)]
    let builder = builder.data_directory(app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("curve-preview-webview"));
    if let Err(error) = builder.build() {
        *preview.snapshot.lock().map_err(|e| e.to_string())? = None;
        return Err(error.to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn publish_curve_preview(window: WebviewWindow, app: AppHandle, preview: State<'_, Preview>, snapshot: CurvePreviewState) -> Result<(), String> {
    require_main(&window)?;
    if let Some(window) = app.get_webview_window(PREVIEW_LABEL) {
        *preview.snapshot.lock().map_err(|e| e.to_string())? = Some(snapshot);
        window.emit(CHANGED, snapshot).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn curve_preview_state(window: WebviewWindow, preview: State<'_, Preview>) -> Result<CurvePreviewState, String> {
    if window.label() != PREVIEW_LABEL { return Err("Not a preview window".into()); }
    preview.snapshot.lock().map_err(|e| e.to_string())?.ok_or_else(|| "Preview is closed".into())
}

#[tauri::command]
pub fn close_curve_preview(window: WebviewWindow) -> Result<(), String> {
    if window.label() != PREVIEW_LABEL { return Err("Not a preview window".into()); }
    window.close().map_err(|e| e.to_string())
}

pub fn destroyed(app: &AppHandle) {
    if let Ok(mut snapshot) = app.state::<Preview>().snapshot.lock() { *snapshot = None; }
    let _ = app.emit_to("main", "curve-preview-closed", ());
}
