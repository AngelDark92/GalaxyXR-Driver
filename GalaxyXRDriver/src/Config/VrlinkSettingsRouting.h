#pragma once
#include <algorithm>
#include <string>
#include <vector>

// 2026-11-06 Steam Link Galaxy XR routing (approved plan 20d64fee). The only
// supported client is the Steam Link Galaxy XR whose ORIGINAL handshake model
// is `xrvst2ue`; every other vrlink headset/streamer must keep its own
// settings. Therefore:
//   * tuning AND capability requests are written ONLY to the canonical
//     `vrlink_xrvst2ue` profile section (never to the shared `driver_vrlink`
//     section and never to a foreign `vrlink_<original model>` section);
//   * the old `driver_vrlink` / `vrlink_<other>` copies this driver wrote
//     earlier are restored through the existing journal (current == last
//     only; foreign, reserved and malformed entries are preserved);
//   * keys VRLink only reads from `driver_vrlink` (for example
//     automaticBandwidth/targetBandwidth) reach it through the epoch-gated
//     scoped read overlay on the shared IVRSettings getters
//     (Driver/Hooking/VrlinkSettingsHook.h), never through a persisted
//     global write.
// The `useGalaxyProfile` / `originalModel` parameters are kept so call sites
// and the profile switch (Sdr10BaselinePolicy::profileEnabled) stay source
// compatible; they no longer select a destination.
namespace gxr {
inline constexpr const char* kGalaxyProfileSection = "vrlink_xrvst2ue";
inline constexpr const char* kVrlinkGlobalSection = "driver_vrlink";
inline const char* VrlinkTuningSection(bool /*useGalaxyProfile*/) {
    return kGalaxyProfileSection;
}
inline std::string VrlinkCapabilitySection(bool /*useGalaxyProfile*/, const std::string& /*originalModel*/) {
    // NEVER vrlink_<foreign original model>: that section belongs to a
    // different headset/streamer.
    return kGalaxyProfileSection;
}
inline std::vector<std::string> VrlinkCapabilitySections(bool useGalaxyProfile, const std::string& originalModel) {
    return {VrlinkCapabilitySection(useGalaxyProfile, originalModel)};
}
inline std::vector<std::string> VrlinkTuningSections(bool useGalaxyProfile) {
    return {VrlinkTuningSection(useGalaxyProfile)};
}
inline bool IsVrlinkCapabilityKey(const std::string& key) {
    return key == "recommendedRenderWidth" || key == "recommendedRenderHeight"
        || key == "supports10bit" || key == "supportsEyeTracking"
        || key == "minStreamFormatWidth" || key == "maxStreamFormatWidth"
        || key == "minNonFoveatedStreamFormatWidth" || key == "maxNonFoveatedStreamFormatWidth";
}
// The enabled custom profile also carries the identity strings vrlink rewrites when it applies
// the section, so they follow the same routing as the capability keys.
inline bool IsVrlinkProfileIdentityKey(const std::string& key) {
    return key == "manufacturerName" || key == "modelNumber" || key == "trackingSystemName"
        || key == "controllerType" || key == "resourceRoot" || key == "inputProfilePath"
        || key == "serialNumber";
}
inline bool IsVrlinkTuningKey(const std::string& key) {
    return key == "encodeWidth" || key == "streamFormatWidth" || key == "automaticStreamFormatWidth"
        || key == "automaticBandwidth" || key == "recommendedBandwidthMbit" || key == "targetBandwidth"
        || key == "renderWidth" || key == "renderHeight" || key == "overrideRenderWidth"
        || key == "overrideRenderHeight" || key == "displayFrequency" || key == "debugRegionColoring"
        || key == "showAdvancedGraphs" || key == "force10bit" || key == "maxVideoQueueLatencyUs"
        || key == "backoffRecoveryCoefficient";
}
inline bool IsVrlinkReservedKey(const std::string& key) {
    return key == "enable" || key == "blocked_by_safe_mode" || key == "hasBeenRun";
}
inline bool IsVrlinkSettingsSection(const std::string& section) {
    return section == "driver_vrlink" || section.rfind("vrlink_", 0) == 0;
}
// Used ONLY for keys already present in this driver's recovery journal.
// Every vrlink section except the canonical profile is legacy for this driver:
// restore (current == last is enforced by the journal) anything we wrote there
// before, and never touch reserved lifecycle keys. Foreign sections that this
// driver never journaled are not in the journal and therefore never selected.
inline bool ShouldRestoreInactiveVrlinkKey(const std::string& section, const std::string& key,
    bool /*useGalaxyProfile*/, const std::string& /*originalModel*/) {
    if(!IsVrlinkSettingsSection(section) || IsVrlinkReservedKey(key)) return false;
    return section != kGalaxyProfileSection;
}
} // namespace gxr
