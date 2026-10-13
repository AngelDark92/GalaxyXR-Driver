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
uint32_t seenLevel = 0;
uint32_t seenBitrate = 0;
GUID seenCodecGuid{};
GUID seenProfileGuid{};
uint32_t seenH264Level = 0, seenH264BitDepth = 0, seenH264RepeatSpsPps = 0;
uint32_t seenAv1Level = 0, seenAv1BitDepth = 0, seenAv1RepeatSeqHdr = 0;
int destroyCalls = 0;
int capsCalls = 0;

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

void ConfigureCodec(bool enabled, int codec){
	driverConfig.streamFrame.nvencTap = enabled;
	driverConfig.streamFrame.nvencCodec = codec;
	NvencTapConfig config;
	config.enabled = enabled;
	config.codec = codec;
	NvencTap::Get().SetConfig(config);
}

void CheckCodecOverride(void* encoder){
	// H.264 rewrite: GUID + profile + 8-bit + SPS/PPS repeat, full caller restore after
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
	Check(seenH264BitDepth == NV_ENC_BIT_DEPTH_8, "codec H264: 8-bit output");
	Check(seenH264RepeatSpsPps == 1, "codec H264: repeatSPSPPS");
	Check(memcmp(&init, &savedInit, sizeof(init)) == 0, "codec H264: caller init fully restored");
	Check(memcmp(&cfg, &savedCfg, sizeof(cfg)) == 0, "codec H264: caller config fully restored");

	// AV1 rewrite
	ConfigureCodec(true, 2);
	NV_ENC_CONFIG cfg2 = {}; cfg2.version = Tag111(7, true); cfg2.rcParams.version = Tag111(1);
	cfg2.rcParams.averageBitRate = 42000000; cfg2.gopLength = 60;
	cfg2.profileGUID = NV_ENC_HEVC_PROFILE_MAIN_GUID;
	cfg2.encodeCodecConfig.hevcConfig.level = NV_ENC_LEVEL_HEVC_61;
	cfg2.encodeCodecConfig.hevcConfig.outputBitDepth = NV_ENC_BIT_DEPTH_10;
	const auto savedCfg2 = cfg2;
	NV_ENC_INITIALIZE_PARAMS init2 = {}; init2.version = Tag111(5, true);
	init2.encodeGUID = NV_ENC_CODEC_HEVC_GUID; init2.encodeConfig = &cfg2;
	init2.frameRateNum = 90; init2.frameRateDen = 1;
	Check(NvencTapShims::InitializeEncoder(encoder, &init2) == NV_ENC_SUCCESS, "codec AV1: init delegated");
	Check(memcmp(&seenCodecGuid, &NV_ENC_CODEC_AV1_GUID, sizeof(GUID)) == 0, "codec AV1: encoder gets the AV1 GUID");
	Check(memcmp(&seenProfileGuid, &NV_ENC_AV1_PROFILE_MAIN_GUID, sizeof(GUID)) == 0, "codec AV1: profile is Main");
	Check(seenAv1Level == NV_ENC_LEVEL_AV1_AUTOSELECT, "codec AV1: level AUTOSELECT");
	Check(seenAv1BitDepth == NV_ENC_BIT_DEPTH_8, "codec AV1: 8-bit output");
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

NVENCSTATUS NVENCAPI CaptureCaps(void*, GUID, NV_ENC_CAPS_PARAM* params, int* value){
	++capsCalls;
	seenCapsVersion = params->version;
	*value = 1;
	return NV_ENC_SUCCESS;
}

NVENCSTATUS NVENCAPI CaptureInit(void*, NV_ENC_INITIALIZE_PARAMS* params){
	if(!params){ return NV_ENC_ERR_INVALID_PTR; }
	seenInitVersion = params->version;
	seenConfigVersion = params->encodeConfig->version;
	seenRcVersion = params->encodeConfig->rcParams.version;
	seenLevel = params->encodeConfig->encodeCodecConfig.hevcConfig.level;
	seenBitrate = params->encodeConfig->rcParams.averageBitRate;
	// 2026-10-13 codec override capture: GUID/profile always, codec fields
	// per the GUID the encoder actually receives.
	seenCodecGuid = params->encodeGUID;
	seenProfileGuid = params->encodeConfig->profileGUID;
	seenH264Level = 0xdeadbeefu; seenAv1Level = 0xdeadbeefu;
	if(memcmp(&params->encodeGUID, &NV_ENC_CODEC_H264_GUID, sizeof(GUID)) == 0){
		seenH264Level = params->encodeConfig->encodeCodecConfig.h264Config.level;
		seenH264BitDepth = (uint32_t)params->encodeConfig->encodeCodecConfig.h264Config.outputBitDepth;
		seenH264RepeatSpsPps = params->encodeConfig->encodeCodecConfig.h264Config.repeatSPSPPS;
	}else if(memcmp(&params->encodeGUID, &NV_ENC_CODEC_AV1_GUID, sizeof(GUID)) == 0){
		seenAv1Level = params->encodeConfig->encodeCodecConfig.av1Config.level;
		seenAv1BitDepth = (uint32_t)params->encodeConfig->encodeCodecConfig.av1Config.outputBitDepth;
		seenAv1RepeatSeqHdr = params->encodeConfig->encodeCodecConfig.av1Config.repeatSeqHdr;
	}
	return NV_ENC_SUCCESS;
}

int ordinaryCalls = 0;
const void* seenOrdinary = nullptr;
uint32_t seenPictureVersion = 0, seenLockVersion = 0;
NVENCSTATUS NVENCAPI CaptureReconfigure(void*, NV_ENC_RECONFIGURE_PARAMS* p){ ++ordinaryCalls; seenOrdinary = p; return NV_ENC_ERR_GENERIC; }
NVENCSTATUS NVENCAPI CaptureRegister(void*, NV_ENC_REGISTER_RESOURCE* p){ ++ordinaryCalls; seenOrdinary = p; return NV_ENC_ERR_GENERIC; }
NVENCSTATUS NVENCAPI CaptureMap(void*, NV_ENC_MAP_INPUT_RESOURCE* p){ ++ordinaryCalls; seenOrdinary = p; return NV_ENC_ERR_GENERIC; }
NVENCSTATUS NVENCAPI CaptureEncode(void*, NV_ENC_PIC_PARAMS* p){ ++ordinaryCalls; seenOrdinary = p; seenPictureVersion = p ? p->version : 0; return NV_ENC_ERR_GENERIC; }
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

	Configure(true, 0);
	stock = OpenSession();
	Check(openApis == std::vector<uint32_t>{kApi111} && !Upgraded(stock), "split mode zero leaves session stock");
	CreateFunctionList();
	Check(listVersions == std::vector<uint32_t>{Tag111(2)}, "split mode zero leaves function list stock");

	Configure(true, 1);
	rejectOpenUpgrade = true;
	stock = OpenSession();
	Check(openApis == std::vector<uint32_t>{kApi121, kApi111}, "rejected upgrade retries pristine session");
	Check(!Upgraded(stock) && sessionUpgradeRejected.load(), "rejected upgrade latches stock behavior");
	OpenSession();
	Check(openApis == std::vector<uint32_t>{kApi111}, "rejected session upgrade is not retried");
	CreateFunctionList();
	Check(listVersions == std::vector<uint32_t>{Tag111(2)}, "session rejection also prevents list upgrade");
	rejectOpenUpgrade = false;

	// A fresh runtime starts with no rejection; simulate it for the list case.
	sessionUpgradeRejected.store(false);
	rejectListUpgrade = true;
	CreateFunctionList();
	Check(listVersions == std::vector<uint32_t>{Tag121(2, false), Tag111(2)},
		"rejected upgraded function list retries pristine list");
	Check(sessionUpgradeRejected.load(), "function-list rejection latches stock behavior");
	stock = OpenSession();
	Check(openApis == std::vector<uint32_t>{kApi111} && !Upgraded(stock),
		"function-list rejection prevents subsequent session upgrade");
	Configure(false, 1);
	CheckExistingSessionAfterOff(upgraded);
	Check(NvencTapShims::DestroyEncoder(upgraded) == NV_ENC_SUCCESS && destroyCalls == 1,
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
