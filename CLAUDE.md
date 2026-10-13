# CLAUDE.md — GalaxyXR-Driver

Read [AGENTS.md](AGENTS.md) first. It is the project policy and routing source for this checkout, including vendor/runtime contracts, authority boundaries, verification and cleanup.

- Source: `GalaxyXRDriver/` (C++17) and `GalaxyXRDriverGUI/` (Lit/TypeScript/Tauri).
- All generated build/test/cache/package artifacts: **`../builds/GalaxyXR-Driver/`**, with `build/`, `output/`, `gui/` and `release/` subfolders. `project` is a placeholder; never create `builds/project`.
- Project map: [.agents/skills/galaxyxr-workspace/SKILL.md](.agents/skills/galaxyxr-workspace/SKILL.md) and its `references/project-map.md`.
- Implementation checklists: [.agents/skills/customheadset-gxr/SKILL.md](.agents/skills/customheadset-gxr/SKILL.md) and matching add/edit/fix workflow.
- Delegation when requested: [.agents/skills/cavecrew/SKILL.md](.agents/skills/cavecrew/SKILL.md), with host-specific role presets (`.codex/agents/` for Codex, `.github/agents/` for Copilot, the role contracts in the skill itself for Hermes `delegate_task`). Delegation does not authorize a full local build or deployment.

Use focused local checks by default and GitHub for full builds. Preserve unrelated source work, vendored inputs and runtime data. Read [Docs/PortableBuildCleanup.md](Docs/PortableBuildCleanup.md) before migration/cleanup; preview exact targets and protections before applying. Do not duplicate the full policy here or follow stale historical paths in diagnostic documents as current build instructions.
