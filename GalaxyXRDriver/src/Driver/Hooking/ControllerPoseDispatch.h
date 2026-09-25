#pragma once

#include "openvr_driver.h"

namespace gxr {

// 2026-09-25: restore controller corrections without promoting a source
// tracking-loss/disconnect sample back to Running_OK during a hand takeover.
// Both host ABI versions use the same publication policy. Submit consumes
// the pose synchronously.
template<class Provider, class Submit>
void DispatchControllerPoseUpdate(Provider& provider, uint32_t deviceId,
    const vr::DriverPose_t& source, uint32_t poseSize, Submit&& submit)
{
    if (poseSize != sizeof(vr::DriverPose_t)) {
        submit(source, poseSize);
        return;
    }

    // Decide from the SOURCE: forceTracking and Kalman loss coasting can
    // change validity/result on the processed copy. Unknown devices and
    // native hands must retain the caller's original object and all fields.
    const bool publishCorrections = deviceId != vr::k_unTrackedDeviceIndex_Hmd
        && source.deviceIsConnected && source.poseIsValid
        && source.result == vr::TrackingResult_Running_OK
        && provider.IsStreamedController(deviceId);

    auto corrected = source;
    // Keep loss/reacquisition bookkeeping alive even when publishing raw.
    if (provider.HandleDevicePoseUpdated(deviceId, corrected)) {
        submit(publishCorrections ? corrected : source, poseSize);
    }
}

} // namespace gxr
