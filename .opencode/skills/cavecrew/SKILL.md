---
name: cavecrew
description: Delegate bounded Galaxy XR investigation, one- or two-file edits, or diff review to compressed-output subagents. Use when delegation is requested; the main thread keeps build and authorization authority.
---

# Cavecrew

Cavecrew has three roles. OpenCode discovers them as `cavecrew-investigator`, `cavecrew-builder` and `cavecrew-reviewer` from the nearest `.opencode/agents/`. Codex uses `.codex/agents/*.toml`. Hermes runs the same contracts through `delegate_task` with the role text pasted into each child's `context`.

## Call contract

Every call states all five lines. A missing line returns `ambiguous. ask: <missing line>`.

1. **Role** — investigator, builder or reviewer.
2. **Goal** — one answerable question or one stated change.
3. **Bound** — exact files or directories; nothing outside them.
4. **Evidence** — symptom, log line, failing check or diff to start from.
5. **Write authorization** — `read-only`, or the exact files a builder may edit.

Children start with fresh context and cannot ask questions. Paste every path and the full role contract; a preset name alone loads nothing.

## Roles

- **Investigator** — read-only symbol and execution-path tracing. Returns `path:line` evidence and what it ruled out.
- **Builder** — one or two assigned files. Reads direct callers, makes only the stated change, re-reads the edited lines and runs the agreed focused check. More than two files or a cross-owner change returns `too-big.`
- **Reviewer** — read-only review of the changed path and every directly affected consumer. Reports concrete defects with a fix; no general commentary.

Terminal refusals: `too-big.` / `needs-confirm.` / `ambiguous.` / `regressed.` The role stops rather than guessing a binary, device or missing authorization fact.

## Output contracts

Investigator:

```text
<Header>:
- path:line — `symbol` — short note
totals: <counts>.
```

Or `No match.`

Builder:

```text
<path:line-range> — <change, <=10 words>.
verified: <re-read OK | mismatch @ path:line | limitation>.
```

Reviewer:

```text
path:line: <severity>: <problem>. <fix>.
totals: N bug, N risk, N nit, N question.
```

Or `No issues.` Sort findings file then line ascending. Use clear prose for security or irreversible-action warnings.

## Selection

| Task | Use |
| --- | --- |
| Locate a definition, caller or use | investigator |
| Same, plus architecture commentary | built-in explore/general |
| Surgical edit in <=2 files | builder |
| New feature or 3+ file refactor | main thread or general |
| Review a concrete diff | reviewer |

Do not use a builder before the file is known. Do not chain investigator to builder for a multi-file refactor. A delegation adds no device, installer, SteamVR, Git, release or workflow authorization.

## End-of-plan gate

Delegation never replaces the main thread's full local portable build. For GalaxyXR-Driver, run `tools/Build-Portable.ps1` and validate exit 0, `Built test package: ...`, and the driver DLL/manifest/Companion EXE.

Hermes users load [the role contracts](references/hermes-roles.md) and run the parent's re-read/check step after every child summary.
