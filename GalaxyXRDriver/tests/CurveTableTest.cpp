// 2026-10-19 bitrate curve families: standalone tests for the pure mapping in
// CurveMath.h. No driver, no SteamVR, no NVENC, no live settings IO.
#include "../src/Driver/CurveMath.h"
#include <cmath>
#include <cstdio>
#include <iostream>

static int checks = 0;
static int failures = 0;
static void Check(bool success, const char* message){
	++checks;
	if(success){ return; }
	++failures;
	std::cerr << "FAIL: " << message << '\n';
}

static bool Near(double got, double expected){
	return std::fabs(got - expected) <= 1e-9;
}

static void Expect(int curve, int pct, double x, double expected, const char* message){
	Check(Near(GxrCurveTarget(x, curve, pct), expected), message);
}

int main(){
	// Reference points. linear/pct0 and pct100 are the two endpoints the
	// driver documents; the power and soft knees are pinned so a change to a
	// constant cannot pass unnoticed.
	Expect(GxrCurveLinear, 0, 0.5, 0.5, "linear pct0 passes the request through");
	Expect(GxrCurveLinear, 0, 0.9, 0.9, "linear pct0 at 0.9");
	Expect(GxrCurveLinear, 25, 0.9, 0.924021086472, "linear pct25");
	Expect(GxrCurveLinear, 50, 0.5, 0.707106781187, "linear pct50 is the square root");
	Expect(GxrCurveLinear, 100, 0.5, 1.0, "linear pct100 holds the ceiling");
	Expect(GxrCurvePowerKnee, 0, 0.9, 0.924021086472, "power knee pct0 above the knee");
	Expect(GxrCurvePowerKnee, 0, 0.3, 0.340865809940, "power knee pct0 linear tail");
	Expect(GxrCurvePowerKnee, 50, 0.6, 0.825670406325, "power knee pct50 at the knee");
	Expect(GxrCurvePowerKnee, 75, 0.2, 0.690435392599, "power knee pct75 deep backoff");
	Expect(GxrCurvePowerKnee, 100, 0.1, 1.0, "power knee pct100 holds the ceiling");
	Expect(GxrCurveSoftKnee, 0, 0.9, 1.0, "soft knee holds the ceiling above the knee");
	Expect(GxrCurveSoftKnee, 0, 0.3, 0.5, "soft knee proportional below the knee");
	Expect(GxrCurveSoftKnee, 50, 0.3, 0.707106781187, "soft knee pct50 below the knee");
	Expect(GxrCurveSoftKnee, 100, 0.1, 1.0, "soft knee pct100 holds the ceiling");

	// Structural contract for every family and every percentage the settings
	// can carry: zero request -> zero bits, full request -> the ceiling, never
	// above the ceiling, and monotone.
	const int families[] = {GxrCurveLinear, GxrCurvePowerKnee, GxrCurveSoftKnee};
	for(int curve : families){
		for(int pct = 0; pct <= 100; pct += 5){
			Check(Near(GxrCurveTarget(0.0, curve, pct), 0.0), "zero request yields zero target");
			Check(Near(GxrCurveTarget(1.0, curve, pct), 1.0), "full request yields the ceiling");
			double previous = 0.0;
			bool monotone = true;
			bool bounded = true;
			for(int i = 0; i <= 100; ++i){
				const double v = GxrCurveTarget(i / 100.0, curve, pct);
				if(v < previous - 1e-12){ monotone = false; }
				if(v > 1.0 + 1e-12){ bounded = false; }
				previous = v;
			}
			Check(monotone, "curve is monotone over the request range");
			Check(bounded, "curve never exceeds the ceiling");
			if(pct == 100){
				Check(Near(GxrCurveTarget(0.01, curve, pct), 1.0), "pct100 is constant above zero");
			}
		}
	}

	// Out-of-range curves fall back to the linear family in the header; the
	// driver refuses them before they reach this code (ValidateRequest).
	Check(Near(GxrCurveTarget(0.5, 99, 0), 0.5), "unknown family evaluates as linear");

	std::cout << "curve table: " << (checks - failures) << '/' << checks << " checks passed\n";
	return failures == 0 ? 0 : 1;
}
