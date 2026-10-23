# CLAUDE.md — GalaxyXR-Driver

Read [AGENTS.md](AGENTS.md) first. It is the project policy and routing source for this checkout, including vendor/runtime contracts, authority boundaries, verification and cleanup.

- Source: `GalaxyXRDriver/` (C++17) and `GalaxyXRDriverGUI/` (Lit/TypeScript/Tauri).
- All generated build/test/cache/package artifacts: **`../builds/GalaxyXR-Driver/`**, with `build/`, `output/`, `gui/` and `release/` subfolders. `project` is a placeholder; never create `builds/project`.
- Project map: [.opencode/skills/galaxyxr-workspace/SKILL.md](.opencode/skills/galaxyxr-workspace/SKILL.md) and its `references/project-map.md`.
- Implementation checklists: [.opencode/skills/customheadset-gxr/SKILL.md](.opencode/skills/customheadset-gxr/SKILL.md) and matching add/edit/fix workflow.
- Delegation when requested: [.opencode/skills/cavecrew/SKILL.md](.opencode/skills/cavecrew/SKILL.md), with `.opencode/agents/` for OpenCode, `.codex/agents/` for Codex and `.cursor/rules/project.mdc` for Cursor; Hermes uses the role contracts in the skill. Delegation does not remove the end-of-plan full local build or authorize deployment.

Use focused local checks for changed behavior and run the full local portable build (`tools/Build-Portable.ps1`) at the end of every completed plan. Preserve unrelated source work, vendored inputs and runtime data. Read [Docs/PortableBuildCleanup.md](Docs/PortableBuildCleanup.md) before migration/cleanup; preview exact targets and protections before applying. Do not duplicate the full policy here or follow stale historical paths in diagnostic documents as current build instructions.
