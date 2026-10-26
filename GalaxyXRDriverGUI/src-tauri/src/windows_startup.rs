//! Per-user startup registration. The Run value is authoritative; the separate
//! last-command receipt only establishes which exact value we may change.
//! StartupApproved is deliberately never read or written here.
use serde::Serialize;
use std::sync::Mutex;
use tauri::WebviewWindow;

static STARTUP_LOCK: Mutex<()> = Mutex::new(());
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const REG_SZ_KIND: u32 = 1;
const START_ARGUMENT: &str = " --start-in-tray";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupStatus {
    pub supported: bool,
    pub state: String,
    pub command: Option<String>,
    pub current_command: String,
    pub registered_path: Option<String>,
}

#[derive(Clone, Copy)]
struct Vendor {
    run_name: &'static str,
    receipt_key: &'static str,
}

fn vendor(value: &str) -> Result<Vendor, String> {
    match value {
        "galaxyxr" => Ok(Vendor {
            run_name: "GalaxyXRCompanion",
            receipt_key: r"Software\GalaxyXR\Companion\WindowsStartup",
        }),
        "" => Ok(Vendor {
            run_name: "CustomHeadsetCompanion",
            receipt_key: r"Software\CustomHeadset\Companion\WindowsStartup",
        }),
        _ => Err("Unsupported Companion vendor".into()),
    }
}

fn require_main(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("Only the Companion main window can manage Windows startup".into())
    }
}

// Always quote the executable, including paths without spaces. Reject shell
// ambiguity instead of attempting to repair a path or caller-supplied command.
fn command_for_path(path: &str) -> Result<String, String> {
    let bytes = path.as_bytes();
    let drive_absolute = bytes.len() > 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && bytes[2] == b'\\';
    let unc = path.strip_prefix(r"\\").map(|rest| {
        let parts: Vec<_> = rest.split('\\').collect();
        parts.len() >= 3 && parts.iter().all(|part| !part.is_empty())
            && parts[0] != "." && parts[0] != "?"
    }).unwrap_or(false);
    if (!drive_absolute && !unc)
        || path.chars().any(|c| c.is_control() || matches!(c, '"' | '/' | '*' | '?' | '<' | '>' | '|'))
        || path.split('\\').any(|part| part == "." || part == "..")
        || !path.to_ascii_lowercase().ends_with(".exe")
        || path.chars().skip(2).any(|c| c == ':')
    {
        return Err("The Companion executable path is unsafe for Windows startup".into());
    }
    let command = format!("\"{path}\"{START_ARGUMENT}");
    if command.encode_utf16().count() > 260 {
        return Err("The Windows startup command exceeds 260 UTF-16 characters; move this copy to a shorter path".into());
    }
    Ok(command)
}

fn command_path(command: &str) -> Option<String> {
    let path = command.strip_prefix('"')?.strip_suffix(START_ARGUMENT)?.strip_suffix('"')?;
    (command_for_path(path).ok()?.as_str() == command).then(|| path.to_string())
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Value {
    kind: u32,
    bytes: Vec<u8>,
}

impl Value {
    fn string(value: &str) -> Self {
        Self {
            kind: REG_SZ_KIND,
            bytes: value.encode_utf16().chain(Some(0)).flat_map(u16::to_le_bytes).collect(),
        }
    }

    fn text(&self) -> Option<String> {
        if self.kind != REG_SZ_KIND || self.bytes.len() % 2 != 0 {
            return None;
        }
        let mut units: Vec<_> = self.bytes.chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]])).collect();
        if units.pop()? != 0 || units.contains(&0) {
            return None;
        }
        String::from_utf16(&units).ok()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Slot { Run, Receipt }

trait Store {
    fn read(&mut self, slot: Slot) -> Result<Option<Value>, String>;
    fn write(&mut self, slot: Slot, value: Option<&Value>) -> Result<(), String>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Snapshot {
    run: Option<Value>,
    receipt: Option<Value>,
}

impl Snapshot {
    fn read(store: &mut impl Store) -> Result<Self, String> {
        Ok(Self { run: store.read(Slot::Run)?, receipt: store.read(Slot::Receipt)? })
    }

    fn get(&self, slot: Slot) -> &Option<Value> {
        match slot { Slot::Run => &self.run, Slot::Receipt => &self.receipt }
    }

    fn set(&mut self, slot: Slot, value: Option<Value>) {
        match slot { Slot::Run => self.run = value, Slot::Receipt => self.receipt = value }
    }

    fn owned(&self) -> bool {
        self.run.is_some() && self.run == self.receipt
            && self.run.as_ref().and_then(Value::text).and_then(|s| command_path(&s)).is_some()
    }

    fn status(&self, current: &str) -> StartupStatus {
        let command = self.run.as_ref().and_then(Value::text);
        let registered_path = command.as_deref().and_then(command_path);
        let state = if self.run.is_none() { "absent" }
            else if !self.owned() { "conflict" }
            else if command.as_deref() == Some(current) { "current" }
            else { "other-copy" };
        StartupStatus {
            supported: true, state: state.into(), command,
            current_command: current.into(), registered_path,
        }
    }
}

// A registry pair is not an atomic transaction. Recheck the whole pair before
// each write, and restore a value only while it still equals our own write.
// This also protects external edits made while a failed operation rolls back.
fn transact(store: &mut impl Store, before: &Snapshot, writes: &[(Slot, Option<Value>)]) -> Result<Snapshot, String> {
    let mut expected = before.clone();
    let mut completed: Vec<(Slot, Option<Value>, Option<Value>)> = Vec::new();
    let result: Result<Snapshot, String> = (|| {
        for (slot, value) in writes {
            if Snapshot::read(store)? != expected {
                return Err("Windows startup registration changed during the operation; refresh and try again".into());
            }
            let previous = expected.get(*slot).clone();
            store.write(*slot, value.as_ref())?;
            completed.push((*slot, previous, value.clone()));
            expected.set(*slot, value.clone());
        }
        let after = Snapshot::read(store)?;
        if after != expected {
            return Err("Windows startup registration changed during the operation; refresh and try again".into());
        }
        Ok(after)
    })();
    match result {
        Ok(after) => Ok(after),
        Err(error) => {
            let mut rollback_errors = Vec::new();
            for (slot, previous, written) in completed.into_iter().rev() {
                match store.read(slot) {
                    Ok(actual) if actual == written => {
                        if let Err(e) = store.write(slot, previous.as_ref()) { rollback_errors.push(e); }
                    }
                    Ok(_) => rollback_errors.push("An external registry edit was preserved during rollback".into()),
                    Err(e) => rollback_errors.push(e),
                }
            }
            if rollback_errors.is_empty() { Err(error) }
            else { Err(format!("{error}; rollback: {}", rollback_errors.join("; "))) }
        }
    }
}

fn change(store: &mut impl Store, current: &str, enabled: bool, expected_command: Option<&str>) -> Result<StartupStatus, String> {
    let before = Snapshot::read(store)?;
    let status = before.status(current);
    if status.state == "conflict" {
        return Err("The Windows startup entry is not owned by this Companion; it was left unchanged".into());
    }
    if status.command.as_deref() != expected_command {
        return Err("Windows startup registration changed; refresh before changing it".into());
    }
    if enabled {
        if before.receipt.as_ref().is_some_and(|v| v.text().and_then(|s| command_path(&s)).is_none()) {
            return Err("The Windows startup ownership receipt was modified; it was left unchanged".into());
        }
        let value = Some(Value::string(current));
        Ok(transact(store, &before, &[(Slot::Receipt, value.clone()), (Slot::Run, value)])?.status(current))
    } else {
        Ok(cleanup_snapshot(store, &before)?.status(current))
    }
}

fn cleanup_snapshot(store: &mut impl Store, before: &Snapshot) -> Result<Snapshot, String> {
    if before.run.is_some() && !before.owned() {
        return Err("The Windows startup entry changed externally; startup cleanup left it unchanged".into());
    }
    if before.receipt.as_ref().is_some_and(|v| v.text().and_then(|s| command_path(&s)).is_none()) {
        return Err("The Windows startup receipt changed externally; startup cleanup left it unchanged".into());
    }
    transact(store, before, &[(Slot::Run, None), (Slot::Receipt, None)])
}

#[cfg(windows)]
fn current_command() -> Result<String, String> {
    let path = std::env::current_exe().map_err(|e| format!("Cannot locate the Companion executable: {e}"))?;
    let text = path.to_str().ok_or("The Companion executable path is not valid Unicode")?;
    command_for_path(text)
}

#[tauri::command]
pub fn get_windows_startup(window: WebviewWindow, vendor: String) -> Result<StartupStatus, String> {
    require_main(&window)?;
    let identity = self::vendor(&vendor)?;
    #[cfg(windows)]
    {
        let _guard = STARTUP_LOCK.lock().map_err(|_| "Windows startup operation lock failed")?;
        let current = current_command()?;
        Ok(Snapshot::read(&mut registry::RegistryStore(identity))?.status(&current))
    }
    #[cfg(not(windows))]
    {
        let _ = identity;
        Ok(StartupStatus { supported: false, state: "absent".into(), command: None,
            current_command: String::new(), registered_path: None })
    }
}

#[tauri::command]
pub fn set_windows_startup(window: WebviewWindow, vendor: String, enabled: bool, expected_command: Option<String>) -> Result<StartupStatus, String> {
    require_main(&window)?;
    let identity = self::vendor(&vendor)?;
    #[cfg(windows)]
    {
        let _guard = STARTUP_LOCK.lock().map_err(|_| "Windows startup operation lock failed")?;
        change(&mut registry::RegistryStore(identity), &current_command()?, enabled, expected_command.as_deref())
    }
    #[cfg(not(windows))]
    {
        let _ = (identity, enabled, expected_command);
        Err("Windows startup is only supported on Windows".into())
    }
}

pub fn cleanup_companion_startup(vendor: &str) -> Result<(), String> {
    let identity = self::vendor(vendor)?;
    #[cfg(windows)]
    {
        let _guard = STARTUP_LOCK.lock().map_err(|_| "Windows startup operation lock failed")?;
        let mut store = registry::RegistryStore(identity);
        let before = Snapshot::read(&mut store)?;
        cleanup_snapshot(&mut store, &before).map(|_| ())
    }
    #[cfg(not(windows))]
    {
        let _ = identity;
        Ok(())
    }
}

#[cfg(windows)]
mod registry {
    use super::*;
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_MORE_DATA, ERROR_PATH_NOT_FOUND, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::*;

    pub(super) struct RegistryStore(pub(super) Vendor);
    struct Key(HKEY);
    impl Drop for Key {
        fn drop(&mut self) { unsafe { RegCloseKey(self.0); } }
    }
    fn wide(s: &str) -> Vec<u16> { s.encode_utf16().chain(Some(0)).collect() }
    fn missing(code: u32) -> bool { code == ERROR_FILE_NOT_FOUND || code == ERROR_PATH_NOT_FOUND }
    fn error(operation: &str, code: u32) -> String { format!("Windows startup registry {operation} failed (Windows error {code})") }

    impl RegistryStore {
        fn location(&self, slot: Slot) -> (&str, &str) {
            match slot { Slot::Run => (RUN_KEY, self.0.run_name), Slot::Receipt => (self.0.receipt_key, "Command") }
        }
        fn open(&self, slot: Slot, create: bool) -> Result<Option<Key>, String> {
            let (path, _) = self.location(slot);
            let mut key = null_mut();
            let code = unsafe {
                if create {
                    RegCreateKeyExW(HKEY_CURRENT_USER, wide(path).as_ptr(), 0, null(), REG_OPTION_NON_VOLATILE,
                        KEY_QUERY_VALUE | KEY_SET_VALUE, null(), &mut key, null_mut())
                } else {
                    RegOpenKeyExW(HKEY_CURRENT_USER, wide(path).as_ptr(), 0, KEY_QUERY_VALUE | KEY_SET_VALUE, &mut key)
                }
            };
            if missing(code) && !create { Ok(None) }
            else if code == ERROR_SUCCESS { Ok(Some(Key(key))) }
            else { Err(error("open", code)) }
        }
    }
    impl Store for RegistryStore {
        fn read(&mut self, slot: Slot) -> Result<Option<Value>, String> {
            // Queries must work even when the user can read but cannot write.
            let (path, name) = self.location(slot);
            let mut raw_key = null_mut();
            let code = unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, wide(path).as_ptr(), 0, KEY_QUERY_VALUE, &mut raw_key) };
            if missing(code) { return Ok(None); }
            if code != ERROR_SUCCESS { return Err(error("query open", code)); }
            let key = Key(raw_key);
            let name = wide(name);
            for _ in 0..3 {
                let mut kind = 0;
                let mut size = 0;
                let code = unsafe { RegQueryValueExW(key.0, name.as_ptr(), null(), &mut kind, null_mut(), &mut size) };
                if missing(code) { return Ok(None); }
                if code != ERROR_SUCCESS { return Err(error("query size", code)); }
                if size > 1024 * 1024 { return Err("Windows startup registry value is too large to inspect safely".into()); }
                let mut bytes = vec![0u8; size as usize];
                let code = unsafe { RegQueryValueExW(key.0, name.as_ptr(), null(), &mut kind, bytes.as_mut_ptr(), &mut size) };
                if code == ERROR_MORE_DATA { continue; }
                if missing(code) { return Ok(None); }
                if code != ERROR_SUCCESS { return Err(error("query", code)); }
                bytes.truncate(size as usize);
                return Ok(Some(Value { kind, bytes }));
            }
            Err("Windows startup registry value kept changing during inspection".into())
        }
        fn write(&mut self, slot: Slot, value: Option<&Value>) -> Result<(), String> {
            let Some(key) = self.open(slot, value.is_some())? else { return Ok(()); };
            let name = wide(self.location(slot).1);
            let code = unsafe {
                match value {
                    Some(value) => RegSetValueExW(key.0, name.as_ptr(), 0, value.kind, value.bytes.as_ptr(), value.bytes.len() as u32),
                    None => RegDeleteValueW(key.0, name.as_ptr()),
                }
            };
            if code == ERROR_SUCCESS || (value.is_none() && missing(code)) { Ok(()) }
            else { Err(error("write", code)) }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct FakeStore {
        run: Option<Value>, receipt: Option<Value>, writes: usize,
        fail_write: Option<usize>, external_on_failure: Option<(Slot, Value)>,
        reads: usize, fail_read: Option<usize>, external_on_read: Option<(usize, Slot, Value)>,
    }
    impl FakeStore {
        fn owned(command: &str) -> Self {
            Self { run: Some(Value::string(command)), receipt: Some(Value::string(command)), ..Self::default() }
        }
        fn put(&mut self, slot: Slot, value: Option<Value>) {
            match slot { Slot::Run => self.run = value, Slot::Receipt => self.receipt = value }
        }
    }
    impl Store for FakeStore {
        fn read(&mut self, slot: Slot) -> Result<Option<Value>, String> {
            self.reads += 1;
            if self.fail_read == Some(self.reads) { return Err("injected query failure".into()); }
            if self.external_on_read.as_ref().is_some_and(|(at, _, _)| *at == self.reads) {
                let (_, changed_slot, value) = self.external_on_read.take().unwrap();
                self.put(changed_slot, Some(value));
            }
            Ok(match slot { Slot::Run => self.run.clone(), Slot::Receipt => self.receipt.clone() })
        }
        fn write(&mut self, slot: Slot, value: Option<&Value>) -> Result<(), String> {
            self.writes += 1;
            if self.fail_write == Some(self.writes) {
                if let Some((slot, value)) = self.external_on_failure.take() { self.put(slot, Some(value)); }
                return Err("injected registry failure".into());
            }
            self.put(slot, value.cloned());
            Ok(())
        }
    }
    fn current() -> String { command_for_path(r"C:\Portable copy\Companion.exe").unwrap() }

    #[test]
    fn quotes_unicode_and_exact_arguments() {
        let command = command_for_path(r"C:\VR 世界\🚀 Companion.exe").unwrap();
        assert_eq!(command, "\"C:\\VR 世界\\🚀 Companion.exe\" --start-in-tray");
        assert_eq!(command_path(&command).as_deref(), Some(r"C:\VR 世界\🚀 Companion.exe"));
        for path in ["relative.exe", "C:relative.exe", "C:\\bad\"name.exe", "C:\\bad\0name.exe", r"C:\..\app.exe", r"\\.\app.exe", r"C:\app.exe:other.exe", "é.exe", "世界.exe", r"C:\bad*name.exe"] {
            assert!(command_for_path(path).is_err(), "{path:?}");
        }
        assert!(command_path("C:\\app.exe --start-in-tray").is_none());
        assert!(command_path(&(command + " --extra")).is_none());
    }

    #[test]
    fn length_counts_utf16_including_quotes_and_arguments() {
        let overhead = command_for_path(r"C:\a.exe").unwrap().encode_utf16().count() - 1;
        let exact = format!("C:\\{}.exe", "a".repeat(260 - overhead));
        assert_eq!(command_for_path(&exact).unwrap().encode_utf16().count(), 260);
        assert!(command_for_path(&exact.replace(".exe", "a.exe")).is_err());
        let emoji = exact.replacen("aa", "🚀", 1);
        assert_eq!(command_for_path(&emoji).unwrap().encode_utf16().count(), 260);
    }

    #[test]
    fn vendor_names_are_fixed_and_reject_untrusted_input() {
        assert_eq!(vendor("galaxyxr").unwrap().run_name, "GalaxyXRCompanion");
        assert_eq!(vendor("").unwrap().run_name, "CustomHeadsetCompanion");
        assert_ne!(vendor("").unwrap().receipt_key, vendor("galaxyxr").unwrap().receipt_key);
        assert!(vendor("neutral").is_err());
        assert!(vendor("GalaxyXR").is_err());
    }

    #[test]
    fn off_absent_and_orphan_receipt_do_not_enable_startup() {
        let mut store = FakeStore::default();
        assert_eq!(Snapshot::read(&mut store).unwrap().status(&current()).state, "absent");
        store.receipt = Some(Value::string(&current()));
        assert_eq!(Snapshot::read(&mut store).unwrap().status(&current()).state, "absent");
        assert_eq!(store.writes, 0);
        assert_eq!(change(&mut store, &current(), false, None).unwrap().state, "absent");
        assert!(store.receipt.is_none());
    }

    #[test]
    fn enable_disable_and_explicit_move_between_copies() {
        let mut store = FakeStore::default();
        let first = current();
        assert_eq!(change(&mut store, &first, true, None).unwrap().state, "current");
        let second = command_for_path(r"D:\Other\Companion.exe").unwrap();
        let other = Snapshot::read(&mut store).unwrap().status(&second);
        assert_eq!(other.state, "other-copy");
        assert_eq!(other.registered_path.as_deref(), Some(r"C:\Portable copy\Companion.exe"));
        assert_eq!(store.run.as_ref().unwrap().text(), Some(first.clone()));
        assert!(change(&mut store, &second, true, None).is_err());
        assert_eq!(change(&mut store, &second, true, Some(&first)).unwrap().state, "current");
        assert_eq!(change(&mut store, &second, false, Some(&second)).unwrap().state, "absent");
        assert!(store.run.is_none() && store.receipt.is_none());
    }

    #[test]
    fn unknown_modified_and_non_string_entries_are_preserved() {
        let first = current();
        for receipt in [None, Some(Value::string("external")), Some(Value { kind: 4, bytes: vec![0; 4] })] {
            let mut store = FakeStore { run: Some(Value::string(&first)), receipt, ..FakeStore::default() };
            let before = Snapshot::read(&mut store).unwrap();
            assert_eq!(before.status(&first).state, "conflict");
            assert!(change(&mut store, &first, true, Some(&first)).is_err());
            assert!(cleanup_snapshot(&mut store, &before).is_err());
            assert_eq!(Snapshot::read(&mut store).unwrap(), before);
            assert_eq!(store.writes, 0);
        }
        let mut malformed = FakeStore::owned(&first);
        malformed.run.as_mut().unwrap().kind = 4;
        assert_eq!(Snapshot::read(&mut malformed).unwrap().status(&first).state, "conflict");
    }

    #[test]
    fn partial_enable_and_disable_restore_both_values() {
        let command = current();
        for enabled in [true, false] {
            let mut store = if enabled { FakeStore::default() } else { FakeStore::owned(&command) };
            let before = Snapshot::read(&mut store).unwrap();
            store.fail_write = Some(2);
            assert!(change(&mut store, &command, enabled, if enabled { None } else { Some(&command) }).is_err());
            assert_eq!(Snapshot::read(&mut store).unwrap(), before);
        }
    }

    #[test]
    fn rollback_preserves_external_edits() {
        let command = current();
        let external = Value::string("external receipt");
        let mut store = FakeStore { fail_write: Some(2), external_on_failure: Some((Slot::Receipt, external.clone())), ..FakeStore::default() };
        let error = change(&mut store, &command, true, None).unwrap_err();
        assert!(error.contains("external registry edit was preserved"));
        assert_eq!(store.receipt, Some(external));
        assert!(store.run.is_none());
    }

    #[test]
    fn malformed_receipt_without_run_stays_absent_but_is_not_overwritten() {
        let mut store = FakeStore { receipt: Some(Value::string("foreign")), ..FakeStore::default() };
        assert_eq!(Snapshot::read(&mut store).unwrap().status(&current()).state, "absent");
        assert!(change(&mut store, &current(), true, None).is_err());
        assert_eq!(store.writes, 0);
    }

    #[test]
    fn recheck_detects_external_change_before_first_write() {
        let external = Value::string("external command");
        let mut store = FakeStore { external_on_read: Some((3, Slot::Run, external.clone())), ..FakeStore::default() };
        assert!(change(&mut store, &current(), true, None).unwrap_err().contains("changed during"));
        assert_eq!(store.run, Some(external));
        assert_eq!(store.writes, 0);
    }

    #[test]
    fn query_failure_after_partial_write_rolls_back() {
        // Two initial reads, two pre-write reads, then the receipt is written.
        let mut store = FakeStore { fail_read: Some(5), ..FakeStore::default() };
        assert!(change(&mut store, &current(), true, None).unwrap_err().contains("query failure"));
        assert!(store.run.is_none() && store.receipt.is_none());
    }

    #[test]
    fn cleanup_rolls_back_run_if_receipt_delete_fails() {
        let mut store = FakeStore::owned(&current());
        let before = Snapshot::read(&mut store).unwrap();
        store.fail_write = Some(2);
        assert!(cleanup_snapshot(&mut store, &before).is_err());
        assert_eq!(Snapshot::read(&mut store).unwrap(), before);
    }

    #[test]
    fn registry_text_rejects_malformed_and_embedded_nul() {
        assert!(Value { kind: 1, bytes: vec![0] }.text().is_none());
        assert!(Value { kind: 1, bytes: vec![0, 216, 0, 0] }.text().is_none());
        assert!(Value::string("prefix\0suffix").text().is_none());
    }
}
