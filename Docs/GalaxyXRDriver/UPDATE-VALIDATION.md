# GalaxyXRDriver 1.2.0 — current update validation

Date: 2026-09-21. Scope: About-first setup, native runtime confirmation, settings cleanup, nested cards, project/package rename, cumulative earlier fixes.

**This is source validation, not a certified Windows release build.** No executable or driver DLL was produced here. The full GitHub-hosted workflow was not executed. Other validation reports retained in the archive are historical; the results below belong to this revision.

## Executed and passed

| Suite | Result | Scope |
|---|---:|---|
| `Test-FluentFixes.cjs` | 36/36 | Real services with mocked Tauri filesystem/IPC; persistence, installation inspection, watchers and saved values |
| `Test-CompanionModes.cjs` | 22/22 | Baseline/enhancement exclusion, defaults, route restrictions; About + App Settings before installation |
| `Test-AboutSetup.cjs` | 18/18 | Startup status invalidation, single-flight reads, launch/error semantics, reset coordination, cancellation, uninstalled state and pending writes |
| `Test-SectionCards.cjs` | 11/11 | Actual grouping helper/CSS, inert template-object adapter because npm dependencies are unavailable; NOT production Lit rendering |
| Chromium layout fixture | 4/4 | Light/dark at 1100/600px: increasing nested card offsets, no horizontal overflow, no Expand/Collapse text; substitute native inputs, NOT production Fluent/WebView2 |
| `Test-SteamVRSettingsDiff.cjs` | 19/19 | Settings-diff behavior |
| `Test-FluentBuildHooks.cjs` | 20/20 | Build hook/staging fixtures, locale assets, BOM-free JSON, stderr handling, zlib utility source |
| `Test-SourceUpdate.cjs` | 8/8 | Legacy/already-renamed checkout, source backups, generated-file exclusions, rollback, link refusal and unrelated data retention |
| Full source migration rehearsal | Passed | Apply the actual overlay to a copy of the prior cumulative package; all 462 then-present overlay files matched exactly, legacy roots archived, ThirdParty/unique local files preserved |
| `Test-CompanionAssets.py` | 56/56 | Required HMD/icon/catalog/title resources |
| C++ `CompanionSettingsTest` | 132 each | Compiled and run with g++ for neutral and `VENDOR_GALAXYXR` configurations |
| C++ `SdrColorPolicyTest` | 62 | Compiled and run with g++ |
| C++ `SteamVRSettingsJournalTest` | 36 | Compiled and run with g++ |
| C++ `VrlinkCapabilitiesTest` | Passed | Compiled and run with g++ |
| TypeScript syntax pass | 52 files | Zero transpile/syntax diagnostics; not a dependency-resolved typecheck |
| JavaScript syntax | 19 files | `node --check` |
| Source/project structure | Passed | Both native XML project files parse; 49 non-ThirdParty source/header paths resolve; renamed roots/solution and workflow YAML checked |
| Release version consistency | 8 sources | All 1.2.0; npm/Cargo package names consistently `galaxyxrdriver-gui` |

The source migration rehearsal preceded the final documentation/log manifest additions. The same updater includes those documentation files; final archive integrity and per-file hashes are checked during packaging. Logs are in `validation/`. Included screenshots are explicitly labeled layout-only fixtures and must not be presented as screenshots of the running production app.

## Added but NOT executed here

Twelve Rust cleanup tests cover journal-based restoration, lifecycle retention, external-edit preservation, no-driver/local-only resets, exact custom keys, backup of malformed local data, malformed SteamVR/journal refusal, stale snapshot refusal, rollback, external edits during rollback, and preservation of restored original identity values.

Eight Rust runtime tests cover the current process/initialized state, old or reused PID, stale heartbeat, merely launching, lockout, version mismatch and connected-headset distinction.

Run these together with existing Rust installation tests on the Windows build host:

```powershell
cd GalaxyXRDriverGUI/src-tauri
cargo test --locked --lib
```

These are local end-of-task checks; the release workflow builds and packages only. No Rust compiler/Cargo or Windows/PowerShell/MSVC toolchain was available here, so these native tests were reviewed but not compiled/executed.

## Required Windows release checklist — NOT RUN

| Check | Required evidence |
|---|---|
| Clean checkout/source apply | Source helper succeeds from a separate extraction; ThirdParty retained; no duplicate old project folders are used |
| Full production build | `npm ci`, `npm test`, full `Build-Portable.ps1` (the end-of-plan gate) plus release builder, native Rust tests succeed; no `-GuiOnly` shortcut |
| Portable integrity | New GUI beside complete GalaxyXRNative directory; matching version/manifest/DLL/resources and all locale assets; no development server required |
| First launch, no driver | About selected; About + App Settings visible; all other routes blocked; clean/install/check controls available only in About |
| Install and initialize | Install verifies files only; Start SteamVR shows pending; fresh current-session native proof shows initialized; physical picture/controller test completed |
| Failure states | SteamVR unavailable, driver disabled/locked out, old DLL, stale runtime files, failed launch and unreadable metadata show actionable non-success state |
| Repeat session | Stopping SteamVR clears green status; restarting requires new proof; no stale pending result from the previous install reappears |
| Clean Settings, installed | With SteamVR stopped, confirmation and recovery backup; local tab defaults reset; unrelated SteamVR values/registration/bindings/room setup/profile files retained |
| Clean Settings, uninstalled | Works before installation; local-only report without SteamVR; refuses unresolved recovery journal; active SteamVR blocks cleanup |
| File safety | Malformed SteamVR/journal causes no settings reset; deliberate external edit is preserved; backup/rollback error messages identify recovery files |
| Fluent visual/accessibility | Nested children within cards, no Expand/Collapse words, light/dark/system themes, top-layer help, keyboard operation, zoom and translated text fit actual WebView2 |
| Hardware and regression | Driver/controller icons, Steam Link connection, controller poses/input and picture modes verified on the real headset |
| Release automation | Manual workflow run successful with downloadable renamed ZIP, checksums, notes and attribution before publishing a new version tag |

## Reproducing source-only checks

From the project root after `npm ci` in the GUI folder:

```powershell
node tools/Test-FluentFixes.cjs
node tools/Test-CompanionModes.cjs
node tools/Test-AboutSetup.cjs
node tools/Test-SectionCards.cjs
node tools/Test-SteamVRSettingsDiff.cjs
node tools/Test-FluentBuildHooks.cjs
node tools/Test-SourceUpdate.cjs
python tools/Test-CompanionAssets.py
```

In this environment a global TypeScript compiler was selected with `FLUENT_TEST_TYPESCRIPT`; no mock compiler was used. Native APIs in the service tests are mocks and cannot validate Windows permissions, actual vrserver process access or SteamVR registration.
