#include "../src/Driver/Hooking/ControllerPoseDispatch.h"
#include <cstring>
#include <initializer_list>
#include <iostream>
#include <string>

namespace {
int checks = 0;
int failures = 0;

void Check(bool condition, const std::string& description) {
    ++checks;
    if (!condition) {
        ++failures;
        std::cerr << "FAIL: " << description << '\n';
    }
}

vr::DriverPose_t HealthyPose() {
    vr::DriverPose_t pose;
    std::memset(&pose, 0, sizeof(pose));
    pose.deviceIsConnected = true;
    pose.poseIsValid = true;
    pose.result = vr::TrackingResult_Running_OK;
    pose.qRotation.w = 1.0;
    pose.qWorldFromDriverRotation.w = 1.0;
    pose.qDriverFromHeadRotation.w = 1.0;
    pose.poseTimeOffset = -0.012;
    pose.vecPosition[0] = 0.5;
    pose.vecVelocity[1] = 2.0;
    return pose;
}

struct FakeProvider {
    bool physical = true;
    bool accept = true;
    int classifications = 0;
    int handled = 0;
    uint32_t lastId = vr::k_unTrackedDeviceIndexInvalid;

    bool IsStreamedController(uint32_t id) {
        ++classifications;
        lastId = id;
        return physical;
    }

    bool HandleDevicePoseUpdated(uint32_t id, vr::DriverPose_t& pose) {
        ++handled;
        lastId = id;
        for (int axis = 0; axis < 3; ++axis) {
            pose.vecPosition[axis] = 10.0 + axis;
            pose.vecVelocity[axis] = 20.0 + axis;
            pose.vecAngularVelocity[axis] = 30.0 + axis;
            pose.vecAcceleration[axis] = 40.0 + axis;
            pose.vecAngularAcceleration[axis] = 50.0 + axis;
        }
        pose.qRotation = {0.5, 0.5, 0.5, 0.5};
        pose.poseTimeOffset = 0.025;
        // Simulate forceTracking/coasting: eligibility must use RAW flags.
        pose.poseIsValid = true;
        pose.result = vr::TrackingResult_Running_OK;
        pose.deviceIsConnected = true;
        return accept;
    }
};

struct Submission {
    const vr::DriverPose_t* source;
    int count = 0;
    bool originalReference = false;
    uint32_t size = 0;
    vr::DriverPose_t output{};

    void operator()(const vr::DriverPose_t& pose, uint32_t submittedSize) {
        ++count;
        originalReference = &pose == source;
        size = submittedSize;
        // Copy while the dispatcher-owned corrected pose is still alive.
        std::memcpy(&output, &pose, sizeof(output));
    }
};

void CheckCorrected(const Submission& submission, const std::string& label) {
    Check(submission.count == 1, label + ": exactly one submission");
    Check(!submission.originalReference, label + ": processed copy submitted");
    Check(submission.size == sizeof(vr::DriverPose_t), label + ": ABI size preserved");
    for (int axis = 0; axis < 3; ++axis) {
        Check(submission.output.vecPosition[axis] == 10.0 + axis, label + ": corrected position");
        Check(submission.output.vecVelocity[axis] == 20.0 + axis, label + ": corrected velocity");
        Check(submission.output.vecAngularVelocity[axis] == 30.0 + axis, label + ": corrected angular velocity");
        Check(submission.output.vecAcceleration[axis] == 40.0 + axis, label + ": corrected acceleration");
        Check(submission.output.vecAngularAcceleration[axis] == 50.0 + axis, label + ": corrected angular acceleration");
    }
    const auto& q = submission.output.qRotation;
    Check(q.w == 0.5 && q.x == 0.5 && q.y == 0.5 && q.z == 0.5, label + ": corrected rotation");
    Check(submission.output.poseTimeOffset == 0.025, label + ": corrected epoch");
}

void CheckPassthrough(vr::DriverPose_t source, uint32_t id, bool physical, const char* label) {
    vr::DriverPose_t before;
    std::memcpy(&before, &source, sizeof(before));
    FakeProvider provider;
    provider.physical = physical;
    Submission submission{&source};
    gxr::DispatchControllerPoseUpdate(provider, id, source, sizeof(source), submission);
    Check(submission.count == 1, std::string(label) + ": exactly one submission");
    Check(submission.originalReference, std::string(label) + ": caller-owned object retained");
    Check(submission.size == sizeof(source), std::string(label) + ": ABI size preserved");
    Check(std::memcmp(&submission.output, &before, sizeof(before)) == 0,
          std::string(label) + ": flags and all pose bytes preserved");
    Check(std::memcmp(&source, &before, sizeof(before)) == 0, std::string(label) + ": source immutable");
    Check(provider.handled == 1 && provider.lastId == id, std::string(label) + ": handler bookkeeping retained");
}
}

int main() {
    const uint32_t controllerId = 2;
    auto source = HealthyPose();
    vr::DriverPose_t before;
    std::memcpy(&before, &source, sizeof(before));
    FakeProvider provider;
    Submission submission{&source};
    gxr::DispatchControllerPoseUpdate(provider, controllerId, source, sizeof(source), submission);
    CheckCorrected(submission, "healthy physical controller");
    Check(provider.handled == 1 && provider.classifications == 1 && provider.lastId == controllerId,
          "healthy controller classified and handled exactly once");
    Check(std::memcmp(&source, &before, sizeof(before)) == 0, "correcting never writes caller pose");

    CheckPassthrough(HealthyPose(), controllerId, false, "native hand");
    CheckPassthrough(HealthyPose(), 3, false, "unknown or unresolved identity");
    CheckPassthrough(HealthyPose(), 4, false, "non-streamed controller");
    CheckPassthrough(HealthyPose(), vr::k_unTrackedDeviceIndex_Hmd, true, "HMD even if classifier accepts");
    auto loss = HealthyPose();
    loss.poseIsValid = false;
    CheckPassthrough(loss, controllerId, true, "invalid pose cannot be laundered by handler");
    auto disconnected = HealthyPose();
    disconnected.deviceIsConnected = false;
    CheckPassthrough(disconnected, controllerId, true, "disconnected pose cannot be laundered by handler");
    auto rotationOnly = HealthyPose();
    rotationOnly.result = vr::TrackingResult_Fallback_RotationOnly;
    CheckPassthrough(rotationOnly, controllerId, true, "rotation-only pose");
    auto calibrating = HealthyPose();
    calibrating.result = vr::TrackingResult_Calibrating_InProgress;
    CheckPassthrough(calibrating, controllerId, true, "calibrating pose");
    auto outOfRange = HealthyPose();
    outOfRange.result = vr::TrackingResult_Running_OutOfRange;
    CheckPassthrough(outOfRange, controllerId, true, "out-of-range pose");

    for (uint32_t size : {uint32_t(sizeof(source) - 1), uint32_t(sizeof(source) + 16)}) {
        FakeProvider incompatible;
        incompatible.accept = false; // ABI passthrough must not consult handler.
        Submission forwarded{&source};
        gxr::DispatchControllerPoseUpdate(incompatible, controllerId, source, size, forwarded);
        Check(forwarded.count == 1 && forwarded.originalReference && forwarded.size == size,
              "ABI mismatch forwards original object with original size");
        Check(incompatible.handled == 0 && incompatible.classifications == 0,
              "ABI mismatch never calls provider");
        Check(std::memcmp(&forwarded.output, &source, sizeof(source)) == 0, "ABI mismatch preserves bytes");
    }

    for (bool physical : {true, false}) {
        FakeProvider rejecting;
        rejecting.accept = false;
        rejecting.physical = physical;
        Submission suppressed{&source};
        gxr::DispatchControllerPoseUpdate(rejecting, controllerId, source, sizeof(source), suppressed);
        Check(rejecting.handled == 1 && suppressed.count == 0, "handler false suppresses either output route");
    }

    FakeProvider recovering;
    Submission lossSubmission{&loss};
    gxr::DispatchControllerPoseUpdate(recovering, controllerId, loss, sizeof(loss), lossSubmission);
    Check(recovering.handled == 1 && lossSubmission.originalReference, "loss updates state while forwarding caller object");
    Submission recoveredSubmission{&source};
    gxr::DispatchControllerPoseUpdate(recovering, controllerId, source, sizeof(source), recoveredSubmission);
    Check(recovering.handled == 2, "reacquisition continues existing provider state");
    CheckCorrected(recoveredSubmission, "loss to healthy transition");

    std::cout << "Controller pose dispatch: " << checks << " checks, " << failures << " failures\n";
    return failures == 0 ? 0 : 1;
}
