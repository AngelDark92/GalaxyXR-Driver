import type { Settings, StreamFrameConfig } from './types';

/** Picture controls only. Never reset tracking, controller tuning, transport,
 * encoder bitrate/preset, driver identity, or the persisted migration stamps. */
export const PICTURE_KEYS = [
  'brightness', 'saturation', 'vibrance', 'contrast', 'contrastMidpoint',
  'contrastLinear', 'gamma', 'colorMultiplier', 'srgbMatrix', 'fxaa', 'cas',
  'postPack', 'dither', 'blackFloor', 'stationaryDimming', 'k1', 'k2',
  'distortion', 'centerOffsetXLeft', 'centerOffsetXRight', 'centerOffsetY',
  'alignment', 'pupilSwim', 'calib', 'skipColorWhileDashboardOpen',
  'nvencVuiFullRange', 'nvencVuiMatrix', 'nvencVuiPrimaries', 'nvencVuiTransfer',
] as const satisfies readonly (keyof StreamFrameConfig)[];

export function baselineRequested(settings?: Settings): boolean {
  return settings?.galaxyXr?.sdr10Baseline === true;
}

/** 2026-09-25: legacy overlapping flags remain protected unless the user
 * explicitly accepted the quality warning. Inspection never rewrites values. */
export function imageEnhancementsEnabled(settings?: Settings): boolean {
  return settings?.streamFrame?.enable === true &&
    (!baselineRequested(settings) || settings?.galaxyXr?.sdr10AllowEnhancements === true);
}

function resetKnownValues(current: unknown, defaults: unknown): unknown {
  if (defaults && typeof defaults === 'object' && !Array.isArray(defaults)) {
    const result: Record<string, unknown> = current && typeof current === 'object' && !Array.isArray(current)
      ? structuredClone(current as Record<string, unknown>) : {};
    for (const [key, value] of Object.entries(defaults)) result[key] = resetKnownValues(result[key], value);
    return result;
  }
  return structuredClone(defaults);
}

/** Build one immutable write. Undefined means consent is missing, enhancements
 * must be switched off before a baseline reset, or settings are unavailable. */
export function changePictureMode(
  settings: Settings | undefined, defaults: StreamFrameConfig,
  mode: 'baseline' | 'enhancements', enabled: boolean,
  qualityWarningAccepted = false,
): Settings | undefined {
  if (!settings?.streamFrame) return undefined;
  if (enabled && mode === 'enhancements' && baselineRequested(settings) && !qualityWarningAccepted) return undefined;
  if (enabled && mode === 'baseline' && imageEnhancementsEnabled(settings)) return undefined;
  const next = structuredClone(settings);
  const sf = next.streamFrame!;
  if (mode === 'enhancements') {
    sf.enable = enabled;
    next.galaxyXr = { nativeIdentity: true, ...(next.galaxyXr ?? {}),
      sdr10AllowEnhancements: enabled && baselineRequested(settings) && qualityWarningAccepted };
    return next;
  }
  next.galaxyXr = { nativeIdentity: true, ...(next.galaxyXr ?? {}), sdr10Baseline: enabled, sdr10AllowEnhancements: false };
  // Leaving the baseline never silently re-enables enhancements from a legacy
  // overlapping file. Enabling enhancements is a separate, explicit action.
  sf.enable = false;
  if (enabled && !baselineRequested(settings)) {
    const target = sf as unknown as Record<string, unknown>;
    for (const key of PICTURE_KEYS) {
      if (defaults[key] !== undefined) target[key] = resetKnownValues(target[key], defaults[key]);
    }
    // These are dynamic dictionaries/optional calibration structures. The
    // bundled serializer does not publish them all, so reset their known data
    // explicitly rather than treating old curve/map entries as unknown keys.
    sf.distortion.curves = structuredClone(defaults.distortion.curves);
    if (sf.distortion.map || defaults.distortion.map) {
      sf.distortion.map = { ...(sf.distortion.map ?? {}),
        ...structuredClone(defaults.distortion.map ?? { enable: true, cols: 0, rows: 0, left: [], right: [], source: '' }) };
    }
    if (sf.calib || defaults.calib) {
      sf.calib = { ...(sf.calib ?? {}),
        ...structuredClone(defaults.calib ?? { blackout: false, eye: -1, patternBrightness: 1, captureMode: false, pattern: -1, patternBits: 10 }) };
    }
    for (const key of ['debugRing', 'debugGrid', 'calibDot', 'swimProbe', 'overlayWarped', 'probeCapture', 'gridWorldLocked', 'gridOpaque'] as const) {
      sf.eyeGaze[key] = defaults.eyeGaze[key];
    }
    // The per-device custom shader otherwise owns Galaxy XR's color path and
    // cancels the native baseline. Do not change its other headset targets.
    if (next.customShader) next.customShader.enableForOther = false;
  }
  return next;
}
