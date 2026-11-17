#!/usr/bin/env node
'use strict';
// Real service graph, in-memory Tauri only; never touches installed/user files.
const assert = require('node:assert/strict');
const { harness, tick } = require('./Test-FluentFixes.cjs');
let passed = 0;
async function test(name, run) {
  try { await run(); passed++; console.log('PASS ' + name); }
  catch (error) { console.error('FAIL ' + name, error); process.exitCode = 1; }
}
function setup(fail = false) {
  const h = harness();
  const settings = h.fixture.data + '/settings.json';
  h.fixture.put(settings, { galaxyXr: { nativeIdentity: true }, streamFrame: {
    streamFrameSchema: 4, nvencSettingsVersion: 5, nvencTap: true,
    nvencPreset: 2, nvencForceCbr: false,
    postPack: { enable: true, limitedRange: true, casEnable: true },
  } });
  h.fixture.put(h.fixture.data + '/nvenc-settings-v4.migrated', 'preserved');
  h.fixture.put(h.fixture.data + '/info.json', { driverVersion: '1.2.3',
    defaultSettings: { streamFrame: { nvencTap: false, nvencPreset: 7 } } });
  const originalInvoke = h.api.invoke;
  let calls = 0;
  h.api.invoke = async (name, args) => {
    if (name !== 'restore_steamlink_encoder_behaviour') return originalInvoke(name, args);
    calls++;
    if (fail) throw new Error('SteamVR must be stopped');
    const before = h.fixture.files.get(settings);
    const backupPath = h.fixture.data + '/Backups/encoder/settings.json';
    h.fixture.put(backupPath, before);
    const next = JSON.parse(before); next.streamFrame.nvencTap = false;
    h.fixture.put(settings, next); h.fixture.emitWatch(settings);
    return { outcome: 'complete', backupPath, resetFiles: [settings], tapEnabled: false,
      warnings: [], unresolvedItems: [], preservedPaths: [h.fixture.data] };
  };
  return { h, settings, calls: () => calls };
}
async function settle(h) { await tick(); await h.source('platform/writer').flushFileWrites(); await tick(); }
(async () => {
  await test('Narrow restore preserves tuning, preferences, SteamVR, marker and survives reopening/stale telemetry', async () => {
    const { h, settings, calls } = setup(); let c = await h.app();
    const before = new Map(h.fixture.files), watchers = h.fixture.watchers.size;
    const report = await c.sds.restoreSteamLinkEncoderBehaviour();
    assert.equal(report.tapEnabled, false); assert.equal(calls(), 1);
    const expected = JSON.parse(before.get(settings)); expected.streamFrame.nvencTap = false;
    assert.deepEqual(JSON.parse(h.fixture.files.get(settings)), expected);
    for (const [file, content] of before) if (file !== settings) assert.equal(h.fixture.files.get(file), content, file);
    assert.equal(h.fixture.files.get(report.backupPath), before.get(settings));
    assert.equal(c.galaxy.rootSetting.streamFrame.nvencTap, false);
    assert.equal(h.fixture.watchers.size, watchers);
    await settle(h); c.dispose(); c = await h.app();
    assert.equal(c.dss.values().streamFrame.nvencTap, false);
    const next = structuredClone(c.dss.values()); next.streamFrame.nvencPreset = 3;
    const saved = c.dss.save(next); await settle(h); assert.equal(await saved, true);
    assert.equal(JSON.parse(h.fixture.files.get(settings)).streamFrame.nvencTap, false);
    c.dispose();
  });
  await test('Cancelled confirmation makes no native call or file changes', async () => {
    const { h, calls } = setup(); const c = await h.app(); const before = new Map(h.fixture.files);
    c.dialog.confirm = async () => false;
    assert.equal(await c.sds.restoreSteamLinkEncoderBehaviour(), undefined);
    assert.equal(calls(), 0); assert.deepEqual(h.fixture.files, before); c.dispose();
  });
  await test('Native failure restores disk-backed UI and releases inspection/write suspension', async () => {
    const { h, settings } = setup(true); const c = await h.app(); const before = new Map(h.fixture.files);
    assert.equal(await c.sds.restoreSteamLinkEncoderBehaviour(), undefined);
    assert.deepEqual(h.fixture.files, before);
    assert.equal(c.dss.inspecting, false); assert.equal(c.appSetting.inspecting, false);
    const next = structuredClone(c.dss.values()); next.streamFrame.nvencPreset = 4;
    const saved = c.dss.save(next); await settle(h); assert.equal(await saved, true);
    // Sparse saves omit true because it is the bundled default.
    assert.notEqual(JSON.parse(h.fixture.files.get(settings)).streamFrame.nvencTap, false);
    assert.equal(c.dss.values().streamFrame.nvencTap, true); c.dispose();
  });
  await test('Pending optimistic settings cannot overwrite restored Tap OFF', async () => {
    const { h, settings } = setup(); const c = await h.app();
    const next = structuredClone(c.dss.values()); next.streamFrame.nvencPreset = 7;
    const saved = c.dss.save(next);
    await c.sds.restoreSteamLinkEncoderBehaviour(); await settle(h);
    assert.equal(await saved, false);
    assert.equal(c.dss.values().streamFrame.nvencTap, false);
    assert.equal(JSON.parse(h.fixture.files.get(settings)).streamFrame.nvencTap, false); c.dispose();
  });
  await test('In-progress writes finish before native restore and cannot resurrect Tap', async () => {
    const { h, settings, calls } = setup(); const originalWrite = h.api.writeTextFile;
    let block = false, entered, release;
    const waiting = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    h.api.writeTextFile = async (file, text) => {
      if (block) { block = false; entered(); await gate; }
      return originalWrite(file, text);
    };
    const c = await h.app(); block = true;
    const next = structuredClone(c.dss.values()); next.streamFrame.nvencPreset = 6;
    const saved = c.dss.save(next), flushing = c.dss.flush(); await waiting;
    const restoring = c.sds.restoreSteamLinkEncoderBehaviour(); await tick();
    assert.equal(calls(), 0); release(); await flushing; await saved; await restoring; await settle(h);
    const disk = JSON.parse(h.fixture.files.get(settings));
    assert.equal(disk.streamFrame.nvencTap, false); assert.equal(disk.streamFrame.nvencPreset, 6);
    assert.equal(c.dss.values().streamFrame.nvencTap, false); c.dispose();
  });
  console.log(`Encoder restore: ${passed}/5 passed`);
})();
