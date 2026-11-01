// GPU ASTC encoder qualification: the D3D11 compute encoder must emit standard ASTC blocks
// that an independent reference decoder (astcenc, test-only) reads back to the same image,
// at quality parity with the CPU reference encoder.
//
// Not part of the shipped driver: astcenc is Apache-2.0 and is used here as a local
// diagnostic oracle only, never linked into production code.
#define NOMINMAX
#include "../src/Driver/AstcGpuEncoder.h"
#include "../src/Driver/HybridCapture.h"
#include "../src/Driver/NvencPostPack.h"
#include "../src/Hybrid/AstcBatchEncoder.h"
#include "../src/Hybrid/Gxh1Codec.h"
#include "../src/Hybrid/HybridProducer.h"
#include "../src/Hybrid/PyroWaveCpu.h"
#include "../src/Hybrid/AstcSubset.h"
#include "../src/Hybrid/FoveaPlanner.h"

#include "astcenc.h"

#include <d3d11.h>
#include <dxgi1_2.h>

#include <chrono>
#include <thread>
#include <cmath>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

// The GPU encoder logs through the driver's logger; the test provides a silent sink.
void DriverLog(const char* format, ...) { va_list args; va_start(args, format); std::vfprintf(stderr, format, args); std::fprintf(stderr, "\n"); va_end(args); }

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

double PsnrRgb(const std::vector<uint8_t>& a, const std::vector<uint8_t>& b) {
	double sse = 0.0;
	size_t count = 0;
	for (size_t i = 0; i + 2 < a.size() && i + 2 < b.size(); i += 3) {
		for (int c = 0; c < 3; ++c) {
			const double d = static_cast<double>(a[i + c]) - static_cast<double>(b[i + c]);
			sse += d * d;
			++count;
		}
	}
	if (count == 0) return 0.0;
	if (sse <= 0.0) return 99.0;
	return 10.0 * std::log10((255.0 * 255.0) / (sse / count));
}

std::vector<uint8_t> MakeCanvas(int width, int height, int phase) {
	std::vector<uint8_t> rgba(static_cast<size_t>(width) * height * 4u, 255);
	for (int y = 0; y < height; ++y) {
		for (int x = 0; x < width; ++x) {
			uint8_t* p = rgba.data() + (static_cast<size_t>(y) * width + x) * 4u;
			const bool ink = ((x + phase) % 13 < 4) || ((y + phase) % 17 < 3);
			p[0] = ink ? 18 : static_cast<uint8_t>(60 + (x * 150) / width);
			p[1] = ink ? 210 : static_cast<uint8_t>(40 + (y * 160) / height);
			p[2] = ink ? 96 : static_cast<uint8_t>(200 - (x * 120) / width);
			p[3] = 255;
		}
	}
	return rgba;
}

struct AstcReference {
	astcenc_context* context = nullptr;
	int blockW = 0;
	int blockH = 0;

	bool Init(int bw, int bh, std::string* error) {
		if (context && blockW == bw && blockH == bh) return true;
		if (context) {
			astcenc_context_free(context);
			context = nullptr;
		}
		astcenc_config config{};
		astcenc_error err = astcenc_config_init(ASTCENC_PRF_LDR, static_cast<unsigned>(bw),
		                                        static_cast<unsigned>(bh), 1, ASTCENC_PRE_MEDIUM,
		                                        ASTCENC_FLG_DECOMPRESS_ONLY, &config);
		if (err != ASTCENC_SUCCESS) {
			if (error) *error = astcenc_get_error_string(err);
			return false;
		}
		err = astcenc_context_alloc(&config, 1, &context, nullptr);
		if (err != ASTCENC_SUCCESS) {
			if (error) *error = astcenc_get_error_string(err);
			return false;
		}
		blockW = bw;
		blockH = bh;
		return true;
	}

	~AstcReference() {
		if (context) astcenc_context_free(context);
	}

	bool Decode(const std::vector<uint8_t>& blocks, int width, int height, std::vector<uint8_t>& out,
	            std::string* error) {
		out.assign(static_cast<size_t>(width) * height * 4u, 0);
		astcenc_image image{};
		image.dim_x = static_cast<unsigned>(width);
		image.dim_y = static_cast<unsigned>(height);
		image.dim_z = 1;
		image.data_type = ASTCENC_TYPE_U8;
		void* slices[1] = {out.data()};
		image.data = slices;
		astcenc_swizzle swizzle{ASTCENC_SWZ_R, ASTCENC_SWZ_G, ASTCENC_SWZ_B, ASTCENC_SWZ_A};
		const astcenc_error err = astcenc_decompress_image(context, blocks.data(), blocks.size(), &image, &swizzle, 0);
		if (err != ASTCENC_SUCCESS) {
			if (error) *error = astcenc_get_error_string(err);
			return false;
		}
		return true;
	}
};

std::vector<uint8_t> SourceCrop(const std::vector<uint8_t>& canvas, int canvasW, int canvasH,
                                const gxh1::PlannedPatch& patch) {
	std::vector<uint8_t> rgba(static_cast<size_t>(patch.width) * patch.height * 4u);
	for (int y = 0; y < patch.height; ++y) {
		const int sy = std::min(static_cast<int>(patch.y) + y, canvasH - 1);
		for (int x = 0; x < patch.width; ++x) {
			const int sx = std::min(static_cast<int>(patch.x) + x, canvasW - 1);
			std::memcpy(rgba.data() + (static_cast<size_t>(y) * patch.width + x) * 4u,
			            canvas.data() + (static_cast<size_t>(sy) * canvasW + sx) * 4u, 4u);
		}
	}
	return rgba;
}

std::vector<uint8_t> RgbaToRgb(const std::vector<uint8_t>& rgba) {
	std::vector<uint8_t> rgb(rgba.size() / 4u * 3u);
	for (size_t i = 0, j = 0; i + 3 < rgba.size(); i += 4, j += 3) {
		rgb[j + 0] = rgba[i + 0];
		rgb[j + 1] = rgba[i + 1];
		rgb[j + 2] = rgba[i + 2];
	}
	return rgb;
}

double RunBatch(const gxh1::AstcBatchEncoderFn& batch, const gxh1::AstcBatchRequest& request,
                std::vector<std::vector<uint8_t>>& encoded, std::string* error) {
	encoded.assign(request.patchCount, {});
	gxh1::AstcBatchRequest mutableRequest = request;
	mutableRequest.output = &encoded;
	const auto start = std::chrono::steady_clock::now();
	const bool ok = batch(mutableRequest, error);
	const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
	return ok ? ms : -1.0;
}

// Render device on the encoder's adapter, as the FrameProcessor device is in the driver.
struct RenderDevice {
	ID3D11Device* device = nullptr;
	ID3D11DeviceContext* context = nullptr;
	~RenderDevice() {
		if (context) context->Release();
		if (device) device->Release();
	}
};

ID3D11Texture2D* MakeEyeTexture(ID3D11Device* device, const std::vector<uint8_t>& rgba, int width, int height, bool bgra) {
	std::vector<uint8_t> texels = rgba;
	if (bgra) {
		for (size_t i = 0; i + 3 < texels.size(); i += 4) std::swap(texels[i], texels[i + 2]);
	}
	D3D11_TEXTURE2D_DESC desc = {};
	desc.Width = static_cast<UINT>(width);
	desc.Height = static_cast<UINT>(height);
	desc.MipLevels = 1;
	desc.ArraySize = 1;
	desc.Format = bgra ? DXGI_FORMAT_B8G8R8A8_UNORM_SRGB : DXGI_FORMAT_R8G8B8A8_UNORM_SRGB;
	desc.SampleDesc.Count = 1;
	desc.Usage = D3D11_USAGE_DEFAULT;
	desc.BindFlags = D3D11_BIND_SHADER_RESOURCE;
	D3D11_SUBRESOURCE_DATA data = {texels.data(), static_cast<UINT>(width * 4), 0};
	ID3D11Texture2D* texture = nullptr;
	return SUCCEEDED(device->CreateTexture2D(&desc, &data, &texture)) ? texture : nullptr;
}

// Independent reference for a resampled ring: linear-light mean over the same footprint.
std::vector<uint8_t> ResampleReference(const std::vector<uint8_t>& rgba, int stride, int x, int y, int w, int h, int tw,
                                       int th) {
	auto toLinear = [](uint8_t v) {
		const double c = v / 255.0;
		return c <= 0.04045 ? c / 12.92 : std::pow((c + 0.055) / 1.055, 2.4);
	};
	std::vector<uint8_t> out(static_cast<size_t>(tw) * th * 3u);
	for (int ty = 0; ty < th; ++ty) {
		const int y0 = ty * h / th, y1 = std::max(y0 + 1, ((ty + 1) * h + th - 1) / th);
		for (int tx = 0; tx < tw; ++tx) {
			const int x0 = tx * w / tw, x1 = std::max(x0 + 1, ((tx + 1) * w + tw - 1) / tw);
			for (int c = 0; c < 3; ++c) {
				double sum = 0.0;
				for (int sy = y0; sy < y1; ++sy)
					for (int sx = x0; sx < x1; ++sx) sum += toLinear(rgba[(static_cast<size_t>(y + sy) * stride + x + sx) * 4u + c]);
				const double l = sum / ((x1 - x0) * (y1 - y0));
				const double s = l <= 0.0031308 ? l * 12.92 : 1.055 * std::pow(l, 1.0 / 2.4) - 0.055;
				out[(static_cast<size_t>(ty) * tw + tx) * 3u + c] = static_cast<uint8_t>(std::lround(std::min(1.0, std::max(0.0, s)) * 255.0));
			}
		}
	}
	return out;
}

// Full host path without vrlink: render-device eye textures -> HybridCaptureFrame (shared
// canvas, no Map on the render thread) -> producer worker -> GPU encoder or worker readback
// -> fovea unit. The decoded canvas must equal the source pixels the plan selected.
void TestCaptureHandoff() {
	RenderDevice render;
	const D3D_FEATURE_LEVEL level = D3D_FEATURE_LEVEL_11_0;
	if (FAILED(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, 0, &level, 1, D3D11_SDK_VERSION,
	                             &render.device, nullptr, &render.context))) {
		Check(false, "handoff: render device");
		return;
	}
	const int eyeW = 640, eyeH = 640;
	const std::vector<uint8_t> eyes[2] = {MakeCanvas(eyeW, eyeH, 2), MakeCanvas(eyeW, eyeH, 7)};
	gxh1::Producer& producer = gxh1::Producer::Get();
	uint64_t frameId = 1000;

	uint32_t nativeAstcBytes = 0;
	for (int run = 0; run < 3; ++run) {
		const int codec = run == 2 ? 2 : 1;
		const bool reduced = run == 1;  // ASTC with the plan's lower outer-ring densities
		const bool bgra = codec == 2;  // PyroWave reads back on the worker: exercise the BGRA swizzle there
		const char* label = codec == 2 ? "handoff pyrowave" : (reduced ? "handoff astc density" : "handoff astc");
		ID3D11Texture2D* textures[2] = {MakeEyeTexture(render.device, eyes[0], eyeW, eyeH, bgra),
		                                 MakeEyeTexture(render.device, eyes[1], eyeW, eyeH, bgra)};
		if (!textures[0] || !textures[1]) {
			Check(false, std::string(label) + ": eye textures");
			for (ID3D11Texture2D* t : textures) if (t) t->Release();
			continue;
		}
		gxh1::ProducerConfig config;
		config.enabled = true;
		config.foveaCodec = codec;
		config.baseCodec = 1;
		config.requireReadyPeer = false;
		config.maxFoveaBytes = 8 * 1024 * 1024;
		config.ringDegrees[3] = 30.0;
		config.ringDegrees[4] = 34.0;
		if (reduced) {
			config.ringDensity[2] = 0.75;
			config.ringDensity[3] = 0.5;
			config.ringDensity[4] = 0.5;
		}
		producer.Configure(config, 1);

		HybridCaptureRequest request;
		for (int eye = 0; eye < 2; ++eye) {
			request.source[eye] = textures[eye];
			request.gazeU[eye] = 0.45f + 0.1f * eye;
			request.gazeV[eye] = 0.5f;
			request.gazeValid[eye] = true;
			request.tan[eye][0] = -1.0f;
			request.tan[eye][1] = 1.0f;
			request.tan[eye][2] = -1.0f;
			request.tan[eye][3] = 1.0f;
		}
		request.frameId = ++frameId;
		const uint64_t before = producer.Snapshot().frames;
		const auto start = std::chrono::steady_clock::now();
		HybridCaptureFrame(render.device, render.context, request);
		const double captureMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
		render.context->Flush();
		for (int attempt = 0; attempt < 3000 && producer.Snapshot().frames == before; ++attempt) {
			std::this_thread::sleep_for(std::chrono::milliseconds(2));
		}
		const gxh1::ProducerStatus status = producer.Snapshot();
		std::printf("  %s: render-thread capture %.3f ms, path %s, encode %.2f ms, %u B, state %s\n", label,
		            captureMs, status.capturePath.c_str(), status.encodeMs, status.foveaBytes, status.reason.c_str());
		Check(status.capturePath == "gpu_shared", std::string(label) + ": capture used the shared canvas");
		gxh1::EncodedFrame frame;
		const bool taken = producer.TakeReady(request.frameId, frame);
		Check(taken, std::string(label) + ": fovea produced for the captured frame (" + status.reason + ")");
		if (taken) {
			std::vector<uint8_t> wire;
			gxh1::EnvelopeHeader header{};
			const std::vector<uint8_t> base(64, 0x11);
			gxh1::ParsedFrame parsed;
			gxh1::ParseLimits limits;
			const bool wrapped = producer.WrapAccessUnit(base.data(), base.size(), gxh1::kBaseFormatNv12, frame, wire, header);
			const bool parsedOk =
				wrapped && gxh1::ParseFrame(wire.data(), wire.size(), limits, parsed) == gxh1::ParseError::None;
			Check(parsedOk, std::string(label) + ": envelope parses");
			int mismatchedPatches = 0;
			int resampledPatches = 0;
			double worst = 99.0;
			for (size_t i = 0; parsedOk && i < parsed.patches.size(); ++i) {
				const gxh1::PatchEntry& e = parsed.patches[i].entry;
				const gxh1::EyeMapping& map = parsed.unit->eyes[e.eye];
				std::vector<uint8_t> rgb;
				int w = gxh1::PatchTexelW(e), h = gxh1::PatchTexelH(e);
				const bool ok = codec == 1
					? gxh1::AstcDecodeRgb(parsed.patches[i].payload, e.payloadBytes, w, h, e.blockW, e.blockH, rgb)
					: gxh1::PwDecodeRgb(parsed.patches[i].payload, e.payloadBytes, rgb, w, h);
				if (!ok) {
					++mismatchedPatches;
					continue;
				}
				if (e.texelW != 0) ++resampledPatches;
				const std::vector<uint8_t> source = ResampleReference(eyes[e.eye], eyeW, map.originX + e.x, map.originY + e.y,
				                                                      e.width, e.height, w, h);
				worst = std::min(worst, PsnrRgb(source, rgb));
			}
			std::printf("  %s: %zu patches, worst %.2f dB against the source crop\n", label, parsed.patches.size(), worst);
			Check(mismatchedPatches == 0, std::string(label) + ": every patch decodes");
			// ASTC is lossy at large footprints; PyroWave at full precision must reproduce the
			// source, which also proves eye placement and the BGRA swizzle.
			Check(codec == 1 ? worst > 10.0 : worst >= 60.0, std::string(label) + ": decoded canvas matches the source crop");
			if (codec == 1 && !reduced) nativeAstcBytes = static_cast<uint32_t>(frame.unit.size());
			if (reduced) {
				std::printf("  %s: %d resampled patches, %zu B vs %u B native\n", label, resampledPatches, frame.unit.size(),
				            nativeAstcBytes);
				Check(resampledPatches > 0, std::string(label) + ": outer rings are resampled");
				Check(frame.unit.size() < nativeAstcBytes, std::string(label) + ": lower density costs fewer bytes");
			}
		}
		for (ID3D11Texture2D* t : textures) t->Release();
	}
	gxh1::ProducerConfig off;
	producer.Configure(off, 1);
	HybridCaptureRelease();
	producer.Shutdown();
}

// While the hybrid runs, the video's own fovea tiles are cleared to flat grey before NVENC
// maps vrlink's packed W x 4W frame. Background tiles and the timing block (bottom-left 64 px
// of the last tile) must keep vrlink's pixels; a frame that is not a 4-tile atlas is untouched.
void TestVideoFoveaClear() {
	ID3D11Device* device = nullptr;
	ID3D11DeviceContext* context = nullptr;
	const D3D_FEATURE_LEVEL level = D3D_FEATURE_LEVEL_11_0;
	if (FAILED(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, 0, &level, 1, D3D11_SDK_VERSION, &device,
	                             nullptr, &context))) {
		Check(false, "fovea clear: device");
		return;
	}
	struct Case {
		DXGI_FORMAT format;
		bool foveaTop;
		int tiles;
	};
	const Case cases[] = {{DXGI_FORMAT_NV12, true, 4}, {DXGI_FORMAT_NV12, false, 4}, {DXGI_FORMAT_P010, true, 4},
	                      {DXGI_FORMAT_P010, false, 4}, {DXGI_FORMAT_NV12, true, 2}};
	const UINT W = 256;
	for (const Case& c : cases) {
		const bool p010 = c.format == DXGI_FORMAT_P010;
		const std::string label = std::string("fovea clear ") + (p010 ? "P010" : "NV12") +
		                          (c.foveaTop ? " top" : " bottom") + (c.tiles == 4 ? "" : " 2-tile");
		UINT support = 0;
		if (FAILED(device->CheckFormatSupport(c.format, &support)) || !(support & D3D11_FORMAT_SUPPORT_RENDER_TARGET)) {
			std::printf("  %s: format not renderable on this adapter, skipped\n", label.c_str());
			continue;
		}
		const UINT H = W * static_cast<UINT>(c.tiles);
		const UINT bpc = p010 ? 2u : 1u;
		const UINT pitch = W * bpc;
		// vrlink content: luma 200, chroma (60, 180), scaled to the format's sample range.
		const uint16_t lumaValue = p010 ? static_cast<uint16_t>(200u << 8) : 200u;
		const uint16_t chromaU = p010 ? static_cast<uint16_t>(60u << 8) : 60u;
		const uint16_t chromaV = p010 ? static_cast<uint16_t>(180u << 8) : 180u;
		std::vector<uint8_t> init(static_cast<size_t>(pitch) * (H + H / 2));
		auto put = [&](uint8_t* row, UINT index, uint16_t value) {
			if (p010) std::memcpy(row + index * 2u, &value, 2);
			else row[index] = static_cast<uint8_t>(value);
		};
		for (UINT y = 0; y < H; ++y)
			for (UINT x = 0; x < W; ++x) put(init.data() + static_cast<size_t>(y) * pitch, x, lumaValue);
		for (UINT y = 0; y < H / 2; ++y)
			for (UINT x = 0; x < W / 2; ++x) {
				uint8_t* row = init.data() + static_cast<size_t>(H + y) * pitch;
				put(row, 2u * x, chromaU);
				put(row, 2u * x + 1u, chromaV);
			}
		D3D11_TEXTURE2D_DESC desc = {};
		desc.Width = W;
		desc.Height = H;
		desc.MipLevels = 1;
		desc.ArraySize = 1;
		desc.Format = c.format;
		desc.SampleDesc.Count = 1;
		desc.Usage = D3D11_USAGE_DEFAULT;
		desc.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
		D3D11_SUBRESOURCE_DATA data = {init.data(), pitch, 0};
		ID3D11Texture2D* packed = nullptr;
		D3D11_TEXTURE2D_DESC stagingDesc = desc;
		stagingDesc.Usage = D3D11_USAGE_STAGING;
		stagingDesc.BindFlags = 0;
		stagingDesc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
		ID3D11Texture2D* staging = nullptr;
		if (FAILED(device->CreateTexture2D(&desc, &data, &packed)) ||
		    FAILED(device->CreateTexture2D(&stagingDesc, nullptr, &staging))) {
			Check(false, label + ": textures");
			if (packed) packed->Release();
			continue;
		}
		NvencPostPackConfig config;  // the post-pack itself stays off: the clear does not need it
		config.foveaTop = c.foveaTop;
		NvencPostPack::SetConfig(config);
		const bool cleared = NvencPostPack::BlankFovea(packed);
		Check(cleared == (c.tiles == 4), label + ": clears only a 4-tile atlas");
		context->CopyResource(staging, packed);
		D3D11_MAPPED_SUBRESOURCE map = {};
		if (FAILED(context->Map(staging, 0, D3D11_MAP_READ, 0, &map))) {
			Check(false, label + ": map");
		} else {
			const uint8_t* base = static_cast<const uint8_t*>(map.pData);
			auto get = [&](UINT row, UINT index) -> uint16_t {
				const uint8_t* p = base + static_cast<size_t>(row) * map.RowPitch;
				if (!p010) return p[index];
				uint16_t v = 0;
				std::memcpy(&v, p + index * 2u, 2);
				return v;
			};
			// Mid grey in the format's range (UNORM 0.5 rounds to 127/128 or 32767/32768).
			auto grey = [&](uint16_t v) { return p010 ? (v >> 8) == 127 || (v >> 8) == 128 : v == 127 || v == 128; };
			auto isFovea = [&](UINT tile) { return c.tiles == 4 && ((tile & 1u) == 0u) == c.foveaTop; };
			auto inTiming = [&](UINT x, UINT y) { return y / W == 3u && x < 64u && y % W >= W - 64u; };
			int wrongLuma = 0, wrongChroma = 0;
			for (UINT y = 0; y < H; ++y)
				for (UINT x = 0; x < W; ++x) {
					const bool expectGrey = isFovea(y / W) && !inTiming(x, y);
					const uint16_t v = get(y, x);
					if (expectGrey ? !grey(v) : v != lumaValue) ++wrongLuma;
				}
			for (UINT y = 0; y < H / 2; ++y)
				for (UINT x = 0; x < W / 2; ++x) {
					const bool expectGrey = isFovea((2u * y) / W) && !inTiming(2u * x, 2u * y);
					const uint16_t u = get(H + y, 2u * x), v = get(H + y, 2u * x + 1u);
					if (expectGrey ? !(grey(u) && grey(v)) : (u != chromaU || v != chromaV)) ++wrongChroma;
				}
			context->Unmap(staging, 0);
			std::printf("  %s: %s, %d luma / %d chroma samples off\n", label.c_str(), cleared ? "cleared" : "untouched",
			            wrongLuma, wrongChroma);
			Check(wrongLuma == 0 && wrongChroma == 0,
			      label + ": fovea tiles grey, background and timing block keep vrlink's pixels");
		}
		staging->Release();
		packed->Release();
	}
	context->Release();
	device->Release();
}

}  // namespace

int main() {
	std::printf("Hybrid GPU ASTC qualification\n");
	std::string error;
	if (!gxh1::InitAstcGpuEncoder(&error)) {
		std::fprintf(stderr, "GPU encoder unavailable: %s\n", error.c_str());
		return 2;
	}
	const gxh1::AstcBatchEncoderFn batch = gxh1::GetAstcBatchEncoder();
	Check(batch != nullptr, "batch encoder registered");
	if (!batch) return 1;

	const int eyeW = 256;
	const int eyeH = 256;
	std::vector<uint8_t> canvases[2] = {MakeCanvas(eyeW, eyeH, 0), MakeCanvas(eyeW, eyeH, 3)};

	gxh1::FoveaPlanRequest request;
	request.eyeW = static_cast<uint16_t>(eyeW);
	request.eyeH = static_cast<uint16_t>(eyeH);
	request.guardDegrees = 2.0f;
	request.featherPx = 8;
	for (int eye = 0; eye < 2; ++eye) {
		request.eyes[eye].valid = true;
		request.eyes[eye].gazeX = 128.0f;
		request.eyes[eye].gazeY = 128.0f;
		request.eyes[eye].tanLeft = -1.0f;
		request.eyes[eye].tanRight = 1.0f;
		request.eyes[eye].tanTop = -1.0f;
		request.eyes[eye].tanBottom = 1.0f;
	}
	const float radii[5] = {5.0f, 10.0f, 20.0f, 30.0f, 35.0f};
	const uint8_t footprints[5] = {4, 6, 8, 10, 12};
	for (int i = 0; i < 5; ++i) {
		request.rings[i].outerDegrees = radii[i];
		request.rings[i].blockW = footprints[i];
		request.rings[i].blockH = footprints[i];
	}
	gxh1::FoveaPlan plan;
	if (!gxh1::BuildFoveaPlan(request, plan, &error)) {
		std::fprintf(stderr, "plan failed: %s\n", error.c_str());
		return 2;
	}
	std::printf("  plan: %u patches over %ux%u canvas\n", static_cast<unsigned>(plan.patches.size()),
	            plan.canvasW, plan.canvasH);

	// The producer consumes the gaze-centred canvas crop, not the full eye image.
	std::vector<uint8_t> canvasCrop[2];
	for (int eye = 0; eye < 2; ++eye) {
		canvasCrop[eye].resize(static_cast<size_t>(plan.canvasW) * plan.canvasH * 4u);
		for (int y = 0; y < plan.canvasH; ++y) {
			const size_t sourceOffset =
				(static_cast<size_t>(plan.eyeOriginY[eye] + y) * eyeW + plan.eyeOriginX[eye]) * 4u;
			std::memcpy(canvasCrop[eye].data() + static_cast<size_t>(y) * plan.canvasW * 4u,
			            canvases[eye].data() + sourceOffset, static_cast<size_t>(plan.canvasW) * 4u);
		}
	}

	gxh1::AstcBatchRequest batchRequest;
	batchRequest.canvas[0] = canvasCrop[0].data();
	batchRequest.canvas[1] = canvasCrop[1].data();
	batchRequest.canvasW = plan.canvasW;
	batchRequest.canvasH = plan.canvasH;
	batchRequest.patches = plan.patches.data();
	batchRequest.patchCount = plan.patches.size();

	std::vector<std::vector<uint8_t>> encoded;
	double elapsedMs = RunBatch(batch, batchRequest, encoded, &error);
	Check(elapsedMs >= 0.0, "GPU batch encode: " + error);
	if (elapsedMs < 0.0) return 1;
	// First call may include device creation and shader compilation; the second is steady state.
	std::vector<std::vector<uint8_t>> encodedAgain;
	const double steadyMs = RunBatch(batch, batchRequest, encodedAgain, &error);
	Check(steadyMs >= 0.0, "GPU batch encode (steady): " + error);
	std::printf("  GPU batch: %.2f ms first, %.2f ms steady, %zu patches\n", elapsedMs, steadyMs,
	            plan.patches.size());
	Check(steadyMs >= 0.0 && steadyMs < 12.0, "steady-state GPU encode within the frame budget");

	// Solid-colour canvas proves upload + sampling independently of the fovea pattern.
	{
		std::vector<uint8_t> solid[2];
		for (int eye = 0; eye < 2; ++eye) {
			solid[eye].assign(static_cast<size_t>(plan.canvasW) * plan.canvasH * 4u, 255);
			for (size_t p = 0; p + 3 < solid[eye].size(); p += 4) {
				solid[eye][p + 0] = 200;
				solid[eye][p + 1] = 50;
				solid[eye][p + 2] = 25;
			}
		}
		gxh1::AstcBatchRequest one = batchRequest;
		one.canvas[0] = solid[0].data();
		one.canvas[1] = solid[1].data();
		one.patches = &plan.patches[0];
		one.patchCount = 1;
		std::vector<std::vector<uint8_t>> single;
		const double solidMs = RunBatch(batch, one, single, &error);
		std::vector<uint8_t> solidRgb;
		const bool decoded = solidMs >= 0.0 &&
		                     gxh1::AstcDecodeRgb(single[0].data(), single[0].size(), plan.patches[0].width,
		                                         plan.patches[0].height, plan.patches[0].blockW,
		                                         plan.patches[0].blockH, solidRgb);
		Check(decoded && solidRgb[0] == 200 && solidRgb[1] == 50 && solidRgb[2] == 25,
		      "solid colour survives the GPU path");
		std::printf("  single-patch GPU encode: %.2f ms\n", solidMs);
	}

	AstcReference reference;
	int checkedPatches = 0;
	double worstReference = 99.0;
	double worstAgreement = 99.0;
	double worstParity = -99.0;
	for (size_t i = 0; i < plan.patches.size(); ++i) {
		const gxh1::PlannedPatch& patch = plan.patches[i];
		const std::vector<uint8_t> source = SourceCrop(canvasCrop[patch.eye], plan.canvasW, plan.canvasH, patch);
		const std::vector<uint8_t> sourceRgb = RgbaToRgb(source);
		const size_t expectedBlocks = ((patch.texelW + patch.blockW - 1u) / patch.blockW) *
		                              static_cast<size_t>((patch.texelH + patch.blockH - 1u) / patch.blockH);
		Check(encoded[i].size() == expectedBlocks * 16u,
		      "block count patch " + std::to_string(i) + ": " + std::to_string(encoded[i].size()));

		std::vector<uint8_t> oursRgb;
		const bool oursOk = gxh1::AstcDecodeRgb(encoded[i].data(), encoded[i].size(), patch.width, patch.height,
		                                        patch.blockW, patch.blockH, oursRgb);
		Check(oursOk, "our decoder reads GPU blocks " + std::to_string(i));
		if (!oursOk) continue;

		if (!reference.Init(patch.blockW, patch.blockH, &error)) {
			Check(false, "astcenc init: " + error);
			continue;
		}
		std::vector<uint8_t> referenceRgba;
		if (!reference.Decode(encoded[i], patch.width, patch.height, referenceRgba, &error)) {
			Check(false, "astcenc decode patch " + std::to_string(i) + ": " + error);
			continue;
		}
		const std::vector<uint8_t> referenceRgb = RgbaToRgb(referenceRgba);
		const double referencePsnr = PsnrRgb(sourceRgb, referenceRgb);
		const double agreement = PsnrRgb(oursRgb, referenceRgb);
		worstReference = std::min(worstReference, referencePsnr);
		worstAgreement = std::min(worstAgreement, agreement);
		Check(referencePsnr > 10.0, "reference quality patch " + std::to_string(i) + " " +
		                               std::to_string(referencePsnr) + " dB");
		// The client decoder must reproduce a conformant decoder bit for bit, not merely
		// at high PSNR: GPU texture hardware on the headset decodes these same blocks.
		Check(oursRgb == referenceRgb, "our decoder matches astcenc exactly, patch " + std::to_string(i) + " (" +
		                                   std::to_string(agreement) + " dB)");

		// Quality parity with the CPU reference encoder at the same footprint.
		std::vector<uint8_t> cpuBlocks;
		std::vector<uint8_t> cpuRgb;
		double cpuPsnr = 0.0;
		if (gxh1::AstcEncodeRgb(sourceRgb.data(), static_cast<size_t>(patch.width) * 3u, patch.width,
		                        patch.height, patch.blockW, patch.blockH, cpuBlocks) &&
		    gxh1::AstcDecodeRgb(cpuBlocks.data(), cpuBlocks.size(), patch.width, patch.height, patch.blockW,
		                        patch.blockH, cpuRgb)) {
			cpuPsnr = PsnrRgb(sourceRgb, cpuRgb);
			const double parity = referencePsnr - cpuPsnr;
			worstParity = std::max(worstParity, -parity);
			if (i < 6) {
				std::printf("  patch %zu %ux%u b%u: gpu %.2f dB, cpu %.2f dB, ref %.2f dB, agree %.2f dB\n", i,
				            patch.width, patch.height, patch.blockW, referencePsnr, cpuPsnr, referencePsnr,
				            agreement);
			}
			Check(parity > -3.0, "GPU within 3 dB of CPU patch " + std::to_string(i) + " (" +
			                        std::to_string(parity) + ")");
		}
		++checkedPatches;
	}
	Check(checkedPatches == static_cast<int>(plan.patches.size()), "every patch decoded by both decoders");
	TestCaptureHandoff();
	TestVideoFoveaClear();
	if (!gxh1::GetAstcBatchEncoder()) gxh1::InitAstcGpuEncoder(&error);  // the handoff released it

	// CPU reference blocks for every legal footprint on adversarial content (fine strokes,
	// saturated colour, noise): astcenc and our decoder must agree exactly.
	{
		const uint8_t legal[6] = {4, 5, 6, 8, 10, 12};
		int exactCases = 0;
		int cases = 0;
		for (uint8_t footprint : legal) {
			if (!reference.Init(footprint, footprint, &error)) {
				Check(false, "astcenc init " + std::to_string(footprint) + ": " + error);
				continue;
			}
			for (int kind = 0; kind < 4; ++kind) {
				const int size = 61;  // deliberately not block-aligned
				const std::vector<uint8_t> rgba = MakeCanvas(size, size, kind);
				const std::vector<uint8_t> rgb = RgbaToRgb(rgba);
				std::vector<uint8_t> blocks;
				std::vector<uint8_t> ours;
				std::vector<uint8_t> theirs;
				++cases;
				if (gxh1::AstcEncodeRgb(rgb.data(), static_cast<size_t>(size) * 3u, size, size, footprint, footprint,
				                        blocks) &&
				    gxh1::AstcDecodeRgb(blocks.data(), blocks.size(), size, size, footprint, footprint, ours) &&
				    reference.Decode(blocks, size, size, theirs, &error) && ours == RgbaToRgb(theirs)) {
					++exactCases;
				}
			}
		}
		std::printf("  CPU reference blocks decoded identically by astcenc: %d/%d\n", exactCases, cases);
		Check(exactCases == cases, "CPU reference blocks decode identically in astcenc");
	}
	std::printf("  worst: reference %.2f dB, agreement %.2f dB, GPU-vs-CPU %.2f dB\n", worstReference,
	            worstAgreement, -worstParity);
	gxh1::ShutdownAstcGpuEncoder();
	std::printf("%d checks, %d failures\n", checks, failures);
	return failures == 0 ? 0 : 1;
}
