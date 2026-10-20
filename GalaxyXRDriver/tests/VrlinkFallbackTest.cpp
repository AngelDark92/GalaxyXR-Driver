// VrlinkFallbackTap pin/classification tests (2026-10-20).
//
// Exercises the window classifier the tap uses against the loaded
// driver_vrlink.dll image: stock span -> 1, already patched span -> 2, any
// other byte in the anchor window -> 0 (fail-closed). No SteamVR, no module
// load, no writes: the image is a synthetic buffer.
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "../src/Driver/VrlinkFallbackTap.h"

namespace {
int gFailures = 0;

// The pinned RVAs sit at ~10.6 MB; the buffer covers the highest one with room.
constexpr size_t kImageSize = 0xB00000;

void Check(bool condition, const std::string& label){
	if(!condition){
		std::printf("FAIL %s\n", label.c_str());
		++gFailures;
	}
}

struct Span {
	const char* name;
	int windowRva;
	const unsigned char* window;
	size_t windowSize;
	int spanRva;
	const unsigned char* stock;
	const unsigned char* patched;
	size_t spanSize;
};

Span RatioSpan(){
	return Span{"ratio", VrlinkFallbackPin::kRatioWindowRva, VrlinkFallbackPin::kRatioWindow,
		sizeof(VrlinkFallbackPin::kRatioWindow), VrlinkFallbackPin::kRatioBranchRva,
		VrlinkFallbackPin::kRatioBranchStock, VrlinkFallbackPin::kRatioBranchPatched,
		sizeof(VrlinkFallbackPin::kRatioBranchStock)};
}

Span ThrottleSpan(){
	return Span{"throttle", VrlinkFallbackPin::kOutWindowRva, VrlinkFallbackPin::kOutWindow,
		sizeof(VrlinkFallbackPin::kOutWindow), VrlinkFallbackPin::kThrottleMulRva,
		VrlinkFallbackPin::kThrottleMulStock, VrlinkFallbackPin::kThrottleMulPatched,
		sizeof(VrlinkFallbackPin::kThrottleMulStock)};
}

int Classify(const std::vector<unsigned char>& image, const Span& span){
	return ClassifyVrlinkFallbackWindow(image.data(), span.windowRva, span.window, span.windowSize,
		static_cast<size_t>(span.spanRva - span.windowRva), span.spanSize, span.stock, span.patched);
}

// Writes the anchor window with either the stock or the patched span.
std::vector<unsigned char> ImageWith(const Span& span, bool patched){
	std::vector<unsigned char> image(kImageSize, 0);
	memcpy(image.data() + span.windowRva, span.window, span.windowSize);
	const unsigned char* bytes = patched ? span.patched : span.stock;
	memcpy(image.data() + span.spanRva, bytes, span.spanSize);
	return image;
}
}

int main(){
	const Span ratio = RatioSpan();
	const Span throttle = ThrottleSpan();

	// Constant self-consistency: both spans fit inside their anchor windows.
	Check(ratio.spanRva >= ratio.windowRva
		&& ratio.spanRva + static_cast<int>(ratio.spanSize) <= ratio.windowRva + static_cast<int>(ratio.windowSize),
		std::string("ratio span lies inside its window"));
	Check(throttle.spanRva >= throttle.windowRva
		&& throttle.spanRva + static_cast<int>(throttle.spanSize) <= throttle.windowRva + static_cast<int>(throttle.windowSize),
		std::string("throttle span lies inside its window"));

	// The anchors must not overlap each other (independent pages).
	Check(ratio.windowRva + static_cast<int>(ratio.windowSize) <= throttle.windowRva
		|| throttle.windowRva + static_cast<int>(throttle.windowSize) <= ratio.windowRva,
		std::string("anchor windows are disjoint"));

	for(const Span& span : {ratio, throttle}){
		const std::string name = span.name;

		Check(Classify(ImageWith(span, false), span) == 1, name + ": stock image classifies as stock");
		Check(Classify(ImageWith(span, true), span) == 2, name + ": patched image classifies as patched");

		// A single flipped byte OUTSIDE the editable span fails closed.
		std::vector<unsigned char> corrupted = ImageWith(span, false);
		const int outsideSpan = span.windowRva;
		corrupted[outsideSpan] ^= 0x01;
		Check(Classify(corrupted, span) == 0, name + ": context byte change fails closed");

		// A zeroed image (unknown build) fails closed.
		std::vector<unsigned char> unknown(kImageSize, 0);
		Check(Classify(unknown, span) == 0, name + ": unknown image fails closed");

		// A half-written span (neither known form) fails closed.
		std::vector<unsigned char> half = ImageWith(span, false);
		half[span.spanRva] ^= 0xFF;
		Check(Classify(half, span) == 0, name + ": unrecognised span fails closed");
	}

	// The patched branch byte is exactly the audited flip, and the throttle
	// span is two multi-byte NOPs.
	Check(VrlinkFallbackPin::kRatioBranchStock[0] == 0x76 && VrlinkFallbackPin::kRatioBranchPatched[0] == 0xEB,
		std::string("ratio branch is jbe -> jmp"));
	Check(VrlinkFallbackPin::kRatioBranchStock[1] == VrlinkFallbackPin::kRatioBranchPatched[1],
		std::string("ratio branch displacement is unchanged"));
	Check(VrlinkFallbackPin::kThrottleMulStock[0] == 0xF3 && VrlinkFallbackPin::kThrottleMulPatched[0] == 0x1F
		&& VrlinkFallbackPin::kThrottleMulPatched[4] == 0x1F,
		std::string("throttle multiply becomes two NOPs"));

	if(gFailures != 0){
		std::printf("VrlinkFallbackTap tests: %d failure(s)\n", gFailures);
		return 1;
	}
	std::printf("VrlinkFallbackTap tests: all checks passed\n");
	return 0;
}
