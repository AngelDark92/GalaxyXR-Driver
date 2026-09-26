//! Runtime confirmation uses current vrserver identity AND fresh driver output.
//! A copied manifest, an old info.json, or a successful launch request is not
//! evidence that this driver initialized in the current SteamVR session.
use super::*;

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    state: String,
    detail: String,
    steamvr_running: bool,
    driver_initialized: bool,
    headset_connected: bool,
    driver_version: Option<String>,
    server_pid: Option<u32>,
    checked_at: u64,
}
fn status(state: &str, detail: &str, running: bool, now: u64) -> RuntimeStatus {
    RuntimeStatus { state: state.into(), detail: detail.into(), steamvr_running: running,
        driver_initialized: false, headset_connected: false, driver_version: None, server_pid: None, checked_at: now }
}

fn assess_runtime(info: &Value, diagnostic: &Value, pid: u32, started: u64,
    info_modified: u64, diagnostic_modified: u64, expected: &str, now: u64) -> RuntimeStatus {
    let mut report = status("waiting", "SteamVR is running. Connect the headset through Steam Link and wait for the driver to initialize.", true, now);
    report.server_pid = Some(pid);
    let fresh_info = info_modified >= started && info_modified <= now + 2000;
    let this_session = info["runtime"]["processId"].as_u64() == Some(pid as u64);
    if !fresh_info || !this_session || info["driverName"] != DRIVER {
        report.detail = "Waiting for this installation to publish information for the current SteamVR session. Old runtime files do not count as verification.".into();
        return report;
    }
    report.driver_version = info["driverVersion"].as_str().map(String::from);
    if info["runtime"]["lockedOut"] == true {
        report.state = "locked-out".into();
        report.detail = "The driver loaded but is inactive because the other driver is enabled. Close SteamVR, use Switch to this driver, and start SteamVR again.".into();
        return report;
    }
    if info["driverVersion"].as_str() != Some(expected) {
        report.state = "version-mismatch".into();
        report.detail = "SteamVR loaded a different driver version. Close SteamVR, reinstall the driver from this package, and start it again.".into();
        return report;
    }
    let fresh_diagnostic = diagnostic_modified >= started && diagnostic_modified <= now + 2000
        && now.saturating_sub(diagnostic_modified) <= 5000;
    if info["runtime"]["initialized"] != true || !fresh_diagnostic || diagnostic["vrserverPID"].as_u64() != Some(pid as u64) { return report; }
    report.driver_initialized = true;
    // Connection alone is not proof of image quality, tracking or a working
    // display. The UI separately asks the user to check those in the headset.
    report.headset_connected = info["connectedHeadset"].as_u64().map(|v| v != 0).unwrap_or(false);
    report.state = if report.headset_connected { "headset-connected" } else { "initialized" }.into();
    report.detail = if report.headset_connected {
        "The driver is initialized in the current SteamVR session and reports a connected headset. Check the picture and controller tracking in the headset to finish setup."
    } else {
        "Driver initialization is verified in the current SteamVR session. Connect the headset through Steam Link, then check the picture and controller tracking."
    }.into();
    report
}
fn modified_ms(path: &Path) -> Result<u64> {
    fs::metadata(path).and_then(|m| m.modified()).map_err(|e| error(path, e))?
        .duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).map_err(|e| error(path, e))
}

// Cleanup needs process presence even before installation or when the running
// SteamVR belongs to another location. Initialization still requires the
// strictly matched server and fresh runtime files below (2026-09-26).
fn process_status(running: bool, now: u64) -> RuntimeStatus {
    if running {
        status("waiting", "SteamVR is running. Close it completely before cleaning settings or uninstalling the driver.", true, now)
    } else {
        status("not-running", "Start SteamVR to initialize the driver and verify that it is running. Installation alone does not complete this step.", false, now)
    }
}

#[tauri::command]
pub fn get_galaxyxr_runtime_status(steamvr_path: Option<String>, expected_version: String) -> Result<RuntimeStatus> {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_millis() as u64;
    let mut system = System::new_all();
    system.refresh_processes(ProcessesToUpdate::All, false);
    let running = system.processes().values().any(|process| is_steamvr_process(process.name()));
    if !running { return Ok(process_status(false, now)); }
    let Some(steamvr_path) = steamvr_path.filter(|path| !path.trim().is_empty()) else {
        return Ok(process_status(true, now));
    };
    // An uninstalled driver can still clean settings. Do not construct a
    // runtime context or consult stale info.json merely to detect processes.
    if expected_version.is_empty() { return Ok(process_status(true, now)); }
    let ctx = Context::live(steamvr_path)?;
    let server = system.processes().iter().find(|(_, process)| process.name().eq_ignore_ascii_case("vrserver.exe")
        && process.exe().map(|exe| same_path(exe, &ctx.steamvr.join("bin/win64/vrserver.exe"))).unwrap_or(false));
    let Some((pid, process)) = server else {
        return Ok(process_status(true, now));
    };
    let info_path = ctx.data.join("info.json");
    let diagnostic_path = ctx.data.join("diagnostic.json");
    safe_chain(&info_path)?; safe_chain(&diagnostic_path)?;
    // These files are refreshed by the driver; a read between writes is not a
    // failure of installation. The next poll can confirm a complete snapshot.
    let snapshot = (|| -> Result<RuntimeStatus> {
        let info = read_json(&info_path)?;
        let diagnostic = if diagnostic_path.exists() { read_json(&diagnostic_path)? } else { json!({}) };
        Ok(assess_runtime(&info, &diagnostic, pid.as_u32(), process.start_time() * 1000,
            modified_ms(&info_path)?, modified_ms(&diagnostic_path).unwrap_or(0), &expected_version, now))
    })();
    Ok(snapshot.unwrap_or_else(|_| status("waiting", "Waiting for readable driver runtime information. Connect Steam Link. If this continues, close SteamVR, reinstall the driver, and start SteamVR again.", true, now)))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_steamvr_process_blocks_cleanup_independent_of_path() {
        for name in ["vrserver.exe", "VRMonitor.EXE", "vrcompositor.exe", "vrserver", "vrmonitor", "vrcompositor"] {
            assert!(is_steamvr_process(std::ffi::OsStr::new(name)), "{name}");
        }
        for name in ["steam.exe", "game.exe", "not-vrserver.exe", "vrserver.exe.backup"] {
            assert!(!is_steamvr_process(std::ffi::OsStr::new(name)), "{name}");
        }
    }
    #[test]
    fn process_presence_never_claims_driver_initialization() {
        for running in [false, true] {
            let report = process_status(running, 1234);
            assert_eq!(report.steamvr_running, running);
            assert!(!report.driver_initialized);
            assert!(!report.headset_connected);
            assert!(report.server_pid.is_none());
            assert!(report.driver_version.is_none());
            assert_eq!(report.checked_at, 1234);
        }
    }
    fn info() -> Value { json!({"driverName":DRIVER,"driverVersion":"1.2.0","connectedHeadset":0,"runtime":{"processId":42,"initialized":true,"lockedOut":false}}) }
    #[test] fn current_session_verifies() { assert!(assess_runtime(&info(),&json!({"vrserverPID":42}),42,1000,2000,9000,"1.2.0",10000).driver_initialized); }
    #[test] fn old_pid_never_verifies() { assert!(!assess_runtime(&info(),&json!({"vrserverPID":42}),43,1000,2000,9000,"1.2.0",10000).driver_initialized); }
    #[test] fn reused_pid_old_info_never_verifies() { assert!(!assess_runtime(&info(),&json!({"vrserverPID":42}),42,3000,2000,9000,"1.2.0",10000).driver_initialized); }
    #[test] fn stale_heartbeat_never_verifies() { assert!(!assess_runtime(&info(),&json!({"vrserverPID":42}),42,1000,2000,4000,"1.2.0",10000).driver_initialized); }
    #[test] fn merely_starting_is_not_initialized() { let mut i=info();i["runtime"]["initialized"]=json!(false);assert!(!assess_runtime(&i,&json!({"vrserverPID":42}),42,1000,2000,9000,"1.2.0",10000).driver_initialized); }
    #[test] fn locked_out_is_not_success() { let mut i=info();i["runtime"]["lockedOut"]=json!(true);let r=assess_runtime(&i,&json!({"vrserverPID":42}),42,1000,2000,9000,"1.2.0",10000);assert_eq!(r.state,"locked-out");assert!(!r.driver_initialized); }
    #[test] fn wrong_version_is_not_success() { assert_eq!(assess_runtime(&info(),&json!({"vrserverPID":42}),42,1000,2000,9000,"2.0.0",10000).state,"version-mismatch"); }
    #[test] fn connection_is_separate_from_initialization() { let mut i=info();i["connectedHeadset"]=json!(1);assert_eq!(assess_runtime(&i,&json!({"vrserverPID":42}),42,1000,2000,9000,"1.2.0",10000).state,"headset-connected"); }
}
