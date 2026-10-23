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
import { OfxrSessionService } from './services/ofxr-session';
import { listen } from '@tauri-apps/api/event';
import type { BitrateCurvePoint } from './domain/types';

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
  ofxr: OfxrSessionService;
  dispose(): void;
}

export function createAppContext(paths: PathsService): AppContext {
  if (!paths.appDataDirPath || !paths.settingPath || !paths.guiSettingPath || !paths.infoPath) {
    throw new Error("Initialize PathsService before creating the application context");
  }
  const dialog = new DialogService();
  const appSetting = new AppSettingService(paths);
  const appSettingGetter = () => appSetting.values();
  const dis = new DriverInfoService(paths, appSettingGetter);
  const dss = new DriverSettingService(paths, dis, appSettingGetter);
  const sds = new SystemDiagnosticService(dss, dis, dialog, paths, appSetting);
  const aus = new AppUpdateService(sds, appSettingGetter);
  const galaxy = new GalaxySettingsBase(appSetting, dss, dis);
  const ofxr = new OfxrSessionService(appSetting, dss, galaxy);
  const lifecycle = new CompanionLifecycleService(appSetting, dialog, () => ofxr.idle());
  const startup = new DriverStartupService(sds);
  const curvePreview = new CurvePreviewPublisher(
    () => previewState(galaxy.rootSetting, galaxy.streamQualityValues.bandwidth,
      startup.status()?.steamvrRunning === true),
    update => {
      const stopEdit = galaxy.revision.subscribe(update);
      const stopLoad = dss.values.subscribe(update);
      const stopStatus = startup.status.subscribe(update);
      return () => { stopEdit(); stopLoad(); stopStatus(); };
    });
  const checks = new SettingsCheckService(appSetting, dss, dis, sds);
  const stopInstallation = sds.driverInstalled.subscribe(() => startup.invalidate());
  const stopMaintenance = sds.installingDriver.subscribe(() => { if (sds.installingDriver()) startup.invalidate(); });
  // 2026-10-23: the graph window relays committed point edits here. The main
  // window remains the only settings writer; SteamVR-running edits are refused.
  let disposed = false;
  const stopCurveListeners: (() => void)[] = [];
  const addCurveStop = (stop: () => void) => { if (disposed) stop(); else stopCurveListeners.push(stop); };
  // The event bridge is absent in browser fixtures and non-Tauri hosts. Keep
  // the settings graph usable there; a real host always has listen().
  const safeListen = <T,>(event: string, handler: (event: { payload: T }) => void) => {
    try {
      const pending = listen<T>(event, handler);
      if (pending && typeof pending.then === 'function') {
        void pending.then(addCurveStop).catch(() => {});
      }
    } catch { /* no Tauri event bridge */ }
  };
  safeListen<BitrateCurvePoint[]>('curve-preview-edit', event => {
    if (startup.status()?.steamvrRunning === true) return;
    galaxy.setCustomBitrateCurve(event.payload);
  });
  safeListen('curve-preview-reset', () => {
    if (startup.status()?.steamvrRunning === true) return;
    galaxy.resetBitrateCurve();
  });

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
    ofxr,
    dispose() {
      disposed = true;
      for (const stop of stopCurveListeners.splice(0)) stop();
      lifecycle.dispose();
      ofxr.dispose();
      curvePreview.dispose();
      stopInstallation(); stopMaintenance(); startup.invalidate();
      sds.dispose();
      appSetting.dispose(); dss.dispose(); dis.dispose();
    },
  };
}
