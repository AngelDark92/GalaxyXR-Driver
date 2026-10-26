# Runtime evidence channels for encoder/codec failures

- Driver log lines (`DriverLog`/`VRDriverLog`) land in the SteamVR-side `vrserver.txt` rotation, not in `driver_vrlink.txt`, which is the vrlink streamer's own log. Vrlink sync/overflow lines mirror a stalled stream; they do not carry driver instrumentation.
- Failure log lines dedupe on change in both directions. A failure is logged only when its status/error differs from the previous one, and early connection setup can precede a working log sink. Treat log absence as a visibility gap, not proof of success.
- `info.json` is the reliable channel. The tap persists `requestedCodec`, `lastStatus`, `error` with the full request description, plus `lastInitStatus`/`initError` so a reconfigure retry storm cannot bury the init call's fate. Include the failing request in persisted failures, not just the last error text.
- The driver process is per connection. Heartbeat/stat counters reset each process. Check `observedAt`/PID freshness before reading counts; a fixed vrlink retry pattern can produce the same counts on different attempts.
- The Steam Link client negotiates a per-codec tile class (H.264 at 1024x4096; AV1/HEVC at 1536). A stored tile above the negotiated class must surface as a visible refusal or a visibly applied default. Verify with the on-box refusal message, not user recall.
- An installed driver folder is not necessarily the checkout's tree. Identify the tested binary by its `info.json` version/module path before attributing failures to current source.
- Codec selection integrity is owner policy: the selected codec is the running codec. Never substitute another codec on failure; fail visibly with the NVENC status and request.
