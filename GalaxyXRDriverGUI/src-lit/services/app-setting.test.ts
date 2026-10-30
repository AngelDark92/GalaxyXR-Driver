import { afterEach, expect, it, vi } from 'vitest';
import { AppSettingService } from './app-setting';
import type { PathsService } from './paths';

const disk = vi.hoisted(() => ({ content: '{}', reject: false }));
vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: async () => true, mkdir: async () => {}, watchImmediate: async () => () => {},
  readTextFile: async () => disk.content,
  writeTextFile: async (_path: string, content: string) => {
    if (disk.reject) throw new Error('read-only preferences');
    disk.content = content;
  },
}));
const services: AppSettingService[] = [];
async function load(content: string) {
  disk.content = content; disk.reject = false;
  const service = new AppSettingService({ guiSettingPath: '/prefs/gui-settings.json', appDataDirPath: '/prefs' } as PathsService);
  services.push(service); await service.initTask;
  return service;
}
afterEach(() => { for (const s of services.splice(0)) s.dispose(); vi.useRealTimers(); });

it('defaults a missing tray key on without writing the old preferences file', async () => {
  const s = await load('{"colorScheme":"light"}');
  expect(s.values().minimizeToTray).toBe(true);
  expect(s.confirmedValues()?.minimizeToTray).toBe(true);
  expect(disk.content).toBe('{"colorScheme":"light"}');
});

it('retains an explicit opt-out through save and reload', async () => {
  vi.useFakeTimers();
  const s = await load('{"minimizeToTray":false}');
  expect(s.confirmedValues()?.minimizeToTray).toBe(false);
  const saved = s.save({ ...s.values(), colorScheme: 'light' });
  await vi.advanceTimersByTimeAsync(100);
  expect(await saved).toBe(true);
  expect(JSON.parse(disk.content).minimizeToTray).toBe(false);
  await s.loadSetting();
  expect(s.confirmedValues()?.minimizeToTray).toBe(false);
});

it('does not publish optimistic or failed edits as confirmed native policy', async () => {
  vi.useFakeTimers();
  const s = await load('{}');
  disk.reject = true;
  const saved = s.save({ ...s.values(), minimizeToTray: false });
  await Promise.resolve();
  expect(s.values().minimizeToTray).toBe(false);
  expect(s.confirmedValues()?.minimizeToTray).toBe(true);
  await vi.advanceTimersByTimeAsync(100);
  expect(await saved).toBe(false);
  expect(s.values().minimizeToTray).toBe(true);
  expect(s.confirmedValues()?.minimizeToTray).toBe(true);
});

it('invalidates confirmed policy when preferences become unreadable', async () => {
  const s = await load('{"minimizeToTray":true}');
  disk.content = '{broken';
  expect(await s.loadSetting()).toBe(false);
  expect(s.confirmedValues()).toBeUndefined();
  expect(s.readFileError()).toBeDefined();
});

it('defaults the render slider link on and persists an explicit opt-out', async () => {
  vi.useFakeTimers();
  const s = await load('{}');
  expect(s.values().renderResolutionLinked).toBe(true);
  const saved = s.save({ ...s.values(), renderResolutionLinked: false });
  await vi.advanceTimersByTimeAsync(100);
  expect(await saved).toBe(true);
  expect(JSON.parse(disk.content).renderResolutionLinked).toBe(false);
  await s.loadSetting();
  expect(s.values().renderResolutionLinked).toBe(false);
});
