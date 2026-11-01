// D3D11 compute ASTC encoder for the hybrid fovea rings.
//
// Produces the same bounded subset the CPU reference encoder and the client decoder use:
// 16-byte blocks, LDR single partition, one plane, FMT_RGB, QUANT_256 endpoints and
// QUANT_8/QUANT_16 weight grids, with the physical endpoint order R0,R1,G0,G1,B0,B1.
//
// The device is private to the producer worker (one immediate context, used only from that
// thread). Capture canvases are shared from the render device under a keyed mutex; only
// compressed blocks are read back (PyroWave reads its canvas back on the worker).
#pragma once

#include <cstdint>
#include <string>

namespace gxh1 {

// Select the adapter used for encoding. The capture path calls this with the render
// device's LUID so the encoder runs on the same physical adapter as NVENC.
void SetAstcGpuAdapterLuid(uint64_t luid);

// Registers the D3D11 batch encoder with the producer. Returns false (and a reason) when no
// hardware device or compute-capable adapter is available. Must be called once at startup.
bool InitAstcGpuEncoder(std::string* error);
void ShutdownAstcGpuEncoder();
// True once the encoder device failed to open a shared capture canvas (for example a
// different adapter); capture then uses its CPU staging path. Cleared by shutdown.
bool AstcGpuSharedCanvasBroken();

}  // namespace gxh1
