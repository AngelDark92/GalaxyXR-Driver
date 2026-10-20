// gui-settings.json service, ported from src/app/services/app-setting.service.ts.
// Preserves the on-disk keys, including the deliberate `advanceMode` spelling.
import { computed, signal } from '../reactive';
import type { AppSetting } from '../domain/types';
import { PathsService } from './paths';
import { JsonSettingServiceBase } from './settings-base';

const appDefaults: AppSetting = {
  // 2026-10-20: keep Companion-dependent Optical Flow alive when hidden.
  minimizeToTray: true,
  colorScheme: 'dark',
  // Interface scale (2026-10-19): native webview zoom, integer percent.
  // JsonSettingServiceBase deep-merges this default over older files.
  uiScale: 100,
  // Close button (2026-10-20): ask first, with Close as the default answer.
  // The title-bar Minimize button keeps its own tray behavior.
  closeButtonAction: 'ask',
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
  // Native lifecycle policy must never follow optimistic, uncommitted edits.
  private readonly confirmed = signal<AppSetting | undefined>(undefined);
  public readonly confirmedValues = this.confirmed.asReadonly();
  override async loadSetting(): Promise<boolean> {
    const loaded = await super.loadSetting();
    if (loaded) this.confirmed.set(this.verified && structuredClone(this.verified));
    else if (this.readFileError()) this.confirmed.set(undefined);
    return loaded;
  }
  override async save(values: AppSetting): Promise<boolean> {
    const saved = await super.save(values);
    if (saved) this.confirmed.set(this.verified && structuredClone(this.verified));
    return saved;
  }
  override clearAfterUninstall(): void {
    super.clearAfterUninstall();
    this.confirmed.set(this.verified && structuredClone(this.verified));
  }
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
