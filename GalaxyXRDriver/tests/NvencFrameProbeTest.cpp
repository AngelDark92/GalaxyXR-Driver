// Standalone observation ABI tests. No SteamVR, NVENC, process writes or files.
#include "../src/Driver/NvencFrameProbe.h"
#include <algorithm>
#include <cstdio>
#include <iostream>
#include <memory>
#include <vector>

namespace fp = gxr::frameprobe;
static int checks = 0, failures = 0;
static void Check(bool passed, const char* message){
	++checks;
	if(passed){ return; }
	++failures;
	std::cerr << "FAIL: " << message << '\n';
}

int main(){
	struct Guarded {
		std::uint64_t before = UINT64_C(0x6e85617a4d03b2c9);
		fp::Probe probe;
		std::uint64_t after = UINT64_C(0x351fb082ea6c47d9);
	};
	auto owned = std::make_unique<Guarded>(); // Four MiB lives on the heap.
	auto& probe = owned->probe;
	fp::State state;
	const unsigned char a[] = {0, 0, 0, 1, 0x26, 1, 0x80, 0x11};
	const unsigned char b[] = {0x12, 0, 0x32, 1, 0x33};
	Check(probe.magic == UINT64_C(0x3156424f52505847), "ABI magic is explicit little-endian GXPROBV1");
	Check(probe.abi == 1 && probe.headerBytes == 128, "ABI version and header length");
	Check(probe.capacity == 2097152 && probe.slotBytes == 2097216, "Payload/slot byte sizes");
	Check(probe.counterSeq.load() == 0 && probe.latestFrame.sequence.load() == 0, "Unpublished sequences start even at zero");
	Check(probe.flags == 0 && probe.latestFrame.flags == 0, "Unpublished counters and frames are invalid");

	state.Record(probe, 1234, 0, 0, 1, sizeof(a), 10, a, sizeof(a), true);
	Check(probe.pid == 1234 && probe.flags == fp::kCountersValid, "Counters carry the actual owner");
	Check(probe.totalFrames == 1 && probe.totalBytes == sizeof(a), "Counters are copied without a configured bitrate");
	Check(probe.counterTickMs == 0 && probe.generation == 1, "A real capture at tick zero is admitted");
	Check(probe.counterSeq.load() == 2 && !(probe.counterSeq.load() & 1), "Counter publication is committed even");
	Check(probe.latestFrame.flags == (fp::kFrameValid | fp::kFrameKeyframe), "First frame can be a complete keyframe");
	Check(probe.latestFrame.fullLength == sizeof(a) && probe.latestFrame.copiedLength == sizeof(a), "Actual frame length retained");
	Check(std::memcmp(probe.latestFrame.payload, a, sizeof(a)) == 0, "Latest frame owns copied bytes");
	Check(std::memcmp(probe.latestKeyframe.payload, a, sizeof(a)) == 0, "Keyframe owns a separate copy");
	Check(probe.latestFrame.captureId > 0 && probe.latestKeyframe.captureId > probe.latestFrame.captureId, "Capture IDs advance between slots");
	const auto firstLatest = probe.latestFrame.captureId;
	const auto firstKey = probe.latestKeyframe.captureId;

	state.Record(probe, 1234, 999, 0, 2, 100, 11, b, sizeof(b), false);
	Check(probe.totalFrames == 2 && probe.totalBytes == 100 && probe.counterTickMs == 999, "Counters update independently of frame sampling");
	Check(probe.latestFrame.captureId == firstLatest, "Latest frame is not resampled before one second");
	Check(probe.latestKeyframe.captureId == firstKey, "A P frame does not replace retained keyframe");
	state.Record(probe, 1234, 1000, 0, 3, 105, 12, b, sizeof(b), false);
	Check(probe.latestFrame.captureId > firstKey && probe.latestFrame.frameIndex == 12, "Exact interval boundary publishes latest frame");
	Check(probe.latestFrame.flags == fp::kFrameValid, "P frame is not mislabeled keyframe");
	Check(std::memcmp(probe.latestFrame.payload, b, sizeof(b)) == 0, "Latest frame payload advances");
	Check(probe.latestKeyframe.captureId == firstKey, "Keyframe remains available independently");
	const auto at1000 = probe.latestFrame.captureId;
	state.Record(probe, 1234, 2107, 0, 4, 110, 13, a, sizeof(a), true);
	Check(probe.latestFrame.tickMs == 2107 && probe.latestFrame.captureId > at1000, "Irregular interval uses actual producer tick");
	Check(probe.latestKeyframe.tickMs == 2107 && probe.latestKeyframe.captureId > firstKey, "Eligible later keyframe is retained");
	const auto beforeRegression = probe.latestFrame.captureId;
	state.Record(probe, 1234, 2000, 0, 5, 115, 14, b, sizeof(b), false);
	Check(probe.latestFrame.captureId == beforeRegression, "Clock regression is not an unsigned elapsed-time burst");

	const auto oldGeneration = probe.generation;
	state.Record(probe, 1234, 2110, 22, 6, 120, 1, nullptr, 0, false);
	Check(probe.generation == oldGeneration + 1, "Stream transition increments opaque generation");
	Check(probe.latestFrame.flags == 0 && probe.latestKeyframe.flags == 0, "Stream transition invalidates both retained frames");
	Check(probe.latestFrame.copiedLength == 0 && probe.latestKeyframe.copiedLength == 0, "Old payload bytes cannot be accepted after invalidation");
	Check(probe.latestFrame.generation == probe.generation && probe.latestKeyframe.generation == probe.generation, "Invalidated metadata identifies current generation");
	Check(probe.totalFrames == 6 && probe.totalBytes == 120, "Empty new stream still publishes real counters");
	state.Record(probe, 1234, 2111, 22, 7, 125, 2, b, sizeof(b), false);
	Check(probe.latestFrame.flags == fp::kFrameValid && probe.latestFrame.tickMs == 2111, "First payload in new stream bypasses old interval");
	Check(probe.latestKeyframe.flags == 0, "No fabricated keyframe is published for a new P-only stream");
	state.Record(probe, 1234, 2112, 22, 8, 130, 3, a, sizeof(a), true);
	Check(probe.latestKeyframe.flags == (fp::kFrameValid | fp::kFrameKeyframe), "First new-stream keyframe has its own sampling interval");
	Check(probe.latestKeyframe.tickMs == 2112 && probe.latestFrame.tickMs == 2111, "Keyframe slot advances without oversampling latest slot");
	const auto beforeNull = probe.latestFrame.captureId;
	state.Record(probe, 1234, 4000, 22, 9, 135, 4, nullptr, 100, false);
	state.Record(probe, 1234, 4001, 22, 10, 140, 5, a, 0, false);
	Check(probe.latestFrame.captureId == beforeNull, "Null/empty frames do not fabricate captures");
	Check(probe.totalFrames == 10 && probe.totalBytes == 140, "Null/empty frames do not suppress live counter publication");

	std::vector<unsigned char> oversized(fp::kPayloadCapacity + 17, 0x95);
	oversized.front() = 0x10;
	oversized[fp::kPayloadCapacity - 1] = 0x38;
	state.Record(probe, 1234, 5005, 22, 11, 200, 6, oversized.data(), static_cast<std::uint32_t>(oversized.size()), true);
	Check(probe.latestFrame.fullLength == oversized.size(), "Oversized original size remains visible");
	Check(probe.latestFrame.copiedLength == fp::kPayloadCapacity, "Oversized copy is bounded at capacity");
	Check(probe.latestFrame.flags == (fp::kFrameValid | fp::kFrameTruncated | fp::kFrameKeyframe), "Truncation is explicit and cannot pass as a complete frame");
	Check(probe.latestKeyframe.flags == probe.latestFrame.flags, "Retained keyframe also reports truncation");
	Check(probe.latestFrame.payload[0] == 0x10 && probe.latestFrame.payload[fp::kPayloadCapacity - 1] == 0x38, "Copy preserves first and last admitted bytes");
	Check(owned->before == UINT64_C(0x6e85617a4d03b2c9) && owned->after == UINT64_C(0x351fb082ea6c47d9), "Oversized capture preserves surrounding canaries");
	Check(probe.latestFrame.sequence.load() % 2 == 0 && probe.latestKeyframe.sequence.load() % 2 == 0, "All slot publications finish committed even");
	Check(probe.counterSeq.load() % 2 == 0, "All counter publications finish committed even");

	std::cout << checks << " checks, " << failures << " failures\n";
	return failures == 0 ? 0 : 1;
}
