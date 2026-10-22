import unittest
from .core import RateTracker


def sample(time, size, identity="a", frames=0):
    return dict(monotonic_time=time, total_bytes=size, source_id=identity, frames=frames)


class RateTests(unittest.TestCase):
    def test_real_elapsed_time_and_weighted_average(self):
        tracker = RateTracker()
        self.assertIsNone(tracker.update(sample(100, 9_000_000, frames=50)))
        r = tracker.update(sample(101, 10_000_000, frames=80))
        self.assertEqual((r.current, r.average, r.fps), (8, 8, 30))
        r = tracker.update(sample(104, 16_000_000, frames=140))
        self.assertEqual((r.current, r.average, r.minimum, r.maximum), (16, 14, 8, 16))
        self.assertEqual(r.samples, 2)

    def test_valid_zero_and_counter_reset(self):
        tracker = RateTracker()
        tracker.update(sample(1, 100))
        self.assertEqual(tracker.update(sample(2, 100)).current, 0)
        self.assertIsNone(tracker.update(sample(3, 5)))
        self.assertIsNone(tracker.rates)
        self.assertEqual(tracker.update(sample(4, 1_000_005)).minimum, 8)

    def test_identity_and_frame_generation_reset(self):
        tracker = RateTracker()
        tracker.update(sample(1, 0, frames=10))
        tracker.update(sample(2, 100, frames=20))
        self.assertIsNone(tracker.update(sample(3, 200, identity="new", frames=30)))
        self.assertIsNone(tracker.update(sample(4, 300, identity="new", frames=1)))
        self.assertEqual(tracker.samples, 0)

    def test_invalid_and_suspend_gap(self):
        tracker = RateTracker()
        tracker.update(sample(1, 0))
        with self.assertRaises(ValueError):
            tracker.update(sample(1, 100))
        self.assertIsNone(tracker.update(sample(30, 1_000_000)))
        with self.assertRaises(ValueError):
            tracker.update(sample(float("nan"), 100))
        with self.assertRaises(ValueError):
            tracker.update(sample(31, -1))


if __name__ == "__main__":
    unittest.main()
