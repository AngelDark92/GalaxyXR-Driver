#pragma once
#include <atomic>
#include <cstdint>
#include <cstring>
#include <mutex>

// ============================================================================
// VrlinkFallbackTap — removes VRLink's own bitrate fallback and its pipeline
// throttle by editing two instructions inside the LOADED driver_vrlink.dll
// image (2026-10-20, owner request).
//
// Why an in-memory edit and not a hook: the fallback decision is one branch
// inside the per-frame bandwidth controller, and the throttle is one multiply
// in the same function. A MinHook detour can only rewrite the RESULT of the
// controller (the encoder request), which leaves the decision, the bad-link
// latch and the pacer's view of it oscillating — the framepacing storm this
// work removes. The decision has to be changed where it is made.
//
// The two sites (audited build 25330290, driver_vrlink.dll 13,908,632 B,
// sha256 1e846be041039798580a91452371f6288c614fb4c152126b137e2c693fb77eef):
//
//   0xA19EF5  ratio = clamp((1..4 frames) / ping, 0.05, 1.0)
//             ... 44 0F 2F D9        comiss xmm11, xmm1
//     0xA19EF9   76 07               jbe  +7      -> 0xA19F02 (ratio = 1.0)
//     0xA19EFB   F3 41 0F 5E CB      divss xmm11, xmm1
//     0xA19F02   41 0F 28 C8         movaps xmm8, xmm1
//             patched: 76 07 -> EB 07 (unconditional): ratio is 1.0 every call,
//             so the 0.98 healthy gate always passes, the recovery/backoff block
//             never runs, and the bad-link latch never sets.
//
//   0xA1A092  0F 28 C3               movaps xmm0, xmm3
//             0F 28 CB               movaps xmm1, xmm3
//     0xA1A098  F3 0F 59 87 34 01 00 00   mulss xmm0, [rdi+0x134]  (QThrottle)
//             48 8B CE               mov    rcx, rsi
//             F3 0F 59 C2            mulss  xmm0, xmm2                 (ratio)
//             patched: the QThrottle multiply becomes two AArch64-style NOPs
//             (1F 20 03 D5 x2, the multi-byte NOP this toolchain emits), so the
//             request no longer halves when the frame phase reaches 4.
//
// With both edits the controller request is `min(targetBandwidth, 350)` at any
// ping and any phase. The driver's own bitrate curve/constancy then sees a
// constant request and passes the Bandwidth row through unchanged.
//
// Safety contract (mirrors VrlinkTap / NvencTap):
//   1. driver_vrlink.dll is resolved with GetModuleHandleA only — never loaded
//      from here. Absent module = one log line, tap idle.
//   2. fail CLOSED: both anchor windows must match the audited build (stock or
//      already patched). A mismatch = no write, one log line, status "waiting",
//      stock stream.
//   3. only these two instruction spans are ever written; every other byte of
//      Valve's image is left alone. The stock bytes are saved first and written
//      back on user OFF, so the option is a true toggle.
//   4. the writes are single aligned stores (1 B and 8 B) under VirtualProtect,
//      followed by FlushInstructionCache; nothing is written on disk, no file
//      is created, no registry key is touched. SteamVR restart / driver unload
//      reloads Valve's untouched image.
//   5. independent failure domain: NvencTap and VrlinkTap are unaffected by
//      this tap failing, and vice versa.
// ============================================================================

namespace VrlinkFallbackPin {
	// Context anchor: the ratio computation, stock form.
	constexpr int kRatioWindowRva = 0xA19EF5;
	constexpr unsigned char kRatioWindow[8] = {0x44, 0x0F, 0x2F, 0xD9, 0x76, 0x07, 0xF3, 0x41};

	// Editable span inside that window.
	constexpr int kRatioBranchRva = 0xA19EF9;
	constexpr unsigned char kRatioBranchStock[2] = {0x76, 0x07};
	constexpr unsigned char kRatioBranchPatched[2] = {0xEB, 0x07};

	// Context anchor: the controller output sequence.
	constexpr int kOutWindowRva = 0xA1A092;
	constexpr unsigned char kOutWindow[24] = {
		0x0F, 0x28, 0xC3, 0x0F, 0x28, 0xCB, 0xF3, 0x0F,
		0x59, 0x87, 0x34, 0x01, 0x00, 0x00, 0x48, 0x8B,
		0xCE, 0xF3, 0x0F, 0x59, 0xC2, 0x41, 0x0F, 0x28};

	// Editable span inside that window (offset 6, length 8).
	constexpr int kThrottleMulRva = 0xA1A098;
	constexpr unsigned char kThrottleMulStock[8] = {0xF3, 0x0F, 0x59, 0x87, 0x34, 0x01, 0x00, 0x00};
	constexpr unsigned char kThrottleMulPatched[8] = {0x1F, 0x20, 0x03, 0xD5, 0x1F, 0x20, 0x03, 0xD5};
}

// Published shape: status is exactly one of "off"/"on"/"waiting"
// (off: option off / bytes stock; on: bytes patched; waiting: option on but
// the pinned build was not found or the write failed).
struct VrlinkFallbackRuntimeState {
	bool enabled = false;
	bool applied = false;
	const char* status = "off";
	const char* reason = "";
};

// Classifies one pinned window against an arbitrary image buffer.
// 0 = not the audited build, 1 = stock span, 2 = already patched span.
// Exposed so tools/Test-VrlinkFallback.ps1 can exercise it against a synthetic
// image; the tap calls this same routine with the loaded module base.
inline int ClassifyVrlinkFallbackWindow(const unsigned char* base, int windowRva,
	const unsigned char* window, size_t windowSize,
	size_t spanOffset, size_t spanSize,
	const unsigned char* stock, const unsigned char* patched){
	for(size_t i = 0; i < windowSize; ++i){
		if(i >= spanOffset && i < spanOffset + spanSize){ continue; }
		if(base[windowRva + i] != window[i]){ return 0; }
	}
	const unsigned char* span = base + windowRva + spanOffset;
	if(memcmp(span, stock, spanSize) == 0){ return 1; }
	if(memcmp(span, patched, spanSize) == 0){ return 2; }
	return 0;
}

class VrlinkFallbackTap{
public:
	static VrlinkFallbackTap& Get();

	// Single control path: the hot-reload encoder settings update
	// (FrameProcessor::UpdateEncoderSettings). true = "No fallback".
	void SetConfig(bool noFallback);

	VrlinkFallbackRuntimeState GetRuntimeState();

private:
	void ApplyLocked(bool noFallback);

	std::mutex stateLock;
	std::mutex writeLock;
	bool enabled = false;
	bool applied = false;
	bool failedPermanently = false;
	bool loggedWaiting = false;
	const char* failureReason = "";
};
