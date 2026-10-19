// 2026-10-19 bitrate curve families, framework-free.
// Mirrors GalaxyXRDriver/src/Driver/CurveMath.h exactly; the unit test pins
// the same reference points as GalaxyXRDriver/tests/CurveTableTest.cpp so the
// preview cannot drift from the driver.
//
//   x = request / clamp in [0,1]
//   b = family(x)            all families: b(0)=0, b(1)=1, monotone
//   y = b^(1 - pct/100)      pct 0 = the curve, 100 = the ceiling
//   target = min(ceiling, ceiling * y)
export const BITRATE_CURVE_KNEE = 0.6;
export const BITRATE_CURVE_POWER = 0.75;

export const BITRATE_CURVE_FAMILIES = [
  { value: 0, label: 'Linear (streamer standard)' },
  { value: 1, label: 'Power knee' },
  { value: 2, label: 'Soft knee' },
] as const;

export function bitrateCurveBase(x: number, curve: number): number {
  if (!Number.isFinite(x) || x <= 0) return 0;
  if (x >= 1) return 1;
  if (curve === 1) {
    return x >= BITRATE_CURVE_KNEE
      ? Math.pow(x, BITRATE_CURVE_POWER)
      : x * (Math.pow(BITRATE_CURVE_KNEE, BITRATE_CURVE_POWER) / BITRATE_CURVE_KNEE);
  }
  if (curve === 2) return Math.min(1, x / BITRATE_CURVE_KNEE);
  return x;
}

export function bitrateCurveTarget(x: number, curve: number, pct: number): number {
  const base = bitrateCurveBase(x, curve);
  if (base <= 0) return 0;
  if (pct <= 0) return base;
  if (pct >= 100) return 1;
  return Math.pow(base, 1 - pct / 100);
}

/** Applied encoder target in Mbit/s for one streamer request. */
export function bitrateCurveMbit(requestMbit: number, ceilingMbit: number, clampMbit: number,
  curve: number, pct: number): number {
  const clamp = clampMbit > 0 ? clampMbit : 350;
  const ceiling = ceilingMbit > 0 ? ceilingMbit : 350;
  const x = Math.max(0, Math.min(1, requestMbit / clamp));
  return Math.min(ceiling, ceiling * bitrateCurveTarget(x, curve, pct));
}
