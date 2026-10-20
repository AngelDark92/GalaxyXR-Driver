import { signal } from '../reactive';
import { t } from '../locale/i18n';
import { normalizeOfxrPreferences } from '../domain/ofxr';
import type { OfxrPreferences, OfxrStatus } from '../domain/types';
import { ofxr_apply, ofxr_arm, ofxr_disarm, ofxr_remove, ofxr_reinstall, ofxr_status } from '../platform/tauri';
import type { AppSettingService } from './app-setting';
import type { DriverSettingService } from './driver-setting';
import type { GalaxySettingsBase } from '../state/galaxy-settings';

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
  ) {}

  preferences(): OfxrPreferences { return normalizeOfxrPreferences(this.app.values().ofxr); }
  isArmed(): boolean { return this.status()?.state === 'armed'; }
  idle(): Promise<void> { return this.queue; }
  dispose(): void { this.disposed = true; }

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
      await Promise.all([this.app.initTask, this.driver.initTask]);
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
    const previousSpacewarp = !!this.galaxy.settings.spacewarpEnable;
    const previousEnabled = this.preferences().enabled;
    // Startup must not rewrite a conflicting user setting. An explicit retry
    // can turn ASW off through the same confirmed-save path as the switch.
    if (restoring && previousSpacewarp) {
      throw new Error(t('Optical Flow was not restored because Async Spacewarp is enabled. Enable Optical Flow again to switch modes.'));
    }
    let disabledSpacewarp = false;
    let savedEnable = false;
    try {
      if (previousSpacewarp) {
        this.galaxy.settings.spacewarpEnable = false;
        if (!await this.galaxy.save() || this.galaxy.settings?.spacewarpEnable !== false) {
          throw new Error(t('Async Spacewarp could not be saved Off. Optical Flow was not armed.'));
        }
        disabledSpacewarp = true;
      }
      if (this.disposed) return;
      const prefs = restoring ? this.preferences() : await this.save({ enabled: true });
      savedEnable = !restoring;
      if (this.disposed) return;
      this.status.set(await ofxr_arm(prefs));
      this.error.set(undefined);
    } catch (failure) {
      const errors = [String(failure instanceof Error ? failure.message : failure)];
      if (savedEnable && !previousEnabled) {
        try { await this.save({ enabled: previousEnabled }); }
        catch (error) { errors.push(String(error)); }
      }
      if (disabledSpacewarp && this.galaxy.settings) {
        this.galaxy.settings.spacewarpEnable = previousSpacewarp;
        if (!await this.galaxy.save()) errors.push(t('The previous Async Spacewarp setting could not be restored.'));
      }
      await this.refreshStatus();
      throw new Error(errors.join(' '));
    }
  }

  update(patch: Partial<OfxrPreferences>): Promise<void> {
    return this.serialize(async () => {
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

  reinstall(): Promise<void> {
    return this.serialize(async () => {
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

  setSpacewarp(enabled: boolean): Promise<void> {
    return this.serialize(async () => {
      // A different page or process may have armed the layer since this
      // service last inspected the registry; the exclusion check must read
      // live state (same rule as selectVersion below).
      if (enabled) await this.refreshStatus();
      if (enabled && this.galaxy.vendor && (this.preferences().enabled || this.isArmed() || this.status()?.state === 'armed_external')) {
        await this.save({ enabled: false });
        // Always confirm disarm, including a failed earlier Off operation.
        try { this.status.set(await ofxr_disarm()); }
        finally { await this.refreshStatus(); }
        if (this.status()?.state === 'armed' || this.status()?.state === 'armed_external') {
          throw new Error(t('Disarm Optical Flow from its current manager before enabling Async Spacewarp.'));
        }
      }
      if (!this.galaxy.settings) return;
      this.galaxy.settings.spacewarpEnable = enabled;
      if (!await this.galaxy.save()) throw new Error(t('The Async Spacewarp setting could not be saved.'));
      this.error.set(undefined);
    });
  }
}
