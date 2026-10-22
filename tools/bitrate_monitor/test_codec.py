"""Independent encoded-AU fixtures and malformed/framing ambiguity checks.

HEVC: first complete picture in FFmpeg FATE's
https://fate-suite.ffmpeg.org/hevc-conformance/AMVP_A_MTK_4.bit .
AVC/AV1: complete NVENC AUs captured in the existing 2026-10-16/18 driver
investigations, retained from SteamVRColourLab/tests/test_codec_verify.py.
These fixture bytes establish parser behavior, never current runtime proof.
"""
import base64
import random
import unittest
from unittest.mock import patch
import zlib

from . import codec

H264 = zlib.decompress(base64.b64decode(
    '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'
))

HEVC = zlib.decompress(base64.b64decode(
    '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'
))

AV1 = zlib.decompress(base64.b64decode(
    'eNoBVwCo/xIACgwAAACOsv/f/AIZyEAyRRABCEEBBBBAQABACAEgGCATzUks7dZzQc0cBxiS5R1wdzSEichNVpgC'
    'FdjbfHq0eWDligX4Xgt5jtV6sBPPlmRiavqOWKuAILA='
))

class CodecTests(unittest.TestCase):
    def test_independent_complete_access_units(self):
        for name, data, dimensions in (("H.264", H264, "1024x4096"),
                                       ("HEVC", HEVC, "416x240"),
                                       ("AV1", AV1, "1536x6144")):
            with self.subTest(codec=name):
                result = codec.classify_frame(data)
                self.assertEqual(result["codec"], name)
                self.assertIn(dimensions, result["evidence"])
                self.assertIn("structural byte evidence", result["evidence"])

    def test_every_three_and_four_byte_annex_b_start_is_supported(self):
        for data, expected in ((H264, "H.264"), (HEVC, "HEVC")):
            result = codec.classify_frame(data.replace(b"\0\0\0\1", b"\0\0\1"))
            self.assertEqual(result["codec"], expected)

    def test_producer_truncated_flag_rejects_even_valid_prefix(self):
        for data in (H264, HEVC, AV1):
            result = codec.classify_frame(data, complete=False)
            self.assertIsNone(result["codec"])
            self.assertIn("truncated", result["evidence"])

    def test_annex_b_missing_parameter_sets_and_unrecognized_bytes(self):
        # Slices from real frames are not accepted as parameter-bearing proof.
        for data in (H264, HEVC):
            units = codec._annex_b(data)
            tail = b"\0\0\0\1" + units[-1]
            self.assertIsNone(codec.classify_frame(tail)["codec"])
        randomizer = random.Random(414)
        values = [b"", None, "AV1", b"AV1", b"RIFF" + AV1, b"AV01" + AV1,
                  b"\0\0\1\x67", b"\0\0\1\x40\x01", bytes(codec.MAX_SAMPLE_BYTES + 1)]
        values += [randomizer.randbytes(randomizer.randrange(1, 500)) for _ in range(100)]
        for data in values:
            with self.subTest(length=len(data) if data is not None else None):
                self.assertIsNone(codec.classify_frame(data)["codec"])

    def test_forbidden_bits_temporal_id_and_empty_nal_tail(self):
        values = [H264.replace(b"\0\0\0\1\x67", b"\0\0\0\1\xe7", 1),
                  HEVC.replace(b"\0\0\0\1\x40\x01", b"\0\0\0\1\x40\0", 1),
                  H264[:35], HEVC[:30], H264 + b"\0\0\0\1", HEVC + b"\0\0\1"]
        for data in values:
            self.assertIsNone(codec.classify_frame(data)["codec"])

    def test_av1_incomplete_lengths_reserved_bits_and_missing_frames(self):
        values = [AV1[:-1], AV1[:16], AV1[:15], AV1[:14], AV1[:2] + AV1[16:],
                  b"\x13\0" + AV1[2:], b"\x16\x01\0" + AV1[2:],
                  b"\x0a" + b"\xff" * 8, b"\x0a\xff\xff\xff\x7f",
                  AV1[:16] + b"\x32\0", AV1[:16] + b"\x32\x08" + bytes(8),
                  AV1[:16] + b"\x32\x08\x80abcdefg"]
        for data in values:
            self.assertIsNone(codec.classify_frame(data)["codec"])

    def test_multiple_successful_candidates_are_explicitly_unverified(self):
        # Deliberately force ambiguity to exercise candidate-order independence.
        with patch.object(codec, "_av1", return_value={}):
            result = codec.classify_frame(H264)
            self.assertIsNone(result["codec"])
            self.assertIn("Ambiguous", result["evidence"])

    def test_bounded_unit_count(self):
        for data in (b"\x12\0" * 5000 + AV1,
                     b"\0\0\1\x09\x10" * 5000 + H264):
            self.assertIsNone(codec.classify_frame(data)["codec"])


def without_parameters(data, name):
    if name == "AV1":
        # The independent AV1 AU begins with a two-byte temporal delimiter,
        # then its 14-byte sequence-header OBU. Keep the current coded frame.
        return data[:2] + data[16:]
    kinds = {7, 8} if name == "H.264" else {32, 33, 34}
    units = codec._annex_b(data)
    return b"".join(b"\0\0\0\1" + unit for unit in units
                    if (unit[0] & 31 if name == "H.264" else (unit[0] >> 1) & 63) not in kinds)


class RetainedHeaderTests(unittest.TestCase):
    def test_current_coded_bytes_use_only_retained_parameters(self):
        for name, frame in (("H.264", H264), ("HEVC", HEVC), ("AV1", AV1)):
            with self.subTest(codec=name):
                classifier = codec.FrameClassifier()
                current = without_parameters(frame, name)
                self.assertIsNone(codec.classify_frame(current)["codec"])
                result = classifier.classify_frame(current, generation=(123, "stream-1"), header_frame=frame)
                self.assertEqual(result["codec"], name)
                self.assertIn("Current frame with validated same-generation", result["evidence"])
                self.assertLessEqual(sum(map(len, classifier._parameters)), codec.MAX_PARAMETER_BYTES)
                result = classifier.classify_frame(current, generation=(123, "stream-1"))
                self.assertEqual(result["codec"], name)

    def test_generation_change_discards_old_headers(self):
        classifier = codec.FrameClassifier()
        current = without_parameters(H264, "H.264")
        self.assertEqual(classifier.classify_frame(current, generation="old", header_frame=H264)["codec"], "H.264")
        self.assertIsNone(classifier.classify_frame(current, generation="replacement")["codec"])
        self.assertFalse(classifier._parameters)

    def test_direct_complete_frame_switches_codec_and_seed(self):
        classifier = codec.FrameClassifier()
        classifier.classify_frame(H264, generation=1)
        self.assertEqual(classifier.classify_frame(AV1, generation=1, header_frame=H264)["codec"], "AV1")
        self.assertEqual(classifier.classify_frame(without_parameters(AV1, "AV1"), generation=1)["codec"], "AV1")
        self.assertIsNone(classifier.classify_frame(without_parameters(H264, "H.264"), generation=1)["codec"])

    def test_seed_does_not_substitute_its_old_coded_frame(self):
        classifier = codec.FrameClassifier()
        for name, frame in (("H.264", H264), ("HEVC", HEVC), ("AV1", AV1)):
            classifier.classify_frame(frame, generation=name)
            parameters = b"".join(classifier._parameters)
            for current in (b"", parameters, b"garbage", None):
                with self.subTest(codec=name, current=current[:8] if current else current):
                    self.assertIsNone(classifier.classify_frame(current, generation=name)["codec"])

    def test_known_truncation_never_classifies_using_cache(self):
        classifier = codec.FrameClassifier()
        classifier.classify_frame(AV1, generation=1)
        result = classifier.classify_frame(without_parameters(AV1, "AV1"), generation=1, complete=False)
        self.assertIsNone(result["codec"])
        self.assertIn("truncated", result["evidence"])

    def test_malformed_header_does_not_keep_an_old_seed_active(self):
        classifier = codec.FrameClassifier()
        classifier.classify_frame(H264, generation=1)
        result = classifier.classify_frame(without_parameters(H264, "H.264"), generation=1, header_frame=H264[:10])
        self.assertIsNone(result["codec"])
        self.assertFalse(classifier._parameters)

    def test_changed_partial_parameter_set_requires_new_complete_evidence(self):
        classifier = codec.FrameClassifier()
        classifier.classify_frame(H264, generation=1)
        sps = next(unit for unit in codec._annex_b(H264) if unit[0] & 31 == 7)
        # Same framing/type, different constraint byte. The partial update must
        # not silently borrow the old parameter generation's matching IDs.
        changed = bytearray(sps)
        changed[2] ^= 0x40
        current = b"\0\0\0\1" + changed + without_parameters(H264, "H.264")
        result = classifier.classify_frame(current, generation=1)
        self.assertIsNone(result["codec"])
        self.assertIn("changes parameter sets", result["evidence"])
        self.assertFalse(classifier._parameters)

    def test_parameter_cache_size_bound_does_not_reject_direct_evidence(self):
        classifier = codec.FrameClassifier()
        # Force the cache threshold low without mutating encoded bytes. A direct
        # frame remains identifiable, but its parameters are never retained.
        with patch.object(codec, "MAX_PARAMETER_BYTES", 1):
            result = classifier.classify_frame(H264, generation=1)
        self.assertEqual(result["codec"], "H.264")
        self.assertFalse(classifier._parameters)
        self.assertIsNone(classifier.classify_frame(without_parameters(H264, "H.264"), generation=1)["codec"])


if __name__ == "__main__":
    unittest.main()
