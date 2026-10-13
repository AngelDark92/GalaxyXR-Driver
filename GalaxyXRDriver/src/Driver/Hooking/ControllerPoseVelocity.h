#pragma once

#include "openvr_driver.h"
#include <cmath>

namespace gxr {

// 2026-10-12: captured SteamVR output confirms world/driver-space linear
// velocity and controller-local angular velocity for the direct vrlink path.
// A layout translation changes the tracked point; a local rotation changes
// the axes in which angular velocity is expressed. Preserve the rigid motion
// while retaining the user's p/q offsets. Estimators own their derivatives.
inline bool TransportControllerLayoutVelocity(const vr::DriverPose_t& source,
    vr::DriverPose_t& adjusted, bool physicalController, int velocityFixMode,
    bool controllerBypass, int spaceVelocityFixMode)
{
#ifndef VENDOR_GALAXYXR
    (void)source; (void)adjusted; (void)physicalController;
    (void)velocityFixMode; (void)controllerBypass; (void)spaceVelocityFixMode;
    return false;
#else
    if (!physicalController || velocityFixMode != 0 || controllerBypass
        || spaceVelocityFixMode != 0 || !source.poseIsValid
        || !source.deviceIsConnected || source.result != vr::TrackingResult_Running_OK)
        return false;

    // The measured direct protocol has no acceleration channel (all zero).
    // Do not invent centripetal acceleration or silently alter an unverified
    // nonzero-acceleration/frame contract. Commit both output vectors only
    // after validation; source fields and pose timing stay untouched.
    for (int i = 0; i < 3; ++i) {
        if (source.vecAcceleration[i] != 0 || source.vecAngularAcceleration[i] != 0
            || adjusted.vecAcceleration[i] != 0 || adjusted.vecAngularAcceleration[i] != 0
            || source.vecVelocity[i] != adjusted.vecVelocity[i]
            || source.vecAngularVelocity[i] != adjusted.vecAngularVelocity[i]
            || !std::isfinite(source.vecVelocity[i])
            || !std::isfinite(source.vecAngularVelocity[i])
            || !std::isfinite(source.vecPosition[i])
            || !std::isfinite(adjusted.vecPosition[i])) return false;
    }
    auto unit = [](vr::HmdQuaternion_t& q) {
        const double n2 = q.w*q.w + q.x*q.x + q.y*q.y + q.z*q.z;
        if (!std::isfinite(n2) || n2 < .999 || n2 > 1.001) return false;
        const double n = std::sqrt(n2);
        q.w /= n; q.x /= n; q.y /= n; q.z /= n;
        return true;
    };
    auto before = source.qRotation, after = adjusted.qRotation;
    if (!unit(before) || !unit(after)) return false;
    auto rotate = [](const vr::HmdQuaternion_t& q, const double* v, double* out) {
        const double t[3] = {2*(q.y*v[2]-q.z*v[1]),
            2*(q.z*v[0]-q.x*v[2]), 2*(q.x*v[1]-q.y*v[0])};
        out[0] = v[0] + q.w*t[0] + q.y*t[2] - q.z*t[1];
        out[1] = v[1] + q.w*t[1] + q.z*t[0] - q.x*t[2];
        out[2] = v[2] + q.w*t[2] + q.x*t[1] - q.y*t[0];
    };
    const bool samePosition = source.vecPosition[0] == adjusted.vecPosition[0]
        && source.vecPosition[1] == adjusted.vecPosition[1]
        && source.vecPosition[2] == adjusted.vecPosition[2];
    const bool sameRotation = (before.w == after.w && before.x == after.x
        && before.y == after.y && before.z == after.z)
        || (before.w == -after.w && before.x == -after.x
        && before.y == -after.y && before.z == -after.z);
    if (samePosition && sameRotation) return false;

    double worldAngular[3], localAngular[3], velocity[3];
    rotate(before, source.vecAngularVelocity, worldAngular);
    after.x = -after.x; after.y = -after.y; after.z = -after.z;
    rotate(after, worldAngular, localAngular);
    double delta[3];
    for (int i = 0; i < 3; ++i) delta[i] = adjusted.vecPosition[i] - source.vecPosition[i];
    velocity[0] = source.vecVelocity[0] + worldAngular[1]*delta[2] - worldAngular[2]*delta[1];
    velocity[1] = source.vecVelocity[1] + worldAngular[2]*delta[0] - worldAngular[0]*delta[2];
    velocity[2] = source.vecVelocity[2] + worldAngular[0]*delta[1] - worldAngular[1]*delta[0];
    for (int i = 0; i < 3; ++i)
        if (!std::isfinite(velocity[i]) || !std::isfinite(localAngular[i])) return false;
    for (int i = 0; i < 3; ++i) {
        // Exact no-change channels preserve their original bits.
        if (!samePosition) adjusted.vecVelocity[i] = velocity[i];
        if (!sameRotation) adjusted.vecAngularVelocity[i] = localAngular[i];
    }
    return true;
#endif
}

} // namespace gxr
