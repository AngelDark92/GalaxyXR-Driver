#!/usr/bin/env node
'use strict';
// Focused offline-capable regression checks for the Setup/About split.
// Runs the actual TypeScript page, navigation, lifecycle, and action methods
// using inert Lit template objects and fake services. This is NOT a production
// Lit/Fluent render, a full type check, or a native Windows/SteamVR test.
// After npm ci: node tools/Test-SetupLayout.cjs
// Without local TypeScript: FLUENT_TEST_TYPESCRIPT=/path/to/typescript node ...
// Optional SETUP_LAYOUT_FIXTURES=<directory> exports layout-only HTML fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../GalaxyXRDriverGUI');
const requireGui = createRequire(path.join(root, 'package.json'));
const ts = process.env.FLUENT_TEST_TYPESCRIPT ? require(process.env.FLUENT_TEST_TYPESCRIPT) : requireGui('typescript');
const results = [], timers = new Map();
let timerId = 0;
const windowMock = {
  location: { hash: '', pathname: '/en-US/index.html', search: '' },
  history: { state: null, replaceState(_state, _title, url) { windowMock.location.hash = url.slice(url.indexOf('#')); } },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  addEventListener() {}, removeEventListener() {},
};
class InertElement {
  isConnected = false;
  updates = 0;
  updateComplete = Promise.resolve(true);
  connectedCallback() { this.isConnected = true; }
  disconnectedCallback() { this.isConnected = false; }
  requestUpdate() { this.updates++; }
}
const nothing = Symbol('nothing');
const lit = {
  LitElement: InertElement, nothing,
  html: (strings, ...values) => ({ strings, values }),
  css: (strings, ...values) => ({ cssText: strings.reduce((s, v, i) => s + v + (values[i]?.cssText ?? values[i] ?? ''), '') }),
};
const sandbox = vm.createContext({
  console, window: windowMock, document: { visibilityState: 'visible' },
  performance, queueMicrotask, structuredClone, URL,
  setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
  clearTimeout(id) { timers.delete(id); },
});
const cache = new Map();
function load(relative) {
  const file = path.resolve(root, 'src-lit', relative.endsWith('.ts') ? relative : relative + '.ts');
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} }; cache.set(file, module);
  const result = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    fileName: file, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true, useDefineForClassFields: false },
  });
  assert.equal(result.diagnostics?.length ?? 0, 0, `Syntax diagnostics in ${file}`);
  const req = id => {
    if (id === 'lit') return lit;
    if (id === 'lit/decorators.js') return { customElement: () => target => target, property: () => () => {} };
    if (id === 'lit/directives/unsafe-html.js') return { unsafeHTML: text => ({ raw: text }) };
    if (id.endsWith('/ui/controls')) return {}; // No fake controls are shipped in production.
    if (id.endsWith('/ui/theme')) return { applyTheme() {} };
    if (id.endsWith('/environment')) return { galaxyXRDriverName: 'GalaxyXRNative', vendor: 'galaxyxr' };
    if (id === '@tauri-apps/plugin-opener') return { openUrl: async () => {} };
    if (!id.startsWith('.')) throw new Error(`Unexpected dependency: ${id}`);
    return load(path.relative(path.join(root, 'src-lit'), path.resolve(path.dirname(file), id)));
  };
  vm.runInContext(`(function(require,module,exports){${result.outputText}\n})`, sandbox, { filename: file })(req, module, module.exports);
  return module.exports;
}
const { signal } = load('reactive');
const nav = load('domain/navigation');
const { SetupPage } = load('features/setup-page');
const { AboutPage } = load('features/about-page');
const { AppSettingsPage } = load('features/app-settings-page');
const { AppShell } = load('shell/app-shell');
const { DriverTroubleshooter } = load('features/system-ready');
function signals(values) {
  return new Proxy(values, { get(target, name) { return target[name] ?? (target[name] = signal(undefined)); } });
}
function context(options = {}) {
  const installed = options.installed !== false;
  const calls = [];
  const ctx = {
    calls,
    sds: signals({
      driverInstalled: signal(installed ? '1.2.3' : undefined),
      driverState: signal(options.state ?? (installed ? 'installed' : 'not-installed')),
      installingDriver: signal(!!options.busy),
      steamVRinstalled: signal(options.steamvr !== false),
      steamVrConfig: signal(options.steamvr === false ? undefined : {}),
      systemReady: signal(installed && options.enabled !== false),
      settingFileInited: signal(installed), driverVersionMismatch: signal(!!options.mismatch),
      getSteamVRDriverEnableState: () => options.enabled !== false,
      getNeutralDriverEnabled: () => false, isDriverBlocked: () => false,
      restartCompositor: async () => calls.push('restart'),
      installDriver: async () => { calls.push('install'); return true; },
      uninstallDriver: async () => {
        calls.push('uninstall'); ctx.sds.driverInstalled.set(undefined); ctx.sds.driverState.set('not-installed'); return true;
      },
      cleanSettings: async () => { calls.push('clean'); return { resetFiles: [], restoredSettings: 0, removedIdentityKeys: [], backupPath: 'fixture-backup', warnings: [] }; },
      lastUninstallReport: { removedPaths: [], restoredSettings: 0, warnings: [] },
    }),
    startup: {
      status: signal(options.runtimeUnknown ? undefined : { steamvrRunning: !!options.running, driverInitialized: !!options.initialized, detail: 'Runtime fixture' }),
      error: signal(undefined), launching: signal(!!options.launching),
      refresh: async () => calls.push('runtime-refresh'), start: async () => calls.push('start'),
      invalidate: () => { calls.push('invalidate'); ctx.startup.status.set(undefined); },
    },
    checks: {
      checking: signal(!!options.checking), report: signal(options.report),
      clear: () => { calls.push('clear'); ctx.checks.report.set(undefined); },
      refresh: async () => calls.push('check-refresh'),
    },
    aus: {
      updateInfo: signal(options.noVersion ? undefined : { currentVersion: '1.2.3', fetchSuccess: true,
        updateAvailable: !!options.update, installAvailable: !!options.upgrade, url: 'https://example.invalid/releases' }),
      checkUpdate: async () => calls.push('update'),
    },
    dis: { values: signal(installed ? { driverVersion: '1.2.3' } : undefined) },
    dss: signals({ values: signal({}), readFileError: signal(undefined), writeFileError: signal(undefined) }),
    appSetting: signals({ values: signal({ colorScheme: 'light', advanceMode: false, driverVerified: !!options.verified }),
      save: async value => { calls.push('app-save'); ctx.appSetting.values.set(value); return true; },
      readFileError: signal(undefined), writeFileError: signal(undefined) }),
    galaxy: signals({ imageEnhancementsEnabled: installed, baselineRequested: false, imageModeChanging: signal(false), imageModeError: signal(undefined), sections: signal({}) }),
    dialog: { message: async (title, message) => calls.push({ title, message }) },
  };
  return ctx;
}
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
function markup(value) {
  if (value === nothing || value == null || typeof value === 'function') return '';
  if (Array.isArray(value)) return value.map(markup).join('');
  if (value.raw !== undefined) return value.raw;
  if (!value.strings) return escape(value);
  let text = '';
  value.strings.forEach((chunk, index) => {
    text += chunk;
    if (index === value.values.length) return;
    const next = value.values[index];
    const binding = text.match(/([.?@]?[\w:-]+)=$/);
    if (!binding) { text += markup(next); return; }
    text = text.slice(0, -binding[0].length);
    const attr = binding[1];
    if (attr.startsWith('@') || attr.startsWith('.')) return;
    if (attr.startsWith('?')) { if (next) text += attr.slice(1); return; }
    text += `${attr}="${escape(next)}"`;
  });
  return text;
}
function render(Page, ctx) { const page = new Page(); page.ctx = ctx; return { page, template: page.render() }; }
function cards(template) { return Array.from(template.values[0]); }
function buttonLabels(template) {
  return [...markup(template).matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)]
    .map(m => m[1].replace(/<[^>]+>/g, '').trim());
}
function enhancementSwitch(template) {
  if (Array.isArray(template)) {
    for (const value of template) { const found = enhancementSwitch(value); if (found) return found; }
  } else if (template?.strings) {
    if (template.strings[0].includes('<app-switch')) return template;
    return enhancementSwitch(template.values);
  }
}
function switchProperty(template, property) {
  const control = enhancementSwitch(template);
  assert.ok(control, 'Image Enhancements switch exists in the inert template');
  const index = control.strings.findIndex(part => part.endsWith(`.${property}=`));
  assert.notEqual(index, -1, `${property} binding exists`);
  return control.values[index];
}
function imageModeContext(baseline = true, enabled = false) {
  const ctx = context();
  ctx.galaxy.baselineRequested = baseline;
  ctx.galaxy.imageEnhancementsEnabled = enabled;
  ctx.galaxy.setImageEnhancements = async (value, accepted) => {
    ctx.calls.push({ action: 'setImageEnhancements', enabled: value, accepted });
    ctx.galaxy.imageEnhancementsEnabled = value;
    return true;
  };
  return ctx;
}
async function test(name, fn) {
  try { await fn(); results.push({ test: name, passed: true }); console.log('PASS ' + name); }
  catch (error) { results.push({ test: name, passed: false, error: String(error) }); console.error('FAIL ' + name, error); process.exitCode = 1; }
}
(async () => {
  for (const [state, version, available] of [
    ['checking', undefined, false], ['not-installed', undefined, false], ['unknown', '1.2.3', false],
    ['installed', undefined, false], ['installed', '1.2.3', true], ['checking', '1.2.3', true],
  ]) await test(`Stable navigation: ${state} / ${version ?? 'no version'}`, () => {
    assert.equal(nav.driverAvailable(version, state), available);
    const routes = Array.from(nav.visibleRoutes(available));
    assert.equal(routes[0], available ? 'driver-settings' : 'app-settings'); assert.ok(routes.includes('setup'));
    assert.deepEqual(routes.filter(r => ['app-settings', 'setup', 'about'].includes(r)), ['app-settings', 'setup', 'about']);
    for (const route of nav.ROUTES) assert.equal(nav.permittedRoute(route, available), routes.includes(route) ? route : 'setup');
  });
  await test('Default and invalid hashes land on Setup uninstalled, Driver Settings installed; explicit deep links remain valid', () => {
    for (const hash of ['', '#/', '#/missing']) {
      assert.equal(nav.parseRoute(hash, false), 'setup');
      assert.equal(nav.parseRoute(hash, true), 'driver-settings');
    }
    for (const route of nav.ROUTES) assert.equal(nav.parseRoute('#/' + route, false), route);
  });
  for (const options of [{ installed: false }, {}, { upgrade: true }, { state: 'checking' }, { installed: false, state: 'unknown' }, { enabled: false }, { steamvr: false, installed: false }]) {
    await test(`Single install control and correct card ownership: ${JSON.stringify(options)}`, () => {
      const { template } = render(SetupPage, context(options));
      const sections = cards(template); assert.equal(sections.length, 4);
      assert.match(markup(sections[0]), /Galaxy XR Companion/); assert.match(markup(sections[0]), /A standalone SteamVR vendor driver/);
      assert.match(markup(sections[1]), /Set up your headset/); assert.match(markup(sections[1]), /Installed Driver Version/);
      assert.match(markup(sections[1]), /Restart Compositor/);
      assert.match(markup(sections[2]), /Installation and settings check/);
      assert.match(markup(sections[3]), /Cleanup/); assert.match(markup(sections[3]), /Clean Settings/);
      const labels = buttonLabels(template);
      assert.equal(labels.filter(label => /^(Install Driver|Re-Install Driver|Install 1\.2\.3)$/.test(label)).length, 1);
      assert.equal(labels.filter(label => label === 'Uninstall Driver').length, options.installed === false ? 0 : 1);
      assert.equal(buttonLabels(sections[3]).filter(label => label === 'Uninstall Driver').length, options.installed === false ? 0 : 1);
      assert.doesNotMatch(markup(sections[1]), /Uninstall Driver/);
      assert.doesNotMatch(markup(template), /App Version|Donation Links|Source Code and Releases/);
    });
  }
  await test('Install, update, and reinstall reuse the same single button', () => {
    assert.ok(buttonLabels(render(SetupPage, context({ installed: false })).template).includes('Install Driver'));
    assert.ok(buttonLabels(render(SetupPage, context({ upgrade: true })).template).includes('Install 1.2.3'));
    assert.ok(buttonLabels(render(SetupPage, context()).template).includes('Re-Install Driver'));
  });
  for (const options of [{ busy: true }, { checking: true }, { launching: true }]) await test(`Actions are disabled while busy: ${JSON.stringify(options)}`, () => {
    const html = markup(render(SetupPage, context(options)).template);
    // Collapsible section headings only change layout, not driver state.
    const actions=[...html.matchAll(/<button\b([^>]*)>/g)].filter(match=>!match[1].includes('section-title'));
    assert.ok(actions.length>0);for (const match of actions) assert.match(match[1], /\bdisabled\b/);
  });
  for (const installed of [false,true]) for (const status of ['stopped','running','unknown']) await test(`Cleanup buttons require confirmed stopped SteamVR: installed=${installed}, ${status}`,()=>{
    const ctx=context({installed,running:status==='running',runtimeUnknown:status==='unknown'});
    const buttons=[...markup(render(SetupPage,ctx).template).matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
      .filter(match=>['Clean Settings','Uninstall Driver'].includes(match[2].trim()));
    assert.equal(buttons.length,installed?2:1);
    for(const button of buttons)assert.equal(/\bdisabled\b/.test(button[1]),status!=='stopped',button[2]);
  });
  await test('A launch request is not displayed as verified initialization', () => {
    assert.doesNotMatch(markup(render(SetupPage, context({ running: true })).template), /Driver initialization verified in SteamVR\./);
    assert.match(markup(render(SetupPage, context({ running: true, initialized: true })).template), /Driver initialization verified in SteamVR\./);
  });
  for (const options of [{}, { update: true }, { noVersion: true }]) await test(`About contains one Links card and no setup actions: ${JSON.stringify(options)}`, () => {
    const { template } = render(AboutPage, context(options)); const sections = cards(template);
    assert.equal(sections.length, 1); assert.match(markup(sections[0]), /Links/);
    if (!options.noVersion) assert.match(markup(sections[0]), /App Version/);
    for (const text of ['Source Code and Releases', 'Documentation', 'Report a Problem', 'Based On', 'Galaxy XR icons', 'Donation Links']) assert.ok(markup(sections[0]).includes(text));
    assert.doesNotMatch(markup(template), /Install Driver|Uninstall Driver|Restart Compositor|Clean Settings|Set up your headset/);
  });
  await test('App Settings notices remain inside Application preferences', () => {
    const ctx = context(); ctx.appSetting.readFileError.set(new Error('fixture')); ctx.galaxy.imageModeError.set('mode fixture');
    const sections = cards(render(AppSettingsPage, ctx).template); assert.equal(sections.length, 1);
    assert.match(markup(sections[0]), /Application preferences/); assert.match(markup(sections[0]), /Check installation on Setup/); assert.match(markup(sections[0]), /mode fixture/);
  });
  await test('Image Enhancement page handler: cancelled warning leaves settings and switch off', async () => {
    const ctx = imageModeContext(), prompts = [];
    ctx.dialog.confirm = async (...args) => { prompts.push(args); return false; };
    const { page } = render(AppSettingsPage, ctx), control = { checked: true };
    await page.setImageEnhancements(true, control);
    assert.equal(prompts.length, 1); assert.deepEqual(ctx.calls, []);
    assert.equal(ctx.galaxy.imageEnhancementsEnabled, false); assert.equal(control.checked, false);
    assert.match(prompts[0][0], /SDR 10-bit/);
    assert.match(prompts[0][1], /reduce image quality/);
    assert.match(prompts[0][1], /does not guarantee.*10-bit precision/);
    assert.match(prompts[0][2], /I understand/); assert.equal(prompts[0][3], 'danger');
  });
  await test('Image Enhancement page handler: acceptance forwards explicit consent and updates switch', async () => {
    const ctx = imageModeContext(); let prompts = 0;
    ctx.dialog.confirm = async () => { prompts++; return true; };
    const { page } = render(AppSettingsPage, ctx), control = { checked: true };
    await page.setImageEnhancements(true, control);
    assert.equal(prompts, 1);
    assert.deepEqual(ctx.calls, [{ action: 'setImageEnhancements', enabled: true, accepted: true }]);
    assert.equal(control.checked, true); assert.equal(ctx.galaxy.baselineRequested, true);
  });
  await test('Image Enhancement page handler: ordinary enable and disable do not show a warning', async () => {
    for (const [baseline, enabled, requested] of [[false, false, true], [true, true, false]]) {
      const ctx = imageModeContext(baseline, enabled); let prompts = 0;
      ctx.dialog.confirm = async () => { prompts++; return true; };
      const { page } = render(AppSettingsPage, ctx), control = { checked: requested };
      await page.setImageEnhancements(requested, control);
      assert.equal(prompts, 0);
      assert.deepEqual(ctx.calls, [{ action: 'setImageEnhancements', enabled: requested, accepted: false }]);
      assert.equal(control.checked, requested);
    }
  });
  await test('Image Enhancement page handler: pending warning blocks duplicate toggles', async () => {
    const ctx = imageModeContext(); let resolveWarning, prompts = 0;
    ctx.dialog.confirm = () => { prompts++; return new Promise(resolve => { resolveWarning = resolve; }); };
    const { page } = render(AppSettingsPage, ctx), control = { checked: true };
    const pending = page.setImageEnhancements(true, control);
    assert.equal(control.checked, false);
    assert.equal(switchProperty(page.render(), 'disabled'), true);
    await page.setImageEnhancements(true, control);
    await page.setImageEnhancements(false, control);
    assert.equal(prompts, 1); assert.deepEqual(ctx.calls, []);
    resolveWarning(true); await pending;
    assert.deepEqual(ctx.calls, [{ action: 'setImageEnhancements', enabled: true, accepted: true }]);
    assert.equal(control.checked, true); assert.equal(switchProperty(page.render(), 'disabled'), false);
  });
  await test('Image Enhancement inert template: baseline permits the switch only with installed known settings', () => {
    const ctx = imageModeContext();
    const { page } = render(AppSettingsPage, ctx);
    assert.equal(switchProperty(page.render(), 'disabled'), false);
    assert.equal(switchProperty(page.render(), 'known'), true);
    ctx.dss.values.set(undefined);
    assert.equal(switchProperty(page.render(), 'disabled'), true);
    ctx.dss.values.set({}); ctx.dss.readFileError.set(new Error('unknown settings'));
    assert.equal(switchProperty(page.render(), 'disabled'), true);
    ctx.dss.readFileError.set(undefined); ctx.sds.driverInstalled.set(undefined); ctx.sds.driverState.set('not-installed');
    assert.equal(switchProperty(page.render(), 'disabled'), true);
  });
  await test('Troubleshooting uses a complete card and links to the single Setup install action', () => {
    const { page } = render(DriverTroubleshooter, context({ installed: false })); page.wait = true;
    const template = page.render(); assert.equal(cards(template).length, 1);
    assert.match(markup(template), /System not ready/); assert.match(markup(template), /href="#\/setup"/);
    assert.ok(!buttonLabels(template).includes('Install Driver'));
  });
  await test('Setup renders in the shell before and after installation', () => {
    for (const installed of [false, true]) {
      const shell = new AppShell(); shell.ctx = context({ installed }); shell.route = 'setup';
      const text = markup(shell.render()); assert.match(text, /app-setup-page/);
      assert.match(text, /activeid="tab-setup"/);
      const tabs = [...text.matchAll(/<fluent-tab\b[^>]* id="([^"]+)"/g)].map(match => match[1]);
      assert.ok(tabs.includes('tab-setup'));
      if (installed) assert.deepEqual(tabs, ['tab-driver-settings', 'tab-stream-frame', 'tab-distortion-profile', 'tab-app-settings', 'tab-setup', 'tab-about']);
      else assert.deepEqual(tabs, ['tab-app-settings', 'tab-setup', 'tab-about']);
    }
  });
  await test('Setup is explicitly retained in the production element registry', () => {
    const source = fs.readFileSync(path.join(root, 'src-lit/register.ts'), 'utf8');
    assert.match(source, /import \{ SetupPage \} from '\.\/features\/setup-page'/);
    assert.match(source, /\n  SetupPage,/);
  });
  await test('Driver deep links survive initial checking and redirect to Setup only after a definitive result', () => {
    const shell = new AppShell(); shell.ctx = context({ installed: false, state: 'checking' });
    windowMock.location.hash = '#/driver-settings'; shell.syncRoute();
    assert.equal(windowMock.location.hash, '#/driver-settings'); assert.equal(shell.route, 'setup');
    shell.ctx.sds.driverState.set('not-installed'); shell.syncRoute(); assert.equal(windowMock.location.hash, '#/setup');
  });
  await test('Successful install invalidates stale reports and names Setup in the next-step dialog', async () => {
    const ctx = context({ installed: false }); const { page } = render(SetupPage, ctx); await page.installDriver();
    assert.deepEqual(ctx.calls.slice(0, 3), ['install', 'invalidate', 'clear']);
    assert.match(ctx.calls[3].message, /Start SteamVR on Setup/);
  });
  await test('Cancelled install does not invalidate runtime or show success', async () => {
    const ctx = context(); ctx.sds.installDriver = async () => false; await render(SetupPage, ctx).page.installDriver(); assert.deepEqual(ctx.calls, []);
  });
  await test('Cleanup calls the existing safe service and refreshes state', async () => {
    const ctx = context({verified:true}); await render(SetupPage, ctx).page.cleanSettings();
    assert.deepEqual(ctx.calls.slice(0, 6), ['runtime-refresh', 'clean', 'invalidate', 'clear', 'app-save', 'check-refresh']);
    assert.equal(ctx.appSetting.values().driverVerified,false);
    assert.match(ctx.calls[6].message, /start SteamVR from Setup/);
  });
  await test('Uninstall removes its button, preserves Cleanup, and leaves Setup selected', async () => {
    const ctx = context({verified:true}); const { page } = render(SetupPage, ctx); const shell = new AppShell(); shell.ctx = ctx;
    windowMock.location.hash = '#/setup'; await page.uninstallDriver(); shell.syncRoute();
    assert.equal(shell.route, 'setup'); assert.ok(buttonLabels(page.render()).includes('Install Driver'));
    assert.ok(buttonLabels(page.render()).includes('Clean Settings')); assert.ok(!buttonLabels(page.render()).includes('Uninstall Driver'));
    assert.deepEqual(ctx.calls.slice(0, 5), ['runtime-refresh', 'app-save', 'uninstall', 'invalidate', 'clear']);
    assert.equal(ctx.appSetting.values().driverVerified,false);
  });
  for(const action of ['cleanSettings','uninstallDriver'])for(const status of ['running','unknown'])await test(`${action} rejects ${status} after fresh check and keeps verification`,async()=>{
    const ctx=context({verified:true,running:status==='running',runtimeUnknown:status==='unknown'});
    await render(SetupPage,ctx).page[action]();
    assert.deepEqual(ctx.calls,['runtime-refresh']);assert.equal(ctx.appSetting.values().driverVerified,true);
  });
  for(const action of ['cleanSettings','uninstallDriver'])for(const status of ['running','unknown'])await test(`${action} rejects stale stopped state when async refresh becomes ${status}`,async()=>{
    const ctx=context({verified:true});let release;
    ctx.startup.refresh=()=>{ctx.calls.push('runtime-refresh');return new Promise(resolve=>{release=()=>{ctx.startup.status.set(status==='running'?{steamvrRunning:true,driverInitialized:false}:undefined);resolve();};});};
    const pending=render(SetupPage,ctx).page[action]();assert.deepEqual(ctx.calls,['runtime-refresh']);
    assert.equal(ctx.appSetting.values().driverVerified,true);release();await pending;
    assert.deepEqual(ctx.calls,['runtime-refresh']);assert.equal(ctx.appSetting.values().driverVerified,true);
  });
  await test('Confirmed stopped permits Clean Settings before installation and without SteamVR path',async()=>{
    const ctx=context({installed:false,steamvr:false});await render(SetupPage,ctx).page.cleanSettings();
    assert.deepEqual(ctx.calls.slice(0,5),['runtime-refresh','clean','invalidate','clear','check-refresh']);assert.equal(ctx.sds.driverInstalled(),undefined);
  });
  await test('Only mounted Setup polls runtime; leaving it cancels polling', async () => {
    const ctx = context(); const setup = render(SetupPage, ctx).page;
    setup.connectedCallback(); await new Promise(resolve => setImmediate(resolve)); assert.ok(ctx.calls.includes('runtime-refresh')); assert.equal(timers.size, 1);
    setup.disconnectedCallback(); assert.equal(timers.size, 0);
    const about = render(AboutPage, ctx).page; const count = ctx.calls.length; about.connectedCallback(); await Promise.resolve();
    assert.equal(ctx.calls.length, count); assert.equal(timers.size, 0); about.disconnectedCallback();
  });
  await test('Production views contain only one install and one uninstall click binding', () => {
    const sources = fs.readdirSync(path.join(root, 'src-lit/features')).filter(f => f.endsWith('.ts'))
      .map(file => fs.readFileSync(path.join(root, 'src-lit/features', file), 'utf8')).join('\n');
    assert.equal((sources.match(/@click=\$\{\(\) => (?:this|sds)\.installDriver\(\)\}/g) ?? []).length, 1);
    assert.equal((sources.match(/@click=\$\{\(\) => (?:this|sds)\.uninstallDriver\(\)\}/g) ?? []).length, 1);
  });
  await test('No stale About/App Settings installation directions remain in production views or services', () => {
    for (const dir of ['features', 'services']) for (const name of fs.readdirSync(path.join(root, 'src-lit', dir)).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
      const source = fs.readFileSync(path.join(root, 'src-lit', dir, name), 'utf8');
      assert.doesNotMatch(source, /(?:Start SteamVR on About|start SteamVR from About|return to About|check on the About page|check installation on About|Open App Settings to check installation)/, name);
    }
  });
  if (process.env.SETUP_LAYOUT_FIXTURES) {
    const dir = path.resolve(process.env.SETUP_LAYOUT_FIXTURES); fs.mkdirSync(dir, { recursive: true });
    for (const [name, Page, options] of [['setup-uninstalled', SetupPage, { installed: false }], ['setup-installed', SetupPage, {}], ['about', AboutPage, {}]]) {
      const { template } = render(Page, context(options));
      const styles = Page.styles.map(style => style.cssText).join('\n').replaceAll(':host', '.page');
      const variables = '--colorNeutralForeground1:#242424;--colorNeutralBackground1:#fff;--colorNeutralBackground2:#fafafa;--colorNeutralBackground3:#f5f5f5;--colorNeutralStroke2:#d1d1d1;--colorNeutralStroke1:#c7c7c7;--colorBrandStroke1:#0f6cbd;--colorNeutralStrokeAccessible:#616161;--colorPaletteGreenForeground1:#107c10;--colorPaletteDarkOrangeForeground1:#a85000;';
      const base = require('node:url').pathToFileURL(path.join(root, 'public') + path.sep).href;
      fs.writeFileSync(path.join(dir, name + '.html'), `<!doctype html><html><head><meta charset="utf-8"><base href="${base}"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${name} — layout-only fixture</title><style>:root{${variables}}body{margin:0;font:16px "Segoe UI",system-ui,sans-serif;background:var(--colorNeutralBackground2)}.fixture-note{font:12px system-ui;padding:8px 16px;margin:0} ${styles}</style></head><body><p class="fixture-note">Layout-only fixture using the source templates and CSS, inert Lit template adapter, and simulated state. Not the production Tauri/Fluent application.</p><main class="page">${markup(template)}</main></body></html>`);
    }
  }
  console.log(`\nSetup layout checks: ${results.filter(r => r.passed).length}/${results.length} passed (inert template adapter; not production Lit/Fluent).`);
  if (process.env.SETUP_LAYOUT_REPORT) fs.writeFileSync(process.env.SETUP_LAYOUT_REPORT, JSON.stringify(results, null, 2) + '\n');
})().catch(error => { console.error(error); process.exitCode = 1; });
