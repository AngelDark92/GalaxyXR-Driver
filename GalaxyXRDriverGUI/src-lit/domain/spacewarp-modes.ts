// Async Spacewarp mode presentation (2026-10-26). The saved value is 0 =
// Automatic and 1 = Forced half rate. The Companion renders the mode as a
// separate Force half-rate switch beside the ASW switch, never as a codec or
// reset side effect. Nothing here rewrites a saved value. The module is free of
// translation imports so the mapping can be tested without the locale runtime.

/** Saved mode value for the Force half-rate switch. */
export const FORCE_HALF_RATE_MODE = 1;

/** True when the saved mode is the forced half-rate selection. Unknown stored
 *  values apply as Automatic (matching the driver) and are left untouched. */
export function isForcedHalfRate(mode: number): boolean {
  return mode === FORCE_HALF_RATE_MODE;
}

/** Switch value -> saved mode: on stores 1, off stores 0. */
export function modeForForceSwitch(force: boolean): number {
  return force ? FORCE_HALF_RATE_MODE : 0;
}

/** Human-readable mode label for the status/tips. */
export function spacewarpModeLabel(mode: number): 'Force half-rate' | 'Automatic' {
  return isForcedHalfRate(mode) ? 'Force half-rate' : 'Automatic';
}

/** Publication is evidence of the delivered carrier, not the desired mode or
 * headset synthesis. A failed transition keeps showing the last delivered mode. */
export function spacewarpPublication(block?: {
  published?: boolean;
  publishedValue?: number;
  effectiveMode?: number;
}): { mode: 'half' | 'late' | 'unknown'; pending: boolean } {
  const delivered = block?.published ? block.publishedValue : undefined;
  const desired = block?.effectiveMode;
  return {
    mode: delivered === 2 ? 'half' : delivered === 1 ? 'late' : 'unknown',
    pending: (desired === 0 || desired === 1 || desired === 2) && desired !== delivered,
  };
}
