// 2026-09-25: execute the production settings orchestration with fake writers.
// Tests ordering and reload decisions only; never accesses SteamVR or user files.
#include "../src/Config/Config.h"
#include "../src/Config/SdrColorPolicy.h"
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
    values["renderWidth"] = driverConfig.galaxyXr.nativeResolution ? 3552 : 0;
}
void ApplyStreamQualitySetting() {
    calls += 'S';
    values["targetBandwidth"] = driverConfig.galaxyXr.customBandwidthMbit;
    values["streamFormatWidth"] = driverConfig.galaxyXr.customStreamFormatWidth;
}
void ApplyHeadsetProfileSetting(const std::string&, const gxr::Sdr10BaselinePolicy& policy) {
    calls += 'P';
    values["supports10bit"] = policy.profileSupports10bit;
}
void ApplyVrlinkExtraKeys() {
    calls += 'E';
    values["maxVideoQueueLatencyUs"] = driverConfig.galaxyXr.vrlinkMaxVideoQueueLatencyUs;
    values["backoffRecoveryCoefficient"] = driverConfig.galaxyXr.vrlinkBackoffRecoveryCoefficient;
    for(const auto& entry : driverConfig.galaxyXr.vrlinkExtraKeys) {
        if(std::get<1>(entry) == 'x') values.erase(std::get<0>(entry));
        else values[std::get<0>(entry)] = std::get<2>(entry);
    }
}

struct PriorityShim {
    bool active = true;
    std::string origModelNumber = "xrvst2ue";
    bool appliedProfileRoute = true;
    bool appliedNativeResolution = false;
    bool appliedHeadsetProfile = false;
    int appliedProfileMaxSfw = 0;
    bool appliedProfile10bit = false;
    bool appliedDebugOverlay = false;
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

void CheckOverrides(const char* label, double renderWidth = 4000) {
    Check(values["renderWidth"] == renderWidth, std::string(label) + ": explicit geometry wins");
    Check(values["targetBandwidth"] == 900, std::string(label) + ": explicit stream budget wins");
    Check(values["supports10bit"] == 0, std::string(label) + ": explicit profile value wins");
    Check(values.count("streamFormatWidth") == 0, std::string(label) + ": explicit removal wins");
    Check(!calls.empty() && calls.back() == 'E', std::string(label) + ": extras applied last");
}

int main() {
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
    EarlySettingsForTest();
    Check(calls == "RNSPE", "startup writes standard settings before explicit overrides");
    CheckOverrides("startup");

    PriorityShim shim;
    calls.clear();
    shim.ActivateSettings();
    Check(calls == "RNSPE", "activation preserves startup ordering");
    CheckOverrides("activation");
    calls.clear(); shim.RunFrameSettings();
    Check(calls.empty(), "unchanged active frame does not rewrite settings");

    config.nativeResolution = false;
    calls.clear(); shim.RunFrameSettings();
    Check(calls == "NE", "geometry-only change reapplies unchanged explicit overrides");
    CheckOverrides("geometry reload");

    config.customBandwidthMbit = 450;
    calls.clear(); shim.RunFrameSettings();
    Check(calls == "SE", "stream-only change reapplies unchanged explicit overrides");
    CheckOverrides("bandwidth reload");

    config.profileSupports10bit = false;
    calls.clear(); shim.RunFrameSettings();
    Check(calls == "PE", "profile-only change reapplies unchanged explicit overrides");
    CheckOverrides("profile reload");

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

    shim.active = false;
    config.nativeResolution = true; config.customBandwidthMbit = 500;
    calls.clear(); shim.RunFrameSettings();
    Check(calls.empty(), "inactive shim never writes changed settings");
    std::cout << "VRLink extra-key priority: " << checks << " checks, " << failures << " failures\n";
    return failures ? 1 : 0;
}
