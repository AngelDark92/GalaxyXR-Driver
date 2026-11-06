# Galaxy XR Steam Link isolation — 2026-11-06

## Contract

Galaxy XR features target only Steam Link's current connection reporting the
original client model `xrvst2ue`. Installing or enabling this driver must not
apply Galaxy XR identity, frame, input or encoder policy to another streamer,
another Steam Link headset, or an unrelated NVENC session.

Saved configuration is user intent, not proof of an eligible connection.
Our profile serial, cosmetic model/manufacturer overrides, GPU, dimensions and
process ID cannot authorize a session. Unknown provenance fails closed.
Neutral and upstream headset behavior remain separate compatibility contracts.

## Version-safe interception

Never implement hooks using fixed DLL addresses, RVAs, instruction offsets or
build-specific byte-patch locations. Resolve named imports and versioned
interfaces at runtime, validate module ownership, and refuse unsupported layouts.
The matching rule is permanent project guidance in `AGENTS.md`.

The approved design uses VRLink-local named imports for NVENC discovery and
observation of its original handshake log. Shared settings getter interception
is separately approved because VRLink caches its settings interface during
startup. A getter override requires both the exact VRLink caller module and an
eligible Galaxy XR connection; other callers retain original results. This is
not a process-wide NVENC export hook. No vendor binary file is patched.

## Current shipped-binary evidence

Read-only Ghidra analysis used the installed `driver_vrlink.dll`, SHA-256
`f3d287efe205f8e42ed79e90957a19729adab0cdf7233e07bfa86f66a03fc0b7`.
Addresses below identify this dated analysis only. They are not implementation
constants or a promise about a later SteamVR build.

- `FUN_1809f0170` copies the model from received static properties, constructs
  `vrlink_` plus that original model for an unknown headset, reads `enable` and
  `serialNumber`, and logs the original received model and serial. Profile
  serial substitution changes the stored serial, not those original log
  arguments. Evidence:
  `ev_3769a29b768e24cce1b798450cee4d96925315d39452e03addd3d5016b2cad5e`.
- `FUN_1809f4ba0` obtains static properties from a message and passes them to
  that function. Evidence:
  `ev_9a8cfa7670d609e20d89b908c4e1f4e5eb300df4a727682ec7d20749c3923e0f`.
- `FUN_180a31010` formats logs through the imported
  `__stdio_common_vsnprintf_s` before its output sinks. Formatting is not
  conditional on its later file-output flag. Evidence:
  `ev_a715811cfe05ff5b57f0f62bebe98956eda73267d57688802135d1d5037cc876`.
- `FUN_180a0a770` detects a changed session identifier and emits
  `New Session detected; Invalidating.` through the same logger before
  invalidating its HMD state. Evidence:
  `ev_a2616d89031c0a66d6ff8c80d1a6a0eace6bbe1fcf3763216373b230f793b76d`.
- `FUN_180a23740` reads `automaticBandwidth` and `targetBandwidth` from
  **`driver_vrlink`**, not the per-model section. Moving persisted values alone
  would not preserve those controls. Evidence:
  `ev_3e0e9bc4ddb6e8374a68b14e19f5ae95c8b3d4bbf6927f89e1cadfe1e9bfa829`.
- `FUN_180a08790` fills the cached `IVRSettings_003` pointer while reading
  startup network settings, before completing `SVLDriver::Init`. A proxy
  returned only on later interface requests cannot cover already-cached
  pointers. Evidence:
  `ev_ebcab98a6a7940a4614dc4120714a769be969202f37656333db4395548be1335`.
- `FUN_180a29180` dynamically resolves `NvEncodeAPICreateInstance` by name,
  requests an 11.1 function list and opens an 11.1 encoder session. This proves
  the call path, not process-lifetime caching or reconnect behavior. Evidence:
  `ev_7013232bf2b1a9a6c90ad7ac68d52ca7db38b76849cf66b9edca20715e345d0d`.

Disassembly address order alone does not establish execution order. Absence of
a fully qualified `section.key` string does not establish an absent setting:
OpenVR passes section and key separately. An indirect settings call alone does
not establish its section or session scope.

## Lifecycle and settings rules

Observe the original handshake before any of our identity stamps. Bind its
connection epoch only to an HMD with verified VRLink caller and driver-object
ownership; confirm successful activation and parent-driver ownership. Disconnect,
deactivation, a new session or contradictory identity revokes eligibility.
Reconnect requires fresh evidence, not a sticky telemetry flag or frame cadence.

NVENC authority is fixed when a session opens. Earlier passthrough sessions
cannot be adopted later. Closing an epoch stops new policy and post-processing;
existing upgraded sessions still need ABI translation, resource release and safe
drain until destruction. They do not magically become pristine. Recycled handles
must receive fresh authority.

Persist profile preparation and supported tuning only in `vrlink_xrvst2ue`.
Never seed or tune `driver_vrlink`. Retire historical global overrides through
the ownership journal only when current values match our recorded last write;
preserve later foreign edits, lifecycle keys, original absence and malformed
evidence. A scoped settings read overlay replaces persistence for global-only
readers. Unsupported controls must be reported honestly, not left as editable
no-ops.

## Evidence limits and validation

This document records source requirements and static binary findings, not a
successful live isolation test. Fixture tests must cover foreign/unknown models,
early cached function lists, per-session authority, disconnect/resource drain,
reconnect and handle reuse, unchanged foreign settings results, profile-only
writes, and journal-safe retirement/rollback.

The complete portable package gate and documented cleanup remain mandatory.
Live verification additionally requires separately authorized deployment and
SteamVR restart, with matching process/module/build evidence for Galaxy XR
Steam Link, another Steam Link headset, Virtual Desktop and Chronolink, including
connection swaps. No such runtime authorization is implied by source edits.

## Source and verification record

Implementation owners:

- `GalaxyXRDriver/src/Driver/GalaxyLinkEpoch.h`: original-model evidence,
  published epochs (zero when closed), target lineage and fresh-evidence rebind.
- `GalaxyXRDriver/src/Hooking/ModuleImportHook.h` and
  `src/Driver/NvencTap.cpp`: named import interception, cached-table forwarding,
  per-open authority and ABI/resource drain.
- `GalaxyXRDriver/src/Driver/Hooking/VrlinkSettingsHook.h`: filtered shared
  getters, including provisional activation-time reads; no settings writes.
- `GalaxyXRDriver/src/Config/VrlinkSettingsRouting.h`, headset/provider/frame/input
  code and `GalaxyXRDriverGUI/src-tauri/src/driver_installation.rs`: scoped
  effects, profile-only persistence and ownership-safe retirement/rollback.

Local checks completed on 2026-11-06:

- All 16 selected native runners exited 0. New isolation fixtures total 456
  checks: epoch 138, settings getters 57, imports 52, NVENC authority/resource
  lifetime 167, and real-header epoch/NVENC integration 42. Existing neutral
  NVENC regression suite passed 3,528 checks; post-pack ordering passed 47.
- `npm test`: 35 files, 676 tests passed.
- `cargo test --locked --lib`, Galaxy XR vendor: 212 passed.
- `node --test tools/tests/*.test.cjs`: 275 passed, one instruction-size failure,
  31 environment skips. After shortening guidance without dropping constraints,
  all eight affected instruction tests passed on recheck. Other suite results
  remain valid; the combined final result is 276 passed, 31 skipped.
- Source preflight and `git diff --check` passed. Nine changed production
  translation units passed `cl /Zs` without a vendor define (neutral syntax).
- `Test-VrlinkCapabilities.ps1` was unavailable because its Zig compiler was
  missing. No hosted CI run was performed; new native runners are local tests,
  not automatically part of the existing CI workflow.

The full command
`powershell -NoProfile -ExecutionPolicy Bypass -File tools/Build-Portable.ps1`
exited 0 and printed `Built test package:`. The retained checkout-relative
package is
`../builds/GalaxyXR-Driver/output/GalaxyXRDriver-Test-20261106-201259/`.
Its driver DLL, manifest and Companion EXE were checked as present and nonempty.
Driver DLL SHA-256:
`754DE183E3C0497B131A2B14939923E24D1791E0C207BAB709EA2AACE6679BE6`.

Documented cleanup was previewed and applied with
`-KeepPackage output/GalaxyXRDriver-Test-20261106-201259`. The receipt
`../builds/GalaxyXR-Driver/build/workspace-cleanup-last.json` records complete
status, 41,352,415 logical bytes removed and 160 unchanged retained-package
hashes. Three unrecognized pre-existing seed-test logs were preserved. Own
additional scratch/native test outputs removed: 56,057,187 bytes; the scoped
Cargo clean additionally reported 3,789 files / 3.0 GiB removed. Toolchains,
dependencies, source/user edits, settings and diagnostic evidence were kept.
Local check logs remain under
`../builds/GalaxyXR-Driver/build/isolation-validation/`.

At the end of source/package validation, this package was not installed or deployed. No SteamVR restart, live settings
cleanup, device action, commit, push or release was performed. Actual Steam Link,
Virtual Desktop and Chronolink behavior, real D3D resource release, and
cross-streamer connection swaps still need separately authorized runtime tests.

## Subsequent authorized live validation

On 2026-11-06 the user installed the verified package and performed the requested
headset steps. Loaded-module hashes and fresh matching telemetry confirmed the
same driver DLL in Steam Link and Chronolink processes.

- Steam Link admitted original model `xrvst2ue`. Requested/effective AV1 matched
  at 1536x6144 with API 12.1, multi-engine encoding, frame delivery and post-pack
  processing. An inspected heartbeat recorded 15,746 encoded/locked frames and
  zero NVENC encode failures. User reported normal operation after an initial
  transient problem; its suspected Wi-Fi cause was not independently established.
- Chronolink's fresh process loaded the Galaxy XR driver but did not load
  `driver_vrlink.dll`. Its HMD was registered unchanged, `hookInstalled` was false,
  and no Galaxy target admission, NVENC policy, scoped settings-read or frame-pass
  activity appeared. A passive memory read confirmed the first 32 bytes of the
  dynamically resolved NVENC export entry matched the DLL on disk.
- Saved Galaxy settings, ownership journal and driver registration were
  byte-identical before/after Chronolink. Global/profile VRLink sections stayed
  unchanged; SteamVR changed only window, GPU-cache and active-HMD bookkeeping.

Evidence and read-only reproduction scripts are retained outside the checkout
under `../builds/GalaxyXR-Driver/build/live-isolation-20261106/`.
Chronolink used ASTC, not sustained NVENC encoding. Other codecs, Virtual Desktop,
other headset models, same-process streamer swaps and real resource-lifetime
stress remain separate live coverage. No quantitative old/new performance or
image-pixel comparison was performed.
