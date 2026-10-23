//! On-demand bitrate curve editor. No file polling, worker process or hidden
//! window. The preview window never writes settings: pointer/numeric edits are
//! relayed to the main window, which validates and saves them.
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const PREVIEW_LABEL: &str = "curve-preview";
pub const CHANGED: &str = "curve-preview-changed";
pub const EDIT: &str = "curve-preview-edit";
pub const RESET: &str = "curve-preview-reset";

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CurvePreviewPoint {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CurvePreviewState {
    pub curve: f64,
    pub constancy_pct: f64,
    pub ceiling_mbit: f64,
    /// 2026-10-20: 'No fallback' fixes the streamer request at Max Bitrate, so
    /// the curve is not applied; the window marks the fixed operating point.
    #[serde(default)]
    pub fallback_disabled: bool,
    /// 2026-10-23: the seven displayed handles (derived for presets, the saved
    /// custom shape for Custom).
    #[serde(default)]
    pub points: Vec<CurvePreviewPoint>,
    /// True while SteamVR is running; the main page disables curve changes.
    #[serde(default)]
    pub locked: bool,
}

#[derive(Default)]
pub struct Preview {
    opening: Mutex<()>,
    snapshot: Mutex<Option<CurvePreviewState>>,
}

fn require_main(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" { Ok(()) } else { Err("Only the Companion can publish a preview".into()) }
}

fn require_preview(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == PREVIEW_LABEL { Ok(()) } else { Err("Not a preview window".into()) }
}

// Tauri 2.12 / wry 0.57: synchronous commands run on the event loop and
// WebView2 creation can deadlock there. Async commands execute off that loop.
#[tauri::command]
pub async fn open_curve_preview(app: AppHandle, window: WebviewWindow, preview: State<'_, Preview>, locale: String, snapshot: CurvePreviewState) -> Result<(), String> {
    require_main(&window)?;
    // Serialize double clicks without holding the snapshot lock during build.
    let _opening = preview.opening.lock().map_err(|e| e.to_string())?;
    *preview.snapshot.lock().map_err(|e| e.to_string())? = Some(snapshot.clone());
    if let Some(window) = app.get_webview_window(PREVIEW_LABEL) {
        window.emit(CHANGED, &snapshot).map_err(|e| e.to_string())?;
        window.unminimize().map_err(|e| e.to_string())?;
        window.show().map_err(|e| e.to_string())?;
        return window.set_focus().map_err(|e| e.to_string());
    }
    let locale = match locale.as_str() { "ja" => "ja", "zh-Hant" => "zh-Hant", _ => "en-US" };
    let builder = WebviewWindowBuilder::new(&app, PREVIEW_LABEL, WebviewUrl::App(format!("{locale}/curve.html").into()))
        .title("Bitrate Curve")
        .inner_size(760.0, 640.0)
        .min_inner_size(560.0, 420.0)
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
        *preview.snapshot.lock().map_err(|e| e.to_string())? = Some(snapshot.clone());
        window.emit(CHANGED, &snapshot).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn curve_preview_state(window: WebviewWindow, preview: State<'_, Preview>) -> Result<CurvePreviewState, String> {
    require_preview(&window)?;
    preview.snapshot.lock().map_err(|e| e.to_string())?.clone().ok_or_else(|| "Preview is closed".into())
}

#[tauri::command]
pub fn submit_curve_preview_edit(window: WebviewWindow, app: AppHandle, points: Vec<CurvePreviewPoint>) -> Result<(), String> {
    require_preview(&window)?;
    if points.len() != 7 {
        return Err("The custom bitrate curve needs exactly seven points.".into());
    }
    if points.iter().any(|point| {
        !point.x.is_finite() || !point.y.is_finite()
            || point.x < 0.0 || point.x > 1.0 || point.y < 0.0 || point.y > 1.0
    }) {
        return Err("Curve points must be finite and between 0 and 1.".into());
    }
    app.emit_to("main", EDIT, points).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn submit_curve_preview_reset(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    require_preview(&window)?;
    app.emit_to("main", RESET, ()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn close_curve_preview(window: WebviewWindow) -> Result<(), String> {
    require_preview(&window)?;
    window.close().map_err(|e| e.to_string())
}

pub fn destroyed(app: &AppHandle) {
    if let Ok(mut snapshot) = app.state::<Preview>().snapshot.lock() { *snapshot = None; }
    let _ = app.emit_to("main", "curve-preview-closed", ());
}
