#pragma once
#include "openvr_driver.h"
#include "nlohmann/json.hpp"
#include "LosslessJson.h"
#include "../Driver/DriverLog.h"
#include <cmath>
#include <filesystem>
#include <functional>
#include <limits>
#include <vector>
#include <fstream>
#include <iterator>
#include <stdexcept>
#include <string>
#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <Windows.h>
#endif

// Shared with the GUI's driver_installation.rs. Capture raw user settings,
// including absence (VRSettings getters can return a shipped default instead).
// Journal BEFORE every write/removal; never mutate if recovery data cannot save.
namespace gxrsettings {
using Json = nlohmann::json;

inline void RecordChange(Json& journal, const Json& settings, const std::string& section,
    const std::string& key, bool present, const Json& value) {
    if(!journal.is_object() || journal.value("schema", 0) != 1
        || journal.value("driver", "") != "GalaxyXRNative" || !journal["entries"].is_object())
        throw std::runtime_error("invalid SteamVR change journal");
    auto& entries = journal["entries"];
    if(!journal.contains("sectionPresence")) journal["sectionPresence"] = Json::object();
    if(!journal["sectionPresence"].is_object()) throw std::runtime_error("invalid section-presence journal");
    for(const auto& marker : journal["sectionPresence"])
        if(!marker.is_boolean()) throw std::runtime_error("invalid section-presence marker");
    for(const auto& savedSection : entries) {
        if(!savedSection.is_object()) throw std::runtime_error("invalid journal section");
        for(const auto& saved : savedSection) {
            if(!saved.is_object() || !saved.contains("present") || !saved["present"].is_boolean()
                || (saved["present"].get<bool>() && !saved.contains("value"))
                || !saved.contains("lastPresent") || !saved["lastPresent"].is_boolean()
                || (saved["lastPresent"].get<bool>() && !saved.contains("lastValue")))
                throw std::runtime_error("invalid saved setting in journal");
        }
    }
    if(!journal["sectionPresence"].contains(section))
        journal["sectionPresence"][section] = settings.contains(section);
    if(settings.contains(section) && !settings[section].is_object())
        throw std::runtime_error("SteamVR setting section is not an object");
    if(!entries.contains(section)) entries[section] = Json::object();
    if(!entries[section].is_object()) throw std::runtime_error("invalid journal section");
    auto& keys = entries[section];
    if(!keys.contains(key)) {
        const auto s = settings.find(section);
        const bool existed = s != settings.end() && s->is_object() && s->contains(key);
        keys[key] = {{"present", existed}};
        if(existed) keys[key]["value"] = (*s)[key];
    }
    auto& entry = keys[key];
    if(!entry.is_object() || !entry.contains("present") || !entry["present"].is_boolean()
        || (entry["present"].get<bool>() && !entry.contains("value")))
        throw std::runtime_error("invalid original setting in journal");
    entry["lastPresent"] = present;
    if(present) entry["lastValue"] = value;
    else entry.erase("lastValue");
}

// Restoration is allowed only with journal proof AND an unchanged raw value.
// Equal-looking defaults or values written by another tool are not ownership.
inline bool PlanOwnedRestore(const Json& entry, const Json& settings,
    const std::string& section, const std::string& key, bool& present, Json& value) {
    if(!entry.is_object() || !entry.contains("present") || !entry["present"].is_boolean()
        || !entry.contains("lastPresent") || !entry["lastPresent"].is_boolean()
        || (entry["present"].get<bool>() && !entry.contains("value"))
        || (entry["lastPresent"].get<bool>() && !entry.contains("lastValue")))
        throw std::runtime_error("invalid SteamVR restoration entry");
    if(!settings.is_object() || (settings.contains(section) && !settings[section].is_object()))
        throw std::runtime_error("invalid SteamVR settings section");
    const bool currentPresent = settings.contains(section) && settings[section].contains(key);
    if(currentPresent != entry["lastPresent"].get<bool>()) return false;
    if(currentPresent && settings[section][key] != entry["lastValue"]) return false;
    present = entry["present"].get<bool>();
    value = present ? entry["value"] : Json();
    // The API can restore scalar settings, not arbitrary JSON or null values.
    // Opaque (out-of-range) numeric tokens are binary values: never settable.
    if(present && !(value.is_boolean() || value.is_string() || value.is_number())) return false;
    if(value.is_number_integer() && (value.get<double>() < std::numeric_limits<int32_t>::min()
        || value.get<double>() > std::numeric_limits<int32_t>::max())) return false;
    if(value.is_number_float()) {
        // SetFloat takes a float: reject anything it cannot represent finitely
        // and non-zero values that would collapse to zero.
        const double d = value.get<double>();
        if(!std::isfinite(d) || std::fabs(d) > static_cast<double>(std::numeric_limits<float>::max())
            || (d != 0.0 && static_cast<float>(d) == 0.0f)) return false;
    }
    return present != currentPresent || (present && value != settings[section][key]);
}

#if defined(_WIN32) && defined(VENDOR_GALAXYXR)
class MutationLock {
    HANDLE handle = nullptr;
public:
    MutationLock() {
        handle = CreateMutexW(nullptr, FALSE, L"Local\\GalaxyXRNativeSteamVRSettings");
        if(!handle) throw std::runtime_error("could not create SteamVR journal mutex");
        const DWORD result = WaitForSingleObject(handle, 5000);
        if(result != WAIT_OBJECT_0 && result != WAIT_ABANDONED) {
            CloseHandle(handle); handle = nullptr;
            throw std::runtime_error("SteamVR settings mutation is busy");
        }
    }
    ~MutationLock() { if(handle) { ReleaseMutex(handle); CloseHandle(handle); } }
    MutationLock(const MutationLock&) = delete;
    MutationLock& operator=(const MutationLock&) = delete;
};

inline std::filesystem::path EnvironmentPath(const wchar_t* name) {
    const DWORD size = GetEnvironmentVariableW(name, nullptr, 0);
    if(!size) throw std::runtime_error("required application-data path is unavailable");
    std::wstring value(size, L'\0');
    const DWORD used = GetEnvironmentVariableW(name, &value[0], size);
    if(!used || used >= size) throw std::runtime_error("application-data path changed");
    value.resize(used);
    return std::filesystem::path(value);
}

// Lossless: out-of-range numeric tokens (e.g. SteamVR's -1e+9999) are kept as
// opaque values and written back verbatim; malformed JSON still throws.
inline Json ReadJson(const std::filesystem::path& path) {
    std::ifstream input(path, std::ios::binary);
    if(!input) throw std::runtime_error("could not read SteamVR settings/recovery file");
    const std::string text((std::istreambuf_iterator<char>(input)), std::istreambuf_iterator<char>());
    Json result = gxrjson::ParseLossless(text);
    if(!result.is_object()) throw std::runtime_error("settings/recovery root is not an object");
    return result;
}

inline void WriteJournal(const std::filesystem::path& path, const Json& journal) {
    std::filesystem::create_directories(path.parent_path());
    auto temp = path; temp += ".native.tmp";
    const std::string bytes = gxrjson::DumpLossless(journal, 2) + "\n";
    HANDLE file = CreateFileW(temp.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if(file == INVALID_HANDLE_VALUE) throw std::runtime_error("could not create journal temporary file");
    DWORD written = 0;
    const bool okay = WriteFile(file, bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr)
        && written == bytes.size() && FlushFileBuffers(file);
    CloseHandle(file);
    if(!okay) throw std::runtime_error("could not flush SteamVR journal");
    if(!MoveFileExW(temp.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
        throw std::runtime_error("could not commit SteamVR journal");
}

// Restore inactive destinations as one journaled operation. Do not move or
// delete unjournaled keys: older/user-written values must be reviewed manually.
inline void RestoreOwnedMatching(const std::function<bool(const std::string&, const std::string&)>& select) {
    try {
        MutationLock lock;
        const auto journalPath = EnvironmentPath(L"APPDATA") / "GalaxyXR" / "CustomHeadset" / "steamvr-changes.json";
        if(!std::filesystem::exists(journalPath)) return;
        Json journal = ReadJson(journalPath);
        const auto paths = ReadJson(EnvironmentPath(L"LOCALAPPDATA") / "openvr" / "openvrpaths.vrpath");
        const auto settingsPath = std::filesystem::weakly_canonical(std::filesystem::u8path(
            paths.at("config").at(0).get<std::string>()) / "steamvr.vrsettings");
        const auto recordedPath = std::filesystem::weakly_canonical(std::filesystem::u8path(journal.at("settingsPath").get<std::string>()));
        if(_wcsicmp(recordedPath.c_str(), settingsPath.c_str()) != 0)
            throw std::runtime_error("SteamVR settings path differs from recovery journal");
        if(journal.value("schema", 0) != 1 || journal.value("driver", "") != "GalaxyXRNative"
            || !journal.at("entries").is_object()) throw std::runtime_error("invalid recovery journal");
        const Json settings = ReadJson(settingsPath);
        struct Restore { std::string section, key; bool present; Json value, before; };
        std::vector<Restore> plan;
        const auto entries = journal.at("entries");
        for(const auto& section : entries.items()) {
            if(!section.value().is_object()) throw std::runtime_error("invalid journal section");
            for(const auto& key : section.value().items()) {
                bool present = false; Json value;
                if(!select(section.key(), key.key())) continue;
                if(!PlanOwnedRestore(key.value(), settings, section.key(), key.key(), present, value)) {
                    DriverLog("GalaxyXR: keeping %s.%s (not an unchanged, restorable app-owned value)", section.key().c_str(), key.key().c_str());
                    continue;
                }
                // Also check the live API, so a not-yet-flushed edit cannot be
                // mistaken for our last persisted value. Absence is checked on disk.
                if(key.value()["lastPresent"].get<bool>()) {
                    const auto& last = key.value().at("lastValue");
                    vr::EVRSettingsError e = vr::VRSettingsError_None; bool match = false;
                    if(last.is_boolean()) match = vr::VRSettings()->GetBool(section.key().c_str(), key.key().c_str(), &e) == last.get<bool>();
                    // Opaque or out-of-range values cannot be compared through the typed API.
                    else if(last.is_number_integer()) {
                        const double d = last.get<double>();
                        if(d < std::numeric_limits<int32_t>::min() || d > std::numeric_limits<int32_t>::max()) continue;
                        match = vr::VRSettings()->GetInt32(section.key().c_str(), key.key().c_str(), &e) == last.get<int32_t>();
                    }
                    else if(last.is_number_float()) {
                        const double d = last.get<double>();
                        if(!std::isfinite(d) || std::fabs(d) > static_cast<double>(std::numeric_limits<float>::max())) continue;
                        match = vr::VRSettings()->GetFloat(section.key().c_str(), key.key().c_str(), &e) == last.get<float>();
                    }
                    else if(last.is_string()) {
                        std::vector<char> text(last.get<std::string>().size() + 2, 0);
                        vr::VRSettings()->GetString(section.key().c_str(), key.key().c_str(), text.data(), static_cast<uint32_t>(text.size()), &e);
                        match = last.get<std::string>() == text.data();
                    }
                    if(e != vr::VRSettingsError_None || !match) continue;
                }
                plan.push_back({section.key(), key.key(), present, value, key.value()});
                RecordChange(journal, settings, section.key(), key.key(), present, value);
            }
        }
        if(plan.empty()) return;
        WriteJournal(journalPath, journal); // Intent is durable BEFORE touching SteamVR.
        for(const auto& item : plan) {
            vr::EVRSettingsError e = vr::VRSettingsError_None;
            const char* sec = item.section.c_str(); const char* key = item.key.c_str();
            if(!item.present) vr::VRSettings()->RemoveKeyInSection(sec, key, &e);
            else if(item.value.is_boolean()) vr::VRSettings()->SetBool(sec, key, item.value.get<bool>(), &e);
            else if(item.value.is_string()) vr::VRSettings()->SetString(sec, key, item.value.get<std::string>().c_str(), &e);
            else if(item.value.is_number_integer()) vr::VRSettings()->SetInt32(sec, key, item.value.get<int32_t>(), &e);
            else vr::VRSettings()->SetFloat(sec, key, item.value.get<float>(), &e);
            if(e != vr::VRSettingsError_None) {
                journal["entries"][item.section][item.key] = item.before;
                WriteJournal(journalPath, journal); // Keep previous recovery evidence on a failed write.
            }
            DriverLog("GalaxyXR: restore previous destination %s.%s: error=%d", sec, key, (int)e);
        }
    } catch(const std::exception& e) {
        DriverLog("GalaxyXR: skipped SteamVR owned-setting restoration: %s", e.what());
    }
}

template<class Apply>
inline void Mutate(const char* section, const char* key, bool present, const Json& value,
    vr::EVRSettingsError* error, Apply apply) {
    try {
        MutationLock lock;
        const auto folder = EnvironmentPath(L"APPDATA") / "GalaxyXR" / "CustomHeadset";
        const auto paths = ReadJson(EnvironmentPath(L"LOCALAPPDATA") / "openvr" / "openvrpaths.vrpath");
        const auto& config = paths.at("config");
        if(!config.is_array() || config.empty() || !config[0].is_string())
            throw std::runtime_error("OpenVR configuration directory is unavailable");
        const auto settingsPath = std::filesystem::weakly_canonical(
            std::filesystem::u8path(config[0].get<std::string>()) / "steamvr.vrsettings");
        const auto settings = std::filesystem::exists(settingsPath) ? ReadJson(settingsPath) : Json::object();
        const auto journalPath = folder / "steamvr-changes.json";
        Json journal;
        if(std::filesystem::exists(journalPath)) {
            journal = ReadJson(journalPath);
            const auto recordedPath = std::filesystem::weakly_canonical(
                std::filesystem::u8path(journal.at("settingsPath").get<std::string>()));
            if(_wcsicmp(recordedPath.c_str(), settingsPath.c_str()) != 0)
                throw std::runtime_error("SteamVR settings path differs from recovery journal");
        } else {
            const auto oldDriver = settings.find("driver_GalaxyXRNative");
            const bool legacy = (oldDriver != settings.end() && oldDriver->is_object() && oldDriver->contains("hasBeenRun"))
                || std::filesystem::exists(folder / "info.json");
            journal = {{"schema", 1}, {"driver", "GalaxyXRNative"}, {"settingsPath", settingsPath.u8string()},
                {"legacy", legacy}, {"entries", Json::object()}};
        }
        RecordChange(journal, settings, section, key, present, value);
        WriteJournal(journalPath, journal);
        apply();
    } catch(const std::exception& e) {
        if(error) *error = vr::VRSettingsError_WriteFailed;
        DriverLog("GalaxyXR: skipped SteamVR mutation %s.%s: recovery journal failed (%s)", section, key, e.what());
    }
}
#else
inline void RestoreOwnedMatching(const std::function<bool(const std::string&, const std::string&)>&) {}
template<class Apply>
inline void Mutate(const char*, const char*, bool, const Json&, vr::EVRSettingsError*, Apply apply) { apply(); }
#endif

inline void RestoreOwnedKey(const char* section, const char* key) {
    RestoreOwnedMatching([&](const std::string& s, const std::string& k) { return s == section && k == key; });
}

inline void SetInt32(const char* section, const char* key, int32_t value, vr::EVRSettingsError* error = nullptr) {
    Mutate(section, key, true, value, error, [&]{ vr::VRSettings()->SetInt32(section, key, value, error); });
}
inline void SetFloat(const char* section, const char* key, float value, vr::EVRSettingsError* error = nullptr) {
    Mutate(section, key, true, value, error, [&]{ vr::VRSettings()->SetFloat(section, key, value, error); });
}
inline void SetBool(const char* section, const char* key, bool value, vr::EVRSettingsError* error = nullptr) {
    Mutate(section, key, true, value, error, [&]{ vr::VRSettings()->SetBool(section, key, value, error); });
}
inline void SetString(const char* section, const char* key, const char* value, vr::EVRSettingsError* error = nullptr) {
    Mutate(section, key, true, value, error, [&]{ vr::VRSettings()->SetString(section, key, value, error); });
}
inline void RemoveKeyInSection(const char* section, const char* key, vr::EVRSettingsError* error = nullptr) {
    Mutate(section, key, false, nullptr, error, [&]{ vr::VRSettings()->RemoveKeyInSection(section, key, error); });
}
} // namespace gxrsettings
