#pragma once
#include <cstddef>
#include <cstdint>
#include <cstring>

// ============================================================================
// VrlinkSignature — version-tolerant locator for Valve's vrlink typed-value
// publish entry point (driver_vrlink.dll).
//
// 2026-10-25: the previous gate compared an exact SHA-256 and two fixed RVAs.
// SteamVR 2.18.4 moved the functions (0xA51D80 -> 0xA577C0, 0xA50530 ->
// 0xA55F70) while keeping the machine code intact, so every SteamVR update
// could disable Async Spacewarp even though the code was unchanged. This
// locator resolves the public thunk and its worker from their structure:
//
//   1. exactly one 12-byte public-thunk prefix:
//        movzx eax, byte [rsp+0x28]; add eax, eax;
//        mov [rsp+0x28], eax; jmp rel32
//   2. the rel32 target is inside the executable section;
//   3. exactly one worker prologue:
//        mov [rsp+0x10], edx; push rbp/rsi/r12/r14/r15;
//        lea rbp, [rsp-0x2f]
//   4. the thunk target equals that worker;
//   5. the worker still carries the ValueTransport admission guards:
//        cmp edx, imm8 (id <= 0x74, so carrier 0x48 is valid)
//        cmp r31d/r9d, 0x800000 (size guard)
//
// Nothing here compares a build hash, a fixed RVA or a caller count. The
// caller count changed from 32 to 36 in the same update and is evidence only.
// The function is pure: the caller supplies the mapped executable section and
// validates readability/bounds first. Any failure is a refusal, never a
// guessed hook.
// ============================================================================

namespace VrlinkSignature {

// Public thunk prefix. The 12th byte is the E9 opcode; the rel32 follows it.
inline constexpr unsigned char kImplPrefix[12] = {
	0x0F, 0xB6, 0x44, 0x24, 0x28, 0x03, 0xC0, 0x89, 0x44, 0x24, 0x28, 0xE9};

// Worker prologue (first 16 bytes; the function continues after).
inline constexpr unsigned char kWorkerPrologue[16] = {
	0x89, 0x54, 0x24, 0x10, 0x55, 0x56, 0x41, 0x54, 0x41, 0x56, 0x41, 0x57,
	0x48, 0x8D, 0x6C, 0x24};

struct Result {
	bool ok = false;
	const char* reason = "not-run";
	uint32_t implRva = 0;
	uint32_t workerRva = 0;
	uint32_t callerCount = 0;
};

inline size_t FindUnique(const unsigned char* data, size_t size,
	const unsigned char* pattern, size_t patternSize, size_t* count){
	*count = 0;
	if(data == nullptr || pattern == nullptr || patternSize == 0 || size < patternSize){
		return 0;
	}
	size_t first = 0;
	size_t found = 0;
	const size_t last = size - patternSize;
	for(size_t i = 0; i <= last; ++i){
		if(data[i] != pattern[0]){ continue; }
		if(std::memcmp(data + i, pattern, patternSize) == 0){
			if(found == 0){ first = i; }
			++found;
			if(found > 1){ break; } // only uniqueness matters
		}
	}
	*count = found;
	return first;
}

inline bool HasIdGuard(const unsigned char* data, size_t size, size_t workerOffset){
	// The worker's second argument is ValueTransportID (edx). Accept the
	// compiler's imm8 and imm32 forms, and only an immediate that admits the
	// 0x48 carrier.
	const size_t limit = workerOffset + 0x60;
	for(size_t i = workerOffset; i < limit && i + 3 <= size; ++i){
		if(data[i] == 0x83 && data[i + 1] == 0xFA && data[i + 2] >= 0x48){
			return true;
		}
		if(data[i] == 0x81 && data[i + 1] == 0xFA && i + 6 <= size){
			uint32_t immediate = 0;
			std::memcpy(&immediate, data + i + 2, sizeof(immediate));
			if(immediate >= 0x48){ return true; }
		}
	}
	return false;
}

inline bool HasSizeGuard(const unsigned char* data, size_t size, size_t workerOffset){
	// The worker rejects size > 0x800000. The audited forms are
	// 41 81 FF 00 00 80 00 (cmp r15d, 0x800000) and 41 81 F9 ... (cmp r9d).
	const unsigned char immediate[4] = {0x00, 0x00, 0x80, 0x00};
	const size_t limit = workerOffset + 0x60;
	for(size_t i = workerOffset; i < limit && i + 6 <= size; ++i){
		if(data[i] == 0x41 && data[i + 1] == 0x81
			&& (data[i + 2] == 0xFF || data[i + 2] == 0xF9)
			&& std::memcmp(data + i + 3, immediate, sizeof(immediate)) == 0){
			return true;
		}
		if((data[i] == 0x81 || data[i] == 0x3D)
			&& (data[i + 1] == 0xFF || data[i + 1] == 0xF9)
			&& i + 6 <= size
			&& std::memcmp(data + i + 2, immediate, sizeof(immediate)) == 0){
			return true;
		}
	}
	return false;
}

inline uint32_t CountCallers(const unsigned char* data, size_t size, uint32_t sectionRva, uint32_t implRva){
	uint32_t callers = 0;
	if(data == nullptr || size < 5){ return 0; }
	for(size_t i = 0; i + 5 <= size; ++i){
		if(data[i] != 0xE8){ continue; }
		int32_t rel = 0;
		std::memcpy(&rel, data + i + 1, sizeof(rel));
		const int64_t target = static_cast<int64_t>(sectionRva) + static_cast<int64_t>(i) + 5 + rel;
		if(target == static_cast<int64_t>(implRva)){ ++callers; }
	}
	return callers;
}

// `data` is the first byte of one executable section mapped at `sectionRva`;
// `size` is that section's virtual size; `imageSize` is SizeOfImage.
inline Result Resolve(const unsigned char* data, size_t size, uint32_t sectionRva, uint32_t imageSize){
	Result result;
	if(data == nullptr || size < 0x40){
		result.reason = "section-too-small";
		return result;
	}
	if(sectionRva > imageSize || size > imageSize - sectionRva){
		result.reason = "section-out-of-image";
		return result;
	}

	size_t implCount = 0;
	const size_t implOffset = FindUnique(data, size, kImplPrefix, sizeof(kImplPrefix), &implCount);
	if(implCount == 0){
		result.reason = "impl-not-found";
		return result;
	}
	if(implCount > 1){
		result.reason = "impl-ambiguous";
		return result;
	}
	if(implOffset + 16 > size){
		result.reason = "impl-tail-truncated";
		return result;
	}

	size_t workerCount = 0;
	const size_t workerOffset = FindUnique(data, size, kWorkerPrologue, sizeof(kWorkerPrologue), &workerCount);
	if(workerCount == 0){
		result.reason = "worker-not-found";
		return result;
	}
	if(workerCount > 1){
		result.reason = "worker-ambiguous";
		return result;
	}
	if(workerOffset + 0x60 > size){
		result.reason = "worker-truncated";
		return result;
	}

	int32_t relative = 0;
	std::memcpy(&relative, data + implOffset + 12, sizeof(relative));
	const int64_t target = static_cast<int64_t>(sectionRva) + static_cast<int64_t>(implOffset) + 16 + relative;
	if(target < 0 || target > 0xFFFFFFFFll){
		result.reason = "worker-target-out-of-range";
		return result;
	}
	const uint32_t targetRva = static_cast<uint32_t>(target);
	const uint32_t expectedRva = sectionRva + static_cast<uint32_t>(workerOffset);
	if(targetRva != expectedRva){
		result.reason = "worker-target-mismatch";
		return result;
	}
	if(!HasIdGuard(data, size, workerOffset)){
		result.reason = "worker-id-guard-missing";
		return result;
	}
	if(!HasSizeGuard(data, size, workerOffset)){
		result.reason = "worker-size-guard-missing";
		return result;
	}

	result.ok = true;
	result.reason = "resolved";
	result.implRva = sectionRva + static_cast<uint32_t>(implOffset);
	result.workerRva = targetRva;
	result.callerCount = CountCallers(data, size, sectionRva, result.implRva);
	return result;
}

} // namespace VrlinkSignature
