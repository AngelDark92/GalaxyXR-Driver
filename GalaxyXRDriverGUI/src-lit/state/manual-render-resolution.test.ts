import { describe, expect, it } from 'vitest';
import { GalaxySettingsBase, renderLongEdge, scaleRenderResolution } from './galaxy-settings';
import { driverDefaults } from '../domain/driver-defaults';

function state(galaxyXr: Record<string, unknown>, app: Record<string, unknown> = { advanceMode: false }) {
  const stored = structuredClone(driverDefaults);
  stored.galaxyXr = galaxyXr as any;
  const gs = new GalaxySettingsBase(
    { values: () => app } as any,
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
  it('clears a stored-value error when a reload supplies valid dimensions', () => {
    const gs = state({ nativeIdentity: true, renderWidth: 0, renderHeight: -1 });
    expect(gs.galaxyXr.renderWidth).toBe(0);
    expect(gs.renderResolutionError()).toBeTruthy();
    gs.galaxyXr.renderWidth = 3552;
    gs.galaxyXr.renderHeight = 3840;
    expect(gs.galaxyXr.renderWidth).toBe(3552);
    expect(gs.renderResolutionError()).toBeUndefined();
  });
  it('keeps a rejected edit error across getter reads until corrected', () => {
    const gs = state({ nativeIdentity: true, renderWidth: 2880, renderHeight: 3200 });
    gs.setRenderDimension('renderWidth', 0);
    expect(gs.renderResolutionError()).toBeTruthy();
    expect(gs.galaxyXr.renderWidth).toBe(2880);
    expect(gs.renderResolutionError()).toBeTruthy();
    gs.setRenderDimension('renderWidth', 2880);
    expect(gs.renderResolutionError()).toBeUndefined();
  });
  it('accepts both range boundaries independently', () => {
    const gs = state({ nativeIdentity: true });
    gs.setRenderDimension('renderWidth', 1);
    gs.setRenderDimension('renderHeight', 16384);
    expect(gs.galaxyXr.renderWidth).toBe(1);
    expect(gs.galaxyXr.renderHeight).toBe(16384);
  });
});

describe('linked render resolution', () => {
  it('defaults the slider link on and respects a saved Off', () => {
    expect(state({ nativeIdentity: true }).renderResolutionLinked).toBe(true);
    expect(state({ nativeIdentity: true }, { advanceMode: false, renderResolutionLinked: false })
      .renderResolutionLinked).toBe(false);
  });

  it('reports the long edge only for a valid pair', () => {
    expect(renderLongEdge(3552, 3840)).toBe(3840);
    expect(renderLongEdge(3840, 3552)).toBe(3840);
    expect(renderLongEdge(0, 3840)).toBeUndefined();
    expect(renderLongEdge(3552, 3000.5)).toBeUndefined();
  });

  it('scales both axes by the current ratio and keeps the orientation', () => {
    expect(scaleRenderResolution(3552, 3840, 4096)).toEqual({ width: 3789, height: 4096 });
    expect(scaleRenderResolution(3840, 3552, 4096)).toEqual({ width: 4096, height: 3789 });
    expect(scaleRenderResolution(3000, 3000, 4000)).toEqual({ width: 4000, height: 4000 });
    expect(scaleRenderResolution(1, 16384, 8192)).toEqual({ width: 1, height: 8192 });
    expect(scaleRenderResolution(3552, 3840, 0)).toBeUndefined();
    expect(scaleRenderResolution(3552, 3840, 16385)).toBeUndefined();
  });

  it('writes both axes from the linked long edge', () => {
    const gs = state({ nativeIdentity: true, renderWidth: 3552, renderHeight: 3840 });
    gs.setRenderResolutionLongEdge(4096);
    expect(gs.galaxyXr.renderWidth).toBe(3789);
    expect(gs.galaxyXr.renderHeight).toBe(4096);
    expect(gs.renderResolutionError()).toBeUndefined();
  });

  it('keeps the 8192 slider band inside the native 16384 bound', () => {
    const atSliderMax = state({ nativeIdentity: true, renderWidth: 3552, renderHeight: 3840 });
    atSliderMax.setRenderResolutionLongEdge(8192);
    expect(atSliderMax.galaxyXr.renderWidth).toBe(7578);
    expect(atSliderMax.galaxyXr.renderHeight).toBe(8192);

    const aboveSlider = state({ nativeIdentity: true, renderWidth: 3552, renderHeight: 3840 });
    aboveSlider.setRenderResolutionLongEdge(12000);
    expect(aboveSlider.galaxyXr.renderWidth).toBe(11100);
    expect(aboveSlider.galaxyXr.renderHeight).toBe(12000);
  });

  it('refuses a bad long edge and an invalid stored pair without rewriting', () => {
    const gs = state({ nativeIdentity: true, renderWidth: 3552, renderHeight: 3840 });
    gs.setRenderResolutionLongEdge(0);
    expect(gs.galaxyXr.renderWidth).toBe(3552);
    expect(gs.galaxyXr.renderHeight).toBe(3840);
    expect(gs.renderResolutionError()).toBeTruthy();

    const stored = state({ nativeIdentity: true, renderWidth: 0, renderHeight: 3840 });
    stored.setRenderResolutionLongEdge(4096);
    expect(stored.galaxyXr.renderWidth).toBe(0);
    expect(stored.galaxyXr.renderHeight).toBe(3840);
    expect(stored.renderResolutionError()).toBeTruthy();
  });

  it('resets the linked pair to the native default regardless of the current ratio', () => {
    const gs = state({ nativeIdentity: true, renderWidth: 5051, renderHeight: 5459 });
    gs.resetRenderResolution();
    expect(gs.galaxyXr.renderWidth).toBe(3552);
    expect(gs.galaxyXr.renderHeight).toBe(3840);
    expect(gs.renderResolutionError()).toBeUndefined();
  });

  it('repairs a stored invalid pair on reset', () => {
    const gs = state({ nativeIdentity: true, renderWidth: 0, renderHeight: -1 });
    expect(gs.galaxyXr.renderWidth).toBe(0);
    expect(gs.renderResolutionError()).toBeTruthy();
    gs.resetRenderResolution();
    expect(gs.galaxyXr.renderWidth).toBe(3552);
    expect(gs.galaxyXr.renderHeight).toBe(3840);
    expect(gs.renderResolutionError()).toBeUndefined();
  });
});
