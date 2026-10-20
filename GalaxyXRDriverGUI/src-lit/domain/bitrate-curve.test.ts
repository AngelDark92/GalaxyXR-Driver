import { describe, expect, it } from 'vitest';
import { bitrateCurveBase, bitrateCurveMbit, bitrateCurveTarget } from './bitrate-curve';

// Reference points identical to GalaxyXRDriver/tests/CurveTableTest.cpp.
describe('bitrate curve families', () => {
  it('pins the same table as the native test', () => {
    expect(bitrateCurveTarget(0.5, 0, 0)).toBeCloseTo(0.5, 12);
    expect(bitrateCurveTarget(0.9, 0, 0)).toBeCloseTo(0.9, 12);
    expect(bitrateCurveTarget(0.9, 0, 25)).toBeCloseTo(0.924021086472, 12);
    expect(bitrateCurveTarget(0.5, 0, 50)).toBeCloseTo(0.707106781187, 12);
    expect(bitrateCurveTarget(0.5, 0, 100)).toBeCloseTo(1, 12);
    expect(bitrateCurveTarget(0.9, 1, 0)).toBeCloseTo(0.924021086472, 12);
    expect(bitrateCurveTarget(0.3, 1, 0)).toBeCloseTo(0.34086580994, 12);
    expect(bitrateCurveTarget(0.6, 1, 50)).toBeCloseTo(0.825670406325, 12);
    expect(bitrateCurveTarget(0.2, 1, 75)).toBeCloseTo(0.690435392599, 12);
    expect(bitrateCurveTarget(0.1, 1, 100)).toBeCloseTo(1, 12);
    expect(bitrateCurveTarget(0.9, 2, 0)).toBeCloseTo(1, 12);
    expect(bitrateCurveTarget(0.3, 2, 0)).toBeCloseTo(0.5, 12);
    expect(bitrateCurveTarget(0.3, 2, 50)).toBeCloseTo(0.707106781187, 12);
    expect(bitrateCurveTarget(0.1, 2, 100)).toBeCloseTo(1, 12);
  });

  it('is monotone, starts at zero and never exceeds the ceiling', () => {
    for (const curve of [0, 1, 2]) {
      for (let pct = 0; pct <= 100; pct += 5) {
        expect(bitrateCurveTarget(0, curve, pct)).toBe(0);
        expect(bitrateCurveTarget(1, curve, pct)).toBe(1);
        let previous = 0;
        for (let i = 0; i <= 100; i++) {
          const value = bitrateCurveTarget(i / 100, curve, pct);
          expect(value).toBeGreaterThanOrEqual(previous - 1e-12);
          expect(value).toBeLessThanOrEqual(1 + 1e-12);
          previous = value;
        }
        if (pct === 100) expect(bitrateCurveTarget(0.01, curve, pct)).toBe(1);
      }
    }
  });

  it('converts to Mbit/s against the ceiling and clamp', () => {
    expect(bitrateCurveMbit(350, 450, 350, 0, 0)).toBeCloseTo(450, 9);
    expect(bitrateCurveMbit(280, 450, 350, 0, 0)).toBeCloseTo(360, 9);
    expect(bitrateCurveMbit(280, 450, 350, 1, 0)).toBeCloseTo(380.65365484, 6);
    expect(bitrateCurveMbit(70, 450, 350, 0, 100)).toBeCloseTo(450, 9);
    expect(bitrateCurveMbit(350, 450, 280, 0, 0)).toBeCloseTo(450, 9);
    // A missing clamp falls back to vrlink's 350 rather than dividing by zero.
    expect(bitrateCurveMbit(175, 400, 0, 0, 0)).toBeCloseTo(200, 9);
    // Unknown families evaluate as linear, matching the header's default arm.
    expect(bitrateCurveBase(0.5, 99)).toBeCloseTo(0.5, 12);
  });
});
