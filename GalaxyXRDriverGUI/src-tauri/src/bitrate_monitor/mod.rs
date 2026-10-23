//! On-demand bitrate monitor window (2026-10-23).
//!
//! The Companion creates this window only from Debug Mode. Nothing samples
//! before the window asks to start, and every worker is stopped when the
//! window closes or hides. No timer, process read or ADB command runs while
//! the window is absent.
mod codec;
mod headset;
mod nvenc;

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const WINDOW_LABEL: &str = "bitrate-monitor";
pub const SAMPLE_EVENT: &str = "bitrate-monitor-sample";
pub const CLOSED_EVENT: &str = "bitrate-monitor-closed";
pub const THEME_EVENT: &str = "bitrate-monitor-theme";
const WEBVIEW_DIR: &str = "bitrate-monitor-webview";
const PREFERENCES_FILE: &str = "bitrate-monitor.json";
const SAMPLE_PERIOD: Duration = Duration::from_secs(1);

fn default_interval() -> f64 {
    5.0
}

/// Stable event payload for one source. Counter math stays in the window so
/// Pause/Reset only change display state and never restart a sampler.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    pub source_id: String,
    /// Seconds from this process's monotonic origin.
    pub monotonic_time: f64,
    pub total_bytes: u64,
    pub frames: Option<u64>,
    pub kind: SampleKind,
    pub pid: Option<u32>,
    pub module_sha256: Option<String>,
    pub serial: Option<String>,
    pub interface: Option<String>,
    pub codec: Option<CodecDetection>,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SampleKind {
    Nvenc,
    DecoderInput,
    NetworkRxAllTraffic,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodecDetection {
    pub codec: Option<String>,
    pub label: String,
    pub evidence: String,
    pub age_seconds: f64,
    pub frame_sha256: Option<String>,
    pub frame_index: Option<u64>,
    pub capture_id: Option<u64>,
    pub generation: Option<u64>,
    pub captured_tick_ms: Option<u64>,
    pub frame_bytes: Option<u64>,
    pub sampled_at: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SampleError {
    pub code: String,
    pub detail: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SampleEvent {
    generation: u64,
    source: &'static str,
    sample: Option<Sample>,
    error: Option<SampleError>,
}

#[derive(Debug, Clone)]
pub struct SamplerError {
    pub code: &'static str,
    pub detail: String,
}

impl SamplerError {
    pub fn new(code: &'static str, detail: impl Into<String>) -> Self {
        Self { code, detail: detail.into() }
    }
}

impl std::fmt::Display for SamplerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.detail)
    }
}

impl From<SamplerError> for SampleError {
    fn from(value: SamplerError) -> Self {
        Self { code: value.code.into(), detail: value.detail }
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorConfig {
    #[serde(default)]
    pub info_path: Option<String>,
    #[serde(default)]
    pub adb_path: String,
    #[serde(default)]
    pub serial: String,
    #[serde(default = "default_interval")]
    pub codec_interval: f64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    #[serde(default)]
    pub adb_path: String,
    #[serde(default)]
    pub serial: String,
    #[serde(default = "default_interval")]
    pub codec_interval: f64,
    #[serde(default)]
    pub default_adb: String,
    #[serde(default)]
    pub invalid_interval: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredPreferences {
    #[serde(default)]
    adb_path: String,
    #[serde(default)]
    serial: String,
    #[serde(default = "default_interval")]
    codec_interval: f64,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            adb_path: String::new(),
            serial: String::new(),
            codec_interval: default_interval(),
            default_adb: String::new(),
            invalid_interval: false,
        }
    }
}

#[derive(Default)]
pub struct Monitor {
    // Serializes the check-then-create path so a double click cannot build two
    // windows with the same label/profile.
    opening: Mutex<()>,
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    generation: u64,
    stop: Option<Arc<AtomicBool>>,
    theme: String,
    info_path: Option<String>,
}

impl Inner {
    fn stop_workers(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        if let Some(stop) = self.stop.take() {
            stop.store(true, Ordering::SeqCst);
        }
    }
}

fn require_main(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("Only the Companion can open or control the bitrate monitor".into())
    }
}

fn require_monitor(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == WINDOW_LABEL {
        Ok(())
    } else {
        Err("Not a bitrate monitor window".into())
    }
}

fn normalize_locale(locale: &str) -> &'static str {
    match locale {
        "ja" => "ja",
        "zh-Hant" => "zh-Hant",
        _ => "en-US",
    }
}

fn normalize_theme(theme: &str) -> String {
    match theme {
        "light" | "dark" => theme.to_string(),
        _ => "system".to_string(),
    }
}

pub fn monotonic_now() -> f64 {
    static ORIGIN: OnceLock<Instant> = OnceLock::new();
    ORIGIN.get_or_init(Instant::now).elapsed().as_secs_f64()
}

pub fn wall_now() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

fn validate_config(config: &MonitorConfig) -> Result<(), String> {
    if !config.codec_interval.is_finite() || !(1.0..=3600.0).contains(&config.codec_interval) {
        return Err("Codec inspection interval must be between 1 and 3600 seconds.".into());
    }
    Ok(())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorEnvironment {
    pub theme: String,
    pub info_path: Option<String>,
}

// Tauri 2.12 / wry 0.57: synchronous commands run on the event loop and
// WebView2 creation can deadlock there. Async commands execute off that loop.
#[tauri::command]
pub async fn open_bitrate_monitor(
    app: AppHandle,
    window: WebviewWindow,
    monitor: State<'_, Monitor>,
    locale: String,
    title: String,
    color_scheme: String,
    debug_mode: bool,
    info_path: Option<String>,
) -> Result<(), String> {
    require_main(&window)?;
    if !debug_mode {
        return Err("Enable Debug Mode in App Settings to open the bitrate monitor.".into());
    }
    let _opening = monitor.opening.lock().map_err(|e| e.to_string())?;
    let theme = normalize_theme(&color_scheme);
    if let Ok(mut inner) = monitor.inner.lock() {
        inner.theme = theme.clone();
        inner.info_path = info_path.filter(|path| !path.trim().is_empty());
    }
    if let Some(existing) = app.get_webview_window(WINDOW_LABEL) {
        let _ = existing.emit(THEME_EVENT, &theme);
        existing.unminimize().map_err(|e| e.to_string())?;
        existing.show().map_err(|e| e.to_string())?;
        return existing.set_focus().map_err(|e| e.to_string());
    }
    let locale = normalize_locale(&locale);
    let builder = WebviewWindowBuilder::new(&app, WINDOW_LABEL, WebviewUrl::App(format!("{locale}/bitrate.html").into()))
        .title(if title.trim().is_empty() { "Bitrate Monitor".to_string() } else { title })
        .inner_size(1080.0, 840.0)
        .min_inner_size(820.0, 640.0)
        .resizable(true)
        .closable(true);
    // The main window has custom browser arguments. Sharing a WebView2
    // environment with different arguments can hang creation, so the monitor
    // uses its own profile, created only on Open.
    #[cfg(windows)]
    let builder = builder.data_directory(
        app.path()
            .app_local_data_dir()
            .map_err(|e| e.to_string())?
            .join(WEBVIEW_DIR),
    );
    builder.build().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn close_bitrate_monitor(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    require_main(&window)?;
    if let Some(monitor) = app.get_webview_window(WINDOW_LABEL) {
        monitor.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn close_bitrate_monitor_window(window: WebviewWindow) -> Result<(), String> {
    require_monitor(&window)?;
    window.close().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn publish_bitrate_monitor_theme(
    window: WebviewWindow,
    app: AppHandle,
    monitor: State<'_, Monitor>,
    color_scheme: String,
) -> Result<(), String> {
    require_main(&window)?;
    let theme = normalize_theme(&color_scheme);
    if let Ok(mut inner) = monitor.inner.lock() {
        inner.theme = theme.clone();
    }
    if let Some(monitor) = app.get_webview_window(WINDOW_LABEL) {
        monitor.emit(THEME_EVENT, &theme).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn bitrate_monitor_environment(
    window: WebviewWindow,
    monitor: State<'_, Monitor>,
) -> Result<MonitorEnvironment, String> {
    require_monitor(&window)?;
    let inner = monitor.inner.lock().map_err(|e| e.to_string())?;
    Ok(MonitorEnvironment {
        theme: if inner.theme.is_empty() { "system".into() } else { inner.theme.clone() },
        info_path: inner.info_path.clone(),
    })
}

/// Starts the two independent samplers and returns this session's generation.
/// A previous session for a reused window label is stopped first.
#[tauri::command]
pub fn start_bitrate_monitor(
    app: AppHandle,
    window: WebviewWindow,
    monitor: State<'_, Monitor>,
    config: MonitorConfig,
) -> Result<u64, String> {
    require_monitor(&window)?;
    validate_config(&config)?;
    let (generation, stop) = {
        let mut inner = monitor.inner.lock().map_err(|e| e.to_string())?;
        inner.stop_workers();
        let stop = Arc::new(AtomicBool::new(false));
        inner.stop = Some(stop.clone());
        (inner.generation, stop)
    };
    let resolved = MonitorConfig {
        info_path: config.info_path.clone(),
        adb_path: if config.adb_path.trim().is_empty() {
            headset::default_adb()
        } else {
            config.adb_path.clone()
        },
        serial: config.serial.clone(),
        codec_interval: config.codec_interval,
    };
    spawn_worker(app.clone(), generation, stop.clone(), Source::Nvenc, resolved.clone());
    spawn_worker(app, generation, stop, Source::Headset, resolved);
    Ok(generation)
}

#[tauri::command]
pub fn stop_bitrate_monitor(window: WebviewWindow, monitor: State<'_, Monitor>) -> Result<(), String> {
    require_monitor(&window)?;
    monitor.inner.lock().map_err(|e| e.to_string())?.stop_workers();
    Ok(())
}

#[tauri::command]
pub fn bitrate_monitor_preferences(app: AppHandle) -> Result<Preferences, String> {
    let default_adb = headset::default_adb();
    let mut preferences = Preferences { adb_path: default_adb.clone(), default_adb, ..Preferences::default() };
    if let Ok(path) = preferences_path(&app) {
        if let Ok(text) = std::fs::read_to_string(path) {
            let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
            if let Ok(saved) = serde_json::from_str::<StoredPreferences>(text) {
                preferences.adb_path = if saved.adb_path.trim().is_empty() { preferences.adb_path } else { saved.adb_path };
                preferences.serial = saved.serial;
                preferences.codec_interval = saved.codec_interval;
            }
        }
    }
    if !preferences.codec_interval.is_finite() || !(1.0..=3600.0).contains(&preferences.codec_interval) {
        preferences.codec_interval = default_interval();
        preferences.invalid_interval = true;
    }
    Ok(preferences)
}

#[tauri::command]
pub fn save_bitrate_monitor_preferences(app: AppHandle, preferences: Preferences) -> Result<(), String> {
    if !preferences.codec_interval.is_finite() || !(1.0..=3600.0).contains(&preferences.codec_interval) {
        return Err("Enter a frame inspection interval from 1 to 3600 seconds.".into());
    }
    let path = preferences_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let stored = StoredPreferences {
        adb_path: preferences.adb_path,
        serial: preferences.serial,
        codec_interval: preferences.codec_interval,
    };
    let text = serde_json::to_string_pretty(&stored).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn write_bitrate_csv(window: WebviewWindow, path: String, content: String) -> Result<(), String> {
    require_monitor(&window)?;
    if path.trim().is_empty() {
        return Err("A CSV destination path is required.".into());
    }
    let target = std::path::PathBuf::from(path);
    tauri::async_runtime::spawn_blocking(move || std::fs::write(target, content))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

pub fn destroyed(app: &AppHandle) {
    if let Ok(mut inner) = app.state::<Monitor>().inner.lock() {
        inner.stop_workers();
    }
    let _ = app.emit_to("main", CLOSED_EVENT, ());
}

fn preferences_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join(PREFERENCES_FILE))
}

#[derive(Clone, Copy)]
enum Source {
    Nvenc,
    Headset,
}

impl Source {
    fn key(self) -> &'static str {
        match self {
            Source::Nvenc => "nvenc",
            Source::Headset => "headset",
        }
    }
}

enum Sampler {
    Nvenc(nvenc::NvencSampler),
    Headset(headset::HeadsetSampler),
}

impl Sampler {
    fn sample(&mut self) -> Result<Sample, SamplerError> {
        match self {
            Sampler::Nvenc(sampler) => sampler.sample(),
            Sampler::Headset(sampler) => sampler.sample(),
        }
    }

    fn close(&mut self) {
        match self {
            Sampler::Nvenc(sampler) => sampler.close(),
            Sampler::Headset(sampler) => sampler.close(),
        }
    }
}

fn create_sampler(source: Source, config: &MonitorConfig) -> Result<Sampler, SamplerError> {
    match source {
        Source::Nvenc => nvenc::NvencSampler::new(config.info_path.as_deref(), config.codec_interval).map(Sampler::Nvenc),
        Source::Headset => Ok(Sampler::Headset(headset::HeadsetSampler::new(&config.adb_path, &config.serial))),
    }
}

fn spawn_worker(app: AppHandle, generation: u64, stop: Arc<AtomicBool>, source: Source, config: MonitorConfig) {
    let name = format!("bitrate-{}", source.key());
    let _ = std::thread::Builder::new().name(name).spawn(move || {
        run_worker(app, generation, stop, source, config);
    });
}

fn run_worker(app: AppHandle, generation: u64, stop: Arc<AtomicBool>, source: Source, config: MonitorConfig) {
    let mut sampler: Option<Sampler> = None;
    while !stop.load(Ordering::SeqCst) {
        if app.get_webview_window(WINDOW_LABEL).is_none() {
            break;
        }
        let started = Instant::now();
        if sampler.is_none() {
            match create_sampler(source, &config) {
                Ok(created) => {
                    sampler = Some(created);
                }
                Err(error) => {
                    let event = SampleEvent {
                        generation,
                        source: source.key(),
                        sample: None,
                        error: Some(error.into()),
                    };
                    let _ = app.emit_to(WINDOW_LABEL, SAMPLE_EVENT, event);
                }
            }
        }
        if let Some(active) = sampler.as_mut() {
            match active.sample() {
                Ok(sample) => {
                    let event = SampleEvent { generation, source: source.key(), sample: Some(sample), error: None };
                    if app.emit_to(WINDOW_LABEL, SAMPLE_EVENT, event).is_err() {
                        break;
                    }
                }
                Err(error) => {
                    active.close();
                    sampler = None;
                    let event = SampleEvent {
                        generation,
                        source: source.key(),
                        sample: None,
                        error: Some(error.into()),
                    };
                    if app.emit_to(WINDOW_LABEL, SAMPLE_EVENT, event).is_err() {
                        break;
                    }
                }
            }
        }
        while !stop.load(Ordering::SeqCst) && started.elapsed() < SAMPLE_PERIOD {
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    if let Some(mut active) = sampler {
        active.close();
    }
}

#[cfg(test)]
mod tests {
    use super::{normalize_locale, normalize_theme, validate_config, MonitorConfig};

    #[test]
    fn locale_and_theme_are_closed_sets() {
        assert_eq!(normalize_locale("ja"), "ja");
        assert_eq!(normalize_locale("zh-Hant"), "zh-Hant");
        assert_eq!(normalize_locale("de-DE"), "en-US");
        assert_eq!(normalize_theme("dark"), "dark");
        assert_eq!(normalize_theme("light"), "light");
        assert_eq!(normalize_theme("sepia"), "system");
    }

    #[test]
    fn codec_interval_is_bounded() {
        let mut config = MonitorConfig { info_path: None, adb_path: String::new(), serial: String::new(), codec_interval: 5.0 };
        assert!(validate_config(&config).is_ok());
        for value in [0.0, 0.5, 3601.0, f64::NAN, f64::INFINITY] {
            config.codec_interval = value;
            assert!(validate_config(&config).is_err(), "{value} must be rejected");
        }
    }
}
