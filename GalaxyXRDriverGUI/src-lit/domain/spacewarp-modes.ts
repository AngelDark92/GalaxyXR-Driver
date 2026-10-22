// Half rate retirement (2026-10-21). Async Spacewarp's mode 1 stays in the
// saved settings, the driver contract and the page's change handler; only the
// selection is retired from the UI. Flipping HALF_RATE_AVAILABLE to true
// restores the option, and the retirement assertions in this module's test and in
// SpacewarpToggleTest must be updated in the same pass. Nothing here rewrites a
// saved value. The module is deliberately free of translation imports so the values
// can be tested without the locale runtime.
export const HALF_RATE_AVAILABLE: boolean = false;

/** Values the Spacewarp mode select offers: late frames only (0) always; half
 *  rate (1) only while the mode is available. */
export function spacewarpModeValues(halfRateAvailable: boolean = HALF_RATE_AVAILABLE): number[] {
  return halfRateAvailable ? [0, 1] : [0];
}

/** True when a saved mode can no longer be chosen: half rate is unavailable
 *  and the saved value is not late frames only. The saved value itself is
 *  never changed — the page only explains that late frames only is applied. */
export function isRetiredModeSelection(mode: number, halfRateAvailable: boolean = HALF_RATE_AVAILABLE): boolean {
  return !halfRateAvailable && mode !== 0;
}
