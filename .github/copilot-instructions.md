# GalaxyXR-Driver — Copilot context

Read [AGENTS.md](../AGENTS.md) as the repository contract. This checkout owns the C++17 SteamVR driver in `GalaxyXRDriver/` and the TypeScript/Lit/Fluent UI/Tauri Companion in `GalaxyXRDriverGUI/`. The vendor runtime name is `GalaxyXRNative`; neutral remains `CustomHeadsetOpenVR`. This is not the Kotlin APK patch repository.

Use [.agents/skills/galaxyxr-workspace/SKILL.md](../.agents/skills/galaxyxr-workspace/SKILL.md) and its [implementation map](../.agents/skills/galaxyxr-workspace/references/project-map.md) to find owners, consumers and relevant checks. For code changes, load [.agents/skills/customheadset-gxr/SKILL.md](../.agents/skills/customheadset-gxr/SKILL.md) and the matching add/edit/fix workflow. Verify paths and symbols against current source before editing.

## Build and verification contract

- Every generated build/test/cache/package/log artifact goes to **`../builds/GalaxyXR-Driver/`** relative to checkout root: `build/`, `output/`, `gui/`, `release/`. The general convention is `../builds/<project-name>/`; never use literal `builds/project` or another project's root.
- Keep root builders, MSBuild/CMake, GUI npm/Vite/Tauri/Cargo configs, focused test runners, packaging and CI consumers aligned. Resolve from the relevant script/config location; portable instructions must not hardcode this machine's drive.
- Use focused local checks for the changed behavior. Every completed plan must run the full local portable build (`tools/Build-Portable.ps1`) before it is reported complete. Delegating to cavecrew does not waive this gate. Inspect `.github/workflows/build-tools.yml` and `release.yml` for current CI coverage; verify run/commit results before claiming CI success.
- `node build.js --vendor galaxyxr` / `--vendor neutral` stage full packages when both components run. `tools/Build-Portable.ps1` is the end-of-plan package gate; only exit 0 plus `Built test package: ...` and required DLL/manifest/Companion EXE establish a complete package. Frontend-only and driver-only results remain partial.
- Versions change through `node bump-version.js <version>`; it synchronizes native, npm, Cargo and Tauri version inputs and lockfiles. Never hand-edit versions.

## Change invariants

- Preserve both vendors, legacy MeganeX 8K / Dream Air settings and defaults parity. A setting crosses native field/default/parser, TS type/default/shared state, page control/tip/reset, consumer, localization, tests and docs.
- Existing setting semantics need mirrored versioned migrations in `GalaxyXRDriver/src/Config/ConfigLoader.cpp` and `GalaxyXRDriverGUI/src-lit/state/galaxy-settings.ts`. Upgrade exact old defaults; preserve user tuning and dated rationale comments.
- Pages delegate to `GalaxySettingsBase`. Debug Mode OFF must gate direct routes as well as tabs. New visible strings use `t(...)` and `GalaxyXRDriverGUI/src/locale/messages.xlf`; existing translations change only when requested.
- Runtime JSON/profile files remain user data under the vendor-specific AppData contract. SteamVR settings writes preserve journal ownership and restoration through native `SteamVRSettingsJournal.h` and Rust installation/cleanup code.
- `ThirdParty/` is read-only and new dependencies remain GPLv2-compatible. Its source folders named `build` or `lib` are never disposable artifacts.

## Scope and completion

Preserve unrelated working-tree edits. Implementation or review does not authorize deployment/install/uninstall, ADB/device actions, SteamVR mutation/restart, commits, pushes, manual workflow dispatch or publishing. Use explicit authorization already present in the session.

Read [Docs/PortableBuildCleanup.md](../Docs/PortableBuildCleanup.md) before migration or cleanup. Preview exact resolved targets and protections before apply. Retain one latest verified complete package; protect source, vendored inputs, runtime data, toolchains/offline caches, installed or active paths and diagnostic evidence. Standing authorization covers only the documented routine cleanup allowlist. Report changed locations, checks, evidence limits, moved/removed bytes and protected skips; static/fixture/package evidence is distinct from fresh runtime proof.

## Settings authority (2026-10-17)

Explicit codec switches and reset arrows update the saved values backing each editable field. Advanced controls may remain hidden: switching codecs must still update them, and opening Advanced Mode must show their current values. Never silently coerce, replace or ignore app-visible user settings; preserve rejected requests with a visible error. Automatic internal parameters with no app setting may be derived without rewriting user settings.
