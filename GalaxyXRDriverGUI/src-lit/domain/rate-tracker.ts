// Counter-based rates. No encoder targets or assumed frame rates are used.
// Ported from tools/bitrate_monitor/core.py; the window owns display history,
// while the native samplers only return cumulative counters.

export interface RateSample {
  sourceId: string;
  monotonicTime: number;
  totalBytes: number;
  frames?: number | null;
}

export interface Rates {
  current: number;
  average: number;
  minimum: number;
  maximum: number;
  seconds: number;
  samples: number;
  fps: number | null;
}

export class RateTracker {
  previous?: RateSample;
  byteSum = 0;
  seconds = 0;
  minimum = Infinity;
  maximum = -Infinity;
  samples = 0;
  rates?: Rates;

  reset(): void {
    this.previous = undefined;
    this.byteSum = 0;
    this.seconds = 0;
    this.minimum = Infinity;
    this.maximum = -Infinity;
    this.samples = 0;
    this.rates = undefined;
  }

  isDuplicate(sample: RateSample): boolean {
    const previous = this.previous;
    return !!previous
      && previous.sourceId === sample.sourceId
      && previous.monotonicTime === sample.monotonicTime
      && previous.totalBytes === sample.totalBytes;
  }

  update(sample: RateSample): Rates | null {
    const timestamp = Number(sample.monotonicTime);
    const count = sample.totalBytes;
    if (!Number.isFinite(timestamp) || !Number.isInteger(count) || count < 0) {
      throw new Error('Invalid byte counter or timestamp');
    }
    const previous = this.previous;
    if (previous) {
      const changed = sample.sourceId !== previous.sourceId;
      const backwards = count < previous.totalBytes;
      const oldFrames = previous.frames;
      const frames = sample.frames;
      const frameReset = frames != null && oldFrames != null && frames < oldFrames;
      if (changed || backwards || frameReset) this.reset();
    }
    const prior = this.previous;
    if (!prior) {
      this.previous = { ...sample };
      return null;
    }
    const elapsed = timestamp - prior.monotonicTime;
    if (elapsed <= 0) throw new Error('Sample timestamp did not advance');
    // A suspended PC or failed sampler must not smear a gap into a low rate.
    if (elapsed > 15) {
      this.reset();
      this.previous = { ...sample };
      return null;
    }
    const delta = count - prior.totalBytes;
    const rate = delta * 8 / elapsed / 1_000_000;
    this.byteSum += delta;
    this.seconds += elapsed;
    this.samples += 1;
    this.minimum = Math.min(this.minimum, rate);
    this.maximum = Math.max(this.maximum, rate);
    let fps: number | null = null;
    if (sample.frames != null && prior.frames != null) {
      fps = (sample.frames - prior.frames) / elapsed;
    }
    this.previous = { ...sample };
    this.rates = {
      current: rate,
      average: this.byteSum * 8 / this.seconds / 1_000_000,
      minimum: this.minimum,
      maximum: this.maximum,
      seconds: this.seconds,
      samples: this.samples,
      fps,
    };
    return this.rates;
  }
}
