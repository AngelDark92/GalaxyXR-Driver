// Honest Async Spacewarp row state (2026-10-17). Mirrors
// domain/encoder-tap-status.ts. Reads brief 11's pinned cross-child seam
// verbatim — the info.json `spacewarp` block with keys enabled /
// hookInstalled / published and a status enum of exactly off/on/waiting.
import type { DriverRuntimeStatus } from '../platform/tauri';
import type { DriverInfo } from './types';

/** GUI states (brief 12): Off / Active / Waiting for stream. A saved OFF is
 * believed directly; a saved ON becomes Active only when a fresh driver
 * report states the stream carries the toggle (status 'on', which per the
 * seam implies published). Stale, contradicted or missing observations stay
 * honest as Waiting for stream — synthesis itself runs on the headset client
 * and needs the spacewarp client patch there; the driver block cannot prove
 * the synthesis, only the publish. */
export function spacewarpStatus(savedEnabled: boolean, info: DriverInfo | undefined, runtime: DriverRuntimeStatus | undefined, now = Date.now()):
  'off' | 'on' | 'waiting' {
  if (!savedEnabled) return 'off';
  const block = info?.spacewarp;
  const fresh = !!runtime?.driverInitialized && !!runtime.steamvrRunning
    && !(now - runtime.checkedAt > 5000 || runtime.checkedAt > now + 2000);
  return fresh && block?.status === 'on' ? 'on' : 'waiting';
}