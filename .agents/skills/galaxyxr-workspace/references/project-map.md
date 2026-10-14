# GalaxyXR-Driver implementation map

Verified against the source layout on 2026-10-08. Paths below are relative to
repository root unless labeled as artifacts. Search the named symbols in the
current files before making a behavioral claim.

## Settings and shared state

| Concern | Where to work | Coupling to preserve |
| --- | --- | --- |
| Native schema/defaults | `GalaxyXRDriver/src/Config/Config.h`, `Config.cpp` | Struct defaults and constructors are authoritative; retain legacy headset, Galaxy XR, controller and stream-frame sections. |
| Parse, reload, migration, telemetry | `GalaxyXRDriver/src/Config/ConfigLoader.cpp`, `ConfigLoader.h` | `ParseConfig`, `GetConfigFolder`, `MigrateLegacyConfig`, `WriteInfo`, `WriteDiagnosticInfo`; parser/default telemetry and migrations must agree. |
| Specialized policies | `GalaxyXRDriver/src/Config/DebugModePolicy.h`, `SdrColorPolicy.h`, `StreamTiers.h`, `VrlinkSettingsRouting.h` | Reuse policy helpers rather than duplicating decisions in consumers. |
| GUI mirror types/defaults | `GalaxyXRDriverGUI/src-lit/domain/types.ts`, `driver-defaults.ts`, `vendor-driver-defaults.ts` | Match native definitions/vendor overrides; telemetry availability must not become a prerequisite for editing settings. |
| Generate/check defaults | `tools/Generate-DriverDefaults.ps1` (`-Check` for verification) | Uses compiled native constructors and serializer; writes `driver-defaults.ts` only without `-Check`. Scratch: external `build/driver-defaults-generator/`. |
| Shared settings semantics | `GalaxyXRDriverGUI/src-lit/state/galaxy-settings.ts` (`GalaxySettingsBase`) | Pages delegate defaults, migrations, reset/import/save here. Migrations inspect stored/raw values before merged defaults; preserve save-failure rollback. |
| File persistence | `GalaxyXRDriverGUI/src-lit/services/driver-setting.ts`, `settings-base.ts`, `src-lit/platform/writer.ts` | `DriverSettingService`, `JsonSettingServiceBase`, debounced writes, error handling, retired-key pruning and watching. Read-only inspection must not migrate/save. |
| GUI-only settings | `GalaxyXRDriverGUI/src-lit/services/app-setting.ts` | `gui-settings.json`; keep presentation settings separate from native settings. |
| Runtime polling | `GalaxyXRDriverGUI/src-lit/services/driver-info.ts`, `pulling.ts`, `driver-startup.ts` | Info is telemetry; stale/missing data must not silently re-enable settings. |

For a new setting, cover C++ field/default, parser/default serialization, TS
mirror/default, shared state, page control/tip/reset, runtime consumer, source
XLIFF, relevant tests and user docs. For semantic changes, mirror versioned
migrations in `ConfigLoader.cpp` and `galaxy-settings.ts`, preserving user tuning.
Use dated-campaign comments to explain why tuning changes exist. Regenerate
native-derived defaults through the generator rather than hand-editing them.

## Runtime file contract and installation

`PathsService` in `GalaxyXRDriverGUI/src-lit/services/paths.ts` mirrors
`ConfigLoader::GetConfigFolder`. Windows Galaxy XR state is under
`%APPDATA%/GalaxyXR/CustomHeadset/`; neutral uses `%APPDATA%/CustomHeadset/`.
They exchange `settings.json` (GUI writes, driver reloads), `info.json` and
`diagnostic.json` (driver telemetry), and profiles under `Distortion/`.
`gui-settings.json` is GUI-only. These are user/runtime data, never build
artifacts or artifact-migration candidates.

| Concern | Primary files/symbols |
| --- | --- |
| Driver registration/vendor identity | `GalaxyXRDriver/src/Driver/HmdDriverFactory.cpp`, `GalaxyXRDriver/DriverFiles/driver.vrdrivermanifest`; `VENDOR_GALAXYXR` selects runtime identity. |
| Native reversible SteamVR writes | `GalaxyXRDriver/src/Config/SteamVRSettingsJournal.h`; header-only `gxrsettings` helpers such as `RecordChange`. |
| Install/switch/uninstall and journal handling | `GalaxyXRDriverGUI/src-tauri/src/driver_installation.rs`; `Context`, `load_journal`, `validate_journal`, `InstallReport`, `UninstallReport` |
| Cleanup/runtime confirmation | `GalaxyXRDriverGUI/src-tauri/src/driver_installation/settings_cleanup.rs`, `runtime_status.rs`; fingerprints/last-written values establish ownership, fresh loaded modules establish runtime state. |
| GUI diagnostics/install boundary | `GalaxyXRDriverGUI/src-lit/services/system-diagnostic.ts`, `settings-check.ts`, `domain/steamvr-settings-diff.ts`, `domain/settings-inspection.ts`, `domain/encoder-tap-status.ts` |
| Tauri process commands/registration | `GalaxyXRDriverGUI/src-tauri/src/js_api.rs`, `lib.rs`, `main.rs`; wrapper `GalaxyXRDriverGUI/src-lit/platform/tauri.ts` |

The Rust backend's journal is `steamvr-changes.json` and its receipt is
`installation.json` in its driver data directory. Preserve malformed/foreign
recovery evidence. Installation requires SteamVR stopped; the backend validates
that condition. Inspection/build authorization does not authorize stopping it.

## Driver behavior

| Area | Primary files |
| --- | --- |
| Initialization, devices, controller roles/offsets, pose/Kalman, reload dispatch | `GalaxyXRDriver/src/Driver/DeviceProvider.cpp`, `DeviceProvider.h`; helper `Hooking/ControllerPoseDispatch.h` |
| Per-frame color, CAS/FXAA/dither, stationary dimming, encoder settings | `GalaxyXRDriver/src/Driver/FrameProcessor.cpp`, `FrameProcessor.h` |
| Native encoding hooks/packing order | `GalaxyXRDriver/src/Driver/NvencTap.cpp`, `NvencTap.h`, `NvencPostPack.cpp`, `NvencPostPack.h` |
| Frame/device interception | `GalaxyXRDriver/src/Driver/DeviceShim.cpp`, `FrameComponentShim.cpp`, `CompositorPlugin.cpp`, `Hooking/Hooking.cpp`, `Hooking/InterfaceHookInjector.cpp` |
| Device-page shader replacement | `GalaxyXRDriver/src/Driver/ShaderReplacement.cpp`, `ShaderReplacement.h` |
| Galaxy XR identity/input/capabilities/early vrlink keys | `GalaxyXRDriver/src/Headsets/GalaxyXR.cpp`, `GalaxyXR.h`, `VrlinkCapabilities.h` |
| Legacy headset implementations | `GalaxyXRDriver/src/Headsets/BaseHeadset.*`, `GenericHeadset.*`, `FakeHeadset.*` |
| Distortion profiles | `GalaxyXRDriver/src/Distortion/DistortionProfileConstructor.*`, `RadialBezierDistortionProfile.*`, `DistortionModifier.h`, `NoneDistortionProfile.h` |
| Eye output, hidden area, diagnostics | `GalaxyXRDriver/src/Driver/EyeTrackingTap.*`, `src/Helpers/EyeTrackingOutput.*`, `src/HiddenArea/HiddenArea.*`, `src/Driver/ReconLogger.*`, `DriverLog.*` |

Trace flags to every consumer. Toggles need consistent OFF, hot-reload and
telemetry behavior; default/migration checks do not prove hooks/resources were
disabled. Live assertions require fresh PID/module evidence.

## Companion UI and localization

`GalaxyXRDriverGUI/src-lit/app-context.ts` wires services and `GalaxySettingsBase`;
`src-lit/main.ts` and `register.ts` register the Lit app. Reactive primitives:
`src-lit/reactive.ts`. Pages are thin views:

- `features/driver-settings-page.ts`: headset/device and legacy controls.
- `features/stream-frame-page.ts`: stream/image processing controls.
- `features/distortion-profile-page.ts`, `curve-editor.ts`: distortion/tuner UI.
- `features/debug-page.ts`: diagnostics gated by Debug Mode.
- `features/app-settings-page.ts`: presentation/Debug Mode/application settings.
- `features/setup-page.ts`, `system-ready.ts`, `driver-banner.ts`: setup/state UI.
- `features/about-page.ts`: project/update/install information.

Hash routing/permitted visibility lives in `src-lit/shell/app-shell.ts` and
`domain/navigation.ts`. Debug Mode OFF must gate direct routes and tabs. Shared
controls/tips/reset/styling: `src-lit/ui/controls.ts`, `shared-styles.ts`,
`presentation.ts`, `theme.ts`, `src-lit/styles/app.css`. Setting metadata/search:
`domain/settings-presentation.ts`.

Strings use `src-lit/locale/i18n.ts` and `t(...)`; source catalog:
`GalaxyXRDriverGUI/src/locale/messages.xlf`. Do not hand-edit existing translated
catalogs unless requested. Backend localization: `src-tauri/src/i18n.rs`. Vendor
flags come from `src/environment.ts` and generated `src/environment-gen.ts` via
`generate-env.js`; `src-lit/environment.ts` re-exports them. Project links:
`src-lit/domain/project.ts`.

## Build and artifact routing

Artifact root: `../builds/GalaxyXR-Driver/` from repository root. Every artifact
path below is relative to that root, independent of source/runtime identities.

| Artifacts | Consumers to align |
| --- | --- |
| `build/`: compiler scratch, native tests, logs, CMake/MSBuild intermediates | `tools/Build-Portable.ps1`, native `tools/Test-*.ps1`, `GalaxyXRDriver/CMakeLists.txt`, `Directory.Build.props`, `Directory.Build.targets`, `GalaxyXRDriver/GalaxyXRDriver.vcxproj` |
| `build/toolchains/`: portable tools/offline downloads | `tools/Setup-PortableBuildTools.ps1`, `Enter-PortableBuildEnvironment.ps1`, `Install-MicrosoftBuildTools.ps1`, `tools/lib/portable-toolchain.cjs`, `PortableToolchainIO.ps1` |
| `build/native-dependencies/`: restoration logs/work | `tools/prepare-native-dependencies.cjs`, `native-dependencies.lock.json`; vendored source remains under `ThirdParty/`. |
| `output/GalaxyXRDriverGUI/`: Cargo target output | `GalaxyXRDriverGUI/.cargo/config.toml`, builders' `CARGO_TARGET_DIR`, `tools/lib/stage-companion.cjs` |
| `output/GalaxyXRDriver-STAGING-<version>[-Galaxyxr]-Windows/`, `output/GalaxyXRDriver-Test-<timestamp>/` | `build.js`, `tools/Build-Portable.ps1`; packaged display executable: `Galaxy XR Companion.exe`. |
| `gui/build/`, `gui/dist/`, `gui/cache/`: localization, frontend bundles, Vite/Vitest cache | `GalaxyXRDriverGUI/package.json`, `vite.config.mts`, `vitest.config.mts`, `scripts/configure-tauri.mjs`, `build-frontend-dist.mjs`, `verify-frontend-dist.mjs`, `src-tauri/tauri.conf.json` |
| `build/test-fixtures/`: temporary isolated repositories and test files | `tools/lib/test-fixtures.cjs`, Node tool suites, `tools/Test-WorkspaceCleanup.ps1`; successful checks remove their own fixtures |
| `release/source/`: source ZIPs and temporary archive list files | `tools/Zip-Project.ps1`; explicit outputs must stay beneath the artifact root |
| Cargo `OUT_DIR/tauri-build-context/`: per-build Tauri scratch; `gui/schemas/`: stable editor schemas | `GalaxyXRDriverGUI/src-tauri/build.rs`, `src-tauri/capabilities/default.json` |
| `release/`: ZIP/checksum/notes | `tools/Package-GitHubRelease.ps1`, `publish-release.cjs`, `.github/workflows/release.yml` upload paths |

Vite/Vitest commands must use `--configLoader runner`: the default configuration
loader can create `node_modules/.vite-temp` inside source even when `outDir` and
`cacheDir` are external. `package.json` covers dev/test commands and
`scripts/build-frontend-dist.mjs` covers the production Vite invocation.

Cargo's target directory is external `output/GalaxyXRDriverGUI/`; keep the
`.cargo/config.toml` target and builders' `CARGO_TARGET_DIR` consistent.
`src-tauri/build.rs` rejects `OUT_DIR` outside the artifact root. It copies only
needed inputs to `OUT_DIR/tauri-build-context/`, resolves config input paths from
the real manifest directory, calls Tauri's build helper in that external context,
and restores the previous working directory. Tauri-generated `gen/schemas` stay
there and are copied to stable `gui/schemas/`. Capability `$schema` links point to
that stable location; never regenerate an in-source `src-tauri/gen/` directory.

Full staging: `node build.js --vendor galaxyxr` or `--vendor neutral`. Only when
full local verification is authorized/necessary, run
`powershell -NoProfile -ExecutionPolicy Bypass -File tools/Build-Portable.ps1`;
exit 0 plus `Built test package: ...` proves a complete local package.
`-DriverOnly`/`-GuiOnly` are partial builds. Version changes use
`node bump-version.js <version>`, never manual version edits. It synchronizes
seven files: GUI `package.json`/`package-lock.json`, native `Config.cpp`/manifest,
and Tauri `tauri.conf.json`/`Cargo.toml`/`Cargo.lock`; the npm lock has both root
and root-package version fields (eight values in total).
Linux: `cmake -S GalaxyXRDriver -B ../builds/GalaxyXR-Driver/build/cmake`, then
`cmake --build ../builds/GalaxyXR-Driver/build/cmake`; staging lives in that
external binary tree under `GalaxyXRDriver/bin/linux64/`.

## Focused verification and CI

- GUI logic: from `GalaxyXRDriverGUI/`, run `npm test`; target Vitest files for a
  narrow domain/service/state change. `npm run build:ui` checks frontend types
  and bundling without building the native driver.
- Native logic: matching `tools/Test-*.ps1` wrappers compile standalone tests in
  `GalaxyXRDriver/tests/`. Inspect input sources/defines first; wrappers configure
  the compiler and external outputs. Journal tests deliberately omit live writes.
  The NVENC (`Test-NvencToggle`, `Test-NvencPostPackOrder`), Game Link layout
  (`Test-GameLinkLayoutPolicy`) and controller-pose (`Test-ControllerPoseEpoch`,
  `Test-ControllerPoseVelocity`, `Test-ControllerPoseDispatch`) runners are now
  local end-of-task checks; release CI no longer runs them.
- Rust logic: from `GalaxyXRDriverGUI/src-tauri`, `cargo test --locked --lib`
  covers installation, cleanup and runtime confirmation; run it locally when a
  change reaches that crate.
- Service/UI/build hooks: `tools/Test-GuiReadiness.cjs`, `Test-CompanionModes.cjs`,
  `Test-AboutSetup.cjs`, `Test-FluentBuildHooks.cjs`, `Test-SteamVRSettingsDiff.cjs`
  and affected `tools/tests/*.test.cjs`. `Test-CompanionBrowser.cjs` uses mocked
  Tauri IPC against a built frontend and needs Playwright; it does not prove
  native installation or live driver behavior.
- Source/input checks: `node tools/verify-build-sources.cjs`; CI adds
  `--require-tracked`. Verify fresh-checkout inputs rather than assuming ignored
  captures/caches exist.
- `.github/workflows/build-tools.yml` tests tool compatibility on Windows
  PowerShell 5.1 and 7 and runs the GUI unit suite. `.github/workflows/release.yml`
  is build-only: both vendor builds, packaging and release publication, with no
  unit, Rust, service or NVENC suites. Run those suites locally at the end of
  every task. Read actual run results before claiming CI success; dispatch/push
  need authorization.
- Measured on the hosted runners (2026-10-12): the release job ran 13.7 min with
  every suite, 9.9 min build-only with a warm registry cache, 10.3 min after the
  upload rework. The neutral build is the largest single step (5-7 min, output
  not packaged); the Galaxy XR build adds 2-3 min. GitHub's own actions validate
  paths against the workspace: `actions/cache` rejects `..` in `path`, and
  `upload-artifact` rejects any pattern that leaves the workspace
  (`Relative pathing '.' and '..' is not allowed`). The release job therefore
  stages the external ZIP/checksum/notes into `ci-artifacts/` and the failure
  diagnostics into `ci-diagnostics/` before uploading. In PowerShell, normalize
  such paths with `[IO.Path]::GetFullPath` before slicing relative names — a
  joined `../` string makes `Substring($root.Length)` cut the real path wrong.

## Migration and cleanup

Read `Docs/PortableBuildCleanup.md`. Preview `tools/Move-BuildFolders.ps1` before
`-Apply`: known generated paths, verified boundaries/collisions and preservation
of evidence. Migration receipt: artifact root `build-folder-migration.json`.
Do not improvise recursive moves/deletes based only on directory names.

For retention, select one package from successful full-build evidence and check
its EXE, native DLL and manifest. Preview then apply
`tools/Clean-Workspace.ps1 -KeepPackage output/<verified-package>`; the argument
is relative to artifact root. Inspect `build/workspace-cleanup-last.json` there;
report removed bytes/protected skips. Preserve source/uncommitted work, vendored
source, offline toolchains, `node_modules`, registered/installed driver paths,
active paths, journals and diagnostics. Keep failed-build evidence until its
cause is understood. Unknown outputs/release ZIPs need individual review.
Finish downstream CI consumers before cleanup; do not repopulate caches afterward.

User docs: `Docs/StreamFrame.md`, `TunerUsage.md`, `DriverUninstall.md`,
`SteamLinkTrackingCapabilities.md`, `VrlinkSettingsRouting-2026-09-23.md`,
`tools/PORTABLE_BUILD.md`, `README.md`.

## Project agent roles

Each host has its own preset surface for the same three roles — Codex reads
`.codex/agents/cavecrew-investigator.toml` (read-only symbol/execution-path
discovery), `cavecrew-builder.toml` (bounded assigned edits) and
`cavecrew-reviewer.toml` (read-only concrete diff findings); Copilot reads
`.github/agents/*.md`; Codex and Hermes read the shared `.agents/skills/`.
Codex discovers standalone role files in `.codex/agents/`; do not add a separate
registration requirement. The exact role links are available in the cavecrew skill.

Hermes does not read `.codex/agents/` or `.github/agents/`. Trust the checkout
once (`hermes skills trust` from the checkout root) so `.agents/skills/` loads,
then delegate with `delegate_task`: children inherit the session model, get a
fresh context and cannot ask questions, so paste the role contract and every
path into each child's `context`; the parent re-reads cited lines and reruns
the checks.

Read [cavecrew](../../cavecrew/SKILL.md) for delegation and output contracts.
Pass explicit file ownership, source/artifact roots, requested evidence and
authorized checks to each spawned agent; a role's read-only scope prohibits
write-producing tests. Generic communication skills do not override those roles
or the repository contract.
