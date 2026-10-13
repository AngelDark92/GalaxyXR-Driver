---
name: galaxyxr-workspace
description: Navigate and maintain the GalaxyXR-Driver repository using its driver, Companion, settings, installation, build, test and cleanup map. Use for work in this checkout, especially changes spanning native code, GUI or build tooling; do not apply its paths to adjacent Steam Link patches or firmware projects.
---

# Galaxy XR workspace

Use this skill to find the complete implementation chain before editing this
repository. The source trees are `GalaxyXRDriver/` and `GalaxyXRDriverGUI/`.
The native Galaxy XR driver is `GalaxyXRNative`; the neutral build retains the
`CustomHeadsetOpenVR` runtime identity. Folder names and runtime names differ.

## Find the relevant chain

1. Read the checkout's `AGENTS.md` and inspect `git status --short` so existing
   work remains intact. Use `rg --files` and targeted `rg -n` searches to verify
   current paths and symbols before editing; the reference is a routing map,
   not proof of current behavior.
2. Read [the project map](references/project-map.md) for the affected area.
   Follow a setting from native defaults and parser through GUI types, defaults,
   shared state, page binding and its runtime consumer. Follow installation
   behavior through the Rust backend, ownership journal and runtime verification.
3. For a feature, behavior change or bug fix, load
   [customheadset-gxr](../customheadset-gxr/SKILL.md) and its matching workflow.
   Load `cavecrew` when delegation is requested; give each agent explicit file
   ownership and ask for compact `path:line` evidence.
4. Pick focused verification that exercises changed behavior. Report command
   outcomes and limitations separately from source inspection, package checks,
   GitHub CI and live headset evidence. Cite current `file:line` evidence in the
   main result; a passing mocked browser test is not a native/runtime test.

## External artifacts are part of the contract

All generated compiler output, packages, frontend bundles, test fixtures, caches,
toolchains and release artifacts belong under `../builds/GalaxyXR-Driver/`
relative to this checkout. On this machine the root is:

`D:\Angelo\Desktop\SteamLink-GalaxyXR-Windows-Toolkit-FULL\builds\GalaxyXR-Driver`

Resolve this path from the repository root, not the shell's working directory.
Scripts inside `GalaxyXRDriverGUI/` use `../../builds/GalaxyXR-Driver/`; nested
consumers must account for their own base directory. Keep MSBuild, CMake, Cargo,
Vite/Vitest, Tauri, packaging, test helpers and CI upload consumers aligned.
Use the package scripts' `--configLoader runner` for Vite/Vitest so loading
configuration does not recreate `node_modules/.vite-temp` in the checkout.
Cargo target output and Tauri build-helper scratch remain external; the stable
editor schema location is `gui/schemas/` beneath the artifact root. See the map's
build section before changing those paths.
The literal word `project` is not a directory in this layout. Another project
uses its own project name beneath the shared `builds/` parent.

Keep source, `.agents/`, `.github/`, `ThirdParty/` and dependency source inputs
inside the checkout. A vendored source directory named `build` is not an
artifact. Preserve `node_modules` and offline dependency/toolchain caches during
routine cleanup. Do not create an in-checkout junction to the external root.

Full builds are GitHub-first. Run a full local build only when the user requests
it or a build issue requires it. Do not claim a GitHub run passed without reading
its actual result. At the end of artifact-producing work, follow
`Docs/PortableBuildCleanup.md`: retain one verified complete package, preview
`tools/Clean-Workspace.ps1 -KeepPackage output/<verified-package>`, inspect the
plan, then apply its allowlist. The package argument is relative to the external
artifact root. Report removed bytes and protected/skipped paths.

## Preserve operational boundaries

- Preserve user settings, distortion profiles, migrations, installed drivers,
  SteamVR journals and diagnostic captures. For new migration semantics, change
  both native and GUI migration paths; preserve user tuning rather than broadly
  rewriting values that resemble defaults.
- SteamVR writes use the native/Rust ownership journals. Never replace them with
  direct file edits. Keep neutral and Galaxy XR builds and legacy headsets working.
- Do not modify vendored `ThirdParty/` source. New dependencies/code must remain
  GPLv2-compatible. GUI text uses `t(...)` and the source XLIFF catalog; translated
  catalogs are changed only when requested.
- Work within authorization already present in the conversation. Builds do not
  authorize deployment, driver switching, SteamVR restart, headset/ADB commands,
  commits, pushes or workflow dispatch. Obtain missing authorization only for
  the action requiring it; continue independent authorized work.
- Static code, historical JSON and saved captures cannot establish live NVENC or
  headset behavior. Runtime claims need fresh PID-matched telemetry and loaded
  module path/hash evidence. A read-only audit remains read-only when requested.
