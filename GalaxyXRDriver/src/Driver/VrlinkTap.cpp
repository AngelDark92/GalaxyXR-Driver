#define NOMINMAX
#include "VrlinkTap.h"
#include "VrlinkSignature.h"
#include "AswAutoMode.h"
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

// 2026-10-26 (owner directive): half rate is restored. The carrier value comes
// from the CURRENT requested/effective pair: 0 = off, 1 = late-frame recovery,
// 2 = half rate. The stored setting is 0-based (spacewarpMode: 0 = Automatic,
// 1 = Forced half rate; any other value applies as Automatic).
uint32_t EncodeCarrierValue(bool enabled, int effectiveMode){
	if(!enabled) return 0u;
	return effectiveMode == 2 ? 2u : 1u;
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
			++transportGeneration;
		}
		// A new transport instance is a reconnect: the automatic cadence
		// decision must restart from fresh timing evidence (the saved request is
		// untouched).
		gxr::AswAutoMode::Get().NotifyBoundary("reconnect");
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
		const uint32_t want = EncodeCarrierValue(enabled, effectiveMode);
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

void VrlinkTap::SetConfig(bool enable, int requestedMode){
	{
		std::lock_guard<std::mutex> stateGuard(stateLock);
		const int previousMode = mode;
		enabled = enable;
		// Only 1 is defined as Forced; every other stored value applies as
		// Automatic without rewriting the saved value.
		mode = requestedMode == 1 ? 1 : 0;
		if(!enable){
			effectiveMode = 0;
		}else if(mode == 1){
			effectiveMode = 2;
		}else if(effectiveMode == 0 || previousMode == 1){
			// Automatic starts (or returns from Forced) in late-frame recovery;
			// the cadence tracker raises it only with fresh evidence.
			effectiveMode = 1;
		}
	}
	if(enable){
		TryInstall();
	}
	// publish the CURRENT desired value (never a captured request): a pending
	// enable that is superseded by a later explicit Off simply publishes 0.
	PublishDesired();
}

void VrlinkTap::SetConfig(bool enable){
	// Legacy boolean-only caller: Automatic is the stored default. The carrier
	// starts at late-frame recovery (1) until the cadence tracker raises it.
	SetConfig(enable, 0);
}

void VrlinkTap::SetEffectiveMode(int requestedEffective){
	int publishMode = 0;
	bool forced = false;
	{
		std::lock_guard<std::mutex> stateGuard(stateLock);
		if(!enabled){
			effectiveMode = 0;
			return;
		}
		forced = mode == 1;
		// Forced half rate always wins over the automatic decision.
		const int wanted = forced ? 2 : (requestedEffective == 2 ? 2 : 1);
		if(wanted == effectiveMode) return;
		effectiveMode = wanted;
		publishMode = effectiveMode;
	}
	DriverLog("VrlinkTap: effective spacewarp mode -> %d (%s; requested %s)", publishMode,
		publishMode == 2 ? "half rate" : "late frames", forced ? "forced" : "automatic");
	PublishDesired();
}

void VrlinkTap::TryInstall(){
	std::lock_guard<std::mutex> guard(installationLock);
	{
		std::lock_guard<std::mutex> stateGuard(stateLock);
		if(!enabled){ return; }
	}
	if(installed.load(std::memory_order_relaxed) || failedPermanently.load(std::memory_order_relaxed)){ return; }
	const double now = NowVtSeconds();
	if(now - lastAttempt < 1.0){ return; }
	lastAttempt = now;
	// resolve WITHOUT loading: driver_vrlink.dll is Valve's host driver, loaded
	// into vrserver by Steam itself; never LoadLibrary it from here.
	HMODULE module = GetModuleHandleA("driver_vrlink.dll");
	if(!module){
		std::lock_guard<std::mutex> stateGuard(stateLock);
		lastReason = "module-absent";
		if(!loggedModuleAbsent){
			loggedModuleAbsent = true;
			DriverLog("VrlinkTap: driver_vrlink.dll not loaded yet - spacewarp stays pending (retryable)");
		}
		return;
	}
	// Fail CLOSED: parse the module's own PE image, find executable sections,
	// and require exactly one structurally validated thunk/worker pair. No
	// build hash, no fixed RVA. A SteamVR update that only moves the code is
	// accepted; anything ambiguous or structurally different is refused.
	const auto* base = static_cast<const unsigned char*>(static_cast<const void*>(module));
	if(!IsReadableRange(base, sizeof(IMAGE_DOS_HEADER))){
		failedPermanently.store(true);
		{
			std::lock_guard<std::mutex> stateGuard(stateLock);
			lastReason = "image-bounds";
		}
		DriverLog("VrlinkTap: image-bounds check failed on driver_vrlink.dll (module base 0x%p is not a readable DOS header) - spacewarp stays observe-only (fail-closed), stream untouched",
			static_cast<const void*>(base));
		return;
	}
	const auto* dos = reinterpret_cast<const IMAGE_DOS_HEADER*>(static_cast<const void*>(base));
	if(dos->e_magic != IMAGE_DOS_SIGNATURE){
		failedPermanently.store(true);
		{
			std::lock_guard<std::mutex> stateGuard(stateLock);
			lastReason = "dos-signature";
		}
		DriverLog("VrlinkTap: image-bounds check failed on driver_vrlink.dll (bad DOS signature 0x%04x at module base) - spacewarp stays observe-only (fail-closed), stream untouched",
			static_cast<unsigned int>(dos->e_magic));
		return;
	}
	const LONG ntOffset = dos->e_lfanew;
	if(ntOffset < static_cast<LONG>(sizeof(IMAGE_DOS_HEADER)) || ntOffset > kNtHeaderOffsetLimit
		|| !IsReadableRange(base + ntOffset, sizeof(IMAGE_NT_HEADERS))){
		failedPermanently.store(true);
		{
			std::lock_guard<std::mutex> stateGuard(stateLock);
			lastReason = "nt-header";
		}
		DriverLog("VrlinkTap: image-bounds check failed on driver_vrlink.dll (e_lfanew 0x%lx is not a readable NT header) - spacewarp stays observe-only (fail-closed), stream untouched",
			static_cast<unsigned long>(ntOffset));
		return;
	}
	const auto* nt = reinterpret_cast<const IMAGE_NT_HEADERS*>(static_cast<const void*>(base + ntOffset));
	if(nt->Signature != IMAGE_NT_SIGNATURE){
		failedPermanently.store(true);
		{
			std::lock_guard<std::mutex> stateGuard(stateLock);
			lastReason = "nt-signature";
		}
		DriverLog("VrlinkTap: image-bounds check failed on driver_vrlink.dll (bad NT signature 0x%08lx) - spacewarp stays observe-only (fail-closed), stream untouched",
			static_cast<unsigned long>(nt->Signature));
		return;
	}
	if(nt->FileHeader.Machine != IMAGE_FILE_MACHINE_AMD64
		|| nt->OptionalHeader.Magic != IMAGE_NT_OPTIONAL_HDR64_MAGIC
		|| nt->FileHeader.SizeOfOptionalHeader < sizeof(IMAGE_OPTIONAL_HEADER64)){
		failedPermanently.store(true);
		{
			std::lock_guard<std::mutex> stateGuard(stateLock);
			lastReason = "image-shape";
		}
		DriverLog("VrlinkTap: image-shape check failed on driver_vrlink.dll (machine/magic/optional-header) - spacewarp stays observe-only (fail-closed), stream untouched");
		return;
	}
	const DWORD64 imageSize64 = static_cast<DWORD64>(nt->OptionalHeader.SizeOfImage);
	if(imageSize64 == 0 || imageSize64 > 0xFFFFFFFFull){
		failedPermanently.store(true);
		{
			std::lock_guard<std::mutex> stateGuard(stateLock);
			lastReason = "image-size";
		}
		DriverLog("VrlinkTap: image-size check failed on driver_vrlink.dll (SizeOfImage 0x%llx) - spacewarp stays observe-only (fail-closed), stream untouched",
			static_cast<unsigned long long>(imageSize64));
		return;
	}
	const uint32_t imageSize = static_cast<uint32_t>(imageSize64);
	const WORD sectionCount = nt->FileHeader.NumberOfSections;
	const auto* sectionTable = IMAGE_FIRST_SECTION(nt);
	const size_t sectionTableBytes = static_cast<size_t>(sectionCount) * sizeof(IMAGE_SECTION_HEADER);
	const uintptr_t imageBase = reinterpret_cast<uintptr_t>(base);
	const uintptr_t tableAddress = reinterpret_cast<uintptr_t>(sectionTable);
	if(sectionCount == 0
		|| tableAddress < imageBase
		|| tableAddress - imageBase > imageSize
		|| sectionTableBytes > imageSize - (tableAddress - imageBase)
		|| !IsReadableRange(sectionTable, sectionTableBytes)){
		failedPermanently.store(true);
		{
			std::lock_guard<std::mutex> stateGuard(stateLock);
			lastReason = "section-table";
		}
		DriverLog("VrlinkTap: section-table check failed on driver_vrlink.dll (count %u) - spacewarp stays observe-only (fail-closed), stream untouched",
			static_cast<unsigned int>(sectionCount));
		return;
	}
	VrlinkSignature::Result resolved;
	int resolvedCount = 0;
	const char* lastFailure = "no-executable-section";
	for(WORD index = 0; index < sectionCount; ++index){
		const IMAGE_SECTION_HEADER& section = sectionTable[index];
		if((section.Characteristics & IMAGE_SCN_MEM_EXECUTE) == 0
			|| (section.Characteristics & IMAGE_SCN_MEM_DISCARDABLE) != 0){ continue; }
		DWORD sectionSize = section.Misc.VirtualSize;
		if(sectionSize == 0){ sectionSize = section.SizeOfRawData; }
		if(sectionSize == 0){ continue; }
		if(section.VirtualAddress >= imageSize || sectionSize > imageSize - section.VirtualAddress){
			lastFailure = "section-out-of-image";
			continue;
		}
		if(!IsReadableRange(base + section.VirtualAddress, sectionSize)){
			lastFailure = "section-unreadable";
			continue;
		}
		const VrlinkSignature::Result candidate = VrlinkSignature::Resolve(
			base + section.VirtualAddress, sectionSize, section.VirtualAddress, imageSize);
		if(candidate.ok){
			if(resolvedCount == 0){ resolved = candidate; }
			++resolvedCount;
		} else if(std::strcmp(candidate.reason, "impl-not-found") != 0){
			lastFailure = candidate.reason;
		}
	}
	if(resolvedCount != 1){
		failedPermanently.store(true);
		const char* reason = resolvedCount > 1 ? "impl-ambiguous" : lastFailure;
		{
			std::lock_guard<std::mutex> stateGuard(stateLock);
			lastReason = reason;
			moduleImageSize = imageSize;
			moduleTimestamp = nt->FileHeader.TimeDateStamp;
		}
		DriverLog("VrlinkTap: no validated UpdateValue signature (%s) on driver_vrlink.dll - spacewarp stays observe-only (fail-closed), stream untouched", reason);
		return;
	}
	void* target = const_cast<unsigned char*>(base) + resolved.implRva;
	// MinHook may or may not have been initialised by another module yet
	// (NvencTap shares the runtime — tolerate MH_ERROR_ALREADY_INITIALIZED)
	MH_STATUS mi = MH_Initialize();
	if(mi != MH_OK && mi != MH_ERROR_ALREADY_INITIALIZED){
		failedPermanently.store(true);
		{
			std::lock_guard<std::mutex> stateGuard(stateLock);
			lastReason = "minhook-init-failed";
		}
		DriverLog("VrlinkTap: MH_Initialize failed (%d)", (int)mi);
		return;
	}
	MH_STATUS mh = MH_CreateHook(target, (void*)&VrlinkTapShims::UpdateValueTap, (void**)&VrlinkTapShims::origUpdateValue);
	if(mh != MH_OK && mh != MH_ERROR_ALREADY_CREATED){
		failedPermanently.store(true);
		{
			std::lock_guard<std::mutex> stateGuard(stateLock);
			lastReason = "minhook-create-failed";
		}
		DriverLog("VrlinkTap: MH_CreateHook failed (%d)", (int)mh);
		return;
	}
	if(MH_EnableHook(target) != MH_OK){
		failedPermanently.store(true);
		{
			std::lock_guard<std::mutex> stateGuard(stateLock);
			lastReason = "minhook-enable-failed";
		}
		DriverLog("VrlinkTap: MH_EnableHook failed");
		return;
	}
	installed.store(true);
	{
		std::lock_guard<std::mutex> stateGuard(stateLock);
		resolvedImplRva = resolved.implRva;
		resolvedWorkerRva = resolved.workerRva;
		resolvedCallerCount = resolved.callerCount;
		moduleImageSize = imageSize;
		moduleTimestamp = nt->FileHeader.TimeDateStamp;
		lastReason = "resolved";
	}
	DriverLog("VrlinkTap: resolved UpdateValue thunk RVA 0x%x / worker 0x%x on driver_vrlink.dll (image 0x%x, timestamp 0x%08x, %u callers) - capture+passthrough; spacewarp publishes ride the trampoline (id 0x48)",
		resolved.implRva, resolved.workerRva, imageSize,
		static_cast<unsigned int>(nt->FileHeader.TimeDateStamp), resolved.callerCount);
}

void VrlinkTap::PublishDesired(){
	std::lock_guard<std::mutex> stateGuard(stateLock);
	// The wanted value comes from the CURRENT requested/effective pair on every
	// call, so a pending enable can never overwrite a later explicit Off.
	const uint32_t want = EncodeCarrierValue(enabled, effectiveMode);
	if(havePublished){
		if(want == publishedValue){ return; } // already delivered at this value: idempotent
	} else if(want == 0u){
		// nothing was ever delivered on this transport: an Off has nothing to
		// retract, so it must not publish a spurious 0.
		lastReason = "off";
		return;
	}
	if(failedPermanently.load(std::memory_order_relaxed)){
		// fail-closed: observe-only. enabled stays pending ("waiting" seam
		// state via StatusString); nothing may be published on this build.
		if(want != 0u && !loggedWaiting){
			loggedWaiting = true;
			DriverLog("VrlinkTap: spacewarp requested but the publisher is unavailable on this build — status waiting, stream stock");
		}
		if(want == 0u){ lastReason = "off"; }
		return;
	}
	void* vts = capturedVts.load(std::memory_order_acquire);
	if(!vts || !installed.load(std::memory_order_relaxed) || !VrlinkTapShims::origUpdateValue){
		if(want != 0u && vts == nullptr && !loggedNoCapture){
			loggedNoCapture = true;
			DriverLog("VrlinkTap: no vrlink value-transport publish captured yet — spacewarp publish stays pending (status waiting; retried on the next hot reload)");
		}
		if(want == 0u){
			lastReason = "off";
		} else if(installed.load(std::memory_order_relaxed)
			&& (std::strcmp(lastReason, "resolved") == 0
				|| std::strcmp(lastReason, "published") == 0
				|| std::strcmp(lastReason, "no-capture") == 0)){
			lastReason = "no-capture";
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
		lastReason = "publish-fault";
		if(want == 0u){
			DriverLog("VrlinkTap: explicit-off publish faulted against vrlink — retrying on the next hot reload");
		}
		return;
	}
	publishedValue = want;
	havePublished = true;
	lastReason = want == 0u ? "off" : "published";
	if(want == 0u){
		DriverLog("VrlinkTap: spacewarp bridge published 0x48=0 (explicit user off; impl status %d)", status);
	} else {
		DriverLog("VrlinkTap: spacewarp bridge published 0x48=%u (effective %d, requested %d; impl status %d)", want, effectiveMode, mode, status);
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
	state.reason = lastReason;
	state.requestedMode = mode;
	state.effectiveMode = enabled ? effectiveMode : 0;
	state.transportGeneration = transportGeneration;
	state.implRva = resolvedImplRva;
	state.workerRva = resolvedWorkerRva;
	state.callerCount = resolvedCallerCount;
	state.moduleImageSize = moduleImageSize;
	state.moduleTimestamp = moduleTimestamp;
	return state;
}