// Production provider timing methods, extracted without graphics/OpenVR services.
#include "Config/Config.h"
#include "Driver/Hooking/ControllerPoseEpoch.h"
#include <array>
#include <mutex>
#include <iostream>

Config driverConfig;
double testClock = 100.0004;
double TestPoseClock() { return testClock; }
class GalaxyXRDeviceProvider {
public:
    std::array<gxr::ControllerPoseEpoch, vr::k_unMaxTrackedDeviceCount> controllerPoseEpochs{};
    std::mutex controllerPoseEpochLock;
    void ResetControllerPoseEpoch(uint32_t);
    void CorrectControllerPoseEpoch(uint32_t, const vr::DriverPose_t&, vr::DriverPose_t&, double, bool);
};
#include "EpochMethods.generated.h"

int main() {
    int failures = 0, checks = 0;
    auto check = [&](bool ok) { ++checks; if (!ok) { ++failures; std::cerr << "FAIL integration check " << checks << '\n'; } };
    GalaxyXRDeviceProvider provider;
    vr::DriverPose_t source{};
    source.qRotation.w = source.qWorldFromDriverRotation.w = source.qDriverFromHeadRotation.w = 1;
    source.poseIsValid = source.deviceIsConnected = true;
    source.result = vr::TrackingResult_Running_OK;
    source.poseTimeOffset = .015;
    source.vecVelocity[0] = 1;
    driverConfig.galaxyXr.controllerBypass = false;
    driverConfig.streamFrame.velocityFixMode = 0;
    auto processed = source; processed.vecPosition[0] = 42;
    provider.CorrectControllerPoseEpoch(1, source, processed, 100, true);
    check(processed.vecPosition[0] == 42);
#ifdef VENDOR_GALAXYXR
    check(std::abs(processed.poseTimeOffset - .0146) < 1e-9);
#else
    check(processed.poseTimeOffset == .015);
#endif
    testClock = 100.0034;
    processed = source;
    provider.CorrectControllerPoseEpoch(1, source, processed, 100.003, true);
#ifdef VENDOR_GALAXYXR
    check(std::abs(processed.poseTimeOffset - .0116) < 1e-9);
#else
    check(processed.poseTimeOffset == .015);
#endif
    for (int mode : {1, 2, 3, 4, 5}) {
        driverConfig.streamFrame.velocityFixMode = mode;
        processed = source; processed.poseTimeOffset = .044;
        provider.CorrectControllerPoseEpoch(1, source, processed, 100.004, true);
        check(processed.poseTimeOffset == .044); // estimator owns its epoch
    }
    driverConfig.streamFrame.velocityFixMode = 0;
    for (int bypass = 0; bypass < 2; ++bypass) {
        driverConfig.galaxyXr.controllerBypass = bypass == 1;
        processed = source; processed.poseTimeOffset = .044;
        provider.CorrectControllerPoseEpoch(1, source, processed, 100.004, bypass == 1);
        check(processed.poseTimeOffset == .044); // publication OFF or bypass ON
    }
    driverConfig.galaxyXr.controllerBypass = false;
    testClock = 100.0104; processed = source;
    provider.CorrectControllerPoseEpoch(1, source, processed, 100.01, true);
#ifdef VENDOR_GALAXYXR
    check(std::abs(processed.poseTimeOffset - .0146) < 1e-9); // prior bypass cleared history
#else
    check(processed.poseTimeOffset == .015);
#endif
    provider.ResetControllerPoseEpoch(1);
    testClock = 100.0204; processed = source;
    provider.CorrectControllerPoseEpoch(1, source, processed, 100.02, true);
#ifdef VENDOR_GALAXYXR
    check(std::abs(processed.poseTimeOffset - .0146) < 1e-9);
#else
    check(processed.poseTimeOffset == .015);
#endif
    processed = source;
    provider.ResetControllerPoseEpoch(vr::k_unTrackedDeviceIndexInvalid);
    provider.CorrectControllerPoseEpoch(vr::k_unTrackedDeviceIndexInvalid, source, processed, 100, true);
    check(processed.poseTimeOffset == .015);
    check(source.poseTimeOffset == .015 && source.vecPosition[0] == 0);
    std::cout << "Production epoch integration: " << checks << " checks, " << failures << " failures\n";
    return failures ? 1 : 0;
}
