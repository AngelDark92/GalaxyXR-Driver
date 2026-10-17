import type { Settings } from './types';

export function baselineRequested(settings?: Settings): boolean {
  return settings?.galaxyXr?.sdr10Baseline === true;
}

/** 2026-10-17 (owner directive): Image Enhancements and the SDR 10-bit
 * baseline are independent. The master gate is streamFrame.enable alone; the
 * consent flag is retired in place and never reads into it. Inspection never
 * rewrites values. */
export function imageEnhancementsEnabled(settings?: Settings): boolean {
  return settings?.streamFrame?.enable === true;
}

/** Build one immutable write. Undefined means settings are unavailable. */
export function changePictureMode(
  settings: Settings | undefined,
  mode: 'baseline' | 'enhancements', enabled: boolean,
): Settings | undefined {
  if (!settings?.streamFrame) return undefined;
  const next = structuredClone(settings);
  const sf = next.streamFrame!;
  if (mode === 'enhancements') {
    sf.enable = enabled;
    return next;
  }
  next.galaxyXr = { nativeIdentity: true, ...(next.galaxyXr ?? {}), sdr10Baseline: enabled };
  // 2026-10-17 (owner directive): removing the baseline keeps its capability-off
  // write for older drivers as well as the current policy; enabling never
  // writes profileSupports10bit, which stays user-owned.
  if (!enabled) next.galaxyXr.profileSupports10bit = false;
  // The per-device custom shader otherwise owns Galaxy XR's color path and
  // cancels the native baseline. Enabling the baseline from off clears the
  // target for this headset only; its other headset targets stay unchanged.
  if (enabled && !baselineRequested(settings) && next.customShader) next.customShader.enableForOther = false;
  return next;
}
