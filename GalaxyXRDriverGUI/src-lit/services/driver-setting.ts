// settings.json service, ported from src/app/services/driver-setting.service.ts.
import { exists, writeTextFile } from '@tauri-apps/plugin-fs';
import type { AppSetting, Settings } from '../domain/types';
import { PathsService } from './paths';
import { JsonSettingServiceBase } from './settings-base';
import { deepMerge } from '../domain/pure';
import type { DriverInfoService } from './driver-info';
import { getDriverDefaultsForVendor } from '../domain/vendor-driver-defaults';
import { vendor } from '../environment';

export class DriverSettingService extends JsonSettingServiceBase<Settings> {
  private readonly pathService: PathsService;
  constructor(paths: PathsService, driverInfoService: DriverInfoService, appSettingGetter: () => AppSetting | undefined) {
    super(paths.settingPath, paths.appDataDirPath, () => {
      const bundled = getDriverDefaultsForVendor(vendor);
      const defaults = deepMerge(structuredClone(bundled), driverInfoService.values()?.defaultSettings ?? {});
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
  // migration: keys the driver has retired are deleted on load so the
  // next natural save writes a clean settings.json. Prune-on-save
  // incident 2026-08-11: the round-trip writer preserved a legacy
  // "velocityFix" bool for months; the default-diff serializer then
  // pruned the explicit velocityFixMode the moment it matched the new
  // published default, and the fossil took over mode selection.
  private static readonly retiredStreamFrameKeys = ['velocityFix', 'kalmanDupSkip', 'kalmanAdaptiveBoost'];
  protected override migrateLoadedValues(values: Settings): Settings {
    const sf = (values as any)?.streamFrame;
    if (sf) {
      for (const key of DriverSettingService.retiredStreamFrameKeys) {
        if (key in sf) {
          delete sf[key];
        }
      }
    }
    return values;
  }
}
