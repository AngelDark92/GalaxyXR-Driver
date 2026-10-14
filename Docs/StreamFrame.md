# Galaxy XR Driver: Setup and Image Processing

A standalone SteamVR vendor driver for the Samsung Galaxy XR over Steam Link / vrlink. It does three things:

- **Identity.** The headset and controllers show up in SteamVR as what they are: Galaxy XR model name, icons, official controller models and bindings.
- **Controllers.** Corrected grip origin and pose components, plus Kalman filtering for controller motion during valid tracking.
- **Image processing.** Color, sharpening, anti-aliasing and distortion correction applied to the streamed frames right before the driver encodes them.

Image processing settings apply live within about a second. Identity, input profile, resolution and quality need a SteamVR restart.

Advanced layout (2026-10-01): **App Settings --> Application preferences --> Advanced Mode** reveals labeled inline groups beneath the settings they extend, including Kalman Advanced Settings. Advanced groups do not collapse. Settings pages contain at most two nested collapsible containers.

**App Settings --> Application preferences --> Debug Mode** enables the separate Debug tab after driver installation, independently of Advanced Mode. It defaults off and is stored in the driver settings. Debug groups use non-collapsible **Image Processing**, **Controllers**, and **Encoder** labels, each with a collapsible Diagnostics container. Turning Debug Mode off hides the tab and stops its ramp bar, gaze ring, hitch diagnostics, pose logs/bursts, encoder debug overlay, and verbose encoder logging. Individual diagnostic selections are kept for the next time it is enabled. Black-point correction, HEVC level compatibility, headroom, frame rate and bitrate tuning remain active. The vrlink Debug Overlay request requires a SteamVR restart and reconnect; Debug Mode OFF also overrides expert overlay keys. Distortion calibration tools and retired experiments remain in their existing tabs.

Saved settings and their defaults apply on the first driver start after installation; no toggle cycle is needed. Missing JSON keys use the driver's defaults. Encoder options are published before the first encoder is created, and explicit advanced VRLink overrides are reapplied after profile, stream and resolution settings. Opening a GUI page preserves saved tuning, including values that fall between slider steps. Image processing still follows the Image Enhancements master and SDR10 consent rules below.

Encoder restore (2026-09-30): **Image Settings --> Encoder --> Restore Steam Link encoder behaviour** saves NVENC Tap OFF while retaining every custom tuning value. Close SteamVR completely before restoring; the next driver process starts without installing the NVENC hook. The action backs up `settings.json` and changes only `streamFrame.nvencTap`. Stream quality, bandwidth, resolution, 10-bit requests, image settings, profiles, app preferences and the SteamVR ownership journal are kept. It restores Steam Link's NVIDIA API requests for your selected stream configuration, rather than a factory streaming profile. The Companion can be closed after saving.

OFF skips encoder overrides, preset/capability probes, QP maps and post-pack pixel processing. An already-hooked process can retain applied parameters; an already-upgraded encoder needs its API adapter until destroyed. The page distinguishes **OFF saved**, **restart required**, and **OFF confirmed** using the current process ID, driver version, diagnostic heartbeat, registered DLL path and configuration path. Old or incomplete runtime output cannot confirm OFF. **Restore defaults** still restores the Companion's fresh-install settings, including Tap ON. Stored tuning becomes active again if Tap is enabled and SteamVR restarted.

For an OFF comparison, keep the same stream settings and scene, record the loaded DLL path/version/SHA-256, save Tap OFF, close SteamVR completely, and collect new `vrserver.txt`, `driver_vrlink.txt`, `info.json` and `diagnostic.json` from the next process. Require the fresh runtime to report Tap disabled and no installed hook. Production-shim tests prove parameter pass-through; they do not prove headset picture quality or latency.

Setup encoder lifecycle (2026-09-26): first installation and installation after a completed uninstall use the reference NVENC defaults: Tap, automatic HEVC level, CBR, bitrate scaling and preset merge on; preset Auto, two-frame VBV, keyframe scale 2, 90 fps budgeting and automatic split. Native identity starts on. Direct upgrades preserve saved choices, including native identity off and custom encoder values. Hitch diagnostics remain off and the SDR 10-bit baseline keeps its current opt-in behavior. Encoder toggles and reset arrows use this package's defaults even when an older `info.json` remains. A file read started before a newer save cannot replace that edit with stale settings.

Stream codec (2026-10-13): the Stream Frame Encoder group offers a **Stream codec** setting. **HEVC (default)** keeps Steam Link's own encoder behaviour; **H.264** and **AV1 (experimental)** are applied through the NVENC Tap override. H.264 steers vrlink into its 8-bit pipeline (NVENC cannot encode 10-bit H.264 input); AV1 keeps vrlink's 10-bit-capable path. Non-HEVC streams need the Steam Link client Codecs Support patch on the headset to decode, and the change requires a SteamVR restart.

In **Setup → Restore or remove**, both actions require SteamVR to be confirmed stopped, including its monitor and compositor processes:

- **Restore defaults** resets all driver tuning and app preferences, including appearance, Advanced Mode, and setup verification. Native Identity and NVENC Tap return to their defaults. The reset clears stale telemetry and migration state, restores unchanged journal-owned SteamVR tuning, and makes a recovery backup. The installed driver, registration, saved profiles, and backups stay in place. Start SteamVR afterwards to apply the driver defaults.
- **Uninstall driver** opens a warning with a red confirmation button. It unregisters and removes owned driver packages, clears active driver and app data, and restores recorded SteamVR values or removes app-added keys. Saved distortion profiles, recovery backups, downloaded source packages, unrelated drivers, and later external edits are preserved. Verified historical identity leftovers may be removed; original values that were never recorded cannot be reconstructed. A completed uninstall lets the next installation, including the same version, start with fresh defaults without automatically selecting a saved profile.

An incomplete operation keeps recovery information and shows the remaining work in **Details**. Resolve the reported issue and retry uninstall; its button remains available even when the driver is no longer detected. Opening Companion after uninstall does not recreate active settings. Direct upgrades continue to preserve saved choices. These operations do not edit NVIDIA Control Panel settings. See [maintenance behavior and validation](CompanionMaintenance-2026-09-26.md).

**Check settings** reads saved configuration and displays each control as **Tab → Container → Setting**, with its value source and a **Show setting** link. Links can reveal advanced controls temporarily without changing Advanced Mode or enabling a prerequisite. Raw file names and keys remain in **Technical details**. The check does not verify the live picture or controller behavior.

Toggle corrections (2026-09-25):

- Grip Touch From Grip Pressure OFF releases any synthesized touch and stops further synthesis. Controller Bypass also stops synthesis and skeleton offsets. Re-enabling synthesis works with an already connected controller.
- NVENC Tap OFF stops API upgrades for new encoder sessions. Existing upgraded sessions keep the API compatibility handling they need until closed; reconnect to start a stock session.
- Zero-Copy v3 OFF, Image Enhancements OFF, or inactive eye processing stops texture redirection. Re-enabling waits for active eye processing.
- vrlink Debug Overlay OFF writes both diagnostic flags false, even if they were previously true. Explicit advanced VRLink overrides remain authoritative; uninstall restores unchanged journal-owned values.
- Pose Logging OFF silences pose diagnostics without disabling release latch or release rewind.
- Hitch Diagnostics defaults to OFF (2026-09-26). OFF skips its timing samples, counters, event tags and logs. Enabling it starts a fresh measurement window; explicit saved choices remain supported.
- Legacy encoder imports preserve explicit OFF choices for encoder switches, the headset profile, and CAS. Completed migrations are not repeated; settings already overwritten by an older version cannot be reconstructed automatically.

## Install

1. Unpack the entire release zip. The GUI folder and the `GalaxyXRNative` folder must stay next to each other.
2. Run `Galaxy XR Companion.exe`, open **Setup**, and press **Install Driver**.
3. Older copies of this fork are removed automatically on the first install. If the stock CustomHeadsetOpenVR driver is also enabled, the GUI shows a notice and a "Switch to this driver" button, press it, two drivers must not claim the headset at once.
4. Use **Start SteamVR** on Setup and connect through Steam Link. Wait for driver initialization to be verified, then check the picture and controller tracking in the headset.

Settings live in `%APPDATA%\GalaxyXR\CustomHeadset\settings.json`, separate from the stock driver's `%APPDATA%\CustomHeadset\` so the two never share state.

## Recommended configuration

Galaxy XR page:

- **Headset**: Native Identity on, Native Render Resolution on (default), Stream Quality Preset: High.
- **Controllers**: Official Controller Input Profile on. Controller Fix Mode: Kalman CA (default). Leave the offsets alone unless the controllers visibly sit wrong in your hand, the shipped values were measured against the official models.
- **Image Processing**: Enable on.

Device pages: leave **Custom Shader disabled**. The Galaxy XR image processing replaces it for streamed HMDs, the page warns if both are active with color adjustments.

After changing anything in the Headset section or the input profile, restart SteamVR.

The [NVENC quality review (2026-09-26)](NvencQuality-2026-09-26.md) explains the retained encoder defaults, online sources, and quality features worth testing next. No universal maximum-quality preset is proven for every GPU and headset stream.

## Controllers

Direct controller timing correction (2026-10-12): in the Galaxy XR build with
Controller Fix Mode **Off**, exact repeated moving poses retain the epoch of the
first received copy. Steam Link 2.0.20 was observed sending approximately 90 Hz
pose payloads at 360 Hz with advancing packet timestamps; re-stamping these
copies resets SteamVR prediction backwards. Only `poseTimeOffset` changes;
positions, rotations, velocities, accelerations and tracking flags are preserved.
All other fields participate in freshness detection, and stationary samples with
zero derivatives pass through. A repeat run is limited to 50 ms; a longer freeze
uses upstream timing until data changes. This preserves the first observed time,
not the unavailable original sensor timestamp. Native hands, HMD, invalid tracking,
other devices, the neutral build and estimator modes bypass this correction.
**Controller Bypass** disables it. See [validation and limits](ControllerPoseEpoch-2026-10-12.md).

With the official input profile on, SteamVR sees `galaxy_xr_controller`. Games that ship a native Galaxy XR binding use it, everything else falls back to Index controller bindings through the official remapping, so most titles will show Index controllers in their binding UI. Custom per-game bindings made before enabling the profile (when the controllers were Touch) do not carry over.

Controller Fix Mode drives the pose filter. Kalman CA is the default, the tuning row below it shows the gains for whichever mode is selected, and Kalman Advanced Settings holds the rarely-touched knobs. Since 1.0.0 the reported angular velocity is in controller-local frame, which is what SteamVR's own prediction expects.

Game Link Layout has its own section under Controllers, next to Controller Fix: the switch and the layout's offsets. It presents the controllers the way Samsung's own PC driver (Game Link / XR Link) does: Steam Link's raw pose with no grip convention shift, Samsung's model at its authored size, Samsung's pose points (grip, aim, tip, base) as authored, and Samsung's input profile with the `samsung_touch` controller type, whose remapping tells Touch-authored games they talk to a Touch. It is an add-on to the selected Controller Fix Mode: the motion stays the mode's. With the mode Off the pose, velocities and accelerations go out as Steam Link delivers them; Samsung's driver zeroes small velocities and all accelerations, this one does not. Steam Link's own velocities sent that way made Half-Life: Alyx throws fly sideways, Kalman CA threw straight. Turning it on or off needs a SteamVR restart.

While it is on, the Grip Convention, the Controller Offsets and per-hand trims, the model scale, the mesh offset, the hand anchor and the aim trim are not applied; they come back when it goes off. The layout has its own offsets instead, in the same section (`controllers.gameLinkLayout` in settings.json): authored for the left controller and mirrored for the right, rotation 2 / -5 / -9 deg and position 0.5 / -1.5 / 0.5 cm by default. With Controller Bypass also on, the controllers get Samsung's identity, model, pose points and input profile on the untouched Steam Link pose, without this driver's other corrections.

Settings files from the builds where the layout was a mode are read as before: `kalmanCAGameLink` and `native` are Kalman CA with the switch on, `nativeGameLink` is Off with the switch on. `velocityOnly`, the removed Kalman CA (Velocity only) mode, is read as Kalman CA.

Controller pose publication (2026-09-25): corrected pose, velocity and offsets reach SteamVR while a physical Galaxy XR controller is connected and reports valid `Running_OK` tracking. Native hands, unrecognized devices, and invalid/disconnected controller samples retain the original Steam Link pose and tracking flags. The estimator still processes loss/reacquisition internally, but loss-coast output and `forceTracking` status promotion are not published on those samples. This preserves the preceding hand-compatibility patch's loss behavior while restoring corrections during valid tracking; it does not restore synthetic tracking through a dropout.

The earlier hand-compatibility patch calculated Kalman corrections but discarded them, so a `CA FULL active` log alone did not prove the game received them. After installing a build with restored publication, check throwing with both controllers, switch physical controllers to native hands and back, and reconnect the stream. Verify role assignment and bindings as well as throws. The previous patch recorded hand-role failures even with controller-only corrected poses; preserving source loss flags narrows that risk but requires this live check.

Controller Offsets (under Controllers Advanced) are authored for the left hand and mirrored to the right by default. Per-hand trims appear when Mirror is off and are added on top of the shared offsets.

## Image processing notes

- **Saturation / Contrast / Gamma**: same semantics as the original shader (50 and 2.2 are neutral).
- **Vibrance**: smart saturation, changes muted colors most and vivid colors least. Stacks with Saturation.
- **FXAA**: anti-aliasing before the encode.
- **CAS Sharpening**: with Image Enhancements enabled, Post-pack sharpens the packed frame on NVIDIA with the NVENC Tap on, even when color and distortion controls are neutral. Its fovea/periphery strengths and Off selection apply live; turning Image Enhancements off also stops it. Pre-encode provides per-eye strength for AMD or when the tap is off. Use one sharpening mode at a time.
- **Dither**: helps banding in dark gradients. The encoder eats some of it, but low amplitude noise before quantization still helps.
- **Stationary Dimming**: dims the image when the headset is not moving for a while.
- **Color Matrix**: advanced gamut/white point correction. Empty = off.

## SDR 10-bit baseline

An experimental opt-in on the Driver Settings page (Headset section), off by default. It asks the stream for 10-bit HEVC and runs the host color pipeline neutral, so the driver adds no color of its own while the 10-bit path is measured. It is a request, not a guarantee: the device decides what it actually negotiates.

When enabled, the driver:

- **Requests the profile (restart or reconnect).** At SteamVR start and when the headset attaches it writes the vrlink profile for the connected model with `supports10bit` on, through the model-aware writer and settings journal. The retired `force10bit` stays off. A running stream is not renegotiated, so restart SteamVR or reconnect the headset.
- **Runs the host color neutral (live, unless you opt into enhancements).** Saturation 50, vibrance 0, contrast 50 (midpoint 50, non-linear), gamma 2.2, brightness 1.0, tint 1, color matrix off, dither off, black-floor fix off. Enabling the baseline in the GUI resets picture adjustments after confirmation and turns Image Enhancements off.
- **Bypasses post-pack and VUI overrides.** No host range remap or post-pack sharpening; the NVENC VUI overrides stay at "leave" (-1), so Valve's original pixel/metadata pair reaches the encoder unchanged. That keeps pixels and metadata consistent; it is not proof the stock pair is correct.

Image Enhancements is off by default with the baseline, bypassing picture processing, including FXAA, CAS and distortion correction. Stream quality, bitrate, encoder presets, tracking and controller tuning are preserved.

**Optional enhancements with 10-bit.** In App Settings, turn on **Image Enhancements** and accept **I understand — enable enhancements** in the warning popup. Combining these modes can reduce image quality, introduce banding or artifacts, and change colors; the result is no longer a neutral baseline. Acceptance enables editing and applying the picture controls while keeping the 10-bit stream request. It does not guarantee 10-bit processing precision. Cancel leaves settings unchanged. Turn Image Enhancements off to restore neutral processing without erasing your tuning; enabling it again requires accepting the warning again. The explicit opt-in is saved as `galaxyXr.sdr10AllowEnhancements` (default false), so older files with overlapping mode flags stay protected.

**APK side is a separate manual step; the host does not send it.** Apply the Steam Link patch options yourself: `profile=neutral`, `outputPrecision=srgb8-highp`, `dithering=off`, `use8BitOutputWhenDithering=false`. Note `neutral` keeps Valve's `_valve1_d2020d709` matrix, it is not an identity transform end to end.

**Status.** Driver Settings and App Settings indicate when both modes are on and warn that image quality may be reduced. Stream Frame then exposes the picture controls. A device custom shader enabled for this headset still conflicts with the baseline request.

**Rollback.** Turning the baseline off disables its 10-bit capability request (`supports10bit=false`), also turns Image Enhancements off and clears enhancement consent. The explicit false is journaled even with vrlink Headset Profile off, so removing the key cannot accidentally restore an earlier true. Enable Image Enhancements separately to apply stored tuning. Schema 2 retires the old enabled `profileSupports10bit` default only when the baseline is off; custom picture/encoder tuning and explicit advanced overrides are preserved. Uninstall/recovery restores original values only while the current values still match the journal. Requires a SteamVR restart and reconnect. Recognized Quest Pro/PICO built-in capabilities can bypass per-model requests, so this switch does not guarantee a live 8-bit codec; verify the connection log. Picture adjustments reset when enabling the baseline are not restored by disabling it.

**Limits.** Requested is not observed: after a SteamVR start, check `driver_vrlink.txt` for `Using 10bit mode: 1`. Physical panel precision is unverified, and the authorized runtime test matrix has not been run.

Full design, exact override list, proof levels and the runtime matrix: [VD-LIKE-SDR10-IMPLEMENTATION-PLAN.md](../../steamlink-patches/diagnostics/steamlink-colour/VD-LIKE-SDR10-IMPLEMENTATION-PLAN.md) (§4.2, Phase 2, Phase 5, Phase 6).

## Distortion correction (static)

Symptom: fixate a point, rotate your head, the world ripples or swims. Most likely cause: the headset's built-in lens correction is slightly off; the error is a function of distance from the optical center. The correction applies a small counter-warp to the streamed image.

There are two ways to get a correction. The camera measured displacement map is the primary path; the radial curves are kept as a by-eye and smooth-prior path.

### Camera measured (displacement map)

A per-eye displacement map measured with a calibrated camera in front of the lens, either an automatic Gray-code sweep or manual editing against a ground truth grid. See [TunerUsage.md](TunerUsage.md) for the full workflow, `streamFrame.calib.*` for blackout / capture mode / patterns, and `streamFrame.brightness` for the always-on brightness multiplier.

### By eye (radial curves)

The curve sets a radial scale per ring around the optical center: 1.0 leaves that ring untouched, above 1.0 pulls its content toward the center, below pushes it outward. Real corrections are within about a percent of 1.0.

Suggested calibration workflow (WIP):

1. Stand in front of straight lines or text (the SteamVR construct grid works, or testHMD works).
2. Start in k1/k2 mode. Fixate a grid/text, rotate your head, nudge k1 in ±0.005 steps, refine periphery with k2.
3. Press "Convert k1/k2 to spline" to keep the shape and gain per-radius control points. Drag points, double click adds, right click removes.
4. Use the Annulus Tuning Band to isolate one radius band while tuning its control point (diagnostic only, disable for normal use).
5. If the residual differs between eyes or directions, enable Per Eye and/or Per Axis curves. The existing curve is copied as a starting point; tabs above the plot select which curve you are editing, siblings draw dimmed.
6. Optical Center Offsets move where the rings are anchored, per eye, if the residual is asymmetric around the center.
7. Eye Alignment (inside Distortion Correction) shifts each eye's image for prism-type misalignment. It is not a distortion fix; use it only if lines converge differently in each eye.

Calibrated one eye only? `python tools/gxr_mirror.py` mirrors it to the other. Lens distortion should be symmetric by design and a shared mirrored profile avoids inter-eye disparity, which is worse for the visual system than a shared error.

Share Distortion Profile exports and imports profiles as text or JSON so they can be posted and compared.

## Advanced: blackout

Blackout Headset Screens (Advanced section) turns both panels black while tracking, streaming and the game keep running. Use it when the headset stays connected but nobody is looking through it, while developing or testing, to avoid burn in. It needs Enable Image Processing on, and the calibration banner reminds you while it is active.

## Troubleshooting

Check `Steam\logs\vrserver.txt`:

- `FrameComponentShim: wrapping IVRDriverDirectModeComponent`: the frame path is hooked. Missing: the headset driver is not direct mode, or the driver did not load (check for duplicate registrations).
- Native resolution requests 3552x3840 per eye without forcing a refresh rate. Your selected rate (for example, 75 Hz) is preserved. Earlier refresh-rate overrides are restored only with journal ownership and an unchanged value. Resolution changes take effect on the next SteamVR start.
- `GalaxyXR: stream quality '<preset>'`: the preset was applied. Takes effect at the next headset connect.
- `GalaxyXR: SDR10 baseline: profile + supports10bit forced on ... REQUESTED ONLY`: the SDR 10-bit baseline forced the profile request; the device confirms at connect. Check `driver_vrlink.txt` for `Using 10bit mode: 1` after the next SteamVR start.
- `FrameProcessor: matched hmd adapter <gpu>`: processing runs on the GPU SteamVR renders on. `no adapter matched` / `failed to create D3D11 device`: report with your GPU setup.
- `FrameProcessor: OpenSharedResource failed`: shared texture access problem, usually wrong adapter (see above).
- `FrameProcessor: AcquireSync returned 0x00000102` occasionally is normal (busy frame skipped); constant spam is a problem you should report.
- `FrameProcessor: baked distortion lut (...)` appears whenever curve settings change.
- `FrameProcessor: PS compile error: ...`: a live edit of `resources\shaders\d3d11\vrlink_layer_ps.hlsl` has a typo; the previous working shader stays active.
- `Config: schema migration ...` on first start after upgrading: expected once. It resets Direction Lead and the shared controller offsets to the new defaults.

"Changes nothing": make sure Enable Image Processing is on and you are testing with something non-neutral (saturation 0 is unmissable).

"Controllers show as Index": that is the official profile's fallback and expected. See Controllers above.

"Headset still shows as vrlink / generic": Native Identity needs a full SteamVR restart, not a compositor restart.

If you have any issues, open an issue on the GitHub page linked in the GUI's About page and attach your `Steam\logs\vrserver.txt`. Please don't open them on the original sboys3 repository.
