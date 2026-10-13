# caveman-help

Quick-reference card. One shot, no mode change.

## What it does

Prints a cheat sheet of all caveman modes, sibling skills, deactivation triggers, and how to set the default mode via env var or config file. One-shot display — does not flip the active mode, write flag files, or persist anything. Use when you forget the slash commands.

## How to invoke

```
/caveman-help
```

Also triggers on "caveman help", "what caveman commands", "how do I use caveman".

## Example output

```
Modes:
  /caveman              full (default)
  /caveman lite         lighter
  /caveman ultra        extreme
  /caveman wenyan       classical Chinese

Skills:
  /caveman-commit       terse Conventional Commits
  /caveman-review       one-line PR comments
  /caveman-stats        session token savings

Deactivate:
  "stop caveman" or "normal mode"
```

Hosts: hooks and flag files are Claude Code plugin mechanisms; on Hermes, Codex and Copilot the skill is plain instructions — the mode lives in the session and deactivates the same way.

## See also

- [`SKILL.md`](./SKILL.md) — full reference card
- [Project README](../../../README.md) — GalaxyXR-Driver overview
