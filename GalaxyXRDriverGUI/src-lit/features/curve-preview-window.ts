// 2026-10-19 standalone bitrate curve window.
//
// Created hidden at startup by curve_preview::install and shown by the Rust
// `open_curve_preview` command; the page is the same /<locale>/index.html the
// main window loads, and main.ts mounts this element instead of the shell by
// reading the window label. The window is read-only: it polls
// `curve_preview_state` (which resolves the saved values exactly as the driver
// does) so the graph follows the dropdown and percentage while they are edited
// in the Companion.
import { LitElement, html, css } from 'lit';
import { customElement } from 'lit/decorators.js';
import { close_curve_preview, curve_preview_state, type CurvePreviewState } from '../platform/tauri';
import { t } from '../locale/i18n';
import './bitrate-curve';

const POLL_MS = 250;

@customElement('app-curve-preview')
export class CurvePreviewWindow extends LitElement {
  static styles = css`
    :host { display: block; padding: 1rem 1.25rem; }
    header { display: flex; align-items: baseline; justify-content: space-between; gap: 0.75rem; margin-bottom: 0.35rem; }
    h1 { font-size: 1rem; font-weight: 600; margin: 0; }
    .meta { font-size: 0.85rem; opacity: 0.8; margin-left: auto; }
    button.close { font: inherit; font-size: 0.85rem; padding: 0.15rem 0.6rem; }
    .error { color: #c42b1c; font-size: 0.85rem; margin: 0.5rem 0 0; }
  `;

  private state: CurvePreviewState = { curve: 0, constancyPct: 0, ceilingMbit: 350, clampMbit: 350 };
  private error = '';
  private timer: number | undefined;

  connectedCallback() {
    super.connectedCallback();
    void this.refresh();
    this.timer = window.setInterval(() => { void this.refresh(); }, POLL_MS);
    window.addEventListener('keydown', this.onKeyDown);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  disconnectedCallback() {
    if (this.timer !== undefined) window.clearInterval(this.timer);
    this.timer = undefined;
    window.removeEventListener('keydown', this.onKeyDown);
    document.removeEventListener('visibilitychange', this.onVisibility);
    super.disconnectedCallback();
  }

  // The window is created hidden at startup and hidden again on close, so the
  // page lives for the whole session: skip the settings poll while hidden.
  private readonly onVisibility = () => {
    if (document.visibilityState === 'visible') void this.refresh();
  };

  // Escape always closes the window, even if the title bar misbehaves.
  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') void close_curve_preview();
  };

  private async refresh(): Promise<void> {
    try {
      const next = await curve_preview_state();
      this.error = '';
      if (JSON.stringify(next) !== JSON.stringify(this.state)) {
        this.state = next;
        this.requestUpdate();
      }
    } catch (error) {
      const message = String(error);
      if (message !== this.error) {
        this.error = message;
        this.requestUpdate();
      }
    }
  }

  render() {
    return html`
      <header>
        <h1>${t('Bitrate curve')}</h1>
        <span class="meta">${t('Ceiling {ceiling} Mbit/s, clamp {clamp} Mbit/s', {
          ceiling: String(this.state.ceilingMbit), clamp: String(this.state.clampMbit),
        })}</span>
        <button class="close" type="button" @click=${() => { void close_curve_preview(); }}>${t('Close')}</button>
      </header>
      <app-bitrate-curve .curve=${this.state.curve} .pct=${this.state.constancyPct}
        .ceiling=${this.state.ceilingMbit} .clamp=${this.state.clampMbit}></app-bitrate-curve>
      ${this.error ? html`<p class="error">${t('Could not read settings.json: {reason}', { reason: this.error })}</p>` : html``}
    `;
  }
}
