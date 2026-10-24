---
name: galaxyxr-workspace
description: Navigate the GalaxyXR-Driver repository using its driver, Companion, settings, installation, build, test and cleanup map. Use for work in this checkout; do not apply its paths to adjacent Steam Link patches or firmware projects.
---

# Galaxy XR workspace

Read `../../../AGENTS.md` first. This skill routes work; it does not restate project policy.

## Find the relevant chain

1. Inspect `git status --short` and use `rg --files` / targeted `rg -n` to verify current paths and symbols. The map is a routing aid, not proof of current behavior.
2. Read the affected section of [the project map](references/project-map.md). Follow settings from native defaults/parser through GUI types, defaults, shared state, page binding and runtime consumption. Follow installation through the Rust backend, ownership journal and runtime confirmation.
3. For a feature, behavior change or bug fix, load [customheadset-gxr](../customheadset-gxr/SKILL.md) and the matching workflow. Load `cavecrew` only when delegation is requested and give each writer disjoint files.
4. Pick focused checks that exercise the changed behavior. Report command outcomes and limitations separately from source inspection, package checks, CI and live headset evidence.

## Focused native runners

The portable toolchain provides the C/C++ compiler, not MSBuild. `node build.js` staging needs Visual Studio; the full portable build is the end-of-plan gate. Know each focused runner's compile surface:

- `Test-NvencToggle.ps1` compiles `NvencToggleTest.cpp`, which includes the tap source; it does not compile FrameProcessor, ConfigLoader or Headsets consumers.
- `Test-ToggleMigrations.ps1` extracts the `ConfigLoader::ParseConfig` body; serialization, info emit and watchers are not compiled.
- `Test-CasActivation.ps1` / `Test-HitchDiagnostics.ps1` compile `FrameProcessor.cpp` / `EyeActivity.cpp` against link substitutes; a new external call missing from the substitutes is a link failure, not a silent skip.
- Controller-pose runners compile the named tests and extracted provider methods; they do not replace a full driver build.

A green receipt proves only its compiled subset. Reconcile shared consumers in the main thread and let CI provide cross-translation-unit verification.

## Boundaries

- All generated output belongs under `../builds/GalaxyXR-Driver/`. Resolve from the repository root, not the shell's working directory. Keep MSBuild, CMake, Cargo, Vite/Vitest, Tauri, packaging, tests and CI aligned.
- Preserve settings, profiles, migrations, installed drivers, SteamVR journals and diagnostic captures. SteamVR writes use the native/Rust ownership journal; never replace them with direct edits.
- `ThirdParty/` is read-only. New code and dependencies remain GPLv2-compatible. New GUI text uses `t(...)` and the source XLIFF.
- Builds do not authorize deployment, driver switching, SteamVR restart, headset/ADB commands, commits, pushes or workflow dispatch. Use authorization already present in the conversation.
- Static code, historical JSON and saved captures cannot establish live NVENC or headset behavior. Runtime claims need fresh PID-matched telemetry and loaded module path/hash evidence.

The settings-authority rules, including codec-switch/reset behavior and visible failures, are in `AGENTS.md`. Follow that table rather than copying it here.
