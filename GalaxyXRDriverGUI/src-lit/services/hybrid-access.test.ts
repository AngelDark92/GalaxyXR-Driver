import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppSettingService } from './app-setting';
import { DriverSettingService } from './driver-setting';
import { HybridAccessService } from './hybrid-access';
import type { PathsService } from './paths';
import type { DriverInfoService } from './driver-info';

const disk = vi.hoisted(() => ({
  files: new Map<string, string>(),
  rejected: new Set<string>(),
  writes: [] as { path: string; value: any }[],
  beforeWrite: undefined as undefined | ((path: string) => Promise<void>),
}));
vi.mock('../environment', () => ({ vendor: 'galaxyxr' }));
vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: async (path: string) => path === '/test' || disk.files.has(path),
  mkdir: async () => {}, watchImmediate: async () => () => {},
  readTextFile: async (path: string) => disk.files.get(path)!,
  writeTextFile: async (path: string, content: string) => {
    disk.writes.push({ path, value: JSON.parse(content) });
    await disk.beforeWrite?.(path);
    if (disk.rejected.has(path)) throw new Error('Read-only settings');
    disk.files.set(path, content);
  },
}));

const appPath = '/test/gui-settings.json', driverPath = '/test/settings.json';
const instances: { dispose(): void }[] = [];
const tick = async () => { for (let i = 0; i < 20; ++i) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function put(path: string, value: object | string | null): void {
  if (value === null) disk.files.delete(path);
  else disk.files.set(path, typeof value === 'string' ? value : JSON.stringify(value));
}
function stored(path: string): any { return JSON.parse(disk.files.get(path)!); }
async function fixture(app: object | string | null = { advanceMode: false }, driver: object | string | null = {}) {
  put(appPath, app); put(driverPath, driver);
  const paths = { guiSettingPath: appPath, settingPath: driverPath, appDataDirPath: '/test' } as PathsService;
  const appSetting = new AppSettingService(paths);
  const dss = new DriverSettingService(paths, { values: () => undefined } as unknown as DriverInfoService, () => appSetting.values());
  const service = new HybridAccessService(appSetting, dss);
  instances.push(appSetting, dss, service);
  await Promise.all([appSetting.initTask, dss.initTask]);
  const appSave = vi.spyOn(appSetting, 'save'), driverSave = vi.spyOn(dss, 'save');
  return { appSetting, dss, service, appSave, driverSave };
}
function holdWrite(path: string) {
  const entered = deferred<void>(), release = deferred<void>();
  disk.beforeWrite = async incoming => {
    if (incoming === path) { entered.resolve(); await release.promise; }
  };
  return { entered: entered.promise, release: () => { disk.beforeWrite = undefined; release.resolve(); } };
}

beforeEach(() => { disk.files.clear(); disk.rejected.clear(); disk.writes.length = 0; disk.beforeWrite = undefined; });
afterEach(() => { for (const service of instances.splice(0).reverse()) service.dispose(); });

describe('confirmed Hybrid access and startup', () => {
  it('waits for both initial loads and starts once', async () => {
    const { service, appSetting, dss, driverSave } = await fixture({}, { hybrid: { enabled: true } });
    const appLoaded = deferred<void>(), driverLoaded = deferred<void>();
    Object.defineProperty(appSetting, 'initTask', { value: appLoaded.promise });
    Object.defineProperty(dss, 'initTask', { value: driverLoaded.promise });
    const first = service.start();
    expect(service.start()).toBe(first);
    appLoaded.resolve(); await tick(); expect(driverSave).not.toHaveBeenCalled();
    driverLoaded.resolve(); await first; await service.idle();
    expect(driverSave).toHaveBeenCalledOnce();
    expect(stored(driverPath).hybrid.enabled).toBe(false);
  });

  it('unlocks a saved Advanced preference without enabling Hybrid', async () => {
    const { service, appSave, driverSave } = await fixture({ advanceMode: true });
    await service.start();
    expect(service.allowed()).toBe(true);
    expect(appSave).not.toHaveBeenCalled(); expect(driverSave).not.toHaveBeenCalled();
    expect(stored(driverPath)).toEqual({});
  });

  it('does not use Debug Mode or reveal preferences to unlock Hybrid', async () => {
    const { service, driverSave } = await fixture({ advanceMode: false, debugMode: true, revealAll: true }, { debugMode: true });
    await service.start();
    expect(service.allowed()).toBe(false);
    expect(await service.setEnabled(true)).toBe(false);
    expect(service.error()).toContain('Enable Advanced Mode');
    expect(driverSave).not.toHaveBeenCalled();
  });

  it('keeps optimistic and failed Advanced On preferences locked', async () => {
    const { service, appSetting, driverSave } = await fixture(); await service.start();
    const held = holdWrite(appPath); disk.rejected.add(appPath);
    const saving = appSetting.save({ ...appSetting.values(), advanceMode: true });
    await held.entered;
    expect(appSetting.values().advanceMode).toBe(true);
    expect(service.allowed()).toBe(false);
    held.release(); expect(await saving).toBe(false); await service.idle();
    expect(service.allowed()).toBe(false); expect(driverSave).not.toHaveBeenCalled();
  });

  it('treats absent app defaults as known Off and allows pre-install Advanced edits without creating native settings', async () => {
    const { service, appSetting, driverSave } = await fixture(null, null);
    await service.start();
    expect(service.allowed()).toBe(false); expect(appSetting.confirmedValues()?.advanceMode).toBe(false);
    expect(disk.files.size).toBe(0); expect(service.error()).toBeUndefined();
    expect(await service.setAdvancedMode(true)).toBe(true);
    expect(service.allowed()).toBe(true);
    expect(await service.setEnabled(true)).toBe(false);
    expect(service.error()).toContain('Install the driver');
    expect(await service.setAdvancedMode(false)).toBe(true);
    await appSetting.loadSetting();
    expect(appSetting.confirmedValues()?.advanceMode).toBe(false);
    expect(disk.files.has(driverPath)).toBe(false); expect(driverSave).not.toHaveBeenCalled();
  });

  it('reconciles saved Hybrid On with Advanced Off and preserves every tuning and unknown key', async () => {
    const hybrid = { enabled: true, foveaCodec: 3, guardDegrees: 7.5, featherPx: 19, futureTuning: { gain: 8 } };
    const { service, driverSave, appSave } = await fixture({}, { hybrid, foreignOwner: { untouched: true } });
    await service.start(); await service.idle();
    expect(stored(driverPath)).toMatchObject({ hybrid: { ...hybrid, enabled: false }, foreignOwner: { untouched: true } });
    expect(driverSave).toHaveBeenCalledOnce(); expect(appSave).not.toHaveBeenCalled();
    expect(service.error()).toBeUndefined();
  });

  it('leaves missing Hybrid keys Off without rewriting the document', async () => {
    const { service, dss, driverSave } = await fixture({}, { foreignSetting: 42 });
    await service.start();
    expect(dss.values()?.hybrid?.enabled).toBe(false);
    expect(driverSave).not.toHaveBeenCalled(); expect(stored(driverPath)).toEqual({ foreignSetting: 42 });
    expect(await service.setAdvancedMode(true)).toBe(true);
    expect(await service.setEnabled(true)).toBe(true);
    expect(stored(driverPath)).toMatchObject({ hybrid: { enabled: true }, foreignSetting: 42 });
  });

  it.each(['{broken', '[]'])('denies unknown application preferences without overwriting %s', async content => {
    const { service, appSave, driverSave } = await fixture(content, { hybrid: { enabled: true } });
    await expect(service.start()).resolves.toBeUndefined();
    expect(service.allowed()).toBe(false); expect(service.error()).toContain('gui-settings.json');
    expect(await service.setAdvancedMode(true)).toBe(false); expect(await service.setEnabled(false)).toBe(false);
    expect(appSave).not.toHaveBeenCalled(); expect(driverSave).not.toHaveBeenCalled();
    expect(disk.files.get(appPath)).toBe(content);
  });

  it('keeps unreadable native settings visibly unknown even while Advanced is Off', async () => {
    const { service, appSave, driverSave } = await fixture({}, '{broken');
    await expect(service.start()).resolves.toBeUndefined();
    expect(service.error()).toContain('Repair settings.json');
    expect(await service.setAdvancedMode(false)).toBe(false);
    expect(appSave).not.toHaveBeenCalled(); expect(driverSave).not.toHaveBeenCalled();
    expect(disk.files.get(driverPath)).toBe('{broken');
  });
});

describe('ordered Advanced and Hybrid changes', () => {
  it('confirms Hybrid Off before saving Advanced Off', async () => {
    const { service, appSetting, appSave } = await fixture({ advanceMode: true }, { hybrid: { enabled: true, guardDegrees: 11 } });
    await service.start();
    const held = holdWrite(driverPath), task = service.setAdvancedMode(false);
    await held.entered;
    expect(service.changing()).toBe(true); expect(service.allowed()).toBe(true);
    expect(appSave).not.toHaveBeenCalled(); expect(appSetting.confirmedValues()?.advanceMode).toBe(true);
    held.release(); expect(await task).toBe(true);
    expect(disk.writes.map(write => write.path)).toEqual([driverPath, appPath]);
    expect(stored(driverPath).hybrid).toMatchObject({ enabled: false, guardDegrees: 11 });
    expect(service.allowed()).toBe(false); expect(service.changing()).toBe(false);
  });

  it('retains Advanced On after native save failure and does not retry from rollback notifications', async () => {
    const { service, appSetting, dss, appSave, driverSave } = await fixture({ advanceMode: true }, { hybrid: { enabled: true } });
    await service.start(); disk.rejected.add(driverPath);
    expect(await service.setAdvancedMode(false)).toBe(false); await service.idle();
    expect(appSetting.confirmedValues()?.advanceMode).toBe(true); expect(service.allowed()).toBe(true);
    expect(dss.values()?.hybrid?.enabled).toBe(true); expect(stored(driverPath).hybrid.enabled).toBe(true);
    expect(appSave).not.toHaveBeenCalled(); expect(driverSave).toHaveBeenCalledOnce();
    expect(service.error()).toContain('permissions');
    disk.rejected.clear(); await tick(); await service.idle(); expect(driverSave).toHaveBeenCalledOnce();
    expect(await service.setAdvancedMode(false)).toBe(true);
    expect(service.allowed()).toBe(false);
  });

  it('keeps Hybrid Off if the later Advanced preference write fails', async () => {
    const { service, appSetting, driverSave } = await fixture({ advanceMode: true }, { hybrid: { enabled: true, featherPx: 33 } });
    await service.start(); disk.rejected.add(appPath);
    expect(await service.setAdvancedMode(false)).toBe(false); await service.idle();
    expect(appSetting.confirmedValues()?.advanceMode).toBe(true); expect(service.allowed()).toBe(true);
    expect(stored(driverPath).hybrid).toMatchObject({ enabled: false, featherPx: 33 });
    expect(driverSave).toHaveBeenCalledOnce();
    expect(service.error()).toBe('Hybrid is off, but Advanced Mode could not be saved. Check gui-settings.json permissions and retry.');
    disk.rejected.clear(); expect(await service.setAdvancedMode(false)).toBe(true);
    expect(driverSave).toHaveBeenCalledOnce(); expect(service.allowed()).toBe(false);
  });

  it('rejects Advanced Off with malformed native settings and preserves Advanced On', async () => {
    const { service, appSave } = await fixture({ advanceMode: true }, '{broken');
    await service.start(); expect(await service.setAdvancedMode(false)).toBe(false);
    expect(service.allowed()).toBe(true); expect(appSave).not.toHaveBeenCalled();
    expect(stored(appPath).advanceMode).toBe(true);
  });

  it('serializes an enable behind Advanced persistence and uses native tuning loaded while waiting', async () => {
    const { service, dss, driverSave } = await fixture({}, { hybrid: { featherPx: 13 } }); await service.start();
    const held = holdWrite(appPath), advanced = service.setAdvancedMode(true);
    await held.entered;
    const enable = service.setEnabled(true);
    put(driverPath, { hybrid: { enabled: false, featherPx: 47, guardDegrees: 6 }, externalKey: 99 });
    await dss.loadSetting(); await tick();
    expect(driverSave).not.toHaveBeenCalled(); expect(service.allowed()).toBe(false);
    held.release(); expect(await advanced).toBe(true); expect(await enable).toBe(true); await service.idle();
    expect(stored(driverPath)).toMatchObject({ hybrid: { enabled: true, featherPx: 47, guardDegrees: 6 }, externalKey: 99 });
  });

  it('does not enable Hybrid when a queued Advanced On save fails', async () => {
    const { service, driverSave } = await fixture(); await service.start();
    disk.rejected.add(appPath);
    const advanced = service.setAdvancedMode(true), enable = service.setEnabled(true);
    expect(await advanced).toBe(false); expect(await enable).toBe(false);
    expect(driverSave).not.toHaveBeenCalled(); expect(service.allowed()).toBe(false);
  });

  it('processes rapid enable, Advanced Off, and enable requests in order', async () => {
    const { service, dss, driverSave } = await fixture({ advanceMode: true }); await service.start();
    expect(await Promise.all([service.setEnabled(true), service.setAdvancedMode(false), service.setEnabled(true)])).toEqual([true, true, false]);
    expect(driverSave.mock.calls.map(([value]) => value.hybrid?.enabled)).toEqual([true, false]);
    await dss.loadSetting();
    expect(dss.values()?.hybrid?.enabled).toBe(false); expect(service.allowed()).toBe(false);
  });

  it('stops a just-enabled Hybrid when confirmed Advanced turns Off during its save', async () => {
    const { service, appSetting, dss, driverSave } = await fixture({ advanceMode: true }); await service.start();
    const held = holdWrite(driverPath), enable = service.setEnabled(true);
    await held.entered;
    put(appPath, { advanceMode: false }); await appSetting.loadSetting(); await tick();
    expect(service.allowed()).toBe(false);
    held.release(); expect(await enable).toBe(false); await service.idle();
    expect(driverSave.mock.calls.map(([value]) => value.hybrid?.enabled)).toEqual([true, false]);
    await dss.loadSetting(); await service.idle();
    expect(dss.values()?.hybrid?.enabled).toBe(false); expect(service.error()).toBeUndefined();
  });
});

describe('lifetime reload reconciliation', () => {
  it('reconciles a real driver reload but ignores optimistic values and failed save rollback', async () => {
    const { service, dss, driverSave } = await fixture(); await service.start();
    disk.rejected.add(driverPath);
    expect(await dss.save({ ...dss.values()!, hybrid: { ...dss.values()!.hybrid!, enabled: true } })).toBe(false);
    await service.idle(); expect(driverSave).toHaveBeenCalledOnce();
    disk.rejected.clear();
    put(driverPath, { hybrid: { enabled: true, guardDegrees: 17 } }); await dss.loadSetting(); await service.idle();
    expect(stored(driverPath).hybrid).toMatchObject({ enabled: false, guardDegrees: 17 });
    expect(driverSave).toHaveBeenCalledTimes(2);
  });

  it('reconciles a confirmed external Advanced Off reload', async () => {
    const { service, appSetting } = await fixture({ advanceMode: true }, { hybrid: { enabled: true, featherPx: 23 } });
    await service.start(); put(appPath, { advanceMode: false }); await appSetting.loadSetting(); await service.idle();
    expect(service.allowed()).toBe(false); expect(stored(driverPath).hybrid).toMatchObject({ enabled: false, featherPx: 23 });
  });

  it('latches a failed startup stop until explicit reload, then retries without a watch/save loop', async () => {
    const { service, driverSave } = await fixture({}, { hybrid: { enabled: true } });
    disk.rejected.add(driverPath); await service.start(); await service.idle();
    expect(driverSave).toHaveBeenCalledOnce(); expect(service.error()).toContain('permissions');
    disk.rejected.clear(); await tick(); await service.idle(); expect(driverSave).toHaveBeenCalledOnce();
    await service.retry(); await service.idle();
    expect(driverSave).toHaveBeenCalledTimes(2); expect(stored(driverPath).hybrid.enabled).toBe(false);
    expect(service.error()).toBeUndefined();
  });

  it('permits a real external reload to retry a latched failure', async () => {
    const { service, dss, driverSave } = await fixture({}, { hybrid: { enabled: true } });
    disk.rejected.add(driverPath); await service.start();
    disk.rejected.clear(); put(driverPath, { hybrid: { enabled: true, featherPx: 29 } });
    await dss.loadSetting(); await service.idle();
    expect(driverSave).toHaveBeenCalledTimes(2); expect(stored(driverPath).hybrid).toMatchObject({ enabled: false, featherPx: 29 });
  });

  it('rereads repaired preferences on explicit retry without replaying a rejected toggle', async () => {
    const { service, appSave } = await fixture('{broken', { hybrid: { enabled: true } }); await service.start();
    expect(await service.setAdvancedMode(true)).toBe(false);
    put(appPath, { advanceMode: false }); await service.retry();
    expect(service.allowed()).toBe(false); expect(stored(driverPath).hybrid.enabled).toBe(false);
    expect(appSave).not.toHaveBeenCalled(); expect(service.error()).toBeUndefined();
  });

  it('reports an externally saved conflict discovered by inspection without writing until explicit reload', async () => {
    const { service, appSetting, dss, driverSave, appSave } = await fixture({ advanceMode: true });
    await service.start();
    appSetting.inspecting = dss.inspecting = true;
    put(appPath, { advanceMode: false }); put(driverPath, { hybrid: { enabled: true, featherPx: 12 } });
    await appSetting.loadSetting(); await dss.loadSetting(); await service.idle();
    expect(service.allowed()).toBe(false);
    expect(service.error()).toBe('Hybrid is saved On while Advanced Mode is off. Reload settings to turn Hybrid off.');
    expect(driverSave).not.toHaveBeenCalled(); expect(appSave).not.toHaveBeenCalled(); expect(disk.writes).toEqual([]);
    expect(stored(driverPath).hybrid.enabled).toBe(true);
    appSetting.inspecting = dss.inspecting = false;
    await tick(); await service.idle(); expect(driverSave).not.toHaveBeenCalled();
    await service.retry();
    expect(driverSave).toHaveBeenCalledOnce(); expect(stored(driverPath).hybrid).toMatchObject({ enabled: false, featherPx: 12 });
    expect(appSave).not.toHaveBeenCalled(); expect(service.error()).toBeUndefined();
  });

  it.each([false, true])('does not report a conflict for a healthy inspected Advanced %s snapshot', async advanced => {
    const { service, appSetting, dss, driverSave, appSave } = await fixture({ advanceMode: true }, { hybrid: { enabled: true } });
    await service.start();
    appSetting.inspecting = dss.inspecting = true;
    put(appPath, { advanceMode: advanced }); put(driverPath, { hybrid: { enabled: advanced, featherPx: 31 } });
    await appSetting.loadSetting(); await dss.loadSetting(); await service.idle();
    expect(service.error()).toBeUndefined(); expect(service.allowed()).toBe(advanced);
    expect(driverSave).not.toHaveBeenCalled(); expect(appSave).not.toHaveBeenCalled(); expect(disk.writes).toEqual([]);
    appSetting.inspecting = dss.inspecting = false;
  });

  it('rejects explicit setting writes during read-only inspection', async () => {
    const { service, dss, driverSave, appSave } = await fixture(); await service.start();
    dss.inspecting = true;
    expect(await service.setAdvancedMode(true)).toBe(false);
    expect(service.error()).toContain('Settings are being inspected');
    expect(driverSave).not.toHaveBeenCalled(); expect(appSave).not.toHaveBeenCalled(); expect(disk.writes).toEqual([]);
  });

  it('unsubscribes on dispose and abandons queued operations waiting for initialization', async () => {
    const { service, appSetting, driverSave, appSave } = await fixture();
    const loaded = deferred<void>(); Object.defineProperty(appSetting, 'initTask', { value: loaded.promise });
    const starting = service.start(), changing = service.setAdvancedMode(true);
    service.dispose(); loaded.resolve(); await starting; expect(await changing).toBe(false);
    expect(driverSave).not.toHaveBeenCalled(); expect(appSave).not.toHaveBeenCalled();
    expect(service.changing()).toBe(false);

    const active = await fixture({ advanceMode: true }, { hybrid: { enabled: true } });
    await active.service.start(); active.service.dispose();
    put(appPath, { advanceMode: false }); await active.appSetting.loadSetting(); await active.service.idle();
    expect(active.driverSave).not.toHaveBeenCalled(); expect(stored(driverPath).hybrid.enabled).toBe(true);
  });

  it('does not save Advanced after disposal during the native Off save', async () => {
    const { service, appSave } = await fixture({ advanceMode: true }, { hybrid: { enabled: true } }); await service.start();
    const held = holdWrite(driverPath), changing = service.setAdvancedMode(false);
    await held.entered; service.dispose(); held.release();
    expect(await changing).toBe(false); expect(appSave).not.toHaveBeenCalled();
    expect(stored(driverPath).hybrid.enabled).toBe(false); expect(stored(appPath).advanceMode).toBe(true);
  });
});
