# Handoff: ColourLab start-path verification and NVENC overshoot

Prepared 2026-10-23, Europe/Paris. This is an investigation handoff, not a
confirmed fix. No source behavior, encoder settings or running software was
changed while preparing this document.

## Objective and user steering

Prioritize **SteamVRColourLab as the suspected workload/startup trigger** for
the oversized-output and VRLink reset failure. The user reports that tests can
work when started with SteamVR's desktop view open, but fail when started from
the headset in another way. They have seen the failure at both 15 and 45 seconds.
Do not spend the next pass treating duration as the primary distinction or
repeating only the driver-settings audit.

Determine whether ColourLab changes the actual submitted content, animation,
submission cadence, render size, overlay composition or startup sequence between
these routes, and whether that difference triggers NVENC output beyond its
requested budgets. Fix demonstrated defects and verify using completed encoded
bytes and output sizes. Preserve the user's AV1 / 500 Mbps setting.

The user's suggestion that ColourLab causes larger packets is a hypothesis to
test. ColourLab submits eye textures to SteamVR; it does not directly construct
NVENC bitstreams or VRLink network packets. Distinguish triggering difficult
content from directly controlling transport size. Do not modify/hook VRLink's DLL.

## Repositories and authority

- Driver: `D:\Angelo\Desktop\SteamLink-GalaxyXR-Windows-Toolkit-FULL\GalaxyXR-Driver`.
- Workload: `D:\Angelo\Desktop\SteamLink-GalaxyXR-Windows-Toolkit-FULL\SteamVRColourLab`.
- Evidence root: `D:\Angelo\Desktop\SteamLink-GalaxyXR-Windows-Toolkit-FULL\builds\GalaxyXR-Driver\build\bitrate-monitor`.
- Read each repository's current AGENTS.md and applicable skills before edits.
  The driver working tree contains extensive unrelated changes; preserve them.
  Treat the sibling ColourLab checkout as its own project with its own artifact root.
- This request is to write a handoff. It does not authorize new tests, deployment,
  restarts, device actions or source fixes in this writing pass. Carry forward the
  user's earlier testing/fix instructions when continuing, within repository policy.
- The previous Computer Use session was stopped with physical Escape. No further
  app input was issued afterward. Resume app control only in an appropriate new turn.
- An earlier prompt requested two-pass quarter-resolution encoding. **That
  experiment is on hold:** latest steering is to isolate ColourLab first, keeping
  encoder settings unchanged. Do not infer that the user applied that change.
- A later implementation in GalaxyXR-Driver requires focused checks and the full
  local portable build gate in AGENTS.md. Writing this handoff is not such an
  implementation. Builds do not authorize installing the result.

## What was actually observed

Times below are Paris local time (UTC+2 on this date). ColourLab events store UTC.

| Observation | Evidence and limits |
| --- | --- |
| Desktop-started 15-second noise case `389562fcaf2b478fa99a9555f95b74ba` | Start requested 11:34:01.541; finished 11:34:21.593 with elapsed 15.0, 1,352 stereo submissions, `interrupted=false`, `desktop_preview_only=false`. There was roughly five seconds of waiting before its test clock started. |
| Clean measured portion of that case | `noise-repro-20261023-113319/samples.jsonl`, rows 174–232 inclusive: 59 adjacent windows totaling 14.76723 s; actual completed NVENC output weighted mean **236.511 Mbps**, minimum **211.202**, maximum **264.162** over approximately quarter-second windows; no new packet drops. Effective target ranged **230–274 Mbps**. This is **not** a clean 500 Mbps stress-test result. |
| 45-second case `5d332ed6a0f5430aae0ec728ae3a574e` | Start requested 11:35:10.323522; first new `Packet too big` at **11:35:10.407**, approximately **83.5 ms** later. Ended 11:35:55.358 with 4,023 app submissions. The user was operating the headset during this later run. The event schema does not explicitly record which Start button was used. |
| Failure during that case | Saved log contains **518 oversized-packet drops and 518 stream-reset-request lines** during 11:35:10–11:35:55. Last drop 11:35:55.300. App submissions continuing do not prove successful stream delivery. Future runs must abort much earlier. |
| Encoder state before that failure | 11:35:08.227 heartbeat: requested average/max **500/500 Mbps**; successful prior reconfigurations, no reported NVENC encode failures. That heartbeat is a parameter trace, not independently measured output bitrate. |
| Different startup state | In the clean run, the global SteamVR dashboard was visible before the timed interval, and the target adapted down. Heartbeats bracket the failing start at 500 Mbps (about two seconds before Start and again afterward); there is no exact first-submission accepted-target record. This is a major confound: neither result isolates Start-button identity alone. |
| User's latest reproduction | Both 15 and 45 seconds can fail when started from the headset; opening SteamVR desktop view can change the outcome. This is user-reported evidence. Do not equate “desktop view,” global dashboard visibility, ColourLab's VR overlay and a Windows desktop preview without recording each separately. |

The 100-second `summary.json` in the noise-repro folder includes baseline,
waiting, test and recovery. **Do not call its whole-capture mean or peak the
noise-only result.** Continuous counter sampling had ended before the subsequent
45-second run; that run is supported by app events and the saved SteamVR log,
not a newly measured noise-only bitrate curve. No matching decoder-input rate or
full oversized buffer was captured for that later run.

The inferred five-second static-noise warmup follows from code and event timing;
the exact first submitted/animated frame and clock-start time were not logged.
Zero logged oversized-packet faults does not establish zero transport loss.

## Source findings to start from

Paths and lines were checked on 2026-10-23; re-check against the current tree.

1. **Both Start routes share the same application method.**
   - `SteamVRColourLab/colourlab/ui.py:230`: desktop Start first copies its local
     workload/duration/target fields through `bitrate.configure`, then calls Start.
   - `SteamVRColourLab/colourlab/dashboard_ui.py:296`: headset Start calls
     `app.start_bitrate()` directly, using existing shared values.
   - `SteamVRColourLab/app.py:281`: Start ignores duplicate starts, disables
     cycling, preserves the previous settings, applies the selected full-screen
     workload in reference mode with labels off, and collapses its VR controls.

2. **Menu state changes the transition and noise timing.**
   - `colourlab/dashboard.py:207`: headset pointer release dispatches the button.
   - `app.py:509`: dashboard callbacks run before rendering that loop iteration.
   - `colourlab/dashboard.py:97`: collapse updates/uploads the compact recovery
     overlay immediately. Inspect this GPU work and overlay composition around Start.
   - `app.py:514`: until the test clock starts, the workload receives `seconds=0`.
     Thus waiting can submit static noise before animated noise begins.
   - `app.py:535`: the clock starts only after a successful submission with no
     obscuring dashboard. `colourlab/dashboard.py:129` checks the expanded local
     controls, its dashboard overlay and the global SteamVR dashboard.
   - Consequently a Start while the global dashboard is open can create a
     different static-noise/adaptation warmup from a headset Start without it.
     This is the leading comparison to isolate, not an established root cause.

3. **Concrete UI synchronization defect, separate from oversize causality.**
   - `colourlab/dashboard_ui.py:134`: headset bitrate edits update shared state.
   - `colourlab/ui.py:285`: desktop refresh updates ordinary settings but omits
     bitrate workload/duration/target. Desktop fields can therefore show 15 while
     shared state, used by headset Start, still says 45. A later desktop Start
     can overwrite shared state with those stale local fields.
   - Verify intended editing behavior and fix with appropriate regression coverage
     in a later implementation. This explains misleading controls; it does not
     establish why NVENC produced an oversized output.

4. **Duration itself does not change encoding load.**
   - `colourlab/bitrate.py:39–76`: duration controls validation and completion.
   - `colourlab/shaders.py:69–80`: noise uses `gl_FragCoord`,
     `floor(u_seconds * 90)` and an unsigned seed. No duration branch was found.
   - `colourlab/gl.py:218`: `bitrate_noise` selects shader pattern 9.
   - `colourlab/vr.py:104–111`: full-screen identity transform and per-eye draw /
     compositor submission. Inspect actual negotiated eye dimensions and texture
     identity, not just selected UI labels. Both eyes currently use the same
     noise time/seed; “maximum load” does not mean independent stereo entropy.

## Runtime identity and encoder facts from the previous capture

These are historical matching-capture identities, **not current-state assertions**.
Refresh them before another live comparison.

- `vrserver.exe` PID **26780**, started 2026-10-23 11:14:07 Paris.
- Native driver version 1.14.0, loaded from
  `C:\Users\Angelo\AppData\Local\GalaxyXR\Drivers\GalaxyXRNative-1792746511186046900\bin\win64\driver_GalaxyXRNative.dll`.
- Driver SHA-256: `74e940cdff8adf9ddbdfab04cf9a4d07bb1cca4f4c1bc031c64de9ed0c9c5f87`.
  Binary strings indicate dirty-tree corrective changes; do not assume this is
  byte-equivalent to the tagged release because its display version matches.
- VRLink SHA-256: `8e7100b6b1e88d3ad6dd05f30f030dc9a69b092b64a60d35347cebb5c516b55d`.
- ColourLab PID **5472**, packaged executable under
  `builds\SteamVRColourLab\dist\SteamVRColourLab\SteamVRColourLab.exe`.
- AV1, encoded geometry **1536x6144**, nominal 90 FPS, saved bandwidth 500,
  Force CBR off, effective last-successful rate-control mode **1 = VBR**.
  Scaling reference clamp 350, Linear / Constancy 0%, headroom 0%, VBV 2,
  split mode 1. Verify missing settings against defaults rather than assuming.
- `NvencTap.cpp:1314`: scaled average is capped at the configured ceiling;
  VBR maximum follows headroom, here 500/500. Force CBR off preserves the upstream
  mode; it does not actively force VBR on every initialization.
- At 500 Mbps / 90 FPS, the average budget is 694,444 bytes (0.662 MiB).
  Two-frame VBV requests 11,111,111 bits (1.325 MiB). These requests alone are
  not a software-enforced per-output byte cap. The much larger outputs remain
  a real symptom requiring explanation; do not dismiss sustained overshoot as normal.
- `RecordLast` runs before NVIDIA returns (`NvencTap.cpp:1565`). Distinguish
  attempted parameter telemetry, last-successful configuration and measured bytes.
- Effective QP-map mode/distribution and full accepted RC constraints were not
  logged. If the ColourLab comparison cannot isolate the trigger, capture these
  before blaming negative QP deltas, inherited QP limits, multipass or NVIDIA.

## Evidence locations and interpretation limits

All paths below are relative to the evidence root above unless otherwise stated.

- `noise-repro-20261023-113319/`: `samples.jsonl`, saved settings,
  `vrserver-live.txt` (first capture only), `vrserver-after-45s.txt` and
  `colourlab-events.jsonl`. In the saved full log, line **7435** is the later
  run's first packet drop; line **7427** begins its preceding 500/500 heartbeat.
- Original ColourLab run:
  `builds/SteamVRColourLab/dist/SteamVRColourLab/runs/20261023-112709-469924/`.
  Preserve its events, workload JSON files, session metadata and host logs.
- `vbr-audit-20261023-112557/`: three complete fresh encoded samples and
  `fresh-buffer-evidence.json`, plus complete `sequence-context.obu`.
  Independent parsing found **one shown inter picture per complete sample**,
  no hidden-picture bundle in those samples. They were not the failing first frame.
- Same folder: `retained-keyframe-prefix.partial.obu`,
  `retained-oversized-framing.json`, `sequence-context.json`. A retained
  3,783,093-byte keyframe has only its first 2 MiB copied. Available headers
  declare one frame header and a large tile group ending at the reported size;
  the complete oversized payload was not captured/decoded.
- The earlier session's 3.81 MiB maximum predates the later 45-second run.
  Do not assign that lifetime maximum to its first drop without a matching frame.
- `noise-desktop-20261023-113854/` contains only a prepared capture script.
  Computer Use was stopped before the proposed second desktop test. It is
  **not a completed test or measurement**.
- `comparison-20261022/` contains earlier controlled captures. Keep historical
  binaries/settings separate from today's matched session.
- `Docs/NvencBitrateValidationPlan.md` has earlier driver-oriented test guidance;
  this handoff changes the immediate priority to ColourLab start-state isolation.

## Next verification: isolate ColourLab before tuning the encoder

1. Record exact source revision plus dirty diff, packaged ColourLab hash/shader
   identity, loaded native/VRLink hashes, PID/start time, settings, actual eye
   dimensions and NVENC completed-byte baseline. Source inspection alone does
   not establish what the packaged executable is running.
2. Add bounded PC-side timing evidence if needed: Start origin, shared versus
   desktop-displayed values, all menu/desktop-view/focus states, first submitted
   noise frame, first animated frame, tick/seed, per-eye size, compositor result,
   and exact test-clock start. Align those events with encoded output, not only
   the UI timer. Do not add observer work that changes the tested startup path.
3. Keep AV1 / 500 / VBR / resolution / FPS / split / multipass / curve unchanged.
   Record actual upstream request and applied encoder target at each boundary.
   A clean run at 236 Mbps does not establish stability at 500.
4. Compare the following **matched startup states**, using the same duration
   initially. Confirm what the user means by SteamVR desktop view in the actual
   headset UI; record it independently from the global dashboard.

   | Arm | Start route and state | Question |
   | --- | --- | --- |
   | A | Desktop Start, global dashboard closed, encoder target already 500 | Does desktop Start fail without the warmup? |
   | B | Headset Start, same closed-dashboard/500 state | Does entry route alone change the outcome? |
   | C | Desktop Start with SteamVR Desktop View open | Which focus/overlay/target transition accompanies success? |
   | D | Headset Start with SteamVR Desktop View open, if the UI allows it | Does matching Desktop View remove the route difference? |
   | E | Repeat a failing condition with a deliberate approximately five-second static-noise warmup | Does the warmup account for the clean result? |

   Do not silently force constancy or lower the ceiling to manufacture matching
   targets. Record the global dashboard state separately in every arm; do not
   assume Desktop View can remain open with the dashboard closed. Mark unmatched
   arms inconclusive. Repeat promising pairs in reverse
   order, avoiding inherited reset-state contamination. Only then compare 15/45 s.
5. Collect adjacent exact completed-byte counter deltas using the read-only
   `tools/bitrate_monitor` sampler. Use actual elapsed time, decimal Mbps and a
   clearly stated window size. Report unique buffers where identifiable, frame
   sizes and first failure time, not only running averages or lifetime maxima.
6. Capture the **first failing output** before reset amplification if additional
   instrumentation is necessary. The current probe's 2 MiB copy cannot establish
   a full 3–4 MiB buffer's contents. Use a bounded complete capture and explicit
   truncation rejection; retain no unlocked NVENC pointer. Count AV1 pictures
   structurally, and associate encoder/output handle, generation and frame index.
7. Stop/restore immediately on a storm; never repeat the accidental 45-second
   exposure. Existing plan allows at most 10 oversized drops within five seconds;
   stop earlier for a freeze, disconnect or encode failure. Record restores and
   invalidate interrupted measurement windows.

Do not interpret compositor layers or multiple NVENC strips as multiple video
frames. The current inflight counter is contaminated by successful EOS/flush
calls and incomplete pairing (`NvencTap.cpp:1856`, `:1987`); values near 500 or
1,000 do not prove that many frames are queued or sent simultaneously.

## Completion criteria for the successor

Explain the start-path difference with correlated app and encoded-output evidence.
Identify which ColourLab defect, if any, causes it; preserve a failing matched
case before changing behavior. If the same content/startup state reproduces
equally through both routes, state that and move to encoder investigation rather
than declaring ColourLab guilty by assumption.

A fix must make the previously failing start route stable under the intended
500 Mbps request, without silently reducing settings, weakening the noise test,
truncating encoded bytes or counting dropped outputs as delivered video. Verify
budget adherence, frame sizes and absence of reset storms. Separate host NVENC
production from headset decoder receipt; neither UI settings nor WLAN all-traffic
counters prove delivered video bitrate or presentation. If the transport threshold
is still unknown, do not promise a specific hard per-frame cap.
