#include "../src/Driver/FrameProcessor.h"
#include "../src/Driver/NvencTap.h"
#include "../src/Driver/NvencPostPack.h"
#include "../src/Driver/VrlinkTap.h"
#include "../src/Driver/ReconLogger.h"
#include "../src/Driver/ZeroCopy.h"
#include "../src/Config/ConfigLoader.h"
#include "../src/Config/DebugModePolicy.h"
#include <cmath>
#include <cstdlib>
#include <iostream>
#include <string>

// tools/Test-CasActivation.ps1 compiles the verbatim production activity block.
bool CasEyeActivityForTest(FrameProcessSettings settings, double dimFactor);

namespace {
int checks = 0;
int failures = 0;
int tapUpdates = 0;
int postPackUpdates = 0;
int vrlinkTapUpdates = 0;
int installCalls = 0;
int heartbeatCalls = 0;
int bandwidthCalls = 0;
int tileCalls = 0;
NvencTapConfig lastTap;
NvencPostPackConfig lastPostPack;

void Check(bool condition, const std::string& description) {
    ++checks;
    if (!condition) {
        ++failures;
        std::cerr << "FAIL: " << description << '\n';
    }
}

void Near(float actual, double expected, const char* description) {
    Check(std::abs(actual - expected) < 0.000001, description);
}

// Run the production dispatcher without any scene textures or GPU. Only its
// external side effects are captured below; policy uses the real resolver.
void Dispatch(const Config& config, const char* label) {
    FrameProcessSettings settings;
    settings.config = config.streamFrame;
    settings.policy = gxr::ResolveSdr10Policy(config);
    const int previousTapUpdates = tapUpdates;
    const int previousPostPackUpdates = postPackUpdates;
    const int previousVrlinkTapUpdates = vrlinkTapUpdates;
    const int previousInstallCalls = installCalls;
    const int previousHeartbeatCalls = heartbeatCalls;
    FrameProcessor::UpdateEncoderSettings(settings);
    Check(tapUpdates == previousTapUpdates + 1, std::string(label) + ": encoder snapshot published");
    Check(postPackUpdates == previousPostPackUpdates + 1, std::string(label) + ": post-pack snapshot published");
    Check(vrlinkTapUpdates == previousVrlinkTapUpdates + 1, std::string(label) + ": vrlink tap snapshot published");
    Check(installCalls == previousInstallCalls + (config.streamFrame.nvencTap ? 1 : 0),
        std::string(label) + ": installation follows NVENC master");
    Check(heartbeatCalls == previousHeartbeatCalls + (config.streamFrame.nvencTap ? 1 : 0),
        std::string(label) + ": heartbeat follows NVENC master");
}

bool EyeActive(const Config& config, bool applyColor = true) {
    FrameProcessSettings settings;
    settings.config = config.streamFrame;
    settings.policy = gxr::ResolveSdr10Policy(config);
    settings.config.enable = gxr::ImageEnhancementsEnabled(settings.config, settings.policy);
    settings.applyColor = applyColor;
    return CasEyeActivityForTest(settings, 0);
}

void CheckEyeActivity() {
    const struct {
        const char* name;
        void (*configure)(StreamFrameConfig&);
    } cases[] = {
        { "FXAA fast", [](auto& s) { s.fxaaMode = 1; } },
        { "FXAA quality", [](auto& s) { s.fxaaMode = 2; } },
        { "Vibrance", [](auto& s) { s.vibrance = 25; } },
        { "Black-floor ramp", [](auto& s) { s.blackFloor.rampBar = true; } },
        { "Range compression", [](auto& s) { s.blackFloor.rangeMode = 1; } },
        { "Range expansion", [](auto& s) { s.blackFloor.rangeMode = 2; } },
        { "Shadow lift", [](auto& s) { s.blackFloor.shadowLift = true; } },
        { "Black point", [](auto& s) { s.blackFloor.blackPointCode = 3; } },
        { "Left horizontal alignment", [](auto& s) { s.alignment.leftH = 0.002; } },
        { "Left vertical alignment", [](auto& s) { s.alignment.leftV = 0.002; } },
        { "Right horizontal alignment", [](auto& s) { s.alignment.rightH = 0.002; } },
        { "Right vertical alignment", [](auto& s) { s.alignment.rightV = 0.002; } },
    };
    for(const auto& test : cases) {
        Config config;
        config.streamFrame.enable = true;
        test.configure(config.streamFrame);
        Check(EyeActive(config), std::string(test.name) + " activates with neutral other controls");
        config.streamFrame.enable = false;
        Check(!EyeActive(config), std::string(test.name) + " respects enhancements OFF");
        config.streamFrame.enable = true;
        config.galaxyXr.sdr10Baseline = true;
        Check(EyeActive(config), std::string(test.name) + " activates under SDR10 with the master ON (owner directive 2026-10-17)");
        config.galaxyXr.sdr10AllowEnhancements = true; // retired gate: must not change the outcome
        Check(EyeActive(config), std::string(test.name) + " activates under SDR10 with the retired consent value set");
        config.streamFrame.enable = false;
        Check(!EyeActive(config), std::string(test.name) + " respects enhancements OFF under SDR10");
    }
    Config config;
    config.streamFrame.enable = true;
    Check(!EyeActive(config), "neutral eye controls retain identity fast path");
    config.streamFrame.vibrance = 25;
    Check(!EyeActive(config, false), "dashboard color bypass also bypasses vibrance-only work");
    config.streamFrame.fxaaMode = 2;
    Check(EyeActive(config, false), "dashboard color bypass does not bypass FXAA");
    config = Config{};
    config.streamFrame.enable = true;
    config.streamFrame.pupilSwim.centerStrengthX = 0.2;
    config.streamFrame.distortion.annulus.enable = true;
    Check(!EyeActive(config), "center/annulus controls with identity distortion remain inert");
    config.streamFrame.k1 = 0.02;
    Check(EyeActive(config), "center/annulus controls retain active distortion processing");
}
}

// Link-time substitutes prevent loading NVENC, SteamVR, or a graphics device.
NvencTap& NvencTap::Get() { static NvencTap tap; return tap; }
void NvencTap::SetConfig(const NvencTapConfig& value) { lastTap = value; ++tapUpdates; }
void NvencTap::TryInstall() { ++installCalls; }
void NvencTap::MaybeHeartbeat() { ++heartbeatCalls; }
void NvencPostPack::SetConfig(const NvencPostPackConfig& value) { lastPostPack = value; ++postPackUpdates; }
// 2026-10-17: the ASW publisher joined UpdateEncoderSettings (1488b1e); the
// real VrlinkTap install/publish path never runs in this harness.
VrlinkTap& VrlinkTap::Get() { static VrlinkTap tap; return tap; }
void VrlinkTap::SetConfig(bool) { ++vrlinkTapUpdates; }
int GalaxyXR_EffectiveBandwidthMbit() { ++bandwidthCalls; return 432; }
int GalaxyXR_EffectiveTileWidth() { ++tileCalls; return 1536; }

// MSVC resolves these references before removing unused eye-processing code.
// They must never execute in this test. ConfigLoader has a data-only default
// constructor; neither its file access nor watcher methods are linked or called.
ConfigLoader driverConfigLoader;
[[noreturn]] static void UnexpectedEyeProcessing() {
    std::cerr << "FAIL: encoder settings dispatch invoked eye processing\n";
    std::abort();
}
void DriverLog(const char*, ...) { UnexpectedEyeProcessing(); }
ReconLogger& ReconLogger::Get() { UnexpectedEyeProcessing(); }
void ReconLogger::NoteProcessingDevice(ID3D11Device*) { UnexpectedEyeProcessing(); }
void ReconLogger::InstallOnce(ID3D11DeviceContext*) { UnexpectedEyeProcessing(); }
void ReconLogger::NoteLayerDimensions(uint32_t, uint32_t) { UnexpectedEyeProcessing(); }
void ReconLogger::ResetSuppression() { UnexpectedEyeProcessing(); }
ZeroCopyV3& ZeroCopyV3::Get() { static ZeroCopyV3 instance; return instance; }
void ZeroCopyV3::SetProcessingDevice(ID3D11Device*) { UnexpectedEyeProcessing(); }
void ZeroCopyV3::PublishShadow(uint32_t, uint32_t, int, HANDLE) { UnexpectedEyeProcessing(); }
void ZeroCopyV3::MarkFresh(uint32_t, uint32_t, int) { UnexpectedEyeProcessing(); }
void ZeroCopyV3::MaybeHeartbeat() { UnexpectedEyeProcessing(); }

int main() {
    CheckEyeActivity();
    Config config;
    config.streamFrame.enable = true;
    config.streamFrame.zeroCopyV3 = true;
    config.streamFrame.contrast = 75;
    Dispatch(config, "Zero-copy enabled before eye activity");
    Check(!ZeroCopyV3::Get().Armed(), "enabling zero-copy waits for active eye work");
    Check(EyeActive(config) && ZeroCopyV3::Get().Armed(), "active eye processing arms zero-copy");
    config.streamFrame.zeroCopyV3 = false;
    Dispatch(config, "Zero-copy feature OFF without another frame");
    Check(!ZeroCopyV3::Get().Armed(), "feature OFF disarms immediately while parent remains ON");
    ZeroCopyV3::Get().SetArmed(true);
    Check(!ZeroCopyV3::Get().Armed(), "disabled feature rejects old activity updates");
    config.streamFrame.zeroCopyV3 = true;
    Dispatch(config, "Zero-copy feature re-enabled before fresh activity");
    Check(!ZeroCopyV3::Get().Armed(), "re-enable cannot restore activity from before OFF");
    Check(EyeActive(config) && ZeroCopyV3::Get().Armed(), "fresh eye work re-arms enabled feature");
    config.streamFrame.enable = false;
    Dispatch(config, "Zero-copy parent OFF without another frame");
    Check(!ZeroCopyV3::Get().Armed(), "parent OFF disarms without an eye pass");
    ZeroCopyV3::Get().SetArmed(true);
    Check(!ZeroCopyV3::Get().Armed(), "old eye activity cannot arm a disabled parent");
    config.streamFrame.zeroCopyV3 = false;
    Dispatch(config, "Zero-copy OFF after parent OFF");
    Check(!EyeActive(config) && !ZeroCopyV3::Get().Armed(), "feature OFF remains disarmed with inactive parent");
    config.streamFrame.enable = true;
    Dispatch(config, "Parent ON with zero-copy OFF");
    Check(EyeActive(config) && !ZeroCopyV3::Get().Armed(), "active pixels do not arm zero-copy while OFF");
    config.streamFrame.zeroCopyV3 = true;
    Dispatch(config, "Zero-copy re-enabled");
    Check(EyeActive(config) && ZeroCopyV3::Get().Armed(), "re-enabling restores arming with eye work");
    config.streamFrame.contrast = 50;
    Check(!EyeActive(config) && !ZeroCopyV3::Get().Armed(), "removing last eye effect disarms zero-copy");
    Dispatch(config, "Neutral eye work provider tick");
    Check(!ZeroCopyV3::Get().Armed(), "provider tick does not re-arm inactive eye processing");
    config.streamFrame.contrast = 75;
    Check(EyeActive(config) && ZeroCopyV3::Get().Armed(), "restoring eye work arms again");
    config.galaxyXr.sdr10Baseline = true;
    config.galaxyXr.sdr10AllowEnhancements = false; // retired gate: clearing it must not disarm
    Dispatch(config, "SDR10 baseline with the master ON");
    Check(ZeroCopyV3::Get().Armed(), "SDR10 baseline with the master ON keeps eye work armed (owner directive 2026-10-17)");
    config.streamFrame.enable = false;
    Dispatch(config, "Master OFF under SDR10 baseline");
    Check(!ZeroCopyV3::Get().Armed(), "master OFF under SDR10 disarms immediately");
    config = Config{};
    bandwidthCalls = 0;
    tileCalls = 0;
    config.streamFrame.enable = true;
    Dispatch(config, "Neutral picture with post-pack CAS");
    Check(lastPostPack.enable && lastPostPack.casEnable, "neutral picture enables post-pack CAS without an eye pass");
    Check(!lastPostPack.limitedRange, "fresh config leaves the limited-range remap OFF (owner directive 2026-10-17)");
    Check(lastTap.enabled, "NVENC enabled with neutral picture");
    Near(lastPostPack.foveaStrength, 0.6, "default fovea strength delivered");
    Near(lastPostPack.peripheryStrength, 0.3, "default periphery strength delivered");
    Check(lastTap.bitrateMbit == 432 && bandwidthCalls == 1, "effective bandwidth used when no encoder override exists");
    Check(lastTap.effectiveTileWidth == 1536 && tileCalls == 1 && !lastTap.enforceTile, "geometry published and unenforced in the neutral build");

    config.streamFrame.postPack.foveaStrength = 0.81;
    config.streamFrame.postPack.peripheryStrength = 0.17;
    config.streamFrame.postPack.edgeFalloff = 0.23;
    config.streamFrame.postPack.foveaTop = false;
    config.streamFrame.nvencBitrateMbit = 321;
    Dispatch(config, "Live post-pack tuning");
    Near(lastPostPack.foveaStrength, 0.81, "changed fovea strength delivered");
    Near(lastPostPack.peripheryStrength, 0.17, "changed periphery strength delivered");
    Near(lastPostPack.edgeFalloff, 0.23, "changed edge falloff delivered");
    Check(!lastPostPack.foveaTop && !lastTap.qpFoveaTop, "tile placement preserved across pixel and encoder configs");
    Near(lastTap.qpEdgeFalloff, 0.23, "QP map receives matching falloff");
    Check(lastTap.bitrateMbit == 321 && bandwidthCalls == 1, "explicit bitrate avoids bandwidth fallback");

    config.galaxyXr.sdr10Baseline = true;
    config.galaxyXr.sdr10AllowEnhancements = true; // retired gate: must not gate anything
    config.streamFrame.nvencVuiFullRange = 1; // non-default: the passthrough proof needs a value the neutral path would overwrite
    Dispatch(config, "SDR10 baseline with the master ON");
    Check(lastPostPack.enable && lastPostPack.casEnable, "SDR10 baseline with the master ON permits post-pack CAS (owner directive 2026-10-17)");
    Check(lastTap.postPackEnabled && !lastTap.postPackLimitedRange, "SDR10 baseline with the master ON keeps post-pack active with the remap at its stored Off");
    Check(lastTap.vuiFullRange == 1, "SDR10 baseline with the master ON passes stored range metadata through");

    config.galaxyXr.sdr10AllowEnhancements = false;
    Dispatch(config, "SDR10 baseline with the retired consent cleared");
    Check(lastPostPack.enable && lastTap.postPackEnabled, "clearing the retired consent value leaves the combination active");

    config.streamFrame.enable = false;
    Dispatch(config, "Enhancements OFF under SDR10");
    Check(!lastPostPack.enable && !lastTap.postPackEnabled && lastTap.vuiFullRange == 1, "master OFF bypasses post-pack and remap under SDR10; manual range metadata stays user-owned");

    config.galaxyXr.sdr10Baseline = false;
    config.streamFrame.enable = true;
    config.streamFrame.postPack.limitedRange = true; // explicit opt-in; the remap default is Off (owner directive 2026-10-17)
    config.streamFrame.nvencVuiFullRange = 1;
    config.streamFrame.nvencVuiMatrix = 9;
    config.streamFrame.nvencVuiPrimaries = 4;
    config.streamFrame.nvencVuiTransfer = 13;
    Dispatch(config, "Limited range with manual VUI");
    Check(lastPostPack.enable && lastPostPack.limitedRange,
        "active limited-range pixels keep the range request");
    Check(lastTap.vuiFullRange == 1 && lastTap.postPackEnabled && lastTap.postPackLimitedRange,
        "manual metadata kept as entered; conflicting range pair surfaces for the tap to refuse");
    Check(lastTap.vuiMatrix == 9 && lastTap.vuiPrimaries == 4 && lastTap.vuiTransfer == 13,
        "manual matrix, primaries, and transfer preserved");
    config.streamFrame.enable = false;
    Dispatch(config, "Enhancements OFF without eye work");
    Check(!lastPostPack.enable, "master OFF publishes disabling snapshot without an eye pass");
    Check(lastTap.vuiFullRange == 1, "master OFF removes remap override and restores manual range metadata");

    config.streamFrame.enable = true;
    Dispatch(config, "Re-enable before NVENC OFF");
    Check(lastPostPack.enable, "post-pack active before NVENC OFF transition");
    config.streamFrame.nvencTap = false;
    Dispatch(config, "NVENC OFF");
    Check(!lastTap.enabled && !lastPostPack.enable, "NVENC OFF disables previously active post-pack processing");
    Check(lastTap.vuiFullRange == 1, "NVENC OFF removes remap range override");

    config.streamFrame.nvencTap = true;
    config.streamFrame.postPack.casEnable = false;
    config.streamFrame.cas.enable = true;
    Dispatch(config, "Switch to pre-encode CAS");
    Check(!lastPostPack.casEnable, "pre-encode selection clears post-pack sharpening");
    Check(lastPostPack.enable && lastPostPack.limitedRange,
        "pre-encode selection keeps the requested range processing");
    Check(lastTap.vuiFullRange == 1 && lastTap.postPackEnabled && lastTap.postPackLimitedRange,
        "conflicting manual metadata stays user-authoritative and visible to the tap");
    config.streamFrame.cas.enable = false;
    Dispatch(config, "CAS OFF with range remap");
    Check(!lastPostPack.casEnable && lastPostPack.enable && lastPostPack.limitedRange,
        "CAS OFF keeps independently requested range processing active");
    Check(lastTap.vuiFullRange == 1 && lastPostPack.enable && lastPostPack.limitedRange,
        "CAS OFF keeps range processing with the conflict pair visible to the tap");

    config.streamFrame.postPack.limitedRange = false;
    Dispatch(config, "No range remap");
    Check(!lastPostPack.limitedRange && lastTap.vuiFullRange == 1,
        "without remap manual full-range metadata survives");
    config.streamFrame.postPack.limitedRange = true;
    config.streamFrame.postPack.enable = false;
    Dispatch(config, "Post-pack OFF");
    Check(!lastPostPack.enable && lastTap.vuiFullRange == 1,
        "post-pack OFF disables remap and its metadata override");

    Config selected;
    selected.streamFrame.nvencVerbose = true;
    selected.streamFrame.nvencFixLevel = true;
    selected.streamFrame.nvencForceFps = 72;
    selected.streamFrame.nvencBitrateMbit = 123;
    selected.streamFrame.nvencMaxBitrateHeadroomPct = 20;
    selected.streamFrame.blackFloor.blackPointCode = 3.5;
    for(bool debugMode : {false, true}) {
        Config effective = selected;
        effective.debugMode = debugMode;
        gxr::ApplyDebugModePolicy(effective);
        Dispatch(effective, "Debug Mode encoder policy");
        Check(lastTap.verbose == debugMode, "master gates verbose publication");
        Check(lastTap.fixLevel && lastTap.forceFps == 72 && lastTap.bitrateMbit == 123,
            "master preserves compatibility and rate publication");
        Check(effective.streamFrame.nvencMaxBitrateHeadroomPct == 20 && effective.streamFrame.blackFloor.blackPointCode == 3.5,
            "master preserves headroom and black-point tuning");
    }
    std::cout << "CAS activation: " << checks << " checks, " << failures << " failures\n";
    return failures == 0 ? 0 : 1;
}
