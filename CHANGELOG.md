# Changelog

All notable GalaxyXRDriver / Galaxy XR Companion release changes are recorded here.

New release entries are generated from commits on `main` and `dev`: `fix:` bumps the patch
version, `feat:` bumps the minor version, and `rework:` bumps the major version. See
[the release workflow guide](Docs/Galaxy-XR-Companion/GITHUB-ACTIONS-RELEASE.md).

## [1.13.0-dev.8] - 2026-10-19

### Features

- implement interface scale feature with adjustable zoom for the Companion window (`9029f09`)

## [1.13.0-dev.7] - 2026-10-19

### Features

- gui: bundle and version-manage the OFXR optical-flow payload (`e7897d1`)

### Fixes

- gui: place the Optical Flow card above Encoder Advanced (`4dbea08`)
- tools: recognize the OFXR payload in package cleanup (`acb35b8`)

## [1.13.0-dev.6] - 2026-10-19

### Features

- Implement AV1 split encoding deferral and handshake management for reconnect scenarios (`0561df1`)

## [1.13.0-dev.5] - 2026-10-19

### Features

- Implement bitrate curve families and related functionality (`50351eb`)

## [1.13.0-dev.4] - 2026-10-19

### Features

- implement disabled codec switch state management and UI integration while steamvr is running (`65335ae`)

## [1.13.0-dev.3] - 2026-10-19

### Fixes

- update portable build directory naming and cleanup logic (`4cd363e`)

## [1.13.0-dev.2] - 2026-10-19

### Fixes

- gui: expose setting source in the check report (`645a19c`)

## [1.13.0-dev.1] - 2026-10-19

### Features

- experimental optical flow (ofxr) support (`652f48a`)

## [1.12.2] - 2026-10-18

### Fixes

- adjust controller priority and remove unused remappings in galaxy\_xr\_controller\_remapping.json (`ac1065e`)
- update attention step card styles for better visibility (`fb009f1`)

## [1.12.2-dev.2] - 2026-10-18

### Fixes

- update attention step card styles for better visibility (`fb009f1`)

## [1.12.2-dev.1] - 2026-10-18

### Fixes

- adjust controller priority and remove unused remappings in galaxy\_xr\_controller\_remapping.json (`ac1065e`)

## [1.12.1] - 2026-10-18

### Fixes

- enhance visibility handling and performance optimizations across components (`b16f84f`)
- update native input profile to default ON and adjust split handling in encoder initialization (`3be5068`)
- implement split handshake grace of 5s to prevent zero ACKs on first frame in encoder initialization (`1f41b46`)

## [1.12.1-dev.3] - 2026-10-18

### Fixes

- implement split handshake grace of 5s to prevent zero ACKs on first frame in encoder initialization (`1f41b46`)

## [1.12.1-dev.2] - 2026-10-18

### Fixes

- update native input profile to default ON and adjust split handling in encoder initialization (`3be5068`)

## [1.12.1-dev.1] - 2026-10-18

### Fixes

- enhance visibility handling and performance optimizations across components (`b16f84f`)

## [1.12.0] - 2026-10-17

### Features

- add ASW, status handling and tests (`1488b1e`)

### Fixes

- Refactor NVENC settings to disable Force CBR by default (`ed918b4`)
- Update Force CBR default to On for all codecs and adjust related documentation, disable 10bit for h.264 which wouldn't support it anyway (`8865361`)
- SDR 10-bit baseline handling and image enhancements, various improvements (`d979a23`)

### Other changes

- Update Ko-fi funding username (`b1014a8`)

## [1.12.0-dev.4] - 2026-10-17

### Fixes

- SDR 10-bit baseline handling and image enhancements, various improvements (`d979a23`)

## [1.12.0-dev.3] - 2026-10-17

### Fixes

- Update Force CBR default to On for all codecs and adjust related documentation, disable 10bit for h.264 which wouldn't support it anyway (`8865361`)

## [1.12.0-dev.2] - 2026-10-17

### Fixes

- Refactor NVENC settings to disable Force CBR by default (`ed918b4`)

## [1.12.0-dev.1] - 2026-10-17

### Features

- add ASW, status handling and tests (`1488b1e`)

## [1.11.0] - 2026-10-17

### Features

- gui: retire the Stream Quality preset; Tile Width and Bandwidth are first-class editable settings (`9774a99`)
- gui: NVENC Tap, Stream codec and Restore live under Stream Quality, not advanced (`730b7d2`)
- gui: Stream codec select disabled while the NVENC Tap is off (`cc3c531`)
- gui: help catalog + docs follow the preset retirement (`0e90b37`)
- gui: per-codec default Tile Width and Bandwidth (HEVC 1536/350, H.264 1536/500, AV1 1536/400) (`a74380d`)
- Various renaming and description changes, silent settings change now solved, minor bug fixes (`0cf0cf7`)
- implement inline validation for Stream Frame app-number keys (`6d696fd`)

### Fixes

- honesty pass 2 for real values in app (`4b45110`)
- gui: setting rows are not selectable; focus highlight only on keyboard/deep-link focus (`a1b6fae`)
- gui: fold the reviewer findings of the stream-quality rework (`c2f629a`)
- implement true merge for backmerging main into dev with loud failure handling (`35afc1c`)
- update stream codec references and descriptions for clarity, av1 now not experimental (`e43f1a6`)
- update label for nvencForceCbr setting to 'Constant Bitrate' for clarity (`b3d1eee`)
- enhance error reporting in Guarded function to include NVENC status and request details (`54f1b2b`)
- regressions from dev 3 and bump version to 1.11.0-dev.6 with updated dependencies (`5929b69`)
- enhance setup page behavior and routing during driver installation (`4505761`)

### Other changes

- test(gui): extend the SectionCards reveal stub with the focus-ring endpoints (`ca8fb27`)

## [1.11.0-dev.8] - 2026-10-17

### Fixes

- enhance setup page behavior and routing during driver installation (`4505761`)

## [1.11.0-dev.7] - 2026-10-17

### Fixes

- regressions from dev 3 and bump version to 1.11.0-dev.6 with updated dependencies (`5929b69`)

## [1.11.0-dev.5] - 2026-10-16

### Fixes

- enhance error reporting in Guarded function to include NVENC status and request details (`54f1b2b`)

## [1.11.0-dev.4] - 2026-10-16

### Features

- implement inline validation for Stream Frame app-number keys (`6d696fd`)

## [1.11.0-dev.3] - 2026-10-16

### Features

- Various renaming and description changes, silent settings change now solved, minor bug fixes (`0cf0cf7`)

### Fixes

- update label for nvencForceCbr setting to 'Constant Bitrate' for clarity (`b3d1eee`)

## [1.11.0-dev.2] - 2026-10-16

### Fixes

- update stream codec references and descriptions for clarity, av1 now not experimental (`e43f1a6`)

## [1.11.0-dev.1] - 2026-10-16

### Features

- gui: retire the Stream Quality preset; Tile Width and Bandwidth are first-class editable settings (`9774a99`)
- gui: NVENC Tap, Stream codec and Restore live under Stream Quality, not advanced (`730b7d2`)
- gui: Stream codec select disabled while the NVENC Tap is off (`cc3c531`)
- gui: help catalog + docs follow the preset retirement (`0e90b37`)
- gui: per-codec default Tile Width and Bandwidth (HEVC 1536/350, H.264 1536/500, AV1 1536/400) (`a74380d`)

### Fixes

- honesty pass 2 for real values in app (`4b45110`)
- gui: setting rows are not selectable; focus highlight only on keyboard/deep-link focus (`a1b6fae`)
- gui: fold the reviewer findings of the stream-quality rework (`c2f629a`)
- implement true merge for backmerging main into dev with loud failure handling (`35afc1c`)

### Other changes

- test(gui): extend the SectionCards reveal stub with the focus-ring endpoints (`ca8fb27`)

## [1.10.0-dev.10] - 2026-10-16

### Features

- gui: retire the Stream Quality preset; Tile Width and Bandwidth are first-class editable settings (`9774a99`)
- gui: NVENC Tap, Stream codec and Restore live under Stream Quality, not advanced (`730b7d2`)
- gui: Stream codec select disabled while the NVENC Tap is off (`cc3c531`)
- gui: help catalog + docs follow the preset retirement (`0e90b37`)
- gui: per-codec default Tile Width and Bandwidth (HEVC 1536/350, H.264 1536/500, AV1 1536/400) (`a74380d`)

### Fixes

- gui: setting rows are not selectable; focus highlight only on keyboard/deep-link focus (`a1b6fae`)
- gui: fold the reviewer findings of the stream-quality rework (`c2f629a`)

## [1.10.0-dev.9] - 2026-10-15

### Fixes

- honesty pass 2 for real values in app (`4b45110`)

## [1.10.0] - 2026-10-15

### Features

- nvenctap: H.264 session support groundwork (`1cb8192`)

### Fixes

- gui: re-check updates when the dev channel flips mid-flight (`318a1cd`)
- Enhance delta map handling and session codec management in NvencTap (`36c64b9`)
- Refactor NVENC settings and update codec handling (`c3928cb`)

## [1.10.0-dev.8] - 2026-10-15

### Features

- nvenctap: H.264 session support groundwork (`1cb8192`)

### Fixes

- gui: re-check updates when the dev channel flips mid-flight (`318a1cd`)
- Enhance delta map handling and session codec management in NvencTap (`36c64b9`)
- Refactor NVENC settings and update codec handling (`c3928cb`)

## [1.9.0-dev.7] - 2026-10-15

### Fixes

- Refactor NVENC settings and update codec handling (`c3928cb`)

## [1.9.0-dev.6] - 2026-10-15

### Fixes

- Enhance delta map handling and session codec management in NvencTap (`36c64b9`)

## [1.9.0-dev.5] - 2026-10-15

### Fixes

- gui: re-check updates when the dev channel flips mid-flight (`318a1cd`)

## [1.9.0-dev.4] - 2026-10-15

### Features

- nvenctap: H.264 session support groundwork (`1cb8192`)

## [1.9.0] - 2026-10-14

### Features

- ci: publish dev prereleases from the dev branch (`4be0d0a`)
- gui: add Dev Updates channel toggle (`0592a23`)
- codec: enhance AV1 codec support and improve error handling (`ae2ecd6`)

### Fixes

- ci: make automatic-release fixtures version-independent (`0d97514`)

### Other changes

- docs(ci): document the dev release channel (`eca1337`)

## [1.9.0-dev.3] - 2026-10-14

### Features

- codec: enhance AV1 codec support and improve error handling (`ae2ecd6`)

## [1.9.0-dev.2] - 2026-10-13

### Fixes

- ci: make automatic-release fixtures version-independent (`0d97514`)

### Other changes

- docs(ci): document the dev release channel (`eca1337`)

## [1.9.0-dev.1] - 2026-10-13

### Features

- ci: publish dev prereleases from the dev branch (`4be0d0a`)
- gui: add Dev Updates channel toggle (`0592a23`)

## [1.8.0] - 2026-10-13

### Features

- added possibility to select the codec to encode to, still experimental both driver and steam-link patch (`d974bfb`)

### Other changes

- chore(ci): stage release uploads inside the workspace (`687977e`)

## [1.7.2] - 2026-10-12

### Fixes

- preserve repeated controller pose timing and layout velocities (`25c0ff8`)

## [1.7.1] - 2026-10-11

### Fixes

- remove HAL controller timestamp compensation (`5f8087b`)

## [1.7.0] - 2026-10-07

### Features

- pose time stamp bias for headset-side controller prediction (`24823bb`)

## [1.6.2] - 2026-10-05

### Fixes

- remove Kalman CA (Velocity only), keep the stream's accelerations (`35f149a`)
- remove the Game Link velocity cutoff (`bb8481d`)

## [1.6.1] - 2026-10-04

### Fixes

- remove Controller Rest Smoothing (`1bc7198`)

## [1.6.0] - 2026-10-04

### Features

- Game Link Layout, the controllers as Samsung's own PC driver presents them (`abe0633`)

### Fixes

- gui: declare @types/node as a dev dependency (`3c77780`)

### Other changes

- Update README with new installation image and instructions (`fcd2d61`)

## [1.5.0] - 2026-10-01

### Features

- Introduce Debug Mode and associated settings (`d2cdbe5`)

### Fixes

- ci: honor Debug Mode in navigation checks (`1b9681d`)

## [1.4.0] - 2026-09-30

### Features

- restore Steam Link encoder behaviour with strict NVENC OFF bypass (`2880be2`)

### Fixes

- synchronize NVENC hook installation with OFF confirmation (`fe8b58e`)

### Other changes

- docs: explain NVENC installation snapshot locking (`7d80533`)

## [1.3.0] - 2026-09-26

### Features

- improve settings recovery and refresh Companion UI (`a3d3bcb`)

### Fixes

- ci: recover stale release metadata (`ae0c13f`)

## [1.2.14] - 2026-09-26

### Fixes

- nvenc defaults changed and tabs now fill the window width (`442501b`)

## [1.2.13] - 2026-09-26

### Fixes

- hitch diagnostics off by default (`2d34565`)

## [1.2.12] - 2026-09-25

### Fixes

- various bug fixes on toggles (`31ee38f`)

## [1.2.11] - 2026-09-25

### Fixes

- CAS and other settings woould potentially not apply at driver install (`2c9daba`)

## [1.2.10] - 2026-09-25

### Fixes

- image enhancements can now be selected even with sdr 10-bit patch if user accepts warning (`f179b50`)

## [1.2.9] - 2026-09-25

### Fixes

- controller Kalman CA regression fix (`bb52c11`)

## [1.2.8] - 2026-09-24

### Fixes

- 90Hz not forced anymore (`6bff22d`)

## [1.2.7] - 2026-09-23

### Fixes

- settings now applied under driver\_vrlink (`bd7535e`)

## [1.2.6] - 2026-09-23

### Fixes

- the settings are now also written under Quest Pro and Pico 4 Pro identities for people with the identity patch (`71b62ac`)

## [1.2.5] - 2026-09-23

### Fixes

- automatic versioning (`5f4791d`)

## [1.2.1] - 2026-09-22

- Fixed CI service tests on fresh Windows runners and updated section-card checks for the shared collapse state.
- Automatically build both vendor variants and publish the Galaxy XR ZIP and checksum when the version changes on `main`.
- Synchronize all application version fields and lockfiles with `node bump-version.js`.
- Preserve published releases on retries and publish new releases only after both asset uploads succeed.
- Resolve Windows short-path aliases in installer boundary checks, preventing a bundle from being copied inside itself.
- Keep the local `tools/Build-Portable.ps1` command and package layout unchanged.

## [1.2.0] - 2026-09-21

### Portable dependency bootstrap correction

- Local `Build-Portable.ps1` now detects complete MSVC/Windows SDK tools or downloads them from official publisher manifests rather than requiring a prefilled ignored toolchain directory and one hard-coded MSVC patch.
- Added checksum verification, bounded retries, cache reuse, safe staging, a compile/link probe, license acknowledgement, and project-local Node/Rust fallback without machine/user PATH changes.
- Full builds prepare locked frontend dependencies automatically; missing source dependencies are initialized only from recorded Git submodule revisions. Added preparation-only and no-download modes.
- Added network-free toolchain selection/setup regressions and real Windows PowerShell 5.1/7 I/O tests to the release workflow; required-source preflight includes the new helpers. Application/driver behavior and version remain unchanged.


### Companion UI

- Renamed the desktop application to **Galaxy XR Companion** while preserving existing internal identifiers and settings paths for compatibility.
- Replaced the Angular Material frontend with the Lit + Fluent Web Components frontend and retained the Tauri/Rust native backend.
- Fixed Fluent light/dark/system theming, control contrast, switches/toggles, dropdown synchronization, tab semantics, keyboard behavior, responsive layout, and top-layer help popovers.
- Reworked help text for less technical users while retaining expandable technical detail.
- Added a settings verification action that rereads saved driver/SteamVR settings and synchronizes every toggle with the actual persisted state instead of assuming UI state is authoritative.
- Open **About** by default. Before installation, keep **About** and **App Settings** available; gate driver-dependent tabs and direct routes until installation is verified. Installation and settings verification remain on About, not duplicated in App Settings.
- Grouped parent and nested settings in bordered collapsible cards, with bold left-aligned headings and progressively indented child fields across all settings pages. Removed redundant Expand/Collapse captions while keeping keyboard access and expanded-state semantics.
- Hid **Galaxy XR Native Identity** and **vrlink Headset Profile** unless Advanced mode is enabled. Both remain enabled by default, preserve explicit user choices, and warn that disabling them can cause SteamVR to identify the headset as Unknown or as the patched Steam Link identity.
- Removed the duplicate **Profile: Supports 10-bit** control.
- Made **SDR 10-bit baseline** and **Image Enhancements** mutually exclusive. Enabling SDR baseline requires Image Enhancements to be off and resets picture-processing adjustments to defaults; the UI explains the required off-first workflow in both directions.

- Added an About setup guide with separate installed-files and current-session runtime checks. **Start SteamVR** is a required step, not automatic proof of a working driver. Version, current server process, driver initialization flag and fresh heartbeat must agree before verification is shown.
- Renamed **Older Identity Settings** to **Settings**, and **Clean Older Identity Settings** to **Clean Settings**. Cleanup is available before installation, resets all local tab settings, backs up originals, and conservatively restores recorded SteamVR writes while retaining registration, lifecycle choices, unrelated preferences, bindings, room setup, and saved profile files.

### SteamVR settings and driver behavior

- Added profile-aware SteamVR settings routing: with **vrlink Headset Profile** enabled, applicable profile/tuning values target `vrlink_xrvst2ue`; when disabled, the previous destinations are retained.
- Preserved SteamVR-global settings and driver enable/block settings in their required sections.
- Fixed installation detection so valid registered/copied driver packages are recognized without relying only on optional metadata files.
- Added UTF-8 BOM tolerance in the Rust manifest reader and changed portable JSON generation to UTF-8 without BOM.
- Fixed native image-processing guards so disabled Image Enhancements cannot leave encoder-side sharpening active.
- Removed retired non-Galaxy-XR vendor-specific source, assets, and code paths while preserving Galaxy XR and generic/neutral behavior.

### Icons and branding

- Added Galaxy XR SteamVR HMD status icons through OpenVR driver properties, including searching/standby/error/ready states and high-DPI variants.
- Rebuilt Windows/Tauri icon resources with multiple sizes for better taskbar/titlebar scaling.
- Added explicit icon attribution: Galaxy XR icons were made by **Vilkka**, based on original Quest Pro iconpack made by **Lux / Hekky**.

### Build and release

- Fixed the broad Git `lib` ignore rule hiding `tools/lib/stage-companion.cjs`. Re-included the helper directory and its contents, retained the shared validated executable-staging implementation, and added an early CI check for missing, empty, ignored, or untracked release helpers. Added a fresh-clone regression that runs the actual portable build-hook suite using only normally committed files.

- Fixed release-version validation of npm `packages[""]` entries by parsing the lockfile with the existing Node.js toolchain, preserving all version/tag checks and the PowerShell entry-point contract. Added both-layout compatibility and regression coverage, including required Windows PowerShell / PowerShell 7 wrapper tests in CI.

- Renamed source/build/package paths to **GalaxyXRDriver**, including `GalaxyXRDriverGUI`, `GalaxyXRDriver.sln`, `galaxyxrdriver-gui`, and `GalaxyXRDriver-v1.2.0-Windows-x64.zip`. The desktop display name stays Galaxy XR Companion, and installed OpenVR/data compatibility identifiers remain unchanged.
- Added a backed-up, rollback-aware source updater for both old and already-renamed checkouts. It preserves ThirdParty and unrelated source, archives retired files, and does not touch SteamVR or AppData.
- Added regression suites for About setup, runtime status service, reset coordination, source migration and nested cards. The Windows release workflow additionally runs native Rust installation/reset/runtime tests before publishing.

- Fixed native Windows linking by including zlib `zutil.c`; this resolves unresolved `zcalloc`, `zcfree`, and `z_errmsg` symbols in portable and MSBuild releases.
- Fixed Windows PowerShell 5.1 portable builds incorrectly treating Tauri's normal stderr status output as a terminating `NativeCommandError`.
- Fixed portable `driver.vrdrivermanifest` and `default.vrsettings` generation so JSON is written without a UTF-8 BOM.
- Preserved the existing portable layout containing `GalaxyXRDriverGUI` beside `GalaxyXRNative`.
- Added a Windows GitHub Actions release pipeline that checks version consistency, installs dependencies/toolchains, runs frontend tests, builds the driver and Tauri app, produces a versioned portable ZIP, creates SHA-256 metadata, generates release notes from this changelog plus commits since the previous tag, uploads workflow artifacts, and publishes GitHub Releases for `v*` tags.
