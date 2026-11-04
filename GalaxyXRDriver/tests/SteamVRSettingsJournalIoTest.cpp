// Live-IO journal tests (VENDOR_GALAXYXR path) against a fake IVRSettings and a
// throw-away APPDATA/LOCALAPPDATA tree. No real SteamVR, no real user data.
#ifndef VENDOR_GALAXYXR
#define VENDOR_GALAXYXR 1
#endif

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <Windows.h>
#endif

#include "../src/Config/SteamVRSettingsJournal.h"
#include <cstdarg>
#include <cstdio>
#include <chrono>
#include <iostream>
#include <map>
#include <sstream>
#include <string_view>
#include <vector>

static int checks = 0;
static int failures = 0;
static void Check(bool success, const char* message) {
    ++checks;
    if (!success) { ++failures; std::cerr << "FAIL: " << message << '\n'; }
}

static std::vector<std::string> driverLogs;
void DriverLog(const char* format, ...) {
    char buffer[1024];
    va_list args; va_start(args, format);
    vsnprintf(buffer, sizeof(buffer), format, args);
    va_end(args);
    driverLogs.push_back(buffer);
}

namespace {
struct Value { char kind = 0; double number = 0; std::string text; };
class FakeSettings : public vr::IVRSettings {
public:
    std::map<std::string, Value> values;
    std::vector<std::string> mutations;
    static std::string Id(const char* s, const char* k) { return std::string(s) + "/" + k; }
    const char* GetSettingsErrorNameFromEnum(vr::EVRSettingsError) override { return "fake"; }
    void SetBool(const char* s, const char* k, bool v, vr::EVRSettingsError* e) override { values[Id(s, k)] = {'b', v ? 1.0 : 0.0, ""}; mutations.push_back("set " + Id(s, k)); if (e) *e = vr::VRSettingsError_None; }
    void SetInt32(const char* s, const char* k, int32_t v, vr::EVRSettingsError* e) override { values[Id(s, k)] = {'i', (double)v, ""}; mutations.push_back("set " + Id(s, k)); if (e) *e = vr::VRSettingsError_None; }
    void SetFloat(const char* s, const char* k, float v, vr::EVRSettingsError* e) override { values[Id(s, k)] = {'f', (double)v, ""}; mutations.push_back("set " + Id(s, k)); if (e) *e = vr::VRSettingsError_None; }
    void SetString(const char* s, const char* k, const char* v, vr::EVRSettingsError* e) override { values[Id(s, k)] = {'s', 0, v}; mutations.push_back("set " + Id(s, k)); if (e) *e = vr::VRSettingsError_None; }
    bool GetBool(const char* s, const char* k, vr::EVRSettingsError* e) override { auto i = values.find(Id(s, k)); if (i == values.end() || i->second.kind != 'b') { if (e) *e = vr::VRSettingsError_ReadFailed; return false; } if (e) *e = vr::VRSettingsError_None; return i->second.number != 0; }
    int32_t GetInt32(const char* s, const char* k, vr::EVRSettingsError* e) override { auto i = values.find(Id(s, k)); if (i == values.end() || i->second.kind != 'i') { if (e) *e = vr::VRSettingsError_ReadFailed; return 0; } if (e) *e = vr::VRSettingsError_None; return (int32_t)i->second.number; }
    float GetFloat(const char* s, const char* k, vr::EVRSettingsError* e) override { auto i = values.find(Id(s, k)); if (i == values.end() || i->second.kind != 'f') { if (e) *e = vr::VRSettingsError_ReadFailed; return 0; } if (e) *e = vr::VRSettingsError_None; return (float)i->second.number; }
    void GetString(const char* s, const char* k, char* out, uint32_t len, vr::EVRSettingsError* e) override { auto i = values.find(Id(s, k)); if (i == values.end() || i->second.kind != 's' || i->second.text.size() + 1 > len) { if (e) *e = vr::VRSettingsError_ReadFailed; if (len) out[0] = 0; return; } strcpy_s(out, len, i->second.text.c_str()); if (e) *e = vr::VRSettingsError_None; }
    void RemoveSection(const char*, vr::EVRSettingsError* e) override { if (e) *e = vr::VRSettingsError_None; }
    void RemoveKeyInSection(const char* s, const char* k, vr::EVRSettingsError* e) override { values.erase(Id(s, k)); mutations.push_back("remove " + Id(s, k)); if (e) *e = vr::VRSettingsError_None; }
};
class FakeContext : public vr::IVRDriverContext {
public:
    FakeSettings settings;
    void* GetGenericInterface(const char*, vr::EVRInitError* e) override { if (e) *e = vr::VRInitError_None; return &settings; }
    vr::DriverHandle_t GetDriverHandle() override { return 1; }
};
FakeContext context;

std::filesystem::path g_fixtureBase;
std::filesystem::path g_runRoot;
std::filesystem::path root;
std::filesystem::path settingsFile, journalFile;
bool g_forceFail = false;

std::string ReadAll(const std::filesystem::path& path) {
    std::ifstream input(path, std::ios::binary);
    std::stringstream buffer; buffer << input.rdbuf();
    return buffer.str();
}
void WriteAll(const std::filesystem::path& path, const std::string& text) {
    std::filesystem::create_directories(path.parent_path());
    std::ofstream output(path, std::ios::binary | std::ios::trunc);
    output << text;
}
bool Has(const std::string& text, const std::string& needle) { return text.find(needle) != std::string::npos; }

std::filesystem::path ModuleDirectory() {
    wchar_t path[MAX_PATH] = {};
    const DWORD len = GetModuleFileNameW(nullptr, path, MAX_PATH);
    if (len == 0 || len >= MAX_PATH) {
        std::cerr << "FAIL: GetModuleFileNameW failed\n";
        std::exit(2);
    }
    return std::filesystem::path(path).parent_path();
}

std::wstring ToLower(std::wstring s) {
    for (wchar_t& c : s) c = static_cast<wchar_t>(towlower(static_cast<wint_t>(c)));
    return s;
}

bool IsUnderApprovedBase(const std::filesystem::path& base) {
    const std::wstring lower = ToLower(base.wstring());
    const std::wstring suffix = L"\\builds\\galaxyxr-driver\\build\\steamvr-settings-journal-test";
    return lower.size() >= suffix.size() && lower.compare(lower.size() - suffix.size(), suffix.size(), suffix) == 0;
}

bool IsReparsePoint(const std::filesystem::path& p) {
    if (!std::filesystem::exists(p)) return false;
    if (std::filesystem::is_symlink(p)) return true;
    const DWORD attrs = GetFileAttributesW(p.c_str());
    return attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_REPARSE_POINT);
}

bool PrefixHasReparse(const std::filesystem::path& p, const std::filesystem::path& base) {
    std::filesystem::path current = p;
    while (!current.empty()) {
        if (IsReparsePoint(current)) return true;
        if (current == base) break;
        if (!current.has_parent_path() || current == current.parent_path()) break;
        current = current.parent_path();
    }
    return IsReparsePoint(base);
}

bool IsUnderBase(const std::filesystem::path& p, const std::filesystem::path& base) {
    const std::wstring pw = ToLower(p.wstring());
    const std::wstring bw = ToLower(base.wstring());
    if (pw.size() <= bw.size()) return false;
    if (pw.compare(0, bw.size(), bw) != 0) return false;
    return pw[bw.size()] == L'\\';
}

std::filesystem::path MakeUniqueRunRoot(const std::filesystem::path& base) {
    const auto io = base / "io";
    const auto now = std::chrono::steady_clock::now().time_since_epoch();
    const auto pid = GetCurrentProcessId();
    const auto tick = std::chrono::duration_cast<std::chrono::nanoseconds>(now).count();
    for (int attempt = 0; attempt < 100; ++attempt) {
        std::filesystem::path candidate = io / ("run-" + std::to_string(pid) + "-" + std::to_string(tick) + "-" + std::to_string(attempt));
        if (!std::filesystem::exists(candidate)) return candidate;
    }
    std::cerr << "FAIL: could not allocate unique fixture run root\n";
    std::exit(2);
}

void ValidateFixtureRoot(const std::filesystem::path& fixtureRoot) {
    const std::filesystem::path canonicalRoot = std::filesystem::weakly_canonical(fixtureRoot);
    if (!IsUnderBase(canonicalRoot, g_fixtureBase)) {
        std::cerr << "FAIL: fixture root is outside approved base: " << canonicalRoot << "\n";
        std::exit(2);
    }
    if (PrefixHasReparse(canonicalRoot, g_fixtureBase)) {
        std::cerr << "FAIL: fixture root or prefix is a reparse point: " << canonicalRoot << "\n";
        std::exit(2);
    }
}

// Fresh isolated environment per case.
void Begin(const char* name, const std::string& settingsText, const std::string& journalText = "") {
    root = g_runRoot / name;
    ValidateFixtureRoot(root);
    if (std::filesystem::exists(root)) {
        std::filesystem::remove_all(root);
    }
    std::filesystem::create_directories(root);
    const auto appData = root / "appdata";
    const auto localAppData = root / "local";
    const auto config = root / "config";
    SetEnvironmentVariableW(L"APPDATA", appData.c_str());
    SetEnvironmentVariableW(L"LOCALAPPDATA", localAppData.c_str());
    WriteAll(localAppData / "openvr" / "openvrpaths.vrpath",
        gxrsettings::Json({{"config", gxrsettings::Json::array({config.generic_u8string()})}}).dump());
    settingsFile = config / "steamvr.vrsettings";
    journalFile = appData / "GalaxyXR" / "CustomHeadset" / "steamvr-changes.json";
    WriteAll(settingsFile, settingsText);
    if (!journalText.empty()) {
        const auto canonical = std::filesystem::weakly_canonical(settingsFile).u8string();
        std::string text = journalText;
        const std::string token = "@SETTINGS_PATH@";
        const auto at = text.find(token);
        if (at != std::string::npos) text.replace(at, token.size(), gxrsettings::Json(canonical).dump());
        WriteAll(journalFile, text);
    }
    context.settings = FakeSettings();
    driverLogs.clear();
}
}

int main(int argc, char* argv[]) {
    vr::VRDriverContext() = &context;

    std::filesystem::path baseArg;
    for (int i = 1; i < argc; ++i) {
        if (std::string_view(argv[i]) == "--fail") {
            g_forceFail = true;
        } else if (baseArg.empty()) {
            baseArg = argv[i];
        } else {
            std::cerr << "FAIL: unexpected argument: " << argv[i] << "\n";
            return 2;
        }
    }

    if (baseArg.empty()) baseArg = ModuleDirectory();
    try {
        g_fixtureBase = std::filesystem::canonical(baseArg);
    } catch (const std::exception&) {
        std::cerr << "FAIL: fixture base does not exist or is not canonical: " << baseArg << "\n";
        return 2;
    }

    if (!IsUnderApprovedBase(g_fixtureBase)) {
        std::cerr << "FAIL: fixture base is not the approved external output directory: " << g_fixtureBase << "\n";
        std::cerr << "Run from the build output directory or pass it as the first argument.\n";
        return 2;
    }

    g_runRoot = MakeUniqueRunRoot(g_fixtureBase);
    ValidateFixtureRoot(g_runRoot);
    std::filesystem::create_directories(g_runRoot);

    const std::string overflowSettings =
        "{\n  \"driver_vrlink\": {\"streamFormatWidth\": -1e+9999, \"other\": 7},\n"
        "  \"steamvr\": {\"keep\": true}\n}\n";

    // 1. Overflow baseline in steamvr.vrsettings: a normal write still journals and applies.
    {
        Begin("settings_overflow", overflowSettings);
        vr::EVRSettingsError error = vr::VRSettingsError_None;
        gxrsettings::SetInt32("driver_vrlink", "streamFormatWidth", 1536, &error);
        Check(error == vr::VRSettingsError_None, "write over -1e+9999 baseline succeeds");
        Check(context.settings.mutations.size() == 1, "write over -1e+9999 baseline reaches SteamVR");
        const auto journal = ReadAll(journalFile);
        Check(Has(journal, "\"value\": -1e+9999"), "journal keeps the exact original -1e+9999 token");
        Check(Has(journal, "\"lastValue\": 1536"), "journal records the written value");
        gxrsettings::SetBool("vrlink_xrvst2ue", "enable", true, &error);
        Check(error == vr::VRSettingsError_None && context.settings.mutations.size() == 2, "unrelated key still writes");
        Check(Has(ReadAll(journalFile), "\"value\": -1e+9999"), "original token survives later journal rewrites");
    }
    // 2. Rust v2 journal with an overflow baseline: native mutations must not fail.
    {
        const std::string journal =
            "{\"schema\":1,\"driver\":\"GalaxyXRNative\",\"settingsPath\":@SETTINGS_PATH@,\"legacy\":false,"
            "\"sectionPresence\":{\"driver_vrlink\":true},"
            "\"entries\":{\"driver_vrlink\":{\"streamFormatWidth\":{\"present\":true,\"value\":-1e+9999,\"lastPresent\":true,\"lastValue\":1536}}}}";
        Begin("journal_overflow", "{\"driver_vrlink\":{\"streamFormatWidth\":1536}}", journal);
        vr::EVRSettingsError error = vr::VRSettingsError_None;
        gxrsettings::SetBool("vrlink_xrvst2ue", "enable", true, &error);
        Check(error == vr::VRSettingsError_None, "mutation with overflow journal succeeds");
        Check(context.settings.mutations.size() == 1, "mutation with overflow journal reaches SteamVR");
        gxrsettings::SetBool("vrlink_xrvst2ue", "supports10bit", true, &error);
        Check(error == vr::VRSettingsError_None && context.settings.mutations.size() == 2, "second mutation with overflow journal succeeds");
        const auto text = ReadAll(journalFile);
        Check(Has(text, "\"value\": -1e+9999"), "journal rewrite retains raw overflow baseline");
        Check(Has(text, "\"vrlink_xrvst2ue\"") && Has(text, "\"enable\""), "new entry journaled beside the overflow entry");
        Check(Has(text, "\"lastValue\": 1536"), "existing last value retained");
    }
    // 3. Native restore skips an unrepresentable baseline but restores ordinary keys.
    {
        const std::string journal =
            "{\"schema\":1,\"driver\":\"GalaxyXRNative\",\"settingsPath\":@SETTINGS_PATH@,\"legacy\":false,"
            "\"sectionPresence\":{\"driver_vrlink\":true},"
            "\"entries\":{\"driver_vrlink\":{"
            "\"streamFormatWidth\":{\"present\":true,\"value\":-1e+9999,\"lastPresent\":true,\"lastValue\":1536},"
            "\"ordinary\":{\"present\":true,\"value\":5,\"lastPresent\":true,\"lastValue\":9}}}}";
        Begin("restore_mixed", "{\"driver_vrlink\":{\"streamFormatWidth\":1536,\"ordinary\":9}}", journal);
        context.settings.values["driver_vrlink/streamFormatWidth"] = {'i', 1536, ""};
        context.settings.values["driver_vrlink/ordinary"] = {'i', 9, ""};
        const std::string journalBefore = ReadAll(journalFile);
        gxrsettings::RestoreOwnedKey("driver_vrlink", "streamFormatWidth");
        Check(context.settings.mutations.empty(), "unrepresentable baseline is not restored natively");
        Check(Has(ReadAll(journalFile), "-1e+9999") && ReadAll(journalFile) == journalBefore, "unrepresentable baseline left byte-identical for uninstall");
        gxrsettings::RestoreOwnedKey("driver_vrlink", "ordinary");
        Check(context.settings.mutations.size() == 1 && context.settings.values["driver_vrlink/ordinary"].number == 5, "ordinary key restores");
        Check(Has(ReadAll(journalFile), "\"value\": -1e+9999"), "overflow baseline still preserved after ordinary restore");
    }
    // 4. A later external change is protected from restoration.
    {
        const std::string journal =
            "{\"schema\":1,\"driver\":\"GalaxyXRNative\",\"settingsPath\":@SETTINGS_PATH@,\"legacy\":false,"
            "\"sectionPresence\":{\"driver_vrlink\":true},"
            "\"entries\":{\"driver_vrlink\":{\"ordinary\":{\"present\":true,\"value\":5,\"lastPresent\":true,\"lastValue\":9}}}}";
        Begin("restore_external", "{\"driver_vrlink\":{\"ordinary\":12}}", journal);
        context.settings.values["driver_vrlink/ordinary"] = {'i', 12, ""};
        gxrsettings::RestoreOwnedKey("driver_vrlink", "ordinary");
        Check(context.settings.mutations.empty(), "externally changed value is not restored");
    }
    // 5. Malformed SteamVR settings fail closed.
    for (const char* bad : {"{\"driver_vrlink\":{\"streamFormatWidth\":1e}}", "{\"a\":1,", "{\"a\":01}", "{\"a\":-}", "{\"a\":1e+}", "[1]"}) {
        Begin("malformed", bad);
        vr::EVRSettingsError error = vr::VRSettingsError_None;
        gxrsettings::SetInt32("driver_vrlink", "x", 1, &error);
        Check(error == vr::VRSettingsError_WriteFailed, "malformed settings reports write failure");
        Check(context.settings.mutations.empty() && !std::filesystem::exists(journalFile), "malformed settings neither journals nor writes");
    }
    // 6. Ordinary configuration (no overflow anywhere) is byte-for-byte unchanged behaviour.
    {
        Begin("ordinary", "{\"steamvr\":{\"keep\":true,\"f\":0.5}}");
        vr::EVRSettingsError error = vr::VRSettingsError_None;
        gxrsettings::SetFloat("driver_vrlink", "f", 0.25f, &error);
        Check(error == vr::VRSettingsError_None && context.settings.mutations.size() == 1, "ordinary write applies");
        const auto text = ReadAll(journalFile);
        Check(Has(text, "\"present\": false") && Has(text, "\"lastValue\": 0.25"), "ordinary absent original journaled");
        // Simulate SteamVR flushing the write, then restore removes the key we added.
        WriteAll(settingsFile, "{\"driver_vrlink\":{\"f\":0.25},\"steamvr\":{\"keep\":true}}");
        context.settings.values["driver_vrlink/f"] = {'f', 0.25, ""};
        gxrsettings::RestoreOwnedKey("driver_vrlink", "f");
        Check(context.settings.mutations.size() == 2 && context.settings.mutations.back() == "remove driver_vrlink/f", "ordinary restore removes owned key");
    }

    if (g_forceFail) {
        Check(false, "forced failure to verify fixture retention (test-only --fail)");
    }

    const bool anyFailure = failures > 0;
    std::cout << (anyFailure ? "FAIL: " : "PASS: ") << checks << " journal IO checks; " << failures << " failures.\n";
    if (anyFailure) {
        std::cerr << "Fixture tree retained for inspection: " << g_runRoot << "\n";
        for (const auto& line : driverLogs) std::cerr << "  log: " << line << '\n';
    } else {
        try {
            ValidateFixtureRoot(g_runRoot);
            std::filesystem::remove_all(g_runRoot);
        } catch (const std::exception& e) {
            std::cerr << "WARNING: could not clean up fixture tree " << g_runRoot << ": " << e.what() << "\n";
        }
    }
    return anyFailure ? 1 : 0;
}
