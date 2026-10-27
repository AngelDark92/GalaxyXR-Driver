// 2026-10-19 standalone bitrate curve window.
// 2026-10-23: editable seven-point graph. Mounted by curve.html only. Native
// events carry the Companion's exact values; the window never writes settings.
// Committed point edits and resets are relayed to the main window.
import { LitElement, html, css } from 'lit';
import { customElement } from 'lit/decorators.js';
import {
  curve_preview_state, submit_curve_preview_edit, submit_curve_preview_reset,
  type CurvePreviewPoint, type CurvePreviewState,
} from '../platform/tauri';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { t } from '../locale/i18n';
import './bitrate-curve';

@customElement('app-curve-preview')
export class CurvePreviewWindow extends LitElement {
  static styles = css`
    :host { display: block; padding-top: 0.75rem; -webkit-user-select: none; user-select: none; }
    header { display: flex; align-items: baseline; justify-content: space-between; gap: 0.75rem; margin-bottom: 0.35rem; }
    .meta { font-size: 0.85rem; opacity: 0.8; margin-left: auto; }
    .error { color: #c42b1c; font-size: 0.85rem; margin: 0.5rem 0 0; -webkit-user-select: text; user-select: text; }
    .locked { color: #b07a2a; font-size: 0.85rem; }
  `;

  private state?: CurvePreviewState;
  private error = '';
  private unlisten?: UnlistenFn;
  private generation = 0;

  connectedCallback() {
    super.connectedCallback();
    void this.start(++this.generation);
  }

  disconnectedCallback() {
    ++this.generation;
    this.unlisten?.(); this.unlisten = undefined;
    super.disconnectedCallback();
  }

  private async start(generation: number): Promise<void> {
    try {
      let received = false;
      const stop = await listen<CurvePreviewState>('curve-preview-changed', event => {
        if (generation !== this.generation) return;
        received = true;
        this.state = event.payload;
        this.error = '';
        this.requestUpdate();
      });
      if (generation !== this.generation) { stop(); return; }
      this.unlisten = stop;
      // Listen first so edits during startup cannot be lost. A newer event
      // takes precedence over an initial IPC response already in flight.
      const next = await curve_preview_state();
      if (generation !== this.generation) return;
      this.error = '';
      if (!received) this.state = next;
      this.requestUpdate();
    } catch (error) {
      if (generation !== this.generation) return;
      const message = String(error);
      if (message !== this.error) {
        this.error = message;
        this.requestUpdate();
      }
    }
  }

  private async onPointsChange(event: CustomEvent<{ points: CurvePreviewPoint[] }>) {
    try {
      await submit_curve_preview_edit(event.detail.points);
      this.error = '';
    } catch (error) {
      this.error = String(error);
    }
    this.requestUpdate();
  }

  private async onReset() {
    try {
      await submit_curve_preview_reset();
      this.error = '';
    } catch (error) {
      this.error = String(error);
    }
    this.requestUpdate();
  }

  render() {
    const error = this.error ? html`<p class="error" role="alert">${t('The graph window could not apply the change: {reason}', { reason: this.error })}</p>` : html``;
    if (!this.state) return error;
    return html`
      <header>
        <span class="meta">${t('Max Bitrate {ceiling} Mbit/s', {
          ceiling: String(this.state.ceilingMbit),
        })}</span>
        ${this.state.locked ? html`<span class="locked">${t('Close SteamVR to change')}</span>` : ''}
      </header>
      <app-bitrate-curve .curve=${this.state.curve} .pct=${this.state.constancyPct}
        .ceiling=${this.state.ceilingMbit}
        .requestReference=${this.state.requestReferenceMbit}
        .forceCbr=${this.state.forceCbr} .headroomPct=${this.state.headroomPct}
        .points=${this.state.points} ?fixed=${this.state.fallbackDisabled === true}
        ?editable=${true} ?locked=${this.state.locked === true}
        @points-change=${this.onPointsChange} @points-reset=${this.onReset}></app-bitrate-curve>
      ${error}
    `;
  }
}
