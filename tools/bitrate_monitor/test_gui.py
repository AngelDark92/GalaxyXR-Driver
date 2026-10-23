"""Tk integration checks with fixture samplers, never a real device."""
import csv
import queue
import json
import tempfile
import threading
import tkinter as tk
import unittest
from pathlib import Path
from unittest.mock import patch

from . import gui


class WorkerTests(unittest.TestCase):
    def test_sampler_handle_is_closed_when_worker_stops(self):
        class Sampler:
            closed = False
            def sample(self):
                worker.stop_event.set()
                return {"total_bytes": 123}
            def close(self):
                self.closed = True
        sampler = Sampler()
        output = queue.Queue()
        worker = gui.Worker("test", lambda: sampler, output, 7)
        worker.start()
        worker.join(2)
        self.assertFalse(worker.is_alive())
        self.assertTrue(sampler.closed)
        self.assertEqual(output.get_nowait(), ("test", 7, {"total_bytes": 123}, None))


class GuiTests(unittest.TestCase):
    def setUp(self):
        try:
            self.root = tk.Tk()
            self.root.withdraw()
        except tk.TclError as error:
            self.skipTest(str(error))
        with patch.object(gui.Dashboard, "start_worker"):
            self.app = gui.Dashboard(self.root, adb_path="missing-adb")
        self.root.after_cancel(self.app.after_id)

    def tearDown(self):
        if hasattr(self, "app"):
            self.app.close()

    def push(self, time, count, generation=0, key="nvenc", measurement_kind="encoded_output"):
        self.app.results.put((key, generation, dict(source_id="fixture", monotonic_time=time,
            total_bytes=count, frames=int(time) * 30, measurement_kind=measurement_kind,
            label="fixture exact bytes", status="read-only"), None))
        self.app.drain()
        self.root.after_cancel(self.app.after_id)

    def test_nvenc_rate_shows_buffers_per_second_and_retains_legacy_csv_key(self):
        self.push(100, 0)
        self.push(101, 1_000_000)
        note = self.app.cards["nvenc"]["note"].get()
        self.assertIn("30.0 buffers/s", note)
        self.assertNotIn("FPS", note)
        self.assertNotIn("frames/s", note)
        self.assertEqual(self.app.records[-1]["fps"], 30.0)

    def test_headset_rate_identifies_accepted_decoder_input_frames(self):
        self.push(100, 0, key="headset", measurement_kind="decoder_input")
        self.push(101, 1_000_000, key="headset", measurement_kind="decoder_input")
        note = self.app.cards["headset"]["note"].get()
        self.assertIn("30.0 decoder input frames/s", note)
        self.assertNotIn("buffers/s", note)
        self.assertNotIn("FPS", note)

    def test_current_average_min_max_and_csv_counter_evidence(self):
        self.push(100, 9_000_000)
        self.push(101, 10_000_000)
        self.assertEqual(self.app.cards["nvenc"]["now"].get(), "8.00")
        self.push(104, 16_000_000)
        self.assertEqual(self.app.cards["nvenc"]["fields"]["average"].get(), "14.00")
        gui.DATA_ROOT.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=gui.DATA_ROOT, prefix="gui-fixture-") as directory:
            path = Path(directory) / "export.csv"
            self.app.export(path)
            text = path.read_text(encoding="utf-8-sig")
            self.assertIn("monotonic_seconds", text)
            self.assertIn("total_bytes", text)
            self.assertIn("16000000", text)
            rows = list(csv.DictReader(text.splitlines()))
            self.assertEqual(float(rows[-1]["fps"]), 30.0)

    def test_worker_generations_and_unavailable_never_display_zero(self):
        self.push(100, 0)
        self.push(101, 1_000_000, generation=99)
        self.assertEqual(self.app.cards["nvenc"]["now"].get(), "—")
        self.push(102, 2_000_000)
        self.app.results.put(("nvenc", 0, None, "process closed"))
        self.app.drain()
        self.root.after_cancel(self.app.after_id)
        self.assertEqual(self.app.cards["nvenc"]["now"].get(), "—")
        self.assertIsNone(self.app.trackers["nvenc"].previous)

    def test_repeated_decoder_publication_does_not_reset_statistics(self):
        self.push(100, 0)
        self.push(101, 1_000_000)
        self.push(101, 1_000_000)
        self.assertEqual(self.app.trackers["nvenc"].samples, 1)
        self.assertEqual(self.app.cards["nvenc"]["now"].get(), "8.00")

    def test_applying_adb_does_not_persist_an_unapplied_interval_draft(self):
        gui.DATA_ROOT.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=gui.DATA_ROOT, prefix="interval-fixture-") as directory:
            self.app.codec_interval.set("not a valid interval")
            with patch.object(gui, "DATA_ROOT", Path(directory)), patch.object(self.app, "start_worker"):
                self.app.apply_adb()
            stored = json.loads((Path(directory) / "preferences.json").read_text())
            self.assertEqual(stored["codec_interval"], self.app._codec_seconds)

    def test_interval_validation_and_codec_hash_export(self):
        self.app.codec_interval.set("0")
        with patch.object(gui.messagebox, "showerror") as error, patch.object(self.app, "start_worker") as start:
            self.app.apply_interval()
            error.assert_called_once()
            start.assert_not_called()
        self.push(100, 0)
        detection = dict(codec="HEVC", label="HEVC / H.265", evidence="actual frame fixture",
                         frame_sha256="a" * 64, frame_index=3, capture_id=2, generation=1,
                         captured_tick_ms=123, frame_bytes=4096, sampled_at=1000, age_seconds=0.2)
        self.app.results.put(("nvenc", 0, dict(source_id="fixture", monotonic_time=101,
            total_bytes=1_000_000, frames=3030, label="fixture", codec_detection=detection), None))
        self.app.drain()
        self.root.after_cancel(self.app.after_id)
        self.assertIn("HEVC", self.app.cards["nvenc"]["codec"].get())
        self.assertEqual(self.app.records[-1]["codec_frame_sha256"], "a" * 64)


if __name__ == "__main__":
    unittest.main()
