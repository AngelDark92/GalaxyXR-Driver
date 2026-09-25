import { describe, expect, it } from 'vitest';
import { driverDefaults } from './driver-defaults';
import { baselineRequested, changePictureMode, imageEnhancementsEnabled } from './image-mode';
import type { Settings } from './types';

const pictureDefaults = driverDefaults.streamFrame!;

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

describe('SDR 10-bit image enhancement consent', () => {
  it('keeps legacy overlapping flags blocked without changing saved tuning', () => {
    const settings = tunedSettings();
    settings.streamFrame!.enable = true;
    delete settings.galaxyXr!.sdr10AllowEnhancements;
    const before = structuredClone(settings);

    expect(baselineRequested(settings)).toBe(true);
    expect(imageEnhancementsEnabled(settings)).toBe(false);
    expect(settings).toEqual(before);
  });

  it('requires explicit acceptance before enabling enhancements with the baseline', () => {
    const settings = tunedSettings();
    const before = structuredClone(settings);

    expect(changePictureMode(settings, pictureDefaults, 'enhancements', true)).toBeUndefined();
    expect(changePictureMode(settings, pictureDefaults, 'enhancements', true, false)).toBeUndefined();
    expect(settings).toEqual(before);
  });

  it('allows confirmed enhancements while retaining the baseline and all tuning', () => {
    const settings = tunedSettings();
    const before = structuredClone(settings);
    const next = changePictureMode(settings, pictureDefaults, 'enhancements', true, true)!;

    expect(baselineRequested(next)).toBe(true);
    expect(imageEnhancementsEnabled(next)).toBe(true);
    expect(next.galaxyXr!.sdr10AllowEnhancements).toBe(true);
    expect(next.streamFrame).toEqual({ ...before.streamFrame, enable: true });
    expect(next.controllers).toEqual(before.controllers);
    expect(next.customShader).toEqual(before.customShader);
    expect(settings).toEqual(before);
  });

  it('retains confirmed access after saving and reopening settings', () => {
    const next = changePictureMode(tunedSettings(), pictureDefaults, 'enhancements', true, true)!;
    const reopened = JSON.parse(JSON.stringify(next)) as Settings;

    expect(imageEnhancementsEnabled(reopened)).toBe(true);
    expect(baselineRequested(reopened)).toBe(true);
  });

  it('turns enhancements off without losing baseline or tuning and clears consent', () => {
    const enabled = changePictureMode(tunedSettings(), pictureDefaults, 'enhancements', true, true)!;
    const before = structuredClone(enabled);
    const next = changePictureMode(enabled, pictureDefaults, 'enhancements', false)!;

    expect(imageEnhancementsEnabled(next)).toBe(false);
    expect(baselineRequested(next)).toBe(true);
    expect(next.galaxyXr!.sdr10AllowEnhancements).toBe(false);
    expect(next.streamFrame).toEqual({ ...before.streamFrame, enable: false });
    expect(changePictureMode(next, pictureDefaults, 'enhancements', true)).toBeUndefined();
    expect(enabled).toEqual(before);
  });

  it('does not treat consent alone as an enabled enhancement pipeline', () => {
    const settings = tunedSettings();
    settings.galaxyXr!.sdr10AllowEnhancements = true;

    expect(imageEnhancementsEnabled(settings)).toBe(false);
  });

  it('leaving the baseline clears consent and does not silently enable enhancements', () => {
    const enabled = changePictureMode(tunedSettings(), pictureDefaults, 'enhancements', true, true)!;
    const next = changePictureMode(enabled, pictureDefaults, 'baseline', false)!;

    expect(baselineRequested(next)).toBe(false);
    expect(imageEnhancementsEnabled(next)).toBe(false);
    expect(next.galaxyXr!.sdr10AllowEnhancements).toBe(false);
    expect(next.streamFrame).toEqual({ ...enabled.streamFrame, enable: false });
  });

  it('enabling the baseline resets picture settings and old consent but preserves unrelated tuning', () => {
    const settings = tunedSettings(false);
    settings.galaxyXr!.sdr10AllowEnhancements = true;
    settings.customShader!.enableForOther = true;
    const before = structuredClone(settings);
    const next = changePictureMode(settings, pictureDefaults, 'baseline', true)!;

    expect(baselineRequested(next)).toBe(true);
    expect(imageEnhancementsEnabled(next)).toBe(false);
    expect(next.galaxyXr!.sdr10AllowEnhancements).toBe(false);
    expect(next.streamFrame!.brightness).toBe(pictureDefaults.brightness);
    expect(next.streamFrame!.cas).toEqual(pictureDefaults.cas);
    expect(next.streamFrame!.nvencBitrateMbit).toBe(175);
    expect(next.streamFrame!.kalmanProcessAccel).toBe(3.5);
    expect(next.controllers).toEqual(before.controllers);
    expect(next.customShader!.enableForOther).toBe(false);
    expect(settings).toEqual(before);
  });

  it('retains normal enhancement switching outside the baseline', () => {
    const settings = tunedSettings(false);
    const next = changePictureMode(settings, pictureDefaults, 'enhancements', true)!;

    expect(imageEnhancementsEnabled(next)).toBe(true);
    expect(baselineRequested(next)).toBe(false);
    expect(next.galaxyXr!.sdr10AllowEnhancements).toBe(false);
    expect(next.streamFrame).toEqual({ ...settings.streamFrame, enable: true });
    const disabled = changePictureMode(next, pictureDefaults, 'enhancements', false)!;
    expect(imageEnhancementsEnabled(disabled)).toBe(false);
    expect(disabled.streamFrame).toEqual(settings.streamFrame);
  });

  it('keeps baseline activation blocked while ordinary enhancements are enabled', () => {
    const settings = tunedSettings(false);
    settings.streamFrame!.enable = true;
    const before = structuredClone(settings);

    expect(changePictureMode(settings, pictureDefaults, 'baseline', true)).toBeUndefined();
    expect(settings).toEqual(before);
  });

  it('cannot enable either mode without loaded driver settings', () => {
    const withoutStreamFrame = structuredClone(driverDefaults);
    delete withoutStreamFrame.streamFrame;
    expect(changePictureMode(undefined, pictureDefaults, 'enhancements', true, true)).toBeUndefined();
    expect(changePictureMode(withoutStreamFrame, pictureDefaults, 'baseline', true)).toBeUndefined();
    expect(imageEnhancementsEnabled(undefined)).toBe(false);
  });
});
