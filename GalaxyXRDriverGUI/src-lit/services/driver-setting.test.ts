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

async function load(vendor: string, stored: object = {}) {
  storage.vendor = vendor;
  storage.files.set(filePath, JSON.stringify(stored));
  const paths = { settingPath: filePath, appDataDirPath: '/settings' } as PathsService;
  // No info.json has been published: exercise the offline-default path.
  const info = { values: () => undefined } as unknown as DriverInfoService;
  const service = new DriverSettingService(paths, info, () => ({ updateMode: 'rewrite' } as any));
  services.push(service);
  await service.initTask;
  expect(service.readFileError()).toBeUndefined();
  return service;
}

beforeEach(() => { storage.files.clear(); });
afterEach(() => { for (const service of services.splice(0)) service.dispose(); });

describe('vendor defaults before info.json exists', () => {
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
    expect(state.settings?.streamFrameSchema).toBe(4);
    expect(state.controllerSettings).toMatchObject({
      mirrorOffsetsForRightHand: false,
      rotationOffsetDeg: { x: 0, y: 0, z: 0 },
      positionOffsetCm: { x: 0, y: 0, z: 0 },
      left,
    });
    expect(JSON.parse(storage.files.get(filePath)!).streamFrame.streamFrameSchema).toBe(4);
    expect(await service.loadSetting()).toBe(true);
    expect(service.values()?.controllers).toMatchObject({
      mirrorOffsetsForRightHand: false,
      rotationOffsetDeg: { x: 0, y: 0, z: 0 },
      positionOffsetCm: { x: 0, y: 0, z: 0 },
      left,
    });
  });
});
