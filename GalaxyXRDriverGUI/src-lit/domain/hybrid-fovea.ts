// What the stream's fovea actually is (2026-11-01). Steam Link's frame is four stacked
// W x W tiles: per eye a W x W cut-out of the render target at native density around the
// gaze point (the fovea) and the whole eye view downscaled into W x W (the background).
// Tile Width therefore sets both the fovea's size and the periphery's sharpness; the
// render size sets the pixels per degree everywhere. The hybrid fovea replaces the video's
// fovea tile and spends its own per-ring budget inside that same W x W window.
//
// Angles use a centred symmetric projection, so they are estimates: the real projection is
// asymmetric and the cut-out follows the gaze.
import type { HybridConfig } from './types';
import { t } from '../locale/i18n';

export type FoveaRing = {
  innerDegrees: number;
  outerDegrees: number;  // includes the guard angle, as the planner applies it
  block: number;
  density: number;
  pxPerDegree: number;   // sampled detail at the ring's density
  astcBitsPerPixel: number;  // per source pixel: 128 bits per block, density^2 texels per pixel
  coverage: 'inside' | 'edge' | 'outside';  // against the fovea tile, gaze centred
};

export type FoveaReadout = {
  tileWidth: number;
  eyeWidth: number;
  eyeHeight: number;
  areaPercent: number;        // share of the eye's render target the fovea tile covers
  foveaDegreesX?: number;     // undefined until the driver reports the headset FOV
  foveaDegreesY?: number;
  centrePxPerDegree?: number;
  peripheryPxPerDegree?: number;
  peripheryScale: number;     // background tile samples per render pixel (horizontal)
  rings: FoveaRing[];
};

const deg = Math.PI / 180;

function span(fraction: number, fovDegrees: number): number {
  return 2 * Math.atan(fraction * Math.tan((fovDegrees * deg) / 2)) / deg;
}

export function foveaReadout(tileWidth: number, eyeWidth: number, eyeHeight: number,
  fovX: number | undefined, fovY: number | undefined, hybrid: HybridConfig | undefined): FoveaReadout | undefined {
  if (!(tileWidth > 0) || !(eyeWidth > 0) || !(eyeHeight > 0)) return undefined;
  const fx = Math.min(1, tileWidth / eyeWidth);
  const fy = Math.min(1, tileWidth / eyeHeight);
  const haveFov = !!fovX && fovX > 0 && fovX < 180 && !!fovY && fovY > 0 && fovY < 180;
  const foveaDegreesX = haveFov ? span(fx, fovX!) : undefined;
  const foveaDegreesY = haveFov ? span(fy, fovY!) : undefined;
  const centre = haveFov ? (eyeWidth / (2 * Math.tan((fovX! * deg) / 2))) * deg : undefined;
  const rings: FoveaRing[] = [];
  if (hybrid) {
    const outer = [hybrid.ring0Degrees, hybrid.ring1Degrees, hybrid.ring2Degrees, hybrid.ring3Degrees, hybrid.ring4Degrees];
    const blocks = [hybrid.ring0Block, hybrid.ring1Block, hybrid.ring2Block, hybrid.ring3Block, hybrid.ring4Block];
    const density = [hybrid.ring0Density, hybrid.ring1Density, hybrid.ring2Density, hybrid.ring3Density, hybrid.ring4Density];
    const guard = hybrid.guardDegrees ?? 0;
    const halfMin = haveFov ? Math.min(foveaDegreesX!, foveaDegreesY!) / 2 : undefined;
    const halfCorner = haveFov ? Math.hypot(foveaDegreesX!, foveaDegreesY!) / 2 : undefined;
    let inner = 0;
    for (let i = 0; i < 5; i++) {
      const o = (outer[i] ?? 0) + guard;
      const b = blocks[i] ?? 4;
      const d = density[i] ?? 1;
      rings.push({
        innerDegrees: inner, outerDegrees: o, block: b, density: d,
        pxPerDegree: centre !== undefined ? centre * d : 0,
        astcBitsPerPixel: (128 * d * d) / (b * b),
        coverage: halfMin === undefined || o <= halfMin ? 'inside' : inner >= halfCorner! ? 'outside' : 'edge',
      });
      inner = o;
    }
  }
  return {
    tileWidth, eyeWidth, eyeHeight,
    areaPercent: (100 * tileWidth * tileWidth) / (eyeWidth * eyeHeight),
    foveaDegreesX, foveaDegreesY,
    centrePxPerDegree: centre,
    peripheryPxPerDegree: centre !== undefined ? centre * fx : undefined,
    peripheryScale: fx,
    rings,
  };
}

export function foveaSummary(r: FoveaReadout): string {
  const base = { w: r.tileWidth, pct: r.areaPercent.toFixed(1), ew: r.eyeWidth, eh: r.eyeHeight };
  if (r.foveaDegreesX === undefined || r.foveaDegreesY === undefined || r.centrePxPerDegree === undefined) {
    return t('Stream fovea: {w} x {w} px per eye at native density ({pct}% of the {ew} x {eh} eye render). Angles appear once the headset reports its field of view.', base);
  }
  return t('Stream fovea: {w} x {w} px per eye at native density ({pct}% of the {ew} x {eh} eye render), about {dx}° x {dy}° at {ppd} px/deg. Periphery: the whole eye view in {w} x {w}, about {pppd} px/deg.', {
    ...base, dx: r.foveaDegreesX.toFixed(1), dy: r.foveaDegreesY.toFixed(1),
    ppd: Math.round(r.centrePxPerDegree), pppd: Math.round(r.peripheryPxPerDegree ?? 0),
  });
}

export function ringSummary(r: FoveaRing, index: number): string {
  const params = { i: index, inner: r.innerDegrees.toFixed(0), outer: r.outerDegrees.toFixed(0), b: r.block,
    d: r.density, ppd: Math.round(r.pxPerDegree), bpp: r.astcBitsPerPixel.toFixed(2) };
  const line = r.pxPerDegree > 0
    ? t('Ring {i}: {inner}-{outer}° with guard, {b}x{b}, density {d}: {ppd} px/deg, {bpp} ASTC bits per pixel', params)
    : t('Ring {i}: {inner}-{outer}° with guard, {b}x{b}, density {d}: {bpp} ASTC bits per pixel', params);
  if (r.coverage === 'edge') return `${line} ${t('(reaches the fovea tile edge)')}`;
  if (r.coverage === 'outside') return `${line} ${t('(outside the fovea tile with a centred gaze: no effect)')}`;
  return line;
}
