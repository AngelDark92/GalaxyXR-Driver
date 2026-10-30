import { signal } from '../reactive';
import { inspectSettings, type SettingCheck } from '../domain/settings-inspection';
import { galaxyXRDriverName, vendor } from '../environment';
import { presentSettings, type PresentedSettingCheck } from '../domain/settings-presentation';
import { flushFileWrites } from '../platform/writer';
import type { AppSettingService } from './app-setting';
import type { DriverSettingService } from './driver-setting';
import type { DriverInfoService } from './driver-info';
import type { SystemDiagnosticService } from './system-diagnostic';

export interface SettingsCheckReport {
  checkedAt: string;
  checks: SettingCheck[];
  settings: PresentedSettingCheck[];
  errors: string[];
  warnings: string[];
  driverEnabled: boolean | undefined;
  driverInstalled: boolean;
}

/** Read-back of every persisted boolean, including advanced/hidden controls.
 * This does not claim that a restart-only value is already active in SteamVR.
 * It never installs, resets, changes drivers, or restarts the compositor.
 */
export class SettingsCheckService {
  private _checking = signal(false);
  public readonly checking = this._checking.asReadonly();
  private _report = signal<SettingsCheckReport | undefined>(undefined);
  public readonly report = this._report.asReadonly();
  private running?: Promise<SettingsCheckReport>;

  constructor(
    private app: AppSettingService, private driver: DriverSettingService,
    private info: DriverInfoService, private system: SystemDiagnosticService,
  ) {}

  clear(): void { this._report.set(undefined); }

  refresh(): Promise<SettingsCheckReport> {
    if (this.running) return this.running;
    this._checking.set(true);
    this.running = this.inspect().finally(() => {
      this.running = undefined;
      this._checking.set(false);
    });
    return this.running;
  }

  private async inspect(): Promise<SettingsCheckReport> {
    const report: SettingsCheckReport = {
      checkedAt: new Date().toISOString(), checks: [], settings: [], errors: [], warnings: [],
      driverEnabled: undefined, driverInstalled: false,
    };
    let appKnown = false;
    let driverKnown = false;
    try {
      if (this.system.installingDriver()) throw new Error('Wait for the driver installation change to finish before checking settings.');
      await Promise.all([this.app.initTask, this.driver.initTask, this.info.initTask, this.system.initTask]);
      // Let already-requested saves enqueue, then flush their debounce queues.
      await Promise.resolve();
      try { await flushFileWrites(); }
      catch (error) { report.warnings.push(`An earlier edit could not be saved: ${String(error)}`); }
      this.driver.inspecting = this.app.inspecting = this.info.inspecting = true;
      report.driverInstalled = await this.system.checkDriverInstalled(true, true);
      if (this.system.driverCheckError()) report.errors.push(this.system.driverCheckError()!);
      if (!report.driverInstalled && this.system.driverState() !== 'unknown') {
        report.warnings.push('The selected vendor driver is not installed. Saved configuration is not proof that the driver is running.');
      }
      // Refresh runtime-published defaults before interpreting omitted keys.
      if (!await this.info.loadSetting()) report.warnings.push('Runtime information is unavailable. Missing settings use bundled defaults.');
      if (await this.app.loadSetting()) {
        appKnown = true;
        // driverVerified is the Setup page's verification latch, not a user
        // setting, so it stays out of the settings report (2026-09-23).
        report.checks.push(...inspectSettings(this.app.values(), this.app.storedValues(), this.app.effectiveDefaults(), 'gui-settings.json')
          .filter(check => check.key !== 'driverVerified'));
      } else report.errors.push(`gui-settings.json: ${this.app.readFileError()?.message ?? this.app.readFileError()?.reason}`);
      if (await this.driver.loadSetting()) {
        driverKnown = true;
        report.checks.push(...inspectSettings(this.driver.values(), this.driver.storedValues(), this.driver.effectiveDefaults(), 'settings.json'));
      } else report.errors.push(`settings.json: ${this.driver.readFileError()?.message ?? this.driver.readFileError()?.reason}`);
      if (await this.system.refreshSteamVRSettings()) {
        report.driverEnabled = this.system.getSteamVRDriverEnableState(this.system.steamVrConfig(), galaxyXRDriverName);
      } else report.errors.push(`steamvr.vrsettings: ${this.system.steamVRsettingsError()}`);
      // Allow synchronous/reactive subscribers to consume the disk snapshot
      // while their migration writes are still suppressed.
      await Promise.resolve();
    } catch (error) {
      report.errors.push(String(error));
    } finally {
      this.driver.inspecting = this.app.inspecting = this.info.inspecting = false;
    }
    report.settings = presentSettings(report.checks, {
      settings: driverKnown ? this.driver.values() : undefined,
      app: appKnown ? this.app.values() : undefined,
      driverInstalled: report.driverInstalled, vendor: !!vendor,
    });
    report.checkedAt = new Date().toISOString();
    this._report.set(report);
    return report;
  }
}
