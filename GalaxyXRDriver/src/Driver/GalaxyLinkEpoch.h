#pragma once
// Steam Link Galaxy XR ownership epoch (header only).
//
// The only target is the Steam Link Galaxy XR client whose ORIGINAL handshake
// model is exactly "xrvst2ue", streamed through driver_vrlink.dll. Any other
// headset, streamer or Steam Link model is foreign and must pass through
// untouched. Admission is evidence based; there is NO GPU / PID / geometry /
// cosmetic / nativeIdentity / canary gate and no stamped identity can admit.
//
// Sequence (one epoch):
//   1. vrlink formats "New Session detected; Invalidating.\n"   (ObserveLog)
//   2. vrlink formats "ReceivedHMDStaticProps. Model Number: %s, Serial
//      Number: %s (%d)" with the ORIGINAL model "xrvst2ue"       (ObserveLog)
//   3. vrlink calls IVRServerDriverHost::TrackedDeviceAdded(HMD); the detour
//      passes its own _ReturnAddress() and the original driver (BeginHmd).
//      Opens a PROVISIONAL epoch only with a fresh handshake, a caller inside
//      the exact driver_vrlink.dll module and vtable[0] inside that module.
//   4. Activate runs; the ownership shim binds the device index (BindHmd)
//      then reports Activate success + Prop_ParentDriver_Uint64 ==
//      GetDriverHandle("vrlink") + original-model corroboration (ConfirmHmd).
//   5. A pose with bDeviceIsConnected == false, deactivate or cleanup closes
//      the epoch synchronously (ObservePose / CloseIfEpoch / Close). A
//      reconnect needs a FRESH session marker + handshake: nothing is adopted
//      from a stale epoch.
//
// Thread safety: transitions take one short mutex; every hot-path query reads
// atomics only. Nothing in this header logs, allocates after construction on
// the query paths, or calls back into a host/driver, so ObserveLog is safe to
// call from inside a CRT formatting shim without recursion.
//
// The pure state machine (Tracker) has no Windows dependency; module checks
// are injected through Tracker::moduleValidator so unit tests run anywhere.

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <mutex>

#if defined(_WIN32) && !defined(GXR_GALAXYLINK_PURE)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

namespace gxr {
namespace galaxylink {

inline constexpr const char* kSessionFormat = "New Session detected; Invalidating.\n";
inline constexpr const char* kPropsFormat = "ReceivedHMDStaticProps. Model Number: %s, Serial Number: %s (%d)";
inline constexpr const char* kOriginalModel = "xrvst2ue";
inline constexpr const char* kVrlinkModule = "driver_vrlink.dll";
inline constexpr uint32_t kInvalidDevice = 0xFFFFFFFFu;

enum class TargetState : uint8_t { Closed = 0, Provisional = 1, Admitted = 2 };

// Pure, injectable state machine. All members are private to the mutex except
// the atomics read by the lock-free queries.
class Tracker {
public:
    // Returns true when `address` lies inside the exact driver_vrlink.dll image.
    // Null means "never valid" (non-Windows tests install their own).
    using AddressValidator = bool (*)(const void* address) noexcept;
    // Reads vtable[0] of an object; null when unreadable. Injectable for tests.
    using VtableReader = const void* (*)(void* object) noexcept;

    AddressValidator addressValidator = nullptr;
    VtableReader vtableReader = nullptr;

    // ---- log observation -------------------------------------------------
    void ObserveLog(const char* format, const char* formatted, size_t length) noexcept {
        if (!format) return;
        if (std::strcmp(format, kSessionFormat) == 0) {
            std::lock_guard<std::mutex> lock(mutex_);
            // A new session invalidates everything bound to the previous one.
            // The admitted HMD OBJECT is remembered (not adopted): it can only
            // return through RebindHmd with this session's fresh handshake.
            CloseLocked(true);
            sessionSeen_ = true;
            return;
        }
        if (std::strcmp(format, kPropsFormat) != 0 || !formatted) return;

        char model[64] = {};
        const bool parsed = ParseModel(formatted, length, model, sizeof(model));
        const bool exact = parsed && std::strcmp(model, kOriginalModel) == 0;

        std::lock_guard<std::mutex> lock(mutex_);
        if (!sessionSeen_ || !exact) {
            // Props without a session marker, or a different/unknown model:
            // nothing may be adopted, any open target is revoked and no
            // object stays eligible for a rebind.
            CloseLocked(false);
            return;
        }
        // Same exact model repeated inside the same session: keep state as is
        // (never repeatedly revoke a valid handshake). The first one arms it.
        if (!handshakeSeen_) {
            handshakeSeen_ = true;
            handshakeAvailable_ = true;
        }
    }

    // ---- target lifecycle --------------------------------------------------
    bool BeginHmd(void* originalDriver, const void* caller) noexcept {
        // Module evidence is gathered before taking the lock; it never calls
        // back into this tracker.
        const bool callerOk = caller && IsVrlinkAddress(caller);
        const void* slot0 = originalDriver && vtableReader ? vtableReader(originalDriver) : nullptr;
        const bool vtableOk = slot0 && IsVrlinkAddress(slot0);
        return BeginHmdValidated(originalDriver, callerOk && vtableOk);
    }

    bool BeginHmdValidated(void* originalDriver, bool moduleOwned) noexcept {
        std::lock_guard<std::mutex> lock(mutex_);
        if (!moduleOwned || !originalDriver) return false;
        if (state_ != TargetState::Closed) return false; // never steal an open target
        if (!sessionSeen_ || !handshakeSeen_ || !handshakeAvailable_) return false;
        handshakeAvailable_ = false; // one handshake admits at most one HMD add
        driver_ = originalDriver;
        device_ = kInvalidDevice;
        state_ = TargetState::Provisional;
        // a new HMD object starts a new lineage; nothing retained survives it
        retained_ = Retained();
        retainedDevice_.store(kInvalidDevice, std::memory_order_release);
        lineage_.store(++lineageCounter_, std::memory_order_release);
        openFlag_.store(true, std::memory_order_release);
        epoch_.store(++generation_, std::memory_order_release); // published LAST: 0 never shows an old generation
        return true;
    }

    // Reconnect of the SAME HMD object (no new TrackedDeviceAdded): called from
    // the HMD's pose stream on its connected-up edge. Admits directly, under a
    // brand-new epoch and the SAME lineage (so only wrappers of that object
    // wake up), only when ALL hold:
    //   * the target is closed and this device index is the retained one;
    //   * the pose is connected (live) and `caller` is inside driver_vrlink.dll;
    //   * the parent-driver evidence (`parentOwned`) was verified by the caller;
    //   * a FRESH session marker + exact xrvst2ue handshake were observed since
    //     the disconnect (spent here, so it cannot admit twice).
    // Anything else leaves the target closed (log "restart required" upstream).
    bool RebindHmd(uint32_t deviceIndex, const void* caller, bool connected, bool parentOwned) noexcept {
        const bool callerOk = caller && IsVrlinkAddress(caller);
        std::lock_guard<std::mutex> lock(mutex_);
        if (!connected || !callerOk || !parentOwned || deviceIndex == kInvalidDevice) return false;
        if (state_ != TargetState::Closed || retained_.device != deviceIndex || !retained_.driver) return false;
        if (!sessionSeen_ || !handshakeSeen_ || !handshakeAvailable_) return false;
        handshakeAvailable_ = false;
        driver_ = retained_.driver;
        device_ = deviceIndex;
        lineage_.store(retained_.lineage, std::memory_order_release);
        retained_ = Retained();
        retainedDevice_.store(kInvalidDevice, std::memory_order_release);
        state_ = TargetState::Admitted;
        openFlag_.store(true, std::memory_order_release);
        boundIndex_.store(deviceIndex, std::memory_order_release);
        admittedIndex_.store(deviceIndex, std::memory_order_release);
        epoch_.store(++generation_, std::memory_order_release); // published LAST: 0 never shows an old generation
        return true;
    }

    // Cheap pre-check for the pose hot path: true only when a rebind of this
    // device could possibly succeed (closed, retained index, connected-up,
    // fresh handshake). The caller then gathers the module/parent evidence.
    bool CanRebind(uint32_t deviceIndex, bool connected) const noexcept {
        if (!connected || deviceIndex == kInvalidDevice) return false;
        if (retainedDevice_.load(std::memory_order_acquire) != deviceIndex) return false;
        if (openFlag_.load(std::memory_order_acquire)) return false;
        std::lock_guard<std::mutex> lock(mutex_);
        return state_ == TargetState::Closed && retained_.device == deviceIndex
            && sessionSeen_ && handshakeSeen_ && handshakeAvailable_;
    }

    // Bind the device index before any capability work. Does not admit.
    void BindHmd(uint32_t deviceIndex) noexcept {
        std::lock_guard<std::mutex> lock(mutex_);
        if (state_ == TargetState::Provisional) {
            device_ = deviceIndex;
            boundIndex_.store(deviceIndex, std::memory_order_release);
        }
    }

    // `successfulAndOwned` = Activate succeeded AND Prop_ParentDriver_Uint64
    // read succeeded and equals the valid vrlink driver handle AND the
    // original (pre-stamp) model corroborates. A failure closes the epoch.
    void ConfirmHmd(uint32_t deviceIndex, bool successfulAndOwned) noexcept {
        std::lock_guard<std::mutex> lock(mutex_);
        if (state_ != TargetState::Provisional) return;
        if (!successfulAndOwned || deviceIndex == kInvalidDevice
                || (device_ != kInvalidDevice && device_ != deviceIndex)) {
            CloseLocked(false);
            return;
        }
        device_ = deviceIndex;
        state_ = TargetState::Admitted;
        boundIndex_.store(deviceIndex, std::memory_order_release);
        admittedIndex_.store(deviceIndex, std::memory_order_release);
    }

    // Called for every pose of any device. Only the admitted target's
    // disconnected pose matters; it closes BEFORE the caller touches the pose.
    void ObservePose(uint32_t deviceIndex, bool connected) noexcept {
        if (connected) return;
        if (admittedIndex_.load(std::memory_order_acquire) != deviceIndex) return;
        std::lock_guard<std::mutex> lock(mutex_);
        // the HMD object stays registered with SteamVR: remember it for a
        // fresh-evidence RebindHmd, but admit nothing now
        if (state_ == TargetState::Admitted && device_ == deviceIndex) CloseLocked(true);
    }

    void Close() noexcept {
        std::lock_guard<std::mutex> lock(mutex_);
        CloseLocked(false);
    }

    void CloseIfEpoch(uint64_t epoch) noexcept {
        std::lock_guard<std::mutex> lock(mutex_);
        if (epoch != 0 && epoch_.load(std::memory_order_acquire) == epoch && state_ != TargetState::Closed) {
            CloseLocked(false);
        }
    }

    // Deactivate of an HMD object: closes the target only while that object's
    // lineage is the current one (a newer HMD object is untouched), and the
    // object can never be rebound again.
    void CloseIfLineage(uint64_t lineage) noexcept {
        if (lineage == 0) return;
        std::lock_guard<std::mutex> lock(mutex_);
        if (retained_.lineage == lineage) {
            retained_ = Retained();
            retainedDevice_.store(kInvalidDevice, std::memory_order_release);
        }
        if (lineage_.load(std::memory_order_acquire) == lineage && state_ != TargetState::Closed) {
            CloseLocked(false);
        }
    }

    // ---- lock-free queries -------------------------------------------------
    uint64_t CurrentEpoch() const noexcept { return epoch_.load(std::memory_order_acquire); }
    bool TargetOpen() const noexcept { return openFlag_.load(std::memory_order_acquire); }
    uint32_t AdmittedDevice() const noexcept { return admittedIndex_.load(std::memory_order_acquire); }
    // Device index bound at Pre-Activate (provisional) or admitted; invalid when closed.
    uint32_t TargetDevice() const noexcept { return boundIndex_.load(std::memory_order_acquire); }
    bool IsAdmittedDevice(uint32_t deviceIndex) const noexcept {
        return deviceIndex != kInvalidDevice && admittedIndex_.load(std::memory_order_acquire) == deviceIndex;
    }
    // True only while `epoch` is the current epoch AND it is admitted.
    bool IsAdmittedEpoch(uint64_t epoch) const noexcept {
        return epoch != 0 && epoch_.load(std::memory_order_acquire) == epoch
            && admittedIndex_.load(std::memory_order_acquire) != kInvalidDevice;
    }
    // Provisional or admitted for this epoch (wrap decisions made before Activate).
    bool IsOpenEpoch(uint64_t epoch) const noexcept {
        return epoch != 0 && epoch_.load(std::memory_order_acquire) == epoch
            && openFlag_.load(std::memory_order_acquire);
    }
    // Lineage = the identity of one HMD OBJECT. It is stable across a same-object
    // reconnect (RebindHmd) while every epoch changes; wrappers created for that
    // object gate on it so they can wake up again without ever adopting state of
    // another HMD object.
    uint64_t CurrentLineage() const noexcept { return lineage_.load(std::memory_order_acquire); }
    bool IsAdmittedLineage(uint64_t lineage) const noexcept {
        return lineage != 0 && lineage_.load(std::memory_order_acquire) == lineage
            && admittedIndex_.load(std::memory_order_acquire) != kInvalidDevice;
    }
    bool IsOpenLineage(uint64_t lineage) const noexcept {
        return lineage != 0 && lineage_.load(std::memory_order_acquire) == lineage
            && openFlag_.load(std::memory_order_acquire);
    }
    // Device index of the retained (closed, rebind-eligible) HMD object, or invalid.
    uint32_t RetainedDevice() const noexcept { return retainedDevice_.load(std::memory_order_acquire); }
    bool IsVrlinkAddress(const void* address) const noexcept {
        return address && addressValidator && addressValidator(address);
    }
    TargetState State() const noexcept {
        std::lock_guard<std::mutex> lock(mutex_);
        return state_;
    }
    // Test / diagnostics view of the handshake gate.
    bool HandshakeArmed() const noexcept {
        std::lock_guard<std::mutex> lock(mutex_);
        return sessionSeen_ && handshakeSeen_ && handshakeAvailable_;
    }

    // Extract "Model Number: <model>, Serial Number:" from a formatted line.
    static bool ParseModel(const char* formatted, size_t length, char* out, size_t outSize) noexcept {
        static const char kPrefix[] = "ReceivedHMDStaticProps. Model Number: ";
        static const char kMid[] = ", Serial Number: ";
        const size_t prefixLen = sizeof(kPrefix) - 1;
        const size_t midLen = sizeof(kMid) - 1;
        if (!formatted || !out || outSize == 0) return false;
        if (length < prefixLen || std::memcmp(formatted, kPrefix, prefixLen) != 0) return false;
        // an embedded NUL inside the reported length means the line is not the
        // plain formatted text we expect
        if (std::memchr(formatted, '\0', length) != nullptr) return false;
        // Exactly ONE separator in the whole line. A model or serial that
        // itself contains ", Serial Number: " is ambiguous (the first
        // delimiter could be forged): fail closed, never admit.
        size_t first = 0;
        bool found = false;
        for (size_t i = prefixLen; i + midLen <= length; ++i) {
            if (std::memcmp(formatted + i, kMid, midLen) == 0) {
                if (found) return false;
                found = true;
                first = i;
            }
        }
        if (!found) return false;
        const size_t n = first - prefixLen;
        if (n == 0 || n >= outSize) return false;
        std::memcpy(out, formatted + prefixLen, n);
        out[n] = '\0';
        return true;
    }

private:
    struct Retained {
        void* driver = nullptr;
        uint32_t device = kInvalidDevice;
        uint64_t lineage = 0;
    };

    // `retainObject`: remember the ADMITTED HMD object for a later fresh-evidence
    // rebind. Only an admitted target is ever retained; every other close (failed
    // confirm, model change, deactivate, cleanup) forgets the object.
    void CloseLocked(bool retainObject) noexcept {
        // unpublish FIRST: CurrentEpoch() is 0 whenever no provisional/admitted target exists
        epoch_.store(0, std::memory_order_release);
        const bool wasOpen = state_ != TargetState::Closed;
        if (wasOpen && retainObject && state_ == TargetState::Admitted && device_ != kInvalidDevice) {
            retained_.driver = driver_;
            retained_.device = device_;
            retained_.lineage = lineage_.load(std::memory_order_acquire);
            retainedDevice_.store(device_, std::memory_order_release);
        } else if (!retainObject) {
            retained_ = Retained();
            retainedDevice_.store(kInvalidDevice, std::memory_order_release);
        }
        state_ = TargetState::Closed;
        driver_ = nullptr;
        device_ = kInvalidDevice;
        sessionSeen_ = false;
        handshakeSeen_ = false;
        handshakeAvailable_ = false;
        admittedIndex_.store(kInvalidDevice, std::memory_order_release);
        boundIndex_.store(kInvalidDevice, std::memory_order_release);
        openFlag_.store(false, std::memory_order_release);
    }

    mutable std::mutex mutex_;
    TargetState state_ = TargetState::Closed;
    void* driver_ = nullptr;
    uint32_t device_ = kInvalidDevice;
    bool sessionSeen_ = false;
    bool handshakeSeen_ = false;
    bool handshakeAvailable_ = false;
    Retained retained_;
    uint64_t lineageCounter_ = 0;
    std::atomic<uint64_t> lineage_{ 0 };
    std::atomic<uint32_t> retainedDevice_{ kInvalidDevice };
    uint64_t generation_ = 0;            // internal counter, never published directly
    std::atomic<uint64_t> epoch_{ 0 };   // PUBLISHED epoch: 0 = closed, else the open generation
    std::atomic<bool> openFlag_{ false };
    std::atomic<uint32_t> admittedIndex_{ kInvalidDevice };
    std::atomic<uint32_t> boundIndex_{ kInvalidDevice };
};

namespace detail {
#if defined(_WIN32) && !defined(GXR_GALAXYLINK_PURE)
// Exact module: GetModuleHandleW(driver_vrlink.dll) must own the address.
inline bool AddressInVrlinkModule(const void* address) noexcept {
    HMODULE vrlink = GetModuleHandleW(L"driver_vrlink.dll");
    if (!vrlink || !address) return false;
    HMODULE owner = nullptr;
    return GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
        reinterpret_cast<LPCWSTR>(address), &owner) && owner == vrlink;
}
inline const void* ReadVtableSlot0(void* object) noexcept {
    if (!object) return nullptr;
    void** vtable = *reinterpret_cast<void***>(object);
    return vtable ? vtable[0] : nullptr;
}
#else
inline bool AddressInVrlinkModule(const void*) noexcept { return false; }
inline const void* ReadVtableSlot0(void* object) noexcept {
    if (!object) return nullptr;
    void** vtable = *reinterpret_cast<void***>(object);
    return vtable ? vtable[0] : nullptr;
}
#endif

// Intentionally leaked: callers may run during process/DLL teardown.
inline Tracker& Global() noexcept {
    static Tracker* tracker = [] {
        Tracker* t = new Tracker();
        t->addressValidator = &AddressInVrlinkModule;
        t->vtableReader = &ReadVtableSlot0;
        return t;
    }();
    return *tracker;
}
} // namespace detail

// ---- process-wide API (stable contract shared with the NVENC lane) ----------
inline uint64_t CurrentEpoch() noexcept { return detail::Global().CurrentEpoch(); }
inline void ObserveLog(const char* format, const char* formatted, size_t length) noexcept {
    detail::Global().ObserveLog(format, formatted, length);
}
inline bool BeginHmd(void* originalDriver, const void* caller) noexcept {
    return detail::Global().BeginHmd(originalDriver, caller);
}
inline void ConfirmHmd(uint32_t deviceIndex, bool successfulAndOwned) noexcept {
    detail::Global().ConfirmHmd(deviceIndex, successfulAndOwned);
}
namespace detail {
// Poses this driver publishes itself (for example the forceTracking initial
// pose, which is always "disconnected") re-enter the pose detour on the same
// thread; they are not evidence about the stream and must never close an epoch.
inline int& OwnPoseDepth() noexcept {
    static thread_local int depth = 0;
    return depth;
}
} // namespace detail

struct OwnPoseScope {
    OwnPoseScope() noexcept { ++detail::OwnPoseDepth(); }
    ~OwnPoseScope() { --detail::OwnPoseDepth(); }
    OwnPoseScope(const OwnPoseScope&) = delete;
    OwnPoseScope& operator=(const OwnPoseScope&) = delete;
};

inline void ObservePose(uint32_t deviceIndex, bool connected) noexcept {
    if (detail::OwnPoseDepth() > 0) return;
    detail::Global().ObservePose(deviceIndex, connected);
}
inline void Close() noexcept { detail::Global().Close(); }
inline bool IsVrlinkAddress(const void* address) noexcept { return detail::Global().IsVrlinkAddress(address); }
inline bool IsAdmittedDevice(uint32_t deviceIndex) noexcept { return detail::Global().IsAdmittedDevice(deviceIndex); }

// ---- additions (reported to the parent) ---------------------------------------
inline void BindHmd(uint32_t deviceIndex) noexcept { detail::Global().BindHmd(deviceIndex); }
inline void CloseIfEpoch(uint64_t epoch) noexcept { detail::Global().CloseIfEpoch(epoch); }
inline bool TargetOpen() noexcept { return detail::Global().TargetOpen(); }
inline uint32_t AdmittedDevice() noexcept { return detail::Global().AdmittedDevice(); }
inline uint32_t TargetDevice() noexcept { return detail::Global().TargetDevice(); }
inline bool IsAdmittedEpoch(uint64_t epoch) noexcept { return detail::Global().IsAdmittedEpoch(epoch); }
inline bool IsOpenEpoch(uint64_t epoch) noexcept { return detail::Global().IsOpenEpoch(epoch); }
// Same-object reconnect support (lineage = identity of one HMD object).
inline uint64_t CurrentLineage() noexcept { return detail::Global().CurrentLineage(); }
inline bool IsAdmittedLineage(uint64_t lineage) noexcept { return detail::Global().IsAdmittedLineage(lineage); }
inline bool IsOpenLineage(uint64_t lineage) noexcept { return detail::Global().IsOpenLineage(lineage); }
inline void CloseIfLineage(uint64_t lineage) noexcept { detail::Global().CloseIfLineage(lineage); }
inline uint32_t RetainedDevice() noexcept { return detail::Global().RetainedDevice(); }
inline bool CanRebind(uint32_t deviceIndex, bool connected) noexcept { return detail::Global().CanRebind(deviceIndex, connected); }
inline bool RebindHmd(uint32_t deviceIndex, const void* caller, bool connected, bool parentOwned) noexcept {
    return detail::Global().RebindHmd(deviceIndex, caller, connected, parentOwned);
}

} // namespace galaxylink
} // namespace gxr
