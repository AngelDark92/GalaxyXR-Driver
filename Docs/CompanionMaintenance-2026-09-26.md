# Companion maintenance and presentation — 2026-09-26

Companion separates restoring defaults from removing an installation. Restore defaults keeps saved distortion profiles and recovery backups; uninstall removes them with the driver data.

## Maintenance behavior

| Action | Result | Preserved |
| --- | --- | --- |
| Restore defaults | Reset driver tuning and all app preferences; clear runtime/diagnostic data, migration state, and prior verification; restore recorded SteamVR tuning when still owned. | Installed driver, registration and lifecycle journal entries, named profiles, backups, unrelated or externally edited settings. |
| Uninstall driver | Unregister and remove owned installed packages; clear active app/driver data and saved profiles; remove recovery backups, identity backups and Companion OpenXR state; restore recorded SteamVR originals or original key absence; remove only verified historical identity leftovers. | Downloaded source packages, unrelated drivers, external settings edits. |
| Install after completed uninstall | Create current package defaults. A reinstall over an existing settings.json fills only settings absent from that file from the bundled defaults. | Existing saved values; downloaded source package. |
| Direct upgrade | Update the driver while retaining explicit saved tuning. | User-selected driver and app settings. |

Both destructive operations require a fresh stopped-process check in the UI and a native lock/process check. Cancel or Escape leaves persisted settings unchanged. The warning explains the scope before confirmation. Uninstall remains available for residual cleanup even when installation detection no longer finds a driver.

Reset backs up original bytes before changing files, compares each snapshot before replacement, and attempts rollback if a write fails. It does not run a broad historical cleanup: unrecorded SteamVR settings stay unchanged. Uninstall uses installation receipts and the settings journal to limit ownership. Shared values without a recorded original cannot be reconstructed safely.

Every uninstall checks for verified, untracked Galaxy XR identity residue after restoring recorded settings, including installations whose journal is marked modern. Recorded originals and original empty sections remain protected. A receipt-owned package with an intact, matching manifest can be removed even if its DLL is missing.

Maintenance results distinguish `complete`, `attention-required`, and `incomplete`, and include preserved locations and unresolved items. A failed removal never reports success; recovery records are retained while the driver data tree still exists, and retry finishes the remaining cleanup. Missing SteamVR with remaining recovery records blocks changes; local-only cleanup without such records reports the verification limit. Reopening Companion after uninstall uses app defaults in memory without recreating active configuration. Pending GUI writes and stale reads cannot restore removed data.

After completed removal, an explicit app-preference edit may save new preferences; driver writes remain blocked until installation or an explicit reset. Failed maintenance retries preserve this distinction. Incomplete removal keeps both writers blocked, and rejected edits roll back visibly.

## Settings check and presentation

The checker and rendered fields share stable IDs and control labels. Primary results show **Tab → Container → Setting**, saved state, and value source; raw files and keys are disclosed under **Technical details**. A **Show setting** link opens its parent sections and focuses the control. Advanced visibility is temporary; unavailable controls explain their prerequisite without changing it. Unreadable configuration remains **Unknown**, never an inferred Off.

All six tabs use concise page summaries. Fluent buttons, badges, message bars, spinners, and dialogs identify state with text and icons as well as color. Calibration and profile-transfer procedures have named dialogs. Existing information-button descriptions remain unchanged. Historical driver verification is distinguished from unknown current SteamVR status.

The About page now groups project resources into icon cards, gives version/update
status its own panel, and separates contributor credits from support links.
Internal navigation links use consistent action styling and keyboard focus.
External resources retain their destinations and open through the system browser;
an opener failure presents a dialog with the address available to copy.

## Acceptance matrix

| Scenario | Required result | Verification |
| --- | --- | --- |
| Restore modified driver/app settings | Package defaults reload; installation and named profiles survive; backup exists. | Native reset fixtures; GUI service/lifecycle tests; browser confirmation flow. |
| Uninstall, reopen, reinstall same version | Active settings stay absent on reopen; next install starts at defaults; profiles and backups are removed. | Native install/uninstall round trip; browser with in-memory IPC. |
| External SteamVR edits and unrelated drivers | Preserve later edits and independently owned registrations/settings. | Native journal and ownership fixtures. |
| Corrupt recovery data, missing SteamVR, locked files, concurrent edits | Block unsafe changes or report incomplete work; retain retry evidence; never claim complete removal. | Native failure/rollback fixtures and Setup result tests. |
| Cancel/Escape, running or unknown SteamVR, busy operation | No maintenance mutation; clear disabled state; confirmation focus and cancellation remain usable. | Setup action tests and browser dialog checks. |
| Checker location and advanced target | Human-readable labels, stable links, focus/ancestor reveal, no writes or prerequisite changes. | Catalog/navigation tests and browser navigation checks. |
| Unknown runtime after prior verification | Keep historical verification distinct; do not claim SteamVR is stopped. | Setup regression test. |
| Distortion Import .json | File chooser opens; cancelling selection does not change settings. | Production browser file-chooser check. |
| Six tabs, dialogs and status states | Readable in light/dark themes and narrow/wide layouts; keyboard access; existing info text preserved. | Production-bundle browser captures plus inspection. |
| Package gate | Full driver and GUI portable build exits zero and prints `Built test package: ...`. | `powershell -NoProfile -ExecutionPolicy Bypass -File tools/Build-Portable.ps1`. |

Browser fixtures use real production Lit/Fluent components with in-memory native IPC. They do not prove live SteamVR restoration, headset image quality, or controller tracking. Package validation also does not replace a live headset check.

## Implementation entry points

- Native maintenance: `GalaxyXRDriverGUI/src-tauri/src/driver_installation.rs` and its `settings_cleanup.rs` module.
- GUI lifecycle and write suppression: `src-lit/services/system-diagnostic.ts`, `settings-base.ts`, and `src-lit/platform/writer.ts` under `GalaxyXRDriverGUI`.
- Presentation and navigation: `src-lit/domain/settings-presentation.ts`, `features/page-base.ts`, `shell/app-shell.ts`, and `ui/presentation.ts`.
- Focused checks: `tools/Test-SetupLayout.cjs`, `tools/Test-CompanionBrowser.cjs`, and the native/Vitest suites.

## Verification results

- GUI unit tests: 196 passed.
- Rust installation, reset, uninstall, recovery, and runtime fixtures: 86 passed, including modern-journal historical residue, a missing DLL, concurrent external edits, partial deletion/retry, and saved-profile preservation.
- Setup presentation checks: 62 passed; service/lifecycle checks: 36 passed; Fluent readiness regressions: 36 passed; section/navigation checks: 18 passed; SteamVR settings-diff checks: 19 passed.
- Native journal checks: 36 passed. All 16 toggle-migration scenarios passed.
- Production browser checks: 9 passed using in-memory IPC. Captures cover all six tabs in light/dark themes at 1100px and a narrow 600px layout, the human-readable checker, and the uninstall confirmation. Results and bundle hashes are in `build/companion-ui-validation/results.json`.
- The 166 existing driver/image/distortion information-tip strings remain unchanged. The English source catalog contains 772 unique units; Japanese and Traditional Chinese source translations were not edited.

These checks did not install or remove a live driver, modify live SteamVR settings, or run a headset session.

Both final full native-driver and Companion builds exited zero and printed `Built test package`:

| Variant | Package | Build logs |
| --- | --- | --- |
| Galaxy XR | `output/GalaxyXRDriver-Test-20260926-214322` | `build/portable-logs-20260926-214322-1d42dc964a504506bb434fb4a27e952f` |
| Neutral | `output/GalaxyXRDriver-Neutral-Test-20260926-214548` | `build/portable-logs-20260926-214549-7adc3ea1811c4af7be4be117d223c4a5` |

The Galaxy XR gate used `tools/Build-Portable.ps1`. Neutral validation used its local full-build adaptation `build/Build-NeutralValidation.ps1`, without the native vendor define and with explicit `VENDOR=neutral`. Package identities and executable SHA-256 hashes are recorded in `build/companion-ui-validation/package-validation.json`. The workspace frontend was restored to Galaxy XR afterward and its asset hashes match the browser-tested bundle exactly. Builds retain existing vendored C++/linker and frontend bundle-size warnings.

The package results above are historical maintenance-build evidence, before the
subsequent About/link polish. The current CI-first policy in `AGENTS.md` applies
to that follow-up: focused frontend and browser validation, with no new full local
package or GitHub build claimed. Older packages can be removed under the workspace
retention policy; the retained complete package also predates this UI follow-up.

## About and link follow-up verification

- `npm run build:ui` passed TypeScript and all three production locale bundles.
  The existing bundle-size advisory remains. The English source catalog now has
  789 units; existing Japanese and Traditional Chinese catalogs are unchanged.
- Vitest: 196 passed. Setup layout: 63; About/Setup services: 36; section cards:
  18; Fluent regression checks: 36.
- Production browser: 13 scenarios passed with in-memory native IPC. Every one
  of the nine About destinations opened exactly once through the mocked opener
  with both click and Enter, preserving the app route and settings. Failure
  feedback restored focus. Update loading/current/error/retry/new-release states
  and internal link keyboard focus/navigation also passed.
- Visually reviewed full About captures in light and dark themes at 1100 px and
  dark mode at 600 px. Resource cards and credits reflow without overlapping.
  Captures, scenario results and bundle hashes are under
  `build/companion-ui-validation/`.
- Guarded workspace cleanup preview and apply found zero eligible locations:
  zero bytes removed, zero protected skips. All 148 retained-package SHA-256
  hashes matched. The retained package is
  `output/GalaxyXRDriver-Test-20260926-215043`; it predates this UI follow-up.
- No commit, push, live installation, or GitHub build was performed for this pass.
