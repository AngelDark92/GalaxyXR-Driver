import { describe, expect, it } from 'vitest';
import { encoderTapStatus, encoderEvidence, expiredEncoderEvidence } from './encoder-tap-status';
import type { DriverInfo } from './types';
import type { DriverRuntimeStatus } from '../platform/tauri';

const runtime: DriverRuntimeStatus = { state: 'headset-connected', detail: '', steamvrRunning: true,
  driverInitialized: true, headsetConnected: true, driverVersion: '1.3.0', serverPid: 42, checkedAt: 10000,
  encoderTap: { state: 'disabled', configPath: 'settings.json', modulePath: 'driver.dll' } };
const live: DriverRuntimeStatus = { ...runtime, encoderTap: { ...runtime.encoderTap!, state: 'enabled' as const } };
const refusal: DriverInfo = { encoderTap: { enabled: true, hookInstalled: true, upgradedSessionsRemain: false,
  pid: 42, observedAt: 11000, configPath: 'settings.json', modulePath: 'driver.dll',
  requestedCodec: 2, effectiveCodec: -1, lastStatus: 8, error: 'Unsupported dimensions' } } as DriverInfo;
describe('NVENC OFF runtime evidence', () => {
  it('shows encoder failures only for fresh matching process and module evidence', () => {
    const info = { encoderTap: { ...refusal.encoderTap } } as DriverInfo;
    expect(encoderEvidence(info, live, 12000)?.error).toBe('Unsupported dimensions');
    expect(encoderEvidence(info, undefined, 12000)).toBeUndefined();
    for (const change of [{ pid: 43 }, { observedAt: 1000 }, { observedAt: 15000 },
      { modulePath: 'other.dll' }, { configPath: 'other-settings.json' }]) {
      expect(encoderEvidence({ ...info, encoderTap: { ...info.encoderTap!, ...change } }, live, 12000)).toBeUndefined();
    }
    expect(encoderEvidence(info, { ...live, steamvrRunning: false }, 12000)).toBeUndefined();
  });
  it('keeps an expired process-bound rejection visible with its age', () => {
    // observedAt 11000 is 6 s old at now=17000: one second past the 5 s
    // window, but the runtime (rechecked at 15000) still verifies the same
    // process, module and settings path, so the rejection stays retrievable
    // with its age.
    const expired = expiredEncoderEvidence(refusal, { ...live, checkedAt: 15000 }, 17000)!;
    expect(expired.tap.error).toBe('Unsupported dimensions');
    expect(expired.tap.requestedCodec).toBe(2);
    expect(expired.ageMs).toBe(6000);
    // inside the fresh window (the 5 s boundary included) it is not "expired"
    expect(expiredEncoderEvidence(refusal, live, 12000)).toBeUndefined();
    expect(expiredEncoderEvidence(refusal, live, 16000)).toBeUndefined();
  });
  it('never shows expired evidence for a dead, replaced or unverified process', () => {
    for (const change of [{ pid: 43 }, { modulePath: 'other.dll' }, { configPath: 'other-settings.json' }]) {
      expect(expiredEncoderEvidence(
        { ...refusal, encoderTap: { ...refusal.encoderTap!, ...change } } as DriverInfo, live, 17000)).toBeUndefined();
    }
    expect(expiredEncoderEvidence(refusal, { ...live, steamvrRunning: false }, 17000)).toBeUndefined();
    expect(expiredEncoderEvidence(refusal, { ...live, driverInitialized: false }, 17000)).toBeUndefined();
    expect(expiredEncoderEvidence(refusal, undefined, 17000)).toBeUndefined();
    // a stale runtime check cannot keep old evidence process-bound
    expect(expiredEncoderEvidence(refusal, { ...live, checkedAt: 1000 }, 17000)).toBeUndefined();
    // corrupt future stamps are dropped, not shown with a negative age
    expect(expiredEncoderEvidence(
      { ...refusal, encoderTap: { ...refusal.encoderTap!, observedAt: 100000 } } as DriverInfo, live, 17000)).toBeUndefined();
    // no observation at all is not expired evidence
    expect(expiredEncoderEvidence(
      { ...refusal, encoderTap: { ...refusal.encoderTap!, observedAt: undefined } } as DriverInfo, live, 17000)).toBeUndefined();
  });
  it('requires saved OFF and fresh initialized process evidence', () => {
    expect(encoderTapStatus(false, runtime, 12000)).toBe('confirmed-off');
    expect(encoderTapStatus(true, runtime, 12000)).toBe('on');
    expect(encoderTapStatus(false, undefined, 12000)).toBe('waiting');
    for (const change of [{driverInitialized:false}, {steamvrRunning:false}, {serverPid:null},
      {checkedAt:1000}, {checkedAt:15000}, {encoderTap:null}, {encoderTap:{...runtime.encoderTap!,state:'enabled' as const}}]) {
      expect(encoderTapStatus(false, {...runtime,...change}, 12000)).toBe('waiting');
    }
  });
  it('does not claim live restored parameters for an already hooked process', () => {
    expect(encoderTapStatus(false, {...runtime, encoderTap:{...runtime.encoderTap!,state:'restart-required'}}, 12000))
      .toBe('restart-required');
  });
});
