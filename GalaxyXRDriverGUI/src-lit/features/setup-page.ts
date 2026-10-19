// Setup, read-back checks, and maintenance (2026-09-26).
import { html, nothing, type TemplateResult, css } from 'lit';
import { customElement } from 'lit/decorators.js';
import { BasePage, fieldRow, sectionHeading, fieldStyles } from './page-base';
import { pageIntro, statusIcon, statusMessage } from '../ui/presentation';
import { t } from '../locale/i18n';
import { galaxyXRDriverName } from '../environment';
import '../ui/controls';
import './system-ready';
import './driver-banner';

const INSTALL_KEY = 'Install <x id="INTERPOLATION" equiv-text="{{updateInfo.currentVersion}}"/>';

@customElement('app-setup-page')
export class SetupPage extends BasePage {
  static styles = [fieldStyles, css`
    :host { display: block; padding: 0 1rem 2rem; }
    .step-grid, .maintenance-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
    .step-card, .action-card { border: 1px solid var(--colorNeutralStroke2); border-radius: 8px; padding: 20px; background: var(--colorNeutralBackground1); min-width: 0; }
    .step-card h3, .action-card h3 { margin: 0; font-size: 16px; }
    .step-card p, .action-card p { color: var(--colorNeutralForeground2); line-height: 1.5; }
    .step-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; margin-bottom: 12px; }
    .setup-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 16px; }
    .check-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 16px; }
    .check-toolbar p { margin: 4px 0; color: var(--colorNeutralForeground2); }
    .check-summary { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin: 16px 0; }
    .secondary { color: var(--colorNeutralForeground2); font-size: 13px; }
    .check-table-scroll { overflow: auto; max-height: 32rem; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 12px; border-bottom: 1px solid var(--colorNeutralStroke2); vertical-align: top; }
    th { position: sticky; top: 0; z-index: 1; background: var(--colorNeutralBackground2); font-weight: 600; }
    .location { min-width: 15rem; line-height: 1.7; }
    .location span { color: var(--colorNeutralForeground2); }
    .location .leaf { color: var(--colorNeutralForeground1); font-weight: 600; }
    .location .separator { padding: 0 6px; }
    .location small { display: block; color: var(--colorNeutralForeground2); }
    .technical { overflow-wrap: anywhere; white-space: pre-wrap; }
    .check-details { margin-top: 12px; }
    .action-card.danger-zone { border-color: var(--colorPaletteRedBorder1, var(--colorNeutralStroke2)); }
    /* 2026-10-17: step 2 stays highlighted until the app verifies driver
       initialization in SteamVR (installed but not yet verified/initialized). */
    .step-card.attention { border-color: var(--colorPaletteRedBorder1, var(--colorNeutralStroke2)); background: var(--colorPaletteRedBackground2, var(--colorNeutralBackground1)); }
    .action-card h3 { display: flex; align-items: center; gap: 8px; }
    .action-card .status-icon { width: 20px; height: 20px; }
    @media (max-width: 850px) { .step-grid, .maintenance-grid { grid-template-columns: 1fr; } }
  `];

  private async checkSettings(): Promise<void> {
    await this.ctx.checks.refresh();
    await this.ctx.startup.refresh();
  }

  private renderSetup(): TemplateResult {
    const { sds, startup, aus, dis } = this.ctx;
    const version = sds.driverInstalled();
    const installed = !!version;
    const updateInfo = aus.updateInfo();
    const busy = sds.installingDriver() || this.ctx.checks.checking() || startup.launching();
    const status = startup.status();
    const config = sds.steamVrConfig();
    const enabled = config ? sds.getSteamVRDriverEnableState(config, galaxyXRDriverName) : undefined;
    const verified = this.ctx.appSetting.values()?.driverVerified === true;
    const initialized = installed && enabled !== false && (verified || status?.driverInitialized === true);
    const installLabel = !installed ? t('Install Driver') : updateInfo?.installAvailable
      ? this.installText(updateInfo.currentVersion) : t('Reinstall driver');
    return html`
      <div class="step-grid">
        <article class="step-card">
          <div class="step-heading"><h3>${t('1. Install the driver')}</h3>
            <fluent-badge appearance="tint" color=${installed ? 'success' : 'informative'}>
              ${installed ? t('Installed') : sds.driverState() === 'checking' ? t('Checking…') : sds.driverState() === 'unknown' ? t('Unknown') : t('Not installed')}
            </fluent-badge>
          </div>
          <p>${installed ? t('Updates keep your saved settings.') : t('Install the driver to unlock headset and image settings.')}</p>
          <p><strong>${t('Installed Driver Version')}:</strong> ${version ?? '—'}</p>
          ${sds.driverCheckError() ? statusMessage('error', t('Installation could not be verified'), t('Check the installation again to retry.')) : nothing}
          <div class="setup-actions">
            <fluent-button appearance="primary" ?disabled=${busy} @click=${() => this.installDriver()}>${installLabel}</fluent-button>
            <fluent-button ?disabled=${busy} @click=${() => this.checkSettings()}>${t('Check installation')}</fluent-button>
          </div>
        </article>
        <article class="step-card${installed && !initialized ? ' attention' : ''}">
          <div class="step-heading"><h3>${t('2. Connect and verify')}</h3>
            <fluent-badge appearance="tint" color=${initialized ? 'success' : 'informative'}>
              ${initialized ? t('Verified') : t('Not verified')}
            </fluent-badge>
          </div>
          <p>${t('Start SteamVR, then connect your headset through Steam Link.')}</p>
          ${statusMessage(initialized ? 'success' : 'info',
            !installed ? t('Install the driver first.') : initialized ? t('Driver initialization verified in SteamVR.')
              : status?.steamvrRunning ? t('Waiting for driver initialization') : t('Start SteamVR to continue'),
            initialized && status?.steamvrRunning === false ? t('Previously verified. SteamVR is not running.')
              : initialized && !status ? t('Previously verified. Current SteamVR status is unknown.')
              : installed && status ? t(status.detail) : undefined)}
          ${startup.error() ? statusMessage('error', t('SteamVR could not start'), startup.error()) : nothing}
          ${installed ? html`<div class="setup-actions">
            <fluent-button appearance="primary" ?disabled=${busy || enabled === false || !!status?.steamvrRunning}
              @click=${() => startup.start()}>${startup.launching() ? t('Starting SteamVR…') : t('Start SteamVR')}</fluent-button>
            <fluent-button ?disabled=${busy} @click=${() => this.checkSettings()}>${t('Check driver now')}</fluent-button>
          </div>` : nothing}
        </article>
      </div>
      ${installed ? html`<p class="secondary">${t('After verification, check the picture and controller tracking in your headset.')}</p>` : nothing}
      ${!sds.steamVRinstalled() || (installed && (!sds.systemReady() || enabled === false))
        ? html`<app-driver-troubleshooter .ctx=${this.ctx}></app-driver-troubleshooter>` : nothing}
      ${installed ? html`<app-driver-enable-banner .ctx=${this.ctx}></app-driver-enable-banner>` : nothing}
      <fluent-accordion class="check-details"><fluent-accordion-item>
        <span slot="heading">${t('Runtime tools and details')}</span>
        ${fieldRow(t('Restart Compositor'), html`<fluent-button ?disabled=${busy || !installed}
          @click=${() => sds.restartCompositor()}>${t('Restart Compositor')}</fluent-button>`, {
          tip: t("Restart SteamVR's display process to try to fix display problems without closing the game. Your headset view may briefly disappear; save anything important first.\n\nRestarting the compositor can fix some issues and allows changing various settings like refresh rate without restarting SteamVR or the game."),
        })}
        <p class="secondary"><strong>${t('Last reported driver version (not live verification)')}:</strong> ${dis.values()?.driverVersion ?? t('No runtime information')}</p>
        ${sds.driverVersionMismatch() ? statusMessage('warning', t('Version mismatch'), t('Restart SteamVR to load the installed driver version.')) : nothing}
        ${sds.driverCheckError() ? html`<p class="technical">${sds.driverCheckError()}</p>` : nothing}
      </fluent-accordion-item></fluent-accordion>`;
  }

  private renderSettingsCheck(): TemplateResult {
    const report = this.ctx.checks.report();
    const busy = this.ctx.checks.checking() || this.ctx.sds.installingDriver() || this.ctx.startup.launching();
    const originLabels = { stored: 'Saved value', default: 'Default value', mixed: 'Saved and default values', unknown: 'Unknown' } as const;
    return html`
      <div class="check-toolbar">
        <div><p>${t('Read back saved settings and locate each control.')}</p>
          <p class="secondary">${t('Restart-required settings may not be active in the headset yet.')}</p></div>
        <fluent-button appearance="primary" ?disabled=${busy} @click=${() => this.checkSettings()}>
          ${this.ctx.checks.checking() ? html`<fluent-spinner slot="start" size="tiny"></fluent-spinner>` : nothing}
          ${this.ctx.checks.checking() ? t('Checking…') : t('Check settings')}
        </fluent-button>
      </div>
      ${report ? html`
        <div class="check-summary" role="status" aria-live="polite">
          <fluent-badge appearance="tint" color=${report.errors.length ? 'warning' : 'informative'}>${report.errors.length ? t('Needs attention') : t('Check complete')}</fluent-badge>
          <span class="secondary">${t('Last check')}: ${new Date(report.checkedAt).toLocaleString()}</span>
          <span class="secondary">${t('Driver enabled in SteamVR')}: ${report.driverEnabled === undefined ? t('Unknown') : report.driverEnabled ? t('On') : t('Off')}</span>
        </div>
        ${report.errors.length || report.warnings.length ? statusMessage('warning', t('Some checks need attention'), t('Open Technical details to review unreadable settings and other notices.')) : nothing}
        <div class="check-table-scroll"><table>
          <thead><tr><th>${t('Location')}</th><th>${t('Saved state')}</th><th>${t('Value source')}</th><th>${t('Action')}</th></tr></thead>
          <tbody>${(report.settings ?? []).map(setting => html`<tr>
            <td class="location">${setting.location.map((part, index) => html`${index ? html`<span class="separator" aria-hidden="true">→</span>` : nothing}<span class=${index === setting.location.length - 1 ? 'leaf' : ''}>${t(part)}</span>`)}
              ${setting.unavailableReason ? html`<small>${t(setting.unavailableReason)}</small>` : nothing}
            </td>
            <td><fluent-badge appearance="outline" color="informative">${t(setting.state)}</fluent-badge></td>
            <td>${t(originLabels[setting.origin])}</td>
            <td>${setting.unavailableReason ? html`<span class="secondary">${t('Unavailable')}</span>` : html`<a href=${setting.href}>${t('Show setting')}</a>`}</td>
          </tr>`)}</tbody>
        </table></div>
        <fluent-accordion class="check-details"><fluent-accordion-item>
          <span slot="heading">${t('Technical details')}</span>
          <p class="secondary">${report.checks.length} ${t('boolean settings checked')}. ${t('Saved configuration does not verify live hardware behavior.')}</p>
          ${report.errors.map(error => html`<p class="technical">${error}</p>`)}
          ${report.warnings.map(warning => html`<p class="technical">${warning}</p>`)}
          <div class="check-table-scroll"><table>
            <thead><tr><th>${t('File')}</th><th>${t('Setting')}</th><th>${t('State')}</th><th>${t('Value source')}</th></tr></thead>
            <tbody>${report.checks.map(check => html`<tr>
              <td>${check.source}</td><td><code>${check.key}</code></td>
              <td>${check.enabled ? t('On') : t('Off')}</td>
              <td>${check.origin === 'stored' ? t('Saved value') : t('Default value')}</td>
            </tr>`)}</tbody>
          </table></div>
        </fluent-accordion-item></fluent-accordion>
      ` : nothing}`;
  }

  // 2026-10-18: the 2 s runtime poll must not churn requestUpdate while the
  // window is hidden — shared-signal subscriptions re-fire on every tick from
  // any visible page and amplified low fps during window drags. The
  // subscriptions still run their state updates (rememberVerified and
  // friends); returning to visible re-renders once through onVisibilityChange.
  private readonly onVisibilityChange = () => {
    if (document.visibilityState !== 'hidden') this.requestUpdate();
  };
  private requestVisibleUpdate(): void {
    if (document.visibilityState !== 'hidden') this.requestUpdate();
  }
  private runtimeUnsubs: Array<() => void> = [];
  private runtimeTimer?: ReturnType<typeof setTimeout>;
  private pollGeneration = 0;
  private async pollRuntime(generation: number): Promise<void> {
    if (!this.isConnected || generation !== this.pollGeneration) return;
    if (document.visibilityState !== 'hidden') await this.ctx.startup.refresh();
    if (this.isConnected && generation === this.pollGeneration) {
      this.runtimeTimer = setTimeout(() => { void this.pollRuntime(generation); }, 2000);
    }
  }
  connectedCallback(): void {
    super.connectedCallback();
    this.runtimeUnsubs = [
      this.ctx.startup.status.subscribe(() => { this.rememberVerified(); this.requestVisibleUpdate(); }),
      this.ctx.startup.error.subscribe(() => this.requestVisibleUpdate()),
      this.ctx.startup.launching.subscribe(() => this.requestVisibleUpdate()),
    ];
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    void this.pollRuntime(++this.pollGeneration);
  }
  private rememberVerified(): void {
    if (this.ctx.sds.installingDriver() || !this.ctx.sds.driverInstalled()
        || this.ctx.startup.status()?.driverInitialized !== true) return;
    const app = this.ctx.appSetting;
    if (app.values()?.driverVerified !== true) void app.save({ ...app.values(), driverVerified: true });
  }
  private async resetVerified(): Promise<void> {
    const app = this.ctx.appSetting;
    if (app.values()?.driverVerified === true) await app.save({ ...app.values(), driverVerified: false });
  }
  disconnectedCallback(): void {
    ++this.pollGeneration;
    if (this.runtimeTimer !== undefined) clearTimeout(this.runtimeTimer);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    for (const unsubscribe of this.runtimeUnsubs) unsubscribe();
    this.runtimeUnsubs = [];
    super.disconnectedCallback();
  }
  private installText(version: string): string { return t(INSTALL_KEY).replace(/<x[^>]*>/g, version); }
  // 2026-10-17: an explicit hash stops later installation-signal flips from
  // re-defaulting an empty hash to Driver Settings mid-session; replaceState
  // fires no hashchange and adds no history entry.
  private pinSetupRoute(): void {
    if (window.location.hash === '') {
      window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search + '#/setup');
    }
  }
  private async installDriver(): Promise<void> {
    if (await this.ctx.sds.installDriver()) {
      this.pinSetupRoute();
      this.ctx.startup.invalidate();
      this.ctx.checks.clear();
      await this.resetVerified();
      await this.ctx.dialog.message(t('Driver files installed'), t('Start SteamVR and connect your headset through Steam Link to verify the driver.'));
    }
  }
  private async cleanSettings(): Promise<void> {
    this.pinSetupRoute();
    await this.ctx.startup.refresh();
    if (this.ctx.startup.status()?.steamvrRunning !== false) return;
    const report = await this.ctx.sds.cleanSettings(this.ctx.appSetting);
    if (!report) return;
    this.ctx.startup.invalidate();
    this.ctx.checks.clear();
    await this.ctx.checks.refresh();
    const needsAttention = report.outcome !== 'complete';
    await this.ctx.dialog.message(needsAttention ? t('Defaults restored with notices') : t('Defaults restored'),
      t('Driver tuning and app preferences were reset. The installed driver, saved profiles, and backups were kept. Start SteamVR to apply driver defaults.'),
      [t('Recovery backup') + ': ' + report.backupPath,
        t('Files reset') + ': ' + report.resetFiles.length,
        t('SteamVR settings restored') + ': ' + report.restoredSettings,
        ...(report.unresolvedItems ?? []), ...report.warnings].join('\n'));
  }
  private async uninstallDriver(): Promise<void> {
    this.pinSetupRoute();
    await this.ctx.startup.refresh();
    if (this.ctx.startup.status()?.steamvrRunning !== false) return;
    // Confirmation and cancellation must precede all settings writes.
    if (await this.ctx.sds.uninstallDriver(this.ctx.appSetting)) {
      this.ctx.startup.invalidate();
      this.ctx.checks.clear();
      const report = this.ctx.sds.lastUninstallReport;
      const incomplete = report?.outcome === 'incomplete';
      await this.ctx.dialog.message(incomplete ? t('Uninstall needs another step')
        : report?.outcome === 'attention-required' ? t('Driver removed with notices') : t('Uninstall complete'),
        incomplete ? t('Some items could not be removed. Driver and settings were removed; retry uninstall to finish the remaining cleanup.')
          : t('The driver, active settings, saved profiles and recovery backups were removed. Your next installation will start with defaults.'),
        report ? [t('Locations removed') + ': ' + report.removedPaths.length,
          t('SteamVR settings restored') + ': ' + report.restoredSettings,
          ...((report.preservedPaths ?? []).length ? [t('Kept locations') + ':', ...report.preservedPaths] : []),
          ...(report.unresolvedItems ?? []), ...report.warnings].join('\n') : undefined);
    }
  }

  render() {
    const { sds, checks, startup } = this.ctx;
    const busy = sds.installingDriver() || checks.checking() || startup.launching();
    const cleanupBlocked = busy || startup.status()?.steamvrRunning !== false;
    return html`${pageIntro(t('Setup'), t('Set up Galaxy XR for SteamVR, tune tracking, and adjust the streamed image.'))}
      ${this.sectionCardsFor([
        sectionHeading(t('Set up your headset')),
        this.renderSetup(),
        sectionHeading(t('Settings check')),
        this.renderSettingsCheck(),
        sectionHeading(t('Restore or remove')),
        ...(startup.status()?.steamvrRunning !== false ? [
          statusMessage('info', t('Close SteamVR first'), startup.status()?.steamvrRunning
            ? t('Restore defaults and uninstall are available when SteamVR is closed.')
            : t('Confirm that SteamVR is stopped before changing the installation.'),
            html`<fluent-button ?disabled=${busy} @click=${() => this.checkSettings()}>${t('Check again')}</fluent-button>`),
        ] : []),
        html`<div class="maintenance-grid">
          <article class="action-card">
            <h3>${t('Restore defaults')}</h3>
            <p>${t('Reset driver tuning and app preferences. Keep the installation, saved profiles, and backups.')}</p>
            <fluent-button ?disabled=${cleanupBlocked} @click=${() => this.cleanSettings()}>${t('Restore defaults')}</fluent-button>
          </article>
          <article class="action-card danger-zone">
            <h3>${statusIcon('warning')}${t('Uninstall driver')}</h3>
            <p>${t('Remove the driver, active settings, saved profiles and recovery backups.')}</p>
            <fluent-button appearance="primary" class="danger" ?disabled=${cleanupBlocked}
              @click=${() => this.uninstallDriver()}>${t('Uninstall driver')}</fluent-button>
          </article>
        </div>`,
      ])}`;
  }
}
