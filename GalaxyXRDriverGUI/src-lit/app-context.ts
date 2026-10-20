// Application composition root (Lit frontend, 2026-09-20 migration).
// Services are constructed ONCE here (replacing Angular's root providers +
// per-component injections) and shared by all pages. This removes the old
// per-page duplicate watchers/effects: one GalaxySettingsBase instance,
// one settings store, one diagnostic watcher set.
import { PathsService } from './services/paths';
import { AppSettingService } from './services/app-setting';
import { DriverInfoService } from './services/driver-info';
import { DriverSettingService } from './services/driver-setting';
import { SystemDiagnosticService } from './services/system-diagnostic';
import { AppUpdateService } from './services/app-update';
import { DialogService } from './services/dialog';
import { DriverStartupService } from './services/driver-startup';
import { SettingsCheckService } from './services/settings-check';
import { GalaxySettingsBase } from './state/galaxy-settings';
import { CurvePreviewPublisher, previewState } from './services/curve-preview';
import { CompanionLifecycleService } from './services/companion-lifecycle';

export interface AppContext {
  paths: PathsService;
  appSetting: AppSettingService;
  dis: DriverInfoService;
  dss: DriverSettingService;
  sds: SystemDiagnosticService;
  aus: AppUpdateService;
  dialog: DialogService;
  galaxy: GalaxySettingsBase;
  checks: SettingsCheckService;
  startup: DriverStartupService;
  curvePreview: CurvePreviewPublisher;
  lifecycle: CompanionLifecycleService;
  dispose(): void;
}

export function createAppContext(paths: PathsService): AppContext {
  if (!paths.appDataDirPath || !paths.settingPath || !paths.guiSettingPath || !paths.infoPath) {
    throw new Error("Initialize PathsService before creating the application context");
  }
  const dialog = new DialogService();
  const appSetting = new AppSettingService(paths);
  const lifecycle = new CompanionLifecycleService(appSetting);
  const appSettingGetter = () => appSetting.values();
  const dis = new DriverInfoService(paths, appSettingGetter);
  const dss = new DriverSettingService(paths, dis, appSettingGetter);
  const sds = new SystemDiagnosticService(dss, dis, dialog, paths, appSetting);
  const aus = new AppUpdateService(sds, appSettingGetter);
  const galaxy = new GalaxySettingsBase(appSetting, dss, dis);
  const curvePreview = new CurvePreviewPublisher(() => previewState(galaxy.rootSetting, galaxy.streamQualityValues.bandwidth), update => {
    const stopEdit = galaxy.revision.subscribe(update), stopLoad = dss.values.subscribe(update);
    return () => { stopEdit(); stopLoad(); };
  });
  const checks = new SettingsCheckService(appSetting, dss, dis, sds);
  const startup = new DriverStartupService(sds);
  const stopInstallation = sds.driverInstalled.subscribe(() => startup.invalidate());
  const stopMaintenance = sds.installingDriver.subscribe(() => { if (sds.installingDriver()) startup.invalidate(); });

  // application lifetime: explicit teardown on close (2026-09-20 plan step 7)
  window.addEventListener('pagehide', () => {
    sds.dispose();
  });

  return {
    paths,
    appSetting,
    dis,
    dss,
    sds,
    aus,
    dialog,
    galaxy,
    checks,
    startup,
    curvePreview,
    lifecycle,
    dispose() {
      lifecycle.dispose();
      curvePreview.dispose();
      stopInstallation(); stopMaintenance(); startup.invalidate();
      sds.dispose();
      appSetting.dispose(); dss.dispose(); dis.dispose();
    },
  };
}
