> **Galaxy XR Companion cumulative update:** see [README-GALAXY-XR-COMPANION.md](README-GALAXY-XR-COMPANION.md) for the current Lit/Tauri setup, source replacement instructions and full portable build. The project background below is retained from the original source.

# GalaxyXRDriver

A SteamVR driver for the Samsung Galaxy XR over Steam Link / vrlink. It makes the headset and its controllers show up in SteamVR as what they are, fixes controller tracking and throw velocity, and processes the streamed image (color, sharpening, anti-aliasing, distortion correction) right before it is encoded.

It is a fork of [CustomHeadsetOpenVR by sboys3](https://github.com/sboys3/CustomHeadsetOpenVR) and ships as a separate vendor driver (`GalaxyXRNative`), so it can be installed next to the original and switched with one click.

<picture><img src="./GalaxyXRDriverGUI/public/GalaxyXRDriverCropped.png" height="96"><img/></picture>

## What it does

**Headset**
- Native Galaxy XR identity in SteamVR: model name, manufacturer, icons. No more generic vrlink HMD / Quest Pro.
- Native render resolution: SteamVR renders at the panel's 3552×3840 per eye instead of the streamer's default.
- Stream quality presets for the vrlink encoder.

**Controllers**
- Galaxy XR controller models, input profile and compositor bindings. Games without a native binding see Index controllers.
- Corrected grip origin and pose components so held objects sit where the game expects them.
- Kalman pose filter that fixes throw velocity and improves tracking dropouts from the streamed pose.

**Image processing**
- Saturation, vibrance, contrast, gamma, color matrix, brightness.
- CAS sharpening, FXAA, dither, stationary dimming.
- Distortion correction. The Galaxy XR owns its own lens correction, so this driver pre-warps the image before handing it off rather than replacing the profile. Corrections come from camera-measured per-eye displacement maps or by-eye radial curves, with profile export/import.
- Blackout for leaving the headset connected without burn-in.

Configure the driver in **Galaxy XR Companion 1.2.0**, using Driver Settings, Image Settings, and the calibration pages. About opens by default and owns installation, setup verification, and Clean Settings. Identity, input profile, resolution and quality changes need a SteamVR restart.

## Installing

1. Download the latest release from the [releases page](https://github.com/AngelDark92/GalaxyXR-Driver/releases/latest).
2. Extract the whole folder from the zip. The `GalaxyXRDriverGUI` and `GalaxyXRNative` folders must stay next to each other.
3. Run `Galaxy XR Companion.exe` in `GalaxyXRDriverGUI`, go to About, press Install.
4. If the stock CustomHeadsetOpenVR driver is also enabled, the GUI shows a notice and a "Switch to this driver" button. Press it.
5. On About, select **Start SteamVR** and connect the headset through Steam Link. Wait for **Driver initialization verified in SteamVR**. Installed files and a successful launch request alone do not count as runtime verification. Check the picture and controller tracking in the headset to complete setup.

Older copies of this fork that were installed into `SteamVR\drivers\CustomHeadsetOpenVR` are removed automatically on the first install, and their settings and distortion profiles are copied into the new settings folder.

![Installation Tutorial](Docs/Media/GalaxyXRDriverInstall.webp)

## Building or applying a source update

The source directories are now `GalaxyXRDriverGUI` and `GalaxyXRDriver`, with `GalaxyXRDriver.sln`. Do not merge the renamed folders blindly into the old layout. Extract a source update separately and use `tools/Apply-SourceUpdate.cjs`; see [the current update instructions](README-GALAXY-XR-COMPANION.md). Existing AppData paths and the `GalaxyXRNative` OpenVR identifier are intentionally retained.

## Updating

Same as installing: extract the new zip, run the GUI, go to Setup and press Install (or Re-Install). The GUI checks this repository's latest stable release and tells you when a newer version is available. If the check fails, the About page shows a failure message; use Check for updates to retry.

## Recommended settings

In Driver Settings and Image Settings:

- Headset: Native Identity on, Native Render Resolution on (default), Stream Quality Preset High.
- Controllers: Official Controller Input Profile on. Leave Controller Fix Mode on Kalman CA.
- Picture mode: keep **SDR 10-bit baseline** for unprocessed SDR output. To experiment with color, sharpening or lens correction while keeping the 10-bit request, enable **Image Enhancements** in App Settings and accept the image-quality warning. The combination may reduce image quality. Turn Image Enhancements off to return to neutral processing. Enabling the baseline resets picture adjustments and active lens corrections after confirmation.

Then restart SteamVR once.

## Documentation

- [Setup and image processing guide](Docs/StreamFrame.md): install, recommended configuration, feature notes, distortion correction by eye, troubleshooting from `vrserver.txt`.
- [Camera based distortion tuning](Docs/TunerUsage.md): measuring the lens correction with a fisheye camera, the sweep and overlay tools, mirroring one eye onto the other.

## Reporting issues and Feature Requests

Open an issue [here](https://github.com/AngelDark92/GalaxyXR-Driver/issues) and attach `Steam\logs\vrserver.txt` if applicable. Please do not report problems with this fork on the original CustomHeadsetOpenVR repository.

## Manual configuration

Settings live in `%APPDATA%\GalaxyXR\CustomHeadset\settings.json` and are hot-reloaded by the driver. Distortion profiles go in a `Distortion` subfolder and are referenced by name.

## Tools

`tools/` holds the camera calibration and distortion tuning scripts (`gxr_sweep.py`, `gxr_overlay.py`, `gxr_mirror.py`, and the ChArUco / chessboard camera calibration). Python 3.9+, `pip install -r requirements.txt`. See the [tuner guide](Docs/TunerUsage.md).

## Other headsets


The image processing features should work on other direct-mode streamed headsets but are untested.

## Credits

Galaxy XR icons were made by **Vilkka**.  
Based on original Quest Pro iconpack made by **Lux / Hekky**.

Built on [CustomHeadsetOpenVR](https://github.com/sboys3/CustomHeadsetOpenVR) by sboys3 with modifications by timkhronos and compdoge [CustomHeadsetOpenVR](https://github.com/timkhronos/CustomHeadsetOpenVrGxR). The camera calibration scripts in `tools/` started from sboys3's calibration code (see `tools/LICENSE-sboys3-camera-calibration`).

## License

GPLv2, same as the original project.
