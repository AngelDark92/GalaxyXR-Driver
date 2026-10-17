import { describe, expect, it } from 'vitest';
import { driverDefaults } from './driver-defaults';
import { baselineRequested, changePictureMode, imageEnhancementsEnabled } from './image-mode';
import type { Settings } from './types';

function tunedSettings(baseline = true): Settings {
  const settings = structuredClone(driverDefaults);
  settings.galaxyXr = { ...settings.galaxyXr!, sdr10Baseline: baseline, sdr10AllowEnhancements: false };
  settings.streamFrame!.enable = false;
  settings.streamFrame!.brightness = 0.73;
  settings.streamFrame!.cas.enable = true;
  settings.streamFrame!.nvencBitrateMbit = 175;
  settings.streamFrame!.kalmanProcessAccel = 3.5;
  return settings;
}

describe('Image Enhancements and the SDR 10-bit baseline are independent (2026-10-17)', () => {
  it('reads the master from streamFrame.enable alone and ignores the retired consent key', () => {
    const settings = tunedSettings();
    settings.streamFrame!.enable = true;
    settings.galaxyXr!.sdr10AllowEnhancements = false;
    expect(baselineRequested(settings)).toBe(true);
    expect(imageEnhancementsEnabled(settings)).toBe(true);

    settings.galaxyXr!.sdr10AllowEnhancements = true;
    expect(imageEnhancementsEnabled(settings)).toBe(true);

    settings.streamFrame!.enable = false;
    expect(imageEnhancementsEnabled(settings)).toBe(false);
  });

  it('enabling enhancements under the baseline succeeds with no warning and writes only the master', () => {
    const settings = tunedSettings();
    const before = structuredClone(settings);
    const next = changePictureMode(settings, 'enhancements', true)!;

    expect(baselineRequested(next)).toBe(true);
    expect(imageEnhancementsEnabled(next)).toBe(true);
    expect(next.streamFrame).toEqual({ ...before.streamFrame, enable: true });
    expect(next.galaxyXr).toEqual(before.galaxyXr);
    expect(next.controllers).toEqual(before.controllers);
    expect(next.customShader).toEqual(before.customShader);
    expect(settings).toEqual(before);
  });

  it('keeps both switches enabled across a save-and-reopen round trip', () => {
    const next = changePictureMode(tunedSettings(), 'enhancements', true)!;
    const reopened = JSON.parse(JSON.stringify(next)) as Settings;

    expect(imageEnhancementsEnabled(reopened)).toBe(true);
    expect(baselineRequested(reopened)).toBe(true);
  });

  it('turns enhancements off without touching baseline values or tuning, and re-enables without renewed consent', () => {
    const enabled = changePictureMode(tunedSettings(), 'enhancements', true)!;
    const before = structuredClone(enabled);
    const next = changePictureMode(enabled, 'enhancements', false)!;

    expect(imageEnhancementsEnabled(next)).toBe(false);
    expect(baselineRequested(next)).toBe(true);
    expect(next.galaxyXr).toEqual(before.galaxyXr);
    expect(next.streamFrame).toEqual({ ...before.streamFrame, enable: false });
    expect(enabled).toEqual(before);

    const again = changePictureMode(next, 'enhancements', true)!;
    expect(imageEnhancementsEnabled(again)).toBe(true);
    expect(baselineRequested(again)).toBe(true);
  });

  it('enabling the baseline under an enabled master succeeds in one write and never rewrites the capability request', () => {
    const settings = tunedSettings(false);
    settings.streamFrame!.enable = true;
    settings.galaxyXr!.profileSupports10bit = true; // explicit capability request stays user-owned
    const before = structuredClone(settings);
    const next = changePictureMode(settings, 'baseline', true)!;

    expect(baselineRequested(next)).toBe(true);
    expect(imageEnhancementsEnabled(next)).toBe(true);
    expect(next.streamFrame).toEqual(before.streamFrame);
    expect(next.galaxyXr!.sdr10Baseline).toBe(true);
    expect(next.galaxyXr!.profileSupports10bit).toBe(true);
    expect(next.galaxyXr!.sdr10AllowEnhancements).toBe(before.galaxyXr!.sdr10AllowEnhancements);
    expect(next.controllers).toEqual(before.controllers);
    expect(settings).toEqual(before);
  });

  it('enabling the baseline never resets picture values and clears the custom shader target for this headset', () => {
    const settings = tunedSettings(false);
    settings.customShader!.enableForOther = true;
    const before = structuredClone(settings);
    const next = changePictureMode(settings, 'baseline', true)!;

    expect(baselineRequested(next)).toBe(true);
    expect(next.streamFrame).toEqual(before.streamFrame);
    expect(next.streamFrame!.brightness).toBe(0.73);
    expect(next.streamFrame!.cas).toEqual(before.streamFrame!.cas);
    expect(next.streamFrame!.nvencBitrateMbit).toBe(175);
    expect(next.streamFrame!.kalmanProcessAccel).toBe(3.5);
    expect(next.customShader!.enableForOther).toBe(false);
    expect(settings).toEqual(before);
  });

  it('disabling the baseline writes sdr10Baseline false plus the capability-off write and leaves the master untouched', () => {
    const settings = tunedSettings();
    settings.streamFrame!.enable = true;
    settings.galaxyXr!.profileSupports10bit = true; // non-default: the disable write must clear it
    const next = changePictureMode(settings, 'baseline', false)!;

    expect(baselineRequested(next)).toBe(false);
    expect(imageEnhancementsEnabled(next)).toBe(true);
    expect(next.streamFrame).toEqual(settings.streamFrame);
    expect(next.galaxyXr!.sdr10Baseline).toBe(false);
    expect(next.galaxyXr!.profileSupports10bit).toBe(false);
  });

  it('cannot change a mode without loaded driver settings', () => {
    const withoutStreamFrame = structuredClone(driverDefaults);
    delete withoutStreamFrame.streamFrame;
    expect(changePictureMode(undefined, 'enhancements', true)).toBeUndefined();
    expect(changePictureMode(withoutStreamFrame, 'baseline', true)).toBeUndefined();
    expect(imageEnhancementsEnabled(undefined)).toBe(false);
  });
});
