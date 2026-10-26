// 2026-10-23 on-demand bitrate monitor window.
//
// Sampling lives entirely in src-tauri/src/bitrate_monitor: this component
// starts it on mount/visible, stops it on hide/unmount, and never polls while
// the window is absent. It keeps only display history, pause/reset state and
// CSV rows.
import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { Button, ButtonDefinition } from '@fluentui/web-components';
import { RateTracker, type Rates, type RateSample } from '../domain/rate-tracker';
import { localIsoTimestamp } from '../domain/local-time';
import { t, subscribeLocale } from '../locale/i18n';
import { applyTheme } from '../ui/theme';
import { interactiveStyles } from '../ui/shared-styles';
import {
  bitrate_monitor_environment, bitrate_monitor_preferences, save_bitrate_monitor_preferences,
  start_bitrate_monitor, stop_bitrate_monitor, write_bitrate_csv,
  type BitrateMonitorPreferences, type BitrateSample, type BitrateSampleError, type BitrateSampleEvent,
} from '../platform/tauri';

Button.define(ButtonDefinition);

type SourceKey = 'nvenc' | 'headset';

interface SourceState {
  sample?: BitrateSample;
  rates?: Rates;
  error?: BitrateSampleError;
  waiting?: string;
  lastArrival?: number;
}

interface HistoryPoint { time: number; value: number; }

interface CsvRecord {
  local_time: string;
  source: string;
  source_id: string;
  label: string;
  monotonic_seconds: number;
  measurement_kind: string;
  detected_codec: string;
  codec_evidence: string;
  codec_frame_sha256: string;
  codec_frame_index: number | '';
  codec_capture_id: number | '';
  codec_generation: number | '';
  codec_captured_tick_ms: number | '';
  codec_frame_bytes: number | '';
  codec_sampled_at: number | '';
  total_bytes: number;
  frames: number | '';
  current_mbps: number;
  average_mbps: number;
  min_window_mbps: number;
  max_window_mbps: number;
  measured_seconds: number;
  fps: number | '';
}

const CSV_COLUMNS: Array<keyof CsvRecord> = [
  'local_time', 'source', 'source_id', 'label', 'monotonic_seconds', 'measurement_kind',
  'detected_codec', 'codec_evidence', 'codec_frame_sha256', 'codec_frame_index', 'codec_capture_id',
  'codec_generation', 'codec_captured_tick_ms', 'codec_frame_bytes', 'codec_sampled_at',
  'total_bytes', 'frames', 'current_mbps', 'average_mbps', 'min_window_mbps', 'max_window_mbps',
  'measured_seconds', 'fps',
];

function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function themePreference(value: string): 'system' | 'light' | 'dark' {
  return value === 'light' || value === 'dark' ? value : 'system';
}

@customElement('app-bitrate-monitor')
export class BitrateMonitorWindow extends LitElement {
  static styles = [interactiveStyles, css`
    :host {
      display: block;
      --bitrate-nvenc: #0b7a63;
      --bitrate-headset: #1f5fbf;
      color: var(--colorNeutralForeground1, #242424);
      background: var(--colorNeutralBackground2, #f5f5f5);
    }
    :host-context([data-theme='dark']) {
      --bitrate-nvenc: #4ed6b0;
      --bitrate-headset: #7ab8ff;
    }
    .page { max-width: 1500px; margin: 0 auto; padding: 14px 22px 22px; }
    .intro { margin: 0 0 12px; color: var(--colorNeutralForeground3, #5f6b7a); }
    .controls {
      display: flex; flex-wrap: wrap; align-items: end; gap: 8px 12px;
      padding: 12px 14px; margin-bottom: 12px;
      border: 1px solid var(--colorNeutralStroke2, #e0e0e0); border-radius: 8px;
      background: var(--colorNeutralBackground1, #fff);
    }
    .controls label { display: flex; flex-direction: column; gap: 4px; font-size: 0.9rem; }
    .interval { display: flex; flex-direction: column; gap: 4px; font-size: 0.9rem; }
    .interval input {
      min-height: 32px; padding: 5px 8px; width: 6.5rem;
      color: var(--colorNeutralForeground1, #242424);
      background: var(--colorNeutralBackground1, #fff);
      border: 1px solid var(--colorNeutralStroke1, #d1d1d1); border-radius: 4px;
    }
    .controls label.grow { flex: 1 1 300px; min-width: 220px; }
    .controls input {
      min-height: 32px; padding: 5px 8px; width: 100%;
      color: var(--colorNeutralForeground1, #242424);
      background: var(--colorNeutralBackground1, #fff);
      border: 1px solid var(--colorNeutralStroke1, #d1d1d1); border-radius: 4px;
    }
    .hint { flex-basis: 100%; color: var(--colorNeutralForeground3, #5f6b7a); font-size: 0.82rem; }
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 14px; }
    .card {
      padding: 14px; border: 1px solid var(--colorNeutralStroke2, #e0e0e0); border-radius: 8px;
      background: var(--colorNeutralBackground1, #fff); min-width: 0;
    }
    .card h2 { margin: 0; font-size: 0.8rem; letter-spacing: 0.04em; text-transform: uppercase; }
    .card.nvenc h2 { color: var(--bitrate-nvenc); }
    .card.headset h2 { color: var(--bitrate-headset); }
    .current { font-size: 2.35rem; font-weight: 600; line-height: 1.15; margin-top: 4px; }
    .unit { color: var(--colorNeutralForeground3, #5f6b7a); font-size: 0.8rem; }
    .fields { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin: 10px 0 6px; }
    .fields span { display: block; color: var(--colorNeutralForeground3, #5f6b7a); font-size: 0.78rem; }
    .fields strong { display: block; font-size: 1.15rem; font-weight: 600; }
    .status { margin: 6px 0 0; min-height: 3.1em; white-space: pre-line; overflow-wrap: anywhere; font-size: 0.86rem; }
    .note { margin: 4px 0 0; color: var(--colorNeutralForeground3, #5f6b7a); font-size: 0.8rem; }
    .codec { margin: 8px 0 0; color: var(--colorPaletteDarkOrangeForeground1, #8a5a00); font-size: 0.84rem; white-space: pre-line; overflow-wrap: anywhere; }
    .codec.verified { color: var(--colorPaletteGreenForeground1, #0b6a0b); }
    .chart-title { margin: 16px 0 4px; color: var(--colorNeutralForeground3, #5f6b7a); font-size: 0.75rem; font-weight: 600; letter-spacing: 0.04em; }
    canvas {
      display: block; width: 100%; height: 190px;
      border: 1px solid var(--colorNeutralStroke2, #e0e0e0); border-radius: 8px;
      background: var(--colorNeutralBackground1, #fff);
    }
    .warn { color: var(--colorPaletteDarkOrangeForeground1, #8a5a00); }
    .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 12px; }
    .actions .spacer { flex: 1 1 auto; }
    .footer { margin: 10px 0 0; color: var(--colorNeutralForeground3, #5f6b7a); font-size: 0.8rem; overflow-wrap: anywhere; }
    .error { color: var(--colorPaletteRedForeground1, #a4262c); margin: 8px 0; white-space: pre-wrap; }
    @media (max-width: 760px) {
      .page { padding-inline: 10px; }
      .cards { grid-template-columns: 1fr; }
      .fields { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
  `];

  private states: Record<SourceKey, SourceState> = { nvenc: {}, headset: {} };
  private trackers: Record<SourceKey, RateTracker> = { nvenc: new RateTracker(), headset: new RateTracker() };
  private histories: Record<SourceKey, HistoryPoint[]> = { nvenc: [], headset: [] };
  private records: CsvRecord[] = [];
  private preferences?: BitrateMonitorPreferences;
  private adbPath = '';
  private serial = '';
  private appliedAdb = '';
  private appliedSerial = '';
  private codecInterval = '5';
  private appliedInterval = 5;
  private infoPath?: string;
  private generation = '';
  private sessionStarted = false;
  private starting = false;
  private disposed = false;
  private paused = false;
  private footer = '';
  private openError = '';
  private pending: BitrateSampleEvent[] = [];
  private themePreference: 'system' | 'light' | 'dark' = 'system';
  private watchdog?: ReturnType<typeof setInterval>;
  private unlisten?: UnlistenFn;
  private themeUnlisten?: UnlistenFn;
  private unsubLocale?: () => void;
  private resizeObserver?: ResizeObserver;
  private readonly systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
  private readonly onSystemTheme = () => applyTheme(this.themePreference);
  private readonly onVisibility = () => {
    if (document.visibilityState === 'hidden') {
      void this.stopSession();
      this.footer = t('Sampling is paused while the window is hidden.');
      this.requestUpdate();
    } else {
      void this.startSession();
    }
  };
  private readonly onPageHide = () => { void this.stopSession(); };

  connectedCallback(): void {
    super.connectedCallback();
    this.disposed = false;
    this.unsubLocale = subscribeLocale(() => this.requestUpdate());
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('pagehide', this.onPageHide);
    this.systemTheme.addEventListener('change', this.onSystemTheme);
    void this.boot();
  }

  disconnectedCallback(): void {
    this.disposed = true;
    this.sessionStarted = false;
    this.unsubLocale?.();
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('pagehide', this.onPageHide);
    this.systemTheme.removeEventListener('change', this.onSystemTheme);
    this.unlisten?.(); this.unlisten = undefined;
    this.themeUnlisten?.(); this.themeUnlisten = undefined;
    this.resizeObserver?.disconnect();
    this.clearWatchdog();
    void stop_bitrate_monitor().catch(() => undefined);
    super.disconnectedCallback();
  }

  private async boot(): Promise<void> {
    try {
      const environment = await bitrate_monitor_environment();
      if (this.disposed) return;
      this.themePreference = themePreference(environment.theme || 'system');
      applyTheme(this.themePreference);
      this.infoPath = environment.infoPath ?? undefined;
      this.themeUnlisten = await listen<string>('bitrate-monitor-theme', event => {
        this.themePreference = themePreference(event.payload || 'system');
        applyTheme(this.themePreference);
        this.requestUpdate();
      });
      if (this.disposed) { this.themeUnlisten(); this.themeUnlisten = undefined; return; }
      this.preferences = await bitrate_monitor_preferences();
      if (this.disposed) return;
      this.adbPath = this.appliedAdb = this.preferences.adbPath;
      this.serial = this.appliedSerial = this.preferences.serial;
      this.appliedInterval = this.preferences.codecInterval;
      this.codecInterval = String(this.preferences.codecInterval);
      const invalidInterval = this.preferences.invalidInterval;
      await this.startSession();
      if (invalidInterval) {
        this.footer = t('Saved frame interval is invalid; inspection uses 5 seconds until a valid interval is applied.');
      }
    } catch (error) {
      this.openError = String(error);
    }
  }

  private config() {
    return {
      infoPath: this.infoPath,
      adbPath: this.appliedAdb,
      serial: this.appliedSerial,
      codecInterval: this.appliedInterval,
    };
  }

  private async startSession(): Promise<void> {
    if (this.disposed || this.sessionStarted || this.starting || document.visibilityState === 'hidden') return;
    this.starting = true;
    try {
      this.resetBaselines(true);
      if (!this.unlisten) {
        this.unlisten = await listen<BitrateSampleEvent>('bitrate-monitor-sample', event => this.onSample(event.payload));
      }
      if (this.disposed) { this.unlisten(); this.unlisten = undefined; return; }
      const generation = await start_bitrate_monitor(this.config());
      if (this.disposed) {
        await stop_bitrate_monitor().catch(() => undefined);
        return;
      }
      this.generation = String(generation);
      this.sessionStarted = true;
      this.openError = '';
      const pending = this.pending;
      this.pending = [];
      for (const event of pending) {
        if (String(event.generation) === this.generation) this.applySample(event);
      }
      this.stampFooter();
      this.clearWatchdog();
      this.watchdog = setInterval(() => this.checkStale(), 1000);
    } catch (error) {
      this.openError = String(error);
      this.footer = '';
    } finally {
      this.starting = false;
      this.requestUpdate();
    }
  }

  private async stopSession(): Promise<void> {
    this.clearWatchdog();
    const wasStarted = this.sessionStarted;
    this.sessionStarted = false;
    this.pending = [];
    if (wasStarted) {
      try { await stop_bitrate_monitor(); } catch { /* The window may already be closing. */ }
    }
  }

  private clearWatchdog(): void {
    if (this.watchdog !== undefined) clearInterval(this.watchdog);
    this.watchdog = undefined;
  }

  private async restartSession(): Promise<void> {
    await this.stopSession();
    await this.startSession();
  }

  private onSample(event: BitrateSampleEvent): void {
    if (!this.sessionStarted) {
      if (this.pending.length < 20) this.pending.push(event);
      return;
    }
    if (String(event.generation) !== this.generation) return;
    this.applySample(event);
  }

  private applySample(event: BitrateSampleEvent): void {
    const key = event.source;
    const state = this.states[key];
    state.lastArrival = Date.now();
    if (event.error) {
      state.error = event.error;
      state.sample = undefined;
      state.rates = undefined;
      state.waiting = undefined;
      this.trackers[key].reset();
      this.histories[key] = [];
      if (!this.paused) this.stampFooter();
      this.requestUpdate();
      return;
    }
    if (!event.sample) return;
    state.error = undefined;
    state.sample = event.sample;
    if (!this.paused) {
      const point: RateSample = {
        sourceId: event.sample.sourceId,
        monotonicTime: event.sample.monotonicTime,
        totalBytes: event.sample.totalBytes,
        frames: event.sample.frames,
      };
      if (this.trackers[key].isDuplicate(point)) {
        // Decoder logs can repeat between publication ticks. An exact repeat
        // is not a new time window and must not reset the rate baseline.
        this.stampFooter();
        this.requestUpdate();
        return;
      }
      try {
        const rates = this.trackers[key].update(point);
        if (!rates) {
          this.histories[key] = [];
          state.rates = undefined;
          state.waiting = t('Waiting for two fresh samples…');
        } else {
          state.rates = rates;
          state.waiting = undefined;
          this.histories[key].push({ time: event.sample.monotonicTime, value: rates.current });
          if (this.histories[key].length > 300) this.histories[key].shift();
          this.record(key, event.sample, rates);
        }
      } catch (error) {
        this.trackers[key].reset();
        this.histories[key] = [];
        state.rates = undefined;
        state.waiting = undefined;
        state.error = { code: 'rate-invalid', detail: String(error) };
      }
      this.stampFooter();
    }
    this.requestUpdate();
  }

  private record(key: SourceKey, sample: BitrateSample, rates: Rates): void {
    const detection = sample.codec;
    const label = key === 'nvenc'
      ? 'NVENC encoded video (actual completed bytes)'
      : sample.kind === 'decoderInput'
        ? 'Headset decoder input (accepted video bytes)'
        : `Headset ${sample.interface ?? 'WLAN'} RX (all traffic)`;
    this.records.push({
      local_time: localIsoTimestamp(),
      source: key,
      source_id: sample.sourceId,
      label,
      monotonic_seconds: sample.monotonicTime,
      measurement_kind: sample.kind === 'nvenc' ? 'encoded_output'
        : sample.kind === 'decoderInput' ? 'decoder_input' : 'network_rx_all_traffic',
      detected_codec: detection?.codec ?? '',
      codec_evidence: detection?.evidence ?? '',
      codec_frame_sha256: detection?.frameSha256 ?? '',
      codec_frame_index: detection?.frameIndex ?? '',
      codec_capture_id: detection?.captureId ?? '',
      codec_generation: detection?.generation ?? '',
      codec_captured_tick_ms: detection?.capturedTickMs ?? '',
      codec_frame_bytes: detection?.frameBytes ?? '',
      codec_sampled_at: detection?.sampledAt ?? '',
      total_bytes: sample.totalBytes,
      frames: sample.frames ?? '',
      current_mbps: rates.current,
      average_mbps: rates.average,
      min_window_mbps: rates.minimum,
      max_window_mbps: rates.maximum,
      measured_seconds: rates.seconds,
      fps: rates.fps ?? '',
    });
    if (this.records.length > 14400) this.records.shift();
  }

  private resetBaselines(showWaiting: boolean): void {
    for (const key of ['nvenc', 'headset'] as const) {
      this.trackers[key].reset();
      this.histories[key] = [];
      this.states[key].rates = undefined;
      if (showWaiting) {
        this.states[key].waiting = t('Waiting for two fresh samples…');
        this.states[key].error = undefined;
      }
    }
  }

  /** User Reset clears completed windows; a session restart keeps them. */
  private resetStatistics(showWaiting: boolean): void {
    this.resetBaselines(showWaiting);
    this.records = [];
  }

  private checkStale(): void {
    if (this.paused || !this.sessionStarted) return;
    let changed = false;
    for (const key of ['nvenc', 'headset'] as const) {
      const state = this.states[key];
      if (state.rates && state.lastArrival && Date.now() - state.lastArrival > 6000) {
        this.trackers[key].reset();
        this.histories[key] = [];
        state.rates = undefined;
        state.waiting = undefined;
        state.error = { code: 'stale', detail: '' };
        changed = true;
      }
    }
    if (changed) this.requestUpdate();
  }

  private stampFooter(): void {
    this.footer = `${t('Read-only measurement')} • ${new Date().toLocaleTimeString()} • ${t('Independent sampling, approximately once per second')}`;
  }

  private togglePause(): void {
    this.paused = !this.paused;
    this.resetStatistics(false);
    if (this.paused) {
      for (const key of ['nvenc', 'headset'] as const) {
        this.states[key].waiting = t('Paused');
        this.states[key].error = undefined;
        this.states[key].rates = undefined;
      }
      this.footer = t('Paused');
    } else {
      this.stampFooter();
    }
    this.requestUpdate();
  }

  private async browse(): Promise<void> {
    try {
      const selected = await openDialog({
        title: t('Select adb.exe'),
        multiple: false,
        directory: false,
        filters: [{ name: 'ADB', extensions: ['exe'] }, { name: t('All files'), extensions: ['*'] }],
      });
      if (typeof selected === 'string') {
        this.adbPath = selected;
        await this.applyAdb();
      }
    } catch (error) {
      this.openError = String(error);
    }
  }

  private async savePreferences(): Promise<boolean> {
    try {
      await save_bitrate_monitor_preferences({
        adbPath: this.appliedAdb,
        serial: this.appliedSerial,
        codecInterval: this.appliedInterval,
        defaultAdb: this.preferences?.defaultAdb ?? '',
        invalidInterval: false,
      });
      return true;
    } catch (error) {
      this.openError = `${t('Preferences could not be saved')}: ${String(error)}`;
      return false;
    }
  }

  private async applyAdb(): Promise<void> {
    this.appliedAdb = this.adbPath.trim();
    this.appliedSerial = this.serial.trim();
    if (!await this.savePreferences()) {
      this.requestUpdate();
      return;
    }
    await this.restartSession();
    this.openError = '';
    this.requestUpdate();
  }

  private async applyInterval(): Promise<void> {
    const seconds = Number(this.codecInterval);
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 3600) {
      this.openError = t('Enter a frame inspection interval from 1 to 3600 seconds.');
      this.requestUpdate();
      return;
    }
    this.appliedInterval = seconds;
    this.appliedAdb = this.adbPath.trim();
    this.appliedSerial = this.serial.trim();
    if (!await this.savePreferences()) {
      this.requestUpdate();
      return;
    }
    await this.restartSession();
    this.openError = '';
    this.footer = t('Frame inspection interval applied. Streaming settings were not changed.');
    this.requestUpdate();
  }

  private async exportCsv(): Promise<void> {
    if (!this.records.length) {
      this.footer = t('No completed measurement windows yet.');
      this.requestUpdate();
      return;
    }
    try {
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
      const destination = await saveDialog({
        title: t('Export measured samples'),
        defaultPath: `bitrate-${stamp}.csv`,
        filters: [{ name: 'CSV', extensions: ['csv'] }],
      });
      if (!destination) return;
      const header = CSV_COLUMNS.join(',');
      const rows = this.records.map(record => CSV_COLUMNS.map(column => csvCell(record[column])).join(','));
      await write_bitrate_csv(destination, `\ufeff${header}\r\n${rows.join('\r\n')}\r\n`);
      this.footer = `${t('Saved')}: ${destination}`;
    } catch (error) {
      this.openError = `${t('Export failed')}: ${String(error)}`;
    }
    this.requestUpdate();
  }

  private errorMessage(error: BitrateSampleError): string {
    const label = (() => {
      switch (error.code) {
        case 'adb-missing': return t('Choose an existing adb executable.');
        case 'adb-failed': return t('ADB is unavailable or rejected the command.');
        case 'usb-missing': return t('No single authorized USB headset; connect USB and authorize ADB.');
        case 'usb-model': return t('The connected USB device is not a supported Galaxy XR headset (SM-I610).');
        case 'usb-changed': return t('The selected USB headset changed or disconnected.');
        case 'boot-id': return t('Headset boot identity is unavailable.');
        case 'wlan-interface': return t('Cannot identify one WLAN RX interface.');
        case 'telemetry-missing': return t('Current driver telemetry is missing or incomplete.');
        case 'telemetry-stale': return t('Driver telemetry is stale; start a current stream.');
        case 'not-initialized': return t('SteamVR is not running with the driver initialized.');
        case 'counter-inactive': return t('The installed NVENC output counter is not active.');
        case 'no-stream': return t('NVENC has not accepted a live stream yet.');
        case 'access-denied': return t('Cannot read the current SteamVR process (closed or access denied).');
        case 'module-mismatch': return t('The telemetry driver DLL does not match a module in current SteamVR.');
        case 'unsupported-build': return t('This driver build has no audited counter profile.');
        case 'probe-unavailable': return t('The NVENC frame probe is unavailable.');
        case 'counter-unstable': return t('The NVENC counter changed during sampling.');
        case 'counter-regressed': return t('The NVENC counters moved backwards; waiting for a new baseline.');
        case 'process-changed': return t('The SteamVR process changed; waiting for a new baseline.');
        case 'memory-unreadable': return t('The NVENC counter is no longer readable.');
        case 'rate-invalid': return t('The received counter sample was invalid.');
        case 'stale': return t('Counter is stale; waiting for a fresh measurement.');
        default: return t('Unavailable');
      }
    })();
    const detail = error.detail?.trim();
    if (!detail) return label;
    const normalizedLabel = label.replace(/[.。]$/, '').toLowerCase();
    const normalizedDetail = detail.replace(/[.。]$/, '').toLowerCase();
    if (normalizedLabel.includes(normalizedDetail) || normalizedDetail.includes(normalizedLabel)) return label;
    return `${label} ${detail}`;
  }

  private statusText(key: SourceKey): string {
    const state = this.states[key];
    if (state.error) return `${t('Unavailable')}: ${this.errorMessage(state.error)}`;
    if (!state.sample) return key === 'nvenc' ? t('Waiting for counter samples…') : t('Connecting…');
    const sample = state.sample;
    if (key === 'nvenc') {
      const pid = sample.pid ?? '?';
      const sha = (sample.moduleSha256 ?? '').slice(0, 12);
      return t('Exact counter · PID {pid} · SHA-256 {sha}', { pid, sha });
    }
    const serial = sample.serial ?? '?';
    if (sample.kind === 'decoderInput') {
      return t('USB {serial}; existing fresh decoder telemetry. Not display/presentation proof.', { serial });
    }
    return `${t('USB {serial}; decoder byte telemetry unavailable. Includes audio, FEC, retransmits and other traffic; NOT video-only bitrate.', { serial })}\n${t('Decoder video bytes unavailable; network total shown.')}`;
  }

  private codecLine(key: SourceKey): { text: string; note: string; verified: boolean } {
    if (key === 'headset') {
      return { text: t('Frame codec: unverified'), note: t('No headset frame-byte capture is available.'), verified: false };
    }
    const detection = this.states.nvenc.sample?.codec;
    if (!detection) return { text: t('Frame codec: unverified'), note: t('Waiting for a captured frame…'), verified: false };
    if (detection.codec) {
      const age = Math.max(0, Math.round(detection.ageSeconds));
      const note = detection.frameSha256
        ? `SHA-256 ${detection.frameSha256.slice(0, 16)}`
        : detection.evidence;
      return { text: `${t('Frame codec')}: ${detection.label} • ${age}s`, note, verified: true };
    }
    const evidence = detection.evidence ?? '';
    if (evidence.includes('no frame snapshot export')) {
      return { text: t('Frame codec: unverified'), note: t('Needs the frame-snapshot driver; see the usage guide.'), verified: false };
    }
    if (evidence.includes('stale') || evidence.includes('No encoded frame snapshot')) {
      return { text: t('Frame codec: unverified'), note: t('Frame capture is unavailable or stale.'), verified: false };
    }
    if (evidence.includes('Waiting for a captured frame')) {
      return { text: t('Frame codec: unverified'), note: t('Waiting for a captured frame…'), verified: false };
    }
    return {
      text: t('Frame codec: unverified'),
      note: `${t('Captured frame did not provide conclusive codec evidence.')} ${evidence}`.trim(),
      verified: false,
    };
  }

  private rateNote(key: SourceKey, sample: BitrateSample | undefined, rates: Rates): string {
    const unit = key === 'nvenc' ? t('buffers/s')
      : sample?.kind === 'decoderInput' ? t('decoder input frames/s') : '';
    const countRate = rates.fps == null || !unit ? '' : ` • ${rates.fps.toFixed(1)} ${unit}`;
    return `${rates.seconds.toFixed(1)} s • ${rates.samples} ${t('windows')}${countRate}`;
  }

  private renderCard(key: SourceKey, title: string): TemplateResult {
    const state = this.states[key];
    const rates = state.rates;
    const codec = this.codecLine(key);
    return html`
      <section class="card ${key}">
        <h2>${title}</h2>
        <div class="current">${rates ? rates.current.toFixed(2) : '—'}</div>
        <div class="unit">${t('CURRENT Mbps')}</div>
        <div class="fields">
          ${([['average', t('Average')], ['minimum', t('Min window')], ['maximum', t('Max window')]] as const).map(([field, label]) => html`
            <div><span>${label}</span><strong>${rates ? rates[field].toFixed(2) : '—'}</strong></div>`)}
        </div>
        <p class="status">${this.statusText(key)}${state.waiting ? `\n${state.waiting}` : ''}</p>
        <p class="note">${rates ? this.rateNote(key, state.sample, rates) : ''}</p>
        <p class=${`codec${codec.verified ? ' verified' : ''}`}>${codec.text}</p>
        <p class="note">${codec.note}</p>
      </section>`;
  }

  private historyColors(): { nvenc: string; headset: string; grid: string; text: string } {
    const dark = document.documentElement.dataset.theme === 'dark';
    return {
      nvenc: dark ? '#4ed6b0' : '#0b7a63',
      headset: dark ? '#7ab8ff' : '#1f5fbf',
      grid: dark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.13)',
      text: dark ? '#c7d2de' : '#5f6b7a',
    };
  }

  private drawChart(): void {
    const canvas = this.renderRoot.querySelector('canvas');
    if (!canvas) return;
    const width = canvas.clientWidth, height = canvas.clientHeight;
    if (!width || !height) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const context = canvas.getContext('2d');
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const colors = this.historyColors();
    const points = [...this.histories.nvenc, ...this.histories.headset];
    const maximum = Math.max(100, Math.max(0, ...points.map(point => point.value)) * 1.15);
    const left = 56, right = width - 16, top = 16, bottom = Math.max(34, height - 14);
    context.clearRect(0, 0, width, height);
    context.strokeStyle = colors.grid;
    context.fillStyle = colors.text;
    context.lineWidth = 1;
    context.font = '11px monospace';
    for (const fraction of [0, 0.5, 1]) {
      const y = bottom - fraction * (bottom - top);
      context.beginPath(); context.moveTo(left, y); context.lineTo(right, y); context.stroke();
      const label = String(Math.round(maximum * fraction));
      context.fillText(label, left - 7 - context.measureText(label).width, y + 4);
    }
    context.fillText('Mbps', left, 11);
    if (!points.length) {
      const text = t('Waiting for measured byte deltas');
      context.fillText(text, width / 2 - context.measureText(text).width / 2, height / 2);
      return;
    }
    const newest = Math.max(...points.map(point => point.time));
    const oldest = Math.min(...points.map(point => point.time));
    const span = Math.max(10, newest - oldest);
    for (const key of ['nvenc', 'headset'] as const) {
      const history = this.histories[key];
      const coordinates: number[] = [];
      for (const point of history) {
        const x = right - (newest - point.time) / span * (right - left);
        const y = bottom - point.value / maximum * (bottom - top);
        coordinates.push(x, y);
      }
      if (coordinates.length >= 4) {
        context.strokeStyle = key === 'nvenc' ? colors.nvenc : colors.headset;
        context.lineWidth = 2;
        context.beginPath();
        context.moveTo(coordinates[0], coordinates[1]);
        for (let index = 2; index < coordinates.length; index += 2) context.lineTo(coordinates[index], coordinates[index + 1]);
        context.stroke();
      } else if (coordinates.length) {
        context.fillStyle = key === 'nvenc' ? colors.nvenc : colors.headset;
        context.beginPath();
        context.arc(coordinates[0], coordinates[1], 2.5, 0, Math.PI * 2);
        context.fill();
      }
    }
    context.lineWidth = 1;
  }

  protected firstUpdated(): void {
    const canvas = this.renderRoot.querySelector('canvas');
    if (canvas) {
      this.resizeObserver = new ResizeObserver(() => this.drawChart());
      this.resizeObserver.observe(canvas);
    }
    this.drawChart();
  }

  protected updated(): void {
    this.drawChart();
  }

  render() {
    return html`
      <div class="page">
        <p class="intro">${t('Measured bytes over time • decimal Mbps • no stream settings are changed')}</p>
        <section class="controls" aria-label=${t('Connection')}>
          <label class="grow"><span>${t('ADB path')}</span>
            <input type="text" .value=${this.adbPath} @input=${(event: Event) => { this.adbPath = (event.target as HTMLInputElement).value; }}>
          </label>
          <fluent-button id="browse" appearance="outline" @click=${() => { void this.browse(); }}>${t('Browse…')}</fluent-button>
          <fluent-button id="apply-adb" appearance="outline" @click=${() => { void this.applyAdb(); }}>${t('Apply ADB')}</fluent-button>
          <label><span>${t('USB serial (optional)')}</span>
            <input type="text" .value=${this.serial} @input=${(event: Event) => { this.serial = (event.target as HTMLInputElement).value; }}>
          </label>
          <span class="hint">${t('USB debugging only; wireless ADB is never selected.')}</span>
        </section>
        ${this.openError ? html`<p class="error" role="alert">${this.openError}</p>` : nothing}
        <div class="cards">
          ${this.renderCard('nvenc', t('NVENC OUTPUT'))}
          ${this.renderCard('headset', t('HEADSET VIA USB ADB'))}
        </div>
        <h2 class="chart-title">${t('LAST 300 SAMPLES')}</h2>
        <canvas aria-label=${t('Measured bitrate history')}></canvas>
        <p class="note">${t('Min/max are sampling-window rates, not per-packet peaks. Average is weighted by elapsed time.')}</p>
        <p class="note warn">${t('Headset WLAN RX includes all interface traffic and protocol overhead; it is not video-only bitrate.')}</p>
        <div class="actions">
          <fluent-button id="reset" appearance="outline" @click=${() => { this.resetStatistics(true); this.stampFooter(); this.requestUpdate(); }}>${t('Reset statistics')}</fluent-button>
          <fluent-button id="pause" appearance="outline" @click=${() => this.togglePause()}>${this.paused ? t('Resume') : t('Pause')}</fluent-button>
          <fluent-button id="export" appearance="outline" @click=${() => { void this.exportCsv(); }}>${t('Export CSV…')}</fluent-button>
          <span class="spacer"></span>
          <label class="interval"><span>${t('Frame interval (s)')}</span>
            <input type="number" min="1" max="3600" step="1" .value=${this.codecInterval}
              @input=${(event: Event) => { this.codecInterval = (event.target as HTMLInputElement).value; }}>
          </label>
          <fluent-button id="apply-interval" appearance="outline" @click=${() => { void this.applyInterval(); }}>${t('Apply interval')}</fluent-button>
        </div>
        <p class="footer">${this.footer}</p>
      </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'app-bitrate-monitor': BitrateMonitorWindow;
  }
}
