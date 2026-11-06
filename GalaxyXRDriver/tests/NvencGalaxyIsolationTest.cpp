// Vendor (VENDOR_GALAXYXR) NvencTap path: compiles the real NvencTap.cpp with a
// mock Galaxy link epoch, a fake driver_vrlink.dll import image and fake NVENC
// entry points. No GPU, DLL load, SteamVR process or real hook is used.
#include <windows.h>
#include <atomic>
#include <cstdarg>
#include <cstdlib>
#include <future>
#include <iostream>
#include <mutex>
#include <string>
#include <vector>

HMODULE WINAPI FakeModuleW(LPCWSTR);
BOOL WINAPI FakeModuleEx(DWORD, LPCWSTR, HMODULE*);
DWORD WINAPI FakeModuleFileName(HMODULE, LPWSTR, DWORD);
HMODULE WINAPI ForbiddenLoad(LPCSTR);
#define GetModuleHandleW FakeModuleW
#define GetModuleHandleExW FakeModuleEx
#define GetModuleFileNameW FakeModuleFileName
#define LoadLibraryA ForbiddenLoad
#define LoadLibraryW ForbiddenLoad
#define GXR_GALAXYLINK_EPOCH_HEADER "../../tests/mocks/GalaxyLinkEpochMock.h"
#include "../src/Driver/NvencTap.cpp"
#undef GetModuleHandleW
#undef GetModuleHandleExW
#undef GetModuleFileNameW
#undef LoadLibraryA
#undef LoadLibraryW

Config driverConfig;
namespace NvencPostPack {
int processCalls = 0;
bool Process(void*, uint32_t){ ++processCalls; return true; }
NvencPostPackStats GetStats(){ return {}; }
void ResetIntervalStats(){}
std::vector<void*> releasedTextures; int releaseCalls = 0;
size_t ReleaseTextures(void* const* textures, size_t count){ ++releaseCalls; for(size_t i = 0; i < count; i++){ releasedTextures.push_back(textures[i]); } return count; }
size_t CachedTextureCount(){ return 0; }
}

void FrameShimCadenceSnapshot(uint32_t* count, double* maxGapMs){ *count = 0; *maxGapMs = 0; }

namespace {
std::mutex logMutex;
std::vector<std::string> logs;
}
void DriverLog(const char* format, ...){
	char text[1024];
	va_list args; va_start(args, format); std::vsnprintf(text, sizeof(text), format, args); va_end(args);
	std::lock_guard<std::mutex> g(logMutex); logs.emplace_back(text);
}

namespace {
namespace mock = gxr::galaxylink::mock;
int checks = 0, failures = 0;
void Check(bool ok, const char* label){ checks++; if(!ok){ failures++; std::cerr << "FAIL: " << label << '\n'; } }
int LogCount(const char* needle){
	std::lock_guard<std::mutex> g(logMutex); int n = 0;
	for(const auto& l : logs){ if(l.find(needle) != std::string::npos){ n++; } }
	return n;
}

constexpr uint32_t Tag111(uint32_t digit, bool b31 = false){ return kApi111 | (digit << 16) | (0x7u << 28) | (b31 ? (1u << 31) : 0u); }

// ---- fake NVENC runtime ----
struct Seen { int calls = 0; void* encoder = nullptr; const void* ptr = nullptr; uint32_t version = 0; std::vector<unsigned char> bytes; };
template<typename T> void Record(Seen& s, void* encoder, const T* p){
	s.calls++; s.encoder = encoder; s.ptr = p; s.version = p ? *reinterpret_cast<const uint32_t*>(p) : 0;
	s.bytes.clear(); if(p){ s.bytes.assign(reinterpret_cast<const unsigned char*>(p), reinterpret_cast<const unsigned char*>(p) + sizeof(T)); }
}
template<typename T> std::vector<unsigned char> Bytes(const T& value){
	return std::vector<unsigned char>(reinterpret_cast<const unsigned char*>(&value), reinterpret_cast<const unsigned char*>(&value) + sizeof(T));
}
Seen sOpen, sCaps, sInit, sReconf, sReg, sMap, sUnreg, sUnmap, sEncode, sLock, sDestroy;
uintptr_t nextHandle = 0x1000, forcedHandle = 0;
NVENCSTATUS openStatus = NV_ENC_SUCCESS, initStatus = NV_ENC_SUCCESS;
uint32_t seenOpenApi = 0, seenOpenVersion = 0;
uint32_t seenBitrate = 0, seenMaxBitrate = 0, seenLevel = 0, seenPicVersion = 0, seenLockVersion = 0, seenConfigVersion = 0;
const int8_t* seenQpMap = nullptr;
int capsWidth = 4096, capsHeight = 16384;
NVENCSTATUS createStatus = NV_ENC_SUCCESS;
std::vector<uint32_t> createVersions; std::vector<const void*> createPointers;
bool altInit = false;

NVENCSTATUS NVENCAPI FakeOpen(NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS* p, void** encoder){
	Record(sOpen, nullptr, p); seenOpenApi = p->apiVersion; seenOpenVersion = p->version;
	if(openStatus != NV_ENC_SUCCESS){ return openStatus; }
	*encoder = reinterpret_cast<void*>(forcedHandle ? forcedHandle : (nextHandle += 0x10));
	return NV_ENC_SUCCESS;
}
NVENCSTATUS NVENCAPI FakeCaps(void* e, GUID, NV_ENC_CAPS_PARAM* p, int* v){
	Record(sCaps, e, p);
	*v = p->capsToQuery == NV_ENC_CAPS_WIDTH_MAX ? capsWidth : p->capsToQuery == NV_ENC_CAPS_HEIGHT_MAX ? capsHeight : 1;
	return NV_ENC_SUCCESS;
}
NVENCSTATUS NVENCAPI FakeInit(void* e, NV_ENC_INITIALIZE_PARAMS* p){
	Record(sInit, e, p);
	if(p && p->encodeConfig){ seenBitrate = p->encodeConfig->rcParams.averageBitRate; seenMaxBitrate = p->encodeConfig->rcParams.maxBitRate; seenLevel = p->encodeConfig->encodeCodecConfig.hevcConfig.level; seenConfigVersion = p->encodeConfig->version; }
	return initStatus;
}
NVENCSTATUS NVENCAPI FakeReconf(void* e, NV_ENC_RECONFIGURE_PARAMS* p){
	Record(sReconf, e, p);
	if(p && p->reInitEncodeParams.encodeConfig){ seenBitrate = p->reInitEncodeParams.encodeConfig->rcParams.averageBitRate; seenMaxBitrate = p->reInitEncodeParams.encodeConfig->rcParams.maxBitRate; }
	return NV_ENC_SUCCESS;
}
uintptr_t nextRegistered = 0x9000;
NVENCSTATUS NVENCAPI FakeRegister(void* e, NV_ENC_REGISTER_RESOURCE* p){ Record(sReg, e, p); p->registeredResource = reinterpret_cast<void*>(nextRegistered += 8); return NV_ENC_SUCCESS; }
NVENCSTATUS NVENCAPI FakeMap(void* e, NV_ENC_MAP_INPUT_RESOURCE* p){ Record(sMap, e, p); p->mappedResource = reinterpret_cast<void*>(0x7700); return NV_ENC_SUCCESS; }
NVENCSTATUS unregStatus = NV_ENC_SUCCESS, destroyStatus = NV_ENC_SUCCESS;
NVENCSTATUS NVENCAPI FakeUnreg(void* e, NV_ENC_REGISTERED_PTR r){ sUnreg.calls++; sUnreg.encoder = e; sUnreg.ptr = r; return unregStatus; }
NVENCSTATUS NVENCAPI FakeUnmap(void* e, NV_ENC_INPUT_PTR m){ sUnmap.calls++; sUnmap.encoder = e; sUnmap.ptr = m; return NV_ENC_SUCCESS; }
NVENCSTATUS NVENCAPI FakeEncode(void* e, NV_ENC_PIC_PARAMS* p){ Record(sEncode, e, p); seenPicVersion = p->version; seenQpMap = p->qpDeltaMap; return NV_ENC_SUCCESS; }
NVENCSTATUS NVENCAPI FakeLock(void* e, NV_ENC_LOCK_BITSTREAM* p){ Record(sLock, e, p); seenLockVersion = p->version; p->bitstreamSizeInBytes = 1000; return NV_ENC_SUCCESS; }
NVENCSTATUS NVENCAPI FakeDestroy(void* e){ sDestroy.calls++; sDestroy.encoder = e; return destroyStatus; }
const char* NVENCAPI FakeLastError(void*){ return ""; }
template<int N> NVENCSTATUS NVENCAPI Stub(void*){ return NV_ENC_SUCCESS; }
// capability inventory: all three codecs and presets P1..P7 are available
NVENCSTATUS NVENCAPI FakeGuidCount(void*, uint32_t* count){ *count = 3; return NV_ENC_SUCCESS; }
NVENCSTATUS NVENCAPI FakeGuids(void*, GUID* guids, uint32_t size, uint32_t* fetched){
	const GUID all[3] = { NV_ENC_CODEC_HEVC_GUID, NV_ENC_CODEC_H264_GUID, NV_ENC_CODEC_AV1_GUID };
	*fetched = 0; for(int i = 0; i < 3 && *fetched < size; i++){ guids[(*fetched)++] = all[i]; }
	return NV_ENC_SUCCESS;
}
NVENCSTATUS NVENCAPI FakePresetCount(void*, GUID, uint32_t* count){ *count = 7; return NV_ENC_SUCCESS; }
NVENCSTATUS NVENCAPI FakePresetGuids(void*, GUID, GUID* guids, uint32_t size, uint32_t* fetched){
	*fetched = 0; for(int p = 1; p <= 7 && *fetched < size; p++){ guids[(*fetched)++] = *PresetGuid(p); }
	return NV_ENC_SUCCESS;
}
NVENCSTATUS NVENCAPI FakeInitAlt(void*, NV_ENC_INITIALIZE_PARAMS*){ return NV_ENC_SUCCESS; }

#define STUB(member, N) list->member = reinterpret_cast<decltype(list->member)>(&Stub<N>)
std::mutex createMutex;
// capture the simple wrappers' parameter bytes (ABI retag must not leak onto pristine handles)
Seen sInBuf, sEvent, sSeq;
NVENCSTATUS NVENCAPI FakeInBuf(void* e, NV_ENC_CREATE_INPUT_BUFFER* p){ Record(sInBuf, e, p); return NV_ENC_SUCCESS; }
NVENCSTATUS NVENCAPI FakeEvent(void* e, NV_ENC_EVENT_PARAMS* p){ Record(sEvent, e, p); return NV_ENC_SUCCESS; }
NVENCSTATUS NVENCAPI FakeSeq(void* e, NV_ENC_SEQUENCE_PARAM_PAYLOAD* p){ Record(sSeq, e, p); return NV_ENC_SUCCESS; }
NVENCSTATUS NVENCAPI FakeCreate(NV_ENCODE_API_FUNCTION_LIST* list){
	{ std::lock_guard<std::mutex> g(createMutex); createVersions.push_back(list->version); createPointers.push_back(list); }
	if(createStatus != NV_ENC_SUCCESS){ return createStatus; }
	list->nvEncInitializeEncoder = altInit ? &FakeInitAlt : &FakeInit;
	list->nvEncReconfigureEncoder = &FakeReconf; list->nvEncRegisterResource = &FakeRegister;
	list->nvEncEncodePicture = &FakeEncode; list->nvEncLockBitstream = &FakeLock;
	list->nvEncOpenEncodeSessionEx = &FakeOpen; list->nvEncDestroyEncoder = &FakeDestroy;
	list->nvEncGetEncodeCaps = &FakeCaps; list->nvEncMapInputResource = &FakeMap;
	list->nvEncUnregisterResource = &FakeUnreg; list->nvEncUnmapInputResource = &FakeUnmap;
	list->nvEncGetLastErrorString = &FakeLastError;
	list->nvEncGetEncodeGUIDCount = &FakeGuidCount; list->nvEncGetEncodeGUIDs = &FakeGuids;
	list->nvEncGetEncodePresetCount = &FakePresetCount; list->nvEncGetEncodePresetGUIDs = &FakePresetGuids;
	STUB(nvEncGetEncodePresetConfig, 5); STUB(nvEncGetEncodePresetConfigEx, 6); list->nvEncCreateInputBuffer = &FakeInBuf;
	STUB(nvEncCreateBitstreamBuffer, 8); STUB(nvEncCreateMVBuffer, 9); list->nvEncRegisterAsyncEvent = &FakeEvent;
	STUB(nvEncUnregisterAsyncEvent, 11); STUB(nvEncLockInputBuffer, 12); list->nvEncGetSequenceParams = &FakeSeq;
	STUB(nvEncRunMotionEstimationOnly, 14);
	return NV_ENC_SUCCESS;
}

void ResetSeen(){ for(Seen* s : { &sOpen, &sCaps, &sInit, &sReconf, &sReg, &sMap, &sUnreg, &sUnmap, &sEncode, &sLock, &sDestroy, &sInBuf, &sEvent, &sSeq }){ *s = Seen{}; } }

NV_ENC_CONFIG MakeConfig(){
	NV_ENC_CONFIG c = {}; c.version = Tag111(7, true); c.rcParams.version = Tag111(1);
	c.rcParams.averageBitRate = 42000000; c.rcParams.maxBitRate = 42000000; c.gopLength = 60;
	c.encodeCodecConfig.hevcConfig.level = NV_ENC_LEVEL_HEVC_61;
	return c;
}
NV_ENC_INITIALIZE_PARAMS MakeInit(NV_ENC_CONFIG* c){
	NV_ENC_INITIALIZE_PARAMS i = {}; i.version = Tag111(5, true); i.encodeGUID = NV_ENC_CODEC_HEVC_GUID;
	i.encodeConfig = c; i.frameRateNum = 90; i.frameRateDen = 1; i.encodeWidth = 1536; i.encodeHeight = 6144;
	i.maxEncodeWidth = 1536; i.maxEncodeHeight = 6144;
	return i;
}

// Force CBR makes the applied average and maximum both exactly `bitrate`.
void Configure(bool enabled, int bitrate = 0, int qpFovea = 0, int qpPeriphery = 0, bool enforceTile = false){
	NvencTapConfig c; c.enabled = enabled; c.splitMode = 1; c.bitrateMbit = bitrate; c.forceCbr = bitrate > 0;
	c.qpFovea = qpFovea; c.qpPeriphery = qpPeriphery; c.enforceTile = enforceTile; c.effectiveTileWidth = 1536;
	NvencTap::Get().SetConfig(c);
}

NV_ENCODE_API_FUNCTION_LIST gTable{};
void* OpenVia(NV_ENCODE_API_FUNCTION_LIST& list, NVENCSTATUS expected = NV_ENC_SUCCESS){
	NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS p = {}; p.apiVersion = kApi111; p.version = Tag111(1);
	const auto before = Bytes(p); void* e = nullptr;
	const NVENCSTATUS st = list.nvEncOpenEncodeSessionEx(&p, &e);
	Check(st == expected, "open status");
	Check(Bytes(p) == before, "open caller params restored");
	return e;
}
void InstallTable(NV_ENCODE_API_FUNCTION_LIST& list){
	list = {}; list.version = Tag111(2);
	realCreateInstance.store(reinterpret_cast<void*>(&FakeCreate));
	Check(NvencTapShims::CreateInstance(&list) == NV_ENC_SUCCESS, "create instance status");
}

// ---- fake driver_vrlink.dll image (x64 PE with kernel32 + CRT imports) ----
constexpr size_t kImageSize = 0x4000;
struct Image {
	unsigned char* base;
	Image(bool withCrt){
		base = static_cast<unsigned char*>(VirtualAlloc(nullptr, kImageSize, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE));
		auto* dos = reinterpret_cast<IMAGE_DOS_HEADER*>(base); dos->e_magic = IMAGE_DOS_SIGNATURE; dos->e_lfanew = 0x80;
		auto* nt = reinterpret_cast<IMAGE_NT_HEADERS64*>(base + 0x80);
		nt->Signature = IMAGE_NT_SIGNATURE; nt->OptionalHeader.Magic = IMAGE_NT_OPTIONAL_HDR64_MAGIC; nt->OptionalHeader.SizeOfImage = kImageSize;
		nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT] = { 0x1000, 3 * sizeof(IMAGE_IMPORT_DESCRIPTOR) };
		auto* d = reinterpret_cast<IMAGE_IMPORT_DESCRIPTOR*>(base + 0x1000);
		d[0].Name = 0x1100; d[0].OriginalFirstThunk = 0x1200; d[0].FirstThunk = 0x2000;
		std::memcpy(base + 0x1100, "KERNEL32.dll", 13);
		Put(0x1400, "GetProcAddress"); Put(0x1420, "LoadLibraryA");
		auto* n0 = reinterpret_cast<uint64_t*>(base + 0x1200); n0[0] = 0x1400; n0[1] = 0x1420; n0[2] = 0;
		auto* i0 = reinterpret_cast<void**>(base + 0x2000); i0[0] = reinterpret_cast<void*>(&RealGpa); i0[1] = reinterpret_cast<void*>(&Other);
		if(withCrt){
			d[1].Name = 0x1110; d[1].OriginalFirstThunk = 0x1240; d[1].FirstThunk = 0x2040;
			std::memcpy(base + 0x1110, "api-ms-win-crt-stdio-l1-1-0.dll", 32);
			Put(0x1440, "__stdio_common_vsnprintf_s");
			auto* n1 = reinterpret_cast<uint64_t*>(base + 0x1240); n1[0] = 0x1440; n1[1] = 0;
			auto* i1 = reinterpret_cast<void**>(base + 0x2040); i1[0] = reinterpret_cast<void*>(&RealVsnprintf);
		}
	}
	~Image(){ VirtualFree(base, 0, MEM_RELEASE); }
	void Put(uint32_t rva, const char* name){ std::memcpy(base + rva + 2, name, std::strlen(name) + 1); }
	void** GpaSlot(){ return reinterpret_cast<void**>(base + 0x2000); }
	void** CrtSlot(){ return reinterpret_cast<void**>(base + 0x2040); }
	HMODULE Module(){ return reinterpret_cast<HMODULE>(base); }
	static FARPROC WINAPI RealGpa(HMODULE module, LPCSTR name){ lastGpaModule = module; lastGpaName = name; return gpaResult; }
	static void Other(){}
	static int RealVsnprintf(unsigned long long, char* buffer, size_t count, size_t, const char* format, void*, char*){
		realFormatCalls++; if(buffer && count){ std::snprintf(buffer, count, "%s", format); } return static_cast<int>(std::strlen(format));
	}
	static inline HMODULE lastGpaModule = nullptr; static inline LPCSTR lastGpaName = nullptr; static inline FARPROC gpaResult = nullptr;
	static inline int realFormatCalls = 0;
};
Image* gVrlink = nullptr;
HMODULE gNvencModule = reinterpret_cast<HMODULE>(0x71000), gOtherModule = reinterpret_cast<HMODULE>(0x72000);
const wchar_t* gNvencFile = L"C:\\Windows\\System32\\nvEncodeAPI64.dll";
const wchar_t* gOtherFile = L"C:\\Windows\\System32\\other.dll";
HMODULE gOwnerFor = nullptr; int gPins = 0;
}

HMODULE WINAPI FakeModuleW(LPCWSTR name){ return (gVrlink && name && wcscmp(name, L"driver_vrlink.dll") == 0) ? gVrlink->Module() : nullptr; }
BOOL WINAPI FakeModuleEx(DWORD flags, LPCWSTR, HMODULE* out){
	if(flags & GET_MODULE_HANDLE_EX_FLAG_PIN){ gPins++; *out = reinterpret_cast<HMODULE>(0x1); return TRUE; }
	*out = gOwnerFor; return gOwnerFor != nullptr;
}
DWORD WINAPI FakeModuleFileName(HMODULE m, LPWSTR buffer, DWORD size){
	const wchar_t* file = m == gNvencModule ? gNvencFile : m == gOtherModule ? gOtherFile : L"";
	const DWORD length = static_cast<DWORD>(wcslen(file)); if(length + 1 > size){ return 0; }
	wcscpy_s(buffer, size, file); return length;
}
HMODULE WINAPI ForbiddenLoad(LPCSTR){ std::cerr << "FAIL: vendor path must not pre-load a DLL\n"; std::abort(); }

namespace {
// ---------------------------------------------------------------------------
void TestCachedTableAndPristineOpen(){
	std::cout << "cached table + pristine open\n";
	Configure(true, 100, -4, 4, true);
	mock::epoch = 0; mock::vrlinkCaller = true;
	createVersions.clear(); createPointers.clear();
	NV_ENCODE_API_FUNCTION_LIST list;
	InstallTable(list);
	Check(list.version == Tag111(2), "cached: caller list version untouched");
	Check(createPointers.size() == 1 && createPointers[0] == &list && createVersions[0] == Tag111(2), "cached: exactly one real call, caller list and version unchanged (no speculative 12.1 call before admission)");
	Check(list.nvEncInitializeEncoder == NvencTapShims::InitializeEncoder && list.nvEncEncodePicture == NvencTapShims::EncodePicture
		&& list.nvEncOpenEncodeSessionEx == NvencTapShims::OpenEncodeSessionEx && list.nvEncDestroyEncoder == NvencTapShims::DestroyEncoder, "cached: supported table wrapped before admission");
	gTable = list;

	// pristine OPEN: exact original, no adoption
	ResetSeen();
	const auto stats0 = NvencTap::Get().GetStats();
	void* pristine = OpenVia(gTable);
	Check(seenOpenApi == kApi111 && seenOpenVersion == Tag111(1), "pristine open: api/version reach NVENC unchanged");
	Check(!Upgraded(pristine) && AuthorityOf(pristine) == Auth::Pristine, "pristine open: handle recorded Pristine, never upgraded");
	Check(createVersions.size() == 1, "pristine open: no create-instance call at all");

	initStatus = NV_ENC_ERR_INVALID_PARAM;
	NV_ENC_CONFIG cfg = MakeConfig(); NV_ENC_INITIALIZE_PARAMS init = MakeInit(&cfg);
	const auto cfgBytes = Bytes(cfg), initBytes = Bytes(init);
	Check(gTable.nvEncInitializeEncoder(pristine, &init) == NV_ENC_ERR_INVALID_PARAM, "pristine init: driver status returned");
	Check(sInit.ptr == &init && sInit.bytes == initBytes && Bytes(cfg) == cfgBytes && seenBitrate == 42000000 && seenMaxBitrate == 42000000 && seenLevel == NV_ENC_LEVEL_HEVC_61,
		"pristine init: no override, driver saw the caller bytes");
	initStatus = NV_ENC_SUCCESS;
	Check(NvencTap::Get().GetRuntimeState().lastInitStatus == 0 && NvencTap::Get().GetRuntimeState().initError.empty(), "pristine init: no public failure");

	NV_ENC_CAPS_PARAM caps = {}; caps.version = Tag111(1); caps.capsToQuery = NV_ENC_CAPS_WIDTH_MAX; int width = 0;
	const auto capsBytes = Bytes(caps);
	Check(gTable.nvEncGetEncodeCaps(pristine, NV_ENC_CODEC_HEVC_GUID, &caps, &width) == NV_ENC_SUCCESS && width == capsWidth && sCaps.bytes == capsBytes && sCaps.version == Tag111(1),
		"pristine caps: driver value and caller ABI, no allocation override");

	NV_ENC_RECONFIGURE_PARAMS reconf = {}; reconf.version = Tag111(1, true); reconf.reInitEncodeParams = MakeInit(&cfg);
	const auto reconfBytes = Bytes(reconf);
	Check(gTable.nvEncReconfigureEncoder(pristine, &reconf) == NV_ENC_SUCCESS && sReconf.bytes == reconfBytes && seenBitrate == 42000000, "pristine reconfigure untouched");

	NV_ENC_REGISTER_RESOURCE reg = {}; reg.version = Tag111(4); reg.resourceType = NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX; reg.resourceToRegister = reinterpret_cast<void*>(0x55);
	const auto regBytes = Bytes(reg);
	Check(gTable.nvEncRegisterResource(pristine, &reg) == NV_ENC_SUCCESS && sReg.bytes == regBytes && registered.empty(), "pristine register: untouched, no bookkeeping");
	NV_ENC_MAP_INPUT_RESOURCE map = {}; map.version = Tag111(4); map.registeredResource = reg.registeredResource;
	NvencPostPack::processCalls = 0;
	Check(gTable.nvEncMapInputResource(pristine, &map) == NV_ENC_SUCCESS && sMap.ptr == &map && NvencPostPack::processCalls == 0 && mappedToReg.empty(), "pristine map: untouched, no post-pack");
	Check(gTable.nvEncUnmapInputResource(pristine, map.mappedResource) == NV_ENC_SUCCESS && gTable.nvEncUnregisterResource(pristine, reg.registeredResource) == NV_ENC_SUCCESS && sUnmap.calls == 1 && sUnreg.calls == 1, "pristine unmap/unregister forwarded");

	NV_ENC_PIC_PARAMS pic = {}; pic.version = Tag111(4, true); pic.inputBuffer = reinterpret_cast<void*>(9); pic.outputBitstream = reinterpret_cast<void*>(10);
	pic.inputWidth = 1536; pic.inputHeight = 6144;
	const auto picBytes = Bytes(pic);
	seenQpMap = reinterpret_cast<const int8_t*>(1);
	Check(gTable.nvEncEncodePicture(pristine, &pic) == NV_ENC_SUCCESS && sEncode.ptr == &pic && sEncode.bytes == picBytes && seenQpMap == nullptr, "pristine encode: same pointer, bytes, no QP map");
	NV_ENC_LOCK_BITSTREAM lock = {}; lock.version = Tag111(1, true);
	const auto lockBytes = Bytes(lock);
	Check(gTable.nvEncLockBitstream(pristine, &lock) == NV_ENC_SUCCESS && sLock.ptr == &lock && sLock.bytes == lockBytes, "pristine lock: same pointer and ABI");
	const auto stats1 = NvencTap::Get().GetStats();
	Check(std::memcmp(&stats0, &stats1, sizeof(stats0)) == 0, "pristine session: every NvencTapStats counter unchanged");
	Check(NvencTap::Get().GetRuntimeState().encodeWidth == 0 && NvencTap::Get().GetRuntimeState().lastStatus == 0, "pristine session: no runtime state published");
	Check(gTable.nvEncDestroyEncoder(pristine) == NV_ENC_SUCCESS && AuthorityOf(pristine) == Auth::Pristine, "pristine destroy forwarded");
}

void TestAdmittedPositive(){
	std::cout << "admitted session (cached table)\n";
	Configure(true, 100, -4, 4, true);
	mock::epoch = 5; mock::vrlinkCaller = true;
	ResetSeen();
	const size_t createsBefore = createVersions.size();
	void* live = OpenVia(gTable);
	Check(createVersions.size() == createsBefore + 1 && createVersions.back() == Tag121(2, false), "admitted open: private local 12.1 list registered here, once, before the upgrade");
	Check(seenOpenApi == kApi121 && seenOpenVersion == Tag121(1, false), "admitted open: cached table's open upgrades the session to 12.1");
	Check(Upgraded(live) && AuthorityOf(live) == Auth::Live, "admitted open: Live and ABI-recorded");

	NV_ENC_CAPS_PARAM caps = {}; caps.version = Tag111(1); caps.capsToQuery = NV_ENC_CAPS_WIDTH_MAX; int width = 0;
	Check(gTable.nvEncGetEncodeCaps(live, NV_ENC_CODEC_HEVC_GUID, &caps, &width) == NV_ENC_SUCCESS && width == 1536 && sCaps.version == Tag121(1, false) && caps.version == Tag111(1),
		"admitted caps: explicit allocation override and 12.1 ABI");

	const auto statsBefore = NvencTap::Get().GetStats();
	NV_ENC_CONFIG cfg = MakeConfig(); NV_ENC_INITIALIZE_PARAMS init = MakeInit(&cfg);
	const auto cfgBytes = Bytes(cfg), initBytes = Bytes(init);
	const NVENCSTATUS initResult = gTable.nvEncInitializeEncoder(live, &init);
	Check(initResult == NV_ENC_SUCCESS, "admitted init: succeeds");
	if(initResult != NV_ENC_SUCCESS){ std::cerr << "  init status " << initResult << ": " << NvencTap::Get().GetRuntimeState().initError << '\n'; }
	Check(seenBitrate == 100000000u && seenMaxBitrate == 100000000u && sInit.version == Tag121(6, true) && seenConfigVersion == Tag121(8, true),
		"admitted init: existing settings applied with 12.1 ABI");
	Check(Bytes(init) == initBytes && Bytes(cfg) == cfgBytes, "admitted init: caller bytes restored");
	Check(NvencTap::Get().GetStats().initCalls == statsBefore.initCalls + 1, "admitted init: counted");

	NV_ENC_REGISTER_RESOURCE reg = {}; reg.version = Tag111(4); reg.resourceType = NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX; reg.resourceToRegister = reinterpret_cast<void*>(0x55);
	reg.bufferFormat = NV_ENC_BUFFER_FORMAT_NV12;
	Check(gTable.nvEncRegisterResource(live, &reg) == NV_ENC_SUCCESS && registered.count(reg.registeredResource) == 1, "admitted register: bookkeeping owned by this session");

	NV_ENC_PIC_PARAMS pic = {}; pic.version = Tag111(4, true); pic.inputBuffer = reinterpret_cast<void*>(9); pic.outputBitstream = reinterpret_cast<void*>(10);
	pic.inputWidth = 1536; pic.inputHeight = 6144;
	Check(gTable.nvEncEncodePicture(live, &pic) == NV_ENC_SUCCESS && seenPicVersion == Tag121(6, true) && seenQpMap != nullptr, "admitted encode: 12.1 scratch picture with the foveated QP map");
	Check(gTable.nvEncDestroyEncoder(live) == NV_ENC_SUCCESS && registered.empty() && AuthorityOf(live) == Auth::Pristine && !Upgraded(live), "admitted destroy: resources and authority removed");
	NvencTap::Get().SetConfig(NvencTapConfig{});
}

void TestSimultaneousAndForeign(){
	std::cout << "simultaneous unknown session / foreign caller\n";
	Configure(true, 100, 0, 0, true);
	mock::epoch = 0; mock::vrlinkCaller = true; ResetSeen();
	const size_t createsBefore = createVersions.size();
	void* unknown = OpenVia(gTable); // opened before admission: stays pristine
	Check(createVersions.size() == createsBefore, "unadmitted open: no speculative create-instance call");
	mock::epoch = 7;
	void* admitted = OpenVia(gTable);
	mock::vrlinkCaller = false;
	void* foreign = OpenVia(gTable); // admitted epoch but not the Galaxy vrlink caller
	Check(createVersions.size() == createsBefore + 1, "foreign caller / unadmitted: only the admitted open registered 12.1");
	Check(seenOpenApi == kApi111 && seenOpenVersion == Tag111(1), "foreign caller: open untouched");
	mock::vrlinkCaller = true;
	Check(AuthorityOf(unknown) == Auth::Pristine && AuthorityOf(admitted) == Auth::Live && AuthorityOf(foreign) == Auth::Pristine, "same GPU: only the admitted session is Live");
	NV_ENC_CAPS_PARAM caps = {}; caps.version = Tag111(1); caps.capsToQuery = NV_ENC_CAPS_WIDTH_MAX; int w1 = 0, w2 = 0;
	gTable.nvEncGetEncodeCaps(unknown, NV_ENC_CODEC_HEVC_GUID, &caps, &w1);
	gTable.nvEncGetEncodeCaps(admitted, NV_ENC_CODEC_HEVC_GUID, &caps, &w2);
	Check(w1 == capsWidth && w2 == 1536, "same GPU: unknown session pristine, admitted session overridden");
	mock::epoch = 0; // admitted session now stale; unknown stays pristine
	Check(AuthorityOf(admitted) == Auth::Stale && AuthorityOf(unknown) == Auth::Pristine, "epoch close: admitted -> Stale, unknown stays Pristine");
	for(void* e : { unknown, admitted, foreign }){ gTable.nvEncDestroyEncoder(e); }
	NvencTap::Get().SetConfig(NvencTapConfig{});
}

void TestCloseDuringEncodeAndAbiCleanup(){
	std::cout << "close during encode / ABI cleanup\n";
	Configure(true, 100, -4, 4, true);
	mock::epoch = 9; mock::vrlinkCaller = true; ResetSeen();
	void* e = OpenVia(gTable);
	NV_ENC_REGISTER_RESOURCE reg = {}; reg.version = Tag111(4); reg.resourceType = NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX; reg.resourceToRegister = reinterpret_cast<void*>(0x55); reg.bufferFormat = NV_ENC_BUFFER_FORMAT_NV12;
	gTable.nvEncRegisterResource(e, &reg);
	NV_ENC_PIC_PARAMS pic = {}; pic.version = Tag111(4, true); pic.inputBuffer = reinterpret_cast<void*>(9); pic.outputBitstream = reinterpret_cast<void*>(10); pic.inputWidth = 1536; pic.inputHeight = 6144;
	const uint32_t mapFramesBefore = NvencTap::Get().GetStats().qpMapFrames;
	gTable.nvEncEncodePicture(e, &pic);
	Check(seenQpMap != nullptr && NvencTap::Get().GetStats().qpMapFrames == mapFramesBefore + 1, "live encode used the QP map");

	mock::epoch = 0; // link closes while the session is still encoding
	const auto stats0 = NvencTap::Get().GetStats();
	const auto runtime0 = NvencTap::Get().GetRuntimeState();
	const size_t registered0 = registered.size();
	NvencPostPack::processCalls = 0; seenQpMap = reinterpret_cast<const int8_t*>(1);
	const auto picBefore = Bytes(pic);
	Check(gTable.nvEncEncodePicture(e, &pic) == NV_ENC_SUCCESS, "stale encode drains");
	Check(seenPicVersion == Tag121(6, true), "stale encode: 12.1 ABI retained");
	Check(seenQpMap == nullptr, "stale encode: no new QP map");
	Check(Bytes(pic) == picBefore, "stale encode: caller picture untouched");
	NV_ENC_MAP_INPUT_RESOURCE map = {}; map.version = Tag111(4); map.registeredResource = reg.registeredResource;
	Check(gTable.nvEncMapInputResource(e, &map) == NV_ENC_SUCCESS && NvencPostPack::processCalls == 0 && mappedToReg.count(map.mappedResource) == 1, "stale map: bookkeeping kept, no post-pack");
	NV_ENC_LOCK_BITSTREAM lock = {}; lock.version = Tag111(1, true);
	Check(gTable.nvEncLockBitstream(e, &lock) == NV_ENC_SUCCESS && seenLockVersion == Tag121(1, true) && lock.version == Tag111(1, true) && lock.bitstreamSizeInBytes == 1000, "stale lock: ABI scratch copy, output returned");
	NV_ENC_CONFIG cfg = MakeConfig(); NV_ENC_INITIALIZE_PARAMS init = MakeInit(&cfg);
	Check(gTable.nvEncInitializeEncoder(e, &init) == NV_ENC_SUCCESS && seenBitrate == 42000000 && sInit.version == Tag121(6, true) && init.version == Tag111(5, true), "stale init: ABI retag only, caller bitrate kept");
	NV_ENC_RECONFIGURE_PARAMS reconf = {}; reconf.version = Tag111(1, true); reconf.reInitEncodeParams = MakeInit(&cfg);
	Check(gTable.nvEncReconfigureEncoder(e, &reconf) == NV_ENC_SUCCESS && seenBitrate == 42000000, "stale reconfigure: no policy");
	NV_ENC_CAPS_PARAM caps = {}; caps.version = Tag111(1); caps.capsToQuery = NV_ENC_CAPS_WIDTH_MAX; int w = 0;
	Check(gTable.nvEncGetEncodeCaps(e, NV_ENC_CODEC_HEVC_GUID, &caps, &w) == NV_ENC_SUCCESS && w == capsWidth && sCaps.version == Tag121(1, false), "stale caps: driver value, ABI retag");
	const auto stats1 = NvencTap::Get().GetStats();
	Check(std::memcmp(&stats0, &stats1, sizeof(stats0)) == 0, "stale: no stats change (incl. retag counter)");
	const auto runtime1 = NvencTap::Get().GetRuntimeState();
	Check(runtime0.encodeWidth == runtime1.encodeWidth && runtime0.lastStatus == runtime1.lastStatus && runtime1.error.empty(), "stale: no published runtime state or failure");
	Check(registered.size() == registered0, "close does not erase live resource maps");
	NvencTap::Get().FlushDeferredDiagnostics(); NvencTap::Get().FlushDeferredDiagnostics();
	Check(LogCount("closed link epoch") == 1, "stale policy-bearing calls: one deferred diagnostic, no synthetic error");
	Check(gTable.nvEncUnmapInputResource(e, map.mappedResource) == NV_ENC_SUCCESS && mappedToReg.empty(), "stale unmap keeps bookkeeping consistent");
	Check(gTable.nvEncDestroyEncoder(e) == NV_ENC_SUCCESS && registered.empty() && !Upgraded(e) && AuthorityOf(e) == Auth::Pristine, "destroy cleans resources, ABI record and authority");
	NvencTap::Get().SetConfig(NvencTapConfig{});
}

void TestReconnectRecycledAndOrphan(){
	std::cout << "reconnect / recycled handle / orphan\n";
	Configure(true, 100, 0, 0, true);
	forcedHandle = 0x4440;
	mock::epoch = 11; mock::vrlinkCaller = true;
	void* a = OpenVia(gTable);
	Check(AuthorityOf(a) == Auth::Live, "recycle: first session Live in epoch 11");
	NV_ENC_REGISTER_RESOURCE reg = {}; reg.version = Tag111(4); reg.resourceType = NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX; reg.resourceToRegister = reinterpret_cast<void*>(0x66);
	gTable.nvEncRegisterResource(a, &reg);
	mock::epoch = 12; // reconnect without destroy: same handle comes back from NVENC (orphan)
	Check(AuthorityOf(a) == Auth::Stale, "reconnect: previous epoch's session is Stale");
	void* b = OpenVia(gTable);
	Check(b == a && AuthorityOf(b) == Auth::Live, "recycled handle (orphan): decided fresh by its own OPEN");
	Check(registered.empty(), "orphan reuse: dead session resources dropped");
	NvencTap::Get().FlushDeferredDiagnostics(); NvencTap::Get().FlushDeferredDiagnostics();
	Check(LogCount("orphaned") == 1, "orphan reuse: logged once, deferred");
	gTable.nvEncDestroyEncoder(b);
	mock::epoch = 0;
	void* c = OpenVia(gTable);
	Check(c == a && AuthorityOf(c) == Auth::Pristine && !Upgraded(c), "recycled handle after close: Pristine, never adopted");
	mock::epoch = 13;
	Check(AuthorityOf(c) == Auth::Pristine, "later admission does not adopt an earlier pristine handle");
	gTable.nvEncDestroyEncoder(c);
	forcedHandle = 0;
	mock::epoch = 0;
	NvencTap::Get().SetConfig(NvencTapConfig{});
}

void TestToggleOff(){
	std::cout << "toggle off\n";
	Configure(false);
	mock::epoch = 21; mock::vrlinkCaller = true;
	createVersions.clear();
	NV_ENCODE_API_FUNCTION_LIST list; InstallTable(list);
	Check(createVersions.size() == 1 && list.nvEncInitializeEncoder == NvencTapShims::InitializeEncoder && list.nvEncEncodePicture == NvencTapShims::EncodePicture,
		"OFF: known vrlink table still wrapped with pristine forwarders, single real call");
	mock::epoch = 0;
	void* early = OpenVia(list); // pristine, opened before any admission
	mock::epoch = 21;
	void* offSession = OpenVia(list);
	Check(seenOpenApi == kApi111 && !Upgraded(offSession) && createVersions.size() == 1, "OFF: admitted open stays stock 11.1 with no 12.1 registration");
	Configure(true, 0, 0, 0, false);
	void* e = OpenVia(list);
	Check(seenOpenApi == kApi121 && Upgraded(e) && createVersions.size() == 2 && createVersions.back() == Tag121(2, false),
		"OFF->ON: table cached while OFF serves a new admitted OPEN (12.1 registration happens only now)");
	Check(AuthorityOf(early) == Auth::Pristine && !Upgraded(early), "OFF->ON: earlier pristine handle is not adopted");
	gTable = list;
	Configure(false);
	NV_ENC_CONFIG cfg = MakeConfig(); NV_ENC_INITIALIZE_PARAMS init = MakeInit(&cfg);
	const auto stats0 = NvencTap::Get().GetStats();
	Check(gTable.nvEncInitializeEncoder(e, &init) == NV_ENC_SUCCESS && seenBitrate == 42000000 && sInit.version == Tag121(6, true), "OFF: admitted upgraded session keeps ABI only");
	const auto stats1 = NvencTap::Get().GetStats();
	Check(std::memcmp(&stats0, &stats1, sizeof(stats0)) == 0, "OFF: no stats");
	gTable.nvEncDestroyEncoder(e); gTable.nvEncDestroyEncoder(offSession); gTable.nvEncDestroyEncoder(early);
	mock::epoch = 0;
	NvencTap::Get().SetConfig(NvencTapConfig{});
}

// An upgraded, owned handle that NVENC hands back (orphan) for a pristine OPEN
// must lose its ABI upgrade and every per-session cache, so even the simple
// wrappers pass the caller's bytes through untouched.
void TestRecycledUpgradedAsPristine(){
	std::cout << "recycled upgraded handle reused as pristine\n";
	Configure(true, 100, 0, 0, true);
	forcedHandle = 0x5550;
	mock::epoch = 31; mock::vrlinkCaller = true;
	void* first = OpenVia(gTable);
	Check(Upgraded(first) && AuthorityOf(first) == Auth::Live && sessionApiVersion.count(first) == 1 && capCache.count(first) == 1, "recycle: first session upgraded with caches");
	NV_ENC_PIC_PARAMS none = {};
	(void)none;
	mock::epoch = 0;
	ResetSeen();
	void* second = OpenVia(gTable); // no destroy: same handle, no admitted link
	Check(second == first && AuthorityOf(second) == Auth::Pristine, "recycle: pristine OPEN replaces the owned record");
	Check(!Upgraded(second) && sessionApiVersion.count(second) == 0 && capCache.count(second) == 0 && presetCache.count(second) == 0 && sessionCodecs.count(second) == 0,
		"recycle: ABI upgrade and every per-session cache dropped");
	NV_ENC_CREATE_INPUT_BUFFER inBuf = {}; inBuf.version = Tag111(1); inBuf.width = 1536;
	NV_ENC_EVENT_PARAMS event = {}; event.version = Tag111(1);
	NV_ENC_SEQUENCE_PARAM_PAYLOAD seq = {}; seq.version = Tag111(1);
	const auto inBytes = Bytes(inBuf), evBytes = Bytes(event), seqBytes = Bytes(seq);
	Check(gTable.nvEncCreateInputBuffer(second, &inBuf) == NV_ENC_SUCCESS && sInBuf.ptr == &inBuf && sInBuf.bytes == inBytes && sInBuf.version == Tag111(1), "recycle: CreateInputBuffer bytes/ABI untouched");
	Check(gTable.nvEncRegisterAsyncEvent(second, &event) == NV_ENC_SUCCESS && sEvent.bytes == evBytes && sEvent.version == Tag111(1), "recycle: RegisterAsyncEvent bytes/ABI untouched");
	Check(gTable.nvEncGetSequenceParams(second, &seq) == NV_ENC_SUCCESS && sSeq.bytes == seqBytes && sSeq.version == Tag111(1), "recycle: GetSequenceParams bytes/ABI untouched");
	NV_ENC_CONFIG cfg = MakeConfig(); NV_ENC_INITIALIZE_PARAMS init = MakeInit(&cfg);
	const auto initBytes = Bytes(init);
	Check(gTable.nvEncInitializeEncoder(second, &init) == NV_ENC_SUCCESS && sInit.bytes == initBytes && seenBitrate == 42000000, "recycle: init pristine");
	// the same simple wrappers still retag a genuinely upgraded session
	mock::epoch = 32;
	gTable.nvEncDestroyEncoder(second);
	void* third = OpenVia(gTable);
	Check(third == first && Upgraded(third), "recycle: a fresh admitted OPEN upgrades again");
	Check(gTable.nvEncCreateInputBuffer(third, &inBuf) == NV_ENC_SUCCESS && sInBuf.version == Tag121(1, false) && Bytes(inBuf) == inBytes, "recycle: upgraded session retags and restores");
	gTable.nvEncDestroyEncoder(third);
	forcedHandle = 0; mock::epoch = 0;
	NvencTap::Get().SetConfig(NvencTapConfig{});
}

// Concurrent GetProcAddress binds and shim calls: a thunk returned to vrlink must
// never reach the shim before the real function is visible.
void TestConcurrentBind(){
	std::cout << "concurrent bind / create instance\n";
	mock::epoch = 0; mock::vrlinkCaller = true; gOwnerFor = gNvencModule;
	std::atomic<int> bad{0}, bound{0};
	for(int round = 0; round < 300; round++){
		realCreateInstance.store(nullptr);
		std::vector<std::future<void>> workers;
		for(int t = 0; t < 4; t++){
			workers.push_back(std::async(std::launch::async, [&]{
				FARPROC b = BindCreateInstance(gNvencModule, reinterpret_cast<FARPROC>(&FakeCreate));
				if(b == reinterpret_cast<FARPROC>(&NvencTapShims::CreateInstance)){
					bound++;
					NV_ENCODE_API_FUNCTION_LIST list = {}; list.version = Tag111(2);
					if(NvencTapShims::CreateInstance(&list) != NV_ENC_SUCCESS){ bad++; }
				}else{ bad++; }
			}));
		}
		for(auto& w : workers){ w.get(); }
	}
	Check(bad == 0 && bound == 1200, "concurrent bind: every thunk handed out forwards to the real function");
}

// Post-pack cache lifetime: release is targeted, success-only, and never driven
// by an epoch change.
void TestPostPackCacheCleanup(){
	std::cout << "post-pack cache cleanup\n";
	Configure(true, 100, 0, 0, false);
	mock::vrlinkCaller = true; forcedHandle = 0;
	auto reg = [&](void* enc, uintptr_t tex){
		NV_ENC_REGISTER_RESOURCE r = {}; r.version = Tag111(4); r.resourceType = NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX;
		r.resourceToRegister = reinterpret_cast<void*>(tex); r.bufferFormat = NV_ENC_BUFFER_FORMAT_NV12;
		Check(gTable.nvEncRegisterResource(enc, &r) == NV_ENC_SUCCESS, "cleanup: register");
		return r.registeredResource;
	};
	// pristine session: no bookkeeping, no cleanup of anything
	mock::epoch = 0;
	void* pristine = OpenVia(gTable);
	NvencPostPack::releaseCalls = 0; NvencPostPack::releasedTextures.clear();
	auto pr = reg(pristine, 0xB1);
	Check(gTable.nvEncUnregisterResource(pristine, pr) == NV_ENC_SUCCESS && gTable.nvEncDestroyEncoder(pristine) == NV_ENC_SUCCESS && NvencPostPack::releaseCalls == 0, "pristine unregister/destroy: no post-pack cleanup");

	mock::epoch = 51;
	void* a = OpenVia(gTable);
	auto r1 = reg(a, 0xA1); auto alias = reg(a, 0xA1); auto r2 = reg(a, 0xA2);
	unregStatus = NV_ENC_ERR_GENERIC;
	Check(gTable.nvEncUnregisterResource(a, r2) == NV_ENC_ERR_GENERIC && registered.count(r2) == 1 && NvencPostPack::releaseCalls == 0, "failed unregister retains the record and the cache entry");
	unregStatus = NV_ENC_SUCCESS;
	Check(gTable.nvEncUnregisterResource(a, r1) == NV_ENC_SUCCESS && NvencPostPack::releaseCalls == 0, "unregister of one alias keeps the cache while another registration uses the texture");
	Check(gTable.nvEncUnregisterResource(a, alias) == NV_ENC_SUCCESS && NvencPostPack::releasedTextures == std::vector<void*>{ reinterpret_cast<void*>(0xA1) }, "last registration unregistered: exactly that texture released");
	mock::epoch = 0; // closing the link releases nothing by itself
	Check(NvencPostPack::releaseCalls == 1 && registered.count(r2) == 1, "epoch close: live maps and caches untouched");
	Check(gTable.nvEncUnregisterResource(a, r2) == NV_ENC_SUCCESS && NvencPostPack::releasedTextures.size() == 2 && NvencPostPack::releasedTextures[1] == reinterpret_cast<void*>(0xA2), "stale unregister drains and releases its texture");
	reg(a, 0xA4); reg(a, 0xA5);
	destroyStatus = NV_ENC_ERR_GENERIC; const int callsBeforeDestroy = NvencPostPack::releaseCalls;
	Check(gTable.nvEncDestroyEncoder(a) == NV_ENC_ERR_GENERIC && NvencPostPack::releaseCalls == callsBeforeDestroy && registered.size() == 2, "failed destroy retains resources and caches");
	destroyStatus = NV_ENC_SUCCESS;
	Check(gTable.nvEncDestroyEncoder(a) == NV_ENC_SUCCESS && registered.empty() && NvencPostPack::releaseCalls == callsBeforeDestroy + 1 && NvencPostPack::releasedTextures.size() == 4, "stale destroy releases every remaining texture of that session");

	// orphan recycle: the dead session's textures are released when the handle comes back
	forcedHandle = 0x6660; mock::epoch = 52;
	void* b = OpenVia(gTable);
	reg(b, 0xC1);
	mock::epoch = 53; const int callsBeforeOrphan = NvencPostPack::releaseCalls;
	void* b2 = OpenVia(gTable);
	Check(b2 == b && NvencPostPack::releaseCalls == callsBeforeOrphan + 1 && NvencPostPack::releasedTextures.back() == reinterpret_cast<void*>(0xC1), "orphan handle recycle releases the dead session's textures");
	gTable.nvEncDestroyEncoder(b2);
	forcedHandle = 0; mock::epoch = 0;
	NvencTap::Get().SetConfig(NvencTapConfig{});
}

void TestListConsistency(){
	std::cout << "list capture-once / foreign / unsupported\n";
	Configure(true, 0, 0, 0, false);
	mock::epoch = 0; mock::vrlinkCaller = true;
	NV_ENCODE_API_FUNCTION_LIST same; InstallTable(same);
	Check(same.nvEncEncodePicture == NvencTapShims::EncodePicture, "list: repeated identical table wrapped again");
	altInit = true;
	NV_ENCODE_API_FUNCTION_LIST mismatch; InstallTable(mismatch);
	altInit = false;
	Check(mismatch.nvEncInitializeEncoder == &FakeInitAlt && mismatch.nvEncEncodePicture == &FakeEncode && mismatch.nvEncOpenEncodeSessionEx == &FakeOpen, "list: inconsistent table left wholly pristine");
	Check(origInitializeEncoder == &FakeInit, "list: originals not recaptured from the inconsistent table");
	// foreign caller
	mock::vrlinkCaller = false;
	NV_ENCODE_API_FUNCTION_LIST foreign; InstallTable(foreign);
	Check(foreign.nvEncEncodePicture == &FakeEncode, "foreign caller: table untouched");
	mock::vrlinkCaller = true;
	// unsupported API major
	NV_ENCODE_API_FUNCTION_LIST unsupported{}; unsupported.version = 99u | (7u << 28);
	Check(NvencTapShims::CreateInstance(&unsupported) == NV_ENC_SUCCESS && unsupported.nvEncEncodePicture == &FakeEncode && unsupported.version == (99u | (7u << 28)), "unsupported list: pristine, caller word untouched, status as returned");
	// real rejection is returned without side effects
	createStatus = NV_ENC_ERR_INVALID_VERSION;
	NV_ENCODE_API_FUNCTION_LIST rejected{}; rejected.version = Tag111(2);
	Check(NvencTapShims::CreateInstance(&rejected) == NV_ENC_ERR_INVALID_VERSION && rejected.nvEncEncodePicture == nullptr, "real CreateInstance failure returned as is");
	createStatus = NV_ENC_SUCCESS;
	Check(NvencTap::Get().GetRuntimeState().lastStatus == 0 && NvencTap::Get().GetRuntimeState().error.empty(), "list problems never publish a failure");
	NvencTap::Get().FlushDeferredDiagnostics();
	Check(LogCount("disagreed") == 1 && LogCount("unsupported API major") == 1 && LogCount("not the Galaxy vrlink") == 1, "list problems logged once, deferred");
	NvencTap::Get().SetConfig(NvencTapConfig{});
}

void TestImportInstall(){
	std::cout << "module-local import install\n";
	Configure(false); // observer and local imports install independently of the NVENC tap toggle
	logs.clear();
	Image bad(false), img(true);
	// 1) unsupported imports (no CRT vsnprintf_s): fail closed, nothing patched
	{
		gVrlink = &bad;
		void* gpaBefore = bad.GpaSlot()[0];
		NvencTap::Get().TryInstall();
		Check(!NvencTap::Get().Installed() && bad.GpaSlot()[0] == gpaBefore, "unsupported imports: nothing installed, slot untouched");
		Check(LogCount("failing closed") == 1, "unsupported imports: failure logged once");
		NvencTap::Get().TryInstall();
		Check(LogCount("failing closed") == 1, "unsupported imports: same image is not retried");
		gVrlink = nullptr;
	}
	// 2) module not loaded yet: quiet retry
	NvencTap::Get().TryInstall();
	Check(!NvencTap::Get().Installed(), "module absent: nothing installed");
	// 3) supported image, loaded right after the early miss: the very next call installs (no throttle)
	gVrlink = &img;
	realCreateInstance.store(nullptr); mock::observeCalls = 0;
	NvencTap::Get().TryInstall();
	Check(NvencTap::Get().Installed(), "supported image: installed immediately after an earlier miss, with the tap OFF");
	Check(gPins >= 1, "own module pinned before callbacks are exported");
	Check(img.GpaSlot()[0] != reinterpret_cast<void*>(&Image::RealGpa) && img.CrtSlot()[0] != reinterpret_cast<void*>(&Image::RealVsnprintf), "supported image: both slots patched");
	Check(img.GpaSlot()[1] == reinterpret_cast<void*>(&Image::Other), "unrelated import untouched");
	auto gpa = reinterpret_cast<FARPROC (*)(HMODULE, LPCSTR)>(img.GpaSlot()[0]);
	auto crt = reinterpret_cast<int (*)(unsigned long long, char*, size_t, size_t, const char*, void*, char*)>(img.CrtSlot()[0]);
	FARPROC realExport = reinterpret_cast<FARPROC>(&FakeCreate);

	// GetProcAddress interception
	Image::gpaResult = reinterpret_cast<FARPROC>(0x1234);
	Check(gpa(gNvencModule, "SomethingElse") == reinterpret_cast<FARPROC>(0x1234) && Image::lastGpaName && std::strcmp(Image::lastGpaName, "SomethingElse") == 0, "GPA: unrelated name returns the real result");
	Check(gpa(gNvencModule, reinterpret_cast<LPCSTR>(static_cast<uintptr_t>(42))) == reinterpret_cast<FARPROC>(0x1234), "GPA: ordinal lookup passes through");
	Image::gpaResult = nullptr;
	Check(gpa(gNvencModule, "NvEncodeAPICreateInstance") == nullptr, "GPA: failed lookup stays null");
	Image::gpaResult = realExport; gOwnerFor = gOtherModule;
	Check(gpa(gOtherModule, "NvEncodeAPICreateInstance") == realExport && realCreateInstance.load() == nullptr, "GPA: export from a module that is not nvEncodeAPI64.dll is unbound");
	gOwnerFor = gNvencModule; // address belongs to a different module than the one queried
	Check(gpa(gOtherModule, "NvEncodeAPICreateInstance") == realExport && realCreateInstance.load() == nullptr, "GPA: export owner differs from queried module -> unbound");
	FARPROC bound = gpa(gNvencModule, "NvEncodeAPICreateInstance");
	Check(bound == reinterpret_cast<FARPROC>(&NvencTapShims::CreateInstance) && realCreateInstance.load() == reinterpret_cast<void*>(&FakeCreate), "GPA: exact nvEncodeAPI64 export bound to the shim, real function stored");
	Check(gpa(gNvencModule, "NvEncodeAPICreateInstance") == bound, "GPA: repeated lookup returns the same binding");
	Image::gpaResult = reinterpret_cast<FARPROC>(&Stub<1>);
	Check(gpa(gNvencModule, "NvEncodeAPICreateInstance") == Image::gpaResult && realCreateInstance.load() == reinterpret_cast<void*>(&FakeCreate), "GPA: a second distinct export is left unbound, original kept");
	NvencTap::Get().FlushDeferredDiagnostics();
	Check(LogCount("exact nvEncodeAPI64.dll") == 1, "GPA: mismatch reported once from the deferred path");

	// CRT observer: original first, unchanged
	static char buffer[8192];
	const char* format = "ReceivedHMDStaticProps. Model Number: %s, Serial Number: %s (%d)\n";
	Image::realFormatCalls = 0;
	const int written = crt(0x2, buffer, sizeof(buffer), sizeof(buffer), format, nullptr, reinterpret_cast<char*>(0x77));
	Check(written == static_cast<int>(std::strlen(format)) && Image::realFormatCalls == 1 && std::strcmp(buffer, format) == 0, "CRT: original called once, result and buffer unchanged");
	Check(mock::observeCalls == 1 && std::strcmp(mock::lastFormat, format) == 0 && mock::lastLength == std::strlen(format) && std::strcmp(mock::lastText, format) == 0, "CRT: observer receives exact format, formatted text and bounded length");
	char tiny[4] = {}; mock::observeCalls = 0;
	crt(0x2, tiny, sizeof(tiny), sizeof(tiny), "toolong", nullptr, nullptr);
	Check(mock::observeCalls == 0, "CRT: truncated output is not observed");
	crt(0x2, nullptr, 0, 0, format, nullptr, nullptr);
	Check(mock::observeCalls == 0, "CRT: null buffer (size query) is not observed");

	// Cleanup: passthrough, restore, lifetimes retained
	void* gpaThunk = img.GpaSlot()[0];
	NvencTap::Get().Cleanup();
	Check(!NvencTap::Get().Installed() && img.GpaSlot()[0] == reinterpret_cast<void*>(&Image::RealGpa) && img.CrtSlot()[0] == reinterpret_cast<void*>(&Image::RealVsnprintf), "cleanup: slots restored to their previous functions");
	mock::observeCalls = 0; Image::gpaResult = realExport;
	auto oldGpa = reinterpret_cast<FARPROC (*)(HMODULE, LPCSTR)>(gpaThunk);
	Check(oldGpa(gNvencModule, "NvEncodeAPICreateInstance") == realExport, "cleanup: an already-captured thunk is a pure passthrough");
	crt(0x2, buffer, sizeof(buffer), sizeof(buffer), format, nullptr, nullptr);
	Check(mock::observeCalls == 0, "cleanup: CRT observer inert");
	// 4) reinstall after cleanup
	NvencTap::Get().TryInstall();
	Check(NvencTap::Get().Installed() && img.GpaSlot()[0] != reinterpret_cast<void*>(&Image::RealGpa), "reinstall after cleanup");
	NvencTap::Get().Cleanup();
	gVrlink = nullptr;
}

} // namespace

int main(){
	_putenv_s("APPDATA", "Z:\\no-such-appdata-for-nvenc-isolation-test");

	TestCachedTableAndPristineOpen();
	TestAdmittedPositive();
	TestSimultaneousAndForeign();
	TestCloseDuringEncodeAndAbiCleanup();
	TestReconnectRecycledAndOrphan();
	TestToggleOff();
	TestRecycledUpgradedAsPristine();
	TestConcurrentBind();
	TestPostPackCacheCleanup();
	TestListConsistency();
	TestImportInstall();
	std::cout << "NVENC Galaxy isolation: " << checks << " checks, " << failures << " failures\n";
	return failures == 0 ? 0 : 1;
}
