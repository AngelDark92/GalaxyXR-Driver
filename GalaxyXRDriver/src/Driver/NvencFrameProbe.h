#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <type_traits>

// Stable, owned read-only observation ABI for the external bitrate monitor.
// The producer is serialized by NvencTap's existing statsLock. The consumer
// reads process memory: accept a slot only when its sequence is the same even
// value before and after the metadata/payload read, and its generation matches
// a coherent current header. No pointer into an NVENC-owned buffer is retained.
namespace gxr { namespace frameprobe {

constexpr std::uint64_t kMagic = UINT64_C(0x3156424F52505847); // "GXPROBV1"
constexpr std::uint32_t kAbi = 1;
constexpr std::uint32_t kHeaderBytes = 128;
constexpr std::uint32_t kPayloadCapacity = 2u * 1024u * 1024u;
constexpr std::uint32_t kSlotBytes = 64u + kPayloadCapacity;
constexpr std::uint64_t kMinimumCaptureIntervalMs = 1000;
constexpr std::uint32_t kCountersValid = 1;
constexpr std::uint32_t kFrameValid = 1;
constexpr std::uint32_t kFrameTruncated = 2;
constexpr std::uint32_t kFrameKeyframe = 4;

struct alignas(8) FrameSlot {
	std::atomic<std::uint64_t> sequence{0};
	std::uint64_t tickMs = 0;
	std::uint64_t generation = 0;
	std::uint64_t frameIndex = 0;
	std::uint32_t fullLength = 0;
	std::uint32_t copiedLength = 0;
	std::uint32_t flags = 0;
	std::uint32_t reserved32 = 0;
	std::uint64_t captureId = 0;
	std::uint64_t reserved64 = 0;
	unsigned char payload[kPayloadCapacity]{};
};

struct alignas(8) Probe {
	std::uint64_t magic = kMagic;
	std::uint32_t abi = kAbi;
	std::uint32_t headerBytes = kHeaderBytes;
	std::uint32_t capacity = kPayloadCapacity;
	std::uint32_t slotBytes = kSlotBytes;
	std::uint32_t pid = 0;
	std::uint32_t flags = 0;
	std::atomic<std::uint64_t> counterSeq{0};
	std::uint64_t totalFrames = 0;
	std::uint64_t totalBytes = 0;
	std::uint64_t counterTickMs = 0;
	std::uint64_t generation = 0;
	std::uint64_t reserved[7]{};
	FrameSlot latestFrame;
	FrameSlot latestKeyframe;
};

static_assert(std::atomic<std::uint64_t>::is_always_lock_free,
	"The probe ABI requires a native lock-free 64-bit sequence counter");
static_assert(sizeof(std::atomic<std::uint64_t>) == 8, "Probe sequence width");
static_assert(std::is_standard_layout<Probe>::value, "Probe must have a stable layout");
static_assert(std::is_standard_layout<FrameSlot>::value, "Frame slot must have a stable layout");
static_assert(alignof(Probe) == 8 && alignof(FrameSlot) == 8, "Probe alignment");
static_assert(offsetof(Probe, magic) == 0 && offsetof(Probe, abi) == 8, "Probe identity offsets");
static_assert(offsetof(Probe, headerBytes) == 12 && offsetof(Probe, capacity) == 16, "Probe size offsets");
static_assert(offsetof(Probe, slotBytes) == 20 && offsetof(Probe, pid) == 24, "Probe owner offsets");
static_assert(offsetof(Probe, flags) == 28 && offsetof(Probe, counterSeq) == 32, "Counter sequence offset");
static_assert(offsetof(Probe, totalFrames) == 40 && offsetof(Probe, totalBytes) == 48, "Counter offsets");
static_assert(offsetof(Probe, counterTickMs) == 56 && offsetof(Probe, generation) == 64, "Counter time offsets");
static_assert(offsetof(Probe, latestFrame) == kHeaderBytes, "Latest frame offset");
static_assert(offsetof(Probe, latestKeyframe) == kHeaderBytes + kSlotBytes, "Keyframe offset");
static_assert(sizeof(Probe) == kHeaderBytes + 2u * kSlotBytes, "Probe ABI byte size");
static_assert(offsetof(FrameSlot, sequence) == 0 && offsetof(FrameSlot, tickMs) == 8, "Frame sequence/time offsets");
static_assert(offsetof(FrameSlot, generation) == 16 && offsetof(FrameSlot, frameIndex) == 24, "Frame identity offsets");
static_assert(offsetof(FrameSlot, fullLength) == 32 && offsetof(FrameSlot, copiedLength) == 36, "Frame length offsets");
static_assert(offsetof(FrameSlot, flags) == 40 && offsetof(FrameSlot, captureId) == 48, "Frame publication offsets");
static_assert(offsetof(FrameSlot, payload) == 64 && sizeof(FrameSlot) == kSlotBytes, "Frame payload offset/size");

class State {
public:
	// streamKey must change on encoder/stream-generation transitions. Its value
	// is opaque to the external reader; this class publishes its own increasing
	// generation. totalFrames/totalBytes are the actual process-global counters.
	// Call only while the supplied NVENC buffer remains locked and valid.
	void Record(Probe& probe, std::uint32_t pid, std::uint64_t nowMs,
		std::uint64_t streamKey, std::uint64_t totalFrames, std::uint64_t totalBytes,
		std::uint64_t frameIndex, const void* bytes, std::uint32_t size, bool keyframe) noexcept {
		const bool newStream = !hasStream || streamKey != lastStreamKey;
		Begin(probe.counterSeq);
		if(newStream){
			hasStream = true;
			lastStreamKey = streamKey;
			++generation;
			hasLatest = hasKeyframe = false;
			Invalidate(probe.latestFrame);
			Invalidate(probe.latestKeyframe);
		}
		probe.pid = pid;
		probe.flags = kCountersValid;
		probe.totalFrames = totalFrames;
		probe.totalBytes = totalBytes;
		probe.counterTickMs = nowMs;
		probe.generation = generation;
		End(probe.counterSeq);

		if(!bytes || size == 0){ return; }
		if(!hasLatest || Due(nowMs, latestTick)){
			Publish(probe.latestFrame, nowMs, frameIndex, bytes, size, keyframe);
			latestTick = nowMs;
			hasLatest = true;
		}
		if(keyframe && (!hasKeyframe || Due(nowMs, keyframeTick))){
			Publish(probe.latestKeyframe, nowMs, frameIndex, bytes, size, true);
			keyframeTick = nowMs;
			hasKeyframe = true;
		}
	}

private:
	static void Begin(std::atomic<std::uint64_t>& sequence) noexcept {
		sequence.fetch_add(1, std::memory_order_seq_cst);
	}
	static void End(std::atomic<std::uint64_t>& sequence) noexcept {
		sequence.fetch_add(1, std::memory_order_release);
	}
	static bool Due(std::uint64_t now, std::uint64_t previous) noexcept {
		// A clock regression is never interpreted as a huge elapsed interval.
		return now >= previous && now - previous >= kMinimumCaptureIntervalMs;
	}
	void Invalidate(FrameSlot& slot) noexcept {
		Begin(slot.sequence);
		slot.tickMs = 0;
		slot.generation = generation;
		slot.frameIndex = 0;
		slot.fullLength = slot.copiedLength = slot.flags = 0;
		slot.captureId = 0;
		End(slot.sequence);
	}
	void Publish(FrameSlot& slot, std::uint64_t nowMs, std::uint64_t frameIndex,
		const void* bytes, std::uint32_t size, bool keyframe) noexcept {
		const std::uint32_t copied = size < kPayloadCapacity ? size : kPayloadCapacity;
		Begin(slot.sequence);
		slot.tickMs = nowMs;
		slot.generation = generation;
		slot.frameIndex = frameIndex;
		slot.fullLength = size;
		slot.copiedLength = copied;
		slot.flags = kFrameValid | (size > kPayloadCapacity ? kFrameTruncated : 0u)
			| (keyframe ? kFrameKeyframe : 0u);
		slot.captureId = ++captureId;
		std::memcpy(slot.payload, bytes, copied);
		End(slot.sequence);
	}

	bool hasStream = false, hasLatest = false, hasKeyframe = false;
	std::uint64_t lastStreamKey = 0, generation = 0, captureId = 0;
	std::uint64_t latestTick = 0, keyframeTick = 0;
};

}} // namespace gxr::frameprobe
