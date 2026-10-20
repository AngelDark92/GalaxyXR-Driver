// 2026-10-19 bitrate curve preview: the selected family/percentage against the
// streamer's own straight line. Read-only, drawn client-side from the same
// math the driver uses (domain/bitrate-curve.ts, pinned by its unit test).
import { html, LitElement, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { BITRATE_CURVE_FAMILIES, bitrateCurveMbit } from '../domain/bitrate-curve';
import { t } from '../locale/i18n';

@customElement('app-bitrate-curve')
export class BitrateCurvePanel extends LitElement {
  static styles = css`
    :host { display: block; padding: 0.25rem 0 0.5rem; }
    .wrap { display: flex; flex-direction: column; gap: 0.35rem; }
    canvas { width: 100%; max-width: 100%; height: auto; aspect-ratio: 7 / 3; }
    .legend { display: flex; gap: 1rem; align-items: center; font-size: 0.85rem; opacity: 0.9; flex-wrap: wrap; }
    .legend span.item { display: inline-flex; gap: 0.35rem; align-items: center; }
    .swatch { width: 18px; height: 0; border-top-width: 2px; border-top-style: solid; }
    .swatch.solid { border-color: #5f9fdf; }
    .swatch.dashed { border-top-style: dashed; border-color: rgba(128,128,128,0.9); }
    .hint { font-size: 0.8rem; opacity: 0.75; }
  `;

  @property({ type: Number }) curve = 0;
  @property({ type: Number }) pct = 0;
  @property({ type: Number }) ceiling = 450;
  @property({ type: Number }) clamp = 350;
  /** 'No fallback' on: the streamer request is fixed at the clamp. */
  @property({ type: Boolean }) fixed = false;
  private resizeObserver?: ResizeObserver;

  protected updated() {
    this.resizeObserver ??= new ResizeObserver(() => this.draw());
    this.resizeObserver.disconnect();
    const canvas = this.renderRoot.querySelector('canvas');
    if (canvas) this.resizeObserver.observe(canvas);
    this.draw();
  }

  disconnectedCallback() {
    this.resizeObserver?.disconnect();
    super.disconnectedCallback();
  }

  private valid(): boolean {
    return BITRATE_CURVE_FAMILIES.some(entry => entry.value === this.curve)
      && Number.isFinite(this.pct) && this.pct >= 0 && this.pct <= 100
      && Number.isFinite(this.ceiling) && this.ceiling > 0
      && Number.isFinite(this.clamp) && this.clamp > 0;
  }

  private draw() {
    if (!this.valid()) return;
    const canvas = this.renderRoot.querySelector('canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = canvas.clientWidth, H = canvas.clientHeight;
    if (!W || !H) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(W * ratio);
    canvas.height = Math.round(H * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const padL = 56, padR = 16, padT = 16, padB = 34;
    const ceiling = this.ceiling;
    const clamp = this.clamp;
    const xAt = (mbit: number) => padL + (W - padL - padR) * Math.max(0, Math.min(1, mbit / clamp));
    const yAt = (mbit: number) => H - padB - (H - padT - padB) * Math.max(0, Math.min(1, mbit / ceiling));

    ctx.clearRect(0, 0, W, H);

    // grid + ticks
    ctx.strokeStyle = 'rgba(128,128,128,0.25)';
    ctx.lineWidth = 1;
    ctx.fillStyle = 'rgba(128,128,128,1)';
    ctx.font = '11px monospace';
    for (const frac of [0, 0.25, 0.5, 0.75, 1]) {
      const x = xAt(clamp * frac);
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, H - padB); ctx.stroke();
      const label = String(Math.round(clamp * frac));
      ctx.fillText(label, x - ctx.measureText(label).width / 2, H - padB + 14);
    }
    for (const frac of [0, 0.5, 1]) {
      const y = yAt(ceiling * frac);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
      const label = String(Math.round(ceiling * frac));
      ctx.fillText(label, padL - 6 - ctx.measureText(label).width, y + 4);
    }

    // streamer standard: the straight line, target = ceiling * request / clamp
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = 'rgba(128,128,128,0.9)';
    ctx.beginPath();
    ctx.moveTo(xAt(0), yAt(0));
    ctx.lineTo(xAt(clamp), yAt(ceiling));
    ctx.stroke();

    // selected curve
    ctx.setLineDash([]);
    ctx.strokeStyle = '#5f9fdf';
    ctx.lineWidth = 2;
    ctx.beginPath();
    const samples = 81;
    for (let i = 0; i < samples; i++) {
      const request = clamp * (i / (samples - 1));
      const target = bitrateCurveMbit(request, ceiling, clamp, this.curve, this.pct);
      const x = xAt(request);
      const y = yAt(target);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.lineWidth = 1;

    // axis titles
    ctx.fillStyle = 'rgba(128,128,128,1)';
    const xTitle = t('streamer request (Mbit/s)');
    ctx.fillText(xTitle, padL + (W - padL - padR) / 2 - ctx.measureText(xTitle).width / 2, H - 6);
    ctx.save();
    ctx.translate(12, padT + (H - padT - padB) / 2 + ctx.measureText(t('applied (Mbit/s)')).width / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(t('applied (Mbit/s)'), 0, 0);
    ctx.restore();

    // 2026-10-20: with 'No fallback' the request never leaves the clamp, so the
    // only reachable point on this map is (clamp, ceiling). Mark it instead of
    // letting the curve imply a range the driver cannot visit.
    if (this.fixed) {
      const x = xAt(clamp);
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = '#5f9fdf';
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, H - padB); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#5f9fdf';
      ctx.beginPath(); ctx.arc(x, yAt(ceiling), 4.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(128,128,128,1)';
      const label = t('fixed operating point');
      ctx.fillText(label, Math.min(x - ctx.measureText(label).width, W - padR - ctx.measureText(label).width), padT + 10);
    }
  }

  render() {
    if (!this.valid()) return html`<p role="alert">${t('Cannot plot these curve values. Check the curve family, constancy, ceiling and clamp in the Companion.')}</p>`;
    const family = BITRATE_CURVE_FAMILIES.find(entry => entry.value === this.curve) ?? BITRATE_CURVE_FAMILIES[0];
    return html`
      <div class="wrap">
        <canvas width="560" height="240"></canvas>
        <div class="legend">
          <span class="item"><span class="swatch solid"></span>${t(family.label)} — ${this.pct}%</span>
          <span class="item"><span class="swatch dashed"></span>${t('Streamer standard (linear)')}</span>
        </div>
        <div class="hint">${this.fixed
          ? t('No fallback is on: the streamer request stays at the clamp, so the applied value is the ceiling whatever curve family or constancy is saved. The dashed marker is the only operating point.')
          : t('Steady-state map. Except for Linear at 0%, the driver median-filters the streamer request over five frames; that filter is not shown.')}</div>
      </div>`;
  }
}
