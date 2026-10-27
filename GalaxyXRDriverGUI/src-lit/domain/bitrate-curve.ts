// 2026-10-19 bitrate curve families, framework-free.
// 2026-10-23 seven-point Custom family: editable floor plus a movable Max
// Bitrate plateau. Galaxy XR uses a 350 Mbit request reference. Mirrors
// GalaxyXRDriver/src/Driver/CurveMath.h exactly; the unit test pins the same
// reference points as GalaxyXRDriver/tests/CurveTableTest.cpp so the preview
// cannot drift from the driver.
//
//   D = min(MaxBitrate, requestReference), or MaxBitrate without a reference
//   x = request / D in [0,1]
//   b = family(x)            all families: monotone, bounded to [0,1]
//   y = b^(1 - pct/100)      pct 0 = the curve, 100 = MaxBitrate
//   target = min(MaxBitrate, MaxBitrate * y)
//
// The Custom family (3) is piecewise linear through seven points. P1 is fixed
// at x=0 (its y is the request-zero floor). P2..P5 are free. P6 has y fixed at
// Max Bitrate and its x is the plateau start; moving it left keeps Max Bitrate
// through a slightly backed-off request. P7 is fixed at (1,1). x strictly
// increases; y never decreases.
import type { BitrateCurvePoint } from './types';

export const BITRATE_CURVE_KNEE = 0.6;
export const BITRATE_CURVE_POWER = 0.75;
export const BITRATE_CURVE_POINT_COUNT = 7;
export const BITRATE_CURVE_POINT_GAP = 0.001;
/** P6 starts at the fixed endpoint and overlaps P7 until the user drags it
 * left to begin the Max Bitrate plateau. */
export const BITRATE_CURVE_PLATEAU_START = 1;

export const BITRATE_CURVE_FAMILIES = [
  { value: 0, label: 'Linear (streamer standard)' },
  { value: 1, label: 'Power knee' },
  { value: 2, label: 'Soft knee' },
  { value: 3, label: 'Custom (seven points)' },
] as const;

export const DEFAULT_BITRATE_CURVE_POINTS: readonly BitrateCurvePoint[] = [
  { x: 0, y: 0 },
  { x: 0.2, y: 0.2 },
  { x: 0.4, y: 0.4 },
  { x: 0.6, y: 0.6 },
  { x: 0.8, y: 0.8 },
  { x: 1, y: 1 },
  { x: 1, y: 1 },
];

function close(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9;
}

function ordered(points: readonly BitrateCurvePoint[]): boolean {
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
    if (point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) return false;
  }
  for (let i = 1; i < points.length; i++) {
    // P6 and P7 may overlap at x=1. Every earlier pair keeps the ordering gap.
    if (i === points.length - 1) {
      if (points[i].x < points[i - 1].x) return false;
    } else if (points[i].x < points[i - 1].x + BITRATE_CURVE_POINT_GAP) {
      return false;
    }
    if (points[i].y < points[i - 1].y) return false;
  }
  return true;
}

export function bitrateCurvePointsValid(points: readonly BitrateCurvePoint[] | undefined): boolean {
  if (!points || points.length !== BITRATE_CURVE_POINT_COUNT || !ordered(points)) return false;
  if (!close(points[0].x, 0) || !close(points[points.length - 1].x, 1)) return false;
  // P6 is the fixed-height plateau start; P7 is the fixed (1,1) endpoint.
  return close(points[5].y, 1) && close(points[6].y, 1);
}

/** The immediately preceding six-point shape (P1 x=0, P6 x=1, y editable). */
export function bitrateCurveSixPointsValid(points: readonly BitrateCurvePoint[] | undefined): boolean {
  if (!points || points.length !== 6 || !ordered(points)) return false;
  return close(points[0].x, 0) && close(points[5].x, 1);
}

/** The older five-point shape, used to chain 5 -> 6 -> 7. */
export function bitrateCurveFivePointsValid(points: readonly BitrateCurvePoint[] | undefined): boolean {
  if (!points || points.length !== 5 || !ordered(points)) return false;
  return true;
}

function upgradeFiveToSix(points: readonly BitrateCurvePoint[]): BitrateCurvePoint[] {
  const copy = points.map(point => ({ ...point }));
  copy[0].x = 0;
  if (copy[4].x >= 1 - 1e-9) {
    const left = copy[3], right = copy[4];
    copy.splice(4, 0, { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 });
  } else {
    copy.push({ x: 1, y: 1 });
  }
  return copy;
}

function upgradeSixToSeven(points: readonly BitrateCurvePoint[]): BitrateCurvePoint[] {
  const copy = points.map(point => ({ ...point }));
  // P6 begins at the endpoint, overlapping hidden P7. Dragging it left is the
  // only action that creates a plateau.
  if (copy[4].x > 1 - BITRATE_CURVE_POINT_GAP) {
    copy[4].x = 1 - BITRATE_CURVE_POINT_GAP;
  }
  return [
    ...copy.slice(0, 5),
    { x: 1, y: 1 },
    { x: 1, y: 1 },
  ];
}

/** Upgrade older five- or six-point storage to the seven-point shape. Invalid
 * or missing data falls back to the custom default. */
export function normalizeBitrateCurvePoints(points: readonly BitrateCurvePoint[] | undefined): BitrateCurvePoint[] {
  const copy = (points ?? []).map(point => ({ ...point }));
  if (bitrateCurvePointsValid(copy)) return copy;
  if (bitrateCurveSixPointsValid(copy)) {
    const upgraded = upgradeSixToSeven(copy);
    if (bitrateCurvePointsValid(upgraded)) return upgraded;
  }
  if (bitrateCurveFivePointsValid(copy)) {
    const six = upgradeFiveToSix(copy);
    if (bitrateCurveSixPointsValid(six)) {
      const upgraded = upgradeSixToSeven(six);
      if (bitrateCurvePointsValid(upgraded)) return upgraded;
    }
  }
  return DEFAULT_BITRATE_CURVE_POINTS.map(point => ({ ...point }));
}

export function bitrateCurvePointsBase(x: number, points: readonly BitrateCurvePoint[] | undefined): number {
  if (!bitrateCurvePointsValid(points)) return Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));
  if (x <= 0) return points![0].y;
  if (x >= 1) return points![points!.length - 1].y;
  for (let i = 1; i < points!.length; i++) {
    const left = points![i - 1], right = points![i];
    if (x <= right.x) {
      const span = right.x - left.x;
      if (span <= 0) return right.y;
      return left.y + (right.y - left.y) * ((x - left.x) / span);
    }
  }
  return points![points!.length - 1].y;
}

export function bitrateCurveBase(x: number, curve: number, points?: readonly BitrateCurvePoint[]): number {
  if (!Number.isFinite(x)) return 0;
  // Custom handles own both edges: P1's y is the request-zero floor and the
  // P6->P7 plateau holds Max Bitrate at the top.
  if (curve === 3) return bitrateCurvePointsBase(x, points);
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  if (curve === 1) {
    return x >= BITRATE_CURVE_KNEE
      ? Math.pow(x, BITRATE_CURVE_POWER)
      : x * (Math.pow(BITRATE_CURVE_KNEE, BITRATE_CURVE_POWER) / BITRATE_CURVE_KNEE);
  }
  if (curve === 2) return Math.min(1, x / BITRATE_CURVE_KNEE);
  return x;
}

export function bitrateCurveTarget(x: number, curve: number, pct: number, points?: readonly BitrateCurvePoint[]): number {
  const raw = bitrateCurveBase(x, curve, points);
  const base = Math.max(0, Math.min(1, raw));
  if (base <= 0) return 0;
  if (pct <= 0) return base;
  if (pct >= 100) return 1;
  return Math.pow(base, 1 - pct / 100);
}

/** Request-domain endpoint. Zero reference preserves neutral/legacy mapping. */
export function bitrateCurveRequestDomain(ceilingMbit: number, requestReferenceMbit = 0): number {
  const ceiling = ceilingMbit > 0 ? ceilingMbit : 1;
  return requestReferenceMbit > 0 ? Math.min(ceiling, requestReferenceMbit) : ceiling;
}

/** Steady-state positive-request map; native no-request recovery is separate. */
export function bitrateCurveMbit(requestMbit: number, ceilingMbit: number, curve: number,
  pct: number, points?: readonly BitrateCurvePoint[], requestReferenceMbit = 0,
  headroomPct = 0, forceCbr = false): number {
  const ceiling = ceilingMbit > 0 ? ceilingMbit : 1;
  if (forceCbr) return ceiling;
  const x = Math.max(0, Math.min(1, requestMbit / bitrateCurveRequestDomain(ceiling, requestReferenceMbit)));
  const budget = headroomPct > 0
    ? Math.floor(ceiling * 1e6 * 100 / (100 + headroomPct)) / 1e6 : ceiling;
  return Math.min(budget, ceiling * bitrateCurveTarget(x, curve, pct, points));
}

/** Seed seven handles from an analytic family at fixed request fractions. */
export function bitrateCurvePointsForFamily(curve: number): BitrateCurvePoint[] {
  if (!BITRATE_CURVE_FAMILIES.some(entry => entry.value === curve) || curve === 3) {
    return DEFAULT_BITRATE_CURVE_POINTS.map(point => ({ ...point }));
  }
  return [
    ...[0, 0.2, 0.4, 0.6, 0.8].map(x => ({ x, y: bitrateCurveBase(x, curve) })),
    { x: BITRATE_CURVE_PLATEAU_START, y: 1 },
    { x: 1, y: 1 },
  ];
}

/** Points the graph should draw for the saved family. Presets are derived;
 * Custom uses the saved shape after upgrading any older five/six-point form. */
export function bitrateCurvePointsForSettings(settings: {
  nvencBitrateCurve?: number;
  nvencBitrateCurvePoints?: readonly BitrateCurvePoint[];
}): BitrateCurvePoint[] {
  const curve = settings.nvencBitrateCurve ?? 0;
  if (curve === 3) {
    const points = settings.nvencBitrateCurvePoints;
    if (bitrateCurvePointsValid(points) || bitrateCurveFivePointsValid(points) || bitrateCurveSixPointsValid(points)) {
      return normalizeBitrateCurvePoints(points);
    }
    // The native consumer rejects invalid saved shapes. Keep the graph's error
    // visible too, rather than substituting an apparently valid default curve.
    return Array.isArray(points) ? points.map(point => ({ ...point })) : [];
  }
  return bitrateCurvePointsForFamily(curve);
}

/** Move one handle while preserving fan-curve ordering.
 * P1 x stays 0 with an editable y; P6 keeps y=1 and moves only on x; P7 stays
 * fixed at (1,1). P2..P5 remain free. */
export function moveBitrateCurvePoint(points: readonly BitrateCurvePoint[], index: number,
  x: number, y: number): BitrateCurvePoint[] {
  if (index < 0 || index >= points.length) return points.map(point => ({ ...point }));
  const next = points.map(point => ({ ...point }));
  const last = next.length - 1;
  if (index === 0) {
    next[0].x = 0;
    next[0].y = Math.max(0, Math.min(next[1].y, Number.isFinite(y) ? y : next[0].y));
    return next;
  }
  if (index === last) {
    next[last] = { x: 1, y: 1 };
    return next;
  }
  if (index === last - 1) {
    const lowX = next[index - 1].x + BITRATE_CURVE_POINT_GAP;
    // P6 may sit exactly on P7 (overlap) or move left to start the plateau.
    next[index].x = Math.max(lowX, Math.min(1, Number.isFinite(x) ? x : next[index].x));
    next[index].y = 1;
    return next;
  }
  const lowX = next[index - 1].x + BITRATE_CURVE_POINT_GAP;
  const highX = next[index + 1].x - BITRATE_CURVE_POINT_GAP;
  const lowY = next[index - 1].y;
  const highY = next[index + 1].y;
  next[index].x = Math.max(lowX, Math.min(highX, Number.isFinite(x) ? x : next[index].x));
  next[index].y = Math.max(lowY, Math.min(highY, Number.isFinite(y) ? y : next[index].y));
  return next;
}
