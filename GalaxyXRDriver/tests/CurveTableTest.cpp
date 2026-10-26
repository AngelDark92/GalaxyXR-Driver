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

	// 2026-10-23: seven-point Custom family. P1 is a fixed-x editable floor;
	// P2..P5 are free; P6 starts the fixed Max Bitrate plateau with a movable
	// x; P7 closes it at (1,1). The same points are pinned by the GUI domain
	// test.
	const std::vector<GxrCurvePoint> custom = {
		{0.0, 0.1}, {0.1, 0.15}, {0.4, 0.3}, {0.7, 0.9},
		{0.85, 0.95}, {0.95, 1.0}, {1.0, 1.0}
	};
	Check(GxrCurvePointsValid(custom), "custom points pass validation");
	auto ExpectCustom = [&](int pct, double x, double expected, const char* message){
		Check(Near(GxrCurveTarget(x, GxrCurveCustom, pct, custom), expected), message);
	};
	ExpectCustom(0, 0.0, 0.1, "custom zero request returns the editable P1 floor");
	ExpectCustom(0, 0.05, 0.125, "custom first segment");
	ExpectCustom(0, 0.1, 0.15, "custom first control point");
	ExpectCustom(0, 0.4, 0.3, "custom middle control point");
	ExpectCustom(0, 0.55, 0.6, "custom interpolates the steep segment");
	ExpectCustom(0, 0.85, 0.95, "custom P5 control point");
	ExpectCustom(0, 0.9, 0.975, "custom ramp into the plateau");
	ExpectCustom(0, 0.95, 1.0, "custom P6 starts the Max Bitrate plateau");
	ExpectCustom(0, 0.975, 1.0, "custom plateau stays at Max Bitrate");
	ExpectCustom(0, 1.0, 1.0, "custom full request reaches the ceiling");
	ExpectCustom(50, 0.4, 0.547722557505, "custom pct50 lift");
	ExpectCustom(100, 0.01, 1.0, "custom pct100 holds the ceiling");

	// Moving P6 left widens the plateau: the curve stays at Max Bitrate after
	// the plateau starts, even when the request has backed off.
	auto widerPlateau = custom;
	widerPlateau[4] = {0.75, 0.95};
	widerPlateau[5] = {0.85, 1.0};
	Check(GxrCurvePointsValid(widerPlateau), "movable P6 plateau passes validation");
	Check(Near(GxrCurveTarget(0.90, GxrCurveCustom, 0, widerPlateau), 1.0),
		"movable P6 holds Max Bitrate through the backed-off range");
	Check(Near(GxrCurveTarget(1.0, GxrCurveCustom, 0, widerPlateau), 1.0),
		"P7 keeps the plateau at Max Bitrate");
	auto overlapping = custom;
	overlapping[5].x = 1.0;
	Check(GxrCurvePointsValid(overlapping),
		"P6 and hidden P7 may overlap at the fixed endpoint");

	// Invalid point sets must be refused rather than silently reordered.
	auto invalid = custom; invalid[3].y = 0.1;
	Check(!GxrCurvePointsValid(invalid), "decreasing y is invalid");
	invalid = custom; invalid[2].x = 0.1;
	Check(!GxrCurvePointsValid(invalid), "equal or crossed x is invalid");
	invalid = custom; invalid.pop_back();
	Check(!GxrCurvePointsValid(invalid), "six points are invalid");
	invalid = custom; invalid[1].y = 1.5;
	Check(!GxrCurvePointsValid(invalid), "out-of-range y is invalid");
	invalid = custom; invalid[0].x = 0.1;
	Check(!GxrCurvePointsValid(invalid), "P1 x must be zero");
	invalid = custom; invalid[6].x = 0.9;
	Check(!GxrCurvePointsValid(invalid), "P7 x must be one");
	invalid = custom; invalid[5].y = 0.9;
	Check(!GxrCurvePointsValid(invalid), "P6 y must be one");
	invalid = custom; invalid[6].y = 0.9;
	Check(!GxrCurvePointsValid(invalid), "P7 y must be one");
	invalid = custom; invalid[5].x = 0.85;
	Check(!GxrCurvePointsValid(invalid), "P6 x must stay ordered after P5");
	invalid = custom; invalid[2].x = std::nan("");
	Check(!GxrCurvePointsValid(invalid), "NaN is invalid");

	// Structural contract for every analytic family and every percentage the
	// settings can carry: zero request -> zero bits, full request -> the
	// ceiling, never above the ceiling, and monotone.
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

	// The same structural contract for the custom points, with an editable
	// floor at P1 and the fixed Max Bitrate plateau ending at P7.
	for(int pct = 0; pct <= 100; pct += 5){
		const double expectedFloor = pct >= 100 ? 1.0 : std::pow(0.1, 1.0 - pct / 100.0);
		Check(Near(GxrCurveTarget(0.0, GxrCurveCustom, pct, custom), expectedFloor),
			"custom zero request returns the lifted P1 floor");
		Check(Near(GxrCurveTarget(1.0, GxrCurveCustom, pct, custom), 1.0), "custom full request returns P7");
		double previous = 0.0;
		bool monotone = true;
		bool bounded = true;
		for(int i = 0; i <= 100; ++i){
			const double v = GxrCurveTarget(i / 100.0, GxrCurveCustom, pct, custom);
			if(v < previous - 1e-12){ monotone = false; }
			if(v > 1.0 + 1e-12){ bounded = false; }
			previous = v;
		}
		Check(monotone, "custom curve is monotone over the request range");
		Check(bounded, "custom curve never exceeds the ceiling");
		if(pct == 100){ Check(Near(GxrCurveTarget(0.01, GxrCurveCustom, pct, custom), 1.0), "custom pct100 is constant above zero"); }
	}

	std::cout << "curve table: " << (checks - failures) << '/' << checks << " checks passed\n";
	return failures == 0 ? 0 : 1;
}
