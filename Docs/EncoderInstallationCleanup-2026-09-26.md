# Encoder installation and cleanup verification — 2026-09-26

Fresh installation uses the same 26 NVENC defaults as the local
`CustomHeadsetOpenVrGxR/CustomHeadsetOpenVR/src/Config/Config.h` reference.
Existing explicit choices survive reinstall. Stale runtime `info.json` defaults
no longer override packaged NVENC/post-pack defaults in toggles, sparse saves,
or reset buttons. Other runtime defaults retain their existing behavior.

Clean Settings and Uninstall Driver are disabled until SteamVR is confirmed
stopped. Detection includes vrserver, vrmonitor and vrcompositor, even before
driver installation or without a registered SteamVR path. Click handlers refresh
the status, and native commands independently reject running SteamVR.

Clean Settings writes explicit encoder-off choices and the current NVENC
migration stamp, so later GUI saves and driver starts preserve stock encoder
passthrough. Post-pack processing is also off. Other settings use driver defaults.
Uninstall removes the installed hook/configuration and restores journaled SteamVR
settings. Exact saved legacy extras are cleaned across mirrored profiles as well
as driver_vrlink; external edits and journal-protected originals are preserved.
Neither action changes NVIDIA Control Panel settings.

Verified locally:

- GUI Vitest: 172/172 tests.
- Native Rust installation, cleanup and process-status tests: 72/72.
- Setup service checks: 26/26; Setup layout/action checks: 54/54.
- GUI readiness: 36/36; SteamVR settings diff: 19/19.
- Actual native configuration parser: all 14 migration/default/reset scenarios passed.
- NVENC passthrough: 60/60; companion settings ownership: 447/447.
- Generated C++/GUI defaults match; all 26 reference NVENC defaults match.
- Cavecrew diff review: no actionable findings. Git diff whitespace check passed.

Full driver + GUI package builds both exited 0 with `Built test package`:

- Galaxy XR: `output/GalaxyXRDriver-Test-20260926-181358`, from the required
  `powershell -NoProfile -ExecutionPolicy Bypass -File tools/Build-Portable.ps1`.
- Neutral: `output/GalaxyXRDriver-Test-20260926-EncoderCleanup-Neutral`, from
  `build/Build-NeutralValidation.ps1`, a temporary copy of the same full build
  using no Galaxy XR C++ define, the neutral manifest/default-settings section,
  and an empty GUI vendor flag. Both packaged manifests, DLLs and GUIs were checked.

The MSBuild release entry point `node build.js --vendor galaxyxr` could not run:
no registered MSBuild installation was found. Both full portable builds instead
used the existing MSVC/Rust toolchains. Logs are in
`build/encoder-cleanup-portable-build.log`, `build/encoder-neutral-portable-build.log`,
and `build/encoder-cleanup-rust-tests.log`. Generated GUI vendor selection was
returned to Galaxy XR afterward. Existing unrelated working-tree changes were kept.

No live install, uninstall, cleanup, SteamVR restart, or headset session was run.
These results prove source behavior, isolated regressions and packaged builds;
they do not claim live headset verification.
