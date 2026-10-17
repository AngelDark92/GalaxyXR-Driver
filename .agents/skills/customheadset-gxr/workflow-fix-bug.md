# Fix a bug

1. Describe the concrete trigger, observed failure and expected behavior.
   Reproduce with a targeted fixture or existing evidence when possible; distinguish
   observed defects from hypotheses. An audit-only request authorizes reporting,
   not fixing, unless later user steering changes that scope.
2. Trace the owning path using the workspace map. Record current settings/schema,
   vendor and relevant headset modes. For runtime diagnosis, match fresh process
   IDs, loaded module paths/hashes and telemetry; do not promote stale logs to
   live proof. Device/SteamVR actions need session authorization.

## Runtime evidence channels for encoder/codec failures

- The driver's own log lines (DriverLog/VRDriverLog) land in the SteamVR-side
  `vrserver.txt` rotation under the Steam logs directory — NOT in
  `driver_vrlink.txt`, which is the vrlink streamer's own log (its sync/overflow
  lines mirror a stalled stream; they do not carry driver instrumentation).
- Failure log lines dedupe on change in both directions (a failure is logged
  only when its status/error differs from the previous one), and per-call
  details from early connection setup can precede a working log sink and then
  never re-log if the failure state stays identical. Treat log ABSENCE as a
  visibility gap, not proof of success.
- `info.json` is the reliable channel: the tap persists its failure state there
  (`requestedCodec`, `lastStatus`, `error` with the full request description,
  plus `lastInitStatus`/`initError` so a reconfigure retry storm cannot bury
  the init call's own fate). Include the failing REQUEST in persisted failures,
  not just the last error text — early failures and useless
  `GetLastErrorString` output otherwise hide root causes.
- The driver process is per-connection; heartbeat/stat counters reset each
  process. Check `observedAt`/PID freshness before reading counts; a fixed
  vrlink retry pattern (one init, N reconfigures, then shutdown) produces the
  same counts on different attempts.
- The Steam Link client negotiates a per-codec tile class (H.264 at the
  1024x4096 tile class; AV1/HEVC at the 1536-tile class). A stored tile above
  the negotiated class must surface as a visible refusal or a visibly applied
  default — a user who reports a larger tile 'worked' at an older build may
  have been silently running the negotiated size; verify with the on-box
  refusal message, not recall.
- An installed driver folder is not necessarily the checkout's tree; identify
  the tested binary by its info.json version/module path before attributing
  failures to current source.
- Codec selection integrity is standing owner policy: the selected codec is the
  running codec; never substitute one codec for another on failure — fail
  visibly with the NVENC status and the request.

3. Fix the narrow cause and preserve tuning, defaults parity, neutral/Galaxy XR
   identity, legacy headset support and journal ownership. Add both migrations
   if meanings change; keep dependency source read-only.
4. Choose regression coverage that fails for the original bug and verifies the
   user outcome, plus meaningful adjacent cases such as disabled mode, reset,
   migration, partial failure or the other vendor. Avoid implementation-mirroring
   tests and unrelated full builds. Know each focused runner's compile coverage
   (what TUs it actually compiles) before calling a receipt an all-clear.
5. Keep compiler output, logs, test fixtures, screenshots and generated frontend
   assets under `../builds/GalaxyXR-Driver/`. Run relevant focused checks and
   `git diff --check`. A full local build requires user request or a build issue.
6. Re-read the changed execution path, run the final appropriate check once,
   update help/docs if behavior changes, and clean task-owned successful fixtures.
   Preserve unresolved failure evidence and the last verified complete package.
7. Report the cause, behavior change, verification and evidence limits with
   actual path/line references. Claim CI only from a verified successful run;
   claim headset/runtime behavior only from current authorized observation.
