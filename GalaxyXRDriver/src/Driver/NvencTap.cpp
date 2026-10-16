#define NOMINMAX
#include "NvencTap.h"
#include "NvencPostPack.h"
#include "DriverLog.h"
#include "../../../ThirdParty/minhook/include/MinHook.h"
#include "../../../ThirdParty/nvenc/nvEncodeAPI.h"
#include "../Config/Config.h"
#include <chrono>
#include <set>
#include <map>
#include <vector>
#include <cmath>
#include <cstddef>
#include <cstdio>
#include <cstring>
#include <algorithm>
#include <limits>
#include <fstream>
#include <sstream>
#include "../../../ThirdParty/json/single_include/nlohmann/json.hpp"

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
struct RegInfo { void* texture; uint32_t fmt; uint32_t type; };
std::map<void*, RegInfo> registered;   // NV_ENC_REGISTERED_PTR -> texture
std::map<void*, void*> mappedToReg;    // NV_ENC_INPUT_PTR (mapped) -> NV_ENC_REGISTERED_PTR
// ---- foveated QP delta map ----
// one signed byte per block, row-major on the codec's own grid (HEVC 32x32
// CTB, H.264 16x16 MB, AV1 64x64 SB - nvEncodeAPI.h qpDeltaMapSize), rebuilt
// when the frame size, the codec or the deltas change. the frame is N stacked
// square tiles of width w; fovea tiles are the even (or odd) ones.
std::mutex qpLock;
std::vector<int8_t> qpMap;
uint32_t qpMapW = 0, qpMapH = 0; int qpMapFov = 0, qpMapPer = 0, qpMapCodec = -1; float qpMapFall = -1; bool qpMapTop = true;
const int8_t* GetQpMap(uint32_t w, uint32_t h, int codec, const NvencTapConfig &cfg, uint32_t* size){
	std::lock_guard<std::mutex> g(qpLock);
	if(w != qpMapW || h != qpMapH || codec != qpMapCodec || cfg.qpFovea != qpMapFov || cfg.qpPeriphery != qpMapPer || cfg.qpEdgeFalloff != qpMapFall || cfg.qpFoveaTop != qpMapTop){
		qpMapW = w; qpMapH = h; qpMapCodec = codec; qpMapFov = cfg.qpFovea; qpMapPer = cfg.qpPeriphery; qpMapFall = cfg.qpEdgeFalloff; qpMapTop = cfg.qpFoveaTop;
		const uint32_t bs = (codec == 1) ? 16u : (codec == 2) ? 64u : 32u;
		const uint32_t bw = (w + bs - 1) / bs, bh = (h + bs - 1) / bs;
		qpMap.assign((size_t)bw * bh, 0);
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
				qpMap[(size_t)by * bw + bx] = (int8_t)std::lround(v);
			}
		}
		DriverLog("NvencTap: QP delta map rebuilt %ux%u blocks (fovea %d, periphery %d, ramp %.2f) bs=%u", bw, bh, cfg.qpFovea, cfg.qpPeriphery, cfg.qpEdgeFalloff, bs);
	}
	*size = (uint32_t)qpMap.size();
	return qpMap.data();
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
std::mutex deltaMapLock;
std::vector<int8_t> deltaMap;
std::atomic<int> deltaMapDropLogged{0};
struct MapOverride { bool set = false; const int8_t* p = nullptr; uint32_t n = 0; };
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
	std::lock_guard<std::mutex> g(deltaMapLock);
	deltaMap.assign((size_t)entries, 0);
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
	ov.set = true; ov.p = deltaMap.data(); ov.n = entries;
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

std::mutex statsLock;
NvencTapStats stats;
std::mutex runtimeLock;
NvencTapRuntimeState runtime;
void* runtimeEncoder = nullptr;
void* runtimePictureEncoder = nullptr;
std::string acceptedRequest;
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
		<< " bitrate=" << c.bitrateMbit << '/' << c.bitrateScale << '/' << c.vrlinkClampMbit << '/' << c.maxBitrateHeadroomPct
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
void PublishFailure(void* encoder, const NvencTapConfig& cfg, NVENCSTATUS status, const std::string& error){
	std::lock_guard<std::mutex> guard(runtimeLock);
	if(runtime.lastStatus != (uint32_t)status || runtime.error != error || runtime.requestedCodec != cfg.codec){
		DriverLog("NvencTap: requested codec=%d FAILED status=%u: %s", cfg.codec, (unsigned)status, error.c_str());
	}
	if(runtimeEncoder != encoder){
		runtime.effectiveCodec = -1; runtime.effectiveRateControl = -1;
		runtime.effectiveSplit = -1; runtime.encodeWidth = 0; runtime.encodeHeight = 0;
	}
	runtimeEncoder = encoder; runtime.requestedCodec = cfg.codec;
	runtime.lastStatus = (uint32_t)status; runtime.error = error;
}
void PublishSuccess(void* encoder, const NvencTapConfig& cfg, const NV_ENC_INITIALIZE_PARAMS* p){
	std::lock_guard<std::mutex> guard(runtimeLock);
	const std::string description = RequestDescription(cfg);
	if(acceptedRequest != description){
		if(cfg.enabled){ DriverLog("NvencTap: accepted settings: %s", description.c_str()); }
		acceptedRequest = description;
	}
	const int codec = memcmp(&p->encodeGUID, &NV_ENC_CODEC_H264_GUID, sizeof(GUID)) == 0 ? 1
		: memcmp(&p->encodeGUID, &NV_ENC_CODEC_AV1_GUID, sizeof(GUID)) == 0 ? 2
		: memcmp(&p->encodeGUID, &NV_ENC_CODEC_HEVC_GUID, sizeof(GUID)) == 0 ? 0 : -1;
	const int rc = p->encodeConfig ? (int)p->encodeConfig->rcParams.rateControlMode : -1;
	if(cfg.enabled && (runtime.lastStatus || !runtime.error.empty() || runtimeEncoder != encoder || runtime.effectiveCodec != codec
		|| runtime.effectiveRateControl != rc
		|| runtime.encodeWidth != p->encodeWidth || runtime.encodeHeight != p->encodeHeight)){
		DriverLog("NvencTap: applied requested codec=%d effective codec=%d RC=%d size=%ux%u", cfg.codec, codec, rc, p->encodeWidth, p->encodeHeight);
	}
	runtimeEncoder = encoder; runtime.requestedCodec = cfg.codec; runtime.effectiveCodec = codec;
	runtime.lastStatus = NV_ENC_SUCCESS; runtime.error.clear();
	runtime.effectiveRateControl = rc; runtime.encodeWidth = p->encodeWidth; runtime.encodeHeight = p->encodeHeight;
	runtime.effectiveSplit = codec == 1 ? -1 : ((p->version & 0xFFFFu) >= 12 ? (int)p->splitEncodeMode : -1);
}
// ---- session upgrade state ----
std::mutex upgradedLock;
std::set<void*> upgradedSessions;         // encoder handles opened as 12.1
std::atomic<bool> sessionUpgradeRejected{false};
std::atomic<int> sessionNoteLogged{0};
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
// true, nvencCodec 0, nvencSplitMode 1) and a legacy-typed (wrong-type)
// value is ignored exactly like the loader ignores it. An unreadable or
// malformed file leaves every default in place. Only explicit typed values
// win; nothing here substitutes settings.
struct PrePublishProbe { bool tap = true; int codec = 0; int splitMode = 1; };
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
	if(!json.is_object() || !json.contains("streamFrame") || !json["streamFrame"].is_object()){ return probe; }
	const auto& frame = json["streamFrame"];
	// nvencTap: boolean only; absent or legacy-typed -> the loader default (true)
	if(frame.contains("nvencTap") && frame["nvencTap"].is_boolean()){ probe.tap = frame["nvencTap"].get<bool>(); }
	// nvencCodec / nvencSplitMode: the loader accepts any number; invalid
	// values keep failing visibly at publish time, never silently
	if(frame.contains("nvencCodec") && frame["nvencCodec"].is_number()){ probe.codec = frame["nvencCodec"].get<int>(); }
	if(frame.contains("nvencSplitMode") && frame["nvencSplitMode"].is_number()){ probe.splitMode = frame["nvencSplitMode"].get<int>(); }
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
inline bool Is111(uint32_t v){ return (v & 0xFFFFu) == 11u; }
inline uint32_t Tag121(uint32_t digit, bool b31){ return kApi121 | (digit << 16) | (0x7u << 28) | (b31 ? (1u << 31) : 0u); }
// re-tag one version word for the duration of a call; restores on scope exit
struct Retag {
	uint32_t* slot[6]; uint32_t old[6]; int n = 0;
	void add(uint32_t* p, uint32_t digit, bool b31){
		if(!p || n >= 6 || !Is111(*p)){ return; }
		slot[n] = p; old[n] = *p; *p = Tag121(digit, b31); n++;
	}
	~Retag(){ for(int i = n - 1; i >= 0; i--){ *slot[i] = old[i]; } if(n && NvencTap::Get().GetConfig().enabled){ std::lock_guard<std::mutex> g(statsLock); stats.retagCalls++; } }
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
std::map<void*, int> sessionCodecs;   // guarded by upgradedLock
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
	// 2026-10-16: the maxEncode clamp snapshot fields are retired.
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
struct PresetCache {
	bool valid = false;
	int preset = 0;
	NV_ENC_TUNING_INFO tuning = NV_ENC_TUNING_INFO_UNDEFINED;
	GUID codec{};
	NV_ENC_PRESET_CONFIG pc{};
} presetCache;
std::atomic<int> presetDiffLogged{0};
std::atomic<int> presetFetchFailLogged{0};
std::atomic<int> presetAutoLogged{0};
std::atomic<int> presetAutoH264Logged{0};

const NV_ENC_PRESET_CONFIG* FetchPresetConfig(void* encoder, const NV_ENC_INITIALIZE_PARAMS* p, const NV_ENC_CONFIG* callerCfg, int preset){
	const GUID* pg = PresetGuid(preset);
	if(!pg || !origGetPresetConfigEx || !encoder || ApiMajor(p->version) < 10){ return nullptr; }
	{
		std::lock_guard<std::mutex> g(presetCacheLock);
		if(presetCache.valid && presetCache.preset == preset && presetCache.tuning == p->tuningInfo
				&& memcmp(&presetCache.codec, &p->encodeGUID, sizeof(GUID)) == 0){
			return &presetCache.pc;
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
			presetCache.valid = true; presetCache.preset = preset; presetCache.tuning = p->tuningInfo;
			presetCache.codec = p->encodeGUID; presetCache.pc = pc;
			{ std::lock_guard<std::mutex> s(statsLock); stats.presetFetchOk++; stats.presetCfgVerUsed = pc.version; }
			return &presetCache.pc;
		}
		if(st != NV_ENC_ERR_INVALID_VERSION && f == 0){
			// non-version failure: the other flavours will not do better
			if(presetFetchFailLogged.fetch_add(1) < 3){
				DriverLog("NvencTap: nvEncGetEncodePresetConfigEx(P%d, tuning %u) failed (%u) — preset merge unavailable, GUID swap only", preset, (unsigned)p->tuningInfo, (unsigned)st);
			}
			std::lock_guard<std::mutex> s(statsLock); stats.presetFetchFail++;
			return nullptr;
		}
	}
	if(presetFetchFailLogged.fetch_add(1) < 3){
		DriverLog("NvencTap: nvEncGetEncodePresetConfigEx(P%d) rejected all struct-version flavours (caller api bits 0x%08x, vendored 0x%08x) — preset merge unavailable", preset, callerApi, (unsigned)NV_ENC_PRESET_CONFIG_VER);
	}
	std::lock_guard<std::mutex> s(statsLock); stats.presetFetchFail++;
	return nullptr;
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
		if(p->tuningInfo == NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY){
			// the Application Note lists AV1 combos only at LL/HQ; ULL has
			// no headroom for a 3200x8192@90 frame on 3 engines.
			p->tuningInfo = NV_ENC_TUNING_INFO_LOW_LATENCY;
			w += snprintf(w, WhatRem(w, what, whatLen), "tuning ULL->LL; ");
		}
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
	// 2026-10-16 no-silent-settings: the maxEncodeWidth/Height clamp paired
	// with the old 1024/4096 caps answers is gone; the caller's derived
	// bounds pass through, backed by actual selected-codec caps.
	return true;
}

// returns true if anything was changed
bool ApplyOverrides(void* encoder, NV_ENC_INITIALIZE_PARAMS* p, const NvencTapConfig &cfg, Snapshot &snap, char* what, size_t whatLen){
	snap = Snapshot{};
	what[0] = 0;
	NV_ENC_CONFIG* c = p->encodeConfig;
	if(!c){ return false; }
	if(!ApiSupported(ApiMajor(p->version)) || !ApiSupported(ApiMajor(c->version))){ return false; }
	snap.valid = true; snap.initPtr = p; snap.cfgPtr = c; snap.rc = c->rcParams; snap.preset = p->presetGUID; snap.hevc = IsHevc(p->encodeGUID);
	snap.fpsNum = p->frameRateNum; snap.fpsDen = p->frameRateDen;
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
			if(const NV_ENC_PRESET_CONFIG* pcp = FetchPresetConfig(encoder, p, c, presetWanted)){
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
				if(snap.codecSwapped){
					// Seed the swapped codec's config window from NVENC's own
					// canonical preset config for [target codec, preset,
					// tuning] — valid by construction, so every hand-built
					// field risk in the window disappears. The intentional
					// deltas are re-applied immediately after.
					memcpy(&c->encodeCodecConfig, &pcc.encodeCodecConfig, Snapshot::kCodecWindow);
					ApplyCodecFields(c, p, snap.codecTarget, w, whatLen, what);
					w += snprintf(w, WhatRem(w, what, whatLen), "seeded P%d@tuning%u; ", presetWanted, (unsigned)p->tuningInfo);
					changed = true;
				}
				if(cfg.multiPass < 0 && cfg.codec == 1){
					// 2026-10-15: H.264 runs pinned to multiPass=0 (single-pass). The canonical P2/P7@ULL reports 1, which wedged the first encode on 2026-10-15; SteamFrame's verified H.264 profile is single-pass as well.
					if(rc.multiPass != 0){ w += snprintf(w, WhatRem(w, what, whatLen), "multipass %u->0 [h264]; ", (unsigned)rc.multiPass); rc.multiPass = (NV_ENC_MULTI_PASS)0; changed = true; }
				}else if(cfg.multiPass < 0 && rc.multiPass != prc.multiPass){
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
					DriverLog("NvencTap: preset merge unavailable, GUID swap only (streamFrame.nvencPresetMerge fetch failed)");
				}
				return changed;
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
	// The forced split bits must survive a codec swap: every tap-enabled
	// session carries them (they are what lets the 3200x8192 stream frame
	// encode split across the NVENC engines — the AUTO-selected P7 preset
	// disqualifies the driver's implicit split, which vrlink's own P1..P4
	// preset would have gotten). Gating this branch on snap.hevc made swapped
	// sessions silently drop them, and NVENC then rejected the whole init
	// with INVALID_PARAM — the 2026-10-13 H.264/AV1 wedges (status 8 on both
	// attempts, the pristine retry included).
	// H.264 is excluded (splitEncodeMode is not applicable to H264): codec==1 skips this branch.
	if(cfg.splitMode > 0 && !IsH264(p->encodeGUID)){
		uint32_t mode = (uint32_t)cfg.splitMode;
		if(ApiMajor(p->version) == 11){
			// not upgraded: the session was opened before the tap hooked
			// it, or the 12.1 open was rejected. U0 proved in-place struct
			// bumps are refused (INVALID_VERSION), so nothing to try here.
			if(sessionNoteLogged.fetch_add(1) < 1){
				DriverLog("NvencTap: split-frame: session is 11.1 (not upgraded) — splitEncodeMode unavailable on this encoder");
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
		int64_t target = cfg.bitrateMbit * 1000000ll;
		if(cfg.bitrateScale && cfg.vrlinkClampMbit > 0 && rc.averageBitRate > 0){
			// scale vrlink's request: its clamp maps to our target, a
			// backoff below the clamp stays a proportional backoff
			target = (int64_t)((double)rc.averageBitRate * (double)cfg.bitrateMbit / (double)cfg.vrlinkClampMbit);
			target = (std::min<int64_t>)(target, cfg.bitrateMbit * 1000000ll);
		}
		uint32_t avg = (uint32_t)target;
		double head = 1.0 + cfg.maxBitrateHeadroomPct / 100.0;
		uint32_t mx = (uint32_t)(avg * head);
		if(rc.averageBitRate != avg || rc.maxBitRate != mx){
			double ratio = rc.averageBitRate ? (double)avg / rc.averageBitRate : 1.0;
			w += snprintf(w, WhatRem(w, what, whatLen), "avg %.0fM->%.0fM max %.0fM->%.0fM; ", rc.averageBitRate / 1e6, avg / 1e6, rc.maxBitRate / 1e6, mx / 1e6);
			rc.averageBitRate = avg;
			rc.maxBitRate = mx;
			if(rc.vbvBufferSize){ rc.vbvBufferSize = (uint32_t)(rc.vbvBufferSize * ratio); }
			changed = true;
		}
	}
	if(QpMapWanted(cfg) && c->rcParams.qpMapMode != NV_ENC_QP_MAP_DELTA){
		w += snprintf(w, WhatRem(w, what, whatLen), "qpMap %u->DELTA; ", (unsigned)c->rcParams.qpMapMode);
		c->rcParams.qpMapMode = NV_ENC_QP_MAP_DELTA; changed = true;
	}
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
	if(cfg.forceCbr){
		NV_ENC_RC_PARAMS &rc = c->rcParams;
		uint8_t kf = (uint8_t)cfg.lowDelayKfScale;
		if(rc.rateControlMode != NV_ENC_PARAMS_RC_CBR || rc.lowDelayKeyFrameScale != kf || rc.maxBitRate != rc.averageBitRate){
			w += snprintf(w, WhatRem(w, what, whatLen), "rc %s->CBR lowDelayKF %u->%u; ", RcName(rc.rateControlMode), rc.lowDelayKeyFrameScale, (unsigned)kf);
			rc.rateControlMode = NV_ENC_PARAMS_RC_CBR; rc.lowDelayKeyFrameScale = kf;
			if(rc.maxBitRate != rc.averageBitRate){ rc.maxBitRate = rc.averageBitRate; }
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
			stats.lastBitDepth = (uint32_t)p->encodeConfig->encodeCodecConfig.hevcConfig.outputBitDepth;
		}
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
std::string ValidateRequest(const NvencTapConfig& cfg, const NV_ENC_INITIALIZE_PARAMS* p){
	if(!cfg.enabled){ return {}; }
	if(!cfg.requestError.empty()){ return cfg.requestError; }
	if(cfg.effectiveTileWidth <= 0 || (uint64_t)cfg.effectiveTileWidth * 4u > (std::numeric_limits<uint32_t>::max)()){
		return "streamFrame.streamFormatWidth must be positive and its four-tile height must fit the NVENC uint32 dimension.";
	}
	if(cfg.enforceTile && p && (p->encodeWidth != (uint32_t)cfg.effectiveTileWidth || p->encodeHeight != (uint32_t)cfg.effectiveTileWidth * 4u)){
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
		// call passes through and the success is recorded, it never refuses,
		// and no codec substitution runs on this path.
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
	if(cfg.bitrateScale && cfg.bitrateMbit > 0 && cfg.vrlinkClampMbit <= 0){ return "Bitrate scaling (streamFrame.nvencBitrateScale) requires a positive streamFrame.nvencVrlinkClampMbit."; }
	const double maxValue = (double)(std::numeric_limits<uint32_t>::max)();
	const double bitrate = cfg.bitrateMbit > 0 ? cfg.bitrateMbit * 1000000.0 : p->encodeConfig->rcParams.averageBitRate;
	if(bitrate * (1.0 + cfg.maxBitrateHeadroomPct / 100.0) > maxValue){ return "streamFrame.nvencBitrateMbit with streamFrame.nvencMaxBitrateHeadroomPct exceeds the NVENC uint32 bit-rate field."; }
	if(cfg.vbvFrames > 0 && bitrate / (cfg.forceFps > 0 ? cfg.forceFps : 90.0) * cfg.vbvFrames > maxValue){ return "streamFrame.nvencVbvFrames at this streamFrame.nvencBitrateMbit exceeds the NVENC uint32 field."; }
	if(cfg.bitrateMbit > 0 && p->encodeConfig->rcParams.averageBitRate > 0 && p->encodeConfig->rcParams.vbvBufferSize * (bitrate / p->encodeConfig->rcParams.averageBitRate) > maxValue){ return "The scaled VBV buffer (streamFrame.nvencVbvFrames with streamFrame.nvencBitrateMbit) exceeds the NVENC uint32 field."; }
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
		uint32_t* outerVersion = nullptr){
	(void)failedThenOk; (void)outerVersion;
	const NvencTapConfig cfg = NvencTap::Get().GetConfig();
	{ std::lock_guard<std::mutex> guard(statsLock); calls++; }
	RecordRequest(p);
	if(logThis){ Describe(tag, p, cfg.verbose); }
	const std::string invalid = ValidateRequest(cfg, p);
	if(!invalid.empty()){
		PublishFailure(encoder, cfg, NV_ENC_ERR_INVALID_PARAM, invalid);
		std::lock_guard<std::mutex> guard(statsLock); failed++;
		return NV_ENC_ERR_INVALID_PARAM;
	}
	Snapshot snap; char what[256] = {};
	const bool changed = cfg.enabled && ApplyOverrides(encoder, p, cfg, snap, what, sizeof(what));
	if(!snap.error.empty()){
		Restore(snap); PublishFailure(encoder, cfg, NV_ENC_ERR_INVALID_PARAM, snap.error);
		std::lock_guard<std::mutex> guard(statsLock); failed++;
		return NV_ENC_ERR_INVALID_PARAM;
	}
	if(changed && logThis){ DriverLog("NvencTap: %s override: %s", tag, what); }
	RecordLast(p);
	const int effectiveCodec = CodecOfGuid(p->encodeGUID);
	const NVENCSTATUS status = call();
	if(status == NV_ENC_SUCCESS){
		SetSessionCodec(encoder, effectiveCodec);
		PublishSuccess(encoder, cfg, p);
	}else{
		// 2026-10-16: failures must name the NVENC status number and the
		// request itself — nvEncGetLastErrorString often returns useless
		// text ("Success.") and early calls can precede a working log sink,
		// so the persisted error state carries the full context.
		std::string error = std::string(tag) + " rejected the requested configuration (NVENC status " + std::to_string((unsigned)status) + ")";
		if(origGetLastErrorString){ const char* detail = origGetLastErrorString(encoder); if(detail && *detail){ error += ": "; error += detail; } }
		error += " | request: " + RequestDescription(cfg);
		PublishFailure(encoder, cfg, status, error);
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
	if(!params){ return origInitializeEncoder(encoder, params); }
	// re-tag first so the caps probe below and Guarded see the session's version
	Retag rt; if(Upgraded(encoder)){ RetagInitParams(rt, params); }
	const NvencTapConfig initConfig = NvencTap::Get().GetConfig();
	if(!initConfig.enabled){
		const NVENCSTATUS status = origInitializeEncoder(encoder, params);
		if(status == NV_ENC_SUCCESS){ SetSessionCodec(encoder, CodecOfGuid(params->encodeGUID)); PublishSuccess(encoder, initConfig, params); }
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
		stats.initCalls, stats.initOverridden, stats.initFailedThenPristineOk, stats.initFailed, nullptr);
}

NVENCSTATUS NVENCAPI NvencTapShims::ReconfigureEncoder(void* encoder, NV_ENC_RECONFIGURE_PARAMS* params){
	if(!params){ return origReconfigureEncoder(encoder, params); }
	NvencTapConfig cfg = NvencTap::Get().GetConfig();
	Retag rt; if(Upgraded(encoder)){ rt.add(&params->version, 1, true); RetagInitParams(rt, &params->reInitEncodeParams); }
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
	Retag rt; if(params && Upgraded(encoder)){ rt.add(&params->version, 4, false); }
	// 2026-09-30: retain lifetime ownership even while OFF. A newly
	// registered alias may map the same texture as an older ON handle.
	const bool enabled = NvencTap::Get().GetConfig().enabled;
	if(enabled){ std::lock_guard<std::mutex> g(statsLock); stats.registerCalls++; }
	if(enabled && params && registerLogged.fetch_add(1) < 12){
		DriverLog("NvencTap: nvEncRegisterResource encoder=%p type=%u %ux%u pitch=%u fmt=0x%x usage=%u res=%p — a LAYER-sized DX resource here is the direct-encode substitution site",
			encoder, (unsigned)params->resourceType, params->width, params->height, params->pitch,
			(unsigned)params->bufferFormat, (unsigned)params->bufferUsage, params->resourceToRegister);
	}
	NVENCSTATUS st = origRegisterResource(encoder, params);
	if(st == NV_ENC_SUCCESS && params && params->registeredResource){
		std::lock_guard<std::mutex> g(resLock);
		registered[params->registeredResource] = { params->resourceToRegister, (uint32_t)params->bufferFormat, (uint32_t)params->resourceType };
	}
	return st;
}
NVENCSTATUS NVENCAPI NvencTapShims::UnregisterResource(void* encoder, NV_ENC_REGISTERED_PTR reg){
	std::lock_guard<std::mutex> g(resLock);
	NVENCSTATUS st = origUnregisterResource(encoder, reg);
	if(st == NV_ENC_SUCCESS){ registered.erase(reg); }
	return st;
}
NVENCSTATUS NVENCAPI NvencTapShims::UnmapInputResource(void* encoder, NV_ENC_INPUT_PTR mapped){
	std::lock_guard<std::mutex> g(resLock);
	NVENCSTATUS st = origUnmapInputResource(encoder, mapped);
	if(st == NV_ENC_SUCCESS){ mappedToReg.erase(mapped); }
	return st;
}

NVENCSTATUS NVENCAPI NvencTapShims::EncodePicture(void* encoder, NV_ENC_PIC_PARAMS* params){
	const NvencTapConfig qcfg = NvencTap::Get().GetConfig();
	// 2026-09-30: OFF keeps only the ABI adapter required by live 12.1 sessions.
	if(!qcfg.enabled){
		NVENCSTATUS status;
		if(params && Upgraded(encoder) && Is111(params->version)){
			// explicit 11.1 -> 12.1 field copy (see CopyPicParams111To121)
			alignas(16) unsigned char scratch[kScratch] = {};
			status = origEncodePicture(encoder, CopyPicParams111To121(params, (NV_ENC_PIC_PARAMS*)scratch));
		}else{ status = origEncodePicture(encoder, params); }
		if(status == NV_ENC_SUCCESS && params && params->inputBuffer){ PublishPictureResult(encoder, status, {}, false); }
		return status;
	}
	// 2026-10-16: the QP-map validation applies only when the map is actually
	// configured (QpMapWanted); an unconfigured map can no longer refuse a
	// submitted frame.
	const std::string invalidQpMap = QpMapWanted(qcfg) ? ValidateQpMap(qcfg) : std::string();
	if(params && params->inputBuffer && !invalidQpMap.empty()){
		PublishPictureResult(encoder, NV_ENC_ERR_INVALID_PARAM, invalidQpMap);
		return NV_ENC_ERR_INVALID_PARAM;
	}
	{ std::lock_guard<std::mutex> g(statsLock); stats.encodeCalls++; }
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
		qmap = GetQpMap(params->inputWidth, params->inputHeight, mapCodec, qcfg, &qsize);
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
		if(NvencTap::Get().GetConfig().enabled){ std::lock_guard<std::mutex> g(statsLock); stats.retagCalls++; }
	}else{
		st = origLockBitstream(encoder, params);
	}
	if(!NvencTap::Get().GetConfig().enabled || st != NV_ENC_SUCCESS || !params){ return st; }
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
		if(latMs >= 0 && latMs < 5000){
			stats.latSamples++; stats.latSumMs += latMs; if(latMs > stats.latMaxMs){ stats.latMaxMs = latMs; }
			stats.ivLatSamples++; stats.ivLatSumMs += latMs; if(latMs > stats.ivLatMaxMs){ stats.ivLatMaxMs = latMs; } if(latMs >= 11.1){ stats.ivLatOver11++; }
			int lb = latMs < 5 ? 0 : latMs < 8 ? 1 : latMs < 11 ? 2 : latMs < 16 ? 3 : latMs < 33 ? 4 : 5;
			stats.latBucket[lb]++;
		}
	}
	// every new record above 1 MB is worth a line: the last few of these
	// before a "Packet too big" fault bracket vrlink's send limit
	if(newMax && n >= 1048576 && bigFrameLogged.fetch_add(1) < 40){
		DriverLog("NvencTap: new largest encoded frame: %u bytes (%.2f MB) picType=%u%s frameIdx=%u avgQP=%u slices=%u",
			n, n / 1048576.0, (unsigned)params->pictureType, idr ? " IDR/I" : "", params->frameIdx, params->frameAvgQP, params->numSlices);
	}
	return st;
}

// ---- session upgrade shims ----
NVENCSTATUS NVENCAPI NvencTapShims::OpenEncodeSessionEx(NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS* params, void** encoder){
	if(!params || !encoder || !UpgradeWanted() || params->apiVersion != kApi111){
		return origOpenEncodeSessionEx(params, encoder);
	}
	uint32_t savedVer = params->version, savedApi = params->apiVersion;
	params->apiVersion = kApi121;
	if(Is111(params->version)){ params->version = Tag121(1, false); }
	NVENCSTATUS st = origOpenEncodeSessionEx(params, encoder);
	params->version = savedVer; params->apiVersion = savedApi;
	if(st == NV_ENC_SUCCESS){
		{ std::lock_guard<std::mutex> g(upgradedLock); upgradedSessions.insert(*encoder); }
		{ std::lock_guard<std::mutex> g(statsLock); stats.sessionUpgrade = 1; }
		DriverLog("NvencTap: SESSION UPGRADE: nvEncOpenEncodeSessionEx accepted apiVersion 12.1 (encoder %p) — vrlink's 11.1 structs will be re-tagged as 12.1 on every call; splitEncodeMode is now reachable", *encoder);
		return st;
	}
	sessionUpgradeRejected.store(true);
	{ std::lock_guard<std::mutex> g(statsLock); stats.sessionUpgrade = 2; stats.sessionUpgradeStatus = (uint32_t)st; }
	if(openRejectLogged.fetch_add(1) < 1){
		DriverLog("NvencTap: open-time 12.1 session upgrade rejected by NVENC (status %u) — no pristine open and no fallback; explicit settings keep failing visibly until the upgrade is accepted", (unsigned)st);
	}
	PublishFailure(nullptr, OpenDecisionConfig(), st, "NVENC rejected the required API 12.1 session upgrade. No older-API fallback was attempted.");
	return st;
}
NVENCSTATUS NVENCAPI NvencTapShims::DestroyEncoder(void* encoder){
	const NVENCSTATUS status = origDestroyEncoder(encoder);
	if(status != NV_ENC_SUCCESS){ return status; }
	{ std::lock_guard<std::mutex> guard(upgradedLock); upgradedSessions.erase(encoder); sessionCodecs.erase(encoder); }
	{
		std::lock_guard<std::mutex> guard(runtimeLock);
		if(runtimeEncoder == encoder){
			runtimeEncoder = nullptr; runtime.effectiveCodec = -1;
			runtime.effectiveRateControl = -1; runtime.effectiveSplit = -1; runtime.encodeWidth = 0; runtime.encodeHeight = 0;
			// Keep a rejected request visible until a configuration succeeds.
		}
		if(runtimePictureEncoder == encoder){
			runtimePictureEncoder = nullptr; runtime.lastPictureStatus = 0; runtime.pictureError.clear();
		}
	}
	return status;
}
NVENCSTATUS NVENCAPI NvencTapShims::GetEncodeCaps(void* encoder, GUID encodeGUID, NV_ENC_CAPS_PARAM* params, int* capsVal){
	Retag rt; if(params && Upgraded(encoder)){ rt.add(&params->version, 1, false); }
	NvencTapConfig cfg = NvencTap::Get().GetConfig();
	if(!NvencTap::Get().ConfigPublished()){
		// A caps probe may precede provider publication. Read only this
		// build's config with the shared pre-publish probe: the ConfigLoader
		// parse rules — missing/legacy-typed keys take the loader defaults
		// (nvencTap true, nvencCodec 0, nvencSplitMode 1); an explicitly
		// disabled tap is honored. (The loader's own no-APPDATA ./settings.json
		// fallback is not followed here; the caps shim never read it either.)
		const PrePublishProbe probe = ProbePrePublishConfig();
		cfg.enabled = probe.tap; cfg.codec = probe.codec; cfg.splitMode = probe.splitMode;
	}
	// Query the selected codec's actual hardware capabilities. Requested
	// geometry must never be presented as a fabricated device limit.
	if(cfg.enabled && cfg.codec == 1){ encodeGUID = NV_ENC_CODEC_H264_GUID; }
	else if(cfg.enabled && cfg.codec == 2){ encodeGUID = NV_ENC_CODEC_AV1_GUID; }
	if(cfg.enabled && cfg.codec == 1 && params && capsVal && params->capsToQuery == NV_ENC_CAPS_SUPPORT_10BIT_ENCODE){
		// Profile restriction, not a claim about the GPU: this client path
		// selects H.264 High 8-bit and requires matching input textures.
		if(h264FileSelLogged.fetch_add(1) < 1){ DriverLog("NvencTap: H.264 High 8-bit profile selected; limiting input depth to 8-bit for the client contract (hardware caps otherwise unchanged)"); }
		*capsVal = 0; return NV_ENC_SUCCESS;
	}
	return origGetEncodeCaps(encoder, encodeGUID, params, capsVal);
}
NVENCSTATUS NVENCAPI NvencTapShims::GetEncodePresetConfig(void* encoder, GUID encodeGUID, GUID presetGUID, NV_ENC_PRESET_CONFIG* params){
	Retag rt; if(params && Upgraded(encoder)){ rt.add(&params->version, 4, true); rt.add(&params->presetCfg.version, 8, true); }
	return origGetPresetConfig(encoder, encodeGUID, presetGUID, params);
}
NVENCSTATUS NVENCAPI NvencTapShims::GetEncodePresetConfigEx(void* encoder, GUID encodeGUID, GUID presetGUID, NV_ENC_TUNING_INFO tuning, NV_ENC_PRESET_CONFIG* params){
	Retag rt; if(params && Upgraded(encoder)){ rt.add(&params->version, 4, true); rt.add(&params->presetCfg.version, 8, true); }
	return origGetPresetConfigEx(encoder, encodeGUID, presetGUID, tuning, params);
}
NVENCSTATUS NVENCAPI NvencTapShims::CreateInputBuffer(void* encoder, NV_ENC_CREATE_INPUT_BUFFER* params){
	Retag rt; if(params && Upgraded(encoder)){ rt.add(&params->version, 1, false); }
	return origCreateInputBuffer(encoder, params);
}
NVENCSTATUS NVENCAPI NvencTapShims::CreateBitstreamBuffer(void* encoder, NV_ENC_CREATE_BITSTREAM_BUFFER* params){
	Retag rt; if(params && Upgraded(encoder)){ rt.add(&params->version, 1, false); }
	return origCreateBitstreamBuffer(encoder, params);
}
NVENCSTATUS NVENCAPI NvencTapShims::CreateMVBuffer(void* encoder, NV_ENC_CREATE_MV_BUFFER* params){
	Retag rt; if(params && Upgraded(encoder)){ rt.add(&params->version, 1, false); }
	return origCreateMVBuffer(encoder, params);
}
NVENCSTATUS NVENCAPI NvencTapShims::RegisterAsyncEvent(void* encoder, NV_ENC_EVENT_PARAMS* params){
	Retag rt; if(params && Upgraded(encoder)){ rt.add(&params->version, 1, false); }
	return origRegisterAsyncEvent(encoder, params);
}
NVENCSTATUS NVENCAPI NvencTapShims::UnregisterAsyncEvent(void* encoder, NV_ENC_EVENT_PARAMS* params){
	Retag rt; if(params && Upgraded(encoder)){ rt.add(&params->version, 1, false); }
	return origUnregisterAsyncEvent(encoder, params);
}
NVENCSTATUS NVENCAPI NvencTapShims::MapInputResource(void* encoder, NV_ENC_MAP_INPUT_RESOURCE* params){
	Retag rt; if(params && Upgraded(encoder)){ rt.add(&params->version, 4, false); }
	if(!NvencTap::Get().GetConfig().enabled){
		// Keep ownership while OFF: re-enabling must never sharpen an
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
	Retag rt; if(params && Upgraded(encoder)){ rt.add(&params->version, 1, false); }
	return origLockInputBuffer(encoder, params);
}
NVENCSTATUS NVENCAPI NvencTapShims::GetSequenceParams(void* encoder, NV_ENC_SEQUENCE_PARAM_PAYLOAD* params){
	Retag rt; if(params && Upgraded(encoder)){ rt.add(&params->version, 1, false); }
	return origGetSequenceParams(encoder, params);
}
NVENCSTATUS NVENCAPI NvencTapShims::RunMotionEstimationOnly(void* encoder, NV_ENC_MEONLY_PARAMS* params){
	Retag rt; if(params && Upgraded(encoder)){ rt.add(&params->version, 3, false); }
	return origRunMotionEstimationOnly(encoder, params);
}

NVENCSTATUS NVENCAPI NvencTapShims::CreateInstance(NV_ENCODE_API_FUNCTION_LIST* list){
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
NvencTapStats NvencTap::GetStats(){
	std::lock_guard<std::mutex> g(statsLock);
	return stats;
}

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

void NvencTap::MaybeHeartbeat(){
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
	DriverLog("NvencTap: heartbeat api=%u enabled=%d %ux%u avg=%.0fM max=%.0fM level=%u tier=%u bitDepth=%u | init %u (ovr %u, ovrFail->ok %u, fail %u) | reconf %u (ovr %u, ovrFail->ok %u, fail %u, stockFail %u) | register %u encode %u lock %lld (last %u bytes) encFail %lld | lastEncFail %u \"%s\"",
		s.apiMajor, (int)c.enabled, s.lastWidth, s.lastHeight, s.lastAvgBitrate / 1e6, s.lastMaxBitrate / 1e6, s.lastLevel, s.lastTier, s.lastBitDepth,
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
		DriverLog("NvencTap: last 10s: vrlink asked avg=%.0fM min=%.0fM max=%.0fM (n=%u) | submit->lock mean=%.2fms max=%.1fms over-11.1ms=%u/%u (%.0f%%) | SUBMIT BLOCKED mean=%.2fms max=%.1fms over-10ms=%u/%u (vrlink watchdog resets on >10)",
			s.ivReqCount ? s.ivReqSumMbit / s.ivReqCount : 0.0, s.ivReqCount ? s.ivReqMinMbit : 0.0, s.ivReqMaxMbit, s.ivReqCount,
			s.ivLatSamples ? s.ivLatSumMs / s.ivLatSamples : 0.0, s.ivLatMaxMs, s.ivLatOver11, s.ivLatSamples,
			s.ivLatSamples ? 100.0 * s.ivLatOver11 / s.ivLatSamples : 0.0,
			s.ivSubmitSamples ? s.ivSubmitSumMs / s.ivSubmitSamples : 0.0, s.ivSubmitMaxMs, s.ivSubmitOver10, s.ivSubmitSamples);
		std::lock_guard<std::mutex> g(statsLock);
		stats.ivReqCount = 0; stats.ivReqSumMbit = 0; stats.ivReqMinMbit = 1e9; stats.ivReqMaxMbit = 0;
		stats.ivLatSamples = 0; stats.ivLatOver11 = 0; stats.ivLatSumMs = 0; stats.ivLatMaxMs = 0;
		stats.ivSubmitSamples = 0; stats.ivSubmitOver10 = 0; stats.ivSubmitSumMs = 0; stats.ivSubmitMaxMs = 0;
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
