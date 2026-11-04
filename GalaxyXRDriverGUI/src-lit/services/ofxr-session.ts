import { signal } from '../reactive';
import { t } from '../locale/i18n';
import { normalizeOfxrPreferences } from '../domain/ofxr';
import type { OfxrPreferences, OfxrStatus } from '../domain/types';
import { ofxr_apply, ofxr_arm, ofxr_disarm, ofxr_import, ofxr_remove, ofxr_reinstall, ofxr_status } from '../platform/tauri';
import type { AppSettingService } from './app-setting';
import type { DriverSettingService } from './driver-setting';
import type { GalaxySettingsBase } from '../state/galaxy-settings';
import type { GpuCapabilitiesService } from './gpu-capabilities';
import { ofxrNvidiaSupport } from '../domain/encoder-capabilities';

/** One application-owned queue, including startup restoration and page remounts. */
export class OfxrSessionService {
  readonly status = signal<OfxrStatus | undefined>(undefined);
  readonly error = signal<string | undefined>(undefined);
  readonly changing = signal(false);
  private queue: Promise<void> = Promise.resolve();
  private started?: Promise<void>;
  private disposed = false;

  constructor(
    private readonly app: AppSettingService,
    private readonly driver: DriverSettingService,
    private readonly galaxy: GalaxySettingsBase,
    private readonly gpu: GpuCapabilitiesService,
  ) {}

  preferences(): OfxrPreferences { return normalizeOfxrPreferences(this.app.values().ofxr); }
  isArmed(): boolean { return this.status()?.state === 'armed'; }
  setError(message: string | undefined): void { this.error.set(message); }
  idle(): Promise<void> { return this.queue; }
  dispose(): void { this.disposed = true; }

  private checkNvidiaMode(prefs: OfxrPreferences): void {
    if (!prefs.mode.startsWith('nvidia')) return;
    const verdict = ofxrNvidiaSupport(this.gpu.caps());
    if (verdict.verdict === 'unsupported') {
      throw new Error(verdict.reason ?? t('NVIDIA Optical Flow is not available on the current GPU.'));
    }
  }

  private serialize(task: () => Promise<void>): Promise<void> {
    const next = this.queue.then(async () => {
      if (this.disposed) return;
      this.changing.set(true);
      try { await task(); }
      catch (error) { this.error.set(String(error instanceof Error ? error.message : error)); }
      finally { this.changing.set(false); }
    });
    this.queue = next;
    return next;
  }

  start(): Promise<void> {
    return this.started ??= this.serialize(async () => {
      await Promise.all([this.app.initTask, this.driver.initTask, this.gpu.ready]);
      if (this.disposed || !this.galaxy.vendor) return;
      // Restore only a successfully read preference, never an optimistic draft.
      if (this.app.readFileError() || !this.app.confirmedValues()?.ofxr?.enabled) return;
      await this.refreshStatus();
      await this.arm(true);
    });
  }

  refresh(): Promise<void> { return this.serialize(() => this.refreshStatus()); }
  private async refreshStatus(): Promise<void> {
    try { this.status.set(await ofxr_status(this.preferences().version)); }
    catch (error) {
      this.status.set({ state: 'unavailable', version: null, runtimeDir: null, reason: String(error), versions: [] });
    }
  }

  private async save(patch: Partial<OfxrPreferences>): Promise<OfxrPreferences> {
    const ofxr = { ...this.preferences(), ...patch };
    if (!await this.app.save({ ...this.app.values(), ofxr })) {
      throw new Error(t('Optical Flow preferences could not be saved.') + (this.app.writeFileError() ? ` ${this.app.writeFileError()}` : ''));
    }
    return ofxr;
  }

  setEnabled(enabled: boolean): Promise<void> {
    return this.serialize(async () => {
      if (enabled) { await this.arm(false); return; }
      await this.save({ enabled: false });
      try { this.status.set(await ofxr_disarm()); this.error.set(undefined); }
      finally { await this.refreshStatus(); }
    });
  }

  private async arm(restoring: boolean): Promise<void> {
    await Promise.all([this.app.initTask, this.driver.initTask]);
    if (this.disposed) return;
    if (this.app.readFileError() || this.driver.readFileError() || this.driver.inspecting || !this.galaxy.settings) {
      throw new Error(t('Read the saved driver and Companion settings successfully before enabling Optical Flow.'));
    }
    const previousEnabled = this.preferences().enabled;
    let savedEnable = false;
    try {
      const prefs = restoring ? this.preferences() : await this.save({ enabled: true });
      savedEnable = !restoring;
      this.checkNvidiaMode(prefs);
      if (this.disposed) return;
      this.status.set(await ofxr_arm(prefs));
      this.error.set(undefined);
    } catch (failure) {
      const errors = [String(failure instanceof Error ? failure.message : failure)];
      if (savedEnable && !previousEnabled) {
        try { await this.save({ enabled: previousEnabled }); }
        catch (error) { errors.push(String(error)); }
      }
      await this.refreshStatus();
      throw new Error(errors.join(' '));
    }
  }

  update(patch: Partial<OfxrPreferences>): Promise<void> {
    return this.serialize(async () => {
      // Only a newly requested mode is validated before persisting: choosing an
      // unsupported NVIDIA mode must not be saved and left unapplied, but other
      // edits (and switching away) stay allowed while a stored unsupported mode
      // is kept. Arming always validates the stored mode.
      if (patch.mode !== undefined && patch.mode !== this.preferences().mode) {
        this.checkNvidiaMode({ ...this.preferences(), ...patch });
      }
      const prefs = await this.save(patch);
      try { await ofxr_apply(prefs); this.error.set(undefined); }
      finally { await this.refreshStatus(); }
    });
  }

  selectVersion(version: string): Promise<void> {
    return this.serialize(async () => {
      // Refresh before deciding whether to disarm: a different page may have
      // been open since this service last inspected the registry.
      await this.refreshStatus();
      if (this.status()?.state === 'armed' || this.status()?.state === 'armed_external') {
        this.status.set(await ofxr_disarm());
      }
      const prefs = await this.save({ version });
      try {
        if (prefs.enabled) await this.arm(false);
        else this.error.set(undefined);
      } finally { await this.refreshStatus(); }
    });
  }

  /** Copy a downloaded fork build into the Companion-owned RuntimeLayer. The
   * native side validates the payload shape but deliberately applies no
   * version-compatibility gate; the build's own INI is copied so fork-specific
   * keys survive. */
  importBuild(source: string): Promise<void> {
    return this.serialize(async () => {
      await this.refreshStatus();
      if (this.status()?.state === 'armed' || this.status()?.state === 'armed_external') {
        this.status.set(await ofxr_disarm());
      }
      const version = await ofxr_import(source);
      const prefs = await this.save({ version });
      try {
        if (prefs.enabled) await this.arm(false);
        else this.error.set(undefined);
      } finally { await this.refreshStatus(); }
    });
  }

  reinstall(): Promise<void> {
    return this.serialize(async () => {
      await this.refreshStatus();
      const active = this.status()?.version;
      const selected = this.status()?.versions.find(entry => entry.version === active);
      if (selected?.source === 'imported') {
        throw new Error(t('Reinstall only replaces the bundled payload. Select the bundled version, or remove the imported build through Uninstall Optical Flow first.'));
      }
      try {
        this.status.set(await ofxr_reinstall(this.preferences()));
        if (this.preferences().enabled) await this.arm(false);
        else this.error.set(undefined);
      } finally { await this.refreshStatus(); }
    });
  }

  remove(): Promise<void> {
    return this.serialize(async () => {
      try {
        this.status.set(await ofxr_remove());
        await this.save({ enabled: false, version: '' });
        this.error.set(undefined);
      } finally { await this.refreshStatus(); }
    });
  }
}
