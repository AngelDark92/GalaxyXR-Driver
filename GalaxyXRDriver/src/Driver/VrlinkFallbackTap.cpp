#define NOMINMAX
#include "VrlinkFallbackTap.h"
#include "DriverLog.h"
#include <windows.h>
#include <cstring>

// ============================================================================
// VrlinkFallbackTap implementation. See VrlinkFallbackTap.h for the pinned
// sites, the derivation and the safety contract (2026-10-20).
// ============================================================================

namespace {
// 0 = not the audited build, 1 = stock span, 2 = already patched span.
// The non-editable bytes of the anchor window must match exactly; the editable
// span must be one of the two known forms (idempotent re-apply). The routine
// itself lives in the header so the host test can exercise it.
int ClassifyEditableSpan(const unsigned char* base, int windowRva,
	const unsigned char* window, size_t windowSize,
	size_t spanOffset, size_t spanSize,
	const unsigned char* stock, const unsigned char* patched){
	return ClassifyVrlinkFallbackWindow(base, windowRva, window, windowSize,
		spanOffset, spanSize, stock, patched);
}

// Writes code bytes with the page temporarily writable, then flushes the
// instruction cache and restores the original protection. The 8-byte span is
// 8-byte aligned at RVA 0xA1A098, so it lands as ONE aligned store (atomic on
// x86-64); the 1-byte span needs no such care.
bool WriteCodeBytes(void* dst, const void* src, size_t size){
	SYSTEM_INFO si;
	GetSystemInfo(&si);
	const uintptr_t pageSize = si.dwPageSize ? static_cast<uintptr_t>(si.dwPageSize) : 4096;
	const uintptr_t begin = reinterpret_cast<uintptr_t>(dst);
	const uintptr_t end = begin + size;
	const uintptr_t pageBegin = begin & ~(pageSize - 1);
	const SIZE_T span = static_cast<SIZE_T>(end - pageBegin);
	DWORD oldProtect = 0;
	if(!VirtualProtect(reinterpret_cast<void*>(pageBegin), span, PAGE_EXECUTE_READWRITE, &oldProtect)){
		return false;
	}
	if(size == 8 && (begin & 7) == 0){
		uint64_t value = 0;
		memcpy(&value, src, sizeof(value));
		*reinterpret_cast<volatile uint64_t*>(begin) = value;
	}else{
		memcpy(dst, src, size);
	}
	FlushInstructionCache(GetCurrentProcess(), reinterpret_cast<void*>(begin), size);
	DWORD ignored = 0;
	VirtualProtect(reinterpret_cast<void*>(pageBegin), span, oldProtect, &ignored);
	return memcmp(dst, src, size) == 0;
}
}

VrlinkFallbackTap& VrlinkFallbackTap::Get(){
	static VrlinkFallbackTap instance;
	return instance;
}

VrlinkFallbackRuntimeState VrlinkFallbackTap::GetRuntimeState(){
	std::lock_guard<std::mutex> guard(stateLock);
	VrlinkFallbackRuntimeState state;
	state.enabled = enabled;
	state.applied = applied;
	state.status = !enabled ? "off" : (applied ? "on" : "waiting");
	state.reason = failureReason;
	return state;
}

void VrlinkFallbackTap::SetConfig(bool noFallback){
	{
		std::lock_guard<std::mutex> guard(stateLock);
		enabled = noFallback;
	}
	ApplyLocked(noFallback);
}

void VrlinkFallbackTap::ApplyLocked(bool noFallback){
	std::lock_guard<std::mutex> writeGuard(writeLock);

	{
		std::lock_guard<std::mutex> guard(stateLock);
		if(failedPermanently){
			// Fail closed: this is not the audited build (or the write failed).
			// Nothing is ever written; the stream stays stock.
			if(enabled && !loggedWaiting){
				loggedWaiting = true;
				DriverLog("VrlinkFallbackTap: 'No fallback' requested but the tap is unavailable (%s) — stream stock, status waiting",
					failureReason ? failureReason : "unavailable");
			}
			return;
		}
	}

	// Valve's host driver is loaded by Steam into vrserver; never LoadLibrary it.
	HMODULE module = GetModuleHandleA("driver_vrlink.dll");
	if(!module){
		std::lock_guard<std::mutex> guard(stateLock);
		applied = false;
		if(enabled && !loggedWaiting){
			loggedWaiting = true;
			DriverLog("VrlinkFallbackTap: driver_vrlink.dll not loaded — Steam Link host driver absent, tap idle");
		}
		return;
	}

	const unsigned char* base = static_cast<const unsigned char*>(static_cast<const void*>(module));
	const int ratioState = ClassifyEditableSpan(base, VrlinkFallbackPin::kRatioWindowRva,
		VrlinkFallbackPin::kRatioWindow, sizeof(VrlinkFallbackPin::kRatioWindow),
		VrlinkFallbackPin::kRatioBranchRva - VrlinkFallbackPin::kRatioWindowRva,
		sizeof(VrlinkFallbackPin::kRatioBranchStock),
		VrlinkFallbackPin::kRatioBranchStock, VrlinkFallbackPin::kRatioBranchPatched);
	const int throttleState = ClassifyEditableSpan(base, VrlinkFallbackPin::kOutWindowRva,
		VrlinkFallbackPin::kOutWindow, sizeof(VrlinkFallbackPin::kOutWindow),
		VrlinkFallbackPin::kThrottleMulRva - VrlinkFallbackPin::kOutWindowRva,
		sizeof(VrlinkFallbackPin::kThrottleMulStock),
		VrlinkFallbackPin::kThrottleMulStock, VrlinkFallbackPin::kThrottleMulPatched);

	if(ratioState == 0 || throttleState == 0){
		std::lock_guard<std::mutex> guard(stateLock);
		failedPermanently = true;
		failureReason = "pinned window mismatch on driver_vrlink.dll";
		applied = false;
		if(enabled && !loggedWaiting){
			loggedWaiting = true;
			DriverLog("VrlinkFallbackTap: pin mismatch on driver_vrlink.dll (ratio=%d throttle=%d) — 'No fallback' fails closed, stream untouched",
				ratioState, throttleState);
		}
		return;
	}

	unsigned char* writable = static_cast<unsigned char*>(static_cast<void*>(module));
	bool ok = true;

	if(!noFallback){
		if(ratioState == 2){
			ok = WriteCodeBytes(writable + VrlinkFallbackPin::kRatioBranchRva,
				VrlinkFallbackPin::kRatioBranchStock, sizeof(VrlinkFallbackPin::kRatioBranchStock)) && ok;
		}
		if(throttleState == 2){
			ok = WriteCodeBytes(writable + VrlinkFallbackPin::kThrottleMulRva,
				VrlinkFallbackPin::kThrottleMulStock, sizeof(VrlinkFallbackPin::kThrottleMulStock)) && ok;
		}
		std::lock_guard<std::mutex> guard(stateLock);
		applied = false;
		if(ratioState == 2 || throttleState == 2){
			DriverLog("VrlinkFallbackTap: VRLink fallback/throttle restored to stock (ok=%d)", ok ? 1 : 0);
		}
		return;
	}

	if(ratioState == 1){
		ok = WriteCodeBytes(writable + VrlinkFallbackPin::kRatioBranchRva,
			VrlinkFallbackPin::kRatioBranchPatched, sizeof(VrlinkFallbackPin::kRatioBranchPatched)) && ok;
	}
	if(throttleState == 1){
		ok = WriteCodeBytes(writable + VrlinkFallbackPin::kThrottleMulRva,
			VrlinkFallbackPin::kThrottleMulPatched, sizeof(VrlinkFallbackPin::kThrottleMulPatched)) && ok;
	}

	{
		std::lock_guard<std::mutex> guard(stateLock);
		const bool wasApplied = applied;
		applied = ok;
		if(!ok){
			failedPermanently = true;
			failureReason = "in-memory write failed (page protection)";
		}
		if(ok && wasApplied){
			return; // idempotent hot reload: already patched, stay quiet
		}
	}
	DriverLog("VrlinkFallbackTap: 'No fallback' %s — ratio branch %s, QThrottle multiply %s",
		ok ? "applied" : "FAILED",
		ratioState == 2 ? "patched" : "stock",
		throttleState == 2 ? "patched" : "stock");
}
