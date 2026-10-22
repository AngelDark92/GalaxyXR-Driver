<p align="center"><img src="./GalaxyXRDriverGUI/public/GalaxyXRDriverCropped.png" height="96" alt="Galaxy XR Driver"></p>

# Galaxy XR Driver

Use your Samsung Galaxy XR as a proper SteamVR headset over Steam Link: correct headset identity, working controllers, native panel resolution, and image processing before the stream is encoded.

It is a fork of [CustomHeadsetOpenVR by sboys3](https://github.com/sboys3/CustomHeadsetOpenVR) and installs as its own vendor driver (`GalaxyXRNative`), so it can live next to the original and be switched with one click.

## ⚠️ Required: patched Steam Link builds

This driver has to work in tandem with the latest patched Steam Link releases for **2.0.20** and **2.0.23** — patch set **2.0.0** for both at the time of writing. Install the patched Steam Link on the headset first:

**→ [steamlink-androidxr-patched releases](https://github.com/AngelDark92/steamlink-androidxr-patched/releases)**

- Use the newest patch set available for your Steam Link version, with the newest driver release.
- The driver gives the headset its native identity, panel resolution and controller tracking, and owns the vrlink stream settings these builds expect. Without it, the stream falls back to generic vrlink defaults.

## What it does

**Headset**
- Native Galaxy XR identity in SteamVR: model name, manufacturer, icons — no more generic vrlink HMD or Quest Pro.
- Native render resolution: SteamVR renders at the panel's 3552×3840 per eye instead of the streamer's default.
- Stream quality controls for the vrlink encoder: tile width and bandwidth, with per-codec defaults.

**Controllers**
- Galaxy XR controller models, input profile and compositor bindings. Games without a native binding see Index controllers.
- Corrected grip origin and pose components, so held objects sit where the game expects them.
- Kalman pose filter that fixes throw velocity and improves tracking through dropouts in the streamed pose.

**Image processing**
- Saturation, vibrance, contrast, gamma, color matrix and brightness.
- CAS sharpening, FXAA, dither and stationary dimming.
- Distortion correction. The Galaxy XR owns its own lens correction, so this driver pre-warps the image before handing it off instead of replacing the profile. Corrections come from camera-measured per-eye displacement maps or by-eye radial curves, with profile export and import.
- Blackout for leaving the headset connected without burn-in.

Everything is configured in **Galaxy XR Companion** (Driver Settings, Image Settings, Distortion Profile, App Settings). Identity, input profile, resolution and quality changes need a SteamVR restart.

## Installing

1. Uninstall the existing Steam Link app on the headset, then install the patched build. Patched builds are signed with the patch tool's key, so they cannot update over a store install.
2. Download the latest driver release from the [releases page](https://github.com/AngelDark92/GalaxyXR-Driver/releases/latest).
3. Extract the whole folder from the zip. The `GalaxyXRDriverGUI` and `GalaxyXRNative` folders must stay next to each other.
4. Run `Galaxy XR Companion.exe` in `GalaxyXRDriverGUI` and open **Setup**.
5. Press **Install Driver**. If the stock CustomHeadsetOpenVR driver is also enabled, the Companion shows a notice and a **Switch to the Galaxy XR driver** button on any tab — press it.
6. On **Setup**, choose **Start SteamVR** and connect the headset through Steam Link. Wait for **Driver initialization verified in SteamVR**, then check the picture and controller tracking in the headset. Installed files and a successful launch request alone do not count as runtime verification.

Older copies of this fork that were installed into `SteamVR\drivers\CustomHeadsetOpenVR` are removed automatically on the first install, and their settings and distortion profiles are copied into the new settings folder. **Restore defaults** and **Uninstall driver** also live on **Setup**; both need SteamVR closed.

<img width="800" height="593" alt="Galaxy XR Companion installation and setup" src="https://github.com/user-attachments/assets/ec53a04e-e266-4f65-b705-188aeabd86bc" />

## Recommended settings

In **Driver Settings** and **Image Settings**:

- **Headset:** Galaxy XR Recognition on, Native Panel Resolution on (default), Stream Quality: Tile Width 1536, Bandwidth 350 Mbit/s (defaults).
- **Controllers:** Official Controller Layout on. Controller Motion Filter: Kalman CA (recommended). Leave the offsets alone unless the controllers visibly sit wrong in your hand; the shipped values were measured against the official models.
- **Picture mode:** **SDR 10-bit baseline** sends a 10-bit SDR stream (off by default; HEVC/AV1 only — selecting H.264 turns it off and keeps the switch disabled). It is independent of **Image Enhancements** (on by default): enable either in any order, no warning, and picture adjustments are not reset.

Then restart SteamVR once.

## Updating

Same as installing: extract the new zip, run the Companion and press **Install Driver** (or **Reinstall driver**) on **Setup**. Your saved settings are kept.

The Companion checks this repository's latest stable release and tells you when a newer one exists; if the check fails, **About** shows the error and **Check for updates** retries it. Enable **Developer Builds** under **App Settings → Updates** to also see newer pre-release builds: a stable release is only offered the next dev line (for example, 1.14.0 is offered 1.15.0-dev.*), never an older dev build that shipped before it.

## Troubleshooting and issues

Open an issue [here](https://github.com/AngelDark92/GalaxyXR-Driver/issues) and attach `Steam\logs\vrserver.txt` if applicable. Please do not report problems with this fork on the original CustomHeadsetOpenVR repository.

The full setup, feature and troubleshooting notes live in the [setup and image processing guide](Docs/StreamFrame.md).

## Documentation

- [Setup and image processing guide](Docs/StreamFrame.md): install, recommended configuration, feature notes, distortion correction by eye, troubleshooting from `vrserver.txt`.
- [Camera-based distortion tuning](Docs/TunerUsage.md): measuring lens correction with a fisheye camera, the sweep and overlay tools, mirroring one eye onto the other.
- [Portable build cleanup](Docs/PortableBuildCleanup.md): local builds and reclaiming generated files.
- [Release workflow](Docs/Galaxy-XR-Companion/GITHUB-ACTIONS-RELEASE.md): how releases are built and published.

## Advanced

<details>
<summary><strong>Manual configuration</strong></summary>

Settings live in `%APPDATA%\GalaxyXR\CustomHeadset\settings.json` and are hot-reloaded by the driver. Distortion profiles go in a `Distortion` subfolder and are referenced by name. The Companion's own preferences, including the window's `uiScale` (30–150 percent, default 100), live beside them in `gui-settings.json`.

</details>

<details>
<summary><strong>Calibration and tuning tools</strong></summary>

`tools/` holds the camera calibration and distortion tuning scripts (`gxr_sweep.py`, `gxr_overlay.py`, `gxr_mirror.py`, and the ChArUco / chessboard camera calibration). Python 3.9+, then `pip install -r tools/requirements.txt`. See the [tuner guide](Docs/TunerUsage.md).

</details>

<details>
<summary><strong>Building or applying a source update</strong></summary>

The source directories are `GalaxyXRDriverGUI` and `GalaxyXRDriver`, with `GalaxyXRDriver.sln`. Do not merge renamed folders blindly into an old layout; extract a source update separately and use `tools/Apply-SourceUpdate.cjs`. Existing AppData paths and the `GalaxyXRNative` OpenVR identifier are intentionally retained.

</details>

<details>
<summary><strong>Other headsets</strong></summary>

The image processing features should work on other direct-mode streamed headsets, but are untested.

</details>

## Credits

Galaxy XR icons were made by **Vilkka**.
Based on the original Quest Pro iconpack made by **Lux / Hekky**.

Built on [CustomHeadsetOpenVR](https://github.com/sboys3/CustomHeadsetOpenVR) by sboys3, with modifications by timkhronos and compdoge ([CustomHeadsetOpenVR](https://github.com/timkhronos/CustomHeadsetOpenVrGxR)). The camera calibration scripts in `tools/` started from sboys3's calibration code (see `tools/LICENSE-sboys3-camera-calibration`).

## License

GPLv2, same as the original project.
