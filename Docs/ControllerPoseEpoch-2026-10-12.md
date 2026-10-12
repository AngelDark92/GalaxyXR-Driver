# Controller duplicate timing correction, 2026-10-12

Steam Link 2.0.20 sends identical moving controller payloads repeatedly with newer
packet times. The PC vrlink driver uses those times in `DriverPose_t::poseTimeOffset`.
SteamVR then shortens prediction from the unchanged pose, producing backwards API
steps. The Galaxy XR shim previously preserved that timing unchanged.

The correction preserves the first observed epoch for consecutive equal payloads
in Controller Fix Off. It compares every numeric field except time, plus tracking
and transform flags, before grip/layout processing. Only the final output offset
changes, including compensation for time spent inside the callback. No sample or
tracking-state update is dropped; no smoothing or velocity substitution is added.

Eligibility requires the Galaxy XR vendor build, a recognized physical controller,
healthy source tracking, direct mode and Controller Bypass OFF. Loss, malformed
timestamps, nonfinite fields, clock discontinuity and callback gaps reset history.
The history is per device and guarded by a leaf mutex. ABI mismatch clears that
device's history without interpreting the pose. Provider cleanup clears all history.

Without a source sequence number, a fresh identical moving sample cannot be
distinguished from a retransmit. Samples with zero velocities and accelerations
pass through immediately. Exact moving repeats can hold an epoch for at most
50 ms; expired runs pass through until changed data. This can still leave a jump
at prolonged freeze/recovery, and does not fix network jitter or recover the actual
OpenXR target time. Existing estimator modes keep ownership of their own epochs.

Validation evidence is in the workspace's
`diagnostics/controller-epoch-fix-20261012/`. Production C++ replay of the complete
30-second capture found 2,685 fresh poses and 8,119 repeats per hand. Every repeat
kept its epoch exactly; no non-time field changed and no run expired. Maximum
correction was 23.333 ms. A uniform-motion 90/360/225 Hz oracle reduced backwards
steps from 90 to zero. Unit checks cover state/transform/derivative changes,
stationary samples, finite values, independent hands, gaps, expiry and reset.
Production provider-method tests cover both Galaxy XR and neutral builds, bypass,
estimator ownership and callback-time rebasing; dispatch tests retain raw reference
identity for native hands, other devices and source loss.

A first-order counterfactual using the recorded SteamVR API positions/velocities
reduces backwards steps above 0.1 mm at speed above 0.2 m/s from 1,410 to 28 on the
left and 1,393 to 29 on the right, restricted to mapped sample pairs. This is an
offline model, not a new live capture or a rendered/subjective success claim.
Internal SteamVR sample selection and higher-order angular prediction remain
unobserved.

The subsequent 03:29:41 live capture and user feedback confirmed improvement,
with residual stutter concentrated at acceleration/braking. API backsteps fell
from 1,419/1,402 to 49/46; these were different human motion sequences, not an
identical-motion controlled comparison. A single 71 ms stale run exposed the
50 ms fallback's own jump. First-observed timing of fresh states still differs
from matched HAL target intervals by several milliseconds. Neither limitation
is changed by the separate [layout velocity fix](ControllerPoseVelocity-2026-10-12.md).
Native object throwing has not been validated.

Scope clarification: the Galaxy XR vendor build uses the existing physical
VRLink controller classifier, which also matches Quest controllers. This is
not a headset identity check; a Quest reference capture confirmed that this
path processes those controllers too. No new device-classification change
is included here.
