import { computed, signal } from '../reactive';
import type { AppSetting, Settings } from '../domain/types';
import type { AppSettingService } from './app-setting';
import type { DriverSettingService } from './driver-setting';
import { FileReadErrorReason } from './settings-base';

// The application view translates these messages through the source catalog.
const messages = {
  appRead: 'Application settings could not be read. Repair gui-settings.json and retry.',
  driverRead: 'Driver settings could not be read. Repair settings.json and retry.',
  driverMissing: 'Driver settings are missing. Install the driver before enabling Hybrid.',
  driverSave: 'Could not save Hybrid settings. Check settings.json permissions and retry.',
  appSave: 'Could not save Advanced Mode. Check gui-settings.json permissions and retry.',
  advancedOffSave: 'Hybrid is off, but Advanced Mode could not be saved. Check gui-settings.json permissions and retry.',
  advancedRequired: 'Enable Advanced Mode before enabling Hybrid.',
  inspecting: 'Settings are being inspected. Finish the settings check and retry.',
  inspectionConflict: 'Hybrid is saved On while Advanced Mode is off. Reload settings to turn Hybrid off.',
  unexpected: 'Hybrid settings could not be updated. Reload settings and retry.',
};

/** Application lifetime owner of the Advanced Mode / Hybrid save ordering. */
export class HybridAccessService {
  readonly allowed = computed(() => !this.appSetting.readFileError() &&
    this.appSetting.confirmedValues()?.advanceMode === true);
  private readonly _changing = signal(false);
  readonly changing = this._changing.asReadonly();
  private readonly _error = signal<string | undefined>(undefined);
  readonly error = this._error.asReadonly();
  private queue: Promise<void> = Promise.resolve();
  private started?: Promise<void>;
  private disposed = false;
  private pending = 0;
  private stopSubscriptions: (() => void)[] = [];
  private reloadQueued = false;
  private reconciliationBlocked = false;
  private ownAppActivity = 0;
  private ownDriverActivity = 0;

  constructor(private readonly appSetting: AppSettingService, private readonly dss: DriverSettingService) {}

  private serialize<T>(task: () => Promise<T>, stopped: T): Promise<T> {
    ++this.pending;
    this._changing.set(true);
    const next = this.queue.then(async () => {
      if (this.disposed) return stopped;
      try { return await task(); }
      catch { this.fail(messages.unexpected); return stopped; }
    }).finally(() => {
      if (--this.pending === 0) this._changing.set(false);
    });
    this.queue = next.then(() => {});
    return next;
  }

  start(): Promise<void> {
    return this.started ??= this.serialize(async () => {
      // A broken settings file must not reject application startup.
      await Promise.allSettled([this.appSetting.initTask, this.dss.initTask]);
      if (this.disposed) return;
      const appChanged = () => { if (!this.ownAppActivity) this.onReload(); };
      const driverChanged = () => { if (!this.ownDriverActivity) this.onReload(); };
      this.stopSubscriptions = [
        this.appSetting.confirmedValues.subscribe(appChanged),
        this.appSetting.readFileError.subscribe(appChanged),
        // values also publishes optimistic saves and rollbacks. storedValues
        // changes only after a disk reload, so failed saves cannot retry here.
        this.dss.storedValues.subscribe(driverChanged),
        this.dss.readFileError.subscribe(driverChanged),
      ];
      await this.reconcile();
    }, undefined);
  }

  private onReload(): void {
    if (this.disposed) return;
    if (!this.inspectable()) { this.reportInspectionConflict(); return; }
    if (this.reloadQueued) return;
    this.reloadQueued = true;
    void this.serialize(async () => {
      this.reloadQueued = false;
      this.reconciliationBlocked = false;
      await this.reconcile();
    }, undefined);
  }

  private fail(message: string): false {
    this._error.set(message);
    this.reconciliationBlocked = true;
    return false;
  }

  private preferences(): AppSetting | undefined {
    if (this.appSetting.readFileError()) return undefined;
    return this.appSetting.confirmedValues();
  }

  private inspectable(): boolean {
    return !this.appSetting.inspecting && !this.dss.inspecting;
  }

  private reportInspectionConflict(): void {
    const stored = this.dss.storedValues() as { hybrid?: { enabled?: unknown } } | undefined;
    const conflict = this.preferences()?.advanceMode === false && !this.dss.readFileError() &&
      stored?.hybrid?.enabled === true && this.dss.values()?.hybrid?.enabled === true;
    if (conflict) this.fail(messages.inspectionConflict);
    else if (this._error() === messages.inspectionConflict) {
      this._error.set(undefined);
      this.reconciliationBlocked = false;
    }
  }

  /** Wait out unrelated edits before cloning the latest loaded snapshots. */
  private async settle(): Promise<boolean> {
    if (!this.inspectable()) return this.fail(messages.inspecting);
    // The base service rolls failed writes back. flush also remembers an old
    // failure until the next save, so rejecting here would prevent retries.
    await Promise.allSettled([this.appSetting.flush(), this.dss.flush()]);
    if (this.disposed) return false;
    return this.inspectable() || this.fail(messages.inspecting);
  }

  private driverReadable(): boolean {
    const error = this.dss.readFileError();
    if (error?.reason === FileReadErrorReason.NotExists) return true;
    return (!error && this.dss.values() !== undefined) || this.fail(messages.driverRead);
  }

  private async saveHybrid(enabled: boolean): Promise<boolean> {
    if (!this.inspectable()) return this.fail(messages.inspecting);
    if (!this.driverReadable()) return false;
    if (this.dss.readFileError()?.reason === FileReadErrorReason.NotExists) {
      return enabled ? this.fail(messages.driverMissing) : true;
    }
    const current = this.dss.values()!;
    if ((current.hybrid?.enabled === true) === enabled) return true;
    const hybrid = current.hybrid ?? this.dss.effectiveDefaults()?.hybrid;
    if (!hybrid) return this.fail(messages.driverRead);
    const snapshot: Settings = { ...structuredClone(current), hybrid: { ...structuredClone(hybrid), enabled } };
    ++this.ownDriverActivity;
    try {
      if (!await this.dss.save(snapshot)) return this.fail(messages.driverSave);
      return true;
    } catch { return this.fail(messages.driverSave); }
    finally { --this.ownDriverActivity; }
  }

  private async saveAdvanced(enabled: boolean): Promise<boolean> {
    // A different app preference may have been saved while native Off was
    // pending. Preserve that newly confirmed snapshot in the second write.
    await Promise.allSettled([this.appSetting.flush()]);
    if (this.disposed) return false;
    if (!this.inspectable()) return this.fail(messages.inspecting);
    const current = this.preferences();
    if (!current) return this.fail(messages.appRead);
    if (current.advanceMode === enabled) return true;
    ++this.ownAppActivity;
    try {
      if (!await this.appSetting.save({ ...structuredClone(current), advanceMode: enabled })) return this.fail(messages.appSave);
      return true;
    } catch { return this.fail(messages.appSave); }
    finally { --this.ownAppActivity; }
  }

  private async reconcile(): Promise<void> {
    if (!this.inspectable()) { this.reportInspectionConflict(); return; }
    if (this.reconciliationBlocked) return;
    if (!await this.settle()) return;
    const preferences = this.preferences();
    if (!preferences) { this.fail(messages.appRead); return; }
    if (!this.driverReadable()) return;
    // A missing native file is a known pre-install state, never a reason to
    // create settings.json. Missing Hybrid keys already mean Off by default.
    if (!preferences.advanceMode && !await this.saveHybrid(false)) return;
    this._error.set(undefined);
  }

  setAdvancedMode(enabled: boolean): Promise<boolean> {
    void this.start();
    return this.serialize(async () => {
      this.reconciliationBlocked = false;
      if (!await this.settle()) return false;
      if (!this.preferences()) return this.fail(messages.appRead);
      // A successful native Off is irreversible within this operation: an app
      // preference failure must never re-enable Hybrid as compensation.
      if (!enabled && !await this.saveHybrid(false)) return false;
      if (!await this.saveAdvanced(enabled)) {
        if (!enabled && this._error() === messages.appSave) this.fail(messages.advancedOffSave);
        return false;
      }
      this._error.set(undefined);
      return true;
    }, false);
  }

  setEnabled(enabled: boolean): Promise<boolean> {
    void this.start();
    return this.serialize(async () => {
      this.reconciliationBlocked = false;
      if (!await this.settle()) return false;
      const preferences = this.preferences();
      if (!preferences) return this.fail(messages.appRead);
      if (enabled && !preferences.advanceMode) return this.fail(messages.advancedRequired);
      if (!await this.saveHybrid(enabled)) return false;
      if (enabled && !this.allowed()) { await this.reconcile(); return false; }
      this._error.set(undefined);
      return true;
    }, false);
  }

  retry(): Promise<void> {
    void this.start();
    return this.serialize(async () => {
      this.reconciliationBlocked = false;
      if (!this.inspectable()) { this.fail(messages.inspecting); return; }
      ++this.ownAppActivity;
      ++this.ownDriverActivity;
      try { await Promise.allSettled([this.appSetting.loadSetting(), this.dss.loadSetting()]); }
      finally { --this.ownAppActivity; --this.ownDriverActivity; }
      await this.reconcile();
    }, undefined);
  }

  async idle(): Promise<void> {
    // Subscriptions run on microtasks and may append reconciliation work.
    for (;;) {
      await Promise.resolve();
      const current = this.queue;
      await current;
      await Promise.resolve();
      if (current === this.queue) return;
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const stop of this.stopSubscriptions.splice(0)) stop();
  }
}
