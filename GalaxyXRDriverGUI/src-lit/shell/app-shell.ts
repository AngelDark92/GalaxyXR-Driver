import { LitElement, html, nothing, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { effect } from '../reactive';
import { t, subscribeLocale } from '../locale/i18n';
import type { AppContext } from '../app-context';
import { applyTheme } from '../ui/theme';
import { interactiveStyles } from '../ui/shared-styles';
import { driverAvailable, parseRoute, permittedRoute, visibleRoutes, type Route } from '../domain/navigation';

const LABELS: Record<Route, string> = {
  'driver-settings': 'Driver Settings', 'distortion-profile': 'Distortion Profile',
  'stream-frame': 'Image Settings', 'app-settings': 'App Settings', setup: 'Setup', about: 'About',
};

@customElement('app-shell')
export class AppShell extends LitElement {
  @property({ attribute: false }) ctx!: AppContext;
  @property({ type: String }) route: Route = 'driver-settings';

  static styles = [interactiveStyles, css`
    :host { display: flex; flex-direction: column; height: 100%; width: 100%; background: var(--colorNeutralBackground2); }
    .header { display: flex; flex: 0 0 auto; align-items: center; gap: 8px; padding: 8px 16px 0; background: var(--colorNeutralBackground1); border-bottom: 1px solid var(--colorNeutralStroke2); }
    .brand-icon { width: 48px; height: 40px; object-fit: contain; flex: 0 0 auto; }
    fluent-tablist { display: flex; flex: 1; min-width: 0; overflow-x: auto; }
    fluent-tab { flex: 1 0 0; min-width: max-content; white-space: nowrap; }
    .content { flex: 1; overflow: auto; min-height: 0; padding: 12px 8px; }
    .panel { max-width: 1500px; margin: 0 auto; outline-offset: -2px; }
    .status { padding: 8px 20px; background: var(--colorNeutralBackground3); border-bottom: 1px solid var(--colorNeutralStroke2); }
    .error { color: var(--colorPaletteRedForeground1); }
    .warn { color: var(--colorPaletteDarkOrangeForeground1); margin-left: 0.35rem; }
    @media (max-width: 720px) { .header { padding-inline: 8px; } .brand-icon { display: none; } .content { padding-inline: 0; } }
  `];

  private themeDispose?: () => void;
  private unsubs: Array<() => void> = [];
  private readonly systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
  private readonly onSystemTheme = () => applyTheme(this.ctx.appSetting.values().colorScheme);
  private readonly onHash = () => this.syncRoute();
  private readonly onInstallation = () => { this.syncRoute(); this.requestUpdate(); };

  connectedCallback(): void {
    super.connectedCallback();
    this.syncRoute();
    window.addEventListener('hashchange', this.onHash);
    this.systemTheme.addEventListener('change', this.onSystemTheme);
    const notify = () => this.requestUpdate();
    this.unsubs.push(
      this.ctx.sds.driverInstalled.subscribe(this.onInstallation),
      this.ctx.sds.installingDriver.subscribe(notify),
      this.ctx.sds.driverState.subscribe(this.onInstallation),
      this.ctx.aus.updateInfo.subscribe(notify),
      this.ctx.checks.checking.subscribe(notify), this.ctx.checks.report.subscribe(notify),
      this.ctx.dss.writeFileError.subscribe(notify), this.ctx.appSetting.writeFileError.subscribe(notify),
      subscribeLocale(notify),
    );
    this.themeDispose = effect(() => applyTheme(this.ctx.appSetting.values().colorScheme));
  }

  disconnectedCallback(): void {
    window.removeEventListener('hashchange', this.onHash);
    this.systemTheme.removeEventListener('change', this.onSystemTheme);
    for (const unsubscribe of this.unsubs) unsubscribe();
    this.unsubs = [];
    this.themeDispose?.();
    super.disconnectedCallback();
  }

  private get driverAvailable(): boolean {
    return driverAvailable(this.ctx.sds.driverInstalled(), this.ctx.sds.driverState());
  }

  private syncRoute(): void {
    const requested = parseRoute(window.location.hash, this.driverAvailable);
    const next = permittedRoute(requested, this.driverAvailable);
    const redirected = this.route !== next && requested !== next;
    this.route = next;
    // Do not lose a valid startup deep-link while initial inspection is pending.
    // A definitive missing/unknown result replaces it, including browser Back.
    if (requested !== next && this.ctx.sds.driverState() !== 'checking') {
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}#/${next}`);
    }
    if (redirected && this.isConnected) {
      void this.updateComplete.then(() => {
        this.shadowRoot?.querySelector<HTMLElement>(`#tab-${next}`)?.focus();
      });
    }
  }

  private onTabChange(event: Event): void {
    // Listen to Fluent's selection event, not only clicks: arrow keys and
    // Home/End must select the page as well as highlighting its tab.
    if (this.ctx.checks.checking() || this.ctx.sds.installingDriver()) return;
    const tablist = event.currentTarget as HTMLElement & { activeid: string };
    const route = tablist.activeid?.replace(/^tab-/, '');
    if (route !== this.route && (visibleRoutes(this.driverAvailable) as readonly string[]).includes(route)) {
      this.route = route as Route;
      window.location.hash = `/${route}`;
    }
  }

  private renderPage(): TemplateResult {
    const ctx = this.ctx;
    switch (permittedRoute(this.route, this.driverAvailable)) {
      case 'distortion-profile': return html`<app-distortion-profile-page .ctx=${ctx}></app-distortion-profile-page>`;
      case 'stream-frame': return html`<app-stream-frame-page .ctx=${ctx}></app-stream-frame-page>`;
      case 'app-settings': return html`<app-app-settings-page .ctx=${ctx}></app-app-settings-page>`;
      case 'setup': return html`<app-setup-page .ctx=${ctx}></app-setup-page>`;
      case 'about': return html`<app-about-page .ctx=${ctx}></app-about-page>`;
      default: return html`<app-driver-settings-page .ctx=${ctx}></app-driver-settings-page>`;
    }
  }

  render() {
    const routes = visibleRoutes(this.driverAvailable);
    const activeRoute = permittedRoute(this.route, this.driverAvailable);
    const update = this.ctx.aus.updateInfo();
    const busy = this.ctx.checks.checking() || this.ctx.sds.installingDriver();
    const writeError = this.ctx.dss.writeFileError() || this.ctx.appSetting.writeFileError();
    return html`
      <header class="header" aria-label="Galaxy XR Companion">
        <img class="brand-icon" src="icons/headset_galaxy_xr_ready_2x.png" alt="Galaxy XR Companion" title="Galaxy XR Companion">
        <fluent-tablist activeid=${`tab-${activeRoute}`} aria-label=${t('Settings pages')} ?disabled=${busy} @change=${this.onTabChange}>
          ${routes.map(route => html`<fluent-tab slot="tab" id=${`tab-${route}`} aria-controls=${`panel-${route}`}>
            ${t(LABELS[route])}${(route === 'about' && update?.updateAvailable) ? html`<span class="warn" role="img" aria-label=${t('Warning')}>⚠</span>` : nothing}
          </fluent-tab>`)}
        </fluent-tablist>
      </header>
      ${busy ? html`<div class="status" role="status">${this.ctx.sds.installingDriver() ? t('Updating driver or settings. Please wait…') : t('Checking installation and saved settings…')}</div>` : nothing}
      ${writeError ? html`<div class="status error" role="alert">${t('Settings could not be saved. The controls have been restored to the last verified values.')} ${writeError}</div>` : nothing}
      <main class="content" aria-busy=${String(busy)} .inert=${busy}>
        ${routes.map(route => html`<section class="panel" role="tabpanel" id=${`panel-${route}`}
          aria-labelledby=${`tab-${route}`} ?hidden=${activeRoute !== route} tabindex="0">
          ${activeRoute === route ? this.renderPage() : nothing}
        </section>`)}
      </main>`;
  }
}
