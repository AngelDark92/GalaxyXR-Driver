// Driver Settings page, ported from
// src/app/pages/driver-settings/driver-settings.component.html (Angular era).
// All conditionals, vendor gates, advanced-mode gates, retired velocity mode
// escape hatches, and reset scopes are preserved.
import { html, LitElement, nothing, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';
import { css } from 'lit';
import { BasePage, settingFieldRow, fieldRow, noteRow, sectionRow, sectionGroup, fieldStyles, numberControl, choiceControl, sliderControl, vectorControl } from './page-base';
import { t, tHtml } from '../locale/i18n';
import { pageIntro, statusMessage, type FieldNotice } from '../ui/presentation';
import '../ui/controls';
import './driver-banner';
import './system-ready';
@customElement('app-driver-settings-page')
export class DriverSettingsPage extends BasePage {
  static styles = [fieldStyles, css`
    :host { display: block; padding: 0 1rem 2rem 1rem; }
    .rgb-control { display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; }
    .rgb-control span { opacity: 0.75; font-size: 90%; }
    .note-inline { opacity: 0.75; font-size: 0.9rem; }
    .range-control {
      display: grid; grid-template-columns: minmax(9rem, max-content) minmax(12rem, 1fr);
      align-items: center; gap: 0.75rem; width: 100%;
    }
    .range-track { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .range-track app-slider { width: 100%; flex: 0 0 auto; }
    .range-scale {
      display: flex; justify-content: space-between; gap: 0.5rem;
      color: var(--colorNeutralForeground3); font-size: 0.75rem; line-height: 1.1;
      font-variant-numeric: tabular-nums;
    }
    .link-control { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; width: 100%; }
    .link-control .range-track { flex: 1 1 12rem; }
    @container page (max-width: 700px) { .range-control { grid-template-columns: 1fr; } }
  `];

  private async changeIdentitySetting(key: 'nativeIdentity' | 'vrlinkHeadsetProfile', enabled: boolean, control: HTMLElement & { checked: boolean }): Promise<void> {
    const gx = this.ctx.galaxy.galaxyXr;
    // Do not change the persisted setting unless the user confirms. Explici
    // saved false values remain respected; hiding advanced controls never resets them.
    if (!enabled && gx[key] !== false) {
      const confirmed = await this.ctx.dialog.confirm(t('Turn off Galaxy XR recognition?'),
        t('This setting is normally left on. Turning it off can make SteamVR show Unknown or the headset identity supplied by Steam Link instead of Galaxy XR. Restart SteamVR afterwards. Continue?'), t('Turn off'), 'danger');
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

  render() {
    const galaxy = this.ctx.galaxy;
    if (!galaxy.settings) return html``;
    const settings = galaxy.settings;
    const defaults = galaxy.defaults;
    const advanced = galaxy.advancedMode || this.revealAdvanced;
    const vendor = galaxy.vendor;
    const c = this.ctx;
    const save = () => { galaxy.save(); this.requestUpdate(); };
    const controlContext = {
      codec: settings.nvencCodec ?? 0,
      forceCbr: !!settings.nvencForceCbr,
      enhancements: galaxy.imageEnhancementsEnabled,
      tap: !!settings.nvencTap,
      gripCompensation: !!settings.kalmanGripEnable,
      adaptiveDirectionLead: !!settings.kalmanDirLeadAdaptive,
      gazeAssist: (settings.kalmanGazeAssist ?? 0) > 0,
      deriveMode: settings.velocityFixMode === 'derive',
      fastMagnitude: settings.kalmanMagSource === 'fast',
      softDuplicates: settings.kalmanDupMode === 'soft',
      ofxrLogging: !!this.ctx.ofxr.preferences().logging,
    };

    const body: TemplateResult[] = [html`
      ${pageIntro(t('Driver Settings'), t('Headset identity and controller tracking.'))}
      <app-driver-enable-banner .ctx=${this.ctx}></app-driver-enable-banner>
      ${galaxy.calibrationActive() ? statusMessage('warning', t('Calibration is active'), t('Stop calibration before playing.'),
        html`<fluent-button appearance="outline" @click=${() => { galaxy.stopCalibration(); this.requestUpdate(); }}>${t('Stop calibration')}</fluent-button>`) : html``}
      <div class="status-badge-row"><fluent-badge appearance="tint" color="informative">${t('SteamVR restart required')}</fluent-badge>
        <span>${t('After changing headset or controller identity.')}</span></div>
    `];
    // ---------------- Headset ----------------
    body.push(
      sectionRow(t('Headset'), this.section('headset'), 0, () => this.toggleSection('headset'), 'headset'),
    );
    if (this.section('headset')) {
      const gx = galaxy.galaxyXr;
      const recognitionNotice: FieldNotice = {
        intent: 'warning',
        title: t('Keep Galaxy XR recognition enabled'),
        body: t('Turning off either identity option can make SteamVR show another headset or Unknown. Restart SteamVR after a change.'),
      };
      const nativeIdentityNotices = !gx.nativeIdentity ? [recognitionNotice] : [];
      const profileNotices = gx.nativeIdentity && (advanced || !gx.vrlinkHeadsetProfile) ? [recognitionNotice] : [];
      body.push(
        ...(advanced ? [settingFieldRow('galaxyXr.nativeIdentity', html`<app-switch .checked=${!!gx.nativeIdentity} @change=${(e: CustomEvent) => { void this.changeIdentitySetting('nativeIdentity', e.detail, e.currentTarget as HTMLElement & { checked: boolean }); }}></app-switch>`, {
          notices: nativeIdentityNotices,
          tip: t("Keep this on so SteamVR identifies the headset as Galaxy XR and uses its device icons. Turning it off can show Unknown or the identity reported by Steam Link instead. Restart SteamVR after changing it.\n\nEnabled by default. Sets OpenVR model/manufacturer and named device-icon properties to the Galaxy XR identity and resources. With this disabled the native identity shim does not replace the identity reported by Steam Link. The Galaxy XR Headset Profile is a separate switch. Explicit saved Off values are preserved. Restart SteamVR after changing identity.\n\nValue: galaxyXr.nativeIdentity (settings.json). Driver side — sets OpenVR model/manufacturer and device-icon properties; identity changes need a SteamVR restart."),
        })] : []),
        ...(advanced ? [settingFieldRow('galaxyXr.vrlinkHeadsetProfile', html`<app-switch .checked=${!!gx.vrlinkHeadsetProfile} @change=${(e: CustomEvent) => { void this.changeIdentitySetting('vrlinkHeadsetProfile', e.detail, e.currentTarget as HTMLElement & { checked: boolean }); }}></app-switch>`, {
          notices: profileNotices,
          tip: t("Keep this on to keep a settings copy under the Galaxy XR headset identity. Stream tuning is written to driver_vrlink with this switch on or off. Requires a SteamVR restart.\n\nEnabled by default. Stream size and bandwidth, render overrides, diagnostics, and supported extra vrlink keys always use driver_vrlink. On also writes a copy of those settings and the capability requests to vrlink_xrvst2ue before connection. Off releases journal-owned tuning copies and leaves capability requests in the original-model destination (xrvst2ue). A profile copy is a request, not proof that VRLink consumed it; verify the connection log. Each destination keeps its own recovery record. Driver enable/block keys and SteamVR global settings retain their required sections. Restart/reconnect and inspect driver_vrlink.txt to verify effective settings.\n\nValue: galaxyXr.vrlinkHeadsetProfile (settings.json). SteamVR side — journal-mirrors the vrlink tuning sections in steamvr.vrsettings."),
        })] : []),
      );
      if (!advanced) body.push(noteRow(html`${t('Headset identity controls are available in Advanced Mode.')} <a href="#/app-settings?setting=advanceMode">${t('Open App Settings')}</a>`));
      if (!advanced && (!gx.nativeIdentity || !gx.vrlinkHeadsetProfile)) {
        // The identity rows are hidden outside Advanced mode, so the warning
        // has no visible card to live in. Keep it at section level for that case.
        body.push(statusMessage('warning', t('Keep Galaxy XR recognition enabled'), t('Turning off either identity option can make SteamVR show another headset or Unknown. Restart SteamVR after a change.')));
      }
    }

    // ---------------- Controllers ----------------
    body.push(
      sectionRow(t('Controllers'), this.section('controllers'), 0, () => this.toggleSection('controllers'), 'controllers'),
    );
    if (this.section('controllers')) {
      const gx = galaxy.galaxyXr;
      body.push(
        settingFieldRow('galaxyXr.controllerBypass', html`
          <app-switch .checked=${!!gx.controllerBypass} @change=${(e: CustomEvent) => { gx.controllerBypass = e.detail; save(); }}></app-switch>
          <span class="note-inline">restart SteamVR after switching</span>
        `, {
          tip: t("Master switch for every controller feature this driver adds. On leaves the streamed controllers exactly as Steam Link presents them.\n\nNo Galaxy XR identity, models or icons, no official input profile or pose components, no grip convention, offsets or pose trims, no grip-touch synthesis, no skeleton offsets, no motion filter (all Kalman modes), no Game Link layout and no space velocity fix. The per-feature settings are kept in settings.json and return when this switch is off. Requires a SteamVR restart.\n\nValue: galaxyXr.controllerBypass (settings.json). Driver side — master disable for every controller feature; saved settings are not changed."),
          reset: { can: !!gx.controllerBypass, on: () => { gx.controllerBypass = false; save(); } },
        }),
      );
      if (gx.controllerBypass) {
        body.push(noteRow(t('All controller features are off. Steam Link controls the controllers untouched; the saved controller settings return when this switch is off.')));
      } else {
      if (vendor) {
        body.push(
          settingFieldRow('galaxyXr.nativeInputProfile', html`<app-switch .checked=${!!gx.nativeInputProfile} @change=${(e: CustomEvent) => { gx.nativeInputProfile = e.detail; save(); }}></app-switch>`, {
            tip: t("Use the Galaxy XR controller button layout and default game bindings. Restart SteamVR after changing it; some games still use a compatible fallback layout.\n\nUses the official Steam Link Galaxy XR input profile: real button layout in the bindings UI, official default and per-app bindings, and correct grip/aim/tip poses for held items. Games without a native Galaxy XR binding see the controllers as Index controllers. Requires a SteamVR restart.\n\nValue: galaxyXr.nativeInputProfile (settings.json). Driver side — official Steam Link input profile and binding paths. SteamVR restart needed."),
          }),
        );
        if (gx.nativeInputProfile) {
          body.push(
            settingFieldRow('galaxyXr.synthesizeGripTouch', html`
              <app-switch .checked=${!!gx.synthesizeGripTouch} @change=${(e: CustomEvent) => { gx.synthesizeGripTouch = e.detail; save(); }}></app-switch>
              ${numberControl('galaxyXr.gripTouchThreshold', {
                value: gx.gripTouchThreshold ?? 0.03,
                ctx: controlContext,
                label: t('Grip touch threshold'),
                onCommit: value => { gx.gripTouchThreshold = value; save(); },
              })}
            `, {
              tip: t("Treat a light grip press as touching the grip sensor. This helps games that expect a separate touch signal from controllers that do not supply one.\n\nSteam Link sends no capacitive state for the grip (only its pressure), so the official profile's grip touch never lit. On: the driver creates /input/grip/touch and drives it from the grip value. The threshold is the grip value that counts as touched (release at half of it); lower feels more like a touch sensor but resting fingers may trigger it.\n\nValue: galaxyXr.synthesizeGripTouch + galaxyXr.gripTouchThreshold (settings.json). Driver side — synthesizes the /input/grip/touch component from the grip pressure value."),
              reset: {
                can: gx.synthesizeGripTouch === false || (gx.gripTouchThreshold !== undefined && gx.gripTouchThreshold != 0.03),
                on: () => { gx.synthesizeGripTouch = true; gx.gripTouchThreshold = 0.03; save(); },
              },
            }),
          );
        }
        body.push(
          fieldRow(t('Controller Model Size'), html`${numberControl('galaxyXr.renderModelScale', {
            value: gx.renderModelScale ?? 1.15,
            ctx: controlContext,
            onCommit: value => { gx.renderModelScale = value; save(); },
          })}
          ${sliderControl('galaxyXr.renderModelScale', {
            value: gx.renderModelScale ?? 1.15,
            onChange: value => { gx.renderModelScale = value; save(); },
          })}`, {
            tip: t("Change the size of the controller model shown in VR. This affects its appearance, not tracking scale or the size of your hands.\n\nUniform scale for the controller models. The official assets measure about 124x63mm while the physical controller is about 145x70mm; 1.15 (default) overlays the real shell in SteamVR Home. Scales the visible model only (geometry, button and stick pivots). Pose anchors, hand skeleton and game hand meshes are never scaled, so this cannot change hand size in games. Applied live within about a second. 1.0 = stock assets.\n\nValue: galaxyXr.renderModelScale (settings.json). Driver side — scales the controller render-model mesh only; applies live."),
          }),
          settingFieldRow('galaxyXr.officialComponents', html`<app-switch .checked=${!!gx.officialComponents} @change=${(e: CustomEvent) => { gx.officialComponents = e.detail; save(); }}></app-switch>`, {
            tip: t("Use the official controller grip, aim, and tip positions. This changes how held objects and pointing rays line up with the controller.\n\nUse Samsung's official pose points (Game Link's render model: OpenXR grip/aim, dashboard laser tip, handgrip, base), rebased into our grip-convention frame so each named pose lands on the same physical spot as under Game Link. Only affects bindings that select a named pose (OpenXR games, the dashboard laser, /pose/handgrip bindings) - never raw, so SteamVR Home keeps the stock behavior.\n\nValue: galaxyXr.officialComponents (settings.json). Driver side — rebases Samsung's pose points into the driver grip frame."),
          }),
        );
      }

      // ---------- Controller Fix ----------
      body.push(
        sectionGroup(t('Controller Fix'), 1, 'group', 'controller-fix'),
      );

        if (vendor && galaxy.rootSetting?.galaxyXr) {
          body.push(
            settingFieldRow('galaxyXr.gripConvention', html`
              <app-switch .checked=${!!gx.gripConvention} ?disabled=${!!gx.gameLinkLayout} @change=${(e: CustomEvent) => { gx.gripConvention = e.detail; save(); }}></app-switch>
              ${gx.gameLinkLayout ? html`<span class="note-inline">Game Link layout is on</span>` : html``}
            `, {
              tip: t("Adjust the grip-pose convention for games whose held objects look tilted or misplaced. Compare with a known-good game before changing other offsets.\n\nShifts the raw streamed controller pose (22° pitch, 5 cm) into SteamVR's grip convention so held objects sit where games expect them and the official pose components land on the right spots. Recommended on. Turn off only if a Steam Link build already reports a grip-convention pose and the controllers sit visibly wrong.\n\nValue: galaxyXr.gripConvention (settings.json). Driver side — shifts Steam Link's raw pose into SteamVR's grip convention."),
              reset: { can: gx.gripConvention === false, on: () => { gx.gripConvention = true; save(); } },
            }),
          );
        }

        const caMode = settings.velocityFixMode == 'kalmanCA';
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
          fieldRow(t('Controller Motion Filter'), html`
            <app-select .value=${settings.velocityFixMode} .options=${modeOptions} @change=${(e: CustomEvent) => { settings.velocityFixMode = e.detail; save(); }}></app-select>
          `, {
            tip: settings.graveyardEnable ? galaxy.velocityFixTipFull : galaxy.velocityFixTip,
            reset: { can: settings.velocityFixMode != defaults.velocityFixMode, on: () => galaxy.reset('velocityFixMode') },
          }),
        );

        if (advanced && (settings.velocityFixMode == 'kalman' || settings.velocityFixMode == 'kalmanCAM')) {
          body.push(
            fieldRow(t('Kalman Filter Fine-Tuning'), html`
              <span>A</span>${numberControl('streamFrame.kalmanProcessAccel', { value: settings.kalmanProcessAccel, ctx: controlContext, label: t('Kalman acceleration noise'), onCommit: value => { settings.kalmanProcessAccel = value; save(); } })}
              <span>P</span>${numberControl('streamFrame.kalmanPosNoiseMm', { value: settings.kalmanPosNoiseMm, ctx: controlContext, label: t('Kalman position noise'), onCommit: value => { settings.kalmanPosNoiseMm = value; save(); } })}
              <span>W</span>${numberControl('streamFrame.kalmanProcessAngAccel', { value: settings.kalmanProcessAngAccel, ctx: controlContext, label: t('Kalman angular noise'), onCommit: value => { settings.kalmanProcessAngAccel = value; save(); } })}
              <span>O</span>${numberControl('streamFrame.kalmanOriNoiseDeg', { value: settings.kalmanOriNoiseDeg, ctx: controlContext, label: t('Kalman orientation noise'), onCommit: value => { settings.kalmanOriNoiseDeg = value; save(); } })}
              <span>L</span>${numberControl('streamFrame.kalmanLeadMs', { value: settings.kalmanLeadMs, ctx: controlContext, label: t('Kalman lead'), onCommit: value => { settings.kalmanLeadMs = value; save(); } })}
            `, {
              tip: t("Choose how controller motion is smoothed and predicted. Start with the normal defaults; advanced filter parameters can trade steadiness for lag or overshoot.\n\nFor the Kalman velocity mode: a single estimator produces position, rotation, velocity and spin together, the same architecture native lighthouse controllers use. A adjusts the responsiveness: higher trusts your motion more (snappier throws, a bit noisier), lower trusts smoothness (calmer hands, slight lag). W does the same for rotation: responsiveness of the spin estimator. P/O are the sensor noise floors. L leads the reported position to counter streaming latency.\n\nValue: streamFrame.kalmanProcessAccel, kalmanPosNoiseMm, kalmanProcessAngAccel, kalmanOriNoiseDeg, kalmanLeadMs (settings.json). Driver side — the Kalman filter's responsiveness and trust parameters (A/P/W/O/L)."),
              reset: {
                can: settings.kalmanProcessAccel != defaults.kalmanProcessAccel || settings.kalmanPosNoiseMm != defaults.kalmanPosNoiseMm || settings.kalmanProcessAngAccel != defaults.kalmanProcessAngAccel || settings.kalmanOriNoiseDeg != defaults.kalmanOriNoiseDeg || settings.kalmanLeadMs != defaults.kalmanLeadMs,
                on: () => { galaxy.reset('kalmanProcessAccel'); galaxy.reset('kalmanPosNoiseMm'); galaxy.reset('kalmanProcessAngAccel'); galaxy.reset('kalmanOriNoiseDeg'); galaxy.reset('kalmanLeadMs'); },
              },
            }),
          );
        }

        if (advanced && (caMode)) {
          body.push(
            fieldRow(t('Kalman CA Filter Fine-Tuning'), html`
              <span>J</span>${numberControl('streamFrame.kalmanCaJerk', { value: settings.kalmanCaJerk, ctx: controlContext, label: t('Kalman CA jerk noise'), onCommit: value => { settings.kalmanCaJerk = value; save(); } })}
              <span>Wj</span>${numberControl('streamFrame.kalmanCaAngJerk', { value: settings.kalmanCaAngJerk, ctx: controlContext, label: t('Kalman CA angular jerk'), onCommit: value => { settings.kalmanCaAngJerk = value; save(); } })}
              <span>P</span>${numberControl('streamFrame.kalmanCaPosNoiseMm', { value: settings.kalmanCaPosNoiseMm, ctx: controlContext, label: t('Kalman CA position noise'), onCommit: value => { settings.kalmanCaPosNoiseMm = value; save(); } })}
              <span>O</span>${numberControl('streamFrame.kalmanCaOriNoiseDeg', { value: settings.kalmanCaOriNoiseDeg, ctx: controlContext, label: t('Kalman CA orientation noise'), onCommit: value => { settings.kalmanCaOriNoiseDeg = value; save(); } })}
              <span>L</span>${numberControl('streamFrame.kalmanLeadMs', { value: settings.kalmanLeadMs, ctx: controlContext, label: t('Kalman lead'), onCommit: value => { settings.kalmanLeadMs = value; save(); } })}
            `, {
              tip: t("Use a motion filter that also estimates acceleration. It can change throwing behavior and responsiveness; compare carefully with the normal filter.\n\nThe constant-acceleration state tracks a changing speed estimate rather than treating every speed change as noise. It can reduce lag in some motions but can also change overshoot and throwing behavior; compare it with the normal filter. J (jerk noise) adjusts responsiveness: higher follows faster changes, lower is calmer. Wj is the rotation equivalent. P/O are sensor-noise settings. L leads the report to compensate for timing delay.\n\nValue: streamFrame.kalmanCaJerk, kalmanCaAngJerk, kalmanCaPosNoiseMm, kalmanCaOriNoiseDeg, kalmanLeadMs (settings.json). Driver side — the constant-acceleration filter's parameters (J/Wj/P/O/L)."),
              reset: {
                can: settings.kalmanCaJerk != defaults.kalmanCaJerk || settings.kalmanCaAngJerk != defaults.kalmanCaAngJerk || settings.kalmanCaPosNoiseMm != defaults.kalmanCaPosNoiseMm || settings.kalmanCaOriNoiseDeg != defaults.kalmanCaOriNoiseDeg || settings.kalmanLeadMs != defaults.kalmanLeadMs,
                on: () => { galaxy.reset('kalmanCaJerk'); galaxy.reset('kalmanCaAngJerk'); galaxy.reset('kalmanCaPosNoiseMm'); galaxy.reset('kalmanCaOriNoiseDeg'); galaxy.reset('kalmanLeadMs'); },
              },
            }),
          );
        }

        if (advanced && (settings.velocityFixMode == 'kalmanCAM')) {
          body.push(
            fieldRow(t('Kalman CA Speed Channel'), html`
              <span>J</span>${numberControl('streamFrame.kalmanCaMagJerk', { value: settings.kalmanCaMagJerk, ctx: controlContext, label: t('Kalman CA speed jerk'), onCommit: value => { settings.kalmanCaMagJerk = value; save(); } })}
              <span>τ</span>${numberControl('streamFrame.kalmanCaMagAccelTauMs', { value: settings.kalmanCaMagAccelTauMs, ctx: controlContext, label: t('Kalman CA speed decay'), onCommit: value => { settings.kalmanCaMagAccelTauMs = value; save(); } })}
            `, {
              tip: t("Adjust how strongly the older acceleration-based mode contributes to reported speed. This only affects the filter modes described below.\n\nCA-Magnitude mode: everything about the standard Kalman mode stays identical (calm direction, the A/P/W/O/L tuning above, duplicate handling), except the fast magnitude channel becomes a constant-acceleration estimator. J (jerk) is its responsiveness: higher follows the throw ramp harder. The decay bounds phantom speed across repeated-sample coasts (~150ms matches a real throw's acceleration duration). Success looks like Throw Strength Trim converging to 1.0.\n\nValue: streamFrame.kalmanCaMagJerk, kalmanCaMagAccelTauMs (settings.json). Driver side — responsiveness and decay of the CA filter's fast magnitude channel."),
              reset: {
                can: settings.kalmanCaMagJerk != defaults.kalmanCaMagJerk || settings.kalmanCaMagAccelTauMs != defaults.kalmanCaMagAccelTauMs,
                on: () => { galaxy.reset('kalmanCaMagJerk'); galaxy.reset('kalmanCaMagAccelTauMs'); },
              },
            }),
          );
        }

        if (advanced && (settings.velocityFixMode == 'kalman')) {
          body.push(
            fieldRow(t('Throw Strength Trims'), html`
              <app-select .value=${settings.kalmanMagSource} .options=${[
                { value: 'state', label: 'Calm state (default)' },
                { value: 'fast', label: 'Fast estimator (recommended at low A)' },
              ]} @change=${(e: CustomEvent) => { settings.kalmanMagSource = e.detail; save(); }}></app-select>
              <span>FA</span>${numberControl('streamFrame.kalmanMagAccel', { value: settings.kalmanMagAccel, ctx: controlContext, label: t('Kalman speed noise'), onCommit: value => { settings.kalmanMagAccel = value; save(); } })}
              <span>S</span>${numberControl('streamFrame.kalmanMagScale', { value: settings.kalmanMagScale, ctx: controlContext, label: t('Throw strength scale'), onCommit: value => { settings.kalmanMagScale = value; save(); } })}
              <span>Sa</span>${numberControl('streamFrame.kalmanAngMagScale', { value: settings.kalmanAngMagScale, ctx: controlContext, label: t('Throw spin scale'), onCommit: value => { settings.kalmanAngMagScale = value; save(); } })}
            `, {
              noticeKey: 'streamFrame.kalmanMagAccel',
              ctx: controlContext,
              tip: t("Scale the controller speeds sent to games. 1 leaves the speed unchanged; other values can change throwing strength and rotational movement.\n\nFixes weak throws at low Accel without giving up the calm direction. S/Sa globally scale reported speed. Leave at 1 unless a specific title needs it.\n\nValue: streamFrame.kalmanMagSource, kalmanMagAccel, kalmanMagScale, kalmanAngMagScale (settings.json). Driver side — scaling of the reported speed and spin."),
              reset: {
                can: settings.kalmanMagSource != defaults.kalmanMagSource || settings.kalmanMagAccel != defaults.kalmanMagAccel || settings.kalmanMagScale != defaults.kalmanMagScale || settings.kalmanAngMagScale != defaults.kalmanAngMagScale,
                on: () => { galaxy.reset('kalmanMagSource'); galaxy.reset('kalmanMagAccel'); galaxy.reset('kalmanMagScale'); galaxy.reset('kalmanAngMagScale'); },
              },
            }),
          );
        }

        if (advanced && galaxy.isKalmanMode()) {
          body.push(
            sectionGroup(t('Kalman Advanced Settings'), 2, 'group', 'kalman-advanced'),
          );
            if (advanced && (caMode)) {
              body.push(
                fieldRow(t('Acceleration Decay Time'), html`
                  <span>τ</span>${numberControl('streamFrame.kalmanCaAccelTauMs', { value: settings.kalmanCaAccelTauMs, ctx: controlContext, label: t('Acceleration decay time'), onCommit: value => { settings.kalmanCaAccelTauMs = value; save(); } })}
                `, {
                  tip: t("Set how quickly the filter stops trusting an earlier acceleration estimate. Shorter persistence can reduce overshoot but changes the feel of motion.\n\nThe acceleration state decays toward zero with this time constant (Singer model). It bounds phantom speed during repeated-sample coasts and abrupt stops.\n\nValue: streamFrame.kalmanCaAccelTauMs (settings.json). Driver side — time constant, in ms, of the acceleration state's decay (Singer model)."),
                  reset: { can: settings.kalmanCaAccelTauMs != defaults.kalmanCaAccelTauMs, on: () => galaxy.reset('kalmanCaAccelTauMs') },
                }),
              );
            }
            if (advanced && (caMode || settings.velocityFixMode == 'kalmanCAM')) {
              body.push(
                settingFieldRow('streamFrame.kalmanCaExactCov', html`<app-switch .checked=${!!settings.kalmanCaExactCov} @change=${(e: CustomEvent) => { settings.kalmanCaExactCov = e.detail; save(); }}></app-switch>`, {
                  tip: t("Try an experimental acceleration model with a matching noise calculation. Leave it off unless you are comparing filter behavior deliberately.\n\nExperiment: propagate the filter's uncertainty with the same Singer transition the state prediction actually uses, instead of the simpler approximation. Makes the filter's self-model consistent, which matters most at low Acceleration Decay Time values (in CA-Magnitude mode it applies to the fast magnitude channel). Changes effective gains slightly, so NIS and the J/P/O tuning shift a little; off reproduces the previously tuned behavior exactly.\n\nValue: streamFrame.kalmanCaExactCov (settings.json). Driver side — covariance-propagation experiment."),
                  reset: { can: settings.kalmanCaExactCov != defaults.kalmanCaExactCov, on: () => galaxy.reset('kalmanCaExactCov') },
                }),
              );
            }
            body.push(
              fieldRow(t('Rotation Output Frame'), html`
                <app-select .value=${String(settings.kalmanAngularOutFrame ?? '')} .options=${[
                  { value: 'body', label: 'Body - controller-local (default)' },
                  { value: 'world', label: 'World - previous behaviour' },
                  { value: 'zero', label: 'Zero - diagnostic' },
                ]} @change=${(e: CustomEvent) => { (settings as any).kalmanAngularOutFrame = e.detail; save(); }}></app-select>
              `, {
                tip: t("Choose how controller rotation speed is reported. The wrong coordinate convention can change throwing or aiming behavior; use the default unless testing.\n\nFrame the reported angular velocity is expressed in. Body (default, field-verified 2026-08-24): SteamVR's motion prediction rotates about controller-local axes, so this is what it expects. World: the previous behaviour, which made horizontal sword swings pitch up at the peak of the swing. Zero: diagnostic only - no angular prediction, laggier rotation.\n\nValue: streamFrame.kalmanAngularOutFrame (settings.json). Driver side — frame of the reported angular velocity (body/world/zero)."),
                reset: { can: (settings as any).kalmanAngularOutFrame != defaults.kalmanAngularOutFrame, on: () => galaxy.reset('kalmanAngularOutFrame' as any) },
              }),
            );
            body.push(
              fieldRow(t('Tracking-Loss Coasting'), html`${numberControl('streamFrame.kalmanLossCoastMs', { value: settings.kalmanLossCoastMs, ctx: controlContext, onCommit: value => { settings.kalmanLossCoastMs = value; save(); } })}
              ${sliderControl('streamFrame.kalmanLossCoastMs', { value: settings.kalmanLossCoastMs, onChange: value => { settings.kalmanLossCoastMs = value; save(); } })}`, {
                tip: t("Choose how long controller movement may continue briefly after tracking is lost. Longer coasting can hide interruptions but can also move the controller incorrectly.\n\nWhen the controller briefly leaves tracking (hand out of camera view), the stream freezes the hand in place with zero velocity until it is seen again. For up to this many ms of tracking loss, the driver instead keeps the hand moving along the filter's last known motion (with the usual acceleration decay so it cannot run away).\n\nValue: streamFrame.kalmanLossCoastMs (settings.json). Driver side — coast duration in ms after tracking loss."),
                reset: { can: settings.kalmanLossCoastMs != defaults.kalmanLossCoastMs, on: () => galaxy.reset('kalmanLossCoastMs') },
              }),
            );
            body.push(
              fieldRow(t('Repeated Sample Handling'), html`
                <app-select .value=${settings.kalmanDupMode} .options=${[
                  { value: 'off', label: 'Off - repeats believed (smooth, slight drag)' },
                  { value: 'coast', label: 'Coast - extrapolate through repeats (field-rejected)' },
                  { value: 'drop', label: 'Drop - repeats never happened (honest gaps)' },
                  { value: 'soft', label: 'Soft - repeats distrusted by the scale below' },
                  { value: 'age', label: 'Age - repeats distrusted by hand speed x age (no scale, no speed gate)' },
                ]} @change=${(e: CustomEvent) => { settings.kalmanDupMode = e.detail; save(); }}></app-select>
              `, {
                tip: t("Choose how repeated tracking samples are handled. The default avoids treating a repeated sample as fresh movement.\n\nThe streamer repeats the last pose when fresh tracking hasn't arrived, about 2 of 3 samples during fast throws. Soft (recommended): repeats are processed but distrusted by the scale below. Off: repeats are trusted fully, slight speed drag. Age: distrust grows with speed and time since the last fresh sample. Coast and Drop are not recommended. Sustained repeats are always treated as genuine stillness.\n\nValue: streamFrame.kalmanDupMode (settings.json). Driver side — duplicate-sample policy (off/coast/drop/soft/age)."),
                reset: { can: settings.kalmanDupMode != defaults.kalmanDupMode, on: () => galaxy.reset('kalmanDupMode') },
              }),
              fieldRow(t('Repeat Distrust Strength'), html`${numberControl('streamFrame.kalmanDupRScale', { value: settings.kalmanDupRScale, ctx: controlContext, onCommit: value => { settings.kalmanDupRScale = value; save(); } })}
              ${sliderControl('streamFrame.kalmanDupRScale', { value: settings.kalmanDupRScale, onChange: value => { settings.kalmanDupRScale = value; save(); } })}`, {
                noticeKey: 'streamFrame.kalmanDupRScale',
                ctx: controlContext,
                tip: t("Set how little the filter trusts a repeated tracking sample. Larger values make duplicate samples have less influence.\n\nOnly used when duplicate handling is Soft. A repeated sample is a true position of unknown age, so its honest uncertainty at hand speed is far above the sensor floor; this multiplies the measurement noise for detected repeats. 1 behaves exactly like Off; the default of 3 halves motion jitter with no measured cost; 6 and above re-create Coast's rejected snap character. Repeats sustained past the run cap are always accepted at full weight.\n\nValue: streamFrame.kalmanDupRScale (settings.json). Driver side — measurement-noise multiplier for repeated samples (Soft mode only)."),
                reset: { can: settings.kalmanDupRScale != defaults.kalmanDupRScale, on: () => galaxy.reset('kalmanDupRScale') },
              }),
              settingFieldRow('streamFrame.kalmanDeviceTime', html`<app-switch .checked=${!!settings.kalmanDeviceTime} @change=${(e: CustomEvent) => { settings.kalmanDeviceTime = e.detail; save(); }}></app-switch>`, {
                tip: t("Use timestamps supplied with controller tracking rather than assuming every update is new. This can improve timing when sample delivery is uneven.\n\nThe streamer stamps every hand pose with WHEN it was actually true (poseTimeOffset). When this is on, the filter uses the device's own timestamps for its time steps and quietly discards out-of-order samples. Leave on.\n\nValue: streamFrame.kalmanDeviceTime (settings.json). Driver side — uses the streamer's poseTimeOffset timestamps for filter time steps."),
                reset: { can: settings.kalmanDeviceTime != defaults.kalmanDeviceTime, on: () => galaxy.reset('kalmanDeviceTime') },
              }),
              settingFieldRow('streamFrame.kalmanPosFreeze3dof', html`<app-switch .checked=${!!settings.kalmanPosFreeze3dof} @change=${(e: CustomEvent) => { settings.kalmanPosFreeze3dof = e.detail; save(); }}></app-switch>`, {
                tip: t("Detect when controller position has stopped updating even if other tracking data still changes. This helps avoid treating a tracking freeze as real stillness.\n\nDetects the tracker's position-only loss: the position payload freezes while the quaternion keeps moving (fast or occluded hand falling back to IMU orientation). When detected, the stale position stays distrusted for the whole freeze instead of being adopted after the duplicate-run cap, and orientation keeps tracking live in every duplicate-handling mode. Fixes the hand parking a meter away while still rotating with the wrist, then teleporting back.\n\nValue: streamFrame.kalmanPosFreeze3dof (settings.json). Driver side — detects the position-only tracking freeze."),
                reset: { can: settings.kalmanPosFreeze3dof != defaults.kalmanPosFreeze3dof, on: () => galaxy.reset('kalmanPosFreeze3dof') },
              }),
            );
        }


      // ---------- Game Link Layout ----------
      if (vendor && galaxy.rootSetting?.galaxyXr) {
        body.push(
          sectionGroup(t('Game Link Layout'), 1, 'group', 'game-link-layout'),
        );

          body.push(
            settingFieldRow('galaxyXr.gameLinkLayout', html`
              <app-switch .checked=${!!gx.gameLinkLayout} @change=${(e: CustomEvent) => { gx.gameLinkLayout = e.detail; save(); }}></app-switch>
              <span class="note-inline">restart SteamVR after switching</span>
            `, {
              tip: t("Present the controllers the way Samsung's own PC driver (Game Link) does. An add-on to the selected Controller Motion Filter: the motion stays the mode's.\n\nThe controllers get Samsung's model at its authored size, Samsung's pose points and Samsung's input profile, on Steam Link's raw pose. While it is on, the Grip Convention, the Controller Offsets, the model scale and the aim trim are not applied; the Game Link Layout Offsets are used instead. Everything comes back when it goes off. The Disable All Controller Features master switch wins: no layout is applied while it is on. Requires a SteamVR restart.\n\nValue: galaxyXr.gameLinkLayout (settings.json). Driver side — swaps in Samsung's Game Link model, pose points and input profile; its offsets below replace the shared ones."),
              reset: { can: !!gx.gameLinkLayout, on: () => { gx.gameLinkLayout = false; save(); } },
            }),
          );
          const gl = galaxy.controllerSettings?.gameLinkLayout;
          const gd = galaxy.controllerDefaults.gameLinkLayout;
          if (gl && gd) {
            body.push(
              sectionGroup(t('Game Link Layout Offsets'), 2, 'group', 'game-link-offsets'),
              noteRow(t('Set for the LEFT controller. The right controller gets the mirror image automatically: position X and rotation Y/Z flip sign.')),
              fieldRow(t('Rotation Offset (deg)'), html`
                ${vectorControl({
                  keys: ['controllers.gameLinkLayout.rotationOffsetDeg.x', 'controllers.gameLinkLayout.rotationOffsetDeg.y', 'controllers.gameLinkLayout.rotationOffsetDeg.z'],
                  values: [gl.rotationOffsetDeg.x, gl.rotationOffsetDeg.y, gl.rotationOffsetDeg.z],
                  labels: ['X', 'Y', 'Z'],
                  baseLabel: t('Game Link rotation offset'),
                  ctx: controlContext,
                  onCommit: (key, value) => { const axis = key.slice(-1) as 'x' | 'y' | 'z'; gl.rotationOffsetDeg[axis] = value; save(); },
                })}
              `, {
                tip: t("Rotate both controllers while Game Link Layout is on. Used instead of the Controller Offsets.\n\nLocal frame rotation on Steam Link's raw pose, authored for the LEFT controller and mirrored for the right, live reloaded. X = pitch, Y = yaw, Z = roll.\n\nValue: controllers.gameLinkLayout.rotationOffsetDeg (settings.json). Driver side — left-hand authored, mirrored for the right, live."),
                reset: {
                  can: gl.rotationOffsetDeg.x != gd.rotationOffsetDeg.x || gl.rotationOffsetDeg.y != gd.rotationOffsetDeg.y || gl.rotationOffsetDeg.z != gd.rotationOffsetDeg.z,
                  on: () => galaxy.resetGameLinkOffsets('rotationOffsetDeg'),
                },
              }),
              fieldRow(t('Position Offset (cm)'), html`
                ${vectorControl({
                  keys: ['controllers.gameLinkLayout.positionOffsetCm.x', 'controllers.gameLinkLayout.positionOffsetCm.y', 'controllers.gameLinkLayout.positionOffsetCm.z'],
                  values: [gl.positionOffsetCm.x, gl.positionOffsetCm.y, gl.positionOffsetCm.z],
                  labels: ['X', 'Y', 'Z'],
                  baseLabel: t('Game Link position offset'),
                  ctx: controlContext,
                  onCommit: (key, value) => { const axis = key.slice(-1) as 'x' | 'y' | 'z'; gl.positionOffsetCm[axis] = value; save(); },
                })}
              `, {
                tip: t("Move both controllers while Game Link Layout is on. Used instead of the Controller Offsets.\n\nLocal frame position offset on Steam Link's raw pose, authored for the LEFT controller and mirrored for the right (X flips sign), live reloaded. Z = along the controller, Y = up/down, X = sideways.\n\nValue: controllers.gameLinkLayout.positionOffsetCm (settings.json). Driver side — left-hand authored (X mirrored), live."),
                reset: {
                  can: gl.positionOffsetCm.x != gd.positionOffsetCm.x || gl.positionOffsetCm.y != gd.positionOffsetCm.y || gl.positionOffsetCm.z != gd.positionOffsetCm.z,
                  on: () => galaxy.resetGameLinkOffsets('positionOffsetCm'),
                },
              }),
            );
          }

      }

      // ---------- Controllers Advanced ----------
      if (advanced) {
        body.push(
          sectionGroup(t('Controllers Advanced'), 1, 'group', 'controllers-advanced'),
        );
          if (galaxy.controllerSettings) {
            const cs = galaxy.controllerSettings;
            const cd = galaxy.controllerDefaults;
            body.push(
              sectionGroup(t('Controller Offsets'), 2, 'group', 'controller-offsets'),
            );

              if (gx?.gameLinkLayout) {
                body.push(noteRow(t('Game Link Layout is on: these offsets are not applied, the offsets in the Game Link Layout section are.')));
              }
              body.push(
                fieldRow(t('Rotation Offset (deg)'), html`
                  ${vectorControl({
                    keys: ['controllers.rotationOffsetDeg.x', 'controllers.rotationOffsetDeg.y', 'controllers.rotationOffsetDeg.z'],
                    values: [cs.rotationOffsetDeg.x, cs.rotationOffsetDeg.y, cs.rotationOffsetDeg.z],
                    labels: ['X', 'Y', 'Z'],
                    baseLabel: t('Controller rotation offset'),
                    ctx: controlContext,
                    onCommit: (key, value) => { const axis = key.slice(-1) as 'x' | 'y' | 'z'; cs.rotationOffsetDeg[axis] = value; save(); },
                  })}
                `, {
                  tip: t("Rotate both controller poses by the same adjustment. Use small changes to align virtual objects with how you hold the controllers.\n\nLocal frame rotation added to both controllers' poses, live reloaded. X (pitch): positive tilts the top back toward you. Typical useful range 5-20. Y = yaw, Z = roll.\n\nValue: controllers.rotationOffsetDeg (settings.json). Driver side — local-frame rotation on both controllers (X pitch, Y yaw, Z roll), live."),
                  reset: {
                    can: cs.rotationOffsetDeg.x != cd.rotationOffsetDeg.x || cs.rotationOffsetDeg.y != cd.rotationOffsetDeg.y || cs.rotationOffsetDeg.z != cd.rotationOffsetDeg.z,
                    on: () => galaxy.resetControllers('rotationOffsetDeg'),
                  },
                }),
                fieldRow(t('Position Offset (cm)'), html`
                  ${vectorControl({
                    keys: ['controllers.positionOffsetCm.x', 'controllers.positionOffsetCm.y', 'controllers.positionOffsetCm.z'],
                    values: [cs.positionOffsetCm.x, cs.positionOffsetCm.y, cs.positionOffsetCm.z],
                    labels: ['X', 'Y', 'Z'],
                    baseLabel: t('Controller position offset'),
                    ctx: controlContext,
                    onCommit: (key, value) => { const axis = key.slice(-1) as 'x' | 'y' | 'z'; cs.positionOffsetCm[axis] = value; save(); },
                  })}
                `, {
                  tip: t("Move both controller poses by the same adjustment. This shifts the virtual controller relative to the tracked hand position.\n\nLocal frame position offset added to both controllers' poses, live reloaded. Use when the virtual grip point sits offset from where the controller feels like it is (beam parallel but displaced): Z = forward/back along the controller, Y = up/down, X = sideways.\n\nValue: controllers.positionOffsetCm (settings.json). Driver side — local-frame position (Z along the controller, Y up/down, X sideways), live."),
                  reset: {
                    can: cs.positionOffsetCm.x != cd.positionOffsetCm.x || cs.positionOffsetCm.y != cd.positionOffsetCm.y || cs.positionOffsetCm.z != cd.positionOffsetCm.z,
                    on: () => galaxy.resetControllers('positionOffsetCm'),
                  },
                }),
                settingFieldRow('controllers.mirrorOffsetsForRightHand', html`<app-switch .checked=${!!cs.mirrorOffsetsForRightHand} @change=${(e: CustomEvent) => { cs.mirrorOffsetsForRightHand = e.detail; save(); }}></app-switch>`, {
                  tip: t("Apply one controller alignment to both hands with left/right mirroring. Turn this off to tune each hand independently.\n\nAuthor the offsets above for the LEFT controller and mirror them for the right hand. Position X and rotations Y/Z flip sign. Pitch and position Y/Z stay the same. Turn it off if the hands need different corrections.\n\nValue: controllers.mirrorOffsetsForRightHand (settings.json). Driver side — mirrors position X and rotation Y/Z for the right hand."),
                }),
              );
              if (!cs.mirrorOffsetsForRightHand && cs.left && cs.right) {
                body.push(
                  noteRow(t('Per-hand trims add to the shared offsets. Enable Mirror Offsets to use one set for both hands.')),
                  fieldRow(t('Left Hand Rotation Offset (deg)'), html`
                    ${vectorControl({
                      keys: ['controllers.left.rotationOffsetDeg.x', 'controllers.left.rotationOffsetDeg.y', 'controllers.left.rotationOffsetDeg.z'],
                      values: [cs.left!.rotationOffsetDeg.x, cs.left!.rotationOffsetDeg.y, cs.left!.rotationOffsetDeg.z],
                      labels: ['X', 'Y', 'Z'],
                      baseLabel: t('Left hand rotation offset'),
                      ctx: controlContext,
                      onCommit: (key, value) => { const axis = key.slice(-1) as 'x' | 'y' | 'z'; cs.left!.rotationOffsetDeg[axis] = value; save(); },
                    })}
                  `, {
                    tip: t("Rotate only the left controller's pose. Use this when the two hands need different alignment.\n\nPer-hand trim applied UNMIRRORED to the left controller only, after the shared offsets above. Use when the two hands need different corrections (the tracked origins are not exact mirror images). X = pitch, Y = yaw, Z = roll. Live reloaded.\n\nValue: controllers.left.rotationOffsetDeg (settings.json). Driver side — unmirrored left-hand trim after the shared offsets, live."),
                    reset: { can: galaxy.handOffsetsDirty('left'), on: () => galaxy.resetHandOffsets('left') },
                  }),
                  fieldRow(t('Left Hand Position Offset (cm)'), html`
                    ${vectorControl({
                      keys: ['controllers.left.positionOffsetCm.x', 'controllers.left.positionOffsetCm.y', 'controllers.left.positionOffsetCm.z'],
                      values: [cs.left!.positionOffsetCm.x, cs.left!.positionOffsetCm.y, cs.left!.positionOffsetCm.z],
                      labels: ['X', 'Y', 'Z'],
                      baseLabel: t('Left hand position offset'),
                      ctx: controlContext,
                      onCommit: (key, value) => { const axis = key.slice(-1) as 'x' | 'y' | 'z'; cs.left!.positionOffsetCm[axis] = value; save(); },
                    })}
                  `, {
                    tip: t("Move only the left controller's pose. The offsets change where held objects appear, not the tracking space itself.\n\nPer-hand position trim for the left controller only, unmirrored, applied after the shared offsets. Same axes as the shared Position Offset: Z = along the controller, Y = up/down, X = sideways.\n\nValue: controllers.left.positionOffsetCm (settings.json). Driver side — same axes as the shared offset, left hand only, live."),
                  }),
                  fieldRow(t('Right Hand Rotation Offset (deg)'), html`
                    ${vectorControl({
                      keys: ['controllers.right.rotationOffsetDeg.x', 'controllers.right.rotationOffsetDeg.y', 'controllers.right.rotationOffsetDeg.z'],
                      values: [cs.right!.rotationOffsetDeg.x, cs.right!.rotationOffsetDeg.y, cs.right!.rotationOffsetDeg.z],
                      labels: ['X', 'Y', 'Z'],
                      baseLabel: t('Right hand rotation offset'),
                      ctx: controlContext,
                      onCommit: (key, value) => { const axis = key.slice(-1) as 'x' | 'y' | 'z'; cs.right!.rotationOffsetDeg[axis] = value; save(); },
                    })}
                  `, {
                    tip: t("Rotate only the right controller's pose. Use this when the two hands need different alignment.\n\nPer-hand trim applied UNMIRRORED to the right controller only, after the shared offsets above. Use when the two hands need different corrections (the tracked origins are not exact mirror images). X = pitch, Y = yaw, Z = roll. Live reloaded.\n\nValue: controllers.right.rotationOffsetDeg (settings.json). Driver side — unmirrored right-hand trim after the shared offsets, live."),
                    reset: { can: galaxy.handOffsetsDirty('right'), on: () => galaxy.resetHandOffsets('right') },
                  }),
                  fieldRow(t('Right Hand Position Offset (cm)'), html`
                    ${vectorControl({
                      keys: ['controllers.right.positionOffsetCm.x', 'controllers.right.positionOffsetCm.y', 'controllers.right.positionOffsetCm.z'],
                      values: [cs.right!.positionOffsetCm.x, cs.right!.positionOffsetCm.y, cs.right!.positionOffsetCm.z],
                      labels: ['X', 'Y', 'Z'],
                      baseLabel: t('Right hand position offset'),
                      ctx: controlContext,
                      onCommit: (key, value) => { const axis = key.slice(-1) as 'x' | 'y' | 'z'; cs.right!.positionOffsetCm[axis] = value; save(); },
                    })}
                  `, {
                    tip: t("Move only the right controller's pose. The offsets change where held objects appear, not the tracking space itself.\n\nPer-hand position trim for the right controller only, unmirrored, applied after the shared offsets. Same axes as the shared Position Offset: Z = along the controller, Y = up/down, X = sideways.\n\nValue: controllers.right.positionOffsetCm (settings.json). Driver side — same axes as the shared offset, right hand only, live."),
                  }),
                );
              }

            if (vendor) {
              body.push(
                sectionGroup(t('Pointer Tip Offset'), 2, 'group', 'pointer-tip-offset'),
              );

                body.push(
                  fieldRow(t('Pointer Tip Trim X (cm)'), html`${numberControl('galaxyXr.aimTrimXCm', { value: gx.aimTrimXCm ?? 0, ctx: controlContext, onCommit: value => { gx.aimTrimXCm = value; save(); } })}`, {
                    tip: t("Move the controller's aiming tip sideways. The adjustment is mirrored between the left and right hand.\n\nMeasured correction of the dashboard pointer origin (tip and OpenXR aim together). Sideways; mirrored for the right hand. Applies live.\n\nValue: galaxyXr.aimTrimXCm (settings.json). Driver side — pointer-origin correction, mirrored for the right hand, applies live."),
                  }),
                  fieldRow(t('Pointer Tip Trim Y (cm)'), html`${numberControl('galaxyXr.aimTrimYCm', { value: gx.aimTrimYCm ?? -1, ctx: controlContext, onCommit: value => { gx.aimTrimYCm = value; save(); } })}`, {
                    tip: t("Move the controller's aiming tip vertically. This adjusts the ray or tip position used by compatible games.\n\nUp/down correction of the pointer origin. If the pointer emanates 1 cm above the real tip, set -1.\n\nValue: galaxyXr.aimTrimYCm (settings.json). Driver side — vertical pointer correction, applies live."),
                  }),
                  fieldRow(t('Pointer Tip Trim Z (cm)'), html`${numberControl('galaxyXr.aimTrimZCm', { value: gx.aimTrimZCm ?? 1, ctx: controlContext, onCommit: value => { gx.aimTrimZCm = value; save(); } })}`, {
                    tip: t("Move the controller's aiming tip forward or backward. This adjusts the ray or tip position used by compatible games.\n\nAlong-the-controller correction of the pointer origin. Positive moves it back toward the wrist: if the pointer starts 1 cm beyond the real tip, set +1.\n\nValue: galaxyXr.aimTrimZCm (settings.json). Driver side — along-controller pointer correction, applies live."),
                  }),
                );

            }
          }
      }
      }
    }


    // Retired editors retain their original access even while controller bypass is on.
    if (advanced && settings.graveyardEnable) {
      body.push(sectionRow(t('Controller Experiments (Retired)'), this.section('controllerGraveyard'), 0, () => this.toggleSection('controllerGraveyard'), 'controller-graveyard'));
      if (this.section('controllerGraveyard')) {
        const galaxyXr = galaxy.galaxyXr;
        if (galaxyXr.controllerBypass) body.push(noteRow(t('Controller features are disabled. Saved experimental adjustments are kept.')));
body.push(fieldRow(t('Kalman Freeze Coast Turn'), html`
      ${numberControl('streamFrame.kalmanFreezeCoastTurn', { value: settings.kalmanFreezeCoastTurn ?? 0, ctx: controlContext, onCommit: value => { settings.kalmanFreezeCoastTurn = value; save(); } })}
            `, {
  tip: "Try a custom curve for how motion continues during a tracking interruption. This is experimental and may make brief tracking losses feel worse.\n\nExperimental. While the tracker sends frozen positions with a live rotation (fast swings), bend the coasted hand path by the current angular velocity instead of coasting in a straight line. 0 = off (default), 1 = full coupling.",
  reset: { can: settings.kalmanFreezeCoastTurn != defaults.kalmanFreezeCoastTurn, on: () => { galaxy.reset('kalmanFreezeCoastTurn'); } }
            }));
body.push(fieldRow(t('Kalman Direction Lead (ms)'), html`
      <span>Td</span>
      ${numberControl('streamFrame.kalmanDirLeadMs', { value: settings.kalmanDirLeadMs, ctx: controlContext, disabled: true, onCommit: () => {} })}
      <span class="note">locked at 0 since 1.0.0 (angular frame fix)</span>
            `, {
  tip: "Retired experiment: this direction-lead setting is forced to 0. It is kept only so older settings files remain compatible.\n\nRETIRED 1.0.0: this lead was tuned while the angular velocity was reported in the wrong frame. With the frame fixed any non-zero value bends throws off target, so the driver and GUI force it to 0 on load. Original description: Fixes throws that combine arm movement WITH a wrist flick bending off target. Rotates the reported throw direction forward along your current wrist rotation by this many ms.",
  reset: { can: settings.kalmanDirLeadMs != defaults.kalmanDirLeadMs, on: () => { galaxy.reset('kalmanDirLeadMs'); } }
            }));
body.push(fieldRow(t('Position-Freeze Velocity Decay (ms)'), html`
      ${numberControl('streamFrame.kalmanPosFreezeVelDecayMs', { value: settings.kalmanPosFreezeVelDecayMs, ctx: controlContext, onCommit: value => { settings.kalmanPosFreezeVelDecayMs = value; save(); } })}
            `, {
  tip: "Control how quickly speed fades when controller position stops updating. 0 keeps coasting; larger decay reduces continued movement during a freeze.\n\nWhile the position is frozen (3dof fallback), the hand's velocity decays toward zero with this time constant. Short mid-throw freezes coast almost untouched; long out-of-view occlusions (windups behind the head) glide to a stop near where tracking was lost instead of sailing away on the entry velocity and reacquiring with a wrong-direction state. 0 = pure coast. Driver clamps 20-2000 when nonzero.",
  reset: { can: settings.kalmanPosFreezeVelDecayMs != defaults.kalmanPosFreezeVelDecayMs, on: () => { galaxy.reset('kalmanPosFreezeVelDecayMs'); } }
            }));
body.push(settingFieldRow('streamFrame.kalmanCaReportAccel', html`
      <app-switch .checked=${!!settings.kalmanCaReportAccel} @change=${(e: CustomEvent) => { settings.kalmanCaReportAccel = e.detail; save(); }}></app-switch>
            `, {
  tip: "Retired acceleration-reporting experiment. Leave this at its default; it is not a general improvement for normal play.\n\nRetired 2026-08-25. Reports the CA filter's acceleration state to SteamVR as vecAcceleration. No title was found that consumes it and it adds noise to the pose log.",
  reset: { can: settings.kalmanCaReportAccel != defaults.kalmanCaReportAccel, on: () => { galaxy.reset('kalmanCaReportAccel'); } }
            }));
if (galaxy.controllerSettings) {
const controllerSettings = galaxy.controllerSettings;
              body.push(settingFieldRow('controllers.aligner.enable', html`
      <app-switch .checked=${!!controllerSettings.aligner.enable} @change=${(e: CustomEvent) => { controllerSettings.aligner.enable = e.detail; save(); }}></app-switch>
              `, {
  tip: "Open the controller alignment workflow to compare tracked poses and adjust held-object alignment. Follow the capture instructions and save a known-good profile first.\n\nInteractive tuning of the controller offsets below, with the controllers themselves. A magenta marker draws where the driver believes the selected controller's TIP is. MANUAL: X switches hand, Y switches position/rotation, A/B cycle the axis, stick adjusts it live. AUTOMATIC (position): plant the tip on any solid surface at chest height away from your body (armrest, desk edge), HOLD THE TRIGGER, slowly swirl a wide cone around the planted tip for a few seconds, release. Swirl again without the trigger to verify: a frozen marker means the offset is right. Rotation is finished manually by aiming. Hold a grip 1.5s to save (paste block + file). Offsets are shared by both hands for now."
              }));
}
if (vendor) {
              body.push(fieldRow(t('Debug: Skeleton Hand Offset X (cm)'), html`
      ${numberControl('galaxyXr.skeletonOffsetXCm', { value: galaxyXr.skeletonOffsetXCm ?? 0, ctx: controlContext, onCommit: value => { galaxyXr.skeletonOffsetXCm = value; save(); } })}
              `, {
  tip: "Move the animated hand skeleton sideways relative to the controller. This affects compatible hand visuals rather than headset tracking.\n\nMoves the skeletal hand relative to its grip anchor without touching the tracked pose, controller model, or the pivot games rotate held items around. Mirrored to the right hand. Applies LIVE - no restart, watch the hand move as you adjust."
              }));
              body.push(fieldRow(t('Debug: Skeleton Hand Offset Y (cm)'), html`
      ${numberControl('galaxyXr.skeletonOffsetYCm', { value: galaxyXr.skeletonOffsetYCm ?? 0, ctx: controlContext, onCommit: value => { galaxyXr.skeletonOffsetYCm = value; save(); } })}
              `, {
  tip: "Move the animated hand skeleton vertically relative to the controller. This affects compatible hand visuals.\n\nSecond axis of the live skeletal hand offset. Axes are in the skeleton root frame - identify directions empirically by nudging; changes apply immediately."
              }));
              body.push(fieldRow(t('Debug: Skeleton Hand Offset Z (cm)'), html`
      ${numberControl('galaxyXr.skeletonOffsetZCm', { value: galaxyXr.skeletonOffsetZCm ?? 0, ctx: controlContext, onCommit: value => { galaxyXr.skeletonOffsetZCm = value; save(); } })}
              `, {
  tip: "Move the animated hand skeleton forward or backward relative to the controller. This affects compatible hand visuals.\n\nThird axis of the live skeletal hand offset. Set skeletonOffsetMirror to false in settings.json if the left hand needs the X direction unmirrored."
              }));
              body.push(settingFieldRow('galaxyXr.simulateTouch', html`
      <app-switch .checked=${!!galaxyXr.simulateTouch} @change=${(e: CustomEvent) => { galaxyXr.simulateTouch = e.detail; save(); }}></app-switch>
              `, {
  tip: "Retired controller-layout experiment. Leave it Off; it is kept only so older settings files remain compatible.\n\nRetired experiment. The switch is retained in the Graveyard so older settings do not break; it presents an alternate controller layout to games and can change bindings. Requires a SteamVR restart."
              }));
              body.push(fieldRow(t('Controller Mesh Offset X (cm)'), html`
      ${numberControl('galaxyXr.meshOffsetXCm', { value: galaxyXr.meshOffsetXCm ?? 0, ctx: controlContext, onCommit: value => { galaxyXr.meshOffsetXCm = value; save(); } })}
              `, {
  tip: "Move only the visible controller model sideways to compensate for a pose adjustment. This does not move the underlying tracked pose.\n\nCosmetic counter-translation of the visible controller model (SteamVR Home, dashboard) after a pose trim moved it off the physical controller. Moves ONLY the mesh - no pose, anchor or held-object pivot changes. Left-hand authored, X mirrored for the right. Applies live (model regenerates and reloads within a second)."
              }));
              body.push(fieldRow(t('Controller Mesh Offset Y (cm)'), html`
      ${numberControl('galaxyXr.meshOffsetYCm', { value: galaxyXr.meshOffsetYCm ?? 0, ctx: controlContext, onCommit: value => { galaxyXr.meshOffsetYCm = value; save(); } })}
              `, {
  tip: "Move only the visible controller model vertically. This does not move the underlying tracked pose.\n\nSecond axis of the mesh counter-translation (up/down in the controller frame)."
              }));
              body.push(fieldRow(t('Controller Mesh Offset Z (cm)'), html`
      ${numberControl('galaxyXr.meshOffsetZCm', { value: galaxyXr.meshOffsetZCm ?? 0, ctx: controlContext, onCommit: value => { galaxyXr.meshOffsetZCm = value; save(); } })}
              `, {
  tip: "Move only the visible controller model forward or backward. This does not move the underlying tracked pose.\n\nThird axis of the mesh counter-translation. Positive moves the mesh back toward the wrist. If Position Offset Z is -2 for the hands, +2 here puts the Home mesh back on the real controller."
              }));
              body.push(fieldRow(t('Hand Anchor X (cm)'), html`
      ${numberControl('galaxyXr.handAnchorXCm', { value: galaxyXr.handAnchorXCm ?? 0, ctx: controlContext, onCommit: value => { galaxyXr.handAnchorXCm = value; save(); } })}
              `, {
  tip: "Move the optional hand-anchor pose sideways. A game must explicitly use the hand-anchor binding for this adjustment to have an effect.\n\nTransform of the /pose/hand_anchor component, used ONLY by per-app bindings that select it (identity = same as raw). Note: a per-app binding disables SteamVR controller-type simulation, so games lose their own per-controller hand offsets - prefer the knuckles fallback and the pose trims below unless a game has no usable offsets. Left-hand authored; X, yaw and roll mirror for the right. Live."
              }));
              body.push(fieldRow(t('Hand Anchor Y (cm)'), html`
      ${numberControl('galaxyXr.handAnchorYCm', { value: galaxyXr.handAnchorYCm ?? 0, ctx: controlContext, onCommit: value => { galaxyXr.handAnchorYCm = value; save(); } })}
              `, {
  tip: "Move the optional hand-anchor pose vertically. It only affects games bound to that pose.\n\nSecond axis of the hand anchor translation."
              }));
              body.push(fieldRow(t('Hand Anchor Z (cm)'), html`
      ${numberControl('galaxyXr.handAnchorZCm', { value: galaxyXr.handAnchorZCm ?? 0, ctx: controlContext, onCommit: value => { galaxyXr.handAnchorZCm = value; save(); } })}
              `, {
  tip: "Move the optional hand-anchor pose forward or backward. It only affects games bound to that pose.\n\nThird axis of the hand anchor translation (negative = toward the fingertips)."
              }));
              body.push(fieldRow(t('Hand Anchor Pitch (deg)'), html`
      ${numberControl('galaxyXr.handAnchorPitchDeg', { value: galaxyXr.handAnchorPitchDeg ?? 0, ctx: controlContext, onCommit: value => { galaxyXr.handAnchorPitchDeg = value; save(); } })}
              `, {
  tip: "Rotate the optional hand-anchor pose around its first axis. It only affects games bound to that pose.\n\nHand anchor rotation about X, in the render model rotate_xyz convention."
              }));
              body.push(fieldRow(t('Hand Anchor Yaw (deg)'), html`
      ${numberControl('galaxyXr.handAnchorYawDeg', { value: galaxyXr.handAnchorYawDeg ?? 0, ctx: controlContext, onCommit: value => { galaxyXr.handAnchorYawDeg = value; save(); } })}
              `, {
  tip: "Rotate the optional hand-anchor pose around its second axis. It only affects games bound to that pose.\n\nHand anchor rotation about Y (mirrored for the right hand)."
              }));
              body.push(fieldRow(t('Hand Anchor Roll (deg)'), html`
      ${numberControl('galaxyXr.handAnchorRollDeg', { value: galaxyXr.handAnchorRollDeg ?? 0, ctx: controlContext, onCommit: value => { galaxyXr.handAnchorRollDeg = value; save(); } })}
              `, {
  tip: "Rotate the optional hand-anchor pose around its third axis. It only affects games bound to that pose.\n\nHand anchor rotation about Z (mirrored for the right hand)."
              }));
}
body.push(settingFieldRow('streamFrame.deriveLatchPoseAssist', html`
      <app-select .value=${settings.deriveDiagVelocity} .options=${[{ value: 'off', label: 'Normal velocity' }, { value: 'zero', label: 'Report zero (test)' }]} @change=${(e: CustomEvent) => { settings.deriveDiagVelocity = e.detail; save(); }}></app-select>
      <app-switch .checked=${!!settings.deriveLatchPoseAssist} @change=${(e: CustomEvent) => { settings.deriveLatchPoseAssist = e.detail; save(); }}></app-switch>
            `, {
  ctx: controlContext,
  tip: "Send zero controller velocity to isolate problems caused by reported motion. This diagnostic mode can break throwing and should be off for normal play.\n\nHelps decide if a game uses vecVelocity or computes the velocity itself. Report zero for ~2 minutes: if throws still fly, the game ignores reported velocity. Turn off after testing.",
  reset: { can: settings.deriveDiagVelocity != defaults.deriveDiagVelocity || settings.deriveLatchPoseAssist != defaults.deriveLatchPoseAssist, on: () => { galaxy.reset('deriveDiagVelocity'); galaxy.reset('deriveLatchPoseAssist'); } }
            }));
body.push(settingFieldRow('streamFrame.kalmanDirLeadAdaptive', html`
      <app-switch .checked=${!!settings.kalmanDirLeadAdaptive} @change=${(e: CustomEvent) => { settings.kalmanDirLeadAdaptive = e.detail; save(); }}></app-switch>
      <span>Base</span>
      ${numberControl('streamFrame.kalmanDirLeadBaseMs', { value: settings.kalmanDirLeadBaseMs, ctx: controlContext, onCommit: value => { settings.kalmanDirLeadBaseMs = value; save(); } })}
      <span>Slope</span>
      ${numberControl('streamFrame.kalmanDirLeadWMs', { value: settings.kalmanDirLeadWMs, ctx: controlContext, onCommit: value => { settings.kalmanDirLeadWMs = value; save(); } })}
            `, {
  noticeKey: 'streamFrame.kalmanDirLeadBaseMs',
  ctx: controlContext,
  tip: "Try an experimental correction that anticipates changes in motion direction. Leave it off unless you are measuring the result.\n\nThe fixed Direction Lead above is tuned for the average throw, but the hardest wrist whips (25+ rad/s) lag the filter more, so a single value under-corrects exactly your most violent throws - the last remaining direction tail. When enabled, the lead grows smoothly with your wrist speed: base + slope x rotation speed, OVERRIDING the manual Td while on. Defaults (5 + 0.3/rads): an ordinary throw gets ~8ms, a hard whip ~14ms. No thresholds, nothing switches - gentle throws are essentially unchanged. Success looks like the rare 12-24 degree hard-whip releases dropping to the ~5 degree baseline with everything else identical.",
  reset: { can: settings.kalmanDirLeadAdaptive != defaults.kalmanDirLeadAdaptive || settings.kalmanDirLeadBaseMs != defaults.kalmanDirLeadBaseMs || settings.kalmanDirLeadWMs != defaults.kalmanDirLeadWMs, on: () => { galaxy.reset('kalmanDirLeadAdaptive'); galaxy.reset('kalmanDirLeadBaseMs'); galaxy.reset('kalmanDirLeadWMs'); } }
            }));
body.push(settingFieldRow('streamFrame.kalmanAdaptiveR', html`
      <app-switch .checked=${!!settings.kalmanAdaptiveR} @change=${(e: CustomEvent) => { settings.kalmanAdaptiveR = e.detail; save(); }}></app-switch>
      <span>Max</span>
      ${numberControl('streamFrame.kalmanAdaptiveRMaxDiv', { value: settings.kalmanAdaptiveRMaxDiv, ctx: controlContext, onCommit: value => { settings.kalmanAdaptiveRMaxDiv = value; save(); } })}
            `, {
  tip: "Try an experimental correction for smoothing delay. Too much correction can create overshoot or unstable motion.\n\nAttacks the hard-whip lag itself instead of compensating its direction error - so unlike Experiment A this also reaches games that compute throws from hand position history. The filter continuously measures how far the incoming tracking is outrunning its own smooth model and, exactly in proportion, trusts the raw measurements more (bounded by Max). During calm and ordinary motion it is mathematically identical to off; during violent whips it lets the filter keep up, at the honest cost of passing some tracking noise through while your hand is moving fast (where it is hard to perceive). Purely opt-in - this deliberately bends the smoothness tuning the whole campaign ratified, so judge it on its own session. Watch rDiv/rADiv in KALDIAG: 1.0 all session = it never engaged; peaks of 5-16 during whips only = working as designed.",
  reset: { can: settings.kalmanAdaptiveR != defaults.kalmanAdaptiveR || settings.kalmanAdaptiveRMaxDiv != defaults.kalmanAdaptiveRMaxDiv, on: () => { galaxy.reset('kalmanAdaptiveR'); galaxy.reset('kalmanAdaptiveRMaxDiv'); } }
            }));
body.push(settingFieldRow('streamFrame.kalmanGripEnable', html`
      <app-switch .checked=${!!settings.kalmanGripEnable} @change=${(e: CustomEvent) => { settings.kalmanGripEnable = e.detail; save(); }}></app-switch>
      <span>Blend</span>
      ${numberControl('streamFrame.kalmanGripBlend', { value: settings.kalmanGripBlend, ctx: controlContext, onCommit: value => { settings.kalmanGripBlend = value; save(); } })}
            `, {
  noticeKey: 'streamFrame.kalmanGripBlend',
  ctx: controlContext,
  tip: "Account for rotation around a wrist or grip point when estimating controller motion. This is an advanced alignment-dependent adjustment.\n\nThe estimator honestly reports the tracked origin's velocity; during a wrist snap that includes the origin's tangential speed around your hand (w x r) - physics, not filter error, and the measured cause of combined linear+wrist throws bending off while pure linear and pure flick throws feel right. When enabled, reported velocity is transported to the grip point: v + blend x (w x r). Set r via the in-headset Aligner's GRIP capture (hold the palm still, swirl a pure wrist cone with the trigger held) or type it below. With r set but Enable OFF the driver runs shadow-only: PEAKDIAG logs gOut/gDirOff/wr showing what compensation WOULD have reported - verify a session like that first. Leave OFF for games/engines that already transport velocity to their own attach point (they would double-apply). Blend 1 = full physics; below 1 under-corrects deliberately.",
  reset: { can: settings.kalmanGripEnable != defaults.kalmanGripEnable || settings.kalmanGripBlend != defaults.kalmanGripBlend, on: () => { galaxy.reset('kalmanGripEnable'); galaxy.reset('kalmanGripBlend'); } }
            }));
body.push(fieldRow(t('Grip Point r - Left / Right (cm, controller local frame)'), html`
      <span>Lx</span>
      ${numberControl('streamFrame.kalmanGripLeftCm.x', { value: settings.kalmanGripLeftCm.x, ctx: controlContext, onCommit: value => { settings.kalmanGripLeftCm.x = value; save(); } })}
      <span>Ly</span>
      ${numberControl('streamFrame.kalmanGripLeftCm.y', { value: settings.kalmanGripLeftCm.y, ctx: controlContext, onCommit: value => { settings.kalmanGripLeftCm.y = value; save(); } })}
      <span>Lz</span>
      ${numberControl('streamFrame.kalmanGripLeftCm.z', { value: settings.kalmanGripLeftCm.z, ctx: controlContext, onCommit: value => { settings.kalmanGripLeftCm.z = value; save(); } })}
      <span>Rx</span>
      ${numberControl('streamFrame.kalmanGripRightCm.x', { value: settings.kalmanGripRightCm.x, ctx: controlContext, onCommit: value => { settings.kalmanGripRightCm.x = value; save(); } })}
      <span>Ry</span>
      ${numberControl('streamFrame.kalmanGripRightCm.y', { value: settings.kalmanGripRightCm.y, ctx: controlContext, onCommit: value => { settings.kalmanGripRightCm.y = value; save(); } })}
      <span>Rz</span>
      ${numberControl('streamFrame.kalmanGripRightCm.z', { value: settings.kalmanGripRightCm.z, ctx: controlContext, onCommit: value => { settings.kalmanGripRightCm.z = value; save(); } })}
            `, {
  noticeKey: 'streamFrame.kalmanGripLeftCm.x',
  ctx: controlContext,
  tip: "Set the point around which each controller rotates. Use measurements from the alignment workflow rather than guessing large offsets.\n\nPer-hand vector from the tracked origin to the hand's rotation center, in the controller's local frame. The Aligner's GRIP capture solves this automatically (it is the same least-squares pivot solve as the tip capture, aimed at your wrist instead of a desk) and saving from the Aligner writes these fields. Typical magnitude a few cm; values are ignored (compensator inert) below 0.1cm or above 30cm. Field data 2026-08-14: per-throw inversion of the direction error clusters at |r| ~ 5cm.",
  reset: { can: settings.kalmanGripLeftCm.x != defaults.kalmanGripLeftCm.x || settings.kalmanGripLeftCm.y != defaults.kalmanGripLeftCm.y || settings.kalmanGripLeftCm.z != defaults.kalmanGripLeftCm.z || settings.kalmanGripRightCm.x != defaults.kalmanGripRightCm.x || settings.kalmanGripRightCm.y != defaults.kalmanGripRightCm.y || settings.kalmanGripRightCm.z != defaults.kalmanGripRightCm.z, on: () => { galaxy.reset('kalmanGripLeftCm'); galaxy.reset('kalmanGripRightCm'); } }
            }));
body.push(fieldRow(t('Throw Strength Trim (scale / spin scale)'), html`
      <span>S</span>
      ${numberControl('streamFrame.kalmanMagScale', { value: settings.kalmanMagScale, ctx: controlContext, onCommit: value => { settings.kalmanMagScale = value; save(); } })}
      <span>Sa</span>
      ${numberControl('streamFrame.kalmanAngMagScale', { value: settings.kalmanAngMagScale, ctx: controlContext, onCommit: value => { settings.kalmanAngMagScale = value; save(); } })}
            `, {
  tip: "Scale the speed estimate in the acceleration-based filter. 1 leaves it unchanged; this can affect throwing strength.\n\nGlobal multipliers on reported speed and spin, kept as safety trims for the CA experiment modes. If the CA model is doing its job these converge to 1.0 - the PEAKDIAG log line (out/sec ratio) is the instrument that says whether they can.",
  reset: { can: settings.kalmanMagScale != defaults.kalmanMagScale || settings.kalmanAngMagScale != defaults.kalmanAngMagScale, on: () => { galaxy.reset('kalmanMagScale'); galaxy.reset('kalmanAngMagScale'); } }
            }));
body.push(fieldRow(t('Kalman Smoothed Reporting Lag (ms)'), html`
      ${numberControl('streamFrame.kalmanSmoothLagMs', { value: settings.kalmanSmoothLagMs, ctx: controlContext, onCommit: value => { settings.kalmanSmoothLagMs = value; save(); } })}
            `, {
  tip: "Try a filter that smooths motion using a short history. This is experimental and trades some delay for steadier estimates.\n\nThe one remaining pure-estimator upgrade, aimed at what this game actually reads (your hand's position history): instead of estimating the present from the past only, the reported hand state is estimated a few ms in the past using tracking samples from BOTH sides of that moment - as calm as your A=1 tuning AND amplitude-accurate like a fast filter, a combination plain filtering cannot achieve. The whole reported state (position, rotation, velocity, spin) shifts together, staying coherent. The single honest cost: this many ms of added hand latency (partly hidden by the runtime's forward prediction, which now gets an accurate velocity). In Kalman CA this is a true fixed-lag RTS smoother; set it to roughly your measured release skew (~35 ms) and pair it with a faster Jerk (8-25) than you would run causally. 0 = off.",
  reset: { can: settings.kalmanSmoothLagMs != defaults.kalmanSmoothLagMs, on: () => { galaxy.reset('kalmanSmoothLagMs'); } }
            }));
body.push(fieldRow(t('Kalman Smoothed Lag Epoch'), html`
      <app-select .value=${settings.kalmanSmoothLagEpoch} .options=${[{ value: 0, label: 'Latent - stamped as current (+L hand latency)' }, { value: 1, label: 'Honest - true epoch (runtime extrapolates L)' }]} @change=${(e: CustomEvent) => { settings.kalmanSmoothLagEpoch = e.detail; save(); }}></app-select>
            `, {
  tip: "Choose how the experimental history-based filter timestamps its result. This can change how games interpret prediction and delay.\n\nHow the smoothed (L ms old) state is stamped for SteamVR. Latent (default): stamped as current, so the runtime predicts its usual short horizon and the whole hand simply carries L ms of extra latency; the submitted position history is the smoothed trajectory delayed by L, which is what pose-history throw estimators read. Honest: the true epoch (-L) is reported; the runtime then extrapolates the position by L plus its photon horizon from the reported velocity, which turned throws weak/backward in the field for this game (pose-history games); only for games that read vecVelocity directly.",
  reset: { can: settings.kalmanSmoothLagEpoch != defaults.kalmanSmoothLagEpoch, on: () => { galaxy.reset('kalmanSmoothLagEpoch'); } }
            }));
body.push(fieldRow(t('Gaze Aim Assist (strength 0-1 / max bend deg / min speed m/s)'), html`
      <span>G</span>
      ${numberControl('streamFrame.kalmanGazeAssist', { value: settings.kalmanGazeAssist, ctx: controlContext, onCommit: value => { settings.kalmanGazeAssist = value; save(); } })}
      <span>°</span>
      ${numberControl('streamFrame.kalmanGazeMaxDeg', { value: settings.kalmanGazeMaxDeg, ctx: controlContext, onCommit: value => { settings.kalmanGazeMaxDeg = value; save(); } })}
      <span>S</span>
      ${numberControl('streamFrame.kalmanGazeMinSpeed', { value: settings.kalmanGazeMinSpeed, ctx: controlContext, onCommit: value => { settings.kalmanGazeMinSpeed = value; save(); } })}
            `, {
  noticeKey: 'streamFrame.kalmanGazeMaxDeg',
  ctx: controlContext,
  tip: "Try using gaze information to help estimate throwing direction. This is experimental, needs reliable eye tracking, and can change normal throws.\n\nUses your eye tracking to fix the last class of bad throws: you look at the target before your hand lets go, so your gaze knows the intended direction even when the release samples the hand's snap-back. Above the minimum speed, the reported throw direction is bent toward where you're looking - by strength fraction of the angle, never more than the max bend cap. Direction only: throw power and spin are untouched, the rendered hand is untouched, and if eye data is missing or stale for even 100ms it silently does nothing. Start at 0.4-0.6; the 'gaze aim assist ENGAGED' log line confirms it's live. 0 = off. TEST MODE: values above 1 shrink the disagreement needed for full gaze takeover - G=10 with max bend 180 locks every throw straight onto your gaze, for verifying the whole pipeline.",
  reset: { can: settings.kalmanGazeAssist != defaults.kalmanGazeAssist || settings.kalmanGazeMaxDeg != defaults.kalmanGazeMaxDeg || settings.kalmanGazeMinSpeed != defaults.kalmanGazeMinSpeed, on: () => { galaxy.reset('kalmanGazeAssist'); galaxy.reset('kalmanGazeMaxDeg'); galaxy.reset('kalmanGazeMinSpeed'); } }
            }));
body.push(fieldRow(t('Kalman Duplicate-Coast Cap (ms)'), html`
      ${numberControl('streamFrame.kalmanDupCoastMaxMs', { value: settings.kalmanDupCoastMaxMs, ctx: controlContext, onCommit: value => { settings.kalmanDupCoastMaxMs = value; save(); } })}
            `, {
  tip: "Limit how long repeated samples are treated as duplicates while the controller is still. This balances freeze detection against genuine stillness.\n\nActive even while archived. Repeats sustained past this cap are accepted as genuine stillness at full weight - no human hand holds a position bit-identically for tens of ms, so a long repeat means the tracker stopped producing, and believing it beats extrapolating or distrusting blind. Also closes a coast runaway. Default 90, range 10-500. Applies to Coast, Drop, and Soft.",
  reset: { can: settings.kalmanDupCoastMaxMs != defaults.kalmanDupCoastMaxMs, on: () => { galaxy.reset('kalmanDupCoastMaxMs'); } }
            }));
body.push(fieldRow(t('Kalman Direction Smoothing (linear ms / angular ms)'), html`
      <span>Dir</span>
      ${numberControl('streamFrame.kalmanDirSmoothMs', { value: settings.kalmanDirSmoothMs, ctx: controlContext, onCommit: value => { settings.kalmanDirSmoothMs = value; save(); } })}
      <span>DirA</span>
      ${numberControl('streamFrame.kalmanAngDirSmoothMs', { value: settings.kalmanAngDirSmoothMs, ctx: controlContext, onCommit: value => { settings.kalmanAngDirSmoothMs = value; save(); } })}
            `, {
  tip: "Smooth motion speed and motion direction separately in the legacy filter. This only affects the supported legacy branch.\n\nWhat your A=1 tuning discovered, made into its own knob: throw DIRECTION gets heavy smoothing (the calm you liked) while throw STRENGTH stays live (no weak throws, nothing slipping out of your hand). Set Accel back to 40-60 and put 60-90 here; direction takes on the A=1 steadiness while magnitude keeps full snap. Angular ditto for spin. 0 = off. Only the reported velocity is shaped; the rendered hand is untouched.",
  reset: { can: settings.kalmanDirSmoothMs != defaults.kalmanDirSmoothMs || settings.kalmanAngDirSmoothMs != defaults.kalmanAngDirSmoothMs, on: () => { galaxy.reset('kalmanDirSmoothMs'); galaxy.reset('kalmanAngDirSmoothMs'); } }
            }));
body.push(fieldRow(t('Kalman Release Rewind (ms) / Hold (ms) - EXPERIMENT'), html`
      <span>R</span>
      ${numberControl('streamFrame.kalmanReleaseRewindMs', { value: settings.kalmanReleaseRewindMs, ctx: controlContext, onCommit: value => { settings.kalmanReleaseRewindMs = value; save(); } })}
      <span>H</span>
      ${numberControl('streamFrame.kalmanRewindHoldMs', { value: settings.kalmanRewindHoldMs, ctx: controlContext, onCommit: value => { settings.kalmanRewindHoldMs = value; save(); } })}
            `, {
  tip: "Try an experimental release-time correction for throwing. 0 disables it; the approach is a hypothesis to test, not a guaranteed fix.\n\nSingle-session experiment, off at 0. Hypothesis: your trigger release reaches the PC 40-60ms later than your hand motion does, so games read the hand AFTER it already snapped back - that is where reverse throws come from. When set, the moment your release arrives, the reported velocity is taken from Rewind ms earlier in the motion history (then blends back to live over Hold ms). This is pure time re-alignment by one constant - if a value around 45 makes reverse throws vanish, the hypothesis is proven and the value IS your network's input lag; if no value in 30-60 helps, the hypothesis is dead and this stays off forever. The rendered hand is never touched.",
  reset: { can: settings.kalmanReleaseRewindMs != defaults.kalmanReleaseRewindMs || settings.kalmanRewindHoldMs != defaults.kalmanRewindHoldMs, on: () => { galaxy.reset('kalmanReleaseRewindMs'); galaxy.reset('kalmanRewindHoldMs'); } }
            }));
body.push(fieldRow(t('Derive Smoothing (tau slow/fast ms, speed low/high)'), html`
      <span>τS</span>
      ${numberControl('streamFrame.deriveSmoothTauSlowMs', { value: settings.deriveSmoothTauSlowMs, ctx: controlContext, onCommit: value => { settings.deriveSmoothTauSlowMs = value; save(); } })}
      <span>τF</span>
      ${numberControl('streamFrame.deriveSmoothTauFastMs', { value: settings.deriveSmoothTauFastMs, ctx: controlContext, onCommit: value => { settings.deriveSmoothTauFastMs = value; save(); } })}
      <span>sL</span>
      ${numberControl('streamFrame.deriveSmoothSpeedLow', { value: settings.deriveSmoothSpeedLow, ctx: controlContext, onCommit: value => { settings.deriveSmoothSpeedLow = value; save(); } })}
      <span>sH</span>
      ${numberControl('streamFrame.deriveSmoothSpeedHigh', { value: settings.deriveSmoothSpeedHigh, ctx: controlContext, onCommit: value => { settings.deriveSmoothSpeedHigh = value; save(); } })}
            `, {
  noticeKey: 'streamFrame.deriveSmoothTauSlowMs',
  ctx: controlContext,
  tip: "Adjust the motion filter's smoothing automatically with speed. This changes the trade-off between steady slow motion and responsive fast motion.\n\nSpeed-adaptive smoothing for the Derive velocity mode, live reloaded. The filter time constant slides from tau slow (held still: kills trembling) to tau fast (throw speeds: near raw so the peak survives) as effective speed crosses low..high. Lower tau fast raises the reported peak but passes more raw noise at release; if throw directions misbehave, prefer the Split Direction toggles below over pushing tau fast toward zero.",
  reset: { can: settings.deriveSmoothTauSlowMs != defaults.deriveSmoothTauSlowMs || settings.deriveSmoothTauFastMs != defaults.deriveSmoothTauFastMs || settings.deriveSmoothSpeedLow != defaults.deriveSmoothSpeedLow || settings.deriveSmoothSpeedHigh != defaults.deriveSmoothSpeedHigh, on: () => { galaxy.reset('deriveSmoothTauSlowMs'); galaxy.reset('deriveSmoothTauFastMs'); galaxy.reset('deriveSmoothSpeedLow'); galaxy.reset('deriveSmoothSpeedHigh'); } }
            }));
body.push(settingFieldRow('streamFrame.deriveSmoothAngSeparate', html`
      <app-switch .checked=${!!settings.deriveSmoothAngSeparate} @change=${(e: CustomEvent) => { settings.deriveSmoothAngSeparate = e.detail; save(); }}></app-switch>
      <span>τS</span>
      ${numberControl('streamFrame.deriveSmoothAngTauSlowMs', { value: settings.deriveSmoothAngTauSlowMs, ctx: controlContext, onCommit: value => { settings.deriveSmoothAngTauSlowMs = value; save(); } })}
      <span>τF</span>
      ${numberControl('streamFrame.deriveSmoothAngTauFastMs', { value: settings.deriveSmoothAngTauFastMs, ctx: controlContext, onCommit: value => { settings.deriveSmoothAngTauFastMs = value; save(); } })}
      <span>sL</span>
      ${numberControl('streamFrame.deriveSmoothAngSpeedLow', { value: settings.deriveSmoothAngSpeedLow, ctx: controlContext, onCommit: value => { settings.deriveSmoothAngSpeedLow = value; save(); } })}
      <span>sH</span>
      ${numberControl('streamFrame.deriveSmoothAngSpeedHigh', { value: settings.deriveSmoothAngSpeedHigh, ctx: controlContext, onCommit: value => { settings.deriveSmoothAngSpeedHigh = value; save(); } })}
            `, {
  noticeKey: 'streamFrame.deriveSmoothAngTauSlowMs',
  ctx: controlContext,
  tip: "Use a separate smoothing strength for rotational motion. This lets rotation and straight-line movement be tuned independently.\n\nGives the angular (spin) channel its own speed-adaptive smoothing instead of sharing the linear channel's filter. Field data shows the shared filter under-serves spin: reported angular speed swings about +-40% around raw. Defaults are chosen to be nearly behavior neutral on enable, so tune from there: raise tau fast to calm spin jitter, lower speed high if wrist-flick throws lose their snap. Angular speeds are in rad/s (a firm wrist flick peaks around 10-20).",
  reset: { can: settings.deriveSmoothAngSeparate != defaults.deriveSmoothAngSeparate || settings.deriveSmoothAngTauSlowMs != defaults.deriveSmoothAngTauSlowMs || settings.deriveSmoothAngTauFastMs != defaults.deriveSmoothAngTauFastMs || settings.deriveSmoothAngSpeedLow != defaults.deriveSmoothAngSpeedLow || settings.deriveSmoothAngSpeedHigh != defaults.deriveSmoothAngSpeedHigh, on: () => { galaxy.reset('deriveSmoothAngSeparate'); galaxy.reset('deriveSmoothAngTauSlowMs'); galaxy.reset('deriveSmoothAngTauFastMs'); galaxy.reset('deriveSmoothAngSpeedLow'); galaxy.reset('deriveSmoothAngSpeedHigh'); } }
            }));
body.push(settingFieldRow('streamFrame.deriveSplitDirLinear', html`
      <app-switch .checked=${!!settings.deriveSplitDirLinear} @change=${(e: CustomEvent) => { settings.deriveSplitDirLinear = e.detail; save(); }}></app-switch>
            `, {
  ctx: controlContext,
  tip: "Use a separate smoothing strength for straight-line motion direction. It only affects filter modes that split speed from direction.\n\nExperimental fix for throws flying in random directions with Derive mode. Keeps the smoothed velocity MAGNITUDE but takes the DIRECTION from a speed-weighted average of the raw estimates over a short window, so the fastest (most reliable) samples pin the release direction. Toggle one channel at a time for a clean A/B; the log line 'VelocityFix: split-dir active' confirms it engaged.",
  reset: { can: settings.deriveSplitDirLinear != defaults.deriveSplitDirLinear, on: () => { galaxy.reset('deriveSplitDirLinear'); } }
            }));
body.push(settingFieldRow('streamFrame.deriveSplitDirAngular', html`
      <app-switch .checked=${!!settings.deriveSplitDirAngular} @change=${(e: CustomEvent) => { settings.deriveSplitDirAngular = e.detail; save(); }}></app-switch>
            `, {
  ctx: controlContext,
  tip: "Use a separate smoothing strength for rotation direction. It only affects filter modes that split rotation speed from direction.\n\nSame split treatment for angular velocity (spin direction at release). Independent from the linear toggle so A/B tests stay single-variable.",
  reset: { can: settings.deriveSplitDirAngular != defaults.deriveSplitDirAngular, on: () => { galaxy.reset('deriveSplitDirAngular'); } }
            }));
body.push(fieldRow(t('Latch Angular Min Speed (rad/s) / Input Prefilter'), html`
      ${numberControl('streamFrame.deriveLatchAngMinSpeed', { value: settings.deriveLatchAngMinSpeed, ctx: controlContext, onCommit: value => { settings.deriveLatchAngMinSpeed = value; save(); } })}
      <app-select .value=${settings.derivePreFilter} .options=${[{ value: 'off', label: 'Off (raw input)' }, { value: 'median3', label: 'Median of 3 (recommended)' }]} @change=${(e: CustomEvent) => { settings.derivePreFilter = e.detail; save(); }}></app-select>
            `, {
  noticeKey: 'streamFrame.deriveLatchAngMinSpeed',
  ctx: controlContext,
  tip: "Choose the minimum spin speed needed before the experimental spin latch takes effect. Keep the default unless testing that mode.\n\nAngular min speed: the spin channel's own latch gate - wrist snaps above this replay their peak spin at release, gentler rotation stays live (6 is a deliberate flick; casual regrabs sit far below). Input prefilter median3: cleans single-frame network position spikes BEFORE velocity is derived, at one sample of lag - the recommended fix for jitter tails and twitchy held objects. Off restores raw input for A/B.",
  reset: { can: settings.deriveLatchAngMinSpeed != defaults.deriveLatchAngMinSpeed || settings.derivePreFilter != defaults.derivePreFilter, on: () => { galaxy.reset('deriveLatchAngMinSpeed'); galaxy.reset('derivePreFilter'); } }
            }));
body.push(fieldRow(t('Input Pre-Smoothing (ms) / Scope'), html`
      ${numberControl('streamFrame.derivePreSmoothMs', { value: settings.derivePreSmoothMs, ctx: controlContext, onCommit: value => { settings.derivePreSmoothMs = value; save(); } })}
      <app-select .value=${settings.derivePreSmoothScope} .options=${[{ value: 'direction', label: 'Direction only (recommended)' }, { value: 'both', label: 'Both direction and speed' }]} @change=${(e: CustomEvent) => { settings.derivePreSmoothScope = e.detail; save(); }}></app-select>
            `, {
  noticeKey: 'streamFrame.derivePreSmoothMs',
  ctx: controlContext,
  tip: "Choose which parts of motion data receive the optional pre-filter. Different scopes can change both responsiveness and noise.\n\nSmooths the raw tracking stream BEFORE anything is derived from it, with adjustable strength (0 = off; try 10-25; capped at 100). Scope 'Direction only' cleans what the throw direction and rendered-hand prediction see while speed is still derived from the exact positions - the recommended way to calm jittery hands without losing throw power. 'Both' also feeds the smoothed stream to the speed derivation: maximum calm, slight peak lag. Works alongside the median-of-3 spike filter.",
  reset: { can: settings.derivePreSmoothMs != defaults.derivePreSmoothMs || settings.derivePreSmoothScope != defaults.derivePreSmoothScope, on: () => { galaxy.reset('derivePreSmoothMs'); galaxy.reset('derivePreSmoothScope'); } }
            }));
body.push(fieldRow(t('Split Direction Source'), html`
      <app-select .value=${settings.deriveDirSource} .options=${[{ value: 'secant', label: 'Position secant (recommended)' }, { value: 'runtime', label: 'Runtime report direction' }, { value: 'window', label: 'Window average (original)' }]} @change=${(e: CustomEvent) => { settings.deriveDirSource = e.detail; save(); }}></app-select>
            `, {
  tip: "Choose where the motion-direction estimate comes from. The choices use different sample histories and can behave differently around release.\n\nWhere the throw DIRECTION comes from when a Split Direction toggle is on (magnitude always comes from the smoothed estimate). Position secant: direction of the raw hand displacement over the last ~25-70ms - very noise resistant, small fixed lag; the recommended default. Runtime report: direction of the driver's own (heavily smoothed) velocity - device-side sensor fusion, smooth but more lagged. Window average: the original weighted average of recent estimates - kept for A/B, weakest against correlated noise. After changing this, flip a Split toggle off and on to get a fresh confirmation log line.",
  reset: { can: settings.deriveDirSource != defaults.deriveDirSource, on: () => { galaxy.reset('deriveDirSource'); } }
            }));
body.push(fieldRow(t('Split Magnitude Source'), html`
      <app-select .value=${settings.deriveMagSource} .options=${[{ value: 'vector', label: 'Vector length (original)' }, { value: 'scalar', label: 'Scalar speed (recommended test)' }]} @change=${(e: CustomEvent) => { settings.deriveMagSource = e.detail; save(); }}></app-select>
            `, {
  tip: "Choose where the motion-speed estimate comes from. Compare with measured throws rather than assuming a different source is more accurate.\n\nWhere the throw SPEED comes from when a Split Direction toggle is on. Vector: length of the smoothed velocity vector (original; components pointing in changing directions partially cancel inside the average, which both jitters and under-reads mid-swing). Scalar: the speed itself is smoothed with the same adaptive time constant - no cancellation, less jitter for the same responsiveness. Recommended test: Scalar, combined with Tau Fast raised to ~15-20 (direction no longer pays for a slower magnitude filter since it comes from the secant).",
  reset: { can: settings.deriveMagSource != defaults.deriveMagSource, on: () => { galaxy.reset('deriveMagSource'); } }
            }));
body.push(settingFieldRow('streamFrame.deriveReleaseLatch', html`
      <app-switch .checked=${!!settings.deriveReleaseLatch} @change=${(e: CustomEvent) => { settings.deriveReleaseLatch = e.detail; save(); }}></app-switch>
      <span>W</span>
      ${numberControl('streamFrame.deriveLatchWindowMs', { value: settings.deriveLatchWindowMs, ctx: controlContext, onCommit: value => { settings.deriveLatchWindowMs = value; save(); } })}
      <span>H</span>
      ${numberControl('streamFrame.deriveLatchHoldMs', { value: settings.deriveLatchHoldMs, ctx: controlContext, onCommit: value => { settings.deriveLatchHoldMs = value; save(); } })}
      <span>S</span>
      ${numberControl('streamFrame.deriveLatchMinSpeed', { value: settings.deriveLatchMinSpeed, ctx: controlContext, onCommit: value => { settings.deriveLatchMinSpeed = value; save(); } })}
            `, {
  noticeKey: 'streamFrame.deriveLatchWindowMs',
  ctx: controlContext,
  tip: "Retain a recent speed peak briefly around release in the legacy filter. This can change throw strength and may exaggerate a noisy peak.\n\nFixes throws that come out weak or die mid-air: field data shows the input release event often trails the hand motion, so about a quarter of throws sample the velocity AFTER the hand already slowed. When on, the moment your trigger/grip release arrives, the output replays the strongest recent motion (window below) for the hold duration - full strength for the first half, fading after. Normal throws that release at the peak are unaffected. The three numbers: peak window ms / hold ms / minimum speed to engage (m/s).",
  reset: { can: settings.deriveReleaseLatch != defaults.deriveReleaseLatch, on: () => { galaxy.reset('deriveReleaseLatch'); } }
            }));
body.push(fieldRow(t('Split Direction Window (ms) / Weight Power'), html`
      <span>W</span>
      ${numberControl('streamFrame.deriveDirWindowMs', { value: settings.deriveDirWindowMs, ctx: controlContext, onCommit: value => { settings.deriveDirWindowMs = value; save(); } })}
      <span>P</span>
      ${numberControl('streamFrame.deriveDirWeightPow', { value: settings.deriveDirWeightPow, ctx: controlContext, onCommit: value => { settings.deriveDirWeightPow = value; save(); } })}
            `, {
  noticeKey: 'streamFrame.deriveDirWindowMs',
  ctx: controlContext,
  tip: "Choose how older samples are weighted when averaging motion direction. Recent-sample weighting reacts faster but may be less steady.\n\nWindow: how far back the direction average looks (clamped 5-200 in the driver). Shorter follows wrist snaps tighter but averages less noise. Weight power: how strongly fast samples dominate (speed^power weighting); 2 is a good default, higher approaches 'direction of the single fastest sample', 0 is an unweighted average.",
  reset: { can: settings.deriveDirWindowMs != defaults.deriveDirWindowMs || settings.deriveDirWeightPow != defaults.deriveDirWeightPow, on: () => { galaxy.reset('deriveDirWindowMs'); galaxy.reset('deriveDirWeightPow'); } }
            }));
body.push(fieldRow(t('Field-retired experiments - kept for reproducibility. Each lost a live test. Values here stay ACTIVE while hidden; re-test only if the transport fresh-rate materially improves.'), html`

            `, {
  reset: { can: true, on: () => { galaxy.resetGraveyard(); } }
            }));
        body.push(noteRow(t('This reset restores the existing field-retired defaults across both settings pages; other experiment values are kept.')));
        body.push(noteRow(html`<a href="#/stream-frame?section=graveyard">${t('Open image experiments')}</a>`));
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
