import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signal } from '../reactive';
import { ofxrDefaults } from '../domain/ofxr';
import type { AppSetting, OfxrStatus } from '../domain/types';
import { OfxrSessionService } from './ofxr-session';

const bridge = vi.hoisted(() => ({ status: vi.fn(), arm: vi.fn(), disarm: vi.fn(), apply: vi.fn(), reinstall: vi.fn(), remove: vi.fn() }));
vi.mock('../platform/tauri', () => ({
  ofxr_status: bridge.status, ofxr_arm: bridge.arm, ofxr_disarm: bridge.disarm,
  ofxr_apply: bridge.apply, ofxr_reinstall: bridge.reinstall, ofxr_remove: bridge.remove,
}));
const status = (state: OfxrStatus['state']): OfxrStatus => ({ state, version: '116', runtimeDir: 'runtime/v116', reason: null, versions: [] });
const tick = async () => { for (let i = 0; i < 15; ++i) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function fixture(enabled = false, spacewarp = false, vendor = 'galaxyxr') {
  const values = signal({ ofxr: { ...ofxrDefaults, enabled, version: '116', mode: 'nvidia-medium' } } as AppSetting);
  const confirmedValues = signal<AppSetting | undefined>(structuredClone(values()));
  const app = {
    initTask: Promise.resolve(), values, confirmedValues, readFileError: signal<unknown>(undefined), writeFileError: signal<string | undefined>(undefined),
    save: vi.fn(async (next: AppSetting) => { values.set(next); confirmedValues.set(structuredClone(next)); return true; }),
  };
  const driver = { initTask: Promise.resolve(), readFileError: signal<unknown>(undefined), inspecting: false };
  const galaxy = { vendor, settings: { spacewarpEnable: spacewarp }, save: vi.fn(async () => true) };
  const service = new OfxrSessionService(app as any, driver as any, galaxy as any);
  return { service, app, driver, galaxy };
}
beforeEach(() => {
  vi.resetAllMocks();
  bridge.status.mockResolvedValue(status('ready'));
  bridge.arm.mockImplementation(async () => { bridge.status.mockResolvedValue(status('armed')); return status('armed'); });
  bridge.disarm.mockImplementation(async () => { bridge.status.mockResolvedValue(status('ready')); return status('ready'); });
  bridge.reinstall.mockResolvedValue(status('ready'));
  bridge.remove.mockResolvedValue(status('ready'));
});

describe('saved OFXR session restoration', () => {
  it('waits for both settings stores, then restores the selected NVIDIA session once without resaving preferences', async () => {
    const { service, app, driver } = fixture(true);
    const loaded = deferred<void>(); driver.initTask = loaded.promise;
    const first = service.start(), second = service.start();
    await tick(); expect(bridge.arm).not.toHaveBeenCalled();
    loaded.resolve(); await Promise.all([first, second]);
    expect(bridge.arm).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ enabled: true, version: '116', mode: 'nvidia-medium' }));
    expect(app.save).not.toHaveBeenCalled(); expect(service.isArmed()).toBe(true);
  });
  it.each(['disabled', 'neutral', 'unreadable', 'unconfirmed'])('does not arm a %s startup preference', async mode => {
    const { service, app } = fixture(mode !== 'disabled', false, mode === 'neutral' ? '' : 'galaxyxr');
    if (mode === 'unreadable') app.readFileError.set('bad JSON');
    if (mode === 'unconfirmed') app.confirmedValues.set(undefined);
    await service.start(); expect(bridge.arm).not.toHaveBeenCalled(); expect(app.save).not.toHaveBeenCalled();
  });
  it('keeps a failed restore visibly disarmed and permits an explicit retry with the saved On preference', async () => {
    const { service, app } = fixture(true);
    bridge.arm.mockRejectedValueOnce(new Error('selected version missing'));
    await service.start();
    expect(service.isArmed()).toBe(false); expect(service.error()).toContain('selected version missing');
    expect(app.values().ofxr.enabled).toBe(true);
    await service.setEnabled(true);
    expect(service.isArmed()).toBe(true); expect(service.error()).toBeUndefined();
  });
  it('refuses conflicting startup ASW without rewriting it, then switches modes on explicit retry', async () => {
    const { service, galaxy } = fixture(true, true);
    await service.start(); expect(bridge.arm).not.toHaveBeenCalled(); expect(galaxy.save).not.toHaveBeenCalled();
    expect(galaxy.settings.spacewarpEnable).toBe(true); expect(service.error()).toContain('Async Spacewarp is enabled');
    await service.setEnabled(true); expect(galaxy.settings.spacewarpEnable).toBe(false); expect(service.isArmed()).toBe(true);
  });
  it('does not arm with unreadable driver settings or after disposal during initialization', async () => {
    const first = fixture(true); first.driver.readFileError.set('read failed'); await first.service.start();
    expect(bridge.arm).not.toHaveBeenCalled(); expect(first.service.error()).toContain('saved driver');
    const next = fixture(true); const loaded = deferred<void>(); next.driver.initTask = loaded.promise;
    const task = next.service.start(); await tick(); next.service.dispose(); loaded.resolve(); await task;
    expect(bridge.arm).not.toHaveBeenCalled();
  });
});

describe('confirmed synthesis mode switching', () => {
  it('preserves neutral and already-disabled OFXR paths without invoking its Windows manager', async () => {
    const neutral = fixture(false, false, ''); await neutral.service.setSpacewarp(true);
    expect(neutral.galaxy.settings.spacewarpEnable).toBe(true);
    const disabled = fixture(); await disabled.service.setSpacewarp(true);
    expect(disabled.galaxy.settings.spacewarpEnable).toBe(true);
    expect(bridge.disarm).not.toHaveBeenCalled(); expect(disabled.app.save).not.toHaveBeenCalled();
  });
  it('cannot arm until the ASW Off write succeeds', async () => {
    const { service, galaxy } = fixture(false, true);
    const saved = deferred<boolean>(); galaxy.save.mockReturnValueOnce(saved.promise);
    const task = service.setEnabled(true); await tick();
    expect(bridge.arm).not.toHaveBeenCalled(); expect(service.changing()).toBe(true);
    saved.resolve(true); await task;
    expect(bridge.arm).toHaveBeenCalledOnce(); expect(service.isArmed()).toBe(true);
  });
  it('does not arm or persist OFXR On after a failed/superseded ASW save', async () => {
    const { service, app, galaxy } = fixture(false, true); galaxy.save.mockResolvedValueOnce(false);
    await service.setEnabled(true);
    expect(bridge.arm).not.toHaveBeenCalled(); expect(app.save).not.toHaveBeenCalled();
    expect(service.error()).toContain('could not be saved Off');
  });
  it('restores previous ASW when saving OFXR preferences fails', async () => {
    const { service, app, galaxy } = fixture(false, true); app.save.mockResolvedValueOnce(false);
    await service.setEnabled(true);
    expect(bridge.arm).not.toHaveBeenCalled(); expect(galaxy.settings.spacewarpEnable).toBe(true);
    expect(galaxy.save).toHaveBeenCalledTimes(2); expect(service.error()).toContain('could not be saved');
  });
  it('rolls back both preferences after native arming fails', async () => {
    const { service, app, galaxy } = fixture(false, true); bridge.arm.mockRejectedValueOnce(new Error('registry denied'));
    await service.setEnabled(true);
    expect(app.values().ofxr.enabled).toBe(false); expect(galaxy.settings.spacewarpEnable).toBe(true);
    expect(service.isArmed()).toBe(false); expect(service.error()).toContain('registry denied');
  });
  it('never enables ASW if native disarm fails, and reports the actual still-armed switch state', async () => {
    const { service, galaxy } = fixture(true); await service.start();
    bridge.disarm.mockRejectedValueOnce(new Error('cannot disarm'));
    await service.setSpacewarp(true);
    expect(galaxy.settings.spacewarpEnable).toBe(false); expect(galaxy.save).not.toHaveBeenCalled();
    expect(service.isArmed()).toBe(true); expect(service.error()).toContain('cannot disarm');
  });
  it('serializes a version change behind an unfinished arming operation', async () => {
    const { service } = fixture(); const armed = deferred<OfxrStatus>(); bridge.arm.mockReturnValueOnce(armed.promise);
    const first = service.setEnabled(true); await tick(); const next = service.selectVersion('117'); await tick();
    expect(bridge.disarm).not.toHaveBeenCalled();
    bridge.status.mockResolvedValue(status('armed')); armed.resolve(status('armed')); await Promise.all([first, next]);
    expect(bridge.disarm).toHaveBeenCalledOnce(); expect(bridge.arm.mock.lastCall?.[0].version).toBe('117');
  });
  it('refuses ASW when another manager remains armed after Companion disarm', async () => {
    const { service, galaxy } = fixture(false);
    // 2026-10-20: the exclusion reads the LIVE registry, so the mocked read (not
    // a cached status) is what reports the external manager here.
    bridge.status.mockResolvedValue(status('armed_external'));
    service.status.set(status('armed_external'));
    bridge.disarm.mockImplementationOnce(async () => { bridge.status.mockResolvedValue(status('armed_external')); return status('armed_external'); });
    await service.setSpacewarp(true);
    expect(galaxy.save).not.toHaveBeenCalled(); expect(service.error()).toContain('current manager');
  });
  it('does not let a stale armed cache block ASW after the external manager is gone', async () => {
    const { service, galaxy } = fixture(false);
    service.status.set(status('armed_external'));  // stale observation
    bridge.status.mockResolvedValue(status('ready'));  // live registry: nothing armed
    await service.setSpacewarp(true);
    expect(galaxy.save).toHaveBeenCalledOnce();
    expect((galaxy.settings as { spacewarpEnable?: boolean }).spacewarpEnable).toBe(true);
  });
  it('only applies confirmed saved backend preferences', async () => {
    const { service, app } = fixture(true); app.save.mockResolvedValueOnce(false);
    await service.update({ scale: 75 }); expect(bridge.apply).not.toHaveBeenCalled();
    await service.update({ scale: 75 }); expect(bridge.apply).toHaveBeenCalledWith(expect.objectContaining({ scale: 75 }));
  });
});

describe('OFXR management', () => {
  it('rearms an enabled selection after successful reinstall', async () => {
    const { service } = fixture(true); await service.reinstall();
    expect(bridge.reinstall).toHaveBeenCalledWith(expect.objectContaining({ version: '116' })); expect(service.isArmed()).toBe(true);
  });
  it('does not arm after a rejected reinstall and preserves the selected version', async () => {
    const { service, app } = fixture(true); bridge.reinstall.mockRejectedValueOnce(new Error('external runtime preserved'));
    await service.reinstall(); expect(bridge.arm).not.toHaveBeenCalled(); expect(app.values().ofxr.version).toBe('116');
    expect(service.error()).toContain('external runtime preserved');
  });
  it('removes the layer before recording disabled preferences', async () => {
    const { service, app } = fixture(true); await service.remove();
    expect(bridge.remove).toHaveBeenCalledOnce(); expect(app.values().ofxr).toMatchObject({ enabled: false, version: '' });
    expect(bridge.remove.mock.invocationCallOrder[0]).toBeLessThan(app.save.mock.invocationCallOrder[0]);
  });
});
