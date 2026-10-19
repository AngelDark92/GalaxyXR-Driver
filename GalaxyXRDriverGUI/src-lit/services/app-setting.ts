// gui-settings.json service, ported from src/app/services/app-setting.service.ts.
// Preserves the on-disk keys, including the deliberate `advanceMode` spelling.
import { computed } from '../reactive';
import type { AppSetting } from '../domain/types';
import { PathsService } from './paths';
import { JsonSettingServiceBase } from './settings-base';

const appDefaults: AppSetting = {
  colorScheme: 'dark',
  updateMode: 'rewrite',
  advanceMode: false,
  // 2026-10-13: the dev (pre-release) update channel is opt-in; the stable
  // release channel stays the default.
  devUpdates: false,
  // A new installation or explicit reset requires fresh runtime verification.
  driverVerified: false,
  // OFXR Bridge (2026-10-17): disabled until the managed component reports
  // ready; every value is written through appSetting.save and ofxr_apply.
  // JsonSettingServiceBase deep-merges these nested defaults over older
  // gui-settings.json files, and migrateLoadedValues keeps the block.
  ofxr: {
    enabled: false,
    version: '',
    mode: 'fidelityfx',
    scale: 50,
    bidirectional: false,
    logging: false,
    maxLogMb: 32,
    flushEachEvent: false,
    overlay: 'off'
  }
};

export class AppSettingService extends JsonSettingServiceBase<AppSetting> {
  public allowEditsAfterUninstall(): void { this.debouncedFileWriter.allowCurrentSuspension(); }
  // 2026-09-26: missing preferences use defaults in memory. Opening Companion
  // after Uninstall must not recreate removed settings.
  public readonly values = computed(() => this._values() ?? { ...appDefaults });
  protected override normalizeStoredValues(values: unknown): unknown {
    // Older autoCreate wrote JSON.stringify('{}') into gui-settings.json.
    // Accept only that exact empty sentinel; other non-object JSON is invalid.
    return values === '{}' ? {} : values;
  }
  protected override migrateLoadedValues(values: AppSetting): AppSetting {
    const clean = { ...values } as AppSetting & Record<string, unknown>;
    for (const key of ['defaultSettingsTab', 'showIncompatibleProfiles']) delete clean[key];
    return clean;
  }
  constructor(paths: PathsService) {
    super(paths.guiSettingPath, paths.appDataDirPath, () => ({ ...appDefaults }), true, true, () => this.values());
  }
}
