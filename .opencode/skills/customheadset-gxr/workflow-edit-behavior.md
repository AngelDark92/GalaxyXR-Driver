# Edit behavior or build tooling

1. Establish current behavior from the live implementation and tests. Identify
   the requested before/after outcome; preserve unrelated user edits.
2. Trace producers and consumers: shared state and GUI services for UI/settings;
   native config and consumption sites for runtime; every build entrypoint,
   staging path, packaging consumer and CI upload for artifact changes.
3. If setting semantics change, update C++ and TS migrations together. Upgrade
   exact old defaults only. Check reset/fresh-install behavior separately from
   upgrade behavior. Preserve journal ownership, vendor identities and legacy
   headset paths. Explain tuning changes with the repository's dated comments.
4. Keep all build directories external under `../builds/GalaxyXR-Driver/`.
   Check PowerShell, Node, MSBuild including project references, Cargo, Vite,
   Tauri frontend/schema generation, packaging, tests and CI consumers together.
   Preserve Vite/Vitest `--configLoader runner` to avoid source-local
   `node_modules/.vite-temp`. Keep Cargo target output external, Tauri scratch in
   `OUT_DIR/tauri-build-context/` through `GalaxyXRDriverGUI/src-tauri/build.rs`,
   and capability schema links aligned with external `gui/schemas/`.
   Do not insert junctions or symlinks back into source. Use the native dependency
   setup scripts instead of editing dependency source.
5. Run focused checks that cover the changed contract: build-tool fixtures,
   portable lifecycle/cleanup checks, GUI tests/frontend compilation, or targeted
   native checks. Exercise custom path rejection and changed consumers where
   appropriate. Verify output actually lands outside source.
6. Update maintained documentation, `AGENTS.md`, agent roles and applicable skills
   when commands or ownership change. Historical evidence remains dated evidence.
7. Review the final diff and clean only task-owned fixtures/allowlisted artifacts
   after checks finish. Keep one verified full package; never evict it for a
   partial/failing build. Report precisely what passed and what remains untested.

End-of-plan full local build and external-action authorization remain governed by
`AGENTS.md`; this workflow does not add a deployment or publishing gate.
