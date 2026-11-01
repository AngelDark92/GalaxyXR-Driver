// Deterministic foveal ring planner.
//
// The planner derives every patch rectangle, footprint and angular bound from frame
// metadata only (gaze position, per-eye frusta, configured ring radii and guard). It never
// reads lossy encoded alpha, and it never extends the native crop: every returned rectangle
// lies inside the eye tile.
//
// Each ring is the projected gaze cone of (ring bound + guard) degrees. The cone is sampled
// on the view sphere and projected through the eye's signed, possibly asymmetric frustum, so
// its bounding box is correct for diagonal and off-centre gaze, where the projected cone is
// a tilted ellipse rather than a circle. Ring rectangles are those bounding boxes, made
// nested and clipped only by the eye tile (no source pixels exist beyond it). Every pixel
// within ring k's angle of the gaze therefore lies in a patch of annulus <= k.
#ifndef GXR_HYBRID_FOVEA_PLANNER_H
#define GXR_HYBRID_FOVEA_PLANNER_H

#include <cstdint>
#include <string>
#include <vector>

namespace gxh1 {

constexpr int kRingCount = 5;

struct RingSpec {
	float outerDegrees = 5.0f;  // angular bound measured from the gaze ray
	uint8_t blockW = 4;
	uint8_t blockH = 4;
	// Sampling density relative to the source (1 = native). Below 1 the ring is low-pass
	// resampled to ceil(size * density) texels per axis before coding.
	float density = 1.0f;
};

struct EyeGazeInput {
	// Gaze position in continuous eye-tile pixels: pixel i spans [i, i + 1).
	float gazeX = 0.0f;
	float gazeY = 0.0f;
	bool valid = false;
	// Signed projection bounds of the eye tile (OpenVR GetProjectionRaw convention, y-down):
	// tanLeft < tanRight and tanTop < tanBottom. Asymmetric frusta are supported.
	float tanLeft = -1.0f;
	float tanRight = 1.0f;
	float tanTop = -1.0f;
	float tanBottom = 1.0f;
};

struct FoveaPlanRequest {
	uint16_t eyeW = 0;
	uint16_t eyeH = 0;
	// Optional window (eye-tile pixels) the fovea layer may cover, centred on each eye's
	// gaze and kept inside the tile: Steam Link's native-crop fovea tile. 0 = whole tile.
	uint16_t cropW = 0;
	uint16_t cropH = 0;
	EyeGazeInput eyes[2] = {};
	float guardDegrees = 2.0f;
	uint16_t featherPx = 8;
	RingSpec rings[kRingCount] = {};
};

struct PlannedPatch {
	uint16_t x = 0;  // canvas-local
	uint16_t y = 0;
	uint16_t width = 0;
	uint16_t height = 0;
	uint8_t eye = 0;
	uint8_t annulus = 0;
	uint8_t blockW = 4;
	uint8_t blockH = 4;
	uint16_t texelW = 0;  // encoded texels (== width/height at native density)
	uint16_t texelH = 0;
	float density = 1.0f;
	uint16_t innerRadiusPx = 0;  // informational: largest gaze-to-edge distance of the inner box
	uint16_t outerRadiusPx = 0;
	float innerDegrees = 0.0f;
	float outerDegrees = 0.0f;
};

// Half-open canvas-local rectangle.
struct PlanRect {
	int32_t x0 = 0;
	int32_t y0 = 0;
	int32_t x1 = 0;
	int32_t y1 = 0;
};

struct FoveaPlan {
	uint16_t eyeW = 0;
	uint16_t eyeH = 0;
	uint16_t canvasW = 0;  // shared by both eyes
	uint16_t canvasH = 0;
	uint16_t featherPx = 0;
	float outerDegrees = 0.0f;
	// Source origin of the canvas inside each eye tile.
	uint16_t eyeOriginX[2] = {};
	uint16_t eyeOriginY[2] = {};
	// The gaze and frustum the plan was built from, carried to the wire mapping.
	EyeGazeInput eyes[2] = {};
	// Nested ring boxes per eye, canvas-local; ring kRingCount-1 is the whole canvas.
	PlanRect rings[2][kRingCount] = {};
	std::vector<PlannedPatch> patches;
};

// Returns false (and a reason) when either gaze sample is invalid, a frustum is
// degenerate, or the plan cannot be represented. A false result must disable narrow
// allocation for that frame.
bool BuildFoveaPlan(const FoveaPlanRequest& request, FoveaPlan& plan, std::string* error);

// Angle in degrees between the gaze ray and the ray through eye-tile point (px, py).
// Exposed so tests can verify protection against the same projection the planner uses.
double GazeAngleDegrees(const EyeGazeInput& eye, uint16_t eyeW, uint16_t eyeH, double px, double py);

// Smallest annulus whose nested ring box intersects the canvas-local region, or the outer
// annulus when none does. Used to weight codecs that are not tiled per ring.
uint8_t AnnulusForRegion(const FoveaPlan& plan, int eye, int32_t x0, int32_t y0, int32_t x1, int32_t y1);

// Encoded texels for `pixels` source pixels at `density` (never 0, never above `pixels`).
uint16_t DensityTexels(uint16_t pixels, float density);

// ASTC payload estimate for the plan: 16 bytes per block of the encoded texel grid,
// independently padded per patch.
uint64_t EstimateAstcBytes(const FoveaPlan& plan);

}  // namespace gxh1

#endif  // GXR_HYBRID_FOVEA_PLANNER_H
