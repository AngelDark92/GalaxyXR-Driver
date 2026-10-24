# Handoff plan: encoder compliance with SteamVRColourLab

Prepared 2026-10-23, Europe/Paris. **Plan and operator runbook.** The compliance
feature (opt-in budget validation, accepted-configuration/per-output evidence, the
temporary notice) and additional instrumentation below are not implemented by the
original handoff. Only the test-only NVENC override harness was implemented and
built on 2026-10-24 (see §3A.8.1 and §11). No live test, settings change,
deployment or restart was performed while writing this plan.

Revised 2026-10-24: added §3A (NVENC frame-size mechanics, per-codec control audit
and a ranked first-fix order) and changed §7 to Phase 0/1/2 (superseded by the
test-execution task program below). This revision was documentation only; no code,
build, settings change or live test was performed.

Revised 2026-10-24 (test execution): the test-only `nvenc-experimental.json`
harness is implemented and built (see §3A.8.1 and §11); §1A now fixes the
single-conversation/dialogue protocol, §7 is the sequential task program, §8.1 is
the mandatory AV1/HEVC ColourLab acceptance matrix, and §11 is the successor's
productization and return-to-normal handoff. The harness was built and its focused
tests passed; **no live ColourLab test was run in this revision**.

## 1. Successor brief and decisions already made

Use **SteamVRColourLab as the visual workload generator** and the driver's actual
completed NVENC bytes as the host bitrate measurement. Test **300, 400, 500 and
600 Mbps**, always **Linear, Constancy 0%**. Do not substitute another curve or
raise constancy to make a favorable result. The primary codec is AV1, continuing
the user's session; **HEVC is mandatory**. H.264 is a post-winner compatibility
tail and does not select the AV1/HEVC winner. Test both 75 and 90 Hz, subject to
actual client support.

Implement **encoder compliance first**: opt-in requested-budget validation,
accurate accepted-parameter/output evidence and a temporary closable explanation.
Find and correct demonstrated causes of first-attempt oversize. **Do not implement
iterative re-encoding, committed-frame discarding, truncation, or a production
hard output guard in this phase.** Those were explicitly deferred after discussing
their latency and ownership costs. Unsupported requests fail visibly; no silent
codec substitution, bitrate reduction or tuning replacement.

The ranked first-fix order is in §3A. It starts with the keyframe envelope, because
the current matrix keeps Force CBR Off and the driver writes the keyframe ratio
only under CBR. Execution is governed by §1A/§7: one conversation, a dialogue
before every settings change, sequential tasks, and early stop at the first full
AV1/HEVC pass. The deciding suite is §8.1, not a single screening cell.

Two different success questions must stay separate:

- Does each completed encoded output remain **strictly below 2 MiB**?
- Does completed video production remain at or below the configured ceiling in
  **every rolling one-second interval**?

Input validation and a passing workload sample cannot establish a universal
future guarantee. A negative finding with complete evidence is a valid outcome
of the investigation, but must not be called a working protection feature.

The user reports that starting from the headset can fail while starting with
SteamVR Desktop View open works. Isolate start state alongside bitrate. Do not
attribute the problem to duration: both 15- and 45-second runs can fail.

## 1A. Execution contract: one conversation, a dialogue per settings change, tasks in order

This section governs how the plan is run. §7 is the detailed task program and
§8.1 is the acceptance matrix. Read all three before touching a setting.

### 1A.1 One conversation owns the run

The live run stays in **one conversation/session** from T0 through the winner and
productization (P3). Do not hand the test execution to a fresh conversation or a
different agent between tasks. Do not start a new session because a previous task
was slow, failed or was interrupted. Subagents may read code or evidence, but the
main thread owns every live setting change, run and verdict.

If the conversation is interrupted, resume it in the same conversation from the
task log in §7.11. The handoff to another agent happens **only after** the tests and
productization are complete; that successor reads §11, not a half-finished run.

### 1A.2 A dialogue box before every settings change

No setting is changed silently. Before writing `settings.json`, writing or deleting
`nvenc-experimental.json`, or asking the user to change a Companion/SteamVR field,
open a dialogue box (the host's question/dialogue UI) that states:

- the exact current value and proposed value;
- the codec/refresh/rate/workload scope;
- why the change is being made and which task it belongs to;
- whether it needs a SteamVR restart or reconnect;
- what evidence will be captured;
- choices **Apply**, **Keep current**, **Stop**.

Apply only after the user confirms. Record the answer, time and exact values in the
task log. Never edit first and ask later. Never bundle unrelated changes into one
dialogue. A fixed configuration may be authorized once for a cell sequence, but
each rate/refresh change still gets its own confirmation.

### 1A.3 Tasks run one after another

Run the tasks in §7.2 in order. A task is complete only when its result, evidence
path and next task are written in the log. Do not run two candidate arms at once.
Do not start a matrix cell before the candidate's screening cell has passed.

The task sequence is:

1. **T0** — current-build setup and baseline gate.
2. **A1–A7** — AV1 candidate search, only if the AV1 baseline gate fails.
3. **H1–H7** — HEVC candidate search, only if the HEVC baseline gate fails.
4. **P1–P3** — lock winners, productize, final acceptance and handoff.

A candidate arm is a **screening** run on the lowest reproducibly failing cell.
A candidate becomes a **gate** only after screening passes: run the full matrix
for that codec (§8.1). The first candidate that passes the full gate is that
codec's winner.

### 1A.4 Early stop: best settings win immediately

The first candidate that passes the full mandatory matrix for a codec is that
codec's winner. Stop testing lower-probability candidates for that codec. When
AV1 and HEVC both have winners (or one codec is negative), stop the whole search
and go to P1. Do not keep testing to fill a table.

A pass on the screening cell alone is not a winner. A candidate that passes AV1
but fails HEVC is not an overall winner. If a codec's baseline already passes its
full gate, the current defaults are that codec's winner and no candidate search
for that codec is needed. If no candidate passes, the result is negative for that
codec; do not change its defaults.

### 1A.5 The determining test

The determining test is **all SteamVRColourLab bitrate cells in §8.1 executing
without any problem**: AV1 and HEVC, 75 and 90 Hz, 300/400/500/600 Mbps, Moving
Detail and Changing Noise, both Start routes, with every completed output below
2,097,152 bytes, no `Packet too big`, no rolling-second violation, no
disconnect/reset/encoder failure and complete matching evidence. H.264 is a
post-winner compatibility check, not part of the AV1/HEVC winner gate.

### 1A.6 No hidden settings and no silent application

`nvenc-experimental.json` is a **test harness**, not a shipping setting. It must
not be required by the final build. The winning values become normal codec
defaults and/or normal editable page controls; the codec switch and reset arrows
apply them visibly, and the user can edit them. At P2 the harness file, its code
path and its read-only note are removed. No debug, verbose or graveyard flag is
left enabled. See §11 for the exact removal and productization checklist.

### 1A.7 Evidence root and task log

Create one evidence root for the run:

`builds/GalaxyXR-Driver/build/bitrate-monitor/compliance-<timestamp>/`

Keep the task log at `task-log.md` in that root and one subdirectory per task/cell.
Every task records: build and module hashes, settings before/after, dialogue
answer, accepted encoder values, ColourLab case UUIDs, raw capture/ledger data,
the verdict and the next task. The successor's §11 handoff uses this log.

## 2. Locations, authority and evidence freshness

Workspace: `D:\Angelo\Desktop\SteamLink-GalaxyXR-Windows-Toolkit-FULL`.

| Item | Path beneath workspace |
| --- | --- |
| Driver checkout | `GalaxyXR-Driver/` |
| ColourLab checkout | `SteamVRColourLab/` |
| Complete portable ColourLab executable, verify before use | `builds/SteamVRColourLab/dist/SteamVRColourLab/SteamVRColourLab.exe` |
| Driver build/test outputs | `builds/GalaxyXR-Driver/` |
| New captures | `builds/GalaxyXR-Driver/build/bitrate-monitor/compliance-<timestamp>/` |
| ColourLab build outputs and source-run artifacts | `builds/SteamVRColourLab/` |
| Earlier run observations | `GalaxyXR-Driver/Docs/SteamVRColourLabVerificationHandoff.md` |
| Older driver-oriented test plan | `GalaxyXR-Driver/Docs/NvencBitrateValidationPlan.md` |

Read each checkout's current AGENTS.md and skills, then inspect Git status before
edits. This document supersedes the older documents' **forward test instructions**
where they differ; their raw observations remain historical evidence. The earlier
observations handoff is deleted in the current worktree; read it from `HEAD` and
treat it as historical. Its retained 3,783,093-byte keyframe is the basis for
§3A.4-§3A.5. Do not
assume old source line numbers, PIDs, installed builds or settings remain current.

This writing request does not execute the implementation or tests. For the
successor, preserve existing session authorization: the agent handles software,
workload switching and capture; the user starts/reconnects streams and changes
requested stream settings through readiness dialogs. Do not infer authorization
for installing a package, stopping SteamVR, device mutations, commits or releases.
Ask only for genuinely missing authorization, not again for actions already covered.
The earlier Computer Use session was stopped with Escape; that interruption is
not an instruction to resume old window handles or pending test commands.

## 3. Transport facts and arithmetic

Static analysis qualified this VRLink build:

`8e7100b6b1e88d3ad6dd05f30f030dc9a69b092b64a60d35347cebb5c516b55d`

The inspected NVENC path forwards the reported encoded length unchanged into a
fragmenter with capacity for 2,048 fragments of 1,024 payload bytes. Metadata is
separate; no video envelope is prepended before that size check. Data/parity
fragment headers are added afterward. Thus the examined path permits encoded
length **<= 2,097,152 bytes**; this plan deliberately uses **2,097,151 bytes**
for the user's strict `<2 MiB` condition. This is a logical message, not a UDP
datagram. It does not establish successful delivery or a wire-rate limit.

Static anchors for re-verification: size copy `0xA21932–0xA21962`, send caller
`0xA2156A–0xA21581`, wrapper `0xA3234D`, fragment capacity `0xA4B445` /
`0xA4B4D3`, fragment-count check `0xA4BC0C–0xA4BC61`. The constructed FEC profile
is data/parity 8/2 with 512 parity slots. Qualify the build/profile rather than
copying these offsets to a different SteamVR update.

At a full-ceiling applied target, nominal budgets are:

| Ceiling Mbps | Average MiB/picture at 75 FPS | VBV 2 MiB at 75 FPS | Average MiB/picture at 90 FPS | VBV 2 MiB at 90 FPS |
| ---: | ---: | ---: | ---: | ---: |
| 300 | 0.476837 | 0.953674 | 0.397364 | 0.794729 |
| 400 | 0.635783 | 1.271566 | 0.529819 | 1.059638 |
| 500 | 0.794729 | 1.589457 | 0.662274 | 1.324548 |
| 600 | 0.953674 | 1.907349 | 0.794729 | 1.589457 |

Formula: `average bytes = Mbps * 1,000,000 / (8 * nominal FPS)`;
`requested VBV bits = floor(applied average bits/s / nominal FPS * VBV frames)`.
MiB means 1,048,576 bytes; Mbps is decimal. The table is an upper envelope for
requested buffering, **not an enforced maximum encoded-picture size**.
600 Mbps / 75 FPS / VBV 2 leaves only about 97,151 bytes below 2 MiB. Reducing
FPS at unchanged bitrate increases the average bytes per picture.

Current Linear/0% uses the caller's request capped at the configured ceiling;
it does not force the applied target to that ceiling. Capture the actual target.
A run averaging 236 Mbps with a configured ceiling of 500 is not proof of
full-ceiling 500 Mbps stability.

For requested-budget validation, let `P=2,097,151` and `N=VBV frames`:
`maximum integer Mbps = floor(8*P*verifiedFPS/(1,000,000*N))`.
For N=2: **629 Mbps at 75 FPS**, **754 Mbps at 90 FPS**. All four requested test
rates pass this arithmetic test. Do not advertise these as certified codec limits.
The message-cap arithmetic is shared across codecs; capability/geometry/RC
constraints still differ. H.264's current codec default is VBV 1, whereas
HEVC/AV1 default to 2. Explicitly set **VBV 2 for the T0 baseline/reproduction
arm** and record that H.264 override; the candidate and final gates use the
envelope selected by the task program in §7/§8.1. Do not let a codec switch
silently change the arm.

## 3A. Frame-size mechanics and ranked first-fix order (added 2026-10-24)

This section cross-references the NVENC frame-size analysis supplied on 2026-10-24
with the driver at commit `c9ad632` (v1.15.0-dev.3). It changes the order of work,
not the implementation. **Read it before §7:** the full 16-cell AV1/HEVC matrix
in §8.1 is the validation grid, not the first experiment. Probability labels are engineering judgment from
the cited evidence, not measured frequencies. Source references are relative to
`GalaxyXRDriver/src/`: `NvencTap.cpp` means `Driver/NvencTap.cpp`, and `Config.h`
means `Config/Config.h`.

### 3A.1 CBR bounds an average, not a single picture

CBR controls bits over time. It does not make every encoded output equal the
per-frame average, and `maxBitRate` is ignored in CBR
(`GalaxyXRDriver/src/Driver/NvencTap.h:72-77`). At 600 Mbps and 90 Hz the average
allocation is:

`600,000,000 / (8 * 90) = 833,333 bytes = 0.795 MiB`

At 500 Mbps and 90 Hz it is 694,444 bytes = 0.662 MiB. The retained
3,783,093-byte output is 4.54x the 600/90 average and 5.45x the 500/90 average; it
is 3.61 MiB. (The reported "3.8 MiB" is a rounded observation; the retained value
is exact.) At 600 Mbps it represents about 50.4 ms of link time, versus an
11.1 ms frame interval. A burst that size can be accepted by the encoder and still
cause a latency spike or a transport failure. `maxBitRate` is a rate parameter
under VBR and is ignored under CBR; neither is a per-picture ceiling.

The same 3,783,093-byte output against the plausible sessions:

| Session | Average bytes/picture | VBV 2 bytes | Observed / average | Observed / VBV 2 |
| --- | ---: | ---: | ---: | ---: |
| 500 Mbps / 90 Hz | 694,444 | 1,388,889 | 5.45x | 2.72x |
| 600 Mbps / 90 Hz | 833,333 | 1,666,667 | 4.54x | 2.27x |
| 600 Mbps / 75 Hz | 1,000,000 | 2,000,000 | 3.78x | 1.89x |

Even the most generous of those envelopes is exceeded by 1.89x. That is why the
first test is not "make the VBV smaller than 2 MiB" but "find out which envelope
the encoder was actually given, and whether the keyframe ratio applied."

The table uses the **full ceiling**. Under Linear/0% the applied average is the
caller's request capped at the ceiling, so a lower request makes the requested VBV
smaller, never larger (`NvencTap.cpp:1263-1326`). If the old run's **applied target**
was about 236 Mbps under a 500 Mbps ceiling (the output average alone does not
establish this), its two-frame VBV was about 0.62 MiB, not 1.325 MiB, and the
3.78 MB keyframe is about 6x that request. Capture the actual applied target; do
not infer the envelope from the ceiling or from the output average alone.

The three questions must stay separate:

| Question | What answers it | What does not |
| --- | --- | --- |
| Is the average target met over a window? | completed-byte deltas over time | one frame's size |
| Does every completed output fit the transport? | per-output size ledger or complete capture | sampled Mbps or a lifetime maximum alone |
| Is one output one coded picture? | complete OBU/NAL parse | `bitstreamSizeInBytes` alone |

### 3A.2 The 2 MiB limit is VRLink's logical message limit

The qualified VRLink path forwards the reported encoded length unchanged into a
fragmenter with capacity for 2,048 fragments of 1,024 payload bytes. The limit is
2,097,152 bytes per encoded output; this plan uses 2,097,151 for the strict
`<2 MiB` condition. It is a logical message limit, not an Ethernet/Wi-Fi MTU and
not a 2 MiB UDP datagram. Data/parity fragment headers are added after the size
check. The driver cannot fix it by changing MTU, and `NvencPostPack` cannot split
an encoded buffer because it processes the pre-encode texture, not the bitstream
(`GalaxyXRDriver/src/Driver/NvencPostPack.cpp:246-316`). Either every NVENC output
stays below the limit, or the VRLink send/fragment path must change; the latter is
outside this phase. This does not establish a decoder sample-size limit: if the
client also rejects a >2 MiB sample after fragmentation, that is a separate
decoder-side test.

### 3A.3 What the tap actually controls, by codec

`Force CBR` is off in every codec row by default, and the keyframe ratio is written
only inside the CBR branch. That single fact changes the test order: the handoff's
baseline (Force CBR Off) disables the only keyframe-specific driver control, the
one aimed at the observed oversized keyframe.

| Control | H.264 | HEVC | AV1 | Current tap behavior | Evidence |
| --- | --- | --- | --- | --- | --- |
| RC mode | caller unless forced | same | same | writes CBR only when `nvencForceCbr`; otherwise preserves vrlink's mode | `NvencTap.cpp:1346-1355` |
| average / max bitrate | all | all | all | average = curve/request capped at ceiling; max = average x (1 + headroom), headroom default 0; max ignored in CBR | `NvencTap.cpp:1263-1310`; `Config.h:862` |
| VBV size | row default 1 | row default 2 | row default 2 | `vbv = applied average / (forceFps or 90) * N`; 0 preserves caller; no capability query; no accepted-value export | `NvencTap.cpp:1317-1326`; `galaxy-settings.ts:78-82` |
| VBV initial delay | configurable | caller | caller | writes H.264 only (`h264VbvInitialDelay`, default 0) | `NvencTap.cpp:1245`; `Config.h:903` |
| keyframe ratio | only under CBR | same | same | writes `lowDelayKeyFrameScale` only when `forceCbr`; under VBR the saved Keyframe Size Budget is inert | `NvencTap.cpp:1346-1355`; `Config.h:855-858` |
| temporal AQ | preset merge | preset merge | preset merge | no explicit control; adopts the canonical preset's `enableTemporalAQ` | `NvencTap.cpp:1052-1055` |
| spatial AQ | Graveyard | Graveyard | Graveyard | explicit strength 1-15; preset merge adopts it only when no manual/tier value is set | `NvencTap.cpp:1356-1363`, `:1056-1061` |
| lookahead | caller | caller | caller | never adopted; a preset request is logged and the caller's value remains | `NvencTap.cpp:1041-1043` |
| multipass | auto or explicit | auto or explicit | auto or explicit | explicit wins; H.264 pinned 0 when preset merge is on and multipass is automatic | `NvencTap.cpp:1247-1250`, `:1045-1051` |
| split | not applied | applied | deferred ~5 s | H.264 skipped; AV1 held through the handshake; HEVC immediate | `NvencTap.cpp:1171-1206` |
| GOP / IDR | controllable | caller | caller | H.264 writes `gopLength` and `h264.idrPeriod`; HEVC/AV1 untouched | `NvencTap.cpp:1207-1221` |
| H.264 recipe | full | n/a | n/a | GOP/IDR, refs, entropy, slices, AUD/SPS-PPS, restriction flag, filler pin and initial VBV delay are explicit or tested defaults | `NvencTap.cpp:1207-1246`; `Config.h:889-903` |
| B-frames / reorder | caller | caller | caller | `frameIntervalP`, `zeroReorderDelay`, `enableNonRefP` read/logged, never written | `NvencTap.cpp:789-792`, `:1039` |
| intra refresh | caller | caller | caller | HEVC logged; never written; AV1 untouched | `NvencTap.cpp:796-797` |
| QP ceilings / floors | Graveyard | Graveyard | Graveyard | writes when nonzero; default 0 | `NvencTap.cpp:1328-1344`; `Config.h:843-853` |
| QP delta map | off by default | off by default | off by default | applies `qpMapMode=DELTA` only when fovea/periphery are nonzero; NVIDIA warns delta QP is applied after rate control and can violate VBV (the explicit emphasis-map note is H.264-only) | `NvencTap.cpp:1311-1314`; `ThirdParty/nvenc/nvEncodeAPI.h:1619-1624` |
| preset | auto P2 | P7/P5/P4 by engines | P7/P5/P4 by engines | preset merge adopts multipass, tAQ, AQ-if-unset and HEVC refDPB only | `NvencTap.cpp:988-1069` |
| forceIDR / reset | logged | logged | logged | reconfigure reset/forceIDR are logged, never handled | `NvencTap.cpp:1664` |
| accepted config | partial | partial | partial | `PublishSuccess` logs `RequestDescription(cfg)` (the request), not verified NVENC acceptance; `info.json` exposes only RC/split/size for accepted encoder state | `NvencTap.cpp:371-403`; `ConfigLoader.cpp:2237-2252` |
| observe-only | yes | yes | yes | a reconfigure without explicit `encodeConfig` passes through; one-shot log only | `NvencTap.cpp:1459-1469` |

Consequences for the test order:

- The VBV request is already 1.33 MiB at 500/90 and 1.59 MiB at 600/90, below the
  2 MiB limit. Re-deriving a "2 MiB VBV" is not the first test. The useful first
  question is why a 3.8 MiB keyframe exceeded a 1.3-1.6 MiB request.
- The matrix's Force CBR Off means the saved Keyframe Size Budget was not applied
  at all. The old run's effective mode was VBR, so the 3.78 MiB keyframe reflects
  VBR's own keyframe allocation; the driver's keyframe ratio was not part of it.
- The driver cannot prove the encoder honored the VBV request. It never queries
  `NV_ENC_CAPS_SUPPORT_CUSTOM_VBV_BUF_SIZE` and does not export the requested or
  accepted buffer size.
- Temporal AQ, `frameIntervalP`, lookahead and intra refresh are not user controls
  today. The supplied analysis's recommendations for them require new fields, not
  just a settings change.
- One doc/source mismatch to record: `Docs/StreamFrame.md:23` says "two-frame VBV
  ... in every codec row", but the H.264 row is 1 (`galaxy-settings.ts:80`). The
  test plan must read the saved row, not the prose.

Three recommendations in the supplied analysis need translation to this driver:

- A **1.5 MiB VBV** is not directly requestable: `nvencVbvFrames` is an integer
  nominal-frame count. At 500/90, VBV 2 is 1.325 MiB; at 600/90, 1.589 MiB. Use 1
  or 2 frames, or change the applied target.
- **`gopLength = NVENC_INFINITE_GOPLENGTH`** is not recommended for this lossy
  path. It removes the periodic recovery point. Keep a periodic IDR unless intra
  refresh is proven, and expose HEVC/AV1 cadence only as a labeled test.
- **`frameIntervalP = 1`** is a candidate, not an established fix: the retained
  oversized buffer is a single keyframe, so IP-only does not address it. Test it
  only for unclassified inter-frame bundles.

### 3A.4 The known oversized buffer is a keyframe, not an AV1 bundle

The only oversized buffer whose available headers were structurally inspected is
the earlier handoff's retained 3,783,093-byte keyframe: they declare one frame
header and a large tile group ending at the reported size. That is one coded picture. It is not evidence of
AV1's ability to concatenate a shown picture with preceding no-show pictures. The
earlier 3.81 MiB lifetime maximum is a different event and was not matched to the
retained keyframe or to a first drop; do not assign the keyframe's structure to it.

AV1 aggregation remains a real possibility for unclassified inter-frame maxima.
NVENC can pack non-displayed reference frames with the following displayed frame,
and the 2 MiB check applies to the whole buffer. The driver cannot detect this: the
probe publishes one size, a frame index and a keyframe bit, not a picture count
(`GalaxyXRDriver/src/Driver/NvencFrameProbe.h:27-39`; `NvencTap.cpp:1900-1976`).
The current probe copies at most 2 MiB, once per second per slot, and marks larger
outputs truncated, so it cannot prove the contents of a 3-4 MiB buffer
(`NvencFrameProbe.h:19-21`; `Docs/BitrateMonitor.md:84-101`). A complete capture
and an OBU count are required before blaming aggregation.

### 3A.5 The missing numbers: saved keyframe scale and actual nominal FPS

The retained failure's saved `nvencLowDelayKfScale` and actual `forceFps` were not
recorded. That matters because the keyframe envelope is not fixed by the codec
alone. Under the I/P interpretation NVIDIA documents, the envelope is
`average bytes per picture * keyframe scale`. At 500 Mbps/90 Hz:

| Saved keyframe scale | Requested I-frame envelope | Margin vs 2,097,151 B |
| ---: | ---: | ---: |
| 1 | 694,444 B (0.662 MiB) | +1,402,707 |
| 2 | 1,388,889 B (1.325 MiB) | +708,262 |
| 3 | 2,083,333 B (1.987 MiB) | +13,818 |
| 4 | 2,777,778 B (2.649 MiB) | -680,627 |
| 5 | 3,472,222 B (3.311 MiB) | -1,375,071 |

At 500/90, scale 3 is the largest integer ratio that fits on this arithmetic, and
it leaves only 13.8 kB (0.66%) of margin; any container overhead or a slightly
higher applied target breaks it. The observed 3,783,093 B lies between scale 5 and 6 at
500/90, between scale 4 and 5 at 600/90, and just below `VBV 2 * scale 2` at
600/75 (4,000,000 B = 3.81 MiB, essentially the recorded 3.81 MiB lifetime
maximum).

None of those coincidences proves the formula: NVIDIA documents the ratio as I/P,
not VBV x scale, and the old run's Force CBR Off means the driver did not write
the field. They do prove that **the saved scale and actual FPS must be read before
calling the output an encoder defect**. If the observed size is within the
configured or requested envelope, the first fix is to request a smaller envelope,
not to repair the encoder.

Two interpretations must be distinguished at 600/75:

- I/P ratio: `1,000,000 * 2 = 2,000,000 B`, under the limit by 97,151 B.
- VBV x scale: `2,000,000 * 2 = 4,000,000 B`, over the limit by 1,902,849 B and
  close to the recorded 3.81 MiB maximum.

Establish which envelope this encoder uses before trusting either. A complete
capture plus the accepted VBV and keyframe-scale values is the evidence.

### 3A.6 Ranked fix candidates

**Start here:** T0 on the current build. If the baseline fails, follow §7: check
the saved QP map; if `nvencQpFovea` or `nvencQpPeriphery` is nonzero, run the T0
baseline with both 0 first (A2, one variable, documented VBV violator). If the map
is already 0, run A1 (AV1/90/500, Force CBR On, VBV 1, Keyframe Size Budget 1). Do
not start with the candidate table or skip the T0 gate. Run in the order below. Stop at the first
passing configuration, then de-compose to the smallest change that still passes.
"Pass" means every completed output is `< 2,097,152` bytes across the workload and
transitions, no rolling-second violation, and no packet-too-big/reset storm.

| Order | Candidate | Probability | Why it ranks here | Driver status |
| --- | --- | --- | --- | --- |
| 0 | Current-build baseline and first-output classification | Required | Old 3.78 MB is from 1.14.0; saved scale/FPS missing | Partial probe |
| 1 | CBR On + VBV 1 + Keyframe Size Budget 1 (AV1) | High | Only classified oversize is a keyframe; keyframe control is inert under VBR; documented combo | Existing controls, no code |
| 2 | QP delta map off (if enabled) | High if enabled | NVIDIA documents delta QP can violate VBV; old run did not record it | Existing controls, no code |
| 3 | QP floor for IDR/I | Medium-high | Historical HEVC IDR ballooning fixed by a floor; AV1 default 0 | Existing Graveyard; add per-IDR QP log |
| 4 | Temporal AQ off | Medium | tAQ gives extra bits to reference frames; preset may enable it; no toggle | New field |
| 5 | IP-only / lookahead off / zero reorder | Medium for unclassified maxima | AV1 can bundle no-show frames; driver leaves intervalP/lookahead | New fields |
| 6 | Intra refresh instead of keyframes | Medium-low | Removes keyframe bursts; client recovery unproven | New fields |
| 7 | Multipass / split / preset / headroom / 10-bit | Low | Quality, parallelism or depth, not a keyframe cap | Existing controls |
| 8 | VRLink fragmentation | Deferred | 2 MiB is VRLink capacity; out of driver | Out of scope |

A2 is conditional: when the map is nonzero, its T0 + map-off arm is a smaller,
single-variable test than A1 and should run first; when the map is zero, skip it.
The numbering reflects the usual default (map off), not a claim that the map is
always present.

The older `Docs/NvencBitrateValidationPlan.md:74-88` already kept Force CBR On and
ordered VBV 1 before keyframe budget 1. Task A1 restores that keyframe-first order
and explains why the later compliance handoff's Force CBR Off baseline could not
exercise the keyframe control at all.

**0. Current-build baseline and classification (required, not a fix).** The
retained keyframe came from driver 1.14.0; the current checkout is 1.15.0-dev.3
with later VBV-zero and QP-map lifetime fixes. Reproduce the failure on the
current package before tuning. If it no longer fails, the fix may already be in
the current build; go to validation, not to the fix arms. Record the saved
`nvencForceCbr`, `nvencVbvFrames`, `nvencLowDelayKfScale`, `nvencMinQp`,
`nvencMinQpIntra`, `nvencMaxQp`, `nvencQpFovea`, `nvencQpPeriphery`,
`nvencMultiPass`, `nvencPreset`, `nvencSplitMode`, `nvencForceFps` and the codec
row. Record the `customVbvSupported` capability if the current build exposes it;
otherwise note that it is unavailable. If the existing probe sees the first
oversized output, record its full length, keyframe bit, frame index and generation
and proceed to task A1. A complete bounded 8 MiB capture is required before
classifying the buffer as single keyframe, single inter picture, multiple pictures
or unverified, but it is not required to start A1. Do not merge the
3.81 MiB lifetime maximum with the 3.78 MiB keyframe.

**1. Force CBR On + VBV 1 + Keyframe Size Budget 1 (AV1 first).** This is the
first arm in which the keyframe ratio actually applies, and it requests the
smallest documented envelope. Under the I/P interpretation, the requested I-frame
budget at 500/90 is 0.66 MiB at ratio 1 and 1.33 MiB at ratio 2; at 600/90 it is
0.79 MiB and 1.59 MiB. All are below 2 MiB. NVIDIA documents the ratio for CBR
with a single-frame VBV; with VBV 2 that premise does not hold, which is why 1A
pairs the ratio with VBV 1 and 1B/1C test whether either alone is enough. Do not
"fix" this by writing the ratio under VBR without evidence: NVIDIA documents it for
CBR plus single-frame VBV, and the driver's own tip says the same. If CBR is
unacceptable, A3 is the VBR-compatible path; A6, if implemented, is the
structural alternative.

Test 1A at AV1/90/500 (the retained failure) unless only another cell reproduces.
Keep Linear/0%, headroom 0, both bandwidth overrides 0, split, multipass and
10-bit unchanged. Confirm accepted RC=CBR and the requested VBV/keyframe values
from runtime evidence, not the saved JSON. Then de-compose:

| Arm | Configuration | Question |
| --- | --- | --- |
| 1A | CBR On, VBV 1, Keyframe Size Budget 1 | Does the documented combination bound the keyframe? |
| 1B | 1A with VBV 2 | Is keyframe 1 alone enough? |
| 1C | 1A with Keyframe Size Budget 2 | Is VBV 1 alone enough? |
| 1D | Force CBR Off, VBV 1, Keyframe Size Budget 1 | Is CBR required? The ratio is inert under VBR, so expect no keyframe effect. |

1A is deliberately conservative and may cost keyframe quality. The de-composition
arms exist to find the largest still-passing envelope, not to keep 1A if 1B or 1C
passes. If 1A fails while the output exceeds the requested envelope, the encoder is not
honoring the documented combination; go to A2/A3. If the output is within
the requested envelope but above 2 MiB, the requested envelope itself is too large;
lower VBV or keyframe scale. Do not change resolution, tile width, bitrate ceiling
or constancy to make the arm pass. No code is required; if the UI leaves Keyframe
Size Budget editable while Force CBR is off, add an inline "inactive without Force
CBR" note rather than rewriting the saved value.

**2. Disable the QP delta map if it is enabled.** If `nvencQpFovea` and
`nvencQpPeriphery` are both 0, the map is not applied; skip this arm and rule it
out from the saved settings. If either is nonzero, run the T0 baseline with both
0 first: that isolates the map from the CBR/VBV change. Then run A1 with both 0 if
needed. NVIDIA's header warns that a delta-QP adjustment is applied after
rate control and can violate bitrate/VBV constraints; its explicit Emphasis Level
Map note is H.264-only (`ThirdParty/nvenc/nvEncodeAPI.h:1619-1624`). The driver uses
`NV_ENC_QP_MAP_DELTA`, so treat the map as a plausible violator, not a proven one,
and the old evidence did not record it. No code; existing controls. Publish
`qpMapMode` and the map values in the accepted export regardless of the result.

**3. Add a QP floor for IDR/I frames (existing Graveyard controls).** The driver's
HEVC history is explicit: reset IDRs at QP 8-9 produced 3.5-5.4 MB, and a floor of
about 14-18 stopped the ballooning (`NvencTap.h:85-94`). The controls live in the
Graveyard, which requires the hand-edited `graveyardEnable` setting. AV1's
`nvencMinQp` default is 0. If A1 and A2 fail and per-IDR QP is low, a floor is the proven
stopper. It is a quality workaround, not a budget fix, and it can mask the RC
defect. The current `frameAvgQP` is cumulative, not per-picture; add per-IDR QP and
size logging before choosing a value. Use the codec's real QP range; NVENC validates
it, and the H.264/HEVC 0-51 scale must not be assumed for AV1. Record the effective
QP. If a high floor is needed (more than roughly 22 on the H.264/HEVC scale), stop
and prefer A1/A2.

**4. Turn temporal AQ off explicitly.** Check the one-shot preset diff log
(`NvencTap.cpp:1035-1040`). If the canonical preset already reports tAQ=0, skip.
If it reports 1, add `streamFrame.nvencTemporalAq` with `-1 = leave`, `0 = off`,
`1 = on`; default `-1` preserves current behavior, an explicit value wins after
preset merge, and the effective value is published. Test 1A + tAQ 0 and compare
both keyframe and inter-frame maxima. This is more likely to explain reference-
frame inflation than the known keyframe, so it ranks below A1-A3.

**5. Force IP-only, no lookahead and zero reorder delay.** First read the caller's
`frameIntervalP`, `zeroReorderDelay` and `enableLookahead` from the verbose init log
or the new export. If `frameIntervalP == 1` and lookahead is off, skip. If not, add
`streamFrame.nvencFrameIntervalP` (`0 = leave`, `1 = IP-only`),
`streamFrame.nvencZeroReorderDelay` (`-1 = leave`, `1 = on`) and
`streamFrame.nvencLookahead` (`-1 = leave`, `0 = off`); default leave, apply after
preset merge, publish the effective values. Capture a complete inter-frame buffer
and count OBUs before and after. This is the leading explanation for unclassified
>2 MiB buffers, not for the retained single keyframe. IP-only can reduce
compression efficiency; measure quality and latency.

**6. Intra refresh instead of periodic keyframes.** Add
`streamFrame.nvencIntraRefresh`, `nvencIntraRefreshPeriod` and
`nvencIntraRefreshCount`, apply to HEVC/AV1, validate per codec, and publish the
effective values. NVENC exposes `enableIntraRefresh`, `intraRefreshPeriod` and
`intraRefreshCnt` for AV1
(`ThirdParty/nvenc/nvEncodeAPI.h:2089-2106`), and tile-based refresh is the
AV1-relevant form. Steam Link recovery without IDRs is unproven. Test only after a
passing A1 or A5, with an induced packet-loss recovery check. This is a
structural keyframe-burst fix, not a quick arm, and it must not be used in the main
matrix until the client is shown to recover.

**7. Multipass, split, preset, headroom and 10-bit.** These change quality,
parallelism or depth; they should not make a single keyframe more than 2.7x the
requested VBV. Test one variable at a time on the lowest reproducibly failing cell:
multipass single/quarter/full, split 0/1, preset P2/P4/P5/P7, headroom 0/15, 10-bit
on/off. H.264 multipass is pinned 0 only when preset merge is on and multipass is
automatic; an explicit value wins. Split is skipped for H.264. P7 needs three
engines; check the engine-count log. Record accepted values; abort on the first
oversize.

**8. VRLink fragmentation (deferred).** The 2 MiB limit is VRLink's fragmenter
capacity, not a decoder or network-packet limit. A driver-side post-encode split
does not exist, and `NvencPostPack` is pre-encode. A correct fix would fragment and
reassemble the encoded output or raise the fragmenter capacity, which is outside
this phase and explicitly deferred. Do not truncate or drop an oversized output.

Do not test first: lowering resolution, tile width, bitrate or constancy to evade
the failure; raising QP blindly without per-IDR QP evidence; iterative re-encoding;
a production hard output guard. Those change the workload or the deferred scope.

### 3A.7 Decision tree

```
First oversized output, completely captured:
├─ single keyframe, one coded picture
│  ├─ QP delta map nonzero ........... A2 first (single-variable)
│  ├─ saved Force CBR Off ............ A1 (CBR + VBV 1 + keyframe 1)
│  ├─ keyframe QP low (per-IDR log) .. A3
│  ├─ temporal AQ on ................. A1 + A4
│  └─ all requested values honored ... A6 (if implemented) or transport
├─ single inter picture
│  ├─ requested envelope < 2 MiB ..... encoder over envelope: A2/A4/A5/A6
│  └─ requested envelope >= 2 MiB .... lower VBV/keyframe scale first
├─ multiple pictures in one buffer
│  └─ A5 (IP-only/lookahead), then A1 per picture
└─ truncated or unverified
   └─ recapture completely; no verdict
```

Two side branches:

- An **observe-only reconfigure** coinciding with the failure means the tap
  skipped its overrides because vrlink passed no explicit `encodeConfig`
  (`NvencTap.cpp:1459-1469`). Fix that path (apply from the preset or refuse
  visibly) before tuning; it is a driver gap, not an encoder setting.
- **`SUPPORT_CUSTOM_VBV_BUF_SIZE = 0`** means the VBV requests may be ignored.
  A1 may still work through CBR; if it does not, stop VBV tuning and use A3 or A6
  (if implemented). Surface the capability result in the UI and log.

### 3A.8 Settings and evidence to add

A4/A5 are available through the test-only harness implemented 2026-10-24; A6
(intra refresh / HEVC-AV1 GOP-IDR) is still not implemented. Do not add more
fields speculatively. T0/A1 need no code; add a normal field only when its arm is
reached and the preceding arms fail. A1-A3 and A7 use existing controls. A4/A5 use
the harness and must be graduated to normal settings/defaults at P2. A6 needs new
fields, the infinite-GOP coupling and a client-recovery test; it follows the full
AGENTS.md chain (`Config.h`, `ConfigLoader.cpp`, `types.ts`, `driver-defaults.ts`,
`galaxy-settings.ts`, the Stream Frame page, the native consumer, XLIFF/docs and
focused tests). Every new field defaults to leave/off so no saved tuning is
rewritten, and a capability refusal stays visible.

| Field | NVENC field | Default | Applies to | Why |
| --- | --- | --- | --- | --- |
| `streamFrame.nvencTemporalAq` | `rcParams.enableTemporalAQ` | `-1` leave | all | explicit off/on; preset merge currently owns it |
| `streamFrame.nvencFrameIntervalP` | `NV_ENC_CONFIG::frameIntervalP` | `0` leave (not NVENC I-only); `1` IP-only | all; AV1/HEVC first | prevent B-frame/no-show bundling at the source |
| `streamFrame.nvencZeroReorderDelay` | `rcParams.zeroReorderDelay` | `-1` leave | all | low-latency, no reorder |
| `streamFrame.nvencLookahead` | `rcParams.enableLookahead`, `lookaheadDepth` | `-1` leave | all | avoid extra latency and aggregation |
| `streamFrame.nvencGopFrames` / `nvencIdrFrames` (or HEVC-specific) | `NV_ENC_CONFIG::gopLength`, codec `idrPeriod` | `-1` leave | HEVC/AV1 | parity with H.264; control keyframe cadence, not remove recovery points |
| `streamFrame.nvencIntraRefresh` / `nvencIntraRefreshPeriod` / `nvencIntraRefreshCount` | codec `enableIntraRefresh` / `intraRefreshPeriod` / `intraRefreshCnt` | `0` off | HEVC/AV1 | remove keyframe bursts; client recovery test |
| `streamFrame.nvencVbvInitialDelay` (generic) | `rcParams.vbvInitialDelay` | `0` | all | CBR startup; currently H.264 only |
| no new field | `rcParams.lowDelayKeyFrameScale` | existing `2` | all | make the CBR-only condition visible in the UI; do not rewrite the saved value |
| no new field | `NV_ENC_CAPS_SUPPORT_CUSTOM_VBV_BUF_SIZE` | read-only | all | prove capability and surface an unsupported result |

Diagnostics come before more settings:

- Query the custom-VBV capability in the existing one-shot caps block
  (`NvencTap.cpp:1612-1623`) and publish `customVbvSupported` and the status.
- Publish the requested and attempted RC values: RC mode, average/max bitrate,
  VBV size and initial delay, keyframe scale, min/max QP and enable flags, tAQ,
  lookahead/depth, multipass, `frameIntervalP`, `zeroReorderDelay`,
  `enableNonRefP`, intra refresh/period, GOP/IDR, `qpMapMode`, split, codec,
  dimensions and FPS. Do not call `RequestDescription(cfg)` "accepted" without
  saying it is the request.
- Publish `observeOnlyReconfigures`, `resetCount`, `forceIdrCount`, `idrFrames`,
  `maxFrameBytesIdr`, per-IDR QP/size, and the existing size buckets.
- Capture the first oversized output completely up to a bounded 8 MiB with full
  length, captured length, truncation flag, SHA-256, picture type, frame index,
  generation, timestamp and parsed OBU/NAL picture count. Reject truncated
  evidence explicitly.
- Add the 16,384-entry size-only ledger already specified in §4.B: completion
  time, bytes, frame index, generation, keyframe bit and sequence-gap detection.
  The current 2 MiB, once-per-second probe cannot prove all-output maxima
  (`NvencFrameProbe.h:19-21`).

#### 3A.8.1 Pre-run experimental override file (implemented 2026-10-24)

The first five fields above have a test-only path that needs no page control.
The driver reads a separate file beside `settings.json` at startup / settings
reload:

`%APPDATA%/GalaxyXR/CustomHeadset/nvenc-experimental.json` (vendor build)
`%APPDATA%/CustomHeadset/nvenc-experimental.json` (neutral build)

The file is **not** `settings.json`, so the Companion never rewrites it and the
user's normal tuning is untouched. It is read by `ConfigLoader::ParseConfig`, not
per frame. Delete it (or leave all sentinels) to return to stock behavior. It is
test-only until an arm proves useful; the productized version then follows the
full Config/GUI/XLIFF/migration chain. A copy-paste template is in
`Docs/nvenc-experimental.example.json`.

```json
{
  "temporalAq": -1,
  "frameIntervalP": 0,
  "zeroReorderDelay": -1,
  "lookahead": -1,
  "lookaheadDepth": 0
}
```

Sentinels: `temporalAq`/`zeroReorderDelay`/`lookahead` = `-1` leave, `0` off,
`1` on; `frameIntervalP` = `0` leave, `1` IPP only; `lookaheadDepth` = `0` leave,
`1..31` only when `lookahead = 1`. An absent file leaves every sentinel in place.
A malformed or out-of-range file is logged, ignored, and shown in `info.json` /
the Stream Frame page; it does not fail the stream.

Use one variable at a time:

- A4 (temporal AQ off): `{"temporalAq":0,"frameIntervalP":0,
  "zeroReorderDelay":-1,"lookahead":-1,"lookaheadDepth":0}`.
- A5 (IP-only, no lookahead, zero reorder):
  `{"temporalAq":-1,"frameIntervalP":1,"zeroReorderDelay":1,
  "lookahead":0,"lookaheadDepth":0}`.

`frameIntervalP` is applied at **init only**. NVENC documents GOP-structure
changes as unsupported at reconfigure, and vrlink reconfigures before nearly
every frame; a reconfigure carrying a different value is logged and left alone.
If the value does not survive the connect-time reconfigure, the log says so and
the arm is inconclusive rather than silently forced. Reconnect after changing the
file. `info.json` publishes `encoderTap.experimental` (`present`, `active`, the
five values and `error`); the Stream Frame page shows a read-only note when the
file is present. The driver log prints one summary line and the normal
`override:` line when a value is written.

The separate file is also the safest place for a hand edit: the Companion's
normal save, codec switch and reset arrows preserve unknown `settings.json` keys,
but "Restore defaults", "Reset Setting" and uninstall can remove them. A sibling
file is untouched by all three except uninstall.

**Implementation receipt (2026-10-24).** The harness exists in the current
checkout and in the built test package:

| Piece | Evidence |
| --- | --- |
| Transient native fields (`nvencExp*`, present/error) | `GalaxyXRDriver/src/Config/Config.h` beside `nvencVerbose` |
| File read, range checks, log and ignore-on-error | `ConfigLoader.cpp` inside `ParseConfig` |
| Config-to-tap mapping | `FrameProcessor::UpdateEncoderSettings` |
| Tap apply/validate/restore and runtime telemetry | `NvencTap.cpp` experimental block, `ValidateRequest`, `Snapshot`/`Restore`, `PublishSuccess` |
| Read-only `info.json` evidence | `ConfigLoader::WriteInfo` `encoderTap.experimental` |
| Read-only Stream Frame note | `GalaxyXRDriverGUI/src-lit/features/stream-frame-page.ts` + `domain/types.ts` + `src/locale/messages.xlf` |
| Focused tests | `NvencToggleTest.cpp` experimental block; `ToggleMigrationTest.cpp` scenarios 29/30; `tools/Test-ToggleMigrations.ps1` loop `0..30` |
| Test package | `builds/GalaxyXR-Driver/output/GalaxyXRDriver-Test-20261024-111010` (DLL/manifest/Companion verified) |
| Live sentinel file | `%APPDATA%/GalaxyXR/CustomHeadset/nvenc-experimental.json` with all sentinels |

The codec defaults are **unchanged** by this harness: Force CBR Off, AV1/HEVC
VBV 2, H.264 VBV 1, Keyframe Size Budget 2, split 1, 90 fps budgeting. No page
control was added. The harness is temporary and **must be removed/graduated at
P2**; §11 lists every file to remove and every default/control to add.

### 3A.9 What this changes in §7-§9

- §7 becomes the sequential task program (T0 baseline, A1–A7 AV1, H1–H7 HEVC,
  P1–P3 productization/final acceptance) with a mandatory dialogue before every
  settings change. Force CBR Off and VBV 2 are the T0 baseline, not a requirement
  for the candidate arms.
- §8.1 is the mandatory AV1/HEVC ColourLab matrix and winner rule; §8.2 records
  the requested and accepted envelope, picture count, and a failure taxonomy that
  separates encoder-over-envelope from envelope-over-transport and aggregation.
- §9 narrows the generalization claim: a pass at CBR/VBV 1/keyframe 1 does not
  certify VBR/VBV 2/keyframe 2, and vice versa. The arithmetic and measurement
  method transfer; the runtime pass applies to the tested configuration.
- §11 is the successor's productization and return-to-normal checklist, including
  the exact harness removal and winning-default edits.

## 4. Implementation handoff: first-attempt compliance phase

### A. Refresh, validation and notice

- Add `streamFrame.nvencBudgetValidation`, default Off, through Config/loader,
  generated GUI defaults/types/shared state, page, native consumer and telemetry.
  Preserve both vendors, legacy headsets and existing explicit settings. No
  rewrite of old tuning is needed for this additive opt-in field.
- Read `Prop_DisplayFrequency_Float` from the actual active Galaxy XR shim's
  property container after successful activation; refresh on matching property
  changes and retry nonblocking from its independent update loop. Invalidate on
  deactivation. Do not assume tracked-device index 0 or derive nominal refresh
  from the caller's instantaneous per-frame FPS estimate.
- Publish negotiated refresh, observation state/generation and effective encoder
  nominal FPS separately. Support verified 75/90 initially. Unknown stays unknown;
  do not substitute 90 or wait synchronously for the first accepted encoded frame.
  If the property is unavailable before admission, refuse validation activation
  with a visible reason; first verify this bootstrap path on the real runtime.
- With validation enabled, positive saved encoder FPS must match verified refresh.
  Explicit FPS 0 means follow verified refresh **in this mode only**; explain this
  conditional behavior in the control tip. Outside the new mode, retain semantics.
- Require Tap enabled, the qualified VRLink build/profile, custom-VBV capability,
  zero headroom and positive VBV budget. Apply the formula above to all effective
  bandwidth sources, including Advanced and separate encoder overrides. Check
  overflow with wide arithmetic before converting NVENC fields.
- Keep invalid values editable and saved as requests, show field-specific errors,
  and refuse application natively as well as in the GUI. Do not merely add a
  number-input `max` that JSON imports or overrides can bypass.
- Use a temporary Fluent status message with a Close button and 10-second expiry;
  pause expiry on hover/focus and clear timers on page teardown. Show once on
  enabling and once per distinct rejection. Closing the explanation never hides
  persistent field errors or disables checks. Localize through t()/messages.xlf.
- Notice title: **Encoder budget validation**. Body explains the computed
  refresh/VBV limit and says **“These checks constrain requested encoder settings.
  They do not guarantee every encoded message stays below 2 MiB.”** Include
  **“Requires a SteamVR restart.”** in the mode's control tip.

### B. Diagnostic prerequisites before claiming compliance

- Record accepted parameters only after NVIDIA success: codec, size, average/max,
  nominal FPS, VBV/delay, keyframe scale, frame interval, lookahead, intra refresh,
  QP constraints, map mode, AQ, multipass, split, reset/IDR. Correlate submissions
  and completions by encoder/session/output identity. Summarize caller/converted
  QP-map distributions without hot-path disk logging.
- Add opt-in, bounded **per-output size/timing accounting**. The current monitor's
  cumulative counters and approximately one-second snapshots are insufficient for
  all-output maxima and arbitrary rolling-second peaks. Record monotonic completion
  time, byte length, frame/output identity, sequence/generation and associated
  accepted configuration. Detect duplicate locks, loss/gaps and EOS separately.
- Expose that accounting through a separately versioned read-only diagnostic
  export; preserve `GalaxyXR_NVENC_Probe_v1` and existing readers unchanged. Use a
  16,384-entry size-only ring with coherent publication and explicit sequence-gap
  detection. The collector drains at least once per second; any gap invalidates
  maximum/rolling-window proof. Do not write one payload file per frame.
- Capture the first failing output completely only when needed for AV1 framing
  analysis. Use a separate bounded diagnostic capture, up to 8 MiB, owned while
  the bitstream is locked; mark larger/truncated captures unverified. The existing
  2 MiB snapshot cannot prove the contents of a 3–4 MiB buffer. Avoid changing its
  capacity under the same ABI identifier.
- Establish a baseline before corrections. Investigate custom VBV support,
  accepted RC settings, inherited codec-specific QP limits, QP-map conversion and
  resets. Fix demonstrated defects only; do not assume one block's negative QP
  marker or the latest SteamVR update is the cause without isolation evidence.
- §3A.6 moves the first isolation before the matrix: RC mode, VBV frames, keyframe
  envelope, QP map, QP floor, temporal AQ, then frame interval. After the passing
  fix, isolate automatic versus quarter-resolution multipass and the other single
  variables on the lowest reproducibly failing cell. These are separate labeled
  experiments, not hidden changes to the matrix. The CBR-specific keyframe-budget
  combination is task A1, not a post-matrix afterthought.

### C. Source routing and agent ownership

The owning paths are the active-HMD shim for refresh, FrameProcessor for resolved
encoder settings, NvencTap for capability/accepted/output evidence, ConfigLoader
for info publication and validation, and shared GUI settings for persistence.
Pages remain thin. All new fields must cover the complete AGENTS.md chain.

Suggested cavecrew waves: read-only investigator establishes seams; bounded
builders receive one or two exact files at a time; main thread owns shared
schema/publication seams and integrates; independent reviewer checks the completed
diff. Assign no overlapping writers. Children never gain deployment authority.

For ColourLab changes, use its own project instructions. Correct the desktop/
headset stale bitrate-field synchronization before relying on those fields for
repeatability, and log explicit Start origin, clock start, first animated frame,
shared configuration and dashboard states. Add regression coverage. These are
measurement-integrity corrections, not proof that ColourLab causes the oversize.

## 5. How the successor operates SteamVRColourLab

1. After an authorized stream connection, open the **complete portable package's**
   `SteamVRColourLab.exe` at the path in section 2. Check the actual running path,
   version/hash, session metadata and matching source/shader identity. Rebuild via
   ColourLab's project workflow if instrumentation changed; old EXEs do not run
   edited source. Do not run a second competing VR game.
2. **Never use `--desktop` for a VR bitrate test.** That flag is preview-only.
   Using the ordinary application's Windows desktop controls is a valid VR start
   route; it is not the same thing as launching with `--desktop`.
3. Desktop route: open **Bitrate**, set **Workload**, **Duration (15–600 seconds)**
   and **Comparison target (Mbps)**, then **Start fullscreen test**. Available
   workloads: Static detail, Moving detail, High-contrast motion, and
   **Changing noise (maximum load)**. Use Moving detail and Changing noise below.
4. Headset route: open ColourLab's **OPEN OPTIONS** panel, choose **Bitrate**,
   cycle **Workload: … >** to the required case, set **Duration (seconds)** and
   **Comparison target (Mbps)**, then **Start fullscreen test**.
5. Set/check values on the same surface that starts the test. Until the sync fix
   is verified, desktop draft fields may disagree with shared headset values.
   The emitted case snapshot is authoritative for what the workload requested.
6. **Comparison target is only a note.** Entering 600 in ColourLab does not set
   NVENC to 600. Set the actual bitrate, codec, curve, constancy and refresh in
   Companion/SteamVR, then confirm fresh accepted encoder evidence independently.
7. To abort from desktop, click **Stop / restore**. From the headset, reopen
   **OPEN OPTIONS**, then **Stop / restore colour test**. F1 also reopens the
   controls. These restore the previous colour scene. Starting disables automatic
   colour cycling; record its original state and restore it separately if needed.
8. The timer starts on the first successful unobscured stereo submission, not
   the click. Expanded ColourLab controls, its dashboard overlay and the global
   SteamVR dashboard can delay it. During the wait, noise time remains zero,
   creating a possible static-noise/adaptation warmup. Once started, lost focus
   marks the case interrupted even though elapsed time can keep advancing.
9. Record **SteamVR Desktop View**, **global SteamVR dashboard**, ColourLab's
   expanded/compact menu, focus and tracking separately. Do not treat all these
   states as the same “desktop open” condition. Keep the headset awake and avoid
   opening menus during the timed portion, except to abort.
10. Use the supported UI; the current application has no workload-control IPC or
    `--noise` command. Old external `colourlab_operator.py` files only control a
    specially launched wrapper, not the ordinary packaged process. Do not issue
    commands to stale JSON files and assume the running EXE received them.

Portable logs are beside the EXE under `runs/<session>/`: retain `events.jsonl`,
`session.json`, `bitrate-workload-<case UUID>.json` and `telemetry/`. If the run
directory differs, derive it from the actual launch arguments/session metadata.
ColourLab's host target telemetry is not measured compressed-video throughput.

## 6. Bitrate capture: exact use and prerequisites

From the **driver checkout**, the existing GUI command is:

```powershell
python -B -m tools.bitrate_monitor
```

Use **Debug → Monitoring → Open monitor window** in Companion as an alternative.
The monitoring window must remain open/visible; its sampler stops when hidden.
Start capture before Start, retain it through the workload and recovery, and
export the completed source windows. Do not label whole-capture means as test means.

Example console capture for one arm, after choosing a new evidence directory:

```powershell
python -B -m tools.bitrate_monitor --codec-interval 1 --probe 120 --output '../builds/GalaxyXR-Driver/build/bitrate-monitor/compliance-<timestamp>/<arm-id>/capture.json'
```

Replace placeholders; do not literally reuse them. Add
`--adb '<actual adb.exe path>' --serial '<currently connected USB serial>'` only
when that headset is present and the authorized USB read is available. Do not
substitute wireless ADB, install probes, or enable telemetry without authorization.
The console command samples both sources; exit **2** can mean missing headset
data even when NVENC rows are valid. Inspect each source, not only the exit code.

The example's 120 seconds covers **one arm only**, not an entire cell or matrix.
Restart it with a fresh arm directory before each subsequent workload, or use a
longer continuous collector and explicit case boundaries. Keep capture running
as a managed command session while operating ColourLab; monitor live faults
instead of waiting for the command to finish before deciding whether to abort.

The current reader validates fresh info/PID/process creation, the actual loaded
DLL and SHA-256. Any source/session/generation change invalidates the rate baseline.
Frame inspection every second still cannot observe every output. The new size/
timing ledger is an additional prerequisite for the stronger acceptance tests;
extend the collector to export it with gaps and identities, not infer it from
the existing snapshot. Preserve complete/truncated flags and payload hashes.

Measurements to keep distinct: configured ceiling; accepted NVENC parameters;
completed encoded bytes; headset accepted decoder-input bytes if available;
WLAN RX all traffic. WLAN includes other traffic/FEC and is not decoder bitrate
or a packet-loss estimate. USB is the measurement connection, not the video path.

## 7. Sequential task program: settings dialogues, screening, gates and stop rules

§1A is the execution contract. This section is the task list. Run one task at a
time in the same conversation; open a dialogue before every settings change; stop
at the first full pass.

### 7.1 Task table

| Task | Phase | Candidate / change | Screening cell | Gate after screening passes | Stop / next |
| --- | --- | --- | --- | --- | --- |
| **T0** | Setup + baseline | Current defaults; Tap on; experimental file sentinels/absent | AV1/90/500 | AV1 8 cells, then HEVC 8 cells | If both pass, current defaults are the winners → P1. If AV1 fails → A1. If AV1 passes and HEVC fails → H1. |
| **A1** | AV1 | Force CBR On + VBV 1 + Keyframe Size Budget 1 | AV1/90/500 | AV1 8 cells | First pass = AV1 winner → H phase or P1. Fail → A2. |
| **A2** | AV1 | QP delta map off (if saved nonzero) | AV1/90/500 | AV1 8 cells | First pass = AV1 winner. If map is zero, record skipped → A3. |
| **A3** | AV1 | QP floor for IDR/I (Graveyard; labeled workaround) | AV1/90/500 | AV1 8 cells | First pass = AV1 winner. Fail → A4. |
| **A4** | AV1 | `temporalAq:0` via `nvenc-experimental.json` | AV1/90/500 | AV1 8 cells | First pass = AV1 winner. Fail → A5. |
| **A5** | AV1 | `frameIntervalP:1`, `zeroReorderDelay:1`, `lookahead:0` via the file | AV1/90/500 | AV1 8 cells | First pass = AV1 winner. Fail → A7 (A6 deferred). |
| **A6** | AV1 | Intra refresh / HEVC/AV1 GOP-IDR | — | — | **Not implemented in the current harness. Do not run; record deferred.** |
| **A7** | AV1 | One variable: multipass, split, preset, headroom, 10-bit | AV1/90/500 | AV1 8 cells | First pass = AV1 winner. Exhausted → AV1 negative. |
| **H1–H7** | HEVC | Repeat A1–A7 with HEVC defaults (A6 deferred) | HEVC/90/500 or lowest failing HEVC cell | HEVC 8 cells | First pass = HEVC winner → P1. Exhausted → HEVC negative. |
| **P1** | Lock | Record AV1/HEVC winners or negative; H.264 compatibility tail | — | — | Winners/negative recorded → P2. |
| **P2** | Productize | Remove harness; set codec defaults/controls; rebuild | — | Final build + full matrix with file absent | Pass → P3. Fail → restore previous defaults; report. |
| **P3** | Finish | Final receipt, cleanup, handoff | — | — | Done. |

T0 is deliberately a full baseline gate: the current defaults may already pass
now that the driver has newer fixes. If they do, stop immediately and keep them.
Do not tune against the old 1.14.0 capture.

No row starts without a dialogue reference and a recorded answer in the task log.
A missing dialogue means the task has not started; a failed dialogue means the
task is stopped, not silently skipped.

### 7.2 T0 — session setup and baseline gate

**Entry:** the user installed the new test package and fully exited SteamVR.
Verify the loaded `driver_GalaxyXRNative.dll` SHA-256, file version, VRLink hash,
ColourLab EXE hash/session identity and GPU driver. Record the settings before.

**Harness check before the baseline:** with the sentinel `nvenc-experimental.json`
present, the driver log must contain
`Config: nvenc-experimental.json loaded: temporalAq=-1 frameIntervalP=0 ...` and
the Stream Frame page must show **present but inactive**. This proves the new
package is loaded and the file is readable without changing behavior. If the line
or note is absent, stop and verify the package/hash; do not start the baseline.

**Dialogue:** confirm the baseline settings and that `nvenc-experimental.json` is
absent or all sentinels, NVENC Tap is on, and the user will start a fresh stream.
Record the saved values first; if they differ from the baseline, the dialogue sets
the baseline explicitly (never assume the saved file is the default).

Baseline settings to verify:

- AV1 first: Force CBR Off, VBV 2, Keyframe Size Budget 2, Linear, Constancy 0%,
  headroom 0, both bandwidth overrides 0, nominal encoder FPS 90, split and
  multipass unchanged, SDR 10-bit unchanged.
- Tap on. Experimental file sentinels (or absent).

**Screening:** AV1/90/500. If it fails, record the first failure, classify it with
§8's taxonomy, and go to A1. If it passes, run the full **AV1 gate** (8 cells). If
the AV1 gate passes, run the full **HEVC gate** at the current HEVC defaults
(Force CBR Off, VBV 2, keyframe 2). If both gates pass, the current defaults are
the winners → P1. If AV1 passes but HEVC fails, go to H1. If AV1 fails, go to A1;
run the HEVC phase after the AV1 phase ends (winner or negative).

### 7.3 A1–A7 — AV1 candidate search

Each task starts with a dialogue that names the exact change and the cell. Apply
the change, fully exit/restart SteamVR, reconnect, verify the accepted values, then
run the screening cell. A failure stops the task; do not continue its gate. A
screening pass unlocks the **AV1 gate** (all 8 AV1 cells); a gate failure means the
candidate is not the winner, even if the screening cell passed. If two single
changes fail, a combination is a separate, explicitly named task with its own
dialogue and gate; never merge them silently.

**A1 — keyframe envelope.** Force CBR On, VBV 1, Keyframe Size Budget 1. This is
the first configuration in which the driver's keyframe ratio actually applies. At
500/90 the requested one-frame envelope is 0.66 MiB at ratio 1. If A1 passes the
full AV1 gate, it is the AV1 winner; **do not de-compose** unless the user
explicitly asks for the least restrictive envelope. If the user asks, A1B
(CBR+VBV2+kf1), A1C (CBR+VBV1+kf2) and A1D (VBR+VBV1+kf1) are separate tasks and
must pass the same full gate.

**A2 — QP delta map.** If `nvencQpFovea` and `nvencQpPeriphery` are both 0, record
the saved values and skip to A3; the map is not applied. If either is nonzero, the
dialogue sets both to 0 on the **T0 baseline** (one variable), then run the
screening and gate. If that passes, it is the AV1 winner; do not continue to A3.
If it fails, A3.

**A3 — QP floor for IDR/I.** Only if A1/A2 fail and per-IDR QP evidence shows a
low-quality keyframe. The dialogue sets `nvencMinQp`/`nvencMinQpIntra` in the
Graveyard with `graveyardEnable` on; this is a labeled quality workaround, not a
budget fix. Screening and gate. If a high floor is needed, record the quality cost
and prefer A1/A2/A5.

**A4 — temporal AQ off.** Dialogue: write the file with
`{"temporalAq":0,"frameIntervalP":0,"zeroReorderDelay":-1,"lookahead":-1,"lookaheadDepth":0}`,
then fully restart SteamVR. Verify the log line says `temporalAq=0` and the Stream
Frame note is active with tAQ 0 before running the screening cell. Screening and
gate. If it fails, the next dialogue replaces the file contents for A5 (do not
leave a failed A4 value silently active).

**A5 — IP-only / no lookahead / zero reorder.** Dialogue: write
`{"temporalAq":-1,"frameIntervalP":1,"zeroReorderDelay":1,"lookahead":0,"lookaheadDepth":0}`,
restart, verify the log's `frameIntervalP` init value and any reconfigure-skip
warning, and confirm the Stream Frame note is active. `frameIntervalP` is
init-only; if the connect-time reconfigure resets it, record the arm as
inconclusive rather than silently forcing it. Screening and gate.

**A6 — intra refresh / GOP-IDR.** The current harness does **not** expose
`enableIntraRefresh`, `intraRefreshPeriod`, `intraRefreshCnt`, HEVC/AV1 GOP or
IDR. Do not fake it through the current file. Record A6 deferred; it requires a
separate implementation and client-recovery test. Do not let A6 block A7 or the
negative result.

**A7 — one-variable quality/latency arms.** Only after A1–A5 fail. The dialogue
names exactly one variable: multipass single/quarter/full, split 0/1, preset
P2/P4/P5/P7, headroom 0/15 or 10-bit on/off. Each is a separate task with screening
and gate. The first full AV1 pass wins; if every arm fails, AV1 is negative.

### 7.4 H1–H7 — HEVC candidate search

HEVC starts from its own defaults (Force CBR Off, VBV 2, Keyframe Size Budget 2,
Linear/0%, headroom 0, overrides 0). Run this phase even if AV1 is negative: the
codecs are independent and the user requires both tested. Use the same candidate
order as A1–A7, skipping A6 (not implemented); a general candidate (A1's
CBR/VBV/keyframe combination) is tried first. The screening cell is HEVC/90/500, or the lowest HEVC cell that failed in
T0. The gate is all 8 HEVC cells. The codecs are independent: keep the per-codec
winners separately, and a failure in one codec does not invalidate the other's
winner. If HEVC's T0 gate already passed, skip H entirely and keep the current
HEVC defaults.

Arm the experimental file with a dialogue before each H task, exactly as in A4/A5.
The file is shared by both codecs; the applied values are per-effective-codec, but
the requested fields are the same. Record the effective values.

### 7.5 P1 — lock the winners

Record, for AV1 and HEVC separately:

- the winning candidate and the exact settings (`forceCbr`, `vbvFrames`,
  `lowDelayKfScale`, `temporalAq`, `frameIntervalP`, `zeroReorderDelay`,
  `lookahead`, `lookaheadDepth`, QP map/limits, multipass, split, preset, headroom,
  10-bit);
- every cell verdict and evidence path;
- the accepted RC/VBV/keyframe values, not only the saved settings;
- the first failure of every rejected candidate, if any.

If a codec has no winner, mark that codec negative. Do not change its defaults.

**H.264 compatibility tail (optional, post-winner):** with the AV1/HEVC winners
recorded, run H.264 90 Hz at 300/500/600 Mbps, Moving Detail and Noise, using
H.264's own defaults plus the general winning fields that apply. This does not
select the AV1/HEVC winner. If H.264 fails, report it and leave H.264 defaults
unchanged; do not claim cross-codec safety. If the user does not need H.264,
record it pending.

### 7.6 P2 — productize; P3 — final acceptance and handoff

P2 is a code change, not a test-only file change. The dialogue must show the exact
codec-default changes and the harness removal before any edit. Follow §11 exactly:
remove the experimental file/code/note, set the winning per-codec defaults, add
normal visible controls for any winning field that is user-editable, rebuild with
`tools/Build-Portable.ps1`, and run the **full matrix again with
`nvenc-experimental.json` absent**. A pass on the test build does not prove the
final build; the final build is the one that ships.

P3 records the final package/hash, the full matrix results, the cleanup receipt and
the residual limits. The final handoff is §11.

### 7.7 Per-cell procedure

For each gate cell, open the rate/refresh dialogue, fully exit SteamVR, reconnect,
and verify the accepted values before starting the collector. Then:

1. **Moving detail:** 75 seconds; retain startup separately, use seconds 15–75 for
   the steady 60-second result. Confirm real unobscured stereo submissions.
2. **Noise qualification:** 15 seconds from desktop Start, then 15 seconds from
   headset Start, both with global dashboard/Desktop View closed and matched
   initial encoder target/menu state. Keep the complete transition in evidence.
3. If both pass, run **45-second noise** through both routes, reversing their
   order. Analyze onset, steady portion and Stop/recovery separately. Do not
   discard startup spikes by counting only a favorable settled interval.
4. If routes differ, pause rate escalation and isolate Desktop View open/closed
   with each Start route, then a deliberately matched five-second static-noise
   warmup. Record actual global dashboard state; do not assume Desktop View can
   remain open while that dashboard is closed. No alternate curves/constancy.

Start the collector before Start and keep it through the workload and recovery.
A cell is a gate pass only when all of its workloads and both Start routes pass.

### 7.8 Abort, rollback and candidate transition

Abort and restore on the **first logged Packet too big**, observed output
`>=2,097,152` bytes, rolling-second violation, disconnect or NVENC failure. Stop
longer arms/repeats for that configuration; label them skipped. Do not continue a
storm to obtain an average. Save the first failure and its accepted RC/VBV/QP map
context.

On a failed screening cell: stop the workload, restore/Stop ColourLab, record the
failure, and move to the next task. On a failed gate cell: the candidate is not the
winner; stop the gate, record which cell failed, and move to the next candidate.
Before the next task, use a dialogue to restore the previous confirmed settings
(or to set the next candidate); never leave a failed candidate's values silently
active.

If a setting causes an NVENC init/reconfigure failure, the driver fails visibly;
treat it as a candidate failure, not as a reason to lower the workload. Do not
change resolution, tile width, bitrate ceiling or constancy to make a candidate
pass.

An adaptive target below the configured maximum is allowed at Constancy 0%.
Mark a cell **ceiling not exercised** unless accepted targets reach it; do not
raise constancy or switch curves to force a favorable label. It still supplies
useful production evidence.

### 7.9 Early stop and winner rule

The first candidate that passes the full gate for a codec is that codec's winner.
Stop testing lower-probability candidates for that codec immediately. When both
AV1 and HEVC have winners (or a codec is negative), stop the search and go to P1.
A pass on the screening
cell alone is not a winner; a candidate that passes AV1 but fails HEVC is not an
overall winner. If a codec's baseline gate passes, the current defaults are its
winner and no candidate search is needed. If no candidate passes, the codec is
negative; do not change its defaults.

### 7.10 What the gate uses

Every gate cell uses: Linear / Constancy 0%; headroom 0%; both bandwidth
overrides 0; NVENC Tap on; nominal encoder FPS matching 75 or 90; the codec under
test; the candidate's RC/VBV/keyframe/tAQ/frameInterval/QP-map/QP-limit values;
unchanged multipass/split/image processing/10-bit and negotiated geometry unless
that is the one variable under test. Codec switching resets the optimized rows;
after a switch, use a dialogue to restore the candidate's values. Record the
accepted values from runtime evidence, not the saved JSON alone.

### 7.11 Task log and settings-dialogue template

Keep the log at `<evidence-root>/task-log.md`. The same conversation updates it
after every task. The successor reads it at P3. The header records the
conversation/session identifier, agent, start time and build hash; every row uses
that same identifier. A row from a different conversation means the run was split
and is not valid for a handoff.

| Task | Codec/phase | Candidate / exact change | Dialogue ref + answer | Screening | Gate | Evidence | Next |
| --- | --- | --- | --- | --- | --- | --- | --- |
| T0 | setup | baseline, Tap on, file sentinel/absent | | | | | |
| A1 | AV1 | CBR On, VBV 1, kf 1 | | | | | |
| ... | ... | ... | ... | ... | ... | ... | ... |

Dialogue template (use the host's question/dialogue UI; do not edit first):

```
Task: <T0 / A4 / H5 / P2>
Current: <exact saved values and effective values>
Proposed: <exact change, per codec/refresh/rate/cell>
Scope: <AV1|HEVC|H.264, Hz, Mbps, workload>
Why: <candidate/arm and expected effect>
Applies: <SteamVR restart / reconnect / both>
Evidence: <collector path and cell ID>
Choices: Apply / Keep current / Stop
```

Example A4:

```
Task: A4 (AV1 temporal AQ off)
Current: tAQ from the preset merge (log value: <read it>); experimental file absent
Proposed: nvenc-experimental.json {"temporalAq":0,"frameIntervalP":0,
  "zeroReorderDelay":-1,"lookahead":-1,"lookaheadDepth":0}
Scope: AV1, 90 Hz, 500 Mbps, Moving Detail + Noise
Why: test whether temporal AQ is inflating reference/key frames
Applies: full SteamVR restart (file is read at driver start)
Evidence: <evidence-root>/A4/
Choices: Apply / Keep current / Stop
```

Record the answer, the exact applied values, the accepted encoder values and the
evidence path. If the user chooses **Keep current**, do not write the file. If
**Stop**, stop the test program and write the interim handoff; do not continue.

## 8. Analysis, result files and acceptance

### 8.1 Mandatory acceptance matrix (the determining test)

The determining test is **all of these cells executing without any problem**:

| Codec | Refresh | Ceilings (Mbps) | Cells |
| --- | --- | --- | ---: |
| AV1 | 75, 90 Hz | 300, 400, 500, 600 | 8 |
| HEVC | 75, 90 Hz | 300, 400, 500, 600 | 8 |
| **Mandatory total** | | | **16** |

Each cell runs **Moving Detail** (75 s; analyze seconds 15–75) and **Changing
Noise** (15 s from desktop Start and 15 s from headset Start; if both pass, 45 s
through both routes, reversing order). Both Start routes, with matched dashboard/
Desktop View state, are part of the cell.

A cell passes only when its full workload and transitions have:

- every completed output `< 2,097,152` bytes;
- no `Packet too big`, disconnect, reset storm or NVENC/encoder failure;
- no completed rolling-second rate above the configured ceiling;
- complete matching evidence: fresh process/module/DLL hash, accepted encoder
  values, both Start routes, ColourLab case UUIDs and the available per-output/
  counter capture.

The 16,384-entry ledger is the stronger rolling-second proof. If it is not
implemented, report the rolling-second peak as **not measured** and do not claim
it; a known oversize, `Packet too big`, reset, disconnect or encoder failure still
fails the cell. A partial capture or missing event makes the **specific claim it
supports** inconclusive; it does not turn a known failure into a pass. An
unsupported refresh/rate/codec is recorded as unsupported/pending, not as a pass.
A cell whose accepted target never reaches the ceiling is still a valid production
cell but is labeled **ceiling not exercised**.

**Winner rule:** a candidate is a codec winner only after all 8 cells for that
codec pass. The first such candidate wins; stop testing lower-probability
candidates for that codec. AV1 and HEVC are independent winners. When both have
winners (or a codec is negative), stop the search and go to P1. Do not continue
to a lower-probability candidate just to fill a table.

**H.264 compatibility tail:** after the AV1/HEVC winners are locked, optionally
run H.264 90 Hz at 300/500/600 Mbps with H.264's own defaults plus the general
winning fields. It does not select the AV1/HEVC winner. If it fails, report it and
leave the H.264 defaults unchanged; do not claim cross-codec safety. If not run,
record it pending.

The matrix is run once per candidate that passes its screening cell, and again on
the **final productized build** with `nvenc-experimental.json` absent. The test
build's pass is not the final proof.

### 8.2 Result files and analysis

Use an arm ID containing build, codec, Hz, Mbps, workload, duration, start route,
Desktop View/dashboard state, replicate and correction/variant. Save a manifest,
settings before/after, accepted-configuration events, module hashes, exact run/case
UUID, raw counter/ledger data, workload events, SteamVR log slice and analysis.
Suggested result columns:

`arm, codec, Hz, ceiling, actual-target-range, RC, N, requested-vbv-bits,
accepted-vbv-bits, requested-kf-scale, tAQ, frameIntervalP, lookahead, qp-map,
minQP/maxQP, multipass, route, menu-state, submissions, valid-seconds,
weighted-Mbps, min/max-sample-Mbps, max-rolling-1s-Mbps, max-output-bytes,
pictures-per-buffer, obu-count, size-percentiles, drops, resets,
observe-only-reconfigures, forceIDR, latency, first-oversize-kind, verdict,
exclusions`.

Compute `Mbps = 8*delta_bytes/delta_seconds/1e6`; weighted means use total valid
bytes divided by total valid time. Reject reset/generation changes, negative
deltas, gaps and interrupted workloads. Preserve excluded time/reasons. Do not
average running averages or join baseline/warmup/recovery into the workload.
Report the requested and accepted envelope separately: the pass/fail is on
completed bytes, but the explanation needs both.

For the stronger rolling check, sort all complete output ledger events by
monotonic completion time. Evaluate the sum over `(t-1 second, t]` at each event
with a sliding queue. Report that peak separately from one-second sampled GUI
peaks. It measures NVENC production at completion, not exact wire-send timing.
Any missing events or uncertain source identity makes this check inconclusive.

A cell passes observed compliance only when its full workloads/transitions have
no oversize, no rolling-second violation, no packet-drop/reset storm and complete
matching evidence. Report measured deviation, even small deviations; do not hide
them in an undocumented tolerance. Never call this proof of every future scene.
Codec/refresh/request refusals are validation outcomes, not successful streaming.

§8.1 is the deciding set. A codec is complete only when all 8 of its cells pass;
a screening-cell pass is not a winner. The first candidate with a complete codec
gate wins that codec; do not run lower-probability candidates after that.

Classify every failure before tuning:

- `encoder-over-envelope`: a completed output exceeds the requested VBV or
  keyframe envelope. This is the encoder/rate-control case (A2–A7).
- `envelope-over-transport`: the requested envelope itself exceeds 2,097,151 B.
  This is a settings case, not an encoder defect; lower VBV or keyframe scale.
- `aggregate`: one output contains multiple coded pictures; each picture may be
  under the limit. This is the frame-interval/lookahead case (A5).
- `inconclusive`: truncated capture, missing ledger events, uncertain source or
  generation. Do not call it a pass or a codec limit.

If noise repeatedly exceeds the budget, retain the first failure and accepted
RC/map context. Correct the demonstrated cause and repeat the same matched case,
then the matrix. Do not mask it by increasing QP, reducing bitrate, disabling
split, or changing resolution without an explicit labeled experiment. If the
first-attempt fix remains unresolved, report that; a hard output guard is deferred.

## 9. How far Linear / 0% results generalize

Keep every test in this handoff Linear / 0%, as requested. For valid curves whose
applied target never exceeds the same ceiling, the nominal maximum/VBV arithmetic
and native validation limits carry over **only when the RC mode, VBV frames,
keyframe scale, temporal AQ, `frameIntervalP`, lookahead and QP map are also the
same**. If a codec winner selects CBR On, VBV 1 and keyframe scale 1, a pass does
not certify Force CBR Off, VBV 2 or keyframe scale 2: those are different requested
envelopes and a different RC mode. A pass at VBR/VBV 2/keyframe 2 does not certify
the smaller envelope either; the encoder can ignore a smaller request. The
transferable result is the arithmetic and the measurement method, not the runtime
pass.

Other curves/constancy can request higher targets at intermediate upstream
requests, spend longer near the ceiling and introduce different target transitions.
Some use request-history smoothing where Linear/0% uses the immediate request.
Thus Linear/0% runtime passes do **not** certify all future curve/constancy settings,
congestion behavior or keyframe transitions. A true future output guard would
make its byte-size admission independent of the curve; this phase does not add it.

## 10. Checks, builds and completion receipt

Test native/GUI formula parity at all eight rate/refresh points, strict boundary
rounding and overflow, override precedence, disabled mode, unsupported capability/
hash, unknown/mismatched refresh, activation/deactivation, accepted-versus-attempted
snapshots, ledger wrap/gap/duplicates/EOS and notice Close/expiry/teardown.

For any §3A.8 field or diagnostic, also test: leave/off default and no migration
rewrite; capability refusal; application at init and reconfigure; accepted-versus-
requested export; observe-only reconfigure count; per-IDR QP/size; complete-versus-
truncated first-oversize capture and OBU count; and the UI's visible "inactive
without Force CBR" state for Keyframe Size Budget. Cover the custom-VBV capability
for supported, unsupported and query-error paths. Run the affected NVENC/refresh,
monitor/parser and GUI suites. Rebuild the complete driver package with
`tools/Build-Portable.ps1`; require exit 0, `Built test package:` and
DLL/manifest/Companion EXE. If ColourLab changes, run its required local suite and
package checks as well. Source/unit/package success is separate from live proof.

The 2026-10-24 test-harness revision added native and GUI code plus focused tests;
its results are recorded in §11.1. P2 must repeat the affected checks after the
harness is removed and the winning defaults are set, and must run the full
acceptance matrix on the **final** build with `nvenc-experimental.json` absent.
A final build that still contains the experimental reader, its UI note or any
debug/verbose/graveyard state is not complete.

After authorized artifact production, follow each project's allowlisted cleanup
policy, preserving captures and saved runs/settings. Keep the latest verified
complete driver package; inspect active-process protections before deletion.
Report actual checks, package identity, bytes removed/protected skips, settings
left saved, supported/failed/pending matrix cells and remaining limitations.
No commits, pushes, releases or device/software deployment are implied.

## 11. Successor handoff: execute, decide, productize, return to normal

Read §1A, §7, §8.1 and this section before touching the driver. The agent that
finishes the live tests hands this file plus the task log to the productization
agent; §11 is the productization and return-to-normal checklist.

### 11.1 Current state (2026-10-24)

- The test-only `nvenc-experimental.json` harness is implemented and built. It is
  **not** a shipping setting and no codec default was changed.
- Focused checks passed: `NvencToggle` 626 checks/0 failures; `ToggleMigrations`
  scenarios 0–30/0 failures; GUI 452 tests/0 failures; `npm run build:ui`; full
  portable build.
- Test package: `builds/GalaxyXR-Driver/output/GalaxyXRDriver-Test-20261024-111010`
  (driver DLL, manifest and Companion EXE verified).
- Live file: `%APPDATA%/GalaxyXR/CustomHeadset/nvenc-experimental.json` with all
  sentinels. It is inert until the new package is installed and SteamVR restarts.
- No live ColourLab run has been performed. Do not treat the package build or the
  focused tests as runtime proof.

### 11.2 What was done to the driver for the tests

- `Config.h` has transient `nvencExp*` fields plus present/error status; they are
  never serialized to `settings.json`.
- `ConfigLoader::ParseConfig` reads `nvenc-experimental.json`, validates integers
  (-1/0/1, frameIntervalP 0/1, lookaheadDepth 0..31, lookahead-on needs depth),
  logs and ignores a malformed/out-of-range file, and stores the transient values.
- `FrameProcessor::UpdateEncoderSettings` maps the five values into
  `NvencTapConfig`.
- `NvencTap` applies them after the preset merge/H.264 recipe:
  `enableTemporalAQ`, `frameIntervalP`, `zeroReorderDelay`, `enableLookahead`,
  `lookaheadDepth`. `Snapshot`/`Restore` covers every write, including the new
  `frameIntervalP` snapshot. `frameIntervalP` is **init-only**; a differing
  reconfigure is logged and left unchanged.
- `WriteInfo` publishes `encoderTap.experimental` (`present`, `active`, five
  values, `error`). The Stream Frame page shows a read-only note; there is no
  editable control and no codec-default change.
- Tests: `NvencToggleTest` apply/restore/refusal/sentinel block;
  `ToggleMigrationTest` scenarios 29/30 for valid/invalid file parsing;
  `Test-ToggleMigrations.ps1` runs 0–30.
- Live file: a sentinel copy exists at the vendor AppData path; delete it at P2.
- The harness is intentionally separate from `settings.json` so the Companion
  cannot rewrite it and the user's normal tuning is untouched.

### 11.3 How to execute the tests

Follow §1A and §7 exactly:

1. Keep the run in **one conversation** from T0 to P1/P3. Do not hand off mid-run.
2. Before every settings change, open a dialogue box; apply only after **Apply**.
3. T0 baseline → A1–A7 AV1 → H1–H7 HEVC → P1 lock → P2 productize → P3 final.
4. Screening cell first; only a screening pass unlocks the codec gate (§8.1).
5. First full codec gate wins; stop lower-probability candidates. Both AV1 and
   HEVC are mandatory; H.264 is a post-winner compatibility tail.
6. Save the task log and evidence under
   `builds/GalaxyXR-Driver/build/bitrate-monitor/compliance-<timestamp>/`.
7. The user starts/reconnects streams and changes Companion/SteamVR fields; the
   agent captures evidence and never installs/deploys/restarts without permission.

### 11.4 How to decide the winners

A codec winner is the first candidate whose **8 cells** for that codec all pass
§8.1. AV1 and HEVC are independent. If a codec's T0 baseline gate passes, its
current defaults are the winner and no candidate search is needed. If no candidate
passes, that codec is negative; do not change its defaults. Stop the whole search
as soon as both codecs have winners (or a negative result).

### 11.5 P2 — remove the harness and set the codec defaults

Do this only **after** P1 has recorded the winners. Use a dialogue before the code
change. Follow the full AGENTS.md chain.

**Remove the test-only path:**

- Delete `%APPDATA%/GalaxyXR/CustomHeadset/nvenc-experimental.json` and
  `%APPDATA%/CustomHeadset/nvenc-experimental.json` if present.
- `Config.h`: remove `nvencExpTemporalAq`, `nvencExpFrameIntervalP`,
  `nvencExpZeroReorderDelay`, `nvencExpLookahead`, `nvencExpLookaheadDepth`,
  `nvencExperimentalPresent`, `nvencExperimentalError`.
- `ConfigLoader.cpp`: remove the `nvenc-experimental.json` block in `ParseConfig`
  and `encoderTap.experimental` from `WriteInfo`.
- `FrameProcessor.cpp`: remove the `tc.exp*` mappings.
- `NvencTap.h`: remove `expPresent`, `expError`, `expTemporalAq`,
  `expFrameIntervalP`, `expZeroReorderDelay`, `expLookahead`, `expLookaheadDepth`
  from `NvencTapConfig` and `NvencTapRuntimeState`.
- `NvencTap.cpp`: remove `LogExperimentalOnce`, the `expLogged` /
  `expFramePReconfLogged` atomics, the experimental apply block, the experimental
  validation, the `exp=` part of `RequestDescription`, and the experimental
  telemetry. Keep `Snapshot::frameIntervalP`, its capture and its `Restore` line
  **only if** a winning codec default uses `frameIntervalP`; otherwise remove them
  too.
- GUI: remove `experimental` from `domain/types.ts`, the Stream Frame note and the
  three `nvenc-exp-20261024-*` XLIFF units.
- Tests: remove the `CheckExperimentalOverrides` block and its capture globals
  from `NvencToggleTest.cpp`; remove scenarios 29/30 and their helper writes from
  `ToggleMigrationTest.cpp`; restore `Test-ToggleMigrations.ps1` to `0..28`.
- Delete `Docs/nvenc-experimental.example.json` and the test-only parts of
  §3A.8.1; keep the historical rationale only if it still helps.

**Set the winning defaults:**

- `GalaxyXRDriver/src/Config/Config.h` native defaults.
- `ConfigLoader.cpp` parse/default serialization (and a dated migration only if
  the meaning of an existing key changed; never rewrite explicit user tuning).
- `GalaxyXRDriverGUI/src-lit/domain/types.ts`, `driver-defaults.ts`,
  `state/galaxy-settings.ts` (`codecEncoderDefaults` and
  `applyCodecEncoderDefaults`), and `features/stream-frame-page.ts` controls,
  tips and reset arrows.
- `src/locale/messages.xlf` and `Docs/StreamFrame.md` / README settings guidance.
- Native/GUI tests for the new defaults and reset behavior.

Set the winning values **per codec** (AV1 and HEVC; H.264 only if tested). If a
codec is negative, leave its defaults unchanged. If a winning field is not
currently user-editable (temporal AQ, frameIntervalP, lookahead), either add a
normal page control or make it a visible codec-row default with a tooltip/reset
arrow; do not leave the experimental file as the only way to set it. Codec
switching and reset arrows apply the new defaults visibly; the user can still
edit. No load-time silent rewrite, no hidden file, no debug-only path.

**Remove debug/test state:**

- `nvencVerbose=false`, Debug Mode off, Graveyard off, experimental file absent,
  no test package installed as the normal driver, no stale `info.json` evidence.
- Leave the user's saved settings in a normal state: the winning values (or the
  user's original tuning if they prefer), never the last failed candidate.

**Rebuild and prove:**

- `tools/Build-Portable.ps1`; require exit 0, `Built test package:` and a complete
  driver DLL/manifest/Companion EXE.
- Install the final package only with authorization; fully exit/restart SteamVR.
- Run the full AV1+HEVC matrix again on the final build **with
  `nvenc-experimental.json` absent**; verify the loaded DLL SHA-256. The test
  build's pass is not the final proof.
- Follow `Docs/PortableBuildCleanup.md`; keep the latest verified package, remove
  obsolete test packages/fixtures, preserve evidence and the task log.

### 11.6 If no winner

Do not change codec defaults. Remove the harness as in §11.5, keep the previous
defaults, rebuild a clean package, and report the negative result with the first
failure of every candidate and the cells that remain pending. A negative result is
a valid outcome; a hard output guard or a silent fallback is not part of this plan.

### 11.7 Handoff checklist

- [ ] Task log and evidence root are complete and readable.
- [ ] Every settings change has a dialogue reference and a recorded answer; no silent edits.
- [ ] AV1 winner recorded or marked negative; HEVC winner recorded or marked negative.
- [ ] H.264 compatibility recorded or marked pending.
- [ ] Live `nvenc-experimental.json` deleted from both AppData paths.
- [ ] Test-only code, UI note, XLIFF strings, example file and tests removed.
- [ ] Winning defaults set per codec; normal controls/reset arrows added where needed.
- [ ] No debug, verbose, graveyard or experimental path left enabled.
- [ ] Final package rebuilt and DLL/manifest/EXE verified.
- [ ] Full AV1+HEVC matrix rerun on the final build with the file absent.
- [ ] Loaded DLL SHA-256 verified against the final package.
- [ ] Docs/README updated with the winning defaults and remaining limits.
- [ ] Cleanup receipt and retained package recorded.
- [ ] No commit, push, release, deployment or restart without authorization.

### 11.8 Limits

The harness is a test aid, not a shipping feature. The final package must not
depend on it. `frameIntervalP` is init-only because NVENC documents GOP-structure
changes as unsupported at reconfigure; if a winning default needs it, verify the
init value survives the connect-time reconfigure before shipping. Intra refresh,
HEVC/AV1 GOP/IDR and generic VBV initial delay are not implemented in this batch;
they require their own fields, coupling rules and client-recovery test. A pass on
the test build is not proof of every future scene.

Implementation references: current AGENTS.md and project skills; source paths in
the previous handoff; `Docs/BitrateMonitor.md`; NVIDIA's current programming guide:
https://docs.nvidia.com/video-technologies/video-codec-sdk/13.1/nvenc-video-encoder-api-prog-guide/index.html
Local field contracts: `ThirdParty/nvenc/nvEncodeAPI.h:1029-1034` (custom VBV
capability), `:1577-1578` (VBV size and initial delay), `:1609`
(`lowDelayKeyFrameScale`), `:1619-1624` (delta-QP adjustment is applied after rate
control and can violate bitrate/VBV; the explicit emphasis-map note is H.264-only).
The driver's `Describe` log already exposes the caller's `frameIntervalP`,
`zeroReorderDelay`, lookahead, tAQ and multipass (`NvencTap.cpp:789-792`), but it
does not expose the accepted VBV, keyframe scale or per-picture count; treat those
as missing evidence until the accepted-configuration and per-output ledger export
in §3A.8/§4.B exists.

The 2026-10-24 frame-size analysis is the basis for §3A. Its central correction is
that the driver already requests 1.33-1.59 MiB of VBV at 500-600 Mbps/90 Hz, so the
first question is not "make the VBV smaller than 2 MiB" but "why did a 3.8 MiB
keyframe exceed the 1.3-1.6 MiB request, and was the keyframe ratio even applied?"
The older observation of a clean roughly 236 Mbps run under a 500 Mbps ceiling
remains a startup-state clue, not a successful full-ceiling stress test.
