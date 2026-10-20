# Bitrate Curve window maintenance

The Companion opens `/<locale>/curve.html` only on request. Vite builds this
entry for all three locales alongside `index.html`; the asset verifier rejects
a package without either entry or its referenced assets. `curve-main.ts`
imports only the preview and localization, without the application context.
The HTML Close control and Escape handler work even if the graph module fails.

`curve_preview.rs` creates the native window from an **async command**. Tauri
2.12.4 documents that WebView2 creation from a synchronous command can deadlock
on Windows. The graph uses its own WebView2 data directory because the main
window has custom browser arguments; different arguments in a shared WebView2
environment are another documented cause of a frozen second window. This
directory is a runtime browser profile, not build output. No hidden graph,
polling thread, timer or helper executable runs before Open or after close.

The Companion publisher subscribes to edits and reloads only while the window
exists. It sends the current effective values, including merged defaults, with
native events. Opening snapshots the same values; listening before the initial
read prevents startup races. Native read/close commands identify the calling
window; only `main` may open or publish. The graph has no settings service,
writer, migrations or driver actions. Invalid plotting values display an error
without rewriting a user setting or drawing a substituted value.

Checks after frontend changes:

```powershell
# From GalaxyXRDriverGUI
npm test
npm run build:ui
# From the repository root, with Playwright available through NODE_PATH
node tools/Test-CurvePreviewBrowser.cjs
node tools/Test-CompanionBrowser.cjs
```

`build-tools.yml` runs these production-asset browser checks against installed
Edge. Its pinned Playwright QA dependency belongs under the external artifact
root's `build/browser-qa-tools/`. Release CI remains build-only.

For explicit native QA after a full portable build, with an already installed
Galaxy XR driver, Advanced Mode on and the encoder override enabled:

```powershell
node tools/Test-CurvePreviewPackaged.cjs '<absolute path to packaged Companion.exe>'
```

Close other Companion and SteamVR sessions first. This launches the supplied
package with temporary remote debugging arguments, clicks the real Image
Settings controls, moves/resizes the actual OS window and tests all close paths,
reopening, duplicate prevention and the graph's WebView2 process lifetime.
Saves from those control edits are intercepted **in the test process only**;
the runner verifies that the existing `settings.json` remains byte-identical.
It neither installs the package nor changes the installed driver. Its screenshot
and receipt go to external `build/curve-window-validation/`. This establishes
native packaged-window behavior, not headset encoding behavior.

## GitHub workflow approval

GitHub now creates approval-required PR workflow runs when PRs are created or
synchronized using `GITHUB_TOKEN`. The observed runs 39336201922 and 39336201974
had `action_required` and zero jobs; no compiler had failed. A job-level push
skip cannot remove a gate applied before jobs start.

Configure repository secret `PR_AUTOMATION_TOKEN` with an approved repository
automation identity (for example a repository-scoped fine-grained PAT with
Contents and Pull requests read/write, plus Workflows write if backmerges can
update workflow files). Both PR creation and release-version/backmerge pushes
use it. Without it, the workflows retain `GITHUB_TOKEN` and visibly warn that a
maintainer must approve bot-triggered PR runs. Existing gated runs still need
approval or a new authorized run; editing YAML does not approve them.

Sources: [Tauri window builder](https://docs.rs/tauri/2.12.4/tauri/webview/struct.WebviewWindowBuilder.html),
[WebView2 environment discussion](https://github.com/tauri-apps/tauri/issues/13092),
[GitHub token event rules](https://docs.github.com/en/actions/concepts/security/github_token).
