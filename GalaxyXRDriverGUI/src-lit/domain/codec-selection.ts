// 2026-10-19 (owner directive): the video codec selector is inert while a
// SteamVR session is live. The running session keeps the encoder class it
// created, and settings.json is hot-reloaded by the driver, so a switch made
// during a session can rewrite the codec under a running stream instead of
// waiting for the next start.
//
// 'allowed' needs a runtime report that is both stopped and fresh: a stale,
// missing or failed report is never proof that SteamVR is stopped. The page
// polls every 2 s; the 5 s window matches the encoder-evidence freshness rule.
import type { DriverRuntimeStatus } from '../platform/tauri';

export type CodecSwitchState = 'allowed' | 'running' | 'unconfirmed';

export function codecSwitchState(runtime: Pick<DriverRuntimeStatus, 'steamvrRunning' | 'checkedAt'> | undefined,
  now = Date.now()): CodecSwitchState {
  if (runtime?.steamvrRunning === true) return 'running';
  if (runtime?.steamvrRunning !== false) return 'unconfirmed';
  if (now - runtime.checkedAt > 5000 || runtime.checkedAt > now + 2000) return 'unconfirmed';
  return 'allowed';
}
