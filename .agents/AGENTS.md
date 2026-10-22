# Project skills and agent guidance

Read [the checkout contract](../AGENTS.md). This directory contains project-scoped
skills; specialized agent presets are in `../.codex/agents/` (Codex); OpenCode uses
`../.opencode/agents/` and Cursor uses `../.cursor/rules/project.mdc`. Hermes loads
these skills directly when the session runs from this checkout and the repo root
is trusted (`hermes skills trust` from the checkout root), and delegates roles
through `delegate_task` with the role contracts in `cavecrew/SKILL.md` pasted into
each child's `context` — a preset name alone loads nothing.

Use `galaxyxr-workspace` to locate the actual ownership/execution path and
`customheadset-gxr` plus its matching workflow for implementation. `cavecrew`
coordinates bounded investigation/build/review when delegation is authorized.
Communication skills change wording only; they never authorize code, runtime or
Git mutations. The `morphe-patches` skill routes Steam Link integration to the
sibling checkout, whose own rules and exact-build evidence apply.

Builds always belong to `../../builds/GalaxyXR-Driver/` when resolving from this
directory (equivalently `../builds/GalaxyXR-Driver/` from the checkout root).
Use subfolders for compiler scratch, packages, releases, generated GUI assets and
validation. Keep project knowledge centralized in the workspace reference and
implementation workflows instead of copying a different stale map into each skill.
