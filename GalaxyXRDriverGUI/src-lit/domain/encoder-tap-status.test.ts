import { describe, expect, it } from 'vitest';
import { encoderTapStatus, encoderEvidence } from './encoder-tap-status';
import type { DriverInfo } from './types';
import type { DriverRuntimeStatus } from '../platform/tauri';

const runtime: DriverRuntimeStatus = { state: 'headset-connected', detail: '', steamvrRunning: true,
  driverInitialized: true, headsetConnected: true, driverVersion: '1.3.0', serverPid: 42, checkedAt: 10000,
  encoderTap: { state: 'disabled', configPath: 'settings.json', modulePath: 'driver.dll' } };
describe('NVENC OFF runtime evidence', () => {
  it('shows encoder failures only for fresh matching process and module evidence', () => {
    const live = { ...runtime, encoderTap: { ...runtime.encoderTap!, state: 'enabled' as const } };
    const info = { encoderTap: { enabled: true, hookInstalled: true, upgradedSessionsRemain: false,
      pid: 42, observedAt: 11000, configPath: 'settings.json', modulePath: 'driver.dll',
      requestedCodec: 1, effectiveCodec: -1, lastStatus: 8, error: 'Unsupported dimensions' } } as DriverInfo;
    expect(encoderEvidence(info, live, 12000)?.error).toBe('Unsupported dimensions');
    expect(encoderEvidence(info, undefined, 12000)).toBeUndefined();
    for (const change of [{ pid: 43 }, { observedAt: 1000 }, { observedAt: 15000 },
      { modulePath: 'other.dll' }, { configPath: 'other-settings.json' }]) {
      expect(encoderEvidence({ ...info, encoderTap: { ...info.encoderTap!, ...change } }, live, 12000)).toBeUndefined();
    }
    expect(encoderEvidence(info, { ...live, steamvrRunning: false }, 12000)).toBeUndefined();
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
