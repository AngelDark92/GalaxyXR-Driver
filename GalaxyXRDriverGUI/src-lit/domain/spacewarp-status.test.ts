import { describe, expect, it } from 'vitest';
import { spacewarpStatus } from './spacewarp-status';
import type { DriverInfo } from './types';
import type { DriverRuntimeStatus } from '../platform/tauri';

const runtime: DriverRuntimeStatus = { state: 'headset-connected', detail: '', steamvrRunning: true,
  driverInitialized: true, headsetConnected: true, driverVersion: '1.3.0', serverPid: 42, checkedAt: 10000 };
// Brief 11's pinned seam: info.json block spacewarp, status exactly
// 'off' | 'on' | 'waiting'. No other keys are invented here.
const block = { enabled: true, hookInstalled: true, published: true, status: 'on' as const };
const info = (spacewarp: DriverInfo['spacewarp']) => ({ spacewarp }) as DriverInfo;

describe('Async Spacewarp honest status (2026-10-17 seam)', () => {
  it('maps the driver block status off/on/waiting to Off/Active/Waiting', () => {
    expect(spacewarpStatus(true, info(block), runtime, 12000)).toBe('on');
    expect(spacewarpStatus(true, info({ ...block, status: 'waiting', published: false }), runtime, 12000)).toBe('waiting');
    // off=Off maps regardless of saved state: the user's saved value rules
    expect(spacewarpStatus(false, info({...block, enabled: false, published: false, status: 'off' }), runtime, 12000)).toBe('off');
    expect(spacewarpStatus(false, info(block), runtime, 12000)).toBe('off');
    expect(spacewarpStatus(false, undefined, runtime, 12000)).toBe('off');
  });
  it('does not claim Active for a saved ON without fresh publish confirmation', () => {
    // no observation at all (older driver build without the emitter)
    expect(spacewarpStatus(true, undefined, runtime, 12000)).toBe('waiting');
    // contradicted driver report: not yet taken effect
    expect(spacewarpStatus(true, info({ ...block, status: 'off', published: false, enabled: false }), runtime, 12000)).toBe('waiting');
    expect(spacewarpStatus(true, info({ ...block, status: 'waiting' }), runtime, 12000)).toBe('waiting');
    // stale or missing runtime verification cannot prove the publish
    expect(spacewarpStatus(true, info(block), undefined, 12000)).toBe('waiting');
    for (const change of [{ driverInitialized: false }, { steamvrRunning: false }, { checkedAt: 1000 }, { checkedAt: 15001 }]) {
      expect(spacewarpStatus(true, info(block), { ...runtime, ...change }, 12000)).toBe('waiting');
    }
  });
  it('keeps the encoder-style freshness windows: 5 s age cap, 2 s future tolerance', () => {
    expect(spacewarpStatus(true, info(block), { ...runtime, checkedAt: 7000 }, 12000)).toBe('on');
    expect(spacewarpStatus(true, info(block), { ...runtime, checkedAt: 6999 }, 12000)).toBe('waiting');
    expect(spacewarpStatus(true, info(block), { ...runtime, checkedAt: 14000 }, 12000)).toBe('on');
    expect(spacewarpStatus(true, info(block), { ...runtime, checkedAt: 14001 }, 12000)).toBe('waiting');
  });
});