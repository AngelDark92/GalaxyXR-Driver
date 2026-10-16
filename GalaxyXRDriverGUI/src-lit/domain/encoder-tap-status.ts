import type { DriverRuntimeStatus } from '../platform/tauri';
import type { DriverInfo } from './types';

/** Latest encoder evidence must belong to the freshly verified driver process. */
export function encoderEvidence(info: DriverInfo | undefined, runtime: DriverRuntimeStatus | undefined, now = Date.now()) {
  const tap = info?.encoderTap;
  const path = (s: string | undefined) => s?.replace(/\\/g, '/').toLowerCase();
  if (!tap || !runtime?.driverInitialized || !runtime.steamvrRunning || !runtime.serverPid
      || runtime.serverPid !== tap.pid || tap.observedAt === undefined
      || now - runtime.checkedAt > 5000 || runtime.checkedAt > now + 2000
      || now - tap.observedAt > 5000 || tap.observedAt > now + 2000
      || !runtime.encoderTap?.modulePath || !runtime.encoderTap.configPath
      || path(tap.modulePath) !== path(runtime.encoderTap.modulePath)
      || path(tap.configPath) !== path(runtime.encoderTap.configPath)) return undefined;
  return tap;
}

/** Saved OFF is not proof of a fresh, unhooked encoder process. */
export function encoderTapStatus(savedEnabled: boolean, runtime: DriverRuntimeStatus | undefined, now = Date.now()):
  'on' | 'waiting' | 'restart-required' | 'confirmed-off' {
  if (savedEnabled) return 'on';
  if (!runtime?.driverInitialized || !runtime.steamvrRunning || !runtime.serverPid
      || now - runtime.checkedAt > 5000 || runtime.checkedAt > now + 2000) return 'waiting';
  if (runtime.encoderTap?.state === 'restart-required') return 'restart-required';
  if (runtime.encoderTap?.state === 'disabled') return 'confirmed-off';
  return 'waiting';
}
