import { describe, expect, it } from 'vitest';
import { codecSwitchState } from './codec-selection';

const now = 20_000;
const report = (steamvrRunning: boolean, checkedAt = now - 1000) => ({ steamvrRunning, checkedAt });

describe('codec switch gate (2026-10-19)', () => {
  it('reports a running runtime as running', () => {
    expect(codecSwitchState(report(true), now)).toBe('running');
    // Running wins even when the report itself is stale.
    expect(codecSwitchState(report(true, now - 60_000), now)).toBe('running');
  });
  it('never treats a missing report as stopped', () => {
    expect(codecSwitchState(undefined, now)).toBe('unconfirmed');
  });
  it('rejects a stale stopped report', () => {
    expect(codecSwitchState(report(false, now - 5001), now)).toBe('unconfirmed');
  });
  it('rejects a future-dated stopped report beyond the clock tolerance', () => {
    expect(codecSwitchState(report(false, now + 2001), now)).toBe('unconfirmed');
  });
  it('allows a switch only on a fresh confirmed stopped runtime', () => {
    expect(codecSwitchState(report(false), now)).toBe('allowed');
    expect(codecSwitchState(report(false, now - 5000), now)).toBe('allowed');
  });
});
