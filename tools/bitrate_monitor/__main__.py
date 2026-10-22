"""Launch with python -B -m tools.bitrate_monitor (no pip packages)."""
import argparse
from dataclasses import asdict
import json
import time
from pathlib import Path


def probe(seconds, adb_path, serial, output, codec_interval=5):
    from .core import RateTracker
    from .headset import HeadsetSampler
    from .windows_nvenc import NvencSampler
    from .gui import default_adb
    samplers = {"nvenc": NvencSampler(codec_interval=codec_interval), "headset": HeadsetSampler(adb_path or default_adb(), serial=serial)}
    trackers = {key: RateTracker() for key in samplers}
    rows = []
    until = time.monotonic() + seconds
    try:
        while time.monotonic() < until:
            start = time.monotonic()
            for key, sampler in samplers.items():
                try:
                    sample = sampler.sample()
                    previous = trackers[key].previous
                    if previous and all(previous.get(k) == sample.get(k) for k in ("source_id", "monotonic_time", "total_bytes")):
                        continue
                    rates = trackers[key].update(sample)
                    row = dict(source=key, sample=sample, rates=asdict(rates) if rates else None)
                except Exception as error:
                    trackers[key].reset()
                    row = dict(source=key, error=str(error))
                rows.append(row)
                print(json.dumps(row), flush=True)
            time.sleep(max(0, 1 - (time.monotonic() - start)))
    finally:
        for sampler in samplers.values():
            if getattr(sampler, "close", None):
                sampler.close()
    if output:
        path = Path(output)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(rows, indent=2), encoding="utf-8")
    return 0 if all(trackers[key].samples for key in samplers) else 2


def main():
    parser = argparse.ArgumentParser(description="Read-only NVENC output and USB headset bitrate monitor")
    parser.add_argument("--adb", help="Path to adb.exe (GUI also has a browser)")
    parser.add_argument("--serial", help="Require this USB serial; never chooses wireless ADB")
    parser.add_argument("--codec-interval", type=float, default=None, metavar="SECONDS", help="Inspect one captured frame at this interval (default 5 seconds)")
    parser.add_argument("--probe", type=float, metavar="SECONDS", help="Console measurement without a GUI")
    parser.add_argument("--output", help="JSON evidence path for --probe")
    parser.add_argument("--smoke-seconds", type=float, help=argparse.SUPPRESS)
    parser.add_argument("--smoke-report", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.codec_interval is not None and not 1 <= args.codec_interval <= 3600:
        parser.error("--codec-interval must be between 1 and 3600 seconds")
    if args.probe is not None:
        if not 2 <= args.probe <= 86400:
            parser.error("--probe must be between 2 and 86400 seconds")
        return probe(args.probe, args.adb, args.serial, args.output, args.codec_interval or 5)
    import tkinter as tk
    from .gui import Dashboard
    root = tk.Tk()
    dashboard = Dashboard(root, args.adb, args.serial, args.codec_interval)
    if args.smoke_seconds:
        def finish():
            if args.smoke_report:
                path = Path(args.smoke_report)
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps(dict(results=dashboard.last_results,
                    records=list(dashboard.records), window_geometry=root.geometry()), indent=2), encoding="utf-8")
            dashboard.close()
        root.after(int(args.smoke_seconds * 1000), finish)
    root.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
