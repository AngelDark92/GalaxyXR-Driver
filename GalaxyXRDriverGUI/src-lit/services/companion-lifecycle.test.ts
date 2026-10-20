import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { signal } from '../reactive';
import { setLocale } from '../locale/i18n';
import type { AppSetting } from '../domain/types';
import type { AppSettingService } from './app-setting';
import { CompanionLifecycleService } from './companion-lifecycle';

const bridge = vi.hoisted(() => ({ sync: vi.fn(), complete: vi.fn(), flush: vi.fn(), listen: vi.fn() }));
vi.mock('../platform/tauri', () => ({ sync_companion_lifecycle: bridge.sync, complete_companion_quit: bridge.complete }));
vi.mock('../platform/writer', () => ({ flushFileWrites: bridge.flush }));
vi.mock('@tauri-apps/api/event', () => ({ listen: bridge.listen }));
const handlers = new Map<string, (event: { payload: unknown }) => void>();
const services: CompanionLifecycleService[] = [];
const stops: ReturnType<typeof vi.fn>[] = [];
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(enabled = true, valid = true, beforeQuit?: () => Promise<void>) {
  const initial = { minimizeToTray: enabled } as AppSetting;
  const confirmedValues = signal<AppSetting | undefined>(valid ? initial : undefined);
  const values = signal(initial);
  const readFileError = signal<unknown>(valid ? undefined : { reason: 'Parsing failed' });
  const writeFileError = signal<string | undefined>(undefined);
  const save = vi.fn(async (next: AppSetting) => { values.set(next); confirmedValues.set(next); return true; });
  const settings = { confirmedValues, values, readFileError, writeFileError, save };
  const service = new CompanionLifecycleService(settings as unknown as AppSettingService, beforeQuit);
  services.push(service);
  return { service, settings };
}
beforeEach(() => {
  vi.resetAllMocks(); handlers.clear(); stops.length = 0; setLocale('en-US', {});
  bridge.sync.mockResolvedValue(undefined); bridge.complete.mockResolvedValue(undefined); bridge.flush.mockResolvedValue(undefined);
  bridge.listen.mockImplementation(async (name: string, callback: (event: { payload: unknown }) => void) => {
    handlers.set(name, callback);
    const stop = vi.fn(() => handlers.delete(name)); stops.push(stop); return stop;
  });
});
afterEach(() => { for (const service of services.splice(0)) service.dispose(); });

it('waits for pending OFXR commands before flushing settings and acknowledging Quit', async () => {
  const pending = deferred<void>(); const beforeQuit = vi.fn(() => pending.promise);
  const { service } = fixture(true, true, beforeQuit); await service.start();
  handlers.get('companion-quit-requested')!({ payload: 29 }); await tick();
  expect(beforeQuit).toHaveBeenCalledOnce(); expect(bridge.flush).not.toHaveBeenCalled(); expect(bridge.complete).not.toHaveBeenCalled();
  pending.resolve(); await tick();
  expect(bridge.flush).toHaveBeenCalledOnce(); expect(bridge.complete).toHaveBeenCalledWith(29, null);
});

it.each([true, false])('registers native events before applying confirmed tray preference %s', async enabled => {
  const { service } = fixture(enabled);
  bridge.sync.mockImplementation(async () => {
    expect(handlers.has('companion-quit-requested')).toBe(true);
    expect(handlers.has('companion-lifecycle-error')).toBe(true);
    expect(handlers.has('companion-quit-aborted')).toBe(true);
  });
  await Promise.all([service.start(), service.start()]);
  expect(bridge.listen).toHaveBeenCalledTimes(3);
  expect(bridge.sync).toHaveBeenCalledExactlyOnceWith(enabled, { open: 'Open Companion', quit: 'Quit', tooltip: 'Galaxy XR Companion' });
  expect(service.error()).toBeUndefined();
});

it('keeps invalid/unavailable preferences accessible without overwriting the file and recovers after a valid read', async () => {
  const { service, settings } = fixture(true, false);
  await service.start();
  expect(bridge.sync.mock.calls[0][0]).toBe(false);
  expect(service.error()).toContain('could not be read');
  expect(settings.save).not.toHaveBeenCalled();
  settings.readFileError.set(undefined);
  settings.confirmedValues.set({ minimizeToTray: true } as AppSetting);
  await tick();
  expect(bridge.sync.mock.lastCall?.[0]).toBe(true);
  expect(service.error()).toBeUndefined();
  // An uninstall/unknown snapshot also disables interception, with no rewrite.
  settings.confirmedValues.set(undefined); await tick();
  expect(bridge.sync.mock.lastCall?.[0]).toBe(false);
  expect(settings.save).not.toHaveBeenCalled();
});

it('never applies optimistic values while saving or after a failed save', async () => {
  const { service, settings } = fixture(); await service.start();
  const pending = deferred<boolean>();
  settings.save.mockImplementation(next => { settings.values.set(next); return pending.promise; });
  const save = service.setMinimizeToTray(false); await tick();
  expect(service.changing()).toBe(true);
  expect(bridge.sync).toHaveBeenCalledTimes(1);
  settings.writeFileError.set('disk full'); pending.resolve(false); await save;
  expect(bridge.sync).toHaveBeenCalledTimes(1);
  expect(service.error()).toContain('disk full'); expect(service.changing()).toBe(false);
});

it('disables native hiding when a subsequent read fails, even if the last confirmed snapshot is retained', async () => {
  const { service, settings } = fixture(); await service.start();
  settings.readFileError.set({ reason: 'Read failed', message: 'access denied' }); await tick();
  expect(bridge.sync.mock.lastCall?.[0]).toBe(false);
  expect(service.error()).toContain('stay accessible in the taskbar');
  expect(settings.save).not.toHaveBeenCalled();
});

it('applies a confirmed successful save and prevents concurrent toggles from losing preferences', async () => {
  const { service, settings } = fixture(); await service.start();
  const pending = deferred<boolean>();
  settings.save.mockImplementation(async next => {
    settings.values.set(next); const ok = await pending.promise;
    if (ok) settings.confirmedValues.set(next); return ok;
  });
  const save = service.setMinimizeToTray(false);
  await service.setMinimizeToTray(true);
  expect(settings.save).toHaveBeenCalledTimes(1);
  pending.resolve(true); await save;
  expect(bridge.sync.mock.lastCall?.[0]).toBe(false);
  expect(service.error()).toBeUndefined();
});

it('serializes native policy changes and refreshes localized labels', async () => {
  const { service, settings } = fixture(); const first = deferred<void>();
  bridge.sync.mockImplementationOnce(() => first.promise);
  const start = service.start(); await tick();
  settings.confirmedValues.set({ minimizeToTray: false } as AppSetting); await tick();
  setLocale('test', { 'Open Companion': 'Open localized', Quit: 'Quit localized' }); await tick();
  expect(bridge.sync).toHaveBeenCalledTimes(1);
  first.resolve(); await start; await tick();
  expect(bridge.sync.mock.calls.map(call => call[0])).toEqual([true, false, false]);
  expect(bridge.sync.mock.lastCall?.[1]).toMatchObject({ open: 'Open localized', quit: 'Quit localized' });
});

it('surfaces native sync and runtime errors and retries a failed policy on another confirmed save', async () => {
  const { service } = fixture(); bridge.sync.mockRejectedValueOnce(new Error('tray unavailable'));
  await expect(service.start()).resolves.toBeUndefined();
  expect(service.error()).toContain('tray unavailable');
  await service.setMinimizeToTray(true); expect(service.error()).toBeUndefined();
  handlers.get('companion-lifecycle-error')!({ payload: 'restore failed' });
  expect(service.error()).toBe('restore failed');
});

it('flushes settings before acknowledging Quit and deduplicates the same pending token', async () => {
  const { service } = fixture(); await service.start(); const flush = deferred<void>();
  bridge.flush.mockImplementation(() => flush.promise);
  handlers.get('companion-quit-requested')!({ payload: 7 });
  expect(service.quitting()).toBe(true);
  handlers.get('companion-quit-requested')!({ payload: 7 });
  await tick();
  expect(bridge.flush).toHaveBeenCalledTimes(1); expect(bridge.complete).not.toHaveBeenCalled();
  flush.resolve(); await tick();
  expect(bridge.complete).toHaveBeenCalledExactlyOnceWith(7, null);
  expect(service.quitting()).toBe(false);
});

it('blocks new edits synchronously and stays quiescent through flush and acknowledgement', async () => {
  const { service, settings } = fixture(); await service.start();
  const flush = deferred<void>(), ack = deferred<void>();
  bridge.flush.mockImplementation(() => flush.promise);
  bridge.complete.mockImplementation(() => ack.promise);
  handlers.get('companion-quit-requested')!({ payload: 12 });
  expect(service.quitting()).toBe(true);
  await service.setMinimizeToTray(false); await tick();
  expect(settings.save).not.toHaveBeenCalled();
  flush.resolve(); await tick();
  expect(service.quitting()).toBe(true);
  await service.setMinimizeToTray(false);
  expect(settings.save).not.toHaveBeenCalled();
  ack.resolve(); await tick();
  expect(service.quitting()).toBe(false);
  await service.setMinimizeToTray(false);
  expect(settings.save).toHaveBeenCalledOnce();
});

it('waits for an already-started preference change before taking the global flush snapshot', async () => {
  const { service, settings } = fixture(); await service.start();
  const saved = deferred<boolean>();
  settings.save.mockImplementation(async next => {
    const ok = await saved.promise;
    if (ok) settings.confirmedValues.set(next);
    return ok;
  });
  const change = service.setMinimizeToTray(false);
  handlers.get('companion-quit-requested')!({ payload: 13 }); await tick();
  expect(service.quitting()).toBe(true);
  expect(bridge.flush).not.toHaveBeenCalled();
  expect(bridge.complete).not.toHaveBeenCalled();
  bridge.flush.mockImplementation(async () => {
    expect(settings.confirmedValues()?.minimizeToTray).toBe(false);
    expect(bridge.sync.mock.lastCall?.[0]).toBe(false);
  });
  saved.resolve(true); await change; await tick();
  expect(bridge.flush).toHaveBeenCalledOnce();
  expect(bridge.complete).toHaveBeenCalledWith(13, null);
});

it('unblocks editing after native timeout and ignores a cancelled flush completing later', async () => {
  const { service } = fixture(); await service.start();
  const flush = deferred<void>(); bridge.flush.mockImplementation(() => flush.promise);
  handlers.get('companion-quit-requested')!({ payload: 21 }); await tick();
  expect(service.quitting()).toBe(true);
  handlers.get('companion-quit-aborted')!({ payload: 21 });
  expect(service.quitting()).toBe(false);
  flush.resolve(); await tick();
  expect(bridge.complete).not.toHaveBeenCalled();
});

it('does not let stale cancellation or an old flush release a newer quit gate', async () => {
  const { service } = fixture(); await service.start();
  const oldFlush = deferred<void>(), currentFlush = deferred<void>();
  bridge.flush.mockImplementationOnce(() => oldFlush.promise).mockImplementationOnce(() => currentFlush.promise);
  handlers.get('companion-quit-requested')!({ payload: 22 }); await tick();
  handlers.get('companion-quit-aborted')!({ payload: 22 });
  handlers.get('companion-quit-requested')!({ payload: 23 }); await tick();
  handlers.get('companion-quit-aborted')!({ payload: 22 });
  expect(service.quitting()).toBe(true);
  oldFlush.resolve(); await tick();
  expect(service.quitting()).toBe(true);
  expect(bridge.complete).not.toHaveBeenCalled();
  currentFlush.resolve(); await tick();
  expect(bridge.complete).toHaveBeenCalledExactlyOnceWith(23, null);
  expect(service.quitting()).toBe(false);
});

it('cancels Quit while an earlier preference save is waiting without flushing or acknowledging it later', async () => {
  const { service, settings } = fixture(); await service.start();
  const saved = deferred<boolean>(); settings.save.mockImplementation(() => saved.promise);
  const change = service.setMinimizeToTray(false);
  handlers.get('companion-quit-requested')!({ payload: 24 }); await tick();
  handlers.get('companion-quit-aborted')!({ payload: 24 });
  expect(service.quitting()).toBe(false);
  saved.resolve(false); await change; await tick();
  expect(bridge.flush).not.toHaveBeenCalled();
  expect(bridge.complete).not.toHaveBeenCalled();
});

it('rejects Quit visibly when saving fails, and surfaces an acknowledgement IPC failure', async () => {
  const { service } = fixture(); await service.start(); bridge.flush.mockRejectedValueOnce(new Error('access denied'));
  handlers.get('companion-quit-requested')!({ payload: 8 }); await tick();
  expect(bridge.complete).toHaveBeenCalledWith(8, expect.stringContaining('access denied'));
  expect(service.error()).toContain('access denied');
  expect(service.quitting()).toBe(false);
  bridge.complete.mockRejectedValueOnce(new Error('IPC lost'));
  handlers.get('companion-quit-requested')!({ payload: 9 }); await tick();
  // Keep both the unsaved-data error and a secondary IPC error visible.
  expect(service.error()).toContain('access denied');
  expect(service.error()).toContain('IPC lost');
  expect(service.quitting()).toBe(false);
  await service.setMinimizeToTray(false);
  expect(service.changing()).toBe(false);
});

it('reports event setup errors without enabling native interception', async () => {
  const { service } = fixture(); bridge.listen.mockRejectedValueOnce(new Error('listen failed'));
  await expect(service.start()).resolves.toBeUndefined();
  expect(service.error()).toContain('listen failed'); expect(bridge.sync).not.toHaveBeenCalled();
});

it('releases late event registration after disposal and stops all subsequent updates', async () => {
  const { service } = fixture(); const registration = deferred<() => void>(), stop = vi.fn();
  bridge.listen.mockImplementationOnce(() => registration.promise);
  const start = service.start(); service.dispose(); registration.resolve(stop); await start;
  expect(stop).toHaveBeenCalledOnce(); expect(bridge.sync).not.toHaveBeenCalled();
  await service.setMinimizeToTray(false); await service.start();
  expect(bridge.listen).toHaveBeenCalledTimes(1);
});

it('unsubscribes listeners and queued native changes when disposed', async () => {
  const { service, settings } = fixture(); await service.start(); service.dispose();
  expect(stops.every(stop => stop.mock.calls.length === 1)).toBe(true);
  settings.confirmedValues.set({ minimizeToTray: false } as AppSetting);
  setLocale('test', {}); await tick();
  expect(bridge.sync).toHaveBeenCalledTimes(1);
});

it('skips a policy update queued behind an in-flight sync if disposed', async () => {
  const { service, settings } = fixture(); const native = deferred<void>();
  bridge.sync.mockImplementationOnce(() => native.promise);
  const start = service.start(); await tick();
  settings.confirmedValues.set({ minimizeToTray: false } as AppSetting); await tick();
  service.dispose(); native.resolve(); await start; await tick();
  expect(bridge.sync).toHaveBeenCalledTimes(1);
});
