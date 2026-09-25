#include "../src/Config/VrlinkSettingsRouting.h"
#include "../src/Config/SdrColorPolicy.h"
#include "../src/Config/SteamVRSettingsJournal.h"
#include "../src/Headsets/GalaxyXRStatusIcons.h"
#include <iostream>
#include <set>
#include <vector>
using gxrsettings::Json;
static int checks = 0, failures = 0;
static void Check(bool result, const char* description) {
    ++checks;
    if(!result) { ++failures; std::cerr << "FAIL: " << description << '\n'; }
}
int main() {
    const std::vector<std::string> models = {"", "xrvst2ue", "Galaxy XR", "Oculus Quest Pro", "PICO 4 Pro", "Patched Quest Identity"};
    const std::vector<std::string> profiles = {"vrlink_xrvst2ue", "vrlink_Oculus Quest Pro", "vrlink_PICO 4 Pro"};
    const std::vector<std::string> tuning = {"driver_vrlink", "vrlink_xrvst2ue", "vrlink_Oculus Quest Pro", "vrlink_PICO 4 Pro"};
    for(const auto& model : models) {
        Check(gxr::VrlinkCapabilitySection(true, model) == "vrlink_xrvst2ue", "ON always uses exact Galaxy capability section");
        Check(gxr::VrlinkCapabilitySection(false, model) == "vrlink_" + (model.empty() ? "xrvst2ue" : model), "OFF preserves original-model capability destination");
        Check(gxr::VrlinkCapabilitySections(true, model) == profiles, "ON mirrors capabilities to the exact three model identities");
        Check(gxr::VrlinkCapabilitySections(false, model) == std::vector<std::string>{"vrlink_" + (model.empty() ? "xrvst2ue" : model)}, "OFF retains only the original-model capability destination");
        for(bool baseline : {false, true}) for(bool profile : {false, true}) {
            Config config{}; config.galaxyXr.sdr10Baseline = baseline; config.galaxyXr.vrlinkHeadsetProfile = profile;
            const auto policy = gxr::ResolveSdr10Policy(config);
            Check(std::string(gxr::VrlinkTuningSection(profile)) == "driver_vrlink", "primary tuning reads always use the consumed global section");
            Check(gxr::VrlinkTuningSections(profile) == (profile ? tuning : std::vector<std::string>{"driver_vrlink"}), "global tuning is always written and ON retains all three mirrors");
            for(const auto& key : {"renderWidth", "streamFormatWidth", "targetBandwidth", "automaticBandwidth", "customOldExpertKey"})
                Check(!gxr::ShouldRestoreInactiveVrlinkKey("driver_vrlink", key, profile, model), "route cleanup never restores consumed global tuning for any headset identity");
            const auto capabilities = gxr::VrlinkCapabilitySections(profile, model);
            Check(std::find(capabilities.begin(), capabilities.end(), "driver_vrlink") == capabilities.end(), "capability requests never leak into the global tuning destination");
            Check(!baseline || policy.profileEnabled, "baseline still requests legacy capabilities when profile is off");
            Check(config.galaxyXr.vrlinkHeadsetProfile == profile, "resolver does not change the saved profile switch");
        }
    }
    // 2026-09-25: combined picture modes require explicit warning consent.
    // Older overlapping files remain bypassed without rewriting stored state.
    for(bool baseline : {false, true}) for(bool enhancements : {false, true}) for(bool consent : {false, true}) {
        Config config{};
        config.galaxyXr.sdr10Baseline = baseline;
        config.streamFrame.enable = enhancements;
        config.galaxyXr.sdr10AllowEnhancements = consent;
        config.customShader.enableForOther = false;
        const auto policy = gxr::ResolveSdr10Policy(config);
        Check(gxr::ImageEnhancementsEnabled(config.streamFrame, policy) == (enhancements && (!baseline || consent)), "baseline/master/consent truth table gates all enhancement passes");
        Check(config.streamFrame.enable == enhancements, "runtime mode gate does not rewrite stored master");
        Check(config.galaxyXr.sdr10Baseline == baseline, "runtime mode gate preserves stored baseline");
        Check(config.galaxyXr.sdr10AllowEnhancements == consent, "runtime mode gate preserves stored consent");
        Check(!baseline || (policy.active && policy.profileSupports10bit), "baseline still requests 10-bit regardless of enhancement consent");
    }
    {
        Config config{};
        config.galaxyXr.sdr10Baseline = true;
        config.streamFrame.enable = true;
        config.customShader.enable = true;
        config.customShader.enableForOther = true;
        const auto policy = gxr::ResolveSdr10Policy(config);
        Check(policy.conflict && !policy.active, "external custom-shader conflict remains detectable");
        Check(!gxr::ImageEnhancementsEnabled(config.streamFrame, policy), "requested baseline still disables normal enhancements in conflict");
    }
    Check(gxr::IsVrlinkCapabilityKey("supports10bit"), "supports10bit is classified as a capability");
    Check(gxr::IsVrlinkTuningKey("overrideRenderHeight"), "render height follows tuning route");
    Check(!gxr::IsVrlinkTuningKey("enable"), "driver enablement is not profile tuning");
    Check(!gxr::IsVrlinkTuningKey("blocked_by_safe_mode"), "safe-mode protection is not moved");
    Check(!gxr::IsVrlinkSettingsSection("steamvr"), "SteamVR global keys remain global");
    Check(!gxr::IsVrlinkSettingsSection("driver_GalaxyXRNative"), "Galaxy driver registration remains separate");
    Check(gxr::IsVrlinkSettingsSection("vrlink_xrvst2ue"), "Galaxy profile is eligible for owned-key restoration");
    Check(gxr::IsVrlinkSettingsSection("driver_vrlink"), "legacy tuning section is eligible");
    Check(!gxr::ShouldRestoreInactiveVrlinkKey("driver_vrlink", "customOldExpertKey", true, "Patched"), "historical expert key is retained in the active global route");
    Check(!gxr::ShouldRestoreInactiveVrlinkKey("driver_vrlink", "enable", true, "Patched"), "driver enablement remains untouched during route cleanup");
    for(bool profile : {false, true}) for(const auto& key : {"enable", "blocked_by_safe_mode", "hasBeenRun"})
        Check(!gxr::ShouldRestoreInactiveVrlinkKey("driver_vrlink", key, profile, "Oculus Quest Pro"), "driver lifecycle keys remain separate from global tuning");
    Check(!gxr::ShouldRestoreInactiveVrlinkKey("vrlink_Patched", "supports10bit", false, ""), "early OFF routing does not guess and erase previous patched profile");
    Check(gxr::ShouldRestoreInactiveVrlinkKey("vrlink_Patched", "supports10bit", true, "Patched"), "ON routes old patched capability keys to exact Galaxy section");
    Check(!gxr::ShouldRestoreInactiveVrlinkKey("vrlink_xrvst2ue", "targetBandwidth", true, "Patched"), "selected profile is never cleaned as inactive");
    Check(gxr::ShouldRestoreInactiveVrlinkKey("vrlink_xrvst2ue", "targetBandwidth", false, "Patched"), "OFF releases previously profile-scoped tuning");
    for(const auto& section : profiles) {
        for(const auto& key : {"supports10bit", "targetBandwidth", "customOldExpertKey"})
            Check(!gxr::ShouldRestoreInactiveVrlinkKey(section, key, true, "Patched"), "ON retains every active mirrored capability/tuning/expert key");
        Check(gxr::ShouldRestoreInactiveVrlinkKey(section, "targetBandwidth", false, "Oculus Quest Pro"), "OFF releases tuning from all mirrored profiles");
        Check(gxr::ShouldRestoreInactiveVrlinkKey(section, "supports10bit", false, "Oculus Quest Pro") == (section != "vrlink_Oculus Quest Pro"), "OFF retains only detected model capabilities");
        Check(!gxr::ShouldRestoreInactiveVrlinkKey(section, "supports10bit", false, ""), "early OFF retains capabilities until model detection");
        Check(!gxr::ShouldRestoreInactiveVrlinkKey(section, "enable", true, "Patched"), "mirrored profile lifecycle keys remain separate");
    }
    Check(!gxr::ShouldRestoreInactiveVrlinkKey("steamvr", "preferredRefreshRate", true, "Patched"), "global compositor refresh is not relocated");
    bool present = true; Json value;
    // 2026-09-24: retire the native-resolution option's implicit refresh writes
    // without overwriting a later user-selected 75 Hz or an external deletion.
    std::vector<std::string> refreshSections = tuning;
    refreshSections.push_back("steamvr");
    for(const auto& section : refreshSections) for(bool originalPresent : {false, true}) {
        const std::string key = section == "steamvr" ? "preferredRefreshRate" : "displayFrequency";
        Json journal = {{"schema", 1}, {"driver", "GalaxyXRNative"}, {"entries", Json::object()}};
        Json settings = Json::object();
        if(originalPresent) settings[section][key] = 75;
        gxrsettings::RecordChange(journal, settings, section, key, true, 90);
        settings[section][key] = 90;
        const auto& entry = journal["entries"][section][key];

        Json changed = settings;
        changed[section][key] = 75;
        Check(!gxrsettings::PlanOwnedRestore(entry, changed, section, key, present, value),
            "refresh retirement preserves external 75 Hz in every global/profile destination");
        changed[section].erase(key);
        Check(!gxrsettings::PlanOwnedRestore(entry, changed, section, key, present, value),
            "refresh retirement preserves external deletion in every global/profile destination");

        const bool restore = gxrsettings::PlanOwnedRestore(entry, settings, section, key, present, value);
        Check(restore && present == originalPresent && (!present || value == 75),
            "unchanged app-owned 90 Hz restores original 75 Hz or original absence");
        if(restore) {
            gxrsettings::RecordChange(journal, settings, section, key, present, value);
            if(present) settings[section][key] = value;
            else settings[section].erase(key);
        }
        Check(!gxrsettings::PlanOwnedRestore(journal["entries"][section][key], settings, section, key, present, value),
            "repeated refresh retirement is a no-op after journaled restoration");
    }
    {
        Json journal = {{"schema", 1}, {"driver", "GalaxyXRNative"}, {"entries", Json::object()}};
        Json settings = Json::object();
        for(size_t i = 0; i < tuning.size(); ++i) settings[tuning[i]]["targetBandwidth"] = 70 + i;
        for(const auto& section : tuning) {
            gxrsettings::RecordChange(journal, settings, section, "targetBandwidth", true, 200);
            settings[section]["targetBandwidth"] = 200;
        }
        for(size_t i = 0; i < tuning.size(); ++i) {
            const auto& section = tuning[i];
            const auto& entry = journal["entries"][section]["targetBandwidth"];
            Check(gxrsettings::PlanOwnedRestore(entry, settings, section, "targetBandwidth", present, value)
                && present && value == 70 + i, "global and mirrored destinations restore their independently journaled originals");
            Json changed = settings; changed[section]["targetBandwidth"] = 999;
            Check(!gxrsettings::PlanOwnedRestore(entry, changed, section, "targetBandwidth", present, value), "external edits to each global or mirrored section are preserved");
            changed[section].erase("targetBandwidth");
            Check(!gxrsettings::PlanOwnedRestore(entry, changed, section, "targetBandwidth", present, value), "external deletions from each global or mirrored section are preserved");
            const auto& other = tuning[(i + 1) % tuning.size()];
            Check(gxrsettings::PlanOwnedRestore(journal["entries"][other]["targetBandwidth"], changed, other, "targetBandwidth", present, value), "an external change to one destination does not block another destination's restoration");
        }
    }
    const Json saved = {{"present", false}, {"lastPresent", true}, {"lastValue", 42}};
    Check(gxrsettings::PlanOwnedRestore(saved, {{"driver_vrlink", {{"test", 42}}}}, "driver_vrlink", "test", present, value) && !present, "unchanged journal-owned insertion is removed");
    Check(!gxrsettings::PlanOwnedRestore(saved, {{"driver_vrlink", {{"test", 43}}}}, "driver_vrlink", "test", present, value), "external changed value is preserved");
    Check(!gxrsettings::PlanOwnedRestore(saved, Json::object(), "driver_vrlink", "test", present, value), "external key removal is preserved");
    for(const auto& original : std::vector<Json>{false, true, 7, 0.5, "old"}) {
        Json entry = {{"present", true}, {"value", original}, {"lastPresent", true}, {"lastValue", 42}};
        Check(gxrsettings::PlanOwnedRestore(entry, {{"driver_vrlink", {{"test", 42}}}}, "driver_vrlink", "test", present, value)
            && present && value == original, "each supported original scalar is restored exactly");
        entry["lastPresent"] = false; entry.erase("lastValue");
        Check(gxrsettings::PlanOwnedRestore(entry, Json::object(), "driver_vrlink", "test", present, value)
            && present && value == original, "journal-owned deletion restores its original");
    }
    for(const auto& original : std::vector<Json>{nullptr, Json::array({1,2}), Json::object({{"x", 1}}), 99999999999LL}) {
        Json entry = {{"present", true}, {"value", original}, {"lastPresent", true}, {"lastValue", 42}};
        Check(!gxrsettings::PlanOwnedRestore(entry, {{"driver_vrlink", {{"test", 42}}}}, "driver_vrlink", "test", present, value), "unsupported original is preserved for manual recovery");
    }
    const Json restored = {{"present", true}, {"value", 5}, {"lastPresent", true}, {"lastValue", 5}};
    Check(!gxrsettings::PlanOwnedRestore(restored, {{"driver_vrlink", {{"test", 5}}}}, "driver_vrlink", "test", present, value), "already-restored value is not rewritten");
    for(const auto& bad : std::vector<Json>{nullptr, false, Json::object(), Json{{"present", true}, {"lastPresent", true}}}) {
        bool rejected = false;
        try { gxrsettings::PlanOwnedRestore(bad, Json::object(), "driver_vrlink", "test", present, value); }
        catch(const std::exception&) { rejected = true; }
        Check(rejected, "corrupt recovery entries are rejected before mutation");
    }
    std::set<int> properties;
    for(const auto& icon : gxr::kHeadsetStatusIcons) {
        Check(properties.insert(icon.property).second, "each SteamVR icon property is unique");
        Check(std::string(icon.file).rfind("headset_galaxy_xr_", 0) == 0, "driver uses supplied HMD artwork names");
    }
    Check(properties.size() == 9, "all nine SteamVR status-icon properties are covered");
    #ifdef VENDOR_GALAXYXR
    Check(Config{}.galaxyXr.nativeIdentity, "native identity defaults ON for Galaxy vendor");
    #else
    Check(!Config{}.galaxyXr.nativeIdentity, "neutral vendor identity remains unchanged");
    #endif
    Check(Config{}.galaxyXr.vrlinkHeadsetProfile, "headset profile defaults ON");
    std::cout << (failures ? "FAIL: " : "PASS: ") << checks << " companion settings checks, " << failures << " failures.\n";
    return failures ? 1 : 0;
}
