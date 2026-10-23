# Live bitrate monitor

## Companion window

Open **Debug → Monitoring → Open monitor window** while Debug Mode is on. The
window uses the same read-only NVENC and USB ADB measurements as the standalone
tool, but the Companion owns its lifecycle: no sampler thread, process-memory
read, ADB command or timer runs before the window opens, and every sampler stops
when the window closes or hides. The window follows the Companion's color scheme
and locale, starts in its own WebView2 profile, and keeps Pause, Reset, the last
300-sample graph and CSV export local to that window.

The integrated window stores its ADB path, optional serial and frame interval in
`%LOCALAPPDATA%\com.sboys3.custom-headset\bitrate-monitor.json`. It never writes
`settings.json` or changes a stream setting. Its codec row uses the same
conservative structural rule as the standalone parser (parameter-set evidence
from the current or retained same-generation frame); ambiguous, truncated or
stale samples remain unverified. The standalone Python/Tk utility below remains
available for source-tree work.

Double-click [`tools/Start-BitrateMonitor.cmd`](../tools/Start-BitrateMonitor.cmd).
This standalone Windows utility uses **64-bit Python 3.10+ with Tk** and the
standard library only. There is no pip install, browser engine, server or driver
deployment. It leaves streaming settings and processes alone.

The GUI automatically finds ADB on PATH or under `ANDROID_HOME` /
`ANDROID_SDK_ROOT`. Use **Browse…** to select `adb.exe`, then **Apply ADB**.
USB debugging must be authorized on the Galaxy XR. Only one USB debugging device
can be attached; other phones must be disconnected. The optional serial field
requires that specific USB headset; it does not select wireless ADB.

## What is measured

**NVENC output:** exact cumulative completed bytes from successful NVENC
`bitstreamSizeInBytes` results. The tool opens SteamVR with read/query rights only,
without injection, hooks, writes or restart. Each sample checks fresh driver
telemetry, process creation identity, actual loaded DLL path and full DLL SHA-256.
Drivers with the versioned `GalaxyXR_NVENC_Probe_v1` data export additionally
validate its ABI, writable-image bounds, publication sequence, PID and freshness.
This stable export carries exact byte/frame counters and owned frame snapshots;
it supports new Galaxy XR and neutral builds without private-structure offsets.
It never uses the configured bitrate or declared frame rate for a measurement.

For older drivers without that export, the legacy profile admits only the binary
verified on 2026-10-21:
`056ccf2c890b179078b01c7aff65f9f937876626f0f48857607221fc5cf38759`.
Its counter starts at RVA `0x177d00`; the cumulative byte field is at prefix
offset 104 and completed frame count at 44. The profile is tied to the exact
binary, not the display version. A different build without a supported export or
an audited profile displays **Unsupported driver build**. Never copy this RVA to
a neighboring build. If SteamVR is elevated, run the monitor
with matching permissions only if its read access is otherwise denied.

**Headset:** ADB communication is strictly USB (`adb -d`), with a Galaxy XR model
and boot identity check. If an already-installed, already-active
`GXRDecoderProbe` publishes fresh accepted decoder-input video-byte counters,
those are used and clearly labeled. The monitor does not enable or install it.
Otherwise it reads the active WLAN interface's received bytes from
`/proc/net/dev`, clearly labeled **all traffic**. That includes audio, FEC,
retransmissions and unrelated traffic; it is not decoded-video-only bitrate.
USB is the measurement connection, not a claim that video travels over USB.
Absent/unauthorized/ambiguous USB devices show unavailable, and wireless ADB is
never substituted. No root, APK installation, settings writes, log clearing,
`adb connect`, `tcpip`, server shutdown or driver deployment is performed.

NVENC output and WLAN RX measure different stages; their difference is not a
packet-loss estimate. Neither establishes displayed-frame delivery. If decoder
telemetry is unavailable, the GUI says so rather than claiming its network
counter is a decoder measurement.

## Codec inspection from encoded output buffers

**Frame interval (s)** controls how often the monitor analyzes a fresh NVENC
frame. The default is **5 seconds**; enter 1–3600 and select **Apply interval**.
The interval affects this tool only and does not change streaming settings.

The driver copies one actual completed NVENC output buffer at most once per second
while its NVENC output buffer is still locked. A second slot retains a keyframe
for codec parameter sets. Each slot owns up to 2 MiB of data; oversized frames
are marked truncated and cannot verify a codec. Publication sequences, capture
IDs, timestamps and stream generations prevent stale or racing reads. No NVENC
pointer is retained after unlocking, no keyframes are forced, and no picture
decoding or additional encoder session is required.

NVENC output-buffer length is not necessarily one coded-picture length: AV1
with picture-type decision enabled can pack a show picture and preceding
no-show pictures into one buffer. The counter's rate is successful output
buffer locks per second, displayed as **buffers/s**, not headset display FPS.
The legacy CSV field `fps` retains that buffer-rate meaning for NVENC; it is
accepted decoder-input frames/s only for the decoder-input source. Zero-length
or repeated successful locks are not independently identified as unique pictures.
The full-size field comes from NVENC, while a snapshot SHA-256 hashes only the
copied bytes. A truncated copy cannot prove the full buffer's picture count,
codec or integrity.

The parser distinguishes **H.264 / AVC**, **HEVC / H.265** and **AV1** using
encoded NAL/OBU syntax and parameter-set references. An ordinary frame may omit
its parameter sets: in that case, the parser can use validated headers from the
same generation's retained keyframe while analyzing the fresh coded frame. It
retains only those parameters, not an old coded picture. Encoder/session changes
and frame-index regressions invalidate the native generation and header context.
Ambiguous, unsupported, incomplete, stale or malformed evidence remains
**unverified**; configured codec values and decoder MIME names are not substitutes.

The GUI displays the detected codec, frame age and SHA-256 prefix. CSV exports
also include the full SHA-256, captured frame size/index, capture ID, generation,
timestamp and parsing evidence. This verifies encoded structure, not complete
entropy decoding, image correctness or headset presentation.

An older installed driver without the snapshot export can continue to provide
bitrate through its audited profile, while frame codec detection explicitly
requires an updated driver and SteamVR restart. The tool never installs or
restarts the driver automatically. Headset network counters contain no frame
payload: the headset codec row remains unverified when frame bytes are unavailable.

## Current, average, minimum and maximum

Independent workers sample approximately every second. Each completed interval
uses its actual monotonic elapsed time:

`Mbps = 8 × (bytes_now − bytes_before) / elapsed_seconds / 1,000,000`

Current is the latest completed window. Average is total measured bytes divided
by total measured time since the baseline, not an unweighted average of rates.
Min/max describe these windows, not instantaneous packet or frame peaks. Rates
use decimal Mbps. First samples establish a baseline and show a dash; they do
not count the stream's bytes produced before the monitor started. Disconnections,
counter regressions, source/PID/boot changes and long sampling gaps reset that
source's baseline and statistics. A successfully read unchanged counter is a
real zero-output interval; an unavailable counter is not converted to zero.

**Reset statistics** changes only the monitor's calculations. **Pause** pauses
display/statistics accumulation; read-only source polling continues. **Export
CSV…** saves the last 14,400 completed source windows, including cumulative bytes,
monotonic sample times, source identity, measurement kind and derived statistics.
The graph retains 300 samples per source. Preferences and default exports live
under `../builds/GalaxyXR-Driver/build/bitrate-monitor/`, outside the checkout.

## Console and verification

From the repository root:

```powershell
python -B -m tools.bitrate_monitor
python -B -m tools.bitrate_monitor --adb 'F:\Runtimes\AndroidSdk\platform-tools\adb.exe'
python -B -m tools.bitrate_monitor --codec-interval 5
python -B -m tools.bitrate_monitor --probe 15 --output '../builds/GalaxyXR-Driver/build/bitrate-monitor/capture.json'
python -B -m unittest discover -s tools/bitrate_monitor -t . -p 'test_*.py' -v
powershell -NoProfile -ExecutionPolicy Bypass -File tools/Test-NvencFrameProbe.ps1
```

`-B` prevents Python bytecode caches in the source tree. The console probe exits
2 if either source never yields a completed measurement window. This does not
prevent using the GUI's NVENC panel when no USB headset is attached. Test fixtures
cover counter math, exact binary/layout admission, stale/torn samples, process
replacement, USB-only selection and disconnected/unsupported devices.
Native frame-probe checks verify ABI layout, sampling bounds, generation changes,
truncation and memory canaries; parser fixtures cover all three codec families.

The integrated Companion window is compiled by `npm run build:ui`; its rate math
is covered by `src-lit/domain/rate-tracker.test.ts` and its native probe/ADB
parsers by `cargo test --locked --lib` in `GalaxyXRDriverGUI/src-tauri`. The
production page is checked by `node tools/Test-BitrateMonitorBrowser.cjs`
(Playwright via `NODE_PATH`, as configured by `build-tools.yml`).

The staged, not-yet-executed headset investigation is documented in
[the NVENC bitrate validation plan](NvencBitrateValidationPlan.md). Corrected
VBV ownership and QP-map lifetimes do not themselves prove that oversized
output or VRLink resets are resolved.
