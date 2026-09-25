// Driver Settings page, ported from
// src/app/pages/driver-settings/driver-settings.component.html (Angular era).
// All conditionals, vendor gates, advanced-mode gates, retired velocity mode
// escape hatches, and reset scopes are preserved.
import { html, LitElement, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';
import { css } from 'lit';
import { BasePage, fieldRow, noteRow, sectionRow, fieldStyles } from './page-base';
import { t, tHtml } from '../locale/i18n';
import '../ui/controls';
import './driver-banner';
import './system-ready';
@customElement('app-driver-settings-page')
export class DriverSettingsPage extends BasePage {
  static styles = [fieldStyles, css`
    :host { display: block; padding: 0 1rem 2rem 1rem; }
    .calibration-banner { background: #4a3b00; border: 1px solid #a08500; color: #ffe97a; border-radius: 6px; padding: 8px 14px; margin: 8px 0; }
    .rgb-control { display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; }
    .rgb-control span { opacity: 0.75; font-size: 90%; }
    .note-inline { opacity: 0.75; font-size: 0.9rem; }
  `];

  private async changeIdentitySetting(key: 'nativeIdentity' | 'vrlinkHeadsetProfile', enabled: boolean, control: HTMLElement & { checked: boolean }): Promise<void> {
    const gx = this.ctx.galaxy.galaxyXr;
    // Do not change the persisted setting unless the user confirms. Explicit
    // saved false values remain respected; hiding advanced controls never resets them.
    if (!enabled && gx[key] !== false) {
      const confirmed = await this.ctx.dialog.confirm(t('Turn off Galaxy XR recognition?'),
        t('This setting is normally left on. Turning it off can make SteamVR show Unknown or the headset identity supplied by a patched Steam Link app instead of Galaxy XR. Restart SteamVR afterwards. Continue?'), t('Turn off'), 'danger');
      if (!confirmed) {
        // The adapter has already toggled locally; explicitly restore it on Cancel.
        control.checked = !!gx[key];
        this.requestUpdate();
        return;
      }
    }
    gx[key] = enabled;
    this.ctx.galaxy.save();
    this.requestUpdate();
  }

  private async changeBaseline(enabled: boolean, control: HTMLElement & { checked: boolean }): Promise<void> {
    const galaxy = this.ctx.galaxy;
    control.checked = galaxy.baselineRequested;
    if (enabled && !galaxy.baselineRequested) {
      if (galaxy.imageEnhancementsEnabled) return;
      const confirmed = await this.ctx.dialog.confirm(t('Reset picture adjustments and enable the baseline?'),
        t('This resets color, sharpening, lens correction and other image-processing adjustments to their defaults. It also turns off the custom shader for this headset. Your controller, tracking and stream-quality settings are kept. Turning the baseline off later will not restore the previous picture adjustments. Back up your settings or export your lens profile first. Continue?'),
        t('Reset and enable'), 'danger');
      if (!confirmed) return;
    }
    await galaxy.setSdr10Baseline(enabled);
    control.checked = galaxy.baselineRequested;
    this.requestUpdate();
  }

  render() {
    const galaxy = this.ctx.galaxy;
    if (!galaxy.settings) return html``;
    const settings = galaxy.settings;
    const defaults = galaxy.defaults;
    const advanced = galaxy.advancedMode;
    const vendor = galaxy.vendor;
    const c = this.ctx;
    const save = () => { galaxy.save(); this.requestUpdate(); };

    const body: TemplateResult[] = [html`
      <app-driver-enable-banner .ctx=${this.ctx}></app-driver-enable-banner>
      ${galaxy.calibrationActive() ? html`<div class="calibration-banner">
        Calibration modes are active. Turn them off before normal play, or use Advanced Mode to adjust them.
        <button type="button" @click=${() => { galaxy.stopCalibration(); this.requestUpdate(); }}>${t('Stop calibration')}</button>
      </div>` : html``}
      ${noteRow(t('Headset and controller identity changes apply after restarting SteamVR.'))}
    `];

    // ---------------- Headset ----------------
    body.push(
      sectionRow(t('Headset'), this.section('headset'), 0, () => this.toggleSection('headset')),
    );
    if (this.section('headset')) {
      const gx = galaxy.galaxyXr;
      body.push(
        ...(advanced ? [fieldRow(t('Galaxy XR Native Identity'), html`<app-switch .checked=${!!gx.nativeIdentity} @change=${(e: CustomEvent) => { void this.changeIdentitySetting('nativeIdentity', e.detail, e.currentTarget as HTMLElement & { checked: boolean }); }}></app-switch>`, {
          tip: "Keep this on so SteamVR identifies the headset as Galaxy XR and uses its device icons. Turning it off can show Unknown or the identity provided by a patched Steam Link app instead. Restart SteamVR after changing it.\n\nEnabled by default. Sets OpenVR model/manufacturer and named device-icon properties to the Galaxy XR identity and resources. With this disabled the native identity shim does not replace the identity reported by Steam Link; a patched APK may report a different headset. The vrlink Headset Profile is a separate switch. Explicit saved Off values are preserved. Restart SteamVR after changing identity.",
        })] : []),
        fieldRow(t('Native Render Resolution'), html`<app-switch .checked=${!!gx.nativeResolution} @change=${(e: CustomEvent) => { gx.nativeResolution = e.detail; save(); }}></app-switch>`, {
          tip: t("Ask SteamVR to render at the Galaxy XR's native per-eye size. This improves the requested resolution but can increase GPU load. Restart SteamVR to apply it.\n\nRequests 3552 × 3840 per eye without forcing a refresh rate. Your selected refresh rate, including 75 Hz, is preserved. renderWidth, renderHeight, overrideRenderWidth, and overrideRenderHeight are written to driver_vrlink, where VRLink reads the tuning settings. With vrlink Headset Profile On, the same values are also copied to vrlink_xrvst2ue, vrlink_Oculus Quest Pro and vrlink_PICO 4 Pro. Previous refresh-rate overrides are restored only when still journal-owned and unchanged; explicit displayFrequency extra keys remain under your control. Each section's original values are journaled independently. Turning this off restores only unchanged journal-owned resolution values; external edits are preserved."),
        }),
        ...(advanced ? [fieldRow(t('vrlink Headset Profile'), html`<app-switch .checked=${!!gx.vrlinkHeadsetProfile} @change=${(e: CustomEvent) => { void this.changeIdentitySetting('vrlinkHeadsetProfile', e.detail, e.currentTarget as HTMLElement & { checked: boolean }); }}></app-switch>`, {
          tip: t("Keep this on to keep settings copies under the supported Steam Link headset identities. Stream tuning is written to driver_vrlink with this switch on or off. Requires a SteamVR restart.\n\nEnabled by default. Stream size and bandwidth, render overrides, diagnostics, and supported extra vrlink keys always use driver_vrlink. On also mirrors those settings and capability requests to vrlink_xrvst2ue, vrlink_Oculus Quest Pro and vrlink_PICO 4 Pro before connection. Recognized Quest Pro and PICO 4 Pro identities select VRLink's built-in capabilities; this SteamVR build bypasses their per-model capability sections. Profile copies alone therefore do not prove that capability requests were consumed. Off releases journal-owned tuning copies and preserves the original-model capability destination (xrvst2ue fallback); an active SDR 10-bit baseline can still request capabilities there. Each destination keeps its own recovery record. Driver enable/block keys and SteamVR global settings retain their required sections. Restart/reconnect and inspect driver_vrlink.txt to verify effective settings."),
        })] : []),
      );
      if (advanced || !gx.nativeIdentity || !gx.vrlinkHeadsetProfile) {
        body.push(noteRow(html`<span class="warn-color" role="note">${t('Keep Galaxy XR Native Identity and vrlink Headset Profile enabled for normal use. Turning either off can stop SteamVR recognizing the headset as Galaxy XR: it may show Unknown or the identity supplied by your patched Steam Link app. Restart SteamVR after changing either setting.')}</span>`));
      }
      body.push(
        fieldRow(t('SDR 10-bit baseline'), html`<app-switch
          .checked=${galaxy.baselineRequested}
          .disabled=${galaxy.imageModeChanging() || (!galaxy.baselineRequested && galaxy.imageEnhancementsEnabled)}
          @change=${(e: CustomEvent<boolean>) => { void this.changeBaseline(e.detail, e.currentTarget as HTMLElement & { checked: boolean }); }}></app-switch>`, {
          tip: t("Request a neutral 10-bit SDR picture. Enabling this resets image-processing adjustments to their defaults and turns Image Enhancements off. Switch Image Enhancements off in App Settings before enabling the baseline. You can then enable Image Enhancements in App Settings after accepting the image-quality warning. Restart SteamVR and reconnect after changing it.\n\nThe reset covers color/brightness, sharpening, FXAA, dither, black-floor correction, distortion curves/maps, eye alignment, dimming, calibration and video-color metadata. Controller motion, tracking, stream quality, bitrate and encoder presets are not reset. The custom shader target for this headset is turned off to avoid a conflicting color path. Previous picture adjustments are not restored when the baseline is disabled; export or back up first. The same capability request is mirrored to vrlink_xrvst2ue, vrlink_Oculus Quest Pro and vrlink_PICO 4 Pro with vrlink Headset Profile On, otherwise it uses the previous vrlink_<original model> destination. Recognized Quest Pro and PICO 4 Pro identities use VRLink's built-in capabilities instead of these per-model requests. Stream tuning is separately written to driver_vrlink. Each section's original values are tracked independently by the recovery journal. A request does not prove the live codec: restart/reconnect and check driver_vrlink.txt for Using 10bit mode: 1."),
        }),
      );
      if (galaxy.baselineRequested) {
        body.push(noteRow(html`<strong>${galaxy.imageEnhancementsEnabled ? t('SDR 10-bit and Image Enhancements are both on. Image quality may be reduced.') : t('SDR 10-bit baseline is on. Image Enhancements is off by default.')}</strong>
          ${t('Enable Image Enhancements in App Settings if you accept the risk of reduced image quality. Picture adjustments reset when the baseline is enabled; switching it off does not restore them.')}
          ${t('Restart SteamVR and reconnect to apply the 10-bit request.')}`));
        if (galaxy.sdr10BaselineConflict()) {
          body.push(noteRow(html`<span class="warn-color" role="alert">${t('An external setting has enabled a custom shader for this headset, so the neutral baseline is not active. Turn the baseline off and on to reset picture adjustments and clear this conflict.')}</span>`));
        }
      } else if (galaxy.imageEnhancementsEnabled) {
        body.push(noteRow(html`<strong>${t('Turn Image Enhancements off before enabling SDR 10-bit baseline.')}</strong>
          <a href="#/app-settings">${t('Open App Settings')}</a>
          ${t('Enabling the baseline resets picture adjustments to their defaults.')}`));
      } else {
        body.push(noteRow(t('Enabling SDR 10-bit baseline resets image-processing adjustments to their defaults and keeps Image Enhancements off. Back up custom picture settings first.')));
      }
      if (galaxy.imageModeError()) body.push(noteRow(html`<span class="mode-error" role="alert">${galaxy.imageModeError()}</span>`));
    }

    // ---------------- Controllers ----------------
    body.push(
      sectionRow(t('Controllers'), this.section('controllers'), 0, () => this.toggleSection('controllers')),
    );
    if (this.section('controllers')) {
      const gx = galaxy.galaxyXr;
      if (vendor) {
        body.push(
          fieldRow(t('Official Controller Input Profile'), html`<app-switch .checked=${!!gx.nativeInputProfile} @change=${(e: CustomEvent) => { gx.nativeInputProfile = e.detail; save(); }}></app-switch>`, {
            tip: "Use the Galaxy XR controller button layout and default game bindings. Restart SteamVR after changing it; some games still use a compatible fallback layout.\n\nUses the official Steam Link Galaxy XR input profile: real button layout in the bindings UI, official default and per-app bindings, and correct grip/aim/tip poses for held items. Games without a native Galaxy XR binding see the controllers as Index controllers. Requires a SteamVR restart.",
          }),
        );
        if (gx.nativeInputProfile) {
          body.push(
            fieldRow(t('Grip Touch From Grip Pressure'), html`
              <app-switch .checked=${!!gx.synthesizeGripTouch} @change=${(e: CustomEvent) => { gx.synthesizeGripTouch = e.detail; save(); }}></app-switch>
              <app-number .value=${gx.gripTouchThreshold ?? 0.03} min="0.005" max="0.5" step="0.005" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { gx.gripTouchThreshold = e.detail; save(); } }}></app-number>
            `, {
              tip: "Treat a light grip press as touching the grip sensor. This helps games that expect a separate touch signal from controllers that do not supply one.\n\nSteam Link sends no capacitive state for the grip (only its pressure), so the official profile's grip touch never lit. On: the driver creates /input/grip/touch and drives it from the grip value. The threshold is the grip value that counts as touched (release at half of it); lower feels more like a touch sensor but resting fingers may trigger it.",
              reset: {
                can: gx.synthesizeGripTouch === false || (gx.gripTouchThreshold !== undefined && gx.gripTouchThreshold != 0.03),
                on: () => { gx.synthesizeGripTouch = true; gx.gripTouchThreshold = 0.03; save(); },
              },
            }),
          );
        }
        body.push(
          fieldRow(t('Controller Model Size'), html`<app-number .value=${gx.renderModelScale ?? 1.15} min="0.5" max="2" step="0.01" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { gx.renderModelScale = e.detail; save(); } }}></app-number>`, {
            tip: "Change the size of the controller model shown in VR. This affects its appearance, not tracking scale or the size of your hands.\n\nUniform scale for the controller models. The official assets measure about 124x63mm while the physical controller is about 145x70mm; 1.15 (default) overlays the real shell in SteamVR Home. Scales the visible model only (geometry, button and stick pivots). Pose anchors, hand skeleton and game hand meshes are never scaled, so this cannot change hand size in games. Applied live within about a second. 1.0 = stock assets.",
          }),
          fieldRow(t('Official Pose Components'), html`<app-switch .checked=${!!gx.officialComponents} @change=${(e: CustomEvent) => { gx.officialComponents = e.detail; save(); }}></app-switch>`, {
            tip: "Use the official controller grip, aim, and tip positions. This changes how held objects and pointing rays line up with the controller.\n\nUse Samsung's official pose points (Game Link's render model: OpenXR grip/aim, dashboard laser tip, handgrip, base), rebased into our grip-convention frame so each named pose lands on the same physical spot as under Game Link. Only affects bindings that select a named pose (OpenXR games, the dashboard laser, /pose/handgrip bindings) - never raw, so SteamVR Home keeps the stock behavior.",
          }),
        );
      }

      // ---------- Controller Fix ----------
      body.push(
        sectionRow(t('Controller Fix'), this.section('ctrlFix'), 1, () => this.toggleSection('ctrlFix')),
      );
      if (this.section('ctrlFix')) {
        if (vendor && galaxy.rootSetting?.galaxyXr) {
          body.push(
            fieldRow(t('Grip Convention'), html`
              <app-switch .checked=${!!gx.gripConvention} ?disabled=${!!gx.controllerBypass} @change=${(e: CustomEvent) => { gx.gripConvention = e.detail; save(); }}></app-switch>
              ${gx.controllerBypass ? html`<span class="note-inline">controller bypass is on</span>` : html``}
            `, {
              tip: "Adjust the grip-pose convention for games whose held objects look tilted or misplaced. Compare with a known-good game before changing other offsets.\n\nShifts the raw streamed controller pose (22° pitch, 5 cm) into SteamVR's grip convention so held objects sit where games expect them and the official pose components land on the right spots. Recommended on. Turn off only if a Steam Link build already reports a grip-convention pose and the controllers sit visibly wrong.",
              reset: { can: gx.gripConvention === false, on: () => { gx.gripConvention = true; save(); } },
            }),
          );
        }

        // Controller Fix Mode (velocityFixMode) with retired-mode escape hatch
        const modeOptions = [
          { value: 'off', label: 'Off' },
          { value: 'kalman', label: 'Kalman' },
          { value: 'kalmanCA', label: 'Kalman CA (recommended)' },
        ];
        if (advanced && settings.graveyardEnable) {
          for (const m of ['classic', 'full', 'derive', 'kalmanCAM']) modeOptions.push({ value: m, label: galaxy.retiredVelocityModeLabels[m] ?? m });
        } else if (galaxy.isRetiredVelocityMode(settings.velocityFixMode)) {
          modeOptions.push({ value: settings.velocityFixMode, label: galaxy.retiredVelocityModeLabels[settings.velocityFixMode] ?? settings.velocityFixMode });
        }
        body.push(
          fieldRow(t('Controller Fix Mode'), html`
            <app-select .value=${settings.velocityFixMode} .options=${modeOptions} @change=${(e: CustomEvent) => { settings.velocityFixMode = e.detail; save(); }}></app-select>
          `, {
            tip: settings.graveyardEnable ? galaxy.velocityFixTipFull : galaxy.velocityFixTip,
            reset: { can: settings.velocityFixMode != defaults.velocityFixMode, on: () => galaxy.reset('velocityFixMode') },
          }),
        );

        if (advanced && (settings.velocityFixMode == 'kalman' || settings.velocityFixMode == 'kalmanCAM')) {
          body.push(
            fieldRow(t('Kalman Tuning (accel m/s², pos mm, ang accel, ori deg, lead ms)'), html`
              <span>A</span><app-number .value=${settings.kalmanProcessAccel} step="10" min="1" max="2000" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanProcessAccel = e.detail; save(); } }}></app-number>
              <span>P</span><app-number .value=${settings.kalmanPosNoiseMm} step="0.5" min="0.2" max="20" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanPosNoiseMm = e.detail; save(); } }}></app-number>
              <span>W</span><app-number .value=${settings.kalmanProcessAngAccel} step="50" min="10" max="20000" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanProcessAngAccel = e.detail; save(); } }}></app-number>
              <span>O</span><app-number .value=${settings.kalmanOriNoiseDeg} step="0.1" min="0.05" max="10" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanOriNoiseDeg = e.detail; save(); } }}></app-number>
              <span>L</span><app-number .value=${settings.kalmanLeadMs} step="5" min="0" max="50" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanLeadMs = e.detail; save(); } }}></app-number>
            `, {
              tip: "Choose how controller motion is smoothed and predicted. Start with the normal defaults; advanced filter parameters can trade steadiness for lag or overshoot.\n\nFor the Kalman velocity mode: a single estimator produces position, rotation, velocity and spin together, the same architecture native lighthouse controllers use. A adjusts the responsiveness: higher trusts your motion more (snappier throws, a bit noisier), lower trusts smoothness (calmer hands, slight lag). W does the same for rotation: responsiveness of the spin estimator. P/O are the sensor noise floors. L leads the reported position to counter streaming latency.",
              reset: {
                can: settings.kalmanProcessAccel != defaults.kalmanProcessAccel || settings.kalmanPosNoiseMm != defaults.kalmanPosNoiseMm || settings.kalmanProcessAngAccel != defaults.kalmanProcessAngAccel || settings.kalmanOriNoiseDeg != defaults.kalmanOriNoiseDeg || settings.kalmanLeadMs != defaults.kalmanLeadMs,
                on: () => { galaxy.reset('kalmanProcessAccel'); galaxy.reset('kalmanPosNoiseMm'); galaxy.reset('kalmanProcessAngAccel'); galaxy.reset('kalmanOriNoiseDeg'); galaxy.reset('kalmanLeadMs'); },
              },
            }),
          );
        }

        if (advanced && (settings.velocityFixMode == 'kalmanCA')) {
          body.push(
            fieldRow(t('Kalman CA Tuning (jerk m/s³, ang jerk, pos mm, ori deg, lead ms)'), html`
              <span>J</span><app-number .value=${settings.kalmanCaJerk} step="50" min="1" max="50000" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanCaJerk = e.detail; save(); } }}></app-number>
              <span>Wj</span><app-number .value=${settings.kalmanCaAngJerk} step="250" min="50" max="500000" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanCaAngJerk = e.detail; save(); } }}></app-number>
              <span>P</span><app-number .value=${settings.kalmanCaPosNoiseMm} step="0.5" min="0.2" max="20" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanCaPosNoiseMm = e.detail; save(); } }}></app-number>
              <span>O</span><app-number .value=${settings.kalmanCaOriNoiseDeg} step="0.1" min="0.05" max="10" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanCaOriNoiseDeg = e.detail; save(); } }}></app-number>
              <span>L</span><app-number .value=${settings.kalmanLeadMs} step="5" min="0" max="50" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanLeadMs = e.detail; save(); } }}></app-number>
            `, {
              tip: "Use a motion filter that also estimates acceleration. It can change throwing behavior and responsiveness; compare carefully with the normal filter.\n\nThe constant-acceleration state tracks a changing speed estimate rather than treating every speed change as noise. It can reduce lag in some motions but can also change overshoot and throwing behavior; compare it with the normal filter. J (jerk noise) adjusts responsiveness: higher follows faster changes, lower is calmer. Wj is the rotation equivalent. P/O are sensor-noise settings. L leads the report to compensate for timing delay.",
              reset: {
                can: settings.kalmanCaJerk != defaults.kalmanCaJerk || settings.kalmanCaAngJerk != defaults.kalmanCaAngJerk || settings.kalmanCaPosNoiseMm != defaults.kalmanCaPosNoiseMm || settings.kalmanCaOriNoiseDeg != defaults.kalmanCaOriNoiseDeg || settings.kalmanLeadMs != defaults.kalmanLeadMs,
                on: () => { galaxy.reset('kalmanCaJerk'); galaxy.reset('kalmanCaAngJerk'); galaxy.reset('kalmanCaPosNoiseMm'); galaxy.reset('kalmanCaOriNoiseDeg'); galaxy.reset('kalmanLeadMs'); },
              },
            }),
          );
        }

        if (advanced && (settings.velocityFixMode == 'kalmanCAM')) {
          body.push(
            fieldRow(t('Kalman CA Magnitude Channel (jerk m/s³, decay τ ms)'), html`
              <span>J</span><app-number .value=${settings.kalmanCaMagJerk} step="50" min="1" max="50000" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanCaMagJerk = e.detail; save(); } }}></app-number>
              <span>τ</span><app-number .value=${settings.kalmanCaMagAccelTauMs} step="25" min="20" max="10000" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanCaMagAccelTauMs = e.detail; save(); } }}></app-number>
            `, {
              tip: "Adjust how strongly the older acceleration-based mode contributes to reported speed. This only affects the filter modes described below.\n\nCA-Magnitude mode: everything about the standard Kalman mode stays identical (calm direction, the A/P/W/O/L tuning above, duplicate handling), except the fast magnitude channel becomes a constant-acceleration estimator. J (jerk) is its responsiveness: higher follows the throw ramp harder. The decay bounds phantom speed across repeated-sample coasts (~150ms matches a real throw's acceleration duration). Success looks like Throw Strength Trim converging to 1.0.",
              reset: {
                can: settings.kalmanCaMagJerk != defaults.kalmanCaMagJerk || settings.kalmanCaMagAccelTauMs != defaults.kalmanCaMagAccelTauMs,
                on: () => { galaxy.reset('kalmanCaMagJerk'); galaxy.reset('kalmanCaMagAccelTauMs'); },
              },
            }),
          );
        }

        if (advanced && (settings.velocityFixMode == 'kalman')) {
          body.push(
            fieldRow(t('Kalman Throw Strength (source / fast accel / scale / spin scale)'), html`
              <app-select .value=${settings.kalmanMagSource} .options=${[
                { value: 'state', label: 'Calm state (default)' },
                { value: 'fast', label: 'Fast estimator (recommended at low A)' },
              ]} @change=${(e: CustomEvent) => { settings.kalmanMagSource = e.detail; save(); }}></app-select>
              <span>FA</span><app-number .value=${settings.kalmanMagAccel} step="10" min="1" max="2000" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanMagAccel = e.detail; save(); } }}></app-number>
              <span>S</span><app-number .value=${settings.kalmanMagScale} step="0.05" min="0.25" max="4" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanMagScale = e.detail; save(); } }}></app-number>
              <span>Sa</span><app-number .value=${settings.kalmanAngMagScale} step="0.05" min="0.25" max="4" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanAngMagScale = e.detail; save(); } }}></app-number>
            `, {
              tip: "Scale the controller speeds sent to games. 1 leaves the speed unchanged; other values can change throwing strength and rotational movement.\n\nFixes weak throws at low Accel without giving up the calm direction. S/Sa globally scale reported speed. Leave at 1 unless a specific title needs it.",
              reset: {
                can: settings.kalmanMagSource != defaults.kalmanMagSource || settings.kalmanMagAccel != defaults.kalmanMagAccel || settings.kalmanMagScale != defaults.kalmanMagScale || settings.kalmanAngMagScale != defaults.kalmanAngMagScale,
                on: () => { galaxy.reset('kalmanMagSource'); galaxy.reset('kalmanMagAccel'); galaxy.reset('kalmanMagScale'); galaxy.reset('kalmanAngMagScale'); },
              },
            }),
          );
        }

        if (advanced && galaxy.isKalmanMode()) {
          body.push(
            sectionRow(t('Kalman Advanced Settings'), this.section('kalmanAdv'), 2, () => this.toggleSection('kalmanAdv')),
          );
          if (this.section('kalmanAdv')) {
            if (advanced && (settings.velocityFixMode == 'kalmanCA')) {
              body.push(
                fieldRow(t('Kalman CA Accel Decay τ (ms)'), html`
                  <span>τ</span><app-number .value=${settings.kalmanCaAccelTauMs} step="25" min="20" max="10000" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanCaAccelTauMs = e.detail; save(); } }}></app-number>
                `, {
                  tip: "Set how quickly the filter stops trusting an earlier acceleration estimate. Shorter persistence can reduce overshoot but changes the feel of motion.\n\nThe acceleration state decays toward zero with this time constant (Singer model). It bounds phantom speed during repeated-sample coasts and abrupt stops.",
                  reset: { can: settings.kalmanCaAccelTauMs != defaults.kalmanCaAccelTauMs, on: () => galaxy.reset('kalmanCaAccelTauMs') },
                }),
              );
            }
            if (advanced && (settings.velocityFixMode == 'kalmanCA' || settings.velocityFixMode == 'kalmanCAM')) {
              body.push(
                fieldRow(t('Exact Covariance Transition (A/B)'), html`<app-switch .checked=${!!settings.kalmanCaExactCov} @change=${(e: CustomEvent) => { settings.kalmanCaExactCov = e.detail; save(); }}></app-switch>`, {
                  tip: "Try an experimental acceleration model with a matching noise calculation. Leave it off unless you are comparing filter behavior deliberately.\n\nExperiment: propagate the filter's uncertainty with the same Singer transition the state prediction actually uses, instead of the simpler approximation. Makes the filter's self-model consistent, which matters most at low Accel Decay tau values (in CA-Magnitude mode it applies to the fast magnitude channel). Changes effective gains slightly, so NIS and the J/P/O tuning shift a little; off reproduces the previously tuned behavior exactly.",
                  reset: { can: settings.kalmanCaExactCov != defaults.kalmanCaExactCov, on: () => galaxy.reset('kalmanCaExactCov') },
                }),
              );
            }
            body.push(
              fieldRow(t('Kalman Angular Velocity Frame'), html`
                <app-select .value=${String(settings.kalmanAngularOutFrame ?? '')} .options=${[
                  { value: 'body', label: 'Body - controller-local (default)' },
                  { value: 'world', label: 'World - previous behaviour' },
                  { value: 'zero', label: 'Zero - diagnostic' },
                ]} @change=${(e: CustomEvent) => { (settings as any).kalmanAngularOutFrame = e.detail; save(); }}></app-select>
              `, {
                tip: "Choose how controller rotation speed is reported. The wrong coordinate convention can change throwing or aiming behavior; use the default unless testing.\n\nFrame the reported angular velocity is expressed in. Body (default, field-verified 2026-08-24): SteamVR's motion prediction rotates about controller-local axes, so this is what it expects. World: the previous behaviour, which made horizontal sword swings pitch up at the peak of the swing. Zero: diagnostic only - no angular prediction, laggier rotation.",
                reset: { can: (settings as any).kalmanAngularOutFrame != defaults.kalmanAngularOutFrame, on: () => galaxy.reset('kalmanAngularOutFrame' as any) },
              }),
              fieldRow(t('Kalman Loss Coast (ms)'), html`<app-number .value=${settings.kalmanLossCoastMs} step="50" min="0" max="1000" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanLossCoastMs = e.detail; save(); } }}></app-number>`, {
                tip: "Choose how long controller movement may continue briefly after tracking is lost. Longer coasting can hide interruptions but can also move the controller incorrectly.\n\nWhen the controller briefly leaves tracking (hand out of camera view), the stream freezes the hand in place with zero velocity until it is seen again. For up to this many ms of tracking loss, the driver instead keeps the hand moving along the filter's last known motion (with the usual acceleration decay so it cannot run away).",
                reset: { can: settings.kalmanLossCoastMs != defaults.kalmanLossCoastMs, on: () => galaxy.reset('kalmanLossCoastMs') },
              }),
              fieldRow(t('Kalman Duplicate-Sample Handling'), html`
                <app-select .value=${settings.kalmanDupMode} .options=${[
                  { value: 'off', label: 'Off - repeats believed (smooth, slight drag)' },
                  { value: 'coast', label: 'Coast - extrapolate through repeats (field-rejected)' },
                  { value: 'drop', label: 'Drop - repeats never happened (honest gaps)' },
                  { value: 'soft', label: 'Soft - repeats distrusted by the scale below' },
                  { value: 'age', label: 'Age - repeats distrusted by hand speed x age (no scale, no speed gate)' },
                ]} @change=${(e: CustomEvent) => { settings.kalmanDupMode = e.detail; save(); }}></app-select>
              `, {
                tip: "Choose how repeated tracking samples are handled. The default avoids treating a repeated sample as fresh movement.\n\nThe streamer repeats the last pose when fresh tracking hasn't arrived, about 2 of 3 samples during fast throws. Soft (recommended): repeats are processed but distrusted by the scale below. Off: repeats are trusted fully, slight speed drag. Age: distrust grows with speed and time since the last fresh sample. Coast and Drop are not recommended. Sustained repeats are always treated as genuine stillness.",
                reset: { can: settings.kalmanDupMode != defaults.kalmanDupMode, on: () => galaxy.reset('kalmanDupMode') },
              }),
              fieldRow(t('Kalman Duplicate Distrust Scale (Soft mode)'), html`<app-number .value=${settings.kalmanDupRScale} step="1" min="1" max="100" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanDupRScale = e.detail; save(); } }}></app-number>`, {
                tip: "Set how little the filter trusts a repeated tracking sample. Larger values make duplicate samples have less influence.\n\nOnly used when duplicate handling is Soft. A repeated sample is a true position of unknown age, so its honest uncertainty at hand speed is far above the sensor floor; this multiplies the measurement noise for detected repeats. 1 behaves exactly like Off; the default of 3 halves motion jitter with no measured cost; 6 and above re-create Coast's rejected snap character. Repeats sustained past the run cap are always accepted at full weight.",
                reset: { can: settings.kalmanDupRScale != defaults.kalmanDupRScale, on: () => galaxy.reset('kalmanDupRScale') },
              }),
              fieldRow(t('Kalman Device-Time Measurements'), html`<app-switch .checked=${!!settings.kalmanDeviceTime} @change=${(e: CustomEvent) => { settings.kalmanDeviceTime = e.detail; save(); }}></app-switch>`, {
                tip: "Use timestamps supplied with controller tracking rather than assuming every update is new. This can improve timing when sample delivery is uneven.\n\nThe streamer stamps every hand pose with WHEN it was actually true (poseTimeOffset). When this is on, the filter uses the device's own timestamps for its time steps and quietly discards out-of-order samples. Leave on.",
                reset: { can: settings.kalmanDeviceTime != defaults.kalmanDeviceTime, on: () => galaxy.reset('kalmanDeviceTime') },
              }),
              fieldRow(t('Position-Freeze Protection (3dof Fallback)'), html`<app-switch .checked=${!!settings.kalmanPosFreeze3dof} @change=${(e: CustomEvent) => { settings.kalmanPosFreeze3dof = e.detail; save(); }}></app-switch>`, {
                tip: "Detect when controller position has stopped updating even if other tracking data still changes. This helps avoid treating a tracking freeze as real stillness.\n\nDetects the tracker's position-only loss: the position payload freezes while the quaternion keeps moving (fast or occluded hand falling back to IMU orientation). When detected, the stale position stays distrusted for the whole freeze instead of being adopted after the duplicate-run cap, and orientation keeps tracking live in every duplicate-handling mode. Fixes the hand parking a meter away while still rotating with the wrist, then teleporting back.",
                reset: { can: settings.kalmanPosFreeze3dof != defaults.kalmanPosFreeze3dof, on: () => galaxy.reset('kalmanPosFreeze3dof') },
              }),
            );
          }
        }
      }

      // ---------- Controllers Advanced ----------
      if (advanced) {
        body.push(
          sectionRow(t('Controllers Advanced'), this.section('ctrlAdv'), 1, () => this.toggleSection('ctrlAdv')),
        );
        if (this.section('ctrlAdv')) {
          if (vendor) {
            body.push(
              fieldRow(t('Controller Bypass'), html`<app-switch .checked=${!!gx.controllerBypass} @change=${(e: CustomEvent) => { gx.controllerBypass = e.detail; save(); }}></app-switch>`, {
                tip: "Bypass this driver's controller adjustments while leaving the headset path active. Use this to compare with Steam Link's controller behavior.\n\nLeave the streamed controllers exactly as vrlink presents them: no Galaxy XR identity, models or icons, no official input profile or pose components, no grip convention, no offsets. Kalman is not part of the bypass; use Controller Fix Mode to turn it off. For A/B tests against stock, or if you only want the image processing. Identity and input profile changes take effect after a SteamVR restart.",
                reset: { can: !!gx.controllerBypass, on: () => { gx.controllerBypass = false; save(); } },
              }),
            );
          }
          if (galaxy.controllerSettings) {
            const cs = galaxy.controllerSettings;
            const cd = galaxy.controllerDefaults;
            body.push(
              sectionRow(t('Controller Offsets'), this.section('ctrlOffsets'), 2, () => this.toggleSection('ctrlOffsets')),
            );
            if (this.section('ctrlOffsets')) {
              body.push(
                fieldRow(t('Rotation Offset (deg)'), html`
                  <span>X</span><app-number .value=${cs.rotationOffsetDeg.x} step="1" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { cs.rotationOffsetDeg.x = e.detail; save(); } }}></app-number>
                  <span>Y</span><app-number .value=${cs.rotationOffsetDeg.y} step="1" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { cs.rotationOffsetDeg.y = e.detail; save(); } }}></app-number>
                  <span>Z</span><app-number .value=${cs.rotationOffsetDeg.z} step="1" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { cs.rotationOffsetDeg.z = e.detail; save(); } }}></app-number>
                `, {
                  tip: "Rotate both controller poses by the same adjustment. Use small changes to align virtual objects with how you hold the controllers.\n\nLocal frame rotation added to both controllers' poses, live reloaded. X (pitch): positive tilts the top back toward you. Typical useful range 5-20. Y = yaw, Z = roll.",
                  reset: {
                    can: cs.rotationOffsetDeg.x != cd.rotationOffsetDeg.x || cs.rotationOffsetDeg.y != cd.rotationOffsetDeg.y || cs.rotationOffsetDeg.z != cd.rotationOffsetDeg.z,
                    on: () => galaxy.resetControllers('rotationOffsetDeg'),
                  },
                }),
                fieldRow(t('Position Offset (cm)'), html`
                  <span>X</span><app-number .value=${cs.positionOffsetCm.x} step="0.5" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { cs.positionOffsetCm.x = e.detail; save(); } }}></app-number>
                  <span>Y</span><app-number .value=${cs.positionOffsetCm.y} step="0.5" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { cs.positionOffsetCm.y = e.detail; save(); } }}></app-number>
                  <span>Z</span><app-number .value=${cs.positionOffsetCm.z} step="0.5" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { cs.positionOffsetCm.z = e.detail; save(); } }}></app-number>
                `, {
                  tip: "Move both controller poses by the same adjustment. This shifts the virtual controller relative to the tracked hand position.\n\nLocal frame position offset added to both controllers' poses, live reloaded. Use when the virtual grip point sits offset from where the controller feels like it is (beam parallel but displaced): Z = forward/back along the controller, Y = up/down, X = sideways.",
                  reset: {
                    can: cs.positionOffsetCm.x != cd.positionOffsetCm.x || cs.positionOffsetCm.y != cd.positionOffsetCm.y || cs.positionOffsetCm.z != cd.positionOffsetCm.z,
                    on: () => galaxy.resetControllers('positionOffsetCm'),
                  },
                }),
                fieldRow(t('Mirror Offsets For Right Hand'), html`<app-switch .checked=${!!cs.mirrorOffsetsForRightHand} @change=${(e: CustomEvent) => { cs.mirrorOffsetsForRightHand = e.detail; save(); }}></app-switch>`, {
                  tip: "Apply one controller alignment to both hands with left/right mirroring. Turn this off to tune each hand independently.\n\nAuthor the offsets above for the LEFT controller and mirror them for the right hand. Position X and rotations Y/Z flip sign. Pitch and position Y/Z stay the same. Turn it off if the hands need different corrections.",
                }),
              );
              if (!cs.mirrorOffsetsForRightHand && cs.left && cs.right) {
                body.push(
                  noteRow(t('Per-hand trims are added on top of the shared offsets above, unmirrored. Turn Mirror Offsets on to hide them and drive both hands from one set.')),
                  fieldRow(t('Left Hand Rotation Offset (deg)'), html`
                    <span>X</span><app-number .value=${cs.left!.rotationOffsetDeg.x} step="1" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { cs.left!.rotationOffsetDeg.x = e.detail; save(); } }}></app-number>
                    <span>Y</span><app-number .value=${cs.left!.rotationOffsetDeg.y} step="1" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { cs.left!.rotationOffsetDeg.y = e.detail; save(); } }}></app-number>
                    <span>Z</span><app-number .value=${cs.left!.rotationOffsetDeg.z} step="1" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { cs.left!.rotationOffsetDeg.z = e.detail; save(); } }}></app-number>
                  `, {
                    tip: "Rotate only the left controller's pose. Use this when the two hands need different alignment.\n\nPer-hand trim applied UNMIRRORED to the left controller only, after the shared offsets above. Use when the two hands need different corrections (the tracked origins are not exact mirror images). X = pitch, Y = yaw, Z = roll. Live reloaded.",
                    reset: { can: galaxy.handOffsetsDirty('left'), on: () => galaxy.resetHandOffsets('left') },
                  }),
                  fieldRow(t('Left Hand Position Offset (cm)'), html`
                    <span>X</span><app-number .value=${cs.left!.positionOffsetCm.x} step="0.5" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { cs.left!.positionOffsetCm.x = e.detail; save(); } }}></app-number>
                    <span>Y</span><app-number .value=${cs.left!.positionOffsetCm.y} step="0.5" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { cs.left!.positionOffsetCm.y = e.detail; save(); } }}></app-number>
                    <span>Z</span><app-number .value=${cs.left!.positionOffsetCm.z} step="0.5" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { cs.left!.positionOffsetCm.z = e.detail; save(); } }}></app-number>
                  `, {
                    tip: "Move only the left controller's pose. The offsets change where held objects appear, not the tracking space itself.\n\nPer-hand position trim for the left controller only, unmirrored, applied after the shared offsets. Same axes as the shared Position Offset: Z = along the controller, Y = up/down, X = sideways.",
                  }),
                  fieldRow(t('Right Hand Rotation Offset (deg)'), html`
                    <span>X</span><app-number .value=${cs.right!.rotationOffsetDeg.x} step="1" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { cs.right!.rotationOffsetDeg.x = e.detail; save(); } }}></app-number>
                    <span>Y</span><app-number .value=${cs.right!.rotationOffsetDeg.y} step="1" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { cs.right!.rotationOffsetDeg.y = e.detail; save(); } }}></app-number>
                    <span>Z</span><app-number .value=${cs.right!.rotationOffsetDeg.z} step="1" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { cs.right!.rotationOffsetDeg.z = e.detail; save(); } }}></app-number>
                  `, {
                    tip: "Rotate only the right controller's pose. Use this when the two hands need different alignment.\n\nPer-hand trim applied UNMIRRORED to the right controller only, after the shared offsets above. Use when the two hands need different corrections (the tracked origins are not exact mirror images). X = pitch, Y = yaw, Z = roll. Live reloaded.",
                    reset: { can: galaxy.handOffsetsDirty('right'), on: () => galaxy.resetHandOffsets('right') },
                  }),
                  fieldRow(t('Right Hand Position Offset (cm)'), html`
                    <span>X</span><app-number .value=${cs.right!.positionOffsetCm.x} step="0.5" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { cs.right!.positionOffsetCm.x = e.detail; save(); } }}></app-number>
                    <span>Y</span><app-number .value=${cs.right!.positionOffsetCm.y} step="0.5" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { cs.right!.positionOffsetCm.y = e.detail; save(); } }}></app-number>
                    <span>Z</span><app-number .value=${cs.right!.positionOffsetCm.z} step="0.5" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { cs.right!.positionOffsetCm.z = e.detail; save(); } }}></app-number>
                  `, {
                    tip: "Move only the right controller's pose. The offsets change where held objects appear, not the tracking space itself.\n\nPer-hand position trim for the right controller only, unmirrored, applied after the shared offsets. Same axes as the shared Position Offset: Z = along the controller, Y = up/down, X = sideways.",
                  }),
                );
              }
            }
            if (vendor) {
              body.push(
                sectionRow(t('Pointer Tip Offset'), this.section('tipOffset'), 2, () => this.toggleSection('tipOffset')),
              );
              if (this.section('tipOffset')) {
                body.push(
                  fieldRow(t('Pointer Tip Trim X (cm)'), html`<app-number .value=${gx.aimTrimXCm ?? 0} min="-5" max="5" step="0.25" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { gx.aimTrimXCm = e.detail; save(); } }}></app-number>`, {
                    tip: "Move the controller's aiming tip sideways. The adjustment is mirrored between the left and right hand.\n\nMeasured correction of the dashboard pointer origin (tip and OpenXR aim together). Sideways; mirrored for the right hand. Applies live.",
                  }),
                  fieldRow(t('Pointer Tip Trim Y (cm)'), html`<app-number .value=${gx.aimTrimYCm ?? -1} min="-5" max="5" step="0.25" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { gx.aimTrimYCm = e.detail; save(); } }}></app-number>`, {
                    tip: "Move the controller's aiming tip vertically. This adjusts the ray or tip position used by compatible games.\n\nUp/down correction of the pointer origin. If the pointer emanates 1 cm above the real tip, set -1.",
                  }),
                  fieldRow(t('Pointer Tip Trim Z (cm)'), html`<app-number .value=${gx.aimTrimZCm ?? 1} min="-5" max="5" step="0.25" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { gx.aimTrimZCm = e.detail; save(); } }}></app-number>`, {
                    tip: "Move the controller's aiming tip forward or backward. This adjusts the ray or tip position used by compatible games.\n\nAlong-the-controller correction of the pointer origin. Positive moves it back toward the wrist: if the pointer starts 1 cm beyond the real tip, set +1.",
                  }),
                );
              }
            }
          }
        }
      }
    }

    return html`<app-system-ready .ctx=${this.ctx}>${this.sectionCardsFor(body)}</app-system-ready>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'app-driver-settings-page': DriverSettingsPage;
  }
}
