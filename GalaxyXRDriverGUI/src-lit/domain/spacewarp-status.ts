// Honest Async Spacewarp row state (2026-10-17). Mirrors
// domain/encoder-tap-status.ts. Reads brief 11's pinned cross-child seam
// verbatim — the info.json `spacewarp` block with keys enabled /
// hookInstalled / published and a status enum of exactly off/on/waiting.
import type { DriverRuntimeStatus } from '../platform/tauri';
import type { DriverInfo } from './types';

/** GUI states (brief 12): Off / Active / Waiting for stream. A saved OFF is
 * believed directly; a saved ON becomes Active only when a fresh driver
 * report states the stream carries the toggle (status 'on', which per the
 * seam implies published).
 *
 * 2026-10-25: the row must not depend on the separate installation/version
 * runtime check. That check can be in `version-mismatch` (for example while a
 * local test build runs beside a packaged Companion) even when the running
 * driver has published. When the driver includes `observedAt`, a fresh
 * `status:'on'` is authoritative; missing/stale timestamps fall back to the
 * older runtime freshness rule. Stale, contradicted or missing observations
 * stay honest as Waiting for stream — synthesis itself runs on the headset
 * client and needs the spacewarp client patch there; the driver block cannot
 * prove the synthesis, only the publish. */
export function spacewarpStatus(savedEnabled: boolean, info: DriverInfo | undefined, runtime: DriverRuntimeStatus | undefined, now = Date.now()):
  'off' | 'on' | 'waiting' {
  if (!savedEnabled) return 'off';
  const block = info?.spacewarp;
  const observedAt = block?.observedAt;
  // Two independent freshness proofs: the driver's own info.json timestamp
  // (works even when the installation/version check is mismatched) and the
  // legacy runtime check (works for older drivers and if the info watcher
  // misses an update). Neither trusts an old status forever.
  const freshInfo = typeof observedAt === 'number'
    && !(now - observedAt > 5000 || observedAt > now + 2000);
  const freshRuntime = !!runtime?.driverInitialized && !!runtime.steamvrRunning
    && !(now - runtime.checkedAt > 5000 || runtime.checkedAt > now + 2000);
  // 'on' implies published/enabled in the pinned seam; reject a contradictory
  // block instead of rendering Active from one field alone.
  const carries = block?.status === 'on'
    && block?.published !== false
    && block?.enabled !== false;
  return (freshInfo || freshRuntime) && carries ? 'on' : 'waiting';
}