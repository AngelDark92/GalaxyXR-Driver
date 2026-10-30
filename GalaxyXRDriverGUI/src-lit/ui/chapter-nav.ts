// Docked navigator (2026-10-30).
//
// The primary rail is part of the layout and opens by default; only the spine
// toggle or the rail's Close button changes that. The page column flexes as
// the rail collapses/expands, so the navigator never covers the page.
//
// The secondary section tree is an inline disclosure under the selected page:
// it opens only from the arrow at the right of that page's row, never on hover
// or on a normal page click. It closes on route change, on leaving the
// navigator, on Escape, on section selection, or when the rail closes.
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { t } from '../locale/i18n';
import { sectionHref, type Route } from '../domain/navigation';
import { findOutlineItem, type ChapterView, type OutlineItem } from '../domain/page-outline';

@customElement('app-chapter-nav')
export class ChapterNav extends LitElement {
  static styles = css`
    :host {
      --spine-width: 36px;
      --rail-width: 210px;
      --nav-open-width: calc(var(--spine-width) + var(--rail-width));
      display: block;
      box-sizing: border-box;
      width: var(--spine-width);
      height: 100%;
      overflow: hidden;
      background: var(--colorNeutralBackground1);
      border-inline-end: 1px solid var(--colorNeutralStroke2);
      color: var(--colorNeutralForeground1);
      transition: width 170ms cubic-bezier(0.2, 0, 0, 1);
    }
    :host([open]) { width: var(--nav-open-width); }

    .frame {
      display: flex;
      flex-direction: row;
      width: var(--nav-open-width);
      height: 100%;
      overflow: hidden;
    }

    .spine {
      flex: 0 0 var(--spine-width);
      width: var(--spine-width);
      height: 100%;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
      padding: 10px 0;
      background: var(--colorNeutralBackground2);
      border-inline-end: 1px solid var(--colorNeutralStroke2);
    }
    .brand { width: 28px; height: 28px; object-fit: contain; flex: 0 0 auto; }
    .spine-toggle {
      flex: 1;
      width: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
      padding: 0;
      border: 0;
      background: transparent;
      color: var(--colorNeutralForeground2);
      cursor: pointer;
      font: inherit;
    }
    .spine-toggle:hover { color: var(--colorNeutralForeground1); }
    .spine-toggle:focus-visible { outline: 2px solid var(--colorBrandStroke1); outline-offset: -3px; }
    .vertical-label {
      writing-mode: vertical-rl;
      transform: rotate(180deg);
      font-size: 0.68rem;
      font-weight: 700;
      letter-spacing: 0.18em;
      text-transform: uppercase;
    }
    .spine-chevron { font-size: 1.05rem; line-height: 1; transition: transform 160ms ease; }
    .spine-chevron.open { transform: rotate(180deg); }

    .rail {
      flex: 0 0 var(--rail-width);
      width: var(--rail-width);
      height: 100%;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      padding: 10px 8px 12px;
      background: var(--colorNeutralBackground1);
      border-inline-end: 1px solid var(--colorNeutralStroke2);
      overflow: hidden;
    }
    .rail-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 2px 6px 8px;
      color: var(--colorNeutralForeground3);
      font-size: 0.66rem;
      font-weight: 700;
      letter-spacing: 0.14em;
      text-transform: uppercase;
    }
    .rail-close {
      width: 22px; height: 22px;
      display: inline-flex; align-items: center; justify-content: center;
      border: 0; border-radius: 4px; padding: 0;
      background: transparent; color: inherit;
      font: inherit; font-size: 1rem; line-height: 1; cursor: pointer;
    }
    .rail-close:hover { background: var(--colorNeutralBackground1Hover); color: var(--colorNeutralForeground1); }
    .rail-close:focus-visible { outline: 2px solid var(--colorBrandStroke1); outline-offset: 0; }

    .rail-list {
      position: relative;
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding-left: 6px;
    }
    .chapter-row {
      position: relative;
      display: flex;
      align-items: stretch;
      border-radius: 6px;
      margin: 1px 0;
    }
    .chapter-row:hover { background: var(--colorNeutralBackground1Hover); }
    .chapter-row.active {
      background: var(--colorNeutralBackground3);
      color: var(--colorBrandForeground1);
      font-weight: 600;
    }
    .chapter-row.active::before {
      content: '';
      position: absolute;
      left: 0; top: 7px; bottom: 7px;
      width: 3px; border-radius: 2px;
      background: var(--colorBrandBackground);
    }
    .chapter-link {
      position: relative;
      flex: 1;
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 6px;
      min-height: 42px;
      box-sizing: border-box;
      padding: 7px 34px 7px 16px;
      border-radius: 6px;
      color: inherit;
      text-decoration: none;
      font-size: 0.84rem;
      line-height: 1.2;
    }
    .chapter-link::after {
      content: '';
      position: absolute;
      left: 4px; top: 50%;
      width: 5px; height: 5px;
      border-radius: 50%;
      background: var(--colorNeutralStroke1);
      transform: translateY(-50%);
    }
    .chapter-row.active .chapter-link::after { background: var(--colorBrandBackground); }
    .chapter-link:focus-visible { outline: 2px solid var(--colorBrandStroke1); outline-offset: -2px; }
    .chapter-label { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    .chapter-disclosure {
      position: absolute;
      top: 50%;
      right: 4px;
      width: 24px;
      height: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      transform: translateY(-50%);
      border: 0;
      border-radius: 4px;
      padding: 0;
      background: transparent;
      color: var(--colorNeutralForeground3);
      font: inherit;
      cursor: pointer;
      z-index: 1;
    }
    .chapter-row.active .chapter-disclosure { color: var(--colorBrandForeground1); }
    .chapter-disclosure:hover { color: var(--colorNeutralForeground1); }
    .chapter-disclosure:focus-visible { outline: 2px solid var(--colorBrandStroke1); outline-offset: -2px; }
    .chapter-disclosure[disabled] { cursor: default; opacity: 0.4; }
    .chapter-disclosure span { display: inline-block; transition: transform 150ms ease; }
    .chapter-disclosure.expanded span { transform: rotate(90deg); }
    .badge {
      flex: 0 0 6px;
      width: 6px; height: 6px;
      border-radius: 50%;
      background: var(--colorBrandBackground);
    }

    .submenu {
      margin: 4px 0 8px 6px;
      padding: 8px;
      background: var(--colorNeutralBackground2, #fafafa);
      border: 1px solid var(--colorNeutralStroke2);
      border-radius: 6px;
    }
    .submenu[hidden] { display: none; }
    .submenu-label {
      padding: 1px 5px 7px;
      color: var(--colorNeutralForeground2);
      font-size: 0.72rem;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      user-select: none;
    }
    .outline {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .outline .outline {
      margin: 2px 0 2px 6px;
      padding-left: 10px;
      border-inline-start: 1px solid var(--colorNeutralStroke2);
    }
    .outline-link {
      display: block;
      padding: 6px 7px;
      border-radius: 4px;
      color: var(--colorNeutralForeground2);
      text-decoration: none;
      font-size: 0.84rem;
      font-weight: 500;
      line-height: 1.3;
      overflow-wrap: anywhere;
    }
    .outline > li > .outline-link {
      color: var(--colorNeutralForeground1);
      font-weight: 600;
    }
    .outline-link.group,
    .outline > li > .outline-link.group,
    .outline .outline .outline-link.group {
      color: var(--colorNeutralForeground1);
      font-weight: 700;
      font-size: 0.86rem;
    }
    .outline .outline .outline-link { font-size: 0.84rem; }
    .outline-link:hover { background: var(--colorNeutralBackground1Hover); }
    .outline-link:focus-visible { outline: 2px solid var(--colorBrandStroke1); outline-offset: -2px; }
    .outline-link.active-path { color: var(--colorNeutralForeground1); font-weight: 600; }
    .outline-link.group.active-path { font-weight: 700; }
    .outline-link.active {
      padding-left: 9px;
      color: var(--colorBrandForeground1);
      background: var(--colorNeutralBackground3);
      box-shadow: inset 2px 0 0 var(--colorBrandStroke1);
      font-weight: 600;
    }
    .outline-link.group.active { font-weight: 700; }
    .empty {
      margin: 4px 7px;
      color: var(--colorNeutralForeground3);
      font-size: 0.84rem;
      line-height: 1.35;
    }

    .sr-only {
      position: absolute;
      width: 1px; height: 1px;
      padding: 0; margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }

    @media (prefers-reduced-motion: reduce) {
      :host, .spine-chevron, .chapter-disclosure span { transition: none; }
    }
  `;

  @property({ attribute: false }) chapters: readonly ChapterView[] = [];
  @property({ type: String }) activeRoute = '';
  @property({ type: String }) activeSection = '';
  @property({ type: Boolean }) busy = false;
  @property({ type: Boolean, reflect: true }) open = true;

  private expandedRoute?: Route;

  private readonly toggleOpen = (): void => {
    const next = !this.open;
    this.open = next;
    if (!next) this.expandedRoute = undefined;
    this.requestUpdate();
    if (next) {
      void this.updateComplete.then(() => {
        this.renderRoot.querySelector<HTMLAnchorElement>(`#page-${this.activeRoute}`)
          ?.focus({ preventScroll: true });
      });
    }
  };

  private readonly close = (): void => {
    this.open = false;
    this.expandedRoute = undefined;
    this.requestUpdate();
    void this.updateComplete.then(() => {
      this.renderRoot.querySelector<HTMLButtonElement>('.spine-toggle')?.focus({ preventScroll: true });
    });
  };

  private readonly onPageClick = (event: MouseEvent, route: Route): void => {
    if (this.busy) { event.preventDefault(); return; }
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    // Selecting another page navigates normally. Once the page is already
    // selected, every click on it behaves like the disclosure arrow: the
    // first click after selection opens the section tree, the next closes it.
    if (route === this.activeRoute) {
      this.expandedRoute = this.expandedRoute === route ? undefined : route;
      this.requestUpdate();
      return;
    }
    this.expandedRoute = undefined;
    this.requestUpdate();
    this.dispatchEvent(new CustomEvent<Route>('chapter-select', { detail: route, bubbles: true, composed: true }));
  };

  private readonly onDisclosureClick = (event: MouseEvent, route: Route): void => {
    event.preventDefault();
    event.stopPropagation();
    if (this.busy || route !== this.activeRoute) return;
    this.expandedRoute = this.expandedRoute === route ? undefined : route;
    this.requestUpdate();
  };

  private readonly onSectionClick = (event: MouseEvent, route: Route, id: string): void => {
    if (this.busy) { event.preventDefault(); return; }
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    this.dispatchEvent(new CustomEvent<{ route: Route; id: string }>('section-select', {
      detail: { route, id }, bubbles: true, composed: true,
    }));
  };

  private revealActiveSection(): void {
    const list = this.renderRoot.querySelector<HTMLElement>('.rail-list');
    const active = list?.querySelector<HTMLElement>('.submenu .outline-link.active');
    if (!list || !active) return;
    const listRect = list.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    if (activeRect.top < listRect.top + 8) list.scrollTop -= listRect.top + 8 - activeRect.top;
    else if (activeRect.bottom > listRect.bottom - 8) list.scrollTop += activeRect.bottom - (listRect.bottom - 8);
  }

  protected updated(): void {
    if (this.expandedRoute && this.expandedRoute !== this.activeRoute) {
      this.expandedRoute = undefined;
      this.requestUpdate();
      return;
    }
    if (!this.open || !this.expandedRoute) return;
    this.revealActiveSection();
  }

  private renderPageRow(page: ChapterView): TemplateResult {
    const active = page.route === this.activeRoute;
    const expanded = active && this.expandedRoute === page.route;
    const submenuId = `sections-${page.route}`;
    const disclosureLabel = t(expanded ? 'Hide sections for {page}' : 'Show sections for {page}', {
      page: t(page.label),
    });
    return html`
      <div class="chapter-row ${active ? 'active' : ''}">
        <a class="chapter-link" id=${`page-${page.route}`} href=${`#/${page.route}`} data-route=${page.route}
          aria-current=${active ? 'page' : nothing}
          aria-disabled=${this.busy ? 'true' : nothing} tabindex=${this.busy ? '-1' : nothing}
          @click=${(event: MouseEvent) => this.onPageClick(event, page.route)}>
          <span class="chapter-label">${t(page.label)}</span>
          ${page.badge ? html`<span class="sr-only">${t('Update')}</span><span class="badge" aria-hidden="true"></span>` : nothing}
        </a>
        ${active ? html`<button class="chapter-disclosure ${expanded ? 'expanded' : ''}"
          id=${`sections-toggle-${page.route}`} type="button"
          aria-expanded=${String(expanded)} aria-controls=${submenuId}
          aria-label=${disclosureLabel} title=${disclosureLabel} ?disabled=${this.busy}
          @click=${(event: MouseEvent) => this.onDisclosureClick(event, page.route)}>
          <span aria-hidden="true">›</span>
        </button>` : nothing}
      </div>
      ${active ? html`<div class="submenu" id=${submenuId} role="region" aria-label=${t('On this page')}
        ?hidden=${!expanded}>
        <div class="submenu-label">${t('On this page')}</div>
        ${page.outline.length
          ? this.renderOutline(page.outline, page.route)
          : html`<p class="empty">${t('No sections on this page.')}</p>`}
      </div>` : nothing}
    `;
  }

  private renderOutline(items: readonly OutlineItem[], route: Route): TemplateResult {
    return html`<ul class="outline">
      ${items.map(item => {
        const onActiveRoute = route === this.activeRoute;
        const active = onActiveRoute && item.id === this.activeSection;
        const activePath = onActiveRoute && !!this.activeSection && !!item.children
          && !!findOutlineItem(item.children, this.activeSection);
        const group = !!item.children?.length;
        return html`<li>
          <a class="outline-link ${group ? 'group' : 'section'} ${active ? 'active' : ''} ${activePath ? 'active-path' : ''}"
            href=${sectionHref(route, item.id)} data-route=${route} data-section=${item.id}
            aria-current=${active ? 'location' : nothing}
            aria-disabled=${this.busy ? 'true' : nothing} tabindex=${this.busy ? '-1' : nothing}
            @click=${(event: MouseEvent) => this.onSectionClick(event, route, item.id)}>${t(item.label)}</a>
          ${item.children?.length ? this.renderOutline(item.children, route) : nothing}
        </li>`;
      })}
    </ul>`;
  }

  render() {
    return html`
      <div class="frame">
        <div class="spine">
          <img class="brand" src="icons/headset_galaxy_xr_ready_2x.png" alt="Galaxy XR Companion">
          <button class="spine-toggle" type="button" aria-expanded=${String(this.open)}
            aria-controls=${this.open ? 'navigator-panel' : nothing}
            title=${t(this.open ? 'Close navigator' : 'Open navigator')}
            @click=${this.toggleOpen}>
            <span class="vertical-label">${t('Navigator')}</span>
            <span class="spine-chevron ${this.open ? 'open' : ''}" aria-hidden="true">›</span>
          </button>
        </div>

        ${this.open ? html`
          <nav class="rail" id="navigator-panel" aria-labelledby="navigator-heading">
            <div class="rail-head">
              <span id="navigator-heading">${t('Pages')}</span>
              <button class="rail-close" type="button" aria-label=${t('Close navigator')}
                @click=${this.close}>×</button>
            </div>
            <div class="rail-list">
              ${this.chapters.map(page => this.renderPageRow(page))}
            </div>
          </nav>
        ` : nothing}
      </div>
    `;
  }
}
