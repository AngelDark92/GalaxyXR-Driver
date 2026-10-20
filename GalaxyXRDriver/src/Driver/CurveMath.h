#pragma once
#include <algorithm>
#include <cmath>

// ============================================================================
// 2026-10-19 bitrate curve families (owner request).
//
// vrlink's own per-frame request is clamped at ~350 Mbit/s; the tap maps that
// request onto the configured ceiling B. The mapping used to be the single
// integer ratio B * request / clamp (NvencTap.cpp). It is now one of three
// families, lifted toward the ceiling by a constancy percentage:
//
//   b = family(x),     x = request / clamp in [0,1]
//   y = b^(1 - pct/100)
//   target = B * y
//
//   pct   0  = the family curve itself
//   pct 100  = the ceiling, constant (the retired nvencBitrateScale=false)
//
// All families are monotone, b(0) = 0 and b(1) = 1, so a streamer request of
// zero still yields zero and no family can exceed the ceiling.
//
// The default (linear, pct 0) is deliberately NOT routed through this header:
// NvencTap keeps the original integer expression for that case so the
// untouched configuration stays byte-identical (pow() is not bit-exact).
// ============================================================================

enum GxrBitrateCurve {
	GxrCurveLinear = 0,
	GxrCurvePowerKnee = 1,
	GxrCurveSoftKnee = 2
};

// knee/shoulder position as a fraction of the clamp: below it the power knee
// hands control back to a proportional tail, the soft knee holds the ceiling.
static const double kGxrCurveKnee = 0.6;
static const double kGxrCurvePower = 0.75;

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

inline double GxrCurveTarget(double x, int curve, int constancyPct){
	const double b = GxrCurveBase(x, curve);
	if(b <= 0.0){ return 0.0; }
	if(constancyPct <= 0){ return b; }
	if(constancyPct >= 100){ return 1.0; }
	return std::pow(b, 1.0 - constancyPct / 100.0);
}
