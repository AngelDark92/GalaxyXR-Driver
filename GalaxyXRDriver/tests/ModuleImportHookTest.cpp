// Fixture tests for src/Hooking/ModuleImportHook.h. A synthetic x64 PE image is
// built in VirtualAlloc'd memory; no real module, loader hook or process-wide
// state is touched.
#include "../src/Hooking/ModuleImportHook.h"
#include <cstdio>
#include <iostream>
#include <string>
#include <vector>

using namespace gxr::hooking;

namespace {
int checks = 0, failures = 0;
void Check(bool ok, const char* label){ checks++; if(!ok){ failures++; std::cerr << "FAIL: " << label << '\n'; } }

constexpr size_t kImageSize = 0x4000;

// Functions standing in for real imports. Distinct bodies so the linker cannot fold them.
volatile int sink = 0;
FARPROC WINAPI RealGpaKernel32(HMODULE, LPCSTR){ sink += 1; return reinterpret_cast<FARPROC>(0x1111); }
FARPROC WINAPI RealGpaKernelBase(HMODULE, LPCSTR){ sink += 2; return reinterpret_cast<FARPROC>(0x2222); }
int RealVsnprintf(unsigned long long, char* buffer, size_t count, size_t, const char* format, void*, char* args){
	sink += 3; if(count){ std::snprintf(buffer, count, "%s", format); } (void)args; return static_cast<int>(std::strlen(format));
}
void Other(){ sink += 4; }

struct Fixture {
	unsigned char* base = nullptr;
	Fixture(){ base = static_cast<unsigned char*>(VirtualAlloc(nullptr, kImageSize, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE)); }
	~Fixture(){ if(base){ VirtualFree(base, 0, MEM_RELEASE); } }
	template<typename T> T* At(uint32_t rva){ return reinterpret_cast<T*>(base + rva); }
	void Name(uint32_t rva, const char* text){ std::memcpy(base + rva, text, std::strlen(text) + 1); }
	// by-name import: hint(2 bytes) + name
	void ImportName(uint32_t rva, const char* text){ *At<uint16_t>(rva) = 0; Name(rva + 2, text); }
	HMODULE Module(){ return reinterpret_cast<HMODULE>(base); }
};

constexpr uint32_t kDescRva = 0x1000;
constexpr uint32_t kIatKernel32 = 0x2000, kIatUcrt = 0x2040, kIatKernelBase = 0x2080;

// kernel32.dll: GetProcAddress, ordinal 0x10, LoadLibraryA | ucrtbase.dll: vsnprintf_s, printf | kernelbase.dll: GetProcAddress
void Build(Fixture& f){
	auto* dos = f.At<IMAGE_DOS_HEADER>(0);
	dos->e_magic = IMAGE_DOS_SIGNATURE; dos->e_lfanew = 0x80;
	auto* nt = f.At<IMAGE_NT_HEADERS64>(0x80);
	nt->Signature = IMAGE_NT_SIGNATURE;
	nt->OptionalHeader.Magic = IMAGE_NT_OPTIONAL_HDR64_MAGIC;
	nt->OptionalHeader.SizeOfImage = kImageSize;
	nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT] = { kDescRva, 4 * sizeof(IMAGE_IMPORT_DESCRIPTOR) };
	auto* d = f.At<IMAGE_IMPORT_DESCRIPTOR>(kDescRva);
	d[0].Name = 0x1100; d[0].OriginalFirstThunk = 0x1200; d[0].FirstThunk = kIatKernel32;
	d[1].Name = 0x1110; d[1].OriginalFirstThunk = 0x1240; d[1].FirstThunk = kIatUcrt;
	d[2].Name = 0x1120; d[2].OriginalFirstThunk = 0x1280; d[2].FirstThunk = kIatKernelBase;
	f.Name(0x1100, "KERNEL32.dll"); f.Name(0x1110, "api-ms-win-crt-stdio-l1-1-0.dll"); f.Name(0x1120, "KernelBase.dll");
	f.ImportName(0x1400, "GetProcAddress"); f.ImportName(0x1420, "LoadLibraryA");
	f.ImportName(0x1440, "__stdio_common_vsnprintf_s"); f.ImportName(0x1470, "printf"); f.ImportName(0x1480, "GetProcAddress");
	auto* int0 = f.At<uint64_t>(0x1200); int0[0] = 0x1400; int0[1] = IMAGE_ORDINAL_FLAG64 | 0x10; int0[2] = 0x1420; int0[3] = 0;
	auto* int1 = f.At<uint64_t>(0x1240); int1[0] = 0x1440; int1[1] = 0x1470; int1[2] = 0;
	auto* int2 = f.At<uint64_t>(0x1280); int2[0] = 0x1480; int2[1] = 0;
	auto* iat0 = f.At<void*>(kIatKernel32); iat0[0] = reinterpret_cast<void*>(&RealGpaKernel32); iat0[1] = reinterpret_cast<void*>(&Other); iat0[2] = reinterpret_cast<void*>(&Other);
	auto* iat1 = f.At<void*>(kIatUcrt); iat1[0] = reinterpret_cast<void*>(&RealVsnprintf); iat1[1] = reinterpret_cast<void*>(&Other);
	auto* iat2 = f.At<void*>(kIatKernelBase); iat2[0] = reinterpret_cast<void*>(&RealGpaKernelBase);
}

bool MatchGpa(const char* dll, const char* name){
	(void)dll; return std::strcmp(name, "GetProcAddress") == 0;
}
bool MatchAnyName(const char*, const char*){ return true; }
bool MatchCrt(const char*, const char* name){ return std::strcmp(name, "__stdio_common_vsnprintf_s") == 0; }

// ---- pool tags: each scenario owns its own static pool ----
struct GpaA {}; struct GpaB {}; struct GpaC {}; struct CrtA {}; struct Exhaust {};
using GpaFn = FARPROC(HMODULE, LPCSTR);
int implCalls = 0;
FARPROC GpaCounting(FARPROC (*next)(HMODULE, LPCSTR), HMODULE m, LPCSTR n){ implCalls++; return next(m, n); }

int observed = 0; std::string observedFormat; std::string observedText;
int CrtObserve(int (*next)(unsigned long long, char*, size_t, size_t, const char*, void*, char*),
		unsigned long long o, char* b, size_t c, size_t m, const char* f, void* l, char* a){
	const int r = next(o, b, c, m, f, l, a);
	observed++; observedFormat = f ? f : ""; observedText = b ? b : "";
	return r;
}

// nine distinct function bodies for pool exhaustion
template<int N> int Distinct(int v){ sink += N; return v + N; }
using IntFn = int (*)(int);
const IntFn kDistinct[] = { &Distinct<1>, &Distinct<2>, &Distinct<3>, &Distinct<4>, &Distinct<5>, &Distinct<6>, &Distinct<7>, &Distinct<8>, &Distinct<9> };
int ExhaustImpl(int (*next)(int), int v){ return next(v); }

void TestScan(){
	Fixture f; Build(f);
	auto gpa = ScanImports(f.Module(), &MatchGpa);
	Check(gpa.status == ScanStatus::Ok && gpa.slots.size() == 2, "scan: GetProcAddress from kernel32 and kernelbase descriptors");
	if(gpa.slots.size() == 2){
		Check(gpa.slots[0].slot == f.At<void*>(kIatKernel32) && gpa.slots[0].current == reinterpret_cast<void*>(&RealGpaKernel32), "scan: kernel32 slot address/value");
		Check(gpa.slots[1].slot == f.At<void*>(kIatKernelBase) && gpa.slots[1].dll == "KernelBase.dll", "scan: kernelbase slot and descriptor name");
	}
	auto all = ScanImports(f.Module(), &MatchAnyName);
	Check(all.slots.size() == 5, "scan: every by-name import reported, the ordinal import never");
	for(const auto& s : all.slots){ Check(s.name != "" && s.name.find("0x") == std::string::npos, "scan: no ordinal pseudo-name"); }
	auto crt = ScanImports(f.Module(), &MatchCrt);
	Check(crt.status == ScanStatus::Ok && crt.slots.size() == 1 && crt.slots[0].slot == f.At<void*>(kIatUcrt), "scan: CRT vsnprintf_s slot");
	auto none = ScanImports(f.Module(), [](const char*, const char* n){ return std::strcmp(n, "NotImported") == 0; });
	Check(none.status == ScanStatus::NoImports && none.slots.empty(), "scan: unrelated name -> NoImports");
}

void TestMalformed(){
	Check(ScanImports(nullptr, &MatchGpa).status == ScanStatus::InvalidImage, "malformed: null module");
	{ Fixture f; Build(f); f.At<IMAGE_DOS_HEADER>(0)->e_magic = 0; Check(ScanImports(f.Module(), &MatchGpa).status == ScanStatus::InvalidImage, "malformed: bad DOS magic"); }
	{ Fixture f; Build(f); f.At<IMAGE_DOS_HEADER>(0)->e_lfanew = 0x83; Check(ScanImports(f.Module(), &MatchGpa).status == ScanStatus::InvalidImage, "malformed: misaligned e_lfanew"); }
	{ Fixture f; Build(f); f.At<IMAGE_DOS_HEADER>(0)->e_lfanew = static_cast<LONG>(kImageSize - 8); Check(ScanImports(f.Module(), &MatchGpa).status == ScanStatus::InvalidImage, "malformed: NT headers outside image"); }
	{ Fixture f; Build(f); f.At<IMAGE_NT_HEADERS64>(0x80)->Signature = 0; Check(ScanImports(f.Module(), &MatchGpa).status == ScanStatus::InvalidImage, "malformed: bad PE signature"); }
	{ Fixture f; Build(f); f.At<IMAGE_NT_HEADERS64>(0x80)->OptionalHeader.Magic = IMAGE_NT_OPTIONAL_HDR32_MAGIC; Check(ScanImports(f.Module(), &MatchGpa).status == ScanStatus::InvalidImage, "malformed: PE32 image rejected"); }
	{ Fixture f; Build(f); f.At<IMAGE_NT_HEADERS64>(0x80)->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT].VirtualAddress = 0; Check(ScanImports(f.Module(), &MatchGpa).status == ScanStatus::NoImports, "malformed: no import directory"); }
	{ Fixture f; Build(f); f.At<IMAGE_NT_HEADERS64>(0x80)->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT].VirtualAddress = static_cast<DWORD>(kImageSize - 4); Check(ScanImports(f.Module(), &MatchGpa).status == ScanStatus::InvalidImage, "malformed: import directory outside image"); }
	{ Fixture f; Build(f); f.At<IMAGE_IMPORT_DESCRIPTOR>(kDescRva)[0].FirstThunk = kIatKernel32 + 4; auto r = ScanImports(f.Module(), &MatchGpa); Check(r.slots.size() == 1, "malformed: misaligned IAT descriptor skipped, others kept"); }
	{ Fixture f; Build(f); f.At<IMAGE_IMPORT_DESCRIPTOR>(kDescRva)[0].FirstThunk = static_cast<DWORD>(kImageSize); f.At<IMAGE_IMPORT_DESCRIPTOR>(kDescRva)[0].OriginalFirstThunk = 0x1200; auto r = ScanImports(f.Module(), &MatchGpa); Check(r.slots.size() == 1, "malformed: IAT slot beyond image never reported"); }
	{ Fixture f; Build(f); f.At<uint64_t>(0x1200)[0] = kImageSize + 0x10; auto r = ScanImports(f.Module(), &MatchGpa); Check(r.slots.size() == 1, "malformed: out-of-image name RVA skipped"); }
	{ Fixture f; Build(f); f.At<uint64_t>(0x1200)[0] = 0x00000001'00001400ull; auto r = ScanImports(f.Module(), &MatchGpa); Check(r.slots.size() == 1, "malformed: reserved high bits in name entry skipped"); }
	{ Fixture f; Build(f); std::memset(f.base + 0x1400, 'A', 0x300); auto r = ScanImports(f.Module(), &MatchAnyName); Check(r.slots.size() < 5, "malformed: unterminated/oversized import name skipped"); }
	{ Fixture f; Build(f); f.At<IMAGE_IMPORT_DESCRIPTOR>(kDescRva)[1].OriginalFirstThunk = 0; auto r = ScanImports(f.Module(), &MatchCrt); Check(r.slots.empty(), "malformed: descriptor without import name table skipped"); }
	{ Fixture f; Build(f); f.At<IMAGE_IMPORT_DESCRIPTOR>(kDescRva)[0].Name = static_cast<DWORD>(kImageSize + 8); auto r = ScanImports(f.Module(), &MatchGpa); Check(r.slots.size() == 1, "malformed: descriptor with out-of-image DLL name skipped"); }
}

void TestPatchAndChain(){
	Fixture f; Build(f);
	auto gpa = ScanImports(f.Module(), &MatchGpa);
	using Pool = HookPool<GpaA, FARPROC(HMODULE, LPCSTR)>;
	Pool::SetImpl(&GpaCounting);
	std::vector<PatchRecord> records;
	Check(PatchWithPool<Pool>(gpa.slots, records), "patch: two distinct nexts patched");
	Check(records.size() == 2 && Pool::Used() == 2, "patch: one trampoline per distinct next");
	auto* k32 = reinterpret_cast<FARPROC (*)(HMODULE, LPCSTR)>(*f.At<void*>(kIatKernel32));
	auto* kb = reinterpret_cast<FARPROC (*)(HMODULE, LPCSTR)>(*f.At<void*>(kIatKernelBase));
	Check(k32 != RealGpaKernel32 && kb != RealGpaKernelBase && k32 != kb, "patch: slots now hold distinct replacements");
	Pool::SetActive(true); implCalls = 0;
	Check(k32(nullptr, "x") == reinterpret_cast<FARPROC>(0x1111), "chain: kernel32 slot reaches its own next");
	Check(kb(nullptr, "x") == reinterpret_cast<FARPROC>(0x2222), "chain: kernelbase slot reaches its own next");
	Check(implCalls == 2, "chain: impl observed both calls");
	// idempotent re-patch: slots already hold our thunks
	std::vector<PatchRecord> again;
	Check(PatchWithPool<Pool>(gpa.slots, again) && again.empty(), "patch: already-owned slots are skipped, not double-wrapped");

	// a foreign hook chained on top of our slot (previous hook preserved as next)
	static FARPROC (*ourK32)(HMODULE, LPCSTR) = k32;
	static auto foreign = +[](HMODULE m, LPCSTR n) -> FARPROC { sink += 9; return ourK32(m, n); };
	*f.At<void*>(kIatKernel32) = reinterpret_cast<void*>(foreign);
	Pool::SetActive(false); implCalls = 0;
	Check(k32(nullptr, "x") == reinterpret_cast<FARPROC>(0x1111) && implCalls == 0, "deactivated thunk is a pure passthrough to its next");
	size_t restored = RestorePatches(records);
	Check(restored == 1, "restore: only the slot still holding our thunk is restored");
	Check(*f.At<void*>(kIatKernel32) == reinterpret_cast<void*>(foreign), "restore: foreign hook over our slot is left alone");
	Check(*f.At<void*>(kIatKernelBase) == reinterpret_cast<void*>(&RealGpaKernelBase), "restore: own slot returns to its previous next");
	Check(foreign(nullptr, "x") == reinterpret_cast<FARPROC>(0x1111), "restore: abandoned thunk stays callable (lifetime retained)");
	// re-patch after restore reuses the pool entry for the same next
	auto again2 = ScanImports(f.Module(), &MatchGpa);
	std::vector<PatchRecord> rec2;
	*f.At<void*>(kIatKernel32) = reinterpret_cast<void*>(&RealGpaKernel32);
	Check(PatchWithPool<Pool>(again2.slots, rec2) && Pool::Used() == 2, "patch: reinstall reuses existing trampolines");
	RestorePatches(rec2);
}

void TestSharedNext(){
	Fixture f; Build(f);
	*f.At<void*>(kIatKernelBase) = reinterpret_cast<void*>(&RealGpaKernel32); // two slots, one next
	auto gpa = ScanImports(f.Module(), &MatchGpa);
	using Pool = HookPool<GpaB, FARPROC(HMODULE, LPCSTR)>;
	std::vector<PatchRecord> records;
	Check(PatchWithPool<Pool>(gpa.slots, records) && Pool::Used() == 1 && records.size() == 2, "patch: slots with identical next share one trampoline");
	Check(*f.At<void*>(kIatKernel32) == *f.At<void*>(kIatKernelBase), "patch: shared trampoline installed in both slots");
	RestorePatches(records);
	Check(*f.At<void*>(kIatKernel32) == reinterpret_cast<void*>(&RealGpaKernel32), "restore: shared-next slots restored");
}

void TestCrtObserver(){
	Fixture f; Build(f);
	auto crt = ScanImports(f.Module(), &MatchCrt);
	using Pool = HookPool<CrtA, int(unsigned long long, char*, size_t, size_t, const char*, void*, char*)>;
	Pool::SetImpl(&CrtObserve);
	std::vector<PatchRecord> records;
	Check(PatchWithPool<Pool>(crt.slots, records), "crt: patched");
	Pool::SetActive(true);
	auto call = reinterpret_cast<int (*)(unsigned long long, char*, size_t, size_t, const char*, void*, char*)>(*f.At<void*>(kIatUcrt));
	char buffer[64] = {};
	char* fakeArgs = reinterpret_cast<char*>(0x1234);
	const int direct = RealVsnprintf(0x7, buffer, sizeof(buffer), 64, "New Session detected", nullptr, fakeArgs);
	char buffer2[64] = {};
	const int viaHook = call(0x7, buffer2, sizeof(buffer2), 64, "New Session detected", nullptr, fakeArgs);
	Check(viaHook == direct && std::strcmp(buffer, buffer2) == 0, "crt: observer returns the original result and output unchanged");
	Check(observed == 1 && observedFormat == "New Session detected" && observedText == "New Session detected", "crt: observer saw format and formatted text");
	Pool::SetActive(false); observed = 0;
	char buffer3[64] = {};
	Check(call(0x7, buffer3, sizeof(buffer3), 64, "x", nullptr, fakeArgs) == 1 && observed == 0, "crt: deactivated -> passthrough, no observation");
	RestorePatches(records);
	Check(*f.At<void*>(kIatUcrt) == reinterpret_cast<void*>(&RealVsnprintf), "crt: slot restored");
}

void TestExhaustionFailsClosed(){
	Fixture f; Build(f);
	// build a descriptor whose IAT holds nine distinct nexts
	auto* d = f.At<IMAGE_IMPORT_DESCRIPTOR>(kDescRva);
	d[0].OriginalFirstThunk = 0x1500; d[0].FirstThunk = 0x2100;
	auto* nameTable = f.At<uint64_t>(0x1500); auto* iat = f.At<void*>(0x2100);
	for(int i = 0; i < 9; i++){ f.ImportName(0x1600 + i * 0x20, "GetProcAddress"); nameTable[i] = 0x1600 + i * 0x20; iat[i] = reinterpret_cast<void*>(kDistinct[i]); }
	nameTable[9] = 0;
	d[1].Name = 0; d[1].OriginalFirstThunk = 0; d[1].FirstThunk = 0; // terminate after d[0]
	auto scan = ScanImports(f.Module(), &MatchGpa);
	Check(scan.slots.size() == 9, "exhaustion: nine distinct slots scanned");
	using Pool = HookPool<Exhaust, int(int)>;
	Pool::SetImpl(&ExhaustImpl);
	std::vector<PatchRecord> records;
	Check(!PatchWithPool<Pool>(scan.slots, records), "exhaustion: more distinct nexts than the pool holds fails closed");
	bool pristine = true;
	for(int i = 0; i < 9; i++){ pristine = pristine && iat[i] == reinterpret_cast<void*>(kDistinct[i]); }
	Check(pristine && records.empty(), "exhaustion: every earlier patch rolled back, no original overwritten");
}

void TestPin(){
	Check(PinModuleContaining(reinterpret_cast<const void*>(&TestPin)), "pin: module containing an address can be pinned");
	Check(!PinModuleContaining(reinterpret_cast<const void*>(8)), "pin: bogus address refused");
}
} // namespace

int main(){
	TestScan(); TestMalformed(); TestPatchAndChain(); TestSharedNext(); TestCrtObserver(); TestExhaustionFailsClosed(); TestPin();
	std::cout << "ModuleImportHook: " << checks << " checks, " << failures << " failures\n";
	return failures == 0 ? 0 : 1;
}
