# Workspace cleanup and output retention

## Current artifact location (2026-10-08)

Builds now use `../builds/GalaxyXR-Driver/` relative to the checkout. On this machine that
is `D:\Angelo\Desktop\SteamLink-GalaxyXR-Windows-Toolkit-FULL\builds\GalaxyXR-Driver`.
`build/` holds compiler scratch, toolchains and logs; `output/` holds Cargo targets
and staged packages; `release/` holds release ZIPs and metadata; `gui/build/`,
`gui/dist/` and `gui/cache/` hold generated frontend files and caches.
Tauri metadata uses Cargo's external scratch context and stable `gui/schemas/`.
Temporary tool fixtures use `build/test-fixtures/` and remove themselves after
successful checks. Source archives default to `release/source/`.

PowerShell builders and tests, MSBuild (including referenced MinHook), Cargo,
Vite, packaging and CI artifact uploads use this external layout. Do not create
new build folders inside the checkout. Vendored source folders named `build`
remain in `ThirdParty`; they are source inputs, not disposable compiler outputs.

`tools/Move-BuildFolders.ps1` previews the migration; `-Apply` moves known
untracked artifact directories and verifies file names and sizes. Existing
destination directories accept disjoint children only; collisions fail before
moving anything. It preserves all packages and evidence, rejects links and
tracked files, and checks active processes and SteamVR registrations.
The migration receipt is `../builds/GalaxyXR-Driver/build-folder-migration.json`.

For routine retention, `tools/Clean-Workspace.ps1 -KeepPackage output/<package>`
interprets the package path relative to `../builds/GalaxyXR-Driver`. It retains its
allowlist and protections, and still recognizes legacy artifacts during
migration. Its receipt is `../builds/GalaxyXR-Driver/build/workspace-cleanup-last.json`.
Preview before `-Apply`; a missing verified full package is never substituted
with a frontend-only build. Other projects' unrecognized artifacts are preserved.

The sections below record the historical 2026-09-26 audit; their paths and byte
counts describe that audit, before external relocation.

User policy, 2026-09-26: full builds run on GitHub. Keep only the latest verified
complete local package and clean generated artifacts at the end of tasks. This
replaces the previous policy of keeping every output package and historical cache.
`AGENTS.md` makes this a standing instruction for future agents.

## Can output be deleted?

The audited `output/` contains rebuildable Cargo compiler caches and finished
packages. None of its paths is registered as the installed SteamVR driver in the
2026-09-26 audit. Deleting these generated copies does not delete source or the
separate managed installation under `%LOCALAPPDATA%/GalaxyXR/Drivers`.

Keep **one complete package**, as requested, rather than emptying the folder.
At the start of this cleanup that package is
`output/GalaxyXRDriver-Test-20260926-215043/`. Its native driver, manifest and
Companion executable are present; the matching
`build/portable-logs-20260926-215044-7b32ee5923234d89a3109eb961f421c4/gui-build.log`
records successful release compilation. A cleanup hash comparison proves file
preservation, not headset runtime behavior or a new build of later source edits.

Do not assume every future file placed in `output/` is disposable. An older
installer could register a package in place; custom outputs might also contain
user files. Check registered drivers, live processes and unexpected files first.

## Measured plan

Inventory on 2026-09-26: **18,981,995,110 bytes = 18.98 GB = 17.68 GiB**,
excluding linked targets. Numbers below are logical file sizes, not filesystem
allocated-space measurements. GB uses 1,000,000,000 bytes; GiB uses 1,073,741,824.

| Path | Size before cleanup | Decision |
| --- | ---: | --- |
| `output/GalaxyXRDriverGUI/` | 8.58 GiB | Delete Cargo debug/release cache; recreated by the next Rust build. This is not the portable package. |
| `GalaxyXRDriverGUI/src-tauri/target/` | 2.80 GiB | Delete the second Cargo cache; next local Rust test/build recompiles. |
| `build/portable-objects-*` (45 directories) | 1.31 GiB | Remove native compiler outputs; preserve build logs, export reports and dependency reports. |
| 12 obsolete Galaxy XR / neutral test packages | About 368 MiB | Delete after validating the retained package and checking installations/processes. Keep one package total, not one per vendor. |
| Latest complete package | About 31 MiB | Preserve every file and compare SHA-256 before/after cleanup. |
| `build/toolchains/` | 3.51 GiB | Preserve MSVC/Rust tools and downloaded offline dependencies. |
| `GalaxyXRDriverGUI/node_modules/` | 0.14 GiB | Preserve; supports focused local checks without reinstalling dependencies. |
| `ThirdParty/` | 0.50 GiB | Preserve vendored source and required binaries, including folders named `build`, `lib` or `output`. |
| `.git/` | 0.19 GiB | Preserve repository history and metadata. |
| Other `build/` folders and `release/` | Individually small | Preserve pending individual review: some contain scripts, diagnostic captures or release evidence. |

The selected cleanup should reclaim about **13 GiB**, leaving roughly **5 GB**.
Actual results are recorded below after execution. Do not delete the entire
`build/` folder: generated compiler files coexist with tools and unique evidence.

Removing toolchains or `node_modules` is a separate optional space tradeoff:
future local work needs reinstallation/downloads and offline builds may stop
working. Neither is part of routine cleanup. Do not stop a toolchain process just
to reclaim its installation. Installed drivers and AppData settings are outside
the cleanup scope.

## End-of-task procedure

1. Finish focused checks. Do not start a full local build just to satisfy the old
   cavecrew gate; `AGENTS.md` now uses the user's GitHub-first policy. Report
   exactly which checks ran and whether an actual CI build was verified.
2. Choose the latest successfully staged full package. Check its driver manifest,
   native DLL and Companion EXE. Never promote a failed or partial build solely
   because its folder is newer. Preserve the previous complete package until a
   replacement succeeds.
3. Ensure no build/dev session or other task uses candidates. Preview the plan:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File tools/Clean-Workspace.ps1 -KeepPackage output/GalaxyXRDriver-Test-20260926-215043
   ```

4. Inspect proposed removals and protected skips, then apply the same plan:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File tools/Clean-Workspace.ps1 -KeepPackage output/GalaxyXRDriver-Test-20260926-215043 -Apply
   ```

   Replace the example path with the verified package for that task. Standing
   authorization covers these allowlisted generated artifacts; routine cleanup
   needs no repeated permission question.
5. Inspect `build/workspace-cleanup-last.json`, retained-package hashes and Git
   status. Report reclaimed bytes and anything skipped. Remove task-owned test
   fixtures after success; preserve failure evidence while investigating. Do not
   run another build after final cleanup unless new changes require verification.

The helper is intentionally limited to the two named Cargo targets, recognized
complete timestamped test packages and legacy native compiler outputs. It refuses
paths outside the repository, linked paths, tracked candidates, active build or
registered-driver paths; unfamiliar package files are preserved for review.
It does not treat Git's ignore rules as permission to delete arbitrary files.
Custom-named outputs, release staging folders and ZIPs require individual review.

The normal portable builder already removes its own
`build/pw-<HHmmss><6 hex>/` work directory after successful staging and restores
the caller's `CARGO_TARGET_DIR`. The short id keeps Cargo and link paths under
MAX_PATH 260 on long checkouts; the older `portable-work-<timestamp>-<guid>` name
is still accepted so pre-2026-10-17 trees remain cleanable. Logs remain in
`build/plog-*`; failed builds retain their work for diagnosis.
`-KeepBuildArtifacts` is a debugging opt-out.
Partial builds clean their own scratch but must not evict the last full package.
The standalone cleanup command is run by the agent at task end; it is not a
background job or a new GitHub workflow hook. CI must keep artifacts until its
remaining tests, packaging and upload steps have consumed them.

## Verification

Run `tools/Test-WorkspaceCleanup.ps1` to exercise the new deletion guards with
disposable fixtures. Existing per-build cleanup remains covered by
`tools/Test-PortableBuildCleanup.ps1` and `tools/Test-PortableBuildLifecycle.ps1`.
Fixture checks validate cleanup behavior; they do not claim a full driver/GUI
build or runtime test.

## Executed audit

Completed on 2026-09-26:

- Removed **14,006,648,852 bytes (14.01 GB / 13.04 GiB)** from 59 eligible
  locations: 12 old packages, two Cargo targets and compiler outputs in 45 old
  native build directories. Their small logs and reports remain.
- Checkout size fell from **18.98 GB to 4.98 GB** (17.68 GiB to 4.63 GiB).
  Final audit measured 4,975,696,753 bytes before writing its small JSON report.
- `output/` now contains only `GalaxyXRDriver-Test-20260926-215043`, totaling
  32,246,057 bytes. SHA-256 matched before/after for all **148 files**.
- All **50 pre-existing modified/untracked user files** matched their baseline
  SHA-256 hashes. No settings, installed driver, source or vendored files were
  changed by cleanup. Toolchains and dependency installations were preserved.
- **41 fixture assertions passed under Windows PowerShell 5.1 and PowerShell
  7.6.5**, including registered driver junctions, registry overrides and accurate
  partial deletion reporting on a locked file. Successful fixtures self-delete.
  Independent review found no remaining issues in the three corrected guards.
- A post-cleanup preview reported **zero eligible locations / zero bytes**.
  No full local build, deployment, commit, push or GitHub build was performed.

Local evidence: `build/workspace-cleanup-preview.log`,
`build/workspace-cleanup-execution.log`, `build/workspace-cleanup-last.json`
(before/after package hashes and removal receipt),
`build/workspace-cleanup-source-before.json` and
`build/workspace-cleanup-verification.json`. These are small diagnostic records,
not additional output packages. The reusable last-cleanup receipt is replaced
on the next invocation of the apply command.
