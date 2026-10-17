---
name: cavecrew
description: Delegate bounded GalaxyXR-Driver investigation, implementation or diff review to project-scoped agents with compact path and line evidence. Use when the user requests cavecrew, subagents, delegation or parallel agent work.
---

# Cavecrew

Use the host's delegation tools and the project-scoped role
instructions. On Codex that is the collaboration tools with `.codex/agents/*.toml`
role files; on Hermes it is `delegate_task` (children inherit the session model
and get a fresh context — paste the role contract in, a preset name loads nothing).
Delegate when authorized by the user or applicable instructions;
an ordinary repository task does not by itself request subagents. The main
thread retains scope, assigns owners, reviews results and communicates clearly.

## Select the role

| Work | Role and scope |
| --- | --- |
| Locate definitions, callers, setting consumers or build producers | Investigator: read-only inspection and source citations. Codex preset [`.codex/agents/cavecrew-investigator.toml`](../../../.codex/agents/cavecrew-investigator.toml); the role contract below is the Hermes form. |
| Implement an already located change in one or two files | Builder: edit only parent-assigned files and run agreed focused checks. Codex preset [`.codex/agents/cavecrew-builder.toml`](../../../.codex/agents/cavecrew-builder.toml); the role contract below is the Hermes form. |
| Review a concrete diff for defects | Reviewer: read-only changed execution paths and directly affected consumers. Codex preset [`.codex/agents/cavecrew-reviewer.toml`](../../../.codex/agents/cavecrew-reviewer.toml); the role contract below is the Hermes form. |
| Cross-cutting implementation in three or more files | Main thread partitions independent owners or implements the complete chain itself. |
| One-line known answer | Main thread; no delegation. |

Codex discovers standalone `.codex/agents/*.toml` project roles. When spawning
through collaboration tools, include the selected role's instructions; a task
name alone does not load a role preset. Use the current session's model unless
explicit user/role instructions request another supported model.

## Delegate on Hermes

Hermes reads this skill directly when the session runs from the checkout root
or a subdirectory (`hermes skills trust` once per machine), so no preset file
loads for it — paste the full role contract into each `delegate_task` child:

- **Investigator** — `context`: "Read-only. Locate <symbols/paths> in
  <GalaxyXRDriver/ or GalaxyXRDriverGUI/>. Never edit files, run migrations or
  builds, install dependencies, or touch runtime/Git state. Return
  `path:line — symbol — short note` with totals; no matches: `No match.` Asked
  to implement: `Read-only. Assign cavecrew-builder or main thread.` If the
  request needs missing evidence, return the exact question line instead of
  guessing."
- **Builder** — `context`: "Edit ONLY these assigned files: <paths>. Read
  AGENTS.md, .agents/skills/customheadset-gxr/SKILL.md and the matching
  workflow in this child's context: <paste workflow>. Preserve unrelated edits,
  both vendors, legacy headsets, defaults parity and journal-owned SteamVR
  settings. Run only these checks: <focused commands>. If scope needs a third
  file or a full build, return `too-big.` with the missing owner instead of
  editing. Receipt: `path:line — change` plus `verified: exact check/outcome
  or limitation`."
- **Reviewer** — `context`: "Read-only review of this diff: <inline git diff
  output only when it is short AND free of backticks/angle brackets;
  otherwise run the wave's git diff to the scratch dir and paste the FILE
  path — a large diff's code fences break the delegate payload. Report only
  concrete regressions in the changed paths and their consumers. Do not run
  write-producing checks or edit anything. Findings:
  `path:line severity: problem. Fix direction.` plus totals; zero findings:
  `No issues.`"

Hermes mechanics that differ from Codex: children inherit the session model
(there is no per-child model pin), cannot ask the user questions, and return
only a final summary the parent must verify against the cited lines and rerun
checks — never trust a receipt alone.
- A `delegate_task` dispatch rejected with "could not be parsed as JSON" is a
  SIZE failure, not a content one: past roughly 2.5-3 KB of total payload the
  arguments truncate mid-string and fail with a delimiter error — observed with
  nested-array output schemas AND with plain prose alone. Fix = shrink the TOTAL
  payload: dispatch ONE short task whose context names the files to read, put the
  detailed spec into a plan/reference FILE under the evidence dir, and pass its
  absolute path; drop the output_schema when the goal prose already fixes the
  shape. Losing the schema loses nothing — the contract stated in prose fixes it.

## Give the agent concrete boundaries

Provide the goal, selected role, exact file ownership or read-only search area,
source/artifact roots, relevant existing work, authorized checks and required
output. Do not hand a builder an unknown execution path: investigate first.
For parallel work, use disjoint file owners and explicitly reconcile shared
settings schemas, build paths and their consumers in the main thread.

## Main-thread verification of parallel waves

- Before dispatching builders, map shared consumers: a field published in one
  owner's file and read in another's (config -> tap, tap state -> info.json
  emitter, tap state -> GUI types) must live inside ONE owner, or the main
  thread holds the seam itself. Partial-TU test runners will not catch a
  consumer break: extraction-based runners compile one function body, and
  test-TU runners compile only the test file's includes.
- An investigator's `No match.` is a self-report, not evidence: it can be a failed
  read even when the goal carried exact symbols and paths. When the main thread
  already holds grep hits in the same area, discard the child report and finish
  the locate in the main thread instead of re-dispatching blind; likewise distrust
  any report containing scope statements the dispatch never wrote.
- Before EACH main-thread patch round, rerun `git status --short`. A parallel
  agent session live-edits the same tree mid-wave; absorb consistent owner
  work, never revert it, and reconcile seams it left half-done.
- Terminal state persists across calls: run every command batch with an
  explicit absolute `cd`, or commands run under the wrong directory and can
  fail silently inside background calls. A shell pipeline also masks the real
  exit code (`echo EXIT=$?` after `cmd | tail` reports tail's status); write
  the real exit into a log file.

Read [AGENTS.md](../../../AGENTS.md) and
[the workspace map](../galaxyxr-workspace/references/project-map.md) before
project work. Implementation follows [customheadset-gxr](../customheadset-gxr/SKILL.md)
and its matching workflow. Respect all authorization already in the conversation;
a role cannot expand user-authorized scope.

Generated artifacts use `../builds/GalaxyXR-Driver/`, with `build/`, `output/`,
`release/` and `gui/` subfolders. Read-only roles do not run write-producing tests.
Full builds remain GitHub-first; cavecrew never adds an unconditional local build.
Build-path review includes Vite/Vitest `--configLoader runner` (prevents
`node_modules/.vite-temp`), external Cargo target output, Tauri scratch in
`OUT_DIR/tauri-build-context/` through `GalaxyXRDriverGUI/src-tauri/build.rs`,
and stable external `gui/schemas/` capability links.

## Output contracts

Investigator:

```text
<Header>:
- path:line — `symbol` — short note
totals: <counts>.
```

Use `No match.` when no matching implementation exists. Separate observed facts
from hypotheses and identify incomplete evidence.

Builder:

```text
path:line — change.
verified: exact check/outcome or limitation.
```

If assigned scope cannot be safely completed, return a clear reason such as
`too-big.`, `needs-confirm.`, `ambiguous.` or `regressed.`, with the missing owner,
authorization or failing check. Do not edit outside assigned files to finish.

Reviewer:

```text
path:line severity: concrete problem. Suggested fix.
totals: <counts by severity>.
```

Use `No issues.` when no actionable defect is found. Do not invent findings or
claim CI/runtime evidence from static review.

Keep output compact while retaining exact paths, line numbers, symbols and
validation limits. Use normal clear English for authorization, risk or anything
where fragments could mislead. The main thread converts agent output into a
self-contained user result with the necessary evidence.

## Settings authority (2026-10-17)

Explicit codec switches and reset arrows update the saved values backing each editable field. Advanced controls may remain hidden: switching codecs must still update them, and opening Advanced Mode must show their current values. Force CBR is On in every codec row by default, and selecting H.264 turns the SDR 10-bit baseline off (H.264 cannot carry 10-bit): its toggle reads Off and is disabled until another codec is selected. Image Enhancements defaults On and is independent of the 10-bit SDR baseline: no consent gate and no mutual warnings (owner directive 2026-10-17). The Lifted-Blacks Fix is Off in every codec by default: its toggle and reset arrow read and restore Off, and turning it on stays the user's choice. Never silently coerce, replace or ignore app-visible user settings; preserve rejected requests with a visible error. Automatic internal parameters with no app setting may be derived without rewriting user settings.
