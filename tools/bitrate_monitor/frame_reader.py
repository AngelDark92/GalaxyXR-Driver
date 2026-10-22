"""Bounded, read-only access to the versioned NVENC frame probe data export.

The ABI contains owned copies taken while an NVENC bitstream is locked.  This
reader never follows an NVENC buffer pointer, calls target code, or classifies
an encoder setting as frame evidence. The caller supplies its read-only process
API, current process identity and GetTickCount64-compatible clock value.
"""
from __future__ import annotations

import struct


EXPORT_NAME = "GalaxyXR_NVENC_Probe_v1"
MAGIC = 0x3156424F52505847
HEADER_SIZE = 128
CAPACITY = 2 * 1024 * 1024
SLOT_HEADER_SIZE = 64
SLOT_SIZE = SLOT_HEADER_SIZE + CAPACITY
PROBE_SIZE = HEADER_SIZE + 2 * SLOT_SIZE
MAX_COUNTER_AGE_MS = 6000
_RETRIES = 3


class ProbeUnavailable(RuntimeError):
    """No current, supported and coherent probe can be read."""


class FrameUnavailable(ProbeUnavailable):
    """The live probe does not currently contain a usable frame snapshot."""


def _check_range(image_size: int, rva: int, size: int) -> None:
    if (not isinstance(image_size, int) or not isinstance(rva, int)
            or not isinstance(size, int) or image_size <= 0 or rva < 0
            or size < 0 or rva > image_size or size > image_size - rva):
        raise ProbeUnavailable("Frame probe points outside the loaded driver image")


def _read(api, handle, base, image_size, rva, size):
    _check_range(image_size, rva, size)
    if not size:
        return b""
    try:
        data = api.read(handle, base + rva, size)
    except ProbeUnavailable:
        raise
    except Exception as error:
        raise ProbeUnavailable("Frame probe memory is unavailable: " + str(error)) from error
    if not isinstance(data, bytes) or len(data) != size:
        raise ProbeUnavailable("Incomplete frame probe memory read")
    return data


def _pe_layout(headers, image_size):
    try:
        if not isinstance(headers, bytes) or len(headers) < 64 or headers[:2] != b"MZ":
            raise ValueError("DOS header")
        pe = struct.unpack_from("<I", headers, 0x3C)[0]
        if headers[pe:pe + 4] != b"PE\0\0":
            raise ValueError("PE signature")
        machine, count = struct.unpack_from("<HH", headers, pe + 4)
        optional_size = struct.unpack_from("<H", headers, pe + 20)[0]
        optional = pe + 24
        if (machine != 0x8664 or struct.unpack_from("<H", headers, optional)[0] != 0x20B
                or optional_size < 120 or not 1 <= count <= 96
                or struct.unpack_from("<I", headers, optional + 56)[0] != image_size):
            raise ValueError("x64 image layout")
        table = optional + optional_size
        if table + count * 40 > len(headers):
            raise ValueError("section table exceeds supplied headers")
        sections = []
        for i in range(count):
            at = table + i * 40
            length, rva = struct.unpack_from("<II", headers, at + 8)
            flags = struct.unpack_from("<I", headers, at + 36)[0]
            _check_range(image_size, rva, length)
            sections.append((rva, length, flags))
        directories = struct.unpack_from("<I", headers, optional + 108)[0]
        export_rva, export_size = ((0, 0) if not directories else
                                  struct.unpack_from("<II", headers, optional + 112))
        return export_rva, export_size, sections
    except (ValueError, struct.error, OverflowError, TypeError) as error:
        raise ProbeUnavailable("Unsupported or malformed frame probe PE headers") from error


def find_probe(api, handle, base, image_size, headers):
    """Find the named data export, or return None only when it is absent.

    The entire fixed-capacity ABI object must fit inside one readable/writable
    image section. Forwarded exports and arbitrary pointer dereferences are not
    supported. Presence of this export does not itself establish live evidence;
    read_probe_counters/frame perform ABI, PID, time and seqlock checks.
    """
    export_rva, export_size, sections = _pe_layout(headers, image_size)
    if not export_rva and not export_size:
        return None
    if not export_rva or export_size < 40:
        raise ProbeUnavailable("Malformed driver export directory")
    _check_range(image_size, export_rva, export_size)
    directory = _read(api, handle, base, image_size, export_rva, 40)
    functions, names, function_table, name_table, ordinals = struct.unpack_from("<5I", directory, 20)
    if not 1 <= functions <= 65536 or names > 4096:
        raise ProbeUnavailable("Unsupported driver export table bounds")
    if not function_table or (names and (not name_table or not ordinals)):
        raise ProbeUnavailable("Driver export table address is missing")
    _check_range(image_size, function_table, functions * 4)
    _check_range(image_size, name_table, names * 4)
    _check_range(image_size, ordinals, names * 2)
    if not names:
        return None
    name_addresses = _read(api, handle, base, image_size, name_table, names * 4)
    ordinal_values = _read(api, handle, base, image_size, ordinals, names * 2)
    for index in range(names):
        name_rva = struct.unpack_from("<I", name_addresses, index * 4)[0]
        if not name_rva:
            raise ProbeUnavailable("Driver export name address is missing")
        _check_range(image_size, name_rva, 1)
        # Only an exact bounded ASCII name is relevant. Other DLL exports may
        # legitimately have very long C++ names; never scan those strings or
        # reject the probe just because an unrelated name exceeds a limit.
        expected_name = EXPORT_NAME.encode("ascii") + b"\0"
        name = _read(api, handle, base, image_size, name_rva,
                     min(len(expected_name), image_size - name_rva))
        if name != expected_name:
            continue
        ordinal = struct.unpack_from("<H", ordinal_values, index * 2)[0]
        if ordinal >= functions:
            raise ProbeUnavailable("Frame probe export ordinal is invalid")
        address = _read(api, handle, base, image_size, function_table + ordinal * 4, 4)
        rva = struct.unpack("<I", address)[0]
        if export_rva <= rva < export_rva + export_size:
            raise ProbeUnavailable("Forwarded frame probe exports are unsupported")
        _check_range(image_size, rva, PROBE_SIZE)
        if not any(start <= rva and PROBE_SIZE <= size - (rva - start)
                   and flags & 0xC0000000 == 0xC0000000
                   for start, size, flags in sections):
            raise ProbeUnavailable("Frame probe export does not fit in a writable driver section")
        return rva
    return None


def _decode_header(raw, expected_pid, now_ms):
    magic, version, header_size, capacity, slot_size, pid, flags = struct.unpack_from("<Q6I", raw)
    sequence, frames, total_bytes, tick, generation = struct.unpack_from("<5Q", raw, 32)
    if (magic != MAGIC or version != 1 or header_size != HEADER_SIZE
            or capacity != CAPACITY or slot_size != SLOT_SIZE):
        raise ProbeUnavailable("Unsupported NVENC frame probe ABI")
    if pid != expected_pid or pid <= 0:
        raise ProbeUnavailable("Frame probe does not belong to current SteamVR")
    if flags != 1 or not sequence or sequence & 1 or not frames or not total_bytes or not generation:
        raise ProbeUnavailable("NVENC frame probe has not published coherent live counters")
    if not -1000 <= now_ms - tick <= MAX_COUNTER_AGE_MS:
        raise ProbeUnavailable("NVENC frame probe counters are stale")
    return dict(frames=frames, total_bytes=total_bytes, generation=generation,
                ownerpid=pid, tick_ms=tick, sequence=sequence)


def read_probe_counters(api, handle, base, image_size, rva, expected_pid, now_ms):
    """Read coherent exact byte counters from the versioned data export."""
    _check_range(image_size, rva, PROBE_SIZE)
    for _ in range(_RETRIES):
        first = _read(api, handle, base, image_size, rva, HEADER_SIZE)
        if struct.unpack_from("<Q", first, 32)[0] & 1:
            continue
        second = _read(api, handle, base, image_size, rva, HEADER_SIZE)
        if first == second:
            return _decode_header(first, expected_pid, now_ms)
    raise ProbeUnavailable("NVENC frame probe counters changed during sampling")


def read_probe_frame(api, handle, base, image_size, rva, expected_pid, now_ms,
                     *, slot="latest", max_age_ms=MAX_COUNTER_AGE_MS):
    """Copy a bounded owned frame snapshot, preserving its freshness evidence.

    max_age_ms=None is permitted for the retained keyframe as same-generation
    parameter context. It does not turn that old keyframe into a fresh sample.
    Truncated snapshots return complete=False; callers must not classify them
    as a complete encoded frame.
    """
    if slot not in {"latest", "keyframe"}:
        raise ValueError("slot must be 'latest' or 'keyframe'")
    if max_age_ms is None and slot != "keyframe":
        raise ValueError("Only retained keyframe context may omit the age bound")
    if max_age_ms is not None and (not isinstance(max_age_ms, (int, float)) or max_age_ms < 0):
        raise ValueError("max_age_ms must be nonnegative")
    offset = rva + HEADER_SIZE + (SLOT_SIZE if slot == "keyframe" else 0)
    last_error = "Frame snapshot changed during sampling"
    for _ in range(_RETRIES):
        header = read_probe_counters(api, handle, base, image_size, rva, expected_pid, now_ms)
        first = _read(api, handle, base, image_size, offset, SLOT_HEADER_SIZE)
        sequence, tick, generation, frame_index, full, copied, flags, _, capture_id, _ = struct.unpack("<4Q4I2Q", first)
        if sequence & 1:
            continue
        if not sequence or not flags & 1 or not full or not copied or not capture_id:
            raise FrameUnavailable("No encoded frame snapshot is available yet")
        if (flags & ~7 or copied != min(full, CAPACITY)
                or bool(flags & 2) != (full > CAPACITY)
                or (slot == "keyframe" and not flags & 4)):
            raise FrameUnavailable("Frame snapshot length or flags are inconsistent")
        if generation != header["generation"]:
            last_error = "Frame snapshot belongs to a previous stream generation"
            continue
        if tick > header["tick_ms"] or now_ms - tick < -1000:
            raise FrameUnavailable("Frame snapshot timestamp is inconsistent")
        if max_age_ms is not None and now_ms - tick > max_age_ms:
            raise FrameUnavailable("Encoded frame snapshot is stale")
        data = _read(api, handle, base, image_size, offset + SLOT_HEADER_SIZE, copied)
        second = _read(api, handle, base, image_size, offset, SLOT_HEADER_SIZE)
        if first != second:
            continue
        final = read_probe_counters(api, handle, base, image_size, rva, expected_pid, now_ms)
        if final["generation"] != generation:
            last_error = "Stream generation changed while reading encoded frame bytes"
            continue
        return dict(data=data, full_size=full, captured_size=copied,
                    complete=not bool(flags & 2) and copied == full,
                    tick_ms=tick, generation=generation, frame_index=frame_index,
                    capture_id=capture_id, sequence=sequence, keyframe=bool(flags & 4))
    raise FrameUnavailable(last_error)
