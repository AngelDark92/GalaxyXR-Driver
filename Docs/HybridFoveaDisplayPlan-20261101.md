# Hybrid Fovea — Display Plan (2026-11-01)

Design for the two unbuilt gates in `Docs/HybridFovea.md`: the **readiness bridge** and the
**headset compositor**. No code accompanies this document. Every claim below is grounded in
the sources cited inline.

Related: `Docs/HybridFovea.md` (feature contract), `Docs/HybridFoveaReview-20261101.md`.

---

## 0. Status today, as measured

| Fact | Evidence |
| --- | --- |
| Driver encodes ASTC patches, wraps GXH1, clears the fovea tile to grey | `NvencTap.cpp`, `HybridProducer.cpp`, `HybridPostPack`; `hybridStatus.videoFoveaCleared` |
| Driver refuses to stream when a selected hybrid mode cannot run | `NvencTap.cpp:1789`, `:2309`; verified live `vrserver.txt` 20:17:25.385 |
| Driver never sets peer-ready — `SetPeerReady` has no callers | `HybridProducer.cpp:237`, `HybridProducer.h:126` |
| Client strips GXH1 and decodes the base AU correctly | `steamlink-patches/extensions/codecs-support-layer/src/codecs_support_layer.cpp:566-651` |
| Client parses/validates the fovea, then discards it (`demux_only`) | `hybrid_session.cpp:459-464` |
| Client can CPU-decode into RGBA canvases, but nothing reads them | `hybrid_session.cpp:183-270`, `CopyLayer` at `:146-163` |
| No client→host byte channel exists in the app | lane report: no property writes, sockets, or event injection |
| Headset GPU samples ASTC natively | `ro.opengles.version=196610` (GLES 3.2), Adreno |
| A compositing seam already ships, default-enabled | `blue_noise.cpp:272`, `shader_rewrite.h:36-47` |

Consequence: base video is correct, the fovea is grey, and the mode is honestly rejected.
Nothing on the wire needs to change to fix that.

---

## 1. Stage 1 — Fovea compositor

### 1.1 Principle

The fovea is drawn **into Steam Link's own fovea tile, before its renderer**, with no extra XR
layer and no CPU decode. The GPU samples the driver's ASTC blocks directly as compressed
textures (`GLES 3.2` guarantees ASTC LDR sampling).

CPU decode is explicitly out of scope for display: the scalar decoder in `astc_decode.cpp` is a
single-partition subset and is not a 90 Hz path — the frame budget is 11 ms at 90 Hz and the
decode would have to fit inside it every frame.

### 1.2 What the client must retain

Today the fovea unit is dropped when decode is disabled. Add a **retain-raw** path:

- On `kFlagFoveaPresent` with decode disabled, store per eye: `frameId`, the parsed patch table,
  the raw block spans, and the `EyeMapping`. No decode, no RGBA canvas.
- Capacity: `kFrameSlots = 2`, fovea unit ≤ 8 MiB (`Gxh1Protocol.h:31-45`) ⇒ ≤ 16 MiB retained.
- Newest-frame-wins and epoch/`reset` semantics are unchanged (`hybrid_session.cpp:106-116`).

### 1.3 Helper ABI (new export)

The existing `gxr_hybrid_take_layer` returns RGBA and is the wrong shape. Add one bounded call:

```
int gxr_hybrid_take_blocks(uint32_t eye,
                           uint64_t* frameId,
                           GxrHybridBlockSetHeader* hdr,
                           void* outBlocks,
                           size_t outCapacity);

struct GxrHybridBlockSetHeader {   // 64 bytes, all little-endian
  uint32_t magic;        // 'GXRB' 0x42525847
  uint16_t versionMajor; // 2
  uint16_t versionMinor; // 0
  uint32_t patchCount;   // <= 64
  uint16_t canvasW, canvasH;
  uint16_t originX, originY;
  uint16_t featherPx;
  uint16_t patchStride;  // sizeof(GxrHybridBlockPatch)
  float    tanLeft, tanRight, tanTop, tanBottom;
  float    gazeX, gazeY;
  uint32_t reserved[4];
};

struct GxrHybridBlockPatch {       // 32 bytes
  uint16_t x, y, w, h;             // rect in canvas pixels
  uint8_t  eye;                    // echo
  uint8_t  footprint;              // 4,6,8,10,12 (square block edge)
  uint16_t densityQ8;              // 256 = native
  uint32_t blockOffset;            // byte offset inside outBlocks
  uint32_t blockBytes;             // exact ASTC payload length
  uint32_t reserved[3];
};
```

Return codes: `1` frame available and packed, `0` no frame yet, `-1` bad arguments,
`-2` output too small (header still filled), `-3` retained frame inconsistent.

Rules: no allocation; caller-provided buffer; every offset/length bounds-checked against
`outCapacity` before use; a partial or inconsistent set returns `-3` and the compositor draws
nothing (the grey tile stays — never a partially-covered fovea).

### 1.4 Block layout and GL formats

Group patches by footprint; one compressed texture per distinct footprint (≤ 5). Each patch is
uploaded as a tight `(w/footprint) × (h/footprint)` block grid.

| footprint | linear RGBA | sRGB RGBA |
| --- | --- | --- |
| 4×4 | `0x93B0` | `0x93D0` |
| 6×6 | `0x93B4` | `0x93D4` |
| 8×8 | `0x93B7` | `0x93D7` |
| 10×10 | `0x93BB` | `0x93DB` |
| 12×12 | `0x93BD` | `0x93DD` |

(`GL_COMPRESSED_RGBA_ASTC_<N>x<N>_KHR` and the `SRGB8_ALPHA8` family, offset `+0x20`.)

Use `glCompressedTexImage2D` per patch (no repacking into an atlas initially). Sort patches by
footprint before drawing so texture binds are ≤ 5 per frame.

**Open question Q1:** linear vs sRGB sampler domain. The stream is sRGB8 (`0x8c43`), but the ASTC
payload is encoded from the captured eye texture whose colour space must be confirmed against
`AstcGpuEncoder`. Gate 2 of `Docs/HybridFovea.md` names this explicitly ("confirm the
decoded-video sampler domain before blending"). Resolve by encoding a known mid-grey ramp and
comparing the sampled value.

### 1.5 Draw

Host: the foveal draw hook already used by blue noise.

- Hook: `blue_noise.cpp:272` `gxDrawArrays`, gated by the pin at `:167-180` and the sRGB8 /
  no-blend precondition at `:181-195`.
- Shader: `shader_rewrite.h:36-47` appends to the **foveal fragment shader**; the same mechanism
  is reused for the composite program.

Per frame, per eye:

1. Take the block set (§1.3). On `0`/negative → draw nothing, increment `compositeMisses`.
2. Convert each patch rect from canvas space to tile space using `originX/originY`.
3. For each patch: bind its footprint texture, draw a quad at the mapped rect sampling the full
   texture.
4. Feather the outer edge over `featherPx` using the same falloff the driver applies.

Preserve and restore every GL binding touched (texture unit, program, VAO, blend, scissor,
viewport) — the blue-noise layer already does this and is the reference.

### 1.6 Failure behaviour (fail-closed)

| Condition | Result |
| --- | --- |
| No retained frame | grey tile, `compositeMisses++` |
| Bad/partial block set | grey tile, `compositeInvalid++` |
| GL upload failure | grey tile for that frame, `compositeGlFailed++`, log once |
| Frame older than N frames | grey tile, `compositeStale++` |

Never draw a partially covered fovea and never substitute a different source. A grey fovea is the
honest signal that compositing is not running.

### 1.7 Cost estimate

~500–800 lines across the helper (retain-raw + ABI) and the patch C++ (upload + draw), plus the
shader append. Device cost target: ≤ 1.5 ms/frame, ≤ 5 texture binds, ≤ 64 draws per eye.

---

## 2. Stage 2 — Readiness bridge

### 2.1 Carrier

vrlink's ValueTransport is bidirectional and the client already publishes typed values to the
host (ids `0x0d–0x12`, `0x15`, `0x21`, `0x72`). Unknown ids are auto-instantiated, so an unused
id is a free slot. `0x48` is host→client and explicitly forbidden by `Docs/HybridFovea.md:277`.

Chosen carrier: **one typed record on an unused id, candidate `0x38`**, emitted once per observed
session. No protocol change; no GXH1 change.

### 2.2 Ack record (16 bytes)

| Offset | Field | Value |
| --- | --- | --- |
| 0 | `magic` u32 | `0x47585248` (`GXRH`) |
| 4 | `versionMajor` u8 | `2` |
| 5 | `versionMinor` u8 | `0` |
| 6 | `codecMask` u8 | bit0 ASTC, bit1 PyroWave |
| 7 | `precisionMask` u8 | bit0 8-bit, bit1 10-bit |
| 8 | `compositor` u8 | 0 = absent, 1 = present |
| 9 | `reserved0` u8 | 0 |
| 10 | `maxCanvas` u16 | 4096 |
| 12 | `reserved1` u32 | 0 |

The host accepts the ack only if: size == 16, magic matches, `versionMajor == 2` (a v1 client is
refused as `peer_version_mismatch`, not translated), `codecMask` contains the configured
`foveaCodec`, and `compositor == 1`.

### 2.3 Client emit

- Site: `steamlink-patches/extensions/gxr-spacewarp-layer/src/swp_vts.cpp:533`
  `SwpVtsRootObserved` — the only place holding the live `SVLRoot*` and VTS pointer.
- Content: the ack above, with `codecMask`/`precisionMask` from the compiled helper
  (`codecs_support_layer.cpp:225` `HybridEnabled`), `compositor` from Stage 1 being compiled in.
- Cadence: once per observed root, re-sent on `SwpVtsSessionEnded` (`:548`) boundaries.
- Cleared on session end so a stale ack cannot admit the next session.

### 2.4 Host receive

- New `GalaxyXRDriver/src/Driver/HybridReadinessTap.cpp`, modelled on `VrlinkTap` (MinHook +
  signature scan via `VrlinkSignature.h:129-198`; never a fixed RVA).
- Validates the record, then calls `gxh1::Producer::Get().SetPeerReady(true, sessionEpoch)`.
- `SetPeerReady` already re-runs `Configure` on change (`HybridProducer.cpp:246-255`), which is
  exactly the re-admission the rejection path needs.
- **Epoch:** take it from the encoder session boundary — teardown at `NvencTap.cpp:1775-1783`,
  new session at `:2324-2331`. Readiness is cleared on teardown.
- Readiness lives in the tap and is pushed via `SetPeerReady`; `ProducerConfig` has no readiness
  field and must not gain one.

**Open question Q2 (blocking):** the host-side ValueTransport receive address is not pinned.
The client publish path, the `0x38` slot, and the wire format are; the host receive site is not.
One RE step is required before implementation. If it cannot be pinned, the fallback is the host's
remote-value accessor, which carries higher derivation risk.

### 2.5 Failure codes (replace `no_readiness_bridge`)

| Code | Meaning |
| --- | --- |
| `peer_ack_absent` | no ack for the current session epoch |
| `peer_version_mismatch` | ack present, schema not v2 |
| `peer_codec_unsupported` | ack codecMask lacks the configured fovea codec |
| `peer_compositor_absent` | ack says compositor not built |
| `peer_ack_malformed` | bad magic/size |

All are `Rejected`, all fail the stream through the already-shipped enforcement, all are logged
with the request (`HybridConfigGlue.cpp:128-148`) and shown in `info.json`/Companion.

### 2.6 Bench override

`hybrid.requireReadyPeer = false` stays a driver-side development switch (`Config.h:1726`), never
exposed in the Companion (`hybrid-fovea-page.ts:86`). It bypasses `peer_ack_absent` only, and the
status reason records `peer_check_disabled` so a bench session is never mistaken for a validated
one.

---

## 3. Stage 3 — Device validation

Acceptance, per base (2.0.20/5001712 first, then 2.0.24/5002395):

| Check | Pass condition |
| --- | --- |
| Producer | `hybridStatus.state = active`, `patchCount > 0`, `foveaBytes > 0`, `frames` increments |
| Tile clear | `videoFoveaCleared` increments, `videoFoveaKept = 0` |
| Composite | `compositeFrames` increments, `compositeMisses/compositeInvalid/compositeGlFailed` = 0 |
| Geometry | fovea edges align with vrlink's crop; no offset drift under head motion |
| Seams | no visible ring boundary at density steps; feather matches `featherPx` |
| Colour | mid-grey ramp matches the base stream (resolves Q1) |
| Rate | 90 Hz held; composite ≤ 1.5 ms/frame |
| Base integrity | base video unaffected; no decoder errors in logcat |

Instrumentation to add: `composite*` counters in the helper status string and a matching field in
`info.json hybridStatus`, so the Companion reports compositing honestly.

---

## 4. Test plan

### Stage 1
- Unit (host): block-set ABI — bounds, `-2`/`-3` paths, footprint grouping, rect mapping, coverage
  completeness, no-frame behaviour, stale-frame drop.
- Unit: retain-raw path preserves the fovea unit bytes and epoch/`reset` semantics with decode off.
- Fixture: encode a known ASTC set, upload in a headless GL/EGL offscreen context, read back, and
  compare against the CPU decoder's RGBA for the overlapping subset.
- Packaging: helper SHA-256 pin updated in `HybridCodecPatchTest.kt`.

### Stage 2
- Unit: ack parser accepts the 16-byte record and rejects each malformed variant (magic, size,
  version, masks, compositor).
- Unit: readiness cleared on encoder teardown; stale ack for a previous epoch is refused.
- Unit: hook/signature resolve failure ⇒ `peer_ack_absent`, never a false ready.
- Integration: bench vs bridge produce identical producer state transitions.

### Gates
- `tools/Test-HybridCore.ps1`, `Test-HybridConfig.ps1`, `Test-HybridLoopback.ps1`,
  `Test-NvencToggle.ps1` per stage.
- steamlink-patches: `extensions/hybrid-codec/tests/Run-Tests.ps1`,
  `extensions/codecs-support-layer/tests/Run-Tests.ps1`, `gradlew :patches:test`.
- End-of-plan: `tools/Build-Portable.ps1` (exit 0, `Built test package: …`, driver DLL + manifest +
  Companion EXE) and a documented device session with the §3 table filled in.

---

## 5. Risks

| Risk | Mitigation |
| --- | --- |
| Host VTS receive address cannot be pinned | Fallback accessor; if both fail, keep fail-closed rejection rather than a guessed carrier |
| GL state corruption inside Valve's draw | Use the blue-noise layer as the reference implementation; save/restore every touched binding |
| ASTC colour domain mismatch | Q1 ramp test before wide rollout |
| Payload over budget at high ring density | Producer already refuses over `maxFoveaBytes`; surface as `rejected`, never shrink silently |
| Draw count (≤ 128/frame) | Sort by footprint; batch to instanced draws only if profiling demands |
| Per-base drift of Valve internals | Reuse the existing per-base VA/pin discipline and guards |

---

## 6. Sequencing

1. **Stage 1** — visible fovea in bench mode (`requireReadyPeer=false`), validated on device.
   Produces a real pixel result and de-risks the hard part without any RE.
2. **Q2 RE** — pin the host receive address (can run in parallel with Stage 1).
3. **Stage 2** — ship the ack; replaces `no_readiness_bridge` with specific refusal codes.
4. **Stage 3** — full per-base validation; only then is the feature "working" by the project's own
   standard.

Until stage 3 completes, the driver keeps the shipped enforcement: a selected hybrid mode that
cannot run fails the stream and says why.
