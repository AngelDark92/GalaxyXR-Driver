import { describe, expect, it } from 'vitest';
import { normalizeUiScale, UI_SCALE_DEFAULT, UI_SCALE_MAX, UI_SCALE_MIN } from './ui-scale';

describe('normalizeUiScale', () => {
  it('keeps a supported percent unchanged', () => {
    expect(normalizeUiScale(100)).toBe(100);
    expect(normalizeUiScale(30)).toBe(UI_SCALE_MIN);
    expect(normalizeUiScale(150)).toBe(UI_SCALE_MAX);
  });

  it('falls back to the default for missing or non-numeric values', () => {
    expect(normalizeUiScale(undefined)).toBe(UI_SCALE_DEFAULT);
    expect(normalizeUiScale(null)).toBe(UI_SCALE_DEFAULT);
    expect(normalizeUiScale('')).toBe(UI_SCALE_DEFAULT);
    expect(normalizeUiScale('large')).toBe(UI_SCALE_DEFAULT);
    expect(normalizeUiScale(Number.NaN)).toBe(UI_SCALE_DEFAULT);
    expect(normalizeUiScale(Number.POSITIVE_INFINITY)).toBe(UI_SCALE_DEFAULT);
  });

  it('clamps a hand-edited value to the applied range', () => {
    expect(normalizeUiScale(5)).toBe(UI_SCALE_MIN);
    expect(normalizeUiScale(900)).toBe(UI_SCALE_MAX);
  });

  it('snaps to the slider step', () => {
    expect(normalizeUiScale(112)).toBe(110);
    expect(normalizeUiScale(113)).toBe(115);
    expect(normalizeUiScale('132')).toBe(130);
  });
});
