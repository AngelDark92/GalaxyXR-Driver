// Page base + shared field layout for the Lit frontend (2026-09-20 migration).
// Every page subscribes once to the application signals it renders and asks
// Lit to re-render on change — the same coarse change-detection the Angular
// templates had, without per-binding subscriptions. Services live for the
// application (composition root in main.ts); pages only borrow them.
import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import { css } from 'lit';
import type { AppContext } from '../app-context';
import { t } from '../locale/i18n';
import { interactiveStyles } from '../ui/shared-styles';
import { settingPresentation, settingUnavailable } from '../domain/settings-presentation';
import { controlSpec, inertReasons, type ControlContext } from '../domain/control-specs';

/**
 * Shared .field grid + color helpers, ported from src/simple-form.scss.
 * Lit pages render in shadow DOM, so this css is included in each page's
 * `static styles` to reach its shadow root (a plain stylesheet cannot pierce
 * it). Section headers and notes span both columns, as before.
 */
export const fieldStyles = css`
  ${interactiveStyles}
  /* The page is a size container: when the docked navigator opens or closes,
     the page's own width changes and these queries reflow the rows. */
  :host { container-type: inline-size; container-name: page; }
  .field {
    position: relative;
    display: grid;
    flex-shrink: 0;
    grid-template-columns: minmax(13rem, 22rem) minmax(0, 1fr);
    gap: 0 0.5rem; padding: 0.5rem 0;
    min-height: 3rem;
    border-bottom: 1px solid var(--colorNeutralStroke1, rgba(0, 0, 0, 0.15));
  }
  .field:last-child { border-bottom: none; }
  /* 2026-10-16: rows are not selectable - only the control in the second
     column is interactive. user-select:none covers the whole row and the
     focus highlight paints only for keyboard/deep-link focus (:focus-visible),
     so a mouse click on the row neither selects text nor looks "selected". */
  .field { user-select: none; }
  .field :is(input, textarea, select, [contenteditable]) { -webkit-user-select: text; user-select: text; }
  .field[data-setting-id]:focus-visible, .field[data-setting-id].revealed { outline: 2px solid var(--colorBrandStroke1); outline-offset: 3px; border-radius: 4px; background: var(--colorNeutralBackground3); }
  .field .title {
    display: flex;
    align-items: center;
    position: relative;
    user-select: none;
    padding-right: 1rem;
    gap: 0.25rem;
    font-size: 0.9rem;
    line-height: 1.25;
  }
  .field .title .changed-dot {
    width: 6px; height: 6px; flex: 0 0 6px; border-radius: 50%;
    background: var(--colorBrandBackground, #0f6cbd);
  }
  .inert-note {
    flex: 1 0 100%; width: 100%;
    color: var(--colorPaletteDarkOrangeForeground1, #a85000);
    font-size: 0.8rem; line-height: 1.35;
  }
  .field .title::after {
    content: '';
    top: 10%;
    height: 80%;
    border-right: 1px solid var(--colorNeutralStroke1, rgba(0, 0, 0, 0.15));
    position: absolute;
    right: 0.5rem;
  }
  .field .section-title {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    text-align: start;
    font-weight: 700;
    grid-column: span 2;
    position: relative;
    user-select: none;
    background: linear-gradient(90deg, transparent, var(--colorNeutralBackground3, rgba(0, 0, 0, 0.06)) 30% 70%, transparent);
    padding-right: 1rem;
  }
  .section-field { border-bottom: 0; padding: 0; margin: 1.25rem 0 0.5rem; min-height: 0; }
  .field .section-title {
    margin: 0; min-height: 44px; gap: 10px; padding: 10px 14px;
    width: 100%; border: 1px solid var(--colorNeutralStroke2, #d1d1d1);
    border-inline-start: 4px solid var(--colorBrandStroke1, #0f6cbd);
    border-radius: 6px; background: var(--colorNeutralBackground3, #f5f5f5);
    color: var(--colorNeutralForeground1, #242424); font-size: 1.08rem;
  }
  .section-field.level-1 { margin-inline-start: 20px; margin-top: 0.75rem; }
  .section-field.level-2 { margin-inline-start: 40px; margin-top: 0.65rem; }
  .section-field.level-3 { margin-inline-start: 60px; margin-top: 0.6rem; }
  .field.level-1 .section-title, .field.level-2 .section-title, .field.level-3 .section-title {
    font-size: 1rem; border-inline-start-width: 3px;
    border-inline-start-color: var(--colorNeutralStrokeAccessible, #616161);
    background: var(--colorNeutralBackground2, #fafafa);
  }
  .field .section-title.collapsible { cursor: pointer; }
  .section-label { flex: 1; }
  .mode-notice { padding: 12px 16px; margin: 12px 0; border-inline-start: 4px solid var(--colorBrandStroke1, #0f6cbd); background: var(--colorNeutralBackground3, #f5f5f5); }
  .mode-error { color: var(--colorPaletteRedForeground1, #b00020); }
  .field .note { grid-column: span 2; padding: 0.5rem 1rem; font-size: 95%; opacity: 0.85; }
  .field .note p { margin: 0.5rem; }
  .field .value { width: 10%; }
  .field .control { min-width: 0; display: flex; align-items: center; flex: 1 1 auto; gap: 0.5rem; flex-wrap: wrap; }
  .field .control .wide { flex: 1 1 auto; min-width: 0; }
  .field .control > * { max-width: 100%; }
  .chevron { display: inline-block; width: 1em; flex: 0 0 auto; text-align: center; transition: transform 150ms ease; }
  .chevron.closed { transform: rotate(-90deg); }
  .section-card { animation: card-in 180ms cubic-bezier(0.2, 0, 0, 1) both; }
  @keyframes card-in { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: none; } }
  @container page (max-width: 700px) {
    .field { grid-template-columns: minmax(0, 1fr); gap: 8px; }
    .field .title::after { display: none; }
    .field .section-title, .field .note { grid-column: 1; }
  }
  .section-card { margin: 1rem 0; border: 1px solid var(--colorNeutralStroke2);
    border-inline-start: 4px solid var(--colorBrandStroke1); border-radius: 8px;
    background: var(--colorNeutralBackground1); min-width: 0; }
  .section-card > .card-heading .section-title { display: flex; align-items: center; gap: 10px;
    width: 100%; min-height: 46px; margin: 0; padding: 12px 16px; border: 0; border-radius: 4px;
    background: var(--colorNeutralBackground3); color: var(--colorNeutralForeground1);
    text-align: start; justify-content: flex-start; font-size: 1.05rem; font-weight: 700; }
  .section-card > .card-heading .collapsible:hover { background: var(--colorNeutralBackground1Hover); }
  .section-card > .card-heading .collapsible:focus-visible { outline: 2px solid var(--colorBrandStroke1); outline-offset: -3px; }
  .section-body { padding: 4px 16px 12px 22px; min-width: 0; }
  .section-body[hidden] { display: none; }
  /* 2026-10-30: only depth-0 sections are collapsible cards. Every nested
     section is a group: a banded heading with a brand rule and dot, not a
     button and not a row. Depth indentation carries the book hierarchy. */
  .section-group { margin: 16px 0 6px; min-width: 0; }
  .section-group.level-1 { margin-inline-start: 10px; }
  .section-group.level-2 { margin-inline-start: 22px; }
  .section-group.level-3 { margin-inline-start: 34px; }
  .section-group-label {
    display: flex; align-items: center; gap: 8px;
    margin: 0; padding: 6px 10px;
    border-inline-start: 3px solid var(--colorBrandStroke1, #0f6cbd);
    border-radius: 0 6px 6px 0;
    background: linear-gradient(90deg,
      var(--colorNeutralBackground3, #f5f5f5) 0,
      transparent 88%);
    color: var(--colorNeutralForeground1, #242424);
    font-size: 0.96rem; font-weight: 700;
    letter-spacing: 0.06em; line-height: 1.25; text-transform: uppercase;
    user-select: none;
  }
  .section-group-label::before {
    content: ''; width: 5px; height: 5px; flex: 0 0 5px; border-radius: 50%;
    background: var(--colorBrandBackground, #0f6cbd);
  }
  .section-group.source > .section-group-label {
    border-inline-start-color: var(--colorNeutralStrokeAccessible, #616161);
  }
  .section-group.source > .section-group-label::before { background: var(--colorNeutralForeground3, #616161); }
  /* 2026-10-30: a group inside another group is a subhead, not a second
     band. The outer band carries the section; the inner one gets a tree
     guide and a larger uppercase label without a filled header. */
  .section-group.nested {
    margin-top: 10px;
    padding-inline-start: 12px;
    border-inline-start: 1px solid var(--colorNeutralStroke2, #d1d1d1);
  }
  .section-group.nested > .section-group-label {
    margin-top: 0;
    padding: 7px 0 5px;
    border-inline-start: 0;
    border-radius: 0;
    background: none;
    color: var(--colorNeutralForeground1, #242424);
    font-size: 0.92rem;
    font-weight: 600;
    letter-spacing: 0.09em;
    line-height: 1.25;
  }
  .section-group.nested > .section-group-label::before {
    width: 4px; height: 4px; flex-basis: 4px;
    background: var(--colorNeutralForeground3, #616161);
  }
  .section-group.nested > .section-group-label::after {
    content: ''; flex: 1; height: 1px; margin-inline-start: 2px;
    background: var(--colorNeutralStroke2, #d1d1d1);
  }
  .section-group:focus-visible, .section-card:focus-visible {
    outline: 2px solid var(--colorBrandStroke1, #0f6cbd); outline-offset: 2px;
  }
  .section-group.revealed, .section-card.revealed {
    outline: 2px solid var(--colorBrandStroke1, #0f6cbd); outline-offset: 2px;
  }
  .section-group > .field:first-of-type { border-top: 0; }
  .section-card .field { grid-template-columns: minmax(12rem, 22rem) minmax(0, 1fr); }
  @container page (max-width: 720px) {
    .section-body { padding-inline: 12px; }
    .section-body > .section-card { margin-inline-start: 6px; }
    .section-card .field { grid-template-columns: 1fr; }
    .section-card .field .title::after { display: none; }
    .section-card .field .note { grid-column: 1; }
  }
  .primary-color { color: var(--colorBrandForeground1, #1a73e8); }
  .warn-color { color: var(--colorPaletteDarkOrangeForeground1, #a85000); }
  .section-card, .section-group { scroll-margin-top: 12px; }
`;

export class BasePage extends LitElement {
  // NOTE: subclasses declare `static styles = [fieldStyles, ...]`. BasePage
  // itself keeps LitElement's `styles` type (CSSResult | CSSResult[]) so the
  // array form in every page is accepted.
  @property({ attribute: false }) ctx!: AppContext;

  private _unsubs: Array<() => void> = [];
  private _hiddenUpdate = false;
  private readonly _onVisibility = () => {
    if (document.visibilityState !== 'hidden' && this._hiddenUpdate) {
      this._hiddenUpdate = false;
      this.requestUpdate();
    }
  };
  /** Temporary inspection visibility. Never saved as the Advanced Mode setting. */
  protected revealAdvanced = false;

  clearSettingTarget(): void {
    if (this.revealAdvanced) { this.revealAdvanced = false; this.requestUpdate(); }
  }

  async showSetting(id: string): Promise<string | undefined> {
    const setting = settingPresentation(id);
    if (!setting) return 'This setting is not available in this version.';
    const unavailable = settingUnavailable(setting, {
      settings: this.ctx.dss.values(), app: this.ctx.appSetting.readFileError() ? undefined : this.ctx.appSetting.values(),
      driverInstalled: !!this.ctx.sds.driverInstalled(), vendor: !!this.ctx.galaxy.vendor,
    });
    if (unavailable) return unavailable;
    this.revealAdvanced = setting.advanced;
    const sections = { ...this.ctx.galaxy.sections() } as Record<string, boolean>;
    for (const key of setting.sections) sections[key] = true;
    this.ctx.galaxy.sections.set(sections as unknown as ReturnType<typeof this.ctx.galaxy.sections>);
    this.requestUpdate();
    await this.updateComplete;
    if (!this.isConnected) return undefined;
    const field = this.shadowRoot?.getElementById(`setting-${id}`);
    if (!field) return 'This control is hidden by the current mode. No settings were changed.';
    field.focus({ preventScroll: true });
    field.scrollIntoView({ block: 'center', behavior: 'auto' });
    // script focus after a mouse-initiated deep link does not match
    // :focus-visible in Chromium - paint the ring explicitly and clear
    // it on blur so it behaves like the old :focus highlight
    field.classList.add('revealed');
    field.addEventListener('blur', () => field.classList.remove('revealed'), { once: true });
    return undefined;
  }

  connectedCallback(): void {
    super.connectedCallback();
    // 2026-10-20: tray-hidden pages retain state, but need no Lit redraws.
    // Refresh once on return, including updates received while hidden.
    const notify = () => {
      if (document.visibilityState === 'hidden') this._hiddenUpdate = true;
      else this.requestUpdate();
    };
    const c = this.ctx;
    if (!c) return;
    document.addEventListener('visibilitychange', this._onVisibility);
    this._unsubs.push(
      c.dss.values.subscribe(notify),
      c.dss.readFileError.subscribe(notify),
      c.appSetting.readFileError.subscribe(notify),
      c.dss.writeFileError.subscribe(notify),
      c.appSetting.writeFileError.subscribe(notify),
      c.sds.driverState.subscribe(notify),
      c.sds.driverCheckError.subscribe(notify),
      c.sds.steamVRsettingsError.subscribe(notify),
      c.checks.checking.subscribe(notify),
      c.checks.report.subscribe(notify),
      c.dis.values.subscribe(notify),
      c.appSetting.values.subscribe(notify),
      c.lifecycle.changing.subscribe(notify),
      c.windowsStartup.status.subscribe(notify),
      c.windowsStartup.error.subscribe(notify),
      c.windowsStartup.changing.subscribe(notify),
      c.sds.systemReady.subscribe(notify),
      c.sds.steamVrConfig.subscribe(notify),
      c.sds.installingDriver.subscribe(notify),
      c.sds.driverInstalled.subscribe(notify),
      c.sds.driverRegisteredPath.subscribe(notify),
      c.sds.defaultDriverRoot.subscribe(notify),
      c.sds.steamVRinstalled.subscribe(notify),
      c.sds.driverVersionMismatch.subscribe(notify),
      c.aus.updateInfo.subscribe(notify),
      c.galaxy.revision.subscribe(notify),
      c.galaxy.imageModeChanging.subscribe(notify),
      c.galaxy.imageModeError.subscribe(notify),
      c.galaxy.sections.subscribe(notify),
      c.galaxy.matrixText.subscribe(notify),
      c.galaxy.matrixError.subscribe(notify),
      c.galaxy.shareText.subscribe(notify),
      c.galaxy.shareStatus.subscribe(notify),
    );
  }

  disconnectedCallback(): void {
    document.removeEventListener('visibilitychange', this._onVisibility);
    this._hiddenUpdate = false;
    for (const unsub of this._unsubs) unsub();
    this._unsubs = [];
    super.disconnectedCallback();
  }

  protected section(name: string): boolean {
    const sections = this.ctx.galaxy.sections() as Record<string, boolean>;
    return !!sections[name];
  }

  protected toggleSection(name: string, defaultOpen = false): void {
    const current = this.ctx.galaxy.sections();
    const next = { ...(current as unknown as Record<string, boolean>) };
    next[name] = !(next[name] ?? defaultOpen);
    this.ctx.galaxy.sections.set(next as unknown as typeof current);
  }

  protected jumpToSection(anchorId: string): void {
    const target = this.shadowRoot?.getElementById(`section-${anchorId}`);
    if (!target) return;
    const reduce = typeof window !== 'undefined'
      && (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
    target.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
  }

  /**
   * Reveal a section from the chapter Contents card. Nested groups no longer
   * collapse, so `openKeys` only needs the enclosing depth-0 cards. The card
   * and group renderer assigns tabindex=-1 to anchored targets; focus moves
   * there so keyboard and screen-reader users land on the requested section.
   */
  async revealSection(anchorId: string, openKeys: readonly string[] = []): Promise<void> {
    if (openKeys.length) {
      const current = { ...(this.ctx.galaxy.sections() as unknown as Record<string, boolean>) };
      let changed = false;
      for (const key of openKeys) {
        if (!current[key]) { current[key] = true; changed = true; }
      }
      if (changed) {
        this.ctx.galaxy.sections.set(current as unknown as ReturnType<typeof this.ctx.galaxy.sections>);
        await this.updateComplete;
      }
    }
    const target = this.shadowRoot?.getElementById(`section-${anchorId}`);
    if (!target) return;
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
    // Programmatic focus after a pointer click does not match :focus-visible
    // in Chromium; paint the ring explicitly and clear it on blur.
    target.classList.add('revealed');
    target.addEventListener('blur', () => target.classList.remove('revealed'), { once: true });
    this.jumpToSection(anchorId);
  }

  /** Card renderer for page bodies. Heading containers resolve their
   * open/closed state through the shared section state, so every container
   * in the app collapses like the other section cards (2026-09-22). */
  protected sectionCardsFor(rows: readonly TemplateResult[]): TemplateResult {
    return sectionCards(rows, {
      sections: this.ctx.galaxy.sections() as Record<string, boolean>,
      // Match the renderer's open default for headings with no saved state;
      // otherwise their first click leaves them open (2026-09-23).
      onToggle: (key: string) => this.toggleSection(key, true),
    });
  }
}

export interface FieldReset {
  can: boolean;
  on: () => void;
}

/**
 * One settings row, matching the old .field grid (22rem title | control).
 * Section headers and notes span both columns, as before.
 */
export function fieldRow(
  title: string | TemplateResult,
  control: TemplateResult,
  opts?: { tip?: string; reset?: FieldReset; wide?: boolean; settingId?: string }
): TemplateResult {
  return html`<div class="field" id=${opts?.settingId ? `setting-${opts.settingId}` : nothing}
    data-setting-id=${opts?.settingId ?? nothing} tabindex=${opts?.settingId ? '-1' : nothing}>
    <div class="title">
      ${opts?.reset?.can ? html`<i class="changed-dot" aria-hidden="true"></i>` : nothing}
      <span>${title}</span>
      ${opts?.tip ? html`<app-field-tip .info=${opts.tip} .label=${typeof title === 'string' ? title : ''}></app-field-tip>` : html``}
      ${opts?.reset ? html`<app-reset .canReset=${opts.reset.can} @resetClick=${opts.reset.on}></app-reset>` : html``}
    </div>
    <div class="control ${opts?.wide ? 'wide' : ''}">${control}</div>
  </div>`;
}

export interface NumberControlOptions {
  value: number;
  ctx: ControlContext;
  disabled?: boolean;
  /** Explicit accessible name; required when a row has several numeric fields. */
  label?: string;
  wide?: boolean;
  onCommit?: (value: number) => void;
  onInvalid?: (message: string) => void;
}

/**
 * Spec-driven numeric field. The bounds, unit, integer rule and sentinel labels
 * come from `domain/control-specs.ts`; pages must not pass their own range.
 * Validates on blur/Enter and refuses an out-of-contract edit (the control
 * shows the reason); a stored value outside the spec is displayed and flagged,
 * never rewritten.
 */
export function numberControl(key: string, opts: NumberControlOptions): TemplateResult {
  const spec = controlSpec(key);
  if (!spec || spec.kind !== 'number') throw new Error(`Unknown numeric control spec: ${key}`);
  const inert = inertReasons(spec, opts.ctx);
  return html`<app-number .spec=${spec} .ctx=${opts.ctx} .value=${opts.value}
    .label=${opts.label ?? ''} .disabled=${!!opts.disabled} .wide=${!!opts.wide}
    .commitOn=${'blur'}
    @change=${(event: CustomEvent<number>) => { if (Number.isFinite(event.detail)) opts.onCommit?.(event.detail); }}
    @invalid=${(event: CustomEvent<{ message: string }>) => opts.onInvalid?.(event.detail.message)}></app-number>${inert.length
      ? html`<span class="inert-note">${inert.map(reason => t(reason)).join(' ')}</span>` : nothing}`;
}

export interface ChoiceControlOptions {
  value: string | number;
  ctx: ControlContext;
  disabled?: boolean;
  label?: string;
  onCommit: (value: string | number) => void;
}

/**
 * Spec-driven finite set. A stored value that is not in the list is appended as
 * an explicit "Stored: X (unsupported)" option, so the control shows the truth
 * instead of selecting a different value.
 */
export function choiceControl(key: string, opts: ChoiceControlOptions): TemplateResult {
  const spec = controlSpec(key);
  if (!spec || spec.kind !== 'choice') throw new Error(`Unknown choice control spec: ${key}`);
  const options = spec.options.map(option => ({ value: option.value, label: t(option.label) }));
  if (!options.some(option => String(option.value) === String(opts.value))) {
    options.push({
      value: opts.value,
      label: t('Stored: {value} (unsupported)', { value: String(opts.value) }),
    });
  }
  const onChange = (event: CustomEvent<string | number>) => opts.onCommit(event.detail);
  const control = spec.segmented
    ? html`<app-choice .value=${opts.value} .options=${options} .label=${opts.label ?? ''}
        .disabled=${!!opts.disabled} @change=${onChange}></app-choice>`
    : html`<app-select .value=${String(opts.value)} .options=${options} .label=${opts.label ?? ''}
        .disabled=${!!opts.disabled} @change=${onChange}></app-select>`;
  const inert = inertReasons(spec, opts.ctx);
  return html`${control}${inert.length ? html`<span class="inert-note">${inert.map(reason => t(reason)).join(' ')}</span>` : nothing}`;
}

export interface SliderControlOptions {
  value: number;
  disabled?: boolean;
  onChange: (value: number) => void;
  onCommit?: (value: number) => void;
}

/** Companion slider for rows whose spec declares a guidance band. Renders
 *  nothing when the spec has none, so adding a slider stays a spec decision.
 *  The row's numberControl owns the "saved, not applied" note, so the slider
 *  does not repeat it. */
export function sliderControl(key: string, opts: SliderControlOptions): TemplateResult {
  const spec = controlSpec(key);
  if (!spec || spec.kind !== 'number' || !spec.slider) return html``;
  const band = spec.slider;
  return html`<app-slider .value=${opts.value} .min=${band.min} .max=${band.max} .step=${band.step}
    .disabled=${!!opts.disabled}
    @change=${(event: CustomEvent<number>) => opts.onChange(event.detail)}
    @commit=${(event: CustomEvent<number>) => opts.onCommit?.(event.detail)}></app-slider>`;
}

export interface VectorControlOptions {
  keys: readonly [string, string, string];
  values: readonly [number, number, number];
  /** Visible axis captions, e.g. ['X','Y','Z']. */
  labels: readonly [string, string, string];
  /** Accessible base name; the axis caption is appended. */
  baseLabel: string;
  ctx: ControlContext;
  disabled?: boolean;
  onCommit: (key: string, value: number) => void;
}

/** Three-axis numeric row rendered as labelled cells. Spec lookup stays here,
 *  so a vector cannot be added without declaring all three keys. */
export function vectorControl(opts: VectorControlOptions): TemplateResult {
  const axes = opts.keys.map((key, index) => {
    const spec = controlSpec(key);
    if (!spec || spec.kind !== 'number') throw new Error(`Unknown numeric control spec: ${key}`);
    return {
      key, label: opts.labels[index], ariaLabel: `${opts.baseLabel} ${opts.labels[index]}`,
      value: opts.values[index], spec, disabled: !!opts.disabled,
    };
  });
  return html`<app-vector .axes=${axes} .ctx=${opts.ctx}
    @axis-change=${(event: CustomEvent<{ key: string; value: number }>) => opts.onCommit(event.detail.key, event.detail.value)}></app-vector>`;
}

/** One catalog label is used by the rendered control and its check result. */
export function settingFieldRow(id: string, control: TemplateResult,
  opts?: { tip?: string; reset?: FieldReset; wide?: boolean }): TemplateResult {
  const setting = settingPresentation(id);
  if (!setting) throw new Error(`Unknown setting presentation: ${id}`);
  return fieldRow(t(setting.label), control, { ...opts, settingId: id });
}

export function noteRow(text: string | TemplateResult): TemplateResult {
  return html`<div class="field"><div class="note">${text}</div></div>`;
}

/** Section metadata stays with its template: no querying/transplanting DOM nodes,
 * no innerHTML, and no lifecycle changes to nested controls. */
interface SectionSpec { title: string; depth: number; open: boolean; onToggle?: () => void; key?: string; group?: 'group' | 'source'; anchorId?: string; }
const sectionSpecs = new WeakMap<TemplateResult, SectionSpec>();

/** Top-level container heading. Collapsible like every other section card:
 * its open/closed state lives in the shared section state under a derived
 * key (open by default), wired in by BasePage.sectionCardsFor (2026-09-22). */
export function sectionHeading(title: string, level = 0, id?: string): TemplateResult {
  const result = html`<h2 class="section-title">${title}</h2>`;
  sectionSpecs.set(result, { title, depth: Math.max(0, Math.min(3, level)), open: true, key: `heading:${id ?? title}`, anchorId: id });
  return result;
}

export function sectionRow(title: string, open: boolean, level: number, onToggle: () => void, anchorId?: string): TemplateResult {
  const result = html`<button type="button" aria-expanded=${String(open)} @click=${onToggle}>${title}</button>`;
  sectionSpecs.set(result, { title, open, onToggle, depth: Math.max(0, Math.min(3, level)), anchorId });
  return result;
}

/** Non-collapsible nested section heading (2026-10-30). Depth-1+ sections are
 * always groups: no chevron, no collapse state, a banded heading instead. */
export function sectionGroup(title: string, level = 0, kind: 'group' | 'source' = 'group', anchorId?: string): TemplateResult {
  const result = html`<div class="section-group-label">${title}</div>`;
  sectionSpecs.set(result, { title, depth: Math.max(0, Math.min(3, level)), open: true, group: kind, anchorId });
  return result;
}

/** Turn the existing ordered rows into nested cards. A heading owns all rows up
 * to the next heading at the same or a shallower depth. Conditional controls
 * remain controlled by their original feature code. Collapsing does not save
 * settings, and reopening uses the same shared state as before. */
export interface SectionCardsOptions {
  /** Shared section state (GalaxySettingsBase.sections()) backing the
   * collapsible heading containers. */
  sections?: Record<string, boolean>;
  /** Flip a heading's key in the shared section state. */
  onToggle?: (key: string) => void;
}

export function sectionCards(rows: readonly TemplateResult[], opts?: SectionCardsOptions): TemplateResult {
  interface Card { spec: SectionSpec; index: number; children: Array<Card | TemplateResult>; }
  const root: Array<Card | TemplateResult> = [];
  const stack: Card[] = [];
  rows.forEach((row, index) => {
    const spec = sectionSpecs.get(row);
    if (spec) {
      while (stack.length && stack[stack.length - 1].spec.depth >= spec.depth) stack.pop();
      const card: Card = { spec, index, children: [] };
      (stack.length ? stack[stack.length - 1].children : root).push(card);
      stack.push(card);
    } else (stack.length ? stack[stack.length - 1].children : root).push(row);
  });
  const renderItem = (item: Card | TemplateResult, cardDepth = 0, insideGroup = false): TemplateResult => {
    if (!('spec' in item)) return item;
    const { spec, index } = item;
    const label = `settings-section-${index}`;
    const body = `${label}-body`;
    // 2026-10-30: only depth-0 sections collapse. A nested section is a group
    // even if its template still came from sectionRow/sectionHeading, so a
    // collapsible card can never appear inside another collapsible card.
    const isGroup = !!spec.group || cardDepth >= 1 || spec.depth >= 1;
    if (isGroup) {
      const kind = spec.group ?? 'group';
      return html`<div class="section-group level-${spec.depth} ${kind} ${insideGroup ? 'nested' : ''}"
        role="group" aria-labelledby=${label}
        id=${spec.anchorId ? `section-${spec.anchorId}` : nothing}
        tabindex=${spec.anchorId ? '-1' : nothing}>
        <div class="section-group-label" id=${label} role="heading" aria-level=${String(spec.depth + 2)}>${spec.title}</div>
        ${item.children.map(child => renderItem(child, cardDepth, true))}
      </div>`;
    }
    // Heading containers collapse like every other card; their state comes
    // from the shared section record (open by default).
    const key = spec.key;
    const toggle = opts?.onToggle;
    const open = key ? (opts?.sections ? opts.sections[key] ?? true : true) : spec.open;
    const onToggle = key ? (toggle ? () => toggle(key) : undefined) : spec.onToggle;
    return html`<section class="section-card level-${spec.depth}" aria-labelledby=${label}
      id=${spec.anchorId ? `section-${spec.anchorId}` : nothing}
      tabindex=${spec.anchorId ? '-1' : nothing}>
      <div class="card-heading" role="heading" aria-level=${String(spec.depth + 2)}>
        ${onToggle ? html`<button type="button" class="section-title collapsible" id=${label}
          aria-expanded=${String(open)} aria-controls=${body} @click=${onToggle}>
          <span class="chevron ${open ? '' : 'closed'}" aria-hidden="true">▾</span>
          <span class="section-label">${spec.title}</span>
        </button>` : html`<div class="section-title" id=${label}><span class="section-label">${spec.title}</span></div>`}
      </div>
      <div class="section-body" id=${body} ?hidden=${!open}>${open ? item.children.map(child => renderItem(child, cardDepth + 1, false)) : html``}</div>
    </section>`;
  };
  return html`${root.map(item => renderItem(item))}`;
}
