#include "FoveaPlanner.h"

#include <algorithm>
#include <cmath>

namespace gxh1 {
namespace {

constexpr double kPi = 3.14159265358979323846;
// Boundary samples per cone. The bounding box is widened by a quarter of the longest chord
// between neighbouring samples, which bounds how far the true curve can bulge past them.
constexpr int kConeSamples = 256;

struct Vec3 {
	double x = 0.0;
	double y = 0.0;
	double z = 0.0;
};

Vec3 Normalize(Vec3 v) {
	const double n = std::sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
	return n > 0.0 ? Vec3{v.x / n, v.y / n, v.z / n} : Vec3{0.0, 0.0, 1.0};
}

Vec3 Cross(const Vec3& a, const Vec3& b) {
	return Vec3{a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x};
}

bool ValidEye(const EyeGazeInput& eye, uint16_t eyeW, uint16_t eyeH) {
	if (!eye.valid) return false;
	if (!std::isfinite(eye.gazeX) || !std::isfinite(eye.gazeY)) return false;
	if (eye.gazeX < 0.0f || eye.gazeY < 0.0f) return false;
	if (eye.gazeX > static_cast<float>(eyeW) || eye.gazeY > static_cast<float>(eyeH)) return false;
	if (!std::isfinite(eye.tanLeft) || !std::isfinite(eye.tanRight) || !std::isfinite(eye.tanTop) ||
	    !std::isfinite(eye.tanBottom)) {
		return false;
	}
	// Each tangent span must be a real projection; a span below ~0.06 degrees is degenerate.
	if (!(eye.tanRight - eye.tanLeft > 1e-3f) || !(eye.tanBottom - eye.tanTop > 1e-3f)) return false;
	return true;
}

// Ray (not normalized) through the continuous eye-tile point (px, py).
Vec3 PixelRay(const EyeGazeInput& eye, uint16_t eyeW, uint16_t eyeH, double px, double py) {
	const double tx = eye.tanLeft + px / eyeW * (static_cast<double>(eye.tanRight) - eye.tanLeft);
	const double ty = eye.tanTop + py / eyeH * (static_cast<double>(eye.tanBottom) - eye.tanTop);
	return Vec3{tx, ty, 1.0};
}

// Pixel bounding box of the gaze cone of `degrees`, clipped to the tile. A cone that reaches
// the image plane's horizon has no finite projection on that side, so it takes the tile.
PlanRect ConeBounds(const EyeGazeInput& eye, uint16_t eyeW, uint16_t eyeH, double degrees) {
	const PlanRect tile{0, 0, eyeW, eyeH};
	const double theta = degrees * (kPi / 180.0);
	if (!(theta < kPi / 2.0)) return tile;

	const Vec3 g = Normalize(PixelRay(eye, eyeW, eyeH, eye.gazeX, eye.gazeY));
	const Vec3 helper = std::fabs(g.x) < 0.9 ? Vec3{1.0, 0.0, 0.0} : Vec3{0.0, 1.0, 0.0};
	const Vec3 u = Normalize(Cross(g, helper));
	const Vec3 v = Cross(g, u);
	const double ct = std::cos(theta);
	const double st = std::sin(theta);
	const double pixelsPerTanX = eyeW / (static_cast<double>(eye.tanRight) - eye.tanLeft);
	const double pixelsPerTanY = eyeH / (static_cast<double>(eye.tanBottom) - eye.tanTop);

	// The planner runs on the render thread: the boundary directions are a fixed table.
	struct Circle {
		double c[kConeSamples + 1];
		double s[kConeSamples + 1];
		Circle() {
			for (int k = 0; k <= kConeSamples; ++k) {
				const double phi = (2.0 * kPi * k) / kConeSamples;
				c[k] = std::cos(phi);
				s[k] = std::sin(phi);
			}
		}
	};
	static const Circle circle;

	double minX = 1e300, minY = 1e300, maxX = -1e300, maxY = -1e300;
	double prevX = 0.0, prevY = 0.0, maxChord = 0.0;
	for (int k = 0; k <= kConeSamples; ++k) {
		const double cp = circle.c[k];
		const double sp = circle.s[k];
		const Vec3 d{ct * g.x + st * (cp * u.x + sp * v.x), ct * g.y + st * (cp * u.y + sp * v.y),
		             ct * g.z + st * (cp * u.z + sp * v.z)};
		if (!(d.z > 1e-6)) return tile;
		const double px = (d.x / d.z - eye.tanLeft) * pixelsPerTanX;
		const double py = (d.y / d.z - eye.tanTop) * pixelsPerTanY;
		if (!std::isfinite(px) || !std::isfinite(py)) return tile;
		if (k > 0) maxChord = std::max(maxChord, std::hypot(px - prevX, py - prevY));
		prevX = px;
		prevY = py;
		minX = std::min(minX, px);
		maxX = std::max(maxX, px);
		minY = std::min(minY, py);
		maxY = std::max(maxY, py);
	}
	const double margin = 1.0 + 0.25 * maxChord;
	const double limit = 1e7;
	PlanRect rect;
	rect.x0 = static_cast<int32_t>(std::floor(std::max(-limit, minX - margin)));
	rect.y0 = static_cast<int32_t>(std::floor(std::max(-limit, minY - margin)));
	rect.x1 = static_cast<int32_t>(std::ceil(std::min(limit, maxX + margin)));
	rect.y1 = static_cast<int32_t>(std::ceil(std::min(limit, maxY + margin)));
	rect.x0 = std::max(rect.x0, tile.x0);
	rect.y0 = std::max(rect.y0, tile.y0);
	rect.x1 = std::min(rect.x1, tile.x1);
	rect.y1 = std::min(rect.y1, tile.y1);
	return rect;
}

PlanRect Union(const PlanRect& a, const PlanRect& b) {
	return PlanRect{std::min(a.x0, b.x0), std::min(a.y0, b.y0), std::max(a.x1, b.x1), std::max(a.y1, b.y1)};
}

uint16_t ExtentFromGaze(const PlanRect& rect, double gx, double gy) {
	const double extent = std::max(std::max(gx - rect.x0, rect.x1 - gx), std::max(gy - rect.y0, rect.y1 - gy));
	return static_cast<uint16_t>(std::min(65535.0, std::max(0.0, std::ceil(extent))));
}

void Emit(const PlanRect& rect, uint8_t eye, uint8_t annulus, const RingSpec& spec, uint16_t innerPx,
          uint16_t outerPx, float innerDeg, float outerDeg, FoveaPlan& plan) {
	if (rect.x1 <= rect.x0 || rect.y1 <= rect.y0) return;
	PlannedPatch patch;
	patch.x = static_cast<uint16_t>(rect.x0);
	patch.y = static_cast<uint16_t>(rect.y0);
	patch.width = static_cast<uint16_t>(rect.x1 - rect.x0);
	patch.height = static_cast<uint16_t>(rect.y1 - rect.y0);
	patch.eye = eye;
	patch.annulus = annulus;
	patch.blockW = spec.blockW;
	patch.blockH = spec.blockH;
	patch.density = spec.density;
	patch.texelW = DensityTexels(patch.width, spec.density);
	patch.texelH = DensityTexels(patch.height, spec.density);
	patch.innerRadiusPx = innerPx;
	patch.outerRadiusPx = outerPx;
	patch.innerDegrees = innerDeg;
	patch.outerDegrees = outerDeg;
	plan.patches.push_back(patch);
}

}  // namespace

uint16_t DensityTexels(uint16_t pixels, float density) {
	if (!(density < 1.0f)) return pixels;
	const double texels = std::ceil(static_cast<double>(pixels) * std::max(0.0f, density) - 1e-6);
	return static_cast<uint16_t>(std::max(1.0, std::min(static_cast<double>(pixels), texels)));
}

double GazeAngleDegrees(const EyeGazeInput& eye, uint16_t eyeW, uint16_t eyeH, double px, double py) {
	const Vec3 g = Normalize(PixelRay(eye, eyeW, eyeH, eye.gazeX, eye.gazeY));
	const Vec3 r = Normalize(PixelRay(eye, eyeW, eyeH, px, py));
	const double dot = std::max(-1.0, std::min(1.0, g.x * r.x + g.y * r.y + g.z * r.z));
	return std::acos(dot) * (180.0 / kPi);
}

bool BuildFoveaPlan(const FoveaPlanRequest& request, FoveaPlan& plan, std::string* error) {
	plan = FoveaPlan{};
	auto fail = [&](const char* why) {
		if (error) *error = why;
		return false;
	};
	if (request.eyeW == 0 || request.eyeH == 0) return fail("empty_eye_extent");
	if (!(request.guardDegrees >= 0.0f) || request.guardDegrees > 30.0f) return fail("bad_guard");
	for (int i = 0; i < 2; ++i) {
		if (!ValidEye(request.eyes[i], request.eyeW, request.eyeH)) return fail("invalid_gaze");
	}
	for (int i = 0; i < kRingCount; ++i) {
		const RingSpec& spec = request.rings[i];
		if (!(spec.outerDegrees > 0.0f) || spec.outerDegrees > 89.0f) return fail("bad_ring_radius");
		if (i > 0 && !(spec.outerDegrees > request.rings[i - 1].outerDegrees)) return fail("ring_radii_not_increasing");
		if (spec.blockW < 4 || spec.blockW > 12 || spec.blockH < 4 || spec.blockH > 12) return fail("bad_footprint");
		if (!(spec.density >= 0.1f) || spec.density > 1.0f) return fail("bad_density");
	}
	const float outerDegrees = request.rings[kRingCount - 1].outerDegrees + request.guardDegrees;
	if (!std::isfinite(outerDegrees)) return fail("bad_guard");

	// Eye-tile ring boxes, nested by construction (a wider cone contains a narrower one; the
	// union only absorbs the outward rounding of neighbouring bounds), then clipped to the
	// fovea-tile window: the hybrid layer upgrades Steam Link's fovea tile, and the
	// background layer already carries everything outside it.
	PlanRect tileRings[2][kRingCount];
	PlanRect window[2];
	for (int eye = 0; eye < 2; ++eye) {
		window[eye] = PlanRect{0, 0, request.eyeW, request.eyeH};
		if (request.cropW > 0 && request.cropW < request.eyeW) {
			const int32_t x0 = static_cast<int32_t>(std::lround(request.eyes[eye].gazeX - request.cropW * 0.5));
			window[eye].x0 = std::max(0, std::min<int32_t>(x0, request.eyeW - request.cropW));
			window[eye].x1 = window[eye].x0 + request.cropW;
		}
		if (request.cropH > 0 && request.cropH < request.eyeH) {
			const int32_t y0 = static_cast<int32_t>(std::lround(request.eyes[eye].gazeY - request.cropH * 0.5));
			window[eye].y0 = std::max(0, std::min<int32_t>(y0, request.eyeH - request.cropH));
			window[eye].y1 = window[eye].y0 + request.cropH;
		}
	}
	uint16_t canvasW = 0;
	uint16_t canvasH = 0;
	for (int eye = 0; eye < 2; ++eye) {
		for (int ring = 0; ring < kRingCount; ++ring) {
			const double degrees = static_cast<double>(request.rings[ring].outerDegrees) + request.guardDegrees;
			PlanRect rect = ConeBounds(request.eyes[eye], request.eyeW, request.eyeH, degrees);
			if (ring > 0) rect = Union(rect, tileRings[eye][ring - 1]);
			rect.x0 = std::max(rect.x0, window[eye].x0);
			rect.y0 = std::max(rect.y0, window[eye].y0);
			rect.x1 = std::min(rect.x1, window[eye].x1);
			rect.y1 = std::min(rect.y1, window[eye].y1);
			if (rect.x1 <= rect.x0 || rect.y1 <= rect.y0) return fail("empty_canvas");
			tileRings[eye][ring] = rect;
		}
		// With a fovea-tile window the outer annulus fills the whole window: the hybrid layer
		// replaces the video's fovea tile, so no part of that tile may be left uncovered.
		if (request.cropW > 0 && request.cropH > 0) tileRings[eye][kRingCount - 1] = window[eye];
		const PlanRect& outer = tileRings[eye][kRingCount - 1];
		canvasW = std::max<uint16_t>(canvasW, static_cast<uint16_t>(outer.x1 - outer.x0));
		canvasH = std::max<uint16_t>(canvasH, static_cast<uint16_t>(outer.y1 - outer.y0));
	}
	// One canvas size serves both eyes, so the smaller eye's canvas reaches past its outer
	// cone; that margin belongs to the outer annulus. The canvas always fits the tile because
	// each eye's outer box does.
	if (canvasW < 8 || canvasH < 8) return fail("empty_canvas");

	plan.eyeW = request.eyeW;
	plan.eyeH = request.eyeH;
	plan.canvasW = canvasW;
	plan.canvasH = canvasH;
	plan.featherPx = std::min<uint16_t>(request.featherPx,
	                                    static_cast<uint16_t>(std::min(canvasW, canvasH) / 2));
	plan.outerDegrees = outerDegrees;

	for (int eye = 0; eye < 2; ++eye) {
		const EyeGazeInput& input = request.eyes[eye];
		plan.eyes[eye] = input;
		const PlanRect& outer = tileRings[eye][kRingCount - 1];
		// Inside this eye's fovea-tile window (the tile when uncropped) and containing its
		// outer box; both fit because every box is at most one window wide.
		const int32_t originX = std::min<int32_t>(outer.x0, window[eye].x1 - canvasW);
		const int32_t originY = std::min<int32_t>(outer.y0, window[eye].y1 - canvasH);
		plan.eyeOriginX[eye] = static_cast<uint16_t>(originX);
		plan.eyeOriginY[eye] = static_cast<uint16_t>(originY);
		const double gazeX = input.gazeX - originX;
		const double gazeY = input.gazeY - originY;

		for (int ring = 0; ring < kRingCount; ++ring) {
			PlanRect local;
			if (ring == kRingCount - 1) {
				local = PlanRect{0, 0, canvasW, canvasH};
			} else {
				const PlanRect& rect = tileRings[eye][ring];
				local = PlanRect{rect.x0 - originX, rect.y0 - originY, rect.x1 - originX, rect.y1 - originY};
			}
			plan.rings[eye][ring] = local;
		}

		for (int ring = 0; ring < kRingCount; ++ring) {
			const PlanRect& outerRect = plan.rings[eye][ring];
			const RingSpec& spec = request.rings[ring];
			const float innerDeg = ring == 0 ? 0.0f : request.rings[ring - 1].outerDegrees;
			const float outerDeg = spec.outerDegrees;
			const uint16_t outerPx = ExtentFromGaze(outerRect, gazeX, gazeY);
			const uint8_t eyeIndex = static_cast<uint8_t>(eye);
			const uint8_t annulus = static_cast<uint8_t>(ring);
			if (ring == 0) {
				Emit(outerRect, eyeIndex, annulus, spec, 0, outerPx, innerDeg, outerDeg, plan);
				continue;
			}
			const PlanRect& in = plan.rings[eye][ring - 1];
			const uint16_t innerPx = ExtentFromGaze(in, gazeX, gazeY);
			const PlanRect& out = outerRect;
			const PlanRect top{out.x0, out.y0, out.x1, in.y0};
			const PlanRect bottom{out.x0, in.y1, out.x1, out.y1};
			const PlanRect left{out.x0, in.y0, in.x0, in.y1};
			const PlanRect right{in.x1, in.y0, out.x1, in.y1};
			for (const PlanRect& rect : {top, bottom, left, right}) {
				Emit(rect, eyeIndex, annulus, spec, innerPx, outerPx, innerDeg, outerDeg, plan);
			}
		}
	}

	if (plan.patches.empty()) return fail("empty_plan");
	if (plan.patches.size() > 64) return fail("too_many_patches");
	return true;
}

uint8_t AnnulusForRegion(const FoveaPlan& plan, int eye, int32_t x0, int32_t y0, int32_t x1, int32_t y1) {
	if (eye < 0 || eye > 1) return kRingCount - 1;
	for (int ring = 0; ring < kRingCount; ++ring) {
		const PlanRect& r = plan.rings[eye][ring];
		if (x0 < r.x1 && r.x0 < x1 && y0 < r.y1 && r.y0 < y1) return static_cast<uint8_t>(ring);
	}
	return kRingCount - 1;
}

uint64_t EstimateAstcBytes(const FoveaPlan& plan) {
	uint64_t total = 0;
	for (const PlannedPatch& patch : plan.patches) {
		const uint64_t texelW = patch.texelW ? patch.texelW : patch.width;
		const uint64_t texelH = patch.texelH ? patch.texelH : patch.height;
		const uint64_t blocksW = (texelW + patch.blockW - 1u) / patch.blockW;
		const uint64_t blocksH = (texelH + patch.blockH - 1u) / patch.blockH;
		total += blocksW * blocksH * 16u;
	}
	return total;
}

}  // namespace gxh1
