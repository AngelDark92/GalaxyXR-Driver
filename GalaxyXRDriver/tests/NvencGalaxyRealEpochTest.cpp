// Integration fixture: the REAL src/Driver/NvencTap.cpp (VENDOR_GALAXYXR) driven
// by the REAL src/Driver/GalaxyLinkEpoch.h. Nothing about the epoch is mocked:
//   * the handshake/session text reaches the real Tracker through the real CRT
//     import observer (module-local IAT patch of a fake driver_vrlink.dll image);
//   * the Tracker's PUBLIC injectable seam (addressValidator) supplies the
//     "address belongs to driver_vrlink.dll" proof (an address range check);
//     vtableReader is the real one reading a fake driver object's vtable;
//   * admission, provisional epoch, confirm, pose disconnect, reconnect and
//     failure all go through the real Tracker state machine and CurrentEpoch().
// No GPU, DLL load, SteamVR process or process-wide hook is used.
#include <windows.h>
#include <atomic>
#include <cstdarg>
#include <cstdlib>
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
#include "../src/Driver/NvencTap.cpp"   // includes the real GalaxyLinkEpoch.h
#undef GetModuleHandleW
#undef GetModuleHandleExW
#undef GetModuleFileNameW
#undef LoadLibraryA
#undef LoadLibraryW

Config driverConfig;
namespace NvencPostPack {
bool Process(void*, uint32_t){ return true; }
NvencPostPackStats GetStats(){ return {}; }
void ResetIntervalStats(){}
size_t ReleaseTextures(void* const*, size_t){ return 0; }
size_t CachedTextureCount(){ return 0; }
}
void FrameShimCadenceSnapshot(uint32_t* count, double* maxGapMs){ *count = 0; *maxGapMs = 0; }
void DriverLog(const char*, ...){}

namespace {
namespace gl = gxr::galaxylink;
int checks = 0, failures = 0;
void Check(bool ok, const char* label){ checks++; if(!ok){ failures++; std::cerr << "FAIL: " << label << '\n'; } }
constexpr uint32_t Tag111(uint32_t digit, bool b31 = false){ return kApi111 | (digit << 16) | (0x7u << 28) | (b31 ? (1u << 31) : 0u); }
template<typename T> std::vector<unsigned char> Bytes(const T& v){ return std::vector<unsigned char>(reinterpret_cast<const unsigned char*>(&v), reinterpret_cast<const unsigned char*>(&v) + sizeof(T)); }

// ---- injected module proof (public Tracker seam) ----
bool vrlinkProof = true;   // false = the caller/object is NOT inside driver_vrlink.dll
bool InVrlink(const void* address) noexcept {
	if(!vrlinkProof || !address){ return false; }
	const auto* base = reinterpret_cast<const unsigned char*>(GetModuleHandleA(nullptr));
	const auto* nt = reinterpret_cast<const IMAGE_NT_HEADERS*>(base + reinterpret_cast<const IMAGE_DOS_HEADER*>(base)->e_lfanew);
	const auto* a = reinterpret_cast<const unsigned char*>(address);
	return a >= base && a < base + nt->OptionalHeader.SizeOfImage;
}
struct FakeDriver { const void* const* vtable; };
const void* const kVtable[1] = { reinterpret_cast<const void*>(&InVrlink) };
FakeDriver driverA{ kVtable }, driverB{ kVtable }, driverC{ kVtable };

// ---- fake NVENC runtime ----
uintptr_t nextHandle = 0x1000;
uint32_t seenOpenApi = 0, seenPicVersion = 0;
const int8_t* seenQpMap = nullptr;
int capsWidth = 4096, createCalls = 0;
NVENCSTATUS NVENCAPI FakeOpen(NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS* p, void** e){ seenOpenApi = p->apiVersion; *e = reinterpret_cast<void*>(nextHandle += 0x10); return NV_ENC_SUCCESS; }
NVENCSTATUS NVENCAPI FakeCaps(void*, GUID, NV_ENC_CAPS_PARAM* p, int* v){ *v = p->capsToQuery == NV_ENC_CAPS_WIDTH_MAX ? capsWidth : p->capsToQuery == NV_ENC_CAPS_HEIGHT_MAX ? 16384 : 1; return NV_ENC_SUCCESS; }
NVENCSTATUS NVENCAPI FakeEncode(void*, NV_ENC_PIC_PARAMS* p){ seenPicVersion = p->version; seenQpMap = p->qpDeltaMap; return NV_ENC_SUCCESS; }
NVENCSTATUS NVENCAPI FakeDestroy(void*){ return NV_ENC_SUCCESS; }
const char* NVENCAPI FakeLastError(void*){ return ""; }
NVENCSTATUS NVENCAPI FakeCreate(NV_ENCODE_API_FUNCTION_LIST* list){
	createCalls++;
	list->nvEncOpenEncodeSessionEx = &FakeOpen; list->nvEncGetEncodeCaps = &FakeCaps; list->nvEncEncodePicture = &FakeEncode;
	list->nvEncDestroyEncoder = &FakeDestroy; list->nvEncGetLastErrorString = &FakeLastError;
	return NV_ENC_SUCCESS;
}

// ---- fake driver_vrlink.dll image: GetProcAddress + CRT vsnprintf_s imports ----
constexpr size_t kImageSize = 0x4000;
struct Image {
	unsigned char* base;
	static inline std::string outputText;
	static inline FARPROC gpaResult = nullptr;
	Image(){
		base = static_cast<unsigned char*>(VirtualAlloc(nullptr, kImageSize, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE));
		auto* dos = reinterpret_cast<IMAGE_DOS_HEADER*>(base); dos->e_magic = IMAGE_DOS_SIGNATURE; dos->e_lfanew = 0x80;
		auto* nt = reinterpret_cast<IMAGE_NT_HEADERS64*>(base + 0x80);
		nt->Signature = IMAGE_NT_SIGNATURE; nt->OptionalHeader.Magic = IMAGE_NT_OPTIONAL_HDR64_MAGIC; nt->OptionalHeader.SizeOfImage = kImageSize;
		nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT] = { 0x1000, 3 * sizeof(IMAGE_IMPORT_DESCRIPTOR) };
		auto* d = reinterpret_cast<IMAGE_IMPORT_DESCRIPTOR*>(base + 0x1000);
		d[0].Name = 0x1100; d[0].OriginalFirstThunk = 0x1200; d[0].FirstThunk = 0x2000; std::memcpy(base + 0x1100, "KERNEL32.dll", 13);
		d[1].Name = 0x1110; d[1].OriginalFirstThunk = 0x1240; d[1].FirstThunk = 0x2040; std::memcpy(base + 0x1110, "api-ms-win-crt-stdio-l1-1-0.dll", 32);
		Put(0x1400, "GetProcAddress"); Put(0x1440, "__stdio_common_vsnprintf_s");
		reinterpret_cast<uint64_t*>(base + 0x1200)[0] = 0x1400; reinterpret_cast<uint64_t*>(base + 0x1240)[0] = 0x1440;
		reinterpret_cast<void**>(base + 0x2000)[0] = reinterpret_cast<void*>(&RealGpa);
		reinterpret_cast<void**>(base + 0x2040)[0] = reinterpret_cast<void*>(&RealVsnprintf);
	}
	~Image(){ VirtualFree(base, 0, MEM_RELEASE); }
	void Put(uint32_t rva, const char* name){ std::memcpy(base + rva + 2, name, std::strlen(name) + 1); }
	HMODULE Module(){ return reinterpret_cast<HMODULE>(base); }
	void* GpaSlot(){ return reinterpret_cast<void**>(base + 0x2000)[0]; }
	void* CrtSlot(){ return reinterpret_cast<void**>(base + 0x2040)[0]; }
	static FARPROC WINAPI RealGpa(HMODULE, LPCSTR){ return gpaResult; }
	// stands in for the CRT: writes the already-formatted text for the logger call
	static int RealVsnprintf(unsigned long long, char* buffer, size_t count, size_t, const char*, void*, char*){
		if(!buffer || count == 0 || outputText.size() >= count){ return -1; }
		std::memcpy(buffer, outputText.c_str(), outputText.size() + 1); return static_cast<int>(outputText.size());
	}
};
Image* gVrlink = nullptr;
HMODULE gNvencModule = reinterpret_cast<HMODULE>(0x71000);
}

HMODULE WINAPI FakeModuleW(LPCWSTR name){ return (gVrlink && name && wcscmp(name, L"driver_vrlink.dll") == 0) ? gVrlink->Module() : nullptr; }
BOOL WINAPI FakeModuleEx(DWORD flags, LPCWSTR, HMODULE* out){ if(flags & GET_MODULE_HANDLE_EX_FLAG_PIN){ *out = reinterpret_cast<HMODULE>(1); return TRUE; } *out = gNvencModule; return TRUE; }
DWORD WINAPI FakeModuleFileName(HMODULE, LPWSTR buffer, DWORD size){ const wchar_t* f = L"C:\\Windows\\System32\\nvEncodeAPI64.dll"; wcscpy_s(buffer, size, f); return static_cast<DWORD>(wcslen(f)); }
HMODULE WINAPI ForbiddenLoad(LPCSTR){ std::abort(); }

namespace {
using CrtFn = int (*)(unsigned long long, char*, size_t, size_t, const char*, void*, char*);
CrtFn gCrt = nullptr;
NV_ENCODE_API_FUNCTION_LIST gTable{};

// the vrlink logger: formatted text goes through the patched CRT import
void Say(const char* format, const std::string& formatted){
	static char buffer[8192];
	Image::outputText = formatted;
	gCrt(2, buffer, sizeof(buffer), sizeof(buffer), format, nullptr, nullptr);
}
void NewSession(){ Say(gl::kSessionFormat, "New Session detected; Invalidating.\n"); }
void Props(const char* model){ Say(gl::kPropsFormat, std::string("ReceivedHMDStaticProps. Model Number: ") + model + ", Serial Number: SN123 (1)"); }
bool Begin(FakeDriver& driver){ return gl::BeginHmd(&driver, reinterpret_cast<const void*>(&InVrlink)); }

void Configure(bool enabled){
	NvencTapConfig c; c.enabled = enabled; c.splitMode = 1; c.enforceTile = true; c.effectiveTileWidth = 1536;
	c.qpFovea = -4; c.qpPeriphery = 4;
	NvencTap::Get().SetConfig(c);
}
void* Open(){
	NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS p = {}; p.apiVersion = kApi111; p.version = Tag111(1);
	void* e = nullptr; seenOpenApi = 0;
	Check(gTable.nvEncOpenEncodeSessionEx(&p, &e) == NV_ENC_SUCCESS && p.apiVersion == kApi111 && p.version == Tag111(1), "open succeeds, caller words restored");
	return e;
}
int WidthOf(void* e){
	NV_ENC_CAPS_PARAM c = {}; c.version = Tag111(1); c.capsToQuery = NV_ENC_CAPS_WIDTH_MAX; int w = -1;
	gTable.nvEncGetEncodeCaps(e, NV_ENC_CODEC_HEVC_GUID, &c, &w); return w;
}
bool EncodeUsesQpMap(void* e){
	NV_ENC_PIC_PARAMS pic = {}; pic.version = Tag111(4, true); pic.inputBuffer = reinterpret_cast<void*>(9); pic.outputBitstream = reinterpret_cast<void*>(10);
	pic.inputWidth = 1536; pic.inputHeight = 6144; seenQpMap = nullptr;
	gTable.nvEncEncodePicture(e, &pic); return seenQpMap != nullptr;
}

void Run(){
	_putenv_s("APPDATA", "Z:\\no-such-appdata-for-real-epoch-test");
	gl::detail::Global().addressValidator = &InVrlink; // public injectable seam
	Check(gl::detail::Global().vtableReader != nullptr && gl::CurrentEpoch() == 0, "real tracker starts closed with its real vtable reader");

	// install the module-local hooks into the fake vrlink image (tap ON)
	Image image; gVrlink = &image;
	Configure(true);
	NvencTap::Get().TryInstall();
	Check(NvencTap::Get().Installed(), "local import hooks installed");
	gCrt = reinterpret_cast<CrtFn>(image.CrtSlot());
	auto gpa = reinterpret_cast<FARPROC (*)(HMODULE, LPCSTR)>(image.GpaSlot());
	Image::gpaResult = reinterpret_cast<FARPROC>(&FakeCreate);
	auto createShim = reinterpret_cast<PFN_CreateInstance>(gpa(gNvencModule, "NvEncodeAPICreateInstance"));
	Check(createShim == &NvencTapShims::CreateInstance, "NvEncodeAPICreateInstance bound through GetProcAddress");
	// the table vrlink caches BEFORE any admission
	gTable = {}; gTable.version = Tag111(2);
	Check(createShim(&gTable) == NV_ENC_SUCCESS && gTable.nvEncOpenEncodeSessionEx == NvencTapShims::OpenEncodeSessionEx && createCalls == 1, "cached pre-admission table wrapped with a single real call");

	// 1) not admitted: pristine
	void* pre = Open();
	Check(seenOpenApi == kApi111 && AuthorityOf(pre) == Auth::Pristine && WidthOf(pre) == capsWidth, "before any handshake: pristine open");

	// 2) wrong model: nothing adopted
	NewSession(); Props("some-other-model");
	Check(!Begin(driverA) && gl::CurrentEpoch() == 0, "non-original model: BeginHmd refused, epoch stays 0");
	void* wrongModel = Open();
	Check(AuthorityOf(wrongModel) == Auth::Pristine, "non-original model: pristine open");

	// 3) original handshake observed by the REAL observer path; provisional epoch
	NewSession(); Props("xrvst2ue");
	vrlinkProof = false;
	Check(!Begin(driverA) && gl::CurrentEpoch() == 0, "module proof missing: BeginHmd refused");
	vrlinkProof = true;
	Check(Begin(driverA), "real BeginHmd admits provisionally (valid proof + fresh handshake)");
	const uint64_t e1 = gl::CurrentEpoch();
	Check(e1 != 0, "provisional epoch is published nonzero");
	gl::BindHmd(3);
	void* provisional = Open();
	Check(seenOpenApi == kApi121 && AuthorityOf(provisional) == Auth::Live && Upgraded(provisional), "provisional epoch: new session is Live and upgraded");
	gl::ConfirmHmd(3, true);
	Check(gl::CurrentEpoch() == e1 && AuthorityOf(provisional) == Auth::Live && WidthOf(provisional) == 1536 && EncodeUsesQpMap(provisional), "confirmed: same epoch, policy active");
	// foreign module proof while the epoch is open
	vrlinkProof = false;
	void* foreign = Open();
	Check(seenOpenApi == kApi111 && AuthorityOf(foreign) == Auth::Pristine && WidthOf(foreign) == capsWidth, "open epoch but caller not in driver_vrlink.dll: pristine");
	NV_ENCODE_API_FUNCTION_LIST foreignList{}; foreignList.version = Tag111(2);
	Check(createShim(&foreignList) == NV_ENC_SUCCESS && foreignList.nvEncOpenEncodeSessionEx == &FakeOpen, "foreign CreateInstance caller: table untouched");
	vrlinkProof = true;

	// 4) target disconnects: CurrentEpoch is published 0 (never the raw counter)
	gl::ObservePose(3, false);
	Check(gl::CurrentEpoch() == 0, "pose disconnect: published epoch is 0");
	Check(AuthorityOf(provisional) == Auth::Stale, "disconnect: the old session is Stale");
	Check(!EncodeUsesQpMap(provisional) && seenPicVersion == Tag121(6, true) && WidthOf(provisional) == capsWidth, "disconnect: no new QP/caps policy, ABI retained");
	void* afterClose = Open(); // a current (or foreign) vrlink NVENC OPEN after the disconnect
	Check(seenOpenApi == kApi111 && AuthorityOf(afterClose) == Auth::Pristine && !Upgraded(afterClose), "after disconnect: OPEN is pristine, closed epoch is not admitted");
	vrlinkProof = false; void* afterCloseForeign = Open(); vrlinkProof = true;
	Check(AuthorityOf(afterCloseForeign) == Auth::Pristine, "after disconnect: foreign OPEN pristine");

	// 5) reconnect: fresh session + handshake + new object -> a new epoch
	Check(!Begin(driverB), "no fresh handshake yet: reconnect refused");
	NewSession(); Props("xrvst2ue");
	Check(Begin(driverB), "fresh handshake after disconnect admits the new object");
	const uint64_t e2 = gl::CurrentEpoch();
	Check(e2 != 0 && e2 != e1, "reconnect: a brand-new epoch");
	gl::BindHmd(3); gl::ConfirmHmd(3, true);
	Check(AuthorityOf(provisional) == Auth::Stale && AuthorityOf(afterClose) == Auth::Pristine, "reconnect: old session still Stale, earlier pristine still pristine");
	void* fresh = Open();
	Check(seenOpenApi == kApi121 && AuthorityOf(fresh) == Auth::Live && EncodeUsesQpMap(fresh), "reconnect: new session is Live in the new epoch");

	// 6) failed confirmation closes the epoch
	gl::ObservePose(3, false);
	NewSession(); Props("xrvst2ue");
	Check(Begin(driverC), "third object admitted provisionally");
	gl::BindHmd(4); gl::ConfirmHmd(4, false);
	Check(gl::CurrentEpoch() == 0, "failed confirm: epoch 0");
	void* afterFailedConfirm = Open();
	Check(AuthorityOf(afterFailedConfirm) == Auth::Pristine && AuthorityOf(fresh) == Auth::Stale, "failed confirm: new OPEN pristine, previous session stale");

	// 7) identity/handshake admission is independent of the NVENC tap toggle
	Configure(false);
	gl::ObservePose(4, false);
	NewSession(); Props("xrvst2ue");
	Check(Begin(driverA), "tap OFF: the observer still admits the identity");
	gl::BindHmd(3); gl::ConfirmHmd(3, true);
	void* offSession = Open();
	Check(seenOpenApi == kApi111 && AuthorityOf(offSession) == Auth::Live && !Upgraded(offSession), "tap OFF: admitted session is Live but stock (no upgrade)");
	Configure(true);
	void* onSession = Open();
	Check(seenOpenApi == kApi121 && Upgraded(onSession) && AuthorityOf(onSession) == Auth::Live, "tap ON again: the cached table serves a new admitted OPEN");

	// 8) explicit close / CloseIfEpoch
	const uint64_t e3 = gl::CurrentEpoch();
	gl::CloseIfEpoch(e3 + 100);
	Check(gl::CurrentEpoch() == e3, "CloseIfEpoch for another epoch is ignored");
	gl::Close();
	Check(gl::CurrentEpoch() == 0 && AuthorityOf(onSession) == Auth::Stale && AuthorityOf(offSession) == Auth::Stale, "Close(): everything opened under the epoch is Stale");

	NvencTap::Get().Cleanup();
	gVrlink = nullptr;
}
}

int main(){
	Run();
	std::cout << "NVENC Galaxy real-epoch integration: " << checks << " checks, " << failures << " failures\n";
	return failures == 0 ? 0 : 1;
}
