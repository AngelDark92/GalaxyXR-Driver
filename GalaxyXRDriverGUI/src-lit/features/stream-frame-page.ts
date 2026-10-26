// Stream Frame (Image Settings) page, ported from the Angular template (2026-09-20 Lit/Fluent migration).
// Every conditional, field, tip, reset scope and control binding from the original
// template is preserved 1:1; the only interpretation layer is the control
// adapters (app-switch / app-select / app-number / app-slider) whose events
// were verified against the pinned @fluentui/web-components package.
import { html, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';
import { css } from 'lit';
import { BasePage, settingFieldRow, fieldRow, noteRow, sectionRow, sectionHeading, sectionGroup, fieldStyles } from './page-base';
import { t } from '../locale/i18n';
import { pageIntro, statusMessage } from '../ui/presentation';
import { encoderTapStatus, encoderEvidence, expiredEncoderEvidence } from '../domain/encoder-tap-status';
import { spacewarpStatus } from '../domain/spacewarp-status';
import { HALF_RATE_AVAILABLE, isRetiredModeSelection, spacewarpModeValues } from '../domain/spacewarp-modes';
import { codecSwitchState } from '../domain/codec-selection';
import { ofxrCanArm, ofxrDisabledReason } from '../domain/ofxr';
import type { OfxrPreferences, OfxrStatus } from '../domain/types';
import { codecEncoderDefaults, streamFrameIntegerError } from '../state/galaxy-settings';
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
  private readonly streamNumberErrors = new Map<string, string>();
  // 2026-10-16: inline per-key validation for app-number rows (the driver
  // contract in streamFrameIntegerError). The entered value is kept and
  // saved exactly as typed; the error row names the key and its accepted
  // range until a valid value is entered. Nothing is rounded or replaced.
  private noteNumberError(key: string, value: number | undefined, context?: { forceCbr: boolean }): void {
    const error = streamFrameIntegerError(key, value, context);
    if (error) this.streamNumberErrors.set(key, error); else this.streamNumberErrors.delete(key);
    this.requestUpdate();
  }
  private numberErrorRow(key: string): TemplateResult {
    const message = this.streamNumberErrors.get(key);
    return message ? noteRow(html`${message}`) : html``;
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
    const evidence = encoderEvidence(this.ctx.dis.values(), this.ctx.startup.status());
    // 2026-10-16: heal stale inline errors each render — programmatic writes
    // (codec switches, reset arrows) can satisfy an earlier recorded error,
    // and Force CBR moves the keyframe-scale contract with itself.
    if (settings) {
      const context = { forceCbr: !!settings.nvencForceCbr };
      const contractValues: Record<string, number | undefined> = {
        'galaxyXr.customStreamFormatWidth': galaxy.streamQualityValues.width,
        'galaxyXr.customBandwidthMbit': galaxy.streamQualityValues.bandwidth,
        'streamFrame.nvencBandwidthOverrideMbit': settings.nvencBandwidthOverrideMbit,
        'streamFrame.nvencBitrateMbit': settings.nvencBitrateMbit,
        'streamFrame.nvencMaxBitrateHeadroomPct': settings.nvencMaxBitrateHeadroomPct,
        'streamFrame.nvencForceFps': settings.nvencForceFps,
        'streamFrame.nvencVbvFrames': settings.nvencVbvFrames,
        'streamFrame.nvencAqStrength': settings.nvencAqStrength,
        'streamFrame.nvencLowDelayKfScale': settings.nvencLowDelayKfScale,
        'streamFrame.nvencPreset': settings.nvencPreset,
        'streamFrame.nvencMultiPass': settings.nvencMultiPass,
        'streamFrame.nvencSplitMode': settings.nvencSplitMode,
        'streamFrame.nvencMaxQp': settings.nvencMaxQp,
        'streamFrame.nvencMinQp': settings.nvencMinQp,
        'streamFrame.nvencMinQpIntra': settings.nvencMinQpIntra,
        'streamFrame.nvencQpFovea': settings.nvencQpFovea,
        'streamFrame.nvencQpPeriphery': settings.nvencQpPeriphery,
        'streamFrame.nvencH264GopFrames': settings.nvencH264GopFrames,
        'streamFrame.nvencH264IdrFrames': settings.nvencH264IdrFrames,
        'streamFrame.nvencH264RefFrames': settings.nvencH264RefFrames,
        'streamFrame.nvencH264Entropy': settings.nvencH264Entropy,
        'streamFrame.nvencH264SliceMode': settings.nvencH264SliceMode,
        'streamFrame.nvencH264SliceData': settings.nvencH264SliceData,
        'streamFrame.nvencH264VbvInitialDelay': settings.nvencH264VbvInitialDelay,
        'streamFrame.nvencVuiFullRange': settings.nvencVuiFullRange,
        'streamFrame.nvencBitrateConstancyPct': settings.nvencBitrateConstancyPct,
        'streamFrame.nvencVuiMatrix': settings.nvencVuiMatrix,
        'streamFrame.nvencVuiPrimaries': settings.nvencVuiPrimaries,
        'streamFrame.nvencVuiTransfer': settings.nvencVuiTransfer,
      };
      for (const [key, value] of Object.entries(contractValues)) {
        const error = streamFrameIntegerError(key, value, context);
        if (error) this.streamNumberErrors.set(key, error); else this.streamNumberErrors.delete(key);
      }
    }
    const parts: TemplateResult[] = [pageIntro(t('Image Settings'), t('Stream quality, color, and sharpening.'))];
if (settings) {
      parts.push(html`<app-driver-enable-banner .ctx=${this.ctx}></app-driver-enable-banner>`);
if (galaxy.calibrationActive()) {
          parts.push(statusMessage('warning', t('Calibration is active'), t('Stop calibration before playing.'),
            html`<fluent-button appearance="outline" @click=${() => { galaxy.stopCalibration(); this.requestUpdate(); }}>${t('Stop calibration')}</fluent-button>`));
}
if (vendor) {
        const codecDef = codecEncoderDefaults[settings.nvencCodec ?? 0] ?? codecEncoderDefaults[0];
        parts.push(sectionHeading(t('Stream Quality'), 0, 'stream-quality'));
          parts.push(fieldRow(t('Tile Width'), html`
      <app-number .value=${galaxy.streamQualityValues.width} step="1" min="1" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { galaxy.setStreamQualityValue('width', e.detail); } this.noteNumberError('galaxyXr.customStreamFormatWidth', e.detail); save(); }}></app-number>
          `, {
  tip: t("Tile width is sent unchanged for every codec. Each frame contains four stacked tiles. The codec and GPU determine the supported dimensions; unsupported requests report an encoder error instead of changing resolution. Requires a SteamVR restart.\n\nValue: galaxyXr.customStreamFormatWidth (settings.json), applied through the shared stream-quality values. SteamVR side — streamFormatWidth/encodeWidth in steamvr.vrsettings; also feeds the encoder tap's tile answers."),
  reset: { can: galaxy.streamQualityValues.width != codecDef.streamFormatWidth, on: () => { galaxy.setStreamQualityValue('width', codecDef.streamFormatWidth); save(); } }
          }));
          parts.push(this.numberErrorRow('galaxyXr.customStreamFormatWidth'));
          if (settings.nvencCodec === 1 && galaxy.streamQualityValues.width > 1024) {
            parts.push(statusMessage('warning', t('H.264 tile width above 1024'),
              t('Steam Link negotiates H.264 at 1024 × 4096. A tile width above 1024 requests a taller four-tile frame and may fail to encode. Your value is kept and remains editable; reset Tile Width to use 1024.')));
          }
          parts.push(fieldRow(t('Max Bitrate (Mbit/s)'), html`
      <app-number .value=${galaxy.streamQualityValues.bandwidth} step="1" min="1" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { galaxy.setStreamQualityValue('bandwidth', e.detail); } this.noteNumberError('galaxyXr.customBandwidthMbit', e.detail); save(); }}></app-number>
          `, {
  tip: t("Set the stream bandwidth budget and the highest requested encoder target (the Max Bitrate ceiling for the curve). The budget is written to targetBandwidth and recommendedBandwidthMbit for pacing. The driver maps the streamer's request directly onto this Max Bitrate; there is no separate 350 Mbit/s clamp. No curve point or applied target can exceed this Max Bitrate value.\n\nA target is not a guarantee of actual encoded output or constant sent bits. Actual encoded and wire rates depend on content and encoder behavior. Takes effect at the next SteamVR start or headset connect. Requires a SteamVR restart.\n\nValue: galaxyXr.customBandwidthMbit (settings.json), applied through the shared stream-quality values. SteamVR side — targetBandwidth + recommendedBandwidthMbit in steamvr.vrsettings; encoder side — requested bitrate target."),
  reset: { can: galaxy.streamQualityValues.bandwidth != codecDef.bandwidthMbit, on: () => { galaxy.setStreamQualityValue('bandwidth', codecDef.bandwidthMbit); save(); } }
          }));
          parts.push(this.numberErrorRow('galaxyXr.customBandwidthMbit'));
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
            if ((evidence.effectiveCodec ?? -1) >= 0) parts.push(noteRow(html`${t('Latest accepted encoder: {codec}; {width} × {height}; rate control {rc}; split {split}.', {
              codec: names[evidence.effectiveCodec ?? -1] ?? t('Unknown'), width: evidence.encodeWidth ?? 0, height: evidence.encodeHeight ?? 0,
              rc: evidence.effectiveRateControl === 2 ? 'CBR' : evidence.effectiveRateControl === 1 ? 'VBR' : t('Unknown'),
              split: evidence.effectiveSplit === -1 ? t('Not applicable') : evidence.effectiveSplit ?? t('Unknown') })}`));
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
        // 2026-10-21 (owner directive): the Half rate selection is retired from this row;
        // the saved mode value and the driver contract stay untouched.
        const spacewarpMode = settings.spacewarpMode ?? 0;
        parts.push(settingFieldRow('streamFrame.spacewarpEnable', html`
      <span class="spacewarp-controls"><app-switch .checked=${!!settings.spacewarpEnable} ?disabled=${this.ctx.ofxr.changing()} @change=${(e: CustomEvent) => { void this.setSpacewarp(e.detail); }}></app-switch>${HALF_RATE_AVAILABLE ? html`<app-select ?disabled=${!settings.spacewarpEnable || this.ctx.ofxr.changing()} .value=${spacewarpMode} .options=${spacewarpModeValues().map((value) => ({ value, label: value === 1 ? t('Half rate') : t('Late frames only') }))} @change=${(e: CustomEvent) => { settings.spacewarpMode = Number(e.detail); save(); }}></app-select>` : html``}</span>
            `, {
  tip: `${isRetiredModeSelection(spacewarpMode) ? t('Half rate is retired in this build. Late frames only is applied; your saved choice is kept.') + '\n\n' : ''}${t("Applies live to the running stream. Async Spacewarp synthesizes frames on the headset client when the stream misses a display tick. It needs the GXR spacewarp client patch (experimental) installed on the headset; without it the stream shows extra held frames instead of synthesized frames. When your graphics card supports optical flow (NVIDIA Turing generation or newer with Optical Flow hardware), prefer Optical Flow: it synthesizes on the PC with hardware motion vectors and needs no headset patch. Only one synthesis mode runs at a time: enabling this turns Optical Flow off, and enabling Optical Flow turns this off.\n\nMode: Late frames only synthesizes when a display tick has no new decoded frame. Mode changes are saved immediately and apply live.\n\nValue: streamFrame.spacewarpEnable and streamFrame.spacewarpMode (settings.json). Stream side — publishes the toggle and mode live to the running vrlink stream; the headset client synthesizes the frames.")}`,
  reset: { can: settings.spacewarpEnable != defaults.spacewarpEnable || settings.spacewarpMode != defaults.spacewarpMode, on: () => { galaxy.reset('spacewarpEnable'); galaxy.reset('spacewarpMode'); } }
            }));
        {
          const spacewarpState = spacewarpStatus(!!settings.spacewarpEnable, this.ctx.dis.values(), this.ctx.startup.status());
          parts.push(statusMessage(spacewarpState === 'on' ? 'success' : spacewarpState === 'waiting' ? 'warning' : 'info',
            t(spacewarpState === 'on' ? 'Async Spacewarp: Active' : spacewarpState === 'waiting' ? 'Async Spacewarp: Waiting for stream' : 'Async Spacewarp: Off'),
            t(spacewarpState === 'on' ? 'The running stream carries the request. Frames are synthesized only while the headset client patch is active.'
              : spacewarpState === 'waiting' ? 'The saved value is not confirmed by the running stream yet. When this persists while streaming, the headset needs the GXR spacewarp client patch (experimental) to synthesize frames; without it the stream shows extra held frames instead of synthesized frames.'
              : 'The stream is left unchanged; no frames are synthesized.')));
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
        parts.push(sectionRow(t('Color'), sections['color'], 1, () => this.toggleSection('color')));
if (sections.color) {
          parts.push(fieldRow(t('Brightness'), html`
      <app-number .value=${settings.brightness} step="0.05" min="0.05" max="1.5" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.brightness = e.detail; } save(); }}></app-number>
      <app-slider .value=${settings.brightness} .min=${0.05} .max=${1.5} .step=${0.05} @change=${(e: CustomEvent) => { settings.brightness = e.detail; save(); }}></app-slider>
          `, {
  tip: t("Adjust the overall picture brightness. Lower values darken the image; this is a display preference, not a guarantee about panel lifespan.\n\nScales output brightness in the host image-processing path. Compare against a known neutral setting and avoid compensating for a video-range mismatch with brightness alone. Panel wear depends on many factors; this control does not provide a measured or guaranteed lifespan improvement.\n\nValue: streamFrame.brightness (settings.json). Driver side — per-frame brightness scale in the host image pipeline."),
  reset: { can: settings.brightness != defaults.brightness, on: () => { galaxy.reset('brightness'); } }
          }));
          parts.push(fieldRow(t('Saturation'), html`
      <app-number .value=${settings.saturation} step="1" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.saturation = e.detail; } save(); }}></app-number>
      <app-slider .value=${settings.saturation} .min=${0} .max=${100} .step=${1} @change=${(e: CustomEvent) => { settings.saturation = e.detail; save(); }}></app-slider>
          `, {
  tip: t("Adjust the strength of colors. The neutral value keeps the original color saturation.\n\nIncrease or decrease the variation of the colors. 50 is neutral, 0 is grayscale.\n\nValue: streamFrame.saturation (settings.json). Driver side — per-frame color saturation; mirrored into the compositor-shader path."),
  reset: { can: settings.saturation != defaults.saturation, on: () => { galaxy.reset('saturation'); } }
          }));
          parts.push(fieldRow(t('Vibrance'), html`
      <app-number .value=${settings.vibrance} step="1" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.vibrance = e.detail; } save(); }}></app-number>
      <app-slider .value=${settings.vibrance} .min=${-100} .max=${100} .step=${1} @change=${(e: CustomEvent) => { settings.vibrance = e.detail; save(); }}></app-slider>
          `, {
  tip: t("Boost quieter colors without changing all colors equally. Use small adjustments to avoid an unnatural-looking picture.\n\nSmart saturation: changes muted colors the most and already vivid colors the least. Positive enriches dull colors with far less clipping and skin tone blowout than raw saturation; negative fades muted colors toward gray while vivid accents remain. 0 is off, stacks with Saturation.\n\nValue: streamFrame.vibrance (settings.json). Driver side — selective saturation boost for muted colors."),
  reset: { can: settings.vibrance != defaults.vibrance, on: () => { galaxy.reset('vibrance'); } }
          }));
          parts.push(fieldRow(t('Contrast'), html`
      <app-number .value=${settings.contrast} step="1" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.contrast = e.detail; } save(); }}></app-number>
      <app-slider .value=${settings.contrast} .min=${0} .max=${100} .step=${1} @change=${(e: CustomEvent) => { settings.contrast = e.detail; save(); }}></app-slider>
          `, {
  tip: t("Adjust the difference between light and dark areas. Stronger contrast can hide details in shadows or highlights.\n\nContrast around the midpoint. 50 is neutral.\n\nValue: streamFrame.contrast (settings.json). Driver side — midpoint contrast; mirrored into the compositor-shader path."),
  reset: { can: settings.contrast != defaults.contrast, on: () => { galaxy.reset('contrast'); } }
          }));
          parts.push(fieldRow(t('Contrast Midpoint'), html`
      <app-number .value=${settings.contrastMidpoint} step="1" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.contrastMidpoint = e.detail; } save(); }}></app-number>
      <app-slider .value=${settings.contrastMidpoint} .min=${0} .max=${100} .step=${1} @change=${(e: CustomEvent) => { settings.contrastMidpoint = e.detail; save(); }}></app-slider>
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
      <app-number .value=${settings.gamma} step="0.01" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.gamma = e.detail; } save(); }}></app-number>
      <app-slider .value=${settings.gamma} .min=${1.2} .max=${3.2} .step=${0.01} @change=${(e: CustomEvent) => { settings.gamma = e.detail; save(); }}></app-slider>
          `, {
  tip: t("Adjust midtone brightness without using the overall brightness control. The neutral pipeline value is 2.2.\n\nGamma of the output. 2.2 is neutral, lower brightens midtones.\n\nValue: streamFrame.gamma (settings.json). Driver side — output gamma; 2.2 neutral."),
  reset: { can: settings.gamma != defaults.gamma, on: () => { galaxy.reset('gamma'); } }
          }));
          parts.push(fieldRow(t('Color Multiplier'), html`
      <span>R</span>
      <app-number .value=${settings.colorMultiplier.r} step="0.01" min="0" max="2" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.colorMultiplier.r = e.detail; } save(); }}></app-number>
      <span>G</span>
      <app-number .value=${settings.colorMultiplier.g} step="0.01" min="0" max="2" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.colorMultiplier.g = e.detail; } save(); }}></app-number>
      <span>B</span>
      <app-number .value=${settings.colorMultiplier.b} step="0.01" min="0" max="2" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.colorMultiplier.b = e.detail; } save(); }}></app-number>
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
}
        parts.push(sectionRow(t('Image Enhancements'), sections['enhance'], 1, () => this.toggleSection('enhance')));
if (sections.enhance) {
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
      <app-number .value=${settings.postPack.foveaStrength} step="0.05" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.postPack.foveaStrength = e.detail; } save(); }}></app-number>
      <app-slider .value=${settings.postPack.foveaStrength} .min=${0} .max=${1} .step=${0.05} @change=${(e: CustomEvent) => { settings.postPack.foveaStrength = e.detail; save(); }}></app-slider>
            `, {
  tip: t("Adjust sharpening in the high-detail center of the streamed image. Too much sharpening can create bright outlines or noise.\n\nSharpening for the gaze cut-out tile (1:1 render-target pixels), 0 to 1. Under CBR sharpening costs bits: spend them here.\n\nValue: streamFrame.postPack.foveaStrength (settings.json). Encoder side — post-pack sharpening of the gaze tile."),
  reset: { can: settings.postPack.foveaStrength != 0.6, on: () => { settings.postPack.foveaStrength = 0.6; save(); } }
            }));
            parts.push(fieldRow(t('Edge Sharpness'), html`
      <app-number .value=${settings.postPack.peripheryStrength} step="0.05" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.postPack.peripheryStrength = e.detail; } save(); }}></app-number>
      <app-slider .value=${settings.postPack.peripheryStrength} .min=${0} .max=${1} .step=${0.05} @change=${(e: CustomEvent) => { settings.postPack.peripheryStrength = e.detail; save(); }}></app-slider>
            `, {
  tip: t("Adjust sharpening outside the high-detail center. This affects the lower-detail edges of the streamed image.\n\nSharpening for the downscaled whole-view tile, 0 to 1. Applied after the downscale, so it is visible on the panel; keep it lower than the fovea to avoid haloing on the stretched periphery.\n\nValue: streamFrame.postPack.peripheryStrength (settings.json). Encoder side — post-pack sharpening of the downscaled whole-view tile."),
  reset: { can: settings.postPack.peripheryStrength != 0.3, on: () => { settings.postPack.peripheryStrength = 0.3; save(); } }
            }));
            parts.push(fieldRow(t('Center-Edge Blend'), html`
      <app-number .value=${settings.postPack.edgeFalloff} step="0.02" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.postPack.edgeFalloff = e.detail; } save(); }}></app-number>
      <app-slider .value=${settings.postPack.edgeFalloff} .min=${0} .max=${0.5} .step=${0.02} @change=${(e: CustomEvent) => { settings.postPack.edgeFalloff = e.detail; save(); }}></app-slider>
            `, {
  tip: t("Smooth the transition between center and edge sharpening. Use this when a visible boundary appears around the sharp region.\n\nFraction of the fovea tile (0 to 0.5) over which its sharpening ramps down to the periphery strength at the tile border, so the seam where the headset composites the cut-out over the stretched periphery is not a sharpness step. 0 = hard edge. Raise if a halo is visible around the fovea region.\n\nValue: streamFrame.postPack.edgeFalloff (settings.json). Encoder side — ramp width of the center-to-edge sharpening transition."),
  reset: { can: settings.postPack.edgeFalloff != 0.12, on: () => { settings.postPack.edgeFalloff = 0.12; save(); } }
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
      <app-number .value=${settings.cas.strength} step="0.05" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.cas.strength = e.detail; } save(); }}></app-number>
      <app-slider .value=${settings.cas.strength} .min=${0} .max=${1} .step=${0.05} @change=${(e: CustomEvent) => { settings.cas.strength = e.detail; save(); }}></app-slider>
              `, {
  tip: t("Set the overall sharpening strength. Higher values can improve apparent detail but may also amplify noise or create halos.\n\nStrength of the sharpening from 0 to 1.\n\nValue: streamFrame.cas.strength (settings.json). Driver side — pre-encode sharpening strength (0-1).")
              }));
}
if (settings.cas.perEye) {
              parts.push(fieldRow(t('Strength Left'), html`
      <app-number .value=${settings.cas.strengthLeft} step="0.05" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.cas.strengthLeft = e.detail; } save(); }}></app-number>
      <app-slider .value=${settings.cas.strengthLeft} .min=${0} .max=${1} .step=${0.05} @change=${(e: CustomEvent) => { settings.cas.strengthLeft = e.detail; save(); }}></app-slider>
              `, {
  tip: t("Set sharpening strength for the left eye. Compare both eyes to avoid an uneven-looking image.\n\nSharpening strength for the left eye only, 0 to 1.\n\nValue: streamFrame.cas.strengthLeft (settings.json). Driver side — per-eye pre-encode strength, left (0-1).")
              }));
              parts.push(fieldRow(t('Strength Right'), html`
      <app-number .value=${settings.cas.strengthRight} step="0.05" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.cas.strengthRight = e.detail; } save(); }}></app-number>
      <app-slider .value=${settings.cas.strengthRight} .min=${0} .max=${1} .step=${0.05} @change=${(e: CustomEvent) => { settings.cas.strengthRight = e.detail; save(); }}></app-slider>
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
      <app-number .value=${settings.stationaryDimming.movementTime} step="1" min="2" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.stationaryDimming.movementTime = e.detail; } save(); }}></app-number>
      <span>fade</span>
      <app-number .value=${settings.stationaryDimming.dimSeconds} step="1" min="1" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.stationaryDimming.dimSeconds = e.detail; } save(); }}></app-number>
            `, {
  tip: t("Set how long the headset must stay still before dimming starts and how quickly the picture fades.\n\nSeconds of stillness before dimming starts, and seconds to fade fully to black.\n\nValue: streamFrame.stationaryDimming.movementTime + dimSeconds (settings.json). Driver side — stillness threshold and fade duration, in seconds.")
            }));
}
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
      <app-number .value=${ofxr.maxLogMb} step="1" min="1" max="512" ?disabled=${this.ctx.ofxr.changing() || !this.ctx.ofxr.isArmed() || !ofxr.logging} @change=${(e: CustomEvent) => { if (e.detail !== undefined) void this.updateOfxr({ maxLogMb: e.detail }); }}></app-number>
            `, {
  tip: t("Maximum size of the flight log before it rolls over.\n\nValue: ofxr.maxLogMb (gui-settings.json). Companion side — writes max_file_mb.")
            }));
        parts.push(settingFieldRow('ofxr.flushEachEvent', html`
      <app-switch .checked=${ofxr.flushEachEvent} ?disabled=${this.ctx.ofxr.changing() || !this.ctx.ofxr.isArmed() || !ofxr.logging} @change=${(e: CustomEvent) => { void this.updateOfxr({ flushEachEvent: e.detail }); }}></app-switch>
            `, {
  tip: t("Write each flight-log event to disk immediately. Safer for crash reports, slower.\n\nValue: ofxr.flushEachEvent (gui-settings.json). Companion side — writes flush_each_event.")
            }));
        parts.push(fieldRow(t('OFXR Bridge version'), html`
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
        parts.push(sectionGroup(t('Advanced'), 1));
          parts.push(fieldRow(t('Frame Sync Timeout (ms)'), html`
      <app-number .value=${settings.syncTimeoutMs} step="1" min="1" max="100" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.syncTimeoutMs = e.detail; } save(); }}></app-number>
          `, {
  tip: t("Skip a synchronization wait in the image-processing path. This is a latency experiment and can cause flashes or other display artifacts.\n\nHow long to wait for the frame sync before letting a frame through unprocessed (a brief 'flash' of ungraded color). Higher values trade flashes under heavy load for slightly later frames. After a skipped frame the wait automatically escalates to break flash streaks. Default 10, sensible range 3-15.\n\nValue: streamFrame.syncTimeoutMs (settings.json). Driver side — frame-sync wait before passing a frame unprocessed, in ms."),
  reset: { can: settings.syncTimeoutMs != defaults.syncTimeoutMs, on: () => { galaxy.reset('syncTimeoutMs'); } }
          }));
          parts.push(fieldRow(t('Gaze Prediction (ms)'), html`
      <app-number .value=${settings.eyeGaze.predictionMs} step="5" min="0" max="100" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.eyeGaze.predictionMs = e.detail; } save(); }}></app-number>
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
      <app-number .value=${settings.nvencBandwidthOverrideMbit} step="25" min="0" max="600" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.nvencBandwidthOverrideMbit = e.detail; } this.noteNumberError('streamFrame.nvencBandwidthOverrideMbit', e.detail); save(); }}></app-number>
                `, {
  tip: t("Override the normal stream bandwidth budget. 0 follows the Max Bitrate row above instead of forcing a separate value.\n\nNonzero supplies the network pacing budget and highest requested encoder target instead of the Max Bitrate row. It does not guarantee actual encoded output or constant sent bits. Requires a SteamVR restart.\n\nValue: streamFrame.nvencBandwidthOverrideMbit (settings.json). SteamVR + encoder sides — pacing budget and requested encoder target."),
  reset: { can: settings.nvencBandwidthOverrideMbit != defaults.nvencBandwidthOverrideMbit, on: () => { galaxy.reset('nvencBandwidthOverrideMbit'); } }
                }));
                parts.push(this.numberErrorRow('streamFrame.nvencBandwidthOverrideMbit'));
                parts.push(fieldRow(t('VBV Encoder Buffer Budget'), html`
      <app-number .value=${settings.nvencVbvFrames} step="1" min="0" max="30" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.nvencVbvFrames = e.detail; } this.noteNumberError('streamFrame.nvencVbvFrames', e.detail); save(); }}></app-number>
                `, {
  tip: t("Request an NVENC VBV buffer budget in nominal frame units. A smaller budget can reduce buffering but makes complex scenes harder to encode cleanly.\n\nFor N > 0, requested VBV = (target bits/s / nominal fps) × N, in bits. 0 preserves the caller's VBV value. This is a rate-control buffer request, not a guaranteed maximum encoded frame size or a transport limit. Requires a SteamVR restart.\n\nValue: streamFrame.nvencVbvFrames (settings.json). Encoder side — requested VBV buffer size in bits."),
  reset: { can: settings.nvencVbvFrames != codecDef.vbvFrames, on: () => { settings.nvencVbvFrames = codecDef.vbvFrames; save(); } }
                }));
                parts.push(this.numberErrorRow('streamFrame.nvencVbvFrames'));
                parts.push(fieldRow(t('Encoder Quality Preset'), html`
      <app-number .value=${settings.nvencPreset} step="1" min="0" max="7" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.nvencPreset = e.detail; } this.noteNumberError('streamFrame.nvencPreset', e.detail); save(); }}></app-number>
                `, {
  tip: t("Choose the NVIDIA encoding preset. Keep automatic selection unless you are testing a specific quality or latency trade-off.\n\n0 = automatic by NVENC engine count (3 engines: P7, 2: P5, 1: P4; logged as 'preset AUTO'). Higher presets spend more encoder time for better quality at the same bitrate; P7 needs the split across three engines to hold 90 fps. Auto resolves to P2 for H.264 (P7/P5/P4 by engine count otherwise).\n\nValue: streamFrame.nvencPreset (settings.json). Encoder side — NVENC preset selector; 0 = automatic by engine count."),
  reset: { can: settings.nvencPreset != defaults.nvencPreset, on: () => { galaxy.reset('nvencPreset'); } }
                }));
                parts.push(this.numberErrorRow('streamFrame.nvencPreset'));
                parts.push(settingFieldRow('streamFrame.nvencForceCbr', html`
      <app-switch .checked=${!!settings.nvencForceCbr} @change=${(e: CustomEvent) => { settings.nvencForceCbr = e.detail; save(); }}></app-switch>
      ${evidence && (evidence.effectiveCodec ?? -1) >= 0 ? html`<span class="note-inline">${t('Latest accepted rate control: {rc}', {
        rc: evidence.effectiveRateControl === 2 ? 'CBR' : evidence.effectiveRateControl === 1 ? 'VBR'
          : evidence.effectiveRateControl === 0 ? t('Constant QP') : t('Unknown') })}</span>` : html``}
                `, {
  tip: t("Force CBR selects constant-bitrate rate control. It does not guarantee constant encoded output or constant sent bits. Off is the default for every codec and preserves upstream rate control, which may already be CBR. Turn it on whenever it helps. The reset arrow restores Off. Requires a SteamVR restart.\n\nValue: streamFrame.nvencForceCbr (settings.json). Encoder side — requests CBR rate control with low-delay keyframes."),
  reset: { can: settings.nvencForceCbr != codecDef.forceCbr, on: () => { settings.nvencForceCbr = codecDef.forceCbr; save(); } }
                }));
                {
                  // 2026-10-19: lock only on an observed running session. The
                  // freshness-checked predicate treated a missing or stale
                  // report as "running", which locked these rows permanently
                  // when SteamVR was closed; the page already polls every 2 s.
                  const curveLocked = this.ctx.startup.status()?.steamvrRunning === true;
                  const curveDisabled = curveLocked;
                  const curveNote = curveLocked ? html`<span class="note-inline">${t('Close SteamVR to change')}</span>` : html``;
                  parts.push(settingFieldRow('streamFrame.nvencBitrateCurve', html`
      <app-select ?disabled=${curveDisabled} .value=${settings.nvencBitrateCurve ?? 0} .options=${BITRATE_CURVE_FAMILIES.map(family => ({ value: family.value, label: t(family.label) }))} @change=${(e: CustomEvent) => { galaxy.setBitrateCurve(Number(e.detail)); }}></app-select>
      ${curveNote}
                  `, {
  tip: t("Choose how the streamer's per-frame request becomes the requested encoder target. Close SteamVR to change this; the saved value applies to the next session. Requires a SteamVR restart.\n\nThe ceiling is the highest requested encoder target, not a guaranteed actual output limit. Linear maps a request at Max Bitrate to that ceiling; below it the request passes through. Power knee raises targets in the middle of the range and keeps a proportional tail below 60% of Max Bitrate; soft knee requests the ceiling from 60% upward. Custom uses seven points in the graph window: P1 is fixed at request 0 with an editable floor, P2–P5 are free, P6 starts at the fixed Max Bitrate endpoint overlapping hidden P7 and can move left to start the plateau, and P7 is fixed at full request and Max Bitrate and is shown only as the curve endpoint. At 100% constancy, every positive request selects the ceiling regardless of curve family. No point or applied target can exceed Max Bitrate. None of these settings guarantees constant encoded output or constant sent bits.\n\nValue: streamFrame.nvencBitrateCurve and streamFrame.nvencBitrateCurvePoints (settings.json). Encoder side — reshapes the requested NVENC average bitrate target."),
  reset: { can: (settings.nvencBitrateCurve ?? 0) !== defaults.nvencBitrateCurve, on: () => galaxy.resetBitrateCurve() }
                  }));
                  parts.push(settingFieldRow('streamFrame.nvencBitrateConstancyPct', html`
      <app-number ?disabled=${curveDisabled} .value=${settings.nvencBitrateConstancyPct ?? 0} step="5" min="0" max="100" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.nvencBitrateConstancyPct = e.detail; } this.noteNumberError('streamFrame.nvencBitrateConstancyPct', e.detail); save(); }}></app-number>
      ${curveNote}
                  `, {
  tip: t("Lift the selected curve toward Max Bitrate. 0 leaves the selected curve unchanged; 100 requests Max Bitrate for any positive streamer request; the applied target never exceeds it. Close SteamVR to change this. Requires a SteamVR restart.\n\nWith a 450 Mbit/s Max Bitrate, a 280 Mbit/s request is 62% of the range: 280 with Linear at 0%, about 315 with power knee at 0%, about 355 with Linear at 50%, about 377 with power knee at 50%, and 450 at 100%. These are requested targets, not guaranteed encoded or wire rates. Higher constancy reduces the encoder target's response to congestion and can increase stream resets or stalled pacing.\n\nValue: streamFrame.nvencBitrateConstancyPct (settings.json). Encoder side — exponent lift applied to the selected curve."),
  reset: { can: (settings.nvencBitrateConstancyPct ?? 0) !== defaults.nvencBitrateConstancyPct, on: () => galaxy.reset('nvencBitrateConstancyPct') }
                  }));
                  parts.push(this.numberErrorRow('streamFrame.nvencBitrateConstancyPct'));
                  parts.push(fieldRow(t('Bitrate Curve Graph'), html`
      <fluent-button appearance="outline" @click=${() => { void this.openCurveWindow(); }}>${t('Open graph window')}</fluent-button>
                  `, {
  tip: t("Open the curve graph in its own resizable window. It follows the curve and percentage immediately while you edit them. Editable, drawn from the same arithmetic the driver uses. Drag P1–P6 to shape a Custom curve; P1 stays at request 0 with an editable floor, P2–P5 are free, P6 starts on the fixed Max Bitrate endpoint and moves left to start the plateau, and hidden P7 stays at full request and Max Bitrate. Selecting a preset seeds the handles.\n\nSolid line: the applied curve after Bitrate Constancy; the thin line is the base curve through the seven points. Dashed line: the linear reference mapping; the top line is Max Bitrate. The graph shows requested encoder targets, not measured encoded output or wire rates; the five-frame request median is not drawn. Minimizing or closing to the tray hides the graph with the Companion. Quitting the Companion closes the graph window too.\n\nValue: streamFrame.nvencBitrateCurve + streamFrame.nvencBitrateCurvePoints (settings.json). Client side graph; the main window validates and saves committed edits.")
                  }));
                  if (this.curveWindowError) {
                    parts.push(noteRow(html`${t('The graph window could not be opened: {reason}', { reason: this.curveWindowError })}`));
                  }
                }
                parts.push(settingFieldRow('streamFrame.nvencMultiPass', html`
                  <app-select .value=${settings.nvencMultiPass ?? -1} .options=${[
                    { value: -1, label: t('Automatic (codec / preset)') }, { value: 0, label: t('Single pass') },
                    { value: 1, label: t('Two passes, quarter resolution') }, { value: 2, label: t('Two passes, full resolution') }
                  ]} @change=${(e: CustomEvent) => { settings.nvencMultiPass = e.detail; save(); }}></app-select>
                `, { tip: t('Explicit multipass selection applies even when preset merge is off. Automatic keeps the codec and preset recommendation. Unsupported requests fail without fallback.\n\nValue: streamFrame.nvencMultiPass (settings.json). Encoder side — pass count hint; automatic follows the codec/preset recommendation.'),
                  reset: { can: settings.nvencMultiPass !== defaults.nvencMultiPass, on: () => galaxy.reset('nvencMultiPass') } }));
                if (settings.nvencCodec === 1) {
                  parts.push(noteRow(html`${t('H.264 compatibility defaults are editable below. Reset arrows restore the tested values. Split-Frame is not applicable to H.264; its saved choice is retained.')}`));
                  parts.push(settingFieldRow('streamFrame.nvencH264GopFrames', html`
                    <app-number .value=${settings.nvencH264GopFrames ?? defaults.nvencH264GopFrames} step="1"
                      @change=${(e: CustomEvent) => { this.noteNumberError('streamFrame.nvencH264GopFrames', e.detail); if (e.detail !== undefined) { settings.nvencH264GopFrames = e.detail; save(); } }}></app-number>
                  `, { tip: t("0 = automatic nominal frame rate; -1 = leave upstream GOP unchanged. Positive values are applied exactly."), reset: { can: settings.nvencH264GopFrames !== defaults.nvencH264GopFrames, on: () => galaxy.reset('nvencH264GopFrames') } }));
                  parts.push(this.numberErrorRow('streamFrame.nvencH264GopFrames'));
                  parts.push(settingFieldRow('streamFrame.nvencH264IdrFrames', html`
                    <app-number .value=${settings.nvencH264IdrFrames ?? defaults.nvencH264IdrFrames} step="1"
                      @change=${(e: CustomEvent) => { this.noteNumberError('streamFrame.nvencH264IdrFrames', e.detail); if (e.detail !== undefined) { settings.nvencH264IdrFrames = e.detail; save(); } }}></app-number>
                  `, { tip: t("0 = automatic nominal frame rate; -1 = leave upstream IDR unchanged. Positive values are applied exactly."), reset: { can: settings.nvencH264IdrFrames !== defaults.nvencH264IdrFrames, on: () => galaxy.reset('nvencH264IdrFrames') } }));
                  parts.push(this.numberErrorRow('streamFrame.nvencH264IdrFrames'));
                  parts.push(settingFieldRow('streamFrame.nvencH264RefFrames', html`
                    <app-number .value=${settings.nvencH264RefFrames ?? defaults.nvencH264RefFrames} step="1"
                      @change=${(e: CustomEvent) => { this.noteNumberError('streamFrame.nvencH264RefFrames', e.detail); if (e.detail !== undefined) { settings.nvencH264RefFrames = e.detail; save(); } }}></app-number>
                  `, { tip: t("Set the reference-frame count. Unsupported requests fail instead of falling back."), reset: { can: settings.nvencH264RefFrames !== defaults.nvencH264RefFrames, on: () => galaxy.reset('nvencH264RefFrames') } }));
                  parts.push(this.numberErrorRow('streamFrame.nvencH264RefFrames'));
                  parts.push(settingFieldRow('streamFrame.nvencH264Entropy', html`
                    <app-number .value=${settings.nvencH264Entropy ?? defaults.nvencH264Entropy} step="1"
                      @change=${(e: CustomEvent) => { this.noteNumberError('streamFrame.nvencH264Entropy', e.detail); if (e.detail !== undefined) { settings.nvencH264Entropy = e.detail; save(); } }}></app-number>
                  `, { tip: t("0 = automatic; 1 = CABAC; 2 = CAVLC. Automatic uses CAVLC above 200 Mbit/s."), reset: { can: settings.nvencH264Entropy !== defaults.nvencH264Entropy, on: () => galaxy.reset('nvencH264Entropy') } }));
                  parts.push(this.numberErrorRow('streamFrame.nvencH264Entropy'));
                  parts.push(settingFieldRow('streamFrame.nvencH264SliceMode', html`
                    <app-number .value=${settings.nvencH264SliceMode ?? defaults.nvencH264SliceMode} step="1"
                      @change=${(e: CustomEvent) => { this.noteNumberError('streamFrame.nvencH264SliceMode', e.detail); if (e.detail !== undefined) { settings.nvencH264SliceMode = e.detail; save(); } }}></app-number>
                  `, { tip: t("NVENC slice mode: 0 = macroblocks; 1 = bytes; 2 = rows; 3 = slice count."), reset: { can: settings.nvencH264SliceMode !== defaults.nvencH264SliceMode, on: () => galaxy.reset('nvencH264SliceMode') } }));
                  parts.push(this.numberErrorRow('streamFrame.nvencH264SliceMode'));
                  parts.push(settingFieldRow('streamFrame.nvencH264SliceData', html`
                    <app-number .value=${settings.nvencH264SliceData ?? defaults.nvencH264SliceData} step="1"
                      @change=${(e: CustomEvent) => { this.noteNumberError('streamFrame.nvencH264SliceData', e.detail); if (e.detail !== undefined) { settings.nvencH264SliceData = e.detail; save(); } }}></app-number>
                  `, { tip: t("Value for the selected NVENC slice mode."), reset: { can: settings.nvencH264SliceData !== defaults.nvencH264SliceData, on: () => galaxy.reset('nvencH264SliceData') } }));
                  parts.push(this.numberErrorRow('streamFrame.nvencH264SliceData'));
                  parts.push(settingFieldRow('streamFrame.nvencH264VbvInitialDelay', html`
                    <app-number .value=${settings.nvencH264VbvInitialDelay ?? defaults.nvencH264VbvInitialDelay} step="1"
                      @change=${(e: CustomEvent) => { this.noteNumberError('streamFrame.nvencH264VbvInitialDelay', e.detail); if (e.detail !== undefined) { settings.nvencH264VbvInitialDelay = e.detail; save(); } }}></app-number>
                  `, { tip: t("Initial VBV delay in bits. Zero preserves the tested low-latency default."), reset: { can: settings.nvencH264VbvInitialDelay !== defaults.nvencH264VbvInitialDelay, on: () => galaxy.reset('nvencH264VbvInitialDelay') } }));
                  parts.push(this.numberErrorRow('streamFrame.nvencH264VbvInitialDelay'));
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
      <app-number .value=${settings.nvencLowDelayKfScale} step="1" min="0" max="255" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.nvencLowDelayKfScale = e.detail; } this.noteNumberError('streamFrame.nvencLowDelayKfScale', e.detail, { forceCbr: !!settings.nvencForceCbr }); save(); }}></app-number>
                `, {
  tip: t("With Force CBR, request the keyframe-to-P-frame size ratio (0–255, NVENC byte field). NVENC documents this ratio for CBR with a single-frame VBV buffer. It is not a hard keyframe size limit or a transport limit. The optimized recommendation is 2. Unsupported requests fail without rewriting the value. Requires a SteamVR restart.\n\nValue: streamFrame.nvencLowDelayKfScale (settings.json). Encoder side — requested low-delay keyframe ratio under CBR."),
  reset: { can: settings.nvencLowDelayKfScale != codecDef.lowDelayKfScale, on: () => { settings.nvencLowDelayKfScale = codecDef.lowDelayKfScale; save(); } }
                }));
                parts.push(this.numberErrorRow('streamFrame.nvencLowDelayKfScale'));
                parts.push(fieldRow(t('Multi-Engine Encoding'), html`
      <app-number .value=${settings.nvencSplitMode} step="1" min="0" max="15" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.nvencSplitMode = e.detail; } this.noteNumberError('streamFrame.nvencSplitMode', e.detail); save(); }}></app-number>
                `, {
  tip: t("0 = automatic; 1 = forced, driver-selected strips; 2–4 = requested strips; 15 = disabled. Other values are rejected. Values above 0 require an accepted NVENC API 12.1 session upgrade, and a refusal shows in the driver log and the Stream Frame evidence row. H.264 does not support split encoding and retains this choice without applying it. AV1 API upgrade is independent of this value. Requires a SteamVR restart.\n\nValue: streamFrame.nvencSplitMode (settings.json). Encoder side — multi-engine split; nonzero opens the API 12.1 encoder session."),
  reset: { can: settings.nvencSplitMode != codecDef.splitMode, on: () => { settings.nvencSplitMode = codecDef.splitMode; save(); } }
                }));
                parts.push(this.numberErrorRow('streamFrame.nvencSplitMode'));
                parts.push(fieldRow(t('Center Quality Boost (QP)'), html`
      <app-number .value=${settings.nvencQpFovea} step="1" min="-10" max="0" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.nvencQpFovea = e.detail; } this.noteNumberError('streamFrame.nvencQpFovea', e.detail); save(); }}></app-number>
      <app-number .value=${settings.nvencQpPeriphery} step="1" min="0" max="10" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.nvencQpPeriphery = e.detail; } this.noteNumberError('streamFrame.nvencQpPeriphery', e.detail); save(); }}></app-number>
                `, {
  tip: t("Spend more encoding quality on the center of the image than on the edges. This advanced option can change artifacts in different areas.\n\nMoves bits within the same bitrate: a QP offset per block, negative for the gaze cut-out tile (finer, more bits) and positive for the periphery tile (coarser, fewer bits), blended over the same edge falloff as the sharpening. 0 / 0 = off. Small values (-2 / 2, -3 / 3) work; large ones starve the whole frame. The ramp shape and fovea-tile parity come from the Edge Falloff and fovea-top controls (shown with CAS in post-process mode) — one value drives both the sharpening and the encoder QP ramp.\n\nValue: streamFrame.nvencQpFovea + nvencQpPeriphery (settings.json). Encoder side — per-block QP offsets that move bits to the gaze tile."),
  reset: { can: settings.nvencQpFovea != 0 || settings.nvencQpPeriphery != 0, on: () => { settings.nvencQpFovea = 0; settings.nvencQpPeriphery = 0; save(); } }
                }));
                parts.push(this.numberErrorRow('streamFrame.nvencQpFovea'));
                parts.push(this.numberErrorRow('streamFrame.nvencQpPeriphery'));
                parts.push(settingFieldRow('streamFrame.postPack.limitedRange', html`
      <app-switch .checked=${!!settings.postPack.limitedRange} @change=${(e: CustomEvent) => { settings.postPack.limitedRange = e.detail; settings.postPack.enable = settings.postPack.enable || settings.postPack.limitedRange; save(); }}></app-switch>
                `, {
  tip: t("Correct a mismatch between full-range and limited-range video levels. Off by default; turn it on only if the headset shows washed-out blacks or crushed shadows. The reset arrow restores Off; it requires the NVIDIA encoder adjustment path.\n\nSteam Link produces full-range video; the Galaxy XR client handles full-range imperfectly and lifts the 'black floor'. This remaps luma to 16-235 and chroma to 16-240 on the packed frame and tags the stream as limited range, so the headset expands it on its standard path. Measured to fix the black floor with the xrvst2ue-identity APK (no effect on the older Quest-Pro-identity build). Needs the NVENC Tap. Additionally requires Image Enhancements on; with them off this is saved but not applied.\n\nValue: streamFrame.postPack.limitedRange (settings.json). Encoder + client sides — remaps luma to 16-235 and tags the stream limited range."),
  reset: { can: settings.postPack.limitedRange != false, on: () => { settings.postPack.limitedRange = false; save(); } }
                }));

}
}
if (settings.graveyardEnable) {
          parts.push(sectionRow(t('Graveyard (retired experiments)'), sections['graveyard'], 0, () => this.toggleSection('graveyard')));
if (sections.graveyard) {
            parts.push(fieldRow(t('Kalman Freeze Coast Turn'), html`
      <app-number .value=${settings.kalmanFreezeCoastTurn} step="0.25" min="0" max="1" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanFreezeCoastTurn = e.detail; } save(); }}></app-number>
            `, {
  tip: "Try a custom curve for how motion continues during a tracking interruption. This is experimental and may make brief tracking losses feel worse.\n\nExperimental. While the tracker sends frozen positions with a live rotation (fast swings), bend the coasted hand path by the current angular velocity instead of coasting in a straight line. 0 = off (default), 1 = full coupling.",
  reset: { can: settings.kalmanFreezeCoastTurn != defaults.kalmanFreezeCoastTurn, on: () => { galaxy.reset('kalmanFreezeCoastTurn'); } }
            }));
            parts.push(fieldRow(t('Kalman Direction Lead (ms)'), html`
      <span>Td</span>
      <app-number .value=${settings.kalmanDirLeadMs} ?disabled=${true}></app-number>
      <span class="note">locked at 0 since 1.0.0 (angular frame fix)</span>
            `, {
  tip: "Retired experiment: this direction-lead setting is forced to 0. It is kept only so older settings files remain compatible.\n\nRETIRED 1.0.0: this lead was tuned while the angular velocity was reported in the wrong frame. With the frame fixed any non-zero value bends throws off target, so the driver and GUI force it to 0 on load. Original description: Fixes throws that combine arm movement WITH a wrist flick bending off target. Rotates the reported throw direction forward along your current wrist rotation by this many ms.",
  reset: { can: settings.kalmanDirLeadMs != defaults.kalmanDirLeadMs, on: () => { galaxy.reset('kalmanDirLeadMs'); } }
            }));
            parts.push(fieldRow(t('Position-Freeze Velocity Decay (ms)'), html`
      <app-number .value=${settings.kalmanPosFreezeVelDecayMs} step="20" min="0" max="2000" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanPosFreezeVelDecayMs = e.detail; } save(); }}></app-number>
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
      <app-number .value=${galaxyXr.skeletonOffsetXCm} step="0.25" min="-10" max="10" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { galaxyXr.skeletonOffsetXCm = e.detail; } save(); }}></app-number>
              `, {
  tip: "Move the animated hand skeleton sideways relative to the controller. This affects compatible hand visuals rather than headset tracking.\n\nMoves the skeletal hand relative to its grip anchor without touching the tracked pose, controller model, or the pivot games rotate held items around. Mirrored to the right hand. Applies LIVE - no restart, watch the hand move as you adjust."
              }));
              parts.push(fieldRow(t('Debug: Skeleton Hand Offset Y (cm)'), html`
      <app-number .value=${galaxyXr.skeletonOffsetYCm} step="0.25" min="-10" max="10" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { galaxyXr.skeletonOffsetYCm = e.detail; } save(); }}></app-number>
              `, {
  tip: "Move the animated hand skeleton vertically relative to the controller. This affects compatible hand visuals.\n\nSecond axis of the live skeletal hand offset. Axes are in the skeleton root frame - identify directions empirically by nudging; changes apply immediately."
              }));
              parts.push(fieldRow(t('Debug: Skeleton Hand Offset Z (cm)'), html`
      <app-number .value=${galaxyXr.skeletonOffsetZCm} step="0.25" min="-10" max="10" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { galaxyXr.skeletonOffsetZCm = e.detail; } save(); }}></app-number>
              `, {
  tip: "Move the animated hand skeleton forward or backward relative to the controller. This affects compatible hand visuals.\n\nThird axis of the live skeletal hand offset. Set skeletonOffsetMirror to false in settings.json if the left hand needs the X direction unmirrored."
              }));
              parts.push(settingFieldRow('galaxyXr.simulateTouch', html`
      <app-switch .checked=${!!galaxyXr.simulateTouch} @change=${(e: CustomEvent) => { galaxyXr.simulateTouch = e.detail; save(); }}></app-switch>
              `, {
  tip: "Try presenting a compatible Oculus Touch controller identity to games. This is experimental, can change bindings, and requires a SteamVR restart.\n\nIdentity experiment. Adds an Oculus Touch layout above Valve Index in the controller remapping, so games that ship Touch bindings auto-remap with Touch simulation (the game applies its Touch hand offsets) instead of Index. Meant to be tested with gripConvention off in settings.json, since Samsung's raw pose is Touch-convention. Off = Index remains the fallback. Requires a SteamVR restart."
              }));
              parts.push(fieldRow(t('Controller Mesh Offset X (cm)'), html`
      <app-number .value=${galaxyXr.meshOffsetXCm} step="0.25" min="-10" max="10" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { galaxyXr.meshOffsetXCm = e.detail; } save(); }}></app-number>
              `, {
  tip: "Move only the visible controller model sideways to compensate for a pose adjustment. This does not move the underlying tracked pose.\n\nCosmetic counter-translation of the visible controller model (SteamVR Home, dashboard) after a pose trim moved it off the physical controller. Moves ONLY the mesh - no pose, anchor or held-object pivot changes. Left-hand authored, X mirrored for the right. Applies live (model regenerates and reloads within a second)."
              }));
              parts.push(fieldRow(t('Controller Mesh Offset Y (cm)'), html`
      <app-number .value=${galaxyXr.meshOffsetYCm} step="0.25" min="-10" max="10" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { galaxyXr.meshOffsetYCm = e.detail; } save(); }}></app-number>
              `, {
  tip: "Move only the visible controller model vertically. This does not move the underlying tracked pose.\n\nSecond axis of the mesh counter-translation (up/down in the controller frame)."
              }));
              parts.push(fieldRow(t('Controller Mesh Offset Z (cm)'), html`
      <app-number .value=${galaxyXr.meshOffsetZCm} step="0.25" min="-10" max="10" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { galaxyXr.meshOffsetZCm = e.detail; } save(); }}></app-number>
              `, {
  tip: "Move only the visible controller model forward or backward. This does not move the underlying tracked pose.\n\nThird axis of the mesh counter-translation. Positive moves the mesh back toward the wrist. If Position Offset Z is -2 for the hands, +2 here puts the Home mesh back on the real controller."
              }));
              parts.push(fieldRow(t('Hand Anchor X (cm)'), html`
      <app-number .value=${galaxyXr.handAnchorXCm} step="0.25" min="-20" max="20" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { galaxyXr.handAnchorXCm = e.detail; } save(); }}></app-number>
              `, {
  tip: "Move the optional hand-anchor pose sideways. A game must explicitly use the hand-anchor binding for this adjustment to have an effect.\n\nTransform of the /pose/hand_anchor component, used ONLY by per-app bindings that select it (identity = same as raw). Note: a per-app binding disables SteamVR controller-type simulation, so games lose their own per-controller hand offsets - prefer the knuckles fallback and the pose trims below unless a game has no usable offsets. Left-hand authored; X, yaw and roll mirror for the right. Live."
              }));
              parts.push(fieldRow(t('Hand Anchor Y (cm)'), html`
      <app-number .value=${galaxyXr.handAnchorYCm} step="0.25" min="-20" max="20" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { galaxyXr.handAnchorYCm = e.detail; } save(); }}></app-number>
              `, {
  tip: "Move the optional hand-anchor pose vertically. It only affects games bound to that pose.\n\nSecond axis of the hand anchor translation."
              }));
              parts.push(fieldRow(t('Hand Anchor Z (cm)'), html`
      <app-number .value=${galaxyXr.handAnchorZCm} step="0.25" min="-20" max="20" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { galaxyXr.handAnchorZCm = e.detail; } save(); }}></app-number>
              `, {
  tip: "Move the optional hand-anchor pose forward or backward. It only affects games bound to that pose.\n\nThird axis of the hand anchor translation (negative = toward the fingertips)."
              }));
              parts.push(fieldRow(t('Hand Anchor Pitch (deg)'), html`
      <app-number .value=${galaxyXr.handAnchorPitchDeg} step="1" min="-90" max="90" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { galaxyXr.handAnchorPitchDeg = e.detail; } save(); }}></app-number>
              `, {
  tip: "Rotate the optional hand-anchor pose around its first axis. It only affects games bound to that pose.\n\nHand anchor rotation about X, in the render model rotate_xyz convention."
              }));
              parts.push(fieldRow(t('Hand Anchor Yaw (deg)'), html`
      <app-number .value=${galaxyXr.handAnchorYawDeg} step="1" min="-90" max="90" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { galaxyXr.handAnchorYawDeg = e.detail; } save(); }}></app-number>
              `, {
  tip: "Rotate the optional hand-anchor pose around its second axis. It only affects games bound to that pose.\n\nHand anchor rotation about Y (mirrored for the right hand)."
              }));
              parts.push(fieldRow(t('Hand Anchor Roll (deg)'), html`
      <app-number .value=${galaxyXr.handAnchorRollDeg} step="1" min="-90" max="90" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { galaxyXr.handAnchorRollDeg = e.detail; } save(); }}></app-number>
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
      <app-number .value=${settings.kalmanDirLeadBaseMs} step="1" min="0" max="30" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanDirLeadBaseMs = e.detail; } save(); }}></app-number>
      <span>Slope</span>
      <app-number .value=${settings.kalmanDirLeadWMs} step="0.05" min="0" max="1" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanDirLeadWMs = e.detail; } save(); }}></app-number>
            `, {
  tip: "Try an experimental correction that anticipates changes in motion direction. Leave it off unless you are measuring the result.\n\nThe fixed Direction Lead above is tuned for the average throw, but the hardest wrist whips (25+ rad/s) lag the filter more, so a single value under-corrects exactly your most violent throws - the last remaining direction tail. When enabled, the lead grows smoothly with your wrist speed: base + slope x rotation speed, OVERRIDING the manual Td while on. Defaults (5 + 0.3/rads): an ordinary throw gets ~8ms, a hard whip ~14ms. No thresholds, nothing switches - gentle throws are essentially unchanged. Success looks like the rare 12-24 degree hard-whip releases dropping to the ~5 degree baseline with everything else identical.",
  reset: { can: settings.kalmanDirLeadAdaptive != defaults.kalmanDirLeadAdaptive || settings.kalmanDirLeadBaseMs != defaults.kalmanDirLeadBaseMs || settings.kalmanDirLeadWMs != defaults.kalmanDirLeadWMs, on: () => { galaxy.reset('kalmanDirLeadAdaptive'); galaxy.reset('kalmanDirLeadBaseMs'); galaxy.reset('kalmanDirLeadWMs'); } }
            }));
            parts.push(settingFieldRow('streamFrame.kalmanAdaptiveR', html`
      <app-switch .checked=${!!settings.kalmanAdaptiveR} @change=${(e: CustomEvent) => { settings.kalmanAdaptiveR = e.detail; save(); }}></app-switch>
      <span>Max</span>
      <app-number .value=${settings.kalmanAdaptiveRMaxDiv} step="2" min="1" max="100" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanAdaptiveRMaxDiv = e.detail; } save(); }}></app-number>
            `, {
  tip: "Try an experimental correction for smoothing delay. Too much correction can create overshoot or unstable motion.\n\nAttacks the hard-whip lag itself instead of compensating its direction error - so unlike Experiment A this also reaches games that compute throws from hand position history. The filter continuously measures how far the incoming tracking is outrunning its own smooth model and, exactly in proportion, trusts the raw measurements more (bounded by Max). During calm and ordinary motion it is mathematically identical to off; during violent whips it lets the filter keep up, at the honest cost of passing some tracking noise through while your hand is moving fast (where it is hard to perceive). Purely opt-in - this deliberately bends the smoothness tuning the whole campaign ratified, so judge it on its own session. Watch rDiv/rADiv in KALDIAG: 1.0 all session = it never engaged; peaks of 5-16 during whips only = working as designed.",
  reset: { can: settings.kalmanAdaptiveR != defaults.kalmanAdaptiveR || settings.kalmanAdaptiveRMaxDiv != defaults.kalmanAdaptiveRMaxDiv, on: () => { galaxy.reset('kalmanAdaptiveR'); galaxy.reset('kalmanAdaptiveRMaxDiv'); } }
            }));
            parts.push(settingFieldRow('streamFrame.kalmanGripEnable', html`
      <app-switch .checked=${!!settings.kalmanGripEnable} @change=${(e: CustomEvent) => { settings.kalmanGripEnable = e.detail; save(); }}></app-switch>
      <span>Blend</span>
      <app-number .value=${settings.kalmanGripBlend} step="0.1" min="0" max="2" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanGripBlend = e.detail; } save(); }}></app-number>
            `, {
  tip: "Account for rotation around a wrist or grip point when estimating controller motion. This is an advanced alignment-dependent adjustment.\n\nThe estimator honestly reports the tracked origin's velocity; during a wrist snap that includes the origin's tangential speed around your hand (w x r) - physics, not filter error, and the measured cause of combined linear+wrist throws bending off while pure linear and pure flick throws feel right. When enabled, reported velocity is transported to the grip point: v + blend x (w x r). Set r via the in-headset Aligner's GRIP capture (hold the palm still, swirl a pure wrist cone with the trigger held) or type it below. With r set but Enable OFF the driver runs shadow-only: PEAKDIAG logs gOut/gDirOff/wr showing what compensation WOULD have reported - verify a session like that first. Leave OFF for games/engines that already transport velocity to their own attach point (they would double-apply). Blend 1 = full physics; below 1 under-corrects deliberately.",
  reset: { can: settings.kalmanGripEnable != defaults.kalmanGripEnable || settings.kalmanGripBlend != defaults.kalmanGripBlend, on: () => { galaxy.reset('kalmanGripEnable'); galaxy.reset('kalmanGripBlend'); } }
            }));
            parts.push(fieldRow(t('Grip Point r - Left / Right (cm, controller local frame)'), html`
      <span>Lx</span>
      <app-number .value=${settings.kalmanGripLeftCm.x} step="0.5" min="-20" max="20" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanGripLeftCm.x = e.detail; } save(); }}></app-number>
      <span>Ly</span>
      <app-number .value=${settings.kalmanGripLeftCm.y} step="0.5" min="-20" max="20" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanGripLeftCm.y = e.detail; } save(); }}></app-number>
      <span>Lz</span>
      <app-number .value=${settings.kalmanGripLeftCm.z} step="0.5" min="-20" max="20" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanGripLeftCm.z = e.detail; } save(); }}></app-number>
      <span>Rx</span>
      <app-number .value=${settings.kalmanGripRightCm.x} step="0.5" min="-20" max="20" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanGripRightCm.x = e.detail; } save(); }}></app-number>
      <span>Ry</span>
      <app-number .value=${settings.kalmanGripRightCm.y} step="0.5" min="-20" max="20" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanGripRightCm.y = e.detail; } save(); }}></app-number>
      <span>Rz</span>
      <app-number .value=${settings.kalmanGripRightCm.z} step="0.5" min="-20" max="20" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanGripRightCm.z = e.detail; } save(); }}></app-number>
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
      <app-number .value=${settings.blackFloor.floorCode} step="0.5" min="0" max="16" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.blackFloor.floorCode = e.detail; } save(); }}></app-number>
      <span>K</span>
      <app-number .value=${settings.blackFloor.kneeCode} step="1" min="2" max="48" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.blackFloor.kneeCode = e.detail; } save(); }}></app-number>
            `, {
  tip: "Brighten the darkest visible shades. Use small values to reveal shadow detail without making black areas look gray.\n\nLifts the deepest shadows before encoding: values below the knee are remapped so black reaches the selected floor, while values above the knee are unchanged. This may make dark detail more visible, but cannot recreate detail already lost elsewhere in the pipeline. Floor 2 / knee 8 is a small starting adjustment. Check near-black test patches; excessive lifting can make blacks look gray."
            }));
            parts.push(fieldRow(t('Throw Strength Trim (scale / spin scale)'), html`
      <span>S</span>
      <app-number .value=${settings.kalmanMagScale} step="0.05" min="0.25" max="4" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanMagScale = e.detail; } save(); }}></app-number>
      <span>Sa</span>
      <app-number .value=${settings.kalmanAngMagScale} step="0.05" min="0.25" max="4" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanAngMagScale = e.detail; } save(); }}></app-number>
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
      <app-number .value=${settings.nvencAqStrength} step="1" min="0" max="15" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.nvencAqStrength = e.detail; } this.noteNumberError('streamFrame.nvencAqStrength', e.detail); save(); }}></app-number>
            `, {
  tip: "Do not use spatial adaptive quantization for normal play in this build. It has caused encoder stalls in testing, and the driver's safety checks may reset it.\n\nDO NOT USE. Any spatial AQ, at any strength, makes nvEncEncodePicture block 4-6 ms per frame on these tall frames and trips the streamer's 10 ms watchdog (encoder resets, soft key frames, storms). No longer forced to 0; leave at 0 unless measuring.",
  reset: { can: settings.nvencAqStrength != defaults.nvencAqStrength, on: () => { galaxy.reset('nvencAqStrength'); } }
            }));
            parts.push(this.numberErrorRow('streamFrame.nvencAqStrength'));
            parts.push(fieldRow(t('NVENC (retired): Max QP'), html`
      <app-number .value=${settings.nvencMaxQp} step="1" min="0" max="51" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.nvencMaxQp = e.detail; } this.noteNumberError('streamFrame.nvencMaxQp', e.detail); save(); }}></app-number>
            `, {
  tip: t("Set the encoder's quantization constraint. This is an advanced quality/bandwidth constraint, not a simple quality slider.\n\nA quality floor can fight CBR and increase encoded frame sizes in complex scenes. VBV and keyframe ratios do not guarantee a hard encoded frame size limit."),
  reset: { can: settings.nvencMaxQp != defaults.nvencMaxQp, on: () => { galaxy.reset('nvencMaxQp'); } }
            }));
            parts.push(this.numberErrorRow('streamFrame.nvencMaxQp'));
            parts.push(fieldRow(t('NVENC (retired): Min QP / Min QP intra'), html`
      <app-number .value=${settings.nvencMinQp} step="1" min="0" max="51" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.nvencMinQp = e.detail; } this.noteNumberError('streamFrame.nvencMinQp', e.detail); save(); }}></app-number>
      <app-number .value=${settings.nvencMinQpIntra} step="1" min="0" max="51" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.nvencMinQpIntra = e.detail; } this.noteNumberError('streamFrame.nvencMinQpIntra', e.detail); save(); }}></app-number>
            `, {
  tip: t("Request a lower quantizer bound for P/B pictures and, separately, intra pictures. A higher bound can reduce quality and encoded size where supported by the selected codec and rate-control mode.\n\nThis request is not a hard encoded-output size limit. Validate its actual effect on the running encoder.")
            }));
            parts.push(this.numberErrorRow('streamFrame.nvencMinQp'));
            parts.push(this.numberErrorRow('streamFrame.nvencMinQpIntra'));
            parts.push(settingFieldRow('streamFrame.nvencPresetMerge', html`
      <app-switch .checked=${!!settings.nvencPresetMerge} @change=${(e: CustomEvent) => { settings.nvencPresetMerge = e.detail; save(); }}></app-switch>
            `, {
  tip: t("Preset merge adopts canonical preset settings. Explicit multipass and H.264 controls below remain authoritative. Automatic multipass uses the tested H.264 single-pass default or the HEVC/AV1 preset recommendation.\n\nValue: streamFrame.nvencPresetMerge (settings.json). Encoder side — preset merge adoption on encoder session setup; the H.264 multipass adoption stays 0."),
  reset: { can: settings.nvencPresetMerge != defaults.nvencPresetMerge, on: () => { galaxy.reset('nvencPresetMerge'); } }
            }));
            parts.push(fieldRow(t('NVENC (retired): VUI Full Range / Matrix / Primaries / Transfer'), html`
      <app-number .value=${settings.nvencVuiFullRange} step="1" min="-1" max="1" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.nvencVuiFullRange = e.detail; } this.noteNumberError('streamFrame.nvencVuiFullRange', e.detail); save(); }}></app-number>
      <app-number .value=${settings.nvencVuiMatrix} step="1" min="-1" max="14" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.nvencVuiMatrix = e.detail; } this.noteNumberError('streamFrame.nvencVuiMatrix', e.detail); save(); }}></app-number>
      <app-number .value=${settings.nvencVuiPrimaries} step="1" min="-1" max="22" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.nvencVuiPrimaries = e.detail; } this.noteNumberError('streamFrame.nvencVuiPrimaries', e.detail); save(); }}></app-number>
      <app-number .value=${settings.nvencVuiTransfer} step="1" min="-1" max="18" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.nvencVuiTransfer = e.detail; } this.noteNumberError('streamFrame.nvencVuiTransfer', e.detail); save(); }}></app-number>
            `, {
  tip: "Override video color-range metadata. Leave automatic unless diagnosing a known mismatch; incompatible client handling can darken the image.\n\n-1 leaves the streamer's tags. The correct BT.709 tags (1/1/1) make the client render dim and saturated - the client mishandles explicit tags, so these stay inert until the APK changes. Manual VUI values are applied as entered: a full-range value conflicting with active post-pack limited-range output is refused visibly in the driver log and the Stream Frame evidence row, and an active SDR 10-bit baseline leaves the pair at -1."
            }));
            parts.push(this.numberErrorRow('streamFrame.nvencVuiFullRange'));
            parts.push(this.numberErrorRow('streamFrame.nvencVuiMatrix'));
            parts.push(this.numberErrorRow('streamFrame.nvencVuiPrimaries'));
            parts.push(this.numberErrorRow('streamFrame.nvencVuiTransfer'));
            parts.push(fieldRow(t('vrlink (retired): Encode Width'), html`
      <app-number .value=${galaxyXr.customEncodeWidth} step="256" min="512" max="8192" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { galaxyXr.customEncodeWidth = e.detail; } save(); }}></app-number>
            `, {
  tip: "Compatibility value for encoder width. It does not control the actual tile width in the current foveated streaming path.\n\nNo observable effect in foveated mode (the streamer's sampling shader never reads it); written as 3072 for compatibility.",
  reset: { can: galaxyXr.customEncodeWidth != 3072, on: () => { galaxyXr.customEncodeWidth = 3072; save(); } }
            }));
            parts.push(fieldRow(t('vrlink (retired): Max Video Queue Latency (us) / Backoff Recovery Coefficient'), html`
      <app-number .value=${galaxyXr.vrlinkMaxVideoQueueLatencyUs} step="1000" min="0" max="200000" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { galaxyXr.vrlinkMaxVideoQueueLatencyUs = e.detail; } save(); }}></app-number>
      <app-number .value=${galaxyXr.vrlinkBackoffRecoveryCoefficient} step="0.1" min="0" max="100" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { galaxyXr.vrlinkBackoffRecoveryCoefficient = e.detail; } save(); }}></app-number>
            `, {
  tip: "Test undocumented Steam Link settings. 0 or the default value leaves the override unused; there is no guarantee that a particular client reads these keys.\n\nUndocumented streamer keys found in driver_vrlink.dll. No measurable effect in A/B (V1/V2). 0 leaves the streamer's defaults."
            }));
            parts.push(fieldRow(t('Gaze FOV Tangents'), html`
      <span>X</span>
      <app-number .value=${settings.eyeGaze.tanHalfFovX} step="0.02" min="0.3" max="3" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.eyeGaze.tanHalfFovX = e.detail; } save(); }}></app-number>
      <span>Y</span>
      <app-number .value=${settings.eyeGaze.tanHalfFovY} step="0.02" min="0.3" max="3" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.eyeGaze.tanHalfFovY = e.detail; } save(); }}></app-number>
            `, {
  tip: "Set the field-of-view values used to map eye gaze into the image. Incorrect values can misplace gaze-based correction.\n\nHalf-FOV tangents used to map gaze direction to screen position. 1.19 corresponds to ~100 degrees. If the ring moves too far for your gaze, increase; too little, decrease. Tune X with horizontal gaze, Y with vertical."
            }));
            parts.push(fieldRow(t('Kalman Smoothed Reporting Lag (ms)'), html`
      <app-number .value=${settings.kalmanSmoothLagMs} step="5" min="0" max="100" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanSmoothLagMs = e.detail; } save(); }}></app-number>
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
      <app-number .value=${settings.kalmanGazeAssist} step="0.1" min="0" max="20" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanGazeAssist = e.detail; } save(); }}></app-number>
      <span>°</span>
      <app-number .value=${settings.kalmanGazeMaxDeg} step="5" min="5" max="180" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanGazeMaxDeg = e.detail; } save(); }}></app-number>
      <span>S</span>
      <app-number .value=${settings.kalmanGazeMinSpeed} step="0.1" min="0.3" max="4" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanGazeMinSpeed = e.detail; } save(); }}></app-number>
            `, {
  tip: "Try using gaze information to help estimate throwing direction. This is experimental, needs reliable eye tracking, and can change normal throws.\n\nUses your eye tracking to fix the last class of bad throws: you look at the target before your hand lets go, so your gaze knows the intended direction even when the release samples the hand's snap-back. Above the minimum speed, the reported throw direction is bent toward where you're looking - by strength fraction of the angle, never more than the max bend cap. Direction only: throw power and spin are untouched, the rendered hand is untouched, and if eye data is missing or stale for even 100ms it silently does nothing. Start at 0.4-0.6; the 'gaze aim assist ENGAGED' log line confirms it's live. 0 = off. TEST MODE: values above 1 shrink the disagreement needed for full gaze takeover - G=10 with max bend 180 locks every throw straight onto your gaze, for verifying the whole pipeline.",
  reset: { can: settings.kalmanGazeAssist != defaults.kalmanGazeAssist || settings.kalmanGazeMaxDeg != defaults.kalmanGazeMaxDeg || settings.kalmanGazeMinSpeed != defaults.kalmanGazeMinSpeed, on: () => { galaxy.reset('kalmanGazeAssist'); galaxy.reset('kalmanGazeMaxDeg'); galaxy.reset('kalmanGazeMinSpeed'); } }
            }));
            parts.push(fieldRow(t('Kalman Duplicate-Coast Cap (ms)'), html`
      <app-number .value=${settings.kalmanDupCoastMaxMs} step="10" min="10" max="500" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanDupCoastMaxMs = e.detail; } save(); }}></app-number>
            `, {
  tip: "Limit how long repeated samples are treated as duplicates while the controller is still. This balances freeze detection against genuine stillness.\n\nActive even while archived. Repeats sustained past this cap are accepted as genuine stillness at full weight - no human hand holds a position bit-identically for tens of ms, so a long repeat means the tracker stopped producing, and believing it beats extrapolating or distrusting blind. Also closes a coast runaway. Default 90, range 10-500. Applies to Coast, Drop, and Soft.",
  reset: { can: settings.kalmanDupCoastMaxMs != defaults.kalmanDupCoastMaxMs, on: () => { galaxy.reset('kalmanDupCoastMaxMs'); } }
            }));
            parts.push(fieldRow(t('Kalman Direction Smoothing (linear ms / angular ms)'), html`
      <span>Dir</span>
      <app-number .value=${settings.kalmanDirSmoothMs} step="10" min="0" max="300" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanDirSmoothMs = e.detail; } save(); }}></app-number>
      <span>DirA</span>
      <app-number .value=${settings.kalmanAngDirSmoothMs} step="10" min="0" max="300" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanAngDirSmoothMs = e.detail; } save(); }}></app-number>
            `, {
  tip: "Smooth motion speed and motion direction separately in the legacy filter. This only affects the supported legacy branch.\n\nWhat your A=1 tuning discovered, made into its own knob: throw DIRECTION gets heavy smoothing (the calm you liked) while throw STRENGTH stays live (no weak throws, nothing slipping out of your hand). Set Accel back to 40-60 and put 60-90 here; direction takes on the A=1 steadiness while magnitude keeps full snap. Angular ditto for spin. 0 = off. Only the reported velocity is shaped; the rendered hand is untouched.",
  reset: { can: settings.kalmanDirSmoothMs != defaults.kalmanDirSmoothMs || settings.kalmanAngDirSmoothMs != defaults.kalmanAngDirSmoothMs, on: () => { galaxy.reset('kalmanDirSmoothMs'); galaxy.reset('kalmanAngDirSmoothMs'); } }
            }));
            parts.push(fieldRow(t('Kalman Release Rewind (ms) / Hold (ms) - EXPERIMENT'), html`
      <span>R</span>
      <app-number .value=${settings.kalmanReleaseRewindMs} step="5" min="0" max="150" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanReleaseRewindMs = e.detail; } save(); }}></app-number>
      <span>H</span>
      <app-number .value=${settings.kalmanRewindHoldMs} step="10" min="20" max="300" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.kalmanRewindHoldMs = e.detail; } save(); }}></app-number>
            `, {
  tip: "Try an experimental release-time correction for throwing. 0 disables it; the approach is a hypothesis to test, not a guaranteed fix.\n\nSingle-session experiment, off at 0. Hypothesis: your trigger release reaches the PC 40-60ms later than your hand motion does, so games read the hand AFTER it already snapped back - that is where reverse throws come from. When set, the moment your release arrives, the reported velocity is taken from Rewind ms earlier in the motion history (then blends back to live over Hold ms). This is pure time re-alignment by one constant - if a value around 45 makes reverse throws vanish, the hypothesis is proven and the value IS your network's input lag; if no value in 30-60 helps, the hypothesis is dead and this stays off forever. The rendered hand is never touched.",
  reset: { can: settings.kalmanReleaseRewindMs != defaults.kalmanReleaseRewindMs || settings.kalmanRewindHoldMs != defaults.kalmanRewindHoldMs, on: () => { galaxy.reset('kalmanReleaseRewindMs'); galaxy.reset('kalmanRewindHoldMs'); } }
            }));
            parts.push(fieldRow(t('Derive Smoothing (tau slow/fast ms, speed low/high)'), html`
      <span>τS</span>
      <app-number .value=${settings.deriveSmoothTauSlowMs} step="5" min="1" max="300" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.deriveSmoothTauSlowMs = e.detail; } save(); }}></app-number>
      <span>τF</span>
      <app-number .value=${settings.deriveSmoothTauFastMs} step="1" min="1" max="60" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.deriveSmoothTauFastMs = e.detail; } save(); }}></app-number>
      <span>sL</span>
      <app-number .value=${settings.deriveSmoothSpeedLow} step="0.05" min="0" max="3" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.deriveSmoothSpeedLow = e.detail; } save(); }}></app-number>
      <span>sH</span>
      <app-number .value=${settings.deriveSmoothSpeedHigh} step="0.05" min="0.1" max="5" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.deriveSmoothSpeedHigh = e.detail; } save(); }}></app-number>
            `, {
  tip: "Adjust the motion filter's smoothing automatically with speed. This changes the trade-off between steady slow motion and responsive fast motion.\n\nSpeed-adaptive smoothing for the Derive velocity mode, live reloaded. The filter time constant slides from tau slow (held still: kills trembling) to tau fast (throw speeds: near raw so the peak survives) as effective speed crosses low..high. Lower tau fast raises the reported peak but passes more raw noise at release; if throw directions misbehave, prefer the Split Direction toggles below over pushing tau fast toward zero.",
  reset: { can: settings.deriveSmoothTauSlowMs != defaults.deriveSmoothTauSlowMs || settings.deriveSmoothTauFastMs != defaults.deriveSmoothTauFastMs || settings.deriveSmoothSpeedLow != defaults.deriveSmoothSpeedLow || settings.deriveSmoothSpeedHigh != defaults.deriveSmoothSpeedHigh, on: () => { galaxy.reset('deriveSmoothTauSlowMs'); galaxy.reset('deriveSmoothTauFastMs'); galaxy.reset('deriveSmoothSpeedLow'); galaxy.reset('deriveSmoothSpeedHigh'); } }
            }));
            parts.push(settingFieldRow('streamFrame.deriveSmoothAngSeparate', html`
      <app-switch .checked=${!!settings.deriveSmoothAngSeparate} @change=${(e: CustomEvent) => { settings.deriveSmoothAngSeparate = e.detail; save(); }}></app-switch>
      <span>τS</span>
      <app-number .value=${settings.deriveSmoothAngTauSlowMs} step="5" min="1" max="300" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.deriveSmoothAngTauSlowMs = e.detail; } save(); }}></app-number>
      <span>τF</span>
      <app-number .value=${settings.deriveSmoothAngTauFastMs} step="1" min="1" max="60" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.deriveSmoothAngTauFastMs = e.detail; } save(); }}></app-number>
      <span>sL</span>
      <app-number .value=${settings.deriveSmoothAngSpeedLow} step="0.1" min="0" max="30" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.deriveSmoothAngSpeedLow = e.detail; } save(); }}></app-number>
      <span>sH</span>
      <app-number .value=${settings.deriveSmoothAngSpeedHigh} step="0.5" min="0.5" max="60" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.deriveSmoothAngSpeedHigh = e.detail; } save(); }}></app-number>
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
      <app-number .value=${settings.deriveLatchAngMinSpeed} step="0.5" min="0" max="30" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.deriveLatchAngMinSpeed = e.detail; } save(); }}></app-number>
      <app-select .value=${settings.derivePreFilter} .options=${[{ value: 'off', label: 'Off (raw input)' }, { value: 'median3', label: 'Median of 3 (recommended)' }]} @change=${(e: CustomEvent) => { settings.derivePreFilter = e.detail; save(); }}></app-select>
            `, {
  tip: "Choose the minimum spin speed needed before the experimental spin latch takes effect. Keep the default unless testing that mode.\n\nAngular min speed: the spin channel's own latch gate - wrist snaps above this replay their peak spin at release, gentler rotation stays live (6 is a deliberate flick; casual regrabs sit far below). Input prefilter median3: cleans single-frame network position spikes BEFORE velocity is derived, at one sample of lag - the recommended fix for jitter tails and twitchy held objects. Off restores raw input for A/B.",
  reset: { can: settings.deriveLatchAngMinSpeed != defaults.deriveLatchAngMinSpeed || settings.derivePreFilter != defaults.derivePreFilter, on: () => { galaxy.reset('deriveLatchAngMinSpeed'); galaxy.reset('derivePreFilter'); } }
            }));
            parts.push(fieldRow(t('Input Pre-Smoothing (ms) / Scope'), html`
      <app-number .value=${settings.derivePreSmoothMs} step="5" min="0" max="100" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.derivePreSmoothMs = e.detail; } save(); }}></app-number>
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
      <app-number .value=${settings.deriveLatchWindowMs} step="10" min="40" max="400" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.deriveLatchWindowMs = e.detail; } save(); }}></app-number>
      <span>H</span>
      <app-number .value=${settings.deriveLatchHoldMs} step="10" min="40" max="400" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.deriveLatchHoldMs = e.detail; } save(); }}></app-number>
      <span>S</span>
      <app-number .value=${settings.deriveLatchMinSpeed} step="0.1" min="0" max="3" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.deriveLatchMinSpeed = e.detail; } save(); }}></app-number>
            `, {
  tip: "Retain a recent speed peak briefly around release in the legacy filter. This can change throw strength and may exaggerate a noisy peak.\n\nFixes throws that come out weak or die mid-air: field data shows the input release event often trails the hand motion, so about a quarter of throws sample the velocity AFTER the hand already slowed. When on, the moment your trigger/grip release arrives, the output replays the strongest recent motion (window below) for the hold duration - full strength for the first half, fading after. Normal throws that release at the peak are unaffected. The three numbers: peak window ms / hold ms / minimum speed to engage (m/s).",
  reset: { can: settings.deriveReleaseLatch != defaults.deriveReleaseLatch, on: () => { galaxy.reset('deriveReleaseLatch'); } }
            }));
            parts.push(fieldRow(t('Split Direction Window (ms) / Weight Power'), html`
      <span>W</span>
      <app-number .value=${settings.deriveDirWindowMs} step="5" min="5" max="200" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.deriveDirWindowMs = e.detail; } save(); }}></app-number>
      <span>P</span>
      <app-number .value=${settings.deriveDirWeightPow} step="0.5" min="0" max="6" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.deriveDirWeightPow = e.detail; } save(); }}></app-number>
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
