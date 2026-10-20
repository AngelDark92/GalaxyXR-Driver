import { describe, expect, it } from 'vitest';
import { normalizeUiScale, UI_SCALE_DEFAULT, UI_SCALE_MAX, UI_SCALE_MIN, uiScaleZoom } from './ui-scale';

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

describe('uiScaleZoom', () => {
  it('maps the 100% label to the 90% baseline', () => {
    expect(uiScaleZoom(100)).toBeCloseTo(0.9, 10);
  });

  it('maps the default and non-numeric input to the baseline', () => {
    expect(uiScaleZoom(UI_SCALE_DEFAULT)).toBeCloseTo(0.9, 10);
    expect(uiScaleZoom(undefined)).toBeCloseTo(0.9, 10);
    expect(uiScaleZoom('large')).toBeCloseTo(0.9, 10);
  });

  it('keeps the minimum above the native 0.25 floor', () => {
    expect(uiScaleZoom(30)).toBeCloseTo(0.27, 10);
  });

  it('scales the maximum label', () => {
    expect(uiScaleZoom(150)).toBeCloseTo(1.35, 10);
  });

  it('snaps to the slider step before applying the baseline', () => {
    expect(uiScaleZoom(112)).toBeCloseTo(0.99, 10);
  });
});
