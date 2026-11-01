# Hybrid ASTC / PyroWave fovea (experimental)

The single record of how the hybrid fovea works, how it was verified, what was fixed, and
what still blocks it. Client internals are in
`steamlink-patches/extensions/hybrid-codec/README.md`; the design contracts are the local
plans `steamlink-patches/diagnostics/astc-streaming/2026-10-20-ASTC-STREAMING-PLAN.md` and
`.../pyrowave-streaming/2026-10-31-PYROWAVE-GAZE-PLAN.md` (gitignored notes).

## Companion access (2026-11-01)

**Hybrid Fovea (Experimental)** is a separate page after Image Settings. It appears only
when the driver is installed and **App Settings > Advanced > Advanced Mode** has been
saved On. Debug Mode and temporary advanced-control links do not unlock this page.
Advanced Mode only unlocks access: Hybrid remains Off until its own Enable switch is
turned on. All Hybrid tuning, estimates, summaries and telemetry live on this page.

Turning Advanced Mode Off first saves Hybrid Off, then saves the Advanced preference.
Its codec/ring/budget tuning is retained. Re-enabling Advanced does not restart Hybrid.
At Companion startup, a saved Hybrid On with Advanced Off is reconciled to Hybrid Off;
the same policy applies to confirmed settings reloads. A read-only Check Settings
inspection reports a discovered conflict without saving; use Reload settings to
apply the reconciliation explicitly. Failed writes are visible. A
failed Hybrid-Off write keeps Advanced On; if the subsequent Advanced write fails,
Hybrid remains Off. **Reload settings** retries read/reconciliation; repeat a failed
switch action to request that change again.

This is Companion-managed coordination through the existing native `hybrid.enabled`
setting and hot reload. GUI preferences remain GUI-only. Saved Off is distinct from
fresh runtime proof that the loaded driver has stopped Hybrid; manually edited files
while Companion is closed are still native settings.

## Status (2026-11-01)

Host side complete and tested; **not displayable on the headset**. Fail-closed by default:
`hybrid.requireReadyPeer` is on and no readiness bridge exists, so the driver never wraps an
access unit. Evidence is host-only (unit/fixture, D3D11 on an RTX 5090, compilation,
package); nothing has run in SteamVR or on a headset. Missing for a picture: the readiness
bridge, the headset compositor, and (for PyroWave) the GPU route — see [Open gates](#open-gates).
There is no video fallback: while the mode runs (for a bench run, `requireReadyPeer` off)
Steam Link's fovea tiles are cleared to grey, so until the compositor exists the headset
shows a grey fovea. That is the intended visible failure, not a defect.

## How it works

```text
game frame ── eye pass (optional) ── fovea tiles cleared ── vrlink encode (NVENC) ── lock
     │                                                                                   │
     └─ capture: copy the encoded eye content into a shared canvas (render thread)      │
          └─ producer worker: plan rings → ASTC on GPU / PyroWave on CPU → fovea unit ──┤
                                                         wrap only the same scene frame ┘
client: Codecs Support layer → helper strips GXH1 → base AU to the one hardware decoder
                                 (fovea composited into Steam Link's fovea tile: not built)
```

**Base stream.** The hybrid replaces Steam Link's fovea instead of duplicating it. While the
producer is active, both fovea tiles of vrlink's packed W x 4W frame (chosen by
`postPack.foveaTop`) are cleared to flat mid grey just before NVENC maps the frame
(`NvencPostPack::BlankFovea`: two D3D11.1 `ClearView` rects per plane on a deferred context,
NV12 and P010, no scratch copy; like the CAS post-pack it turns on D3D11 multithread
protection for vrlink's device). The bottom-left 64 px timing block is kept, and the
background tiles are left as vrlink drew them. A flat tile costs NVENC almost nothing, so the
fovea is no longer paid twice. A late, lost, rejected or undisplayed hybrid fovea therefore
shows as grey at once. A frame the clear cannot handle (not a writable 4-tile NV12/P010
atlas) keeps its video fovea and is counted (`videoFoveaKept`, reason `video_fovea_kept`).
Capture reads the game's eye texture, not the packed frame, so the clear never reaches the
fovea source. The envelope is applied after NVENC success at `nvEncLockBitstream`; the unlock
shim releases the real buffer and frees the envelope (lock-free while nothing is wrapped).

**Base codec and NVENC hook.** `hybrid.baseCodec` 0 (default) follows the codec the stream
runs: the codec NVENC last accepted for a hooked encoder (observed at initialization and
reconfiguration, never modified); before any session, the Stream Frame codec while the NVENC
tap is on, else vrlink's HEVC. 1 or 2 require HEVC or AV1 and reject a mismatch; an H.264
stream is rejected (`base_h264_unsupported`). Every access unit is also checked against its
own encoder's accepted codec, and one of another codec is sent base-only
(`base_codec_live_mismatch`), so enabling the tap mid-stream cannot relabel the running
session. The hybrid does not need the tap's encoder overrides: with the tap off it installs
its own hook on new encoders, which observes initialization and reconfiguration, wraps
submit, lock, unlock and destroy, and keeps resource register/map bookkeeping so the clear
can find the packed input. There is no API upgrade and no encoder setting. Turning the tap
off mid-stream keeps an encoder the tap created joining and wrapping. Like the tap, a hook
reaches only encoders created after it is installed, so a first enable during a stream starts
at the next headset connection. Until a wrapped encoder submits, capture stays idle
(`nvenc_seam_pending`). Each finished encoder session starts a new epoch, so the next
stream's first envelope resets the client. Settings applies are serialized end to end, so
a delayed apply of older settings cannot override a newer one.

**Frame join.** `Present` announces a scene frame id before vrlink submits; each
`nvEncEncodePicture` output buffer records it; the lock attaches only that frame's fovea.
Older foveas are discarded, newer ones wait, late or unmapped frames go base-only and are
counted (`joinedFrames`, `lateFrames`, `staleFovea`, `unmappedFrames`). The id-to-submission
assumption is plausible from the call order but unproven at runtime.

**Capture.** On vrlink's Present thread, from the texture vrlink actually encodes (the
zero-copy shadow when the eye pass drew one, else the layer). Without Image Enhancements a
capture-only path takes the same keyed mutex and only copies. Both eyes go into one of two
canvases shared with the encoder device (keyed mutex, key 0 both sides): the render thread
queues two copies and returns (0.2–0.6 ms measured, no GPU wait); the worker waits for the
GPU. A slot still being read skips that frame. If the encoder device cannot open the shared
canvas, a staging texture is mapped on the Present thread instead (`capturePath:
cpu_staging`). RGBA8/BGRA8 single-sample layers only; MSAA and float formats are refused.

**Ring plan.** Each ring is the projected gaze cone of (bound + guard) degrees, sampled on
the view sphere and projected through the eye's signed, possibly asymmetric frustum, so
diagonal and off-centre gaze keep full angular protection. Ring boxes are nested and clipped
to Steam Link's fovea tile (W of the applied W x 4W stream spans W pixels of the recommended
per-eye render, centred on the gaze; the background layers carry the rest). The outer
annulus is stretched to the whole tile, because the video's tile is cleared and no part of
it may be left uncovered. Rings are annuli: every pixel is sent exactly once, cut as
rectangular frames. Both eyes share one canvas size. Invalid or stale gaze, or no real
frustum, turns the rings off for that frame.

| Annulus | Outer bound | ASTC footprint | Density |
| --- | --- | --- | --- |
| 0 | 5 deg | 4x4 | 1 (native) |
| 1 | 10 deg | 6x6 | 1 |
| 2 | 20 deg | 8x8 | 0.75 |
| 3 | 35 deg | 10x10 | 0.5 |
| 4 | 45 deg, then to the fovea-tile edge | 12x12 | 0.25 |

Guard default 2 deg. Density is sampling relative to the game image: an ASTC ring below 1 is
low-pass resampled (linear-light box mean) to `ceil(size x density)` texels per axis and
stretched back by the compositor; PyroWave omits the wavelet bands above the ring's density.

Planned cost on a 3552x3840 render, W = 1536, defaults, assumed ±50° frustum (the real one
was not captured): 0.95 MB per frame, about 690 Mbit/s at 90 Hz, under the 2 MiB default
budget. Without the crop and density it was 3.66 MB. A plan over `hybrid.maxFoveaBytes`, a
canvas above 4096 px or a patch above 2 Mi px is refused before capture.

**Fovea size and resolution.** Two settings decide what the fovea is, and the hybrid works
inside the result:

- *Render Width/Height per Eye* (Image Settings > Render Resolution, default 3552 x 3840) is the whole
  per-eye render target, not the fovea. It sets the pixels per degree everywhere.
- *Tile Width* W (Image Settings > Stream Quality: 1024, 1536 HEVC/AV1 default, 2048) is the
  fovea. Each eye's fovea tile is a W x W cut-out of the render at native density around the
  gaze, and the background tile is the whole eye view downscaled to W x W. A larger W covers
  more degrees and sharpens the periphery. A larger render makes the same tile cover fewer
  degrees at more pixels per degree. Both need a SteamVR restart.
- The hybrid rings, guard, footprints and densities (live) only decide how those W x W pixels
  are coded. They cannot make the fovea larger than the tile.

The Companion shows this: a line under Tile Width, and in the hybrid card the fovea size in
pixels, its share of the eye, an estimate in degrees and px/deg (centred symmetric projection,
from the FOV the driver reports), the periphery px/deg, and per ring the bounds with the
guard, the px/deg at its density, the ASTC bits per source pixel (128 x density^2 / block^2),
and whether it reaches past the tile edge. For example, at an assumed 100 deg per-eye FOV
on the default render: W 1536 is 17.3% of the eye, about 54.5 x 51.0 deg at about 26 px/deg,
with a periphery of about 11 px/deg; W 2048 is 30.8%, about 69 x 65 deg, periphery about
15 px/deg; W 1024 is 7.7%, about 38 x 35 deg, periphery about 7.5 px/deg. With the default
rings, W 1536 holds rings 0-2 whole and cuts rings 3-4 at its edge; at W 1024 ring 4 starts
beyond the tile corners and has no effect.

**ASTC** (`GXAST-v1`): LDR, single partition, one plane, direct RGB endpoints at QUANT_256,
bits-only weight grids (1–4 bits, densest legal grid per precision, up to the footprint).
Decoding follows the spec order (weight infill, then UNORM8 endpoint interpolation), so
blocks decode identically on GPU texture hardware, in astcenc and in the CPU reference.
Encoded by a D3D11 compute shader on a private device on the render adapter: one dispatch
per frame, compressed readback only. Legal footprints `{4, 5, 6, 8, 10, 12}`. No GPU encoder
means `astc_gpu_unavailable`, never a CPU substitute.

**PyroWave** (`GXPW-CPU-v1`): dependency-free CPU encoder/decoder of the v1 transform and
packet layout, not wire-compatible with upstream's Vulkan encoder. One transform per eye; each
32x32 packet takes the quantizer step of the finest ring its synthesis support reaches
(footprint N = N/4 x base step) and detail bands above the ring's density are not sent. Bit-
plane rate control meets `hybrid.maxFoveaBytes` or reports `pyrowave_budget`. About 20 ms
per frame on the host CPU at 640 px eyes: over budget for 90 Hz.

## Wire format (GXH1 v2)

`GalaxyXRDriver/src/Hybrid/Gxh1Protocol.h` is the authority; the client carries a
byte-identical schema block, checked with every copied codec source by
`tools/tests/hybrid-protocol-parity.test.cjs`. Little-endian, packed, `static_assert`ed.

- Envelope header (80 B): magic `GXH1`, version 2.0, flags (fovea / reset / degraded / exact /
  snapshot), session/source/mapping epochs, frame id (the base frame), PTS, base codec and
  format, fovea codec and precision, canvas, patch count, feather, CRC-32.
- Fovea unit header (96 B) with one 32 B `EyeMapping` per eye: source tile extent, canvas
  origin, signed frustum, gaze.
- Patch entries (48 B): rect, eye, annulus, footprint, texel grid (`texelW/H`, 0 = native),
  source epoch, payload range, angular bounds.

The first envelope of every epoch (each reconfigure or peer change) sets `reset`. The parser
rejects, before allocation: bad magic/version (v1 included), length overflow, bad codec or
precision, bad mapping, out-of-canvas or impossible texel grids, overlapping payloads,
inconsistent epochs, CRC mismatch, coverage gaps and overlaps.

## Client (Steam Link 2.0.20–2.0.24)

The Codecs Support layer resolves the helper once per session; an ordinary access unit costs
one cached boolean plus a 4-byte magic compare (0.7 ns measured). A GXH1 envelope is stripped
so only the untouched base AU reaches the hardware decoder (~1 µs). An unreadable envelope is
handed back as an empty input buffer (a dropped frame) and the helper stays armed; an
integrity or epoch failure past the fixed header drops only the fovea. Production is
demux-only; `GXR_HYBRID_CPU_DECODE=1` enables a bench CPU decode (10–70 ms per frame).

## Settings and status

`hybrid.*` in `settings.json`, persistent across streams and SteamVR restarts, applied live
(no restart), never coerced: enabled, foveaCodec, baseCodec (0 = same as stream),
guardDegrees, ring0..4Degrees/Block/Density,
featherPx, maxFoveaBytes, requireReadyPeer (bench only, not in the Companion). Invalid values
reject with a reason. `info.json` `hybridStatus` reports state/reason, backend, capture path,
latest plan (canvas, crop, planned ASTC bytes), per-frame bytes and encode time, join and
failure counters, video-fovea clears (`videoFoveaCleared`, `videoFoveaKept`), and the applied
base budget, Force CBR and fps. The Companion's Hybrid Fovea page renders all of it,
together with the fovea readout above, the fovea Mbit/s beside the base budget, and a warning
that without Force CBR vrlink's adaptive request counts the fovea bytes and can lower the
base.

## Verification

| Command (driver root unless noted) | Last result (2026-11-01) |
| --- | --- |
| `tools/Test-HybridCore.ps1` | 549 / 0 |
| `tools/Test-HybridLoopback.ps1` | 145 / 0 |
| `tools/Test-HybridGpuAstc.ps1` (needs the astcenc 5.7 source under `builds/`) | 194 / 0, decode bit-identical to astcenc, shared-canvas handoff end to end |
| `tools/Test-HybridConfig.ps1`, `Test-CasActivation.ps1`, `Test-HitchDiagnostics.ps1`, `Test-ToggleMigrations.ps1`, `Test-NvencToggle.ps1` | 42, 245, 114, all scenarios, 3473 (includes the tap-off hybrid hook); 0 failures |
| `node --test tools/tests/*.test.cjs` | 0 failures (PowerShell 7 cases skip without `pwsh`) |
| `GalaxyXRDriverGUI`: `npm test`, `npm run build:ui` | 550 / 0, locales verified |
| steamlink-patches: `extensions/hybrid-codec/tests/Run-Tests.ps1`, `extensions/codecs-support-layer/tests/Run-Tests.ps1` | 112 / 0, 54 / 0 |
| steamlink-patches: `.\gradlew.bat :patches:test --offline --rerun` | 225 (209 run, 16 decoded-APK skips), 0 failures |
| `tools/Build-Portable.ps1` | exit 0, `GalaxyXRDriver-Test-20261101-133129` |

Android payloads (NDK 27.2.12479018, `-Werror`): helper `libgxr_hybrid_codec.so` 494,432 B,
SHA-256 `995da8563c4216095534ad8bc7866990e1137987d1f9158438d723772bec12fb`, five exports;
layer `libgxr_codecs_support.so` 409,512 B, `96d53e57b4e9e35181767d841581b1821b77ffe4d758584e9cfbc8a3a6a7ecb5`.
Pins live in `HybridCodecPatch.kt`/`CodecsSupportPatch.kt` and `HybridCodecPatchTest.kt`.

## Review record (2026-10-31 → 2026-11-01)

Two reviews (an agent pair on 10-31, then a source re-audit on 11-01) found and fixed:

- **Wire:** the fovea could not be placed (no canvas origin/frustum) → GXH1 v2 eye mapping;
  the reset flag was never sent → set on each epoch; `Test-HybridProtocol.cjs` was cited but
  missing → parity test.
- **Pairing:** the fovea was attached to the next base frame (one frame of misregistration)
  → scene-frame join at the NVENC seam.
- **Capture:** read the unprocessed game texture under zero-copy → reads the encoded texture;
  required Image Enhancements → capture-only path; mip subresource, MSAA, BGRA, per-eye Map
  stalls → fixed; render-thread Map → shared-canvas GPU handoff; undecodable plans → refused
  before capture; cross-thread lifecycle races on disable/reconfigure (10-31) → serialized,
  generation-checked.
- **Planner:** independent H/V angles under-protected diagonal gaze and edge gaze collapsed
  rings → projected cones with property tests; rings beyond Steam Link's fovea tile → crop;
  no density → per-ring density.
- **ASTC:** non-standard decode order and a too-small grid search → spec-exact decode
  (bit-identical to astcenc), fine strokes at 6x6 from 17 dB to exact at the same rate; GPU
  table/UAV stride violations (10-31) → fixed; silent CPU fallback → removed.
- **PyroWave:** padded sub-blocks written with the wrong bit shift and a rounding quantizer
  against a midpoint decoder (errors up to 17 levels at full precision) → exact; 34 padded
  strip transforms → one ring-weighted transform per eye.
- **Client:** unreadable envelopes were fed to MediaCodec and demux disarmed → dropped frame,
  stays armed; bench decode dropped the base on fovea errors → fovea only; packaged layer
  lacked the demux and the builder overwrote pinned resources (10-31) → rebuilt, external
  build output.
- **Companion/settings:** illegal 7/9/11 footprints offered and a false "Requires a SteamVR
  restart." tip → legal choices, accurate tips; the defaults generator had been broken by the
  hybrid serializer blocks and `driver-defaults.ts` hand-edited → generated again.
- **Coupling:** the hybrid required the NVENC tap's encoder overrides and a second base-codec
  choice that could only disagree with the stream (and, with the tap off, read the tap's
  unapplied codec) → own pass-through hook, base follows the running stream.
- **Fallback (11-01, follow-up):** Steam Link's own fovea tile was kept under the hybrid, so
  the fovea was paid twice and a broken hybrid was invisible → tiles cleared while the mode
  runs, outer annulus fills the tile, clear counters and a Companion fovea readout.
- **Transitions (11-01, follow-up, from the open-findings review):** turning the tap off on
  an encoder it created stopped the joins → hybrid submit and lock are independent of the
  tap. A delayed render-thread apply could land older settings after a newer apply → the
  apply is one critical section. Enabling the tap with AV1 saved could label a running HEVC
  session as AV1 → observed session codec for admission and a per-AU check. A half-failed
  GPU output growth could be reused with missing views, and a later LUID match leaked the
  fallback adapter → complete-set reuse and release (source-level; allocation failure not
  injected). The CPU-bench client session transitions in that review are still open.

## Open gates

1. **Readiness bridge.** A session-bound client → host acknowledgement of envelope version,
   codecs and compositor; no reverse carrier has been derived (do not reuse spacewarp 0x48).
2. **Headset compositor.** Upload ASTC blocks to footprint-grouped textures and sample them,
   resampled rings stretched over their rects, into Steam Link's fovea tile (which arrives
   grey) before its renderer, covering the whole tile, with one feather at the outer edge; no CPU decode, no decoder-owned buffers, no
   extra XR layers. Per exact base (2.0.20/5001712, 2.0.24/5002395 first). Colour: confirm the
   decoded-video sampler domain before blending.
3. **Device validation.** Fovea-tile size and position against vrlink's crop, the join
   counters, vrlink's handling of the envelope prefix and frame-size caps, base-rate
   behaviour without Force CBR, gaze measurement age, worn and thermal quality (seams at
   density steps, peripheral stability).
4. **PyroWave GPU.** Pinned upstream encoder/decoder (Vulkan/Granite) with same-adapter
   interop; compare compute and fragment decode on the headset. The CPU variant stays
   labelled `pyrowave_cpu` and is not upstream-wire-compatible.
5. **Efficiency next steps.** Staircase ring tiling that hands rectangular-frame corners to
   the coarser ring (~7%); aprons between rings of different density; 10-bit precision only
   with end-to-end negotiation.
