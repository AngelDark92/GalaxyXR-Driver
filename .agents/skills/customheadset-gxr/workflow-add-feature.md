# Add a feature

1. Read `AGENTS.md`, inspect the ownership map, and record the concrete user
   behavior and affected vendor/headset modes. Use existing shared controls and
   state rather than duplicating behavior in a page.
2. For a setting, trace the complete chain: C++ `Config.h`,
   `ConfigLoader.cpp` parse/default serialization, TS `domain/types.ts`,
   `driver-defaults.ts`, shared `GalaxySettingsBase`, page binding and runtime
   consumption. Defaults must match. Decide whether hot reload or SteamVR restart
   applies; restart-only controls say “Requires a SteamVR restart.” in their tip.
3. Keep defaults conservative, retain custom tuning, and use the dated-campaign
   comments explaining why. Add migrations in both languages when existing key
   semantics change. Do not edit `ThirdParty` or translated XLIFF catalogs.
4. Add source XLIFF entries and `t(...)`, help/reset controls following adjacent
   patterns, and user documentation where the behavior becomes visible.
5. Select meaningful checks from the actual changed path: GUI `npm test`,
   `npm run build:ui`, relevant tool suite or standalone native test. Put generated
   output in `../builds/GalaxyXR-Driver/`. A GUI-only build is not full-package proof.
6. Review the full chain, both vendors and affected legacy paths. Run
   `git diff --check`; finish cleanup after validation. Report files, behavior,
   validation and remaining material limits with path/line evidence.

The full local portable build is required at plan completion. Deployment and runtime
actions follow `AGENTS.md` and existing session authorization, not this checklist alone.
