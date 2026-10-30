import { LitElement, html, nothing, css, type PropertyValues, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { effect } from '../reactive';
import { t, subscribeLocale } from '../locale/i18n';
import type { AppContext } from '../app-context';
import { applyTheme } from '../ui/theme';
import { applyUiScale } from '../ui/ui-scale';
import { interactiveStyles } from '../ui/shared-styles';
import { driverAvailable, parseRoute, parseSectionTarget, parseSettingTarget, permittedRoute, visibleRoutes, sectionHref, settingHref, ROUTE_LABELS, type Route } from '../domain/navigation';
import { CHAPTER_OUTLINES, findOutlineItem, flattenOutline, visibleOutline, type ChapterView, type OutlineContext } from '../domain/page-outline';
import { settingPresentation } from '../domain/settings-presentation';
import { close_bitrate_monitor, publish_bitrate_monitor_theme } from '../platform/tauri';
import type { BasePage } from '../features/page-base';
import type { StreamQualityFallbackNotice } from '../state/galaxy-settings';
import '../ui/chapter-nav';

@customElement('app-shell')
export class AppShell extends LitElement {
  @property({ attribute: false }) ctx!: AppContext;
  @property({ type: String }) route: Route = 'driver-settings';
  @property({ attribute: false }) private settingMessage = '';
  private targetGeneration = 0;
  private debugAllowed = false;
  private monitorAllowed = false;
  private streamQualityToast?: StreamQualityFallbackNotice;
  private streamQualityToastTimer?: number;
  private contentEl?: HTMLElement;
  private activeSection = '';
  private scrollFrame = 0;
  private focusPageAfterRoute = false;

  static styles = [interactiveStyles, css`
    :host { display: flex; flex-direction: row; height: 100%; width: 100%; background: var(--colorNeutralBackground2); }
    app-chapter-nav { flex: 0 0 auto; min-height: 0; }
    .main { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
    .content { flex: 1; overflow: auto; min-height: 0; padding: 0; }
    .panel { max-width: 1500px; margin: 0 auto; outline-offset: -2px; padding: 12px 8px; }
    .page-enter { animation: page-in 140ms cubic-bezier(0.2, 0, 0, 1) both; }
    @keyframes page-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
    .status { margin: 8px 20px; }
    .stream-toast { position: fixed; right: 16px; bottom: 16px; z-index: 1000; margin: 0; max-width: min(440px, calc(100vw - 32px)); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25); }
    .warn { color: var(--colorPaletteDarkOrangeForeground1); margin-left: 0.35rem; }
    @media (max-width: 720px) { .panel { padding-inline: 0; } }
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
      this.ctx.appSetting.values.subscribe(notify),
      this.ctx.lifecycle.error.subscribe(notify), this.ctx.lifecycle.quitting.subscribe(notify),
      this.ctx.ofxr.error.subscribe(notify),
      subscribeLocale(notify),
      this.ctx.galaxy.streamQualityNotice.subscribe(() => this.onStreamQualityNotice()),
    );
    this.onStreamQualityNotice();
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
    this.contentEl?.removeEventListener('scroll', this.onContentScroll);
    this.contentEl = undefined;
    if (this.scrollFrame) cancelAnimationFrame(this.scrollFrame);
    this.scrollFrame = 0;
    for (const unsubscribe of this.unsubs) unsubscribe();
    this.unsubs = [];
    if (this.streamQualityToastTimer !== undefined) {
      window.clearTimeout(this.streamQualityToastTimer);
      this.streamQualityToastTimer = undefined;
    }
    this.themeDispose?.();
    this.scaleDispose?.();
    super.disconnectedCallback();
  }

  private get driverAvailable(): boolean {
    return driverAvailable(this.ctx.sds.driverInstalled(), this.ctx.sds.driverState());
  }

  private onStreamQualityNotice(): void {
    const notice = this.ctx.galaxy.streamQualityNotice();
    if (!notice) {
      if (this.streamQualityToastTimer !== undefined) {
        window.clearTimeout(this.streamQualityToastTimer);
        this.streamQualityToastTimer = undefined;
      }
      this.streamQualityToast = undefined;
      this.requestUpdate();
      return;
    }
    if (this.streamQualityToast?.name === notice.name) return;
    if (this.streamQualityToastTimer !== undefined) {
      window.clearTimeout(this.streamQualityToastTimer);
      this.streamQualityToastTimer = undefined;
    }
    this.streamQualityToast = { ...notice };
    this.streamQualityToastTimer = window.setTimeout(() => {
      this.streamQualityToast = undefined;
      this.streamQualityToastTimer = undefined;
      this.requestUpdate();
    }, 12000);
    this.requestUpdate();
  }

  private dismissStreamQualityToast = (): void => {
    if (this.streamQualityToastTimer !== undefined) {
      window.clearTimeout(this.streamQualityToastTimer);
      this.streamQualityToastTimer = undefined;
    }
    this.streamQualityToast = undefined;
    this.requestUpdate();
  };

  private syncRoute(): void {
    this.debugAllowed = this.driverAvailable && this.ctx.galaxy.debugMode;
    const target = parseSettingTarget(window.location.hash);
    const section = parseSectionTarget(window.location.hash);
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
        this.shadowRoot?.getElementById(`panel-${next}`)?.focus({ preventScroll: true });
      });
    }
    const generation = ++this.targetGeneration;
    if (section && !target) void this.showSectionTarget(section, requested, generation);
    else void this.showTarget(target, requested, generation);
  }

  private activePageElement(): BasePage | undefined {
    return this.shadowRoot?.getElementById(`panel-${this.route}`)
      ?.querySelector('.page-enter > *') as BasePage | undefined;
  }

  private outlineContext(): OutlineContext {
    const galaxy = this.ctx.galaxy;
    const gx = galaxy.galaxyXr;
    return {
      vendor: !!galaxy.vendor,
      advancedMode: galaxy.advancedMode,
      enhancements: galaxy.imageEnhancementsEnabled,
      controllerBypass: !!gx.controllerBypass,
      kalmanMode: galaxy.isKalmanMode(),
      gameLinkLayout: !!gx.gameLinkLayout,
      hasControllerSettings: !!galaxy.controllerSettings,
      settings: galaxy.settings,
    };
  }

  private async showTarget(id: string | undefined, requested: Route, generation: number): Promise<void> {
    this.settingMessage = '';
    await this.updateComplete;
    if (!this.isConnected || generation !== this.targetGeneration) return;
    const page = this.activePageElement();
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

  private async showSectionTarget(id: string, requested: Route, generation: number): Promise<void> {
    this.settingMessage = '';
    await this.updateComplete;
    if (!this.isConnected || generation !== this.targetGeneration) return;
    if (requested !== this.route) {
      this.settingMessage = requested === 'debug' && this.driverAvailable
        ? 'Enable Debug Mode in App Settings to show diagnostic controls.'
        : 'This section is not available in this version.';
      this.requestUpdate();
      return;
    }
    const item = findOutlineItem(visibleOutline(CHAPTER_OUTLINES[requested], this.outlineContext()), id);
    if (!item) {
      this.settingMessage = 'This section is not available in this version.';
      this.requestUpdate();
      return;
    }
    const page = this.activePageElement();
    if (!page) return;
    await page.updateComplete;
    if (generation !== this.targetGeneration) return;
    page.clearSettingTarget?.();
    await page.revealSection(id, item.open ?? []);
    if (generation === this.targetGeneration) {
      this.activeSection = id;
      this.requestUpdate();
    }
  }

  private async revealSection(id: string, openKeys: readonly string[]): Promise<void> {
    await this.updateComplete;
    const page = this.activePageElement();
    if (!page) return;
    await page.updateComplete;
    page.clearSettingTarget?.();
    await page.revealSection(id, openKeys);
  }

  private onChapterSelect = (event: Event): void => {
    const route = (event as CustomEvent<Route>).detail;
    if (!(visibleRoutes(this.driverAvailable, this.ctx.galaxy.debugMode) as readonly string[]).includes(route)) return;
    if (route === this.route) {
      this.activeSection = '';
      this.activePageElement()?.clearSettingTarget?.();
      window.history.replaceState(window.history.state, '',
        `${window.location.pathname}${window.location.search}#/${route}`);
      this.contentEl?.scrollTo({ top: 0, behavior: 'auto' });
      void this.updateComplete.then(() => {
        this.updateActiveSection();
        this.shadowRoot?.getElementById(`panel-${this.route}`)?.focus({ preventScroll: true });
      });
      return;
    }
    this.focusPageAfterRoute = true;
    window.location.hash = `/${route}`;
  };

  private onSectionSelect = (event: Event): void => {
    const { route, id } = (event as CustomEvent<{ route: Route; id: string }>).detail;
    if (!(visibleRoutes(this.driverAvailable, this.ctx.galaxy.debugMode) as readonly string[]).includes(route)) return;
    const target = sectionHref(route, id);
    // A changed hash goes through syncRoute, which adds a history entry and
    // runs the same reveal path for pasted links and Back/Forward. Re-selecting
    // the current section only scrolls and focuses it.
    if (window.location.hash !== target) {
      window.location.hash = target;
      return;
    }
    ++this.targetGeneration;
    const item = findOutlineItem(visibleOutline(CHAPTER_OUTLINES[route], this.outlineContext()), id);
    if (!item) {
      this.settingMessage = 'This section is not available in this version.';
      this.requestUpdate();
      return;
    }
    this.settingMessage = '';
    this.activeSection = id;
    this.requestUpdate();
    void this.revealSection(id, item.open ?? []);
  };

  private readonly onContentScroll = (): void => {
    if (this.scrollFrame) return;
    this.scrollFrame = requestAnimationFrame(() => {
      this.scrollFrame = 0;
      this.updateActiveSection();
    });
  };

  private updateActiveSection(): void {
    if (!this.contentEl) return;
    const ids = flattenOutline(visibleOutline(CHAPTER_OUTLINES[this.route], this.outlineContext()))
      .map(item => item.id);
    if (!ids.length) {
      if (this.activeSection) { this.activeSection = ''; this.requestUpdate(); }
      return;
    }
    const page = this.activePageElement();
    const threshold = this.contentEl.getBoundingClientRect().top + 96;
    let active = ids[0];
    for (const id of ids) {
      const target = page?.shadowRoot?.getElementById(`section-${id}`);
      if (!target) continue;
      if (target.getBoundingClientRect().top <= threshold) active = id;
    }
    if (active !== this.activeSection) {
      this.activeSection = active;
      this.requestUpdate();
    }
  }

  protected firstUpdated(): void {
    this.contentEl = this.renderRoot.querySelector<HTMLElement>('.content') ?? undefined;
    this.contentEl?.addEventListener('scroll', this.onContentScroll, { passive: true });
    this.updateActiveSection();
  }

  protected updated(changed: PropertyValues): void {
    if (changed.has('route')) {
      this.activeSection = '';
      this.contentEl?.scrollTo({ top: 0, behavior: 'auto' });
      if (this.focusPageAfterRoute) {
        this.focusPageAfterRoute = false;
        void this.updateComplete.then(() => {
          this.shadowRoot?.getElementById(`panel-${this.route}`)?.focus({ preventScroll: true });
        });
      }
      void this.updateComplete.then(() => this.updateActiveSection());
      return;
    }
    // Settings can arrive after the shell's first render; establish the
    // current section once the page and its outline are available.
    if (!this.activeSection && this.contentEl) {
      void Promise.resolve().then(() => { if (!this.activeSection) this.updateActiveSection(); });
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
    const navContext = this.outlineContext();
    const chapters: ChapterView[] = routes.map(route => ({
      route,
      label: ROUTE_LABELS[route],
      outline: visibleOutline(CHAPTER_OUTLINES[route], navContext),
      badge: route === 'about' && !!update?.updateAvailable,
    }));
    return html`
      <app-chapter-nav .chapters=${chapters} .activeRoute=${activeRoute}
        .activeSection=${this.activeSection} .busy=${busy}
        @chapter-select=${this.onChapterSelect} @section-select=${this.onSectionSelect}></app-chapter-nav>
      <div class="main">
        ${busy ? html`<fluent-message-bar class="status" intent="info" role="status"><fluent-spinner slot="icon" size="tiny" aria-hidden="true"></fluent-spinner>${this.ctx.lifecycle.quitting() ? t('Saving settings before quitting…') : this.ctx.sds.installingDriver() ? t('Updating driver or settings. Please wait…') : t('Checking installation and saved settings…')}</fluent-message-bar>` : nothing}
        ${writeError ? html`<fluent-message-bar class="status" intent="error" role="alert"><span slot="icon" aria-hidden="true">!</span><strong>${t('Settings could not be saved.')}</strong> ${t('The controls have been restored to the last verified values.')}<details><summary>${t('Technical details')}</summary>${writeError}</details></fluent-message-bar>` : nothing}
        ${lifecycleError ? html`<fluent-message-bar class="status" intent="error" role="alert"><span slot="icon" aria-hidden="true">!</span><strong>${t('Companion tray behavior could not be applied')}</strong> ${lifecycleError}</fluent-message-bar>` : nothing}
        ${ofxrError ? html`<fluent-message-bar class="status" intent="error" role="alert"><span slot="icon" aria-hidden="true">!</span><strong>${t('Optical Flow needs attention')}</strong> ${ofxrError} <a href="#/stream-frame">${t('Open Optical Flow')}</a></fluent-message-bar>` : nothing}
        ${this.settingMessage ? html`<fluent-message-bar class="status" intent="info" role="status"><span slot="icon" aria-hidden="true">ⓘ</span>${t(this.settingMessage)}</fluent-message-bar>` : nothing}
        <main class="content" aria-busy=${String(busy)} .inert=${busy}>
          ${routes.map(route => html`<section class="panel" id=${`panel-${route}`}
            aria-label=${t(ROUTE_LABELS[route])} ?hidden=${activeRoute !== route} tabindex="0">
            ${activeRoute === route ? html`<div class="page-enter">${this.renderPage()}</div>` : nothing}
          </section>`)}
        </main>
      </div>
      ${this.streamQualityToast ? html`<fluent-message-bar class="stream-toast" intent="warning" layout="multiline" role="status" aria-live="polite">
        <span slot="icon" aria-hidden="true">!</span>
        <strong>${t('Stream quality not recognized')}</strong>
        ${t('The stored stream quality "{name}" is not recognized. The driver is using its fallback values: {tile} px tile width and {bandwidth} Mbit/s encoder budget. Edit Tile Width or Max Bitrate to replace them.', {
          name: this.streamQualityToast.name, tile: this.streamQualityToast.tile, bandwidth: this.streamQualityToast.bandwidth })}
        <fluent-button slot="actions" appearance="subtle" @click=${this.dismissStreamQualityToast}>${t('Dismiss')}</fluent-button>
      </fluent-message-bar>` : nothing}`;
  }
}
