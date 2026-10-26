import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WindowsStartupService } from './windows-startup';
import type { WindowsStartupStatus } from '../platform/tauri';

const bridge = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock('../platform/tauri', () => ({ get_windows_startup: bridge.get, set_windows_startup: bridge.set }));
const currentCommand = '"C:\\Companion\\Galaxy XR Companion.exe" --start-in-tray';
const state = (kind: WindowsStartupStatus['state'] = 'absent'): WindowsStartupStatus => ({
  supported: true, state: kind, currentCommand,
  command: kind === 'absent' ? null : kind === 'current' ? currentCommand : '"D:\\Other\\Companion.exe" --start-in-tray',
  registeredPath: kind === 'absent' ? null : kind === 'current' ? 'C:\\Companion\\Galaxy XR Companion.exe' : 'D:\\Other\\Companion.exe',
});
let service: WindowsStartupService;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
beforeEach(() => {
  vi.resetAllMocks(); bridge.get.mockResolvedValue(state()); bridge.set.mockResolvedValue(state('current'));
  service = new WindowsStartupService('galaxyxr');
});
afterEach(() => service.dispose());

it('queries once at startup, defaults Off and never writes a startup preference', async () => {
  await Promise.all([service.start(), service.start()]);
  expect(bridge.get).toHaveBeenCalledExactlyOnceWith('galaxyxr');
  expect(service.enabled()).toBe(false); expect(bridge.set).not.toHaveBeenCalled();
});
it('enables only on explicit action, passing the observed registry command', async () => {
  await service.start(); await service.setEnabled(true);
  expect(bridge.set).toHaveBeenCalledExactlyOnceWith('galaxyxr', true, null);
  expect(service.enabled()).toBe(true);
});
it('preserves another portable copy until explicitly retargeted, and can disable it', async () => {
  bridge.get.mockResolvedValue(state('other-copy'));
  await service.start(); expect(service.enabled()).toBe(true); expect(bridge.set).not.toHaveBeenCalled();
  await service.setEnabled(true);
  expect(bridge.set).toHaveBeenLastCalledWith('galaxyxr', true, state('other-copy').command);
  bridge.set.mockResolvedValue(state()); await service.setEnabled(false);
  expect(bridge.set).toHaveBeenLastCalledWith('galaxyxr', false, currentCommand);
  expect(service.enabled()).toBe(false);
});
it.each(['conflict', 'unsupported', 'unreadable'])('does not mutate %s startup state', async mode => {
  if (mode === 'unreadable') bridge.get.mockRejectedValue(Error('access denied'));
  else bridge.get.mockResolvedValue({ ...state(mode === 'conflict' ? 'conflict' : 'absent'), supported: mode !== 'unsupported' });
  await service.start(); await service.setEnabled(true);
  expect(bridge.set).not.toHaveBeenCalled();
  if (mode === 'unreadable') expect(service.error()).toContain('access denied');
});
it('requeries after a failed transaction and shows the actual OS result and error', async () => {
  await service.start(); bridge.set.mockRejectedValue(Error('rollback failed'));
  bridge.get.mockResolvedValue(state('conflict'));
  await service.setEnabled(true);
  expect(service.status()?.state).toBe('conflict'); expect(service.error()).toContain('rollback failed');
});
it('marks state unknown if failed transaction cannot be inspected', async () => {
  await service.start(); bridge.set.mockRejectedValue(Error('write failed')); bridge.get.mockRejectedValue(Error('read failed'));
  await service.setEnabled(true);
  expect(service.status()).toBeUndefined(); expect(service.error()).toContain('read failed');
});
it('waits for active changes on Quit, refuses duplicates and ignores stale focus queries', async () => {
  await service.start(); const old = deferred<WindowsStartupStatus>(); bridge.get.mockReturnValueOnce(old.promise);
  const refresh = service.refresh(); const pending = deferred<WindowsStartupStatus>(); bridge.set.mockReturnValueOnce(pending.promise);
  const change = service.setEnabled(true); let idle = false; void service.idle().then(() => { idle = true; });
  await service.setEnabled(false); await Promise.resolve(); expect(idle).toBe(false);
  pending.resolve(state('current')); await change;
  old.resolve(state()); await refresh;
  expect(service.enabled()).toBe(true); expect(bridge.set).toHaveBeenCalledOnce();
  await service.idle(); expect(idle).toBe(true);
});
it('refresh observes external removal without recreating registration', async () => {
  bridge.get.mockResolvedValueOnce(state('current')); await service.start(); await service.refresh();
  expect(service.enabled()).toBe(false); expect(bridge.set).not.toHaveBeenCalled();
});
it('does not publish or write after disposal', async () => {
  const pending = deferred<WindowsStartupStatus>(); bridge.get.mockReturnValue(pending.promise);
  const task = service.start(); service.dispose(); pending.resolve(state('current')); await task;
  await service.setEnabled(true); expect(service.status()).toBeUndefined(); expect(bridge.set).not.toHaveBeenCalled();
});
