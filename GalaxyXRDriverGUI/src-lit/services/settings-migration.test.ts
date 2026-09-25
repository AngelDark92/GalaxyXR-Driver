import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DriverSettingService } from './driver-setting';
import { GalaxySettingsBase } from '../state/galaxy-settings';

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
async function load(streamFrame: object) {
  disk.content = JSON.stringify({ streamFrame });
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
});
