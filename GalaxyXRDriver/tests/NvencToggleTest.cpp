// Compile the actual shim implementation; substitute only external NVENC/D3D
// and hook dependencies. No GPU, injected hooks, or SteamVR process is used.
#include <windows.h>
#include <future>
#include <condition_variable>
#include <cstdarg>
#include <functional>
HMODULE WINAPI FakeModule(LPCSTR);
FARPROC WINAPI FakeExport(HMODULE, LPCSTR);
#define GetModuleHandleA FakeModule
#define LoadLibraryA FakeModule
#define GetProcAddress FakeExport
#include "../src/Driver/NvencTap.cpp"
#undef GetModuleHandleA
#undef LoadLibraryA
#undef GetProcAddress
#include <algorithm>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>

Config driverConfig;
std::atomic<int> logCalls{0};
std::mutex capturedLogLock;
std::string largestBufferLog;
void DriverLog(const char* format, ...) {
	++logCalls;
	if(std::strstr(format, "new largest encoded")){
		char message[1024];
		va_list args; va_start(args, format);
		std::vsnprintf(message, sizeof(message), format, args);
		va_end(args);
		std::lock_guard<std::mutex> guard(capturedLogLock);
		largestBufferLog = message;
	}
}

namespace {
int checks = 0;
int failures = 0;
uintptr_t nextHandle = 1;
std::vector<uint32_t> openApis;
std::vector<uint32_t> openVersions;
std::vector<uint32_t> listVersions;
bool rejectOpenUpgrade = false;
bool rejectListUpgrade = false;
uint32_t seenCapsVersion = 0;
uint32_t seenInitVersion = 0;
uint32_t seenConfigVersion = 0;
uint32_t seenRcVersion = 0;
uint32_t seenInitFlags = 0;
uint32_t seenTuning = 0;
uint32_t seenLevel = 0;
uint32_t seenBitrate = 0;
uint32_t seenRcMode = 0, seenKfScale = 0, seenMaxBitrate = 0, seenVbvSize = 0;
GUID seenCodecGuid{};
GUID seenCapsGuid{};
GUID seenProfileGuid{};
uint32_t seenH264Level = 0, seenH264BitDepth = 0, seenH264RepeatSpsPps = 0;
uint32_t seenAv1Level = 0, seenAv1BitDepth = 0, seenAv1InputBitDepth = 0, seenAv1RepeatSeqHdr = 0;
uint32_t seenAv1Flags = 0;
uint32_t seenMaxEncodeW = 0, seenMaxEncodeH = 0;
const int8_t* seenEncodeMap = nullptr;
uint32_t seenEncodeMapSize = 0;
int8_t seenEncodeMapBytes[32] = {};
uint32_t seenPictureVersion = 0, seenLockVersion = 0;
int destroyCalls = 0;
int capsCalls = 0;
bool failNextInit = false;
NVENCSTATUS nextInitStatus = NV_ENC_SUCCESS;
NVENCSTATUS reconfigureDriverStatus = NV_ENC_ERR_GENERIC;
bool strictCapabilities = false;
std::vector<GUID> directGeometryCaps;
uint32_t seenEncodeW = 0, seenEncodeH = 0;
int initDriverCalls = 0;
int ordinaryCalls = 0;
NVENCSTATUS encodeDriverStatus = NV_ENC_ERR_GENERIC;
uint32_t seenMultiPass = 0;
uint32_t seenVbvDelay = 0;
NV_ENC_CONFIG_H264 seenH264Recipe{};
NV_ENC_CONFIG_HEVC_VUI_PARAMETERS seenHevcVui{};
NV_ENC_CONFIG_AV1 seenAv1Config{};
uint32_t seenH264Gop = 0, seenH264Idr = 0;
int rejectedPresetCalls = 0;
std::function<NVENCSTATUS(void*, NV_ENC_PIC_PARAMS*)> encodeMapCallback;
NVENCSTATUS NVENCAPI EncodeMapCallback(void* encoder, NV_ENC_PIC_PARAMS* params){
	return encodeMapCallback(encoder, params);
}

void Check(bool condition, const char* label){
	checks++;
	if(!condition){ failures++; std::cerr << "FAIL: " << label << '\n'; }
}

constexpr uint32_t Tag111(uint32_t digit, bool b31 = false){
	return kApi111 | (digit << 16) | (0x7u << 28) | (b31 ? (1u << 31) : 0u);
}

void Configure(bool enabled, int splitMode){
	// Match both publications so this same test exposes the old raw-config
	// gate as well as verifying the synchronized snapshot used by the fix.
	driverConfig.streamFrame.nvencTap = enabled;
	driverConfig.streamFrame.nvencSplitMode = splitMode;
	NvencTapConfig config;
	config.enabled = enabled;
	config.splitMode = splitMode;
	NvencTap::Get().SetConfig(config);
}

// 2026-10-16 second param: codec selection published via SetConfig
// (mirrors FrameProcessor::UpdateEncoderSettings). third param: the
// requested tile published with the config; it must not replace GPU caps.
void ConfigureCodec(bool enabled, int codec, int tile = 1536){
	driverConfig.streamFrame.nvencTap = enabled;
	driverConfig.streamFrame.nvencCodec = codec;
	NvencTapConfig config;
	config.enabled = enabled;
	config.codec = codec;
	config.effectiveTileWidth = tile;
	NvencTap::Get().SetConfig(config);
}

// 2026-10-16 caps-shim probe helper: run one capsToQuery through the shim
// and report the answered value plus whether the driver was consulted
// (driverCalls > 0 = the call passed through to CaptureCaps)
struct CapsProbe { NVENCSTATUS status; int value; int driverCalls; };
CapsProbe ShimCapsQuery(void* encoder, NV_ENC_CAPS capsToQuery){
	NV_ENC_CAPS_PARAM caps = {}; caps.version = Tag111(1); caps.capsToQuery = capsToQuery;
	CapsProbe p = { NV_ENC_ERR_GENERIC, -1, 0 };
	const int before = capsCalls;
	p.status = NvencTapShims::GetEncodeCaps(encoder, NV_ENC_CODEC_HEVC_GUID, &caps, &p.value);
	p.driverCalls = capsCalls - before;
	return p;
}

void* OpenSession();
void CreateFunctionList();

void CheckCodecOverride(void* encoder){
	// H.264 rewrite: GUID + profile + SPS/PPS repeat, depths left DEFAULT,
	// full caller restore after
	ConfigureCodec(true, 1);
	NV_ENC_CONFIG cfg = {}; cfg.version = Tag111(7, true); cfg.rcParams.version = Tag111(1);
	cfg.rcParams.averageBitRate = 42000000; cfg.rcParams.maxBitRate = 42000000;
	cfg.gopLength = 60; cfg.profileGUID = NV_ENC_HEVC_PROFILE_MAIN_GUID;
	cfg.encodeCodecConfig.hevcConfig.level = NV_ENC_LEVEL_HEVC_61;
	cfg.encodeCodecConfig.hevcConfig.tier = NV_ENC_TIER_HEVC_HIGH;
	cfg.encodeCodecConfig.hevcConfig.outputBitDepth = NV_ENC_BIT_DEPTH_10;
	const auto savedCfg = cfg;
	NV_ENC_INITIALIZE_PARAMS init = {}; init.version = Tag111(5, true);
	init.encodeGUID = NV_ENC_CODEC_HEVC_GUID; init.encodeConfig = &cfg;
	init.frameRateNum = 90; init.frameRateDen = 1;
	const auto savedInit = init;
	Check(NvencTapShims::InitializeEncoder(encoder, &init) == NV_ENC_SUCCESS, "codec H264: init delegated");
	Check(memcmp(&seenCodecGuid, &NV_ENC_CODEC_H264_GUID, sizeof(GUID)) == 0, "codec H264: encoder gets the H264 GUID");
	Check(memcmp(&seenProfileGuid, &NV_ENC_H264_PROFILE_HIGH_GUID, sizeof(GUID)) == 0, "codec H264: profile is High");
	Check(seenH264Level == NV_ENC_LEVEL_AUTOSELECT, "codec H264: level AUTOSELECT");
	Check(seenH264BitDepth == 0u, "codec H264: bit depth left DEFAULT (class decides)");
	Check(seenH264RepeatSpsPps == 1, "codec H264: repeatSPSPPS");
	Check(memcmp(&init, &savedInit, sizeof(init)) == 0, "codec H264: caller init fully restored");
	Check(memcmp(&cfg, &savedCfg, sizeof(cfg)) == 0, "codec H264: caller config fully restored");

	// AV1 rewrite (needs an upgraded session: AV1 exists from NVENC API 12.0
	// on; the session upgrade must also work with split mode zero).
	driverConfig.streamFrame.nvencTap = true;
	driverConfig.streamFrame.nvencCodec = 2;
	driverConfig.streamFrame.nvencSplitMode = 1;
	NvencTapConfig av1Cfg; av1Cfg.enabled = true; av1Cfg.codec = 2; av1Cfg.splitMode = 0;
	NvencTap::Get().SetConfig(av1Cfg);
	CreateFunctionList();
	Check(listVersions == std::vector<uint32_t>{Tag121(2, false)}, "codec AV1: split zero still upgrades function list");
	void* av1Enc = OpenSession();
	Check(Upgraded(av1Enc), "codec AV1: split zero still upgrades session for the 12.0+ AV1 union");
	NV_ENC_CONFIG cfg2 = {}; cfg2.version = Tag111(7, true); cfg2.rcParams.version = Tag111(1);
	cfg2.rcParams.averageBitRate = 42000000; cfg2.gopLength = 60;
	cfg2.profileGUID = NV_ENC_HEVC_PROFILE_MAIN_GUID;
	cfg2.encodeCodecConfig.hevcConfig.level = NV_ENC_LEVEL_HEVC_61;
	cfg2.encodeCodecConfig.hevcConfig.outputBitDepth = NV_ENC_BIT_DEPTH_10;
	const auto savedCfg2 = cfg2;
	NV_ENC_INITIALIZE_PARAMS init2 = {}; init2.version = Tag111(5, true);
	init2.encodeGUID = NV_ENC_CODEC_HEVC_GUID; init2.encodeConfig = &cfg2;
	init2.frameRateNum = 90; init2.frameRateDen = 1;
	init2.bufferFormat = NV_ENC_BUFFER_FORMAT_YUV420_10BIT;
	init2.tuningInfo = NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY;
	Check(NvencTapShims::InitializeEncoder(av1Enc, &init2) == NV_ENC_SUCCESS, "codec AV1: init delegated");
	Check(memcmp(&seenCodecGuid, &NV_ENC_CODEC_AV1_GUID, sizeof(GUID)) == 0, "codec AV1: encoder gets the AV1 GUID");
	Check(memcmp(&seenProfileGuid, &NV_ENC_AV1_PROFILE_MAIN_GUID, sizeof(GUID)) == 0, "codec AV1: profile is Main");
	Check(seenAv1Level == NV_ENC_LEVEL_AV1_AUTOSELECT, "codec AV1: level AUTOSELECT");
	Check(seenAv1BitDepth == 0u && seenAv1InputBitDepth == 0u, "codec AV1: SDK13 tail depths untouched (reserved in the 12.1 ABI)");
	Check((seenAv1Flags & 0x3F000u) == 0x12000u, "codec AV1: 12.1 flags depth bits set to 10-bit (2/2)");
	Check(seenTuning == NV_ENC_TUNING_INFO_LOW_LATENCY, "codec AV1: ULL re-tuned to LL for the big frame");
	Check(init2.tuningInfo == NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY, "codec AV1: caller tuning restored");
	Check(seenAv1RepeatSeqHdr == 1, "codec AV1: repeatSeqHdr");
	Check(memcmp(&cfg2, &savedCfg2, sizeof(cfg2)) == 0, "codec AV1: caller config fully restored");

	// default: HEVC sessions are not rewritten by the codec override
	ConfigureCodec(true, 0);
	NV_ENC_CONFIG cfg3 = {}; cfg3.version = Tag111(7, true); cfg3.rcParams.version = Tag111(1);
	cfg3.rcParams.averageBitRate = 42000000;
	cfg3.encodeCodecConfig.hevcConfig.level = NV_ENC_LEVEL_HEVC_61;
	NV_ENC_INITIALIZE_PARAMS init3 = {}; init3.version = Tag111(5, true);
	init3.encodeGUID = NV_ENC_CODEC_HEVC_GUID; init3.encodeConfig = &cfg3;
	init3.frameRateNum = 90; init3.frameRateDen = 1;
	Check(NvencTapShims::InitializeEncoder(encoder, &init3) == NV_ENC_SUCCESS, "codec default: HEVC init delegated");
	Check(memcmp(&seenCodecGuid, &NV_ENC_CODEC_HEVC_GUID, sizeof(GUID)) == 0, "codec default: HEVC GUID kept");

	// caps shim: while H.264 is selected the SUPPORT_10BIT_ENCODE probe must
	// answer no (vrlink then builds its 8-bit class and the H.264 session is
	// valid); AV1 and stock HEVC keep the real GPU answer.
	ConfigureCodec(true, 1);
	NV_ENC_CAPS_PARAM caps = {}; caps.version = Tag111(1); caps.capsToQuery = NV_ENC_CAPS_SUPPORT_10BIT_ENCODE;
	int capsValue = -1;
	const int capsBefore = capsCalls;
	Check(NvencTapShims::GetEncodeCaps(encoder, NV_ENC_CODEC_HEVC_GUID, &caps, &capsValue) == NV_ENC_SUCCESS,
		"caps shim: H264 selection answers SUCCESS");
	Check(capsValue == 0, "caps shim: H264 selection reports no 10-bit encode");
	Check(capsCalls == capsBefore, "caps shim: driver not consulted for the H264 selection");
	ConfigureCodec(true, 2);
	capsValue = -1;
	Check(NvencTapShims::GetEncodeCaps(encoder, NV_ENC_CODEC_HEVC_GUID, &caps, &capsValue) == NV_ENC_SUCCESS,
		"caps shim: AV1 selection still consults the driver");
	Check(capsValue == 1 && capsCalls == capsBefore + 1, "caps shim: AV1 keeps the real 10-bit answer");
	ConfigureCodec(false, 1);
	capsValue = -1;
	Check(NvencTapShims::GetEncodeCaps(encoder, NV_ENC_CODEC_HEVC_GUID, &caps, &capsValue) == NV_ENC_SUCCESS,
		"caps shim: disabled tap consults the driver");
	Check(capsValue == 1 && capsCalls == capsBefore + 2, "caps shim: disabled tap keeps the real answer");
	ConfigureCodec(true, 0);

	// Legacy caller probes describe the codec the caller asked about. In
	// particular HEVC-only feature probes must not be routed to AV1.
	for(int codec : {0, 1, 2}) for(int tile : {768, 1536, 3072}){
		ConfigureCodec(true, codec, tile);
		for(auto query : {NV_ENC_CAPS_WIDTH_MAX, NV_ENC_CAPS_HEIGHT_MAX}){
			auto probe = ShimCapsQuery(encoder, query);
			Check(probe.status == NV_ENC_SUCCESS && probe.value == 8192 && probe.driverCalls == 1,
				"caps: caller geometry uses actual driver answer without request-derived limits");
			Check(memcmp(&seenCapsGuid, &NV_ENC_CODEC_HEVC_GUID, sizeof(GUID)) == 0, "caps: driver receives the caller's HEVC GUID");
		}
	}
	ConfigureCodec(true, 2);
	auto constrained = ShimCapsQuery(encoder, NV_ENC_CAPS_SUPPORT_CONSTRAINED_ENCODING);
	Check(constrained.status == NV_ENC_SUCCESS && constrained.value == 1
		&& memcmp(&seenCapsGuid, &NV_ENC_CODEC_HEVC_GUID, sizeof(GUID)) == 0,
		"caps: AV1 selection preserves a legacy HEVC constrained-encoding query");
	ConfigureCodec(false, 1);
	auto disabledCaps = ShimCapsQuery(encoder, NV_ENC_CAPS_WIDTH_MAX);
	Check(disabledCaps.driverCalls == 1 && memcmp(&seenCapsGuid, &NV_ENC_CODEC_HEVC_GUID, sizeof(GUID)) == 0,
		"caps: disabled tap leaves caller codec and actual geometry untouched");
	// codec 0 stays published for the split tests below
	ConfigureCodec(true, 0);

	// split forcing must survive the codec swap (2026-10-13 fix): with split
	// enabled — the shipping default — a swapped session must still get the
	// forced bits via reconfigure, or NVENC rejects the big stream frame
	// (INVALID_PARAM). 2026-10-18 fresh-connect deferral: the bits never ride
	// nvEncInitializeEncoder — with them on the first keyframe the Steam Link
	// client acknowledges zero frames and the stream dies — they engage at the
	// first reconfigure, which re-applies the codec swap too. The handshake
	// grace (splitHandshakeGraceSeconds) is zeroed here: tests run
	// instant-clear so reconfigure engagement is deterministic; the deferral
	// during grace is its own check below.
	splitHandshakeGraceSeconds = 0.0;
	driverConfig.streamFrame.nvencTap = true;
	driverConfig.streamFrame.nvencCodec = 2;
	driverConfig.streamFrame.nvencSplitMode = 1;
	NvencTapConfig splitCfg; splitCfg.enabled = true; splitCfg.codec = 2; splitCfg.splitMode = 1;
	NvencTap::Get().SetConfig(splitCfg);
	void* upgraded2 = OpenSession();
	Check(Upgraded(upgraded2), "codec+split: session upgraded for the 12.1 split bits");
	NV_ENC_CONFIG scfg = {}; scfg.version = Tag111(7, true); scfg.rcParams.version = Tag111(1);
	scfg.encodeCodecConfig.hevcConfig.level = NV_ENC_LEVEL_HEVC_61;
	NV_ENC_INITIALIZE_PARAMS sinit = {}; sinit.version = Tag111(5, true);
	sinit.encodeGUID = NV_ENC_CODEC_HEVC_GUID; sinit.encodeConfig = &scfg;
	sinit.frameRateNum = 90; sinit.frameRateDen = 1;
	Check(NvencTapShims::InitializeEncoder(upgraded2, &sinit) == NV_ENC_SUCCESS, "codec+split: init delegated");
	Check(memcmp(&seenCodecGuid, &NV_ENC_CODEC_AV1_GUID, sizeof(GUID)) == 0, "codec+split: AV1 GUID applied");
	Check(seenAv1BitDepth == 0u, "codec+split: unknown buffer format leaves depths unset");
	Check((seenAv1Flags & 0x3F000u) == 0u, "codec+split: unknown buffer format leaves 12.1 depth bits at 8-bit");
	Check(((seenInitFlags >> 5) & 0xFu) == 0u, "codec+split: forced split bits deferred at init on the swapped session");
	Check(*((uint32_t*)&sinit.enablePTD + 1) == 0, "codec+split: caller flags word restored");
	Check(sinit.version == Tag111(5, true), "codec+split: caller version restored");
	NV_ENC_RECONFIGURE_PARAMS sreconf = {}; sreconf.version = Tag111(1, true);
	sreconf.reInitEncodeParams = sinit;
	const auto savedReconf = sreconf;
	reconfigureDriverStatus = NV_ENC_SUCCESS;
	Check(NvencTapShims::ReconfigureEncoder(upgraded2, &sreconf) == NV_ENC_SUCCESS, "codec+split: reconfigure delegated");
	reconfigureDriverStatus = NV_ENC_ERR_GENERIC;
	Check(((seenInitFlags >> 5) & 0xFu) == 1, "codec+split: forced split bits applied at reconfigure on the swapped session");
	Check(memcmp(&sreconf, &savedReconf, sizeof(sreconf)) == 0, "codec+split: reconfigure caller bytes restored");

	// handshake grace (2026-10-18): during grace a reconfigure ALSO defers
	// the bits — the first reconfigure lands ~100 ms after init, ahead of
	// the first keyframe, so first-reconfigure engagement alone still
	// poisons the client. After the grace they engage like the verified
	// mid-stream mode change (covered by the checks above at grace 0).
	splitHandshakeGraceSeconds = 1e9;
	NV_ENC_RECONFIGURE_PARAMS gsrconf = {}; gsrconf.version = Tag111(1, true);
	gsrconf.reInitEncodeParams = sinit;
	const auto savedGsrconf = gsrconf;
	reconfigureDriverStatus = NV_ENC_SUCCESS;
	Check(NvencTapShims::ReconfigureEncoder(upgraded2, &gsrconf) == NV_ENC_SUCCESS, "split grace: reconfigure delegated");
	reconfigureDriverStatus = NV_ENC_ERR_GENERIC;
	Check(((seenInitFlags >> 5) & 0xFu) == 0u, "split grace: split bits deferred during the handshake grace");
	Check(memcmp(&gsrconf, &savedGsrconf, sizeof(gsrconf)) == 0, "split grace: caller bytes restored");
	splitHandshakeGraceSeconds = 0.0;

	// h264+split: with codec==1 the split application is skipped outright —
	// even on the upgraded (12.1-ABI) session the forced split bits must stay
	// ABSENT for H.264, and the caller's flags word must come back untouched.
	driverConfig.streamFrame.nvencTap = true;
	driverConfig.streamFrame.nvencCodec = 1;
	driverConfig.streamFrame.nvencSplitMode = 1;
	NvencTapConfig h264Cfg; h264Cfg.enabled = true; h264Cfg.codec = 1; h264Cfg.splitMode = 1;
	NvencTap::Get().SetConfig(h264Cfg);
	void* h264Enc = OpenSession();
	Check(Upgraded(h264Enc), "h264+split: session upgraded for the split test");
	sinit.maxEncodeWidth = 1024; sinit.maxEncodeHeight = 4096;
	Check(NvencTapShims::InitializeEncoder(h264Enc, &sinit) == NV_ENC_SUCCESS, "h264+split: init delegated");
	Check(memcmp(&seenCodecGuid, &NV_ENC_CODEC_H264_GUID, sizeof(GUID)) == 0, "h264+split: H264 GUID applied");
	Check(((seenInitFlags >> 5) & 0xFu) == 0u, "h264+split: forced split bits ABSENT for H.264");
	Check(*((uint32_t*)&sinit.enablePTD + 1) == 0, "h264+split: caller flags word restored");

	// Allocation reservations have no app field. Bound them to real target
	// hardware while preserving the active geometry and caller-owned memory.
	strictCapabilities = true;
	sinit.encodeWidth = 1024; sinit.encodeHeight = 4096;
	sinit.maxEncodeWidth = 3200; sinit.maxEncodeHeight = 8192;
	Check(NvencTapShims::InitializeEncoder(h264Enc, &sinit) == NV_ENC_SUCCESS, "h264 reservations: valid active frame initializes within actual hardware bounds");
	Check(seenMaxEncodeW == 3200u && seenMaxEncodeH == 4096u && seenEncodeW == 1024u && seenEncodeH == 4096u,
		"h264 reservations: maximum height bounded to hardware without changing active frame");
	Check(sinit.maxEncodeWidth == 3200u && sinit.maxEncodeHeight == 8192u, "h264 reservations: caller bounds restored");
	strictCapabilities = false;

	// hevc+split regression: codec 0 keeps split via reconfigure — the skip
	// must only drop it for H.264, and the deferral is AV1-only (2026-10-19),
	// so HEVC applies the bits at init immediately (its pre-2026-10-18 shape).
	driverConfig.streamFrame.nvencTap = true;
	driverConfig.streamFrame.nvencCodec = 0;
	driverConfig.streamFrame.nvencSplitMode = 1;
	NvencTapConfig hevcCfg; hevcCfg.enabled = true; hevcCfg.codec = 0; hevcCfg.splitMode = 1;
	NvencTap::Get().SetConfig(hevcCfg);
	void* hevcEnc = OpenSession();
	Check(NvencTapShims::InitializeEncoder(hevcEnc, &sinit) == NV_ENC_SUCCESS, "hevc+split: init delegated");
	Check(((seenInitFlags >> 5) & 0xFu) == 1u, "hevc+split: forced split bits applied at init for HEVC (no AV1-only deferral)");
	Check(*((uint32_t*)&sinit.enablePTD + 1) == 0, "hevc+split: caller flags word restored");
	NV_ENC_RECONFIGURE_PARAMS hreconf = {}; hreconf.version = Tag111(1, true);
	hreconf.reInitEncodeParams = sinit;
	const auto savedHreconf = hreconf;
	reconfigureDriverStatus = NV_ENC_SUCCESS;
	Check(NvencTapShims::ReconfigureEncoder(hevcEnc, &hreconf) == NV_ENC_SUCCESS, "hevc+split: reconfigure delegated");
	reconfigureDriverStatus = NV_ENC_ERR_GENERIC;
	Check(((seenInitFlags >> 5) & 0xFu) == 1, "hevc+split: forced split bits applied at reconfigure for HEVC");
	Check(memcmp(&hreconf, &savedHreconf, sizeof(hreconf)) == 0, "hevc+split: reconfigure caller bytes restored");

	// reconnect+split (2026-10-19, AV1-only): a quick client reconnect that
	// reuses the live encode session produces no init, so a reconfigure that
	// arrives after an encode idle gap must re-arm the handshake window and
	// keep split off the resumed connection's first frames; once the window
	// clears the same session applies split at the next reconfigure.
	{
		NvencTapConfig av1Resume; av1Resume.enabled = true; av1Resume.codec = 2; av1Resume.splitMode = 1;
		NvencTap::Get().SetConfig(av1Resume);
		const auto savedScfg = scfg;
		const long long nowMs = (long long)(NowSecondsNv() * 1000.0);
		splitHandshakeGraceSeconds = 5.0;
		splitReconnectIdleSeconds = 0.5;
		splitArmSteadyMs.store((long long)((NowSecondsNv() - 60.0) * 1000.0));
		lastEncodeSteadyMs.store((long long)((NowSecondsNv() - 5.0) * 1000.0));
		lastEncodeEncoder.store(upgraded2);
		NV_ENC_RECONFIGURE_PARAMS rreconf = {}; rreconf.version = Tag111(1, true);
		rreconf.reInitEncodeParams = sinit;
		const auto savedRreconf = rreconf;
		reconfigureDriverStatus = NV_ENC_SUCCESS;
		Check(NvencTapShims::ReconfigureEncoder(upgraded2, &rreconf) == NV_ENC_SUCCESS, "reconnect: reconfigure delegated");
		reconfigureDriverStatus = NV_ENC_ERR_GENERIC;
		Check(((seenInitFlags >> 5) & 0xFu) == 0u, "reconnect: AV1 split re-deferred after the resumed-stream arm");
		Check(memcmp(&rreconf, &savedRreconf, sizeof(rreconf)) == 0, "reconnect: caller bytes restored");
		Check(memcmp(&scfg, &savedScfg, sizeof(scfg)) == 0, "reconnect: codec config bytes restored");
		Check(splitArmSteadyMs.load() > nowMs - 1000, "reconnect: resumed-stream arm refreshed the window");
		// no reconnect: a recent encode leaves the cleared window alone and split applies
		splitArmSteadyMs.store(nowMs - 60000);
		lastEncodeSteadyMs.store(nowMs);
		NV_ENC_RECONFIGURE_PARAMS nreconf = {}; nreconf.version = Tag111(1, true);
		nreconf.reInitEncodeParams = sinit;
		reconfigureDriverStatus = NV_ENC_SUCCESS;
		Check(NvencTapShims::ReconfigureEncoder(upgraded2, &nreconf) == NV_ENC_SUCCESS, "reconnect: no-gap reconfigure delegated");
		reconfigureDriverStatus = NV_ENC_ERR_GENERIC;
		Check(((seenInitFlags >> 5) & 0xFu) == 1u, "reconnect: recent encoding does not re-arm; split stays on");
		Check(splitArmSteadyMs.load() == nowMs - 60000, "reconnect: no-gap reconfigure left the window untouched");
		// window still open: a gap does not re-arm (no per-reconfigure loop)
		splitArmSteadyMs.store(nowMs);
		lastEncodeSteadyMs.store(nowMs - 5000);
		NV_ENC_RECONFIGURE_PARAMS oreconf = {}; oreconf.version = Tag111(1, true);
		oreconf.reInitEncodeParams = sinit;
		reconfigureDriverStatus = NV_ENC_SUCCESS;
		Check(NvencTapShims::ReconfigureEncoder(upgraded2, &oreconf) == NV_ENC_SUCCESS, "reconnect: open-window reconfigure delegated");
		reconfigureDriverStatus = NV_ENC_ERR_GENERIC;
		Check(((seenInitFlags >> 5) & 0xFu) == 0u, "reconnect: open window still defers split");
		Check(splitArmSteadyMs.load() == nowMs, "reconnect: open window was not re-armed");
		splitArmSteadyMs.store((long long)((NowSecondsNv() - 60.0) * 1000.0));
		lastEncodeSteadyMs.store(0);
		NV_ENC_RECONFIGURE_PARAMS areconf = {}; areconf.version = Tag111(1, true);
		areconf.reInitEncodeParams = sinit;
		reconfigureDriverStatus = NV_ENC_SUCCESS;
		Check(NvencTapShims::ReconfigureEncoder(upgraded2, &areconf) == NV_ENC_SUCCESS, "reconnect: post-window reconfigure delegated");
		reconfigureDriverStatus = NV_ENC_ERR_GENERIC;
		Check(((seenInitFlags >> 5) & 0xFu) == 1u, "reconnect: AV1 split applies at the first reconfigure after the window");
		lastEncodeSteadyMs.store(0); lastEncodeEncoder.store(nullptr);
		splitReconnectIdleSeconds = 2.0;
		splitHandshakeGraceSeconds = 0.0;
	}

	// The same reservation rule must also work for a direct H.264 caller.
	driverConfig.streamFrame.nvencTap = true;
	driverConfig.streamFrame.nvencCodec = 1;
	driverConfig.streamFrame.nvencSplitMode = 1;
	NvencTap::Get().SetConfig(h264Cfg);
	sinit.encodeGUID = NV_ENC_CODEC_H264_GUID;
	sinit.maxEncodeWidth = 8192; sinit.maxEncodeHeight = 8192;
	strictCapabilities = true;
	Check(NvencTapShims::InitializeEncoder(h264Enc, &sinit) == NV_ENC_SUCCESS, "h264 reservations: already-H264 init delegated");
	Check(seenMaxEncodeW == 4096u && seenMaxEncodeH == 4096u, "h264 reservations: already-H264 bounds follow actual capability");
	Check(sinit.maxEncodeWidth == 8192u && sinit.maxEncodeHeight == 8192u, "h264 reservations: already-H264 caller restored");
	strictCapabilities = false;

	// h264 rc: forceCbr and vbvFrames honor the configured values for codec 1
	// like for every codec (the codec-1 bypass is gone). forceCbr off: the
	// caller's VBR, kf scale and max bitrate stay untouched; the VBV still
	// follows the config. forceCbr on: CBR + lowDelayKeyFrameScale from the
	// config, maxBitRate flattened to averageBitRate.
	NvencTapConfig h264RcCfg; h264RcCfg.enabled = true; h264RcCfg.codec = 1; h264RcCfg.splitMode = 1; h264RcCfg.vbvFrames = 1;
	NvencTap::Get().SetConfig(h264RcCfg);
	NV_ENC_CONFIG rcOff = {}; rcOff.version = Tag111(7, true); rcOff.rcParams.version = Tag111(1);
	rcOff.rcParams.averageBitRate = 90000000; rcOff.rcParams.maxBitRate = 100000000;
	rcOff.rcParams.rateControlMode = NV_ENC_PARAMS_RC_VBR;
	const auto savedRcOff = rcOff;
	NV_ENC_INITIALIZE_PARAMS rcInitOff = {}; rcInitOff.version = Tag111(5, true);
	rcInitOff.encodeGUID = NV_ENC_CODEC_H264_GUID; rcInitOff.encodeConfig = &rcOff;
	rcInitOff.frameRateNum = 90; rcInitOff.frameRateDen = 1;
	Check(NvencTapShims::InitializeEncoder(h264Enc, &rcInitOff) == NV_ENC_SUCCESS, "h264 rc: forceCbr off init delegated");
	Check(seenRcMode == NV_ENC_PARAMS_RC_VBR && seenKfScale == 0u && seenMaxBitrate == 100000000u,
		"h264 rc: forceCbr off leaves the caller's VBR, kf scale and max bitrate untouched");
	Check(seenVbvSize == 1000000u, "h264 rc: configured 1-frame VBV applied (avg/90*1)");
	Check(memcmp(&rcOff, &savedRcOff, sizeof(rcOff)) == 0, "h264 rc: forceCbr off caller config fully restored");

	h264RcCfg.forceCbr = true; h264RcCfg.lowDelayKfScale = 2; h264RcCfg.vbvFrames = 2;
	NvencTap::Get().SetConfig(h264RcCfg);
	NV_ENC_CONFIG rcOn = {}; rcOn.version = Tag111(7, true); rcOn.rcParams.version = Tag111(1);
	rcOn.rcParams.averageBitRate = 90000000; rcOn.rcParams.maxBitRate = 100000000;
	rcOn.rcParams.rateControlMode = NV_ENC_PARAMS_RC_VBR;
	const auto savedRcOn = rcOn;
	NV_ENC_INITIALIZE_PARAMS rcInitOn = {}; rcInitOn.version = Tag111(5, true);
	rcInitOn.encodeGUID = NV_ENC_CODEC_H264_GUID; rcInitOn.encodeConfig = &rcOn;
	rcInitOn.frameRateNum = 90; rcInitOn.frameRateDen = 1;
	Check(NvencTapShims::InitializeEncoder(h264Enc, &rcInitOn) == NV_ENC_SUCCESS, "h264 rc: forceCbr on init delegated");
	Check(seenRcMode == NV_ENC_PARAMS_RC_CBR && seenKfScale == 2u, "h264 rc: forceCbr applies CBR + the configured kf scale");
	Check(seenMaxBitrate == 90000000u, "h264 rc: maxBitRate flattened to averageBitRate");
	Check(seenVbvSize == 2000000u, "h264 rc: configured 2-frame VBV applied (avg/90*2)");
	Check(memcmp(&rcOn, &savedRcOn, sizeof(rcOn)) == 0, "h264 rc: forceCbr on caller config fully restored");

	// vbvFrames=0 means "leave the streamer's value" (GUI tip promises it) — the
	// codec-1 pin is gone, so 0 must stay a no-op for H.264 like for every codec.
	h264RcCfg.forceCbr = false; h264RcCfg.vbvFrames = 0;
	NvencTap::Get().SetConfig(h264RcCfg);
	NV_ENC_CONFIG rcVbv0 = {}; rcVbv0.version = Tag111(7, true); rcVbv0.rcParams.version = Tag111(1);
	rcVbv0.rcParams.averageBitRate = 90000000; rcVbv0.rcParams.maxBitRate = 100000000;
	rcVbv0.rcParams.rateControlMode = NV_ENC_PARAMS_RC_VBR; rcVbv0.rcParams.vbvBufferSize = 2500000;
	const auto savedRcVbv0 = rcVbv0;
	NV_ENC_INITIALIZE_PARAMS rcInitVbv0 = {}; rcInitVbv0.version = Tag111(5, true);
	rcInitVbv0.encodeGUID = NV_ENC_CODEC_H264_GUID; rcInitVbv0.encodeConfig = &rcVbv0;
	rcInitVbv0.frameRateNum = 90; rcInitVbv0.frameRateDen = 1;
	Check(NvencTapShims::InitializeEncoder(h264Enc, &rcInitVbv0) == NV_ENC_SUCCESS, "h264 rc: vbvFrames=0 init delegated");
	Check(seenVbvSize == 2500000u, "h264 rc: vbvFrames=0 leaves the caller's VBV size untouched");
	Check(memcmp(&rcVbv0, &savedRcVbv0, sizeof(rcVbv0)) == 0, "h264 rc: vbvFrames=0 caller config fully restored");

	// Scaling 350 -> 500 Mbit must leave a zero-frame VBV request alone,
	// including large valid caller buffers which previously failed validation.
	h264RcCfg.bitrateMbit = 500; h264RcCfg.vrlinkClampMbit = 350;
	h264RcCfg.bitrateConstancyPct = 0;
	h264RcCfg.h264VbvInitialDelay = 123456;
	NvencTap::Get().SetConfig(h264RcCfg);
	rcVbv0.rcParams.averageBitRate = 350000000;
	rcVbv0.rcParams.maxBitRate = 350000000;
	rcVbv0.rcParams.vbvInitialDelay = 123456;
	for(uint32_t callerVbv : {2500000u, 4000000000u}){
		rcVbv0.rcParams.vbvBufferSize = callerVbv;
		const auto savedScaledConfig = rcVbv0;
		const auto savedScaledInit = rcInitVbv0;
		Check(NvencTapShims::InitializeEncoder(h264Enc, &rcInitVbv0) == NV_ENC_SUCCESS,
			"scaled VBV zero: initialization accepts caller buffer");
		Check(seenBitrate == 500000000u && seenVbvSize == callerVbv && seenVbvDelay == 123456u,
			"scaled VBV zero: 350->500 bitrate preserves buffer and initial delay");
		Check(memcmp(&rcVbv0, &savedScaledConfig, sizeof(rcVbv0)) == 0
			&& memcmp(&rcInitVbv0, &savedScaledInit, sizeof(rcInitVbv0)) == 0,
			"scaled VBV zero: complete init and config restored");
		NV_ENC_RECONFIGURE_PARAMS reconfigure = {}; reconfigure.version = Tag111(1, true);
		reconfigure.reInitEncodeParams = rcInitVbv0;
		const auto savedReconfigure = reconfigure;
		const auto oldStatus = reconfigureDriverStatus;
		reconfigureDriverStatus = NV_ENC_SUCCESS;
		Check(NvencTapShims::ReconfigureEncoder(h264Enc, &reconfigure) == NV_ENC_SUCCESS,
			"scaled VBV zero: reconfigure delegated");
		Check(seenBitrate == 500000000u && seenVbvSize == callerVbv && seenVbvDelay == 123456u,
			"scaled VBV zero: reconfigure preserves buffer and initial delay");
		Check(memcmp(&rcVbv0, &savedScaledConfig, sizeof(rcVbv0)) == 0
			&& memcmp(&reconfigure, &savedReconfigure, sizeof(reconfigure)) == 0,
			"scaled VBV zero: complete reconfigure and config restored");
		reconfigureDriverStatus = oldStatus;
	}
	h264RcCfg.vbvFrames = 2;
	NvencTap::Get().SetConfig(h264RcCfg);
	rcInitVbv0.frameRateNum = 15;
	const auto savedScaledConfig = rcVbv0;
	Check(NvencTapShims::InitializeEncoder(h264Enc, &rcInitVbv0) == NV_ENC_SUCCESS,
		"scaled positive VBV: large caller buffer does not reject explicit replacement");
	Check(seenBitrate == 500000000u && seenVbvSize == (uint32_t)(500000000.0 / 90.0 * 2)
		&& seenVbvDelay == 123456u, "scaled positive VBV: configured frames use nominal 90 FPS, delay preserved");
	Check(memcmp(&rcVbv0, &savedScaledConfig, sizeof(rcVbv0)) == 0,
		"scaled positive VBV: caller config restored");

	ConfigureCodec(true, 0);
}

NVENCSTATUS NVENCAPI CaptureCanonicalPreset(void*, GUID codec, GUID, NV_ENC_TUNING_INFO, NV_ENC_PRESET_CONFIG* preset){
	preset->presetCfg.rcParams.multiPass = (NV_ENC_MULTI_PASS)1;
	if(IsH264(codec)){ preset->presetCfg.encodeCodecConfig.h264Config.disableDeblockingFilterIDC = 2; }
	else if(CodecOfGuid(codec) == 2){ preset->presetCfg.encodeCodecConfig.av1Config.numTileRows = 2; }
	return NV_ENC_SUCCESS;
}
NVENCSTATUS NVENCAPI RejectCanonicalPreset(void*, GUID, GUID, NV_ENC_TUNING_INFO, NV_ENC_PRESET_CONFIG*){
	++rejectedPresetCalls;
	return NV_ENC_ERR_UNSUPPORTED_PARAM;
}

void CheckExplicitSettings(){
	Configure(true, 1);
	void* encoder = OpenSession();
	NV_ENC_CONFIG config = {}; config.version = Tag111(7, true); config.rcParams.version = Tag111(1);
	config.rcParams.averageBitRate = 42000000; config.rcParams.rateControlMode = NV_ENC_PARAMS_RC_VBR;
	config.encodeCodecConfig.hevcConfig.enableFillerDataInsertion = 1;
	NV_ENC_INITIALIZE_PARAMS init = {}; init.version = Tag111(5, true);
	init.encodeGUID = NV_ENC_CODEC_HEVC_GUID; init.encodeConfig = &config;
	init.frameRateNum = 90; init.frameRateDen = 1;
	const auto savedInit = init; const auto savedConfig = config;
	for(int tile : {0, -1, (std::numeric_limits<int>::max)()}){
		NvencTapConfig cfg; cfg.enabled = true; cfg.effectiveTileWidth = tile;
		NvencTap::Get().SetConfig(cfg); const int before = initDriverCalls;
		Check(NvencTapShims::InitializeEncoder(encoder, &init) == NV_ENC_ERR_INVALID_PARAM && initDriverCalls == before,
			"invalid requested tile: zero, negative or stacked-height overflow fails visibly before NVENC");
	}
	NvencTapConfig parseFailure; parseFailure.enabled = true; parseFailure.requestError = "Tile width must be an integer.";
	for(int codec : {0, 1, 2}){
		NvencTapConfig geometry; geometry.enabled = true; geometry.codec = codec; geometry.enforceTile = true;
		geometry.effectiveTileWidth = codec == 1 ? 1024 : 1536;
		NvencTap::Get().SetConfig(geometry);
		auto negotiated = init; negotiated.encodeWidth = 768; negotiated.encodeHeight = 3072;
		const auto original = negotiated; const auto originalConfig = config;
		void* geometryEncoder = codec == 2 ? OpenSession() : encoder;
		const int before = initDriverCalls;
		Check(NvencTapShims::InitializeEncoder(geometryEncoder, &negotiated) == NV_ENC_SUCCESS && initDriverCalls == before + 1,
			"startup allocation: every codec permits initialization before packed geometry is selected");
		Check(memcmp(&negotiated, &original, sizeof(original)) == 0 && memcmp(&config, &originalConfig, sizeof(config)) == 0,
			"startup allocation: caller parameters remain byte-exact");
		NV_ENC_RECONFIGURE_PARAMS mismatch = {}; mismatch.version = Tag111(1, true); mismatch.reInitEncodeParams = negotiated;
		const auto originalMismatch = mismatch; const int beforeMismatch = ordinaryCalls;
		Check(NvencTapShims::ReconfigureEncoder(geometryEncoder, &mismatch) == NV_ENC_ERR_INVALID_PARAM && ordinaryCalls == beforeMismatch,
			"active geometry downgrade: every codec rejects a packed frame different from the requested tile");
		Check(memcmp(&mismatch, &originalMismatch, sizeof(mismatch)) == 0,
			"active geometry rejection: caller parameters remain byte-exact");
		Check(NvencTap::Get().GetRuntimeState().error.find(std::to_string(geometry.effectiveTileWidth)) != std::string::npos,
			"active geometry rejection: UI error identifies requested dimensions");
		negotiated.encodeWidth = geometry.effectiveTileWidth; negotiated.encodeHeight = geometry.effectiveTileWidth * 4;
		Check(NvencTapShims::InitializeEncoder(geometryEncoder, &negotiated) == NV_ENC_SUCCESS,
			"exact requested geometry: all codec requests reach NVENC unchanged");
	}
	NvencTap::Get().SetConfig(parseFailure); const int beforeParse = initDriverCalls;
	Check(NvencTapShims::InitializeEncoder(encoder, &init) == NV_ENC_ERR_INVALID_PARAM && initDriverCalls == beforeParse
		&& NvencTap::Get().GetRuntimeState().error.find(parseFailure.requestError) == 0,
		"parser rejection: runtime surfaces original error without default substitution");
	NvencTapConfig highRate; highRate.enabled = true; highRate.bitrateMbit = 2500; highRate.bitrateConstancyPct = 100;
	NvencTap::Get().SetConfig(highRate);
	Check(NvencTapShims::InitializeEncoder(encoder, &init) == NV_ENC_SUCCESS && seenBitrate == 2500000000u,
		"requested bitrate above old 2000Mbps cap: exact representable value reaches NVENC");
	for(int codec : {0, 2}){
		NvencTapConfig inactiveRecipe; inactiveRecipe.enabled = true; inactiveRecipe.codec = codec;
		inactiveRecipe.h264SliceMode = 9; inactiveRecipe.h264RefFrames = -3;
		NvencTap::Get().SetConfig(inactiveRecipe);
		void* activeEncoder = codec == 2 ? OpenSession() : encoder;
		Check(NvencTapShims::InitializeEncoder(activeEncoder, &init) == NV_ENC_SUCCESS,
			"inactive H264 recipe: invalid retained H264 values do not prevent HEVC or AV1 initialization");
		Check(NvencTap::Get().GetConfig().h264SliceMode == 9 && NvencTap::Get().GetConfig().h264RefFrames == -3,
			"inactive H264 recipe: retained values remain user-authoritative without normalization");
		if(codec == 2){ Check(NvencTapShims::DestroyEncoder(activeEncoder) == NV_ENC_SUCCESS, "inactive H264 recipe: AV1 session destroyed"); }
	}
	for(int split = 5; split <= 14; ++split){
		NvencTapConfig cfg; cfg.enabled = true; cfg.splitMode = split;
		NvencTap::Get().SetConfig(cfg); const int before = initDriverCalls;
		Check(NvencTapShims::InitializeEncoder(encoder, &init) == NV_ENC_ERR_INVALID_PARAM,
			"invalid split: rejected instead of normalized to AUTO");
		Check(initDriverCalls == before && memcmp(&init, &savedInit, sizeof(init)) == 0
			&& memcmp(&config, &savedConfig, sizeof(config)) == 0, "invalid split: no NVENC call or caller mutation");
	}
	init = savedInit; config = savedConfig;
	NvencTapConfig cfg; cfg.enabled = true; cfg.codec = 1; cfg.multiPass = 2; cfg.preset = 7;
	cfg.h264GopFrames = 123; cfg.h264IdrFrames = 321; cfg.h264RefFrames = 7;
	cfg.h264Entropy = 2; cfg.h264SliceMode = 1; cfg.h264SliceData = 456;
	cfg.h264Aud = false; cfg.h264RepeatHeaders = false; cfg.h264DisableHeaders = true;
	cfg.h264BitstreamRestriction = false; cfg.h264VbvInitialDelay = 12345;
	const auto savedPresetFunction = origGetPresetConfigEx;
	origGetPresetConfigEx = CaptureCanonicalPreset;
	for(bool merge : {false, true}){
		cfg.presetMerge = merge; NvencTap::Get().SetConfig(cfg);
		Check(NvencTapShims::InitializeEncoder(encoder, &init) == NV_ENC_SUCCESS,
			"custom H264 recipe: valid explicit request accepted");
		Check(seenH264Gop == 123 && seenH264Idr == 321 && seenH264Recipe.maxNumRefFrames == 7
			&& seenH264Recipe.entropyCodingMode == NV_ENC_H264_ENTROPY_CODING_MODE_CAVLC
			&& seenH264Recipe.sliceMode == 1 && seenH264Recipe.sliceModeData == 456,
			"custom H264 recipe: GOP/IDR/references/entropy/slices honored");
		Check(seenH264Recipe.outputAUD == 0 && seenH264Recipe.repeatSPSPPS == 0 && seenH264Recipe.disableSPSPPS == 1
			&& seenH264Recipe.h264VUIParameters.bitstreamRestrictionFlag == 0 && seenMultiPass == 2 && seenVbvDelay == 12345,
			"custom H264 recipe: header flags and explicit multipass honored");
		Check(seenH264Recipe.disableDeblockingFilterIDC == 2,
			"canonical H264 seed: codec setup adopts canonical codec fields even with optional preset merge disabled");
		Check(memcmp(&init, &savedInit, sizeof(init)) == 0 && memcmp(&config, &savedConfig, sizeof(config)) == 0,
			"custom H264 recipe: complete caller data restored");
	}
	origGetPresetConfigEx = RejectCanonicalPreset;
	cfg.forceCbr = true; cfg.lowDelayKfScale = 3; cfg.vbvFrames = 2;
	cfg.bitrateMbit = 180; cfg.bitrateConstancyPct = 100; cfg.presetMerge = true; cfg.preset = 6;
	NvencTap::Get().SetConfig(cfg);
	const int rejectedPresetsBefore = rejectedPresetCalls;
	Check(NvencTapShims::InitializeEncoder(encoder, &init) == NV_ENC_SUCCESS,
		"preset lookup failure: valid target codec request still reaches NVENC");
	Check(rejectedPresetCalls > rejectedPresetsBefore,
		"preset lookup failure: exercise a real failed fetch rather than a cached successful preset");
	Check(seenBitrate == 180000000u && seenMaxBitrate == 180000000u
		&& seenRcMode == NV_ENC_PARAMS_RC_CBR && seenKfScale == 3u && seenVbvSize == 4000000u
		&& seenMultiPass == 2 && seenH264Gop == 123u && seenH264Idr == 321u && seenH264Recipe.maxNumRefFrames == 7u,
		"preset lookup failure: explicit bitrate, CBR, VBV, multipass and H264 recipe are all honored");
	Check(memcmp(&init, &savedInit, sizeof(init)) == 0 && memcmp(&config, &savedConfig, sizeof(config)) == 0,
		"preset lookup failure: full caller configuration restored");
	origGetPresetConfigEx = CaptureCanonicalPreset;
	cfg = NvencTapConfig{}; cfg.enabled = true; cfg.codec = 2; cfg.preset = 7; cfg.presetMerge = false;
	NvencTap::Get().SetConfig(cfg); void* seededAv1 = OpenSession();
	Check(NvencTapShims::InitializeEncoder(seededAv1, &init) == NV_ENC_SUCCESS && seenAv1Config.numTileRows == 2,
		"canonical AV1 seed: optional merge OFF still uses the target codec recipe");
	Check(memcmp(&init, &savedInit, sizeof(init)) == 0 && memcmp(&config, &savedConfig, sizeof(config)) == 0,
		"canonical AV1 seed: caller bytes restored");
	Check(NvencTapShims::DestroyEncoder(seededAv1) == NV_ENC_SUCCESS, "canonical AV1 seed: session destroyed");
	origGetPresetConfigEx = savedPresetFunction;
	for(int codec : {0, 1, 2}){
		cfg = NvencTapConfig{}; cfg.enabled = true; cfg.codec = codec;
		cfg.vuiFullRange = 0; cfg.vuiMatrix = 1; cfg.vuiPrimaries = 1; cfg.vuiTransfer = 13;
		NvencTap::Get().SetConfig(cfg); void* vuiEncoder = codec == 2 ? OpenSession() : encoder;
		Check(NvencTapShims::InitializeEncoder(vuiEncoder, &init) == NV_ENC_SUCCESS, "manual VUI: accepted for every codec");
		if(codec == 2){
			Check(seenAv1Config.colorRange == 0 && seenAv1Config.matrixCoefficients == 1
				&& seenAv1Config.colorPrimaries == 1 && seenAv1Config.transferCharacteristics == 13,
				"manual VUI: AV1 color metadata honors explicit fields");
		}else{
			const auto& vui = codec == 1 ? seenH264Recipe.h264VUIParameters : seenHevcVui;
			Check(vui.videoFullRangeFlag == 0 && vui.colourMatrix == 1 && vui.colourPrimaries == 1
				&& vui.transferCharacteristics == 13 && vui.videoSignalTypePresentFlag && vui.colourDescriptionPresentFlag,
				"manual VUI: H264/HEVC fields and presence flags honor request");
		}
		Check(memcmp(&init, &savedInit, sizeof(init)) == 0 && memcmp(&config, &savedConfig, sizeof(config)) == 0,
			"manual VUI: complete caller bytes restored");
	}
	cfg = NvencTapConfig{}; cfg.enabled = true; cfg.qpFovea = -200;
	NvencTap::Get().SetConfig(cfg);
	NV_ENC_PIC_PARAMS picture = {}; picture.version = Tag111(4, true); picture.inputBuffer = reinterpret_cast<void*>(1);
	picture.inputWidth = 64; picture.inputHeight = 64;
	const auto savedPicture = picture; const int beforePicture = ordinaryCalls;
	Check(NvencTapShims::EncodePicture(encoder, &picture) == NV_ENC_ERR_INVALID_PARAM && ordinaryCalls == beforePicture,
		"invalid QP delta: hot reload rejects without encoding or integer wrap");
	Check(memcmp(&picture, &savedPicture, sizeof(picture)) == 0, "invalid QP delta: caller picture unchanged");
	Check(NvencTap::Get().GetRuntimeState().lastPictureStatus == NV_ENC_ERR_INVALID_PARAM
		&& !NvencTap::Get().GetRuntimeState().pictureError.empty() && NvencTap::Get().GetRuntimeState().error.empty(),
		"picture validation failure: separate visible picture error preserves successful configuration state");
	cfg.qpFovea = -10; cfg.qpPeriphery = 10; cfg.qpEdgeFalloff = std::numeric_limits<float>::quiet_NaN();
	NvencTap::Get().SetConfig(cfg); const int beforeInit = initDriverCalls;
	Check(NvencTapShims::InitializeEncoder(encoder, &init) == NV_ENC_ERR_INVALID_PARAM && initDriverCalls == beforeInit,
		"NaN QP falloff: initialization rejected before driver call");
	for(float edge : {0.0f, 1.0f}){
		cfg.qpEdgeFalloff = edge; NvencTap::Get().SetConfig(cfg);
		Check(NvencTapShims::InitializeEncoder(encoder, &init) == NV_ENC_SUCCESS,
			"QP map: documented endpoints accepted without normalization");
	}
	Check(!NvencTap::Get().GetRuntimeState().pictureError.empty(),
		"successful initialization does not clear unresolved picture failure");
	encodeDriverStatus = NV_ENC_SUCCESS;
	Check(NvencTapShims::EncodePicture(encoder, &picture) == NV_ENC_SUCCESS
		&& NvencTap::Get().GetRuntimeState().lastPictureStatus == 0 && NvencTap::Get().GetRuntimeState().pictureError.empty(),
		"successful picture clears its own error state");
	encodeDriverStatus = NV_ENC_ERR_GENERIC;
	Check(NvencTapShims::EncodePicture(encoder, &picture) == NV_ENC_ERR_GENERIC
		&& NvencTap::Get().GetRuntimeState().lastPictureStatus == NV_ENC_ERR_GENERIC,
		"actual encode rejection surfaces separate picture status");
	Check(NvencTapShims::DestroyEncoder(encoder) == NV_ENC_SUCCESS, "successful encoder destroy accepted");
	const auto destroyed = NvencTap::Get().GetRuntimeState();
	Check(destroyed.effectiveCodec == -1 && destroyed.effectiveRateControl == -1
		&& destroyed.encodeWidth == 0 && destroyed.encodeHeight == 0 && destroyed.error.empty() && destroyed.pictureError.empty(),
		"successful encoder destroy: no stale effective state or error");
	Configure(true, 0);
}
void CheckDeltaMapConversion(){
	// H.264: vrlink's HEVC-grid (32x32 CTB) per-frame map must be adapted to
	// the 16x16 MB grid (2x2 replication, clamp [-51,51], bottom-left timing
	// tile pinned) - a smaller map fails the encode with status 14.
	auto makePic = [](uint32_t w, uint32_t h, int8_t* map, uint32_t size) -> NV_ENC_PIC_PARAMS {
		NV_ENC_PIC_PARAMS p = {};
		p.version = Tag111(4, true);
		p.inputBuffer = reinterpret_cast<void*>(9); p.outputBitstream = reinterpret_cast<void*>(10);
		p.inputWidth = w; p.inputHeight = h;
		*reinterpret_cast<int8_t**>(reinterpret_cast<unsigned char*>(&p) + kQpDeltaMap11Offset) = map;
		*reinterpret_cast<uint32_t*>(reinterpret_cast<unsigned char*>(&p) + kQpDeltaMapSize11Offset) = size;
		return p;
	};

	// upgraded (12.1 ABI) session, H.264 selected
	NvencTapConfig h264Cfg; h264Cfg.enabled = true; h264Cfg.codec = 1; h264Cfg.splitMode = 1;
	NvencTap::Get().SetConfig(h264Cfg);
	void* h264Enc = OpenSession();
	Check(Upgraded(h264Enc), "delta map: H264 session upgraded");

	// 64x64 frame: 32x32 grid = 4 caller entries, 16x16 grid = 16 entries.
	// values exercise the clamp (10, -70 -> -51, 60 -> 51, 5) and the
	// timing-tile pin (rows 2..3 x columns 0..1 = -51).
	int8_t src[4] = { 10, -70, 60, 5 };
	NV_ENC_PIC_PARAMS pic = makePic(64, 64, src, 4);
	const auto savedPic = pic;
	Check(NvencTapShims::EncodePicture(h264Enc, &pic) == NV_ENC_ERR_GENERIC, "delta map: H264 encode delegated");
	Check(seenPictureVersion == Tag121(6, true), "delta map: converted call carries the 12.1 ABI");
	Check(seenEncodeMapSize == 16u, "delta map: 4-entry CTB map converted to the 16-entry MB count");
	{
		const int8_t expected[16] = { 10, 10, -51, -51, 10, 10, -51, -51, -51, -51, 5, 5, -51, -51, 5, 5 };
		bool same = seenEncodeMapSize == 16u;
		for(int i = 0; same && i < 16; i++){ same = seenEncodeMapBytes[i] == expected[i]; }
		Check(same, "delta map: 2x2 replication + clamp + timing-tile pin exact");
	}
	Check(memcmp(&pic, &savedPic, sizeof(pic)) == 0, "delta map: caller picture bytes unchanged");

	// null map: nothing attached stays nothing
	NV_ENC_PIC_PARAMS picNull = makePic(64, 64, nullptr, 0);
	Check(NvencTapShims::EncodePicture(h264Enc, &picNull) == NV_ENC_ERR_GENERIC, "delta map: null-map encode delegated");
	Check(seenEncodeMap == nullptr && seenEncodeMapSize == 0u, "delta map: null map stays unset");

	// already on the H.264 grid: passed through untouched
	int8_t mb16[16];
	for(int i = 0; i < 16; i++){ mb16[i] = (int8_t)(i - 8); }
	NV_ENC_PIC_PARAMS picMb = makePic(64, 64, mb16, 16);
	Check(NvencTapShims::EncodePicture(h264Enc, &picMb) == NV_ENC_ERR_GENERIC, "delta map: MB-grid encode delegated");
	Check(seenEncodeMap == mb16 && seenEncodeMapSize == 16u, "delta map: MB-grid map passes through untouched");

	// unrecognized size: dropped (an unconvertible map would fail the encode)
	NV_ENC_PIC_PARAMS picOdd = makePic(64, 64, src, 7);
	Check(NvencTapShims::EncodePicture(h264Enc, &picOdd) == NV_ENC_ERR_GENERIC, "delta map: odd-size encode delegated");
	Check(seenEncodeMap == nullptr && seenEncodeMapSize == 0u, "delta map: unrecognized size is dropped");

	// EOS-style flush (no input buffer): the map is detached (no picture;
	// a wrong-size surface must not fail the flush - SF skips it too)
	NV_ENC_PIC_PARAMS picEos = makePic(64, 64, src, 4);
	picEos.inputBuffer = nullptr; picEos.outputBitstream = nullptr;
	Check(NvencTapShims::EncodePicture(h264Enc, &picEos) == NV_ENC_ERR_GENERIC, "delta map: EOS encode delegated");
	Check(seenEncodeMap == nullptr && seenEncodeMapSize == 0u, "delta map: EOS frame map detached");

	// HEVC keeps the caller map verbatim (regression guard), including on
	// the EOS flush - the HEVC path is unmodified end to end
	NvencTapConfig hevcCfg; hevcCfg.enabled = true; hevcCfg.codec = 0; hevcCfg.splitMode = 1;
	NvencTap::Get().SetConfig(hevcCfg);
	void* hevcEnc = OpenSession();
	Check(Upgraded(hevcEnc), "delta map: HEVC session upgraded");
	NV_ENC_PIC_PARAMS picHevc = makePic(64, 64, src, 4);
	Check(NvencTapShims::EncodePicture(hevcEnc, &picHevc) == NV_ENC_ERR_GENERIC, "delta map: HEVC encode delegated");
	Check(seenEncodeMap == src && seenEncodeMapSize == 4u, "delta map: HEVC map passed through verbatim");
	NV_ENC_PIC_PARAMS picHevcEos = makePic(64, 64, src, 4);
	picHevcEos.inputBuffer = nullptr; picHevcEos.outputBitstream = nullptr;
	Check(NvencTapShims::EncodePicture(hevcEnc, &picHevcEos) == NV_ENC_ERR_GENERIC, "delta map: HEVC EOS encode delegated");
	Check(seenEncodeMap == src && seenEncodeMapSize == 4u, "delta map: HEVC EOS map untouched (HEVC path unmodified)");

	// AV1: 64x64 SB grid; per-SB min of the 2x2 source block, x4, clamp
	// [-128,124]; bottom-left SB pinned to -128 (legacy_api_bridge.cpp:240-252)
	NvencTapConfig av1Cfg; av1Cfg.enabled = true; av1Cfg.codec = 2; av1Cfg.splitMode = 1;
	NvencTap::Get().SetConfig(av1Cfg);
	void* av1Enc = OpenSession();
	Check(Upgraded(av1Enc), "delta map: AV1 session upgraded");
	// 128x128: source CTB grid 4x4 = 16 entries; SB grid 2x2 = 4 entries
	int8_t av1src[16] = { 10, 10, 5, 7,  -70, 10, 5, 7,  31, 31, -32, 0,  31, 31, 0, -32 };
	NV_ENC_PIC_PARAMS picAv1 = makePic(128, 128, av1src, 16);
	Check(NvencTapShims::EncodePicture(av1Enc, &picAv1) == NV_ENC_ERR_GENERIC, "delta map: AV1 encode delegated");
	Check(seenEncodeMapSize == 4u, "delta map: AV1 16-entry CTB map converted to the 4-entry SB count");
	{
		const int8_t expected[4] = { -128, 20, -128, -128 }; // SB00 min -70 x4 clamp; SB10 min 5 x4; SB01 pin; SB11 min -32 x4
		bool same = seenEncodeMapSize == 4u;
		for(int i = 0; same && i < 4; i++){ same = seenEncodeMapBytes[i] == expected[i]; }
		Check(same, "delta map: AV1 min-aggregation + x4 + clamp + SB pin exact");
	}
	NV_ENC_PIC_PARAMS picAv1Eos = makePic(128, 128, av1src, 16);
	picAv1Eos.inputBuffer = nullptr; picAv1Eos.outputBitstream = nullptr;
	Check(NvencTapShims::EncodePicture(av1Enc, &picAv1Eos) == NV_ENC_ERR_GENERIC, "delta map: AV1 EOS encode delegated");
	Check(seenEncodeMap == nullptr && seenEncodeMapSize == 0u, "delta map: AV1 EOS frame map detached");

	// non-upgraded H.264 session: the direct path swaps the raw 11.1 fields
	// for the call and restores them after
	NvencTapConfig directCfg; directCfg.enabled = true; directCfg.codec = 1; directCfg.splitMode = 0;
	NvencTap::Get().SetConfig(directCfg);
	void* directEnc = OpenSession();
	Check(!Upgraded(directEnc), "delta map: direct-mode session stays stock 11.1");
	NV_ENC_PIC_PARAMS picDirect = makePic(64, 64, src, 4);
	const auto savedDirect = picDirect;
	Check(NvencTapShims::EncodePicture(directEnc, &picDirect) == NV_ENC_ERR_GENERIC, "delta map: direct-mode encode delegated");
	Check(seenEncodeMapSize == 16u, "delta map: direct-mode conversion applies");
	Check(memcmp(&picDirect, &savedDirect, sizeof(picDirect)) == 0, "delta map: direct-mode caller fields restored");

	// the tap's own foveation map still wins over the caller's (codec-aware
	// 16x16 grid), and its frames are counted
	NvencTapConfig foveaCfg; foveaCfg.enabled = true; foveaCfg.codec = 1; foveaCfg.splitMode = 1;
	foveaCfg.qpFovea = -8; foveaCfg.qpPeriphery = 4;
	NvencTap::Get().SetConfig(foveaCfg);
	NV_ENC_PIC_PARAMS picFov = makePic(64, 64, src, 4);
	const auto qpFramesBefore = NvencTap::Get().GetStats().qpMapFrames;
	Check(NvencTapShims::EncodePicture(h264Enc, &picFov) == NV_ENC_ERR_GENERIC, "delta map: fovea encode delegated");
	Check(seenEncodeMap != src && seenEncodeMapSize == 16u, "delta map: tap foveation map replaces the caller map (16x16 grid)");
	Check(NvencTap::Get().GetStats().qpMapFrames == qpFramesBefore + 1, "delta map: foveation frame counted");
	ConfigureCodec(true, 0);
}

void CheckMapSubmissionLifetime(){
	// The fake NVIDIA call deliberately submits another picture before it
	// finishes reading the first map. This exercises ownership at the actual
	// shim boundary, including the ABI adapter and direct caller restoration.
	const auto savedEncode = origEncodePicture;
	origEncodePicture = EncodeMapCallback;
	auto makePic = [](uint32_t frame, int8_t* map, uint32_t size, uint32_t width, uint32_t height){
		NV_ENC_PIC_PARAMS p = {}; p.version = Tag111(4, true);
		p.inputBuffer = reinterpret_cast<void*>(9); p.frameIdx = frame;
		p.inputWidth = width; p.inputHeight = height;
		*reinterpret_cast<int8_t**>(reinterpret_cast<unsigned char*>(&p) + kQpDeltaMap11Offset) = map;
		*reinterpret_cast<uint32_t*>(reinterpret_cast<unsigned char*>(&p) + kQpDeltaMapSize11Offset) = size;
		return p;
	};
	auto deliveredMap = [](const NV_ENC_PIC_PARAMS* p){
		if(Is111(p->version)){
			return std::make_pair(*reinterpret_cast<int8_t* const*>(reinterpret_cast<const unsigned char*>(p) + kQpDeltaMap11Offset),
				*reinterpret_cast<const uint32_t*>(reinterpret_cast<const unsigned char*>(p) + kQpDeltaMapSize11Offset));
		}
		return std::make_pair(p->qpDeltaMap, p->qpDeltaMapSize);
	};
	for(int kind : {0, 1, 2}){
		NvencTapConfig cfg; cfg.enabled = true; cfg.codec = kind == 1 ? 2 : 1;
		// Exercise both direct (H.264) and upgraded (AV1/generated) paths.
		cfg.splitMode = kind == 0 ? 0 : 1;
		if(kind == 2){ cfg.qpFovea = -8; cfg.qpPeriphery = 4; cfg.qpEdgeFalloff = 0; }
		NvencTap::Get().SetConfig(cfg);
		void* encoder = OpenSession();
		int8_t outerSource[16] = {10, -70, 60, 5};
		int8_t innerSource[16] = {-7, -7, -7, -7, -7, -7, -7, -7, -7, -7, -7, -7, -7, -7, -7, -7};
		std::vector<int8_t> expected;
		uint32_t width = 64, height = 64, sourceSize = 4;
		if(kind == 0){ expected = {10, 10, -51, -51, 10, 10, -51, -51, -51, -51, 5, 5, -51, -51, 5, 5}; }
		if(kind == 1){
			width = height = 128; sourceSize = 16;
			const int8_t source[16] = {10, 10, 5, 7, -70, 10, 5, 7, 31, 31, -32, 0, 31, 31, 0, -32};
			std::copy(source, source + 16, outerSource);
			expected = {-128, 20, -128, -128};
		}
		if(kind == 2){ height = 128; expected.assign(16, -8); expected.insert(expected.end(), 16, 4); }
		auto outer = makePic(201, outerSource, sourceSize, width, height);
		auto inner = makePic(202, innerSource, sourceSize, width, height);
		const auto savedOuter = outer, savedInner = inner;
		NvencTapConfig innerConfig = cfg;
		if(kind == 2){ innerConfig.qpFovea = 7; innerConfig.qpPeriphery = 9; }
		bool beforeMatches = false, afterMatches = false, innerDistinct = false;
		encodeMapCallback = [&](void*, NV_ENC_PIC_PARAMS* p){
			auto map = deliveredMap(p);
			if(p->frameIdx == 202){
				innerDistinct = map.first && map.second && map.first[0] == (kind == 1 ? -28 : kind == 2 ? 7 : -7);
				return NV_ENC_ERR_GENERIC;
			}
			beforeMatches = map.first && map.second == expected.size() && std::equal(expected.begin(), expected.end(), map.first);
			NvencTap::Get().SetConfig(innerConfig);
			NvencTapShims::EncodePicture(encoder, &inner);
			afterMatches = beforeMatches && std::equal(expected.begin(), expected.end(), map.first);
			return NV_ENC_ERR_GENERIC;
		};
		Check(NvencTapShims::EncodePicture(encoder, &outer) == NV_ENC_ERR_GENERIC,
			"map lifetime: reentrant NVIDIA failure returned unchanged");
		Check(beforeMatches && innerDistinct && afterMatches,
			"map lifetime: nested H264/AV1/generated map does not overwrite in-flight bytes");
		Check(memcmp(&outer, &savedOuter, sizeof(outer)) == 0 && memcmp(&inner, &savedInner, sizeof(inner)) == 0,
			"map lifetime: nested caller pictures fully restored");

		// Keep the first NVIDIA call in flight until a second thread has
		// converted its map. Promises give a deterministic overlap without
		// racing the fixture's usual global capture fields or log counter.
		NvencTap::Get().SetConfig(cfg);
		std::promise<void> entered, release;
		auto enteredFuture = entered.get_future();
		auto releaseFuture = release.get_future().share();
		encodeMapCallback = [&](void*, NV_ENC_PIC_PARAMS* p){
			auto map = deliveredMap(p);
			if(p->frameIdx == 202){ return NV_ENC_SUCCESS; }
			entered.set_value();
			releaseFuture.wait();
			afterMatches = map.first && map.second == expected.size() && std::equal(expected.begin(), expected.end(), map.first);
			return NV_ENC_ERR_GENERIC;
		};
		auto first = std::async(std::launch::async, [&]{ return NvencTapShims::EncodePicture(encoder, &outer); });
		const bool firstEntered = enteredFuture.wait_for(std::chrono::seconds(5)) == std::future_status::ready;
		NvencTap::Get().SetConfig(innerConfig);
		auto second = std::async(std::launch::async, [&]{ return NvencTapShims::EncodePicture(encoder, &inner); });
		const bool overlapped = second.wait_for(std::chrono::seconds(5)) == std::future_status::ready;
		release.set_value();
		Check(first.get() == NV_ENC_ERR_GENERIC && second.get() == NV_ENC_SUCCESS && firstEntered && overlapped,
			"map lifetime: another encode completes while NVIDIA holds the first map");
		Check(afterMatches, "map lifetime: concurrent H264/AV1/generated conversion preserves the first map");
		Check(memcmp(&outer, &savedOuter, sizeof(outer)) == 0 && memcmp(&inner, &savedInner, sizeof(inner)) == 0,
			"map lifetime: concurrent caller pictures fully restored");
		Check(NvencTapShims::DestroyEncoder(encoder) == NV_ENC_SUCCESS, "map lifetime: fixture session destroyed");
	}
	origEncodePicture = savedEncode;
	encodeMapCallback = {};
	ConfigureCodec(true, 0);
}

void CheckSessionCodecGating(){
	// The per-frame map paths must key off the LIVE session codec, not the
	// tap config: a swap that fails at init and falls back to vrlink's
	// pristine params leaves an HEVC session live under a codec-1 config,
	// and an MB-grid map would fail every one of its frames (status 14).
	auto makePic = [](uint32_t w, uint32_t h, int8_t* map, uint32_t size) -> NV_ENC_PIC_PARAMS {
		NV_ENC_PIC_PARAMS p = {};
		p.version = Tag111(4, true);
		p.inputBuffer = reinterpret_cast<void*>(9); p.outputBitstream = reinterpret_cast<void*>(10);
		p.inputWidth = w; p.inputHeight = h;
		*reinterpret_cast<int8_t**>(reinterpret_cast<unsigned char*>(&p) + kQpDeltaMap11Offset) = map;
		*reinterpret_cast<uint32_t*>(reinterpret_cast<unsigned char*>(&p) + kQpDeltaMapSize11Offset) = size;
		return p;
	};

	// An explicit rejected swap returns the real error with one call and
	// byte-exact restoration. It never starts a different HEVC session.
	NvencTapConfig h264Cfg; h264Cfg.enabled = true; h264Cfg.codec = 1; h264Cfg.splitMode = 1;
	NvencTap::Get().SetConfig(h264Cfg);
	void* enc = OpenSession();
	NV_ENC_CONFIG cfg = {}; cfg.version = Tag111(7, true); cfg.rcParams.version = Tag111(1);
	cfg.rcParams.averageBitRate = 42000000; cfg.gopLength = 60; cfg.profileGUID = NV_ENC_HEVC_PROFILE_MAIN_GUID;
	NV_ENC_INITIALIZE_PARAMS init = {}; init.version = Tag111(5, true);
	init.encodeGUID = NV_ENC_CODEC_HEVC_GUID; init.encodeConfig = &cfg;
	init.frameRateNum = 90; init.frameRateDen = 1;
	const auto savedInit = init; const auto savedCfg = cfg;
	failNextInit = true;
	const int callsBefore = initDriverCalls;
	const auto statsBefore = NvencTap::Get().GetStats();
	Check(NvencTapShims::InitializeEncoder(enc, &init) == NV_ENC_ERR_INVALID_PARAM, "rejected swap: actual NVENC error returned");
	Check(initDriverCalls == callsBefore + 1, "rejected swap: one call, no pristine HEVC retry");
	Check(memcmp(&init, &savedInit, sizeof(init)) == 0 && memcmp(&cfg, &savedCfg, sizeof(cfg)) == 0,
		"rejected swap: entire caller init and config restored");
	Check(NvencTap::Get().GetStats().initFailedThenPristineOk == statsBefore.initFailedThenPristineOk,
		"rejected swap: no successful fallback counter");
	const auto rejected = NvencTap::Get().GetRuntimeState();
	Check(rejected.lastStatus == NV_ENC_ERR_INVALID_PARAM && !rejected.error.empty() && rejected.effectiveCodec == -1,
		"rejected swap: UI state reports failure, no effective codec");
	NvencTap::Get().SetConfig(h264Cfg);
	Check(!NvencTap::Get().GetRuntimeState().error.empty(), "rejected swap: config publication does not hide failure");
	Check(NvencTapShims::InitializeEncoder(enc, &init) == NV_ENC_SUCCESS, "rejected swap: later successful apply allowed");
	Check(NvencTap::Get().GetRuntimeState().lastStatus == 0 && NvencTap::Get().GetRuntimeState().error.empty()
		&& NvencTap::Get().GetRuntimeState().effectiveCodec == 1, "successful apply: runtime error clears and H264 is confirmed");
	NV_ENC_RECONFIGURE_PARAMS reconf = {}; reconf.version = Tag111(1, true); reconf.reInitEncodeParams = init;
	const auto savedReconf = reconf; const int reconfBefore = ordinaryCalls;
	Check(NvencTapShims::ReconfigureEncoder(enc, &reconf) == NV_ENC_ERR_GENERIC, "reconfigure rejection: real error returned");
	Check(ordinaryCalls == reconfBefore + 1, "reconfigure rejection: one driver call, no HEVC retry");
	Check(memcmp(&reconf, &savedReconf, sizeof(reconf)) == 0 && memcmp(&cfg, &savedCfg, sizeof(cfg)) == 0,
		"reconfigure rejection: complete caller bytes restored");
	Check(NvencTapShims::DestroyEncoder(enc) == NV_ENC_SUCCESS, "rejected session: destroy delegates");
	const auto destroyed = NvencTap::Get().GetRuntimeState();
	Check(destroyed.effectiveCodec == -1 && destroyed.encodeWidth == 0 && !destroyed.error.empty(),
		"destroy: stale codec/geometry cleared while unresolved rejection remains visible");
	int8_t src[4] = { 1, -2, 3, -4 };
	// a SUCCESSFUL swap records the live codec and drives the conversion;
	// gop/idr follow forceFps, not the caller's drifting measured rate
	NvencTapConfig swapCfg; swapCfg.enabled = true; swapCfg.codec = 1; swapCfg.splitMode = 1; swapCfg.forceFps = 90;
	NvencTap::Get().SetConfig(swapCfg);
	void* enc2 = OpenSession();
	NV_ENC_CONFIG cfg2 = {}; cfg2.version = Tag111(7, true); cfg2.rcParams.version = Tag111(1);
	cfg2.rcParams.averageBitRate = 42000000; cfg2.gopLength = 60; cfg2.profileGUID = NV_ENC_HEVC_PROFILE_MAIN_GUID;
	NV_ENC_INITIALIZE_PARAMS init2 = {}; init2.version = Tag111(5, true);
	init2.encodeGUID = NV_ENC_CODEC_HEVC_GUID; init2.encodeConfig = &cfg2;
	init2.frameRateNum = 89; init2.frameRateDen = 1;   // measured-rate drift: forceFps must win
	Check(NvencTapShims::InitializeEncoder(enc2, &init2) == NV_ENC_SUCCESS, "session codec: H264 swap init delegated");
	Check(seenH264Gop == 90u && seenH264Idr == 90u, "session codec: gop/idr follow forceFps, not the drifting caller rate");
	NV_ENC_PIC_PARAMS pic2 = makePic(64, 64, src, 4);
	Check(NvencTapShims::EncodePicture(enc2, &pic2) == NV_ENC_ERR_GENERIC, "session codec: swapped-session encode delegated");
	Check(seenEncodeMapSize == 16u, "session codec: live-codec record drives the MB conversion on the swapped session");

	// the tap's own foveation map builds on the codec's grid: 64x64 SB for
	// AV1 (a 32-grid map would be status-14 class on a live AV1 session)
	NvencTapConfig fovAv1; fovAv1.enabled = true; fovAv1.codec = 2; fovAv1.splitMode = 1;
	fovAv1.qpFovea = -8; fovAv1.qpPeriphery = 4;
	NvencTap::Get().SetConfig(fovAv1);
	void* av1Enc = OpenSession();
	NV_ENC_PIC_PARAMS picFov = makePic(128, 128, nullptr, 0);
	Check(NvencTapShims::EncodePicture(av1Enc, &picFov) == NV_ENC_ERR_GENERIC, "session codec: AV1 fovea encode delegated");
	Check(seenEncodeMap != nullptr && seenEncodeMapSize == 4u, "session codec: AV1 foveation map on the 64x64 SB grid");
	ConfigureCodec(true, 0);
}

NVENCSTATUS NVENCAPI CaptureOpen(NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS* params, void** encoder){
	openApis.push_back(params->apiVersion);
	openVersions.push_back(params->version);
	if(rejectOpenUpgrade && params->apiVersion == kApi121){ return NV_ENC_ERR_INVALID_VERSION; }
	*encoder = reinterpret_cast<void*>(nextHandle++);
	return NV_ENC_SUCCESS;
}

NVENCSTATUS NVENCAPI CaptureList(NV_ENCODE_API_FUNCTION_LIST* list){
	listVersions.push_back(list ? list->version : 0);
	if(!list){ return NV_ENC_ERR_INVALID_PTR; }
	if(rejectListUpgrade && (list->version & 0xffffu) == 12u){ return NV_ENC_ERR_INVALID_VERSION; }
	return NV_ENC_SUCCESS;
}

NVENCSTATUS NVENCAPI CaptureCaps(void*, GUID guid, NV_ENC_CAPS_PARAM* params, int* value){
	++capsCalls;
	seenCapsGuid = guid;
	seenCapsVersion = params->version;
	*value = 1;
	if(params->capsToQuery == NV_ENC_CAPS_SUPPORT_CONSTRAINED_ENCODING){ *value = IsHevc(guid) ? 1 : 0; }
	if(params->capsToQuery == NV_ENC_CAPS_WIDTH_MAX || params->capsToQuery == NV_ENC_CAPS_HEIGHT_MAX){
		*value = IsH264(guid) ? 4096 : 8192;
		if(strictCapabilities){ directGeometryCaps.push_back(guid); }
	}
	return NV_ENC_SUCCESS;
}

NVENCSTATUS NVENCAPI CaptureInit(void*, NV_ENC_INITIALIZE_PARAMS* params){
	++initDriverCalls;
	if(!params){ return NV_ENC_ERR_INVALID_PTR; }
	if(failNextInit){ failNextInit = false; return NV_ENC_ERR_INVALID_PARAM; }
	if(nextInitStatus != NV_ENC_SUCCESS){ const auto status = nextInitStatus; nextInitStatus = NV_ENC_SUCCESS; return status; }
	if(strictCapabilities){
		const uint32_t limit = IsH264(params->encodeGUID) ? 4096u : 8192u;
		if(params->encodeWidth > limit || params->encodeHeight > limit
			|| params->maxEncodeWidth > limit || params->maxEncodeHeight > limit){ return NV_ENC_ERR_INVALID_PARAM; }
	}
	seenInitVersion = params->version;
	seenInitFlags = *((uint32_t*)&params->enablePTD + 1);
	seenTuning = (uint32_t)params->tuningInfo;
	// 2026-10-13 codec override capture: GUID/profile always, codec fields
	// per the GUID the encoder actually receives. 2026-10-16: the
	// observe-only init arrives WITHOUT an encodeConfig (valid NVENC usage)
	// — capture a cleared config view and never dereference null.
	seenCodecGuid = params->encodeGUID;
	seenEncodeW = params->encodeWidth; seenEncodeH = params->encodeHeight;
	seenMaxEncodeW = params->maxEncodeWidth; seenMaxEncodeH = params->maxEncodeHeight;
	seenConfigVersion = 0; seenRcVersion = 0; seenLevel = 0; seenBitrate = 0;
	seenRcMode = 0; seenKfScale = 0; seenMaxBitrate = 0; seenVbvSize = 0; seenVbvDelay = 0;
	seenMultiPass = 0; seenProfileGuid = GUID{};
	seenH264Level = 0xdeadbeefu; seenAv1Level = 0xdeadbeefu;
	if(!params->encodeConfig){
		seenH264Recipe = NV_ENC_CONFIG_H264{}; seenAv1Config = NV_ENC_CONFIG_AV1{}; seenHevcVui = NV_ENC_CONFIG_HEVC_VUI_PARAMETERS{};
		return NV_ENC_SUCCESS;
	}
	seenConfigVersion = params->encodeConfig->version;
	seenRcVersion = params->encodeConfig->rcParams.version;
	seenLevel = params->encodeConfig->encodeCodecConfig.hevcConfig.level;
	seenBitrate = params->encodeConfig->rcParams.averageBitRate;
	seenRcMode = (uint32_t)params->encodeConfig->rcParams.rateControlMode;
	seenKfScale = (uint32_t)params->encodeConfig->rcParams.lowDelayKeyFrameScale;
	seenMaxBitrate = params->encodeConfig->rcParams.maxBitRate;
	seenVbvSize = params->encodeConfig->rcParams.vbvBufferSize;
	seenVbvDelay = params->encodeConfig->rcParams.vbvInitialDelay;
	seenMultiPass = (uint32_t)params->encodeConfig->rcParams.multiPass;
	seenProfileGuid = params->encodeConfig->profileGUID;
	if(memcmp(&params->encodeGUID, &NV_ENC_CODEC_H264_GUID, sizeof(GUID)) == 0){
		seenH264Recipe = params->encodeConfig->encodeCodecConfig.h264Config;
		seenH264Level = params->encodeConfig->encodeCodecConfig.h264Config.level;
		seenH264BitDepth = (uint32_t)params->encodeConfig->encodeCodecConfig.h264Config.outputBitDepth;
		seenH264RepeatSpsPps = params->encodeConfig->encodeCodecConfig.h264Config.repeatSPSPPS;
		seenH264Gop = params->encodeConfig->gopLength;
		seenH264Idr = params->encodeConfig->encodeCodecConfig.h264Config.idrPeriod;
	}else if(memcmp(&params->encodeGUID, &NV_ENC_CODEC_AV1_GUID, sizeof(GUID)) == 0){
		seenAv1Config = params->encodeConfig->encodeCodecConfig.av1Config;
		seenAv1Level = params->encodeConfig->encodeCodecConfig.av1Config.level;
		seenAv1BitDepth = (uint32_t)params->encodeConfig->encodeCodecConfig.av1Config.outputBitDepth;
		seenAv1InputBitDepth = (uint32_t)params->encodeConfig->encodeCodecConfig.av1Config.inputBitDepth;
		seenAv1Flags = *((uint32_t*)((unsigned char*)&params->encodeConfig->encodeCodecConfig.av1Config + 16));
		seenAv1RepeatSeqHdr = params->encodeConfig->encodeCodecConfig.av1Config.repeatSeqHdr;
	}else if(memcmp(&params->encodeGUID, &NV_ENC_CODEC_HEVC_GUID, sizeof(GUID)) == 0){
		seenHevcVui = params->encodeConfig->encodeCodecConfig.hevcConfig.hevcVUIParameters;
	}
	return NV_ENC_SUCCESS;
}

const void* seenOrdinary = nullptr;
NVENCSTATUS NVENCAPI CaptureReconfigure(void*, NV_ENC_RECONFIGURE_PARAMS* p){
	++ordinaryCalls; seenOrdinary = p;
	if(reconfigureDriverStatus == NV_ENC_SUCCESS && p){
		const int before = initDriverCalls;
		const NVENCSTATUS checked = CaptureInit(nullptr, &p->reInitEncodeParams);
		initDriverCalls = before;
		return checked;
	}
	return reconfigureDriverStatus;
}
NVENCSTATUS NVENCAPI CaptureRegister(void*, NV_ENC_REGISTER_RESOURCE* p){ ++ordinaryCalls; seenOrdinary = p; return NV_ENC_ERR_GENERIC; }
NVENCSTATUS NVENCAPI CaptureMap(void*, NV_ENC_MAP_INPUT_RESOURCE* p){ ++ordinaryCalls; seenOrdinary = p; return NV_ENC_ERR_GENERIC; }
NVENCSTATUS NVENCAPI CaptureEncode(void*, NV_ENC_PIC_PARAMS* p){
	++ordinaryCalls; seenOrdinary = p; seenPictureVersion = p ? p->version : 0;
	// the delivered map lives at the 11.1 offsets when the call struct is
	// 11.1-versioned (direct-path sessions), member offsets otherwise
	if(p && Is111(p->version)){
		seenEncodeMap = *reinterpret_cast<int8_t* const*>(reinterpret_cast<unsigned char*>(p) + kQpDeltaMap11Offset);
		seenEncodeMapSize = *reinterpret_cast<uint32_t*>(reinterpret_cast<unsigned char*>(p) + kQpDeltaMapSize11Offset);
	}else{
		seenEncodeMap = p ? p->qpDeltaMap : nullptr;
		seenEncodeMapSize = p ? p->qpDeltaMapSize : 0;
	}
	std::memset(seenEncodeMapBytes, 0, sizeof(seenEncodeMapBytes));
	if(seenEncodeMap){
		for(uint32_t i = 0; i < seenEncodeMapSize && i < 32; i++){ seenEncodeMapBytes[i] = seenEncodeMap[i]; }
	}
	return encodeDriverStatus;
}
NVENCSTATUS NVENCAPI CaptureLock(void*, NV_ENC_LOCK_BITSTREAM* p){ ++ordinaryCalls; seenOrdinary = p; seenLockVersion = p ? p->version : 0; if(p){ p->bitstreamSizeInBytes = 2000000; } return NV_ENC_SUCCESS; }

void CheckOutputBufferLog(){
	Configure(true, 0);
	void* encoder = OpenSession();
	NV_ENC_LOCK_BITSTREAM lock = {}; lock.version = Tag111(1, true);
	Check(NvencTapShims::LockBitstream(encoder, &lock) == NV_ENC_SUCCESS,
		"output buffer log: successful lock delegated");
	{
		std::lock_guard<std::mutex> guard(capturedLogLock);
		Check(largestBufferLog.find("NvencTap: new largest encoded output buffer: 2000000 bytes (1.91 MiB)") == 0,
			"output buffer log: searchable prefix, buffer scope and binary units are explicit");
	}
	Check(NvencTapShims::DestroyEncoder(encoder) == NV_ENC_SUCCESS, "output buffer log: fixture session destroyed");
}

void CheckOffPassthrough(void* encoder){
	Configure(false, 1);
	NV_ENCODE_API_FUNCTION_LIST list = {};
	list.version = Tag111(2);
	list.nvEncInitializeEncoder = CaptureInit;
	list.nvEncReconfigureEncoder = CaptureReconfigure;
	list.nvEncRegisterResource = CaptureRegister;
	list.nvEncMapInputResource = CaptureMap;
	list.nvEncEncodePicture = CaptureEncode;
	list.nvEncLockBitstream = CaptureLock;
	const auto originalList = list;
	NvencTapShims::CreateInstance(&list);
	Check(memcmp(&list, &originalList, sizeof(list)) == 0, "OFF preserves populated API table");
	Check(NvencTapShims::CreateInstance(nullptr) == NV_ENC_ERR_INVALID_PTR, "OFF null list status forwarded");
	list.version = 0xffff;
	const auto unsupportedList = list;
	NvencTapShims::CreateInstance(&list);
	Check(memcmp(&list, &unsupportedList, sizeof(list)) == 0, "OFF preserves unsupported API table");
	const auto before = NvencTap::Get().GetStats();
	const int logsBefore = logCalls;
	const int capsBefore = capsCalls;
	NV_ENC_CONFIG cfg = {}; cfg.version = Tag111(7, true); cfg.rcParams.version = Tag111(1);
	cfg.rcParams.averageBitRate = 12345678; cfg.rcParams.maxBitRate = 23456789;
	cfg.encodeCodecConfig.hevcConfig.level = NV_ENC_LEVEL_HEVC_61;
	const auto savedCfg = cfg;
	NV_ENC_INITIALIZE_PARAMS init = {}; init.version = Tag111(5, true); init.encodeConfig = &cfg;
	init.encodeGUID = NV_ENC_CODEC_HEVC_GUID; init.frameRateNum = 37; init.frameRateDen = 2;
	const auto savedInit = init;
	Check(NvencTapShims::InitializeEncoder(encoder, &init) == NV_ENC_SUCCESS, "OFF init delegated");
	Check(memcmp(&init, &savedInit, sizeof(init)) == 0 && memcmp(&cfg, &savedCfg, sizeof(cfg)) == 0,
		"OFF full initialization/config bytes unchanged");
	Check(capsCalls == capsBefore, "OFF does not query encoder capabilities");
	Check(logCalls == logsBefore, "OFF successful passthrough emits no diagnostic logs");
	Check(NvencTapShims::InitializeEncoder(encoder, nullptr) == NV_ENC_ERR_INVALID_PTR, "OFF null init delegated");
	Check(NvencTap::Get().GetRuntimeState().lastInitStatus == NV_ENC_ERR_INVALID_PTR
		&& !NvencTap::Get().GetRuntimeState().initError.empty(), "OFF failed null init remains diagnosable");
	const int logsAfterNullFailure = logCalls;
	NvencTap::Get().TryInstall();
	NvencTap::Get().MaybeHeartbeat();
	NV_ENC_RECONFIGURE_PARAMS r = {}; r.version = Tag111(1, true);
	const auto savedR = r;
	Check(NvencTapShims::ReconfigureEncoder(encoder, &r) == NV_ENC_ERR_GENERIC && seenOrdinary == &r,
		"OFF reconfigure failure/pointer forwarded");
	Check(memcmp(&r, &savedR, sizeof(r)) == 0, "OFF complete reconfigure params unchanged");
	NV_ENC_REGISTER_RESOURCE reg = {}; reg.version = Tag111(4);
	reg.resourceType = NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX;
	reg.resourceToRegister = reinterpret_cast<void*>(7);
	const auto savedReg = reg;
	Check(NvencTapShims::RegisterResource(encoder, &reg) == NV_ENC_ERR_GENERIC, "OFF register failure forwarded");
	Check(memcmp(&reg, &savedReg, sizeof(reg)) == 0, "OFF complete register params unchanged");
	registered[reinterpret_cast<void*>(8)] = { reinterpret_cast<void*>(7), NV_ENC_BUFFER_FORMAT_NV12, NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX };
	NV_ENC_MAP_INPUT_RESOURCE map = {}; map.version = Tag111(4); map.registeredResource = reinterpret_cast<void*>(8);
	const auto savedMap = map;
	Check(NvencTapShims::MapInputResource(encoder, &map) == NV_ENC_ERR_GENERIC, "OFF map skips GPU and forwards failure");
	Check(memcmp(&map, &savedMap, sizeof(map)) == 0, "OFF complete map params unchanged");
	registered.erase(map.registeredResource);
	NV_ENC_PIC_PARAMS pic = {}; pic.version = Tag111(4, true); pic.inputBuffer = reinterpret_cast<void*>(9);
	pic.outputBitstream = reinterpret_cast<void*>(10);
	const auto savedPic = pic;
	Check(NvencTapShims::EncodePicture(encoder, &pic) == NV_ENC_ERR_GENERIC, "OFF encode failure forwarded");
	Check(memcmp(&pic, &savedPic, sizeof(pic)) == 0, "OFF complete picture unchanged");
	NV_ENC_LOCK_BITSTREAM lock = {}; lock.version = Tag111(1, true); lock.bitstreamSizeInBytes = 2000000;
	Check(NvencTapShims::LockBitstream(encoder, &lock) == NV_ENC_SUCCESS, "OFF lock output delegated");
	Check(NvencTapShims::EncodePicture(encoder, nullptr) == NV_ENC_ERR_GENERIC, "OFF null picture forwarded");
	Check(NvencTapShims::ReconfigureEncoder(encoder, nullptr) == NV_ENC_ERR_GENERIC, "OFF null reconfigure forwarded");
	const auto after = NvencTap::Get().GetStats();
	Check(memcmp(&before, &after, sizeof(before)) == 0, "OFF no diagnostic counter changes");
	Check(logCalls == logsAfterNullFailure, "OFF passthrough operations emit no extra diagnostics after recorded init failure");
}

NVENCSTATUS NVENCAPI CaptureDestroy(void*){ destroyCalls++; return NV_ENC_SUCCESS; }

void* OpenSession(){
	openApis.clear(); openVersions.clear();
	NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS params = {};
	params.apiVersion = kApi111;
	params.version = Tag111(1);
	void* encoder = nullptr;
	Check(NvencTapShims::OpenEncodeSessionEx(&params, &encoder) == NV_ENC_SUCCESS, "session open succeeds");
	Check(params.apiVersion == kApi111 && params.version == Tag111(1), "session caller words restored");
	return encoder;
}

void CreateFunctionList(){
	listVersions.clear();
	NV_ENCODE_API_FUNCTION_LIST list = {};
	list.version = Tag111(2);
	Check(NvencTapShims::CreateInstance(&list) == NV_ENC_SUCCESS, "function list creation succeeds");
	Check(list.version == Tag111(2), "function list caller version restored");
}

void CheckExistingSessionAfterOff(void* encoder){
	const auto statsBefore = NvencTap::Get().GetStats();
	const int logsBefore = logCalls;
	NV_ENC_CAPS_PARAM caps = {};
	caps.version = Tag111(1);
	int value = 0;
	Check(NvencTapShims::GetEncodeCaps(encoder, NV_ENC_CODEC_HEVC_GUID, &caps, &value) == NV_ENC_SUCCESS,
		"existing upgraded session caps succeeds after OFF");
	Check(seenCapsVersion == Tag121(1, false), "existing session still receives its 12.1 ABI after OFF");
	Check(caps.version == Tag111(1), "caps caller version restored after OFF");

	NV_ENC_CONFIG config = {};
	config.version = Tag111(7, true);
	config.rcParams.version = Tag111(1);
	config.rcParams.averageBitRate = 42000000;
	config.encodeCodecConfig.hevcConfig.level = NV_ENC_LEVEL_HEVC_61;
	NV_ENC_INITIALIZE_PARAMS params = {};
	params.version = Tag111(5, true);
	params.encodeGUID = NV_ENC_CODEC_HEVC_GUID;
	params.encodeConfig = &config;
	Check(NvencTapShims::InitializeEncoder(encoder, &params) == NV_ENC_SUCCESS,
		"existing upgraded session initializes after OFF");
	Check(seenInitVersion == Tag121(6, true) && seenConfigVersion == Tag121(8, true)
		&& seenRcVersion == Tag121(1, false), "existing session retains all initialization ABI tags after OFF");
	Check(seenLevel == NV_ENC_LEVEL_HEVC_61 && seenBitrate == 42000000,
		"OFF retains caller encoder settings while preserving ABI");
	Check(params.version == Tag111(5, true) && config.version == Tag111(7, true)
		&& config.rcParams.version == Tag111(1), "all initialization caller tags restored after OFF");
	NV_ENC_PIC_PARAMS pic = {}; pic.version = Tag111(4, true);
	const auto savedPic = pic;
	Check(NvencTapShims::EncodePicture(encoder, &pic) == NV_ENC_ERR_GENERIC
		&& seenPictureVersion == Tag121(6, true), "OFF upgraded picture keeps required ABI");
	Check(memcmp(&pic, &savedPic, sizeof(pic)) == 0, "OFF upgraded picture caller bytes unchanged");
	NV_ENC_LOCK_BITSTREAM lock = {}; lock.version = Tag111(1, true);
	Check(NvencTapShims::LockBitstream(encoder, &lock) == NV_ENC_SUCCESS
		&& seenLockVersion == Tag121(1, true), "OFF upgraded lock keeps required ABI");
	Check(lock.version == Tag111(1, true) && lock.bitstreamSizeInBytes == 2000000,
		"OFF upgraded lock copies output while restoring caller ABI");
	const auto statsAfter = NvencTap::Get().GetStats();
	Check(memcmp(&statsBefore, &statsAfter, sizeof(statsBefore)) == 0 && logsBefore == logCalls,
		"OFF upgraded ABI adapter does not produce diagnostics");
}

// 2026-10-16 open-time decision parity. Runs FIRST in main: no SetConfig has
// happened, so the open/function-list decisions consult the caps shim's
// settings.json probe. The probe must mirror the ConfigLoader parse of the
// same file: missing keys take the loader defaults (nvencTap true,
// nvencCodec 0, nvencSplitMode 1), legacy-typed values are ignored like the
// loader ignores them, and an unreadable or malformed file leaves every
// default in place. The owner's runtime file holds nvencCodec 2 and no
// nvencTap, nvencSplitMode or streamFormatWidth key.
void CheckOpenProbeParity(){
	const char* appdataRaw = getenv("APPDATA");
	const std::string savedAppdata = appdataRaw ? appdataRaw : "";
	const auto checkoutParent = std::filesystem::path(__FILE__).parent_path().parent_path().parent_path().parent_path();
	const std::string base = (checkoutParent / "builds/GalaxyXR-Driver/build/nvenc-toggle-test/open-probe").string();
	std::filesystem::create_directories(base + "/CustomHeadset");
	struct ProbeCase { const char* name; const char* json; bool expectTap; int expectCodec; int expectSplit; bool expectUpgrade; };
	const ProbeCase cases[] = {
		{ "owner file shape (nvencCodec 2, tap absent, split absent)",
			"{\"streamFrame\":{\"nvencCodec\":2,\"profileSupports10bit\":false,\"sdr10SettingsVersion\":2}}", true, 2, 1, true },
		{ "absent keys keep the loader defaults", "{\"streamFrame\":{}}", true, 0, 1, true },
		{ "legacy-typed keys are ignored", "{\"streamFrame\":{\"nvencTap\":1,\"nvencCodec\":\"2\",\"nvencSplitMode\":\"1\"}}", true, 0, 1, true },
		{ "explicit tap disabled wins", "{\"streamFrame\":{\"nvencTap\":false,\"nvencCodec\":2,\"nvencSplitMode\":4}}", false, 2, 4, false },
		{ "malformed file keeps every default", "{{{", true, 0, 1, true },
	};
	for(const ProbeCase &probeCase : cases){
		const std::string file = base + "/CustomHeadset/settings.json";
		{ std::ofstream out(file.c_str(), std::ios::binary); out << probeCase.json; }
		_putenv(("APPDATA=" + base).c_str());
		const PrePublishProbe parsed = ProbePrePublishConfig();
		Check(parsed.tap == probeCase.expectTap && parsed.codec == probeCase.expectCodec && parsed.splitMode == probeCase.expectSplit,
			std::string("open probe: ").append(probeCase.name).append(" mirrors the ConfigLoader parse").c_str());
		NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS openParams = {};
		openParams.apiVersion = kApi111; openParams.version = Tag111(1);
		void* encoder = nullptr;
		openApis.clear(); openVersions.clear();
		Check(NvencTapShims::OpenEncodeSessionEx(&openParams, &encoder) == NV_ENC_SUCCESS,
			std::string("open probe: ").append(probeCase.name).append(" opens").c_str());
		const uint32_t wantOpen = probeCase.expectUpgrade ? (uint32_t)kApi121 : (uint32_t)kApi111;
		Check(openApis == std::vector<uint32_t>{wantOpen},
			std::string("open probe: ").append(probeCase.name).append(" open api matches the probe").c_str());
		Check(Upgraded(encoder) == probeCase.expectUpgrade, "open probe: session upgrade record follows the probe");
		Check(NvencTapShims::DestroyEncoder(encoder) == NV_ENC_SUCCESS, "open probe: probe-driven session destroyed");
		listVersions.clear();
		NV_ENCODE_API_FUNCTION_LIST list = {}; list.version = Tag111(2);
		Check(NvencTapShims::CreateInstance(&list) == NV_ENC_SUCCESS, "open probe: function list creation succeeds");
		Check(listVersions == std::vector<uint32_t>{ probeCase.expectUpgrade ? Tag121(2, false) : Tag111(2) },
			std::string("open probe: ").append(probeCase.name).append(" list presentation matches the probe").c_str());
		Check(list.version == Tag111(2), "open probe: caller list version restored");
	}
	_putenv(("APPDATA=" + savedAppdata).c_str());
}

// 2026-10-16 restore (pre-0cf0cf7 behavior): initialization without an
// explicit encodeConfig is valid NVENC usage — the call passes through and
// the success is recorded; it never refuses and no override runs.
void CheckObserveOnlyInit(){
	NvencTapConfig cfg; cfg.enabled = true; cfg.splitMode = 1;
	NvencTap::Get().SetConfig(cfg);
	void* encoder = OpenSession();
	Check(Upgraded(encoder), "observe-only: the split request upgrades the session open");
	NV_ENC_INITIALIZE_PARAMS init = {}; init.version = Tag111(5, true);
	init.encodeGUID = NV_ENC_CODEC_HEVC_GUID; init.encodeConfig = nullptr;
	init.frameRateNum = 90; init.frameRateDen = 1;
	const auto savedInit = init;
	const int before = initDriverCalls;
	Check(NvencTapShims::InitializeEncoder(encoder, &init) == NV_ENC_SUCCESS, "observe-only: encodeConfig-less init delegates to the real call");
	Check(initDriverCalls == before + 1, "observe-only: the real encoder call happened");
	const auto runtime = NvencTap::Get().GetRuntimeState();
	Check(runtime.lastStatus == NV_ENC_SUCCESS && runtime.error.empty(), "observe-only: success recorded, no refusal state");
	Check(runtime.effectiveCodec == 0 && runtime.effectiveRateControl == -1,
		"observe-only: caller codec recorded, config-derived rate control stays unset");
	// the retag presents 12.1 during the call, so the carved split field reads 0
	Check(runtime.effectiveSplit == 0, "observe-only: effective split reports the observed (carved-zero) field");
	Check(memcmp(&init, &savedInit, sizeof(init)) == 0, "observe-only: caller bytes unchanged — no split bits, no override");
	Check(NvencTapShims::DestroyEncoder(encoder) == NV_ENC_SUCCESS, "observe-only: session destroyed");
}

// 2026-10-16: the 12.1 open is what lets init pass the split gate; a stock
// 11.1 session refuses the same request visibly. Every refusal names the
// exact setting key the Companion shows.
void CheckSplitGateAndRefusalKeys(){
	NvencTapConfig cfgSplit; cfgSplit.enabled = true; cfgSplit.splitMode = 1;
	NvencTap::Get().SetConfig(cfgSplit);
	void* upgradedEnc = OpenSession();
	Check(Upgraded(upgradedEnc), "split gate: published split request upgrades the open");
	NV_ENC_CONFIG hcfg = {}; hcfg.version = Tag111(7, true); hcfg.rcParams.version = Tag111(1);
	hcfg.rcParams.averageBitRate = 42000000;
	NV_ENC_INITIALIZE_PARAMS hinit = {}; hinit.version = Tag111(5, true);
	hinit.encodeGUID = NV_ENC_CODEC_HEVC_GUID; hinit.encodeConfig = &hcfg;
	hinit.frameRateNum = 90; hinit.frameRateDen = 1;
	const auto savedInit = hinit; const auto savedCfg = hcfg;
	Check(NvencTapShims::InitializeEncoder(upgradedEnc, &hinit) == NV_ENC_SUCCESS, "split gate: upgraded session passes the split request");
	Check(((seenInitFlags >> 5) & 0xFu) == 1u, "split gate: forced split bits applied at init on HEVC (deferral is AV1-only)");
	Check(memcmp(&hinit, &savedInit, sizeof(hinit)) == 0 && memcmp(&hcfg, &savedCfg, sizeof(savedCfg)) == 0, "split gate: caller bytes restored");
	NV_ENC_RECONFIGURE_PARAMS greconf = {}; greconf.version = Tag111(1, true);
	greconf.reInitEncodeParams = hinit;
	const auto savedGreconf = greconf;
	reconfigureDriverStatus = NV_ENC_SUCCESS;
	Check(NvencTapShims::ReconfigureEncoder(upgradedEnc, &greconf) == NV_ENC_SUCCESS, "split gate: reconfigure delegated");
	reconfigureDriverStatus = NV_ENC_ERR_GENERIC;
	Check(((seenInitFlags >> 5) & 0xFu) == 1u, "split gate: forced split bits applied at reconfigure on the upgraded session");
	Check(memcmp(&greconf, &savedGreconf, sizeof(greconf)) == 0, "split gate: reconfigure caller bytes restored");
	// stock 11.1 session, same request: refused before NVENC with the named key
	NvencTapConfig cfgStock; cfgStock.enabled = true; cfgStock.splitMode = 0;
	NvencTap::Get().SetConfig(cfgStock);
	void* stockEnc = OpenSession();
	Check(!Upgraded(stockEnc), "split gate: split-zero open stays stock");
	NvencTap::Get().SetConfig(cfgSplit);
	const int beforeRefused = initDriverCalls;
	Check(NvencTapShims::InitializeEncoder(stockEnc, &hinit) == NV_ENC_ERR_INVALID_PARAM && initDriverCalls == beforeRefused,
		"split gate: stock 11.1 session refuses the split request before NVENC");
	Check(NvencTap::Get().GetRuntimeState().error.find("streamFrame.nvencSplitMode") != std::string::npos,
		"split gate: refusal names streamFrame.nvencSplitMode");
	// an UNCONFIGURED map can no longer refuse: falloff nonsense with the
	// fovea/periphery pair at 0 passes init and submits frames normally
	NvencTapConfig unconfigured; unconfigured.enabled = true; unconfigured.splitMode = 1;
	unconfigured.qpFovea = 0; unconfigured.qpPeriphery = 0; unconfigured.qpEdgeFalloff = 2.0f;
	NvencTap::Get().SetConfig(unconfigured);
	Check(NvencTapShims::InitializeEncoder(upgradedEnc, &hinit) == NV_ENC_SUCCESS,
		"qp gate: an unused map (bad falloff, fovea/periphery 0) cannot refuse the session");
	NV_ENC_PIC_PARAMS frame = {}; frame.version = Tag111(4, true);
	frame.inputBuffer = reinterpret_cast<void*>(1); frame.inputWidth = 64; frame.inputHeight = 64;
	const int beforeFrame = ordinaryCalls;
	Check(NvencTapShims::EncodePicture(upgradedEnc, &frame) == NV_ENC_ERR_GENERIC && ordinaryCalls == beforeFrame + 1,
		"qp gate: an unconfigured map still submits the frame to NVENC (no pre-validation refusal)");
	// configured map + bad falloff keeps refusing (the map is now in use),
	// with its key named
	NvencTapConfig configured; configured.enabled = true; configured.qpFovea = -10; configured.qpPeriphery = 10;
	configured.qpEdgeFalloff = 2.0f;
	NvencTap::Get().SetConfig(configured);
	Check(NvencTapShims::InitializeEncoder(upgradedEnc, &hinit) == NV_ENC_ERR_INVALID_PARAM,
		"qp gate: a configured map still refuses an out-of-range falloff");
	Check(NvencTap::Get().GetRuntimeState().error.find("streamFrame.postPack.edgeFalloff") != std::string::npos,
		"qp gate: configured-map refusal names streamFrame.postPack.edgeFalloff");
	// remaining refusals name their exact setting keys
	struct RefusalCase { const char* name; NvencTapConfig cfg; const char* key; };
	NvencTapConfig c1; c1.enabled = true; c1.codec = 5;
	NvencTapConfig c2; c2.enabled = true; c2.preset = 9;
	NvencTapConfig c3; c3.enabled = true; c3.multiPass = 9;
	NvencTapConfig c4; c4.enabled = true; c4.bitrateMbit = -1;
	NvencTapConfig c5; c5.enabled = true; c5.maxQp = -1;
	NvencTapConfig c6; c6.enabled = true; c6.vuiFullRange = 7;
	NvencTapConfig c7; c7.enabled = true; c7.codec = 1; c7.h264SliceMode = 9;
	const RefusalCase refusals[] = {
		{ "invalid codec", c1, "streamFrame.nvencCodec" },
		{ "invalid preset", c2, "streamFrame.nvencPreset" },
		{ "invalid multipass", c3, "streamFrame.nvencMultiPass" },
		{ "negative bitrate", c4, "streamFrame.nvencBitrateMbit" },
		{ "negative maxQp", c5, "streamFrame.nvencMaxQp" },
		{ "invalid vui full range", c6, "streamFrame.nvencVuiFullRange" },
		{ "invalid h264 slice mode", c7, "streamFrame.nvencH264" },
	};
	for(const RefusalCase &ref : refusals){
		NvencTap::Get().SetConfig(ref.cfg);
		const int beforeCase = initDriverCalls;
		Check(NvencTapShims::InitializeEncoder(upgradedEnc, &hinit) == NV_ENC_ERR_INVALID_PARAM && initDriverCalls == beforeCase,
			std::string(ref.name).append(": refuses without an NVENC call").c_str());
		Check(NvencTap::Get().GetRuntimeState().error.find(ref.key) != std::string::npos,
			std::string(ref.name).append(": refusal names its key").c_str());
	}
	Check(memcmp(&hinit, &savedInit, sizeof(hinit)) == 0 && memcmp(&hcfg, &savedCfg, sizeof(savedCfg)) == 0,
		"refusals leave every caller byte untouched");
	Check(NvencTapShims::DestroyEncoder(upgradedEnc) == NV_ENC_SUCCESS, "split gate: upgraded session destroyed");
	Check(NvencTapShims::DestroyEncoder(stockEnc) == NV_ENC_SUCCESS, "split gate: stock session destroyed");
	ConfigureCodec(true, 0);
}

void CheckStartupAllocationAndPictures(){
	strictCapabilities = true;
	for(int codec : {0, 1, 2}){
		NvencTapConfig cfg; cfg.enabled = true; cfg.codec = codec; cfg.splitMode = codec == 1 ? 0 : 1;
		cfg.enforceTile = true; cfg.effectiveTileWidth = codec == 1 ? 1024 : 1536;
		NvencTap::Get().SetConfig(cfg);
		void* encoder = OpenSession();
		directGeometryCaps.clear();
		auto width = ShimCapsQuery(encoder, NV_ENC_CAPS_WIDTH_MAX);
		auto height = ShimCapsQuery(encoder, NV_ENC_CAPS_HEIGHT_MAX);
		Check(width.status == NV_ENC_SUCCESS && width.value == cfg.effectiveTileWidth
			&& height.status == NV_ENC_SUCCESS && height.value == cfg.effectiveTileWidth * 4,
			"startup caps: advertised allocation envelope carries the selected explicit tile");
		const GUID target = codec == 1 ? NV_ENC_CODEC_H264_GUID : codec == 2 ? NV_ENC_CODEC_AV1_GUID : NV_ENC_CODEC_HEVC_GUID;
		Check(!directGeometryCaps.empty() && std::all_of(directGeometryCaps.begin(), directGeometryCaps.end(), [&](GUID guid){
			return memcmp(&guid, &target, sizeof(GUID)) == 0;
		}), "startup caps: allocation envelope is checked against actual target codec hardware");
		NV_ENC_CONFIG config = {}; config.version = Tag111(7, true); config.rcParams.version = Tag111(1);
		config.rcParams.averageBitRate = 42000000; config.profileGUID = NV_ENC_HEVC_PROFILE_MAIN_GUID;
		NV_ENC_INITIALIZE_PARAMS init = {}; init.version = Tag111(5, true);
		init.encodeGUID = NV_ENC_CODEC_HEVC_GUID; init.encodeConfig = &config;
		init.frameRateNum = 90; init.frameRateDen = 1;
		// HEVC and AV1 legitimately allocate at maximum size before the
		// streamer reconfigures to the packed frame selected for transmission.
		init.encodeWidth = codec == 1 ? 1024 : 3200; init.encodeHeight = codec == 1 ? 4096 : 8192;
		init.maxEncodeWidth = 3200; init.maxEncodeHeight = 8192;
		const auto savedInit = init; const auto savedConfig = config;
		Check(NvencTapShims::InitializeEncoder(encoder, &init) == NV_ENC_SUCCESS,
			"startup allocation: maximum-size initialization is accepted before packed-size reconfiguration");
		Check(memcmp(&init, &savedInit, sizeof(init)) == 0 && memcmp(&config, &savedConfig, sizeof(config)) == 0,
			"startup allocation: init and config caller bytes restored");
		NV_ENC_RECONFIGURE_PARAMS reconfigure = {}; reconfigure.version = Tag111(1, true);
		reconfigure.reInitEncodeParams = init;
		reconfigure.reInitEncodeParams.encodeWidth = cfg.effectiveTileWidth;
		reconfigure.reInitEncodeParams.encodeHeight = cfg.effectiveTileWidth * 4;
		const auto savedReconfigure = reconfigure;
		reconfigureDriverStatus = NV_ENC_SUCCESS;
		Check(NvencTapShims::ReconfigureEncoder(encoder, &reconfigure) == NV_ENC_SUCCESS,
			"startup allocation: subsequent requested packed frame reconfiguration succeeds");
		const auto accepted = NvencTap::Get().GetRuntimeState();
		Check(accepted.effectiveCodec == codec && accepted.encodeWidth == (uint32_t)cfg.effectiveTileWidth
			&& accepted.encodeHeight == (uint32_t)cfg.effectiveTileWidth * 4u,
			"startup allocation: app evidence reports actual accepted packed dimensions and selected codec");
		Check(memcmp(&reconfigure, &savedReconfigure, sizeof(reconfigure)) == 0
			&& memcmp(&config, &savedConfig, sizeof(config)) == 0,
			"startup allocation: reconfigure and config caller bytes restored");
		NV_ENC_PIC_PARAMS picture = {}; picture.version = Tag111(4, true);
		picture.inputBuffer = reinterpret_cast<void*>(1); picture.outputBitstream = reinterpret_cast<void*>(2);
		picture.inputWidth = 768; picture.inputHeight = 3072;
		const auto savedPicture = picture; const int beforePicture = ordinaryCalls;
		Check(NvencTapShims::EncodePicture(encoder, &picture) == NV_ENC_ERR_INVALID_PARAM && ordinaryCalls == beforePicture,
			"active picture: mismatched tile is refused before encoding instead of silently sent");
		Check(!NvencTap::Get().GetRuntimeState().pictureError.empty()
			&& memcmp(&picture, &savedPicture, sizeof(picture)) == 0,
			"active picture: refusal is visible and caller bytes remain intact");
		Check(NvencTapShims::DestroyEncoder(encoder) == NV_ENC_SUCCESS, "startup allocation: session destroyed");
	}
	NvencTapConfig oversized; oversized.enabled = true; oversized.codec = 1; oversized.enforceTile = true;
	oversized.effectiveTileWidth = 1536;
	NvencTap::Get().SetConfig(oversized); void* encoder = OpenSession();
	const auto rejected = ShimCapsQuery(encoder, NV_ENC_CAPS_HEIGHT_MAX);
	Check(rejected.status != NV_ENC_SUCCESS && !NvencTap::Get().GetRuntimeState().error.empty(),
		"unsupported requested H264 tile: allocation probe fails visibly instead of lowering user value");
	const auto allocationFailure = NvencTap::Get().GetRuntimeState();
	Check(allocationFailure.lastInitStatus == NV_ENC_ERR_INVALID_PARAM
		&& allocationFailure.initError.find("allocation") != std::string::npos,
		"unsupported requested H264 tile: allocation probe preserves the initiating setup failure");
	NV_ENC_CONFIG invalidConfig = {}; invalidConfig.version = Tag111(7, true); invalidConfig.rcParams.version = Tag111(1);
	NV_ENC_INITIALIZE_PARAMS invalidInit = {}; invalidInit.version = Tag111(5, true);
	invalidInit.encodeGUID = NV_ENC_CODEC_HEVC_GUID; invalidInit.encodeConfig = &invalidConfig;
	invalidInit.frameRateNum = 90; invalidInit.frameRateDen = 1;
	invalidInit.encodeWidth = 1024; invalidInit.encodeHeight = 4096;
	nextInitStatus = NV_ENC_ERR_DEVICE_NOT_EXIST;
	Check(NvencTapShims::InitializeEncoder(encoder, &invalidInit) == NV_ENC_ERR_DEVICE_NOT_EXIST,
		"unsupported requested H264 tile: later invalid-device initialization error returned");
	Check(NvencTap::Get().GetRuntimeState().lastInitStatus == NV_ENC_ERR_INVALID_PARAM
		&& NvencTap::Get().GetRuntimeState().initError == allocationFailure.initError,
		"unsupported requested H264 tile: subsequent init status 5 cannot hide allocation setup failure");
	Check(NvencTap::Get().GetConfig().effectiveTileWidth == 1536,
		"unsupported requested H264 tile: exact user value remains configured");
	Check(NvencTapShims::DestroyEncoder(encoder) == NV_ENC_SUCCESS, "unsupported requested H264 tile: session destroyed");
	strictCapabilities = false; reconfigureDriverStatus = NV_ENC_ERR_GENERIC;
	ConfigureCodec(true, 0);
}

void CheckFirstInitializationFailure(){
	ConfigureCodec(true, 0);
	void* encoder = OpenSession();
	NV_ENC_CONFIG config = {}; config.version = Tag111(7, true); config.rcParams.version = Tag111(1);
	NV_ENC_INITIALIZE_PARAMS init = {}; init.version = Tag111(5, true);
	init.encodeGUID = NV_ENC_CODEC_HEVC_GUID; init.encodeConfig = &config; init.frameRateNum = 90; init.frameRateDen = 1;
	nextInitStatus = NV_ENC_ERR_INVALID_PARAM;
	Check(NvencTapShims::InitializeEncoder(encoder, &init) == NV_ENC_ERR_INVALID_PARAM,
		"first init failure: initiating status 8 returned");
	const auto first = NvencTap::Get().GetRuntimeState();
	Check(first.lastInitStatus == NV_ENC_ERR_INVALID_PARAM && first.initError.find("nvEncInitializeEncoder") != std::string::npos
		&& first.initError.find("request:") != std::string::npos,
		"first init failure: exact initiating status and request preserved together");
	NV_ENC_RECONFIGURE_PARAMS reconfigure = {}; reconfigure.version = Tag111(1, true); reconfigure.reInitEncodeParams = init;
	reconfigureDriverStatus = NV_ENC_ERR_DEVICE_NOT_EXIST;
	Check(NvencTapShims::ReconfigureEncoder(encoder, &reconfigure) == NV_ENC_ERR_DEVICE_NOT_EXIST,
		"first init failure: later reconfigure status 5 returned");
	nextInitStatus = NV_ENC_ERR_DEVICE_NOT_EXIST;
	Check(NvencTapShims::InitializeEncoder(encoder, &init) == NV_ENC_ERR_DEVICE_NOT_EXIST,
		"first init failure: repeated init status 5 returned");
	const auto repeated = NvencTap::Get().GetRuntimeState();
	Check(repeated.lastStatus == NV_ENC_ERR_DEVICE_NOT_EXIST && repeated.lastInitStatus == NV_ENC_ERR_INVALID_PARAM
		&& repeated.initError == first.initError,
		"first init failure: later reconfigure/init failures cannot overwrite initiating status 8");
	void* other = OpenSession();
	Check(NvencTapShims::InitializeEncoder(other, &init) == NV_ENC_SUCCESS,
		"first init failure: another encoder may initialize successfully");
	Check(NvencTap::Get().GetRuntimeState().lastInitStatus == NV_ENC_ERR_INVALID_PARAM
		&& NvencTap::Get().GetRuntimeState().initError == first.initError,
		"first init failure: unrelated active encoder success preserves the failed session's visible evidence");
	Check(NvencTapShims::DestroyEncoder(other) == NV_ENC_SUCCESS, "first init failure: unrelated session destroy succeeds");
	// Revisiting the failed session must recover its own first failure,
	// regardless of which other session most recently published telemetry.
	nextInitStatus = NV_ENC_ERR_DEVICE_NOT_EXIST;
	Check(NvencTapShims::InitializeEncoder(encoder, &init) == NV_ENC_ERR_DEVICE_NOT_EXIST,
		"first init failure: failed session retry still returns actual status");
	Check(NvencTap::Get().GetRuntimeState().lastInitStatus == NV_ENC_ERR_INVALID_PARAM
		&& NvencTap::Get().GetRuntimeState().initError == first.initError,
		"first init failure: unrelated session success/destroy cannot erase original session evidence");
	Check(NvencTapShims::InitializeEncoder(encoder, &init) == NV_ENC_SUCCESS,
		"first init failure: matching successful initialization allowed");
	Check(NvencTap::Get().GetRuntimeState().lastInitStatus == 0 && NvencTap::Get().GetRuntimeState().initError.empty(),
		"first init failure: matching success clears initiating failure");
	ConfigureCodec(false, 0);
	nextInitStatus = NV_ENC_ERR_INVALID_PARAM;
	Check(NvencTapShims::InitializeEncoder(encoder, &init) == NV_ENC_ERR_INVALID_PARAM
		&& NvencTap::Get().GetRuntimeState().lastInitStatus == NV_ENC_ERR_INVALID_PARAM,
		"first init failure: Tap OFF path also preserves initialization rejection");
	Check(NvencTapShims::InitializeEncoder(encoder, &init) == NV_ENC_SUCCESS
		&& NvencTap::Get().GetRuntimeState().initError.empty(),
		"first init failure: Tap OFF matching success clears its own failure");
	ConfigureCodec(true, 0);
	nextInitStatus = NV_ENC_ERR_INVALID_PARAM;
	NvencTapShims::InitializeEncoder(encoder, &init);
	Check(NvencTapShims::DestroyEncoder(encoder) == NV_ENC_SUCCESS, "first init failure: original session destroyed");
	nextHandle = reinterpret_cast<uintptr_t>(encoder);
	void* reused = OpenSession();
	Check(reused == encoder, "first init failure: fake driver reuses the same raw session handle");
	nextInitStatus = NV_ENC_ERR_DEVICE_NOT_EXIST;
	Check(NvencTapShims::InitializeEncoder(reused, &init) == NV_ENC_ERR_DEVICE_NOT_EXIST
		&& NvencTap::Get().GetRuntimeState().lastInitStatus == NV_ENC_ERR_DEVICE_NOT_EXIST,
		"first init failure: reused handle starts a fresh diagnostic lifetime");
	Check(NvencTapShims::DestroyEncoder(reused) == NV_ENC_SUCCESS, "first init failure: reused session destroyed");
	Check(NvencTap::Get().GetRuntimeState().lastInitStatus == NV_ENC_ERR_DEVICE_NOT_EXIST
		&& !NvencTap::Get().GetRuntimeState().initError.empty(),
		"first init failure: destroyed failing session remains available as archived diagnostic evidence");
	void* recoveredSession = OpenSession();
	Check(NvencTapShims::InitializeEncoder(recoveredSession, &init) == NV_ENC_SUCCESS,
		"first init failure: new session may recover after failed owner is destroyed");
	Check(NvencTap::Get().GetRuntimeState().lastInitStatus == 0 && NvencTap::Get().GetRuntimeState().initError.empty(),
		"first init failure: new successful session clears archived failure of a destroyed owner");
	Check(NvencTapShims::DestroyEncoder(recoveredSession) == NV_ENC_SUCCESS, "first init failure: recovered session destroyed");
	reconfigureDriverStatus = NV_ENC_ERR_GENERIC;
}
}

// GPU processing always fails fast. Hook installation is allowed only in
// the explicit fake-loader concurrency case below; no live DLL is loaded.
namespace NvencPostPack {
bool Process(void*, uint32_t){ std::abort(); }
NvencPostPackStats GetStats(){ std::abort(); }
void ResetIntervalStats(){ std::abort(); }
}
namespace {
bool hookTest = false, hookEntered = false, hookRelease = false;
std::mutex hookMutex;
std::condition_variable hookCondition;
}
HMODULE WINAPI FakeModule(LPCSTR){ if(!hookTest) std::abort(); return reinterpret_cast<HMODULE>(1); }
FARPROC WINAPI FakeExport(HMODULE, LPCSTR){ if(!hookTest) std::abort(); return reinterpret_cast<FARPROC>(1); }
extern "C" MH_STATUS WINAPI MH_Initialize(){ if(!hookTest) std::abort(); return MH_OK; }
extern "C" MH_STATUS WINAPI MH_CreateHook(LPVOID, LPVOID, LPVOID*){ if(!hookTest) std::abort(); return MH_OK; }
extern "C" MH_STATUS WINAPI MH_EnableHook(LPVOID){
	if(!hookTest) std::abort();
	std::unique_lock<std::mutex> lock(hookMutex);
	hookEntered = true; hookCondition.notify_all();
	hookCondition.wait(lock, []{ return hookRelease; });
	return MH_OK;
}

int main(){
	origOpenEncodeSessionEx = CaptureOpen;
	origCreateInstance = CaptureList;
	origGetEncodeCaps = CaptureCaps;
	origInitializeEncoder = CaptureInit;
	origDestroyEncoder = CaptureDestroy;
	origReconfigureEncoder = CaptureReconfigure;
	origRegisterResource = CaptureRegister;
	origMapInputResource = CaptureMap;
	origEncodePicture = CaptureEncode;
	origLockBitstream = CaptureLock;

	// 2026-10-16: pre-publish open-decision parity — must run before the
	// first SetConfig publish (cfgPublished still false), so the shims'
	// open/function-list decisions really consult the settings.json probe.
	CheckOpenProbeParity();

	Configure(false, 1);
	void* stock = OpenSession();
	Check(openApis == std::vector<uint32_t>{kApi111} && openVersions[0] == Tag111(1),
		"OFF with saved split mode opens stock 11.1 session");
	Check(!Upgraded(stock), "OFF session is not marked upgraded");
	CheckOffPassthrough(stock);
	CreateFunctionList();
	Check(listVersions == std::vector<uint32_t>{Tag111(2)}, "OFF creates stock function list");

	Configure(true, 1);
	CreateFunctionList();
	Check(listVersions == std::vector<uint32_t>{Tag121(2, false)}, "ON upgrades function list");
	NV_ENCODE_API_FUNCTION_LIST populated = {}; populated.version = Tag111(2);
	populated.nvEncInitializeEncoder = CaptureInit; populated.nvEncEncodePicture = CaptureEncode;
	NvencTapShims::CreateInstance(&populated);
	Check(populated.nvEncInitializeEncoder == NvencTapShims::InitializeEncoder
		&& populated.nvEncEncodePicture == NvencTapShims::EncodePicture, "ON populated API table still wraps");
	void* upgraded = OpenSession();
	Check(openApis == std::vector<uint32_t>{kApi121} && openVersions[0] == Tag121(1, false),
		"ON upgrades new session to 12.1");
	Check(Upgraded(upgraded), "ON session recorded for subsequent ABI retagging");

	Configure(false, 1);
	stock = OpenSession();
	Check(openApis == std::vector<uint32_t>{kApi111} && !Upgraded(stock),
		"ON to OFF stops upgrades for the next connection");
	CreateFunctionList();
	Check(listVersions == std::vector<uint32_t>{Tag111(2)}, "ON to OFF stops new function-list upgrades");
	CheckExistingSessionAfterOff(upgraded);
	NV_ENC_CAPS_PARAM stockCaps = {};
	stockCaps.version = Tag111(1);
	int stockValue = 0;
	NvencTapShims::GetEncodeCaps(stock, NV_ENC_CODEC_HEVC_GUID, &stockCaps, &stockValue);
	Check(seenCapsVersion == Tag111(1), "new OFF session continues with stock ABI");
	CheckCodecOverride(stock);
	CheckExplicitSettings();
	CheckOutputBufferLog();
	CheckDeltaMapConversion();
	CheckMapSubmissionLifetime();
	CheckSessionCodecGating();
	CheckObserveOnlyInit();
	CheckSplitGateAndRefusalKeys();
	CheckStartupAllocationAndPictures();
	CheckFirstInitializationFailure();

	Configure(true, 0);
	stock = OpenSession();
	Check(openApis == std::vector<uint32_t>{kApi111} && !Upgraded(stock), "split mode zero leaves session stock");
	CreateFunctionList();
	Check(listVersions == std::vector<uint32_t>{Tag111(2)}, "split mode zero leaves function list stock");

	Configure(true, 1);
	rejectOpenUpgrade = true;
	NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS rejectedOpen = {}; rejectedOpen.apiVersion = kApi111; rejectedOpen.version = Tag111(1);
	const auto savedOpen = rejectedOpen; void* rejectedEncoder = nullptr;
	openApis.clear();
	Check(NvencTapShims::OpenEncodeSessionEx(&rejectedOpen, &rejectedEncoder) == NV_ENC_ERR_INVALID_VERSION,
		"required API upgrade: actual rejection returned");
	Check(openApis == std::vector<uint32_t>{kApi121} && rejectedEncoder == nullptr,
		"required API upgrade: no older API fallback");
	Check(memcmp(&rejectedOpen, &savedOpen, sizeof(savedOpen)) == 0, "required API upgrade: caller bytes restored on failure");
	rejectOpenUpgrade = false;
	rejectListUpgrade = true;
	NV_ENCODE_API_FUNCTION_LIST rejectedList = {}; rejectedList.version = Tag111(2);
	listVersions.clear();
	Check(NvencTapShims::CreateInstance(&rejectedList) == NV_ENC_ERR_INVALID_VERSION,
		"required API list upgrade: actual rejection returned");
	Check(listVersions == std::vector<uint32_t>{Tag121(2, false)} && rejectedList.version == Tag111(2),
		"required API list upgrade: no pristine retry, caller version restored");
	rejectListUpgrade = false;
	Configure(false, 1);
	CheckExistingSessionAfterOff(upgraded);
	Check(NvencTapShims::DestroyEncoder(upgraded) == NV_ENC_SUCCESS && destroyCalls > 0,
		"upgraded session destruction still delegates after OFF");
	Check(!Upgraded(upgraded), "destroy removes the session ABI record");

	// Exercise actual TryInstall with fake loader/hooks; pause inside hook enable.
	hookTest = true;
	Configure(true, 1);
	auto installer = std::async(std::launch::async, []{ NvencTap::Get().TryInstall(); });
	{
		std::unique_lock<std::mutex> lock(hookMutex);
		Check(hookCondition.wait_for(lock, std::chrono::seconds(2), []{ return hookEntered; }), "installation reached paused enable");
	}
	Configure(false, 1);
	std::promise<void> readerStarted;
	auto reader = std::async(std::launch::async, [&]{ readerStarted.set_value(); return NvencTap::Get().GetRuntimeState(); });
	readerStarted.get_future().wait();
	Check(reader.wait_for(std::chrono::milliseconds(100)) == std::future_status::timeout,
		"OFF runtime snapshot waits for in-flight installation");
	{
		std::lock_guard<std::mutex> lock(hookMutex); hookRelease = true;
	}
	hookCondition.notify_all(); installer.get();
	const auto snapshot = reader.get();
	Check(!snapshot.enabled && snapshot.hookInstalled, "OFF snapshot reports completed hook installation");
	hookTest = false;
	std::cout << "NVENC toggle: " << checks << " checks, " << failures << " failures\n";
	return failures == 0 ? 0 : 1;
}
