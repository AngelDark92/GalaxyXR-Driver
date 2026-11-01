// Host-side tests for the hybrid core: GXH1 envelope/parser, foveal planner and the
// ASTC LDR subset round trip. Pure CPU, no NVENC, D3D11, SteamVR or installed driver.
#include "../src/Hybrid/AstcSubset.h"
#include "../src/Hybrid/FoveaPlanner.h"
#include "../src/Hybrid/Gxh1Codec.h"
#include "../src/Hybrid/PyroWaveCpu.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

namespace {
int checks = 0;
int failures = 0;

void Check(bool ok, const std::string& message) {
	++checks;
	if (!ok) {
		++failures;
		std::fprintf(stderr, "FAIL: %s\n", message.c_str());
	}
}

double Psnr(const std::vector<uint8_t>& a, const std::vector<uint8_t>& b) {
	double sse = 0.0;
	size_t count = 0;
	for (size_t i = 0; i < a.size() && i < b.size(); ++i) {
		const double d = static_cast<double>(a[i]) - static_cast<double>(b[i]);
		sse += d * d;
		++count;
	}
	if (count == 0) return 0.0;
	if (sse <= 0.0) return 99.0;
	const double mse = sse / count;
	return 10.0 * std::log10((255.0 * 255.0) / mse);
}

// Deterministic synthetic corpus: gradients, hard-edged text-like glyphs, colour chart,
// and pseudo-random noise. The plan's UI/text gate cares about the glyph pattern most.
std::vector<uint8_t> MakeImage(int width, int height, int kind) {
	std::vector<uint8_t> rgb(static_cast<size_t>(width) * height * 3u);
	for (int y = 0; y < height; ++y) {
		for (int x = 0; x < width; ++x) {
			uint8_t* p = rgb.data() + (static_cast<size_t>(y) * width + x) * 3u;
			switch (kind) {
			case 0: {  // gradient
				p[0] = static_cast<uint8_t>(x * 255 / (width - 1));
				p[1] = static_cast<uint8_t>(y * 255 / (height - 1));
				p[2] = static_cast<uint8_t>((x + y) * 255 / (width + height - 2));
				break;
			}
			case 1: {  // text-like hard edges, deliberately not block-aligned
				const bool ink = ((x % 7) < 3) || ((y % 11) < 2);
				p[0] = ink ? 8 : 240;
				p[1] = ink ? 12 : 242;
				p[2] = ink ? 20 : 246;
				break;
			}
			case 2: {  // saturated colour chart
				const int c = ((x / 16) * 3 + (y / 16) * 5) % 7;
				static const uint8_t palette[7][3] = {{255, 0, 0},   {0, 255, 0},   {0, 0, 255},
				                                      {255, 255, 0}, {0, 255, 255}, {255, 0, 255},
				                                      {128, 128, 128}};
				p[0] = palette[c][0];
				p[1] = palette[c][1];
				p[2] = palette[c][2];
				break;
			}
			default: {  // deterministic noise
				uint32_t h = static_cast<uint32_t>(x) * 73856093u ^ static_cast<uint32_t>(y) * 19349663u;
				h ^= h >> 13;
				h *= 0x5bd1e995u;
				h ^= h >> 15;
				p[0] = static_cast<uint8_t>(h);
				p[1] = static_cast<uint8_t>(h >> 8);
				p[2] = static_cast<uint8_t>(h >> 16);
				break;
			}
			}
		}
	}
	return rgb;
}

void TestAstcRoundTrip() {
	const int sizes[] = {64, 100, 256};
	const uint8_t footprints[] = {4, 6, 8, 10, 12};
	for (int size : sizes) {
		for (int kind = 0; kind < 4; ++kind) {
			const std::vector<uint8_t> src = MakeImage(size, size, kind);
			for (uint8_t footprint : footprints) {
				std::vector<uint8_t> blocks;
				Check(gxh1::AstcEncodeRgb(src.data(), static_cast<size_t>(size) * 3u, size, size, footprint,
				                          footprint, blocks),
				      "astc encode " + std::to_string(footprint) + " kind " + std::to_string(kind));
				const size_t blocksX = (size + footprint - 1) / footprint;
				const size_t blocksY = blocksX;
				Check(blocks.size() == blocksX * blocksY * gxh1::kAstcBlockBytes, "astc block count");

				// Every emitted block must be inside the supported subset.
				bool supported = true;
				for (size_t i = 0; i < blocks.size(); i += gxh1::kAstcBlockBytes) {
					gxh1::AstcBlockInfo info;
					supported = supported && gxh1::AstcInspectBlock(blocks.data() + i, footprint, footprint, info) &&
					            info.supported;
				}
				Check(supported, "astc subset conformance");

				std::vector<uint8_t> decoded;
				Check(gxh1::AstcDecodeRgb(blocks.data(), blocks.size(), size, size, footprint, footprint, decoded),
				      "astc decode");
				const double psnr = Psnr(src, decoded);
				std::printf("  astc %2dx%-2d %3dpx kind %d: %6.2f dB  %8zu B (%5.2f bpp)\n", footprint, footprint,
				            size, kind, psnr, blocks.size(),
				            blocks.size() * 8.0 / (static_cast<double>(size) * size));
				Check(psnr > 8.0, "astc psnr floor");
				if (footprint == 4 && kind == 1) {
					// The plan's UI/text gate at 4x4, on a deliberately non-aligned pattern.
					Check(psnr >= 34.0, "astc 4x4 text psnr");
				}
				if (footprint == 8 && kind == 0) {
					Check(psnr >= 30.0, "astc 8x8 gradient psnr");
				}
			}
		}
	}
}

void TestCoverageExactness() {
	std::vector<uint8_t> cells;
	gxh1::PatchEntry full = {};
	full.width = 32;
	full.height = 32;
	gxh1::PatchEntry both[2] = {full, full};
	both[1].eye = 1;
	Check(gxh1::ValidateCoverage(both, 2, 32, 32, 16, cells), "exact full-canvas tiling accepted");

	gxh1::PatchEntry gap[2] = {both[0], both[1]};
	gap[1].x = 1;
	gap[1].width = 31;
	Check(!gxh1::ValidateCoverage(gap, 2, 32, 32, 16, cells), "1px coverage gap rejected");

	gxh1::PatchEntry overlap[3] = {both[0], both[1], both[0]};
	overlap[2].width = 2;
	Check(!gxh1::ValidateCoverage(overlap, 3, 32, 32, 16, cells), "1px overlap rejected");

	gxh1::PatchEntry tiny[1] = {full};
	tiny[0].width = 1;
	tiny[0].height = 1;
	Check(!gxh1::ValidateCoverage(tiny, 1, 1, 1, 16, cells), "missing eye rejected on a 1x1 canvas");
}

gxh1::FoveaPlanRequest PlannerRequest() {
	gxh1::FoveaPlanRequest request;
	request.eyeW = 1024;
	request.eyeH = 1024;
	request.guardDegrees = 2.0f;
	request.featherPx = 8;
	for (int e = 0; e < 2; ++e) {
		request.eyes[e].valid = true;
		request.eyes[e].gazeX = 512.0f;
		request.eyes[e].gazeY = 512.0f;
		request.eyes[e].tanLeft = -1.0f;
		request.eyes[e].tanRight = 1.0f;
		request.eyes[e].tanTop = -1.0f;
		request.eyes[e].tanBottom = 1.0f;
	}
	const float radii[5] = {5.0f, 10.0f, 20.0f, 30.0f, 35.0f};
	const uint8_t footprints[5] = {4, 6, 8, 10, 12};
	for (int i = 0; i < 5; ++i) {
		request.rings[i].outerDegrees = radii[i];
		request.rings[i].blockW = footprints[i];
		request.rings[i].blockH = footprints[i];
	}
	return request;
}

bool PlanTilesExactly(const gxh1::FoveaPlan& plan) {
	std::vector<gxh1::PatchEntry> entries;
	for (const auto& patch : plan.patches) {
		gxh1::PatchEntry entry{};
		entry.x = patch.x;
		entry.y = patch.y;
		entry.width = patch.width;
		entry.height = patch.height;
		entry.eye = patch.eye;
		entries.push_back(entry);
	}
	std::vector<uint8_t> cells;
	return gxh1::ValidateCoverage(entries.data(), entries.size(), plan.canvasW, plan.canvasH, 16, cells);
}

// Every eye-tile pixel within ring k's angle (+guard) of the gaze must land in a patch of
// annulus <= k, measured with an independent per-pixel angle, not the planner's boxes.
// Returns the number of violating samples.
int ConeViolations(const gxh1::FoveaPlanRequest& request, const gxh1::FoveaPlan& plan, int step) {
	int violations = 0;
	for (int eye = 0; eye < 2; ++eye) {
		const gxh1::EyeGazeInput& gaze = request.eyes[eye];
		// Only the fovea-tile window has to be covered when a crop is requested.
		int wx0 = 0, wy0 = 0, wx1 = request.eyeW, wy1 = request.eyeH;
		if (request.cropW > 0 && request.cropW < request.eyeW) {
			wx0 = std::max(0, std::min<int>(static_cast<int>(std::lround(gaze.gazeX - request.cropW * 0.5)),
			                                request.eyeW - request.cropW));
			wx1 = wx0 + request.cropW;
		}
		if (request.cropH > 0 && request.cropH < request.eyeH) {
			wy0 = std::max(0, std::min<int>(static_cast<int>(std::lround(gaze.gazeY - request.cropH * 0.5)),
			                                request.eyeH - request.cropH));
			wy1 = wy0 + request.cropH;
		}
		for (int y = wy0; y < wy1; y += step) {
			for (int x = wx0; x < wx1; x += step) {
				const double angle = gxh1::GazeAngleDegrees(gaze, request.eyeW, request.eyeH, x + 0.5, y + 0.5);
				int required = -1;
				for (int k = 0; k < gxh1::kRingCount; ++k) {
					if (angle <= request.rings[k].outerDegrees + request.guardDegrees) {
						required = k;
						break;
					}
				}
				if (required < 0) continue;
				const int cx = x - plan.eyeOriginX[eye];
				const int cy = y - plan.eyeOriginY[eye];
				int annulus = -1;
				if (cx >= 0 && cy >= 0 && cx < plan.canvasW && cy < plan.canvasH) {
					for (const auto& patch : plan.patches) {
						if (patch.eye == eye && cx >= patch.x && cx < patch.x + patch.width && cy >= patch.y &&
						    cy < patch.y + patch.height) {
							annulus = patch.annulus;
							break;
						}
					}
				}
				if (annulus < 0 || annulus > required) ++violations;
			}
		}
	}
	return violations;
}

void TestPlanner() {
	const gxh1::FoveaPlanRequest request = PlannerRequest();
	gxh1::FoveaPlan plan;
	std::string error;
	const bool built = gxh1::BuildFoveaPlan(request, plan, &error);
	Check(built, "planner builds: " + error);
	Check(plan.canvasW == plan.canvasH, "planner square canvas for centred symmetric gaze");
	Check(plan.patches.size() == 2 * 17, "planner patch count");
	Check(PlanTilesExactly(plan), "planner tiles canvas exactly");
	Check(gxh1::EstimateAstcBytes(plan) > 0, "planner byte estimate");
	Check(ConeViolations(request, plan, 4) == 0, "planner protects every ring cone (centred)");

	// Off-axis coverage: with the gaze at 75% of the tile, the 5 degree core + 2 degree guard
	// must still subtend 7 degrees, which needs ~83.7 px on the right (angle addition), not
	// the 62.9 px a symmetric tan(angle) formula gives.
	gxh1::FoveaPlanRequest offAxis = request;
	for (int e = 0; e < 2; ++e) {
		offAxis.eyes[e].gazeX = 768.0f;
		offAxis.eyes[e].gazeY = 512.0f;
	}
	for (int i = 0; i < gxh1::kRingCount; ++i) offAxis.rings[i].outerDegrees = 5.0f + i;
	gxh1::FoveaPlan offPlan;
	Check(gxh1::BuildFoveaPlan(offAxis, offPlan, &error), "planner builds off-axis: " + error);
	const gxh1::PlanRect& core = offPlan.rings[0][0];
	const double rightExtent = core.x1 - (768.0 - offPlan.eyeOriginX[0]);
	Check(rightExtent >= 83.7, "planner keeps 7 degrees off-axis (" + std::to_string(rightExtent) + " px)");
	Check(ConeViolations(offAxis, offPlan, 2) == 0, "planner protects every ring cone (off-axis)");

	// Review case: diagonal gaze in a +-2 tangent frustum. A ray exactly 7 degrees from the
	// gaze lies ~91 px out along the diagonal; independent H/V angles allocated 72 px.
	gxh1::FoveaPlanRequest diagonal = request;
	for (int e = 0; e < 2; ++e) {
		diagonal.eyes[e].tanLeft = -2.0f;
		diagonal.eyes[e].tanRight = 2.0f;
		diagonal.eyes[e].tanTop = -2.0f;
		diagonal.eyes[e].tanBottom = 2.0f;
		diagonal.eyes[e].gazeX = 768.0f;
		diagonal.eyes[e].gazeY = 768.0f;
	}
	gxh1::FoveaPlan diagonalPlan;
	Check(gxh1::BuildFoveaPlan(diagonal, diagonalPlan, &error), "planner builds diagonal: " + error);
	Check(ConeViolations(diagonal, diagonalPlan, 2) == 0, "planner protects the diagonal cone");

	// Gaze 4 px from the left edge: the rings are clipped by the tile only, so the far side
	// keeps its full support instead of the whole canvas shrinking to 4 px.
	gxh1::FoveaPlanRequest edge = request;
	edge.eyes[0].gazeX = 4.0f;
	gxh1::FoveaPlan edgePlan;
	Check(gxh1::BuildFoveaPlan(edge, edgePlan, &error), "planner builds edge gaze: " + error);
	Check(ConeViolations(edge, edgePlan, 4) == 0, "planner protects edge-gaze cones inside the tile");
	Check(PlanTilesExactly(edgePlan), "edge plan tiles canvas exactly");
	for (int eye = 0; eye < 2; ++eye) {
		Check(edgePlan.eyeOriginX[eye] + edgePlan.canvasW <= edge.eyeW &&
		          edgePlan.eyeOriginY[eye] + edgePlan.canvasH <= edge.eyeH,
		      "edge canvas lies inside the eye tile");
	}

	// Randomized asymmetric frusta, off-centre and corner gaze, unequal eyes.
	uint32_t seed = 0x1234567u;
	auto next = [&seed]() {
		seed = seed * 1664525u + 1013904223u;
		return (seed >> 8) / 16777216.0;
	};
	int randomViolations = 0;
	int randomBuilt = 0;
	bool randomTiled = true;
	bool randomInside = true;
	for (int trial = 0; trial < 40; ++trial) {
		gxh1::FoveaPlanRequest random = request;
		random.eyeW = static_cast<uint16_t>(256 + static_cast<int>(next() * 1024));
		random.eyeH = static_cast<uint16_t>(256 + static_cast<int>(next() * 1024));
		random.guardDegrees = static_cast<float>(next() * 4.0);
		for (int e = 0; e < 2; ++e) {
			random.eyes[e].tanLeft = static_cast<float>(-0.4 - next() * 1.6);
			random.eyes[e].tanRight = static_cast<float>(0.4 + next() * 1.6);
			random.eyes[e].tanTop = static_cast<float>(-0.4 - next() * 1.6);
			random.eyes[e].tanBottom = static_cast<float>(0.4 + next() * 1.6);
			random.eyes[e].gazeX = static_cast<float>(next() * random.eyeW);
			random.eyes[e].gazeY = static_cast<float>(next() * random.eyeH);
		}
		gxh1::FoveaPlan randomPlan;
		if (!gxh1::BuildFoveaPlan(random, randomPlan, &error)) continue;
		++randomBuilt;
		randomViolations += ConeViolations(random, randomPlan, 7);
		randomTiled = randomTiled && PlanTilesExactly(randomPlan) && randomPlan.patches.size() <= 64;
		for (int eye = 0; eye < 2; ++eye) {
			randomInside = randomInside && randomPlan.eyeOriginX[eye] + randomPlan.canvasW <= random.eyeW &&
			               randomPlan.eyeOriginY[eye] + randomPlan.canvasH <= random.eyeH;
		}
	}
	Check(randomBuilt == 40, "planner builds every random asymmetric case (" + std::to_string(randomBuilt) + ")");
	Check(randomViolations == 0, "planner protects random asymmetric cones (" + std::to_string(randomViolations) + ")");
	Check(randomTiled, "random plans tile their canvas exactly");
	Check(randomInside, "random canvases lie inside their eye tiles");

	// Fovea-tile crop: rings are clipped to a window of the stream tile around the gaze, the
	// canvas never leaves it, and everything inside it keeps its ring protection.
	gxh1::FoveaPlanRequest cropped = request;
	cropped.cropW = 400;
	cropped.cropH = 360;
	cropped.eyes[0].gazeX = 120.0f;  // window clamps at the tile edge
	cropped.eyes[1].gazeX = 700.0f;
	cropped.eyes[1].gazeY = 300.0f;
	gxh1::FoveaPlan croppedPlan;
	Check(gxh1::BuildFoveaPlan(cropped, croppedPlan, &error), "planner builds cropped: " + error);
	Check(croppedPlan.canvasW <= 400 && croppedPlan.canvasH <= 360, "cropped canvas fits the fovea tile");
	Check(croppedPlan.eyeOriginX[0] + croppedPlan.canvasW <= 400, "cropped canvas stays in the edge-clamped window");
	Check(croppedPlan.eyeOriginX[1] >= 500 && croppedPlan.eyeOriginX[1] + croppedPlan.canvasW <= 900,
	      "cropped canvas stays in the gaze-centred window");
	Check(ConeViolations(cropped, croppedPlan, 3) == 0, "cropped plan protects every cone inside the window");
	Check(PlanTilesExactly(croppedPlan), "cropped plan tiles its canvas exactly");
	Check(gxh1::EstimateAstcBytes(croppedPlan) < gxh1::EstimateAstcBytes(plan), "cropping saves bytes");

	// Ring density: rings below native are coded on a smaller texel grid and cost less.
	gxh1::FoveaPlanRequest dense = request;
	dense.rings[2].density = 0.75f;
	dense.rings[3].density = 0.5f;
	dense.rings[4].density = 0.25f;
	gxh1::FoveaPlan densePlan;
	Check(gxh1::BuildFoveaPlan(dense, densePlan, &error), "planner builds with ring density: " + error);
	bool texelsOk = true;
	for (const auto& patch : densePlan.patches) {
		const uint16_t expectW = gxh1::DensityTexels(patch.width, dense.rings[patch.annulus].density);
		texelsOk = texelsOk && patch.texelW == expectW && patch.texelW <= patch.width && patch.texelW >= 1 &&
		           (patch.annulus > 1 || (patch.texelW == patch.width && patch.texelH == patch.height));
	}
	Check(texelsOk, "density sets each ring's texel grid; native rings keep their rect");
	Check(gxh1::DensityTexels(100, 0.5f) == 50 && gxh1::DensityTexels(101, 0.5f) == 51 && gxh1::DensityTexels(3, 0.25f) == 1,
	      "density texel counts round up and never reach zero");
	std::printf("  density 1/1/0.75/0.5/0.25: %llu B vs %llu B native\n",
	            static_cast<unsigned long long>(gxh1::EstimateAstcBytes(densePlan)),
	            static_cast<unsigned long long>(gxh1::EstimateAstcBytes(plan)));
	Check(gxh1::EstimateAstcBytes(densePlan) * 2 < gxh1::EstimateAstcBytes(plan), "lower outer density halves the ASTC bytes");
	gxh1::FoveaPlanRequest badDensity = request;
	badDensity.rings[1].density = 0.0f;
	Check(!gxh1::BuildFoveaPlan(badDensity, edgePlan, &error), "planner rejects a zero density");

	// Invalid gaze and a degenerate frustum disable narrow allocation.
	gxh1::FoveaPlanRequest invalid = request;
	invalid.eyes[0].valid = false;
	Check(!gxh1::BuildFoveaPlan(invalid, edgePlan, &error), "planner rejects invalid gaze");
	gxh1::FoveaPlanRequest flipped = request;
	flipped.eyes[1].tanLeft = 1.0f;  // left >= right is not a projection
	Check(!gxh1::BuildFoveaPlan(flipped, edgePlan, &error), "planner rejects an inverted frustum");
	gxh1::FoveaPlanRequest outside = request;
	outside.eyes[0].gazeX = 2000.0f;
	Check(!gxh1::BuildFoveaPlan(outside, edgePlan, &error), "planner rejects gaze outside the tile");
}

void TestEnvelope() {
	const std::vector<uint8_t> base = {1, 2, 3, 4, 5, 6, 7};
	const std::vector<uint8_t> payload = {9, 8, 7, 6};

	const uint32_t foveaBytes = gxh1::kFoveaUnitHeaderBytes + 2 * gxh1::kPatchEntryBytes +
	                            static_cast<uint32_t>(payload.size()) * 2u;
	std::vector<uint8_t> wire(gxh1::kHeaderBytes + base.size() + foveaBytes);
	gxh1::EnvelopeHeader header{};
	header.magic = gxh1::kMagic;
	header.versionMajor = gxh1::kVersionMajor;
	header.versionMinor = gxh1::kVersionMinor;
	header.headerBytes = gxh1::kHeaderBytes;
	header.flags = gxh1::kFlagFoveaPresent;
	header.sessionEpoch = 3;
	header.sourceEpoch = 4;
	header.mappingEpoch = 5;
	header.frameId = 99;
	header.ptsNs = 123456789;
	header.baseBytes = static_cast<uint32_t>(base.size());
	header.foveaBytes = foveaBytes;
	header.baseOffset = gxh1::kHeaderBytes;
	header.foveaOffset = gxh1::kHeaderBytes + static_cast<uint32_t>(base.size());
	header.baseCodec = gxh1::kBaseCodecHevc;
	header.baseFormat = gxh1::kBaseFormatNv12;
	header.foveaCodec = gxh1::kFoveaCodecAstc;
	header.precision = gxh1::kFoveaPrecisionRgb8;
	header.canvasW = 32;
	header.canvasH = 32;
	header.patchCount = 2;
	header.featherPx = 2;

	gxh1::FoveaUnitHeader unit{};
	unit.unitBytes = header.foveaBytes;
	unit.canvasW = 32;
	unit.canvasH = 32;
	unit.foveaCodec = gxh1::kFoveaCodecAstc;
	unit.precision = gxh1::kFoveaPrecisionRgb8;
	unit.patchCount = 2;
	unit.mappingEpoch = 5;
	unit.featherPx = 2;
	for (int eye = 0; eye < 2; ++eye) {
		unit.eyes[eye].sourceW = 64;
		unit.eyes[eye].sourceH = 64;
		unit.eyes[eye].originX = static_cast<uint16_t>(8 * eye);
		unit.eyes[eye].originY = 16;
		unit.eyes[eye].tanLeft = -1.0f;
		unit.eyes[eye].tanRight = 1.0f;
		unit.eyes[eye].tanTop = -1.0f;
		unit.eyes[eye].tanBottom = 1.0f;
		unit.eyes[eye].gazeX = 32.0f;
		unit.eyes[eye].gazeY = 32.0f;
	}

	gxh1::PatchEntry patches[2] = {};
	for (int i = 0; i < 2; ++i) {
		patches[i].payloadBytes = static_cast<uint32_t>(payload.size());
		patches[i].payloadOffset = gxh1::kFoveaUnitHeaderBytes + 2 * gxh1::kPatchEntryBytes +
		                           static_cast<uint32_t>(i) * static_cast<uint32_t>(payload.size());
		patches[i].width = 32;
		patches[i].height = 32;
		patches[i].eye = static_cast<uint8_t>(i);
		patches[i].annulus = 0;
		patches[i].blockW = 4;
		patches[i].blockH = 4;
		patches[i].codec = gxh1::kFoveaCodecAstc;
		patches[i].sourceEpoch = 4;
		patches[i].outerRadiusPx = 16;
		patches[i].outerDegrees = 5.0f;
	}

	std::memcpy(wire.data(), &header, sizeof(header));
	std::memcpy(wire.data() + header.baseOffset, base.data(), base.size());
	std::memcpy(wire.data() + header.foveaOffset, &unit, sizeof(unit));
	std::memcpy(wire.data() + header.foveaOffset + sizeof(unit), patches, sizeof(patches));
	for (int i = 0; i < 2; ++i) {
		std::memcpy(wire.data() + header.foveaOffset + patches[i].payloadOffset, payload.data(), payload.size());
	}

	auto reseal = [](std::vector<uint8_t>& buffer) {
		auto* h = reinterpret_cast<gxh1::EnvelopeHeader*>(buffer.data());
		h->crc32 = 0;
		uint32_t crc = gxh1::Crc32(buffer.data(), sizeof(gxh1::EnvelopeHeader));
		crc = gxh1::Crc32(buffer.data() + h->baseOffset, h->baseBytes, crc);
		crc = gxh1::Crc32(buffer.data() + h->foveaOffset, h->foveaBytes, crc);
		h->crc32 = crc;
	};
	reseal(wire);

	gxh1::ParsedFrame parsed;
	gxh1::ParseLimits limits;
	Check(gxh1::ParseFrame(wire.data(), wire.size(), limits, parsed) == gxh1::ParseError::None,
	      "envelope parses");
	Check(parsed.header.frameId == 99 && parsed.foveaPresent && parsed.patches.size() == 2, "envelope fields");
	Check(parsed.base[0] == 1 && parsed.patches[0].payload[0] == 9 && parsed.patches[1].payload[0] == 9,
	      "envelope payload pointers");

	std::vector<uint8_t> corrupt = wire;
	corrupt[wire.size() - 1] ^= 0xFFu;
	Check(gxh1::ParseFrame(corrupt.data(), corrupt.size(), limits, parsed) == gxh1::ParseError::BadCrc,
	      "envelope rejects bad crc");

	Check(gxh1::ParseFrame(wire.data(), wire.size() - 1, limits, parsed) == gxh1::ParseError::LengthOverflow,
	      "envelope rejects truncation");

	corrupt = wire;
	reinterpret_cast<gxh1::PatchEntry*>(corrupt.data() + header.foveaOffset + sizeof(gxh1::FoveaUnitHeader))->eye = 7;
	reseal(corrupt);
	Check(gxh1::ParseFrame(corrupt.data(), corrupt.size(), limits, parsed) == gxh1::ParseError::BadPatchGeometry,
	      "envelope rejects bad eye");

	// A resampled patch declares both texel axes, never more texels than pixels.
	const std::pair<uint16_t, uint16_t> badTexels[2] = {{uint16_t(33), uint16_t(16)}, {uint16_t(16), uint16_t(0)}};
	for (const auto& texels : badTexels) {
		corrupt = wire;
		auto* entry = reinterpret_cast<gxh1::PatchEntry*>(corrupt.data() + header.foveaOffset + sizeof(gxh1::FoveaUnitHeader));
		entry->texelW = texels.first;
		entry->texelH = texels.second;
		reseal(corrupt);
		Check(gxh1::ParseFrame(corrupt.data(), corrupt.size(), limits, parsed) == gxh1::ParseError::BadPatchGeometry,
		      "envelope rejects an impossible texel grid");
	}

	// A gap must be rejected: shrink the eye-0 patch and fix the CRC.
	corrupt = wire;
	reinterpret_cast<gxh1::PatchEntry*>(corrupt.data() + header.foveaOffset + sizeof(gxh1::FoveaUnitHeader))->width = 16;
	reseal(corrupt);
	Check(gxh1::ParseFrame(corrupt.data(), corrupt.size(), limits, parsed) == gxh1::ParseError::CoverageGap,
	      "envelope rejects coverage gap");

	// Overlapping payload ranges must be rejected.
	corrupt = wire;
	reinterpret_cast<gxh1::PatchEntry*>(corrupt.data() + header.foveaOffset + sizeof(gxh1::FoveaUnitHeader) +
	                                    sizeof(gxh1::PatchEntry))->payloadOffset = patches[0].payloadOffset;
	reseal(corrupt);
	Check(gxh1::ParseFrame(corrupt.data(), corrupt.size(), limits, parsed) == gxh1::ParseError::BadPatchTable,
	      "envelope rejects overlapping payloads");

	// The eye mapping must place the canvas inside its source tile with a real frustum.
	{
		auto mappingCase = [&](auto mutate) {
			std::vector<uint8_t> bad = wire;
			auto* u = reinterpret_cast<gxh1::FoveaUnitHeader*>(bad.data() + header.foveaOffset);
			mutate(*u);
			reseal(bad);
			return gxh1::ParseFrame(bad.data(), bad.size(), limits, parsed);
		};
		Check(mappingCase([](gxh1::FoveaUnitHeader& u) { u.eyes[1].originX = 40; }) == gxh1::ParseError::BadMapping,
		      "envelope rejects a canvas outside its eye tile");
		Check(mappingCase([](gxh1::FoveaUnitHeader& u) { u.eyes[0].tanLeft = 2.0f; }) == gxh1::ParseError::BadMapping,
		      "envelope rejects an inverted frustum");
		Check(mappingCase([](gxh1::FoveaUnitHeader& u) { u.eyes[0].gazeY = std::nanf(""); }) ==
		          gxh1::ParseError::BadMapping,
		      "envelope rejects non-finite gaze");
		Check(mappingCase([](gxh1::FoveaUnitHeader& u) { u.eyes[1].sourceW = 0; }) == gxh1::ParseError::BadMapping,
		      "envelope rejects an empty source tile");
	}
	{
		std::vector<uint8_t> old = wire;
		reinterpret_cast<gxh1::EnvelopeHeader*>(old.data())->versionMajor = 1;
		reseal(old);
		Check(gxh1::ParseFrame(old.data(), old.size(), limits, parsed) == gxh1::ParseError::BadVersion,
		      "envelope rejects the unplaceable v1 layout");
	}

	// Degraded frame with no fovea must parse and carry the degraded flag.
	corrupt = wire;
	{
		auto* h = reinterpret_cast<gxh1::EnvelopeHeader*>(corrupt.data());
		h->flags = gxh1::kFlagDegraded;
		h->foveaBytes = 0;
		h->patchCount = 0;
		h->foveaCodec = gxh1::kFoveaCodecNone;
		h->foveaOffset = 0;
		corrupt.resize(static_cast<size_t>(h->baseOffset) + h->baseBytes);
	}
	reseal(corrupt);
	Check(gxh1::ParseFrame(corrupt.data(), corrupt.size(), limits, parsed) == gxh1::ParseError::None &&
	          !parsed.foveaPresent,
	      "envelope accepts degraded base-only frame");
}

void DebugDwt() {
	for (int n : {2, 4, 8, 13}) {
		std::vector<float> line(static_cast<size_t>(n));
		for (int i = 0; i < n; ++i) line[i] = std::sin(static_cast<float>(i) * 1.7f) + 0.3f * i;
		const std::vector<float> originalLine = line;
		gxh1::PwForwardLine(line, n);
		gxh1::PwInverseLine(line, n);
		float lineError = 0.0f;
		for (int i = 0; i < n; ++i) lineError = std::max(lineError, std::fabs(line[i] - originalLine[i]));
		std::printf("DEBUG line %d: max error %.6f\n", n, lineError);
		if (n == 4) {
			std::vector<float> probe = {0.0f, 0.1f, 0.2f, 0.3f};
			gxh1::PwForwardLine(probe, 4);
			std::printf("DEBUG line4 forward: %.4f %.4f %.4f %.4f\n", probe[0], probe[1], probe[2], probe[3]);
		}

		std::vector<float> plane(static_cast<size_t>(n) * n);
		for (int y = 0; y < n; ++y)
			for (int x = 0; x < n; ++x) plane[static_cast<size_t>(y) * n + x] = static_cast<float>(y * n + x) * 0.1f;
		const std::vector<float> original = plane;
		gxh1::PwForwardTransform(plane, n, n);
		gxh1::PwInverseTransform(plane, n, n);
		float maxError = 0.0f;
		for (size_t i = 0; i < plane.size(); ++i) maxError = std::max(maxError, std::fabs(plane[i] - original[i]));
		std::printf("DEBUG dwt %d: max error %.6f\n", n, maxError);
		if (n == 4) {
			std::printf("forward:");
			for (float value : original) (void)value;
			std::vector<float> fwd = original;
			gxh1::PwForwardTransform(fwd, n, n);
			for (float value : fwd) std::printf(" %.4f", value);
			std::printf("\n");
		}
	}

	// Non-power-of-two aligned sizes must round trip too.
	for (const auto& dims : {std::pair<int, int>{224, 160}, {96, 288}, {128, 32}}) {
		const int w = dims.first, h = dims.second;
		std::vector<float> plane(static_cast<size_t>(w) * h);
		for (int y = 0; y < h; ++y)
			for (int x = 0; x < w; ++x)
				plane[static_cast<size_t>(y) * w + x] = std::sin(x * 0.05f) * 0.3f + std::cos(y * 0.03f) * 0.2f;
		const std::vector<float> original = plane;
		gxh1::PwForwardTransform(plane, w, h);
		gxh1::PwInverseTransform(plane, w, h);
		float error = 0.0f;
		for (size_t i = 0; i < plane.size(); ++i) error = std::max(error, std::fabs(plane[i] - original[i]));
		std::printf("DEBUG dwt2d %dx%d: max error %.6f\n", w, h, error);
	}
	{
		const int size = 128;
		std::vector<float> plane(static_cast<size_t>(size) * size);
		for (int y = 0; y < size; ++y)
			for (int x = 0; x < size; ++x) plane[static_cast<size_t>(y) * size + x] = x / 127.0f - 0.5f;
		gxh1::PwForwardTransform(plane, size, size);
		double quad[4] = {0, 0, 0, 0};
		for (int y = 0; y < size; ++y) {
			for (int x = 0; x < size; ++x) {
				const int q = (x >= size / 2 ? 1 : 0) + (y >= size / 2 ? 2 : 0);
				quad[q] += std::fabs(plane[static_cast<size_t>(y) * size + x]);
			}
		}
		std::printf("DEBUG bands LL=%.2f HL=%.2f LH=%.2f HH=%.2f\n", quad[0], quad[1], quad[2], quad[3]);
		std::printf("DEBUG LL4 row0: %.3f %.3f %.3f %.3f\n", plane[0], plane[1], plane[2], plane[3]);
		std::printf("DEBUG LL4 row1: %.3f %.3f %.3f %.3f\n", plane[128], plane[129], plane[130], plane[131]);

		// Reconstruct from LL4 only and compare with the source ramp.
		std::vector<float> llOnly(static_cast<size_t>(size) * size, 0.0f);
		for (int y = 0; y < 4; ++y)
			for (int x = 0; x < 4; ++x) llOnly[static_cast<size_t>(y) * size + x] = plane[static_cast<size_t>(y) * size + x];
		gxh1::PwInverseTransform(llOnly, size, size);
		std::printf("DEBUG ll-only: x0=%.3f x32=%.3f x64=%.3f x96=%.3f x127=%.3f\n", llOnly[0], llOnly[32],
		            llOnly[64], llOnly[96], llOnly[127]);
	}
}

void DebugPyroWave() {
	const int w = 128, h = 128;
	std::vector<uint8_t> ramp(static_cast<size_t>(w) * h * 3u);
	for (int y = 0; y < h; ++y)
		for (int x = 0; x < w; ++x) {
			const uint8_t v = static_cast<uint8_t>(x * 2);
			uint8_t* p = ramp.data() + (static_cast<size_t>(y) * w + x) * 3u;
			p[0] = p[1] = p[2] = v;
		}
	std::vector<uint8_t> flat(static_cast<size_t>(w) * h * 3u, 128);

	for (const auto* image : {&flat, &ramp}) {
		std::vector<uint8_t> wire;
		gxh1::PwEncodeOptions options;
		gxh1::PwStats stats;
		gxh1::PwEncodeRgb(image->data(), static_cast<size_t>(w) * 3u, w, h, options, wire, &stats);
		int dw = 0, dh = 0;
		std::vector<uint8_t> decoded;
		const bool ok = gxh1::PwDecodeRgb(wire.data(), wire.size(), decoded, dw, dh);
		std::printf("DEBUG pw %s: ok=%d bytes=%zu blocks=%u psnr=%.2f\n", image == &flat ? "flat" : "ramp",
		            static_cast<int>(ok), wire.size(), stats.blocks, ok ? Psnr(*image, decoded) : 0.0);
		if (ok) {
			for (int x = 0; x < 8; ++x) {
				std::printf("  x=%d in=%u out=%u\n", x * 16, (*image)[static_cast<size_t>(x * 16) * 3],
				            decoded[static_cast<size_t>(x * 16) * 3]);
			}
			std::printf("  mid in=%u out=%u\n", (*image)[static_cast<size_t>(64) * w * 3 + 64 * 3],
			            decoded[static_cast<size_t>(64) * w * 3 + 64 * 3]);
		}
	}
}

void DebugTwoColorBlock() {
	const int size = 6;
	std::vector<uint8_t> src(static_cast<size_t>(size) * size * 3u, 240);
	for (int y = 0; y < size; ++y) {
		for (int x = 0; x < 3; ++x) {
			uint8_t* p = src.data() + (static_cast<size_t>(y) * size + x) * 3u;
			p[0] = 8;
			p[1] = 12;
			p[2] = 20;
		}
	}
	std::vector<uint8_t> blocks;
	gxh1::AstcEncodeRgb(src.data(), static_cast<size_t>(size) * 3u, size, size, 6, 6, blocks);
	gxh1::AstcBlockInfo info;
	gxh1::AstcInspectBlock(blocks.data(), 6, 6, info);
	std::printf("DEBUG mode=0x%03x grid=%dx%d quant=%u wbits=%u cbits=%d supported=%d\n", info.blockMode, info.gridX,
	            info.gridY, info.weightQuant, info.weightBits, info.colorBits, static_cast<int>(info.supported));
	for (size_t i = 0; i < 16; ++i) std::printf("%02x%s", blocks[i], (i == 15) ? "\n" : " ");
	std::vector<uint8_t> decoded;
	gxh1::AstcDecodeRgb(blocks.data(), blocks.size(), size, size, 6, 6, decoded);
	for (int y = 0; y < size; ++y) {
		std::printf("DEBUG row %d:", y);
		for (int x = 0; x < size; ++x) std::printf(" %3u", decoded[static_cast<size_t>(y) * size + x * 3]);
		std::printf("\n");
	}
	std::printf("DEBUG psnr %.2f\n", Psnr(src, decoded));
}

void TestAstcEndpointField() {
	// Independent physical-layout check: for a uniform block both endpoints equal the
	// colour, and FMT_RGB stores them as R0,R1,G0,G1,B0,B1 at bits 17..64.
	const int w = 4, h = 4;
	std::vector<uint8_t> rgb(static_cast<size_t>(w) * h * 3u);
	for (int i = 0; i < w * h; ++i) {
		rgb[i * 3 + 0] = 10;
		rgb[i * 3 + 1] = 200;
		rgb[i * 3 + 2] = 30;
	}
	std::vector<uint8_t> blocks;
	Check(gxh1::AstcEncodeRgb(rgb.data(), static_cast<size_t>(w) * 3u, w, h, 4, 4, blocks), "astc endpoint encode");
	const uint8_t* block = blocks.data();
	auto bitAt = [&](int pos) { return (block[pos >> 3] >> (pos & 7)) & 1u; };
	uint8_t field[6] = {};
	for (int i = 0; i < 6; ++i) {
		uint32_t value = 0;
		for (int bit = 0; bit < 8; ++bit) value |= bitAt(17 + i * 8 + bit) << bit;
		field[i] = static_cast<uint8_t>(value);
	}
	std::printf("  astc endpoint field: %u %u %u %u %u %u\n", field[0], field[1], field[2], field[3], field[4],
	            field[5]);
	Check(field[0] == 10 && field[1] == 10, "astc R0/R1 interleaved first");
	Check(field[2] == 200 && field[3] == 200, "astc G0/G1 follow");
	Check(field[4] == 30 && field[5] == 30, "astc B0/B1 last");

	std::vector<uint8_t> decoded;
	Check(gxh1::AstcDecodeRgb(blocks.data(), blocks.size(), w, h, 4, 4, decoded), "astc endpoint decode");
	Check(decoded[0] == 10 && decoded[1] == 200 && decoded[2] == 30, "astc endpoint round trip");
}

// Builds one ASTC block by hand (independent of the encoder) and checks the decoder
// against the spec order: weight infill rounded first, then UNORM8 endpoint mixing.
void TestAstcDecodeOrder() {
	// 5x5 footprint, 3x3 QUANT_8 grid, black/white endpoints, alternating weight codes 0/1.
	const uint8_t blockW = 5, blockH = 5, gridX = 3, gridY = 3, quant = 5;
	const uint32_t mode = gxh1::FindAstcBlockMode(blockW, blockH, gridX, gridY, quant);
	Check(mode != 0, "astc 5x5 3x3 QUANT_8 block mode exists");
	uint8_t block[16] = {};
	auto setBit = [&](int pos, unsigned bit) {
		if (bit) block[pos >> 3] = static_cast<uint8_t>(block[pos >> 3] | (1u << (pos & 7)));
	};
	for (int bit = 0; bit < 11; ++bit) setBit(bit, (mode >> bit) & 1u);
	for (int bit = 0; bit < 4; ++bit) setBit(13 + bit, (8u >> bit) & 1u);  // FMT_RGB
	const uint8_t endpoints[6] = {0, 255, 0, 255, 0, 255};                  // R0,R1,G0,G1,B0,B1
	for (int i = 0; i < 6; ++i) {
		for (int bit = 0; bit < 8; ++bit) setBit(17 + i * 8 + bit, (endpoints[i] >> bit) & 1u);
	}
	uint8_t codes[9];
	for (int n = 0; n < 9; ++n) {
		codes[n] = static_cast<uint8_t>(n & 1);
		for (int bit = 0; bit < 3; ++bit) setBit(127 - (n * 3 + bit), (codes[n] >> bit) & 1u);
	}
	std::vector<uint8_t> decoded;
	Check(gxh1::AstcDecodeRgb(block, 16, blockW, blockH, blockW, blockH, decoded), "astc hand block decodes");
	const int unq[2] = {0, 9};
	int mismatches = 0;
	for (int y = 0; y < blockH; ++y) {
		for (int x = 0; x < blockW; ++x) {
			const unsigned xw = ((((1024u + blockW / 2u) / (blockW - 1u)) * x * (gridX - 1u)) + 32u) >> 6;
			const unsigned yw = ((((1024u + blockH / 2u) / (blockH - 1u)) * y * (gridY - 1u)) + 32u) >> 6;
			const unsigned fs = xw & 15u, ft = yw & 15u, js = xw >> 4, jt = yw >> 4;
			const unsigned v0 = js + jt * gridX;
			const unsigned w11 = (fs * ft + 8u) >> 4;
			const unsigned w10 = ft - w11, w01 = fs - w11, w00 = 16u - fs - ft + w11;
			auto weightAt = [&](unsigned index) { return index < 9u ? unq[codes[index]] : 0; };
			const int w = static_cast<int>((weightAt(v0) * w00 + weightAt(v0 + 1) * w01 + weightAt(v0 + gridX) * w10 +
			                                weightAt(v0 + gridX + 1) * w11 + 8u) >> 4);
			const int expected = ((255 * 257 * w + 32) >> 6) >> 8;
			if (decoded[(static_cast<size_t>(y) * blockW + x) * 3u] != expected) ++mismatches;
		}
	}
	Check(mismatches == 0, "astc decode follows the spec order (" + std::to_string(mismatches) + " mismatches)");
}

// Strong strokes next to faint texture: subblocks of one 8x8 then differ by many bitplanes,
// which an earlier encoder shifted into the wrong planes.
void TestPyroWaveMixedMagnitudes() {
	const int w = 256, h = 256;
	std::vector<uint8_t> rgb(static_cast<size_t>(w) * h * 3u);
	uint32_t seed = 12345u;
	for (int y = 0; y < h; ++y) {
		for (int x = 0; x < w; ++x) {
			seed = seed * 1664525u + 1013904223u;
			const int v = x < w / 2 ? (((x / 3 + y / 5) & 1) ? 250 : 5) : 120 + static_cast<int>((seed >> 24) % 9) - 4;
			for (int c = 0; c < 3; ++c) rgb[(static_cast<size_t>(y) * w + x) * 3u + c] = static_cast<uint8_t>(v);
		}
	}
	gxh1::PwEncodeOptions options;
	std::vector<uint8_t> wire;
	gxh1::PwStats stats;
	Check(gxh1::PwEncodeRgb(rgb.data(), static_cast<size_t>(w) * 3u, w, h, options, wire, &stats), "pyrowave mixed encode");
	std::vector<uint8_t> decoded;
	int dw = 0, dh = 0;
	Check(gxh1::PwDecodeRgb(wire.data(), wire.size(), decoded, dw, dh), "pyrowave mixed decode");
	int maxError = 0;
	for (size_t i = 0; i < rgb.size() && i < decoded.size(); ++i) {
		maxError = std::max(maxError, std::abs(static_cast<int>(rgb[i]) - static_cast<int>(decoded[i])));
	}
	std::printf("  pyrowave mixed magnitudes: max error %d, %zu B\n", maxError, wire.size());
	Check(maxError <= 1, "pyrowave full precision keeps faint texture beside strong edges");

	// Ring weighting: a coarser step outside the centre must cost fewer bytes and leave the
	// centre at full precision.
	struct Centre {
		static float Scale(const void*, int, int, int x0, int y0, int x1, int y1) {
			return (x0 < 160 && x1 > 96 && y0 < 160 && y1 > 96) ? 1.0f : 3.0f;
		}
		// Ring density as a wavelet does it: the finest detail band is left out away from
		// the centre (a density of one half).
		static float HalfDensityOutside(const void*, int level, int band, int x0, int y0, int x1, int y1) {
			const bool centre = x0 < 160 && x1 > 96 && y0 < 160 && y1 > 96;
			return (!centre && band != 0 && level == 0) ? 0.0f : 1.0f;
		}
	};
	gxh1::PwEncodeOptions weighted;
	weighted.stepScale = &Centre::Scale;
	weighted.maxBytes = 0;
	weighted.baseBitplanes = 14;
	gxh1::PwEncodeOptions uniform = weighted;
	uniform.stepScale = nullptr;
	std::vector<uint8_t> weightedWire, uniformWire;
	Check(gxh1::PwEncodeRgb(rgb.data(), static_cast<size_t>(w) * 3u, w, h, weighted, weightedWire, nullptr) &&
	          gxh1::PwEncodeRgb(rgb.data(), static_cast<size_t>(w) * 3u, w, h, uniform, uniformWire, nullptr),
	      "pyrowave weighted encodes");
	std::vector<uint8_t> weightedDecoded, uniformDecoded;
	Check(gxh1::PwDecodeRgb(weightedWire.data(), weightedWire.size(), weightedDecoded, dw, dh) &&
	          gxh1::PwDecodeRgb(uniformWire.data(), uniformWire.size(), uniformDecoded, dw, dh),
	      "pyrowave weighted decodes");
	double centreDiff = 0.0;
	for (int y = 112; y < 144; ++y) {
		for (int x = 112; x < 144; ++x) {
			for (int c = 0; c < 3; ++c) {
				const size_t i = (static_cast<size_t>(y) * w + x) * 3u + c;
				centreDiff = std::max(centreDiff, std::fabs(static_cast<double>(weightedDecoded[i]) - uniformDecoded[i]));
			}
		}
	}
	std::printf("  pyrowave ring weighting: %zu B weighted vs %zu B uniform, centre max diff %.0f\n",
	            weightedWire.size(), uniformWire.size(), centreDiff);
	Check(weightedWire.size() < uniformWire.size(), "pyrowave ring weighting saves bytes");
	Check(centreDiff <= 1.0, "pyrowave ring weighting keeps the centre step");

	gxh1::PwEncodeOptions dropped = uniform;
	dropped.stepScale = &Centre::HalfDensityOutside;
	std::vector<uint8_t> droppedWire, droppedDecoded;
	Check(gxh1::PwEncodeRgb(rgb.data(), static_cast<size_t>(w) * 3u, w, h, dropped, droppedWire, nullptr) &&
	          gxh1::PwDecodeRgb(droppedWire.data(), droppedWire.size(), droppedDecoded, dw, dh),
	      "pyrowave band-dropped encode decodes");
	double droppedCentre = 0.0;
	for (int y = 112; y < 144; ++y)
		for (int x = 112; x < 144; ++x)
			for (int c = 0; c < 3; ++c) {
				const size_t i = (static_cast<size_t>(y) * w + x) * 3u + c;
				droppedCentre = std::max(droppedCentre, std::fabs(static_cast<double>(droppedDecoded[i]) - uniformDecoded[i]));
			}
	std::printf("  pyrowave half density outside the centre: %zu B vs %zu B, centre max diff %.0f\n",
	            droppedWire.size(), uniformWire.size(), droppedCentre);
	Check(droppedWire.size() * 10 < uniformWire.size() * 8, "pyrowave dropping the finest band outside saves >20%");
	Check(droppedCentre <= 1.0, "pyrowave band dropping keeps the centre intact");
}

void TestPyroWaveRoundTrip() {
	// The transform must be reversible on its own before any quantization is involved.
	{
		std::vector<float> plane(128 * 128);
		for (int y = 0; y < 128; ++y) {
			for (int x = 0; x < 128; ++x) {
				plane[static_cast<size_t>(y) * 128 + x] =
					std::sin(x * 0.11f) * 0.3f + std::cos(y * 0.07f) * 0.2f + (x > 64 ? 0.25f : -0.1f);
			}
		}
		const std::vector<float> original = plane;
		gxh1::PwForwardTransform(plane, 128, 128);
		gxh1::PwInverseTransform(plane, 128, 128);
		double maxError = 0.0;
		for (size_t i = 0; i < plane.size(); ++i) {
			maxError = std::max(maxError, static_cast<double>(std::fabs(plane[i] - original[i])));
		}
		std::printf("  pyrowave transform round trip: max error %.6f\n", maxError);
		Check(maxError < 1e-3, "pyrowave dwt reversible");
	}

	const int widths[] = {128, 200, 133};
	const int heights[] = {128, 150, 129};
	for (int kind = 0; kind < 4; ++kind) {
		for (int i = 0; i < 3; ++i) {
			const int w = widths[i];
			const int h = heights[i];
			const std::vector<uint8_t> src = MakeImage(w, h, kind);
			std::vector<uint8_t> wire;
			gxh1::PwEncodeOptions options;
			gxh1::PwStats stats;
			Check(gxh1::PwEncodeRgb(src.data(), static_cast<size_t>(w) * 3u, w, h, options, wire, &stats),
			      "pyrowave encode");
			Check(wire.size() >= 8 && stats.blocks > 0, "pyrowave header/blocks");

			int decodedW = 0, decodedH = 0;
			std::vector<uint8_t> decoded;
			const bool decodedOk = gxh1::PwDecodeRgb(wire.data(), wire.size(), decoded, decodedW, decodedH);
			Check(decodedOk, std::string("pyrowave decode: ") + gxh1::g_pwLastError);
			Check(decodedW == w && decodedH == h, "pyrowave dimensions");
			const double psnr = Psnr(src, decoded);
			std::printf("  pyrowave %dx%d kind %d full: %6.2f dB %6zu B (%5.2f bpp)\n", w, h, kind, psnr,
			            wire.size(), wire.size() * 8.0 / (w * h));
			Check(psnr >= 34.0, "pyrowave full precision psnr");

			// Budgeted encode: a 2:1 reduction is requested. The format is sign-dominated at
			// very low rates, so the encoder may honestly report the request as infeasible
			// instead of exceeding it silently.
			const uint32_t budget = std::max<uint32_t>(1024u, static_cast<uint32_t>(wire.size() / 2));
			options.maxBytes = budget;
			gxh1::PwStats budgetStats;
			std::vector<uint8_t> budgetWire;
			Check(gxh1::PwEncodeRgb(src.data(), static_cast<size_t>(w) * 3u, w, h, options, budgetWire, &budgetStats),
			      "pyrowave encode budget");
			if (budgetStats.budgetExceeded) {
				std::printf("  pyrowave %dx%d kind %d: budget %u B infeasible, minimum %zu B reported\n", w, h, kind,
				            budget, budgetWire.size());
				Check(budgetWire.size() > budget, "pyrowave infeasible budget is honest");
			} else {
				Check(budgetWire.size() <= budget, "pyrowave budget respected");
			}
			std::vector<uint8_t> budgetDecoded;
			Check(gxh1::PwDecodeRgb(budgetWire.data(), budgetWire.size(), budgetDecoded, decodedW, decodedH),
			      "pyrowave decode budget");
			const double budgetPsnr = Psnr(src, budgetDecoded);
			std::printf("  pyrowave %dx%d kind %d <=%uB: %6.2f dB %6zu B drop=%u\n", w, h, kind, budget, budgetPsnr,
			            budgetWire.size(), static_cast<unsigned>(budgetStats.droppedPlanes));
			Check(budgetPsnr >= 12.0, "pyrowave budgeted psnr");

			options.maxBytes = 512;
			gxh1::PwStats tightStats;
			std::vector<uint8_t> tightWire;
			Check(gxh1::PwEncodeRgb(src.data(), static_cast<size_t>(w) * 3u, w, h, options, tightWire, &tightStats),
			      "pyrowave encode tight budget");
			Check(tightStats.budgetExceeded, "pyrowave reports infeasible budget");
			Check(tightWire.size() > 512u, "pyrowave does not drop required data");

			// A frame cut inside a packet must be rejected; a cut on a packet boundary is a
			// legal partial frame (missing 32x32 blocks decode as zero by design).
			std::vector<uint8_t> truncated(wire.begin(), wire.end() - 2);
			std::vector<uint8_t> ignored;
			Check(!gxh1::PwDecodeRgb(truncated.data(), truncated.size(), ignored, decodedW, decodedH),
			      "pyrowave rejects mid-packet truncation");
			std::vector<uint8_t> half(wire.begin(), wire.begin() + static_cast<long>(wire.size() / 2));
			ignored.clear();
			const bool halfOk = gxh1::PwDecodeRgb(half.data(), half.size(), ignored, decodedW, decodedH);
			Check(!halfOk || (decodedW == w && decodedH == h && ignored.size() == src.size()),
			      "pyrowave partial frame stays bounded");
		}
	}
}

}  // namespace

int main(int argc, char** argv) {
	std::printf("GXH1/ASTC core tests\n");
	if (argc > 1 && std::strcmp(argv[1], "--debug-block") == 0) {
		DebugTwoColorBlock();
		return 0;
	}
	if (argc > 1 && std::strcmp(argv[1], "--debug-dwt") == 0) {
		DebugDwt();
		return 0;
	}
	if (argc > 1 && std::strcmp(argv[1], "--debug-pw") == 0) {
		DebugPyroWave();
		return 0;
	}
	TestAstcRoundTrip();
	TestAstcEndpointField();
	TestAstcDecodeOrder();
	TestPyroWaveMixedMagnitudes();
	TestPyroWaveRoundTrip();
	TestCoverageExactness();
	TestPlanner();
	TestEnvelope();
	std::printf("%d checks, %d failures\n", checks, failures);
	return failures == 0 ? 0 : 1;
}
