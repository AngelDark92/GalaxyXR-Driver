// Local validation only: extracted production startup and profile writer,
// in-memory IO, and the production journal's pure ownership operations.
// No live SteamVR settings, runtime, or files are accessed.
#include "Config/Config.h"
#include "Config/SdrColorPolicy.h"
#include "Config/VrlinkSettingsRouting.h"
#include "Config/SteamVRSettingsJournal.h"
#include <iostream>

Config driverConfig;
using gxrsettings::Json;
Json settings, journal;
int checks=0, failures=0, writes=0;
constexpr int kGalaxyXrRenderWidth=3552, kGalaxyXrRenderHeight=3840;
void Check(bool condition, const std::string& label) {
    ++checks;
    if(!condition) { ++failures; std::cerr << "FAIL: " << label << '\n'; }
}
void DriverLog(const char*, ...) {}
namespace fakejournal {
void Mutate(const char* section, const char* key, bool present, const Json& value) {
    if(present && settings.contains(section) && settings[section].contains(key) && settings[section][key]==value) return;
    if(!present && (!settings.contains(section) || !settings[section].contains(key))) return;
    gxrsettings::RecordChange(journal, settings, section, key, present, value);
    if(present) settings[section][key]=value;
    else settings[section].erase(key);
    ++writes;
}
void SetInt32(const char* s,const char* k,int32_t v) { Mutate(s,k,true,v); }
void SetFloat(const char* s,const char* k,float v) { Mutate(s,k,true,v); }
void SetBool(const char* s,const char* k,bool v) { Mutate(s,k,true,v); }
void RemoveKeyInSection(const char* s,const char* k,vr::EVRSettingsError* error) {
    Mutate(s,k,false,nullptr); if(error) *error=vr::VRSettingsError_None;
}
void RestoreOwnedMatching(const std::function<bool(const std::string&,const std::string&)>& select) {
    const Json entries=journal["entries"];
    for(const auto& section:entries.items()) for(const auto& key:section.value().items()) {
        bool present=false; Json value;
        if(select(section.key(),key.key()) && gxrsettings::PlanOwnedRestore(key.value(),settings,section.key(),key.key(),present,value))
            Mutate(section.key().c_str(),key.key().c_str(),present,value);
    }
}
void RestoreOwnedKey(const char* s,const char* k) {
    RestoreOwnedMatching([&](const std::string& section,const std::string& key) { return section==s && key==k; });
}
}
struct FakeSettings {
    bool GetBool(const char* s,const char* k,vr::EVRSettingsError* error) {
        const bool found=settings.contains(s)&&settings[s].contains(k)&&settings[s][k].is_boolean();
        *error=found?vr::VRSettingsError_None:vr::VRSettingsError_ReadFailed;
        return found?settings[s][k].get<bool>():false;
    }
    int32_t GetInt32(const char* s,const char* k,vr::EVRSettingsError* error) {
        const bool found=settings.contains(s)&&settings[s].contains(k)&&settings[s][k].is_number_integer();
        *error=found?vr::VRSettingsError_None:vr::VRSettingsError_ReadFailed;
        return found?settings[s][k].get<int32_t>():0;
    }
};
FakeSettings* TestSettings() { static FakeSettings api; return &api; }
int GalaxyXR_EffectiveTileWidth() { return driverConfig.galaxyXr.customStreamFormatWidth; }
gxr::Sdr10BaselinePolicy ResolveSdr10PolicyLocked() { return gxr::ResolveSdr10Policy(driverConfig); }
void ApplyNativeResolutionSetting() {}
void ApplyStreamQualitySetting() {}
#include "Startup.generated.h"

void Reset(bool profile,int original) {
    driverConfig=Config{};
    driverConfig.galaxyXr.vrlinkHeadsetProfile=profile;
    driverConfig.galaxyXr.profileSupports10bit=true;
    settings=Json::object();
    journal={{"schema",1},{"driver","GalaxyXRNative"},{"entries",Json::object()}};
    writes=0;
    if(original>=0) for(const auto& section:gxr::VrlinkCapabilitySections(true,"")) settings[section]["supports10bit"]=(original!=0);
}
void CheckValue(const std::vector<std::string>& sections,bool value,const std::string& label) {
    for(const auto& section:sections)
        Check(settings.contains(section)&&settings[section].contains("supports10bit")&&settings[section]["supports10bit"]==value,label+" "+section);
}
void CheckOriginal(const std::vector<std::string>& sections,int original,const std::string& label) {
    for(const auto& section:sections)
        Check(original<0?!settings[section].contains("supports10bit"):settings[section]["supports10bit"]==(original!=0),label+" "+section);
}
constexpr const char* kOverlayKeys[]={"debugRegionColoring","showAdvancedGraphs"};
void ResetOverlay(bool profile,int regionsOriginal,int graphsOriginal) {
    Reset(profile,-1);
    const int originals[]={regionsOriginal,graphsOriginal};
    for(const auto& section:gxr::VrlinkTuningSections(true)) for(int key=0;key<2;++key)
        if(originals[key]>=0) settings[section][kOverlayKeys[key]]=(originals[key]!=0);
}
void CheckKeyOriginal(const std::vector<std::string>& sections,const char* key,int original,const std::string& label) {
    for(const auto& section:sections) {
        const bool present=settings.contains(section)&&settings[section].contains(key);
        Check(original<0?!present:(present&&settings[section][key]==(original!=0)),label+" "+section+"."+key);
    }
}
void CheckOverlay(const std::vector<std::string>& sections,int regions,int graphs,const std::string& label) {
    CheckKeyOriginal(sections,kOverlayKeys[0],regions,label);
    CheckKeyOriginal(sections,kOverlayKeys[1],graphs,label);
}
int main() {
    // Cold-start and ON -> OFF, all identity routes, legacy stored true,
    // original absent/false/true, idempotence and uninstall restoration.
    for(bool profile:{false,true}) for(int original:{-1,0,1}) {
        Reset(profile,original);
        const auto earlySections=gxr::VrlinkCapabilitySections(profile,"");
        driverConfig.galaxyXr.sdr10Baseline=false;
        GalaxyXR_EarlyApplyVrlinkSettings();
        CheckValue(earlySections,false,"cold OFF");
        driverConfig.galaxyXr.sdr10Baseline=true;
        GalaxyXR_EarlyApplyVrlinkSettings();
        CheckValue(earlySections,true,"ON");
        driverConfig.galaxyXr.sdr10Baseline=false;
        GalaxyXR_EarlyApplyVrlinkSettings();
        CheckValue(earlySections,false,"ON -> OFF");
        const int before=writes;
        GalaxyXR_EarlyApplyVrlinkSettings();
        Check(writes==before,"repeated OFF startup is idempotent");
        fakejournal::RestoreOwnedMatching([](const auto&,const auto&) { return true; });
        CheckOriginal(earlySections,original,"uninstall restores original");
        for(const auto& model:{"xrvst2ue","Oculus Quest Pro","PICO 4 Pro"}) {
            Reset(profile,original);
            const auto sections=gxr::VrlinkCapabilitySections(profile,model);
            driverConfig.galaxyXr.sdr10Baseline=true;
            RestoreInactiveVrlinkSettings(model);
            ApplyHeadsetProfileSetting(model,ResolveSdr10PolicyLocked());
            CheckValue(sections,true,std::string("activation ON ")+model);
            driverConfig.galaxyXr.sdr10Baseline=false;
            ApplyHeadsetProfileSetting(model,ResolveSdr10PolicyLocked());
            CheckValue(sections,false,std::string("activation OFF ")+model);
            fakejournal::RestoreOwnedMatching([](const auto&,const auto&) { return true; });
            CheckOriginal(sections,original,std::string("activation uninstall ")+model);
        }
    }
    // Actual expert writer remains last; supports10bit value/removal is
    // authoritative in the destinations selected by the existing route.
    for(bool profile:{false,true}) for(int extra:{-1,0,1}) {
        Reset(profile,-1);
        driverConfig.galaxyXr.vrlinkExtraKeys={{"supports10bit",extra<0?'x':'b',static_cast<double>(extra)}};
        for(bool baseline:{true,false}) {
            driverConfig.galaxyXr.sdr10Baseline=baseline;
            GalaxyXR_EarlyApplyVrlinkSettings();
            CheckOriginal(gxr::VrlinkTuningSections(profile),extra,"expert value/removal wins at startup");
        }
    }
    // Pure journal recovery must preserve user edits/deletions made after
    // the OFF write, including a manually restored true value.
    for(bool deleted:{false,true}) {
        Reset(true,-1);
        driverConfig.galaxyXr.sdr10Baseline=false;
        GalaxyXR_EarlyApplyVrlinkSettings();
        for(const auto& section:gxr::VrlinkCapabilitySections(true,"")) {
            if(deleted) settings[section].erase("supports10bit");
            else settings[section]["supports10bit"]=true;
        }
        fakejournal::RestoreOwnedMatching([](const auto&,const auto&) { return true; });
        CheckOriginal(gxr::VrlinkCapabilitySections(true,""),deleted?-1:1,"recovery preserves later user edit");
    }

    // 2026-09-25: debug overlay OFF must be an explicit journaled false,
    // including when either original was true. Recovery alone is not OFF.
    for(bool profile:{false,true}) for(int regionsOriginal:{-1,0,1}) for(int graphsOriginal:{-1,0,1}) {
        ResetOverlay(profile,regionsOriginal,graphsOriginal);
        const auto sections=gxr::VrlinkTuningSections(profile);
        driverConfig.galaxyXr.vrlinkDebugOverlay=false;
        GalaxyXR_EarlyApplyVrlinkSettings();
        CheckOverlay(sections,0,0,"overlay cold OFF");
        driverConfig.galaxyXr.vrlinkDebugOverlay=true;
        GalaxyXR_EarlyApplyVrlinkSettings();
        CheckOverlay(sections,1,1,"overlay ON");
        const int onWrites=writes;
        GalaxyXR_EarlyApplyVrlinkSettings();
        Check(writes==onWrites,"repeated overlay ON startup is idempotent");
        driverConfig.galaxyXr.vrlinkDebugOverlay=false;
        GalaxyXR_EarlyApplyVrlinkSettings();
        CheckOverlay(sections,0,0,"overlay ON -> OFF");
        const int offWrites=writes;
        GalaxyXR_EarlyApplyVrlinkSettings();
        Check(writes==offWrites,"repeated overlay OFF startup is idempotent");
        fakejournal::RestoreOwnedMatching([](const auto&,const auto&) { return true; });
        CheckOverlay(gxr::VrlinkTuningSections(true),regionsOriginal,graphsOriginal,
            "overlay recovery restores originals and preserves inactive destinations");
    }
    // Both overlay keys retain their independent expert value/removal, even
    // across OFF -> ON -> OFF. The original values survive those overrides.
    for(bool profile:{false,true}) for(int regionsExtra:{-1,0,1}) for(int graphsExtra:{-1,0,1}) {
        ResetOverlay(profile,1,0);
        driverConfig.galaxyXr.vrlinkExtraKeys={
            {kOverlayKeys[0],regionsExtra<0?'x':'b',static_cast<double>(regionsExtra)},
            {kOverlayKeys[1],graphsExtra<0?'x':'b',static_cast<double>(graphsExtra)}};
        for(bool overlay:{false,true,false}) {
            driverConfig.galaxyXr.vrlinkDebugOverlay=overlay;
            GalaxyXR_EarlyApplyVrlinkSettings();
            CheckOverlay(gxr::VrlinkTuningSections(profile),regionsExtra,graphsExtra,
                "overlay explicit values/removals win at startup");
        }
        fakejournal::RestoreOwnedMatching([](const auto&,const auto&) { return true; });
        CheckOverlay(gxr::VrlinkTuningSections(true),1,0,"overlay expert recovery preserves originals");
    }
    // Recovery only restores unchanged owned values. Edit/delete one overlay
    // key externally and verify its sibling still restores independently.
    for(bool profile:{false,true}) for(int original:{-1,0,1}) for(bool overlay:{false,true})
        for(bool deleted:{false,true}) for(int editedKey=0;editedKey<2;++editedKey) {
        ResetOverlay(profile,original,original);
        const auto sections=gxr::VrlinkTuningSections(profile);
        driverConfig.galaxyXr.vrlinkDebugOverlay=overlay;
        GalaxyXR_EarlyApplyVrlinkSettings();
        for(const auto& section:sections) {
            if(deleted) settings[section].erase(kOverlayKeys[editedKey]);
            else settings[section][kOverlayKeys[editedKey]]=!overlay;
        }
        fakejournal::RestoreOwnedMatching([](const auto&,const auto&) { return true; });
        CheckKeyOriginal(sections,kOverlayKeys[editedKey],deleted?-1:static_cast<int>(!overlay),
            "overlay recovery preserves external edit/deletion");
        CheckKeyOriginal(sections,kOverlayKeys[1-editedKey],original,"overlay untouched sibling restores");
    }
    std::cout << "SDR10 actual startup writer: " << checks << " checks, " << failures << " failures\n";
    return failures?1:0;
}
