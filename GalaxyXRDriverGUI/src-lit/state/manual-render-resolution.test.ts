import { describe, expect, it } from 'vitest';
import { GalaxySettingsBase } from './galaxy-settings';
import { driverDefaults } from '../domain/driver-defaults';

function state(galaxyXr: Record<string, unknown>) {
  const stored = structuredClone(driverDefaults);
  stored.galaxyXr = galaxyXr as any;
  const gs = new GalaxySettingsBase(
    { values: () => ({ advanceMode: false }) } as any,
    { values: () => stored, save: () => true } as any,
    { values: () => undefined } as any);
  return gs;
}

describe('manual render resolution', () => {
  it.each([true, false])('retains legacy enabled=%s with native dimensions', enabled => {
    const gs = state({ nativeIdentity: true, nativeResolution: enabled });
    expect(gs.galaxyXr.nativeResolution).toBe(enabled);
    expect(gs.galaxyXr.renderWidth).toBe(3552);
    expect(gs.galaxyXr.renderHeight).toBe(3840);
  });
  it('preserves custom dimensions even when disabled and on reopening', () => {
    const gs = state({ nativeIdentity: true, nativeResolution: false, renderWidth: 2880, renderHeight: 3200 });
    gs.setRenderDimension('renderWidth', 4096);
    const reopened = state(JSON.parse(JSON.stringify(gs.galaxyXr)));
    expect(reopened.galaxyXr.renderWidth).toBe(4096);
    expect(reopened.galaxyXr.renderHeight).toBe(3200);
    expect(reopened.galaxyXr.nativeResolution).toBe(false);
  });
  it.each([undefined, NaN, Infinity, 0, -5, 16385, 3000.5])('ignores invalid edits: %s', value => {
    const gs = state({ nativeIdentity: true, renderWidth: 2880, renderHeight: 3200 });
    gs.setRenderDimension('renderWidth', value);
    expect(gs.galaxyXr.renderWidth).toBe(2880);
    expect(gs.galaxyXr.renderHeight).toBe(3200);
    expect(gs.renderResolutionError()).toBeTruthy();
  });
  it.each([null, '4096', 4096.5, 0, -1, 16385])('preserves and reports invalid stored values: %s', value => {
    const gs = state({ nativeIdentity: true, renderWidth: value, renderHeight: value });
    expect(gs.galaxyXr.renderWidth).toBe(value);
    expect(gs.galaxyXr.renderHeight).toBe(value);
    expect(gs.renderResolutionError()).toBeTruthy();
  });
  it('clears stored-value errors only after both axes are corrected', () => {
    const gs = state({ nativeIdentity: true, renderWidth: 0, renderHeight: -1 });
    gs.setRenderDimension('renderWidth', 5376);
    expect(gs.renderResolutionError()).toBeTruthy();
    gs.setRenderDimension('renderHeight', 4973);
    expect(gs.renderResolutionError()).toBeUndefined();
    expect(gs.galaxyXr.renderWidth).toBe(5376);
    expect(gs.galaxyXr.renderHeight).toBe(4973);
  });
  it('accepts both range boundaries independently', () => {
    const gs = state({ nativeIdentity: true });
    gs.setRenderDimension('renderWidth', 1);
    gs.setRenderDimension('renderHeight', 16384);
    expect(gs.galaxyXr.renderWidth).toBe(1);
    expect(gs.galaxyXr.renderHeight).toBe(16384);
  });
});
