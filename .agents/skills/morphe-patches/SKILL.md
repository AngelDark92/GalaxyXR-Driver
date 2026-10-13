---
name: morphe-patches
description: Route Galaxy XR driver changes that depend on Steam Link APK patches to the sibling steamlink-patches checkout. Use for cross-project host/headset compatibility; implementation follows that checkout's current skills and exact-build evidence.
---

# Steam Link integration boundary

This checkout builds a Windows SteamVR driver and Companion. Read [AGENTS.md](../../../AGENTS.md) and [the workspace map](../galaxyxr-workspace/references/project-map.md) to identify the host producer or consumer.

The sibling `../steamlink-patches/` owns APK patches. Read its current AGENTS.md and local skills before work there. Discover current Kotlin/resource paths and patcher versions there; never copy old versions or driver-specific rules into that project. A host task or read-only integration investigation does not authorize edits in a sibling checkout.

Compatibility is an exact `(versionName, versionCode)` pair. Native changes require verified size/hash and byte guards. Do not borrow neighboring layouts. Consult the target project's tried-experiment record before reviving a hypothesis. Keep static audits, CI package proof and fresh headset observations distinct.

GalaxyXR-Driver artifacts use `../builds/GalaxyXR-Driver/` and its `build/`, `output/`, `release/` and `gui/` subfolders. Other projects use their own project-named roots and documented subfolders. Never share outputs across projects.

ADB, device changes, APK install, SteamVR mutations/restarts, commits, pushes and release actions need session authorization. Report scope and evidence explicitly across host/headset boundaries.
