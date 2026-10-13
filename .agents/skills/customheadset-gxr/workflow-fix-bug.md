# Fix a bug

1. Describe the concrete trigger, observed failure and expected behavior.
   Reproduce with a targeted fixture or existing evidence when possible; distinguish
   observed defects from hypotheses. An audit-only request authorizes reporting,
   not fixing, unless later user steering changes that scope.
2. Trace the owning path using the workspace map. Record current settings/schema,
   vendor and relevant headset modes. For runtime diagnosis, match fresh process
   IDs, loaded module paths/hashes and telemetry; do not promote stale logs to
   live proof. Device/SteamVR actions need session authorization.
3. Fix the narrow cause and preserve tuning, defaults parity, neutral/Galaxy XR
   identity, legacy headset support and journal ownership. Add both migrations
   if meanings change; keep dependency source read-only.
4. Choose regression coverage that fails for the original bug and verifies the
   user outcome, plus meaningful adjacent cases such as disabled mode, reset,
   migration, partial failure or the other vendor. Avoid implementation-mirroring
   tests and unrelated full builds.
5. Keep compiler output, logs, test fixtures, screenshots and generated frontend
   assets under `../builds/GalaxyXR-Driver/`. Run relevant focused checks and
   `git diff --check`. A full local build requires user request or a build issue.
6. Re-read the changed execution path, run the final appropriate check once,
   update help/docs if behavior changes, and clean task-owned successful fixtures.
   Preserve unresolved failure evidence and the last verified complete package.
7. Report the cause, behavior change, verification and evidence limits with
   actual path/line references. Claim CI only from a verified successful run;
   claim headset/runtime behavior only from current authorized observation.
