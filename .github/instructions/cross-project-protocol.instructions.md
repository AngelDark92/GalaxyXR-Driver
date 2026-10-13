---
description: Preserve verified Steam Link host/headset contracts and exact APK compatibility at the GalaxyXR-Driver integration boundary.
applyTo: "**/*.{h,hpp,c,cc,cpp,rs,ts,json,md,py,ps1,cjs,mjs}"
---

# Host/headset integration

Read [AGENTS.md](../../AGENTS.md), [the implementation map](../../.agents/skills/galaxyxr-workspace/references/project-map.md) and [.agents/skills/morphe-patches/SKILL.md](../../.agents/skills/morphe-patches/SKILL.md) when host changes depend on APK patches. This checkout implements the SteamVR driver/Companion; the sibling `../steamlink-patches/` owns Steam Link APK patching. Locate the actual producer, consumer and implementation before assuming a shared protocol exists.

For pose, gaze, controller, timing, transport, encoder or vrlink setting changes:

1. Trace actual producers and consumers, including native `GalaxyXRDriver/src/Driver/`, `src/Headsets/GalaxyXR.*`, `src/Config/VrlinkSettingsRouting.h` and relevant GUI settings. Read sibling guidance before investigating its implementation; an integration audit does not authorize sibling edits.
2. Record exact units, coordinate conventions, timing sources, settings keys, failure behavior and any existing schema/version field. Retain ownership-safe journal behavior for SteamVR keys; avoid silently changing field meanings.
3. Treat APK compatibility as an exact `(versionName, versionCode)` pair. Native byte changes require exact file size/hash and original/already-patched guards. Do not borrow offsets/layouts from a neighboring build or revive tried experiments without consulting the sibling's current record.
4. If an existing contract changes, explicitly handle compatibility and migrations at every affected consumer. Use versioning when supported; do not invent a protocol-version field in a component that has none. Preserve user tuning and vendor/legacy behavior.
5. Run focused checks for the actual implementation, plus golden/vector tests where they exist. Keep driver artifacts under `../builds/GalaxyXR-Driver/`; sibling artifacts use their own project root and documented subfolders. Full builds use CI by default.
6. Report static source/byte audits, fixture checks, package/CI validation and fresh headset/SteamVR observations separately. Runtime claims need matching fresh process/module/build evidence. Missing device evidence remains an explicit limit.

ADB, APK install, deployment, SteamVR mutations/restarts, commits, pushes, manual dispatch and publication need session authorization. Do not introduce these actions just to complete a static integration investigation.
