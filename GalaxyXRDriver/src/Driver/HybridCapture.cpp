#define NOMINMAX
#include "HybridCapture.h"
#include "AstcGpuEncoder.h"
#include "../Hybrid/AstcBatchEncoder.h"

#include <d3d11.h>
#include <dxgi1_2.h>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <mutex>

#include "../Hybrid/HybridProducer.h"
#include "DriverLog.h"

namespace {
std::mutex g_captureLock;

// GPU-resident path: two canvases shared with the encoder device (keyed mutex, key 0 on both
// sides), both eyes stacked vertically. The render thread queues two copies and releases;
// the producer worker waits for the GPU. With one job pending and one encoding at most, the
// two slots alternate and the render thread only finds a slot held while the worker is
// still reading it, which skips the frame instead of waiting.
struct SharedSlot {
	ID3D11Texture2D* texture = nullptr;
	IDXGIKeyedMutex* mutex = nullptr;
	void* handle = nullptr;
	uint64_t generation = 0;
	ID3D11Device* device = nullptr;
	uint32_t width = 0;
	uint32_t height = 0;
	DXGI_FORMAT format = DXGI_FORMAT_UNKNOWN;
};
SharedSlot g_slots[2];
uint32_t g_nextSlot = 0;
uint64_t g_slotGeneration = 0;
bool g_sharedUnavailable = false;  // creation failed on this device: staging path, logged once
const char* g_lastPath = nullptr;

// Staging path (shared canvases unavailable): one staging texture holds both eye canvases
// stacked vertically (eye 0 on top), so a frame costs two GPU copies and a single Map,
// which waits on this thread.
ID3D11Texture2D* g_staging = nullptr;
uint32_t g_stagingWidth = 0;
uint32_t g_stagingHeight = 0;
DXGI_FORMAT g_stagingFormat = DXGI_FORMAT_UNKNOWN;
ID3D11Device* g_stagingDevice = nullptr;
bool g_loggedUnsupported = false;
bool g_loggedFailure = false;
ID3D11Device* g_luidDevice = nullptr;

void ReportAdapterLuid(ID3D11Device* device) {
	if (!device || device == g_luidDevice) return;
	IDXGIDevice* dxgiDevice = nullptr;
	if (SUCCEEDED(device->QueryInterface(__uuidof(IDXGIDevice), reinterpret_cast<void**>(&dxgiDevice))) && dxgiDevice) {
		IDXGIAdapter* adapter = nullptr;
		if (SUCCEEDED(dxgiDevice->GetAdapter(&adapter)) && adapter) {
			DXGI_ADAPTER_DESC desc = {};
			if (SUCCEEDED(adapter->GetDesc(&desc))) {
				const uint64_t luid = (static_cast<uint64_t>(static_cast<uint32_t>(desc.AdapterLuid.HighPart)) << 32) |
				                      static_cast<uint64_t>(desc.AdapterLuid.LowPart);
				gxh1::SetAstcGpuAdapterLuid(luid);
			}
			adapter->Release();
		}
		dxgiDevice->Release();
	}
	g_luidDevice = device;
}

void ReleaseSlot(SharedSlot& slot) {
	if (slot.mutex) slot.mutex->Release();
	if (slot.texture) slot.texture->Release();
	slot = SharedSlot{};
}

bool EnsureSharedSlot(SharedSlot& slot, ID3D11Device* device, uint32_t width, uint32_t height, DXGI_FORMAT format) {
	if (slot.texture && slot.device == device && slot.width == width && slot.height == height && slot.format == format) {
		return true;
	}
	ReleaseSlot(slot);
	D3D11_TEXTURE2D_DESC desc = {};
	desc.Width = width;
	desc.Height = height;
	desc.MipLevels = 1;
	desc.ArraySize = 1;
	desc.Format = format;
	desc.SampleDesc.Count = 1;
	desc.Usage = D3D11_USAGE_DEFAULT;
	desc.BindFlags = D3D11_BIND_SHADER_RESOURCE;  // the encoder device samples it
	desc.MiscFlags = D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX;
	ID3D11Texture2D* texture = nullptr;
	HRESULT hr = device->CreateTexture2D(&desc, nullptr, &texture);
	IDXGIKeyedMutex* mutex = nullptr;
	IDXGIResource* resource = nullptr;
	HANDLE handle = nullptr;
	if (SUCCEEDED(hr) && texture) hr = texture->QueryInterface(__uuidof(IDXGIKeyedMutex), reinterpret_cast<void**>(&mutex));
	if (SUCCEEDED(hr) && texture) hr = texture->QueryInterface(__uuidof(IDXGIResource), reinterpret_cast<void**>(&resource));
	if (SUCCEEDED(hr) && resource) hr = resource->GetSharedHandle(&handle);
	if (resource) resource->Release();
	if (FAILED(hr) || !texture || !mutex || !handle) {
		if (mutex) mutex->Release();
		if (texture) texture->Release();
		DriverLog("HybridCapture: shared capture canvas unavailable (0x%08X); using the staging path, which "
		          "maps on the present thread", static_cast<unsigned>(hr));
		return false;
	}
	slot.texture = texture;
	slot.mutex = mutex;
	slot.handle = handle;
	slot.generation = ++g_slotGeneration;
	slot.device = device;
	slot.width = width;
	slot.height = height;
	slot.format = format;
	return true;
}

void ReleaseStaging() {
	if (g_staging) {
		g_staging->Release();
		g_staging = nullptr;
	}
	g_stagingWidth = 0;
	g_stagingHeight = 0;
	g_stagingFormat = DXGI_FORMAT_UNKNOWN;
	g_stagingDevice = nullptr;
}

bool EnsureStaging(ID3D11Device* device, uint32_t width, uint32_t height, DXGI_FORMAT format) {
	if (!device || width == 0 || height == 0) return false;
	if (g_staging && g_stagingDevice == device && g_stagingWidth == width && g_stagingHeight == height &&
	    g_stagingFormat == format) {
		return true;
	}
	ReleaseStaging();
	D3D11_TEXTURE2D_DESC desc = {};
	desc.Width = width;
	desc.Height = height;
	desc.MipLevels = 1;
	desc.ArraySize = 1;
	desc.Format = format;
	desc.SampleDesc.Count = 1;
	desc.Usage = D3D11_USAGE_STAGING;
	desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
	HRESULT hr = device->CreateTexture2D(&desc, nullptr, &g_staging);
	if (FAILED(hr)) {
		g_staging = nullptr;
		if (!g_loggedFailure) {
			g_loggedFailure = true;
			DriverLog("HybridCapture: staging texture creation failed (0x%08X) — fovea capture disabled",
			          static_cast<unsigned>(hr));
		}
		return false;
	}
	g_stagingDevice = device;
	g_stagingWidth = width;
	g_stagingHeight = height;
	g_stagingFormat = format;
	return true;
}

// Staging format for a layer format: the copy needs the same typeless family. BGRA layers
// are swizzled to RGBA while the producer copies the rows. Wider or float formats would
// need a transfer-aware conversion and are refused visibly.
bool StagingFormatFor(DXGI_FORMAT format, DXGI_FORMAT& staging, bool& bgra) {
	switch (format) {
	case DXGI_FORMAT_R8G8B8A8_TYPELESS:
	case DXGI_FORMAT_R8G8B8A8_UNORM:
	case DXGI_FORMAT_R8G8B8A8_UNORM_SRGB:
		staging = DXGI_FORMAT_R8G8B8A8_UNORM;
		bgra = false;
		return true;
	case DXGI_FORMAT_B8G8R8A8_TYPELESS:
	case DXGI_FORMAT_B8G8R8A8_UNORM:
	case DXGI_FORMAT_B8G8R8A8_UNORM_SRGB:
		staging = DXGI_FORMAT_B8G8R8A8_UNORM;
		bgra = true;
		return true;
	case DXGI_FORMAT_B8G8R8X8_TYPELESS:
	case DXGI_FORMAT_B8G8R8X8_UNORM:
	case DXGI_FORMAT_B8G8R8X8_UNORM_SRGB:
		staging = DXGI_FORMAT_B8G8R8X8_UNORM;
		bgra = true;
		return true;
	default:
		return false;
	}
}

void LogUnsupportedOnce(const char* what, unsigned value) {
	if (g_loggedUnsupported) return;
	g_loggedUnsupported = true;
	DriverLog("HybridCapture: %s %u — fovea capture skipped (the base stream is unaffected)", what, value);
}

}  // namespace

void HybridCaptureFrame(ID3D11Device* device, ID3D11DeviceContext* context, const HybridCaptureRequest& request) {
	std::lock_guard<std::mutex> captureLock(g_captureLock);
	gxh1::Producer& producer = gxh1::Producer::Get();
	if (!producer.WantsCapture() || !device || !context) return;
	// Publish the compute encoder seam before the first batch; registration allocates
	// nothing (the device is created on the producer worker at first use). Re-registered
	// after a mode-off release without touching the capture lock.
	if (gxh1::GetAstcBatchEncoder() == nullptr) {
		gxh1::InitAstcGpuEncoder(nullptr);
	}
	ReportAdapterLuid(device);

	// The eye tile in pixels follows the submitted texture bounds. A texture array used by
	// a single-pass-instanced app gives each eye its own slice of the same texture.
	D3D11_TEXTURE2D_DESC desc[2] = {};
	UINT subresource[2] = {};
	int tileX[2] = {};
	int tileY[2] = {};
	uint32_t tileWidth[2] = {};
	uint32_t tileHeight[2] = {};
	DXGI_FORMAT stagingFormat = DXGI_FORMAT_UNKNOWN;
	bool bgra = false;
	for (int eye = 0; eye < 2; ++eye) {
		ID3D11Texture2D* texture = request.source[eye];
		if (!texture) return;
		texture->GetDesc(&desc[eye]);
		DXGI_FORMAT eyeStaging = DXGI_FORMAT_UNKNOWN;
		bool eyeBgra = false;
		if (!StagingFormatFor(desc[eye].Format, eyeStaging, eyeBgra)) {
			LogUnsupportedOnce("eye layer format", static_cast<unsigned>(desc[eye].Format));
			return;
		}
		if (eye == 1 && eyeStaging != stagingFormat) {
			LogUnsupportedOnce("mixed eye layer format", static_cast<unsigned>(desc[eye].Format));
			return;
		}
		stagingFormat = eyeStaging;
		bgra = eyeBgra;
		if (desc[eye].SampleDesc.Count > 1) {
			// A multisampled copy into a single-sample staging texture is invalid.
			LogUnsupportedOnce("multisampled eye layer, samples", desc[eye].SampleDesc.Count);
			return;
		}
		const int slice = request.slice[eye];
		if (slice < 0 || static_cast<UINT>(slice) >= desc[eye].ArraySize) return;
		subresource[eye] = D3D11CalcSubresource(0, static_cast<UINT>(slice), desc[eye].MipLevels);
		const float u0 = std::max(0.0f, std::min(1.0f, request.tileU0[eye]));
		const float u1 = std::max(0.0f, std::min(1.0f, request.tileU1[eye]));
		const float v0 = std::max(0.0f, std::min(1.0f, request.tileV0[eye]));
		const float v1 = std::max(0.0f, std::min(1.0f, request.tileV1[eye]));
		tileX[eye] = static_cast<int>(std::lround(desc[eye].Width * u0));
		tileY[eye] = static_cast<int>(std::lround(desc[eye].Height * v0));
		const int x1 = static_cast<int>(std::lround(desc[eye].Width * u1));
		const int y1 = static_cast<int>(std::lround(desc[eye].Height * v1));
		if (x1 - tileX[eye] < 64 || y1 - tileY[eye] < 64) return;
		tileWidth[eye] = static_cast<uint32_t>(x1 - tileX[eye]);
		tileHeight[eye] = static_cast<uint32_t>(y1 - tileY[eye]);
	}

	gxh1::FrameMeta meta;
	meta.eyeW = static_cast<uint16_t>(std::min<uint32_t>(65535u, std::min(tileWidth[0], tileWidth[1])));
	meta.eyeH = static_cast<uint16_t>(std::min<uint32_t>(65535u, std::min(tileHeight[0], tileHeight[1])));
	meta.frameId = request.frameId;
	meta.ptsNs = request.ptsNs;
	for (int eye = 0; eye < 2; ++eye) {
		meta.gazeValid[eye] = request.gazeValid[eye];
		// Continuous tile coordinates: u = 0 is the left edge of pixel 0.
		meta.gazeX[eye] = request.gazeU[eye] * static_cast<float>(meta.eyeW);
		meta.gazeY[eye] = request.gazeV[eye] * static_cast<float>(meta.eyeH);
		for (int i = 0; i < 4; ++i) meta.tan[eye][i] = request.tan[eye][i];
	}
	std::string reason;
	if (!producer.BeginFrame(meta, &reason)) return;

	// BeginFrame stored the plan; the eye origin is plan.eyeOrigin* plus the tile origin.
	const gxh1::FoveaPlan* plan = producer.InflightPlan();
	if (!plan || plan->canvasW == 0 || plan->canvasH == 0) {
		producer.AbortFrame();
		return;
	}
	const uint32_t canvasW = plan->canvasW;
	const uint32_t canvasH = plan->canvasH;
	D3D11_BOX boxes[2] = {};
	for (int eye = 0; eye < 2; ++eye) {
		D3D11_BOX& box = boxes[eye];
		box.left = static_cast<UINT>(tileX[eye] + plan->eyeOriginX[eye]);
		box.top = static_cast<UINT>(tileY[eye] + plan->eyeOriginY[eye]);
		box.right = box.left + canvasW;
		box.bottom = box.top + canvasH;
		box.front = 0;
		box.back = 1;
		if (box.right > desc[eye].Width || box.bottom > desc[eye].Height) {
			producer.AbortFrame();
			return;
		}
	}
	auto notePath = [&](const char* path) {
		if (g_lastPath != path) {
			g_lastPath = path;
			producer.NoteCapturePath(path);
		}
	};

	if (!g_sharedUnavailable && !gxh1::AstcGpuSharedCanvasBroken()) {
		SharedSlot& slot = g_slots[g_nextSlot];
		if (!EnsureSharedSlot(slot, device, canvasW, canvasH * 2u, stagingFormat)) {
			g_sharedUnavailable = true;
		} else {
			// Never wait here: a held slot means the encoder is still reading it.
			if (slot.mutex->AcquireSync(0, 0) != S_OK) {
				producer.AbortFrame();
				return;
			}
			for (int eye = 0; eye < 2; ++eye) {
				context->CopySubresourceRegion(slot.texture, 0, 0, static_cast<UINT>(eye) * canvasH, 0,
				                               request.source[eye], subresource[eye], &boxes[eye]);
			}
			slot.mutex->ReleaseSync(0);
			gxh1::GpuCanvasRef ref;
			ref.handle = slot.handle;
			ref.generation = slot.generation;
			ref.bgra = bgra;
			if (producer.SubmitGpuCanvas(ref, static_cast<int>(canvasW), static_cast<int>(canvasH))) {
				g_nextSlot ^= 1u;
				notePath("gpu_shared");
			} else {
				producer.AbortFrame();
			}
			return;
		}
	}

	// EnsureStaging compares the *stored* device against the requested one; assigning the
	// field before this call would let a device swap reuse a texture from the old device.
	if (!EnsureStaging(device, canvasW, canvasH * 2u, stagingFormat)) {
		producer.AbortFrame();
		return;
	}
	for (int eye = 0; eye < 2; ++eye) {
		context->CopySubresourceRegion(g_staging, 0, 0, static_cast<UINT>(eye) * canvasH, 0, request.source[eye],
		                               subresource[eye], &boxes[eye]);
	}

	// The Map waits for the copies (and the eye pass queued before them) on this thread.
	D3D11_MAPPED_SUBRESOURCE mapped = {};
	const HRESULT hr = context->Map(g_staging, 0, D3D11_MAP_READ, 0, &mapped);
	if (FAILED(hr)) {
		if (!g_loggedFailure) {
			g_loggedFailure = true;
			DriverLog("HybridCapture: staging map failed (0x%08X) — fovea capture disabled",
			          static_cast<unsigned>(hr));
		}
		producer.AbortFrame();
		return;
	}
	const uint8_t* base = static_cast<const uint8_t*>(mapped.pData);
	bool submitted = true;
	for (int eye = 0; eye < 2 && submitted; ++eye) {
		const uint8_t* rows = base + static_cast<size_t>(eye) * canvasH * mapped.RowPitch;
		submitted = producer.SubmitEye(eye, rows, static_cast<int>(mapped.RowPitch), static_cast<int>(canvasW),
		                               static_cast<int>(canvasH), bgra);
	}
	context->Unmap(g_staging, 0);
	if (!submitted) producer.AbortFrame();
	else notePath("cpu_staging");
}

void HybridCaptureRelease() {
	std::lock_guard<std::mutex> captureLock(g_captureLock);
	ReleaseStaging();
	for (SharedSlot& slot : g_slots) ReleaseSlot(slot);
	g_nextSlot = 0;
	g_sharedUnavailable = false;
	g_lastPath = nullptr;
	g_loggedUnsupported = false;
	g_loggedFailure = false;
	g_luidDevice = nullptr;
	// Retire the private encoder device with the mode. The encoder's own mutex drains an
	// in-flight batch before releasing; re-enable registers the seam again.
	gxh1::ShutdownAstcGpuEncoder();
}
