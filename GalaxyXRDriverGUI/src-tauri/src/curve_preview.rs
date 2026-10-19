//! 2026-10-19 bitrate curve preview window.
//!
//! The graph lives in its own resizable window so it can be watched while the
//! Stream Frame page is edited. The window is built hidden during startup
//! (`install`) and only shown or hidden afterwards: building a webview inside an
//! IPC handler deadlocks on Windows (wry#583), so nothing here creates windows
//! from a command except as a last-resort async fallback.
//!
//! `curve_preview_state` resolves the same values the driver would use:
//!   ceiling = nvencBitrateMbit, else nvencBandwidthOverrideMbit, else
//!             galaxyXr.customBandwidthMbit, else 350
//!   clamp   = nvencVrlinkClampMbit, else 350
// Read-only: it never writes settings.
use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub const PREVIEW_LABEL: &str = "curve-preview";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurvePreviewState {
    pub curve: i64,
    pub constancy_pct: i64,
    pub ceiling_mbit: i64,
    pub clamp_mbit: i64,
}

fn data_dir() -> Result<PathBuf, String> {
    let appdata = std::env::var_os("APPDATA").ok_or("APPDATA is unavailable")?;
    Ok(PathBuf::from(appdata).join("GalaxyXR").join("CustomHeadset"))
}

fn int_at(value: Option<&serde_json::Value>, key: &str, default: i64) -> i64 {
    value
        .and_then(|object| object.get(key))
        .and_then(|entry| entry.as_i64())
        .unwrap_or(default)
}

/// Resolution mirrors FrameProcessor::UpdateEncoderSettings + GalaxyXR.cpp.
/// Values are returned as saved: the preview shows what the driver was asked
/// for, never a silently substituted default.
pub fn resolve_state(settings: &serde_json::Value) -> CurvePreviewState {
    let stream_frame = settings.get("streamFrame");
    let galaxy = settings.get("galaxyXr");
    let bitrate = int_at(stream_frame, "nvencBitrateMbit", 0);
    let override_mbit = int_at(stream_frame, "nvencBandwidthOverrideMbit", 0);
    let custom = int_at(galaxy, "customBandwidthMbit", 0);
    let ceiling = if bitrate != 0 {
        bitrate
    } else if override_mbit != 0 {
        override_mbit
    } else if custom != 0 {
        custom
    } else {
        350
    };
    let clamp = int_at(stream_frame, "nvencVrlinkClampMbit", 350);
    CurvePreviewState {
        curve: int_at(stream_frame, "nvencBitrateCurve", 0),
        constancy_pct: int_at(stream_frame, "nvencBitrateConstancyPct", 0),
        ceiling_mbit: ceiling,
        // A non-positive clamp is refused by the driver unless constancy is
        // 100; drawing against vrlink's 350 keeps the graph meaningful there.
        clamp_mbit: if clamp > 0 { clamp } else { 350 },
    }
}

#[tauri::command]
pub fn curve_preview_state() -> Result<CurvePreviewState, String> {
    let path = data_dir()?.join("settings.json");
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        // A fresh install has no file yet: the driver's defaults apply.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(resolve_state(&serde_json::json!({})));
        }
        Err(error) => return Err(format!("{}: {error}", path.display())),
    };
    let settings: serde_json::Value = serde_json::from_str(&text)
        .map_err(|error| format!("{} is not valid JSON: {error}", path.display()))?;
    Ok(resolve_state(&settings))
}

#[tauri::command]
pub fn is_curve_preview_window(window: tauri::WebviewWindow) -> bool {
    window.label() == PREVIEW_LABEL
}

/// Creates the graph window once, hidden, while the app is starting.
///
/// Windows deadlocks if a webview window is built from a synchronous command
/// (wry#583: `create_controller`'s completion never runs on the IPC thread), so
/// the window is built here — the same place Tauri builds the main window —
/// and later only shown or hidden. Closing it hides it; the app exits when the
/// main window closes.
pub fn install(app: &AppHandle) {
    if app.get_webview_window(PREVIEW_LABEL).is_some() {
        return;
    }
    // Reuse the URL shape the main window already loaded: <locale>/index.html.
    let Some(main) = app.get_webview_window("main") else {
        return;
    };
    let Ok(url) = main.url() else { return };
    let path = url.path().trim_start_matches('/').to_string();
    let path = if path.is_empty() || !path.ends_with("index.html") {
        "en-US/index.html".to_string()
    } else {
        path
    };
    let built = WebviewWindowBuilder::new(app, PREVIEW_LABEL, WebviewUrl::App(path.into()))
        .title("Bitrate Curve")
        .inner_size(760.0, 520.0)
        .min_inner_size(480.0, 320.0)
        .resizable(true)
        .closable(true)
        .visible(false)
        .initialization_script("window.__GXR_CURVE_PREVIEW__ = true;")
        .build();
    if let Ok(window) = built {
        let target = window.clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Hiding keeps the loaded page; recreating a webview at runtime
                // is the path that deadlocks on Windows.
                api.prevent_close();
                let _ = target.hide();
            }
        });
    }
}

#[tauri::command]
pub async fn open_curve_preview(app: AppHandle, locale: String) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(PREVIEW_LABEL) {
        window.show().map_err(|error| error.to_string())?;
        return window.set_focus().map_err(|error| error.to_string());
    }
    // Only reachable if install() could not create the window. Building here is
    // the documented async path, never a synchronous command.
    let locale = if !locale.is_empty()
        && locale.len() <= 16
        && locale.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        locale
    } else {
        "en-US".to_string()
    };
    WebviewWindowBuilder::new(
        &app,
        PREVIEW_LABEL,
        WebviewUrl::App(format!("{locale}/index.html").into()),
    )
    .title("Bitrate Curve")
    .inner_size(760.0, 520.0)
    .min_inner_size(480.0, 320.0)
    .resizable(true)
    .closable(true)
    .initialization_script("window.__GXR_CURVE_PREVIEW__ = true;")
    .build()
    .map(|_| ())
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn close_curve_preview(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(PREVIEW_LABEL) {
        return window.hide().map_err(|error| error.to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn empty_settings_use_pre_curve_defaults() {
        let state = resolve_state(&json!({}));
        assert_eq!(state.curve, 0);
        assert_eq!(state.constancy_pct, 0);
        assert_eq!(state.ceiling_mbit, 350);
        assert_eq!(state.clamp_mbit, 350);
    }

    #[test]
    fn ceiling_precedence_matches_the_driver() {
        let settings = json!({
            "streamFrame": {"nvencBitrateMbit": 0, "nvencBandwidthOverrideMbit": 400},
            "galaxyXr": {"customBandwidthMbit": 450}
        });
        assert_eq!(resolve_state(&settings).ceiling_mbit, 400);
        let settings = json!({
            "streamFrame": {"nvencBitrateMbit": 0, "nvencBandwidthOverrideMbit": 0},
            "galaxyXr": {"customBandwidthMbit": 450}
        });
        assert_eq!(resolve_state(&settings).ceiling_mbit, 450);
        let settings = json!({"streamFrame": {"nvencBitrateMbit": 500}});
        assert_eq!(resolve_state(&settings).ceiling_mbit, 500);
    }

    #[test]
    fn explicit_curve_and_percentage_are_reported_unchanged() {
        let settings = json!({
            "streamFrame": {"nvencBitrateCurve": 2, "nvencBitrateConstancyPct": 35, "nvencVrlinkClampMbit": 280},
            "galaxyXr": {"customBandwidthMbit": 450}
        });
        let state = resolve_state(&settings);
        assert_eq!(state.curve, 2);
        assert_eq!(state.constancy_pct, 35);
        assert_eq!(state.clamp_mbit, 280);
        assert_eq!(state.ceiling_mbit, 450);
    }

    #[test]
    fn non_positive_clamp_falls_back_for_drawing() {
        let settings = json!({"streamFrame": {"nvencVrlinkClampMbit": 0}});
        assert_eq!(resolve_state(&settings).clamp_mbit, 350);
    }

    #[test]
    fn non_numeric_values_use_defaults_instead_of_failing() {
        let settings = json!({"streamFrame": {"nvencBitrateCurve": "2", "nvencBitrateConstancyPct": null}});
        let state = resolve_state(&settings);
        assert_eq!(state.curve, 0);
        assert_eq!(state.constancy_pct, 0);
    }
}
