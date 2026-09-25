#pragma once
#include <d3d11.h>
#include <cstdint>
#include <map>
#include <mutex>
#include <atomic>

// ============================================================================
// ZeroCopyV3 — consumption-point source substitution (design per the recon
// findings; the third attempt, built to avoid both prior walls):
//
//   v1 fed foreign handles into SubmitLayer -> vrlink's handle->swap-set
//      lookup failed ("Present() can't find texture"). WALL: handle
//      bookkeeping. v3 never touches handles: vrlink keeps presenting the
//      textures it created.
//   v2 substituted sibling swap textures -> NVENC entered a perpetual reset
//      loop (encode surfaces bind to vrlink's present rotation). WALL: the
//      encoder. v3 never touches encode surfaces: the staging texture vrlink
//      copies into and feeds to NVENC remains exactly vrlink's own.
//
//   v3 instead redirects ONE call: vrlink's per-frame
//   CopySubresourceRegion(staging <- layer) — the recon-verified single
//   consumption point (bind 0x28/misc 0x2 layer -> bind 0x8/misc 0x0 SRV-only
//   staging, full copy at (0,0), identical at scene and dashboard sizes).
//   When our pre-warped shadow for that layer size is FRESH, the copy reads
//   the shadow instead of the layer. The layer itself keeps the app's
//   unprocessed frame, so every failure mode (stale shadow, open failure,
//   v3 off) degrades to PASSTHROUGH: vrlink encodes the unprocessed frame —
//   the same benign flash as a sync-timeout skip, never a freeze or a reset.
//
//   Bandwidth: FrameProcessor in v3 mode samples the layer directly (SRV)
//   and draws into the shadow — no scratchIn copy, no layer write. Our
//   traffic per eye drops 4x -> 2x; systemwide 6 -> 4 units.
//
// Threading: PublishShadow/MarkFresh run on our processing thread;
// AcquireRedirect runs on vrlink's thread inside the copy detour. zLock is a
// LEAF lock; the one D3D call made from the detour (OpenSharedResource, a
// thread-safe ID3D11Device method) happens OUTSIDE the lock, and the result
// is published back under it (concurrency law: never call out under a lock).
//
// The redirect NEVER engages for copies issued by our own processing device
// (our layer->scratchIn copy has the same signature as vrlink's staging
// copy; without the device guard v3 would feed our own input from the
// shadow — a feedback loop).
// ============================================================================

class ZeroCopyV3{
public:
	static ZeroCopyV3& Get();

	// 2026-09-25: configuration OFF must take effect even without another
	// processed frame. Activity alone cannot re-arm a disabled feature.
	void SetEnabled(bool on){
		if(on){ armState.fetch_or(1, std::memory_order_relaxed); }
		else { armState.store(0, std::memory_order_relaxed); }
	}
	void SetArmed(bool on){
		if(!on){ armState.fetch_and(1, std::memory_order_relaxed); }
		else {
			uint8_t enabledOnly = 1;
			armState.compare_exchange_strong(enabledOnly, 3, std::memory_order_relaxed);
		}
	}
	bool Armed() const { return armState.load(std::memory_order_relaxed) == 3; }

	// our processing device: copies issued by it are never redirected
	void SetProcessingDevice(ID3D11Device* device);

	// processing side: register one slot of the rotating shadow set for a
	// layer size (idempotent), and mark a slot as holding this frame's
	// processed image (called after the producing Flush)
	void PublishShadow(uint32_t width, uint32_t height, int index, HANDLE sharedHandle);
	void MarkFresh(uint32_t width, uint32_t height, int index);

	// detour side: if a fresh shadow exists for this size and the copy is
	// NOT from our own device, return the shadow as a resource opened on
	// `device` (lazily, cached); else null. Never throws, never blocks on
	// anything but the leaf lock.
	ID3D11Resource* AcquireRedirect(uint32_t width, uint32_t height, ID3D11Device* device);

	// v3b: SRV-bind substitution. field 2026-08-10: at some resolution /
	// format combinations vrlink SKIPS the staging copy and binds the
	// layer directly as a pixel-shader SRV — no copy exists to redirect.
	// this returns an SRV of the fresh shadow, created and cached on the
	// caller's device, to swap into the PSSetShaderResources array. same
	// walls respected: no handles, no NVENC, null on any miss =
	// passthrough. never substitutes for our own processing device.
	ID3D11ShaderResourceView* AcquireRedirectSRV(uint32_t width, uint32_t height, ID3D11Device* device);
	// true when this is our own processing device: the detours skip both
	// substitution AND the passthrough counters for it, so our own
	// layer-sampling draws neither substitute nor burn the log budget
	bool IsProcessingDevice(ID3D11Device* device);

	// bounded diagnostics (DriverLog outside all locks)
	void CountRedirect();
	void CountPassthrough(const char* reason);
	// self-diagnosis: when armed and a copy LOOKS like the staging copy
	// (layer-shaped src, equal-size dst) but a predicate leg fails, log
	// exactly which one — so a field log explains its own misses
	void NearMiss(const char* detail);
	// periodic counter dump while armed (~30s), so even ALL-ZERO counters
	// are reported — silence itself becomes data
	void MaybeHeartbeat();

private:
	ZeroCopyV3() = default;
	ZeroCopyV3(const ZeroCopyV3&) = delete;
	ZeroCopyV3& operator=(const ZeroCopyV3&) = delete;

	static constexpr int slots = 3;
	struct Entry{
		HANDLE handle[slots] = {};
		ID3D11Resource* opened[slots] = {};
		ID3D11ShaderResourceView* openedSRV[slots] = {};
		ID3D11Device* openedDevice = nullptr;
		int freshIndex = -1;
		double freshTime = 0;
	};
	std::mutex zLock;
	std::map<uint64_t, Entry> entries; // key = (w << 32) | h
	// Atomic pair: bit 0 = configured, bit 1 = active eye work. OFF clears
	// both together so an in-flight activity update cannot resurrect state.
	std::atomic<uint8_t> armState{0};
	ID3D11Device* processingDevice = nullptr;

	// counters, logged bounded
	uint32_t redirects = 0;
	uint32_t stale = 0;
	uint32_t noEntry = 0;
	uint32_t openFail = 0;
	uint32_t redirectsLogged = 0;
	uint32_t passLogged = 0;
	uint32_t nearMissLogged = 0;
	double lastHeartbeat = 0;
};
