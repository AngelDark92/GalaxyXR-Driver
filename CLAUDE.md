# CLAUDE.md — GalaxyXR-Driver

Read [AGENTS.md](AGENTS.md) first. It is the canonical project policy; this file adds no policy of its own.

- Source: `GalaxyXRDriver/` (C++17) and `GalaxyXRDriverGUI/` (Lit/TypeScript/Tauri).
- Artifacts: `../builds/GalaxyXR-Driver/` with `build/`, `output/`, `gui/` and `release/`.
- End-of-plan gate: `tools/Build-Portable.ps1`; focused checks come first.
- Skills: `.opencode/skills/galaxyxr-workspace/` for the map, `.opencode/skills/customheadset-gxr/` for implementation, `.opencode/skills/cavecrew/` for delegation.
- Commit, push, deploy, SteamVR/ADB actions, release and workflow dispatch need explicit authorization.
