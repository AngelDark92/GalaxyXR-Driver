// GPU capability probe lifecycle tests (2026-11-03).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GpuCapabilities } from '../domain/types';
import { GpuCapabilitiesService, GPU_PROBE_TIMEOUT_MS, GPU_REFRESH_MS } from './gpu-capabilities';
import type { DriverRuntimeStatus } from '../platform/tauri';

const bridge = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../platform/tauri', () => ({ get_gpu_capabilities: bridge.get }));

const baseCaps: GpuCapabilities = {
  adapters: [{ adapterLuid: 'luid-1', gpuName: 'Test GPU', nvenc: true }],
  checkedAt: 1000,
};

function status(overrides: Partial<DriverRuntimeStatus> = {}): DriverRuntimeStatus {
  return {
    state: 'not-running', detail: '', steamvrRunning: false, driverInitialized: false,
    headsetConnected: false, driverVersion: null, serverPid: null, checkedAt: 0,
    ...overrides,
  };
}

describe('GpuCapabilitiesService', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.resetAllMocks();
    bridge.get.mockResolvedValue(baseCaps);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts an initial refresh and exposes a ready promise', () => {
    const service = new GpuCapabilitiesService(() => status());
    expect(service.caps()).toBeUndefined();
    expect(service.error()).toBeUndefined();
    expect(service.loading()).toBe(true);
    expect(service.isFresh(Date.now())).toBe(false);
    expect(service.ready).toBeInstanceOf(Promise);
  });

  it('ready resolves after the first refresh attempt even on error', async () => {
    bridge.get.mockRejectedValue(new Error('probe failed'));
    const service = new GpuCapabilitiesService(() => status());
    await service.ready;
    expect(service.loading()).toBe(false);
    expect(service.error()).toContain('probe failed');
  });

  it('fetches and caches capabilities on refresh', async () => {
    const service = new GpuCapabilitiesService(() => status());
    const promise = service.refresh();
    expect(service.loading()).toBe(true);
    await promise;
    expect(service.caps()).toEqual(baseCaps);
    expect(service.error()).toBeUndefined();
    expect(service.loading()).toBe(false);
    expect(bridge.get).toHaveBeenCalledOnce();
  });

  it('shares a single in-flight refresh promise', async () => {
    const service = new GpuCapabilitiesService(() => status());
    const first = service.refresh();
    const second = service.refresh();
    expect(first).toBe(second);
    await first;
    expect(bridge.get).toHaveBeenCalledOnce();
  });

  it('is fresh inside the refresh window and stale after it', async () => {
    const service = new GpuCapabilitiesService(() => status());
    await service.refresh();
    const now = Date.now();
    expect(service.isFresh(now)).toBe(true);
    expect(service.isFresh(now + GPU_REFRESH_MS)).toBe(true);
    expect(service.isFresh(now + GPU_REFRESH_MS + 1000)).toBe(false);
  });

  it('keeps the adapter inventory past 5 s (no stale invalidation)', async () => {
    const service = new GpuCapabilitiesService(() => status());
    await service.refresh();
    await vi.advanceTimersByTimeAsync(5001);
    expect(service.caps()).toEqual(baseCaps);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(service.caps()).toEqual(baseCaps);
    expect(bridge.get).toHaveBeenCalledOnce();
  });

  it('re-probes on the long timer and keeps the previous caps while it is pending', async () => {
    const service = new GpuCapabilitiesService(() => status());
    await service.refresh();
    const next: GpuCapabilities = { adapters: [{ adapterLuid: 'luid-2', nvenc: false }], checkedAt: 2000 };
    let release!: (value: GpuCapabilities) => void;
    bridge.get.mockReturnValueOnce(new Promise<GpuCapabilities>(resolve => { release = resolve; }));
    await vi.advanceTimersByTimeAsync(GPU_REFRESH_MS);
    expect(bridge.get).toHaveBeenCalledTimes(2);
    expect(service.loading()).toBe(true);
    expect(service.caps()).toEqual(baseCaps); // no flicker to unknown
    release(next);
    await vi.advanceTimersByTimeAsync(0);
    expect(service.caps()).toEqual(next);
    expect(service.loading()).toBe(false);
  });

  it('keeps the previous caps when a later refresh fails or returns an invalid report', async () => {
    const service = new GpuCapabilitiesService(() => status());
    await service.refresh();
    bridge.get.mockRejectedValueOnce(new Error('NVML not available'));
    await service.refresh();
    expect(service.caps()).toEqual(baseCaps);
    expect(service.error()).toContain('NVML not available');
    bridge.get.mockResolvedValueOnce({ adapters: 'not-an-array', checkedAt: 1000 });
    await service.refresh();
    expect(service.caps()).toEqual(baseCaps);
    expect(service.error()).toContain('invalid GPU capability report');
    await service.refresh();
    expect(service.error()).toBeUndefined();
  });

  it('a backend error with valid adapters keeps usable hints, shows the reason and is not a fresh success', async () => {
    const withError: GpuCapabilities = { adapters: [{ adapterLuid: 'luid-1' }], checkedAt: 3000, error: 'NVML unavailable' };
    bridge.get.mockResolvedValueOnce(withError);
    const service = new GpuCapabilitiesService(() => status());
    await service.ready;
    expect(service.caps()).toEqual(withError);
    expect(service.error()).toBe('NVML unavailable');
    expect(service.isFresh()).toBe(false);
  });

  it('a backend error with an empty inventory keeps the previous caps', async () => {
    const service = new GpuCapabilitiesService(() => status());
    await service.refresh();
    bridge.get.mockResolvedValueOnce({ adapters: [], checkedAt: 4000, error: 'probe failed' });
    await service.refresh();
    expect(service.caps()).toEqual(baseCaps);
    expect(service.error()).toBe('probe failed');
  });

  it('stays unknown (undefined caps) when the first probe fails', async () => {
    bridge.get.mockRejectedValue(new Error('NVML not available'));
    const service = new GpuCapabilitiesService(() => status());
    await service.ready;
    expect(service.caps()).toBeUndefined();
    expect(service.error()).toContain('NVML not available');
  });

  it('a hung startup probe times out so ready resolves and the UI stays unknown', async () => {
    bridge.get.mockReturnValue(new Promise(() => {}));
    const service = new GpuCapabilitiesService(() => status());
    let readyDone = false;
    void service.ready.then(() => { readyDone = true; });
    await vi.advanceTimersByTimeAsync(GPU_PROBE_TIMEOUT_MS - 1);
    expect(readyDone).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(readyDone).toBe(true);
    expect(service.caps()).toBeUndefined();
    expect(service.error()).toContain('timed out');
    expect(service.loading()).toBe(false);
  });

  it('a hung refresh times out and preserves the previous caps', async () => {
    const service = new GpuCapabilitiesService(() => status());
    await service.refresh();
    bridge.get.mockReturnValueOnce(new Promise(() => {}));
    const pending = service.refresh();
    await vi.advanceTimersByTimeAsync(GPU_PROBE_TIMEOUT_MS + 1);
    await pending;
    expect(service.caps()).toEqual(baseCaps);
    expect(service.error()).toContain('timed out');
  });

  it('refreshIfStale throttles to the refresh window, including after failures', async () => {
    bridge.get.mockRejectedValue(new Error('down'));
    const service = new GpuCapabilitiesService(() => status());
    await service.ready;
    await service.refreshIfStale();
    expect(bridge.get).toHaveBeenCalledOnce();
    await service.refreshIfStale(Date.now() + GPU_REFRESH_MS + 1);
    expect(bridge.get).toHaveBeenCalledTimes(2);
  });

  it('invalidation clears caps and cancels the refresh timer', async () => {
    const service = new GpuCapabilitiesService(() => status());
    await service.refresh();
    service.invalidate();
    expect(service.caps()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(GPU_REFRESH_MS * 3);
    expect(bridge.get).toHaveBeenCalledOnce();
  });

  it('disposes cleanly and stops re-probing', async () => {
    const service = new GpuCapabilitiesService(() => status());
    await service.refresh();
    service.dispose();
    await vi.advanceTimersByTimeAsync(GPU_REFRESH_MS * 3);
    expect(service.caps()).toBeUndefined();
    expect(bridge.get).toHaveBeenCalledOnce();
  });
});
