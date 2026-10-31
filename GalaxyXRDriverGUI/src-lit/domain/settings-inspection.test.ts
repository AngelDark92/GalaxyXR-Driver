import { describe, expect, it } from 'vitest';
import { inspectSettings } from './settings-inspection';
import { driverDefaults } from './driver-defaults';

describe('settings inspection (2026-10-30)', () => {
  it('reports stored/default origin and changed values for every JSON leaf type', () => {
    const defaults = { a: { flag: true, count: 5, list: [1, 2] }, b: false };
    const stored = { a: { flag: false, count: 5 }, b: false, extra: 7 };
    const effective = { a: { flag: false, count: 5, list: [1, 2, 3] }, b: false, extra: 7 };
    const checks = inspectSettings(effective, stored, defaults, 'settings.json');
    const byKey = Object.fromEntries(checks.map(check => [check.key, check]));
    expect(byKey['a.flag']).toMatchObject({
      kind: 'boolean', origin: 'stored', changed: true, hasDefault: true, enabled: false,
    });
    expect(byKey['a.count']).toMatchObject({
      kind: 'number', origin: 'stored', changed: false, hasDefault: true, value: 5, defaultValue: 5,
    });
    expect(byKey['a.list']).toMatchObject({
      kind: 'array', origin: 'default', changed: false, hasDefault: true, value: [1, 2, 3],
    });
    expect(byKey['extra']).toMatchObject({
      kind: 'number', origin: 'stored', changed: true, hasDefault: false, value: 7,
    });
  });

  it('finds the camera-calibration blackout default and reports its stored change', () => {
    const checks = inspectSettings(
      { streamFrame: { calib: { blackout: true } } },
      { streamFrame: { calib: { blackout: true } } },
      driverDefaults,
      'settings.json',
    );
    expect(checks.find(check => check.key === 'streamFrame.calib.blackout')).toMatchObject({
      kind: 'boolean', origin: 'stored', changed: true, hasDefault: true, enabled: true,
    });
  });
});
