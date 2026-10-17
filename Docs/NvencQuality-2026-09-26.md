# NVENC quality review — 2026-09-26

The online guidance supports the existing low-latency quality approach. **No NVENC defaults were changed.** It does not establish a stronger universal default for Steam Link's packed VR stream: encode time, transport limits, GPU capacity and headset decoding all matter. This is a source/code review, not a headset quality or latency measurement.

## What the sources support

NVIDIA recommends low/ultra-low-latency tuning with CBR for interactive streaming, a small VBV, and evaluating multipass encoding. It cautions that temporal AQ can vary frame sizes, which matters for strict CBR. Split-frame encoding speeds up an individual session at some quality cost. HEVC unidirectional B-frames use past references without frame-reordering delay and can improve compression. These are tradeoffs to measure, not evidence that every quality feature should be enabled together. [NVIDIA NVENC programming guide](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.0/nvenc-video-encoder-api-prog-guide/index.html)

Sunshine defaults to quarter-resolution two-pass encoding; full-resolution analysis costs more encoder time. Its documentation also describes higher presets as a compression-versus-latency tradeoff and leaves spatial AQ disabled by default. These provide a useful streaming comparison, but Sunshine's defaults do not validate Steam Link's packed-frame workload. [Sunshine NVENC configuration](https://docs.lizardbyte.dev/projects/sunshine/latest/md_docs_2configuration.html#nvenc_twopass)

## Existing defaults retained

The C++ and GUI defaults agree in `GalaxyXRDriver/src/Config/Config.h` and `GalaxyXRDriverGUI/src-lit/domain/driver-defaults.ts`.

| Setting | Default | Effective behavior |
| --- | --- | --- |
| NVENC Tap / Fix Level | On / On | Enable overrides; HEVC level auto, tier High |
| Preset / True Preset Merge | 0 / On | Auto: P7 with 3+ engines, P5 with 2, P4 with 1; unknown count leaves the streamer's preset |
| Force CBR / Key Frame Budget | On / 2 | CBR with low-delay keyframe scale 2 |
| VBV Frames / Force Frame Rate | 2 / 90 | Buffer budget uses two frames at the configured encoder rate |
| Bandwidth Override / Separate Encoder Bitrate | 0 / 0 | Follow selected stream bandwidth; no separate forced budget |
| Bitrate Follows Streamer Backoff / Clamp Reference | On / 350 Mbit/s | Preserve proportional congestion backoff |
| Peak Headroom | 0% | No extra requested peak allowance |
| Split-Frame Encoding | 1 | Force splitting with driver-selected strip count where accepted |
| Fovea / Periphery QP Delta | 0 / 0 | No custom QP map |
| Spatial AQ Strength | 0 | No explicit strength override; preset merge can still enable AQ |
| Min QP / Intra Min QP / Max QP | 0 / 0 / 0 | No explicit QP bounds |
| VUI Range / Matrix / Primaries / Transfer | -1 / -1 / -1 / -1 | Leave metadata; effective image policy can override these |
| Verbose Log | Off | No verbose encoder logging |

`NvencTap.cpp` already merges the selected preset's multipass, temporal/spatial AQ and HEVC reference settings using the streamer's tuning. It deliberately does not adopt preset lookahead. Post-pack sharpening and range conversion are separate image-processing controls, gated by Image Enhancements.

Two caveats remain: **90 FPS budgeting does not automatically follow a 75-Hz headset setting**, and **AQ strength 0 does not mean spatial AQ is strictly disabled**. The latter differs from the retired-control warning about previously observed spatial-AQ stalls. Neither behavior was changed by this review.

## Candidates for measured follow-up

- **HEVC unidirectional B-frames:** the strongest new candidate from this review for improving compression without reorder delay. The tap has no control for it. Implementation needs NVENC API/capability checks, compatible reference-picture configuration, and Steam Link/headset decoder validation. A material gain on this stream is unproven.
- **Explicit multipass comparison control:** absent as a user setting. Multipass itself is already implemented through preset merge. A selectable quarter/full-resolution comparison could identify quality gains that still meet the frame deadline; it should first record the effective preset value.

Retain Auto rather than forcing P7 on all GPUs. Any follow-up should compare matched scenes at the same bitrate, resolution and refresh rate, checking visible artifacts, encode latency, dropped frames and decoder behavior before changing defaults.

## Dark motion trails: user report and next isolation test

On 2026-09-26 the user reported faint, uncoloured trails behind objects on dark backgrounds with NVENC Tap enabled. They confirmed that the trails disappear with Tap disabled after a SteamVR restart, but ordinary scenes then show more compression artifacts. Both P2 and P7 were tested with the trails still present. The preset choice alone therefore does not account for the reported difference; the precise cause remains unproven.

The local SteamVR logs available during this review ended on September 25 and cannot identify the effective configuration of those P2/P7 trials. The sparse settings file currently on disk is also not a record of both trials. No live settings were changed for this investigation.

The next comparison is **P2, Tap ON, True Preset Merge ON versus OFF**, restarting SteamVR for each arm and holding the scene, bitrate, resolution, refresh rate and every other setting constant. The existing control is labelled **NVENC (retired): True Preset Merge**. Disabling it stops importing canonical multipass, AQ and reference settings (`NvencTap.cpp`, `ApplyOverrides`), while preserving the tap's independent bitrate scaling. It does not explicitly disable any AQ already requested by Steam Link.

Record whether the dark trails change and whether the normal-scene quality benefit remains. Preserve each arm's settings and fresh `vrserver.txt` / `driver_vrlink.txt` before starting the other arm. A successful comparison identifies the preset-merge group, not the individual member responsible. If it makes no difference, restore the saved merge choice and investigate the remaining rate-control and split/session changes one at a time; do not repeat P1/P2/P7 as a standalone fix.

Force CBR OFF is not a full rate-control bypass: the tap can still set maximum bitrate, VBV size and frame-rate budgeting. Likewise, Tap OFF gates post-pack processing as well as encoder overrides. Those distinctions must remain visible in any later A/B result. HEVC unidirectional B-frames remain a separate quality experiment, not an established remedy for these trails.
