#pragma once
#include <algorithm>
#include <cmath>
#include <cstddef>
#include <vector>

// ============================================================================
// 2026-10-19 bitrate curve families (owner request).
// 2026-10-23 seven-point custom curve: editable floor plus a movable Max
// Bitrate plateau, with no 350 Mbit clamp.
//
// The streamer request is normalized against the configured Max Bitrate, not
// VRLink's old 350 Mbit reference:
//
//   x = request / maxBitrate in [0,1]
//   b = family(x)
//   y = b^(1 - pct/100)
//   target = maxBitrate * y, capped at maxBitrate
//
// Families 0..2 are analytic. Family 3 (Custom) is seven points, piecewise
// linear. P1 is fixed at x=0 with an editable y floor. P2..P5 are free.
// P6 has y fixed at Max Bitrate and its x is the plateau start; moving it left
// holds Max Bitrate through the slightly backed-off request range. P7 is fixed
// at x=1 and y=Max Bitrate. x strictly increases; y never decreases. Values
// are clamped to [0,1], so no point or target can exceed Max Bitrate.
//
// The default (linear, pct 0) is deliberately NOT routed through this header:
// NvencTap keeps the direct request expression for that case so the untouched
// configuration stays byte-identical (pow() is not bit-exact).
// ============================================================================

enum GxrBitrateCurve {
	GxrCurveLinear = 0,
	GxrCurvePowerKnee = 1,
	GxrCurveSoftKnee = 2,
	GxrCurveCustom = 3
};

struct GxrCurvePoint {
	double x = 0.0;
	double y = 0.0;
};

static const std::size_t kGxrCurvePointCount = 7;
static const double kGxrCurvePointGap = 0.001;
static const double kGxrCurveEdgeEpsilon = 1e-9;

static const double kGxrCurveKnee = 0.6;
static const double kGxrCurvePower = 0.75;

// Seven points. P1 is fixed on the y axis (x=0) with an editable floor.
// P6 carries the fixed Max Bitrate plateau height; its x is free. P7 is the
// fixed (1,1) endpoint. P2..P5 are free. Every point stays fan-curve ordered.
inline bool GxrCurvePointsValid(const std::vector<GxrCurvePoint>& points){
	if(points.size() != kGxrCurvePointCount){ return false; }
	for(const auto &point : points){
		if(!std::isfinite(point.x) || !std::isfinite(point.y)){ return false; }
		if(point.x < 0.0 || point.x > 1.0 || point.y < 0.0 || point.y > 1.0){ return false; }
	}
	if(std::fabs(points.front().x) > kGxrCurveEdgeEpsilon){ return false; }
	if(std::fabs(points.back().x - 1.0) > kGxrCurveEdgeEpsilon){ return false; }
	if(std::fabs(points[5].y - 1.0) > kGxrCurveEdgeEpsilon){ return false; }
	if(std::fabs(points[6].y - 1.0) > kGxrCurveEdgeEpsilon){ return false; }
	for(std::size_t i = 1; i < points.size(); ++i){
		// P6 and P7 may overlap at x=1. Every earlier pair keeps the gap.
		if(i == points.size() - 1){
			if(points[i].x < points[i - 1].x){ return false; }
		}else if(points[i].x < points[i - 1].x + kGxrCurvePointGap){
			return false;
		}
		if(points[i].y < points[i - 1].y){ return false; }
	}
	return true;
}

inline double GxrCurveBase(double x, int curve){
	if(x <= 0.0){ return 0.0; }
	if(x >= 1.0){ return 1.0; }
	switch(curve){
	case GxrCurvePowerKnee:
		return x >= kGxrCurveKnee
			? std::pow(x, kGxrCurvePower)
			: x * (std::pow(kGxrCurveKnee, kGxrCurvePower) / kGxrCurveKnee);
	case GxrCurveSoftKnee:
		return (std::min)(1.0, x / kGxrCurveKnee);
	default:
		return x;
	}
}

// Seven-point custom family. P1 is the value at request zero. P6 starts the
// fixed Max Bitrate plateau and P7 holds it to the full request. No implicit
// anchors: a raised P1 is a real floor. Invalid point sets fall back to linear
// defensively; the tap rejects them before they reach this function.
inline double GxrCurvePointsBase(double x, const std::vector<GxrCurvePoint>& points){
	if(!GxrCurvePointsValid(points)){ return (std::max)(0.0, (std::min)(1.0, x)); }
	if(x <= 0.0){ return points.front().y; }
	if(x >= 1.0){ return points.back().y; }
	for(std::size_t i = 1; i < points.size(); ++i){
		const auto &left = points[i - 1];
		const auto &right = points[i];
		if(x <= right.x){
			const double span = right.x - left.x;
			if(span <= 0.0){ return right.y; }
			return left.y + (right.y - left.y) * ((x - left.x) / span);
		}
	}
	return points.back().y;
}

inline double GxrCurveTarget(double x, int curve, int constancyPct, const std::vector<GxrCurvePoint>& points){
	double b = curve == GxrCurveCustom
		? GxrCurvePointsBase(x, points)
		: GxrCurveBase(x, curve);
	b = (std::max)(0.0, (std::min)(1.0, b));
	if(b <= 0.0){ return 0.0; }
	if(constancyPct <= 0){ return b; }
	if(constancyPct >= 100){ return 1.0; }
	return std::pow(b, 1.0 - constancyPct / 100.0);
}

inline double GxrCurveTarget(double x, int curve, int constancyPct){
	static const std::vector<GxrCurvePoint> noPoints;
	return GxrCurveTarget(x, curve, constancyPct, noPoints);
}
