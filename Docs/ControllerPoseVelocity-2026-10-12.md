# Controller layout velocity transport

The direct Galaxy XR controller path changed position/orientation for grip,
shared offsets and per-hand trims while retaining the original velocity vectors.
The capture on 2026-10-12 at 03:29:41 confirmed a constant 16.6 mm translation
and 10.56 degree local rotation. These were the configured GameLink offsets,
not the optional 5 cm / 22 degree grip convention.

`ControllerPoseVelocity.h` now transports the source rigid motion after all
layout edits, before diagnostics and the downstream estimator section:

```
omega_driver = rotate(q_source, omega_source_local)
v_adjusted = v_source + cross(omega_driver, p_adjusted - p_source)
omega_adjusted_local = inverse_rotate(q_adjusted, omega_driver)
```

This preserves the edited position/orientation, time, transforms and flags.
It runs only for recognized physical streamed controllers in the Galaxy XR
build, Controller Fix Off, Disable All Controller Features off (formerly
Controller Bypass) and Space Velocity Fix off.
Raw source tracking must be connected, valid and Running_OK, even if Force
Tracking later overrides those flags. Native hands return before this code.
Other estimator modes and the neutral vendor build retain their old behavior.

The verified direct protocol supplies zero acceleration channels. Nonzero or
nonfinite acceleration, changed input derivatives, invalid/nonunit quaternions
and nonfinite values skip transport; no new acceleration model is invented.
All output components are validated before either vector is written.

Validation: `tools/Test-ControllerPoseVelocity.ps1` compiles the actual production
layout section, not a copied offset implementation, for Galaxy XR and neutral.
It covers composed grip/shared/per-hand/aligner offsets, mirrored hands, native
hands, unrelated devices, source loss masked by Force Tracking and estimator
ownership. Independent central differences of a moving rigid body validate both
point velocity and orientation derivatives, including the driver-to-head lever.

Replay of all 21,612 input/output controller pairs in the latest recording passed;
maximum numerical rigid derivative error was 3.812e-10. Galaxy XR checks: 65,087;
neutral checks: 251; zero failures. Existing epoch (555 + 14 + 14) and dispatch
(120) checks also passed. Driver-only MSVC build passed, including exports and
dependency checks. No full GUI/CI build is claimed.

This is a separate correctness fix, not evidence that acceleration/braking
stutter is solved. The earlier offline counterfactual did not reduce the ordinary
backstep count. Fresh-pose timestamp jitter and HAL p/v continuity remain separate
questions. The same-payload epoch fix and its 50 ms freeze limitation are retained.
Native object throwing is still unvalidated.

Published source version: `1.7.2`. Workspace installation/rollback receipts live in
`diagnostics/controller-layout-fix-20261012/`. `Install-PcLayoutFix.ps1 -Restore`
restores the preceding `1.7.2-epoch.1` DLL/manifest with SteamVR closed. A PC reboot
does not roll back this installed driver. No headset module or settings changes
are needed for this fix. A new live motion comparison is still required.

Scope clarification: the Galaxy XR vendor build uses the existing physical
VRLink controller classifier, which also matches Quest controllers. This is
not a headset identity check; a Quest reference capture confirmed that this
path processes those controllers too. No new device-classification change
is included here.
