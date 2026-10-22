"""Focused USB-only/freshness tests; no real device commands."""
from __future__ import annotations

import subprocess
import unittest
from unittest.mock import patch

from tools.bitrate_monitor import headset


BOOT = "7d54938d-fbef-4774-ad13-813a440f8f10"
TOKEN = "a" * 32
NET = """Inter-| Receive | Transmit
 wlan0: 1000000000 12 0 0 0 0 0 0 23000 10 0 0 0 0 0 0
 lo: 9999999999 1 0 0 0 0 0 0 9999999999 1 0 0 0 0 0 0
 rndis0: 8888888888 1 0 0 0 0 0 0 8888888888 1 0 0 0 0 0 0
"""


def probe_line(stamp=1000000000, byte_count=12345, pid=99):
    return (f"1792600000.000 {pid} 101 I GXRDecoderProbe: event=stats token={TOKEN} "
            f"stream=1 monotonic_ns={stamp} accepted_input_bytes={byte_count} "
            "accepted_input_frames=10 output_frames=10 scope=decoder_input")


class ParsingTests(unittest.TestCase):
    def test_receive_column_and_wlan_selection(self):
        counters = headset.parse_net_dev(NET)
        self.assertEqual(counters["wlan0"], 1000000000)
        self.assertEqual(headset.choose_wlan_interface(counters, "default dev wlan0"), "wlan0")
        with self.assertRaises(headset.HeadsetUnavailable):
            headset.choose_wlan_interface({"lo": 1, "rndis0": 2}, "default dev rndis0")

    def test_decoder_requires_current_pid_scope_and_token(self):
        self.assertEqual(headset.parse_decoder_stats(probe_line(), {99})["accepted_input_bytes"], 12345)
        self.assertIsNone(headset.parse_decoder_stats(probe_line(), {100}))
        self.assertIsNone(headset.parse_decoder_stats(probe_line().replace("scope=decoder_input", "scope=transport"), {99}))
        self.assertIsNone(headset.parse_decoder_stats(probe_line().replace(TOKEN, "bad"), {99}))

    def test_invalid_or_negative_counter_is_rejected(self):
        self.assertIsNone(headset.parse_decoder_stats(probe_line(byte_count=-1), {99}))
        self.assertEqual(headset.parse_net_dev("wlan0: malformed"), {})


class AdbTests(unittest.TestCase):
    def test_subprocess_arguments_timeout_and_hidden_window(self):
        result = subprocess.CompletedProcess([], 0, "USB123\n", "")
        with patch.object(headset.os.path, "isfile", return_value=True), patch.object(
                headset.subprocess, "run", return_value=result) as run:
            self.assertEqual(headset._usb_serial("C:/adb path/adb.exe"), "USB123")
        self.assertEqual(run.call_args.args[0], ["C:/adb path/adb.exe", "-d", "get-serialno"])
        self.assertEqual(run.call_args.kwargs["timeout"], 3.0)
        self.assertNotIn("shell", run.call_args.kwargs)

    def test_timeout_and_unauthorized_are_not_zero_samples(self):
        with patch.object(headset.os.path, "isfile", return_value=True), patch.object(
                headset.subprocess, "run", side_effect=subprocess.TimeoutExpired("adb", 3)):
            with self.assertRaises(headset.HeadsetUnavailable):
                headset._usb_serial("adb.exe")
        with patch.object(headset.subprocess, "run", return_value=
                          subprocess.CompletedProcess([], 1, "", "device unauthorized")), patch.object(
                              headset.os.path, "isfile", return_value=True):
            with self.assertRaisesRegex(headset.HeadsetUnavailable, "unauthorized"):
                headset._usb_serial("adb.exe")

    def test_wifi_serial_never_admitted(self):
        with patch.object(headset, "_run", return_value="192.168.1.42:5555\n"):
            self.assertEqual(headset.discover_usb_devices("adb.exe"), [])

    def test_discovery_uses_single_usb_selector(self):
        def run(_path, args):
            if args == ["-d", "get-serialno"]:
                return "USB123"
            if args[-1] == "ro.product.model": return "SM-I610"
            return "USB123 device model:SM_I610\n192.168.1.3:5555 device model:Wireless"
        with patch.object(headset, "_run", side_effect=run) as call:
            self.assertEqual(headset.discover_usb_devices("adb.exe"), [{"serial": "USB123", "model": "SM I610"}])
        self.assertEqual(call.call_args_list[0].args[1], ["-d", "get-serialno"])

    def test_network_fallback_is_honestly_labeled_and_usb_only(self):
        def run(_path, args):
            self.assertEqual(args[0], "-d")
            if args[1] == "get-serialno": return "USB123"
            if args[-1] == "/proc/sys/kernel/random/boot_id": return BOOT
            if args[-1] == "ro.product.model": return "SM-I610"
            if args[-1] == "com.valvesoftware.steamlinkvr": return ""
            if args[-2:] == ["ip", "route"]: return "192.168.1.0/24 dev wlan0"
            if args[-1] == "/proc/net/dev": return NET
            self.fail(f"Unexpected command: {args}")
        with patch.object(headset, "_run", side_effect=run):
            row = headset.HeadsetSampler("adb.exe").sample()
        self.assertEqual(row["total_bytes"], 1000000000)
        self.assertEqual(row["measurement_kind"], "network_rx_all_traffic")
        self.assertIn("all traffic", row["label"])
        self.assertIn("NOT video-only", row["status"])
        self.assertIn(BOOT, row["source_id"])

    def test_selected_device_disconnect_never_substitutes_another(self):
        with patch.object(headset, "_run", return_value="DifferentUSB"):
            with self.assertRaisesRegex(headset.HeadsetUnavailable, "not connected"):
                headset.HeadsetSampler("adb.exe", serial="WantedUSB").sample()

    def test_usb_device_swap_mid_sample_is_rejected(self):
        serials = iter(["USB123", "USB123", "OtherUSB"])
        def run(_path, args):
            if args[1] == "get-serialno": return next(serials)
            if args[-1] == "/proc/sys/kernel/random/boot_id": return BOOT
            if args[-1] == "ro.product.model": return "SM-I610"
            if args[-1] == "com.valvesoftware.steamlinkvr": return ""
            if args[-2:] == ["ip", "route"]: return "default dev wlan0"
            if args[-1] == "/proc/net/dev": return NET
            self.fail(f"Unexpected command: {args}")
        with patch.object(headset, "_run", side_effect=run):
            with self.assertRaisesRegex(headset.HeadsetUnavailable, "changed"):
                headset.HeadsetSampler("adb.exe").sample()

    def test_no_device_does_not_start_shell_or_wifi_fallback(self):
        with patch.object(headset, "_run", side_effect=headset.HeadsetUnavailable("no devices")) as run:
            with self.assertRaises(headset.HeadsetUnavailable):
                headset.HeadsetSampler("adb.exe").sample()
        self.assertEqual(run.call_count, 1)
        self.assertEqual(run.call_args.args[1], ["-d", "get-serialno"])

    def test_usb_phone_rejected_before_network_or_decoder_poll(self):
        def run(_path, args):
            if args[1] == "get-serialno": return "PHONE123"
            if args[-1] == "/proc/sys/kernel/random/boot_id": return BOOT
            if args[-1] == "ro.product.model": return "SM-S928B"
            self.fail(f"Phone must not be used for counters: {args}")
        with patch.object(headset, "_run", side_effect=run):
            with self.assertRaisesRegex(headset.HeadsetUnavailable, "not a supported Galaxy XR"):
                headset.HeadsetSampler("adb.exe").sample()
            self.assertEqual(headset.discover_usb_devices("adb.exe"), [])

    def test_galaxy_xr_model_variants_and_cached_identity(self):
        for model in ("SM-I610", "SM_I610", "sm i610n"):
            with self.subTest(model=model), patch.object(headset, "_run", return_value=model):
                self.assertEqual(headset._galaxy_xr_model("adb.exe"), model)
        def run(_path, args):
            if args[1] == "get-serialno": return "USB123"
            if args[-1] == "/proc/sys/kernel/random/boot_id": return BOOT
            if args[-1] == "ro.product.model": return "SM-I610"
            if args[-1] == "com.valvesoftware.steamlinkvr": return ""
            if args[-2:] == ["ip", "route"]: return "default dev wlan0"
            if args[-1] == "/proc/net/dev": return NET
            self.fail(f"Unexpected command: {args}")
        with patch.object(headset, "_run", side_effect=run) as commands:
            sampler = headset.HeadsetSampler("adb.exe")
            sampler.sample()
            sampler.sample()
        model_reads = [call for call in commands.call_args_list if call.args[1][-1] == "ro.product.model"]
        self.assertEqual(len(model_reads), 1)

    def test_old_decoder_log_needs_fresh_advancing_counters(self):
        now = [10.0]
        stamp = [1000000000]
        def run(_path, args):
            if "pidof" in args: return "99"
            return probe_line(stamp[0])
        sampler = headset.HeadsetSampler("adb.exe")
        with patch.object(headset, "_run", side_effect=run), patch.object(headset.time, "monotonic", side_effect=lambda: now[0]):
            self.assertIsNone(sampler._read_decoder("USB123", BOOT))
            now[0] += 1
            self.assertIsNone(sampler._read_decoder("USB123", BOOT))
            stamp[0] += 1000000000
            now[0] += 1
            row = sampler._read_decoder("USB123", BOOT)
            self.assertEqual(row["measurement_kind"], "decoder_input")
            self.assertEqual(row["total_bytes"], 12345)
            now[0] += 5
            self.assertIsNone(sampler._read_decoder("USB123", BOOT))


if __name__ == "__main__":
    unittest.main()
