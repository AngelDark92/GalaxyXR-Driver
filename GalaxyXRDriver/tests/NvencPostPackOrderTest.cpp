// 2026-09-25: exercise the real private NVENC shims with fake API/GPU calls.
// No NVENC library, GPU device, SteamVR process, or installed driver is used.
#include "../src/Driver/NvencTap.cpp"
#include <cstdlib>
#include <iostream>

namespace {
int checks = 0, failures = 0;
std::string calls;
int encoderToken, textureToken, regToken, aliasToken, mappedToken;
NVENCSTATUS mapResult = NV_ENC_SUCCESS, unmapResult = NV_ENC_SUCCESS;
NVENCSTATUS unregisterResult = NV_ENC_SUCCESS;
uint32_t seenMapVersion = 0;
bool processResult = true;

void Check(bool ok, const char* message){
	++checks;
	if(!ok){ ++failures; std::cerr << "FAIL: " << message << '\n'; }
}
NVENCSTATUS NVENCAPI FakeMap(void*, NV_ENC_MAP_INPUT_RESOURCE* p){
	calls += 'M';
	if(p){ seenMapVersion = p->version; }
	if(p && mapResult == NV_ENC_SUCCESS){ p->mappedResource = &mappedToken; }
	return mapResult;
}
NVENCSTATUS NVENCAPI FakeUnmap(void*, NV_ENC_INPUT_PTR){ calls += 'U'; return unmapResult; }
NVENCSTATUS NVENCAPI FakeUnregister(void*, NV_ENC_REGISTERED_PTR){ return unregisterResult; }
NVENCSTATUS NVENCAPI FakeEncode(void*, NV_ENC_PIC_PARAMS*){ calls += 'E'; return NV_ENC_ERR_GENERIC; }

NV_ENC_MAP_INPUT_RESOURCE Input(void* handle = &regToken){
	NV_ENC_MAP_INPUT_RESOURCE p = {};
	p.version = NV_ENC_MAP_INPUT_RESOURCE_VER;
	p.registeredResource = handle;
	return p;
}
void Reset(){
	registered.clear(); mappedToReg.clear(); upgradedSessions.clear(); calls.clear();
	mapResult = unmapResult = unregisterResult = NV_ENC_SUCCESS;
	processResult = true;
	registered[&regToken] = { &textureToken, NV_ENC_BUFFER_FORMAT_NV12, NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX };
}
}

void DriverLog(const char*, ...){}
// Fail fast if a future test accidentally invokes real hook installation or
// monitoring; these symbols are referenced by unused production functions.
Config driverConfig;
MH_STATUS WINAPI MH_Initialize(){ std::abort(); }
MH_STATUS WINAPI MH_CreateHook(LPVOID, LPVOID, LPVOID*){ std::abort(); }
MH_STATUS WINAPI MH_EnableHook(LPVOID){ std::abort(); }
NvencPostPackStats NvencPostPack::GetStats(){ std::abort(); }
void NvencPostPack::ResetIntervalStats(){ std::abort(); }
bool NvencPostPack::Process(void* texture, uint32_t format){
	calls += 'P';
	Check(texture == &textureToken && format == NV_ENC_BUFFER_FORMAT_NV12, "registered texture/format passed to CAS");
	Check(mappedToReg.empty(), "CAS executes before input is mapped");
	return processResult;
}

int main(){
	origMapInputResource = FakeMap;
	origUnmapInputResource = FakeUnmap;
	origUnregisterResource = FakeUnregister;
	origEncodePicture = FakeEncode;
	Reset();
	auto p = Input();
	Check(NvencTapShims::MapInputResource(&encoderToken, &p) == NV_ENC_SUCCESS, "map success forwarded");
	Check(calls == "PM", "CAS precedes original map");
	Check(mappedToReg[p.mappedResource] == p.registeredResource, "successful map recorded");
	NV_ENC_PIC_PARAMS pic = {};
	pic.version = NV_ENC_PIC_PARAMS_VER; pic.inputBuffer = p.mappedResource;
	Check(NvencTapShims::EncodePicture(&encoderToken, &pic) == NV_ENC_ERR_GENERIC, "encode status forwarded");
	Check(calls == "PME", "encode does not apply CAS again to mapped input");

	calls.clear();
	NvencTapShims::MapInputResource(&encoderToken, &p);
	Check(calls == "M", "duplicate map forwarded without modifying mapped texture");
	registered[&aliasToken] = registered[&regToken];
	auto alias = Input(&aliasToken);
	calls.clear();
	mapResult = NV_ENC_ERR_INVALID_PARAM;
	Check(NvencTapShims::MapInputResource(&encoderToken, &alias) == mapResult, "alias map failure forwarded");
	Check(calls == "M", "alternate registration cannot write mapped texture");

	unmapResult = NV_ENC_ERR_GENERIC;
	Check(NvencTapShims::UnmapInputResource(&encoderToken, p.mappedResource) == unmapResult, "unmap failure forwarded");
	Check(mappedToReg.count(p.mappedResource) == 1, "failed unmap retains ownership guard");
	calls.clear();
	NvencTapShims::MapInputResource(&encoderToken, &p);
	Check(calls == "M", "CAS remains blocked after failed unmap");
	unmapResult = NV_ENC_SUCCESS;
	Check(NvencTapShims::UnmapInputResource(&encoderToken, p.mappedResource) == NV_ENC_SUCCESS, "unmap succeeds");
	Check(mappedToReg.empty(), "successful unmap releases ownership guard");
	mapResult = NV_ENC_SUCCESS; calls.clear();
	NvencTapShims::MapInputResource(&encoderToken, &p);
	Check(calls == "PM", "CAS resumes for next unmapped frame");

	Reset();
	unregisterResult = NV_ENC_ERR_GENERIC;
	Check(NvencTapShims::UnregisterResource(&encoderToken, &regToken) == unregisterResult, "unregister failure forwarded");
	Check(registered.count(&regToken) == 1, "failed unregister preserves resource lookup");
	unregisterResult = NV_ENC_SUCCESS;
	Check(NvencTapShims::UnregisterResource(&encoderToken, &regToken) == NV_ENC_SUCCESS, "unregister succeeds");
	Check(registered.empty(), "successful unregister removes resource lookup");

	for(int bypass = 0; bypass < 4; ++bypass){
		Reset(); p = Input();
		if(bypass == 1){ registered.clear(); }
		if(bypass == 2){ registered[&regToken].type = NV_ENC_INPUT_RESOURCE_TYPE_CUDADEVICEPTR; }
		if(bypass == 3){ registered[&regToken].texture = nullptr; }
		NvencTapShims::MapInputResource(&encoderToken, bypass == 0 ? nullptr : &p);
		Check(calls == "M", "null/unknown/CUDA/null-texture input bypasses CAS and forwards map");
	}
	Reset(); p = Input(); processResult = false;
	Check(NvencTapShims::MapInputResource(&encoderToken, &p) == NV_ENC_SUCCESS, "CAS unavailable does not block encoding");
	Check(calls == "PM", "original map called after skipped/failed CAS");
	Reset(); p = Input(); mapResult = NV_ENC_ERR_GENERIC;
	Check(NvencTapShims::MapInputResource(&encoderToken, &p) == mapResult, "map failure returned unchanged");
	Check(mappedToReg.empty(), "failed map does not create ownership entry");
	Reset(); p = Input();
	p.version = kApi111 | (4u << 16) | (0x7u << 28);
	const auto oldVersion = p.version;
	upgradedSessions.insert(&encoderToken);
	NvencTapShims::MapInputResource(&encoderToken, &p);
	Check(seenMapVersion == Tag121(4, false), "upgraded map sees required API version");
	Check(p.version == oldVersion, "caller API version restored after map");
	std::cout << "NvencPostPackOrder: " << checks << " checks, " << failures << " failures\n";
	return failures ? 1 : 0;
}
