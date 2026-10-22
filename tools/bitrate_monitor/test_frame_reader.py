"""Synthetic PE/process-memory tests; no live process or device is accessed."""
import struct
import unittest

from . import frame_reader as reader


BASE = 0x7FFF00000000
IMAGE_SIZE = 0x500000
PROBE_RVA = 0x10000
PID = 1234
NOW = 1_000_000


class Image:
    def __init__(self):
        self.memory = bytearray(IMAGE_SIZE)
        self.reads = []
        self.callback = None
        self.memory[:2] = b"MZ"
        struct.pack_into("<I", self.memory, 0x3C, 0x80)
        self.memory[0x80:0x84] = b"PE\0\0"
        struct.pack_into("<HH", self.memory, 0x84, 0x8664, 2)
        struct.pack_into("<H", self.memory, 0x94, 240)
        optional = 0x98
        struct.pack_into("<H", self.memory, optional, 0x20B)
        struct.pack_into("<I", self.memory, optional + 56, IMAGE_SIZE)
        struct.pack_into("<I", self.memory, optional + 108, 16)
        struct.pack_into("<II", self.memory, optional + 112, 0x2000, 0x200)
        for index, (name, rva, size, flags) in enumerate(((b".rdata", 0x1000, 0x8000, 0x40000040),
                                                       (b".data", PROBE_RVA, reader.PROBE_SIZE, 0xC0000040))):
            at = optional + 240 + index * 40
            self.memory[at:at + len(name)] = name
            struct.pack_into("<II", self.memory, at + 8, size, rva)
            struct.pack_into("<I", self.memory, at + 36, flags)
        struct.pack_into("<5I", self.memory, 0x2000 + 20, 1, 1, 0x2100, 0x2110, 0x2120)
        struct.pack_into("<I", self.memory, 0x2100, PROBE_RVA)
        struct.pack_into("<I", self.memory, 0x2110, 0x2130)
        struct.pack_into("<H", self.memory, 0x2120, 0)
        name = reader.EXPORT_NAME.encode() + b"\0"
        self.memory[0x2130:0x2130 + len(name)] = name
        self.header()

    @property
    def headers(self):
        return bytes(self.memory[:4096])

    def header(self, *, generation=7, sequence=22, pid=PID, tick=NOW - 10,
               frames=(1 << 33) + 5, total_bytes=(1 << 50) + 9):
        struct.pack_into("<Q6I5Q", self.memory, PROBE_RVA, reader.MAGIC, 1,
                         reader.HEADER_SIZE, reader.CAPACITY, reader.SLOT_SIZE,
                         pid, 1, sequence, frames, total_bytes, tick, generation)

    def frame(self, data=b"fresh actual encoded bytes", *, slot="latest", generation=7,
              sequence=8, tick=NOW - 100, flags=1, full=None, capture=41):
        offset = PROBE_RVA + reader.HEADER_SIZE + (reader.SLOT_SIZE if slot == "keyframe" else 0)
        copied = len(data)
        if full is None:
            full = copied
        struct.pack_into("<4Q4I2Q", self.memory, offset, sequence, tick, generation,
                         0x100000001, full, copied, flags, 0, capture, 0)
        self.memory[offset + 64:offset + 64 + copied] = data

    def read(self, handle, address, size):
        rva = address - BASE
        if not 0 <= rva <= IMAGE_SIZE or not 0 <= size <= IMAGE_SIZE - rva:
            raise AssertionError("Reader attempted an out-of-image read")
        self.reads.append((rva, size))
        if self.callback:
            override = self.callback(rva, size)
            if override is not None:
                return override
        return bytes(self.memory[rva:rva + size])


class ExportTests(unittest.TestCase):
    def test_finds_named_writable_data_export(self):
        image = Image()
        self.assertEqual(reader.find_probe(image, None, BASE, IMAGE_SIZE, image.headers), PROBE_RVA)

    def test_absent_exports_are_not_invented(self):
        image = Image()
        struct.pack_into("<II", image.memory, 0x98 + 112, 0, 0)
        self.assertIsNone(reader.find_probe(image, None, BASE, IMAGE_SIZE, image.headers))
        self.assertFalse(image.reads)

    def test_unrelated_named_export_returns_none(self):
        image = Image()
        image.memory[0x2130:0x2138] = b"Other\0\0\0"
        self.assertIsNone(reader.find_probe(image, None, BASE, IMAGE_SIZE, image.headers))

    def test_long_unrelated_export_does_not_trigger_unbounded_string_reads(self):
        image = Image()
        image.memory[0x2130:0x2130 + 1001] = b"?" * 1000 + b"\0"
        self.assertIsNone(reader.find_probe(image, None, BASE, IMAGE_SIZE, image.headers))
        self.assertLessEqual(max(size for _, size in image.reads), 40)

    def test_export_aliases_may_share_one_function_ordinal(self):
        image = Image()
        struct.pack_into("<I", image.memory, 0x2000 + 24, 2)
        struct.pack_into("<2I", image.memory, 0x2110, 0x2180, 0x2130)
        struct.pack_into("<2H", image.memory, 0x2120, 0, 0)
        image.memory[0x2180:0x2186] = b"Alias\0"
        self.assertEqual(reader.find_probe(image, None, BASE, IMAGE_SIZE, image.headers), PROBE_RVA)

    def test_forwarder_invalid_ordinal_and_out_of_image_are_rejected(self):
        for target, ordinal in ((0x2050, 0), (PROBE_RVA, 1), (IMAGE_SIZE - 1, 0)):
            with self.subTest(target=target, ordinal=ordinal):
                image = Image()
                struct.pack_into("<I", image.memory, 0x2100, target)
                struct.pack_into("<H", image.memory, 0x2120, ordinal)
                with self.assertRaises(reader.ProbeUnavailable):
                    reader.find_probe(image, None, BASE, IMAGE_SIZE, image.headers)

    def test_nonwritable_or_too_small_section_cannot_hold_probe(self):
        for flags, size in ((0x40000040, reader.PROBE_SIZE), (0xC0000040, 1000)):
            image = Image()
            section = 0x98 + 240 + 40
            struct.pack_into("<I", image.memory, section + 36, flags)
            struct.pack_into("<I", image.memory, section + 8, size)
            with self.assertRaises(reader.ProbeUnavailable):
                reader.find_probe(image, None, BASE, IMAGE_SIZE, image.headers)

    def test_malformed_pe_or_export_bounds_fail_before_large_reads(self):
        image = Image()
        struct.pack_into("<I", image.memory, 0x2000 + 24, 1000000)
        with self.assertRaises(reader.ProbeUnavailable):
            reader.find_probe(image, None, BASE, IMAGE_SIZE, image.headers)
        self.assertLessEqual(max(size for _, size in image.reads), 40)
        image = Image()
        struct.pack_into("<H", image.memory, 0x84, 0x14C)
        with self.assertRaises(reader.ProbeUnavailable):
            reader.find_probe(image, None, BASE, IMAGE_SIZE, image.headers)


class CounterTests(unittest.TestCase):
    def test_reads_exact_64_bit_counters(self):
        image = Image()
        row = reader.read_probe_counters(image, None, BASE, IMAGE_SIZE, PROBE_RVA, PID, NOW)
        self.assertEqual(row["frames"], (1 << 33) + 5)
        self.assertEqual(row["total_bytes"], (1 << 50) + 9)
        self.assertEqual(row["generation"], 7)

    def test_wrong_process_stale_or_unsupported_abi_are_unavailable(self):
        for kwargs in ({"pid": 9}, {"tick": NOW - 6001}, {"sequence": 1}):
            image = Image()
            image.header(**kwargs)
            with self.assertRaises(reader.ProbeUnavailable):
                reader.read_probe_counters(image, None, BASE, IMAGE_SIZE, PROBE_RVA, PID, NOW)
        image = Image()
        struct.pack_into("<I", image.memory, PROBE_RVA + 8, 2)
        with self.assertRaises(reader.ProbeUnavailable):
            reader.read_probe_counters(image, None, BASE, IMAGE_SIZE, PROBE_RVA, PID, NOW)

    def test_retry_stops_after_racing_counter_reads(self):
        image = Image()
        calls = 0
        def race(rva, size):
            nonlocal calls
            if rva == PROBE_RVA:
                calls += 1
                image.header(sequence=2 * calls)
        image.callback = race
        with self.assertRaises(reader.ProbeUnavailable):
            reader.read_probe_counters(image, None, BASE, IMAGE_SIZE, PROBE_RVA, PID, NOW)
        self.assertEqual(calls, 6)


class FrameTests(unittest.TestCase):
    def test_owned_latest_and_retained_keyframe_keep_generation_and_identity(self):
        image = Image()
        image.frame(b"current frame")
        image.frame(b"header frame", slot="keyframe", flags=5, tick=NOW - 60000, capture=3)
        row = reader.read_probe_frame(image, None, BASE, IMAGE_SIZE, PROBE_RVA, PID, NOW)
        self.assertEqual(row["data"], b"current frame")
        self.assertEqual(row["frame_index"], 0x100000001)
        self.assertTrue(row["complete"])
        with self.assertRaises(reader.FrameUnavailable):
            reader.read_probe_frame(image, None, BASE, IMAGE_SIZE, PROBE_RVA, PID, NOW, slot="keyframe")
        context = reader.read_probe_frame(image, None, BASE, IMAGE_SIZE, PROBE_RVA, PID, NOW,
                                         slot="keyframe", max_age_ms=None)
        self.assertEqual(context["data"], b"header frame")
        self.assertLess(context["tick_ms"], NOW - 6000)

    def test_no_frame_stale_frame_and_unknown_flags_are_rejected(self):
        for kwargs in ({"flags": 0}, {"tick": NOW - 6001}, {"flags": 9}, {"generation": 6}):
            image = Image()
            image.frame(**kwargs)
            with self.assertRaises(reader.FrameUnavailable):
                reader.read_probe_frame(image, None, BASE, IMAGE_SIZE, PROBE_RVA, PID, NOW)

    def test_truncation_is_explicit_and_payload_is_bounded(self):
        image = Image()
        image.frame(b"x" * reader.CAPACITY, flags=3, full=reader.CAPACITY + 1)
        row = reader.read_probe_frame(image, None, BASE, IMAGE_SIZE, PROBE_RVA, PID, NOW)
        self.assertFalse(row["complete"])
        self.assertEqual(len(row["data"]), reader.CAPACITY)
        image.frame(b"short", flags=3, full=reader.CAPACITY + 1)
        with self.assertRaises(reader.FrameUnavailable):
            reader.read_probe_frame(image, None, BASE, IMAGE_SIZE, PROBE_RVA, PID, NOW)

    def test_racing_payload_and_stream_change_are_not_accepted(self):
        for mode in ("slot", "generation"):
            image = Image()
            image.frame()
            payload = PROBE_RVA + reader.HEADER_SIZE + 64
            mutations = 0
            def race(rva, size):
                nonlocal mutations
                if rva == payload:
                    mutations += 1
                    if mode == "slot":
                        image.frame(sequence=8 + 2 * mutations)
                    else:
                        image.header(generation=7 + mutations)
            image.callback = race
            with self.assertRaises(reader.FrameUnavailable):
                reader.read_probe_frame(image, None, BASE, IMAGE_SIZE, PROBE_RVA, PID, NOW)

    def test_only_keyframe_context_can_disable_freshness(self):
        image = Image()
        with self.assertRaises(ValueError):
            reader.read_probe_frame(image, None, BASE, IMAGE_SIZE, PROBE_RVA, PID, NOW, max_age_ms=None)
        with self.assertRaises(ValueError):
            reader.read_probe_frame(image, None, BASE, IMAGE_SIZE, PROBE_RVA, PID, NOW, slot="arbitrary")


if __name__ == "__main__":
    unittest.main()
