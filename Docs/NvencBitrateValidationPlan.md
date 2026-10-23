# NVENC bitrate and oversized-output validation

Prepared 2026-10-23. Live tests in this plan have **not** been executed. Source
fixes and focused fixtures are separate from packaged, GPU and headset proof.
Do not modify or hook `driver_vrlink.dll` for this investigation.

## Questions and corrected contracts

- Does VBV `0` preserve the caller's exact buffer size during bitrate scaling?
- Can overlapping encode calls retain different generated/converted QP maps
  without either call changing the other's storage?
- Why does the recorded 500 Mbps AV1 workload produce output buffers larger
  than its requested VBV, and can it deliver video above 350 Mbps without resets?

The first two are code defects covered by focused fixtures. They are not proven
causes of the recorded two-frame-VBV failure. No encoder defaults or saved
settings are changed by the corrections; no migration is needed.

At 500,000,000 bits/s and 90 nominal frames/s the average picture budget is
694,444 bytes (0.662 MiB); two nominal frames request 11,111,111 bits of VBV
(1.325 MiB). These are requested rate-control budgets, not enforced output
ceilings. NVENC ignores `maxBitRate` in CBR. NVIDIA documents the keyframe
budget ratio for single-frame VBV plus CBR. An AV1 output buffer can pack a
show picture and preceding no-show pictures; buffer count is not display FPS.

## Gate 1: focused checks, before any installation

Run the NVENC toggle fixture for scaled-bitrate VBV-zero preservation at init
and reconfigure, unchanged caller bytes on success/failure, explicit positive
VBV at nominal FPS, generated/converted map isolation during overlapping or
reentrant calls, inactive/pass-through paths and codec-specific map bytes.
Run the monitor Python suite, relevant Companion tests and frontend compilation
for the corrected labels/catalog. Record actual results in the task receipt.

Compile fixtures can confirm parameters and CPU ownership; they cannot prove
GPU consumption, actual bitrate, decoder receipt or presentation.

## Gate 2: prepare evidence collection before the live session

1. Build through the normal end-of-plan local portable build when authorized. Deployment,
   a SteamVR restart and headset/device actions require their own authorization.
   Confirm the installed binary includes the fixes; saved source is insufficient.
2. Record SteamVR build/branch and VRLink hash, Companion/native version and hash,
   process creation identity, settings snapshot, GPU/driver, exact Steam Link
   version/build/patch hash and the USB Galaxy XR identity. Use the same versions
   for all arms. Start each configuration in a fresh SteamVR process.
3. Prepare bounded, opt-in diagnostics for the missing evidence below. This
   instrumentation is a prerequisite, not an implemented feature of this fix.
   Capture an entire oversized output buffer to PC evidence storage with full
   length, captured length, SHA-256, time, encoder/output handle, generation,
   frame index, picture type and output timestamp. The existing 2 MiB snapshot
   and early 98 KiB dump **cannot** prove the structure of a roughly 3 MiB buffer.
   Choose a documented bounded capture capacity, reject truncation explicitly,
   retain no unlocked NVENC pointers and avoid continuous full-frame dumping.
4. Log the effective request reaching NVIDIA: codec, dimensions, nominal FPS,
   RC mode, average/max bitrate, VBV size/initial delay, keyframe ratio,
   multipass, split, AQ/tAQ, GOP and reset/force-IDR flags. Record effective
   `qpMapMode` plus caller/converted-map min/max, negative/zero/positive counts
   and timing-block contribution. Current size/pointer-only map logs are
   insufficient to establish whether the map affects rate control.
5. Correlate submit/lock events by encoder, output handle, generation, frame
   index and timestamp. Establish unique completed output buffers and detect
   repeated locks/zero-length buffers before calling a counter picture FPS.
   Parse the complete AV1 OBUs to count coded/show/no-show pictures. Do not
   infer those counts from one NVENC buffer's byte length or picture-type enum.
6. Capture decoder-input compressed bytes and accepted input/output counts only
   if compatible telemetry is already available and authorized. Without them,
   report NVENC production and USB-read WLAN RX separately; WLAN includes other
   traffic and cannot prove delivered video bitrate or packet loss.

Keep diagnostics under `../builds/GalaxyXR-Driver/build/bitrate-monitor/` in a
new timestamped directory. Preserve the 2026-10-22 captures unchanged.

## Gate 3: controlled arms, one change at a time

Keep AV1, the negotiated tile/encoder dimensions, refresh rate, forced encoding
FPS 90, Force CBR On, Constancy 0%, split policy and image processing unchanged.
Keep the headset awake and SteamVR dashboard closed. The operator controls
ColourLab; manual workloads between arms are excluded.

| Order | Configuration | Purpose |
| --- | --- | --- |
| A | 300 Mbps, Linear, existing VBV 2 / keyframe 2 / automatic multipass | Establish a clean moving-detail baseline with the corrected binary. |
| B | 500 Mbps, Linear, otherwise identical | Establish whether the failure persists after correctness fixes. Abort promptly on a storm. |
| C | B with explicit two-pass quarter resolution | Isolate the preset merge's observed single-pass selection. |
| D | C with VBV 1 | Isolate single-frame buffer budgeting. |
| E | D with keyframe budget 1 | Test the documented single-frame-VBV/CBR ratio combination. |
| F, conditional | E with two-pass full resolution | Compare only if quarter-resolution still fails and encode latency has headroom. |

Do not run further failure arms just to fill a table. If an arm fails, preserve
its evidence and stop/restore the ColourLab workload. The previous guard of
at least 10 oversized-packet drops within five seconds is the maximum allowed
storm exposure; stop earlier for a frozen view, disconnect or encoder failure.
Do not increase the exposure to obtain a settled average from a failing stream.

Use fullscreen moving detail first: 15 seconds settling and a 60-second measured
window, timed from actual unobscured stereo submissions. Verify a fresh workload
case and scene after each command acknowledgment. Only after stable moving
detail succeeds should changing noise be attempted; it already failed at 300
Mbps in the old capture. Treat noise as an adversarial test, not a game proxy.

For any stable 500 Mbps arm, repeat the same settings at 300 Mbps, then repeat
500. Once stable, compare Linear and Soft Knee at both targets with reversed
order/repeats. Keep shader phase, eye size and actual submission rate matched.
If the fixes still fail, a QP-map isolation experiment needs a separate explicit
implementation that preserves the timing marker; do not disable or alter that
protocol-dependent block blindly or recommend an arbitrary AV1 QP number.

## Analysis and decision criteria

Accept only adjacent samples whose endpoints fall inside the selected window
with the same scene/case, process, source kind, module and encoder generation.
Reject errors, missing endpoints, backward byte/frame counters and long gaps;
never average across a source reset. Report excluded duration and boundary
uncertainty from status/ADB sampling. Reject interrupted or manually changed
workloads rather than silently selecting a favorable segment.

Compute `8 * sum(delta_bytes) / sum(delta_seconds) / 1,000,000`; do not average
running averages. Report accepted duration, min/max one-second rates, time and
longest contiguous interval above 350 Mbps, unique buffers/s, parsed picture
counts, bytes/buffer, size percentiles/maxima, encode latency, actual ColourLab
submissions and counts/times of drops, resets and failed calls. Count errors
within the same workload window, not from later manual/transition tests.

- **Correctness fix passes:** focused VBV ownership/map isolation checks pass;
  native deployment and GPU behavior still require the later gates.
- **Stable encoder output above 350:** the complete accepted interval averages
  above 350 Mbps with the duration/spread reported and no drop/reset storm.
- **Stable delivery above 350:** additionally requires matching decoder-input
  compressed-byte counters above 350 Mbps. Displayed FPS remains a separate
  measurement; decoder release does not prove physical presentation.
- **500 Mbps adherence:** report deviation from 500 over the accepted window.
  A target alone, an isolated peak or reset-amplified output is not a pass.
- **Update regression:** requires an authorized whole-SteamVR old/new/old
  comparison with exact hashes and otherwise identical settings/driver/APK.
  The existing different binaries and update timing do not prove that the
  proprietary frame-size threshold changed.

After testing, show the settings actually left saved. Restore only values the
user authorizes; preserve journals and all diagnostic captures. A completed
plan or passing source checks must not be reported as a live fix.
