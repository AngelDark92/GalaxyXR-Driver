//! Owned-driver installation and reversible SteamVR settings changes.
//! All entry points serialize with the native driver's settings writer.
pub mod settings_cleanup;
pub mod runtime_status;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeSet, fs, io::Write, path::{Component, Path, PathBuf}, process::Command, time::{SystemTime, UNIX_EPOCH}};
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
    outcome: &'static str,
    preserved_paths: Vec<String>,
    unresolved_items: Vec<String>,
    removed_paths: Vec<String>,
    restored_settings: usize,
    legacy_reset: bool,
    warnings: Vec<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InstallReport {
    registered_path: String,
    managed_root: String,
    used_default_root: bool,
    legacy_detected: bool,
}

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
        fn GetDriveTypeW(root: *const u16) -> u32;
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
    // 2026-10-26: custom driver roots must be on a local fixed drive. A mapped
    // network drive, removable drive or RAM disk can disappear between the
    // install and the next SteamVR start, producing the same class of
    // "Skipping external driver ... because it is not a directory" failure.
    pub fn fixed_drive(path: &Path) -> bool {
        let letter = match path.components().next() {
            Some(Component::Prefix(prefix)) => match prefix.kind() {
                std::path::Prefix::Disk(letter) | std::path::Prefix::VerbatimDisk(letter) => letter,
                _ => return false,
            },
            _ => return false,
        };
        let root = [letter as u16, b':' as u16, b'\\' as u16, 0];
        unsafe { GetDriveTypeW(root.as_ptr()) == 3 }
    }
    pub fn hidden(command: &mut Command) { command.creation_flags(0x08000000); }
}
#[cfg(not(windows))]
mod platform {
    use super::*;
    pub struct Lock;
    impl Lock { pub fn acquire() -> Result<Self> { Ok(Self) } }
    pub fn replace(from: &Path, to: &Path) -> Result<()> { fs::rename(from, to).map_err(|e| e.to_string()) }
    pub fn reparse(meta: &fs::Metadata) -> bool { meta.file_type().is_symlink() }
    pub fn fixed_drive(_: &Path) -> bool { true }
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
fn strip_verbatim(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let text = path.to_string_lossy();
        if let Some(rest) = text.strip_prefix("\\\\?\\") { return PathBuf::from(rest); }
    }
    path
}
fn resolved_path(path: &Path) -> PathBuf {
    strip_verbatim(path.ancestors().find_map(|ancestor| fs::canonicalize(ancestor).ok().and_then(|canonical|
        path.strip_prefix(ancestor).ok().map(|suffix| canonical.join(suffix)))).unwrap_or_else(|| path.to_path_buf()))
}
fn env_path(key: &str) -> Option<PathBuf> {
    std::env::var_os(key).filter(|value| !value.is_empty()).map(PathBuf::from)
}
fn path_units(path: &Path) -> usize {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        path.as_os_str().encode_wide().count()
    }
    #[cfg(not(windows))]
    {
        path.as_os_str().len()
    }
}
// Returns the directories that would have to be created for `root`, in
// top-down order. It also rejects a file or reparse point anywhere on the
// chain before any mutation. A non-existent chain is common on a new drive.
fn plan_created_dirs(root: &Path) -> Result<Vec<PathBuf>> {
    let mut missing = vec![];
    for part in root.ancestors() {
        match fs::symlink_metadata(part) {
            Ok(meta) if platform::reparse(&meta) || meta.file_type().is_symlink() => return Err(error(part, "Refusing reparse point / symbolic link")),
            Ok(meta) if meta.is_dir() => break,
            Ok(_) => return Err(error(part, "Install root is not a directory")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => missing.push(part.to_path_buf()),
            Err(e) => return Err(error(part, e)),
        }
    }
    missing.reverse();
    Ok(missing)
}
// 2026-10-26: the default root stays byte-for-byte the existing contract. A
// custom root is explicit opt-in and must be a local fixed drive, a dedicated
// folder, and outside every path this app already owns or preserves.
fn validate_managed_root(ctx: &Context, root: &Path, source: &Path) -> Result<PathBuf> {
    let text = root.to_string_lossy();
    if text.trim().is_empty() { return Err("Choose an install folder".into()); }
    if !root.is_absolute() { return Err(error(root, "Install folder must be an absolute path")); }
    if text.starts_with("\\\\") { return Err(error(root, "Network/UNC install folders are not supported")); }
    if root.components().any(|component| component == Component::ParentDir) { return Err(error(root, "Install folder must not contain ..")); }
    if root.parent().is_none() { return Err(error(root, "Choose a dedicated folder, not a drive root")); }
    let resolved = resolved_path(root);
    if !platform::fixed_drive(&resolved) {
        return Err(error(root, "Choose a folder on a local fixed drive; network, removable and RAM-disk folders are not supported"));
    }
    for key in ["USERPROFILE", "LOCALAPPDATA", "APPDATA"] {
        if env_path(key).map(|path| same_path(&resolved, &path)).unwrap_or(false) {
            return Err(error(root, "Choose a dedicated folder, not a Windows profile or system folder"));
        }
    }
    for key in ["ProgramFiles", "ProgramFiles(x86)", "ProgramData", "SystemRoot"] {
        if let Some(base) = env_path(key) {
            if same_path(&resolved, &base) || contains_directory(&base, &resolved) {
                return Err(error(root, "Choose a dedicated folder, not a Windows system folder"));
            }
        }
    }
    if let Some(app_data) = env_path("USERPROFILE").map(|path| path.join("AppData")) {
        if same_path(&resolved, &app_data) { return Err(error(root, "Choose a dedicated folder, not the AppData root")); }
    }
    if let Some(users) = env_path("SystemDrive").map(|drive| drive.join("Users")) {
        if same_path(&resolved, &users) { return Err(error(root, "Choose a dedicated folder, not the Users root")); }
    }
    #[cfg(not(test))]
    if let Some(temp) = env_path("TEMP").or_else(|| env_path("TMP")) {
        if contains_directory(&temp, &resolved) { return Err(error(root, "Temporary install folders are not supported")); }
    }
    for ancestor in resolved.ancestors() {
        if ancestor.join(".git").exists() || ancestor.join("GalaxyXRDriver").exists()
            || ancestor.join("GalaxyXRDriverGUI").exists() || ancestor.join("CustomHeadsetOpenVR").exists() {
            return Err(error(root, "Refusing a source/workspace install folder"));
        }
    }
    let other_owned = [
        ("driver configuration", ctx.data.clone()),
        ("default managed driver folder", ctx.managed.clone()),
        ("SteamVR", ctx.steamvr.clone()),
        ("driver source bundle", source.to_path_buf()),
    ];
    for (label, other) in other_owned {
        if same_path(&resolved, &other) {
            if label == "default managed driver folder" { return Ok(resolved); }
            return Err(error(root, format!("Install folder overlaps the {label}")));
        }
        if contains_directory(&other, &resolved) || contains_directory(&resolved, &other) {
            return Err(error(root, format!("Install folder overlaps the {label}")));
        }
    }
    let sample = resolved.join(format!("GalaxyXRNative-{}", "0".repeat(19))).join("bin/win64/driver_GalaxyXRNative.dll");
    if path_units(&sample) > 240 { return Err(error(root, "Install path is too long; choose a shorter folder")); }
    let _ = plan_created_dirs(&resolved)?;
    if resolved.exists() && !resolved.is_dir() { return Err(error(root, "Install folder is not a directory")); }
    safe_chain(&resolved)?;
    Ok(resolved)
}
fn receipt_managed_roots(ctx: &Context, receipt: Option<&Value>) -> Vec<PathBuf> {
    let mut roots = vec![];
    if let Some(receipt) = receipt.filter(|receipt| receipt["schema"] == 3) {
        if let Some(list) = receipt["managedRoots"].as_array() {
            for path in list.iter().filter_map(Value::as_str).map(PathBuf::from) { push_path(&mut roots, path); }
        }
    }
    // A schema 1/2 receipt owns packages under the historical default root.
    // A pristine custom install has no default package to record.
    if roots.is_empty() && receipt.is_some() { roots.push(ctx.managed.clone()); }
    roots
}
fn receipt_created_roots(receipt: Option<&Value>) -> Vec<PathBuf> {
    receipt.filter(|receipt| receipt["schema"] == 3).and_then(|receipt| receipt["createdRoots"].as_array())
        .map(|list| list.iter().filter_map(Value::as_str).map(PathBuf::from).collect()).unwrap_or_default()
}
fn managed_location_for(ctx: &Context, receipt: Option<&Value>, path: &Path) -> bool {
    let leaf = path.file_name().and_then(|name| name.to_str()).unwrap_or("");
    if !leaf.starts_with("GalaxyXRNative-") && !leaf.starts_with(".galaxyxr-uninstall-") { return false; }
    if receipt.map(|receipt| receipt["schema"] == 3).unwrap_or(false) {
        let Some(parent) = path.parent() else { return false };
        return receipt_managed_roots(ctx, receipt).iter().any(|root| same_path(parent, root));
    }
    managed_location(ctx, path)
}
// A custom root can live on a drive that is currently disconnected. Fail
// before registrations or files are changed so the receipt remains recoverable.
fn ensure_managed_roots_available(ctx: &Context, receipt: Option<&Value>) -> Result<()> {
    let Some(receipt) = receipt.filter(|receipt| receipt["schema"] == 3) else { return Ok(()) };
    for path in receipt_paths(Some(receipt), "packages") {
        if path.exists() { continue; }
        if !owned_package(ctx, Some(receipt), &path) || !managed_location_for(ctx, Some(receipt), &path) { continue; }
        let Some(parent) = path.parent() else { continue };
        if !parent.exists() {
            return Err(error(&parent, "The recorded custom driver folder is unavailable. Reconnect the drive and retry; the installation record was preserved."));
        }
        if !parent.is_dir() { return Err(error(parent, "The recorded custom driver folder is not a directory")); }
        safe_chain(parent)?;
    }
    Ok(())
}
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
        if ![json!(1),json!(2),json!(3)].contains(&v["schema"]) || v["driver"] != DRIVER || !v["packages"].is_array() { return Err("Invalid Galaxy XR installation receipt; preserve for recovery".into()); }
        if !v["packages"].as_array().unwrap().iter().all(Value::is_string) {return Err("Invalid installation package path".into());}
        if v["schema"].as_u64().unwrap_or(0) >= 2 && !v["sourcePaths"].as_array().map(|a|a.iter().all(Value::is_string)).unwrap_or(false) { return Err("Invalid installation source paths".into()); }
        if v["schema"] == 3 {
            let roots=v["managedRoots"].as_array().filter(|a|!a.is_empty() && a.iter().all(Value::is_string))
                .ok_or("Invalid custom installation roots")?;
            if !roots.iter().filter_map(Value::as_str).all(|path|Path::new(path).is_absolute()) { return Err("Invalid custom installation root path".into()); }
            let active=v["activeRoot"].as_str().ok_or("Invalid active installation root")?;
            if !roots.iter().filter_map(Value::as_str).any(|path|same_path(Path::new(path),Path::new(active))) { return Err("Active installation root is not recorded".into()); }
            let created=v["createdRoots"].as_array().filter(|a|a.iter().all(Value::is_string)).ok_or("Invalid created installation roots")?;
            if !created.iter().filter_map(Value::as_str).all(|path|Path::new(path).is_absolute()) { return Err("Invalid created installation root path".into()); }
        }
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
        // Neutral packages can share the old fork's shaders. Only a receipt
        // proves that this installation owns a neutral-name registration.
        let kind = if path.exists() { fork_kind(&path)? } else { None };
        let recorded = contains_path(&receipt_paths(receipt,"packages"), &path)
            || contains_path(&receipt_paths(receipt,"sourcePaths"), &path);
        if path.exists() && (kind == Some(false) || (kind == Some(true) && recorded) || cleanup_pending(receipt, &path)) { owned.push(path); }
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
    validate_source_boundaries_for(ctx,source,&ctx.managed)
}
fn validate_source_boundaries_for(ctx:&Context,source:&Path,managed:&Path)->Result<()> {
    // Config is removed during uninstall; an unpacked bundle must never live
    // inside it (or contain it). Copy destinations also cannot be inside source.
    if contains_directory(&ctx.data,source) || contains_directory(source,&ctx.data) {
        return Err(error(source,"Bundle overlaps the driver configuration directory. Move the bundle outside that directory before installing or uninstalling."));
    }
    if contains_directory(source,managed) {
        return Err(error(source,"Bundle contains the managed installation directory. Move the bundle outside that directory."));
    }
    // A custom destination must not contain the selected source either. The
    // historical default keeps accepting a previously managed copy as source.
    if !same_path(managed,&ctx.managed) && contains_directory(managed,source) {
        return Err(error(source,"Bundle overlaps the managed installation directory. Move the bundle outside that directory."));
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
    (legacy_install_location(ctx,path) && (path.file_name().and_then(|p|p.to_str()).map(|p|p.eq_ignore_ascii_case(DRIVER)).unwrap_or(false)
        || contains_path(&receipt_paths(receipt,"packages"),path)))
        || (receipt.map(|r|r["schema"]==2).unwrap_or(false)
            && managed_location(ctx,path) && contains_path(&receipt_paths(receipt,"packages"),path))
        || (receipt.map(|r|r["schema"]==3).unwrap_or(false)
            && managed_location_for(ctx,receipt,path) && contains_path(&receipt_paths(receipt,"packages"),path))
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
fn default_native_identity(config:&mut Value)->Result<()> {
    let root=config.as_object_mut().ok_or("Driver settings must be an object")?;
    let galaxy=root.entry("galaxyXr").or_insert_with(||json!({})).as_object_mut().ok_or("galaxyXr settings must be an object")?;
    // 2026-09-26: first install defaults On; an upgrade must retain a saved
    // Off. Uninstall removes driver settings, so reinstall gets On again.
    galaxy.entry("nativeIdentity").or_insert(json!(true));
    Ok(())
}

// 2026-10-16: first-install vrlink SteamVR seed. The values mirror the GalaxyXR
// nativeResolution/streamQuality defaults in GalaxyXRDriver/src/Config/Config.h
// (streamQuality "custom": customEncodeWidth, customStreamFormatWidth,
// customBandwidthMbit) and src/Headsets/GalaxyXR.cpp (kGalaxyXrRenderWidth/
// kGalaxyXrRenderHeight, capability min/max = tile width, automatics off),
// so the FIRST stream after a fresh install already has them. They are
// duplicated here because install must run before the driver does; the
// driver's early-apply corrects any later drift on difference
// (SetInt32IfDifferent). Seeding only ever goes through apply_changes so each
// key records a present:false baseline (key absent before install) and
// uninstall removes exactly what install introduced. Never write the settings
// JSON directly for these keys.
const VRLINK_SEED_RENDER_WIDTH: i64 = 3552;
const VRLINK_SEED_RENDER_HEIGHT: i64 = 3840;
const VRLINK_SEED_ENCODE_WIDTH: i64 = 3072;
const VRLINK_SEED_STREAM_FORMAT_WIDTH: i64 = 1536;
const VRLINK_SEED_BANDWIDTH_MBIT: i64 = 350;
const VRLINK_SEED_TUNING_SECTIONS: [&str; 2] = ["driver_vrlink", "vrlink_xrvst2ue"];
const VRLINK_SEED_CAPABILITY_SECTIONS: [&str; 1] = ["vrlink_xrvst2ue"];

fn seed_vrlink_defaults(ctx: &Context) -> Result<()> {
    let tuning: [(&str, Value); 12] = [
        ("renderWidth", json!(VRLINK_SEED_RENDER_WIDTH)), ("renderHeight", json!(VRLINK_SEED_RENDER_HEIGHT)),
        ("overrideRenderWidth", json!(VRLINK_SEED_RENDER_WIDTH)), ("overrideRenderHeight", json!(VRLINK_SEED_RENDER_HEIGHT)),
        ("encodeWidth", json!(VRLINK_SEED_ENCODE_WIDTH)), ("streamFormatWidth", json!(VRLINK_SEED_STREAM_FORMAT_WIDTH)),
        ("automaticStreamFormatWidth", json!(false)), ("automaticBandwidth", json!(false)),
        ("recommendedBandwidthMbit", json!(VRLINK_SEED_BANDWIDTH_MBIT)), ("targetBandwidth", json!(VRLINK_SEED_BANDWIDTH_MBIT)),
        ("debugRegionColoring", json!(false)), ("showAdvancedGraphs", json!(false)),
    ];
    let capability: [(&str, Value); 8] = [
        ("supports10bit", json!(false)),
        // vrlink only creates the /eyetracking component for an unknown model when this
        // key is present; the Galaxy XR client always streams gaze.
        ("supportsEyeTracking", json!(true)),
        ("recommendedRenderWidth", json!(VRLINK_SEED_RENDER_WIDTH)), ("recommendedRenderHeight", json!(VRLINK_SEED_RENDER_HEIGHT)),
        ("minStreamFormatWidth", json!(VRLINK_SEED_STREAM_FORMAT_WIDTH)), ("maxStreamFormatWidth", json!(VRLINK_SEED_STREAM_FORMAT_WIDTH)),
        ("minNonFoveatedStreamFormatWidth", json!(VRLINK_SEED_STREAM_FORMAT_WIDTH)), ("maxNonFoveatedStreamFormatWidth", json!(VRLINK_SEED_STREAM_FORMAT_WIDTH)),
    ];
    let mut changes = Vec::new();
    for &(key, ref value) in tuning.iter() {
        for section in VRLINK_SEED_TUNING_SECTIONS { changes.push(SettingChange { section: section.into(), key: key.into(), present: true, value: value.clone() }); }
    }
    for &(key, ref value) in capability.iter() {
        for section in VRLINK_SEED_CAPABILITY_SECTIONS { changes.push(SettingChange { section: section.into(), key: key.into(), present: true, value: value.clone() }); }
    }
    apply_changes(ctx, changes)
}

#[tauri::command]
pub fn register_galaxyxr_driver(steamvr_path: String, driver_path: String, install_root: Option<String>) -> Result<InstallReport> {
    let _guard = platform::Lock::acquire()?;
    require_stopped()?;
    let ctx = Context::live(steamvr_path)?;
    let install_root = install_root.as_deref().map(str::trim).filter(|root| !root.is_empty()).map(PathBuf::from);
    install_driver_to(&ctx,Path::new(&driver_path),&std::env::current_exe().map_err(|e|e.to_string())?,install_root.as_deref(),|path,add|run_registration(&ctx,path,add))
}
#[cfg(test)]
fn install_driver(ctx:&Context,source:&Path,exe:&Path,register:impl FnMut(&Path,bool)->Result<()>)->Result<InstallReport> {
    install_driver_to(ctx,source,exe,None,register)
}
fn install_driver_to(ctx:&Context,source:&Path,exe:&Path,install_root:Option<&Path>,mut register:impl FnMut(&Path,bool)->Result<()>)->Result<InstallReport> {
    let source=validate_package(source,exe)?;
    let managed=match install_root { Some(root)=>validate_managed_root(ctx,root,&source)?, None=>ctx.managed.clone() };
    let custom=!same_path(&managed,&ctx.managed);
    validate_source_boundaries_for(ctx,&source,&managed)?;
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
    // 2026-10-16: the vrlink defaults are seeded only on a pristine first
    // install: no GUI settings.json, and no prior-install evidence (receipt,
    // journal, or legacy/previous packages) that existing user tuning could
    // be present on either side. Those non-pristine states self-heal at the
    // driver's first SteamVR start (early-apply writes on difference).
    // Capture this before any data-dir write (receipt/config) can create
    // the file.
    let fresh_install=!config_path.exists() && receipt.is_none() && !ctx.journal().exists() && !legacy;
    let mut config=read_settings(&config_path)?;
    if legacy && journal.get("legacyKeys").is_none() {
        record_legacy_keys(&mut journal,&read_settings(&ctx.settings)?,&config,previous.iter().any(|p|fork_kind(p).ok().flatten()==Some(true)))?;
    }
    default_native_identity(&mut config)?;
    let snapshots=[ctx.settings.clone(),ctx.journal(),config_path.clone(),ctx.receipt()].into_iter()
        .map(|path|snapshot_file(&path).map(|bytes|(path,bytes))).collect::<Result<Vec<_>>>()?;
    let stamp=SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e|e.to_string())?.as_nanos();
    let path=managed.join(format!("GalaxyXRNative-{stamp}"));
    let staging=managed.join(format!("GalaxyXRNative-{stamp}.stage"));
    safe_chain(&path)?; safe_chain(&staging)?;
    if path.exists() || staging.exists() { return Err("Installation destination already exists".into()); }
    let created_dirs=plan_created_dirs(&managed)?;
    let schema3=custom || receipt.as_ref().map(|r|r["schema"]==3).unwrap_or(false);
    let mut managed_roots=receipt_managed_roots(ctx,receipt.as_ref());
    push_path(&mut managed_roots,managed.clone());
    let mut created_roots=receipt_created_roots(receipt.as_ref());
    for dir in &created_dirs { push_path(&mut created_roots,dir.clone()); }
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
    let make_receipt=|receipt_packages:&[PathBuf],cleanup:Option<&[PathBuf]>| {
        let mut receipt=json!({"schema":if schema3 {3} else {2},"driver":DRIVER,"packages":receipt_packages,
            "sourcePaths":sources,"legacyDetected":legacy,"retirements":retirements});
        if schema3 {
            receipt["managedRoots"]=json!(managed_roots);
            receipt["activeRoot"]=json!(managed);
            receipt["createdRoots"]=json!(created_roots);
        }
        if let Some(cleanup)=cleanup { receipt["cleanupPending"]=json!(cleanup); }
        receipt
    };
    let attempt_receipt=make_receipt(&attempt_packages,Some(&[path.clone(),staging.clone()]));
    // Write ownership before copying; interrupted copies remain safely recoverable.
    atomic_json(&ctx.receipt(),&attempt_receipt)?;
    let install=(|| {
        atomic_json(&ctx.journal(),&journal)?;
        fs::create_dir_all(&managed).map_err(|e|error(&managed,e))?;
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
        // Second apply_changes: on a first install, seed the vrlink defaults
        // (see seed_vrlink_defaults); a failure here aborts and rolls back
        // the whole install transaction.
        if fresh_install { seed_vrlink_defaults(ctx)?; }
        atomic_json(&ctx.receipt(),&make_receipt(&packages,None))
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
        if custom {
            // A failed custom install must not strand empty directories that
            // the user did not have before. Non-empty directories are kept.
            for dir in created_dirs.iter().rev() {
                if dir.exists() && fs::read_dir(dir).map(|mut entries|entries.next().is_none()).unwrap_or(false) {
                    let _ = fs::remove_dir(dir);
                }
            }
        }
        if errors.len()==1 {
            let (_,bytes)=snapshots.last().unwrap();
            if let Err(e)=restore_file(&ctx.receipt(),bytes) { errors.push(format!("ROLLBACK receipt: {e}")); }
        }
        cleanup_retirement_parents(ctx,&packages,&mut errors);
        return Err(errors.join("; "));
    }
    Ok(InstallReport { registered_path:path.to_string_lossy().into_owned(),managed_root:managed.to_string_lossy().into_owned(),used_default_root:!custom,legacy_detected:legacy })
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
    // Older legacyKeys markers were inferred from generic names. Revalidate
    // their original values as a complete Galaxy XR identity before deletion.
    let mut baseline = json!({});
    for (section, entries) in journal["entries"].as_object().ok_or("Invalid journal entries")? {
        for (key, entry) in entries.as_object().ok_or("Invalid journal section")? {
            if entry["present"] == true { baseline[section][key] = entry["value"].clone(); }
        }
    }
    let mut verified = IdentityCleanupReport { removed_keys: vec![], removed_sections: vec![], warnings: vec![], backup_path: None };
    plan_identity_cleanup(&mut baseline, None, &mut verified)?;
    for (section, entries) in journal["entries"].as_object().ok_or("Invalid journal entries")? {
        for (key, entry) in entries.as_object().ok_or("Invalid journal section")? {
            let current = settings.get(section).and_then(|s| s.get(key)).cloned();
            let last = entry["lastPresent"].as_bool().ok_or("Invalid journal entry")?.then(|| entry["lastValue"].clone());
            let baseline = entry["present"].as_bool().ok_or("Invalid journal entry")?.then(|| entry["value"].clone());
            let legacy_key=journal["legacyKeys"][section][key]==true && verified.removed_keys.contains(&format!("{section}.{key}"));
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
    // 2026-09-26: generic key names and common values (including 90 Hz) are
    // not ownership evidence. Only the Galaxy XR identity fingerprint is
    // strong enough for cleanup without a recorded write.
    let mut report = IdentityCleanupReport { removed_keys: vec![], removed_sections: vec![], warnings: vec![], backup_path: None };
    plan_identity_cleanup(settings, Some(journal), &mut report)?;
    Ok(report.removed_keys.len())
}

fn legacy_config_reset(settings:&mut Value,journal:&Value,config:&Value,_legacy_fork:bool,warnings:&mut Vec<String>) -> Result<usize> {
    if let Some(extra)=config["galaxyXr"]["vrlinkExtraKeys"].as_object() {
        for section in std::iter::once("driver_vrlink").chain(COMPANION_PROFILE_SECTIONS.iter().copied()) {
            for key in extra.keys() {
                if journal["entries"][section].get(key).is_none() && settings[section].get(key).is_some() {
                    warnings.push(format!("Preserved unrecorded historical setting {section}.{key}: its original value and ownership cannot be verified."));
                }
            }
        }
    }
    Ok(0)
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
    let mut recovery=previous.unwrap_or_else(||json!({"schema":2,"driver":DRIVER}));
    if recovery["schema"] != 3 { recovery=json!({"schema":2,"driver":DRIVER}); }
    recovery["packages"]=json!(recovery_paths);
    recovery["sourcePaths"]=json!(sources);
    recovery["legacyDetected"]=json!(legacy);
    recovery["cleanupPending"]=json!(recovery_paths);
    recovery["staged"]=json!(planned);
    // Write ahead of registration, rename, and settings operations. Even a
    // pre-commit rollback failure or process interruption remains discoverable.
    atomic_json(&ctx.receipt(),&recovery)?;
    Ok((planned,recovery))
}

#[tauri::command]
pub fn uninstall_galaxyxr_driver(steamvr_path: Option<String>) -> Result<UninstallReport> {
    let _guard = platform::Lock::acquire()?;
    require_stopped()?;
    let Some(steamvr_path) = steamvr_path.filter(|p| !p.trim().is_empty()) else {
        let data = PathBuf::from(std::env::var_os("APPDATA").ok_or("APPDATA unavailable")?).join("GalaxyXR/CustomHeadset");
        let managed = PathBuf::from(std::env::var_os("LOCALAPPDATA").ok_or("LOCALAPPDATA unavailable")?).join("GalaxyXR/Drivers");
        return uninstall_local_settings(&data, &managed);
    };
    let ctx = Context::live(steamvr_path)?;
    uninstall_driver(&ctx,&std::env::current_exe().map_err(|e|e.to_string())?,|path,add|run_registration(&ctx,path,add))
}

/// Paths a settings-only reset leaves alone. Uninstall removes the whole
/// driver data tree, so it reports only source bundles and foreign
/// registrations as preserved.
fn preserved_data_paths(data: &Path) -> Vec<String> {
    [Some(data.join("Distortion")), data.parent().map(|p|p.join("Backups"))].into_iter().flatten()
        .filter(|p|p.exists()).map(|p|p.to_string_lossy().into_owned()).collect()
}

/// Deletes every entry under the driver data root, including named distortion
/// profiles and the Distortion directory itself, so an uninstall leaves no
/// `CustomHeadset` tree behind. The root goes too once it is empty.
fn remove_driver_data(data: &Path, removed: &mut Vec<String>) -> Result<()> {
    if !data.exists() { return Ok(()); }
    safe_tree(data)?;
    for entry in fs::read_dir(data).map_err(|e|error(data,e))? {
        let entry = entry.map_err(|e|error(data,e))?;
        let path = entry.path();
        let result = if entry.file_type().map_err(|e|error(&path,e))?.is_dir() { fs::remove_dir_all(&path) } else { fs::remove_file(&path) };
        result.map_err(|e|error(&path,e))?;
        removed.push(path.to_string_lossy().into_owned());
    }
    if fs::read_dir(data).map_err(|e|error(data,e))?.next().is_none() {
        fs::remove_dir(data).map_err(|e|error(data,e))?;
        removed.push(data.to_string_lossy().into_owned());
    }
    Ok(())
}

/// `gxr_au_dump.bin` locations written by the driver's AU diagnostic path
/// (NvencTap.cpp:1802-1808): `%TEMP%`, or `%USERPROFILE%\AppData\Local\Temp`
/// when TEMP is missing.
fn uninstall_dump_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let temp = std::env::var_os("TEMP").filter(|temp| !temp.is_empty()).map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    push_path(&mut paths, temp.join("gxr_au_dump.bin"));
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        push_path(&mut paths, PathBuf::from(profile).join("AppData/Local/Temp/gxr_au_dump.bin"));
    }
    paths
}

/// Removes `steamvr.vrsettings.galaxyxr-identity-backup-*.json` files written
/// beside SteamVR settings by identity cleanup. Other files are untouched.
fn remove_identity_backups(parent: &Path, removed: &mut Vec<String>) -> Result<()> {
    const PREFIX: &str = "steamvr.vrsettings.galaxyxr-identity-backup-";
    let entries = match fs::read_dir(parent) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(error(parent, e)),
    };
    for entry in entries {
        let entry = entry.map_err(|e| error(parent, e))?;
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        if !name.starts_with(PREFIX) || !name.ends_with(".json") { continue; }
        let path = entry.path();
        if !entry.file_type().map_err(|e| error(&path, e))?.is_file() { continue; }
        safe_chain(&path)?;
        fs::remove_file(&path).map_err(|e| error(&path, e))?;
        removed.push(path.to_string_lossy().into_owned());
    }
    Ok(())
}

/// Removes a directory only when it is already empty; a non-empty directory is
/// left for the user (or another manager) and is not an error.
fn remove_empty_directory(path: Option<&Path>, removed: &mut Vec<String>) -> Result<()> {
    let Some(path) = path.filter(|p| !p.as_os_str().is_empty()) else { return Ok(()) };
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => (),
        Ok(_) => return Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(error(path, e)),
    }
    safe_chain(path)?;
    if fs::read_dir(path).map_err(|e| error(path, e))?.next().is_some() { return Ok(()); }
    fs::remove_dir(path).map_err(|e| error(path, e))?;
    removed.push(path.to_string_lossy().into_owned());
    Ok(())
}

/// Post-commit uninstall cleanup for state this app owns outside the driver
/// data tree: the profile backup tree, AU dumps, identity backups beside
/// SteamVR settings and the Companion's OFXR registration/INI state. Any error
/// makes the caller report an incomplete uninstall so the user can retry.
fn cleanup_uninstall_residue_at(data: &Path, managed: &Path, settings: Option<&Path>, dumps: &[PathBuf], ofxr_cleanup: &mut dyn FnMut() -> Result<()>) -> Result<Vec<String>> {
    let mut removed = Vec::new();
    if let Some(backups) = data.parent().filter(|p| !p.as_os_str().is_empty()).map(|p| p.join("Backups")) {
        match fs::symlink_metadata(&backups) {
            Ok(meta) if meta.is_dir() => {
                safe_tree(&backups)?;
                fs::remove_dir_all(&backups).map_err(|e| error(&backups, e))?;
                removed.push(backups.to_string_lossy().into_owned());
            }
            Ok(_) => return Err(error(&backups, "Backups path is not a directory")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(error(&backups, e)),
        }
    }
    for dump in dumps {
        safe_chain(dump)?;
        match fs::remove_file(dump) {
            Ok(()) => removed.push(dump.to_string_lossy().into_owned()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(error(dump, e)),
        }
    }
    if let Some(parent) = settings.and_then(Path::parent) {
        remove_identity_backups(parent, &mut removed)?;
    }
    ofxr_cleanup()?;
    remove_empty_directory(data.parent(), &mut removed)?;
    remove_empty_directory(managed.parent(), &mut removed)?;
    Ok(removed)
}

// Unit tests never touch live per-user state: no %TEMP% dump or OpenXR
// registry/INI is removed by a fixture uninstall. Tests that exercise residue
// pass explicit paths and a recording closure to cleanup_uninstall_residue_at.
#[cfg(test)]
fn uninstall_residue_dumps() -> Vec<PathBuf> { Vec::new() }
#[cfg(not(test))]
fn uninstall_residue_dumps() -> Vec<PathBuf> { uninstall_dump_paths() }

#[cfg(test)]
fn ofxr_cleanup_for_uninstall() -> Result<()> { Ok(()) }
#[cfg(not(test))]
fn ofxr_cleanup_for_uninstall() -> Result<()> {
    // Startup ownership lives in HKCU, outside the removed driver-data tree.
    // A conflict keeps its receipt and makes uninstall retryable.
    cleanup_companion_integrations(
        || crate::windows_startup::cleanup_companion_startup("galaxyxr"),
        || crate::ofxr::cleanup_companion_state(),
    )
}

fn cleanup_companion_integrations(startup: impl FnOnce() -> Result<()>, ofxr: impl FnOnce() -> Result<()>) -> Result<()> {
    let mut errors = Vec::new();
    if let Err(error) = startup() { errors.push(format!("Companion Windows startup: {error}")); }
    if let Err(error) = ofxr() { errors.push(format!("OFXR companion state: {error}")); }
    if errors.is_empty() { Ok(()) } else { Err(errors.join("; ")) }
}

fn cleanup_uninstall_residue(ctx: &Context) -> Result<Vec<String>> {
    cleanup_uninstall_residue_at(&ctx.data, &ctx.managed, Some(&ctx.settings), &uninstall_residue_dumps(), &mut || ofxr_cleanup_for_uninstall())
}

fn steamvr_settings_from_paths() -> Option<PathBuf> {
    let paths_file = PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join("openvr/openvrpaths.vrpath");
    let paths = read_json(&paths_file).ok()?;
    let config = paths["config"].as_array()?.first()?.as_str()?;
    Some(PathBuf::from(config).join("steamvr.vrsettings"))
}

fn uninstall_local_settings(data: &Path, managed: &Path) -> Result<UninstallReport> {
    safe_chain(data)?; safe_chain(managed)?;
    if data.join("steamvr-changes.json").exists() || data.join("installation.json").exists()
        || data.join("info.json").exists() || (managed.exists() && fs::read_dir(managed).map_err(|e|error(managed,e))?.next().is_some()) {
        return Err("SteamVR cannot be located, but installation or recovery records remain. Locate SteamVR and retry; recovery records and settings were preserved.".into());
    }
    // SteamVR is missing, so no source bundle or registration is preserved;
    // the local driver data, backups and residue are all owned by uninstall.
    let preserved_paths = vec![];
    let mut removed_paths = vec![];
    let settings = steamvr_settings_from_paths();
    let result = remove_driver_data(data, &mut removed_paths)
        .and_then(|()| cleanup_uninstall_residue_at(data, managed, settings.as_deref(), &uninstall_residue_dumps(), &mut || ofxr_cleanup_for_uninstall()))
        .map(|mut residue| removed_paths.append(&mut residue));
    let mut unresolved_items = vec!["SteamVR could not be located. Driver registration and historical SteamVR changes could not be verified.".into()];
    if let Err(error) = &result { unresolved_items.push(format!("Local settings removal is incomplete: {error}. Retry Uninstall.")); }
    Ok(UninstallReport { outcome:if result.is_ok() { "attention-required" } else { "incomplete" }, preserved_paths, warnings:unresolved_items.clone(), unresolved_items,
        removed_paths, restored_settings:0, legacy_reset:false })
}

fn uninstall_driver(ctx:&Context,exe:&Path,mut register:impl FnMut(&Path,bool)->Result<()>)->Result<UninstallReport> {
    let receipt = ctx.receipt_value()?;
    ensure_managed_roots_available(ctx,receipt.as_ref())?;
    let journal_existed = ctx.journal().exists();
    if journal_existed && !ctx.settings.is_file() { return Err("The recorded SteamVR settings file is missing. Restore or locate it before uninstalling; recovery records were preserved.".into()); }
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
        } else if receipt.as_ref().map(|r|r["schema"] == 2).unwrap_or(false)
            && managed_location(ctx,path) && contains_path(&receipt_paths(receipt.as_ref(),"packages"),path) {
            // 2026-09-26: a damaged owned installation still needs removal.
            // Its exact managed receipt plus unchanged manifest proves identity;
            // a runnable DLL is an install prerequisite, not an uninstall one.
            let checked=validate_package_path(path,exe)?;
            if fork_kind(&checked)? != Some(false) { return Err(error(&checked,"Recorded package identity changed; refusing deletion")); }
            packages.push(checked);
        } else { packages.push(validate_package(&path, &exe)?); }
    }
    safe_tree(&ctx.data)?;
    let original_settings_bytes = snapshot_file(&ctx.settings)?;
    let original_settings = match &original_settings_bytes {
        Some(bytes) => parse_json_bytes(&ctx.settings, bytes)?,
        None => json!({}),
    };
    if !original_settings.is_object() { return Err(error(&ctx.settings,"Expected JSON object")); }
    let mut settings = original_settings.clone();
    let mut warnings = vec![];
    let legacy = journal["legacy"].as_bool().unwrap_or(false) || receipt.as_ref().and_then(|r| r["legacyDetected"].as_bool()).unwrap_or(false) || (!journal_existed && (!candidates.is_empty() || settings.get("driver_GalaxyXRNative").is_some()));
    let legacy_fork=candidates.iter().any(|p|fork_kind(p).ok().flatten()==Some(true));
    let config=if legacy && ctx.data.join("settings.json").exists() {read_json(&ctx.data.join("settings.json"))?}else{json!({})};
    if legacy && journal.get("legacyKeys").is_none() {record_legacy_keys(&mut journal,&settings,&config,legacy_fork)?;}
    let mut restored = restore_settings(&mut settings, &journal, &mut warnings)?;
    // 2026-09-26: older identity residue may coexist with a modern journal.
    // Keep recorded originals protected after restore, and remove only the
    // untracked Galaxy XR fingerprint. External changes are reported above;
    // protected originals need no standalone cleanup advice during uninstall.
    let historical_removed = legacy_reset(&mut settings, &journal)?;
    restored += historical_removed;
    if legacy {
        restored += legacy_config_reset(&mut settings,&journal,&config,legacy_fork,&mut warnings)?;
        warnings.push("Historical installation: only verified Galaxy XR identity settings were removed. Unrecorded shared settings were preserved because their original values cannot be reconstructed.".into());
    }
    // Status markers belong to this driver only when its installation is proved.
    if let Some(section) = settings.get_mut("driver_GalaxyXRNative").and_then(Value::as_object_mut) {
        for key in ["enable", "blocked_by_safe_mode", "hasBeenRun"] {
            if (receipt.is_some() || !candidates.is_empty()) && journal["entries"]["driver_GalaxyXRNative"].get(key).is_none() { section.remove(key); }
        }
        if section.is_empty() && (legacy || journal["sectionPresence"]["driver_GalaxyXRNative"] != true) { settings.as_object_mut().unwrap().remove("driver_GalaxyXRNative"); }
    }
    let registered = ctx.registrations()?;
    let mut preserved_neutral = vec![];
    for path in &registered {
        if fork_kind(path)? == Some(true) && !contains_path(&registration_paths,path) { preserved_neutral.push(path.clone()); }
    }
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
        if snapshot_file(&ctx.settings)? != original_settings_bytes {
            return Err("SteamVR settings changed during uninstall. The external edit was preserved; retry after closing other settings editors.".into());
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
    let mut report = UninstallReport { outcome: "complete", preserved_paths: vec![],
        unresolved_items: vec![], removed_paths: vec![], restored_settings: restored, legacy_reset: legacy || historical_removed > 0, warnings };
    for source in sources.iter().filter(|p|p.exists()) { report.preserved_paths.push(source.to_string_lossy().into_owned()); }
    for path in preserved_neutral {
        report.preserved_paths.push(path.to_string_lossy().into_owned());
        report.warnings.push(format!("Preserved neutral driver {}: no installation ownership record.", path.display()));
    }
    let cleanup: Result<()> = (|| {
        for (original, tombstone) in &staged {
            fs::remove_dir_all(tombstone).map_err(|e|error(tombstone,e))?;
            report.removed_paths.push(original.to_string_lossy().into_owned());
        }
        let mut retirement_paths=packages.clone();
        if let Some(receipt)=&receipt {
            for path in receipt_paths(Some(receipt),"packages") { push_path(&mut retirement_paths,path); }
        }
        cleanup_retirement_parents(&ctx,&retirement_paths,&mut report.warnings);
        if ctx.managed.exists() && fs::read_dir(&ctx.managed).map(|mut d|d.next().is_none()).unwrap_or(false) {
            safe_chain(&ctx.managed)?;
            fs::remove_dir(&ctx.managed).map_err(|e|error(&ctx.managed,e))?;
        }
        remove_driver_data(&ctx.data, &mut report.removed_paths)?;
        report.removed_paths.extend(cleanup_uninstall_residue(&ctx)?);
        // Remove only empty roots the installer created for a custom location.
        // A folder the user selected and already owned is never removed.
        for root in receipt_created_roots(receipt.as_ref()).iter().rev() {
            remove_empty_directory(Some(root), &mut report.removed_paths)?;
        }
        Ok(())
    })();
    if let Err(e) = cleanup {
        // Registration/settings have committed. Keep recovery evidence and
        // report partial removal so the GUI never resumes stale settings writes.
        report.outcome = "incomplete";
        report.unresolved_items.push(format!("Removal is incomplete: {e}. Retry Uninstall to finish."));
        // Recovery records only make sense while the data tree still exists.
        // Recreating them after a complete data removal would leave a journal
        // without its SteamVR settings file and block the retry.
        if ctx.data.exists() {
            if let Err(e)=atomic_json(&ctx.journal(),&journal) { report.unresolved_items.push(format!("Recovery journal save failed: {e}")); }
            if let Err(e)=atomic_json(&ctx.receipt(),&recovery_receipt) { report.unresolved_items.push(format!("Recovery receipt save failed: {e}")); }
            report.preserved_paths.push(ctx.data.to_string_lossy().into_owned());
        }
    } else if !report.warnings.is_empty() { report.outcome = "attention-required"; }
    report.unresolved_items.extend(report.warnings.iter().cloned());
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_cleanup_conflict_never_skips_ofxr_shutdown() {
        let mut stopped = false;
        let result = cleanup_companion_integrations(
            || Err("Run entry changed externally".into()),
            || { stopped = true; Err("OpenXR registration busy".into()) },
        );
        assert!(stopped);
        let error = result.unwrap_err();
        assert!(error.contains("Run entry changed externally"));
        assert!(error.contains("OpenXR registration busy"));
        assert!(cleanup_companion_integrations(|| Ok(()), || Ok(())).is_ok());
    }
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
    fn modern_uninstall_cleans_untracked_identity_but_preserves_recorded_originals() {
        let f=Fixture::new();let source=f.package("bundle/GalaxyXRNative");let exe=f.root.join("gui.exe");
        let original=legacy_identity();
        atomic_json(&f.ctx.settings,&json!({"vrlink_Oculus Quest Pro":original,"vrlink_xrvst2":{}})).unwrap();
        // 2026-10-16: an existing GUI settings.json suppresses the fresh-install
        // vrlink default seed, keeping this scenario focused on identity
        // restore; seeded defaults would otherwise collide with the settings
        // rewrite below as unrecorded external changes.
        atomic_json(&f.ctx.data.join("settings.json"),&json!({})).unwrap();
        install_driver(&f.ctx,&source,&exe,|p,a|fake_registration(&f.ctx,p,a)).unwrap();
        let mut changes=original.as_object().unwrap().keys()
            .map(|key|change("vrlink_Oculus Quest Pro",key,None)).collect::<Vec<_>>();
        changes.push(change("vrlink_xrvst2","resourceRoot",Some(json!(DRIVER))));
        apply_changes(&f.ctx,changes).unwrap();
        assert_eq!(load_journal(&f.ctx).unwrap()["legacy"],false);
        assert_eq!(f.ctx.receipt_value().unwrap().unwrap()["legacyDetected"],false);
        let mut settings=read_settings(&f.ctx.settings).unwrap();
        settings["vrlink_PICO 4 Pro"]=legacy_identity();
        settings["vrlink_PICO 4 Pro"]["supports10bit"]=json!(true);
        settings["vrlink_PICO 4 Pro"]["targetBandwidth"]=json!(80);
        settings["vrlink_Galaxy XR"]=json!({"enable":true,"supportsEyeTracking":true,"preferredRefreshRate":90});
        atomic_json(&f.ctx.settings,&settings).unwrap();
        let report=uninstall_driver(&f.ctx,&exe,|p,a|fake_registration(&f.ctx,p,a)).unwrap();
        assert!(report.legacy_reset);assert_eq!(report.outcome,"complete");assert!(report.warnings.is_empty());
        assert_eq!(read_settings(&f.ctx.settings).unwrap(),json!({"vrlink_Oculus Quest Pro":original,"vrlink_xrvst2":{},
            "vrlink_PICO 4 Pro":{"supports10bit":true,"targetBandwidth":80},
            "vrlink_Galaxy XR":{"enable":true,"supportsEyeTracking":true,"preferredRefreshRate":90}}));
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
        assert_eq!(config,json!({"other":17,"galaxyXr":{"nativeIdentity":false,"bandwidth":123}}));
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
        assert_eq!(read_json(&f.ctx.data.join("settings.json")).unwrap(),json!({"galaxyXr":{"nativeIdentity":true}}));
    }
    #[test]
    fn direct_upgrade_preserves_all_saved_settings() {
        let f=Fixture::new();let source=f.package("bundle/GalaxyXRNative");let exe=f.root.join("gui.exe");
        install_driver(&f.ctx,&source,&exe,|p,a|fake_registration(&f.ctx,p,a)).unwrap();
        let choices=json!({"galaxyXr":{"nativeIdentity":false,"nativeResolution":false,
            "vrlinkHeadsetProfile":false,"streamQuality":"custom","customStreamFormatWidth":1856,
            "vrlinkExtraKeys":{"targetBandwidth":{"i":125}}},
            "streamFrame":{"nvencSettingsVersion":4,"nvencTap":false,"nvencPreset":3,
                "nvencVbvFrames":3.5,"hitchDiag":false},"unknownFutureSetting":{"keep":17}});
        atomic_json(&f.ctx.data.join("settings.json"),&choices).unwrap();
        install_driver(&f.ctx,&source,&exe,|p,a|fake_registration(&f.ctx,p,a)).unwrap();
        assert_eq!(read_json(&f.ctx.data.join("settings.json")).unwrap(),choices);
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
    fn fresh_install_seeds_vrlink_defaults_with_absent_baselines() {
        let f=Fixture::new();let source=f.package("bundle/GalaxyXRNative");let exe=f.root.join("gui.exe");
        install_driver(&f.ctx,&source,&exe,|p,a|fake_registration(&f.ctx,p,a)).unwrap();
        let settings=read_settings(&f.ctx.settings).unwrap();
        for (key,value) in [("renderWidth",json!(3552)),("overrideRenderHeight",json!(3840)),("encodeWidth",json!(3072)),
            ("streamFormatWidth",json!(1536)),("automaticBandwidth",json!(false)),("targetBandwidth",json!(350))] {
            assert_eq!(settings["driver_vrlink"][key],value,"driver_vrlink.{key}");
        }
        for section in VRLINK_SEED_TUNING_SECTIONS { assert_eq!(settings[section]["renderWidth"],3552,"{section}.renderWidth"); }
        assert_eq!(settings["vrlink_xrvst2ue"]["supports10bit"],false);
        assert_eq!(settings["vrlink_xrvst2ue"]["maxStreamFormatWidth"],1536);
        for section in VRLINK_SEED_CAPABILITY_SECTIONS { assert_eq!(settings[section]["minStreamFormatWidth"],1536,"{section}.minStreamFormatWidth"); }
        assert!(settings.get("vrlink_Oculus Quest Pro").is_none(),"alias section not seeded");
        assert!(settings.get("vrlink_PICO 4 Pro").is_none(),"alias section not seeded");
        let journal=load_journal(&f.ctx).unwrap();
        assert_eq!(journal["entries"]["driver_vrlink"]["renderWidth"]["present"],false);
        assert_eq!(journal["entries"]["driver_vrlink"]["renderWidth"]["lastValue"],3552);
        assert_eq!(journal["entries"]["vrlink_xrvst2ue"]["supports10bit"]["present"],false);
        assert_eq!(journal["entries"]["vrlink_xrvst2ue"]["maxStreamFormatWidth"]["present"],false);
        assert_eq!(journal["entries"]["vrlink_xrvst2ue"]["targetBandwidth"]["lastPresent"],true);
    }
    #[test]
    fn existing_settings_json_suppresses_install_vrlink_seeding() {
        let f=Fixture::new();let source=f.package("bundle/GalaxyXRNative");let exe=f.root.join("gui.exe");
        atomic_json(&f.ctx.data.join("settings.json"),&json!({"other":17})).unwrap();
        install_driver(&f.ctx,&source,&exe,|p,a|fake_registration(&f.ctx,p,a)).unwrap();
        let settings=read_settings(&f.ctx.settings).unwrap();
        assert!(settings.get("driver_vrlink").is_none());
        for section in VRLINK_SEED_TUNING_SECTIONS { assert!(settings.get(section).is_none(),"{section}"); }
        assert_eq!(settings["driver_GalaxyXRNative"]["enable"],true);
    }
    #[test]
    fn prior_journal_evidence_suppresses_install_vrlink_seeding() {
        // 2026-10-16: a missing GUI settings.json with a surviving installation
        // journal means prior-install evidence on the machine; user tuning may
        // exist on either side, so the fresh-install seed must not run.
        let f=Fixture::new();let source=f.package("bundle/GalaxyXRNative");let exe=f.root.join("gui.exe");
        atomic_json(&f.ctx.journal(),&json!({"schema":1,"driver":DRIVER,"settingsPath":f.ctx.settings,"legacy":false,"sectionPresence":{},"entries":{}})).unwrap();
        install_driver(&f.ctx,&source,&exe,|p,a|fake_registration(&f.ctx,p,a)).unwrap();
        let settings=read_settings(&f.ctx.settings).unwrap();
        assert!(settings.get("driver_vrlink").is_none());
        for section in VRLINK_SEED_TUNING_SECTIONS { assert!(settings.get(section).is_none(),"{section}"); }
        assert_eq!(settings["driver_GalaxyXRNative"]["enable"],true);
    }
    #[test]
    fn uninstall_removes_fresh_install_seeded_vrlink_keys() {
        let f=Fixture::new();let source=f.package("bundle/GalaxyXRNative");let exe=f.root.join("gui.exe");
        install_driver(&f.ctx,&source,&exe,|p,a|fake_registration(&f.ctx,p,a)).unwrap();
        let report=uninstall_driver(&f.ctx,&exe,|p,a|fake_registration(&f.ctx,p,a)).unwrap();
        assert_eq!(report.outcome,"complete");assert!(report.warnings.is_empty());
        let settings=read_settings(&f.ctx.settings).unwrap();
        for section in VRLINK_SEED_TUNING_SECTIONS { assert!(settings.get(section).is_none(),"{section}"); }
        assert_eq!(settings,json!({}));
    }
    #[test]
    fn legacy_encoder_extras_need_recorded_ownership_not_just_matching_values() {
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
        assert_eq!(restored,0);assert!(!warnings.is_empty());
        for section in std::iter::once("driver_vrlink").chain(COMPANION_PROFILE_SECTIONS.iter().copied()) {
            assert_eq!(settings[section]["encoderExtra"],12);
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
    fn legacy_custom_settings_and_neutral_markers_need_recorded_ownership() {
        let mut settings=json!({"driver_vrlink":{"custom":12,"changed":99,"journaled":7},"driver_CustomHeadsetOpenVR":{"enable":false,"other":42}});
        let journal=json!({"entries":{"driver_vrlink":{"journaled":{}}}});
        let config=json!({"galaxyXr":{"vrlinkExtraKeys":{"custom":{"i":12},"changed":5,"journaled":7}}});
        let mut warnings=vec![];
        assert_eq!(legacy_config_reset(&mut settings,&journal,&config,true,&mut warnings).unwrap(),0);
        assert_eq!(settings,json!({"driver_vrlink":{"custom":12,"changed":99,"journaled":7},"driver_CustomHeadsetOpenVR":{"enable":false,"other":42}}));
        assert_eq!(warnings.len(),2);
    }
    #[test]
    fn upgrade_preserves_unproven_baseline_overrides_after_new_journaled_change() {
        let f=Fixture::new();atomic_json(&f.ctx.settings,&json!({"driver_vrlink":{"targetBandwidth":200,"enableHandTracking":true}})).unwrap();
        apply_changes(&f.ctx,vec![change("driver_vrlink","targetBandwidth",Some(json!(300)))]).unwrap();
        let mut journal=load_journal(&f.ctx).unwrap();journal["legacy"]=json!(true);
        let mut settings=read_settings(&f.ctx.settings).unwrap();record_legacy_keys(&mut journal,&settings,&json!({}),false).unwrap();
        restore_settings(&mut settings,&journal,&mut vec![]).unwrap();legacy_reset(&mut settings,&journal).unwrap();
        assert_eq!(settings,json!({"driver_vrlink":{"targetBandwidth":200,"enableHandTracking":true}}));
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
        assert_eq!(settings,json!({"driver_GalaxyXRNative":{"enable":true},"driver_vrlink":{"targetBandwidth":75,"encodeWidth":4096,"enableHandTracking":true,"shareEyeTracking":true},"driver_other":{"enable":true}}));
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
    fn uninstall_removes_app_preferences_and_driver_data() {
        let f=Fixture::new();let source=f.package("bundle/GalaxyXRNative");let exe=f.root.join("bundle/GalaxyXRDriverGUI/gui.exe");
        atomic_json(&f.ctx.data.join("settings.json"),&json!({"other":17})).unwrap();
        atomic_json(&f.ctx.data.join("gui-settings.json"),&json!({"colorScheme":"light","updateMode":"rewrite","advanceMode":true})).unwrap();
        let installed=install_driver(&f.ctx,&source,&exe,|p,a|fake_registration(&f.ctx,p,a)).unwrap();
        assert!(Path::new(&installed.registered_path).join("driver.vrdrivermanifest").exists());
        uninstall_driver(&f.ctx,&exe,|p,a|fake_registration(&f.ctx,p,a)).unwrap();
        assert!(!Path::new(&installed.registered_path).exists());
        assert!(!f.ctx.data.join("settings.json").exists());
        assert!(!f.ctx.data.join("gui-settings.json").exists());
        assert!(source.exists());
    }

    #[test]
    fn uninstall_removes_profiles_backups_and_same_version_reinstall_uses_defaults() {
        let f=Fixture::new();let source=f.package("bundle/GalaxyXRNative");let exe=f.root.join("bundle/gui.exe");
        let profile=f.ctx.data.join("Distortion/custom.json");let backup=f.ctx.data.parent().unwrap().join("Backups/old/settings.before");
        atomic_bytes(&profile,b"saved profile bytes").unwrap();atomic_bytes(&backup,b"saved backup bytes").unwrap();
        atomic_json(&f.ctx.data.join("settings.json"),&json!({"galaxyXr":{"nativeIdentity":false},"streamFrame":{"nvencTap":false},"distortionProfile":"custom"})).unwrap();
        let installed=install_driver(&f.ctx,&source,&exe,|p,a|fake_registration(&f.ctx,p,a)).unwrap();
        let report=uninstall_driver(&f.ctx,&exe,|p,a|fake_registration(&f.ctx,p,a)).unwrap();
        assert_ne!(report.outcome,"incomplete");assert!(!Path::new(&installed.registered_path).exists());
        // Uninstall owns the whole data tree: named profiles and backups go,
        // and only source bundles remain preserved.
        assert!(!profile.exists());assert!(!f.ctx.data.join("Distortion").exists());
        assert!(!backup.exists());assert!(!f.ctx.data.parent().unwrap().join("Backups").exists());
        assert!(!f.ctx.data.exists());assert!(!f.ctx.data.parent().unwrap().exists());
        assert!(report.preserved_paths.iter().any(|p|same_path(Path::new(p),&source)));
        assert!(!report.preserved_paths.iter().any(|p|p.contains("Distortion")||p.contains("Backups")));
        assert!(!f.ctx.data.join("settings.json").exists());assert!(!f.ctx.journal().exists());assert!(!f.ctx.receipt().exists());
        install_driver(&f.ctx,&source,&exe,|p,a|fake_registration(&f.ctx,p,a)).unwrap();
        assert_eq!(read_json(&f.ctx.data.join("settings.json")).unwrap(),json!({"galaxyXr":{"nativeIdentity":true}}));
        assert!(!profile.exists());
    }

    #[test]
    fn neutral_shader_fingerprint_without_receipt_never_authorizes_retirement_or_unregister() {
        let f=Fixture::new();let neutral=f.package("steamvr/drivers/CustomHeadsetOpenVR");let source=f.package("bundle/GalaxyXRNative");
        atomic_json(&neutral.join("driver.vrdrivermanifest"),&json!({"name":LEGACY})).unwrap();
        atomic_bytes(&neutral.join("bin/win64/driver_CustomHeadsetOpenVR.dll"),b"neutral").unwrap();
        for name in ["vrlink_layer_ps.hlsl","vrlink_fxaa_ps.hlsl"] { atomic_bytes(&neutral.join("resources/shaders/d3d11").join(name),b"shared shader").unwrap(); }
        fake_registration(&f.ctx,&neutral,true).unwrap();
        assert!(!owned_package(&f.ctx,None,&neutral));assert!(candidate_packages(&f.ctx,None).unwrap().is_empty());
        let exe=f.root.join("bundle/gui.exe");install_driver(&f.ctx,&source,&exe,|p,a|fake_registration(&f.ctx,p,a)).unwrap();
        let report=uninstall_driver(&f.ctx,&exe,|p,a|fake_registration(&f.ctx,p,a)).unwrap();
        assert_eq!(f.ctx.registrations().unwrap(),vec![neutral.clone()]);assert!(neutral.exists());
        assert!(report.preserved_paths.contains(&neutral.to_string_lossy().into_owned()));
    }

    #[test]
    fn unrecorded_generic_names_and_common_values_survive_historical_cleanup() {
        let mut settings=json!({"steamvr":{"preferredRefreshRate":90},"driver_vrlink":{"targetBandwidth":200,"encodeWidth":4096},"vrlink_xrvst2ue":{"supports10bit":true}});
        let before=settings.clone();assert_eq!(legacy_reset(&mut settings,&json!({"entries":{}})).unwrap(),0);assert_eq!(settings,before);
        // A flag produced by an older heuristic cannot convert a common value
        // into proof that the pre-upgrade baseline belonged to this app.
        let journal=json!({"entries":{"driver_vrlink":{"targetBandwidth":{"present":true,"value":200,"lastPresent":true,"lastValue":350}}},"legacyKeys":{"driver_vrlink":{"targetBandwidth":true}}});
        settings["driver_vrlink"]["targetBandwidth"]=json!(350);
        restore_settings(&mut settings,&journal,&mut vec![]).unwrap();assert_eq!(settings,before);
    }

    #[test]
    fn orphan_settings_can_be_removed_without_a_driver_package() {
        let f=Fixture::new();atomic_json(&f.ctx.data.join("settings.json"),&json!({"old":true})).unwrap();
        atomic_json(&f.ctx.data.join("gui-settings.json"),&json!({"advanceMode":true})).unwrap();
        let report=uninstall_driver(&f.ctx,&f.root.join("gui.exe"),|_,_|panic!("No registration expected")).unwrap();
        assert_eq!(report.outcome,"complete");assert!(!f.ctx.data.exists());
    }

    #[test]
    fn missing_recovery_target_prevents_uninstall_without_losing_evidence() {
        let f=Fixture::new();apply_changes(&f.ctx,vec![change("s","a",Some(json!(2)))]).unwrap();
        let journal=fs::read(f.ctx.journal()).unwrap();fs::remove_file(&f.ctx.settings).unwrap();
        assert!(uninstall_driver(&f.ctx,&f.root.join("gui.exe"),|_,_|panic!("No mutation expected")).is_err());
        assert_eq!(fs::read(f.ctx.journal()).unwrap(),journal);
    }

    #[test]
    fn missing_steamvr_allows_only_local_cleanup_without_recovery_records() {
        let f=Fixture::new();atomic_json(&f.ctx.data.join("settings.json"),&json!({"old":true})).unwrap();
        atomic_bytes(&f.ctx.data.join("Distortion/profile.json"),b"profile").unwrap();
        atomic_json(&f.ctx.receipt(),&json!({"unreadable":"receipt"})).unwrap();
        assert!(uninstall_local_settings(&f.ctx.data,&f.ctx.managed).is_err());assert!(f.ctx.data.join("settings.json").exists());
        fs::remove_file(f.ctx.receipt()).unwrap();let report=uninstall_local_settings(&f.ctx.data,&f.ctx.managed).unwrap();
        assert_eq!(report.outcome,"attention-required");assert!(report.preserved_paths.is_empty());
        assert!(!f.ctx.data.join("settings.json").exists());
        // The local uninstall removes named profiles with the rest of the tree.
        assert!(!f.ctx.data.join("Distortion/profile.json").exists());assert!(!f.ctx.data.exists());
        assert!(!f.ctx.data.parent().unwrap().exists());
    }

    #[test]
    fn uninstall_removes_backups_identity_backups_and_keeps_settings_siblings() {
        let f=Fixture::new();let source=f.package("bundle/GalaxyXRNative");let exe=f.root.join("bundle/gui.exe");
        let backups=f.ctx.data.parent().unwrap().join("Backups/old/settings.before");
        atomic_bytes(&backups,b"backup").unwrap();
        let settings_dir=f.ctx.settings.parent().unwrap();
        let identity=settings_dir.join("steamvr.vrsettings.galaxyxr-identity-backup-4242-7.json");
        let unrelated=settings_dir.join("steamvr.vrsettings.manual.json");
        atomic_bytes(&identity,b"identity").unwrap();atomic_bytes(&unrelated,b"manual").unwrap();
        let installed=install_driver(&f.ctx,&source,&exe,|p,a|fake_registration(&f.ctx,p,a)).unwrap();
        let report=uninstall_driver(&f.ctx,&exe,|p,a|fake_registration(&f.ctx,p,a)).unwrap();
        assert_eq!(report.outcome,"complete");assert!(!Path::new(&installed.registered_path).exists());
        assert!(!backups.exists());assert!(!f.ctx.data.parent().unwrap().join("Backups").exists());
        assert!(!identity.exists());assert!(unrelated.exists());
        assert!(!f.ctx.data.parent().unwrap().exists());
        assert!(report.removed_paths.iter().any(|p|p.ends_with("Backups")));
        assert!(report.removed_paths.iter().any(|p|p.ends_with("galaxyxr-identity-backup-4242-7.json")));
        assert!(report.preserved_paths.iter().any(|p|same_path(Path::new(p),&source)));
        assert!(!report.preserved_paths.iter().any(|p|p.contains("Distortion")||p.contains("Backups")));
    }

    #[test]
    fn uninstall_residue_removes_au_dumps_from_temp_and_user_profile() {
        let f=Fixture::new();
        let dumps=uninstall_dump_paths();
        let temp=std::env::var_os("TEMP").filter(|temp|!temp.is_empty()).map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
        assert!(dumps.contains(&temp.join("gxr_au_dump.bin")));
        if let Some(profile)=std::env::var_os("USERPROFILE") {
            assert!(dumps.contains(&PathBuf::from(profile).join("AppData/Local/Temp/gxr_au_dump.bin")));
        }
        let temp_dump=f.root.join("temp/gxr_au_dump.bin");let profile_dump=f.root.join("profile/gxr_au_dump.bin");
        atomic_bytes(&temp_dump,b"dump").unwrap();atomic_bytes(&profile_dump,b"dump").unwrap();
        let removed=cleanup_uninstall_residue_at(&f.ctx.data,&f.ctx.managed,None,&[temp_dump.clone(),profile_dump.clone()],&mut || Ok(())).unwrap();
        assert!(!temp_dump.exists());assert!(!profile_dump.exists());
        assert_eq!(removed.iter().filter(|p|p.ends_with("gxr_au_dump.bin")).count(),2);
    }

    #[test]
    fn uninstall_residue_invokes_ofxr_cleanup_and_propagates_its_error() {
        let f=Fixture::new();
        let mut calls=0;
        cleanup_uninstall_residue_at(&f.ctx.data,&f.ctx.managed,None,&[],&mut || {calls+=1;Ok(())}).unwrap();
        assert_eq!(calls,1);
        let mut calls=0;
        let result=cleanup_uninstall_residue_at(&f.ctx.data,&f.ctx.managed,None,&[],&mut || {calls+=1;Err("OpenXR key busy".into())});
        assert_eq!(calls,1);
        assert!(result.unwrap_err().contains("OpenXR key busy"));
    }

    #[test]
    fn external_settings_edit_during_unregister_is_preserved_and_installation_rolls_back() {
        let f=Fixture::new();let source=f.package("bundle/GalaxyXRNative");let exe=f.root.join("bundle/gui.exe");
        let installed=install_driver(&f.ctx,&source,&exe,|p,a|fake_registration(&f.ctx,p,a)).unwrap();
        let result=uninstall_driver(&f.ctx,&exe,|p,add| {
            fake_registration(&f.ctx,p,add)?;
            if !add {
                let mut external=read_settings(&f.ctx.settings)?;external["steamvr"]["externalPreference"]=json!(123);
                atomic_json(&f.ctx.settings,&external)?;
            }
            Ok(())
        });
        assert!(result.err().unwrap().contains("changed during uninstall"));
        assert!(Path::new(&installed.registered_path).exists());
        assert!(contains_path(&f.ctx.registrations().unwrap(),Path::new(&installed.registered_path)));
        assert_eq!(read_settings(&f.ctx.settings).unwrap()["steamvr"]["externalPreference"],123);
        uninstall_driver(&f.ctx,&exe,|p,a|fake_registration(&f.ctx,p,a)).unwrap();
        assert_eq!(read_settings(&f.ctx.settings).unwrap()["steamvr"]["externalPreference"],123);
    }

    #[cfg(windows)]
    #[test]
    fn locked_app_preferences_report_incomplete_then_retry_removes_profiles() {
        use std::os::windows::fs::OpenOptionsExt;
        let f=Fixture::new();let source=f.package("bundle/GalaxyXRNative");let exe=f.root.join("bundle/gui.exe");
        install_driver(&f.ctx,&source,&exe,|p,a|fake_registration(&f.ctx,p,a)).unwrap();
        let preferences=f.ctx.data.join("gui-settings.json");atomic_json(&preferences,&json!({"advanceMode":true})).unwrap();
        let profile=f.ctx.data.join("Distortion/profile.json");atomic_bytes(&profile,b"profile").unwrap();
        let locked=fs::OpenOptions::new().read(true).share_mode(1).open(&preferences).unwrap();
        let report=uninstall_driver(&f.ctx,&exe,|p,a|fake_registration(&f.ctx,p,a)).unwrap();
        assert_eq!(report.outcome,"incomplete");assert!(!report.unresolved_items.is_empty());assert!(f.ctx.receipt().exists());assert!(f.ctx.journal().exists());
        drop(locked);
        let report=uninstall_driver(&f.ctx,&exe,|p,a|fake_registration(&f.ctx,p,a)).unwrap();
        assert_ne!(report.outcome,"incomplete");assert!(!preferences.exists());assert!(!f.ctx.receipt().exists());assert!(!f.ctx.journal().exists());
        assert!(!profile.exists());assert!(!f.ctx.data.join("Distortion").exists());assert!(!f.ctx.data.exists());
    }

    #[test]
    fn receipt_owned_managed_installation_can_be_uninstalled_after_its_dll_is_missing() {
        let f=Fixture::new();let source=f.package("bundle/GalaxyXRNative");let exe=f.root.join("bundle/gui.exe");
        let baseline=json!({"steamvr":{"unrelated":42}});atomic_json(&f.ctx.settings,&baseline).unwrap();
        let installed=install_driver(&f.ctx,&source,&exe,|p,a|fake_registration(&f.ctx,p,a)).unwrap();
        fs::remove_file(Path::new(&installed.registered_path).join("bin/win64/driver_GalaxyXRNative.dll")).unwrap();
        let report=uninstall_driver(&f.ctx,&exe,|p,a|fake_registration(&f.ctx,p,a)).unwrap();
        assert_eq!(report.outcome,"complete");assert!(!Path::new(&installed.registered_path).exists());
        assert!(f.ctx.registrations().unwrap().is_empty());assert_eq!(read_settings(&f.ctx.settings).unwrap(),baseline);
        assert!(source.join("bin/win64/driver_GalaxyXRNative.dll").exists());assert!(!f.ctx.data.exists());
    }
    #[test]
    fn custom_root_install_uses_receipt_and_preserves_pre_existing_root() {
        let f=Fixture::new();let source=f.package("bundle/GalaxyXRNative");let exe=f.root.join("gui.exe");
        let custom=f.root.join("custom-drivers");fs::create_dir_all(&custom).unwrap();fs::write(custom.join("keep.txt"),b"keep").unwrap();
        let installed=install_driver_to(&f.ctx,&source,&exe,Some(&custom),|p,a|fake_registration(&f.ctx,p,a)).unwrap();
        let path=PathBuf::from(&installed.registered_path);
        assert!(!installed.used_default_root);
        assert_eq!(path.parent(),Some(custom.as_path()));
        assert!(same_path(Path::new(&installed.managed_root),&custom));
        let receipt=f.ctx.receipt_value().unwrap().unwrap();
        assert_eq!(receipt["schema"],3);
        assert!(same_path(Path::new(receipt["activeRoot"].as_str().unwrap()),&custom));
        assert!(contains_path(&receipt_paths(Some(&receipt),"packages"),&path));
        assert!(receipt["managedRoots"].as_array().unwrap().iter().filter_map(Value::as_str).any(|p|same_path(Path::new(p),&custom)));
        assert!(receipt["createdRoots"].as_array().unwrap().is_empty());
        assert_eq!(f.ctx.registrations().unwrap(),vec![path.clone()]);
        let report=uninstall_driver(&f.ctx,&exe,|p,a|fake_registration(&f.ctx,p,a)).unwrap();
        assert_eq!(report.outcome,"complete");
        assert!(!path.exists());assert!(custom.exists());assert!(custom.join("keep.txt").exists());
        assert!(f.ctx.registrations().unwrap().is_empty());assert!(!f.ctx.receipt().exists());
    }
    #[test]
    fn custom_root_creation_is_tracked_and_removed_only_when_empty() {
        let f=Fixture::new();let source=f.package("bundle/GalaxyXRNative");let exe=f.root.join("gui.exe");
        let custom=f.root.join("created/custom-drivers");
        let installed=install_driver_to(&f.ctx,&source,&exe,Some(&custom),|p,a|fake_registration(&f.ctx,p,a)).unwrap();
        let path=PathBuf::from(&installed.registered_path);
        let receipt=f.ctx.receipt_value().unwrap().unwrap();
        assert!(receipt["createdRoots"].as_array().unwrap().iter().filter_map(Value::as_str).any(|p|same_path(Path::new(p),&custom)));
        assert!(custom.exists());
        uninstall_driver(&f.ctx,&exe,|p,a|fake_registration(&f.ctx,p,a)).unwrap();
        assert!(!path.exists());assert!(!custom.exists());assert!(!f.root.join("created").exists());
    }
    #[test]
    fn default_install_keeps_schema_2_and_no_custom_fields() {
        let f=Fixture::new();let source=f.package("bundle/GalaxyXRNative");let exe=f.root.join("gui.exe");
        let installed=install_driver(&f.ctx,&source,&exe,|p,a|fake_registration(&f.ctx,p,a)).unwrap();
        let receipt=f.ctx.receipt_value().unwrap().unwrap();
        assert!(installed.used_default_root);
        assert!(same_path(Path::new(&installed.managed_root),&f.ctx.managed));
        assert_eq!(receipt["schema"],2);
        assert!(receipt.get("managedRoots").is_none());
        assert!(receipt.get("activeRoot").is_none());
        assert!(receipt.get("createdRoots").is_none());
    }
    #[test]
    fn custom_then_default_reinstall_retains_both_copies_and_settings() {
        let f=Fixture::new();let source=f.package("bundle/GalaxyXRNative");let exe=f.root.join("gui.exe");
        let custom=f.root.join("custom-drivers");fs::create_dir_all(&custom).unwrap();
        let custom_install=install_driver_to(&f.ctx,&source,&exe,Some(&custom),|p,a|fake_registration(&f.ctx,p,a)).unwrap();
        let custom_path=PathBuf::from(&custom_install.registered_path);
        let settings=json!({"galaxyXr":{"nativeIdentity":false}});atomic_json(&f.ctx.data.join("settings.json"),&settings).unwrap();
        let default_install=install_driver_to(&f.ctx,&source,&exe,None,|p,a|fake_registration(&f.ctx,p,a)).unwrap();
        let default_path=PathBuf::from(&default_install.registered_path);
        assert!(default_install.used_default_root);assert!(default_path.starts_with(&f.ctx.managed));assert!(custom_path.exists());
        let receipt=f.ctx.receipt_value().unwrap().unwrap();
        assert_eq!(receipt["schema"],3);
        assert!(same_path(Path::new(receipt["activeRoot"].as_str().unwrap()),&f.ctx.managed));
        assert!(contains_path(&receipt_paths(Some(&receipt),"packages"),&custom_path));
        assert!(contains_path(&receipt_paths(Some(&receipt),"packages"),&default_path));
        assert_eq!(f.ctx.registrations().unwrap(),vec![default_path.clone()]);
        assert_eq!(read_json(&f.ctx.data.join("settings.json")).unwrap(),settings);
        uninstall_driver(&f.ctx,&exe,|p,a|fake_registration(&f.ctx,p,a)).unwrap();
        assert!(!custom_path.exists());assert!(!default_path.exists());assert!(custom.exists());
    }
    #[test]
    fn unavailable_custom_root_blocks_uninstall_and_preserves_receipt() {
        let f=Fixture::new();let source=f.package("bundle/GalaxyXRNative");let exe=f.root.join("gui.exe");
        let custom=f.root.join("custom-drivers");fs::create_dir_all(&custom).unwrap();
        let installed=install_driver_to(&f.ctx,&source,&exe,Some(&custom),|p,a|fake_registration(&f.ctx,p,a)).unwrap();
        fs::remove_dir_all(&custom).unwrap();
        let before=fs::read(f.ctx.receipt()).unwrap();
        let result=uninstall_driver(&f.ctx,&exe,|p,a|fake_registration(&f.ctx,p,a));
        assert!(matches!(result,Err(e) if e.contains("unavailable")));
        assert_eq!(fs::read(f.ctx.receipt()).unwrap(),before);
        assert_eq!(f.ctx.registrations().unwrap(),vec![PathBuf::from(installed.registered_path)]);
    }
    #[test]
    fn custom_root_validation_rejects_relative_broad_overlap_and_file_paths() {
        let f=Fixture::new();let source=f.package("bundle/GalaxyXRNative");
        for path in [PathBuf::from("relative"),PathBuf::from("C:\\"),PathBuf::from("\\\\server\\share")] {
            assert!(validate_managed_root(&f.ctx,&path,&source).is_err(),"{path:?}");
        }
        assert!(validate_managed_root(&f.ctx,&f.ctx.data.join("custom"),&source).is_err());
        assert!(validate_managed_root(&f.ctx,&f.ctx.managed.join("custom"),&source).is_err());
        assert!(validate_managed_root(&f.ctx,&source.join("custom"),&source).is_err());
        let file=f.root.join("not-a-folder");fs::write(&file,b"x").unwrap();
        assert!(validate_managed_root(&f.ctx,&file,&source).is_err());
    }
    #[test]
    fn manually_registered_package_under_custom_root_is_preserved() {
        let f=Fixture::new();let source=f.package("bundle/GalaxyXRNative");let exe=f.root.join("gui.exe");
        let custom=f.root.join("custom-drivers");fs::create_dir_all(&custom).unwrap();
        install_driver_to(&f.ctx,&source,&exe,Some(&custom),|p,a|fake_registration(&f.ctx,p,a)).unwrap();
        let manual=f.package("custom-drivers/GalaxyXRNative-manual");fake_registration(&f.ctx,&manual,true).unwrap();
        let receipt=f.ctx.receipt_value().unwrap().unwrap();
        assert!(!owned_package(&f.ctx,Some(&receipt),&manual));
        uninstall_driver(&f.ctx,&exe,|p,a|fake_registration(&f.ctx,p,a)).unwrap();
        assert!(manual.exists());
        assert!(!f.ctx.registrations().unwrap().iter().any(|p|same_path(p,&manual)));
    }
}
