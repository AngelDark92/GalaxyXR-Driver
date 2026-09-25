// 2026-09-25 toggle regression: production input callbacks/state extracted by
// Test-ControllerToggles.ps1; API, device identity, and clock are memory-only.
#include "Config/Config.h"
#include "openvr_driver.h"
#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <vector>

Config driverConfig;
static double testNow = 100.0;
static double TestNow() { return testNow; }
static std::vector<std::string> logs;
static void DriverLog(const char* format, ...) {
    char buffer[2048];
    va_list args;
    va_start(args, format);
    vsnprintf(buffer, sizeof(buffer), format, args);
    va_end(args);
    logs.emplace_back(buffer);
}
static int checks = 0, failures = 0;
static void Check(bool condition, const std::string& label) {
    ++checks;
    if (!condition) { ++failures; std::cerr << "FAIL: " << label << '\n'; }
}
static bool Near(double actual, double expected) { return std::abs(actual - expected) < 0.000001; }
static int LogsStarting(const char* prefix) {
    return static_cast<int>(std::count_if(logs.begin(), logs.end(), [&](const auto& line) { return line.rfind(prefix, 0) == 0; }));
}

class GalaxyXRDeviceProvider {
public:
#include "ControllerState.generated.h"
    std::map<vr::VRInputComponentHandle_t, InputComponentInfo> inputComponents;
    std::map<vr::PropertyContainerHandle_t, int> containerHand;
    std::map<uint32_t, int> openVRIDHand;
    std::map<uint32_t, KalState> kalStates;
    std::map<uint32_t, DeriveFilterState> deriveFilterStates;
    std::map<uint32_t, VelFixState> velFixStates;
    std::map<uint32_t, MotionSnapshot> motionSnapshots;
    std::mutex poseLogLock, gripTouchLock, deriveFilterLock;
    std::atomic<bool> tunerInputActive{false};
    double lastReleaseLogTime = 0, lastEdgeLogTime = 0;
    uint32_t ResolveContainerId(vr::PropertyContainerHandle_t container) {
        std::lock_guard<std::mutex> guard(poseLogLock);
        return container >= 1 && container <= 3 ? static_cast<uint32_t>(container) : vr::k_unTrackedDeviceIndexInvalid;
    }
    bool IsNativeHand(uint32_t id) { return id == 3; }
    bool IsStreamedController(uint32_t id) { return id == 1 || id == 2; }
    void OnInputComponentCreated(vr::PropertyContainerHandle_t, const char*, vr::VRInputComponentHandle_t, vr::EVRInputError);
    void OnScalarComponentCreated(vr::PropertyContainerHandle_t, const char*, vr::VRInputComponentHandle_t, vr::EVRInputError);
    void OnScalarComponentUpdated(vr::VRInputComponentHandle_t, float, double, vr::EVRInputError);
    void OnBooleanComponentUpdated(vr::VRInputComponentHandle_t, bool, double, vr::EVRInputError);
    void UpdateGripTouch(vr::VRInputComponentHandle_t);
    void RefreshGripTouch();
    void HandleInputRelease(vr::PropertyContainerHandle_t, const std::string&);
    void LogReleaseSnapshot(vr::PropertyContainerHandle_t, const std::string&);
    void AnchorReleaseGesture(uint32_t);
    void OnSkeletonComponentCreated(vr::PropertyContainerHandle_t, const char*, const char*, vr::VRInputComponentHandle_t);
    bool HandleSkeletonUpdate(vr::VRInputComponentHandle_t, const vr::VRBoneTransform_t*, uint32_t, vr::VRBoneTransform_t*);
};

struct FakeDriverInput {
    GalaxyXRDeviceProvider* provider = nullptr;
    int creates = 0, attempts = 0;
    bool available = true, failCreate = false, failNextUpdate = false;
    vr::VRInputComponentHandle_t next = 1000;
    std::map<vr::PropertyContainerHandle_t, vr::VRInputComponentHandle_t> created;
    std::vector<std::pair<vr::VRInputComponentHandle_t, bool>> updates;
    vr::EVRInputError CreateBooleanComponent(vr::PropertyContainerHandle_t container, const char* name, vr::VRInputComponentHandle_t* handle) {
        ++creates;
        if (failCreate || created.count(container)) return vr::VRInputError_InvalidHandle;
        *handle = ++next;
        created[container] = *handle;
        // This callback synchronously takes the production input map lock.
        provider->OnInputComponentCreated(container, name, *handle, vr::VRInputError_None);
        return vr::VRInputError_None;
    }
    vr::EVRInputError UpdateBooleanComponent(vr::VRInputComponentHandle_t handle, bool value, double offset) {
        ++attempts;
        if (failNextUpdate) { failNextUpdate = false; return vr::VRInputError_InvalidHandle; }
        updates.emplace_back(handle, value);
        provider->OnBooleanComponentUpdated(handle, value, offset, vr::VRInputError_None);
        return vr::VRInputError_None;
    }
};
static FakeDriverInput input;
static FakeDriverInput* TestDriverInput() { return input.available ? &input : nullptr; }
static std::mutex skeletonTapMutex;
static std::map<vr::VRInputComponentHandle_t, int> skeletonTapHands;
#include "ControllerMethods.generated.h"

struct Fixture {
    GalaxyXRDeviceProvider provider;
    Fixture() {
        driverConfig = Config{};
        driverConfig.galaxyXr.nativeInputProfile = true;
        driverConfig.galaxyXr.synthesizeGripTouch = true;
        driverConfig.galaxyXr.controllerBypass = false;
        driverConfig.streamFrame.poseLogging = false;
        driverConfig.streamFrame.velocityFixMode = 0;
        input = FakeDriverInput{};
        input.provider = &provider;
        skeletonTapHands.clear();
        logs.clear();
        testNow = 100.0;
    }
    void Scalar(vr::VRInputComponentHandle_t handle = 10, vr::PropertyContainerHandle_t container = 1, const char* name = "/input/grip/value") {
        provider.OnScalarComponentCreated(container, name, handle, vr::VRInputError_None);
    }
    void Pressure(float value, vr::VRInputComponentHandle_t handle = 10, vr::EVRInputError error = vr::VRInputError_None) {
        provider.OnScalarComponentUpdated(handle, value, 0, error);
    }
    void Boolean(vr::VRInputComponentHandle_t handle, vr::PropertyContainerHandle_t container) {
        provider.OnInputComponentCreated(container, "/input/grip/click", handle, vr::VRInputError_None);
    }
    void Button(vr::VRInputComponentHandle_t handle, bool value) {
        provider.OnBooleanComponentUpdated(handle, value, 0, vr::VRInputError_None);
    }
};

static void TestGripTransitions() {
    Fixture f;
    f.Scalar();
    Check(input.creates == 1 && input.updates.empty(), "ON creates a dormant touch with a reentrant registration callback");
    const auto touch = f.provider.inputComponents.at(10).gripTouchHandle;
    Check(f.provider.inputComponents.count(touch) == 1, "synthetic boolean registration is retained");
    f.Pressure(0.5f);
    Check(input.updates.size() == 1 && input.updates.back().second, "pressure ON asserts touch");
    driverConfig.galaxyXr.synthesizeGripTouch = false;
    f.provider.RefreshGripTouch();
    Check(input.updates.size() == 2 && !input.updates.back().second, "OFF releases asserted touch without another pressure update");
    f.provider.RefreshGripTouch(); f.Pressure(0); f.Pressure(1); f.provider.RefreshGripTouch();
    Check(input.updates.size() == 2, "OFF pressure and repeated polling generate no additional synthetic input");
    driverConfig.galaxyXr.synthesizeGripTouch = true;
    f.provider.RefreshGripTouch();
    Check(input.creates == 1 && input.updates.size() == 3 && input.updates.back().second, "ON again reuses existing component and latest pressure");
    driverConfig.galaxyXr.nativeInputProfile = false;
    f.provider.RefreshGripTouch();
    Check(input.updates.size() == 4 && !input.updates.back().second, "native input profile OFF releases touch");
    driverConfig.galaxyXr.nativeInputProfile = true;
    f.provider.RefreshGripTouch();
    driverConfig.galaxyXr.controllerBypass = true;
    f.provider.RefreshGripTouch();
    Check(input.updates.size() == 6 && !input.updates.back().second, "controller bypass releases touch");
    f.Pressure(0); f.Pressure(1); f.provider.RefreshGripTouch();
    Check(input.updates.size() == 6, "bypass suppresses subsequent pressure synthesis");
}

static void TestGripLifecycle() {
    for (int disabledBy = 0; disabledBy < 3; ++disabledBy) {
        Fixture f;
        if (disabledBy == 0) driverConfig.galaxyXr.synthesizeGripTouch = false;
        if (disabledBy == 1) driverConfig.galaxyXr.nativeInputProfile = false;
        if (disabledBy == 2) driverConfig.galaxyXr.controllerBypass = true;
        f.Scalar(); f.Pressure(0.8f); f.provider.RefreshGripTouch();
        Check(input.creates == 0 && input.updates.empty(), "disabled startup does not create or drive touch");
        driverConfig.galaxyXr.synthesizeGripTouch = true;
        driverConfig.galaxyXr.nativeInputProfile = true;
        driverConfig.galaxyXr.controllerBypass = false;
        f.provider.RefreshGripTouch();
        Check(input.creates == 1 && input.updates.size() == 1 && input.updates.back().second, "enabling uses already-existing scalar source without reconnect");
    }
    {
        Fixture f;
        f.Scalar(10, 1, "/input/joystick/y"); f.Pressure(1);
        f.Scalar(11, 3); f.Pressure(1, 11); f.provider.RefreshGripTouch();
        Check(input.creates == 0 && input.updates.empty(), "non-grip scalars and native hands remain untouched");
    }
    {
        Fixture f;
        input.available = false;
        f.Scalar(); f.Pressure(0.8f);
        input.available = true;
        f.provider.RefreshGripTouch();
        Check(input.creates == 1 && input.updates.size() == 1, "API becoming available preserves pending source");
    }
    {
        Fixture f;
        input.failCreate = true;
        f.Scalar(); f.Pressure(0.8f); f.provider.RefreshGripTouch();
        Check(input.creates == 1 && input.updates.empty(), "failed create is not retried every input/frame");
        driverConfig.galaxyXr.synthesizeGripTouch = false; f.provider.RefreshGripTouch();
        input.failCreate = false;
        driverConfig.galaxyXr.synthesizeGripTouch = true; f.provider.RefreshGripTouch();
        Check(input.creates == 2 && input.updates.size() == 1, "toggle retries a failed create safely");
    }
    {
        Fixture f;
        f.Scalar(); f.Pressure(0.5f);
        driverConfig.galaxyXr.synthesizeGripTouch = false;
        input.failNextUpdate = true;
        f.provider.RefreshGripTouch();
        Check(f.provider.inputComponents.at(10).gripTouched && input.updates.size() == 1, "failed release retains pending asserted state");
        f.provider.RefreshGripTouch();
        Check(!f.provider.inputComponents.at(10).gripTouched && input.updates.size() == 2 && !input.updates.back().second, "next poll retries failed release");
    }
}

static void TestGripHysteresis() {
    Fixture f;
    f.Scalar(); f.Pressure(0.04f); f.Pressure(0.02f);
    Check(input.updates.size() == 1 && input.updates.back().second, "held touch uses lower release threshold");
    f.Pressure(0.01f);
    Check(input.updates.size() == 2 && !input.updates.back().second, "touch releases below half threshold");
    f.Pressure(0.5f, 10, vr::VRInputError_InvalidHandle);
    Check(input.updates.size() == 2, "failed pressure update cannot assert touch");
    driverConfig.galaxyXr.gripTouchThreshold = 0;
    f.Pressure(0.004f); Check(input.updates.size() == 2, "threshold lower bound preserved");
    f.Pressure(0.006f); Check(input.updates.size() == 3 && input.updates.back().second, "threshold lower bound activates above 0.005");
    f.Pressure(0);
    driverConfig.galaxyXr.gripTouchThreshold = 1;
    f.Pressure(0.6f);
    Check(input.updates.size() == 5 && input.updates.back().second, "threshold upper bound remains 0.5");
}

static void TestReleaseEffects() {
    for (int mode : {3, 4}) for (bool logging : {false, true}) for (bool scalar : {false, true}) {
        Fixture f;
        driverConfig.galaxyXr.synthesizeGripTouch = false;
        driverConfig.streamFrame.velocityFixMode = mode;
        driverConfig.streamFrame.deriveReleaseLatch = true;
        driverConfig.streamFrame.deriveLatchHoldMs = 100;
        driverConfig.streamFrame.kalmanReleaseRewindMs = 30;
        driverConfig.streamFrame.kalmanRewindHoldMs = 80;
        driverConfig.streamFrame.poseLogging = logging;
        if (scalar) { f.Scalar(10, 1); f.Scalar(20, 2); }
        else { f.Boolean(10, 1); f.Boolean(20, 2); }
        logs.clear();
        if (scalar) { f.Pressure(1, 10); f.Pressure(1, 20); }
        else { f.Button(10, true); f.Button(20, true); }
        logs.clear();
        if (scalar) f.Pressure(0, 10); else f.Button(10, false);
        testNow = 100.01;
        if (scalar) f.Pressure(0, 20); else f.Button(20, false);
        if (mode == 3) {
            Check(Near(f.provider.deriveFilterStates[1].latchUntil, 100.1), "first release arms latch independently of logging");
            Check(Near(f.provider.deriveFilterStates[2].latchUntil, 100.11), "second hand within 50ms also arms latch");
        } else {
            Check(Near(f.provider.kalStates[1].rewindUntil, 100.08) && Near(f.provider.kalStates[1].rewindTarget, 99.97), "first release arms correct rewind window");
            Check(Near(f.provider.kalStates[2].rewindUntil, 100.09) && Near(f.provider.kalStates[2].rewindTarget, 99.98), "second hand within 50ms also arms rewind");
        }
        Check(logging ? LogsStarting("ReleaseSnap:") == 1 : logs.empty(), "poseLogging OFF silent; ON throttles diagnostics only");
        testNow = 100.08;
        if (scalar) { f.Pressure(1, 20); f.Pressure(0, 20); }
        else { f.Button(20, true); f.Button(20, false); }
        Check(logging ? LogsStarting("ReleaseSnap:") == 2 : logs.empty(), "logging resumes after throttle without controlling release effects");
    }
    for (int mode : {3, 4}) {
        Fixture f;
        driverConfig.streamFrame.velocityFixMode = mode;
        driverConfig.streamFrame.deriveReleaseLatch = false;
        driverConfig.streamFrame.kalmanReleaseRewindMs = 0;
        f.Boolean(10, 1); logs.clear(); f.Button(10, true); f.Button(10, false);
        Check(f.provider.kalStates.empty() && f.provider.deriveFilterStates.empty() && logs.empty(), "disabled release feature remains inactive with logging OFF");
    }
    {
        Fixture f;
        driverConfig.streamFrame.velocityFixMode = 3;
        driverConfig.streamFrame.deriveReleaseLatch = true;
        f.Boolean(10, 1); f.Button(10, true);
        driverConfig.streamFrame.poseLogging = true;
        f.Button(10, false);
        Check(f.provider.deriveFilterStates[1].latchUntil > testNow, "logging enabled mid-grip retains the real held edge");
        driverConfig.streamFrame.poseLogging = false;
        logs.clear();
        f.provider.LogReleaseSnapshot(1, "test");
        Check(logs.empty(), "diagnostic helper itself respects logging OFF");
    }
    {
        Fixture f;
        driverConfig.streamFrame.velocityFixMode = 2;
        f.Scalar(10, 1, "/input/trigger/value"); logs.clear();
        f.Pressure(0.95f); f.Pressure(0.9f);
        Check(Near(f.provider.velFixStates[1].anchorTime, testNow) && logs.empty(), "existing mode-2 release gesture remains independent of diagnostics");
    }
    {
        Fixture f;
        driverConfig.streamFrame.velocityFixMode = 3;
        driverConfig.streamFrame.deriveReleaseLatch = true;
        f.Boolean(10, 3); f.Button(10, true); f.Button(10, false);
        Check(f.provider.deriveFilterStates.empty() && f.provider.kalStates.empty(), "native-hand release cannot arm controller motion adjustment");
    }
}

static void TestSkeletonBypass() {
    Fixture f;
    driverConfig.galaxyXr.skeletonOffsetXCm = 2;
    driverConfig.galaxyXr.skeletonOffsetYCm = 3;
    driverConfig.galaxyXr.skeletonOffsetZCm = 4;
    driverConfig.galaxyXr.skeletonOffsetMirror = true;
    f.provider.OnSkeletonComponentCreated(1, "/input/skeleton/left", "/skeleton/hand/left", 10);
    f.provider.OnSkeletonComponentCreated(2, "/input/skeleton/right", "/skeleton/hand/right", 20);
    f.provider.OnSkeletonComponentCreated(3, "/input/skeleton/left", "/skeleton/hand/left", 30);
    vr::VRBoneTransform_t bones[3]{}, output[3]{};
    Check(f.provider.HandleSkeletonUpdate(10, bones, 3, output) && Near(output[1].position.v[0], 0.02), "controller skeleton offset works before bypass");
    Check(f.provider.HandleSkeletonUpdate(20, bones, 3, output) && Near(output[1].position.v[0], -0.02), "right skeleton offset still mirrors");
    driverConfig.galaxyXr.controllerBypass = true;
    const auto before = output[1];
    Check(!f.provider.HandleSkeletonUpdate(10, bones, 3, output) && std::memcmp(&before, &output[1], sizeof(before)) == 0, "bypass declines skeleton mutation and leaves output untouched");
    driverConfig.galaxyXr.controllerBypass = false;
    Check(f.provider.HandleSkeletonUpdate(10, bones, 3, output) && Near(output[1].position.v[2], 0.04), "bypass OFF restores configured offsets");
    Check(!f.provider.HandleSkeletonUpdate(30, bones, 3, output), "native hand skeleton remains passthrough");
}

static void TestRejectedRelease() {
    for (int mode : {3, 4}) for (bool scalar : {false, true}) {
        Fixture f;
        driverConfig.galaxyXr.synthesizeGripTouch = false;
        driverConfig.streamFrame.velocityFixMode = mode;
        driverConfig.streamFrame.deriveReleaseLatch = true;
        driverConfig.streamFrame.kalmanReleaseRewindMs = 30;
        f.provider.tunerInputActive = true;
        if (scalar) { f.Scalar(); f.Pressure(1); }
        else { f.Boolean(10, 1); f.Button(10, true); }
        logs.clear();
        if (scalar) f.Pressure(0, 10, vr::VRInputError_InvalidHandle);
        else f.provider.OnBooleanComponentUpdated(10, false, 0, vr::VRInputError_InvalidHandle);
        Check(f.provider.kalStates.empty() && f.provider.deriveFilterStates.empty(), "rejected release cannot arm rewind or latch");
        const auto& component = f.provider.inputComponents.at(10);
        Check(scalar ? component.scalarPressed && component.lastScalar == 1 && component.tunerScalar == 1 : component.haveValue && component.lastValue,
            "rejected release preserves last successful held/tuner state");
        Check(logs.empty(), "rejected physical-controller release does not log when diagnostics OFF");
        if (scalar) f.Pressure(0); else f.Button(10, false);
        Check(mode == 3 ? f.provider.deriveFilterStates[1].latchUntil > testNow : f.provider.kalStates[1].rewindUntil > testNow,
            "successful release after rejection still arms the selected effect");
    }
}

int main() {
    TestGripTransitions();
    TestGripLifecycle();
    TestGripHysteresis();
    TestReleaseEffects();
    TestRejectedRelease();
    TestSkeletonBypass();
    std::cout << "Controller toggle production callbacks: " << checks << " checks, " << failures << " failures\n";
    return failures ? 1 : 0;
}
