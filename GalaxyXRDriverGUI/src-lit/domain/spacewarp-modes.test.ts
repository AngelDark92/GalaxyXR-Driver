import { describe, expect, it } from 'vitest';
import {
  FORCE_HALF_RATE_MODE,
  isForcedHalfRate,
  modeForForceSwitch,
  spacewarpModeLabel,
  spacewarpPublication,
} from './spacewarp-modes';

describe('Async Spacewarp mode semantics (2026-10-26)', () => {
  it('maps the Force half-rate switch to the saved 0/1 value', () => {
    expect(FORCE_HALF_RATE_MODE).toBe(1);
    expect(modeForForceSwitch(true)).toBe(1);
    expect(modeForForceSwitch(false)).toBe(0);
  });

  it('treats 0 and unknown stored values as Automatic, 1 as Forced', () => {
    expect(isForcedHalfRate(0)).toBe(false);
    expect(isForcedHalfRate(1)).toBe(true);
    expect(isForcedHalfRate(2)).toBe(false); // unknown applies as Automatic, value untouched
    expect(isForcedHalfRate(-1)).toBe(false);
    expect(spacewarpModeLabel(0)).toBe('Automatic');
    expect(spacewarpModeLabel(1)).toBe('Force half-rate');
    expect(spacewarpModeLabel(7)).toBe('Automatic');
  });

  it('never rounds or coerces a value through the switch round trip', () => {
    for (const mode of [0, 1]) {
      expect(modeForForceSwitch(isForcedHalfRate(mode))).toBe(mode);
    }
  });

  it('shows the last confirmed carrier when a mode transition fails', () => {
    expect(spacewarpPublication({ published: true, publishedValue: 1, effectiveMode: 2 }))
      .toEqual({ mode: 'late', pending: true });
    expect(spacewarpPublication({ published: true, publishedValue: 2, effectiveMode: 1 }))
      .toEqual({ mode: 'half', pending: true });
    expect(spacewarpPublication({ published: true, publishedValue: 2, effectiveMode: 2 }))
      .toEqual({ mode: 'half', pending: false });
  });

  it('does not infer a delivered mode from an unpublished or legacy report', () => {
    expect(spacewarpPublication({ published: false, publishedValue: 2, effectiveMode: 2 }))
      .toEqual({ mode: 'unknown', pending: true });
    expect(spacewarpPublication({ published: true })).toEqual({ mode: 'unknown', pending: false });
    expect(spacewarpPublication()).toEqual({ mode: 'unknown', pending: false });
  });
});
