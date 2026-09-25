import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DriverSettingService } from './driver-setting';
import { GalaxySettingsBase } from '../state/galaxy-settings';
import { driverDefaults } from '../domain/driver-defaults';

const disk = vi.hoisted(() => ({ content: '', attempts: 0, rejectWrites: false }));
vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: async () => true,
  mkdir: async () => {},
  readTextFile: async () => disk.content,
  watchImmediate: async () => () => {},
  writeTextFile: async (_path: string, content: string) => {
    disk.attempts++;
    if (disk.rejectWrites) throw new Error('Settings file is read-only');
    disk.content = content;
  },
}));

let service: DriverSettingService;
async function load(streamFrame?: object, galaxyXr: object = { sdr10SettingsVersion: 2 }) {
  if (streamFrame !== undefined) disk.content = JSON.stringify({ streamFrame, galaxyXr });
  const info = { values: () => undefined };
  service = new DriverSettingService(
    { settingPath: '/test/settings.json', appDataDirPath: '/test' } as any,
    info as any, () => ({ updateMode: 'rewrite' } as any),
  );
  await service.initTask;
  return new GalaxySettingsBase({ values: () => ({}) } as any, service, info as any);
}

beforeEach(() => { vi.useFakeTimers(); disk.attempts = 0; disk.rejectWrites = false; });
afterEach(() => { service?.dispose(); vi.useRealTimers(); });

describe('first-load settings application', () => {
  it('persists the SDR10 migration and keeps its version after a default-diff save', async () => {
    await load({ streamFrameSchema: 4, nvencSettingsVersion: 4, gamma: 1.8 }, {});
    await vi.advanceTimersByTimeAsync(1000);
    expect(disk.attempts).toBe(1);
    const saved = JSON.parse(disk.content);
    expect(saved.galaxyXr.sdr10SettingsVersion).toBe(2);
    expect(saved.galaxyXr.profileSupports10bit).toBe(false);
    expect(saved.streamFrame.gamma).toBe(1.8);
    await service.loadSetting();
    await vi.advanceTimersByTimeAsync(1000);
    expect(disk.attempts).toBe(1);
  });

  it('stops automatic migration retries on a write error and permits explicit recovery', async () => {
    disk.rejectWrites = true;
    await load({ streamFrameSchema: 4, nvencSettingsVersion: 3, nvencTap: true, cas: { enable: true, strength: 0.83 } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(disk.attempts).toBe(1);
    expect(service.writeFileError()).toContain('read-only');
    expect(JSON.parse(disk.content).streamFrame.nvencSettingsVersion).toBe(3);
    expect(service.values()?.streamFrame?.nvencSettingsVersion).toBe(3);

    disk.rejectWrites = false;
    const recovery = service.save(service.values()!);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await recovery).toBe(true);
    expect(service.writeFileError()).toBeUndefined();
    const saved = JSON.parse(disk.content).streamFrame;
    expect(saved.nvencSettingsVersion).toBe(4);
    expect(service.values()?.streamFrame?.postPack?.foveaStrength).toBe(0.83);
    const completedAttempts = disk.attempts;
    await vi.advanceTimersByTimeAsync(1000);
    expect(disk.attempts).toBe(completedAttempts);
  });

  it('loads current explicit Off choices and exact tuning without saving or toggling', async () => {
    const state = await load({
      streamFrameSchema: 4, nvencSettingsVersion: 4, enable: false, nvencTap: false,
      cas: { enable: false, strength: 0.63 }, postPack: { enable: false, casEnable: false },
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(disk.attempts).toBe(0);
    expect(state.settings?.enable).toBe(false);
    expect(state.settings?.nvencTap).toBe(false);
    expect(state.settings?.postPack?.enable).toBe(false);
    expect(state.settings?.cas?.strength).toBe(0.63);
  });

  it('persists every explicit pre-v3 encoder Off choice and reopens with current stamps', async () => {
    const off = {
      nvencTap: false, nvencFixLevel: false, nvencForceCbr: false,
      nvencBitrateScale: false, nvencPresetMerge: false,
    };
    let state = await load({
      streamFrameSchema: 4, nvencSettingsVersion: 2, ...off,
      cas: { enable: false, strength: 0.79 }, postPack: { enable: false, casEnable: false },
    }, { sdr10SettingsVersion: 2, vrlinkHeadsetProfile: false });
    await vi.advanceTimersByTimeAsync(1000);
    expect(disk.attempts).toBe(1);
    expect(state.settings).toMatchObject({ ...off, nvencSettingsVersion: 4 });
    const saved = JSON.parse(disk.content);
    expect(saved.streamFrame).toMatchObject({ ...off, streamFrameSchema: 4, nvencSettingsVersion: 4 });
    expect(saved.streamFrame.postPack).toMatchObject({ enable: false, casEnable: false });
    expect(saved.galaxyXr.vrlinkHeadsetProfile).toBe(false);
    const stableDisk = disk.content;
    service.dispose();
    state = await load();
    await vi.advanceTimersByTimeAsync(1000);
    expect(disk.attempts).toBe(1);
    expect(disk.content).toBe(stableDisk);
    expect(state.settings).toMatchObject({ ...off, nvencSettingsVersion: 4 });
    expect(state.settings?.postPack).toMatchObject({ enable: false, casEnable: false });
    expect(state.settings?.cas).toMatchObject({ enable: false, strength: 0.79 });
    expect(service.values()?.galaxyXr?.vrlinkHeadsetProfile).toBe(false);
  });

  it('keeps defaults for missing pre-v3 switches instead of treating filled values as explicit', async () => {
    const state = await load({ streamFrameSchema: 4, nvencSettingsVersion: 2 });
    await vi.advanceTimersByTimeAsync(1000);
    for (const key of ['nvencTap', 'nvencFixLevel', 'nvencForceCbr', 'nvencBitrateScale', 'nvencPresetMerge'] as const) {
      expect(state.settings?.[key], key).toBe(driverDefaults.streamFrame![key]);
    }
    expect(service.values()?.galaxyXr?.vrlinkHeadsetProfile).toBe(true);
    expect(state.settings?.postPack).toMatchObject({ enable: true, casEnable: true });
    expect(JSON.parse(disk.content).streamFrame.nvencSettingsVersion).toBe(4);
  });

  it.each([{ enable: false }, { casEnable: false }])('persists a partial explicit post-pack Off mode %j', async mode => {
    let state = await load({
      streamFrameSchema: 4, nvencSettingsVersion: 3, nvencTap: true,
      cas: { enable: true, strength: 0.91 }, postPack: { ...mode, foveaStrength: 0.23 },
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.settings?.postPack).toMatchObject({ ...mode, foveaStrength: 0.23 });
    expect(JSON.parse(disk.content).streamFrame.postPack).toMatchObject({ ...mode, foveaStrength: 0.23 });
    const completedAttempts = disk.attempts;
    service.dispose();
    state = await load();
    await vi.advanceTimersByTimeAsync(1000);
    expect(disk.attempts).toBe(completedAttempts);
    expect(state.settings?.postPack).toMatchObject({ ...mode, foveaStrength: 0.23 });
    expect(state.settings?.nvencSettingsVersion).toBe(4);
  });

  it.each([false, true])('persists legacy CAS Off while retaining independent limitedRange=%s', async limitedRange => {
    let state = await load({
      streamFrameSchema: 4, nvencSettingsVersion: 3, nvencTap: true,
      cas: { enable: false, strength: 0.87 }, postPack: { limitedRange },
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.settings?.cas?.enable).toBe(false);
    expect(state.settings?.postPack).toMatchObject({ enable: limitedRange, casEnable: false, limitedRange });
    expect(JSON.parse(disk.content).streamFrame.postPack.casEnable).toBe(false);
    const completedAttempts = disk.attempts;
    service.dispose();
    state = await load();
    await vi.advanceTimersByTimeAsync(1000);
    expect(disk.attempts).toBe(completedAttempts);
    expect(state.settings?.postPack).toMatchObject({ enable: limitedRange, casEnable: false, limitedRange });
    expect(state.settings?.cas).toMatchObject({ enable: false, strength: 0.87 });
  });

  it('migrates enabled pre-encode CAS despite post-pack defaults filled by the service', async () => {
    const state = await load({
      streamFrameSchema: 4, nvencSettingsVersion: 3, nvencTap: true,
      cas: { enable: true, strength: 0.91 },
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.settings?.cas?.enable).toBe(false);
    expect(state.settings?.postPack).toMatchObject({ enable: true, casEnable: true, foveaStrength: 0.91 });
    expect(state.settings?.nvencSettingsVersion).toBe(4);
  });
});
