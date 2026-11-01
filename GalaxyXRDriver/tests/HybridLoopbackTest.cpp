// End-to-end loopback: producer plan -> worker encode -> GXH1 envelope -> client parser ->
// per-patch decode. Proves the wire and both codecs agree without NVENC, D3D11 or a device.
#include "../src/Hybrid/AstcSubset.h"
#include "../src/Hybrid/FoveaPlanner.h"
#include "../src/Hybrid/Gxh1Codec.h"
#include "../src/Hybrid/HybridProducer.h"
#include "../src/Hybrid/PyroWaveCpu.h"

#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

namespace {
int checks = 0;
int failures = 0;

void Check(bool ok, const std::string& message) {
	++checks;
	if (!ok) {
		++failures;
		std::fprintf(stderr, "FAIL: %s\n", message.c_str());
	}
}

double Psnr(const uint8_t* a, const uint8_t* b, size_t count) {
	double sse = 0.0;
	for (size_t i = 0; i < count; ++i) {
		const double d = static_cast<double>(a[i]) - static_cast<double>(b[i]);
		sse += d * d;
	}
	if (sse <= 0.0) return 99.0;
	return 10.0 * std::log10((255.0 * 255.0) / (sse / count));
}

// Synthetic eye canvas: a fine-detail pattern that defeats block alignment.
std::vector<uint8_t> MakeCanvas(int width, int height, int phase) {
	std::vector<uint8_t> rgba(static_cast<size_t>(width) * height * 4u, 255);
	for (int y = 0; y < height; ++y) {
		for (int x = 0; x < width; ++x) {
			const bool ink = ((x + phase) % 11 < 3) || ((y + phase) % 13 < 2);
			uint8_t* p = rgba.data() + (static_cast<size_t>(y) * width + x) * 4u;
			p[0] = ink ? 12 : 238;
			p[1] = ink ? 18 : 240;
			p[2] = ink ? 26 : 244;
			p[3] = 255;
		}
	}
	return rgba;
}

void RunCase(int foveaCodec, const char* label) {
	gxh1::ProducerConfig config;
	config.enabled = true;
	config.foveaCodec = foveaCodec;
	config.baseCodec = 1;
	config.requireReadyPeer = false;
	config.maxFoveaBytes = 8 * 1024 * 1024;
	// No D3D11 encoder is registered in this harness; the CPU reference is opted in here only.
	config.allowCpuAstcReference = true;
	gxh1::Producer::Get().Configure(config, 1);
	Check(gxh1::Producer::Get().WantsCapture(), std::string(label) + ": producer active");

	const int eyeW = 512;
	const int eyeH = 512;
	gxh1::FrameMeta meta;
	meta.eyeW = static_cast<uint16_t>(eyeW);
	meta.eyeH = static_cast<uint16_t>(eyeH);
	meta.frameId = 42 + static_cast<uint64_t>(foveaCodec);
	meta.ptsNs = 1234567;
	for (int eye = 0; eye < 2; ++eye) {
		meta.gazeValid[eye] = true;
		meta.gazeX[eye] = 256.0f + eye * 4.0f;
		meta.gazeY[eye] = 250.0f;
		meta.tan[eye][0] = -1.0f;
		meta.tan[eye][1] = 1.0f;
		meta.tan[eye][2] = -1.0f;
		meta.tan[eye][3] = 1.0f;
	}
	std::string reason;
	Check(gxh1::Producer::Get().BeginFrame(meta, &reason), std::string(label) + ": begin frame (" + reason + ")");
	const gxh1::FoveaPlan* plan = gxh1::Producer::Get().InflightPlan();
	Check(plan != nullptr && plan->canvasW > 0, std::string(label) + ": plan exists");
	if (!plan || plan->canvasW == 0) return;

	const std::vector<uint8_t> eyes[2] = {MakeCanvas(eyeW, eyeH, 0), MakeCanvas(eyeW, eyeH, 5)};
	std::vector<uint8_t> canvas[2];
	for (int eye = 0; eye < 2; ++eye) {
		canvas[eye].resize(static_cast<size_t>(plan->canvasW) * plan->canvasH * 4u);
		for (int y = 0; y < plan->canvasH; ++y) {
			const size_t sourceOffset =
				(static_cast<size_t>(plan->eyeOriginY[eye] + y) * eyeW + plan->eyeOriginX[eye]) * 4u;
			std::memcpy(canvas[eye].data() + static_cast<size_t>(y) * plan->canvasW * 4u,
			            eyes[eye].data() + sourceOffset, static_cast<size_t>(plan->canvasW) * 4u);
		}
		Check(gxh1::Producer::Get().SubmitEye(eye, canvas[eye].data(), plan->canvasW * 4, plan->canvasW,
		                                      plan->canvasH),
		      std::string(label) + ": submit eye");
	}

	gxh1::EncodedFrame frame;
	for (int attempt = 0; attempt < 6000 && !gxh1::Producer::Get().TakeReady(meta.frameId, frame); ++attempt) {
		std::this_thread::sleep_for(std::chrono::milliseconds(5));
	}
	if (frame.unit.empty()) {
		const gxh1::ProducerStatus status = gxh1::Producer::Get().Snapshot();
		std::printf("  %s: no unit; state=%d reason=%s frames=%llu degraded=%llu encodeMs=%.2f\n", label,
		            static_cast<int>(status.state), status.reason.c_str(),
		            static_cast<unsigned long long>(status.frames),
		            static_cast<unsigned long long>(status.degradedFrames), status.encodeMs);
	}
	Check(!frame.unit.empty(), std::string(label) + ": worker produced a fovea unit");
	if (frame.unit.empty()) return;
	std::printf("  %s: %u patches, %zu fovea bytes, %.2f ms\n", label, static_cast<unsigned>(frame.patchCount),
	            frame.unit.size(), frame.encodeMs);

	const std::vector<uint8_t> base(1024, 0x5A);
	std::vector<uint8_t> wire;
	gxh1::EnvelopeHeader header{};
	Check(gxh1::Producer::Get().WrapAccessUnit(base.data(), base.size(), gxh1::kBaseFormatNv12, frame, wire, header),
	      std::string(label) + ": envelope built");
	Check(header.frameId == meta.frameId, std::string(label) + ": envelope carries the base frame id");
	// The first envelope of a session epoch carries the reset flag; once committed, the next
	// envelope of the same epoch does not.
	Check((header.flags & gxh1::kFlagReset) != 0, std::string(label) + ": first envelope of the epoch resets");
	Check(gxh1::Producer::Get().CommitIfCurrent(frame.frameId, [] {}), std::string(label) + ": commit gate");
	{
		std::vector<uint8_t> again;
		gxh1::EnvelopeHeader againHeader{};
		gxh1::Producer::Get().WrapAccessUnit(base.data(), base.size(), gxh1::kBaseFormatNv12, frame, again, againHeader);
		Check((againHeader.flags & gxh1::kFlagReset) == 0, std::string(label) + ": later envelope keeps the epoch");
	}

	gxh1::ParsedFrame parsed;
	gxh1::ParseLimits limits;
	limits.maxFoveaBytes = 8 * 1024 * 1024;
	const gxh1::ParseError error = gxh1::ParseFrame(wire.data(), wire.size(), limits, parsed);
	if (error != gxh1::ParseError::None) {
		const gxh1::FoveaUnitHeader* unit = reinterpret_cast<const gxh1::FoveaUnitHeader*>(
			wire.data() + header.foveaOffset);
		std::printf("  %s: parse %s header(s=%llu src=%llu map=%llu) unit(map=%u bytes=%u) firstEntry(src=%u)\n",
		            label, gxh1::ParseErrorName(error), static_cast<unsigned long long>(header.sessionEpoch),
		            static_cast<unsigned long long>(header.sourceEpoch),
		            static_cast<unsigned long long>(header.mappingEpoch), unit->mappingEpoch, unit->unitBytes,
		            reinterpret_cast<const gxh1::PatchEntry*>(reinterpret_cast<const uint8_t*>(unit) +
		                                                       gxh1::kFoveaUnitHeaderBytes)->sourceEpoch);
	}
	Check(error == gxh1::ParseError::None, std::string(label) + ": client parse (" + gxh1::ParseErrorName(error) + ")");
	if (error != gxh1::ParseError::None) return;
	Check(parsed.base == wire.data() + header.baseOffset && parsed.base[0] == 0x5A,
	      std::string(label) + ": base AU preserved");
	Check(parsed.patches.size() == plan->patches.size(), std::string(label) + ": patch count matches");
	for (int eye = 0; eye < 2; ++eye) {
		const gxh1::EyeMapping& mapping = parsed.unit->eyes[eye];
		Check(mapping.sourceW == eyeW && mapping.sourceH == eyeH && mapping.originX == plan->eyeOriginX[eye] &&
		          mapping.originY == plan->eyeOriginY[eye] && mapping.gazeX == meta.gazeX[eye] &&
		          mapping.tanLeft == -1.0f && mapping.tanBottom == 1.0f,
		      std::string(label) + ": eye mapping carries the plan placement");
	}
	if (foveaCodec == 2) {
		Check(parsed.patches.size() == 2, std::string(label) + ": one ring-weighted transform per eye");
	}

	double worst = 99.0;
	for (size_t i = 0; i < parsed.patches.size() && i < plan->patches.size(); ++i) {
		const gxh1::ParsedPatch& patch = parsed.patches[i];
		const gxh1::PlannedPatch& planned = plan->patches[i];
		std::vector<uint8_t> rgb;
		int width = 0, height = 0;
		bool decoded = false;
		if (patch.entry.codec == gxh1::kFoveaCodecAstc) {
			decoded = gxh1::AstcDecodeRgb(patch.payload, patch.entry.payloadBytes, planned.width, planned.height,
			                              planned.blockW, planned.blockH, rgb);
			width = planned.width;
			height = planned.height;
		} else {
			decoded = gxh1::PwDecodeRgb(patch.payload, patch.entry.payloadBytes, rgb, width, height);
		}
		if (!decoded) {
			Check(false, std::string(label) + ": patch decodes");
			continue;
		}
		Check(width == planned.width && height == planned.height, std::string(label) + ": patch dimensions");

		// Compare against the matching source region (edge-clamped like the encoder).
		std::vector<uint8_t> source(static_cast<size_t>(planned.width) * planned.height * 3u);
		for (int y = 0; y < planned.height; ++y) {
			for (int x = 0; x < planned.width; ++x) {
				const uint8_t* p =
					canvas[patch.entry.eye].data() +
					(static_cast<size_t>(planned.y + y) * plan->canvasW + planned.x + x) * 4u;
				uint8_t* d = source.data() + (static_cast<size_t>(y) * planned.width + x) * 3u;
				d[0] = p[0];
				d[1] = p[1];
				d[2] = p[2];
			}
		}
		const double psnr = Psnr(source.data(), rgb.data(), source.size());
		worst = std::min(worst, psnr);
		if (i < 3) {
			// Transposed comparison distinguishes a layout bug from a codec bug.
			std::vector<uint8_t> transposed(source.size());
			for (int y = 0; y < planned.height; ++y)
				for (int x = 0; x < planned.width; ++x)
					for (int c = 0; c < 3; ++c)
						transposed[(static_cast<size_t>(x) * planned.height + y) * 3 + c] =
							source[(static_cast<size_t>(y) * planned.width + x) * 3 + c];
			std::printf("  %s: patch%zu %ux%u b%ux%u psnr %.2f transposed %.2f\n", label, i, planned.width,
			            planned.height, planned.blockW, planned.blockH, psnr,
			            Psnr(transposed.data(), rgb.data(), source.size()));
		}
		Check(psnr > 8.0, std::string(label) + ": patch psnr " + std::to_string(psnr));
		if (planned.blockW == 4 && planned.blockH == 4) {
			// The 4x4 core has a per-texel weight grid and must stay near-exact.
			Check(psnr >= 40.0, std::string(label) + ": 4x4 core psnr " + std::to_string(psnr));
		}
	}
	std::printf("  %s: worst patch PSNR %.2f dB\n", label, worst);
}

}  // namespace

// Base/fovea join: a fovea is attached only to the access unit of its own scene frame.
void RunJoinCase() {
	gxh1::ProducerConfig config;
	config.enabled = true;
	config.foveaCodec = 1;
	config.baseCodec = 1;
	config.requireReadyPeer = false;
	config.allowCpuAstcReference = true;
	gxh1::Producer& producer = gxh1::Producer::Get();
	producer.Configure(config, 1);
	const int eyeW = 256, eyeH = 256;
	auto encodeFrame = [&](uint64_t frameId) {
		gxh1::FrameMeta meta;
		meta.eyeW = static_cast<uint16_t>(eyeW);
		meta.eyeH = static_cast<uint16_t>(eyeH);
		meta.frameId = frameId;
		for (int eye = 0; eye < 2; ++eye) {
			meta.gazeValid[eye] = true;
			meta.gazeX[eye] = 128.0f;
			meta.gazeY[eye] = 128.0f;
			meta.tan[eye][0] = -1.0f;
			meta.tan[eye][1] = 1.0f;
			meta.tan[eye][2] = -1.0f;
			meta.tan[eye][3] = 1.0f;
		}
		std::string reason;
		const uint64_t before = producer.Snapshot().frames;
		if (!producer.BeginFrame(meta, &reason)) return false;
		const gxh1::FoveaPlan* plan = producer.InflightPlan();
		const std::vector<uint8_t> canvas = MakeCanvas(plan->canvasW, plan->canvasH, static_cast<int>(frameId));
		for (int eye = 0; eye < 2; ++eye) {
			if (!producer.SubmitEye(eye, canvas.data(), plan->canvasW * 4, plan->canvasW, plan->canvasH)) return false;
		}
		for (int attempt = 0; attempt < 6000 && producer.Snapshot().frames == before; ++attempt) {
			std::this_thread::sleep_for(std::chrono::milliseconds(2));
		}
		return producer.Snapshot().frames > before;
	};
	gxh1::EncodedFrame frame;
	Check(encodeFrame(100), "join: frame 100 encoded");
	Check(!producer.TakeReady(99, frame), "join: an older base never takes a newer fovea");
	Check(!producer.TakeReady(0, frame), "join: an unmapped base never takes a fovea");
	Check(producer.TakeReady(100, frame) && frame.frameId == 100, "join: the matching base takes its fovea");
	Check(!producer.TakeReady(100, frame), "join: a fovea is attached once");
	Check(encodeFrame(110), "join: frame 110 encoded");
	Check(!producer.TakeReady(111, frame), "join: a newer base never takes an older fovea");
	Check(!producer.TakeReady(110, frame), "join: a fovea whose base already passed is discarded");
	const gxh1::ProducerStatus status = producer.Snapshot();
	Check(status.staleFovea >= 1 && status.unmappedFrames >= 1 && status.lateFrames >= 3,
	      "join: late/stale/unmapped outcomes are counted");
	// The fovea tile from the applied stream settings clips planning: W atlas pixels of a
	// 3552-wide recommended render scale to this 256-pixel eye tile.
	config.streamTileWidth = 1536;
	config.renderWidth = 3552;
	config.renderHeight = 3840;
	producer.Configure(config, 1);
	Check(encodeFrame(115), "crop: frame encoded with a fovea-tile crop");
	{
		const gxh1::ProducerStatus cropped = producer.Snapshot();
		Check(cropped.cropW == 111 && cropped.cropH == 102 && cropped.canvasW <= 111 && cropped.canvasH <= 102,
		      "crop: canvas limited to the stream's fovea tile (" + std::to_string(cropped.canvasW) + "x" +
		          std::to_string(cropped.canvasH) + ")");
	}
	config.streamTileWidth = 0;

	// A plan over the byte budget is refused before capture and still publishes its cost.
	config.maxFoveaBytes = 1000;
	producer.Configure(config, 1);
	Check(!encodeFrame(120), "budget: an over-budget plan is not captured");
	const gxh1::ProducerStatus refused = producer.Snapshot();
	Check(refused.reason == "fovea_budget" && refused.plannedBytes > 1000 && refused.canvasW > 0,
	      "budget: refusal names the reason and the planned cost (" + refused.reason + ")");
	// The base follows the running codec by default; H.264 and a required mismatch reject.
	config.maxFoveaBytes = 2097152;
	config.baseCodec = 0;
	producer.Configure(config, 2);
	Check(producer.WantsCapture() && producer.Snapshot().baseCodec == 2, "base: follows a running AV1 stream");
	producer.Configure(config, 3);
	Check(producer.Snapshot().reason == "base_h264_unsupported", "base: H.264 stream rejected visibly");
	config.baseCodec = 1;
	producer.Configure(config, 2);
	Check(producer.Snapshot().reason == "base_codec_mismatch", "base: a required HEVC base rejects an AV1 stream");
	config.baseCodec = 0;

	// With a live-seam requirement, nothing is captured until a wrapped encoder submits.
	config.requireLiveSeam = true;
	producer.Configure(config, 1);
	Check(!encodeFrame(130), "seam: no capture before the NVENC seam is live");
	Check(producer.Snapshot().reason == "nvenc_seam_pending", "seam: the pending seam is reported");
	producer.NoteSeamAlive();
	Check(encodeFrame(131), "seam: capture resumes once a wrapped encoder submits");
	producer.OnStreamBoundary();
	Check(!encodeFrame(132), "seam: a finished encoder session stops capture until the next stream submits");
	config.requireLiveSeam = false;

	config.enabled = false;
	producer.Configure(config, 1);
	Check(!producer.WantsCapture(), "join: disable stops capture");
}

// Ring density end to end: reduced outer rings travel as smaller texel grids (ASTC) or
// without their finest wavelet band (PyroWave), parse on the client and cost fewer bytes.
void RunDensityCase(int foveaCodec, const char* label) {
	gxh1::Producer& producer = gxh1::Producer::Get();
	uint32_t bytes[2] = {0, 0};
	for (int reduced = 0; reduced < 2; ++reduced) {
		gxh1::ProducerConfig config;
		config.enabled = true;
		config.foveaCodec = foveaCodec;
		config.baseCodec = 1;
		config.requireReadyPeer = false;
		config.allowCpuAstcReference = true;
		config.maxFoveaBytes = 8 * 1024 * 1024;
		if (reduced) {
			config.ringDensity[2] = 0.75;
			config.ringDensity[3] = 0.5;
			config.ringDensity[4] = 0.25;
		}
		producer.Configure(config, 1);
		gxh1::FrameMeta meta;
		meta.eyeW = 512;
		meta.eyeH = 512;
		meta.frameId = 500 + static_cast<uint64_t>(reduced) + 10u * static_cast<uint64_t>(foveaCodec);
		for (int eye = 0; eye < 2; ++eye) {
			meta.gazeValid[eye] = true;
			meta.gazeX[eye] = 256.0f;
			meta.gazeY[eye] = 256.0f;
			meta.tan[eye][0] = -1.0f;
			meta.tan[eye][1] = 1.0f;
			meta.tan[eye][2] = -1.0f;
			meta.tan[eye][3] = 1.0f;
		}
		std::string reason;
		if (!producer.BeginFrame(meta, &reason)) {
			Check(false, std::string(label) + ": density begin frame (" + reason + ")");
			return;
		}
		const gxh1::FoveaPlan* plan = producer.InflightPlan();
		const std::vector<uint8_t> canvas = MakeCanvas(plan->canvasW, plan->canvasH, 3);
		for (int eye = 0; eye < 2; ++eye) producer.SubmitEye(eye, canvas.data(), plan->canvasW * 4, plan->canvasW, plan->canvasH);
		gxh1::EncodedFrame frame;
		for (int attempt = 0; attempt < 6000 && !producer.TakeReady(meta.frameId, frame); ++attempt) {
			std::this_thread::sleep_for(std::chrono::milliseconds(2));
		}
		Check(!frame.unit.empty(), std::string(label) + ": density frame encoded");
		if (frame.unit.empty()) return;
		bytes[reduced] = static_cast<uint32_t>(frame.unit.size());
		std::vector<uint8_t> wire;
		gxh1::EnvelopeHeader header{};
		const std::vector<uint8_t> base(32, 0x22);
		producer.WrapAccessUnit(base.data(), base.size(), gxh1::kBaseFormatNv12, frame, wire, header);
		gxh1::ParsedFrame parsed;
		gxh1::ParseLimits limits;
		Check(gxh1::ParseFrame(wire.data(), wire.size(), limits, parsed) == gxh1::ParseError::None,
		      std::string(label) + ": density envelope parses");
		int resampled = 0, decoded = 0;
		for (const gxh1::ParsedPatch& patch : parsed.patches) {
			const gxh1::PatchEntry& e = patch.entry;
			if (e.texelW) ++resampled;
			std::vector<uint8_t> rgb;
			int w = gxh1::PatchTexelW(e), h = gxh1::PatchTexelH(e);
			if (foveaCodec == 1 ? gxh1::AstcDecodeRgb(patch.payload, e.payloadBytes, w, h, e.blockW, e.blockH, rgb)
			                    : gxh1::PwDecodeRgb(patch.payload, e.payloadBytes, rgb, w, h)) {
				++decoded;
			}
		}
		Check(decoded == static_cast<int>(parsed.patches.size()), std::string(label) + ": every density patch decodes");
		if (reduced && foveaCodec == 1) Check(resampled > 0, std::string(label) + ": outer ASTC rings declare texel grids");
	}
	std::printf("  %s density 1/1/0.75/0.5/0.25: %u B vs %u B native\n", label, bytes[1], bytes[0]);
	Check(bytes[1] < bytes[0], std::string(label) + ": lower ring density costs fewer bytes");
}

int main() {
	std::printf("Hybrid loopback tests\n");
	RunDensityCase(1, "astc");
	RunDensityCase(2, "pyrowave");
	RunCase(1, "astc");
	RunCase(2, "pyrowave");
	RunJoinCase();
	gxh1::Producer::Get().Shutdown();
	std::printf("%d checks, %d failures\n", checks, failures);
	return failures == 0 ? 0 : 1;
}
