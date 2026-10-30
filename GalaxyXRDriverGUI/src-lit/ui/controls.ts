import { helpPopover } from './help-popover';
// Application control adapters (Lit frontend, 2026-09-20 migration).
// Thin normalizers over the pinned @fluentui/web-components v3.1.3 package:
// each adapter exposes a typed application value and exactly one normalized
// user-intent event, so pages never see Fluent's internal event payloads.
// Adapter contract for the pinned Fluent v3 components:
//   fluent-switch  (BaseCheckbox): checked, change
//   fluent-dropdown: value, change, fluent-option children
//   fluent-slider : value/min/max/step, change
//   fluent-dialog : open, toggle
import { html, nothing, LitElement, type PropertyValues } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { css } from 'lit';
import { t } from '../locale/i18n';
import { interactiveStyles } from './shared-styles';
import {
  DEFAULT_CONTROL_CONTEXT, numberBounds, numberInputError,
  type ControlContext, type NumberControlSpec,
} from '../domain/control-specs';

let controlId = 0;
function nextControlId(): number { return ++controlId; }

function accessibleLabel(element: HTMLElement, explicit = ''): string {
  return explicit || element.closest('.field')?.querySelector('.title > span')?.textContent?.trim() || t('Setting');
}

export const controlStyles = css`
  ${interactiveStyles}
  :host {
    display: inline-block;
  }
`;

/**
 * app-switch — boolean control over a real boolean setting.
 * The string "false" can never become checked just because an attribute
 * exists: `checked` is a property, and programmatic updates do not fire
 * `change` (only user intent does).
 */
@customElement('app-switch')
export class AppSwitch extends LitElement {
  static styles = [controlStyles, css`
    :host { display: inline-flex; align-items: center; gap: 10px; min-height: 32px; }
    fluent-switch { flex: 0 0 auto; }
    .state { min-width: 3ch; color: var(--colorNeutralForeground2); font-size: 0.9em; }
  `];

  @property({ type: Boolean }) checked = false;
  @property({ type: Boolean }) disabled = false;
  @property({ type: String }) label = '';
  @property({ type: Boolean }) known = true;

  private onNativeChange = (event: Event) => {
    // Stop the original event. Letting both it and the normalized event bubble
    // made page handlers execute twice, the second time with detail=undefined.
    event.stopPropagation();
    if (this.disabled || !this.known) return;
    const control = event.currentTarget as HTMLElement & { checked: boolean };
    this.checked = control.checked === true;
    this.dispatchEvent(new CustomEvent<boolean>('change', { detail: this.checked, bubbles: true, composed: true }));
  };

  render() {
    return html`<fluent-switch
      .checked=${this.checked}
      ?disabled=${this.disabled || !this.known}
      aria-label=${accessibleLabel(this, this.label)}
      @change=${this.onNativeChange}
    ></fluent-switch><span class="state" aria-hidden="true">${!this.known ? t('Unknown') : this.checked ? t('On') : t('Off')}</span>`;
  }
}

export interface AppSelectOption {
  /** The value the domain stores for this option: a string, or a number when
   *  the original Angular option used a numeric [value] (e.g. the tuner
   *  segment count 1/4/8 and the Kalman lag epoch 0/1). The adapter must
   *  hand this exact value back to the page on change. */
  value: string | number;
  label: string;
}

/**
 * app-select — choice control storing the documented domain value (not the
 * visual index). `change` fires once per user commit with the stored value,
 * preserving its declared type: Fluent's dropdown reports option values as
 * strings, so a raw string is mapped back to the declared option (whose
 * value may be a number) before the event is emitted.
 */
@customElement('app-select')
export class AppSelect extends LitElement {
  static styles = css`
    :host {
      display: inline-block;
      min-width: min(14rem, 100%);
      max-width: 100%;
    }
    fluent-dropdown {
      width: 100%;
    }
    fluent-listbox { transform-origin: top center; }
    fluent-listbox:popover-open { animation: dropdown-in 120ms cubic-bezier(0.2, 0, 0, 1) both; }
    @keyframes dropdown-in {
      from { opacity: 0; transform: translateY(-4px) scale(0.98); }
      to { opacity: 1; transform: none; }
    }
    @media (prefers-reduced-motion: reduce) {
      fluent-listbox:popover-open { animation: none; }
    }
  `;

  @property({ type: String }) value = '';
  @property({ attribute: false }) options: AppSelectOption[] = [];
  @property({ type: Boolean }) disabled = false;
  @property({ type: Number }) width = 300;
  @property({ type: String }) label = '';
  private syncTimer?: ReturnType<typeof setTimeout>;

  private onNativeChange = (event: Event) => {
    event.stopPropagation();
    if (this.disabled) return;
    const el = event.currentTarget as HTMLSelectElement;
    const raw = String(el.value ?? '');
    const opt = this.options.find(o => String(o.value) === raw);
    if (!opt) return; // An unselected/unknown option is not a settings change.
    const detail: string | number = opt.value;
    this.value = String(detail);
    this.dispatchEvent(new CustomEvent('change', { detail, bubbles: true, composed: true }));
  };

  /**
   * Sync the selected value onto the Fluent dropdown.
   *
   * The Fluent `value` setter (dropdown.base.js) calls `selectOption`, which does
   * `this.listbox.selectOption(...)` WITHOUT guarding `this.listbox`. The listbox
   * is only assigned once the dropdown's listbox element is slotted, which happens
   * after the element is connected. Lit sets `.value` during the FIRST render —
   * before that — so setting it in the template throws and aborts the render (the
   * control vanishes). Instead we set it after connect and retry a few frames until
   * the dropdown's listbox is ready and accepts it. `shouldEmit` is false, so this
   * never fires a spurious `change`.
   */
  private syncValue(attempts = 0): void {
    if (!this.isConnected) return;
    const dd = this.renderRoot.querySelector('fluent-dropdown') as unknown as { listbox?: unknown; value: string; control?: HTMLElement } | null;
    if (!dd) return;
    if (!this.options.some(o => String(o.value) === String(this.value))) return;
    // The dropdown's listbox is assigned by an async slotchange event; its
    // value setter throws until then. Wait for it, then set the value.
    if (!dd.listbox) {
      if (attempts < 60) this.syncTimer = setTimeout(() => this.syncValue(attempts + 1), 16);
      return;
    }
    try {
      dd.value = String(this.value);
      dd.control?.setAttribute('aria-label', accessibleLabel(this, this.label));
    } catch {
      if (attempts < 60) this.syncTimer = setTimeout(() => this.syncValue(attempts + 1), 16);
    }
  }

  // `updated()` fires with an empty changed map on the initial render when the
  // properties were set before connect, so we sync from `firstUpdated` (fires
  // once, after the first render) as well as on later value/option changes.
  disconnectedCallback(): void {
    if (this.syncTimer !== undefined) clearTimeout(this.syncTimer);
    super.disconnectedCallback();
  }

  firstUpdated(): void { this.syncValue(); }

  updated(changed: PropertyValues): void {
    if (changed.has('value') || changed.has('options') || changed.has('disabled')) {
      if (this.syncTimer !== undefined) clearTimeout(this.syncTimer);
      this.syncValue();
    }
  }

  render() {
    // The Fluent dropdown assigns its internal `listbox` from a slotted
    // `*-listbox` element (slotchangeHandler); without it the value setter and
    // selection throw. So the options must live inside a <fluent-listbox>.
    // The current selection is expressed with the option `selected` attribute
    // (drives the option's selected state robustly, without calling the
    // listbox-dependent `value` setter before the listbox is slotted).
    return html`<fluent-dropdown
      ?disabled=${this.disabled}
      aria-label=${accessibleLabel(this, this.label)}
      style=${`width: ${this.width}px; max-width: 100%;`}
      @change=${this.onNativeChange}
    ><fluent-listbox>${this.options.map(o => html`<fluent-option .value=${String(o.value)} ?selected=${String(o.value) === String(this.value)}>${o.label}</fluent-option>`)}</fluent-listbox></fluent-dropdown>`;
  }
}

/**
 * app-choice — segmented choice for 2-4 enumerated values. Unlike a dropdown it
 * keeps every option visible, which is what makes a finite set read as finite.
 * `change` carries the declared option value (string or number), same contract
 * as app-select. A stored value outside the option list stays selectable only
 * as an explicit "Stored: X" button added by the caller, so it is never
 * silently replaced.
 */
@customElement('app-choice')
export class AppChoice extends LitElement {
  static styles = css`
    ${interactiveStyles}
    :host { display: inline-block; max-width: 100%; }
    .segmented {
      display: inline-flex;
      flex-wrap: wrap;
      border: 1px solid var(--colorNeutralStroke1, #d1d1d1);
      border-radius: 6px;
      overflow: hidden;
      background: var(--colorNeutralBackground1, #fff);
    }
    button {
      min-height: 34px;
      padding: 5px 12px;
      border: 0;
      border-radius: 0;
      background: transparent;
      white-space: nowrap;
      transition: background-color 120ms ease, color 120ms ease, transform 80ms ease;
    }
    button:active:not(:disabled) { transform: scale(0.98); }
    button + button { border-left: 1px solid var(--colorNeutralStroke2, #e0e0e0); }
    button[aria-pressed='true'] {
      background: var(--colorBrandBackground, #0f6cbd);
      color: var(--colorNeutralForegroundOnBrand, #fff);
    }
    button[aria-pressed='true']:hover:not(:disabled) { background: var(--colorBrandBackgroundHover, #115ea3); }
    button:disabled { cursor: not-allowed; }
  `;

  @property({ attribute: false }) options: AppSelectOption[] = [];
  @property({ attribute: false }) value: string | number = '';
  @property({ type: Boolean }) disabled = false;
  @property({ type: String }) label = '';

  private select(option: AppSelectOption): void {
    if (this.disabled || String(option.value) === String(this.value)) return;
    this.value = option.value;
    this.dispatchEvent(new CustomEvent('change', { detail: option.value, bubbles: true, composed: true }));
  }

  render() {
    return html`<div class="segmented" role="group" aria-label=${accessibleLabel(this, this.label)}>
      ${this.options.map(option => html`<button type="button"
        aria-pressed=${String(option.value) === String(this.value) ? 'true' : 'false'}
        ?disabled=${this.disabled}
        @click=${() => this.select(option)}>${option.label}</button>`)}
    </div>`;
  }
}

export interface VectorAxis {
  key: string;
  /** Visible axis caption (X / Y / Z or R / G / B). */
  label: string;
  /** Accessible name; falls back to the visible caption. */
  ariaLabel?: string;
  value: number;
  spec?: NumberControlSpec;
  disabled?: boolean;
}

/**
 * app-vector — 2-3 labelled axis cells sharing one spec-driven numeric field
 * each. The visible caption sits with its field, so X/Y/Z (or R/G/B) no longer
 * float as unlabelled spans. `axis-change` carries the axis key and value.
 */
@customElement('app-vector')
export class AppVector extends LitElement {
  static styles = css`
    ${interactiveStyles}
    :host { display: block; max-width: 100%; }
    .vector {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(7.5rem, 1fr));
      gap: 0.4rem 0.75rem;
      align-items: end;
    }
    .vector-cell { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .vector-label {
      color: var(--colorNeutralForeground3, #616161);
      font-size: 0.8rem;
      font-weight: 600;
      letter-spacing: 0.02em;
    }
  `;

  @property({ attribute: false }) axes: VectorAxis[] = [];
  @property({ attribute: false }) ctx?: ControlContext;

  private axisChanged(key: string, event: CustomEvent<number>): void {
    if (!Number.isFinite(event.detail)) return;
    this.dispatchEvent(new CustomEvent('axis-change', {
      detail: { key, value: event.detail }, bubbles: true, composed: true,
    }));
  }

  render() {
    return html`<div class="vector">
      ${this.axes.map(axis => html`<span class="vector-cell">
        <span class="vector-label">${axis.label}</span>
        <app-number .spec=${axis.spec} .ctx=${this.ctx} .value=${axis.value}
          .label=${axis.ariaLabel ?? axis.label} .disabled=${!!axis.disabled} .commitOn=${'blur'}
          @change=${(event: CustomEvent<number>) => this.axisChanged(axis.key, event)}></app-number>
      </span>`)}
    </div>`;
  }
}

/**
 * app-number — numeric field. Keeps the draft string separate from the last
 * valid numeric value: empty/NaN input never becomes 0 in the store; pages
 * receive `change` with a finite number or undefined (leave untouched).
 *
 * 2026-10-30: a spec-driven mode. With `.spec` set, the field resolves its
 * bounds from the codec/context, keeps the typed draft private, validates on
 * blur/Enter and refuses an out-of-contract edit (`invalid` event) instead of
 * writing it. A stored value outside the spec is still shown verbatim and
 * flagged, never rewritten. `commitOn` defaults to `input`, which preserves
 * the legacy per-keystroke behavior for rows that have not migrated yet.
 */
@customElement('app-number')
export class AppNumber extends LitElement {
  static styles = css`
    ${interactiveStyles}
    :host {
      display: inline-flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 2px;
    }
    .shell {
      position: relative;
      display: inline-flex;
      align-items: center;
    }
    input {
      width: 6rem;
      height: 1.8rem;
      padding: 0 0.4rem;
      font-size: 130%;
      text-align: right;
      border-radius: 0.25rem;
      border: 0.1rem solid var(--colorNeutralStroke1, #888);
      background: var(--colorNeutralBackground2, #f4f4f4);
      color: var(--colorNeutralForeground1, #202020);
      font-variant-numeric: tabular-nums;
    }
    .shell.has-unit input {
      width: 9rem;
      padding-right: 3.4rem;
    }
    .unit {
      position: absolute;
      right: 0.5rem;
      color: var(--colorNeutralForeground3, #616161);
      font-size: 0.85em;
      pointer-events: none;
      white-space: nowrap;
    }
    input[aria-invalid='true'] {
      border-color: var(--colorPaletteDarkOrangeForeground1, #a85000);
    }
    .error {
      max-width: 16rem;
      color: var(--colorPaletteRedForeground1, #b00020);
      font-size: 0.8rem;
      line-height: 1.35;
    }
    .stored-warning {
      max-width: 16rem;
      color: var(--colorPaletteDarkOrangeForeground1, #a85000);
      font-size: 0.8rem;
      line-height: 1.35;
    }
  `;

  @property({ type: Number }) value = 0;
  @property({ type: Number }) min = -Infinity;
  @property({ type: Number }) max = Infinity;
  @property({ type: Number }) step = 1;
  @property({ type: Boolean }) disabled = false;
  @property({ type: Boolean }) wide = false;
  @property({ type: String }) unit = '';
  @property({ type: Boolean }) integer = false;
  /** Explicit accessible name; required for multi-field (vector) rows. */
  @property({ type: String }) label = '';
  /** 'input' keeps the legacy per-keystroke commit; 'blur' waits for commit. */
  @property({ type: String }) commitOn: 'input' | 'blur' = 'input';
  @property({ attribute: false }) spec?: NumberControlSpec;
  @property({ attribute: false }) ctx?: ControlContext;

  private draft?: string;
  private error = '';
  private readonly errorId = `app-number-error-${nextControlId()}`;

  private get context(): ControlContext { return this.ctx ?? DEFAULT_CONTROL_CONTEXT; }

  private get bounds(): { min: number; max: number } {
    if (this.spec) return numberBounds(this.spec, this.context);
    return { min: this.min, max: this.max };
  }

  private get unitText(): string { return this.spec?.unit ?? this.unit; }

  private validate(value: number): string | undefined {
    if (!this.spec) return undefined;
    return numberInputError(this.spec.key, value, this.context);
  }

  private emitChange(value: number): void {
    this.value = value;
    this.dispatchEvent(new CustomEvent('change', { detail: value, bubbles: true, composed: true }));
  }

  private commit = (): void => {
    if (this.disabled || this.commitOn !== 'blur' || this.draft === undefined) return;
    const raw = this.draft.trim();
    if (raw === '') {
      this.error = t('Enter a value.');
      this.requestUpdate();
      return;
    }
    const num = Number(raw);
    if (!Number.isFinite(num)) {
      this.error = t('Enter a number.');
      this.requestUpdate();
      return;
    }
    const problem = this.validate(num);
    if (problem) {
      this.error = problem;
      this.dispatchEvent(new CustomEvent('invalid', {
        detail: { key: this.spec?.key, message: problem }, bubbles: true, composed: true,
      }));
      this.requestUpdate();
      return;
    }
    this.error = '';
    this.draft = undefined;
    if (num !== this.value) this.emitChange(num);
    else this.requestUpdate();
  };

  private onInput = (event: Event) => {
    event.stopPropagation();
    if (this.disabled) return;
    const el = event.currentTarget as HTMLInputElement;
    const raw = el.value;
    if (this.commitOn === 'blur') {
      this.draft = raw;
      if (this.error) { this.error = ''; this.requestUpdate(); }
      return;
    }
    const trimmed = raw.trim();
    if (trimmed === '') {
      this.dispatchEvent(new CustomEvent('change', { detail: undefined, bubbles: true, composed: true }));
      return;
    }
    const num = Number(trimmed);
    if (Number.isFinite(num)) this.emitChange(num);
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Enter') { event.preventDefault(); this.commit(); return; }
    if (event.key === 'Escape') {
      event.preventDefault();
      this.draft = undefined;
      this.error = '';
      this.requestUpdate();
    }
  };

  updated(changed: PropertyValues): void {
    // An external settings reload or a preset/reset button replaces the stored
    // value; drop a stale draft and its error so the field shows what will
    // actually be written.
    if (changed.has('value') && this.draft !== undefined) {
      this.draft = undefined;
      this.error = '';
      this.requestUpdate();
    }
  }

  render() {
    const bounds = this.bounds;
    const storedProblem = this.spec && Number.isFinite(this.value) && this.draft === undefined
      ? this.validate(this.value) : undefined;
    const shown = this.draft ?? (Number.isFinite(this.value) ? String(this.value) : '');
    return html`
      <span class="shell ${this.unitText ? 'has-unit' : ''}">
        <input
          type="number"
          .value=${shown}
          ?disabled=${this.disabled}
          min=${Number.isFinite(bounds.min) ? String(bounds.min) : nothing}
          max=${Number.isFinite(bounds.max) ? String(bounds.max) : nothing}
          step=${Number.isFinite(this.step) ? String(this.step) : 'any'}
          aria-label=${accessibleLabel(this, this.label)}
          aria-invalid=${this.error ? 'true' : nothing}
          aria-describedby=${this.error ? this.errorId : nothing}
          style=${this.wide ? 'width: 12rem;' : ''}
          @input=${this.onInput}
          @change=${(event: Event) => event.stopPropagation()}
          @blur=${this.commit}
          @keydown=${this.onKeyDown}
        >
        ${this.unitText ? html`<span class="unit" aria-hidden="true">${this.unitText}</span>` : nothing}
      </span>
      ${this.error ? html`<span class="error" role="alert" id=${this.errorId}>${this.error}</span>` : html``}
      ${!this.error && storedProblem ? html`<span class="stored-warning">${storedProblem}</span>` : html``}
    `;
  }
}

// Keys Fluent's slider uses to move the value; their keyup ends a keyboard step.
const SLIDER_VALUE_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']);

/**
 * Fluent paints a tick after every step whenever its `step` attribute is set
 * (slider.styles.js in the pinned 3.1.3 package). Those marks read as a scale
 * only when the band has a few steps; a dense band such as the 16..8192 px
 * render slider (511 steps) turns the track into noise. Fluent has no switch
 * for the marks, so a dense band sets a 200% repeat period: the 1px mark then
 * falls outside the track and the track renders solid.
 */
export const MAX_SLIDER_STEP_MARKERS = 24;

export function sliderStepMarkerStyle(min: number, max: number, step: number): string | undefined {
  if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(step) || step <= 0 || max <= min) return undefined;
  const steps = Math.floor((max - min) / step + 1e-9);
  return steps > MAX_SLIDER_STEP_MARKERS ? '--step-rate: 200%;' : undefined;
}

/**
 * app-slider — forwards Fluent's interaction changes without treating display
 * synchronization or normalization as edits to the stored setting.
 *
 * `change` fires once per step, so a live-preview consumer keeps reacting while
 * the thumb moves. `commit` fires once when the interaction ends (pointer
 * release, pointer cancel, or the keyup that ends a keyboard step) for
 * consumers that must not act on every step, such as the window zoom.
 */
@customElement('app-slider')
export class AppSlider extends LitElement {
  static styles = css`
    ${interactiveStyles}
    :host {
      display: inline-block;
      flex: 1 1 12rem;
      min-width: min(10rem, 100%);
    }
    fluent-slider {
      width: 100%;
      --thumb-size: 18px;
      --track-size: 6px;
      --track-color: var(--colorNeutralStroke1, #d1d1d1);
      --border-radius: 999px;
    }
  `;

  @property({ type: Number }) value = 0;
  @property({ type: Number }) min = 0;
  @property({ type: Number }) max = 100;
  @property({ type: Number }) step = 1;
  @property({ type: Boolean }) disabled = false;

  private synchronizing = false;
  private initialized = false;
  private interacting = false;

  // 2026-10-20: Fluent publishes one change per pointer move and keeps its own
  // release handler inside its shadow root, so the end of the gesture is
  // tracked here: the window pointerup that finishes a drag, or the keyup that
  // finishes a keyboard step. Fluent also ends a drag on document mouseleave
  // (its pointer moves stop once the cursor leaves the window), so that path
  // commits instead of leaving a stale interaction armed.
  private readonly endInteraction = (): void => {
    this.stopInteraction();
    if (this.disabled) return;
    this.dispatchEvent(new CustomEvent('commit', { detail: this.value, bubbles: true, composed: true }));
  };

  private readonly startInteraction = (): void => {
    if (this.disabled || this.interacting) return;
    this.interacting = true;
    window.addEventListener('pointerup', this.endInteraction);
    window.addEventListener('pointercancel', this.endInteraction);
    // A window that loses focus mid-drag still commits what the thumb shows.
    window.addEventListener('blur', this.endInteraction);
    document.addEventListener('mouseleave', this.endInteraction);
  };

  private stopInteraction(): void {
    if (!this.interacting) return;
    this.interacting = false;
    window.removeEventListener('pointerup', this.endInteraction);
    window.removeEventListener('pointercancel', this.endInteraction);
    window.removeEventListener('blur', this.endInteraction);
    document.removeEventListener('mouseleave', this.endInteraction);
  }

  // Keyboard steps end on keyup. The value at the first keydown of a held key
  // tells a real step from a key Fluent ignored (Shift+Arrow) or clamped at a
  // bound, so an unchanged press never re-applies the zoom or rewrites the
  // settings file.
  private keyStart: number | undefined;

  private readonly onValueKeyDown = (event: KeyboardEvent): void => {
    if (this.disabled || this.keyStart !== undefined || !SLIDER_VALUE_KEYS.has(event.key)) return;
    this.keyStart = this.value;
  };

  private readonly onReleaseKey = (event: KeyboardEvent): void => {
    if (!SLIDER_VALUE_KEYS.has(event.key)) return;
    const start = this.keyStart;
    this.keyStart = undefined;
    if (start === undefined || start === this.value) {
      this.stopInteraction();
      return;
    }
    this.endInteraction();
  };

  // 2026-09-25: Fluent 3.1.3 emits change from its value setter, including
  // programmatic writes and min/max/step normalization. Set bounds first and
  // suppress those events, preserving exact saved tuning even if its slider
  // display is rounded or clamped. Initial sync also precedes Fluent's first
  // animation-frame default-value check, which otherwise resets an out-of-
  // range value to the midpoint and silently saves it through the page.
  private syncValue(): void {
    const control = this.renderRoot.querySelector('fluent-slider') as (HTMLElement & {
      min: string; max: string; step: string; value: string;
    }) | null;
    if (!control || !this.isConnected) return;
    this.synchronizing = true;
    try {
      control.min = String(this.min);
      control.max = String(this.max);
      control.step = String(this.step);
      control.value = String(this.value);
      this.initialized = true;
    } finally {
      this.synchronizing = false;
    }
  }

  firstUpdated(): void { this.syncValue(); }

  disconnectedCallback(): void {
    this.stopInteraction();
    super.disconnectedCallback();
  }

  updated(changed: PropertyValues): void {
    if (['value', 'min', 'max', 'step'].some(key => changed.has(key))) this.syncValue();
  }

  private onNativeChange = (event: Event) => {
    event.stopPropagation();
    if (this.disabled || this.synchronizing || !this.initialized) return;
    const el = event.currentTarget as HTMLElement & { value: number };
    if (!Number.isFinite(Number(el.value))) return;
    this.value = Number(el.value);
    this.dispatchEvent(new CustomEvent('change', { detail: this.value, bubbles: true, composed: true }));
  };

  render() {
    return html`<fluent-slider
      style=${sliderStepMarkerStyle(this.min, this.max, this.step) ?? nothing}
      ?disabled=${this.disabled}
      aria-label=${accessibleLabel(this)}
      @pointerdown=${this.startInteraction}
      @keydown=${this.onValueKeyDown}
      @keyup=${this.onReleaseKey}
      @change=${this.onNativeChange}
    ></fluent-slider>`;
  }
}

/**
 * app-section — collapsible section header. UI state only: toggling must
 * never enable, disable, reset, or migrate the settings beneath it.
 */
@customElement('app-section')
export class AppSection extends LitElement {
  static styles = css`
    ${interactiveStyles}
    :host {
      display: block;
    }
    .head {
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
      user-select: none;
      cursor: pointer;
      background: linear-gradient(90deg, transparent, var(--colorNeutralBackground3, rgba(0, 0, 0, 0.06)) 30% 70%, transparent);
      padding: 0.15rem 1rem 0.15rem 0;
    }
    .chevron {
      display: inline-block;
      margin-left: 8px;
      transition: transform 0.15s;
    }
    .chevron.closed {
      transform: rotate(-90deg);
    }
    .level-0 { font-size: 1.15em; margin-top: 0.9rem; }
    .level-1 { margin-left: 1rem; font-size: 1em; opacity: 0.95; }
    .level-2 { margin-left: 2rem; font-size: 0.95em; opacity: 0.9; }
    .level-3 { margin-left: 3rem; font-size: 0.9em; opacity: 0.85; }
  `;

  @property({ type: String }) title = '';
  @property({ type: Boolean }) open = true;
  @property({ type: Number }) level = 1;

  private toggle = () => {
    this.open = !this.open;
    this.dispatchEvent(new CustomEvent('toggle', { detail: this.open, bubbles: true, composed: true }));
  };

  render() {
    const cls = `level-${Math.max(0, Math.min(3, this.level))}`;
    return html`<div class="head ${cls}" role="button" tabindex="0"
      @click=${this.toggle}
      @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.toggle(); } }}
    >
      <span>${this.title}</span>
      <span class="chevron ${this.open ? '' : 'closed'}">▾</span>
    </div>`;
  }
}

/** Click/keyboard help. The shared top-layer renderer escapes every page's
 * scrolling/stacking context, clamps to the viewport and cleans up on unmount. */
@customElement('app-field-tip')
export class AppFieldTip extends LitElement {
  static styles = css`
    ${interactiveStyles}
    :host { display:inline-block; margin-left:0.4rem; vertical-align:middle; }
    .tip { border:none; background:transparent; color:var(--colorBrandForegroundLink,#0067c0);
      cursor:pointer; font-size:1em; padding:0.15rem 0.3rem; }
  `;
  @property({ type: String }) info = '';
  @property({ type: String }) label = '';

  private open = (event: Event): void => {
    const [summary, ...details] = this.info.split('\n\n');
    helpPopover.open(event.currentTarget as HTMLButtonElement, {
      title: this.label || t('Setting help'), summary,
      details: details.join('\n\n') || undefined,
    }, { close: t('Close help'), details: t('Technical details') });
  };

  disconnectedCallback(): void {
    const button = this.shadowRoot?.querySelector<HTMLButtonElement>('button');
    if (button) helpPopover.close(false, button);
    super.disconnectedCallback();
  }

  render() {
    return html`<button class="tip" type="button" aria-label=${this.label ? `${t('About')} ${this.label}` : t('Setting help')}
      aria-haspopup="dialog" aria-expanded="false" @click=${this.open}><span aria-hidden="true">ⓘ</span></button>`;
  }
}

/**
 * app-reset — "reset this field to its authoritative default" affordance.
 * Only rendered when canReset is true, exactly like the old reset-button.
 */
@customElement('app-reset')
export class AppReset extends LitElement {
  static styles = css`
    ${interactiveStyles}
    :host {
      display: inline-block;
      margin-left: auto;
    }
    button {
      border: none;
      background: transparent;
      cursor: pointer;
      font-size: 1.05rem;
      color: var(--colorBrandForegroundLink, #0067c0);
      padding: 0.1rem 0.35rem;
      border-radius: 4px;
    }
    button:hover {
      background: rgba(127, 127, 127, 0.15);
    }
  `;

  @property({ type: Boolean }) canReset = false;

  private onClick = () => {
    this.dispatchEvent(new CustomEvent('resetClick', { bubbles: true, composed: true }));
  };

  render() {
    if (!this.canReset) return html``;
    return html`<button type="button" @click=${this.onClick} title=${t('Reset to default')} aria-label=${t('Reset to default')}>↺</button>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'app-switch': AppSwitch;
    'app-select': AppSelect;
    'app-choice': AppChoice;
    'app-vector': AppVector;
    'app-number': AppNumber;
    'app-slider': AppSlider;
    'app-section': AppSection;
    'app-field-tip': AppFieldTip;
    'app-reset': AppReset;
  }
}
