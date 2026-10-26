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

On reopening the Companion, a saved enabled selection is armed again after both settings files load successfully. The Enable switch reflects the Companion's current armed state; a failed restore appears beside that switch and can be retried by enabling it again. If Async Spacewarp is also saved On, startup leaves it untouched and asks you to enable Optical Flow again to switch modes. An explicit mode switch waits for the Async Spacewarp Off write to succeed before arming OFXR.

Async Spacewarp's separate **Force half-rate** switch stores mode 1; Off is Automatic (2026-10-26). Automatic publishes normal late-frame recovery until the application's measured cadence stays below 90% of the headset refresh for 500 ms, then half rate; it returns to normal after the cadence stays at or above 97% for two seconds. Force half-rate keeps it on regardless of game FPS. Half rate is client-side frame selection (45 selected stream frames plus 45 synthetic display slots at 90 Hz; 36/36 at 72 Hz); it does not throttle the game or promise PC GPU savings. The dated `spacewarpSettingsVersion` migration advances without rewriting a saved enable/mode choice.

An explicitly selected OFXR version must be available exactly: the Companion reports a missing version instead of loading another one. Reinstall uses the matching bundled payload and preserves external OFXR installations; Automatic reinstalls the bundled seed. An enabled selection is rearmed after reinstall. Uninstall Optical Flow removes Companion-owned registration and runtime directories.

OFXR is an OpenXR layer, so ordinary OpenVR games do not automatically use it. It needs a compatible graphics API and GPU, an installed NVIDIA driver providing Optical Flow for the NVIDIA backends, and the x64 Microsoft Visual C++ Redistributable. Armed confirms layer registration, not successful NVIDIA initialization or displayed generated frames.

**Minimize to tray** is On by default under **App Settings → Window**. The Minimize button hides the Companion and its visible graph preview to the system tray without stopping Optical Flow. Click the tray icon or choose **Open Companion** to restore it. Choose **Quit** to save pending edits, exit, and disarm Optical Flow. The window's Close (X) button asks first and closes the Companion; the **Close button** row on the same page can make it close immediately or minimize instead.

Turn the preference Off for normal taskbar minimization; the X follows the **Close button** row either way. The choice applies immediately and is preserved across launches. An older preferences file without the key receives the On default. Tray failures stay visible and keep the window accessible. ASW runs in the driver and patched headset client and does not require the Companion window to remain open.

When hidden to the tray, the Companion and graph explicitly hide their WebViews and request WebView2's Low memory target. Restoring a window requests Normal again. This is best effort cache/memory reduction; the app keeps scripts running for settings saves and Quit. No fixed amount of reclaimed RAM is guaranteed. Hidden pages defer reactive redraws until visible, and normal Chromium background throttling remains enabled.

Runtime verification on Setup and Image Settings runs process/file inspection on a worker thread and requests only required process information. It no longer performs redundant system-wide scans on the native UI thread. This removes a source of periodic window-movement stalls; Windows drag smoothness still needs native runtime verification.

## Icon credits

Galaxy XR icons were made by **Vilkka**. Based on original Quest Pro iconpack made by **Lux / Hekky**. See the repository `CREDITS.md`.
