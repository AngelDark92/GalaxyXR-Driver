import { LitElement, html, nothing, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { effect } from '../reactive';
import { t, subscribeLocale } from '../locale/i18n';
import type { AppContext } from '../app-context';
import { applyTheme } from '../ui/theme';
import { applyUiScale } from '../ui/ui-scale';
import { interactiveStyles } from '../ui/shared-styles';
import { driverAvailable, parseRoute, parseSettingTarget, permittedRoute, visibleRoutes, settingHref, ROUTE_LABELS, type Route } from '../domain/navigation';
import { settingPresentation } from '../domain/settings-presentation';
import { close_bitrate_monitor, publish_bitrate_monitor_theme } from '../platform/tauri';
import type { BasePage } from '../features/page-base';

@customElement('app-shell')
export class AppShell extends LitElement {
  @property({ attribute: false }) ctx!: AppContext;
  @property({ type: String }) route: Route = 'driver-settings';
  @property({ attribute: false }) private settingMessage = '';
  private targetGeneration = 0;
  private debugAllowed = false;
  private monitorAllowed = false;

  static styles = [interactiveStyles, css`
    :host { display: flex; flex-direction: column; height: 100%; width: 100%; background: var(--colorNeutralBackground2); }
    .header { display: flex; flex: 0 0 auto; align-items: center; gap: 8px; padding: 8px 16px 0; background: var(--colorNeutralBackground1); border-bottom: 1px solid var(--colorNeutralStroke2); }
    .brand-icon { width: 48px; height: 40px; object-fit: contain; flex: 0 0 auto; }
    fluent-tablist { display: flex; flex: 1; min-width: 0; overflow-x: auto; }
    fluent-tab { flex: 1 0 0; min-width: max-content; white-space: nowrap; }
    .content { flex: 1; overflow: auto; min-height: 0; padding: 12px 8px; }
    .panel { max-width: 1500px; margin: 0 auto; outline-offset: -2px; }
    .status { margin: 8px 20px; }
    .warn { color: var(--colorPaletteDarkOrangeForeground1); margin-left: 0.35rem; }
    @media (max-width: 720px) { .header { padding-inline: 8px; } .brand-icon { display: none; } .content { padding-inline: 0; } }
  `];

  private themeDispose?: () => void;
  private scaleDispose?: () => void;
  private unsubs: Array<() => void> = [];
  private readonly systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
  private readonly onSystemTheme = () => applyTheme(this.ctx.appSetting.values().colorScheme);
  private readonly onHash = () => this.syncRoute();
  private readonly onInstallation = () => {
    // 2026-10-17: a mid-session install must keep the user on Setup; the
    // empty-hash re-default to Driver Settings serves fresh opens only and
    // must not fire while an install is running.
    const allowed = this.driverAvailable && this.ctx.galaxy.debugMode;
    if (this.monitorAllowed && !allowed) void close_bitrate_monitor().catch(() => undefined);
    this.monitorAllowed = allowed;
    if (!(this.ctx.sds.installingDriver() && this.route === 'setup')) this.syncRoute();
    this.requestUpdate();
  };
  private readonly onDriverSettings = () => {
    // Saved selections/default emissions must not erase a guarded-link message.
    const allowed = this.driverAvailable && this.ctx.galaxy.debugMode;
    // The monitor is a Debug Mode tool: losing the gate closes its window too.
    if (this.monitorAllowed && !allowed) void close_bitrate_monitor().catch(() => undefined);
    this.monitorAllowed = allowed;
    if (this.debugAllowed !== allowed) this.syncRoute();
    this.requestUpdate();
  };

  connectedCallback(): void {
    super.connectedCallback();
    this.syncRoute();
    this.monitorAllowed = this.driverAvailable && this.ctx.galaxy.debugMode;
    window.addEventListener('hashchange', this.onHash);
    this.systemTheme.addEventListener('change', this.onSystemTheme);
    const notify = () => this.requestUpdate();
    this.unsubs.push(
      this.ctx.sds.driverInstalled.subscribe(this.onInstallation),
      this.ctx.sds.installingDriver.subscribe(notify),
      this.ctx.sds.driverState.subscribe(this.onInstallation),
      this.ctx.dss.values.subscribe(this.onDriverSettings),
      this.ctx.dss.readFileError.subscribe(this.onDriverSettings),
      this.ctx.aus.updateInfo.subscribe(notify),
      this.ctx.checks.checking.subscribe(notify), this.ctx.checks.report.subscribe(notify),
      this.ctx.dss.writeFileError.subscribe(notify), this.ctx.appSetting.writeFileError.subscribe(notify),
      this.ctx.lifecycle.error.subscribe(notify), this.ctx.lifecycle.quitting.subscribe(notify),
      this.ctx.ofxr.error.subscribe(notify),
      subscribeLocale(notify),
    );
    this.themeDispose = effect(() => {
      const preference = this.ctx.appSetting.values().colorScheme;
      applyTheme(preference);
      // Only the main window can publish; the command is a no-op when closed.
      void publish_bitrate_monitor_theme(preference).catch(() => undefined);
    });
    // 2026-10-19: also covers a gui-settings.json edit picked up by the file
    // watcher, so the window scale always matches the saved value.
    this.scaleDispose = effect(() => { void applyUiScale(this.ctx.appSetting.values().uiScale); });
  }

  disconnectedCallback(): void {
    ++this.targetGeneration;
    window.removeEventListener('hashchange', this.onHash);
    this.systemTheme.removeEventListener('change', this.onSystemTheme);
    for (const unsubscribe of this.unsubs) unsubscribe();
    this.unsubs = [];
    this.themeDispose?.();
    this.scaleDispose?.();
    super.disconnectedCallback();
  }

  private get driverAvailable(): boolean {
    return driverAvailable(this.ctx.sds.driverInstalled(), this.ctx.sds.driverState());
  }

  private syncRoute(): void {
    this.debugAllowed = this.driverAvailable && this.ctx.galaxy.debugMode;
    const target = parseSettingTarget(window.location.hash);
    let requested = parseRoute(window.location.hash, this.driverAvailable);
    const setting = target ? settingPresentation(target) : undefined;
    // 2026-10-01: retain pre-move links without bypassing Debug Mode.
    if (requested === 'stream-frame' && setting?.route === 'debug') {
      requested = 'debug';
      if (this.ctx.galaxy.debugMode && this.driverAvailable) {
        window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}${settingHref('debug', target!)}`);
      }
    }
    const next = permittedRoute(requested, this.driverAvailable, this.ctx.galaxy.debugMode);
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
    void this.showTarget(target, requested, ++this.targetGeneration);
  }

  private async showTarget(id: string | undefined, requested: Route, generation: number): Promise<void> {
    this.settingMessage = '';
    await this.updateComplete;
    if (!this.isConnected || generation !== this.targetGeneration) return;
    const page = this.shadowRoot?.getElementById(`panel-${this.route}`)?.firstElementChild as BasePage | undefined;
    if (!id) {
      page?.clearSettingTarget?.();
      if (requested === 'debug' && this.driverAvailable && !this.ctx.galaxy.debugMode) this.settingMessage = 'Enable Debug Mode in App Settings to show diagnostic controls.';
      return;
    }
    const setting = settingPresentation(id);
    if (!setting || setting.route !== requested) {
      this.settingMessage = 'This setting is not available in this version.';
      return;
    }
    if (requested !== this.route) {
      this.settingMessage = requested === 'debug' && this.driverAvailable
        ? 'Enable Debug Mode in App Settings to show diagnostic controls.' : 'Install the driver to show this control.';
      return;
    }
    if (page) {
      await page.updateComplete;
      if (generation !== this.targetGeneration) return;
      const message = await page.showSetting(id);
      if (generation === this.targetGeneration) this.settingMessage = message ?? (setting.advanced && !this.ctx.galaxy.advancedMode
        ? 'Advanced controls are temporarily visible for this setting. Advanced Mode has not changed.' : '');
    }
  }

  private onTabChange(event: Event): void {
    // Listen to Fluent's selection event, not only clicks: arrow keys and
    // Home/End must select the page as well as highlighting its tab.
    if (this.ctx.checks.checking() || this.ctx.sds.installingDriver()) return;
    const tablist = event.currentTarget as HTMLElement & { activeid: string };
    const route = tablist.activeid?.replace(/^tab-/, '');
    if (route !== this.route && (visibleRoutes(this.driverAvailable, this.ctx.galaxy.debugMode) as readonly string[]).includes(route)) {
      this.route = route as Route;
      window.location.hash = `/${route}`;
    }
  }

  private renderPage(): TemplateResult {
    const ctx = this.ctx;
    switch (permittedRoute(this.route, this.driverAvailable, this.ctx.galaxy.debugMode)) {
      case 'debug': return html`<app-debug-page .ctx=${ctx}></app-debug-page>`;
      case 'distortion-profile': return html`<app-distortion-profile-page .ctx=${ctx}></app-distortion-profile-page>`;
      case 'stream-frame': return html`<app-stream-frame-page .ctx=${ctx}></app-stream-frame-page>`;
      case 'app-settings': return html`<app-app-settings-page .ctx=${ctx}></app-app-settings-page>`;
      case 'setup': return html`<app-setup-page .ctx=${ctx}></app-setup-page>`;
      case 'about': return html`<app-about-page .ctx=${ctx}></app-about-page>`;
      default: return html`<app-driver-settings-page .ctx=${ctx}></app-driver-settings-page>`;
    }
  }

  render() {
    const routes = visibleRoutes(this.driverAvailable, this.ctx.galaxy.debugMode);
    const activeRoute = permittedRoute(this.route, this.driverAvailable, this.ctx.galaxy.debugMode);
    const update = this.ctx.aus.updateInfo();
    const busy = this.ctx.checks.checking() || this.ctx.sds.installingDriver() || this.ctx.lifecycle.quitting();
    const writeError = this.ctx.dss.writeFileError() || this.ctx.appSetting.writeFileError();
    const lifecycleError = this.ctx.lifecycle.error();
    const ofxrError = this.ctx.ofxr.error();
    return html`
      <header class="header" aria-label="Galaxy XR Companion">
        <img class="brand-icon" src="icons/headset_galaxy_xr_ready_2x.png" alt="Galaxy XR Companion" title="Galaxy XR Companion">
        <fluent-tablist activeid=${`tab-${activeRoute}`} aria-label=${t('Settings pages')} ?disabled=${busy} @change=${this.onTabChange}>
          ${routes.map(route => html`<fluent-tab slot="tab" id=${`tab-${route}`} aria-controls=${`panel-${route}`}>
            ${t(ROUTE_LABELS[route])}${(route === 'about' && update?.updateAvailable) ? html`<fluent-badge appearance="tint" color="brand">${t('Update')}</fluent-badge>` : nothing}
          </fluent-tab>`)}
        </fluent-tablist>
      </header>
      ${busy ? html`<fluent-message-bar class="status" intent="info" role="status"><fluent-spinner slot="icon" size="tiny" aria-hidden="true"></fluent-spinner>${this.ctx.lifecycle.quitting() ? t('Saving settings before quitting…') : this.ctx.sds.installingDriver() ? t('Updating driver or settings. Please wait…') : t('Checking installation and saved settings…')}</fluent-message-bar>` : nothing}
      ${writeError ? html`<fluent-message-bar class="status" intent="error" role="alert"><span slot="icon" aria-hidden="true">!</span><strong>${t('Settings could not be saved.')}</strong> ${t('The controls have been restored to the last verified values.')}<details><summary>${t('Technical details')}</summary>${writeError}</details></fluent-message-bar>` : nothing}
      ${lifecycleError ? html`<fluent-message-bar class="status" intent="error" role="alert"><span slot="icon" aria-hidden="true">!</span><strong>${t('Companion tray behavior could not be applied')}</strong> ${lifecycleError}</fluent-message-bar>` : nothing}
      ${ofxrError ? html`<fluent-message-bar class="status" intent="error" role="alert"><span slot="icon" aria-hidden="true">!</span><strong>${t('Optical Flow needs attention')}</strong> ${ofxrError} <a href="#/stream-frame">${t('Open Optical Flow')}</a></fluent-message-bar>` : nothing}
      ${this.settingMessage ? html`<fluent-message-bar class="status" intent="info" role="status"><span slot="icon" aria-hidden="true">ⓘ</span>${t(this.settingMessage)}</fluent-message-bar>` : nothing}
      <main class="content" aria-busy=${String(busy)} .inert=${busy}>
        ${routes.map(route => html`<section class="panel" role="tabpanel" id=${`panel-${route}`}
          aria-labelledby=${`tab-${route}`} ?hidden=${activeRoute !== route} tabindex="0">
          ${activeRoute === route ? this.renderPage() : nothing}
        </section>`)}
      </main>`;
  }
}
