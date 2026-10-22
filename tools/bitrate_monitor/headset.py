"""Read-only bitrate counters from one USB-connected Android headset.

No root, installs, settings writes, ADB TCP connections, or log clearing.
Decoder input bytes are used only if an existing decoder probe is publishing
fresh counters. Otherwise the source is explicitly *all traffic* on WLAN RX.
"""
from __future__ import annotations

import os
import re
import subprocess
import time


class HeadsetUnavailable(RuntimeError):
    """The requested USB counter cannot currently be read safely."""


def _run(adb_path: str, args: list[str], timeout: float = 3.0) -> str:
    if not adb_path or not os.path.isfile(adb_path):
        raise HeadsetUnavailable("Choose an existing adb executable.")
    try:
        result = subprocess.run(
            [adb_path, *args], capture_output=True, text=True, encoding="utf-8",
            errors="replace", timeout=timeout, check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise HeadsetUnavailable(f"ADB is unavailable: {exc}") from exc
    if result.returncode:
        message = (result.stderr or result.stdout).strip()
        raise HeadsetUnavailable(message or f"ADB exited with {result.returncode}.")
    return result.stdout


def _usb_serial(adb_path: str) -> str:
    # -d is ADB's USB-only transport selector. On Windows get-devpath may
    # legitimately return "unknown", so it cannot be the sole USB guard.
    serial = _run(adb_path, ["-d", "get-serialno"]).strip()
    if not re.fullmatch(r"[A-Za-z0-9._-]+", serial) or serial in {"unknown", "offline"}:
        raise HeadsetUnavailable("No single authorized USB headset; connect USB and authorize ADB.")
    return serial


def _galaxy_xr_model(adb_path: str) -> str:
    model = _run(adb_path, ["-d", "shell", "getprop", "ro.product.model"]).strip()
    # The Galaxy XR is SM-I610 (regional models can append a short suffix).
    # Ignore only conventional separators; a connected USB phone must not
    # silently become the headset bitrate source.
    canonical = re.sub(r"[-_\s]", "", model).upper()
    if not re.fullmatch(r"SMI610[A-Z0-9]{0,3}", canonical):
        raise HeadsetUnavailable(f"USB device model {model or '(unknown)'} is not a supported Galaxy XR headset (SM-I610).")
    return model


def discover_usb_devices(adb_path: str) -> list[dict]:
    """Return the single USB Galaxy XR, never a phone or Wi-Fi ADB device.

    ADB's portable -d selector deliberately refuses multiple USB devices. This
    monitor asks that other USB debugging devices be disconnected instead of
    guessing a transport from serial spelling or accidentally polling Wi-Fi.
    """
    try:
        serial = _usb_serial(adb_path)
        model = _galaxy_xr_model(adb_path)
    except HeadsetUnavailable:
        return []
    try:
        for line in _run(adb_path, ["devices", "-l"]).splitlines():
            fields = line.split()
            if len(fields) >= 2 and fields[0] == serial and fields[1] == "device":
                match = re.search(r"\bmodel:([^\s]+)", line)
                if match:
                    model = match[1].replace("_", " ")
                break
    except HeadsetUnavailable:
        pass
    return [{"serial": serial, "model": model}]


def parse_net_dev(text: str) -> dict[str, int]:
    counters = {}
    for line in text.splitlines():
        if ":" not in line:
            continue
        interface, raw = line.split(":", 1)
        fields = raw.split()
        if len(fields) >= 16 and re.fullmatch(r"\d+", fields[0]):
            counters[interface.strip()] = int(fields[0])
    return counters


def choose_wlan_interface(counters: dict[str, int], routes: str) -> str:
    available = {name for name in counters if re.fullmatch(r"wlan\d+", name)}
    routed = re.findall(r"\bdev\s+(wlan\d+)\b", routes)
    for name in routed:
        if name in available:
            return name
    if len(available) == 1:
        return next(iter(available))
    raise HeadsetUnavailable("Cannot identify one WLAN RX interface; USB/loopback traffic is not substituted.")


def parse_decoder_stats(text: str, live_pids: set[int]) -> dict | None:
    latest = None
    for line in text.splitlines():
        if "GXRDecoderProbe" not in line:
            continue
        pid = re.match(r"\s*\d+\.\d+\s+(\d+)\s+\d+\s", line)
        if not pid or int(pid[1]) not in live_pids:
            continue
        fields = dict(re.findall(r"([a-z_][a-z_0-9]*)=([^\s]+)", line))
        if (fields.get("event") != "stats" or fields.get("scope") != "decoder_input"
                or not re.fullmatch(r"[0-9a-f]{32}", fields.get("token", ""))):
            continue
        required = ("stream", "monotonic_ns", "accepted_input_bytes", "accepted_input_frames")
        if any(not re.fullmatch(r"\d+", fields.get(key, "")) for key in required):
            continue
        record = {key: int(fields[key]) for key in required}
        record.update(token=fields["token"], pid=int(pid[1]))
        if latest is None or record["monotonic_ns"] > latest["monotonic_ns"]:
            latest = record
    return latest


class HeadsetSampler:
    """Return cumulative counters; the GUI owns rate/current/min/max history."""

    def __init__(self, adb_path: str, serial: str | None = None):
        self.adb_path = adb_path
        self.serial = serial
        self._probe_key = None
        self._probe_ns = None
        self._probe_host = None
        self._probe_last_advance = None
        self._probe_origin = None
        self._verified_identity = None

    def _read_decoder(self, serial: str, boot_id: str) -> dict | None:
        now = time.monotonic()
        try:
            pids = {int(p) for p in _run(self.adb_path, ["-d", "shell", "pidof",
                       "com.valvesoftware.steamlinkvr"]).split() if p.isdecimal()}
            if not pids:
                return None
            logs = _run(self.adb_path, ["-d", "logcat", "-d", "-t", "100", "-v", "epoch",
                                       "GXRDecoderProbe:I", "*:S"])
            row = parse_decoder_stats(logs, pids)
        except HeadsetUnavailable:
            return None
        if row is None:
            return None
        key = (serial, boot_id, row["pid"], row["token"], row["stream"])
        stamp = row["monotonic_ns"]
        if key != self._probe_key or self._probe_ns is None or stamp < self._probe_ns:
            self._probe_key, self._probe_ns, self._probe_host = key, stamp, now
            self._probe_last_advance = self._probe_origin = None
            return None  # Historical log lines alone never establish freshness.
        if stamp > self._probe_ns:
            if self._probe_origin is None:
                self._probe_origin = (self._probe_ns, self._probe_host)
            self._probe_ns, self._probe_host = stamp, now
            self._probe_last_advance = now
        elif self._probe_last_advance is None or now - self._probe_last_advance > 4.0:
            return None
        origin_ns, origin_host = self._probe_origin
        return {
            "source_id": "decoder:" + ":".join(map(str, key)),
            "monotonic_time": origin_host + (stamp - origin_ns) / 1e9,
            "total_bytes": row["accepted_input_bytes"],
            "frames": row["accepted_input_frames"],
            "label": "Headset decoder input (accepted video bytes)",
            "status": f"USB {serial}; existing fresh decoder telemetry. Not display/presentation proof.",
            "measurement_kind": "decoder_input",
        }

    def sample(self) -> dict:
        serial = _usb_serial(self.adb_path)
        if self.serial and self.serial != serial:
            raise HeadsetUnavailable("Selected USB headset is not connected; no other device was substituted.")
        boot_id = _run(self.adb_path, ["-d", "shell", "cat",
                                    "/proc/sys/kernel/random/boot_id"]).strip()
        if not re.fullmatch(r"[0-9a-fA-F-]{36}", boot_id):
            raise HeadsetUnavailable("Headset boot identity is unavailable.")
        identity = (serial, boot_id)
        if identity != self._verified_identity:
            _galaxy_xr_model(self.adb_path)
            self._verified_identity = identity
        decoder = self._read_decoder(serial, boot_id)
        if decoder is not None:
            if _usb_serial(self.adb_path) != serial:
                raise HeadsetUnavailable("USB headset changed while sampling; waiting for a new baseline.")
            return decoder
        # Freshness and counters from a different device must not survive a
        # USB change between commands. -d itself still prohibits network ADB.
        if _usb_serial(self.adb_path) != serial:
            raise HeadsetUnavailable("USB headset changed while sampling; waiting for a new baseline.")
        routes = _run(self.adb_path, ["-d", "shell", "ip", "route"])
        start = time.monotonic()
        counters = parse_net_dev(_run(self.adb_path, ["-d", "shell", "cat", "/proc/net/dev"]))
        finish = time.monotonic()
        interface = choose_wlan_interface(counters, routes)
        if _usb_serial(self.adb_path) != serial:
            raise HeadsetUnavailable("USB headset changed while sampling; waiting for a new baseline.")
        return {
            "source_id": f"wlan_rx:{serial}:{boot_id}:{interface}",
            "monotonic_time": (start + finish) / 2,
            "total_bytes": counters[interface],
            "frames": None,
            "label": f"Headset {interface} RX (all traffic)",
            "status": f"USB {serial}; decoder byte telemetry unavailable. Includes audio, FEC, retransmits and other traffic; NOT video-only bitrate.",
            "measurement_kind": "network_rx_all_traffic",
        }
