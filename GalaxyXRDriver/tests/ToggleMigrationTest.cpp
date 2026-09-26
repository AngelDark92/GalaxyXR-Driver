// Execute the actual ConfigLoader parser against build-only fixtures. Each
// process models a fresh install; the runner never reads live settings.
#include "Config/Config.h"
#include "Config/SdrColorPolicy.h"
#include "Config/StreamTiers.h"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <mutex>
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
    const char* toggles[] = {"nvencTap", "nvencFixLevel", "nvencForceCbr", "nvencBitrateScale", "nvencPresetMerge"};
    if (scenario == 0 || scenario == 7 || scenario == 8) {
        sf["nvencSettingsVersion"] = scenario == 7 ? 4 : 0;
        for (auto key : toggles) sf[key] = false;
        input["galaxyXr"]["vrlinkHeadsetProfile"] = false;
        sf["nvencBitrateMbit"] = 123;
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
        if (scenario != 9) sf["hitchDiag"] = scenario == 11;
    } else if (scenario == 12) {
        // Clean Settings must survive both migrations and repeated loads.
        sf["nvencSettingsVersion"] = 4;
        for (auto key : toggles) sf[key] = false;
        for (auto key : {"nvencVbvFrames", "nvencLowDelayKfScale", "nvencForceFps", "nvencSplitMode"}) sf[key] = 0;
        sf["postPack"] = {{"enable",false},{"casEnable",false}};
    } else if (scenario == 13) {
        input = json::object(); // Fresh installation before any GUI/runtime save.
    } else return 2;
    const auto path = testFolder + "settings.json";
    { std::ofstream out(path); out << input.dump(); }
    ParseConfig();
    auto checkExpected = [&] {
        const auto &s = driverConfig.streamFrame;
        Check(s.nvencSettingsVersion == 4, "version reaches current schema");
        Check(s.hitchDiag == (scenario == 11), "hitch diagnostics defaults OFF and preserves explicit choices");
        if (scenario == 0 || scenario == 7 || scenario == 8) {
            Check(!s.nvencTap && !s.nvencFixLevel && !s.nvencForceCbr
                && !s.nvencBitrateScale && !s.nvencPresetMerge, "all explicit encoder OFF choices preserved");
            Check(!driverConfig.galaxyXr.vrlinkHeadsetProfile, "profile OFF preserved");
            Check(!s.postPack.enable && !s.postPack.casEnable, "post-pack OFF preserved");
            if (scenario != 0) Check(s.nvencBitrateMbit == 123, "current schema/marker preserves custom tuning");
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
                && !s.nvencBitrateScale && !s.nvencPresetMerge, "cleaned encoder switches remain OFF");
            Check(!s.postPack.enable && !s.postPack.casEnable, "cleanup does not revive post-pack");
            Check(s.nvencVbvFrames == 0 && s.nvencLowDelayKfScale == 0
                && s.nvencForceFps == 0 && s.nvencSplitMode == 0, "cleanup leaves encoder budgeting overrides off");
        } else if (scenario == 13) {
            Check(s.nvencTap && s.nvencFixLevel && s.nvencForceCbr
                && s.nvencBitrateScale && s.nvencPresetMerge, "fresh install enables reference encoder switches");
            Check(s.nvencPreset == 0 && s.nvencVbvFrames == 2 && s.nvencLowDelayKfScale == 2
                && s.nvencForceFps == 90 && s.nvencSplitMode == 1, "fresh install uses reference encoder tuning");
        }
    };
    checkExpected();
    json persisted;
    { std::ifstream in(path); in >> persisted; }
    ParseConfig();
    checkExpected();
    json reopened;
    { std::ifstream in(path); in >> reopened; }
    Check(reopened == persisted, "repeated load does not rewrite the migrated file");
    std::cout << "Toggle migration scenario " << scenario << ": " << checks << " checks, " << failures << " failures\n";
    return failures ? 1 : 0;
}
