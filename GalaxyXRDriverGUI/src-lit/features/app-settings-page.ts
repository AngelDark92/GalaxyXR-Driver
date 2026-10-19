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
import { applyUiScale, normalizeUiScale, UI_SCALE_MAX, UI_SCALE_MIN, UI_SCALE_STEP } from '../ui/ui-scale';
import '../ui/controls';

@customElement('app-app-settings-page')
export class AppSettingsPage extends BasePage {
  static styles = [fieldStyles, css`
    :host { display: block; padding: 0 1rem 2rem 1rem; }
    .scale-value { min-width: 3.5ch; font-variant-numeric: tabular-nums; color: var(--colorNeutralForeground2); }
  `];

  private uiScaleError = '';

  // 2026-10-19: applying and saving are separate steps. A drag emits one
  // change per step, so the window previews live while the debounced writer
  // keeps a single saved value; a platform refusal stays visible here.
  private async setUiScale(value: number): Promise<void> {
    const scale = normalizeUiScale(value);
    const error = await applyUiScale(scale, true);
    this.uiScaleError = error ?? '';
    void this.ctx.appSetting.save({ ...this.ctx.appSetting.values(), uiScale: scale });
    this.requestUpdate();
  }

  private async setImageEnhancements(enabled: boolean, control: HTMLElement & { checked: boolean }): Promise<void> {
    const galaxy = this.ctx.galaxy;
    control.checked = galaxy.imageEnhancementsEnabled;
    if (galaxy.imageModeChanging()) return;
    if (!driverAvailable(this.ctx.sds.driverInstalled(), this.ctx.sds.driverState())) return;
    await galaxy.setImageEnhancements(enabled);
    control.checked = galaxy.imageEnhancementsEnabled;
    this.requestUpdate();
  }

  render() {
    const { appSetting, galaxy, sds, checks } = this.ctx;
    const installed = driverAvailable(sds.driverInstalled(), sds.driverState());
    const known = !!this.ctx.dss.values() && !this.ctx.dss.readFileError();
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
      ...(this.uiScaleError ? [statusMessage('error', t('Interface scale could not be applied'), this.uiScaleError)] : []),
      fieldRow(t('Theme'), html`
        <app-select .value=${appSetting.values().colorScheme} .options=${[
          { value: 'system', label: t('System') }, { value: 'dark', label: t('Dark') }, { value: 'light', label: t('Light') },
        ]} @change=${(e: CustomEvent) => save({ colorScheme: e.detail as AppSetting['colorScheme'] })}></app-select>
      `, {
        tip: t("Light, dark, or follow your Windows theme.\n\nValue: colorScheme (gui-settings.json). GUI-only presentation preference.") }),
      fieldRow(t('Interface Scale'), html`
        <app-slider .value=${normalizeUiScale(appSetting.values().uiScale)}
          .min=${UI_SCALE_MIN} .max=${UI_SCALE_MAX} .step=${UI_SCALE_STEP}
          @change=${(e: CustomEvent) => { void this.setUiScale(e.detail); }}></app-slider>
        <span class="scale-value" aria-hidden="true">${normalizeUiScale(appSetting.values().uiScale)}%</span>
      `, {
        tip: t("Scales the whole Companion window: text, controls, dialogs and popups. Drag to preview; the value saves as it changes.\n\nValue: uiScale (gui-settings.json). GUI-only presentation preference.") }),
      settingFieldRow('image-enhancements', html`
        <app-switch .known=${known} .checked=${galaxy.imageEnhancementsEnabled}
          .disabled=${!installed || !known || galaxy.imageModeChanging() || busy}
          @change=${(e: CustomEvent<boolean>) => { void this.setImageEnhancements(e.detail, e.currentTarget as HTMLElement & { checked: boolean }); }}></app-switch>
      `, {
        tip: t("Master switch for the color, sharpening and lens-correction tools. Off restores the neutral picture without changing your saved values.\n\nValue: streamFrame.enable (settings.json). Driver side — the effective color-processing gate.") }),
      ...(!installed ? [statusMessage('info', t('Install the driver to enable image controls'), t('Appearance and advanced preferences are available now.'),
        html`<a href="#/setup">${t('Open Setup')}</a>`)] : []),
      settingFieldRow('advanceMode', html`
        <app-switch .known=${!appSetting.readFileError()} .disabled=${!!appSetting.readFileError()}
          .checked=${!!appSetting.values().advanceMode} @change=${(e: CustomEvent) => save({ advanceMode: e.detail })}></app-switch>
      `, {
        tip: t("Reveals the advanced and encoder controls. Hiding them never changes their values.\n\nValue: advanceMode (gui-settings.json). GUI-only visibility fence.") }),
      noteRow(t('Show encoder, controller, and calibration controls. Hiding them keeps their values.')),
      settingFieldRow('devUpdates', html`
        <app-switch .known=${!appSetting.readFileError()} .disabled=${!!appSetting.readFileError()}
          .checked=${!!appSetting.values().devUpdates} @change=${(e: CustomEvent) => save({ devUpdates: e.detail })}></app-switch>
      `, {
        tip: t("Also offer pre-release developer builds when checking for updates.\n\nValue: devUpdates (gui-settings.json). GUI-only update-channel preference.") }),
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
      `, { tip: t('Show the Debug tab and allow its selected diagnostic overlays and logging. Turning this off stops diagnostic effects while keeping their saved selections. Black-point correction and encoder compatibility/rate tuning remain active. Requires a SteamVR restart and reconnect for the Steam Link debug overlay.') }),
    ];
    if (appSetting.values().advanceMode || this.revealAdvanced) {
      body.push(sectionGroup(t('Advanced'), 1));
      body.push(fieldRow(t('Update Install Style'), html`
        <app-select .value=${appSetting.values().updateMode} .options=${[
          { value: 'replace', label: t('Replace') }, { value: 'rewrite', label: t('Rewrite') },
        ]} @change=${(e: CustomEvent) => save({ updateMode: e.detail as AppSetting['updateMode'] })}></app-select>
      `, {
        tip: t("How the updater installs a new build of the Companion app.\n\nValue: updateMode (gui-settings.json). GUI-only preference.\n\nValue: debugMode (settings.json). Driver side — unlocks the Debug tab's diagnostics and the SteamVR-side Steam Link debug keys.") }));
    }
    return this.sectionCardsFor(body);
  }
}
