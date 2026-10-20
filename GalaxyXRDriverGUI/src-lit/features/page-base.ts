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

/**
 * Shared .field grid + color helpers, ported from src/simple-form.scss.
 * Lit pages render in shadow DOM, so this css is included in each page's
 * `static styles` to reach its shadow root (a plain stylesheet cannot pierce
 * it). Section headers and notes span both columns, as before.
 */
export const fieldStyles = css`
  ${interactiveStyles}
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
  .field :is(input, textarea) { user-select: text; }
  .field[data-setting-id]:focus-visible, .field[data-setting-id].revealed { outline: 2px solid var(--colorBrandStroke1); outline-offset: 3px; border-radius: 4px; background: var(--colorNeutralBackground3); }
  .field .title {
    display: flex;
    align-items: center;
    position: relative;
    user-select: none;
    padding-right: 1rem;
    gap: 0.25rem;
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
  .chevron { display: inline-block; width: 1em; flex: 0 0 auto; text-align: center; }
  .chevron.closed { transform: rotate(-90deg); }
  @media (max-width: 700px) {
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
  .section-body > .section-card { margin: 12px 0 8px 12px; border-inline-start-width: 3px;
    border-inline-start-color: var(--colorNeutralStrokeAccessible); }
  .section-body > .section-card > .card-heading .section-title { font-size: 1rem; }
  .section-group { margin: 12px 0 8px; min-width: 0; }
  .section-group-label { margin: 0 0 4px; color: var(--colorNeutralForeground2); font-size: 0.95rem; font-weight: 600; }
  .section-group.source > .section-group-label { color: var(--colorNeutralForeground1); font-size: 1rem; }
  .section-group > .section-card { margin-inline-start: 12px; }
  .section-card .field { grid-template-columns: minmax(12rem, 22rem) minmax(0, 1fr); }
  @media (max-width: 720px) {
    .section-body { padding-inline: 12px; }
    .section-body > .section-card { margin-inline-start: 6px; }
    .section-card .field { grid-template-columns: 1fr; }
    .section-card .field .title::after { display: none; }
    .section-card .field .note { grid-column: 1; }
  }
  .primary-color { color: var(--colorBrandForeground1, #1a73e8); }
  .warn-color { color: var(--colorPaletteDarkOrangeForeground1, #a85000); }
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
      c.sds.systemReady.subscribe(notify),
      c.sds.steamVrConfig.subscribe(notify),
      c.sds.installingDriver.subscribe(notify),
      c.sds.driverInstalled.subscribe(notify),
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
      <span>${title}</span>
      ${opts?.tip ? html`<app-field-tip .info=${opts.tip} .label=${typeof title === 'string' ? title : ''}></app-field-tip>` : html``}
      ${opts?.reset ? html`<app-reset .canReset=${opts.reset.can} @resetClick=${opts.reset.on}></app-reset>` : html``}
    </div>
    <div class="control ${opts?.wide ? 'wide' : ''}">${control}</div>
  </div>`;
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
interface SectionSpec { title: string; depth: number; open: boolean; onToggle?: () => void; key?: string; group?: 'advanced' | 'source'; }
const sectionSpecs = new WeakMap<TemplateResult, SectionSpec>();

/** Top-level container heading. Collapsible like every other section card:
 * its open/closed state lives in the shared section state under a derived
 * key (open by default), wired in by BasePage.sectionCardsFor (2026-09-22). */
export function sectionHeading(title: string, level = 0, id?: string): TemplateResult {
  const result = html`<h2 class="section-title">${title}</h2>`;
  sectionSpecs.set(result, { title, depth: Math.max(0, Math.min(3, level)), open: true, key: `heading:${id ?? title}` });
  return result;
}

export function sectionRow(title: string, open: boolean, level: number, onToggle: () => void): TemplateResult {
  const result = html`<button type="button" aria-expanded=${String(open)} @click=${onToggle}>${title}</button>`;
  sectionSpecs.set(result, { title, open, onToggle, depth: Math.max(0, Math.min(3, level)) });
  return result;
}

/** Inline groups keep row ownership without adding another card or collapse
 * switch. Advanced controls belong beside the settings they extend (2026-10-01). */
export function sectionGroup(title: string, level = 0, kind: 'advanced' | 'source' = 'advanced'): TemplateResult {
  const result = html`<div class="section-group-label">${title}</div>`;
  sectionSpecs.set(result, { title, depth: Math.max(0, Math.min(3, level)), open: true, group: kind });
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
  const renderItem = (item: Card | TemplateResult, cardDepth = 0): TemplateResult => {
    if (!('spec' in item)) return item;
    const { spec, index } = item;
    const label = `settings-section-${index}`;
    const body = `${label}-body`;
    // A plain group does not count toward the two-card limit (2026-10-01).
    // Excess hierarchy keeps its fields and label without another border or
    // collapse switch; the enclosing real cards still control visibility.
    if (spec.group || cardDepth >= 2) {
      return html`<div class="section-group ${spec.group ?? 'source'}" role="group" aria-labelledby=${label}>
        <div class="section-group-label" id=${label}>${spec.title}</div>
        ${item.children.map(child => renderItem(child, cardDepth))}
      </div>`;
    }
    // Heading containers collapse like every other card; their state comes
    // from the shared section record (open by default).
    const key = spec.key;
    const toggle = opts?.onToggle;
    const open = key ? (opts?.sections ? opts.sections[key] ?? true : true) : spec.open;
    const onToggle = key ? (toggle ? () => toggle(key) : undefined) : spec.onToggle;
    return html`<section class="section-card level-${spec.depth}" aria-labelledby=${label}>
      <div class="card-heading" role="heading" aria-level=${String(spec.depth + 2)}>
        ${onToggle ? html`<button type="button" class="section-title collapsible" id=${label}
          aria-expanded=${String(open)} aria-controls=${body} @click=${onToggle}>
          <span class="chevron ${open ? '' : 'closed'}" aria-hidden="true">▾</span>
          <span class="section-label">${spec.title}</span>
        </button>` : html`<div class="section-title" id=${label}><span class="section-label">${spec.title}</span></div>`}
      </div>
      <div class="section-body" id=${body} ?hidden=${!open}>${open ? item.children.map(child => renderItem(child, cardDepth + 1)) : html``}</div>
    </section>`;
  };
  return html`${root.map(item => renderItem(item))}`;
}
