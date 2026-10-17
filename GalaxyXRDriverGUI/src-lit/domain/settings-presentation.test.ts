import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { driverDefaults } from './driver-defaults';
import { inspectBooleanSettings } from './settings-inspection';
import { classifyBoolean, presentSettings, SETTINGS_PRESENTATION, settingPresentation, settingUnavailable } from './settings-presentation';
import { setLocale } from '../locale/i18n';
import type { AppSetting } from './types';

const app: AppSetting = { advanceMode: false, colorScheme: 'dark', updateMode: 'rewrite', devUpdates: false, driverVerified: false };
const context = () => ({ settings: structuredClone(driverDefaults), app: { ...app }, driverInstalled: true, vendor: true });

describe('human-readable settings inspection', () => {
  it('classifies every bundled boolean and preserves unknown forward-compatible keys', () => {
    const checks = inspectBooleanSettings(driverDefaults, {}, 'settings.json');
    expect(checks.length).toBeGreaterThan(70);
    expect(checks.filter(check => classifyBoolean(check) === 'unknown')).toEqual([]);
    expect(classifyBoolean({ key: 'driverVerified', source: 'gui-settings.json' })).toBe('internal');
    expect(classifyBoolean({ key: 'futureFeature', source: 'settings.json' })).toBe('unknown');
  });

  it('binds every catalog entry to exactly one real field and keeps labels outside JSON paths', () => {
    const sources = ['driver-settings', 'stream-frame', 'debug', 'distortion-profile', 'app-settings'].map(route =>
      readFileSync(new URL(`../features/${route}-page.ts`, import.meta.url), 'utf8')).join('\n');
    const ids = [...sources.matchAll(/settingFieldRow\('([^']+)'/g)].map(match => match[1]);
    expect(new Set(SETTINGS_PRESENTATION.map(setting => setting.id)).size).toBe(SETTINGS_PRESENTATION.length);
    expect(ids.sort()).toEqual(SETTINGS_PRESENTATION.map(setting => setting.id).sort());
    const rows = presentSettings([], context());
    expect(rows.find(row => row.id === 'streamFrame.nvencForceCbr')?.location)
      .toEqual(['Image Settings', 'Encoder Advanced', 'Force Constant Bitrate']);
    expect(rows.every(row => !row.location.join(' ').includes('.json'))).toBe(true);
  });

  it('uses effective Image Enhancements consent and compound CAS mode without changing saved values', () => {
    const c = context();
    c.settings.streamFrame!.enable = true;
    c.settings.galaxyXr!.sdr10Baseline = true;
    c.settings.galaxyXr!.sdr10AllowEnhancements = false;
    const before = structuredClone(c);
    let rows = presentSettings([], c);
    expect(rows.find(row => row.id === 'image-enhancements')?.state).toBe('Off');
    expect(c).toEqual(before);
    c.settings.galaxyXr!.sdr10AllowEnhancements = true;
    rows = presentSettings([], c);
    expect(rows.find(row => row.id === 'image-enhancements')?.state).toBe('On');
    expect(rows.find(row => row.id === 'cas-sharpening')?.state).toBe('Post-pack');
    c.settings.streamFrame!.postPack.casEnable = false;
    c.settings.streamFrame!.cas.enable = true;
    expect(presentSettings([], c).find(row => row.id === 'cas-sharpening')?.state).toBe('Pre-encode');
    c.settings.streamFrame!.cas.enable = false;
    expect(presentSettings([], c).find(row => row.id === 'cas-sharpening')?.state).toBe('Off');
  });

  it('reports unreadable sources as Unknown and distinguishes mixed origins', () => {
    const unknown = presentSettings([], { driverInstalled: true, vendor: true });
    expect(unknown.every(row => row.state === 'Unknown' && row.origin === 'unknown')).toBe(true);
    const c = context();
    const checks = inspectBooleanSettings(c.settings, { streamFrame: { enable: false } }, 'settings.json');
    expect(presentSettings(checks, c).find(row => row.id === 'image-enhancements')?.origin).toBe('mixed');
    expect(presentSettings(checks, c).find(row => row.id === 'streamFrame.nvencTap')?.origin).toBe('default');
    expect(presentSettings([], { ...c, settings: undefined }).find(row => row.id === 'advanceMode')?.state).toBe('Off');
  });

  it('keeps unavailable modes explanatory and never enables their prerequisites', () => {
    const c = context();
    const reason = (id: string) => settingUnavailable(settingPresentation(id)!, c);
    const before = structuredClone(c);
    expect(reason('streamFrame.dither')).toMatch(/Image Enhancements is off/);
    expect(reason('streamFrame.kalmanGripEnable')).toMatch(/Retired experiments/);
    expect(reason('galaxyXr.synthesizeGripTouch')).toMatch(/Official Controller Layout is off/);
    expect(c).toEqual(before);
    c.settings.streamFrame!.enable = true;
    expect(reason('streamFrame.distortion.tune.forceGrid')).toMatch(/Interactive Tuner is off/);
    c.settings.streamFrame!.distortion.tune.enable = true;
    expect(reason('streamFrame.eyeGaze.debugGrid')).toMatch(/Force Calibration Grid/);
    c.settings.streamFrame!.distortion.tune.forceGrid = false;
    expect(reason('streamFrame.eyeGaze.debugGrid')).toBeUndefined();
    // the codec selector is encoder-gated: with the tap off it is inert
    c.settings.streamFrame!.nvencTap = true;
    expect(reason('streamFrame.nvencCodec')).toBeUndefined();
    c.settings.streamFrame!.nvencTap = false;
    expect(reason('streamFrame.nvencCodec')).toMatch(/NVENC Tap is off/);
    c.settings.streamFrame!.nvencTap = true;
    c.driverInstalled = false;
    expect(reason('streamFrame.nvencTap')).toMatch(/Install the driver/);
    expect(reason('advanceMode')).toBeUndefined();
  });

  it('removes the retired filler-data switch from catalog, page source and catalog strings', () => {
    // Owner directive 2026-10-16: the nvencFillerDataInsertion knob is gone
    // from the GUI entirely; reintroducing any of these would silently
    // resurrect a switched-off knob. The DriverInfo evidence type and the
    // page's evidence row lost their filler segment with it.
    const catalogText = readFileSync(new URL('./settings-presentation.ts', import.meta.url), 'utf8');
    const pageText = readFileSync(new URL('../features/stream-frame-page.ts', import.meta.url), 'utf8');
    const defaultsText = readFileSync(new URL('./driver-defaults.ts', import.meta.url), 'utf8');
    const typesText = readFileSync(new URL('./types.ts', import.meta.url), 'utf8');
    const xlf = readFileSync(new URL('../../src/locale/messages.xlf', import.meta.url), 'utf8');
    for (const text of [catalogText, pageText, defaultsText, typesText, xlf]) {
      expect(text.includes('nvencFillerDataInsertion')).toBe(false);
      expect(text.includes('Filler')).toBe(false);
      expect(text.includes('filler')).toBe(false);
    }
    expect(SETTINGS_PRESENTATION.some(setting => setting.id.includes('Filler'))).toBe(false);
  });

  it('keeps target IDs stable when the display locale changes', () => {
    const c = context();
    c.settings.streamFrame!.nvencH264Aud = false;
    const saved = structuredClone(c.settings);
    for (const codec of [0, 2]) {
      c.settings.streamFrame!.nvencCodec = codec;
      expect(settingUnavailable(settingPresentation('streamFrame.nvencH264Aud')!, c)).toMatch(/Select H.264/);
    }
    c.settings.streamFrame!.nvencCodec = 1;
    expect(settingUnavailable(settingPresentation('streamFrame.nvencH264Aud')!, c)).toBeUndefined();
    expect(c.settings.streamFrame!.nvencH264Aud).toBe(saved.streamFrame!.nvencH264Aud);
    const before = presentSettings([], context()).map(row => row.href);
    setLocale('ja', { 'Image Settings': '画像', 'Force Constant Bitrate': '固定レート' });
    try { expect(presentSettings([], context()).map(row => row.href)).toEqual(before); }
    finally { setLocale('en-US', {}); }
  });

  it('keeps Debug links gated independently of Advanced Mode and reports saved selections', () => {
    const c = context();
    c.settings.streamFrame!.poseLogging = true;
    const before = structuredClone(c.settings);
    const setting = settingPresentation('streamFrame.poseLogging')!;
    expect(setting.route).toBe('debug');
    expect(setting.advanced).toBe(false);
    expect(settingUnavailable(setting, c)).toMatch(/Enable Debug Mode/);
    const row = presentSettings([], c).find(row => row.id === setting.id)!;
    expect(row.location).toEqual(['Debug', 'Controllers', 'Diagnostics', 'Motion Logging']);
    expect(row.state).toBe('On');
    expect(row.unavailableReason).toMatch(/Enable Debug Mode/);
    expect(c.settings).toEqual(before);
    c.settings.debugMode = true;
    expect(settingUnavailable(setting, c)).toBeUndefined();
    c.settings.streamFrame!.nvencTap = false;
    expect(settingUnavailable(settingPresentation('streamFrame.nvencVerbose')!, c)).toMatch(/NVENC Tap is off/);
  });
});
