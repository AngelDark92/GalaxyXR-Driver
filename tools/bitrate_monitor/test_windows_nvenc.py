"""Focused tests for fail-closed exact-byte admission and process lifecycles."""

import hashlib
import json
import os
from pathlib import Path
import struct
import tempfile
import time
import unittest
from unittest.mock import patch

from tools.bitrate_monitor import windows_nvenc as nvenc


def counter(frames=10, total_bytes=None, *, encode_calls=None):
    words = [0] * 25
    words[0] = words[1] = 1
    words[4] = words[5] = frames
    words[9] = 2
    words[10] = frames if encode_calls is None else encode_calls
    words[11] = frames
    words[12] = words[13] = words[14] = 1000
    words[15] = 1
    words[16] = frames
    words[23] = words[24] = 20
    return struct.pack("<25I4xQ", *words, frames * 1000 if total_bytes is None else total_bytes)


def image(profile):
    data = bytearray(4096)
    data[:2] = b"MZ"
    struct.pack_into("<I", data, 0x3C, 0x80)
    data[0x80:0x84] = b"PE\0\0"
    struct.pack_into("<HH", data, 0x84, 0x8664, 1)
    struct.pack_into("<H", data, 0x94, 240)
    struct.pack_into("<H", data, 0x98, 0x20B)
    struct.pack_into("<I", data, 0x98 + 56, 0x2000)
    section = 0x98 + 240
    data[section:section + 8] = b".data\0\0\0"
    struct.pack_into("<II", data, section + 8, profile.section_size, profile.section_rva)
    struct.pack_into("<I", data, section + 36, 0xC0000040)
    return bytes(data)


class FakeApi:
    def __init__(self, module_path, profile):
        self.path = str(module_path)
        self.profile = profile
        self.started = 1234567
        self.opened = []
        self.closed = []
        self.prefix = counter()
        self.read_queue = []
        self.bad_module = False

    def open(self, pid):
        self.opened.append(pid)
        return len(self.opened)

    def close(self, handle):
        self.closed.append(handle)

    def creation_time(self, handle):
        return self.started

    def module(self, handle, path):
        if self.bad_module:
            raise nvenc.NvencUnavailable("module mismatch")
        return 0x100000, 0x2000, self.path

    def read(self, handle, address, size):
        if address == 0x100000:
            return image(self.profile)
        if address != 0x100000 + self.profile.stats_rva or size != 112:
            raise AssertionError("Unexpected memory request")
        return self.read_queue.pop(0) if self.read_queue else self.prefix


class CounterTests(unittest.TestCase):
    def test_uses_actual_uint64_bytes_and_completed_frames(self):
        value = nvenc.decode_counter_prefix(counter(5_000_000))
        self.assertEqual(value.total_bytes, 5_000_000_000)
        self.assertEqual(value.frames, 5_000_000)

    def test_torn_frame_bucket_counter_is_rejected(self):
        raw = bytearray(counter())
        struct.pack_into("<I", raw, 44, 11)
        struct.pack_into("<I", raw, 40, 11)
        with self.assertRaisesRegex(nvenc.NvencUnavailable, "changed"):
            nvenc.decode_counter_prefix(bytes(raw))

    def test_impossible_byte_count_is_rejected(self):
        with self.assertRaisesRegex(nvenc.NvencUnavailable, "byte counter"):
            nvenc.decode_counter_prefix(counter(10, 10001))

    def test_partial_read_and_uninitialized_counter_are_unavailable(self):
        for value in [counter()[:-1], bytes(112)]:
            with self.subTest(value=len(value)):
                with self.assertRaises(nvenc.NvencUnavailable):
                    nvenc.decode_counter_prefix(value)

    def test_pe_requires_audited_writable_section_and_x64_layout(self):
        profile = nvenc.StatsProfile(0x1080, 0x1000, 0x200)
        good = image(profile)
        nvenc.validate_image_profile(good, 0x2000, profile)
        for offset, value in [(0x84, 0x014C), (0x98, 0x10B),
                              (0x98 + 240 + 36, 0x40000040)]:
            raw = bytearray(good)
            struct.pack_into("<I" if offset > 0x98 else "<H", raw, offset, value)
            with self.subTest(offset=offset):
                with self.assertRaises(nvenc.NvencUnavailable):
                    nvenc.validate_image_profile(bytes(raw), 0x2000, profile)
        with self.assertRaises(nvenc.NvencUnavailable):
            nvenc.validate_image_profile(good, 0x3000, profile)
        with self.assertRaises(nvenc.NvencUnavailable):
            nvenc.validate_image_profile(good, 0x2000,
                nvenc.StatsProfile(0x11F0, 0x1000, 0x200))


class SamplerTests(unittest.TestCase):
    def setUp(self):
        repository = Path(__file__).resolve().parents[2]
        root = repository.parent / "builds" / repository.name / "build" / "bitrate-monitor" / "tests"
        root.mkdir(parents=True, exist_ok=True)
        self.scratch = tempfile.TemporaryDirectory(prefix="nvenc-", dir=root)
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        self.module_path = self.root / "driver_GalaxyXRNative.dll"
        self.module_path.write_bytes(b"explicitly audited fixture binary")
        self.digest = hashlib.sha256(self.module_path.read_bytes()).hexdigest()
        self.profile = nvenc.StatsProfile(0x1080, 0x1000, 0x200)
        self.api = FakeApi(self.module_path, self.profile)
        self.info_path = self.root / "info.json"
        self.now = time.time()
        self.data = {"runtime": {"initialized": True, "lockedOut": False, "processId": 42},
                     "encoderTap": {"pid": 42, "modulePath": str(self.module_path),
                        "enabled": True, "hookInstalled": True, "observedAt": self.now * 1000,
                        "encodeWidth": 1536, "encodeHeight": 6144, "effectiveCodec": 0}}
        self.write_info()
        self.sampler = self.make_sampler()
        self.addCleanup(self.sampler.close)

    def write_info(self):
        self.info_path.write_text(json.dumps(self.data), encoding="utf-8")
        os.utime(self.info_path, (self.now, self.now))

    def make_sampler(self, **kwargs):
        values = dict(profiles={self.digest: self.profile}, api_factory=lambda: self.api,
                      wall_clock=lambda: self.now)
        values.update(kwargs)
        return nvenc.NvencSampler([str(self.info_path)], **values)

    def test_real_bytes_not_target_and_no_process_handle_leak(self):
        a = self.sampler.sample()
        self.api.prefix = counter(20)
        b = self.sampler.sample()
        self.assertEqual(a["total_bytes"], 10000)
        self.assertEqual(b["total_bytes"] - a["total_bytes"], 10000)
        self.assertEqual(b["frames"] - a["frames"], 10)
        self.assertEqual(a["source_id"], b["source_id"])
        self.assertEqual(len(self.api.opened), len(self.api.closed))
        self.assertIsNone(self.sampler._handle)

    def test_unchanged_counter_is_valid_zero_delta(self):
        a, b = self.sampler.sample(), self.sampler.sample()
        self.assertEqual(b["total_bytes"] - a["total_bytes"], 0)

    def test_pid_reuse_creation_time_changes_baseline_identity(self):
        a = self.sampler.sample()
        self.api.started += 1
        self.api.prefix = counter(3)
        b = self.sampler.sample()
        self.assertNotEqual(a["source_id"], b["source_id"])

    def test_decreasing_counters_are_unavailable_and_do_not_leak_handle(self):
        self.sampler.sample()
        self.api.prefix = counter(3)
        with self.assertRaisesRegex(nvenc.NvencUnavailable, "backwards"):
            self.sampler.sample()
        self.assertEqual(len(self.api.opened), len(self.api.closed))

    def test_unknown_sha_never_reads_a_counter_or_uses_encoder_target(self):
        self.module_path.write_bytes(b"neighbor build")
        with self.assertRaisesRegex(nvenc.NvencUnavailable, "Unsupported driver build"):
            self.sampler.sample()
        self.assertEqual(len(self.api.opened), len(self.api.closed))

    def test_stale_disabled_uninitialized_or_pid_mismatch_info_is_unavailable(self):
        cases = [("observedAt", (self.now - 7) * 1000), ("enabled", False),
                 ("hookInstalled", False), ("encodeWidth", 0),
                 ("effectiveCodec", -1), ("pid", 99)]
        for key, value in cases:
            old = self.data["encoderTap"][key]
            self.data["encoderTap"][key] = value
            self.write_info()
            with self.subTest(key=key):
                with self.assertRaises(nvenc.NvencUnavailable):
                    self.sampler.sample()
            self.data["encoderTap"][key] = old
        self.assertEqual(self.api.opened, [])

    def test_actual_loaded_module_must_match_telemetry(self):
        self.api.bad_module = True
        with self.assertRaisesRegex(nvenc.NvencUnavailable, "module mismatch"):
            self.sampler.sample()
        self.assertEqual(len(self.api.opened), len(self.api.closed))

    def test_snapshot_retries_torn_reads_then_returns_consistent_bytes(self):
        self.api.read_queue = [counter(10), counter(11), counter(11), counter(11)]
        self.assertEqual(self.sampler.sample()["total_bytes"], 11000)

    def test_two_sources_can_fall_back_to_fresh_neutral_metadata(self):
        missing = self.root / "missing.json"
        self.sampler.info_paths.insert(0, missing)
        self.assertEqual(self.sampler.sample()["frames"], 10)

    def test_export_frames_override_codec_hint_and_obey_inspection_interval(self):
        from .test_codec import HEVC
        self.data["encoderTap"]["effectiveCodec"] = 2  # AV1 hint is not frame evidence.
        self.write_info()
        self.api.ticks = lambda: 10000
        clock = [100.0]
        sampler = self.make_sampler(profiles={}, clock=lambda: clock[0], codec_interval=5)
        self.addCleanup(sampler.close)
        frame = dict(data=HEVC, generation=7, complete=True, frame_index=22,
                     capture_id=3, full_size=len(HEVC), captured_size=len(HEVC), tick_ms=9900)
        with patch.object(nvenc, "find_probe", return_value=0x1000), \
             patch.object(nvenc, "read_probe_counters", return_value=dict(frames=30, total_bytes=9000, generation=7)), \
             patch.object(nvenc, "read_probe_frame", return_value=frame) as read_frame:
            first = sampler.sample()
            self.assertEqual(first["codec_detection"]["codec"], "HEVC")
            self.assertEqual(read_frame.call_count, 2)
            clock[0] += 2
            second = sampler.sample()
            self.assertEqual(read_frame.call_count, 2)
            self.assertGreater(second["codec_detection"]["age_seconds"], 2)
            clock[0] += 4
            sampler.sample()
            self.assertEqual(read_frame.call_count, 4)

    def test_frame_probe_failure_does_not_replace_valid_bitrate_counters(self):
        self.api.ticks = lambda: 10000
        sampler = self.make_sampler(profiles={})
        self.addCleanup(sampler.close)
        with patch.object(nvenc, "find_probe", return_value=0x1000), \
             patch.object(nvenc, "read_probe_counters", return_value=dict(frames=30, total_bytes=9000, generation=7)), \
             patch.object(nvenc, "read_probe_frame", side_effect=nvenc.FrameUnavailable("no retained frame")):
            result = sampler.sample()
            self.assertEqual(result["total_bytes"], 9000)
            self.assertIsNone(result["codec_detection"]["codec"])


if __name__ == "__main__":
    unittest.main()
