"""Conservative structural codec identification from one complete encoded AU.

The frame bytes, not encoder configuration or a decoder's reported MIME type,
are the only input. This is codec framing/parameter evidence, not entropy
validation, picture decoding, live-session identity or headset-delivery proof.
Ordinary P-only AUs without parameter sets deliberately remain unverified.

Adapted from SteamVRColourLab/colourlab/codec_verify.py. Its original MIT notice
is retained below; the implementation is standalone and has no sibling import.

Specification references:
https://aomediacodec.github.io/av1-spec/#obu-header-syntax
https://www.itu.int/rec/T-REC-H.264
https://www.itu.int/rec/T-REC-H.265

MIT License

Copyright (c) 2026 SteamVR Colour Lab contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""
from __future__ import annotations

from itertools import islice
import re

MAX_SAMPLE_BYTES = 8 * 1024 * 1024
_MAX_UNITS = 4096
_START = re.compile(b"\x00\x00\x00?\x01")


class _Bits:
    def __init__(self, data):
        self.data, self.pos = data, 0

    @property
    def left(self):
        return len(self.data) * 8 - self.pos

    def u(self, count):
        if count < 0 or count > self.left:
            raise ValueError("Truncated bit header")
        result = 0
        for _ in range(count):
            result = (result << 1) | ((self.data[self.pos // 8] >> (7 - self.pos % 8)) & 1)
            self.pos += 1
        return result

    def ue(self, maximum=(1 << 31) - 1):
        zeros = 0
        while not self.u(1):
            zeros += 1
            if zeros > 31:
                raise ValueError("Unbounded Exp-Golomb header")
        value = (1 << zeros) - 1 + self.u(zeros)
        if value > maximum:
            raise ValueError("Out-of-range bit header")
        return value

    def se(self):
        v = self.ue()
        return (v + 1) // 2 if v & 1 else -(v // 2)

    def trailing(self):
        if self.left > 8 or self.u(1) != 1 or self.u(self.left) != 0:
            raise ValueError("Invalid trailing bits")


def _rbsp(data):
    """Remove and validate byte-stream emulation prevention bytes."""
    out = bytearray()
    zeros = 0
    i = 0
    while i < len(data):
        b = data[i]
        if zeros == 2:
            if b == 3:
                if i + 1 >= len(data) or data[i + 1] > 3:
                    raise ValueError("Invalid emulation-prevention byte")
                zeros = 0
                i += 1
                continue
            if b < 3:
                raise ValueError("Unescaped start-code emulation")
        out.append(b)
        zeros = zeros + 1 if b == 0 else 0
        i += 1
    return bytes(out)


def _annex_b(data):
    starts = list(islice(_START.finditer(data), _MAX_UNITS + 1))
    if len(starts) > _MAX_UNITS:
        raise ValueError("Too many Annex-B units in one sample")
    if not starts or any(data[:starts[0].start()]):
        raise ValueError("Missing Annex-B start code")
    units = []
    for i, start in enumerate(starts):
        stop = starts[i + 1].start() if i + 1 < len(starts) else len(data)
        unit = data[start.end():stop].rstrip(b"\x00")
        if not unit:
            raise ValueError("Empty Annex-B NAL unit")
        units.append(unit)
    return units


def _h264_sps(payload):
    b = _Bits(payload)
    profile = b.u(8)
    if profile not in (66, 77, 88, 100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135):
        raise ValueError("Unknown AVC profile")
    if b.u(8) & 3:
        raise ValueError("Reserved AVC constraint bits")
    level = b.u(8)
    if level == 0 or level > 62:
        raise ValueError("Invalid AVC level")
    ident = b.ue(31)
    chroma = 1
    if profile not in (66, 77, 88):
        chroma = b.ue(3)
        if chroma == 3:
            b.u(1)
        b.ue(6)
        b.ue(6)
        b.u(1)
        if b.u(1):
            for i in range(12 if chroma == 3 else 8):
                if b.u(1):
                    last = next_scale = 8
                    for _ in range(16 if i < 6 else 64):
                        if next_scale:
                            next_scale = (last + b.se() + 256) % 256
                        last = next_scale or last
    b.ue(12)  # log2_max_frame_num_minus4
    poc = b.ue(2)
    if poc == 0:
        b.ue(12)
    elif poc == 1:
        b.u(1)
        b.se()
        b.se()
        for _ in range(b.ue(255)):
            b.se()
    b.ue(16)
    b.u(1)
    width, height = 16 * (b.ue(4095) + 1), 16 * (b.ue(4095) + 1)
    frame_only = b.u(1)
    if not frame_only:
        b.u(1)
        height *= 2
    b.u(1)
    if b.u(1):
        for _ in range(4):
            b.ue(65535)
    # The VUI is not needed for identity. A present VUI must at least have
    # bytes beyond the flag; decoding its timing/color metadata is out of scope.
    if b.u(1):
        if b.left < 8 or not payload[-1]:
            raise ValueError("Truncated AVC VUI")
    else:
        b.trailing()
    return ident, {"profile_idc": profile, "coded_width": width, "coded_height": height}


def _h264(units):
    sps, pps, frames, types = {}, {}, [], []
    for unit in units:
        if unit[0] & 0x80:
            raise ValueError("AVC forbidden_zero_bit")
        kind, ref = unit[0] & 31, (unit[0] >> 5) & 3
        if kind not in (1, 5, 6, 7, 8, 9, 10, 11, 12):
            raise ValueError("Unsupported AVC NAL unit")
        if (kind in (5, 7, 8) and not ref) or (kind in (6, 9, 10, 11, 12) and ref):
            raise ValueError("Invalid AVC reference header")
        types.append(kind)
        payload = _rbsp(unit[1:])
        if not payload:
            raise ValueError("Empty AVC payload")
        if kind == 7:
            ident, details = _h264_sps(payload)
            sps[ident] = details
        elif kind == 8:
            if len(payload) < 3:
                raise ValueError("Truncated AVC PPS")
            b = _Bits(payload)
            ident, parent = b.ue(255), b.ue(31)
            b.u(2)
            if b.ue(7):
                raise ValueError("AVC slice groups unsupported")
            b.ue(31)
            b.ue(31)
            b.u(3)
            b.se()
            b.se()
            b.se()
            b.u(3)
            pps[ident] = parent
        elif kind in (1, 5):
            if len(payload) < 8:
                raise ValueError("Insufficient AVC coded slice evidence")
            b = _Bits(payload)
            b.ue(16777215)
            b.ue(9)
            frames.append(b.ue(255))
    if not sps or not pps or not frames or any(p not in sps for p in pps.values()) or any(p not in pps for p in frames):
        raise ValueError("AVC SPS/PPS and referenced coded slice required")
    return {"framing": "Annex B", "nal_types": types, "coded_slices": len(frames), **next(iter(sps.values()))}


def _hevc_profile(b, sublayers):
    b.u(2)
    b.u(1)
    profile = b.u(5)
    compatibility = b.u(32)
    if not profile and not compatibility:
        raise ValueError("Missing HEVC profile")
    b.u(48)  # constraints/source flags
    level = b.u(8)
    if not level:
        raise ValueError("Missing HEVC level")
    flags = [(b.u(1), b.u(1)) for _ in range(sublayers)]
    if sublayers:
        for _ in range(sublayers, 8):
            if b.u(2):
                raise ValueError("Reserved HEVC profile bits")
    for profile_present, level_present in flags:
        if profile_present:
            b.u(88)
        if level_present:
            b.u(8)
    return profile


def _hevc(units):
    vps, sps, pps, frames, types = set(), {}, {}, [], []
    for unit in units:
        if len(unit) < 3 or unit[0] & 0x80 or not unit[1] & 7:
            raise ValueError("Invalid HEVC NAL header")
        if ((unit[0] & 1) << 5) | (unit[1] >> 3):
            raise ValueError("Multilayer HEVC unsupported")
        kind = (unit[0] >> 1) & 63
        if kind not in (*range(10), *range(16, 22), *range(32, 41)):
            raise ValueError("Reserved HEVC NAL type")
        types.append(kind)
        payload = _rbsp(unit[2:])
        b = _Bits(payload)
        if kind == 32:
            ident = b.u(4)
            b.u(2)
            if b.u(6):
                raise ValueError("Multilayer HEVC VPS unsupported")
            layers = b.u(3)
            if layers > 6:
                raise ValueError("Invalid HEVC sublayer count")
            b.u(1)
            if b.u(16) != 65535:
                raise ValueError("Invalid HEVC VPS reserved bits")
            _hevc_profile(b, layers)
            if b.left < 8:
                raise ValueError("Truncated HEVC VPS")
            vps.add(ident)
        elif kind == 33:
            parent, layers = b.u(4), b.u(3)
            if layers > 6:
                raise ValueError("Invalid HEVC sublayer count")
            b.u(1)
            profile = _hevc_profile(b, layers)
            ident, chroma = b.ue(15), b.ue(3)
            if chroma == 3:
                b.u(1)
            width, height = b.ue(65535), b.ue(65535)
            if not width or not height:
                raise ValueError("Invalid HEVC dimensions")
            if b.u(1):
                for _ in range(4):
                    b.ue(65535)
            b.ue(8)
            b.ue(8)
            b.ue(12)
            if b.left < 8:
                raise ValueError("Truncated HEVC SPS")
            sps[ident] = (parent, {"profile_idc": profile, "coded_width": width, "coded_height": height})
        elif kind == 34:
            if len(payload) < 3:
                raise ValueError("Truncated HEVC PPS")
            ident, parent = b.ue(63), b.ue(15)
            b.u(7)
            b.ue(14)
            b.ue(14)
            b.se()
            if b.left < 3:
                raise ValueError("Truncated HEVC PPS body")
            pps[ident] = parent
        elif kind < 32:
            if len(payload) < 8:
                raise ValueError("Insufficient HEVC coded slice evidence")
            first = b.u(1)
            if 16 <= kind <= 23:
                b.u(1)
            # A first slice gives an unambiguous PPS id; later dependent
            # slices require more SPS state than this identifier maintains.
            if first:
                frames.append(b.ue(63))
    if (not vps or not sps or not pps or not frames or any(v[0] not in vps for v in sps.values())
            or any(p not in sps for p in pps.values()) or any(p not in pps for p in frames)):
        raise ValueError("HEVC VPS/SPS/PPS and referenced first coded slice required")
    return {"framing": "Annex B", "nal_types": types, "first_slices": len(frames), **next(iter(sps.values()))[1]}


def _av1_sequence(payload):
    b = _Bits(payload)
    profile, still, reduced = b.u(3), b.u(1), b.u(1)
    if profile > 2 or (reduced and not still):
        raise ValueError("Invalid AV1 sequence profile/flags")
    def level():
        value = b.u(5)
        if 23 < value < 31:
            raise ValueError("Reserved AV1 sequence level")
        return value

    if reduced:
        level()
    else:
        model = delay_bits = 0
        if b.u(1):
            if not b.u(32) or not b.u(32):
                raise ValueError("Invalid AV1 sequence timing")
            if b.u(1):
                b.ue()
            model = b.u(1)
            if model:
                delay_bits = b.u(5) + 1
                b.u(32)
                b.u(10)
        display = b.u(1)
        for _ in range(b.u(5) + 1):
            b.u(12)
            if level() > 7:
                b.u(1)
            if model and b.u(1):
                b.u(2 * delay_bits + 1)
            if display and b.u(1):
                b.u(4)
    width_bits, height_bits = b.u(4) + 1, b.u(4) + 1
    width, height = b.u(width_bits) + 1, b.u(height_bits) + 1
    if not reduced and b.u(1):
        b.u(7)
    b.u(3)
    if not reduced:
        b.u(4)
        order = b.u(1)
        if order:
            b.u(2)
        screen = 2 if b.u(1) else b.u(1)
        if screen and not b.u(1):
            b.u(1)
        if order:
            b.u(3)
    b.u(3)
    depth = 10 if b.u(1) else 8
    if profile == 2 and depth == 10 and b.u(1):
        depth = 12
    mono = 0 if profile == 1 else b.u(1)
    color = (b.u(8), b.u(8), b.u(8)) if b.u(1) else (2, 2, 2)
    if mono:
        b.u(1)
    else:
        if color != (1, 13, 0):
            b.u(1)
            sx, sy = (1, 1) if profile == 0 else (0, 0)
            if profile == 2:
                sx = b.u(1) if depth == 12 else 1
                sy = b.u(1) if depth == 12 and sx else 0
            if sx and sy:
                if b.u(2) == 3:
                    raise ValueError("Reserved AV1 chroma position")
        b.u(1)
    b.u(1)
    b.trailing()
    return {"seq_profile": profile, "bit_depth": depth, "coded_width": width,
            "coded_height": height, "reduced_still_picture_header": bool(reduced)}


def _sized_obus(data):
    """Return bounded AV1 units with their exact header/size bytes retained."""
    offset, units = 0, []
    while offset < len(data):
        if len(units) >= _MAX_UNITS:
            raise ValueError("Too many AV1 units in one sample")
        start = offset
        header = data[offset]
        offset += 1
        kind = (header >> 3) & 15
        if header & 0x81 or not header & 2 or kind not in (1, 2, 3, 4, 5, 6, 7, 8, 15):
            raise ValueError("Invalid or unsupported sized AV1 OBU header")
        if header & 4:
            if offset >= len(data) or data[offset] & 7:
                raise ValueError("Truncated/reserved AV1 extension header")
            offset += 1
        size = 0
        for i in range(8):
            if offset >= len(data):
                raise ValueError("Truncated AV1 OBU length")
            byte = data[offset]
            offset += 1
            size |= (byte & 127) << (7 * i)
            if not byte & 128:
                break
        else:
            raise ValueError("Unbounded AV1 OBU length")
        if size > MAX_SAMPLE_BYTES or size > len(data) - offset:
            raise ValueError("Truncated or oversized AV1 OBU")
        payload = data[offset:offset + size]
        offset += size
        units.append((kind, payload, data[start:offset]))
    return units


def _av1(data):
    types, sequence, frames, pending_header = [], None, 0, False
    for kind, payload, raw in _sized_obus(data):
        size = len(payload)
        types.append(kind)
        if kind == 1:
            if sequence is not None or frames or pending_header:
                raise ValueError("Multiple/late AV1 sequence headers unsupported")
            sequence = _av1_sequence(payload)
        elif kind == 2:
            if size or pending_header:
                raise ValueError("Invalid AV1 temporal delimiter")
        elif kind in (3, 6):
            if sequence is None or len(payload) < (8 if kind == 6 else 2) or not any(payload):
                raise ValueError("AV1 sequence and substantive frame payload required")
            # show_existing_frame carries no newly coded picture evidence.
            if not sequence["reduced_still_picture_header"] and payload[0] & 128:
                raise ValueError("AV1 show_existing_frame is not coded frame evidence")
            if pending_header:
                raise ValueError("AV1 frame header without its tile group")
            pending_header = kind == 3
            frames += kind == 6
        elif kind == 4:
            if not pending_header or len(payload) < 8 or not any(payload):
                raise ValueError("AV1 tile group without substantive frame header/data")
            pending_header = False
            frames += 1
        elif kind in (7, 8):
            raise ValueError("AV1 redundant/tile-list OBUs unsupported")
    if not sequence or not frames or pending_header:
        raise ValueError("AV1 sequence header and complete sized coded-frame OBU required")
    return {"framing": "size-delimited OBUs", "obu_types": types, "coded_frames": frames, **sequence}


def _identify_codec(data):
    """Return structural codec evidence or raise ValueError; no picture decoding.

    Supports Annex-B AVC/HEVC and AV1 low-overhead sized OBUs. Containers,
    length-prefixed AVC/HEVC and encrypted transport payloads are unsupported.
    """
    if not isinstance(data, (bytes, bytearray, memoryview)) or not 0 < len(data) <= MAX_SAMPLE_BYTES:
        raise ValueError("A nonempty encoded sample of at most 8 MiB is required")
    data = bytes(data)
    matches = []
    for codec, parser in (("H.264", lambda: _h264(_annex_b(data))),
                          ("HEVC", lambda: _hevc(_annex_b(data))), ("AV1", lambda: _av1(data))):
        try:
            matches.append({"detected_codec": codec, "details": parser()})
        except ValueError:
            pass
    if len(matches) != 1:
        raise ValueError("Ambiguous sample" if matches else "No complete supported codec framing and parameter/frame evidence")
    return matches[0]



def classify_frame(data: bytes, *, complete: bool = True) -> dict:
    """Identify one complete AU conservatively; ambiguous data is unverified.

    ``complete=False`` means the capture producer knows it truncated the AU.
    Fragments never receive a positive classification. Supported representations
    are AVC/HEVC Annex B and AV1 low-overhead sized OBUs. No global/session
    parameter cache exists, so stale headers cannot qualify a different stream.
    """
    if not complete:
        return {"codec": None, "label": "Unverified", "evidence": "Frame capture is truncated"}
    try:
        match = _identify_codec(data)
    except (ValueError, OverflowError) as error:
        return {"codec": None, "label": "Unverified", "evidence": str(error)}
    codec, details = match["detected_codec"], match["details"]
    labels = {"H.264": "H.264 / AVC", "HEVC": "HEVC / H.265", "AV1": "AV1"}
    parameter_sets = {"H.264": "SPS/PPS and referenced coded slice",
                      "HEVC": "VPS/SPS/PPS and referenced first coded slice",
                      "AV1": "sequence header and complete coded-frame OBU"}
    evidence = (f"{details['framing']}; {parameter_sets[codec]}; "
                f"{details['coded_width']}x{details['coded_height']}; "
                "structural byte evidence, not decoded-picture integrity")
    return {"codec": codec, "label": labels[codec], "evidence": evidence}


MAX_PARAMETER_BYTES = 64 * 1024


def _parameter_units(data: bytes, codec: str) -> tuple[bytes, ...]:
    if codec == "AV1":
        return tuple(raw for kind, payload, raw in _sized_obus(data) if kind == 1)
    kinds = (7, 8) if codec == "H.264" else (32, 33, 34)
    shift, mask = (0, 31) if codec == "H.264" else (1, 63)
    return tuple(b"\0\0\0\1" + unit for unit in _annex_b(data)
                 if ((unit[0] >> shift) & mask) in kinds)


class FrameClassifier:
    """Identify fresh frames using only parameters from the same generation.

    ``generation`` must come from the capture producer's process/session/stream
    identity, not from a codec setting. ``header_frame`` is an optional complete
    header-bearing AU whose capture identity the caller has already checked to
    match that generation. This class cannot recover capture provenance from raw
    bytes. It never retains an old coded picture, only up to 64 KiB of validated
    parameter units. A generation change invalidates those retained parameters.
    """

    def __init__(self):
        self.generation = None
        self._codec = None
        self._parameters = ()

    def _forget(self):
        self._codec, self._parameters = None, ()

    def _remember(self, data, result):
        self._forget()
        try:
            units = _parameter_units(bytes(data), result["codec"])
        except (TypeError, ValueError, OverflowError):
            return
        if units and sum(map(len, units)) <= MAX_PARAMETER_BYTES:
            self._codec, self._parameters = result["codec"], units

    def classify_frame(self, data: bytes, *, generation, complete: bool = True,
                       header_frame: bytes | None = None) -> dict:
        if generation != self.generation:
            self._forget()
            self.generation = generation
        direct = classify_frame(data, complete=complete)
        if direct["codec"] is not None:
            # Fresh, complete evidence always wins, including a codec switch.
            self._remember(data, direct)
            return direct
        if not complete:
            return direct
        if direct["evidence"] == "Ambiguous sample":
            return direct
        if not isinstance(data, (bytes, bytearray, memoryview)) or not 0 < len(data) <= MAX_SAMPLE_BYTES:
            return direct
        data = bytes(data)
        if header_frame is not None:
            header = classify_frame(header_frame)
            if header["codec"] is None:
                self._forget()
                return {"codec": None, "label": "Unverified",
                        "evidence": "Retained header AU did not supply complete codec evidence"}
            self._remember(header_frame, header)
        if self._codec is None or not self._parameters:
            return direct
        try:
            changed = _parameter_units(data, self._codec)
        except (ValueError, OverflowError):
            return direct
        if any(unit not in self._parameters for unit in changed):
            self._forget()
            return {"codec": None, "label": "Unverified",
                    "evidence": "Current frame changes parameter sets without complete matching header evidence"}
        parameters = b"".join(self._parameters)
        # All parsers require a substantive coded picture. Parameter-only input
        # cannot become a successful sample by reusing an old coded frame.
        combined = classify_frame(parameters + data)
        if combined["codec"] != self._codec:
            return direct
        return {**combined,
                "evidence": "Current frame with validated same-generation retained parameters; "
                            + combined["evidence"]}
