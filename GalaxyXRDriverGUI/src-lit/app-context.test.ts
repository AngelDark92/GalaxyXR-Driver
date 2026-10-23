// End-to-end startup regression: construct the REAL composition root
// (createAppContext) — the exact code path that crashed app startup with
// "TypeError: Cannot read properties of undefined (reading 'values')" when
// `computed` evaluated eagerly during SystemDiagnosticService's field
// initialization — and read the same computed/signal values the app shell
// reads in connectedCallback.
//
// The Tauri IPC bridge is unavailable in Node; the async init tasks that
// need it are expected to reject and are settled (caught) here, exactly as
// the app's own lifecycle handles them.
import { describe, it, expect } from 'vitest';
import { createAppContext, type AppContext } from './app-context';
import { GalaxySettingsBase } from './state/galaxy-settings';
import { PathsService } from './services/paths';

function settle(ctx: AppContext): void {
  // catch the expected bridge rejections so they never surface as unhandled
  const tasks: Array<Promise<unknown> | undefined> = [
    ctx.appSetting.initTask,
    ctx.dis.initTask,
    ctx.dss.initTask,
    ctx.sds.initTask,
  ];
  for (const task of tasks) {
    task?.catch(() => {});
  }
  ctx.aus.checkUpdate().catch(() => {});
}

describe('createAppContext (startup regression)', () => {
  it('constructs the full service graph and exposes the shell-read values', async () => {
    // Must not throw — the old eager computed threw here, during
    // SystemDiagnosticService construction.
    const paths = Object.assign(new PathsService(), {
      _appDataDirPath: '/test', _settingPath: '/test/settings.json',
      _guiSettingPath: '/test/gui-settings.json', _infoPath: '/test/info.json',
      _distortionDirPath: '/test/Distortion', _diagnosticPath: '/test/diagnostic.json',
    });
    const ctx = createAppContext(paths);
    settle(ctx);
    await new Promise<void>(resolve => setTimeout(resolve, 0));

    // the shared state core exists and is wired
    expect(ctx.galaxy).toBeInstanceOf(GalaxySettingsBase);
    expect(ctx.galaxy.dss).toBe(ctx.dss);
    expect(ctx.galaxy.dis).toBe(ctx.dis);

    // app-setting values fall back to defaults before settings.json loads
    expect(ctx.appSetting.values()).toEqual({ colorScheme: 'dark', minimizeToTray: true, uiScale: 100, closeButtonAction: 'ask', updateMode: 'rewrite', advanceMode: false, devUpdates: false, driverVerified: false, ofxr: { enabled: false, version: '', mode: 'fidelityfx', bidirectional: false, logging: false, maxLogMb: 32, flushEachEvent: false, overlay: 'off' } });
    expect(ctx.galaxy.advancedMode).toBe(false);

    // the exact reads AppShell.connectedCallback/render performs;
    // the update check settles to its "fetch unavailable" shape (the test
    // env has no network), which render() reads via optional chaining
    expect(ctx.aus.updateInfo()?.fetchSuccess).toBe(false);
    expect(ctx.aus.updateInfo()?.updateAvailable).toBe(false);
    expect(ctx.sds.driverVersionMismatch()).toBe(false);
    expect(ctx.sds.settingFileInited()).toBe(false);
    expect(ctx.sds.systemReady()).toBe(false);
    expect(typeof ctx.sds.installingDriver()).toBe('boolean');
    ctx.dispose();
  });
});
