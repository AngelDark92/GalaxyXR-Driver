// 2026-09-19 SDR10 baseline: standalone tests for the pure policy resolver
// (SdrColorPolicy.h). no driver, no SteamVR, no live settings IO.
#include "../src/Config/SdrColorPolicy.h"
#include <iostream>
#include <vector>

static int checks = 0;
static int failures = 0;
static void Check(bool success, const char* message) {
    if (success) { ++checks; return; }
    ++checks;
    ++failures;
    std::cerr << "FAIL: " << message << '\n';
}

static Config StoredConfig() {
    Config c = {};
    // deliberately non-neutral stored color controls so a passthrough
    // that leaks baseline values (or the other way around) is visible
    c.streamFrame.enable = true;
    c.streamFrame.saturation = 62;
    c.streamFrame.vibrance = 15;
    c.streamFrame.contrast = 41;
    c.streamFrame.contrastMidpoint = 57;
    c.streamFrame.contrastLinear = true;
    c.streamFrame.gamma = 2.4;
    c.streamFrame.brightness = 1.2;
    c.streamFrame.colorMultiplier = { 0.9, 1.0, 1.1 };
    c.streamFrame.srgbMatrix = { 0.95, 0.0, 0.0, 0.0, 1.05, 0.0, 0.0, 0.0, 0.98 };
    c.streamFrame.dither = true;
    c.streamFrame.blackFloor.rampBar = true; // user debug overlay: NOT baseline-owned
    c.streamFrame.blackFloor.rangeMode = 1;
    c.streamFrame.blackFloor.shadowLift = true;
    c.streamFrame.blackFloor.floorCode = 4.0;
    c.streamFrame.blackFloor.kneeCode = 12.0;
    c.streamFrame.blackFloor.blackPointCode = 3.0;
    c.streamFrame.postPack.enable = true;
    c.streamFrame.postPack.casEnable = true;
    c.streamFrame.postPack.limitedRange = true;
    c.streamFrame.nvencVuiFullRange = 0;
    c.streamFrame.nvencVuiMatrix = 1;
    c.streamFrame.nvencVuiPrimaries = 1;
    c.streamFrame.nvencVuiTransfer = 13;
    // baseline-out-of-scope controls: must survive untouched in EVERY state
    c.streamFrame.cas.enable = true;
    c.streamFrame.fxaaMode = 2;
    c.streamFrame.k1 = 0.012;
    c.streamFrame.distortion.points = { { 0.2, 0.98 } };
    c.streamFrame.calib.blackout = true;
    c.streamFrame.stationaryDimming.enable = true;
    c.streamFrame.nvencBitrateMbit = 450;
    c.streamFrame.nvencMaxQp = 30;
    c.streamFrame.nvencTap = true;
    c.galaxyXr.vrlinkHeadsetProfile = false;
    c.galaxyXr.sdr10Baseline = false; // stored Off fixture; the shipped default is now On
    c.galaxyXr.profileSupports10bit = false;
    c.galaxyXr.force10bit = true; // retired: the baseline must not read or write it
    return c;
}

int main() {
    for(bool baseline : {false, true}) for(bool legacy10bit : {false, true}) {
        GalaxyXrConfig g{};
        g.sdr10Baseline = baseline;
        g.profileSupports10bit = legacy10bit;
        g.customBandwidthMbit = 177;
        g.vrlinkExtraKeys = {{"supports10bit", 'b', 1}};
        Check(gxr::MigrateSdr10Settings(g), "legacy SDR10 settings migrate once");
        Check(g.sdr10SettingsVersion == 2 && g.sdr10Baseline == baseline,
            "migration stamps version 2 without changing baseline selection");
        Check(g.profileSupports10bit == legacy10bit,
            "migration preserves explicitly stored compatibility values");
        Check(g.customBandwidthMbit == 177 && std::get<2>(g.vrlinkExtraKeys.front()) == 1,
            "migration preserves custom tuning and advanced overrides");
        Check(!gxr::MigrateSdr10Settings(g), "SDR10 migration is idempotent");
    }
    {
        GalaxyXrConfig current{};
        current.profileSupports10bit = true;
        GalaxyXrConfig absent{};
        Check(gxr::MigrateSdr10Settings(absent, false) && absent.sdr10Baseline && !absent.profileSupports10bit,
            "never-set baseline defaults ON with the explicit compatibility request still off");
        current.sdr10SettingsVersion = 3;
        Check(!gxr::MigrateSdr10Settings(current) && current.profileSupports10bit,
            "migration leaves current/future compatibility values untouched");
    }
    // 2026-10-23 (owner directive): the shipped default requests the 10-bit
    // SDR baseline. H.264 is 8-bit only and suppresses it so the disabled GUI
    // switch and the real capability request agree.
    {
        Config c{};
        const auto p = gxr::ResolveSdr10Policy(c);
        Check(p.requested && p.active && !p.codecBlocked && p.profileEnabled && p.profileSupports10bit,
            "default config requests the 10-bit SDR baseline");
        c.streamFrame.nvencCodec = 1;
        const auto h264 = gxr::ResolveSdr10Policy(c);
        Check(h264.codecBlocked && !h264.requested && !h264.active && !h264.profileSupports10bit,
            "H.264 suppresses the stored/default 10-bit request");
        c.galaxyXr.profileSupports10bit = true;
        const auto h264Advanced = gxr::ResolveSdr10Policy(c);
        Check(h264Advanced.codecBlocked && !h264Advanced.active && h264Advanced.profileSupports10bit,
            "H.264 keeps an explicit advanced capability request user-owned");
    }
    // 2026-09-25: the removed compatibility toggle must not keep the request
    // enabled when the visible baseline switch is turned off.
    for(bool profile : {false, true}) for(bool legacy10bit : {false, true}) {
        Config c{};
        c.galaxyXr.vrlinkHeadsetProfile = profile;
        c.galaxyXr.profileSupports10bit = legacy10bit;
        c.galaxyXr.sdr10Baseline = true;
        const auto on = gxr::ResolveSdr10Policy(c);
        c.galaxyXr.sdr10Baseline = false;
        const auto off = gxr::ResolveSdr10Policy(c);
        Check(on.profileSupports10bit && off.profileSupports10bit == legacy10bit,
            "ON -> OFF disables the 10-bit request for both profile routes and legacy values");
        Check(off.profileEnabled == profile, "OFF preserves the profile geometry switch");
        Check(c.galaxyXr.profileSupports10bit == legacy10bit, "policy does not rewrite legacy stored values");
    }
    // 2026-10-17 (owner directive): the retired consent gate is never read;
    // the baseline and the master are independent and combine both ways.
    {
        Config combined{};
        combined.galaxyXr.sdr10Baseline = true; // default streamFrame: master ON
        const auto combo = gxr::ResolveSdr10Policy(combined);
        Check(gxr::ImageEnhancementsEnabled(combined.streamFrame, combo), "baseline ON + master ON: enhancements pass enabled");
        Check(combo.postPackEnable == combined.streamFrame.postPack.enable, "baseline ON + master ON: post-pack equals the stored value");
        Check(combo.saturation == combined.streamFrame.saturation, "baseline ON + master ON: stored picture controls pass through");
        Check(combo.profileSupports10bit, "baseline ON + master ON: 10-bit capability request remains active");
        combined.streamFrame.enable = false;
        const auto comboOff = gxr::ResolveSdr10Policy(combined);
        Check(!gxr::ImageEnhancementsEnabled(combined.streamFrame, comboOff) && comboOff.saturation == 50.0 && !comboOff.postPackEnable,
            "baseline ON + master OFF: neutral baseline holds");
        Check(comboOff.profileSupports10bit, "baseline ON + master OFF: 10-bit capability request remains active");
    }
    // ---- stored off: every policy field passes the stored config through exactly ----
    {
        Config c = StoredConfig();
        gxr::Sdr10BaselinePolicy p = gxr::ResolveSdr10Policy(c);
        Check(!p.requested && !p.conflict && !p.active, "stored off: requested/conflict/active all false");
        Check(p.profileEnabled == c.galaxyXr.vrlinkHeadsetProfile, "stored off: profile enabled passes through stored value");
        Check(p.profileSupports10bit == c.galaxyXr.profileSupports10bit, "stored off: supports10bit passes through stored value");
        Check(p.saturation == c.streamFrame.saturation, "stored off: saturation passthrough exact");
        Check(p.vibrance == c.streamFrame.vibrance, "stored off: vibrance passthrough exact");
        Check(p.contrast == c.streamFrame.contrast, "stored off: contrast passthrough exact");
        Check(p.contrastMidpoint == c.streamFrame.contrastMidpoint, "stored off: contrast midpoint passthrough exact");
        Check(p.contrastLinear == c.streamFrame.contrastLinear, "stored off: contrast linear passthrough exact");
        Check(p.gamma == c.streamFrame.gamma, "stored off: gamma passthrough exact");
        Check(p.brightness == c.streamFrame.brightness, "stored off: brightness passthrough exact");
        Check(p.colorMultiplier.r == c.streamFrame.colorMultiplier.r && p.colorMultiplier.g == c.streamFrame.colorMultiplier.g && p.colorMultiplier.b == c.streamFrame.colorMultiplier.b, "stored off: tint passthrough exact");
        Check(p.srgbMatrix == c.streamFrame.srgbMatrix, "stored off: matrix passthrough exact (incl. empty)");
        Check(p.dither == c.streamFrame.dither, "stored off: dither passthrough exact");
        Check(p.blackFloorRangeMode == c.streamFrame.blackFloor.rangeMode, "stored off: black floor range mode passthrough exact");
        Check(p.blackFloorShadowLift == c.streamFrame.blackFloor.shadowLift, "stored off: shadow lift passthrough exact");
        Check(p.blackFloorFloorCode == c.streamFrame.blackFloor.floorCode && p.blackFloorKneeCode == c.streamFrame.blackFloor.kneeCode, "stored off: floor/knee codes passthrough exact");
        Check(p.blackFloorBlackPointCode == c.streamFrame.blackFloor.blackPointCode, "stored off: black point passthrough exact");
        Check(p.postPackEnable == c.streamFrame.postPack.enable, "stored off: post-pack passthrough exact");
        Check(p.vuiFullRange == c.streamFrame.nvencVuiFullRange && p.vuiMatrix == c.streamFrame.nvencVuiMatrix, "stored off: VUI fullRange/matrix passthrough exact");
        Check(p.vuiPrimaries == c.streamFrame.nvencVuiPrimaries && p.vuiTransfer == c.streamFrame.nvencVuiTransfer, "stored off: VUI primaries/transfer passthrough exact");
    }
    // ---- active with the master OFF: every effective value is the neutral baseline ----
    {
        Config c = StoredConfig();
        c.galaxyXr.sdr10Baseline = true;
        c.streamFrame.enable = false; // 2026-10-17: the neutral baseline needs the master off
        gxr::Sdr10BaselinePolicy p = gxr::ResolveSdr10Policy(c);
        Check(p.requested && !p.conflict && p.active, "active: requested true, no conflict, active true");
        Check(p.profileEnabled == true && p.profileSupports10bit == true, "active: profile enabled with supports10bit requested");
        Check(p.saturation == 50.0, "active: saturation neutral 50");
        Check(p.vibrance == 0.0, "active: vibrance neutral 0");
        Check(p.contrast == 50.0, "active: contrast neutral 50");
        Check(p.contrastMidpoint == 50.0, "active: contrast midpoint neutral 50");
        Check(p.contrastLinear == false, "active: contrast in gamma space");
        Check(p.gamma == 2.2, "active: gamma neutral 2.2");
        Check(p.brightness == 1.0, "active: brightness neutral 1");
        Check(p.colorMultiplier.r == 1.0 && p.colorMultiplier.g == 1.0 && p.colorMultiplier.b == 1.0, "active: tint neutral 1/1/1");
        Check(p.srgbMatrix.empty(), "active: color matrix disabled (empty)");
        Check(p.dither == false, "active: host dither off");
        Check(p.blackFloorRangeMode == 0 && p.blackFloorShadowLift == false && p.blackFloorBlackPointCode == 0.0, "active: black floor range/shadow/blackpoint disabled");
        Check(p.postPackEnable == false, "active: post-pack bypassed");
        Check(p.vuiFullRange == -1 && p.vuiMatrix == -1 && p.vuiPrimaries == -1 && p.vuiTransfer == -1, "active: VUI left to Valve's original pair (all -1)");
    }
    // ---- 2026-10-17 (owner directive): the master alone decides; the
    // baseline plus master-ON combination passes stored controls through ----
    {
        Config c = StoredConfig();
        const auto stored = gxr::ResolveSdr10Policy(c);
        c.galaxyXr.sdr10Baseline = true;
        const auto combined = gxr::ResolveSdr10Policy(c); // StoredConfig keeps the master ON
        Check(combined.active && combined.profileEnabled && combined.profileSupports10bit, "master ON under baseline: capability request remains active");
        Check(gxr::ImageEnhancementsEnabled(c.streamFrame, combined), "master ON under baseline: enhancement passes enabled");
        Check(combined.saturation == stored.saturation && combined.vibrance == stored.vibrance && combined.contrast == stored.contrast, "master ON under baseline: stored saturation/vibrance/contrast pass through");
        Check(combined.contrastMidpoint == stored.contrastMidpoint && combined.contrastLinear == stored.contrastLinear && combined.gamma == stored.gamma && combined.brightness == stored.brightness, "master ON under baseline: stored contrast mode/gamma/brightness pass through");
        Check(combined.colorMultiplier.r == stored.colorMultiplier.r && combined.colorMultiplier.g == stored.colorMultiplier.g && combined.colorMultiplier.b == stored.colorMultiplier.b && combined.srgbMatrix == stored.srgbMatrix, "master ON under baseline: stored tint and matrix pass through");
        Check(combined.dither == stored.dither && combined.blackFloorRangeMode == stored.blackFloorRangeMode && combined.blackFloorShadowLift == stored.blackFloorShadowLift, "master ON under baseline: stored dither and black floor mode pass through");
        Check(combined.blackFloorFloorCode == stored.blackFloorFloorCode && combined.blackFloorKneeCode == stored.blackFloorKneeCode && combined.blackFloorBlackPointCode == stored.blackFloorBlackPointCode, "master ON under baseline: stored black floor tuning passes through");
        Check(combined.postPackEnable == stored.postPackEnable && combined.vuiFullRange == stored.vuiFullRange && combined.vuiMatrix == stored.vuiMatrix && combined.vuiPrimaries == stored.vuiPrimaries && combined.vuiTransfer == stored.vuiTransfer, "master ON under baseline: stored post-pack and VUI pass through");
        Check(c.streamFrame.saturation == 62 && !c.galaxyXr.profileSupports10bit, "master ON under baseline: stored settings remain untouched");
        c.streamFrame.enable = false;
        const auto masterOff = gxr::ResolveSdr10Policy(c);
        Check(!gxr::ImageEnhancementsEnabled(c.streamFrame, masterOff) && masterOff.saturation == 50 && !masterOff.postPackEnable && masterOff.vuiFullRange == -1, "master OFF under baseline: neutral picture and metadata restored");
        Check(masterOff.active && masterOff.profileSupports10bit, "master OFF under baseline: 10-bit request remains active");
        c.streamFrame.enable = true;
        c.galaxyXr.sdr10AllowEnhancements = true;
        const auto consentStamped = gxr::ResolveSdr10Policy(c);
        c.galaxyXr.sdr10AllowEnhancements = false;
        const auto consentCleared = gxr::ResolveSdr10Policy(c);
        Check(consentStamped.saturation == consentCleared.saturation && consentStamped.postPackEnable == consentCleared.postPackEnable
            && consentStamped.vuiFullRange == consentCleared.vuiFullRange && consentStamped.profileSupports10bit == consentCleared.profileSupports10bit,
            "retired consent value never changes resolution (owner directive 2026-10-17)");
        c.galaxyXr.sdr10Baseline = false;
        const auto off = gxr::ResolveSdr10Policy(c);
        Check(!off.active && off.saturation == stored.saturation && off.profileSupports10bit == stored.profileSupports10bit, "baseline off: no effect on existing behavior");
    }
    // ---- resolve is const-correct and leaves the stored config unmodified ----
    {
        Config c = StoredConfig();
        c.galaxyXr.sdr10Baseline = true;
        const Config &ref = c; // resolver takes a const reference
        gxr::Sdr10BaselinePolicy p = gxr::ResolveSdr10Policy(ref);
        (void)p;
        Check(c.streamFrame.saturation == 62.0 && c.streamFrame.srgbMatrix.size() == 9 && c.streamFrame.postPack.enable, "active resolve: stored color config unmodified (not a preset)");
        Check(c.streamFrame.blackFloor.rangeMode == 1 && c.streamFrame.blackFloor.shadowLift, "active resolve: stored black floor unmodified");
        Check(c.streamFrame.nvencVuiFullRange == 0 && c.streamFrame.nvencVuiTransfer == 13, "active resolve: stored VUI values unmodified");
        Check(c.galaxyXr.vrlinkHeadsetProfile == false && c.galaxyXr.profileSupports10bit == false, "active resolve: stored profile settings unmodified");
    }
    // ---- reversibility: disabling restores the exact prior stored values ----
    {
        Config c = StoredConfig();
        c.galaxyXr.sdr10Baseline = true;
        gxr::Sdr10BaselinePolicy on = gxr::ResolveSdr10Policy(c);
        Check(on.active, "reversibility: baseline active while requested");
        c.galaxyXr.sdr10Baseline = false;
        gxr::Sdr10BaselinePolicy off = gxr::ResolveSdr10Policy(c);
        Check(!off.active && off.requested == false && off.conflict == false, "reversibility: off again after toggle");
        Check(off.saturation == 62.0 && off.vibrance == 15.0 && off.contrast == 41.0 && off.contrastMidpoint == 57.0, "reversibility: exact prior saturation/vibrance/contrast restored");
        Check(off.contrastLinear == true && off.gamma == 2.4 && off.brightness == 1.2, "reversibility: exact prior contrastLinear/gamma/brightness restored");
        Check(off.colorMultiplier.r == 0.9 && off.colorMultiplier.b == 1.1 && off.srgbMatrix.size() == 9, "reversibility: exact prior tint/matrix restored");
        Check(off.dither == true, "reversibility: host dither restored");
        Check(off.blackFloorRangeMode == 1 && off.blackFloorShadowLift == true && off.blackFloorFloorCode == 4.0 && off.blackFloorBlackPointCode == 3.0, "reversibility: exact prior black floor restored");
        Check(off.postPackEnable == true, "reversibility: post-pack restored");
        Check(off.vuiFullRange == 0 && off.vuiMatrix == 1 && off.vuiPrimaries == 1 && off.vuiTransfer == 13, "reversibility: exact prior VUI values restored");
        Check(off.profileEnabled == false && off.profileSupports10bit == false, "reversibility: stored profile request restored (baseline did not persist anything)");
    }
    // ---- conflict: custom shader for "other" headsets owns the color path ----
    {
        Config c = StoredConfig();
        c.galaxyXr.sdr10Baseline = true;
        c.customShader.enable = true;
        c.customShader.enableForOther = true; // Galaxy XR lands in the "other" bucket
        gxr::Sdr10BaselinePolicy p = gxr::ResolveSdr10Policy(c);
        Check(p.requested && p.conflict && !p.active, "conflict: requested true, conflict true, active false");
        Check(p.saturation == c.streamFrame.saturation && p.srgbMatrix == c.streamFrame.srgbMatrix, "conflict: stored color passthrough (baseline not applied at all)");
        Check(p.postPackEnable == c.streamFrame.postPack.enable, "conflict: stored post-pack passthrough");
        Check(p.profileEnabled == c.galaxyXr.vrlinkHeadsetProfile && p.profileSupports10bit == c.galaxyXr.profileSupports10bit, "conflict: stored profile request passthrough");
    }
    {
        // custom shader enabled but NOT for "other" headsets: no conflict
        Config c = StoredConfig();
        c.galaxyXr.sdr10Baseline = true;
        c.customShader.enable = true;
        c.customShader.enableForOther = false;
        gxr::Sdr10BaselinePolicy p = gxr::ResolveSdr10Policy(c);
        Check(p.requested && !p.conflict && p.active, "no conflict: custom shader on but not for this headset -> baseline active");
        Check(p.saturation == c.streamFrame.saturation && p.postPackEnable == c.streamFrame.postPack.enable, "no conflict: master ON passes stored picture controls through (owner directive 2026-10-17)");
        c.streamFrame.enable = false;
        const auto neutral = gxr::ResolveSdr10Policy(c);
        Check(neutral.saturation == 50.0 && neutral.postPackEnable == false, "no conflict: master OFF still applies the neutral baseline");
    }
    {
        // custom shader disabled entirely: no conflict
        Config c = StoredConfig();
        c.galaxyXr.sdr10Baseline = true;
        c.customShader.enable = false;
        c.customShader.enableForOther = true;
        gxr::Sdr10BaselinePolicy p = gxr::ResolveSdr10Policy(c);
        Check(p.requested && !p.conflict && p.active, "no conflict: custom shader master off -> baseline active");
    }
    // ---- out-of-scope controls are untouched in every state ----
    {
        Config c = StoredConfig();
        c.galaxyXr.sdr10Baseline = true;
        gxr::Sdr10BaselinePolicy p = gxr::ResolveSdr10Policy(c);
        (void)p;
        Check(c.streamFrame.cas.enable && c.streamFrame.fxaaMode == 2 && c.streamFrame.k1 == 0.012, "untouched: CAS/FXAA/distortion unchanged while active");
        Check(c.streamFrame.calib.blackout && c.streamFrame.stationaryDimming.enable, "untouched: blackout/dimming safety unchanged while active");
        Check(c.streamFrame.nvencBitrateMbit == 450 && c.streamFrame.nvencMaxQp == 30 && c.streamFrame.nvencTap, "untouched: bitrate/QP/tap master unchanged while active");
        Check(c.streamFrame.blackFloor.rampBar, "untouched: user ramp-bar debug overlay unchanged while active");
        // force10bit stays retired: the policy exposes no force field and
        // the active profile request comes from the profile, not from it
        gxr::Sdr10BaselinePolicy active = gxr::ResolveSdr10Policy(c);
        Check(c.galaxyXr.force10bit == true && active.profileSupports10bit == true, "force10bit: stored value untouched, baseline request is the profile's supports10bit");
        // default config: nothing changes about the retired flag either
        Config d = {};
        d.galaxyXr.sdr10Baseline = true;
        d.galaxyXr.force10bit = false;
        gxr::Sdr10BaselinePolicy pd = gxr::ResolveSdr10Policy(d);
        Check(pd.active && d.galaxyXr.force10bit == false, "force10bit: default stays retired under the baseline");
    }
    if (failures > 0) {
        std::cerr << checks << " checks, " << failures << " FAILURES" << '\n';
        return 1;
    }
    std::cout << "SdrColorPolicy: " << checks << " checks passed" << '\n';
    return 0;
}
