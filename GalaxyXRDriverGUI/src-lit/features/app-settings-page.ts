// App preferences remain available before driver installation. Picture controls
// use the same state actions as Driver Settings; no second write path exists.
import { html, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';
import { css } from 'lit';
import { BasePage, fieldRow, noteRow, sectionHeading, fieldStyles } from './page-base';
import { t } from '../locale/i18n';
import type { AppSetting } from '../domain/types';
import { driverAvailable } from '../domain/navigation';
import '../ui/controls';

@customElement('app-app-settings-page')
export class AppSettingsPage extends BasePage {
  private warningPending = false;
  static styles = [fieldStyles, css`
    :host { display: block; padding: 0 1rem 2rem 1rem; }
    .installation-note { padding: 0.75rem 1rem; border-inline-start: 4px solid var(--colorBrandStroke1); background: var(--colorNeutralBackground3); }
    .check-error { color: var(--colorPaletteRedForeground1); overflow-wrap: anywhere; }
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
          t('Combining SDR 10-bit with Image Enhancements can reduce image quality, introduce banding or artifacts, and change colors. The picture will no longer be a neutral baseline. The 10-bit stream request stays enabled, but does not guarantee that processing preserves 10-bit precision. Only continue if you understand this tradeoff and want to experiment. You can turn Image Enhancements off at any time to return to the neutral baseline.'),
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
      sectionHeading(t('Application preferences')),
      ...(appSetting.readFileError() ? [noteRow(t('App preferences could not be verified. Correct the file or its permissions, then use Check installation on Setup.'))] : []),
      ...(galaxy.imageModeError() ? [noteRow(html`<span class="mode-error" role="alert">${galaxy.imageModeError()}</span>`)] : []),
      fieldRow(t('Color Scheme'), html`
        <app-select .value=${appSetting.values().colorScheme} .options=${[
          { value: 'system', label: t('System') }, { value: 'dark', label: t('Dark') }, { value: 'light', label: t('Light') },
        ]} @change=${(e: CustomEvent) => save({ colorScheme: e.detail as AppSetting['colorScheme'] })}></app-select>
      `),
      fieldRow(t('Image Enhancements'), html`
        <app-switch .known=${known} .checked=${galaxy.imageEnhancementsEnabled}
          .disabled=${!installed || !known || this.warningPending || galaxy.imageModeChanging() || busy}
          @change=${(e: CustomEvent<boolean>) => { void this.setImageEnhancements(e.detail, e.currentTarget as HTMLElement & { checked: boolean }); }}></app-switch>
      `),
      noteRow(baseline
        ? html`<strong>${galaxy.imageEnhancementsEnabled
            ? t('SDR 10-bit and Image Enhancements are both on. Image quality may be reduced.')
            : t('SDR 10-bit baseline is on. Enabling Image Enhancements requires accepting an image-quality warning.')}</strong>
            ${t('Turn Image Enhancements off to use the neutral baseline. Your picture adjustments are kept.')}`
        : html`${t('Enable color adjustments, sharpening and distortion correction. Turn Image Enhancements off before enabling SDR 10-bit baseline. Enabling the baseline resets picture adjustments to their defaults.')}`),
      ...(!installed ? [noteRow(t('Install the driver before changing Image Enhancements. App preferences can still be changed.'))] : []),
      fieldRow(t('Advanced Mode'), html`
        <app-switch .known=${!appSetting.readFileError()} .disabled=${!!appSetting.readFileError()}
          .checked=${!!appSetting.values().advanceMode} @change=${(e: CustomEvent) => save({ advanceMode: e.detail })}></app-switch>
      `),
      noteRow(t('Show encoder tuning, detailed controller controls, calibration tools, and diagnostic sections. Hiding these controls keeps their current values.')),
    ];
    if (appSetting.values().advanceMode) {
      body.push(fieldRow(t('Update Mode'), html`
        <app-select .value=${appSetting.values().updateMode} .options=${[
          { value: 'replace', label: t('Replace') }, { value: 'rewrite', label: t('Rewrite') },
        ]} @change=${(e: CustomEvent) => save({ updateMode: e.detail as AppSetting['updateMode'] })}></app-select>
      `));
    }
    return this.sectionCardsFor(body);
  }
}
