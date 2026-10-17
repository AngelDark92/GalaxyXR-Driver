import type { DriverRuntimeStatus } from '../platform/tauri';
import type { DriverInfo } from './types';

/** Latest encoder evidence must belong to the freshly verified driver process. */
function processBoundEvidence(info: DriverInfo | undefined, runtime: DriverRuntimeStatus | undefined, now: number) {
  const tap = info?.encoderTap;
  const path = (s: string | undefined) => s?.replace(/\\/g, '/').toLowerCase();
  if (!tap || !runtime?.driverInitialized || !runtime.steamvrRunning || !runtime.serverPid
      || runtime.serverPid !== tap.pid || tap.observedAt === undefined
      || now - runtime.checkedAt > 5000 || runtime.checkedAt > now + 2000
      || !runtime.encoderTap?.modulePath || !runtime.encoderTap.configPath
      || path(tap.modulePath) !== path(runtime.encoderTap.modulePath)
      || path(tap.configPath) !== path(runtime.encoderTap.configPath)) return undefined;
  return tap;
}

export function encoderEvidence(info: DriverInfo | undefined, runtime: DriverRuntimeStatus | undefined, now = Date.now()) {
  const tap = processBoundEvidence(info, runtime, now);
  if (!tap || now - tap.observedAt! > 5000 || tap.observedAt! > now + 2000) return undefined;
  return tap;
}

export type ExpiredEncoderEvidence = {
  tap: NonNullable<DriverInfo['encoderTap']>;
  /** now - observedAt, only for observations older than the 5 s window. */
  ageMs: number;
};

/** Expired but still process-bound tap evidence (2026-10-16): the last
 * observed encoder state of the verified process, with its age. A stored
 * refusal must stay visible with this age instead of degrading to a bare
 * waiting row; evidence bound to a dead or replaced process is not shown. */
export function expiredEncoderEvidence(info: DriverInfo | undefined, runtime: DriverRuntimeStatus | undefined, now = Date.now()):
    ExpiredEncoderEvidence | undefined {
  const tap = processBoundEvidence(info, runtime, now);
  if (!tap || tap.observedAt! > now + 2000) return undefined;
  const ageMs = now - tap.observedAt!;
  if (ageMs <= 5000) return undefined; // still inside the fresh window
  return { tap, ageMs };
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
