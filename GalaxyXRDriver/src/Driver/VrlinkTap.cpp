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
		// with its session: reset the stale "published" latch and re-publish for
		// THIS connection now instead of waiting for a manual settings reload.
		// (A stale "on" here would be a UI lie — the carrier value is gone.)
		bool republish;
		{
			std::lock_guard<std::mutex> stateGuard(stateLock);
			published = false;
			republish = enabled;
		}
		DriverLog("VrlinkTap: value-transport instance changed (0x%p -> 0x%p) — republishing on the fresh connection", previous, vts);
		if(republish){ DoPublish(true); }
		return;
	}
	// pending-publish retry on vrlink's own publish cadence: a publish that
	// faulted, or was requested before the first capture, no longer waits for
	// the next hot reload. Cheap: the locked fast path exits when the carrier
	// is already delivered. (Never touches Valve state; forwards nothing here.)
	bool pendingPublish;
	{
		std::lock_guard<std::mutex> stateGuard(stateLock);
		pendingPublish = enabled && !published
			&& !failedPermanently.load(std::memory_order_relaxed)
			&& installed.load(std::memory_order_relaxed)
			&& (VrlinkTapShims::origUpdateValue != nullptr);
	}
	if(pendingPublish){ DoPublish(true); }
}

VrlinkTap& VrlinkTap::Get(){
	static VrlinkTap instance;
	return instance;
}

const char* VrlinkTap::StatusString(bool enabled, bool published){
	// pinned seam enum (brief 11-W2B; brief 12-W2C consumes verbatim)
	return !enabled ? "off" : (published ? "on" : "waiting");
}

void VrlinkTap::SetConfig(bool enable){
	{
		std::lock_guard<std::mutex> stateGuard(stateLock);
		enabled = enable;
	}
	if(enable){
		TryInstall();
	}
	DoPublish(enable);
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
	// fail-CLOSED gate (2026-10-17): the bytes at both pinned RVAs must match
	// the audited build before anything is hooked or published. A SteamVR
	// update changes them -> observe-only (status "waiting"), stock stream.
	const auto* mem = static_cast<const unsigned char*>(static_cast<const void*>(module));
	if(memcmp(mem + VrlinkTapPin::kImplRva, VrlinkTapPin::kImplPin, sizeof(VrlinkTapPin::kImplPin)) != 0
		|| memcmp(mem + VrlinkTapPin::kWorkerRva, VrlinkTapPin::kWorkerPin, sizeof(VrlinkTapPin::kWorkerPin)) != 0){
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

void VrlinkTap::DoPublish(bool enable){
	std::lock_guard<std::mutex> stateGuard(stateLock);
	if(failedPermanently.load(std::memory_order_relaxed)){
		// fail-closed: observe-only. enabled stays pending ("waiting" seam
		// state via StatusString); nothing may be published on this build.
		if(enable && !loggedWaiting){
			loggedWaiting = true;
			DriverLog("VrlinkTap: spacewarp requested but the publisher is unavailable on this build — status waiting, stream stock");
		}
		return;
	}
	if(!enable){
		// explicit user OFF is a legitimate publish: the user's own previous
		// state, not a silent rewrite (brief 11-W2B). only retract when 1 was
		// actually delivered.
		if(!published){ return; }
		void* vts = capturedVts.load(std::memory_order_acquire);
		if(!vts || !installed.load(std::memory_order_relaxed) || !VrlinkTapShims::origUpdateValue){
			return; // keep the latch: retried on the next hot-reload SetConfig
		}
		uint32_t zero = 0;
		const int status = CallUpdateValue(vts, VrlinkTapPin::kSpacewarpValueTransportId,
			&zero, VrlinkTapPin::kPublishPayloadBytes, VrlinkTapPin::kPublishFlagClass);
		if(status != -1){
			published = false;
			DriverLog("VrlinkTap: spacewarp bridge published 0x48=0 (explicit user off; impl status %d)", status);
		}else{
			DriverLog("VrlinkTap: explicit-off publish faulted against vrlink — retrying on the next hot reload");
		}
		return;
	}
	if(published){
		return; // already delivered at this value; idempotent
	}
	void* vts = capturedVts.load(std::memory_order_acquire);
	if(!vts || !installed.load(std::memory_order_relaxed) || !VrlinkTapShims::origUpdateValue){
		if(vts == nullptr && !loggedNoCapture){
			loggedNoCapture = true;
			DriverLog("VrlinkTap: no vrlink value-transport publish captured yet — spacewarp publish stays pending (status waiting; retried on the next hot reload)");
		}
		return; // status "waiting"; every hot-reload SetConfig retries
	}
	uint32_t one = 1;
	const int status = CallUpdateValue(vts, VrlinkTapPin::kSpacewarpValueTransportId,
		&one, VrlinkTapPin::kPublishPayloadBytes, VrlinkTapPin::kPublishFlagClass);
	if(status != -1){
		published = true;
		DriverLog("VrlinkTap: spacewarp bridge published 0x48=1 (impl status %d)", status);
	}
	// -1 = faulted native call: state stays unpublished; status "waiting";
	// retried on the next hot-reload SetConfig
}

VrlinkTapRuntimeState VrlinkTap::GetRuntimeState(){
	std::lock_guard<std::mutex> stateGuard(stateLock);
	VrlinkTapRuntimeState state;
	state.enabled = enabled;
	state.hookInstalled = installed.load(std::memory_order_relaxed);
	state.published = published;
	state.status = StatusString(enabled, published);
	return state;
}