// OFXR Bridge managed component — pure state/prefs helpers (2026-10-17).
// The page keeps no duplicated rules: the pinned defaults, the arm gate and
// the status explanation live here and are unit-tested. Values entered by the
// user are never clamped or silently replaced; normalization only supplies
// defaults for missing or out-of-contract values (the no-silent-settings
// policy leaves the stored file authoritative).
import type { OfxrPreferences, OfxrStatus } from './types';

export const ofxrDefaults: OfxrPreferences = {
  enabled: false,
  version: '',
  mode: 'fidelityfx',
  scale: 50,
  bidirectional: false,
  logging: false,
  maxLogMb: 32,
  flushEachEvent: false,
  overlay: 'off',
};

const MODES: readonly OfxrPreferences['mode'][] = ['fidelityfx', 'nvidia-fast', 'nvidia-medium', 'nvidia-slow'];
const SCALES: readonly OfxrPreferences['scale'][] = [50, 75, 100];
const OVERLAYS: readonly OfxrPreferences['overlay'][] = ['off', 'upper-left', 'upper-right', 'lower-left', 'lower-right'];

/** A managed layer can arm from these states. `armed_external` keeps the
 * switch usable: the registration may be this Companion's own leftover from a
 * previous session (arm recovers it); a foreign OFXR tray registration makes
 * the arm fail visibly and reverts the switch. */
export function ofxrCanArm(status: OfxrStatus | undefined): boolean {
  return status?.state === 'ready' || status?.state === 'armed' || status?.state === 'armed_external';
}

/** Short explanation for a disabled Enable switch. `undefined` means armable. */
export function ofxrDisabledReason(status: OfxrStatus | undefined): string | undefined {
  if (!status) return 'Checking the OFXR Bridge installation.';
  if (ofxrCanArm(status)) return undefined;
  if (status.reason) return status.reason;
  return status.state === 'not_installed'
    ? 'OFXR Bridge is not installed.'
    : 'OFXR Bridge is unavailable.';
}

/** Fill missing or out-of-contract fields without rewriting valid user values.
 * `maxLogMb` is rounded into the row's 1-512 contract only when the stored
 * file is out of contract: the IPC carries it as u32, so a corrupt value must
 * not make every arm/apply fail deserialization. In-contract values are
 * untouched. */
export function normalizeOfxrPreferences(value: Partial<OfxrPreferences> | null | undefined): OfxrPreferences {
  const candidate = value ?? {};
  return {
    enabled: typeof candidate.enabled === 'boolean' ? candidate.enabled : ofxrDefaults.enabled,
    version: typeof candidate.version === 'string' ? candidate.version : ofxrDefaults.version,
    mode: MODES.includes(candidate.mode as OfxrPreferences['mode']) ? candidate.mode! : ofxrDefaults.mode,
    scale: SCALES.includes(candidate.scale as OfxrPreferences['scale']) ? candidate.scale! : ofxrDefaults.scale,
    bidirectional: typeof candidate.bidirectional === 'boolean' ? candidate.bidirectional : ofxrDefaults.bidirectional,
    logging: typeof candidate.logging === 'boolean' ? candidate.logging : ofxrDefaults.logging,
    maxLogMb: typeof candidate.maxLogMb === 'number' && Number.isFinite(candidate.maxLogMb)
      ? Math.min(512, Math.max(1, Math.round(candidate.maxLogMb))) : ofxrDefaults.maxLogMb,
    flushEachEvent: typeof candidate.flushEachEvent === 'boolean' ? candidate.flushEachEvent : ofxrDefaults.flushEachEvent,
    overlay: OVERLAYS.includes(candidate.overlay as OfxrPreferences['overlay'])
      ? candidate.overlay! : ofxrDefaults.overlay,
  };
}
