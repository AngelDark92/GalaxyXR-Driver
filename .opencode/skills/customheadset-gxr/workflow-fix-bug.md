# Fix a bug

1. Describe the concrete trigger, observed failure and expected behavior. Reproduce with a targeted fixture or existing evidence where possible. Separate observed facts from hypotheses. An audit-only request authorizes reporting, not fixing.
2. Trace the owning path in the project map. Record current settings/schema, vendor and headset modes. For runtime diagnosis, match fresh process IDs, loaded module paths/hashes and telemetry; do not promote stale logs to live proof. Device/SteamVR actions need session authorization.
3. Read [runtime evidence channels](references/runtime-evidence.md) when the failure involves NVENC, codec selection, tile classes or driver logs.
4. Fix the narrow cause. Preserve tuning, defaults parity, vendor identity, legacy headset support and journal ownership. Add both migrations when meanings change; keep dependency source read-only.
5. Add regression coverage that fails for the original bug and verifies the user outcome, plus meaningful adjacent cases such as disabled mode, reset, migration, partial failure or the other vendor. Know each focused runner's compile coverage before calling a receipt an all-clear.
6. Keep output under `../builds/GalaxyXR-Driver/`. Run focused checks, then the end-of-plan full portable build. Re-read the changed path, update help/docs if behavior changes, clean task-owned success fixtures and preserve unresolved failure evidence and the last verified package.
7. Report cause, behavior change, verification and evidence limits with current `path:line` references. Claim CI only from a verified run and headset/runtime behavior only from current authorized observation.
