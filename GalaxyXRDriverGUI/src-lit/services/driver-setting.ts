// settings.json service, ported from src/app/services/driver-setting.service.ts.
import { exists, writeTextFile } from '@tauri-apps/plugin-fs';
import type { AppSetting, Settings } from '../domain/types';
import { PathsService } from './paths';
import { JsonSettingServiceBase } from './settings-base';
import { deepMerge, fillMissingDefaults, pruneUnstoredDefaults } from '../domain/pure';
import type { DriverInfoService } from './driver-info';
import { getDriverDefaultsForVendor } from '../domain/vendor-driver-defaults';
import { vendor } from '../environment';

export class DriverSettingService extends JsonSettingServiceBase<Settings> {
  private readonly pathService: PathsService;
  constructor(paths: PathsService, driverInfoService: DriverInfoService, appSettingGetter: () => AppSetting | undefined) {
    super(paths.settingPath, paths.appDataDirPath, () => {
      const bundled = getDriverDefaultsForVendor(vendor);
      const defaults = deepMerge(structuredClone(bundled), driverInfoService.values()?.defaultSettings ?? {});
      // 2026-10-01: stale telemetry must not change the master default or prune OFF.
      defaults.debugMode = bundled.debugMode;
      // 2026-09-26: telemetry can outlive an installed package. Encoder toggles
      // and sparse saves must use that package's native defaults, otherwise an
      // explicit Off can be pruned and return as On on the next native load.
      if (defaults.streamFrame) {
        Object.assign(defaults.streamFrame, Object.fromEntries(Object.entries(bundled.streamFrame ?? {})
          .filter(([key]) => key.startsWith('nvenc') || key === 'postPack')));
      }
      if (vendor === 'galaxyxr' && defaults.galaxyXr) {
        defaults.galaxyXr.nativeIdentity = true;
        defaults.galaxyXr.vrlinkHeadsetProfile = true;
      }
      // 2026-10-11: retired HAL timestamp compensation must not return from stale telemetry.
      for (const key of DriverSettingService.retiredStreamFrameKeys) {
        if (defaults.streamFrame) delete (defaults.streamFrame as any)[key];
      }
      return defaults;
    }, false, true, appSettingGetter);
    this.pathService = paths;
  }
  // Installation is sufficient to edit settings. info.json is runtime telemetry,
  // not an initialization prerequisite; generated defaults work before first run.
  public async ensureEditableSettings() {
    await this.pathService.ensureAllDirCreated();
    if (!await exists(this.filePath)) await writeTextFile(this.filePath, '{}');
    await this.refreshWatch();
    return this.loadSetting();
  }
  protected override serializeForSave(snapshot: Settings): string {
    // 2026-10-19: only leaves absent from the stored document are pruned.
    // A reinstall materializes defaults into settings.json, so later saves keep
    // them instead of silently reverting a new default to "not stored".
    return JSON.stringify(
      pruneUnstoredDefaults(snapshot, this.defaults ?? {}, this.storedValues() ?? {}), undefined, 4);
  }

  /**
   * Writes every effective value, including defaults inherited at load time, so
   * the stored document owns them and prune-on-save keeps them afterwards.
   * Returns false when no settings are loaded (nothing to materialize).
   */
  public async materializeDefaults(): Promise<boolean> {
    const stored = this.storedValues();
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return false;
    // 2026-10-19: use this build's bundled defaults, not the previous
    // installation's info.json telemetry, so a default that changed in the new
    // package is the value written. Existing stored values always win.
    const defaults = structuredClone(getDriverDefaultsForVendor(vendor));
    if (vendor === 'galaxyxr' && defaults.galaxyXr) defaults.galaxyXr.nativeIdentity = true;
    const snapshot = this.migrateLoadedValues(
      fillMissingDefaults(structuredClone(stored as Settings), defaults));
    await this.debouncedFileWriter.save(JSON.stringify(snapshot, undefined, 4));
    this.verified = structuredClone(snapshot);
    return this.loadSetting();
  }

  // migration: keys the driver has retired are deleted on load so the
  // next natural save writes a clean settings.json. Prune-on-save
  // incident 2026-08-11: the round-trip writer preserved a legacy
  // "velocityFix" bool for months; the default-diff serializer then
  // pruned the explicit velocityFixMode the moment it matched the new
  // published default, and the fossil took over mode selection.
  private static readonly retiredStreamFrameKeys = ['velocityFix', 'kalmanDupSkip', 'kalmanAdaptiveBoost', 'gameLinkLinearVelocityCutoff', 'gameLinkAngularVelocityCutoffDeg', 'poseTimeOffsetBiasMs', 'poseTimeOffsetBiasEnabled', 'nvencVrlinkFallbackMode'];
  protected override migrateLoadedValues(values: Settings): Settings {
    const sf = (values as any)?.streamFrame;
    if (sf) {
      // 2026-10-21: the retired No-fallback select is honoured once as Bitrate
      // Constancy 100 % before its key is pruned, so an upgraded install keeps
      // the encoder target on the Bandwidth row instead of reverting silently.
      if (sf.nvencVrlinkFallbackMode === 1 && sf.nvencBitrateConstancyPct !== 100) {
        sf.nvencBitrateConstancyPct = 100;
      }
      for (const key of DriverSettingService.retiredStreamFrameKeys) {
        if (key in sf) {
          delete sf[key];
        }
      }
    }
    return values;
  }
}
