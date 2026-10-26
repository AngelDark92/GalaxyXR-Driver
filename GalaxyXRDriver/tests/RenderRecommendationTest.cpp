// Production component wrapping and recommendation callback with a fake VRLink
// display that reproduces the inspected binary's independent 100..4096 clamps.
#include "Driver/DeviceShim.h"
#include "Config/Config.h"
#include <algorithm>
#include <iostream>
#include <mutex>
#include <cstring>
Config driverConfig;
std::mutex driverConfigLock;
void DriverLog(const char*, ...) {}
class RenderTargetTestShim : public ShimDefinition {
public:
    bool active = true;
    uint32_t loggedRenderWidth = 0, loggedRenderHeight = 0;
    void PosTrackedDeviceGetComponent(const char*&, void*&) override;
    void PosDisplayComponentGetRecommendedRenderTargetSize(uint32_t*&, uint32_t*&) override;
};
vr::IVRDisplayComponent* ownedDisplay = nullptr;
bool IsVrlinkDisplayComponent(vr::IVRDisplayComponent* display) { return display == ownedDisplay; }
#include "RenderRecommendation.generated.h"
struct ClampingDisplay : vr::IVRDisplayComponent {
    uint32_t width = 5376, height = 4973;
    int queries = 0;
    void GetRecommendedRenderTargetSize(uint32_t* w, uint32_t* h) override {
        ++queries;
        *w = std::clamp(width, 100u, 4096u);
        *h = std::clamp(height, 100u, 4096u);
    }
    void GetWindowBounds(int32_t*, int32_t*, uint32_t*, uint32_t*) override {}
    bool IsDisplayOnDesktop() override { return false; }
    bool IsDisplayRealDisplay() override { return false; }
    void GetEyeOutputViewport(vr::EVREye, uint32_t*, uint32_t*, uint32_t*, uint32_t*) override {}
    void GetProjectionRaw(vr::EVREye, float*, float*, float*, float*) override {}
    vr::DistortionCoordinates_t ComputeDistortion(vr::EVREye, float, float) override { return {}; }
    bool ComputeInverseDistortion(vr::HmdVector2_t*, vr::EVREye, uint32_t, float, float) override { return false; }
};
int checks = 0, failures = 0;
void Check(bool ok, const char* label) {
    ++checks;
    if(!ok) { ++failures; std::cerr << "FAIL: " << label << '\n'; }
}
int main() {
    ClampingDisplay display, otherHeadset;
    ownedDisplay = &display;
    RenderTargetTestShim shim;
    const char* version = vr::IVRDisplayComponent_Version;
    void* component = &display;
    shim.PosTrackedDeviceGetComponent(version, component);
    Check(component != &display && component, "VRLink component is wrapped");
    auto* wrapper = static_cast<ShimDisplayComponent*>(component);
    uint32_t w = 0, h = 0;
    display.GetRecommendedRenderTargetSize(&w, &h);
    Check(w == 4096 && h == 4096, "upstream clamp reproduces square base for 5376x4973");
    for(const auto& pair : {std::pair<int,int>{5376,4973}, {5568,5150}, {4973,5376}, {5000,3000}, {3000,5000}, {3552,3840}, {1,16384}}) {
        driverConfig.galaxyXr.renderWidth = display.width = pair.first;
        driverConfig.galaxyXr.renderHeight = display.height = pair.second;
        const auto count = display.queries;
        wrapper->GetRecommendedRenderTargetSize(&w, &h);
        Check(w == pair.first && h == pair.second, "requested dimensions survive the production callback");
        Check(display.queries == count + 1, "original display callback still runs exactly once");
    }
    driverConfig.galaxyXr.nativeResolution = false;
    wrapper->GetRecommendedRenderTargetSize(&w, &h);
    Check(w == 100 && h == 4096, "OFF preserves original driver behavior");
    driverConfig.galaxyXr.nativeResolution = true;
    shim.active = false;
    wrapper->GetRecommendedRenderTargetSize(&w, &h);
    Check(w == 100 && h == 4096, "inactive HMD preserves original behavior");
    shim.active = true;
    shim.shimActive = false;
    wrapper->GetRecommendedRenderTargetSize(&w, &h);
    Check(w == 100 && h == 4096, "disabled framework shim preserves original behavior");
    shim.shimActive = true;
    driverConfig.galaxyXr.renderWidth = 5376;
    driverConfig.galaxyXr.renderHeight = 4973;
    for(bool identity : {false, true}) for(bool profile : {false, true}) {
        driverConfig.galaxyXr.nativeIdentity = identity;
        driverConfig.galaxyXr.vrlinkHeadsetProfile = profile;
        wrapper->GetRecommendedRenderTargetSize(&w, &h);
        Check(w == 5376 && h == 4973, "identity and profile switches do not gate manual dimensions");
    }
    for(const auto& key : {"renderWidth", "overrideRenderWidth"}) {
        driverConfig.galaxyXr.vrlinkExtraKeys = {{key,'i',4000}};
        display.width = 4000;
        wrapper->GetRecommendedRenderTargetSize(&w, &h);
        Check(w == 4000 && h == 4973, "expert width owns only its axis");
    }
    for(const auto& key : {"renderHeight", "overrideRenderHeight"}) {
        driverConfig.galaxyXr.vrlinkExtraKeys = {{key,'x',0}};
        display.height = 2048;
        wrapper->GetRecommendedRenderTargetSize(&w, &h);
        Check(w == 5376 && h == 2048, "expert height removal retains upstream fallback on its axis");
    }
    component = &otherHeadset;
    shim.PosTrackedDeviceGetComponent(version, component);
    Check(component == &otherHeadset, "other headset components are never wrapped");
    component = &display;
    const char* unknown = "IVRDisplayComponent_999";
    shim.PosTrackedDeviceGetComponent(unknown, component);
    Check(component == &display, "unrecognized interface versions are untouched");
    component = nullptr;
    shim.PosTrackedDeviceGetComponent(version, component);
    Check(!component, "missing interface remains unsupported");
    uint32_t* nullWidth = nullptr;
    uint32_t* heightPointer = &h;
    shim.PosDisplayComponentGetRecommendedRenderTargetSize(nullWidth, heightPointer);
    Check(!nullWidth, "null output pointers remain safe");
    delete wrapper;
    std::cout << "Render recommendation: " << checks << " checks, " << failures << " failures\n";
    return failures ? 1 : 0;
}
