// Exercise the production parser and resolution writer using isolated files and fake SteamVR I/O.
#include "Config/Config.h"
#include "Config/SdrColorPolicy.h"
#include "Config/DebugModePolicy.h"
#include "Config/GameLinkLayoutPolicy.h"
#include "Config/ControllerMasterPolicy.h"
#include "Config/StreamTiers.h"
#include "Config/VrlinkSettingsRouting.h"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <mutex>
using json = nlohmann::json;
Config driverConfig, driverConfigOld;
std::mutex driverConfigLock;
bool hasLoggedConfigFileNotFound = false;
std::string testFolder;
std::string GetConfigFolder() { return testFolder; }
void DriverLog(const char*, ...) {}
#include "ParseConfig.generated.h"
std::map<std::string, int> writes;
std::vector<std::string> restores;
std::string Key(const char* section, const char* key) { return std::string(section) + "/" + key; }
void SetInt32IfDifferent(const char* section, const char* key, int value) { writes[Key(section, key)] = value; }
namespace gxrsettings {
void RestoreOwnedKey(const char* section, const char* key) { restores.push_back(Key(section, key)); }
}
#include "ResolutionWriter.generated.h"
int checks = 0, failures = 0;
void Check(bool condition, const char* label) {
    ++checks;
    if (!condition) { ++failures; std::cerr << "FAIL: " << label << '\n'; }
}
int main(int argc, char** argv) {
    if (argc != 2) return 2;
    testFolder = std::string(argv[1]) + "/";
    std::filesystem::create_directories(testFolder);
    auto load = [](json gx) {
        json input = {{"galaxyXr", gx}, {"streamFrame", {{"streamFrameSchema",5},{"nvencSettingsVersion",4}}}};
        { std::ofstream out(testFolder + "settings.json"); out << input; }
        ParseConfig();
    };
    for (bool enabled : {false, true}) {
        load({{"nativeResolution", enabled}});
        Check(driverConfig.galaxyXr.nativeResolution == enabled, "legacy choice preserved");
        Check(driverConfig.galaxyXr.renderWidth == 3552 && driverConfig.galaxyXr.renderHeight == 3840, "legacy native dimensions");
    }
    for (const auto& value : std::vector<json>{nullptr, false, "4096", 4096.5, 0, -1, 16385, 18446744073709551615ull}) {
        load({{"renderWidth",value},{"renderHeight",value}});
        Check(driverConfig.galaxyXr.renderWidth == 3552 && driverConfig.galaxyXr.renderHeight == 3840, "invalid dimensions fall back without overflow");
    }
    load({{"renderWidth",1},{"renderHeight",16384}});
    Check(driverConfig.galaxyXr.renderWidth == 1 && driverConfig.galaxyXr.renderHeight == 16384, "integer boundaries accepted");
    for (bool profile : {false, true}) {
        load({{"nativeResolution",true},{"renderWidth",2880},{"renderHeight",3200},{"vrlinkHeadsetProfile",profile}});
        writes.clear(); restores.clear(); ApplyResolutionForTest();
        const auto targets = gxr::VrlinkTuningSections(profile);
        Check(writes.size() == targets.size() * 4, "only selected route destinations receive geometry");
        for (const auto& section : targets) {
            Check(writes[Key(section.c_str(),"renderWidth")] == 2880, "manual width applied");
            Check(writes[Key(section.c_str(),"overrideRenderWidth")] == 2880, "manual override width applied");
            Check(writes[Key(section.c_str(),"renderHeight")] == 3200, "manual height applied");
            Check(writes[Key(section.c_str(),"overrideRenderHeight")] == 3200, "manual override height applied");
        }
        driverConfig.galaxyXr.nativeResolution = false;
        writes.clear(); restores.clear(); ApplyResolutionForTest();
        Check(writes.empty(), "disabled override writes no geometry or refresh rate");
        for (const auto& section : targets) for (const char* key : {"renderWidth","renderHeight","overrideRenderWidth","overrideRenderHeight"})
            Check(std::find(restores.begin(),restores.end(),Key(section.c_str(),key)) != restores.end(), "disabled geometry uses owned restore");
        Check(driverConfig.galaxyXr.renderWidth == 2880 && driverConfig.galaxyXr.renderHeight == 3200, "disable preserves manual dimensions");
    }
    std::cout << "Manual render resolution: " << checks << " checks, " << failures << " failures\n";
    return failures ? 1 : 0;
}
