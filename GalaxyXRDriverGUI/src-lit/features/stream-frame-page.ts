// Stream Frame (Image Settings) page, ported from the Angular template (2026-09-20 Lit/Fluent migration).
// Every conditional, field, tip, reset scope and control binding from the original
// template is preserved 1:1; the only interpretation layer is the control
// adapters (app-switch / app-select / app-number / app-slider) whose events
// were verified against the pinned @fluentui/web-components package.
import { html, nothing, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';
import { css } from 'lit';
import { BasePage, settingFieldRow, fieldRow, noteRow, sectionRow, sectionHeading, sectionGroup, fieldStyles, numberControl, choiceControl, sliderControl } from './page-base';
import { t } from '../locale/i18n';
import { pageIntro, statusMessage } from '../ui/presentation';
import { encoderTapStatus, encoderEvidence, expiredEncoderEvidence } from '../domain/encoder-tap-status';
import { spacewarpStatus } from '../domain/spacewarp-status';
import { isForcedHalfRate, modeForForceSwitch, spacewarpPublication } from '../domain/spacewarp-modes';
import { codecSwitchState } from '../domain/codec-selection';
import { ofxrCanArm, ofxrDisabledReason } from '../domain/ofxr';
import type { OfxrPreferences, OfxrStatus } from '../domain/types';
import { codecEncoderDefaults } from '../state/galaxy-settings';
import { crossFieldIssues } from '../domain/control-specs';
import { BITRATE_CURVE_FAMILIES } from '../domain/bitrate-curve';
import { open } from '@tauri-apps/plugin-dialog';
import '../ui/controls';
import './driver-banner';
import './system-ready';

@customElement('app-stream-frame-page')
export class StreamFramePage extends BasePage {
  private runtimeTimer?: ReturnType<typeof setTimeout>;
  private runtimeExpiryTimer?: ReturnType<typeof setTimeout>;
  private evidenceExpiryTimer?: ReturnType<typeof setTimeout>;
  private runtimeUnsub?: () => void;
  private evidenceUnsub?: () => void;
  private ofxrUnsubs: Array<() => void> = [];
  // 2026-10-18: extended for the hidden-window guard in updateRuntimeEvidence.
  // Becoming visible again re-runs updateRuntimeEvidence once (re-render plus
  // expiry timer re-arm); hiding keeps the direct requestUpdate from before.
  // The listener stays registered exactly once (connectedCallback add,
  // disconnectedCallback remove).
  private readonly onVisibilityChange = () => {
    if (document.visibilityState !== 'hidden') {
      // A transient status failure latches 'unavailable'; regaining visibility
      // is the bounded retry point (one status call per switch back).
      void this.ctx.ofxr.refresh();
      this.updateRuntimeEvidence();
    } else this.requestUpdate();
  };
  private pollGeneration = 0;
  private get ofxrStatus(): OfxrStatus | undefined { return this.ctx.ofxr.status(); }
  private get ofxrError(): string | undefined { return this.ctx.ofxr.error(); }
  // 2026-10-19: the graph opens in its own window; this only reports a failure
  // to open it.
  private curveWindowError?: string;
  private async openCurveWindow(): Promise<void> {
    // Same locale segment boot() resolves from the page path.
    const locale = window.location.pathname.split('/').filter(Boolean)[0] ?? 'en-US';
    try {
      await this.ctx.curvePreview.open(locale);
      this.curveWindowError = undefined;
    } catch (error) {
      this.curveWindowError = String(error);
      console.error('Curve preview window failed to open', error);
    }
    this.requestUpdate();
  }
  private updateRuntimeEvidence(): void {
    // 2026-10-18: while the window is hidden (minimized/occluded), skip the
    // re-render and do not re-arm the expiry timers — the 2 s poll
    // subscriptions would otherwise churn requestUpdate and amplify low fps
    // during window drags. A return to visible re-runs this once through
    // onVisibilityChange, so no evidence state is lost, only deferred.
    if (document.visibilityState === 'hidden') return;
    this.requestUpdate();
    if (this.runtimeExpiryTimer !== undefined) clearTimeout(this.runtimeExpiryTimer);
    if (this.evidenceExpiryTimer !== undefined) clearTimeout(this.evidenceExpiryTimer);
    const checkedAt = this.ctx.startup.status()?.checkedAt;
    // Expire evidence independently: an unresolved native poll cannot keep
    // the previous confirmed-OFF badge alive indefinitely (2026-09-30).
    if (checkedAt !== undefined) this.runtimeExpiryTimer = setTimeout(() => {
      // 2026-10-18: the expiry render waits for a visible window; a visible
      // transition re-runs updateRuntimeEvidence, which re-arms this timer.
      if (document.visibilityState !== 'hidden') this.requestUpdate();
    }, Math.max(0, checkedAt + 5001 - Date.now()));
    // Expired encoder evidence triggers a real refresh of the runtime status
    // (2026-10-16), not merely a waiting re-render: the rejection keeps its
    // age on screen until a newer observation replaces it.
    const observedAt = this.ctx.dis.values()?.encoderTap?.observedAt;
    if (observedAt !== undefined) this.evidenceExpiryTimer = setTimeout(() => {
      if (document.visibilityState !== 'hidden') void this.ctx.startup.refresh().then(() => this.requestUpdate());
    }, Math.max(0, observedAt + 5001 - Date.now()));
  }
  private async pollRuntime(generation: number): Promise<void> {
    if (!this.isConnected || generation !== this.pollGeneration) return;
    if (document.visibilityState !== 'hidden') await this.ctx.startup.refresh();
    if (this.isConnected && generation === this.pollGeneration) {
      this.runtimeTimer = setTimeout(() => { void this.pollRuntime(generation); }, 2000);
    }
  }
  connectedCallback(): void {
    super.connectedCallback();
    this.runtimeUnsub = this.ctx.startup.status.subscribe(() => this.updateRuntimeEvidence());
    this.evidenceUnsub = this.ctx.dis.values.subscribe(() => this.updateRuntimeEvidence());
    this.ofxrUnsubs = [this.ctx.ofxr.status, this.ctx.ofxr.error, this.ctx.ofxr.changing]
      .map(value => value.subscribe(() => this.requestUpdate()));
    void this.ctx.ofxr.refresh();
    this.updateRuntimeEvidence();
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    void this.pollRuntime(++this.pollGeneration);
  }
  disconnectedCallback(): void {
    ++this.pollGeneration;
    if (this.runtimeTimer !== undefined) clearTimeout(this.runtimeTimer);
    if (this.runtimeExpiryTimer !== undefined) clearTimeout(this.runtimeExpiryTimer);
    if (this.evidenceExpiryTimer !== undefined) clearTimeout(this.evidenceExpiryTimer);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.runtimeUnsub?.();
    this.evidenceUnsub?.();
    for (const stop of this.ofxrUnsubs.splice(0)) stop();
    super.disconnectedCallback();
  }
  private async restoreEncoder(): Promise<void> {
    await this.ctx.startup.refresh();
    if (this.ctx.startup.status()?.steamvrRunning !== false) return;
    const report = await this.ctx.sds.restoreSteamLinkEncoderBehaviour();
    if (!report) return;
    this.ctx.startup.invalidate();
    this.ctx.checks.clear();
    await this.ctx.dialog.message(t('Restore Steam Link encoder behaviour'),
      t('NVENC Tap is OFF. Saved tuning was kept. Start SteamVR to use Steam Link\'s encoder parameters.'),
      [t('Recovery backup') + ': ' + report.backupPath, ...report.unresolvedItems].join('\n'));
    await this.ctx.startup.refresh();
    this.requestUpdate();
  }
  // The application-owned service also restores the saved session at startup.
  private ofxrPreferences(): OfxrPreferences { return this.ctx.ofxr.preferences(); }
  private setOfxrEnabled(enabled: boolean): Promise<void> { return this.ctx.ofxr.setEnabled(enabled); }
  private selectOfxrVersion(version: string): Promise<void> { return this.ctx.ofxr.selectVersion(version); }
  private async importOfxr(): Promise<void> {
    try {
      const selected = await open({ directory: true, multiple: false, title: t('Select the OFXR Bridge build folder') });
      if (typeof selected === 'string') await this.ctx.ofxr.importBuild(selected);
    } catch (error) {
      this.ctx.ofxr.setError(String(error instanceof Error ? error.message : error));
      this.requestUpdate();
    }
  }
  private reinstallOfxr(): Promise<void> { return this.ctx.ofxr.reinstall(); }
  private removeOfxr(): Promise<void> { return this.ctx.ofxr.remove(); }
  private updateOfxr(patch: Partial<OfxrPreferences>): Promise<void> { return this.ctx.ofxr.update(patch); }
  private setSpacewarp(enabled: boolean): Promise<void> { return this.ctx.ofxr.setSpacewarp(enabled); }
  // 2026-10-19 (owner directive): a codec switch is live-session-sensitive, so
  // the runtime is re-checked when the user commits it. A refused switch puts
  // the control back on the saved codec; the setting never changes silently.
  private async selectCodec(select: EventTarget | null, codec: number): Promise<void> {
    await this.ctx.startup.refresh();
    const galaxy = this.ctx.galaxy;
    if (!galaxy.settings) return;
    if (codecSwitchState(this.ctx.startup.status()) !== 'allowed') {
      const control = select as unknown as { value?: string } | null;
      if (control) control.value = String(galaxy.settings.nvencCodec);
      this.requestUpdate();
      return;
    }
    if (codec === galaxy.settings.nvencCodec) return;
    galaxy.settings.nvencCodec = codec;
    galaxy.applyCodecEncoderDefaults(codec);
    this.requestUpdate();
  }
  static styles = [fieldStyles, css`
    :host { display: block; padding: 0 1rem 2rem 1rem; }
    .rgb-control { display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; }
    .preset-buttons { display: inline-flex; align-items: center; gap: 0.35rem; flex-wrap: wrap; }
    .preset-buttons fluent-button { min-width: 4.6rem; }
    .stored-chip {
      display: inline-flex; align-items: center; min-height: 32px; padding: 0 0.65rem;
      border: 1px dashed var(--colorNeutralStroke1); border-radius: 6px;
      color: var(--colorNeutralForeground2); font-variant-numeric: tabular-nums;
      background: var(--colorNeutralBackground2); white-space: nowrap;
    }
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
    @container page (max-width: 700px) { .range-control { grid-template-columns: 1fr; } }
    .qp-pair { display: inline-flex; align-items: flex-end; gap: 0.4rem; }
    .qp-label { align-self: center; color: var(--colorNeutralForeground3); font-size: 0.85rem; }
    .axis-field { display: inline-flex; align-items: flex-end; gap: 0.35rem; }
    .axis-label { align-self: center; color: var(--colorNeutralForeground3); font-size: 0.85rem; font-weight: 600; min-width: 1ch; }
    .evidence-strip {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr));
      gap: 8px; margin: 8px 0 12px; padding: 10px 12px;
      border: 1px solid var(--colorNeutralStroke2); border-radius: 8px;
      background: var(--colorNeutralBackground2);
    }
    .evidence-strip > span { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .evidence-strip .k {
      color: var(--colorNeutralForeground3); font-size: 0.75rem;
      text-transform: uppercase; letter-spacing: 0.04em;
    }
    .evidence-strip .v { font-variant-numeric: tabular-nums; font-weight: 600; overflow-wrap: anywhere; }
    .spacewarp-controls { display: inline-flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
    .rgb-control span { opacity: 0.75; font-size: 90%; }
    .matrix-control { flex-direction: column; align-items: flex-start; gap: 0.3rem; }
    .note-inline { opacity: 0.75; font-size: 0.9rem; }

  `];


  render() {
    const galaxy = this.ctx.galaxy;
    if (!galaxy.settings) return html``;
    const settings = galaxy.settings;
    const defaults = galaxy.defaults;
    const advancedMode = galaxy.advancedMode || this.revealAdvanced;
    const vendor = galaxy.vendor;
    const galaxyXr = galaxy.galaxyXr;
    const sections = galaxy.sections();
    const save = () => { galaxy.save(); this.requestUpdate(); };
    // 2026-10-30: one context for every spec-driven control. Tile width resolves
    // its ceiling from the selected codec; keyframe budget applies only under CBR.
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
    const evidence = encoderEvidence(this.ctx.dis.values(), this.ctx.startup.status());
    const parts: TemplateResult[] = [pageIntro(t('Image Settings'), t('Stream quality, color, and sharpening.'))];
if (settings) {
      parts.push(html`<app-driver-enable-banner .ctx=${this.ctx}></app-driver-enable-banner>`);
if (galaxy.calibrationActive()) {
          parts.push(statusMessage('warning', t('Calibration is active'), t('Stop calibration before playing.'),
            html`<fluent-button appearance="outline" @click=${() => { galaxy.stopCalibration(); this.requestUpdate(); }}>${t('Stop calibration')}</fluent-button>`));
}
        {
          const crossField = crossFieldIssues({
            'streamFrame.nvencMaxQp': settings.nvencMaxQp,
            'streamFrame.nvencMinQp': settings.nvencMinQp,
            'streamFrame.nvencMinQpIntra': settings.nvencMinQpIntra,
            'streamFrame.nvencVuiFullRange': settings.nvencVuiFullRange,
            'streamFrame.postPack.enable': settings.postPack.enable,
            'streamFrame.postPack.limitedRange': settings.postPack.limitedRange,
            'streamFrame.blackFloor.shadowLift': settings.blackFloor.shadowLift,
            'streamFrame.blackFloor.floorCode': settings.blackFloor.floorCode,
            'streamFrame.blackFloor.kneeCode': settings.blackFloor.kneeCode,
          }).filter(issue => issue.key !== 'streamFrame.distortion.annulus.rMin');
          if (crossField.length) {
            parts.push(statusMessage('warning', t('Conflicting settings'),
              crossField.map(issue => t(issue.message)).join(' ')));
          }
        }
if (vendor) {
        const codecDef = codecEncoderDefaults[settings.nvencCodec ?? 0] ?? codecEncoderDefaults[0];
        parts.push(sectionHeading(t('Stream Quality'), 0, 'stream-quality'));
          parts.push(fieldRow(t('Tile Width'), html`
      <span class="preset-buttons">
        ${[1024, 1536, 2048].filter(value => value <= (settings.nvencCodec === 1 ? 1024 : 2048)).map(value => html`<fluent-button
          appearance=${galaxy.streamQualityValues.width === value ? 'primary' : 'outline'}
          @click=${() => { galaxy.setStreamQualityValue('width', value); save(); }}>${value}</fluent-button>`)}
      </span>
      ${![1024, 1536, 2048].includes(galaxy.streamQualityValues.width) ? html`
        <span class="stored-chip">${t('Stored: {value} px', { value: galaxy.streamQualityValues.width })}</span>
      ` : nothing}
          `, {
  tip: t("Tile width is a preset class sent unchanged for every codec. Each frame contains four stacked tiles. The codec and GPU determine the supported dimensions; unsupported requests report an encoder error instead of changing resolution. The selected codec caps the tile: H.264 1024, HEVC/AV1 2048, because tile × 4 must fit the encoder's height. A stored value outside the presets is kept and shown here; choose a preset to replace it. Requires a SteamVR restart.\n\nValue: galaxyXr.customStreamFormatWidth (settings.json), applied through the shared stream-quality values. SteamVR side — streamFormatWidth/encodeWidth in steamvr.vrsettings; also feeds the encoder tap's tile answers."),
  reset: { can: galaxy.streamQualityValues.width != codecDef.streamFormatWidth, on: () => { galaxy.setStreamQualityValue('width', codecDef.streamFormatWidth); save(); } }
          }));
          if (settings.nvencCodec === 1 && galaxy.streamQualityValues.width > 1024) {
            parts.push(statusMessage('warning', t('H.264 tile width above 1024'),
              t('Steam Link negotiates H.264 at 1024 × 4096. A tile width above 1024 requests a taller four-tile frame and will fail to encode. Your stored value is kept and shown here; reset Tile Width to use 1024.')));
          }
          parts.push(fieldRow(t('Max Bitrate (Mbit/s)'), html`
      <div class="range-control">
        ${numberControl('galaxyXr.customBandwidthMbit', {
          value: galaxy.streamQualityValues.bandwidth,
          ctx: controlContext,
          onCommit: value => { galaxy.setStreamQualityValue('bandwidth', value); save(); },
        })}
        <div class="range-track">
          ${sliderControl('galaxyXr.customBandwidthMbit', {
            value: galaxy.streamQualityValues.bandwidth,
            onChange: value => { galaxy.setStreamQualityValue('bandwidth', value); save(); },
          })}
          <span class="range-scale" aria-hidden="true"><span>1</span><span>1500 Mbit/s</span></span>
        </div>
      </div>
          `, {
  tip: t("Set the stream bandwidth budget and the applied encoder budget.\n\nFor Galaxy XR, Max Bitrate above 350 Mbit/s raises the adaptive streamer request by Max Bitrate / 350 before the selected curve and constancy are evaluated. At or below 350, Linear at 0% follows the streamer request up to Max Bitrate. The entered Max Bitrate is the encoder maximum; Force CBR applies it directly as both average and maximum. Headroom can reserve part of the budget and lower the average. The budget is also written to targetBandwidth and recommendedBandwidthMbit for pacing.\n\nA target is not measured encoded output or delivered bitrate. Takes effect at the next SteamVR start or headset connect. Requires a SteamVR restart.\n\nValue: galaxyXr.customBandwidthMbit (settings.json), with the existing Advanced bandwidth and separate encoder overrides."),
  reset: { can: galaxy.streamQualityValues.bandwidth != codecDef.bandwidthMbit, on: () => { galaxy.setStreamQualityValue('bandwidth', codecDef.bandwidthMbit); save(); } }
          }));
        if (!Number.isInteger(galaxy.streamQualityValues.width) || galaxy.streamQualityValues.width <= 0
            || !Number.isInteger(galaxy.streamQualityValues.bandwidth) || galaxy.streamQualityValues.bandwidth <= 0) {
          parts.push(statusMessage('error', t('Invalid stream setting'), t('Tile width and bandwidth must be positive whole numbers. Entered values are kept until corrected.')));
        }
        const expired = expiredEncoderEvidence(this.ctx.dis.values(), this.ctx.startup.status());
        if (settings.nvencTap || evidence?.initError || expired?.tap.initError) {
          const names = ['HEVC', 'H.264', 'AV1'];
          if (evidence) {
            if (evidence.initError) parts.push(statusMessage('error', t('Encoder initialization failed'), evidence.initError));
            if (evidence.error || evidence.pictureError) parts.push(statusMessage('error', t('Encoder request failed'), evidence.error || evidence.pictureError || ''));
            if ((evidence.effectiveCodec ?? -1) >= 0) {
              const codecName = names[evidence.effectiveCodec ?? -1] ?? t('Unknown');
              const rateControl = evidence.effectiveRateControl === 2 ? 'CBR'
                : evidence.effectiveRateControl === 1 ? 'VBR' : t('Unknown');
              const split = evidence.effectiveSplit === -1 ? t('Not applicable') : evidence.effectiveSplit ?? t('Unknown');
              parts.push(html`<div class="evidence-strip">
                <span><span class="k">${t('Codec')}</span><span class="v">${codecName}</span></span>
                <span><span class="k">${t('Frame')}</span><span class="v">${evidence.encodeWidth ?? 0} × ${evidence.encodeHeight ?? 0}</span></span>
                <span><span class="k">${t('Rate control')}</span><span class="v">${rateControl}</span></span>
                <span><span class="k">${t('Split')}</span><span class="v">${split}</span></span>
              </div>`);
            }
            else parts.push(noteRow(t('No encoder configuration has been accepted in this session.')));
          } else {
            // Expiry (2026-10-16): the last rejection of the verified process
            // stays visible with its age; it must never appear as merely
            // waiting. updateRuntimeEvidence also schedules the real status
            // refresh that replaces this snapshot.
            if (expired?.tap.initError) {
              parts.push(statusMessage('error', t('Encoder initialization failed'),
                t('Last observed encoder rejection, {seconds} seconds ago: {error}',
                  { seconds: Math.max(0, Math.floor(expired.ageMs / 1000)), error: expired.tap.initError })));
            }
            const refusal = expired?.tap.error || expired?.tap.pictureError;
            if (refusal) {
              parts.push(statusMessage('error', t('Encoder request failed'),
                t('Last observed encoder rejection, {seconds} seconds ago: {error}',
                  { seconds: Math.max(0, Math.floor((expired!.ageMs ?? 0) / 1000)), error: refusal || '' })));
            }
          }
        }
        parts.push(settingFieldRow('streamFrame.nvencTap', html`
      <app-switch .checked=${!!settings.nvencTap} @change=${(e: CustomEvent) => { settings.nvencTap = e.detail; save(); }}></app-switch>
            `, {
  tip: t("Allow this driver to adjust NVIDIA's video encoder. OFF bypasses NVIDIA parameter overrides and post-pack processing; saved tuning is kept. Stream quality, bandwidth, resolution and 10-bit requests still apply. Requires a SteamVR restart.\n\nAn encoder already created with the tap can retain its earlier parameters and API version until SteamVR is closed. The restore action requires SteamVR to be stopped so the next session starts without the tap.\n\nValue: streamFrame.nvencTap (settings.json). Encoder side — hooks NVIDIA NVENC session creation and reconfiguration."),
  reset: { can: settings.nvencTap != defaults.nvencTap, on: () => { galaxy.reset('nvencTap'); } }
            }));
        // 2026-10-26 (owner directive): Automatic is the saved mode 0 and the
        // separate Force half-rate switch stores mode 1. Both values are
        // user-owned; an automatic runtime transition never rewrites them.
        const spacewarpMode = settings.spacewarpMode ?? 0;
        parts.push(settingFieldRow('streamFrame.spacewarpEnable', html`
      <span class="spacewarp-controls"><app-switch .checked=${!!settings.spacewarpEnable} ?disabled=${this.ctx.ofxr.changing()} @change=${(e: CustomEvent) => { void this.setSpacewarp(e.detail); }}></app-switch></span>
            `, {
  tip: `${t("Applies live to the running stream. Async Spacewarp synthesizes frames on the headset client when the stream misses a display tick. It needs the GXR spacewarp client patch (experimental) installed on the headset; without it the stream shows extra held frames instead of synthesized frames. When your graphics card supports optical flow (NVIDIA Turing generation or newer with Optical Flow hardware), prefer Optical Flow: it synthesizes on the PC with hardware motion vectors and needs no headset patch. Only one synthesis mode runs at a time: enabling this turns Optical Flow off, and enabling Optical Flow turns this off.\n\nAutomatic enters half rate after the application cadence stays below 90% of the headset refresh for 500 ms, and returns to normal late-frame recovery after it stays at or above 97% for two seconds. Force half-rate keeps half rate on regardless of game FPS. Half rate targets 45 selected stream frames plus 45 synthetic display slots at 90 Hz (36/36 at 72 Hz); it does not throttle the game or promise upstream GPU savings, and selected stream frames may already contain repeated or reprojected game content.\n\nValue: streamFrame.spacewarpEnable and streamFrame.spacewarpMode (settings.json). Stream side — publishes the effective mode live to the running vrlink stream; the headset client synthesizes the frames.")}`,
  reset: { can: settings.spacewarpEnable != defaults.spacewarpEnable, on: () => { galaxy.reset('spacewarpEnable'); } }
            }));
        parts.push(settingFieldRow('streamFrame.spacewarpMode', html`
      <span class="spacewarp-controls"><app-switch .checked=${isForcedHalfRate(spacewarpMode)} ?disabled=${!settings.spacewarpEnable || this.ctx.ofxr.changing()} @change=${(e: CustomEvent) => { settings.spacewarpMode = modeForForceSwitch(!!e.detail); save(); }}></app-switch></span>
            `, {
  tip: t("Keep half-rate presentation on regardless of game FPS. Off is Automatic: the driver publishes normal late-frame recovery until the measured application cadence stays below 90% of the headset refresh for 500 ms, then half rate; it returns to normal after the cadence stays at or above 97% for two seconds. The measurement uses the application's frame timings, never compositor, encoder or decoder FPS. Automatic and forced transitions publish live to the running stream without rewriting your saved enable/mode choice.\n\nHalf rate is client-side frame selection: 45 selected stream frames plus 45 synthetic display slots at 90 Hz (36/36 at 72 Hz). It does not throttle the game or promise upstream GPU savings, and selected stream frames may already contain repeated or reprojected game content.\n\nValue: streamFrame.spacewarpMode (settings.json). 0 = Automatic, 1 = Forced half rate. Changes apply live to the running stream."),
  reset: { can: spacewarpMode != defaults.spacewarpMode, on: () => { galaxy.reset('spacewarpMode'); } }
            }));
        {
          const spacewarpState = spacewarpStatus(!!settings.spacewarpEnable, this.ctx.dis.values(), this.ctx.startup.status());
          const publication = spacewarpPublication(this.ctx.dis.values()?.spacewarp);
          const deliveredNote = publication.mode === 'half' ? t('The driver currently publishes half rate.')
            : publication.mode === 'late' ? t('The driver currently publishes late-frame recovery.')
              : t('The published mode is not reported by this driver.');
          const modeNote = publication.pending ? `${deliveredNote} ${t('A mode change is pending publication.')}` : deliveredNote;
          parts.push(statusMessage(spacewarpState === 'on' ? 'success' : spacewarpState === 'waiting' ? 'warning' : 'info',
            t(spacewarpState === 'on' ? 'Async Spacewarp: Active' : spacewarpState === 'waiting' ? 'Async Spacewarp: Waiting for stream' : 'Async Spacewarp: Off'),
            spacewarpState === 'on'
              ? t('Green confirms that the driver published the request. It does not guarantee that the headset is synthesizing frames or that motion will be smoother. {mode} Frames are synthesized only while the headset client patch is active.', { mode: modeNote })
              : spacewarpState === 'waiting' ? t('The saved value is not confirmed by the running stream yet. Green confirms that the driver published the request. It does not guarantee that the headset is synthesizing frames or that motion will be smoother. When this persists while streaming, the headset needs the GXR spacewarp client patch (experimental) to synthesize frames; without it the stream shows extra held frames instead of synthesized frames.')
              : t('The stream is left unchanged; no frames are synthesized.')));
        }
        // 2026-10-19 (owner directive): a codec switch made while SteamVR is
        // running would land in settings.json under a live session instead of
        // waiting for the next start, so the selector stays disabled until the
        // runtime is fresh and confirmed stopped.
        const codecState = codecSwitchState(this.ctx.startup.status());
        parts.push(settingFieldRow('streamFrame.nvencCodec', html`
      <app-select ?disabled=${!settings.nvencTap || codecState !== 'allowed'} .value=${settings.nvencCodec} .options=${[{ value: 0, label: 'HEVC (default)' }, { value: 1, label: 'H.264' }, { value: 2, label: 'AV1' }]} @change=${(e: CustomEvent) => { void this.selectCodec(e.currentTarget, e.detail); }}></app-select>
            `, {
  tip: t("Choose the video codec for the streamed video. HEVC (default) keeps Steam Link's own encoder behaviour; H.264 and AV1 are forced through the NVENC Tap override and need the Steam Link client Codecs Support patch on the headset to decode. The override rewrites the encoder's codec and profile when the encoder session is created and on every reconfigure; H.264 runs 8-bit; AV1 follows the SDR 10-bit baseline (10-bit 4:2:0 when on). With the SDR 10-bit baseline off, a stored explicit 10-bit request stays user tuning and asks the HEVC or AV1 session class for 10-bit. Switching applies the selected codec's optimized Tile Width, Bandwidth and encoder default rows at once; afterwards every value can be changed freely, and switching codecs again loads that codec's optimized values. Selecting H.264 turns the SDR 10-bit baseline off (its toggle on Driver Settings shows Off and is disabled until another codec is selected). Requires a SteamVR restart and reconnect.\n\nValue: streamFrame.nvencCodec (settings.json). Encoder side — rewrites the encoder session at create and every reconfigure; the Steam Link client must also support the codec.")
            }));
        if (!settings.nvencTap) {
          parts.push(noteRow(html`Requires the NVENC Tap — enable it above to choose a codec. With the tap off the codec choice is saved but not applied.`));
        } else if (codecState === 'running') {
          parts.push(noteRow(html`${t('Codec switching is disabled while SteamVR is running. Close SteamVR completely, then choose the codec. The saved choice applies at the next SteamVR session.')}`));
        } else if (codecState === 'unconfirmed') {
          parts.push(noteRow(html`${t('The SteamVR runtime check has not confirmed a stopped runtime, so codec switching stays disabled. It unlocks after a successful check; open Setup if this persists.')}`));
        }
        parts.push(fieldRow(t('Restore Steam Link encoder behaviour'), html`
          <fluent-button appearance="outline" ?disabled=${this.ctx.sds.installingDriver() || this.ctx.startup.status()?.steamvrRunning !== false}
            @click=${() => this.restoreEncoder()}>${t('Restore encoder behaviour')}</fluent-button>
        `, { tip: t("Disable NVENC Tap without deleting your custom tuning. Stream quality, bandwidth, resolution, 10-bit requests and other settings are kept. Close SteamVR completely before restoring.\n\nValue: streamFrame.nvencTap off + journal restore. Driver action — removes the encoder hook for the next session; needs SteamVR fully stopped.") }));
        if (!settings.nvencTap) {
          const runtime = this.ctx.startup.status();
          const state = encoderTapStatus(false, runtime);
          parts.push(statusMessage(state === 'restart-required' ? 'warning' : 'info',
            t(state === 'confirmed-off' ? 'NVENC Tap OFF confirmed' : state === 'restart-required' ? 'NVENC Tap OFF: restart required' : 'NVENC Tap OFF saved'),
            t(state === 'confirmed-off' ? 'The current driver process reports no NVENC hook. Your selected stream settings remain active.'
              : state === 'restart-required' ? 'This SteamVR process already installed the hook. Close SteamVR completely and start it again to clear the encoder session.'
              : 'Start SteamVR to verify OFF in a fresh driver process. Old or missing runtime information cannot confirm it.')));
          if (state === 'confirmed-off' && runtime?.encoderTap) {
            parts.push(noteRow(html`${t('Driver configuration')}: ${runtime.encoderTap.configPath}<br />
              ${t('Loaded driver')}: ${runtime.encoderTap.modulePath}`));
          }
        }
        parts.push(html`<div class="status-badge-row"><fluent-badge appearance="tint" color="informative">${t('SteamVR restart required')}</fluent-badge>
          <span>${t('After changing stream quality.')}</span></div>`);
}
parts.push(sectionHeading(t('Image Processing'), 0, 'image-processing'));
if (galaxy.imageEnhancementsEnabled) {
        parts.push(sectionGroup(t('Color'), 1, 'group', 'color'));

          parts.push(fieldRow(t('Brightness'), html`
      ${numberControl('streamFrame.brightness', { value: settings.brightness, ctx: controlContext, onCommit: value => { settings.brightness = value; save(); } })}
      ${sliderControl('streamFrame.brightness', { value: settings.brightness, onChange: value => { settings.brightness = value; save(); } })}
          `, {
  tip: t("Adjust the overall picture brightness. Lower values darken the image; this is a display preference, not a guarantee about panel lifespan.\n\nScales output brightness in the host image-processing path. Compare against a known neutral setting and avoid compensating for a video-range mismatch with brightness alone. Panel wear depends on many factors; this control does not provide a measured or guaranteed lifespan improvement.\n\nValue: streamFrame.brightness (settings.json). Driver side — per-frame brightness scale in the host image pipeline."),
  reset: { can: settings.brightness != defaults.brightness, on: () => { galaxy.reset('brightness'); } }
          }));
          parts.push(fieldRow(t('Saturation'), html`
      ${numberControl('streamFrame.saturation', { value: settings.saturation, ctx: controlContext, onCommit: value => { settings.saturation = value; save(); } })}
      ${sliderControl('streamFrame.saturation', { value: settings.saturation, onChange: value => { settings.saturation = value; save(); } })}
          `, {
  tip: t("Adjust the strength of colors. The neutral value keeps the original color saturation.\n\nIncrease or decrease the variation of the colors. 50 is neutral, 0 is grayscale.\n\nValue: streamFrame.saturation (settings.json). Driver side — per-frame color saturation; mirrored into the compositor-shader path."),
  reset: { can: settings.saturation != defaults.saturation, on: () => { galaxy.reset('saturation'); } }
          }));
          parts.push(fieldRow(t('Vibrance'), html`
      ${numberControl('streamFrame.vibrance', { value: settings.vibrance, ctx: controlContext, onCommit: value => { settings.vibrance = value; save(); } })}
      ${sliderControl('streamFrame.vibrance', { value: settings.vibrance, onChange: value => { settings.vibrance = value; save(); } })}
          `, {
  tip: t("Boost quieter colors without changing all colors equally. Use small adjustments to avoid an unnatural-looking picture.\n\nSmart saturation: changes muted colors the most and already vivid colors the least. Positive enriches dull colors with far less clipping and skin tone blowout than raw saturation; negative fades muted colors toward gray while vivid accents remain. 0 is off, stacks with Saturation.\n\nValue: streamFrame.vibrance (settings.json). Driver side — selective saturation boost for muted colors."),
  reset: { can: settings.vibrance != defaults.vibrance, on: () => { galaxy.reset('vibrance'); } }
          }));
          parts.push(fieldRow(t('Contrast'), html`
      ${numberControl('streamFrame.contrast', { value: settings.contrast, ctx: controlContext, onCommit: value => { settings.contrast = value; save(); } })}
      ${sliderControl('streamFrame.contrast', { value: settings.contrast, onChange: value => { settings.contrast = value; save(); } })}
          `, {
  tip: t("Adjust the difference between light and dark areas. Stronger contrast can hide details in shadows or highlights.\n\nContrast around the midpoint. 50 is neutral.\n\nValue: streamFrame.contrast (settings.json). Driver side — midpoint contrast; mirrored into the compositor-shader path."),
  reset: { can: settings.contrast != defaults.contrast, on: () => { galaxy.reset('contrast'); } }
          }));
          parts.push(fieldRow(t('Contrast Midpoint'), html`
      ${numberControl('streamFrame.contrastMidpoint', { value: settings.contrastMidpoint, ctx: controlContext, onCommit: value => { settings.contrastMidpoint = value; save(); } })}
      ${sliderControl('streamFrame.contrastMidpoint', { value: settings.contrastMidpoint, onChange: value => { settings.contrastMidpoint = value; save(); } })}
          `, {
  tip: t("Choose the brightness level around which contrast is adjusted. Change this only when the normal contrast control does not give the desired balance.\n\nThe brightness level from 0 to 100 percent of white that the contrast pivots around.\n\nValue: streamFrame.contrastMidpoint (settings.json). Driver side — the brightness pivot of the contrast curve."),
  reset: { can: settings.contrastMidpoint != defaults.contrastMidpoint, on: () => { galaxy.reset('contrastMidpoint'); } }
          }));
          parts.push(settingFieldRow('streamFrame.contrastLinear', html`
      <app-switch .checked=${!!settings.contrastLinear} @change=${(e: CustomEvent) => { settings.contrastLinear = e.detail; save(); }}></app-switch>
          `, {
  tip: t("Apply contrast in linear light rather than the usual display-encoded space. This changes the effect of the contrast control.\n\nApply the contrast in linear space instead of gamma space.\n\nValue: streamFrame.contrastLinear (settings.json). Driver side — applies contrast in linear light instead of gamma space."),
  reset: { can: settings.contrastLinear != defaults.contrastLinear, on: () => { galaxy.reset('contrastLinear'); } }
          }));
          parts.push(fieldRow(t('Gamma'), html`
      ${numberControl('streamFrame.gamma', { value: settings.gamma, ctx: controlContext, onCommit: value => { settings.gamma = value; save(); } })}
      ${sliderControl('streamFrame.gamma', { value: settings.gamma, onChange: value => { settings.gamma = value; save(); } })}
          `, {
  tip: t("Adjust midtone brightness without using the overall brightness control. The neutral pipeline value is 2.2.\n\nGamma of the output. 2.2 is neutral, lower brightens midtones. The driver does not clamp this value; 0 or a negative gamma is not usable, so the field refuses it.\n\nValue: streamFrame.gamma (settings.json). Driver side — output gamma; 2.2 neutral."),
  reset: { can: settings.gamma != defaults.gamma, on: () => { galaxy.reset('gamma'); } }
          }));
          parts.push(fieldRow(t('Color Multiplier'), html`
      <span class="axis-field"><span class="axis-label">R</span>
        ${numberControl('streamFrame.colorMultiplier.r', { value: settings.colorMultiplier.r, ctx: controlContext, label: t('Color multiplier, red'), onCommit: value => { settings.colorMultiplier.r = value; save(); } })}
      </span>
      <span class="axis-field"><span class="axis-label">G</span>
        ${numberControl('streamFrame.colorMultiplier.g', { value: settings.colorMultiplier.g, ctx: controlContext, label: t('Color multiplier, green'), onCommit: value => { settings.colorMultiplier.g = value; save(); } })}
      </span>
      <span class="axis-field"><span class="axis-label">B</span>
        ${numberControl('streamFrame.colorMultiplier.b', { value: settings.colorMultiplier.b, ctx: controlContext, label: t('Color multiplier, blue'), onCommit: value => { settings.colorMultiplier.b = value; save(); } })}
      </span>
          `, {
  tip: t("Adjust the red, green, and blue channels separately to correct a color tint. 1 on every channel leaves the balance unchanged.\n\nPer channel tint multiplier applied to the image. 1 for each channel is neutral.\n\nValue: streamFrame.colorMultiplier.r/g/b (settings.json). Driver side — per-channel tint multipliers."),
  reset: { can: settings.colorMultiplier.r != defaults.colorMultiplier.r || settings.colorMultiplier.g != defaults.colorMultiplier.g || settings.colorMultiplier.b != defaults.colorMultiplier.b, on: () => { galaxy.reset('colorMultiplier'); } }
          }));
          parts.push(fieldRow(t('Color Matrix'), html`
      <input type="text" .value=${galaxy.matrixText()} placeholder="empty = disabled" @input=${(e: Event) => { galaxy.onMatrixTextChanged((e.target as HTMLInputElement).value) }}></input>
      ${galaxy.matrixError() ? statusMessage('error', t('Color matrix could not be applied'), galaxy.matrixError()!) : html``}
          `, {
  tip: t("Apply a nine-value color correction matrix. This is an advanced calibration tool; an incorrect matrix can strongly distort colors.\n\nOptional 3x3 linear rgb matrix, row major, 9 comma separated numbers. Used for gamut or white point correction. Leave empty to disable.\n\nValue: streamFrame.srgbMatrix - 9 comma-separated values (settings.json). Driver side — 3x3 linear RGB matrix applied per frame; empty disables."),
  reset: { can: settings.srgbMatrix.length != 0, on: () => { galaxy.reset('srgbMatrix'); } }
          }));

        parts.push(sectionGroup(t('Image Enhancements'), 1, 'group', 'image-enhancements'));

          parts.push(fieldRow(t('Edge Smoothing (FXAA)'), html`
      <app-select .value=${settings.fxaa} .options=${[{ value: 'off', label: 'Off' }, { value: 'fast', label: 'Fast - in-pass (single pass, lightest)' }, { value: 'quality', label: 'Quality - separate pre-pass (best edges)' }]} @change=${(e: CustomEvent) => { settings.fxaa = e.detail; save(); }}></app-select>
          `, {
  tip: t("Reduce jagged edges with a post-processing filter. The quality mode does more work than the fast mode and may cost performance.\n\nFXAA applied BEFORE CAS so sharpening enhances resolved edges instead of amplifying jagged staircases. Best for titles with heavy edge shimmer (specular geometry, foliage, thin railings); slightly softens fine text - leave off for text-heavy apps. Fast: integrated into the main pass; CAS sharpens raw neighbors around the AA-resolved center (can faintly re-jag very strong edges at high CAS strength). Quality: a separate FXAA pre-pass, so CAS sees fully resolved edges - costs one extra full-frame pass and VRAM for an intermediate texture; falls back to Fast automatically (with a log line) if the pass shader or intermediate is unavailable. Check 'pixel shader ready (... fxaa: yes, fxaaPass: yes)' in the log after updating.\n\nValue: streamFrame.fxaa (settings.json). Driver side — FXAA pass applied before CAS."),
  reset: { can: settings.fxaa != defaults.fxaa, on: () => { galaxy.reset('fxaa'); } }
          }));
          parts.push(settingFieldRow('cas-sharpening', html`
      <app-select .width=${300} .value=${galaxy.casMode} .options=${[{ value: 'off', label: 'Off' }, { value: 'postpack', label: 'Post-pack — on the encoded frame (recommended)' }, { value: 'preencode', label: 'Pre-encode — full-resolution pass (AMD / tap off)' }]} @change=${(e: CustomEvent) => { galaxy.casMode = e.detail; save(); }}></app-select>
          `, {
  tip: t("Choose where contrast-adaptive sharpening is applied. The modes use different processing paths; avoid adding the same sharpening twice.\n\nContrast adaptive sharpening. POST-PACK (recommended, NVIDIA + NVENC Tap): runs on the frame the encoder actually sends - the foveated transport image - with separate strengths for the gaze region and the periphery; the periphery is sharpened after Steam Link downscales it, so it survives to the panel, at ~0.04 ms per frame. PRE-ENCODE: the older full-resolution pass on the eye textures; only for AMD GPUs or with the NVENC Tap off. Never run both.\n\nValue: streamFrame.cas.enable + streamFrame.postPack.enable/casEnable (settings.json). Driver + encoder sides — post-pack sharpening runs on the encoded frame through the tap; pre-encode is the full-resolution driver pass.")
          }));
if (galaxy.casMode === 'postpack' && !settings.nvencTap) {
            parts.push(statusMessage('info', t('Post-pack sharpening needs NVENC Tap'), t('Enable NVENC Tap in Encoder, or choose Pre-encode sharpening.')));
}
if (galaxy.casMode === 'postpack') {
            parts.push(fieldRow(t('Center Sharpness'), html`
      ${numberControl('streamFrame.postPack.foveaStrength', { value: settings.postPack.foveaStrength, ctx: controlContext, onCommit: value => { settings.postPack.foveaStrength = value; save(); } })}
      ${sliderControl('streamFrame.postPack.foveaStrength', { value: settings.postPack.foveaStrength, onChange: value => { settings.postPack.foveaStrength = value; save(); } })}
            `, {
  tip: t("Adjust sharpening in the high-detail center of the streamed image. Too much sharpening can create bright outlines or noise.\n\nSharpening for the gaze cut-out tile (1:1 render-target pixels), 0 to 1. Under CBR sharpening costs bits: spend them here.\n\nValue: streamFrame.postPack.foveaStrength (settings.json). Encoder side — post-pack sharpening of the gaze tile."),
  reset: { can: settings.postPack.foveaStrength != defaults.postPack.foveaStrength, on: () => { settings.postPack.foveaStrength = defaults.postPack.foveaStrength; save(); } }
            }));
            parts.push(fieldRow(t('Edge Sharpness'), html`
      ${numberControl('streamFrame.postPack.peripheryStrength', { value: settings.postPack.peripheryStrength, ctx: controlContext, onCommit: value => { settings.postPack.peripheryStrength = value; save(); } })}
      ${sliderControl('streamFrame.postPack.peripheryStrength', { value: settings.postPack.peripheryStrength, onChange: value => { settings.postPack.peripheryStrength = value; save(); } })}
            `, {
  tip: t("Adjust sharpening outside the high-detail center. This affects the lower-detail edges of the streamed image.\n\nSharpening for the downscaled whole-view tile, 0 to 1. Applied after the downscale, so it is visible on the panel; keep it lower than the fovea to avoid haloing on the stretched periphery.\n\nValue: streamFrame.postPack.peripheryStrength (settings.json). Encoder side — post-pack sharpening of the downscaled whole-view tile."),
  reset: { can: settings.postPack.peripheryStrength != defaults.postPack.peripheryStrength, on: () => { settings.postPack.peripheryStrength = defaults.postPack.peripheryStrength; save(); } }
            }));
            parts.push(fieldRow(t('Center-Edge Blend'), html`
      ${numberControl('streamFrame.postPack.edgeFalloff', { value: settings.postPack.edgeFalloff ?? defaults.postPack.edgeFalloff ?? 0.12, ctx: controlContext, onCommit: value => { settings.postPack.edgeFalloff = value; save(); } })}
      ${sliderControl('streamFrame.postPack.edgeFalloff', { value: settings.postPack.edgeFalloff ?? defaults.postPack.edgeFalloff ?? 0.12, onChange: value => { settings.postPack.edgeFalloff = value; save(); } })}
            `, {
  tip: t("Smooth the transition between center and edge sharpening. Use this when a visible boundary appears around the sharp region.\n\nFraction of the fovea tile over which its sharpening ramps down to the periphery strength at the tile border, so the seam where the headset composites the cut-out over the stretched periphery is not a sharpness step. 0 = hard edge. The native contract accepts 0 to 1; the slider covers the tested 0 to 0.5 band.\n\nValue: streamFrame.postPack.edgeFalloff (settings.json). Encoder side — ramp width of the center-to-edge sharpening transition."),
  reset: { can: settings.postPack.edgeFalloff != defaults.postPack.edgeFalloff, on: () => { settings.postPack.edgeFalloff = defaults.postPack.edgeFalloff ?? 0.12; save(); } }
            }));
            parts.push(settingFieldRow('streamFrame.postPack.foveaTop', html`
      <app-switch .checked=${!!settings.postPack.foveaTop} @change=${(e: CustomEvent) => { settings.postPack.foveaTop = e.detail; save(); }}></app-switch>
            `, {
  tip: t("Adjust sharpening for the upper and lower center tiles. These values fine-tune the streamed image layout.\n\nWhich tile of each eye's pair is the gaze cut-out. On = upper tile (what the streamer's shader indicates). If the wrong region looks sharpened - e.g. periphery crisp, fovea soft - flip this.\n\nValue: streamFrame.postPack.foveaTop (settings.json). Encoder side — selects which tile is the gaze cut-out.")
            }));
}
if (galaxy.casMode === 'preencode') {
            parts.push(settingFieldRow('streamFrame.cas.perEye', html`
      <app-switch .checked=${!!settings.cas.perEye} @change=${(e: CustomEvent) => { settings.cas.perEye = e.detail; save(); }}></app-switch>
            `, {
  tip: t("Use different sharpening values for the left and right eye. Leave linked unless you need an eye-specific correction.\n\nSharpen each eye independently. Useful when one eye sits slightly off its lens axis (facial asymmetry) and only that eye needs extra sharpening to mask the mild off-axis blur; the other eye is spared the over-sharpening.\n\nValue: streamFrame.cas.perEye (settings.json). Driver side — independent pre-encode strengths per eye.")
            }));
if (!settings.cas.perEye) {
              parts.push(fieldRow(t('CAS Strength'), html`
      ${numberControl('streamFrame.cas.strength', { value: settings.cas.strength, ctx: controlContext, onCommit: value => { settings.cas.strength = value; save(); } })}
      ${sliderControl('streamFrame.cas.strength', { value: settings.cas.strength, onChange: value => { settings.cas.strength = value; save(); } })}
              `, {
  tip: t("Set the overall sharpening strength. Higher values can improve apparent detail but may also amplify noise or create halos.\n\nStrength of the sharpening from 0 to 1.\n\nValue: streamFrame.cas.strength (settings.json). Driver side — pre-encode sharpening strength (0-1).")
              }));
}
if (settings.cas.perEye) {
              parts.push(fieldRow(t('Strength Left'), html`
      ${numberControl('streamFrame.cas.strengthLeft', { value: settings.cas.strengthLeft, ctx: controlContext, onCommit: value => { settings.cas.strengthLeft = value; save(); } })}
      ${sliderControl('streamFrame.cas.strengthLeft', { value: settings.cas.strengthLeft, onChange: value => { settings.cas.strengthLeft = value; save(); } })}
              `, {
  tip: t("Set sharpening strength for the left eye. Compare both eyes to avoid an uneven-looking image.\n\nSharpening strength for the left eye only, 0 to 1.\n\nValue: streamFrame.cas.strengthLeft (settings.json). Driver side — per-eye pre-encode strength, left (0-1).")
              }));
              parts.push(fieldRow(t('Strength Right'), html`
      ${numberControl('streamFrame.cas.strengthRight', { value: settings.cas.strengthRight, ctx: controlContext, onCommit: value => { settings.cas.strengthRight = value; save(); } })}
      ${sliderControl('streamFrame.cas.strengthRight', { value: settings.cas.strengthRight, onChange: value => { settings.cas.strengthRight = value; save(); } })}
              `, {
  tip: t("Set sharpening strength for the right eye. Compare both eyes to avoid an uneven-looking image.\n\nSharpening strength for the right eye only, 0 to 1.\n\nValue: streamFrame.cas.strengthRight (settings.json). Driver side — per-eye pre-encode strength, right (0-1).")
              }));
}
}
          parts.push(settingFieldRow('streamFrame.dither', html`
      <app-switch .checked=${!!settings.dither} @change=${(e: CustomEvent) => { settings.dither = e.detail; save(); }}></app-switch>
          `, {
  tip: t("Add a small amount of noise to make color banding less obvious. It can improve smooth gradients but does not add real color detail.\n\nAdds a small amount of noise before the encode to reduce banding in dark gradients.\n\nValue: streamFrame.dither (settings.json). Driver side — pre-encode noise against banding."),
  reset: { can: settings.dither != defaults.dither, on: () => { galaxy.reset('dither'); } }
          }));
          parts.push(settingFieldRow('streamFrame.stationaryDimming.enable', html`
      <app-switch .checked=${!!settings.stationaryDimming.enable} @change=${(e: CustomEvent) => { settings.stationaryDimming.enable = e.detail; save(); }}></app-switch>
          `, {
  tip: t("Dim the picture when the headset is not moving. This reduces visible brightness during still periods rather than pausing the game.\n\nFades the streamed image uniformly toward black when the headset has not moved for the configured time, then restores brightness on movement. This reduces time spent showing a bright stationary image; it does not guarantee protection from panel wear. Tracking and the game can continue while the picture is dimmed.\n\nValue: streamFrame.stationaryDimming.enable (settings.json). Driver side — fades the streamed image to black when the headset is still.")
          }));
if (settings.stationaryDimming.enable) {
            parts.push(fieldRow(t('Dimming Timing'), html`
      <span>after</span>
      ${numberControl('streamFrame.stationaryDimming.movementTime', {
        value: settings.stationaryDimming.movementTime,
        ctx: controlContext,
        label: t('Dimming delay'),
        onCommit: value => { settings.stationaryDimming.movementTime = value; save(); },
      })}
      <span>fade</span>
      ${numberControl('streamFrame.stationaryDimming.dimSeconds', {
        value: settings.stationaryDimming.dimSeconds,
        ctx: controlContext,
        label: t('Dimming fade'),
        onCommit: value => { settings.stationaryDimming.dimSeconds = value; save(); },
      })}
            `, {
  tip: t("Set how long the headset must stay still before dimming starts and how quickly the picture fades.\n\nSeconds of stillness before dimming starts, and seconds to fade fully to black.\n\nValue: streamFrame.stationaryDimming.movementTime + dimSeconds (settings.json). Driver side — stillness threshold and fade duration, in seconds.")
            }));
}

} else {
        parts.push(statusMessage('info', t('Image Enhancements is off'),
          t('Enable it in App Settings to adjust color and sharpening.'),
          html`<a href="#/app-settings">${t('Open App Settings')}</a>`));
}
if (vendor && settings) {
        const ofxr = this.ofxrPreferences();
        const ofxrStatus = this.ofxrStatus;
        parts.push(sectionHeading(t('Optical Flow'), 0, 'optical-flow'));
        parts.push(statusMessage('info', t('Optical Flow requires the Companion to stay running'),
          t('Keep the Companion open, minimized, or running in the system tray while playing. Enable Start with Windows in App Settings to restore saved Optical Flow at sign-in. Quitting the Companion stops Optical Flow.'),
          html`<a href="#/app-settings">${t('Open App Settings')}</a>`));
        parts.push(settingFieldRow('ofxr.enabled', html`
      <app-switch .checked=${this.ctx.ofxr.isArmed()} ?disabled=${this.ctx.ofxr.changing() || (!this.ctx.ofxr.isArmed() && !ofxrCanArm(ofxrStatus))} title=${this.ofxrError ?? t(ofxrDisabledReason(ofxrStatus) ?? '')} @change=${(e: CustomEvent) => { void this.setOfxrEnabled(e.detail); }}></app-switch>
      ${this.ofxrError ? html`<span class="mode-error" role="alert">${this.ofxrError}</span>` : ''}
            `, {
  tip: t("Arm the OFXR Bridge optical-flow layer. It inserts intermediate frames on the PC using the graphics card's optical-flow engine (NVIDIA Turing generation or newer for the NVIDIA backends; FidelityFX works on other cards) and needs no headset patch. The game must be restarted for the layer to load. While armed, quitting the Companion disarms it; minimizing or closing to the tray keeps it running. Only one synthesis mode runs at a time: enabling this turns Async Spacewarp off.\n\nValue: ofxr.enabled (gui-settings.json). Companion side — registers and configures the OFXR Bridge OpenXR layer for the current user.")
            }));
        parts.push(settingFieldRow('ofxr.mode', html`
      <app-select .value=${ofxr.mode} ?disabled=${this.ctx.ofxr.changing() || !this.ctx.ofxr.isArmed()} .options=${[
        { value: 'fidelityfx', label: t('FidelityFX (any card)') },
        { value: 'nvidia-fast', label: t('NVIDIA Fast (test)') },
        { value: 'nvidia-medium', label: t('NVIDIA Medium (recommended)') },
        { value: 'nvidia-slow', label: t('NVIDIA Slow (best quality)') }
      ]} @change=${(e: CustomEvent) => { void this.updateOfxr({ mode: e.detail }); }}></app-select>
            `, {
  tip: t("Choose who computes the optical flow. FidelityFX runs on any graphics card. The NVIDIA options use the GPU's hardware Optical Flow engine and require an NVIDIA Turing generation or newer card with Optical Flow support (TU117-based GTX 1650 class cards are not supported). NVIDIA Medium with 50% resolution is the recommended starting point; the GPU cost and quality trade off against each other.\n\nValue: ofxr.mode (gui-settings.json). Companion side — writes backend and nvidia_preset into the OFXR layer configuration; applies at the next game start.")
            }));
        parts.push(settingFieldRow('ofxr.bidirectional', html`
      <app-switch .checked=${ofxr.bidirectional} ?disabled=${this.ctx.ofxr.changing() || !this.ctx.ofxr.isArmed() || ofxr.mode === 'fidelityfx'} @change=${(e: CustomEvent) => { void this.updateOfxr({ bidirectional: e.detail }); }}></app-switch>
            `, {
  tip: t("Compute optical flow in both directions and reject inconsistent vectors. Better quality around occlusions for slightly more GPU cost.\n\nValue: ofxr.bidirectional (gui-settings.json). Companion side — writes nvidia_bidirectional; applies at the next game start.")
            }));
        parts.push(settingFieldRow('ofxr.logging', html`
      <app-switch .checked=${ofxr.logging} ?disabled=${this.ctx.ofxr.changing() || !this.ctx.ofxr.isArmed()} @change=${(e: CustomEvent) => { void this.updateOfxr({ logging: e.detail }); }}></app-switch>
            `, {
  tip: t("Write the OFXR diagnostic flight log for problem reports. Turn it off when not diagnosing.\n\nValue: ofxr.logging (gui-settings.json). Companion side — writes logging_enabled; applies at the next game start.")
            }));
        parts.push(settingFieldRow('ofxr.maxLogMb', html`
      ${numberControl('ofxr.maxLogMb', {
        value: ofxr.maxLogMb,
        ctx: controlContext,
        disabled: this.ctx.ofxr.changing() || !this.ctx.ofxr.isArmed() || !ofxr.logging,
        onCommit: value => { void this.updateOfxr({ maxLogMb: value }); },
      })}
            `, {
  tip: t("Maximum size of the flight log before it rolls over.\n\nValue: ofxr.maxLogMb (gui-settings.json). Companion side — writes max_file_mb.")
            }));
        parts.push(settingFieldRow('ofxr.flushEachEvent', html`
      <app-switch .checked=${ofxr.flushEachEvent} ?disabled=${this.ctx.ofxr.changing() || !this.ctx.ofxr.isArmed() || !ofxr.logging} @change=${(e: CustomEvent) => { void this.updateOfxr({ flushEachEvent: e.detail }); }}></app-switch>
            `, {
  tip: t("Write each flight-log event to disk immediately. Safer for crash reports, slower.\n\nValue: ofxr.flushEachEvent (gui-settings.json). Companion side — writes flush_each_event.")
            }));
        parts.push(settingFieldRow('ofxr.version', html`
      <app-select .value=${ofxr.version} ?disabled=${this.ctx.ofxr.changing()} .options=${[
        { value: '', label: t('Automatic (newest installed)') },
        ...((ofxrStatus?.versions ?? []).map(entry => {
          const source = entry.source === 'external' ? t('External')
            : entry.source === 'imported' ? t('Imported')
            : entry.source === 'downloaded' ? t('Downloaded') : t('Bundled');
          return {
            value: entry.version,
            label: entry.label ? `${source} ${entry.label} (v${entry.version})` : `${source} v${entry.version}`
          };
        }))
      ]} @change=${(e: CustomEvent) => { void this.selectOfxrVersion(e.detail); }}></app-select>
            `, {
  tip: t("Which OFXR Bridge payload the Companion arms. Empty means the newest installed version. Bundled ships with the Companion; Imported is a build you copied from a folder; Downloaded is reserved for future use; External belongs to OFXR's own tray. Imported builds are used as-is with no version-compatibility check: download any fork, unzip it, and install it from its folder. Switching versions disarms first because the layer's arm event belongs to the payload path.\n\nValue: ofxr.version (gui-settings.json).")
            }));
        parts.push(fieldRow(t('Manage OFXR Bridge'), html`
      <fluent-button ?disabled=${this.ctx.ofxr.changing()} @click=${() => { void this.importOfxr(); }}>${t('Install from folder…')}</fluent-button>
      <fluent-button ?disabled=${this.ctx.ofxr.changing() || !ofxrStatus || ofxrStatus.state === 'unavailable'} @click=${() => { void this.reinstallOfxr(); }}>${t('Reinstall')}</fluent-button>
      <fluent-button appearance="primary" class="danger" ?disabled=${this.ctx.ofxr.changing()} @click=${() => { void this.removeOfxr(); }}>${t('Uninstall Optical Flow')}</fluent-button>
            `, {
  tip: t("Install from folder copies a downloaded OFXR Bridge build into the Companion's own runtime area. The build must contain XR_APILAYER_XRFrameBridge_diagnostic.dll and its own ofxr_bridge.ini; the whole payload folder is copied so fork-specific helper DLLs survive. No version check is applied. The Companion only manages the settings shared by every fork (backend, NVIDIA preset, bidirectional flow, flight recorder and overlay position); Hybrid, 3X, NVIDIA input scale, frame-generation mode, Vulkan/D3D11 bridges and other build-specific options stay in the downloaded build's own tray. Reinstall re-stages the bundled payload. Uninstall removes the Companion's copies but leaves external tray installs untouched. Driver uninstall keeps imported builds.")
            }));
        parts.push(settingFieldRow('ofxr.overlay', html`
      <app-select .value=${ofxr.overlay} ?disabled=${this.ctx.ofxr.changing() || !this.ctx.ofxr.isArmed()} .options=${[
        { value: 'off', label: t('Off') },
        { value: 'upper-left', label: t('Upper left') },
        { value: 'upper-right', label: t('Upper right') },
        { value: 'lower-left', label: t('Lower left') },
        { value: 'lower-right', label: t('Lower right') }
      ]} @change=${(e: CustomEvent) => { void this.updateOfxr({ overlay: e.detail }); }}></app-select>
            `, {
  tip: t("Show the OFXR frame counter in the headset at the chosen corner; Off hides it.\n\nValue: ofxr.overlay (gui-settings.json). Companion side — writes the overlay position.")
            }));
}
if (advancedMode) {
        parts.push(sectionGroup(t('Advanced'), 1, 'group', 'advanced'));
          parts.push(fieldRow(t('Frame Sync Timeout (ms)'), html`
      ${numberControl('streamFrame.syncTimeoutMs', { value: settings.syncTimeoutMs, ctx: controlContext, onCommit: value => { settings.syncTimeoutMs = value; save(); } })}
      ${sliderControl('streamFrame.syncTimeoutMs', { value: settings.syncTimeoutMs, onChange: value => { settings.syncTimeoutMs = value; save(); } })}
          `, {
  tip: t("Skip a synchronization wait in the image-processing path. This is a latency experiment and can cause flashes or other display artifacts.\n\nHow long to wait for the frame sync before letting a frame through unprocessed (a brief 'flash' of ungraded color). Higher values trade flashes under heavy load for slightly later frames. After a skipped frame the wait automatically escalates to break flash streaks. Default 10, sensible range 3-15.\n\nValue: streamFrame.syncTimeoutMs (settings.json). Driver side — frame-sync wait before passing a frame unprocessed, in ms."),
  reset: { can: settings.syncTimeoutMs != defaults.syncTimeoutMs, on: () => { galaxy.reset('syncTimeoutMs'); } }
          }));
          parts.push(fieldRow(t('Gaze Prediction (ms)'), html`
      ${numberControl('streamFrame.eyeGaze.predictionMs', { value: settings.eyeGaze.predictionMs, ctx: controlContext, onCommit: value => { settings.eyeGaze.predictionMs = value; save(); } })}
      ${sliderControl('streamFrame.eyeGaze.predictionMs', { value: settings.eyeGaze.predictionMs, onChange: value => { settings.eyeGaze.predictionMs = value; save(); } })}
          `, {
  tip: t("Adjust how far ahead eye movement is predicted for processing. Too much prediction can place the correction ahead of your actual gaze.\n\nLeads the gaze point by extrapolating recent eye motion, compensating the capture-to-display latency that makes the ring trail your eyes. Raise if the ring lags behind saccades, lower if it overshoots. 0 disables.\n\nValue: streamFrame.eyeGaze.predictionMs (settings.json). Driver side — gaze-point lead time, in ms; 0 disables.")
          }));
          parts.push(settingFieldRow('streamFrame.directRender', html`
      <app-switch .checked=${!!settings.directRender} @change=${(e: CustomEvent) => { settings.directRender = e.detail; save(); }}></app-switch>
          `, {
  tip: t("Request a more direct rendering path. Performance and compatibility depend on the runtime; compare carefully before leaving it enabled.\n\nPerformance: draws the processed frame directly into the layer texture instead of a scratch target plus copy-back (about a third less GPU memory traffic). Falls back automatically per texture if a layer refuses a render target view. Only turn off to A/B against the old path; the log line 'direct render path' / 'copy-back path' shows which is active per app.\n\nValue: streamFrame.directRender (settings.json). Driver side — renders the processed frame directly into the layer texture."),
  reset: { can: settings.directRender != defaults.directRender, on: () => { galaxy.reset('directRender'); } }
          }));
          parts.push(settingFieldRow('streamFrame.deferredEviction', html`
      <app-switch .checked=${!!settings.deferredEviction} @change=${(e: CustomEvent) => { settings.deferredEviction = e.detail; save(); }}></app-switch>
          `, {
  tip: t("Keep cached resources longer to try to reduce short stutters. This changes resource handling and may use more memory.\n\nPerformance: when the scratch texture cache is full and a new resolution arrives, the old set's release is postponed a few frames and performed after the frame sync mutex is released, instead of inside the same frame that already pays the unavoidable creation stall. Spreads transition cost so resolution/app switches hitch less. Off restores the old synchronous eviction for A/B; score the difference with Hitch Diagnostics on ('creates'/'evicts' counters and HITCH tags mark the transitions).\n\nValue: streamFrame.deferredEviction (settings.json). Driver side — postpones scratch-texture release past the frame-sync mutex."),
  reset: { can: settings.deferredEviction != defaults.deferredEviction, on: () => { galaxy.reset('deferredEviction'); } }
          }));
          parts.push(settingFieldRow('streamFrame.processAtSubmitLayer', html`
      <app-switch .checked=${!!settings.processAtSubmitLayer} @change=${(e: CustomEvent) => { settings.processAtSubmitLayer = e.detail; save(); }}></app-switch>
          `, {
  tip: t("Choose an alternate point in the rendering pipeline for image processing. This is a compatibility and performance experiment.\n\nProcesses frames during SubmitLayer instead of Present. Only needed if processing at Present has no visible effect on your driver.\n\nValue: streamFrame.processAtSubmitLayer (settings.json). Driver side — processes frames in SubmitLayer instead of Present."),
  reset: { can: settings.processAtSubmitLayer != defaults.processAtSubmitLayer, on: () => { galaxy.reset('processAtSubmitLayer'); } }
          }));
          parts.push(settingFieldRow('streamFrame.calib.blackout', html`
      <app-switch .checked=${!!settings.calib?.blackout} ?disabled=${!settings.enable} @change=${(e: CustomEvent) => { galaxy.setBlackout(e.detail); }}></app-switch>
      ${!settings.enable ? html`<span class="note">enable Image Processing first</span>` : html``}
          `, {
  tip: t("Make the headset image black while keeping tracking and the game running. Use this for testing, not as a way to stop or pause the application.\n\nBlack out the headset's screens to protect from burn in. Tracking, streaming and the game keep running; only the panels go black. Useful while developing or leaving the headset connected. Needs Enable Image Processing on.\n\nValue: streamFrame.calib.blackout (settings.json). Driver side — renders black to the panels; tracking and streaming continue."),
  reset: { can: !!settings.calib?.blackout, on: () => { galaxy.setBlackout(false); } }
          }));
if (vendor && settings.nvencTap) {
        parts.push(sectionHeading(t('Encoder Advanced'), 0, 'encoder'));
if (settings.nvencTap) {
  const codecDef = codecEncoderDefaults[settings.nvencCodec ?? 0] ?? codecEncoderDefaults[0];
                parts.push(fieldRow(t('Bandwidth Override (Mbit/s)'), html`
      <div class="range-control">
        ${numberControl('streamFrame.nvencBandwidthOverrideMbit', {
          value: settings.nvencBandwidthOverrideMbit,
          ctx: controlContext,
          onCommit: value => { settings.nvencBandwidthOverrideMbit = value; save(); },
        })}
        <div class="range-track">
          ${sliderControl('streamFrame.nvencBandwidthOverrideMbit', {
            value: settings.nvencBandwidthOverrideMbit,
            onChange: value => { settings.nvencBandwidthOverrideMbit = value; save(); },
          })}
          <span class="range-scale" aria-hidden="true"><span>0</span><span>1500 Mbit/s</span></span>
        </div>
      </div>
                `, {
  tip: t("Override the normal stream bandwidth budget. 0 follows the Max Bitrate row above instead of forcing a separate value.\n\nNonzero supplies the network pacing budget and highest requested encoder target instead of the Max Bitrate row. It does not guarantee actual encoded output or constant sent bits. Requires a SteamVR restart.\n\nValue: streamFrame.nvencBandwidthOverrideMbit (settings.json). SteamVR + encoder sides — pacing budget and requested encoder target."),
  reset: { can: settings.nvencBandwidthOverrideMbit != defaults.nvencBandwidthOverrideMbit, on: () => { galaxy.reset('nvencBandwidthOverrideMbit'); } }
                }));
                parts.push(fieldRow(t('VBV Encoder Buffer Budget'), html`
      ${numberControl('streamFrame.nvencVbvFrames', {
        value: settings.nvencVbvFrames,
        ctx: controlContext,
        onCommit: value => { settings.nvencVbvFrames = value; save(); },
      })}
                `, {
  tip: t("Request an NVENC VBV buffer budget in nominal frame units. A smaller budget can reduce buffering but makes complex scenes harder to encode cleanly.\n\nFor N > 0, requested VBV = (target bits/s / nominal fps) × N, in bits. 0 preserves the caller's VBV value. This is a rate-control buffer request, not a guaranteed maximum encoded frame size or a transport limit. Requires a SteamVR restart.\n\nValue: streamFrame.nvencVbvFrames (settings.json). Encoder side — requested VBV buffer size in bits."),
  reset: { can: settings.nvencVbvFrames != codecDef.vbvFrames, on: () => { settings.nvencVbvFrames = codecDef.vbvFrames; save(); } }
                }));
                parts.push(fieldRow(t('Encoder Quality Preset'), html`
      ${choiceControl('streamFrame.nvencPreset', {
        value: settings.nvencPreset,
        ctx: controlContext,
        onCommit: value => { settings.nvencPreset = Number(value); save(); },
      })}
                `, {
  tip: t("Choose the NVIDIA encoding preset. Keep automatic selection unless you are testing a specific quality or latency trade-off.\n\n0 = automatic by NVENC engine count (3 engines: P7, 2: P5, 1: P4; logged as 'preset AUTO'). Higher presets spend more encoder time for better quality at the same bitrate; P7 needs the split across three engines to hold 90 fps. Auto resolves to P2 for H.264 (P7/P5/P4 by engine count otherwise).\n\nValue: streamFrame.nvencPreset (settings.json). Encoder side — NVENC preset selector; 0 = automatic by engine count."),
  reset: { can: settings.nvencPreset != defaults.nvencPreset, on: () => { galaxy.reset('nvencPreset'); } }
                }));
                parts.push(settingFieldRow('streamFrame.nvencForceCbr', html`
      <app-switch .checked=${!!settings.nvencForceCbr} @change=${(e: CustomEvent) => { settings.nvencForceCbr = e.detail; save(); }}></app-switch>
      ${evidence && (evidence.effectiveCodec ?? -1) >= 0 ? html`<span class="note-inline">${t('Latest accepted rate control: {rc}', {
        rc: evidence.effectiveRateControl === 2 ? 'CBR' : evidence.effectiveRateControl === 1 ? 'VBR'
          : evidence.effectiveRateControl === 0 ? t('Constant QP') : t('Unknown') })}</span>` : html``}
                `, {
  tip: t("Force CBR selects constant-bitrate rate control. It does not guarantee constant encoded output or constant sent bits. Off is the default for every codec and preserves upstream rate control, which may already be CBR. Turn it on whenever it helps. When on, Max Bitrate is both the constant average and the maximum; the bitrate curve, constancy and headroom do not apply. The reset arrow restores Off. Requires a SteamVR restart.\n\nValue: streamFrame.nvencForceCbr (settings.json). Encoder side — requests CBR rate control with low-delay keyframes; Max Bitrate becomes the constant target."),
  reset: { can: settings.nvencForceCbr != codecDef.forceCbr, on: () => { settings.nvencForceCbr = codecDef.forceCbr; save(); } }
                }));
                {
                  // 2026-10-19: lock only on an observed running session. The
                  // freshness-checked predicate treated a missing or stale
                  // report as "running", which locked these rows permanently
                  // when SteamVR was closed; the page already polls every 2 s.
                  const curveLocked = this.ctx.startup.status()?.steamvrRunning === true;
                  const curveDisabled = curveLocked;
                  const curveNote = curveLocked
                    ? html`<span class="note-inline">${t('Close SteamVR to change')}</span>`
                    : settings.nvencForceCbr
                      ? html`<span class="note-inline">${t('Force CBR uses Max Bitrate directly')}</span>`
                      : html``;
                  parts.push(settingFieldRow('streamFrame.nvencBitrateCurve', html`
      <app-select ?disabled=${curveDisabled} .value=${settings.nvencBitrateCurve ?? 0} .options=${BITRATE_CURVE_FAMILIES.map(family => ({ value: family.value, label: t(family.label) }))} @change=${(e: CustomEvent) => { galaxy.setBitrateCurve(Number(e.detail)); }}></app-select>
      ${curveNote}
                  `, {
  tip: t("Choose how the streamer's adaptive request becomes the requested encoder target.\n\nGalaxy XR uses a request domain of min(Max Bitrate, 350 Mbit/s). Above 350, default Linear at 0% scales each request by Max Bitrate / 350; below 350 it follows the request up to Max Bitrate. Power knee raises the middle of this domain; soft knee reaches the base ceiling from 60% upward. Custom uses seven normalized points: P1 has a request-zero floor, P2-P5 are free, P6 starts the plateau, and hidden P7 is the fixed endpoint. Point edits change the native encoder override; the scale is applied once. Bitrate Constancy lifts this base curve, then any headroom reservation limits the average. Force CBR applies Max Bitrate directly instead. Close SteamVR to change this. Requires a SteamVR restart.\n\nThese are requested targets, not measured encoded or wire rates. Neutral builds retain normalization against Max Bitrate.\n\nValue: streamFrame.nvencBitrateCurve and streamFrame.nvencBitrateCurvePoints (settings.json)."),
  reset: { can: (settings.nvencBitrateCurve ?? 0) !== defaults.nvencBitrateCurve, on: () => galaxy.resetBitrateCurve() }
                  }));
                  parts.push(settingFieldRow('streamFrame.nvencBitrateConstancyPct', html`
      ${numberControl('streamFrame.nvencBitrateConstancyPct', {
        value: settings.nvencBitrateConstancyPct ?? 0,
        ctx: controlContext,
        disabled: curveDisabled,
        onCommit: value => { settings.nvencBitrateConstancyPct = value; save(); },
      })}
      ${sliderControl('streamFrame.nvencBitrateConstancyPct', {
        value: settings.nvencBitrateConstancyPct ?? 0,
        disabled: curveDisabled,
        onChange: value => { settings.nvencBitrateConstancyPct = value; save(); },
      })}
      ${curveNote}
                  `, {
  tip: t("Lift the selected curve toward Max Bitrate.\n\n0 leaves the selected base curve unchanged; 100 selects the base ceiling for positive requests. A headroom reservation can lower the final average. Force CBR uses Max Bitrate directly and ignores this percentage. For Galaxy XR with Max Bitrate 500 and a request of 320 Mbit/s, Linear at 0% requests about 457.14 Mbit/s before headroom. With Max Bitrate 280 and a request of 200, it requests 200. Higher constancy reduces the response to congestion. Close SteamVR to change this. Requires a SteamVR restart.\n\nA requested average does not guarantee constant encoded output or constant sent bits.\n\nValue: streamFrame.nvencBitrateConstancyPct (settings.json)."),
  reset: { can: (settings.nvencBitrateConstancyPct ?? 0) !== defaults.nvencBitrateConstancyPct, on: () => galaxy.reset('nvencBitrateConstancyPct') }
                  }));
                  parts.push(fieldRow(t('Bitrate Curve Graph'), html`
      <fluent-button appearance="outline" @click=${() => { void this.openCurveWindow(); }}>${t('Open graph window')}</fluent-button>
                  `, {
  tip: t("Open the curve graph in its own resizable window.\n\nFor Galaxy XR, the request axis always ends at 350 Mbit/s and the target axis ends at the higher of 350 or the entered Max Bitrate. Dashed line: the streamer standard ending at (350, 350). Thin line and P1-P6: the editable base curve. Solid line: the final requested average after constancy and headroom, or the fixed Max Bitrate under Force CBR. Above 350, default Linear is raised by Max Bitrate / 350. Below 350, it follows the request and then holds Max Bitrate. Custom point edits are validated and saved by the main Companion and affect the native encoder override.\n\nThe graph shows positive-request, steady-state targets, not measured encoded output or wire rates. The five-frame request filter and zero or missing request fallback are not drawn. The graph follows edits immediately, is locked while SteamVR runs, hides with the Companion tray lifecycle and closes when the Companion quits.\n\nValue: streamFrame.nvencBitrateCurve + streamFrame.nvencBitrateCurvePoints (settings.json).")
                  }));
                  if (this.curveWindowError) {
                    parts.push(noteRow(html`${t('The graph window could not be opened: {reason}', { reason: this.curveWindowError })}`));
                  }
                }
                parts.push(settingFieldRow('streamFrame.nvencMultiPass', html`
                  ${choiceControl('streamFrame.nvencMultiPass', {
                    value: settings.nvencMultiPass ?? -1,
                    ctx: controlContext,
                    onCommit: value => { settings.nvencMultiPass = Number(value); save(); },
                  })}
                `, { tip: t('Explicit multipass selection applies even when preset merge is off. Automatic keeps the codec and preset recommendation. Unsupported requests fail without fallback.\n\nValue: streamFrame.nvencMultiPass (settings.json). Encoder side — pass count hint; automatic follows the codec/preset recommendation.'),
                  reset: { can: settings.nvencMultiPass !== defaults.nvencMultiPass, on: () => galaxy.reset('nvencMultiPass') } }));
                if (settings.nvencCodec === 1) {
                  parts.push(noteRow(html`${t('H.264 compatibility defaults are editable below. Reset arrows restore the tested values. Split-Frame is not applicable to H.264; its saved choice is retained.')}`));
                  parts.push(settingFieldRow('streamFrame.nvencH264GopFrames', html`
                    ${numberControl('streamFrame.nvencH264GopFrames', {
                      value: settings.nvencH264GopFrames ?? 0,
                      ctx: controlContext,
                      onCommit: value => { settings.nvencH264GopFrames = value; save(); },
                    })}
                  `, { tip: t("0 = automatic nominal frame rate; -1 = leave upstream GOP unchanged. Positive values are applied exactly. Automatic requires a nonzero frame rate (Force FPS or the caller's rate)."), reset: { can: settings.nvencH264GopFrames !== defaults.nvencH264GopFrames, on: () => galaxy.reset('nvencH264GopFrames') } }));
                  parts.push(settingFieldRow('streamFrame.nvencH264IdrFrames', html`
                    ${numberControl('streamFrame.nvencH264IdrFrames', {
                      value: settings.nvencH264IdrFrames ?? 0,
                      ctx: controlContext,
                      onCommit: value => { settings.nvencH264IdrFrames = value; save(); },
                    })}
                  `, { tip: t("0 = automatic nominal frame rate; -1 = leave upstream IDR unchanged. Positive values are applied exactly. Automatic requires a nonzero frame rate (Force FPS or the caller's rate)."), reset: { can: settings.nvencH264IdrFrames !== defaults.nvencH264IdrFrames, on: () => galaxy.reset('nvencH264IdrFrames') } }));
                  parts.push(settingFieldRow('streamFrame.nvencH264RefFrames', html`
                    ${numberControl('streamFrame.nvencH264RefFrames', {
                      value: settings.nvencH264RefFrames ?? 3,
                      ctx: controlContext,
                      onCommit: value => { settings.nvencH264RefFrames = value; save(); },
                    })}
                  `, { tip: t("Set the reference-frame count (0 to 16). Unsupported requests fail instead of falling back."), reset: { can: settings.nvencH264RefFrames !== defaults.nvencH264RefFrames, on: () => galaxy.reset('nvencH264RefFrames') } }));
                  parts.push(settingFieldRow('streamFrame.nvencH264Entropy', html`
                    ${choiceControl('streamFrame.nvencH264Entropy', {
                      value: settings.nvencH264Entropy ?? 0,
                      ctx: controlContext,
                      onCommit: value => { settings.nvencH264Entropy = Number(value); save(); },
                    })}
                  `, { tip: t("Automatic uses CAVLC above 200 Mbit/s. CABAC and CAVLC force the selected coder."), reset: { can: settings.nvencH264Entropy !== defaults.nvencH264Entropy, on: () => galaxy.reset('nvencH264Entropy') } }));
                  parts.push(settingFieldRow('streamFrame.nvencH264SliceMode', html`
                    ${choiceControl('streamFrame.nvencH264SliceMode', {
                      value: settings.nvencH264SliceMode ?? 3,
                      ctx: controlContext,
                      onCommit: value => { settings.nvencH264SliceMode = Number(value); save(); },
                    })}
                  `, { tip: t("NVENC slice mode: macroblocks, bytes, rows or slice count."), reset: { can: settings.nvencH264SliceMode !== defaults.nvencH264SliceMode, on: () => galaxy.reset('nvencH264SliceMode') } }));
                  parts.push(settingFieldRow('streamFrame.nvencH264SliceData', html`
                    ${numberControl('streamFrame.nvencH264SliceData', {
                      value: settings.nvencH264SliceData ?? 1,
                      ctx: controlContext,
                      onCommit: value => { settings.nvencH264SliceData = value; save(); },
                    })}
                  `, { tip: t("Value for the selected NVENC slice mode."), reset: { can: settings.nvencH264SliceData !== defaults.nvencH264SliceData, on: () => galaxy.reset('nvencH264SliceData') } }));
                  parts.push(settingFieldRow('streamFrame.nvencH264VbvInitialDelay', html`
                    ${numberControl('streamFrame.nvencH264VbvInitialDelay', {
                      value: settings.nvencH264VbvInitialDelay ?? 0,
                      ctx: controlContext,
                      onCommit: value => { settings.nvencH264VbvInitialDelay = value; save(); },
                    })}
                  `, { tip: t("Initial VBV delay in bits. Zero preserves the tested low-latency default."), reset: { can: settings.nvencH264VbvInitialDelay !== defaults.nvencH264VbvInitialDelay, on: () => galaxy.reset('nvencH264VbvInitialDelay') } }));
                  parts.push(settingFieldRow('streamFrame.nvencH264Aud', html`
                    <app-switch .checked=${settings.nvencH264Aud ?? defaults.nvencH264Aud}
                      @change=${(e: CustomEvent) => { settings.nvencH264Aud = e.detail; save(); }}></app-switch>
                  `, { reset: { can: settings.nvencH264Aud !== defaults.nvencH264Aud, on: () => galaxy.reset('nvencH264Aud') } }));
                  parts.push(settingFieldRow('streamFrame.nvencH264RepeatHeaders', html`
                    <app-switch .checked=${settings.nvencH264RepeatHeaders ?? defaults.nvencH264RepeatHeaders}
                      @change=${(e: CustomEvent) => { settings.nvencH264RepeatHeaders = e.detail; save(); }}></app-switch>
                  `, { reset: { can: settings.nvencH264RepeatHeaders !== defaults.nvencH264RepeatHeaders, on: () => galaxy.reset('nvencH264RepeatHeaders') } }));
                  parts.push(settingFieldRow('streamFrame.nvencH264DisableHeaders', html`
                    <app-switch .checked=${settings.nvencH264DisableHeaders ?? defaults.nvencH264DisableHeaders}
                      @change=${(e: CustomEvent) => { settings.nvencH264DisableHeaders = e.detail; save(); }}></app-switch>
                  `, { reset: { can: settings.nvencH264DisableHeaders !== defaults.nvencH264DisableHeaders, on: () => galaxy.reset('nvencH264DisableHeaders') } }));
                  parts.push(settingFieldRow('streamFrame.nvencH264BitstreamRestriction', html`
                    <app-switch .checked=${settings.nvencH264BitstreamRestriction ?? defaults.nvencH264BitstreamRestriction}
                      @change=${(e: CustomEvent) => { settings.nvencH264BitstreamRestriction = e.detail; save(); }}></app-switch>
                  `, { reset: { can: settings.nvencH264BitstreamRestriction !== defaults.nvencH264BitstreamRestriction, on: () => galaxy.reset('nvencH264BitstreamRestriction') } }));
                }
                parts.push(fieldRow(t('Keyframe Size Budget'), html`
      ${numberControl('streamFrame.nvencLowDelayKfScale', {
        value: settings.nvencLowDelayKfScale,
        ctx: controlContext,
        onCommit: value => { settings.nvencLowDelayKfScale = value; save(); },
      })}
                `, {
  tip: t("With Force CBR, request the keyframe-to-P-frame size ratio (0–255, NVENC byte field). NVENC documents this ratio for CBR with a single-frame VBV buffer. It is not a hard keyframe size limit or a transport limit. The optimized recommendation is 2. Unsupported requests fail without rewriting the value. Requires a SteamVR restart.\n\nValue: streamFrame.nvencLowDelayKfScale (settings.json). Encoder side — requested low-delay keyframe ratio under CBR."),
  reset: { can: settings.nvencLowDelayKfScale != codecDef.lowDelayKfScale, on: () => { settings.nvencLowDelayKfScale = codecDef.lowDelayKfScale; save(); } }
                }));
                parts.push(fieldRow(t('Multi-Engine Encoding'), html`
      ${choiceControl('streamFrame.nvencSplitMode', {
        value: settings.nvencSplitMode,
        ctx: controlContext,
        onCommit: value => { settings.nvencSplitMode = Number(value); save(); },
      })}
                `, {
  tip: t("0 = automatic; 1 = forced, driver-selected strips; 2–4 = requested strips; 15 = disabled. Other values are rejected. Values above 0 require an accepted NVENC API 12.1 session upgrade, and a refusal shows in the driver log and the Stream Frame evidence row. H.264 does not support split encoding and retains this choice without applying it. AV1 API upgrade is independent of this value. Requires a SteamVR restart.\n\nValue: streamFrame.nvencSplitMode (settings.json). Encoder side — multi-engine split; nonzero opens the API 12.1 encoder session."),
  reset: { can: settings.nvencSplitMode != codecDef.splitMode, on: () => { settings.nvencSplitMode = codecDef.splitMode; save(); } }
                }));
                parts.push(fieldRow(t('Center Quality Boost (QP)'), html`
      <span class="qp-pair"><span class="qp-label">${t('Center')}</span>
        ${numberControl('streamFrame.nvencQpFovea', {
          value: settings.nvencQpFovea,
          ctx: controlContext,
          label: t('Center QP offset'),
          onCommit: value => { settings.nvencQpFovea = value; save(); },
        })}
      </span>
      <span class="qp-pair"><span class="qp-label">${t('Periphery')}</span>
        ${numberControl('streamFrame.nvencQpPeriphery', {
          value: settings.nvencQpPeriphery,
          ctx: controlContext,
          label: t('Periphery QP offset'),
          onCommit: value => { settings.nvencQpPeriphery = value; save(); },
        })}
      </span>
                `, {
  tip: t("Spend more encoding quality on the center of the image than on the edges. This advanced option can change artifacts in different areas.\n\nMoves bits within the same bitrate: a QP offset per block, negative for the gaze cut-out tile (finer, more bits) and positive for the periphery tile (coarser, fewer bits), blended over the same edge falloff as the sharpening. 0 / 0 = off. Small values (-2 / 2, -3 / 3) work; large ones starve the whole frame. The ramp shape and fovea-tile parity come from the Edge Falloff and fovea-top controls (shown with CAS in post-process mode) — one value drives both the sharpening and the encoder QP ramp. The native range is -128..127; the slider covers the tested band.\n\nValue: streamFrame.nvencQpFovea + nvencQpPeriphery (settings.json). Encoder side — per-block QP offsets that move bits to the gaze tile."),
  reset: { can: settings.nvencQpFovea != 0 || settings.nvencQpPeriphery != 0, on: () => { settings.nvencQpFovea = 0; settings.nvencQpPeriphery = 0; save(); } }
                }));
                parts.push(settingFieldRow('streamFrame.postPack.limitedRange', html`
      <app-switch .checked=${!!settings.postPack.limitedRange} @change=${(e: CustomEvent) => { settings.postPack.limitedRange = e.detail; settings.postPack.enable = settings.postPack.enable || settings.postPack.limitedRange; save(); }}></app-switch>
                `, {
  tip: t("Correct a mismatch between full-range and limited-range video levels. Off by default; turn it on only if the headset shows washed-out blacks or crushed shadows. The reset arrow restores Off; it requires the NVIDIA encoder adjustment path.\n\nSteam Link produces full-range video; the Galaxy XR client handles full-range imperfectly and lifts the 'black floor'. This remaps luma to 16-235 and chroma to 16-240 on the packed frame and tags the stream as limited range, so the headset expands it on its standard path. Measured to fix the black floor with the xrvst2ue-identity APK (no effect on the older Quest-Pro-identity build). Needs the NVENC Tap. Additionally requires Image Enhancements on; with them off this is saved but not applied.\n\nValue: streamFrame.postPack.limitedRange (settings.json). Encoder + client sides — remaps luma to 16-235 and tags the stream limited range."),
  reset: { can: settings.postPack.limitedRange != false, on: () => { settings.postPack.limitedRange = false; save(); } }
                }));

}
}
if (settings.graveyardEnable) {
          parts.push(sectionRow(t('Graveyard (retired experiments)'), sections['graveyard'], 0, () => this.toggleSection('graveyard'), 'graveyard'));
if (sections.graveyard) {
            parts.push(fieldRow(t('Kalman Freeze Coast Turn'), html`
      ${numberControl('streamFrame.kalmanFreezeCoastTurn', { value: settings.kalmanFreezeCoastTurn ?? 0, ctx: controlContext, onCommit: value => { settings.kalmanFreezeCoastTurn = value; save(); } })}
            `, {
  tip: "Try a custom curve for how motion continues during a tracking interruption. This is experimental and may make brief tracking losses feel worse.\n\nExperimental. While the tracker sends frozen positions with a live rotation (fast swings), bend the coasted hand path by the current angular velocity instead of coasting in a straight line. 0 = off (default), 1 = full coupling.",
  reset: { can: settings.kalmanFreezeCoastTurn != defaults.kalmanFreezeCoastTurn, on: () => { galaxy.reset('kalmanFreezeCoastTurn'); } }
            }));
            parts.push(fieldRow(t('Kalman Direction Lead (ms)'), html`
      <span>Td</span>
      ${numberControl('streamFrame.kalmanDirLeadMs', { value: settings.kalmanDirLeadMs, ctx: controlContext, disabled: true, onCommit: () => {} })}
      <span class="note">locked at 0 since 1.0.0 (angular frame fix)</span>
            `, {
  tip: "Retired experiment: this direction-lead setting is forced to 0. It is kept only so older settings files remain compatible.\n\nRETIRED 1.0.0: this lead was tuned while the angular velocity was reported in the wrong frame. With the frame fixed any non-zero value bends throws off target, so the driver and GUI force it to 0 on load. Original description: Fixes throws that combine arm movement WITH a wrist flick bending off target. Rotates the reported throw direction forward along your current wrist rotation by this many ms.",
  reset: { can: settings.kalmanDirLeadMs != defaults.kalmanDirLeadMs, on: () => { galaxy.reset('kalmanDirLeadMs'); } }
            }));
            parts.push(fieldRow(t('Position-Freeze Velocity Decay (ms)'), html`
      ${numberControl('streamFrame.kalmanPosFreezeVelDecayMs', { value: settings.kalmanPosFreezeVelDecayMs, ctx: controlContext, onCommit: value => { settings.kalmanPosFreezeVelDecayMs = value; save(); } })}
            `, {
  tip: "Control how quickly speed fades when controller position stops updating. 0 keeps coasting; larger decay reduces continued movement during a freeze.\n\nWhile the position is frozen (3dof fallback), the hand's velocity decays toward zero with this time constant. Short mid-throw freezes coast almost untouched; long out-of-view occlusions (windups behind the head) glide to a stop near where tracking was lost instead of sailing away on the entry velocity and reacquiring with a wrong-direction state. 0 = pure coast. Driver clamps 20-2000 when nonzero.",
  reset: { can: settings.kalmanPosFreezeVelDecayMs != defaults.kalmanPosFreezeVelDecayMs, on: () => { galaxy.reset('kalmanPosFreezeVelDecayMs'); } }
            }));
            parts.push(settingFieldRow('streamFrame.kalmanCaReportAccel', html`
      <app-switch .checked=${!!settings.kalmanCaReportAccel} @change=${(e: CustomEvent) => { settings.kalmanCaReportAccel = e.detail; save(); }}></app-switch>
            `, {
  tip: "Retired acceleration-reporting experiment. Leave this at its default; it is not a general improvement for normal play.\n\nRetired 2026-08-25. Reports the CA filter's acceleration state to SteamVR as vecAcceleration. No title was found that consumes it and it adds noise to the pose log.",
  reset: { can: settings.kalmanCaReportAccel != defaults.kalmanCaReportAccel, on: () => { galaxy.reset('kalmanCaReportAccel'); } }
            }));
if (galaxy.controllerSettings) {
const controllerSettings = galaxy.controllerSettings;
              parts.push(settingFieldRow('controllers.aligner.enable', html`
      <app-switch .checked=${!!controllerSettings.aligner.enable} @change=${(e: CustomEvent) => { controllerSettings.aligner.enable = e.detail; save(); }}></app-switch>
              `, {
  tip: "Open the controller alignment workflow to compare tracked poses and adjust held-object alignment. Follow the capture instructions and save a known-good profile first.\n\nInteractive tuning of the controller offsets below, with the controllers themselves. A magenta marker draws where the driver believes the selected controller's TIP is. MANUAL: X switches hand, Y switches position/rotation, A/B cycle the axis, stick adjusts it live. AUTOMATIC (position): plant the tip on any solid surface at chest height away from your body (armrest, desk edge), HOLD THE TRIGGER, slowly swirl a wide cone around the planted tip for a few seconds, release. Swirl again without the trigger to verify: a frozen marker means the offset is right. Rotation is finished manually by aiming. Hold a grip 1.5s to save (paste block + file). Offsets are shared by both hands for now."
              }));
}
if (vendor) {
              parts.push(fieldRow(t('Debug: Skeleton Hand Offset X (cm)'), html`
      ${numberControl('galaxyXr.skeletonOffsetXCm', { value: galaxyXr.skeletonOffsetXCm ?? 0, ctx: controlContext, onCommit: value => { galaxyXr.skeletonOffsetXCm = value; save(); } })}
              `, {
  tip: "Move the animated hand skeleton sideways relative to the controller. This affects compatible hand visuals rather than headset tracking.\n\nMoves the skeletal hand relative to its grip anchor without touching the tracked pose, controller model, or the pivot games rotate held items around. Mirrored to the right hand. Applies LIVE - no restart, watch the hand move as you adjust."
              }));
              parts.push(fieldRow(t('Debug: Skeleton Hand Offset Y (cm)'), html`
      ${numberControl('galaxyXr.skeletonOffsetYCm', { value: galaxyXr.skeletonOffsetYCm ?? 0, ctx: controlContext, onCommit: value => { galaxyXr.skeletonOffsetYCm = value; save(); } })}
              `, {
  tip: "Move the animated hand skeleton vertically relative to the controller. This affects compatible hand visuals.\n\nSecond axis of the live skeletal hand offset. Axes are in the skeleton root frame - identify directions empirically by nudging; changes apply immediately."
              }));
              parts.push(fieldRow(t('Debug: Skeleton Hand Offset Z (cm)'), html`
      ${numberControl('galaxyXr.skeletonOffsetZCm', { value: galaxyXr.skeletonOffsetZCm ?? 0, ctx: controlContext, onCommit: value => { galaxyXr.skeletonOffsetZCm = value; save(); } })}
              `, {
  tip: "Move the animated hand skeleton forward or backward relative to the controller. This affects compatible hand visuals.\n\nThird axis of the live skeletal hand offset. Set skeletonOffsetMirror to false in settings.json if the left hand needs the X direction unmirrored."
              }));
              parts.push(settingFieldRow('galaxyXr.simulateTouch', html`
      <app-switch .checked=${!!galaxyXr.simulateTouch} @change=${(e: CustomEvent) => { galaxyXr.simulateTouch = e.detail; save(); }}></app-switch>
              `, {
  tip: "Try presenting a compatible Oculus Touch controller identity to games. This is experimental, can change bindings, and requires a SteamVR restart.\n\nIdentity experiment. Adds an Oculus Touch layout above Valve Index in the controller remapping, so games that ship Touch bindings auto-remap with Touch simulation (the game applies its Touch hand offsets) instead of Index. Meant to be tested with gripConvention off in settings.json, since Samsung's raw pose is Touch-convention. Off = Index remains the fallback. Requires a SteamVR restart."
              }));
              parts.push(fieldRow(t('Controller Mesh Offset X (cm)'), html`
      ${numberControl('galaxyXr.meshOffsetXCm', { value: galaxyXr.meshOffsetXCm ?? 0, ctx: controlContext, onCommit: value => { galaxyXr.meshOffsetXCm = value; save(); } })}
              `, {
  tip: "Move only the visible controller model sideways to compensate for a pose adjustment. This does not move the underlying tracked pose.\n\nCosmetic counter-translation of the visible controller model (SteamVR Home, dashboard) after a pose trim moved it off the physical controller. Moves ONLY the mesh - no pose, anchor or held-object pivot changes. Left-hand authored, X mirrored for the right. Applies live (model regenerates and reloads within a second)."
              }));
              parts.push(fieldRow(t('Controller Mesh Offset Y (cm)'), html`
      ${numberControl('galaxyXr.meshOffsetYCm', { value: galaxyXr.meshOffsetYCm ?? 0, ctx: controlContext, onCommit: value => { galaxyXr.meshOffsetYCm = value; save(); } })}
              `, {
  tip: "Move only the visible controller model vertically. This does not move the underlying tracked pose.\n\nSecond axis of the mesh counter-translation (up/down in the controller frame)."
              }));
              parts.push(fieldRow(t('Controller Mesh Offset Z (cm)'), html`
      ${numberControl('galaxyXr.meshOffsetZCm', { value: galaxyXr.meshOffsetZCm ?? 0, ctx: controlContext, onCommit: value => { galaxyXr.meshOffsetZCm = value; save(); } })}
              `, {
  tip: "Move only the visible controller model forward or backward. This does not move the underlying tracked pose.\n\nThird axis of the mesh counter-translation. Positive moves the mesh back toward the wrist. If Position Offset Z is -2 for the hands, +2 here puts the Home mesh back on the real controller."
              }));
              parts.push(fieldRow(t('Hand Anchor X (cm)'), html`
      ${numberControl('galaxyXr.handAnchorXCm', { value: galaxyXr.handAnchorXCm ?? 0, ctx: controlContext, onCommit: value => { galaxyXr.handAnchorXCm = value; save(); } })}
              `, {
  tip: "Move the optional hand-anchor pose sideways. A game must explicitly use the hand-anchor binding for this adjustment to have an effect.\n\nTransform of the /pose/hand_anchor component, used ONLY by per-app bindings that select it (identity = same as raw). Note: a per-app binding disables SteamVR controller-type simulation, so games lose their own per-controller hand offsets - prefer the knuckles fallback and the pose trims below unless a game has no usable offsets. Left-hand authored; X, yaw and roll mirror for the right. Live."
              }));
              parts.push(fieldRow(t('Hand Anchor Y (cm)'), html`
      ${numberControl('galaxyXr.handAnchorYCm', { value: galaxyXr.handAnchorYCm ?? 0, ctx: controlContext, onCommit: value => { galaxyXr.handAnchorYCm = value; save(); } })}
              `, {
  tip: "Move the optional hand-anchor pose vertically. It only affects games bound to that pose.\n\nSecond axis of the hand anchor translation."
              }));
              parts.push(fieldRow(t('Hand Anchor Z (cm)'), html`
      ${numberControl('galaxyXr.handAnchorZCm', { value: galaxyXr.handAnchorZCm ?? 0, ctx: controlContext, onCommit: value => { galaxyXr.handAnchorZCm = value; save(); } })}
              `, {
  tip: "Move the optional hand-anchor pose forward or backward. It only affects games bound to that pose.\n\nThird axis of the hand anchor translation (negative = toward the fingertips)."
              }));
              parts.push(fieldRow(t('Hand Anchor Pitch (deg)'), html`
      ${numberControl('galaxyXr.handAnchorPitchDeg', { value: galaxyXr.handAnchorPitchDeg ?? 0, ctx: controlContext, onCommit: value => { galaxyXr.handAnchorPitchDeg = value; save(); } })}
              `, {
  tip: "Rotate the optional hand-anchor pose around its first axis. It only affects games bound to that pose.\n\nHand anchor rotation about X, in the render model rotate_xyz convention."
              }));
              parts.push(fieldRow(t('Hand Anchor Yaw (deg)'), html`
      ${numberControl('galaxyXr.handAnchorYawDeg', { value: galaxyXr.handAnchorYawDeg ?? 0, ctx: controlContext, onCommit: value => { galaxyXr.handAnchorYawDeg = value; save(); } })}
              `, {
  tip: "Rotate the optional hand-anchor pose around its second axis. It only affects games bound to that pose.\n\nHand anchor rotation about Y (mirrored for the right hand)."
              }));
              parts.push(fieldRow(t('Hand Anchor Roll (deg)'), html`
      ${numberControl('galaxyXr.handAnchorRollDeg', { value: galaxyXr.handAnchorRollDeg ?? 0, ctx: controlContext, onCommit: value => { galaxyXr.handAnchorRollDeg = value; save(); } })}
              `, {
  tip: "Rotate the optional hand-anchor pose around its third axis. It only affects games bound to that pose.\n\nHand anchor rotation about Z (mirrored for the right hand)."
              }));
}
            parts.push(settingFieldRow('streamFrame.eyeGaze.probeCapture', html`
      <app-switch .checked=${!!settings.eyeGaze.probeCapture} @change=${(e: CustomEvent) => { settings.eyeGaze.probeCapture = e.detail; save(); }}></app-switch>
            `, {
  tip: "Use a controlled comparison preset for measuring image movement. This changes a group of calibration settings; it is not intended for normal play.\n\nOne switch for an A/B scoring run: acts as Fixation Dot + Swim Probe logging + Warped Overlays together, in the right combination, so nothing can be toggled in the wrong order. Procedure: face forward, flip this on (the dot latches ahead), fixate the dot, rotate your head slowly for 60-90s sweeping it around, flip off, save vrserver.txt. Do one run with the profile off (gain 0) and one with it on, then compare with swimprobe_score.py."
            }));
            parts.push(settingFieldRow('streamFrame.skipColorWhileDashboardOpen', html`
      <app-switch .checked=${!!settings.skipColorWhileDashboardOpen} @change=${(e: CustomEvent) => { settings.skipColorWhileDashboardOpen = e.detail; save(); }}></app-switch>
            `, {
  tip: "Avoid applying color correction twice when the dashboard's custom shader is active. Choose one processing path for a fair comparison.\n\nOnly needed if the custom shader is also enabled with color adjustments: avoids applying them twice while the dashboard is open. Recommended setup for streamed headsets is custom shader off and this off.",
  reset: { can: settings.skipColorWhileDashboardOpen != defaults.skipColorWhileDashboardOpen, on: () => { galaxy.reset('skipColorWhileDashboardOpen'); } }
            }));
            parts.push(settingFieldRow('streamFrame.eyeGaze.calibDot', html`
      <app-switch .checked=${!!settings.eyeGaze.calibDot} @change=${(e: CustomEvent) => { settings.eyeGaze.calibDot = e.detail; save(); }}></app-switch>
            `, {
  tip: "Show a target fixed in the virtual world for gaze and lens-correction tests. Follow the target as directed by the measurement workflow.\n\nDraws a world-locked cyan dot, latched to your view direction the moment it's enabled (toggle off and on to re-center it). Stare at the dot and slowly ROTATE your head in place - don't translate, the dot is at infinity. With the gaze ring on, the red ring should stay centered on the dot. This is the fixation target for swim probe data collection."
            }));
            parts.push(settingFieldRow('streamFrame.eyeGaze.swimProbe', html`
      <app-switch .checked=${!!settings.eyeGaze.swimProbe} @change=${(e: CustomEvent) => { settings.eyeGaze.swimProbe = e.detail; save(); }}></app-switch>
            `, {
  tip: "Record data for measuring image movement as your eyes or head move. Use the probe with the matching calibration tools.\n\nWhile the fixation dot is on, writes throttled SwimProbe lines to vrserver.txt: gaze-vs-dot angular residual (raw and smoothed), head angular velocity, gaze sample age, and per-eye lens UVs of both. This is the raw data for empirical distortion / pupil swim calibration. Leave off when not collecting."
            }));
            parts.push(settingFieldRow('streamFrame.deriveLatchPoseAssist', html`
      <app-select .value=${settings.deriveDiagVelocity} .options=${[{ value: 'off', label: 'Normal velocity' }, { value: 'zero', label: 'Report zero (test)' }]} @change=${(e: CustomEvent) => { settings.deriveDiagVelocity = e.detail; save(); }}></app-select>
      <app-switch .checked=${!!settings.deriveLatchPoseAssist} @change=${(e: CustomEvent) => { settings.deriveLatchPoseAssist = e.detail; save(); }}></app-switch>
            `, {
  tip: "Send zero controller velocity to isolate problems caused by reported motion. This diagnostic mode can break throwing and should be off for normal play.\n\nHelps decide if a game uses vecVelocity or computes the velocity itself. Report zero for ~2 minutes: if throws still fly, the game ignores reported velocity. Turn off after testing.",
  reset: { can: settings.deriveDiagVelocity != defaults.deriveDiagVelocity || settings.deriveLatchPoseAssist != defaults.deriveLatchPoseAssist, on: () => { galaxy.reset('deriveDiagVelocity'); galaxy.reset('deriveLatchPoseAssist'); } }
            }));
            parts.push(settingFieldRow('streamFrame.kalmanDirLeadAdaptive', html`
      <app-switch .checked=${!!settings.kalmanDirLeadAdaptive} @change=${(e: CustomEvent) => { settings.kalmanDirLeadAdaptive = e.detail; save(); }}></app-switch>
      <span>Base</span>
      ${numberControl('streamFrame.kalmanDirLeadBaseMs', { value: settings.kalmanDirLeadBaseMs, ctx: controlContext, onCommit: value => { settings.kalmanDirLeadBaseMs = value; save(); } })}
      <span>Slope</span>
      ${numberControl('streamFrame.kalmanDirLeadWMs', { value: settings.kalmanDirLeadWMs, ctx: controlContext, onCommit: value => { settings.kalmanDirLeadWMs = value; save(); } })}
            `, {
  tip: "Try an experimental correction that anticipates changes in motion direction. Leave it off unless you are measuring the result.\n\nThe fixed Direction Lead above is tuned for the average throw, but the hardest wrist whips (25+ rad/s) lag the filter more, so a single value under-corrects exactly your most violent throws - the last remaining direction tail. When enabled, the lead grows smoothly with your wrist speed: base + slope x rotation speed, OVERRIDING the manual Td while on. Defaults (5 + 0.3/rads): an ordinary throw gets ~8ms, a hard whip ~14ms. No thresholds, nothing switches - gentle throws are essentially unchanged. Success looks like the rare 12-24 degree hard-whip releases dropping to the ~5 degree baseline with everything else identical.",
  reset: { can: settings.kalmanDirLeadAdaptive != defaults.kalmanDirLeadAdaptive || settings.kalmanDirLeadBaseMs != defaults.kalmanDirLeadBaseMs || settings.kalmanDirLeadWMs != defaults.kalmanDirLeadWMs, on: () => { galaxy.reset('kalmanDirLeadAdaptive'); galaxy.reset('kalmanDirLeadBaseMs'); galaxy.reset('kalmanDirLeadWMs'); } }
            }));
            parts.push(settingFieldRow('streamFrame.kalmanAdaptiveR', html`
      <app-switch .checked=${!!settings.kalmanAdaptiveR} @change=${(e: CustomEvent) => { settings.kalmanAdaptiveR = e.detail; save(); }}></app-switch>
      <span>Max</span>
      ${numberControl('streamFrame.kalmanAdaptiveRMaxDiv', { value: settings.kalmanAdaptiveRMaxDiv, ctx: controlContext, onCommit: value => { settings.kalmanAdaptiveRMaxDiv = value; save(); } })}
            `, {
  tip: "Try an experimental correction for smoothing delay. Too much correction can create overshoot or unstable motion.\n\nAttacks the hard-whip lag itself instead of compensating its direction error - so unlike Experiment A this also reaches games that compute throws from hand position history. The filter continuously measures how far the incoming tracking is outrunning its own smooth model and, exactly in proportion, trusts the raw measurements more (bounded by Max). During calm and ordinary motion it is mathematically identical to off; during violent whips it lets the filter keep up, at the honest cost of passing some tracking noise through while your hand is moving fast (where it is hard to perceive). Purely opt-in - this deliberately bends the smoothness tuning the whole campaign ratified, so judge it on its own session. Watch rDiv/rADiv in KALDIAG: 1.0 all session = it never engaged; peaks of 5-16 during whips only = working as designed.",
  reset: { can: settings.kalmanAdaptiveR != defaults.kalmanAdaptiveR || settings.kalmanAdaptiveRMaxDiv != defaults.kalmanAdaptiveRMaxDiv, on: () => { galaxy.reset('kalmanAdaptiveR'); galaxy.reset('kalmanAdaptiveRMaxDiv'); } }
            }));
            parts.push(settingFieldRow('streamFrame.kalmanGripEnable', html`
      <app-switch .checked=${!!settings.kalmanGripEnable} @change=${(e: CustomEvent) => { settings.kalmanGripEnable = e.detail; save(); }}></app-switch>
      <span>Blend</span>
      ${numberControl('streamFrame.kalmanGripBlend', { value: settings.kalmanGripBlend, ctx: controlContext, onCommit: value => { settings.kalmanGripBlend = value; save(); } })}
            `, {
  tip: "Account for rotation around a wrist or grip point when estimating controller motion. This is an advanced alignment-dependent adjustment.\n\nThe estimator honestly reports the tracked origin's velocity; during a wrist snap that includes the origin's tangential speed around your hand (w x r) - physics, not filter error, and the measured cause of combined linear+wrist throws bending off while pure linear and pure flick throws feel right. When enabled, reported velocity is transported to the grip point: v + blend x (w x r). Set r via the in-headset Aligner's GRIP capture (hold the palm still, swirl a pure wrist cone with the trigger held) or type it below. With r set but Enable OFF the driver runs shadow-only: PEAKDIAG logs gOut/gDirOff/wr showing what compensation WOULD have reported - verify a session like that first. Leave OFF for games/engines that already transport velocity to their own attach point (they would double-apply). Blend 1 = full physics; below 1 under-corrects deliberately.",
  reset: { can: settings.kalmanGripEnable != defaults.kalmanGripEnable || settings.kalmanGripBlend != defaults.kalmanGripBlend, on: () => { galaxy.reset('kalmanGripEnable'); galaxy.reset('kalmanGripBlend'); } }
            }));
            parts.push(fieldRow(t('Grip Point r - Left / Right (cm, controller local frame)'), html`
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
  tip: "Set the point around which each controller rotates. Use measurements from the alignment workflow rather than guessing large offsets.\n\nPer-hand vector from the tracked origin to the hand's rotation center, in the controller's local frame. The Aligner's GRIP capture solves this automatically (it is the same least-squares pivot solve as the tip capture, aimed at your wrist instead of a desk) and saving from the Aligner writes these fields. Typical magnitude a few cm; values are ignored (compensator inert) below 0.1cm or above 30cm. Field data 2026-08-14: per-throw inversion of the direction error clusters at |r| ~ 5cm.",
  reset: { can: settings.kalmanGripLeftCm.x != defaults.kalmanGripLeftCm.x || settings.kalmanGripLeftCm.y != defaults.kalmanGripLeftCm.y || settings.kalmanGripLeftCm.z != defaults.kalmanGripLeftCm.z || settings.kalmanGripRightCm.x != defaults.kalmanGripRightCm.x || settings.kalmanGripRightCm.y != defaults.kalmanGripRightCm.y || settings.kalmanGripRightCm.z != defaults.kalmanGripRightCm.z, on: () => { galaxy.reset('kalmanGripLeftCm'); galaxy.reset('kalmanGripRightCm'); } }
            }));
            parts.push(fieldRow(t('Black Floor: Range Remap'), html`
      <app-select .value=${settings.blackFloor.rangeMode} .options=${[{ value: 'off', label: 'Off' }, { value: 'compress', label: 'Compress (fix crushed blacks below code 16)' }, { value: 'expand', label: 'Expand (fix grey blacks / clipped whites)' }]} @change=${(e: CustomEvent) => { settings.blackFloor.rangeMode = e.detail; save(); }}></app-select>
            `, {
  tip: "Adjust video black levels to diagnose a range mismatch. Incorrect compression or expansion can wash out blacks or erase shadow detail.\n\nFix for a full-vs-limited video range mismatch in the stream chain. Compress: pre-maps into limited range (16-235) before encode - the fix when the first ~8 ramp patches are indistinguishable black (display decoding full as limited). Expand: the inverse - the fix when black looks grey and highlights clip. Leave off unless the ramp bar diagnosed one of the two."
            }));
            parts.push(settingFieldRow('streamFrame.blackFloor.shadowLift', html`
      <app-switch .checked=${!!settings.blackFloor.shadowLift} @change=${(e: CustomEvent) => { settings.blackFloor.shadowLift = e.detail; save(); }}></app-switch>
      <span>F</span>
      ${numberControl('streamFrame.blackFloor.floorCode', { value: settings.blackFloor.floorCode, ctx: controlContext, onCommit: value => { settings.blackFloor.floorCode = value; save(); } })}
      <span>K</span>
      ${numberControl('streamFrame.blackFloor.kneeCode', { value: settings.blackFloor.kneeCode, ctx: controlContext, onCommit: value => { settings.blackFloor.kneeCode = value; save(); } })}
            `, {
  tip: "Brighten the darkest visible shades. Use small values to reveal shadow detail without making black areas look gray.\n\nLifts the deepest shadows before encoding: values below the knee are remapped so black reaches the selected floor, while values above the knee are unchanged. This may make dark detail more visible, but cannot recreate detail already lost elsewhere in the pipeline. Floor 2 / knee 8 is a small starting adjustment. Check near-black test patches; excessive lifting can make blacks look gray."
            }));
            parts.push(fieldRow(t('Throw Strength Trim (scale / spin scale)'), html`
      <span>S</span>
      ${numberControl('streamFrame.kalmanMagScale', { value: settings.kalmanMagScale, ctx: controlContext, onCommit: value => { settings.kalmanMagScale = value; save(); } })}
      <span>Sa</span>
      ${numberControl('streamFrame.kalmanAngMagScale', { value: settings.kalmanAngMagScale, ctx: controlContext, onCommit: value => { settings.kalmanAngMagScale = value; save(); } })}
            `, {
  tip: "Scale the speed estimate in the acceleration-based filter. 1 leaves it unchanged; this can affect throwing strength.\n\nGlobal multipliers on reported speed and spin, kept as safety trims for the CA experiment modes. If the CA model is doing its job these converge to 1.0 - the PEAKDIAG log line (out/sec ratio) is the instrument that says whether they can.",
  reset: { can: settings.kalmanMagScale != defaults.kalmanMagScale || settings.kalmanAngMagScale != defaults.kalmanAngMagScale, on: () => { galaxy.reset('kalmanMagScale'); galaxy.reset('kalmanAngMagScale'); } }
            }));
            parts.push(fieldRow(t('Field-retired experiments - kept for reproducibility. Each lost a live test. Values here stay ACTIVE while hidden; re-test only if the transport fresh-rate materially improves.'), html`

            `, {
  reset: { can: true, on: () => { galaxy.resetGraveyard(); } }
            }));
            parts.push(settingFieldRow('streamFrame.zeroCopyV3', html`
      <app-switch .checked=${!!settings.zeroCopyV3} @change=${(e: CustomEvent) => { settings.zeroCopyV3 = e.detail; save(); }}></app-switch>
            `, {
  tip: "Use an alternate texture-staging path for image processing. This is a performance and compatibility experiment, not a picture-quality control.\n\nPerformance: instead of writing the processed frame back into the layer, it is drawn into a shared shadow texture and the streamer's own per-frame staging copy is redirected to read it - roughly halving this driver's GPU memory traffic on top of Direct Render. Failure mode is benign: any miss ships one unprocessed frame (a brief ungraded flash), the same as a sync timeout skip. Test in a disposable session first: grep the log for 'zero-copy v3: redirect active' to confirm engagement, and 'passthrough' lines to see misses. Turn off if you see persistent unprocessed frames or flicker. Requires Image Enhancements on; with them off this is saved but not applied.",
  reset: { can: settings.zeroCopyV3 != defaults.zeroCopyV3, on: () => { galaxy.reset('zeroCopyV3'); } }
            }));
            parts.push(fieldRow(t('NVENC (retired): AQ Strength'), html`
      ${numberControl('streamFrame.nvencAqStrength', { value: settings.nvencAqStrength, ctx: controlContext, onCommit: value => { settings.nvencAqStrength = value; save(); } })}
            `, {
  tip: "Do not use spatial adaptive quantization for normal play in this build. It has caused encoder stalls in testing, and the driver's safety checks may reset it.\n\nDO NOT USE. Any spatial AQ, at any strength, makes nvEncEncodePicture block 4-6 ms per frame on these tall frames and trips the streamer's 10 ms watchdog (encoder resets, soft key frames, storms). No longer forced to 0; leave at 0 unless measuring.",
  reset: { can: settings.nvencAqStrength != defaults.nvencAqStrength, on: () => { galaxy.reset('nvencAqStrength'); } }
            }));
            parts.push(fieldRow(t('NVENC (retired): Max QP'), html`
      ${numberControl('streamFrame.nvencMaxQp', { value: settings.nvencMaxQp, ctx: controlContext, onCommit: value => { settings.nvencMaxQp = value; save(); } })}
            `, {
  tip: t("Set the encoder's quantization constraint. This is an advanced quality/bandwidth constraint, not a simple quality slider.\n\nA quality floor can fight CBR and increase encoded frame sizes in complex scenes. VBV and keyframe ratios do not guarantee a hard encoded frame size limit."),
  reset: { can: settings.nvencMaxQp != defaults.nvencMaxQp, on: () => { galaxy.reset('nvencMaxQp'); } }
            }));
            parts.push(fieldRow(t('NVENC (retired): Min QP / Min QP intra'), html`
      ${numberControl('streamFrame.nvencMinQp', { value: settings.nvencMinQp, ctx: controlContext, onCommit: value => { settings.nvencMinQp = value; save(); } })}
      ${numberControl('streamFrame.nvencMinQpIntra', { value: settings.nvencMinQpIntra, ctx: controlContext, onCommit: value => { settings.nvencMinQpIntra = value; save(); } })}
            `, {
  tip: t("Request a lower quantizer bound for P/B pictures and, separately, intra pictures. A higher bound can reduce quality and encoded size where supported by the selected codec and rate-control mode.\n\nThis request is not a hard encoded-output size limit. Validate its actual effect on the running encoder.")
            }));
            parts.push(settingFieldRow('streamFrame.nvencPresetMerge', html`
      <app-switch .checked=${!!settings.nvencPresetMerge} @change=${(e: CustomEvent) => { settings.nvencPresetMerge = e.detail; save(); }}></app-switch>
            `, {
  tip: t("Preset merge adopts canonical preset settings. Explicit multipass and H.264 controls below remain authoritative. Automatic multipass uses the tested H.264 single-pass default or the HEVC/AV1 preset recommendation.\n\nValue: streamFrame.nvencPresetMerge (settings.json). Encoder side — preset merge adoption on encoder session setup; the H.264 multipass adoption stays 0."),
  reset: { can: settings.nvencPresetMerge != defaults.nvencPresetMerge, on: () => { galaxy.reset('nvencPresetMerge'); } }
            }));
            parts.push(fieldRow(t('NVENC (retired): VUI Full Range'), html`
      ${choiceControl('streamFrame.nvencVuiFullRange', {
        value: settings.nvencVuiFullRange,
        ctx: controlContext,
        onCommit: value => { settings.nvencVuiFullRange = Number(value); save(); },
      })}
            `, {
  tip: "Override video color-range metadata. Leave automatic unless diagnosing a known mismatch; incompatible client handling can darken the image.\n\n-1 leaves the streamer's tags. The correct BT.709 tags (1/1/1) make the client render dim and saturated - the client mishandles explicit tags, so these stay inert until the APK changes. A full-range value conflicting with active post-pack limited-range output is refused visibly in the driver log and the Stream Frame evidence row."
            }));
            parts.push(fieldRow(t('NVENC (retired): VUI Matrix'), html`
      ${choiceControl('streamFrame.nvencVuiMatrix', {
        value: settings.nvencVuiMatrix,
        ctx: controlContext,
        onCommit: value => { settings.nvencVuiMatrix = Number(value); save(); },
      })}
            `, {
  tip: "Colour matrix coefficients written into the stream's VUI. -1 leaves the streamer's tag. HEVC/H.264 only; the AV1 path does not write these tags."
            }));
            parts.push(fieldRow(t('NVENC (retired): VUI Primaries'), html`
      ${choiceControl('streamFrame.nvencVuiPrimaries', {
        value: settings.nvencVuiPrimaries,
        ctx: controlContext,
        onCommit: value => { settings.nvencVuiPrimaries = Number(value); save(); },
      })}
            `, {
  tip: "Colour primaries written into the stream's VUI. -1 leaves the streamer's tag. HEVC/H.264 only; the client mishandles explicit tags."
            }));
            parts.push(fieldRow(t('NVENC (retired): VUI Transfer'), html`
      ${choiceControl('streamFrame.nvencVuiTransfer', {
        value: settings.nvencVuiTransfer,
        ctx: controlContext,
        onCommit: value => { settings.nvencVuiTransfer = Number(value); save(); },
      })}
            `, {
  tip: "Transfer characteristics written into the stream's VUI. -1 leaves the streamer's tag. HEVC/H.264 only; the client mishandles explicit tags."
            }));
            parts.push(fieldRow(t('vrlink (retired): Encode Width'), html`
      ${numberControl('galaxyXr.customEncodeWidth', { value: galaxyXr.customEncodeWidth ?? 3072, ctx: controlContext, onCommit: value => { galaxyXr.customEncodeWidth = value; save(); } })}
            `, {
  tip: "Compatibility value for encoder width. It does not control the actual tile width in the current foveated streaming path.\n\nNo observable effect in foveated mode (the streamer's sampling shader never reads it); written as 3072 for compatibility.",
  reset: { can: galaxyXr.customEncodeWidth != 3072, on: () => { galaxyXr.customEncodeWidth = 3072; save(); } }
            }));
            parts.push(fieldRow(t('vrlink (retired): Max Video Queue Latency (us) / Backoff Recovery Coefficient'), html`
      ${numberControl('galaxyXr.vrlinkMaxVideoQueueLatencyUs', { value: galaxyXr.vrlinkMaxVideoQueueLatencyUs ?? 0, ctx: controlContext, onCommit: value => { galaxyXr.vrlinkMaxVideoQueueLatencyUs = value; save(); } })}
      ${numberControl('galaxyXr.vrlinkBackoffRecoveryCoefficient', { value: galaxyXr.vrlinkBackoffRecoveryCoefficient ?? 0, ctx: controlContext, onCommit: value => { galaxyXr.vrlinkBackoffRecoveryCoefficient = value; save(); } })}
            `, {
  tip: "Test undocumented Steam Link settings. 0 or the default value leaves the override unused; there is no guarantee that a particular client reads these keys.\n\nUndocumented streamer keys found in driver_vrlink.dll. No measurable effect in A/B (V1/V2). 0 leaves the streamer's defaults."
            }));
            parts.push(fieldRow(t('Gaze FOV Tangents'), html`
      <span>X</span>
      ${numberControl('streamFrame.eyeGaze.tanHalfFovX', { value: settings.eyeGaze.tanHalfFovX, ctx: controlContext, onCommit: value => { settings.eyeGaze.tanHalfFovX = value; save(); } })}
      <span>Y</span>
      ${numberControl('streamFrame.eyeGaze.tanHalfFovY', { value: settings.eyeGaze.tanHalfFovY, ctx: controlContext, onCommit: value => { settings.eyeGaze.tanHalfFovY = value; save(); } })}
            `, {
  tip: "Set the field-of-view values used to map eye gaze into the image. Incorrect values can misplace gaze-based correction.\n\nHalf-FOV tangents used to map gaze direction to screen position. 1.19 corresponds to ~100 degrees. If the ring moves too far for your gaze, increase; too little, decrease. Tune X with horizontal gaze, Y with vertical."
            }));
            parts.push(fieldRow(t('Kalman Smoothed Reporting Lag (ms)'), html`
      ${numberControl('streamFrame.kalmanSmoothLagMs', { value: settings.kalmanSmoothLagMs, ctx: controlContext, onCommit: value => { settings.kalmanSmoothLagMs = value; save(); } })}
            `, {
  tip: "Try a filter that smooths motion using a short history. This is experimental and trades some delay for steadier estimates.\n\nThe one remaining pure-estimator upgrade, aimed at what this game actually reads (your hand's position history): instead of estimating the present from the past only, the reported hand state is estimated a few ms in the past using tracking samples from BOTH sides of that moment - as calm as your A=1 tuning AND amplitude-accurate like a fast filter, a combination plain filtering cannot achieve. The whole reported state (position, rotation, velocity, spin) shifts together, staying coherent. The single honest cost: this many ms of added hand latency (partly hidden by the runtime's forward prediction, which now gets an accurate velocity). In Kalman CA this is a true fixed-lag RTS smoother; set it to roughly your measured release skew (~35 ms) and pair it with a faster Jerk (8-25) than you would run causally. 0 = off.",
  reset: { can: settings.kalmanSmoothLagMs != defaults.kalmanSmoothLagMs, on: () => { galaxy.reset('kalmanSmoothLagMs'); } }
            }));
            parts.push(fieldRow(t('Kalman Smoothed Lag Epoch'), html`
      <app-select .value=${settings.kalmanSmoothLagEpoch} .options=${[{ value: 0, label: 'Latent - stamped as current (+L hand latency)' }, { value: 1, label: 'Honest - true epoch (runtime extrapolates L)' }]} @change=${(e: CustomEvent) => { settings.kalmanSmoothLagEpoch = e.detail; save(); }}></app-select>
            `, {
  tip: "Choose how the experimental history-based filter timestamps its result. This can change how games interpret prediction and delay.\n\nHow the smoothed (L ms old) state is stamped for SteamVR. Latent (default): stamped as current, so the runtime predicts its usual short horizon and the whole hand simply carries L ms of extra latency; the submitted position history is the smoothed trajectory delayed by L, which is what pose-history throw estimators read. Honest: the true epoch (-L) is reported; the runtime then extrapolates the position by L plus its photon horizon from the reported velocity, which turned throws weak/backward in the field for this game (pose-history games); only for games that read vecVelocity directly.",
  reset: { can: settings.kalmanSmoothLagEpoch != defaults.kalmanSmoothLagEpoch, on: () => { galaxy.reset('kalmanSmoothLagEpoch'); } }
            }));
            parts.push(fieldRow(t('Gaze Aim Assist (strength 0-1 / max bend deg / min speed m/s)'), html`
      <span>G</span>
      ${numberControl('streamFrame.kalmanGazeAssist', { value: settings.kalmanGazeAssist, ctx: controlContext, onCommit: value => { settings.kalmanGazeAssist = value; save(); } })}
      <span>°</span>
      ${numberControl('streamFrame.kalmanGazeMaxDeg', { value: settings.kalmanGazeMaxDeg, ctx: controlContext, onCommit: value => { settings.kalmanGazeMaxDeg = value; save(); } })}
      <span>S</span>
      ${numberControl('streamFrame.kalmanGazeMinSpeed', { value: settings.kalmanGazeMinSpeed, ctx: controlContext, onCommit: value => { settings.kalmanGazeMinSpeed = value; save(); } })}
            `, {
  tip: "Try using gaze information to help estimate throwing direction. This is experimental, needs reliable eye tracking, and can change normal throws.\n\nUses your eye tracking to fix the last class of bad throws: you look at the target before your hand lets go, so your gaze knows the intended direction even when the release samples the hand's snap-back. Above the minimum speed, the reported throw direction is bent toward where you're looking - by strength fraction of the angle, never more than the max bend cap. Direction only: throw power and spin are untouched, the rendered hand is untouched, and if eye data is missing or stale for even 100ms it silently does nothing. Start at 0.4-0.6; the 'gaze aim assist ENGAGED' log line confirms it's live. 0 = off. TEST MODE: values above 1 shrink the disagreement needed for full gaze takeover - G=10 with max bend 180 locks every throw straight onto your gaze, for verifying the whole pipeline.",
  reset: { can: settings.kalmanGazeAssist != defaults.kalmanGazeAssist || settings.kalmanGazeMaxDeg != defaults.kalmanGazeMaxDeg || settings.kalmanGazeMinSpeed != defaults.kalmanGazeMinSpeed, on: () => { galaxy.reset('kalmanGazeAssist'); galaxy.reset('kalmanGazeMaxDeg'); galaxy.reset('kalmanGazeMinSpeed'); } }
            }));
            parts.push(fieldRow(t('Kalman Duplicate-Coast Cap (ms)'), html`
      ${numberControl('streamFrame.kalmanDupCoastMaxMs', { value: settings.kalmanDupCoastMaxMs, ctx: controlContext, onCommit: value => { settings.kalmanDupCoastMaxMs = value; save(); } })}
            `, {
  tip: "Limit how long repeated samples are treated as duplicates while the controller is still. This balances freeze detection against genuine stillness.\n\nActive even while archived. Repeats sustained past this cap are accepted as genuine stillness at full weight - no human hand holds a position bit-identically for tens of ms, so a long repeat means the tracker stopped producing, and believing it beats extrapolating or distrusting blind. Also closes a coast runaway. Default 90, range 10-500. Applies to Coast, Drop, and Soft.",
  reset: { can: settings.kalmanDupCoastMaxMs != defaults.kalmanDupCoastMaxMs, on: () => { galaxy.reset('kalmanDupCoastMaxMs'); } }
            }));
            parts.push(fieldRow(t('Kalman Direction Smoothing (linear ms / angular ms)'), html`
      <span>Dir</span>
      ${numberControl('streamFrame.kalmanDirSmoothMs', { value: settings.kalmanDirSmoothMs, ctx: controlContext, onCommit: value => { settings.kalmanDirSmoothMs = value; save(); } })}
      <span>DirA</span>
      ${numberControl('streamFrame.kalmanAngDirSmoothMs', { value: settings.kalmanAngDirSmoothMs, ctx: controlContext, onCommit: value => { settings.kalmanAngDirSmoothMs = value; save(); } })}
            `, {
  tip: "Smooth motion speed and motion direction separately in the legacy filter. This only affects the supported legacy branch.\n\nWhat your A=1 tuning discovered, made into its own knob: throw DIRECTION gets heavy smoothing (the calm you liked) while throw STRENGTH stays live (no weak throws, nothing slipping out of your hand). Set Accel back to 40-60 and put 60-90 here; direction takes on the A=1 steadiness while magnitude keeps full snap. Angular ditto for spin. 0 = off. Only the reported velocity is shaped; the rendered hand is untouched.",
  reset: { can: settings.kalmanDirSmoothMs != defaults.kalmanDirSmoothMs || settings.kalmanAngDirSmoothMs != defaults.kalmanAngDirSmoothMs, on: () => { galaxy.reset('kalmanDirSmoothMs'); galaxy.reset('kalmanAngDirSmoothMs'); } }
            }));
            parts.push(fieldRow(t('Kalman Release Rewind (ms) / Hold (ms) - EXPERIMENT'), html`
      <span>R</span>
      ${numberControl('streamFrame.kalmanReleaseRewindMs', { value: settings.kalmanReleaseRewindMs, ctx: controlContext, onCommit: value => { settings.kalmanReleaseRewindMs = value; save(); } })}
      <span>H</span>
      ${numberControl('streamFrame.kalmanRewindHoldMs', { value: settings.kalmanRewindHoldMs, ctx: controlContext, onCommit: value => { settings.kalmanRewindHoldMs = value; save(); } })}
            `, {
  tip: "Try an experimental release-time correction for throwing. 0 disables it; the approach is a hypothesis to test, not a guaranteed fix.\n\nSingle-session experiment, off at 0. Hypothesis: your trigger release reaches the PC 40-60ms later than your hand motion does, so games read the hand AFTER it already snapped back - that is where reverse throws come from. When set, the moment your release arrives, the reported velocity is taken from Rewind ms earlier in the motion history (then blends back to live over Hold ms). This is pure time re-alignment by one constant - if a value around 45 makes reverse throws vanish, the hypothesis is proven and the value IS your network's input lag; if no value in 30-60 helps, the hypothesis is dead and this stays off forever. The rendered hand is never touched.",
  reset: { can: settings.kalmanReleaseRewindMs != defaults.kalmanReleaseRewindMs || settings.kalmanRewindHoldMs != defaults.kalmanRewindHoldMs, on: () => { galaxy.reset('kalmanReleaseRewindMs'); galaxy.reset('kalmanRewindHoldMs'); } }
            }));
            parts.push(fieldRow(t('Derive Smoothing (tau slow/fast ms, speed low/high)'), html`
      <span>τS</span>
      ${numberControl('streamFrame.deriveSmoothTauSlowMs', { value: settings.deriveSmoothTauSlowMs, ctx: controlContext, onCommit: value => { settings.deriveSmoothTauSlowMs = value; save(); } })}
      <span>τF</span>
      ${numberControl('streamFrame.deriveSmoothTauFastMs', { value: settings.deriveSmoothTauFastMs, ctx: controlContext, onCommit: value => { settings.deriveSmoothTauFastMs = value; save(); } })}
      <span>sL</span>
      ${numberControl('streamFrame.deriveSmoothSpeedLow', { value: settings.deriveSmoothSpeedLow, ctx: controlContext, onCommit: value => { settings.deriveSmoothSpeedLow = value; save(); } })}
      <span>sH</span>
      ${numberControl('streamFrame.deriveSmoothSpeedHigh', { value: settings.deriveSmoothSpeedHigh, ctx: controlContext, onCommit: value => { settings.deriveSmoothSpeedHigh = value; save(); } })}
            `, {
  tip: "Adjust the motion filter's smoothing automatically with speed. This changes the trade-off between steady slow motion and responsive fast motion.\n\nSpeed-adaptive smoothing for the Derive velocity mode, live reloaded. The filter time constant slides from tau slow (held still: kills trembling) to tau fast (throw speeds: near raw so the peak survives) as effective speed crosses low..high. Lower tau fast raises the reported peak but passes more raw noise at release; if throw directions misbehave, prefer the Split Direction toggles below over pushing tau fast toward zero.",
  reset: { can: settings.deriveSmoothTauSlowMs != defaults.deriveSmoothTauSlowMs || settings.deriveSmoothTauFastMs != defaults.deriveSmoothTauFastMs || settings.deriveSmoothSpeedLow != defaults.deriveSmoothSpeedLow || settings.deriveSmoothSpeedHigh != defaults.deriveSmoothSpeedHigh, on: () => { galaxy.reset('deriveSmoothTauSlowMs'); galaxy.reset('deriveSmoothTauFastMs'); galaxy.reset('deriveSmoothSpeedLow'); galaxy.reset('deriveSmoothSpeedHigh'); } }
            }));
            parts.push(settingFieldRow('streamFrame.deriveSmoothAngSeparate', html`
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
  tip: "Use a separate smoothing strength for rotational motion. This lets rotation and straight-line movement be tuned independently.\n\nGives the angular (spin) channel its own speed-adaptive smoothing instead of sharing the linear channel's filter. Field data shows the shared filter under-serves spin: reported angular speed swings about +-40% around raw. Defaults are chosen to be nearly behavior neutral on enable, so tune from there: raise tau fast to calm spin jitter, lower speed high if wrist-flick throws lose their snap. Angular speeds are in rad/s (a firm wrist flick peaks around 10-20).",
  reset: { can: settings.deriveSmoothAngSeparate != defaults.deriveSmoothAngSeparate || settings.deriveSmoothAngTauSlowMs != defaults.deriveSmoothAngTauSlowMs || settings.deriveSmoothAngTauFastMs != defaults.deriveSmoothAngTauFastMs || settings.deriveSmoothAngSpeedLow != defaults.deriveSmoothAngSpeedLow || settings.deriveSmoothAngSpeedHigh != defaults.deriveSmoothAngSpeedHigh, on: () => { galaxy.reset('deriveSmoothAngSeparate'); galaxy.reset('deriveSmoothAngTauSlowMs'); galaxy.reset('deriveSmoothAngTauFastMs'); galaxy.reset('deriveSmoothAngSpeedLow'); galaxy.reset('deriveSmoothAngSpeedHigh'); } }
            }));
            parts.push(settingFieldRow('streamFrame.deriveSplitDirLinear', html`
      <app-switch .checked=${!!settings.deriveSplitDirLinear} @change=${(e: CustomEvent) => { settings.deriveSplitDirLinear = e.detail; save(); }}></app-switch>
            `, {
  tip: "Use a separate smoothing strength for straight-line motion direction. It only affects filter modes that split speed from direction.\n\nExperimental fix for throws flying in random directions with Derive mode. Keeps the smoothed velocity MAGNITUDE but takes the DIRECTION from a speed-weighted average of the raw estimates over a short window, so the fastest (most reliable) samples pin the release direction. Toggle one channel at a time for a clean A/B; the log line 'VelocityFix: split-dir active' confirms it engaged.",
  reset: { can: settings.deriveSplitDirLinear != defaults.deriveSplitDirLinear, on: () => { galaxy.reset('deriveSplitDirLinear'); } }
            }));
            parts.push(settingFieldRow('streamFrame.deriveSplitDirAngular', html`
      <app-switch .checked=${!!settings.deriveSplitDirAngular} @change=${(e: CustomEvent) => { settings.deriveSplitDirAngular = e.detail; save(); }}></app-switch>
            `, {
  tip: "Use a separate smoothing strength for rotation direction. It only affects filter modes that split rotation speed from direction.\n\nSame split treatment for angular velocity (spin direction at release). Independent from the linear toggle so A/B tests stay single-variable.",
  reset: { can: settings.deriveSplitDirAngular != defaults.deriveSplitDirAngular, on: () => { galaxy.reset('deriveSplitDirAngular'); } }
            }));
            parts.push(fieldRow(t('Latch Angular Min Speed (rad/s) / Input Prefilter'), html`
      ${numberControl('streamFrame.deriveLatchAngMinSpeed', { value: settings.deriveLatchAngMinSpeed, ctx: controlContext, onCommit: value => { settings.deriveLatchAngMinSpeed = value; save(); } })}
      <app-select .value=${settings.derivePreFilter} .options=${[{ value: 'off', label: 'Off (raw input)' }, { value: 'median3', label: 'Median of 3 (recommended)' }]} @change=${(e: CustomEvent) => { settings.derivePreFilter = e.detail; save(); }}></app-select>
            `, {
  tip: "Choose the minimum spin speed needed before the experimental spin latch takes effect. Keep the default unless testing that mode.\n\nAngular min speed: the spin channel's own latch gate - wrist snaps above this replay their peak spin at release, gentler rotation stays live (6 is a deliberate flick; casual regrabs sit far below). Input prefilter median3: cleans single-frame network position spikes BEFORE velocity is derived, at one sample of lag - the recommended fix for jitter tails and twitchy held objects. Off restores raw input for A/B.",
  reset: { can: settings.deriveLatchAngMinSpeed != defaults.deriveLatchAngMinSpeed || settings.derivePreFilter != defaults.derivePreFilter, on: () => { galaxy.reset('deriveLatchAngMinSpeed'); galaxy.reset('derivePreFilter'); } }
            }));
            parts.push(fieldRow(t('Input Pre-Smoothing (ms) / Scope'), html`
      ${numberControl('streamFrame.derivePreSmoothMs', { value: settings.derivePreSmoothMs, ctx: controlContext, onCommit: value => { settings.derivePreSmoothMs = value; save(); } })}
      <app-select .value=${settings.derivePreSmoothScope} .options=${[{ value: 'direction', label: 'Direction only (recommended)' }, { value: 'both', label: 'Both direction and speed' }]} @change=${(e: CustomEvent) => { settings.derivePreSmoothScope = e.detail; save(); }}></app-select>
            `, {
  tip: "Choose which parts of motion data receive the optional pre-filter. Different scopes can change both responsiveness and noise.\n\nSmooths the raw tracking stream BEFORE anything is derived from it, with adjustable strength (0 = off; try 10-25; capped at 100). Scope 'Direction only' cleans what the throw direction and rendered-hand prediction see while speed is still derived from the exact positions - the recommended way to calm jittery hands without losing throw power. 'Both' also feeds the smoothed stream to the speed derivation: maximum calm, slight peak lag. Works alongside the median-of-3 spike filter.",
  reset: { can: settings.derivePreSmoothMs != defaults.derivePreSmoothMs || settings.derivePreSmoothScope != defaults.derivePreSmoothScope, on: () => { galaxy.reset('derivePreSmoothMs'); galaxy.reset('derivePreSmoothScope'); } }
            }));
            parts.push(fieldRow(t('Split Direction Source'), html`
      <app-select .value=${settings.deriveDirSource} .options=${[{ value: 'secant', label: 'Position secant (recommended)' }, { value: 'runtime', label: 'Runtime report direction' }, { value: 'window', label: 'Window average (original)' }]} @change=${(e: CustomEvent) => { settings.deriveDirSource = e.detail; save(); }}></app-select>
            `, {
  tip: "Choose where the motion-direction estimate comes from. The choices use different sample histories and can behave differently around release.\n\nWhere the throw DIRECTION comes from when a Split Direction toggle is on (magnitude always comes from the smoothed estimate). Position secant: direction of the raw hand displacement over the last ~25-70ms - very noise resistant, small fixed lag; the recommended default. Runtime report: direction of the driver's own (heavily smoothed) velocity - device-side sensor fusion, smooth but more lagged. Window average: the original weighted average of recent estimates - kept for A/B, weakest against correlated noise. After changing this, flip a Split toggle off and on to get a fresh confirmation log line.",
  reset: { can: settings.deriveDirSource != defaults.deriveDirSource, on: () => { galaxy.reset('deriveDirSource'); } }
            }));
            parts.push(fieldRow(t('Split Magnitude Source'), html`
      <app-select .value=${settings.deriveMagSource} .options=${[{ value: 'vector', label: 'Vector length (original)' }, { value: 'scalar', label: 'Scalar speed (recommended test)' }]} @change=${(e: CustomEvent) => { settings.deriveMagSource = e.detail; save(); }}></app-select>
            `, {
  tip: "Choose where the motion-speed estimate comes from. Compare with measured throws rather than assuming a different source is more accurate.\n\nWhere the throw SPEED comes from when a Split Direction toggle is on. Vector: length of the smoothed velocity vector (original; components pointing in changing directions partially cancel inside the average, which both jitters and under-reads mid-swing). Scalar: the speed itself is smoothed with the same adaptive time constant - no cancellation, less jitter for the same responsiveness. Recommended test: Scalar, combined with Tau Fast raised to ~15-20 (direction no longer pays for a slower magnitude filter since it comes from the secant).",
  reset: { can: settings.deriveMagSource != defaults.deriveMagSource, on: () => { galaxy.reset('deriveMagSource'); } }
            }));
            parts.push(settingFieldRow('streamFrame.deriveReleaseLatch', html`
      <app-switch .checked=${!!settings.deriveReleaseLatch} @change=${(e: CustomEvent) => { settings.deriveReleaseLatch = e.detail; save(); }}></app-switch>
      <span>W</span>
      ${numberControl('streamFrame.deriveLatchWindowMs', { value: settings.deriveLatchWindowMs, ctx: controlContext, onCommit: value => { settings.deriveLatchWindowMs = value; save(); } })}
      <span>H</span>
      ${numberControl('streamFrame.deriveLatchHoldMs', { value: settings.deriveLatchHoldMs, ctx: controlContext, onCommit: value => { settings.deriveLatchHoldMs = value; save(); } })}
      <span>S</span>
      ${numberControl('streamFrame.deriveLatchMinSpeed', { value: settings.deriveLatchMinSpeed, ctx: controlContext, onCommit: value => { settings.deriveLatchMinSpeed = value; save(); } })}
            `, {
  tip: "Retain a recent speed peak briefly around release in the legacy filter. This can change throw strength and may exaggerate a noisy peak.\n\nFixes throws that come out weak or die mid-air: field data shows the input release event often trails the hand motion, so about a quarter of throws sample the velocity AFTER the hand already slowed. When on, the moment your trigger/grip release arrives, the output replays the strongest recent motion (window below) for the hold duration - full strength for the first half, fading after. Normal throws that release at the peak are unaffected. The three numbers: peak window ms / hold ms / minimum speed to engage (m/s).",
  reset: { can: settings.deriveReleaseLatch != defaults.deriveReleaseLatch, on: () => { galaxy.reset('deriveReleaseLatch'); } }
            }));
            parts.push(fieldRow(t('Split Direction Window (ms) / Weight Power'), html`
      <span>W</span>
      ${numberControl('streamFrame.deriveDirWindowMs', { value: settings.deriveDirWindowMs, ctx: controlContext, onCommit: value => { settings.deriveDirWindowMs = value; save(); } })}
      <span>P</span>
      ${numberControl('streamFrame.deriveDirWeightPow', { value: settings.deriveDirWeightPow, ctx: controlContext, onCommit: value => { settings.deriveDirWeightPow = value; save(); } })}
            `, {
  tip: "Choose how older samples are weighted when averaging motion direction. Recent-sample weighting reacts faster but may be less steady.\n\nWindow: how far back the direction average looks (clamped 5-200 in the driver). Shorter follows wrist snaps tighter but averages less noise. Weight power: how strongly fast samples dominate (speed^power weighting); 2 is a good default, higher approaches 'direction of the single fastest sample', 0 is an unweighted average.",
  reset: { can: settings.deriveDirWindowMs != defaults.deriveDirWindowMs || settings.deriveDirWeightPow != defaults.deriveDirWeightPow, on: () => { galaxy.reset('deriveDirWindowMs'); galaxy.reset('deriveDirWeightPow'); } }
            }));
}
}
}
}


    return html`<app-system-ready .ctx=${this.ctx}>${this.sectionCardsFor(parts)}</app-system-ready>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'app-stream-frame-page': StreamFramePage;
  }
}
