# GalaxyXR-Driver — Copilot context

Read [AGENTS.md](../AGENTS.md) as the canonical repository contract. This file adds Copilot pointers only.

The checkout owns the C++17 SteamVR driver in `GalaxyXRDriver/` and the TypeScript/Lit/Fluent UI/Tauri Companion in `GalaxyXRDriverGUI/`. The vendor runtime name is `GalaxyXRNative`; neutral remains `CustomHeadsetOpenVR`. This is not the Kotlin APK patch repository.

## Where to look

- Map and execution paths: [galaxyxr-workspace](../.opencode/skills/galaxyxr-workspace/SKILL.md) and [project-map.md](../.opencode/skills/galaxyxr-workspace/references/project-map.md).
- Implementation: [customheadset-gxr](../.opencode/skills/customheadset-gxr/SKILL.md) plus the matching workflow.
- Path-scoped rules: [project routing](instructions/project-routing.instructions.md) and [cross-project protocol](instructions/cross-project-protocol.instructions.md).

## Build and completion

- Generated artifacts belong under `../builds/GalaxyXR-Driver/` in `build/`, `output/`, `gui/` and `release/`; never inside the checkout.
- Focused checks cover changed behavior. Every completed plan also runs `tools/Build-Portable.ps1` and validates exit 0, `Built test package: ...`, and the driver DLL, manifest and Companion EXE.
- Verify CI against the actual commit and run. `build.js` or a frontend-only build is not a complete package.
- Commit, push, deploy, install, ADB/device actions, SteamVR mutation, release and workflow dispatch need explicit authorization.

## Invariants

- Preserve both vendors, legacy MeganeX 8K / Dream Air settings, defaults parity, versioned migrations, user tuning and SteamVR journal ownership.
- New visible strings use `t(...)` and `GalaxyXRDriverGUI/src/locale/messages.xlf`; do not hand-edit `zh-Hant` or `ja` unless requested.
- `ThirdParty/` is read-only and new dependencies remain GPLv2-compatible.
- Report static, fixture, compilation, package, CI and fresh runtime evidence separately.
