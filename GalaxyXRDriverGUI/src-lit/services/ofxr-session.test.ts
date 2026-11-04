import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signal } from '../reactive';
import { ofxrDefaults } from '../domain/ofxr';
import type { AppSetting, GpuCapabilities, OfxrStatus } from '../domain/types';
import { OfxrSessionService } from './ofxr-session';

const bridge = vi.hoisted(() => ({ status: vi.fn(), arm: vi.fn(), disarm: vi.fn(), apply: vi.fn(), import: vi.fn(), reinstall: vi.fn(), remove: vi.fn() }));
vi.mock('../platform/tauri', () => ({
  ofxr_status: bridge.status, ofxr_arm: bridge.arm, ofxr_disarm: bridge.disarm,
  ofxr_apply: bridge.apply, ofxr_import: bridge.import, ofxr_reinstall: bridge.reinstall, ofxr_remove: bridge.remove,
}));
const status = (state: OfxrStatus['state']): OfxrStatus => ({ state, version: '116', runtimeDir: 'runtime/v116', reason: null, versions: [] });
const tick = async () => { for (let i = 0; i < 15; ++i) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function fixture(enabled = false, vendor = 'galaxyxr') {
  const values = signal({ ofxr: { ...ofxrDefaults, enabled, version: '116', mode: 'nvidia-medium' } } as AppSetting);
  const confirmedValues = signal<AppSetting | undefined>(structuredClone(values()));
  const app = {
    initTask: Promise.resolve(), values, confirmedValues, readFileError: signal<unknown>(undefined), writeFileError: signal<string | undefined>(undefined),
    save: vi.fn(async (next: AppSetting) => { values.set(next); confirmedValues.set(structuredClone(next)); return true; }),
  };
  const driver = { initTask: Promise.resolve(), readFileError: signal<unknown>(undefined), inspecting: false };
  const galaxy = { vendor, settings: {}, save: vi.fn(async () => true) };
  const gpu = { caps: vi.fn<() => GpuCapabilities | undefined>(() => undefined), ready: Promise.resolve() };
  const service = new OfxrSessionService(app as any, driver as any, galaxy as any, gpu as any);
  return { service, app, driver, galaxy, gpu };
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
    const { service, app } = fixture(mode !== 'disabled', mode === 'neutral' ? '' : 'galaxyxr');
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
  it('does not arm with unreadable driver settings or after disposal during initialization', async () => {
    const first = fixture(true); first.driver.readFileError.set('read failed'); await first.service.start();
    expect(bridge.arm).not.toHaveBeenCalled(); expect(first.service.error()).toContain('saved driver');
    const next = fixture(true); const loaded = deferred<void>(); next.driver.initTask = loaded.promise;
    const task = next.service.start(); await tick(); next.service.dispose(); loaded.resolve(); await task;
    expect(bridge.arm).not.toHaveBeenCalled();
  });
});

describe('confirmed preference application', () => {
  it('only applies confirmed saved backend preferences', async () => {
    const { service, app } = fixture(true); app.save.mockResolvedValueOnce(false);
    await service.update({ bidirectional: true }); expect(bridge.apply).not.toHaveBeenCalled();
    await service.update({ bidirectional: true }); expect(bridge.apply).toHaveBeenCalledWith(expect.objectContaining({ bidirectional: true }));
  });
  const noFlow = { adapters: [{ nvenc: true, opticalFlow: false }], checkedAt: Date.now() } as GpuCapabilities;
  it('refuses to newly select an unsupported NVIDIA mode before saving', async () => {
    const { service, app, gpu } = fixture(true);
    gpu.caps.mockReturnValue(noFlow);
    await service.update({ mode: 'nvidia-fast' });
    expect(app.save).not.toHaveBeenCalled();
    expect(bridge.apply).not.toHaveBeenCalled();
    expect(service.error()).toContain('NVIDIA Optical Flow is not available');
  });
  it('allows unrelated edits and switching away while a stored NVIDIA mode is unsupported', async () => {
    const { service, app, gpu } = fixture(true);
    gpu.caps.mockReturnValue(noFlow);
    await service.update({ bidirectional: true });
    expect(app.values().ofxr).toMatchObject({ bidirectional: true, mode: 'nvidia-medium' });
    expect(bridge.apply).toHaveBeenCalledTimes(1);
    expect(service.error()).toBeUndefined();
    await service.update({ mode: 'fidelityfx' });
    expect(app.values().ofxr.mode).toBe('fidelityfx');
    expect(bridge.apply).toHaveBeenCalledTimes(2);
  });
  it('allows an NVIDIA mode while the adapter is unknown', async () => {
    const { service, app } = fixture(true);
    await service.update({ mode: 'nvidia-slow' });
    expect(app.values().ofxr.mode).toBe('nvidia-slow');
  });
  it('arming and startup restore always validate the stored NVIDIA mode', async () => {
    const restored = fixture(true);
    restored.gpu.caps.mockReturnValue(noFlow);
    await restored.service.start();
    expect(bridge.arm).not.toHaveBeenCalled();
    expect(restored.service.error()).toContain('NVIDIA Optical Flow is not available');
    expect(restored.app.values().ofxr.enabled).toBe(true);
    const manual = fixture(false);
    manual.gpu.caps.mockReturnValue(noFlow);
    await manual.service.setEnabled(true);
    expect(bridge.arm).not.toHaveBeenCalled();
    expect(manual.app.values().ofxr.enabled).toBe(false);
  });
  it('startup restore waits for the (time-bounded) GPU probe attempt, then arms', async () => {
    const { service, gpu } = fixture(true);
    const probe = deferred<void>();
    gpu.ready = probe.promise;
    const started = service.start(); await tick();
    expect(bridge.arm).not.toHaveBeenCalled();
    probe.resolve(); await started;
    expect(bridge.arm).toHaveBeenCalledOnce();
  });
  it('rolls back Optical Flow preferences after native arming fails', async () => {
    const { service, app } = fixture(); bridge.arm.mockRejectedValueOnce(new Error('registry denied'));
    await service.setEnabled(true);
    expect(app.values().ofxr.enabled).toBe(false);
    expect(service.isArmed()).toBe(false);
    expect(service.error()).toContain('registry denied');
  });
  it('serializes a version change behind an unfinished arming operation', async () => {
    const { service } = fixture(); const armed = deferred<OfxrStatus>(); bridge.arm.mockReturnValueOnce(armed.promise);
    const first = service.setEnabled(true); await tick(); const next = service.selectVersion('117'); await tick();
    expect(bridge.disarm).not.toHaveBeenCalled();
    bridge.status.mockResolvedValue(status('armed')); armed.resolve(status('armed')); await Promise.all([first, next]);
    expect(bridge.disarm).toHaveBeenCalledOnce(); expect(bridge.arm.mock.lastCall?.[0].version).toBe('117');
  });
});

describe('OFXR management', () => {
  it('imports a fork build, records its version and rearms an enabled selection', async () => {
    const { service, app } = fixture(true);
    bridge.import.mockResolvedValue('9999');
    await service.importBuild('/tmp/ofxr-fork');
    expect(bridge.import).toHaveBeenCalledWith('/tmp/ofxr-fork');
    expect(app.values().ofxr.version).toBe('9999');
    expect(bridge.arm).toHaveBeenCalled();
  });
  it('refuses to reinstall over an imported build', async () => {
    const { service } = fixture(true);
    bridge.status.mockResolvedValue({
      state: 'ready', version: '9999', runtimeDir: 'runtime/v9999', reason: null,
      versions: [{ version: '9999', source: 'imported', label: 'OFXR-Bridge-v9999' }],
    });
    await service.reinstall();
    expect(bridge.reinstall).not.toHaveBeenCalled();
    expect(service.error()).toContain('imported');
  });
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
