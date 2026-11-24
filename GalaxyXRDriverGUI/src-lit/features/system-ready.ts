// System readiness gate, ported from
// src/app/utilities/system-ready/system-ready.component.{ts,html}
// and driver-troubleshooter.component.{ts,html}.
// Shows the page content only when SteamVR + driver + settings are ready;
// otherwise the troubleshooting checklist with the same actions
// (install SteamVR, enable driver, retry, reset setting). Driver installation
// is linked to Setup so its single button is the only installation entry point.
import { html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { css } from 'lit';
import { interactiveStyles } from '../ui/shared-styles';
import { BasePage, fieldStyles, sectionHeading } from './page-base';
import { galaxyXRDriverName } from '../environment';
import { openUrl } from '@tauri-apps/plugin-opener';
import { t } from '../locale/i18n';
import { statusMessage } from '../ui/presentation';

@customElement('app-driver-troubleshooter')
export class DriverTroubleshooter extends BasePage {
  static styles = [fieldStyles, css`
    :host { display: block; padding: 0 1rem 1rem; }
    .read-error { font-size: 0.85rem; opacity: 0.8; overflow-wrap: anywhere; }
  `];

  @property({ type: Boolean }) wait = false;
  @property({ type: Boolean }) driverEnablePrompt = false;

  connectedCallback(): void {
    super.connectedCallback();
    const sds = this.ctx.sds;
    sds.initTask
      .catch(error => console.error('Readiness check failed', error))
      .then(() => {
        this.wait = true;
        // (2026-09-22) SteamVR detection keeps polling: it has no 'checking'
        // state, so it cannot flicker the driver row. The driver-install check
        // is on-demand only (app start, "Check installation", install flow).
        if (!sds.steamVRinstalled()) sds.pullingSteamVRinstall.start();
        this.requestUpdate();
      });

  }

  private enableDriver = async () => {
    await this.ctx.sds.enableSteamVRDriver(galaxyXRDriverName);
  };
  private installSteamVR = async () => {
    await openUrl('steam://install/250820');
  };

  render() {
    const sds = this.ctx.sds;
    const cfg = sds.steamVrConfig();
    this.driverEnablePrompt = !!cfg && !sds.getSteamVRDriverEnableState(cfg, galaxyXRDriverName);
    if (!this.wait) return html`<div class="status-badge-row" role="status"><fluent-spinner size="tiny" aria-hidden="true"></fluent-spinner>${t('Checking installation…')}</div>`;
    return this.sectionCardsFor([sectionHeading(t('System not ready')), html`
    ${statusMessage('info', t('Complete setup to use these controls'), t('Check the items below, then verify the driver on Setup.'), html`<a href="#/setup">${t('Open Setup')}</a>`)}
    ${sds.driverCheckError() ? statusMessage('error', t('Installation could not be checked'), sds.driverCheckError()!) : html``}

    <div class="field">
      <div class="title">${t('SteamVR installation')}</div>
      <div class="control">
        ${!sds.steamVRinstalled()
          ? html`<fluent-badge appearance="tint" color="warning">${t('Not installed')}</fluent-badge>
            <fluent-button appearance="primary" @click=${this.installSteamVR}>${t('Install SteamVR')}</fluent-button>`
          : html`<fluent-badge appearance="tint" color="success">${t('Installed')}</fluent-badge>`}
      </div>
    </div>

    <div class="field">
      <div class="title">${t('Driver installation')}</div>
      <div class="control">
        ${!sds.driverInstalled()
          ? html`<fluent-badge appearance="tint" color="warning">${sds.driverState() === 'unknown' ? t('Unknown') : sds.driverState() === 'checking' ? t('Checking…') : t('Not installed')}</fluent-badge>`
          : html`<fluent-badge appearance="tint" color="success">${t('Installed')}</fluent-badge>`}
      </div>
    </div>

    <div class="field">
      <div class="title">${t('Driver enabled')}</div>
      <div class="control">
        ${!cfg ? html`<fluent-badge appearance="tint" color="warning">${t('Unknown')}</fluent-badge>` : this.driverEnablePrompt
          ? html`<fluent-badge appearance="tint" color="warning">${t('Disabled')}</fluent-badge>
            ${sds.steamVRinstalled() ? html`<fluent-button appearance="primary" ?disabled=${sds.installingDriver()} @click=${this.enableDriver}>${t('Enable Driver')}</fluent-button>` : html``}`
          : html`<fluent-badge appearance="tint" color="success">${t('Enabled')}</fluent-badge>`}
      </div>
    </div>

    <div class="field">
      <div class="title">${t('Editable driver settings')}</div>
      <div class="control">
        ${!sds.settingFileInited()
          ? html`<fluent-badge appearance="tint" color="warning">${t('Unavailable')}</fluent-badge>
            <span>${t('Settings are missing or could not be loaded.')}</span>
            ${sds.driverInstalled() ? html`<fluent-button appearance="outline" ?disabled=${sds.installingDriver()} @click=${() => sds.checkDriverInstalled()}>${t('Retry')}</fluent-button>` : html``}`
          : html`<fluent-badge appearance="tint" color="success">${t('Ready')}</fluent-badge>`}
      </div>
    </div>

    <div class="field">
      <div class="title">${t('Driver settings valid')}</div>
      <div class="control">
        ${this.ctx.dss.readFileError()
          ? html`${statusMessage('error', t('Driver settings could not be read'), this.ctx.dss.readFileError()?.message)}
            ${sds.driverInstalled() ? html`<fluent-button appearance="outline" @click=${() => sds.resetDriverSetting()}>${t('Reset Setting')}</fluent-button>` : html``}`
          : html`<fluent-badge appearance="tint" color=${sds.settingFileInited() ? 'success' : 'warning'}>${sds.settingFileInited() ? t('Valid') : t('Unknown')}</fluent-badge>`}
      </div>
    </div>`]);
  }
}

@customElement('app-system-ready')
export class SystemReady extends BasePage {
  static styles = css`
    ${interactiveStyles}
    :host { display: block; }
  `;

  render() {
    const sds = this.ctx.sds;
    if (sds.systemReady()) {
      return html`<slot></slot>`;
    }
    return html`<app-driver-troubleshooter .ctx=${this.ctx}></app-driver-troubleshooter>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'app-system-ready': SystemReady;
    'app-driver-troubleshooter': DriverTroubleshooter;
  }
}
