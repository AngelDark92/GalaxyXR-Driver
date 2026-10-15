// Debug controls use the saved driver settings and remain independent of
// Advanced Mode. Debug Mode gates diagnostics at the driver boundary (2026-10-01).
import { html, css, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';
import { BasePage, settingFieldRow, fieldRow, sectionRow, sectionGroup, fieldStyles } from './page-base';
import { t } from '../locale/i18n';
import { pageIntro } from '../ui/presentation';
import '../ui/controls';
import './system-ready';

@customElement('app-debug-page')
export class DebugPage extends BasePage {
  static styles = [fieldStyles, css`
    :host { display: block; padding: 0 1rem 2rem 1rem; }
  `];

  render() {
    const galaxy = this.ctx.galaxy;
    if (!this.ctx.dss.values()?.debugMode || !galaxy.settings) return html``;
    const settings = galaxy.settings;
    const defaults = galaxy.defaults;
    const galaxyXr = galaxy.galaxyXr;
    const sections = galaxy.sections();
    const save = () => { galaxy.save(); this.requestUpdate(); };
    const parts: TemplateResult[] = [pageIntro(t('Debug'), t('Diagnostic overlays, logging, and encoder tuning.'))];
    parts.push(sectionGroup(t('Image Processing'), 0, 'source'));
    parts.push(sectionRow(t('Diagnostics'), sections['debugImage'], 1, () => this.toggleSection('debugImage')));
    if (sections.debugImage) {
      parts.push(settingFieldRow('streamFrame.blackFloor.rampBar', html`
        <app-switch .checked=${!!settings.blackFloor.rampBar} @change=${(e: CustomEvent) => { settings.blackFloor.rampBar = e.detail; save(); }}></app-switch>
      `, {
        tip: "Show grayscale ramps and near-black patches to help judge shadow detail and video levels. Turn the test pattern off for normal play.\n\nDraws two near-black test strips per eye (17 patches, sRGB codes 0 to 32 in steps of 2, white ticks over codes 0/8/16/24/32): one across screen center and one near the bottom."
      }));
      parts.push(fieldRow(t('Black Floor: Black Point (sRGB code)'), html`
        <app-number .value=${settings.blackFloor.blackPointCode} step="0.5" min="0" max="24" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.blackFloor.blackPointCode = e.detail; } save(); }}></app-number>
      `, {
        tip: "Remap the darkest part of the picture. Too much correction can erase shadow detail; compare against the near-black test patches.\n\nAdjustable black level: remaps [BP, 255] onto [0, 255], darkening blacks. Calibration recipe: turn the Ramp Bar on, raise BP until the two darkest patches just merge into one black, then back off one notch, that is maximum contrast with zero crushed detail."
      }));
      parts.push(settingFieldRow('streamFrame.hitchDiag', html`
        <app-switch .checked=${!!settings.hitchDiag} @change=${(e: CustomEvent) => { settings.hitchDiag = e.detail; save(); }}></app-switch>
      `, {
        tip: "Record information about frame-time spikes. Enable it while reproducing stutters, then turn it off to limit log size and overhead.\n\nRender-side cadence instrumentation, the frame-path analog of KALDIAG. Every 2 seconds a HITCHDIAG log line summarizes the frame callback rhythm: mean/max gap between frames, counts over 16.7ms and 33ms, sync-mutex wait, this driver's own work time, and skip/scratch-create/evict counters. Any single gap over 25ms also logs a one-shot HITCH line tagged with what the previous frame did (scratch creation, distortion LUT bake, shader compile, sync skip) so stutters name their own cause.",
        reset: { can: settings.hitchDiag != defaults.hitchDiag, on: () => { galaxy.reset('hitchDiag'); } }
      }));
      parts.push(settingFieldRow('streamFrame.eyeGaze.debugRing', html`
        <app-switch .checked=${!!settings.eyeGaze.debugRing} @change=${(e: CustomEvent) => { settings.eyeGaze.debugRing = e.detail; save(); }}></app-switch>
      `, {
        tip: "Show where eye tracking reports you are looking. Eye tracking and the appropriate Steam Link sharing setting must be available.\n\nDraws a small red ring where the eye tracker says you are looking (requires SteamVR's Steam Link tab's 'Share ET data with other apps' to be on).",
        reset: { can: settings.eyeGaze.debugRing != defaults.eyeGaze.debugRing, on: () => { galaxy.reset('eyeGaze'); } }
      }));
    }
    parts.push(sectionGroup(t('Controllers'), 0, 'source'));
    parts.push(sectionRow(t('Diagnostics'), sections['debugControllers'], 1, () => this.toggleSection('debugControllers')));
    if (sections.debugControllers) {
      parts.push(settingFieldRow('streamFrame.poseLogging', html`
        <app-switch .checked=${!!settings.poseLogging} @change=${(e: CustomEvent) => { settings.poseLogging = e.detail; save(); }}></app-switch>
      `, {
        tip: "Record tracking samples for troubleshooting or calibration. Logs can contain movement data and may become large.\n\nWrites throttled controller pose lines to vrserver.txt (positions, reported vs position-derived velocity, tracking state), with burst capture during fast motion. Only needed when collecting data for a report; leave off otherwise.",
        reset: { can: settings.poseLogging != defaults.poseLogging, on: () => { galaxy.reset('poseLogging'); } }
      }));
      parts.push(settingFieldRow('streamFrame.poseLogBurst', html`
        <app-switch .checked=${!!settings.poseLogBurst} @change=${(e: CustomEvent) => { settings.poseLogBurst = e.detail; save(); }}></app-switch>
      `, {
        tip: "Record a short, high-detail burst of tracking samples. The extra work can itself cause stutters, so use it only for a focused test.\n\nHigh-rate diagnostic lines (up to 100/s per device) during fast motion, on top of Pose Logging. Log storms during hard throws can hitch the game/stream, so leave this off unless a session is specifically collecting throw diagnostics.",
        reset: { can: settings.poseLogBurst != defaults.poseLogBurst, on: () => { galaxy.reset('poseLogBurst'); } }
      }));
    }
    if (galaxy.vendor && settings.nvencTap) {
      parts.push(sectionGroup(t('Encoder'), 0, 'source'));
      parts.push(sectionRow(t('Diagnostics'), sections['debugEncoder'], 1, () => this.toggleSection('debugEncoder')));
      if (sections.debugEncoder) {
        parts.push(settingFieldRow('galaxyXr.vrlinkDebugOverlay', html`
          <app-switch .checked=${!!galaxyXr.vrlinkDebugOverlay} @change=${(e: CustomEvent) => { galaxyXr.vrlinkDebugOverlay = e.detail; save(); }}></app-switch>
        `, {
          tip: "Show the encoder's diagnostic overlay. Turn it off for normal play after collecting the information you need.\n\nDisplays a coloured overlay on the foveated area and the streamer's advanced graphs (encode time, RFOV %). Diagnostic only; takes effect at the next connect."
        }));
        parts.push(settingFieldRow('streamFrame.nvencFixLevel', html`
          <app-switch .checked=${!!settings.nvencFixLevel} @change=${(e: CustomEvent) => { settings.nvencFixLevel = e.detail; save(); }}></app-switch>
        `, {
          tip: "Let the encoder choose an HEVC level and tier suitable for the stream. Incorrect manual choices can prevent a stream from starting.\n\nSets HEVC level to auto-select and tier to High on every encoder init and reconfigure. The streamer hardcodes level 6.1, which the 8192-row canvas exceeds at 90 Hz, so its reconfigures were being rejected. Keep on. Inert for H.264/AV1: those codec paths set level auto-select internally.",
          reset: { can: settings.nvencFixLevel != defaults.nvencFixLevel, on: () => { galaxy.reset('nvencFixLevel'); } }
        }));
        parts.push(fieldRow(t('Peak Headroom (%)'), html`
          <app-number .value=${settings.nvencMaxBitrateHeadroomPct} step="5" min="0" max="100" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.nvencMaxBitrateHeadroomPct = e.detail; } save(); }}></app-number>
        `, {
          tip: "Allow temporary bitrate peaks above the target budget. This mainly affects modes that are not strict constant bitrate.\n\nPeak bitrate over the average, in percent. Only meaningful without Force CBR (under CBR peak = average). 0 measured safe.",
          reset: { can: settings.nvencMaxBitrateHeadroomPct != defaults.nvencMaxBitrateHeadroomPct, on: () => { galaxy.reset('nvencMaxBitrateHeadroomPct'); } }
        }));
        parts.push(fieldRow(t('Force Frame Rate'), html`
          <app-number .value=${settings.nvencForceFps} step="1" min="0" max="120" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.nvencForceFps = e.detail; } save(); }}></app-number>
        `, {
          tip: "Set the frame-rate value used for encoder budgeting. Match the intended stream rate; changing this alone does not change the headset refresh rate.\n\nPins the encoder's frame rate so the per-frame budget is constant. Without it the streamer passes its momentary estimate (down to 12 fps while hitching) and under CBR the next key frame balloons. Recommended 90. 0 leaves the streamer's value.",
          reset: { can: settings.nvencForceFps != defaults.nvencForceFps, on: () => { galaxy.reset('nvencForceFps'); } }
        }));
        parts.push(fieldRow(t('Encoder Bitrate (separate, Mbit/s)'), html`
          <app-number .value=${settings.nvencBitrateMbit} step="25" min="0" max="600" @change=${(e: CustomEvent) => { if (e.detail !== undefined) { settings.nvencBitrateMbit = e.detail; } save(); }}></app-number>
        `, {
          tip: "Override only the encoder's bitrate budget. This does not automatically change network pacing, so mismatched values can cause problems.\n\n0 = the encoder bitrate equals the pacer bandwidth (normal). Nonzero sets only the encoder, for experiments where the pacer and the encoder should differ.",
          reset: { can: settings.nvencBitrateMbit != defaults.nvencBitrateMbit, on: () => { galaxy.reset('nvencBitrateMbit'); } }
        }));
        parts.push(settingFieldRow('streamFrame.nvencVerbose', html`
          <app-switch .checked=${!!settings.nvencVerbose} @change=${(e: CustomEvent) => { settings.nvencVerbose = e.detail; save(); }}></app-switch>
        `, {
          tip: "Write detailed NVIDIA encoder diagnostics to the log. Use this for troubleshooting; extra logging can add overhead and large files.\n\nLogs every reconfigure and hex-dumps the encoder structs. For offline decoding of driver_vrlink's encoder setup; leave off. Only published while Debug Mode is on; with it off the value is kept but not applied.",
          reset: { can: settings.nvencVerbose != defaults.nvencVerbose, on: () => { galaxy.reset('nvencVerbose'); } }
        }));
      }
    }
    return html`<app-system-ready .ctx=${this.ctx}>${this.sectionCardsFor(parts)}</app-system-ready>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'app-debug-page': DebugPage;
  }
}
