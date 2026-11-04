//! Read-only Windows GPU capability probe for the Companion.
//!
//! Enumerates DXGI hardware adapters (through the `windows` crate's COM
//! bindings, never hand-written vtables), loads the NVIDIA libraries only from
//! System32, and reports adapter-level hints. No encoder session or D3D device
//! is created and no host setting is changed.
//!
//! Evidence rules (owner policy: a missing answer is "unknown", never "no"):
//! * A failed or ambiguous query leaves the field absent. It is never turned
//!   into `false`, an empty GPU list, or a union of unrelated adapters.
//! * `nvmlDeviceGetEncoderCapacity` reports *current* capacity. A value above
//!   zero proves the codec is encodable; zero or an error proves nothing.
//! * Dimensions, engine counts, presets, split-frame and 10-bit support are not
//!   guessed from the architecture. The running session reports them.
//! * Only hardware-generation facts that are certain are published as `false`
//!   (no AV1 encode before Ada, no Optical Flow engine before Turing, and the
//!   confirmed TU117 device IDs).

use serde::Serialize;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct CodecCaps {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supported: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ten_bit: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engines: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub presets: Option<Vec<u32>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub split: Option<bool>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Codecs {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub h264: Option<CodecCaps>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hevc: Option<CodecCaps>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub av1: Option<CodecCaps>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AdapterCapabilities {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adapter_luid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gpu_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vendor_id: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_version: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codecs: Option<Codecs>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nvenc: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub optical_flow: Option<bool>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GpuCapabilities {
    pub adapters: Vec<AdapterCapabilities>,
    pub checked_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

const NVIDIA_VENDOR_ID: u32 = 0x10DE;

fn checked_at_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

// ---------------------------------------------------------------------------
// Cache. The slot lock is only ever held for a clone/assignment, never across
// a probe, so a cache-only read can never wait on NVML.
// ---------------------------------------------------------------------------

const CACHE_TTL: Duration = Duration::from_secs(5);

struct ProbeCache {
    slot: Mutex<Option<(Instant, GpuCapabilities)>>,
    /// Serialises probes so concurrent callers share one result.
    gate: Mutex<()>,
}

impl ProbeCache {
    const fn new() -> Self {
        Self {
            slot: Mutex::new(None),
            gate: Mutex::new(()),
        }
    }

    /// Last stored result regardless of age. Never probes, never blocks on one.
    fn last_known(&self) -> Option<GpuCapabilities> {
        lock(&self.slot).as_ref().map(|(_, caps)| caps.clone())
    }

    fn fresh(&self, ttl: Duration) -> Option<GpuCapabilities> {
        lock(&self.slot)
            .as_ref()
            .filter(|(at, _)| at.elapsed() < ttl)
            .map(|(_, caps)| caps.clone())
    }

    fn get_or_probe(&self, ttl: Duration, probe: impl FnOnce() -> GpuCapabilities) -> GpuCapabilities {
        if let Some(caps) = self.fresh(ttl) {
            return caps;
        }
        let _gate = lock(&self.gate);
        if let Some(caps) = self.fresh(ttl) {
            return caps;
        }
        let caps = probe();
        *lock(&self.slot) = Some((Instant::now(), caps.clone()));
        caps
    }
}

static CACHE: ProbeCache = ProbeCache::new();

/// Probe (or reuse a result younger than the TTL). May block for the duration
/// of an NVML query: call it from the blocking pool, never from the UI thread.
pub fn get_cached_gpu_capabilities() -> GpuCapabilities {
    CACHE.get_or_probe(CACHE_TTL, probe_gpu_capabilities)
}

/// The most recent probe result, or `None` when nothing has been probed yet.
/// Never probes and never waits on a probe, so it is safe on the UI thread.
pub fn last_known_gpu_capabilities() -> Option<GpuCapabilities> {
    CACHE.last_known()
}

/// True only when the report proves Optical Flow is unavailable: the probe
/// succeeded, found at least one adapter, and every adapter is explicitly
/// `false`. An error, an empty list, or any unknown/true adapter never refuses.
pub fn optical_flow_known_unsupported(caps: &GpuCapabilities) -> bool {
    caps.error.is_none()
        && !caps.adapters.is_empty()
        && caps.adapters.iter().all(|adapter| adapter.optical_flow == Some(false))
}

/// Tauri command exposed to the Companion front end. The native work runs on
/// the blocking pool.
#[tauri::command]
pub async fn get_gpu_capabilities() -> GpuCapabilities {
    match tauri::async_runtime::spawn_blocking(get_cached_gpu_capabilities).await {
        Ok(caps) => caps,
        Err(error) => GpuCapabilities {
            adapters: Vec::new(),
            checked_at: checked_at_now(),
            error: Some(format!("GPU probe task failed: {error}")),
        },
    }
}

// ---------------------------------------------------------------------------
// Pure evidence logic (platform independent, unit tested).
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub(crate) struct DxgiAdapterInfo {
    pub(crate) luid: String,
    pub(crate) name: String,
    pub(crate) vendor_id: u32,
    pub(crate) device_id: u32,
    pub(crate) sub_sys_id: u32,
}

/// NVML architecture. Values are from nvml.h (`NVML_DEVICE_ARCH_*`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Arch {
    Kepler,
    Maxwell,
    Pascal,
    Volta,
    Turing,
    Ampere,
    Ada,
    Hopper,
    Blackwell,
    /// Anything NVML does not name in the values above (newer or non-desktop).
    Unknown,
}

pub(crate) fn arch_from_nvml(value: u32) -> Arch {
    match value {
        2 => Arch::Kepler,
        3 => Arch::Maxwell,
        4 => Arch::Pascal,
        5 => Arch::Volta,
        6 => Arch::Turing,
        7 => Arch::Ampere,
        8 => Arch::Ada,
        9 => Arch::Hopper,
        10 => Arch::Blackwell,
        _ => Arch::Unknown,
    }
}

/// `None` means the query failed. `Some(0)` means no free capacity right now,
/// which is not evidence of missing hardware.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct EncoderCapacity {
    pub(crate) h264: Option<u32>,
    pub(crate) hevc: Option<u32>,
    pub(crate) av1: Option<u32>,
}

#[derive(Clone, Debug)]
pub(crate) struct NvmlDeviceInfo {
    pub(crate) device_id: u32,
    pub(crate) sub_sys_id: u32,
    pub(crate) arch: Arch,
    pub(crate) capacity: EncoderCapacity,
}

/// Result of the NVML enumeration. `total` is the device count NVML reported,
/// even when some devices could not be read, so "only one GPU" is never
/// concluded from a partial list.
#[derive(Clone, Debug, Default)]
pub(crate) struct NvmlInventory {
    pub(crate) total: u32,
    pub(crate) devices: Vec<NvmlDeviceInfo>,
}

/// Confirmed TU117 PCI device IDs (no Optical Flow engine). Other Turing
/// parts are left unknown rather than assumed.
const TU117_DEVICE_IDS: &[u32] = &[
    0x1F82, 0x1F83, 0x1F91, 0x1F95, 0x1F96, 0x1F97, 0x1F98, 0x1F99, 0x1F9C, 0x1F9D, 0x1F9F, 0x1FA0,
    0x1FB0, 0x1FB1, 0x1FB2, 0x1FB6, 0x1FB7, 0x1FB8, 0x1FB9, 0x1FBA, 0x1FBB, 0x1FBC, 0x1FDD, 0x1FF0,
    0x1FF2, 0x1FF9,
];

pub(crate) fn is_tu117(device_id: u32) -> bool {
    TU117_DEVICE_IDS.contains(&device_id)
}

/// AV1 encode first shipped with Ada.
fn arch_lacks_av1_encode(arch: Arch) -> bool {
    matches!(
        arch,
        Arch::Kepler | Arch::Maxwell | Arch::Pascal | Arch::Volta | Arch::Turing | Arch::Ampere
    )
}

/// The Optical Flow accelerator first shipped with Turing.
fn arch_lacks_optical_flow(arch: Arch) -> bool {
    matches!(arch, Arch::Kepler | Arch::Maxwell | Arch::Pascal | Arch::Volta)
}

fn codec_caps(capacity: Option<u32>, known_unsupported: bool) -> Option<CodecCaps> {
    if capacity.is_some_and(|value| value > 0) {
        Some(CodecCaps {
            supported: Some(true),
            ..Default::default()
        })
    } else if known_unsupported {
        Some(CodecCaps {
            supported: Some(false),
            ..Default::default()
        })
    } else {
        None
    }
}

fn build_codecs(device: &NvmlDeviceInfo) -> Option<Codecs> {
    let codecs = Codecs {
        h264: codec_caps(device.capacity.h264, false),
        hevc: codec_caps(device.capacity.hevc, false),
        av1: codec_caps(device.capacity.av1, arch_lacks_av1_encode(device.arch)),
    };
    if codecs.h264.is_none() && codecs.hevc.is_none() && codecs.av1.is_none() {
        None
    } else {
        Some(codecs)
    }
}

fn build_adapter(
    dxgi: &DxgiAdapterInfo,
    nvml: Option<&NvmlDeviceInfo>,
    nvenc_api_version: Option<u32>,
) -> AdapterCapabilities {
    let mut adapter = AdapterCapabilities {
        adapter_luid: Some(dxgi.luid.clone()),
        gpu_name: Some(dxgi.name.clone()).filter(|name| !name.is_empty()),
        vendor_id: Some(dxgi.vendor_id),
        ..Default::default()
    };

    if dxgi.vendor_id != NVIDIA_VENDOR_ID {
        // NVENC and NVIDIA Optical Flow only exist on NVIDIA hardware.
        adapter.nvenc = Some(false);
        adapter.optical_flow = Some(false);
        return adapter;
    }

    adapter.api_version = nvenc_api_version;

    // The PCI device ID is per adapter, so the TU117 exclusion needs no
    // NVML correlation.
    if is_tu117(dxgi.device_id) {
        adapter.optical_flow = Some(false);
    }

    if let Some(device) = nvml {
        let any_capacity = [device.capacity.h264, device.capacity.hevc, device.capacity.av1]
            .iter()
            .any(|value| value.is_some_and(|capacity| capacity > 0));
        if any_capacity {
            adapter.nvenc = Some(true);
        }
        if adapter.optical_flow.is_none() && arch_lacks_optical_flow(device.arch) {
            adapter.optical_flow = Some(false);
        }
        adapter.codecs = build_codecs(device);
    }
    adapter
}

/// Pair DXGI adapters with NVML devices only when the pairing is certain.
pub(crate) fn merge_adapters(
    dxgi: &[DxgiAdapterInfo],
    nvml: &NvmlInventory,
    nvenc_api_version: Option<u32>,
) -> Vec<AdapterCapabilities> {
    let nvidia_adapters: Vec<&DxgiAdapterInfo> =
        dxgi.iter().filter(|adapter| adapter.vendor_id == NVIDIA_VENDOR_ID).collect();
    let single = nvidia_adapters.len() == 1 && nvml.total == 1 && nvml.devices.len() == 1;

    dxgi.iter()
        .map(|adapter| {
            if adapter.vendor_id != NVIDIA_VENDOR_ID {
                return build_adapter(adapter, None, nvenc_api_version);
            }

            let device = if single {
                nvml.devices.first().filter(|device| device.device_id == adapter.device_id)
            } else if nvml.total as usize == nvml.devices.len() {
                let same_adapters = nvidia_adapters
                    .iter()
                    .filter(|other| other.device_id == adapter.device_id && other.sub_sys_id == adapter.sub_sys_id)
                    .count();
                let matches: Vec<&NvmlDeviceInfo> = nvml
                    .devices
                    .iter()
                    .filter(|device| device.device_id == adapter.device_id && device.sub_sys_id == adapter.sub_sys_id)
                    .collect();
                // Identical GPUs cannot be told apart by PCI IDs, and DXGI
                // and NVML enumeration orders are unrelated: leave unknown.
                if same_adapters == 1 && matches.len() == 1 {
                    Some(matches[0])
                } else {
                    None
                }
            } else {
                None
            };
            build_adapter(adapter, device, nvenc_api_version)
        })
        .collect()
}

fn format_luid(high: i32, low: u32) -> String {
    format!("{:08x}{:08x}", high as u32, low)
}

/// NVENCAPI packs the version as `(major << 4) | minor`; expose `major * 100 + minor`.
fn nvenc_api_version_from_raw(raw: u32) -> u32 {
    (raw >> 4) * 100 + (raw & 0xF)
}

// ---------------------------------------------------------------------------
// Windows probe.
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod platform {
    use super::*;
    use std::ffi::{c_char, c_void};
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::null_mut;
    use windows::core::Interface;
    use windows::Win32::Graphics::Dxgi::{IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE, DXGI_ERROR_NOT_FOUND};
    use windows_sys::Win32::Foundation::{FreeLibrary, HMODULE};
    use windows_sys::Win32::System::LibraryLoader::{
        GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_SYSTEM32,
    };

    // nvml.h (NVML API Reference): NVML_SUCCESS == 0; nvmlEncoderType_t:
    // NVML_ENCODER_QUERY_H264 = 0, HEVC = 1, AV1 = 2.
    const NVML_SUCCESS: u32 = 0;
    const NVML_ENCODER_QUERY_H264: u32 = 0;
    const NVML_ENCODER_QUERY_HEVC: u32 = 1;
    const NVML_ENCODER_QUERY_AV1: u32 = 2;
    // nvEncodeAPI.h: NV_ENC_SUCCESS == 0.
    const NV_ENC_SUCCESS: u32 = 0;

    // nvmlPciInfo_t (nvml.h).
    #[repr(C)]
    struct NvmlPciInfo {
        _bus_id_legacy: [c_char; 16],
        _domain: u32,
        _bus: u32,
        _device: u32,
        pci_device_id: u32,
        pci_sub_system_id: u32,
        _bus_id: [c_char; 32],
    }

    type CreateDxgiFactory1 = unsafe extern "system" fn(*const windows::core::GUID, *mut *mut c_void) -> i32;
    type NvmlInit = unsafe extern "C" fn() -> u32;
    type NvmlShutdown = unsafe extern "C" fn() -> u32;
    type NvmlDeviceGetCount = unsafe extern "C" fn(*mut u32) -> u32;
    type NvmlDeviceGetHandleByIndex = unsafe extern "C" fn(u32, *mut *mut c_void) -> u32;
    type NvmlDeviceGetPciInfo = unsafe extern "C" fn(*mut c_void, *mut NvmlPciInfo) -> u32;
    type NvmlDeviceGetArchitecture = unsafe extern "C" fn(*mut c_void, *mut u32) -> u32;
    type NvmlDeviceGetEncoderCapacity = unsafe extern "C" fn(*mut c_void, u32, *mut u32) -> u32;
    type NvEncodeApiGetMaxSupportedVersion = unsafe extern "system" fn(*mut u32) -> u32;

    /// A module loaded from System32 only.
    struct Library(HMODULE);

    impl Library {
        /// `name` is a bare file name. LOAD_LIBRARY_SEARCH_SYSTEM32 restricts
        /// both the module and its dependencies to %SystemRoot%\System32, so
        /// the application directory, the working directory and PATH are
        /// never searched.
        fn system32(name: &str) -> Option<Self> {
            debug_assert!(!name.contains(['\\', '/', ':']));
            let wide: Vec<u16> = std::ffi::OsStr::new(name).encode_wide().chain(std::iter::once(0)).collect();
            let module = unsafe { LoadLibraryExW(wide.as_ptr(), null_mut(), LOAD_LIBRARY_SEARCH_SYSTEM32) };
            if module.is_null() {
                None
            } else {
                Some(Self(module))
            }
        }

        /// # Safety
        /// `T` must be the exact function-pointer type exported under `name`.
        unsafe fn symbol<T: Copy>(&self, name: &'static [u8]) -> Option<T> {
            debug_assert!(name.ends_with(&[0]));
            debug_assert_eq!(std::mem::size_of::<T>(), std::mem::size_of::<usize>());
            let address = GetProcAddress(self.0, name.as_ptr())?;
            Some(std::mem::transmute_copy::<unsafe extern "system" fn() -> isize, T>(&address))
        }
    }

    impl Drop for Library {
        fn drop(&mut self) {
            unsafe { FreeLibrary(self.0) };
        }
    }

    fn probe_nvenc_api_version() -> Option<u32> {
        let library = Library::system32("nvEncodeAPI64.dll")?;
        let get_version: NvEncodeApiGetMaxSupportedVersion =
            unsafe { library.symbol(b"NvEncodeAPIGetMaxSupportedVersion\0")? };
        let mut raw: u32 = 0;
        if unsafe { get_version(&mut raw) } != NV_ENC_SUCCESS || raw == 0 {
            return None;
        }
        Some(nvenc_api_version_from_raw(raw))
    }

    fn probe_dxgi() -> Result<Vec<DxgiAdapterInfo>, String> {
        let library = Library::system32("dxgi.dll").ok_or("dxgi.dll could not be loaded from System32.")?;
        let create: CreateDxgiFactory1 = unsafe { library.symbol(b"CreateDXGIFactory1\0") }
            .ok_or("CreateDXGIFactory1 was not found in dxgi.dll.")?;

        let mut raw: *mut c_void = null_mut();
        let hr = unsafe { create(&IDXGIFactory1::IID, &mut raw) };
        if hr < 0 || raw.is_null() {
            return Err(format!("CreateDXGIFactory1 failed ({:#010x}).", hr as u32));
        }
        // Ownership of the reference moves into the windows-crate wrapper,
        // which releases it on drop (before `library` is freed below).
        let factory = unsafe { IDXGIFactory1::from_raw(raw) };

        let mut adapters = Vec::new();
        for index in 0u32.. {
            let adapter = match unsafe { factory.EnumAdapters1(index) } {
                Ok(adapter) => adapter,
                Err(error) if error.code() == DXGI_ERROR_NOT_FOUND => break,
                Err(error) => return Err(format!("IDXGIFactory1::EnumAdapters1 failed: {error}")),
            };
            // A partial inventory could make "every adapter lacks X" look true.
            let desc = unsafe { adapter.GetDesc1() }
                .map_err(|error| format!("IDXGIAdapter1::GetDesc1 failed: {error}"))?;
            if desc.Flags & (DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32) != 0 {
                continue;
            }
            let end = desc.Description.iter().position(|&unit| unit == 0).unwrap_or(desc.Description.len());
            adapters.push(DxgiAdapterInfo {
                luid: format_luid(desc.AdapterLuid.HighPart, desc.AdapterLuid.LowPart),
                name: String::from_utf16_lossy(&desc.Description[..end]).trim().to_string(),
                vendor_id: desc.VendorId,
                device_id: desc.DeviceId,
                sub_sys_id: desc.SubSysId,
            });
        }
        drop(factory);
        drop(library);
        Ok(adapters)
    }

    fn probe_nvml() -> Result<NvmlInventory, String> {
        let library = Library::system32("nvml.dll").ok_or("nvml.dll could not be loaded from System32.")?;
        unsafe {
            let init: NvmlInit = library.symbol(b"nvmlInit_v2\0").ok_or("nvmlInit_v2 not found.")?;
            let shutdown: NvmlShutdown = library.symbol(b"nvmlShutdown\0").ok_or("nvmlShutdown not found.")?;
            let get_count: NvmlDeviceGetCount =
                library.symbol(b"nvmlDeviceGetCount_v2\0").ok_or("nvmlDeviceGetCount_v2 not found.")?;
            let get_handle: NvmlDeviceGetHandleByIndex = library
                .symbol(b"nvmlDeviceGetHandleByIndex_v2\0")
                .ok_or("nvmlDeviceGetHandleByIndex_v2 not found.")?;
            let get_pci: NvmlDeviceGetPciInfo = library
                .symbol(b"nvmlDeviceGetPciInfo_v3\0")
                .ok_or("nvmlDeviceGetPciInfo_v3 not found.")?;
            let get_arch: Option<NvmlDeviceGetArchitecture> = library.symbol(b"nvmlDeviceGetArchitecture\0");
            let get_capacity: Option<NvmlDeviceGetEncoderCapacity> =
                library.symbol(b"nvmlDeviceGetEncoderCapacity\0");

            let status = init();
            if status != NVML_SUCCESS {
                return Err(format!("nvmlInit_v2 failed ({status})."));
            }

            let mut inventory = NvmlInventory::default();
            let mut count: u32 = 0;
            if get_count(&mut count) == NVML_SUCCESS {
                inventory.total = count;
                for index in 0..count {
                    let mut handle: *mut c_void = null_mut();
                    if get_handle(index, &mut handle) != NVML_SUCCESS || handle.is_null() {
                        continue;
                    }
                    let mut pci: NvmlPciInfo = std::mem::zeroed();
                    if get_pci(handle, &mut pci) != NVML_SUCCESS {
                        continue;
                    }
                    let arch = get_arch
                        .and_then(|query| {
                            let mut raw: u32 = 0;
                            (query(handle, &mut raw) == NVML_SUCCESS).then_some(raw)
                        })
                        .map_or(Arch::Unknown, arch_from_nvml);
                    let capacity = |kind: u32| {
                        get_capacity.and_then(|query| {
                            let mut value: u32 = 0;
                            (query(handle, kind, &mut value) == NVML_SUCCESS).then_some(value)
                        })
                    };
                    inventory.devices.push(NvmlDeviceInfo {
                        // nvmlPciInfo_t.pciDeviceId: device ID in the high 16 bits.
                        device_id: pci.pci_device_id >> 16,
                        sub_sys_id: pci.pci_sub_system_id,
                        arch,
                        capacity: EncoderCapacity {
                            h264: capacity(NVML_ENCODER_QUERY_H264),
                            hevc: capacity(NVML_ENCODER_QUERY_HEVC),
                            av1: capacity(NVML_ENCODER_QUERY_AV1),
                        },
                    });
                }
            }
            shutdown();
            Ok(inventory)
        }
    }

    pub(crate) fn probe_dxgi_adapters() -> Result<Vec<DxgiAdapterInfo>, String> {
        probe_dxgi()
    }

    pub fn probe() -> GpuCapabilities {
        let checked_at = checked_at_now();
        let dxgi = match probe_dxgi() {
            Ok(adapters) => adapters,
            Err(error) => {
                return GpuCapabilities {
                    adapters: Vec::new(),
                    checked_at,
                    error: Some(error),
                }
            }
        };
        let has_nvidia = dxgi.iter().any(|adapter| adapter.vendor_id == NVIDIA_VENDOR_ID);
        // A missing or failing NVML/NVENC library leaves NVIDIA fields unknown.
        let (api_version, inventory) = if has_nvidia {
            (probe_nvenc_api_version(), probe_nvml().unwrap_or_default())
        } else {
            (None, NvmlInventory::default())
        };
        GpuCapabilities {
            adapters: merge_adapters(&dxgi, &inventory, api_version),
            checked_at,
            error: None,
        }
    }
}

#[cfg(windows)]
pub fn probe_gpu_capabilities() -> GpuCapabilities {
    platform::probe()
}

#[cfg(not(windows))]
pub fn probe_gpu_capabilities() -> GpuCapabilities {
    GpuCapabilities {
        adapters: Vec::new(),
        checked_at: checked_at_now(),
        error: Some("GPU capability probe is only available on Windows.".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc;
    use std::sync::Arc;

    fn dxgi(luid: &str, vendor: u32, device: u32, subsys: u32) -> DxgiAdapterInfo {
        DxgiAdapterInfo {
            luid: luid.into(),
            name: format!("GPU {luid}"),
            vendor_id: vendor,
            device_id: device,
            sub_sys_id: subsys,
        }
    }

    fn nvml(device: u32, subsys: u32, arch: Arch, h264: Option<u32>, hevc: Option<u32>, av1: Option<u32>) -> NvmlDeviceInfo {
        NvmlDeviceInfo {
            device_id: device,
            sub_sys_id: subsys,
            arch,
            capacity: EncoderCapacity { h264, hevc, av1 },
        }
    }

    fn inventory(devices: Vec<NvmlDeviceInfo>) -> NvmlInventory {
        NvmlInventory {
            total: devices.len() as u32,
            devices,
        }
    }

    fn caps(adapters: Vec<AdapterCapabilities>, error: Option<&str>) -> GpuCapabilities {
        GpuCapabilities {
            adapters,
            checked_at: 1,
            error: error.map(str::to_string),
        }
    }

    fn of(value: Option<bool>) -> AdapterCapabilities {
        AdapterCapabilities {
            optical_flow: value,
            ..Default::default()
        }
    }

    #[test]
    fn luid_is_canonical_lowercase_high_then_low() {
        assert_eq!(format_luid(0x12345678, 0x9abcdef0), "123456789abcdef0");
        assert_eq!(format_luid(-1, 1), "ffffffff00000001");
    }

    #[test]
    fn nvenc_api_version_is_major_times_100_plus_minor() {
        assert_eq!(nvenc_api_version_from_raw(0xC1), 1201);
        assert_eq!(nvenc_api_version_from_raw(0xD0), 1300);
    }

    #[test]
    fn nvml_architecture_values_match_the_header() {
        assert_eq!(arch_from_nvml(2), Arch::Kepler);
        assert_eq!(arch_from_nvml(3), Arch::Maxwell);
        assert_eq!(arch_from_nvml(4), Arch::Pascal);
        assert_eq!(arch_from_nvml(5), Arch::Volta);
        assert_eq!(arch_from_nvml(6), Arch::Turing);
        assert_eq!(arch_from_nvml(7), Arch::Ampere);
        assert_eq!(arch_from_nvml(8), Arch::Ada);
        assert_eq!(arch_from_nvml(9), Arch::Hopper);
        assert_eq!(arch_from_nvml(10), Arch::Blackwell);
        // NVML_DEVICE_ARCH_T23X (Tegra), UNKNOWN and values this build has
        // never seen stay unknown.
        assert_eq!(arch_from_nvml(11), Arch::Unknown);
        assert_eq!(arch_from_nvml(0xFFFF_FFFF), Arch::Unknown);
        assert_eq!(arch_from_nvml(1), Arch::Unknown);
        assert_eq!(arch_from_nvml(99), Arch::Unknown);
    }

    #[test]
    fn non_nvidia_adapters_are_known_without_nvenc() {
        let adapters = [dxgi("01", 0x1002, 0x73BF, 1), dxgi("02", 0x8086, 0x56A0, 2)];
        let merged = merge_adapters(&adapters, &NvmlInventory::default(), Some(1201));
        for adapter in &merged {
            assert_eq!(adapter.nvenc, Some(false));
            assert_eq!(adapter.optical_flow, Some(false));
            assert!(adapter.codecs.is_none());
            assert!(adapter.api_version.is_none());
        }
    }

    #[test]
    fn nvidia_without_nvml_is_unknown_except_certain_facts() {
        let adapters = [dxgi("01", NVIDIA_VENDOR_ID, 0x2684, 1)];
        let merged = merge_adapters(&adapters, &NvmlInventory::default(), None);
        let adapter = &merged[0];
        assert_eq!(adapter.vendor_id, Some(NVIDIA_VENDOR_ID));
        assert!(adapter.nvenc.is_none());
        assert!(adapter.optical_flow.is_none());
        assert!(adapter.codecs.is_none());
        assert!(adapter.api_version.is_none());

        // TU117 is known from the adapter's own PCI ID even without NVML.
        let tu117 = merge_adapters(&[dxgi("01", NVIDIA_VENDOR_ID, 0x1F82, 1)], &NvmlInventory::default(), Some(1201));
        assert_eq!(tu117[0].optical_flow, Some(false));
        assert!(tu117[0].nvenc.is_none());
        assert_eq!(tu117[0].api_version, Some(1201));
    }

    #[test]
    fn zero_capacity_and_query_errors_stay_unknown() {
        let adapters = [dxgi("01", NVIDIA_VENDOR_ID, 0x2684, 1)];
        // Capacity 0 (busy encoders) and a failed query prove nothing.
        let devices = inventory(vec![nvml(0x2684, 1, Arch::Ada, Some(0), None, Some(0))]);
        let merged = merge_adapters(&adapters, &devices, Some(1201));
        let adapter = &merged[0];
        assert!(adapter.nvenc.is_none());
        assert!(adapter.codecs.is_none());
    }

    #[test]
    fn positive_capacity_publishes_support_but_never_guessed_limits() {
        let adapters = [dxgi("01", NVIDIA_VENDOR_ID, 0x2882, 1)];
        let devices = inventory(vec![nvml(0x2882, 1, Arch::Ada, Some(2), Some(2), Some(2))]);
        let merged = merge_adapters(&adapters, &devices, Some(1201));
        let adapter = &merged[0];
        assert_eq!(adapter.nvenc, Some(true));
        let codecs = adapter.codecs.as_ref().unwrap();
        for codec in [&codecs.h264, &codecs.hevc, &codecs.av1] {
            let codec = codec.as_ref().unwrap();
            assert_eq!(codec.supported, Some(true));
            assert!(codec.ten_bit.is_none());
            assert!(codec.max_width.is_none());
            assert!(codec.max_height.is_none());
            assert!(codec.engines.is_none());
            assert!(codec.presets.is_none());
            assert!(codec.split.is_none());
        }
    }

    #[test]
    fn av1_is_negative_before_ada_and_unknown_when_busy_on_ada() {
        let adapters = [dxgi("01", NVIDIA_VENDOR_ID, 0x2484, 1)];
        let ampere = inventory(vec![nvml(0x2484, 1, Arch::Ampere, Some(1), Some(1), Some(0))]);
        let merged = merge_adapters(&adapters, &ampere, None);
        let codecs = merged[0].codecs.as_ref().unwrap();
        assert_eq!(codecs.av1.as_ref().unwrap().supported, Some(false));
        assert_eq!(codecs.hevc.as_ref().unwrap().supported, Some(true));

        let ada = inventory(vec![nvml(0x2484, 1, Arch::Ada, Some(1), Some(1), Some(0))]);
        let merged = merge_adapters(&adapters, &ada, None);
        assert!(merged[0].codecs.as_ref().unwrap().av1.is_none());

        let unknown_arch = inventory(vec![nvml(0x2484, 1, Arch::Unknown, Some(0), Some(0), Some(0))]);
        assert!(merge_adapters(&adapters, &unknown_arch, None)[0].codecs.is_none());
    }

    #[test]
    fn optical_flow_is_independent_of_nvenc() {
        // Maxwell has NVENC but no Optical Flow engine.
        let maxwell = merge_adapters(
            &[dxgi("01", NVIDIA_VENDOR_ID, 0x1380, 1)],
            &inventory(vec![nvml(0x1380, 1, Arch::Maxwell, Some(1), Some(0), None)]),
            None,
        );
        assert_eq!(maxwell[0].nvenc, Some(true));
        assert_eq!(maxwell[0].optical_flow, Some(false));

        // A Turing (non-TU117) part with no free NVENC capacity: Optical Flow
        // is not inferred false from NVENC and not inferred true either.
        let turing = merge_adapters(
            &[dxgi("01", NVIDIA_VENDOR_ID, 0x1E04, 1)],
            &inventory(vec![nvml(0x1E04, 1, Arch::Turing, Some(0), Some(0), Some(0))]),
            None,
        );
        assert!(turing[0].nvenc.is_none());
        assert!(turing[0].optical_flow.is_none());

        // Newer architectures are never claimed supported from the family.
        for arch in [Arch::Ampere, Arch::Ada, Arch::Hopper, Arch::Blackwell, Arch::Unknown] {
            let merged = merge_adapters(
                &[dxgi("01", NVIDIA_VENDOR_ID, 0x2000, 1)],
                &inventory(vec![nvml(0x2000, 1, arch, Some(1), Some(1), Some(1))]),
                None,
            );
            assert!(merged[0].optical_flow.is_none(), "{arch:?}");
        }
    }

    #[test]
    fn tu117_ids_are_excluded_and_other_turing_ids_are_not() {
        for id in [0x1F82u32, 0x1F83, 0x1FB0, 0x1FB1, 0x1FB2, 0x1FB9, 0x1F91, 0x1FF9] {
            assert!(is_tu117(id), "{id:#x}");
        }
        for id in [0x1E04u32, 0x1E87, 0x2182, 0x2184, 0x1F02, 0x2484] {
            assert!(!is_tu117(id), "{id:#x}");
        }
    }

    #[test]
    fn single_gpu_pairing_requires_matching_device_id_and_complete_inventory() {
        let adapters = [dxgi("01", NVIDIA_VENDOR_ID, 0x2684, 1)];
        let paired = merge_adapters(&adapters, &inventory(vec![nvml(0x2684, 9, Arch::Ada, Some(1), None, None)]), None);
        assert_eq!(paired[0].nvenc, Some(true));

        // NVML sees a different device: no pairing.
        let other = merge_adapters(&adapters, &inventory(vec![nvml(0x2204, 1, Arch::Ampere, Some(1), None, None)]), None);
        assert!(other[0].nvenc.is_none());

        // NVML reported two devices but only one could be read.
        let partial = NvmlInventory {
            total: 2,
            devices: vec![nvml(0x2684, 1, Arch::Ada, Some(1), None, None)],
        };
        assert!(merge_adapters(&adapters, &partial, None)[0].nvenc.is_none());
    }

    #[test]
    fn multi_gpu_pairs_by_unique_pci_ids_and_leaves_identical_gpus_unknown() {
        let distinct = merge_adapters(
            &[dxgi("01", NVIDIA_VENDOR_ID, 0x2484, 0x1111), dxgi("02", NVIDIA_VENDOR_ID, 0x2684, 0x2222)],
            &inventory(vec![
                nvml(0x2684, 0x2222, Arch::Ada, Some(1), Some(1), Some(1)),
                nvml(0x2484, 0x1111, Arch::Ampere, Some(1), Some(1), Some(0)),
            ]),
            Some(1201),
        );
        // NVML order differs from DXGI order; PCI IDs decide.
        assert_eq!(distinct[0].codecs.as_ref().unwrap().av1.as_ref().unwrap().supported, Some(false));
        assert_eq!(distinct[1].codecs.as_ref().unwrap().av1.as_ref().unwrap().supported, Some(true));

        let identical = merge_adapters(
            &[dxgi("01", NVIDIA_VENDOR_ID, 0x2484, 0x1111), dxgi("02", NVIDIA_VENDOR_ID, 0x2484, 0x1111)],
            &inventory(vec![
                nvml(0x2484, 0x1111, Arch::Ampere, Some(1), Some(1), Some(0)),
                nvml(0x2484, 0x1111, Arch::Ampere, Some(0), Some(0), Some(0)),
            ]),
            Some(1201),
        );
        for adapter in &identical {
            assert!(adapter.nvenc.is_none());
            assert!(adapter.codecs.is_none());
            assert_eq!(adapter.api_version, Some(1201));
        }
    }

    #[test]
    fn integrated_plus_nvidia_pairs_only_the_nvidia_adapter() {
        let merged = merge_adapters(
            &[dxgi("01", 0x8086, 0x9A49, 1), dxgi("02", NVIDIA_VENDOR_ID, 0x2684, 2)],
            &inventory(vec![nvml(0x2684, 2, Arch::Ada, Some(1), None, None)]),
            Some(1201),
        );
        assert_eq!(merged[0].nvenc, Some(false));
        assert!(merged[0].api_version.is_none());
        assert_eq!(merged[1].nvenc, Some(true));
        assert_eq!(merged[1].api_version, Some(1201));
    }

    #[test]
    fn optical_flow_refusal_needs_a_clean_nonempty_all_false_report() {
        assert!(optical_flow_known_unsupported(&caps(vec![of(Some(false))], None)));
        assert!(optical_flow_known_unsupported(&caps(vec![of(Some(false)), of(Some(false))], None)));
        // Empty, errored, mixed and unknown reports never refuse.
        assert!(!optical_flow_known_unsupported(&caps(vec![], None)));
        assert!(!optical_flow_known_unsupported(&caps(vec![], Some("dxgi failed"))));
        assert!(!optical_flow_known_unsupported(&caps(vec![of(Some(false))], Some("partial"))));
        assert!(!optical_flow_known_unsupported(&caps(vec![of(Some(false)), of(Some(true))], None)));
        assert!(!optical_flow_known_unsupported(&caps(vec![of(Some(false)), of(None)], None)));
        assert!(!optical_flow_known_unsupported(&caps(vec![of(None)], None)));
    }

    #[test]
    fn serialises_the_shared_contract_shape() {
        let report = GpuCapabilities {
            adapters: vec![AdapterCapabilities {
                adapter_luid: Some("0000000100000002".into()),
                gpu_name: Some("GPU".into()),
                vendor_id: Some(NVIDIA_VENDOR_ID),
                api_version: Some(1201),
                codecs: Some(Codecs {
                    h264: Some(CodecCaps {
                        supported: Some(true),
                        ten_bit: Some(false),
                        max_width: Some(1),
                        max_height: Some(2),
                        engines: Some(3),
                        presets: Some(vec![1]),
                        split: Some(true),
                    }),
                    ..Default::default()
                }),
                nvenc: Some(true),
                optical_flow: Some(false),
            }],
            checked_at: 42,
            error: None,
        };
        let value = serde_json::to_value(&report).unwrap();
        assert_eq!(value["checkedAt"], 42);
        assert!(value.get("error").is_none());
        let adapter = &value["adapters"][0];
        for key in ["adapterLuid", "gpuName", "vendorId", "apiVersion", "nvenc", "opticalFlow"] {
            assert!(adapter.get(key).is_some(), "{key}");
        }
        let h264 = &adapter["codecs"]["h264"];
        for key in ["supported", "tenBit", "maxWidth", "maxHeight", "engines", "presets", "split"] {
            assert!(h264.get(key).is_some(), "{key}");
        }
        assert!(adapter["codecs"].get("hevc").is_none());
    }

    #[test]
    fn cache_is_cold_then_reused_within_ttl_and_reprobed_after() {
        let cache = ProbeCache::new();
        assert!(cache.last_known().is_none());

        let calls = AtomicUsize::new(0);
        let probe = || {
            calls.fetch_add(1, Ordering::SeqCst);
            caps(vec![of(None)], None)
        };
        cache.get_or_probe(Duration::from_secs(60), probe);
        cache.get_or_probe(Duration::from_secs(60), probe);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(cache.last_known().is_some());

        cache.get_or_probe(Duration::ZERO, probe);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn cache_only_read_does_not_wait_for_a_running_probe() {
        let cache = Arc::new(ProbeCache::new());
        let (started_tx, started_rx) = mpsc::channel::<()>();
        let (release_tx, release_rx) = mpsc::channel::<()>();

        let worker_cache = Arc::clone(&cache);
        let worker = std::thread::spawn(move || {
            worker_cache.get_or_probe(Duration::ZERO, || {
                started_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                caps(vec![of(Some(false))], None)
            })
        });

        started_rx.recv().unwrap();
        // The probe is parked mid-flight; a cold cache-only read returns at once.
        assert!(cache.last_known().is_none());
        release_tx.send(()).unwrap();
        worker.join().unwrap();
        assert!(cache.last_known().is_some());
    }

    #[cfg(not(windows))]
    #[test]
    fn non_windows_reports_unknown_with_an_error() {
        let report = probe_gpu_capabilities();
        assert!(report.error.is_some());
        assert!(report.adapters.is_empty());
        assert!(!optical_flow_known_unsupported(&report));
    }

    // Exercises the real IDXGIFactory1/IDXGIAdapter1 COM calls on this host
    // (read-only enumeration; no device or encoder session is created).
    #[cfg(windows)]
    #[test]
    fn real_dxgi_enumeration_uses_the_correct_com_abi() {
        let adapters = platform::probe_dxgi_adapters().expect("DXGI enumeration");
        for adapter in &adapters {
            assert_eq!(adapter.luid.len(), 16, "{}", adapter.luid);
            assert!(adapter.luid.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()));
            assert_ne!(adapter.vendor_id, 0, "vendor id must come from a valid DXGI_ADAPTER_DESC1");
            assert!(!adapter.name.contains('\0'));
        }
    }

    #[cfg(windows)]
    #[test]
    fn real_probe_never_reports_error_with_adapters() {
        let report = probe_gpu_capabilities();
        assert!(report.error.is_none() || report.adapters.is_empty());
        let encoded = serde_json::to_string(&report).unwrap();
        assert!(encoded.contains("checkedAt"));
    }
}
