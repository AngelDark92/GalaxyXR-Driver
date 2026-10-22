"""Small Tk dashboard; samplers run independently outside the UI thread."""
import csv
from collections import deque
from datetime import datetime
import gettext
import json
import os
from pathlib import Path
import queue
import shutil
import threading
import time
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

from .core import RateTracker

t = gettext.gettext
REPO_ROOT = Path(__file__).resolve().parents[2]
DATA_ROOT = REPO_ROOT.parent / "builds" / REPO_ROOT.name / "build" / "bitrate-monitor"
BG, PANEL, FG, MUTED = "#101721", "#1b2635", "#edf3fb", "#a9bbce"
COLORS = {"nvenc": "#5ed4b3", "headset": "#74b9ff"}


def default_adb():
    candidates = [shutil.which("adb")]
    for name in ("ANDROID_HOME", "ANDROID_SDK_ROOT"):
        if os.environ.get(name):
            candidates.append(str(Path(os.environ[name]) / "platform-tools" / "adb.exe"))
    candidates.append(str(Path(os.environ.get("LOCALAPPDATA", "")) / "Android/Sdk/platform-tools/adb.exe"))
    return next((p for p in candidates if p and Path(p).is_file()), "")


class Worker(threading.Thread):
    def __init__(self, name, factory, results, generation):
        super().__init__(name="bitrate-" + name, daemon=True)
        self.source, self.factory, self.results = name, factory, results
        self.generation = generation
        self.stop_event = threading.Event()

    def run(self):
        sampler = None
        try:
            while not self.stop_event.is_set():
                start = time.monotonic()
                try:
                    if sampler is None:
                        sampler = self.factory()
                    result = sampler.sample()
                    self.results.put((self.source, self.generation, result, None))
                except Exception as error:
                    self.results.put((self.source, self.generation, None, str(error)))
                    if sampler is not None:
                        close = getattr(sampler, "close", None)
                        if close:
                            close()
                        sampler = None
                self.stop_event.wait(max(0.05, 1.0 - (time.monotonic() - start)))
        finally:
            if sampler is not None and getattr(sampler, "close", None):
                sampler.close()


class Dashboard:
    def __init__(self, root, adb_path=None, serial=None, codec_interval=None):
        self.root = root
        self.root.title(t("Galaxy XR Bitrate Monitor"))
        self.root.geometry("1080x840")
        self.root.minsize(820, 760)
        self.root.configure(bg=BG)
        self.results = queue.Queue()
        self.trackers = {key: RateTracker() for key in COLORS}
        self.generations = {key: 0 for key in COLORS}
        self.histories = {key: deque(maxlen=300) for key in COLORS}
        self.records = deque(maxlen=14400)
        self.workers = []
        self.cards = {}
        self.last_samples = {}
        self.last_results = {}
        self.last_arrival = {}
        self.closing = False
        self.paused = False
        self.after_id = None
        self.prefs = {}
        try:
            stored = json.loads((DATA_ROOT / "preferences.json").read_text(encoding="utf-8"))
            self.prefs = stored if isinstance(stored, dict) else {}
        except (OSError, ValueError):
            pass
        self.adb = tk.StringVar(value=adb_path if adb_path is not None else self.prefs.get("adb_path", default_adb()))
        self.serial = tk.StringVar(value=serial if serial is not None else self.prefs.get("serial", ""))
        self.codec_interval = tk.StringVar(value=str(codec_interval if codec_interval is not None else self.prefs.get("codec_interval", 5)))
        try:
            self._codec_seconds = float(self.codec_interval.get())
            if not 1 <= self._codec_seconds <= 3600:
                raise ValueError()
            interval_error = False
        except (ValueError, TypeError):
            self._codec_seconds = 5.0
            interval_error = True
        self.footer = tk.StringVar(value=t("Waiting for counter samples…"))
        if interval_error:
            self.footer.set(t("Saved frame interval is invalid; inspection uses 5 seconds until a valid interval is applied."))
        self._build()
        self.root.protocol("WM_DELETE_WINDOW", self.close)
        self.start_worker("nvenc")
        self.start_worker("headset")
        self.after_id = self.root.after(100, self.drain)

    def _label(self, parent, text="", **kwargs):
        return tk.Label(parent, text=text, bg=kwargs.pop("bg", BG), fg=kwargs.pop("fg", FG),
                        font=kwargs.pop("font", ("Segoe UI", 10)), **kwargs)

    def _build(self):
        style = ttk.Style()
        style.theme_use("clam")
        style.configure("TButton", font=("Segoe UI", 10), padding=(10, 6))
        style.configure("TEntry", padding=5)
        outer = tk.Frame(self.root, bg=BG, padx=22, pady=16)
        outer.pack(fill="both", expand=True)
        outer.columnconfigure(0, weight=1)
        outer.rowconfigure(5, weight=1, minsize=65)
        self._label(outer, t("BITRATE MONITOR"), font=("Segoe UI", 22, "bold")).grid(row=0, column=0, sticky="w")
        self._label(outer, t("Measured bytes over time • decimal Mbps • no stream settings are changed"), fg=MUTED).grid(row=1, column=0, sticky="w", pady=(3, 10))
        controls = tk.Frame(outer, bg=BG)
        controls.grid(row=2, column=0, sticky="ew")
        self._label(controls, t("ADB path")).grid(row=0, column=0, sticky="w", padx=(0, 8))
        ttk.Entry(controls, textvariable=self.adb).grid(row=0, column=1, sticky="ew")
        ttk.Button(controls, text=t("Browse…"), command=self.browse).grid(row=0, column=2, padx=8)
        ttk.Button(controls, text=t("Apply ADB"), command=self.apply_adb).grid(row=0, column=3)
        controls.columnconfigure(1, weight=1)
        self._label(controls, t("USB serial (optional)")).grid(row=1, column=0, sticky="w", pady=8, padx=(0, 8))
        ttk.Entry(controls, textvariable=self.serial, width=24).grid(row=1, column=1, sticky="w")
        usb_note = self._label(controls, t("USB debugging only; wireless ADB is never selected."), fg=MUTED, wraplength=280, justify="left")
        usb_note.grid(row=1, column=2, columnspan=2, sticky="w")
        cards = tk.Frame(outer, bg=BG)
        cards.grid(row=3, column=0, sticky="ew", pady=(6, 8))
        for column, (key, title) in enumerate((("nvenc", t("NVENC OUTPUT")), ("headset", t("HEADSET VIA USB ADB")))):
            card = tk.Frame(cards, bg=PANEL, padx=14, pady=10)
            card.grid(row=0, column=column, sticky="nsew", padx=(0, 7) if column == 0 else (7, 0))
            cards.columnconfigure(column, weight=1, uniform="cards")
            self._label(card, title, bg=PANEL, fg=COLORS[key], font=("Segoe UI", 11, "bold")).pack(anchor="w")
            now = tk.StringVar(value="—")
            self._label(card, bg=PANEL, textvariable=now, font=("Segoe UI", 28, "bold")).pack(anchor="w", pady=3)
            self._label(card, t("CURRENT Mbps"), bg=PANEL, fg=MUTED).pack(anchor="w")
            values = tk.Frame(card, bg=PANEL)
            values.pack(fill="x", pady=(10, 6))
            fields = {}
            for i, (field, label) in enumerate((("average", t("Average")), ("minimum", t("Min window")), ("maximum", t("Max window")))):
                values.columnconfigure(i, weight=1)
                var = tk.StringVar(value="—")
                self._label(values, label, bg=PANEL, fg=MUTED).grid(row=0, column=i, sticky="w")
                self._label(values, bg=PANEL, textvariable=var, font=("Segoe UI", 15, "bold")).grid(row=1, column=i, sticky="w")
                fields[field] = var
            status = tk.StringVar(value=t("Connecting…"))
            note = tk.StringVar(value="")
            status_label = self._label(card, bg=PANEL, textvariable=status, font=("Segoe UI", 9), wraplength=450, justify="left", anchor="w", height=4)
            status_label.pack(fill="x")
            note_label = self._label(card, bg=PANEL, textvariable=note, fg=MUTED, font=("Segoe UI", 9), wraplength=450, justify="left", anchor="w", height=1)
            note_label.pack(fill="x")
            codec = tk.StringVar(value=t("Frame codec: unverified"))
            codec_label = self._label(card, bg=PANEL, textvariable=codec, fg="#f4cb7c", font=("Segoe UI", 9), wraplength=450, justify="left", anchor="w", height=2)
            codec_label.pack(fill="x", pady=(5, 0))
            card.bind("<Configure>", lambda event, a=status_label, b=note_label:
                (a.configure(wraplength=max(100, event.width - 32)), b.configure(wraplength=max(100, event.width - 32))))
            card.bind("<Configure>", lambda event, label=codec_label:
                label.configure(wraplength=max(100, event.width - 32)), add="+")
            self.cards[key] = dict(now=now, fields=fields, status=status, note=note, codec=codec)
        self._label(outer, t("LAST 300 SAMPLES"), fg=MUTED, font=("Segoe UI", 9, "bold")).grid(row=4, column=0, sticky="w")
        self.canvas = tk.Canvas(outer, bg=PANEL, highlightthickness=0, height=170)
        self.canvas.grid(row=5, column=0, sticky="nsew", pady=(6, 8))
        self.canvas.bind("<Configure>", lambda _: self.draw_chart())
        rate_note = self._label(outer, t("Min/max are sampling-window rates, not per-packet peaks. Average is weighted by elapsed time."), fg=MUTED, wraplength=990, justify="left")
        rate_note.grid(row=6, column=0, sticky="w")
        network_note = self._label(outer, t("Headset WLAN RX includes all interface traffic and protocol overhead; it is not video-only bitrate."), fg="#f4cb7c", wraplength=990, justify="left")
        network_note.grid(row=7, column=0, sticky="w", pady=(3, 8))
        outer.bind("<Configure>", lambda event:
            (rate_note.configure(wraplength=max(300, event.width - 44)), network_note.configure(wraplength=max(300, event.width - 44))))
        actions = tk.Frame(outer, bg=BG)
        actions.grid(row=8, column=0, sticky="ew")
        ttk.Button(actions, text=t("Reset statistics"), command=self.reset).pack(side="left")
        self.pause_button = ttk.Button(actions, text=t("Pause"), command=self.pause)
        self.pause_button.pack(side="left", padx=8)
        ttk.Button(actions, text=t("Export CSV…"), command=self.export).pack(side="left")
        interval = tk.Frame(actions, bg=BG)
        interval.pack(side="right")
        self._label(interval, t("Frame interval (s)"), font=("Segoe UI", 9)).pack(side="left", padx=(8, 5))
        ttk.Spinbox(interval, from_=1, to=3600, increment=1, width=5, textvariable=self.codec_interval).pack(side="left")
        ttk.Button(interval, text=t("Apply interval"), command=self.apply_interval).pack(side="left", padx=(5, 0))
        self._label(outer, textvariable=self.footer, fg=MUTED, anchor="w", wraplength=750, font=("Segoe UI", 9)).grid(row=9, column=0, sticky="ew", pady=(8, 0))

    def start_worker(self, key):
        from .windows_nvenc import NvencSampler
        from .headset import HeadsetSampler
        self.generations[key] += 1
        for worker in self.workers:
            if worker.source == key:
                worker.stop_event.set()
        if key == "nvenc":
            seconds = self._codec_seconds
            factory = lambda: NvencSampler(codec_interval=seconds)
        else:
            adb_path, serial = self.adb.get().strip(), self.serial.get().strip() or None
            factory = lambda: HeadsetSampler(adb_path, serial=serial)
        worker = Worker(key, factory, self.results, self.generations[key])
        self.workers.append(worker)
        worker.start()

    def browse(self):
        path = filedialog.askopenfilename(title=t("Select adb.exe"), filetypes=[("ADB", "adb.exe"), (t("All files"), "*.*")])
        if path:
            self.adb.set(path)
            self.apply_adb()

    def apply_adb(self):
        try:
            DATA_ROOT.mkdir(parents=True, exist_ok=True)
            (DATA_ROOT / "preferences.json").write_text(json.dumps(dict(adb_path=self.adb.get(), serial=self.serial.get(), codec_interval=self._codec_seconds), indent=2), encoding="utf-8")
        except OSError as error:
            messagebox.showerror(t("Preferences could not be saved"), str(error))
        self.trackers["headset"].reset()
        self.histories["headset"].clear()
        self.start_worker("headset")

    def apply_interval(self):
        try:
            seconds = float(self.codec_interval.get())
            if not 1 <= seconds <= 3600:
                raise ValueError()
        except ValueError:
            messagebox.showerror(t("Invalid interval"), t("Enter a frame inspection interval from 1 to 3600 seconds."))
            return
        try:
            DATA_ROOT.mkdir(parents=True, exist_ok=True)
            (DATA_ROOT / "preferences.json").write_text(json.dumps(dict(adb_path=self.adb.get(), serial=self.serial.get(), codec_interval=seconds), indent=2), encoding="utf-8")
        except OSError as error:
            messagebox.showerror(t("Preferences could not be saved"), str(error))
            return
        self._codec_seconds = seconds
        self.start_worker("nvenc")
        self.footer.set(t("Frame inspection interval applied. Streaming settings were not changed."))

    def reset(self):
        for tracker in self.trackers.values():
            tracker.reset()
        for history in self.histories.values():
            history.clear()
        self.records.clear()
        for key in self.cards:
            self.unavailable(key, t("Waiting for two fresh samples…"))
        self.draw_chart()

    def pause(self):
        self.paused = not self.paused
        self.pause_button.configure(text=t("Resume") if self.paused else t("Pause"))
        self.reset()
        if self.paused:
            for key in self.cards:
                self.unavailable(key, t("Paused"))

    def unavailable(self, key, reason):
        card = self.cards[key]
        card["now"].set("—")
        for variable in card["fields"].values():
            variable.set("—")
        card["status"].set(reason)
        card["note"].set("")
        card["codec"].set(t("Frame codec: unverified"))

    def drain(self):
        if self.closing:
            return
        changed = False
        while True:
            try:
                key, generation, sample, error = self.results.get_nowait()
            except queue.Empty:
                break
            if generation != self.generations[key] or self.paused:
                continue
            self.last_arrival[key] = time.monotonic()
            changed = True
            if error:
                self.trackers[key].reset()
                self.histories[key].clear()
                self.last_results[key] = dict(error=error)
                self.unavailable(key, error)
                continue
            self.last_samples[key] = sample
            detection = sample.get("codec_detection") or {}
            if detection.get("codec"):
                age = detection.get("age_seconds", 0)
                text = t("Frame codec") + ": " + detection["label"] + f" • {age:.0f}s"
                if detection.get("frame_sha256"):
                    text += "\nSHA-256 " + detection["frame_sha256"][:16]
            elif key == "nvenc":
                text = t("Frame codec: unverified") + "\n" + t("Needs the frame-snapshot driver; see the usage guide.")
                if detection.get("sampled_at"):
                    reason = t("Captured frame did not provide conclusive codec evidence.") if detection.get("frame_sha256") else t("Frame capture is unavailable or stale.")
                    text = t("Frame codec: unverified") + "\n" + reason
            else:
                text = t("Frame codec: unverified") + "\n" + t("No headset frame-byte capture is available.")
            self.cards[key]["codec"].set(text)
            tracker = self.trackers[key]
            previous_id = tracker.previous.get("source_id") if tracker.previous else None
            if tracker.previous and all(tracker.previous.get(field) == sample.get(field)
                    for field in ("source_id", "monotonic_time", "total_bytes")):
                continue  # Decoder logs can repeat between publication ticks.
            try:
                rates = tracker.update(sample)
            except (ValueError, KeyError, TypeError) as error:
                tracker.reset()
                self.unavailable(key, str(error))
                continue
            if previous_id is not None and previous_id != sample["source_id"]:
                self.histories[key].clear()
            status = sample.get("status", "")
            if sample.get("measurement_kind") == "network_rx_all_traffic":
                status = status.split(";", 1)[0] + "\n" + t("Decoder video bytes unavailable; network total shown.")
            self.cards[key]["status"].set(sample.get("label", "") + "\n" + status)
            if rates is None:
                self.histories[key].clear()
                self.unavailable(key, sample.get("label", "") + "\n" + t("Waiting for two fresh samples…"))
                continue
            card = self.cards[key]
            card["now"].set(f"{rates.current:.2f}")
            for field, variable in card["fields"].items():
                variable.set(f"{getattr(rates, field):.2f}")
            fps = "" if rates.fps is None else f" • {rates.fps:.1f} FPS"
            card["note"].set(f"{rates.seconds:.1f} s • {rates.samples} " + t("windows") + fps)
            self.histories[key].append((sample["monotonic_time"], rates.current))
            record = dict(local_time=datetime.now().astimezone().isoformat(timespec="milliseconds"),
                          source=key, source_id=sample["source_id"], label=sample.get("label", ""),
                          monotonic_seconds=sample["monotonic_time"],
                          measurement_kind=sample.get("measurement_kind", "encoded_output"),
                          detected_codec=detection.get("codec"), codec_evidence=detection.get("evidence", ""),
                          codec_frame_sha256=detection.get("frame_sha256", ""),
                          codec_frame_index=detection.get("frame_index"), codec_capture_id=detection.get("capture_id"),
                          codec_generation=detection.get("generation"), codec_captured_tick_ms=detection.get("captured_tick_ms"),
                          codec_frame_bytes=detection.get("frame_bytes"), codec_sampled_at=detection.get("sampled_at"),
                          total_bytes=sample["total_bytes"], frames=sample.get("frames"),
                          current_mbps=rates.current, average_mbps=rates.average,
                          min_window_mbps=rates.minimum, max_window_mbps=rates.maximum,
                          measured_seconds=rates.seconds, fps=rates.fps)
            self.records.append(record)
            self.last_results[key] = record
        if not self.paused:
            for key, arrival in list(self.last_arrival.items()):
                if time.monotonic() - arrival > 6 and self.trackers[key].previous is not None:
                    self.trackers[key].reset()
                    self.histories[key].clear()
                    self.unavailable(key, t("Counter is stale; waiting for a fresh measurement."))
                    changed = True
        if changed:
            self.draw_chart()
            self.footer.set(t("Read-only measurement") + " • " + datetime.now().strftime("%H:%M:%S") + " • " + t("Independent sampling, approximately once per second"))
        self.after_id = self.root.after(100, self.drain)

    def draw_chart(self):
        canvas = self.canvas
        canvas.delete("all")
        width, height = canvas.winfo_width(), canvas.winfo_height()
        if width < 50:
            return
        points = [p for history in self.histories.values() for p in history]
        maximum = max(100.0, max((value for _, value in points), default=0) * 1.15)
        left, right = 56, width - 16
        top, bottom = 18, max(34, height - 14)
        for fraction in ((0, 1) if height < 100 else (0, 0.5, 1)):
            y = bottom - fraction * (bottom - top)
            canvas.create_line(left, y, right, y, fill="#304052")
            canvas.create_text(left - 7, y, text=f"{maximum*fraction:.0f}", anchor="e", fill=MUTED, font=("Segoe UI", 9))
        canvas.create_text(left, 10, text="Mbps", anchor="w", fill=MUTED, font=("Segoe UI", 9))
        if not points:
            canvas.create_text(width / 2, height / 2, text=t("Waiting for measured byte deltas"), fill=MUTED)
            return
        newest = max(time for time, _ in points)
        oldest = min(time for time, _ in points)
        span = max(10, newest - oldest)
        for key, history in self.histories.items():
            coordinates = []
            for timestamp, value in history:
                x = right - (newest - timestamp) / span * (right - left)
                y = bottom - value / maximum * (bottom - top)
                coordinates.extend((x, y))
            if len(coordinates) >= 4:
                canvas.create_line(*coordinates, fill=COLORS[key], width=2)
            elif coordinates:
                x, y = coordinates
                canvas.create_oval(x - 2, y - 2, x + 2, y + 2, fill=COLORS[key], outline="")

    def export(self, destination=None):
        if not self.records:
            messagebox.showinfo(t("Export CSV"), t("No completed measurement windows yet."))
            return
        DATA_ROOT.mkdir(parents=True, exist_ok=True)
        if destination is None:
            destination = filedialog.asksaveasfilename(title=t("Export measured samples"),
                initialdir=DATA_ROOT, initialfile=datetime.now().strftime("bitrate-%Y%m%d-%H%M%S.csv"),
                defaultextension=".csv", filetypes=[("CSV", "*.csv")])
        if destination:
            try:
                with open(destination, "w", newline="", encoding="utf-8-sig") as output:
                    writer = csv.DictWriter(output, fieldnames=list(self.records[0]))
                    writer.writeheader()
                    writer.writerows(self.records)
                self.footer.set(t("Saved") + ": " + str(destination))
            except OSError as error:
                messagebox.showerror(t("Export failed"), str(error))

    def close(self):
        if self.closing:
            return
        self.closing = True
        if self.after_id:
            self.root.after_cancel(self.after_id)
        self.footer.set(t("Stopping measurement workers…"))
        for worker in self.workers:
            worker.stop_event.set()
        self._finish_close()

    def _finish_close(self):
        if any(worker.is_alive() for worker in self.workers):
            self.root.after(50, self._finish_close)
        else:
            self.root.destroy()
