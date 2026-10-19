// Companion window scale (2026-10-19): the whole webview is scaled with the
// native page-zoom factor, never CSS `zoom`/`transform`. CSS zoom splits
// getBoundingClientRect() from style pixels, which misplaces Fluent's
// fixed-position dropdowns and tooltips; the platform zoom factor keeps layout
// and popups in one coordinate space. gui-settings.json stores integer percent.
import { set_webview_zoom } from '../platform/tauri';

export const UI_SCALE_MIN = 30;
export const UI_SCALE_MAX = 150;
export const UI_SCALE_STEP = 5;
export const UI_SCALE_DEFAULT = 100;

/**
 * Clamp to the supported range and snap to the slider step. The row shows the
 * value that actually applies; a hand-edited out-of-range number is never
 * rewritten on disk.
 */
export function normalizeUiScale(value: unknown): number {
  if (value === null || value === undefined || value === '') return UI_SCALE_DEFAULT;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return UI_SCALE_DEFAULT;
  const clamped = Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, number));
  return Math.round(clamped / UI_SCALE_STEP) * UI_SCALE_STEP;
}

let pending = UI_SCALE_DEFAULT;
let timer: ReturnType<typeof setTimeout> | undefined;
let applied = -1;
// Set by an explicit slider change so the same value is re-sent even though
// this module already applied it: window zoom shortcuts can leave the real
// factor different from the last value sent here.
let forceNext = false;
let waiters: Array<(error?: string) => void> = [];

function flush(): void {
  timer = undefined;
  const target = pending;
  void (async () => {
    let error: string | undefined;
    // A drag emits one change per step; only the newest value crosses the IPC.
    if (forceNext || target !== applied) {
      forceNext = false;
      try {
        await set_webview_zoom(target / 100);
        applied = target;
      } catch (reason) {
        error = reason instanceof Error ? reason.message : String(reason);
      }
    }
    const done = waiters;
    waiters = [];
    for (const resolve of done) resolve(error);
  })();
}

/**
 * Applies the saved scale. Resolves with the failure message when the platform
 * rejected the zoom so the caller can surface it instead of pretending the
 * window changed size.
 */
export function applyUiScale(percent: number, force = false): Promise<string | undefined> {
  pending = normalizeUiScale(percent);
  forceNext = forceNext || force;
  return new Promise(resolve => {
    waiters.push(resolve);
    if (!timer) timer = setTimeout(flush, 16);
  });
}
