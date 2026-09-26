// System diagnostics + driver install/enable/uninstall, ported from
// src/app/services/system-diagnostic.service.ts (Angular era).
// Behavior is preserved 1:1, including:
//  - generation-gated driver checks invalidated during install/uninstall
//  - suspendFileWrites around the native Galaxy XR install/uninstall
//  - legacy fork fingerprint cleanup (vrlink shaders only)
//  - the vendor lockout swap (disable neutral CustomHeadsetOpenVR,
//    enable the vendor driver) via the settings journal on Galaxy builds
//  - the finally-path driver enablement semantics (kept as observed;
//    the plan tracks "install finally enables after failure" as a known
//    corrective candidate, not changed here)
import { computed, signal } from '../reactive';
import { copyFile, remove, exists, mkdir, readDir, readTextFile, watchImmediate, writeTextFile } from '@tauri-apps/plugin-fs';
import { localDataDir, basename, join } from '@tauri-apps/api/path';
import type { DriverSettingService } from './driver-setting';
import type { AppSettingService } from './app-setting';
import type { DriverInfoService } from './driver-info';
import { get_executable_path, restart_vrcompositor, run_process_sync, register_galaxyxr_driver,
  uninstall_galaxyxr_driver, update_galaxyxr_steamvr_settings, DriverUninstallReport,
  clean_legacy_galaxyxr_identity, IdentityCleanupReport, clean_galaxyxr_settings, CleanSettingsReport } from '../platform/tauri';
import { galaxyXRDriverName, driverCopyInstallationMethod, vendor } from '../environment';
import { open } from '@tauri-apps/plugin-dialog';
import { DialogService } from './dialog';
import { PullingService } from './pulling';
import { cleanJsonComments } from '../domain/pure';
import { suspendFileWrites, resumeFileWrites } from '../platform/writer';
import { steamVRSettingsDiff, launch_process } from '../platform/tauri';
import { PathsService } from './paths';
import { openUrl } from '@tauri-apps/plugin-opener';
import { t } from '../locale/i18n';

export class SystemDiagnosticService {
  private _installingDriver = signal(false)
  public readonly installingDriver = this._installingDriver.asReadonly()
  public lastUninstallReport: DriverUninstallReport | undefined;
  private driverDataRemoved = false;
  private _steamVRinstalled = signal<string | undefined>(undefined);
  public readonly steamVRinstalled = this._steamVRinstalled.asReadonly();
  private _driverInstalled = signal<string | undefined>(undefined);
  public readonly driverInstalled = this._driverInstalled.asReadonly();
  public readonly settingFileInited = computed(() => !!this.dss.values() && !this.dss.readFileError());
  public readonly systemReady = computed(() => !!this.steamVRinstalled() && !!this.driverInstalled() && this.settingFileInited());
  private readonly neutralDriverInstalled = signal(false);
  private installationGeneration = 0;
  private inspectionIssues: string[] = [];
  private _driverCheckError = signal<string | undefined>(undefined);
  public readonly driverCheckError = this._driverCheckError.asReadonly();
  private _driverState = signal<'checking' | 'installed' | 'not-installed' | 'unknown'>('checking');
  public readonly driverState = this._driverState.asReadonly();
  private _steamVRsettingsError = signal<string | undefined>(undefined);
  public readonly steamVRsettingsError = this._steamVRsettingsError.asReadonly();
  private readonly activeDriverChecks = new Set<Promise<boolean>>();
  public readonly driverVersionMismatch = computed(() => {
    const installed = this.driverInstalled();
    const lastRun = this.dis.values()?.driverVersion;
    return !!installed && !!lastRun && installed !== lastRun;
  });
  private _steamVrConfig = signal<any>(undefined);
  public readonly steamVrConfig = this._steamVrConfig.asReadonly();
  private _initTask: Promise<any>;
  public get initTask() {
    return this._initTask;
  }
  public readonly pullingSteamVRinstall = new PullingService(() => this.checkSteamVrInstalled(), 'pullingSteamVRinstallk');
  // (2026-09-22) The per-second driver-install polling loop was removed: every
  // tick reset driverState to 'checking', flipping the Setup "Not installed"
  // label to "Checking…" and back — the unreadable one-frame flicker. The
  // driver install check now runs only on demand: app start (initTask below),
  // the "Check installation" button (settings-check.ts), and the install /
  // clean-settings / uninstall flows in this file.
  constructor(public dss: DriverSettingService, public dis: DriverInfoService, private dialog: DialogService, private paths: PathsService) {
    this._initTask = (async () => {
      await Promise.all([dss.initTask, dis.initTask]);
      await this.checkDriverInstalled();
      await this.watchSteamVRSettings();
    })();
  }
  private watchedSteamVRConfig?: string;
  private unwatchSteamVRConfig?: () => void;
  public async refreshSteamVRSettings(): Promise<boolean> {
    try {
      const settings = await this.getSteamVRSettings();
      this._steamVrConfig.set(settings);
      this._steamVRsettingsError.set(settings === undefined ? 'The SteamVR configuration path is unavailable' : undefined);
      return settings !== undefined;
    } catch (error) {
      this._steamVrConfig.set(undefined);
      this._steamVRsettingsError.set(String(error));
      return false;
    }
  }
  async watchSteamVRSettings(): Promise<void> {
    try {
      const directory = await this.getSteamVRConfigDirPath();
      if (directory !== this.watchedSteamVRConfig) {
        this.unwatchSteamVRConfig?.();
        this.unwatchSteamVRConfig = undefined;
        this.watchedSteamVRConfig = undefined;
        if (directory) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const unwatch = await watchImmediate(directory, () => {
              if (timer !== undefined) clearTimeout(timer);
              timer = setTimeout(() => { if (!this.installing) void this.refreshSteamVRSettings(); }, 50);
            });
            this.unwatchSteamVRConfig = () => { unwatch(); if (timer !== undefined) clearTimeout(timer); };
            this.watchedSteamVRConfig = directory;
          } catch (error) {
            if (timer !== undefined) clearTimeout(timer);
            console.warn('Cannot watch SteamVR settings; manual checks remain available', error);
          }
        }
      }
    } catch (error) {
      console.warn('Cannot locate SteamVR settings', error);
    }
    // Always read, even when the watch is already attached to this directory.
    await this.refreshSteamVRSettings();
  }
  dispose(): void {
    this.pullingSteamVRinstall.stop();
    this.unwatchSteamVRConfig?.();
  }

  private async inspectDriverPackage(path: string, name = galaxyXRDriverName): Promise<string | undefined> {
    if (!path) return undefined;
    try {
      const manifestPath = await join(path, 'driver.vrdrivermanifest');
      if (!await exists(manifestPath)) return undefined;
      const manifest = JSON.parse(cleanJsonComments(await readTextFile(manifestPath)));
      if (manifest.name !== name || !await exists(await join(path, 'bin', 'win64', `driver_${name}.dll`))) return undefined;
      return typeof manifest.version === 'string' && manifest.version ? manifest.version : '0.0.0';
    } catch (error) {
      this.inspectionIssues.push(`${path}: ${String(error)}`);
      return undefined;
    }
  }
  public async checkDriverInstalled(force = false, readOnly = false): Promise<boolean> {
    if (this.installing && !force) return !!this._driverInstalled();
    const generation = this.installationGeneration;
    const task = navigator.locks.request('custom-headset-driver-inspection', async () => {
      if (generation !== this.installationGeneration) return false;
      this.inspectionIssues = [];
      this._driverCheckError.set(undefined);
      this._driverState.set('checking');
      try {
        const installed = await this.inspectInstalledDriver(generation, readOnly);
        if (generation === this.installationGeneration) {
          const issues = this.inspectionIssues.join('\n');
          this._driverCheckError.set(issues || undefined);
          this._driverState.set(installed ? 'installed' : issues ? 'unknown' : 'not-installed');
        }
        return installed;
      } catch (error) {
        if (generation === this.installationGeneration) {
          this._driverInstalled.set(undefined);
          this._driverCheckError.set(String(error));
          this._driverState.set('unknown');
        }
        return false;
      }
    });
    this.activeDriverChecks.add(task);
    try { return await task; }
    finally { this.activeDriverChecks.delete(task); }
  }
  private async drainDriverChecks() {
    // Invalidate reads before waiting. In-flight settings initialization must
    // finish before uninstall deletes its directory; cancellation alone cannot
    // undo a filesystem write that already started.
    ++this.installationGeneration;
    await Promise.allSettled([...this.activeDriverChecks]);
  }
  private async inspectInstalledDriver(generation: number, readOnly = false) {
    const current = () => generation === this.installationGeneration;
    const steamVrPath = await this.checkSteamVrInstalled();
    if (!current()) return false;
    if (steamVrPath) {
      const copied = await join(steamVrPath, 'drivers', galaxyXRDriverName);
      const registered = await this.checkDriverRegisteredPath();
      const version = await this.inspectDriverPackage(copied) ?? await this.inspectDriverPackage(registered);
      const neutral = await this.inspectDriverPackage(await join(steamVrPath, 'drivers', 'CustomHeadsetOpenVR'), 'CustomHeadsetOpenVR')
        ?? await this.inspectDriverPackage(await this.checkDriverRegisteredPath('CustomHeadsetOpenVR'), 'CustomHeadsetOpenVR');
      if (!current()) return false;
      if (version) {
        const wasInstalled = !!this._driverInstalled();
        // Recreate editable configuration only for a verified installation.
        if (!readOnly && !this.dss.inspecting && (!wasInstalled || !this.dss.values())) await this.dss.ensureEditableSettings();
        if (!current()) return false;
        await this.watchSteamVRSettings();
        if (!current()) return false;
        this.neutralDriverInstalled.set(!!neutral);
        this._driverInstalled.set(version);
        return true;
      }
    }
    if (!current()) return false;
    this._driverInstalled.set(undefined);
    this.neutralDriverInstalled.set(false);
    return false;
  }
  public async getOpenvrpaths() {
    const filename = await join(await localDataDir(), 'openvr', 'openvrpaths.vrpath');
    if (!await exists(filename)) return undefined;
    // Do not turn denied access or malformed JSON into "not installed".
    const paths = JSON.parse(cleanJsonComments(await readTextFile(filename)));
    if (!paths || typeof paths !== 'object' || Array.isArray(paths)) throw new Error(`Invalid OpenVR paths file: ${filename}`);
    return paths;
  }
  public async disableSteamVRDriver(driverName: string) {
    await this.updateSteamVRSettings(settings => {
      const name = this.getDriverFieldName(driverName);
      if (!settings[name]) {
        settings[name] = {}
      }
      settings[name]['enable'] = false
      return true;
    })
  }
  public async enableSteamVRDriver(driverName: string) {
    await this.updateSteamVRSettings(settings => {
      const name = this.getDriverFieldName(driverName);
      if (!settings[name]) {
        settings[name] = {}
      }
      settings[name]['enable'] = true
      delete settings[name]['blocked_by_safe_mode']
      return true;
    })
  }
  public async unblockAllDrivers() {
    await this.updateSteamVRSettings(settings => {
      let changed = false;
      for (const key in settings) {
        if (key.startsWith('driver_') && settings[key]) {
          if (settings[key]['blocked_by_safe_mode']) {
            delete settings[key]['blocked_by_safe_mode'];
            changed = true;
          }
        }
      }
      return changed;
    })
  }
  public getSteamVRDriverEnableState(settings: any, driverName: string) {
    if (settings) {
      const driverSetting = settings[this.getDriverFieldName(driverName)]
      if (driverSetting) {
        return (driverSetting['enable'] ?? true) && !(driverSetting['blocked_by_safe_mode'] ?? false);
      }
    }
    return true;
  }
  public isDriverBlocked(settings: any, driverName: string) {
    return !!settings?.[this.getDriverFieldName(driverName)]?.blocked_by_safe_mode;
  }
  private getDriverFieldName(driverName: string) {
    return `driver_${driverName}`;
  }
  /**
   * For vendor-specific drivers: whether the vendor-neutral CustomHeadsetOpenVR
   * driver is enabled (which locks this vendor driver out).
   */
  public getNeutralDriverEnabled(settings: any): boolean {
    if (!settings || !this.neutralDriverInstalled()) {
      return false;
    }
    const neutralDriverKey = this.getDriverFieldName('CustomHeadsetOpenVR');
    const driverSetting = settings[neutralDriverKey];
    if (!driverSetting) {
      // An installed OpenVR driver defaults to enabled without an override.
      return true;
    }
    if (driverSetting['blocked_by_safe_mode']) {
      return false;
    }
    return driverSetting['enable'] ?? true;
  }
  /**
   * For vendor-specific drivers: disable the neutral driver and enable the vendor driver.
   * This implements the driver lockout swap behavior.
   */
  public async enableVendorDriverAndDisableNeutral() {
    await this.updateSteamVRSettings(settings => {
      let changed = false;
      // Disable the vendor-neutral driver
      const neutralKey = this.getDriverFieldName('CustomHeadsetOpenVR');
      if (!settings[neutralKey]) {
        settings[neutralKey] = {};
      }
      if (settings[neutralKey]['enable'] !== false) {
        settings[neutralKey]['enable'] = false;
        changed = true;
      }
      // Enable the vendor-specific driver
      const vendorKey = this.getDriverFieldName(galaxyXRDriverName);
      if (!settings[vendorKey]) {
        settings[vendorKey] = {};
      }
      if (settings[vendorKey]['enable'] !== true) {
        settings[vendorKey]['enable'] = true;
        changed = true;
      }
      delete settings[vendorKey]['blocked_by_safe_mode'];
      return changed;
    });
  }
  private installing = false
  async installDriver() {
    if (this.installing) return false;
    const steamVrPath = this.steamVRinstalled();
    if (!steamVrPath) {
      // Previously a silent no-op: the Setup page Install button did nothing
      // when SteamVR could not be located, leaving the user with no feedback.
      // Surface the reason (and how to resolve it) instead of failing silently.
      await this.dialog.message(t('SteamVR not installed'), t('The driver install needs a SteamVR installation. If SteamVR is already installed, launch it once (this registers its OpenVR paths) and then retry. Install SteamVR from Steam, launch it once, then return to Setup and check again.'));
      return false;
    }
    this._installingDriver.set(true);
    this.installing = true
    let installedSuccessfully = false;
    try {
      await this.drainDriverChecks();
      let driverDir = await join(await get_executable_path(), `../${galaxyXRDriverName}`);
      if (!await exists(driverDir)) {
        if (await this.dialog.confirm(t('Driver folder not found'), t('The driver folder was not found next to the app. Extract the complete portable package and try again, or choose the driver folder containing driver.vrdrivermanifest (GalaxyXRNative for the Galaxy XR package).'), t('Locate'), 'primary')) {
          const path = await open({ directory: true, multiple: false })
          if (path) {
            driverDir = path;
          } else {
            return false;
          }
        } else {
          return false;
        }
      }
      if (await exists(await join(driverDir, 'driver.vrdrivermanifest'))) {
        if (vendor === 'galaxyxr') {
          // Upgrades retain the original settings journal and all owned package
          // paths. Uninstalling first would erase recovery data and the source.
          await suspendFileWrites();
          await register_galaxyxr_driver(steamVrPath, driverDir);
          await this.paths.ensureAllDirCreated();
          this.driverDataRemoved = false;
          resumeFileWrites();
          await this.dss.ensureEditableSettings();
          await this.dis.refreshWatch();
          await this.dis.loadSetting();
          if (!await this.checkDriverInstalled(true)) throw new Error('Driver registration could not be verified');
          await this.watchSteamVRSettings();
          this._steamVrConfig.set(await this.getSteamVRSettings());
          installedSuccessfully = true;
          return true;
        }
        // Remove any previous install of this driver first (copied or registered)
        if (!await this.uninstallLegacyDriver(steamVrPath)) return false;
        // Vendor builds: also remove legacy copies of this fork that were
        // installed under the CustomHeadsetOpenVR name (issue #1)
        if (vendor) {
          await this.cleanupLegacyForkInstall(steamVrPath);
        }
        if (driverCopyInstallationMethod) {
          // Copy driver into SteamVR drivers folder (vendor-neutral behavior)
          const steamVrDriverDir = await join(steamVrPath, 'drivers');
          if (!await exists(steamVrDriverDir)) {
            await mkdir(steamVrDriverDir)
          }
          const driverPath = await join(steamVrDriverDir, galaxyXRDriverName);
          try {
            await this.copyRec(driverPath, driverDir)
          } catch (e) {
            await this.dialog.message(t('Install Failed, Make sure SteamVR is closed'), `${e}`)
            return false
          }
        } else {
          // Register driver in place using vrpathreg (vendor build behavior)
          try {
            const success = await this.registerDriver(steamVrPath, driverDir);
            if (!success) {
              await this.dialog.message(t('Install Failed'), t('Failed to register driver using vrpathreg. Make sure SteamVR is installed and closed.'))
              return false;
            }
          } catch (e) {
            await this.dialog.message(t('Install Failed, Make sure SteamVR is closed'), `${e}`)
            return false
          }
        }
        await this.checkDriverInstalled(true)
        installedSuccessfully = true;
        return true;
      } else {
        await this.dialog.message(t('Driver files not valid'), t('the folder seems not include driver file, please check again'))
        return false;
      }
    } catch (e) {
      if (!this.driverDataRemoved) resumeFileWrites();
      await this.dialog.message(t('Install Failed'), `${e}`);
      return false;
    } finally {
      try {
        if (installedSuccessfully && vendor !== 'galaxyxr') await this.enableSteamVRDriver(galaxyXRDriverName);
      } finally {
        this.installing = false;
        this._installingDriver.set(false);
      }
    }
  }
  async cleanSettings(app: AppSettingService): Promise<CleanSettingsReport | undefined> {
    if (this.installing || this.dss.inspecting || app.inspecting) return undefined;
    if (vendor !== 'galaxyxr') {
      await this.dialog.message(t('Clean Settings'), t('Use the Galaxy XR build to clean Galaxy XR settings. No files were changed.'));
      return undefined;
    }
    this.installing = true;
    this._installingDriver.set(true);
    let suspended = false;
    let completed: CleanSettingsReport | undefined;
    try {
      if (!await this.dialog.confirm(t('Clean Settings?'), t('Close SteamVR completely first. This resets all Companion-controlled driver settings to their defaults: headset and controller tuning, color, image enhancements, encoder overrides, and active distortion/calibration choices. Unsaved edits are discarded. App preferences, such as the color scheme, are kept.\n\nRecorded SteamVR changes are restored to their previous values (or removed to use SteamVR defaults). Recognized old identity settings are cleaned. Other SteamVR settings, room setup, game bindings, installed drivers and saved profile files are kept. Driver enable/block choices are not changed.\n\nA recovery backup is created before any file is changed. You can clean before installing. After installing or cleaning, start SteamVR from Setup to initialize and verify the driver.') + '\n\n' + t('Clean Settings leaves NVENC Tap and encoder overrides off for stock NVIDIA encoding. Other driver settings return to their defaults. Enable NVENC Tap and reset the encoder controls to use the installation defaults again.'), t('Clean Settings'), 'danger')) return undefined;
      await this.drainDriverChecks();
      app.inspecting = this.dss.inspecting = this.dis.inspecting = true;
      suspended = true;
      await suspendFileWrites();
      const report = completed = await clean_galaxyxr_settings(this.steamVRinstalled());
      this.driverDataRemoved = false;
      // Clear old runtime defaults first, then reload the reset configuration.
      await this.dis.loadSetting();
      const appLoaded = await app.reloadAfterReset();
      const driverLoaded = await this.dss.reloadAfterReset();
      await Promise.all([app.refreshWatch(), this.dss.refreshWatch(), this.dis.refreshWatch()]);
      if (!appLoaded || !driverLoaded) report.warnings.push('The reset completed, but a settings file could not be reloaded. Use Check installation after resolving its permissions.');
      if (this.steamVRinstalled()) await this.watchSteamVRSettings();
      // Keep installation detection separate from the fact that defaults exist.
      await this.checkDriverInstalled(true, true);
      await Promise.resolve();
      return report;
    } catch (error) {
      if (completed) {
        completed.warnings.push(`The reset completed, but automatic UI refresh failed: ${String(error)}. Use Check installation, or reopen the application.`);
        return completed;
      }
      if (suspended) {
        // Pending optimistic edits were cancelled; show the unchanged disk
        // state again instead of leaving uncommitted switches on screen.
        await this.dis.loadSetting();
        await Promise.allSettled([app.loadSetting(), this.dss.loadSetting()]);
      }
      await this.dialog.message(t('Clean Settings failed'), String(error));
      return undefined;
    } finally {
      app.inspecting = this.dss.inspecting = this.dis.inspecting = false;
      if (suspended && !this.driverDataRemoved) resumeFileWrites();
      this.installing = false;
      this._installingDriver.set(false);
    }
  }

  async cleanOlderIdentitySettings(): Promise<IdentityCleanupReport | undefined> {
    if (this.installing) return undefined;
    const steamVrPath = this.steamVRinstalled();
    if (!steamVrPath) return undefined;
    this.installing = true;
    this._installingDriver.set(true);
    try {
      const report = await clean_legacy_galaxyxr_identity(steamVrPath);
      try { this._steamVrConfig.set(await this.getSteamVRSettings()); }
      catch (error) { console.warn('Identity cleanup succeeded, but settings refresh failed', error); }
      return report;
    } catch (error) {
      await this.dialog.message('Identity cleanup failed', `${error}`);
      return undefined;
    } finally {
      this.installing = false;
      this._installingDriver.set(false);
    }
  }

  async uninstallDriver() {
    if (this.installing) return false;
    const steamVrPath = this.steamVRinstalled();
    if (!steamVrPath) return false;
    this.installing = true;
    this._installingDriver.set(true);
    this.lastUninstallReport = undefined;
    try {
      await this.drainDriverChecks();
      if (vendor === 'galaxyxr') {
        await suspendFileWrites();
        this.lastUninstallReport = await uninstall_galaxyxr_driver(steamVrPath);
        this.driverDataRemoved = true;
        this._driverInstalled.set(undefined);
        await this.dss.loadSetting();
        await this.dis.loadSetting();
        return true;
      }
      return await this.uninstallLegacyDriver(steamVrPath);
    } catch (e) {
      if (!this.driverDataRemoved) resumeFileWrites();
      await this.dialog.message(t('Uninstall Failed'), `${e}`);
      return false;
    } finally {
      this.installing = false;
      this._installingDriver.set(false);
    }
  }
  private async uninstallLegacyDriver(steamVrPath: string) {
    // Remove copied driver from SteamVR drivers folder (if exists)
    const driverPath = await join(steamVrPath, 'drivers', galaxyXRDriverName);
    if (await exists(driverPath)) {
      try{
        await remove(driverPath, {recursive: true});
      } catch(e){
        await this.dialog.message(t('Uninstall Failed, Make sure SteamVR is closed'), `${e}`)
        return false;
      }
    }
    // Also unregister any in-place registered driver using vrpathreg
    try {
      await this.unregisterDriver(steamVrPath);
    } catch(e) {
      await this.dialog.message(t('Uninstall Failed'), `${e}`);
      return false;
    }
    return !await this.checkDriverInstalled(true);
  }
  /**
   * Check if the driver is registered in-place via openvrpaths external_drivers.
   * Returns the registered driver directory, or "" when not registered.
   */
  public async checkDriverRegisteredPath(name = galaxyXRDriverName): Promise<string> {
    try {
      const openvrpaths = await this.getOpenvrpaths();
      if (!openvrpaths || !openvrpaths.external_drivers) {
        return "";
      }
      const drivers = openvrpaths.external_drivers;
      if (Array.isArray(drivers)) {
        for (const driverPath of drivers) {
          if (typeof driverPath === 'string' && await this.inspectDriverPackage(driverPath, name)) return driverPath;
        }
      }
      return "";
    } catch (e) {
      console.warn('Failed to check driver registration from openvrpaths:', e);
      return "";
    }
  }
  /**
   * Legacy installs of this fork were copied into SteamVR/drivers under the
   * name CustomHeadsetOpenVR, colliding with the upstream vendor-neutral
   * driver of the same name. Detect such an install by its fingerprint (the
   * vrlink shaders only this fork ships) and remove it. A genuine upstream
   * CustomHeadsetOpenVR install can never match the fingerprint and is never
   * touched. Runs only in vendor builds, during install.
   */
  public async cleanupLegacyForkInstall(steamVrPath: string): Promise<void> {
    const isForkInstall = async (dir: string): Promise<boolean> => {
      try {
        const manifestPath = await join(dir, 'driver.vrdrivermanifest');
        if (!await exists(manifestPath)) return false;
        const manifest = JSON.parse(cleanJsonComments(await readTextFile(manifestPath)));
        if (manifest['name'] !== 'CustomHeadsetOpenVR') return false;
        // fingerprint: both fork-only shaders must be present
        const fp1 = await join(dir, 'resources', 'shaders', 'd3d11', 'vrlink_layer_ps.hlsl');
        const fp2 = await join(dir, 'resources', 'shaders', 'd3d11', 'vrlink_fxaa_ps.hlsl');
        return await exists(fp1) && await exists(fp2);
      } catch (e) {
        console.warn('Fingerprint check failed for', dir, e);
        return false;
      }
    };
    // 1. Copied install in SteamVR/drivers/CustomHeadsetOpenVR
    try {
      const copiedPath = await join(steamVrPath, 'drivers', 'CustomHeadsetOpenVR');
      if (await exists(copiedPath) && await isForkInstall(copiedPath)) {
        console.log('Removing legacy fork install at', copiedPath);
        await remove(copiedPath, { recursive: true });
      }
    } catch (e) {
      console.warn('Failed to remove legacy copied fork install:', e);
    }
    // 2. Registered external driver dirs named CustomHeadsetOpenVR with the fingerprint:
    // surgically drop only those entries from openvrpaths.external_drivers
    // (removedriverswithname would also remove a genuine upstream registration)
    try {
      const openvrpaths = await this.getOpenvrpaths();
      const drivers = openvrpaths?.external_drivers;
      if (Array.isArray(drivers)) {
        const keep: string[] = [];
        let removedAny = false;
        for (const driverPath of drivers) {
          const lastFolder = await basename(driverPath);
          if (lastFolder === 'CustomHeadsetOpenVR' && await isForkInstall(driverPath)) {
            console.log('Unregistering legacy fork install at', driverPath);
            removedAny = true;
            continue;
          }
          keep.push(driverPath);
        }
        if (removedAny) {
          openvrpaths.external_drivers = keep;
          const openVrConfigPath = await join(await localDataDir(), 'openvr', 'openvrpaths.vrpath');
          await writeTextFile(openVrConfigPath, JSON.stringify(openvrpaths, undefined, 1).replaceAll('  ', '\t'));
        }
      }
    } catch (e) {
      console.warn('Failed to unregister legacy fork install:', e);
    }
  }
  private async getVrpathregPath(steamVrPath: string): Promise<string | undefined> {
    // this fork's GUI targets Windows only
    const vrpathregPath = await join(steamVrPath, 'bin', 'win64', 'vrpathreg.exe');
    if (!await exists(vrpathregPath)) {
      return undefined;
    }
    return vrpathregPath;
  }
  /**
   * Register driver in place using vrpathreg adddriver.
   * Verifies the driver directory name matches the expected driver name before registering.
   */
  private async registerDriver(steamVrPath: string, driverDir: string): Promise<boolean> {
    const vrpathregPath = await this.getVrpathregPath(steamVrPath);
    if (!vrpathregPath) {
      return false;
    }
    const lastFolder = await basename(driverDir);
    if (lastFolder !== galaxyXRDriverName) {
      console.warn(`Driver directory name "${lastFolder}" does not match expected "${galaxyXRDriverName}". Refusing to register.`);
      return false;
    }
    const exitCode = await run_process_sync(vrpathregPath, ['adddriver', driverDir]);
    return exitCode === 0;
  }
  /**
   * Unregister driver in place using vrpathreg removedriverswithname.
   */
  private async unregisterDriver(steamVrPath: string): Promise<void> {
    const vrpathregPath = await this.getVrpathregPath(steamVrPath);
    if (!vrpathregPath) {
      throw new Error('SteamVR driver registration tool is missing');
    }
    const registered = await this.checkDriverRegisteredPath();
    if (registered) {
      const exitCode = await run_process_sync(vrpathregPath, ['removedriver', registered]);
      if (exitCode !== 0) throw new Error(`Driver unregister failed (${exitCode})`);
    }
  }
  private async copyRec(targetDir: string, sourceDir: string) {
    if (!await exists(targetDir)) {
      await mkdir(targetDir)
    }
    const content = await readDir(sourceDir);
    for (const e of content) {
      if (e.isFile) {
        await copyFile(await join(sourceDir, e.name), await join(targetDir, e.name));
      } else if (e.isDirectory) {
        await this.copyRec(await join(targetDir, e.name), await join(sourceDir, e.name));
      }
    }
  }
  /**
   * 
   * @param update return true to save
   */
  public async updateSteamVRSettings(update: (steamVrSettings: any) => boolean) {
    if (this.driverDataRemoved || (vendor === 'galaxyxr' && this.installing)) {
      throw new Error('Driver installation changes are in progress or the driver was uninstalled');
    }
    const settings = await this.getSteamVRSettings();
    if (settings) {
      const original = structuredClone(settings);
      const path = await this.getSteamVRConfigFilePath();
      if (update(settings) && path) {
        if (vendor === 'galaxyxr') {
          const steamVrPath = this.steamVRinstalled();
          if (!steamVrPath) throw new Error('SteamVR is not installed');
          await update_galaxyxr_steamvr_settings(steamVrPath, steamVRSettingsDiff(original, settings));
        } else {
          await writeTextFile(path, JSON.stringify(settings, undefined, 4))
        }
        await this.refreshSteamVRSettings();
      }
    }
  }
  public async getSteamVRSettings() {
    const path = await this.getSteamVRConfigFilePath();
    if (path) {
      const settings = await exists(path) ? JSON.parse(cleanJsonComments(await readTextFile(path))) : {};
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error(`Invalid SteamVR settings: ${path}`);
      for (const [name, section] of Object.entries(settings)) {
        if (!name.startsWith('driver_')) continue;
        if (!section || typeof section !== 'object' || Array.isArray(section)) throw new Error(`Invalid driver section: ${name}`);
        for (const flag of ['enable', 'blocked_by_safe_mode']) {
          const value = (section as Record<string, unknown>)[flag];
          if (value !== undefined && typeof value !== 'boolean') throw new Error(`${name}.${flag} must be true or false`);
        }
      }
      return settings;
    }
  }
  public async getSteamVRConfigFilePath(): Promise<string | undefined> {
    const dirPath = await this.getSteamVRConfigDirPath()
    if (dirPath) {
      return await join(dirPath, 'steamvr.vrsettings')
    }
    return undefined;
  }
  public async getSteamVRConfigDirPath(): Promise<string | undefined> {
    const openvrpaths = await this.getOpenvrpaths();
    if (openvrpaths) {
      const path = openvrpaths?.['config'];
      if (path && typeof path == 'object' && Array.isArray(path)) {
        const configFolderPath = path[0];
        if (configFolderPath) {
          return configFolderPath;
        }
      }
    }
    return undefined;
  }
  public async checkSteamVrInstalled(): Promise<string | undefined> {
    const openvrpaths = await this.getOpenvrpaths();
    const runtime = openvrpaths?.['runtime'];
    if (runtime && typeof runtime == 'object' && Array.isArray(runtime)) {
      for (const steamVrPath of runtime) {
        if (typeof steamVrPath !== 'string') continue;
        // OpenVR permits a renamed runtime directory. Verify its executables,
        // not the spelling/case of the install folder or optional version.txt.
        if (await exists(await join(steamVrPath, 'bin', 'win64', 'vrserver.exe')) &&
            await exists(await join(steamVrPath, 'bin', 'win64', 'vrpathreg.exe'))) {
          this._steamVRinstalled.set(steamVrPath);
          this.pullingSteamVRinstall.stop();
          return steamVrPath;
        }
      }
    }    this._steamVRinstalled.set(undefined);
    return undefined;
  }
  public async resetDriverSetting() {
    if (this.installing || this.driverDataRemoved) return;
    await writeTextFile(this.dss.filePath, "{}");
    await this.dss.loadSetting();
  }
  public async restartCompositor() {
    if (this.installing) return false;
    return await restart_vrcompositor()
  }
  public async launchSteamVR(): Promise<boolean> {
    if (this.installing) return false;
    // Use the registered SteamVR runtime first, including non-default drives.
    const runtime = this.steamVRinstalled();
    const paths = runtime ? [await join(runtime, 'bin', 'win64', 'vrstartup.exe')] : [];
    paths.push(
      'C:/Program Files (x86)/Steam/steamapps/common/SteamVR/bin/win64/vrstartup.exe',
      'C:/Program Files/Steam/steamapps/common/SteamVR/bin/win64/vrstartup.exe',
    );
    for (const path of [...new Set(paths)]) {
      try { if (await launch_process(path, [])) return true; }
      catch (error) { console.warn('SteamVR executable launch failed', error); }
    }
    try { await openUrl('steam://rungameid/250820'); return true; }
    catch (error) { console.warn('SteamVR launch request failed', error); return false; }
  }
}
