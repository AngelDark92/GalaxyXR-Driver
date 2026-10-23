//! Exact completed NVENC bytes from the installed driver's read-only telemetry.
//!
//! Preferred path: the versioned `GalaxyXR_NVENC_Probe_v1` data export, whose
//! ABI, writable-image bounds, publication sequence, PID and freshness are all
//! checked. The older fixed-offset profile remains admitted only for the exact
//! audited binary. No target code is called, no process memory is written and
//! no NVENC pointer survives an unlocked bitstream.

use super::codec::CodecClassifier;
use super::{monotonic_now, wall_now, CodecDetection, Sample, SampleKind, SamplerError};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

const PREFIX_SIZE: usize = 112;
const MAX_INFO_AGE: f64 = 6.0;
const PROBE_MAGIC: u64 = 0x3156_424F_5250_5847;
const PROBE_ABI: u32 = 1;
const PROBE_HEADER_BYTES: usize = 128;
const PROBE_CAPACITY: usize = 2 * 1024 * 1024;
const PROBE_SLOT_BYTES: usize = 64 + PROBE_CAPACITY;
const PROBE_SIZE: usize = PROBE_HEADER_BYTES + 2 * PROBE_SLOT_BYTES;
const MAX_COUNTER_AGE_MS: i128 = 6000;
const RETRIES: usize = 3;
const PROBE_EXPORT: &[u8] = b"GalaxyXR_NVENC_Probe_v1\0";

/// 2026-10-21 audited fallback for the one driver binary without the export.
/// A neighboring version or encoder target is never assumed to share it.
const LEGACY_SHA256: &str = "056ccf2c890b179078b01c7aff65f9f937876626f0f48857607221fc5cf38759";

#[derive(Clone, Copy)]
struct StatsProfile {
    stats_rva: u32,
    section_rva: u32,
    section_size: u32,
    section_name: &'static str,
}

const LEGACY_PROFILE: StatsProfile = StatsProfile {
    stats_rva: 0x177D00,
    section_rva: 0x177000,
    section_size: 68484,
    section_name: ".data",
};

#[derive(Clone, Copy)]
struct CounterSnapshot {
    frames: u64,
    total_bytes: u64,
}

#[derive(Clone)]
struct ProbeCounters {
    frames: u64,
    total_bytes: u64,
    generation: u64,
    tick_ms: u64,
}

struct ProbeFrame {
    data: Vec<u8>,
    full_size: u32,
    complete: bool,
    tick_ms: u64,
    generation: u64,
    frame_index: u64,
    capture_id: u64,
}

trait ProcessReader {
    fn read(&self, address: u64, size: usize) -> Result<Vec<u8>, SamplerError>;
    fn ticks(&self) -> u64;
}

pub struct NvencSampler {
    info_paths: Vec<PathBuf>,
    codec_interval: f64,
    codec_next: f64,
    codec_source: Option<String>,
    classifier: CodecClassifier,
    codec_result: Option<CodecDetection>,
    codec_sampled_at: f64,
    codec_frame_age: f64,
    last: Option<(String, u64, u64)>,
    stop: Arc<AtomicBool>,
}

impl NvencSampler {
    pub fn new(info_path: Option<&str>, codec_interval: f64, stop: Arc<AtomicBool>) -> Result<Self, SamplerError> {
        if !codec_interval.is_finite() || !(1.0..=3600.0).contains(&codec_interval) {
            return Err(SamplerError::new(
                "invalid-interval",
                "Codec inspection interval must be between 1 and 3600 seconds",
            ));
        }
        let paths = if let Some(path) = info_path.filter(|path| !path.trim().is_empty()) {
            vec![PathBuf::from(path)]
        } else {
            let appdata = std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_default();
            vec![
                appdata.join("GalaxyXR").join("CustomHeadset").join("info.json"),
                appdata.join("CustomHeadset").join("info.json"),
            ]
        };
        Ok(Self {
            info_paths: paths,
            codec_interval,
            codec_next: 0.0,
            codec_source: None,
            classifier: CodecClassifier::default(),
            codec_result: None,
            codec_sampled_at: 0.0,
            codec_frame_age: 0.0,
            last: None,
            stop,
        })
    }

    pub fn close(&mut self) {
        self.classifier.reset();
        self.codec_source = None;
        self.codec_result = None;
        self.codec_next = 0.0;
        self.codec_sampled_at = 0.0;
        self.codec_frame_age = 0.0;
        self.last = None;
    }

    fn metadata(&self) -> Result<(serde_json::Value, PathBuf), SamplerError> {
        let mut errors = Vec::new();
        for path in &self.info_paths {
            match read_info(path, wall_now()) {
                Ok(value) => return Ok((value, path.clone())),
                Err(error) => errors.push(error),
            }
        }
        Err(errors.into_iter().next().unwrap_or_else(|| {
            SamplerError::new("telemetry-missing", "No driver telemetry paths were provided")
        }))
    }

    fn inspect_frame(
        &mut self,
        reader: &dyn ProcessReader,
        base: u64,
        image_size: u32,
        rva: u32,
        identity: &str,
        pid: u32,
        generation: u64,
    ) -> CodecDetection {
        let now = monotonic_now();
        if self.codec_source.as_deref() != Some(identity) {
            self.classifier.reset();
            self.codec_result = None;
            self.codec_next = 0.0;
            self.codec_source = Some(identity.to_string());
        }
        if now >= self.codec_next {
            self.codec_next = now + self.codec_interval;
            let tick = reader.ticks();
            match read_probe_frame(reader, base, image_size, rva, pid, tick, Slot::Latest, Some(MAX_COUNTER_AGE_MS)) {
                Ok(frame) => {
                    if frame.generation != generation {
                        self.codec_result = Some(unverified_codec("Encoder session changed during frame capture"));
                        self.codec_sampled_at = now;
                        self.codec_frame_age = 0.0;
                    } else {
                        let header_frame = read_probe_frame(
                            reader,
                            base,
                            image_size,
                            rva,
                            pid,
                            tick,
                            Slot::Keyframe,
                            None,
                        )
                        .ok()
                        .filter(|retained| retained.generation == generation && retained.complete)
                        .map(|retained| retained.data);
                        let classification = self.classifier.classify_frame(
                            &frame.data,
                            identity,
                            frame.complete,
                            header_frame.as_deref(),
                        );
                        let hash = sha256_bytes(&frame.data);
                        self.codec_frame_age = ((tick.saturating_sub(frame.tick_ms)) as f64) / 1000.0;
                        self.codec_sampled_at = now;
                        self.codec_result = Some(CodecDetection {
                            codec: classification.codec.map(str::to_string),
                            label: classification.label.to_string(),
                            evidence: classification.evidence,
                            age_seconds: 0.0,
                            frame_sha256: Some(hash),
                            frame_index: Some(frame.frame_index),
                            capture_id: Some(frame.capture_id),
                            generation: Some(frame.generation),
                            captured_tick_ms: Some(frame.tick_ms),
                            frame_bytes: Some(frame.full_size as u64),
                            sampled_at: super::wall_now(),
                        });
                    }
                }
                Err(error) => {
                    self.codec_result = Some(unverified_codec(error.detail));
                    self.codec_sampled_at = now;
                    self.codec_frame_age = 0.0;
                }
            }
        }
        let mut result = self
            .codec_result
            .clone()
            .unwrap_or_else(|| unverified_codec("Waiting for a captured frame"));
        result.age_seconds = (now - self.codec_sampled_at).max(0.0) + self.codec_frame_age;
        result
    }

    pub fn sample(&mut self) -> Result<Sample, SamplerError> {
        if self.stop.load(Ordering::SeqCst) {
            return Err(SamplerError::new("cancelled", "Sampling stopped."));
        }
        let (info, _) = self.metadata()?;
        let tap = info
            .get("encoderTap")
            .and_then(|value| value.as_object())
            .ok_or_else(|| SamplerError::new("telemetry-missing", "Current driver telemetry is missing or incomplete"))?;
        let runtime = info
            .get("runtime")
            .and_then(|value| value.as_object())
            .ok_or_else(|| SamplerError::new("telemetry-missing", "Current driver telemetry is missing or incomplete"))?;
        let pid = tap
            .get("pid")
            .and_then(|value| value.as_u64())
            .and_then(|value| u32::try_from(value).ok())
            .filter(|pid| *pid > 0)
            .ok_or_else(|| SamplerError::new("telemetry-missing", "Driver telemetry does not identify an active SteamVR process"))?;
        if runtime.get("processId").and_then(|value| value.as_u64()) != Some(pid as u64)
            || runtime.get("initialized").and_then(|value| value.as_bool()) != Some(true)
            || runtime.get("lockedOut").and_then(|value| value.as_bool()) == Some(true)
        {
            return Err(SamplerError::new(
                "not-initialized",
                "Driver telemetry does not identify an active SteamVR process",
            ));
        }
        if tap.get("enabled").and_then(|value| value.as_bool()) != Some(true)
            || tap.get("hookInstalled").and_then(|value| value.as_bool()) != Some(true)
        {
            return Err(SamplerError::new("counter-inactive", "The installed NVENC output counter is not active"));
        }
        if tap.get("encodeWidth").and_then(|value| value.as_u64()).unwrap_or(0) == 0
            || tap.get("encodeHeight").and_then(|value| value.as_u64()).unwrap_or(0) == 0
            || tap.get("effectiveCodec").and_then(|value| value.as_i64()).unwrap_or(-1) < 0
        {
            return Err(SamplerError::new("no-stream", "NVENC has not accepted a live stream yet"));
        }
        let module_path = tap
            .get("modulePath")
            .and_then(|value| value.as_str())
            .filter(|path| !path.is_empty())
            .ok_or_else(|| SamplerError::new("telemetry-missing", "Driver module path is missing from current telemetry"))?
            .to_string();

        let process = WindowsProcess::open(pid)?;
        let started = process.creation_time()?;
        let (base, image_size, loaded_path) = process.module(&module_path)?;
        let file_path = Path::new(&loaded_path);
        let before = fs::metadata(file_path)
            .map_err(|error| SamplerError::new("module-mismatch", format!("Cannot read the loaded driver image: {error}")))?;
        let digest = sha256_file(file_path)?;
        let after = fs::metadata(file_path)
            .map_err(|error| SamplerError::new("module-mismatch", format!("Cannot read the loaded driver image: {error}")))?;
        if (before.len(), modified_ns(&before)) != (after.len(), modified_ns(&after)) {
            return Err(SamplerError::new(
                "module-changed",
                "Driver DLL changed while validating its exact build",
            ));
        }
        let headers = process.read(base, 4096)?;
        let probe_rva = find_probe(&process, base, image_size, &headers)?;
        let (snapshot, measured_at, source_id, codec) = if let Some(rva) = probe_rva {
            let before_counter = monotonic_now();
            let counter = read_probe_counters(&process, base, image_size, rva, pid, process.ticks())?;
            let measured_at = (before_counter + monotonic_now()) / 2.0;
            let source_id = format!("nvenc:{pid}:{started}:{digest}:{base:x}:probe1:{}", counter.generation);
            let codec = self.inspect_frame(&process, base, image_size, rva, &source_id, pid, counter.generation);
            (
                CounterSnapshot { frames: counter.frames, total_bytes: counter.total_bytes },
                measured_at,
                source_id,
                codec,
            )
        } else {
            if digest != LEGACY_SHA256 {
                return Err(SamplerError::new(
                    "unsupported-build",
                    format!(
                        "Unsupported driver build for exact NVENC bytes (SHA-256 {}). An audited counter profile is required.",
                        &digest[..16.min(digest.len())]
                    ),
                ));
            }
            validate_image_profile(&headers, image_size, LEGACY_PROFILE)?;
            let (snapshot, measured_at) = stable_snapshot(&process, base + LEGACY_PROFILE.stats_rva as u64)?;
            (
                snapshot,
                measured_at,
                format!("nvenc:{pid}:{started}:{digest}:{base:x}:{:x}", LEGACY_PROFILE.stats_rva),
                unverified_codec(
                    "Installed driver has no frame snapshot export; updated driver and SteamVR restart required",
                ),
            )
        };
        if let Some((previous_source, previous_bytes, previous_frames)) = self.last.clone() {
            if previous_source == source_id
                && (snapshot.total_bytes < previous_bytes || snapshot.frames < previous_frames)
            {
                self.last = None;
                return Err(SamplerError::new(
                    "counter-regressed",
                    "NVENC cumulative counters moved backwards; baseline reset required",
                ));
            }
        }
        self.last = Some((source_id.clone(), snapshot.total_bytes, snapshot.frames));
        // Never return a valid counter after its freshness check has expired
        // during a slow filesystem or process operation.
        let (final_info, _) = self.metadata()?;
        let final_tap = final_info.get("encoderTap").and_then(|value| value.as_object());
        let final_pid = final_tap.and_then(|tap| tap.get("pid")).and_then(|value| value.as_u64());
        let final_path = final_tap.and_then(|tap| tap.get("modulePath")).and_then(|value| value.as_str());
        if final_pid != Some(pid as u64) || final_path.map(normalized_path) != Some(normalized_path(&loaded_path)) {
            return Err(SamplerError::new(
                "process-changed",
                "Driver process changed during sampling; waiting for a new baseline",
            ));
        }
        Ok(Sample {
            source_id,
            monotonic_time: measured_at,
            total_bytes: snapshot.total_bytes,
            frames: Some(snapshot.frames),
            kind: SampleKind::Nvenc,
            pid: Some(pid),
            module_sha256: Some(digest),
            serial: None,
            interface: None,
            codec: Some(codec),
        })
    }
}

fn unverified_codec(evidence: impl Into<String>) -> CodecDetection {
    CodecDetection {
        codec: None,
        label: "Unverified".into(),
        evidence: evidence.into(),
        age_seconds: 0.0,
        frame_sha256: None,
        frame_index: None,
        capture_id: None,
        generation: None,
        captured_tick_ms: None,
        frame_bytes: None,
        sampled_at: wall_now(),
    }
}

fn modified_ns(metadata: &fs::Metadata) -> u128 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or(0)
}

fn sha256_bytes(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}

fn sha256_file(path: &Path) -> Result<String, SamplerError> {
    let mut file = File::open(path)
        .map_err(|error| SamplerError::new("module-mismatch", format!("Cannot hash the loaded driver: {error}")))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| SamplerError::new("module-mismatch", format!("Cannot hash the loaded driver: {error}")))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn epoch_seconds(time: SystemTime) -> f64 {
    time.duration_since(UNIX_EPOCH).map(|duration| duration.as_secs_f64()).unwrap_or(0.0)
}

fn read_info(path: &Path, now: f64) -> Result<serde_json::Value, SamplerError> {
    let metadata = fs::metadata(path)
        .map_err(|_| SamplerError::new("telemetry-missing", "Current driver telemetry is missing or incomplete"))?;
    let modified = metadata
        .modified()
        .map(epoch_seconds)
        .map_err(|_| SamplerError::new("telemetry-missing", "Current driver telemetry is missing or incomplete"))?;
    if !(-2.0..=MAX_INFO_AGE).contains(&(now - modified)) {
        return Err(SamplerError::new("telemetry-stale", "Driver telemetry is stale; start a current stream"));
    }
    let text = fs::read_to_string(path)
        .map_err(|_| SamplerError::new("telemetry-missing", "Current driver telemetry is missing or incomplete"))?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    let data: serde_json::Value = serde_json::from_str(text)
        .map_err(|_| SamplerError::new("telemetry-missing", "Current driver telemetry is missing or incomplete"))?;
    let tap = data
        .get("encoderTap")
        .and_then(|value| value.as_object())
        .ok_or_else(|| SamplerError::new("telemetry-missing", "Current driver telemetry is missing or incomplete"))?;
    let observed_at = tap
        .get("observedAt")
        .and_then(|value| value.as_f64())
        .ok_or_else(|| SamplerError::new("telemetry-missing", "Encoder telemetry is stale; start a current stream"))?;
    if !(-2.0..=MAX_INFO_AGE).contains(&(now - observed_at / 1000.0)) {
        return Err(SamplerError::new("telemetry-stale", "Encoder telemetry is stale; start a current stream"));
    }
    Ok(data)
}

fn normalized_path(path: &str) -> String {
    let mut value = path.replace('/', "\\").to_lowercase();
    if let Some(rest) = value.strip_prefix("\\\\?\\unc\\") {
        value = format!("\\\\{rest}");
    } else if let Some(rest) = value.strip_prefix("\\\\?\\") {
        value = rest.to_string();
    } else if let Some(rest) = value.strip_prefix("\\\\.\\") {
        value = rest.to_string();
    }
    while value.ends_with('\\') {
        value.pop();
    }
    value
}

#[cfg(windows)]
struct WindowsProcess {
    handle: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
impl WindowsProcess {
    fn open(pid: u32) -> Result<Self, SamplerError> {
        use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ};
        let handle = unsafe { OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid) };
        if handle.is_null() {
            return Err(SamplerError::new(
                "access-denied",
                "Cannot read the current SteamVR process (closed or access denied)",
            ));
        }
        Ok(Self { handle })
    }

    fn creation_time(&self) -> Result<u64, SamplerError> {
        use windows_sys::Win32::Foundation::FILETIME;
        use windows_sys::Win32::System::Threading::GetProcessTimes;
        let mut creation = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
        let mut exited = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
        let mut kernel = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
        let mut user = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
        let ok = unsafe { GetProcessTimes(self.handle, &mut creation, &mut exited, &mut kernel, &mut user) };
        if ok == 0 {
            return Err(SamplerError::new(
                "process-unavailable",
                "Cannot validate the SteamVR process start time",
            ));
        }
        Ok(((creation.dwHighDateTime as u64) << 32) | creation.dwLowDateTime as u64)
    }

    fn module(&self, expected_path: &str) -> Result<(u64, u32, String), SamplerError> {
        use windows_sys::Win32::Foundation::HMODULE;
        use windows_sys::Win32::System::ProcessStatus::{
            EnumProcessModulesEx, GetModuleFileNameExW, GetModuleInformation, LIST_MODULES_ALL, MODULEINFO,
        };
        let mut modules: [HMODULE; 1024] = [std::ptr::null_mut(); 1024];
        let mut needed: u32 = 0;
        let ok = unsafe {
            EnumProcessModulesEx(
                self.handle,
                modules.as_mut_ptr(),
                std::mem::size_of_val(&modules) as u32,
                &mut needed,
                LIST_MODULES_ALL,
            )
        };
        if ok == 0 {
            return Err(SamplerError::new("process-unavailable", "Cannot enumerate the current SteamVR modules"));
        }
        if needed as usize > std::mem::size_of_val(&modules) {
            return Err(SamplerError::new(
                "process-unavailable",
                "SteamVR module inventory exceeded the supported bound",
            ));
        }
        let expected = normalized_path(expected_path);
        let count = needed as usize / std::mem::size_of::<HMODULE>();
        for module in modules.iter().take(count) {
            let mut buffer = vec![0u16; 32768];
            let length = unsafe { GetModuleFileNameExW(self.handle, *module, buffer.as_mut_ptr(), buffer.len() as u32) };
            if length == 0 || length as usize >= buffer.len() {
                continue;
            }
            let loaded = String::from_utf16_lossy(&buffer[..length as usize]);
            if normalized_path(&loaded) != expected {
                continue;
            }
            let mut info = MODULEINFO::default();
            let ok = unsafe {
                GetModuleInformation(self.handle, *module, &mut info, std::mem::size_of::<MODULEINFO>() as u32)
            };
            if ok == 0 {
                return Err(SamplerError::new("process-unavailable", "Cannot validate the loaded driver image"));
            }
            return Ok((info.lpBaseOfDll as usize as u64, info.SizeOfImage, loaded));
        }
        Err(SamplerError::new(
            "module-mismatch",
            "Telemetry driver DLL does not match a module in current SteamVR",
        ))
    }
}

#[cfg(windows)]
impl Drop for WindowsProcess {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.handle) };
    }
}

#[cfg(windows)]
impl ProcessReader for WindowsProcess {
    fn read(&self, address: u64, size: usize) -> Result<Vec<u8>, SamplerError> {
        use windows_sys::Win32::System::Diagnostics::Debug::ReadProcessMemory;
        let mut buffer = vec![0u8; size];
        let mut count: usize = 0;
        let ok = unsafe {
            ReadProcessMemory(
                self.handle,
                address as usize as *const core::ffi::c_void,
                buffer.as_mut_ptr() as *mut core::ffi::c_void,
                size,
                &mut count,
            )
        };
        if ok == 0 || count != size {
            return Err(SamplerError::new(
                "memory-unreadable",
                "NVENC counter is no longer readable (stream/process closed)",
            ));
        }
        Ok(buffer)
    }

    fn ticks(&self) -> u64 {
        unsafe { windows_sys::Win32::System::SystemInformation::GetTickCount64() }
    }
}

// The Companion targets Windows. Keeping a non-Windows fallback lets the pure
// parsing tests compile without asserting any sampler availability.
#[cfg(not(windows))]
struct WindowsProcess;

#[cfg(not(windows))]
impl WindowsProcess {
    fn open(_pid: u32) -> Result<Self, SamplerError> {
        Err(SamplerError::new("unsupported-platform", "NVENC memory sampling requires Windows"))
    }
    fn creation_time(&self) -> Result<u64, SamplerError> {
        Err(SamplerError::new("unsupported-platform", "NVENC memory sampling requires Windows"))
    }
    fn module(&self, _expected_path: &str) -> Result<(u64, u32, String), SamplerError> {
        Err(SamplerError::new("unsupported-platform", "NVENC memory sampling requires Windows"))
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Slot {
    Latest,
    Keyframe,
}

struct Section {
    name: String,
    rva: u32,
    size: u32,
    flags: u32,
}

struct PeImage {
    export_rva: u32,
    export_size: u32,
    sections: Vec<Section>,
}

fn check_range(image_size: u32, rva: u32, size: u64) -> Result<(), SamplerError> {
    if rva as u64 > image_size as u64 || size > image_size as u64 - rva as u64 {
        return Err(SamplerError::new("probe-unavailable", "Frame probe points outside the loaded driver image"));
    }
    Ok(())
}

fn parse_pe(headers: &[u8], image_size: u32) -> Result<PeImage, SamplerError> {
    let read_u16 = |offset: usize| -> Result<u16, SamplerError> {
        headers
            .get(offset..offset + 2)
            .map(|bytes| u16::from_le_bytes([bytes[0], bytes[1]]))
            .ok_or_else(|| SamplerError::new("probe-unavailable", "Unsupported or malformed frame probe PE headers"))
    };
    let read_u32 = |offset: usize| -> Result<u32, SamplerError> {
        headers
            .get(offset..offset + 4)
            .map(|bytes| u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
            .ok_or_else(|| SamplerError::new("probe-unavailable", "Unsupported or malformed frame probe PE headers"))
    };
    if headers.len() < 64 || &headers[..2] != b"MZ" {
        return Err(SamplerError::new("probe-unavailable", "Unsupported or malformed frame probe PE headers"));
    }
    let pe = read_u32(0x3C)? as usize;
    if headers.get(pe..pe + 4) != Some(b"PE\0\0") {
        return Err(SamplerError::new("probe-unavailable", "Unsupported or malformed frame probe PE headers"));
    }
    let machine = read_u16(pe + 4)?;
    let count = read_u16(pe + 6)? as usize;
    let optional_size = read_u16(pe + 20)? as usize;
    let optional = pe + 24;
    if machine != 0x8664
        || read_u16(optional)? != 0x20B
        || optional_size < 120
        || !(1..=96).contains(&count)
        || read_u32(optional + 56)? != image_size
    {
        return Err(SamplerError::new("probe-unavailable", "Unsupported or malformed frame probe PE headers"));
    }
    let table = optional + optional_size;
    if table + count * 40 > headers.len() {
        return Err(SamplerError::new("probe-unavailable", "Unsupported or malformed frame probe PE headers"));
    }
    let mut sections = Vec::with_capacity(count);
    for index in 0..count {
        let at = table + index * 40;
        let name_bytes = &headers[at..at + 8];
        let name = name_bytes
            .split(|byte| *byte == 0)
            .next()
            .map(|bytes| String::from_utf8_lossy(bytes).into_owned())
            .unwrap_or_default();
        let size = read_u32(at + 8)?;
        let rva = read_u32(at + 12)?;
        let flags = read_u32(at + 36)?;
        check_range(image_size, rva, size as u64)?;
        sections.push(Section { name, rva, size, flags });
    }
    let directories = read_u32(optional + 108)?;
    let (export_rva, export_size) = if directories == 0 {
        (0, 0)
    } else {
        (read_u32(optional + 112)?, read_u32(optional + 116)?)
    };
    Ok(PeImage { export_rva, export_size, sections })
}

fn read_at(reader: &dyn ProcessReader, base: u64, image_size: u32, rva: u32, size: usize) -> Result<Vec<u8>, SamplerError> {
    check_range(image_size, rva, size as u64)?;
    if size == 0 {
        return Ok(Vec::new());
    }
    reader.read(base + rva as u64, size)
}

fn find_probe(
    reader: &dyn ProcessReader,
    base: u64,
    image_size: u32,
    headers: &[u8],
) -> Result<Option<u32>, SamplerError> {
    let image = parse_pe(headers, image_size)?;
    if image.export_rva == 0 && image.export_size == 0 {
        return Ok(None);
    }
    if image.export_rva == 0 || image.export_size < 40 {
        return Err(SamplerError::new("probe-unavailable", "Malformed driver export directory"));
    }
    check_range(image_size, image.export_rva, image.export_size as u64)?;
    let directory = read_at(reader, base, image_size, image.export_rva, 40)?;
    let word = |offset: usize| -> u32 {
        u32::from_le_bytes([directory[offset], directory[offset + 1], directory[offset + 2], directory[offset + 3]])
    };
    let functions = word(20);
    let names = word(24);
    let function_table = word(28);
    let name_table = word(32);
    let ordinals = word(36);
    if functions == 0 || functions > 65536 || names > 4096 {
        return Err(SamplerError::new("probe-unavailable", "Unsupported driver export table bounds"));
    }
    if function_table == 0 || (names > 0 && (name_table == 0 || ordinals == 0)) {
        return Err(SamplerError::new("probe-unavailable", "Driver export table address is missing"));
    }
    check_range(image_size, function_table, functions as u64 * 4)?;
    check_range(image_size, name_table, names as u64 * 4)?;
    check_range(image_size, ordinals, names as u64 * 2)?;
    if names == 0 {
        return Ok(None);
    }
    let name_addresses = read_at(reader, base, image_size, name_table, names as usize * 4)?;
    let ordinal_values = read_at(reader, base, image_size, ordinals, names as usize * 2)?;
    for index in 0..names as usize {
        let name_rva = u32::from_le_bytes([
            name_addresses[index * 4],
            name_addresses[index * 4 + 1],
            name_addresses[index * 4 + 2],
            name_addresses[index * 4 + 3],
        ]);
        if name_rva == 0 {
            return Err(SamplerError::new("probe-unavailable", "Driver export name address is missing"));
        }
        check_range(image_size, name_rva, 1)?;
        let available = (image_size - name_rva) as usize;
        if available < PROBE_EXPORT.len() {
            continue;
        }
        let name = read_at(reader, base, image_size, name_rva, PROBE_EXPORT.len())?;
        if name.as_slice() != PROBE_EXPORT {
            continue;
        }
        let ordinal = u16::from_le_bytes([ordinal_values[index * 2], ordinal_values[index * 2 + 1]]) as u32;
        if ordinal >= functions {
            return Err(SamplerError::new("probe-unavailable", "Frame probe export ordinal is invalid"));
        }
        let address = read_at(reader, base, image_size, function_table + ordinal * 4, 4)?;
        let rva = u32::from_le_bytes([address[0], address[1], address[2], address[3]]);
        if image.export_rva <= rva && rva < image.export_rva.saturating_add(image.export_size) {
            return Err(SamplerError::new("probe-unavailable", "Forwarded frame probe exports are unsupported"));
        }
        check_range(image_size, rva, PROBE_SIZE as u64)?;
        let writable = image.sections.iter().any(|section| {
            if rva < section.rva { return false; }
            let offset = (rva - section.rva) as u64;
            offset < section.size as u64
                && (PROBE_SIZE as u64) <= section.size as u64 - offset
                && section.flags & 0xC0000000 == 0xC0000000
        });
        if !writable {
            return Err(SamplerError::new(
                "probe-unavailable",
                "Frame probe export does not fit in a writable driver section",
            ));
        }
        return Ok(Some(rva));
    }
    Ok(None)
}

fn validate_image_profile(headers: &[u8], image_size: u32, profile: StatsProfile) -> Result<(), SamplerError> {
    let image = parse_pe(headers, image_size)?;
    let Some(section) = image.sections.iter().find(|section| section.name == profile.section_name) else {
        return Err(SamplerError::new(
            "probe-unavailable",
            "Loaded driver PE layout does not match the audited counter profile",
        ));
    };
    if section.rva != profile.section_rva
        || section.size != profile.section_size
        || section.flags & 0xC0000000 != 0xC0000000
        || section.rva > profile.stats_rva
        || profile.stats_rva as u64 + PREFIX_SIZE as u64 > section.rva as u64 + section.size as u64
        || section.rva as u64 + section.size as u64 > image_size as u64
    {
        return Err(SamplerError::new(
            "probe-unavailable",
            "Loaded driver PE layout does not match the audited counter profile",
        ));
    }
    Ok(())
}

fn decode_counter_prefix(data: &[u8]) -> Result<CounterSnapshot, SamplerError> {
    if data.len() != PREFIX_SIZE {
        return Err(SamplerError::new("counter-unstable", "Incomplete NVENC counter read"));
    }
    let mut words = [0u32; 25];
    for (index, word) in words.iter_mut().enumerate() {
        *word = u32::from_le_bytes([
            data[index * 4],
            data[index * 4 + 1],
            data[index * 4 + 2],
            data[index * 4 + 3],
        ]);
    }
    let total_bytes = u64::from_le_bytes(data[104..112].try_into().expect("counter tail"));
    let frames = words[11] as u64;
    let maximum = words[12] as u64;
    let maximum_idr = words[13] as u64;
    let last = words[14] as u64;
    let idrs = words[15] as u64;
    if !(1..=1_000_000).contains(&words[0]) || words[9] == 0 {
        return Err(SamplerError::new(
            "probe-unavailable",
            "NVENC counter header does not match its audited layout",
        ));
    }
    if frames == 0 || frames > words[10] as u64 || maximum == 0 || maximum > 128 * 1024 * 1024 {
        return Err(SamplerError::new("probe-unavailable", "NVENC has no validated completed encoded frames"));
    }
    if words[16..23].iter().map(|value| *value as u64).sum::<u64>() != frames {
        return Err(SamplerError::new("counter-unstable", "NVENC counter snapshot changed during sampling"));
    }
    if maximum_idr > maximum || last > maximum || idrs > frames {
        return Err(SamplerError::new("probe-unavailable", "NVENC frame-size counters are inconsistent"));
    }
    if maximum > total_bytes || total_bytes > frames * maximum {
        return Err(SamplerError::new("probe-unavailable", "NVENC byte counter is inconsistent"));
    }
    if words[23] > words[24] || words[24] > 255 {
        return Err(SamplerError::new("probe-unavailable", "NVENC QP counters are inconsistent"));
    }
    Ok(CounterSnapshot { frames, total_bytes })
}

fn stable_snapshot(reader: &dyn ProcessReader, address: u64) -> Result<(CounterSnapshot, f64), SamplerError> {
    for _ in 0..8 {
        let before = monotonic_now();
        let first = reader.read(address, PREFIX_SIZE)?;
        let second = reader.read(address, PREFIX_SIZE)?;
        let after = monotonic_now();
        if first == second {
            if let Ok(snapshot) = decode_counter_prefix(&first) {
                return Ok((snapshot, (before + after) / 2.0));
            }
        }
    }
    Err(SamplerError::new(
        "counter-unstable",
        "NVENC counter changed during sampling; waiting for a consistent read",
    ))
}

fn read_probe_counters(
    reader: &dyn ProcessReader,
    base: u64,
    image_size: u32,
    rva: u32,
    expected_pid: u32,
    now_ms: u64,
) -> Result<ProbeCounters, SamplerError> {
    check_range(image_size, rva, PROBE_SIZE as u64)?;
    let last = "NVENC frame probe counters changed during sampling".to_string();
    for _ in 0..RETRIES {
        let first = read_at(reader, base, image_size, rva, PROBE_HEADER_BYTES)?;
        let sequence = u64::from_le_bytes(first[32..40].try_into().expect("counter sequence"));
        if sequence & 1 != 0 {
            continue;
        }
        let second = read_at(reader, base, image_size, rva, PROBE_HEADER_BYTES)?;
        if first != second {
            continue;
        }
        let magic = u64::from_le_bytes(first[0..8].try_into().expect("probe magic"));
        let abi = u32::from_le_bytes(first[8..12].try_into().expect("probe abi"));
        let header_bytes = u32::from_le_bytes(first[12..16].try_into().expect("probe header"));
        let capacity = u32::from_le_bytes(first[16..20].try_into().expect("probe capacity"));
        let slot_bytes = u32::from_le_bytes(first[20..24].try_into().expect("probe slot"));
        let pid = u32::from_le_bytes(first[24..28].try_into().expect("probe pid"));
        let flags = u32::from_le_bytes(first[28..32].try_into().expect("probe flags"));
        let frames = u64::from_le_bytes(first[40..48].try_into().expect("probe frames"));
        let total_bytes = u64::from_le_bytes(first[48..56].try_into().expect("probe bytes"));
        let tick_ms = u64::from_le_bytes(first[56..64].try_into().expect("probe tick"));
        let generation = u64::from_le_bytes(first[64..72].try_into().expect("probe generation"));
        if magic != PROBE_MAGIC
            || abi != PROBE_ABI
            || header_bytes as usize != PROBE_HEADER_BYTES
            || capacity as usize != PROBE_CAPACITY
            || slot_bytes as usize != PROBE_SLOT_BYTES
        {
            return Err(SamplerError::new("probe-unavailable", "Unsupported NVENC frame probe ABI"));
        }
        if pid != expected_pid || pid == 0 {
            return Err(SamplerError::new(
                "probe-unavailable",
                "Frame probe does not belong to current SteamVR",
            ));
        }
        if flags != 1 || sequence == 0 || sequence & 1 != 0 || frames == 0 || total_bytes == 0 || generation == 0 {
            return Err(SamplerError::new(
                "probe-unavailable",
                "NVENC frame probe has not published coherent live counters",
            ));
        }
        let age = now_ms as i128 - tick_ms as i128;
        if !(-1000..=MAX_COUNTER_AGE_MS).contains(&age) {
            return Err(SamplerError::new("probe-unavailable", "NVENC frame probe counters are stale"));
        }
        return Ok(ProbeCounters { frames, total_bytes, generation, tick_ms });
    }
    Err(SamplerError::new("probe-unavailable", last))
}

fn read_probe_frame(
    reader: &dyn ProcessReader,
    base: u64,
    image_size: u32,
    rva: u32,
    expected_pid: u32,
    now_ms: u64,
    slot: Slot,
    max_age_ms: Option<i128>,
) -> Result<ProbeFrame, SamplerError> {
    if max_age_ms.is_none() && slot != Slot::Keyframe {
        return Err(SamplerError::new(
            "probe-unavailable",
            "Only retained keyframe context may omit the age bound",
        ));
    }
    let offset = rva + PROBE_HEADER_BYTES as u32 + if slot == Slot::Keyframe { PROBE_SLOT_BYTES as u32 } else { 0 };
    let mut last = "Frame snapshot changed during sampling".to_string();
    for _ in 0..RETRIES {
        let header = read_probe_counters(reader, base, image_size, rva, expected_pid, now_ms)?;
        let first = read_at(reader, base, image_size, offset, 64)?;
        let sequence = u64::from_le_bytes(first[0..8].try_into().expect("slot sequence"));
        let tick = u64::from_le_bytes(first[8..16].try_into().expect("slot tick"));
        let generation = u64::from_le_bytes(first[16..24].try_into().expect("slot generation"));
        let frame_index = u64::from_le_bytes(first[24..32].try_into().expect("slot frame index"));
        let full = u32::from_le_bytes(first[32..36].try_into().expect("slot full"));
        let copied = u32::from_le_bytes(first[36..40].try_into().expect("slot copied"));
        let flags = u32::from_le_bytes(first[40..44].try_into().expect("slot flags"));
        let capture_id = u64::from_le_bytes(first[48..56].try_into().expect("slot capture"));
        if sequence & 1 != 0 {
            continue;
        }
        if sequence == 0 || flags & 1 == 0 || full == 0 || copied == 0 || capture_id == 0 {
            return Err(SamplerError::new("probe-unavailable", "No encoded frame snapshot is available yet"));
        }
        let expected_copied = full.min(PROBE_CAPACITY as u32);
        let truncated = full as usize > PROBE_CAPACITY;
        if flags & !7 != 0
            || copied != expected_copied
            || (flags & 2 != 0) != truncated
            || (slot == Slot::Keyframe && flags & 4 == 0)
        {
            return Err(SamplerError::new(
                "probe-unavailable",
                "Frame snapshot length or flags are inconsistent",
            ));
        }
        if generation != header.generation {
            last = "Frame snapshot belongs to a previous stream generation".into();
            continue;
        }
        if tick > header.tick_ms || (now_ms as i128 - tick as i128) < -1000 {
            return Err(SamplerError::new(
                "probe-unavailable",
                "Frame snapshot timestamp is inconsistent",
            ));
        }
        if let Some(max_age) = max_age_ms {
            if now_ms as i128 - tick as i128 > max_age {
                return Err(SamplerError::new("probe-unavailable", "Encoded frame snapshot is stale"));
            }
        }
        let data = read_at(reader, base, image_size, offset + 64, copied as usize)?;
        let second = read_at(reader, base, image_size, offset, 64)?;
        if first != second {
            continue;
        }
        let final_counters = read_probe_counters(reader, base, image_size, rva, expected_pid, now_ms)?;
        if final_counters.generation != generation {
            last = "Stream generation changed while reading encoded frame bytes".into();
            continue;
        }
        return Ok(ProbeFrame {
            data,
            full_size: full,
            complete: flags & 2 == 0 && copied == full,
            tick_ms: tick,
            generation,
            frame_index,
            capture_id,
        });
    }
    Err(SamplerError::new("probe-unavailable", last))
}

#[cfg(test)]
mod tests {
    use super::{
        decode_counter_prefix, find_probe, read_probe_counters, read_probe_frame, ProcessReader, SamplerError, Slot,
        PREFIX_SIZE, PROBE_CAPACITY, PROBE_EXPORT, PROBE_HEADER_BYTES, PROBE_MAGIC, PROBE_SLOT_BYTES,
    };

    const BASE: u64 = 0x7FFF_0000_0000;
    const IMAGE_SIZE: u32 = 0x500000;
    const PROBE_RVA: u32 = 0x10000;
    const PID: u32 = 1234;
    const NOW: u64 = 1_000_000;

    struct Image {
        memory: Vec<u8>,
    }

    impl Image {
        fn new() -> Self {
            let mut image = Self { memory: vec![0; IMAGE_SIZE as usize] };
            image.memory[..2].copy_from_slice(b"MZ");
            image.put_u32(0x3C, 0x80);
            image.memory[0x80..0x84].copy_from_slice(b"PE\0\0");
            image.put_u16(0x84, 0x8664);
            image.put_u16(0x86, 2);
            image.put_u16(0x94, 240);
            let optional = 0x98;
            image.put_u16(optional, 0x20B);
            image.put_u32(optional + 56, IMAGE_SIZE);
            image.put_u32(optional + 108, 16);
            image.put_u32(optional + 112, 0x2000);
            image.put_u32(optional + 116, 0x200);
            let sections = [
                (".rdata", 0x1000u32, 0x8000u32, 0x40000040u32),
                (".data", PROBE_RVA, super::PROBE_SIZE as u32, 0xC0000040),
            ];
            for (index, (name, rva, size, flags)) in sections.into_iter().enumerate() {
                let at = optional + 240 + index * 40;
                image.memory[at..at + name.len()].copy_from_slice(name.as_bytes());
                image.put_u32(at + 8, size);
                image.put_u32(at + 12, rva);
                image.put_u32(at + 36, flags);
            }
            image.put_u32(0x2000 + 20, 1);
            image.put_u32(0x2000 + 24, 1);
            image.put_u32(0x2000 + 28, 0x2100);
            image.put_u32(0x2000 + 32, 0x2110);
            image.put_u32(0x2000 + 36, 0x2120);
            image.put_u32(0x2100, PROBE_RVA);
            image.put_u32(0x2110, 0x2130);
            image.put_u16(0x2120, 0);
            image.memory[0x2130..0x2130 + PROBE_EXPORT.len()].copy_from_slice(PROBE_EXPORT);
            image.header(7, 22, PID, NOW - 10, (1 << 33) + 5, (1 << 50) + 9);
            image
        }

        fn put_u16(&mut self, at: usize, value: u16) {
            self.memory[at..at + 2].copy_from_slice(&value.to_le_bytes());
        }
        fn put_u32(&mut self, at: usize, value: u32) {
            self.memory[at..at + 4].copy_from_slice(&value.to_le_bytes());
        }
        fn put_u64(&mut self, at: usize, value: u64) {
            self.memory[at..at + 8].copy_from_slice(&value.to_le_bytes());
        }
        fn header(&mut self, generation: u64, sequence: u64, pid: u32, tick: u64, frames: u64, total: u64) {
            let at = PROBE_RVA as usize;
            self.put_u64(at, PROBE_MAGIC);
            self.put_u32(at + 8, 1);
            self.put_u32(at + 12, PROBE_HEADER_BYTES as u32);
            self.put_u32(at + 16, PROBE_CAPACITY as u32);
            self.put_u32(at + 20, PROBE_SLOT_BYTES as u32);
            self.put_u32(at + 24, pid);
            self.put_u32(at + 28, 1);
            self.put_u64(at + 32, sequence);
            self.put_u64(at + 40, frames);
            self.put_u64(at + 48, total);
            self.put_u64(at + 56, tick);
            self.put_u64(at + 64, generation);
        }
        fn frame(&mut self, data: &[u8], slot: Slot, generation: u64, tick: u64, flags: u32) {
            let offset = PROBE_RVA as usize + PROBE_HEADER_BYTES + if slot == Slot::Keyframe { PROBE_SLOT_BYTES } else { 0 };
            self.put_u64(offset, 8);
            self.put_u64(offset + 8, tick);
            self.put_u64(offset + 16, generation);
            self.put_u64(offset + 24, 0x1_0000_0001);
            self.put_u32(offset + 32, data.len() as u32);
            self.put_u32(offset + 36, data.len() as u32);
            self.put_u32(offset + 40, flags);
            self.put_u64(offset + 48, 41);
            self.memory[offset + 64..offset + 64 + data.len()].copy_from_slice(data);
        }
        fn headers(&self) -> Vec<u8> {
            self.memory[..4096].to_vec()
        }
    }

    impl ProcessReader for Image {
        fn read(&self, address: u64, size: usize) -> Result<Vec<u8>, SamplerError> {
            let rva = (address - BASE) as usize;
            if rva + size > self.memory.len() {
                return Err(SamplerError::new("probe-unavailable", "test read outside image"));
            }
            Ok(self.memory[rva..rva + size].to_vec())
        }
        fn ticks(&self) -> u64 {
            NOW
        }
    }

    #[test]
    fn finds_named_writable_data_export() {
        let image = Image::new();
        assert_eq!(find_probe(&image, BASE, IMAGE_SIZE, &image.headers()).unwrap(), Some(PROBE_RVA));
    }

    #[test]
    fn absent_or_unrelated_exports_are_not_invented() {
        let mut image = Image::new();
        image.put_u32(0x98 + 112, 0);
        image.put_u32(0x98 + 116, 0);
        assert_eq!(find_probe(&image, BASE, IMAGE_SIZE, &image.headers()).unwrap(), None);
        let mut image = Image::new();
        image.memory[0x2130..0x2138].copy_from_slice(b"Other\0\0\0");
        assert_eq!(find_probe(&image, BASE, IMAGE_SIZE, &image.headers()).unwrap(), None);
    }

    #[test]
    fn counters_and_frame_slots_are_coherent() {
        let mut image = Image::new();
        image.frame(b"current frame", Slot::Latest, 7, NOW - 100, 1);
        image.frame(b"header frame", Slot::Keyframe, 7, NOW - 60_000, 5);
        let counters = read_probe_counters(&image, BASE, IMAGE_SIZE, PROBE_RVA, PID, NOW).unwrap();
        assert_eq!(counters.frames, (1 << 33) + 5);
        let frame = read_probe_frame(&image, BASE, IMAGE_SIZE, PROBE_RVA, PID, NOW, Slot::Latest, Some(6000)).unwrap();
        assert_eq!(frame.data, b"current frame");
        assert!(frame.complete);
        let retained = read_probe_frame(&image, BASE, IMAGE_SIZE, PROBE_RVA, PID, NOW, Slot::Keyframe, None).unwrap();
        assert_eq!(retained.data, b"header frame");
    }

    #[test]
    fn stale_wrong_process_and_odd_sequences_are_unavailable() {
        let mut image = Image::new();
        image.header(7, 22, PID, NOW - 6001, (1 << 33) + 5, (1 << 50) + 9);
        assert!(read_probe_counters(&image, BASE, IMAGE_SIZE, PROBE_RVA, PID, NOW).is_err());
        let mut image = Image::new();
        image.header(7, 22, 9, NOW - 10, (1 << 33) + 5, (1 << 50) + 9);
        assert!(read_probe_counters(&image, BASE, IMAGE_SIZE, PROBE_RVA, PID, NOW).is_err());
        let mut image = Image::new();
        image.header(7, 21, PID, NOW - 10, (1 << 33) + 5, (1 << 50) + 9);
        assert!(read_probe_counters(&image, BASE, IMAGE_SIZE, PROBE_RVA, PID, NOW).is_err());
    }

    #[test]
    fn stale_or_previous_generation_frames_are_rejected() {
        let mut image = Image::new();
        image.frame(b"stale frame", Slot::Latest, 7, NOW - 6001, 1);
        assert!(read_probe_frame(&image, BASE, IMAGE_SIZE, PROBE_RVA, PID, NOW, Slot::Latest, Some(6000)).is_err());
        let mut image = Image::new();
        image.frame(b"old generation", Slot::Latest, 6, NOW - 100, 1);
        assert!(read_probe_frame(&image, BASE, IMAGE_SIZE, PROBE_RVA, PID, NOW, Slot::Latest, Some(6000)).is_err());
    }

    #[test]
    fn forwarded_or_nonwritable_probe_exports_are_rejected() {
        let mut image = Image::new();
        image.put_u32(0x2100, 0x2050);
        assert!(find_probe(&image, BASE, IMAGE_SIZE, &image.headers()).is_err());
        let mut image = Image::new();
        let data_section = 0x98 + 240 + 40;
        image.put_u32(data_section + 36, 0x40000040);
        assert!(find_probe(&image, BASE, IMAGE_SIZE, &image.headers()).is_err());
    }

    #[test]
    fn legacy_prefix_requires_consistent_counters() {
        let mut data = vec![0u8; PREFIX_SIZE];
        let mut put = |offset: usize, value: u32| data[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
        put(0, 1);       // words[0] layout marker
        put(36, 1);      // words[9] heartbeat
        put(40, 4);      // words[10] total encode calls
        put(44, 4);      // words[11] completed frames
        put(48, 100);    // words[12] maximum frame bytes
        put(52, 50);     // words[13] maximum IDR bytes
        put(56, 50);     // words[14] last frame bytes
        put(60, 2);      // words[15] IDR frames
        put(64, 1);      // words[16..23] size buckets sum to frames
        put(68, 1);
        put(72, 1);
        put(76, 1);
        put(92, 10);     // words[23] min QP
        put(96, 10);     // words[24] max QP
        data[104..112].copy_from_slice(&100u64.to_le_bytes());
        let snapshot = decode_counter_prefix(&data).unwrap();
        assert_eq!(snapshot.frames, 4);
        assert_eq!(snapshot.total_bytes, 100);
        data[36] = 0;
        assert!(decode_counter_prefix(&data).is_err());
    }
}
