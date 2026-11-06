#pragma once
// Test double for src/Driver/GalaxyLinkEpoch.h (same gxr::galaxylink interface).
// Selected through GXR_GALAXYLINK_EPOCH_HEADER so the vendor NvencTap path can be
// tested independently of the real epoch implementation.
#include <cstddef>
#include <cstdint>

namespace gxr::galaxylink {
namespace mock {
inline uint64_t epoch = 0;          // 0 = no admitted link
inline bool vrlinkCaller = true;    // IsVrlinkAddress answer
inline int observeCalls = 0;
inline char lastFormat[256] = {};
inline char lastText[512] = {};
inline size_t lastLength = 0;
}
inline uint64_t CurrentEpoch() noexcept { return mock::epoch; }
inline void ObserveLog(const char* format, const char* formatted, size_t length) noexcept {
	mock::observeCalls++;
	size_t i = 0; for(; format && format[i] && i < sizeof(mock::lastFormat) - 1; i++){ mock::lastFormat[i] = format[i]; } mock::lastFormat[i] = 0;
	size_t j = 0; for(; formatted && j < length && j < sizeof(mock::lastText) - 1; j++){ mock::lastText[j] = formatted[j]; } mock::lastText[j] = 0;
	mock::lastLength = length;
}
inline bool BeginHmd(void*, const void*) noexcept { return false; }
inline void ConfirmHmd(uint32_t, bool) noexcept {}
inline void ObservePose(uint32_t, bool) noexcept {}
inline void Close() noexcept { mock::epoch = 0; }
inline bool IsVrlinkAddress(const void*) noexcept { return mock::vrlinkCaller; }
inline bool IsAdmittedDevice(uint32_t) noexcept { return false; }
}
