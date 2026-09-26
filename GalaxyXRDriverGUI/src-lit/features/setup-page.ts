// Headset installation, runtime verification, and cleanup (2026-09-22).
// Always available, including before installation and after uninstall. These
// thin views retain the existing safe service actions and mounted-only polling.
import { html, nothing, type TemplateResult, css } from 'lit';
import { customElement } from 'lit/decorators.js';
import { BasePage, fieldRow, noteRow, sectionHeading, fieldStyles } from './page-base';
import { t } from '../locale/i18n';
import { galaxyXRDriverName } from '../environment';
import '../ui/controls';
import './system-ready';
import './driver-banner';

// Keep the existing locale-specific inline version placeholder intact.
const INSTALL_KEY = 'Install <x id="INTERPOLATION" equiv-text="{{updateInfo.currentVersion}}"/>';

@customElement('app-setup-page')
export class SetupPage extends BasePage {
  static styles = [fieldStyles, css`
    :host { display: block; padding: 0 1rem 2rem 1rem; }
    .setup-content h3 { margin: 14px 0 6px; font-size: 1rem; }
    .setup-content p { margin: 8px 0; overflow-wrap: anywhere; }
    .complete { color: var(--colorPaletteGreenForeground1); }
    .required, .check-warning { color: var(--colorPaletteDarkOrangeForeground1); }
    .setup-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0; }
    .check-result, .check-details { margin: 12px 0; padding: 12px 16px; border: 1px solid var(--colorNeutralStroke2); border-radius: 6px; background: var(--colorNeutralBackground1); }
    .check-result p { margin: 6px 0; overflow-wrap: anywhere; }
    .check-error { color: var(--colorPaletteRedForeground1); overflow-wrap: anywhere; }
    .check-table-scroll { overflow: auto; max-height: 26rem; }
    summary { cursor: pointer; padding: 4px 0; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 0.9em; }
    th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--colorNeutralStroke2); }
    th { position: sticky; top: 0; background: var(--colorNeutralBackground2); }
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
    // Verification latch (2026-09-23): once SteamVR has confirmed the driver
    // initialized, the check stays verified until the next install or
    // uninstall clears the flag — closing SteamVR or restarting the app must
    // not force a re-verification.
    const verified = this.ctx.appSetting.values()?.driverVerified === true;
    const initialized = installed && enabled !== false && (verified || status?.driverInitialized === true);
    const installLabel = !installed ? t('Install Driver') : updateInfo?.installAvailable
      ? this.installText(updateInfo.currentVersion) : t('Re-Install Driver');
    return html`<div class="setup-content">
      <h3 class=${installed ? 'complete' : 'required'}>${installed ? '✓' : '1.'} ${t('Install the driver')}</h3>
      <p>${installed ? t('Driver files are installed. The next step verifies that SteamVR can actually run them.')
        : t('Install from this page to make the driver settings tabs available. You can use Clean Settings below before installing.')}</p>
      <p><strong>${t('Installed Driver Version')}:</strong> ${version ?? (sds.driverState() === 'unknown'
        ? t('Unable to verify installation') : sds.driverState() === 'checking' ? t('Checking…') : t('Not installed'))}</p>
      ${sds.driverCheckError() ? html`<p class="check-error" role="alert">${sds.driverCheckError()}</p>` : nothing}
      <div class="setup-actions">
        <button class="primary" type="button" ?disabled=${busy} @click=${() => this.installDriver()}>${installLabel}</button>
        ${!installed ? html`<button type="button" ?disabled=${busy}
          @click=${() => this.checkSettings()}>${t('Check installation')}</button>` : nothing}
      </div>
      <h3 class=${initialized ? 'complete' : 'required'}>${initialized ? '✓' : '2.'} ${t('Start SteamVR and verify the driver')}</h3>
      <p>${t('Starting SteamVR initializes the driver and its runtime settings. Connect your Galaxy XR through Steam Link, then wait here for initialization to be confirmed. Having the driver files installed is not enough.')}</p>
      <div role="status" aria-live="polite" class=${initialized ? 'complete' : 'required'}>
        <strong>${!installed ? t('Install the driver first.') : initialized ? t('Driver initialization verified in SteamVR.')
          : status?.steamvrRunning ? t('SteamVR is open — driver verification is not complete.') : t('Required next step: Start SteamVR.')}</strong>
        ${installed && status ? html`<p>${t(status.detail)}</p>` : nothing}
      </div>
      ${startup.error() ? html`<p class="check-error" role="alert">${startup.error()}</p>` : nothing}
      ${installed && enabled === false ? html`<p class="required">${t('This driver is disabled or blocked in SteamVR. Close SteamVR and enable the driver below before starting it again.')}</p>` : nothing}
      ${installed ? html`<div class="setup-actions">
        <button class="primary" type="button" ?disabled=${busy || enabled === false || !!status?.steamvrRunning}
          @click=${() => startup.start()}>${startup.launching() ? t('Starting SteamVR…') : t('Start SteamVR')}</button>
        <button type="button" ?disabled=${busy} @click=${() => this.checkSettings()}>${t('Check driver now')}</button>
      </div><p class="note">${t('If SteamVR is already open after an install or reset, close it completely and start it again. When initialization is verified, check the picture and controller tracking in the headset; this app cannot verify those visually for you.')}</p>` : nothing}
      ${fieldRow(t('Restart Compositor'), html`<button type="button" ?disabled=${busy || !installed}
        @click=${() => sds.restartCompositor()}>${t('Restart Compositor')}</button>`, {
        tip: t("Restart SteamVR's display process to try to fix display problems without closing the game. Your headset view may briefly disappear; save anything important first.\n\nRestarting the compositor can fix some issues and allows changing various settings like refresh rate without restarting SteamVR or the game."),
      })}
      <p class="note"><strong>${t('Last reported driver version (not live verification)')}:</strong>
        ${dis.values()?.driverVersion ?? t('No runtime information')}
        ${sds.driverVersionMismatch() ? html`<span class="required" role="img" aria-label=${t('Warning')}>⚠</span>` : nothing}
      </p>
      ${!sds.steamVRinstalled() || (installed && (!sds.systemReady() || enabled === false))
        ? html`<app-driver-troubleshooter .ctx=${this.ctx}></app-driver-troubleshooter>` : nothing}
      ${installed ? html`<app-driver-enable-banner .ctx=${this.ctx}></app-driver-enable-banner>` : nothing}
    </div>`;
  }

  private renderSettingsCheck(): TemplateResult {
    const report = this.ctx.checks.report();
    const busy = this.ctx.checks.checking() || this.ctx.sds.installingDriver() || this.ctx.startup.launching();
    return html`
      <div class="setup-actions">
        <button class="btn primary" type="button" ?disabled=${busy} @click=${() => this.checkSettings()}>
          ${this.ctx.checks.checking() ? t('Checking…') : t('Check installation')}
        </button></div>
      <div class="field"><div class="note">${t('Reads the configuration files again and synchronizes every setting toggle, including hidden advanced controls. It does not reset settings or restart SteamVR. Missing keys use their defaults; unreadable files are reported as unknown.')}</div></div>
      ${report ? html`
        <div class="check-result" role="status" aria-live="polite">
          <p>${t('Last check')}: ${new Date(report.checkedAt).toLocaleString()} · ${report.checks.length} ${t('boolean settings checked')}</p>
          <p>${t('Driver enabled in SteamVR')}: ${report.driverEnabled === undefined ? t('Unknown') : report.driverEnabled ? t('On') : t('Off')}</p>
          ${report.errors.map(error => html`<p class="check-error">${error}</p>`)}
          ${report.warnings.map(warning => html`<p class="check-warning">${warning}</p>`)}
          <p class="note">${t('This verifies saved configuration, not live hardware behavior. Changes that require a SteamVR restart may not be active yet. Runtime telemetry is the last reported state, not proof that SteamVR is currently running.')}</p>
        </div>
        <details class="check-details"><summary>${t('Show all checked settings')}</summary>
          <div class="check-table-scroll"><table>
            <thead><tr><th>${t('File')}</th><th>${t('Setting')}</th><th>${t('State')}</th><th>${t('Value source')}</th></tr></thead>
            <tbody>${report.checks.map(check => html`<tr>
              <td>${check.source}</td><td><code>${check.key}</code></td>
              <td>${check.enabled ? t('On') : t('Off')}</td>
              <td>${check.origin === 'stored' ? t('Saved value') : t('Default value')}</td>
            </tr>`)}</tbody>
          </table></div>
        </details>
      ` : nothing}`;
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
      this.ctx.startup.status.subscribe(() => { this.rememberVerified(); this.requestUpdate(); }),
      this.ctx.startup.error.subscribe(() => this.requestUpdate()),
      this.ctx.startup.launching.subscribe(() => this.requestUpdate()),
    ];
    void this.pollRuntime(++this.pollGeneration);
  }

  /** Persist the verification latch when SteamVR confirms driver
   * initialization (2026-09-23). Fires from every refresh path that ends in
   * a status change: Start SteamVR, Check driver now, and the 2s poll. */
  private rememberVerified(): void {
    if (this.ctx.startup.status()?.driverInitialized !== true) return;
    const appSetting = this.ctx.appSetting;
    if (appSetting.values()?.driverVerified === true) return;
    void appSetting.save({ ...appSetting.values(), driverVerified: true });
  }

  /** Clear the latch: a fresh install or an uninstall must be re-verified in
   * SteamVR (2026-09-23). No-op when already cleared. */
  private async resetVerified(): Promise<void> {
    const appSetting = this.ctx.appSetting;
    if (appSetting.values()?.driverVerified !== true) return;
    await appSetting.save({ ...appSetting.values(), driverVerified: false });
  }

  disconnectedCallback(): void {
    ++this.pollGeneration;
    if (this.runtimeTimer !== undefined) clearTimeout(this.runtimeTimer);
    for (const unsubscribe of this.runtimeUnsubs) unsubscribe();
    this.runtimeUnsubs = [];
    super.disconnectedCallback();
  }

  private installText(version: string): string {
    return t(INSTALL_KEY).replace(/<x[^>]*>/g, version);
  }

  private async installDriver(): Promise<void> {
    if (await this.ctx.sds.installDriver()) {
      this.ctx.startup.invalidate();
      this.ctx.checks.clear();
      await this.resetVerified(); // new install needs a fresh SteamVR verification (2026-09-23)
      await this.ctx.dialog.message(t('Driver files installed'), t('Next, use Start SteamVR on Setup and connect your headset through Steam Link. Wait for Driver initialization verified in SteamVR before considering setup complete.'));
    }
  }

  private async cleanSettings(): Promise<void> {
    await this.ctx.startup.refresh();
    if (this.ctx.startup.status()?.steamvrRunning !== false) return;
    const report = await this.ctx.sds.cleanSettings(this.ctx.appSetting);
    if (!report) return;
    this.ctx.startup.invalidate();
    this.ctx.checks.clear();
    await this.resetVerified();
    await this.ctx.checks.refresh();
    const details = `${report.resetFiles.length} files reset or refreshed. ${report.restoredSettings} recorded SteamVR settings restored. ${report.removedIdentityKeys.length} older identity settings removed.`;
    await this.ctx.dialog.message(t('Settings cleaned'), details
      + `\nRecovery backup: ${report.backupPath}`
      + '\nSaved profile files, installed drivers, bindings and room setup were kept. Active profile selections and adjustments were reset.'
      + '\n' + t('After installation, start SteamVR from Setup to initialize and verify the driver again.')
      + (report.warnings.length ? `\n\n${report.warnings.join('\n')}` : ''));
  }

  private async uninstallDriver(): Promise<void> {
    await this.ctx.startup.refresh();
    if (this.ctx.startup.status()?.steamvrRunning !== false) return;
    // A successful uninstall leaves settings writes suspended, so the latch
    // must be cleared BEFORE it runs; a save afterwards would be rejected
    // (2026-09-23). gui-settings.json survives uninstall, so this sticks.
    await this.resetVerified();
    if (await this.ctx.sds.uninstallDriver()) {
      this.ctx.startup.invalidate();
      this.ctx.checks.clear();
      const report = this.ctx.sds.lastUninstallReport;
      const details = report
        ? `${report.removedPaths.length} locations removed. ${report.restoredSettings} SteamVR settings restored.`
          + (report.legacyReset ? '\nOlder settings without an original-value record were reset; exact historical values were unavailable.' : '')
          + (report.warnings.length ? `\n${report.warnings.join('\n')}` : '')
        : t('Successfully uninstalled the driver');
      this.ctx.dialog.message(t('Uninstall complete'), details);
    }
  }

  render() {
    const { sds, checks, startup } = this.ctx;
    const busy = sds.installingDriver() || checks.checking() || startup.launching();
    const cleanupBlocked = busy || startup.status()?.steamvrRunning !== false;
    return this.sectionCardsFor([
      sectionHeading(t('Galaxy XR Companion')),
      noteRow(t('A standalone SteamVR vendor driver for the Samsung Galaxy XR over Steam Link. It gives the headset and its controllers their native identity, models and bindings in SteamVR, corrects controller tracking and throw velocity, and adds the ability to process the streamed image (color, sharpening, distortion correction) before it is encoded.')),
      sectionHeading(t('Set up your headset')),
      this.renderSetup(),
      sectionHeading(t('Installation and settings check')),
      this.renderSettingsCheck(),
      sectionHeading(t('Cleanup')),
      fieldRow(t('Settings'), html`<button type="button" ?disabled=${cleanupBlocked}
        @click=${() => this.cleanSettings()}>${t('Clean Settings')}</button>`),
      noteRow(t('Close SteamVR first. Resets the driver settings of the Driver Settings, Image Settings and Distortion Profile tabs to defaults and cleans recognized old identity settings, including the Quest Pro and PICO 4 Pro profiles used by patched Steam Link. App preferences, such as the color scheme, are kept. Recorded SteamVR overrides are restored safely; unrelated SteamVR preferences, room setup, bindings, driver enable/block choices and saved profile files are kept. A recovery backup is made first. Available even before installing the driver.')),
      noteRow(t('Clean Settings leaves NVENC Tap and encoder overrides off for stock NVIDIA encoding. Other driver settings return to their defaults. Enable NVENC Tap and reset the encoder controls to use the installation defaults again.')),
      ...(startup.status()?.steamvrRunning !== false ? [noteRow(startup.status()?.steamvrRunning
        ? t('SteamVR is running. Close it completely before cleaning settings or uninstalling the driver.')
        : t('Cleanup is unavailable until SteamVR is confirmed stopped. Use Check installation to retry.'))] : []),
      ...(sds.driverInstalled() ? [
        fieldRow(t('Driver'), html`<button type="button" ?disabled=${cleanupBlocked}
          @click=${() => this.uninstallDriver()}>${t('Uninstall Driver')}</button>`),
        noteRow(t('Uninstall the driver and restore recorded SteamVR settings. Close SteamVR first.')),
      ] : []),
    ]);
  }
}
