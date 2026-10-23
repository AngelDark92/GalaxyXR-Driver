import { describe, expect, it } from 'vitest';
import { RateTracker } from './rate-tracker';

function sample(time: number, size: number, identity = 'a', frames: number | null = 0) {
  return { monotonicTime: time, totalBytes: size, sourceId: identity, frames };
}

describe('RateTracker', () => {
  it('uses real elapsed time and a time-weighted average', () => {
    const tracker = new RateTracker();
    expect(tracker.update(sample(100, 9_000_000, 'a', 50))).toBeNull();
    const first = tracker.update(sample(101, 10_000_000, 'a', 80))!;
    expect([first.current, first.average, first.fps]).toEqual([8, 8, 30]);
    const second = tracker.update(sample(104, 16_000_000, 'a', 140))!;
    expect([second.current, second.average, second.minimum, second.maximum]).toEqual([16, 14, 8, 16]);
    expect(second.samples).toBe(2);
  });

  it('accepts a real zero interval and resets on a backwards counter', () => {
    const tracker = new RateTracker();
    tracker.update(sample(1, 100));
    expect(tracker.update(sample(2, 100))!.current).toBe(0);
    expect(tracker.update(sample(3, 5))).toBeNull();
    expect(tracker.rates).toBeUndefined();
    expect(tracker.update(sample(4, 1_000_005))!.minimum).toBe(8);
  });

  it('resets on source identity or frame-generation changes', () => {
    const tracker = new RateTracker();
    tracker.update(sample(1, 0, 'a', 10));
    tracker.update(sample(2, 100, 'a', 20));
    expect(tracker.update(sample(3, 200, 'new', 30))).toBeNull();
    expect(tracker.update(sample(4, 300, 'new', 1))).toBeNull();
    expect(tracker.samples).toBe(0);
  });

  it('rejects invalid samples and treats a suspend gap as a new baseline', () => {
    const tracker = new RateTracker();
    tracker.update(sample(1, 0));
    expect(() => tracker.update(sample(1, 100))).toThrow('Sample timestamp did not advance');
    expect(tracker.update(sample(30, 1_000_000))).toBeNull();
    expect(() => tracker.update(sample(Number.NaN, 100))).toThrow('Invalid byte counter or timestamp');
    expect(() => tracker.update(sample(31, -1))).toThrow('Invalid byte counter or timestamp');
  });

  it('recognizes an exact repeated decoder publication without advancing time', () => {
    const tracker = new RateTracker();
    tracker.update(sample(10, 100, 'decoder', 5));
    expect(tracker.isDuplicate(sample(10, 100, 'decoder', 5))).toBe(true);
    expect(tracker.isDuplicate(sample(11, 100, 'decoder', 5))).toBe(false);
    expect(tracker.isDuplicate(sample(10, 101, 'decoder', 5))).toBe(false);
    expect(tracker.isDuplicate(sample(10, 100, 'other', 5))).toBe(false);
  });
});
