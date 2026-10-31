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
| Numeric control contracts | `GalaxyXRDriverGUI/src-lit/domain/control-specs.ts` | One spec per numeric keys.json key: range, step, unit, integer, sentinels, codec/capability/context/ordering. Pages render from it; the coverage test rejects an undeclared numeric control. |
| Runtime polling | `GalaxyXRDriverGUI/src-lit/services/driver-info.ts`, `pulling.ts`, `driver-startup.ts` | Info is telemetry; stale/missing data must not silently re-enable settings. |

For a new setting, follow the full chain in `AGENTS.md`. For semantic changes,
mirror versioned migrations in `ConfigLoader.cpp` and `galaxy-settings.ts`,
preserve user tuning, and regenerate native-derived defaults through the generator.

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

The read-only bitrate graph uses a separate `curve.html` / `src-lit/curve-main.ts`
entry. `src-lit/services/curve-preview.ts` owns the Companion subscription while
`src-tauri/src/curve_preview.rs` creates the native window on demand. The
on-demand bitrate monitor uses `bitrate.html` / `src-lit/bitrate-main.ts`;
`src-tauri/src/bitrate_monitor/` owns the native window and the read-only
NVENC/USB ADB samplers, and `src-lit/features/bitrate-monitor-window.ts` starts
them only on mount/visible and stops them on close/hide. Debug Mode gates the
open control. Keep all three HTML entries in Vite and the per-locale asset
verifier. See `Docs/CompanionGraphWindow.md` for async WebView2 creation,
lifecycle and QA, and `Docs/BitrateMonitor.md` for the monitor's measurement
contract.

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

Artifact root: `../builds/GalaxyXR-Driver/` from repository root. Paths below are relative to that root; the artifact contract is in `AGENTS.md`.

| Artifacts | Consumers to align |
| --- | --- |
| `build/`: compiler scratch, native tests, logs, CMake/MSBuild intermediates | `tools/Build-Portable.ps1`, native `tools/Test-*.ps1`, `GalaxyXRDriver/CMakeLists.txt`, `Directory.Build.props`, `Directory.Build.targets`, `GalaxyXRDriver/GalaxyXRDriver.vcxproj` |
| `build/toolchains/`: portable tools/offline downloads | `tools/Setup-PortableBuildTools.ps1`, `Enter-PortableBuildEnvironment.ps1`, `Install-MicrosoftBuildTools.ps1`, `tools/lib/portable-toolchain.cjs`, `PortableToolchainIO.ps1` |
| `build/native-dependencies/`: restoration logs/work | `tools/prepare-native-dependencies.cjs`, `native-dependencies.lock.json`; vendored source remains under `ThirdParty/`. |
| `output/GalaxyXRDriverGUI/`: Cargo target output | `GalaxyXRDriverGUI/.cargo/config.toml`, builders' `CARGO_TARGET_DIR`, `tools/lib/stage-companion.cjs` |
| `output/GalaxyXRDriver-STAGING-<version>[-Galaxyxr]-Windows/`, `output/GalaxyXRDriver-Test-<timestamp>/` | `build.js`, `tools/Build-Portable.ps1`; packaged display executable: `Galaxy XR Companion.exe`. |
| `gui/build/`, `gui/dist/`, `gui/cache/`: localization, frontend bundles, Vite/Vitest cache | `GalaxyXRDriverGUI/package.json`, `vite.config.mts`, `vitest.config.mts`, `scripts/configure-tauri.mjs`, `build-frontend-dist.mjs`, `verify-frontend-dist.mjs`, `src-tauri/tauri.conf.json` |
| `build/test-fixtures/`: temporary isolated repositories and test files | `tools/lib/test-fixtures.cjs`, Node tool suites, `tools/Test-WorkspaceCleanup.ps1`; successful checks remove their own fixtures |
| `build/`: isolated release backmerge worktrees | `tools/backmerge-release.cjs`, invoked after main publication; preserves the build checkout, removes successful scratch and retains failed scratch for diagnosis |
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

Full staging: `node build.js --vendor galaxyxr` or `--vendor neutral`;
`-DriverOnly`/`-GuiOnly` are partial builds. Version changes use
`node bump-version.js <version>` and synchronize the native, npm, Cargo and Tauri
version files. Linux: `cmake -S GalaxyXRDriver -B ../builds/GalaxyXR-Driver/build/cmake`,
then `cmake --build ../builds/GalaxyXR-Driver/build/cmake`; staging lives under
`GalaxyXRDriver/bin/linux64/` in that external tree.

## Focused verification and CI

- GUI logic: from `GalaxyXRDriverGUI/`, run `npm test`; target Vitest files for a
  narrow domain/service/state change. `npm run build:ui` checks frontend types
  and bundling without building the native driver.
- Native logic: matching `tools/Test-*.ps1` wrappers compile standalone tests in
  `GalaxyXRDriver/tests/`. Inspect input sources/defines first; wrappers configure
  the compiler and external outputs. Journal tests deliberately omit live writes.
  The NVENC (`Test-NvencToggle`, `Test-NvencPostPackOrder`), Game Link layout
  (`Test-GameLinkLayoutPolicy`), controller master disable
  (`Test-ControllerMasterPolicy`) and controller-pose (`Test-ControllerPoseEpoch`,
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
- Graph packaging: `tools/Test-CurvePreviewBrowser.cjs` exercises the production
  graph entries for all locales, live events, resizing and failed-module close
  controls. `build-tools.yml` builds the frontend and runs this plus
  `Test-CompanionBrowser.cjs` with external `build/browser-qa-tools/` dependencies.
  Explicit local `Test-CurvePreviewPackaged.cjs <exe>` exercises real OS windows
  with an existing installation and verifies settings stayed byte-identical;
  see `Docs/CompanionGraphWindow.md` for prerequisites and evidence limits.
- Bot PR approval: PR creation and release/backmerge pushes share optional
  `PR_AUTOMATION_TOKEN`. Without it GitHub requires approval for GITHUB_TOKEN
  PR events before jobs can start; push skip conditions cannot fix that gate.
- Source/input checks: `node tools/verify-build-sources.cjs`; CI adds
  `--require-tracked`. Verify fresh-checkout inputs rather than assuming ignored
  captures/caches exist.
- Release backmerge: `tools/backmerge-release.cjs` merges the exact published
  commit in a detached external worktree with explicit bot identity. Before its
  first merge, it carries the released version through `bump-version.js` to all
  seven version files; real source conflicts fail rather than favoring dev.
  Already-synced releases leave later dev prerelease versions alone. Concurrent
  dev advances retry from the fetched tip, up to three attempts. Fetch/push
  use the original checkout's credentials; it never resets the build checkout.
  `node --test tools/tests/backmerge-release.test.cjs tools/tests/workflows.test.cjs`
  checks real local Git remotes and workflow wiring without changing GitHub.
- `.github/workflows/build-tools.yml` runs tool/service/GUI tests;
  `.github/workflows/release.yml` builds both vendors and packages. Read actual
  run results before claiming CI success; dispatch/push need authorization.

## Cleanup

Follow `AGENTS.md` and `Docs/PortableBuildCleanup.md`. Preview
`tools/Move-BuildFolders.ps1` or `tools/Clean-Workspace.ps1` before applying,
inspect targets and protections, retain one verified package and report removed
bytes and skipped paths. Do not improvise recursive moves or deletes based only
on directory names.

User docs: `Docs/StreamFrame.md`, `TunerUsage.md`, `DriverUninstall.md`,
`SteamLinkTrackingCapabilities.md`, `VrlinkSettingsRouting-2026-09-23.md`,
`tools/PORTABLE_BUILD.md`, `README.md`.

## Delegation

OpenCode reads `.opencode/agents/*.md`, Codex `.codex/agents/*.toml`, Cursor
`.cursor/rules/project.mdc`, and Hermes `.agents/skills/`. Read
[the cavecrew skill](../../cavecrew/SKILL.md) for role contracts and output
formats. Children start with fresh context and cannot ask questions: paste the
role, exact paths, evidence and authorization into each call. The parent re-reads
cited lines and reruns the checks.
