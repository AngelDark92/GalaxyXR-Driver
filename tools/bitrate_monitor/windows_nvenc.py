"""Read exact completed NVENC bytes from an explicitly audited driver build.

This module never injects code or writes process memory.  The counter is
NvencTapStats.sumFrameBytes, incremented from NV_ENC_LOCK_BITSTREAM's actual
bitstreamSizeInBytes.  New driver binaries require an audited profile; a nearby
version or encoder target is deliberately not used as a substitute.
"""

from __future__ import annotations

import ctypes
from ctypes import wintypes
from dataclasses import dataclass
import hashlib
import json
import ntpath
import os
from pathlib import Path
import struct
import time

from .codec import FrameClassifier
from .frame_reader import (find_probe, read_probe_counters, read_probe_frame,
                           ProbeUnavailable, FrameUnavailable)


class NvencUnavailable(RuntimeError):
    """A current, validated byte counter is not available."""


@dataclass(frozen=True)
class StatsProfile:
    stats_rva: int
    section_rva: int
    section_size: int
    section_name: str = ".data"


# Audited live on 2026-10-21: one writable-section candidate matched the
# complete size-bucket/counter prefix and fresh heartbeat, then advanced with
# actual encoded output.  This is a full SHA-256 admission guard, not a version
# string guard.  No neutral/other build is presumed to share this layout.
SUPPORTED_PROFILES = {
    "056ccf2c890b179078b01c7aff65f9f937876626f0f48857607221fc5cf38759":
        StatsProfile(0x177D00, 0x177000, 68484),
}
PREFIX_SIZE = 112
MAX_INFO_AGE = 6.0


@dataclass(frozen=True)
class CounterSnapshot:
    frames: int
    total_bytes: int
    encode_calls: int


def decode_counter_prefix(data: bytes) -> CounterSnapshot:
    """Validate the audited x64 struct prefix, including torn-read invariants."""
    if len(data) != PREFIX_SIZE:
        raise NvencUnavailable("Incomplete NVENC counter read")
    words = struct.unpack_from("<25I", data)
    total_bytes = struct.unpack_from("<Q", data, 104)[0]
    frames, maximum, maximum_idr, last, idrs = words[11:16]
    if not (1 <= words[0] <= 1_000_000 and words[9] > 0):
        raise NvencUnavailable("NVENC counter header does not match its audited layout")
    if not (0 < frames <= words[10] and 0 < maximum <= 128 * 1024 * 1024):
        raise NvencUnavailable("NVENC has no validated completed encoded frames")
    if sum(words[16:23]) != frames:
        raise NvencUnavailable("NVENC counter snapshot changed during sampling")
    if not (maximum_idr <= maximum and last <= maximum and idrs <= frames):
        raise NvencUnavailable("NVENC frame-size counters are inconsistent")
    if not (maximum <= total_bytes <= frames * maximum):
        raise NvencUnavailable("NVENC byte counter is inconsistent")
    if not (words[23] <= words[24] <= 255):
        raise NvencUnavailable("NVENC QP counters are inconsistent")
    return CounterSnapshot(frames, total_bytes, words[10])


def validate_image_profile(headers: bytes, image_size: int,
                           profile: StatsProfile) -> None:
    """Ensure the pinned counter lies inside the expected writable PE section."""
    try:
        if len(headers) < 64 or headers[:2] != b"MZ":
            raise ValueError("DOS header")
        pe = struct.unpack_from("<I", headers, 0x3C)[0]
        if headers[pe:pe + 4] != b"PE\0\0":
            raise ValueError("PE signature")
        machine, sections = struct.unpack_from("<HH", headers, pe + 4)
        optional_size = struct.unpack_from("<H", headers, pe + 20)[0]
        optional = pe + 24
        magic = struct.unpack_from("<H", headers, optional)[0]
        size_of_image = struct.unpack_from("<I", headers, optional + 56)[0]
        if machine != 0x8664 or magic != 0x20B or not 0 < sections <= 96:
            raise ValueError("x64 image")
        if image_size != size_of_image:
            raise ValueError("image size")
        for i in range(sections):
            offset = optional + optional_size + i * 40
            name = headers[offset:offset + 8].split(b"\0", 1)[0].decode("ascii")
            virtual_size, rva = struct.unpack_from("<II", headers, offset + 8)
            flags = struct.unpack_from("<I", headers, offset + 36)[0]
            if name != profile.section_name:
                continue
            if (rva != profile.section_rva or virtual_size != profile.section_size
                    or flags & 0xC0000000 != 0xC0000000
                    or not rva <= profile.stats_rva
                    or profile.stats_rva + PREFIX_SIZE > rva + virtual_size
                    or rva + virtual_size > image_size):
                raise ValueError("counter section")
            return
        raise ValueError("missing counter section")
    except (ValueError, struct.error, UnicodeDecodeError, OverflowError) as exc:
        raise NvencUnavailable("Loaded driver PE layout does not match the audited counter profile") from exc


def _normalized_path(path: str) -> str:
    return ntpath.normcase(ntpath.normpath(path))


def _read_info(path: Path, now: float) -> dict:
    try:
        if not -2.0 <= now - path.stat().st_mtime <= MAX_INFO_AGE:
            raise NvencUnavailable("Driver telemetry is stale; start a current stream")
        data = json.loads(path.read_text(encoding="utf-8-sig"))
        tap = data["encoderTap"]
        runtime = data["runtime"]
        pid = int(tap["pid"])
        if (pid <= 0 or pid != int(runtime["processId"])
                or not runtime.get("initialized") or runtime.get("lockedOut")):
            raise NvencUnavailable("Driver telemetry does not identify an active SteamVR process")
        if not -2.0 <= now - float(tap["observedAt"]) / 1000.0 <= MAX_INFO_AGE:
            raise NvencUnavailable("Encoder telemetry is stale; start a current stream")
        if not tap.get("enabled") or not tap.get("hookInstalled"):
            raise NvencUnavailable("The installed NVENC output counter is not active")
        if (int(tap.get("encodeWidth", 0)) <= 0 or int(tap.get("encodeHeight", 0)) <= 0
                or int(tap.get("effectiveCodec", -1)) < 0):
            raise NvencUnavailable("NVENC has not accepted a live stream yet")
        if not isinstance(tap.get("modulePath"), str) or not tap["modulePath"]:
            raise NvencUnavailable("Driver module path is missing from current telemetry")
        return data
    except NvencUnavailable:
        raise
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise NvencUnavailable("Current driver telemetry is missing or incomplete") from exc


class _WindowsApi:
    """Small read-only Win32 boundary, kept separate for fixture verification."""

    def __init__(self):
        if os.name != "nt" or ctypes.sizeof(ctypes.c_void_p) != 8:
            raise NvencUnavailable("NVENC memory sampling requires 64-bit Windows Python")
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self.psapi = ctypes.WinDLL("psapi", use_last_error=True)
        self.kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        self.kernel.OpenProcess.restype = wintypes.HANDLE
        self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        self.kernel.CloseHandle.restype = wintypes.BOOL
        self.kernel.ReadProcessMemory.argtypes = [wintypes.HANDLE, ctypes.c_void_p,
            ctypes.c_void_p, ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
        self.kernel.ReadProcessMemory.restype = wintypes.BOOL
        self.kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
        self.kernel.GetProcessTimes.restype = wintypes.BOOL
        self.kernel.GetTickCount64.argtypes = []
        self.kernel.GetTickCount64.restype = ctypes.c_uint64
        self.psapi.EnumProcessModulesEx.argtypes = [wintypes.HANDLE, ctypes.POINTER(ctypes.c_void_p),
            wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), wintypes.DWORD]
        self.psapi.EnumProcessModulesEx.restype = wintypes.BOOL
        self.psapi.GetModuleFileNameExW.argtypes = [wintypes.HANDLE, ctypes.c_void_p,
            wintypes.LPWSTR, wintypes.DWORD]
        self.psapi.GetModuleFileNameExW.restype = wintypes.DWORD
        self.psapi.GetModuleInformation.argtypes = [wintypes.HANDLE, ctypes.c_void_p,
            ctypes.c_void_p, wintypes.DWORD]
        self.psapi.GetModuleInformation.restype = wintypes.BOOL

    def open(self, pid: int):
        # PROCESS_QUERY_INFORMATION | PROCESS_VM_READ. Never VM_WRITE/VM_OPERATION.
        handle = self.kernel.OpenProcess(0x410, False, pid)
        if not handle:
            raise NvencUnavailable("Cannot read the current SteamVR process (closed or access denied)")
        return handle

    def close(self, handle):
        self.kernel.CloseHandle(handle)

    def ticks(self):
        return self.kernel.GetTickCount64()

    def creation_time(self, handle) -> int:
        creation, exited, kernel, user = (wintypes.FILETIME() for _ in range(4))
        if not self.kernel.GetProcessTimes(handle, ctypes.byref(creation), ctypes.byref(exited),
                                          ctypes.byref(kernel), ctypes.byref(user)):
            raise NvencUnavailable("Cannot validate the SteamVR process start time")
        return (creation.dwHighDateTime << 32) | creation.dwLowDateTime

    def module(self, handle, expected_path: str) -> tuple[int, int, str]:
        class ModuleInfo(ctypes.Structure):
            _fields_ = [("base", ctypes.c_void_p), ("size", wintypes.DWORD),
                        ("entry", ctypes.c_void_p)]
        modules = (ctypes.c_void_p * 1024)()
        needed = wintypes.DWORD()
        if not self.psapi.EnumProcessModulesEx(handle, modules, ctypes.sizeof(modules),
                                              ctypes.byref(needed), 0x03):
            raise NvencUnavailable("Cannot enumerate the current SteamVR modules")
        if needed.value > ctypes.sizeof(modules):
            raise NvencUnavailable("SteamVR module inventory exceeded the supported bound")
        expected = _normalized_path(expected_path)
        for module in modules[:needed.value // ctypes.sizeof(ctypes.c_void_p)]:
            buffer = ctypes.create_unicode_buffer(32768)
            length = self.psapi.GetModuleFileNameExW(handle, module, buffer, len(buffer))
            if not length or length >= len(buffer) or _normalized_path(buffer.value) != expected:
                continue
            info = ModuleInfo()
            if not self.psapi.GetModuleInformation(handle, module, ctypes.byref(info), ctypes.sizeof(info)):
                raise NvencUnavailable("Cannot validate the loaded driver image")
            return int(info.base), int(info.size), buffer.value
        raise NvencUnavailable("Telemetry driver DLL does not match a module in current SteamVR")

    def read(self, handle, address: int, size: int) -> bytes:
        data = ctypes.create_string_buffer(size)
        count = ctypes.c_size_t()
        if not self.kernel.ReadProcessMemory(handle, address, data, size, ctypes.byref(count)):
            raise NvencUnavailable("NVENC counter is no longer readable (stream/process closed)")
        if count.value != size:
            raise NvencUnavailable("Incomplete NVENC process-memory read")
        return data.raw


class NvencSampler:
    """Sample cumulative completed encoded bytes without changing the stream.

    The monitoring GUI calculates rates from successive total_bytes/time pairs.
    A new source_id means its rate baseline must be reset.
    """

    def __init__(self, info_paths: list[str] | None = None, *, profiles=None,
                 api_factory=None, clock=None, wall_clock=None, codec_interval=5.0):
        appdata = Path(os.environ.get("APPDATA", ""))
        self.info_paths = [Path(p) for p in info_paths] if info_paths is not None else [
            appdata / "GalaxyXR" / "CustomHeadset" / "info.json",
            appdata / "CustomHeadset" / "info.json",
        ]
        self.profiles = SUPPORTED_PROFILES if profiles is None else profiles
        self.api_factory = api_factory or _WindowsApi
        self.clock = clock or time.monotonic
        self.wall_clock = wall_clock or time.time
        self._api = None
        self._handle = None
        self._key = None
        self._last = None
        if not 1 <= float(codec_interval) <= 3600:
            raise ValueError("Codec inspection interval must be between 1 and 3600 seconds")
        self.codec_interval = float(codec_interval)
        self._codec_next = 0.0
        self._codec_source = None
        self._classifier = FrameClassifier()
        self._codec_result = None

    def close(self):
        self._release_handle()
        self._key = self._last = None
        self._codec_source = self._codec_result = None
        self._codec_next = 0.0
        self._classifier = FrameClassifier()

    def _inspect_frame(self, base, image_size, rva, pid, identity, generation):
        now = self.clock()
        if identity != self._codec_source:
            self._classifier = FrameClassifier()
            self._codec_result = None
            self._codec_next = 0.0
            self._codec_source = identity
        if now >= self._codec_next:
            self._codec_next = now + self.codec_interval
            try:
                tick = self._api.ticks()
                frame = read_probe_frame(self._api, self._handle, base, image_size,
                                         rva, pid, tick)
                if frame["generation"] != generation:
                    raise FrameUnavailable("Encoder session changed during frame capture")
                header_frame = None
                try:
                    retained = read_probe_frame(self._api, self._handle, base, image_size,
                        rva, pid, tick, slot="keyframe", max_age_ms=None)
                    if retained["generation"] == generation and retained["complete"]:
                        header_frame = retained["data"]
                except FrameUnavailable:
                    pass
                answer = self._classifier.classify_frame(frame["data"], generation=identity,
                    complete=frame["complete"], header_frame=header_frame)
                self._codec_result = dict(answer, frame_index=frame["frame_index"],
                    capture_id=frame["capture_id"], generation=frame["generation"],
                    frame_bytes=frame["full_size"], captured_bytes=frame["captured_size"],
                    frame_sha256=hashlib.sha256(frame["data"]).hexdigest(),
                    sampled_at=self.wall_clock(), sampled_monotonic=now,
                    frame_age_at_analysis_seconds=max(0, tick - frame["tick_ms"]) / 1000,
                    captured_tick_ms=frame["tick_ms"], source="NVENC owned frame snapshot")
            except ProbeUnavailable as error:
                self._codec_result = dict(codec=None, label="Unverified", evidence=str(error),
                    sampled_at=self.wall_clock(), sampled_monotonic=now)
        answer = dict(self._codec_result or dict(codec=None, label="Unverified", evidence="Waiting for a captured frame"))
        answer["age_seconds"] = max(0.0, now - answer.get("sampled_monotonic", now)) + answer.get("frame_age_at_analysis_seconds", 0)
        return answer

    def _release_handle(self):
        if self._handle is not None:
            self._api.close(self._handle)
        self._handle = None

    def _metadata(self) -> tuple[dict, Path]:
        errors = []
        for path in self.info_paths:
            try:
                return _read_info(path, self.wall_clock()), path
            except NvencUnavailable as exc:
                errors.append(str(exc))
        raise NvencUnavailable(errors[0] if errors else "No driver telemetry paths were provided")

    def _stable_snapshot(self, address: int) -> tuple[CounterSnapshot, float]:
        for _ in range(8):
            before = self.clock()
            first = self._api.read(self._handle, address, PREFIX_SIZE)
            second = self._api.read(self._handle, address, PREFIX_SIZE)
            after = self.clock()
            if first == second:
                try:
                    return decode_counter_prefix(first), (before + after) / 2.0
                except NvencUnavailable:
                    # A stable read can still catch the very short update region.
                    continue
        raise NvencUnavailable("NVENC counter changed during sampling; waiting for a consistent read")

    def sample(self) -> dict:
        try:
            data, metadata_path = self._metadata()
            tap = data["encoderTap"]
            pid, path = int(tap["pid"]), tap["modulePath"]
            if self._api is None:
                self._api = self.api_factory()
            # Open/close per sample prevents retaining an exited PID across a
            # replacement process. Creation time is also part of source identity.
            self._release_handle()
            self._handle = self._api.open(pid)
            started = self._api.creation_time(self._handle)
            base, image_size, loaded_path = self._api.module(self._handle, path)
            file_path = Path(loaded_path)
            before = file_path.stat()
            key = (pid, started, _normalized_path(loaded_path), base,
                   before.st_size, before.st_mtime_ns)
            # Hash each sample: the binary is small, and fail-closed admission is
            # more useful than caching a path whose file can be replaced.
            digest = hashlib.sha256(file_path.read_bytes()).hexdigest()
            after = file_path.stat()
            if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                raise NvencUnavailable("Driver DLL changed while validating its exact build")
            headers = self._api.read(self._handle, base, 4096)
            try:
                probe_rva = find_probe(self._api, self._handle, base, image_size, headers)
            except ProbeUnavailable as error:
                raise NvencUnavailable(str(error)) from error
            if probe_rva is not None:
                before_counter = self.clock()
                try:
                    counter = read_probe_counters(self._api, self._handle, base, image_size,
                        probe_rva, pid, self._api.ticks())
                except ProbeUnavailable as error:
                    raise NvencUnavailable(str(error)) from error
                measured_at = (before_counter + self.clock()) / 2
                snapshot = CounterSnapshot(counter["frames"], counter["total_bytes"], counter["frames"])
                source_id = f"nvenc:{pid}:{started}:{digest}:{base:x}:probe1:{counter['generation']}"
                codec_result = self._inspect_frame(base, image_size, probe_rva, pid,
                                                   source_id, counter["generation"])
            else:
                profile = self.profiles.get(digest)
                if profile is None:
                    raise NvencUnavailable("Unsupported driver build for exact NVENC bytes (SHA-256 "
                                           + digest[:16] + "). An audited counter profile is required.")
                validate_image_profile(headers, image_size, profile)
                snapshot, measured_at = self._stable_snapshot(base + profile.stats_rva)
                source_id = f"nvenc:{pid}:{started}:{digest}:{base:x}:{profile.stats_rva:x}"
                codec_result = dict(codec=None, label="Unverified",
                    evidence="Installed driver has no frame snapshot export; updated driver and SteamVR restart required")
            previous = self._last
            # _last is stored outside the handle lifecycle; normal sample close
            # does not discard the cross-sample monotonic-counter check.
            if previous and previous[0] == source_id:
                if snapshot.total_bytes < previous[1] or snapshot.frames < previous[2]:
                    raise NvencUnavailable("NVENC cumulative counters moved backwards; baseline reset required")
            self._last = (source_id, snapshot.total_bytes, snapshot.frames)
            self._key = key
            result = {"source_id": source_id, "monotonic_time": measured_at,
                      "total_bytes": snapshot.total_bytes, "frames": snapshot.frames,
                      "label": "NVENC encoded video (actual completed bytes)",
                      "status": f"Exact counter · PID {pid} · SHA-256 {digest[:12]}",
                      "pid": pid, "module_path": loaded_path, "module_sha256": digest,
                      "codec_detection": codec_result}
            # Never return a valid counter after its freshness check has expired
            # due to a very slow filesystem/process operation.
            final_data = _read_info(metadata_path, self.wall_clock())
            if (int(final_data["encoderTap"]["pid"]) != pid
                    or _normalized_path(final_data["encoderTap"]["modulePath"]) !=
                    _normalized_path(loaded_path)):
                raise NvencUnavailable("Driver process changed during sampling; waiting for a new baseline")
            return result
        except NvencUnavailable:
            self.close()
            raise
        except (OSError, ValueError, KeyError, TypeError, StopIteration) as exc:
            self.close()
            raise NvencUnavailable("NVENC output sampling is unavailable: " + str(exc)) from exc
        finally:
            if self._handle is not None:
                self._api.close(self._handle)
                self._handle = None
