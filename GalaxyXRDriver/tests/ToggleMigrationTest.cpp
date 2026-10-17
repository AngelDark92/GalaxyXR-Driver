// Execute the actual ConfigLoader parser against build-only fixtures. Each
// process models a fresh install; the runner never reads live settings.
#include "Config/Config.h"
#include "Config/SdrColorPolicy.h"
#include "Config/DebugModePolicy.h"
#include "Config/GameLinkLayoutPolicy.h"
#include "Config/StreamTiers.h"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <mutex>
#include <limits>
using json = nlohmann::json;
Config driverConfig, driverConfigOld;
std::mutex driverConfigLock;
bool hasLoggedConfigFileNotFound = false;
std::string testFolder;
std::string GetConfigFolder() { return testFolder; }
void DriverLog(const char*, ...) {}
#include "ParseConfig.generated.h"
int checks = 0, failures = 0;
void Check(bool condition, const char* label) {
    ++checks;
    if (!condition) { ++failures; std::cerr << "FAIL: " << label << '\n'; }
}
int main(int argc, char** argv) {
    if (argc != 3) return 2;
    testFolder = std::string(argv[1]) + "/";
    std::filesystem::create_directories(testFolder);
    const int scenario = std::stoi(argv[2]);
    json input = {{"streamFrame", {{"streamFrameSchema",4},{"nvencSettingsVersion",3}}},
        {"galaxyXr", {{"sdr10SettingsVersion",2}}}};
    auto &sf = input["streamFrame"];
    const json customTuning = {
        {"nvencVbvFrames",5},{"nvencLowDelayKfScale",4},{"nvencMaxBitrateHeadroomPct",20},
        {"nvencForceFps",72},{"nvencSplitMode",3},{"nvencPreset",7},{"nvencAqStrength",4},
        {"nvencMinQp",5},{"nvencMinQpIntra",7},{"nvencMaxQp",31},{"nvencVuiFullRange",1},
        {"nvencVuiMatrix",1},{"nvencVuiPrimaries",1},{"nvencVuiTransfer",1},
        {"nvencBitrateMbit",123},{"nvencBandwidthOverrideMbit",234},
    };
    const json h264Tuning = {
        {"nvencFillerDataInsertion",true},{"nvencH264GopFrames",144},{"nvencH264IdrFrames",288},
        {"nvencH264RefFrames",2},{"nvencH264Entropy",2},{"nvencH264SliceMode",0},
        {"nvencH264SliceData",12},{"nvencH264Aud",false},{"nvencH264RepeatHeaders",false},
        {"nvencH264DisableHeaders",true},{"nvencH264BitstreamRestriction",false},
        {"nvencH264VbvInitialDelay",12345},{"nvencMultiPass",2},
    };
    const bool customUpgrade = scenario == 0 || scenario == 7 || scenario == 8 || scenario == 14;
    const char* toggles[] = {"nvencTap", "nvencFixLevel", "nvencForceCbr", "nvencBitrateScale", "nvencPresetMerge"};
    if (customUpgrade) {
        sf["nvencSettingsVersion"] = scenario == 14 ? 3 : scenario == 7 ? 4 : 0;
        for (auto key : toggles) sf[key] = false;
        input["galaxyXr"]["vrlinkHeadsetProfile"] = false;
        input["galaxyXr"]["customStreamFormatWidth"] = 1856;
        sf.update(customTuning);
        sf["postPack"] = {{"enable",false},{"casEnable",false}};
        if (scenario == 8) std::ofstream(testFolder + "nvenc-settings-v4.migrated") << "4";
    } else if (scenario == 1) {
        sf["nvencSettingsVersion"] = 0;
    } else if (scenario == 2 || scenario == 3) {
        sf["cas"] = {{"enable",false}};
        sf["postPack"] = {{"limitedRange",scenario == 3}};
    } else if (scenario == 4 || scenario == 5) {
        sf["cas"] = {{"enable",true},{"strength",0.87}};
        if (scenario == 5) sf["postPack"] = {{"enable",false},{"casEnable",false}};
    } else if (scenario == 6) {
        sf["postPack"] = {{"casEnable",false},{"limitedRange",true}};
    } else if (scenario >= 9 && scenario <= 11) {
        sf["nvencSettingsVersion"] = 4;
        input["debugMode"] = scenario == 11;
        if (scenario != 9) sf["hitchDiag"] = scenario == 11;
    } else if (scenario == 12) {
        // An explicitly saved legacy stock-encoder profile is still a user
        // choice on direct upgrade, even though Clean Settings now resets it.
        sf["nvencSettingsVersion"] = 4;
        for (auto key : toggles) sf[key] = false;
        for (auto key : {"nvencVbvFrames", "nvencLowDelayKfScale", "nvencForceFps", "nvencSplitMode"}) sf[key] = 0;
        sf["postPack"] = {{"enable",false},{"casEnable",false}};
    } else if (scenario == 13) {
        input = json::object(); // Fresh installation before any GUI/runtime save.
    } else if (scenario == 15) {
        // Rust Clean Settings replaces old configuration with this payload
        // and removes its migration marker transactionally. The native parser
        // must also discard any previous in-memory picture/calibration state.
        input = {{"galaxyXr", {{"nativeIdentity",true}}}};
        Check(!std::filesystem::exists(testFolder + "nvenc-settings-v4.migrated"), "reset starts without a stale migration marker");
        driverConfig.galaxyXr.nativeIdentity = false;
        driverConfig.galaxyXr.nativeResolution = false;
        driverConfig.galaxyXr.sdr10Baseline = true;
        driverConfig.streamFrame.nvencTap = false;
        driverConfig.streamFrame.nvencFixLevel = false;
        driverConfig.streamFrame.nvencForceCbr = false;
        driverConfig.streamFrame.nvencBitrateScale = false;
        driverConfig.streamFrame.nvencPresetMerge = false;
        driverConfig.streamFrame.nvencVbvFrames = 5;
        driverConfig.streamFrame.nvencPreset = 7;
        driverConfig.streamFrame.nvencAqStrength = 4;
        driverConfig.streamFrame.nvencBitrateMbit = 123;
        driverConfig.streamFrame.postPack.enable = false;
        driverConfig.streamFrame.postPack.casEnable = false;
        driverConfig.streamFrame.postPack.limitedRange = true; // pre-set ON: the reset payload must discard it (owner directive 2026-10-17)
        driverConfig.streamFrame.enable = false; // pre-set OFF: reset must discard it and apply the new ON default (owner directive 2026-10-17)
        driverConfig.streamFrame.gamma = 1.3;
        driverConfig.streamFrame.brightness = 0.2;
        driverConfig.streamFrame.saturation = 87;
        driverConfig.streamFrame.calib.blackout = true;
        driverConfig.streamFrame.calib.captureMode = true;
        driverConfig.streamFrame.calib.pattern = 4;
        driverConfig.streamFrame.eyeGaze.debugGrid = true;
        driverConfig.streamFrame.eyeGaze.calibDot = true;
        driverConfig.streamFrame.eyeGaze.probeCapture = true;
        driverConfig.customShader.enable = true;
    } else if (scenario >= 16 && scenario <= 19) {
        sf["nvencSettingsVersion"] = 4;
        sf.update(customTuning);
        sf["hitchDiag"] = sf["poseLogging"] = sf["poseLogBurst"] = sf["nvencVerbose"] = true;
        sf["eyeGaze"]["debugRing"] = true;
        sf["blackFloor"] = {{"rampBar",true},{"blackPointCode",3.5}};
        input["galaxyXr"]["vrlinkDebugOverlay"] = true;
        if (scenario == 17) input["debugMode"] = false;
        if (scenario == 18) input["debugMode"] = true;
        if (scenario == 19) input["debugMode"] = "true";
    } else if (scenario == 20) {
        // Old-schema explicit values must not be mistaken for obsolete
        // defaults, including requests above the former artificial limits.
        sf["nvencSettingsVersion"] = 2;
        input["galaxyXr"] = {{"streamQuality","custom"},{"customStreamFormatWidth",3072},
            {"customBandwidthMbit",2500},{"profileSupports10bit",true},{"sdr10SettingsVersion",1}};
    } else if (scenario == 21) {
        sf["nvencSettingsVersion"] = 4;
        input["galaxyXr"] = {{"sdr10SettingsVersion",1}};
    } else if (scenario == 22) {
        sf["nvencSettingsVersion"] = 4;
        sf["nvencCodec"] = 1;
        sf["nvencForceCbr"] = false;
        sf.update(h264Tuning);
    } else if (scenario >= 23 && scenario <= 26) {
        sf["nvencSettingsVersion"] = 4;
        sf["nvencCodec"] = 1;
        if (scenario == 23) sf["nvencH264GopFrames"] = 120.5;
        if (scenario == 24) sf["nvencMultiPass"] = 1.5;
        if (scenario == 25) sf["nvencH264GopFrames"] = std::numeric_limits<int64_t>::max();
        if (scenario == 26) input["galaxyXr"]["customStreamFormatWidth"] = std::numeric_limits<uint64_t>::max();
    } else return 2;
    const auto path = testFolder + "settings.json";
    { std::ofstream out(path); out << input.dump(); }
    ParseConfig();
    auto checkExpected = [&] {
        const auto &s = driverConfig.streamFrame;
        Check(s.nvencSettingsVersion == 4, "version reaches current schema");
        Check(s.hitchDiag == (scenario == 11 || scenario == 18), "hitch diagnostics require master and preserve explicit choices");
        Check(s.streamFrameSchema == 5, "debug policy version stamp reaches schema 5");
        if (scenario >= 16 && scenario <= 19) {
            const bool enabled = scenario == 18;
            Check(driverConfig.debugMode == enabled, "master is strictly boolean and defaults OFF");
            Check(s.blackFloor.rampBar == enabled && s.eyeGaze.debugRing == enabled
                && s.poseLogging == enabled && s.poseLogBurst == enabled && s.nvencVerbose == enabled
                && driverConfig.galaxyXr.vrlinkDebugOverlay == enabled, "all seven diagnostics use effective master");
            Check(s.blackFloor.blackPointCode == 3.5 && s.nvencFixLevel && s.nvencForceFps == 72
                && s.nvencBitrateMbit == 123 && s.nvencMaxBitrateHeadroomPct == 20,
                "picture and encoder compatibility/rate tuning remains effective");
            json stored; { std::ifstream in(path); in >> stored; }
            Check(stored == input, "runtime masking never rewrites saved diagnostic choices");
        }
        if (customUpgrade) {
            Check(!s.nvencTap && !s.nvencFixLevel && !s.nvencForceCbr
                && !s.nvencBitrateScale && !s.nvencPresetMerge, "all explicit encoder OFF choices preserved");
            Check(!driverConfig.galaxyXr.vrlinkHeadsetProfile, "profile OFF preserved");
            Check(!s.postPack.enable && !s.postPack.casEnable, "post-pack OFF preserved");
            Check(s.nvencVbvFrames == 5, "VBV tuning preserved");
            Check(s.nvencLowDelayKfScale == 4, "keyframe scale preserved");
            Check(s.nvencMaxBitrateHeadroomPct == 20, "bitrate headroom preserved");
            Check(s.nvencForceFps == 72, "frame rate override preserved");
            Check(s.nvencSplitMode == 3 && s.nvencPreset == 7, "split and preset preserved");
            Check(s.nvencAqStrength == 4, "AQ tuning preserved");
            Check(s.nvencMinQp == 5 && s.nvencMinQpIntra == 7 && s.nvencMaxQp == 31, "QP bounds preserved");
            Check(s.nvencVuiFullRange == 1 && s.nvencVuiMatrix == 1
                && s.nvencVuiPrimaries == 1 && s.nvencVuiTransfer == 1, "VUI choices preserved");
            Check(s.nvencBitrateMbit == 123 && s.nvencBandwidthOverrideMbit == 234, "bandwidth tuning preserved");
            Check(driverConfig.galaxyXr.customStreamFormatWidth == 1856, "valid custom stream width preserved");
        } else if (scenario == 1) {
            const StreamFrameConfig defaults;
            Check(s.nvencTap == defaults.nvencTap && s.nvencFixLevel == defaults.nvencFixLevel
                && s.nvencForceCbr == defaults.nvencForceCbr && s.nvencBitrateScale == defaults.nvencBitrateScale
                && s.nvencPresetMerge == defaults.nvencPresetMerge, "missing switches use defaults");
            Check(s.postPack.enable && s.postPack.casEnable, "unspecified CAS retains default upgrade");
        } else if (scenario == 2 || scenario == 3) {
            Check(!s.cas.enable && !s.postPack.casEnable, "legacy CAS OFF disables both sharpeners");
            Check(s.postPack.enable == (scenario == 3), "independent range remap preserved");
        } else if (scenario == 4) {
            Check(!s.cas.enable && s.postPack.enable && s.postPack.casEnable, "enabled legacy CAS migrates");
            Check(s.postPack.foveaStrength == 0.87, "legacy sharpening strength retained");
        } else if (scenario == 5) {
            Check(s.cas.enable && !s.postPack.enable && !s.postPack.casEnable, "explicit pre-encode choice retained");
        } else if (scenario == 6) {
            Check(!s.postPack.casEnable && s.postPack.limitedRange, "explicit post-pack sharpening OFF retained");
        } else if (scenario == 12) {
            Check(!s.nvencTap && !s.nvencFixLevel && !s.nvencForceCbr
                && !s.nvencBitrateScale && !s.nvencPresetMerge, "saved legacy encoder switches remain OFF");
            Check(!s.postPack.enable && !s.postPack.casEnable, "upgrade preserves legacy post-pack OFF");
            Check(s.nvencVbvFrames == 0 && s.nvencLowDelayKfScale == 0
                && s.nvencForceFps == 0 && s.nvencSplitMode == 0, "upgrade preserves disabled encoder budgeting overrides");
        } else if (scenario == 13 || scenario == 15) {
            Check(s.nvencTap && s.nvencFixLevel && s.nvencForceCbr
                && s.nvencBitrateScale && s.nvencPresetMerge, "fresh/reset config enables reference encoder switches");
            Check(s.nvencPreset == 0 && s.nvencVbvFrames == 2 && s.nvencLowDelayKfScale == 2
                && s.nvencForceFps == 90 && s.nvencSplitMode == 1, "fresh/reset config uses reference encoder tuning");
            Check(s.nvencAqStrength == 0 && s.nvencMinQp == 0 && s.nvencMinQpIntra == 0 && s.nvencMaxQp == 0
                && s.nvencBitrateMbit == 0 && s.nvencBandwidthOverrideMbit == 0, "fresh/reset config clears custom AQ, QP and bitrate overrides");
            Check(s.nvencVuiFullRange == -1 && s.nvencVuiMatrix == -1 && s.nvencVuiPrimaries == -1
                && s.nvencVuiTransfer == -1, "fresh/reset config uses automatic VUI metadata");
            Check(s.postPack.enable && s.postPack.casEnable && !s.cas.enable, "fresh/reset config uses only post-pack sharpening");
            Check(!s.postPack.limitedRange, "fresh/reset config keeps the lifted-blacks remap OFF (owner directive 2026-10-17)");
            Check(driverConfig.galaxyXr.nativeIdentity && driverConfig.galaxyXr.nativeResolution, "fresh/reset config enables native identity and resolution");
            Check(!driverConfig.galaxyXr.sdr10Baseline && !driverConfig.galaxyXr.profileSupports10bit, "fresh/reset config keeps current SDR10 OFF policy");
            Check(s.enable, "fresh/reset config resolves the Image Enhancements master ON (owner directive 2026-10-17)");
            Check(!driverConfig.customShader.enable, "old custom-shader processing is inactive after reset");
            Check(s.gamma == 2.2 && s.brightness == 1.0 && s.saturation == 50, "old picture tuning returns to defaults");
            Check(!s.calib.blackout && !s.calib.captureMode && s.calib.pattern == -1, "old blackout and calibration patterns are inactive");
            Check(!s.eyeGaze.debugGrid && !s.eyeGaze.calibDot && !s.eyeGaze.probeCapture, "old gaze calibration overlays are inactive");
        } else if (scenario == 20) {
            Check(driverConfig.galaxyXr.customStreamFormatWidth == 3072, "old-schema explicit tile above former limit survives");
            Check(driverConfig.galaxyXr.customBandwidthMbit == 2500, "old-schema explicit bandwidth above former limit survives");
            Check(driverConfig.galaxyXr.profileSupports10bit, "old-schema explicit 10-bit capability survives migration");
            Check(gxr::ResolveSdr10Policy(driverConfig).profileSupports10bit, "explicit capability remains effective with baseline off");
            Check(s.nvencValidationError.empty(), "valid unbounded scalar requests have no parse error");
        } else if (scenario == 21) {
            Check(!driverConfig.galaxyXr.profileSupports10bit, "absent capability uses false default");
            Check(s.nvencH264GopFrames == 0 && s.nvencH264IdrFrames == 0 && s.nvencMultiPass == -1,
                "absent recipe timing and multipass use automatic defaults");
            Check(s.nvencValidationError.empty(), "absent optional fields are not invalid requests");
        } else if (scenario == 22) {
            // h264Tuning still carries the retired nvencFillerDataInsertion
            // key: an old settings.json with it must parse cleanly, keep the
            // key untouched on disk and enable nothing.
            Check(!s.nvencForceCbr, "retired filler key parses cleanly, is ignored and leaves Force CBR unset");
            Check(s.nvencH264GopFrames == 144 && s.nvencH264IdrFrames == 288 && s.nvencH264RefFrames == 2,
                "explicit GOP, IDR and reference frames reach runtime config");
            Check(s.nvencH264Entropy == 2 && s.nvencH264SliceMode == 0 && s.nvencH264SliceData == 12,
                "explicit entropy and slice settings reach runtime config");
            Check(!s.nvencH264Aud && !s.nvencH264RepeatHeaders && s.nvencH264DisableHeaders && !s.nvencH264BitstreamRestriction,
                "explicit header and restriction toggles reach runtime config");
            Check(s.nvencH264VbvInitialDelay == 12345 && s.nvencMultiPass == 2,
                "explicit VBV delay and multipass reach runtime config");
            Check(s.nvencValidationError.empty(), "valid explicit recipe has no parse error");
        } else if (scenario >= 23 && scenario <= 26) {
            const std::string field = scenario == 24 ? "streamFrame.nvencMultiPass"
                : scenario == 26 ? "galaxyXr.customStreamFormatWidth" : "streamFrame.nvencH264GopFrames";
            Check(s.nvencValidationError.find(field) != std::string::npos, "invalid integer request exposes its exact field");
            Check(s.nvencValidationError.find("32-bit integer") != std::string::npos, "fraction or overflow fails visibly instead of accepting defaults");
        }
        if (scenario >= 21 && scenario <= 26) {
            json stored; { std::ifstream in(path); in >> stored; }
            Check(stored == input, "recipe and invalid raw requests remain unchanged on disk");
            Check(!stored["streamFrame"].contains("nvencValidationError"), "transient validation error is never persisted");
        }
    };
    checkExpected();
    json persisted;
    { std::ifstream in(path); in >> persisted; }
    if (customUpgrade) {
        for (auto entry = customTuning.begin(); entry != customTuning.end(); ++entry) {
            Check(persisted["streamFrame"][entry.key()] == entry.value(), (entry.key() + " persists after migration").c_str());
        }
        Check(persisted["galaxyXr"]["customStreamFormatWidth"] == 1856, "custom stream width persists after migration");
    }
    if (scenario == 20) {
        Check(persisted["galaxyXr"]["customStreamFormatWidth"] == 3072 && persisted["galaxyXr"]["customBandwidthMbit"] == 2500,
            "migration writeback retains explicit geometry and bandwidth");
        Check(persisted["galaxyXr"]["profileSupports10bit"] == true, "migration writeback retains explicit capability true");
    }
    ParseConfig();
    checkExpected();
    json reopened;
    { std::ifstream in(path); in >> reopened; }
    Check(reopened == persisted, "repeated load does not rewrite the migrated file");
    if(scenario == 18) {
        const auto generation = driverConfig.debugGeneration;
        json disabled = input; disabled["debugMode"] = false;
        { std::ofstream out(path); out << disabled.dump(); }
        ParseConfig();
        Check(!driverConfig.streamFrame.poseLogging && !driverConfig.streamFrame.hitchDiag,
            "live master OFF applies diagnostic policy");
        { std::ofstream out(path); out << input.dump(); }
        ParseConfig();
        Check(driverConfig.debugGeneration == generation + 2, "runtime generation retains both transitions without scene frames");
        checkExpected();
    }
    std::cout << "Toggle migration scenario " << scenario << ": " << checks << " checks, " << failures << " failures\n";
    return failures ? 1 : 0;
}
