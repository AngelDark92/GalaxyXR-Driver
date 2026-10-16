---
name: customheadset-gxr
description: Implement and validate GalaxyXR-Driver native driver, Companion settings/UI, installation, build tooling and bug fixes. Use for code changes in this checkout; select the matching add-feature, edit-behavior or fix-bug workflow.
---

# Galaxy XR implementation

Read [the repository contract](../../../AGENTS.md) first. Locate actual source and
current status before editing. The source roots are `GalaxyXRDriver/` and
`GalaxyXRDriverGUI/`; `CustomHeadsetOpenVR` remains a neutral runtime identity.
For ownership, execution paths and commands, consult
[the project map](../galaxyxr-workspace/references/project-map.md).

Choose the relevant workflow only:

- [Add a feature](workflow-add-feature.md): new controls, settings or capabilities.
- [Edit behavior](workflow-edit-behavior.md): defaults, migrations, routes or build changes.
- [Fix a bug](workflow-fix-bug.md): reproduce a concrete failure and verify the fix.

Every generated artifact belongs under `../builds/GalaxyXR-Driver/`, relative to
the checkout. Use its `build/`, `output/`, `release/` and `gui/` subfolders; never
create compiler, target, dist or cache folders in source. Existing source folders
named `build` in `ThirdParty/` are immutable dependency inputs.

Keep Galaxy XR and neutral builds, legacy headset sections, defaults parity,
user tuning and journal-owned SteamVR settings intact. New GUI strings use
`t(...)` and the source XLIFF catalog. A settings meaning change needs both C++
and TypeScript migrations which upgrade exact old defaults only.

## No silent settings (owner policy, 2026-10-16)

A user-entered setting is authoritative. Never silently coerce, clamp
per-codec, or replace an entered value with a default — not in driver runtime
code, not in caps/NVENC overrides, not in GUI state on codec switch, not in
load-time stamps. Per-codec optimized defaults are presentation: the UI shows
them and an explicit reset/apply control applies them (see the codec-aware
reset arrows on Stream Frame). When driver/device capability would force a
different outcome, honor the user value or fail loudly — driver log line plus
honest UI state — never downgrade in place. Dated, versioned migrations remain
the only permitted silent rewrites and cover never-set values only. Any new
override path needs its visibility story (log + UI surface) as part of the
same change.

Use focused local checks. Full builds run on GitHub unless the user explicitly
requests a local full build or a concrete build issue requires one. Report static,
fixture, compilation, CI and runtime evidence separately. A runtime claim needs
fresh matching process/module evidence, not an old package or report.

Implementation/validation permission does not authorize deploying, installing,
ADB, restarting SteamVR, committing, pushing, dispatching workflows or publishing.
Use session authorization when it exists. Preview and apply only the cleanup
allowlist described in [PortableBuildCleanup](../../../Docs/PortableBuildCleanup.md).

When cavecrew is requested, delegate bounded investigation, independent file
ownership or diff review through [cavecrew](../cavecrew/SKILL.md). Its invocation
never requires a full build or changes runtime authorization.
