---
name: customheadset-gxr
description: Implement and validate GalaxyXR-Driver native driver, Companion settings/UI, installation, build tooling and bug fixes. Use for code changes in this checkout; choose add-feature, edit-behavior or fix-bug.
---

# Galaxy XR implementation

Read `../../../AGENTS.md` first. It is the project contract, including the settings-authority table, artifact layout and completion gate. Use `../galaxyxr-workspace/references/project-map.md` to find the actual owner and consumers.

Select one workflow only:

- [Add a feature](workflow-add-feature.md): new controls, settings or capabilities.
- [Edit behavior](workflow-edit-behavior.md): defaults, migrations, routes, build or packaging changes.
- [Fix a bug](workflow-fix-bug.md): reproduce a concrete failure and verify the fix.

## Invariants

- Keep Galaxy XR and neutral builds, legacy MeganeX 8K / Dream Air paths, runtime identities and AppData contracts intact.
- A setting crosses `Config.h`, `ConfigLoader.cpp`, `domain/types.ts`, `driver-defaults.ts`, `GalaxySettingsBase`, the page, the runtime consumer, source XLIFF, tests and docs. Defaults must match; no unused control.
- A semantics change needs mirrored dated migrations in `ConfigLoader.cpp` and `galaxy-settings.ts`; upgrade exact old defaults only and preserve user tuning.
- SteamVR writes stay journal-owned. `ThirdParty/` is read-only. New GUI strings use `t(...)` and the source XLIFF.
- Do not bypass the settings-authority rules in `AGENTS.md`, including codec switching, reset behavior and visible failures.

## Verification

Choose focused checks for the changed behavior, then run the end-of-plan `tools/Build-Portable.ps1` gate. Keep output under `../builds/GalaxyXR-Driver/`. Report static, fixture, compilation, package, CI and runtime evidence separately.

Implementation and validation permission does not authorize deployment, installation, ADB, SteamVR restart, commit, push, workflow dispatch or release. Use only authorization already present in the conversation.

For bounded delegation, read `../../../.opencode/skills/cavecrew/SKILL.md`. Delegation never removes the full build gate or adds authorization.
