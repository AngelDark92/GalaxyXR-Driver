# AGENTS.md — GalaxyXR-Driver

Always-on guidance for every agent working in this checkout. Current user instructions take precedence. Read this file before edits, inspect the relevant implementation, and preserve unrelated work shown by `git status --short`. Never infer current behavior from an old diagnostic report alone.

## Project and authority

This GPLv2 project is a SteamVR driver for Samsung Galaxy XR over Steam Link (`vrlink`), forked from sboys3/CustomHeadsetOpenVR. The Galaxy XR vendor build registers `GalaxyXRNative`; the neutral build registers `CustomHeadsetOpenVR`. Source folder names are **`GalaxyXRDriver/` and `GalaxyXRDriverGUI/`**. Runtime driver names and AppData paths remain their own contracts; do not rename them to match source folders.

| Part | Technology | Source |
| --- | --- | --- |
| Driver, pose/Kalman, hooks, frame processing, distortion, identity | C++17 | `GalaxyXRDriver/src/`; packaging inputs in `GalaxyXRDriver/DriverFiles/` |
| Companion UI | TypeScript, Lit, Fluent UI v3, Vite | `GalaxyXRDriverGUI/src-lit/` |
| Native Companion operations | Rust, Tauri 2 | `GalaxyXRDriverGUI/src-tauri/` |
| Localization and generated vendor environment | XLIFF, Node | `GalaxyXRDriverGUI/src/locale/`, `GalaxyXRDriverGUI/generate-env.js` |
| Builds, checks, calibration and maintenance | PowerShell, Node, Python | root build scripts and `tools/` |
| User and maintenance documentation | Markdown | `Docs/`, `README.md` |
| Vendored dependencies | OpenVR, MinHook, NVENC, JSON, zlib, easywsclient | **`ThirdParty/` is read-only** |

Source edits and focused checks needed for an authorized task may proceed. Keep deployment/install/uninstall, SteamVR settings or process changes, ADB/device actions, commits, pushes, release publication and manual workflow dispatch explicitly authorized. Editing their implementation does not authorize executing those actions. Report inherited CI triggers separately from actions performed in this task.

## Workflows and project guidance

- Read `.agents/skills/customheadset-gxr/SKILL.md` and its matching add-feature, edit-behavior or fix-bug workflow before implementation.
- Use `.agents/skills/galaxyxr-workspace/SKILL.md` and `.agents/skills/galaxyxr-workspace/references/project-map.md` for project navigation and the build/verification map. Verify any path or behavior that may have changed.
- When cavecrew delegation is requested, read `.agents/skills/cavecrew/SKILL.md`. Host presets: Codex reads `.codex/agents/*.toml`, Copilot `.github/agents/*.md`; Hermes uses the same role contracts through `delegate_task`. Assign disjoint files to builders, aggregate findings in the main thread, and review the completed diff — a child's summary is a self-report, not verified evidence. Delegation never adds permission for builds or deployment.
- For build/CI changes, update the affected scripts/configs, consumers, tests, documentation and project guidance together. Do not maintain competing path policies in different skills.

### Agent hosts and context files

This checkout ships instructions for several agent hosts. Each host loads different files; when policy changes, update the file map, not one host's alias.

| Host | Always-loaded context | Role presets and skills |
| --- | --- | --- |
| Codex | `AGENTS.md` | `.agents/skills/` (its `agents/openai.yaml` interfaces) + `.codex/agents/*.toml` presets |
| GitHub Copilot | `.github/copilot-instructions.md`, `.github/instructions/*.instructions.md`, `.github/agents/*.md` | path-scoped instructions via `applyTo` |
| Claude Code | `CLAUDE.md` (points to `AGENTS.md`) | none in this checkout |
| Hermes | `AGENTS.md` (git-root→cwd chain) | `.agents/skills/` after `hermes skills trust`; `delegate_task` replaces host presets |

Hermes does not read `.codex/agents/`, `.github/agents/` or `.github/copilot-instructions.md`; keep their authority in `.agents/skills/` and this file. Hermes project skills load only when the session works in this checkout (or a subdirectory) and the repo root is trusted — run `hermes skills trust` from the checkout root once per machine. Hermes' hub scanner quarantines any project skill it rates dangerous (today: `caveman-compress`, flagged for its subprocess/file-I/O heuristics); the rest load, and the quarantine is a security control — do not bypass it. `delegate_task` children start with fresh context: paste the entire role contract and every needed path into each child's `context`; a preset name loads nothing. Children summarize and cannot ask questions — require the role's `ambiguous.`/`needs-confirm.` refusal instead of a guess — and the main thread re-reads cited lines and reruns the checks, because a child's summary is a self-report.

## External artifact contract (user policy, 2026-10-08)

**Every generated build output, compiler cache, test executable/fixture, frontend bundle, packaging result and build log belongs outside this checkout under `../builds/GalaxyXR-Driver/`.** On this machine the root is:

`D:\Angelo\Desktop\SteamLink-GalaxyXR-Windows-Toolkit-FULL\builds\GalaxyXR-Driver`

The general sibling-project convention is `../builds/<project-name>/`; `project` is a placeholder, never a literal folder name. Subfolders belong under the owning project's root. Resolve paths from the script/config location or explicit repository root, not from an assumed caller working directory. CI uses the same relative contract; do not hardcode this machine's `D:` path into portable scripts.

| Artifact | Location relative to artifact root |
| --- | --- |
| Native/compiler scratch, tests, toolchains, logs | `build/` (CMake: `build/cmake/`; MSBuild: `build/msbuild/`) |
| Driver intermediate distribution and Cargo target | `output/GalaxyXRDriver/`, `output/GalaxyXRDriverGUI/` |
| Portable packages | `output/GalaxyXRDriver-Test-<timestamp>/`, `output/GalaxyXRDriver-STAGING-<version>[-Galaxyxr]-Windows/` |
| Generated frontend locale JSON, dist and caches | `gui/build/`, `gui/dist/`, `gui/cache/` |
| Relocated legacy Tauri target, if present | `gui/target/` (current Cargo builds use `output/GalaxyXRDriverGUI/`) |
| Release ZIPs, checksums and release notes | `release/` |

Keep `build.js`, `Directory.Build.props/targets`, CMake, GUI npm/Vite/Tauri/Cargo configs, `tools/Build-Portable.ps1`, test runners, packaging and `.github/workflows/` aligned. A new consumer must read this layout too. Never relocate vendored source directories because they are named `build`, `lib` or `output`. Preserve `node_modules` and offline dependencies by default; generated caches inside dependency folders must use the external cache location.

## Runtime contract and invariants

The vendor build shares `%APPDATA%/GalaxyXR/CustomHeadset/` between GUI and driver; neutral uses `%APPDATA%/CustomHeadset/`. `ConfigLoader::GetConfigFolder` and `src-lit/services/paths.ts` must agree. `settings.json` is written by the GUI and hot-reloaded by the driver; `info.json` is driver output; `gui-settings.json` belongs to the GUI; named distortion profiles live in `Distortion/`. These runtime files are not build artifacts.

1. Preserve Galaxy XR and neutral builds and coexistence. `VENDOR_GALAXYXR` decides native vendor identity; GUI `VENDOR` must match. Do not hardcode one runtime name where vendor selection applies.
2. Preserve upstream MeganeX 8K / Dream Air behavior, `meganeX8K` / `dreamAir` settings and the Driver Settings page.
3. Existing setting semantics require matching versioned migrations in `GalaxyXRDriver/src/Config/ConfigLoader.cpp` and `GalaxyXRDriverGUI/src-lit/state/galaxy-settings.ts`. Upgrade exact old defaults only; preserve user tuning. Follow the dated comment convention and explain why (for example `// schema-N migration (YYYY-MM-DD) ...`).
4. SteamVR `settings.vrjson` changes must retain ownership-safe journal/restore behavior in `GalaxyXRDriver/src/Config/SteamVRSettingsJournal.h` (header-only) and `driver_installation.rs` / `driver_installation/settings_cleanup.rs`.
5. Never edit `ThirdParty/`; new code/dependencies must remain GPLv2-compatible.
6. New user-visible strings use `t(...)` and `GalaxyXRDriverGUI/src/locale/messages.xlf`. Do not hand-edit `zh-Hant` / `ja` translations unless requested.
7. Static source/package checks establish only what they actually test. Runtime claims need fresh matching process/module/build evidence; a saved `info.json` or old capture does not establish current runtime behavior.
8. No silent settings (owner policy, 2026-10-16; codec-switch clause updated same day; visible-application mantra 2026-10-17): a user-entered setting is never silently coerced, clamped per-codec, or replaced by a default — neither by driver runtime code, caps/NVENC overrides, nor load-time stamps. Two explicit user actions write per-codec optimized defaults on Stream Frame: switching the codec applies that codec's optimized values at once (tile, bandwidth, Force CBR, Frame Size Cap, Keyframe Size Budget, Multi-Engine Encoding) and the per-row reset arrows apply them manually; afterwards every value stays user-authoritative until the next explicit action. Applied values always match their editable fields. Codec switching still updates Advanced settings while Advanced Mode is off; opening Advanced Mode shows those current values without requiring the section to be revealed automatically. Per-codec optimized rows carry that codec's negotiated-carryable class (H.264 = the 1024x4096 tile the Steam Link client negotiates). Force CBR is On in every per-codec row by default (owner directive 2026-10-17, revised same day) — codec switches and reset arrows apply On, and the user can switch it off — and selecting H.264 turns the SDR 10-bit baseline off through the same baseline-off writes the Driver Settings toggle performs: its toggle reads Off and stays disabled until another codec is selected, while a saved explicit 10-bit capability request (galaxyXr.profileSupports10bit) stays user-owned. Where a driver/device capability forces an outcome, the change is visible (driver log plus honest UI state) and a capability-forced failure is surfaced, not downgraded in place. Dated, versioned migrations remain the only other permitted rewrites and cover never-set values only.

## Change routing

### New or changed user setting — complete the full chain

1. `GalaxyXRDriver/src/Config/Config.h`: field and native default.
2. `GalaxyXRDriver/src/Config/ConfigLoader.cpp`: parse, default serialization and migration if semantics change.
3. `GalaxyXRDriverGUI/src-lit/domain/types.ts`: matching TypeScript type.
4. `GalaxyXRDriverGUI/src-lit/domain/driver-defaults.ts`: default equal to the native default.
5. `GalaxyXRDriverGUI/src-lit/state/galaxy-settings.ts`: shared state, save and GUI migration; pages remain thin views over `GalaxySettingsBase`.
6. Relevant `GalaxyXRDriverGUI/src-lit/features/*-page.ts`: bind control, field tip and reset button where the existing pattern uses them. Values that require restart must say **"Requires a SteamVR restart."** in the tip.
7. Driver consumption site: apply the value where behavior occurs; do not add an unused control.
8. Source XLIFF catalog plus `t(...)`, focused regression checks, and relevant user docs (`Docs/StreamFrame.md`, `Docs/TunerUsage.md`, README settings guidance).

### Driver — paths relative to `GalaxyXRDriver/`

| Area | Files |
| --- | --- |
| Factory/registration | `src/Driver/HmdDriverFactory.cpp`, `DriverFiles/driver.vrdrivermanifest` |
| Pose/Kalman and controller motion | `src/Driver/DeviceProvider.cpp`, `src/Driver/Hooking/ControllerPoseDispatch.h` |
| Color/CAS/FXAA/dither/stationary dimming | `src/Driver/FrameProcessor.{cpp,h}` |
| Device shader replacement | `src/Driver/ShaderReplacement.{cpp,h}` |
| NVENC interception and post-pack behavior | `src/Driver/NvencTap.{cpp,h}`, `src/Driver/NvencPostPack.{cpp,h}` |
| Distortion/tuner | `src/Distortion/` |
| Galaxy XR identity and early vrlink settings | `src/Headsets/GalaxyXR.{cpp,h}`, `src/Headsets/VrlinkCapabilities.h` |
| Legacy headsets | `src/Headsets/BaseHeadset.*`, `GenericHeadset.*`, `FakeHeadset.*` |
| Settings/watch/migrate/routing | `src/Config/ConfigLoader.cpp`, `src/Config/VrlinkSettingsRouting.h` |
| SteamVR settings ownership/restore | `src/Config/SteamVRSettingsJournal.h` (header-only) |

### GUI — paths relative to `GalaxyXRDriverGUI/`

| Area | Files |
| --- | --- |
| Shared settings/state/migrations | `src-lit/state/galaxy-settings.ts`, `src-lit/domain/` |
| Page views | `src-lit/features/{driver-settings,stream-frame,distortion-profile,app-settings,about,setup,debug}-page.ts` |
| Shared controls and styles | `src-lit/ui/controls.ts`, `src-lit/ui/shared-styles.ts`, `src-lit/styles/app.css` |
| Tabs/hash routes/Debug Mode gating | `src-lit/shell/app-shell.ts` |
| Settings persistence/retired keys | `src-lit/services/driver-setting.ts` |
| Driver info polling | `src-lit/services/driver-info.ts`, `src-lit/services/pulling.ts` |
| Runtime paths | `src-lit/services/paths.ts` |
| Install/switch/uninstall/SteamVR ownership | `src-tauri/src/driver_installation.rs`, `src-tauri/src/driver_installation/`, `src-lit/services/system-diagnostic.ts` |
| Process commands | `src-tauri/src/js_api.rs`, `src-lit/platform/tauri.ts` |
| Tauri commands/entry | `src-tauri/src/lib.rs`, `src-tauri/src/main.rs` |
| Localization | `src-lit/locale/i18n.ts`, `src-tauri/src/i18n.rs`, `src/locale/messages.*.xlf` and `messages.xlf` |
| Vendor environment | `src/environment.ts`, generated `src/environment-gen.ts`, `generate-env.js` |

## Build and verification

**CI-first (user policy, 2026-09-26):** full builds run on GitHub. Use focused local checks for ordinary edits and cleanup. A cavecrew invocation does not require a full local build. Run a full local build only when explicitly requested or necessary to investigate/verify a build issue. Never claim CI passed without checking the actual run and commit.

**Build-only release CI (user policy, 2026-10-12):** `release.yml` builds both portable packages, packages the Galaxy XR ZIP and publishes; it runs no unit, Rust, service or NVENC suites. Run the relevant suites from the table below locally at the end of every task before reporting it complete. `build-tools.yml` remains the CI home for the tool/service suites and the GUI unit suite.

Commands below run from the checkout root unless stated otherwise:

| Purpose | Command and evidence |
| --- | --- |
| GUI unit tests | From `GalaxyXRDriverGUI/`: `npm test`; select relevant Vitest files when scope is narrow |
| Frontend-only compilation | From `GalaxyXRDriverGUI/`: `npm run build:ui`; proves frontend compilation, not a complete package |
| Service/UI regression checks | Relevant `node tools/Test-*.cjs`, for example `Test-GuiReadiness.cjs`, `Test-CompanionModes.cjs`, `Test-SteamVRSettingsDiff.cjs` |
| Native logic tests | Relevant `powershell -NoProfile -ExecutionPolicy Bypass -File tools/Test-*.ps1`; standalone C++17 tests are in `GalaxyXRDriver/tests/`. The NVENC, Game Link layout, controller-pose and other compile runners that release CI no longer runs are covered here |
| Rust library tests | From `GalaxyXRDriverGUI/src-tauri`: `cargo test --locked --lib`; installation, cleanup and runtime-confirmation logic. No longer part of release CI, so run it for any change reaching that crate |
| Build/migration path regression | `node --test tools/tests/external-build-paths.test.cjs`; choose other affected `tools/tests/*.test.cjs` as needed |
| Build-source preflight | `node tools/verify-build-sources.cjs` (`--require-tracked` is for committed/fresh-checkout evidence) |
| Local full portable fallback | `powershell -NoProfile -ExecutionPolicy Bypass -File tools/Build-Portable.ps1`; success requires exit 0, `Built test package: ...`, and complete driver DLL/manifest/Companion EXE |
| Standard MSBuild + GUI staging | `node build.js --vendor galaxyxr` or `--vendor neutral`; `--no-driver` / `--no-gui` are partial validation only |
| Version change | `node bump-version.js x.y.z[-tag]`; never hand-edit versions. Synchronizes Config.cpp, manifest, Tauri config, Cargo manifest/lock and npm manifest/lock |
| Linux CMake | `cmake -S GalaxyXRDriver -B ../builds/GalaxyXR-Driver/build/cmake`, then `cmake --build ../builds/GalaxyXR-Driver/build/cmake`; output is `build/cmake/GalaxyXRDriver/bin/linux64/driver_CustomHeadsetOpenVR.so` under the artifact root |
| CI | `.github/workflows/build-tools.yml` for tool compatibility, service regressions and GUI unit tests; `.github/workflows/release.yml` is build-only: neutral/vendor builds, packaging and release publication |

Choose meaningful checks matching the changed behavior. Do not write tests that merely duplicate implementation, or repeatedly broaden testing after relevant checks pass. Toolchain bootstrap/download behavior must be understood before invoking a native test script. Manual compiler success is not proof of MSBuild, Cargo or CI success.

## Artifact relocation and end-of-task cleanup

Follow `Docs/PortableBuildCleanup.md` after any artifact-producing task. Relocation and retention are different operations: preserve useful packages/caches/evidence during migration, then apply the cleanup policy only to verified eligible artifacts.

1. Preview `powershell -NoProfile -ExecutionPolicy Bypass -File tools/Move-BuildFolders.ps1` before migration; inspect the exact resolved source/destination mappings, protected paths and collisions before `-Apply`. Use native PowerShell file operations with `-LiteralPath`; never compose deletions/moves across shells. Verify every resolved target lies within the checkout or explicit artifact root. Check links, tracked files, active processes and registered drivers before moving.
2. Keep **one latest verified complete package total**, across Galaxy XR and neutral runs. Choose by successful build evidence plus DLL/manifest/EXE checks, not modification time. A partial/failed build must not evict the last full package. Preserve failed-build evidence until understood.
3. With no build/dev session or other task using candidates, preview `powershell -NoProfile -ExecutionPolicy Bypass -File tools/Clean-Workspace.ps1 -KeepPackage output/<verified-package>`. `output/...` is relative to **`../builds/GalaxyXR-Driver/`**. Inspect the allowlist/protections, then use the same command with `-Apply`. Standing user authorization covers this routine allowlisted cleanup; do not ask again.
4. Preserve source, uncommitted work, `.git`, `.github`, `.codex`, `.agents`, `ThirdParty`, user settings/profiles, SteamVR files, installed drivers, journals and diagnostic captures. Preserve external `build/toolchains`, offline dependencies, `node_modules` and small useful logs. Unknown/custom outputs and release ZIPs need individual review. Ignored files are not automatically disposable.
5. Refuse symlinks/junctions, tracked candidates, active build/process paths, registered-driver paths and targets outside the two authorized roots. Never run blanket `git clean -xfd`, remove all of `build`, or recursively remove generic `lib` folders. CI artifacts remain until downstream tests/package/upload finish.
6. Clean task-owned successful fixtures and obsolete allowlisted compiler/Cargo/package artifacts; retain failed evidence. Check the cleanup receipt, retained package and final Git diff/status. Report removed bytes and protected/skipped paths. Do not repopulate caches after final cleanup without a new verification need.

## Reporting

Cavecrew subagents return concise findings with `path:line` evidence. On Hermes, `delegate_task` children return only a final summary; treat it as a self-report until the main thread re-reads the cited lines and reruns the checks. Main thread explains the result in plain language and cites clickable absolute `file:line` links for technical claims. State what changed, relevant checks and their results, remaining limits, migration/cleanup evidence and any protected skips. Distinguish source/static checks, package validation, actual CI results and fresh runtime proof. Do not report completion while required checks or authorized work remain.
