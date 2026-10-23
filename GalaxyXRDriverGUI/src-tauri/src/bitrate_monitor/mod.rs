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
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
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
    // Async close/hide cleanup must finish before process exit so adb.exe does
    // not outlive the Companion. Incremented before spawning a teardown thread.
    cleanup_pending: Arc<AtomicUsize>,
}

#[derive(Default)]
struct Inner {
    generation: u64,
    stop: Option<Arc<AtomicBool>>,
    handles: Vec<std::thread::JoinHandle<()>>,
    theme: String,
    info_path: Option<String>,
    adb_path: Option<String>,
}

impl Inner {
    /// Stop the current generation and hand its handles and ADB path to the
    /// caller. The caller joins off the event loop, then shuts ADB down.
    fn take_session(&mut self) -> (Option<Arc<AtomicBool>>, Vec<std::thread::JoinHandle<()>>, Option<String>) {
        self.generation = self.generation.wrapping_add(1);
        let stop = self.stop.take();
        if let Some(stop) = &stop {
            stop.store(true, Ordering::SeqCst);
        }
        (
            stop,
            std::mem::take(&mut self.handles),
            self.adb_path.take(),
        )
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
pub fn close_bitrate_monitor(window: WebviewWindow, app: AppHandle, monitor: State<'_, Monitor>) -> Result<(), String> {
    require_main(&window)?;
    shutdown_async(&monitor, true);
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        window.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn close_bitrate_monitor_window(window: WebviewWindow, monitor: State<'_, Monitor>) -> Result<(), String> {
    require_monitor(&window)?;
    // Stop samplers and the ADB server before destroying the WebView that
    // requested the close. Destroyed() is only a fallback.
    shutdown_async(&monitor, true);
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
    let (generation, stop, old_handles) = {
        let mut inner = monitor.inner.lock().map_err(|e| e.to_string())?;
        let (_, old_handles, _) = inner.take_session();
        let stop = Arc::new(AtomicBool::new(false));
        inner.stop = Some(stop.clone());
        inner.adb_path = Some(resolved.adb_path.clone());
        (inner.generation, stop, old_handles)
    };
    // The previous generation gets its stop flag immediately; join it off the
    // event loop so a slow fs/process read cannot block the new start.
    if !old_handles.is_empty() {
        std::thread::spawn(move || {
            for handle in old_handles {
                let _ = handle.join();
            }
        });
    }
    let mut handles = Vec::with_capacity(2);
    for (source, config) in [(Source::Nvenc, resolved.clone()), (Source::Headset, resolved)] {
        match spawn_worker(app.clone(), generation, stop.clone(), source, config) {
            Ok(handle) => handles.push(handle),
            Err(error) => {
                stop.store(true, Ordering::SeqCst);
                return Err(format!("Could not start the bitrate monitor worker: {error}"));
            }
        }
    }
    if let Ok(mut inner) = monitor.inner.lock() {
        inner.handles = handles;
    }
    Ok(generation)
}

#[tauri::command]
pub fn stop_bitrate_monitor(window: WebviewWindow, monitor: State<'_, Monitor>) -> Result<(), String> {
    require_monitor(&window)?;
    shutdown_async(&monitor, true);
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
    shutdown_async(&app.state::<Monitor>(), true);
    let _ = app.emit_to("main", CLOSED_EVENT, ());
}

/// Stops the monitor when its Companion hides to the tray. No session means
/// no ADB shutdown: never disturb a server this monitor did not start.
pub fn suspend(app: &AppHandle) {
    shutdown_async(&app.state::<Monitor>(), true);
}

/// Bounded, synchronous teardown for application exit. Cancels the workers,
/// joins them, then shuts the monitor's ADB server down before the process
/// can terminate the cleanup thread.
pub fn shutdown_on_exit(app: &AppHandle) {
    let Some(monitor) = app.try_state::<Monitor>() else { return; };
    let session = match monitor.inner.lock() {
        Ok(mut inner) => Some(inner.take_session()),
        Err(_) => None,
    };
    if let Some((stop, handles, adb_path)) = session {
        if let Some(stop) = &stop {
            stop.store(true, Ordering::SeqCst);
        }
        for handle in handles {
            let _ = handle.join();
        }
        if let Some(path) = adb_path {
            headset::kill_server(&path);
        }
    }
    // A close/hide command may have handed the same teardown to a background
    // thread. Do not let process exit terminate that thread before adb.exe is
    // gone. Workers are cancel-aware, so this normally completes in <100 ms.
    let deadline = Instant::now() + Duration::from_secs(4);
    while monitor.cleanup_pending.load(Ordering::SeqCst) > 0 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    if monitor.cleanup_pending.load(Ordering::SeqCst) > 0 {
        log::warn!("Bitrate monitor teardown still pending at exit; adb.exe may need manual cleanup");
    }
}

fn shutdown_async(monitor: &Monitor, kill_adb: bool) {
    let (stop, handles, adb_path) = match monitor.inner.lock() {
        Ok(mut inner) => inner.take_session(),
        Err(_) => return,
    };
    if stop.is_none() && handles.is_empty() && adb_path.is_none() {
        return;
    }
    if let Some(stop) = &stop {
        stop.store(true, Ordering::SeqCst);
    }
    let pending = monitor.cleanup_pending.clone();
    pending.fetch_add(1, Ordering::SeqCst);
    let thread_pending = pending.clone();
    let spawned = std::thread::Builder::new()
        .name("bitrate-teardown".into())
        .spawn(move || {
            for handle in handles {
                let _ = handle.join();
            }
            if kill_adb {
                if let Some(path) = adb_path {
                    headset::kill_server(&path);
                }
            }
            thread_pending.fetch_sub(1, Ordering::SeqCst);
        });
    if spawned.is_err() {
        pending.fetch_sub(1, Ordering::SeqCst);
    }
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

fn create_sampler(source: Source, config: &MonitorConfig, stop: &Arc<AtomicBool>) -> Result<Sampler, SamplerError> {
    match source {
        Source::Nvenc => nvenc::NvencSampler::new(config.info_path.as_deref(), config.codec_interval, stop.clone())
            .map(Sampler::Nvenc),
        Source::Headset => Ok(Sampler::Headset(headset::HeadsetSampler::new(
            &config.adb_path,
            &config.serial,
            stop.clone(),
        ))),
    }
}

fn spawn_worker(
    app: AppHandle,
    generation: u64,
    stop: Arc<AtomicBool>,
    source: Source,
    config: MonitorConfig,
) -> std::io::Result<std::thread::JoinHandle<()>> {
    let name = format!("bitrate-{}", source.key());
    std::thread::Builder::new().name(name).spawn(move || {
        run_worker(app, generation, stop, source, config);
    })
}

fn run_worker(app: AppHandle, generation: u64, stop: Arc<AtomicBool>, source: Source, config: MonitorConfig) {
    let mut sampler: Option<Sampler> = None;
    while !stop.load(Ordering::SeqCst) {
        if app.get_webview_window(WINDOW_LABEL).is_none() {
            break;
        }
        let started = Instant::now();
        if sampler.is_none() {
            match create_sampler(source, &config, &stop) {
                Ok(created) => {
                    sampler = Some(created);
                }
                Err(error) => {
                    if stop.load(Ordering::SeqCst) {
                        break;
                    }
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
                    if stop.load(Ordering::SeqCst) {
                        active.close();
                        break;
                    }
                    let event = SampleEvent { generation, source: source.key(), sample: Some(sample), error: None };
                    if app.emit_to(WINDOW_LABEL, SAMPLE_EVENT, event).is_err() {
                        break;
                    }
                }
                Err(error) if error.code == "cancelled" => {
                    active.close();
                    break;
                }
                Err(error) => {
                    active.close();
                    sampler = None;
                    if stop.load(Ordering::SeqCst) {
                        break;
                    }
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

    #[test]
    fn shutdown_async_joins_workers_and_completes_without_adb_path() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;
        use std::time::{Duration, Instant};
        let monitor = super::Monitor::default();
        let stop = Arc::new(AtomicBool::new(false));
        let observed = stop.clone();
        let handle = std::thread::spawn(move || {
            while !observed.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(5));
            }
        });
        {
            let mut inner = monitor.inner.lock().unwrap();
            inner.stop = Some(stop.clone());
            inner.handles.push(handle);
        }
        super::shutdown_async(&monitor, true);
        let deadline = Instant::now() + Duration::from_secs(2);
        while monitor.cleanup_pending.load(Ordering::SeqCst) > 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(monitor.cleanup_pending.load(Ordering::SeqCst), 0);
        assert!(stop.load(Ordering::SeqCst));
    }

    #[test]
    fn take_session_signals_workers_and_clears_state() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;
        use std::time::Duration;
        let stop = Arc::new(AtomicBool::new(false));
        let observed = stop.clone();
        let handle = std::thread::spawn(move || {
            while !observed.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(5));
            }
        });
        let mut inner = super::Inner::default();
        inner.stop = Some(stop.clone());
        inner.handles.push(handle);
        inner.adb_path = Some("C:/platform-tools/adb.exe".into());
        let (taken, handles, adb) = inner.take_session();
        assert!(taken.is_some());
        assert!(stop.load(Ordering::SeqCst));
        assert_eq!(handles.len(), 1);
        assert_eq!(adb.as_deref(), Some("C:/platform-tools/adb.exe"));
        for handle in handles {
            handle.join().unwrap();
        }
        assert!(inner.stop.is_none());
        assert!(inner.handles.is_empty());
        assert!(inner.adb_path.is_none());
    }
}
