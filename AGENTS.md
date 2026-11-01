# AGENTS.md — GalaxyXR-Driver

Read `../AGENTS.md` workspace rules. This is the project contract. Edit canonical files, never mirrors.

## Identity and scope

GPLv2 SteamVR driver for Samsung Galaxy XR over Steam Link (`vrlink`), forked from sboys3/CustomHeadsetOpenVR. Galaxy XR/neutral registrations: `GalaxyXRNative`/`CustomHeadsetOpenVR`. Sources: `GalaxyXRDriver/` (C++17), `GalaxyXRDriverGUI/` (TypeScript/Lit/Fluent UI + Tauri 2). Separate runtime-identity/AppData contracts; never rename to match source folders. `ThirdParty/` is read-only.

Runtime state: vendor `%APPDATA%/GalaxyXR/CustomHeadset/`, neutral `%APPDATA%/CustomHeadset/`. Match `ConfigLoader::GetConfigFolder` and `src-lit/services/paths.ts`. `settings.json`: GUI-written, driver hot-reloaded; `info.json`: driver telemetry; `gui-settings.json`: GUI-only; named distortion profiles: `Distortion/`. All are user/runtime data, never build artifacts.

## Precedence

Highest first: user instruction; `../AGENTS.md`; this file; loaded skill/workflow; host adapter/role prompt. Lower tiers may tighten, never weaken or contradict higher tiers.

Authorized source edits/focused checks may proceed. Deployment, install/uninstall, SteamVR settings or process changes, ADB/device actions, commits, pushes, release publication and manual workflow dispatch require explicit authorization. Implementation edits do not authorize execution. Separate inherited CI triggers.

## Behavior invariants

1. Preserve Galaxy XR/neutral builds and coexistence. `VENDOR_GALAXYXR` selects native identity; GUI `VENDOR` must match. Never hardcode vendor-selected runtime names.
2. Preserve upstream MeganeX 8K / Dream Air behavior, `meganeX8K` / `dreamAir` settings and Driver Settings page.
3. New/changed settings require the full chain: `GalaxyXRDriver/src/Config/Config.h`, `ConfigLoader.cpp`, `GalaxyXRDriverGUI/src-lit/domain/types.ts`, `driver-defaults.ts`, `state/galaxy-settings.ts`, the relevant page, the driver consumer, source XLIFF and tests/docs. Match defaults; no unused controls. Each numeric control declares one spec in `GalaxyXRDriverGUI/src-lit/domain/control-specs.ts` (range, step, unit, integer, sentinel, capability codec/GPU, gate, order, degenerate guard); pages render from it and `npm test` fails an undeclared control. Sliders guide; wider native contracts require another control. Restart-only tips say **"Requires a SteamVR restart."**
4. Settings-semantics changes need matching dated, versioned migrations in `ConfigLoader.cpp` and `galaxy-settings.ts`. Upgrade exact old defaults only; preserve user tuning.
5. Keep SteamVR `settings.vrjson` writes ownership-safe through `SteamVRSettingsJournal.h` and Rust `driver_installation*` cleanup paths.
6. New visible text uses `t(...)` and `GalaxyXRDriverGUI/src/locale/messages.xlf`. Do not hand-edit `zh-Hant` or `ja` unless requested.
7. Static source/package checks prove only what they test. Runtime claims need fresh matching process/module/build evidence.

## Settings authority

User settings are authoritative. Never silently coerce, clamp per codec, or substitute defaults in runtime code, caps/NVENC overrides or load-time stamps.

Only two actions write Stream Frame per-codec optimized defaults: codec switching applies its row immediately (tile, bandwidth, Force CBR, Frame Size Cap, Keyframe Size Budget, Multi-Engine Encoding); per-row reset arrow applies it manually. Thereafter values stay user-owned and must equal editable fields. Codec switching updates Advanced settings even with Advanced Mode off; opening it shows current values without auto-revealing the section.

| Control | Default / rule |
| --- | --- |
| Lifted-Blacks Fix (`streamFrame.postPack.limitedRange`) | Off for all codecs; reset Off |
| Force CBR | Off for all codecs; reset Off |
| Multi-Engine Encoding | On (driver-chosen strips) for all codecs; reset On |
| SDR 10-bit baseline | On; H.264 turns it Off/disabled, logs it and suppresses the `supports10bit` request; HEVC or AV1 restore On |
| `galaxyXr.profileSupports10bit` | User-owned; never rewritten by codec selection |
| Image Enhancements | On; independent of 10-bit baseline; never disables its switch |
| Hybrid Fovea | Default Off; separate page requires saved Advanced Mode On, which only unlocks access. Save Hybrid Off before disabling Advanced; Companion startup/confirmed reloads with Advanced Off reconcile Hybrid Off. Preserve all other Hybrid tuning; report failures. |
| H.264 tile | 1024x4096 negotiated class; other codecs use the 1536 class |

Selected codecs must run; no codec-to-codec fallback. Selection failures must show NVENC status and request in logs plus the evidence row. Capability-forced outcomes stay visible in driver logs and honest UI, never downgraded. Except for Hybrid Advanced-access above, only dated, versioned migrations may rewrite, covering never-set values only.

## External artifacts

All generated output (compiler/cache/toolchain files, test executables/fixtures, frontend bundles, packages, build logs) belongs under `../builds/GalaxyXR-Driver/` from this checkout. Use `build/`, `output/`, `gui/` and `release/`. Never create `build/`, `dist/`, `target/` or compiler caches in source.

Resolve paths from repository/script roots, never caller working directories. Portable scripts must not hardcode machine drives. Never relocate vendored source directories `build`, `lib` or `output`. Align `build.js`, `Directory.Build.*`, CMake, npm/Vite/Tauri/Cargo configs, packaging, test runners and CI consumers.

## Verification

**End-of-plan gate:** run `powershell -NoProfile -ExecutionPolicy Bypass -File tools/Build-Portable.ps1`. Completion requires exit 0, output `Built test package: ...`, and a package containing driver DLL, manifest and Companion EXE. Focused checks never replace this gate.

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

CI: `.github/workflows/build-tools.yml` runs tool/service/GUI tests; `release.yml` only builds both vendors/packages, without unit, Rust, service or NVENC suites. Unrun commits have no CI proof; run relevant suites locally. `node build.js` staging is partial validation.

## Cleanup

Follow `Docs/PortableBuildCleanup.md`. After artifact-producing tasks, retain one latest verified complete package total and run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/Clean-Workspace.ps1 -KeepPackage output/<verified-package>
```

Preview/inspect allowlist and protections, then add `-Apply`. Standing authorization covers the documented allowlist after a verified build; unknown paths need individual review. Preserve source, uncommitted work, `.git`, `.github`, `.agents`, `.codex`, `ThirdParty`, runtime settings/profiles, installed drivers, journals, diagnostic evidence, toolchains, offline dependencies and `node_modules`. Refuse links, tracked files, active processes and registered-driver paths. Never run blanket `git clean -xfd` or delete all of `build/`. Report removed bytes, retained package and protected skips.

## Navigation/delegation

Load `.opencode/skills/galaxyxr-workspace/SKILL.md` and `references/project-map.md` for owners/execution paths; `.opencode/skills/customheadset-gxr/SKILL.md` plus matching add/edit/fix workflow for implementation. Bounded delegation uses `.opencode/skills/cavecrew/SKILL.md`; the workspace copy has the same contract. Main thread must re-read child-cited lines and rerun checks; summaries are self-reports. Delegation adds no build, deployment, commit or push authorization.

## Reporting

Report changes, checks/results, limits, cleanup evidence/protected skips. Cite absolute `file:line` for technical claims. Separate static/fixture, compilation, package, CI and fresh runtime evidence. Completion requires all required checks and authorized work.
