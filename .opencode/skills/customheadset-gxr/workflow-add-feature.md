# Add a feature

1. Read `AGENTS.md` and the affected section of `../galaxyxr-workspace/references/project-map.md`. Record the user-visible behavior, vendor/headset modes and exact files.
2. For a setting, trace the full chain in `AGENTS.md`. Declare its control spec **first** — constraint kinds, range, step, unit, sentinel, capability/context/ordering — then render the row from the spec through `numberControl`/`choiceControl`/`sliderControl`. Reuse shared controls and `GalaxySettingsBase`; pages stay thin views. Match native and TypeScript defaults.
3. Decide whether the control hot-reloads or needs a restart. A restart-only tip says **"Requires a SteamVR restart."**
4. If existing key semantics change, add matching dated migrations in `ConfigLoader.cpp` and `galaxy-settings.ts`. Upgrade exact old defaults only; preserve custom tuning.
5. Add source XLIFF entries and `t(...)`, help/reset behavior following adjacent patterns, and user documentation where behavior becomes visible.
6. Select focused checks for the changed path. `npm test` includes the control-spec coverage test; run it before the end-of-plan full portable build. Review both vendors and affected legacy paths, run `git diff --check`, clean task-owned residue and report evidence limits.

Artifacts belong under `../builds/GalaxyXR-Driver/`. Deployment, runtime, commit, push, dispatch and release actions follow `AGENTS.md` and existing session authorization.
