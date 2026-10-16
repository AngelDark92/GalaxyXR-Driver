// Compile the actual shim implementation; substitute only external NVENC/D3D
// and hook dependencies. No GPU, injected hooks, or SteamVR process is used.
#include <windows.h>
#include <future>
#include <condition_variable>
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
#include <iostream>

Config driverConfig;
int logCalls = 0;
void DriverLog(const char*, ...) { ++logCalls; }

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
// 2026-10-16 filler capture: 0xdeadbeef = "not this codec" sentinel, reset
// on every capture and set per the GUID the encoder receives (CaptureInit)
uint32_t seenH264Filler = 0xdeadbeefu, seenHevcFiller = 0xdeadbeefu;
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
int initDriverCalls = 0;
int ordinaryCalls = 0;
NVENCSTATUS encodeDriverStatus = NV_ENC_ERR_GENERIC;
uint32_t seenMultiPass = 0;
uint32_t seenVbvDelay = 0;
NV_ENC_CONFIG_H264 seenH264Recipe{};
NV_ENC_CONFIG_HEVC_VUI_PARAMETERS seenHevcVui{};
NV_ENC_CONFIG_AV1 seenAv1Config{};
uint32_t seenH264Gop = 0, seenH264Idr = 0;

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
// 2026-10-16 fourth param: the filler-data knob published with the config
// (default false = today's pinned path).
void ConfigureCodec(bool enabled, int codec, int tile = 1536, bool filler = false){
	driverConfig.streamFrame.nvencTap = enabled;
	driverConfig.streamFrame.nvencCodec = codec;
	NvencTapConfig config;
	config.enabled = enabled;
	config.codec = codec;
	config.effectiveTileWidth = tile;
	config.fillerData = filler;
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

	// Actual GPU geometry limits are queried for the selected codec; user
	// requests never masquerade as hardware caps (including oversized tiles).
	for(int codec : {0, 1, 2}) for(int tile : {768, 1536, 3072}){
		ConfigureCodec(true, codec, tile);
		for(auto query : {NV_ENC_CAPS_WIDTH_MAX, NV_ENC_CAPS_HEIGHT_MAX}){
			auto probe = ShimCapsQuery(encoder, query);
			Check(probe.status == NV_ENC_SUCCESS && probe.value == 1 && probe.driverCalls == 1,
				"caps: selected codec geometry uses actual driver answer without request-derived limits");
			const GUID expected = codec == 1 ? NV_ENC_CODEC_H264_GUID : codec == 2 ? NV_ENC_CODEC_AV1_GUID : NV_ENC_CODEC_HEVC_GUID;
			Check(memcmp(&seenCapsGuid, &expected, sizeof(GUID)) == 0, "caps: driver receives selected codec GUID");
		}
	}
	ConfigureCodec(false, 1);
	auto disabledCaps = ShimCapsQuery(encoder, NV_ENC_CAPS_WIDTH_MAX);
	Check(disabledCaps.driverCalls == 1 && memcmp(&seenCapsGuid, &NV_ENC_CODEC_HEVC_GUID, sizeof(GUID)) == 0,
		"caps: disabled tap leaves caller codec and actual geometry untouched");
	// codec 0 stays published for the split tests below
	ConfigureCodec(true, 0);

	// split forcing must survive the codec swap (2026-10-13 fix): with split
	// enabled — the shipping default — a swapped session must still carry the
	// forced split bits, or NVENC rejects the big stream frame (INVALID_PARAM).
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
	Check(((seenInitFlags >> 5) & 0xFu) == 1, "codec+split: forced split bits present on the swapped session");
	Check(*((uint32_t*)&sinit.enablePTD + 1) == 0, "codec+split: caller flags word restored");
	Check(sinit.version == Tag111(5, true), "codec+split: caller version restored");

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

	// 2026-10-16 no-silent-settings: no maxEncode rewrite for codec 1 — the
	// caller's derived bounds pass through (3200x8192 stays 3200x8192).
	sinit.maxEncodeWidth = 3200; sinit.maxEncodeHeight = 8192;
	Check(NvencTapShims::InitializeEncoder(h264Enc, &sinit) == NV_ENC_SUCCESS, "h264 passthrough: init delegated");
	Check(seenMaxEncodeW == 3200u && seenMaxEncodeH == 8192u, "h264 passthrough: caller bounds reach the encoder unchanged");
	Check(sinit.maxEncodeWidth == 3200u && sinit.maxEncodeHeight == 8192u, "h264 passthrough: caller bounds untouched");

	// hevc+split regression: codec 0 keeps the forced split bits — the skip
	// must only drop them for H.264.
	driverConfig.streamFrame.nvencTap = true;
	driverConfig.streamFrame.nvencCodec = 0;
	driverConfig.streamFrame.nvencSplitMode = 1;
	NvencTapConfig hevcCfg; hevcCfg.enabled = true; hevcCfg.codec = 0; hevcCfg.splitMode = 1;
	NvencTap::Get().SetConfig(hevcCfg);
	void* hevcEnc = OpenSession();
	Check(NvencTapShims::InitializeEncoder(hevcEnc, &sinit) == NV_ENC_SUCCESS, "hevc+split: init delegated");
	Check(((seenInitFlags >> 5) & 0xFu) == 1, "hevc+split: forced split bits still present for HEVC");
	Check(*((uint32_t*)&sinit.enablePTD + 1) == 0, "hevc+split: caller flags word restored");

	// 2026-10-16 no-silent-settings (already-H264 caller): the caller hands
	// over the H264 GUID directly; no swap and no bounds rewrite happen.
	driverConfig.streamFrame.nvencTap = true;
	driverConfig.streamFrame.nvencCodec = 1;
	driverConfig.streamFrame.nvencSplitMode = 1;
	NvencTap::Get().SetConfig(h264Cfg);
	sinit.encodeGUID = NV_ENC_CODEC_H264_GUID;
	sinit.maxEncodeWidth = 8192; sinit.maxEncodeHeight = 8192;
	Check(NvencTapShims::InitializeEncoder(h264Enc, &sinit) == NV_ENC_SUCCESS, "h264 passthrough: already-H264 init delegated");
	Check(seenMaxEncodeW == 8192u && seenMaxEncodeH == 8192u, "h264 passthrough: already-H264 bounds flow through");
	Check(sinit.maxEncodeWidth == 8192u && sinit.maxEncodeHeight == 8192u, "h264 passthrough: already-H264 caller untouched");

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

	// 2026-10-16 filler-data toggle (streamFrame.nvencFillerDataInsertion,
	// published as NvencTapConfig::fillerData). H.264: the recipe pin is now
	// conditional - knob off pins a caller-carried 1 back to 0 (the existing
	// pin contract), knob on keeps the caller-carried 1 standing and lifts a
	// caller 0 to 1 (filler 0->1 [h264]).
	ConfigureCodec(true, 1, 1536, false);
	NV_ENC_CONFIG filOff = {}; filOff.version = Tag111(7, true); filOff.rcParams.version = Tag111(1);
	filOff.rcParams.averageBitRate = 42000000; filOff.gopLength = 60;
	filOff.profileGUID = NV_ENC_H264_PROFILE_HIGH_GUID;
	filOff.encodeCodecConfig.h264Config.enableFillerDataInsertion = 1;
	const auto savedFilOff = filOff;
	NV_ENC_INITIALIZE_PARAMS filInitOff = {}; filInitOff.version = Tag111(5, true);
	filInitOff.encodeGUID = NV_ENC_CODEC_H264_GUID; filInitOff.encodeConfig = &filOff;
	filInitOff.frameRateNum = 90; filInitOff.frameRateDen = 1;
	Check(NvencTapShims::InitializeEncoder(h264Enc, &filInitOff) == NV_ENC_SUCCESS, "filler h264: off init delegated");
	Check(seenH264Filler == 0u, "filler h264: knob off pins the caller-carried 1 back to 0 (pin contract stands)");
	Check(memcmp(&filOff, &savedFilOff, sizeof(filOff)) == 0, "filler h264: off caller config fully restored");

	ConfigureCodec(true, 1, 1536, true);
	NV_ENC_CONFIG filOn = {}; filOn.version = Tag111(7, true); filOn.rcParams.version = Tag111(1);
	filOn.rcParams.averageBitRate = 42000000; filOn.gopLength = 60;
	filOn.rcParams.rateControlMode = NV_ENC_PARAMS_RC_CBR;
	filOn.profileGUID = NV_ENC_H264_PROFILE_HIGH_GUID;
	filOn.encodeCodecConfig.h264Config.enableFillerDataInsertion = 1;
	const auto savedFilOn = filOn;
	NV_ENC_INITIALIZE_PARAMS filInitOn = {}; filInitOn.version = Tag111(5, true);
	filInitOn.encodeGUID = NV_ENC_CODEC_H264_GUID; filInitOn.encodeConfig = &filOn;
	filInitOn.frameRateNum = 90; filInitOn.frameRateDen = 1;
	Check(NvencTapShims::InitializeEncoder(h264Enc, &filInitOn) == NV_ENC_SUCCESS, "filler h264: on init delegated");
	Check(seenH264Filler == 1u, "filler h264: knob on keeps the caller-carried 1 standing (no pin)");
	Check(memcmp(&filOn, &savedFilOn, sizeof(filOn)) == 0, "filler h264: on caller config fully restored");

	// knob on + caller 0: the lift, same as the HEVC side
	NV_ENC_CONFIG filOn0 = {}; filOn0.version = Tag111(7, true); filOn0.rcParams.version = Tag111(1);
	filOn0.rcParams.averageBitRate = 42000000; filOn0.gopLength = 60;
	filOn0.rcParams.rateControlMode = NV_ENC_PARAMS_RC_CBR;
	filOn0.profileGUID = NV_ENC_H264_PROFILE_HIGH_GUID;
	filOn0.encodeCodecConfig.h264Config.enableFillerDataInsertion = 0;
	const auto savedFilOn0 = filOn0;
	NV_ENC_INITIALIZE_PARAMS filInitOn0 = {}; filInitOn0.version = Tag111(5, true);
	filInitOn0.encodeGUID = NV_ENC_CODEC_H264_GUID; filInitOn0.encodeConfig = &filOn0;
	filInitOn0.frameRateNum = 90; filInitOn0.frameRateDen = 1;
	Check(NvencTapShims::InitializeEncoder(h264Enc, &filInitOn0) == NV_ENC_SUCCESS, "filler h264: on+caller0 init delegated");
	Check(seenH264Filler == 1u, "filler h264: knob on lifts the caller 0 to 1 (filler 0->1 [h264])");
	Check(memcmp(&filOn0, &savedFilOn0, sizeof(filOn0)) == 0, "filler h264: on+caller0 caller config fully restored");

	// HEVC has the same explicit filler-bit semantics as H.264: On sets 1,
	// Off sets 0, and either path restores the caller's bytes afterwards.
	ConfigureCodec(true, 0, 1536, true);
	NV_ENC_CONFIG filHevc = {}; filHevc.version = Tag111(7, true); filHevc.rcParams.version = Tag111(1);
	filHevc.rcParams.averageBitRate = 42000000;
	filHevc.rcParams.rateControlMode = NV_ENC_PARAMS_RC_CBR;
	filHevc.encodeCodecConfig.hevcConfig.level = NV_ENC_LEVEL_HEVC_61;
	filHevc.encodeCodecConfig.hevcConfig.enableFillerDataInsertion = 0;
	const auto savedFilHevc = filHevc;
	NV_ENC_INITIALIZE_PARAMS filInitHevc = {}; filInitHevc.version = Tag111(5, true);
	filInitHevc.encodeGUID = NV_ENC_CODEC_HEVC_GUID; filInitHevc.encodeConfig = &filHevc;
	filInitHevc.frameRateNum = 90; filInitHevc.frameRateDen = 1;
	Check(NvencTapShims::InitializeEncoder(hevcEnc, &filInitHevc) == NV_ENC_SUCCESS, "filler hevc: on init delegated");
	Check(seenHevcFiller == 1u, "filler hevc: knob on lifts the caller 0 to 1 (filler 0->1 [hevc])");
	Check(memcmp(&filHevc, &savedFilHevc, sizeof(filHevc)) == 0, "filler hevc: on caller config fully restored");

	ConfigureCodec(true, 0, 1536, false);
	NV_ENC_CONFIG filHevcOff = {}; filHevcOff.version = Tag111(7, true); filHevcOff.rcParams.version = Tag111(1);
	filHevcOff.rcParams.averageBitRate = 42000000;
	filHevcOff.encodeCodecConfig.hevcConfig.level = NV_ENC_LEVEL_HEVC_61;
	filHevcOff.encodeCodecConfig.hevcConfig.enableFillerDataInsertion = 1;
	const auto savedFilHevcOff = filHevcOff;
	NV_ENC_INITIALIZE_PARAMS filInitHevcOff = {}; filInitHevcOff.version = Tag111(5, true);
	filInitHevcOff.encodeGUID = NV_ENC_CODEC_HEVC_GUID; filInitHevcOff.encodeConfig = &filHevcOff;
	filInitHevcOff.frameRateNum = 90; filInitHevcOff.frameRateDen = 1;
	Check(NvencTapShims::InitializeEncoder(hevcEnc, &filInitHevcOff) == NV_ENC_SUCCESS, "filler hevc: off init delegated");
	Check(seenHevcFiller == 0u, "filler hevc: knob off disables the upstream filler bit");
	Check(memcmp(&filHevcOff, &savedFilHevcOff, sizeof(filHevcOff)) == 0, "filler hevc: off caller config fully restored");

	// AV1 has no enableFillerDataInsertion API bit: knob on must find no
	// filler write path. The caller HEVC (bit 1) is swapped to AV1; the
	// delivered window carries no filler field and the caller is restored.
	driverConfig.streamFrame.nvencTap = true;
	driverConfig.streamFrame.nvencCodec = 2;
	driverConfig.streamFrame.nvencSplitMode = 1;
	NvencTapConfig filAv1; filAv1.enabled = true; filAv1.codec = 2; filAv1.splitMode = 1; filAv1.fillerData = true;
	NvencTap::Get().SetConfig(filAv1);
	void* av1FillEnc = OpenSession();
	Check(Upgraded(av1FillEnc), "filler av1: session upgraded for the AV1 swap");
	NV_ENC_CONFIG filAv1C = {}; filAv1C.version = Tag111(7, true); filAv1C.rcParams.version = Tag111(1);
	filAv1C.rcParams.averageBitRate = 42000000;
	filAv1C.profileGUID = NV_ENC_HEVC_PROFILE_MAIN_GUID;
	filAv1C.encodeCodecConfig.hevcConfig.level = NV_ENC_LEVEL_HEVC_61;
	filAv1C.encodeCodecConfig.hevcConfig.enableFillerDataInsertion = 1;
	const auto savedFilAv1C = filAv1C;
	NV_ENC_INITIALIZE_PARAMS filInitAv1 = {}; filInitAv1.version = Tag111(5, true);
	filInitAv1.encodeGUID = NV_ENC_CODEC_HEVC_GUID; filInitAv1.encodeConfig = &filAv1C;
	filInitAv1.frameRateNum = 90; filInitAv1.frameRateDen = 1;
	filInitAv1.bufferFormat = NV_ENC_BUFFER_FORMAT_YUV420_10BIT;
	filInitAv1.tuningInfo = NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY;
	Check(NvencTapShims::InitializeEncoder(av1FillEnc, &filInitAv1) == NV_ENC_SUCCESS, "filler av1: init delegated");
	Check(memcmp(&seenCodecGuid, &NV_ENC_CODEC_AV1_GUID, sizeof(GUID)) == 0, "filler av1: encoder receives the AV1 GUID");
	Check(seenH264Filler == 0xdeadbeefu && seenHevcFiller == 0xdeadbeefu, "filler av1: no filler field touched (AV1 has no API bit)");
	Check(memcmp(&filAv1C, &savedFilAv1C, sizeof(filAv1C)) == 0, "filler av1: caller config fully restored");

	ConfigureCodec(true, 0);
}

NVENCSTATUS NVENCAPI CaptureCanonicalPreset(void*, GUID, GUID, NV_ENC_TUNING_INFO, NV_ENC_PRESET_CONFIG* preset){
	preset->presetCfg.rcParams.multiPass = (NV_ENC_MULTI_PASS)1;
	return NV_ENC_SUCCESS;
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
		geometry.effectiveTileWidth = 1536;
		NvencTap::Get().SetConfig(geometry);
		auto negotiated = init; negotiated.encodeWidth = 1024; negotiated.encodeHeight = 4096;
		const auto original = negotiated; const auto originalConfig = config;
		const int before = initDriverCalls;
		Check(NvencTapShims::InitializeEncoder(encoder, &negotiated) == NV_ENC_ERR_INVALID_PARAM && initDriverCalls == before,
			"upstream geometry downgrade: every codec rejects 1024 when the user requested 1536");
		Check(memcmp(&negotiated, &original, sizeof(original)) == 0 && memcmp(&config, &originalConfig, sizeof(config)) == 0,
			"upstream geometry rejection: input parameters remain byte-exact");
		Check(NvencTap::Get().GetRuntimeState().error.find("1536") != std::string::npos,
			"upstream geometry rejection: UI error identifies requested dimensions");
		negotiated.encodeWidth = 1536; negotiated.encodeHeight = 6144;
		Check(NvencTapShims::InitializeEncoder(encoder, &negotiated) == NV_ENC_SUCCESS,
			"exact requested geometry: all codec requests reach NVENC unchanged");
	}
	NvencTap::Get().SetConfig(parseFailure); const int beforeParse = initDriverCalls;
	Check(NvencTapShims::InitializeEncoder(encoder, &init) == NV_ENC_ERR_INVALID_PARAM && initDriverCalls == beforeParse
		&& NvencTap::Get().GetRuntimeState().error == parseFailure.requestError,
		"parser rejection: runtime surfaces original error without default substitution");
	NvencTapConfig highRate; highRate.enabled = true; highRate.bitrateMbit = 2500; highRate.bitrateScale = false;
	NvencTap::Get().SetConfig(highRate);
	Check(NvencTapShims::InitializeEncoder(encoder, &init) == NV_ENC_SUCCESS && seenBitrate == 2500000000u,
		"requested bitrate above old 2000Mbps cap: exact representable value reaches NVENC");
	for(int split = 5; split <= 14; ++split){
		NvencTapConfig cfg; cfg.enabled = true; cfg.splitMode = split;
		NvencTap::Get().SetConfig(cfg); const int before = initDriverCalls;
		Check(NvencTapShims::InitializeEncoder(encoder, &init) == NV_ENC_ERR_INVALID_PARAM,
			"invalid split: rejected instead of normalized to AUTO");
		Check(initDriverCalls == before && memcmp(&init, &savedInit, sizeof(init)) == 0
			&& memcmp(&config, &savedConfig, sizeof(config)) == 0, "invalid split: no NVENC call or caller mutation");
	}
	for(int codec : {0, 1}){
		NvencTapConfig cfg; cfg.enabled = true; cfg.codec = codec; cfg.fillerData = true;
		NvencTap::Get().SetConfig(cfg);
		const int before = initDriverCalls;
		Check(NvencTapShims::InitializeEncoder(encoder, &init) == NV_ENC_ERR_INVALID_PARAM && initDriverCalls == before,
			"filler: actual VBR rejected without NVENC call");
		Check(memcmp(&init, &savedInit, sizeof(init)) == 0 && memcmp(&config, &savedConfig, sizeof(config)) == 0,
			"filler rejection: caller restored after tentative recipe writes");
		config.rcParams.rateControlMode = NV_ENC_PARAMS_RC_CBR;
		Check(NvencTapShims::InitializeEncoder(encoder, &init) == NV_ENC_SUCCESS,
			"filler: upstream CBR accepted while Force CBR is false");
		const auto runtime = NvencTap::Get().GetRuntimeState();
		Check(runtime.effectiveFiller == 1 && runtime.effectiveRateControl == NV_ENC_PARAMS_RC_CBR,
			"filler: runtime reports actual enabled CBR state");
		config.rcParams.rateControlMode = NV_ENC_PARAMS_RC_VBR;
		cfg.forceCbr = true; NvencTap::Get().SetConfig(cfg);
		Check(NvencTapShims::InitializeEncoder(encoder, &init) == NV_ENC_SUCCESS,
			"filler: forced CBR satisfies actual rate-control prerequisite");
	}
	NvencTapConfig cfg; cfg.enabled = true; cfg.fillerData = true;
	NvencTap::Get().SetConfig(cfg); config.rcParams.rateControlMode = NV_ENC_PARAMS_RC_CBR;
	for(int denominator : {0, 1}){
		init.frameRateNum = 0; init.frameRateDen = denominator; const int before = initDriverCalls;
		Check(NvencTapShims::InitializeEncoder(encoder, &init) == NV_ENC_ERR_INVALID_PARAM && initDriverCalls == before,
			"filler: zero frame rate rejected without NVENC call");
	}
	init = savedInit; config = savedConfig;
	cfg.fillerData = false; cfg.codec = 1; cfg.multiPass = 2; cfg.preset = 7;
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
		Check(memcmp(&init, &savedInit, sizeof(init)) == 0 && memcmp(&config, &savedConfig, sizeof(config)) == 0,
			"custom H264 recipe: complete caller data restored");
	}
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
	Check(destroyed.effectiveCodec == -1 && destroyed.effectiveFiller == -1 && destroyed.effectiveRateControl == -1
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
	return NV_ENC_SUCCESS;
}

NVENCSTATUS NVENCAPI CaptureInit(void*, NV_ENC_INITIALIZE_PARAMS* params){
	++initDriverCalls;
	if(!params){ return NV_ENC_ERR_INVALID_PTR; }
	if(failNextInit){ failNextInit = false; return NV_ENC_ERR_INVALID_PARAM; }
	seenInitVersion = params->version;
	seenConfigVersion = params->encodeConfig->version;
	seenRcVersion = params->encodeConfig->rcParams.version;
	seenInitFlags = *((uint32_t*)&params->enablePTD + 1);
	seenTuning = (uint32_t)params->tuningInfo;
	seenLevel = params->encodeConfig->encodeCodecConfig.hevcConfig.level;
	seenBitrate = params->encodeConfig->rcParams.averageBitRate;
	seenRcMode = (uint32_t)params->encodeConfig->rcParams.rateControlMode;
	seenKfScale = (uint32_t)params->encodeConfig->rcParams.lowDelayKeyFrameScale;
	seenMaxBitrate = params->encodeConfig->rcParams.maxBitRate;
	seenVbvSize = params->encodeConfig->rcParams.vbvBufferSize;
	seenVbvDelay = params->encodeConfig->rcParams.vbvInitialDelay;
	seenMultiPass = (uint32_t)params->encodeConfig->rcParams.multiPass;
	// 2026-10-13 codec override capture: GUID/profile always, codec fields
	// per the GUID the encoder actually receives.
	seenCodecGuid = params->encodeGUID;
	seenMaxEncodeW = params->maxEncodeWidth; seenMaxEncodeH = params->maxEncodeHeight;
	seenProfileGuid = params->encodeConfig->profileGUID;
	seenH264Level = 0xdeadbeefu; seenAv1Level = 0xdeadbeefu;
	seenH264Filler = 0xdeadbeefu; seenHevcFiller = 0xdeadbeefu;
	if(memcmp(&params->encodeGUID, &NV_ENC_CODEC_H264_GUID, sizeof(GUID)) == 0){
		seenH264Recipe = params->encodeConfig->encodeCodecConfig.h264Config;
		seenH264Level = params->encodeConfig->encodeCodecConfig.h264Config.level;
		seenH264BitDepth = (uint32_t)params->encodeConfig->encodeCodecConfig.h264Config.outputBitDepth;
		seenH264RepeatSpsPps = params->encodeConfig->encodeCodecConfig.h264Config.repeatSPSPPS;
		seenH264Gop = params->encodeConfig->gopLength;
		seenH264Idr = params->encodeConfig->encodeCodecConfig.h264Config.idrPeriod;
		seenH264Filler = params->encodeConfig->encodeCodecConfig.h264Config.enableFillerDataInsertion;
	}else if(memcmp(&params->encodeGUID, &NV_ENC_CODEC_AV1_GUID, sizeof(GUID)) == 0){
		seenAv1Config = params->encodeConfig->encodeCodecConfig.av1Config;
		seenAv1Level = params->encodeConfig->encodeCodecConfig.av1Config.level;
		seenAv1BitDepth = (uint32_t)params->encodeConfig->encodeCodecConfig.av1Config.outputBitDepth;
		seenAv1InputBitDepth = (uint32_t)params->encodeConfig->encodeCodecConfig.av1Config.inputBitDepth;
		seenAv1Flags = *((uint32_t*)((unsigned char*)&params->encodeConfig->encodeCodecConfig.av1Config + 16));
		seenAv1RepeatSeqHdr = params->encodeConfig->encodeCodecConfig.av1Config.repeatSeqHdr;
	}else if(memcmp(&params->encodeGUID, &NV_ENC_CODEC_HEVC_GUID, sizeof(GUID)) == 0){
		seenHevcVui = params->encodeConfig->encodeCodecConfig.hevcConfig.hevcVUIParameters;
		seenHevcFiller = params->encodeConfig->encodeCodecConfig.hevcConfig.enableFillerDataInsertion;
	}
	return NV_ENC_SUCCESS;
}

const void* seenOrdinary = nullptr;
NVENCSTATUS NVENCAPI CaptureReconfigure(void*, NV_ENC_RECONFIGURE_PARAMS* p){ ++ordinaryCalls; seenOrdinary = p; return NV_ENC_ERR_GENERIC; }
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
	Check(NvencTapShims::InitializeEncoder(encoder, nullptr) == NV_ENC_ERR_INVALID_PTR, "OFF null init delegated");
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
	Check(logCalls == logsBefore, "OFF no diagnostic logs");
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
	CheckDeltaMapConversion();
	CheckSessionCodecGating();

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
