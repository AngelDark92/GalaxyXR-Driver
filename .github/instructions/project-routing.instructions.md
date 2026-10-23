---
description: Route GalaxyXR-Driver work to verified native, Companion, tooling and sibling integration owners.
applyTo: "**/*"
---

# GalaxyXR-Driver project routing

Read [AGENTS.md](../../AGENTS.md) and [the implementation map](../../.agents/skills/galaxyxr-workspace/references/project-map.md). Paths below are relative to checkout root.

| Work | Owner |
| --- | --- |
| OpenVR registration, hooks, frame processing, pose/Kalman, distortion, headset identity | `GalaxyXRDriver/src/` and `GalaxyXRDriver/DriverFiles/` |
| GUI types/defaults/shared settings/migrations | `GalaxyXRDriverGUI/src-lit/domain/`, `src-lit/state/galaxy-settings.ts` |
| Thin page views, tabs/Debug Mode, shared controls/styles | `GalaxyXRDriverGUI/src-lit/features/*-page.ts`, `src-lit/shell/app-shell.ts`, `src-lit/ui/` |
| Settings/info persistence and runtime paths | `GalaxyXRDriverGUI/src-lit/services/` plus native `GalaxyXRDriver/src/Config/ConfigLoader.cpp` |
| Installation/SteamVR settings ownership/process control | `GalaxyXRDriverGUI/src-tauri/src/driver_installation.rs`, `driver_installation/`, `js_api.rs`; native `GalaxyXRDriver/src/Config/SteamVRSettingsJournal.h` |
| Localization | `GalaxyXRDriverGUI/src/locale/messages.xlf`, `src-lit/locale/i18n.ts`, `src-tauri/src/i18n.rs` |
| Build/test/package/cleanup | root build/config scripts, `tools/`, GUI configs and `.github/workflows/` |
| Steam Link APK Kotlin/resource/native patching | Sibling `../steamlink-patches/`, under its current guidance; cross-project edits need task authorization |
| Firmware/kernel | Separate project scope; discover its actual owner instead of treating driver source as firmware tooling |

For implementation choose the matching workflow in [.agents/skills/customheadset-gxr/SKILL.md](../../.agents/skills/customheadset-gxr/SKILL.md). If a setting changes, follow the full native-to-GUI-to-consumer chain in AGENTS.md; do not fix only the visible page.

All generated artifacts belong to **`../builds/GalaxyXR-Driver/`**, using `build/`, `output/`, `gui/` and `release/` subfolders. Build scripts, caches, test output, packaging and CI paths must agree. Runtime identities/AppData folders and vendored source names are separate contracts. Never move source because a folder is named `build`.

Use focused local checks and run the full local portable build at the end of every completed plan. Preserve unrelated source edits, vendored dependencies, runtime data, diagnostic captures and offline tools. Migration/cleanup follows the documented preview/guards/allowlist. Repository edits do not authorize deployment, SteamVR/ADB actions, commit/push, dispatch or publication.

## Settings authority (2026-10-17)

Explicit codec switches and reset arrows update the saved values backing each editable field. Advanced controls may remain hidden: switching codecs must still update them, and opening Advanced Mode must show their current values. Never silently coerce, replace or ignore app-visible user settings; preserve rejected requests with a visible error. Automatic internal parameters with no app setting may be derived without rewriting user settings.
