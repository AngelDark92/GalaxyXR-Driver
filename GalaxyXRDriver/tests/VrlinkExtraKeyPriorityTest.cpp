// 2026-09-25: execute the production settings orchestration with fake writers.
// Tests ordering and reload decisions only; never accesses SteamVR or user files.
#include "../src/Config/Config.h"
#include "../src/Config/SdrColorPolicy.h"
#include "../src/Config/VrlinkSettingsRouting.h"
#include "openvr_driver.h"
#include <cstdlib>
#include <iostream>
#include <map>
#include <string>

Config driverConfig;
namespace {
int checks = 0, failures = 0;
std::map<std::string, double> values;
std::string calls;
void Check(bool condition, const std::string& message) {
    ++checks;
    if(!condition) { ++failures; std::cerr << "FAIL: " << message << '\n'; }
}
}

// Fake writers represent the overlapping keys owned by their production
// counterparts. The generated header retains the production callers verbatim.
void DriverLog(const char*, ...) {}
void RestoreInactiveVrlinkSettings(const std::string&) { calls += 'R'; }
void ProbeVrlinkPaths() {}
int GalaxyXR_EffectiveTileWidth() { return driverConfig.galaxyXr.customStreamFormatWidth; }
gxr::Sdr10BaselinePolicy ResolveSdr10PolicyLocked() { return gxr::ResolveSdr10Policy(driverConfig); }
void ApplyNativeResolutionSetting() {
    calls += 'N';
    values["renderWidth"] = driverConfig.galaxyXr.nativeResolution ? driverConfig.galaxyXr.renderWidth : 0;
    values["renderHeight"] = driverConfig.galaxyXr.nativeResolution ? driverConfig.galaxyXr.renderHeight : 0;
}
void ApplyStreamQualitySetting() {
    calls += 'S';
    values["targetBandwidth"] = driverConfig.galaxyXr.customBandwidthMbit;
    values["streamFormatWidth"] = driverConfig.galaxyXr.customStreamFormatWidth;
}
void ApplyHeadsetProfileSetting(const std::string&, const gxr::Sdr10BaselinePolicy& policy) {
    calls += 'P';
    values["supports10bit"] = policy.profileSupports10bit;
    values["debugRegionColoring"] = driverConfig.galaxyXr.vrlinkDebugOverlay;
    values["showAdvancedGraphs"] = driverConfig.galaxyXr.vrlinkDebugOverlay;
}
namespace gxrsettings {
void SetInt32(const char*, const char* key, int32_t value) { values[key] = value; }
void SetFloat(const char*, const char* key, float value) { values[key] = value; }
void SetBool(const char*, const char* key, bool value) { values[key] = value; }
void RestoreOwnedKey(const char*, const char* key) { values.erase(key); }
void RemoveKeyInSection(const char*, const char* key, vr::EVRSettingsError* error) { values.erase(key); *error = vr::VRSettingsError_None; }
}
void SetBoolIfDifferent(const char*, const char* key, bool value) { values[key] = value; }
// Execute the production extra-key policy; only its external writers are fake.
#include "VrlinkExtraKeysWriter.generated.h"
void ApplyVrlinkExtraKeys() { calls += 'E'; ApplyVrlinkExtraKeysIn("driver_vrlink"); }

struct PriorityShim {
    bool active = true;
    std::string origModelNumber = "xrvst2ue";
    bool appliedProfileRoute = true;
    bool appliedNativeResolution = false;
    int appliedRenderWidth = 0, appliedRenderHeight = 0;
    bool appliedHeadsetProfile = false;
    int appliedProfileMaxSfw = 0;
    bool appliedProfile10bit = false;
    bool appliedDebugOverlay = false;
    bool appliedDebugMode = false;
    std::string appliedStreamQuality;
    int appliedCustomEncodeWidth = 0, appliedCustomStreamFormatWidth = 0, appliedCustomBandwidthMbit = 0;
    int appliedBandwidthOverride = 0;
    std::vector<std::tuple<std::string, char, double>> appliedExtraKeys;
    int appliedMaxVqLat = 0;
    double appliedBackoffCoef = 0;
    void ActivateSettings();
    void RunFrameSettings();
};

#include "VrlinkExtraKeysControlFlow.generated.h"

void CheckOverrides(const char* label, double renderWidth = 4000, bool expectWrite = true) {
    Check(values["renderWidth"] == renderWidth, std::string(label) + ": explicit geometry wins");
    Check(values["targetBandwidth"] == 900, std::string(label) + ": explicit stream budget wins");
    Check(values["supports10bit"] == 0, std::string(label) + ": explicit profile value wins");
    Check(values.count("streamFormatWidth") == 0, std::string(label) + ": explicit removal wins");
    if(expectWrite) Check(!calls.empty() && calls.back() == 'E', std::string(label) + ": extras applied last");
}

void CheckOverlay(bool regions, bool graphs, const char* label) {
    Check(values.count("debugRegionColoring") == 1 && values.at("debugRegionColoring") == (regions ? 1.0 : 0.0),
        std::string(label) + ": region coloring has the effective explicit boolean");
    Check(values.count("showAdvancedGraphs") == 1 && values.at("showAdvancedGraphs") == (graphs ? 1.0 : 0.0),
        std::string(label) + ": advanced graphs have the effective explicit boolean");
}

void CheckOverlayRemoved(const char* label) {
    Check(values.count("debugRegionColoring") == 0 && values.count("showAdvancedGraphs") == 0,
        std::string(label) + ": explicit overlay removals win");
    Check(!calls.empty() && calls.back() == 'E', std::string(label) + ": extras applied last");
}

int main() {
    driverConfig.debugMode = true;
    auto& config = driverConfig.galaxyXr;
    config.nativeResolution = true;
    config.streamQuality = "custom";
    config.customStreamFormatWidth = 1536;
    config.customBandwidthMbit = 350;
    config.profileSupports10bit = true;
    config.vrlinkExtraKeys = {
        { "renderWidth", 'i', 4000 }, { "targetBandwidth", 'i', 900 },
        { "supports10bit", 'b', 0 }, { "streamFormatWidth", 'x', 0 }
    };
    // The orchestration must publish OFF even when the previous session was ON.
    // This fake-writer test covers orchestration, not journal restoration.
    values["debugRegionColoring"] = values["showAdvancedGraphs"] = 1;
    EarlySettingsForTest();
    Check(calls == "RNSPE", "startup writes standard settings before explicit overrides");
    CheckOverrides("startup");
    CheckOverlay(false, false, "startup overlay OFF");

    PriorityShim shim;
    calls.clear();
    shim.ActivateSettings();
    Check(calls == "RNSPE", "activation preserves startup ordering");
    CheckOverrides("activation");
    CheckOverlay(false, false, "activation overlay OFF");
    calls.clear(); shim.RunFrameSettings();
    Check(calls.empty(), "unchanged active frame does not rewrite settings");

    config.renderWidth = 2880;
    calls.clear(); shim.RunFrameSettings();
    Check(calls == "NE", "width-only edit reapplies resolution before expert overrides");
    CheckOverrides("manual width reload");
    config.renderHeight = 3200;
    calls.clear(); shim.RunFrameSettings();
    Check(calls == "NE", "height-only edit reapplies resolution before expert overrides");
    Check(values["renderHeight"] == 3200, "manual height reaches the resolution writer");
    calls.clear(); shim.RunFrameSettings();
    Check(calls.empty(), "unchanged manual dimensions do not rewrite settings");

    config.nativeResolution = false;
    calls.clear(); shim.RunFrameSettings();
    Check(calls == "NE", "geometry-only change reapplies unchanged explicit overrides");
    CheckOverrides("geometry reload");

    config.customBandwidthMbit = 450;
    calls.clear(); shim.RunFrameSettings();
    Check(calls == "SE", "stream-only change reapplies unchanged explicit overrides");
    CheckOverrides("bandwidth reload");

    config.sdr10Baseline = true;
    calls.clear(); shim.RunFrameSettings();
    Check(calls.empty(), "baseline ON retains the already effective explicit 10-bit request without rewriting");
    CheckOverrides("profile reload", 4000, false);

    config.sdr10Baseline = false;
    calls.clear(); shim.RunFrameSettings();
    Check(calls.empty(), "baseline OFF retains the explicit 10-bit request without rewriting");
    CheckOverrides("baseline off reload", 4000, false);

    config.customStreamFormatWidth = 2048;
    calls.clear(); shim.RunFrameSettings();
    Check(calls == "PSE", "tile change writes profile and stream before overrides");
    CheckOverrides("tile reload");

    config.vrlinkHeadsetProfile = false;
    calls.clear(); shim.RunFrameSettings();
    Check(calls == "RNPSE", "route change rewrites normal destinations before overrides");
    CheckOverrides("route reload");

    std::get<2>(config.vrlinkExtraKeys.front()) = 4200;
    calls.clear(); shim.RunFrameSettings();
    Check(calls == "E", "extra-key-only edit applies once without other settings changes");
    CheckOverrides("extra-key edit", 4200);

    config.vrlinkMaxVideoQueueLatencyUs = 20000;
    calls.clear(); shim.RunFrameSettings();
    Check(calls == "E" && values["maxVideoQueueLatencyUs"] == 20000, "latency-only change reaches extra writer");
    config.vrlinkBackoffRecoveryCoefficient = 0.75;
    calls.clear(); shim.RunFrameSettings();
    Check(calls == "E" && values["backoffRecoveryCoefficient"] == 0.75, "backoff-only change reaches extra writer");

    // 2026-09-25: the overlay switch is independent of the baseline and route,
    // but an explicit expert value/removal remains authoritative after reload.
    config.vrlinkDebugOverlay = true;
    calls.clear(); shim.RunFrameSettings();
    Check(calls == "PE", "overlay ON reapplies profile then expert overrides");
    CheckOverlay(true, true, "overlay ON");
    config.vrlinkDebugOverlay = false;
    calls.clear(); shim.RunFrameSettings();
    Check(calls == "PE", "overlay OFF reapplies profile then expert overrides");
    CheckOverlay(false, false, "overlay OFF");

    const auto overlayExtraStart = config.vrlinkExtraKeys.size();
    config.vrlinkExtraKeys.emplace_back("debugRegionColoring", 'b', 1);
    config.vrlinkExtraKeys.emplace_back("showAdvancedGraphs", 'b', 0);
    calls.clear(); shim.RunFrameSettings();
    Check(calls == "E", "overlay expert values apply without a toggle change");
    CheckOverlay(true, false, "expert true/false over overlay OFF");
    config.vrlinkDebugOverlay = true;
    calls.clear(); shim.RunFrameSettings();
    Check(calls == "PE", "overlay ON retains unchanged expert values");
    CheckOverlay(true, false, "expert true/false over overlay ON");

    std::get<2>(config.vrlinkExtraKeys[overlayExtraStart]) = 0;
    std::get<2>(config.vrlinkExtraKeys[overlayExtraStart + 1]) = 1;
    calls.clear(); shim.RunFrameSettings();
    Check(calls == "E", "opposite overlay expert values apply immediately");
    CheckOverlay(false, true, "expert false/true over overlay ON");
    config.vrlinkDebugOverlay = false;
    calls.clear(); shim.RunFrameSettings();
    Check(calls == "PE", "overlay OFF retains unchanged expert values");
    CheckOverlay(false, true, "expert false/true over overlay OFF");

    std::get<1>(config.vrlinkExtraKeys[overlayExtraStart]) = 'x';
    std::get<1>(config.vrlinkExtraKeys[overlayExtraStart + 1]) = 'x';
    calls.clear(); shim.RunFrameSettings();
    Check(calls == "E", "overlay expert removals apply immediately");
    CheckOverlayRemoved("expert removal over overlay OFF");
    config.vrlinkDebugOverlay = true;
    calls.clear(); shim.RunFrameSettings();
    Check(calls == "PE", "overlay ON reapplies unchanged expert removals");
    CheckOverlayRemoved("expert removal over overlay ON");
    config.vrlinkHeadsetProfile = true;
    calls.clear(); shim.RunFrameSettings();
    Check(calls == "RNPSE", "route change reapplies unchanged overlay removals");
    CheckOverlayRemoved("expert removal after route change");
    CheckOverrides("overlay route reload", 4200);

    // The normal overlay is false in both snapshots: the master transition
    // still must suppress expert overlay values and then restore their choices.
    config.vrlinkDebugOverlay = false;
    config.vrlinkExtraKeys[overlayExtraStart] = {"debugRegionColoring", 'b', 1};
    config.vrlinkExtraKeys[overlayExtraStart + 1] = {"showAdvancedGraphs", 'b', 1};
    calls.clear(); shim.RunFrameSettings();
    CheckOverlay(true, true, "expert overlay before master OFF");
    const auto selectedExtras = config.vrlinkExtraKeys;
    driverConfig.debugMode = false;
    calls.clear(); shim.RunFrameSettings();
    Check(calls == "PE", "master OFF invalidates unchanged effective overlay cache");
    CheckOverlay(false, false, "master OFF overrides expert overlays");
    Check(config.vrlinkExtraKeys == selectedExtras, "master OFF preserves expert selections");
    driverConfig.debugMode = true;
    calls.clear(); shim.RunFrameSettings();
    Check(calls == "PE", "master ON reapplies stored expert choices");
    CheckOverlay(true, true, "master ON restores expert overlays");

    shim.active = false;
    config.nativeResolution = true; config.customBandwidthMbit = 500;
    calls.clear(); shim.RunFrameSettings();
    Check(calls.empty(), "inactive shim never writes changed settings");
    std::cout << "VRLink extra-key priority: " << checks << " checks, " << failures << " failures\n";
    return failures ? 1 : 0;
}
