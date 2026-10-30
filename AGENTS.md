# AGENTS.md — GalaxyXR-Driver

Read `../AGENTS.md` for workspace rules. This file is the project contract for this checkout. User instructions override both. Edit a canonical file, never a mirror.

## Identity and scope

This GPLv2 project is a SteamVR driver for Samsung Galaxy XR over Steam Link (`vrlink`), forked from sboys3/CustomHeadsetOpenVR. The Galaxy XR vendor build registers `GalaxyXRNative`; the neutral build registers `CustomHeadsetOpenVR`. Source roots are `GalaxyXRDriver/` (C++17) and `GalaxyXRDriverGUI/` (TypeScript/Lit/Fluent UI + Tauri 2). Runtime identities and AppData paths are separate contracts; never rename them to match source folders. `ThirdParty/` is read-only.

Vendor runtime state is `%APPDATA%/GalaxyXR/CustomHeadset/`; neutral is `%APPDATA%/CustomHeadset/`. `ConfigLoader::GetConfigFolder` and `src-lit/services/paths.ts` must agree. `settings.json` is GUI-written and driver hot-reloaded; `info.json` is driver telemetry; `gui-settings.json` is GUI-only; named distortion profiles live in `Distortion/`. These are user/runtime data, never build artifacts.

## Authority and precedence

1. User instruction.
2. `../AGENTS.md` cross-project safety rules.
3. This file.
4. The loaded skill or workflow.
5. A host adapter or role prompt.

A lower tier may add stricter rules; it may not weaken or contradict a higher tier.

Source edits and focused checks for an authorized task may proceed. Deployment, install/uninstall, SteamVR settings or process changes, ADB/device actions, commits, pushes, release publication and manual workflow dispatch require explicit authorization. Editing their implementation does not authorize executing them. Report inherited CI triggers separately.

## Runtime and behavior invariants

1. Preserve Galaxy XR and neutral builds and coexistence. `VENDOR_GALAXYXR` selects native vendor identity; GUI `VENDOR` must match. Do not hardcode one runtime name where vendor selection applies.
2. Preserve upstream MeganeX 8K / Dream Air behavior, `meganeX8K` / `dreamAir` settings and the Driver Settings page.
3. For a new or changed setting, complete the chain: `GalaxyXRDriver/src/Config/Config.h`, `ConfigLoader.cpp`, `GalaxyXRDriverGUI/src-lit/domain/types.ts`, `driver-defaults.ts`, `state/galaxy-settings.ts`, the relevant page, the driver consumer, source XLIFF and tests/docs. Defaults must match; do not add an unused control. Every numeric control declares one spec in `GalaxyXRDriverGUI/src-lit/domain/control-specs.ts` (range, step, unit, integer, sentinel, capability codec/GPU, gate, order, degenerate guard); pages render from it and `npm test` fails an undeclared control. A slider is guidance, never the only control where the native contract is wider. A restart-only tip says **"Requires a SteamVR restart."**
4. A settings-semantics change needs matching dated, versioned migrations in `ConfigLoader.cpp` and `galaxy-settings.ts`. Upgrade exact old defaults only; preserve user tuning.
5. SteamVR `settings.vrjson` writes stay ownership-safe through `SteamVRSettingsJournal.h` and the Rust `driver_installation*` cleanup paths.
6. New visible strings use `t(...)` and `GalaxyXRDriverGUI/src/locale/messages.xlf`. Do not hand-edit `zh-Hant` or `ja` unless requested.
7. Static source/package checks prove only what they test. Runtime claims need fresh matching process/module/build evidence.

## Settings authority (owner policy)

A user-entered setting is authoritative. Never silently coerce, clamp per codec, or replace it with a default in runtime code, caps/NVENC overrides or load-time stamps.

Only two actions write per-codec optimized defaults on Stream Frame: switching the codec applies its row at once (tile, bandwidth, Force CBR, Frame Size Cap, Keyframe Size Budget, Multi-Engine Encoding); the per-row reset arrow applies it manually. Afterwards every value stays user-owned. Applied values must equal the editable fields. Codec switching updates Advanced settings even while Advanced Mode is off; opening it shows the current values without auto-revealing the section.

| Control | Default / rule |
| --- | --- |
| Lifted-Blacks Fix (`streamFrame.postPack.limitedRange`) | Off in every codec; reset restores Off |
| Force CBR | Off in every codec; reset restores Off |
| Multi-Engine Encoding | On (driver-chosen strips) in every codec; reset restores On |
| SDR 10-bit baseline | On; H.264 turns it Off/disabled, logs it and suppresses the `supports10bit` request; HEVC or AV1 restore On |
| `galaxyXr.profileSupports10bit` | User-owned; never rewritten by codec selection |
| Image Enhancements | On; independent of the 10-bit baseline and never disables its switch |
| H.264 tile | 1024x4096 negotiated class; other codecs use the 1536 class |

Selected codecs are running codecs: no codec-to-codec fallback. A failed selection fails loudly with NVENC status and request in the log plus the evidence row. Capability-forced outcomes stay visible (driver log plus honest UI), never downgraded. Dated, versioned migrations are the only other permitted rewrites and cover never-set values only.

## External artifacts

All generated output — compiler/cache/toolchain files, test executables and fixtures, frontend bundles, packages and build logs — belongs under `../builds/GalaxyXR-Driver/` relative to this checkout. Use `build/`, `output/`, `gui/` and `release/`. Never create `build/`, `dist/`, `target/` or compiler caches in source. Runtime `%APPDATA%` files are not build artifacts.

Resolve paths from the repository/script root, never from a caller's working directory. Portable scripts must not hardcode a machine drive. Never relocate vendored source directories named `build`, `lib` or `output`; `ThirdParty/` is immutable. Keep `build.js`, `Directory.Build.*`, CMake, npm/Vite/Tauri/Cargo configs, packaging, test runners and CI consumers aligned.

## Build and verification

**End-of-plan gate:** run `powershell -NoProfile -ExecutionPolicy Bypass -File tools/Build-Portable.ps1`. Complete only if it exits 0, prints `Built test package: ...`, and the package contains the driver DLL, manifest and Companion EXE. Focused checks do not replace this gate.

| Purpose | Command |
| --- | --- |
| GUI unit tests | `cd GalaxyXRDriverGUI; npm test` |
| Frontend compile | `cd GalaxyXRDriverGUI; npm run build:ui` (not a package) |
| Service/UI regressions | relevant `node tools/Test-*.cjs` |
| Native logic | relevant `powershell -NoProfile -ExecutionPolicy Bypass -File tools/Test-*.ps1`; standalone tests in `GalaxyXRDriver/tests/` |
| Rust library | `cd GalaxyXRDriverGUI/src-tauri; cargo test --locked --lib` |
| Build/path regressions | `node --test tools/tests/*.test.cjs` |
| Source preflight | `node tools/verify-build-sources.cjs` |
| Version change | `node bump-version.js x.y.z[-tag]`; never hand-edit versions |

CI: `.github/workflows/build-tools.yml` runs tool/service/GUI tests; `release.yml` only builds both vendors and packages — no unit, Rust, service or NVENC suites. CI is not proof for an unrun commit; run the relevant suites locally. `Build-Portable.ps1` is the local package gate; `node build.js` staging is partial validation only.

## Cleanup

Follow `Docs/PortableBuildCleanup.md`. After any artifact-producing task, retain one latest verified complete package total and run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/Clean-Workspace.ps1 -KeepPackage output/<verified-package>
```

Preview and inspect the allowlist/protections, then add `-Apply`. Standing authorization covers the documented allowlist after a verified build; unknown paths still need individual review. Preserve source, uncommitted work, `.git`, `.github`, `.agents`, `.codex`, `ThirdParty`, runtime settings/profiles, installed drivers, journals, diagnostic evidence, toolchains, offline dependencies and `node_modules`. Refuse links, tracked files, active processes and registered-driver paths. Never run blanket `git clean -xfd` or delete all of `build/`. Report removed bytes, retained package and protected skips.

## Navigation and delegation

Load `.opencode/skills/galaxyxr-workspace/SKILL.md` and `references/project-map.md` for owners and execution paths; `.opencode/skills/customheadset-gxr/SKILL.md` with the matching add/edit/fix workflow for implementation. Use `.opencode/skills/cavecrew/SKILL.md` for bounded delegation; the workspace copy carries the same contract. A child's summary is a self-report until the main thread re-reads the cited lines and reruns the checks. Delegation never adds build, deployment, commit or push authorization.

## Reporting

State what changed, checks and results, remaining limits, cleanup evidence and protected skips. Cite absolute `file:line` for technical claims. Separate static/fixture, compilation, package, CI and fresh runtime evidence. Do not report complete while required checks or authorized work remain.
