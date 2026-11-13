#define NOMINMAX
#include "NvencTap.h"
#include "NvencPostPack.h"
#include "NvencFrameProbe.h"
#include "CurveMath.h"
#include "DriverLog.h"
#ifdef VENDOR_GALAXYXR
// Galaxy XR vendor build: the Steam Link GalaxyXR original vrlink module only.
// Module-local IAT patches replace the process-wide MinHook export hook.
#include "../Hooking/ModuleImportHook.h"
#ifndef GXR_GALAXYLINK_EPOCH_HEADER
#define GXR_GALAXYLINK_EPOCH_HEADER "GalaxyLinkEpoch.h"
#endif
#include GXR_GALAXYLINK_EPOCH_HEADER
#include <intrin.h>
#else
#include "../../../ThirdParty/minhook/include/MinHook.h"
#endif
#include "../../../ThirdParty/nvenc/nvEncodeAPI.h"
#include "../Config/Config.h"
#include "../Config/StreamTiers.h"
#include <chrono>
#include <set>
#include <map>
#include <memory>
#include <vector>
#include <cmath>
#include <cstddef>
#include <cstdio>
#include <cstring>
#include <algorithm>
#include <limits>
#include <fstream>
#include <sstream>
#include <dxgi.h>
#include <unknwn.h>
#include "../../../ThirdParty/json/single_include/nlohmann/json.hpp"

// Versioned read-only data export for external measurement tools. It contains
// owned frame copies, never pointers into unlocked NVENC output buffers.
extern "C" {
__declspec(dllexport) gxr::frameprobe::Probe GalaxyXR_NVENC_Probe_v1;
}

static double NowSecondsNv(){
	return std::chrono::duration_cast<std::chrono::microseconds>(
		std::chrono::steady_clock::now().time_since_epoch()).count() / 1000000.0;
}

// shared state between the shims and the public object
struct NvencTapShims {
	static NVENCSTATUS NVENCAPI CreateInstance(NV_ENCODE_API_FUNCTION_LIST* list);
	static NVENCSTATUS NVENCAPI InitializeEncoder(void* encoder, NV_ENC_INITIALIZE_PARAMS* params);
	static NVENCSTATUS NVENCAPI ReconfigureEncoder(void* encoder, NV_ENC_RECONFIGURE_PARAMS* params);
	static NVENCSTATUS NVENCAPI RegisterResource(void* encoder, NV_ENC_REGISTER_RESOURCE* params);
	static NVENCSTATUS NVENCAPI EncodePicture(void* encoder, NV_ENC_PIC_PARAMS* params);
	static NVENCSTATUS NVENCAPI LockBitstream(void* encoder, NV_ENC_LOCK_BITSTREAM* params);
	// session upgrade (11.1 -> 12.1) re-tagging shims
	static NVENCSTATUS NVENCAPI OpenEncodeSessionEx(NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS* params, void** encoder);
	static NVENCSTATUS NVENCAPI DestroyEncoder(void* encoder);
	static NVENCSTATUS NVENCAPI GetEncodeCaps(void* encoder, GUID encodeGUID, NV_ENC_CAPS_PARAM* params, int* capsVal);
	static NVENCSTATUS NVENCAPI GetEncodeGUIDCount(void* encoder, uint32_t* count);
	static NVENCSTATUS NVENCAPI GetEncodeGUIDs(void* encoder, GUID* guids, uint32_t guidArraySize, uint32_t* guidCount);
	static NVENCSTATUS NVENCAPI GetEncodePresetCount(void* encoder, GUID encodeGUID, uint32_t* count);
	static NVENCSTATUS NVENCAPI GetEncodePresetGUIDs(void* encoder, GUID encodeGUID, GUID* presetGuids, uint32_t guidArraySize, uint32_t* guidCount);
	static NVENCSTATUS NVENCAPI GetEncodePresetConfig(void* encoder, GUID encodeGUID, GUID presetGUID, NV_ENC_PRESET_CONFIG* params);
	static NVENCSTATUS NVENCAPI GetEncodePresetConfigEx(void* encoder, GUID encodeGUID, GUID presetGUID, NV_ENC_TUNING_INFO tuning, NV_ENC_PRESET_CONFIG* params);
	static NVENCSTATUS NVENCAPI CreateInputBuffer(void* encoder, NV_ENC_CREATE_INPUT_BUFFER* params);
	static NVENCSTATUS NVENCAPI CreateBitstreamBuffer(void* encoder, NV_ENC_CREATE_BITSTREAM_BUFFER* params);
	static NVENCSTATUS NVENCAPI CreateMVBuffer(void* encoder, NV_ENC_CREATE_MV_BUFFER* params);
	static NVENCSTATUS NVENCAPI RegisterAsyncEvent(void* encoder, NV_ENC_EVENT_PARAMS* params);
	static NVENCSTATUS NVENCAPI UnregisterAsyncEvent(void* encoder, NV_ENC_EVENT_PARAMS* params);
	static NVENCSTATUS NVENCAPI MapInputResource(void* encoder, NV_ENC_MAP_INPUT_RESOURCE* params);
	static NVENCSTATUS NVENCAPI LockInputBuffer(void* encoder, NV_ENC_LOCK_INPUT_BUFFER* params);
	static NVENCSTATUS NVENCAPI GetSequenceParams(void* encoder, NV_ENC_SEQUENCE_PARAM_PAYLOAD* params);
	static NVENCSTATUS NVENCAPI RunMotionEstimationOnly(void* encoder, NV_ENC_MEONLY_PARAMS* params);
	// post-pack bookkeeping (registered -> D3D texture, mapped -> registered)
	static NVENCSTATUS NVENCAPI UnregisterResource(void* encoder, NV_ENC_REGISTERED_PTR reg);
	static NVENCSTATUS NVENCAPI UnmapInputResource(void* encoder, NV_ENC_INPUT_PTR mapped);
};

namespace {

typedef NVENCSTATUS (NVENCAPI *PFN_CreateInstance)(NV_ENCODE_API_FUNCTION_LIST*);
PFN_CreateInstance origCreateInstance = nullptr;
PNVENCINITIALIZEENCODER origInitializeEncoder = nullptr;
PNVENCRECONFIGUREENCODER origReconfigureEncoder = nullptr;
PNVENCREGISTERRESOURCE origRegisterResource = nullptr;
PNVENCENCODEPICTURE origEncodePicture = nullptr;
PNVENCLOCKBITSTREAM origLockBitstream = nullptr;
// not shimmed, only captured: used by the preset merge to ask the driver
// for the canonical config of the target preset (see NvencTapConfig::presetMerge)
PNVENCGETENCODEPRESETCONFIGEX origGetPresetConfigEx = nullptr;
PNVENCGETENCODECAPS origGetEncodeCaps = nullptr;
PNVENCGETENCODEGUIDCOUNT origGetEncodeGUIDCount = nullptr;
PNVENCGETENCODEGUIDS origGetEncodeGUIDs = nullptr;
PNVENCGETENCODEPRESETCOUNT origGetEncodePresetCount = nullptr;
PNVENCGETENCODEPRESETGUIDS origGetEncodePresetGUIDs = nullptr;
PNVENCGETLASTERROR origGetLastErrorString = nullptr;
PNVENCOPENENCODESESSIONEX origOpenEncodeSessionEx = nullptr;
PNVENCDESTROYENCODER origDestroyEncoder = nullptr;
PNVENCGETENCODEPRESETCONFIG origGetPresetConfig = nullptr;
PNVENCCREATEINPUTBUFFER origCreateInputBuffer = nullptr;
PNVENCCREATEBITSTREAMBUFFER origCreateBitstreamBuffer = nullptr;
PNVENCCREATEMVBUFFER origCreateMVBuffer = nullptr;
PNVENCREGISTERASYNCEVENT origRegisterAsyncEvent = nullptr;
PNVENCUNREGISTERASYNCEVENT origUnregisterAsyncEvent = nullptr;
PNVENCMAPINPUTRESOURCE origMapInputResource = nullptr;
PNVENCLOCKINPUTBUFFER origLockInputBuffer = nullptr;
PNVENCGETSEQUENCEPARAMS origGetSequenceParams = nullptr;
PNVENCRUNMOTIONESTIMATIONONLY origRunMotionEstimationOnly = nullptr;
PNVENCUNREGISTERRESOURCE origUnregisterResource = nullptr;
PNVENCUNMAPINPUTRESOURCE origUnmapInputResource = nullptr;

// ---- post-pack resource bookkeeping ----
// vrlink registers a ring of D3D11 textures (nvEncRegisterResource ->
// registered handle), maps one per frame (nvEncMapInputResource ->
// mapped/input pointer) and encodes it (nvEncEncodePicture inputBuffer ==
// mapped). Resolve the registered texture before mapping it; once mapped,
// NVENC owns the resource and no D3D writes are allowed until it is unmapped.
std::mutex resLock;
struct RegInfo { void* texture; uint32_t fmt; uint32_t type; void* encoder = nullptr; };
std::map<void*, RegInfo> registered;   // NV_ENC_REGISTERED_PTR -> texture
std::map<void*, void*> mappedToReg;    // NV_ENC_INPUT_PTR (mapped) -> NV_ENC_REGISTERED_PTR
// ---- foveated QP delta map ----
// one signed byte per block, row-major on the codec's own grid (HEVC 32x32
// CTB, H.264 16x16 MB, AV1 64x64 SB - nvEncodeAPI.h qpDeltaMapSize), rebuilt
// when the frame size, the codec or the deltas change. the frame is N stacked
// square tiles of width w; fovea tiles are the even (or odd) ones.
std::mutex qpLock;
using QpMapSnapshot = std::shared_ptr<const std::vector<int8_t>>;
QpMapSnapshot qpMap;
uint32_t qpMapW = 0, qpMapH = 0; int qpMapFov = 0, qpMapPer = 0, qpMapCodec = -1; float qpMapFall = -1; bool qpMapTop = true;
QpMapSnapshot GetQpMap(uint32_t w, uint32_t h, int codec, const NvencTapConfig &cfg){
	std::lock_guard<std::mutex> g(qpLock);
	if(!qpMap || w != qpMapW || h != qpMapH || codec != qpMapCodec || cfg.qpFovea != qpMapFov || cfg.qpPeriphery != qpMapPer || cfg.qpEdgeFalloff != qpMapFall || cfg.qpFoveaTop != qpMapTop){
		qpMapW = w; qpMapH = h; qpMapCodec = codec; qpMapFov = cfg.qpFovea; qpMapPer = cfg.qpPeriphery; qpMapFall = cfg.qpEdgeFalloff; qpMapTop = cfg.qpFoveaTop;
		const uint32_t bs = (codec == 1) ? 16u : (codec == 2) ? 64u : 32u;
		const uint32_t bw = (w + bs - 1) / bs, bh = (h + bs - 1) / bs;
		auto rebuilt = std::make_shared<std::vector<int8_t>>((size_t)bw * bh, 0);
		const float tile = (float)w; // square tiles
		for(uint32_t by = 0; by < bh; by++){
			for(uint32_t bx = 0; bx < bw; bx++){
				float px = bx * (float)bs + bs / 2.f, py = by * (float)bs + bs / 2.f;
				int t = (int)(py / tile);
				bool fovea = ((t & 1) == 0) == cfg.qpFoveaTop;
				float v = (float)cfg.qpPeriphery;
				if(fovea){
					float ix = px / tile, iy = py / tile - t;
					float d = (std::min)((std::min)(ix, 1.f - ix), (std::min)(iy, 1.f - iy));
					float k = cfg.qpEdgeFalloff > 0 ? (std::max)(0.f, (std::min)(1.f, d / cfg.qpEdgeFalloff)) : 1.f;
					k = k * k * (3.f - 2.f * k);
					v = (float)cfg.qpPeriphery + ((float)cfg.qpFovea - (float)cfg.qpPeriphery) * k;
				}
				(*rebuilt)[(size_t)by * bw + bx] = (int8_t)std::lround(v);
			}
		}
		qpMap = std::move(rebuilt);
		DriverLog("NvencTap: QP delta map rebuilt %ux%u blocks (fovea %d, periphery %d, ramp %.2f) bs=%u", bw, bh, cfg.qpFovea, cfg.qpPeriphery, cfg.qpEdgeFalloff, bs);
	}
	// The caller retains this immutable snapshot through nvEncEncodePicture;
	// rebuilding the cache cannot alter an in-flight picture's map.
	return qpMap;
}
inline bool QpMapWanted(const NvencTapConfig &cfg){ return cfg.enabled && (cfg.qpFovea != 0 || cfg.qpPeriphery != 0); }

// ---- delta-map adaptation (per frame; codec==1 H264, codec==2 AV1) ----
// vrlink attaches its per-frame qpDeltaMap on the HEVC 32x32-CTB grid
// (SteamFrame-Advanced-Options legacy_api_bridge.cpp:232-254 converts the
// same map for both codecs). The driver validates the map per codec
// (nvEncodeAPI.h qpDeltaMapSize: per MB for H264, per SB for AV1); the
// HEVC-sized map makes nvEncEncodePicture fail with
// NV_ENC_ERR_NOT_ENOUGH_BUFFER (14). H.264: replicate each 32x32 block 2x2,
// clamp [-51,51], pin the bottom-left timing tile (the MB rows covered by
// the last HEVC CTB row, first two columns) to -51. AV1: per 64x64 SB take
// the min of the 2x2 source block, x4, clamp [-128,124], pin the
// bottom-left SB to -128.
std::atomic<int> deltaMapDropLogged{0};
struct MapOverride { bool set = false; const int8_t* p = nullptr; uint32_t n = 0; QpMapSnapshot owned; };
MapOverride ConvertDeltaMap(const int8_t* src, uint32_t srcSize, uint32_t w, uint32_t h, int codec){
	MapOverride ov;
	if(!src || !srcSize || !w || !h){ return ov; }              // nothing to adapt
	const uint32_t ctbW = (w + 31) / 32, ctbH = (h + 31) / 32;
	const uint32_t block = codec == 2 ? 64u : 16u;
	const uint32_t cols = (w + block - 1) / block, rows = (h + block - 1) / block;
	const uint32_t entries = cols * rows;
	if(srcSize == entries){ return ov; }                        // already the target grid
	if(srcSize != ctbW * ctbH){
		// a map we cannot interpret would fail the encode (status 14);
		// dropping it keeps the session alive without foveation
		if(deltaMapDropLogged.fetch_add(1) < 3){
			DriverLog("NvencTap: delta map size %u matches neither the %s grid (%u) nor the CTB-32 grid (%u) - dropped for this frame", srcSize, codec == 2 ? "SB-64" : "MB-16", entries, ctbW * ctbH);
		}
		ov.set = true; ov.p = nullptr; ov.n = 0;
		return ov;
	}
	// Conversion is per submission. No shared mutable storage or mutex may
	// survive into NVIDIA's call, which can overlap or reenter the shim.
	auto converted = std::make_shared<std::vector<int8_t>>((size_t)entries, 0);
	auto& deltaMap = *converted;
	if(codec != 2){
		for(uint32_t y = 0; y < rows; y++){
			for(uint32_t x = 0; x < cols; x++){
				int v = src[(size_t)(y / 2) * ctbW + (x / 2)];
				if(v < -51){ v = -51; } else if(v > 51){ v = 51; }
				deltaMap[(size_t)y * cols + x] = (int8_t)v;
			}
		}
		// timing tile: the MB rows the last HEVC CTB row covers, first two
		// columns (legacy_api_bridge.cpp:248-250)
		for(uint32_t y = 2 * (ctbH - 1); y < rows; y++){
			for(uint32_t x = 0; x < cols && x < 2; x++){ deltaMap[(size_t)y * cols + x] = -51; }
		}
	}else{
		for(uint32_t y = 0; y < rows; y++){
			for(uint32_t x = 0; x < cols; x++){
				int v = 31;                                          // source sentinel
				for(uint32_t yy = y * 2; yy < (std::min)(y * 2 + 2, ctbH); yy++){
					for(uint32_t xx = x * 2; xx < (std::min)(x * 2 + 2, ctbW); xx++){
						v = (std::min)(v, (int)src[(size_t)yy * ctbW + xx]);
					}
				}
				int s = v * 4;
				if(s < -128){ s = -128; } else if(s > 124){ s = 124; }
				deltaMap[(size_t)y * cols + x] = (int8_t)s;
			}
		}
		deltaMap[(size_t)(rows - 1) * cols] = -128;                  // bottom-left SB
	}
	ov.set = true; ov.p = deltaMap.data(); ov.n = entries; ov.owned = std::move(converted);
	return ov;
}

// Caller holds resLock through processing and the map call so another map,
// unmap, or unregister cannot change ownership while the texture is written.
bool LookupUnmappedTexture(void* reg, void** texture, uint32_t* fmt){
	auto r = registered.find(reg);
	if(r == registered.end() || !r->second.texture || r->second.type != (uint32_t)NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX){ return false; }
	for(const auto &m : mappedToReg){
		if(m.second == reg){ return false; }
		// A texture may have more than one registered handle.
		auto alias = registered.find(m.second);
		if(alias != registered.end() && alias->second.texture == r->second.texture){ return false; }
	}
	*texture = r->second.texture; *fmt = r->second.fmt; return true;
}

// split-frame experiment latch: once the 12.1-versioned structs are rejected
// by the session we stop trying (per-frame reconfigures would otherwise
// fail-and-retry forever)
std::atomic<bool> splitRejected{false};
std::atomic<int> capsLogged{0};
std::atomic<int> h264SplitSkipLogged{0};
// one-shot log for the caps shim's pre-publish settings-file fallback
std::atomic<int> h264FileSelLogged{0};
// one-shot logs for the probe-driven open-time decisions and their rejections
std::atomic<int> openProbeLogged{0};
std::atomic<int> openRejectLogged{0};
// one-shot note for the observe-only encodeConfig-less init/reconfigure path
std::atomic<int> observeOnlyLogged{0};
// SDK 12.1 struct versions (NVENCAPI_VERSION 12|1<<24 = 0x0100000C)
constexpr uint32_t kApi121 = 12u | (1u << 24);
constexpr uint32_t kInit121 = kApi121 | (6u << 16) | (0x7u << 28) | (1u << 31);   // NV_ENC_INITIALIZE_PARAMS_VER 12.1
constexpr uint32_t kConfig121 = kApi121 | (8u << 16) | (0x7u << 28) | (1u << 31); // NV_ENC_CONFIG_VER 12.1
constexpr uint32_t kRc121 = kApi121 | (1u << 16) | (0x7u << 28);                   // NV_ENC_RC_PARAMS_VER 12.1
constexpr uint32_t kReconf121 = kApi121 | (1u << 16) | (0x7u << 28) | (1u << 31); // NV_ENC_RECONFIGURE_PARAMS_VER 12.1
std::atomic<int> bigFrameLogged{0};
// submit timestamps keyed by output bitstream pointer (vrlink uses a small
// ring of bitstream buffers; async encode returns before completion)
std::mutex submitLock;
struct Submit { void* out; double t; };
Submit submits[16];
int submitHead = 0;

// 2026-10-21 (S1): published ceiling/clamp/request relationship (see
// BitratePolicyState). Written on the encode thread, read by the info writer.
std::mutex policyLock;
BitratePolicyState policyState;

// 2026-11-11: the rate-control state the tap last wrote into the session,
// reported next to an oversized locked frame so an overshoot can be tied to
// the mode, budget and VBV that were actually in force.
struct RcDiagState {
	int mode = -1;
	unsigned avgM = 0, maxM = 0, kf = 0;
	double vbvM = 0.0;
};
RcDiagState rcDiagState;

// 2026-10-21 (S0): one admission event at the DirectMode shim. Measures the
// cadence the compositor offers vrlink, independently of NVENC. Declared in
// NvencTap.h; defined after the stats block below.

std::mutex statsLock;
NvencTapStats stats;
gxr::frameprobe::State frameProbeState; // serialized by statsLock below
uint64_t frameProbeEpoch = 0;
void* frameProbeEncoder = nullptr;
uint32_t frameProbeInitCount = 0, frameProbeLastIndex = 0;
int frameProbeCodec = -2;
// 2026-10-19: defined beside RecordRequest (which fills the window); declared
// here because ApplyOverrides reads it earlier in the file.
double RequestMedian();
// 2026-11-13: defined with the preset tables below; PublishSuccess needs the
// P1..P7 GUID mapping before that definition.
const GUID* PresetGuid(int p);
std::mutex runtimeLock;
NvencTapRuntimeState runtime;
void* runtimeEncoder = nullptr;
void* runtimePictureEncoder = nullptr;
void* runtimeInitEncoder = nullptr;
struct InitFailure { uint32_t status; std::string error; };
std::map<void*, InitFailure> firstInitFailures;
std::string acceptedRequest;

// 2026-11-03: per-session capability inventory and the actual session API
// version (major*100+minor, e.g. 1201). Kept separate from the global stats
// so multi-session / handle-reuse lifetimes do not cross-contaminate.
std::mutex capsLock;
std::map<void*, NvencCapabilities> capCache;
std::map<void*, uint32_t> sessionApiVersion;
void PublishPictureResult(void* encoder, NVENCSTATUS status, const std::string& error, bool log = true){
	if(status == NV_ENC_ERR_NEED_MORE_INPUT){ return; }
	std::lock_guard<std::mutex> guard(runtimeLock);
	const std::string message = status == NV_ENC_SUCCESS ? std::string{} : error;
	if(log && (runtime.lastPictureStatus != (uint32_t)status || runtime.pictureError != message)){
		DriverLog("NvencTap: picture status=%u%s%s", (unsigned)status, message.empty() ? "" : ": ", message.c_str());
	}
	runtimePictureEncoder = encoder; runtime.lastPictureStatus = (uint32_t)status; runtime.pictureError = message;
}
std::string RequestDescription(const NvencTapConfig& c){
	std::ostringstream out;
	out << "codec=" << c.codec << " preset=" << c.preset << '/' << c.presetAuto << '/' << c.presetMerge
		<< " split=" << c.splitMode << " multipass=" << c.multiPass << " fps=" << c.forceFps
		<< " bitrate=" << c.bitrateMbit << '/' << c.bitrateCurve << '/' << c.bitrateConstancyPct << '/' << c.maxBitrateHeadroomPct
		<< " requestReferenceMbit=" << c.bitrateRequestReferenceMbit
		<< " cbr=" << c.forceCbr << " vbv=" << c.vbvFrames << " kf=" << c.lowDelayKfScale
		<< " qp=" << c.minQp << '/' << c.minQpIntra << '/' << c.maxQp << " aq=" << c.aqStrength
		<< " qpMap=" << c.qpFovea << '/' << c.qpPeriphery << '/' << c.qpEdgeFalloff << '/' << c.qpFoveaTop << " fixLevel=" << c.fixLevel
		<< " tile=" << c.effectiveTileWidth << '/' << c.enforceTile
		<< " vui=" << c.vuiFullRange << '/' << c.vuiMatrix << '/' << c.vuiPrimaries << '/' << c.vuiTransfer
		<< " pixelRange=" << c.postPackEnabled << '/' << c.postPackLimitedRange
		<< " h264=" << c.h264GopFrames << '/' << c.h264IdrFrames << '/' << c.h264RefFrames << '/' << c.h264Entropy
		<< '/' << c.h264SliceMode << '/' << c.h264SliceData << '/' << c.h264Aud << '/' << c.h264RepeatHeaders
		<< '/' << c.h264DisableHeaders << '/' << c.h264BitstreamRestriction << '/' << c.h264VbvInitialDelay;
	return out.str();
}
void PublishFailure(void* encoder, const NvencTapConfig& cfg, NVENCSTATUS status, const std::string& error, bool initializing = false){
	std::lock_guard<std::mutex> guard(runtimeLock);
	if(initializing){
		// Capture at the error's origin under this same lock. Later retries,
		// reconfigures and failures on other encoders cannot replace its cause.
		const auto first = firstInitFailures.emplace(encoder, InitFailure{(uint32_t)status, error}).first;
		runtimeInitEncoder = encoder;
		runtime.lastInitStatus = first->second.status; runtime.initError = first->second.error;
	}
	if(runtime.lastStatus != (uint32_t)status || runtime.error != error || runtime.requestedCodec != cfg.codec){
		DriverLog("NvencTap: requested codec=%d FAILED status=%u: %s", cfg.codec, (unsigned)status, error.c_str());
	}
	if(runtimeEncoder != encoder){
		runtime.effectiveCodec = -1; runtime.effectiveRateControl = -1;
		runtime.effectiveSplit = -1; runtime.encodeWidth = 0; runtime.encodeHeight = 0;
		runtime.effectiveTuningInfo.reset(); runtime.effectivePreset.reset();
		runtime.effectiveMultiPass.reset(); runtime.effectiveAverageBitrateMbit.reset();
		runtime.effectiveMaxBitrateMbit.reset(); runtime.effectiveVbvBufferSizeBits.reset();
		runtime.effectiveVbvInitialDelayBits.reset();
	}
	runtimeEncoder = encoder; runtime.encoder = encoder; runtime.requestedCodec = cfg.codec;
	runtime.lastStatus = (uint32_t)status; runtime.error = error;
	}
	// 2026-10-18 handshake grace (see the ApplyOverrides split block): split
	// waits for a reconfigure AND this many seconds past the first successful
	// init of the connection. Facts: the Galaxy XR Steam Link client ACKs zero
	// frames when its first decoded frame is split-encoded (the first
	// reconfigure lands ~100 ms after init, still ahead of the first keyframe),
	// and a session wedged that way never recovers — even unsplit frames stay
	// unACKed (observed 11:39-11:40: switching the value to 0 did not restore
	// ACKs). The owner-verified healthy flow is: init unsplit, split engages
	// seconds later through reconfigure; the tap reproduces that automatically
	// and never rewrites the saved setting. Internal knob, not a user setting.
	// 2026-10-19 reconnect deferral (owner directive): the window is armed by
	// ANY stream boundary, not only by init. A quick client reconnect (inside
	// vrlink's ~30 s quit window, SteamVR still running) leaves the encode
	// session alive: no init follows, the init-scoped window already read
	// cleared, and the first reconfigure of the resumed connection would carry
	// split into the client's fresh decoder. Arming on the resume keeps AV1
	// split off the reconnect exactly like the fresh-connect shape.
	// AV1-only (owner directive): HEVC applies split immediately at init and
	// reconfigure, H.264 never applies it (see the split block in
	// ApplyOverrides). Internal knobs, not user settings.
	enum SplitArmSource { SplitArmInit = 0, SplitArmOpen = 1, SplitArmResume = 2 };
	double splitHandshakeGraceSeconds = 5.0;     // window length after any stream boundary
	// 2.0 s, not 1.0: ordinary hitches are sub-second and must not count as a
	// boundary. A long non-reconnect pause (level load, headset idle) still
	// re-arms — accepted cost: one reconfigure without split bits plus up to
	// splitHandshakeGraceSeconds of single-engine encoding before it re-engages.
	double splitReconnectIdleSeconds = 2.0;       // encode gap that marks a resumed connection
	std::atomic<long long> splitArmSteadyMs{0};   // window start (NowSecondsNv * 1000)
	std::atomic<long long> lastEncodeSteadyMs{0}; // last nvEncEncodePicture (NowSecondsNv * 1000)
	std::atomic<void*> lastEncodeEncoder{nullptr};
	bool SplitHandshakeCleared(){
		const long long arm = splitArmSteadyMs.load(std::memory_order_relaxed);
		if(arm <= 0){ return false; }
		return NowSecondsNv() * 1000.0 - (double)arm >= splitHandshakeGraceSeconds * 1000.0;
	}
	void ArmSplitHandshakeWindow(SplitArmSource source, double idleSeconds, bool announce){
		splitArmSteadyMs.store((long long)(NowSecondsNv() * 1000.0), std::memory_order_relaxed);
		if(!announce){ return; }
		if(source == SplitArmResume){
			DriverLog("NvencTap: split-frame: handshake window armed (stream resume after %.2f s idle; reconnect) — AV1 split held off %.0f s from here; saved streamFrame.nvencSplitMode is unchanged", idleSeconds, splitHandshakeGraceSeconds);
		}else if(source == SplitArmOpen){
			DriverLog("NvencTap: split-frame: handshake window armed (encode session open) — AV1 split held off %.0f s from here; saved streamFrame.nvencSplitMode is unchanged", splitHandshakeGraceSeconds);
		}else{
			DriverLog("NvencTap: split-frame: handshake window armed (encoder init) — AV1 split held off %.0f s from here; saved streamFrame.nvencSplitMode is unchanged", splitHandshakeGraceSeconds);
		}
	}
	void PublishSuccess(void* encoder, const NvencTapConfig& cfg, const NV_ENC_INITIALIZE_PARAMS* p, bool initializing = false){
	std::lock_guard<std::mutex> guard(runtimeLock);
	if(initializing){
		// arm the split handshake window at each fresh connection's first
		// successful init (see the grace note above); only AV1 deferral uses it
		ArmSplitHandshakeWindow(SplitArmInit, 0.0, cfg.enabled && cfg.codec == 2 && cfg.splitMode > 0);
		firstInitFailures.erase(encoder);
		// A successful replacement session also retires an archived failure
		// whose encoder was destroyed. An unrelated live encoder's failure
		// remains intact until that encoder itself initializes successfully.
		if(runtimeInitEncoder == encoder || firstInitFailures.count(runtimeInitEncoder) == 0){
			runtime.lastInitStatus = 0; runtime.initError.clear(); runtimeInitEncoder = nullptr;
		}
	}
	const std::string description = RequestDescription(cfg);
	if(acceptedRequest != description){
		if(cfg.enabled){ DriverLog("NvencTap: accepted settings: %s", description.c_str()); }
		acceptedRequest = description;
	}
	const int codec = memcmp(&p->encodeGUID, &NV_ENC_CODEC_H264_GUID, sizeof(GUID)) == 0 ? 1
		: memcmp(&p->encodeGUID, &NV_ENC_CODEC_AV1_GUID, sizeof(GUID)) == 0 ? 2
		: memcmp(&p->encodeGUID, &NV_ENC_CODEC_HEVC_GUID, sizeof(GUID)) == 0 ? 0 : -1;
	const int rc = p->encodeConfig ? (int)p->encodeConfig->rcParams.rateControlMode : -1;
	int appliedPreset = 0;
	for(int n = 1; n <= 7; ++n){
		const GUID* pg = PresetGuid(n);
		if(pg && memcmp(&p->presetGUID, pg, sizeof(GUID)) == 0){ appliedPreset = n; break; }
	}
	const int appliedMultiPass = p->encodeConfig ? (int)p->encodeConfig->rcParams.multiPass : -1;
	if(cfg.enabled && (runtime.lastStatus || !runtime.error.empty() || runtimeEncoder != encoder || runtime.effectiveCodec != codec
		|| runtime.effectiveRateControl != rc
		|| runtime.encodeWidth != p->encodeWidth || runtime.encodeHeight != p->encodeHeight
		|| runtime.effectiveTuningInfo != (int)p->tuningInfo || runtime.effectivePreset != appliedPreset
		|| runtime.effectiveMultiPass != appliedMultiPass)){
		DriverLog("NvencTap: applied requested codec=%d effective codec=%d RC=%d size=%ux%u tuning=%u preset=P%d multipass=%d",
			cfg.codec, codec, rc, p->encodeWidth, p->encodeHeight, (unsigned)p->tuningInfo, appliedPreset, appliedMultiPass);
	}
	runtimeEncoder = encoder; runtime.encoder = encoder; runtime.requestedCodec = cfg.codec; runtime.effectiveCodec = codec;
	runtime.lastStatus = NV_ENC_SUCCESS; runtime.error.clear();
	runtime.effectiveRateControl = rc; runtime.encodeWidth = p->encodeWidth; runtime.encodeHeight = p->encodeHeight;
	runtime.effectiveSplit = codec == 1 ? -1 : ((p->version & 0xFFFFu) >= 12 ? (int)p->splitEncodeMode : -1);
	// 2026-11-13: publish the applied rate-control shape. This runs only after
	// NVENC accepted the parameters and before Guarded restores the caller's
	// bytes, so it describes what the session really got, not the request.
	runtime.effectiveTuningInfo = (int)p->tuningInfo;
	runtime.effectivePreset = appliedPreset;
	runtime.effectiveMultiPass.reset(); runtime.effectiveAverageBitrateMbit.reset();
	runtime.effectiveMaxBitrateMbit.reset(); runtime.effectiveVbvBufferSizeBits.reset();
	runtime.effectiveVbvInitialDelayBits.reset();
	if(p->encodeConfig){
		const NV_ENC_RC_PARAMS &applied = p->encodeConfig->rcParams;
		runtime.effectiveMultiPass = (int)applied.multiPass;
		runtime.effectiveAverageBitrateMbit = applied.averageBitRate / 1000000.0;
		runtime.effectiveMaxBitrateMbit = applied.maxBitRate / 1000000.0;
		runtime.effectiveVbvBufferSizeBits = applied.vbvBufferSize;
		runtime.effectiveVbvInitialDelayBits = applied.vbvInitialDelay;
	}
}
// ---- session upgrade state ----
std::mutex upgradedLock;
std::set<void*> upgradedSessions;         // encoder handles opened as 12.1
std::map<void*, int> sessionCodecs;       // guarded by upgradedLock
std::atomic<bool> sessionUpgradeRejected{false};
std::atomic<int> sessionNoteLogged{0};
// fresh-connect split deferral (2026-10-18): one-shot explanation per process
std::atomic<int> splitInitDeferLogged{0};
constexpr uint32_t kApi111 = 11u | (1u << 24);
// sizes of the two structs that grew 11.1 -> 12.1 (x64, both compilers use
// natural alignment for these; verified by compiling both headers)
constexpr size_t kPicParams11Size = 3344;   // 12.1: 3360
constexpr size_t kLockBitstream11Size = 1544; // 12.1: 1552
constexpr size_t kScratch = 4096;

// ---------------------------------------------------------------------------
// 2026-10-16 pre-publish settings.json probe (the caps shim's pattern, now
// shared). An early connection reaches OpenEncodeSessionEx /
// NvEncodeAPICreateInstance before the first SetConfig publish
// (cfgPublished false): GetConfig() is still the empty default, so open
// decisions would miss the user's request and hand back a pristine 11.1
// session whose init then refuses the requested split/AV1 with no fallback.
// Before the first publish, the open/function-list decisions read this
// build's settings.json instead, parsing the streamFrame keys exactly like
// the ConfigLoader: a missing key keeps the setting's default (nvencTap
// true, nvencCodec 0, nvencSplitMode 1). Wrong-type boolean values keep the
// boolean default, while invalid integer fields retain a visible requestError
// like the loader instead of being truncated or silently substituted. An
// unreadable/malformed file leaves defaults in place without rewriting it.
struct PrePublishProbe { bool tap = true; int codec = 0; int splitMode = 1; int tile = 1536; std::string requestError; };
PrePublishProbe ProbePrePublishConfig(){
	PrePublishProbe probe;
	const char* appdata = getenv("APPDATA");
	if(!appdata){ return probe; }
#ifdef VENDOR_GALAXYXR
	const std::string path = std::string(appdata) + "/GalaxyXR/CustomHeadset/settings.json";
#else
	const std::string path = std::string(appdata) + "/CustomHeadset/settings.json";
#endif
	std::ifstream file(path);
	if(!file){ return probe; }
	const auto json = nlohmann::json::parse(file, nullptr, false, true);
	if(!json.is_object()){ return probe; }
	const auto readInteger = [&](const nlohmann::json& object, const char* key, int& value, const char* section){
		if(!object.contains(key)){ return; }
		const auto& item = object[key];
		if(!item.is_number_integer() || item.get<double>() < -2147483648.0 || item.get<double>() > 2147483647.0){
			probe.requestError = std::string(section) + "." + key + " must be a 32-bit integer; requested " + item.dump();
			return;
		}
		value = item.get<int>();
	};
	// Match GalaxyXR_EffectiveTileWidth: explicit custom width or a legacy
	// tier width. These are allocation requests, never inferred GPU limits.
	if(json.contains("galaxyXr") && json["galaxyXr"].is_object()){
		const auto& galaxy = json["galaxyXr"];
		const std::string quality = galaxy.contains("streamQuality") && galaxy["streamQuality"].is_string()
			? galaxy["streamQuality"].get<std::string>() : "custom";
		if(quality == "custom"){
			readInteger(galaxy, "customStreamFormatWidth", probe.tile, "galaxyXr");
		}else if(const auto* tier = FindGxrStreamTier(quality)){ probe.tile = tier->width; }
	}
	if(!json.contains("streamFrame") || !json["streamFrame"].is_object()){ return probe; }
	const auto& frame = json["streamFrame"];
	// nvencTap: boolean only; absent or legacy-typed -> the loader default (true)
	if(frame.contains("nvencTap") && frame["nvencTap"].is_boolean()){ probe.tap = frame["nvencTap"].get<bool>(); }
	// Integer fields mirror the loader's explicit validation. Invalid stored
	// requests remain on disk and surface as failures rather than truncation.
	readInteger(frame, "nvencCodec", probe.codec, "streamFrame");
	readInteger(frame, "nvencSplitMode", probe.splitMode, "streamFrame");
	return probe;
}
// Open-time decision config: the published snapshot once one exists, else
// the settings.json probe above (recorded once with its one-shot log).
NvencTapConfig OpenDecisionConfig(){
	if(NvencTap::Get().ConfigPublished()){ return NvencTap::Get().GetConfig(); }
	const PrePublishProbe probe = ProbePrePublishConfig();
	if(openProbeLogged.fetch_add(1) < 1){
		DriverLog("NvencTap: pre-publish settings probe (no published config yet): nvencTap=%d nvencCodec=%d nvencSplitMode=%d — open decisions mirror the ConfigLoader parse defaults until the first publish takes over",
			(int)probe.tap, probe.codec, probe.splitMode);
	}
	NvencTapConfig cfg;
	cfg.enabled = probe.tap; cfg.codec = probe.codec; cfg.splitMode = probe.splitMode;
	cfg.effectiveTileWidth = probe.tile;
	cfg.requestError = probe.requestError;
#ifdef VENDOR_GALAXYXR
	cfg.enforceTile = true;
#endif
	return cfg;
}

bool UpgradeWanted(){
	// 2026-09-25: OFF must also stop upgrades for newly opened sessions and
	// function lists after the hook is installed. Existing upgraded sessions
	// still use Upgraded(encoder) below: their ABI cannot change mid-session.
	// 2026-10-16 pre-publish parity: an early connection consults the
	// caps-shim settings.json probe (OpenDecisionConfig) instead of the
	// empty config. A genuinely rejected 12.1 open or function list keeps
	// failing visibly (PublishFailure plus a one-shot status log); no
	// pristine open and no silent downgrade latch, and no codec-to-codec or
	// same-codec value substitution fallback ever runs here.
	const NvencTapConfig cfg = OpenDecisionConfig();
	return cfg.enabled && (cfg.codec == 2 || cfg.splitMode > 0);
}
bool Upgraded(void* encoder){ std::lock_guard<std::mutex> g(upgradedLock); return upgradedSessions.count(encoder) != 0; }

// ---- per-session authority ----
// Vendor build: only a session opened while a Galaxy link epoch was admitted
// is ever touched by tap policy. Live  = opened in the CURRENT epoch (existing
// behaviour); Stale = opened in an epoch that has since closed or been replaced
// (ABI retag, resource bookkeeping and drain only: no caps/codec/QP/bitrate/
// post-pack writes, no stats, no published failure); Pristine = opened with no
// admitted epoch or unknown handle (original NVENC untouched, never adopted
// retroactively). The neutral build keeps legacy behaviour: every handle is Live.
enum class Auth { Live, Stale, Pristine };

// Drop the registered/mapped bookkeeping of every resource registered through
// `encoder` (destroyed session / recycled handle). Lock order: records are
// collected and removed under resLock only; the post-pack cache release runs
// AFTER resLock is dropped (resLock -> post-pack mutex is the Map order, and
// no path takes them the other way). A texture still referenced by another
// registration (aliases map the same texture) keeps its cache entry.
// Returns whether anything was dropped.
bool EraseSessionResources(void* encoder){
	std::vector<void*> textures;
	bool any = false;
	{
		std::lock_guard<std::mutex> g(resLock);
		for(auto it = registered.begin(); it != registered.end();){
			if(it->second.encoder == encoder){
				any = true;
				for(auto m = mappedToReg.begin(); m != mappedToReg.end();){ if(m->second == it->first){ m = mappedToReg.erase(m); }else{ ++m; } }
				if(it->second.texture){ textures.push_back(it->second.texture); }
				it = registered.erase(it);
			}else{ ++it; }
		}
		for(auto t = textures.begin(); t != textures.end();){
			bool stillUsed = false;
			for(const auto& r : registered){ if(r.second.texture == *t){ stillUsed = true; break; } }
			t = stillUsed ? textures.erase(t) : t + 1;
		}
	}
	if(!textures.empty()){ NvencPostPack::ReleaseTextures(textures.data(), textures.size()); }
	return any;
}
#ifdef VENDOR_GALAXYXR
struct SessionRecord { bool owned; uint64_t epoch; };
std::map<void*, SessionRecord> sessionRecords; // guarded by upgradedLock
Auth AuthorityOf(void* encoder){
	SessionRecord record{false, 0};
	{
		std::lock_guard<std::mutex> g(upgradedLock);
		const auto it = sessionRecords.find(encoder);
		if(it == sessionRecords.end()){ return Auth::Pristine; }
		record = it->second;
	}
	if(!record.owned){ return Auth::Pristine; }
	const uint64_t current = gxr::galaxylink::CurrentEpoch();
	return (current != 0 && current == record.epoch) ? Auth::Live : Auth::Stale;
}
void RecordSession(void* encoder, bool owned, uint64_t epoch){
	std::lock_guard<std::mutex> g(upgradedLock);
	sessionRecords[encoder] = { owned, epoch };
}
// one-shot diagnostics recorded by lock-free paths; flushed by FlushDeferredDiagnostics
enum DeferredBit : uint32_t {
	DeferredExportMismatch = 1u << 0, DeferredUnsupportedList = 1u << 1, DeferredListInconsistent = 1u << 2,
	DeferredOrphanReused = 1u << 3, DeferredPrivateListRejected = 1u << 4, DeferredForeignCaller = 1u << 5,
	DeferredImportsUnsupported = 1u << 6, DeferredPatchFailed = 1u << 7, DeferredStalePolicyCall = 1u << 8,
};
std::atomic<uint32_t> deferredPending{0};
std::atomic<uint32_t> deferredLogged{0};
// lock-free; skips the atomic read-modify-write once the note was reported
void Defer(uint32_t bit){
	if(deferredLogged.load(std::memory_order_relaxed) & bit){ return; }
	deferredPending.fetch_or(bit, std::memory_order_relaxed);
}
// The real NvEncodeAPICreateInstance, published by the GetProcAddress hook. The
// shim reads ONLY this atomic (never a second plain pointer), so a thunk handed
// to vrlink can never be called before the function it forwards to is visible.
std::atomic<void*> realCreateInstance{nullptr};
void ForgetSessionCaches(void* encoder); // capability / preset caches (defined with presetCache)
void ForgetSessionBookkeeping(void* encoder){
	bool orphan;
	{
		std::lock_guard<std::mutex> g(upgradedLock);
		// every erase runs unconditionally: a recycled handle must not keep the
		// previous session's ABI upgrade, codec, API version or authority
		const size_t records = sessionRecords.erase(encoder);
		const size_t upgraded = upgradedSessions.erase(encoder);
		orphan = records != 0 || upgraded != 0;
		sessionCodecs.erase(encoder);
		sessionApiVersion.erase(encoder);
	}
	ForgetSessionCaches(encoder);
	if(EraseSessionResources(encoder)){ orphan = true; } // also releases their post-pack cache entries
	if(orphan){ Defer(DeferredOrphanReused); }
}
#else
inline Auth AuthorityOf(void*){ return Auth::Live; }
#endif
inline bool Is111(uint32_t v){ return (v & 0xFFFFu) == 11u; }
inline uint32_t Tag121(uint32_t digit, bool b31){ return kApi121 | (digit << 16) | (0x7u << 28) | (b31 ? (1u << 31) : 0u); }
// re-tag one version word for the duration of a call; restores on scope exit
struct Retag {
	uint32_t* slot[6]; uint32_t old[6]; int n = 0;
	void* owner = nullptr; // session whose authority decides whether the retag is counted
	Retag() = default;
	explicit Retag(void* encoder) : owner(encoder) {}
	void add(uint32_t* p, uint32_t digit, bool b31){
		if(!p || n >= 6 || !Is111(*p)){ return; }
		slot[n] = p; old[n] = *p; *p = Tag121(digit, b31); n++;
	}
	~Retag(){ for(int i = n - 1; i >= 0; i--){ *slot[i] = old[i]; } if(n && NvencTap::Get().GetConfig().enabled && (!owner || AuthorityOf(owner) == Auth::Live)){ std::lock_guard<std::mutex> g(statsLock); stats.retagCalls++; } }
};
void RetagInitParams(Retag &r, NV_ENC_INITIALIZE_PARAMS* p){
	if(!p){ return; }
	r.add(&p->version, 6, true);
	if(p->encodeConfig){ r.add(&p->encodeConfig->version, 8, true); r.add(&p->encodeConfig->rcParams.version, 1, false); }
}

// NV_ENC_PIC_PARAMS 11.1 -> 12.1 explicit field copy (the session retag
// presents a 12.1 ABI to the driver). The old raw byte copy assumed the
// caller's first kPicParams11Size bytes match the modern struct; they do
// not: the AV1 union member grew codecPicParams (11.1 1536 -> 12.1 1552),
// shifting every field from meHintCountsPerBlock on by +16 (qpDeltaMap
// 1696 -> 1712), and the vendored 13.1 header disagrees with BOTH again
// (union 1544: meHintCountsPerBlock/meExternalHints at 1624/1656).
// Measured with the portable cl against the 11.1, 12.1 and vendored
// headers (builds/GalaxyXR-Driver/build/picparams-geometry-20261015):
//   * offsets 0..79 are identical in all three eras -> copy by name;
//   * qpDeltaMap/qpDeltaMapSize: read at the 11.1 offsets (1696/1704; the
//     reference repo's legacy_picture.cpp static_asserts 1696 the same
//     way) and written through the vendored members — 13.1 and 12.1 agree
//     exactly there (1712/1720), which is the slot the driver reads;
//   * meHintCountsPerBlock/meExternalHints moved in every era, vrlink
//     passes neither, and the old copy effectively delivered zeros for
//     them: left zero;
//   * codecPicParams (union content is era-specific) and every field after
//     qpDeltaMapSize: left zero (the byte copy only ever misplaced those).
constexpr size_t kQpDeltaMap11Offset = 1696;      // 11.1 layout, sizeof = 3344
constexpr size_t kQpDeltaMapSize11Offset = kQpDeltaMap11Offset + 8; // 1704
static_assert(offsetof(NV_ENC_PIC_PARAMS, inputWidth) == 4 && offsetof(NV_ENC_PIC_PARAMS, inputTimeStamp) == 24
	&& offsetof(NV_ENC_PIC_PARAMS, inputBuffer) == 40 && offsetof(NV_ENC_PIC_PARAMS, bufferFmt) == 64
	&& offsetof(NV_ENC_PIC_PARAMS, pictureStruct) == 68 && offsetof(NV_ENC_PIC_PARAMS, pictureType) == 72
	&& offsetof(NV_ENC_PIC_PARAMS, codecPicParams) == 80, "PIC_PARAMS 11.1/12.1/13.1 common prefix moved");
static_assert(offsetof(NV_ENC_PIC_PARAMS, qpDeltaMap) == 1712 && offsetof(NV_ENC_PIC_PARAMS, qpDeltaMapSize) == 1720,
	"PIC_PARAMS 12.1/13.1 qpDeltaMap slot moved (the 11.1->12.1 copy assumes it)");

NV_ENC_PIC_PARAMS* CopyPicParams111To121(const NV_ENC_PIC_PARAMS* caller, NV_ENC_PIC_PARAMS* out){
	const unsigned char* raw = (const unsigned char*)caller;
	*out = NV_ENC_PIC_PARAMS{}; // zero first: fields without an 11.1 counterpart stay 0
	out->version = Tag121(6, true); // the existing 11.1 -> 12.1 retag
	out->inputWidth = caller->inputWidth;
	out->inputHeight = caller->inputHeight;
	out->inputPitch = caller->inputPitch;
	out->encodePicFlags = caller->encodePicFlags;
	out->frameIdx = caller->frameIdx;
	out->inputTimeStamp = caller->inputTimeStamp;
	out->inputDuration = caller->inputDuration;
	out->inputBuffer = caller->inputBuffer;         // stays null on the EOS/flush calls
	out->outputBitstream = caller->outputBitstream; // ditto
	out->completionEvent = caller->completionEvent;
	out->bufferFmt = caller->bufferFmt;
	out->pictureStruct = caller->pictureStruct;
	out->pictureType = caller->pictureType;
	out->qpDeltaMap = *(int8_t* const*)(raw + kQpDeltaMap11Offset);
	out->qpDeltaMapSize = *(const uint32_t*)(raw + kQpDeltaMapSize11Offset);
	return out;
}
std::atomic<int> initLogged{0};
std::atomic<int> reconfLogged{0};
std::atomic<int> registerLogged{0};
std::atomic<int> encodeLogged{0};
// first-encode / first-lock instrumentation (no behavior change)
std::atomic<long long> encFails{0}, lockCalls{0};
std::atomic<uint32_t> lockLastSize{0};
std::atomic<int> encFailLogged{0};
std::atomic<int> firstLockLogged{0};
// last encode-failure reason, kept for the heartbeat: the failure log lines
// rotate out of vrserver.txt under a flood, the heartbeat is periodic
std::atomic<uint32_t> lastEncFailStatus{0};
char lastEncFailStr[96] = {0}; // guarded by statsLock
// last per-frame delta-map sizes over the encode boundary (bytes; one byte
// per block) - rotation-proof probe: H.264 wants the 16x16 MB grid count,
// HEVC the 32x32 CTB count, AV1 the SB count
std::atomic<uint32_t> lastMapInSize{0xFFFFFFFFu};
std::atomic<uint32_t> lastMapUseSize{0xFFFFFFFFu};
std::atomic<int> lastMapSel{-1};
std::atomic<int> lastSessCodec{-1};   // live session codec seen by the last encode (-1: none)

// NVENCAPI_STRUCT_VERSION(ver) = NVENCAPI_VERSION | (ver<<16) | (0x7<<28),
// NVENCAPI_VERSION = MAJOR | (MINOR<<24). bits 0..15 carry the major.
uint32_t ApiMajor(uint32_t structVersion){ return structVersion & 0xFFFFu; }
uint32_t StructVer(uint32_t structVersion){ return (structVersion >> 16) & 0xFFu; }
bool ApiSupported(uint32_t major){ return major >= 9 && major <= 13; }

bool IsHevc(const GUID &g){ return memcmp(&g, &NV_ENC_CODEC_HEVC_GUID, sizeof(GUID)) == 0; }
bool IsH264(const GUID &g){ return memcmp(&g, &NV_ENC_CODEC_H264_GUID, sizeof(GUID)) == 0; }

// Live codec of each encoder that last initialized/reconfigured SUCCESSFULLY
// (0 HEVC / 1 H264 / 2 AV1). The per-frame map paths key off this, not the
// tap config: failed reconfiguration leaves the last accepted session
// codec live; map conversion must follow that accepted codec.
int CodecOfGuid(const GUID &g){
	if(IsH264(g)){ return 1; }
	if(memcmp(&g, &NV_ENC_CODEC_AV1_GUID, sizeof(GUID)) == 0){ return 2; }
	if(IsHevc(g)){ return 0; }
	return -1;
}
void SetSessionCodec(void* encoder, int codec){
	if(!encoder || codec < 0){ return; }
	std::lock_guard<std::mutex> g(upgradedLock);
	sessionCodecs[encoder] = codec;
}
int SessionCodecOf(void* encoder){
	if(!encoder){ return -1; }
	std::lock_guard<std::mutex> g(upgradedLock);
	std::map<void*, int>::const_iterator it = sessionCodecs.find(encoder);
	return it == sessionCodecs.end() ? -1 : it->second;
}

// 2026-11-03: capability-inventory helpers.
static const GUID* CodecGuid(int codec){
	switch(codec){ case 0: return &NV_ENC_CODEC_HEVC_GUID; case 1: return &NV_ENC_CODEC_H264_GUID; case 2: return &NV_ENC_CODEC_AV1_GUID; default: return nullptr; }
}

// Forward: defined later beside Snapshot.
const GUID* PresetGuid(int p);
static const char* CodecShortName(int codec){
	switch(codec){ case 0: return "HEVC"; case 1: return "H.264"; case 2: return "AV1"; default: return "unknown"; }
}

static bool IsTenBitBufferFormat(NV_ENC_BUFFER_FORMAT fmt){
	switch(fmt){
		case NV_ENC_BUFFER_FORMAT_YUV420_10BIT:
		case NV_ENC_BUFFER_FORMAT_YUV444_10BIT:
		case NV_ENC_BUFFER_FORMAT_ARGB10:
		case NV_ENC_BUFFER_FORMAT_ABGR10:
		case NV_ENC_BUFFER_FORMAT_P210:
			return true;
		default:
			return false;
	}
}

static std::string FormatLuid(const LUID& luid){
	char buf[32];
	snprintf(buf, sizeof(buf), "%08x%08x", (uint32_t)luid.HighPart, (uint32_t)luid.LowPart);
	return std::string(buf);
}

static void ResolveAdapterIdentity(const NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS* params, NvencAdapterIdentity& id){
	if(!params || params->deviceType != NV_ENC_DEVICE_TYPE_DIRECTX || !params->device){ return; }
	IUnknown* unk = static_cast<IUnknown*>(params->device);
	IDXGIDevice* dxgi = nullptr;
	if(FAILED(unk->QueryInterface(__uuidof(IDXGIDevice), reinterpret_cast<void**>(&dxgi)))){ return; }
	IDXGIAdapter* adapter = nullptr;
	HRESULT hr = dxgi->GetAdapter(&adapter);
	dxgi->Release();
	if(FAILED(hr) || !adapter){ return; }
	DXGI_ADAPTER_DESC desc{};
	hr = adapter->GetDesc(&desc);
	adapter->Release();
	if(FAILED(hr)){ return; }
	id.luid = FormatLuid(desc.AdapterLuid);
	id.vendorId = desc.VendorId;
	int len = WideCharToMultiByte(CP_UTF8, 0, desc.Description, -1, nullptr, 0, nullptr, nullptr);
	if(len > 0){
		std::string name(len, '\0');
		WideCharToMultiByte(CP_UTF8, 0, desc.Description, -1, &name[0], len, nullptr, nullptr);
		if(!name.empty() && name.back() == '\0'){ name.pop_back(); }
		id.gpuName = std::move(name);
	}
}

static uint32_t EncodedApiVersion(uint32_t nvencApiVersion){
	const uint32_t major = nvencApiVersion & 0xFFFFu;
	const uint32_t minor = (nvencApiVersion >> 24) & 0xFu;
	return major * 100u + minor;
}

static int PresetNumberFromGuid(const GUID& g){
	for(int p = 1; p <= 7; p++){
		const GUID* pg = PresetGuid(p);
		if(pg && memcmp(&g, pg, sizeof(GUID)) == 0){ return p; }
	}
	return 0;
}

static void QueryCodecCapabilities(void* encoder, uint32_t apiMajor, uint32_t apiMinor, NvencCodecCapability caps[3]){
	if(!origGetEncodeCaps){ return; }
	// 1. Authoritative codec GUID inventory. If the driver enumerates GUIDs,
	// a missing codec is a known negative; width/height alone are not reliable.
	bool guidKnown[3] = {false, false, false};
	bool guidSupported[3] = {false, false, false};
	bool enumSucceeded = false;
	if(origGetEncodeGUIDCount && origGetEncodeGUIDs){
		uint32_t count = 0;
		if(origGetEncodeGUIDCount(encoder, &count) == NV_ENC_SUCCESS){
			if(count > 0){
				std::vector<GUID> guids(count);
				uint32_t fetched = 0;
				if(origGetEncodeGUIDs(encoder, guids.data(), count, &fetched) == NV_ENC_SUCCESS){
					enumSucceeded = true;
					for(uint32_t i = 0; i < fetched && i < count; i++){
						int idx = CodecOfGuid(guids[i]);
						if(idx >= 0){ guidKnown[idx] = true; guidSupported[idx] = true; }
					}
				}
			}else{
				enumSucceeded = true; // driver reports zero supported codecs
			}
		}
	}
	const NV_ENC_CAPS_PARAM cpBase = {};
	for(int codec = 0; codec < 3; codec++){
		const GUID* guid = CodecGuid(codec);
		if(!guid){ continue; }
		// AV1 only exists from NVENC API 12.0 onward.
		if(codec == 2 && (apiMajor < 12)){ continue; }
		NvencCodecCapability& cap = caps[codec];
		if(guidKnown[codec]){
			cap.supported = guidSupported[codec];
			if(!guidSupported[codec]){ continue; }
		}else if(enumSucceeded){
			// Enumeration succeeded but this codec was absent: known unsupported.
			cap.supported = false;
			continue;
		}
		NV_ENC_CAPS_PARAM cp = cpBase;
		cp.version = apiMajor | (apiMinor << 24) | (1u << 16) | (0x7u << 28);
		auto q = [&](NV_ENC_CAPS what, int* out)->bool{
			cp.capsToQuery = what;
			return origGetEncodeCaps(encoder, *guid, &cp, out) == NV_ENC_SUCCESS;
		};
		int v = 0;
		if(q(NV_ENC_CAPS_WIDTH_MAX, &v)){ cap.maxWidth = (uint32_t)v; }
		if(q(NV_ENC_CAPS_HEIGHT_MAX, &v)){ cap.maxHeight = (uint32_t)v; }
		// Fallback support detection only when the driver did not enumerate GUIDs.
		if(!guidKnown[codec] && cap.maxWidth.has_value() && cap.maxHeight.has_value()){
			cap.supported = (cap.maxWidth.value() > 0 && cap.maxHeight.value() > 0);
		}
		if(q(NV_ENC_CAPS_NUM_ENCODER_ENGINES, &v)){ cap.engines = (uint32_t)v; }
		if(q(NV_ENC_CAPS_SUPPORT_10BIT_ENCODE, &v)){ cap.tenBit = (v != 0); }
		// 2. Authoritative preset GUID enumeration. Tuning-specific config queries
		// are not the same as preset GUID support.
		if(origGetEncodePresetCount && origGetEncodePresetGUIDs){
			uint32_t pcount = 0;
			if(origGetEncodePresetCount(encoder, *guid, &pcount) == NV_ENC_SUCCESS && pcount > 0){
				std::vector<GUID> pguids(pcount);
				uint32_t pfetched = 0;
				if(origGetEncodePresetGUIDs(encoder, *guid, pguids.data(), pcount, &pfetched) == NV_ENC_SUCCESS){
					std::vector<int> presets;
					for(uint32_t i = 0; i < pfetched && i < pcount; i++){
						int pn = PresetNumberFromGuid(pguids[i]);
						if(pn){ presets.push_back(pn); }
					}
					// An empty mapped list (driver reported no recognizable presets)
					// must stay unknown so we do not falsely reject P1..P7.
					if(!presets.empty()){ cap.presets = std::move(presets); }
				}
			}
		}
		// H.264 genuinely does not support split-frame encoding. For other
		// codecs we defer to the engine count check in ValidateCapabilities,
		// which names the exact requested strip count rather than claiming a
		// generic unsupported capability.
		if(codec == 1){ cap.split = false; }
	}
}

static void EnsureCapabilitiesQueried(void* encoder, uint32_t initStructVersion){
	if(!encoder){ return; }
	// The actual opened session API wins over the caller's struct version word.
	uint32_t apiMajor = 0, apiMinor = 0;
	{
		std::lock_guard<std::mutex> g(upgradedLock);
		auto it = sessionApiVersion.find(encoder);
		if(it != sessionApiVersion.end()){
			const uint32_t enc = it->second;
			apiMajor = enc / 100u;
			apiMinor = enc % 100u;
		}
	}
	if(apiMajor == 0){
		apiMajor = ApiMajor(initStructVersion);
		apiMinor = (initStructVersion >> 24) & 0xFu;
	}
	if(apiMajor == 0){ return; }
	std::lock_guard<std::mutex> g(capsLock);
	NvencCapabilities& caps = capCache[encoder];
	if(caps.queried){ return; }
	caps.queried = true;
	if(!caps.adapter.apiVersion.has_value() || caps.adapter.apiVersion.value() == 0){
		caps.adapter.apiVersion = apiMajor * 100u + apiMinor;
	}
	QueryCodecCapabilities(encoder, apiMajor, apiMinor, caps.codecs.data());
}

static NvencCapabilities GetCapabilitiesForEncoder(void* encoder){
	std::lock_guard<std::mutex> g(capsLock);
	auto it = capCache.find(encoder);
	return it == capCache.end() ? NvencCapabilities{} : it->second;
}

static std::string ValidateCapabilities(const NvencTapConfig& cfg, void* encoder, const NV_ENC_INITIALIZE_PARAMS* p){
	if(!cfg.enabled || !encoder || !p || !p->encodeConfig){ return {}; }
	const NvencCapabilities caps = GetCapabilitiesForEncoder(encoder);
	int targetCodec = cfg.codec > 0 ? cfg.codec : CodecOfGuid(p->encodeGUID);
	if(targetCodec < 0 || targetCodec > 2){ return {}; }
	const NvencCodecCapability& cc = caps.codecs[targetCodec];
	const char* name = CodecShortName(targetCodec);
	if(cc.supported.has_value() && !cc.supported.value()){
		return std::string("streamFrame.nvencCodec ") + name + " is not supported by this NVIDIA session.";
	}
	if(IsTenBitBufferFormat(p->bufferFormat)){
		if(targetCodec == 1){ return "streamFrame.nvencCodec=1 (H.264 High 8-bit) cannot encode a 10-bit input surface."; }
		if(cc.tenBit.has_value() && !cc.tenBit.value()){
			return std::string("streamFrame.nvencCodec=") + std::to_string(targetCodec) + " (" + name + ") 10-bit encoding is not supported by this NVIDIA session.";
		}
	}
	if(cfg.preset != 0 && cc.presets.has_value()){
		const auto& ps = cc.presets.value();
		if(std::find(ps.begin(), ps.end(), cfg.preset) == ps.end()){
			return std::string("streamFrame.nvencPreset ") + std::to_string(cfg.preset) + " is not supported for " + name + " on this NVIDIA session.";
		}
	}
	if(cfg.splitMode >= 2 && cfg.splitMode <= 4){
		if(targetCodec == 1){
			return "streamFrame.nvencSplitMode " + std::to_string(cfg.splitMode) + " is not applicable to H.264.";
		}
		if(cc.split.has_value() && !cc.split.value()){
			return "streamFrame.nvencSplitMode " + std::to_string(cfg.splitMode) + " strip encoding is not supported on this NVIDIA session.";
		}
		if(cc.engines.has_value() && cfg.splitMode > (int)cc.engines.value()){
			return "streamFrame.nvencSplitMode " + std::to_string(cfg.splitMode) + " requires " + std::to_string(cfg.splitMode) + " encoder engines; this session reports " + std::to_string(cc.engines.value()) + ". The requested strip count is retained and not lowered.";
		}
	}
	return {};
}

const char* PresetName(const GUID &g){
	if(memcmp(&g, &NV_ENC_PRESET_P1_GUID, sizeof(GUID)) == 0) return "P1";
	if(memcmp(&g, &NV_ENC_PRESET_P2_GUID, sizeof(GUID)) == 0) return "P2";
	if(memcmp(&g, &NV_ENC_PRESET_P3_GUID, sizeof(GUID)) == 0) return "P3";
	if(memcmp(&g, &NV_ENC_PRESET_P4_GUID, sizeof(GUID)) == 0) return "P4";
	if(memcmp(&g, &NV_ENC_PRESET_P5_GUID, sizeof(GUID)) == 0) return "P5";
	if(memcmp(&g, &NV_ENC_PRESET_P6_GUID, sizeof(GUID)) == 0) return "P6";
	if(memcmp(&g, &NV_ENC_PRESET_P7_GUID, sizeof(GUID)) == 0) return "P7";
	return "other/legacy";
}
const char* RcName(uint32_t m){
	switch(m){ case NV_ENC_PARAMS_RC_CONSTQP: return "CONSTQP"; case NV_ENC_PARAMS_RC_VBR: return "VBR";
		case NV_ENC_PARAMS_RC_CBR: return "CBR"; default: return "other"; }
}

// VirtualQuery-guarded hex dump for offline decoding
void SafeHexDump(const char* label, const void* ptr, size_t want){
	if(!ptr){ return; }
	MEMORY_BASIC_INFORMATION mbi = {};
	if(VirtualQuery(ptr, &mbi, sizeof(mbi)) == 0){ return; }
	if(mbi.State != MEM_COMMIT || (mbi.Protect & (PAGE_NOACCESS | PAGE_GUARD))){ return; }
	size_t avail = (size_t)((const char*)mbi.BaseAddress + mbi.RegionSize - (const char*)ptr);
	size_t len = (std::min)(want, avail);
	const unsigned char* p = (const unsigned char*)ptr;
	char line[3 * 32 + 8];
	for(size_t off = 0; off < len; off += 32){
		size_t n = (std::min<size_t>)(32, len - off);
		char* w = line;
		for(size_t i = 0; i < n; i++){ w += snprintf(w, 4, "%02x ", p[off + i]); }
		DriverLog("NvencTap: %s +0x%03x: %s", label, (unsigned)off, line);
	}
}

// ---------------------------------------------------------------------------
// snapshot / override / restore of the caller-owned NV_ENC_INITIALIZE_PARAMS
// and the NV_ENC_CONFIG it points at. Only the fields we touch are saved.
// ---------------------------------------------------------------------------
struct Snapshot {
	bool valid = false;
	std::string error;
	NV_ENC_INITIALIZE_PARAMS* initPtr = nullptr;
	NV_ENC_CONFIG* cfgPtr = nullptr;
	NV_ENC_RC_PARAMS rc{};
	GUID preset{};
	uint32_t fpsNum = 0, fpsDen = 0;
	// split experiment: the three version words and the init bitfield word
	bool split = false;
	uint32_t initVer = 0, cfgVer = 0, rcVer = 0, initFlags = 0;
	uint32_t splitModeApplied = 0;   // the value written by the split branch (for the pristine retry)
	uint32_t tuning = 0;             // original tuningInfo (the AV1 swap re-tunes ULL->LL)
	uint32_t hevcLevel = 0, hevcTier = 0, hevcRefs = 0;
	NV_ENC_CONFIG_HEVC_VUI_PARAMETERS hevcVui{};
	bool hevc = false;
	// 2026-10-13 codec override: original GUIDs + a byte window of the
	// codec-config union. 256 bytes covers every field of every union
	// member in every SDK era (verified field offsets, all <= 216) and
	// never exceeds the union of the runtime struct.
	bool codecSwapped = false;
	int codecTarget = 0;
	GUID codecGuid{};
	GUID codecProfile{};
	static constexpr size_t kCodecWindow = 256;
	unsigned char codecWindow[kCodecWindow]{};
	uint32_t maxEncodeWidth = 0, maxEncodeHeight = 0;
	bool h264GopCaptured = false;
	uint32_t h264GopLength = 0;
	bool h264IdrCaptured = false;
	uint32_t h264IdrPeriod = 0;
	uint32_t callerIdrPeriod = 0;
	// 2026-10-15: the H.264 codec-window fields (refs/VUI/AUD/SPS-PPS/
	// slices/entropy) are group-captured before the first write:
	// a swapped call restores the codecWindow union wholesale, a direct
	// H.264 caller (no swap) relies on this copy in Restore, like idrPeriod.
	bool h264CfgCaptured = false;
	NV_ENC_CONFIG_H264 h264Cfg{};
};
const GUID* PresetGuid(int p){
	switch(p){ case 1: return &NV_ENC_PRESET_P1_GUID; case 2: return &NV_ENC_PRESET_P2_GUID; case 3: return &NV_ENC_PRESET_P3_GUID;
		case 4: return &NV_ENC_PRESET_P4_GUID; case 5: return &NV_ENC_PRESET_P5_GUID; case 6: return &NV_ENC_PRESET_P6_GUID;
		case 7: return &NV_ENC_PRESET_P7_GUID; default: return nullptr; }
}

// ---------------------------------------------------------------------------
// canonical preset config fetch, for the preset merge. cached per
// (preset, tuning, codec): reconfigures are frequent and the answer is
// deterministic. struct versions are tried in three flavours because vrlink
// may be compiled against an older API than our vendored SDK 13.1 header:
//   1. caller-matched: NVENCAPI_VERSION bits lifted from the caller's own
//      struct version (major at 0..15, minor at 24..27), inner NV_ENC_CONFIG
//      version copied verbatim from the caller's accepted config
//   2. fully vendored NV_ENC_PRESET_CONFIG_VER / NV_ENC_CONFIG_VER
//   3. caller-matched with the older preset-config struct digit (4)
// a rejected flavour costs one cheap NV_ENC_ERR_INVALID_VERSION; if all
// three fail the merge is skipped and logged, GUID-swap behaviour remains.
// ---------------------------------------------------------------------------
std::mutex presetCacheLock;
// 2026-11-03: preset canonical-config cache is bound to (encoder, session API
// version) so a recycled or cross-adapter handle cannot reuse a stale config.
struct PresetCacheEntry {
	uint32_t apiVersion = 0;
	int preset = 0;
	NV_ENC_TUNING_INFO tuning = NV_ENC_TUNING_INFO_UNDEFINED;
	GUID codec{};
	NV_ENC_PRESET_CONFIG pc{};
};
std::map<void*, std::vector<PresetCacheEntry>> presetCache;
void ForgetSessionCaches(void* encoder){
	{ std::lock_guard<std::mutex> g(capsLock); capCache.erase(encoder); }
	{ std::lock_guard<std::mutex> g(presetCacheLock); presetCache.erase(encoder); }
}
std::atomic<int> presetDiffLogged{0};
std::atomic<int> presetFetchFailLogged{0};
std::atomic<int> presetAutoLogged{0};
std::atomic<int> presetAutoH264Logged{0};

bool FetchPresetConfig(void* encoder, const NV_ENC_INITIALIZE_PARAMS* p, const NV_ENC_CONFIG* callerCfg, int preset, NV_ENC_PRESET_CONFIG* outPc){
	const GUID* pg = PresetGuid(preset);
	if(!pg || !origGetPresetConfigEx || !encoder || ApiMajor(p->version) < 10 || !outPc){ return false; }
	// The actual opened session API is part of the cache key; a reused handle
	// or a different adapter may not share the same canonical config.
	uint32_t apiVersion = 0;
	{
		std::lock_guard<std::mutex> g(upgradedLock);
		auto it = sessionApiVersion.find(encoder);
		if(it != sessionApiVersion.end()){ apiVersion = it->second; }
	}
	{
		std::lock_guard<std::mutex> g(presetCacheLock);
		auto it = presetCache.find(encoder);
		if(it != presetCache.end()){
			for(const auto& e : it->second){
				if(e.apiVersion == apiVersion && e.preset == preset && e.tuning == p->tuningInfo
						&& memcmp(&e.codec, &p->encodeGUID, sizeof(GUID)) == 0){
					*outPc = e.pc;
					return true;
				}
			}
		}
	}
	// NVENCAPI_VERSION bits of the caller: major 0..15, minor 24..27
	const uint32_t callerApi = (p->version & 0xFFFFu) | (p->version & 0x0F000000u);
	const uint32_t verFlavours[3][2] = {
		{ callerApi | (5u << 16) | (0x7u << 28) | (1u << 31), callerCfg->version },
		{ NV_ENC_PRESET_CONFIG_VER, NV_ENC_CONFIG_VER },
		{ callerApi | (4u << 16) | (0x7u << 28) | (1u << 31), callerCfg->version },
	};
	for(int f = 0; f < 3; f++){
		NV_ENC_PRESET_CONFIG pc = {};
		pc.version = verFlavours[f][0];
		pc.presetCfg.version = verFlavours[f][1];
		NVENCSTATUS st = origGetPresetConfigEx(encoder, p->encodeGUID, *pg, p->tuningInfo, &pc);
		if(st == NV_ENC_SUCCESS){
			std::lock_guard<std::mutex> g(presetCacheLock);
			PresetCacheEntry e;
			e.apiVersion = apiVersion; e.preset = preset; e.tuning = p->tuningInfo;
			e.codec = p->encodeGUID; e.pc = pc;
			auto& entries = presetCache[encoder];
			entries.push_back(std::move(e));
			{ std::lock_guard<std::mutex> s(statsLock); stats.presetFetchOk++; stats.presetCfgVerUsed = pc.version; }
			*outPc = pc;
			return true;
		}
		if(st != NV_ENC_ERR_INVALID_VERSION && f == 0){
			// non-version failure: the other flavours will not do better
			if(presetFetchFailLogged.fetch_add(1) < 3){
				DriverLog("NvencTap: nvEncGetEncodePresetConfigEx(P%d, tuning %u) failed (%u) — preset merge unavailable, GUID swap only", preset, (unsigned)p->tuningInfo, (unsigned)st);
			}
			std::lock_guard<std::mutex> s(statsLock); stats.presetFetchFail++;
			return false;
		}
	}
	if(presetFetchFailLogged.fetch_add(1) < 3){
		DriverLog("NvencTap: nvEncGetEncodePresetConfigEx(P%d) rejected all struct-version flavours (caller api bits 0x%08x, vendored 0x%08x) — preset merge unavailable", preset, callerApi, (unsigned)NV_ENC_PRESET_CONFIG_VER);
	}
	std::lock_guard<std::mutex> s(statsLock); stats.presetFetchFail++;
	return false;
}

void Describe(const char* tag, const NV_ENC_INITIALIZE_PARAMS* p, bool full){
	const NV_ENC_CONFIG* c = p->encodeConfig;
	DriverLog("NvencTap: %s api=%u v=%u %ux%u dar=%ux%u fps=%u/%u codec=%s preset=%s tuning=%u async=%u ptd=%u vidmem=%u bf=%x",
		tag, ApiMajor(p->version), StructVer(p->version), p->encodeWidth, p->encodeHeight, p->darWidth, p->darHeight,
		p->frameRateNum, p->frameRateDen, IsHevc(p->encodeGUID) ? "HEVC" : IsH264(p->encodeGUID) ? "H264" : "?",
		PresetName(p->presetGUID), (unsigned)p->tuningInfo, p->enableEncodeAsync, p->enablePTD, p->enableOutputInVidmem, (unsigned)p->bufferFormat);
	if(!c){ DriverLog("NvencTap:   encodeConfig = null (preset defaults)"); return; }
	const NV_ENC_RC_PARAMS &rc = c->rcParams;
	DriverLog("NvencTap:   cfg v=%u gop=%u intervalP=%d rc=%s avg=%.1fM max=%.1fM vbv=%.2fMbit init=%u minQP=%u/%u maxQP=%u/%u AQ=%u(%u) tAQ=%u lookahead=%u(%u) multipass=%u zeroReorder=%u nonRefP=%u",
		StructVer(c->version), c->gopLength, c->frameIntervalP, RcName(rc.rateControlMode),
		rc.averageBitRate / 1e6, rc.maxBitRate / 1e6, rc.vbvBufferSize / 1e6, rc.vbvInitialDelay,
		rc.enableMinQP, rc.minQP.qpInterP, rc.enableMaxQP, rc.maxQP.qpInterP, rc.enableAQ, rc.aqStrength,
		rc.enableTemporalAQ, rc.enableLookahead, rc.lookaheadDepth, (unsigned)rc.multiPass, rc.zeroReorderDelay, rc.enableNonRefP);
	if(IsHevc(p->encodeGUID)){
		const NV_ENC_CONFIG_HEVC &h = c->encodeCodecConfig.hevcConfig;
		const NV_ENC_CONFIG_HEVC_VUI_PARAMETERS &v = h.hevcVUIParameters;
		DriverLog("NvencTap:   hevc level=%u tier=%u cu=%u..%u chroma=%u idr=%u intraRefresh=%u/%u refDPB=%u slices=%u/%u outBitDepth=%u inBitDepth=%u repeatSPSPPS=%u",
			h.level, h.tier, (unsigned)h.minCUSize, (unsigned)h.maxCUSize, h.chromaFormatIDC, h.idrPeriod, h.enableIntraRefresh, h.intraRefreshPeriod,
			h.maxNumRefFramesInDPB, h.sliceMode, h.sliceModeData, (unsigned)h.outputBitDepth, (unsigned)h.inputBitDepth, h.repeatSPSPPS);
		// the black-floor suspects: range flag and colour signalling
		DriverLog("NvencTap:   hevc VUI present=%u fullRange=%u colourDesc=%u primaries=%u transfer=%u matrix=%u  <- fullRange=0 means LIMITED range (16..235): a full-range source is crushed at black",
			v.videoSignalTypePresentFlag, v.videoFullRangeFlag, v.colourDescriptionPresentFlag, (unsigned)v.colourPrimaries,
			(unsigned)v.transferCharacteristics, (unsigned)v.colourMatrix);
	}
	if(full){ SafeHexDump("init", p, sizeof(NV_ENC_INITIALIZE_PARAMS)); if(c){ SafeHexDump("cfg", c, 0x200); } }
}

// remaining space for the override-description builder; 0 once full so the
// following snprintf calls become no-ops instead of taking a negative size
inline size_t WhatRem(const char* w, const char* what, size_t whatLen){
	return w < what + whatLen ? (size_t)(what + whatLen - w) : 0;
}

// 2026-10-13 stream codec override: rewrite vrlink's HEVC session into
// H.264 or AV1. Applied at init and every reconfigure; the caller params
// are restored after each call (Restore), so each call re-derives from
// vrlink's own state. Only fields inside kCodecWindow are cleared and
// written; every HEVC-only override below skips itself because snap.hevc
// is cleared here. H.264 gets the 8-bit session class via the caps shim
// (NVENC rejects 10-bit H.264); AV1 follows the session input depth
// (10-bit when the SDR 10-bit baseline is on). The client "Codecs
// Support" patch decodes both.
// 2026-10-14 codec-swap fix: codec-specific fields, applied once onto the
// hand-built window and re-applied after the merge seeds that window from
// NVENC's own canonical preset config (valid by construction — the hand-built
// AV1 window produced INVALID_PARAM on a live driver; the canonical seed
// removes every hand-built-field risk).
void ApplyCodecFields(NV_ENC_CONFIG* c, NV_ENC_INITIALIZE_PARAMS* p, int targetCodec, char* &w, size_t whatLen, const char* what){
	(void)w; (void)whatLen; (void)what; // no codec-field rewrite needs a log fragment yet
	if(targetCodec == 1){
		NV_ENC_CONFIG_H264 &h = c->encodeCodecConfig.h264Config;
		h.level = NV_ENC_LEVEL_AUTOSELECT;
		h.entropyCodingMode = NV_ENC_H264_ENTROPY_CODING_MODE_CABAC;
		h.repeatSPSPPS = 1;                 // SPS/PPS with every IDR: client resync
		h.chromaFormatIDC = 1;
		// Bit depths stay DEFAULT (0) like vrlink's own params: the depth
		// follows the session's input surface class. H.264 needs the 8-bit
		// class — steered in via the SUPPORT_10BIT_ENCODE caps shim below.
	}else{
		NV_ENC_CONFIG_AV1 &a = c->encodeCodecConfig.av1Config;
		a.level = NV_ENC_LEVEL_AV1_AUTOSELECT;
		a.tier = NV_ENC_TIER_AV1_0;              // MAIN tier
		a.repeatSeqHdr = 1;                 // sequence header with every key frame
		a.chromaFormatIDC = 1;
		// ABI note (verified root cause, live 2026-10-14): the struct is
		// stamped 12.1, where the bit depths are inputPixelBitDepthMinus8:3 /
		// pixelBitDepthMinus8:3 INSIDE the flags word at +16, while the SDK 13
		// tail enums (offsets 112/116) land on 12.1's reserved1[0..1] ("must
		// be set to 0"). Writing the tail enums corrupts reserved words
		// (INVALID_PARAM) and leaves the real bits reading 8-bit. Write the
		// 12.1 bits directly: bits 12..14 = input, 15..17 = output, 0 = 8-bit,
		// 2 = 10-bit (n12.1.14.0.h; nvEncodeAPI.h:2133-2136).
		uint32_t* av1Flags = (uint32_t*)((unsigned char*)&a + 16);
		switch(p->bufferFormat){
			case NV_ENC_BUFFER_FORMAT_YUV420_10BIT:
			case NV_ENC_BUFFER_FORMAT_YUV444_10BIT:
			case NV_ENC_BUFFER_FORMAT_ARGB10:
			case NV_ENC_BUFFER_FORMAT_ABGR10:
			case NV_ENC_BUFFER_FORMAT_P210:
				if(ApiMajor(p->version) >= 13){ a.inputBitDepth = NV_ENC_BIT_DEPTH_10; a.outputBitDepth = NV_ENC_BIT_DEPTH_10; }
				else{ *av1Flags = (*av1Flags & ~(0x3Fu << 12)) | (2u << 12) | (2u << 15); }
				break;
			case NV_ENC_BUFFER_FORMAT_NV12:
			case NV_ENC_BUFFER_FORMAT_YV12:
			case NV_ENC_BUFFER_FORMAT_IYUV:
			case NV_ENC_BUFFER_FORMAT_YUV444:
			case NV_ENC_BUFFER_FORMAT_ARGB:
			case NV_ENC_BUFFER_FORMAT_AYUV:
			case NV_ENC_BUFFER_FORMAT_ABGR:
			case NV_ENC_BUFFER_FORMAT_NV16:
				if(ApiMajor(p->version) >= 13){ a.inputBitDepth = NV_ENC_BIT_DEPTH_8; a.outputBitDepth = NV_ENC_BIT_DEPTH_8; }
				else{ *av1Flags &= ~(0x3Fu << 12); } // 8-bit == minus8 = 0
				break;
			default:
				break;
		}
		// 2026-11-13: the caller's tuningInfo is preserved for AV1 too. The
		// old unconditional ULL->LL rewrite silently retuned vrlink's request;
		// if NVENC does not support the requested tuning for AV1 the init fails
		// visibly with its status instead of being downgraded here.
	}
}

bool ApplyCodecOverride(void* encoder, NV_ENC_INITIALIZE_PARAMS* p, const NvencTapConfig &cfg, Snapshot &snap, char* &w, size_t whatLen, const char* what){
	if(cfg.codec <= 0 || !p->encodeConfig){ return false; }
	const GUID* codec = nullptr; const GUID* profile = nullptr; const char* name = nullptr;
	if(cfg.codec == 1){ codec = &NV_ENC_CODEC_H264_GUID; profile = &NV_ENC_H264_PROFILE_HIGH_GUID; name = "H264"; }
	else if(cfg.codec == 2){ codec = &NV_ENC_CODEC_AV1_GUID; profile = &NV_ENC_AV1_PROFILE_MAIN_GUID; name = "AV1"; }
	else { return false; }
	if(cfg.codec == 2 && ApiMajor(p->version) < 12){
		// AV1 exists only from NVENC API 12.0 on; this session never got the
		// 12.1 upgrade (split mode off), so its union has no AV1 member.
		// Guarded rejects this request before ApplyOverrides. Keep the helper
		// non-mutating for direct fixture callers using an old API.
		return false;
	}
	if(memcmp(&p->encodeGUID, codec, sizeof(GUID)) == 0){ // already the target
		// Caller geometry is authoritative; NVENC validates its actual limits.
		return false;
	}
	if(!IsHevc(p->encodeGUID)){
		// only vrlink's HEVC sessions are rewritten; anything else is left alone
		return false;
	}
	NV_ENC_CONFIG* c = p->encodeConfig;
	// save everything the rewrite touches, for the post-call restore
	snap.codecSwapped = true;
	snap.codecTarget = cfg.codec;
	snap.codecGuid = p->encodeGUID;
	snap.codecProfile = c->profileGUID;
	memcpy(snap.codecWindow, &c->encodeCodecConfig, sizeof(snap.codecWindow));
	p->encodeGUID = *codec;
	c->profileGUID = *profile;
	memset(&c->encodeCodecConfig, 0, sizeof(snap.codecWindow));
	ApplyCodecFields(c, p, cfg.codec, w, whatLen, what);
	snap.hevc = false; // every HEVC-only override below must skip itself
	w += snprintf(w, WhatRem(w, what, whatLen), "codec HEVC->%s; ", name);
	return true;
}

// returns true if anything was changed
bool ApplyOverrides(void* encoder, NV_ENC_INITIALIZE_PARAMS* p, const NvencTapConfig &cfg, Snapshot &snap, char* what, size_t whatLen, bool initializing){
	snap = Snapshot{};
	what[0] = 0;
	NV_ENC_CONFIG* c = p->encodeConfig;
	if(!c){ return false; }
	if(!ApiSupported(ApiMajor(p->version)) || !ApiSupported(ApiMajor(c->version))){ return false; }
	snap.valid = true; snap.initPtr = p; snap.cfgPtr = c; snap.rc = c->rcParams; snap.preset = p->presetGUID; snap.hevc = IsHevc(p->encodeGUID);
	snap.fpsNum = p->frameRateNum; snap.fpsDen = p->frameRateDen;
	snap.maxEncodeWidth = p->maxEncodeWidth; snap.maxEncodeHeight = p->maxEncodeHeight;
	// the bitfield word right after enablePTD (reportSliceOffsets.. in
	// every SDK; splitEncodeMode occupies bits 5..8 from 12.1 on)
	uint32_t* initFlags = (uint32_t*)&p->enablePTD + 1;
	snap.initVer = p->version; snap.cfgVer = c->version; snap.rcVer = c->rcParams.version; snap.initFlags = *initFlags;
	snap.tuning = (uint32_t)p->tuningInfo;
	snap.codecGuid = p->encodeGUID; snap.codecProfile = c->profileGUID;
	memcpy(snap.codecWindow, &c->encodeCodecConfig, sizeof(snap.codecWindow));
	snap.h264GopLength = c->gopLength;
	snap.callerIdrPeriod = IsHevc(p->encodeGUID) ? c->encodeCodecConfig.hevcConfig.idrPeriod
		: IsH264(p->encodeGUID) ? c->encodeCodecConfig.h264Config.idrPeriod : 0;
	if(snap.hevc){
		snap.hevcLevel = c->encodeCodecConfig.hevcConfig.level; snap.hevcTier = c->encodeCodecConfig.hevcConfig.tier;
		snap.hevcRefs = c->encodeCodecConfig.hevcConfig.maxNumRefFramesInDPB;
		snap.hevcVui = c->encodeCodecConfig.hevcConfig.hevcVUIParameters;
	}
	// colour-depth fix B (2026-10-17): a stock HEVC session (tap codec 0 —
	// no codec override ran) that carries vrlink's 10-bit surface class is
	// otherwise encoded Main-8 in the P010 container (bit depths DEFAULT).
	// Live sessions are stamped SDK 12.1, whose fields do not compile-map
	// to the vendored 13.1 header, so the depth is written by raw offset
	// inside the guarded window: the capture above already saved the
	// 256-byte codec union and this session's profileGUID, and Restore
	// returns Valve's original bytes after every NVENC call.
	// 12.1 _NV_ENC_CONFIG_HEVC (SteamFrame-Advanced-Options/Native/vendor/
	// nvEncodeAPI12.h 1770-1846): level +0, tier +4, min/maxCUSize +8/+12,
	// packed uint32 flags word +16 (idrPeriod follows at +20): bits 0-8
	// single-bit fields, bits 9-10 chromaFormatIDC, bits 11-13
	// pixelBitDepthMinus8 (:3; 0=8-bit, 2=10-bit — header line 1792), bits
	// 20-31 reserved; the window has NO depth/profile member — the profile
	// GUID lives on the OUTER NV_ENC_CONFIG.profileGUID.
	if(cfg.codec == 0 && IsHevc(p->encodeGUID) && p->bufferFormat == NV_ENC_BUFFER_FORMAT_YUV420_10BIT){
		// era split like the AV1 branch: a >=13-stamped session carries the
		// depths as typed 13.1 members (compile-visible here); 12.1 and
		// older carry the packed bitfield, written by raw offset.
		if(ApiMajor(p->version) >= 13){
			// 13.1 header (ThirdParty/nvenc/nvEncodeAPI.h 2023/2026):
			// outputBitDepth/inputBitDepth are NV_ENC_BIT_DEPTH members.
			c->encodeCodecConfig.hevcConfig.inputBitDepth = NV_ENC_BIT_DEPTH_10;
			c->encodeCodecConfig.hevcConfig.outputBitDepth = NV_ENC_BIT_DEPTH_10;
		}else{
			// 12.1 session: packed flags word at +16 — clear bits 11-13,
			// set them to 2 (pixelBitDepthMinus8 = 10-bit); every other
			// bit, chromaFormatIDC bits 9-10 included, stays Valve's value
			uint32_t* hevcFlags = (uint32_t*)((unsigned char*)&c->encodeCodecConfig.hevcConfig + 16);
			*hevcFlags = (*hevcFlags & ~(0x7u << 11)) | (0x2u << 11);
		}
		if(memcmp(&c->profileGUID, &NV_ENC_HEVC_PROFILE_MAIN10_GUID, sizeof(GUID)) != 0){ c->profileGUID = NV_ENC_HEVC_PROFILE_MAIN10_GUID; }
		// one-shot visibility: the 10-bit surface class is the whole gate —
		// never a settings read, never a user-setting rewrite
		static std::atomic<int> hevcSdr10Logged{0};
		if(hevcSdr10Logged.fetch_add(1) < 1){
			DriverLog("NvencTap: HEVC session carries a 10-bit surface; writing Main10 bit depth (pixelBitDepthMinus8 2) and Main10 profile for the SDR10 request.");
		}
	}
	bool changed = false;
	char* w = what;
	if(ApplyCodecOverride(encoder, p, cfg, snap, w, whatLen, what)){ changed = true; }
	int presetWanted = cfg.preset;
	if(presetWanted == 0 && cfg.presetAuto){
		if(cfg.codec == 1){
			// H.264: canonical low-latency profile is P2 (P7's multipass raise wedged the ULL session)
			presetWanted = 2;
			if(presetAutoH264Logged.fetch_add(1) < 1){
				DriverLog("NvencTap: preset AUTO (H264) -> P2 (low-latency H.264 profile)");
			}
		}else{
			uint32_t engines; { std::lock_guard<std::mutex> g(statsLock); engines = stats.numEncoderEngines; }
			presetWanted = engines >= 3 ? 7 : engines == 2 ? 5 : engines == 1 ? 4 : 0;
			if(presetAutoLogged.fetch_add(1) < 1){
				DriverLog("NvencTap: preset AUTO -> %s (%u NVENC engine%s)", presetWanted ? (presetWanted == 7 ? "P7" : presetWanted == 5 ? "P5" : "P4") : "leave vrlink's", engines, engines == 1 ? "" : "s");
			}
		}
	}
	// Construct the target codec independently of the optional preset merge.
	// Disabling merge must not leave a swapped HEVC union as an AV1 recipe.
	int seedPreset = presetWanted;
	if(!PresetGuid(seedPreset)){
		for(int n = 1; n <= 7; ++n){ if(memcmp(&p->presetGUID, PresetGuid(n), sizeof(GUID)) == 0){ seedPreset = n; break; } }
	}
	// Caller-owned copy: the cache vector may reallocate/erase after unlock.
	NV_ENC_PRESET_CONFIG canonicalStorage{};
	const NV_ENC_PRESET_CONFIG* canonical = ((snap.codecSwapped || cfg.presetMerge)
		&& FetchPresetConfig(encoder, p, c, seedPreset, &canonicalStorage)) ? &canonicalStorage : nullptr;
	if(snap.codecSwapped && canonical){
		memcpy(&c->encodeCodecConfig, &canonical->presetCfg.encodeCodecConfig, Snapshot::kCodecWindow);
		ApplyCodecFields(c, p, snap.codecTarget, w, whatLen, what);
		w += snprintf(w, WhatRem(w, what, whatLen), "seeded P%d@tuning%u; ", seedPreset, (unsigned)p->tuningInfo);
		changed = true;
	}
	if(const GUID* pg = PresetGuid(presetWanted)){
		if(memcmp(&p->presetGUID, pg, sizeof(GUID)) != 0){
			w += snprintf(w, WhatRem(w, what, whatLen), "preset %s->P%d; ", PresetName(p->presetGUID), presetWanted);
			p->presetGUID = *pg; changed = true;
		}
		// GUID swap alone only moves NVENC's hardware-internal effort knobs
		// (per the header docs an explicit encodeConfig is never overridden
		// by presetGUID). the merge adopts the visible whitelist from the
		// canonical preset config for vrlink's own tuning. deterministic:
		// init and every reconfigure derive the same values, so the running
		// encoder state and reconfigure params never disagree.
		if(cfg.presetMerge){
			if(const NV_ENC_PRESET_CONFIG* pcp = canonical){
				const NV_ENC_CONFIG &pcc = pcp->presetCfg;
				const NV_ENC_RC_PARAMS &prc = pcc.rcParams;
				NV_ENC_RC_PARAMS &rc = c->rcParams;
				if(presetDiffLogged.fetch_add(1) < 1){
					DriverLog("NvencTap: canonical P%d@tuning%u vs vrlink: rc=%s/%s multipass=%u/%u AQ=%u(%u)/%u(%u) tAQ=%u/%u lookahead=%u(%u)/%u(%u) intervalP=%d/%d nonRefP=%u/%u zeroReorder=%u/%u refDPB=%u/%u  (preset/vrlink; whitelist merged: multipass, tAQ, AQ-if-unset, refDPB)",
						presetWanted, (unsigned)p->tuningInfo, RcName(prc.rateControlMode), RcName(rc.rateControlMode),
						(unsigned)prc.multiPass, (unsigned)rc.multiPass, prc.enableAQ, prc.aqStrength, rc.enableAQ, rc.aqStrength,
						prc.enableTemporalAQ, rc.enableTemporalAQ, prc.enableLookahead, prc.lookaheadDepth, rc.enableLookahead, rc.lookaheadDepth,
						pcc.frameIntervalP, c->frameIntervalP, prc.enableNonRefP, rc.enableNonRefP, prc.zeroReorderDelay, rc.zeroReorderDelay,
						snap.hevc ? pcc.encodeCodecConfig.hevcConfig.maxNumRefFramesInDPB : 0, snap.hevc ? c->encodeCodecConfig.hevcConfig.maxNumRefFramesInDPB : 0);
					if(prc.enableLookahead && prc.lookaheadDepth){
						DriverLog("NvencTap: canonical P%d wants lookahead depth %u — NOT adopted (adds %u frames of latency)", presetWanted, prc.lookaheadDepth, prc.lookaheadDepth);
					}
				}
				if(cfg.multiPass < 0 && cfg.codec == 1){
					// 2026-10-15: H.264 runs pinned to multiPass=0 (single-pass). The canonical P2/P7@ULL reports 1, which wedged the first encode on 2026-10-15; SteamFrame's verified H.264 profile is single-pass as well.
					if(rc.multiPass != 0){ w += snprintf(w, WhatRem(w, what, whatLen), "multipass %u->0 [h264]; ", (unsigned)rc.multiPass); rc.multiPass = (NV_ENC_MULTI_PASS)0; changed = true; }
				}else if(cfg.multiPass < 0 && CodecOfGuid(p->encodeGUID) != 2 && rc.multiPass != prc.multiPass){
					// 2026-11-13: AV1 keeps the caller's multiPass when the user
					// left the setting automatic (vrlink's own AV1 tuning); the
					// canonical preset no longer overrides it. Explicit 0/1/2
					// still wins in the [explicit] block below.
					w += snprintf(w, WhatRem(w, what, whatLen), "multipass %u->%u; ", (unsigned)rc.multiPass, (unsigned)prc.multiPass);
					rc.multiPass = prc.multiPass; changed = true;
				}
				if(rc.enableTemporalAQ != prc.enableTemporalAQ){
					w += snprintf(w, WhatRem(w, what, whatLen), "tAQ %u->%u; ", rc.enableTemporalAQ, prc.enableTemporalAQ);
					rc.enableTemporalAQ = prc.enableTemporalAQ; changed = true;
				}
				// spatial AQ from the preset only when nothing else (manual
				// field or tier) claims it; the explicit AQ block below wins
				if(cfg.aqStrength <= 0 && (rc.enableAQ != prc.enableAQ || rc.aqStrength != prc.aqStrength)){
					w += snprintf(w, WhatRem(w, what, whatLen), "AQ %u(%u)->%u(%u) [preset]; ", rc.enableAQ, rc.aqStrength, prc.enableAQ, prc.aqStrength);
					rc.enableAQ = prc.enableAQ; rc.aqStrength = prc.aqStrength; changed = true;
				}
				if(snap.hevc){
					uint32_t prefs = pcc.encodeCodecConfig.hevcConfig.maxNumRefFramesInDPB;
					NV_ENC_CONFIG_HEVC &h = c->encodeCodecConfig.hevcConfig;
					if(prefs && h.maxNumRefFramesInDPB != prefs){
						w += snprintf(w, WhatRem(w, what, whatLen), "refDPB %u->%u; ", h.maxNumRefFramesInDPB, prefs);
						h.maxNumRefFramesInDPB = prefs; changed = true;
					}
				}
			}else{
				// 2026-10-16 (owner directive): a preset-merge fetch failure keeps
				// the user's selected codec — GUID swap only, one-shot log, never
				// a refusal and never another codec.
				static std::atomic<int> presetMergeUnavailableLogged{0};
				if(presetMergeUnavailableLogged.fetch_add(1) < 1){
					DriverLog("NvencTap: optional preset merge unavailable (streamFrame.nvencPresetMerge fetch failed); preserving selected codec and continuing all explicit settings");
				}
				// Continue: explicit bitrate, VBV, CBR, split and recipe settings
				// below remain authoritative even if optional merging fails.
			}
		}
	}
	if(IsH264(p->encodeGUID) && origGetEncodeCaps){
		// The legacy caller's HEVC allocation envelope can exceed H.264's
		// real reservation limits. Only internal reservations are adapted;
		// active dimensions and the user's requested tile are never lowered.
		for(int axis = 0; axis < 2; ++axis){
			NV_ENC_CAPS_PARAM cp{};
			cp.version = (p->version & 0x0F00FFFFu) | (1u << 16) | (0x7u << 28);
			cp.capsToQuery = axis ? NV_ENC_CAPS_HEIGHT_MAX : NV_ENC_CAPS_WIDTH_MAX;
			int cap = 0;
			if(origGetEncodeCaps(encoder, p->encodeGUID, &cp, &cap) != NV_ENC_SUCCESS || cap <= 0){ continue; }
			const uint32_t active = axis ? p->encodeHeight : p->encodeWidth;
			uint32_t& maximum = axis ? p->maxEncodeHeight : p->maxEncodeWidth;
			if(active > (uint32_t)cap){
				snap.error = std::string("Requested H.264 active ") + (axis ? "height " : "width ") + std::to_string(active)
					+ " exceeds the selected codec's hardware limit " + std::to_string(cap) + "; the requested tile was not lowered.";
				return changed;
			}
			if(maximum > (uint32_t)cap){
				static std::atomic<int> reservationLogged[2];
				if(reservationLogged[axis].fetch_add(1) < 3){ DriverLog("NvencTap: H.264 internal maximum %s reservation %u -> %d (active %u, requested tile %d unchanged)", axis ? "height" : "width", maximum, cap, active, cfg.effectiveTileWidth); }
				maximum = (uint32_t)cap; changed = true;
			}
		}
	}
	if(IsHevc(p->encodeGUID) || IsH264(p->encodeGUID)){
		NV_ENC_CONFIG_HEVC_VUI_PARAMETERS &v = IsH264(p->encodeGUID)
			? c->encodeCodecConfig.h264Config.h264VUIParameters : c->encodeCodecConfig.hevcConfig.hevcVUIParameters;
		const int range = cfg.vuiFullRange >= 0 ? cfg.vuiFullRange : cfg.postPackEnabled ? (cfg.postPackLimitedRange ? 0 : 1) : -1;
		if(range >= 0 && (v.videoFullRangeFlag != (uint32_t)range || !v.videoSignalTypePresentFlag)){
			w += snprintf(w, WhatRem(w, what, whatLen), "vuiFullRange %u->%d; ", v.videoFullRangeFlag, range);
			v.videoFullRangeFlag = (uint32_t)range; v.videoSignalTypePresentFlag = 1; changed = true;
		}
		if(cfg.vuiMatrix >= 0 && (uint32_t)v.colourMatrix != (uint32_t)cfg.vuiMatrix){
			w += snprintf(w, WhatRem(w, what, whatLen), "vuiMatrix %u->%d; ", (uint32_t)v.colourMatrix, cfg.vuiMatrix);
			v.colourMatrix = (NV_ENC_VUI_MATRIX_COEFFS)cfg.vuiMatrix;
			v.colourDescriptionPresentFlag = 1; v.videoSignalTypePresentFlag = 1; changed = true;
		}
		if(cfg.vuiPrimaries >= 0 && (uint32_t)v.colourPrimaries != (uint32_t)cfg.vuiPrimaries){
			w += snprintf(w, WhatRem(w, what, whatLen), "vuiPrimaries %u->%d; ", (uint32_t)v.colourPrimaries, cfg.vuiPrimaries);
			v.colourPrimaries = (NV_ENC_VUI_COLOR_PRIMARIES)cfg.vuiPrimaries;
			v.colourDescriptionPresentFlag = 1; v.videoSignalTypePresentFlag = 1; changed = true;
		}
		if(cfg.vuiTransfer >= 0 && (uint32_t)v.transferCharacteristics != (uint32_t)cfg.vuiTransfer){
			w += snprintf(w, WhatRem(w, what, whatLen), "vuiTransfer %u->%d; ", (uint32_t)v.transferCharacteristics, cfg.vuiTransfer);
			v.transferCharacteristics = (NV_ENC_VUI_TRANSFER_CHARACTERISTIC)cfg.vuiTransfer;
			v.colourDescriptionPresentFlag = 1; v.videoSignalTypePresentFlag = 1; changed = true;
		}
		if((cfg.vuiMatrix >= 0 || cfg.vuiPrimaries >= 0 || cfg.vuiTransfer >= 0)
			&& (!v.colourDescriptionPresentFlag || !v.videoSignalTypePresentFlag)){
			v.colourDescriptionPresentFlag = 1; v.videoSignalTypePresentFlag = 1; changed = true;
		}
	}
	if(cfg.fixLevel && snap.hevc){
		NV_ENC_CONFIG_HEVC &h = c->encodeCodecConfig.hevcConfig;
		if(h.level != NV_ENC_LEVEL_AUTOSELECT || h.tier != NV_ENC_TIER_HEVC_HIGH){
			w += snprintf(w, WhatRem(w, what, whatLen), "level %u->auto tier %u->high; ", h.level, h.tier);
			h.level = NV_ENC_LEVEL_AUTOSELECT; h.tier = NV_ENC_TIER_HEVC_HIGH; changed = true;
		}
	}
	// 2026-10-13 history (superseded by the 2026-10-18 deferral below): the
	// forced split bits were made to survive a codec swap because swapped
	// sessions were silently dropping them; that era wrote the bits at init
	// on every non-H.264 session. 2026-10-18 live evidence reversed the
	// init-time half: the init AUs themselves carry the frame-header +
	// tile-group OBU shape the client's decoder-swap layer rejects (zero
	// ACKs, watchdog reset storm), so the bits now ride reconfigure only.
	// H.264 is excluded (splitEncodeMode is not applicable to H264): codec==1 skips this branch.
	// 2026-10-18 fresh-connect deferral: the bits ride reconfiguration only.
	// Live evidence (vrserver/driver_vrlink, 2026-10-18): a session whose
	// FIRST nvEncInitializeEncoder already carries split bits produces a
	// first keyframe the Steam Link client never acknowledges —
	// m_iLastAcknowledgeFrameNumber stays 0, Cause-Mask-000100 watchdog
	// resets every ~330 ms, HandleUnrecoverableError storms, client
	// shutdown (three connections on 2026-10-18, split 1 and 3, AV1). The
	// byte-identical session shape WITHOUT init-time split bits streamed
	// healthy (ACKs confirmed mid-session), and split engaged through
	// reconfigure in the owner-verified live-change flow. So at init the
	// split bits are deferred, never dropped: vrlink's first reconfigure
	// (ms later) applies them, effectiveSplit mirrors the written request in
	// info.json (NVENC may ignore AUTO_FORCED on 1-engine GPUs), and the saved
	// nvencSplitMode is untouched throughout.
	// 2026-10-19 (owner directive): the deferral below is AV1-ONLY. AV1 is the
	// codec whose Steam Link decoder wedges on a split first frame; HEVC
	// applies split immediately at init and reconfigure (its pre-2026-10-18
	// behaviour) and H.264 never applies it at all. The window is armed at
	// init, at session open and again on a resumed stream
	// (ReconfigureEncoder), so a reconnect that reuses the live session —
	// vrlink keeps it for ~30 s after the client drops — is covered too.
	if(cfg.splitMode > 0 && !IsH264(p->encodeGUID)){
		uint32_t mode = (uint32_t)cfg.splitMode;
		const bool deferralCodec = CodecOfGuid(p->encodeGUID) == 2 || cfg.codec == 2;
		if(ApiMajor(p->version) == 11){
			// not upgraded: the session was opened before the tap hooked
			// it, or the 12.1 open was rejected. U0 proved in-place struct
			// bumps are refused (INVALID_VERSION), so nothing to try here.
			if(sessionNoteLogged.fetch_add(1) < 1){
				DriverLog("NvencTap: split-frame: session is 11.1 (not upgraded) — splitEncodeMode unavailable on this encoder");
			}
		}else if(deferralCodec && (initializing || !SplitHandshakeCleared())){
			// AV1 deferral, three layers: the bits never ride
			// nvEncInitializeEncoder (fresh-connect zero-ACK death), they
			// also stay off every reconfigure until the handshake window
			// clears, and the window re-arms on a resumed stream so a
			// reconnect that reuses the live session defers as well (see the
			// reconnect arm in ReconfigureEncoder). After the window split
			// engages at the next reconfigure exactly like the owner-verified
			// mid-stream mode change. Once the client's decoder wedges on a
			// split first frame, switching the value does not recover the
			// session; a reconnect does.
			w += snprintf(w, WhatRem(w, what, whatLen), "split deferred; ");
			if(splitInitDeferLogged.fetch_add(1) < 1){
				DriverLog("NvencTap: split-frame: deferring AV1 splitEncodeMode — the client ACKs zero frames when the first decoded frame is split (and never recovers mid-session), so the bits wait for the handshake window (init, open or resumed stream, +%.0f s) and engage at the next reconfigure. Saved streamFrame.nvencSplitMode is unchanged.", splitHandshakeGraceSeconds);
			}
		}else if(ApiMajor(p->version) >= 12 && StructVer(p->version) >= 6 && p->splitEncodeMode != mode){
			// native field (a future vrlink built against 12.1+)
			w += snprintf(w, WhatRem(w, what, whatLen), "SPLIT %u->%u; ", p->splitEncodeMode, mode);
			*initFlags = (snap.initFlags & ~(0xFu << 5)) | (mode << 5);
			snap.split = true; snap.splitModeApplied = mode; changed = true;
		}
	}else if(cfg.splitMode > 0 && IsH264(p->encodeGUID)){
		if(h264SplitSkipLogged.fetch_add(1) < 1){
			DriverLog("NvencTap: split not applicable to H.264; saved preference retained and effectiveSplit=-1");
		}
	}
	if(cfg.codec == 1){
		// H.264 GOP/IDR (SteamFrame-verified recipe): vrlink passes 0xFFFFFFFF (infinite) for both; use the frame rate.
		NV_ENC_CONFIG_H264 &h = c->encodeCodecConfig.h264Config;
		// codec-window group capture before the first write: a swapped call
		// restores the 256-byte window wholesale; a direct H.264 caller
		// (no swap) relies on this copy in Restore (h264CfgCaptured)
		if(!snap.h264CfgCaptured){ snap.h264CfgCaptured = true; snap.h264Cfg = h; }
		// effective rate: forceFps when set (vrlink's measured-rate
		// reconfigures otherwise drift gop/idr per reconf - SteamFrame
		// normalizes first), else the caller's rate.
		const uint32_t fps = cfg.forceFps > 0 ? (uint32_t)cfg.forceFps : p->frameRateDen ? (uint32_t)std::floor((double)p->frameRateNum / p->frameRateDen + 0.5) : 0;
		const uint32_t gop = cfg.h264GopFrames == 0 ? fps : (uint32_t)cfg.h264GopFrames;
		const uint32_t idr = cfg.h264IdrFrames < 0 ? snap.callerIdrPeriod : cfg.h264IdrFrames == 0 ? fps : (uint32_t)cfg.h264IdrFrames;
		if(cfg.h264GopFrames >= 0 && c->gopLength != gop){ snap.h264GopCaptured = true; snap.h264GopLength = c->gopLength; w += snprintf(w, WhatRem(w, what, whatLen), "gop %u->%u [h264]; ", c->gopLength, gop); c->gopLength = gop; changed = true; }
		if(h.idrPeriod != idr){ snap.h264IdrCaptured = true; snap.h264IdrPeriod = c->encodeCodecConfig.h264Config.idrPeriod; w += snprintf(w, WhatRem(w, what, whatLen), "idr %u->%u [h264]; ", h.idrPeriod, idr); h.idrPeriod = idr; changed = true; }
		// the rest of the SteamFrame H.264 recipe: DPB refs, VUI bitstream
		// restriction (client buffer allocation), AUD + SPS/PPS every IDR
		// (client resync), numSlices-in-picture, entropy by session rate
		// (CAVLC above ~200 Mbit), no filler, no VBV initial delay.
		if(h.maxNumRefFrames != (uint32_t)cfg.h264RefFrames){ w += snprintf(w, WhatRem(w, what, whatLen), "maxNumRefFrames %u->%d [h264]; ", h.maxNumRefFrames, cfg.h264RefFrames); h.maxNumRefFrames = (uint32_t)cfg.h264RefFrames; changed = true; }
		if(h.h264VUIParameters.bitstreamRestrictionFlag != (uint32_t)cfg.h264BitstreamRestriction){ w += snprintf(w, WhatRem(w, what, whatLen), "h264BitstreamRestriction %u->%u; ", h.h264VUIParameters.bitstreamRestrictionFlag, (unsigned)cfg.h264BitstreamRestriction); h.h264VUIParameters.bitstreamRestrictionFlag = cfg.h264BitstreamRestriction ? 1u : 0u; changed = true; }
		if(h.outputAUD != (uint32_t)cfg.h264Aud){ w += snprintf(w, WhatRem(w, what, whatLen), "h264Aud %u->%u; ", h.outputAUD, (unsigned)cfg.h264Aud); h.outputAUD = cfg.h264Aud ? 1u : 0u; changed = true; }
		if(h.repeatSPSPPS != (uint32_t)cfg.h264RepeatHeaders){ w += snprintf(w, WhatRem(w, what, whatLen), "h264RepeatHeaders %u->%u; ", h.repeatSPSPPS, (unsigned)cfg.h264RepeatHeaders); h.repeatSPSPPS = cfg.h264RepeatHeaders ? 1u : 0u; changed = true; }
		if(h.disableSPSPPS != (uint32_t)cfg.h264DisableHeaders){ w += snprintf(w, WhatRem(w, what, whatLen), "h264DisableHeaders %u->%u; ", h.disableSPSPPS, (unsigned)cfg.h264DisableHeaders); h.disableSPSPPS = cfg.h264DisableHeaders ? 1u : 0u; changed = true; }
		if(h.sliceMode != (uint32_t)cfg.h264SliceMode){ w += snprintf(w, WhatRem(w, what, whatLen), "sliceMode %u->%d [h264]; ", h.sliceMode, cfg.h264SliceMode); h.sliceMode = (uint32_t)cfg.h264SliceMode; changed = true; }
		if(h.sliceModeData != (uint32_t)cfg.h264SliceData){ w += snprintf(w, WhatRem(w, what, whatLen), "sliceModeData %u->%d [h264]; ", h.sliceModeData, cfg.h264SliceData); h.sliceModeData = (uint32_t)cfg.h264SliceData; changed = true; }
		// entropy by session rate: deterministic from the configured target
		// (cfg.bitrateMbit), not the caller's pre-override rc value — the
		// avg-bitrate override below would otherwise leave init at CABAC and
		// only a later reconfigure at CAVLC.
		const uint32_t rateMbit = cfg.bitrateMbit > 0 ? (uint32_t)cfg.bitrateMbit : (uint32_t)(c->rcParams.averageBitRate / 1000000u);
		const NV_ENC_H264_ENTROPY_CODING_MODE ent = (cfg.h264Entropy == 2 || (cfg.h264Entropy == 0 && rateMbit > 200u)) ? NV_ENC_H264_ENTROPY_CODING_MODE_CAVLC : NV_ENC_H264_ENTROPY_CODING_MODE_CABAC;
		if(h.entropyCodingMode != ent){ w += snprintf(w, WhatRem(w, what, whatLen), "entropy %u->%u [h264]; ", (uint32_t)h.entropyCodingMode, (uint32_t)ent); h.entropyCodingMode = ent; changed = true; }
		// the recipe-internal filler pin, restored from the pre-0cf0cf7
		// commit (its codec 1 recipe kept the bit at 0; kept here so H.264
		// output stays byte-identical to that era): a caller-carried bit is
		// pinned back to 0.
		if(h.enableFillerDataInsertion != 0){ w += snprintf(w, WhatRem(w, what, whatLen), "filler %u->0 [h264]; ", h.enableFillerDataInsertion); h.enableFillerDataInsertion = 0; changed = true; }
		if(c->rcParams.vbvInitialDelay != (uint32_t)cfg.h264VbvInitialDelay){ w += snprintf(w, WhatRem(w, what, whatLen), "vbvInitDelay %u->%d [h264]; ", c->rcParams.vbvInitialDelay, cfg.h264VbvInitialDelay); c->rcParams.vbvInitialDelay = (uint32_t)cfg.h264VbvInitialDelay; changed = true; }
	}
	if(cfg.multiPass >= 0 && c->rcParams.multiPass != (NV_ENC_MULTI_PASS)cfg.multiPass){
		w += snprintf(w, WhatRem(w, what, whatLen), "multipass %u->%d [explicit]; ", (unsigned)c->rcParams.multiPass, cfg.multiPass);
		c->rcParams.multiPass = (NV_ENC_MULTI_PASS)cfg.multiPass; changed = true;
	}
	if(CodecOfGuid(p->encodeGUID) == 2){
		auto& a = c->encodeCodecConfig.av1Config;
		const int range = cfg.vuiFullRange >= 0 ? cfg.vuiFullRange : cfg.postPackEnabled ? (cfg.postPackLimitedRange ? 0 : 1) : -1;
		if(range >= 0 && a.colorRange != (uint32_t)range){ a.colorRange = range; changed = true; }
		if(cfg.vuiMatrix >= 0 && a.matrixCoefficients != (NV_ENC_VUI_MATRIX_COEFFS)cfg.vuiMatrix){ a.matrixCoefficients = (NV_ENC_VUI_MATRIX_COEFFS)cfg.vuiMatrix; changed = true; }
		if(cfg.vuiPrimaries >= 0 && a.colorPrimaries != (NV_ENC_VUI_COLOR_PRIMARIES)cfg.vuiPrimaries){ a.colorPrimaries = (NV_ENC_VUI_COLOR_PRIMARIES)cfg.vuiPrimaries; changed = true; }
		if(cfg.vuiTransfer >= 0 && a.transferCharacteristics != (NV_ENC_VUI_TRANSFER_CHARACTERISTIC)cfg.vuiTransfer){ a.transferCharacteristics = (NV_ENC_VUI_TRANSFER_CHARACTERISTIC)cfg.vuiTransfer; changed = true; }
	}
	if(cfg.forceFps > 0 && (p->frameRateNum != (uint32_t)cfg.forceFps || p->frameRateDen != 1)){
		w += snprintf(w, WhatRem(w, what, whatLen), "fps %u/%u->%d/1; ", p->frameRateNum, p->frameRateDen, cfg.forceFps);
		p->frameRateNum = (uint32_t)cfg.forceFps; p->frameRateDen = 1; changed = true;
	}
	if(cfg.bitrateMbit > 0){
		NV_ENC_RC_PARAMS &rc = c->rcParams;
		// 2026-10-27 (owner directive): Max Bitrate is the applied budget.
		// Under VBR the requested average is the curve-shaped streamer request
		// capped by the budget (and by the headroom reservation), and
		// maxBitRate is exactly the budget. Under Force CBR the budget is the
		// constant average and peak: the curve, constancy and headroom cannot
		// reshape it, and a lower streamer request cannot lower it.
		// 2026-11-13: restored the v2.1.1 CBR pin after the intermediate change
		// that shaped CBR with the VBR request/curve.
		const int64_t ceiling = (int64_t)cfg.bitrateMbit * 1000000ll;
		const int requestReferenceMbit = cfg.bitrateRequestReferenceMbit > 0
			? (std::min)(cfg.bitrateMbit, cfg.bitrateRequestReferenceMbit) : cfg.bitrateMbit;
		int64_t target = ceiling;
		if(cfg.forceCbr){
			target = ceiling;
			static std::atomic<bool> cbrPolicyLogged{false};
			if((cfg.bitrateCurve != 0 || cfg.bitrateConstancyPct != 0 || cfg.maxBitrateHeadroomPct != 0)
				&& !cbrPolicyLogged.exchange(true)){
				DriverLog("NvencTap: Force CBR applies streamFrame.nvencBitrateMbit directly as the constant average and maximum; the bitrate curve, constancy and headroom are not applied.");
			}
		}else if(cfg.bitrateCurve == 0 && cfg.bitrateConstancyPct == 0){
			// Keep the raw request's integer-bit precision. The internal
			// reference only scales upward when Max Bitrate exceeds it;
			// the budget and headroom caps still apply below.
			target = (int64_t)rc.averageBitRate * cfg.bitrateMbit / requestReferenceMbit;
		} else {
			// The curve reads the median of the last five requests so one
			// deep one-frame dip cannot drag the target; the current call is
			// already in the window (RecordRequest runs before ApplyOverrides).
			double reqMbit = RequestMedian();
			if(reqMbit <= 0.0){ reqMbit = rc.averageBitRate / 1e6; }
			double x = reqMbit / (double)requestReferenceMbit;
			if(x < 0.0){ x = 0.0; } else if(x > 1.0){ x = 1.0; }
			target = (int64_t)((double)cfg.bitrateMbit * 1e6 * GxrCurveTarget(x, cfg.bitrateCurve, cfg.bitrateConstancyPct, cfg.bitrateCurvePoints));
			// A zero request with a zero floor keeps the historical no-request
			// behavior (leave the caller's target). A raised custom P1 floor is
			// a real target and is applied even when the request is zero.
			if(target <= 0 && reqMbit <= 0.0){ target = ceiling; }
		}
		// Linear at 0% historically left a zero request alone rather than
		// writing an invalid zero average into the encoder session.
		if(!cfg.forceCbr && cfg.bitrateCurve == 0 && cfg.bitrateConstancyPct == 0 && rc.averageBitRate <= 0){
			target = ceiling;
		}
		target = (std::min<int64_t>)(target, ceiling);
		// 2026-10-27: headroom reserves part of the budget for the VBR peak.
		// The average is capped at budget/(1+pct/100); maxBitRate stays the
		// budget. 0 leaves the average free to use the whole budget. Force CBR
		// is constant rate, so headroom is inert there (max == average).
		if(!cfg.forceCbr && cfg.maxBitrateHeadroomPct > 0){
			const int64_t reserved = ceiling * 100ll / (100ll + (int64_t)cfg.maxBitrateHeadroomPct);
			target = (std::min<int64_t>)(target, reserved);
		}
		uint32_t avg = (uint32_t)target;
		uint32_t mx = cfg.forceCbr ? avg : (uint32_t)ceiling;
		// Diagnostics only: request, Max Bitrate budget and applied average.
		{
			double reqM = RequestMedian();
			if(reqM <= 0.0){ reqM = rc.averageBitRate / 1e6; }
			std::lock_guard<std::mutex> g(policyLock);
			policyState.ceilingMbit = cfg.bitrateMbit;
			policyState.requestMbit = (int)(reqM + 0.5);
			policyState.targetMbit = (int)((avg + 500000ull) / 1000000ull);
		}
		if(rc.averageBitRate != avg || rc.maxBitRate != mx){
			w += snprintf(w, WhatRem(w, what, whatLen), "avg %.0fM->%.0fM max %.0fM->%.0fM; ", rc.averageBitRate / 1e6, avg / 1e6, rc.maxBitRate / 1e6, mx / 1e6);
			rc.averageBitRate = avg;
			rc.maxBitRate = mx;
			changed = true;
		}
	}
	if(QpMapWanted(cfg) && c->rcParams.qpMapMode != NV_ENC_QP_MAP_DELTA){
		w += snprintf(w, WhatRem(w, what, whatLen), "qpMap %u->DELTA; ", (unsigned)c->rcParams.qpMapMode);
		c->rcParams.qpMapMode = NV_ENC_QP_MAP_DELTA; changed = true;
	}
	// Zero preserves the caller's buffer even when bitrate scaling is active;
	// positive values derive the explicit nominal-frame budget below.
	if(cfg.vbvFrames > 0){
		NV_ENC_RC_PARAMS &rc = c->rcParams;
		// nominal rate, never vrlink's per-call estimate (see forceFps)
		double fps = cfg.forceFps > 0 ? (double)cfg.forceFps : 90.0;
		int vbvFr = cfg.vbvFrames;
		uint32_t vbv = (uint32_t)(rc.averageBitRate / fps * vbvFr);
		if(vbv && rc.vbvBufferSize != vbv){
			w += snprintf(w, WhatRem(w, what, whatLen), "vbv %.2fM->%.2fM(%d fr); ", rc.vbvBufferSize / 1e6, vbv / 1e6, vbvFr);
			rc.vbvBufferSize = vbv; changed = true;
		}
		// 2026-11-13: AV1/HEVC derive the initial delay from the applied buffer
		// so the session starts full rather than with a caller-carried delay.
		// Policy choice for this tap, not a historical replication; H.264 keeps
		// its explicit recipe control above, and vbvFrames=0 leaves both caller
		// fields untouched.
		if(vbv && !IsH264(p->encodeGUID) && rc.vbvInitialDelay != rc.vbvBufferSize){
			w += snprintf(w, WhatRem(w, what, whatLen), "vbvInitDelay %.2fM->%.2fM [derived]; ", rc.vbvInitialDelay / 1e6, rc.vbvBufferSize / 1e6);
			rc.vbvInitialDelay = rc.vbvBufferSize; changed = true;
		}
	}
	if(cfg.maxQp > 0){
		NV_ENC_RC_PARAMS &rc = c->rcParams;
		uint32_t q = (uint32_t)cfg.maxQp;
		if(!rc.enableMaxQP || rc.maxQP.qpInterP != q || rc.maxQP.qpInterB != q || rc.maxQP.qpIntra != q){
			w += snprintf(w, WhatRem(w, what, whatLen), "maxQP %u(%u)->%u; ", rc.enableMaxQP, rc.maxQP.qpInterP, q);
			rc.enableMaxQP = 1; rc.maxQP.qpInterP = q; rc.maxQP.qpInterB = q; rc.maxQP.qpIntra = q; changed = true;
		}
	}
	if(cfg.minQp > 0 || cfg.minQpIntra > 0){
		NV_ENC_RC_PARAMS &rc = c->rcParams;
		uint32_t q = cfg.minQp > 0 ? (uint32_t)cfg.minQp : rc.minQP.qpInterP;
		uint32_t qb = cfg.minQp > 0 ? (uint32_t)cfg.minQp : rc.minQP.qpInterB;
		uint32_t qi = (uint32_t)(cfg.minQpIntra > 0 ? cfg.minQpIntra : (int)q);
		if(!rc.enableMinQP || rc.minQP.qpInterP != q || rc.minQP.qpInterB != qb || rc.minQP.qpIntra != qi){
			w += snprintf(w, WhatRem(w, what, whatLen), "minQP %u(P%u/I%u)->P%u/I%u; ", rc.enableMinQP, rc.minQP.qpInterP, rc.minQP.qpIntra, q, qi);
			rc.enableMinQP = 1; rc.minQP.qpInterP = q; rc.minQP.qpInterB = qb; rc.minQP.qpIntra = qi; changed = true;
		}
	}
	// 2026-11-11: keyframe size budget. NVENC bounds I-frame bits through
	// lowDelayKeyFrameScale, and the tap wrote it only on the Force-CBR
	// branch. VBR sessions (and CBR chosen by Steam Link with the switch off)
	// therefore left keyframes unbounded: measured 3.3-4.0 MiB IDRs at a
	// 500 Mbit budget, which Steam Link drops as "Packet too big", resets the
	// encoder, and the reset's forced IDR repeats the fault. Write the user's
	// budget whenever a bitrate budget is in force; Force CBR additionally
	// selects the mode and pins maxBitRate to the average.
	if(cfg.bitrateMbit > 0 || cfg.forceCbr){
		NV_ENC_RC_PARAMS &rc = c->rcParams;
		const uint8_t kf = (uint8_t)cfg.lowDelayKfScale;
		const bool cbr = cfg.forceCbr;
		if(rc.lowDelayKeyFrameScale != kf || (cbr && rc.rateControlMode != NV_ENC_PARAMS_RC_CBR)
			|| (cbr && rc.maxBitRate != rc.averageBitRate)){
			w += snprintf(w, WhatRem(w, what, whatLen), "%slowDelayKF %u->%u; ", cbr ? "rc->CBR " : "", rc.lowDelayKeyFrameScale, (unsigned)kf);
			rc.lowDelayKeyFrameScale = kf;
			if(cbr){
				rc.rateControlMode = NV_ENC_PARAMS_RC_CBR;
				if(rc.maxBitRate != rc.averageBitRate){ rc.maxBitRate = rc.averageBitRate; }
			}
			changed = true;
		}
	}
	if(cfg.aqStrength > 0){
		NV_ENC_RC_PARAMS &rc = c->rcParams;
		uint32_t s = (uint32_t)cfg.aqStrength;
		if(!rc.enableAQ || rc.aqStrength != s){
			w += snprintf(w, WhatRem(w, what, whatLen), "AQ %u(%u)->on(%u); ", rc.enableAQ, rc.aqStrength, s);
			rc.enableAQ = 1; rc.aqStrength = s; changed = true;
		}
	}
	{
		std::lock_guard<std::mutex> g(policyLock);
		const NV_ENC_RC_PARAMS &rc = c->rcParams;
		rcDiagState.mode = (int)rc.rateControlMode;
		rcDiagState.avgM = (unsigned)((rc.averageBitRate + 500000ull) / 1000000ull);
		rcDiagState.maxM = (unsigned)((rc.maxBitRate + 500000ull) / 1000000ull);
		rcDiagState.kf = (unsigned)rc.lowDelayKeyFrameScale;
		rcDiagState.vbvM = rc.vbvBufferSize / 1e6;
	}
	return changed;
}

void Restore(const Snapshot &snap){
	if(!snap.valid || !snap.cfgPtr || !snap.initPtr){ return; }
	snap.cfgPtr->rcParams = snap.rc;
	snap.initPtr->encodeGUID = snap.codecGuid;
	snap.cfgPtr->profileGUID = snap.codecProfile;
	memcpy(&snap.cfgPtr->encodeCodecConfig, snap.codecWindow, sizeof(snap.codecWindow));
	snap.cfgPtr->gopLength = snap.h264GopLength;
	snap.initPtr->presetGUID = snap.preset;
	snap.initPtr->frameRateNum = snap.fpsNum; snap.initPtr->frameRateDen = snap.fpsDen;
	snap.initPtr->maxEncodeWidth = snap.maxEncodeWidth; snap.initPtr->maxEncodeHeight = snap.maxEncodeHeight;
	snap.initPtr->tuningInfo = (NV_ENC_TUNING_INFO)snap.tuning;
	if(snap.split){
		snap.initPtr->version = snap.initVer; snap.cfgPtr->version = snap.cfgVer;
		*((uint32_t*)&snap.initPtr->enablePTD + 1) = snap.initFlags;
	}
}

// vrlink's own request, sampled before any override
void RecordRequest(const NV_ENC_INITIALIZE_PARAMS* p){
	if(!p->encodeConfig || !p->encodeConfig->rcParams.averageBitRate){ return; }
	double m = p->encodeConfig->rcParams.averageBitRate / 1e6;
	std::lock_guard<std::mutex> g(statsLock);
	stats.ivReqCount++; stats.ivReqSumMbit += m;
	if(m < stats.ivReqMinMbit){ stats.ivReqMinMbit = m; }
	if(m > stats.ivReqMaxMbit){ stats.ivReqMaxMbit = m; }
	// 2026-10-19: the bitrate curve's window. newest sample replaces the
	// oldest once the five slots are full.
	stats.reqHist[stats.reqHistPos] = m;
	stats.reqHistPos = (stats.reqHistPos + 1u) % 5u;
	if(stats.reqHistCount < 5u){ stats.reqHistCount++; }
}

// median of the last five requests in Mbit/s (0 = no history yet). takes
// statsLock: callers must not already hold it.
double RequestMedian(){
	std::lock_guard<std::mutex> g(statsLock);
	const uint32_t n = stats.reqHistCount;
	if(!n){ return 0.0; }
	double v[5];
	for(uint32_t i = 0; i < n; ++i){ v[i] = stats.reqHist[i]; }
	std::sort(v, v + n);
	return (n & 1u) ? v[n / 2u] : 0.5 * (v[n / 2u - 1u] + v[n / 2u]);
}

// Configured encoder OUTPUT bit depth in bits (8 or 10), 0 = not stated by the
// struct (SDK 13 typed member NV_ENC_BIT_DEPTH_INVALID) or not a known codec.
// Reads the struct era the session is stamped with, exactly like the writers
// in ApplyOverrides: >= 13 the typed members; older the packed flags word at
// +16 (HEVC pixelBitDepthMinus8 bits 11-13, AV1 output bits 15-17). H.264 High
// carries 8-bit only. This is the CONFIGURED value only: neither it nor the
// input buffer format proves what the headset decoder actually renders.
uint32_t ConfiguredOutputBitDepth(const NV_ENC_INITIALIZE_PARAMS* p){
	if(!p || !p->encodeConfig){ return 0; }
	const NV_ENC_CODEC_CONFIG &cc = p->encodeConfig->encodeCodecConfig;
	if(IsH264(p->encodeGUID)){ return 8; }
	const bool typed = ApiMajor(p->version) >= 13;
	if(IsHevc(p->encodeGUID)){
		if(typed){ const uint32_t d = (uint32_t)cc.hevcConfig.outputBitDepth; return d == 8 || d == 10 ? d : 0; }
		const uint32_t flags = *(const uint32_t*)((const unsigned char*)&cc.hevcConfig + 16);
		return 8 + ((flags >> 11) & 0x7u);
	}
	if(memcmp(&p->encodeGUID, &NV_ENC_CODEC_AV1_GUID, sizeof(GUID)) == 0){
		if(typed){ const uint32_t d = (uint32_t)cc.av1Config.outputBitDepth; return d == 8 || d == 10 ? d : 0; }
		if(ApiMajor(p->version) < 12){ return 0; } // AV1 does not exist before 12.0
		const uint32_t flags = *(const uint32_t*)((const unsigned char*)&cc.av1Config + 16);
		return 8 + ((flags >> 15) & 0x7u);
	}
	return 0;
}

void RecordLast(const NV_ENC_INITIALIZE_PARAMS* p){
	std::lock_guard<std::mutex> g(statsLock);
	stats.apiMajor = ApiMajor(p->version);
	stats.lastWidth = p->encodeWidth; stats.lastHeight = p->encodeHeight;
	if(p->encodeConfig){
		stats.lastAvgBitrate = p->encodeConfig->rcParams.averageBitRate;
		stats.lastMaxBitrate = p->encodeConfig->rcParams.maxBitRate;
		if(IsHevc(p->encodeGUID)){
			stats.lastLevel = p->encodeConfig->encodeCodecConfig.hevcConfig.level;
			stats.lastTier = p->encodeConfig->encodeCodecConfig.hevcConfig.tier;
		}
		// after ApplyOverrides: the depth the encoder is about to receive
		stats.lastBitDepth = ConfiguredOutputBitDepth(p);
	}
}

// Validate explicit values before writing caller-owned memory. Capability errors
// are returned unchanged by NVENC; invalid settings are reported, never coerced.
std::string ValidateQpMap(const NvencTapConfig& cfg){
	if(cfg.qpFovea < -128 || cfg.qpFovea > 127 || cfg.qpPeriphery < -128 || cfg.qpPeriphery > 127){
		return "streamFrame.nvencQpFovea/nvencQpPeriphery must fit the NVENC signed-byte map (-128..127).";
	}
	if(!std::isfinite(cfg.qpEdgeFalloff) || cfg.qpEdgeFalloff < 0 || cfg.qpEdgeFalloff > 1){
		return "streamFrame.postPack.edgeFalloff must be a finite fraction from 0 to 1.";
	}
	return {};
}
std::string ValidateRequest(const NvencTapConfig& cfg, const NV_ENC_INITIALIZE_PARAMS* p, bool initializing = false){
	if(!cfg.enabled){ return {}; }
	if(!cfg.requestError.empty()){ return cfg.requestError; }
	if(cfg.effectiveTileWidth <= 0 || (uint64_t)cfg.effectiveTileWidth * 4u > (std::numeric_limits<uint32_t>::max)()){
		return "streamFrame.streamFormatWidth must be positive and its four-tile height must fit the NVENC uint32 dimension.";
	}
	// Initial dimensions may describe the allocation envelope; enforce the
	// packed picture at reconfiguration and actual non-EOS submission.
	if(!initializing && cfg.enforceTile && p && (p->encodeWidth != (uint32_t)cfg.effectiveTileWidth || p->encodeHeight != (uint32_t)cfg.effectiveTileWidth * 4u)){
		std::ostringstream error;
		error << "Requested stream geometry (streamFrame.streamFormatWidth) " << cfg.effectiveTileWidth << 'x' << (uint64_t)cfg.effectiveTileWidth * 4u
			<< " differs from negotiated NVENC geometry " << p->encodeWidth << 'x' << p->encodeHeight
			<< "; refusing a stream geometry mismatch. Fix streamFrame.streamFormatWidth or reconnect after correcting the requested geometry or device capability.";
		return error.str();
	}
	// 2026-10-16: the QP-map checks apply only when the map is actually
	// configured (the per-frame encode path validates the same way); an
	// unconfigured map can no longer refuse a session.
	if(QpMapWanted(cfg)){
		const std::string invalidQpMap = ValidateQpMap(cfg);
		if(!invalidQpMap.empty()){ return invalidQpMap; }
	}
	if(!p || !p->encodeConfig){
		// 2026-10-16 restore (pre-0cf0cf7 behavior): initialization or a
		// reconfigure without an explicit encodeConfig is valid NVENC usage
		// (the request is built from the preset GUID): observe-only — the
		// call passes through after explicit active-geometry validation;
		// no codec substitution runs on this path.
		if(observeOnlyLogged.fetch_add(1) < 1){
			DriverLog("NvencTap: request without an explicit encodeConfig: observe-only pass-through (no overrides attempted, success still recorded)");
		}
		return {};
	}
	if(!ApiSupported(ApiMajor(p->version)) || !ApiSupported(ApiMajor(p->encodeConfig->version))){ return "Unsupported NVENC structure version for explicit settings."; }
	if(cfg.codec < 0 || cfg.codec > 2){ return "streamFrame.nvencCodec must be 0 (HEVC), 1 (H.264) or 2 (AV1)."; }
	if(cfg.codec == 2 && ApiMajor(p->version) < 12){ return "streamFrame.nvencCodec=2 (AV1) requires an accepted NVENC API 12.1 session upgrade."; }
	if(cfg.codec > 0 && !IsHevc(p->encodeGUID) && CodecOfGuid(p->encodeGUID) != cfg.codec){ return "streamFrame.nvencCodec cannot be applied to this caller codec."; }
	if(cfg.splitMode < 0 || (cfg.splitMode > 4 && cfg.splitMode != 15)){ return "streamFrame.nvencSplitMode must be 0, 1, 2, 3, 4 or 15."; }
	if(cfg.splitMode > 0 && cfg.codec != 1 && !IsH264(p->encodeGUID) && (ApiMajor(p->version) < 12 || StructVer(p->version) < 6)){ return "streamFrame.nvencSplitMode requires NVENC API 12.1 initialization parameters."; }
	if(cfg.preset < 0 || cfg.preset > 7 || cfg.multiPass < -1 || cfg.multiPass > 2){ return "streamFrame.nvencPreset must be 0..7 and streamFrame.nvencMultiPass must be -1..2."; }
	if(cfg.forceFps < 0 || cfg.bitrateMbit < 0 || cfg.vbvFrames < 0 || cfg.maxBitrateHeadroomPct < 0){ return "streamFrame.nvencForceFps, streamFrame.nvencBitrateMbit, streamFrame.nvencVbvFrames and streamFrame.nvencMaxBitrateHeadroomPct cannot be negative."; }
	if(cfg.bitrateRequestReferenceMbit < 0){ return "Internal bitrateRequestReferenceMbit cannot be negative."; }
	if(cfg.maxBitrateHeadroomPct > 100){ return "streamFrame.nvencMaxBitrateHeadroomPct must be 0..100."; }
	if(cfg.bitrateCurve < 0 || cfg.bitrateCurve > 3){ return "streamFrame.nvencBitrateCurve must be 0 (linear), 1 (power knee), 2 (soft knee) or 3 (custom seven-point curve)."; }
	if(cfg.bitrateCurve == GxrCurveCustom && !GxrCurvePointsValid(cfg.bitrateCurvePoints)){
		return "streamFrame.nvencBitrateCurvePoints must be seven finite {x,y} points with P1 at x=0, P6 at y=1 with a movable x, P7 at (1,1), x strictly increasing, y non-decreasing, and all values in 0..1.";
	}
	if(cfg.bitrateConstancyPct < 0 || cfg.bitrateConstancyPct > 100){ return "streamFrame.nvencBitrateConstancyPct must be 0..100."; }
	const double maxValue = (double)(std::numeric_limits<uint32_t>::max)();
	const double bitrate = cfg.bitrateMbit > 0 ? cfg.bitrateMbit * 1000000.0 : p->encodeConfig->rcParams.averageBitRate;
	if(bitrate > maxValue){ return "streamFrame.nvencBitrateMbit exceeds the NVENC uint32 bit-rate field."; }
	if(cfg.vbvFrames > 0 && bitrate / (cfg.forceFps > 0 ? cfg.forceFps : 90.0) * cfg.vbvFrames > maxValue){ return "streamFrame.nvencVbvFrames at this streamFrame.nvencBitrateMbit exceeds the NVENC uint32 field."; }
	if(cfg.maxQp < 0 || cfg.minQp < 0 || cfg.minQpIntra < 0){ return "streamFrame.nvencMaxQp, streamFrame.nvencMinQp and streamFrame.nvencMinQpIntra must be nonnegative; NVENC validates the codec-specific range."; }
	if(cfg.maxQp > 0 && (cfg.minQp > cfg.maxQp || cfg.minQpIntra > cfg.maxQp)){ return "streamFrame.nvencMinQp/streamFrame.nvencMinQpIntra exceed streamFrame.nvencMaxQp."; }
	if(cfg.aqStrength < 0 || cfg.aqStrength > 15 || (cfg.forceCbr && (cfg.lowDelayKfScale < 0 || cfg.lowDelayKfScale > 255))){ return "streamFrame.nvencAqStrength must fit 4 bits (0..15) and streamFrame.nvencLowDelayKfScale a byte (0..255) while streamFrame.nvencForceCbr is on."; }
	if(cfg.vuiFullRange < -1 || cfg.vuiFullRange > 1 || cfg.vuiMatrix < -1 || cfg.vuiMatrix > 255 || cfg.vuiPrimaries < -1 || cfg.vuiPrimaries > 255 || cfg.vuiTransfer < -1 || cfg.vuiTransfer > 255){ return "Invalid streamFrame.nvencVuiFullRange/nvencVuiMatrix/nvencVuiPrimaries/nvencVuiTransfer value."; }
	if(cfg.postPackEnabled && cfg.vuiFullRange >= 0 && cfg.vuiFullRange != (cfg.postPackLimitedRange ? 0 : 1)){ return "streamFrame.nvencVuiFullRange conflicts with streamFrame.postPack.limitedRange; change the range request or the post-pack output."; }
	if(cfg.codec == 1){
		if(cfg.h264GopFrames < -1 || cfg.h264IdrFrames < -1 || cfg.h264RefFrames < 0 || cfg.h264RefFrames > 16
			|| cfg.h264Entropy < 0 || cfg.h264Entropy > 2 || cfg.h264SliceMode < 0 || cfg.h264SliceMode > 3
			|| cfg.h264SliceData < 0 || cfg.h264VbvInitialDelay < 0){ return "Invalid streamFrame.nvencH264 recipe value (GOP, IDR, references, entropy, slices or initial VBV delay)."; }
		if((cfg.h264GopFrames == 0 || cfg.h264IdrFrames == 0) && cfg.forceFps == 0
			&& (!p->frameRateNum || !p->frameRateDen || (double)p->frameRateNum / p->frameRateDen < 0.5)){ return "Automatic streamFrame.nvencH264GopFrames/nvencH264IdrFrames requires a valid nonzero rational frame rate (streamFrame.nvencForceFps or the caller's rate)."; }
	}
	return {};
}

// One requested configuration, one NVENC call, unconditional restoration.
// A failed explicit override must never become a successful HEVC fallback.
template<typename Call>
NVENCSTATUS Guarded(const char* tag, void* encoder, NV_ENC_INITIALIZE_PARAMS* p, Call call, bool logThis,
		uint32_t &calls, uint32_t &overridden, uint32_t &failedThenOk, uint32_t &failed, uint32_t* failedStock,
		uint32_t* outerVersion = nullptr, bool initializing = false){
	(void)failedThenOk; (void)outerVersion;
	const NvencTapConfig cfg = NvencTap::Get().GetConfig();
	{
		std::lock_guard<std::mutex> guard(statsLock);
		calls++;
		// 2026-10-19: the request window belongs to one session and one tap
		// state; a fresh init or an enable transition starts a new one.
		if(initializing || stats.reqHistEnabled != cfg.enabled){
			stats.reqHistCount = 0; stats.reqHistPos = 0;
			for(double &v : stats.reqHist){ v = 0.0; }
			stats.reqHistEnabled = cfg.enabled;
		}
	}
	RecordRequest(p);
	// colour-depth fix A (2026-10-17): record the caller's raw input surface
	// class at every guarded init/reconfigure. No override writes bufferFormat
	// (overrides restore caller bytes), so this is the format vrlink passed,
	// before/after override alike — captured even when validation or an
	// override failure path returns early below.
	if(p){
		std::lock_guard<std::mutex> guard(statsLock); stats.lastInputBufferFormat = (uint32_t)p->bufferFormat;
	}
	if(logThis){ Describe(tag, p, cfg.verbose); }
	const std::string callerGeometry = p ? std::to_string(p->encodeWidth) + "x" + std::to_string(p->encodeHeight)
		+ " max=" + std::to_string(p->maxEncodeWidth) + "x" + std::to_string(p->maxEncodeHeight) : "null";
	const auto fail = [&](NVENCSTATUS status, std::string error){
		if(initializing && p){
			error += " | caller init: " + callerGeometry + " | applied init: " + std::to_string(p->encodeWidth) + "x" + std::to_string(p->encodeHeight)
				+ " max=" + std::to_string(p->maxEncodeWidth) + "x" + std::to_string(p->maxEncodeHeight)
				+ " api=" + std::to_string(p->version) + " format=" + std::to_string((uint32_t)p->bufferFormat);
		}
		PublishFailure(encoder, cfg, status, error, initializing);
	};
	const std::string invalid = ValidateRequest(cfg, p, initializing);
	if(!invalid.empty()){
		fail(NV_ENC_ERR_INVALID_PARAM, invalid);
		std::lock_guard<std::mutex> guard(statsLock); failed++;
		return NV_ENC_ERR_INVALID_PARAM;
	}
	// 2026-11-03: session-bound capability inventory is queried outside frame
	// paths (init/reconfigure) and only when the tap is enabled. A failed or
	// incomplete query never publishes false; it simply defers to NVENC.
	if(cfg.enabled){
		EnsureCapabilitiesQueried(encoder, p ? p->version : 0);
		const std::string capError = ValidateCapabilities(cfg, encoder, p);
		if(!capError.empty()){
			fail(NV_ENC_ERR_INVALID_PARAM, capError);
			std::lock_guard<std::mutex> guard(statsLock); failed++;
			return NV_ENC_ERR_INVALID_PARAM;
		}
	}
	Snapshot snap; char what[256] = {};
	const bool changed = cfg.enabled && ApplyOverrides(encoder, p, cfg, snap, what, sizeof(what), initializing);
	if(!snap.error.empty()){
		fail(NV_ENC_ERR_INVALID_PARAM, snap.error); Restore(snap);
		std::lock_guard<std::mutex> guard(statsLock); failed++;
		return NV_ENC_ERR_INVALID_PARAM;
	}
	if(changed && logThis){ DriverLog("NvencTap: %s override: %s", tag, what); }
	RecordLast(p);
	const int effectiveCodec = CodecOfGuid(p->encodeGUID);
	const NVENCSTATUS status = call();
	if(status == NV_ENC_SUCCESS){
		SetSessionCodec(encoder, effectiveCodec);
		PublishSuccess(encoder, cfg, p, initializing);
	}else{
		// 2026-10-16: failures must name the NVENC status number and the
		// request itself — nvEncGetLastErrorString often returns useless
		// text ("Success.") and early calls can precede a working log sink,
		// so the persisted error state carries the full context.
		std::string error = std::string(tag) + " rejected the requested configuration (NVENC status " + std::to_string((unsigned)status) + ")";
		if(origGetLastErrorString){ const char* detail = origGetLastErrorString(encoder); if(detail && *detail){ error += ": "; error += detail; } }
		error += " | request: " + RequestDescription(cfg);
		fail(status, error);
	}
	Restore(snap);
	{
		std::lock_guard<std::mutex> guard(statsLock);
		if(status == NV_ENC_SUCCESS){
			if(changed){ overridden++; }
			if(snap.split){ stats.splitApplied++; stats.splitState = 1; stats.splitStatus = 0; }
		}else{
			if(!cfg.enabled && failedStock){ (*failedStock)++; }else{ failed++; }
			if(snap.split){ stats.splitState = 2; stats.splitStatus = (uint32_t)status; }
		}
	}
	return status;
}

} // namespace

// ---------------------------------------------------------------------------
NVENCSTATUS NVENCAPI NvencTapShims::InitializeEncoder(void* encoder, NV_ENC_INITIALIZE_PARAMS* params){
	{
		const Auth auth = AuthorityOf(encoder);
		if(auth == Auth::Pristine){ return origInitializeEncoder(encoder, params); }
		if(auth == Auth::Stale){
			// closed epoch: required 12.1 ABI adaptation only, nothing recorded or published
#ifdef VENDOR_GALAXYXR
			Defer(DeferredStalePolicyCall);
#endif
			Retag rt(encoder); if(params && Upgraded(encoder)){ RetagInitParams(rt, params); }
			return origInitializeEncoder(encoder, params);
		}
	}
	if(!params){
		const NVENCSTATUS status = origInitializeEncoder(encoder, params);
		if(status != NV_ENC_SUCCESS){ PublishFailure(encoder, NvencTap::Get().GetConfig(), status, "nvEncInitializeEncoder rejected null parameters (NVENC status " + std::to_string((unsigned)status) + ")", true); }
		return status;
	}
	// re-tag first so the caps probe below and Guarded see the session's version
	Retag rt(encoder); if(Upgraded(encoder)){ RetagInitParams(rt, params); }
	const NvencTapConfig initConfig = NvencTap::Get().GetConfig();
	if(!initConfig.enabled){
		const NVENCSTATUS status = origInitializeEncoder(encoder, params);
		if(status == NV_ENC_SUCCESS){ SetSessionCodec(encoder, CodecOfGuid(params->encodeGUID)); PublishSuccess(encoder, initConfig, params, true); }
		else{
			std::string error = "nvEncInitializeEncoder failed with tap OFF (NVENC status " + std::to_string((unsigned)status) + ")";
			if(origGetLastErrorString){ const char* detail = origGetLastErrorString(encoder); if(detail && *detail){ error += ": "; error += detail; } }
			error += " | init: " + std::to_string(params->encodeWidth) + "x" + std::to_string(params->encodeHeight)
				+ " max=" + std::to_string(params->maxEncodeWidth) + "x" + std::to_string(params->maxEncodeHeight);
			PublishFailure(encoder, initConfig, status, error, true);
		}
		return status;
	}
	// one-shot: how many NVENC engines does this session see (NV_ENC_CAPS_
	// NUM_ENCODER_ENGINES is a 12.0 enum value; NV_ENC_CAPS_PARAM itself is
	// unchanged since 11.1, so we ask with the caller's own struct version)
	if(origGetEncodeCaps && capsLogged.fetch_add(1) < 1){
		NV_ENC_CAPS_PARAM cp = {};
		cp.version = ((params->version & 0xFFFFu) | (params->version & 0x0F000000u)) | (1u << 16) | (0x7u << 28);
		cp.capsToQuery = NV_ENC_CAPS_NUM_ENCODER_ENGINES;
		int v = 0;
		const GUID capsCodec = initConfig.codec == 1 ? NV_ENC_CODEC_H264_GUID
			: initConfig.codec == 2 ? NV_ENC_CODEC_AV1_GUID : params->encodeGUID;
		NVENCSTATUS cs = origGetEncodeCaps(encoder, capsCodec, &cp, &v);
		DriverLog("NvencTap: NV_ENC_CAPS_NUM_ENCODER_ENGINES -> %d (status %u) | frame %ux%u: implicit split needs height>=2112, NVENCs>=2, preset P1..P4 at LL/ULL",
			v, (unsigned)cs, params->encodeWidth, params->encodeHeight);
		std::lock_guard<std::mutex> g(statsLock); stats.numEncoderEngines = cs == NV_ENC_SUCCESS ? (uint32_t)v : 0;
	}
	bool logThis = initLogged.fetch_add(1) < 4 || NvencTap::Get().GetConfig().verbose;
	return Guarded("nvEncInitializeEncoder", encoder, params, [&]{ return origInitializeEncoder(encoder, params); }, logThis,
		stats.initCalls, stats.initOverridden, stats.initFailedThenPristineOk, stats.initFailed, nullptr, nullptr, true);
}

NVENCSTATUS NVENCAPI NvencTapShims::ReconfigureEncoder(void* encoder, NV_ENC_RECONFIGURE_PARAMS* params){
	{
		const Auth auth = AuthorityOf(encoder);
		if(auth == Auth::Pristine){ return origReconfigureEncoder(encoder, params); }
		if(auth == Auth::Stale){
#ifdef VENDOR_GALAXYXR
			Defer(DeferredStalePolicyCall);
#endif
			Retag rt(encoder); if(params && Upgraded(encoder)){ rt.add(&params->version, 1, true); RetagInitParams(rt, &params->reInitEncodeParams); }
			return origReconfigureEncoder(encoder, params);
		}
	}
	if(!params){ return origReconfigureEncoder(encoder, params); }
	NvencTapConfig cfg = NvencTap::Get().GetConfig();
	// 2026-10-19 reconnect deferral (AV1): vrlink stops encoding when the
	// client drops and reconfigures before the first frame of the resumed
	// connection, so a reconfigure after an encode idle gap marks that
	// boundary. Re-arm the handshake window here — otherwise a reconnect that
	// reuses the live session inherits the previous connection's cleared
	// window and split rides its first frames. A window that is still open is
	// left alone, so the burst of reconfigures that follows arms once.
	if(cfg.enabled && cfg.splitMode > 0
		&& (CodecOfGuid(params->reInitEncodeParams.encodeGUID) == 2 || cfg.codec == 2)){
		const long long last = lastEncodeSteadyMs.load(std::memory_order_relaxed);
		if(last > 0 && lastEncodeEncoder.load(std::memory_order_relaxed) == encoder){
			const double now = NowSecondsNv();
			const double idleSeconds = now - (double)last / 1000.0;
			const long long arm = splitArmSteadyMs.load(std::memory_order_relaxed);
			const double armSeconds = arm > 0 ? now - (double)arm / 1000.0 : -1.0;
			if(idleSeconds >= splitReconnectIdleSeconds
				&& (armSeconds < 0.0 || armSeconds >= splitHandshakeGraceSeconds)){
				ArmSplitHandshakeWindow(SplitArmResume, idleSeconds, true);
			}
		}
	}
	Retag rt(encoder); if(Upgraded(encoder)){ rt.add(&params->version, 1, true); RetagInitParams(rt, &params->reInitEncodeParams); }
	if(!cfg.enabled){
		const NVENCSTATUS status = origReconfigureEncoder(encoder, params);
		if(status == NV_ENC_SUCCESS){ SetSessionCodec(encoder, CodecOfGuid(params->reInitEncodeParams.encodeGUID)); PublishSuccess(encoder, cfg, &params->reInitEncodeParams); }
		return status;
	}
	bool logThis = reconfLogged.fetch_add(1) < 4 || cfg.verbose;
	NVENCSTATUS st = Guarded("nvEncReconfigureEncoder", encoder, &params->reInitEncodeParams,
		[&]{ return origReconfigureEncoder(encoder, params); }, logThis,
		stats.reconfCalls, stats.reconfOverridden, stats.reconfFailedThenPristineOk, stats.reconfFailed,
		cfg.enabled ? nullptr : &stats.reconfFailedStock, &params->version);
	if(logThis){ DriverLog("NvencTap: nvEncReconfigureEncoder -> %u (reset=%u forceIDR=%u)", (unsigned)st, params->resetEncoder, params->forceIDR); }
	return st;
}

NVENCSTATUS NVENCAPI NvencTapShims::RegisterResource(void* encoder, NV_ENC_REGISTER_RESOURCE* params){
	const Auth auth = AuthorityOf(encoder);
	if(auth == Auth::Pristine){ return origRegisterResource(encoder, params); }
	Retag rt(encoder); if(params && Upgraded(encoder)){ rt.add(&params->version, 4, false); }
	// 2026-09-30: retain lifetime ownership even while OFF. A newly
	// registered alias may map the same texture as an older ON handle.
	// A stale (closed-epoch) session keeps bookkeeping so its resources stay
	// consistent, but records no statistics or diagnostics.
	const bool enabled = NvencTap::Get().GetConfig().enabled && auth == Auth::Live;
	if(enabled){ std::lock_guard<std::mutex> g(statsLock); stats.registerCalls++; }
	if(enabled && params && registerLogged.fetch_add(1) < 12){
		DriverLog("NvencTap: nvEncRegisterResource encoder=%p type=%u %ux%u pitch=%u fmt=0x%x usage=%u res=%p — a LAYER-sized DX resource here is the direct-encode substitution site",
			encoder, (unsigned)params->resourceType, params->width, params->height, params->pitch,
			(unsigned)params->bufferFormat, (unsigned)params->bufferUsage, params->resourceToRegister);
	}
	NVENCSTATUS st = origRegisterResource(encoder, params);
	if(st == NV_ENC_SUCCESS && params && params->registeredResource){
		std::lock_guard<std::mutex> g(resLock);
		registered[params->registeredResource] = { params->resourceToRegister, (uint32_t)params->bufferFormat, (uint32_t)params->resourceType, encoder };
	}
	return st;
}
NVENCSTATUS NVENCAPI NvencTapShims::UnregisterResource(void* encoder, NV_ENC_REGISTERED_PTR reg){
	if(AuthorityOf(encoder) == Auth::Pristine){ return origUnregisterResource(encoder, reg); }
	void* releasedTexture = nullptr;
	NVENCSTATUS st;
	{
		std::lock_guard<std::mutex> g(resLock);
		st = origUnregisterResource(encoder, reg);
		if(st == NV_ENC_SUCCESS){
			const auto it = registered.find(reg);
			if(it != registered.end()){
				void* const texture = it->second.texture;
				registered.erase(it);
				bool stillUsed = false; // an alias registration of the same texture keeps the cache entry
				for(const auto& r : registered){ if(r.second.texture == texture){ stillUsed = true; break; } }
				if(!stillUsed){ releasedTexture = texture; }
			}
		}
	}
	// success only, outside resLock; a failed unregister retains everything
	if(releasedTexture){ NvencPostPack::ReleaseTextures(&releasedTexture, 1); }
	return st;
}
NVENCSTATUS NVENCAPI NvencTapShims::UnmapInputResource(void* encoder, NV_ENC_INPUT_PTR mapped){
	if(AuthorityOf(encoder) == Auth::Pristine){ return origUnmapInputResource(encoder, mapped); }
	std::lock_guard<std::mutex> g(resLock);
	NVENCSTATUS st = origUnmapInputResource(encoder, mapped);
	if(st == NV_ENC_SUCCESS){ mappedToReg.erase(mapped); }
	return st;
}

NVENCSTATUS NVENCAPI NvencTapShims::EncodePicture(void* encoder, NV_ENC_PIC_PARAMS* params){
	const Auth auth = AuthorityOf(encoder);
	if(auth == Auth::Pristine){ return origEncodePicture(encoder, params); }
#ifdef VENDOR_GALAXYXR
	if(auth == Auth::Stale){ Defer(DeferredStalePolicyCall); }
#endif
	const NvencTapConfig qcfg = NvencTap::Get().GetConfig();
	// 2026-09-30: OFF keeps only the ABI adapter required by live 12.1 sessions.
	// A stale (closed-epoch) session is drained through the same adapter: no QP
	// map, geometry enforcement, stats or published result.
	if(!qcfg.enabled || auth == Auth::Stale){
		NVENCSTATUS status;
		if(params && Upgraded(encoder) && Is111(params->version)){
			// explicit 11.1 -> 12.1 field copy (see CopyPicParams111To121)
			alignas(16) unsigned char scratch[kScratch] = {};
			status = origEncodePicture(encoder, CopyPicParams111To121(params, (NV_ENC_PIC_PARAMS*)scratch));
		}else{ status = origEncodePicture(encoder, params); }
		if(auth == Auth::Live && status == NV_ENC_SUCCESS && params && params->inputBuffer){ PublishPictureResult(encoder, status, {}, false); }
		return status;
	}
	// 2026-10-16: the QP-map validation applies only when the map is actually
	// configured (QpMapWanted); an unconfigured map can no longer refuse a
	// submitted frame.
	const std::string invalidQpMap = QpMapWanted(qcfg) ? ValidateQpMap(qcfg) : std::string();
	if(params && params->inputBuffer && !(params->encodePicFlags & NV_ENC_PIC_FLAG_EOS) && qcfg.enforceTile
		&& (qcfg.effectiveTileWidth <= 0 || (uint64_t)qcfg.effectiveTileWidth * 4u > (std::numeric_limits<uint32_t>::max)()
			|| params->inputWidth != (uint32_t)qcfg.effectiveTileWidth || params->inputHeight != (uint64_t)qcfg.effectiveTileWidth * 4u)){
		const std::string error = "Requested stream geometry (streamFrame.streamFormatWidth) " + std::to_string(qcfg.effectiveTileWidth)
			+ "x" + std::to_string((int64_t)qcfg.effectiveTileWidth * 4) + " differs from submitted picture "
			+ std::to_string(params->inputWidth) + "x" + std::to_string(params->inputHeight) + "; no alternate tile was applied.";
		PublishPictureResult(encoder, NV_ENC_ERR_INVALID_PARAM, error);
		return NV_ENC_ERR_INVALID_PARAM;
	}
	if(params && params->inputBuffer && !invalidQpMap.empty()){
		PublishPictureResult(encoder, NV_ENC_ERR_INVALID_PARAM, invalidQpMap);
		return NV_ENC_ERR_INVALID_PARAM;
	}
	{ std::lock_guard<std::mutex> g(statsLock); stats.encodeCalls++; }
	// connection-boundary probe (2026-10-19): a reconfigure that arrives when
	// this timestamp is older than splitReconnectIdleSeconds is the resumed
	// connection's first NVENC call (see the reconnect arm in ReconfigureEncoder)
	lastEncodeSteadyMs.store((long long)(NowSecondsNv() * 1000.0), std::memory_order_relaxed);
	lastEncodeEncoder.store(encoder, std::memory_order_relaxed);
	if(params && params->outputBitstream){
		std::lock_guard<std::mutex> g(submitLock);
		submits[submitHead] = { params->outputBitstream, NowSecondsNv() };
		submitHead = (submitHead + 1) % 16;
	}
	if(params && encodeLogged.fetch_add(1) < 3){
		DriverLog("NvencTap: nvEncEncodePicture encoder=%p %ux%u pitch=%u in=%p out=%p fmt=0x%x picType=%u struct=%u frameIdx=%u flags=0x%x",
			encoder, params->inputWidth, params->inputHeight, params->inputPitch, params->inputBuffer, params->outputBitstream,
			(unsigned)params->bufferFmt, (unsigned)params->pictureType, (unsigned)params->pictureStruct, params->frameIdx, params->encodePicFlags);
	}
	double t0 = NowSecondsNv();
	NVENCSTATUS st;
	QpMapSnapshot qmapOwned;
	const int8_t* qmap = nullptr; uint32_t qsize = 0;
	// the per-frame map paths key off the LIVE session codec (0/1/2),
	// falling back to the tap config while no init has been seen: a swap
	// that failed and fell back to vrlink's pristine params leaves an
	// HEVC session live under a codec-1/2 config, and an MB/SB-grid map
	// would fail every one of its frames.
	const int liveCodec = SessionCodecOf(encoder);
	const int mapCodec = liveCodec >= 0 ? liveCodec : (int)qcfg.codec;
	lastSessCodec.store(liveCodec);
	if(params && params->inputBuffer && QpMapWanted(qcfg) && params->inputWidth && params->inputHeight){
		qmapOwned = GetQpMap(params->inputWidth, params->inputHeight, mapCodec, qcfg);
		qmap = qmapOwned->data(); qsize = (uint32_t)qmapOwned->size();
	}
	// The caller's delta-map fields live at the 11.1 offsets whenever the
	// struct it handed us is 11.1-versioned (vrlink) - the same raw offsets
	// CopyPicParams111To121 reads for the upgraded path. Member access is
	// only valid for a 12.1+ caller.
	const int8_t* callerMap = params ? params->qpDeltaMap : nullptr;
	uint32_t callerSize = params ? params->qpDeltaMapSize : 0;
	if(params && Is111(params->version)){
		callerMap = *(int8_t* const*)((const unsigned char*)params + kQpDeltaMap11Offset);
		callerSize = *(const uint32_t*)((const unsigned char*)params + kQpDeltaMapSize11Offset);
	}
	// H.264 / AV1: adapt the caller's HEVC-grid (32x32 CTB) delta map to
	// the grid the encoder validates (see ConvertDeltaMap). EOS frames
	// carry no picture: detach the caller's map like SteamFrame does so a
	// wrong-size surface cannot fail the flush. The tap's own foveation
	// map wins when it is active.
	MapOverride mapOv;
	if(!qmap && params && (mapCodec == 1 || mapCodec == 2)){
		if(params->inputBuffer){
			mapOv = ConvertDeltaMap(callerMap, callerSize, params->inputWidth, params->inputHeight, mapCodec);
		}else if(callerMap){
			mapOv.set = true;
		}
	}
	if(params && params->inputBuffer){
		// one-shot detail probe + rotation-proof heartbeat pair: what the
		// caller supplied vs what the encode call actually carries
		const int8_t* useMap = qmap ? qmap : (mapOv.set ? mapOv.p : callerMap);
		const uint32_t useSize = qmap ? qsize : (mapOv.set ? mapOv.n : callerSize);
		lastMapInSize.store(callerSize); lastMapUseSize.store(useSize); lastMapSel.store(mapCodec);
		static std::atomic<int> probeSel[3];
		const int sel = (mapCodec >= 0 && mapCodec <= 2) ? mapCodec : 2;
		if(probeSel[sel].fetch_add(1) < 2){
			DriverLog("NvencTap: delta map probe sel=%d in=%p/%u use=%p/%u w=%u h=%u (ctb32=%u mb=%u sb64=%u)",
				sel, (const void*)callerMap, callerSize, (const void*)useMap, useSize,
				params->inputWidth, params->inputHeight,
				((params->inputWidth + 31) / 32) * ((params->inputHeight + 31) / 32),
				((params->inputWidth + 15) / 16) * ((params->inputHeight + 15) / 16),
				((params->inputWidth + 63) / 64) * ((params->inputHeight + 63) / 64));
		}
	}
	if(params && Upgraded(encoder) && Is111(params->version)){
		// NV_ENC_PIC_PARAMS grew 11.1 -> 12.1: call with an explicitly
		// copied 12.1 struct (see CopyPicParams111To121) so the driver
		// never reads past vrlink's struct and every moved field lands in
		// its 12.1 slot
		alignas(16) unsigned char scratch[kScratch] = {};
		NV_ENC_PIC_PARAMS* sp = CopyPicParams111To121(params, (NV_ENC_PIC_PARAMS*)scratch);
		if(qmap){ sp->qpDeltaMap = (int8_t*)qmap; sp->qpDeltaMapSize = qsize; std::lock_guard<std::mutex> g(statsLock); stats.qpMapFrames++; }
		else if(mapOv.set){ sp->qpDeltaMap = (int8_t*)mapOv.p; sp->qpDeltaMapSize = mapOv.n; }
		st = origEncodePicture(encoder, sp);
		{ std::lock_guard<std::mutex> g(statsLock); stats.retagCalls++; }
	}else if(params && (qmap || mapOv.set)){
		// direct (non-upgraded) session: address the caller's map fields in
		// ITS layout for the duration of the call, restore after
		const bool c111 = Is111(params->version);
		int8_t* savedMap; uint32_t savedSize;
		const int8_t* setMap = qmap ? qmap : mapOv.p;
		const uint32_t setSize = qmap ? qsize : mapOv.n;
		if(c111){
			savedMap = *(int8_t**)((unsigned char*)params + kQpDeltaMap11Offset);
			savedSize = *(uint32_t*)((unsigned char*)params + kQpDeltaMapSize11Offset);
			*(int8_t**)((unsigned char*)params + kQpDeltaMap11Offset) = (int8_t*)setMap;
			*(uint32_t*)((unsigned char*)params + kQpDeltaMapSize11Offset) = setSize;
		}else{
			savedMap = params->qpDeltaMap; savedSize = params->qpDeltaMapSize;
			params->qpDeltaMap = (int8_t*)setMap; params->qpDeltaMapSize = setSize;
		}
		if(qmap){ std::lock_guard<std::mutex> g(statsLock); stats.qpMapFrames++; }
		st = origEncodePicture(encoder, params);
		if(c111){
			*(int8_t**)((unsigned char*)params + kQpDeltaMap11Offset) = savedMap;
			*(uint32_t*)((unsigned char*)params + kQpDeltaMapSize11Offset) = savedSize;
		}else{
			params->qpDeltaMap = savedMap; params->qpDeltaMapSize = savedSize;
		}
	}else{
		st = origEncodePicture(encoder, params);
	}
	// 2026-10-21 (S0): occupancy + stale-slot hygiene. Only a successful submit
	// owns a pairing entry; a failed one used to leave its timestamp in the ring
	// until a later wrap, which could pair with a reused bitstream buffer and
	// report a bogus submit->lock latency.
	{
		std::lock_guard<std::mutex> g(statsLock);
		if(st == NV_ENC_SUCCESS){
			stats.inflight++;
			if(stats.inflight > stats.ivInflightMax){ stats.ivInflightMax = stats.inflight; }
		}
	}
	if(st != NV_ENC_SUCCESS && params && params->outputBitstream){
		std::lock_guard<std::mutex> g(submitLock);
		for(int i = 0; i < 16; i++){
			if(submits[i].out == params->outputBitstream){ submits[i].out = nullptr; submits[i].t = 0; }
		}
	}
	if(NvencTap::Get().GetConfig().enabled && params && st != NV_ENC_SUCCESS){
		encFails.fetch_add(1);
		lastEncFailStatus.store((uint32_t)st);
		const char* le = origGetLastErrorString ? origGetLastErrorString(encoder) : "";
		{ std::lock_guard<std::mutex> g(statsLock); snprintf(lastEncFailStr, sizeof(lastEncFailStr), "%s", le ? le : ""); }
		if(encFailLogged.fetch_add(1) < 3){
			DriverLog("NvencTap: nvEncEncodePicture -> failed (status %u) %s", (unsigned)st, le ? le : "");
		}
	}
	if(params && params->inputBuffer){
		std::string error;
		if(st != NV_ENC_SUCCESS && st != NV_ENC_ERR_NEED_MORE_INPUT){
			error = "nvEncEncodePicture rejected the submitted picture";
			const char* detail = origGetLastErrorString ? origGetLastErrorString(encoder) : nullptr;
			if(detail && *detail){ error += ": "; error += detail; }
		}
		PublishPictureResult(encoder, st, error);
	}
	double ms = (NowSecondsNv() - t0) * 1000.0;
	if(params && params->inputBuffer){ // skip the EOS/flush calls (in=null)
		std::lock_guard<std::mutex> g(statsLock);
		stats.ivSubmitSamples++; stats.ivSubmitSumMs += ms; if(ms > stats.ivSubmitMaxMs){ stats.ivSubmitMaxMs = ms; } if(ms >= 10.0){ stats.ivSubmitOver10++; }
	}
	return st;
}

NVENCSTATUS NVENCAPI NvencTapShims::LockBitstream(void* encoder, NV_ENC_LOCK_BITSTREAM* params){
	const Auth auth = AuthorityOf(encoder);
	if(auth == Auth::Pristine){ return origLockBitstream(encoder, params); }
	NVENCSTATUS st;
	if(params && Upgraded(encoder) && Is111(params->version)){
		// NV_ENC_LOCK_BITSTREAM grew 11.1 -> 12.1 and has [out] fields: call
		// on a scratch copy, copy the 11.1 extent back
		alignas(16) unsigned char scratch[kScratch] = {};
		memcpy(scratch, params, kLockBitstream11Size);
		uint32_t saved = params->version;
		((NV_ENC_LOCK_BITSTREAM*)scratch)->version = Tag121(1, true);
		st = origLockBitstream(encoder, (NV_ENC_LOCK_BITSTREAM*)scratch);
		memcpy(params, scratch, kLockBitstream11Size);
		params->version = saved;
		if(auth == Auth::Live && NvencTap::Get().GetConfig().enabled){ std::lock_guard<std::mutex> g(statsLock); stats.retagCalls++; }
	}else{
		st = origLockBitstream(encoder, params);
	}
	if(auth != Auth::Live || !NvencTap::Get().GetConfig().enabled || st != NV_ENC_SUCCESS || !params){ return st; }
	lockCalls.fetch_add(1);
	lockLastSize.store(params->bitstreamSizeInBytes);
	if(firstLockLogged.fetch_add(1) < 1){
		// guard: read the 8 head bytes only when pointer and size allow
		if(params->bitstreamBufferPtr && params->bitstreamSizeInBytes >= 8){
			const unsigned char* p = (const unsigned char*)params->bitstreamBufferPtr;
			DriverLog("NvencTap: first bitstream lock: %u bytes, head %02x %02x %02x %02x %02x %02x %02x %02x",
				params->bitstreamSizeInBytes, (unsigned)p[0], (unsigned)p[1], (unsigned)p[2], (unsigned)p[3], (unsigned)p[4], (unsigned)p[5], (unsigned)p[6], (unsigned)p[7]);
		}
	}
	double latMs = -1;
	if(params->outputBitstream){
		double now = NowSecondsNv();
		std::lock_guard<std::mutex> g(submitLock);
		for(int i = 0; i < 16; i++){
			if(submits[i].out == params->outputBitstream){ latMs = (now - submits[i].t) * 1000.0; submits[i].out = nullptr; break; }
		}
	}
	uint32_t n = params->bitstreamSizeInBytes;
	// Debug AU dump (overridden sessions only): full bytes for the first 4
	// frames, then a size-only trace, to compare what NVENC produced against
	// what the client's decoder receives. TEMP is writable from the SteamVR
	// user session; missing env -> no dump.
	{
		static std::atomic<int> dumpFrames{0};
		int df = dumpFrames.fetch_add(1);
		if(df < 50 && NvencTap::Get().GetConfig().codec != 0){
			const char* tmp = getenv("TEMP");
			std::string path;
			if(tmp){ path = std::string(tmp) + "\\gxr_au_dump.bin"; }
			else {
				const char* up = getenv("USERPROFILE");
				if(up){ path = std::string(up) + "\\AppData\\Local\\Temp\\gxr_au_dump.bin"; }
			}
			if(!path.empty()){
				FILE* f = fopen(path.c_str(), df == 0 ? "wb" : "ab");
				if(f){
					uint32_t dumpCap = df < 4 ? 98304u : 0u;
					uint32_t m = n < dumpCap ? n : dumpCap;
					uint32_t hdr[6] = { 0x31415547u /*GAU1*/, (uint32_t)df, (uint32_t)params->pictureType,
						(uint32_t)params->frameIdx, n, m };
					fwrite(hdr, 1, sizeof(hdr), f);
					if(m && params->bitstreamBufferPtr){ fwrite(params->bitstreamBufferPtr, 1, m, f); }
					fclose(f);
					if(df < 8){
						DriverLog("NvencTap: AUdump %d frameIdx=%u type=%u size=%u dumped=%u", df,
							(uint32_t)params->frameIdx, (uint32_t)params->pictureType, n, m);
					}
				}
			}
		}
	}
	bool idr = params->pictureType == NV_ENC_PIC_TYPE_IDR || params->pictureType == NV_ENC_PIC_TYPE_I;
	const int probeSessionCodec = SessionCodecOf(encoder); // accepted session, epoch boundary only
	bool newMax = false;
	{
		std::lock_guard<std::mutex> g(statsLock);
		stats.lockCalls++;
		stats.lastFrameBytes = n; stats.sumFrameBytes += n;
		if(n > stats.maxFrameBytes){ stats.maxFrameBytes = n; newMax = true; }
		if(idr){ stats.idrFrames++; if(n > stats.maxFrameBytesIdr){ stats.maxFrameBytesIdr = n; } }
		int b = n < 262144 ? 0 : n < 524288 ? 1 : n < 1048576 ? 2 : n < 1572864 ? 3 : n < 2097152 ? 4 : n < 4194304 ? 5 : 6;
		stats.sizeBucket[b]++;
		stats.lastAvgQp = params->frameAvgQP; if(params->frameAvgQP > stats.maxAvgQp){ stats.maxAvgQp = params->frameAvgQP; }
		// 2026-10-21: capture at most one ordinary frame per second plus a
		// retained keyframe for same-generation parameter sets. NVENC still
		// owns this locked buffer; only the bounded owned copy is published.
		if(frameProbeEncoder != encoder || frameProbeInitCount != stats.initCalls
			|| frameProbeCodec != probeSessionCodec || params->frameIdx < frameProbeLastIndex){
			++frameProbeEpoch;
		}
		frameProbeEncoder = encoder;
		frameProbeInitCount = stats.initCalls;
		frameProbeCodec = probeSessionCodec;
		frameProbeLastIndex = params->frameIdx;
		frameProbeState.Record(GalaxyXR_NVENC_Probe_v1, GetCurrentProcessId(), GetTickCount64(),
			frameProbeEpoch, stats.lockCalls, stats.sumFrameBytes, params->frameIdx,
			params->bitstreamBufferPtr, n, idr);
		if(latMs >= 0 && stats.inflight > 0){ stats.inflight--; }
		if(latMs >= 0 && latMs < 5000){
			stats.latSamples++; stats.latSumMs += latMs; if(latMs > stats.latMaxMs){ stats.latMaxMs = latMs; }
			stats.ivLatSamples++; stats.ivLatSumMs += latMs; if(latMs > stats.ivLatMaxMs){ stats.ivLatMaxMs = latMs; } if(latMs >= 11.1){ stats.ivLatOver11++; }
			int lb = latMs < 5 ? 0 : latMs < 8 ? 1 : latMs < 11 ? 2 : latMs < 16 ? 3 : latMs < 33 ? 4 : 5;
			stats.latBucket[lb]++;
		}
	}
	// Record individual NVENC output buffers above 1 MiB. These observations
	// alone do not establish complete-frame, transport or decoder limits.
	if(newMax && n >= 1048576 && bigFrameLogged.fetch_add(1) < 40){
		int rcMode; unsigned rcAvgM, rcMaxM, rcKf; double rcVbvM;
		{
			std::lock_guard<std::mutex> g(policyLock);
			rcMode = rcDiagState.mode; rcAvgM = rcDiagState.avgM; rcMaxM = rcDiagState.maxM;
			rcKf = rcDiagState.kf; rcVbvM = rcDiagState.vbvM;
		}
		DriverLog("NvencTap: new largest encoded output buffer: %u bytes (%.2f MiB) picType=%u%s frameIdx=%u avgQP=%u slices=%u | rc mode=%d avg=%uM max=%uM vbv=%.2fM lowDelayKF=%u",
			n, n / 1048576.0, (unsigned)params->pictureType, idr ? " IDR/I" : "", params->frameIdx, params->frameAvgQP, params->numSlices,
			rcMode, rcAvgM, rcMaxM, rcVbvM, rcKf);
	}
	return st;
}

// ---- session upgrade shims ----
#ifdef VENDOR_GALAXYXR
namespace {
// The old design presented the function list as 12.1 so the runtime's view of
// the client matched a 12.1 session. The caller's cached list stays untouched;
// instead, only an ADMITTED OPEN that is about to upgrade registers a private
// local 12.1 list first. Its status is diagnostic: a real rejection surfaces
// as the open's own status.
void RegisterPrivateList121(){
	const PFN_CreateInstance real = reinterpret_cast<PFN_CreateInstance>(realCreateInstance.load(std::memory_order_acquire));
	if(!real){ return; }
	NV_ENCODE_API_FUNCTION_LIST local = {};
	local.version = Tag121(2, false);
	if(real(&local) != NV_ENC_SUCCESS){ Defer(DeferredPrivateListRejected); }
}
}
#endif
NVENCSTATUS NVENCAPI NvencTapShims::OpenEncodeSessionEx(NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS* params, void** encoder){
	if(!params || !encoder || !origOpenEncodeSessionEx){ return NV_ENC_ERR_INVALID_PTR; }
#ifdef VENDOR_GALAXYXR
	// Authority is decided ONCE, at OPEN. No admitted epoch (or a caller that is
	// not the Galaxy vrlink module): the original call runs with exact caller
	// params/version/apiVersion, and the returned handle is recorded Pristine so
	// a later admission can never adopt it retroactively.
	const uint64_t openEpoch = gxr::galaxylink::CurrentEpoch();
	const bool vrlinkCaller = gxr::galaxylink::IsVrlinkAddress(_ReturnAddress());
	if(openEpoch == 0 || !vrlinkCaller){
		if(openEpoch != 0){ Defer(DeferredForeignCaller); }
		const NVENCSTATUS pristine = origOpenEncodeSessionEx(params, encoder);
		if(pristine == NV_ENC_SUCCESS && *encoder){ ForgetSessionBookkeeping(*encoder); RecordSession(*encoder, false, 0); }
		return pristine;
	}
#endif
	const bool upgrade = UpgradeWanted() && params->apiVersion == kApi111;
#ifdef VENDOR_GALAXYXR
	if(upgrade){ RegisterPrivateList121(); }
#endif
	const uint32_t sessionApi = upgrade ? kApi121 : params->apiVersion;
	uint32_t savedVer = params->version, savedApi = params->apiVersion;
	if(upgrade){
		params->apiVersion = kApi121;
		if(Is111(params->version)){ params->version = Tag121(1, false); }
	}
	NVENCSTATUS st = origOpenEncodeSessionEx(params, encoder);
	params->version = savedVer; params->apiVersion = savedApi;
	if(st == NV_ENC_SUCCESS){
		// A recycled handle must not inherit a dead session's capability cache,
		// preset config cache, or API version. Only the handle NVENC actually
		// returned is valid; reading *encoder before the call is undefined.
		{
			std::lock_guard<std::mutex> g(capsLock);
			capCache.erase(*encoder);
		}
		{
			std::lock_guard<std::mutex> g(upgradedLock);
			sessionApiVersion.erase(*encoder);
		}
		{
			std::lock_guard<std::mutex> g(presetCacheLock);
			presetCache.erase(*encoder);
		}
#ifdef VENDOR_GALAXYXR
		ForgetSessionBookkeeping(*encoder);
		RecordSession(*encoder, true, openEpoch);
#endif
		// OFF keeps pass-through and performs no capability/identity probes.
		const bool tapEnabled = OpenDecisionConfig().enabled;
		if(tapEnabled){
			// Record the actual session identity and API version before anything
			// else reads the cache. DXGI identity is only available for D3D
			// sessions; other session types remain unknown.
			{
				std::lock_guard<std::mutex> g(capsLock);
				NvencCapabilities& caps = capCache[*encoder];
				caps.adapter.apiVersion = EncodedApiVersion(sessionApi);
				ResolveAdapterIdentity(params, caps.adapter);
			}
			{
				std::lock_guard<std::mutex> g(upgradedLock);
				sessionApiVersion[*encoder] = EncodedApiVersion(sessionApi);
			}
		}
		if(upgrade){
			{ std::lock_guard<std::mutex> g(upgradedLock); upgradedSessions.insert(*encoder); }
			{ std::lock_guard<std::mutex> g(statsLock); stats.sessionUpgrade = 1; }
			// earliest observable boundary of a new encode session: arm the split
			// handshake window here too (silent; the init that follows announces)
			ArmSplitHandshakeWindow(SplitArmOpen, 0.0, false);
			DriverLog("NvencTap: SESSION UPGRADE: nvEncOpenEncodeSessionEx accepted apiVersion 12.1 (encoder %p) — vrlink's 11.1 structs will be re-tagged as 12.1 on every call; splitEncodeMode is now reachable", *encoder);
		}
		return st;
	}
	if(upgrade){
		sessionUpgradeRejected.store(true);
		{ std::lock_guard<std::mutex> g(statsLock); stats.sessionUpgrade = 2; stats.sessionUpgradeStatus = (uint32_t)st; }
		if(openRejectLogged.fetch_add(1) < 1){
			DriverLog("NvencTap: open-time 12.1 session upgrade rejected by NVENC (status %u) — no pristine open and no fallback; explicit settings keep failing visibly until the upgrade is accepted", (unsigned)st);
		}
		PublishFailure(nullptr, OpenDecisionConfig(), st, "NVENC rejected the required API 12.1 session upgrade. No older-API fallback was attempted.");
	}
	return st;
}
NVENCSTATUS NVENCAPI NvencTapShims::DestroyEncoder(void* encoder){
	const NVENCSTATUS status = origDestroyEncoder(encoder);
	if(status != NV_ENC_SUCCESS){ return status; }
	// successful destroy only: resources of the destroyed session (their post-pack
	// cache entries too), then its authority record; a recycled handle is a fresh
	// session decided only by its own OPEN
	EraseSessionResources(encoder);
#ifdef VENDOR_GALAXYXR
	{ std::lock_guard<std::mutex> guard(upgradedLock); sessionRecords.erase(encoder); }
#endif
	{ std::lock_guard<std::mutex> guard(upgradedLock); upgradedSessions.erase(encoder); sessionCodecs.erase(encoder); sessionApiVersion.erase(encoder); }
	{ std::lock_guard<std::mutex> guard(capsLock); capCache.erase(encoder); }
	{ std::lock_guard<std::mutex> guard(presetCacheLock); presetCache.erase(encoder); }
	// a destroyed handle must not leave a stale encode stamp behind: a later
	// session at a recycled handle would read the dead session's gap and arm a
	// phantom reconnect
	if(lastEncodeEncoder.load(std::memory_order_relaxed) == encoder){
		lastEncodeSteadyMs.store(0, std::memory_order_relaxed);
		lastEncodeEncoder.store(nullptr, std::memory_order_relaxed);
	}
	{
		std::lock_guard<std::mutex> guard(runtimeLock);
		firstInitFailures.erase(encoder);
		if(runtimeEncoder == encoder){
			runtimeEncoder = nullptr; runtime.encoder = nullptr; runtime.effectiveCodec = -1;
			runtime.effectiveRateControl = -1; runtime.effectiveSplit = -1; runtime.encodeWidth = 0; runtime.encodeHeight = 0;
			runtime.effectiveTuningInfo.reset(); runtime.effectivePreset.reset();
			runtime.effectiveMultiPass.reset(); runtime.effectiveAverageBitrateMbit.reset();
			runtime.effectiveMaxBitrateMbit.reset(); runtime.effectiveVbvBufferSizeBits.reset();
			runtime.effectiveVbvInitialDelayBits.reset();
			// Keep a rejected request visible until a configuration succeeds.
		}
		if(runtimePictureEncoder == encoder){
			runtimePictureEncoder = nullptr; runtime.lastPictureStatus = 0; runtime.pictureError.clear();
		}
	}
	return status;
}
NVENCSTATUS NVENCAPI NvencTapShims::GetEncodeCaps(void* encoder, GUID encodeGUID, NV_ENC_CAPS_PARAM* params, int* capsVal){
	const Auth auth = AuthorityOf(encoder);
	if(auth == Auth::Pristine){ return origGetEncodeCaps(encoder, encodeGUID, params, capsVal); }
	Retag rt(encoder); if(params && Upgraded(encoder)){ rt.add(&params->version, 1, false); }
	if(auth == Auth::Stale){ return origGetEncodeCaps(encoder, encodeGUID, params, capsVal); }
	NvencTapConfig cfg = NvencTap::Get().GetConfig();
	if(!NvencTap::Get().ConfigPublished()){
		// A caps probe may precede provider publication. Read only this
		// build's config with the shared pre-publish probe: the ConfigLoader
		// parse rules — missing/legacy-typed keys take the loader defaults
		// (nvencTap true, nvencCodec 0, nvencSplitMode 1); an explicitly
		// disabled tap is honored. (The loader's own no-APPDATA ./settings.json
		// fallback is not followed here; the caps shim never read it either.)
		const PrePublishProbe probe = ProbePrePublishConfig();
		cfg.enabled = probe.tap; cfg.codec = probe.codec; cfg.splitMode = probe.splitMode; cfg.effectiveTileWidth = probe.tile; cfg.requestError = probe.requestError;
#ifdef VENDOR_GALAXYXR
		cfg.enforceTile = true;
#endif
	}
	if(cfg.enabled && cfg.enforceTile && params && capsVal
		&& (params->capsToQuery == NV_ENC_CAPS_WIDTH_MAX || params->capsToQuery == NV_ENC_CAPS_HEIGHT_MAX)){
		const std::string phase = std::string("NVENC startup allocation ") + (params->capsToQuery == NV_ENC_CAPS_HEIGHT_MAX ? "height" : "width") + " capability validation: ";
		if(!cfg.requestError.empty()){
			PublishFailure(encoder, cfg, NV_ENC_ERR_INVALID_PARAM, phase + cfg.requestError + " | request: " + RequestDescription(cfg), true);
			return NV_ENC_ERR_INVALID_PARAM;
		}
		// VRLink initializes at its advertised maximum before it picks active
		// packed dimensions. This is the explicitly selected session allocation
		// envelope, validated against real target-codec limits independently.
		const GUID target = cfg.codec == 1 ? NV_ENC_CODEC_H264_GUID : cfg.codec == 2 ? NV_ENC_CODEC_AV1_GUID : encodeGUID;
		int hardwareLimit = 0;
		const NVENCSTATUS status = origGetEncodeCaps(encoder, target, params, &hardwareLimit);
		if(status != NV_ENC_SUCCESS){
			std::string error = phase + "nvEncGetEncodeCaps rejected the real selected-codec limit query (NVENC status " + std::to_string((unsigned)status) + "; real limit unavailable)";
			if(origGetLastErrorString){ const char* detail = origGetLastErrorString(encoder); if(detail && *detail){ error += ": "; error += detail; } }
			PublishFailure(encoder, cfg, status, error + " | request: " + RequestDescription(cfg), true);
			return status;
		}
		const int64_t requested = (int64_t)cfg.effectiveTileWidth * (params->capsToQuery == NV_ENC_CAPS_HEIGHT_MAX ? 4 : 1);
		if(requested <= 0 || requested > hardwareLimit){
			const std::string error = phase + "Requested streamFrame.streamFormatWidth allocation " + std::to_string(requested)
				+ " exceeds the selected codec's real " + (params->capsToQuery == NV_ENC_CAPS_HEIGHT_MAX ? "height" : "width")
				+ " limit " + std::to_string(hardwareLimit) + "; request was not lowered.";
			PublishFailure(encoder, cfg, NV_ENC_ERR_INVALID_PARAM, error + " | request: " + RequestDescription(cfg), true);
			return NV_ENC_ERR_INVALID_PARAM;
		}
		*capsVal = (int)requested;
		static std::atomic<int> allocationLogged[2];
		const int axis = params->capsToQuery == NV_ENC_CAPS_HEIGHT_MAX ? 1 : 0;
		if(allocationLogged[axis].exchange(*capsVal) != *capsVal){ DriverLog("NvencTap: explicit session allocation %s=%d (real selected-codec limit %d, requested tile %d)", axis ? "height" : "width", *capsVal, hardwareLimit, cfg.effectiveTileWidth); }
		return NV_ENC_SUCCESS;
	}
	// Preserve legacy HEVC-facing feature queries. A selected AV1 codec does
	// not make HEVC-only feature probes meaningful for AV1 (e.g. constrained
	// encoding); direct target-codec validation above never recurses here.
	if(cfg.enabled && cfg.codec == 1 && params && capsVal && params->capsToQuery == NV_ENC_CAPS_SUPPORT_10BIT_ENCODE){
		// Profile restriction, not a claim about the GPU: this client path
		// selects H.264 High 8-bit and requires matching input textures.
		if(h264FileSelLogged.fetch_add(1) < 1){ DriverLog("NvencTap: H.264 High 8-bit profile selected; limiting input depth to 8-bit for the client contract (hardware caps otherwise unchanged)"); }
		*capsVal = 0; return NV_ENC_SUCCESS;
	}
	return origGetEncodeCaps(encoder, encodeGUID, params, capsVal);
}
NVENCSTATUS NVENCAPI NvencTapShims::GetEncodeGUIDCount(void* encoder, uint32_t* count){
	return origGetEncodeGUIDCount(encoder, count);
}
NVENCSTATUS NVENCAPI NvencTapShims::GetEncodeGUIDs(void* encoder, GUID* guids, uint32_t guidArraySize, uint32_t* guidCount){
	return origGetEncodeGUIDs(encoder, guids, guidArraySize, guidCount);
}
NVENCSTATUS NVENCAPI NvencTapShims::GetEncodePresetCount(void* encoder, GUID encodeGUID, uint32_t* count){
	return origGetEncodePresetCount(encoder, encodeGUID, count);
}
NVENCSTATUS NVENCAPI NvencTapShims::GetEncodePresetGUIDs(void* encoder, GUID encodeGUID, GUID* presetGuids, uint32_t guidArraySize, uint32_t* guidCount){
	return origGetEncodePresetGUIDs(encoder, encodeGUID, presetGuids, guidArraySize, guidCount);
}
NVENCSTATUS NVENCAPI NvencTapShims::GetEncodePresetConfig(void* encoder, GUID encodeGUID, GUID presetGUID, NV_ENC_PRESET_CONFIG* params){
	Retag rt(encoder); if(params && Upgraded(encoder)){ rt.add(&params->version, 4, true); rt.add(&params->presetCfg.version, 8, true); }
	return origGetPresetConfig(encoder, encodeGUID, presetGUID, params);
}
NVENCSTATUS NVENCAPI NvencTapShims::GetEncodePresetConfigEx(void* encoder, GUID encodeGUID, GUID presetGUID, NV_ENC_TUNING_INFO tuning, NV_ENC_PRESET_CONFIG* params){
	Retag rt(encoder); if(params && Upgraded(encoder)){ rt.add(&params->version, 4, true); rt.add(&params->presetCfg.version, 8, true); }
	return origGetPresetConfigEx(encoder, encodeGUID, presetGUID, tuning, params);
}
NVENCSTATUS NVENCAPI NvencTapShims::CreateInputBuffer(void* encoder, NV_ENC_CREATE_INPUT_BUFFER* params){
	Retag rt(encoder); if(params && Upgraded(encoder)){ rt.add(&params->version, 1, false); }
	return origCreateInputBuffer(encoder, params);
}
NVENCSTATUS NVENCAPI NvencTapShims::CreateBitstreamBuffer(void* encoder, NV_ENC_CREATE_BITSTREAM_BUFFER* params){
	Retag rt(encoder); if(params && Upgraded(encoder)){ rt.add(&params->version, 1, false); }
	return origCreateBitstreamBuffer(encoder, params);
}
NVENCSTATUS NVENCAPI NvencTapShims::CreateMVBuffer(void* encoder, NV_ENC_CREATE_MV_BUFFER* params){
	Retag rt(encoder); if(params && Upgraded(encoder)){ rt.add(&params->version, 1, false); }
	return origCreateMVBuffer(encoder, params);
}
NVENCSTATUS NVENCAPI NvencTapShims::RegisterAsyncEvent(void* encoder, NV_ENC_EVENT_PARAMS* params){
	Retag rt(encoder); if(params && Upgraded(encoder)){ rt.add(&params->version, 1, false); }
	return origRegisterAsyncEvent(encoder, params);
}
NVENCSTATUS NVENCAPI NvencTapShims::UnregisterAsyncEvent(void* encoder, NV_ENC_EVENT_PARAMS* params){
	Retag rt(encoder); if(params && Upgraded(encoder)){ rt.add(&params->version, 1, false); }
	return origUnregisterAsyncEvent(encoder, params);
}
NVENCSTATUS NVENCAPI NvencTapShims::MapInputResource(void* encoder, NV_ENC_MAP_INPUT_RESOURCE* params){
	const Auth auth = AuthorityOf(encoder);
	if(auth == Auth::Pristine){ return origMapInputResource(encoder, params); }
	Retag rt(encoder); if(params && Upgraded(encoder)){ rt.add(&params->version, 4, false); }
	if(!NvencTap::Get().GetConfig().enabled || auth != Auth::Live){
		// Keep ownership while OFF or after the epoch closed (no post-pack): re-enabling must never sharpen an
		// input mapped through an alias while processing was disabled.
		std::lock_guard<std::mutex> g(resLock);
		NVENCSTATUS st = origMapInputResource(encoder, params);
		if(st == NV_ENC_SUCCESS && params && params->mappedResource
			&& registered.count(params->registeredResource)){
			mappedToReg[params->mappedResource] = params->registeredResource;
		}
		return st;
	}
	std::lock_guard<std::mutex> g(resLock);
	// CAS ordering fix (2026-09-25): submit all post-pack D3D writes before
	// NVENC maps the texture; modifying a mapped input is undefined behavior.
	if(params && params->registeredResource){
		void* tex = nullptr; uint32_t fmt = 0;
		if(LookupUnmappedTexture(params->registeredResource, &tex, &fmt)){ NvencPostPack::Process(tex, fmt); }
	}
	NVENCSTATUS st = origMapInputResource(encoder, params);
	if(st == NV_ENC_SUCCESS && params && params->mappedResource){
		mappedToReg[params->mappedResource] = params->registeredResource;
	}
	return st;
}
NVENCSTATUS NVENCAPI NvencTapShims::LockInputBuffer(void* encoder, NV_ENC_LOCK_INPUT_BUFFER* params){
	Retag rt(encoder); if(params && Upgraded(encoder)){ rt.add(&params->version, 1, false); }
	return origLockInputBuffer(encoder, params);
}
NVENCSTATUS NVENCAPI NvencTapShims::GetSequenceParams(void* encoder, NV_ENC_SEQUENCE_PARAM_PAYLOAD* params){
	Retag rt(encoder); if(params && Upgraded(encoder)){ rt.add(&params->version, 1, false); }
	return origGetSequenceParams(encoder, params);
}
NVENCSTATUS NVENCAPI NvencTapShims::RunMotionEstimationOnly(void* encoder, NV_ENC_MEONLY_PARAMS* params){
	Retag rt(encoder); if(params && Upgraded(encoder)){ rt.add(&params->version, 3, false); }
	return origRunMotionEstimationOnly(encoder, params);
}

#ifdef VENDOR_GALAXYXR
namespace {
std::mutex listLock;
bool listCaptured = false; // guarded by listLock: first supported table fixed the originals
struct ListSlot { void** member; void* shim; void** orig; };
// Wrap (or leave entirely pristine) the returned function table. The table
// vrlink caches may be requested before any link is admitted; every forwarder
// checks per-session authority, so wrapping early is safe and a table cached
// before admission works for a later admitted OPEN.
// Capture-once: the first supported table fixes the original pointers; a later
// table that disagrees with them is left untouched as a whole.
void WrapListVendor(NV_ENCODE_API_FUNCTION_LIST* list){
	ListSlot slots[] = {
#define SLOT(member, shim, orig) { reinterpret_cast<void**>(&list->member), reinterpret_cast<void*>(&NvencTapShims::shim), reinterpret_cast<void**>(&orig) }
		SLOT(nvEncInitializeEncoder, InitializeEncoder, origInitializeEncoder),
		SLOT(nvEncReconfigureEncoder, ReconfigureEncoder, origReconfigureEncoder),
		SLOT(nvEncRegisterResource, RegisterResource, origRegisterResource),
		SLOT(nvEncEncodePicture, EncodePicture, origEncodePicture),
		SLOT(nvEncLockBitstream, LockBitstream, origLockBitstream),
		SLOT(nvEncOpenEncodeSessionEx, OpenEncodeSessionEx, origOpenEncodeSessionEx),
		SLOT(nvEncDestroyEncoder, DestroyEncoder, origDestroyEncoder),
		SLOT(nvEncGetEncodeCaps, GetEncodeCaps, origGetEncodeCaps),
		SLOT(nvEncGetEncodeGUIDCount, GetEncodeGUIDCount, origGetEncodeGUIDCount),
		SLOT(nvEncGetEncodeGUIDs, GetEncodeGUIDs, origGetEncodeGUIDs),
		SLOT(nvEncGetEncodePresetCount, GetEncodePresetCount, origGetEncodePresetCount),
		SLOT(nvEncGetEncodePresetGUIDs, GetEncodePresetGUIDs, origGetEncodePresetGUIDs),
		SLOT(nvEncGetEncodePresetConfig, GetEncodePresetConfig, origGetPresetConfig),
		SLOT(nvEncGetEncodePresetConfigEx, GetEncodePresetConfigEx, origGetPresetConfigEx),
		SLOT(nvEncCreateInputBuffer, CreateInputBuffer, origCreateInputBuffer),
		SLOT(nvEncCreateBitstreamBuffer, CreateBitstreamBuffer, origCreateBitstreamBuffer),
		SLOT(nvEncCreateMVBuffer, CreateMVBuffer, origCreateMVBuffer),
		SLOT(nvEncRegisterAsyncEvent, RegisterAsyncEvent, origRegisterAsyncEvent),
		SLOT(nvEncUnregisterAsyncEvent, UnregisterAsyncEvent, origUnregisterAsyncEvent),
		SLOT(nvEncMapInputResource, MapInputResource, origMapInputResource),
		SLOT(nvEncLockInputBuffer, LockInputBuffer, origLockInputBuffer),
		SLOT(nvEncGetSequenceParams, GetSequenceParams, origGetSequenceParams),
		SLOT(nvEncRunMotionEstimationOnly, RunMotionEstimationOnly, origRunMotionEstimationOnly),
		SLOT(nvEncUnregisterResource, UnregisterResource, origUnregisterResource),
		SLOT(nvEncUnmapInputResource, UnmapInputResource, origUnmapInputResource),
#undef SLOT
	};
	// capture-only member: the driver names the exact violated rule
	void** const lastError = reinterpret_cast<void**>(&list->nvEncGetLastErrorString);
	std::lock_guard<std::mutex> guard(listLock);
	if(listCaptured){
		for(const ListSlot& s : slots){
			void* const current = *s.member;
			if(current != s.shim && current != *s.orig){ Defer(DeferredListInconsistent); return; }
		}
		if(*lastError != reinterpret_cast<void*>(origGetLastErrorString)){ Defer(DeferredListInconsistent); return; }
	}else{
		for(const ListSlot& s : slots){
			// a member already holding our shim has no recoverable original
			if(*s.member == s.shim && !*s.orig){ Defer(DeferredListInconsistent); return; }
		}
		for(const ListSlot& s : slots){ if(*s.member && *s.member != s.shim){ *s.orig = *s.member; } }
		origGetLastErrorString = list->nvEncGetLastErrorString;
		listCaptured = true;
	}
	for(const ListSlot& s : slots){ if(*s.orig){ *s.member = s.shim; } }
}
NVENCSTATUS CreateInstanceVendor(NV_ENCODE_API_FUNCTION_LIST* list, const void* caller){
	const PFN_CreateInstance real = reinterpret_cast<PFN_CreateInstance>(realCreateInstance.load(std::memory_order_acquire));
	if(!real){ return NV_ENC_ERR_INVALID_PTR; }
	// Exactly one real call, with the caller's list and version word untouched:
	// negotiation for an unadmitted client (any other Steam Link headset) is
	// never altered, and no speculative extra call is made. The table is wrapped
	// whenever it is a supported vrlink table, independent of the tap toggle and
	// of admission: every forwarder checks per-session authority, so a table
	// cached before admission (or while the tap is OFF) serves a later admitted
	// OPEN. The private 12.1 list registration happens only at that OPEN.
	const NVENCSTATUS status = real(list);
	if(status != NV_ENC_SUCCESS || !list){ return status; }
	if(!gxr::galaxylink::IsVrlinkAddress(caller)){ Defer(DeferredForeignCaller); return status; } // foreign: untouched
	if(!ApiSupported(ApiMajor(list->version))){ Defer(DeferredUnsupportedList); return status; }
	WrapListVendor(list);
	return status;
}
} // namespace
#endif

NVENCSTATUS NVENCAPI NvencTapShims::CreateInstance(NV_ENCODE_API_FUNCTION_LIST* list){
#ifdef VENDOR_GALAXYXR
	return CreateInstanceVendor(list, _ReturnAddress());
#else
	// 2026-10-16: pre-publish, the wrap decision consults the same
	// settings.json probe as the open decisions (OpenDecisionConfig); the
	// published snapshot is authoritative from the first SetConfig on.
	if(!OpenDecisionConfig().enabled){ return origCreateInstance(list); }
	// present the function list as 12.1 when an upgrade is wanted: same
	// size (12.1 only appends pointers into 11.1's reserved tail), and it
	// keeps the runtime's view of this client consistent with the session
	uint32_t listSaved = list ? list->version : 0;
	bool listBumped = false;
	if(list && UpgradeWanted() && Is111(list->version)){ list->version = Tag121(2, false); listBumped = true; }
	NVENCSTATUS status = origCreateInstance(list);
	if(listBumped && status != NV_ENC_SUCCESS){
		if(openRejectLogged.fetch_add(1) < 1){
			DriverLog("NvencTap: open-time 12.1 function-list presentation rejected by NVENC (status %u) — no pristine list and no fallback; explicit settings keep failing visibly until the upgrade is accepted", (unsigned)status);
		}
		list->version = listSaved;
		PublishFailure(nullptr, OpenDecisionConfig(), status, "NVENC rejected the required API 12.1 function list. No older-API fallback was attempted.");
		return status;
	}
	if(status != NV_ENC_SUCCESS || !list){
		DriverLog("NvencTap: NvEncodeAPICreateInstance status=%u (list not wrapped)", (unsigned)status);
		return status;
	}
	uint32_t major = ApiMajor(list->version);
	if(!ApiSupported(major)){
		if(listBumped){ list->version = listSaved; }
		PublishFailure(nullptr, NvencTap::Get().GetConfig(), NV_ENC_ERR_INVALID_VERSION, "Unsupported NVENC function-list version for explicit encoder settings.");
		return NV_ENC_ERR_INVALID_VERSION;
	}
	// wrap by member name. the driver returns the same function pointers
	// for every instance, so the static originals are stable; a re-call on
	// an already-wrapped list is guarded by pointer identity.
#define WRAP(member, shim, orig) \
	if(list->member && list->member != &NvencTapShims::shim){ orig = list->member; list->member = &NvencTapShims::shim; }
	WRAP(nvEncInitializeEncoder, InitializeEncoder, origInitializeEncoder);
	WRAP(nvEncReconfigureEncoder, ReconfigureEncoder, origReconfigureEncoder);
	WRAP(nvEncRegisterResource, RegisterResource, origRegisterResource);
	WRAP(nvEncEncodePicture, EncodePicture, origEncodePicture);
	WRAP(nvEncLockBitstream, LockBitstream, origLockBitstream);
	WRAP(nvEncOpenEncodeSessionEx, OpenEncodeSessionEx, origOpenEncodeSessionEx);
	WRAP(nvEncDestroyEncoder, DestroyEncoder, origDestroyEncoder);
	WRAP(nvEncGetEncodeCaps, GetEncodeCaps, origGetEncodeCaps);
	WRAP(nvEncGetEncodeGUIDCount, GetEncodeGUIDCount, origGetEncodeGUIDCount);
	WRAP(nvEncGetEncodeGUIDs, GetEncodeGUIDs, origGetEncodeGUIDs);
	WRAP(nvEncGetEncodePresetCount, GetEncodePresetCount, origGetEncodePresetCount);
	WRAP(nvEncGetEncodePresetGUIDs, GetEncodePresetGUIDs, origGetEncodePresetGUIDs);
	WRAP(nvEncGetEncodePresetConfig, GetEncodePresetConfig, origGetPresetConfig);
	WRAP(nvEncGetEncodePresetConfigEx, GetEncodePresetConfigEx, origGetPresetConfigEx);
	WRAP(nvEncCreateInputBuffer, CreateInputBuffer, origCreateInputBuffer);
	WRAP(nvEncCreateBitstreamBuffer, CreateBitstreamBuffer, origCreateBitstreamBuffer);
	WRAP(nvEncCreateMVBuffer, CreateMVBuffer, origCreateMVBuffer);
	WRAP(nvEncRegisterAsyncEvent, RegisterAsyncEvent, origRegisterAsyncEvent);
	WRAP(nvEncUnregisterAsyncEvent, UnregisterAsyncEvent, origUnregisterAsyncEvent);
	WRAP(nvEncMapInputResource, MapInputResource, origMapInputResource);
	origGetLastErrorString = list->nvEncGetLastErrorString;   // capture only: the driver names the exact violated rule
	WRAP(nvEncLockInputBuffer, LockInputBuffer, origLockInputBuffer);
	WRAP(nvEncGetSequenceParams, GetSequenceParams, origGetSequenceParams);
	WRAP(nvEncRunMotionEstimationOnly, RunMotionEstimationOnly, origRunMotionEstimationOnly);
	WRAP(nvEncUnregisterResource, UnregisterResource, origUnregisterResource);
	WRAP(nvEncUnmapInputResource, UnmapInputResource, origUnmapInputResource);
#undef WRAP
	if(listBumped){ list->version = listSaved; } // vrlink may compare its own word
	splitRejected.store(false);
	{ std::lock_guard<std::mutex> g(statsLock); stats.apiMajor = major; }
	DriverLog("NvencTap: function list wrapped (API major %u, list version 0x%08x): init/reconfigure/register/encode/lockBitstream", major, list->version);
	return status;
#endif
}

// ---------------------------------------------------------------------------
NvencTap& NvencTap::Get(){
	static NvencTap instance;
	return instance;
}

void NvencTap::SetConfig(const NvencTapConfig &c){
	std::lock_guard<std::mutex> g(cfgLock);
	cfg = c;
	// 2026-10-15: the published snapshot is authoritative for the caps shim
	// from here on; its settings-file fallback is pre-publish only.
	cfgPublished.store(true);
}
NvencTapConfig NvencTap::GetConfig(){
	std::lock_guard<std::mutex> g(cfgLock);
	return cfg;
}
NvencTapRuntimeState NvencTap::GetRuntimeState(){
	std::lock_guard<std::mutex> installationGuard(installationLock);
	const NvencTapConfig config = GetConfig();
	const bool hookInstalled = Installed();
	bool remain; { std::lock_guard<std::mutex> guard(upgradedLock); remain = !upgradedSessions.empty(); }
	std::lock_guard<std::mutex> guard(runtimeLock);
	NvencTapRuntimeState state = runtime;
	state.enabled = config.enabled; state.hookInstalled = hookInstalled; state.upgradedSessionsRemain = remain;
	state.requestedCodec = config.codec;
	return state;
}
BitratePolicyState NvencTap::GetBitratePolicyState(){
	std::lock_guard<std::mutex> g(policyLock);
	return policyState;
}

NvencTapStats NvencTap::GetStats(){
	std::lock_guard<std::mutex> g(statsLock);
	return stats;
}

NvencCapabilities NvencTap::GetCapabilities(void* encoder){
	return GetCapabilitiesForEncoder(encoder);
}

#ifdef VENDOR_GALAXYXR
// ---- vendor: module-local import hooks for the Steam Link GalaxyXR vrlink ----
// Replaces the process-wide MinHook export hook and any DLL pre-load. Two IAT
// families inside driver_vrlink.dll only:
//   * GetProcAddress (loader imports): resolved for NvEncodeAPICreateInstance,
//     answered with our CreateInstance shim bound to the REAL export;
//   * __stdio_common_vsnprintf_s (CRT stdio): the original call always runs
//     first and unchanged, then the formatted text is handed to the Galaxy link
//     epoch observer (handshake / new-session detection).
// Callbacks never log, allocate or touch the caller's arguments; anything
// unexpected is recorded in an atomic bit and reported later from TryInstall.
namespace {
struct GpaTag {}; struct CrtTag {};
using GpaPool = gxr::hooking::HookPool<GpaTag, FARPROC(HMODULE, LPCSTR)>;
using CrtPool = gxr::hooking::HookPool<CrtTag, int(unsigned long long, char*, size_t, size_t, const char*, void*, char*)>;
std::vector<gxr::hooking::PatchRecord> vendorPatches; // guarded by installationLock
bool EndsWithNvenc(const wchar_t* path){
	static const wchar_t kName[] = L"nvEncodeAPI64.dll";
	const size_t length = wcslen(path), name = (sizeof(kName) / sizeof(kName[0])) - 1;
	if(length < name){ return false; }
	if(_wcsicmp(path + length - name, kName) != 0){ return false; }
	return length == name || path[length - name - 1] == L'\\' || path[length - name - 1] == L'/';
}
// The resolved address must live inside the very module the caller queried, and
// that module must be nvEncodeAPI64.dll.
bool ExportBelongsToNvenc(HMODULE queried, FARPROC resolved){
	HMODULE owner = nullptr;
	if(!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
		reinterpret_cast<LPCWSTR>(resolved), &owner) || owner != queried){ return false; }
	wchar_t path[MAX_PATH];
	const DWORD length = GetModuleFileNameW(queried, path, MAX_PATH);
	if(length == 0 || length >= MAX_PATH){ return false; }
	return EndsWithNvenc(path);
}
FARPROC BindCreateInstance(HMODULE queried, FARPROC resolved){
	if(resolved == reinterpret_cast<FARPROC>(&NvencTapShims::CreateInstance)){ return resolved; }
	if(!ExportBelongsToNvenc(queried, resolved)){ Defer(DeferredExportMismatch); return resolved; }
	void* expected = nullptr;
	void* const wanted = reinterpret_cast<void*>(resolved);
	if(!realCreateInstance.compare_exchange_strong(expected, wanted, std::memory_order_acq_rel) && expected != wanted){
		Defer(DeferredExportMismatch); return resolved; // second, different export: unbound
	}
	return reinterpret_cast<FARPROC>(&NvencTapShims::CreateInstance);
}
FARPROC GpaImpl(FARPROC (*next)(HMODULE, LPCSTR), HMODULE module, LPCSTR name){
	const FARPROC result = next(module, name);
	if(!result || !name || (reinterpret_cast<uintptr_t>(name) >> 16) == 0){ return result; } // ordinal
	if(std::strcmp(name, "NvEncodeAPICreateInstance") != 0){ return result; }
	return BindCreateInstance(module, result);
}
int CrtImpl(int (*next)(unsigned long long, char*, size_t, size_t, const char*, void*, char*),
		unsigned long long options, char* buffer, size_t bufferCount, size_t maxCount, const char* format, void* locale, char* args){
	const int written = next(options, buffer, bufferCount, maxCount, format, locale, args);
	if(written >= 0 && buffer && format && bufferCount != 0 && static_cast<size_t>(written) < bufferCount){
		const void* end = std::memchr(buffer, 0, bufferCount);
		if(end){ gxr::galaxylink::ObserveLog(format, buffer, static_cast<size_t>(static_cast<const char*>(end) - buffer)); }
	}
	return written;
}
bool IsLoaderDll(const char* dll){
	return _stricmp(dll, "kernel32.dll") == 0 || _stricmp(dll, "kernelbase.dll") == 0
		|| _strnicmp(dll, "api-ms-win-core-libraryloader-", 30) == 0;
}
bool IsCrtStdioDll(const char* dll){
	return _stricmp(dll, "ucrtbase.dll") == 0 || _strnicmp(dll, "api-ms-win-crt-stdio-", 21) == 0;
}
bool MatchGetProcAddress(const char* dll, const char* name){ return std::strcmp(name, "GetProcAddress") == 0 && IsLoaderDll(dll); }
bool MatchCrtFormat(const char* dll, const char* name){ return std::strcmp(name, "__stdio_common_vsnprintf_s") == 0 && IsCrtStdioDll(dll); }
} // namespace

void NvencTap::FlushDeferredDiagnostics(){
	const uint32_t pending = deferredPending.exchange(0, std::memory_order_relaxed);
	if(!pending){ return; }
	struct Note { uint32_t bit; const char* text; };
	static const Note notes[] = {
		{ DeferredExportMismatch, "NvEncodeAPICreateInstance export did not belong to the exact nvEncodeAPI64.dll module (or a second distinct export appeared); left unbound and unwrapped" },
		{ DeferredUnsupportedList, "NVENC function list has an unsupported API major version; whole table left pristine" },
		{ DeferredListInconsistent, "a later NVENC function table disagreed with the originals captured first; whole table left pristine" },
		{ DeferredOrphanReused, "an NVENC session handle was reused while its previous session record still existed (orphaned session); records dropped, new session decided by its own OPEN" },
		{ DeferredPrivateListRejected, "NVENC rejected the private 12.1 function-list registration; the caller's list was unaffected, a required 12.1 session open will report its own status" },
		{ DeferredStalePolicyCall, "a session from a closed link epoch is still making policy-bearing calls (init/reconfigure/encode); only ABI adaptation and cleanup are applied, no settings, no failure" },
		{ DeferredForeignCaller, "an NVENC call from a module that is not the Galaxy vrlink module reached the tap; passed through untouched" },
	};
	for(const Note& n : notes){
		if(!(pending & n.bit)){ continue; }
		if(deferredLogged.fetch_or(n.bit, std::memory_order_relaxed) & n.bit){ continue; }
		DriverLog("NvencTap: %s", n.text);
	}
}

void NvencTap::Cleanup(){
	std::lock_guard<std::mutex> installationGuard(installationLock);
	GpaPool::SetActive(false);
	CrtPool::SetActive(false);
	const size_t total = vendorPatches.size();
	const size_t restored = gxr::hooking::RestorePatches(vendorPatches);
	const bool was = installed.exchange(false);
	if(was){ DriverLog("NvencTap: module-local import hooks cleaned up (%zu of %zu slots restored; thunks remain as passthrough)", restored, total); }
}

void NvencTap::TryInstall(){
	FlushDeferredDiagnostics();
	std::lock_guard<std::mutex> installationGuard(installationLock);
	// Installed independently of the NVENC tap toggle: the CRT observer feeds
	// the Galaxy link epoch (identity/frame/settings admission). Only per-session
	// encoder policy depends on the toggle. Not throttled: the module lookup is
	// cheap, a miss records nothing, and an image that fails validation is
	// remembered (vendorFailedModule), so a vrlink that loads right after an
	// early miss is patched by the very next call.
	if(installed.load(std::memory_order_relaxed) || failedPermanently.load(std::memory_order_relaxed)){ return; }
	HMODULE vrlink = GetModuleHandleW(L"driver_vrlink.dll");
	if(!vrlink){ return; } // not loaded yet: retry on the next call
	if(vendorFailedModule == reinterpret_cast<void*>(vrlink)){ return; }
	const auto gpa = gxr::hooking::ScanImports(vrlink, &MatchGetProcAddress);
	const auto crt = gxr::hooking::ScanImports(vrlink, &MatchCrtFormat);
	if(gpa.status != gxr::hooking::ScanStatus::Ok || crt.status != gxr::hooking::ScanStatus::Ok){
		vendorFailedModule = reinterpret_cast<void*>(vrlink);
		DriverLog("NvencTap: driver_vrlink.dll imports not recognised (GetProcAddress slots %zu, CRT vsnprintf_s slots %zu) — failing closed: no hook installed, NVENC left untouched", gpa.slots.size(), crt.slots.size());
		return;
	}
	if(!gxr::hooking::PinModuleContaining(reinterpret_cast<const void*>(&GpaImpl))){
		vendorFailedModule = reinterpret_cast<void*>(vrlink);
		DriverLog("NvencTap: could not pin this driver module — failing closed: no hook installed");
		return;
	}
	GpaPool::SetImpl(&GpaImpl);
	CrtPool::SetImpl(&CrtImpl);
	std::vector<gxr::hooking::PatchRecord> records;
	if(!gxr::hooking::PatchWithPool<GpaPool>(gpa.slots, records) || !gxr::hooking::PatchWithPool<CrtPool>(crt.slots, records)){
		gxr::hooking::RestorePatches(records);
		vendorFailedModule = reinterpret_cast<void*>(vrlink);
		DriverLog("NvencTap: module-local import patch failed (pool exhausted or slot changed concurrently) — rolled back, NVENC left untouched");
		return;
	}
	GpaPool::SetActive(true);
	CrtPool::SetActive(true);
	vendorPatches.insert(vendorPatches.end(), records.begin(), records.end());
	installed.store(true);
	DriverLog("NvencTap: installed module-local import hooks in driver_vrlink.dll (GetProcAddress x%zu, CRT vsnprintf_s x%zu); no process-wide NVENC hook and no DLL pre-load", gpa.slots.size(), crt.slots.size());
}
#else
void NvencTap::FlushDeferredDiagnostics(){}
void NvencTap::Cleanup(){}

void NvencTap::TryInstall(){
	std::lock_guard<std::mutex> installationGuard(installationLock);
	if(!GetConfig().enabled){ return; }
	if(installed.load(std::memory_order_relaxed) || failedPermanently.load(std::memory_order_relaxed)){ return; }
	double now = NowSecondsNv();
	if(now - lastAttempt < 1.0){ return; }
	lastAttempt = now;
	// pre-load the API DLL ourselves so the hook is in place before vrlink
	// (same process) loads it and calls CreateInstance at headset connect.
	// the handle is intentionally leaked: it must outlive the hook.
	HMODULE nv = GetModuleHandleA("nvEncodeAPI64.dll");
	if(!nv){ nv = LoadLibraryA("nvEncodeAPI64.dll"); }
	if(!nv){
		// no NVIDIA driver on this machine (AMD path uses AMF); retry a few
		// times in case the system DLL search is slow, then give up quietly
		static int misses = 0;
		if(++misses > 10){ failedPermanently.store(true); DriverLog("NvencTap: nvEncodeAPI64.dll not loadable — NVENC not present, tap idle"); }
		return;
	}
	void* target = (void*)GetProcAddress(nv, "NvEncodeAPICreateInstance");
	if(!target){
		failedPermanently.store(true);
		DriverLog("NvencTap: NvEncodeAPICreateInstance export not found — tap unavailable");
		return;
	}
	// MinHook may or may not have been initialised by another module yet
	MH_STATUS mi = MH_Initialize();
	if(mi != MH_OK && mi != MH_ERROR_ALREADY_INITIALIZED){
		failedPermanently.store(true);
		DriverLog("NvencTap: MH_Initialize failed (%d)", (int)mi);
		return;
	}
	MH_STATUS mh = MH_CreateHook(target, (void*)&NvencTapShims::CreateInstance, (void**)&origCreateInstance);
	if(mh != MH_OK && mh != MH_ERROR_ALREADY_CREATED){
		failedPermanently.store(true);
		DriverLog("NvencTap: MH_CreateHook failed (%d)", (int)mh);
		return;
	}
	if(MH_EnableHook(target) != MH_OK){
		failedPermanently.store(true);
		DriverLog("NvencTap: MH_EnableHook failed");
		return;
	}
	installed.store(true);
	DriverLog("NvencTap: installed on NvEncodeAPICreateInstance (nvEncodeAPI64.dll pre-loaded by us; encoders created from now on are wrapped)");
}
#endif

void NvencTap::MaybeHeartbeat(){
	FlushDeferredDiagnostics();
	if(!GetConfig().enabled){ return; }
	double now = NowSecondsNv();
	if(now - lastHeartbeat < 10.0){ return; }
	lastHeartbeat = now;
	NvencTapStats s = GetStats();
	NvencTapConfig c = GetConfig();
	if(!installed.load() || (s.initCalls == 0 && s.reconfCalls == 0)){ return; }
	const long long hbLock = lockCalls.load();
	const uint32_t hbLockLast = lockLastSize.load();
	const long long hbEncFail = encFails.load();
	const uint32_t hbLastEncFailStatus = lastEncFailStatus.load();
	char errCopy[96];
	{ std::lock_guard<std::mutex> g(statsLock); snprintf(errCopy, sizeof(errCopy), "%s", lastEncFailStr); }
	DriverLog("NvencTap: heartbeat api=%u enabled=%d %ux%u avg=%.0fM max=%.0fM level=%u tier=%u cfgOutBits=%u(0=unstated) inBf=0x%x | init %u (ovr %u, ovrFail->ok %u, fail %u) | reconf %u (ovr %u, ovrFail->ok %u, fail %u, stockFail %u) | register %u encode %u lock %lld (last %u bytes) encFail %lld | lastEncFail %u \"%s\"",
		s.apiMajor, (int)c.enabled, s.lastWidth, s.lastHeight, s.lastAvgBitrate / 1e6, s.lastMaxBitrate / 1e6, s.lastLevel, s.lastTier, s.lastBitDepth, s.lastInputBufferFormat,
		s.initCalls, s.initOverridden, s.initFailedThenPristineOk, s.initFailed,
		s.reconfCalls, s.reconfOverridden, s.reconfFailedThenPristineOk, s.reconfFailed, s.reconfFailedStock,
		s.registerCalls, s.encodeCalls, hbLock, hbLockLast, hbEncFail, hbLastEncFailStatus, errCopy);
	if(lastMapInSize.load() != 0xFFFFFFFFu){
		DriverLog("NvencTap: delta map heartbeat: sel=%d in=%u use=%u sess=%d", (int)lastMapSel.load(), lastMapInSize.load(), lastMapUseSize.load(), (int)lastSessCodec.load());
	}
	if(s.presetFetchOk || s.presetFetchFail){
		DriverLog("NvencTap: preset merge: fetch ok %u fail %u (cfgVer 0x%08x)", s.presetFetchOk, s.presetFetchFail, s.presetCfgVerUsed);
	}
	{
		NvencPostPackStats pp = NvencPostPack::GetStats();
		if(pp.frames || pp.skipped || pp.disabled){
			DriverLog("NvencPostPack: last 10s: processed %u skipped %u | pass mean=%.3fms max=%.3fms%s", pp.frames, pp.skipped,
				pp.frames ? pp.sumMs / pp.frames : 0.0, pp.maxMs, pp.disabled ? " | DISABLED (see earlier line)" : "");
			NvencPostPack::ResetIntervalStats();
		}
	}
	if(QpMapWanted(c)){
		DriverLog("NvencTap: foveated QP: fovea %d periphery %d, %u frames with map", c.qpFovea, c.qpPeriphery, s.qpMapFrames);
	}
	if(c.splitMode > 0 || s.splitState || s.sessionUpgrade){
		DriverLog("NvencTap: split-frame: mode %d state %s applied %u (status %u) engines=%u | session upgrade %s (status %u) retagged calls %u", c.splitMode,
			s.splitState == 1 ? "ACCEPTED" : s.splitState == 2 ? "REJECTED" : "untried", s.splitApplied, s.splitStatus, s.numEncoderEngines,
			s.sessionUpgrade == 1 ? "12.1 LIVE" : s.sessionUpgrade == 2 ? "REJECTED" : "not attempted", s.sessionUpgradeStatus, s.retagCalls);
	}
	if(s.ivReqCount || s.ivLatSamples){
		uint32_t shimCount = 0; double shimGapMaxMs = 0;
		FrameShimCadenceSnapshot(&shimCount, &shimGapMaxMs);
		DriverLog("NvencTap: last 10s: vrlink asked avg=%.0fM min=%.0fM max=%.0fM (n=%u) | submit->lock mean=%.2fms max=%.1fms over-11.1ms=%u/%u (%.0f%%) | SUBMIT BLOCKED mean=%.2fms max=%.1fms over-10ms=%u/%u (vrlink watchdog resets on >10) | shim n=%u gap max=%.0fms | inflight max=%u",
			s.ivReqCount ? s.ivReqSumMbit / s.ivReqCount : 0.0, s.ivReqCount ? s.ivReqMinMbit : 0.0, s.ivReqMaxMbit, s.ivReqCount,
			s.ivLatSamples ? s.ivLatSumMs / s.ivLatSamples : 0.0, s.ivLatMaxMs, s.ivLatOver11, s.ivLatSamples,
			s.ivLatSamples ? 100.0 * s.ivLatOver11 / s.ivLatSamples : 0.0,
			s.ivSubmitSamples ? s.ivSubmitSumMs / s.ivSubmitSamples : 0.0, s.ivSubmitMaxMs, s.ivSubmitOver10, s.ivSubmitSamples,
			shimCount, shimGapMaxMs, s.ivInflightMax);
		std::lock_guard<std::mutex> g(statsLock);
		stats.ivReqCount = 0; stats.ivReqSumMbit = 0; stats.ivReqMinMbit = 1e9; stats.ivReqMaxMbit = 0;
		stats.ivLatSamples = 0; stats.ivLatOver11 = 0; stats.ivLatSumMs = 0; stats.ivLatMaxMs = 0;
		stats.ivSubmitSamples = 0; stats.ivSubmitOver10 = 0; stats.ivSubmitSumMs = 0; stats.ivSubmitMaxMs = 0;
		stats.ivInflightMax = stats.inflight;
	}
	if(s.lockCalls){
		DriverLog("NvencTap: frames %u avg=%.0fKB max=%.2fMB maxIDR=%.2fMB idr=%u avgQP=%u(max %u) | size buckets <256K:%u <512K:%u <1M:%u <1.5M:%u <2M:%u <4M:%u >=4M:%u",
			s.lockCalls, s.sumFrameBytes / (double)s.lockCalls / 1024.0, s.maxFrameBytes / 1048576.0, s.maxFrameBytesIdr / 1048576.0, s.idrFrames,
			s.lastAvgQp, s.maxAvgQp, s.sizeBucket[0], s.sizeBucket[1], s.sizeBucket[2], s.sizeBucket[3], s.sizeBucket[4], s.sizeBucket[5], s.sizeBucket[6]);
	}
	if(s.latSamples){
		DriverLog("NvencTap: encode latency n=%u mean=%.2fms max=%.1fms | <5:%u <8:%u <11:%u(frame@90) <16:%u <33:%u >=33:%u",
			s.latSamples, s.latSumMs / s.latSamples, s.latMaxMs,
			s.latBucket[0], s.latBucket[1], s.latBucket[2], s.latBucket[3], s.latBucket[4], s.latBucket[5]);
	}
}
