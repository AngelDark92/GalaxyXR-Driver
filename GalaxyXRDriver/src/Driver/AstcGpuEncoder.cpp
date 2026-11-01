// D3D11 compute ASTC encoder for the hybrid fovea rings.
//
// Produces the same bounded subset the CPU reference encoder and the client decoder use:
// 16-byte blocks, LDR single partition, one plane, FMT_RGB, QUANT_256 endpoints and
// bits-only (QUANT_2/4/8/16) weight grids, with the physical endpoint order R0,R1,G0,G1,B0,B1.
// Blocks are scored with the decoder's exact arithmetic (weight infill, then UNORM8
// endpoint interpolation), which is also what headset ASTC texture hardware computes.
//
// One submission per frame: the CPU builds a patch table and a flat grid table, and a single
// dispatch covers every block of every patch. The device is private to the producer worker
// (one immediate context, used only from that thread). The eye canvases normally arrive as a
// texture shared from the render device (both eyes stacked, keyed mutex key 0 on both
// sides), so raw pixels never touch the CPU; a CPU-uploaded canvas remains for the staging
// capture path and tests. Only compressed blocks are read back.
#include "AstcGpuEncoder.h"

#include <d3d11.h>
#include <d3dcompiler.h>
#include <dxgi1_2.h>

#include <algorithm>
#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <vector>

#include "../Hybrid/AstcBatchEncoder.h"
#include "../Hybrid/AstcSubset.h"
#include "DriverLog.h"

#pragma comment(lib, "D3D11.lib")
#pragma comment(lib, "dxgi.lib")
#pragma comment(lib, "D3DCompiler.lib")

namespace gxh1 {
namespace {

constexpr uint32_t kGridsPerPatch = 4;

struct GpuParams {
	uint32_t canvasW;
	uint32_t canvasH;
	uint32_t patchCount;
	uint32_t pad0;
};
static_assert(sizeof(GpuParams) % 16 == 0, "constant buffer must stay 16-byte aligned");

struct GpuPatch {
	uint32_t x;
	uint32_t y;
	uint32_t width;
	uint32_t height;
	uint32_t blockW;
	uint32_t blockH;
	uint32_t canvasSlice;
	uint32_t gridOffset;
	uint32_t gridCount;
	uint32_t blockStart;
	uint32_t blockEnd;
	uint32_t texels;  // texelW | texelH << 16 (the encoded grid; equals the rect at native density)
};
static_assert(sizeof(GpuPatch) == 48, "patch table entry layout");

const char* kShader = R"HLSL(
cbuffer Params : register(b0)
{
    uint canvasW;
    uint canvasH;
    uint patchCount;
    uint pad0;
};

Texture2D<float4> g_canvas : register(t0);  // eye 0 rows [0, canvasH), eye 1 below
StructuredBuffer<uint4> g_patchesRaw : register(t1);
StructuredBuffer<uint4> g_gridsFlat : register(t2);
RWStructuredBuffer<uint4> g_out : register(u0);

static const uint kUnq2[2] = { 0, 64 };
static const uint kUnq4[4] = { 0, 21, 43, 64 };
static const uint kUnq8[8]  = { 0, 9, 18, 27, 37, 46, 55, 64 };
static const uint kUnq16[16] = { 0, 4, 8, 12, 17, 21, 25, 29, 35, 39, 43, 47, 52, 56, 60, 64 };

uint Unq(uint levels, uint code)
{
    if (levels == 2) return kUnq2[code & 1u];
    if (levels == 4) return kUnq4[code & 3u];
    if (levels == 8) return kUnq8[code & 7u];
    return kUnq16[code & 15u];
}

// Nearest stored code for t in [0, 1]; the unquantized levels are not evenly spaced.
uint NearestCode(uint levels, float t)
{
    const float target = saturate(t) * 64.0f;
    uint best = 0;
    float bestDistance = 1.0e30f;
    for (uint code = 0; code < levels; ++code)
    {
        const float distance = abs((float)Unq(levels, code) - target);
        if (distance < bestDistance) { bestDistance = distance; best = code; }
    }
    return best;
}

// Resampling low-pass in linear light (the canvas holds display-encoded bytes).
float3 SrgbToLinear(float3 c)
{
    return c <= 0.04045f ? c / 12.92f : pow((c + 0.055f) / 1.055f, 2.4f);
}

float3 LinearToSrgb255(float3 l)
{
    l = saturate(l);
    const float3 c = l <= 0.0031308f ? l * 12.92f : 1.055f * pow(l, 1.0f / 2.4f) - 0.055f;
    return round(saturate(c) * 255.0f);
}

// ASTC LDR decode_unorm8: endpoints bit-replicated to 16 bits, mixed, top 8 bits kept.
int LerpUnorm8(int e0, int e1, int w)
{
    return (((e0 * 257) * (64 - w) + (e1 * 257) * w + 32) >> 6) >> 8;
}

void SetBit(inout uint words[4], uint pos, uint bit)
{
    const uint word = pos >> 5;
    const uint mask = 1u << (pos & 31u);
    if (bit != 0)
        words[word] |= mask;
    else
        words[word] &= ~mask;
}

[numthreads(64, 1, 1)]
void main(uint3 tid : SV_DispatchThreadID)
{
    const uint globalBlock = tid.x;

    // Locate the owning patch with a bounded linear scan (at most 64 patches).
    uint p = 0xFFFFFFFFu;
    for (uint i = 0; i < patchCount; ++i)
    {
        const uint4 b = g_patchesRaw[i * 3u + 1u];
        const uint4 c = g_patchesRaw[i * 3u + 2u];
        if (globalBlock >= c.y && globalBlock < c.z)
        {
            p = i;
            break;
        }
    }
    if (p == 0xFFFFFFFFu)
        return;

    const uint4 a = g_patchesRaw[p * 3u + 0u];
    const uint4 b = g_patchesRaw[p * 3u + 1u];
    const uint4 c = g_patchesRaw[p * 3u + 2u];
    const uint patchX = a.x;
    const uint patchY = a.y;
    const uint patchW = a.z;
    const uint patchH = a.w;
    const uint blockW = b.x;
    const uint blockH = b.y;
    const uint eyeRowOffset = b.z * canvasH;
    const uint gridOffset = b.w;
    const uint gridCount = c.x;
    const uint blockStart = c.y;
    const uint localBlock = globalBlock - blockStart;

    const uint texelW = c.w & 0xFFFFu;
    const uint texelH = c.w >> 16;
    const uint blocksX = (texelW + blockW - 1u) / blockW;
    const uint bx = localBlock % blocksX;
    const uint by = localBlock / blocksX;

    // Each texel covers [x0, x1) x [y0, y1) of the patch rect: one pixel at native density,
    // otherwise the linear-light mean of the pixels it spans (low-pass before decimation).
    float3 tex[144];
    for (uint y = 0; y < blockH; ++y)
    {
        const uint ty = min(by * blockH + y, texelH - 1u);
        const uint y0 = ty * patchH / texelH;
        const uint y1 = max(y0 + 1u, ((ty + 1u) * patchH + texelH - 1u) / texelH);
        for (uint x = 0; x < blockW; ++x)
        {
            const uint tx = min(bx * blockW + x, texelW - 1u);
            const uint x0 = tx * patchW / texelW;
            const uint x1 = max(x0 + 1u, ((tx + 1u) * patchW + texelW - 1u) / texelW);
            if (x1 - x0 == 1u && y1 - y0 == 1u)
            {
                tex[y * blockW + x] = round(g_canvas.Load(int3(patchX + x0, patchY + y0 + eyeRowOffset, 0)).rgb * 255.0f);
                continue;
            }
            float3 sum = float3(0.0f, 0.0f, 0.0f);
            for (uint sy = y0; sy < y1; ++sy)
            {
                for (uint sx = x0; sx < x1; ++sx)
                    sum += SrgbToLinear(g_canvas.Load(int3(patchX + sx, patchY + sy + eyeRowOffset, 0)).rgb);
            }
            tex[y * blockW + x] = LinearToSrgb255(sum / (float)((x1 - x0) * (y1 - y0)));
        }
    }
    const uint texelCount = blockW * blockH;

    float bestError = 1.0e30f;
    uint bestBlock[4] = { 0u, 0u, 0u, 0u };

    for (uint g = 0; g < gridCount; ++g)
    {
        const uint4 grid = g_gridsFlat[gridOffset + g];
        const uint gx = grid.x;
        const uint gy = grid.y;
        const uint bits = grid.z & 0xFFu;
        const uint levels = (grid.z >> 8) & 0xFFu;
        const uint mode = grid.w;
        const uint nodes = gx * gy;

        uint lo = 0;
        uint hi = 0;
        float loLuma = 1.0e30f;
        float hiLuma = -1.0e30f;
        for (uint i = 0; i < texelCount; ++i)
        {
            const float luma = dot(tex[i], float3(0.299f, 0.587f, 0.114f));
            if (luma < loLuma) { loLuma = luma; lo = i; }
            if (luma > hiLuma) { hiLuma = luma; hi = i; }
        }
        float3 e0 = tex[lo];
        float3 e1 = tex[hi];

        uint code[64];
        float err = 0.0f;

        for (uint iteration = 0; iteration < 2; ++iteration)
        {
            float3 delta = e1 - e0;
            const float denom = dot(delta, delta);

            float nodeT[64];
            float nodeW[64];
            for (uint n = 0; n < nodes; ++n) { nodeT[n] = 0.0f; nodeW[n] = 0.0f; }

            for (uint i = 0; i < texelCount; ++i)
            {
                const uint x = i % blockW;
                const uint y = i / blockW;
                const uint xw = (((1024u + blockW / 2u) / (blockW - 1u)) * x * (gx - 1u) + 32u) >> 6u;
                const uint yw = (((1024u + blockH / 2u) / (blockH - 1u)) * y * (gy - 1u) + 32u) >> 6u;
                const uint xf = xw & 15u;
                const uint yf = yw & 15u;
                const uint xi = xw >> 4u;
                const uint yi = yw >> 4u;

                uint qi[4];
                qi[0] = xi + yi * gx;
                qi[1] = qi[0] + 1u;
                qi[2] = qi[0] + gx;
                qi[3] = qi[2] + 1u;

                const uint prod = xf * yf;
                uint c[4];
                c[3] = (prod + 8u) >> 4u;
                c[1] = xf - c[3];
                c[2] = yf - c[3];
                c[0] = 16u - xf - yf + c[3];

                float t = 0.0f;
                if (denom > 1.0e-6f)
                    t = clamp(dot(tex[i] - e0, delta) / denom, 0.0f, 1.0f);

                for (uint k = 0; k < 4; ++k)
                {
                    if (c[k] == 0u || qi[k] >= nodes)
                        continue;
                    nodeT[qi[k]] += t * (float)c[k];
                    nodeW[qi[k]] += (float)c[k];
                }
            }

            for (uint n = 0; n < nodes; ++n)
            {
                const float t = nodeW[n] > 0.0f ? nodeT[n] / nodeW[n] : 0.0f;
                code[n] = NearestCode(levels, t);
            }

            float a00 = 0.0f, a01 = 0.0f, a11 = 0.0f;
            float b0[3] = { 0.0f, 0.0f, 0.0f };
            float b1[3] = { 0.0f, 0.0f, 0.0f };
            for (uint i = 0; i < texelCount; ++i)
            {
                const uint x = i % blockW;
                const uint y = i / blockW;
                const uint xw = (((1024u + blockW / 2u) / (blockW - 1u)) * x * (gx - 1u) + 32u) >> 6u;
                const uint yw = (((1024u + blockH / 2u) / (blockH - 1u)) * y * (gy - 1u) + 32u) >> 6u;
                const uint xf = xw & 15u;
                const uint yf = yw & 15u;
                const uint xi = xw >> 4u;
                const uint yi = yw >> 4u;
                uint qi[4];
                qi[0] = xi + yi * gx;
                qi[1] = qi[0] + 1u;
                qi[2] = qi[0] + gx;
                qi[3] = qi[2] + 1u;
                const uint prod = xf * yf;
                uint c[4];
                c[3] = (prod + 8u) >> 4u;
                c[1] = xf - c[3];
                c[2] = yf - c[3];
                c[0] = 16u - xf - yf + c[3];

                float wsum = 0.0f;
                for (uint k = 0; k < 4; ++k)
                {
                    if (c[k] == 0u || qi[k] >= nodes)
                        continue;
                    wsum += (float)c[k] * (float)Unq(levels, code[qi[k]]);
                }
                const float t = wsum / (16.0f * 64.0f);
                const float u = 1.0f - t;
                a00 += u * u;
                a01 += u * t;
                a11 += t * t;
                for (uint ch = 0; ch < 3; ++ch)
                {
                    b0[ch] += u * tex[i][ch];
                    b1[ch] += t * tex[i][ch];
                }
            }
            const float det = a00 * a11 - a01 * a01;
            if (abs(det) > 1.0e-6f)
            {
                for (uint ch = 0; ch < 3; ++ch)
                {
                    const float v0 = (b0[ch] * a11 - b1[ch] * a01) / det;
                    const float v1 = (b1[ch] * a00 - b0[ch] * a01) / det;
                    e0[ch] = clamp(v0, 0.0f, 255.0f);
                    e1[ch] = clamp(v1, 0.0f, 255.0f);
                }
            }

            // Score the emitted form: endpoints are stored with sum(e0) <= sum(e1) (the
            // other order would decode through blue contraction), so swap and invert here.
            // The inverted infill can round differently by one, so score after the swap.
            const int3 r0 = int3((int)round(e0.x), (int)round(e0.y), (int)round(e0.z));
            const int3 r1 = int3((int)round(e1.x), (int)round(e1.y), (int)round(e1.z));
            if (r0.x + r0.y + r0.z > r1.x + r1.y + r1.z)
            {
                const float3 tmp = e0;
                e0 = e1;
                e1 = tmp;
                for (uint n = 0; n < nodes; ++n) code[n] = levels - 1u - code[n];
            }
            const int3 q0 = int3((int)round(e0.x), (int)round(e0.y), (int)round(e0.z));
            const int3 q1 = int3((int)round(e1.x), (int)round(e1.y), (int)round(e1.z));

            err = 0.0f;
            for (uint i = 0; i < texelCount; ++i)
            {
                const uint x = i % blockW;
                const uint y = i / blockW;
                const uint xw = (((1024u + blockW / 2u) / (blockW - 1u)) * x * (gx - 1u) + 32u) >> 6u;
                const uint yw = (((1024u + blockH / 2u) / (blockH - 1u)) * y * (gy - 1u) + 32u) >> 6u;
                const uint xf = xw & 15u;
                const uint yf = yw & 15u;
                const uint xi = xw >> 4u;
                const uint yi = yw >> 4u;
                uint qi[4];
                qi[0] = xi + yi * gx;
                qi[1] = qi[0] + 1u;
                qi[2] = qi[0] + gx;
                qi[3] = qi[2] + 1u;
                const uint prod = xf * yf;
                uint c[4];
                c[3] = (prod + 8u) >> 4u;
                c[1] = xf - c[3];
                c[2] = yf - c[3];
                c[0] = 16u - xf - yf + c[3];

                int wacc = 0;
                for (uint k = 0; k < 4; ++k)
                {
                    if (c[k] == 0u || qi[k] >= nodes)
                        continue;
                    wacc += (int)c[k] * (int)Unq(levels, code[qi[k]]);
                }
                const int w = (wacc + 8) >> 4;
                for (uint ch = 0; ch < 3; ++ch)
                {
                    const int value = LerpUnorm8(q0[ch], q1[ch], w);
                    const float diff = (float)value - tex[i][ch];
                    err += diff * diff;
                }
            }
        }

        if (err < bestError)
        {
            bestError = err;
            int e0i[3] = { (int)round(e0.x), (int)round(e0.y), (int)round(e0.z) };
            int e1i[3] = { (int)round(e1.x), (int)round(e1.y), (int)round(e1.z) };
            uint codes[64];
            for (uint n = 0; n < nodes; ++n) codes[n] = code[n];

            // Already canonical (sum(e0) <= sum(e1)) from the scoring swap above; kept as a
            // guard so an emitted block can never decode through blue contraction.
            if (e0i[0] + e0i[1] + e0i[2] > e1i[0] + e1i[1] + e1i[2])
            {
                for (uint ch = 0; ch < 3; ++ch)
                {
                    const int tmp = e0i[ch];
                    e0i[ch] = e1i[ch];
                    e1i[ch] = tmp;
                }
                for (uint n = 0; n < nodes; ++n) codes[n] = levels - 1u - codes[n];
            }

            bestBlock[0] = 0u; bestBlock[1] = 0u; bestBlock[2] = 0u; bestBlock[3] = 0u;
            for (uint bit = 0; bit < 11u; ++bit)
            {
                if (((mode >> bit) & 1u) != 0u) SetBit(bestBlock, bit, 1u);
            }
            for (uint bit = 0; bit < 4u; ++bit)
            {
                if (((8u >> bit) & 1u) != 0u) SetBit(bestBlock, 13u + bit, 1u);
            }
            const int physical[6] = { e0i[0], e1i[0], e0i[1], e1i[1], e0i[2], e1i[2] };
            for (uint i = 0; i < 6u; ++i)
            {
                for (uint bit = 0; bit < 8u; ++bit)
                {
                    if ((((uint)physical[i] >> bit) & 1u) != 0u) SetBit(bestBlock, 17u + i * 8u + bit, 1u);
                }
            }
            for (uint n = 0; n < nodes; ++n)
            {
                for (uint bit = 0; bit < bits; ++bit)
                {
                    if (((codes[n] >> bit) & 1u) != 0u) SetBit(bestBlock, 127u - (n * bits + bit), 1u);
                }
            }
        }
    }

    g_out[globalBlock] = uint4(bestBlock[0], bestBlock[1], bestBlock[2], bestBlock[3]);
}
)HLSL";

std::mutex g_mutex;
bool g_registered = false;
uint64_t g_adapterLuid = 0;
uint64_t g_createdLuid = 0;

ID3D11Device* g_device = nullptr;
ID3D11DeviceContext* g_context = nullptr;
ID3D11ComputeShader* g_shader = nullptr;
ID3D11Texture2D* g_canvas = nullptr;
uint32_t g_canvasW = 0;
uint32_t g_canvasH = 0;
ID3D11ShaderResourceView* g_canvasSrv = nullptr;
ID3D11Buffer* g_output = nullptr;
ID3D11UnorderedAccessView* g_outputUav = nullptr;
ID3D11Buffer* g_staging = nullptr;
uint32_t g_outputBlocks = 0;
ID3D11Buffer* g_params = nullptr;
ID3D11Buffer* g_patchBuffer = nullptr;
ID3D11ShaderResourceView* g_patchSrv = nullptr;
uint32_t g_patchCapacity = 0;
ID3D11Buffer* g_gridBuffer = nullptr;
ID3D11ShaderResourceView* g_gridSrv = nullptr;
uint32_t g_gridCapacity = 0;

// Shared capture canvases opened on this device (the capture side alternates two slots).
struct OpenedCanvas {
	void* handle = nullptr;
	uint64_t generation = 0;
	ID3D11Texture2D* texture = nullptr;
	IDXGIKeyedMutex* mutex = nullptr;
	ID3D11ShaderResourceView* srv = nullptr;
	uint32_t width = 0;
	uint32_t height = 0;
	DXGI_FORMAT format = DXGI_FORMAT_UNKNOWN;
};
OpenedCanvas g_opened[4];
uint32_t g_openedNext = 0;
ID3D11Texture2D* g_readStaging = nullptr;  // PyroWave readback of a shared canvas
uint32_t g_readStagingW = 0;
uint32_t g_readStagingH = 0;
DXGI_FORMAT g_readStagingFormat = DXGI_FORMAT_UNKNOWN;
// Set when this device cannot open the render device's canvases (e.g. another adapter);
// the capture side then uses its staging path, visibly.
std::atomic<bool> g_shareBroken{false};
constexpr DWORD kCanvasWaitMs = 100;

uint64_t LuidToU64(const LUID& luid) {
	return (static_cast<uint64_t>(static_cast<uint32_t>(luid.HighPart)) << 32) |
	       static_cast<uint64_t>(luid.LowPart);
}

void ReleaseSurface() {
	if (g_canvasSrv) { g_canvasSrv->Release(); g_canvasSrv = nullptr; }
	if (g_canvas) { g_canvas->Release(); g_canvas = nullptr; }
	g_canvasW = g_canvasH = 0;
	if (g_outputUav) { g_outputUav->Release(); g_outputUav = nullptr; }
	if (g_output) { g_output->Release(); g_output = nullptr; }
	if (g_staging) { g_staging->Release(); g_staging = nullptr; }
	g_outputBlocks = 0;
}

void ReleaseOpened() {
	for (OpenedCanvas& opened : g_opened) {
		if (opened.srv) opened.srv->Release();
		if (opened.mutex) opened.mutex->Release();
		if (opened.texture) opened.texture->Release();
		opened = OpenedCanvas{};
	}
	g_openedNext = 0;
	if (g_readStaging) { g_readStaging->Release(); g_readStaging = nullptr; }
	g_readStagingW = g_readStagingH = 0;
	g_readStagingFormat = DXGI_FORMAT_UNKNOWN;
}

void ReleaseAll() {
	ReleaseOpened();
	ReleaseSurface();
	if (g_patchSrv) { g_patchSrv->Release(); g_patchSrv = nullptr; }
	if (g_patchBuffer) { g_patchBuffer->Release(); g_patchBuffer = nullptr; }
	g_patchCapacity = 0;
	if (g_gridSrv) { g_gridSrv->Release(); g_gridSrv = nullptr; }
	if (g_gridBuffer) { g_gridBuffer->Release(); g_gridBuffer = nullptr; }
	g_gridCapacity = 0;
	if (g_params) { g_params->Release(); g_params = nullptr; }
	if (g_shader) { g_shader->Release(); g_shader = nullptr; }
	if (g_context) { g_context->Release(); g_context = nullptr; }
	if (g_device) { g_device->Release(); g_device = nullptr; }
}

bool CreateDevice(std::string* error) {
	IDXGIFactory1* factory = nullptr;
	if (FAILED(CreateDXGIFactory1(__uuidof(IDXGIFactory1), reinterpret_cast<void**>(&factory))) || !factory) {
		if (error) *error = "dxgi_factory";
		return false;
	}

	IDXGIAdapter1* chosen = nullptr;
	IDXGIAdapter1* best = nullptr;
	SIZE_T bestVram = 0;
	for (UINT index = 0;; ++index) {
		IDXGIAdapter1* adapter = nullptr;
		if (factory->EnumAdapters1(index, &adapter) == DXGI_ERROR_NOT_FOUND) break;
		if (!adapter) continue;
		DXGI_ADAPTER_DESC1 desc = {};
		if (SUCCEEDED(adapter->GetDesc1(&desc)) && (desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) == 0) {
			if (g_adapterLuid != 0 && LuidToU64(desc.AdapterLuid) == g_adapterLuid) {
				chosen = adapter;
				chosen->AddRef();
				adapter->Release();
				break;
			}
			if (!best || desc.DedicatedVideoMemory > bestVram) {
				if (best) best->Release();
				best = adapter;
				best->AddRef();
				bestVram = desc.DedicatedVideoMemory;
			}
		}
		adapter->Release();
	}
	factory->Release();
	// A LUID match found after an earlier fallback candidate releases that candidate.
	if (chosen) {
		if (best) best->Release();
	} else {
		chosen = best;
	}
	if (!chosen) {
		if (error) *error = "no_hardware_adapter";
		return false;
	}

	const D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0};
	ID3D11Device* created = nullptr;
	ID3D11DeviceContext* createdContext = nullptr;
	HRESULT hr = D3D11CreateDevice(chosen, D3D_DRIVER_TYPE_UNKNOWN, nullptr, 0, levels, 2, D3D11_SDK_VERSION,
	                               &created, nullptr, &createdContext);
	if (FAILED(hr)) {
		hr = D3D11CreateDevice(chosen, D3D_DRIVER_TYPE_UNKNOWN, nullptr, 0, &levels[1], 1, D3D11_SDK_VERSION,
		                       &created, nullptr, &createdContext);
	}
	{
		DXGI_ADAPTER_DESC1 adapterDesc = {};
		if (SUCCEEDED(chosen->GetDesc1(&adapterDesc))) {
			DriverLog("Hybrid: ASTC encoder adapter: %ls (%llu MB dedicated)", adapterDesc.Description,
			          static_cast<unsigned long long>(adapterDesc.DedicatedVideoMemory / (1024ull * 1024ull)));
		}
	}
	chosen->Release();
	if (FAILED(hr) || !created || !createdContext) {
		if (error) *error = "d3d11_device";
		return false;
	}
	g_device = created;
	g_context = createdContext;

	ID3DBlob* blob = nullptr;
	ID3DBlob* errors = nullptr;
	hr = D3DCompile(kShader, std::strlen(kShader), "gxh1_astc_cs", nullptr, nullptr, "main", "cs_5_0",
	                D3DCOMPILE_OPTIMIZATION_LEVEL3, 0, &blob, &errors);
	if (FAILED(hr) || !blob) {
		if (error) *error = errors ? static_cast<const char*>(errors->GetBufferPointer()) : "shader_compile";
		if (errors) errors->Release();
		return false;
	}
	hr = g_device->CreateComputeShader(blob->GetBufferPointer(), blob->GetBufferSize(), nullptr, &g_shader);
	blob->Release();
	if (errors) errors->Release();
	if (FAILED(hr)) {
		if (error) *error = "shader_create";
		return false;
	}

	D3D11_BUFFER_DESC cb = {};
	cb.ByteWidth = sizeof(GpuParams);
	cb.Usage = D3D11_USAGE_DYNAMIC;
	cb.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
	cb.CPUAccessFlags = D3D11_CPU_ACCESS_WRITE;
	if (FAILED(g_device->CreateBuffer(&cb, nullptr, &g_params))) {
		if (error) *error = "cb_create";
		return false;
	}
	{
		IDXGIDevice* dxgiDevice = nullptr;
		IDXGIAdapter* adapter = nullptr;
		if (SUCCEEDED(g_device->QueryInterface(__uuidof(IDXGIDevice), reinterpret_cast<void**>(&dxgiDevice))) &&
		    dxgiDevice) {
			if (SUCCEEDED(dxgiDevice->GetAdapter(&adapter)) && adapter) {
				DXGI_ADAPTER_DESC desc = {};
				if (SUCCEEDED(adapter->GetDesc(&desc))) g_createdLuid = LuidToU64(desc.AdapterLuid);
				adapter->Release();
			}
			dxgiDevice->Release();
		}
	}
	return true;
}

bool EnsureDevice(std::string* error) {
	if (g_device && (g_adapterLuid == 0 || g_createdLuid == g_adapterLuid)) return true;
	if (g_device) {
		// The render device arrived after the encoder was created on another adapter;
		// rebuild once on the requested LUID so encode and NVENC share silicon.
		ReleaseAll();
		g_createdLuid = 0;
	}
	return CreateDevice(error);
}

// CPU-uploaded canvas (staging capture path and tests): width x 2*height, eyes stacked.
bool EnsureCanvas(uint32_t width, uint32_t height) {
	if (g_canvas && g_canvasW == width && g_canvasH == height) return true;
	if (g_canvasSrv) { g_canvasSrv->Release(); g_canvasSrv = nullptr; }
	if (g_canvas) { g_canvas->Release(); g_canvas = nullptr; }
	g_canvasW = g_canvasH = 0;

	D3D11_TEXTURE2D_DESC desc = {};
	desc.Width = width;
	desc.Height = height * 2u;
	desc.MipLevels = 1;
	desc.ArraySize = 1;
	desc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
	desc.SampleDesc.Count = 1;
	desc.Usage = D3D11_USAGE_DEFAULT;
	desc.BindFlags = D3D11_BIND_SHADER_RESOURCE;
	if (FAILED(g_device->CreateTexture2D(&desc, nullptr, &g_canvas))) return false;
	if (FAILED(g_device->CreateShaderResourceView(g_canvas, nullptr, &g_canvasSrv))) return false;
	g_canvasW = width;
	g_canvasH = height;
	return true;
}

// Opens (once per handle generation) a capture canvas shared from the render device.
OpenedCanvas* OpenCanvas(const GpuCanvasRef& ref, std::string* error) {
	for (OpenedCanvas& opened : g_opened) {
		if (opened.texture && opened.handle == ref.handle && opened.generation == ref.generation) return &opened;
	}
	OpenedCanvas& slot = g_opened[g_openedNext];
	g_openedNext = (g_openedNext + 1) % (sizeof(g_opened) / sizeof(g_opened[0]));
	if (slot.srv) slot.srv->Release();
	if (slot.mutex) slot.mutex->Release();
	if (slot.texture) slot.texture->Release();
	slot = OpenedCanvas{};

	ID3D11Texture2D* texture = nullptr;
	if (FAILED(g_device->OpenSharedResource(reinterpret_cast<HANDLE>(ref.handle), __uuidof(ID3D11Texture2D),
	                                        reinterpret_cast<void**>(&texture))) || !texture) {
		g_shareBroken.store(true, std::memory_order_relaxed);
		if (error) *error = "gpu_canvas_open";
		return nullptr;
	}
	IDXGIKeyedMutex* mutex = nullptr;
	if (FAILED(texture->QueryInterface(__uuidof(IDXGIKeyedMutex), reinterpret_cast<void**>(&mutex))) || !mutex) {
		texture->Release();
		g_shareBroken.store(true, std::memory_order_relaxed);
		if (error) *error = "gpu_canvas_mutex";
		return nullptr;
	}
	D3D11_TEXTURE2D_DESC desc = {};
	texture->GetDesc(&desc);
	ID3D11ShaderResourceView* srv = nullptr;
	if (FAILED(g_device->CreateShaderResourceView(texture, nullptr, &srv)) || !srv) {
		mutex->Release();
		texture->Release();
		if (error) *error = "gpu_canvas_srv";
		return nullptr;
	}
	slot.handle = ref.handle;
	slot.generation = ref.generation;
	slot.texture = texture;
	slot.mutex = mutex;
	slot.srv = srv;
	slot.width = desc.Width;
	slot.height = desc.Height;
	slot.format = desc.Format;
	return &slot;
}

bool EnsureOutput(uint32_t blocks) {
	// Reuse only a complete set: a growth that failed half-way must not leave a capacity that
	// lets a later, smaller batch run with a missing view or staging buffer.
	if (g_output && g_outputUav && g_staging && g_outputBlocks >= blocks) return true;
	g_outputBlocks = 0;
	if (g_outputUav) { g_outputUav->Release(); g_outputUav = nullptr; }
	if (g_output) { g_output->Release(); g_output = nullptr; }
	if (g_staging) { g_staging->Release(); g_staging = nullptr; }

	const uint32_t capacity = std::max<uint32_t>(blocks, 1024u);
	D3D11_BUFFER_DESC desc = {};
	desc.ByteWidth = capacity * 16u;
	desc.Usage = D3D11_USAGE_DEFAULT;
	desc.BindFlags = D3D11_BIND_UNORDERED_ACCESS;
	desc.MiscFlags = D3D11_RESOURCE_MISC_BUFFER_STRUCTURED;
	desc.StructureByteStride = 16;
	if (FAILED(g_device->CreateBuffer(&desc, nullptr, &g_output))) return false;

	D3D11_UNORDERED_ACCESS_VIEW_DESC uav = {};
	uav.Format = DXGI_FORMAT_UNKNOWN;
	uav.ViewDimension = D3D11_UAV_DIMENSION_BUFFER;
	uav.Buffer.NumElements = capacity;
	if (FAILED(g_device->CreateUnorderedAccessView(g_output, &uav, &g_outputUav))) return false;

	D3D11_BUFFER_DESC staging = desc;
	staging.Usage = D3D11_USAGE_STAGING;
	staging.BindFlags = 0;
	staging.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
	if (FAILED(g_device->CreateBuffer(&staging, nullptr, &g_staging))) return false;
	g_outputBlocks = capacity;
	return true;
}

bool EnsureStructured(ID3D11Buffer** buffer, ID3D11ShaderResourceView** srv, uint32_t* capacity, uint32_t count,
                      uint32_t stride) {
	if (*buffer && *srv && *capacity >= count) return true;
	*capacity = 0;
	if (*srv) { (*srv)->Release(); *srv = nullptr; }
	if (*buffer) { (*buffer)->Release(); *buffer = nullptr; }
	const uint32_t elements = std::max<uint32_t>(count, 256u);
	D3D11_BUFFER_DESC desc = {};
	desc.ByteWidth = elements * stride;
	desc.Usage = D3D11_USAGE_DEFAULT;
	desc.BindFlags = D3D11_BIND_SHADER_RESOURCE;
	desc.MiscFlags = D3D11_RESOURCE_MISC_BUFFER_STRUCTURED;
	desc.StructureByteStride = stride;
	if (FAILED(g_device->CreateBuffer(&desc, nullptr, buffer))) return false;
	D3D11_SHADER_RESOURCE_VIEW_DESC view = {};
	view.Format = DXGI_FORMAT_UNKNOWN;
	view.ViewDimension = D3D11_SRV_DIMENSION_BUFFER;
	view.Buffer.NumElements = elements;
	if (FAILED(g_device->CreateShaderResourceView(*buffer, &view, srv))) return false;
	*capacity = elements;
	return true;
}

bool EncodeBatch(const AstcBatchRequest& request, std::string* error) {
	const bool shared = request.gpuCanvas.handle != nullptr;
	if ((!shared && (!request.canvas[0] || !request.canvas[1])) || !request.patches || !request.output) return false;
	if (request.canvasW <= 0 || request.canvasH <= 0 || request.patchCount == 0) return false;

	std::lock_guard<std::mutex> lock(g_mutex);
	if (!g_registered) {
		if (error) *error = "not_registered";
		return false;
	}
	if (!EnsureDevice(error)) return false;

	const uint32_t width = static_cast<uint32_t>(request.canvasW);
	const uint32_t height = static_cast<uint32_t>(request.canvasH);
	OpenedCanvas* sharedCanvas = nullptr;
	if (shared) {
		sharedCanvas = OpenCanvas(request.gpuCanvas, error);
		if (!sharedCanvas) return false;
		if (sharedCanvas->width < width || sharedCanvas->height < height * 2u) {
			if (error) *error = "gpu_canvas_size";
			return false;
		}
	} else if (!EnsureCanvas(width, height)) {
		if (error) *error = "canvas_resource";
		return false;
	}

	// Build the patch and grid tables. Grids are cached per footprint so a frame with one
	// footprint per annulus uploads a handful of entries, not one table per patch.
	struct FootprintGrids {
		uint8_t blockW;
		uint8_t blockH;
		uint32_t offset;
		uint32_t count;
	};
	std::vector<FootprintGrids> footprintGrids;
	std::vector<uint32_t> gridWords;  // uint4 per grid, flattened
	std::vector<GpuPatch> patches(request.patchCount);
	uint64_t totalBlocks = 0;

	for (size_t i = 0; i < request.patchCount; ++i) {
		const PlannedPatch& patch = request.patches[i];
		if (patch.width == 0 || patch.height == 0) return false;
		const std::vector<AstcGrid>& candidates = AstcGridCandidates(patch.blockW, patch.blockH);
		if (candidates.empty()) {
			if (error) *error = "grid_table";
			return false;
		}
		uint32_t gridOffset = 0;
		uint32_t gridCount = 0;
		for (const FootprintGrids& entry : footprintGrids) {
			if (entry.blockW == patch.blockW && entry.blockH == patch.blockH) {
				gridOffset = entry.offset;
				gridCount = entry.count;
				break;
			}
		}
		if (gridCount == 0) {
			const uint32_t offset = static_cast<uint32_t>(gridWords.size() / 4u);
			const uint32_t count = static_cast<uint32_t>(std::min<size_t>(candidates.size(), kGridsPerPatch));
			for (uint32_t g = 0; g < count; ++g) {
				const AstcGrid& grid = candidates[g];
				gridWords.push_back(grid.gridX);
				gridWords.push_back(grid.gridY);
				gridWords.push_back((static_cast<uint32_t>(1u << grid.bits) << 8) | grid.bits);
				gridWords.push_back(grid.blockMode);
			}
			footprintGrids.push_back(FootprintGrids{patch.blockW, patch.blockH, offset, count});
			gridOffset = offset;
			gridCount = count;
		}

		const uint32_t texelW = patch.texelW ? patch.texelW : patch.width;
		const uint32_t texelH = patch.texelH ? patch.texelH : patch.height;
		if (texelW > patch.width || texelH > patch.height) return false;
		const uint32_t blocksX = (texelW + patch.blockW - 1u) / patch.blockW;
		const uint32_t blocksY = (texelH + patch.blockH - 1u) / patch.blockH;
		const uint32_t blocks = blocksX * blocksY;
		GpuPatch& gpu = patches[i];
		gpu.x = patch.x;
		gpu.y = patch.y;
		gpu.width = patch.width;
		gpu.height = patch.height;
		gpu.blockW = patch.blockW;
		gpu.blockH = patch.blockH;
		gpu.canvasSlice = patch.eye;
		gpu.gridOffset = gridOffset;
		gpu.gridCount = gridCount;
		gpu.blockStart = static_cast<uint32_t>(totalBlocks);
		totalBlocks += blocks;
		gpu.blockEnd = static_cast<uint32_t>(totalBlocks);
		gpu.texels = texelW | (texelH << 16);
	}
	if (totalBlocks == 0 || totalBlocks > (1u << 22)) {
		if (error) *error = "block_overflow";
		return false;
	}
	if (!EnsureOutput(static_cast<uint32_t>(totalBlocks))) {
		if (error) *error = "output_resource";
		return false;
	}
	if (!EnsureStructured(&g_patchBuffer, &g_patchSrv, &g_patchCapacity,
	                      static_cast<uint32_t>(request.patchCount) * 3u, 16u)) {
		if (error) *error = "patch_resource";
		return false;
	}
	if (!EnsureStructured(&g_gridBuffer, &g_gridSrv, &g_gridCapacity, static_cast<uint32_t>(gridWords.size() / 4u),
	                      sizeof(uint32_t) * 4u)) {
		if (error) *error = "grid_resource";
		return false;
	}

	// The shader reads three uint4 per patch: rect, footprint+block range, slice+grid index.
	// UpdateSubresource copies the whole destination when pDstBox is null, so the source
	// storage is padded to the resource capacity instead of reading past these vectors.
	std::vector<uint32_t> packed(static_cast<size_t>(g_patchCapacity) * 4u, 0);
	for (size_t i = 0; i < request.patchCount; ++i) {
		const GpuPatch& p = patches[i];
		uint32_t* entry = packed.data() + i * 12u;
		entry[0] = p.x;
		entry[1] = p.y;
		entry[2] = p.width;
		entry[3] = p.height;
		entry[4] = p.blockW;
		entry[5] = p.blockH;
		entry[6] = p.canvasSlice;
		entry[7] = p.gridOffset;
		entry[8] = p.gridCount;
		entry[9] = p.blockStart;
		entry[10] = p.blockEnd;
		entry[11] = p.texels;
	}
	std::vector<uint32_t> gridUpload(static_cast<size_t>(g_gridCapacity) * 4u, 0);
	std::memcpy(gridUpload.data(), gridWords.data(), gridWords.size() * sizeof(uint32_t));
	g_context->UpdateSubresource(g_patchBuffer, 0, nullptr, packed.data(), 0, 0);
	g_context->UpdateSubresource(g_gridBuffer, 0, nullptr, gridUpload.data(), 0, 0);
	if (!shared) {
		for (UINT eye = 0; eye < 2; ++eye) {
			D3D11_BOX box = {0, eye * height, 0, width, (eye + 1) * height, 1};
			g_context->UpdateSubresource(g_canvas, 0, &box, request.canvas[eye], width * 4u, 0);
		}
	}

	D3D11_MAPPED_SUBRESOURCE mapped = {};
	if (FAILED(g_context->Map(g_params, 0, D3D11_MAP_WRITE_DISCARD, 0, &mapped))) {
		if (error) *error = "cb_map";
		return false;
	}
	GpuParams* params = static_cast<GpuParams*>(mapped.pData);
	params->canvasW = width;
	params->canvasH = height;
	params->patchCount = static_cast<uint32_t>(request.patchCount);
	params->pad0 = 0;
	g_context->Unmap(g_params, 0);

	// The render device released the canvas after queueing its copies; this wait is on the
	// worker, never on the render thread.
	if (shared && sharedCanvas->mutex->AcquireSync(0, kCanvasWaitMs) != S_OK) {
		if (error) *error = "gpu_canvas_timeout";
		return false;
	}
	g_context->CSSetShader(g_shader, nullptr, 0);
	ID3D11Buffer* cbs[] = {g_params};
	ID3D11ShaderResourceView* srvs[] = {shared ? sharedCanvas->srv : g_canvasSrv, g_patchSrv, g_gridSrv};
	ID3D11UnorderedAccessView* uavs[] = {g_outputUav};
	g_context->CSSetConstantBuffers(0, 1, cbs);
	g_context->CSSetShaderResources(0, 3, srvs);
	g_context->CSSetUnorderedAccessViews(0, 1, uavs, nullptr);
	g_context->Dispatch((static_cast<uint32_t>(totalBlocks) + 63u) / 64u, 1, 1);
	if (shared) {
		// Unbind before handing the canvas back; the release orders the render device's next
		// copy after this dispatch on the GPU.
		ID3D11ShaderResourceView* unbound[1] = {nullptr};
		g_context->CSSetShaderResources(0, 1, unbound);
		sharedCanvas->mutex->ReleaseSync(0);
	}

	g_context->CopyResource(g_staging, g_output);
	D3D11_MAPPED_SUBRESOURCE readback = {};
	if (FAILED(g_context->Map(g_staging, 0, D3D11_MAP_READ, 0, &readback))) {
		if (error) *error = "readback_map";
		return false;
	}
	const uint8_t* bytes = static_cast<const uint8_t*>(readback.pData);
	for (size_t i = 0; i < request.patchCount; ++i) {
		const GpuPatch& p = patches[i];
		std::vector<uint8_t>& out = (*request.output)[i];
		out.resize(static_cast<size_t>(p.blockEnd - p.blockStart) * 16u);
		std::memcpy(out.data(), bytes + static_cast<size_t>(p.blockStart) * 16u, out.size());
	}
	g_context->Unmap(g_staging, 0);

	ID3D11ShaderResourceView* nullSrvs[3] = {nullptr, nullptr, nullptr};
	ID3D11UnorderedAccessView* nullUav[] = {nullptr};
	g_context->CSSetShaderResources(0, 3, nullSrvs);
	g_context->CSSetUnorderedAccessViews(0, 1, nullUav, nullptr);
	g_context->CSSetShader(nullptr, nullptr, 0);
	return true;
}

// Reads a shared canvas back as two RGBA8 eye images, for the CPU PyroWave encoder. Runs on
// the producer worker: the copy and Map wait here, not on the render thread.
bool ReadCanvas(const GpuCanvasRef& ref, int canvasW, int canvasH, std::vector<uint8_t> (&eyes)[2], std::string* error) {
	if (!ref.handle || canvasW <= 0 || canvasH <= 0) return false;
	std::lock_guard<std::mutex> lock(g_mutex);
	if (!g_registered) {
		if (error) *error = "not_registered";
		return false;
	}
	if (!EnsureDevice(error)) return false;
	OpenedCanvas* opened = OpenCanvas(ref, error);
	if (!opened) return false;
	const uint32_t width = static_cast<uint32_t>(canvasW);
	const uint32_t height = static_cast<uint32_t>(canvasH);
	if (opened->width < width || opened->height < height * 2u) {
		if (error) *error = "gpu_canvas_size";
		return false;
	}
	if (!g_readStaging || g_readStagingW != width || g_readStagingH != height * 2u || g_readStagingFormat != opened->format) {
		if (g_readStaging) { g_readStaging->Release(); g_readStaging = nullptr; }
		D3D11_TEXTURE2D_DESC desc = {};
		desc.Width = width;
		desc.Height = height * 2u;
		desc.MipLevels = 1;
		desc.ArraySize = 1;
		desc.Format = opened->format;
		desc.SampleDesc.Count = 1;
		desc.Usage = D3D11_USAGE_STAGING;
		desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
		if (FAILED(g_device->CreateTexture2D(&desc, nullptr, &g_readStaging))) {
			g_readStaging = nullptr;
			if (error) *error = "gpu_canvas_staging";
			return false;
		}
		g_readStagingW = width;
		g_readStagingH = height * 2u;
		g_readStagingFormat = opened->format;
	}
	if (opened->mutex->AcquireSync(0, kCanvasWaitMs) != S_OK) {
		if (error) *error = "gpu_canvas_timeout";
		return false;
	}
	D3D11_BOX box = {0, 0, 0, width, height * 2u, 1};
	g_context->CopySubresourceRegion(g_readStaging, 0, 0, 0, 0, opened->texture, 0, &box);
	opened->mutex->ReleaseSync(0);
	D3D11_MAPPED_SUBRESOURCE mapped = {};
	if (FAILED(g_context->Map(g_readStaging, 0, D3D11_MAP_READ, 0, &mapped))) {
		if (error) *error = "gpu_canvas_map";
		return false;
	}
	const size_t rowBytes = static_cast<size_t>(width) * 4u;
	for (int eye = 0; eye < 2; ++eye) {
		eyes[eye].resize(rowBytes * height);
		for (uint32_t y = 0; y < height; ++y) {
			const uint8_t* src = static_cast<const uint8_t*>(mapped.pData) +
			                     static_cast<size_t>(eye * height + y) * mapped.RowPitch;
			uint8_t* dst = eyes[eye].data() + static_cast<size_t>(y) * rowBytes;
			std::memcpy(dst, src, rowBytes);
			if (ref.bgra) {
				for (size_t x = 0; x < rowBytes; x += 4) std::swap(dst[x], dst[x + 2]);
			}
		}
	}
	g_context->Unmap(g_readStaging, 0);
	return true;
}

}  // namespace

bool AstcGpuSharedCanvasBroken() {
	return g_shareBroken.load(std::memory_order_relaxed);
}

void SetAstcGpuAdapterLuid(uint64_t luid) {
	std::lock_guard<std::mutex> lock(g_mutex);
	if (g_adapterLuid == luid) return;
	g_adapterLuid = luid;
	// The device is created lazily on the first batch, so a LUID that arrives later simply
	// makes the next EnsureDevice rebuild on the render adapter.
}

bool InitAstcGpuEncoder(std::string* error) {
	std::lock_guard<std::mutex> lock(g_mutex);
	(void)error;
	if (g_registered) return true;
	// Registration only publishes the seam; the device is created on first use, when the
	// adapter LUID of the render device is known. A later failure is reported per frame.
	SetAstcBatchEncoder(&EncodeBatch);
	SetGpuCanvasReader(&ReadCanvas);
	g_registered = true;
	DriverLog("Hybrid: D3D11 ASTC compute encoder registered (private device, compressed readback only)");
	return true;
}

void ShutdownAstcGpuEncoder() {
	std::lock_guard<std::mutex> lock(g_mutex);
	if (g_registered) {
		SetAstcBatchEncoder(nullptr);
		SetGpuCanvasReader(nullptr);
		g_registered = false;
	}
	ReleaseAll();
	g_shareBroken.store(false, std::memory_order_relaxed);
}

}  // namespace gxh1
