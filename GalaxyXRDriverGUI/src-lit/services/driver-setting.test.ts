import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DriverSettingService } from './driver-setting';
import type { DriverInfoService } from './driver-info';
import type { PathsService } from './paths';
import { driverDefaults } from '../domain/driver-defaults';
import { GalaxySettingsBase } from '../state/galaxy-settings';

const storage = vi.hoisted(() => ({
  vendor: 'galaxyxr',
  files: new Map<string, string>(),
}));

vi.mock('../environment', () => ({ get vendor() { return storage.vendor; } }));
vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: async (path: string) => path === '/settings' || storage.files.has(path),
  mkdir: async () => {},
  readTextFile: async (path: string) => {
    const value = storage.files.get(path);
    if (value === undefined) throw new Error(`Missing virtual file: ${path}`);
    return value;
  },
  writeTextFile: async (path: string, value: string) => { storage.files.set(path, value); },
  watchImmediate: async () => () => {},
  copyFile: async (source: string, target: string) => { storage.files.set(target, storage.files.get(source)!); },
  remove: async (path: string) => { storage.files.delete(path); },
}));

const filePath = '/settings/settings.json';
const services: DriverSettingService[] = [];
// Config.h in the user-selected CustomHeadsetOpenVrGxR reference, 2026-09-26;
// Force CBR OFF per the 2026-10-23 owner directive.
// Literal expectations pin parity independently of generated GUI defaults.
const referenceEncoderDefaults = {
  nvencTap: true, nvencFixLevel: true, nvencBitrateMbit: 0, nvencBandwidthOverrideMbit: 0,
  nvencSettingsVersion: 0, nvencMaxQp: 0, nvencAqStrength: 0, nvencMinQp: 0,
  nvencMinQpIntra: 0, nvencForceCbr: false, nvencLowDelayKfScale: 2,
  nvencMaxBitrateHeadroomPct: 0, nvencVbvFrames: 2, nvencForceFps: 90,
  nvencBitrateCurve: 0, nvencBitrateConstancyPct: 0, nvencPreset: 0,
  nvencPresetMerge: true, nvencVuiFullRange: -1, nvencVuiMatrix: -1,
  nvencVuiPrimaries: -1, nvencVuiTransfer: -1, nvencSplitMode: 1,
  nvencQpFovea: 0, nvencQpPeriphery: 0, nvencVerbose: false,
};

async function load(vendor: string, stored: object = {}, infoDefaults?: object) {
  storage.vendor = vendor;
  storage.files.set(filePath, JSON.stringify(stored));
  const paths = { settingPath: filePath, appDataDirPath: '/settings' } as PathsService;
  const info = { values: () => infoDefaults ? { defaultSettings: infoDefaults } : undefined } as unknown as DriverInfoService;
  const service = new DriverSettingService(paths, info, () => ({ updateMode: 'rewrite' } as any));
  services.push(service);
  await service.initTask;
  expect(service.readFileError()).toBeUndefined();
  return service;
}

beforeEach(() => { storage.files.clear(); });
afterEach(() => { for (const service of services.splice(0)) service.dispose(); });

describe('vendor defaults before info.json exists', () => {
  it.each(['', 'galaxyxr'])('initializes absent %s encoder controls with the reference defaults', async vendor => {
    const service = await load(vendor);
    expect(service.values()?.streamFrame).toMatchObject(referenceEncoderDefaults);
    const state = new GalaxySettingsBase({ values: () => ({}) } as any, service, { values: () => undefined } as any);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    await service.flush();
    expect(state.settings).toMatchObject({ ...referenceEncoderDefaults, nvencSettingsVersion: 4 });
    expect(await service.loadSetting()).toBe(true);
    expect(service.values()?.streamFrame).toMatchObject({ ...referenceEncoderDefaults, nvencSettingsVersion: 4 });
  });

  it.each(['', 'galaxyxr'])('pins the SDR10 default On for the %s build against stale info.json telemetry while a stored Off wins', async vendor => {
    const stale = await load(vendor, {}, { galaxyXr: { sdr10Baseline: false } });
    expect(stale.values()?.galaxyXr?.sdr10Baseline).toBe(true);
    const stored = await load(vendor, { galaxyXr: { sdr10Baseline: false } }, { galaxyXr: { sdr10Baseline: true } });
    expect(stored.values()?.galaxyXr?.sdr10Baseline).toBe(false);
  });

  it.each(['', 'galaxyxr'])('uses the installed %s encoder defaults when runtime telemetry is stale', async vendor => {
    const encoderDefaults = Object.fromEntries(Object.entries(driverDefaults.streamFrame!)
      .filter(([key]) => key.startsWith('nvenc') || key === 'postPack'));
    const stale = Object.fromEntries(Object.entries(encoderDefaults).map(([key, value]) => [key,
      typeof value === 'boolean' ? !value : typeof value === 'number' ? value + 1 : { enable: false, casEnable: false, limitedRange: false },
    ]));
    const published = { streamFrame: { ...stale, saturation: 42 } };
    const before = structuredClone(published);
    const service = await load(vendor, {}, published);
    expect(service.values()?.streamFrame).toMatchObject(encoderDefaults);
    // Other driver-published defaults remain supported.
    expect(service.values()?.streamFrame?.saturation).toBe(42);
    expect(published).toEqual(before);
  });

  it('retains explicit encoder and post-pack Off choices against stale Off telemetry', async () => {
    const stock = {
      nvencSettingsVersion: 4, nvencTap: false, nvencFixLevel: false,
      nvencForceCbr: false, nvencBitrateConstancyPct: 100, nvencPresetMerge: false,
      postPack: { enable: false, casEnable: false, limitedRange: false },
    };
    const service = await load('galaxyxr', { streamFrame: stock }, { streamFrame: stock });
    expect(service.values()?.streamFrame).toMatchObject(stock);
    expect(await service.save(service.values()!)).toBe(true);
    // 2026-10-19: a stored key stays explicit even at its default, so the
    // user's Off choice remains in settings.json and reads back Off.
    const savedStock = JSON.parse(storage.files.get(filePath)!).streamFrame;
    expect(savedStock).toMatchObject(stock);
    expect(savedStock.postPack.limitedRange).toBe(false);
    expect(await service.loadSetting()).toBe(true);
    expect(service.values()?.streamFrame).toMatchObject(stock);
  });

  it.each([0, 2, 3, 4])('retains schema %s custom encoder tuning through migration, sparse save and reopening', async version => {
    const chosen = {
      nvencTap: false, nvencVbvFrames: 5, nvencLowDelayKfScale: 4,
      nvencMaxBitrateHeadroomPct: 20, nvencForceFps: 72, nvencSplitMode: 3,
      nvencPreset: 7, nvencAqStrength: 4, nvencMinQp: 5, nvencMinQpIntra: 7,
      nvencMaxQp: 31, nvencVuiFullRange: 1, nvencVuiMatrix: 1,
      nvencVuiPrimaries: 1, nvencVuiTransfer: 1,
      nvencBitrateMbit: 123, nvencBandwidthOverrideMbit: 234,
    };
    const service = await load('galaxyxr', {
      galaxyXr: { sdr10SettingsVersion: 2, customStreamFormatWidth: 1856 },
      streamFrame: { streamFrameSchema: 4, nvencSettingsVersion: version, ...chosen },
    });
    const state = new GalaxySettingsBase({ values: () => ({}) } as any, service, { values: () => undefined } as any);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    await service.flush();
    expect(state.settings).toMatchObject({ ...chosen, nvencSettingsVersion: 4 });
    expect(await service.save(service.values()!)).toBe(true);
    const persisted = JSON.parse(storage.files.get(filePath)!);
    expect(persisted.streamFrame).toMatchObject({ ...chosen, nvencSettingsVersion: 4 });
    expect(persisted.galaxyXr.customStreamFormatWidth).toBe(1856);
    service.dispose();
    const reopened = await load('galaxyxr', persisted);
    expect(reopened.values()?.streamFrame).toMatchObject({ ...chosen, nvencSettingsVersion: 4 });
    expect(reopened.values()?.galaxyXr?.customStreamFormatWidth).toBe(1856);
  });

  it.each(['', 'galaxyxr'])('resets %s encoder controls through GalaxySettingsBase using package defaults', async vendor => {
    const old = {
      nvencTap: false, nvencFixLevel: false, nvencForceCbr: false, nvencPresetMerge: false,
      nvencForceFps: 75, nvencSplitMode: 15,
      postPack: { enable: false, casEnable: false, limitedRange: false },
    };
    const info = { values: () => ({ defaultSettings: { streamFrame: old } }) } as unknown as DriverInfoService;
    const service = await load(vendor, {
      streamFrame: { streamFrameSchema: 4, nvencSettingsVersion: 4, ...old },
    }, { streamFrame: old });
    const state = new GalaxySettingsBase({ values: () => ({}) } as any, service, info);
    expect(state.defaults).toMatchObject(referenceEncoderDefaults);
    expect(state.defaults.postPack).toMatchObject({ enable: true, casEnable: true, limitedRange: false });
    for (const key of ['nvencTap', 'nvencFixLevel', 'nvencForceCbr', 'nvencPresetMerge', 'nvencForceFps', 'nvencSplitMode', 'postPack'] as const) {
      state.reset(key);
    }
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    await service.flush();
    expect(state.settings).toMatchObject({ ...referenceEncoderDefaults, nvencSettingsVersion: 4 });
    expect(state.settings?.postPack).toMatchObject({ enable: true, casEnable: true, limitedRange: false });
    expect(await service.loadSetting()).toBe(true);
    expect(service.values()?.streamFrame).toMatchObject({ ...referenceEncoderDefaults, nvencSettingsVersion: 4 });
    expect(service.values()?.streamFrame?.postPack).toMatchObject({ enable: true, casEnable: true, limitedRange: false });
  });

  it('serializes the async spacewarp toggle and resets it to the native default (2026-10-17)', async () => {
    const service = await load('galaxyxr', { streamFrame: { streamFrameSchema: 5, nvencSettingsVersion: 4, spacewarpEnable: true } });
    expect(service.values()?.streamFrame?.spacewarpEnable).toBe(true);
    const state = new GalaxySettingsBase({ values: () => ({}) } as any, service, { values: () => undefined } as any);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    // an old info.json without the key publishes no default for it
    expect(state.defaults.spacewarpEnable).toBe(false);
    await service.flush();
    expect(state.settings?.spacewarpEnable).toBe(true);
    state.reset('spacewarpEnable');
    expect(state.settings?.spacewarpEnable).toBe(false); // native default
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    await service.flush();
    const persisted = JSON.parse(storage.files.get(filePath)!);
    // 2026-10-19: a stored key restored to its default stays explicit.
    expect(persisted.streamFrame.spacewarpEnable).toBe(false);
    const reopened = await load('galaxyxr', persisted);
    expect(reopened.values()?.streamFrame?.spacewarpEnable).toBe(false);
  });

  it('preserves a saved legacy encoder-off profile through migrations, sparse saves and reloads', async () => {
    const stock = {
      nvencSettingsVersion: 4, nvencTap: false, nvencFixLevel: false,
      nvencForceCbr: false, nvencBitrateConstancyPct: 100, nvencPresetMerge: false,
      nvencVbvFrames: 0, nvencLowDelayKfScale: 0, nvencForceFps: 0, nvencSplitMode: 0,
      postPack: { enable: false, casEnable: false },
    };
    // Clean Settings leaves other schema versions absent: their migrations may
    // save, but must never reactivate these explicit encoder choices.
    const service = await load('galaxyxr', { streamFrame: stock });
    const state = new GalaxySettingsBase({ values: () => ({}) } as any, service, { values: () => undefined } as any);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    await service.flush();
    expect(state.settings).toMatchObject(stock);
    expect(JSON.parse(storage.files.get(filePath)!).streamFrame).toMatchObject(stock);
    expect(await service.save(service.values()!)).toBe(true);
    expect(await service.loadSetting()).toBe(true);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    await service.flush();
    expect(state.settings).toMatchObject(stock);
    expect(service.values()?.streamFrame).toMatchObject(stock);
    expect(JSON.parse(storage.files.get(filePath)!).streamFrame).toMatchObject(stock);
  });

  it.each(['', 'galaxyxr'])('keeps Hitch Diagnostics off by default for %s and preserves opt-in on reload', async vendor => {
    const service = await load(vendor);
    expect(service.values()?.streamFrame?.hitchDiag).toBe(false);
    service.values()!.streamFrame!.hitchDiag = true;
    expect(await service.save(service.values()!)).toBe(true);
    expect(JSON.parse(storage.files.get(filePath)!).streamFrame.hitchDiag).toBe(true);
    expect(await service.loadSetting()).toBe(true);
    expect(service.values()?.streamFrame?.hitchDiag).toBe(true);
  });

  it.each([
    ['', false],
    ['galaxyxr', true],
  ] as const)('uses the native %s default for omitted settings', async (vendor, expected) => {
    const service = await load(vendor);
    expect(service.values()?.galaxyXr?.nativeIdentity).toBe(expected);
    expect(service.values()?.controllers?.mirrorOffsetsForRightHand).toBe(expected);
    expect(service.values()?.controllers?.rotationOffsetDeg).toEqual({ x: 0, y: expected ? 5 : 0, z: 0 });
    expect(service.values()?.controllers?.positionOffsetCm).toEqual({ x: expected ? 0.5 : 0, y: 0, z: 0 });
    expect(storage.files.get(filePath)).toBe('{}');
    // Resolving a vendor must never mutate the shared generated defaults.
    expect(driverDefaults.galaxyXr?.nativeIdentity).toBe(true);
    expect(driverDefaults.controllers?.mirrorOffsetsForRightHand).toBe(true);
    expect(driverDefaults.controllers?.rotationOffsetDeg).toEqual({ x: 0, y: 5, z: 0 });
    expect(driverDefaults.controllers?.positionOffsetCm).toEqual({ x: 0.5, y: 0, z: 0 });
  });

  it('drops the removed Game Link velocity cutoff keys on load and save', async () => {
    const service = await load('galaxyxr', { streamFrame: { gameLinkLinearVelocityCutoff: 0.1, gameLinkAngularVelocityCutoffDeg: 5, saturation: 1.1 } });
    expect(service.values()?.streamFrame).not.toHaveProperty('gameLinkLinearVelocityCutoff');
    expect(service.values()?.streamFrame).not.toHaveProperty('gameLinkAngularVelocityCutoffDeg');
    expect(await service.save(service.values()!)).toBe(true);
    const stored = JSON.parse(storage.files.get(filePath)!);
    expect(stored.streamFrame).not.toHaveProperty('gameLinkLinearVelocityCutoff');
    expect(stored.streamFrame).not.toHaveProperty('gameLinkAngularVelocityCutoffDeg');
    expect(stored.streamFrame.saturation).toBe(1.1);
  });

  it('retains an explicit true in the neutral build through save and reload', async () => {
    const service = await load('', { galaxyXr: { nativeIdentity: true } });
    expect(service.values()?.galaxyXr?.nativeIdentity).toBe(true);
    expect(await service.save(service.values()!)).toBe(true);
    const stored = JSON.parse(storage.files.get(filePath)!);
    expect(stored.galaxyXr.nativeIdentity).toBe(true);
    expect(await service.loadSetting()).toBe(true);
    expect(service.values()?.galaxyXr?.nativeIdentity).toBe(true);
  });

  it('preserves an explicit false in the Galaxy XR build through save and reload', async () => {
    const service = await load('galaxyxr', { galaxyXr: { nativeIdentity: false } });
    expect(service.values()?.galaxyXr?.nativeIdentity).toBe(false);
    expect(await service.save(service.values()!)).toBe(true);
    const stored = JSON.parse(storage.files.get(filePath)!);
    expect(stored.galaxyXr.nativeIdentity).toBe(false);
    expect(await service.loadSetting()).toBe(true);
    expect(service.values()?.galaxyXr?.nativeIdentity).toBe(false);
  });

  it('retains explicit controller corrections in the neutral build', async () => {
    const tuning = {
      mirrorOffsetsForRightHand: true,
      rotationOffsetDeg: { x: 0, y: 5, z: 0 },
      positionOffsetCm: { x: 0.5, y: 0, z: 0 },
    };
    const service = await load('', { controllers: tuning });
    expect(service.values()?.controllers).toMatchObject(tuning);
    expect(await service.save(service.values()!)).toBe(true);
    const stored = JSON.parse(storage.files.get(filePath)!);
    expect(stored.controllers.mirrorOffsetsForRightHand).toBe(true);
    expect(stored.controllers.rotationOffsetDeg.y).toBe(5);
    expect(stored.controllers.positionOffsetCm.x).toBe(0.5);
    expect(await service.loadSetting()).toBe(true);
    expect(service.values()?.controllers).toMatchObject(tuning);
  });

  it('uses neutral controller defaults for explicit resets while preserving other tuning', async () => {
    const service = await load('', {
      streamFrame: { streamFrameSchema: 4, nvencSettingsVersion: 4 },
      controllers: {
        mirrorOffsetsForRightHand: true,
        rotationOffsetDeg: { x: 1, y: 9, z: 2 },
        positionOffsetCm: { x: 3, y: 4, z: 5 },
      },
    });
    const state = new GalaxySettingsBase({ values: () => ({}) } as any, service, { values: () => undefined } as any);
    expect(state.controllerDefaults).toMatchObject({
      mirrorOffsetsForRightHand: false,
      rotationOffsetDeg: { x: 0, y: 0, z: 0 },
      positionOffsetCm: { x: 0, y: 0, z: 0 },
    });
    state.resetControllers('rotationOffsetDeg');
    state.resetControllers('mirrorOffsetsForRightHand');
    // Let queued save calls reach the real writer before draining it.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    await service.flush();
    expect(state.controllerSettings).toMatchObject({
      mirrorOffsetsForRightHand: false,
      rotationOffsetDeg: { x: 0, y: 0, z: 0 },
      positionOffsetCm: { x: 3, y: 4, z: 5 },
    });
    expect(await service.loadSetting()).toBe(true);
    expect(service.values()?.controllers).toMatchObject({
      mirrorOffsetsForRightHand: false,
      rotationOffsetDeg: { x: 0, y: 0, z: 0 },
      positionOffsetCm: { x: 3, y: 4, z: 5 },
    });
  });

  it('uses neutral shared offsets in schema-4 migration and preserves per-hand trims', async () => {
    const left = {
      rotationOffsetDeg: { x: 1, y: 2, z: 3 },
      positionOffsetCm: { x: 4, y: 5, z: 6 },
    };
    const service = await load('', {
      streamFrame: { streamFrameSchema: 3, nvencSettingsVersion: 4 },
      controllers: {
        mirrorOffsetsForRightHand: true,
        rotationOffsetDeg: { x: 2, y: 8, z: 1 },
        positionOffsetCm: { x: 3, y: 7, z: 4 },
        left,
      },
    });
    const state = new GalaxySettingsBase({ values: () => ({}) } as any, service, { values: () => undefined } as any);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    await service.flush();
    expect(state.settings?.streamFrameSchema).toBe(5);
    expect(state.controllerSettings).toMatchObject({
      mirrorOffsetsForRightHand: false,
      rotationOffsetDeg: { x: 0, y: 0, z: 0 },
      positionOffsetCm: { x: 0, y: 0, z: 0 },
      left,
    });
    expect(JSON.parse(storage.files.get(filePath)!).streamFrame.streamFrameSchema).toBe(5);
    expect(await service.loadSetting()).toBe(true);
    expect(service.values()?.controllers).toMatchObject({
      mirrorOffsetsForRightHand: false,
      rotationOffsetDeg: { x: 0, y: 0, z: 0 },
      positionOffsetCm: { x: 0, y: 0, z: 0 },
      left,
    });
  });
});

describe('retired HAL timestamp compensation', () => {
  it.each(['', 'galaxyxr'])('removes saved and stale telemetry bias for %s without changing tuning', async vendor => {
    const retired = { poseTimeOffsetBiasMs: 30, poseTimeOffsetBiasEnabled: true };
    const service = await load(vendor, { streamFrame: { ...retired, saturation: 1.23 } }, { streamFrame: retired });
    for (const key of Object.keys(retired)) expect(service.values()?.streamFrame).not.toHaveProperty(key);
    expect(service.values()?.streamFrame?.saturation).toBe(1.23);
    expect(await service.save(service.values()!)).toBe(true);
    const saved = JSON.parse(storage.files.get(filePath)!);
    for (const key of Object.keys(retired)) expect(saved.streamFrame).not.toHaveProperty(key);
    expect(saved.streamFrame.saturation).toBe(1.23);
    expect(await service.loadSetting()).toBe(true);
    for (const key of Object.keys(retired)) expect(service.values()?.streamFrame).not.toHaveProperty(key);
  });
});

// 2026-10-21: the No-fallback select is retired. Its stored choice is honoured
// once as Bitrate Constancy 100 %, the key is pruned, and nothing else moves.
describe('retired Bitrate Fallback select', () => {
  it.each(['', 'galaxyxr'])('raises constancy once and prunes the key for %s', async vendor => {
    const service = await load(vendor,
      { streamFrame: { nvencVrlinkFallbackMode: 1, nvencBitrateConstancyPct: 35, nvencBitrateCurve: 1 } },
      { streamFrame: { nvencVrlinkFallbackMode: 1, nvencBitrateConstancyPct: 35, nvencBitrateCurve: 1 } });
    expect(service.values()?.streamFrame).not.toHaveProperty('nvencVrlinkFallbackMode');
    expect(service.values()?.streamFrame?.nvencBitrateConstancyPct).toBe(100);
    expect(service.values()?.streamFrame?.nvencBitrateCurve).toBe(1);
    expect(await service.save(service.values()!)).toBe(true);
    const saved = JSON.parse(storage.files.get(filePath)!);
    expect(saved.streamFrame).not.toHaveProperty('nvencVrlinkFallbackMode');
  });

  it('leaves an explicit constancy and the key-free install alone', async () => {
    const service = await load('galaxyxr', { streamFrame: { nvencBitrateConstancyPct: 60 } },
      { streamFrame: { nvencBitrateConstancyPct: 60 } });
    expect(service.values()?.streamFrame?.nvencBitrateConstancyPct).toBe(60);
  });
});

describe('reinstall default materialization', () => {
  it('writes current defaults for absent settings without overwriting saved values', async () => {
    const service = await load('galaxyxr', { streamFrame: { saturation: 1.25 } });
    expect(await service.materializeDefaults()).toBe(true);
    const saved = JSON.parse(storage.files.get(filePath)!);
    expect(saved.streamFrame.saturation).toBe(1.25);
    expect(saved.streamFrame.gamma).toBe(driverDefaults.streamFrame!.gamma);
    expect(saved.galaxyXr.nativeIdentity).toBe(true);
  });

  it('keeps materialized defaults through a later save of another setting', async () => {
    const service = await load('galaxyxr', { streamFrame: { saturation: 1.25 } });
    expect(await service.materializeDefaults()).toBe(true);
    const values = service.values()!;
    expect(await service.save({ ...values, streamFrame: { ...values.streamFrame!, saturation: 1.3 } })).toBe(true);
    const saved = JSON.parse(storage.files.get(filePath)!);
    expect(saved.streamFrame.saturation).toBe(1.3);
    expect(saved.streamFrame).toHaveProperty('gamma');
    expect(saved.streamFrame.gamma).toBe(driverDefaults.streamFrame!.gamma);
  });

  it('materializes the bundled default instead of a stale telemetry default', async () => {
    const service = await load('galaxyxr', { streamFrame: { saturation: 1.25 } }, { streamFrame: { gamma: 1.1 } });
    expect(service.values()?.streamFrame?.gamma).toBe(1.1);
    expect(await service.materializeDefaults()).toBe(true);
    const saved = JSON.parse(storage.files.get(filePath)!);
    expect(saved.streamFrame.gamma).toBe(driverDefaults.streamFrame!.gamma);
    expect(saved.streamFrame.gamma).not.toBe(1.1);
  });

  it('does not resurrect retired keys when materializing', async () => {
    const service = await load('galaxyxr', { streamFrame: { saturation: 1.25, poseTimeOffsetBiasMs: 30 } });
    expect(await service.materializeDefaults()).toBe(true);
    const saved = JSON.parse(storage.files.get(filePath)!);
    expect(saved.streamFrame).not.toHaveProperty('poseTimeOffsetBiasMs');
  });
});
