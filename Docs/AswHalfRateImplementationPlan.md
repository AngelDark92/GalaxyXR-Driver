# ASW half-rate implementation and validation plan

Revision: 2026-10-21, incorporating the headset memory, estimator, identity and latency review, and the owner's clarification that client texture size varies with SteamVR settings.

**Retired 2026-10-21 (owner decision).** Half rate is not selectable, the host never publishes carrier `2`, and the client maps `2` to late frames. Phase B1 landed; B2–E have not started. The code and this plan are kept for revival — see [RetiredHalfRateASW.md](RetiredHalfRateASW.md).

Status: proposed work, not an implementation or runtime validation receipt. This document supersedes the earlier conversational plan. The present task changes documentation only.

## 1. Outcome, scope and verdict on the review

The reported symptom is that selecting Half rate leaves game FPS and PC GPU load unchanged. Current host code publishes a mode to the client; `DirectModeComponentShim::PostPresent` forwards the original throttling arguments unchanged. Alternating client presentations cannot by itself halve game rendering. True half rate requires verified application pacing as well as correct client synthesis.

**V1 targets PC game-rendering GPU headroom. It retains the existing encode, network and decode cadence. At a 90 Hz display, a successful 45 Hz game source does not imply a 45 Hz decoder. Do not ship v1 claiming headset decode, network, battery or thermal savings.** Duplicate content may compress differently, but no bitrate or encoder saving is promised. Deduplicating estimation can reduce headset matcher work; that is a separate measured benefit, not a substitute for the cost gates below.

The lifecycle work must be independently reviewable and releasable. Safe history/output ownership is a correctness prerequisite, but a larger enabled resource set must still pass admission and performance checks. Neither cleanup correctness nor a working mode carrier justifies enabling host pacing.

### 1.1 Review adjudication

| Review point | Verdict and correction |
| --- | --- |
| V1 gives no decode/network relief | Confirmed as the design scope. Measure actual encode/decode cadence; do not assume every duplicate is sent identically. |
| The previous memory justification was insufficient | Confirmed. Budget selected formats, actual physical allocations, runtime image counts and peak lifetime. A fixed cap is a guard, not evidence that a profile fits. |
| 2204x2352 is the primary client allocation size | Not established. The cited diagnostic labels it a historical, pre-apply `GetRecommendedRenderTargetSize` for the PC game. After restart that report records 4348x4700. Neither establishes decoded/projection texture extent. |
| FP16 is possible | Confirmed. Destination-format discovery explicitly anticipates packed 10-bit and FP16. Packed RGB10_A2 is 4 bytes/pixel; RGBA16F is 8. They must not be conflated. |
| Current motion maps are shared across components | Confirmed: two persistent eye fields plus two worker scratch fields, all RGBA16F, and one 1x1 GME texture. A separate-field proposal costs more than today's shared topology. Equal extents alone do not prove sharing is correct for fovea/background. |
| The 12 ms estimator budget establishes headroom | Denied. It is a CPU elapsed-time check around GPU command submission, per worker call, with incomplete final-pass coverage. It is neither completed GPU time nor a deadline for a whole stereo composite. |
| One estimation per distinct source render is required | Confirmed; now an explicit invariant and performance gate. At a genuine 45 Hz source, duplicate 90 Hz decodes must not trigger 90 estimations or 90 history copies. |
| Texture inequality proves distinct frames, and duplicates always fail it | Denied as a general rule. A duplicate can arrive in another texture; a reused texture can contain new pixels. Same-handle duplicates can fail the existing guard and clear `mvValid`, but an every-other-tick failure is not proved without a trace. |
| A numeric latency/reprojection gate is missing | Confirmed; added before Phase C. Source sample age, head-pose latency, content latency and queue delay need separate measurements. |
| Half rate necessarily adds 22 ms latency, or interpolation always adds another 22 ms | Needs qualification. At 90 Hz, source intervals become 22.222 ms rather than 11.111 ms. This changes sampling age, not necessarily all head-pose latency by 22 ms. Waiting for a future interpolation endpoint adds delay depending on scheduling. V1 must use causal extrapolation without future-frame waiting. |
| Snapshot bandwidth must be explicit and redundant copies removed | Confirmed. A real snapshot and the current synthetic staging commit contain different pixels at different times; merely retaining that blit is not a safe fusion. The revised pipeline captures real history once and draws synthetic output directly into owned acquired images. |
| `PostPresent` throttle=1 needs a go/no-go test | Confirmed. It remains an unproved runtime mechanism for this exact driver/SteamVR path, including SteamVR OpenXR games. |

### 1.2 Non-negotiable constraints

- ASW defaults Off. Off retains no ASW-owned heap buffers, GPU textures, swapchains, estimator state, timing-query pool, fences, workers or growing queues. Existing fixed interception/control state may remain; no new Off polling service or GUI process is introduced.
- Preserve the user's saved request. Unsupported or failed half rate is visible; do not silently rewrite the mode, precision, resolution, codec or other settings.
- Keep late-frames-only behavior available with correct ownership. Half rate and late-frame recovery must have separate acceptance results.
- Preserve both eyes and both video components as one coherent submission. Preserve alpha, FOV, pose, rect, array index, layer order, flags, space and display time. Preserve unrelated layers.
- No stock-image writes after downstream `xrReleaseSwapchainImage`. No mutable stock texture handles used as durable history.
- No fabricated frame timings, encoder FPS overrides, sleeping in frame hooks, dropping encoder submissions, global SteamVR pacing settings or game injection as an implicit fallback.
- Keep Optical Flow/OFXR and ASW mutual exclusion and confirmed-save behavior. OFXR registration or an "Armed" state is not evidence of active synthesis.
- No deployment, headset/ADB action, SteamVR restart, install, commit, push or workflow dispatch is performed by creating this plan.

## 2. Baseline evidence and resource design

Source snapshot inspected: GalaxyXR-Driver `b0abc9091cf6d0bd2e94d6a918aff47b9cb737c5`; steamlink-patches `28056a956ceae1164944d88bee45e803f292655c`, with existing local edits. Recheck source and dirty-file diffs before implementation. Exact Steam Link compatibility is a `(versionName, versionCode)` pair. The current patch supports both `2.0.20/5001712` and `2.0.23/5002363`, each with its own guards; older layer README wording is incomplete. Preserve both existing bases and validate the new protocol/pacing support separately for each. A base without fresh passing evidence retains its existing compatible behavior and reports true half rate unavailable; do not borrow offsets from another base.

### 2.1 Capture the actual allocation and timing profile first

**Client texture size is variable with the user's SteamVR configuration. There is no single fixed "headset resolution" for admission.** Budget the active size selected by the user; never assume 2204x2352, the panel dimensions or a PC recommendation is the allocation size. A successful test at one resolution does not admit a larger one.

For each tested stream, record the exact host module/build, patched APK and layer hashes, headset/runtime version, codec, display refresh, actual game cadence, encode/decode cadence, and thermal state. Record separately:

1. Game recommended render size, encoded frame/atlas size and decoded surface size.
2. Every selected projection component/eye: backing texture extent, image rect/offset, array layer, internal format, samples, mips, FOV, pose, alpha/blend semantics and swapchain identity.
3. Every owned swapchain's runtime-enumerated image count, physical texture count and allocation descriptors. Stereo array layers must not be mistaken for independent physical textures or counted twice.
4. Resolved estimator input/map dimensions, persistent maps, scratch resources and private runtime overhead where observable.
5. Current CPU submission time and completed GPU time for estimation, each warp, each copy, synchronization and the aggregate display tick.

Construct a layout/profile fingerprint from observed backing sizes, subimage rects/array layers, format, samples, mips, component geometry and runtime output counts. A change invalidates readiness and triggers unpacing, safe retirement and fresh admission before synthesis resumes. Detect backing-size changes even if the submitted image rect happens to stay the same. Observe the actual runtime layout; a SteamVR slider change may take effect only on later swapchain/stream creation or restart. Do not promise a hot resize where the runtime requires recreation. While Off, do not add a resource-query loop to monitor settings.

An imported native-buffer context can be null. Learn the actual owning EGL context/display from successful resource creation on the client's render path; do not derive ownership solely from an import-hook argument.

The historical 2204x2352 example is useful for sensitivity analysis only. In particular, `2204 % 16 = 12`: the current estimator rejects this input width because it requires dimensions divisible by 16. An actual trace at that extent would first expose an initialization incompatibility, not a proven supported memory profile. Never silently round, crop or pad it. Any explicit padding design requires coordinate, format, memory and error validation of its own.

### 2.2 Re-derived memory budget

Use bytes for admission and MiB (`2^20` bytes) for reporting. Decimal MB/GB are labeled explicitly. Count all enabled-only retained CPU/GPU resources and transition peaks, not just texture payloads.

For each selected view subresource `j`, let `P_j = W_j * H_j`, `b_j` be actual destination bytes/pixel, and `N_j` be the number of runtime output images backing that view. In the simple four-independent-view layout used in the example below:

```text
U                  = sum_j(P_j * b_j)            # one real composite
immutable_history  = 2 * U                      # two distinct real composites
synthetic_outputs  = sum_j(N_j * P_j * b_j)
current_shared_mv  = 4 * 8 * M + 8               # 2 eye fields + 2 scratch + 1x1 GME
accounted_bytes    = immutable_history + synthetic_outputs + current_shared_mv
                    + all other ASW-owned allocations
```

`M` is one resolved eye-field pixel count. Default map dimensions are input width/2 and height/2. If one additional persistent stereo field is needed for the other component, this topology becomes `48*M + 8`, not `32*M + 8`; additional scratch/concurrent work changes it again. Use the implemented allocation graph rather than assuming all resources are replicated per slot. If components have different dimensions or formats, sum their actual sizes instead of multiplying a common size.

Physical descriptors are authoritative for array textures, mip levels, MSAA and padding. Do not add borrowed stock swapchain/decoder images to ASW-owned bytes, but include them when measuring total application memory. Private OpenXR allocation overhead and allocator alignment are not zero merely because their size is opaque.

**Illustrative sizing only:** two components x two eyes, all 2204x2352, two real history images per view, default half-size maps, and shared fields. These dimensions are not claimed to pass the current estimator constraint.

| Destination | Runtime N per view | History, MiB | Synthetic output, MiB | Shared maps/scratch, MiB | Subtotal, MiB |
| --- | ---: | ---: | ---: | ---: | ---: |
| RGBA8 / SRGB8_ALPHA8 / packed RGB10_A2, 4 B/px | 2 | 158.20 | 158.20 | 39.55 | 355.94 |
| RGBA8 / SRGB8_ALPHA8 / packed RGB10_A2, 4 B/px | 3 | 158.20 | 237.30 | 39.55 | 435.04 |
| RGBA16F, 8 B/px | 2 | 316.39 | 316.39 | 39.55 | 672.34 |
| RGBA16F, 8 B/px | 3 | 316.39 | 474.59 | 39.55 | 830.54 |

An independent persistent field per component adds 19.77 MiB here: the N=3 totals become 454.82 MiB and 850.31 MiB. That explains the larger previous formula; it must not be represented as today's shared-map allocation. None of these subtotals includes programs, FBOs, query/fence storage, alignment, driver/runtime overhead or old/new overlap.

Today's four staging textures alone would be 79.10 MiB in the illustrative 4 B/px case (82.94 decimal MB). Including current shared fields/scratch gives about 118.65 MiB before other overhead. These are sizing calculations, not a measured resident GPU-memory baseline.

Admission rules:

- Keep **512 MiB as a provisional upper guard**, not a device-validated safe budget. Establish a lower profile-specific budget if measured headroom requires it. Do not silently raise the guard to make an example pass.
- The illustrative FP16 N=2 and N=3 cases exceed that guard before overhead. They are unsupported by this resource layout under this guard. Precision reduction, smaller history or a different ownership design needs explicit review; never silently substitute RGBA8.
- The illustrative shared RGBA8 N=3 case leaves approximately 77 MiB below the guard before uncounted overhead. It is not proved to pass or fail on the primary configuration. Measure the actual profile before calling it admitted.
- Allow N=2 when the runtime actually enumerates two images and lifecycle tests pass. OpenXR does not offer a requested fixed image count in `XrSwapchainCreateInfo`; do not assume the runtime will return two. Budget all enumerated images, including counts above three.
- Preflight known texture bytes before allocation. Create outputs incrementally, account actual image counts, then reject and fully retire the candidate if the complete set exceeds budget. Avoid keeping old and replacement pools live together: unpace, drain, destroy and rebuild. A rejected candidate must leave no retained resources and no host throttle.
- Bound added CPU metadata to **64 KiB** total per active session, including queue capacities. Use at most **16 in-flight source associations** and a small fixed timing-query ring. No unbounded vectors/log buffers. All heap backing is enabled-only and released when Off completes.
- Total application memory must be measured too; opaque runtime overhead cannot be certified by the texel formula. Do not claim an exact RSS/PSS value from logical allocation counters.
- Apply admission to every newly observed SteamVR-selected size. Larger user selections may become visibly unsupported under the same guard; preserve their values and stock pacing. Never silently lower SteamVR resolution to make ASW fit. Memory scales with the actual pixel areas, and estimator cost/error must be revalidated for the admitted resolution range rather than extrapolated from one example.

### 2.3 Optical-flow topology across fovea and background

The current client uses its own GPU block matcher and pose-integrated warp. PC OFXR/NVIDIA Optical Flow is a separate synthesis path; it does not supply this client's fields.

Start from the existing shared stereo field only if an exact-build geometry audit and pixel tests establish that it is valid for both components. Compare FOV, image rect, crop, sampling coordinates, pose, temporal identity, alpha boundaries and composition order. Equal texture sizes and a source comment are insufficient evidence. Test motion both inside and across the fovea boundary, including different component contrast/visibility and disocclusion.

If sharing is incorrect, stop profile admission. Choose and validate either a correct coordinate transformation or separate component fields, and recalculate memory, aggregate GPU time and estimation dispatch counts. Do not preserve an incorrect shared field merely to fit the budget, or advertise 45 matcher calls/s while hiding twice the underlying work.

### 2.4 Source identity and estimation cadence

Required identity: `(streamGeneration, sourceRenderId, layoutGeneration)`, with real source timing and exact association to the encoded sample, decoded PTS and projection image. Add component/eye association where the format carries them separately. An EGL image creation epoch or texture ID is an observation, not a verified game-render identity.

- **At most one stereo estimation job per new distinct source pair** in the validated shared-field topology. After warm-up, 45 distinct renders/s must produce approximately 45 such jobs/s even if there are 90 decode arrivals/s. Record worker-eye and component dispatch counts too.
- A duplicate decode does not advance either real-history entry, copy another snapshot, regenerate vectors, or clear an otherwise valid field. Reuse the last valid distinct pair with its real timestamps until it is replaced or invalidated by age, failure or layout/session change.
- Track the last two distinct real composites, not the last two decode arrivals. A repeated ID with inconsistent timestamps, components or pixels is an association failure, not a reason to guess.
- Same texture/new ID must capture new pixels. Different texture/same ID must retain existing history. Synthesized pixels never enter real history.
- Compute the motion interval from distinct source timestamps: about 22.222 ms at 45 Hz, not the 11.111 ms decode interval. Derive extrapolation age from the chosen presentation time. Validate displacement/sign/pose subtraction at that baseline.
- Bound extrapolation to a validated age and missed-tick count. Initially admit at most one source interval beyond the newest real sample, with no future-frame wait; older/invalid content passes stock and causes readiness withdrawal as appropriate.
- Never stamp a decode with the latest independently arriving control message. Reordered, missing or late metadata must fail association visibly and withdraw half-rate readiness.

### 2.5 Immutable history and the copy ledger

For the initial design, **immutable snapshot means a copy into layer-owned GPU storage**, not a borrowed GL handle. Capture each distinct real component/eye once while its original image is acquired, waited and still writable/readable by the application, before forwarding its downstream release. Preserve original precision and required alpha. If release-time rect/layout information is not yet established, warm up without synthesis until it is; do not guess from an old layout.

Preferred pipeline:

1. Keep real-frame projection submission on the stock path. Do not add a copy of every real frame into the synthetic output pool.
2. Capture the two-entry real-history ring once per distinct source render. Synchronize GPU ownership without routine CPU blocking and never overwrite an entry still read by an in-flight warp.
3. On a synthetic tick acquire and wait all required private OpenXR output images. Render the four coherent view outputs directly into those images from immutable history/fields.
4. Release owned output images and substitute a frame-local copy of the affected projection descriptors. Preserve all unrelated composition data and forward `xrEndFrame` once.
5. A partial failure submits the unchanged stock composite; never publish a mix of synthesized and stock eyes/components. Release every acquired private image correctly even on failure.

This removes the current staging-to-stock synthetic commit blit. Reuse existing staging storage as history only after its content and in-flight lifetime are proved compatible; never alias live history with an output destination. A decoder-buffer reference/lease is a possible later optimization only after exact decoder ownership and fencing are proved. It is not the initial assumption.

At the illustrative size, four RGBA8 captures per distinct frame at 45/s move `4 * 2204 * 2352 * 4 * 45 = 3.732 GB/s` of payload. Logical read-plus-write traffic for that copy alone is at least **7.465 GB/s**; FP16 doubles both figures. This excludes matcher/warp reads, output writes and cache/runtime effects. It is not measured physical LPDDR traffic. Measure device bandwidth and power/thermal consequences; do not equate payload rate with DRAM traffic.

Fusing work means eliminating a real transfer with a validated render/decoder integration. The existing blit copies synthesized staging pixels into stock images at end-frame time; it cannot simultaneously capture the original real pixels earlier in the lifecycle. Never retain released-image writes in the name of fusion.

### 2.6 Enabled-only resource ownership and teardown

Use one lazy `EnabledResources` owner per active session/layout. It owns history, maps, scratch, programs, FBOs, output swapchains, bounded metadata backing, query objects and synchronization objects. A disengaged owner has no heap backing. Keep only minimal fixed-size session/control bookkeeping while dormant.

States: `Off -> Preparing -> Warming -> Ready -> Active`; any failure, disable, mode/layout change or session shutdown enters `Stopping` before `Off` or a visible failed state. Late-frame mode does not require host pacing. Ready is a capability/lease state, not evidence of actual half-rate game rendering.

- On disable: revoke readiness/unpace first, stop new ASW work, drain in-flight use, release private images, delete GL resources on their owning context, destroy private swapchains before forwarding session destruction, and free all backing storage.
- Capture the real EGL owner context/display on allocation. A null import context is not an ownership token. Never issue deletion against an unrelated current context.
- Drain pending retirement at guaranteed valid render/session teardown points while the owner context still exists. Avoid locks held across downstream calls that may re-enter wrappers.
- If safe deletion cannot yet happen, report `Stopping` with pending-resource counters. Do not report Off-complete or silently leak. A design without a guaranteed context-safe retirement route blocks release.
- Resize/reformat/reconnect invalidates history and readiness, then retires the old owner before building the replacement. No speculative double-sized resource sets.
- Cold Off and settled Off-after-On must both have zero ASW-owned live-resource counters. No shader compile, context creation, estimator call, snapshot copy or ASW background task is permitted while settled Off.

## 3. Gates required before protocol/pacing integration

The numerical ceilings below are **proposed engineering acceptance targets**, not measured performance or a medical comfort guarantee. Freeze the test method and thresholds before collecting acceptance results; do not loosen them after a failed run to label it passing.

### 3.1 Gate P: completed GPU time and distinct-source work

Use bounded asynchronous GPU timer queries, such as `EXT_disjoint_timer_query` when supported, and reject disjoint samples. Do not time `glDrawArrays`/`glFlush` on the CPU and call that GPU completion. Do not add a steady-state `glFinish`. Measure CPU work and synchronization separately. If trustworthy GPU timestamps are unavailable, use an external/vendor GPU trace; mark the gate unmeasured until then.

Compare matched runs at the actual selected extents/formats and runtime N:

- Stock/ASW Off at 90 real source frames/s and 90 Hz display.
- Enabled late-frame behavior at 90 real frames/s, including injected misses.
- A real, independently verified 45 Hz source at 90 Hz with synthesis disabled, then enabled. Use a controlled test source or explicitly paced test application before relying on the new host mechanism.
- Repeat 45 Hz with 90 decode arrivals carrying duplicate source IDs. Separately run 90 distinct source frames/s to characterize estimator saturation.

At refresh `R`, let `T = 1000/R` ms and `G_stock,p99` be matched stock client critical-path GPU time. Require:

```text
B_ASW = min(2.0 ms, T - G_stock,p99 - 2.0 ms)
```

If this is not positive, the profile is not admitted. Added aggregate ASW critical-path GPU time p99 must be at most `B_ASW`; total client critical-path GPU time p99 must be at most `T - 2.0 ms` (9.111 ms at 90 Hz), and p99.9 must not exceed `T` (11.111 ms). Added CPU submission/synchronization time p99 must be at most 0.5 ms. Report absolute and incremental time, frame misses, GPU utilization and thermal throttling, not just averages.

Aggregate scope includes history capture, both eye estimates, all component warps, output writes and synchronization. Count work on every presentation tick, including bursts; averaging 45 heavy jobs over 90 ticks does not establish the heavy tick fits. Current worker calls have separate budgets, multiple eye/slot calls and no completion guarantee; the 12000 us constant is not reused as this acceptance deadline.

For 45 distinct source frames/s, assert at most one estimation per distinct eligible pair and no extra captures on duplicate decodes. Report actual internal worker dispatches and map reuse. Maintain or reduce missed-display-frame rate versus the matched baseline; any ASW-caused missed deadline is investigated even if percentile targets pass. If separate component fields are needed, rerun the complete gate with their real cost.

### 3.2 Gate L: latency, extrapolation error and boundary coherence

At 90 Hz, `T = 11.111 ms` and a half-rate source period is `P = 22.222 ms`. In a simple uniform sampling model, worst phase age rises from approximately T to P and mean phase age from T/2 to P/2. This is not a measurement of total motion-to-photon, nor proof that late head-pose reprojection has the same extra age. Queue/render/decode delay is additional.

Use causal extrapolation only: no future endpoint, no intentional extra real-frame hold and no interpolation queue. Measure a genuinely 45 Hz source with the actual 22.222 ms motion baseline and predicted display times. A 90 Hz source with alternate output discarded is insufficient validation.

Provisional numeric gates at 90 Hz:

| Metric | Acceptance target |
| --- | --- |
| Additional physical head-motion-to-photon latency, ASW On versus matched 45 Hz paced/ASW Off | p95 <= 2 ms and p99 <= 5 ms |
| Additional physical content/input-to-photon latency, 45 Hz ASW versus 90 Hz stock | p95 <= T and p99 <= 2T; no additional intentional source queue |
| Additional queue residence due to ASW at matched 45 Hz | No extra queued source frame; p99 <= 1 ms of measured ASW-induced queue residence |
| Reprojection residual on known visible, non-occluded moving features | p95 <= 1 output pixel and p99 <= 4 output pixels, after mapping both components to a common presentation geometry |
| Fovea/background boundary disagreement on the same visible feature | <= 1 output pixel in deterministic boundary fixtures; no mixed source IDs or opposite warp phase |

Use repeatable translational, rotational, near-field and crossing-boundary stimuli, plus real motion-heavy scenes. Record angular equivalents of pixel errors at the actual FOV. Report occluded/disoccluded pixels, low-confidence regions and stock-fallback frequency separately; do not discard them to improve error statistics. A causal matcher cannot reconstruct genuinely unseen content. Require a defined low-confidence/disocclusion policy and visual review of tearing, halos, alpha, judder and comfort; the visible-feature thresholds alone cannot accept those cases.

Measure physical latency with a high-speed camera/photodiode or equivalent apparatus whose stated uncertainty resolves the 2 ms gate. Software timestamps quantify pipeline components but do not prove panel motion-to-photon. If measurement uncertainty is too large, report the gate unmeasured. Capture head and content latency separately, since pose reprojection can improve one while game content remains stale.

Failure of either Gate P or L blocks Phases C/D for that profile. Lifecycle corrections can still land independently after their own tests; failed performance evidence must remain visible.

## 4. Protocol and host pacing design, conditional on the gates

### 4.1 Versioned bidirectional readiness

Preserve the existing four-byte carrier on ValueTransport ID `0x48`: 0 Off, 1 late frames only, 2 half rate. The persisted mode remains 0-based: 0 late, 1 half. Do not repurpose this value into an acknowledged capability or use its delivery as proof of synthesis.

Audit exact-build host/client VTS ABI, unused IDs, size/type guards, dispatch/lifetime and return semantics before assigning any new channel. Adjacent IDs are not implicitly free. Prove the client-to-host path; do not presume a read-only remote-value API supplies it. If a safe bidirectional transport or exact source association cannot be implemented, report half rate unsupported and leave host pacing stock.

Define bounded, versioned messages for request, readiness/revocation and source association. Include protocol version/size, stream nonce, request/status sequence, layout generation, mode, refresh/source cadence, supported resource profile and failure reason. Source identity/timing must be bound to the actual video sample/PTS, including duplicate encodes of one source. An out-of-band latest-value control channel alone cannot provide that binding.

Readiness requires valid layout, admitted resources, compatible source association, warm distinct history/fields and current session/context. Refresh its lease about every 100 ms while enabling/enabled through existing frame callbacks; expire after 500 ms using each receiver's own monotonic time. No cross-machine timestamp subtraction. Explicit revocation is immediate when received; lease expiry is a backstop. No new Off worker or timer is retained.

A new stream nonce, layout, mode, reconnect, sequence rollback or malformed payload invalidates old readiness and frame mappings. The bounded 16-entry association queue rejects ambiguity/overflow; it does not relabel the newest decode from a newer control message. Host pacing is permitted only for a matching, fresh half-rate request/readiness generation.

Bootstrap without circular dependencies: keep source cadence stock while preparing; establish verified distinct source IDs and warm history at that cadence; acknowledge readiness; then request half-rate pacing. Failure at any step returns to stock pacing before retiring resources. Intentional switching between half-rate and late-frame modes revokes/re-warms the applicable generation.

### 4.2 SteamVR application pacing go/no-go

Candidate mechanism: the existing direct-mode `PostPresent` hook, with a stack-local copy of `Throttling_t` and `nFramesToThrottle = 1`. Preserve the original prediction offset and all unrelated fields. Audit the exact interface/ABI and application-throttling capability negotiation for the loaded driver/SteamVR build. Do not claim that the public API's existence proves this path honors it.

- Forward downstream exactly once. While Off, late-only, unready, expired, failed or unsupported, pass the original arguments verbatim, including null when supplied.
- Only use the local override during a matching ready half-rate session. Define and test null-input behavior from the verified ABI; do not invent a prediction offset when none is available.
- Do not toggle local overrides based on independently alternating callback parity. Verify what throttle=1 means to this compositor path and whether SteamVR sustains the intended R/2 application rate while keeping R display/stream cadence.
- First run a bounded controlled go/no-go experiment. Measure application submissions, GPU render time/load, compositor cadence and prediction behavior. Prove approximately 45 distinct renders/s at 90 Hz separately for OpenVR and games using the SteamVR OpenXR runtime, including GPU-light and GPU-heavy scenes.
- If honored only on one API/build, mark the other unsupported. If it does not reduce source cadence or harms prediction, do not ship a working-looking Half rate status. Document the failed mechanic and reassess the host mechanism separately.
- Test original downstream prediction behavior and fresh head poses. Do not synthesize frame-timing records, claim encode skipping is game pacing, change global motion-smoothing settings, or add sleeps as a fallback.
- On client readiness loss, restore stock arguments on the next applicable host callback; lease loss must restore them no later than the 500 ms expiry plus that callback. Record the fallback interval and held-frame behavior in testing.

### 4.3 Honest Companion status and settings compatibility

Keep requested mode, published carrier, client readiness, host pacing and observed synthesis as different states. Display useful states such as Preparing, Ready, Half rate active, Unsupported, Failed and Stopping, with the reason and requested value retained. "Half rate active" requires fresh client synthesis and measured host source cadence evidence, not merely successful publication. Reuse existing driver-info/UI polling; no new idle service, renderer or graph window.

Update native info emission, GUI types/domain status, shared state, page copy and source XLIFF together when implementing. State plainly that v1 keeps decode/network cadence and targets PC rendering savings. Preserve confirmed save, ASW/OFXR exclusion, user opt-outs and quit recovery. Do not reintroduce already-fixed stale OFXR cache assumptions.

No persistent readiness/lease keys. If changing persisted semantics requires migration, extend the existing native and GUI versioned migration chain together (currently through schema 5; recheck before assigning the next version), with dated comments and tests. Preserve explicit enabled/mode choices and tuning; do not reset existing users broadly or rewrite settings merely to reflect a runtime failure. Default remains disabled, mode 0. Restart-only prerequisites must say "Requires a SteamVR restart."; live transitions must not promise restart-free support until verified.

## 5. Delivery phases and independent landing criteria

| Phase | Deliverable | Go/no-go and independence |
| --- | --- | --- |
| A: baseline and exact-build audit | Allocation/timing trace, original behavior, format/layout/N ledger, VTS and direct-mode audit | Separate historical evidence from a fresh run. Unknown client extents, unsupported alignment or missing tooling remain explicit blockers to that profile's acceptance. |
| B1: lazy lifecycle | Enabled-only owner, context-safe cleanup, cold/settled Off counters, teardown and failure unwinding | Can land independently of all pacing/protocol work. No enabled resource expansion is needed just to fix Off retention. |
| B2: correct immutable history/output ownership | Pre-release real capture, private acquired/waited/released synthetic output, all-component atomic substitution, direct warp output | Can land independently after memory admission and correctness/performance checks for its existing late-frame path. No host throttle or half-rate claim. Test bounded arrival identities here; verified game-source identity is completed in C. |
| B3: headset feasibility gates | Completed GPU timing at 45/s and 90/s, duplicate-work fixture, physical latency/error evidence at real 45 Hz | Gate P and Gate L must pass for the actual profile before C. A controlled source/fixture exercises known distinct IDs without building the production transport first. No speculative protocol investment is used to excuse missing matcher measurements. |
| C: source metadata and readiness protocol | Exact frame association, one estimation/capture per distinct source, bidirectional generation/lease/failure behavior | Requires B3. Keep host cadence stock until association and readiness are proven; rerun gates through the production path. |
| D: verified host pacing | Guarded `PostPresent` candidate, runtime API/build go/no-go, honest Companion status | Requires admitted client profile plus fresh protocol readiness. Stop if actual game cadence is unchanged. No encoder/network cadence change. |
| E: release qualification | Regression matrix, memory/performance/latency results, package and runtime receipts | Release only profiles/APIs that passed. Lifecycle changes may release earlier without advertising true half rate. |

Do not combine B1 with a large protocol/pacing patch. Keep B2 separately reviewable because its enabled memory and copy behavior are materially different. Where a prerequisite cannot be met, land the independently validated correction and keep the affected half-rate profile visibly unavailable.

### 5.1 File ownership and integration map

| Responsibility | Implementation locations to inspect/update |
| --- | --- |
| Host bridge/protocol and runtime info | `GalaxyXRDriver/src/Driver/VrlinkTap.{h,cpp}`, its info emitter and config-consumption callers |
| Direct-mode pacing | `GalaxyXRDriver/src/Driver/FrameComponentShim.{h,cpp}`, exact capability/registration consumers |
| Defaults/migration, only if needed | `GalaxyXRDriver/src/Config/Config{.h,Loader.cpp}`, GUI `domain/types.ts`, `domain/driver-defaults.ts`, `state/galaxy-settings.ts` |
| Companion request/status/copy | `GalaxyXRDriverGUI/src-lit/domain/spacewarp-status.ts`, `services/ofxr-session.ts`, affected driver-info types/services, `features/stream-frame-page.ts`, `GalaxyXRDriverGUI/src/locale/messages.xlf` |
| Client lifetime/swapchains/history/identity | Sibling `extensions/gxr-spacewarp-layer/src/swp_dispatch.cpp`, `swp_egl.cpp`, `swp_hooks.cpp`, `swp_vts.cpp`, associated headers |
| Estimator correctness and GPU cost | Sibling `extensions/gxr-spacewarp-layer/src/spacewarp_est.{h,cpp}`, `swp_est_worker.cpp`, `swp_shaders.h` |
| Exact-build staging/audits | Sibling layer manifest/gate assets, native build/staging scripts and Kotlin patch consumers, following that checkout's current AGENTS/skills |

Do not edit `ThirdParty/`. Preserve Galaxy XR/neutral builds and legacy headsets. Assign disjoint builder files only after these seams are located; reconcile producer/consumer structures in the main thread.

## 6. Verification and release evidence

### 6.1 Focused source/fixture checks during implementation

- Extend `GalaxyXRDriver/tests/SpacewarpToggleTest.cpp` and add an external-output focused runner if still absent. Cover readiness generations, expired lease, malformed/old protocol, original/null `PostPresent` forwarding, actual local throttle arguments and failure restore. A mock proving throttle=1 was passed does not prove SteamVR honored it.
- Run relevant GUI Vitest suites: `domain/spacewarp-status.test.ts`, `services/ofxr-session.test.ts`, `domain/ofxr.test.ts`, `state/galaxy-settings.test.ts`, plus frontend compilation if UI/types change. Cover saved request versus actual activity, unsupported FP16 profile, lease loss, quit/disable and no extra Off service.
- Run matching native migration/NVENC/service checks only for affected consumers. Use `cargo test --locked --lib` if implementation reaches the Rust crate; documentation-only changes do not require the full build unless the plan also changes code.
- Extend sibling `swp_dispatch_tests`, `swp_vts_tests`, `swp_hooks_tests` with observable GL/XR lifetime and allocation spies. Cover source IDs independent of texture handles, both components/eyes, duplicate/reordered PTS, layout changes, private output runtime N=2/N=3/N>3, every partial allocation/copy/acquire/wait/release failure, context loss and teardown ordering.
- Assert no use of original images after release, no history overwrite while in flight, no mixed composite, no synthetic-history feedback, bounded storage, and no leaked acquire on fallback. Run at least 100 mocked enable/disable cycles and failure-at-each-step unwinding.
- Exercise real estimator shaders with actual GLES compilation/linking and deterministic motion/alpha fixtures; syntax/math scripts alone do not establish successful programs or correct pixels. Retain `swp_shader_syntax.py` and `swp_est_math_test.py` as supplementary checks.
- Tests with a fake estimator prove dispatch only. They cannot establish the estimator's memory, timing, precision or actual shader output. Do not duplicate these limitations as a "GPU passed" receipt.

Use the check commands/runners discovered in each checkout; inspect native runners for toolchain download behavior before invocation. All generated artifacts/logs/fixtures stay under `../builds/GalaxyXR-Driver/` or `../builds/steamlink-patches/`, resolved from the owning project root. Keep the end-of-plan full local build and authorized-action boundaries intact.

### 6.2 Device/package acceptance matrix

Run only when the corresponding runtime/device actions are authorized. Each row needs exact package/module evidence and fresh traces; source assertions and an old `info.json` are insufficient.

| Scenario | Required result |
| --- | --- |
| Cold Off, stock stream | No ASW resource allocation/work and no app memory increase attributable to ASW. Compare the same build with the layer disabled and the pre-change build under identical stream conditions. |
| On then Off, at least 20 device cycles | Off completes with every owned resource/byte/worker counter zero; no monotonic memory growth. Report total app PSS/native/graphics/runtime memory as well as logical counters and measurement noise. Investigate retained runtime pools, not just layer counters. |
| Wrong/missing EGL context, resize, reformat, disconnect, session destruction | Unpace first; guaranteed safe retirement before parent session/context destruction; no silent leaks, delayed stale cleanup or mixed frames. |
| Low, typical and high SteamVR-selected client sizes, including a transition across the admission limit | Derive budget from actual new allocation descriptors, invalidate old readiness and re-admit safely. Test backing-size-only changes, restart/reconnect application of settings and unsupported alignment. Preserve resolution and mode requests; no old/new pool overlap or stale fields. |
| 90 Hz stock source versus 45 Hz verified source | Correct distinct IDs/PTS; one job/capture per eligible distinct render at 45/s; 90 decode arrivals do not double matcher work. True source cadence is measured independently. |
| Two components and both eyes | Matching source generation/phase; boundary/alpha/FOV/rect correctness; shared-field validity or separately admitted correct fields. |
| Packed 8/10-bit and FP16 paths | Preserve selected actual format; use actual extent/N ledger. Unsupported profiles fail visibly with request preserved and stock host pacing. |
| H.264, HEVC and AV1 with relevant supported calibration paths, on both 2.0.20/5001712 and 2.0.23/5002363 | No codec-specific association, precision or composition regression. Preserve each exact base's guards and existing behavior; admit new half-rate support only with that base's passing evidence. No borrowed native offsets. |
| Optical Flow/OFXR transitions and quit | Confirmed-save exclusion, no simultaneous synthesis, no resource carryover or new Off polling/processes. |
| OpenVR and SteamVR OpenXR, light/heavy scenes | Independently prove R/2 game rendering, full display cadence, prediction correctness and PC GPU benefit. Encode/decode/network cadence stays as designed. |
| Metadata loss/reordering, stale readiness, client failure | No guessed identity; stock pacing resumes within the defined lease/callback bound. UI distinguishes request, fallback and failure. |
| GPU, latency and image quality | Pass Gate P and Gate L on the real profile, including sustained thermals, disocclusion review and residual error. No headset saving claim based only on reduced job count. |

For memory, zero attributable regression is the requirement, not permission to add a small permanent Off allocation. OS/driver allocator noise needs repeated matched runs and explicit uncertainty, not a conveniently large tolerance. If total app memory remains higher after a complete Off cycle despite zero layer counters, explain and fix/contain it before claiming the requirement passed.

The final evidence bundle must include resource/byte high-water marks, Off-zero receipts, actual format/extent/N, source/decode/estimation/synthesis counters, GPU/CPU percentile distributions, frame misses, latency apparatus/uncertainty/results, component error maps, host pacing traces and API/build support decisions. Capture enabled diagnostics in bounded buffers; export through existing tooling and remove their backing while Off.

### 6.3 Rollback and completion criteria

Any failed admission, expired readiness or invalid association restores original host pacing and stock client submission, preserves the saved request with a visible reason, and retires the enabled owner. User disable follows the same retirement route. Do not label the transition Off-complete while cleanup is pending.

The half-rate feature is complete only when a supported exact profile satisfies ownership, unchanged settled-Off memory, actual R/2 game rendering, one estimation per distinct source, Gate P, Gate L and the regression matrix. A delivered carrier, mocked throttle, successful package or lower PC GPU load alone is insufficient.

## 7. Source references and interpretation limits

Paths below are relative to this document; line numbers are inspection aids for the 2026-10-21 source snapshot and will drift. Current source is authoritative over older reports.

| Evidence | Source |
| --- | --- |
| Current direct-mode forwarding without application pacing | [FrameComponentShim.cpp](../GalaxyXRDriver/src/Driver/FrameComponentShim.cpp), `PostPresent`, approximately line 2145 |
| Host mode encoding/delivery | [VrlinkTap.h](../GalaxyXRDriver/src/Driver/VrlinkTap.h), approximately lines 19-44; [VrlinkTap.cpp](../GalaxyXRDriver/src/Driver/VrlinkTap.cpp), configuration/publication |
| Current saved Off/default and UI descriptions | [Config.h](../GalaxyXRDriver/src/Config/Config.h), approximately lines 795-802; [stream-frame-page.ts](../GalaxyXRDriverGUI/src-lit/features/stream-frame-page.ts), approximately lines 309-316 |
| Projection dimensions, map sharing, texture-pair guard | [swp_dispatch.cpp](../../steamlink-patches/extensions/gxr-spacewarp-layer/src/swp_dispatch.cpp), approximately lines 1026-1056 and 1125-1136 |
| Destination format, staging and synthetic commit copies | [swp_dispatch.cpp](../../steamlink-patches/extensions/gxr-spacewarp-layer/src/swp_dispatch.cpp), approximately lines 576-744 |
| Estimator alignment/default map size and per-eye calls | [spacewarp_est.cpp](../../steamlink-patches/extensions/gxr-spacewarp-layer/src/spacewarp_est.cpp), approximately lines 109-121 and 270-297 |
| 12000 us budget definition | [spacewarp_est.h](../../steamlink-patches/extensions/gxr-spacewarp-layer/src/spacewarp_est.h), approximately line 190 |
| Scratch storage, CPU budget checks, flush and incomplete final-pass coverage | [swp_est_worker.cpp](../../steamlink-patches/extensions/gxr-spacewarp-layer/src/swp_est_worker.cpp), approximately lines 64-66, 300-303, 520-522 and 633-689 |
| Historical pre-apply PC render recommendation, not client texture evidence | [Native-resolution diagnostic](../../steamlink-patches/diagnostics/steamlink-streaming/2026-10-14-driver-reinstall-av1-500-and-native-res.md), lines 24-34 |
| Earlier integration defects and outstanding device timing | [Integration validation/fix report](../../steamlink-patches/diagnostics/vd-asw-multilayer/2026-10-20-ASW-INTEGRATION-DEFECTS-VALIDATION-AND-FIX-PLAN.md), historical evidence only |
| Both existing exact client bases and per-base staging guards | [GxrSpacewarpLayerPatch.kt](../../steamlink-patches/patches/src/main/kotlin/app/template/patches/steamlink/androidxr/GxrSpacewarpLayerPatch.kt), approximately lines 42-44 and 237-253 |

Primary API references: [Valve driver API documentation](https://github.com/ValveSoftware/openvr/blob/master/docs/Driver_API_Documentation.md#ivrdriverdirectmodecomponent) for the application-throttle contract; [Khronos swapchain release reference](https://registry.khronos.org/OpenXR/specs/1.1/man/html/xrReleaseSwapchainImage.html) for image ownership; [EXT_disjoint_timer_query](https://registry.khronos.org/OpenGL/extensions/EXT/EXT_disjoint_timer_query.txt) for asynchronous completed GPU timing and disjoint validity. API contracts do not establish that this exact SteamVR/headset path works or meets the proposed budgets.
