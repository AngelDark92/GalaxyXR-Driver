// App preferences remain available before driver installation. Picture controls
// use the same state actions as Driver Settings; no second write path exists.
import { html, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';
import { css } from 'lit';
import { BasePage, settingFieldRow, fieldRow, noteRow, sectionHeading, sectionGroup, fieldStyles } from './page-base';
import { t } from '../locale/i18n';
import type { AppSetting } from '../domain/types';
import { driverAvailable } from '../domain/navigation';
import { pageIntro, statusMessage } from '../ui/presentation';
import '../ui/controls';

@customElement('app-app-settings-page')
export class AppSettingsPage extends BasePage {
  private warningPending = false;
  static styles = [fieldStyles, css`
    :host { display: block; padding: 0 1rem 2rem 1rem; }
  `];

  private async setImageEnhancements(enabled: boolean, control: HTMLElement & { checked: boolean }): Promise<void> {
    const galaxy = this.ctx.galaxy;
    control.checked = galaxy.imageEnhancementsEnabled;
    if (this.warningPending || galaxy.imageModeChanging()) return;
    if (!driverAvailable(this.ctx.sds.driverInstalled(), this.ctx.sds.driverState())) return;
    let qualityWarningAccepted = false;
    if (enabled && galaxy.baselineRequested) {
      this.warningPending = true;
      this.requestUpdate();
      try {
        qualityWarningAccepted = !!await this.ctx.dialog.confirm(
          t('Enable Image Enhancements with SDR 10-bit?'),
          t('Image Enhancements can cause banding, artifacts, or color changes with SDR 10-bit. The 10-bit request stays enabled, but processing may not preserve its precision.\n\nContinue only if you accept this image-quality tradeoff. Turn enhancements off to return to the neutral baseline.'),
          t('I understand — enable enhancements'), 'danger');
      } finally {
        this.warningPending = false;
        this.requestUpdate();
      }
      if (!qualityWarningAccepted) return;
    }
    await galaxy.setImageEnhancements(enabled, qualityWarningAccepted);
    control.checked = galaxy.imageEnhancementsEnabled;
    this.requestUpdate();
  }

  render() {
    const { appSetting, galaxy, sds, checks } = this.ctx;
    const installed = driverAvailable(sds.driverInstalled(), sds.driverState());
    const known = !!this.ctx.dss.values() && !this.ctx.dss.readFileError();
    const baseline = galaxy.baselineRequested;
    const busy = checks.checking() || sds.installingDriver() || galaxy.imageModeChanging();
    const save = (patch: Partial<AppSetting>) => {
      void appSetting.save({ ...appSetting.values(), ...patch });
      this.requestUpdate();
    };
    const body: TemplateResult[] = [
      pageIntro(t('App Settings'), t('Appearance and advanced controls.')),
      sectionHeading(t('Application preferences'), 0, 'app-preferences'),
      ...(appSetting.readFileError() ? [statusMessage('error', t('App preferences could not be read'), t('Check file permissions, then use Check Settings on Setup.'))] : []),
      ...(galaxy.imageModeError() ? [statusMessage('error', t('Image mode could not be changed'), galaxy.imageModeError()!)] : []),
      fieldRow(t('Color Scheme'), html`
        <app-select .value=${appSetting.values().colorScheme} .options=${[
          { value: 'system', label: t('System') }, { value: 'dark', label: t('Dark') }, { value: 'light', label: t('Light') },
        ]} @change=${(e: CustomEvent) => save({ colorScheme: e.detail as AppSetting['colorScheme'] })}></app-select>
      `),
      settingFieldRow('image-enhancements', html`
        <app-switch .known=${known} .checked=${galaxy.imageEnhancementsEnabled}
          .disabled=${!installed || !known || this.warningPending || galaxy.imageModeChanging() || busy}
          @change=${(e: CustomEvent<boolean>) => { void this.setImageEnhancements(e.detail, e.currentTarget as HTMLElement & { checked: boolean }); }}></app-switch>
      `),
      baseline ? statusMessage(galaxy.imageEnhancementsEnabled ? 'warning' : 'info',
        galaxy.imageEnhancementsEnabled ? t('SDR 10-bit with Image Enhancements') : t('SDR 10-bit baseline is on'),
        galaxy.imageEnhancementsEnabled ? t('Image processing may reduce quality. Turn enhancements off to use the neutral baseline; your adjustments are kept.')
          : t('Enabling enhancements requires accepting an image-quality warning.'))
        : noteRow(t('Enable color, sharpening, and lens correction. Turn this off before enabling the SDR 10-bit baseline, which resets picture adjustments.')),
      ...(!installed ? [statusMessage('info', t('Install the driver to enable image controls'), t('Appearance and advanced preferences are available now.'),
        html`<a href="#/setup">${t('Open Setup')}</a>`)] : []),
      settingFieldRow('advanceMode', html`
        <app-switch .known=${!appSetting.readFileError()} .disabled=${!!appSetting.readFileError()}
          .checked=${!!appSetting.values().advanceMode} @change=${(e: CustomEvent) => save({ advanceMode: e.detail })}></app-switch>
      `),
      noteRow(t('Show encoder, controller, and calibration controls. Hiding them keeps their values.')),
      settingFieldRow('devUpdates', html`
        <app-switch .known=${!appSetting.readFileError()} .disabled=${!!appSetting.readFileError()}
          .checked=${!!appSetting.values().devUpdates} @change=${(e: CustomEvent) => save({ devUpdates: e.detail })}></app-switch>
      `),
      noteRow(t('Also check for dev (pre-release) builds when checking for updates.')),
      settingFieldRow('debugMode', html`
        <app-switch .known=${known} .disabled=${!installed || !known || busy}
          .checked=${galaxy.debugMode} @change=${async (e: CustomEvent<boolean>) => {
            const control = e.currentTarget as HTMLElement & { checked: boolean };
            control.checked = galaxy.debugMode;
            const settings = this.ctx.dss.values();
            if (!settings || !installed || !known || busy) return;
            await this.ctx.dss.save({ ...settings, debugMode: e.detail });
            control.checked = galaxy.debugMode;
            this.requestUpdate();
          }}></app-switch>
      `, { tip: t('Show the Debug tab and allow its selected diagnostic overlays and logging. Turning this off stops diagnostic effects while keeping their saved selections. Black-point correction and encoder compatibility/rate tuning remain active. Requires a SteamVR restart and reconnect for the vrlink Debug Overlay.') }),
    ];
    if (appSetting.values().advanceMode || this.revealAdvanced) {
      body.push(sectionGroup(t('Advanced'), 1));
      body.push(fieldRow(t('Update Mode'), html`
        <app-select .value=${appSetting.values().updateMode} .options=${[
          { value: 'replace', label: t('Replace') }, { value: 'rewrite', label: t('Rewrite') },
        ]} @change=${(e: CustomEvent) => save({ updateMode: e.detail as AppSetting['updateMode'] })}></app-select>
      `));
    }
    return this.sectionCardsFor(body);
  }
}
