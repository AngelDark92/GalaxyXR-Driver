import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { open_curve_preview, publish_curve_preview, type CurvePreviewState } from '../platform/tauri';
import type { Settings } from '../domain/types';
import { bitrateCurvePointsForSettings } from '../domain/bitrate-curve';

/** Effective Companion values, including merged defaults and unsaved edits.
 * No file parsing, coercion, migration or settings writes in the graph path. */
export function previewState(settings: Settings | undefined, bandwidthMbit = settings?.galaxyXr?.customBandwidthMbit ?? 350,
  locked = false): CurvePreviewState {
  if (!settings?.streamFrame) throw new Error('Settings are unavailable');
  const sf = settings.streamFrame!;
  return {
    curve: sf.nvencBitrateCurve,
    constancyPct: sf.nvencBitrateConstancyPct,
    ceilingMbit: sf.nvencBitrateMbit !== 0 ? sf.nvencBitrateMbit
      : sf.nvencBandwidthOverrideMbit !== 0 ? sf.nvencBandwidthOverrideMbit : bandwidthMbit,
    // 2026-10-21: a constancy of 100 pins the request factor to 1.0, so the graph
    // marks a single operating point instead of implying a live curve.
    fallbackDisabled: (sf.nvencBitrateConstancyPct ?? 0) >= 100,
    points: bitrateCurvePointsForSettings(sf),
    locked,
  };
}

/** Only subscribes while a graph window exists. Closing releases both ends. */
export class CurvePreviewPublisher {
  private stopChanges?: () => void;
  private stopClosed?: UnlistenFn;
  private opening?: Promise<void>;
  private ready = false;
  private last = '';
  constructor(private read: () => CurvePreviewState, private subscribe: (update: () => void) => () => void) {}

  open(locale: string): Promise<void> {
    if (this.opening) return this.opening;
    this.opening = this.openWindow(locale).finally(() => { this.opening = undefined; });
    return this.opening;
  }
  private async openWindow(locale: string): Promise<void> {
    try {
      if (!this.stopClosed) this.stopClosed = await listen('curve-preview-closed', () => this.dispose());
      if (!this.stopChanges) {
        this.ready = false;
        this.stopChanges = this.subscribe(() => this.publish());
      }
      const snapshot = this.read();
      this.last = JSON.stringify(snapshot);
      await open_curve_preview(locale, snapshot);
      this.ready = true;
      // Include any edit made while WebView2 was being created.
      this.publish();
    } catch (error) { this.dispose(); throw error; }
  }
  private publish(): void {
    if (!this.stopChanges || !this.ready) return;
    const snapshot = this.read(), key = JSON.stringify(snapshot);
    if (key === this.last) return;
    this.last = key;
    void publish_curve_preview(snapshot).catch(error => console.error('Could not update curve preview', error));
  }
  dispose(): void {
    this.stopChanges?.(); this.stopChanges = undefined;
    this.stopClosed?.(); this.stopClosed = undefined;
    this.last = '';
    this.ready = false;
  }
}
