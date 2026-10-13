#pragma once

#include "openvr_driver.h"
#include <array>
#include <chrono>
#include <cmath>

namespace gxr {

inline double PoseCallbackTime() {
    return std::chrono::duration<double>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
}

// 2026-10-12: Steam Link 2.0.20 repeats ~90 Hz controller payloads at ~360 Hz,
// while vrlink stamps each repeat with the newer packet time. Advancing the
// epoch of an unchanged moving pose resets SteamVR prediction backwards.
// Preserve the FIRST observed epoch of exact repeats; this is not a recovered
// sensor timestamp. Without a source sequence ID, identical fresh samples are
// indistinguishable. Stationary samples bypass this and a run is bounded to
// 50 ms, after which upstream timing passes through until the payload changes.
// Caller owns synchronization and decides device/config eligibility.
class ControllerPoseEpoch {
public:
    enum class Result { Passthrough, Fresh, Repeat, Expired };
    static constexpr double MaxRepeatSeconds = 0.050;

    void Reset() { have_ = false; expired_ = false; }

    Result Apply(vr::DriverPose_t& pose, double receipt, bool eligible) {
        const auto values = Values(pose);
        bool finite = std::isfinite(receipt) && std::isfinite(pose.poseTimeOffset)
            && std::abs(pose.poseTimeOffset) <= 0.1;
        for (double value : values) finite = finite && std::isfinite(value);
        bool moving = false;
        for (int i = 0; i < 3; ++i) {
            moving = moving || pose.vecVelocity[i] != 0 || pose.vecAngularVelocity[i] != 0
                || pose.vecAcceleration[i] != 0 || pose.vecAngularAcceleration[i] != 0;
        }
        if (!eligible || !finite || !moving || !pose.poseIsValid || !pose.deviceIsConnected
            || pose.result != vr::TrackingResult_Running_OK) {
            Reset();
            return Result::Passthrough;
        }
        const double epoch = receipt + pose.poseTimeOffset;
        const std::array<bool, 4> flags{pose.poseIsValid, pose.deviceIsConnected,
            pose.willDriftInYaw, pose.shouldApplyHeadModel};
        // A new transform/derivative/status is a new sample even if p/q stayed
        // still. Loss, callback gaps and clock discontinuities forget history.
        if (!have_ || values != values_ || flags != flags_
            || receipt < lastReceipt_ || receipt - lastReceipt_ > MaxRepeatSeconds
            || epoch < lastEpoch_ - 0.0001
            || std::abs((epoch - lastEpoch_) - (receipt - lastReceipt_)) > MaxRepeatSeconds) {
            values_ = values;
            flags_ = flags;
            firstReceipt_ = receipt;
            firstEpoch_ = epoch;
            lastReceipt_ = receipt;
            lastEpoch_ = epoch;
            have_ = true;
            expired_ = false;
            return Result::Fresh;
        }
        lastReceipt_ = receipt;
        lastEpoch_ = epoch;
        if (expired_ || receipt - firstReceipt_ > MaxRepeatSeconds
            || epoch - firstEpoch_ > MaxRepeatSeconds) {
            // Do not re-arm on every timeout: a permanently frozen moving
            // payload must not cycle through repeated prediction ramps.
            expired_ = true;
            return Result::Expired;
        }
        pose.poseTimeOffset = firstEpoch_ - receipt;
        return Result::Repeat;
    }

private:
    // Explicit fields avoid ABI padding and do not use position epsilon tests.
    static std::array<double, 33> Values(const vr::DriverPose_t& p) {
        return {p.qWorldFromDriverRotation.w, p.qWorldFromDriverRotation.x,
            p.qWorldFromDriverRotation.y, p.qWorldFromDriverRotation.z,
            p.vecWorldFromDriverTranslation[0], p.vecWorldFromDriverTranslation[1], p.vecWorldFromDriverTranslation[2],
            p.qDriverFromHeadRotation.w, p.qDriverFromHeadRotation.x,
            p.qDriverFromHeadRotation.y, p.qDriverFromHeadRotation.z,
            p.vecDriverFromHeadTranslation[0], p.vecDriverFromHeadTranslation[1], p.vecDriverFromHeadTranslation[2],
            p.vecPosition[0], p.vecPosition[1], p.vecPosition[2],
            p.vecVelocity[0], p.vecVelocity[1], p.vecVelocity[2],
            p.vecAcceleration[0], p.vecAcceleration[1], p.vecAcceleration[2],
            p.qRotation.w, p.qRotation.x, p.qRotation.y, p.qRotation.z,
            p.vecAngularVelocity[0], p.vecAngularVelocity[1], p.vecAngularVelocity[2],
            p.vecAngularAcceleration[0], p.vecAngularAcceleration[1], p.vecAngularAcceleration[2]};
    }
    std::array<double, 33> values_{};
    std::array<bool, 4> flags_{};
    double firstReceipt_ = 0, firstEpoch_ = 0, lastReceipt_ = 0, lastEpoch_ = 0;
    bool have_ = false, expired_ = false;
};

} // namespace gxr
