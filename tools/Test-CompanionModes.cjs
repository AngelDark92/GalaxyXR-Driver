#!/usr/bin/env node
'use strict';
// Runs the actual service graph against the in-memory Tauri fixture. No SteamVR
// installation, user files, or processes are touched. Run after GUI npm ci.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { harness, tick } = require('./Test-FluentFixes.cjs');
const results = [];
const clone = value => JSON.parse(JSON.stringify(value));
async function test(name, fn) {
  try { await fn(); results.push({ test: name, passed: true }); console.log('PASS', name); }
  catch (error) { results.push({ test: name, passed: false, error: String(error) }); console.error('FAIL', name, error); process.exitCode = 1; }
}
async function scenario(change, run) {
  const h = harness();
  const initial = clone(h.source('domain/driver-defaults').driverDefaults);
  initial.streamFrame.streamFrameSchema = 4;
  initial.streamFrame.nvencSettingsVersion = 4;
  change(initial);
  h.fixture.put(h.fixture.data + '/settings.json', initial);
  const c = await h.app();
  try { await run(h, c, initial); }
  finally { c.dispose(); }
}
const writes = h => h.fixture.calls.filter(x => x.kind === 'write' && x.path === h.fixture.data + '/settings.json');

(async () => {
  const nav = harness().source('domain/navigation');
  for (const [state, version, available] of [
    ['checking', undefined, false], ['not-installed', undefined, false], ['unknown', '1.2.3', false],
    ['installed', undefined, false], ['installed', '1.2.3', true], ['checking', '1.2.3', true],
  ]) await test(`Navigation: ${state}, ${version ?? 'no verified version'}`, () => {
    assert.equal(nav.driverAvailable(version, state), available);
    assert.deepEqual(clone(nav.visibleRoutes(available)), available ? clone(nav.ROUTES) : ['app-settings', 'setup', 'about']);
    for (const route of nav.ROUTES) assert.equal(nav.permittedRoute(route, available), available || ['app-settings', 'setup', 'about'].includes(route) ? route : 'setup');
  });
  await test('Deep links are recognized but cannot bypass the installation gate', () => {
    for (const hash of ['#/driver-settings', '#stream-frame', '#/distortion-profile']) {
      assert.equal(nav.permittedRoute(nav.parseRoute(hash), false), 'setup');
    }
    assert.equal(nav.parseRoute('#/invalid-page', false), 'setup');
    assert.equal(nav.parseRoute('#/invalid-page', true), 'driver-settings');
    assert.equal(nav.parseRoute('#/app-settings', false), 'app-settings');
    assert.equal(nav.permittedRoute(nav.parseRoute('#/setup'), false), 'setup');
    assert.equal(nav.permittedRoute(nav.parseRoute('#/about'), false), 'about');
  });
  await test('Baseline reset is immutable and preserves unrelated and unknown settings', async () => scenario(s => {
    s.streamFrame.enable = false;
    s.streamFrame.brightness = 0.42; s.streamFrame.gamma = 1.8; s.streamFrame.saturation = 12;
    s.streamFrame.cas.enable = true; s.streamFrame.fxaa = 'quality';
    s.streamFrame.k1 = 0.15; s.streamFrame.distortion.curves = { left: { k1: 0.12, k2: 0.05, points: [] } };
    s.streamFrame.distortion.map = { enable: true, cols: 1, rows: 1, left: [0.1, 0.2], right: [0.1, 0.2], source: 'test', future: 42 };
    s.streamFrame.calib = { blackout: true, eye: 1, patternBrightness: 0.3, captureMode: true, pattern: 5, patternBits: 6 };
    s.streamFrame.nvencBitrateMbit = 450; s.streamFrame.kalmanMagScale = 1.7;
    s.controllers.positionOffsetCm.x = 4; s.galaxyXr.vrlinkHeadsetProfile = false;
    s.streamFrame.futureSetting = { keep: true }; s.futureRoot = { keep: 42 };
    s.customShader.enable = true; s.customShader.enableForOther = true;
  }, async (h, c, before) => {
    const count = writes(h).length;
    assert.equal(await c.galaxy.setSdr10Baseline(true), true);
    assert.equal(writes(h).length, count + 1, 'all changes are saved in one settings write');
    const after = c.dss.values();
    assert.equal(after.galaxyXr.sdr10Baseline, true); assert.equal(after.streamFrame.enable, false);
    assert.equal(after.streamFrame.brightness, c.galaxy.defaults.brightness);
    assert.equal(after.streamFrame.gamma, c.galaxy.defaults.gamma);
    assert.equal(after.streamFrame.saturation, c.galaxy.defaults.saturation);
    assert.equal(after.streamFrame.cas.enable, c.galaxy.defaults.cas.enable);
    assert.equal(after.streamFrame.fxaa, c.galaxy.defaults.fxaa);
    assert.deepEqual(clone(after.streamFrame.distortion.curves), {});
    assert.deepEqual(clone(after.streamFrame.distortion.map.left), []);
    assert.equal(after.streamFrame.distortion.map.future, 42);
    assert.equal(after.streamFrame.calib.blackout, false); assert.equal(after.streamFrame.calib.pattern, -1);
    assert.equal(after.streamFrame.nvencBitrateMbit, 450); assert.equal(after.streamFrame.kalmanMagScale, 1.7);
    assert.equal(after.controllers.positionOffsetCm.x, 4); assert.equal(after.galaxyXr.vrlinkHeadsetProfile, false);
    assert.deepEqual(clone(after.futureRoot), before.futureRoot);
    assert.deepEqual(clone(after.streamFrame.futureSetting), before.streamFrame.futureSetting);
    assert.equal(after.customShader.enableForOther, false); assert.equal(after.customShader.enable, true);
    assert.equal(before.streamFrame.brightness, 0.42, 'input fixture was not mutated');
  }));
  await test('Baseline cannot be enabled while Image Enhancements is on', async () => scenario(s => { s.streamFrame.enable = true; }, async (h, c) => {
    const count = writes(h).length;
    assert.equal(await c.galaxy.setSdr10Baseline(true), false);
    assert.equal(c.galaxy.baselineRequested, false); assert.equal(c.galaxy.imageEnhancementsEnabled, true);
    assert.equal(writes(h).length, count); assert.match(c.galaxy.imageModeError(), /Turn Image Enhancements off/);
  }));
  await test('Image Enhancements requires quality warning acceptance while baseline is on', async () => scenario(s => { s.galaxyXr.sdr10Baseline = true; }, async (h, c) => {
    const count = writes(h).length;
    assert.equal(await c.galaxy.setImageEnhancements(true), false);
    assert.equal(c.galaxy.imageEnhancementsEnabled, false); assert.equal(c.galaxy.baselineRequested, true);
    assert.equal(writes(h).length, count);
  }));
  await test('Accepted enhancements preserve baseline and tuning through save and reload', async () => scenario(s => {
    s.galaxyXr.sdr10Baseline = true; s.streamFrame.enable = false;
    s.streamFrame.gamma = 1.7; s.streamFrame.cas.enable = true; s.streamFrame.nvencBitrateMbit = 175;
  }, async (h, c) => {
    const before = clone(c.dss.values()), count = writes(h).length;
    assert.equal(await c.galaxy.setImageEnhancements(true, true), true);
    assert.equal(writes(h).length, count + 1, 'consent and enhancements are saved together');
    assert.equal(c.galaxy.baselineRequested, true); assert.equal(c.galaxy.imageEnhancementsEnabled, true);
    assert.equal(c.dss.values().galaxyXr.sdr10AllowEnhancements, true);
    assert.deepEqual(clone(c.dss.values().streamFrame), { ...before.streamFrame, enable: true });
    const disk = JSON.parse(h.fixture.files.get(h.fixture.data + '/settings.json'));
    assert.equal(disk.galaxyXr.sdr10Baseline, true); assert.equal(disk.galaxyXr.sdr10AllowEnhancements, true);
    await c.checks.refresh();
    assert.equal(c.galaxy.baselineRequested, true); assert.equal(c.galaxy.imageEnhancementsEnabled, true);
    assert.equal(c.dss.values().streamFrame.gamma, 1.7); assert.equal(c.dss.values().streamFrame.nvencBitrateMbit, 175);
  }));
  await test('Disabling accepted enhancements retains tuning and requires renewed consent', async () => scenario(s => {
    s.galaxyXr.sdr10Baseline = true; s.galaxyXr.sdr10AllowEnhancements = true; s.streamFrame.enable = true;
    s.streamFrame.gamma = 1.7; s.streamFrame.cas.enable = true;
  }, async (h, c) => {
    const before = clone(c.dss.values().streamFrame);
    assert.equal(c.galaxy.imageEnhancementsEnabled, true);
    assert.equal(await c.galaxy.setImageEnhancements(false), true);
    await c.checks.refresh();
    assert.equal(c.galaxy.baselineRequested, true); assert.equal(c.galaxy.imageEnhancementsEnabled, false);
    assert.equal(c.dss.values().galaxyXr.sdr10AllowEnhancements, false);
    assert.deepEqual(clone(c.dss.values().streamFrame), { ...before, enable: false });
    const count = writes(h).length;
    assert.equal(await c.galaxy.setImageEnhancements(true), false);
    assert.equal(writes(h).length, count);
  }));
  await test('Failed enhancement save rolls back consent and retains baseline and tuning', async () => scenario(s => {
    s.galaxyXr.sdr10Baseline = true; s.streamFrame.enable = false; s.streamFrame.gamma = 1.7;
  }, async (h, c) => {
    const before = clone(c.dss.values()), disk = h.fixture.files.get(h.fixture.data + '/settings.json');
    h.fixture.denied.add(h.fixture.data + '/settings.json');
    assert.equal(await c.galaxy.setImageEnhancements(true, true), false);
    assert.equal(c.galaxy.baselineRequested, true); assert.equal(c.galaxy.imageEnhancementsEnabled, false);
    assert.equal(c.dss.values().galaxyXr.sdr10AllowEnhancements, false);
    assert.deepEqual(clone(c.dss.values()), before);
    assert.equal(h.fixture.files.get(h.fixture.data + '/settings.json'), disk);
    assert.match(c.galaxy.imageModeError(), /Permission denied/); assert.equal(c.galaxy.imageModeChanging(), false);
  }));
  await test('Explicit transitions require the previous mode to be switched off', async () => scenario(s => { s.streamFrame.enable = true; }, async (h, c) => {
    assert.equal(await c.galaxy.setImageEnhancements(false), true);
    assert.equal(await c.galaxy.setSdr10Baseline(true), true);
    assert.equal(await c.galaxy.setSdr10Baseline(false), true);
    assert.equal(c.galaxy.imageEnhancementsEnabled, false);
    assert.equal(await c.galaxy.setImageEnhancements(true), true);
    assert.equal(c.galaxy.imageEnhancementsEnabled, true); assert.equal(c.galaxy.baselineRequested, false);
  }));
  await test('Turning the baseline off does not restore reset picture adjustments', async () => scenario(s => { s.streamFrame.gamma = 1.6; }, async (h, c) => {
    await c.galaxy.setSdr10Baseline(true); await c.galaxy.setSdr10Baseline(false);
    assert.equal(c.dss.values().streamFrame.gamma, c.galaxy.defaults.gamma);
    assert.equal(c.dss.values().streamFrame.enable, false);
  }));
  await test('Legacy overlapping flags show baseline priority without a write on inspection', async () => scenario(s => {
    s.streamFrame.enable = true; s.galaxyXr.sdr10Baseline = true; s.streamFrame.gamma = 1.4;
  }, async (h, c) => {
    const before = h.fixture.files.get(h.fixture.data + '/settings.json'), count = writes(h).length;
    await c.checks.refresh();
    assert.equal(c.galaxy.baselineRequested, true); assert.equal(c.galaxy.imageEnhancementsEnabled, false);
    assert.equal(h.fixture.files.get(h.fixture.data + '/settings.json'), before); assert.equal(writes(h).length, count);
    await c.galaxy.setSdr10Baseline(false);
    assert.equal(c.dss.values().streamFrame.enable, false); assert.equal(c.dss.values().streamFrame.gamma, 1.4);
  }));
  await test('Failed baseline save restores confirmed values and reports the error', async () => scenario(s => { s.streamFrame.gamma = 1.5; }, async (h, c) => {
    h.fixture.denied.add(h.fixture.data + '/settings.json');
    assert.equal(await c.galaxy.setSdr10Baseline(true), false);
    assert.equal(c.galaxy.baselineRequested, false); assert.equal(c.dss.values().streamFrame.gamma, 1.5);
    assert.match(c.galaxy.imageModeError(), /Permission denied/); assert.equal(c.galaxy.imageModeChanging(), false);
  }));
  await test('Unknown settings cannot be changed or replaced with defaults', async () => scenario(() => {}, async (h, c) => {
    h.fixture.put(h.fixture.data + '/settings.json', '{broken json'); await c.checks.refresh();
    assert.equal(await c.galaxy.setSdr10Baseline(true), false);
    assert.equal(h.fixture.files.get(h.fixture.data + '/settings.json'), '{broken json');
  }));
  await test('Concurrent mode changes cannot save both modes enabled', async () => scenario(() => {}, async (h, c) => {
    const a = c.galaxy.setSdr10Baseline(true), b = c.galaxy.setImageEnhancements(true);
    assert.equal(await b, false); assert.equal(await a, true);
    assert.equal(c.dss.values().galaxyXr.sdr10Baseline, true); assert.equal(c.dss.values().streamFrame.enable, false);
  }));
  await test('Mode changes wait for pending edits before choosing a snapshot', async () => scenario(() => {}, async (h, c) => {
    const values = clone(c.dss.values()); values.controllers.positionOffsetCm.x = 7;
    const save = c.dss.save(values); await tick(); const mode = c.galaxy.setSdr10Baseline(true);
    assert.equal(await save, true); assert.equal(await mode, true);
    assert.equal(c.dss.values().controllers.positionOffsetCm.x, 7);
  }));
  await test('Saved defaults may be omitted; effective readback still reports the correct modes', async () => scenario(() => {}, async (h, c) => {
    await c.galaxy.setSdr10Baseline(true); await c.checks.refresh();
    assert.equal(c.galaxy.baselineRequested, true); assert.equal(c.galaxy.imageEnhancementsEnabled, false);
    await c.galaxy.setSdr10Baseline(false); await c.checks.refresh();
    assert.equal(c.galaxy.baselineRequested, false); assert.equal(c.galaxy.imageEnhancementsEnabled, false);
    await c.galaxy.setImageEnhancements(true); await c.checks.refresh();
    assert.equal(c.galaxy.imageEnhancementsEnabled, true);
    const report = c.checks.report(); assert.equal(report.checks.find(x => x.key === 'streamFrame.enable').enabled, true);
  }));
  await test('Removed Supports 10-bit control does not erase old compatibility values', async () => scenario(s => { s.galaxyXr.profileSupports10bit = false; }, async (h, c) => {
    await c.galaxy.setSdr10Baseline(true);
    assert.equal(c.dss.values().galaxyXr.profileSupports10bit, false);
    const page = fs.readFileSync(path.join(__dirname, '../GalaxyXRDriverGUI/src-lit/features/driver-settings-page.ts'), 'utf8');
    assert.equal(page.includes("fieldRow(t('Profile: Supports 10-bit')"), false);
  }));
  await test('Disk inspection restores state after external mode edits', async () => scenario(() => {}, async (h, c) => {
    const values = clone(c.dss.values()); values.galaxyXr.sdr10Baseline = true; values.streamFrame.enable = false;
    h.fixture.put(h.fixture.data + '/settings.json', values); await c.checks.refresh();
    assert.equal(c.galaxy.baselineRequested, true); assert.equal(c.galaxy.imageEnhancementsEnabled, false);
  }));
  await test('Driver removal retains App Settings, Setup, and About', async () => scenario(() => {}, async (h, c) => {
    assert.equal(nav.driverAvailable(c.sds.driverInstalled(), c.sds.driverState()), true);
    h.fixture.files.delete(h.fixture.runtime + '/drivers/GalaxyXRNative/bin/win64/driver_GalaxyXRNative.dll');
    await c.checks.refresh();
    assert.equal(nav.driverAvailable(c.sds.driverInstalled(), c.sds.driverState()), false);
    assert.equal(nav.permittedRoute('about', false), 'about');
    assert.deepEqual(clone(nav.visibleRoutes(false)), ['app-settings', 'setup', 'about']);
    assert.equal(nav.permittedRoute('setup', false), 'setup');
  }));
  await test('Installed but SteamVR-disabled driver retains all tabs', async () => scenario(() => {}, async (h, c) => {
    h.fixture.put(h.fixture.config + '/steamvr.vrsettings', { driver_GalaxyXRNative: { enable: false } });
    await c.checks.refresh();
    assert.equal(nav.driverAvailable(c.sds.driverInstalled(), c.sds.driverState()), true);
    assert.equal(c.checks.report().driverEnabled, false);
  }));
  if (process.env.COMPANION_MODES_REPORT) fs.writeFileSync(process.env.COMPANION_MODES_REPORT, JSON.stringify(results, null, 2) + '\n');
  console.log(`\nCompanion modes/navigation: ${results.filter(x => x.passed).length}/${results.length} passed.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
