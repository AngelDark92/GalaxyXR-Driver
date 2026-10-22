import { describe, expect, it } from 'vitest';
import { HALF_RATE_AVAILABLE, isRetiredModeSelection, spacewarpModeValues } from './spacewarp-modes';

describe('Half rate retirement (2026-10-21)', () => {
  it('ships with Half rate unavailable', () => {
    expect(HALF_RATE_AVAILABLE).toBe(false);
  });
  it('offers only Late frames only while Half rate is unavailable', () => {
    expect(spacewarpModeValues()).toEqual([0]);
    expect(spacewarpModeValues(false)).toEqual([0]);
    expect(spacewarpModeValues(true)).toEqual([0, 1]);
  });
  it('flags only non-zero saved modes, and only while Half rate is unavailable', () => {
    expect(isRetiredModeSelection(0)).toBe(false);
    expect(isRetiredModeSelection(1)).toBe(true);
    expect(isRetiredModeSelection(2)).toBe(true);
    expect(isRetiredModeSelection(1, false)).toBe(true);
    expect(isRetiredModeSelection(0, false)).toBe(false);
    expect(isRetiredModeSelection(1, true)).toBe(false);
    expect(isRetiredModeSelection(0, true)).toBe(false);
  });
});
