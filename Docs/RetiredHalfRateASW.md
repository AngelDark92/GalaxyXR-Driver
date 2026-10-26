# Half rate (ASW) — retired 2026-10-21, revived 2026-10-26

Status: **revived**. The owner reversed the retirement on 2026-10-26 with a
new scheduler and estimator revision, so this file records the old retirement
and the requirements that still block a comfort claim.

- The stored `streamFrame.spacewarpMode` values are unchanged: `0` is Automatic
  (normal late-frame recovery until the measured application cadence drops, then
  half rate) and `1` is Forced half rate. A never-set feature stays absent.
- The host publishes carrier `0` Off, `1` late-frame recovery and `2` half rate
  from requested/effective state. Automatic transitions never rewrite settings.
- The client layer maps carrier `2` to the predicted-display-time scheduler, not
  to the retired decoded-arrival branch.
- The rebuilt layer is staged and `GXR_SPACEWARP_LIBRARY_SHA256` is re-pinned in
  `GxrSpacewarpLayerPatch.kt`.

## Why it was retired in the first place

Half rate replaced every second decoded frame with a synthesized one. Because it
ran after decode, it saved nothing upstream: the game still rendered, the host
still encoded and the client still decoded every frame. At the observed
1536x6144 10-bit atlas it discarded roughly 1.7 GB/s of decoded pixels and paid
four full-resolution warps per synthesized tick plus a matcher run on every
arrival.

The 2026-10-26 revision targets client-side frame selection only: 45 selected
stream frames plus 45 synthetic display slots at 90 Hz (36/36 at 72 Hz). It does
not throttle the game, change encode/decode cadence or promise PC GPU savings.
Selected stream frames may already contain repeated or reprojected game content.
Application pacing through `PostPresent` remains unchanged and unproven.

## What now exists

- Host automatic cadence sampling through `IVRServerDriverHost::GetFrameTimings`
  at most ten times per second, a bounded one-second history, deduplication and
  advancing-submission validation, 90%/97% hysteresis, stale/application/
  reconnect/refresh resets, and requested-versus-effective carrier publishing.
- Client scheduler driven by OpenXR predicted display time and period; after
  warmup selected-real and synthetic slots alternate. Fresh frames in synthetic
  slots are discarded; duplicate/out-of-order timestamps do not advance phase;
  skipped slots do; failures never shift phase.
- Two immutable selected composites A/B, rotation alignment A into B, residual
  motion estimation, nominal 1.5 extrapolation, B metadata on synthetic views,
  and layer-owned runtime output swapchains. Released stock images are never
  written.
- Dense coarse-to-fine matcher (working longest side <= 1024, levels to 64,
  full +-96-native envelope, native refinement), normalized mean RGB error,
  zero-displacement comparison and the production 1% improvement rule. Portable
  GLSL is the baseline; QCOM is armed only after capability, compilation and a
  deterministic parity probe.
- Nonaligned/odd dimensions, per-view geometry, 2D/array layouts, the 512 MiB
  admission ledger, sampler/rasterizer-discard state restoration, async GPU
  timing and separate selected/discarded/synthesized/committed/late/fallback
  counters.

## Remaining gates

The revival does not by itself prove smoother or stable presentation. Before a
comfort or performance claim:

1. Run Gate P (completed GPU time, estimator saturation, distinct-source work)
   on the actual selected extent/format/runtime N.
2. Run Gate L (physical latency and reprojection error) with a genuine 45 Hz
   source, not a 90 Hz source with alternate frames discarded.
3. Verify SteamVR OpenXR and OpenVR application timing independently against
   `GetFrameTimings`.
4. Exercise the ownership/teardown matrix on device, including N=2, N=3, N>3,
   context loss, resize and session destruction.
5. Review disocclusion, alpha, fovated boundaries, judder and comfort visually.

[AswHalfRateImplementationPlan.md](AswHalfRateImplementationPlan.md) remains the
full design and evidence contract.
