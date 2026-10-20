# Galaxy XR Companion frontend and Tauri backend

See **`../README-GALAXY-XR-COMPANION.md`** for current replacement, full portable-build and release instructions. The frontend is TypeScript + Lit + Fluent Web Components; it no longer uses Angular or Angular Material. The supplied current Rust backend is under `src-tauri`.

From this directory:

```powershell
npm ci
npm start           # Tauri development application
npm run build      # Tauri application, not just frontend files
```

`dev:ui` runs the frontend server and `build:ui` typechecks/builds the localized frontend. These do not produce a complete portable GUI + driver package; use the root portable-build script for that. Native commands require Tauri, so a plain browser does not reproduce native functionality.

`src-lit` contains application/domain/services/components; `src/locale` retains translation catalogs; `public` contains static assets; `src-tauri` contains Rust, native permissions, application configuration and icons. The locale converter keeps en-US, ja and zh-Hant entry points. New untranslated strings fall back to their English source text. Do not use the retired Angular `ng extract-i18n` workflow.

For the new mode/navigation regression suite, run `node ../tools/Test-CompanionModes.cjs` after installing the pinned dependencies.

## Keeping Optical Flow running

Optical Flow needs the Companion to remain running while you play. Its card displays this requirement even with Advanced Mode off. Enable it before launching or restarting the game.

**Minimize to tray** is On by default under **App Settings → Application preferences**. Minimize and the window's Close button hide the Companion and its visible graph preview to the system tray without stopping Optical Flow. Click the tray icon or choose **Open Companion** to restore it. Choose **Quit** to save pending edits, exit, and disarm Optical Flow.

Turn the preference Off for normal taskbar minimization and Close-to-exit behavior. The choice applies immediately and is preserved across launches. An older preferences file without the key receives the On default. Tray failures stay visible and keep the window accessible. ASW runs in the driver and patched headset client and does not require the Companion window to remain open.

When hidden to the tray, the Companion and graph explicitly hide their WebViews and request WebView2's Low memory target. Restoring a window requests Normal again. This is best effort cache/memory reduction; the app keeps scripts running for settings saves and Quit. No fixed amount of reclaimed RAM is guaranteed. Hidden pages defer reactive redraws until visible, and normal Chromium background throttling remains enabled.

Runtime verification on Setup and Image Settings runs process/file inspection on a worker thread and requests only required process information. It no longer performs redundant system-wide scans on the native UI thread. This removes a source of periodic window-movement stalls; Windows drag smoothness still needs native runtime verification.

## Icon credits

Galaxy XR icons were made by **Vilkka**. Based on original Quest Pro iconpack made by **Lux / Hekky**. See the repository `CREDITS.md`.
