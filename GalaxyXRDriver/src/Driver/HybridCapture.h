// D3D11 capture of the same-frame pre-4:2:0 eye content for the hybrid fovea producer.
//
// The eye layer texture already lives on the FrameProcessor device, so the canvas region is
// copied into a small staging texture and mapped once per eye. Nothing is allocated unless
// Producer::WantsCapture() is true, which requires a configured, admitted hybrid session.
#pragma once

#include <cstdint>

struct ID3D11Device;
struct ID3D11DeviceContext;
struct ID3D11Texture2D;

struct HybridCaptureRequest {
	// The textures vrlink will actually encode this frame: the zero-copy shadow when the
	// eye pass drew into one, otherwise the submitted layer (processed in place or not).
	ID3D11Texture2D* source[2] = {nullptr, nullptr};
	int slice[2] = {0, 0};
	// Per-eye tile rectangle in normalized texture coordinates.
	float tileU0[2] = {0.0f, 0.0f};
	float tileV0[2] = {0.0f, 0.0f};
	float tileU1[2] = {1.0f, 1.0f};
	float tileV1[2] = {1.0f, 1.0f};
	// Gaze position normalized inside each eye tile (0..1, continuous) and the signed
	// projection bounds (left, right, top, bottom; y-down) of each eye.
	float gazeU[2] = {0.5f, 0.5f};
	float gazeV[2] = {0.5f, 0.5f};
	float tan[2][4] = {};
	bool gazeValid[2] = {false, false};
	uint64_t frameId = 0;  // scene frame id, shared with the NVENC submission of this frame
	uint64_t ptsNs = 0;
};

// Copies both eye canvases and hands them to the producer. No-op when capture is inactive.
void HybridCaptureFrame(ID3D11Device* device, ID3D11DeviceContext* context, const HybridCaptureRequest& request);
void HybridCaptureRelease();
