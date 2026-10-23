---
name: caveman-help
description: >
  Quick-reference card for all caveman modes, skills, and commands.
  One-shot display, not a persistent mode. Trigger: /caveman-help,
  "caveman help", "what caveman commands", "how do I use caveman".
---

# Caveman Help

Display this reference card when invoked. One-shot — do NOT change mode, write flag files, or persist anything. Output in caveman style.

## Modes

| Mode | Trigger | What change |
|------|---------|-------------|
| **Lite** | `/caveman lite` | Drop filler. Keep sentence structure. |
| **Full** | `/caveman` | Drop articles, filler, pleasantries, hedging. Fragments OK. Default. |
| **Ultra** | `/caveman ultra` | Extreme compression. Bare fragments. Tables over prose. |
| **Wenyan-Lite** | `/caveman wenyan-lite` | Classical Chinese style, light compression. |
| **Wenyan-Full** | `/caveman wenyan` | Full 文言文. Maximum classical terseness. |
| **Wenyan-Ultra** | `/caveman wenyan-ultra` | Extreme. Ancient scholar on a budget. |

Mode stick until changed or session end.

## Skills

| Skill | Trigger | What it do |
|-------|---------|-----------|
| **caveman-commit** | `/caveman-commit` | Terse commit messages. Conventional Commits. ≤50 char subject. |
| **caveman-review** | `/caveman-review` | One-line PR comments: `L42: bug: user null. Add guard.` |
| **caveman-compress** | `/caveman-compress <file>` | Compress .md files to caveman prose. Saves ~46% input tokens. |
| **caveman-help** | `/caveman-help` | This card. |

## Deactivate

Say "stop caveman" or "normal mode". Resume anytime with `/caveman`.

## Language

Keep user's language by default. User write Portuguese → reply Portuguese caveman. Compress the style, not the language. Technical terms, code, commands, commit types, and exact error strings stay verbatim unless user ask for translation.

## Configure Default Mode

Default mode = `full`. Change it:

**Environment variable** (highest priority):
```bash
export CAVEMAN_DEFAULT_MODE=ultra
```

**Config file** (`~/.config/caveman/config.json` macOS/Linux, `%APPDATA%\caveman\config.json` Windows):
```json
{ "defaultMode": "lite" }
```

Set `"off"` to disable auto-activation on session start. User can still activate manually with `/caveman`.

Resolution: env var > config file > `full`.

`/caveman status` is answered from the host: with the Claude Code mode-tracker hook present, relay its `Caveman mode: <mode>` value; on a host without hooks (Hermes, Codex, Copilot) report the mode followed before the command, or `off` if caveman was never active, plus `(not tracked by this host)`. Never infer a mode from the configured default.

## Hosts

The hooks, flag files and statusline badge above are Claude Code plugin mechanisms. On other hosts (Hermes, Codex, Copilot) this skill is plain instructions: activation happens when the user's message invokes it, mode persists in the session, and nothing reads a `config.json` or writes flag files automatically — the env var / config file above apply only where the plugin runs. On Hermes, `/caveman` loads via the skill-command mechanism and the mode is session-scoped.

## More

Full docs: https://github.com/JuliusBrussee/caveman

## GalaxyXR-Driver checkout

Read [AGENTS.md](../../../AGENTS.md) and [the workspace map](../galaxyxr-workspace/references/project-map.md) before project work. Implementation uses [customheadset-gxr](../customheadset-gxr/SKILL.md). Generated artifacts always use `../builds/GalaxyXR-Driver/` relative to the checkout, with `build/`, `output/`, `release/` and `gui/` subfolders. Communication modes never override project scope, the end-of-plan local build/verification or existing authorization.
