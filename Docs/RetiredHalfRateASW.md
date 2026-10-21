# Half rate (ASW) — retired 2026-10-21

Status: retired experiment. The code is kept, compiled, and shipped inactive: not selectable, never published by the host, and ignored by the client if an older host publishes it.

Shipping state: the packaged patch still pins the pre-retirement `libgxr_spacewarp.so`. Until the rebuilt layer is staged and `GXR_SPACEWARP_LIBRARY_SHA256` is re-pinned (an explicitly authorized step), a stale host driver could still publish carrier `2` to the shipped client and enter half rate. The host-side gate already prevents this build from publishing `2`.

## Why it was retired

Half rate replaced every second decoded frame with a synthesized one. Because it runs after decode, it saved nothing upstream: the game still rendered, the host still encoded and the client still decoded every frame. At the observed 1536x6144 10-bit atlas it discarded roughly 1.7 GB/s of decoded pixels, and paid four full-resolution warps per synthesized tick plus a matcher run on every arrival.

Headset-side headroom would need half-cadence submission (host sends 45, client synthesizes to 90), which is a different architecture and is not built. PC-side headroom needs application pacing through `PostPresent`, which remains unproven on this driver path.

The mode needs device time to test (Gate P and Gate L in the plan below) before any claim about it is honest.

## What exists

- Layer lifecycle, phase B1: counted enabled-only ownership, context-keyed release, deferred reclaim, resize retirement, 100-cycle tests.
- Client half-rate synthesis branch (`swp_dispatch.cpp`, carrier mode 2): compiled but unreachable while retired; no behavioral host tests.
- Host carrier plumbing (`VrlinkTap`, `spacewarpMode`), which now publishes late frames for every stored value.
- [AswHalfRateImplementationPlan.md](AswHalfRateImplementationPlan.md) — the full design, gates and evidence requirements.

## Dormant switches

| Side | Where | Symbol | Retired value |
| --- | --- | --- | --- |
| Host | `GalaxyXRDriver/src/Driver/VrlinkTap.cpp` | `kHalfRateRetired` | `true` |
| Client | `extensions/gxr-spacewarp-layer/src/swp_vts.cpp` | `g_halfRateRetired` | `true` |
| GUI | `GalaxyXRDriverGUI/src-lit/domain/spacewarp-modes.ts` | `HALF_RATE_AVAILABLE` | `false` |

The stored `streamFrame.spacewarpMode` value is preserved, never rewritten: a saved half-rate choice applies again when the mode returns.

## Revival checklist

1. Flip the three flags above.
2. Restore the mode select rendering in `stream-frame-page.ts` (already conditional on `HALF_RATE_AVAILABLE`).
3. Update the retirement assertions in `spacewarp-modes.test.ts` and `SpacewarpToggleTest.cpp` — both pin the retired behavior and will fail on a flip.
4. Rebuild the layer and re-pin `GXR_SPACEWARP_LIBRARY_SHA256` in `GxrSpacewarpLayerPatch.kt` — an explicitly authorized step, and the one that actually ships the client-side change.
5. Add host tests for the mode-2 branch: reachability is covered, behavior is not.
6. Run Gate P (completed GPU time) and Gate L (latency and reprojection error) on device before shipping the mode to anyone.
