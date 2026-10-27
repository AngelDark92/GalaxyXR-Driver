import { describe, expect, it } from 'vitest';
import {
  BITRATE_CURVE_PLATEAU_START, DEFAULT_BITRATE_CURVE_POINTS, bitrateCurveBase,
  bitrateCurveMbit, bitrateCurveRequestDomain, bitrateCurvePointsForFamily, bitrateCurvePointsForSettings,
  bitrateCurvePointsValid, bitrateCurveTarget, moveBitrateCurvePoint,
  normalizeBitrateCurvePoints,
} from './bitrate-curve';

// Reference points identical to GalaxyXRDriver/tests/CurveTableTest.cpp.
const custom = [
  { x: 0, y: 0.1 }, { x: 0.1, y: 0.15 }, { x: 0.4, y: 0.3 },
  { x: 0.7, y: 0.9 }, { x: 0.85, y: 0.95 }, { x: 0.95, y: 1 }, { x: 1, y: 1 },
];

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

  it('is monotone, starts at zero and never exceeds the ceiling for analytic families', () => {
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

  it('converts to Mbit/s against Max Bitrate without a separate clamp', () => {
    expect(bitrateCurveMbit(450, 450, 0, 0)).toBeCloseTo(450, 9);
    expect(bitrateCurveMbit(280, 450, 0, 0)).toBeCloseTo(280, 9);
    expect(bitrateCurveMbit(280, 450, 1, 0)).toBeCloseTo(315.262018575, 6);
    expect(bitrateCurveMbit(70, 450, 0, 100)).toBeCloseTo(450, 9);
    expect(bitrateCurveMbit(700, 450, 0, 0)).toBeCloseTo(450, 9);
    // A missing or zero ceiling falls back so the preview can report invalid
    // values without dividing by zero; it does not reintroduce 350.
    expect(bitrateCurveMbit(175, 0, 0, 0)).toBeCloseTo(1, 9);
    // Unknown families evaluate as linear, matching the header's default arm.
    expect(bitrateCurveBase(0.5, 99)).toBeCloseTo(0.5, 12);
  });

  it('scales Galaxy XR requests once above 350 and retains the raw request below it', () => {
    for (const [max, request, target] of [[280, 200, 200], [280, 320, 280],
      [350, 200, 200], [500, 320, 320 * 500 / 350], [500, 350, 500], [800, 175, 400]]) {
      expect(bitrateCurveMbit(request, max, 0, 0, undefined, 350)).toBeCloseTo(target, 9);
      expect(bitrateCurveMbit(request, max, 3, 0, DEFAULT_BITRATE_CURVE_POINTS, 350)).toBeCloseTo(target, 9);
      expect(bitrateCurveRequestDomain(max, 350)).toBe(Math.min(max, 350));
    }
    const saved = structuredClone(custom);
    // Raw 140/350 lands on the tuned point (0.4, 0.3), without a second lift.
    expect(bitrateCurveMbit(140, 500, 3, 0, custom, 350)).toBeCloseTo(150, 9);
    expect(bitrateCurveMbit(140, 500, 3, 50, custom, 350)).toBeCloseTo(500 * Math.sqrt(0.3), 9);
    for (const family of [1, 2]) {
      expect(bitrateCurveMbit(175, 800, family, 35, undefined, 350))
        .toBeCloseTo(800 * bitrateCurveTarget(0.5, family, 35), 9);
    }
    expect(custom).toEqual(saved);
    expect(bitrateCurveRequestDomain(500)).toBe(500); // neutral mapping
  });

  it('matches the native headroom budget and Force CBR policy', () => {
    expect(bitrateCurveMbit(320, 500, 0, 0, undefined, 350, 15)).toBe(434.782608);
    expect(bitrateCurveMbit(100, 500, 0, 0, undefined, 350, 15)).toBeCloseTo(100 * 500 / 350, 9);
    expect(bitrateCurveMbit(1, 500, 3, 100, custom, 350, 15)).toBe(434.782608);
    expect(bitrateCurveMbit(0, 500, 3, 0, custom, 350, 15, true)).toBe(500);
    expect(bitrateCurveMbit(70, 500, 0, 0, undefined, 350, 100, true)).toBe(500);
  });

  it('evaluates the seven-point custom curve with a movable max plateau', () => {
    expect(bitrateCurvePointsValid(custom)).toBe(true);
    expect(bitrateCurveTarget(0, 3, 0, custom)).toBeCloseTo(0.1, 12);
    expect(bitrateCurveTarget(0.05, 3, 0, custom)).toBeCloseTo(0.125, 12);
    expect(bitrateCurveTarget(0.1, 3, 0, custom)).toBeCloseTo(0.15, 12);
    expect(bitrateCurveTarget(0.4, 3, 0, custom)).toBeCloseTo(0.3, 12);
    expect(bitrateCurveTarget(0.55, 3, 0, custom)).toBeCloseTo(0.6, 12);
    expect(bitrateCurveTarget(0.85, 3, 0, custom)).toBeCloseTo(0.95, 12);
    expect(bitrateCurveTarget(0.9, 3, 0, custom)).toBeCloseTo(0.975, 12);
    expect(bitrateCurveTarget(0.95, 3, 0, custom)).toBe(1);
    expect(bitrateCurveTarget(0.975, 3, 0, custom)).toBe(1);
    expect(bitrateCurveTarget(1, 3, 0, custom)).toBe(1);
    expect(bitrateCurveTarget(0.4, 3, 50, custom)).toBeCloseTo(0.547722557505, 12);
    expect(bitrateCurveTarget(0.01, 3, 100, custom)).toBe(1);
    expect(bitrateCurveMbit(180, 450, 3, 0, custom)).toBeCloseTo(135, 9);
    expect(bitrateCurveMbit(0, 450, 3, 0, custom)).toBeCloseTo(45, 9);

    // P6's x can move left: the curve holds Max Bitrate after the plateau
    // starts even when the request has backed off.
    const wider = custom.map((point, index) => index === 4
      ? { ...point, x: 0.75, y: 0.95 }
      : index === 5 ? { ...point, x: 0.85 } : point);
    expect(bitrateCurvePointsValid(wider)).toBe(true);
    expect(bitrateCurveTarget(0.9, 3, 0, wider)).toBe(1);
    expect(bitrateCurveTarget(1, 3, 0, wider)).toBe(1);

    const capped = [
      { x: 0, y: 0 }, { x: 0.2, y: 0.5 }, { x: 0.4, y: 0.9 },
      { x: 0.7, y: 1 }, { x: 0.85, y: 1 }, { x: 0.95, y: 1 }, { x: 1, y: 1 },
    ];
    expect(bitrateCurveMbit(120, 300, 3, 0, capped)).toBeCloseTo(270, 9);
    expect(bitrateCurveMbit(120, 300, 3, 100, capped)).toBeCloseTo(300, 9);
  });

  it('rejects crossed, short, out-of-range and unanchored point sets', () => {
    expect(bitrateCurvePointsValid(custom)).toBe(true);
    expect(bitrateCurvePointsValid(custom.map((p, i) => i === 3 ? { ...p, y: 0.1 } : p))).toBe(false);
    expect(bitrateCurvePointsValid(custom.map((p, i) => i === 2 ? { ...p, x: 0.1 } : p))).toBe(false);
    expect(bitrateCurvePointsValid(custom.slice(0, 6))).toBe(false);
    const invalid = custom.map((point, index) => index === 2 ? { ...point, x: 0.01 } : point);
    expect(bitrateCurvePointsForSettings({ nvencBitrateCurve: 3, nvencBitrateCurvePoints: invalid })).toEqual(invalid);
    expect(bitrateCurvePointsValid(custom.map((p, i) => i === 1 ? { ...p, y: 1.5 } : p))).toBe(false);
    expect(bitrateCurvePointsValid(custom.map((p, i) => i === 0 ? { ...p, x: 0.1 } : p))).toBe(false);
    expect(bitrateCurvePointsValid(custom.map((p, i) => i === 6 ? { ...p, x: 0.9 } : p))).toBe(false);
    expect(bitrateCurvePointsValid(custom.map((p, i) => i === 5 ? { ...p, y: 0.9 } : p))).toBe(false);
    expect(bitrateCurvePointsValid(custom.map((p, i) => i === 6 ? { ...p, y: 0.9 } : p))).toBe(false);
    expect(bitrateCurvePointsValid(custom.map((p, i) => i === 5 ? { ...p, x: 0.85 } : p))).toBe(false);
    expect(bitrateCurvePointsValid(custom.map((p, i) => i === 2 ? { ...p, x: NaN } : p))).toBe(false);
    // A raised floor remains valid; only P1's x and the P6/P7 plateau values
    // are anchored.
    expect(bitrateCurvePointsValid(custom.map((p, i) => i === 0 ? { ...p, y: 0.12 } : p))).toBe(true);
    // P6 starts on top of hidden P7; that overlap is intentional.
    expect(bitrateCurvePointsValid(custom.map((p, i) => i === 5 ? { ...p, x: 1 } : p))).toBe(true);
  });

  it('upgrades five- and six-point shapes to the plateau shape', () => {
    const five = [
      { x: 0, y: 0 }, { x: 0.1, y: 0.05 }, { x: 0.4, y: 0.3 }, { x: 0.7, y: 0.9 }, { x: 1, y: 1 },
    ];
    const upgraded = normalizeBitrateCurvePoints(five);
    expect(upgraded).toHaveLength(7);
    expect(upgraded[0].x).toBe(0);
    expect(upgraded[4]).toEqual({ x: 0.85, y: 0.95 });
    expect(upgraded[5]).toEqual({ x: 1, y: 1 });
    expect(upgraded[6]).toEqual({ x: 1, y: 1 });
    expect(bitrateCurvePointsValid(upgraded)).toBe(true);

    const six = [
      { x: 0, y: 0 }, { x: 0.1, y: 0.05 }, { x: 0.4, y: 0.3 },
      { x: 0.7, y: 0.9 }, { x: 0.9, y: 0.95 }, { x: 1, y: 1 },
    ];
    const fromSix = normalizeBitrateCurvePoints(six);
    expect(fromSix).toHaveLength(7);
    expect(fromSix[4]).toEqual({ x: 0.9, y: 0.95 });
    expect(fromSix[5]).toEqual({ x: 1, y: 1 });
    expect(fromSix[6]).toEqual({ x: 1, y: 1 });
    expect(normalizeBitrateCurvePoints(undefined)).toEqual(DEFAULT_BITRATE_CURVE_POINTS);
  });

  it('seeds seven handles and keeps only P1 x, P6 y and P7 anchored', () => {
    for (const curve of [0, 1, 2]) {
      const points = bitrateCurvePointsForFamily(curve);
      expect(points).toHaveLength(7);
      expect(points[0]).toEqual({ x: 0, y: 0 });
      expect(points[5]).toEqual({ x: BITRATE_CURVE_PLATEAU_START, y: 1 });
      expect(points[6]).toEqual({ x: 1, y: 1 });
      expect(bitrateCurvePointsValid(points)).toBe(true);
      expect(bitrateCurvePointsForSettings({ nvencBitrateCurve: curve, nvencBitrateCurvePoints: points }))
        .toEqual(points);
    }
    const points = DEFAULT_BITRATE_CURVE_POINTS.map(point => ({ ...point }));
    const moved = moveBitrateCurvePoint(points, 2, 0.99, 0.99);
    expect(moved[2].x).toBeLessThanOrEqual(moved[3].x - 0.001);
    expect(moved[2].y).toBeLessThanOrEqual(moved[3].y);
    expect(bitrateCurvePointsValid(moved)).toBe(true);
    const crossed = moveBitrateCurvePoint(points, 1, 0.9, 0);
    expect(crossed[1].x).toBeLessThanOrEqual(crossed[2].x - 0.001);
    expect(bitrateCurvePointsValid(crossed)).toBe(true);
    const floor = moveBitrateCurvePoint(points, 0, 0.5, 0.15);
    expect(floor[0]).toEqual({ x: 0, y: 0.15 });
    const plateau = moveBitrateCurvePoint(points, 5, 0.7, 0.8);
    expect(plateau[5].x).toBeGreaterThan(points[4].x);
    expect(plateau[5].y).toBe(1);
    const edge = moveBitrateCurvePoint(points, 6, 0.5, 0.8);
    expect(edge[6]).toEqual({ x: 1, y: 1 });
    expect(bitrateCurvePointsForSettings({ nvencBitrateCurve: 3, nvencBitrateCurvePoints: moved }))
      .toEqual(moved);
  });
});
