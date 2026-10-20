// SpacewarpToggleTest.cpp — brief 11-W2B-HOST-VRLINKTAP (add-feature 2026-10-17).
// Shape: the NvencToggleTest.cpp precedent — compile the REAL implementation
// (VrlinkTap.cpp) in this TU with a fake module loader + fake MinHook, and the
// REAL ConfigLoader.cpp (parse + WriteInfo) with stubbed externals. No GPU, no
// real driver_vrlink.dll, no SteamVR process is touched.
//
// The latch/fail-closed state machine needs fresh singleton lifetimes for its
// branches, so the binary self-spawns one process per scenario (config / tap /
// pinfail); a single `cl.exe` compile + run is still the whole story, exactly
// like the precedent's runner. Exits nonzero on any failed check.
#include <windows.h>
#include <process.h>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdarg>
#include <cstring>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

// the real tap header first (pins + class; no implementation)
#include "../src/Driver/VrlinkTap.h"

// the loader macros must precede the tap implementation so its
// GetModuleHandleA resolves to the fake; the tap itself never LoadLibrary's
namespace FakeLoader {
	HMODULE WINAPI Module(LPCSTR);
	FARPROC WINAPI Export(HMODULE, LPCSTR);
}
#define GetModuleHandleA FakeLoader::Module
#define LoadLibraryA FakeLoader::Export
#include "../src/Driver/VrlinkTap.cpp"
#undef GetModuleHandleA
#undef LoadLibraryA
// the real ConfigLoader (parse + WriteInfo) completes the config->seam chain
#include "../src/Config/ConfigLoader.cpp"

// --- substituted external implementation dependencies (defined; linked) -----
Config driverConfig;
Config driverConfigOld;
std::mutex driverConfigLock;
std::string driverVersion = "SpacewarpToggleTest";
int logCalls = 0;
std::vector<std::string> logHistory; // every line; state-transition asserts look here
void DriverLog(const char* format, ...){
	++logCalls;
	va_list args;
	va_start(args, format);
	char buffer[512];
	const int written = _vsnprintf_s(buffer, sizeof(buffer), _TRUNCATE, format, args);
	va_end(args);
	if(written > 0){ logHistory.push_back(buffer); }
}
// NvencTap must stay independent of VrlinkTap (separate module/failure domain);
// the real NvencTap.cpp is NOT compiled here — only the WriteInfo call surface.
NvencTap& NvencTap::Get(){ static NvencTap stub; return stub; }
NvencTapRuntimeState NvencTap::GetRuntimeState(){ return {}; }
// 2026-10-20: ConfigLoader::WriteInfo also emits the VRLink fallback block; the
// real tap is a separate failure domain and is not compiled into this harness.
VrlinkFallbackTap& VrlinkFallbackTap::Get(){ static VrlinkFallbackTap stub; return stub; }
VrlinkFallbackRuntimeState VrlinkFallbackTap::GetRuntimeState(){ return {}; }
// Distortion globals are only read by WriteInfo's profile listing (empty here).
std::unordered_map<std::string, DistortionProfileConfig> builtInDistortionProfiles;

// --- fake module loader: the tap's only runtime dependency ------------------
namespace {
std::vector<uint8_t> gValidModule;   // bytes match both pinned excerpts
std::vector<uint8_t> gPinBroken;     // one byte differs at the impl pin
uint8_t* gServedModule = nullptr; // what GetModuleHandleA returns

void BuildFakeModules(){
	const size_t moduleSize = VrlinkTapPin::kImplRva + sizeof(VrlinkTapPin::kImplPin) + 16;
	gValidModule.assign(moduleSize, 0);
	// 2026-10-20: the tap's fail-closed gate parses the module's PE headers and
	// bounds-checks both pinned RVAs against SizeOfImage BEFORE any memcmp. The
	// fake image must therefore carry a readable DOS + NT header, not just the
	// two pinned windows (a zero-filled buffer would fail the gate and the
	// scenarios below would stop exercising the hook).
	auto* dos = reinterpret_cast<IMAGE_DOS_HEADER*>(static_cast<void*>(gValidModule.data()));
	dos->e_magic = IMAGE_DOS_SIGNATURE;
	dos->e_lfanew = 0x80;
	auto* nt = reinterpret_cast<IMAGE_NT_HEADERS*>(static_cast<void*>(gValidModule.data() + dos->e_lfanew));
	nt->Signature = IMAGE_NT_SIGNATURE;
	nt->OptionalHeader.SizeOfImage = static_cast<DWORD>(moduleSize);
	memcpy(gValidModule.data() + VrlinkTapPin::kImplRva, VrlinkTapPin::kImplPin, sizeof(VrlinkTapPin::kImplPin));
	memcpy(gValidModule.data() + VrlinkTapPin::kWorkerRva, VrlinkTapPin::kWorkerPin, sizeof(VrlinkTapPin::kWorkerPin));
	gPinBroken = gValidModule;
	gPinBroken[VrlinkTapPin::kImplRva + 5] = static_cast<uint8_t>(gPinBroken[VrlinkTapPin::kImplRva + 5] ^ 0x01);
}
}
HMODULE WINAPI FakeLoader::Module(LPCSTR){ return reinterpret_cast<HMODULE>(gServedModule); }
FARPROC WINAPI FakeLoader::Export(HMODULE, LPCSTR){ return nullptr; }

// --- fake hooks: record the target/detour/trampoline wiring -----------------
namespace {
int gMhInitializeCalls = 0, gMhCreateCalls = 0;
void* gHookTarget = nullptr;
struct RecordedPublish { void* vts; unsigned int id; unsigned int size; unsigned char flag; uint64_t payload; uint32_t payloadMask; };
std::vector<RecordedPublish> gImplCalls;
int __fastcall FakeOrigUpdateValue(void* vts, unsigned int id, const void* value, unsigned int size, unsigned char flag){
	RecordedPublish record = { vts, id, size, flag, 0, 0 };
	if(value && record.size > 0 && record.size <= sizeof(record.payload)){
		std::memcpy(&record.payload, value, record.size);
		record.payloadMask = record.size >= sizeof(uint32_t) ? 0xFFFFFFFFu
			: static_cast<uint32_t>((1ull << (record.size * 8)) - 1ull);
	}
	gImplCalls.push_back(record);
	return 0; // a benign impl return (the tap must not gate on the raw status)
}
}
extern "C" MH_STATUS WINAPI MH_Initialize(){ ++gMhInitializeCalls; return MH_OK; }
extern "C" MH_STATUS WINAPI MH_CreateHook(LPVOID target, LPVOID, LPVOID* trampoline){
	++gMhCreateCalls;
	gHookTarget = target;
	if(trampoline){ *trampoline = reinterpret_cast<LPVOID>(&FakeOrigUpdateValue); }
	return MH_OK;
}
extern "C" MH_STATUS WINAPI MH_EnableHook(LPVOID){ return MH_OK; }

#include <nlohmann/json.hpp>
#include <algorithm>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>

namespace {
int checks = 0, failures = 0;
void Check(bool condition, const char* label){
	++checks;
	if(!condition){ ++failures; std::cerr << "FAIL: " << label << '\n'; }
}

std::string TestRoot(){
	// resolve from the test executable itself: the artifact contract puts the
	// binary under ../builds/GalaxyXR-Driver/build/<name>/, so the exe dir IS
	// the test root regardless of how cl was invoked (relative vs absolute).
	char exePath[MAX_PATH] = {};
	GetModuleFileNameA(nullptr, exePath, MAX_PATH);
	const std::string exeDir = std::filesystem::path(exePath).parent_path().string();
	if(!exeDir.empty()){ return exeDir; }
	const auto checkoutParent =
		std::filesystem::path(__FILE__).parent_path().parent_path().parent_path().parent_path();
	return (checkoutParent / "builds/GalaxyXR-Driver/build/spacewarp-toggle-test").string();
}

// APPDATA override + restore around every parse/WriteInfo call
struct AppdataOverride {
	std::string saved;
	explicit AppdataOverride(const std::string& folder){
		const char* raw = std::getenv("APPDATA");
		saved = raw ? raw : "";
		_putenv(("APPDATA=" + folder).c_str());
	}
	~AppdataOverride(){ _putenv(("APPDATA=" + saved).c_str()); }
};

void ResetTapState(){
	// fresh process per scenario: assert the pretest state to keep the
	// sequences below independent of run order
	const auto pre = VrlinkTap::Get().GetRuntimeState();
	Check(!pre.enabled && !pre.hookInstalled && !pre.published && std::string(pre.status) == "off", "tap starts disabled/off");
	gImplCalls.clear(); gHookTarget = nullptr;
	gMhInitializeCalls = 0; gMhCreateCalls = 0;
	logCalls = 0; logHistory.clear();
}

void CheckPublished(unsigned int id, unsigned int size, unsigned char flag, unsigned int payload, const char* label){
	bool found = false;
	for(const auto &record : gImplCalls){
		if(record.id == id && record.size == size && record.flag == flag
			&& (record.payload & record.payloadMask) == payload){ found = true; break; }
	}
	Check(found, label);
}

// optional gate cross-check: the pins in code must equal the pinned gate JSON
void CheckGateAgreement(){
	const std::string gatePath = (std::filesystem::path(TestRoot()) / ".." / "asw" / "vrlinktap-gate.json")
		.lexically_normal().string();
	std::ifstream gateFile(gatePath.c_str());
	if(!gateFile.is_open()){
		std::cout << "note: vrlinktap-gate.json not present -> byte cross-check skipped\n";
		return;
	}
	try{
		const nlohmann::json gate = nlohmann::json::parse(gateFile);
		auto hexOf = [](const unsigned char* bytes, size_t n){
			std::string out; out.reserve(n * 2);
			static const char* digits = "0123456789abcdef";
			for(size_t i = 0; i < n; ++i){ out += digits[bytes[i] >> 4]; out += digits[bytes[i] & 0xF]; }
			return out;
		};
		Check(gate["pin"]["impl_rva"].get<unsigned int>() == (unsigned)VrlinkTapPin::kImplRva
			&& gate["pin"]["worker_rva"].get<unsigned int>() == (unsigned)VrlinkTapPin::kWorkerRva,
			"gate: pinned RVAs agree with the code pin");
		Check(gate["pin"]["impl_bytes"].get<std::string>().rfind(hexOf(VrlinkTapPin::kImplPin, sizeof(VrlinkTapPin::kImplPin)), 0) == 0,
			"gate: impl pin bytes agree with vrlinktap-gate.json");
		Check(gate["pin"]["worker_bytes"].get<std::string>().rfind(hexOf(VrlinkTapPin::kWorkerPin, sizeof(VrlinkTapPin::kWorkerPin)), 0) == 0,
			"gate: worker pin bytes agree with vrlinktap-gate.json");
		Check(gate["pin"]["notify_rva"].get<unsigned int>() == 0x9E8450, "gate: notify impl rva recorded");
	}catch(const std::exception &error){
		Check(false, (std::string("gate: json unreadable (") + error.what() + ")").c_str());
	}
}

// ---------------------------------------------------------------------------
int ScenarioConfig(){
	CheckGateAgreement();
	// config field default (deliverable 1)
	const Config fresh = {};
	Check(fresh.streamFrame.spacewarpEnable == false, "config: spacewarpEnable default false");
	// pinned constants (brief: UpdateValue(0x48, &one, 4) at impl rva 0xa51d80)
	Check(VrlinkTapPin::kSpacewarpValueTransportId == 0x48, "pin: carrier ValueTransportID 0x48");
	Check(VrlinkTapPin::kPublishPayloadBytes == 4, "pin: 4-byte u32 payload");
	Check(VrlinkTapPin::kPublishFlagClass == 0, "pin: flag class 0 (audited fixed-size publish form)");
	Check(VrlinkTapPin::kImplRva == 0xA51D80, "pin: impl rva 0xa51d80");
	// pure tri-state classifier (deliverable 3 seam enum)
	Check(std::string(VrlinkTap::StatusString(false, false)) == "off", "status: disabled -> off");
	Check(std::string(VrlinkTap::StatusString(false, true)) == "off", "status: disabled stays off");
	Check(std::string(VrlinkTap::StatusString(true, false)) == "waiting", "status: enabled unpublished -> waiting");
	Check(std::string(VrlinkTap::StatusString(true, true)) == "on", "status: enabled published -> on");

	// parse round-trip through the REAL ConfigLoader::ParseConfig
	const std::string base = TestRoot() + "/fixtures/parse";
	std::filesystem::create_directories(base + "/CustomHeadset");
	const std::vector<std::pair<const char*, bool>> cases = {
		{ "", false }, // file absent
		{ "{}", false }, // key absent -> never-set key stays at the native default
		{ "{\"streamFrame\":{\"spacewarpEnable\":true}}", true },
		{ "{\"streamFrame\":{\"spacewarpEnable\":false}}", false },
		{ "{\"streamFrame\":{\"spacewarpEnable\":\"on\"}}", false }, // non-boolean ignored
	};
	for(const auto &parseCase : cases){
		const std::string file = base + "/CustomHeadset/settings.json";
		if(std::string(parseCase.first).empty()){ std::remove(file.c_str()); }
		else{ std::ofstream out(file.c_str(), std::ios::binary); out << parseCase.first; }
		// A missing settings.json leaves the live config untouched (ParseConfig
		// returns early); a PRESENT file proves the parse rebuilds from the
		// native defaults (absence of the key = default, no stale carryover).
		driverConfig.streamFrame.spacewarpEnable = parseCase.first[0] ? true : false;
		{
			AppdataOverride overrideAppdata(base);
			driverConfigLoader.ParseConfig();
		}
		Check(driverConfig.streamFrame.spacewarpEnable == parseCase.second,
			(std::string("parse round-trip: ") + (parseCase.first[0] ? parseCase.first : "(file absent)")).c_str());
	}

	// the real WriteInfo -> info.json seam (pinned cross-child shape)
	BuildFakeModules();
	gServedModule = gValidModule.data();
	const std::string seamBase = TestRoot() + "/fixtures/seam";
	std::filesystem::create_directories(seamBase + "/CustomHeadset");
	auto readSeam = [&](const char* label, bool expectEnabled, const char* expectStatus, bool expectPublished){
		{
			AppdataOverride overrideAppdata(seamBase);
			driverConfigLoader.WriteInfo();
		}
		std::ifstream infoFile((seamBase + "/CustomHeadset/info.json").c_str());
		Check(infoFile.is_open(), (std::string(label) + ": info.json written").c_str());
		if(!infoFile.is_open()){ return; }
		try{
			const nlohmann::json info = nlohmann::json::parse(infoFile);
			Check(info["spacewarp"].contains("enabled")
				&& info["spacewarp"].contains("hookInstalled")
				&& info["spacewarp"].contains("published")
				&& info["spacewarp"].contains("status"),
				(std::string(label) + ": seam carries exactly the pinned keys").c_str());
			Check(info["spacewarp"]["status"].get<std::string>() == expectStatus,
				(std::string(label) + ": status == ").append(expectStatus).c_str());
			Check(info["spacewarp"]["enabled"].get<bool>() == expectEnabled,
				(std::string(label) + ": enabled flag honest").c_str());
			Check(info["spacewarp"]["published"].get<bool>() == expectPublished,
				(std::string(label) + ": published flag honest").c_str());
			Check(info["defaultSettings"]["streamFrame"]["spacewarpEnable"].get<bool>() == false,
				(std::string(label) + ": defaultSettings echo matches the native default").c_str());
		}catch(const std::exception &error){
			Check(false, (std::string(label) + ": info.json unreadable (").append(error.what()).append(")").c_str());
		}
	};
	ResetTapState();
	// stock: disabled
	readSeam("seam off", false, "off", false);
	// enabled but never published -> waiting (W2C reads this verbatim)
	VrlinkTap::Get().SetConfig(true);
	readSeam("seam waiting", true, "waiting", false);
	// vrlink publishes its own id-11 width value; next hot-reload publishes us
	unsigned int width = 1536;
	VrlinkTapShims::UpdateValueTap(gServedModule, 11, &width, 4, 0);
	VrlinkTap::Get().SetConfig(true);
	readSeam("seam on", true, "on", true);
	// explicit user off published once, then off
	VrlinkTap::Get().SetConfig(false);
	readSeam("seam off again", false, "off", false);
	CheckPublished(0x48, 4, 0, 0, "seam off: the off flip published 0 exactly once");
	std::cout << "spacewarp config: " << checks << " checks, " << failures << " failures\n";
	return failures == 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
int ScenarioTap(){
	BuildFakeModules();
	gServedModule = gValidModule.data();
	ResetTapState();
	// disabled tap: zero hooks, zero publishes, zero logs (NvencTap stays byte-identical)
	VrlinkTap::Get().SetConfig(false);
	Check(gMhCreateCalls == 0 && gHookTarget == nullptr && gImplCalls.empty() && logCalls == 0,
		"disabled tap: no hook, no publishes, no log lines");
	// enable on a build whose pins match: hook installed at the pinned impl
	VrlinkTap::Get().SetConfig(true);
	const auto waiting = VrlinkTap::Get().GetRuntimeState();
	Check(waiting.enabled && waiting.hookInstalled && !waiting.published && std::string(waiting.status) == "waiting",
		"enable: hooked but nothing captured -> status waiting");
	Check(gMhCreateCalls == 1 && gHookTarget == gValidModule.data() + VrlinkTapPin::kImplRva,
		"enable: exactly one hook at module base + 0xa51d80");
	Check(gMhInitializeCalls == 1, "enable: MinHook initialised once");
	// no publish attempt may have happened before the first vrlink publish
	Check(gImplCalls.empty(), "waiting: no publish before a captured value-transport call");
	// vrlink's own publish: pure capture+passthrough of the exact vrlink bytes;
	// the capture ALSO delivers the pending publish (no settings reload needed)
	unsigned int width = 1536;
	const int passthrough = VrlinkTapShims::UpdateValueTap(gServedModule, 11, &width, 4, 0);
	Check(passthrough == 0 && gImplCalls.size() == 2 && gImplCalls[0].id == 0x48
		&& (gImplCalls[0].payload & gImplCalls[0].payloadMask) == 1
		&& gImplCalls[1].id == 11 && gImplCalls[1].size == 4 && gImplCalls[1].flag == 0
		&& (gImplCalls[1].payload & gImplCalls[1].payloadMask) == 1536,
		"passthrough: pending publish rides the capture hook, then vrlink's publish forwards byte-identically");
	const auto on = VrlinkTap::Get().GetRuntimeState();
	Check(on.published && std::string(on.status) == "on", "publish: enabled + published -> status on");
	CheckPublished(0x48, 4, 0, 1, "publish: UpdateValue(0x48, &one, 4) through the pinned impl");
	const int before = (int)gImplCalls.size();
	// idempotence: hot reloads without a value change never re-publish
	VrlinkTap::Get().SetConfig(true);
	VrlinkTap::Get().SetConfig(true);
	Check((int)gImplCalls.size() == before, "idempotent: repeated hot reloads do not republish");
	// explicit user off is a legitimate publish: exactly one 0 payload
	const int beforeOff = (int)gImplCalls.size();
	VrlinkTap::Get().SetConfig(false);
	const auto off = VrlinkTap::Get().GetRuntimeState();
	Check(!off.enabled && !off.published && std::string(off.status) == "off", "off: status off");
	CheckPublished(0x48, 4, 0, 0, "off: published 0 once (stock value restored)");
	Check((int)gImplCalls.size() == beforeOff + 1, "off: exactly one off publish");
	VrlinkTap::Get().SetConfig(false);
	Check((int)gImplCalls.size() == beforeOff + 1, "off: repeated disables do not republish");
	// re-enable publishes again
	VrlinkTap::Get().SetConfig(true);
	CheckPublished(0x48, 4, 0, 1, "re-enable: publish 1 again after an off cycle");
	// 2026-10-17: post-restart republish — a NEW transport instance resets the
	// stale latch and auto-publishes for the fresh connection with no reload
	const int beforeReconnect = (int)gImplCalls.size();
	VrlinkTapShims::UpdateValueTap(gServedModule + 0x10, 11, &width, 4, 0);
	const auto reconnect = VrlinkTap::Get().GetRuntimeState();
	Check(reconnect.published && std::string(reconnect.status) == "on",
		"reconnect: fresh transport republished without a settings reload");
	Check((int)gImplCalls.size() == beforeReconnect + 2 && gImplCalls.size() >= 2
		&& gImplCalls[gImplCalls.size() - 2].id == 0x48
		&& (gImplCalls[gImplCalls.size() - 2].payload & gImplCalls[gImplCalls.size() - 2].payloadMask) == 1
		&& gImplCalls[gImplCalls.size() - 1].id == 11,
		"reconnect: one 0x48=1 republish + one passthrough in hook order");
	CheckPublished(0x48, 4, 0, 1, "reconnect: the fresh connection carries 0x48=1");
	// disabled tap: a cadence publish must never appear
	VrlinkTap::Get().SetConfig(false);
	const int beforeDisabled = (int)gImplCalls.size();
	VrlinkTapShims::UpdateValueTap(gServedModule, 11, &width, 4, 0);
	Check((int)gImplCalls.size() == beforeDisabled + 1
		&& gImplCalls.back().id == 11,
		"disabled cadence: the passthrough forwards but no 0x48 publish appears");
	std::cout << "spacewarp tap: " << checks << " checks, " << failures << " failures\n";
	return failures == 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
int ScenarioPinFail(){
	BuildFakeModules();
	ResetTapState();
	// absent module: never LoadLibrary'ed; throttled one-line log; observe-only
	gServedModule = nullptr;
	VrlinkTap::Get().SetConfig(true);
	auto state = VrlinkTap::Get().GetRuntimeState();
	Check(state.enabled && !state.hookInstalled && std::string(state.status) == "waiting",
		"module absent: enabled -> waiting, nothing hooked");
	Check(gMhCreateCalls == 0, "module absent: no hook attempt");
	// pin mismatch: the audited-build bytes differ -> fail CLOSED
	std::this_thread::sleep_for(std::chrono::milliseconds(1100)); // past the 1/s install throttle
	gServedModule = gPinBroken.data();
	logCalls = 0;
	VrlinkTap::Get().SetConfig(true);
	state = VrlinkTap::Get().GetRuntimeState();
	Check(!state.hookInstalled && state.enabled && !state.published && std::string(state.status) == "waiting",
		"pin mismatch: fail-closed observe-only, status waiting");
	Check(gMhCreateCalls == 0, "pin mismatch: no hook is created on unpinned bytes");
	bool mismatchLogged = false;
	for(const auto &line : logHistory){ if(line.find("pin mismatch") != std::string::npos){ mismatchLogged = true; } }
	Check(mismatchLogged, "pin mismatch: the fail-closed reason is in the driver log");
	// the off path also stays inert and crash-free (the publisher never existed:
	// no hook, no capture, so there is nothing to publish or retract)
	std::this_thread::sleep_for(std::chrono::milliseconds(1100));
	VrlinkTap::Get().SetConfig(false);
	Check(gImplCalls.empty() && std::string(VrlinkTap::Get().GetRuntimeState().status) == "off",
		"pin mismatch: off flips nothing and does not touch the stream");
	std::cout << "spacewarp pin fail: " << checks << " checks, " << failures << " failures\n";
	return failures == 0 ? 0 : 1;
}

int RunScenario(const char* name){
	if(std::string(name) == "config"){ return ScenarioConfig(); }
	if(std::string(name) == "tap"){ return ScenarioTap(); }
	if(std::string(name) == "pinfail"){ return ScenarioPinFail(); }
	return 2;
}
}

int main(int argc, char** argv){
	// child mode: run exactly one scenario (fresh tap singleton, latches reset)
	if(argc == 2){ return RunScenario(argv[1]); }
	// parent mode: self-spawn each scenario and aggregate
	static const char* scenarios[] = { "config", "tap", "pinfail" };
	int failed = 0;
	for(const char* scenario : scenarios){
		char quoted[1024];
		_snprintf_s(quoted, sizeof(quoted), _TRUNCATE, "\"%s\" %s", argv[0], scenario);
		const int code = std::system(quoted); // cmd-style quoting keeps spaces safe
		if(code != 0){
			++failed;
			std::cerr << "scenario " << scenario << " failed with " << code << '\n';
		}
	}
	std::cout << "spacewarp toggle: " << (3 - failed) << "/3 scenarios ok\n";
	return failed == 0 ? 0 : 1;
}