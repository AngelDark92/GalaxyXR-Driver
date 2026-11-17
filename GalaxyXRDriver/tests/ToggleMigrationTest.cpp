// Execute the actual ConfigLoader parser against build-only fixtures. Each
// process models a fresh install; the runner never reads live settings.
#include "Config/Config.h"
#include "Config/SdrColorPolicy.h"
#include "Config/DebugModePolicy.h"
#include "Config/ControllerMasterPolicy.h"
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
        {"nvencBitrateMbit",123},
    };
    const json h264Tuning = {
        {"nvencFillerDataInsertion",true},{"nvencH264GopFrames",144},{"nvencH264IdrFrames",288},
        {"nvencH264RefFrames",2},{"nvencH264Entropy",2},{"nvencH264SliceMode",0},
        {"nvencH264SliceData",12},{"nvencH264Aud",false},{"nvencH264RepeatHeaders",false},
        {"nvencH264DisableHeaders",true},{"nvencH264BitstreamRestriction",false},
        {"nvencH264VbvInitialDelay",12345},{"nvencMultiPass",2},
    };
    const bool customUpgrade = scenario == 0 || scenario == 7 || scenario == 8 || scenario == 14;
    const char* toggles[] = {"nvencTap", "nvencFixLevel", "nvencForceCbr", "nvencPresetMerge"};
    if (customUpgrade) {
        sf["nvencSettingsVersion"] = scenario == 14 ? 3 : scenario == 7 ? 4 : 0;
        for (auto key : toggles) sf[key] = false;
        input["galaxyXr"]["vrlinkHeadsetProfile"] = false;
        input["galaxyXr"]["customStreamFormatWidth"] = 1856;
        sf.update(customTuning);
        sf["nvencBitrateScale"] = false; // retired bool: must migrate to constancy 100
        sf["nvencBitrateCurve"] = 3;
        sf["nvencBitrateCurvePoints"] = json::array({
            json{{"x", 0.0}, {"y", 0.0}}, json{{"x", 0.1}, {"y", 0.05}},
            json{{"x", 0.4}, {"y", 0.3}}, json{{"x", 0.7}, {"y", 0.9}},
            json{{"x", 1.0}, {"y", 1.0}},
        });
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
        sf["nvencBitrateScale"] = false; // retired bool: must migrate to constancy 100
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
        driverConfig.streamFrame.nvencBitrateConstancyPct = 100;
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
    } else if (scenario == 27) {
        // 2026-10-19: an existing install's explicit curve/constancy must
        // survive a reinstall/upgrade untouched, and an explicit new key
        // outranks the retired bool when a file carries both.
        sf["nvencSettingsVersion"] = 4;
        sf["nvencBitrateCurve"] = 2;
        sf["nvencBitrateConstancyPct"] = 35;
        sf["nvencBitrateScale"] = false;
    } else if (scenario == 28) {
        // 2026-10-21: streamFrame.nvencVrlinkFallbackMode is retired. A stored
        // 1 is honoured once as Bitrate Constancy 100 (the encoder target is the
        // Bandwidth row), the key is ignored, and the file is not rewritten.
        sf["nvencSettingsVersion"] = 4;
        sf["nvencBitrateCurve"] = 2;
        sf["nvencBitrateConstancyPct"] = 35;
        sf["nvencVrlinkFallbackMode"] = 1;
    } else if (scenario == 31) {
        // 2026-10-24: the former Controller Bypass is the master controller
        // disable. It must win over a saved Game Link layout and every filter.
        sf["streamFrameSchema"] = 5;
        sf["nvencSettingsVersion"] = 4;
        sf["velocityFixMode"] = "kalmanCA";
        input["galaxyXr"]["controllerBypass"] = true;
        input["galaxyXr"]["gameLinkLayout"] = true;
        input["controllers"] = {{"spaceVelocityFix", "driver"}};
    } else if (scenario == 32) {
        // Master off and schema 5: the semantics-only upgrade preserves every
        // explicitly tuned encoder field, including the edited Custom curve.
        sf["streamFrameSchema"] = 5;
        sf["nvencSettingsVersion"] = 4;
        sf.update(customTuning);
        sf.update(h264Tuning);
        sf["nvencTap"] = false;
        sf["nvencFixLevel"] = false;
        sf["nvencForceCbr"] = true;
        sf["nvencPresetMerge"] = false;
        sf["nvencCodec"] = 2;
        sf["nvencBandwidthOverrideMbit"] = 234; // retired at v5: must fold into Max Bitrate
        sf["nvencBitrateCurve"] = 3;
        sf["nvencBitrateConstancyPct"] = 37;
        sf["nvencBitrateCurvePoints"] = json::array({
            json{{"x",0.0},{"y",0.12}}, json{{"x",0.1},{"y",0.2}},
            json{{"x",0.3},{"y",0.4}}, json{{"x",0.5},{"y",0.7}},
            json{{"x",0.7},{"y",0.9}}, json{{"x",0.85},{"y",1.0}},
            json{{"x",1.0},{"y",1.0}},
        });
        sf["postPack"] = {{"enable",false},{"casEnable",false},{"limitedRange",true}};
        sf["velocityFixMode"] = "kalmanCA";
        input["galaxyXr"]["controllerBypass"] = false;
        input["galaxyXr"]["gameLinkLayout"] = true;
    } else if (scenario == 33) {
        // 2026-11-17: a nonzero retired bandwidth override on a legacy tier
        // name folds into Max Bitrate; the tier tile is pinned to custom first
        // so the negotiated stream width is unchanged.
        sf["streamFrameSchema"] = 6;
        sf["nvencSettingsVersion"] = 4;
        sf["nvencBandwidthOverrideMbit"] = 500;
        input["galaxyXr"] = {{"streamQuality","sharp"},{"customStreamFormatWidth",2048},{"customBandwidthMbit",350}};
    } else if (scenario == 34) {
        // Already custom: only Max Bitrate changes and the stored tile stays.
        // The v4 migration marker must not skip or block the v5 fold.
        sf["streamFrameSchema"] = 6;
        sf["nvencSettingsVersion"] = 4;
        sf["nvencBandwidthOverrideMbit"] = 275;
        input["galaxyXr"] = {{"streamQuality","custom"},{"customStreamFormatWidth",2048},{"customBandwidthMbit",400}};
        std::ofstream(testFolder + "nvenc-settings-v4.migrated") << "4";
    } else if (scenario == 35) {
        // Zero folds nothing: the retired key is removed and every other
        // stored value (including a legacy tier name) stays as it was.
        sf["streamFrameSchema"] = 6;
        sf["nvencSettingsVersion"] = 4;
        sf["nvencBandwidthOverrideMbit"] = 0;
        input["galaxyXr"] = {{"streamQuality","balanced"},{"customStreamFormatWidth",1536},{"customBandwidthMbit",350}};
    } else if (scenario == 36) {
        // At v5 the retired key is ignored even when present; nothing changes.
        sf["streamFrameSchema"] = 6;
        sf["nvencSettingsVersion"] = 5;
        sf["nvencBandwidthOverrideMbit"] = 500;
        input["galaxyXr"] = {{"streamQuality","sharp"},{"customStreamFormatWidth",1536},{"customBandwidthMbit",450}};
    } else return 2;
    const auto path = testFolder + "settings.json";
    { std::ofstream out(path); out << input.dump(); }
    ParseConfig();
    // 2026-11-17: nvencSettingsVersion 5 retires
    // streamFrame.nvencBandwidthOverrideMbit. Any config below 5 gains the new
    // stamp, so a stored file is expected to differ by exactly the v5 writeback.
    auto stampedAtV5 = [&](json expected) {
        expected["streamFrame"]["nvencSettingsVersion"] = 5;
        return expected;
    };
    auto checkExpected = [&] {
        const auto &s = driverConfig.streamFrame;
        Check(s.nvencSettingsVersion == 5, "version reaches current schema");
        Check(s.hitchDiag == (scenario == 11 || scenario == 18), "hitch diagnostics require master and preserve explicit choices");
        Check(s.streamFrameSchema == 6, "bitrate reference semantics stamp reaches schema 6");
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
            Check(stored == stampedAtV5(input), "runtime masking never rewrites saved diagnostic choices");
        }
        if (customUpgrade) {
            Check(!s.nvencTap && !s.nvencFixLevel && !s.nvencForceCbr
                && s.nvencBitrateConstancyPct == 100 && !s.nvencPresetMerge, "all explicit encoder OFF choices preserved (retired bitrate bool migrates to constant)");
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
            Check(s.nvencBitrateMbit == 123, "encoder bitrate tuning preserved");
            if (scenario == 0) {
                Check(s.nvencBitrateCurve == 3 && s.nvencBitrateCurvePoints.size() == 7,
                    "five-point custom curve upgrades to seven points");
                Check(s.nvencBitrateCurvePoints[2].x == 0.4 && s.nvencBitrateCurvePoints[2].y == 0.3,
                    "custom curve point values parsed exactly");
                Check(s.nvencBitrateCurvePoints[4].x == 0.85 && s.nvencBitrateCurvePoints[4].y == 0.95
                    && s.nvencBitrateCurvePoints[5].x == 1.0 && s.nvencBitrateCurvePoints[5].y == 1.0
                    && s.nvencBitrateCurvePoints[6].x == 1.0 && s.nvencBitrateCurvePoints[6].y == 1.0,
                    "upgrade leaves P6 overlapping hidden P7 until dragged");
            }
            Check(driverConfig.galaxyXr.customStreamFormatWidth == 1856, "valid custom stream width preserved");
        } else if (scenario == 1) {
            const StreamFrameConfig defaults;
            Check(s.nvencTap == defaults.nvencTap && s.nvencFixLevel == defaults.nvencFixLevel
                && s.nvencForceCbr == defaults.nvencForceCbr && s.nvencBitrateConstancyPct == defaults.nvencBitrateConstancyPct
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
                && s.nvencBitrateConstancyPct == 100 && !s.nvencPresetMerge, "saved legacy encoder switches remain OFF (retired bitrate bool migrates to constant)");
            Check(!s.postPack.enable && !s.postPack.casEnable, "upgrade preserves legacy post-pack OFF");
            Check(s.nvencVbvFrames == 0 && s.nvencLowDelayKfScale == 0
                && s.nvencForceFps == 0 && s.nvencSplitMode == 0, "upgrade preserves disabled encoder budgeting overrides");
        } else if (scenario == 13 || scenario == 15) {
            Check(s.nvencTap && s.nvencFixLevel && !s.nvencForceCbr
                && s.nvencBitrateConstancyPct == 0 && s.nvencPresetMerge, "fresh/reset config enables reference encoder switches with Force CBR off");
            Check(s.nvencPreset == 0 && s.nvencVbvFrames == 2 && s.nvencLowDelayKfScale == 2
                && s.nvencForceFps == 90 && s.nvencSplitMode == 1, "fresh/reset config uses reference encoder tuning");
            Check(s.nvencAqStrength == 0 && s.nvencMinQp == 0 && s.nvencMinQpIntra == 0 && s.nvencMaxQp == 0
                && s.nvencBitrateMbit == 0, "fresh/reset config clears custom AQ, QP and bitrate overrides");
            Check(driverConfig.galaxyXr.customBandwidthMbit == 350, "fresh/reset config keeps the default Max Bitrate");
            Check(s.nvencVuiFullRange == -1 && s.nvencVuiMatrix == -1 && s.nvencVuiPrimaries == -1
                && s.nvencVuiTransfer == -1, "fresh/reset config uses automatic VUI metadata");
            Check(s.postPack.enable && s.postPack.casEnable && !s.cas.enable, "fresh/reset config uses only post-pack sharpening");
            Check(!s.postPack.limitedRange, "fresh/reset config keeps the lifted-blacks remap OFF (owner directive 2026-10-17)");
            Check(driverConfig.galaxyXr.nativeIdentity && driverConfig.galaxyXr.nativeResolution, "fresh/reset config enables native identity and resolution");
            Check(driverConfig.galaxyXr.sdr10Baseline && !driverConfig.galaxyXr.profileSupports10bit,
                "fresh/reset config enables the 10-bit SDR baseline while the explicit capability request stays off");
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
        } else if (scenario == 27) {
            Check(s.nvencBitrateCurve == 2 && s.nvencBitrateConstancyPct == 35,
                "explicit curve and constancy survive an existing-install load (explicit wins over the retired bool)");
            json stored; { std::ifstream in(path); in >> stored; }
            Check(stored == stampedAtV5(input), "existing settings values survive; only the v5 stamp is written");
        } else if (scenario == 28) {
            Check(s.nvencBitrateConstancyPct == 100,
                "retired No-fallback key is honoured once as Bitrate Constancy 100");
            Check(s.nvencBitrateCurve == 2, "curve family survives the retired key");
            json stored; { std::ifstream in(path); in >> stored; }
            Check(stored == stampedAtV5(input), "retired key load writes only the v5 stamp");
            Check(stored["streamFrame"]["nvencBitrateConstancyPct"] == 35,
                "saved constancy stays 35 on disk while runtime uses 100");
        } else if (scenario >= 23 && scenario <= 26) {
            const std::string field = scenario == 24 ? "streamFrame.nvencMultiPass"
                : scenario == 26 ? "galaxyXr.customStreamFormatWidth" : "streamFrame.nvencH264GopFrames";
            Check(s.nvencValidationError.find(field) != std::string::npos, "invalid integer request exposes its exact field");
            Check(s.nvencValidationError.find("32-bit integer") != std::string::npos, "fraction or overflow fails visibly instead of accepting defaults");
        }
        if (scenario >= 21 && scenario <= 26) {
            json stored; { std::ifstream in(path); in >> stored; }
            // 23..26 carry an invalid integer request: the v5 writeback is
            // suppressed with the rest of the migration, so the file is intact.
            Check((scenario >= 23) ? stored == input : stored == stampedAtV5(input),
                "recipe and invalid raw requests remain unchanged on disk (a valid file gains only the v5 stamp)");
            Check(!stored["streamFrame"].contains("nvencValidationError"), "transient validation error is never persisted");
        }
        if (scenario == 31) {
            Check(driverConfig.galaxyXr.controllerBypass, "controller master disable stays on");
            Check(!driverConfig.galaxyXr.gameLinkLayout, "controller master disable wins over a saved Game Link layout");
            Check(s.velocityFixMode == 0, "controller master disable stops every motion-filter mode");
            Check(driverConfig.controllers.spaceVelocityFixMode == 0, "controller master disable stops the space velocity fix");
            Check(!driverConfig.galaxyXr.gripConvention && !driverConfig.galaxyXr.synthesizeGripTouch
                && !driverConfig.galaxyXr.officialComponents,
                "controller master disable turns off the remaining controller feature flags");
            json stored; { std::ifstream in(path); in >> stored; }
            Check(stored == stampedAtV5(input), "controller master disable never rewrites the saved controller settings");
        }
        if (scenario == 32) {
            Check(!driverConfig.galaxyXr.controllerBypass, "controller master disable off stays off");
            Check(driverConfig.galaxyXr.gameLinkLayout, "Game Link layout still applies with the master off");
            Check(s.velocityFixMode == 6, "Kalman CA still applies with the master off");
            Check(!s.nvencTap && !s.nvencFixLevel && s.nvencForceCbr && !s.nvencPresetMerge && s.nvencCodec == 2,
                "schema 5 preserves explicit encoder switches and codec");
            Check(s.nvencBitrateMbit == 123 && driverConfig.galaxyXr.customBandwidthMbit == 234
                && s.nvencBitrateCurve == 3 && s.nvencBitrateConstancyPct == 37 && s.nvencMaxBitrateHeadroomPct == 20,
                "schema 5 preserves bitrate, curve, constancy and headroom tuning; the retired override is folded into Max Bitrate");
            Check(s.nvencBitrateCurvePoints.size() == input["streamFrame"]["nvencBitrateCurvePoints"].size(),
                "schema 5 retains all seven edited Custom points");
            for(size_t i = 0; i < s.nvencBitrateCurvePoints.size(); ++i){
                const auto &point = input["streamFrame"]["nvencBitrateCurvePoints"][i];
                Check(s.nvencBitrateCurvePoints[i].x == point["x"].get<double>()
                    && s.nvencBitrateCurvePoints[i].y == point["y"].get<double>(),
                    "schema 5 preserves each Custom point coordinate exactly");
            }
            Check(s.nvencVbvFrames == 5 && s.nvencLowDelayKfScale == 4 && s.nvencForceFps == 72
                && s.nvencSplitMode == 3 && s.nvencPreset == 7 && s.nvencAqStrength == 4,
                "schema 5 preserves VBV, keyframe, FPS, split, preset and AQ tuning");
            Check(s.nvencMinQp == 5 && s.nvencMinQpIntra == 7 && s.nvencMaxQp == 31
                && s.nvencVuiFullRange == 1 && s.nvencVuiMatrix == 1 && s.nvencVuiPrimaries == 1 && s.nvencVuiTransfer == 1,
                "schema 5 preserves QP bounds and every VUI choice");
            Check(s.nvencH264GopFrames == 144 && s.nvencH264IdrFrames == 288
                && s.nvencH264RefFrames == 2 && s.nvencH264Entropy == 2 && s.nvencH264SliceMode == 0
                && s.nvencH264SliceData == 12 && !s.nvencH264Aud && !s.nvencH264RepeatHeaders
                && s.nvencH264DisableHeaders && !s.nvencH264BitstreamRestriction
                && s.nvencH264VbvInitialDelay == 12345 && s.nvencMultiPass == 2,
                "schema 5 preserves multipass and every H264 recipe field");
            Check(!s.postPack.enable && !s.postPack.casEnable && s.postPack.limitedRange,
                "schema 5 preserves post-pack opt-outs and range tuning");
            json stored; { std::ifstream in(path); in >> stored; }
            json expected = stampedAtV5(input);
            expected["streamFrame"].erase("nvencBandwidthOverrideMbit");
            expected["galaxyXr"]["customBandwidthMbit"] = 234;
            Check(stored == expected, "v5 folds the retired override into Max Bitrate and never rewrites schema 5 user tuning");
        }
        if (scenario == 33) {
            Check(driverConfig.galaxyXr.streamQuality == "custom", "nonzero retired override turns a legacy tier into custom");
            Check(driverConfig.galaxyXr.customStreamFormatWidth == 1536, "the legacy tier tile is pinned (sharp = 1536), not the stale custom width");
            Check(driverConfig.galaxyXr.customBandwidthMbit == 500, "nonzero retired override becomes Max Bitrate");
        }
        if (scenario == 34) {
            Check(driverConfig.galaxyXr.streamQuality == "custom" && driverConfig.galaxyXr.customStreamFormatWidth == 2048,
                "an existing custom tile is untouched by the fold");
            Check(driverConfig.galaxyXr.customBandwidthMbit == 275, "nonzero retired override becomes Max Bitrate on custom");
            Check(std::filesystem::exists(testFolder + "nvenc-settings-v4.migrated"), "the v4 marker still exists (it must not block v5)");
        }
        if (scenario == 35) {
            Check(driverConfig.galaxyXr.streamQuality == "balanced" && driverConfig.galaxyXr.customStreamFormatWidth == 1536
                && driverConfig.galaxyXr.customBandwidthMbit == 350,
                "zero override folds nothing and keeps the stored tier and Max Bitrate");
        }
        if (scenario == 36) {
            Check(driverConfig.galaxyXr.streamQuality == "sharp" && driverConfig.galaxyXr.customBandwidthMbit == 450,
                "a stray retired override at v5 is ignored");
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
    if (scenario == 33) {
        Check(persisted["streamFrame"]["nvencSettingsVersion"] == 5
            && !persisted["streamFrame"].contains("nvencBandwidthOverrideMbit")
            && persisted["galaxyXr"]["streamQuality"] == "custom"
            && persisted["galaxyXr"]["customStreamFormatWidth"] == 1536
            && persisted["galaxyXr"]["customBandwidthMbit"] == 500,
            "tier fold writes custom mode with the tier tile and the new Max Bitrate");
    }
    if (scenario == 34) {
        Check(persisted["streamFrame"]["nvencSettingsVersion"] == 5
            && !persisted["streamFrame"].contains("nvencBandwidthOverrideMbit")
            && persisted["galaxyXr"]["customStreamFormatWidth"] == 2048
            && persisted["galaxyXr"]["customBandwidthMbit"] == 275,
            "custom fold keeps the tile and writes the new Max Bitrate");
    }
    if (scenario == 35) {
        Check(persisted["streamFrame"]["nvencSettingsVersion"] == 5
            && !persisted["streamFrame"].contains("nvencBandwidthOverrideMbit")
            && persisted["galaxyXr"] == input["galaxyXr"],
            "zero override removes only the retired key and stamps v5");
    }
    if (scenario == 36) {
        Check(persisted == input, "v5 keeps a stray retired key and every stored value untouched");
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
        // The file carries the v5 stamp the loader wrote; rewriting it as a
        // pre-v5 document would only exercise the once-per-process guard.
        { std::ofstream out(path); out << stampedAtV5(input).dump(); }
        ParseConfig();
        Check(driverConfig.debugGeneration == generation + 2, "runtime generation retains both transitions without scene frames");
        checkExpected();
    }
    std::cout << "Toggle migration scenario " << scenario << ": " << checks << " checks, " << failures << " failures\n";
    return failures ? 1 : 0;
}
