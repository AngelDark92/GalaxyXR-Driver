#!/usr/bin/env node
'use strict';
// Production Lit/Fluent browser checks with an in-memory Tauri adapter.
// No native IPC, live files, installation or SteamVR processes are touched.
// Run after build:ui. Install Playwright separately or supply it via NODE_PATH.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const repo = path.resolve(__dirname, '..');
const dist = path.join(repo, '../builds/GalaxyXR-Driver/gui/dist/fluent');
const out = process.env.COMPANION_BROWSER_OUTPUT || path.join(repo, '../builds/GalaxyXR-Driver/build/companion-ui-validation');
fs.mkdirSync(out, { recursive: true });

function fixture() {
  const normalize = value => {
    const parts = String(value).replaceAll('\\', '/').split('/');
    const result = [];
    for (const part of parts) { if (part === '..') result.pop(); else if (part && part !== '.') result.push(part); }
    return '/' + result.join('/');
  };
  const data = '/roaming/GalaxyXR/CustomHeadset';
  const initial = {
    [data + '/gui-settings.json']: JSON.stringify({ colorScheme: 'light', advanceMode: false }),
    [data + '/settings.json']: JSON.stringify({ debugMode: false,
      galaxyXr: { nativeIdentity: true, sdr10SettingsVersion: 2, vrlinkDebugOverlay: true },
      streamFrame: { enable: true, streamFrameSchema: 5, nvencSettingsVersion: 4,
        hitchDiag: true, poseLogging: true, poseLogBurst: true, nvencVerbose: true,
        eyeGaze: { debugRing: true }, blackFloor: { rampBar: true, blackPointCode: 7 },
        nvencPreset: 3, nvencForceFps: 72, gamma: 1.8 } }),
    [data + '/info.json']: JSON.stringify({ driverVersion: '1.2.13' }),
    [data + '/Distortion/kept.json']: '{"name":"kept-profile"}',
    '/local/openvr/openvrpaths.vrpath': JSON.stringify({ runtime: ['/SteamVR'], config: ['/SteamConfig'], external_drivers: ['/managed/GalaxyXRNative'] }),
    '/SteamConfig/steamvr.vrsettings': JSON.stringify({ driver_GalaxyXRNative: { enable: true } }),
    '/SteamVR/bin/win64/vrserver.exe': '',
    '/SteamVR/bin/win64/vrpathreg.exe': '',
    '/managed/GalaxyXRNative/driver.vrdrivermanifest': '{"name":"GalaxyXRNative","version":"1.2.13"}',
    '/managed/GalaxyXRNative/bin/win64/driver_GalaxyXRNative.dll': '',
  };
  const files = JSON.parse(sessionStorage.getItem('qa-files') || 'null') || initial;
  const calls = [];
  const persist = () => sessionStorage.setItem('qa-files', JSON.stringify(files));
  const put = (p, value) => { files[normalize(p)] = value; persist(); };
  const github = { tagName: '1.2.13', releaseUrl: 'https://github.com/AngelDark92/GalaxyXR-Driver/releases/tag/v1.2.13',
    status: 200, hold: false, pending: [], requests: [] };
  window.__qa = { files, calls, data, github, openerError: '', runtime: null, holdRuntime: false, pendingRuntime: [], releaseGithub() {
    github.hold = false;
    for (const release of github.pending.splice(0)) release();
  } };
  // Native registrations belong to the process: a reload starts disarmed,
  // while gui-settings.json remains in the fixture filesystem.
  let ofxrState = 'ready';
  const currentStartupCommand = '"C:\\Companion\\Galaxy XR Companion.exe" --start-in-tray';
  window.__qa.windowsStartup = { supported: true, state: 'absent', command: null,
    currentCommand: currentStartupCommand, registeredPath: null };
  const ofxrStatus = () => ({ state: ofxrState, version: '116', runtimeDir: '/ofxr/v116', reason: null,
    versions: [{ version: '116', source: 'bundled' }] });
  const oldFetch = window.fetch;
  window.fetch = (url, ...args) => {
    if (!String(url).includes('api.github.com')) return oldFetch(url, ...args);
    github.requests.push(String(url));
    const response = { tag_name: github.tagName, html_url: github.releaseUrl }, status = github.status;
    const reply = () => new Response(JSON.stringify(response), { status });
    return github.hold ? new Promise(resolve => github.pending.push(() => resolve(reply()))) : Promise.resolve(reply());
  };
  let callback = 0;
  const callbacks = new Map(), events = new Map();
  window.__qa.emitNative = (event, payload) => callbacks.get(events.get(event))?.({ event, payload, id: 1 });
  window.__TAURI_INTERNALS__ = {
    transformCallback: fn => { callbacks.set(++callback, fn); return callback; },
    unregisterCallback() {},
    async invoke(command, args = {}, options = {}) {
      calls.push({ command, args });
      const p = normalize(args.path || '');
      if (command === 'plugin:path|resolve_directory') return args.directory === 14 ? '/roaming/app' : '/local';
      if (command === 'plugin:path|join') return normalize(args.paths.join('/'));
      if (command === 'plugin:path|normalize') return p;
      if (command === 'plugin:path|basename') return p.split('/').at(-1);
      if (command === 'plugin:path|dirname') return p.slice(0, p.lastIndexOf('/'));
      if (command === 'plugin:event|listen') { events.set(args.event, args.handler); return ++callback; }
      if (command === 'complete_companion_quit') return window.__qa.holdQuitAck ? new Promise(resolve => { window.__qa.releaseQuitAck = resolve; }) : undefined;
      if (command === 'complete_companion_startup') return;
      if (command === 'get_windows_startup') return structuredClone(window.__qa.windowsStartup);
      if (command === 'set_windows_startup') {
        if (window.__qa.startupError) throw Error(window.__qa.startupError);
        if (args.expectedCommand !== window.__qa.windowsStartup.command) throw Error('Startup entry changed');
        window.__qa.windowsStartup = { supported: true, state: args.enabled ? 'current' : 'absent',
          command: args.enabled ? currentStartupCommand : null, currentCommand: currentStartupCommand,
          registeredPath: args.enabled ? 'C:\\Companion\\Galaxy XR Companion.exe' : null };
        return structuredClone(window.__qa.windowsStartup);
      }
      if (command === 'plugin:event|unlisten' || command === 'sync_companion_lifecycle' || command === 'set_webview_zoom') return;
      if (command === 'ofxr_status') return ofxrStatus();
      if (command === 'ofxr_arm') {
        const error = sessionStorage.getItem('qa-ofxr-error');
        if (error) throw Error(error);
        ofxrState = 'armed'; return ofxrStatus();
      }
      if (command === 'ofxr_disarm' || command === 'ofxr_reinstall' || command === 'ofxr_remove') { ofxrState = 'ready'; return ofxrStatus(); }
      if (command === 'ofxr_apply') return;
      if (command === 'plugin:app|version') return '1.2.13';
      if (command === 'plugin:opener|open_url') {
        if (window.__qa.openerError) throw Error(window.__qa.openerError);
        return;
      }
      if (command === 'plugin:fs|exists') return Object.hasOwn(files, p) || Object.keys(files).some(key => key.startsWith(p + '/'));
      if (command === 'plugin:fs|read_text_file') {
        const readErrors = JSON.parse(sessionStorage.getItem('qa-read-errors') || '{}');
        if (readErrors[p]) throw Error(readErrors[p]);
        if (!Object.hasOwn(files, p)) throw Error('Missing fixture: ' + p);
        return Array.from(new TextEncoder().encode(files[p]));
      }
      if (command === 'plugin:fs|read_dir') return Object.keys(files).filter(key => key.startsWith(p + '/') && !key.slice(p.length + 1).includes('/'))
        .map(key => ({ name: key.split('/').at(-1), isFile: true, isDirectory: false, isSymlink: false }));
      if (command === 'plugin:fs|write_text_file') {
        const target = options.headers?.path ? decodeURIComponent(options.headers.path) : p;
        const value = args.contents ?? args.data ?? args;
        put(target, typeof value === 'string' ? value : new TextDecoder().decode(new Uint8Array(value)));
        return;
      }
      if (command === 'plugin:fs|copy_file') { put(args.to, files[normalize(args.from)]); return; }
      if (command === 'plugin:fs|remove') { delete files[p]; persist(); return; }
      if (command === 'plugin:fs|mkdir') return;
      if (command === 'plugin:fs|watch') return 1;
      if (command === 'plugin:fs|unwatch' || command === 'plugin:resources|close') return;
      if (command === 'get_galaxyxr_runtime_status') {
        const report = () => ({ state: 'not-running', detail: 'SteamVR is closed.', steamvrRunning: false, driverInitialized: false,
          headsetConnected: false, driverVersion: null, serverPid: null, ...window.__qa.runtime, checkedAt: Date.now() });
        if (window.__qa.holdRuntime) return new Promise(resolve => window.__qa.pendingRuntime.push(() => resolve(report())));
        return report();
      }
      if (command === 'restore_steamlink_encoder_behaviour') {
        if (window.__qa.runtime?.steamvrRunning) throw Error('Close SteamVR completely before restoring encoder behaviour');
        const source = files[data + '/settings.json'];
        const backupPath = '/roaming/GalaxyXR/Backups/encoder-fixture';
        put(backupPath + '/settings.json.before', source);
        const config = JSON.parse(source); config.streamFrame.nvencTap = false;
        put(data + '/settings.json', JSON.stringify(config));
        return { outcome: 'complete', preservedPaths: [], unresolvedItems: [], backupPath,
          resetFiles: [data + '/settings.json'], tapEnabled: false, warnings: [] };
      }
      if (command === 'clean_galaxyxr_settings') {
        put(data + '/settings.json', '{"galaxyXr":{"nativeIdentity":true}}');
        put(data + '/gui-settings.json', '{}');
        delete files[data + '/info.json']; persist();
        return { outcome: 'complete', preservedPaths: [data + '/Distortion'], unresolvedItems: [],
          backupPath: '/roaming/GalaxyXR/Backups/reset-fixture', resetFiles: [data + '/settings.json', data + '/gui-settings.json'],
          restoredSettings: 2, removedIdentityKeys: [], removedIdentitySections: [], steamvrCleaned: true, warnings: [] };
      }
      if (command === 'uninstall_galaxyxr_driver') {
        window.__qa.windowsStartup = { ...window.__qa.windowsStartup, state: 'absent', command: null, registeredPath: null };
        for (const key of Object.keys(files)) {
          if (key.startsWith('/managed/') || (key.startsWith(data + '/') && !key.startsWith(data + '/Distortion/'))) delete files[key];
        }
        put('/local/openvr/openvrpaths.vrpath', JSON.stringify({ runtime: ['/SteamVR'], config: ['/SteamConfig'], external_drivers: [] }));
        put('/SteamConfig/steamvr.vrsettings', '{}');
        return { outcome: 'complete', removedPaths: ['/managed/GalaxyXRNative'], restoredSettings: 2, legacyReset: false,
          warnings: [], unresolvedItems: [], preservedPaths: [data + '/Distortion'] };
      }
      throw Error('Unexpected fixture IPC: ' + command);
    },
  };
}

(async () => {
  const server = http.createServer((req, res) => {
    const file = path.resolve(dist, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
    if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
    res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser, page;
  const results = [];
  try {
    browser = await chromium.launch({ channel: process.env.COMPANION_BROWSER || 'msedge', headless: true });
    const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, reducedMotion: 'reduce' });
    await context.addInitScript(fixture);
    const externalRequests = [];
    await context.route(/^https?:\/\//, route => {
      if (new URL(route.request().url()).hostname === '127.0.0.1') return route.continue();
      externalRequests.push(route.request().url());
      return route.abort();
    });
    page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    const base = `http://127.0.0.1:${server.address().port}/en-US/index.html`;
    await page.goto(base + '#/setup');
    await page.waitForFunction(() => window.appContext?.sds.driverState() === 'installed');
    await page.locator('app-setup-page').waitFor();
    assert.deepEqual(await page.evaluate(() => ['button','badge','message-bar','dialog','dialog-body','accordion','accordion-item','spinner']
      .filter(name => !customElements.get('fluent-' + name))), []);
    results.push('All Fluent elements registered in production bundle');
    const mutationCommands = ['clean_galaxyxr_settings','restore_steamlink_encoder_behaviour','uninstall_galaxyxr_driver','plugin:fs|mkdir','plugin:fs|write_text_file','plugin:fs|copy_file','plugin:fs|remove'];
    const mutations = () => page.evaluate(list => window.__qa.calls.filter(call => list.includes(call.command)).length, mutationCommands);
    const openerUrls = () => page.evaluate(() => window.__qa.calls.filter(call => call.command === 'plugin:opener|open_url').map(call => call.args.url));
    const focusLinkWithKeyboard = async link => {
      assert.equal(await link.evaluate(element => element.tagName), 'A');
      await link.focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      assert.equal(await link.evaluate(element => element.matches(':focus-visible')), true);
      assert.equal(await link.evaluate(element => getComputedStyle(element).outlineStyle), 'solid');
      assert.ok(await link.evaluate(element => parseFloat(getComputedStyle(element).outlineWidth) >= 2));
    };
    const openRoute = async route => {
      await page.evaluate(route => { location.hash = '/' + route; }, route);
      await page.locator(`app-${route}-page`).getByRole('heading', { level: 1 }).waitFor();
    };
    // Each page has its own sessionStorage. Seed through the existing fixture,
    // then reload so startup reads the scenario without changing baseline QA.
    const startupCases = [
      { name: 'Missing app and driver settings use confirmed tray defaults without creating files',
        firstLaunch: true, appSettings: null, driverRaw: null, minimizeToTray: true, driverReason: 'File not exists', startupError: null },
      { name: 'Missing driver settings preserve an explicit tray opt-out without writes',
        firstLaunch: true, appSettings: { minimizeToTray: false }, driverRaw: null, minimizeToTray: false, driverReason: 'File not exists', startupError: null },
      { name: 'Malformed driver settings still fail startup readiness without writes or Optical Flow arming',
        appSettings: {}, driverRaw: '{broken', minimizeToTray: true, driverReason: 'Parsing failed', startupError: /Saved settings could not be read/ },
      { name: 'Unreadable driver settings still fail startup readiness without writes or Optical Flow arming',
        appSettings: {}, driverRaw: '{}', readError: 'Fixture driver access denied', minimizeToTray: true, driverReason: 'Read failed', startupError: /Saved settings could not be read/ },
      { name: 'Missing driver settings block saved Optical Flow restoration and preserve the enabled preference',
        firstLaunch: true, appSettings: { ofxr: { enabled: true } }, driverRaw: null, minimizeToTray: true, driverReason: 'File not exists',
        startupError: /Read the saved driver and Companion settings successfully before enabling Optical Flow/, ofxrEnabled: true },
    ];
    for (const scenario of startupCases) {
      const startupPage = await context.newPage();
      const startupErrors = [];
      startupPage.on('pageerror', error => startupErrors.push(String(error)));
      try {
        await startupPage.goto(base + '#/app-settings');
        await startupPage.waitForFunction(() => window.__qa?.calls.some(call => call.command === 'complete_companion_startup'));
        const seededFiles = await startupPage.evaluate(({ firstLaunch, appSettings, driverRaw, readError }) => {
          const { data, files } = window.__qa;
          if (firstLaunch) {
            for (const key of Object.keys(files)) {
              if (key.startsWith(data + '/') || key.startsWith('/managed/GalaxyXRNative/')) delete files[key];
            }
            files['/local/openvr/openvrpaths.vrpath'] = JSON.stringify({ runtime: ['/SteamVR'], config: ['/SteamConfig'], external_drivers: [] });
            files['/SteamConfig/steamvr.vrsettings'] = '{}';
          }
          if (appSettings === null) delete files[data + '/gui-settings.json'];
          else files[data + '/gui-settings.json'] = JSON.stringify(appSettings);
          if (driverRaw === null) delete files[data + '/settings.json'];
          else files[data + '/settings.json'] = driverRaw;
          sessionStorage.setItem('qa-files', JSON.stringify(files));
          sessionStorage.setItem('qa-read-errors', JSON.stringify(readError ? { [data + '/settings.json']: readError } : {}));
          return files;
        }, { firstLaunch: scenario.firstLaunch, appSettings: scenario.appSettings, driverRaw: scenario.driverRaw, readError: scenario.readError });
        await startupPage.reload();
        await startupPage.waitForFunction(() => window.__qa?.calls.some(call => call.command === 'complete_companion_startup'));
        await startupPage.locator('app-app-settings-page').waitFor();
        const state = await startupPage.evaluate(() => ({
          calls: window.__qa.calls, files: window.__qa.files,
          tray: appContext.appSetting.confirmedValues()?.minimizeToTray,
          appReadError: appContext.appSetting.readFileError(), driverReadError: appContext.dss.readFileError(),
          ofxrError: appContext.ofxr.error(), ofxrEnabled: appContext.appSetting.confirmedValues()?.ofxr?.enabled,
        }));
        assert.deepEqual(state.calls.filter(call => mutationCommands.includes(call.command)), [], scenario.name);
        assert.deepEqual(state.files, seededFiles, scenario.name);
        assert.deepEqual(state.calls.filter(call => call.command === 'ofxr_arm'), [], scenario.name);
        assert.equal(state.appReadError, undefined, scenario.name);
        assert.equal(state.driverReadError?.reason, scenario.driverReason, scenario.name);
        if (scenario.readError) assert.match(state.driverReadError.message, /Fixture driver access denied/);
        assert.equal(state.tray, scenario.minimizeToTray, scenario.name);
        const lifecycleCalls = state.calls.filter(call => call.command === 'sync_companion_lifecycle');
        assert.ok(lifecycleCalls.length > 0, scenario.name);
        assert.ok(lifecycleCalls.every(call => call.args.minimizeToTray === scenario.minimizeToTray), scenario.name);
        const readiness = state.calls.filter(call => call.command === 'complete_companion_startup');
        assert.equal(readiness.length, 1, scenario.name);
        if (scenario.startupError === null) assert.equal(readiness[0].args.error, null, scenario.name);
        else assert.match(readiness[0].args.error, scenario.startupError, scenario.name);
        if (scenario.ofxrEnabled) {
          assert.equal(state.ofxrEnabled, true, scenario.name);
          assert.match(state.ofxrError, scenario.startupError, scenario.name);
          await startupPage.locator('app-shell fluent-message-bar').filter({ hasText: 'Optical Flow needs attention' }).waitFor();
        } else assert.equal(state.ofxrError, undefined, scenario.name);
        assert.deepEqual(startupErrors, [], scenario.name);
        results.push(scenario.name);
      } finally {
        await startupPage.close();
      }
    }
    const debugSelections = () => page.evaluate(() => {
      const settings = appContext.dss.values(), sf = settings.streamFrame;
      return { hitchDiag: sf.hitchDiag, poseLogging: sf.poseLogging, poseLogBurst: sf.poseLogBurst,
        nvencVerbose: sf.nvencVerbose, debugRing: sf.eyeGaze.debugRing, rampBar: sf.blackFloor.rampBar,
        blackPointCode: sf.blackFloor.blackPointCode, nvencPreset: sf.nvencPreset,
        nvencForceFps: sf.nvencForceFps, gamma: sf.gamma, vrlinkDebugOverlay: settings.galaxyXr.vrlinkDebugOverlay };
    });
    const assertCardDepth = async route => {
      const deepest = await page.locator(`app-${route}-page`).evaluate(host => {
        let maximum = 0;
        for (const card of host.shadowRoot.querySelectorAll('.section-card')) {
          let depth = 0;
          for (let node = card; node; node = node.parentElement) if (node.classList.contains('section-card')) depth++;
          maximum = Math.max(maximum, depth);
        }
        return maximum;
      });
      assert.ok(deepest <= 2, `${route} renders ${deepest} stacked cards`);
    };
    assert.equal(await page.locator('#tab-debug').count(), 0);
    assert.equal(await page.evaluate(() => appContext.galaxy.debugMode), false);
    const selectedBeforeDebug = await debugSelections();
    await openRoute('app-settings');
    await page.locator('[data-setting-id="debugMode"] fluent-switch').click();
    await page.waitForFunction(() => appContext.galaxy.debugMode);
    await page.evaluate(() => appContext.dss.flush());
    await page.locator('#tab-debug').waitFor();
    assert.equal(await page.evaluate(() => appContext.appSetting.values().advanceMode), false);
    await openRoute('debug');
    const debug = page.locator('app-debug-page');
    assert.deepEqual(await debug.locator('.section-group.source > .section-group-label').allTextContents(),
      ['Monitoring', 'Image Processing', 'Controllers', 'Encoder']);
    await debug.locator('#open-bitrate-monitor').waitFor();
    assert.equal(await debug.locator('.section-group.source > .section-group-label').evaluateAll(labels =>
      labels.every(label => label.tagName === 'DIV' && !label.hasAttribute('aria-expanded'))), true);
    const imageDiagnostics = debug.locator('.section-title').filter({ hasText: 'Diagnostics' }).first();
    await imageDiagnostics.click();
    await debug.locator('[data-setting-id="streamFrame.hitchDiag"]').waitFor({ state: 'detached' });
    await imageDiagnostics.click();
    await debug.locator('[data-setting-id="streamFrame.hitchDiag"]').waitFor();
    assert.deepEqual(await debugSelections(), selectedBeforeDebug);
    results.push('Debug defaults hidden, opens from App preferences independently of Advanced Mode, and groups collapsible diagnostics under plain source labels');

    await page.reload();
    await page.waitForFunction(() => window.appContext?.sds.driverState() === 'installed');
    await debug.getByRole('heading', { name: 'Debug', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => appContext.galaxy.debugMode), true);
    assert.equal(await page.evaluate(() => appContext.appSetting.values().advanceMode), false);
    assert.deepEqual(await debugSelections(), selectedBeforeDebug);
    for (const theme of ['light', 'dark']) {
      await page.evaluate(async theme => {
        await appContext.appSetting.save({ ...appContext.appSetting.values(), colorScheme: theme });
      }, theme);
      for (const width of [1100, 600]) {
        await page.setViewportSize({ width, height: 900 });
        await page.screenshot({ path: path.join(out, `debug-${theme}-${width}.png`), animations: 'disabled' });
        await assertCardDepth('debug');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      }
    }
    await page.setViewportSize({ width: 1100, height: 900 });
    await openRoute('stream-frame');
    assert.equal(await page.evaluate(() => appContext.galaxy.advancedMode), false);
    await page.locator('app-stream-frame-page').getByRole('heading', { name: 'Optical Flow', exact: true }).waitFor();
    await page.locator('app-stream-frame-page').getByText('Optical Flow requires the Companion to stay running', { exact: true }).waitFor();
    await page.locator('app-stream-frame-page .section-card').filter({ has: page.getByRole('heading', { name: 'Optical Flow', exact: true }) }).screenshot({ path: path.join(out, 'optical-flow-requirement.png') });
    const opticalSwitch = page.locator('app-stream-frame-page [data-setting-id="ofxr.enabled"] app-switch');
    await opticalSwitch.click();
    await page.waitForFunction(() => appContext.ofxr.isArmed());
    assert.equal(await opticalSwitch.evaluate(el => el.checked), true);
    // Keep the real service/page binding in this regression, with native IPC
    // mocked: reload must rearm independently of which page opens first.
    await page.evaluate(async () => { await appContext.ofxr.update({ mode: 'nvidia-medium', scale: 50 }); });
    await openRoute('app-settings');
    await page.reload();
    await page.waitForFunction(() => window.appContext?.ofxr.isArmed());
    assert.ok(await page.evaluate(() => __qa.calls.some(call => call.command === 'ofxr_arm' && call.args.prefs.mode === 'nvidia-medium')));
    await page.evaluate(() => sessionStorage.setItem('qa-ofxr-error', 'Saved Optical Flow restore failed'));
    await page.reload();
    await page.waitForFunction(() => window.appContext?.ofxr.error()?.includes('Saved Optical Flow restore failed'));
    await page.locator('app-shell fluent-message-bar').filter({ hasText: 'Optical Flow needs attention' }).waitFor();
    await page.waitForFunction(() => __qa.calls.some(call => call.command === 'complete_companion_startup' && call.args.error?.includes('Saved Optical Flow restore failed')));
    assert.equal(await page.evaluate(() => appContext.appSetting.confirmedValues().ofxr.enabled), true);
    await page.evaluate(() => sessionStorage.removeItem('qa-ofxr-error'));
    await page.reload();
    await page.waitForFunction(() => window.appContext?.ofxr.isArmed());
    results.push('Failed saved Optical Flow restoration preserves On, renders a global recovery link and reports failed startup readiness');
    await openRoute('stream-frame');
    assert.equal(await opticalSwitch.evaluate(el => el.checked), true);
    await page.locator('app-stream-frame-page fluent-button').filter({ hasText: 'Reinstall' }).click();
    await page.waitForFunction(() => !appContext.ofxr.changing() && appContext.ofxr.isArmed());
    assert.ok(await page.evaluate(() => __qa.calls.some(call => call.command === 'ofxr_reinstall')));
    await page.locator('app-stream-frame-page fluent-button').filter({ hasText: 'Uninstall Optical Flow' }).click();
    await page.waitForFunction(() => !appContext.ofxr.changing() && !appContext.ofxr.isArmed());
    assert.equal(await opticalSwitch.evaluate(el => el.checked), false);
    assert.equal(await page.evaluate(() => appContext.appSetting.confirmedValues().ofxr.enabled), false);
    results.push('Optical Flow arms from its page, restores saved NVIDIA selection on app reopen, rearms after Reinstall, and disables after Uninstall (mocked native IPC)');
    await openRoute('app-settings');
    const trayRow = page.locator('app-app-settings-page [data-setting-id="minimizeToTray"]');
    const startupRow = page.locator('app-app-settings-page .field').filter({ hasText: 'Start with Windows' }).filter({ has: page.locator('app-switch') });
    const startupSwitch = startupRow.locator('app-switch');
    await page.waitForFunction(() => window.appContext?.windowsStartup.status()?.state === 'absent');
    assert.equal(await startupSwitch.evaluate(el => el.checked), false);
    assert.equal(await page.evaluate(() => __qa.calls.some(call => call.command === 'set_windows_startup')), false);
    await startupSwitch.click();
    await page.waitForFunction(() => appContext.windowsStartup.status()?.state === 'current');
    assert.equal(await startupSwitch.evaluate(el => el.checked), true);
    assert.equal(await page.evaluate(() => Object.hasOwn(appContext.appSetting.values(), 'startWithWindows')), false);
    await page.evaluate(async () => {
      __qa.windowsStartup = { ...__qa.windowsStartup, state: 'other-copy', command: '"D:\\Old\\Companion.exe" --start-in-tray', registeredPath: 'D:\\Old\\Companion.exe' };
      await appContext.windowsStartup.refresh();
    });
    await page.getByRole('button', { name: 'Use this copy', exact: true }).click();
    await page.waitForFunction(() => appContext.windowsStartup.status()?.state === 'current');
    await page.evaluate(() => { __qa.startupError = 'Startup access denied'; });
    await startupSwitch.click();
    await page.waitForFunction(() => !!appContext.windowsStartup.error() && !appContext.windowsStartup.changing());
    assert.equal(await startupSwitch.evaluate(el => el.checked), true);
    await page.evaluate(() => { __qa.startupError = ''; });
    await startupSwitch.click();
    await page.waitForFunction(() => appContext.windowsStartup.status()?.state === 'absent');
    results.push('Windows startup defaults Off, uses OS state, retargets only explicitly and preserves actual state after a failed mutation (mocked IPC)');
    assert.equal(await trayRow.locator('app-switch').evaluate(el => el.checked), true);
    const oldScale = await page.locator('app-app-settings-page .scale-value').textContent();
    await page.evaluate(async () => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
      await appContext.appSetting.save({ ...appContext.appSetting.values(), uiScale: 110 });
    });
    assert.equal(await page.locator('app-app-settings-page .scale-value').textContent(), oldScale);
    await page.evaluate(() => {
      delete document.visibilityState;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForFunction(() => document.querySelector('app-shell').shadowRoot.querySelector('app-app-settings-page').shadowRoot.querySelector('.scale-value').textContent === '110%');
    await trayRow.locator('app-switch').click();
    await page.waitForFunction(() => appContext.appSetting.confirmedValues()?.minimizeToTray === false);
    await page.waitForFunction(() => __qa.calls.some(call => call.command === 'sync_companion_lifecycle' && call.args.minimizeToTray === false));
    await page.reload();
    await page.waitForFunction(() => window.appContext?.appSetting.confirmedValues()?.minimizeToTray === false);
    await page.locator('app-app-settings-page [data-setting-id="minimizeToTray"]').waitFor();
    assert.equal(await page.locator('app-app-settings-page [data-setting-id="minimizeToTray"] app-switch').evaluate(el => el.checked), false);
    await page.evaluate(() => { __qa.holdQuitAck = true; __qa.emitNative('companion-quit-requested', 900); });
    await page.waitForFunction(() => appContext.lifecycle.quitting());
    assert.equal(await page.locator('app-shell main.content').evaluate(el => el.inert), true);
    await page.evaluate(() => __qa.releaseQuitAck());
    await page.waitForFunction(() => !appContext.lifecycle.quitting());
    assert.equal(await page.locator('app-shell main.content').evaluate(el => el.inert), false);
    results.push('Optical Flow running-app notice visible with Advanced off; tray opt-out persists; Quit blocks editing through native acknowledgement');
    await page.evaluate(async () => {
      await appContext.appSetting.save({ ...appContext.appSetting.values(), advanceMode: true });
      appContext.galaxy.sections.set(Object.fromEntries(Object.entries(appContext.galaxy.sections()).map(([key]) => [key, true])));
    });
    for (const route of ['driver-settings', 'stream-frame', 'debug', 'distortion-profile', 'app-settings', 'setup', 'about']) {
      await openRoute(route);
      await assertCardDepth(route);
      assert.equal(await page.locator(`app-${route}-page .section-group.advanced > .section-group-label`).evaluateAll(labels =>
        labels.every(label => label.tagName === 'DIV' && !label.hasAttribute('aria-expanded'))), true);
    }
    await openRoute('driver-settings');
    assert.ok(await page.locator('app-driver-settings-page .section-group.advanced').count() > 0);
    await openRoute('stream-frame');
    assert.ok(await page.locator('app-stream-frame-page .section-group.advanced').count() > 0);
    results.push('All seven pages keep at most two real nested cards with Advanced controls open; Debug captured at wide/narrow widths in both themes');

    await openRoute('debug');
    await page.evaluate(async () => {
      await appContext.dss.save({ ...appContext.dss.values(), debugMode: false });
      await appContext.dss.flush();
    });
    await page.locator('app-app-settings-page').getByRole('heading', { level: 1 }).waitFor();
    assert.equal(await page.locator('#tab-debug').count(), 0);
    assert.equal(await page.locator('app-debug-page').count(), 0);
    assert.equal(new URL(page.url()).hash, '#/app-settings');
    assert.deepEqual(await debugSelections(), selectedBeforeDebug);
    await page.reload();
    await page.waitForFunction(() => window.appContext?.sds.driverState() === 'installed');
    assert.equal(await page.evaluate(() => appContext.galaxy.debugMode), false);
    assert.equal(await page.locator('#tab-debug').count(), 0);
    assert.deepEqual(await debugSelections(), selectedBeforeDebug);
    for (const hash of ['#/debug?setting=streamFrame.hitchDiag', '#/stream-frame?setting=streamFrame.hitchDiag']) {
      const beforeGuardedLink = await mutations();
      await page.evaluate(hash => { location.hash = hash; }, hash);
      await page.waitForFunction(() => location.hash === '#/app-settings');
      await page.locator('app-app-settings-page').getByRole('heading', { level: 1 }).waitFor();
      await page.locator('app-shell fluent-message-bar').filter({ hasText: 'Enable Debug Mode in App Settings to show diagnostic controls.' }).waitFor();
      assert.equal(new URL(page.url()).hash, '#/app-settings');
      assert.equal(await page.locator('#tab-debug').count(), 0);
      assert.equal(await mutations(), beforeGuardedLink);
    }
    await page.locator('[data-setting-id="debugMode"] fluent-switch').click();
    await page.waitForFunction(() => appContext.galaxy.debugMode);
    await page.evaluate(() => appContext.dss.flush());
    for (const hash of ['#/debug?setting=streamFrame.hitchDiag', '#/stream-frame?setting=streamFrame.hitchDiag']) {
      const beforeEnabledLink = await mutations();
      await page.evaluate(hash => { location.hash = hash; }, hash);
      await page.waitForFunction(() => location.hash === '#/debug?setting=streamFrame.hitchDiag');
      await debug.locator('[data-setting-id="streamFrame.hitchDiag"]').waitFor();
      assert.equal(new URL(page.url()).hash, '#/debug?setting=streamFrame.hitchDiag');
      await page.waitForFunction(() => {
        let active = document.activeElement;
        while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
        return active?.getAttribute('data-setting-id') === 'streamFrame.hitchDiag';
      });
      assert.equal(await mutations(), beforeEnabledLink);
    }
    await openRoute('app-settings');
    await page.locator('[data-setting-id="debugMode"] fluent-switch').click();
    await page.waitForFunction(() => !appContext.galaxy.debugMode);
    await page.evaluate(() => appContext.dss.flush());
    assert.deepEqual(await debugSelections(), selectedBeforeDebug);
    results.push('Debug master On/Off survives reload, active Off returns to App Settings, and current/legacy setting links honor the gate without writes or tuning changes');
    for (const theme of ['light','dark']) {
      await page.evaluate(async theme => {
        const app = window.appContext.appSetting;
        await app.save({ ...app.values(), colorScheme: theme });
      }, theme);
      for (const route of ['driver-settings','stream-frame','distortion-profile','app-settings','setup','about']) {
        await openRoute(route);
        await page.screenshot({ path: path.join(out, `${route}-${theme}-1100.png`), animations: 'disabled' });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      }
      await page.setViewportSize({ width: 1100, height: 1200 });
      await page.screenshot({ path: path.join(out, `about-${theme}-1100-full.png`), animations: 'disabled', fullPage: true });
      await page.setViewportSize({ width: 1100, height: 900 });
    }
    await page.setViewportSize({ width: 600, height: 900 });
    for (const route of ['driver-settings','stream-frame','distortion-profile','app-settings','setup','about']) {
      await openRoute(route);
      await page.screenshot({ path: path.join(out, `${route}-dark-600.png`), animations: 'disabled' });
    }
    await page.setViewportSize({ width: 600, height: 1700 });
    await page.screenshot({ path: path.join(out, 'about-dark-600-full.png'), animations: 'disabled', fullPage: true });
    results.push('Six production tabs captured in both themes and narrow layout');
    await page.setViewportSize({ width: 1100, height: 900 });
    await openRoute('about');
    const about = page.locator('app-about-page');
    await about.locator('.update-status[aria-busy="false"]').waitFor();
    const project = 'https://github.com/AngelDark92/GalaxyXR-Driver';
    const externalUrls = [project, project + '/releases', project + '/blob/main/Docs/StreamFrame.md',
      project + '/blob/main/Docs/TunerUsage.md', project + '/issues',
      'https://github.com/sboys3/CustomHeadsetOpenVR', 'https://github.com/timkhronos/CustomHeadsetOpenVrGxR',
      'https://patreon.com/SBoys3', 'https://ko-fi.com/sboys3'];
    assert.deepEqual(await about.locator('a[href]').evaluateAll(links => links.map(link => link.getAttribute('href'))), externalUrls);
    const aboutUrl = page.url(), beforeAboutActions = await mutations();
    for (const url of externalUrls) {
      const link = about.locator(`a[href="${url}"]`);
      assert.equal(await link.getAttribute('title'), 'Opens in your browser');
      for (const method of ['click', 'Enter']) {
        const before = (await openerUrls()).length;
        if (method === 'click') await link.click();
        else { await focusLinkWithKeyboard(link); await page.keyboard.press('Enter'); }
        await page.waitForFunction(count => window.__qa.calls.filter(call => call.command === 'plugin:opener|open_url').length > count, before);
        assert.deepEqual((await openerUrls()).slice(before), [url]);
        assert.equal(page.url(), aboutUrl);
        assert.equal(context.pages().length, 1);
      }
    }
    assert.equal(await mutations(), beforeAboutActions);
    results.push('All nine exact About destinations open once for click and Enter, preserve route, and make no writes');
    const failedLink = about.locator(`a[href="${project + '/issues'}"]`);
    await page.evaluate(() => { window.__qa.openerError = 'Injected opener failure'; });
    await focusLinkWithKeyboard(failedLink);
    const beforeFailedOpen = (await openerUrls()).length;
    await page.keyboard.press('Enter');
    const linkError = page.locator('fluent-dialog');
    await linkError.getByText('Could not open link', { exact: true }).waitFor();
    assert.match(await linkError.innerText(), /Try again, or copy the address into your browser\./);
    await linkError.getByText('Details', { exact: true }).click();
    assert.equal(await linkError.locator('pre').innerText(), project + '/issues');
    await page.screenshot({ path: path.join(out, 'about-link-error.png'), animations: 'disabled' });
    await linkError.locator('fluent-button').click();
    await linkError.waitFor({ state: 'detached' });
    assert.equal(await failedLink.evaluate(link => link.getRootNode().activeElement === link), true);
    assert.deepEqual((await openerUrls()).slice(beforeFailedOpen), [project + '/issues']);
    assert.equal(page.url(), aboutUrl);
    assert.equal(await mutations(), beforeAboutActions);
    await page.evaluate(() => { window.__qa.openerError = ''; });
    results.push('Opener failure shows the URL in a recoverable dialog and restores link focus without navigation or writes');
    const checkForUpdate = async ({ status = 200, tagName = '1.2.13', releaseUrl = project + '/releases/tag/v1.2.13' } = {}) => {
      const before = await page.evaluate(state => {
        Object.assign(window.__qa.github, state, { hold: true });
        return window.__qa.github.requests.length;
      }, { status, tagName, releaseUrl });
      await about.getByText('Check for updates', { exact: true }).click();
      await page.waitForFunction(count => window.__qa.github.requests.length > count, before);
      await about.locator('.update-status[aria-busy="true"] fluent-spinner').waitFor();
      assert.notEqual(await about.getByText('Checking…', { exact: true }).getAttribute('disabled'), null);
      assert.equal(await about.getByText('Up to date', { exact: true }).count(), 0);
      assert.equal(await page.evaluate(() => window.__qa.github.requests.length), before + 1);
      await page.screenshot({ path: path.join(out, 'about-update-loading.png'), animations: 'disabled' });
      await page.evaluate(() => window.__qa.releaseGithub());
      await about.locator('.update-status[aria-busy="false"]').waitFor();
    };
    await checkForUpdate();
    await about.getByText('Up to date', { exact: true }).waitFor();
    assert.equal(await about.locator('.version-number').innerText(), '1.2.13');
    assert.equal(await about.getByText('Update check unavailable', { exact: true }).count(), 0);
    await checkForUpdate({ status: 503 });
    await about.getByText('Update check unavailable', { exact: true }).waitFor();
    assert.equal(await about.getByText('Up to date', { exact: true }).count(), 0);
    assert.equal(await about.getByText('Update available', { exact: true }).count(), 0);
    await page.screenshot({ path: path.join(out, 'about-update-error.png'), animations: 'disabled' });
    await checkForUpdate();
    await about.getByText('Up to date', { exact: true }).waitFor();
    assert.equal(await about.getByText('Update check unavailable', { exact: true }).count(), 0);
    const newReleaseUrl = project + '/releases/tag/v1.3.0';
    await checkForUpdate({ tagName: '1.3.0', releaseUrl: newReleaseUrl });
    await about.getByText('Update available', { exact: true }).waitFor();
    const beforeReleaseOpen = (await openerUrls()).length;
    await about.getByText('View release', { exact: true }).click();
    assert.deepEqual((await openerUrls()).slice(beforeReleaseOpen), [newReleaseUrl]);
    assert.equal(page.url(), aboutUrl);
    assert.equal(await about.locator('.version-number').innerText(), '1.2.13');
    assert.equal(await mutations(), beforeAboutActions);
    await page.screenshot({ path: path.join(out, 'about-update-available.png'), animations: 'disabled' });
    results.push('Update checks expose loading, current, failure, recovery and new-release states without installing or writing');
    await openRoute('distortion-profile');
    await page.evaluate(() => appContext.galaxy.sections.set({ ...appContext.galaxy.sections(), share: true }));
    // 2026-10-23 (owner directive): desktop-style non-selectable UI.
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).userSelect), 'none');
    const profileLabel = page.locator('app-distortion-profile-page .field .title').first();
    assert.equal(await profileLabel.evaluate(node => getComputedStyle(node).userSelect), 'none');
    const profileText = page.locator('app-distortion-profile-page textarea').first();
    assert.equal(await profileText.evaluate(node => getComputedStyle(node).userSelect), 'text');
    results.push('Desktop UI text is non-selectable while editable fields keep selection');
    const beforeImport = await mutations();
    const chooserPromise = page.waitForEvent('filechooser');
    await page.locator('app-distortion-profile-page').getByText('Import .json', { exact: true }).click();
    await (await chooserPromise).setFiles([]);
    assert.equal(await mutations(), beforeImport);
    results.push('Import JSON opens a file chooser and cancellation makes no writes');
    await openRoute('setup');
    const setup = page.locator('app-setup-page');
    await setup.getByText('Check settings', { exact: true }).click();
    await page.waitForFunction(() => !!window.appContext.checks.report() && !window.appContext.checks.checking());
    const primaryTable = setup.locator('table').first();
    assert.match(await primaryTable.innerText(), /Driver Settings.*Headset.*Galaxy XR Recognition/s);
    assert.doesNotMatch(await primaryTable.innerText(), /settings\.json|streamFrame\./);
    await primaryTable.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(out, 'settings-check-dark-1100.png'), animations: 'disabled' });
    const beforeLink = await mutations();
    const beforeInternalOpen = (await openerUrls()).length;
    const settingLink = primaryTable.locator('tr').filter({ hasText: 'Galaxy XR Recognition' }).getByText('Show setting');
    await focusLinkWithKeyboard(settingLink);
    assert.ok(await settingLink.evaluate(link => parseFloat(getComputedStyle(link).minHeight) >= 32));
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => location.hash.includes('setting='));
    await page.locator('[data-setting-id="galaxyXr.nativeIdentity"]').waitFor();
    assert.equal(await page.evaluate(() => {
      let active = document.activeElement;
      while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
      return active?.getAttribute('data-setting-id');
    }), 'galaxyXr.nativeIdentity');
    assert.equal(await mutations(), beforeLink);
    assert.equal((await openerUrls()).length, beforeInternalOpen);
    results.push('Human-readable checker link has visible keyboard focus and routes natively without opener calls or writes');
    await page.evaluate(async () => {
      const app = appContext.appSetting;
      await app.save({ ...app.values(), advanceMode: false });
    });
    await openRoute('setup');
    await setup.getByText('Check settings', { exact: true }).click();
    await page.waitForFunction(() => !!appContext.checks.report() && !appContext.checks.checking());
    const beforeAdvancedLink = await mutations();
    await primaryTable.locator('tr').filter({ hasText: 'Fast Render Path' }).getByText('Show setting').click();
    await page.locator('[data-setting-id="streamFrame.directRender"]').waitFor();
    assert.equal(await page.evaluate(() => {
      let active = document.activeElement;
      while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
      return active?.getAttribute('data-setting-id');
    }), 'streamFrame.directRender');
    assert.equal(await page.evaluate(() => appContext.appSetting.values().advanceMode), false);
    assert.equal(await mutations(), beforeAdvancedLink);
    assert.equal((await openerUrls()).length, beforeInternalOpen);
    results.push('Advanced target reveals and focuses its container without enabling Advanced Mode or writing');
    await page.evaluate(async () => {
      await appContext.appSetting.save({ ...appContext.appSetting.values(), advanceMode: true });
      const settings = structuredClone(appContext.dss.values());
      settings.streamFrame.nvencTap = true; settings.streamFrame.nvencPreset = 2;
      await appContext.dss.save(settings); await appContext.dss.flush();
    });
    await openRoute('stream-frame');
    await page.evaluate(() => appContext.galaxy.sections.set({ ...appContext.galaxy.sections(), advanced: true, 'heading:encoder': true }));
    const encoder = page.locator('app-stream-frame-page');
    await encoder.getByText('Restore encoder behaviour', { exact: true }).click();
    let restoreDialog = page.locator('fluent-dialog');
    await restoreDialog.getByText('Restore Steam Link encoder behaviour?', { exact: true }).waitFor();
    await restoreDialog.locator('fluent-button').nth(1).click();
    await restoreDialog.getByText("NVENC Tap is OFF. Saved tuning was kept. Start SteamVR to use Steam Link's encoder parameters.", { exact: true }).waitFor();
    await restoreDialog.locator('fluent-button').click();
    assert.equal(await page.evaluate(() => appContext.dss.values().streamFrame.nvencTap), false);
    assert.equal(await page.evaluate(() => appContext.dss.values().streamFrame.nvencPreset), 2);
    await encoder.getByText('NVENC Tap OFF saved', { exact: true }).waitFor();
    await encoder.getByText('Restore encoder behaviour', { exact: true }).waitFor();
    results.push('Encoder restore remains accessible with Tap OFF and preserves saved tuning');
    await page.evaluate(async () => {
      window.__qa.runtime = { state:'headset-connected',steamvrRunning:true,driverInitialized:true,serverPid:4242,
        encoderTap:{state:'disabled',configPath:'/roaming/GalaxyXR/CustomHeadset/settings.json',modulePath:'/managed/GalaxyXRNative/bin/win64/driver_GalaxyXRNative.dll'} };
      await appContext.startup.refresh();
      window.__qa.holdRuntime = true;
    });
    await encoder.getByText('NVENC Tap OFF confirmed', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(out, 'encoder-off-confirmed.png'), animations: 'disabled' });
    await page.waitForFunction(() => window.__qa.pendingRuntime.length > 0);
    await encoder.getByText('NVENC Tap OFF saved', { exact: true }).waitFor({timeout:8000});
    assert.equal(await encoder.getByText('NVENC Tap OFF confirmed', { exact: true }).count(), 0);
    assert.equal(await encoder.getByText('Restore encoder behaviour', { exact: true }).getAttribute('disabled'), '');
    await page.evaluate(async () => {
      window.__qa.holdRuntime = false; window.__qa.runtime = null;
      for (const release of window.__qa.pendingRuntime.splice(0)) release();
      await appContext.startup.refresh();
    });
    results.push('Confirmed OFF expires independently while a runtime poll hangs');
    await openRoute('setup');
    const beforeCancel = await mutations();
    await setup.locator('fluent-button.danger:not([disabled])').click();
    const dialog = page.locator('fluent-dialog');
    await dialog.locator('fluent-dialog-body').waitFor();
    assert.match(await dialog.innerText(), /saved profiles and recovery backups/i);
    assert.equal(await page.evaluate(() => {
      let active = document.activeElement;
      while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
      return active?.textContent?.trim();
    }), 'Cancel');
    await page.screenshot({ path: path.join(out, 'uninstall-confirmation.png'), animations: 'disabled' });
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await mutations(), beforeCancel);
    assert.equal(await page.evaluate(() => {
      let active = document.activeElement;
      while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
      return active?.textContent?.trim();
    }), 'Uninstall driver');
    results.push('Uninstall confirmation focuses Cancel; Escape restores trigger focus without mutations');
    await setup.locator('fluent-button:not([disabled])').filter({ hasText: 'Restore defaults' }).click();
    await dialog.locator('fluent-dialog-body').waitFor();
    assert.deepEqual(await dialog.locator('fluent-button').allTextContents(), ['Cancel', 'Restore defaults']);
    const cdp = await context.newCDPSession(page);
    const { nodes } = await cdp.send('Accessibility.getFullAXTree');
    assert(nodes.some(node => node.role?.value === 'alertdialog' && node.name?.value === 'Restore all defaults?'));
    const actionNames = nodes.filter(node => node.role?.value === 'button').map(node => node.name?.value);
    assert(actionNames.includes('Cancel') && actionNames.includes('Restore defaults'));
    await cdp.detach();
    results.push('Confirmation exposes its title and both action names in the browser accessibility tree');
    await dialog.locator('fluent-button').nth(1).click();
    await dialog.getByText('Defaults restored', { exact: true }).waitFor();
    await dialog.locator('fluent-button').click();
    assert.equal(await page.evaluate(() => window.appContext.appSetting.values().advanceMode), false);
    assert.equal(await page.evaluate(() => window.appContext.appSetting.values().colorScheme), 'dark');
    results.push('Confirmed reset reloads driver and app defaults');
    await page.evaluate(async () => { await appContext.windowsStartup.refresh(); await appContext.windowsStartup.setEnabled(true); });
    assert.equal(await page.evaluate(() => appContext.windowsStartup.enabled()), true);
    await setup.locator('fluent-button.danger:not([disabled])').click();
    await dialog.locator('fluent-dialog-body').waitFor();
    assert.deepEqual(await dialog.locator('fluent-button').allTextContents(), ['Cancel', 'Uninstall and clear settings']);
    await dialog.locator('fluent-button').nth(1).click();
    await dialog.getByText('Uninstall complete', { exact: true }).waitFor();
    await dialog.locator('fluent-button').click();
    await page.waitForFunction(() => appContext.windowsStartup.status()?.state === 'absent');
    results.push('Uninstall refreshes Windows startup status immediately without a focus change');
    assert.equal(await page.evaluate(() => window.__qa.files[window.__qa.data + '/Distortion/kept.json']), '{"name":"kept-profile"}');
    assert.equal(await page.evaluate(() => window.__qa.files[window.__qa.data + '/gui-settings.json']), undefined);
    await page.reload();
    await page.waitForFunction(() => window.appContext?.sds.driverState() === 'not-installed');
    assert.equal(await mutations(), 0);
    assert.equal(await page.evaluate(() => window.__qa.files[window.__qa.data + '/settings.json']), undefined);
    results.push('Uninstall preserves profile and reopening does not recreate active settings');
    await openRoute('app-settings');
    const setupLink = page.locator('app-app-settings-page').getByText('Open Setup', { exact: true });
    await focusLinkWithKeyboard(setupLink);
    const beforeSetupLink = await mutations(), beforeSetupOpen = (await openerUrls()).length;
    await page.keyboard.press('Enter');
    await page.locator('app-setup-page').getByRole('heading', { name: 'Setup', exact: true }).waitFor();
    assert.equal(new URL(page.url()).hash, '#/setup');
    assert.equal(await mutations(), beforeSetupLink);
    assert.equal((await openerUrls()).length, beforeSetupOpen);
    results.push('Open Setup remains a native keyboard link after uninstall without opener calls or settings recreation');
    assert.deepEqual(externalRequests, []);
    assert.deepEqual(errors, []);
    const assets = path.join(dist, 'en-US/assets');
    const hashes = Object.fromEntries(fs.readdirSync(assets).filter(name => /\.(js|css)$/.test(name))
      .map(name => [name, createHash('sha256').update(fs.readFileSync(path.join(assets, name))).digest('hex')]));
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ productionBundle: true, nativeIPC: 'in-memory fixture only', hashes, results, errors }, null, 2));
    console.log(JSON.stringify({ passed: results.length, screenshots: out, results }, null, 2));
  } catch (error) {
    if (page) {
      console.error(await page.evaluate(() => ({ dialogs: [...document.querySelectorAll('fluent-dialog')].map(dialog => dialog.innerText),
        calls: window.__qa?.calls.slice(-20), runtime: window.appContext?.startup.status(),
        windowsStartup: window.appContext?.windowsStartup.status(), startupError: window.appContext?.windowsStartup.error() })));
      await page.screenshot({ path: path.join(out, 'failure.png'), animations: 'disabled' });
    }
    throw error;
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
