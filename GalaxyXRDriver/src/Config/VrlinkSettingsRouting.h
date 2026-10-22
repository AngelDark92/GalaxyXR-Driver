#pragma once
#include <algorithm>
#include <string>
#include <vector>

// UI profile enablement selects additional profile destinations, independently
// from Sdr10BaselinePolicy::profileEnabled (the baseline can request 10-bit
// capabilities even when the saved profile switch is off).
namespace gxr {
inline constexpr const char* kGalaxyProfileSection = "vrlink_xrvst2ue";
inline const char* VrlinkTuningSection(bool /*useGalaxyProfile*/) {
    return "driver_vrlink";
}
inline std::string VrlinkCapabilitySection(bool useGalaxyProfile, const std::string& originalModel) {
    // OFF preserves the previous per-model capability/baseline destination.
    return useGalaxyProfile ? kGalaxyProfileSection : "vrlink_" + (originalModel.empty() ? "xrvst2ue" : originalModel);
}
// 2026-10-21: the Steam Link client reports a single identity (`xrvst2ue`), so
// the Galaxy profile section is the only additional destination. The former
// Quest Pro / PICO 4 Pro alias mirrors are gone.
inline std::vector<std::string> VrlinkCapabilitySections(bool useGalaxyProfile, const std::string& originalModel) {
    if(useGalaxyProfile)
        return {kGalaxyProfileSection};
    return {VrlinkCapabilitySection(false, originalModel)};
}
inline std::vector<std::string> VrlinkTuningSections(bool useGalaxyProfile) {
    // 2026-09-23: installed VRLink reads tuning from driver_vrlink, and known
    // Quest/PICO identities bypass the unknown-model profile loader entirely.
    // Retain the requested mirrors without removing the consumed global keys.
    auto sections = useGalaxyProfile ? VrlinkCapabilitySections(true, "") : std::vector<std::string>{};
    sections.insert(sections.begin(), VrlinkTuningSection(useGalaxyProfile));
    return sections;
}
inline bool IsVrlinkCapabilityKey(const std::string& key) {
    return key == "recommendedRenderWidth" || key == "recommendedRenderHeight"
        || key == "supports10bit" || key == "supportsEyeTracking"
        || key == "minStreamFormatWidth" || key == "maxStreamFormatWidth"
        || key == "minNonFoveatedStreamFormatWidth" || key == "maxNonFoveatedStreamFormatWidth";
}
// The enabled custom profile also carries the identity strings vrlink rewrites when it applies
// the section, so they follow the same active/inactive routing as the capability keys.
inline bool IsVrlinkProfileIdentityKey(const std::string& key) {
    return key == "manufacturerName" || key == "modelNumber" || key == "trackingSystemName"
        || key == "controllerType" || key == "resourceRoot" || key == "inputProfilePath";
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
// Include historical expert keys even if they are no longer in the current UI.
inline bool ShouldRestoreInactiveVrlinkKey(const std::string& section, const std::string& key,
    bool useGalaxyProfile, const std::string& originalModel) {
    if(!IsVrlinkSettingsSection(section) || IsVrlinkReservedKey(key)) return false;
    if(IsVrlinkCapabilityKey(key) || IsVrlinkProfileIdentityKey(key)) {
        // Before HMD activation, an OFF route does not yet know the patched
        // model. Do not remove its previous profile using a guessed fallback.
        if(!useGalaxyProfile && originalModel.empty()) return false;
        const auto sections = VrlinkCapabilitySections(useGalaxyProfile, originalModel);
        return std::find(sections.begin(), sections.end(), section) == sections.end();
    }
    const auto sections = VrlinkTuningSections(useGalaxyProfile);
    return std::find(sections.begin(), sections.end(), section) == sections.end();
}
} // namespace gxr
