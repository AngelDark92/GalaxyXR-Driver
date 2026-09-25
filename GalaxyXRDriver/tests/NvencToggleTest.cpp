// Compile the actual shim implementation; substitute only external NVENC/D3D
// and hook dependencies. No GPU, injected hooks, or SteamVR process is used.
#include "../src/Driver/NvencTap.cpp"
#include <cstdlib>
#include <iostream>

Config driverConfig;
void DriverLog(const char*, ...) {}

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
int destroyCalls = 0;

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

NVENCSTATUS NVENCAPI CaptureOpen(NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS* params, void** encoder){
	openApis.push_back(params->apiVersion);
	openVersions.push_back(params->version);
	if(rejectOpenUpgrade && params->apiVersion == kApi121){ return NV_ENC_ERR_INVALID_VERSION; }
	*encoder = reinterpret_cast<void*>(nextHandle++);
	return NV_ENC_SUCCESS;
}

NVENCSTATUS NVENCAPI CaptureList(NV_ENCODE_API_FUNCTION_LIST* list){
	listVersions.push_back(list->version);
	if(rejectListUpgrade && (list->version & 0xffffu) == 12u){ return NV_ENC_ERR_INVALID_VERSION; }
	return NV_ENC_SUCCESS;
}

NVENCSTATUS NVENCAPI CaptureCaps(void*, GUID, NV_ENC_CAPS_PARAM* params, int* value){
	seenCapsVersion = params->version;
	*value = 1;
	return NV_ENC_SUCCESS;
}

NVENCSTATUS NVENCAPI CaptureInit(void*, NV_ENC_INITIALIZE_PARAMS* params){
	seenInitVersion = params->version;
	seenConfigVersion = params->encodeConfig->version;
	seenRcVersion = params->encodeConfig->rcParams.version;
	seenLevel = params->encodeConfig->encodeCodecConfig.hevcConfig.level;
	seenBitrate = params->encodeConfig->rcParams.averageBitRate;
	return NV_ENC_SUCCESS;
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
}
}

// Any attempted GPU processing or hook installation is a test failure, not a
// silent fallback. The cases below exercise only the actual API shims.
namespace NvencPostPack {
bool Process(void*, uint32_t){ std::abort(); }
NvencPostPackStats GetStats(){ std::abort(); }
void ResetIntervalStats(){ std::abort(); }
}
extern "C" MH_STATUS WINAPI MH_Initialize(){ std::abort(); }
extern "C" MH_STATUS WINAPI MH_CreateHook(LPVOID, LPVOID, LPVOID*){ std::abort(); }
extern "C" MH_STATUS WINAPI MH_EnableHook(LPVOID){ std::abort(); }

int main(){
	origOpenEncodeSessionEx = CaptureOpen;
	origCreateInstance = CaptureList;
	origGetEncodeCaps = CaptureCaps;
	origInitializeEncoder = CaptureInit;
	origDestroyEncoder = CaptureDestroy;

	Configure(false, 1);
	void* stock = OpenSession();
	Check(openApis == std::vector<uint32_t>{kApi111} && openVersions[0] == Tag111(1),
		"OFF with saved split mode opens stock 11.1 session");
	Check(!Upgraded(stock), "OFF session is not marked upgraded");
	CreateFunctionList();
	Check(listVersions == std::vector<uint32_t>{Tag111(2)}, "OFF creates stock function list");

	Configure(true, 1);
	CreateFunctionList();
	Check(listVersions == std::vector<uint32_t>{Tag121(2, false)}, "ON upgrades function list");
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

	std::cout << "NVENC toggle: " << checks << " checks, " << failures << " failures\n";
	return failures == 0 ? 0 : 1;
}
