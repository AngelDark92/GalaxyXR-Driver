//! Read-only headset counters over one USB-connected Galaxy XR.
//!
//! ADB is always addressed with `-d` (USB only). No root, installs, settings
//! writes, wireless ADB, log clearing or device selection by guesswork.

use super::{monotonic_now, Sample, SampleKind, SamplerError};
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

const ADB_TIMEOUT: Duration = Duration::from_secs(3);
const DECODER_STALE_SECONDS: f64 = 4.0;
const MAX_LOG_LINES: usize = 100;

pub fn default_adb() -> String {
    if let Some(path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path) {
            for name in ["adb.exe", "adb"] {
                let candidate = directory.join(name);
                if candidate.is_file() {
                    return candidate.to_string_lossy().into_owned();
                }
            }
        }
    }
    for variable in ["ANDROID_HOME", "ANDROID_SDK_ROOT"] {
        if let Some(root) = std::env::var_os(variable) {
            let candidate = PathBuf::from(root).join("platform-tools").join("adb.exe");
            if candidate.is_file() {
                return candidate.to_string_lossy().into_owned();
            }
        }
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let candidate = PathBuf::from(local)
            .join("Android")
            .join("Sdk")
            .join("platform-tools")
            .join("adb.exe");
        if candidate.is_file() {
            return candidate.to_string_lossy().into_owned();
        }
    }
    String::new()
}

pub(super) fn kill_server(adb_path: &str) {
    let path = if adb_path.trim().is_empty() { default_adb() } else { adb_path.to_string() };
    if path.is_empty() {
        return;
    }
    let _ = run_adb(&path, &["kill-server"], ADB_TIMEOUT, &AtomicBool::new(false));
}

fn cancelled() -> SamplerError {
    SamplerError::new("cancelled", "Sampling stopped.")
}

fn run_adb(
    adb_path: &str,
    args: &[&str],
    timeout: Duration,
    stop: &AtomicBool,
) -> Result<String, SamplerError> {
    if stop.load(Ordering::SeqCst) {
        return Err(cancelled());
    }
    if adb_path.trim().is_empty() || !Path::new(adb_path).is_file() {
        return Err(SamplerError::new("adb-missing", "Choose an existing adb executable."));
    }
    let mut command = Command::new(adb_path);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = command
        .spawn()
        .map_err(|error| SamplerError::new("adb-failed", format!("ADB is unavailable: {error}")))?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut stdout = String::new();
                let mut stderr = String::new();
                if let Some(mut pipe) = child.stdout.take() {
                    let _ = pipe.read_to_string(&mut stdout);
                }
                if let Some(mut pipe) = child.stderr.take() {
                    let _ = pipe.read_to_string(&mut stderr);
                }
                if !status.success() {
                    let message = if stderr.trim().is_empty() { stdout.trim() } else { stderr.trim() };
                    return Err(SamplerError::new(
                        "adb-failed",
                        if message.is_empty() { format!("ADB exited with {status}.") } else { message.to_string() },
                    ));
                }
                return Ok(stdout);
            }
            Ok(None) => {}
            Err(error) => {
                return Err(SamplerError::new("adb-failed", format!("ADB is unavailable: {error}")))
            }
        }
        if stop.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(cancelled());
        }
        if started.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(SamplerError::new("adb-failed", "ADB command timed out."));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn valid_serial(serial: &str) -> bool {
    !serial.is_empty()
        && serial != "unknown"
        && serial != "offline"
        && serial
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-'))
}

fn usb_serial(adb_path: &str, stop: &AtomicBool) -> Result<String, SamplerError> {
    let serial = run_adb(adb_path, &["-d", "get-serialno"], ADB_TIMEOUT, stop)?.trim().to_string();
    if !valid_serial(&serial) {
        return Err(SamplerError::new(
            "usb-missing",
            "No single authorized USB headset; connect USB and authorize ADB.",
        ));
    }
    Ok(serial)
}

fn galaxy_xr_model(adb_path: &str, stop: &AtomicBool) -> Result<String, SamplerError> {
    let model = run_adb(adb_path, &["-d", "shell", "getprop", "ro.product.model"], ADB_TIMEOUT, stop)?
        .trim()
        .to_string();
    let canonical: String = model
        .chars()
        .filter(|character| !matches!(character, '-' | '_' | ' '))
        .collect::<String>()
        .to_uppercase();
    let suffix = canonical.strip_prefix("SMI610").unwrap_or("");
    if !canonical.starts_with("SMI610") || suffix.len() > 3 || !suffix.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(SamplerError::new(
            "usb-model",
            format!(
                "USB device model {} is not a supported Galaxy XR headset (SM-I610).",
                if model.is_empty() { "(unknown)" } else { &model }
            ),
        ));
    }
    Ok(model)
}

#[derive(Clone, Debug)]
struct DecoderRow {
    pid: u32,
    token: String,
    stream: u64,
    monotonic_ns: u64,
    accepted_bytes: u64,
    accepted_frames: u64,
}

fn parse_decoder_stats(text: &str, live_pids: &HashSet<u32>) -> Option<DecoderRow> {
    let mut latest: Option<DecoderRow> = None;
    for line in text.lines().take(MAX_LOG_LINES * 4) {
        if !line.contains("GXRDecoderProbe") {
            continue;
        }
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 4 || !fields[0].contains('.') {
            continue;
        }
        let Ok(pid) = fields[1].parse::<u32>() else { continue };
        if !live_pids.contains(&pid) || fields[2].parse::<u32>().is_err() {
            continue;
        }
        let mut values: HashMap<&str, &str> = HashMap::new();
        for field in &fields[3..] {
            if let Some((key, value)) = field.split_once('=') {
                values.insert(key, value);
            }
        }
        if values.get("event") != Some(&"stats") || values.get("scope") != Some(&"decoder_input") {
            continue;
        }
        let Some(token) = values.get("token") else { continue };
        if token.len() != 32 || !token.chars().all(|character| character.is_ascii_hexdigit()) {
            continue;
        }
        let parse = |key: &str| values.get(key).and_then(|value| value.parse::<u64>().ok());
        let (Some(stream), Some(monotonic_ns), Some(accepted_bytes), Some(accepted_frames)) =
            (parse("stream"), parse("monotonic_ns"), parse("accepted_input_bytes"), parse("accepted_input_frames"))
        else {
            continue;
        };
        let row = DecoderRow {
            pid,
            token: token.to_string(),
            stream,
            monotonic_ns,
            accepted_bytes,
            accepted_frames,
        };
        if latest.as_ref().map(|current| row.monotonic_ns > current.monotonic_ns).unwrap_or(true) {
            latest = Some(row);
        }
    }
    latest
}

fn parse_net_dev(text: &str) -> HashMap<String, u64> {
    let mut counters = HashMap::new();
    for line in text.lines() {
        let Some((interface, raw)) = line.split_once(':') else { continue };
        let fields: Vec<&str> = raw.split_whitespace().collect();
        if fields.len() >= 16 && !fields[0].is_empty() && fields[0].chars().all(|c| c.is_ascii_digit()) {
            if let Ok(value) = fields[0].parse::<u64>() {
                counters.insert(interface.trim().to_string(), value);
            }
        }
    }
    counters
}

fn is_wlan(name: &str) -> bool {
    name.strip_prefix("wlan")
        .map(|suffix| !suffix.is_empty() && suffix.chars().all(|c| c.is_ascii_digit()))
        .unwrap_or(false)
}

fn choose_wlan_interface(counters: &HashMap<String, u64>, routes: &str) -> Result<String, SamplerError> {
    let available: Vec<&str> = counters.keys().map(String::as_str).filter(|name| is_wlan(name)).collect();
    let words: Vec<&str> = routes.split_whitespace().collect();
    for pair in words.windows(2) {
        if pair[0] == "dev" && is_wlan(pair[1]) && counters.contains_key(pair[1]) {
            return Ok(pair[1].to_string());
        }
    }
    if available.len() == 1 {
        return Ok(available[0].to_string());
    }
    Err(SamplerError::new(
        "wlan-interface",
        "Cannot identify one WLAN RX interface; USB/loopback traffic is not substituted.",
    ))
}

fn valid_boot_id(boot_id: &str) -> bool {
    boot_id.len() == 36 && boot_id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

#[derive(Default)]
struct ProbeState {
    key: Option<(String, String, u32, String, u64)>,
    probe_ns: u64,
    probe_host: f64,
    last_advance: Option<f64>,
    origin: Option<(u64, f64)>,
}

pub struct HeadsetSampler {
    adb_path: String,
    serial: String,
    stop: Arc<AtomicBool>,
    verified_identity: Option<(String, String)>,
    probe: ProbeState,
}

impl HeadsetSampler {
    pub fn new(adb_path: &str, serial: &str, stop: Arc<AtomicBool>) -> Self {
        Self {
            adb_path: if adb_path.trim().is_empty() { default_adb() } else { adb_path.to_string() },
            serial: serial.trim().to_string(),
            stop,
            verified_identity: None,
            probe: ProbeState::default(),
        }
    }

    pub fn close(&mut self) {
        self.verified_identity = None;
        self.probe = ProbeState::default();
    }

    fn read_decoder(&mut self, serial: &str, boot_id: &str) -> Result<Option<Sample>, SamplerError> {
        if self.stop.load(Ordering::SeqCst) {
            return Err(cancelled());
        }
        let now = monotonic_now();
        let pids_text = match run_adb(
            &self.adb_path,
            &["-d", "shell", "pidof", "com.valvesoftware.steamlinkvr"],
            ADB_TIMEOUT,
            &self.stop,
        ) {
            Ok(text) => text,
            Err(_) => return Ok(None),
        };
        let pids: HashSet<u32> = pids_text
            .split_whitespace()
            .filter_map(|value| value.parse::<u32>().ok())
            .collect();
        if pids.is_empty() {
            return Ok(None);
        }
        let logs = match run_adb(
            &self.adb_path,
            &["-d", "logcat", "-d", "-t", "100", "-v", "epoch", "GXRDecoderProbe:I", "*:S"],
            ADB_TIMEOUT,
            &self.stop,
        ) {
            Ok(text) => text,
            Err(_) => return Ok(None),
        };
        let Some(row) = parse_decoder_stats(&logs, &pids) else { return Ok(None) };
        let key = (serial.to_string(), boot_id.to_string(), row.pid, row.token.clone(), row.stream);
        if self.probe.key.as_ref() != Some(&key) || self.probe.probe_ns == 0 || row.monotonic_ns < self.probe.probe_ns {
            self.probe.key = Some(key);
            self.probe.probe_ns = row.monotonic_ns;
            self.probe.probe_host = now;
            self.probe.last_advance = None;
            self.probe.origin = None;
            return Ok(None); // Historical lines alone never establish freshness.
        }
        if row.monotonic_ns > self.probe.probe_ns {
            if self.probe.origin.is_none() {
                self.probe.origin = Some((self.probe.probe_ns, self.probe.probe_host));
            }
            self.probe.probe_ns = row.monotonic_ns;
            self.probe.probe_host = now;
            self.probe.last_advance = Some(now);
        } else if self.probe.last_advance.map(|last| now - last > DECODER_STALE_SECONDS).unwrap_or(true) {
            return Ok(None);
        }
        let (origin_ns, origin_host) = self.probe.origin.unwrap_or((row.monotonic_ns, now));
        let (serial_part, boot_part, pid, token, stream) = self.probe.key.as_ref().expect("probe key");
        Ok(Some(Sample {
            source_id: format!("decoder:{serial_part}:{boot_part}:{pid}:{token}:{stream}"),
            monotonic_time: origin_host + (row.monotonic_ns - origin_ns) as f64 / 1e9,
            total_bytes: row.accepted_bytes,
            frames: Some(row.accepted_frames),
            kind: SampleKind::DecoderInput,
            pid: None,
            module_sha256: None,
            serial: Some(serial_part.clone()),
            interface: None,
            codec: None,
        }))
    }

    pub fn sample(&mut self) -> Result<Sample, SamplerError> {
        if self.stop.load(Ordering::SeqCst) {
            return Err(cancelled());
        }
        let serial = usb_serial(&self.adb_path, &self.stop)?;
        if !self.serial.is_empty() && self.serial != serial {
            return Err(SamplerError::new(
                "usb-changed",
                "Selected USB headset is not connected; no other device was substituted.",
            ));
        }
        let boot_id = run_adb(
            &self.adb_path,
            &["-d", "shell", "cat", "/proc/sys/kernel/random/boot_id"],
            ADB_TIMEOUT,
            &self.stop,
        )?
        .trim()
        .to_string();
        if !valid_boot_id(&boot_id) {
            return Err(SamplerError::new("boot-id", "Headset boot identity is unavailable."));
        }
        let identity = (serial.clone(), boot_id.clone());
        if self.verified_identity.as_ref() != Some(&identity) {
            galaxy_xr_model(&self.adb_path, &self.stop)?;
            self.verified_identity = Some(identity);
        }
        if let Some(sample) = self.read_decoder(&serial, &boot_id)? {
            if usb_serial(&self.adb_path, &self.stop)? != serial {
                return Err(SamplerError::new(
                    "usb-changed",
                    "USB headset changed while sampling; waiting for a new baseline.",
                ));
            }
            return Ok(sample);
        }
        // Freshness and counters from a different device must not survive a
        // USB change between commands. -d still prohibits network ADB.
        if usb_serial(&self.adb_path, &self.stop)? != serial {
            return Err(SamplerError::new(
                "usb-changed",
                "USB headset changed while sampling; waiting for a new baseline.",
            ));
        }
        let routes = run_adb(&self.adb_path, &["-d", "shell", "ip", "route"], ADB_TIMEOUT, &self.stop)?;
        let started = monotonic_now();
        let counters = parse_net_dev(&run_adb(
            &self.adb_path,
            &["-d", "shell", "cat", "/proc/net/dev"],
            ADB_TIMEOUT,
            &self.stop,
        )?);
        let finished = monotonic_now();
        let interface = choose_wlan_interface(&counters, &routes)?;
        if usb_serial(&self.adb_path, &self.stop)? != serial {
            return Err(SamplerError::new(
                "usb-changed",
                "USB headset changed while sampling; waiting for a new baseline.",
            ));
        }
        Ok(Sample {
            source_id: format!("wlan_rx:{serial}:{boot_id}:{interface}"),
            monotonic_time: (started + finished) / 2.0,
            total_bytes: counters[&interface],
            frames: None,
            kind: SampleKind::NetworkRxAllTraffic,
            pid: None,
            module_sha256: None,
            serial: Some(serial),
            interface: Some(interface),
            codec: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{choose_wlan_interface, parse_decoder_stats, parse_net_dev};
    use std::collections::HashSet;

    const BOOT: &str = "7d54938d-fbef-4774-ad13-813a440f8f10";
    const TOKEN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const NET: &str = "Inter-| Receive | Transmit\n wlan0: 1000000000 12 0 0 0 0 0 0 23000 10 0 0 0 0 0 0\n lo: 9999999999 1 0 0 0 0 0 0 9999999999 1 0 0 0 0 0 0\n rndis0: 8888888888 1 0 0 0 0 0 0 8888888888 1 0 0 0 0 0 0\n";

    fn probe_line(stamp: u64, bytes: u64, pid: u32) -> String {
        format!(
            "1792600000.000 {pid} 101 I GXRDecoderProbe: event=stats token={TOKEN} stream=1 monotonic_ns={stamp} accepted_input_bytes={bytes} accepted_input_frames=10 output_frames=10 scope=decoder_input"
        )
    }

    #[test]
    fn receive_column_and_wlan_selection() {
        let counters = parse_net_dev(NET);
        assert_eq!(counters["wlan0"], 1_000_000_000);
        assert_eq!(choose_wlan_interface(&counters, "default dev wlan0").unwrap(), "wlan0");
        let only_loopback = [("lo".to_string(), 1), ("rndis0".to_string(), 2)].into_iter().collect();
        assert!(choose_wlan_interface(&only_loopback, "default dev rndis0").is_err());
    }

    #[test]
    fn decoder_requires_current_pid_scope_and_token() {
        let pids = HashSet::from([99]);
        assert_eq!(parse_decoder_stats(&probe_line(1_000_000_000, 12_345, 99), &pids).unwrap().accepted_bytes, 12_345);
        assert!(parse_decoder_stats(&probe_line(1_000_000_000, 12_345, 100), &pids).is_none());
        let transport = probe_line(1_000_000_000, 12_345, 99).replace("scope=decoder_input", "scope=transport");
        assert!(parse_decoder_stats(&transport, &pids).is_none());
        let bad_token = probe_line(1_000_000_000, 12_345, 99).replace(TOKEN, "bad");
        assert!(parse_decoder_stats(&bad_token, &pids).is_none());
    }

    #[test]
    fn invalid_or_negative_counter_is_rejected() {
        let pids = HashSet::from([99]);
        let negative = probe_line(1_000_000_000, 12_345, 99).replace("accepted_input_bytes=12345", "accepted_input_bytes=-1");
        assert!(parse_decoder_stats(&negative, &pids).is_none());
        assert!(parse_net_dev("wlan0: malformed").is_empty());
        assert_eq!(BOOT.len(), 36);
    }
}
