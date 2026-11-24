// Curve editor (distortion profile), ported from
// src/app/utilities/stream-frame-curve/stream-frame-curve.component.{ts,html}.
// The math (evaluateCurve, smoothstep, directional preview blending) is
// mirrored from FrameProcessor.cpp / vrlink_layer_ps.hlsl and is preserved
// verbatim. UI state (curveKey, scaleRange, exaggeration) keeps the same
// behavior: the stored selection is normalized to a valid key when the
// per-eye/per-axis mode changes, and the plot redraws on every external
// revision without seeding persisted data.
import { html, LitElement, type PropertyValues } from 'lit';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { customElement, property } from 'lit/decorators.js';
import { css } from 'lit';
import { interactiveStyles } from '../ui/shared-styles';
import { effect, signal, untracked } from '../reactive';
import type { StreamFrameConfig, StreamFrameCurveData } from '../domain/types';
import { t } from '../locale/i18n';
// curve math lives in the framework-free domain module (unit-tested in Node);
// re-exported here so existing import sites keep working
import { evaluateCurve, smoothstep } from '../domain/curve';
export { evaluateCurve, smoothstep };

@customElement('app-stream-frame-curve')
export class StreamFrameCurve extends LitElement {
  static styles = css`
    ${interactiveStyles}
    :host { display: block; padding: 0.5rem 0; }
    .curve-editor { display: flex; flex-direction: column; gap: 0.5rem; }
    .toolbar { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
    .curve-tabs button.active-tab { font-weight: 600; outline: 2px solid var(--colorBrandForegroundLink, #0067c0); }
    .hint { opacity: 0.75; font-size: 0.85rem; }
    canvas { background: var(--colorNeutralBackground2, #f7f7f7); border: 1px solid var(--colorNeutralStroke1, #888); border-radius: 6px; max-width: 100%; }
    .preview { background: #fff; }
    .points-table { display: flex; flex-direction: column; gap: 0.25rem; max-height: 22rem; overflow: auto; }
    .point-row { display: flex; align-items: center; gap: 0.4rem; }
    .point-row input { width: 6rem; }
    .range-select { min-width: 8rem; }
  `;

  @property({ attribute: false }) settings!: StreamFrameConfig;
  // parent increments on any external change so the plots redraw promptly
  @property({ type: Number }) revision = 0;

  // vertical range of the plot around 1.0, fixed so dragging feels stable
  scaleRange = signal(0.05);
  scaleRangeOptions = [0.01, 0.02, 0.05, 0.1, 0.2];
  exaggeration = signal(8);

  // which curve is being edited: 'base' or a named per eye / per axis curve
  curveKey = signal('base');
  curveLabels: { [key: string]: string | undefined } = {
    base: 'Curve', left: 'Left eye', right: 'Right eye',
    horizontal: 'Horizontal', vertical: 'Vertical',
    leftHorizontal: 'Left / horizontal', leftVertical: 'Left / vertical',
    rightHorizontal: 'Right / horizontal', rightVertical: 'Right / vertical'
  };

  private dragIndex = -1;
  private curveCanvas!: HTMLCanvasElement;
  private previewCanvas!: HTMLCanvasElement;

  connectedCallback(): void {
    super.connectedCallback();
    // keep the stored selection valid when per-eye/per-axis toggles or an
    // imported profile change the available keys
    effect(() => {
      const keys = this.curveKeys();
      if (!keys.includes(untracked(() => this.curveKey()))) {
        this.curveKey.set(keys[0]);
        this.requestUpdate();
      }
    });
    // local ui state redraws
    effect(() => {
      this.scaleRange();
      this.exaggeration();
      this.requestUpdate();
    });
  }

  firstUpdated(): void {
    requestAnimationFrame(() => this.draw());
  }

  updated(changed: PropertyValues): void {
    if (changed.has('settings') || changed.has('revision')) {
      const keys = this.curveKeys();
      if (!keys.includes(this.curveKey())) {
        this.curveKey.set(keys[0]);
      }
      requestAnimationFrame(() => this.draw());
    }
  }

  // ---- curve selection ----
  curveKeys(): string[] {
    const d = this.settings.distortion;
    if (d.perEye && d.perAxis) return ['leftHorizontal', 'leftVertical', 'rightHorizontal', 'rightVertical'];
    if (d.perEye) return ['left', 'right'];
    if (d.perAxis) return ['horizontal', 'vertical'];
    return ['base'];
  }
  // the storage behind a curve key. 'base' lives at the legacy locations,
  // named curves are seeded from the base curve on first access.
  curveData(key: string, seed: boolean): StreamFrameCurveData {
    const cfg = this.settings;
    if (key === 'base') {
      // facade over the legacy storage so all code paths look the same
      return {
        get k1() { return cfg.k1; }, set k1(v: number) { cfg.k1 = v; },
        get k2() { return cfg.k2; }, set k2(v: number) { cfg.k2 = v; },
        get points() { return cfg.distortion.points; }, set points(v) { cfg.distortion.points = v; }
      } as StreamFrameCurveData;
    }
    if (!cfg.distortion.curves) cfg.distortion.curves = {};
    let curve = cfg.distortion.curves[key];
    if (!curve && seed) {
      curve = {
        k1: cfg.k1, k2: cfg.k2,
        points: JSON.parse(JSON.stringify(cfg.distortion.points))
      };
      cfg.distortion.curves[key] = curve;
    }
    return curve ?? { k1: cfg.k1, k2: cfg.k2, points: cfg.distortion.points };
  }
  // the key to actually use this render: falls back to the first valid key
  // when the stored selection doesn't exist in the current mode (e.g. a
  // per-eye profile was just imported while 'base' was selected).
  private effectiveKey(): string {
    const keys = this.curveKeys();
    const key = this.curveKey();
    return keys.includes(key) ? key : keys[0];
  }
  activeCurve(seed = true): StreamFrameCurveData {
    return this.curveData(this.effectiveKey(), seed);
  }

  private emitChanged() {
    this.dispatchEvent(new CustomEvent('changed', { bubbles: true, composed: true }));
  }

  // ---- shared curve math (annulus + exaggeration applied for the preview only) ----
  private scaleAtCurve(curve: StreamFrameCurveData, r: number, exaggeration: number): number {
    const cfg = this.settings;
    let s: number;
    if (cfg.distortion.mode === 'spline') {
      const points = [...curve.points].sort((a, b) => a.r - b.r);
      s = evaluateCurve(points, r);
    } else {
      s = 1 + (curve.k1 || 0) * r * r + (curve.k2 || 0) * r * r * r * r;
    }
    const an = cfg.distortion.annulus;
    if (an?.enable) {
      const f = an.feather ?? 0.05;
      const w = smoothstep(an.rMin - f, an.rMin + f, r) * (1 - smoothstep(an.rMax - f, an.rMax + f, r));
      s = 1 + (s - 1) * w;
    }
    return 1 + (s - 1) * exaggeration;
  }
  private rawScale(curve: StreamFrameCurveData, r: number): number {
    const cfg = this.settings;
    if (cfg.distortion.mode === 'spline') {
      const points = [...curve.points].sort((a, b) => a.r - b.r);
      return evaluateCurve(points, r);
    }
    return 1 + (curve.k1 || 0) * r * r + (curve.k2 || 0) * r * r * r * r;
  }
  // the full directional field for the preview: per axis blends the horizontal
  // and vertical curves of the previewed eye by the squared direction cosine,
  // exactly like the shader, then applies annulus and exaggeration
  private directionalScale(r: number, wH: number, exaggeration: number): number {
    const cfg = this.settings;
    const d = cfg.distortion;
    let s: number;
    if (d.perAxis) {
      const eyePrefix = d.perEye ? (this.curveKey().startsWith('right') ? 'right' : 'left') : '';
      const hKey = eyePrefix ? eyePrefix + 'Horizontal' : 'horizontal';
      const vKey = eyePrefix ? eyePrefix + 'Vertical' : 'vertical';
      s = this.rawScale(this.curveData(hKey, false), r) * wH + this.rawScale(this.curveData(vKey, false), r) * (1 - wH);
    } else {
      s = this.rawScale(this.activeCurve(false), r);
    }
    const an = d.annulus;
    if (an?.enable) {
      const f = an.feather ?? 0.05;
      const w = smoothstep(an.rMin - f, an.rMin + f, r) * (1 - smoothstep(an.rMax - f, an.rMax + f, r));
      s = 1 + (s - 1) * w;
    }
    return 1 + (s - 1) * exaggeration;
  }

  // ---- coordinate mapping for the curve plot ----
  private toX(r: number, w: number) { return r * w; }
  private toY(s: number, h: number) { return h / 2 - (s - 1) / this.scaleRange() * (h / 2 - 12); }
  private fromX(x: number, w: number) { return Math.min(1, Math.max(0, x / w)); }
  private fromY(y: number, h: number) { return 1 + (h / 2 - y) / (h / 2 - 12) * this.scaleRange(); }

  draw() {
    if (!this.curveCanvas || !this.previewCanvas) return;
    this.drawCurve();
    this.drawPreview();
  }

  private drawCurve() {
    const canvas = this.curveCanvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const cfg = this.settings;

    // annulus band
    const an = cfg.distortion.annulus;
    if (an?.enable) {
      ctx.fillStyle = 'rgba(200, 150, 150, 0.15)';
      ctx.fillRect(this.toX(an.rMin, w), 0, this.toX(an.rMax, w) - this.toX(an.rMin, w), h);
    }
    // identity line + labels
    ctx.strokeStyle = 'rgba(128,128,128,0.8)';
    ctx.beginPath(); ctx.moveTo(0, this.toY(1, h)); ctx.lineTo(w, this.toY(1, h)); ctx.stroke();
    ctx.fillStyle = 'rgba(128,128,128,1)'; ctx.font = '11px monospace';
    ctx.fillText('s=1', 4, this.toY(1, h) - 4);
    ctx.fillText('s=' + (1 + this.scaleRange()).toFixed(3), 4, 12);
    ctx.fillText('s=' + (1 - this.scaleRange()).toFixed(3), 4, h - 4);
    ctx.fillText('r=0', 2, this.toY(1, h) + 14);
    ctx.fillText('r=1', w - 28, this.toY(1, h) + 14);
    // sibling curves dimmed for comparison, active curve bright on top
    const activeKey = this.curveKey();
    for (const key of this.curveKeys()) {
      if (key === activeKey) continue;
      const curve = this.curveData(key, false);
      ctx.strokeStyle = 'rgba(95, 159, 223, 0.3)'; ctx.lineWidth = 1; ctx.beginPath();
      for (let i = 0; i <= 300; i++) {
        const r = i / 300;
        const y = this.toY(this.scaleAtCurve(curve, r, 1), h);
        if (i === 0) ctx.moveTo(this.toX(r, w), y); else ctx.lineTo(this.toX(r, w), y);
      }
      ctx.stroke();
    }
    const active = this.activeCurve(false);
    ctx.strokeStyle = '#5f9fdf'; ctx.lineWidth = 2; ctx.beginPath();
    for (let i = 0; i <= 300; i++) {
      const r = i / 300;
      const y = this.toY(this.scaleAtCurve(active, r, 1), h);
      if (i === 0) ctx.moveTo(this.toX(r, w), y); else ctx.lineTo(this.toX(r, w), y);
    }
    ctx.stroke(); ctx.lineWidth = 1;
    // control points in spline mode
    if (cfg.distortion.mode === 'spline') {
      for (let i = 0; i < active.points.length; i++) {
        const pt = active.points[i];
        ctx.fillStyle = i === this.dragIndex ? '#ffe9a0' : '#e8b64c';
        ctx.beginPath();
        ctx.arc(this.toX(pt.r, w), this.toY(pt.scale, h), 5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  private drawPreview() {
    const canvas = this.previewCanvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const cfg = this.settings;
    const ex = this.exaggeration();
    const cx = 0.5 + (cfg.centerOffsetXLeft || 0), cy = 0.5 + (cfg.centerOffsetY || 0);
    const appear = (qx: number, qy: number): [number, number] => {
      const px = qx - cx, py = qy - cy;
      const rs = Math.hypot(px, py);
      if (rs < 1e-6) return [qx, qy];
      // blend weight is constant along a ray, so the inversion stays 1d
      const wH = (px * px) / Math.max(px * px + py * py, 1e-12);
      let lo = 0, hi = 2.0;
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (mid * this.directionalScale(mid, wH, ex) < rs) lo = mid; else hi = mid;
      }
      const r = (lo + hi) / 2;
      const f = r / rs;
      return [cx + px * f, cy + py * f];
    };
    ctx.strokeStyle = '#5faf5f';
    const lines = 12, steps = 48;
    for (let axis = 0; axis < 2; axis++) {
      for (let li = 0; li <= lines; li++) {
        ctx.beginPath();
        for (let si = 0; si <= steps; si++) {
          const a = li / lines, b = si / steps;
          const [nx, ny] = axis === 0 ? appear(a, b) : appear(b, a);
          if (si === 0) ctx.moveTo(nx * w, ny * h); else ctx.lineTo(nx * w, ny * h);
        }
        ctx.stroke();
      }
    }
    ctx.fillStyle = '#dd5';
    ctx.beginPath(); ctx.arc(cx * w, cy * h, 3, 0, Math.PI * 2); ctx.fill();
  }

  // ---- interaction ----
  private canvasPos(event: PointerEvent | MouseEvent): [number, number] {
    const canvas = this.curveCanvas;
    const rect = canvas.getBoundingClientRect();
    return [(event.clientX - rect.left) * canvas.width / rect.width, (event.clientY - rect.top) * canvas.height / rect.height];
  }
  private hitTest(x: number, y: number): number {
    const cfg = this.settings;
    if (cfg.distortion.mode !== 'spline') return -1;
    const canvas = this.curveCanvas;
    // grab radius of 10 css pixels, converted to canvas units so hit testing
    // feels the same when the window scales the canvas down or up
    const rect = canvas.getBoundingClientRect();
    const cssToCanvas = rect.width > 0 ? canvas.width / rect.width : 1;
    const radius = 10 * cssToCanvas;
    const points = this.activeCurve(false).points;
    for (let i = 0; i < points.length; i++) {
      const pt = points[i];
      const dx = this.toX(pt.r, canvas.width) - x, dy = this.toY(pt.scale, canvas.height) - y;
      if (dx * dx + dy * dy < radius * radius) return i;
    }
    return -1;
  }
  onPointerDown = (event: PointerEvent) => {
    const [x, y] = this.canvasPos(event);
    this.dragIndex = this.hitTest(x, y);
    if (this.dragIndex >= 0) {
      (event.target as HTMLElement).setPointerCapture(event.pointerId);
      event.preventDefault();
    }
  }
  onPointerMove = (event: PointerEvent) => {
    if (this.dragIndex < 0) return;
    const canvas = this.curveCanvas;
    const [x, y] = this.canvasPos(event);
    const pt = this.activeCurve().points[this.dragIndex];
    if (!pt) { this.dragIndex = -1; return; }
    pt.r = Math.round(this.fromX(x, canvas.width) * 1000) / 1000;
    pt.scale = Math.round(this.fromY(y, canvas.height) * 100000) / 100000;
    this.emitChanged();
    this.draw();
  }
  onPointerUp = (event: PointerEvent) => {
    if (this.dragIndex < 0) return;
    this.dragIndex = -1;
    this.activeCurve().points.sort((a, b) => a.r - b.r);
    this.emitChanged();
    this.draw();
    void event;
  }
  onDoubleClick = (event: MouseEvent) => {
    const cfg = this.settings;
    if (cfg.distortion.mode !== 'spline') return;
    const canvas = this.curveCanvas;
    const [x, y] = this.canvasPos(event);
    const points = this.activeCurve().points;
    points.push({
      r: Math.round(this.fromX(x, canvas.width) * 1000) / 1000,
      scale: Math.round(this.fromY(y, canvas.height) * 100000) / 100000
    });
    points.sort((a, b) => a.r - b.r);
    this.emitChanged();
    this.draw();
    this.requestUpdate();
  }
  onContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    const cfg = this.settings;
    if (cfg.distortion.mode !== 'spline') return;
    const [x, y] = this.canvasPos(event);
    const index = this.hitTest(x, y);
    if (index >= 0) {
      this.activeCurve().points.splice(index, 1);
      this.emitChanged();
      this.draw();
      this.requestUpdate();
    }
  }

  convertK1K2ToSpline() {
    const cfg = this.settings;
    const curve = this.activeCurve();
    const radii = [0, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9];
    curve.points = radii.map(r => ({
      r,
      scale: Math.round((1 + curve.k1 * r * r + curve.k2 * r * r * r * r) * 100000) / 100000
    }));
    cfg.distortion.mode = 'spline';
    this.emitChanged();
    this.draw();
    this.requestUpdate();
  }
  resetCurve() {
    const cfg = this.settings;
    const curve = this.activeCurve();
    if (cfg.distortion.mode === 'spline') {
      curve.points = [{ r: 0, scale: 1 }, { r: 0.4, scale: 1 }, { r: 0.8, scale: 1 }];
    } else {
      curve.k1 = 0;
      curve.k2 = 0;
    }
    this.emitChanged();
    this.draw();
    this.requestUpdate();
  }
  onUiChanged() {
    this.emitChanged();
    this.draw();
  }

  private selectCurveKey(key: string) {
    this.curveKey.set(key);
    this.requestUpdate();
    this.draw();
  }

  render() {
    const keys = this.curveKeys();
    const mode = this.settings?.distortion?.mode;
    const active = this.settings ? this.activeCurve(false) : null;
    return html`<div class="curve-editor">
      ${keys.length > 1 ? html`<div class="toolbar curve-tabs">
        ${keys.map(key => html`<button ?disabled=${false} class=${this.curveKey() === key ? 'active-tab' : ''} type="button" @click=${() => this.selectCurveKey(key)}>${this.curveLabels[key] ?? key}</button>`)}
      </div>` : html``}
      <div class="toolbar">
        <span class="hint">
          ${mode === 'spline'
            ? t('Drag points to shape the curve. Double click adds a point, right click removes one.')
            : t('k1/k2 mode: adjust the values below the plot. Convert to spline for control at each radius.')}
        </span>
        <select class="range-select"
          .value=${String(this.scaleRange())}
          @change=${(e: Event) => { this.scaleRange.set(Number((e.target as HTMLSelectElement).value)); this.requestUpdate(); }}>
          ${this.scaleRangeOptions.map(o => html`<option value=${o}>±${(o * 100).toFixed(0)}%</option>`)}
        </select>
      </div>
      <canvas width="640" height="260"
        ref=${(el: HTMLElement | null) => { if (el) this.curveCanvas = el as HTMLCanvasElement; }}
        @pointerdown=${this.onPointerDown}
        @pointermove=${this.onPointerMove}
        @pointerup=${this.onPointerUp}
        @dblclick=${this.onDoubleClick}
        @contextmenu=${this.onContextMenu}></canvas>
      <div class="toolbar">
        <button type="button" @click=${() => this.convertK1K2ToSpline()}>${t('Convert k1/k2 to spline')}</button>
        <button type="button" @click=${() => this.resetCurve()}>${t('Reset curve')}</button>
      </div>
      ${mode !== 'spline' && active ? html`<div class="points-table">
        <div class="point-row">
          <span>k1</span>
          <input type="number" step="0.001" .value=${String(active.k1)} @change=${(e: Event) => { active.k1 = Number((e.target as HTMLInputElement).value); this.onUiChanged(); }}>
          <span>k2</span>
          <input type="number" step="0.001" .value=${String(active.k2)} @change=${(e: Event) => { active.k2 = Number((e.target as HTMLInputElement).value); this.onUiChanged(); }}>
        </div>
      </div>` : html``}
      ${mode === 'spline' && active ? html`<div class="points-table">
        ${active.points.map((point, i) => html`<div class="point-row">
          <span>r</span>
          <input type="number" step="0.01" min="0" max="1" .value=${String(point.r)} @change=${(e: Event) => { point.r = Number((e.target as HTMLInputElement).value); this.onUiChanged(); }}>
          <span>scale</span>
          <input type="number" step="0.0005" .value=${String(point.scale)} @change=${(e: Event) => { point.scale = Number((e.target as HTMLInputElement).value); this.onUiChanged(); }}>
        </div>`)}
      </div>` : html``}
      <div class="toolbar">
        <span class="hint">${t('Appearance preview (what you will see)', {})} ${t('exaggerated')} ${this.exaggeration()}x</span>
        <input type="range" min="1" max="30" .value=${String(this.exaggeration())} @input=${(e: Event) => { this.exaggeration.set(Number((e.target as HTMLInputElement).value)); }}>
      </div>
      <canvas width="360" height="360" class="preview"
        ref=${(el: HTMLElement | null) => { if (el) this.previewCanvas = el as HTMLCanvasElement; }}></canvas>
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'app-stream-frame-curve': StreamFrameCurve;
  }
}
