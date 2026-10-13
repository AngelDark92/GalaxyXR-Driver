---
name: caveman-stats
description: >
  Show real token usage and estimated savings for the current session.
  Reads directly from the Claude Code session log — no AI estimation.
  Triggers on /caveman-stats. Output is injected by the mode-tracker hook;
  the model itself does not compute the numbers.
---

This skill is delivered by `hooks/caveman-stats.js` (read by `hooks/caveman-mode-tracker.js` on `/caveman-stats`). The model does not need to do anything when this skill fires — the hook returns `decision: "block"` with the formatted stats as the reason. The user sees the numbers immediately.

Host behavior: the Claude Code plugin hook above is the only automatic provider of this report. A host without that hook (Hermes, Codex, Copilot, plain CLI) never receives injected stats; on those hosts report the session's own token accounting instead — Hermes: `/usage` and `/insights [days]` — or say plainly that hook-based stats are unavailable. Do not fabricate numbers.

Output also includes `Est. rule overhead` and `Est. net` lines wherever a savings estimate exists with a known turn count. Rule overhead is the estimated per-turn INPUT-token cost of the injected caveman rules (default 1,250 tokens/turn, override with `CAVEMAN_RULE_OVERHEAD_TOKENS`) times the turn count. Net is savings minus that overhead — when negative, the output says so plainly and suggests turning caveman off for that workload, rather than hiding the net-negative regime behind a gross-savings number (see `docs/HONEST-NUMBERS.md`).

## GalaxyXR-Driver checkout

Read [AGENTS.md](../../../AGENTS.md) and [the workspace map](../galaxyxr-workspace/references/project-map.md) before project work. Implementation uses [customheadset-gxr](../customheadset-gxr/SKILL.md). Generated artifacts always use `../builds/GalaxyXR-Driver/` relative to the checkout, with `build/`, `output/`, `release/` and `gui/` subfolders. Communication modes never override project scope, GitHub-first verification or existing authorization.
