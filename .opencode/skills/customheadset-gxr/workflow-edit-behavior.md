# Edit behavior or build tooling

1. Establish current behavior from the live implementation and tests. State the requested before/after outcome and preserve unrelated edits.
2. Trace producers and consumers: shared state and GUI services for settings; native config and consumption sites for runtime; every build entrypoint, staging path, packaging consumer and CI upload for artifacts.
3. For setting semantics, update both native and TypeScript migrations. Upgrade exact old defaults only. Check reset/fresh-install separately from upgrade behavior. Preserve journal ownership, vendor identities and legacy headset paths.
4. Keep all build output under `../builds/GalaxyXR-Driver/`. Check PowerShell, Node, MSBuild project references, Cargo, Vite/Vitest, Tauri schema generation, packaging and CI together. Keep Cargo target output external and do not add junctions back into source.
5. Run focused checks that cover the changed contract: build-tool fixtures, portable lifecycle/cleanup checks, GUI tests/compilation or targeted native checks. Verify output actually lands outside source.
6. Update the canonical `AGENTS.md`, skill or documentation when commands or ownership change. Review the diff, clean allowlisted residue, retain one verified package and report what passed and what remains untested.

The end-of-plan full local build and external-action authorization are governed by `AGENTS.md`; this workflow adds no deployment or publishing permission.
