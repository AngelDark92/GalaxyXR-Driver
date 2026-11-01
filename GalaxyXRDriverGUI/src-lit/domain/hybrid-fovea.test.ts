import { describe, expect, it } from 'vitest';
import { foveaReadout } from './hybrid-fovea';
import type { HybridConfig } from './types';

const hybrid: HybridConfig = {
  enabled: true, foveaCodec: 1, baseCodec: 0, guardDegrees: 2,
  ring0Degrees: 5, ring1Degrees: 10, ring2Degrees: 20, ring3Degrees: 35, ring4Degrees: 45,
  featherPx: 8, ring0Block: 4, ring1Block: 6, ring2Block: 8, ring3Block: 10, ring4Block: 12,
  ring0Density: 1, ring1Density: 1, ring2Density: 0.75, ring3Density: 0.5, ring4Density: 0.25,
  maxFoveaBytes: 2097152, requireReadyPeer: true,
} as HybridConfig;

describe('fovea readout (2026-11-01)', () => {
  it('derives the fovea tile from Tile Width at native render density', () => {
    const r = foveaReadout(1536, 3552, 3840, 100, 100, undefined)!;
    expect(r.areaPercent).toBeCloseTo((100 * 1536 * 1536) / (3552 * 3840), 6);
    // 2 atan(W/eyeW * tan(fov/2)) on each axis
    expect(r.foveaDegreesX).toBeCloseTo((2 * Math.atan((1536 / 3552) * Math.tan(50 * Math.PI / 180)) * 180) / Math.PI, 6);
    expect(r.foveaDegreesY).toBeCloseTo((2 * Math.atan((1536 / 3840) * Math.tan(50 * Math.PI / 180)) * 180) / Math.PI, 6);
    const centre = (3552 / (2 * Math.tan(50 * Math.PI / 180))) * (Math.PI / 180);
    expect(r.centrePxPerDegree).toBeCloseTo(centre, 6);
    // the background tile is the whole eye view in W px: W/eyeW of the native density
    expect(r.peripheryScale).toBeCloseTo(1536 / 3552, 9);
    expect(r.peripheryPxPerDegree).toBeCloseTo(centre * 1536 / 3552, 6);
  });

  it('a wider tile covers more degrees at the same pixels per degree', () => {
    const narrow = foveaReadout(1024, 3552, 3840, 100, 100, undefined)!;
    const wide = foveaReadout(2048, 3552, 3840, 100, 100, undefined)!;
    expect(wide.foveaDegreesX!).toBeGreaterThan(narrow.foveaDegreesX!);
    expect(wide.centrePxPerDegree).toBeCloseTo(narrow.centrePxPerDegree!, 9);
    expect(wide.peripheryPxPerDegree!).toBeGreaterThan(narrow.peripheryPxPerDegree!);
  });

  it('reports rings with the guard, density detail, ASTC bits and tile coverage', () => {
    const r = foveaReadout(1536, 3552, 3840, 100, 100, hybrid)!;
    expect(r.rings.map(x => x.outerDegrees)).toEqual([7, 12, 22, 37, 47]);
    expect(r.rings.map(x => x.innerDegrees)).toEqual([0, 7, 12, 22, 37]);
    expect(r.rings[0]!.astcBitsPerPixel).toBe(8);           // 4x4 at native
    expect(r.rings[2]!.astcBitsPerPixel).toBeCloseTo(128 * 0.5625 / 64, 9);
    expect(r.rings[2]!.pxPerDegree).toBeCloseTo(r.centrePxPerDegree! * 0.75, 9);
    // 1536 tile: half extents about 27.3 x 25.5 degrees, corner about 37.3
    expect(r.rings.map(x => x.coverage)).toEqual(['inside', 'inside', 'inside', 'edge', 'edge']);
    // 1024 tile: half extents about 19.0 x 17.6 degrees, corner about 25.9: ring 4 starts past the corner
    const narrow = foveaReadout(1024, 3552, 3840, 100, 100, hybrid)!;
    expect(narrow.rings.map(x => x.coverage)).toEqual(['inside', 'inside', 'edge', 'edge', 'outside']);
  });

  it('keeps pixel facts without a FOV report and rejects missing sizes', () => {
    const r = foveaReadout(1536, 3552, 3840, 0, 0, hybrid)!;
    expect(r.foveaDegreesX).toBeUndefined();
    expect(r.centrePxPerDegree).toBeUndefined();
    expect(r.rings.every(x => x.coverage === 'inside' && x.pxPerDegree === 0)).toBe(true);
    expect(foveaReadout(0, 3552, 3840, 100, 100, hybrid)).toBeUndefined();
    expect(foveaReadout(1536, 0, 3840, 100, 100, hybrid)).toBeUndefined();
  });
});
