#!/usr/bin/env node
'use strict';
// Explicit local native QA, using an already registered driver. Never installs
// or calls SteamVR. Curve edits are made through real controls with persistence
// intercepted in this test process; user settings must remain byte-identical.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const exe = process.argv[2];
if (!exe || !fs.existsSync(exe)) throw Error('Usage: node tools/Test-CurvePreviewPackaged.cjs <packaged Companion.exe>');
const out = path.resolve(__dirname, '../../builds/GalaxyXR-Driver/build/curve-window-validation');
fs.mkdirSync(out, { recursive: true });
const ps = script => execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true }).trim();
const graphProcesses = () => JSON.parse(ps("ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe'\" | Where-Object { $_.CommandLine -like '*curve-preview-webview*' } | Select-Object ProcessId,ParentProcessId)") || '[]');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, description) { for (let i=0;i<100;i++) { const value = await fn(); if (value) return value; await delay(100); } throw Error('Timed out: ' + description); }

(async () => {
  assert.equal(ps("@(Get-Process | Where-Object { $_.ProcessName -match '^(galaxyxrdriver-gui|Galaxy XR Companion|vrserver|vrcompositor)$' }).Count"), '0', 'Close other Companion/SteamVR sessions before this explicit QA');
  const settingsPath = path.join(process.env.APPDATA, 'GalaxyXR/CustomHeadset/settings.json');
  const settingsBefore = fs.readFileSync(settingsPath);
  assert.deepEqual(graphProcesses(), [], 'no graph background process before Open');
  const profile = path.join(process.env.LOCALAPPDATA, 'com.sboys3.custom-headset');
  const app = spawn(path.resolve(exe), [], { env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=0' }, stdio: 'ignore' });
  const closed = new Promise(resolve => app.on('exit', resolve));
  let browser, main, graph;
  const receipt = { executable: path.resolve(exe), sha256: createHash('sha256').update(fs.readFileSync(exe)).digest('hex'), pid: app.pid, checks: [] };
  const probe = action => execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'Probe-CurvePreviewWindow.ps1'), '-CompanionPid', String(app.pid), '-Action', action], { encoding: 'utf8', windowsHide: true }).trim();
  const endpoint = folder => {
    const file = path.join(folder, 'EBWebView/DevToolsActivePort');
    if (!fs.existsSync(file)) return undefined;
    const port = Number(fs.readFileSync(file, 'utf8').split('\n')[0]);
    return port > 0 ? `http://127.0.0.1:${port}` : undefined;
  };
  try {
    await until(async () => { try { const url = endpoint(profile); if (!url) return false; browser = await chromium.connectOverCDP(url); return true; } catch { return false; } }, 'Companion CDP');
    main = browser.contexts()[0].pages()[0]; main.setDefaultTimeout(10000);
    await main.waitForFunction(() => window.appContext?.sds.driverState() === 'installed');
    // The test does not change persistence behavior in the shipped code. It
    // intercepts this one process's saves to protect the user's settings.
    await main.evaluate(() => {
      const c = window.appContext;
      c.galaxy.save = () => c.galaxy.revision.update(x => x + 1);
      location.hash = '/stream-frame';
    });
    const open = main.locator('fluent-button').filter({ hasText: 'Open graph window' });
    await main.screenshot({ path: path.join(out, 'companion-before-open.png') });
    await open.waitFor();
    const openGraph = async () => {
      await open.click();
      let graphBrowser;
      await until(async () => {
        try { const url = endpoint(path.join(profile, 'curve-preview-webview')); if (!url) return false;
          graphBrowser = await chromium.connectOverCDP(url); return true;
        } catch { return false; }
      }, 'graph debug target');
      // Each WebView2 environment can publish a separate CDP browser target.
      await until(() => { graph = graphBrowser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('/curve.html')); return graph; }, 'graph navigation');
      graph.setDefaultTimeout(10000);
      await graph.locator('app-bitrate-curve canvas').waitFor();
      return graphBrowser;
    };
    await openGraph();
    receipt.checks.push('Installed driver makes Image Settings reachable; real Open graph window button renders packaged graph');
    receipt.graphProcesses = graphProcesses(); assert.ok(receipt.graphProcesses.length > 0);
    const before = JSON.parse(probe('measure')), after = JSON.parse(probe('move'));
    assert.notDeepEqual(after, before); assert.equal(after.width, 920); assert.equal(after.height, 640);
    receipt.checks.push('Separate OS window moved and resized to 920x640');
    const imageBefore = await graph.locator('app-bitrate-curve canvas').evaluate(el => el.toDataURL());
    const pct = main.locator('[data-setting-id="streamFrame.nvencBitrateConstancyPct"] input');
    assert.equal(await pct.isEnabled(), true, 'no false SteamVR lock');
    await pct.fill('75');
    await graph.waitForFunction(old => document.querySelector('app-curve-preview').shadowRoot.querySelector('app-bitrate-curve').shadowRoot.querySelector('canvas').toDataURL() !== old, imageBefore);
    await graph.screenshot({ path: path.join(out, 'packaged-curve.png') });
    receipt.checks.push('Real percentage control changes graph pixels live');
    const family = main.locator('[data-setting-id="streamFrame.nvencBitrateCurve"] fluent-dropdown');
    await family.click();
    await main.locator('[data-setting-id="streamFrame.nvencBitrateCurve"] fluent-option').filter({ hasText: 'Power knee' }).click();
    await graph.waitForFunction(() => document.querySelector('app-curve-preview').shadowRoot.querySelector('app-bitrate-curve').curve === 1);
    receipt.checks.push('Real curve-family dropdown updates the graph live');
    await open.click();
    const targets = await (await fetch(endpoint(path.join(profile, 'curve-preview-webview')) + '/json/list')).json();
    assert.equal(targets.filter(t => t.url.includes('/curve.html')).length, 1);
    receipt.checks.push('Second Open reuses existing window');
    await graph.locator('#close').click();
    await until(() => graphProcesses().length === 0, 'graph processes exit after Close');
    assert.equal(app.exitCode, null); receipt.checks.push('Close releases graph processes; Companion stays running');
    await openGraph(); await graph.keyboard.press('Escape');
    await until(() => graphProcesses().length === 0, 'Escape closes graph');
    await openGraph(); probe('close');
    await until(() => graphProcesses().length === 0, 'own X closes graph');
    assert.equal(app.exitCode, null); receipt.checks.push('Reopen, Escape and own X work independently');
    await openGraph(); probe('close-main');
    await Promise.race([closed, delay(10000).then(() => { throw Error('Companion did not exit'); })]);
    await until(() => graphProcesses().length === 0, 'main close takes graph processes down');
    receipt.checks.push('Companion X closes Companion, graph and graph WebView2 processes');
    assert.deepEqual(fs.readFileSync(settingsPath), settingsBefore, 'settings.json stays byte-identical');
    receipt.checks.push('User settings stayed byte-identical; no install or driver actions');
    fs.writeFileSync(path.join(out, 'receipt.json'), JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify(receipt, null, 2));
  } finally {
    if (app.exitCode === null) { try { probe('close-main'); await Promise.race([closed, delay(2000)]); } catch {} }
    if (app.exitCode === null) app.kill();
    // CDP disconnect occurs automatically when the process exits.
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
