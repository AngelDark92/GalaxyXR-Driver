#include "HybridConfigGlue.h"

#include <atomic>
#include <cstring>
#include <mutex>

#include "../Config/Config.h"
#include "../Hybrid/HybridProducer.h"
#include "AstcGpuEncoder.h"
#include "HybridCapture.h"
#include "NvencTap.h"

namespace {

// Last published hybrid master switch, so the per-frame call is free while hybrid is off.
// Settings publications always run the full apply, which keeps this current.
std::atomic<bool> g_hybridEnabledHint{false};

void Mix(uint64_t& hash, uint64_t value) {
	hash = (hash ^ value) * 1099511628211ull;
}

void MixDouble(uint64_t& hash, double value) {
	uint64_t bits = 0;
	std::memcpy(&bits, &value, sizeof(bits));
	Mix(hash, bits);
}

}  // namespace

void ApplyHybridDriverConfig() {
	// Apply is reachable from the render thread and from the config watcher. The whole
	// sequence (settings snapshot, enabled hint, hook state, Configure) is one critical
	// section, so a delayed apply of older settings can never land after a newer one.
	// Nothing calls this while holding driverConfigLock, so taking it inside is safe.
	static std::mutex applyMutex;
	std::lock_guard<std::mutex> applyLock(applyMutex);
	gxh1::ProducerConfig desired;
	{
		std::lock_guard<std::mutex> lock(driverConfigLock);
		const HybridConfig& h = driverConfig.hybrid;
		desired.enabled = h.enabled;
		desired.foveaCodec = h.foveaCodec;
		desired.baseCodec = h.baseCodec;
		desired.guardDegrees = h.guardDegrees;
		desired.ringDegrees[0] = h.ring0Degrees;
		desired.ringDegrees[1] = h.ring1Degrees;
		desired.ringDegrees[2] = h.ring2Degrees;
		desired.ringDegrees[3] = h.ring3Degrees;
		desired.ringDegrees[4] = h.ring4Degrees;
		desired.ringBlocks[0] = h.ring0Block;
		desired.ringBlocks[1] = h.ring1Block;
		desired.ringBlocks[2] = h.ring2Block;
		desired.ringBlocks[3] = h.ring3Block;
		desired.ringBlocks[4] = h.ring4Block;
		desired.ringDensity[0] = h.ring0Density;
		desired.ringDensity[1] = h.ring1Density;
		desired.ringDensity[2] = h.ring2Density;
		desired.ringDensity[3] = h.ring3Density;
		desired.ringDensity[4] = h.ring4Density;
		desired.featherPx = h.featherPx;
		desired.maxFoveaBytes = h.maxFoveaBytes;
		desired.requireReadyPeer = h.requireReadyPeer;
		desired.renderWidth = driverConfig.galaxyXr.renderWidth;
		desired.renderHeight = driverConfig.galaxyXr.renderHeight;
	}
	g_hybridEnabledHint.store(desired.enabled, std::memory_order_relaxed);
	// Only the two fields this path needs are copied; a full NvencTapConfig copy would
	// duplicate the preset-merge/curve vectors on every processed frame.
	const NvencTap::ConfigSnapshot nvenc = NvencTap::Get().GetConfigSnapshot();
	desired.requireLiveSeam = true;
	desired.streamTileWidth = nvenc.tileWidth;
	desired.baseBitrateMbit = nvenc.bitrateMbit;
	desired.baseForceCbr = nvenc.forceCbr;
	desired.streamFps = nvenc.forceFps > 0 ? nvenc.forceFps : 90;
	// The codec the stream runs: the session codec NVENC last accepted (both hooks observe it,
	// neither changes it); before any session, the tap's selection while it is on (0 = HEVC,
	// 1 = H.264, 2 = AV1), else vrlink's HEVC. Enabling the tap mid-stream therefore cannot
	// relabel the running session. H.264 is not a hybrid base and is reported as 3, which the
	// producer rejects visibly.
	const int acceptedCodec = NvencTap::Get().LastAcceptedSessionCodec();
	const int streamCodec = acceptedCodec >= 0 ? acceptedCodec : (nvenc.enabled ? nvenc.codec : 0);
	const uint8_t runningBase = streamCodec == 2 ? 2 : (streamCodec == 1 ? 3 : 1);

	// Field-wise hash: never hash the struct's padding bytes.
	uint64_t hash = 1469598103934665603ull;
	Mix(hash, desired.enabled ? 1u : 0u);
	Mix(hash, static_cast<uint64_t>(desired.foveaCodec));
	Mix(hash, static_cast<uint64_t>(desired.baseCodec));
	MixDouble(hash, desired.guardDegrees);
	for (int i = 0; i < 5; ++i) {
		MixDouble(hash, desired.ringDegrees[i]);
		Mix(hash, static_cast<uint64_t>(desired.ringBlocks[i]));
		MixDouble(hash, desired.ringDensity[i]);
	}
	Mix(hash, static_cast<uint64_t>(desired.featherPx));
	Mix(hash, static_cast<uint64_t>(desired.maxFoveaBytes));
	Mix(hash, desired.requireReadyPeer ? 1u : 0u);
	// The NVENC tap can be enabled/disabled (and first published) without any hybrid
	// setting changing; both transitions must re-run admission.
	Mix(hash, nvenc.enabled ? 1u : 0u);
	// Stream geometry and the base rate the user applied: the crop and the reported wire
	// cost follow them.
	Mix(hash, static_cast<uint64_t>(desired.streamTileWidth));
	Mix(hash, static_cast<uint64_t>(desired.renderWidth));
	Mix(hash, static_cast<uint64_t>(desired.renderHeight));
	Mix(hash, static_cast<uint64_t>(desired.baseBitrateMbit));
	Mix(hash, desired.baseForceCbr ? 1u : 0u);
	Mix(hash, static_cast<uint64_t>(desired.streamFps));
	Mix(hash, static_cast<uint64_t>(runningBase));

	// The envelope's NVENC seam is wanted whenever a fovea codec is selected; installing the
	// hook is idempotent (and throttled) once done.
	const bool hookWanted = desired.enabled && desired.foveaCodec != 0;
	NvencTap::Get().SetHybridHookWanted(hookWanted);
	if (hookWanted) NvencTap::Get().TryInstall();

	static uint64_t lastHash = 0;
	static bool haveHash = false;
	if (!haveHash || hash != lastHash) {
		lastHash = hash;
		haveHash = true;
		if (desired.enabled && desired.foveaCodec == 1) {
			// Registers the D3D11 compute seam; the device itself is created lazily on the
			// first batch, once the render adapter LUID is known.
			gxh1::InitAstcGpuEncoder(nullptr);
		}
		gxh1::Producer::Get().Configure(desired, runningBase);
		if (!gxh1::Producer::Get().WantsCapture()) {
			// Mode off, rejected or waiting: release the staging texture and the encoder
			// device so the idle path owns no custom GPU resource. The seam is registered
			// again above when the mode becomes active.
			HybridCaptureRelease();
		}
	}
}

void ApplyHybridDriverConfigPerFrame() {
	if (!g_hybridEnabledHint.load(std::memory_order_relaxed)) return;
	ApplyHybridDriverConfig();
}
