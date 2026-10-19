//! Managed OFXR Bridge component (Model A: the Companion owns the lifecycle).
//!
//! The Companion discovers OFXR Bridge's own versioned runtime layer under
//! `%LOCALAPPDATA%\OFXR Bridge`, merge-writes the user-facing settings into
//! that runtime directory's `ofxr_bridge.ini`, creates the per-arm stop event
//! the layer watches, and registers the absolute-path implicit-layer manifest
//! for the current user. Nothing is installed and no OFXR code is copied or
//! linked; the layout, manifest shape, INI keys, registry location and event
//! naming are reimplemented from OFXR-Bridge's observed source behaviour.
//!
//! Verified against OFXR-Bridge (read-only reference):
//!   src/tray/standalone_launcher.cpp:190-235  manifest shape + `vNNN` naming
//!   src/tray/main.cpp:205-274                 runtime INI + arm preparation
//!   src/common/implicit_layer.cpp:116-304     event name, registration
//!   include/xrfg/implicit_layer.hpp:29-33     registry key, manifest names
//!   src/core/fps_overlay_model.cpp:9-25       overlay position spellings

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

/// Pinned IPC shape (GUI codes against these exact names).
#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OfxrPreferences {
    pub enabled: bool,
    pub mode: String,
    pub scale: u32,
    pub bidirectional: bool,
    pub logging: bool,
    pub max_log_mb: u32,
    pub flush_each_event: bool,
    pub overlay: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OfxrStatus {
    pub state: String,
    pub version: Option<String>,
    pub runtime_dir: Option<String>,
    pub reason: Option<String>,
}

const STATE_NOT_INSTALLED: &str = "not_installed";
const STATE_UNAVAILABLE: &str = "unavailable";
const STATE_READY: &str = "ready";
const STATE_ARMED: &str = "armed";
const STATE_ARMED_EXTERNAL: &str = "armed_external";

const LOCAL_DIRECTORY_NAME: &str = "OFXR Bridge";
const RUNTIME_ROOT_NAME: &str = "RuntimeLayer";
const LAYER_DLL_NAME: &str = "XR_APILAYER_XRFrameBridge_diagnostic.dll";
const LAYER_NAME: &str = "XR_APILAYER_XRFrameBridge_diagnostic";
const INI_NAME: &str = "ofxr_bridge.ini";
const MANIFEST_PREFIX_LOWER: &str = "xr_apilayer_xrframebridge_manual-";
const MANIFEST_SUFFIX: &str = ".json";
/// Stable name in OFXR's own manual-manifest grammar (`<prefix><digits>-<digits>.json`).
/// One Companion-owned manifest per runtime directory; re-arming refreshes it.
const STABLE_MANIFEST_NAME: &str = "XR_APILAYER_XRFrameBridge_manual-1-1.json";
const DISABLE_ENVIRONMENT: &str = "XRFG_DISABLE_OFXR_BRIDGE";

/// The layer only trusts a managed session while this named event exists.
/// OFXR creates it manual-reset (standalone_launcher.cpp:127-142).
static ARM_EVENT: Mutex<Option<isize>> = Mutex::new(None);

/// Serializes arm/disarm/apply: the GUI can emit overlapping commands (a
/// number row dispatches change on every keystroke), and the INI, manifest and
/// registry mutations must not interleave.
static COMMAND_LOCK: Mutex<()> = Mutex::new(());
static TEMP_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn command_guard() -> std::sync::MutexGuard<'static, ()> {
    match COMMAND_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RegScope {
    CurrentUser,
    LocalMachine,
}

#[derive(Clone, Debug)]
struct RuntimeComponent {
    runtime_dir: PathBuf,
    version: String,
}

#[derive(Clone, Debug)]
struct BundledComponent {
    directory: PathBuf,
    version: String,
}

#[derive(Clone, Debug)]
enum Discovery {
    Installed(RuntimeComponent),
    Bundled(BundledComponent),
    Missing,
}

#[derive(Clone, Debug, Default)]
struct StatusFacts {
    version: Option<String>,
    runtime_dir: Option<String>,
    bundled_only: bool,
    held: bool,
    registered_here: bool,
    any_registration: bool,
    error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct MappedPreferences {
    backend: &'static str,
    nvidia_preset: &'static str,
    nvidia_input_scale: u32,
    nvidia_bidirectional: bool,
    logging_enabled: bool,
    max_file_mb: u32,
    flush_each_event: bool,
    overlay: &'static str,
}

/// Maps the pinned prefs onto OFXR's INI vocabulary. Unknown values are
/// rejected instead of silently coerced (no silent settings).
fn map_preferences(prefs: &OfxrPreferences) -> Result<MappedPreferences, String> {
    let (backend, nvidia_preset) = match prefs.mode.as_str() {
        "fidelityfx" => ("fidelityfx", "medium"),
        "nvidia-fast" => ("nvidia", "fast"),
        "nvidia-medium" => ("nvidia", "medium"),
        "nvidia-slow" => ("nvidia", "slow"),
        other => {
            return Err(format!(
                "Unsupported OFXR mode \"{other}\"; expected fidelityfx, nvidia-fast, nvidia-medium or nvidia-slow."
            ))
        }
    };
    if !matches!(prefs.scale, 50 | 75 | 100) {
        return Err(format!(
            "Unsupported OFXR NVIDIA input scale {}; expected 50, 75 or 100.",
            prefs.scale
        ));
    }
    let overlay = match prefs.overlay.as_str() {
        "off" => "off",
        "upper-left" => "upper_left",
        "upper-right" => "upper_right",
        "lower-left" => "lower_left",
        "lower-right" => "lower_right",
        other => {
            return Err(format!(
                "Unsupported OFXR overlay position \"{other}\"; expected off, upper-left, upper-right, lower-left or lower-right."
            ))
        }
    };
    Ok(MappedPreferences {
        backend,
        nvidia_preset,
        nvidia_input_scale: prefs.scale,
        nvidia_bidirectional: prefs.bidirectional,
        logging_enabled: prefs.logging,
        max_file_mb: prefs.max_log_mb,
        flush_each_event: prefs.flush_each_event,
        overlay,
    })
}

fn bool_ini(value: bool) -> &'static str {
    if value {
        "1"
    } else {
        "0"
    }
}

// ---------------------------------------------------------------------------
// INI merge-write
// ---------------------------------------------------------------------------

struct IniBlock {
    name: Option<String>,
    header: Option<String>,
    lines: Vec<String>,
}

fn section_name(line: &str) -> Option<String> {
    let trimmed = line.trim();
    let inner = trimmed.strip_prefix('[')?.strip_suffix(']')?;
    Some(inner.trim().to_ascii_lowercase())
}

fn key_name(line: &str) -> Option<String> {
    let trimmed = line.trim_start();
    if trimmed.starts_with(';') || trimmed.starts_with('#') {
        return None;
    }
    let (key, _) = trimmed.split_once('=')?;
    Some(key.trim().to_ascii_lowercase())
}

/// Merge-writes only the Companion-owned keys; every foreign line, section,
/// comment and unknown key is preserved byte-for-byte apart from line-ending
/// normalisation to CRLF (what OFXR's own writers emit).
fn render_ini(
    existing: Option<&str>,
    values: &MappedPreferences,
    control_event: Option<&str>,
) -> String {
    let mut wanted: Vec<(&str, &str, String)> = vec![
        ("ofxr", "backend", values.backend.to_string()),
        ("ofxr", "nvidia_preset", values.nvidia_preset.to_string()),
        (
            "ofxr",
            "nvidia_input_scale",
            values.nvidia_input_scale.to_string(),
        ),
        (
            "ofxr",
            "nvidia_bidirectional",
            bool_ini(values.nvidia_bidirectional).to_string(),
        ),
        (
            "diagnostics",
            "logging_enabled",
            bool_ini(values.logging_enabled).to_string(),
        ),
        (
            "diagnostics",
            "max_file_mb",
            values.max_file_mb.to_string(),
        ),
        (
            "diagnostics",
            "flush_each_event",
            bool_ini(values.flush_each_event).to_string(),
        ),
        ("overlay", "position", values.overlay.to_string()),
    ];
    if let Some(name) = control_event {
        wanted.push(("ofxr", "control_event", name.to_string()));
    }
    let mut written = vec![false; wanted.len()];

    let mut blocks: Vec<IniBlock> = vec![IniBlock {
        name: None,
        header: None,
        lines: Vec::new(),
    }];
    if let Some(text) = existing {
        for raw in text.split_inclusive('\n') {
            let without_newline = raw.strip_suffix('\n').unwrap_or(raw);
            let line = without_newline
                .strip_suffix('\r')
                .unwrap_or(without_newline)
                .to_string();
            if let Some(name) = section_name(&line) {
                blocks.push(IniBlock {
                    name: Some(name),
                    header: Some(line),
                    lines: Vec::new(),
                });
            } else if let Some(last) = blocks.last_mut() {
                last.lines.push(line);
            }
        }
    }

    for block in &mut blocks {
        let name = match &block.name {
            Some(name) => name.clone(),
            None => continue,
        };
        for line in &mut block.lines {
            if let Some(key) = key_name(line) {
                if let Some(index) = wanted
                    .iter()
                    .position(|(section, wanted_key, _)| *section == name && *wanted_key == key)
                {
                    let value_start = line.find('=').map(|at| at + 1).unwrap_or(line.len());
                    let suffix = line[value_start..]
                        .find(|character| character == ';' || character == '#')
                        .map(|at| line[value_start + at..].to_string())
                        .filter(|comment| !comment.is_empty());
                    *line = match suffix {
                        Some(comment) => format!("{key}={}{}", wanted[index].2, comment),
                        None => format!("{key}={}", wanted[index].2),
                    };
                    written[index] = true;
                }
            }
        }
    }

    for block in &mut blocks {
        let name = match &block.name {
            Some(name) => name.clone(),
            None => continue,
        };
        let mut insert_at = block.lines.len();
        while insert_at > 0 && block.lines[insert_at - 1].trim().is_empty() {
            insert_at -= 1;
        }
        let mut additions = Vec::new();
        for (index, (section, key, value)) in wanted.iter().enumerate() {
            if !written[index] && *section == name {
                additions.push(format!("{key}={value}"));
                written[index] = true;
            }
        }
        for (offset, line) in additions.into_iter().enumerate() {
            block.lines.insert(insert_at + offset, line);
        }
    }

    let mut order: Vec<&str> = Vec::new();
    for (section, _, _) in &wanted {
        if !order.contains(section) {
            order.push(section);
        }
    }
    for section in order {
        if blocks
            .iter()
            .any(|block| block.name.as_deref() == Some(section))
        {
            continue;
        }
        let mut lines = Vec::new();
        for (index, (wanted_section, key, value)) in wanted.iter().enumerate() {
            if *wanted_section == section && !written[index] {
                lines.push(format!("{key}={value}"));
                written[index] = true;
            }
        }
        blocks.push(IniBlock {
            name: Some(section.to_string()),
            header: Some(format!("[{section}]")),
            lines,
        });
    }

    let mut output = String::new();
    for block in &blocks {
        if let Some(header) = &block.header {
            output.push_str(header);
            output.push_str("\r\n");
        }
        for line in &block.lines {
            output.push_str(line);
            output.push_str("\r\n");
        }
    }
    output
}

// ---------------------------------------------------------------------------
// Paths, event naming, manifest
// ---------------------------------------------------------------------------

fn lexically_normal(path: &Path) -> PathBuf {
    let mut output = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir => output.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if output.parent().is_some() {
                    output.pop();
                }
            }
            Component::Normal(part) => output.push(part),
        }
    }
    output
}

fn absolute_lexical(path: &Path) -> Result<PathBuf, String> {
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|error| format!("Resolving the current directory failed: {error}"))?
            .join(path)
    };
    Ok(lexically_normal(&joined))
}

fn normalized_path_string(path: &Path) -> Result<String, String> {
    let absolute = absolute_lexical(path)?;
    Ok(absolute.to_string_lossy().replace('/', "\\"))
}

/// OFXR hashes the normalised manifest path's UTF-16 code units after folding
/// only ASCII `A-Z` (implicit_layer.cpp:116-125).
fn fnv1a64_utf16_lower(text: &str) -> u64 {
    let mut hash: u64 = 14_695_981_039_346_656_037;
    for unit in text.encode_utf16() {
        let folded = if (0x41..=0x5A).contains(&unit) {
            unit + 0x20
        } else {
            unit
        };
        hash ^= u64::from(folded);
        hash = hash.wrapping_mul(1_099_511_628_211);
    }
    hash
}

fn arm_event_name(normalized_manifest: &str) -> String {
    format!(
        "Local\\OFXRBridgeArmStop-{}",
        fnv1a64_utf16_lower(normalized_manifest)
    )
}

fn manifest_json(library_path: &Path, version: &str) -> Result<String, String> {
    let absolute = normalized_path_string(library_path)?;
    let document = json!({
        "file_format_version": "1.0.0",
        "api_layer": {
            "name": LAYER_NAME,
            "library_path": absolute,
            "api_version": "1.0",
            "implementation_version": version,
            "description": format!("OFXR Bridge V{version} manual persistent implicit layer"),
            "disable_environment": DISABLE_ENVIRONMENT,
        }
    });
    let mut text = serde_json::to_string_pretty(&document)
        .map_err(|error| format!("Rendering the OFXR layer manifest failed: {error}"))?;
    text.push('\n');
    Ok(text)
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("Invalid file path: {}", path.display()))?;
    let temporary = path.with_file_name(format!(
        "{file_name}.{}.{}.tmp",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    fs::write(&temporary, bytes)
        .map_err(|error| format!("Writing {} failed: {error}", temporary.display()))?;
    if let Err(error) = fs::rename(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("Replacing {} failed: {error}", path.display()));
    }
    Ok(())
}

fn write_manifest(manifest: &Path, library_path: &Path, version: &str) -> Result<(), String> {
    let text = manifest_json(library_path, version)?;
    write_atomic(manifest, text.as_bytes())
}

fn write_ini(
    runtime_dir: &Path,
    values: &MappedPreferences,
    control_event: Option<&str>,
) -> Result<(), String> {
    let path = runtime_dir.join(INI_NAME);
    let existing = match fs::read(&path) {
        Ok(bytes) => match std::str::from_utf8(&bytes) {
            Ok(text) => Some(text.to_string()),
            Err(_) => {
                return Err(format!(
                    "{} is not UTF-8; refusing to rewrite it.",
                    path.display()
                ))
            }
        },
        Err(error) if error.kind() == ErrorKind::NotFound => None,
        Err(error) => return Err(format!("Reading {} failed: {error}", path.display())),
    };
    let rendered = render_ini(existing.as_deref(), values, control_event);
    write_atomic(&path, rendered.as_bytes())
}

// ---------------------------------------------------------------------------
// Discovery and staging
// ---------------------------------------------------------------------------

fn is_manifest_file_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.len() > MANIFEST_PREFIX_LOWER.len() + MANIFEST_SUFFIX.len()
        && lower.starts_with(MANIFEST_PREFIX_LOWER)
        && lower.ends_with(MANIFEST_SUFFIX)
}

fn is_ofxr_manifest_name(value: &str) -> bool {
    let file = value
        .rsplit(|character| character == '\\' || character == '/')
        .next()
        .unwrap_or(value);
    is_manifest_file_name(file)
}

/// True only for the Companion's own registration value: OFXR's manual
/// manifest grammar, our stable file name, inside this install's RuntimeLayer.
/// Used to clean our previous versions on disarm and to tell our stale
/// registration apart from a concurrently armed OFXR tray.
fn is_companion_manifest_for_root(value: &str, local_directory: &Path) -> bool {
    let file = value
        .rsplit(|character| character == '\\' || character == '/')
        .next()
        .unwrap_or(value);
    if !file.eq_ignore_ascii_case(STABLE_MANIFEST_NAME) {
        return false;
    }
    let root = match normalized_path_string(&local_directory.join(RUNTIME_ROOT_NAME)) {
        Ok(root) => root,
        Err(_) => return false,
    };
    let value = value.replace('/', "\\");
    let prefix = format!("{}\\", root.trim_end_matches('\\'));
    match value.get(..prefix.len()) {
        Some(head) => head.eq_ignore_ascii_case(&prefix),
        None => false,
    }
}

fn is_real_directory(path: &Path) -> bool {
    match fs::symlink_metadata(path) {
        Ok(metadata) => metadata.is_dir() && !metadata.file_type().is_symlink(),
        Err(_) => false,
    }
}

fn manifest_files(directory: &Path) -> Result<Vec<PathBuf>, String> {
    let entries = fs::read_dir(directory)
        .map_err(|error| format!("Reading {} failed: {error}", directory.display()))?;
    let mut manifests = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| format!("Reading {} failed: {error}", directory.display()))?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if let Some(name) = path.file_name().and_then(|name| name.to_str()) {
            if is_manifest_file_name(name) {
                manifests.push(path);
            }
        }
    }
    manifests.sort();
    Ok(manifests)
}

fn newest_manifest(mut manifests: Vec<PathBuf>) -> Option<PathBuf> {
    manifests.drain(..).max_by(|left, right| {
        let left_time = left.metadata().and_then(|meta| meta.modified()).ok();
        let right_time = right.metadata().and_then(|meta| meta.modified()).ok();
        left_time
            .cmp(&right_time)
            .then_with(|| left.file_name().cmp(&right.file_name()))
    })
}

fn version_from_dir_name(name: &str) -> Option<String> {
    let digits = name
        .strip_prefix('v')
        .or_else(|| name.strip_prefix('V'))?;
    if digits.len() < 3 || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let trimmed = digits.trim_start_matches('0');
    Some(if trimmed.is_empty() {
        "0".to_string()
    } else {
        trimmed.to_string()
    })
}

/// Mirrors OFXR's `runtime_version_directory` (standalone_launcher.cpp:227-235):
/// `<local>\RuntimeLayer\v<version padded to at least 3 digits>`.
fn runtime_version_directory(local_directory: &Path, version: &str) -> Result<PathBuf, String> {
    if version.is_empty() || !version.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(format!(
            "OFXR implementation version \"{version}\" is not numeric."
        ));
    }
    let mut padded = version.to_string();
    while padded.len() < 3 {
        padded.insert(0, '0');
    }
    Ok(local_directory
        .join(RUNTIME_ROOT_NAME)
        .join(format!("v{padded}")))
}

fn read_manifest_version(manifest: &Path) -> Result<String, String> {
    let text = fs::read_to_string(manifest)
        .map_err(|error| format!("Reading {} failed: {error}", manifest.display()))?;
    let document: Value = serde_json::from_str(&text)
        .map_err(|error| format!("Parsing {} failed: {error}", manifest.display()))?;
    let layer = document
        .get("api_layer")
        .ok_or_else(|| format!("{} has no api_layer object.", manifest.display()))?;
    let version = match layer.get("implementation_version") {
        Some(Value::String(value)) => value.clone(),
        Some(Value::Number(value)) => value.to_string(),
        _ => {
            return Err(format!(
                "{} has no string implementation_version.",
                manifest.display()
            ))
        }
    };
    if version.is_empty() || !version.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(format!(
            "{} has a non-numeric implementation_version \"{version}\".",
            manifest.display()
        ));
    }
    Ok(version)
}

fn consider_candidate(
    slot: &mut Option<(u64, String, PathBuf)>,
    numeric: u64,
    version: String,
    path: PathBuf,
) {
    let replace = match slot {
        Some((best_numeric, best_version, _)) => (numeric, &version) > (*best_numeric, best_version),
        None => true,
    };
    if replace {
        *slot = Some((numeric, version, path));
    }
}

fn discover_runtime(
    local_directory: &Path,
    bundled_directory: Option<&Path>,
) -> Result<Discovery, String> {
    let root = local_directory.join(RUNTIME_ROOT_NAME);
    let mut best: Option<(u64, String, PathBuf)> = None;
    match fs::read_dir(&root) {
        Ok(entries) => {
            for entry in entries {
                let entry = entry
                    .map_err(|error| format!("Reading {} failed: {error}", root.display()))?;
                let path = entry.path();
                if !is_real_directory(&path) {
                    continue;
                }
                let name = match path.file_name().and_then(|name| name.to_str()) {
                    Some(name) => name,
                    None => continue,
                };
                let version = match version_from_dir_name(name) {
                    Some(version) => version,
                    None => continue,
                };
                if !path.join(LAYER_DLL_NAME).is_file() {
                    continue;
                }
                let numeric = match version.parse::<u64>() {
                    Ok(numeric) => numeric,
                    Err(_) => continue,
                };
                // Rank purely by version. Manifest presence is not a version
                // signal: a stale Companion manifest in an older directory must
                // never shadow a newer installed layer, and OFXR's own disarm
                // retires the manifest JSON anyway.
                consider_candidate(&mut best, numeric, version, path);
            }
        }
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(format!("Reading {} failed: {error}", root.display())),
    }

    if let Some((_, version, runtime_dir)) = best {
        return Ok(Discovery::Installed(RuntimeComponent {
            runtime_dir,
            version,
        }));
    }

    if let Some(bundled) = bundled_directory {
        if is_real_directory(bundled) && bundled.join(LAYER_DLL_NAME).is_file() {
            if let Some(manifest) = newest_manifest(manifest_files(bundled)?) {
                let version = read_manifest_version(&manifest)?;
                return Ok(Discovery::Bundled(BundledComponent {
                    directory: bundled.to_path_buf(),
                    version,
                }));
            }
        }
    }

    Ok(Discovery::Missing)
}

fn stage_bundled(
    local_directory: &Path,
    bundled: &BundledComponent,
) -> Result<RuntimeComponent, String> {
    let runtime_dir = runtime_version_directory(local_directory, &bundled.version)?;
    fs::create_dir_all(&runtime_dir)
        .map_err(|error| format!("Creating {} failed: {error}", runtime_dir.display()))?;
    let source_dll = bundled.directory.join(LAYER_DLL_NAME);
    let target_dll = runtime_dir.join(LAYER_DLL_NAME);
    fs::copy(&source_dll, &target_dll).map_err(|error| {
        format!(
            "Staging {} to {} failed: {error}",
            source_dll.display(),
            target_dll.display()
        )
    })?;
    let source_ini = bundled.directory.join(INI_NAME);
    if source_ini.is_file() {
        let target_ini = runtime_dir.join(INI_NAME);
        fs::copy(&source_ini, &target_ini).map_err(|error| {
            format!(
                "Staging {} to {} failed: {error}",
                source_ini.display(),
                target_ini.display()
            )
        })?;
    }
    Ok(RuntimeComponent {
        runtime_dir,
        version: bundled.version.clone(),
    })
}

// ---------------------------------------------------------------------------
// Status classification
// ---------------------------------------------------------------------------

fn same_path(left: &str, right: &str) -> bool {
    let left = left.replace('/', "\\");
    let right = right.replace('/', "\\");
    left.eq_ignore_ascii_case(&right)
}

fn classify_status(facts: &StatusFacts) -> OfxrStatus {
    if let Some(reason) = &facts.error {
        return OfxrStatus {
            state: STATE_UNAVAILABLE.to_string(),
            version: facts.version.clone(),
            runtime_dir: facts.runtime_dir.clone(),
            reason: Some(reason.clone()),
        };
    }
    if facts.held && facts.registered_here {
        return OfxrStatus {
            state: STATE_ARMED.to_string(),
            version: facts.version.clone(),
            runtime_dir: facts.runtime_dir.clone(),
            reason: None,
        };
    }
    if facts.any_registration {
        return OfxrStatus {
            state: STATE_ARMED_EXTERNAL.to_string(),
            version: facts.version.clone(),
            runtime_dir: facts.runtime_dir.clone(),
            reason: Some(
                "An OFXR Bridge layer is registered but not held by this Companion session (the OFXR tray, or a previous session). Arming takes ownership when the registration is the Companion's own."
                    .to_string(),
            ),
        };
    }
    if facts.version.is_some() || facts.runtime_dir.is_some() || facts.bundled_only {
        let reason = if facts.bundled_only {
            Some("Bundled OFXR Bridge component found; it is staged into a runtime directory when armed.".to_string())
        } else if facts.held {
            Some("The OFXR Bridge registration is missing; the retained arm event was left in place.".to_string())
        } else {
            None
        };
        return OfxrStatus {
            state: STATE_READY.to_string(),
            version: facts.version.clone(),
            runtime_dir: facts.runtime_dir.clone(),
            reason,
        };
    }
    OfxrStatus {
        state: STATE_NOT_INSTALLED.to_string(),
        version: None,
        runtime_dir: None,
        reason: Some(
            "OFXR Bridge is not installed: no versioned runtime layer was found under %LOCALAPPDATA%\\OFXR Bridge\\RuntimeLayer."
                .to_string(),
        ),
    }
}

fn unavailable(reason: String, version: Option<String>, runtime_dir: Option<String>) -> OfxrStatus {
    OfxrStatus {
        state: STATE_UNAVAILABLE.to_string(),
        version,
        runtime_dir,
        reason: Some(reason),
    }
}

fn discovery_version(discovery: &Discovery) -> Option<String> {
    match discovery {
        Discovery::Installed(component) => Some(component.version.clone()),
        Discovery::Bundled(bundled) => Some(bundled.version.clone()),
        Discovery::Missing => None,
    }
}

fn discovery_runtime_dir(discovery: &Discovery) -> Option<String> {
    match discovery {
        Discovery::Installed(component) => {
            Some(component.runtime_dir.to_string_lossy().into_owned())
        }
        Discovery::Bundled(_) | Discovery::Missing => None,
    }
}

fn held_event() -> bool {
    let guard = match ARM_EVENT.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    guard.is_some()
}

fn take_held_event() -> Option<isize> {
    let mut guard = match ARM_EVENT.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    guard.take()
}

fn store_held_event(handle: isize) {
    let mut guard = match ARM_EVENT.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    *guard = Some(handle);
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

fn status_impl() -> OfxrStatus {
    let local_directory = match platform::local_directory() {
        Ok(path) => path,
        Err(reason) => return unavailable(reason, None, None),
    };
    let bundled = platform::bundled_directory();
    let discovery = match discover_runtime(&local_directory, bundled.as_deref()) {
        Ok(discovery) => discovery,
        Err(reason) => return unavailable(reason, None, None),
    };

    let mut names: Vec<String> = Vec::new();
    for scope in [RegScope::CurrentUser, RegScope::LocalMachine] {
        match platform::registered_value_names(scope) {
            Ok(mut values) => names.append(&mut values),
            Err(reason) => {
                return unavailable(
                    reason,
                    discovery_version(&discovery),
                    discovery_runtime_dir(&discovery),
                )
            }
        }
    }
    let ofxr_names: Vec<&String> = names
        .iter()
        .filter(|name| is_ofxr_manifest_name(name))
        .collect();

    let mut facts = StatusFacts {
        held: held_event(),
        any_registration: !ofxr_names.is_empty(),
        ..StatusFacts::default()
    };
    match &discovery {
        Discovery::Installed(component) => {
            facts.version = Some(component.version.clone());
            facts.runtime_dir = Some(component.runtime_dir.to_string_lossy().into_owned());
            let manifest = component.runtime_dir.join(STABLE_MANIFEST_NAME);
            if let Ok(normalized) = normalized_path_string(&manifest) {
                facts.registered_here = ofxr_names
                    .iter()
                    .any(|value| same_path(value, &normalized));
            }
        }
        Discovery::Bundled(bundled) => {
            facts.version = Some(bundled.version.clone());
            facts.bundled_only = true;
        }
        Discovery::Missing => {}
    }
    classify_status(&facts)
}

fn arm_impl(prefs: OfxrPreferences) -> Result<OfxrStatus, String> {
    let _command = command_guard();
    let values = map_preferences(&prefs)?;
    let local_directory = platform::local_directory()?;
    let bundled = platform::bundled_directory();
    let component = match discover_runtime(&local_directory, bundled.as_deref())? {
        Discovery::Installed(component) => component,
        Discovery::Bundled(bundled) => stage_bundled(&local_directory, &bundled)?,
        Discovery::Missing => {
            return Err(
                "OFXR Bridge is not installed: no versioned runtime layer was found under %LOCALAPPDATA%\\OFXR Bridge\\RuntimeLayer."
                    .to_string(),
            )
        }
    };

    let manifest = component.runtime_dir.join(STABLE_MANIFEST_NAME);
    let normalized = normalized_path_string(&manifest)?;

    // Single-owner rule: never arm alongside another manager's enabled
    // registration (a second manifest would load the layer twice). Our own
    // stale registration, including an older runtime directory, is allowed
    // and refreshed below.
    for scope in [RegScope::CurrentUser, RegScope::LocalMachine] {
        let names = platform::registered_value_names(scope)?;
        if let Some(foreign) = names
            .iter()
            .filter(|name| is_ofxr_manifest_name(name))
            .find(|name| !is_companion_manifest_for_root(name, &local_directory))
        {
            return Err(format!(
                "An OFXR Bridge layer is registered outside the Companion ({}). Disarm it from its own manager before arming here.",
                foreign
            ));
        }
    }

    // Retire stale Companion registrations left in an older runtime directory
    // so an upgrade cannot load the layer twice.
    for name in platform::registered_value_names(RegScope::CurrentUser)?
        .iter()
        .filter(|name| is_companion_manifest_for_root(name, &local_directory))
        .filter(|name| !same_path(name, &normalized))
    {
        platform::clear_registration_named(name)?;
    }

    // Reconcile this process's previous arm before creating a new event, the
    // same "disarm first" ordering OFXR's tray uses (main.cpp:443-445).
    if let Some(handle) = take_held_event() {
        platform::release_handle(handle, true)?;
    }

    let event_name = arm_event_name(&normalized);
    let handle = match platform::create_arm_event(&event_name) {
        Ok(handle) => handle,
        Err(reason) => {
            // The previous arm was already released; retire this manifest and
            // registration too, so no orphaned registration is left behind.
            let _ = platform::clear_registration(&manifest);
            let _ = fs::remove_file(&manifest);
            return Err(reason);
        }
    };

    let application = (|| -> Result<(), String> {
        write_manifest(
            &manifest,
            &component.runtime_dir.join(LAYER_DLL_NAME),
            &component.version,
        )?;
        write_ini(&component.runtime_dir, &values, Some(&event_name))?;
        platform::set_registration(&manifest)
    })();

    if let Err(reason) = application {
        // Roll back a partial arm; cached files stay inert on disk.
        let _ = platform::clear_registration(&manifest);
        let _ = platform::release_handle(handle, false);
        return Err(reason);
    }

    store_held_event(handle);
    Ok(status_impl())
}

fn disarm_impl() -> Result<OfxrStatus, String> {
    let _command = command_guard();
    let mut errors: Vec<String> = Vec::new();
    if let Some(handle) = take_held_event() {
        if let Err(reason) = platform::release_handle(handle, true) {
            errors.push(reason);
        }
    }
    if let Err(reason) = remove_companion_registrations() {
        errors.push(reason);
    }
    if let Err(reason) = remove_companion_manifests() {
        errors.push(reason);
    }
    if errors.is_empty() {
        Ok(status_impl())
    } else {
        Err(errors.join("\n"))
    }
}

/// Removes every Companion-owned registration for this install, including an
/// older versioned runtime directory. Never touches an OFXR tray manifest or
/// any other registration.
fn remove_companion_registrations() -> Result<(), String> {
    let local_directory = platform::local_directory()?;
    let names = platform::registered_value_names(RegScope::CurrentUser)?;
    let mut errors: Vec<String> = Vec::new();
    for name in names
        .iter()
        .filter(|name| is_companion_manifest_for_root(name, &local_directory))
    {
        if let Err(reason) = platform::clear_registration_named(name) {
            errors.push(reason);
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("\n"))
    }
}

/// Retires the Companion's stable manifest files so a later version upgrade
/// cannot keep selecting a stale runtime directory by a leftover manifest.
fn remove_companion_manifests() -> Result<(), String> {
    let local_directory = platform::local_directory()?;
    let root = local_directory.join(RUNTIME_ROOT_NAME);
    let entries = match fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("Reading {} failed: {error}", root.display())),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !is_real_directory(&path) {
            continue;
        }
        let manifest = path.join(STABLE_MANIFEST_NAME);
        match fs::remove_file(&manifest) {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!("Removing {} failed: {error}", manifest.display()))
            }
        }
    }
    Ok(())
}

/// Called from the Tauri RunEvent::Exit handler: signal the layer stop event
/// (running sessions end cleanly) and retire this Companion's registration and
/// manifests, matching the documented "closing the Companion disarms it".
pub fn shutdown_on_exit() {
    let _command = command_guard();
    if let Some(handle) = take_held_event() {
        let _ = platform::release_handle(handle, true);
    }
    let _ = remove_companion_registrations();
    let _ = remove_companion_manifests();
}

fn apply_impl(prefs: OfxrPreferences) -> Result<(), String> {
    let _command = command_guard();
    let values = map_preferences(&prefs)?;
    let local_directory = platform::local_directory()?;
    let bundled = platform::bundled_directory();
    match discover_runtime(&local_directory, bundled.as_deref())? {
        Discovery::Installed(component) => {
            write_ini(&component.runtime_dir, &values, None)
        }
        // Nothing to write until the component is installed/staged; apply is
        // idempotent and safe when the component is absent or not armed.
        Discovery::Bundled(_) | Discovery::Missing => Ok(()),
    }
}

// ---------------------------------------------------------------------------
// Pinned IPC commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn ofxr_status() -> OfxrStatus {
    status_impl()
}

#[tauri::command]
pub fn ofxr_arm(prefs: OfxrPreferences) -> Result<OfxrStatus, String> {
    arm_impl(prefs)
}

#[tauri::command]
pub fn ofxr_disarm() -> Result<OfxrStatus, String> {
    disarm_impl()
}

#[tauri::command]
pub fn ofxr_apply(prefs: OfxrPreferences) -> Result<(), String> {
    apply_impl(prefs)
}

// ---------------------------------------------------------------------------
// Win32 platform layer (no crates: advapi32/kernel32 through system FFI)
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod platform {
    use super::*;
    use std::ffi::c_void;
    use std::ptr::{null, null_mut};

    const HKEY_CURRENT_USER: isize = 0x8000_0001u32 as i32 as isize;
    const EVENT_MODIFY_STATE: u32 = 0x0002;
    const HKEY_LOCAL_MACHINE: isize = 0x8000_0002u32 as i32 as isize;
    const KEY_QUERY_VALUE: u32 = 0x0001;
    const KEY_SET_VALUE: u32 = 0x0002;
    const KEY_WOW64_64KEY: u32 = 0x0100;
    const REG_DWORD: u32 = 4;
    const REG_OPTION_NON_VOLATILE: u32 = 0;
    const ERROR_SUCCESS: i32 = 0;
    const ERROR_FILE_NOT_FOUND: i32 = 2;
    const ERROR_PATH_NOT_FOUND: i32 = 3;
    const ERROR_INVALID_DATA: i32 = 13;
    const ERROR_BUSY: i32 = 32;
    const ERROR_ALREADY_EXISTS: i32 = 183;
    const ERROR_NO_MORE_ITEMS: i32 = 259;
    const OPENXR_IMPLICIT_KEY: &str = "SOFTWARE\\Khronos\\OpenXR\\1\\ApiLayers\\Implicit";

    #[link(name = "advapi32")]
    extern "system" {
        fn RegCreateKeyExW(
            key: isize,
            sub_key: *const u16,
            reserved: u32,
            class: *const u16,
            options: u32,
            sam: u32,
            security: *const c_void,
            result: *mut isize,
            disposition: *mut u32,
        ) -> i32;
        fn RegOpenKeyExW(
            key: isize,
            sub_key: *const u16,
            options: u32,
            sam: u32,
            result: *mut isize,
        ) -> i32;
        fn RegSetValueExW(
            key: isize,
            value_name: *const u16,
            reserved: u32,
            kind: u32,
            data: *const u8,
            size: u32,
        ) -> i32;
        fn RegQueryValueExW(
            key: isize,
            value_name: *const u16,
            reserved: *mut u32,
            kind: *mut u32,
            data: *mut u8,
            size: *mut u32,
        ) -> i32;
        fn RegDeleteValueW(key: isize, value_name: *const u16) -> i32;
        fn RegEnumValueW(
            key: isize,
            index: u32,
            name: *mut u16,
            name_size: *mut u32,
            reserved: *mut u32,
            kind: *mut u32,
            data: *mut u8,
            data_size: *mut u32,
        ) -> i32;
        fn RegCloseKey(key: isize) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateEventW(
            attributes: *const c_void,
            manual_reset: i32,
            initial_state: i32,
            name: *const u16,
        ) -> isize;
        fn SetEvent(handle: isize) -> i32;
        fn OpenEventW(access: u32, inherit: i32, name: *const u16) -> isize;
        fn CloseHandle(handle: *mut c_void) -> i32;
        fn GetLastError() -> u32;
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn native_error(status: i32) -> String {
        std::io::Error::from_raw_os_error(status).to_string()
    }

    fn root_key(scope: RegScope) -> isize {
        match scope {
            RegScope::CurrentUser => HKEY_CURRENT_USER,
            RegScope::LocalMachine => HKEY_LOCAL_MACHINE,
        }
    }

    pub fn local_directory() -> Result<PathBuf, String> {
        let base = std::env::var_os("LOCALAPPDATA")
            .ok_or_else(|| "LOCALAPPDATA is not set.".to_string())?;
        Ok(PathBuf::from(base).join(LOCAL_DIRECTORY_NAME))
    }

    pub fn bundled_directory() -> Option<PathBuf> {
        std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(|parent| parent.join("ofxr")))
    }

    pub fn create_arm_event(name: &str) -> Result<isize, String> {
        match try_create_arm_event(name) {
            Ok(handle) => Ok(handle),
            Err(EventCreateError::AlreadyExists) => {
                // A previous Companion session (or its still-loaded layer)
                // keeps the named event alive. Signal it, then retry once.
                stop_existing_arm_event(name);
                match try_create_arm_event(name) {
                    Ok(handle) => Ok(handle),
                    Err(EventCreateError::AlreadyExists) => Err(
                        "The OFXR arm control already exists; another OFXR Bridge manager holds this registration."
                            .to_string(),
                    ),
                    Err(EventCreateError::Failed(reason)) => Err(reason),
                }
            }
            Err(EventCreateError::Failed(reason)) => Err(reason),
        }
    }

    enum EventCreateError {
        AlreadyExists,
        Failed(String),
    }

    fn try_create_arm_event(name: &str) -> Result<isize, EventCreateError> {
        let wide_name = wide(name);
        let handle = unsafe { CreateEventW(null(), 1, 0, wide_name.as_ptr()) };
        if handle == 0 {
            return Err(EventCreateError::Failed(format!(
                "Creating the OFXR arm control failed: {}",
                std::io::Error::last_os_error()
            )));
        }
        let status = unsafe { GetLastError() } as i32;
        if status == ERROR_ALREADY_EXISTS {
            unsafe {
                CloseHandle(handle as *mut c_void);
            }
            return Err(EventCreateError::AlreadyExists);
        }
        Ok(handle)
    }

    fn stop_existing_arm_event(name: &str) {
        let wide_name = wide(name);
        unsafe {
            let handle = OpenEventW(EVENT_MODIFY_STATE, 0, wide_name.as_ptr());
            if handle != 0 {
                SetEvent(handle);
                CloseHandle(handle as *mut c_void);
            }
        }
    }

    pub fn release_handle(handle: isize, signal: bool) -> Result<(), String> {
        let mut failure = None;
        if signal && unsafe { SetEvent(handle) } == 0 {
            failure = Some(format!(
                "Stopping the loaded OFXR layer failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        unsafe {
            CloseHandle(handle as *mut c_void);
        }
        match failure {
            Some(reason) => Err(reason),
            None => Ok(()),
        }
    }

    fn open_key(scope: RegScope, sam: u32) -> Result<Option<isize>, String> {
        let sub_key = wide(OPENXR_IMPLICIT_KEY);
        let mut key: isize = 0;
        let status = unsafe {
            RegOpenKeyExW(
                root_key(scope),
                sub_key.as_ptr(),
                0,
                sam | KEY_WOW64_64KEY,
                &mut key,
            )
        };
        match status {
            ERROR_SUCCESS => Ok(Some(key)),
            ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND => Ok(None),
            other => Err(format!(
                "Opening the OpenXR layer key failed ({other}): {}",
                native_error(other)
            )),
        }
    }

    fn create_key() -> Result<isize, String> {
        let sub_key = wide(OPENXR_IMPLICIT_KEY);
        let mut key: isize = 0;
        let mut disposition: u32 = 0;
        let status = unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                sub_key.as_ptr(),
                0,
                null(),
                REG_OPTION_NON_VOLATILE,
                KEY_QUERY_VALUE | KEY_SET_VALUE | KEY_WOW64_64KEY,
                null(),
                &mut key,
                &mut disposition,
            )
        };
        if status != ERROR_SUCCESS {
            return Err(format!(
                "Opening the OpenXR layer key failed ({status}): {}",
                native_error(status)
            ));
        }
        Ok(key)
    }

    /// Mirrors OFXR's `register_manifest` (implicit_layer.cpp:255-304):
    /// value name = normalised absolute manifest path, REG_DWORD 0, read back.
    pub fn set_registration(manifest: &Path) -> Result<(), String> {
        let value_name = wide(&normalized_path_string(manifest)?);
        let key = create_key()?;
        let enabled: u32 = 0;
        let mut status = unsafe {
            RegSetValueExW(
                key,
                value_name.as_ptr(),
                0,
                REG_DWORD,
                &enabled as *const u32 as *const u8,
                std::mem::size_of::<u32>() as u32,
            )
        };
        if status == ERROR_SUCCESS {
            let mut value: u32 = 1;
            let mut size: u32 = std::mem::size_of::<u32>() as u32;
            let mut kind: u32 = 0;
            status = unsafe {
                RegQueryValueExW(
                    key,
                    value_name.as_ptr(),
                    null_mut(),
                    &mut kind,
                    &mut value as *mut u32 as *mut u8,
                    &mut size,
                )
            };
            if status == ERROR_SUCCESS
                && (kind != REG_DWORD || size != std::mem::size_of::<u32>() as u32 || value != 0)
            {
                status = ERROR_INVALID_DATA;
            }
        }
        unsafe {
            RegCloseKey(key);
        }
        if status != ERROR_SUCCESS {
            return Err(format!(
                "Arming the OpenXR layer failed ({status}): {}",
                native_error(status)
            ));
        }
        Ok(())
    }

    /// Mirrors OFXR's `unregister_manifest` (implicit_layer.cpp:306-362):
    /// delete the exact value, then verify it is gone.
    pub fn clear_registration(manifest: &Path) -> Result<(), String> {
        clear_registration_named(&normalized_path_string(manifest)?)
    }

    /// Deletes one exact HKCU registration value (a normalised absolute
    /// manifest path) and verifies it is gone.
    pub fn clear_registration_named(value_name: &str) -> Result<(), String> {
        let value_name = wide(value_name);
        let key = match open_key(RegScope::CurrentUser, KEY_QUERY_VALUE | KEY_SET_VALUE)? {
            Some(key) => key,
            None => return Ok(()),
        };
        let mut status = unsafe { RegDeleteValueW(key, value_name.as_ptr()) };
        if status == ERROR_SUCCESS || status == ERROR_FILE_NOT_FOUND {
            let mut size: u32 = 0;
            status = unsafe {
                RegQueryValueExW(
                    key,
                    value_name.as_ptr(),
                    null_mut(),
                    null_mut(),
                    null_mut(),
                    &mut size,
                )
            };
            if status == ERROR_SUCCESS {
                status = ERROR_BUSY;
            }
        }
        unsafe {
            RegCloseKey(key);
        }
        if status == ERROR_FILE_NOT_FOUND || status == ERROR_PATH_NOT_FOUND {
            return Ok(());
        }
        if status != ERROR_SUCCESS {
            return Err(format!(
                "Disabling/removing the OFXR registration failed ({status}): {}",
                native_error(status)
            ));
        }
        Ok(())
    }

    fn enabled_dword(key: isize, name: &str) -> Result<bool, i32> {
        let name = wide(name);
        let mut kind: u32 = 0;
        let mut value: u32 = 1;
        let mut size: u32 = std::mem::size_of::<u32>() as u32;
        let status = unsafe {
            RegQueryValueExW(
                key,
                name.as_ptr(),
                null_mut(),
                &mut kind,
                &mut value as *mut u32 as *mut u8,
                &mut size,
            )
        };
        if status != ERROR_SUCCESS {
            return Err(status);
        }
        Ok(kind == REG_DWORD && size == std::mem::size_of::<u32>() as u32 && value == 0)
    }

    /// Returns only enabled (`REG_DWORD` 0) registrations, mirroring
    /// `manifest_registered` (implicit_layer.cpp:364-396); a disabled leftover
    /// written by an interrupted cleanup is not an active registration.
    pub fn registered_value_names(scope: RegScope) -> Result<Vec<String>, String> {
        let key = match open_key(scope, KEY_QUERY_VALUE)? {
            Some(key) => key,
            None => return Ok(Vec::new()),
        };
        let mut names = Vec::new();
        let mut buffer = vec![0u16; 32768];
        let mut index: u32 = 0;
        loop {
            let mut length: u32 = buffer.len() as u32;
            let status = unsafe {
                RegEnumValueW(
                    key,
                    index,
                    buffer.as_mut_ptr(),
                    &mut length,
                    null_mut(),
                    null_mut(),
                    null_mut(),
                    null_mut(),
                )
            };
            if status == ERROR_NO_MORE_ITEMS {
                break;
            }
            if status != ERROR_SUCCESS {
                unsafe {
                    RegCloseKey(key);
                }
                return Err(format!(
                    "Enumerating the OpenXR layer registrations failed ({status}): {}",
                    native_error(status)
                ));
            }
            let length = (length as usize).min(buffer.len());
            let name = String::from_utf16_lossy(&buffer[..length]);
            match enabled_dword(key, &name) {
                Ok(true) => names.push(name),
                Ok(false) => {}
                Err(status) => {
                    unsafe {
                        RegCloseKey(key);
                    }
                    return Err(format!(
                        "Reading an OpenXR layer registration failed ({status}): {}",
                        native_error(status)
                    ));
                }
            }
            index += 1;
        }
        unsafe {
            RegCloseKey(key);
        }
        Ok(names)
    }
}

#[cfg(not(windows))]
mod platform {
    use super::*;

    const UNSUPPORTED: &str = "OFXR component management is only available on Windows.";

    pub fn local_directory() -> Result<PathBuf, String> {
        Err(UNSUPPORTED.to_string())
    }

    pub fn bundled_directory() -> Option<PathBuf> {
        None
    }

    pub fn create_arm_event(_name: &str) -> Result<isize, String> {
        Err(UNSUPPORTED.to_string())
    }

    pub fn release_handle(_handle: isize, _signal: bool) -> Result<(), String> {
        Ok(())
    }

    pub fn set_registration(_manifest: &Path) -> Result<(), String> {
        Err(UNSUPPORTED.to_string())
    }

    pub fn clear_registration(_manifest: &Path) -> Result<(), String> {
        Err(UNSUPPORTED.to_string())
    }

    pub fn clear_registration_named(_value_name: &str) -> Result<(), String> {
        Err(UNSUPPORTED.to_string())
    }

    pub fn registered_value_names(_scope: RegScope) -> Result<Vec<String>, String> {
        Err(UNSUPPORTED.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new(tag: &str) -> Self {
            static COUNTER: AtomicU64 = AtomicU64::new(0);
            let sequence = COUNTER.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "galaxyxr-ofxr-{tag}-{}-{sequence}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).expect("create temp root");
            Self(path)
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn prefs(
        mode: &str,
        scale: u32,
        bidirectional: bool,
        logging: bool,
        max_log_mb: u32,
        flush_each_event: bool,
        overlay: &str,
    ) -> OfxrPreferences {
        OfxrPreferences {
            enabled: true,
            mode: mode.to_string(),
            scale,
            bidirectional,
            logging,
            max_log_mb,
            flush_each_event,
            overlay: overlay.to_string(),
        }
    }

    fn sample_prefs() -> OfxrPreferences {
        prefs("fidelityfx", 50, false, false, 32, false, "upper-right")
    }

    fn write_layer_files(directory: &Path, manifest: Option<&str>) {
        fs::create_dir_all(directory).expect("create runtime directory");
        fs::write(directory.join(LAYER_DLL_NAME), b"layer").expect("write layer dll");
        if let Some(version) = manifest {
            fs::write(
                directory.join(STABLE_MANIFEST_NAME),
                format!("{{\"api_layer\":{{\"implementation_version\":\"{version}\"}}}}"),
            )
            .expect("write manifest");
        }
    }

    #[test]
    fn ini_merge_writes_owned_keys_and_preserves_foreign_content() {
        let existing = "[ofxr]\r\nenabled=1\r\nframe_generation=ofxr\r\nmotion_vectors=off\r\nbackend=fidelityfx\r\n\r\n[tray]\r\nbackend=nvidia\r\n\r\n[diagnostics]\r\nlogging_enabled=0\r\nmax_file_mb=32\r\nflush_each_event=0\r\ncustom=keep\r\n\r\n[overlay]\r\nposition=upper_right\r\n";
        let values = map_preferences(&prefs(
            "nvidia-slow",
            75,
            true,
            true,
            64,
            true,
            "lower-left",
        ))
        .expect("map prefs");
        let rendered = render_ini(Some(existing), &values, Some("Local\\OFXRBridgeArmStop-123"));

        assert!(rendered.contains("enabled=1"), "foreign [ofxr] key kept");
        assert!(rendered.contains("frame_generation=ofxr"));
        assert!(rendered.contains("motion_vectors=off"));
        assert!(rendered.contains("[tray]\r\nbackend=nvidia"));
        assert!(rendered.contains("custom=keep"), "foreign [diagnostics] key kept");
        assert!(rendered.contains("backend=nvidia"));
        assert!(rendered.contains("nvidia_preset=slow"));
        assert!(rendered.contains("nvidia_input_scale=75"));
        assert!(rendered.contains("nvidia_bidirectional=1"));
        assert!(rendered.contains("logging_enabled=1"));
        assert!(rendered.contains("max_file_mb=64"));
        assert!(rendered.contains("flush_each_event=1"));
        assert!(rendered.contains("position=lower_left"));
        assert!(rendered.contains("control_event=Local\\OFXRBridgeArmStop-123"));
        assert_eq!(rendered.matches("nvidia_preset=").count(), 1);
        assert_eq!(rendered.matches("backend=nvidia").count(), 2);
    }

    #[test]
    fn ini_merge_builds_missing_sections_and_is_idempotent() {
        let values = map_preferences(&sample_prefs()).expect("map prefs");
        let first = render_ini(None, &values, Some("Local\\OFXRBridgeArmStop-1"));
        assert!(first.starts_with("[ofxr]\r\n"));
        assert!(first.contains("[diagnostics]\r\n"));
        assert!(first.contains("[overlay]\r\n"));
        assert!(first.contains("control_event=Local\\OFXRBridgeArmStop-1"));

        let second = render_ini(Some(&first), &values, Some("Local\\OFXRBridgeArmStop-1"));
        assert_eq!(first, second);
    }

    #[test]
    fn ini_apply_preserves_an_existing_control_event() {
        let existing = "[ofxr]\ncontrol_event=Local\\OFXRBridgeArmStop-9\n";
        let values = map_preferences(&sample_prefs()).expect("map prefs");
        let rendered = render_ini(Some(existing), &values, None);
        assert!(rendered.contains("control_event=Local\\OFXRBridgeArmStop-9"));
    }

    #[test]
    fn preference_mapping_matches_the_ini_contract() {
        let cases = [
            ("fidelityfx", "fidelityfx", "medium"),
            ("nvidia-fast", "nvidia", "fast"),
            ("nvidia-medium", "nvidia", "medium"),
            ("nvidia-slow", "nvidia", "slow"),
        ];
        for (mode, backend, preset) in cases {
            let mapped =
                map_preferences(&prefs(mode, 50, false, false, 32, false, "upper-right"))
                    .expect("valid mode");
            assert_eq!(mapped.backend, backend, "backend for {mode}");
            assert_eq!(mapped.nvidia_preset, preset, "preset for {mode}");
        }

        let mapped = map_preferences(&prefs(
            "nvidia-medium",
            100,
            true,
            true,
            128,
            true,
            "lower-right",
        ))
        .expect("valid prefs");
        assert_eq!(mapped.nvidia_input_scale, 100);
        assert!(mapped.nvidia_bidirectional);
        assert!(mapped.logging_enabled);
        assert_eq!(mapped.max_file_mb, 128);
        assert!(mapped.flush_each_event);
        assert_eq!(mapped.overlay, "lower_right");

        for (preference, ini) in [
            ("off", "off"),
            ("upper-left", "upper_left"),
            ("upper-right", "upper_right"),
            ("lower-left", "lower_left"),
            ("lower-right", "lower_right"),
        ] {
            let mapped = map_preferences(&prefs(
                "fidelityfx", 50, false, false, 32, false, preference,
            ))
            .expect("valid overlay");
            assert_eq!(mapped.overlay, ini, "overlay spelling for {preference}");
        }
        for scale in [50, 75, 100] {
            assert_eq!(
                map_preferences(&prefs(
                    "fidelityfx", scale, false, false, 32, false, "off"
                ))
                .expect("valid scale")
                .nvidia_input_scale,
                scale
            );
        }

        assert!(map_preferences(&prefs("nvidia-ultra", 50, false, false, 32, false, "off"))
            .is_err());
        assert!(map_preferences(&prefs("fidelityfx", 60, false, false, 32, false, "off"))
            .is_err());
        assert!(map_preferences(&prefs("fidelityfx", 50, false, false, 32, false, "top"))
            .is_err());
    }

    #[test]
    fn event_name_is_fnv1a64_of_the_lowercased_utf16_path() {
        let path = r"C:\Users\Alice\AppData\Local\OFXR Bridge\RuntimeLayer\v002\XR_APILAYER_XRFrameBridge_manual-1-1.json";
        assert_eq!(
            arm_event_name(path),
            r"Local\OFXRBridgeArmStop-847772851619026425"
        );
        assert_eq!(
            arm_event_name(&path.to_ascii_uppercase()),
            arm_event_name(path),
            "ASCII case folding only"
        );
        // Only A-Z fold; other scripts keep distinct hashes.
        assert_ne!(fnv1a64_utf16_lower("\u{00C4}"), fnv1a64_utf16_lower("\u{00E4}"));
    }

    #[test]
    fn manifest_json_matches_ofxr_shape_with_an_absolute_library_path() {
        let library = std::env::temp_dir()
            .join("OFXR Bridge")
            .join("RuntimeLayer")
            .join("v002")
            .join(LAYER_DLL_NAME);
        let text = manifest_json(&library, "2").expect("render manifest");
        let document: Value = serde_json::from_str(&text).expect("valid manifest json");

        assert_eq!(document["file_format_version"], "1.0.0");
        let layer = &document["api_layer"];
        assert_eq!(layer["name"], "XR_APILAYER_XRFrameBridge_diagnostic");
        assert_eq!(layer["api_version"], "1.0");
        assert_eq!(layer["implementation_version"], "2");
        assert_eq!(layer["disable_environment"], "XRFG_DISABLE_OFXR_BRIDGE");
        let path = layer["library_path"].as_str().expect("library path string");
        assert!(Path::new(path).is_absolute());
        assert_eq!(path, library.to_string_lossy());
    }

    #[test]
    fn version_directories_mirror_ofxr_naming() {
        let base = Path::new("C:\\base");
        assert_eq!(
            runtime_version_directory(base, "2").expect("version dir"),
            base.join("RuntimeLayer").join("v002")
        );
        assert_eq!(
            runtime_version_directory(base, "002")
                .expect("version dir")
                .file_name()
                .and_then(|name| name.to_str()),
            Some("v002")
        );
        assert!(runtime_version_directory(base, "2a").is_err());
        assert_eq!(version_from_dir_name("v002"), Some("2".to_string()));
        assert_eq!(version_from_dir_name("v000"), Some("0".to_string()));
        assert_eq!(version_from_dir_name("V007"), Some("7".to_string()));
        assert_eq!(version_from_dir_name("v12"), None);
        assert_eq!(version_from_dir_name("runtime"), None);
    }

    #[test]
    fn companion_registration_matching_is_scoped_to_our_runtime_root() {
        let local = Path::new("C:\\Users\\Alice\\AppData\\Local\\OFXR Bridge");
        assert!(is_companion_manifest_for_root(
            r"C:\Users\Alice\AppData\Local\OFXR Bridge\RuntimeLayer\v002\XR_APILAYER_XRFrameBridge_manual-1-1.json",
            local
        ));
        assert!(is_companion_manifest_for_root(
            r"c:\users\alice\appdata\local\ofxr bridge\runtimelayer\v003\XR_APILAYER_XRFrameBridge_manual-1-1.JSON",
            local
        ));
        assert!(!is_companion_manifest_for_root(
            r"C:\Users\Alice\AppData\Local\OFXR Bridge\RuntimeLayer\v002\XR_APILAYER_XRFrameBridge_manual-1-2.json",
            local
        ));
        assert!(!is_companion_manifest_for_root(
            r"C:\Other\RuntimeLayer\v002\XR_APILAYER_XRFrameBridge_manual-1-1.json",
            local
        ));
        assert!(!is_companion_manifest_for_root(
            r"C:\Users\Alice\AppData\Local\OFXR Bridge\RuntimeLayerEvil\v002\XR_APILAYER_XRFrameBridge_manual-1-1.json",
            local
        ));
    }

    #[test]
    fn status_classification_covers_every_state() {
        let installed = StatusFacts {
            version: Some("2".to_string()),
            runtime_dir: Some("C:\\layer\\v002".to_string()),
            ..StatusFacts::default()
        };
        assert_eq!(classify_status(&installed).state, STATE_READY);
        assert_eq!(
            classify_status(&StatusFacts {
                held: true,
                registered_here: true,
                ..installed.clone()
            })
            .state,
            STATE_ARMED
        );
        assert_eq!(
            classify_status(&StatusFacts {
                any_registration: true,
                ..installed.clone()
            })
            .state,
            STATE_ARMED_EXTERNAL
        );
        assert_eq!(
            classify_status(&StatusFacts {
                any_registration: true,
                held: true,
                registered_here: false,
                ..installed.clone()
            })
            .state,
            STATE_ARMED_EXTERNAL
        );
        assert_eq!(
            classify_status(&StatusFacts {
                held: true,
                registered_here: true,
                any_registration: true,
                ..installed.clone()
            })
            .state,
            STATE_ARMED,
            "our own registration wins over an additional external value"
        );
        assert_eq!(
            classify_status(&StatusFacts::default()).state,
            STATE_NOT_INSTALLED
        );
        assert_eq!(
            classify_status(&StatusFacts {
                error: Some("boom".to_string()),
                ..installed
            })
            .state,
            STATE_UNAVAILABLE
        );
    }

    #[test]
    fn discovery_ranks_runtime_directories_by_version_only() {
        let root = TempRoot::new("discovery");
        let local = root.0.join("OFXR Bridge");
        write_layer_files(&local.join("RuntimeLayer").join("v001"), Some("1"));
        write_layer_files(&local.join("RuntimeLayer").join("v002"), Some("2"));
        // A newer install without a leftover manifest (OFRX's own disarm
        // retires it) must still win over an older directory that has one.
        write_layer_files(&local.join("RuntimeLayer").join("v003"), None);
        fs::create_dir_all(local.join("RuntimeLayer").join("scratch")).expect("scratch dir");

        match discover_runtime(&local, None).expect("discover") {
            Discovery::Installed(component) => {
                assert_eq!(component.version, "3");
                assert!(component.runtime_dir.ends_with(Path::new("v003")));
            }
            other => panic!("unexpected discovery: {other:?}"),
        }
    }

    #[test]
    fn staging_copies_the_bundled_layer_and_is_then_discoverable() {
        let root = TempRoot::new("staging");
        let local = root.0.join("OFXR Bridge");
        let bundled_dir = root.0.join("ofxr");
        write_layer_files(&bundled_dir, Some("5"));
        fs::write(bundled_dir.join(INI_NAME), "[ofxr]\nenabled=1\n").expect("bundled ini");

        let discovery = discover_runtime(&local, Some(&bundled_dir)).expect("discover bundled");
        let bundled = match discovery {
            Discovery::Bundled(bundled) => bundled,
            other => panic!("unexpected discovery: {other:?}"),
        };
        assert_eq!(bundled.version, "5");

        let component = stage_bundled(&local, &bundled).expect("stage bundled");
        assert_eq!(
            component.runtime_dir,
            local.join("RuntimeLayer").join("v005")
        );
        assert!(component.runtime_dir.join(LAYER_DLL_NAME).is_file());
        assert!(component.runtime_dir.join(INI_NAME).is_file());

        match discover_runtime(&local, None).expect("rediscover") {
            Discovery::Installed(component) => {
                assert_eq!(component.version, "5");
                assert!(component.runtime_dir.ends_with(Path::new("v005")));
            }
            other => panic!("unexpected rediscovery: {other:?}"),
        }
    }

    #[test]
    fn write_ini_merges_into_an_existing_runtime_file() {
        let root = TempRoot::new("ini");
        let runtime_dir = root.0.join("RuntimeLayer").join("v002");
        fs::create_dir_all(&runtime_dir).expect("runtime dir");
        fs::write(
            runtime_dir.join(INI_NAME),
            "[ofxr]\r\nenabled=1\r\nbackend=fidelityfx\r\n",
        )
        .expect("existing ini");

        let values =
            map_preferences(&prefs("nvidia-fast", 75, true, true, 96, true, "off"))
                .expect("map prefs");
        write_ini(&runtime_dir, &values, Some("Local\\OFXRBridgeArmStop-7")).expect("write ini");
        let text = fs::read_to_string(runtime_dir.join(INI_NAME)).expect("read ini");

        assert!(text.contains("enabled=1"));
        assert!(text.contains("backend=nvidia"));
        assert!(text.contains("nvidia_preset=fast"));
        assert!(text.contains("nvidia_input_scale=75"));
        assert!(text.contains("position=off"));
        assert!(text.contains("max_file_mb=96"));
        assert!(text.contains("control_event=Local\\OFXRBridgeArmStop-7"));
    }
}
