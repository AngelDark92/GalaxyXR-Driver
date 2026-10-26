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
#include <thread>
#include <unordered_map>
#include <vector>

// the real tap header first (locator constants + class; no implementation)
#include "../src/Driver/VrlinkTap.h"
#include "../src/Driver/VrlinkSignature.h"

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
BitratePolicyState NvencTap::GetBitratePolicyState(){ return {}; }
// Distortion globals are only read by WriteInfo's profile listing (empty here).
std::unordered_map<std::string, DistortionProfileConfig> builtInDistortionProfiles;

// --- fake module loader: the tap's only runtime dependency ------------------
namespace {
struct FakeModule {
	std::vector<uint8_t> bytes; // loaded-image layout, not a file image
	uint32_t implRva = 0;
	uint32_t workerRva = 0;
	uint32_t textRva = 0;
	uint32_t textSize = 0;
};

FakeModule gValidModule;     // authentic current layout (unshifted)
FakeModule gShiftedModule;   // same code at a different RVA (SteamVR update)
FakeModule gInvalidModule;   // worker prologue broken -> refuse
FakeModule gAmbiguousModule; // two impl prefixes -> refuse
uint8_t* gServedModule = nullptr; // what GetModuleHandleA returns
uint32_t gExpectedImplRva = 0;
uint32_t gExpectedWorkerRva = 0;

FakeModule MakeFakeModule(uint32_t textImplOffset, uint32_t textWorkerOffset, bool breakWorker, bool duplicateImpl){
	constexpr uint32_t kImageSize = 0x4000;
	constexpr uint32_t kTextRva = 0x1000;
	constexpr uint32_t kTextSize = 0x2000;
	FakeModule module;
	module.textRva = kTextRva;
	module.textSize = kTextSize;
	module.bytes.assign(kTextRva + kTextSize, 0);
	auto* dos = reinterpret_cast<IMAGE_DOS_HEADER*>(static_cast<void*>(module.bytes.data()));
	dos->e_magic = IMAGE_DOS_SIGNATURE;
	dos->e_lfanew = 0x80;
	auto* nt = reinterpret_cast<IMAGE_NT_HEADERS*>(static_cast<void*>(module.bytes.data() + dos->e_lfanew));
	nt->Signature = IMAGE_NT_SIGNATURE;
	nt->FileHeader.Machine = IMAGE_FILE_MACHINE_AMD64;
	nt->FileHeader.NumberOfSections = 1;
	nt->FileHeader.SizeOfOptionalHeader = sizeof(IMAGE_OPTIONAL_HEADER64);
	nt->FileHeader.TimeDateStamp = 0x5A5A5A5A;
	nt->OptionalHeader.Magic = IMAGE_NT_OPTIONAL_HDR64_MAGIC;
	nt->OptionalHeader.ImageBase = 0x180000000;
	nt->OptionalHeader.SectionAlignment = 0x1000;
	nt->OptionalHeader.FileAlignment = 0x200;
	nt->OptionalHeader.SizeOfImage = kImageSize;
	nt->OptionalHeader.SizeOfHeaders = 0x400;
	auto* section = IMAGE_FIRST_SECTION(nt);
	memcpy(section->Name, ".text", 5);
	section->Misc.VirtualSize = kTextSize;
	section->VirtualAddress = kTextRva;
	section->SizeOfRawData = kTextSize;
	section->PointerToRawData = 0x400;
	section->Characteristics = IMAGE_SCN_CNT_CODE | IMAGE_SCN_MEM_EXECUTE | IMAGE_SCN_MEM_READ;
	uint8_t* text = module.bytes.data() + kTextRva;
	module.implRva = kTextRva + textImplOffset;
	module.workerRva = kTextRva + textWorkerOffset;
	memcpy(text + textWorkerOffset, VrlinkSignature::kWorkerPrologue, sizeof(VrlinkSignature::kWorkerPrologue));
	if(breakWorker){ text[textWorkerOffset + 5] ^= 0xFF; }
	text[textWorkerOffset + 0x21] = 0x83;
	text[textWorkerOffset + 0x22] = 0xFA;
	text[textWorkerOffset + 0x23] = 0x74;
	const uint8_t sizeGuard[7] = {0x41, 0x81, 0xFF, 0x00, 0x00, 0x80, 0x00};
	memcpy(text + textWorkerOffset + 0x2A, sizeGuard, sizeof(sizeGuard));
	memcpy(text + textImplOffset, VrlinkSignature::kImplPrefix, sizeof(VrlinkSignature::kImplPrefix));
	const int32_t relative = static_cast<int32_t>(module.workerRva)
		- static_cast<int32_t>(module.implRva + 16);
	memcpy(text + textImplOffset + 12, &relative, sizeof(relative));
	if(duplicateImpl){
		const uint32_t second = textImplOffset + 0x100;
		memcpy(text + second, VrlinkSignature::kImplPrefix, sizeof(VrlinkSignature::kImplPrefix));
		memcpy(text + second + 12, &relative, sizeof(relative));
	}
	return module;
}

void BuildFakeModules(){
	gValidModule = MakeFakeModule(0x180, 0x100, false, false);
	// same code, moved by +0x1000: proves no fixed RVA is required
	gShiftedModule = MakeFakeModule(0x1180, 0x1100, false, false);
	gInvalidModule = MakeFakeModule(0x180, 0x100, true, false);
	gAmbiguousModule = MakeFakeModule(0x180, 0x100, false, true);
	gExpectedImplRva = gValidModule.implRva;
	gExpectedWorkerRva = gValidModule.workerRva;
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
	Check(!pre.enabled && !pre.hookInstalled && !pre.published && std::string(pre.status) == "off"
		&& std::string(pre.reason) == "off", "tap starts disabled/off");
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

// optional gate cross-check: the signature schema and the code constants agree
void CheckGateAgreement(){
	const std::string gatePath = (std::filesystem::path(TestRoot()) / ".." / "asw" / "vrlinktap-gate.json")
		.lexically_normal().string();
	std::ifstream gateFile(gatePath.c_str());
	if(!gateFile.is_open()){
		std::cout << "note: vrlinktap-gate.json not present -> evidence cross-check skipped\n";
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
		Check(gate["schema"].get<int>() == 2, "gate: schema 2");
		Check(gate["candidates"].get<int>() == 1, "gate: exactly one validated candidate");
		Check(gate["resolved"]["implRva"].get<unsigned int>() > 0
			&& gate["resolved"]["workerRva"].get<unsigned int>() > 0,
			"gate: resolved thunk/worker RVAs recorded");
		Check(gate["dll"]["sha256"].get<std::string>().size() == 64,
			"gate: module hash recorded as evidence");
		Check(gate["signature"]["impl_prefix"].get<std::string>().rfind(
			hexOf(VrlinkSignature::kImplPrefix, sizeof(VrlinkSignature::kImplPrefix)), 0) == 0,
			"gate: impl prefix agrees with VrlinkSignature.h");
		Check(gate["signature"]["worker_prologue"].get<std::string>().rfind(
			hexOf(VrlinkSignature::kWorkerPrologue, sizeof(VrlinkSignature::kWorkerPrologue)), 0) == 0,
			"gate: worker prologue agrees with VrlinkSignature.h");
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
	Check(fresh.streamFrame.spacewarpMode == 0, "config: spacewarpMode default Automatic");
	Check(fresh.streamFrame.spacewarpSettingsVersion == 1,
		"config: spacewarpSettingsVersion default 1 (legacy stamp)");
	// pinned constants (brief: UpdateValue(0x48, &one, 4) at impl rva 0xa51d80)
	Check(VrlinkTapPin::kSpacewarpValueTransportId == 0x48, "pin: carrier ValueTransportID 0x48");
	Check(VrlinkTapPin::kPublishPayloadBytes == 4, "pin: 4-byte u32 payload");
	Check(VrlinkTapPin::kPublishFlagClass == 0, "pin: flag class 0 (audited fixed-size publish form)");
	Check(VrlinkTapPin::kAuditedImplRva != VrlinkTapPin::kInstalledImplRva
		&& VrlinkTapPin::kAuditedWorkerRva != VrlinkTapPin::kInstalledWorkerRva,
		"locator: audited and installed RVAs are evidence, not a gate");
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
	// Dated semantics migration: a present Spacewarp choice keeps both values
	// and only advances the version stamp; a never-set feature stays absent.
	{
		const std::string file = base + "/CustomHeadset/settings.json";
		{
			std::ofstream out(file.c_str(), std::ios::binary);
			out << "{\"streamFrame\":{\"spacewarpEnable\":true,\"spacewarpMode\":1}}";
		}
		{
			AppdataOverride overrideAppdata(base);
			driverConfigLoader.ParseConfig();
		}
		Check(driverConfig.streamFrame.spacewarpEnable == true
			&& driverConfig.streamFrame.spacewarpMode == 1,
			"migration: an explicit enable/forced mode is preserved");
		Check(driverConfig.streamFrame.spacewarpSettingsVersion == 2,
			"migration: the dated semantics stamp advances to 2");
		std::remove(file.c_str());
		{
			AppdataOverride overrideAppdata(base);
			driverConfigLoader.ParseConfig();
		}
	}

	// the real WriteInfo -> info.json seam (pinned cross-child shape)
	BuildFakeModules();
	gServedModule = gValidModule.bytes.data();
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
				&& info["spacewarp"].contains("status")
				&& info["spacewarp"].contains("reason")
				&& info["spacewarp"].contains("requestedMode")
				&& info["spacewarp"].contains("effectiveMode")
				&& info["spacewarp"].contains("transportGeneration")
				&& info["spacewarp"].contains("auto")
				&& info["spacewarp"].contains("observedAt")
				&& info["spacewarp"].contains("implRva")
				&& info["spacewarp"].contains("workerRva")
				&& info["spacewarp"].contains("callerCount")
				&& info["spacewarp"].contains("moduleImageSize")
				&& info["spacewarp"].contains("moduleTimestamp"),
				(std::string(label) + ": seam carries the status keys plus additive diagnostics").c_str());
			Check(info["spacewarp"]["observedAt"].is_number(),
				(std::string(label) + ": observedAt is a number").c_str());
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
	{
		std::ifstream infoFile((seamBase + "/CustomHeadset/info.json").c_str());
		if(infoFile.is_open()){
			const nlohmann::json info = nlohmann::json::parse(infoFile);
			Check(info["spacewarp"]["reason"].get<std::string>() == "published",
				"seam on: reason published");
			Check(info["spacewarp"]["implRva"].get<unsigned int>() == gExpectedImplRva,
				"seam on: resolved impl RVA recorded");
			Check(info["spacewarp"]["workerRva"].get<unsigned int>() == gExpectedWorkerRva,
				"seam on: resolved worker RVA recorded");
		}
	}
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
	// deliberately use the shifted copy: the tap must resolve the signature,
	// not the audited 0xA51D80 RVA.
	gServedModule = gShiftedModule.bytes.data();
	gExpectedImplRva = gShiftedModule.implRva;
	gExpectedWorkerRva = gShiftedModule.workerRva;
	ResetTapState();
	// disabled tap: zero hooks, zero publishes, zero logs (NvencTap stays byte-identical)
	VrlinkTap::Get().SetConfig(false);
	Check(gMhCreateCalls == 0 && gHookTarget == nullptr && gImplCalls.empty() && logCalls == 0,
		"disabled tap: no hook, no publishes, no log lines");
	// enable on a moved build: the resolver must find the thunk/worker anyway
	VrlinkTap::Get().SetConfig(true);
	const auto waiting = VrlinkTap::Get().GetRuntimeState();
	Check(waiting.enabled && waiting.hookInstalled && !waiting.published && std::string(waiting.status) == "waiting",
		"enable: hooked but nothing captured -> status waiting");
	Check(std::string(waiting.reason) == "no-capture", "enable: resolver installed, no transport captured yet");
	Check(waiting.implRva == gExpectedImplRva && waiting.workerRva == gExpectedWorkerRva,
		"enable: resolved thunk/worker RVAs recorded");
	Check(gMhCreateCalls == 1 && gHookTarget == gServedModule + gExpectedImplRva,
		"enable: exactly one hook at the resolved impl RVA");
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
	CheckPublished(0x48, 4, 0, 1, "publish: UpdateValue(0x48, &one, 4) through the resolved impl");
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
	// 2026-10-26: requested and effective modes are separate. Automatic (stored
	// 0) starts at late-frame recovery and the tracker raises it to half rate;
	// Forced (stored 1) publishes carrier 2 regardless of measured FPS.
	{
		const size_t beforeModes = gImplCalls.size();
		VrlinkTap::Get().SetConfig(false);
		VrlinkTap::Get().SetConfig(true, 0);
		Check(gImplCalls.size() == beforeModes + 2 && gImplCalls.back().id == 0x48
			&& (gImplCalls.back().payload & gImplCalls.back().payloadMask) == 1,
			"automatic: a stored 0 starts in late-frame recovery (carrier 1)");
		VrlinkTap::Get().SetEffectiveMode(2);
		Check(gImplCalls.size() == beforeModes + 3 && gImplCalls.back().id == 0x48
			&& (gImplCalls.back().payload & gImplCalls.back().payloadMask) == 2,
			"automatic: the cadence decision publishes carrier 2");
		const size_t afterHalf = gImplCalls.size();
		VrlinkTap::Get().SetEffectiveMode(2);
		Check(gImplCalls.size() == afterHalf,
			"automatic: an unchanged effective mode never republishes");
		VrlinkTap::Get().SetEffectiveMode(1);
		Check(gImplCalls.size() == afterHalf + 1
			&& (gImplCalls.back().payload & gImplCalls.back().payloadMask) == 1,
			"automatic: recovery publishes carrier 1");
		VrlinkTap::Get().SetConfig(false);
		VrlinkTap::Get().SetConfig(true, 1);
		Check(gImplCalls.size() == afterHalf + 3 && gImplCalls.back().id == 0x48
			&& (gImplCalls.back().payload & gImplCalls.back().payloadMask) == 2,
			"forced: a stored 1 publishes carrier 2");
		VrlinkTap::Get().SetEffectiveMode(1);
		Check((gImplCalls.back().payload & gImplCalls.back().payloadMask) == 2,
			"forced: the automatic decision cannot lower the carrier");
		VrlinkTap::Get().SetConfig(false);
		VrlinkTap::Get().SetConfig(true, 7);
		Check(gImplCalls.back().id == 0x48
			&& (gImplCalls.back().payload & gImplCalls.back().payloadMask) == 1,
			"an unknown stored mode applies as Automatic (carrier 1) and is not rewritten");
		VrlinkTap::Get().SetConfig(true, 1);  // leave forced for the reconnect case
	}
	// 2026-10-17: post-restart republish — a NEW transport instance resets the
	// stale latch and auto-publishes for the fresh connection with no reload
	const int beforeReconnect = (int)gImplCalls.size();
	VrlinkTapShims::UpdateValueTap(gServedModule + 0x10, 11, &width, 4, 0);
	const auto reconnect = VrlinkTap::Get().GetRuntimeState();
	Check(reconnect.published && std::string(reconnect.status) == "on",
		"reconnect: fresh transport republished without a settings reload");
	Check((int)gImplCalls.size() == beforeReconnect + 2 && gImplCalls.size() >= 2
		&& gImplCalls[gImplCalls.size() - 2].id == 0x48
		&& (gImplCalls[gImplCalls.size() - 2].payload & gImplCalls[gImplCalls.size() - 2].payloadMask) == 2
		&& gImplCalls[gImplCalls.size() - 1].id == 11,
		"reconnect: one 0x48=2 (forced) republish + one passthrough in hook order");
	CheckPublished(0x48, 4, 0, 2, "reconnect: the fresh connection carries 0x48=2");
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
int ScenarioResolveFail(){
	BuildFakeModules();
	gServedModule = gInvalidModule.bytes.data();
	ResetTapState();
	VrlinkTap::Get().SetConfig(true);
	auto state = VrlinkTap::Get().GetRuntimeState();
	Check(state.enabled && !state.hookInstalled && !state.published && std::string(state.status) == "waiting",
		"invalid worker: fail-closed observe-only, status waiting");
	Check(std::string(state.reason) == "worker-not-found", "invalid worker: reason worker-not-found");
	Check(gMhCreateCalls == 0, "invalid worker: no hook is created");
	bool refusedLogged = false;
	for(const auto &line : logHistory){
		if(line.find("no validated UpdateValue signature") != std::string::npos){ refusedLogged = true; }
	}
	Check(refusedLogged, "invalid worker: the fail-closed reason is in the driver log");
	VrlinkTap::Get().SetConfig(false);
	const auto off = VrlinkTap::Get().GetRuntimeState();
	Check(gImplCalls.empty() && std::string(off.status) == "off" && std::string(off.reason) == "off",
		"invalid worker: off flips nothing and does not touch the stream");
	std::cout << "spacewarp resolve fail: " << checks << " checks, " << failures << " failures\n";
	return failures == 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
int ScenarioRetry(){
	BuildFakeModules();
	gServedModule = nullptr;
	ResetTapState();
	VrlinkTap::Get().SetConfig(true);
	auto state = VrlinkTap::Get().GetRuntimeState();
	Check(state.enabled && !state.hookInstalled && std::string(state.status) == "waiting",
		"module absent: enabled -> waiting, nothing hooked");
	Check(std::string(state.reason) == "module-absent", "module absent: reason module-absent");
	Check(gMhCreateCalls == 0, "module absent: no hook attempt");
	// the old ten-miss latch would have permanently disabled this; the tap must
	// retry when vrlink appears later in the same process.
	std::this_thread::sleep_for(std::chrono::milliseconds(1100)); // past the 1/s throttle
	gServedModule = gValidModule.bytes.data();
	gExpectedImplRva = gValidModule.implRva;
	gExpectedWorkerRva = gValidModule.workerRva;
	logCalls = 0;
	VrlinkTap::Get().SetConfig(true);
	state = VrlinkTap::Get().GetRuntimeState();
	Check(state.hookInstalled && state.implRva == gExpectedImplRva
		&& state.workerRva == gExpectedWorkerRva,
		"module appears later: retry resolves the thunk/worker");
	Check(gMhCreateCalls == 1, "module appears later: exactly one hook");
	Check(std::string(state.reason) == "no-capture",
		"module appears later: waits for a transport capture");
	std::cout << "spacewarp retry: " << checks << " checks, " << failures << " failures\n";
	return failures == 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
int ScenarioSignature(){
	BuildFakeModules();
	auto resolve = [](const FakeModule& module){
		return VrlinkSignature::Resolve(module.bytes.data() + module.textRva,
			module.textSize, module.textRva, 0x4000);
	};
	const auto valid = resolve(gValidModule);
	Check(valid.ok && valid.implRva == gValidModule.implRva
		&& valid.workerRva == gValidModule.workerRva,
		"signature: valid module resolves the thunk/worker");
	Check(valid.callerCount == 0, "signature: caller count is diagnostic (fake has no calls)");
	const auto shifted = resolve(gShiftedModule);
	Check(shifted.ok && shifted.implRva == gShiftedModule.implRva
		&& shifted.workerRva == gShiftedModule.workerRva,
		"signature: shifted copy resolves the moved RVAs");
	const auto invalid = resolve(gInvalidModule);
	Check(!invalid.ok && std::string(invalid.reason) == "worker-not-found",
		"signature: broken worker prologue refuses");
	const auto ambiguous = resolve(gAmbiguousModule);
	Check(!ambiguous.ok && std::string(ambiguous.reason) == "impl-ambiguous",
		"signature: duplicate impl prefixes refuse");
	const auto outside = VrlinkSignature::Resolve(gValidModule.bytes.data() + gValidModule.textRva,
		gValidModule.textSize, 0x3000, 0x4000);
	Check(!outside.ok && std::string(outside.reason) == "section-out-of-image",
		"signature: out-of-image section refuses");
	std::cout << "spacewarp signature: " << checks << " checks, " << failures << " failures\n";
	return failures == 0 ? 0 : 1;
}

int ScenarioCadence(){
	gxr::AswCadenceTracker tracker;
	double refresh = 90.0;
	tracker.SetRefreshHz(refresh);
	tracker.SetRequested(true, 0);
	Check(tracker.EffectiveMode() == gxr::AswCadenceTracker::kLateFrames,
		"cadence: Automatic starts in late-frame recovery");
	Check(tracker.SampleDue(0.0), "cadence: first sample is immediately due");
	tracker.MarkSampled(0.0);
	Check(!tracker.SampleDue(0.05), "cadence: a second sample inside 100 ms is refused");
	Check(tracker.SampleDue(0.10), "cadence: the ten-per-second cadence is allowed at 100 ms");

	uint32_t index = 1;
	double frameTime = 0.0;
	auto feed = [&](double now, double fps, int records){
		gxr::AswTimingFrame frames[16];
		const double interval = 1.0 / fps;
		// Emit this sample's newest records in ascending order, ending at the
		// sample time so the application timeline never runs ahead of the clock.
		double first = now - (records - 1) * interval;
		if(first <= frameTime) first = frameTime + interval;
		for(int i = 0; i < records; ++i){
			frames[i].frameIndex = index++;
			frames[i].systemTimeSeconds = first + i * interval;
		}
		frameTime = frames[records - 1].systemTimeSeconds;
		tracker.MarkSampled(now);
		tracker.Observe(now, refresh, frames, static_cast<size_t>(records));
	};

	// One second of 90 FPS application timing (10 samples x 9 frames).
	for(int sample = 1; sample <= 11; ++sample){ feed(sample * 0.1, 90.0, 9); }
	Check(tracker.HaveValidHistory(), "cadence: one second of 90 FPS history is valid");
	Check(tracker.MeasuredFps() > 88.0 && tracker.MeasuredFps() < 92.0,
		"cadence: measured FPS comes from advancing frame timestamps");
	Check(tracker.EffectiveMode() == gxr::AswCadenceTracker::kLateFrames,
		"cadence: 90 FPS at 90 Hz stays in late-frame recovery");

	// Drop to 45 FPS. Entry requires 500 ms of continuous low cadence.
	feed(1.2, 45.0, 4);
	feed(1.3, 45.0, 4);
	feed(1.4, 45.0, 4);
	feed(1.5, 45.0, 4);
	Check(tracker.EffectiveMode() == gxr::AswCadenceTracker::kLateFrames,
		"cadence: no half rate before the 500 ms entry hold");
	for(int sample = 16; sample <= 20; ++sample){ feed(sample * 0.1, 45.0, 4); }
	Check(tracker.EffectiveMode() == gxr::AswCadenceTracker::kHalfRate,
		"cadence: 45 FPS at 90 Hz enters half rate after 500 ms");
	Check(tracker.Reason() == std::string("auto-low-fps"), "cadence: entry reason recorded");

	// 85 FPS is inside the 0.90-0.97 hysteresis band: keep half rate.
	for(int sample = 21; sample <= 26; ++sample){ feed(sample * 0.1, 85.0, 8); }
	Check(tracker.EffectiveMode() == gxr::AswCadenceTracker::kHalfRate,
		"cadence: the hysteresis band holds half rate");

	// Recovery needs 2 s at >= 97% of refresh.
	for(int sample = 27; sample <= 44; ++sample){ feed(sample * 0.1, 90.0, 9); }
	Check(tracker.EffectiveMode() == gxr::AswCadenceTracker::kHalfRate,
		"cadence: no recovery before the two-second exit hold");
	for(int sample = 45; sample <= 65; ++sample){ feed(sample * 0.1, 90.0, 9); }
	Check(tracker.EffectiveMode() == gxr::AswCadenceTracker::kLateFrames,
		"cadence: 90 FPS recovers after two seconds");
	Check(tracker.Reason() == std::string("auto-recovered"), "cadence: exit reason recorded");

	// Deduplicate overlapping records: replaying the newest record must not
	// inflate the measured FPS or the history.
	const double fpsBefore = tracker.MeasuredFps();
	gxr::AswTimingFrame duplicate[1] = {{index - 1, frameTime}};
	tracker.Observe(6.55, refresh, duplicate, 1);
	Check(tracker.MeasuredFps() == fpsBefore, "cadence: duplicate frame index is ignored");

	// Forced bypasses thresholds even with no valid history.
	tracker.SetRequested(true, 1);
	Check(tracker.EffectiveMode() == gxr::AswCadenceTracker::kHalfRate,
		"cadence: Forced half-rate bypasses the FPS thresholds");
	tracker.SetRefreshHz(72.0);
	Check(tracker.EffectiveMode() == gxr::AswCadenceTracker::kHalfRate,
		"cadence: refresh change does not lower a forced request");
	tracker.SetRequested(true, 0);
	Check(tracker.EffectiveMode() == gxr::AswCadenceTracker::kLateFrames,
		"cadence: leaving Forced returns to late-frame recovery until re-measured");

	// Refresh change resets automatic history and requires a fresh second.
	tracker.SetRefreshHz(72.0);
	Check(!tracker.HaveValidHistory(), "cadence: refresh change clears the history");
	Check(tracker.EffectiveMode() == gxr::AswCadenceTracker::kLateFrames,
		"cadence: refresh change resets the decision to late-frame recovery");
	refresh = 72.0;
	frameTime = 0.0;  // the refresh change cleared history; restart the app timeline
	for(int sample = 50; sample <= 60; ++sample){ feed(sample * 0.1, 72.0, 8); }
	Check(tracker.HaveValidHistory() && tracker.EffectiveMode() == gxr::AswCadenceTracker::kLateFrames,
		"cadence: 72 FPS at 72 Hz is normal after refresh re-warm");

	// Stale timing (>500 ms without a sample) resets to late-frame recovery.
	tracker.Evaluate(7.2);
	Check(tracker.EffectiveMode() == gxr::AswCadenceTracker::kLateFrames,
		"cadence: stale timing falls back to late-frame recovery");
	Check(tracker.Reason() == std::string("stale-timing"), "cadence: stale reason recorded");

	// Re-establish a live app timeline so the frame-index reset below is
	// distinguishable from a cold start.
	for(int sample = 73; sample <= 75; ++sample){ feed(sample * 0.1, 72.0, 8); }

	// Application change: a newer timestamp with a reset frame index clears
	// history and restarts the one-second evidence window.
	gxr::AswTimingFrame restarted[3] = {{1, 7.8}, {2, 7.81}, {3, 7.82}};
	tracker.Observe(7.9, 72.0, restarted, 3);
	Check(tracker.Reason() == std::string("application-changed"),
		"cadence: frame-index reset with newer timestamps is an application change");
	Check(!tracker.HaveValidHistory(), "cadence: application change clears the history");

	// Explicit reconnect boundary also resets, keeping the requested mode.
	tracker.SetRequested(true, 0);
	tracker.NotifyBoundary("reconnect");
	Check(tracker.EffectiveMode() == gxr::AswCadenceTracker::kLateFrames,
		"cadence: reconnect resets Automatic to late-frame recovery");
	tracker.SetRequested(false, 0);
	Check(tracker.EffectiveMode() == gxr::AswCadenceTracker::kOff, "cadence: Off publishes off");

	// Provider record order is not guaranteed: a newest-first sample must
	// still build the same one-second history (otherwise the measured FPS
	// collapses to the sample rate and automatic mode falsely enters half rate).
	{
		gxr::AswCadenceTracker reversed;
		reversed.SetRefreshHz(90.0);
		reversed.SetRequested(true, 0);
		uint32_t idx = 1;
		double ft = 0.0;
		for(int sample = 1; sample <= 11; ++sample){
			const double now = sample * 0.1;
			gxr::AswTimingFrame frames[9];
			for(int i = 0; i < 9; ++i){
				frames[i].frameIndex = idx + static_cast<uint32_t>(8 - i);
				frames[i].systemTimeSeconds = now - i * (1.0 / 90.0);
			}
			idx += 9;
			ft = frames[0].systemTimeSeconds;
			reversed.Observe(now, 90.0, frames, 9);
		}
		(void)ft;
		Check(reversed.HaveValidHistory() && reversed.MeasuredFps() > 80.0,
			"cadence: newest-first provider records still measure application FPS");
	}

	// The provider requests 32 overlapping records at 10 Hz. Feeding only the
	// nine unique frames would undercount; the tracker must deduplicate the
	// overlapping 32-record samples and still measure ~90 FPS.
	{
		gxr::AswCadenceTracker wide;
		wide.SetRefreshHz(90.0);
		wide.SetRequested(true, 0);
		uint32_t newestIndex = 0;
		for(int sample = 1; sample <= 15; ++sample){
			const double now = sample * 0.1;
			if(sample == 1) newestIndex = 32;
			else newestIndex += 9;
			gxr::AswTimingFrame frames[32];
			for(int i = 0; i < 32; ++i){
				frames[i].systemTimeSeconds = now - i * (1.0 / 90.0);
				frames[i].frameIndex = newestIndex - static_cast<uint32_t>(i);
			}
			wide.Observe(now, 90.0, frames, 32);
		}
		Check(wide.HaveValidHistory() && wide.MeasuredFps() > 88.0,
			"cadence: 32-record overlapping provider samples do not undercount 90 FPS");
	}

	// Model the actual provider contract: poll at 10 Hz, return the newest 32
	// records including pre-poll history, and advance frames at their own rate.
	// Deliberately give OpenVR timestamps an epoch unrelated to local time.
	auto pollWindow = [](gxr::AswCadenceTracker& target, double now, double elapsed,
		double fps, double epoch, uint32_t firstIndex, double hz = 90.0){
		const uint32_t produced = static_cast<uint32_t>(std::floor(elapsed * fps + 1e-7));
		gxr::AswTimingFrame frames[32];
		for(uint32_t i = 0; i < 32; ++i){
			frames[i].frameIndex = firstIndex + produced - i;
			frames[i].systemTimeSeconds = epoch + (static_cast<double>(produced) - i) / fps;
		}
		target.MarkSampled(now);
		target.Observe(now, hz, frames, 32);
	};

	// A narrow 0.98..1.02 s window permanently rejected 20.5 FPS: twenty
	// intervals span 0.9756 s and twenty-one span 1.0244 s. Real fractional
	// application cadences must remain measurable through the 128-entry ring.
	const double fractionalRates[] = {20.5, 23.5, 59.94};
	for(double fps : fractionalRates){
		gxr::AswCadenceTracker fractional;
		fractional.SetRequested(true, 0);
		bool continuouslyValid = true;
		bool continuouslyHalfRate = true;
		for(int sample = 0; sample <= 600; ++sample){
			const double elapsed = sample * 0.1;
			pollWindow(fractional, 100.0 + elapsed, elapsed, fps, 1000.0, 1000);
			if(sample >= 20){
				continuouslyValid = continuouslyValid && fractional.HaveValidHistory();
				continuouslyHalfRate = continuouslyHalfRate
					&& fractional.EffectiveMode() == gxr::AswCadenceTracker::kHalfRate;
			}
		}
		Check(continuouslyValid && std::fabs(fractional.MeasuredFps() - fps) < 0.001,
			"cadence: fractional low FPS remains valid and accurate for sixty seconds");
		Check(continuouslyHalfRate,
			"cadence: fractional low FPS enters half rate and remains there");
		Check(fractional.HistorySpanSeconds() >= 1.0
			&& fractional.HistorySpanSeconds() <= 1.0 + 1.0 / fps + 1e-7,
			"cadence: fractional history retains only the one-second bracketing interval");
	}

	// Enabling with a full 30 FPS history must not count the pre-enable
	// second or start the 500 ms hold early. Every reset needs the same fresh
	// second, including a new application's first already-populated poll.
	for(int boundary = 0; boundary < 8; ++boundary){
		gxr::AswCadenceTracker fresh;
		fresh.SetRequested(true, 0);
		for(int sample = 0; sample <= 20; ++sample){
			pollWindow(fresh, 20.0 + sample * 0.1, sample * 0.1, 30.0, 5000.0, 1000);
		}
		Check(fresh.EffectiveMode() == gxr::AswCadenceTracker::kHalfRate,
			"cadence: boundary regression begins with established half rate");
		double start = 22.1;
		double epoch = 5002.1;
		uint32_t firstIndex = 2000;
		double hz = 90.0;
		switch(boundary){
		case 0: fresh.NotifyBoundary("reconnect"); break;
		case 1: hz = 72.0; fresh.SetRefreshHz(hz); break;
		case 2: fresh.SetRequested(true, 1); fresh.SetRequested(true, 0); break;
		case 3: fresh.SetRequested(false, 0); fresh.SetRequested(true, 0); break;
		case 4:
			// Replaying a poll is not frame advancement and cannot postpone stale.
			pollWindow(fresh, 22.4, 2.0, 30.0, 5000.0, 1000);
			fresh.Evaluate(22.6);
			Check(fresh.Reason() == std::string("stale-timing"),
				"cadence: repeated historical polls expire using local freshness");
			start = 22.7;
			break;
		case 5: epoch = 5003.0; firstIndex = 100; break; // app index resets
		case 6: start = 1.0; break; // local clock resets; OpenVR keeps its epoch
		case 7:
			// A newly constructed/enabled tracker also has no trusted watermark.
			fresh = gxr::AswCadenceTracker{};
			fresh.SetRequested(true, 0);
			break;
		}
		pollWindow(fresh, start, 0.0, 30.0, epoch, firstIndex, hz);
		Check(!fresh.HaveValidHistory() && fresh.HistoryCount() == 1,
			"cadence: first post-boundary poll establishes only a newest-frame baseline");
		bool prematureHistory = false;
		bool prematureHalfRate = false;
		for(int sample = 1; sample <= 9; ++sample){
			pollWindow(fresh, start + sample * 0.1, sample * 0.1, 30.0, epoch, firstIndex, hz);
			prematureHistory = prematureHistory || fresh.HaveValidHistory();
			prematureHalfRate = prematureHalfRate
				|| fresh.EffectiveMode() == gxr::AswCadenceTracker::kHalfRate;
		}
		Check(!prematureHistory && !prematureHalfRate,
			"cadence: pre-boundary records cannot shorten the fresh one-second warmup");
		pollWindow(fresh, start + 1.0, 1.0, 30.0, epoch, firstIndex, hz);
		Check(fresh.HaveValidHistory(), "cadence: a full fresh second completes warmup");
		for(int sample = 11; sample <= 14; ++sample){
			pollWindow(fresh, start + sample * 0.1, sample * 0.1, 30.0, epoch, firstIndex, hz);
		}
		Check(fresh.EffectiveMode() == gxr::AswCadenceTracker::kLateFrames,
			"cadence: fresh warmup does not consume the separate 500 ms entry hold");
		pollWindow(fresh, start + 1.6, 1.6, 30.0, epoch, firstIndex, hz);
		Check(fresh.EffectiveMode() == gxr::AswCadenceTracker::kHalfRate,
			"cadence: fresh warmup plus the entry hold permits half rate");
	}

	// Both clocks must independently cover the evidence window. Rapidly
	// returned timestamps spanning >1 s cannot compress local warmup to 600 ms.
	{
		gxr::AswCadenceTracker rapid;
		rapid.SetRequested(true, 0);
		for(int sample = 0; sample <= 6; ++sample){
			pollWindow(rapid, 200.0 + sample * 0.1, sample * 0.2, 30.0, 8000.0, 1000);
		}
		Check(!rapid.HaveValidHistory()
			&& rapid.EffectiveMode() == gxr::AswCadenceTracker::kLateFrames,
			"cadence: advancing OpenVR timestamps cannot bypass local one-second warmup");
	}

	std::cout << "spacewarp cadence: " << checks << " checks, " << failures << " failures\n";
	return failures == 0 ? 0 : 1;
}

int RunScenario(const char* name){
	if(std::string(name) == "config"){ return ScenarioConfig(); }
	if(std::string(name) == "tap"){ return ScenarioTap(); }
	if(std::string(name) == "resolvefail"){ return ScenarioResolveFail(); }
	if(std::string(name) == "retry"){ return ScenarioRetry(); }
	if(std::string(name) == "signature"){ return ScenarioSignature(); }
	if(std::string(name) == "cadence"){ return ScenarioCadence(); }
	return 2;
}
}

int main(int argc, char** argv){
	// child mode: run exactly one scenario (fresh tap singleton, latches reset)
	if(argc == 2){ return RunScenario(argv[1]); }
	// parent mode: self-spawn each scenario and aggregate
	static const char* scenarios[] = { "config", "tap", "resolvefail", "retry", "signature", "cadence" };
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
	std::cout << "spacewarp toggle: " << (6 - failed) << "/6 scenarios ok\n";
	return failed == 0 ? 0 : 1;
}
