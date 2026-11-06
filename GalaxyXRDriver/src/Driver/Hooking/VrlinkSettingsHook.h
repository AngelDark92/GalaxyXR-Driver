#pragma once
// Scoped VRLink read overlay on the shared IVRSettings_003 getters (header only).
//
// VRLink reads some tuning keys (for example automaticBandwidth and
// targetBandwidth) from the shared `driver_vrlink` section through an
// IVRSettings pointer it cached during its own init, so a different interface
// object can never reach those reads. This driver must not persist writes
// into `driver_vrlink` (shared with every streamer), so the four typed getters
// of the shared interface object are detoured instead (documented
// IVRSettings_003 vtable order, resolved by interface version at runtime; no
// addresses, RVAs or signatures):
//
//   answer from the canonical `vrlink_xrvst2ue` section ONLY when all hold:
//     * the call site (_ReturnAddress captured inside the detour itself) is in
//       the exact driver_vrlink.dll module;
//     * the section is exactly `driver_vrlink` and the key is not a lifecycle
//       key (enable, blocked_by_safe_mode, hasBeenRun);
//     * the key is a routed tuning key or an explicit expert entry;
//     * a Steam Link Galaxy XR epoch is open (PROVISIONAL or ADMITTED:
//       CurrentEpoch() != 0), so reads made inside the original Activate
//       already see it; closed / handshake-only / unbound states deny;
//     * the canonical section really holds the key with the requested type
//       (read through the ORIGINAL getter, so there is no recursion).
//   Everything else - other callers, sections, absent values, type mismatch,
//   disconnected or unknown epochs, null error/buffer - runs the exact
//   original getter with the exact original arguments. Setters, removals and
//   the error-name call are never hooked, so nothing is written or persisted.

#include <array>
#include <atomic>
#include <cstdint>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

#include "../GalaxyLinkEpoch.h" // first: defines WIN32_LEAN_AND_MEAN / NOMINMAX before windows.h
#include "openvr_driver.h"
#include "vtablehook.h"
#include "../../Config/VrlinkSettingsRouting.h"

#if defined(_WIN32)
#include <intrin.h>
#endif

namespace gxr {
namespace vrlinksettings {

// IVRSettings_003 vtable order (openvr_driver.h declaration order, no overloads):
// 0 GetSettingsErrorNameFromEnum, 1 SetBool, 2 SetInt32, 3 SetFloat, 4 SetString,
// 5 GetBool, 6 GetInt32, 7 GetFloat, 8 GetString, 9 RemoveSection, 10 RemoveKeyInSection
inline constexpr int kSlotGetBool = 5;
inline constexpr int kSlotGetInt32 = 6;
inline constexpr int kSlotGetFloat = 7;
inline constexpr int kSlotGetString = 8;

using GetBoolFn = bool (*)(vr::IVRSettings*, const char*, const char*, vr::EVRSettingsError*);
using GetInt32Fn = int32_t (*)(vr::IVRSettings*, const char*, const char*, vr::EVRSettingsError*);
using GetFloatFn = float (*)(vr::IVRSettings*, const char*, const char*, vr::EVRSettingsError*);
using GetStringFn = void (*)(vr::IVRSettings*, const char*, const char*, char*, uint32_t, vr::EVRSettingsError*);

struct Entry {
    void** vtable = nullptr;
    GetBoolFn getBool = nullptr;
    GetInt32Fn getInt32 = nullptr;
    GetFloatFn getFloat = nullptr;
    GetStringFn getString = nullptr;
};

struct State {
    static constexpr int kMaxEntries = 4;
    std::array<Entry, kMaxEntries> entries{};
    std::atomic<int> count{ 0 };
    std::mutex installMutex;
    std::mutex expertMutex;
    std::vector<std::string> expertKeys;
    std::mutex reportMutex;
    std::vector<std::string> reported;
    // Test seams: admission defaults to "a Steam Link epoch is open";
    // pin defaults to pinning the module that contains the detours.
    bool (*admitted)() noexcept = nullptr;
    bool (*pin)() = nullptr;
    std::atomic<bool> pinned{ false };
    // Optional first-use observer (never called with a lock held, never logs here).
    void (*observer)(const char* key, const char* type) = nullptr;
};

// Intentionally leaked: a detour may run while the module is being torn down.
inline State& S() noexcept {
    static State* state = new State();
    return *state;
}

inline bool Admitted() noexcept {
    auto& s = S();
    if (s.admitted) return s.admitted();
    // PROVISIONAL or ADMITTED: a module-owned HMD add plus a fresh original
    // xrvst2ue handshake already authenticates the startup reads vrlink makes
    // inside the original Activate (before ConfirmHmd). CurrentEpoch() is 0
    // for unknown / handshake-only / unbound / closed states -> deny.
    return gxr::galaxylink::CurrentEpoch() != 0;
}

// Explicit expert entries are the only non-routed keys that may be overlaid.
// The snapshot has its own short mutex, independent of the driver config lock:
// a getter can run while that lock is held.
inline void SetExpertKeys(const std::vector<std::string>& keys) {
    auto& s = S();
    std::lock_guard<std::mutex> lock(s.expertMutex);
    s.expertKeys = keys;
}

inline bool KeyRouted(const char* key) {
    if (gxr::IsVrlinkTuningKey(key)) return true;
    auto& s = S();
    std::lock_guard<std::mutex> lock(s.expertMutex);
    for (const auto& k : s.expertKeys) if (k == key) return true;
    return false;
}

// Pure decision (the caller address is evidence supplied by the detour).
inline bool ShouldOverlay(const void* caller, const char* section, const char* key) {
    if (!section || !key) return false;
    if (std::strcmp(section, gxr::kVrlinkGlobalSection) != 0) return false;
    if (gxr::IsVrlinkReservedKey(key)) return false;
    if (!Admitted()) return false;
    if (!KeyRouted(key)) return false;
    return gxr::galaxylink::IsVrlinkAddress(caller);
}

inline const Entry* Find(vr::IVRSettings* self) noexcept {
    if (!self) return nullptr;
    void** vtable = *reinterpret_cast<void***>(self);
    auto& s = S();
    const int n = s.count.load(std::memory_order_acquire);
    for (int i = 0; i < n; ++i) if (s.entries[i].vtable == vtable) return &s.entries[i];
    // Same detour reached through an object we did not register (a copied
    // slot): forward to the first recorded original rather than a default.
    return n > 0 ? &s.entries[0] : nullptr;
}

// First hit per key and type only (the list stays a handful of tuning keys).
// The observer runs outside the lock and must not read settings itself.
inline void Report(const char* key, const char* type) {
    auto& s = S();
    if (!s.observer) return;
    const std::string id = std::string(key) + "/" + type;
    {
        std::lock_guard<std::mutex> lock(s.reportMutex);
        for (const auto& seen : s.reported) if (seen == id) return;
        s.reported.push_back(id);
    }
    s.observer(key, type);
}

#if defined(_WIN32)
#define GXR_VRLINK_SETTINGS_CALLER() _ReturnAddress()
#else
#define GXR_VRLINK_SETTINGS_CALLER() __builtin_return_address(0)
#endif

// The caller is captured IN each detour (not in a helper).
inline bool DetourGetBool(vr::IVRSettings* self, const char* section, const char* key, vr::EVRSettingsError* error) {
    const void* caller = GXR_VRLINK_SETTINGS_CALLER();
    const Entry* e = Find(self);
    if (!e) return false;
    if (ShouldOverlay(caller, section, key)) {
        vr::EVRSettingsError overlayError = vr::VRSettingsError_None;
        const bool value = e->getBool(self, gxr::kGalaxyProfileSection, key, &overlayError);
        if (overlayError == vr::VRSettingsError_None) {
            if (error) *error = overlayError;
            Report(key, "bool");
            return value;
        }
    }
    return e->getBool(self, section, key, error);
}

inline int32_t DetourGetInt32(vr::IVRSettings* self, const char* section, const char* key, vr::EVRSettingsError* error) {
    const void* caller = GXR_VRLINK_SETTINGS_CALLER();
    const Entry* e = Find(self);
    if (!e) return 0;
    if (ShouldOverlay(caller, section, key)) {
        vr::EVRSettingsError overlayError = vr::VRSettingsError_None;
        const int32_t value = e->getInt32(self, gxr::kGalaxyProfileSection, key, &overlayError);
        if (overlayError == vr::VRSettingsError_None) {
            if (error) *error = overlayError;
            Report(key, "int32");
            return value;
        }
    }
    return e->getInt32(self, section, key, error);
}

inline float DetourGetFloat(vr::IVRSettings* self, const char* section, const char* key, vr::EVRSettingsError* error) {
    const void* caller = GXR_VRLINK_SETTINGS_CALLER();
    const Entry* e = Find(self);
    if (!e) return 0.0f;
    if (ShouldOverlay(caller, section, key)) {
        vr::EVRSettingsError overlayError = vr::VRSettingsError_None;
        const float value = e->getFloat(self, gxr::kGalaxyProfileSection, key, &overlayError);
        if (overlayError == vr::VRSettingsError_None) {
            if (error) *error = overlayError;
            Report(key, "float");
            return value;
        }
    }
    return e->getFloat(self, section, key, error);
}

inline void DetourGetString(vr::IVRSettings* self, const char* section, const char* key, char* out, uint32_t length, vr::EVRSettingsError* error) {
    const void* caller = GXR_VRLINK_SETTINGS_CALLER();
    const Entry* e = Find(self);
    if (!e) return;
    if (out && length > 0 && ShouldOverlay(caller, section, key)) {
        // Private buffer: a failed or truncated overlay read never clobbers the
        // caller's buffer before the original getter has answered.
        std::vector<char> scratch(length, '\0');
        vr::EVRSettingsError overlayError = vr::VRSettingsError_None;
        e->getString(self, gxr::kGalaxyProfileSection, key, scratch.data(), length, &overlayError);
        if (overlayError == vr::VRSettingsError_None && std::memchr(scratch.data(), '\0', length) != nullptr) {
            std::memcpy(out, scratch.data(), length);
            out[length - 1] = '\0';
            if (error) *error = overlayError;
            Report(key, "string");
            return;
        }
    }
    e->getString(self, section, key, out, length, error);
}

// Compare-and-swap one vtable slot: the slot changes ONLY when it still holds
// `expected`. A hook installed by anyone else in between is never overwritten
// (that would drop its chain), and a failed swap simply reports false.
inline bool PatchSlotIf(void** vtable, int index, void* expected, void* value) {
    void** slot = vtable + index;
    if (*slot != expected) return false;
    const int protection = vtablehook_unprotect(slot);
    if (protection == -1) return false;
#if defined(_WIN32)
    const bool swapped = InterlockedCompareExchangePointer(reinterpret_cast<PVOID volatile*>(slot), value, expected) == expected;
#else
    const bool swapped = __sync_bool_compare_and_swap(slot, expected, value);
#endif
    vtablehook_protect(slot, protection);
    return swapped;
}

// Pins the module that contains the detours (looked up from the detour's own
// address through the OS ownership API, never a constant). Test seam:
// State::pin replaces it. Idempotent; the result is cached only on success.
inline bool EnsurePinned() {
    auto& s = S();
    if (s.pinned.load(std::memory_order_acquire)) return true;
    bool ok = false;
    if (s.pin) {
        ok = s.pin();
    } else {
#if defined(_WIN32)
        HMODULE self = nullptr;
        ok = GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_PIN,
            reinterpret_cast<LPCWSTR>(&DetourGetBool), &self) && self != nullptr;
#else
        ok = true; // no unloadable-module concept in the pure/non-Windows build
#endif
    }
    if (ok) s.pinned.store(true, std::memory_order_release);
    return ok;
}

inline void* DetourFor(int slot) {
    switch (slot) {
        case kSlotGetBool: return reinterpret_cast<void*>(&DetourGetBool);
        case kSlotGetInt32: return reinterpret_cast<void*>(&DetourGetInt32);
        case kSlotGetFloat: return reinterpret_cast<void*>(&DetourGetFloat);
        default: return reinterpret_cast<void*>(&DetourGetString);
    }
}
inline void* OriginalFor(const Entry& e, int slot) {
    switch (slot) {
        case kSlotGetBool: return reinterpret_cast<void*>(e.getBool);
        case kSlotGetInt32: return reinterpret_cast<void*>(e.getInt32);
        case kSlotGetFloat: return reinterpret_cast<void*>(e.getFloat);
        default: return reinterpret_cast<void*>(e.getString);
    }
}
inline constexpr int kSlots[4] = { kSlotGetBool, kSlotGetInt32, kSlotGetFloat, kSlotGetString };

// Idempotent per shared vtable. Returns true when every getter slot is ours.
// Originals (whatever the slot held, including another driver's hook, so the
// chain is preserved) are published BEFORE any slot is patched, so a detour can
// always find the original it must forward to. A slot that changed hands is
// left alone: the result is false and nothing foreign is clobbered.
inline bool Install(vr::IVRSettings* settings) {
    if (!settings) return false;
    auto& s = S();
    std::lock_guard<std::mutex> lock(s.installMutex);
    void** vtable = *reinterpret_cast<void***>(settings);
    if (!vtable) return false;
    const int n = s.count.load(std::memory_order_acquire);
    for (int i = 0; i < n; ++i) {
        if (s.entries[i].vtable != vtable) continue;
        // known vtable: re-arm only slots that still hold the original we
        // restored; a slot replaced by another hook is left as it is
        bool ok = true;
        for (int slot : kSlots) {
            if (vtable[slot] == DetourFor(slot)) continue;
            ok = PatchSlotIf(vtable, slot, OriginalFor(s.entries[i], slot), DetourFor(slot)) && ok;
        }
        return ok;
    }
    if (n >= State::kMaxEntries) return false;
    // Pin THIS module before any slot can point into it: another hook may chain
    // through our detour and outlive our uninstall, so the code must never be
    // unloaded. No pin, no install (fail closed). Independent of every other lane.
    if (!EnsurePinned()) return false;

    Entry entry;
    entry.vtable = vtable;
    entry.getBool = reinterpret_cast<GetBoolFn>(vtable[kSlotGetBool]);
    entry.getInt32 = reinterpret_cast<GetInt32Fn>(vtable[kSlotGetInt32]);
    entry.getFloat = reinterpret_cast<GetFloatFn>(vtable[kSlotGetFloat]);
    entry.getString = reinterpret_cast<GetStringFn>(vtable[kSlotGetString]);
    if (!entry.getBool || !entry.getInt32 || !entry.getFloat || !entry.getString) return false;
    s.entries[n] = entry;
    s.count.store(n + 1, std::memory_order_release);

    bool ok = true;
    for (int slot : kSlots) ok = PatchSlotIf(vtable, slot, OriginalFor(entry, slot), DetourFor(slot)) && ok;
    if (!ok) {
        // undo only what we swapped in; anything else was replaced by someone else
        for (int slot : kSlots) PatchSlotIf(vtable, slot, DetourFor(slot), OriginalFor(entry, slot));
    }
    return ok;
}

// Restores every getter slot that still holds our detour. A slot another hook
// replaced (and chained through us) is left: it keeps forwarding to the
// recorded original, which stays valid for the life of the process.
inline void Uninstall() {
    auto& s = S();
    std::lock_guard<std::mutex> lock(s.installMutex);
    const int n = s.count.load(std::memory_order_acquire);
    for (int i = 0; i < n; ++i) {
        const Entry& e = s.entries[i];
        if (!e.vtable) continue;
        for (int slot : kSlots) PatchSlotIf(e.vtable, slot, DetourFor(slot), OriginalFor(e, slot));
    }
}
} // namespace vrlinksettings
} // namespace gxr
