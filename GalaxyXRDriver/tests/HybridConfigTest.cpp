// Host-side tests for the experimental hybrid fovea settings section.
// The runner extracts the production ConfigLoader::ParseConfig() into
// ParseConfig.generated.h so these checks execute the real parser, not a copy.
#include "Config/Config.h"
#include "Config/SdrColorPolicy.h"
#include "Config/DebugModePolicy.h"
#include "Config/ControllerMasterPolicy.h"
#include "Config/GameLinkLayoutPolicy.h"
#include "Config/StreamTiers.h"
#include <nlohmann/json.hpp>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <mutex>
#include <string>
using json = nlohmann::json;

// Stand-ins for the driver-side dependencies of ParseConfig().
Config driverConfig, driverConfigOld;
std::mutex driverConfigLock;
bool hasLoggedConfigFileNotFound = false;
std::string testFolder;
std::string GetConfigFolder() { return testFolder; }
void DriverLog(const char*, ...) {}
// The extracted production parser calls the driver lifecycle hook; this test links only the
// parser, so the hook is a no-op here.
void ApplyHybridDriverConfig() {}
#include "ParseConfig.generated.h"

int checks = 0;
int failures = 0;

void Check(bool condition, const char* label) {
    ++checks;
    if (!condition) {
        ++failures;
        std::cerr << "FAIL: " << label << '\n';
    }
}

void WriteSettings(const json& input) {
    std::ofstream out(testFolder + "settings.json");
    out << input.dump();
}

// Every scenario starts from a fresh default Config, exactly like a new
// ConfigLoader parse pass.
void ParseFresh(const json& input) {
    driverConfig = Config{};
    WriteSettings(input);
    ParseConfig();
}

bool DefaultsMatch(const HybridConfig& h) {
    return h.enabled == false
        && h.foveaCodec == 0
        && h.baseCodec == 0
        && h.guardDegrees == 2.0
        && h.ring0Degrees == 5.0
        && h.ring1Degrees == 10.0
        && h.ring2Degrees == 20.0
        && h.ring3Degrees == 35.0
        && h.ring4Degrees == 45.0
        && h.featherPx == 8
        && h.ring0Block == 4
        && h.ring1Block == 6
        && h.ring2Block == 8
        && h.ring3Block == 10
        && h.ring4Block == 12
        && h.maxFoveaBytes == 2097152
        && h.requireReadyPeer == true;
}

void TestDefaults() {
    HybridConfig h;
    Check(h.enabled == false, "default enabled is false");
    Check(h.foveaCodec == 0, "default foveaCodec is 0");
    Check(h.baseCodec == 0, "default baseCodec follows the stream codec");
    Check(h.guardDegrees == 2.0, "default guardDegrees is 2.0");
    Check(h.ring0Degrees == 5.0 && h.ring1Degrees == 10.0 && h.ring2Degrees == 20.0
        && h.ring3Degrees == 35.0 && h.ring4Degrees == 45.0, "default ring degrees are 5/10/20/35/45");
    Check(h.featherPx == 8, "default featherPx is 8");
    Check(h.ring0Block == 4 && h.ring1Block == 6 && h.ring2Block == 8
        && h.ring3Block == 10 && h.ring4Block == 12, "default ring blocks are 4/6/8/10/12");
    Check(h.maxFoveaBytes == 2097152, "default maxFoveaBytes is 2097152");
    Check(h.requireReadyPeer == true, "default requireReadyPeer is true");
}

void TestMissingSectionLeavesDefaults() {
    ParseFresh(json::object());
    Check(DefaultsMatch(driverConfig.hybrid), "missing hybrid section leaves the built-in defaults");

    ParseFresh(json{{"hybrid", 7}});
    Check(DefaultsMatch(driverConfig.hybrid), "non-object hybrid section leaves the built-in defaults");
}

void TestFullDocument() {
    const json input = {{"hybrid", {
        {"enabled", true},
        {"foveaCodec", 2},
        {"baseCodec", 2},
        {"guardDegrees", 3.5},
        {"ring0Degrees", 6.5},
        {"ring1Degrees", 12.5},
        {"ring2Degrees", 22.5},
        {"ring3Degrees", 37.5},
        {"ring4Degrees", 50.5},
        {"featherPx", 12},
        {"ring0Block", 5},
        {"ring1Block", 7},
        {"ring2Block", 9},
        {"ring3Block", 11},
        {"ring4Block", 12},
        {"maxFoveaBytes", 1048576},
        {"requireReadyPeer", false},
    }}};
    ParseFresh(input);
    const HybridConfig& h = driverConfig.hybrid;
    Check(h.enabled == true, "full document parses enabled");
    Check(h.foveaCodec == 2, "full document parses foveaCodec");
    Check(h.baseCodec == 2, "full document parses baseCodec");
    Check(h.guardDegrees == 3.5, "full document parses guardDegrees");
    Check(h.ring0Degrees == 6.5 && h.ring1Degrees == 12.5 && h.ring2Degrees == 22.5
        && h.ring3Degrees == 37.5 && h.ring4Degrees == 50.5, "full document parses every ring degree");
    Check(h.featherPx == 12, "full document parses featherPx");
    Check(h.ring0Block == 5 && h.ring1Block == 7 && h.ring2Block == 9
        && h.ring3Block == 11 && h.ring4Block == 12, "full document parses every ring block");
    Check(h.maxFoveaBytes == 1048576, "full document parses maxFoveaBytes");
    Check(h.requireReadyPeer == false, "full document parses requireReadyPeer");
}

void TestClamps() {
    // Requests are preserved exactly; the producer validates and rejects, it never rewrites.
    ParseFresh(json{{"hybrid", {
        {"foveaCodec", -7}, {"baseCodec", 0}, {"guardDegrees", -4.5},
        {"ring0Degrees", 0.0}, {"ring1Degrees", 0.5}, {"ring2Degrees", -1.0},
        {"ring3Degrees", -50.0}, {"ring4Degrees", 0.0},
        {"featherPx", -3},
        {"ring0Block", 1}, {"ring1Block", 2}, {"ring2Block", 3}, {"ring3Block", -5}, {"ring4Block", 0},
        {"maxFoveaBytes", -1},
    }}});
    {
        const HybridConfig& h = driverConfig.hybrid;
        Check(h.foveaCodec == -7, "foveaCodec preserved");
        Check(h.baseCodec == 0, "baseCodec preserved");
        Check(h.guardDegrees == -4.5, "guardDegrees preserved");
        Check(h.ring0Degrees == 0.0 && h.ring1Degrees == 0.5 && h.ring2Degrees == -1.0
            && h.ring3Degrees == -50.0 && h.ring4Degrees == 0.0, "ring degrees preserved");
        Check(h.featherPx == -3, "featherPx preserved");
        Check(h.ring0Block == 1 && h.ring1Block == 2 && h.ring2Block == 3
            && h.ring3Block == -5 && h.ring4Block == 0, "ring blocks preserved");
        Check(h.maxFoveaBytes == -1, "maxFoveaBytes preserved");
    }

    // Upper bounds and unordered rings are preserved as requested.
    ParseFresh(json{{"hybrid", {
        {"foveaCodec", 99}, {"baseCodec", 7}, {"guardDegrees", 88.0},
        {"ring0Degrees", 100.0}, {"ring1Degrees", 90.0}, {"ring2Degrees", 120.0},
        {"ring3Degrees", 200.0}, {"ring4Degrees", 360.0},
        {"featherPx", 500},
        {"ring0Block", 13}, {"ring1Block", 64}, {"ring2Block", 99}, {"ring3Block", 100}, {"ring4Block", 200},
        {"maxFoveaBytes", 999999999},
    }}});
    {
        const HybridConfig& h = driverConfig.hybrid;
        Check(h.foveaCodec == 99, "upper foveaCodec preserved");
        Check(h.baseCodec == 7, "upper baseCodec preserved");
        Check(h.guardDegrees == 88.0, "upper guardDegrees preserved");
        Check(h.ring0Degrees == 100.0 && h.ring1Degrees == 90.0 && h.ring2Degrees == 120.0
            && h.ring3Degrees == 200.0 && h.ring4Degrees == 360.0, "unordered rings preserved");
        Check(h.featherPx == 500, "upper featherPx preserved");
        Check(h.ring0Block == 13 && h.ring1Block == 64 && h.ring2Block == 99
            && h.ring3Block == 100 && h.ring4Block == 200, "upper ring blocks preserved");
        Check(h.maxFoveaBytes == 999999999, "upper maxFoveaBytes preserved");
    }

    // Exact bounds stay untouched.
    ParseFresh(json{{"hybrid", {
        {"foveaCodec", 2}, {"baseCodec", 2}, {"guardDegrees", 30.0},
        {"ring0Degrees", 89.0}, {"ring1Degrees", 1.0}, {"ring2Degrees", 45.0},
        {"ring3Degrees", 88.0}, {"ring4Degrees", 2.0},
        {"featherPx", 64},
        {"ring0Block", 12}, {"ring1Block", 4}, {"ring2Block", 8}, {"ring3Block", 11}, {"ring4Block", 5},
        {"maxFoveaBytes", 16777216},
    }}});
    {
        const HybridConfig& h = driverConfig.hybrid;
        Check(h.foveaCodec == 2 && h.baseCodec == 2 && h.guardDegrees == 30.0, "in-range codec and guard values are preserved");
        Check(h.ring1Degrees == 1.0 && h.ring4Degrees == 2.0, "in-range lower ring bounds are preserved");
        Check(h.featherPx == 64 && h.maxFoveaBytes == 16777216, "in-range upper bounds are preserved");
    }
}

void TestUnknownKeysIgnored() {
    ParseFresh(json{{"hybrid", {
        {"enabled", true},
        {"foveaCodec", 1},
        {"unknownScalar", 42},
        {"unknownObject", {{"nested", true}}},
        {"unknownArray", json::array({1, 2, 3})},
    }}});
    const HybridConfig& h = driverConfig.hybrid;
    Check(h.enabled == true && h.foveaCodec == 1, "known keys still parse alongside unknown keys");
    Check(h.baseCodec == 0 && h.guardDegrees == 2.0 && h.ring0Degrees == 5.0 && h.featherPx == 8
        && h.maxFoveaBytes == 2097152 && h.requireReadyPeer == true, "unknown keys change no field");
}

void TestIsolationFromOtherSections() {
    const json streamFrame = {
        {"saturation", 77.5},
        {"gamma", 1.25},
        {"enable", false},
        {"postPack", {{"limitedRange", true}}},
        {"nvencCodec", 2},
    };
    const json galaxyXr = {
        {"nativeIdentity", false},
        {"gripTouchThreshold", 0.75},
        {"streamQuality", "high"},
    };
    ParseFresh(json{{"streamFrame", streamFrame}, {"galaxyXr", galaxyXr}});
    const auto beforeSaturation = driverConfig.streamFrame.saturation;
    const auto beforeGamma = driverConfig.streamFrame.gamma;
    const auto beforeEnable = driverConfig.streamFrame.enable;
    const auto beforeLimitedRange = driverConfig.streamFrame.postPack.limitedRange;
    const auto beforeCodec = driverConfig.streamFrame.nvencCodec;
    const auto beforeNativeIdentity = driverConfig.galaxyXr.nativeIdentity;
    const auto beforeGrip = driverConfig.galaxyXr.gripTouchThreshold;
    const auto beforeQuality = driverConfig.galaxyXr.streamQuality;

    ParseFresh(json{
        {"streamFrame", streamFrame},
        {"galaxyXr", galaxyXr},
        {"hybrid", {{"enabled", true}, {"foveaCodec", 2}, {"baseCodec", 2}, {"featherPx", 32}}},
    });
    Check(driverConfig.hybrid.enabled == true, "hybrid can be enabled in the same document");
    Check(driverConfig.streamFrame.saturation == beforeSaturation
        && driverConfig.streamFrame.gamma == beforeGamma
        && driverConfig.streamFrame.enable == beforeEnable
        && driverConfig.streamFrame.postPack.limitedRange == beforeLimitedRange
        && driverConfig.streamFrame.nvencCodec == beforeCodec,
        "enabling hybrid does not alter streamFrame values");
    Check(driverConfig.galaxyXr.nativeIdentity == beforeNativeIdentity
        && driverConfig.galaxyXr.gripTouchThreshold == beforeGrip
        && driverConfig.galaxyXr.streamQuality == beforeQuality,
        "enabling hybrid does not alter galaxyXr values");
}

int main(int argc, char** argv) {
    testFolder = argc > 1 ? std::string(argv[1]) : std::string("hybrid-config-fixture");
    testFolder += "/";
    std::filesystem::create_directories(testFolder);

    TestDefaults();
    TestMissingSectionLeavesDefaults();
    TestFullDocument();
    TestClamps();
    TestUnknownKeysIgnored();
    TestIsolationFromOtherSections();

    std::cout << checks << " checks, " << failures << " failures\n";
    return failures == 0 ? 0 : 1;
}
