#include "HybridProducer.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>

#include "AstcSubset.h"
#include "Gxh1Codec.h"
#include "PyroWaveCpu.h"
#include "AstcBatchEncoder.h"

namespace gxh1 {
namespace {

// One frame at 72 Hz is 13.9 ms. The producer reports anything above this as degraded and
// never blocks the base stream waiting for it.
constexpr double kFrameBudgetMs = 12.0;

// ASTC block dimensions are a fixed legal set; 7x7, 9x9 and 11x11 have no block descriptor.
bool IsLegalAstcFootprint(int size) {
	return size == 4 || size == 5 || size == 6 || size == 8 || size == 10 || size == 12;
}

// sRGB transfer used for the resampling low-pass (the capture holds display-encoded bytes).
float SrgbToLinear(uint8_t value) {
	const float c = static_cast<float>(value) / 255.0f;
	return c <= 0.04045f ? c / 12.92f : std::pow((c + 0.055f) / 1.055f, 2.4f);
}

uint8_t LinearToSrgb8(float linear) {
	const float l = std::min(1.0f, std::max(0.0f, linear));
	const float c = l <= 0.0031308f ? l * 12.92f : 1.055f * std::pow(l, 1.0f / 2.4f) - 0.055f;
	return static_cast<uint8_t>(std::lround(std::min(1.0f, std::max(0.0f, c)) * 255.0f));
}

double NowMilliseconds() {
	using clock = std::chrono::steady_clock;
	return std::chrono::duration<double, std::milli>(clock::now().time_since_epoch()).count();
}

// Crops a rect out of an RGBA canvas into its encoded texel grid. At native density this is
// a copy; below it every texel is the linear-light mean of the source pixels it covers (the
// low-pass before decimation), the same footprint and arithmetic as the GPU encoder.
void CropToRgb(const uint8_t* rgba, int canvasW, int canvasH, const PlannedPatch& patch, std::vector<uint8_t>& rgb,
                int& outW, int& outH) {
	(void)canvasH;
	outW = patch.texelW ? patch.texelW : patch.width;
	outH = patch.texelH ? patch.texelH : patch.height;
	rgb.resize(static_cast<size_t>(outW) * outH * 3u);
	for (int y = 0; y < outH; ++y) {
		const int y0 = y * patch.height / outH;
		const int y1 = std::max(y0 + 1, ((y + 1) * patch.height + outH - 1) / outH);
		for (int x = 0; x < outW; ++x) {
			const int x0 = x * patch.width / outW;
			const int x1 = std::max(x0 + 1, ((x + 1) * patch.width + outW - 1) / outW);
			uint8_t* dst = rgb.data() + (static_cast<size_t>(y) * outW + x) * 3u;
			if (x1 - x0 == 1 && y1 - y0 == 1) {
				const uint8_t* src = rgba + (static_cast<size_t>(patch.y + y0) * canvasW + patch.x + x0) * 4u;
				dst[0] = src[0];
				dst[1] = src[1];
				dst[2] = src[2];
				continue;
			}
			float sum[3] = {0.0f, 0.0f, 0.0f};
			for (int sy = y0; sy < y1; ++sy) {
				for (int sx = x0; sx < x1; ++sx) {
					const uint8_t* src = rgba + (static_cast<size_t>(patch.y + sy) * canvasW + patch.x + sx) * 4u;
					for (int c = 0; c < 3; ++c) sum[c] += SrgbToLinear(src[c]);
				}
			}
			const float count = static_cast<float>((x1 - x0) * (y1 - y0));
			for (int c = 0; c < 3; ++c) dst[c] = LinearToSrgb8(sum[c] / count);
		}
	}
}

// PyroWave is not tiled per ring (a wavelet patch per ring strip would pad every thin strip
// to the codec's 128 px minimum). Each eye is one transform, and every 32x32 packet takes
// the quantizer step of the finest ring its synthesis support reaches: footprint N means a
// step N/4 times the base step, the same relative density the ASTC rings use.
struct PyroWaveRingWeights {
	const FoveaPlan* plan = nullptr;
	int eye = 0;
	float multiplier[kRingCount] = {1.0f, 1.0f, 1.0f, 1.0f, 1.0f};
	float density[kRingCount] = {1.0f, 1.0f, 1.0f, 1.0f, 1.0f};
};

// Ring density in a wavelet: a detail band of level L holds frequencies above 2^-(L+1) of
// the source Nyquist, so where the finest ring reached has density <= 2^-(L+1) that band
// carries nothing the ring may keep and is not sent. The low-pass band is always sent.
float PyroWaveStepScale(const void* context, int level, int band, int x0, int y0, int x1, int y1) {
	const PyroWaveRingWeights* weights = static_cast<const PyroWaveRingWeights*>(context);
	const uint8_t ring = AnnulusForRegion(*weights->plan, weights->eye, x0, y0, x1, y1);
	if (band != 0 && weights->density[ring] <= std::ldexp(1.0f, -(level + 1))) return 0.0f;
	return weights->multiplier[ring];
}

void ReplaceWithWholeEyePatches(FoveaPlan& plan, const FoveaPlanRequest& request) {
	plan.patches.clear();
	for (int eye = 0; eye < 2; ++eye) {
		PlannedPatch patch;
		patch.x = 0;
		patch.y = 0;
		patch.width = plan.canvasW;
		patch.height = plan.canvasH;
		patch.eye = static_cast<uint8_t>(eye);
		patch.annulus = 0;
		patch.blockW = request.rings[0].blockW;
		patch.blockH = request.rings[0].blockH;
		patch.texelW = plan.canvasW;  // native grid; ring density acts inside the transform
		patch.texelH = plan.canvasH;
		patch.innerRadiusPx = 0;
		patch.outerRadiusPx = static_cast<uint16_t>(std::max(plan.canvasW, plan.canvasH));
		patch.innerDegrees = 0.0f;
		patch.outerDegrees = request.rings[kRingCount - 1].outerDegrees;
		plan.patches.push_back(patch);
	}
}

}  // namespace

Producer& Producer::Get() {
	static Producer instance;
	return instance;
}

Producer::~Producer() {
	Shutdown();
}

void Producer::Shutdown() {
	{
		std::lock_guard<std::mutex> lock(mutex_);
		stop_ = true;
	}
	wake_.notify_all();
	if (worker_.joinable()) worker_.join();
}

void Producer::SetState(ProducerState state, const std::string& reason) {
	std::lock_guard<std::mutex> lock(mutex_);
	status_.state = state;
	status_.reason = reason;
	wantsCapture_.store(state == ProducerState::Active, std::memory_order_relaxed);
}

void Producer::MarkIssueLocked(const char* reason) {
	status_.state = ProducerState::Degraded;
	status_.reason = reason;
}

void Producer::MarkBaseOnlyLocked(const char* joinReason) {
	++status_.degradedFrames;
	// Keep a more specific cause (encode/plan failure) visible; only a clean state is
	// replaced by the join outcome.
	if (status_.state != ProducerState::Degraded || status_.reason == "fovea_late" ||
	    status_.reason == "base_unmapped") {
		status_.reason = joinReason;
	}
	status_.state = ProducerState::Degraded;
}

void Producer::Configure(const ProducerConfig& config, uint8_t runningBaseCodec) {
	{
		std::lock_guard<std::mutex> lock(mutex_);
		config_ = config;
		runningBaseCodec_ = runningBaseCodec;
		++configGeneration_;
		// A new configuration is a new epoch: its first envelope tells the client to drop
		// every canvas, mapping and decode cached under the previous one.
		++sessionEpoch_;
		// Retire every piece of work that belongs to the previous configuration: a job in
		// flight, an unconsumed frame, or a half-captured pair must never be published or
		// wrapped after this point.
		jobPending_ = false;
		pending_ = Job{};
		haveReady_ = false;
		ready_ = EncodedFrame{};
		lastTakenFrame_ = 0;  // attachment order restarts with the configuration
		frameInProgress_ = false;
		inflightEye_[0] = false;
		inflightEye_[1] = false;
	}

	if (!config.enabled || config.foveaCodec == 0) {
		SetState(ProducerState::Off, "disabled");
		return;
	}

	// Validate the requested values; never rewrite them. A rejected configuration is
	// visible with a stable reason code and leaves the base stream untouched.
	const char* reason = nullptr;
	// The base follows the codec the stream runs (the user's Stream Frame choice) unless a
	// specific base is required; H.264 cannot carry the hybrid.
	if (config.foveaCodec != 1 && config.foveaCodec != 2) reason = "bad_fovea_codec";
	else if (config.baseCodec < 0 || config.baseCodec > 2) reason = "bad_base_codec";
	else if (runningBaseCodec != 1 && runningBaseCodec != 2) reason = "base_h264_unsupported";
	else if (config.baseCodec != 0 && config.baseCodec != runningBaseCodec) reason = "base_codec_mismatch";
	else if (!(config.guardDegrees >= 0.0) || config.guardDegrees > 30.0) reason = "bad_guard";
	else if (config.featherPx < 0 || config.featherPx > 64) reason = "bad_feather";
	else if (config.maxFoveaBytes <= 0 || config.maxFoveaBytes > static_cast<int>(kMaxFoveaBytes))
		reason = "bad_budget";
	else {
		for (int i = 0; i < 5 && !reason; ++i) {
			if (!IsLegalAstcFootprint(config.ringBlocks[i])) reason = "illegal_footprint";
			else if (!(config.ringDegrees[i] >= 1.0) || config.ringDegrees[i] > 89.0) reason = "bad_ring_radii";
			else if (!(config.ringDensity[i] >= 0.1) || config.ringDensity[i] > 1.0) reason = "bad_density";
			else if (i > 0 && !(config.ringDegrees[i] > config.ringDegrees[i - 1])) reason = "bad_ring_radii";
		}
	}
	if (reason) {
		SetState(ProducerState::Rejected, reason);
		return;
	}

	// No readiness bridge exists, so peerReady_ can never become true. WaitingPeer would claim
	// the mode is still coming up when it can never start; reject it instead, and let the NVENC
	// seam fail the stream so the selected mode is never silently not applied.
	if (config.requireReadyPeer && !peerReady_) {
		SetState(ProducerState::Rejected, "no_readiness_bridge");
		return;
	}
	{
		std::lock_guard<std::mutex> lock(mutex_);
		status_.baseCodec = runningBaseCodec;
		status_.baseBitrateMbit = config.baseBitrateMbit;
		status_.baseForceCbr = config.baseForceCbr;
		status_.streamFps = config.streamFps;
	}
	SetState(ProducerState::Active, peerReady_ ? "peer_ready" : "peer_check_disabled");
	if (!worker_.joinable()) {
		worker_ = std::thread(&Producer::WorkerMain, this);
	}
}

void Producer::SetPeerReady(bool ready, uint64_t sessionEpoch) {
	bool changed = false;
	{
		std::lock_guard<std::mutex> lock(mutex_);
		changed = peerReady_ != ready || peerSessionEpoch_ != sessionEpoch;
		peerReady_ = ready;
		peerSessionEpoch_ = sessionEpoch;
		if (changed) ++sessionEpoch_;
	}
	if (changed) {
		ProducerConfig config;
		uint8_t base = 1;
		{
			std::lock_guard<std::mutex> lock(mutex_);
			config = config_;
			base = runningBaseCodec_;
		}
		Configure(config, base);
	}
}

void Producer::NoteSeamAlive() {
	const int64_t now = static_cast<int64_t>(NowMilliseconds());
	// Relaxed is enough: a stale value only delays capture by a frame.
	if (now - seamAliveMs_.load(std::memory_order_relaxed) > 50) seamAliveMs_.store(now, std::memory_order_relaxed);
}

void Producer::NoteVideoFoveaBlank(bool cleared) {
	std::lock_guard<std::mutex> lock(mutex_);
	if (cleared) {
		++status_.videoFoveaCleared;
	} else {
		++status_.videoFoveaKept;
		MarkIssueLocked("video_fovea_kept");
	}
}

void Producer::OnStreamBoundary() {
	std::lock_guard<std::mutex> lock(mutex_);
	++sessionEpoch_;
	haveReady_ = false;
	ready_ = EncodedFrame{};
	lastTakenFrame_ = 0;
	seamAliveMs_.store(0, std::memory_order_relaxed);
}

bool Producer::WantsCapture() const {
	return wantsCapture_.load(std::memory_order_relaxed);
}

bool Producer::BeginFrame(const FrameMeta& meta, std::string* reason) {
	auto fail = [&](const char* why) {
		if (reason) *reason = why;
		return false;
	};
	if (!WantsCapture()) return fail("inactive");
	if (meta.eyeW < 64 || meta.eyeH < 64) return fail("eye_extent");
	if (meta.frameId == 0) return fail("no_frame_id");

	ProducerConfig config;
	uint64_t generation = 0;
	{
		std::lock_guard<std::mutex> lock(mutex_);
		// Recover from a partner eye that never arrived (frame dropped upstream) before the
		// busy check, otherwise a single lost eye wedges capture until the next reconfigure.
		if (frameInProgress_ && inflightMeta_.frameId + 4 < meta.frameId) {
			frameInProgress_ = false;
			inflightEye_[0] = false;
			inflightEye_[1] = false;
		}
		if (frameInProgress_ || jobPending_) {
			MarkIssueLocked("capture_busy");
			return fail("busy");
		}
		config = config_;
		generation = configGeneration_;
	}
	if (config.requireLiveSeam) {
		// No wrapped encoder is submitting (stream not started, or the hook arrived after
		// this stream's encoder was created): capturing would only burn GPU time.
		const int64_t seam = seamAliveMs_.load(std::memory_order_relaxed);
		if (seam == 0 || static_cast<int64_t>(NowMilliseconds()) - seam > 1000) {
			std::lock_guard<std::mutex> lock(mutex_);
			if (generation == configGeneration_) MarkIssueLocked("nvenc_seam_pending");
			return fail("nvenc_seam_pending");
		}
	}

	FoveaPlanRequest request;
	request.eyeW = meta.eyeW;
	request.eyeH = meta.eyeH;
	request.guardDegrees = static_cast<float>(config.guardDegrees);
	request.featherPx = static_cast<uint16_t>(std::max(0, config.featherPx));
	for (int eye = 0; eye < 2; ++eye) {
		request.eyes[eye].gazeX = meta.gazeX[eye];
		request.eyes[eye].gazeY = meta.gazeY[eye];
		request.eyes[eye].valid = meta.gazeValid[eye];
		request.eyes[eye].tanLeft = meta.tan[eye][0];
		request.eyes[eye].tanRight = meta.tan[eye][1];
		request.eyes[eye].tanTop = meta.tan[eye][2];
		request.eyes[eye].tanBottom = meta.tan[eye][3];
	}
	for (int i = 0; i < kRingCount; ++i) {
		request.rings[i].outerDegrees = static_cast<float>(config.ringDegrees[i]);
		request.rings[i].blockW = static_cast<uint8_t>(config.ringBlocks[i]);
		request.rings[i].blockH = static_cast<uint8_t>(config.ringBlocks[i]);
		request.rings[i].density = static_cast<float>(config.ringDensity[i]);
	}
	request.cropW = meta.cropW;
	request.cropH = meta.cropH;
	if (request.cropW == 0 && config.streamTileWidth > 0 && config.renderWidth > 0 && config.renderHeight > 0) {
		// W atlas pixels span W of the recommended render; scale to this app's eye tile.
		const double cropW = static_cast<double>(meta.eyeW) * config.streamTileWidth / config.renderWidth;
		const double cropH = static_cast<double>(meta.eyeH) * config.streamTileWidth / config.renderHeight;
		if (cropW < meta.eyeW) request.cropW = static_cast<uint16_t>(std::lround(cropW));
		if (cropH < meta.eyeH) request.cropH = static_cast<uint16_t>(std::lround(cropH));
	}

	FoveaPlan plan;
	std::string error;
	if (!BuildFoveaPlan(request, plan, &error)) {
		// Invalid/stale gaze or an unrepresentable plan disables the rings for this frame.
		std::lock_guard<std::mutex> lock(mutex_);
		if (generation == configGeneration_) MarkIssueLocked(error == "invalid_gaze" ? "gaze_invalid" : "plan_rejected");
		return fail(error.c_str());
	}

	uint64_t plannedBytes = 0;
	const char* refusal = nullptr;
	if (plan.canvasW > kMaxCanvasPixels || plan.canvasH > kMaxCanvasPixels) refusal = "canvas_too_large";
	if (config.foveaCodec == 1) {
		const uint64_t tableBytes = kFoveaUnitHeaderBytes + plan.patches.size() * kPatchEntryBytes;
		plannedBytes = EstimateAstcBytes(plan) + tableBytes;
		for (const PlannedPatch& patch : plan.patches) {
			const uint64_t paddedW = (patch.texelW + patch.blockW - 1u) / patch.blockW * patch.blockW;
			const uint64_t paddedH = (patch.texelH + patch.blockH - 1u) / patch.blockH * patch.blockH;
			if (paddedW * paddedH > kMaxPatchPixels) refusal = "patch_too_large";
		}
		if (!refusal && plannedBytes > static_cast<uint64_t>(config.maxFoveaBytes)) refusal = "fovea_budget";
	} else {
		ReplaceWithWholeEyePatches(plan, request);
		// Each eye is one wavelet image, padded like the decoder pads it.
		const uint64_t alignedW = std::max<uint32_t>(PwAlign(plan.canvasW, 32), 128u);
		const uint64_t alignedH = std::max<uint32_t>(PwAlign(plan.canvasH, 32), 128u);
		if (alignedW * alignedH > kMaxPatchPixels) refusal = "pyrowave_canvas_too_large";
	}
	{
		std::lock_guard<std::mutex> lock(mutex_);
		if (generation == configGeneration_) {
			status_.canvasW = plan.canvasW;
			status_.canvasH = plan.canvasH;
			status_.cropW = request.cropW;
			status_.cropH = request.cropH;
			status_.plannedBytes = plannedBytes;
			if (refusal) MarkIssueLocked(refusal);
		}
	}
	if (refusal) return fail(refusal);

	std::lock_guard<std::mutex> lock(mutex_);
	if (generation != configGeneration_) return fail("reconfigured");
	if (frameInProgress_ || jobPending_) return fail("busy");
	inflightMeta_ = meta;
	inflightPlan_ = std::move(plan);
	inflightEpoch_ = sessionEpoch_;
	inflightGeneration_ = generation;
	inflightEye_[0] = false;
	inflightEye_[1] = false;
	frameInProgress_ = true;
	return true;
}

bool Producer::SubmitEye(int eye, const uint8_t* rgba, int strideBytes, int width, int height, bool bgra) {
	if (eye < 0 || eye > 1 || !rgba) return false;
	std::lock_guard<std::mutex> lock(mutex_);
	if (!frameInProgress_) return false;
	if (width != inflightPlan_.canvasW || height != inflightPlan_.canvasH) return false;
	if (strideBytes < width * 4) return false;
	if (!inflightEye_[0] && !inflightEye_[1]) {
		pending_.meta = inflightMeta_;
		pending_.plan = inflightPlan_;
		pending_.epoch = inflightEpoch_;
		pending_.generation = inflightGeneration_;
		pending_.config = config_;
	}
	// Copy this eye's canvas; the other eye arrives in its own call.
	std::vector<uint8_t>& dst = pending_.eyes[eye];
	dst.resize(static_cast<size_t>(width) * height * 4u);
	const size_t rowBytes = static_cast<size_t>(width) * 4u;
	for (int y = 0; y < height; ++y) {
		uint8_t* row = dst.data() + static_cast<size_t>(y) * rowBytes;
		std::memcpy(row, rgba + static_cast<size_t>(y) * strideBytes, rowBytes);
		if (bgra) {
			for (size_t x = 0; x < rowBytes; x += 4) std::swap(row[x], row[x + 2]);
		}
	}
	pending_.haveEye[eye] = true;
	inflightEye_[eye] = true;
	if (inflightEye_[0] && inflightEye_[1]) {
		jobPending_ = true;
		frameInProgress_ = false;
		wake_.notify_one();
	}
	return true;
}

bool Producer::SubmitGpuCanvas(const GpuCanvasRef& canvas, int width, int height) {
	if (!canvas.handle) return false;
	std::lock_guard<std::mutex> lock(mutex_);
	if (!frameInProgress_ || inflightEye_[0] || inflightEye_[1]) return false;
	if (width != inflightPlan_.canvasW || height != inflightPlan_.canvasH) return false;
	pending_.meta = inflightMeta_;
	pending_.plan = inflightPlan_;
	pending_.epoch = inflightEpoch_;
	pending_.generation = inflightGeneration_;
	pending_.config = config_;
	pending_.gpu = canvas;
	pending_.haveEye[0] = pending_.haveEye[1] = true;
	inflightEye_[0] = inflightEye_[1] = true;
	jobPending_ = true;
	frameInProgress_ = false;
	wake_.notify_one();
	return true;
}

void Producer::AbortFrame() {
	std::lock_guard<std::mutex> lock(mutex_);
	if (!frameInProgress_) return;
	frameInProgress_ = false;
	inflightEye_[0] = inflightEye_[1] = false;
	pending_ = Job{};
}

void Producer::NoteCapturePath(const char* path) {
	std::lock_guard<std::mutex> lock(mutex_);
	status_.capturePath = path ? path : "";
}

void Producer::WorkerMain() {
	for (;;) {
		Job job;
		{
			std::unique_lock<std::mutex> lock(mutex_);
			wake_.wait(lock, [&] { return stop_ || jobPending_; });
			if (stop_) return;
			job = std::move(pending_);
			pending_ = Job{};
			jobPending_ = false;
		}
		EncodedFrame frame;
		EncodeJob(job, frame);
		if (frame.frameId != 0) {
			std::lock_guard<std::mutex> lock(mutex_);
			// Only publish if this job still belongs to the live configuration and the
			// producer is still admitting frames: a disable/reconfigure in the meantime
			// must not resurrect an old fovea.
			if (job.generation == configGeneration_ &&
			    (status_.state == ProducerState::Active || status_.state == ProducerState::Degraded) &&
			    (!haveReady_ || frame.frameId >= ready_.frameId)) {
				if (haveReady_) ++status_.staleFovea;  // replaced before its base was locked
				ready_ = std::move(frame);
				readyGeneration_ = job.generation;
				haveReady_ = true;
			}
		}
	}
}

bool Producer::CommitIfCurrent(uint64_t frameId, const std::function<void()>& commit) {
	std::lock_guard<std::mutex> lock(mutex_);
	if (frameId == 0 || frameId != lastTakenFrame_) return false;
	if (readyGeneration_ != configGeneration_) return false;
	if (status_.state != ProducerState::Active && status_.state != ProducerState::Degraded) return false;
	commit();
	lastWrappedEpoch_ = sessionEpoch_;
	++status_.joinedFrames;
	status_.state = ProducerState::Active;
	status_.reason = "ok";
	return true;
}

void Producer::EncodeJob(Job& job, EncodedFrame& out) {
	const ProducerConfig& config = job.config;
	const double start = NowMilliseconds();
	const size_t patchCount = job.plan.patches.size();
	const size_t tableBytes = kFoveaUnitHeaderBytes + patchCount * kPatchEntryBytes;
	auto degrade = [&](const char* reason, const char* backend) {
		std::lock_guard<std::mutex> lock(mutex_);
		if (job.generation != configGeneration_) return;
		if (backend) status_.backend = backend;
		++status_.encodeFailures;
		MarkIssueLocked(reason);
	};
	if (!job.gpu.handle && (job.eyes[0].empty() || job.eyes[1].empty())) {
		degrade("missing_eye", nullptr);
		return;
	}

	FoveaUnitHeader unit{};
	unit.canvasW = job.plan.canvasW;
	unit.canvasH = job.plan.canvasH;
	unit.patchCount = static_cast<uint8_t>(patchCount);
	unit.foveaCodec = static_cast<uint8_t>(config.foveaCodec == 2 ? kFoveaCodecPyroWave : kFoveaCodecAstc);
	unit.precision = kFoveaPrecisionRgb8;
	unit.featherPx = job.plan.featherPx;
	unit.mappingEpoch = static_cast<uint32_t>(job.epoch);
	for (int eye = 0; eye < 2; ++eye) {
		EyeMapping& mapping = unit.eyes[eye];
		const EyeGazeInput& input = job.plan.eyes[eye];
		mapping.sourceW = job.plan.eyeW;
		mapping.sourceH = job.plan.eyeH;
		mapping.originX = job.plan.eyeOriginX[eye];
		mapping.originY = job.plan.eyeOriginY[eye];
		mapping.tanLeft = input.tanLeft;
		mapping.tanRight = input.tanRight;
		mapping.tanTop = input.tanTop;
		mapping.tanBottom = input.tanBottom;
		mapping.gazeX = input.gazeX;
		mapping.gazeY = input.gazeY;
	}

	std::vector<PatchEntry> entries(patchCount);
	std::vector<std::vector<uint8_t>> encoded(patchCount);
	std::vector<uint8_t> patchOk(patchCount, 0);
	std::vector<uint8_t> patchOverBudget(patchCount, 0);
	const char* backend = nullptr;

	if (config.foveaCodec == 1) {
		const AstcBatchEncoderFn batchEncoder = GetAstcBatchEncoder();
		if (batchEncoder) {
			// Hardware path: one submission for the whole frame, compressed readback only. A
			// failure here is a visible quality failure, never a silent CPU substitution.
			backend = "astc_gpu";
			AstcBatchRequest request;
			request.canvas[0] = job.gpu.handle ? nullptr : job.eyes[0].data();
			request.canvas[1] = job.gpu.handle ? nullptr : job.eyes[1].data();
			request.gpuCanvas = job.gpu;
			request.canvasW = job.plan.canvasW;
			request.canvasH = job.plan.canvasH;
			request.patches = job.plan.patches.data();
			request.patchCount = patchCount;
			request.output = &encoded;
			std::string gpuError;
			if (!batchEncoder(request, &gpuError)) {
				degrade("astc_gpu_failed", backend);
				return;
			}
			for (size_t i = 0; i < patchCount; ++i) patchOk[i] = encoded[i].empty() ? 0 : 1;
		} else if (config.allowCpuAstcReference && !job.gpu.handle) {
			// CPU reference encoder: explicit test/bench path. Patches are independent: fan
			// them out over cores, then assemble in order.
			backend = "astc_cpu_test";
			auto encodeOne = [&](size_t i) {
				const PlannedPatch& patch = job.plan.patches[i];
				std::vector<uint8_t> rgb;
				int rgbW = 0, rgbH = 0;
				CropToRgb(job.eyes[patch.eye].data(), job.plan.canvasW, job.plan.canvasH, patch, rgb, rgbW, rgbH);
				if (AstcEncodeRgb(rgb.data(), static_cast<size_t>(rgbW) * 3u, rgbW, rgbH, patch.blockW, patch.blockH,
				                  encoded[i])) {
					patchOk[i] = 1;
				}
			};
			unsigned threadCount = std::thread::hardware_concurrency();
			if (threadCount == 0) threadCount = 1;
			threadCount = std::min<unsigned>(threadCount, static_cast<unsigned>(patchCount));
			threadCount = std::min<unsigned>(threadCount, 8);
			if (threadCount <= 1) {
				for (size_t i = 0; i < patchCount; ++i) encodeOne(i);
			} else {
				std::vector<std::thread> workers;
				workers.reserve(threadCount);
				for (unsigned t = 0; t < threadCount; ++t) {
					workers.emplace_back([&, t] {
						for (size_t i = t; i < patchCount; i += threadCount) encodeOne(i);
					});
				}
				for (std::thread& worker : workers) worker.join();
			}
		} else {
			// No registered GPU encoder (startup race or released device). Never burn the
			// CPU reference encoder on a production frame.
			degrade("astc_gpu_unavailable", "astc_gpu");
			return;
		}
	} else {
		// PyroWave runs on the CPU in this build: one ring-weighted transform per eye, the
		// two eyes in parallel. A GPU canvas is read back here, on the worker.
		backend = "pyrowave_cpu";
		if (job.gpu.handle) {
			const GpuCanvasReaderFn reader = GetGpuCanvasReader();
			std::string readError;
			if (!reader || !reader(job.gpu, job.plan.canvasW, job.plan.canvasH, job.eyes, &readError)) {
				degrade("gpu_canvas_read_failed", backend);
				return;
			}
		}
		PyroWaveRingWeights weights[2];
		for (int eye = 0; eye < 2; ++eye) {
			weights[eye].plan = &job.plan;
			weights[eye].eye = eye;
			for (int ring = 0; ring < kRingCount; ++ring) {
				weights[eye].multiplier[ring] = static_cast<float>(config.ringBlocks[ring]) / 4.0f;
				weights[eye].density[ring] = static_cast<float>(config.ringDensity[ring]);
			}
		}
		const uint64_t payloadBudget =
			static_cast<uint64_t>(config.maxFoveaBytes) > tableBytes ? config.maxFoveaBytes - tableBytes : 0;
		auto encodeEye = [&](size_t i) {
			const PlannedPatch& patch = job.plan.patches[i];
			std::vector<uint8_t> rgb;
			int rgbW = 0, rgbH = 0;
			CropToRgb(job.eyes[patch.eye].data(), job.plan.canvasW, job.plan.canvasH, patch, rgb, rgbW, rgbH);
			PwEncodeOptions options;
			options.maxBytes = static_cast<uint32_t>(std::max<uint64_t>(1, payloadBudget / patchCount));
			options.stepScale = &PyroWaveStepScale;
			options.stepContext = &weights[patch.eye];
			PwStats stats;
			if (!PwEncodeRgb(rgb.data(), static_cast<size_t>(rgbW) * 3u, rgbW, rgbH, options, encoded[i], &stats)) {
				return;
			}
			if (stats.budgetExceeded) {
				patchOverBudget[i] = 1;
				return;
			}
			patchOk[i] = 1;
		};
		if (patchCount == 2) {
			std::thread second(encodeEye, 1);
			encodeEye(0);
			second.join();
		} else {
			for (size_t i = 0; i < patchCount; ++i) encodeEye(i);
		}
	}

	std::vector<uint8_t> payload;
	for (size_t i = 0; i < patchCount; ++i) {
		if (patchOverBudget[i]) {
			degrade("pyrowave_budget", backend);
			return;
		}
		if (!patchOk[i]) {
			degrade("encode_failed", backend);
			return;  // incomplete frame: never emit a partial unit
		}
		const PlannedPatch& patch = job.plan.patches[i];
		PatchEntry& entry = entries[i];
		entry.payloadBytes = static_cast<uint32_t>(encoded[i].size());
		entry.payloadOffset = static_cast<uint32_t>(tableBytes + payload.size());
		entry.x = patch.x;
		entry.y = patch.y;
		entry.width = patch.width;
		entry.height = patch.height;
		entry.eye = patch.eye;
		entry.annulus = patch.annulus;
		entry.blockW = patch.blockW;
		entry.blockH = patch.blockH;
		entry.codec = unit.foveaCodec;
		// Texels are declared only when resampled; native patches keep 0.
		const bool resampled = patch.texelW != patch.width || patch.texelH != patch.height;
		entry.texelW = resampled ? patch.texelW : 0;
		entry.texelH = resampled ? patch.texelH : 0;
		entry.sourceEpoch = static_cast<uint32_t>(job.epoch);
		entry.innerRadiusPx = patch.innerRadiusPx;
		entry.outerRadiusPx = patch.outerRadiusPx;
		entry.gutters = 0;
		entry.innerDegrees = patch.innerDegrees;
		entry.outerDegrees = patch.outerDegrees;
		entry.reserved1 = 0;
		payload.insert(payload.end(), encoded[i].begin(), encoded[i].end());
	}

	const uint64_t totalBytes = tableBytes + payload.size();
	if (totalBytes > static_cast<uint64_t>(config.maxFoveaBytes)) {
		degrade("fovea_budget", backend);
		return;
	}

	unit.unitBytes = static_cast<uint32_t>(totalBytes);
	out.frameId = job.meta.frameId;
	out.ptsNs = job.meta.ptsNs;
	out.canvasW = job.plan.canvasW;
	out.canvasH = job.plan.canvasH;
	out.codec = unit.foveaCodec;
	out.patchCount = static_cast<uint8_t>(patchCount);
	out.unit.resize(static_cast<size_t>(totalBytes));
	std::memcpy(out.unit.data(), &unit, sizeof(unit));
	std::memcpy(out.unit.data() + kFoveaUnitHeaderBytes, entries.data(), patchCount * kPatchEntryBytes);
	std::memcpy(out.unit.data() + tableBytes, payload.data(), payload.size());
	out.encodeMs = NowMilliseconds() - start;

	{
		std::lock_guard<std::mutex> lock(mutex_);
		if (job.generation != configGeneration_) {
			out = EncodedFrame{};
			return;
		}
		status_.backend = backend;
		status_.patchCount = static_cast<uint32_t>(patchCount);
		status_.foveaBytes = static_cast<uint32_t>(totalBytes);
		status_.encodeMs = out.encodeMs;
		status_.lastFrameId = out.frameId;
		++status_.frames;
		if (out.encodeMs > kFrameBudgetMs) MarkIssueLocked("encode_over_budget");
	}
}

bool Producer::TakeReady(uint64_t baseFrameId, EncodedFrame& out) {
	std::lock_guard<std::mutex> lock(mutex_);
	if (status_.state != ProducerState::Active && status_.state != ProducerState::Degraded) return false;
	if (haveReady_ && readyGeneration_ != configGeneration_) {
		ready_ = EncodedFrame{};
		haveReady_ = false;
	}
	if (baseFrameId == 0) {
		++status_.unmappedFrames;
		MarkBaseOnlyLocked("base_unmapped");
		return false;
	}
	if (haveReady_ && ready_.frameId < baseFrameId) {
		// Finished after its own base was already locked: it can never be attached.
		++status_.staleFovea;
		ready_ = EncodedFrame{};
		haveReady_ = false;
	}
	if (!haveReady_ || ready_.frameId != baseFrameId || ready_.frameId <= lastTakenFrame_) {
		// No fovea for this exact frame (still encoding, not captured, or rejected). The base
		// is transmitted untouched; a fovea for a newer frame stays for its own base.
		++status_.lateFrames;
		MarkBaseOnlyLocked("fovea_late");
		return false;
	}
	out = std::move(ready_);
	ready_ = EncodedFrame{};
	haveReady_ = false;
	lastTakenFrame_ = out.frameId;
	return true;
}

bool Producer::AcceptsLiveBase(uint8_t liveBase) {
	std::lock_guard<std::mutex> lock(mutex_);
	if (liveBase == runningBaseCodec_) return true;
	MarkBaseOnlyLocked(liveBase == 0 ? "base_codec_unknown" : "base_codec_live_mismatch");
	return false;
}

ProducerStatus Producer::Snapshot() const {
	std::lock_guard<std::mutex> lock(mutex_);
	return status_;
}

bool Producer::BlocksStream() const {
	std::lock_guard<std::mutex> lock(mutex_);
	// Configure() only reports Off when hybrid is disabled, so Rejected always means a mode was
	// selected and cannot run.
	return status_.state == ProducerState::Rejected;
}

bool Producer::WrapAccessUnit(const uint8_t* au, size_t auBytes, uint8_t baseFormat, const EncodedFrame& fovea,
                              std::vector<uint8_t>& out, EnvelopeHeader& header) {
	if (!au || auBytes == 0 || fovea.unit.size() < kFoveaUnitHeaderBytes) return false;
	const size_t foveaBytes = fovea.unit.size();
	if (foveaBytes > kMaxFoveaBytes || auBytes > kMaxBaseBytes) return false;
	FoveaUnitHeader unitIn{};
	std::memcpy(&unitIn, fovea.unit.data(), sizeof(unitIn));
	if (unitIn.unitBytes != foveaBytes) return false;
	uint8_t baseCodec = 1;
	bool reset = false;
	{
		std::lock_guard<std::mutex> lock(mutex_);
		baseCodec = runningBaseCodec_;
		// The first envelope of every session epoch tells the client to drop state cached
		// for the previous one; without it a client that pinned the old epoch rejects them.
		reset = lastWrappedEpoch_ != unitIn.mappingEpoch;
	}

	EnvelopeHeader h{};
	h.magic = kMagic;
	h.versionMajor = kVersionMajor;
	h.versionMinor = kVersionMinor;
	h.headerBytes = kHeaderBytes;
	h.flags = static_cast<uint16_t>(kFlagFoveaPresent | (reset ? kFlagReset : 0));  // rings are lossy: never exact
	h.sessionEpoch = unitIn.mappingEpoch;
	h.sourceEpoch = unitIn.mappingEpoch;
	h.mappingEpoch = unitIn.mappingEpoch;
	h.frameId = fovea.frameId;
	h.ptsNs = fovea.ptsNs;
	h.baseBytes = static_cast<uint32_t>(auBytes);
	h.foveaBytes = static_cast<uint32_t>(foveaBytes);
	h.baseOffset = kHeaderBytes;
	h.foveaOffset = kHeaderBytes + static_cast<uint32_t>(auBytes);
	h.baseCodec = static_cast<uint8_t>(baseCodec == 2 ? kBaseCodecAv1 : kBaseCodecHevc);
	h.baseFormat = baseFormat;
	h.foveaCodec = fovea.codec;
	h.precision = kFoveaPrecisionRgb8;
	h.canvasW = fovea.canvasW;
	h.canvasH = fovea.canvasH;
	h.patchCount = fovea.patchCount;
	h.featherPx = unitIn.featherPx;
	h.reserved0 = 0;

	out.resize(kHeaderBytes + auBytes + foveaBytes);
	std::memcpy(out.data(), &h, sizeof(h));
	std::memcpy(out.data() + h.baseOffset, au, auBytes);
	std::memcpy(out.data() + h.foveaOffset, fovea.unit.data(), foveaBytes);

	EnvelopeHeader* written = reinterpret_cast<EnvelopeHeader*>(out.data());
	written->crc32 = 0;
	uint32_t crc = Crc32(out.data(), sizeof(EnvelopeHeader));
	crc = Crc32(out.data() + h.baseOffset, h.baseBytes, crc);
	crc = Crc32(out.data() + h.foveaOffset, h.foveaBytes, crc);
	written->crc32 = crc;
	header = *written;
	return true;
}

}  // namespace gxh1
