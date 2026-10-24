---
description: Preserve the Steam Link host/headset contract and exact APK compatibility at the GalaxyXR-Driver boundary.
applyTo: "**/*.{h,hpp,c,cc,cpp,rs,ts,json,md,py,ps1,cjs,mjs}"
---

# Host/headset integration

Read [AGENTS.md](../../AGENTS.md), [the implementation map](../../.opencode/skills/galaxyxr-workspace/references/project-map.md) and [the Morphe skill](../../.agents/skills/morphe-patches/SKILL.md) when host behavior depends on APK patches. This checkout implements the SteamVR driver/Companion; the sibling `../steamlink-patches/` owns Steam Link APK patching.

1. Trace the actual producer and consumer in `GalaxyXRDriver/src/Driver/`, `src/Headsets/GalaxyXR.*`, `src/Config/VrlinkSettingsRouting.h` and the relevant GUI settings. Do not assume a shared protocol exists.
2. Record units, coordinate conventions, timing sources, settings keys, failure behavior and any schema/version field. Keep SteamVR keys journal-owned; do not silently change field meanings.
3. Treat APK compatibility as an exact `(versionName, versionCode)` pair. Native byte changes require exact file size/hash and original/already-patched guards. Do not reuse offsets from another build.
4. If a contract changes, handle compatibility and migrations at every consumer. Do not invent a protocol-version field where none exists. Preserve user tuning and vendor/legacy behavior.
5. Run focused checks for the implementation and keep artifacts under the owning project's external root. Run the end-of-plan full local build.
6. Report static/byte audits, fixture checks, package/CI validation and fresh headset/SteamVR observations separately. Missing device evidence is an explicit limit.

ADB, APK install, deployment, SteamVR mutation, commit, push, dispatch and publication need session authorization.
