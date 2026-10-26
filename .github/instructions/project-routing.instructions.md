---
description: Route GalaxyXR-Driver work to verified native, Companion, tooling and sibling owners.
applyTo: "**/*"
---

# GalaxyXR-Driver project routing

Read [AGENTS.md](../../AGENTS.md) and [the implementation map](../../.opencode/skills/galaxyxr-workspace/references/project-map.md) before editing. This file only routes work.

- Driver behavior, hooks, pose, distortion, identity: `GalaxyXRDriver/src/` and `GalaxyXRDriver/DriverFiles/`.
- GUI types/defaults/shared settings/migrations: `GalaxyXRDriverGUI/src-lit/domain/` and `src-lit/state/galaxy-settings.ts`.
- Page views, shell, Debug Mode, shared controls: `GalaxyXRDriverGUI/src-lit/features/*-page.ts`, `src-lit/shell/app-shell.ts`, `src-lit/ui/`.
- Persistence and runtime paths: `GalaxyXRDriverGUI/src-lit/services/` plus native `GalaxyXRDriver/src/Config/ConfigLoader.cpp`.
- Installation, SteamVR ownership, process control: `GalaxyXRDriverGUI/src-tauri/src/driver_installation.rs`, `driver_installation/`, `js_api.rs`; native `SteamVRSettingsJournal.h`.
- Localization: `GalaxyXRDriverGUI/src/locale/messages.xlf`, `src-lit/locale/i18n.ts`, `src-tauri/src/i18n.rs`.
- Build/test/package/cleanup: root build scripts, `tools/`, GUI configs and `.github/workflows/`.
- Steam Link APK patching: sibling `../steamlink-patches/`, under its own guidance.
- Firmware/kernel: separate project scope; locate its owner first.

For a setting change, follow the full native-to-GUI-to-consumer chain in `AGENTS.md`; do not fix only the visible page. Generated artifacts belong under `../builds/GalaxyXR-Driver/`. Run focused checks and the end-of-plan full local build. Repository edits do not authorize deployment, SteamVR/ADB actions, commit, push, dispatch or publication.
