#include "AstcBatchEncoder.h"

#include <atomic>

namespace gxh1 {
namespace {
// Published from the render/config threads, read by the producer worker.
std::atomic<AstcBatchEncoderFn> g_batchEncoder{nullptr};
std::atomic<GpuCanvasReaderFn> g_canvasReader{nullptr};
}

void SetAstcBatchEncoder(AstcBatchEncoderFn encoder) {
	g_batchEncoder.store(encoder, std::memory_order_release);
}

AstcBatchEncoderFn GetAstcBatchEncoder() {
	return g_batchEncoder.load(std::memory_order_acquire);
}

void SetGpuCanvasReader(GpuCanvasReaderFn reader) {
	g_canvasReader.store(reader, std::memory_order_release);
}

GpuCanvasReaderFn GetGpuCanvasReader() {
	return g_canvasReader.load(std::memory_order_acquire);
}

}  // namespace gxh1
