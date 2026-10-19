import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeOfxrPreferences, ofxrCanArm, ofxrDefaults, ofxrDisabledReason } from './ofxr';
import { deepCopy, deepMerge } from './pure';
import type { OfxrPreferences, OfxrStatus } from './types';

const status = (state: OfxrStatus['state'], reason: string | null = null): OfxrStatus =>
  ({ state, version: null, runtimeDir: null, reason, versions: [] });

describe('OFRX preferences', () => {
  it('fills every missing field from the pinned defaults', () => {
    expect(normalizeOfxrPreferences(undefined)).toEqual(ofxrDefaults);
    expect(normalizeOfxrPreferences(null)).toEqual(ofxrDefaults);
    expect(normalizeOfxrPreferences({ enabled: true })).toEqual({ ...ofxrDefaults, enabled: true });
  });

  it('keeps every valid pinned value and rounds only out-of-contract log sizes', () => {
    const full: OfxrPreferences = {
      enabled: true, version: '116', mode: 'nvidia-slow', scale: 100, bidirectional: true,
      logging: true, maxLogMb: 512, flushEachEvent: true, overlay: 'lower-right',
    };
    expect(normalizeOfxrPreferences(full)).toEqual(full);
    // The IPC carries maxLogMb as u32; an out-of-contract stored value is
    // rounded into the row's 1-512 contract so arm/apply cannot brick.
    expect(normalizeOfxrPreferences({ maxLogMb: 0 }).maxLogMb).toBe(1);
    expect(normalizeOfxrPreferences({ maxLogMb: 9999 }).maxLogMb).toBe(512);
    expect(normalizeOfxrPreferences({ maxLogMb: 63.6 }).maxLogMb).toBe(64);
  });

  it('replaces values outside the pinned enums with defaults instead of coercing them', () => {
    const dirty = { mode: 'nvidia', scale: 60, overlay: 'center' } as unknown as Partial<OfxrPreferences>;
    expect(normalizeOfxrPreferences(dirty)).toMatchObject({ mode: 'fidelityfx', scale: 50, overlay: 'off' });
  });

  it('fills the nested ofxr block when an older gui-settings.json only has a few keys', () => {
    // JsonSettingServiceBase.loadSetting merges deepCopy(defaults) with the
    // parsed file; this is the exact path that must not hide the block.
    const merged = deepMerge(deepCopy({ ofxr: { ...ofxrDefaults } }), { ofxr: { enabled: true } } as any);
    expect(merged.ofxr).toEqual({ ...ofxrDefaults, enabled: true });
  });

  it('keeps appDefaults.ofxr in lockstep with the pinned defaults', () => {
    // The brief pins the defaults in app-setting.ts; the domain fallback must
    // not drift from them (a silent default change would arm the wrong mode).
    const source = readFileSync(new URL('../services/app-setting.ts', import.meta.url), 'utf8');
    for (const [key, value] of Object.entries(ofxrDefaults)) {
      const literal = typeof value === 'string' ? `'${value}'` : String(value);
      expect(source).toContain(`${key}: ${literal}`);
    }
  });
});

describe('OFRX status gate', () => {
  it('permits arming only in the ready and armed states', () => {
    for (const state of ['ready', 'armed', 'armed_external'] as const) expect(ofxrCanArm(status(state))).toBe(true);
    for (const state of ['not_installed', 'unavailable'] as const) expect(ofxrCanArm(status(state))).toBe(false);
    expect(ofxrCanArm(undefined)).toBe(false);
  });

  it('keeps the component-provided reason and falls back to a readable one', () => {
    expect(ofxrDisabledReason(status('not_installed', 'pinned release missing'))).toBe('pinned release missing');
    expect(ofxrDisabledReason(status('not_installed'))).toMatch(/not installed/);
    expect(ofxrDisabledReason(status('unavailable'))).toMatch(/unavailable/);
    expect(ofxrDisabledReason(undefined)).toMatch(/Checking/);
    expect(ofxrDisabledReason(status('ready'))).toBeUndefined();
  });
});
