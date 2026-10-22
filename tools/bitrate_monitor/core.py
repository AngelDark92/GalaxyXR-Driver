"""Counter-based rates. No encoder targets or assumed frame rates are used."""
from dataclasses import dataclass
import math


@dataclass(frozen=True)
class Rates:
    current: float
    average: float
    minimum: float
    maximum: float
    seconds: float
    samples: int
    fps: float | None


class RateTracker:
    """Time-weighted session mean; extrema are completed sampling windows."""

    def __init__(self):
        self.reset()

    def reset(self):
        self.previous = None
        self.byte_sum = 0
        self.seconds = 0.0
        self.minimum = math.inf
        self.maximum = -math.inf
        self.samples = 0
        self.rates = None

    def update(self, sample):
        timestamp = float(sample["monotonic_time"])
        count = sample["total_bytes"]
        if not math.isfinite(timestamp) or not isinstance(count, int) or count < 0:
            raise ValueError("Invalid byte counter or timestamp")
        previous = self.previous
        if previous is not None:
            changed = sample["source_id"] != previous["source_id"]
            backwards = count < previous["total_bytes"]
            old_frames, frames = previous.get("frames"), sample.get("frames")
            frame_reset = frames is not None and old_frames is not None and frames < old_frames
            if changed or backwards or frame_reset:
                self.reset()
                previous = None
        if previous is None:
            self.previous = dict(sample)
            return None
        elapsed = timestamp - previous["monotonic_time"]
        if elapsed <= 0:
            raise ValueError("Sample timestamp did not advance")
        # A suspended PC or failed sampler must not smear a gap into a low rate.
        if elapsed > 15:
            self.reset()
            self.previous = dict(sample)
            return None
        delta = count - previous["total_bytes"]
        rate = delta * 8.0 / elapsed / 1_000_000
        self.byte_sum += delta
        self.seconds += elapsed
        self.samples += 1
        self.minimum = min(self.minimum, rate)
        self.maximum = max(self.maximum, rate)
        fps = None
        if frames is not None and old_frames is not None:
            fps = (frames - old_frames) / elapsed
        self.previous = dict(sample)
        self.rates = Rates(rate, self.byte_sum * 8.0 / self.seconds / 1_000_000,
                           self.minimum, self.maximum, self.seconds, self.samples, fps)
        return self.rates
