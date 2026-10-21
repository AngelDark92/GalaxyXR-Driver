# Quest Pro settings routing investigation — 2026-09-23

The connected client reported `Oculus Quest Pro`, exactly matching the section
name previously added. The failure was routing, not a misspelled identity.

## Captured runtime evidence

SteamVR loaded GalaxyXRNative 1.2.6 and applied settings before the HMD connected.
At 21:46:32 the driver logged all three profile destinations and requested tile
width 1536 and bandwidth 450 Mbit/s. At 21:46:36 VRLink reported model
`Oculus Quest Pro`, selected its built-in Quest Pro profile, reported render
target 2048×2048 and selected encode target width 1024.

The captured `steamvr.vrsettings` contained matching requests in
`vrlink_xrvst2ue`, `vrlink_Oculus Quest Pro`, and `vrlink_PICO 4 Pro`:
render 3552×3840, stream width 1536, automatic bandwidth false, target 450.
`driver_vrlink` contained only `micVolumeHasBeenInitialized`. Therefore this
was not missing profile writes or writes occurring after connection.
Local snapshots are in `build/quest-pro-routing-20260923/` (not shipped).

## Exact installed VRLink binary

- File: SteamVR `drivers/vrlink/bin/win64/driver_vrlink.dll`.
- Size: 13,908,632 bytes.
- SHA-256: `1e846be041039798580a91452371f6288c614fb4c152126b137e2c693fb77eef`.
- Method: read-only PE section mapping and Capstone x86-64 disassembly;
  preferred image base `0x180000000`.
- The following are file offsets, not reusable patch addresses. The DLL was
  inspected read-only; no binary patch is part of this change.

| File offsets | Observed behavior |
| --- | --- |
| `0x9e4d4e–0x9e4d64` | `Oculus Quest Pro` classifies as model 3 |
| `0x9e4ef8–0x9e4f0e` | `PICO 4 Pro` classifies as model 8 |
| `0x9eaf4a–0x9eaf57` | Models other than unknown (1) skip per-model section construction and its `enable` lookup |
| `0x9eb0e7–0x9eb103` | Unknown-model path reads the profile `enable` flag |
| `0x9ebb30–0x9ebde3` | Quest Pro selects built-in capabilities and skips unknown-profile loading |
| `0x9ebde8–0x9ec0cd` | Model bitmask includes PICO 4 Pro; built-in path also skips unknown-profile loading |
| `0x9ec228–0x9ec298` | Unknown-profile loader checks the enable flag before recommended render dimensions |
| `0x9df786–0x9df7f3` | `renderWidth` and `renderHeight` read from `driver_vrlink`; absent/nonpositive values fall back to 2048×2048 |
| `0x9e7e24–0x9e7e8d` | `automaticStreamFormatWidth` and `streamFormatWidth` read from `driver_vrlink` |
| `0xa184af–0xa184c0` | `targetBandwidth` read from `driver_vrlink` |

Adding `enable=true` to a recognized Quest/PICO section does not override this
binary's known-model branch. Neither renamed sections nor that flag fixes the
observed tuning failure.

## Correction and limits

Tuning now always includes `driver_vrlink`. Profile On retains all three copies
requested by the user; Profile Off restores only owned copies. Capability
requests remain in the existing per-model destinations and are not mislabeled
as global tuning. All writes/restores retain the recovery journal, including
Setup cleanup. Saved GUI choices and defaults are unchanged; no settings-data
migration is needed for this routing correction.

The previous unit tests checked the assumed destination list and could pass
while VRLink ignored it. The regression now explicitly requires the global
tuning destination in both switch states, including Quest/PICO cases, and
ensures capability requests are not accidentally copied there.

The corrected package must still be installed and tested after a restart and
reconnect. Static binary analysis and a successful build do not establish the
post-fix live render size, bandwidth mode, or capability negotiation. No live
settings, driver installation, or SteamVR process was changed during this audit.

## 2026-10-21 update — single identity

The Steam Link client now always reports model `xrvst2ue`: the patched APK writes that
model number into every runtime-selected `hmd_config.json` entry (it is the headset's
`Build.PRODUCT`, which stock 2.0.23 also reports on its product-name lookup miss). VRLink
therefore builds exactly one section, `vrlink_xrvst2ue`, and the Quest Pro / PICO 4 Pro
alias mirrors in `VrlinkCapabilitySections` and the Companion seed lists were removed.
`vrlink_xrvst2ue` remains the only additional destination, for both capability requests
and tuning copies; `COMPANION_PROFILE_SECTIONS` still lists the retired aliases so setup
cleanup can delete leftovers. The captured routing facts above (Quest Pro → model 3,
PICO 4 Pro → model 8) describe the pre-change builds and are kept as history.
