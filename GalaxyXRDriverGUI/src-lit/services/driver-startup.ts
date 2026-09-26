import { signal } from '../reactive';
import { get_galaxyxr_runtime_status, type DriverRuntimeStatus } from '../platform/tauri';
import type { SystemDiagnosticService } from './system-diagnostic';

/** Installation and current-session verification are different states. Polling
 * is owned by Setup's lifecycle, so there is no permanent hidden background job. */
export class DriverStartupService {
  private readonly _status = signal<DriverRuntimeStatus | undefined>(undefined);
  readonly status = this._status.asReadonly();
  private readonly _error = signal<string | undefined>(undefined);
  readonly error = this._error.asReadonly();
  private readonly _launching = signal(false);
  readonly launching = this._launching.asReadonly();
  private running?: Promise<void>;
  private generation = 0;

  constructor(private system: SystemDiagnosticService) {}

  invalidate(): void {
    ++this.generation;
    this._status.set(undefined);
    this._error.set(undefined);
  }

  refresh(): Promise<void> {
    if (this.running) return this.running;
    const generation = this.generation;
    this.running = (async () => {
      const path = this.system.steamVRinstalled();
      const version = this.system.driverInstalled();
      if (this.system.installingDriver()) {
        this._status.set(undefined);
        return;
      }
      try {
        // Process status also protects Clean Settings before installation.
        // An absent path/version must not imply that SteamVR is stopped.
        const result = await get_galaxyxr_runtime_status(path || undefined, version ?? '');
        if (generation !== this.generation || this.system.installingDriver()
          || path !== this.system.steamVRinstalled() || version !== this.system.driverInstalled()) return;
        if (!result || typeof result.driverInitialized !== 'boolean' || typeof result.steamvrRunning !== 'boolean') {
          throw new Error('The backend returned an invalid runtime report. Rebuild and reinstall the complete package.');
        }
        this._status.set(result);
        this._error.set(undefined);
      } catch (error) {
        if (generation !== this.generation || this.system.installingDriver()
          || path !== this.system.steamVRinstalled() || version !== this.system.driverInstalled()) return;
        // Never keep an old green success indicator after an unsuccessful check.
        this._status.set(undefined);
        this._error.set(String(error));
      }
    })().finally(() => { this.running = undefined; });
    return this.running;
  }

  async start(): Promise<boolean> {
    if (this._launching() || this.system.installingDriver() || !this.system.driverInstalled()) return false;
    this._launching.set(true);
    this._error.set(undefined);
    try {
      // Do not start a second session merely because runtime output is late.
      await this.refresh();
      if (!this._status()?.steamvrRunning) {
        if (!await this.system.launchSteamVR()) throw new Error('SteamVR could not be started. Open SteamVR from Steam, then return here to check the driver.');
      }
      await this.refresh();
      return true; // Launch request only; the UI reads status.driverInitialized.
    } catch (error) {
      this._error.set(String(error));
      return false;
    } finally { this._launching.set(false); }
  }
}
