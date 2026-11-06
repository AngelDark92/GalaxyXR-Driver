#pragma once
// Header-only, module-local import address table (IAT) patching.
//
// Scope: patches only the IAT slots of ONE already-loaded module. Nothing here
// touches the exporting module, other importers or process-wide code. Scanning
// and patching run on install/cleanup paths only; the generated replacement
// functions (HookPool thunks) never log, allocate, lock or throw.
//
// Lifetime rules:
//   * Thunk pools are static and never freed. A thunk stays valid for the life
//     of the process, so an unrestorable slot (another hook chained over it)
//     keeps working: after Deactivate() every thunk is a plain tail call to its
//     recorded next function.
//   * Restore only rewrites a slot whose current value is still our thunk
//     (atomic compare-exchange). A foreign hook installed over us is left alone.
//   * x64 only. A different image layout is reported as InvalidImage.
#include <windows.h>
#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

namespace gxr::hooking {

struct ImportSlot {
	void** slot = nullptr;   // address of the IAT entry inside the scanned image
	void* current = nullptr; // value observed at scan time
	std::string dll;         // import descriptor DLL name as written in the image
	std::string name;        // imported symbol name (ordinal imports are never reported)
};

enum class ScanStatus { Ok, InvalidImage, NoImports };

struct ScanResult {
	ScanStatus status = ScanStatus::InvalidImage;
	std::vector<ImportSlot> slots;
};

// Match on the descriptor DLL name and the imported symbol name. Called only
// for by-name imports; ordinals are skipped before the matcher runs.
using ImportMatcher = bool (*)(const char* dll, const char* name);

namespace detail {

struct Image {
	const unsigned char* base = nullptr;
	size_t size = 0;
	bool Contains(uint64_t rva, uint64_t length) const {
		return rva <= size && length <= size - rva;
	}
	// Bounded C string at rva: returns false if unterminated within the image.
	bool String(uint64_t rva, std::string& out, size_t maxLength = 256) const {
		if(rva >= size){ return false; }
		const size_t available = size - static_cast<size_t>(rva);
		const size_t limit = available < maxLength ? available : maxLength;
		const void* end = std::memchr(base + rva, 0, limit);
		if(!end){ return false; }
		out.assign(reinterpret_cast<const char*>(base + rva), static_cast<const unsigned char*>(end) - (base + rva));
		return true;
	}
};

inline bool ReadImage(HMODULE module, Image& image, const IMAGE_NT_HEADERS64*& nt){
	if(!module){ return false; }
	const auto* base = reinterpret_cast<const unsigned char*>(module);
	const auto* dos = reinterpret_cast<const IMAGE_DOS_HEADER*>(base);
	if(dos->e_magic != IMAGE_DOS_SIGNATURE){ return false; }
	const LONG lfanew = dos->e_lfanew;
	if(lfanew < static_cast<LONG>(sizeof(IMAGE_DOS_HEADER)) || (lfanew & 3) != 0){ return false; }
	nt = reinterpret_cast<const IMAGE_NT_HEADERS64*>(base + lfanew);
	if(nt->Signature != IMAGE_NT_SIGNATURE){ return false; }
	if(nt->OptionalHeader.Magic != IMAGE_NT_OPTIONAL_HDR64_MAGIC){ return false; }
	const size_t imageSize = nt->OptionalHeader.SizeOfImage;
	if(imageSize < static_cast<size_t>(lfanew) + sizeof(IMAGE_NT_HEADERS64)){ return false; }
	image.base = base; image.size = imageSize;
	return true;
}

} // namespace detail

// Walk every import descriptor of `module` and report each by-name slot the
// matcher accepts. Every RVA, string and slot address is bounds checked against
// SizeOfImage; slots must be 8-byte aligned. Malformed descriptors are skipped
// individually (a bad descriptor never produces a slot).
inline ScanResult ScanImports(HMODULE module, ImportMatcher matcher){
	ScanResult result;
	detail::Image image; const IMAGE_NT_HEADERS64* nt = nullptr;
	if(!matcher || !detail::ReadImage(module, image, nt)){ return result; }
	const IMAGE_DATA_DIRECTORY dir = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT];
	if(dir.VirtualAddress == 0 || dir.Size == 0){ result.status = ScanStatus::NoImports; return result; }
	if(!image.Contains(dir.VirtualAddress, sizeof(IMAGE_IMPORT_DESCRIPTOR))){ return result; }
	result.status = ScanStatus::NoImports;
	const uint64_t tableEnd = image.size; // the terminating null descriptor bounds the walk
	for(uint64_t rva = dir.VirtualAddress; image.Contains(rva, sizeof(IMAGE_IMPORT_DESCRIPTOR)); rva += sizeof(IMAGE_IMPORT_DESCRIPTOR)){
		IMAGE_IMPORT_DESCRIPTOR desc;
		std::memcpy(&desc, image.base + rva, sizeof(desc));
		if(desc.Name == 0 && desc.FirstThunk == 0 && desc.OriginalFirstThunk == 0){ break; }
		if(rva >= tableEnd){ break; }
		std::string dll;
		if(!image.String(desc.Name, dll)){ continue; }
		if(desc.FirstThunk == 0 || (desc.FirstThunk & 7u) != 0){ continue; }
		// without an import name table the by-name entries cannot be identified
		const uint32_t intRva = desc.OriginalFirstThunk;
		if(intRva == 0 || (intRva & 7u) != 0){ continue; }
		for(uint32_t i = 0;; i++){
			const uint64_t intEntryRva = static_cast<uint64_t>(intRva) + static_cast<uint64_t>(i) * 8u;
			const uint64_t iatEntryRva = static_cast<uint64_t>(desc.FirstThunk) + static_cast<uint64_t>(i) * 8u;
			if(!image.Contains(intEntryRva, 8) || !image.Contains(iatEntryRva, 8)){ break; }
			uint64_t entry;
			std::memcpy(&entry, image.base + intEntryRva, sizeof(entry));
			if(entry == 0){ break; }
			if(entry & IMAGE_ORDINAL_FLAG64){ continue; } // ordinal import
			const uint64_t nameRva = entry & 0x7FFFFFFFull;
			if(entry != nameRva){ continue; } // reserved high bits set: not a name RVA
			std::string name;
			if(!image.Contains(nameRva, 3) || !image.String(nameRva + 2, name, 128) || name.empty()){ continue; }
			if(!matcher(dll.c_str(), name.c_str())){ continue; }
			ImportSlot found;
			found.slot = reinterpret_cast<void**>(const_cast<unsigned char*>(image.base) + iatEntryRva);
			found.current = *reinterpret_cast<void* volatile*>(found.slot);
			found.dll = dll; found.name = name;
			result.slots.push_back(std::move(found));
		}
	}
	if(!result.slots.empty()){ result.status = ScanStatus::Ok; }
	return result;
}

// One slot we changed: `next` is what the slot held before (the previous hook
// in the chain or the real function), `replacement` is our thunk.
struct PatchRecord {
	void** slot = nullptr;
	void* next = nullptr;
	void* replacement = nullptr;
};

// Atomically replace *slot when it still holds `expected`.
inline bool CompareExchangeSlot(void** slot, void* expected, void* replacement){
	DWORD oldProtect = 0;
	if(!VirtualProtect(slot, sizeof(void*), PAGE_READWRITE, &oldProtect)){ return false; }
	void* const previous = InterlockedCompareExchangePointer(reinterpret_cast<PVOID volatile*>(slot), replacement, expected);
	DWORD ignored = 0;
	VirtualProtect(slot, sizeof(void*), oldProtect, &ignored);
	return previous == expected;
}

// Restore only slots that still hold our thunk. Returns the number restored.
inline size_t RestorePatches(std::vector<PatchRecord>& records){
	size_t restored = 0;
	for(auto it = records.rbegin(); it != records.rend(); ++it){
		if(CompareExchangeSlot(it->slot, it->replacement, it->next)){ restored++; }
	}
	records.clear();
	return restored;
}

// Fixed-size pool of distinct replacement functions for one function signature.
// Each pool entry owns one `next` pointer, so slots that currently hold
// different functions (kernel32 vs kernelbase export, or a chained foreign
// hook) each get a correct trampoline. When all entries are used Acquire fails
// and the caller must fail closed.
template<typename Tag, typename Signature> class HookPool;

template<typename Tag, typename R, typename... Args>
class HookPool<Tag, R(Args...)> {
public:
	using Fn = R (*)(Args...);
	using Impl = R (*)(Fn next, Args... args);
	static constexpr size_t kCapacity = 8;

	// `impl` is invoked as impl(next, args...) while active; it must be
	// non-blocking, non-allocating and must call `next` exactly as given.
	static void SetImpl(Impl impl){ State().impl.store(impl, std::memory_order_release); }
	static void SetActive(bool active){ State().active.store(active, std::memory_order_release); }
	static bool Active(){ return State().active.load(std::memory_order_acquire); }

	static Fn Acquire(Fn next){
		if(!next){ return nullptr; }
		auto& s = State();
		std::lock_guard<std::mutex> guard(s.lock);
		const size_t used = s.used.load(std::memory_order_acquire);
		for(size_t i = 0; i < used; i++){ if(s.next[i].load(std::memory_order_acquire) == next){ return Thunks()[i]; } }
		if(used >= kCapacity){ return nullptr; }
		s.next[used].store(next, std::memory_order_release);
		s.used.store(used + 1, std::memory_order_release);
		return Thunks()[used];
	}
	// true when `candidate` is one of this pool's thunks
	static bool Owns(const void* candidate){
		auto& s = State();
		const size_t used = s.used.load(std::memory_order_acquire);
		for(size_t i = 0; i < used; i++){ if(reinterpret_cast<const void*>(Thunks()[i]) == candidate){ return true; } }
		return false;
	}
	static size_t Used(){ return State().used.load(std::memory_order_acquire); }

private:
	struct Data {
		std::atomic<Impl> impl{nullptr};
		std::atomic<bool> active{false};
		std::atomic<size_t> used{0};
		std::atomic<Fn> next[kCapacity];
		std::mutex lock;
		Data(){ for(auto& n : next){ n.store(nullptr); } }
	};
	static Data& State(){ static Data data; return data; }
	template<size_t I> static R Thunk(Args... args){
		auto& s = State();
		const Fn next = s.next[I].load(std::memory_order_acquire);
		const Impl impl = s.impl.load(std::memory_order_acquire);
		if(!impl || !s.active.load(std::memory_order_acquire)){ return next(args...); }
		return impl(next, args...);
	}
	template<size_t... I> static std::array<Fn, kCapacity> MakeThunks(std::index_sequence<I...>){
		return {{ &Thunk<I>... }};
	}
	static const std::array<Fn, kCapacity>& Thunks(){
		static const std::array<Fn, kCapacity> table = MakeThunks(std::make_index_sequence<kCapacity>{});
		return table;
	}
};

// Patch every scanned slot with a thunk from `Pool`. All-or-nothing: on any
// failure every slot patched by this call is restored and false is returned.
// A slot already holding one of our thunks is treated as patched (idempotent).
template<typename Pool>
bool PatchWithPool(const std::vector<ImportSlot>& slots, std::vector<PatchRecord>& records){
	std::vector<PatchRecord> added;
	for(const ImportSlot& found : slots){
		void* const current = *reinterpret_cast<void* volatile*>(found.slot);
		if(Pool::Owns(current)){ continue; }
		typename Pool::Fn replacement = Pool::Acquire(reinterpret_cast<typename Pool::Fn>(current));
		if(!replacement){ RestorePatches(added); return false; }
		if(!CompareExchangeSlot(found.slot, current, reinterpret_cast<void*>(replacement))){ RestorePatches(added); return false; }
		added.push_back({found.slot, current, reinterpret_cast<void*>(replacement)});
	}
	records.insert(records.end(), added.begin(), added.end());
	return true;
}

// Pin the module containing `address` so exported callbacks outlive any unload.
inline bool PinModuleContaining(const void* address){
	HMODULE pinned = nullptr;
	return GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_PIN,
		reinterpret_cast<LPCWSTR>(address), &pinned) != FALSE;
}

} // namespace gxr::hooking
