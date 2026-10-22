#define NOMINMAX
#include "VrlinkTap.h"
#include "DriverLog.h"
#include "../../../ThirdParty/minhook/include/MinHook.h"
#include <chrono>
#include <cstring>

// ============================================================================
// VrlinkTap implementation. See VrlinkTap.h for the pinned-gate contract and
// the derivation evidence (brief 11-W2B-HOST-VRLINKTAP, 2026-10-17).
// ============================================================================

struct VrlinkTapShims {
	// MinHook trampoline: the relocated ORIGINAL impl. vrlink's publishes keep
	// their exact behavior through it; VrlinkTap's own publishes ride it too
	// (identical code path to what vrlink itself calls).
	static int (__fastcall *origUpdateValue)(void* vts, unsigned int id, const void* value,
		unsigned int size, unsigned char flag);

	// THE one lifecycle hook on Valve code. Pure capture + passthrough: the
	// newest call's rcx is the live value-transport `this` (vrlink publishes
	// through this impl from 32 audited call sites); everything else forwards
	// byte-identically.
	static int __fastcall UpdateValueTap(void* vts, unsigned int id, const void* value,
		unsigned int size, unsigned char flag);
};

int (__fastcall *VrlinkTapShims::origUpdateValue)(void* vts, unsigned int id, const void* value,
	unsigned int size, unsigned char flag) = nullptr;

int __fastcall VrlinkTapShims::UpdateValueTap(void* vts, unsigned int id, const void* value,
	unsigned int size, unsigned char flag){
	VrlinkTap::Get().OnVrlinkPublish(vts);
	return origUpdateValue(vts, id, value, size, flag);
}

namespace {
double NowVtSeconds(){
	return std::chrono::duration_cast<std::chrono::microseconds>(
		std::chrono::steady_clock::now().time_since_epoch()).count() / 1000000.0;
}

// 2026-10-21 (owner directive): half rate is retired. The stored setting is kept
// untouched, but this build never publishes carrier 2 - a stored 1 applies as
// late-frames-only, exactly like every unknown stored value. Flip this constant
// (and the client's matching flag) to revive; see Docs/RetiredHalfRateASW.md.
constexpr bool kHalfRateRetired = true;

// Carrier value from the CURRENT stored pair (brief C): 0 = off, 1 = late
// frames only, 2 = half rate. The stored setting is 0-based (spacewarpMode:
// 0 = late frames only — the default and every unknown value — 1 = half rate).
uint32_t EncodeCarrierValue(bool enabled, int mode){
	return enabled ? ((mode == 1 && !kHalfRateRetired) ? 2u : 1u) : 0u;
}

// PE-header sanity for the bounds gate: e_lfanew beyond this cannot be a real
// header (0x3C..0x200 in practice) and stays well inside any mapped image.
constexpr LONG kNtHeaderOffsetLimit = 0x10000;

// Page-granular readability probe, so a bogus module base cannot fault the
// bounds gate itself (an access violation here would still crash vrserver).
bool IsReadableRange(const void* address, size_t bytes){
	if(address == nullptr || bytes == 0){ return false; }
	const auto* cursor = static_cast<const unsigned char*>(address);
	const auto* const end = cursor + bytes;
	while(cursor < end){
		MEMORY_BASIC_INFORMATION info = {};
		if(VirtualQuery(cursor, &info, sizeof(info)) != sizeof(info)){ return false; }
		if(info.State != MEM_COMMIT || (info.Protect & (PAGE_NOACCESS | PAGE_GUARD)) != 0){ return false; }
		cursor = static_cast<const unsigned char*>(info.BaseAddress) + info.RegionSize;
	}
	return true;
}

// SEH isolation for the native publish: no C++ unwinding objects in this
// frame. A torn-down session (stale capture) must NOT crash vrserver — it is
// a failed publish, retried on the next hot-reload SetConfig.
int CallUpdateValue(void* vts, unsigned int id, const void* value, unsigned int size, unsigned char flag){
	__try{
		return VrlinkTapShims::origUpdateValue(vts, id, value, size, flag);
	}
	__except(EXCEPTION_EXECUTE_HANDLER){
		return -1; // faulted: caller latches "waiting" / pending off
	}
}
}

void VrlinkTap::OnVrlinkPublish(void* vts){
	if(!vts){ return; }
	void* previous = capturedVts.exchange(vts, std::memory_order_acq_rel);
	if(previous == nullptr){
		DriverLog("VrlinkTap: value-transport this captured (0x%p) — spacewarp publishes possible", vts);
	} else if(previous != vts){
		// 2026-10-17 add-feature: a NEW transport instance means a fresh stream
		// connection (vrserver restart / reconnect). The previous holder died
		// with its session, so the value delivered on THIS connection is
		// unknown: drop the delivered-value latch and let PublishDesired()
		// re-deliver the current desired value now, instead of waiting for a
		// manual settings reload. (A stale "on" here would be a UI lie — the
		// carrier value is gone.)
		{
			std::lock_guard<std::mutex> stateGuard(stateLock);
			publishedValue = 0;
			havePublished = false;
		}
		DriverLog("VrlinkTap: value-transport instance changed (0x%p -> 0x%p) — republishing on the fresh connection", previous, vts);
		PublishDesired();
		return;
	}
	// Pending-publish retry on vrlink's own publish cadence: PublishDesired()
	// re-derives the wanted value from the CURRENT state under the lock, so a
	// pending enable can never overwrite a later explicit Off (and a pending
	// Off retries here too). Cheap: this locked fast path exits when the
	// carrier already matches. (Never touches Valve state; forwards nothing.)
	bool pendingPublish;
	{
		std::lock_guard<std::mutex> stateGuard(stateLock);
		const uint32_t want = EncodeCarrierValue(enabled, mode);
		pendingPublish = !failedPermanently.load(std::memory_order_relaxed)
			&& installed.load(std::memory_order_relaxed)
			&& (VrlinkTapShims::origUpdateValue != nullptr)
			&& (havePublished ? (want != publishedValue) : (want != 0u));
	}
	if(pendingPublish){ PublishDesired(); }
}

VrlinkTap& VrlinkTap::Get(){
	static VrlinkTap instance;
	return instance;
}

const char* VrlinkTap::StatusString(bool enabled, bool published){
	// pinned seam enum (brief 11-W2B; brief 12-W2C consumes verbatim)
	return !enabled ? "off" : (published ? "on" : "waiting");
}

void VrlinkTap::SetConfig(bool enable, int mode){
	{
		std::lock_guard<std::mutex> stateGuard(stateLock);
		enabled = enable;
		this->mode = mode;
	}
	if(enable){
		TryInstall();
	}
	// publish the CURRENT desired value (never a captured request): a pending
	// enable that is superseded by a later explicit Off simply publishes 0.
	PublishDesired();
}

void VrlinkTap::SetConfig(bool enable){
	// Legacy boolean-only caller (a test harness or any settings path that does
	// not carry the mode yet): the default stored mode (0 = late frames only)
	// keeps the historical carrier value 0x48=1.
	SetConfig(enable, 0);
}

void VrlinkTap::TryInstall(){
	std::lock_guard<std::mutex> guard(installationLock);
	{
		std::lock_guard<std::mutex> stateGuard(stateLock);
		if(!enabled){ return; }
	}
	if(installed.load(std::memory_order_relaxed) || failedPermanently.load(std::memory_order_relaxed)){ return; }
	double now = NowVtSeconds();
	if(now - lastAttempt < 1.0){ return; }
	lastAttempt = now;
	// resolve WITHOUT loading: driver_vrlink.dll is Valve's host driver, loaded
	// into vrserver by Steam itself; never LoadLibrary it from here.
	HMODULE module = GetModuleHandleA("driver_vrlink.dll");
	if(!module){
		static int misses = 0;
		if(++misses > 10){
			failedPermanently.store(true);
			DriverLog("VrlinkTap: driver_vrlink.dll not loaded — Steam Link host driver absent, tap idle");
		}
		return;
	}
	// fail-CLOSED gate (2026-10-17; bounds-hardened 2026-10-20): the module must
	// carry a parseable PE image with BOTH pinned 16-byte windows inside
	// SizeOfImage before anything is memcmp'd or hooked. A SteamVR update, the
	// wrong module, or a bogus module base -> observe-only (status "waiting"),
	// stock stream; the gate never reads outside the mapped image.
	const auto* base = static_cast<const unsigned char*>(static_cast<const void*>(module));
	if(!IsReadableRange(base, sizeof(IMAGE_DOS_HEADER))){
		failedPermanently.store(true);
		DriverLog("VrlinkTap: image-bounds check failed on driver_vrlink.dll (module base 0x%p is not a readable DOS header) — spacewarp stays observe-only (fail-closed), stream untouched",
			static_cast<const void*>(base));
		return;
	}
	const auto* dos = reinterpret_cast<const IMAGE_DOS_HEADER*>(static_cast<const void*>(base));
	if(dos->e_magic != IMAGE_DOS_SIGNATURE){
		failedPermanently.store(true);
		DriverLog("VrlinkTap: image-bounds check failed on driver_vrlink.dll (bad DOS signature 0x%04x at module base) — spacewarp stays observe-only (fail-closed), stream untouched",
			static_cast<unsigned int>(dos->e_magic));
		return;
	}
	const LONG ntOffset = dos->e_lfanew;
	if(ntOffset < static_cast<LONG>(sizeof(IMAGE_DOS_HEADER)) || ntOffset > kNtHeaderOffsetLimit
		|| !IsReadableRange(base + ntOffset, sizeof(IMAGE_NT_HEADERS))){
		failedPermanently.store(true);
		DriverLog("VrlinkTap: image-bounds check failed on driver_vrlink.dll (e_lfanew 0x%lx is not a readable NT header) — spacewarp stays observe-only (fail-closed), stream untouched",
			static_cast<unsigned long>(ntOffset));
		return;
	}
	const auto* nt = reinterpret_cast<const IMAGE_NT_HEADERS*>(static_cast<const void*>(base + ntOffset));
	if(nt->Signature != IMAGE_NT_SIGNATURE){
		failedPermanently.store(true);
		DriverLog("VrlinkTap: image-bounds check failed on driver_vrlink.dll (bad NT signature 0x%08lx) — spacewarp stays observe-only (fail-closed), stream untouched",
			static_cast<unsigned long>(nt->Signature));
		return;
	}
	const DWORD64 imageSize = static_cast<DWORD64>(nt->OptionalHeader.SizeOfImage);
	const DWORD64 implEnd = static_cast<DWORD64>(VrlinkTapPin::kImplRva) + sizeof(VrlinkTapPin::kImplPin);
	const DWORD64 workerEnd = static_cast<DWORD64>(VrlinkTapPin::kWorkerRva) + sizeof(VrlinkTapPin::kWorkerPin);
	if(implEnd > imageSize || workerEnd > imageSize){
		failedPermanently.store(true);
		DriverLog("VrlinkTap: image-bounds check failed on driver_vrlink.dll (impl end 0x%llx / worker end 0x%llx beyond SizeOfImage 0x%llx) — spacewarp stays observe-only (fail-closed), stream untouched",
			static_cast<unsigned long long>(implEnd), static_cast<unsigned long long>(workerEnd),
			static_cast<unsigned long long>(imageSize));
		return;
	}
	if(memcmp(base + VrlinkTapPin::kImplRva, VrlinkTapPin::kImplPin, sizeof(VrlinkTapPin::kImplPin)) != 0
		|| memcmp(base + VrlinkTapPin::kWorkerRva, VrlinkTapPin::kWorkerPin, sizeof(VrlinkTapPin::kWorkerPin)) != 0){
		failedPermanently.store(true);
		DriverLog("VrlinkTap: impl pin mismatch on driver_vrlink.dll — spacewarp stays observe-only (fail-closed), stream untouched");
		return;
	}
	void* target = static_cast<void*>(static_cast<unsigned char*>(static_cast<void*>(module)) + VrlinkTapPin::kImplRva);
	// MinHook may or may not have been initialised by another module yet
	// (NvencTap shares the runtime — tolerate MH_ERROR_ALREADY_INITIALIZED)
	MH_STATUS mi = MH_Initialize();
	if(mi != MH_OK && mi != MH_ERROR_ALREADY_INITIALIZED){
		failedPermanently.store(true);
		DriverLog("VrlinkTap: MH_Initialize failed (%d)", (int)mi);
		return;
	}
	MH_STATUS mh = MH_CreateHook(target, (void*)&VrlinkTapShims::UpdateValueTap, (void**)&VrlinkTapShims::origUpdateValue);
	if(mh != MH_OK && mh != MH_ERROR_ALREADY_CREATED){
		failedPermanently.store(true);
		DriverLog("VrlinkTap: MH_CreateHook failed (%d)", (int)mh);
		return;
	}
	if(MH_EnableHook(target) != MH_OK){
		failedPermanently.store(true);
		DriverLog("VrlinkTap: MH_EnableHook failed");
		return;
	}
	installed.store(true);
	DriverLog("VrlinkTap: hooked UpdateValue impl (rva 0x%x on driver_vrlink.dll) — capture+passthrough; spacewarp publishes ride the trampoline (id 0x48)", VrlinkTapPin::kImplRva);
}

void VrlinkTap::PublishDesired(){
	std::lock_guard<std::mutex> stateGuard(stateLock);
	// The wanted value comes from the CURRENT stored pair on every call, so a
	// pending enable can never overwrite a later explicit Off.
	const uint32_t want = EncodeCarrierValue(enabled, mode);
	if(havePublished){
		if(want == publishedValue){ return; } // already delivered at this value: idempotent
	} else if(want == 0u){
		// nothing was ever delivered on this transport: an Off has nothing to
		// retract, so it must not publish a spurious 0.
		return;
	}
	if(failedPermanently.load(std::memory_order_relaxed)){
		// fail-closed: observe-only. enabled stays pending ("waiting" seam
		// state via StatusString); nothing may be published on this build.
		if(want != 0u && !loggedWaiting){
			loggedWaiting = true;
			DriverLog("VrlinkTap: spacewarp requested but the publisher is unavailable on this build — status waiting, stream stock");
		}
		return;
	}
	void* vts = capturedVts.load(std::memory_order_acquire);
	if(!vts || !installed.load(std::memory_order_relaxed) || !VrlinkTapShims::origUpdateValue){
		if(want != 0u && vts == nullptr && !loggedNoCapture){
			loggedNoCapture = true;
			DriverLog("VrlinkTap: no vrlink value-transport publish captured yet — spacewarp publish stays pending (status waiting; retried on the next hot reload)");
		}
		return; // keep the delivered-value latch: retried on the next SetConfig / captured publish
	}
	uint32_t value = want;
	const int status = CallUpdateValue(vts, VrlinkTapPin::kSpacewarpValueTransportId,
		&value, VrlinkTapPin::kPublishPayloadBytes, VrlinkTapPin::kPublishFlagClass);
	if(status == -1){
		// -1 = faulted native call: state stays at the last delivered value;
		// status "waiting"; retried on the next hot-reload SetConfig or the
		// next captured Valve publish.
		if(want == 0u){
			DriverLog("VrlinkTap: explicit-off publish faulted against vrlink — retrying on the next hot reload");
		}
		return;
	}
	publishedValue = want;
	havePublished = true;
	if(want == 0u){
		DriverLog("VrlinkTap: spacewarp bridge published 0x48=0 (explicit user off; impl status %d)", status);
	} else {
		DriverLog("VrlinkTap: spacewarp bridge published 0x48=%u (mode %d; impl status %d)", want, mode, status);
	}
}

VrlinkTapRuntimeState VrlinkTap::GetRuntimeState(){
	std::lock_guard<std::mutex> stateGuard(stateLock);
	VrlinkTapRuntimeState state;
	state.enabled = enabled;
	state.hookInstalled = installed.load(std::memory_order_relaxed);
	state.publishedValue = publishedValue;
	state.published = havePublished && publishedValue != 0u;
	state.status = StatusString(enabled, state.published);
	return state;
}