//! Owned-driver installation and reversible SteamVR settings changes.
//! All entry points serialize with the native driver's settings writer.
pub mod settings_cleanup;
pub mod runtime_status;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeSet, fs, io::Write, path::{Path, PathBuf}, process::Command, time::{SystemTime, UNIX_EPOCH}};
use sysinfo::{ProcessesToUpdate, System};

const DRIVER: &str = "GalaxyXRNative";
const LEGACY: &str = "CustomHeadsetOpenVR";
// 2026-09-23: Setup cleanup follows all Companion profile destinations, but
// each removal still requires its existing fingerprint/value or journal proof.
// This list is not an ownership allowlist for unjournaled uninstall cleanup.
const COMPANION_PROFILE_SECTIONS: [&str; 5] = [
    "vrlink_xrvst2ue", "vrlink_xrvst2", "vrlink_Galaxy XR",
    "vrlink_Oculus Quest Pro", "vrlink_PICO 4 Pro",
];
type Result<T> = std::result::Result<T, String>;

#[derive(Deserialize, Debug)]
pub struct SettingChange {
    section: String,
    key: String,
    present: bool,
    #[serde(default)]
    value: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallReport {
    removed_paths: Vec<String>,
    restored_settings: usize,
    legacy_reset: bool,
    warnings: Vec<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InstallReport { registered_path: String, legacy_detected: bool }

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct IdentityCleanupReport {
    removed_keys: Vec<String>,
    removed_sections: Vec<String>,
    warnings: Vec<String>,
    backup_path: Option<String>,
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::{ffi::c_void, os::windows::{ffi::OsStrExt, fs::MetadataExt, process::CommandExt}};
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateMutexW(attributes: *const c_void, initial: i32, name: *const u16) -> *mut c_void;
        fn WaitForSingleObject(handle: *mut c_void, milliseconds: u32) -> u32;
        fn ReleaseMutex(handle: *mut c_void) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
        fn MoveFileExW(old: *const u16, new: *const u16, flags: u32) -> i32;
    }
    pub struct Lock(*mut c_void);
    impl Lock {
        pub fn acquire() -> Result<Self> {
            let name: Vec<u16> = "Local\\GalaxyXRNativeSteamVRSettings\0".encode_utf16().collect();
            unsafe {
                let handle = CreateMutexW(std::ptr::null(), 0, name.as_ptr());
                if handle.is_null() { return Err("Cannot create SteamVR settings mutex".into()); }
                let status = WaitForSingleObject(handle, 10000);
                if status != 0 && status != 0x80 { CloseHandle(handle); return Err("SteamVR settings are busy; retry".into()); }
                Ok(Self(handle))
            }
        }
    }
    impl Drop for Lock { fn drop(&mut self) { unsafe { ReleaseMutex(self.0); CloseHandle(self.0); } } }
    pub fn replace(from: &Path, to: &Path) -> Result<()> {
        let a: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
        let b: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe { MoveFileExW(a.as_ptr(), b.as_ptr(), 1 | 8) } == 0 { Err(format!("Replace {}: {}", to.display(), std::io::Error::last_os_error())) } else { Ok(()) }
    }
    pub fn reparse(meta: &fs::Metadata) -> bool { meta.file_attributes() & 0x400 != 0 }
    pub fn hidden(command: &mut Command) { command.creation_flags(0x08000000); }
}
#[cfg(not(windows))]
mod platform {
    use super::*;
    pub struct Lock;
    impl Lock { pub fn acquire() -> Result<Self> { Ok(Self) } }
    pub fn replace(from: &Path, to: &Path) -> Result<()> { fs::rename(from, to).map_err(|e| e.to_string()) }
    pub fn reparse(meta: &fs::Metadata) -> bool { meta.file_type().is_symlink() }
    pub fn hidden(_: &mut Command) {}
}

fn normalized(path: &Path) -> String {
    // Hosted Windows TEMP can use RUNNER~1 while canonical package paths use
    // runneradmin (2026-09-22). Resolve the existing ancestor, including for a
    // destination that has not been created yet, before comparing boundaries.
    // Reparse-point rejection remains in safe_chain/safe_tree at mutation sites.
    #[cfg(windows)]
    let resolved = path.ancestors().find_map(|ancestor| {
        fs::canonicalize(ancestor).ok().and_then(|canonical|
            path.strip_prefix(ancestor).ok().map(|suffix| canonical.join(suffix)))
    });
    #[cfg(windows)]
    let path = resolved.as_deref().unwrap_or(path);
    path.to_string_lossy().replace('/', "\\").trim_start_matches("\\\\?\\").trim_end_matches('\\').to_lowercase()
}
fn same_path(a: &Path, b: &Path) -> bool { normalized(a) == normalized(b) }
fn error(path: &Path, e: impl std::fmt::Display) -> String { format!("{}: {}", path.display(), e) }
fn read_json(path: &Path) -> Result<Value> {
    let data = fs::read(path).map_err(|e| error(path, e))?;
    parse_json_bytes(path, &data)
}
fn parse_json_bytes(path: &Path, bytes: &[u8]) -> Result<Value> {
    // Be tolerant of UTF-8 BOMs from older Windows PowerShell portable builds.
    // New builds write BOM-free UTF-8, but accepting the BOM keeps already
    // generated/installed packages repairable by the Companion application.
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    // SteamVR manifests/settings may contain C/C++ comments. Strip comments
    // only outside JSON strings, retaining escaped quotes and line breaks.
    let mut out = bytes.to_vec();
    let (mut i, mut string, mut escape) = (0, false, false);
    while i < bytes.len() {
        let c = bytes[i];
        if string { if escape { escape = false; } else if c == b'\\' { escape = true; } else if c == b'"' { string = false; } }
        else if c == b'"' { string = true; }
        else if c == b'/' && bytes.get(i + 1) == Some(&b'/') {
            while i < bytes.len() && bytes[i] != b'\n' { out[i] = b' '; i += 1; } continue;
        } else if c == b'/' && bytes.get(i + 1) == Some(&b'*') {
            out[i] = b' '; out[i + 1] = b' '; i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') { if bytes[i] != b'\n' { out[i] = b' '; } i += 1; }
            if i + 1 >= bytes.len() { return Err(error(path, "Unterminated JSON comment")); }
            out[i] = b' '; out[i + 1] = b' '; i += 2; continue;
        }
        i += 1;
    }
    serde_json::from_slice(&out).map_err(|e| error(path, e))
}
fn read_settings(path: &Path) -> Result<Value> {
    let data = if path.exists() { read_json(path)? } else { json!({}) };
    if !data.is_object() { return Err(error(path, "Expected JSON object")); }
    Ok(data)
}
fn safe_chain(path: &Path) -> Result<()> {
    for part in path.ancestors() {
        match fs::symlink_metadata(part) {
            Ok(meta) if platform::reparse(&meta) || meta.file_type().is_symlink() => return Err(error(part, "Refusing reparse point / symbolic link")),
            Ok(_) => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(error(part, e)),
        }
    }
    Ok(())
}
fn safe_tree(path: &Path) -> Result<()> {
    safe_chain(path)?;
    if !path.exists() { return Ok(()); }
    for entry in fs::read_dir(path).map_err(|e| error(path, e))? {
        let p = entry.map_err(|e| e.to_string())?.path();
        let m = fs::symlink_metadata(&p).map_err(|e| error(&p, e))?;
        if platform::reparse(&m) || m.file_type().is_symlink() { return Err(error(&p, "Refusing reparse point / symbolic link")); }
        if m.is_dir() { safe_tree(&p)?; }
    }
    Ok(())
}
fn atomic_bytes(path: &Path, bytes: &[u8]) -> Result<()> {
    safe_chain(path)?;
    let parent = path.parent().ok_or("File has no parent")?;
    fs::create_dir_all(parent).map_err(|e| error(parent, e))?;
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos();
    let tmp = parent.join(format!(".galaxyxr-{}-{}.tmp", std::process::id(), stamp));
    let result = (|| {
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&tmp).map_err(|e| error(&tmp, e))?;
        file.write_all(bytes).and_then(|_| file.sync_all()).map_err(|e| error(&tmp, e))?;
        drop(file);
        platform::replace(&tmp, path)
    })();
    if result.is_err() { let _ = fs::remove_file(&tmp); }
    result
}
fn atomic_json(path: &Path, value: &Value) -> Result<()> { atomic_bytes(path, &serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?) }

struct Context { steamvr: PathBuf, paths_file: PathBuf, settings: PathBuf, data: PathBuf, managed: PathBuf }
impl Context {
    fn live(steamvr: String) -> Result<Self> {
        let steamvr = PathBuf::from(steamvr);
        safe_chain(&steamvr)?;
        if !steamvr.is_absolute() || !steamvr.join("bin/win64/vrpathreg.exe").is_file() { return Err("Invalid SteamVR installation path".into()); }
        let paths_file = PathBuf::from(std::env::var_os("LOCALAPPDATA").ok_or("LOCALAPPDATA unavailable")?).join("openvr/openvrpaths.vrpath");
        safe_chain(&paths_file)?;
        let paths = read_json(&paths_file)?;
        let config = paths["config"].as_array().and_then(|a| a.first()).and_then(Value::as_str).ok_or("SteamVR config directory unavailable in openvrpaths.vrpath")?;
        let settings = PathBuf::from(config).join("steamvr.vrsettings");
        if !settings.is_absolute() { return Err("SteamVR config path must be absolute".into()); }
        safe_chain(&settings)?;
        let settings = if settings.exists() { fs::canonicalize(&settings).map_err(|e|error(&settings,e))? }
            else { fs::canonicalize(settings.parent().unwrap()).map_err(|e|error(&settings,e))?.join("steamvr.vrsettings") };
        let data = PathBuf::from(std::env::var_os("APPDATA").ok_or("APPDATA unavailable")?).join("GalaxyXR/CustomHeadset");
        safe_chain(&data)?;
        let managed = PathBuf::from(std::env::var_os("LOCALAPPDATA").ok_or("LOCALAPPDATA unavailable")?).join("GalaxyXR/Drivers");
        safe_chain(&managed)?;
        Ok(Self { steamvr, paths_file, settings, data, managed })
    }
    fn journal(&self) -> PathBuf { self.data.join("steamvr-changes.json") }
    fn receipt(&self) -> PathBuf { self.data.join("installation.json") }
    fn registrations(&self) -> Result<Vec<PathBuf>> {
        let paths = read_json(&self.paths_file)?;
        match paths.get("external_drivers") {
            None | Some(Value::Null) => Ok(vec![]),
            Some(Value::Array(paths)) => paths.iter().map(|p| p.as_str().map(PathBuf::from).ok_or("Invalid external driver path".into())).collect(),
            _ => Err("Invalid external_drivers in openvrpaths.vrpath".into()),
        }
    }
    fn receipt_value(&self) -> Result<Option<Value>> {
        if !self.receipt().exists() { return Ok(None); }
        let v = read_json(&self.receipt())?;
        if ![json!(1),json!(2)].contains(&v["schema"]) || v["driver"] != DRIVER || !v["packages"].is_array() { return Err("Invalid Galaxy XR installation receipt; preserve for recovery".into()); }
        if !v["packages"].as_array().unwrap().iter().all(Value::is_string) {return Err("Invalid installation package path".into());}
        if v["schema"] == 2 && !v["sourcePaths"].as_array().map(|a|a.iter().all(Value::is_string)).unwrap_or(false) { return Err("Invalid installation source paths".into()); }
        if let Some(pending)=v.get("cleanupPending") {
            if !pending.as_array().map(|a|a.iter().all(|p|p.is_string() && v["packages"].as_array().unwrap().contains(p))).unwrap_or(false) {return Err("Invalid pending cleanup receipt".into());}
        }
        Ok(Some(v))
    }
}
fn is_steamvr_process(name: &std::ffi::OsStr) -> bool {
    ["vrserver.exe", "vrmonitor.exe", "vrcompositor.exe", "vrserver", "vrmonitor", "vrcompositor"]
        .iter().any(|p| name.eq_ignore_ascii_case(p))
}
fn require_stopped() -> Result<()> {
    let mut system = System::new_all();
    system.refresh_processes(ProcessesToUpdate::All, false);
    for process in system.processes().values() {
        if is_steamvr_process(process.name()) {
            return Err("Close SteamVR completely before changing driver installation or SteamVR settings".into());
        }
    }
    Ok(())
}
fn load_journal(ctx: &Context) -> Result<Value> {
    if !ctx.journal().exists() {
        // A GUI setting action may happen before the first upgraded install.
        // Match the native journal's legacy baseline detection, and include
        // positively identified installed/registered packages. An unpacked
        // package selected for a future install is not part of this inventory.
        let raw=read_settings(&ctx.settings)?;
        let legacy=ctx.data.join("info.json").exists()
            || raw["driver_GalaxyXRNative"].get("hasBeenRun").is_some()
            || !candidate_packages(ctx,None)?.is_empty();
        return Ok(json!({"schema":1,"driver":DRIVER,"settingsPath":ctx.settings,"legacy":legacy,"sectionPresence":{},"entries":{}}));
    }
    validate_journal(ctx, read_json(&ctx.journal())?)
}

fn validate_journal(ctx: &Context, journal: Value) -> Result<Value> {
    if journal["schema"] != 1 || journal["driver"] != DRIVER || !journal["entries"].is_object() || !journal["settingsPath"].as_str().map(|p| same_path(Path::new(p), &ctx.settings)).unwrap_or(false) {
        return Err("Invalid or different SteamVR settings journal; preserve for recovery".into());
    }
    if let Some(presence) = journal.get("sectionPresence") {
        if !presence.as_object().map(|s| s.values().all(Value::is_boolean)).unwrap_or(false) { return Err("Invalid journal section presence".into()); }
    }
    if journal.get("legacy").map(|v|!v.is_boolean()).unwrap_or(false) {return Err("Invalid journal legacy marker".into());}
    if let Some(keys)=journal.get("legacyKeys") {
        if !keys.as_object().map(|sections|sections.values().all(|s|s.as_object().map(|keys|keys.values().all(Value::is_boolean)).unwrap_or(false))).unwrap_or(false) {return Err("Invalid legacy setting snapshot".into());}
    }
    for section in journal["entries"].as_object().unwrap().values() {
        for entry in section.as_object().ok_or("Invalid journal section")?.values() {
            for (present, value) in [("present", "value"), ("lastPresent", "lastValue")] {
                let has = entry[present].as_bool().ok_or("Invalid journal presence marker")?;
                if has && entry.get(value).is_none() { return Err("Missing journal setting value".into()); }
            }
        }
    }
    Ok(journal)
}

#[tauri::command]
pub fn clean_legacy_galaxyxr_identity(steamvr_path: String) -> Result<IdentityCleanupReport> {
    let _lock = platform::Lock::acquire()?;
    require_stopped()?;
    clean_identity(&Context::live(steamvr_path)?)
}

fn clean_identity(ctx: &Context) -> Result<IdentityCleanupReport> {
    safe_chain(&ctx.settings)?;
    safe_chain(&ctx.journal())?;
    let mut report = IdentityCleanupReport { removed_keys: vec![], removed_sections: vec![], warnings: vec![], backup_path: None };
    // Never initialize a journal or recreate driver data after uninstall.
    let journal = if ctx.journal().exists() { Some(load_journal(ctx)?) } else { None };
    let original = match fs::read(&ctx.settings) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(report),
        Err(e) => return Err(error(&ctx.settings, e)),
    };
    let mut settings = parse_json_bytes(&ctx.settings, &original)?;
    plan_identity_cleanup(&mut settings, journal.as_ref(), &mut report)?;
    if report.removed_keys.is_empty() && report.removed_sections.is_empty() { return Ok(report); }
    let bytes = serde_json::to_vec_pretty(&settings).map_err(|e|e.to_string())?;
    let parent = ctx.settings.parent().ok_or("Settings file has no parent")?;
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e|e.to_string())?.as_nanos();
    let backup = parent.join(format!("steamvr.vrsettings.galaxyxr-identity-backup-{}-{stamp}.json", std::process::id()));
    safe_chain(&backup)?;
    let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&backup).map_err(|e|error(&backup,e))?;
    file.write_all(&original).and_then(|_|file.sync_all()).map_err(|e|error(&backup,e))?;
    drop(file);
    // Refuse to overwrite another writer that ignored the shared mutex.
    if fs::read(&ctx.settings).map_err(|e|error(&ctx.settings,e))? != original {
        return Err(format!("SteamVR settings changed during cleanup; retry. Original backup: {}", backup.display()));
    }
    atomic_bytes(&ctx.settings, &bytes).map_err(|e|format!("{e}. Original backup: {}",backup.display()))?;
    report.backup_path = Some(backup.to_string_lossy().into_owned());
    Ok(report)
}
fn plan_identity_cleanup(settings: &mut Value, journal: Option<&Value>, report: &mut IdentityCleanupReport) -> Result<()> {
    let root = settings.as_object_mut().ok_or("SteamVR settings must be a JSON object")?;
    for name in COMPANION_PROFILE_SECTIONS {
        let Some(value) = root.get_mut(name) else { continue };
        let section = value.as_object_mut().ok_or_else(||format!("SteamVR section {name} must be a JSON object"))?;
        let strong_identity = section.get("manufacturerName") == Some(&json!("Samsung"))
            && section.get("modelNumber") == Some(&json!("Galaxy XR"))
            && section.get("serialNumber") == Some(&json!("VRLINKHMDGALAXYXR"));
        let fingerprint = strong_identity || section.get("resourceRoot") == Some(&json!(DRIVER))
            || section.get("inputProfilePath") == Some(&json!("{GalaxyXRNative}/input/galaxy_xr_hmd_profile.json"));
        if fingerprint {
            let expected = json!({
                "controllerType":"galaxy_xr_hmd", "deviceType":"androidxr/VRLINKHMDGALAXYXR",
                "enable":true, "hasEyeTracking":true,
                "inputProfilePath":"{GalaxyXRNative}/input/galaxy_xr_hmd_profile.json",
                "manufacturerName":"Samsung", "modelNumber":"Galaxy XR", "renderModelName":"generic_hmd",
                "resourceRoot":"GalaxyXRNative", "serialNumber":"VRLINKHMDGALAXYXR",
                "supportsEyeTracking":true, "trackingSystemName":"androidxr"
            });
            for (key, expected_value) in expected.as_object().unwrap() {
                let Some(current) = section.get(key) else { continue };
                let earlier_resource = strong_identity && match key.as_str() {
                    "resourceRoot" => [json!("galaxyxrresources"), json!(LEGACY)].contains(current),
                    "inputProfilePath" => [json!("{galaxyxrresources}/input/galaxy_xr_hmd_profile.json"), json!("{CustomHeadsetOpenVR}/input/galaxy_xr_hmd_profile.json")].contains(current),
                    _ => false,
                };
                if current != expected_value && !earlier_resource { continue; }
                let tracked = journal.as_ref().map(|j| j["entries"][name].get(key).is_some()
                    || j["legacyKeys"][name].get(key).is_some()).unwrap_or(false);
                if tracked {
                    report.warnings.push(format!("Preserved {name}.{key}: tracked by the current installation journal; uninstall the driver first."));
                } else {
                    section.remove(key);
                    report.removed_keys.push(format!("{name}.{key}"));
                }
            }
        }
        if section.is_empty() {
            // An active journal may need to restore this section's original presence.
            let tracked = journal.as_ref().map(|j| j["sectionPresence"].get(name).is_some()
                || j["entries"].get(name).is_some() || j["legacyKeys"].get(name).is_some()).unwrap_or(false);
            if tracked { report.warnings.push(format!("Preserved empty {name}: tracked by the current installation journal.")); }
            else { root.remove(name); report.removed_sections.push(name.into()); }
        }
    }
    Ok(())
}

fn set_value(settings: &mut Value, section: &str, key: &str, value: Option<Value>) -> Result<()> {
    let root = settings.as_object_mut().ok_or("Settings must be an object")?;
    if let Some(value) = value {
        let sec = root.entry(section).or_insert_with(|| json!({})).as_object_mut().ok_or("Settings section is not an object")?;
        sec.insert(key.to_owned(), value);
    } else if let Some(sec) = root.get_mut(section) {
        let sec = sec.as_object_mut().ok_or("Settings section is not an object")?;
        sec.remove(key);
        if sec.is_empty() { root.remove(section); }
    }
    Ok(())
}
fn apply_changes(ctx: &Context, changes: Vec<SettingChange>) -> Result<()> {
    let mut settings = read_settings(&ctx.settings)?;
    let original_settings = settings.clone();
    let previous_journal = if ctx.journal().exists() { Some(fs::read(ctx.journal()).map_err(|e| e.to_string())?) } else { None };
    let mut journal = load_journal(ctx)?;
    if journal.get("sectionPresence").is_none() { journal["sectionPresence"] = json!({}); }
    for change in changes {
        if change.section.is_empty() || change.key.is_empty() { return Err("Empty SteamVR setting name".into()); }
        let old = settings.get(&change.section).and_then(|s| s.get(&change.key)).cloned();
        let new = change.present.then_some(change.value);
        if old == new { continue; }
        journal["sectionPresence"].as_object_mut().ok_or("Invalid section presence")?.entry(change.section.clone()).or_insert_with(|| json!(original_settings.get(&change.section).is_some()));
        let entries = journal["entries"].as_object_mut().unwrap();
        let section = entries.entry(change.section.clone()).or_insert_with(|| json!({})).as_object_mut().ok_or("Invalid journal section")?;
        let entry = section.entry(change.key.clone()).or_insert_with(|| {
            let mut value = json!({"present":old.is_some()});
            if let Some(old) = &old { value["value"] = old.clone(); } value
        });
        entry["lastPresent"] = json!(new.is_some());
        entry.as_object_mut().ok_or("Invalid journal entry")?.remove("lastValue");
        if let Some(value) = &new { entry["lastValue"] = value.clone(); }
        set_value(&mut settings, &change.section, &change.key, new)?;
    }
    // Durable rollback data must reach disk before settings do.
    atomic_json(&ctx.journal(), &journal)?;
    if let Err(e) = atomic_json(&ctx.settings, &settings) {
        let rollback = if let Some(bytes) = previous_journal { atomic_bytes(&ctx.journal(), &bytes) } else { fs::remove_file(ctx.journal()).map_err(|e| e.to_string()) };
        return Err(match rollback { Ok(()) => e, Err(r) => format!("{e}; journal ROLLBACK failed: {r}") });
    }
    Ok(())
}

#[tauri::command]
pub fn update_galaxyxr_steamvr_settings(steamvr_path: String, changes: Vec<SettingChange>) -> Result<()> {
    let _guard = platform::Lock::acquire()?;
    require_stopped()?;
    apply_changes(&Context::live(steamvr_path)?, changes)
}

fn fork_kind(path: &Path) -> Result<Option<bool>> {
    let manifest = path.join("driver.vrdrivermanifest");
    if !manifest.exists() { return Ok(None); }
    safe_chain(&manifest)?;
    let v = read_json(&manifest)?;
    if v["name"] == DRIVER { return Ok(Some(false)); }
    if v["name"] == LEGACY && ["vrlink_layer_ps.hlsl", "vrlink_fxaa_ps.hlsl"].iter().all(|p| path.join("resources/shaders/d3d11").join(p).is_file()) { return Ok(Some(true)); }
    Ok(None)
}
fn validate_package_path(path: &Path, current_exe: &Path) -> Result<PathBuf> {
    if !path.is_absolute() { return Err(error(path, "Driver path must be absolute")); }
    safe_tree(path)?;
    let path = fs::canonicalize(path).map_err(|e| error(path, e))?;
    if path.parent().and_then(Path::parent).is_none() { return Err(error(&path, "Refusing filesystem root")); }
    for parent in current_exe.ancestors() {
        if same_path(&path, parent) { return Err(error(&path, "Driver directory contains the running GUI")); }
    }
    if [".git", "src", "GalaxyXRDriverGUI", "GalaxyXRDriver", "CustomHeadsetGUI", "CustomHeadsetOpenVR", "Cargo.toml", "CMakeLists.txt"].iter().any(|p| path.join(p).exists()) {
        return Err(error(&path, "Refusing source/workspace directory"));
    }
    Ok(path)
}
fn validate_package(path: &Path, current_exe: &Path) -> Result<PathBuf> {
    let path = validate_package_path(path, current_exe)?;
    if fork_kind(&path)?.is_none() { return Err(error(&path, "Not a Galaxy XR driver package")); }
    let dll = if fork_kind(&path)? == Some(true) { "driver_CustomHeadsetOpenVR.dll" } else { "driver_GalaxyXRNative.dll" };
    if !path.join("bin/win64").join(dll).is_file() { return Err(error(&path, "Runnable driver DLL missing; refusing source template")); }
    Ok(path)
}
fn run_registration(ctx: &Context, path: &Path, add: bool) -> Result<()> {
    let mut command = Command::new(ctx.steamvr.join("bin/win64/vrpathreg.exe"));
    platform::hidden(&mut command);
    let output = command.arg(if add { "adddriver" } else { "removedriver" }).arg(path).output().map_err(|e| e.to_string())?;
    if !output.status.success() { return Err(format!("vrpathreg {} failed for {} (exit {:?})", if add { "adddriver" } else { "removedriver" }, path.display(), output.status.code())); }
    let registered = ctx.registrations()?.iter().any(|p| same_path(p, path));
    if registered != add { return Err(error(path, "vrpathreg verification failed")); }
    Ok(())
}
fn candidate_packages(ctx: &Context, receipt: Option<&Value>) -> Result<Vec<PathBuf>> {
    let mut paths = ctx.registrations()?;
    paths.extend([ctx.steamvr.join("drivers").join(DRIVER), ctx.steamvr.join("drivers").join(LEGACY)]);
    if let Some(receipt) = receipt { for path in receipt["packages"].as_array().unwrap() { paths.push(PathBuf::from(path.as_str().ok_or("Invalid package receipt path")?)); } }
    let mut seen = BTreeSet::new();
    let mut owned = vec![];
    for path in paths {
        if !seen.insert(normalized(&path)) { continue; }
        if path.exists() && (fork_kind(&path)?.is_some() || cleanup_pending(receipt, &path)) { owned.push(path); }
        else if owned_package(ctx,receipt,&path) && path.exists() {
            return Err(error(&path, "Recorded package identity changed; refusing deletion"));
        }
    }
    Ok(owned)
}
fn receipt_paths(receipt: Option<&Value>, key: &str) -> Vec<PathBuf> {
    receipt.and_then(|r|r[key].as_array()).into_iter().flatten().filter_map(Value::as_str).map(PathBuf::from).collect()
}
fn contains_path(paths: &[PathBuf], path: &Path) -> bool { paths.iter().any(|p|same_path(p,path)) }
fn push_path(paths: &mut Vec<PathBuf>, path: PathBuf) { if !contains_path(paths,&path) { paths.push(path); } }
fn contains_directory(parent:&Path,path:&Path)->bool {
    let parent=normalized(parent); let path=normalized(path);
    path==parent || path.starts_with(&(parent+"\\"))
}
fn validate_source_boundaries(ctx:&Context,source:&Path)->Result<()> {
    // Config is removed during uninstall; an unpacked bundle must never live
    // inside it (or contain it). Copy destinations also cannot be inside source.
    if contains_directory(&ctx.data,source) || contains_directory(source,&ctx.data) {
        return Err(error(source,"Bundle overlaps the driver configuration directory. Move the bundle outside that directory before installing or uninstalling."));
    }
    if contains_directory(source,&ctx.managed) {
        return Err(error(source,"Bundle contains the managed installation directory. Move the bundle outside that directory."));
    }
    Ok(())
}
fn legacy_install_location(ctx: &Context, path: &Path) -> bool {
    let leaf=path.file_name().and_then(|n|n.to_str()).unwrap_or("");
    let driver_leaf=[DRIVER,LEGACY].iter().any(|n|leaf.eq_ignore_ascii_case(n));
    let drivers=ctx.steamvr.join("drivers");
    let retired=ctx.steamvr.join(".galaxyxr-retired");
    let direct=path.parent().map(|p|same_path(p,&drivers)).unwrap_or(false);
    let retirement=path.parent().and_then(Path::parent).map(|p|same_path(p,&retired)).unwrap_or(false);
    (driver_leaf || leaf.starts_with(".galaxyxr-uninstall-")) && (direct || retirement)
}
fn managed_location(ctx: &Context, path: &Path) -> bool {
    path.parent().map(|p|same_path(p,&ctx.managed)).unwrap_or(false)
        && path.file_name().and_then(|n|n.to_str()).map(|n|n.starts_with("GalaxyXRNative-") || n.starts_with(".galaxyxr-uninstall-")).unwrap_or(false)
}
fn owned_package(ctx: &Context, receipt: Option<&Value>, path: &Path) -> bool {
    // A registered manifest establishes identity, never ownership of files.
    // v1 registered the user's bundle in place; those paths are source-only.
    if contains_path(&receipt_paths(receipt,"sourcePaths"),path) { return false; }
    legacy_install_location(ctx,path)
        || (receipt.map(|r|r["schema"]==2).unwrap_or(false)
            && managed_location(ctx,path) && contains_path(&receipt_paths(receipt,"packages"),path))
}
fn source_paths(ctx: &Context, receipt: Option<&Value>, candidates: &[PathBuf]) -> Vec<PathBuf> {
    let mut sources=receipt_paths(receipt,"sourcePaths");
    for path in candidates.iter().cloned().chain(receipt_paths(receipt,"packages")) {
        if !owned_package(ctx,receipt,&path) { push_path(&mut sources,path); }
    }
    sources
}
fn copy_package(source: &Path, target: &Path) -> Result<()> {
    safe_tree(source)?;
    safe_chain(target)?;
    if contains_directory(source, target) {
        return Err(error(target, "Copy destination overlaps the source package"));
    }
    if target.exists() { return Err(error(target,"Install destination already exists")); }
    fs::create_dir_all(target).map_err(|e|error(target,e))?;
    fn copy_contents(source:&Path,target:&Path)->Result<()> {
        for entry in fs::read_dir(source).map_err(|e|error(source,e))? {
            let entry=entry.map_err(|e|e.to_string())?;
            let from=entry.path(); let to=target.join(entry.file_name());
            let metadata=fs::symlink_metadata(&from).map_err(|e|error(&from,e))?;
            if platform::reparse(&metadata) || metadata.file_type().is_symlink() { return Err(error(&from,"Refusing reparse point / symbolic link")); }
            if metadata.is_dir() { fs::create_dir(&to).map_err(|e|error(&to,e))?; copy_contents(&from,&to)?; }
            else if metadata.is_file() { fs::copy(&from,&to).map_err(|e|error(&to,e))?; }
            else { return Err(error(&from,"Unsupported package entry")); }
        }
        Ok(())
    }
    copy_contents(source,target)
}
fn cleanup_pending(receipt: Option<&Value>, path: &Path) -> bool {
    receipt.and_then(|r| r["cleanupPending"].as_array()).map(|a| a.iter().any(|p| p.as_str().map(|p| same_path(Path::new(p), path)).unwrap_or(false))).unwrap_or(false)
}

fn snapshot_file(path:&Path)->Result<Option<Vec<u8>>> {
    if path.exists() { fs::read(path).map(Some).map_err(|e|error(path,e)) } else { Ok(None) }
}
fn restore_file(path:&Path,bytes:&Option<Vec<u8>>)->Result<()> {
    if let Some(bytes)=bytes { atomic_bytes(path,bytes) }
    else if path.exists() { fs::remove_file(path).map_err(|e|error(path,e)) } else { Ok(()) }
}
fn enable_native_identity(config:&mut Value)->Result<()> {
    let root=config.as_object_mut().ok_or("Driver settings must be an object")?;
    let galaxy=root.entry("galaxyXr").or_insert_with(||json!({})).as_object_mut().ok_or("galaxyXr settings must be an object")?;
    galaxy.insert("nativeIdentity".into(),json!(true));
    Ok(())
}

#[tauri::command]
pub fn register_galaxyxr_driver(steamvr_path: String, driver_path: String) -> Result<InstallReport> {
    let _guard = platform::Lock::acquire()?;
    require_stopped()?;
    let ctx = Context::live(steamvr_path)?;
    install_driver(&ctx,Path::new(&driver_path),&std::env::current_exe().map_err(|e|e.to_string())?,|path,add|run_registration(&ctx,path,add))
}
fn install_driver(ctx:&Context,source:&Path,exe:&Path,mut register:impl FnMut(&Path,bool)->Result<()>)->Result<InstallReport> {
    let source=validate_package(source,exe)?;
    validate_source_boundaries(ctx,&source)?;
    if fork_kind(&source)? != Some(false) { return Err("Install the GalaxyXRNative package, not the legacy fork".into()); }
    let receipt=ctx.receipt_value()?;
    if !receipt_paths(receipt.as_ref(),"cleanupPending").is_empty() {
        return Err("Previous uninstall cleanup is incomplete. Run Uninstall again before installing.".into());
    }
    let previous=candidate_packages(ctx,receipt.as_ref())?;
    let mut sources=source_paths(ctx,receipt.as_ref(),&previous);
    push_path(&mut sources,source.clone());
    for source in &sources { if source.exists() {validate_source_boundaries(ctx,source)?;} }
    let mut packages:Vec<PathBuf>=previous.iter().filter(|p|owned_package(ctx,receipt.as_ref(),p) && !contains_path(&sources,p)).cloned().collect();
    for p in receipt_paths(receipt.as_ref(),"packages") {
        if owned_package(ctx,receipt.as_ref(),&p) && !contains_path(&sources,&p) { push_path(&mut packages,p); }
    }
    let mut journal=load_journal(ctx)?;
    let legacy=receipt.as_ref().and_then(|r|r["legacyDetected"].as_bool()).unwrap_or(false)
        || (!ctx.journal().exists() && !previous.is_empty()) || journal["legacy"].as_bool().unwrap_or(false);
    journal["legacy"]=json!(legacy);
    let config_path=ctx.data.join("settings.json");
    let mut config=read_settings(&config_path)?;
    if legacy && journal.get("legacyKeys").is_none() {
        record_legacy_keys(&mut journal,&read_settings(&ctx.settings)?,&config,previous.iter().any(|p|fork_kind(p).ok().flatten()==Some(true)))?;
    }
    enable_native_identity(&mut config)?;
    let snapshots=[ctx.settings.clone(),ctx.journal(),config_path.clone(),ctx.receipt()].into_iter()
        .map(|path|snapshot_file(&path).map(|bytes|(path,bytes))).collect::<Result<Vec<_>>>()?;
    let stamp=SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e|e.to_string())?.as_nanos();
    let path=ctx.managed.join(format!("GalaxyXRNative-{stamp}"));
    let staging=ctx.managed.join(format!("GalaxyXRNative-{stamp}.stage"));
    safe_chain(&path)?; safe_chain(&staging)?;
    if path.exists() || staging.exists() { return Err("Installation destination already exists".into()); }
    let mut retirements=vec![];
    for old in &packages {
        if old.exists() && old.parent().map(|p|same_path(p,&ctx.steamvr.join("drivers"))).unwrap_or(false) {
            validate_package(old,exe)?;
            let retired=ctx.steamvr.join(".galaxyxr-retired").join(stamp.to_string()).join(old.file_name().ok_or("Invalid copied driver path")?);
            safe_chain(&retired)?;
            retirements.push((old.clone(),retired));
        }
    }
    packages.extend(retirements.iter().map(|(_,retired)|retired.clone()));
    push_path(&mut packages,path.clone());
    let registered_before=ctx.registrations()?;
    let mut registration_paths=previous;
    for p in receipt_paths(receipt.as_ref(),"packages").into_iter().chain(sources.iter().cloned()) { push_path(&mut registration_paths,p); }
    let mut moved=vec![]; let mut removed=vec![]; let mut registration_attempted=false;
    let mut attempt_packages=packages.clone(); attempt_packages.push(staging.clone());
    let attempt_receipt=json!({"schema":2,"driver":DRIVER,"packages":attempt_packages,"sourcePaths":sources,"legacyDetected":legacy,"retirements":retirements,"cleanupPending":[path,staging]});
    // Write ownership before copying; interrupted copies remain safely recoverable.
    atomic_json(&ctx.receipt(),&attempt_receipt)?;
    let install=(|| {
        atomic_json(&ctx.journal(),&journal)?;
        copy_package(&source,&staging)?;
        validate_package(&staging,exe)?;
        fs::rename(&staging,&path).map_err(|e|error(&path,e))?;
        for (original,retired) in &retirements {
            fs::create_dir_all(retired.parent().unwrap()).map_err(|e|error(retired,e))?;
            fs::rename(original,retired).map_err(|e|error(original,e))?;
            moved.push((original.clone(),retired.clone()));
        }
        registration_attempted=true;
        register(&path,true)?;
        for old in registration_paths.iter().filter(|p|!same_path(p,&path) && contains_path(&registered_before,p)) {
            removed.push(old.clone()); register(old,false)?;
        }
        atomic_json(&config_path,&config)?;
        apply_changes(ctx,vec![
            SettingChange { section:"driver_GalaxyXRNative".into(),key:"enable".into(),present:true,value:json!(true) },
            SettingChange { section:"driver_GalaxyXRNative".into(),key:"blocked_by_safe_mode".into(),present:false,value:Value::Null },
        ])?;
        atomic_json(&ctx.receipt(),&json!({"schema":2,"driver":DRIVER,"packages":packages,"sourcePaths":sources,"legacyDetected":legacy,"retirements":retirements}))
    })();
    if let Err(e)=install {
        let mut errors=vec![e];
        errors.extend(rollback_staged(&moved));
        for old in &removed { if let Err(e)=register(old,true) { errors.push(format!("ROLLBACK {e}")); } }
        if registration_attempted { if let Err(e)=register(&path,false) { errors.push(format!("ROLLBACK {e}")); } }
        // Restore settings/config even if files or registration need later recovery.
        for (file,bytes) in snapshots.iter().filter(|(file,_)|!same_path(file,&ctx.receipt())) {
            if let Err(e)=restore_file(file,bytes) { errors.push(format!("ROLLBACK {e}")); }
        }
        for created in [&path,&staging] {
            if created.exists() {
                if let Err(e)=safe_tree(created).and_then(|_|fs::remove_dir_all(created).map_err(|e|error(created,e))) { errors.push(format!("ROLLBACK {e}")); }
            }
        }
        if errors.len()==1 {
            let (_,bytes)=snapshots.last().unwrap();
            if let Err(e)=restore_file(&ctx.receipt(),bytes) { errors.push(format!("ROLLBACK receipt: {e}")); }
        }
        cleanup_retirement_parents(ctx,&packages,&mut errors);
        return Err(errors.join("; "));
    }
    Ok(InstallReport { registered_path:path.to_string_lossy().into_owned(),legacy_detected:legacy })
}

fn cleanup_retirement_parents(ctx:&Context,packages:&[PathBuf],warnings:&mut Vec<String>) {
    let root=ctx.steamvr.join(".galaxyxr-retired");
    let mut parents=BTreeSet::new();
    for path in packages {
        if let Some(parent)=path.parent() {
            if parent.parent().map(|p|same_path(p,&root)).unwrap_or(false) { parents.insert(parent.to_path_buf()); }
        }
    }
    for parent in parents {
        if parent.exists() {
            if let Err(e)=safe_chain(&parent).and_then(|_| fs::remove_dir(&parent).map_err(|e|error(&parent,e))) { warnings.push(format!("Retirement directory retained: {e}")); }
        }
    }
    if root.exists() && fs::read_dir(&root).map(|mut d|d.next().is_none()).unwrap_or(false) {
        if let Err(e)=safe_chain(&root).and_then(|_|fs::remove_dir(&root).map_err(|e|error(&root,e))) { warnings.push(format!("Retirement directory retained: {e}")); }
    }
}

fn restore_settings(settings: &mut Value, journal: &Value, warnings: &mut Vec<String>) -> Result<usize> {
    let mut count = 0;
    for (section, entries) in journal["entries"].as_object().ok_or("Invalid journal entries")? {
        for (key, entry) in entries.as_object().ok_or("Invalid journal section")? {
            let current = settings.get(section).and_then(|s| s.get(key)).cloned();
            let last = entry["lastPresent"].as_bool().ok_or("Invalid journal entry")?.then(|| entry["lastValue"].clone());
            let baseline = entry["present"].as_bool().ok_or("Invalid journal entry")?.then(|| entry["value"].clone());
            let legacy_key=journal["legacyKeys"][section][key]==true;
            let original = if legacy_key { None } else { baseline.clone() };
            if setting_equal(current.as_ref(),original.as_ref()) { continue; }
            if !setting_equal(current.as_ref(),last.as_ref()) && !(legacy_key && setting_equal(current.as_ref(),baseline.as_ref())) { warnings.push(format!("Preserved later external change to {section}.{key}")); continue; }
            set_value(settings, section, key, original)?;
            count += 1;
        }
        if journal["sectionPresence"][section] == true && settings.get(section).is_none() { settings[section] = json!({}); }
    }
    Ok(count)
}

fn setting_equal(a:Option<&Value>,b:Option<&Value>) -> bool {
    match (a,b) {
        (Some(a),Some(b)) if a.is_number() && b.is_number() => {
            if a==b || a.as_f64()==b.as_f64() {return true;}
            // OpenVR float settings persist float32; JSON may spell the same
            // exact float with either double digits or its shortest decimal.
            if a.is_f64() && b.is_f64() {
                let (a,b)=(a.as_f64().unwrap(),b.as_f64().unwrap());
                return a.is_finite() && b.is_finite() && (a as f32).to_bits()==(b as f32).to_bits();
            }
            false
        }
        _=>a==b,
    }
}

fn record_legacy_keys(journal:&mut Value,current:&Value,config:&Value,legacy_fork:bool)->Result<()> {
    let mut baseline=current.clone();
    for(section,entries)in journal["entries"].as_object().ok_or("Invalid journal")? {
        for(key,entry)in entries.as_object().ok_or("Invalid journal section")? {
            let value=entry["present"].as_bool().ok_or("Invalid journal presence")?.then(||entry["value"].clone());
            set_value(&mut baseline,section,key,value)?;
        }
    }
    let mut reset=baseline.clone();let empty=json!({"entries":{}});
    legacy_reset(&mut reset,&empty)?;legacy_config_reset(&mut reset,&empty,config,legacy_fork,&mut vec![])?;
    let mut keys=json!({});
    for(section,values)in baseline.as_object().unwrap() {
        if let Some(values)=values.as_object() {
            for key in values.keys() {
                if reset.get(section).and_then(|s|s.get(key)).is_none() {keys[section][key]=json!(true);}
            }
        }
    }
    journal["legacyKeys"]=keys;
    Ok(())
}

fn legacy_reset(settings: &mut Value, journal: &Value) -> Result<usize> {
    let mut count = 0;
    let sections: Vec<String> = settings.as_object().ok_or("Invalid settings")?.keys().cloned().collect();
    for section in sections {
        let keys: Vec<String> = settings[&section].as_object().map(|s| s.keys().cloned().collect()).unwrap_or_default();
        for key in keys {
            if journal["entries"].get(&section).and_then(|s| s.get(&key)).is_some() { continue; }
            let owned = section == "driver_GalaxyXRNative" ||
                (section == "driver_vrlink" && ["encodeWidth", "streamFormatWidth", "automaticStreamFormatWidth", "automaticBandwidth", "recommendedBandwidthMbit", "targetBandwidth", "renderWidth", "renderHeight", "overrideRenderWidth", "overrideRenderHeight", "displayFrequency", "force10bit", "debugRegionColoring", "showAdvancedGraphs", "maxVideoQueueLatencyUs", "backoffRecoveryCoefficient"].contains(&key.as_str())) ||
                (section == "steamvr" && key == "preferredRefreshRate" && settings[&section][&key] == 90) ||
                (["vrlink_xrvst2", "vrlink_xrvst2ue", "vrlink_Galaxy XR"].contains(&section.as_str()) && ["recommendedRenderWidth", "recommendedRenderHeight", "supports10bit", "minStreamFormatWidth", "maxStreamFormatWidth", "minNonFoveatedStreamFormatWidth", "maxNonFoveatedStreamFormatWidth"].contains(&key.as_str()));
            if owned { set_value(settings, &section, &key, None)?; count += 1; }
        }
    }
    Ok(count)
}

fn legacy_config_reset(settings:&mut Value,journal:&Value,config:&Value,legacy_fork:bool,warnings:&mut Vec<String>) -> Result<usize> {
    let mut count=0;
    if let Some(extra)=config["galaxyXr"]["vrlinkExtraKeys"].as_object() {
        // 2026-09-26: older installs mirrored encoder extras to each profile.
        // Restore/remove them with the same exact-value ownership rule.
        for section in std::iter::once("driver_vrlink").chain(COMPANION_PROFILE_SECTIONS.iter().copied()) {
        for (key,raw) in extra {
            if journal["entries"][section].get(key).is_some() { continue; }
            let expected=if raw.is_boolean() || raw.is_number() { Some(raw.clone()) }
                else if let Some(value)=raw.get("i").and_then(Value::as_i64) { Some(json!(value)) }
                else if let Some(value)=raw.get("f").and_then(Value::as_f64) { Some(json!(value as f32)) }
                else { raw.get("b").and_then(Value::as_bool).map(|v|json!(v)) };
            let current=settings[section].get(key);
            if let Some(expected)=expected {
                let matches=setting_equal(current,Some(&expected));
                if matches { set_value(settings,section,key,None)?;count+=1; }
                else if current.is_some() { warnings.push(format!("Preserved differing legacy custom setting {section}.{key}")); }
            } else if current.is_some() { warnings.push(format!("Preserved ambiguous legacy custom setting {section}.{key}")); }
        }
        }
    }
    // Older fork installs disabled their old neutral driver section. Only
    // remove a matching false marker when a fork package was fingerprinted.
    if legacy_fork && settings["driver_CustomHeadsetOpenVR"]["enable"]==false && journal["entries"]["driver_CustomHeadsetOpenVR"].get("enable").is_none() {
        set_value(settings,"driver_CustomHeadsetOpenVR","enable",None)?;count+=1;
    }
    Ok(count)
}

fn rollback_staged(staged: &[(PathBuf, PathBuf)]) -> Vec<String> {
    let mut errors = vec![];
    for (original, tombstone) in staged.iter().rev() {
        if tombstone.exists() { if let Err(e) = fs::rename(tombstone, original) { errors.push(format!("ROLLBACK {}: {e}; files retained at {}", original.display(), tombstone.display())); } }
    }
    errors
}

fn prepare_uninstall_receipt(ctx:&Context,packages:&[PathBuf],legacy:bool)->Result<(Vec<(PathBuf,PathBuf)>,Value)> {
    let stamp=SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e|e.to_string())?.as_nanos();
    let mut planned=vec![];
    let mut recovery_paths=packages.to_vec();
    let previous=ctx.receipt_value()?;
    let candidates=candidate_packages(ctx,previous.as_ref())?;
    let sources=source_paths(ctx,previous.as_ref(),&candidates);
    for path in receipt_paths(previous.as_ref(),"packages") { if owned_package(ctx,previous.as_ref(),&path) {push_path(&mut recovery_paths,path);} }
    for(index,path)in packages.iter().enumerate() {
        let tombstone=path.parent().ok_or("Driver has no parent")?.join(format!(".galaxyxr-uninstall-{stamp}-{index}"));
        safe_chain(&tombstone)?;
        match fs::symlink_metadata(&tombstone) {
            Err(e) if e.kind()==std::io::ErrorKind::NotFound=>(),
            _=>return Err(error(&tombstone,"Uninstall staging destination already exists or is unreadable")),
        }
        recovery_paths.push(tombstone.clone());planned.push((path.clone(),tombstone));
    }
    let recovery=json!({"schema":2,"driver":DRIVER,"packages":recovery_paths,"sourcePaths":sources,"legacyDetected":legacy,"cleanupPending":recovery_paths,"staged":planned});
    // Write ahead of registration, rename, and settings operations. Even a
    // pre-commit rollback failure or process interruption remains discoverable.
    atomic_json(&ctx.receipt(),&recovery)?;
    Ok((planned,recovery))
}

#[tauri::command]
pub fn uninstall_galaxyxr_driver(steamvr_path: String) -> Result<UninstallReport> {
    let _guard = platform::Lock::acquire()?;
    require_stopped()?;
    let ctx = Context::live(steamvr_path)?;
    uninstall_driver(&ctx,&std::env::current_exe().map_err(|e|e.to_string())?,|path,add|run_registration(&ctx,path,add))
}
fn uninstall_driver(ctx:&Context,exe:&Path,mut register:impl FnMut(&Path,bool)->Result<()>)->Result<UninstallReport> {
    let receipt = ctx.receipt_value()?;
    let journal_existed = ctx.journal().exists();
    let mut journal = load_journal(&ctx)?; // Corruption never becomes legacy cleanup.
    let candidates = candidate_packages(&ctx, receipt.as_ref())?;
    let sources=source_paths(ctx,receipt.as_ref(),&candidates);
    for source in &sources { if source.exists() {validate_source_boundaries(ctx,source)?;} }
    let mut registration_paths=candidates.clone();
    for path in receipt_paths(receipt.as_ref(),"packages").into_iter().chain(sources.iter().cloned()) {push_path(&mut registration_paths,path);}
    let mut packages = vec![];
    for path in candidates.iter().filter(|p|owned_package(ctx,receipt.as_ref(),p)) {
        if cleanup_pending(receipt.as_ref(), &path) {
            // These exact locations were fully validated before a prior
            // committed uninstall partially deleted their contents.
            let checked = validate_package_path(&path, &exe)?;
            if checked.join("driver.vrdrivermanifest").exists() && fork_kind(&checked)?.is_none() { return Err(error(&checked,"Recovery package identity changed")); }
            packages.push(checked);
        } else { packages.push(validate_package(&path, &exe)?); }
    }
    safe_tree(&ctx.data)?;
    let original_settings = read_settings(&ctx.settings)?;
    let mut settings = original_settings.clone();
    let mut warnings = vec![];
    let legacy = journal["legacy"].as_bool().unwrap_or(false) || receipt.as_ref().and_then(|r| r["legacyDetected"].as_bool()).unwrap_or(false) || (!journal_existed && (!candidates.is_empty() || settings.get("driver_GalaxyXRNative").is_some()));
    let legacy_fork=candidates.iter().any(|p|fork_kind(p).ok().flatten()==Some(true));
    let config=if legacy && ctx.data.join("settings.json").exists() {read_json(&ctx.data.join("settings.json"))?}else{json!({})};
    if legacy && journal.get("legacyKeys").is_none() {record_legacy_keys(&mut journal,&settings,&config,legacy_fork)?;}
    let mut restored = restore_settings(&mut settings, &journal, &mut warnings)?;
    if legacy {
        restored += legacy_reset(&mut settings, &journal)?;
        restored += legacy_config_reset(&mut settings,&journal,&config,legacy_fork,&mut warnings)?;
        warnings.push("Legacy installation: removed known Galaxy XR overrides; pre-install values were not recorded and cannot be reconstructed. Unrecognized historical custom overrides are preserved.".into());
    }
    // Owned status markers can be emitted by SteamVR after our last write.
    if let Some(section) = settings.get_mut("driver_GalaxyXRNative").and_then(Value::as_object_mut) {
        for key in ["enable", "blocked_by_safe_mode", "hasBeenRun"] {
            if journal["entries"]["driver_GalaxyXRNative"].get(key).is_none() { section.remove(key); }
        }
        if section.is_empty() && (legacy || journal["sectionPresence"]["driver_GalaxyXRNative"] != true) { settings.as_object_mut().unwrap().remove("driver_GalaxyXRNative"); }
    }
    let registered = ctx.registrations()?;
    let registrations: Vec<PathBuf> = registered.into_iter().filter(|p|contains_path(&registration_paths,p)).collect();
    let mut removed_registrations = vec![];
    let mut staged: Vec<(PathBuf, PathBuf)> = vec![];
    atomic_json(&ctx.journal(),&journal)?;
    let (planned,recovery_receipt)=prepare_uninstall_receipt(&ctx,&packages,legacy)?;
    let transaction = (|| {
        for path in &registrations { removed_registrations.push(path.clone()); register(path, false)?; }
        for (path,tombstone) in &planned {
            fs::rename(path, tombstone).map_err(|e| error(path, e))?;
            staged.push((path.clone(), tombstone.clone()));
        }
        atomic_json(&ctx.settings, &settings)?;
        Ok(())
    })();
    if let Err(e) = transaction {
        let mut errors = vec![e];
        errors.extend(rollback_staged(&staged));
        for path in &removed_registrations { if let Err(e) = register(path, true) { errors.push(format!("ROLLBACK {e}")); } }
        return Err(errors.join("; "));
    }
    // Commit: deletion errors are surfaced, with settings restored and receipt
    // retained. Never report success after a partial filesystem cleanup.
    let mut removed_paths = vec![];
    for (original, tombstone) in &staged {
        if let Err(e) = fs::remove_dir_all(tombstone) {
            let mut errors = vec![format!("Partial uninstall: settings restored, registration removed, but deleting {} failed: {e}. Recovery receipt retained.", tombstone.display())];
            errors.extend(rollback_staged(&staged));
            return Err(errors.join("; "));
        }
        removed_paths.push(original.to_string_lossy().into_owned());
    }
    let mut retirement_paths=packages.clone();
    if let Some(receipt)=&receipt {
        for path in receipt["packages"].as_array().unwrap() { if let Some(path)=path.as_str() { retirement_paths.push(PathBuf::from(path)); } }
    }
    cleanup_retirement_parents(&ctx,&retirement_paths,&mut warnings);
    if ctx.managed.exists() && fs::read_dir(&ctx.managed).map(|mut d|d.next().is_none()).unwrap_or(false) {
        safe_chain(&ctx.managed)?;
        fs::remove_dir(&ctx.managed).map_err(|e|error(&ctx.managed,e))?;
    }
    if ctx.data.exists() {
        // App preferences (gui-settings.json: color scheme, update mode,
        // advanced mode) must survive driver removal (2026-09-22).
        let gui_settings=ctx.data.join("gui-settings.json");
        let gui_bytes=match fs::symlink_metadata(&gui_settings) {
            Ok(meta) if meta.is_file() => Some(fs::read(&gui_settings).map_err(|e| error(&gui_settings, e))?),
            _ => None,
        };
        if let Err(e)=fs::remove_dir_all(&ctx.data) {
            let mut errors=vec![format!("Driver removed and settings restored, but config cleanup failed: {}. Retry uninstall.",error(&ctx.data,e))];
            // Retain original recovery information even if recursive deletion
            // already removed the journal before encountering a locked file.
            if let Err(e)=atomic_json(&ctx.journal(),&journal) { errors.push(format!("Recovery journal save failed: {e}")); }
            if let Err(e)=atomic_json(&ctx.receipt(),&recovery_receipt) { errors.push(format!("Recovery receipt save failed: {e}")); }
            return Err(errors.join("; "));
        }
        if let Some(bytes)=gui_bytes {
            fs::create_dir_all(&ctx.data).map_err(|e|error(&ctx.data,e))?;
            fs::write(&gui_settings,bytes).map_err(|e|error(&gui_settings,e))?;
        }
        removed_paths.push(ctx.data.to_string_lossy().into_owned());
    }
    // Never remove the shared APPDATA/CustomHeadset directory or GalaxyXR parent.
    Ok(UninstallReport { removed_paths, restored_settings: restored, legacy_reset: legacy, warnings })
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture { root: PathBuf, ctx: Context }
    impl Fixture {
        fn new() -> Self {
            let id = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
            let root = std::env::temp_dir().join(format!("galaxyxr-uninstall-test-{}-{id}", std::process::id()));
            fs::create_dir_all(&root).unwrap();
            let ctx = Context { steamvr: root.join("steamvr"), paths_file: root.join("openvrpaths.vrpath"), settings: root.join("config/steamvr.vrsettings"), data: root.join("GalaxyXR/CustomHeadset"), managed:root.join("local/GalaxyXR/Drivers") };
            atomic_json(&ctx.paths_file, &json!({"external_drivers":[]})).unwrap();
            Self { root, ctx }
        }
        fn package(&self, name: &str) -> PathBuf {
            let path = self.root.join(name);
            fs::create_dir_all(path.join("bin/win64")).unwrap();
            fs::write(path.join("bin/win64/driver_GalaxyXRNative.dll"), b"fixture").unwrap();
            atomic_json(&path.join("driver.vrdrivermanifest"), &json!({"name":DRIVER})).unwrap();
            path
        }
    }
    impl Drop for Fixture { fn drop(&mut self) { if self.root.starts_with(std::env::temp_dir()) { let _ = fs::remove_dir_all(&self.root); } } }
    fn change(section: &str, key: &str, value: Option<Value>) -> SettingChange { SettingChange { section:section.into(), key:key.into(), present:value.is_some(), value:value.unwrap_or(Value::Null) } }
    fn fake_registration(ctx:&Context,path:&Path,add:bool)->Result<()> {
        let mut paths=ctx.registrations()?;
        if add {push_path(&mut paths,path.to_path_buf());}else{paths.retain(|p|!same_path(p,path));}
        atomic_json(&ctx.paths_file,&json!({"external_drivers":paths}))
    }
    fn legacy_identity() -> Value {
        json!({"controllerType":"galaxy_xr_hmd","deviceType":"androidxr/VRLINKHMDGALAXYXR",
            "enable":true,"hasEyeTracking":true,"inputProfilePath":"{GalaxyXRNative}/input/galaxy_xr_hmd_profile.json",
            "manufacturerName":"Samsung","modelNumber":"Galaxy XR","renderModelName":"generic_hmd",
            "resourceRoot":"GalaxyXRNative","serialNumber":"VRLINKHMDGALAXYXR","supportsEyeTracking":true,"trackingSystemName":"androidxr"})
    }
    #[test]
    fn json_reader_accepts_utf8_bom_from_legacy_portable_builds() {
        let path = Path::new("driver.vrdrivermanifest");
        let bytes = b"\xEF\xBB\xBF{\"name\":\"GalaxyXRNative\"}";
        assert_eq!(parse_json_bytes(path, bytes).unwrap()["name"], DRIVER);
    }
    #[test]
    fn identity_cleanup_removes_observed_block_and_backs_up_exact_bytes_without_driver_data() {
        let f=Fixture::new();
        let original=format!("// original comments and formatting\n{{\n\"vrlink_xrvst2ue\":{},\"unrelated\":{{\"preference\":42}}\n}}\n",legacy_identity());
        atomic_bytes(&f.ctx.settings,original.as_bytes()).unwrap();
        let paths_before=fs::read(&f.ctx.paths_file).unwrap();
        let report=clean_identity(&f.ctx).unwrap();
        assert_eq!(report.removed_keys.len(),12);assert_eq!(report.removed_sections,vec!["vrlink_xrvst2ue"]);
        assert_eq!(fs::read(report.backup_path.unwrap()).unwrap(),original.as_bytes());
        assert_eq!(read_settings(&f.ctx.settings).unwrap(),json!({"unrelated":{"preference":42}}));
        assert!(!f.ctx.data.exists());assert!(!f.ctx.managed.exists());
        assert_eq!(fs::read(&f.ctx.paths_file).unwrap(),paths_before);
    }
    #[test]
    fn identity_cleanup_preserves_custom_values_and_all_active_profile_keys() {
        let f=Fixture::new();let mut identity=legacy_identity();
        identity["manufacturerName"]=json!("Custom Manufacturer");identity["enable"]=json!(false);identity["custom"]=json!(123);
        let profile=json!({"recommendedRenderWidth":3552,"recommendedRenderHeight":3840,"supports10bit":true,
            "minStreamFormatWidth":1920,"maxStreamFormatWidth":4096,"minNonFoveatedStreamFormatWidth":1920,"maxNonFoveatedStreamFormatWidth":4096});
        identity.as_object_mut().unwrap().extend(profile.as_object().unwrap().clone());
        atomic_json(&f.ctx.settings,&json!({"vrlink_xrvst2ue":identity})).unwrap();
        let report=clean_identity(&f.ctx).unwrap();assert_eq!(report.removed_keys.len(),10);assert!(report.removed_sections.is_empty());
        let remaining=read_settings(&f.ctx.settings).unwrap();
        assert_eq!(remaining["vrlink_xrvst2ue"]["manufacturerName"],"Custom Manufacturer");
        assert_eq!(remaining["vrlink_xrvst2ue"]["enable"],false);assert_eq!(remaining["vrlink_xrvst2ue"]["custom"],123);
        for (key,value) in profile.as_object().unwrap(){assert_eq!(&remaining["vrlink_xrvst2ue"][key],value);}
    }
    #[test]
    fn identity_cleanup_ignores_unrelated_headsets_and_unknown_sections() {
        let f=Fixture::new();let baseline=json!({"vrlink_xrvst2ue":{"manufacturerName":"Meta","modelNumber":"Quest Pro","enable":true,
            "resourceRoot":"CustomHeadsetOpenVR","inputProfilePath":"{CustomHeadsetOpenVR}/input/galaxy_xr_hmd_profile.json"},
            "vrlink_unrelated":legacy_identity()});
        atomic_json(&f.ctx.settings,&baseline).unwrap();let before=fs::read(&f.ctx.settings).unwrap();
        let report=clean_identity(&f.ctx).unwrap();assert!(report.removed_keys.is_empty());assert!(report.backup_path.is_none());
        assert_eq!(fs::read(&f.ctx.settings).unwrap(),before);
    }
    #[test]
    fn mirrored_identity_cleanup_requires_galaxy_fingerprint_and_exact_values() {
        for (section, manufacturer, model) in [
            ("vrlink_Oculus Quest Pro", "Meta", "Oculus Quest Pro"),
            ("vrlink_PICO 4 Pro", "PICO", "PICO 4 Pro"),
        ] {
            let native = json!({"manufacturerName":manufacturer,"modelNumber":model,
                "enable":true,"hasEyeTracking":true,"supportsEyeTracking":true,
                "renderModelName":"generic_hmd","supports10bit":true,"targetBandwidth":80});
            let mut settings = json!({section:native.clone()});
            let mut report = IdentityCleanupReport { removed_keys:vec![],removed_sections:vec![],warnings:vec![],backup_path:None };
            plan_identity_cleanup(&mut settings,None,&mut report).unwrap();
            assert_eq!(settings[section],native);assert!(report.removed_keys.is_empty());

            settings[section] = legacy_identity();
            settings[section]["manufacturerName"] = json!(manufacturer);
            settings[section]["supports10bit"] = json!(true);
            settings[section]["targetBandwidth"] = json!(80);
            let journal = json!({"entries":{section:{"resourceRoot":{}}},"legacyKeys":{section:{"inputProfilePath":true}}});
            plan_identity_cleanup(&mut settings,Some(&journal),&mut report).unwrap();
            assert_eq!(report.removed_keys.len(),9);
            assert_eq!(settings[section],json!({"manufacturerName":manufacturer,
                "resourceRoot":DRIVER,"inputProfilePath":"{GalaxyXRNative}/input/galaxy_xr_hmd_profile.json",
                "supports10bit":true,"targetBandwidth":80}));
            assert_eq!(report.warnings.len(),2);
        }
    }
    #[test]
    fn legacy_uninstall_does_not_claim_unjournaled_mirrored_profiles() {
        let original = json!({"vrlink_Oculus Quest Pro":{"supports10bit":true,"targetBandwidth":80},
            "vrlink_PICO 4 Pro":{"recommendedRenderWidth":1920,"renderWidth":1920}});
        let mut settings = original.clone();
        assert_eq!(legacy_reset(&mut settings,&json!({"entries":{}})).unwrap(),0);
        assert_eq!(settings,original);
    }
    #[test]
    fn identity_cleanup_preserves_journal_entries_and_legacy_baselines() {
        let f=Fixture::new();atomic_json(&f.ctx.settings,&json!({"vrlink_xrvst2ue":legacy_identity()})).unwrap();
        let journal=json!({"schema":1,"driver":DRIVER,"settingsPath":f.ctx.settings,"sectionPresence":{"vrlink_xrvst2ue":true},
            "entries":{"vrlink_xrvst2ue":{"resourceRoot":{"present":true,"value":"old","lastPresent":true,"lastValue":DRIVER}}},
            "legacyKeys":{"vrlink_xrvst2ue":{"inputProfilePath":true}}});
        atomic_json(&f.ctx.journal(),&journal).unwrap();let before=fs::read(f.ctx.journal()).unwrap();
        let report=clean_identity(&f.ctx).unwrap();assert_eq!(report.removed_keys.len(),10);assert_eq!(report.warnings.len(),2);
        let remaining=read_settings(&f.ctx.settings).unwrap();assert_eq!(remaining["vrlink_xrvst2ue"].as_object().unwrap().len(),2);
        assert_eq!(remaining["vrlink_xrvst2ue"]["resourceRoot"],DRIVER);assert_eq!(fs::read(f.ctx.journal()).unwrap(),before);
    }
    #[test]
    fn identity_cleanup_is_idempotent_and_removes_only_recognized_empty_sections() {
        let f=Fixture::new();atomic_json(&f.ctx.settings,&json!({"vrlink_xrvst2":{},"vrlink_Galaxy XR":{},"other":{}})).unwrap();
        let first=clean_identity(&f.ctx).unwrap();assert_eq!(first.removed_sections.len(),2);assert!(first.removed_keys.is_empty());
        let before=fs::read(&f.ctx.settings).unwrap();let files=fs::read_dir(f.ctx.settings.parent().unwrap()).unwrap().count();
        let second=clean_identity(&f.ctx).unwrap();assert!(second.backup_path.is_none());assert!(second.removed_sections.is_empty());
        assert_eq!(fs::read_dir(f.ctx.settings.parent().unwrap()).unwrap().count(),files);assert_eq!(fs::read(&f.ctx.settings).unwrap(),before);
        assert_eq!(read_settings(&f.ctx.settings).unwrap(),json!({"other":{}}));
    }
    #[test]
    fn identity_cleanup_requires_strong_fingerprint_for_older_resource_roots() {
        for resource in ["galaxyxrresources",LEGACY] {
            let f=Fixture::new();let mut identity=legacy_identity();identity["resourceRoot"]=json!(resource);
            identity["inputProfilePath"]=json!(format!("{{{resource}}}/input/galaxy_xr_hmd_profile.json"));
            atomic_json(&f.ctx.settings,&json!({"vrlink_Galaxy XR":identity})).unwrap();
            let report=clean_identity(&f.ctx).unwrap();assert_eq!(report.removed_keys.len(),12);assert_eq!(report.removed_sections.len(),1);
        }
    }
    #[test]
    fn identity_cleanup_fails_closed_on_malformed_settings_or_journal() {
        for original in ["[]".to_owned(),"{ invalid".to_owned(),format!("{{\"vrlink_xrvst2ue\":{},\"vrlink_xrvst2\":false}}",legacy_identity())] {
            let f=Fixture::new();atomic_bytes(&f.ctx.settings,original.as_bytes()).unwrap();
            assert!(clean_identity(&f.ctx).is_err());assert_eq!(fs::read(&f.ctx.settings).unwrap(),original.as_bytes());
            assert_eq!(fs::read_dir(f.ctx.settings.parent().unwrap()).unwrap().count(),1);assert!(!f.ctx.data.exists());
        }
        let f=Fixture::new();atomic_json(&f.ctx.settings,&json!({"vrlink_xrvst2ue":legacy_identity()})).unwrap();
        atomic_json(&f.ctx.journal(),&json!({"schema":999})).unwrap();let before=fs::read(&f.ctx.settings).unwrap();
        assert!(clean_identity(&f.ctx).is_err());assert_eq!(fs::read(&f.ctx.settings).unwrap(),before);
        assert_eq!(fs::read_dir(f.ctx.settings.parent().unwrap()).unwrap().count(),1);
    }
    #[test]
    fn identity_cleanup_missing_settings_does_not_create_any_directories() {
        let f=Fixture::new();let report=clean_identity(&f.ctx).unwrap();
        assert!(report.backup_path.is_none());assert!(report.removed_keys.is_empty());assert!(!f.ctx.settings.parent().unwrap().exists());assert!(!f.ctx.data.exists());
    }
    #[test]
    fn install_uninstall_reinstall_preserves_bundle_and_restores_settings() {
        let f=Fixture::new();let source=f.package("bundle/GalaxyXRNative");let exe=f.root.join("bundle/GalaxyXRDriverGUI/gui.exe");
        fs::create_dir_all(source.join("resources/nested")).unwrap();fs::write(source.join("resources/nested/profile.json"),b"original bundle").unwrap();
        let baseline=json!({"steamvr":{"other":42},"driver_GalaxyXRNative":{"enable":false,"blocked_by_safe_mode":true}});
        atomic_json(&f.ctx.settings,&baseline).unwrap();
        atomic_json(&f.ctx.data.join("settings.json"),&json!({"other":17,"galaxyXr":{"nativeIdentity":false,"bandwidth":123}})).unwrap();
        let first=install_driver(&f.ctx,&source,&exe,|p,a|fake_registration(&f.ctx,p,a)).unwrap();
        let installed=PathBuf::from(first.registered_path);
        assert!(managed_location(&f.ctx,&installed));assert!(!same_path(&source,&installed));
        assert_eq!(fs::read(installed.join("resources/nested/profile.json")).unwrap(),b"original bundle");
        assert_eq!(f.ctx.registrations().unwrap(),vec![installed.clone()]);
        let config=read_json(&f.ctx.data.join("settings.json")).unwrap();
        assert_eq!(config,json!({"other":17,"galaxyXr":{"nativeIdentity":true,"bandwidth":123}}));
        let receipt=f.ctx.receipt_value().unwrap().unwrap();
        assert_eq!(receipt["schema"],2);assert!(contains_path(&receipt_paths(Some(&receipt),"sourcePaths"),&source));
        assert!(!contains_path(&receipt_paths(Some(&receipt),"packages"),&source));
        uninstall_driver(&f.ctx,&exe,|p,a|fake_registration(&f.ctx,p,a)).unwrap();
        assert!(source.join("bin/win64/driver_GalaxyXRNative.dll").exists());
        assert_eq!(fs::read(source.join("resources/nested/profile.json")).unwrap(),b"original bundle");
        assert!(!installed.exists());assert!(!f.ctx.data.exists());assert!(!f.ctx.managed.exists());
        assert!(f.ctx.registrations().unwrap().is_empty());assert_eq!(read_settings(&f.ctx.settings).unwrap(),baseline);
        let second=install_driver(&f.ctx,&source,&exe,|p,a|fake_registration(&f.ctx,p,a)).unwrap();
        assert!(Path::new(&second.registered_path).join("driver.vrdrivermanifest").exists());assert!(source.exists());
    }
    #[test]
    fn install_preserves_encoder_opt_out_and_uninstall_restores_encoder_settings() {
        let f=Fixture::new();let source=f.package("bundle/GalaxyXRNative");let exe=f.root.join("gui.exe");
        let stock=json!({"nvencSettingsVersion":4,"nvencTap":false,"nvencForceCbr":false,
            "postPack":{"enable":false,"casEnable":false}});
        atomic_json(&f.ctx.data.join("settings.json"),&json!({"streamFrame":stock})).unwrap();
        let baseline=json!({"driver_vrlink":{"targetBandwidth":123,"other":42}});
        atomic_json(&f.ctx.settings,&baseline).unwrap();
        install_driver(&f.ctx,&source,&exe,|p,a|fake_registration(&f.ctx,p,a)).unwrap();
        assert_eq!(read_json(&f.ctx.data.join("settings.json")).unwrap()["streamFrame"],stock);
        for section in std::iter::once("driver_vrlink").chain(COMPANION_PROFILE_SECTIONS.iter().copied()) {
            apply_changes(&f.ctx,vec![
                SettingChange{section:section.into(),key:"targetBandwidth".into(),present:true,value:json!(200)},
                SettingChange{section:section.into(),key:"maxVideoQueueLatencyUs".into(),present:true,value:json!(10000)}]).unwrap();
        }
        uninstall_driver(&f.ctx,&exe,|p,a|fake_registration(&f.ctx,p,a)).unwrap();
        assert_eq!(read_settings(&f.ctx.settings).unwrap(),baseline);
        assert!(!f.ctx.data.join("settings.json").exists());
        assert!(f.ctx.registrations().unwrap().is_empty());
    }
    #[test]
    fn legacy_encoder_extras_restore_all_profiles_without_claiming_external_edits() {
        let mut settings=json!({});
        for section in std::iter::once("driver_vrlink").chain(COMPANION_PROFILE_SECTIONS.iter().copied()) {
            settings[section]=json!({"encoderExtra":12,"changed":99,"journaled":8,"unrelated":42});
        }
        let mut journal=json!({"entries":{}});
        for section in COMPANION_PROFILE_SECTIONS {
            journal["entries"][section]["journaled"]=json!({"present":true,"value":7,"lastPresent":true,"lastValue":8});
        }
        let config=json!({"galaxyXr":{"vrlinkExtraKeys":{"encoderExtra":{"i":12},"changed":4,"journaled":8}}});
        let mut warnings=vec![];
        let restored=legacy_config_reset(&mut settings,&journal,&config,false,&mut warnings).unwrap();
        assert_eq!(restored,COMPANION_PROFILE_SECTIONS.len()+2);
        for section in std::iter::once("driver_vrlink").chain(COMPANION_PROFILE_SECTIONS.iter().copied()) {
            assert!(settings[section].get("encoderExtra").is_none());
            assert_eq!(settings[section]["changed"],99);
            assert_eq!(settings[section]["unrelated"],42);
        }
        for section in COMPANION_PROFILE_SECTIONS { assert_eq!(settings[section]["journaled"],8); }
        assert_eq!(legacy_config_reset(&mut settings,&journal,&config,false,&mut warnings).unwrap(),0);
    }
    #[test]
    fn old_external_bundle_is_unregistered_but_never_deleted() {
        let f=Fixture::new();let source=f.package("bundle/GalaxyXRNative");let copied=f.package("steamvr/drivers/GalaxyXRNative");
        fake_registration(&f.ctx,&source,true).unwrap();
        atomic_json(&f.ctx.receipt(),&json!({"schema":1,"driver":DRIVER,"packages":[source,copied]})).unwrap();
        uninstall_driver(&f.ctx,&f.root.join("gui.exe"),|p,a|fake_registration(&f.ctx,p,a)).unwrap();
        assert!(source.join("bin/win64/driver_GalaxyXRNative.dll").exists());assert!(!copied.exists());
        assert!(f.ctx.registrations().unwrap().is_empty());assert!(!f.ctx.data.exists());
    }
    #[test]
    fn upgrade_migrates_external_registration_and_retains_both_bundle_sources() {
        let f=Fixture::new();let old=f.package("old-bundle/GalaxyXRNative");let new=f.package("new-bundle/GalaxyXRNative");let exe=f.root.join("gui.exe");
        fake_registration(&f.ctx,&old,true).unwrap();
        atomic_json(&f.ctx.receipt(),&json!({"schema":1,"driver":DRIVER,"packages":[old]})).unwrap();
        let install=install_driver(&f.ctx,&new,&exe,|p,a|fake_registration(&f.ctx,p,a)).unwrap();
        assert_eq!(f.ctx.registrations().unwrap(),vec![PathBuf::from(install.registered_path)]);
        let receipt=f.ctx.receipt_value().unwrap().unwrap();
        assert!(contains_path(&receipt_paths(Some(&receipt),"sourcePaths"),&old));
        assert!(contains_path(&receipt_paths(Some(&receipt),"sourcePaths"),&new));
        uninstall_driver(&f.ctx,&exe,|p,a|fake_registration(&f.ctx,p,a)).unwrap();
        assert!(old.join("driver.vrdrivermanifest").exists());assert!(new.join("driver.vrdrivermanifest").exists());
    }
    #[test]
    fn repeated_upgrade_removes_all_managed_copies_on_uninstall() {
        let f=Fixture::new();let source=f.package("bundle/GalaxyXRNative");let exe=f.root.join("gui.exe");
        let first=install_driver(&f.ctx,&source,&exe,|p,a|fake_registration(&f.ctx,p,a)).unwrap();
        let second=install_driver(&f.ctx,&source,&exe,|p,a|fake_registration(&f.ctx,p,a)).unwrap();
        assert_ne!(first.registered_path,second.registered_path);
        assert_eq!(f.ctx.registrations().unwrap(),vec![PathBuf::from(&second.registered_path)]);
        uninstall_driver(&f.ctx,&exe,|p,a|fake_registration(&f.ctx,p,a)).unwrap();
        assert!(!Path::new(&first.registered_path).exists());assert!(!Path::new(&second.registered_path).exists());assert!(source.exists());
    }
    #[test]
    fn install_registration_failure_rolls_back_files_settings_config_and_receipt() {
        let f=Fixture::new();let source=f.package("bundle/GalaxyXRNative");let config=f.ctx.data.join("settings.json");
        atomic_json(&config,&json!({"galaxyXr":{"nativeIdentity":false}})).unwrap();
        atomic_json(&f.ctx.settings,&json!({"steamvr":{"other":12}})).unwrap();
        let original_config=fs::read(&config).unwrap();let original_settings=fs::read(&f.ctx.settings).unwrap();
        let result=install_driver(&f.ctx,&source,&f.root.join("gui.exe"),|p,a|if a {Err("injected registration failure".into())}else{fake_registration(&f.ctx,p,a)});
        assert!(result.unwrap_err().contains("injected registration failure"));
        assert_eq!(fs::read(config).unwrap(),original_config);assert_eq!(fs::read(&f.ctx.settings).unwrap(),original_settings);
        assert!(!f.ctx.receipt().exists());assert!(!f.ctx.journal().exists());assert!(source.exists());
        assert_eq!(fs::read_dir(&f.ctx.managed).unwrap().count(),0);
    }
    #[test]
    fn receipt_cannot_claim_external_bundle_as_owned_even_with_schema_2() {
        let f=Fixture::new();let source=f.package("bundle/GalaxyXRNative");
        let receipt=json!({"schema":2,"driver":DRIVER,"packages":[source],"sourcePaths":[]});
        assert!(!owned_package(&f.ctx,Some(&receipt),&source));
        let preserved=source_paths(&f.ctx,Some(&receipt),&[source.clone()]);assert!(contains_path(&preserved,&source));
    }
    #[test]
    fn incomplete_managed_copy_is_removed_while_source_bundle_survives() {
        let f=Fixture::new();let source=f.package("bundle/GalaxyXRNative");let partial=f.ctx.managed.join("GalaxyXRNative-interrupted.stage");
        fs::create_dir_all(&partial).unwrap();fs::write(partial.join("part"),b"incomplete").unwrap();
        atomic_json(&f.ctx.receipt(),&json!({"schema":2,"driver":DRIVER,"packages":[partial],"sourcePaths":[source],"cleanupPending":[partial]})).unwrap();
        uninstall_driver(&f.ctx,&f.root.join("gui.exe"),|p,a|fake_registration(&f.ctx,p,a)).unwrap();
        assert!(!partial.exists());assert!(source.exists());assert!(!f.ctx.data.exists());
    }
    #[test]
    fn install_retires_steamvr_copy_without_moving_bundle() {
        let f=Fixture::new();let source=f.package("bundle/GalaxyXRNative");let copied=f.package("steamvr/drivers/GalaxyXRNative");let exe=f.root.join("gui.exe");
        install_driver(&f.ctx,&source,&exe,|p,a|fake_registration(&f.ctx,p,a)).unwrap();
        assert!(source.exists());assert!(!copied.exists());
        let receipt=f.ctx.receipt_value().unwrap().unwrap();
        let retired=receipt_paths(Some(&receipt),"packages").into_iter().find(|p|p.exists() && legacy_install_location(&f.ctx,p)).unwrap();
        assert!(retired.join("driver.vrdrivermanifest").exists());
        uninstall_driver(&f.ctx,&exe,|p,a|fake_registration(&f.ctx,p,a)).unwrap();
        assert!(!retired.exists());assert!(source.exists());
    }
    #[test]
    fn failed_uninstall_preserves_bundle_and_owned_files_for_retry() {
        let f=Fixture::new();let source=f.package("bundle/GalaxyXRNative");let exe=f.root.join("gui.exe");
        let installed=install_driver(&f.ctx,&source,&exe,|p,a|fake_registration(&f.ctx,p,a)).unwrap();
        let before=fs::read(&f.ctx.settings).unwrap();
        assert!(uninstall_driver(&f.ctx,&exe,|p,a|if a {fake_registration(&f.ctx,p,a)}else{Err("injected unregister failure".into())}).is_err());
        assert!(source.exists());assert!(Path::new(&installed.registered_path).exists());assert_eq!(fs::read(&f.ctx.settings).unwrap(),before);
        uninstall_driver(&f.ctx,&exe,|p,a|fake_registration(&f.ctx,p,a)).unwrap();
        assert!(source.join("bin/win64/driver_GalaxyXRNative.dll").exists());assert!(!Path::new(&installed.registered_path).exists());
    }
    #[test]
    fn source_inside_configuration_is_rejected_before_install_mutation() {
        let f=Fixture::new();let source=f.package("GalaxyXR/CustomHeadset/bundle");
        let dll=fs::read(source.join("bin/win64/driver_GalaxyXRNative.dll")).unwrap();
        let result=install_driver(&f.ctx,&source,&f.root.join("gui.exe"),|_,_|panic!("Registration must not run"));
        assert!(result.unwrap_err().contains("overlaps the driver configuration directory"));
        assert!(!f.ctx.receipt().exists());assert!(!f.ctx.journal().exists());assert!(!f.ctx.settings.exists());assert!(!f.ctx.managed.exists());
        assert_eq!(fs::read(source.join("bin/win64/driver_GalaxyXRNative.dll")).unwrap(),dll);
    }
    #[test]
    fn source_containing_managed_destination_is_rejected_before_copy() {
        for name in ["local/GalaxyXR","local/GalaxyXR/Drivers"] {
            let f=Fixture::new();let source=f.package(name);
            let result=install_driver(&f.ctx,&source,&f.root.join("gui.exe"),|_,_|panic!("Registration must not run"));
            assert!(result.unwrap_err().contains("contains the managed installation directory"));
            assert!(!f.ctx.receipt().exists());assert!(!f.ctx.journal().exists());assert!(!f.ctx.settings.exists());
            assert_eq!(fs::read_dir(&source).unwrap().count(),2);
        }
    }
    #[test]
    fn copy_rejects_a_descendant_before_creating_it() {
        let f=Fixture::new(); let source=f.package("bundle");
        let target=source.join("not-created/nested-driver");
        assert!(copy_package(&source,&target).unwrap_err().contains("overlaps"));
        assert!(!source.join("not-created").exists());
    }
    #[cfg(windows)]
    #[test]
    fn short_path_aliases_preserve_existing_and_missing_path_boundaries() {
        use std::os::windows::ffi::{OsStrExt,OsStringExt};
        #[link(name="kernel32")]
        extern "system" { fn GetShortPathNameW(long:*const u16,short:*mut u16,size:u32)->u32; }
        let f=Fixture::new(); let source=f.package("Long package directory");
        let canonical=fs::canonicalize(&source).unwrap();
        let wide:Vec<u16>=canonical.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut buffer=vec![0u16;32768];
        let length=unsafe {GetShortPathNameW(wide.as_ptr(),buffer.as_mut_ptr(),buffer.len() as u32)};
        assert!(length>0 && (length as usize)<buffer.len());
        let short=PathBuf::from(std::ffi::OsString::from_wide(&buffer[..length as usize]));
        assert!(same_path(&short,&canonical));
        assert!(same_path(&short.join("missing/gui.exe"),&canonical.join("missing/gui.exe")));
        assert!(contains_directory(&canonical,&short.join("missing/driver")));
        assert!(!contains_directory(&canonical,&canonical.with_file_name("Long package directory sibling")));
        assert!(validate_package(&canonical,&short.join("gui.exe")).unwrap_err().contains("running GUI"));
        assert!(copy_package(&canonical,&short.join("missing/driver")).unwrap_err().contains("overlaps"));
        assert!(!short.join("missing").exists());
    }
    #[test]
    fn legacy_source_in_config_blocks_uninstall_without_deleting_source() {
        let f=Fixture::new();let source=f.package("GalaxyXR/CustomHeadset/old-bundle");
        fake_registration(&f.ctx,&source,true).unwrap();
        atomic_json(&f.ctx.receipt(),&json!({"schema":1,"driver":DRIVER,"packages":[source]})).unwrap();
        atomic_json(&f.ctx.settings,&json!({"driver_vrlink":{"encodeWidth":4096}})).unwrap();
        let receipt=fs::read(f.ctx.receipt()).unwrap();let settings=fs::read(&f.ctx.settings).unwrap();
        let result=uninstall_driver(&f.ctx,&f.root.join("gui.exe"),|_,_|panic!("Registration must not run"));
        assert!(matches!(result,Err(e) if e.contains("overlaps the driver configuration directory")));
        assert!(source.join("bin/win64/driver_GalaxyXRNative.dll").exists());
        assert_eq!(fs::read(f.ctx.receipt()).unwrap(),receipt);assert_eq!(fs::read(&f.ctx.settings).unwrap(),settings);
        assert!(!f.ctx.journal().exists());assert_eq!(f.ctx.registrations().unwrap(),vec![source]);
    }
    #[test]
    fn repeated_writes_restore_original_and_absence_preserving_unrelated() {
        let f = Fixture::new();
        let original = json!({"driver_vrlink":{"targetBandwidth":87,"enableHandTracking":false},"steamvr":{"unrelated":"keep"}});
        atomic_json(&f.ctx.settings, &original).unwrap();
        apply_changes(&f.ctx, vec![change("driver_vrlink","targetBandwidth",Some(json!(200))),change("new","added",Some(json!(true)))]).unwrap();
        apply_changes(&f.ctx, vec![change("driver_vrlink","targetBandwidth",None),change("new","added",Some(json!(false)))]).unwrap();
        let mut settings = read_settings(&f.ctx.settings).unwrap();
        assert_eq!(restore_settings(&mut settings, &load_journal(&f.ctx).unwrap(), &mut vec![]).unwrap(),2);
        assert_eq!(settings,original);
    }
    #[test]
    fn explicit_null_is_not_absence_and_external_changes_survive() {
        let f = Fixture::new();
        atomic_json(&f.ctx.settings,&json!({"s":{"a":null}})).unwrap();
        apply_changes(&f.ctx,vec![change("s","a",Some(json!(42))),change("s","b",Some(json!(3)))]).unwrap();
        let mut settings = json!({"s":{"a":42,"b":9}}); let mut warnings=vec![];
        restore_settings(&mut settings,&load_journal(&f.ctx).unwrap(),&mut warnings).unwrap();
        assert_eq!(settings,json!({"s":{"a":null,"b":9}})); assert_eq!(warnings.len(),1);
    }
    #[test]
    fn originally_empty_section_survives_restore() {
        let f=Fixture::new(); atomic_json(&f.ctx.settings,&json!({"empty":{}})).unwrap();
        apply_changes(&f.ctx,vec![change("empty","a",Some(json!(1)))]).unwrap();
        let mut settings=read_settings(&f.ctx.settings).unwrap(); restore_settings(&mut settings,&load_journal(&f.ctx).unwrap(),&mut vec![]).unwrap();
        assert_eq!(settings,json!({"empty":{}}));
    }
    #[test]
    fn pending_cleanup_can_finish_partially_deleted_package_only() {
        let f=Fixture::new(); let path=f.package("partial"); fs::remove_file(path.join("driver.vrdrivermanifest")).unwrap();
        let receipt=json!({"packages":[path],"cleanupPending":[path]});
        assert_eq!(candidate_packages(&f.ctx,Some(&receipt)).unwrap(),vec![path.clone()]);
        assert!(validate_package(&path,&f.root.join("gui.exe")).is_err());
        assert!(validate_package_path(&path,&f.root.join("gui.exe")).is_ok());
        assert!(!cleanup_pending(Some(&receipt),&f.root));
    }
    #[test]
    fn retained_tombstone_is_discovered_for_retry() {
        let f=Fixture::new();let original=f.package("old");let tombstone=f.root.join(".galaxyxr-uninstall-fixture");
        fs::rename(&original,&tombstone).unwrap();fs::remove_file(tombstone.join("driver.vrdrivermanifest")).unwrap();
        let receipt=json!({"packages":[original,tombstone],"cleanupPending":[original,tombstone],"staged":[[original,tombstone]]});
        assert_eq!(candidate_packages(&f.ctx,Some(&receipt)).unwrap(),vec![tombstone]);
    }
    #[test]
    fn write_ahead_plan_survives_precommit_rollback_failure() {
        let f=Fixture::new();let original=f.package("planned");
        let (planned,_)=prepare_uninstall_receipt(&f.ctx,&[original.clone()],false).unwrap();
        assert!(original.exists());assert!(!planned[0].1.exists());
        fs::rename(&original,&planned[0].1).unwrap();
        // Simulate a collision preventing rollback before settings commit.
        fs::create_dir_all(original.join("occupied")).unwrap();
        assert_eq!(rollback_staged(&planned).len(),1);
        fs::remove_dir_all(&original).unwrap();
        let receipt=f.ctx.receipt_value().unwrap().unwrap();
        assert_eq!(candidate_packages(&f.ctx,Some(&receipt)).unwrap(),vec![planned[0].1.clone()]);
    }
    #[test]
    fn legacy_custom_settings_only_reset_matching_values_and_fork_markers() {
        let mut settings=json!({"driver_vrlink":{"custom":12,"changed":99,"journaled":7},"driver_CustomHeadsetOpenVR":{"enable":false,"other":42}});
        let journal=json!({"entries":{"driver_vrlink":{"journaled":{}}}});
        let config=json!({"galaxyXr":{"vrlinkExtraKeys":{"custom":{"i":12},"changed":5,"journaled":7}}});
        let mut warnings=vec![];
        assert_eq!(legacy_config_reset(&mut settings,&journal,&config,true,&mut warnings).unwrap(),2);
        assert_eq!(settings,json!({"driver_vrlink":{"changed":99,"journaled":7},"driver_CustomHeadsetOpenVR":{"other":42}}));
        assert_eq!(warnings.len(),1);
    }
    #[test]
    fn upgrade_baseline_overrides_are_removed_after_new_journaled_change() {
        let f=Fixture::new();atomic_json(&f.ctx.settings,&json!({"driver_vrlink":{"targetBandwidth":200,"enableHandTracking":true}})).unwrap();
        apply_changes(&f.ctx,vec![change("driver_vrlink","targetBandwidth",Some(json!(300)))]).unwrap();
        let mut journal=load_journal(&f.ctx).unwrap();journal["legacy"]=json!(true);
        let mut settings=read_settings(&f.ctx.settings).unwrap();record_legacy_keys(&mut journal,&settings,&json!({}),false).unwrap();
        restore_settings(&mut settings,&journal,&mut vec![]).unwrap();legacy_reset(&mut settings,&journal).unwrap();
        assert_eq!(settings,json!({"driver_vrlink":{"enableHandTracking":true}}));
        settings["driver_vrlink"]["targetBandwidth"]=json!(99);let mut warnings=vec![];
        restore_settings(&mut settings,&journal,&mut warnings).unwrap();assert_eq!(settings["driver_vrlink"]["targetBandwidth"],99);assert_eq!(warnings.len(),1);
    }
    #[test]
    fn numeric_settings_match_integer_or_float_and_float32_serialization() {
        assert!(setting_equal(Some(&json!(2)),Some(&json!(2.0))));
        assert!(setting_equal(Some(&json!(0.7)),Some(&json!(0.7f32 as f64))));
        assert!(!setting_equal(Some(&json!(0.7)),Some(&json!(0.8))));
    }
    #[test]
    fn missing_recorded_manifest_blocks_normal_cleanup() {
        let f=Fixture::new();let path=f.package("steamvr/drivers/GalaxyXRNative");fs::remove_file(path.join("driver.vrdrivermanifest")).unwrap();
        assert!(candidate_packages(&f.ctx,Some(&json!({"packages":[path]}))).is_err());
    }
    #[test]
    fn upgrade_preserves_missing_external_sources_for_stale_registration_cleanup() {
        let f=Fixture::new();let missing=f.root.join("missing-old-driver");let current=f.package("current");
        let receipt=json!({"packages":[missing,current]});let mut packages=vec![current.clone()];
        packages=source_paths(&f.ctx,Some(&receipt),&packages);
        assert!(contains_path(&packages,&current));assert!(contains_path(&packages,&missing));
    }
    #[test]
    fn retirement_parent_cleanup_preserves_unrelated_files() {
        let f=Fixture::new();let root=f.ctx.steamvr.join(".galaxyxr-retired");let parent=root.join("123");fs::create_dir_all(&parent).unwrap();
        let package=parent.join(DRIVER);let mut warnings=vec![];
        fs::write(parent.join("unrelated"),b"keep").unwrap();cleanup_retirement_parents(&f.ctx,&[package.clone()],&mut warnings);
        assert!(parent.join("unrelated").exists());assert_eq!(warnings.len(),1);
        fs::remove_file(parent.join("unrelated")).unwrap();warnings.clear();cleanup_retirement_parents(&f.ctx,&[package],&mut warnings);
        assert!(!root.exists());assert!(warnings.is_empty());
    }
    #[cfg(windows)]
    #[test]
    fn settings_write_failure_restores_previous_journal() {
        use std::os::windows::fs::OpenOptionsExt;
        let f=Fixture::new();atomic_json(&f.ctx.settings,&json!({"s":{"a":1}})).unwrap();
        apply_changes(&f.ctx,vec![change("s","a",Some(json!(2)))]).unwrap();let original=fs::read(f.ctx.journal()).unwrap();
        let locked=fs::OpenOptions::new().read(true).share_mode(1).open(&f.ctx.settings).unwrap();
        assert!(apply_changes(&f.ctx,vec![change("s","a",Some(json!(3)))]).is_err());drop(locked);
        assert_eq!(fs::read(f.ctx.journal()).unwrap(),original);assert_eq!(read_settings(&f.ctx.settings).unwrap()["s"]["a"],2);
    }
    #[test]
    fn corrupted_journal_never_overwritten() {
        let f=Fixture::new(); fs::create_dir_all(&f.ctx.data).unwrap(); fs::write(f.ctx.journal(),b"broken").unwrap();
        assert!(apply_changes(&f.ctx,vec![change("s","a",Some(json!(1)))]).is_err());
        assert_eq!(fs::read(f.ctx.journal()).unwrap(),b"broken"); assert!(!f.ctx.settings.exists());
    }
    #[test]
    fn first_gui_journal_detects_prior_install_but_not_unregistered_package() {
        let f=Fixture::new();let package=f.package("new-unregistered");
        assert_eq!(load_journal(&f.ctx).unwrap()["legacy"],false);
        atomic_json(&f.ctx.paths_file,&json!({"external_drivers":[package]})).unwrap();
        assert_eq!(load_journal(&f.ctx).unwrap()["legacy"],true);
        apply_changes(&f.ctx,vec![change("driver_GalaxyXRNative","enable",Some(json!(true)))]).unwrap();
        assert_eq!(load_journal(&f.ctx).unwrap()["legacy"],true);
        fs::remove_file(f.ctx.journal()).unwrap();atomic_json(&f.ctx.paths_file,&json!({"external_drivers":[]})).unwrap();
        atomic_json(&f.ctx.data.join("info.json"),&json!({})).unwrap();assert_eq!(load_journal(&f.ctx).unwrap()["legacy"],true);
    }
    #[test]
    fn rejects_foreign_manifest_source_and_gui_ancestor() {
        let f=Fixture::new(); let path=f.package("package"); let exe=f.root.join("gui.exe");
        assert!(validate_package(&path,&exe).is_ok());
        assert!(validate_package(&path,&path.join("gui.exe")).is_err());
        fs::create_dir(path.join("src")).unwrap(); assert!(validate_package(&path,&exe).is_err()); fs::remove_dir(path.join("src")).unwrap();
        atomic_json(&path.join("driver.vrdrivermanifest"),&json!({"name":"vrlink"})).unwrap(); assert!(validate_package(&path,&exe).is_err());
    }
    #[test]
    fn legacy_does_not_erase_journal_restoration_or_preferences() {
        let mut settings=json!({"driver_GalaxyXRNative":{"enable":true},"driver_vrlink":{"targetBandwidth":75,"encodeWidth":4096,"enableHandTracking":true,"shareEyeTracking":true},"driver_other":{"enable":true}});
        let journal=json!({"entries":{"driver_vrlink":{"targetBandwidth":{"present":true,"value":75,"lastPresent":true,"lastValue":200}}}});
        legacy_reset(&mut settings,&journal).unwrap();
        assert_eq!(settings,json!({"driver_vrlink":{"targetBandwidth":75,"enableHandTracking":true,"shareEyeTracking":true},"driver_other":{"enable":true}}));
    }
    #[test]
    fn staged_rename_rollback_restores_files_and_reports_collision() {
        let f=Fixture::new(); let path=f.package("package"); let staged=f.root.join("staged");
        fs::rename(&path,&staged).unwrap(); assert!(rollback_staged(&[(path.clone(),staged.clone())]).is_empty()); assert!(path.exists());
        fs::rename(&path,&staged).unwrap(); fs::create_dir_all(path.join("occupied")).unwrap();
        assert_eq!(rollback_staged(&[(path.clone(),staged.clone())]).len(),1); assert!(staged.exists());
    }
    #[test]
    fn comments_inside_strings_are_preserved() {
        let f=Fixture::new(); fs::write(&f.ctx.paths_file,b"{/* comment */\"url\":\"https://test/a/*b*/\",// line\n\"v\":true}").unwrap();
        assert_eq!(read_json(&f.ctx.paths_file).unwrap()["url"],"https://test/a/*b*/");
    }
    #[cfg(windows)]
    #[test]
    fn junction_package_is_rejected() {
        use std::os::windows::process::CommandExt;
        let f=Fixture::new(); let target=f.package("real"); let link=f.root.join("junction");
        // All paths are generated temporary fixtures. cmd mklink does not
        // delete/move files; fixture teardown removes the junction itself.
        let result=Command::new("cmd.exe").args(["/C","mklink","/J"]).arg(&link).arg(&target).creation_flags(0x08000000).output().unwrap();
        assert!(result.status.success()); assert!(validate_package(&link,&f.root.join("gui.exe")).is_err()); fs::remove_dir(&link).unwrap();
    }
    #[test]
    fn uninstall_preserves_app_preferences_and_removes_driver_data() {
        let f=Fixture::new();let source=f.package("bundle/GalaxyXRNative");let exe=f.root.join("bundle/GalaxyXRDriverGUI/gui.exe");
        atomic_json(&f.ctx.data.join("settings.json"),&json!({"other":17})).unwrap();
        atomic_json(&f.ctx.data.join("gui-settings.json"),&json!({"colorScheme":"light","updateMode":"rewrite","advanceMode":true})).unwrap();
        let installed=install_driver(&f.ctx,&source,&exe,|p,a|fake_registration(&f.ctx,p,a)).unwrap();
        assert!(Path::new(&installed.registered_path).join("driver.vrdrivermanifest").exists());
        uninstall_driver(&f.ctx,&exe,|p,a|fake_registration(&f.ctx,p,a)).unwrap();
        assert!(!Path::new(&installed.registered_path).exists());
        assert!(!f.ctx.data.join("settings.json").exists());
        let gui=read_json(&f.ctx.data.join("gui-settings.json")).unwrap();
        assert_eq!(gui["colorScheme"],"light");assert_eq!(gui["advanceMode"],true);
        assert!(source.exists());
    }
}
