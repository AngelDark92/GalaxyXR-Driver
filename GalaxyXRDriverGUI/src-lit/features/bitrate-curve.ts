// 2026-10-19 bitrate curve graph.
// 2026-10-23: seven draggable points. P1 is fixed on the y axis with an
// editable floor; P2..P5 are free; P6 has y fixed at Max Bitrate and its x is
// the plateau start; P7 is fixed at (1,1). No 350 Mbit clamp. The preview
// window never writes settings; it emits committed point sets to the main
// Companion.
import { html, LitElement, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import {
  BITRATE_CURVE_FAMILIES, BITRATE_CURVE_POINT_GAP, bitrateCurveBase, bitrateCurveMbit,
  bitrateCurveFivePointsValid, bitrateCurvePointsValid, bitrateCurveRequestDomain,
  bitrateCurveSixPointsValid, moveBitrateCurvePoint, normalizeBitrateCurvePoints,
} from '../domain/bitrate-curve';
import type { BitrateCurvePoint } from '../domain/types';
import { t } from '../locale/i18n';

@customElement('app-bitrate-curve')
export class BitrateCurvePanel extends LitElement {
  static styles = css`
    :host { display: block; padding: 0.25rem 0 0.5rem; }
    .wrap { display: flex; flex-direction: column; gap: 0.35rem; min-height: 0; }
    canvas { width: 100%; max-width: 100%; height: auto; aspect-ratio: 7 / 3; touch-action: none; }
    canvas.editable { cursor: crosshair; }
    canvas:focus-visible { outline: 2px solid #5f9fdf; outline-offset: 2px; }
    canvas.locked { opacity: 0.75; }
    .legend { display: flex; gap: 1rem; align-items: center; font-size: 0.85rem; opacity: 0.9; flex-wrap: wrap; }
    .legend span.item { display: inline-flex; gap: 0.35rem; align-items: center; }
    .swatch { width: 18px; height: 0; border-top-width: 2px; border-top-style: solid; }
    .swatch.solid { border-color: #5f9fdf; }
    .swatch.base { border-top-width: 1px; border-color: rgba(95,159,223,0.55); }
    .swatch.dashed { border-top-style: dashed; border-color: rgba(128,128,128,0.9); }
    .swatch.max { border-top-width: 2px; border-color: #b07a2a; }
    .hint { font-size: 0.8rem; opacity: 0.75; }
    .error { color: #c42b1c; font-size: 0.8rem; }
    input, .error { -webkit-user-select: text; user-select: text; }
    .points {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      column-gap: 1.5rem;
      row-gap: 0.65rem;
      margin-top: 0.35rem;
      overflow: auto;
    }
    .point-row {
      display: grid;
      grid-template-columns: 1.7rem minmax(0, 1fr) minmax(0, 1fr);
      align-items: end;
      gap: 0.5rem;
      min-width: 0;
      padding: 0 0 0.35rem;
      border-bottom: 1px solid rgba(128,128,128,0.14);
    }
    .point-row .index { align-self: center; opacity: 0.75; font-size: 0.8rem; }
    .point-row label { display: flex; flex-direction: column; gap: 0.15rem; min-width: 0; font-size: 0.72rem; opacity: 0.9; }
    .point-row input { width: 100%; min-width: 0; box-sizing: border-box; }
    .actions { display: flex; gap: 0.5rem; align-items: center; }
    button.reset { font: inherit; font-size: 0.8rem; padding: 0.25rem 0.6rem; border-radius: 4px; border: 1px solid rgba(128,128,128,0.5); background: transparent; color: inherit; }
    button.reset:disabled { opacity: 0.45; }
  `;

  @property({ type: Number }) curve = 0;
  @property({ type: Number }) pct = 0;
  @property({ type: Number }) ceiling = 450;
  /** Zero preserves the neutral build's Max Bitrate request domain. */
  @property({ type: Number }) requestReference = 0;
  @property({ type: Boolean }) forceCbr = false;
  @property({ type: Number }) headroomPct = 0;
  /** Retained for preview IPC compatibility; constancy does not fix request. */
  @property({ type: Boolean }) fixed = false;
  /** Six displayed handles: derived for presets, saved shape for Custom. */
  @property({ attribute: false }) points: BitrateCurvePoint[] = [];
  /** The graph window sets this; the main page does not embed the editor. */
  @property({ type: Boolean }) editable = false;
  /** SteamVR is running: no edits, matching the main page's locked rows. */
  @property({ type: Boolean }) locked = false;

  @state() private localPoints: BitrateCurvePoint[] = [];
  @state() private dragIndex = -1;
  @state() private dragCustom = false;
  @state() private dragMoved = false;
  private dragStart: BitrateCurvePoint[] = [];
  private dragCustomStart = false;
  private dragSnapshotChanged = false;
  @state() private selected = 0;
  @state() private inputError = '';
  private resizeObserver?: ResizeObserver;

  connectedCallback() {
    super.connectedCallback();
    this.localPoints = this.acceptPoints();
  }

  private acceptPoints(): BitrateCurvePoint[] {
    // Clone malformed entries into objects so validation can reject them
    // without throwing. Only recognized valid shapes may be normalized.
    const points = Array.isArray(this.points) ? this.points.map(point => ({ ...point })) : [];
    return bitrateCurvePointsValid(points) || bitrateCurveSixPointsValid(points) || bitrateCurveFivePointsValid(points)
      ? normalizeBitrateCurvePoints(points) : points;
  }

  protected updated(changed: Map<string, unknown>) {
    if (changed.has('points') || changed.has('curve')) {
      if (this.dragIndex < 0) {
        this.localPoints = this.acceptPoints();
        this.dragCustom = false;
        this.inputError = '';
      } else {
        this.dragSnapshotChanged = true;
      }
    }
    if (changed.has('locked') && this.locked) {
      this.dragIndex = -1;
      this.dragMoved = false;
      this.dragCustom = false;
      this.localPoints = this.acceptPoints();
    }
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

  private drawingCustom(): boolean {
    return this.dragCustom || this.curve === 3;
  }

  private valid(): boolean {
    return BITRATE_CURVE_FAMILIES.some(entry => entry.value === this.curve)
      && Number.isFinite(this.pct) && this.pct >= 0 && this.pct <= 100
      && Number.isFinite(this.ceiling) && this.ceiling > 0
      && Number.isFinite(this.requestReference) && this.requestReference >= 0
      && Number.isFinite(this.headroomPct) && this.headroomPct >= 0 && this.headroomPct <= 100
      && (!this.drawingCustom() || bitrateCurvePointsValid(this.localPoints));
  }

  private plotDomain() {
    const request = bitrateCurveRequestDomain(this.ceiling, this.requestReference);
    const x = this.requestReference > 0 ? this.requestReference : this.ceiling;
    return { request, x, y: Math.max(x, this.ceiling) };
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
    const domain = this.plotDomain();
    const xAt = (mbit: number) => padL + (W - padL - padR) * Math.max(0, Math.min(1, mbit / domain.x));
    const yAt = (mbit: number) => H - padB - (H - padT - padB) * Math.max(0, Math.min(1, mbit / domain.y));
    const points = this.localPoints;
    const custom = this.drawingCustom();

    ctx.clearRect(0, 0, W, H);

    ctx.strokeStyle = 'rgba(128,128,128,0.25)';
    ctx.lineWidth = 1;
    ctx.fillStyle = 'rgba(128,128,128,1)';
    ctx.font = '11px monospace';
    const xTicks = [...new Set([0, 0.25, 0.5, 0.75, 1].map(frac => domain.x * frac).concat(domain.request))].sort((a, b) => a - b);
    for (const value of xTicks) {
      const x = xAt(value);
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, H - padB); ctx.stroke();
      const label = String(Math.round(value));
      ctx.fillText(label, x - ctx.measureText(label).width / 2, H - padB + 14);
    }
    // Keep the exact reference and Max Bitrate ticks even when the regular
    // midpoint would overlap them (for example 350 and 400 with Max 800).
    const requiredYTicks = [...new Set([0, domain.x, ceiling])];
    const midpoint = domain.y / 2;
    const yTicks = [...requiredYTicks];
    if (requiredYTicks.every(value => Math.abs(yAt(value) - yAt(midpoint)) >= 14)) yTicks.push(midpoint);
    for (const value of yTicks.sort((a, b) => a - b)) {
      const y = yAt(value);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
      const label = String(Math.round(value));
      ctx.fillText(label, padL - 6 - ctx.measureText(label).width, y + 4);
    }

    // Max Bitrate line: every point and every lifted target stays on/under it.
    ctx.strokeStyle = '#b07a2a';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(padL, yAt(ceiling)); ctx.lineTo(W - padR, yAt(ceiling)); ctx.stroke();
    ctx.fillStyle = '#b07a2a';
    const maxLabel = t('Max Bitrate {value} Mbit/s', { value: String(Math.round(ceiling)) });
    ctx.fillText(maxLabel, W - padR - ctx.measureText(maxLabel).width, yAt(ceiling) - 4);
    ctx.lineWidth = 1;

    // Streamer standard: identity over its own request range, including the
    // part above a lower user-selected Max Bitrate.
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = 'rgba(128,128,128,0.9)';
    ctx.beginPath();
    ctx.moveTo(xAt(0), yAt(0));
    ctx.lineTo(xAt(domain.x), yAt(domain.x));
    ctx.stroke();
    ctx.setLineDash([]);

    // base curve: the control-point geometry before the constancy lift
    ctx.strokeStyle = 'rgba(95,159,223,0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const samples = 81;
    for (let i = 0; i < samples; i++) {
      const request = domain.x * i / (samples - 1);
      const xNorm = request / domain.request;
      const target = ceiling * (custom
        ? bitrateCurveBase(xNorm, 3, points)
        : bitrateCurveBase(xNorm, this.curve));
      const x = xAt(request);
      const y = yAt(target);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Final average target: the same request-domain, constancy, headroom and
    // Force CBR policy as the driver, without the temporal request filter.
    ctx.strokeStyle = '#5f9fdf';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < samples; i++) {
      const request = domain.x * (i / (samples - 1));
      const target = bitrateCurveMbit(request, ceiling, custom ? 3 : this.curve, this.pct,
        points, this.requestReference, this.headroomPct, this.forceCbr);
      const x = xAt(request);
      const y = yAt(target);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.lineWidth = 1;

    // Fixed base endpoint: P7 is hidden. For Max below the request reference,
    // the curve continues horizontally from here to the plot's right edge.
    const endpointX = xAt(domain.request), endpointY = yAt(ceiling);
    ctx.strokeStyle = '#5f9fdf';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(endpointX, endpointY); ctx.lineTo(endpointX, endpointY + 7); ctx.stroke();
    ctx.lineWidth = 1;

    // draggable handles: P1..P6. P7 is represented by the endpoint tick above.
    const handleRadius = 5;
    for (let i = 0; i < points.length - 1; i++) {
      const point = points[i];
      const x = xAt(point.x * domain.request);
      const y = yAt(point.y * ceiling);
      const selected = i === this.selected;
      ctx.globalAlpha = this.locked ? 0.45 : 1;
      ctx.fillStyle = selected ? '#ffffff' : '#5f9fdf';
      ctx.strokeStyle = '#5f9fdf';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, handleRadius + (selected ? 1.5 : 0), 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      if (selected && !this.locked) {
        ctx.setLineDash([2, 2]);
        ctx.strokeStyle = 'rgba(255,255,255,0.7)';
        ctx.beginPath(); ctx.arc(x, y, handleRadius + 5, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.lineWidth = 1;
      ctx.globalAlpha = 1;
    }

    ctx.fillStyle = 'rgba(128,128,128,1)';
    const xTitle = t('streamer request (Mbit/s)');
    ctx.fillText(xTitle, padL + (W - padL - padR) / 2 - ctx.measureText(xTitle).width / 2, H - 6);
    ctx.save();
    ctx.translate(12, padT + (H - padT - padB) / 2 + ctx.measureText(t('applied target (Mbit/s)')).width / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(t('applied target (Mbit/s)'), 0, 0);
    ctx.restore();
  }

  private canvasGeometry(event: PointerEvent | MouseEvent) {
    const canvas = this.renderRoot.querySelector('canvas');
    if (!canvas) return undefined;
    const rect = canvas.getBoundingClientRect();
    const padL = 56, padR = 16, padT = 16, padB = 34;
    const domain = this.plotDomain();
    return {
      canvas, rect,
      x: (event.clientX - rect.left - padL) / Math.max(1, rect.width - padL - padR) * domain.x / domain.request,
      y: (1 - (event.clientY - rect.top - padT) / Math.max(1, rect.height - padT - padB)) * domain.y / this.ceiling,
    };
  }

  private hitTest(event: PointerEvent): number {
    const canvas = this.renderRoot.querySelector('canvas');
    if (!canvas) return -1;
    const rect = canvas.getBoundingClientRect();
    const padL = 56, padR = 16, padT = 16, padB = 34;
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const plotW = Math.max(1, rect.width - padL - padR);
    const plotH = Math.max(1, rect.height - padT - padB);
    const domain = this.plotDomain();
    let best = -1, bestDistance = 16;
    // P7 is hidden and not selectable; P6 remains draggable even when it
    // overlaps the fixed endpoint.
    for (let i = 0; i < this.localPoints.length - 1; i++) {
      const point = this.localPoints[i];
      const handleX = padL + plotW * point.x * domain.request / domain.x;
      const handleY = padT + plotH * (1 - point.y * this.ceiling / domain.y);
      const distance = Math.hypot(px - handleX, py - handleY);
      if (distance <= bestDistance) { best = i; bestDistance = distance; }
    }
    return best;
  }

  private onPointerDown(event: PointerEvent) {
    if (!this.editable || this.locked) return;
    const index = this.hitTest(event);
    if (index < 0) return;
    const geometry = this.canvasGeometry(event);
    if (!geometry) return;
    this.dragIndex = index;
    this.dragMoved = false;
    this.dragStart = this.localPoints.map(point => ({ ...point }));
    this.dragCustomStart = this.dragCustom;
    this.dragSnapshotChanged = false;
    this.selected = index;
    this.inputError = '';
    geometry.canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
    this.requestUpdate();
  }

  private onPointerMove(event: PointerEvent) {
    if (this.dragIndex < 0 || !this.editable || this.locked) return;
    const geometry = this.canvasGeometry(event);
    if (!geometry) return;
    this.dragCustom = true;
    this.localPoints = moveBitrateCurvePoint(this.localPoints, this.dragIndex, geometry.x, geometry.y);
    this.dragMoved = this.localPoints.some((point, index) =>
      point.x !== this.dragStart[index].x || point.y !== this.dragStart[index].y);
    this.requestUpdate();
  }

  private onPointerUp(event: PointerEvent) {
    if (this.dragIndex < 0) return;
    const geometry = this.canvasGeometry(event);
    try { geometry?.canvas.releasePointerCapture(event.pointerId); } catch { /* already released */ }
    const points = this.localPoints.map(point => ({ ...point }));
    const moved = this.dragMoved;
    this.dragIndex = -1;
    this.dragMoved = false;
    if (event.type === 'pointercancel' || !this.editable || this.locked || this.dragSnapshotChanged) {
      const useSnapshot = this.dragSnapshotChanged || this.locked;
      this.localPoints = useSnapshot ? this.acceptPoints() : this.dragStart.map(point => ({ ...point }));
      this.dragCustom = useSnapshot ? false : this.dragCustomStart;
      this.dragSnapshotChanged = false;
      this.requestUpdate();
      return;
    }
    if (!moved) {
      this.dragCustom = this.dragCustomStart;
      this.requestUpdate();
      return;
    }
    this.commit(points);
  }

  private onKeyDown(event: KeyboardEvent) {
    if (!this.editable || this.locked) return;
    const step = event.shiftKey ? 0.05 : 0.01;
    let dx = 0, dy = 0;
    if (event.key === 'ArrowLeft') dx = -step;
    else if (event.key === 'ArrowRight') dx = step;
    else if (event.key === 'ArrowUp') dy = step;
    else if (event.key === 'ArrowDown') dy = -step;
    else if (event.key === 'Tab') return;
    else return;
    event.preventDefault();
    this.dragCustom = true;
    this.localPoints = moveBitrateCurvePoint(this.localPoints, this.selected,
      this.localPoints[this.selected].x + dx, this.localPoints[this.selected].y + dy);
    this.commit(this.localPoints.map(point => ({ ...point })));
  }

  private applyNumeric(index: number, axis: 'x' | 'y', mbit: number) {
    const point = this.localPoints[index];
    // Preserve the untouched normalized coordinate exactly. Display rounding
    // must never change the other axis during a numeric edit.
    const xMbit = axis === 'x' ? mbit : point.x * this.plotDomain().request;
    const yMbit = axis === 'y' ? mbit : point.y * this.ceiling;
    if (!this.editable || this.locked || !Number.isFinite(xMbit) || !Number.isFinite(yMbit)) {
      this.inputError = t('Enter whole numbers for the request and target.');
      return;
    }
    const last = this.localPoints.length - 1;
    const xLocked = index === 0 || index === last;
    const yLocked = index === last - 1 || index === last;
    const x = xLocked ? (index === 0 ? 0 : 1) : axis === 'x' ? xMbit / this.plotDomain().request : point.x;
    const y = yLocked ? 1 : axis === 'y' ? yMbit / this.ceiling : point.y;
    const lowX = index === 0 ? 0 : this.localPoints[index - 1].x + BITRATE_CURVE_POINT_GAP;
    const highX = index >= last - 1 ? 1 : this.localPoints[index + 1].x - BITRATE_CURVE_POINT_GAP;
    const lowY = index === 0 ? 0 : this.localPoints[index - 1].y;
    const highY = index === last ? 1 : this.localPoints[index + 1].y;
    if (x < lowX || x > highX || y < lowY || y > highY) {
      this.inputError = t('Points must keep their order: request increases left-to-right and target never decreases.');
      return;
    }
    const next = moveBitrateCurvePoint(this.localPoints, index, x, y);
    if (!bitrateCurvePointsValid(next)) {
      this.inputError = t('Points must keep their order: request increases left-to-right and target never decreases.');
      return;
    }
    this.inputError = '';
    this.dragCustom = true;
    this.localPoints = next;
    this.commit(next.map(point => ({ ...point })));
  }

  private commit(points: BitrateCurvePoint[]) {
    this.dispatchEvent(new CustomEvent('points-change', {
      detail: { points }, bubbles: true, composed: true,
    }));
  }

  private reset() {
    if (!this.editable || this.locked) return;
    this.dispatchEvent(new CustomEvent('points-reset', { bubbles: true, composed: true }));
  }

  render() {
    if (!this.valid()) {
      return html`<p role="alert" class="error">${t('Cannot plot these curve values. Check the curve family, constancy, Max Bitrate and the seven points.')}</p>`;
    }
    const family = BITRATE_CURVE_FAMILIES.find(entry => entry.value === this.curve) ?? BITRATE_CURVE_FAMILIES[0];
    const familyLabel = this.drawingCustom() && this.curve !== 3 ? t('Custom (editing)') : t(family.label);
    const requestDomain = this.plotDomain().request;
    const hint = this.locked
      ? t('Close SteamVR to change the curve.')
      : this.editable
        ? t('P1 is fixed at request 0 with an editable floor. P2–P5 move freely. P6 starts the flat Max Bitrate section; drag it left to begin the plateau earlier. P7 is the fixed endpoint and cannot be selected. Request must increase left-to-right and target must never decrease. The thin line shows the base curve before constancy and headroom.')
        : '';
    const policyHint = this.forceCbr
      ? t('Force CBR fixes the final average target at Max Bitrate; curve, constancy and headroom do not apply.')
      : this.pct >= 100
        ? t('At 100% constancy, positive requests reach the final average limit after any headroom reservation. The points still shape the base curve.')
        : this.headroomPct > 0
          ? t('Headroom reserves part of Max Bitrate for the VBR peak and can limit the final average target below the base curve.')
          : '';
    return html`
      <div class="wrap">
        <canvas class=${`${this.editable ? 'editable' : ''} ${this.locked ? 'locked' : ''}`}
          tabindex=${this.editable && !this.locked ? '0' : '-1'}
          @pointerdown=${this.onPointerDown} @pointermove=${this.onPointerMove}
          @pointerup=${this.onPointerUp} @pointercancel=${this.onPointerUp}
          @keydown=${this.onKeyDown}></canvas>
        <div class="legend">
          <span class="item"><span class="swatch solid"></span>${t('Final average target')} — ${familyLabel}, ${this.pct}%</span>
          <span class="item"><span class="swatch base"></span>${t('Base curve (points)')}</span>
          <span class="item"><span class="swatch dashed"></span>${t('Streamer standard (linear)')}</span>
          <span class="item"><span class="swatch max"></span>${t('Max Bitrate {value} Mbit/s', { value: String(Math.round(this.ceiling)) })}</span>
        </div>
        ${hint ? html`<div class="hint">${hint}</div>` : ''}
        ${policyHint ? html`<div class="hint">${policyHint}</div>` : ''}
        <div class="hint">${t('Positive-request, steady-state targets only; not measured throughput. The five-frame request filter and the zero or missing request fallback are not shown.')}</div>
        ${this.inputError ? html`<p class="error" role="alert">${this.inputError}</p>` : ''}
        ${this.editable ? html`
          <div class="points">
            ${this.localPoints.slice(0, -1).map((point, index) => {
              const last = this.localPoints.length - 1;
              const xLocked = index === 0;
              const yLocked = index === last - 1;
              return html`
              <div class="point-row">
                <span class="index">P${index + 1}</span>
                <label>${t('Request')} Mbit/s
                  <input type="number" min="0" max=${requestDomain} step="1" .value=${String(Math.round(point.x * requestDomain))}
                    ?disabled=${this.locked || xLocked} aria-label=${t('Point {index} request Mbit/s', { index: index + 1 })}
                    @change=${(event: Event) => this.applyNumeric(index, 'x',
                      Number((event.target as HTMLInputElement).value))}>
                </label>
                <label>${t('Target')} Mbit/s
                  <input type="number" min="0" max=${this.ceiling} step="1" .value=${String(Math.round(point.y * this.ceiling))}
                    ?disabled=${this.locked || yLocked} aria-label=${t('Point {index} target Mbit/s', { index: index + 1 })}
                    @change=${(event: Event) => this.applyNumeric(index, 'y',
                      Number((event.target as HTMLInputElement).value))}>
                </label>
              </div>`;
            })}
          </div>
          <div class="actions">
            <button class="reset" ?disabled=${this.locked} @click=${() => this.reset()}>${t('Reset points')}</button>
          </div>` : ''}
      </div>`;
  }
}
