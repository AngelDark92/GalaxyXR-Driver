# Workspace cleanup and output retention

## Current artifact location

Builds use `../builds/GalaxyXR-Driver/` relative to this checkout. On this machine that is
`D:\Angelo\Desktop\SteamLink-GalaxyXR-Windows-Toolkit-FULL\builds\GalaxyXR-Driver`.

| Path | Contents |
| --- | --- |
| `build/` | compiler scratch, toolchains, logs, fixtures, CMake/MSBuild scratch |
| `output/` | Cargo targets and staged packages |
| `gui/` | generated frontend bundles, caches and stable schemas |
| `release/` | release ZIPs, checksums and notes |

Tauri uses Cargo's external scratch context and stable `gui/schemas/`. Temporary test
fixtures use `build/test-fixtures/` and remove themselves after a successful check.
Source archives use `release/source/`.

Do not create new build folders inside the checkout. Vendored source folders named
`build`, `lib` or `output` remain immutable dependency inputs.

## Routine cleanup

`tools/Clean-Workspace.ps1` is the routine retention helper. It recognizes:

- validated Cargo target directories under `output/` (`GalaxyXRDriverGUI*`) and
  `build/cargo-target`;
- complete timestamped packages matching
  `GalaxyXRDriver-(Neutral-)?Test-YYYYMMDD-HHmmss`;
- legacy `build/portable-objects-*` compiler directories and `gui/target`.

It validates Cargo markers, package contents, tracked paths, reparse points, active
build processes and SteamVR registrations before deleting. An unrecognized file at
the Cargo target root causes that candidate to be preserved; the generated
`debug`/`release` subdirectories are removed with the validated cache. Alternate or
worktree Cargo targets under `output/GalaxyXRDriverGUI*` and `build/cargo-target` are
covered when they carry the markers. Unknown outputs, release ZIPs and custom
experiment directories require individual review.

Preview with the verified package:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/Clean-Workspace.ps1 -KeepPackage output/<verified-package>
```

Inspect the plan, then apply the same command with `-Apply`. Standing authorization
covers this documented allowlist after a verified build; unknown paths still need
individual review. The receipt is `build/workspace-cleanup-last.json` under the
artifact root. The argument is relative to the artifact root, never the current shell
directory.

`tools/Move-BuildFolders.ps1` previews migration of known in-checkout artifacts. Its
receipt is `build-folder-migration.json`. Do not improvise recursive moves or deletes
based only on directory names.

## Retention rules

- Keep **one latest successfully built complete package total** across Galaxy XR and
  neutral runs. Verify its driver DLL, manifest and Companion EXE; do not evict the
  last good package for a newer partial or failed build.
- Preserve source, uncommitted work, `.git`, `.github`, `.agents`, `.codex`,
  `ThirdParty`, user settings/profiles, installed drivers, SteamVR journals,
  diagnostic captures, toolchains, offline dependencies and `node_modules`.
- Preserve failure evidence until its cause is understood. Successful task-owned
  fixtures should remove themselves.
- Never run blanket `git clean -xfd`, remove all of `build/`, or recursively remove a
  generic `lib` folder. CI artifacts remain until downstream tests, packaging and
  upload have consumed them.

## End-of-task procedure

1. Run focused checks and the end-of-plan full local portable build
   (`tools/Build-Portable.ps1`). Report the package path and whether an actual CI
   build was verified.
2. Validate the new package and choose it as `-KeepPackage`.
3. Preview cleanup, inspect removals and protected skips, then apply it.
4. Verify the receipt, retained-package hashes and `git status`.
5. Report removed bytes and protected/skipped paths. Do not run another build after
   final cleanup unless new changes require verification.

## Verification

- `tools/Test-WorkspaceCleanup.ps1` exercises package, Cargo, worktree, unknown-file,
  junction, tracked-file, registration and active-process guards with disposable
  fixtures.
- `tools/tests/workspace-cleanup.test.cjs` runs that suite in the Windows CI job.
- `tools/tests/external-build-paths.test.cjs` rejects test runners that use
  `$repo` or `$repoRoot` with an in-checkout `build/`, `output/`, `dist/` or `target/`
  path. It does not inspect every possible script form.

Fixture checks validate cleanup behavior; they do not claim a driver build or runtime
test. The historical 2026-09-26 audit is preserved in
[`archive/PortableBuildCleanup-2026-09-26.md`](archive/PortableBuildCleanup-2026-09-26.md);
its paths and byte counts are dated evidence, not current instructions.
