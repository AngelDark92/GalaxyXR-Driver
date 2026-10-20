// 2026-10-19 standalone bitrate curve window.
//
// Mounted by curve.html only. Native events carry the Companion's exact values;
// there is no timer, disk reader, settings writer, migration or driver action.
import { LitElement, html, css } from 'lit';
import { customElement } from 'lit/decorators.js';
import { curve_preview_state, type CurvePreviewState } from '../platform/tauri';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { t } from '../locale/i18n';
import './bitrate-curve';

@customElement('app-curve-preview')
export class CurvePreviewWindow extends LitElement {
  static styles = css`
    :host { display: block; padding-top: 0.75rem; }
    header { display: flex; align-items: baseline; justify-content: space-between; gap: 0.75rem; margin-bottom: 0.35rem; }
    .meta { font-size: 0.85rem; opacity: 0.8; margin-left: auto; }
    .error { color: #c42b1c; font-size: 0.85rem; margin: 0.5rem 0 0; }
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

  render() {
    const error = this.error ? html`<p class="error" role="alert">${t('The graph window could not be opened: {reason}', { reason: this.error })}</p>` : html``;
    if (!this.state) return error;
    return html`
      <header>
        <span class="meta">${t('Ceiling {ceiling} Mbit/s, clamp {clamp} Mbit/s', {
          ceiling: String(this.state.ceilingMbit), clamp: String(this.state.clampMbit),
        })}</span>
      </header>
      <app-bitrate-curve .curve=${this.state.curve} .pct=${this.state.constancyPct}
        .ceiling=${this.state.ceilingMbit} .clamp=${this.state.clampMbit}
        ?fixed=${this.state.fallbackDisabled === true}></app-bitrate-curve>
      ${error}
    `;
  }
}
