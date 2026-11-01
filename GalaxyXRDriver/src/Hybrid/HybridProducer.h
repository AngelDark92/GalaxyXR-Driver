// Hybrid fovea producer: plans the gaze-following rings, encodes them on one worker
// thread, and assembles the GXH1 fovea unit for the NVENC bitstream wrap.
//
// Cost model: when the feature is off, ineligible or waiting for a peer, every entry point
// returns before allocating. When it is active, one bounded job is in flight at a time; a
// frame whose rings are not ready by the lock of its own base access unit is transmitted
// as base-only and counted as late, never waited for and never attached to another frame.
#ifndef GXR_HYBRID_HYBRID_PRODUCER_H
#define GXR_HYBRID_HYBRID_PRODUCER_H

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "AstcBatchEncoder.h"
#include "FoveaPlanner.h"
#include "Gxh1Protocol.h"

namespace gxh1 {

struct ProducerConfig {
	bool enabled = false;
	int foveaCodec = 0;  // 0 off, 1 ASTC, 2 PyroWave
	int baseCodec = 0;   // 0 = the stream's running codec, 1 = require HEVC, 2 = require AV1
	double guardDegrees = 2.0;
	double ringDegrees[5] = {5.0, 10.0, 20.0, 35.0, 45.0};
	int ringBlocks[5] = {4, 6, 8, 10, 12};
	// Sampling density per ring relative to the source (1 = native). Settings default to the
	// plan's 1, 1, 0.75, 0.5, 0.25; this struct defaults to native so harnesses opt in.
	double ringDensity[5] = {1.0, 1.0, 1.0, 1.0, 1.0};
	int featherPx = 8;
	int maxFoveaBytes = 2097152;
	bool requireReadyPeer = true;
	// Capture only while a wrapped NVENC encoder is submitting (the envelope is applied at
	// its lock seam); otherwise nothing could carry the fovea. The driver sets this; test
	// harnesses without NVENC leave it off.
	bool requireLiveSeam = false;
	// Test/bench harnesses only, never read from settings: lets ASTC use the CPU reference
	// encoder when no GPU encoder is registered. Production reports astc_gpu_unavailable.
	bool allowCpuAstcReference = false;
	// Stream facts from the user's applied settings (never changed here). The fovea layer
	// upgrades Steam Link's fovea tile, a W x W window of the recommended per-eye render, so
	// planning is clipped to that window; 0 = unknown, plan over the whole eye tile.
	int streamTileWidth = 0;
	int renderWidth = 0;
	int renderHeight = 0;
	// Applied base budget, for reporting the fovea next to it (0 = unknown).
	int baseBitrateMbit = 0;
	bool baseForceCbr = false;
	int streamFps = 90;
};

enum class ProducerState { Off, WaitingPeer, Active, Degraded, Rejected };

struct ProducerStatus {
	ProducerState state = ProducerState::Off;
	std::string reason;
	std::string backend;  // "astc_gpu", "astc_cpu_test" or "pyrowave_cpu"
	std::string capturePath;  // "gpu_shared" (no render-thread Map) or "cpu_staging"
	uint32_t patchCount = 0;
	uint32_t foveaBytes = 0;
	// Latest plan, published even when it is refused, so a budget or size rejection shows
	// what the configured rings would cost.
	uint16_t canvasW = 0;
	uint16_t canvasH = 0;
	uint64_t plannedBytes = 0;  // ASTC: exact block bytes + table; PyroWave: 0 (rate-controlled)
	uint16_t cropW = 0;         // fovea-tile window used for planning (0 = whole eye tile)
	uint16_t cropH = 0;
	// Wire context: fovea bytes at the stream rate next to the applied base budget. Unless
	// Force CBR is on, vrlink's adaptive request still scales the base and sees these bytes.
	int baseBitrateMbit = 0;
	bool baseForceCbr = false;
	int streamFps = 90;
	int baseCodec = 0;  // codec the envelopes declare (1 HEVC, 2 AV1); 0 before admission
	// While the hybrid runs, the video's fovea tiles are replaced, not kept as a fallback.
	uint64_t videoFoveaCleared = 0;
	uint64_t videoFoveaKept = 0;  // frames where the clear failed: the video fovea is still sent
	double encodeMs = 0.0;
	uint64_t frames = 0;          // fovea units encoded
	uint64_t encodeFailures = 0;  // fovea encodes that failed or exceeded the byte budget
	uint64_t degradedFrames = 0;  // base access units sent without a fovea while active
	uint64_t lastFrameId = 0;
	// Base/fovea join at the NVENC lock, per base access unit while active.
	uint64_t joinedFrames = 0;    // wrapped with the fovea of the same scene frame
	uint64_t lateFrames = 0;      // the matching fovea was not ready at lock time
	uint64_t staleFovea = 0;      // a finished fovea whose base had already been locked
	uint64_t unmappedFrames = 0;  // the base had no recorded scene frame (no join possible)
};

struct FrameMeta {
	uint16_t eyeW = 0;
	uint16_t eyeH = 0;
	float gazeX[2] = {};  // continuous eye-tile pixels
	float gazeY[2] = {};
	bool gazeValid[2] = {};
	float tan[2][4] = {};  // signed left, right, top, bottom (y-down, left < right, top < bottom)
	// Steam Link's fovea tile in eye-tile pixels (the native crop the hybrid layer upgrades);
	// 0 = unknown, plan over the whole tile.
	uint16_t cropW = 0;
	uint16_t cropH = 0;
	uint64_t frameId = 0;  // scene frame id; the NVENC submission of this frame carries the same id
	uint64_t ptsNs = 0;
};

struct EncodedFrame {
	uint64_t frameId = 0;
	uint64_t ptsNs = 0;
	uint16_t canvasW = 0;
	uint16_t canvasH = 0;
	uint8_t codec = 0;
	uint8_t patchCount = 0;
	double encodeMs = 0.0;
	std::vector<uint8_t> unit;  // FoveaUnitHeader + PatchEntry[] + payloads
};

class Producer {
public:
	static Producer& Get();

	void Configure(const ProducerConfig& config, uint8_t runningBaseCodec);
	void SetPeerReady(bool ready, uint64_t sessionEpoch);
	// A wrapped encoder submitted a picture (called from the NVENC seam).
	void NoteSeamAlive();
	// An encoder session ended: drop its pending fovea and start a new epoch, so the next
	// stream's first envelope tells the client to reset.
	void OnStreamBoundary();
	// The video's own fovea tiles were cleared (or could not be) for the frame being encoded.
	void NoteVideoFoveaBlank(bool cleared);
	bool WantsCapture() const;
	// Scene frame about to be handed to the encoder. NVENC submissions read it so each base
	// access unit can be joined with the fovea captured from the same scene frame.
	void NoteScenePresent(uint64_t frameId) { scenePresent_.store(frameId, std::memory_order_release); }
	uint64_t CurrentSceneFrame() const { return scenePresent_.load(std::memory_order_acquire); }
	bool BeginFrame(const FrameMeta& meta, std::string* reason);
	bool SubmitEye(int eye, const uint8_t* rgba, int strideBytes, int width, int height, bool bgra = false);
	// Both eyes at once as a shared GPU canvas (canvasW x 2*canvasH) whose copies have been
	// queued and whose keyed mutex was released by the render thread.
	bool SubmitGpuCanvas(const GpuCanvasRef& canvas, int width, int height);
	// The capture for the frame BeginFrame admitted could not be completed; frees the slot
	// immediately instead of waiting for the stale-frame recovery.
	void AbortFrame();
	void NoteCapturePath(const char* path);
	// Takes the fovea of exactly `baseFrameId` (the scene frame of the access unit being
	// locked). A fovea for an older frame is discarded; one for a newer frame is kept for its
	// own access unit. Never pairs a fovea with another frame's base.
	bool TakeReady(uint64_t baseFrameId, EncodedFrame& out);
	// The access unit's encoder session accepted `liveBase` (1 HEVC, 2 AV1, 3 H.264, 0 never
	// observed). Envelopes declare the admitted base, so any other codec is sent base-only
	// with a visible reason.
	bool AcceptsLiveBase(uint8_t liveBase);
	// Final commit gate: runs `commit` only if `frameId` is still the frame returned by the
	// latest TakeReady and no reconfigure/disable happened since. Configure and this gate
	// share the producer lock, so a taken frame can never be committed into a new mode.
	bool CommitIfCurrent(uint64_t frameId, const std::function<void()>& commit);
	const FoveaPlan* InflightPlan() const { return &inflightPlan_; }
	ProducerStatus Snapshot() const;
	// True when a hybrid mode is enabled but cannot run. The NVENC seam refuses to encode in
	// that state so the stream fails visibly instead of silently running without the mode.
	bool BlocksStream() const;
	void Shutdown();

	// Assembles a GXH1 envelope around `au`. The returned buffer owns the base AU copy and
	// the fovea unit; the caller keeps it alive until the matching NVENC unlock.
	bool WrapAccessUnit(const uint8_t* au, size_t auBytes, uint8_t baseFormat, const EncodedFrame& fovea,
	                    std::vector<uint8_t>& out, EnvelopeHeader& header);

private:
	Producer() = default;
	~Producer();
	Producer(const Producer&) = delete;
	Producer& operator=(const Producer&) = delete;

	struct Job {
		FrameMeta meta;
		FoveaPlan plan;
		uint64_t epoch = 0;
		uint64_t generation = 0;
		ProducerConfig config;
		std::vector<uint8_t> eyes[2];
		bool haveEye[2] = {false, false};
		GpuCanvasRef gpu;  // set instead of `eyes` on the GPU-resident capture path
	};

	void WorkerMain();
	void EncodeJob(Job& job, EncodedFrame& out);
	void SetState(ProducerState state, const std::string& reason);
	// A per-frame problem (plan, capture or encode): visible state, no counter.
	void MarkIssueLocked(const char* reason);
	// A base access unit left the lock seam without its fovea while hybrid was active.
	void MarkBaseOnlyLocked(const char* joinReason);

	mutable std::mutex mutex_;
	std::condition_variable wake_;
	std::thread worker_;
	bool stop_ = false;

	ProducerConfig config_;
	uint8_t runningBaseCodec_ = 1;
	std::atomic<bool> wantsCapture_{false};
	std::atomic<uint64_t> scenePresent_{0};
	std::atomic<int64_t> seamAliveMs_{0};
	bool peerReady_ = false;
	uint64_t peerSessionEpoch_ = 0;
	uint64_t sessionEpoch_ = 1;
	uint64_t lastWrappedEpoch_ = 0;

	bool jobPending_ = false;
	Job pending_;
	bool haveReady_ = false;
	EncodedFrame ready_;
	uint64_t readyGeneration_ = 0;
	uint64_t configGeneration_ = 0;
	uint64_t lastTakenFrame_ = 0;
	bool frameInProgress_ = false;
	FrameMeta inflightMeta_{};
	FoveaPlan inflightPlan_{};
	uint64_t inflightEpoch_ = 1;
	uint64_t inflightGeneration_ = 0;
	bool inflightEye_[2] = {false, false};

	ProducerStatus status_;
};

}  // namespace gxh1

#endif  // GXR_HYBRID_HYBRID_PRODUCER_H
