import { beforeEach, expect, it, vi } from 'vitest';
import { CurvePreviewPublisher, previewState } from './curve-preview';
import { driverDefaults } from '../domain/driver-defaults';

const bridge = vi.hoisted(() => ({ open: vi.fn(), publish: vi.fn(), listen: vi.fn(), stop: vi.fn() }));
vi.mock('../platform/tauri', () => ({ open_curve_preview: bridge.open, publish_curve_preview: bridge.publish }));
vi.mock('@tauri-apps/api/event', () => ({ listen: bridge.listen }));
beforeEach(() => {
  vi.resetAllMocks();
  bridge.open.mockResolvedValue(undefined); bridge.publish.mockResolvedValue(undefined);
  bridge.listen.mockResolvedValue(bridge.stop);
});
const initial = { curve: 1, constancyPct: 35, ceilingMbit: 450, clampMbit: 350, fallbackDisabled: false };
function fixture() {
  let state = { ...initial }, change = () => {};
  const unsubscribe = vi.fn();
  const subscribe = vi.fn(fn => { change = fn; return unsubscribe; });
  const publisher = new CurvePreviewPublisher(() => state, subscribe);
  return { publisher, subscribe, unsubscribe, edit(next: typeof initial) { state = next; change(); } };
}

it('uses effective values, ceiling precedence and preserves invalid entries for visible errors', () => {
  const settings = structuredClone(driverDefaults);
  settings.streamFrame!.nvencBitrateCurve = 99;
  settings.streamFrame!.nvencBitrateConstancyPct = 101.5;
  settings.streamFrame!.nvencVrlinkClampMbit = 0;
  settings.streamFrame!.nvencBandwidthOverrideMbit = 400;
  expect(previewState(settings)).toEqual({ curve: 99, constancyPct: 101.5, clampMbit: 0, ceilingMbit: 400, fallbackDisabled: false });
  // 2026-10-20: 'No fallback' is surfaced to the graph so it can mark the
  // fixed operating point instead of implying a live curve.
  settings.streamFrame!.nvencVrlinkFallbackMode = 1;
  expect(previewState(settings).fallbackDisabled).toBe(true);
  settings.streamFrame!.nvencVrlinkFallbackMode = 0;
  expect(previewState(settings).fallbackDisabled).toBe(false);
  settings.streamFrame!.nvencBitrateMbit = 500;
  expect(previewState(settings).ceilingMbit).toBe(500);
  settings.streamFrame!.nvencBitrateMbit = 0;
  settings.streamFrame!.nvencBandwidthOverrideMbit = 0;
  expect(previewState(settings, 300).ceilingMbit).toBe(300); // selected legacy tier, not stale custom bandwidth
  expect(previewState(settings, 0).ceilingMbit).toBe(0); // invalid explicit bandwidth must remain visible
  expect(() => previewState(undefined)).toThrow();
});
it('does no work until Open, streams only changes, and releases subscriptions on native close', async () => {
  const f = fixture();
  expect(f.subscribe).not.toHaveBeenCalled(); expect(bridge.listen).not.toHaveBeenCalled();
  await f.publisher.open('ja');
  expect(bridge.open).toHaveBeenCalledWith('ja', initial);
  f.edit({ ...initial, constancyPct: 75 }); f.edit({ ...initial, constancyPct: 75 });
  expect(bridge.publish).toHaveBeenCalledTimes(1);
  bridge.listen.mock.calls[0][1]();
  expect(f.unsubscribe).toHaveBeenCalledOnce(); expect(bridge.stop).toHaveBeenCalledOnce();
  f.edit({ ...initial, constancyPct: 80 });
  expect(bridge.publish).toHaveBeenCalledTimes(1);
  await f.publisher.open('en-US');
  expect(bridge.open).toHaveBeenCalledTimes(2);
  f.publisher.dispose();
});
it('serializes double opens and sends edits made during WebView creation after it completes', async () => {
  const f = fixture(); let finish!: () => void;
  bridge.open.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  const first = f.publisher.open('en-US'), second = f.publisher.open('en-US');
  await Promise.resolve();
  f.edit({ ...initial, curve: 2, constancyPct: 50 });
  expect(bridge.publish).not.toHaveBeenCalled();
  finish(); await Promise.all([first, second]);
  expect(bridge.open).toHaveBeenCalledOnce();
  expect(bridge.publish).toHaveBeenCalledWith({ ...initial, curve: 2, constancyPct: 50 });
  f.publisher.dispose();
});
it('cleans up a failed open so reopening can succeed', async () => {
  const f = fixture(); bridge.open.mockRejectedValueOnce(new Error('WebView creation failed'));
  await expect(f.publisher.open('en-US')).rejects.toThrow('WebView creation failed');
  expect(f.unsubscribe).toHaveBeenCalledOnce(); expect(bridge.stop).toHaveBeenCalledOnce();
  await f.publisher.open('en-US'); expect(bridge.open).toHaveBeenCalledTimes(2);
  f.publisher.dispose();
});
