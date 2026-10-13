# Cavecrew for GalaxyXR-Driver

Use investigator, builder and reviewer roles for bounded delegated work with
compact source citations. The main thread chooses scope and synthesizes findings.

- [Investigator](../../../.codex/agents/cavecrew-investigator.toml): read-only symbol and execution-path discovery.
- [Builder](../../../.codex/agents/cavecrew-builder.toml): one or two assigned files and focused authorized checks.
- [Reviewer](../../../.codex/agents/cavecrew-reviewer.toml): read-only concrete diff findings.

Read [SKILL.md](SKILL.md) for selection, chaining and output contracts. Codex
project roles live in `.codex/agents/*.toml` (Copilot presets: `.github/agents/*.md`);
this checkout does not require Claude Code plugins, Anthropic model names or
model-override environment variables.
Use the current session's model unless the user or applicable role instructions
request another supported model. When manually spawning with collaboration
tools, supply the selected role instructions and explicit file ownership.
On Hermes: trust the checkout once with `hermes skills trust`, then delegate
with `delegate_task` — children inherit the session model, get fresh context,
and need the role contract from SKILL.md's [Delegate on Hermes](SKILL.md#delegate-on-hermes)
section pasted into each child's `context`. The parent verifies their receipts.

Project routing and execution guidance:

- [Repository contract](../../../AGENTS.md)
- [Workspace map](../galaxyxr-workspace/references/project-map.md)
- [Implementation workflows](../customheadset-gxr/SKILL.md)
- [Project README](../../../README.md)

Artifacts belong under `../builds/GalaxyXR-Driver/`, with `build/`, `output/`,
`release/` and `gui/` subfolders. Focused local checks are preferred; full builds
are GitHub-first. Delegation does not authorize deployment, device actions,
SteamVR restart, commits, pushes or workflow dispatch.
