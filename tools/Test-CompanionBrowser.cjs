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
// Default is the supported maximum: native 150% UI scale maps to zoom 1.35.
// Set 2 only for the unsupported 200% stress diagnostic.
const refreshZoom = Number(process.env.COMPANION_BROWSER_REFRESH_ZOOM || 1.35);
if (!Number.isFinite(refreshZoom) || refreshZoom <= 0) throw new Error('COMPANION_BROWSER_REFRESH_ZOOM must be a positive finite number');
const refreshZoomPercent = Math.round(refreshZoom * 100);
const refreshZoomTag = String(refreshZoomPercent);
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
  const writes = [], pendingWrites = [];
  const write = async (target, value) => {
    target = normalize(target);
    if (window.__qa.holdWrites[target]) await new Promise(resolve => pendingWrites.push({ target, resolve }));
    if (window.__qa.writeErrors[target]) throw Error(window.__qa.writeErrors[target]);
    put(target, value);
    writes.push({ target, value });
  };
  window.__qa = { files, calls, data, github, writes, pendingWrites, holdWrites: {},
    writeErrors: JSON.parse(sessionStorage.getItem('qa-write-errors') || '{}'),
    releaseWrites() { this.holdWrites = {}; for (const pending of pendingWrites.splice(0)) pending.resolve(); },
    openerError: '', runtime: null, holdRuntime: false, pendingRuntime: [],
    requestedZoom: null, emulateNativeZoom: false, releaseGithub() {
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
      if (command === 'set_webview_zoom') {
        window.__qa.requestedZoom = args.scale;
        if (window.__qa.emulateNativeZoom) document.documentElement.style.zoom = String(args.scale);
        return;
      }
      if (command === 'plugin:event|unlisten' || command === 'sync_companion_lifecycle') return;
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
        await write(target, typeof value === 'string' ? value : new TextDecoder().decode(new Uint8Array(value)));
        return;
      }
      if (command === 'plugin:fs|copy_file') { await write(args.to, files[normalize(args.from)]); return; }
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
  const validationMetrics = {
    hitTargets: [], contrast: [], layouts: [],
    coverage: {
      contrast: 'Computed RGB(A) foregrounds over composited solid ancestor backgrounds and the themed Canvas fallback; text 4.5:1, sampled control icons/focus outlines 3:1.',
      contrastExclusions: 'Disabled controls and empty/hidden text are excluded. Opacity, gradients and images are unsupported and fail the probe rather than producing a ratio. This is targeted coverage, not a full WCAG audit.',
      reflow: `960x600 CSS-pixel viewport at 100%, plus rendered ${refreshZoomPercent}% zoom emulated with CSS zoom in the mocked native-zoom fixture. Not a live Tauri/WebView2 run.`,
    },
  };
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
    const assertNavHitTargets = async label => {
      const audit = await page.locator('app-chapter-nav').evaluate((nav, label) => {
        const root = nav.shadowRoot;
        const intersects = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
        const rect = (element, name = element.id || element.className) => {
          const box = element.getBoundingClientRect();
          return { element, name, left: box.left, top: box.top, right: box.right, bottom: box.bottom,
            width: box.width, height: box.height,
            center: { x: box.left + box.width / 2, y: box.top + box.height / 2 } };
        };
        const spineWidth = root.querySelector('.spine').getBoundingClientRect().width;
        const targets = [...root.querySelectorAll('.brand-link, .spine-toggle, .rail-close, .chapter-disclosure, .chapter-link')]
          .filter(element => element.getClientRects().length).map(element => rect(element));
        const overlaps = [], labelOverlaps = [], hitErrors = [];
        for (let i = 0; i < targets.length; i++) for (let j = i + 1; j < targets.length; j++) {
          const a = targets[i], b = targets[j];
          // The approved disclosure intentionally overlays the link's reserved
          // 52px padding. Its label and actual hit target are checked below.
          const intentionalLayer = a.element.closest('.chapter-row') === b.element.closest('.chapter-row')
            && [a.element, b.element].some(element => element.matches('.chapter-disclosure'))
            && [a.element, b.element].some(element => element.matches('.chapter-link'));
          if (!intentionalLayer && intersects(a, b)) overlaps.push([a.name, b.name]);
        }
        for (const target of targets) {
          const hitTest = (hitRect, expectedSelector, expected, part) => {
            const { x, y } = hitRect.center;
            const clip = (target.element.closest('.rail-list') || target.element.closest('.spine') || target.element.closest('.rail'))
              ?.getBoundingClientRect();
            const inside = x >= 0 && x < innerWidth && y >= 0 && y < innerHeight
              && (!clip || (x >= clip.left && x < clip.right && y >= clip.top && y < clip.bottom));
            // A scrollable rail can legitimately place rows outside its current
            // viewport. Measure their boxes, but hit-test only visible centers.
            if (!inside) return;
            const hit = root.elementFromPoint(x, y);
            if (hit?.closest(expectedSelector) !== expected) {
              hitErrors.push(`${target.name}: ${part} hit ${hit?.className || hit?.tagName || 'null'}`);
            }
          };
          if (target.element.matches('.chapter-link')) {
            const labelRect = rect(target.element.querySelector('.chapter-label'), target.name + ' label');
            const disclosure = target.element.closest('.chapter-row').querySelector('.chapter-disclosure');
            if (disclosure && intersects(labelRect, rect(disclosure))) labelOverlaps.push(target.name);
            hitTest(labelRect, '.chapter-link', target.element, 'label');
          } else {
            hitTest(target, '.brand-link, .spine-toggle, .rail-close, .chapter-disclosure', target.element, 'center');
          }
        }
        const publicTargets = targets.map(({ element, center, ...target }) => target);
        return { label, spineWidth, targets: publicTargets, overlaps, labelOverlaps, hitErrors };
      }, label);
      assert.ok(audit.spineWidth > 0, `${label}: missing spine`);
      assert.ok(audit.targets.length >= 4, `${label}: missing navigation targets`);
      for (const target of audit.targets) {
        assert.ok(target.width >= 43.99 && target.height >= 43.99,
          `${label}: undersized ${target.name} ${target.width}x${target.height}`);
      }
      assert.deepEqual(audit.overlaps, [], `${label}: overlapping navigation hit boxes`);
      assert.deepEqual(audit.labelOverlaps, [], `${label}: chapter label intersects disclosure`);
      assert.deepEqual(audit.hitErrors, [], `${label}: navigation hit-test failure`);
      validationMetrics.hitTargets.push(audit);
    };
    const assertDeepFocus = async (locator, label) => {
      assert.ok(await locator.evaluate(element => {
        let active = document.activeElement;
        while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
        return active === element;
      }), `${label}: focus did not return to the invoking control`);
    };
    const installContrastProbe = () => page.evaluate(() => {
      if (window.__qaContrast) return;
      const parse = text => {
        if (text === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
        const match = /^rgba?\(\s*([\d.]+)[, ]+\s*([\d.]+)[, ]+\s*([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/.exec(text);
        if (!match) throw Error(`Unsupported computed color: ${text}`);
        return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]), a: match[4] === undefined ? 1 : Number(match[4]) };
      };
      const over = (top, bottom) => {
        const a = top.a + bottom.a * (1 - top.a);
        if (!a) return { r: 0, g: 0, b: 0, a: 0 };
        const channel = key => (top[key] * top.a + bottom[key] * bottom.a * (1 - top.a)) / a;
        return { r: channel('r'), g: channel('g'), b: channel('b'), a };
      };
      const parent = element => element.parentElement || element.getRootNode()?.host || null;
      const name = element => `${element.tagName.toLowerCase()}${element.id ? '#' + element.id : ''}${element.classList.length ? '.' + [...element.classList].join('.') : ''}`;
      const luminance = color => {
        const channel = key => {
          const value = color[key] / 255;
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * channel('r') + 0.7152 * channel('g') + 0.0722 * channel('b');
      };
      const rgb = color => `rgba(${[color.r, color.g, color.b, color.a].map(value => Number(value.toFixed(4))).join(',')})`;
      const themedCanvas = () => {
        const probe = document.createElement('span');
        probe.style.cssText = 'position:fixed;visibility:hidden;background:Canvas';
        document.body.appendChild(probe);
        const color = parse(getComputedStyle(probe).backgroundColor);
        probe.remove();
        return color;
      };
      window.__qaContrast = {
        measure(element, property, skipSelfBackground = false) {
          const style = getComputedStyle(element);
          let background = { r: 0, g: 0, b: 0, a: 0 };
          const backgroundChain = [];
          for (let node = skipSelfBackground ? parent(element) : element; node; node = parent(node)) {
            const nodeStyle = getComputedStyle(node);
            if (Number(nodeStyle.opacity) !== 1) throw Error(`Contrast probe does not cover opacity on ${name(node)}`);
            if (nodeStyle.backgroundImage !== 'none') throw Error(`Contrast probe cannot cover gradient/image on ${name(node)}`);
            const layer = parse(nodeStyle.backgroundColor);
            if (layer.a) backgroundChain.push({ element: name(node), color: rgb(layer) });
            background = over(background, layer);
          }
          let canvasFallback = false, canvas = null;
          if (background.a < 1) {
            canvasFallback = true;
            canvas = themedCanvas();
            background = over(background, canvas);
          }
          const foreground = over(parse(style[property]), background);
          const lighter = Math.max(luminance(foreground), luminance(background));
          const darker = Math.min(luminance(foreground), luminance(background));
          return { property, foreground: rgb(foreground), background: rgb(background), backgroundChain,
            canvas: canvas ? rgb(canvas) : null, canvasFallback, ratio: (lighter + 0.05) / (darker + 0.05) };
        },
      };
    });
    const auditContrast = async theme => {
      await installContrastProbe();
      const samples = await page.evaluate(theme => {
        const specs = [
          ['app-stream-frame-page', '.page-intro h1', 'primary text', 4.5],
          ['app-stream-frame-page', '.page-intro p', 'secondary text', 4.5],
          ['app-stream-frame-page', '.field .title > span', 'primary text', 4.5],
          ['app-stream-frame-page', '.row-description', 'secondary text', 4.5],
          ['app-stream-frame-page', '.field .note', 'secondary text', 4.5],
          ['app-stream-frame-page', '.section-card > .card-heading .section-title', 'primary text', 4.5],
          ['app-stream-frame-page', '.section-group-label', 'primary/secondary text', 4.5],
          ['app-chapter-nav', '.vertical-label', 'secondary text', 4.5],
          ['app-chapter-nav', '.rail-head', 'secondary text', 4.5],
          ['app-chapter-nav', '.chapter-label', 'primary text', 4.5],
          ['app-chapter-nav', '.outline-link', 'primary/secondary text', 4.5],
          ['app-chapter-nav', '.rail-close', 'control icon', 3],
          ['app-chapter-nav', '.chapter-disclosure', 'control icon', 3],
        ];
        const samples = [];
        for (const [hostSelector, selector, role, threshold] of specs) {
          const shell = document.querySelector('app-shell');
          const host = shell?.shadowRoot?.querySelector(hostSelector);
          if (!host?.shadowRoot) throw Error(`Missing contrast host ${hostSelector}`);
          for (const element of host.shadowRoot.querySelectorAll(selector)) {
            if (!element.getClientRects().length || !element.textContent.trim()
              || element.matches(':disabled,[disabled],[aria-disabled="true"]')) continue;
            samples.push({ theme, host: hostSelector, selector, role, threshold,
              text: element.textContent.trim().replace(/\s+/g, ' ').slice(0, 120),
              ...window.__qaContrast.measure(element, 'color') });
          }
        }
        return samples;
      }, theme);
      assert.ok(samples.length > 0, `${theme}: no contrast samples`);
      for (const sample of samples) {
        assert.ok(sample.ratio + 1e-9 >= sample.threshold,
          `${theme}: ${sample.role} ${sample.selector} ratio ${sample.ratio.toFixed(3)} < ${sample.threshold}: ${sample.text}`);
      }
      validationMetrics.contrast.push(...samples);
    };
    const auditFocusContrast = async (locator, theme, name) => {
      await locator.focus();
      // Keyboard modality makes :focus-visible deterministic in headless Edge.
      await page.keyboard.press('Tab');
      await page.keyboard.press('Shift+Tab');
      const sample = await locator.evaluate((element, details) => {
        const style = getComputedStyle(element);
        return {
          theme: details.theme, name: details.name, role: 'focus indicator', threshold: 3,
          focusVisible: element.matches(':focus-visible'),
          outlineStyle: style.outlineStyle,
          outlineWidth: parseFloat(style.outlineWidth),
          outlineOffset: parseFloat(style.outlineOffset),
          ...window.__qaContrast.measure(element, 'outlineColor', parseFloat(style.outlineOffset) >= 0),
        };
      }, { theme, name });
      assert.ok(sample.focusVisible, `${theme}: ${name} did not receive keyboard-visible focus`);
      assert.notEqual(sample.outlineStyle, 'none', `${theme}: ${name} has no focus outline`);
      assert.ok(sample.outlineWidth >= 2, `${theme}: ${name} focus outline ${sample.outlineWidth}`);
      assert.ok(sample.ratio + 1e-9 >= 3,
        `${theme}: ${name} focus contrast ${sample.ratio.toFixed(3)} < 3`);
      validationMetrics.contrast.push(sample);
    };
    const auditReflowAndLastControl = async (label, screenshotPrefix) => {
      const audit = await page.evaluate(label => {
        const shell = document.querySelector('app-shell');
        const pageHost = shell.shadowRoot.querySelector('app-stream-frame-page');
        const content = shell.shadowRoot.querySelector('main.content');
        const parent = element => element.parentElement || element.getRootNode()?.host || null;
        const inPage = element => {
          for (let node = element; node; node = parent(node)) if (node === pageHost) return true;
          return false;
        };
        const visible = element => {
          const style = getComputedStyle(element);
          return element.getClientRects().length && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const selector = 'a[href],button,input,select,textarea,fluent-button,fluent-dropdown,fluent-slider,fluent-switch,app-choice,app-select,app-slider,app-switch,app-number,[role="button"]';
        const controls = [];
        const visit = root => {
          for (const element of root.querySelectorAll('*')) {
            if (inPage(element) && element.matches(selector) && visible(element)) controls.push(element);
            if (element.shadowRoot) visit(element.shadowRoot);
          }
        };
        visit(document);
        const rect = element => {
          const box = element.getBoundingClientRect();
          return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
        };
        const name = element => `${element.tagName.toLowerCase()}${element.id ? '#' + element.id : ''}${element.getAttribute('aria-label') ? `[${element.getAttribute('aria-label')}]` : ''}`;
        const clippedControls = controls.filter(element => {
          const box = rect(element);
          return box.left < -1 || box.right > innerWidth + 1;
        }).map(element => ({ name: name(element), rect: rect(element) }));
        const fieldClips = [], descendantClips = [], descendantMeasurements = [];
        const closestAcrossRoots = (element, selector) => {
          for (let node = element; node; node = parent(node)) {
            if (node.matches?.(selector)) return node;
          }
          return null;
        };
        for (const field of pageHost.shadowRoot.querySelectorAll('.field')) {
          if (!visible(field)) continue;
          const fieldBox = rect(field);
          const fieldTitle = field.querySelector(':scope > .title')?.textContent.trim().replace(/\s+/g, ' ').slice(0, 120);
          for (const child of field.querySelectorAll(':scope > .title, :scope > .control, :scope > .row-description, :scope > .field-notices')) {
            if (!visible(child)) continue;
            const box = rect(child);
            if (box.left < fieldBox.left - 1 || box.right > fieldBox.right + 1) {
              fieldClips.push({ field: field.id || field.className,
                title: fieldTitle,
                gridColumns: getComputedStyle(field).gridTemplateColumns,
                child: child.className, childMinWidth: getComputedStyle(child).minWidth,
                fieldRect: fieldBox, childRect: box });
            }
          }
          // Custom-element hosts can fit their grid track while a fixed-width
          // native control inside their shadow root escapes it. Audit the
          // rendered control, not only the host/direct .control wrapper.
          const visitControls = root => {
            for (const element of root.querySelectorAll('*')) {
              const dropdownFace = element.matches('.control') && element.getRootNode()?.host?.tagName === 'FLUENT-DROPDOWN';
              if (visible(element) && (element.matches('input,select,textarea,[part~="control"],fluent-slider,fluent-switch') || dropdownFace)) {
                const box = rect(element);
                const ownerField = closestAcrossRoots(element, '.field');
                const ownerCard = closestAcrossRoots(element, '.section-card');
                // Start at the parent because the Fluent dropdown face itself
                // is named .control; its page-owned wrapper is the container.
                const ownerControl = closestAcrossRoots(parent(element), '.control');
                if (ownerField === field && ownerCard && ownerControl) {
                  const cardBox = rect(ownerCard), controlBox = rect(ownerControl);
                  const composedPath = [];
                  for (let node = element; node; node = parent(node)) {
                    composedPath.push(name(node));
                    if (node === field) break;
                  }
                  const measurement = { field: field.id || field.className, title: fieldTitle,
                    descendant: name(element), host: element.getRootNode()?.host?.tagName.toLowerCase(),
                    composedPath, gridColumns: getComputedStyle(field).gridTemplateColumns,
                    containerInlineWidth: rect(pageHost).width,
                    descendantStyleWidth: getComputedStyle(element).width,
                    descendantStyleMinWidth: getComputedStyle(element).minWidth,
                    fieldRect: fieldBox, controlWrapperRect: controlBox, cardRect: cardBox, descendantRect: box };
                  descendantMeasurements.push(measurement);
                  if (box.left < controlBox.left - 1 || box.right > controlBox.right + 1
                    || box.left < fieldBox.left - 1 || box.right > fieldBox.right + 1
                    || box.left < cardBox.left - 1 || box.right > cardBox.right + 1) {
                    descendantClips.push(measurement);
                  }
                }
              }
              if (element.shadowRoot) visitControls(element.shadowRoot);
            }
          };
          visitControls(field);
        }
        const last = controls.filter(element => element.tabIndex >= 0 && !element.disabled).at(-1);
        if (last) last.setAttribute('data-qa-refresh-last', '');
        return { label, zoom: parseFloat(getComputedStyle(document.documentElement).zoom) || 1,
          coordinateSpace: 'DOM CSS pixels from getBoundingClientRect; browser zoom simulated with CSS zoom',
          container: { inlineWidth: rect(pageHost).width, type: getComputedStyle(pageHost).containerType,
            name: getComputedStyle(pageHost).containerName },
          viewport: { width: innerWidth, height: innerHeight },
          visualViewport: { width: visualViewport.width, height: visualViewport.height, scale: visualViewport.scale },
          documentWidth: document.documentElement.scrollWidth, documentClientWidth: document.documentElement.clientWidth,
          contentWidth: content.scrollWidth, contentClientWidth: content.clientWidth,
          controlCount: controls.length, clippedControls, fieldClips, descendantClips, descendantMeasurements, hasLastControl: !!last };
      }, label);
      assert.ok(audit.documentWidth <= audit.documentClientWidth + 1, `${label}: document horizontal overflow ${JSON.stringify(audit)}`);
      assert.ok(audit.contentWidth <= audit.contentClientWidth + 1, `${label}: content horizontal overflow ${JSON.stringify(audit)}`);
      assert.deepEqual(audit.clippedControls, [], `${label}: viewport-clipped controls`);
      assert.deepEqual(audit.fieldClips, [], `${label}: field-clipped content`);
      assert.deepEqual(audit.descendantClips, [], `${label}: shadow-descendant controls escape their field/card`);
      assert.ok(audit.controlCount > 0 && audit.hasLastControl, `${label}: no focusable controls found`);
      await page.screenshot({ path: path.join(out, `${screenshotPrefix}-top.png`), animations: 'disabled' });
      const last = page.locator('[data-qa-refresh-last]');
      await last.scrollIntoViewIfNeeded();
      await last.focus();
      const lastControl = await last.evaluate(element => {
        const shell = document.querySelector('app-shell');
        const contentBox = shell.shadowRoot.querySelector('main.content').getBoundingClientRect();
        const box = element.getBoundingClientRect();
        let active = document.activeElement;
        while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
        return { name: element.getAttribute('aria-label') || element.textContent.trim() || element.tagName,
          focused: active === element || element.contains(active),
          rect: { left: box.left, right: box.right, top: box.top, bottom: box.bottom },
          contentRect: { left: contentBox.left, right: contentBox.right, top: contentBox.top, bottom: contentBox.bottom } };
      });
      assert.ok(lastControl.focused, `${label}: last control did not receive focus`);
      assert.ok(lastControl.rect.left >= lastControl.contentRect.left - 1 && lastControl.rect.right <= lastControl.contentRect.right + 1
        && lastControl.rect.top >= lastControl.contentRect.top - 1 && lastControl.rect.bottom <= lastControl.contentRect.bottom + 1,
      `${label}: last control is not fully reachable ${JSON.stringify(lastControl)}`);
      await page.screenshot({ path: path.join(out, `${screenshotPrefix}-bottom.png`), animations: 'disabled' });
      await last.evaluate(element => element.removeAttribute('data-qa-refresh-last'));
      validationMetrics.layouts.push({ ...audit, lastControl });
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
    {
      // Settings relocation: moved controls, retired visibility, aliases and save failure.
      const settingsPage = await context.newPage();
      const settingsErrors = [];
      settingsPage.on('pageerror', error => settingsErrors.push(String(error)));
      try {
        const visit = async (hash, route = hash.slice(2).split('?')[0]) => {
          await settingsPage.evaluate(hash => { location.hash = hash; }, hash);
          await settingsPage.locator(`app-${route}-page`).getByRole('heading', { level: 1 }).waitFor();
        };
        const state = () => settingsPage.evaluate(() => ({
          advanced: appContext.appSetting.confirmedValues()?.advanceMode,
          settings: structuredClone(appContext.dss.values()),
          driver: JSON.parse(__qa.files[__qa.data + '/settings.json']),
          app: JSON.parse(__qa.files[__qa.data + '/gui-settings.json']),
        }));
        const writes = () => settingsPage.evaluate(() => __qa.writes
          .filter(write => write.target === __qa.data + '/settings.json' || write.target === __qa.data + '/gui-settings.json')
          .map(write => ({ file: write.target.split('/').at(-1), value: JSON.parse(write.value) })));
        const assertChecked = async (control, checked) => {
          assert.deepEqual(await control.evaluate(async element => {
            const adapter = element.getRootNode().host;
            await adapter.updateComplete;
            return { adapter: adapter.checked, fluent: element.checked };
          }), { adapter: checked, fluent: checked });
        };
        const setError = (file, message) => settingsPage.evaluate(({ file, message }) => {
          __qa.writeErrors = message ? { [__qa.data + '/' + file]: message } : {};
        }, { file, message });
        await settingsPage.goto(base + '#/app-settings');
        await settingsPage.waitForFunction(() => window.appContext?.sds.driverState() === 'installed');
        await settingsPage.evaluate(async () => {
          const settings = structuredClone(appContext.dss.values());
          settings.galaxyXr.controllerBypass = true;
          settings.galaxyXr.nativeIdentity = false;
          settings.galaxyXr.renderWidth = 3600; settings.galaxyXr.renderHeight = 3900;
          settings.streamFrame.enable = false; settings.streamFrame.graveyardEnable = false;
          settings.streamFrame.kalmanGripEnable = true;
          await appContext.dss.save(settings); await appContext.dss.flush();
          await appContext.appSetting.save({ ...appContext.appSetting.values(), advanceMode: false });
        });

        const driverPage = settingsPage.locator('app-driver-settings-page');
        const imagePage = settingsPage.locator('app-stream-frame-page');
        await visit('#/driver-settings');
        await driverPage.getByText('Keep Galaxy XR recognition enabled', { exact: true }).waitFor();
        for (const id of ['galaxyXr.nativeResolution', 'galaxyXr.renderWidth', 'galaxyXr.renderHeight', 'renderResolutionLinked', 'galaxyXr.sdr10Baseline']) {
          assert.equal(await driverPage.locator(`[data-setting-id="${id}"]`).count(), 0, id);
        }
        assert.equal(await driverPage.locator('#section-controller-graveyard').count(), 0);
        await visit('#/stream-frame');
        await imagePage.locator('#section-render-resolution [data-setting-id="galaxyXr.renderWidth"]').waitFor();
        assert.equal(await imagePage.locator('[data-setting-id="galaxyXr.renderWidth"] app-number').evaluate(control => control.value), 3600);
        assert.equal(await imagePage.locator('[data-setting-id="galaxyXr.renderHeight"] app-number').evaluate(control => control.value), 3900);
        await imagePage.locator('#section-image-processing [data-setting-id="galaxyXr.sdr10Baseline"] fluent-switch:not([disabled])').waitFor();
        assert.equal(await imagePage.locator('#section-graveyard').count(), 0);
        assert.equal(await settingsPage.locator('[data-setting-id="streamFrame.graveyardEnable"]').count(), 0);

        await visit('#/app-settings');
        const advancedSwitch = settingsPage.locator('[data-setting-id="advanceMode"] fluent-switch');
        await advancedSwitch.click();
        await settingsPage.waitForFunction(() => appContext.appSetting.confirmedValues()?.advanceMode === true);
        const graveyardSwitch = settingsPage.locator('[data-setting-id="streamFrame.graveyardEnable"] fluent-switch');
        await graveyardSwitch.waitFor();
        await assertChecked(graveyardSwitch, false);
        await setError('settings.json', 'Fixture retired visibility save denied');
        await graveyardSwitch.click();
        await settingsPage.waitForFunction(() => !!appContext.dss.writeFileError());
        await assertChecked(graveyardSwitch, false);
        assert.equal((await state()).driver.streamFrame.graveyardEnable === true, false);
        await setError('', '');

        await graveyardSwitch.click();
        await settingsPage.waitForFunction(() => appContext.dss.values().streamFrame.graveyardEnable === true);
        await settingsPage.evaluate(() => appContext.dss.flush());
        await visit('#/driver-settings');
        const controllerRetired = driverPage.locator('#section-controller-graveyard');
        await controllerRetired.waitFor();
        assert.equal(await controllerRetired.locator('.card-heading button').getAttribute('aria-expanded'), 'false');
        await controllerRetired.locator('.card-heading button').click();
        await controllerRetired.locator('[data-setting-id="streamFrame.kalmanGripEnable"]').waitFor();
        await driverPage.getByText(/This reset restores the existing field-retired defaults/).waitFor();
        await controllerRetired.getByText('Controller features are disabled. Saved experimental adjustments are kept.', { exact: true }).waitFor();
        await visit('#/stream-frame');
        const imageRetired = imagePage.locator('#section-graveyard');
        await imageRetired.waitFor();
        assert.equal(await imageRetired.locator('.card-heading button').getAttribute('aria-expanded'), 'false');
        await imageRetired.locator('.card-heading button').click();
        await imageRetired.locator('[data-setting-id="streamFrame.eyeGaze.probeCapture"]').waitFor();
        await imagePage.getByText(/This reset restores the existing field-retired defaults/).waitFor();

        const beforeLinks = await writes();
        for (const [hash, canonical, id] of [
          ['#/driver-settings?setting=galaxyXr.renderWidth', '#/stream-frame?setting=galaxyXr.renderWidth', 'galaxyXr.renderWidth'],
          ['#/driver-settings?setting=galaxyXr.sdr10Baseline', '#/stream-frame?setting=galaxyXr.sdr10Baseline', 'galaxyXr.sdr10Baseline'],
          ['#/stream-frame?setting=streamFrame.kalmanGripEnable', '#/driver-settings?setting=streamFrame.kalmanGripEnable', 'streamFrame.kalmanGripEnable'],
        ]) {
          await visit(hash, canonical.slice(2).split('?')[0]);
          await settingsPage.waitForFunction(hash => location.hash === hash, canonical);
          await settingsPage.locator(`[data-setting-id="${id}"]`).waitFor();
          await settingsPage.waitForFunction(id => {
            let active = document.activeElement;
            while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
            return active?.getAttribute('data-setting-id') === id;
          }, id);
        }
        assert.deepEqual(await writes(), beforeLinks);

        await visit('#/app-settings');
        await graveyardSwitch.click();
        await settingsPage.waitForFunction(() => appContext.dss.values().streamFrame.graveyardEnable === false);
        await settingsPage.evaluate(() => appContext.dss.flush());
        await visit('#/driver-settings');
        assert.equal(await driverPage.locator('#section-controller-graveyard').count(), 0);
        await visit('#/stream-frame');
        assert.equal(await imagePage.locator('#section-graveyard').count(), 0);
        assert.equal((await state()).settings.streamFrame.kalmanGripEnable, true);
        await visit('#/app-settings');
        await advancedSwitch.click();
        await settingsPage.waitForFunction(() => appContext.appSetting.confirmedValues()?.advanceMode === false);
        assert.equal(await settingsPage.locator('[data-setting-id="streamFrame.graveyardEnable"]').count(), 0);
        assert.deepEqual(settingsErrors, []);
        results.push('Relocated render/SDR controls, retired visibility, independent collapsed cards, old setting links and failed save restoration');
      } finally {
        await settingsPage.close();
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
    assert.equal(await page.locator('#page-debug').count(), 0);
    assert.equal(await page.evaluate(() => appContext.galaxy.debugMode), false);
    const selectedBeforeDebug = await debugSelections();
    await openRoute('app-settings');
    await page.locator('[data-setting-id="debugMode"] fluent-switch').click();
    await page.waitForFunction(() => appContext.galaxy.debugMode);
    await page.evaluate(() => appContext.dss.flush());
    await page.locator('#page-debug').waitFor();
    assert.equal(await page.evaluate(() => appContext.appSetting.values().advanceMode), false);
    await openRoute('debug');
    const debug = page.locator('app-debug-page');
    assert.deepEqual(await debug.locator('.section-card > .card-heading .section-label').allTextContents(),
      ['Monitoring', 'Image Processing', 'Controllers', 'Encoder']);
    await debug.locator('#open-bitrate-monitor').waitFor();
    assert.equal(await debug.locator('.section-card > .card-heading .section-title').evaluateAll(titles =>
      titles.every(title => title.tagName === 'BUTTON' && title.hasAttribute('aria-expanded'))), true);
    // 2026-10-30: only depth-0 cards collapse; Bitrate monitor and Diagnostics
    // are static source groups inside their card bodies, not nested fieldsets.
    assert.deepEqual(await debug.locator('.section-body > .section-group > .section-group-label').allTextContents(),
      ['Bitrate monitor', 'Diagnostics', 'Diagnostics', 'Diagnostics']);
    assert.equal(await debug.locator('.section-body > .section-group > .section-group-label').evaluateAll(labels =>
      labels.every(label => label.tagName === 'DIV' && !label.hasAttribute('aria-expanded'))), true);
    assert.equal(await debug.locator('.section-title').filter({ hasText: 'Diagnostics' }).count(), 0);
    assert.equal(await debug.locator('.section-body > .section-group > .section-group-label')
      .filter({ hasText: 'Diagnostics' }).count(), 3);
    const imageDiagnostics = debug.locator('.section-body > .section-group').filter({ hasText: 'Diagnostics' }).first();
    assert.equal(await imageDiagnostics.getAttribute('role'), 'group');
    await debug.locator('[data-setting-id="streamFrame.hitchDiag"]').waitFor();
    assert.deepEqual(await debugSelections(), selectedBeforeDebug);
    results.push('Debug defaults hidden, opens from App Preferences independently of Advanced Mode, and shows collapsible primary cards with diagnostics fieldsets');

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
      assert.equal(await page.locator(`app-${route}-page .section-group > .section-group-label`).evaluateAll(labels =>
        labels.every(label => label.tagName === 'DIV' && !label.hasAttribute('aria-expanded'))), true);
    }
    await openRoute('driver-settings');
    assert.equal(await page.locator('app-driver-settings-page #section-controllers-advanced').count(), 1);
    await openRoute('stream-frame');
    assert.equal(await page.locator('app-stream-frame-page #section-advanced').count(), 1);
    results.push('All seven pages keep at most two real nested cards with Advanced controls open; Debug captured at wide/narrow widths in both themes');

    await openRoute('debug');
    await page.evaluate(async () => {
      await appContext.dss.save({ ...appContext.dss.values(), debugMode: false });
      await appContext.dss.flush();
    });
    await page.locator('app-app-settings-page').getByRole('heading', { level: 1 }).waitFor();
    assert.equal(await page.locator('#page-debug').count(), 0);
    assert.equal(await page.locator('app-debug-page').count(), 0);
    assert.equal(new URL(page.url()).hash, '#/app-settings');
    assert.deepEqual(await debugSelections(), selectedBeforeDebug);
    await page.reload();
    await page.waitForFunction(() => window.appContext?.sds.driverState() === 'installed');
    assert.equal(await page.evaluate(() => appContext.galaxy.debugMode), false);
    assert.equal(await page.locator('#page-debug').count(), 0);
    assert.deepEqual(await debugSelections(), selectedBeforeDebug);
    for (const hash of ['#/debug?setting=streamFrame.hitchDiag', '#/stream-frame?setting=streamFrame.hitchDiag']) {
      const beforeGuardedLink = await mutations();
      await page.evaluate(hash => { location.hash = hash; }, hash);
      await page.waitForFunction(() => location.hash === '#/app-settings');
      await page.locator('app-app-settings-page').getByRole('heading', { level: 1 }).waitFor();
      await page.locator('app-shell fluent-message-bar').filter({ hasText: 'Enable Debug Mode in App Settings to show diagnostic controls.' }).waitFor();
      assert.equal(new URL(page.url()).hash, '#/app-settings');
      assert.equal(await page.locator('#page-debug').count(), 0);
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

    // Approved presentation refresh: measure the real DOM, not screenshots.
    await page.setViewportSize({ width: 1100, height: 900 });
    await openRoute('stream-frame');
    await page.evaluate(async () => {
      await appContext.appSetting.save({ ...appContext.appSetting.values(), colorScheme: 'light' });
    });
    const refreshNav = page.locator('app-chapter-nav');
    const refreshDisclosure = refreshNav.locator('.chapter-row:has(#page-stream-frame) .chapter-disclosure');
    const expectedDescriptions = [
      ['galaxyXr.nativeResolution', 'Higher resolutions increase GPU load. Requires a SteamVR restart.',
        page.locator('app-stream-frame-page [data-setting-id="galaxyXr.nativeResolution"]')],
      ['streamFrame.nvencCodec', 'Changing the codec loads its optimized defaults. Requires a SteamVR restart. Reconnect your headset afterward.',
        page.locator('app-stream-frame-page [data-setting-id="streamFrame.nvencCodec"]')],
      ['Max Bitrate', 'A requested budget, not measured bitrate. Requires a SteamVR restart.',
        page.locator('app-stream-frame-page .field').filter({ has: page.getByText('Max Bitrate (Mbit/s)', { exact: true }) })],
    ];
    for (const [id, expected, row] of expectedDescriptions) {
      assert.equal(await row.count(), 1, `${id}: expected one rendered row`);
      assert.equal((await row.locator('.row-description').textContent()).trim(), expected, id);
    }
    results.push('Resolution, codec and Max Bitrate rows expose the three exact approved consequence descriptions');

    const beforeRefreshNavMutations = await mutations();
    await assertNavHitTargets('1100x900 light rail open');
    await auditContrast('light');
    await auditFocusContrast(refreshNav.locator('.rail-close'), 'light', 'rail close');
    const refreshHash = page.url();
    await refreshDisclosure.click();
    await page.waitForFunction(() => document.querySelector('app-shell').shadowRoot.querySelector('app-chapter-nav').shadowRoot
      .querySelector('#sections-toggle-stream-frame').getAttribute('aria-expanded') === 'true');
    assert.equal(page.url(), refreshHash, 'Disclosure must not navigate');
    await assertNavHitTargets('1100x900 light disclosure open');
    await auditContrast('light disclosure open');
    await auditFocusContrast(refreshDisclosure, 'light', 'chapter disclosure');
    assert.equal(await mutations(), beforeRefreshNavMutations, 'Navigation/disclosure must not write settings');

    await page.evaluate(async () => {
      await appContext.appSetting.save({ ...appContext.appSetting.values(), colorScheme: 'dark' });
    });
    await auditContrast('dark disclosure open');
    await auditFocusContrast(refreshNav.locator('.rail-close'), 'dark', 'rail close');
    await auditFocusContrast(refreshDisclosure, 'dark', 'chapter disclosure');
    results.push('Targeted light/dark text, control icon and keyboard-focus contrast meets 4.5/3 thresholds');

    await page.setViewportSize({ width: 960, height: 600 });
    await assertNavHitTargets('960x600 dark disclosure open');
    await auditReflowAndLastControl('960x600, 100%, dark, disclosure open', 'refresh-960x600-scale100');
    await page.evaluate(async zoom => {
      window.__qa.emulateNativeZoom = true;
      await window.__TAURI_INTERNALS__.invoke('set_webview_zoom', { scale: zoom });
    }, refreshZoom);
    await page.waitForFunction(zoom => parseFloat(getComputedStyle(document.documentElement).zoom) === zoom, refreshZoom);
    assert.equal(await page.evaluate(() => window.__qa.requestedZoom), refreshZoom);
    await auditReflowAndLastControl(`960x600, rendered ${refreshZoomPercent}% CSS zoom, dark, disclosure open`, `refresh-960x600-zoom${refreshZoomTag}`);
    await page.evaluate(() => {
      window.__qa.emulateNativeZoom = false;
      document.documentElement.style.zoom = '';
    });
    results.push(`960x600 and rendered ${refreshZoomPercent}% CSS zoom have no horizontal/control clipping and keep the last control keyboard reachable`);

    // Keyboard activation and focus restoration come last so a source behavior
    // failure does not hide the independent geometry/contrast evidence above.
    const beforeKeyboardNavMutations = await mutations();
    const outsideNavControl = page.locator('app-stream-frame-page [data-setting-id="galaxyXr.nativeResolution"] fluent-switch');
    await outsideNavControl.focus();
    assert.ok(await outsideNavControl.evaluate(element => element.getRootNode().activeElement === element),
      'Test setup must focus a page control outside the navigator without changing its value');
    const beforeOutsideEscape = await page.evaluate(() => ({ href: location.href, settings: JSON.stringify(appContext.dss.values()) }));
    await page.keyboard.press('Escape');
    // Allow any incorrect navigator handler to render before checking that the
    // navigator-frame-only Escape contract left this page control alone.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await refreshDisclosure.getAttribute('aria-expanded'), 'true', 'Escape outside nav must not close sections');
    assert.equal(page.url(), beforeOutsideEscape.href, 'Escape outside nav must not navigate');
    assert.equal(await page.evaluate(() => JSON.stringify(appContext.dss.values())), beforeOutsideEscape.settings,
      'Escape outside nav must not change settings');
    await refreshDisclosure.focus();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('app-shell').shadowRoot.querySelector('app-chapter-nav').shadowRoot
      .querySelector('#sections-toggle-stream-frame').getAttribute('aria-expanded') === 'false');
    await assertDeepFocus(refreshDisclosure, 'Escape closes disclosure');
    await refreshNav.locator('.rail-close').focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('app-shell').shadowRoot.querySelector('app-chapter-nav').open);
    await assertDeepFocus(refreshNav.locator('.spine-toggle'), 'Rail close keyboard activation');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('app-shell').shadowRoot.querySelector('app-chapter-nav').open);
    await assertDeepFocus(refreshNav.locator('#page-stream-frame'), 'Rail reopen keyboard activation');
    assert.equal(await mutations(), beforeKeyboardNavMutations, 'Keyboard navigation must not write settings');
    results.push('Disclosure Escape restores focus; rail close/reopen work by keyboard and restore focus');

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
    await restoreDialog.getByText("NVENC Tap is off. Saved tuning was kept. Start SteamVR to use Steam Link's encoder parameters.", { exact: true }).waitFor();
    await restoreDialog.locator('fluent-button').click();
    assert.equal(await page.evaluate(() => appContext.dss.values().streamFrame.nvencTap), false);
    assert.equal(await page.evaluate(() => appContext.dss.values().streamFrame.nvencPreset), 2);
    await encoder.getByText('NVENC Tap off saved', { exact: true }).waitFor();
    await encoder.getByText('Restore encoder behaviour', { exact: true }).waitFor();
    results.push('Encoder restore remains accessible with Tap OFF and preserves saved tuning');
    await page.evaluate(async () => {
      window.__qa.runtime = { state:'headset-connected',steamvrRunning:true,driverInitialized:true,serverPid:4242,
        encoderTap:{state:'disabled',configPath:'/roaming/GalaxyXR/CustomHeadset/settings.json',modulePath:'/managed/GalaxyXRNative/bin/win64/driver_GalaxyXRNative.dll'} };
      await appContext.startup.refresh();
      window.__qa.holdRuntime = true;
    });
    await encoder.getByText('NVENC Tap off confirmed', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(out, 'encoder-off-confirmed.png'), animations: 'disabled' });
    await page.waitForFunction(() => window.__qa.pendingRuntime.length > 0);
    await encoder.getByText('NVENC Tap off saved', { exact: true }).waitFor({timeout:8000});
    assert.equal(await encoder.getByText('NVENC Tap off confirmed', { exact: true }).count(), 0);
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
    fs.writeFileSync(path.join(out, 'refresh-metrics.json'), JSON.stringify(validationMetrics, null, 2));
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ productionBundle: true, nativeIPC: 'in-memory fixture only', hashes, results, errors }, null, 2));
    console.log(JSON.stringify({ passed: results.length, screenshots: out, results }, null, 2));
  } catch (error) {
    if (page) {
      console.error(await page.evaluate(() => ({ dialogs: [...document.querySelectorAll('fluent-dialog')].map(dialog => dialog.innerText),
        calls: window.__qa?.calls.slice(-20), runtime: window.appContext?.startup.status(),
        windowsStartup: window.appContext?.windowsStartup.status(), startupError: window.appContext?.windowsStartup.error() })));
      await page.screenshot({ path: path.join(out, 'failure.png'), animations: 'disabled' });
    }
    fs.writeFileSync(path.join(out, 'refresh-metrics.json'), JSON.stringify(validationMetrics, null, 2));
    throw error;
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
