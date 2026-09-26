# Changelog

All notable GalaxyXRDriver / Galaxy XR Companion release changes are recorded here.

New release entries are generated from commits on `main`: `fix:` bumps the patch
version, `feat:` bumps the minor version, and `rework:` bumps the major version. See
[the release workflow guide](Docs/Galaxy-XR-Companion/GITHUB-ACTIONS-RELEASE.md).

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
