// GPU backend seam for the producer.
//
// The pure hybrid core cannot link D3D11, so the driver registers its GPU backend here: a
// batched ASTC encoder and a reader for GPU-resident capture canvases. With a backend
// registered the producer encodes a frame's patches in one GPU submission; without one the
// ASTC frame fails visibly (the CPU reference encoder runs only when a test opts in).
//
// A GPU canvas is a texture on the render device that holds both eye canvases stacked
// vertically (eye 0 on top), shared with the encoder device and guarded by a keyed mutex
// (key 0 on both sides). The render thread only queues copies into it; the producer worker
// waits for it, so no Map ever stalls the render thread.
#ifndef GXR_HYBRID_ASTC_BATCH_ENCODER_H
#define GXR_HYBRID_ASTC_BATCH_ENCODER_H

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

#include "FoveaPlanner.h"

namespace gxh1 {

// Opaque reference to a shared capture canvas (canvasW x 2*canvasH). `handle` is a legacy
// DXGI shared handle; `generation` changes whenever the handle is recreated, so a cached
// open of a reused handle value is never mistaken for the new texture.
struct GpuCanvasRef {
	void* handle = nullptr;
	uint64_t generation = 0;
	bool bgra = false;  // texel order of the shared texture
};

struct AstcBatchRequest {
	const uint8_t* canvas[2] = {nullptr, nullptr};  // RGBA8, canvasW x canvasH (CPU upload path)
	GpuCanvasRef gpuCanvas;                           // used instead of `canvas` when handle is set
	int canvasW = 0;
	int canvasH = 0;
	const PlannedPatch* patches = nullptr;
	size_t patchCount = 0;
	std::vector<std::vector<uint8_t>>* output = nullptr;  // one ASTC block stream per patch
};

using AstcBatchEncoderFn = bool (*)(const AstcBatchRequest& request, std::string* error);
// Reads a shared canvas back as two RGBA8 eye images (for CPU codecs), on the worker.
using GpuCanvasReaderFn = bool (*)(const GpuCanvasRef& canvas, int canvasW, int canvasH,
                                   std::vector<uint8_t> (&eyes)[2], std::string* error);

void SetAstcBatchEncoder(AstcBatchEncoderFn encoder);
AstcBatchEncoderFn GetAstcBatchEncoder();
void SetGpuCanvasReader(GpuCanvasReaderFn reader);
GpuCanvasReaderFn GetGpuCanvasReader();

}  // namespace gxh1

#endif  // GXR_HYBRID_ASTC_BATCH_ENCODER_H
