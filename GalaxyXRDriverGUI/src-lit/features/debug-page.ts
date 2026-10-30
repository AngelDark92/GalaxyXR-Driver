// Debug controls use the saved driver settings and remain independent of
// Advanced Mode. Debug Mode gates diagnostics at the driver boundary (2026-10-01).
import { html, css, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';
import { BasePage, settingFieldRow, fieldRow, noteRow, sectionRow, sectionGroup, fieldStyles, numberControl } from './page-base';
import { t } from '../locale/i18n';
import { pageIntro } from '../ui/presentation';
import { open_bitrate_monitor } from '../platform/tauri';
import '../ui/controls';
import './system-ready';

@customElement('app-debug-page')
export class DebugPage extends BasePage {
  static styles = [fieldStyles, css`
    :host { display: block; padding: 0 1rem 2rem 1rem; }
    .window-error { color: var(--colorPaletteRedForeground1, #a4262c); }
  `];

  private bitrateWindowError?: string;

  private async openBitrateWindow(): Promise<void> {
    const locale = window.location.pathname.split('/').filter(Boolean)[0] ?? 'en-US';
    const colorScheme = this.ctx.appSetting.values().colorScheme ?? 'system';
    try {
      await open_bitrate_monitor(locale, t('Bitrate Monitor'), colorScheme, this.ctx.galaxy.debugMode, this.ctx.paths.infoPath);
      this.bitrateWindowError = undefined;
    } catch (error) {
      this.bitrateWindowError = String(error);
      console.error('Bitrate monitor window failed to open', error);
    }
    this.requestUpdate();
  }

  render() {
    const galaxy = this.ctx.galaxy;
    if (!this.ctx.dss.values()?.debugMode || !galaxy.settings) return html``;
    const settings = galaxy.settings;
    const defaults = galaxy.defaults;
    const galaxyXr = galaxy.galaxyXr;
    const sections = galaxy.sections();
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
    const parts: TemplateResult[] = [pageIntro(t('Debug'), t('Diagnostic overlays, logging, and encoder tuning.'))];
    parts.push(sectionGroup(t('Monitoring'), 0, 'source', 'debug-monitoring'));
    parts.push(sectionGroup(t('Bitrate monitor'), 1, 'source', 'debug-bitrate'));

      parts.push(fieldRow(t('Window'), html`
        <fluent-button id="open-bitrate-monitor" appearance="outline" @click=${() => { void this.openBitrateWindow(); }}>${t('Open monitor window')}</fluent-button>
      `, {
        tip: t("Read exact NVENC output and USB headset counters in a separate window. Nothing is sampled before the window opens, sampling stops when it closes or hides, and no stream setting is changed.\n\nNVENC bytes come from the installed driver's read-only telemetry; the headset uses USB ADB and labels WLAN RX as all-traffic when decoder telemetry is unavailable. The window keeps its own pause, reset and CSV export state.\n\nValue: none (diagnostic only). Native side — read-only process telemetry and ADB."),
      }));
      parts.push(noteRow(t('The monitor samples only while its window is open. Closing or hiding the window stops every sampler.')));
      if (this.bitrateWindowError) parts.push(noteRow(html`<span class="window-error">${this.bitrateWindowError}</span>`));

    parts.push(sectionGroup(t('Image Processing'), 0, 'source', 'debug-image'));
    parts.push(sectionGroup(t('Diagnostics'), 1, 'source', 'debug-image-diagnostics'));

      parts.push(settingFieldRow('streamFrame.blackFloor.rampBar', html`
        <app-switch .checked=${!!settings.blackFloor.rampBar} @change=${(e: CustomEvent) => { settings.blackFloor.rampBar = e.detail; save(); }}></app-switch>
      `, {
        tip: t("Show grayscale ramps and near-black patches to help judge shadow detail and video levels. Turn the test pattern off for normal play.\n\nDraws two near-black test strips per eye (17 patches, sRGB codes 0 to 32 in steps of 2, white ticks over codes 0/8/16/24/32): one across screen center and one near the bottom.\n\nValue: streamFrame.blackFloor.rampBar (settings.json). Driver side — near-black test-strip overlay draw.")
      }));
      parts.push(fieldRow(t('Black Point (sRGB code)'), html`
        ${numberControl('streamFrame.blackFloor.blackPointCode', {
          value: settings.blackFloor.blackPointCode,
          ctx: controlContext,
          onCommit: value => { settings.blackFloor.blackPointCode = value; save(); },
        })}
      `, {
        tip: t("Remap the darkest part of the picture. Too much correction can erase shadow detail; compare against the near-black test patches.\n\nAdjustable black level: remaps [BP, 255] onto [0, 255], darkening blacks. Calibration recipe: turn the Ramp Bar on, raise BP until the two darkest patches just merge into one black, then back off one notch, that is maximum contrast with zero crushed detail.\n\nValue: streamFrame.blackFloor.blackPointCode (settings.json). Driver side — near-black remap in sRGB code units.")
      }));
      parts.push(settingFieldRow('streamFrame.hitchDiag', html`
        <app-switch .checked=${!!settings.hitchDiag} @change=${(e: CustomEvent) => { settings.hitchDiag = e.detail; save(); }}></app-switch>
      `, {
        tip: t("Record information about frame-time spikes. Enable it while reproducing stutters, then turn it off to limit log size and overhead.\n\nRender-side cadence instrumentation, the frame-path analog of KALDIAG. Every 2 seconds a HITCHDIAG log line summarizes the frame callback rhythm: mean/max gap between frames, counts over 16.7ms and 33ms, sync-mutex wait, this driver's own work time, and skip/scratch-create/evict counters. Any single gap over 25ms also logs a one-shot HITCH line tagged with what the previous frame did (scratch creation, distortion LUT bake, shader compile, sync skip) so stutters name their own cause.\n\nValue: streamFrame.hitchDiag (settings.json). Driver side — HITCHDIAG frame-cadence logging."),
        reset: { can: settings.hitchDiag != defaults.hitchDiag, on: () => { galaxy.reset('hitchDiag'); } }
      }));
      parts.push(settingFieldRow('streamFrame.eyeGaze.debugRing', html`
        <app-switch .checked=${!!settings.eyeGaze.debugRing} @change=${(e: CustomEvent) => { settings.eyeGaze.debugRing = e.detail; save(); }}></app-switch>
      `, {
        tip: t("Show where eye tracking reports you are looking. Eye tracking and the appropriate Steam Link sharing setting must be available.\n\nDraws a small red ring where the eye tracker says you are looking (requires SteamVR's Steam Link tab's 'Share ET data with other apps' to be on).\n\nValue: streamFrame.eyeGaze.debugRing (settings.json). Driver side — gaze ring overlay."),
        reset: { can: settings.eyeGaze.debugRing != defaults.eyeGaze.debugRing, on: () => { galaxy.reset('eyeGaze'); } }
      }));

    parts.push(sectionGroup(t('Controllers'), 0, 'source', 'debug-controllers'));
    parts.push(sectionGroup(t('Diagnostics'), 1, 'source', 'debug-controller-diagnostics'));

      parts.push(settingFieldRow('streamFrame.poseLogging', html`
        <app-switch .checked=${!!settings.poseLogging} @change=${(e: CustomEvent) => { settings.poseLogging = e.detail; save(); }}></app-switch>
      `, {
        tip: t("Record tracking samples for troubleshooting or calibration. Logs can contain movement data and may become large.\n\nWrites throttled controller pose lines to vrserver.txt (positions, reported vs position-derived velocity, tracking state), with burst capture during fast motion. Only needed when collecting data for a report; leave off otherwise.\n\nValue: streamFrame.poseLogging (settings.json). Driver side — throttled pose lines in vrserver.txt."),
        reset: { can: settings.poseLogging != defaults.poseLogging, on: () => { galaxy.reset('poseLogging'); } }
      }));
      parts.push(settingFieldRow('streamFrame.poseLogBurst', html`
        <app-switch .checked=${!!settings.poseLogBurst} @change=${(e: CustomEvent) => { settings.poseLogBurst = e.detail; save(); }}></app-switch>
      `, {
        tip: t("Record a short, high-detail burst of tracking samples. The extra work can itself cause stutters, so use it only for a focused test.\n\nHigh-rate diagnostic lines (up to 100/s per device) during fast motion, on top of Pose Logging. Log storms during hard throws can hitch the game/stream, so leave this off unless a session is specifically collecting throw diagnostics.\n\nValue: streamFrame.poseLogBurst (settings.json). Driver side — high-rate burst lines during fast motion."),
        reset: { can: settings.poseLogBurst != defaults.poseLogBurst, on: () => { galaxy.reset('poseLogBurst'); } }
      }));

    if (galaxy.vendor && settings.nvencTap) {
      parts.push(sectionGroup(t('Encoder'), 0, 'source', 'debug-encoder'));
      parts.push(sectionGroup(t('Diagnostics'), 1, 'source', 'debug-encoder-diagnostics'));

        parts.push(settingFieldRow('galaxyXr.vrlinkDebugOverlay', html`
          <app-switch .checked=${!!galaxyXr.vrlinkDebugOverlay} @change=${(e: CustomEvent) => { galaxyXr.vrlinkDebugOverlay = e.detail; save(); }}></app-switch>
        `, {
          tip: t("Show the encoder's diagnostic overlay. Turn it off for normal play after collecting the information you need.\n\nDisplays a coloured overlay on the foveated area and the streamer's advanced graphs (encode time, RFOV %). Diagnostic only; takes effect at the next connect.\n\nValue: galaxyXr.vrlinkDebugOverlay (settings.json). SteamVR side — writes the vrlink debug overlay keys; needs the NVENC Tap and a reconnect.")
        }));
        parts.push(settingFieldRow('streamFrame.nvencFixLevel', html`
          <app-switch .checked=${!!settings.nvencFixLevel} @change=${(e: CustomEvent) => { settings.nvencFixLevel = e.detail; save(); }}></app-switch>
        `, {
          tip: t("Let the encoder choose an HEVC level and tier suitable for the stream. Incorrect manual choices can prevent a stream from starting.\n\nSets HEVC level to auto-select and tier to High on every encoder init and reconfigure. The streamer hardcodes level 6.1, which the 8192-row canvas exceeds at 90 Hz, so its reconfigures were being rejected. Keep on. Inert for H.264/AV1: those codec paths set level auto-select internally.\n\nValue: streamFrame.nvencFixLevel (settings.json). Encoder side — HEVC level/tier auto-selection at encoder init and reconfigure."),
          reset: { can: settings.nvencFixLevel != defaults.nvencFixLevel, on: () => { galaxy.reset('nvencFixLevel'); } }
        }));
        parts.push(fieldRow(t('Bitrate Headroom (%)'), html`
          ${numberControl('streamFrame.nvencMaxBitrateHeadroomPct', {
            value: settings.nvencMaxBitrateHeadroomPct,
            ctx: controlContext,
            onCommit: value => { settings.nvencMaxBitrateHeadroomPct = value; save(); },
          })}
        `, {
          tip: t("Reserve part of the Max Bitrate budget as VBR peak headroom. The requested average is capped at Max Bitrate / (1 + this percentage); the encoder maximum remains Max Bitrate.\n\nInert under Force CBR, where the budget is both the constant average and the maximum. 0 lets the average use the whole budget. This is a rate-control reservation, not a hard encoded-output cap; oversized frames remain a measured-transport risk.\n\nValue: streamFrame.nvencMaxBitrateHeadroomPct (settings.json). Encoder side — VBR average cap reserved below the Max Bitrate peak."),
          reset: { can: settings.nvencMaxBitrateHeadroomPct != defaults.nvencMaxBitrateHeadroomPct, on: () => { galaxy.reset('nvencMaxBitrateHeadroomPct'); } }
        }));
        parts.push(fieldRow(t('Force FPS'), html`
          ${numberControl('streamFrame.nvencForceFps', {
            value: settings.nvencForceFps,
            ctx: controlContext,
            onCommit: value => { settings.nvencForceFps = value; save(); },
          })}
        `, {
          tip: t("Set the frame-rate value used for encoder budgeting. Match the intended stream rate; changing this alone does not change the headset refresh rate.\n\nPins the encoder's frame rate so the per-frame budget is constant. Without it the streamer passes its momentary estimate (down to 12 fps while hitching) and under CBR the next key frame balloons. Recommended 90. 0 leaves the streamer's value.\n\nValue: streamFrame.nvencForceFps (settings.json). Encoder side — pinned encoder frame rate for the per-frame budget."),
          reset: { can: settings.nvencForceFps != defaults.nvencForceFps, on: () => { galaxy.reset('nvencForceFps'); } }
        }));
        parts.push(fieldRow(t('Encoder Bitrate Override (Mbit/s)'), html`
          ${numberControl('streamFrame.nvencBitrateMbit', {
            value: settings.nvencBitrateMbit,
            ctx: controlContext,
            onCommit: value => { settings.nvencBitrateMbit = value; save(); },
          })}
        `, {
          tip: t("Override only the encoder's bitrate budget. This does not automatically change network pacing, so mismatched values can cause problems.\n\n0 = the encoder bitrate equals the pacer bandwidth (normal). Nonzero sets only the encoder, for experiments where the pacer and the encoder should differ.\n\nValue: streamFrame.nvencBitrateMbit (settings.json). Encoder side — encoder-only bitrate override."),
          reset: { can: settings.nvencBitrateMbit != defaults.nvencBitrateMbit, on: () => { galaxy.reset('nvencBitrateMbit'); } }
        }));
        parts.push(settingFieldRow('streamFrame.nvencVerbose', html`
          <app-switch .checked=${!!settings.nvencVerbose} @change=${(e: CustomEvent) => { settings.nvencVerbose = e.detail; save(); }}></app-switch>
        `, {
          tip: t("Write detailed NVIDIA encoder diagnostics to the log. Use this for troubleshooting; extra logging can add overhead and large files.\n\nLogs every reconfigure and hex-dumps the encoder structs. For offline decoding of driver_vrlink's encoder setup; leave off. Only published while Debug Mode is on; with it off the value is kept but not applied.\n\nValue: streamFrame.nvencVerbose (settings.json). Encoder side — per-reconfigure encoder struct dumps. Debug Mode gates the application."),
          reset: { can: settings.nvencVerbose != defaults.nvencVerbose, on: () => { galaxy.reset('nvencVerbose'); } }
        }));

    }
    return html`<app-system-ready .ctx=${this.ctx}>${this.sectionCardsFor(parts)}</app-system-ready>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'app-debug-page': DebugPage;
  }
}
