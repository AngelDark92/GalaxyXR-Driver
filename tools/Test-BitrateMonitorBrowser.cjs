#!/usr/bin/env node
'use strict';
// Production assets + in-memory IPC for the on-demand bitrate monitor.
// Native window creation/lifecycle is not exercised here; this checks that the
// packaged page starts sampling only after mount, renders counters/theme, and
// keeps Close/Escape available even when the feature module fails.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const dist = path.resolve(__dirname, '../../builds/GalaxyXR-Driver/gui/dist/fluent');

function fixture() {
  const callbacks = new Map(), listeners = new Map(); let id = 0;
  const calls = [], state = { theme: 'dark', infoPath: 'C:/GalaxyXR/CustomHeadset/info.json' };
  const preferences = { adbPath: '', serial: '', codecInterval: 5, defaultAdb: '', invalidInterval: false };
  window.__bitrateQA = {
    calls,
    config: null,
    starts: 0,
    stops: 0,
    closes: 0,
    saved: null,
    csv: null,
    emit(payload) {
      for (const entry of listeners.values()) {
        if (entry.event === 'bitrate-monitor-sample') entry.callback({ event: entry.event, payload });
      }
    },
  };
  window.__TAURI_INTERNALS__ = {
    transformCallback(callback) { callbacks.set(++id, callback); return id; },
    unregisterCallback(key) { callbacks.delete(key); },
    async invoke(command, args = {}) {
      calls.push(command);
      if (command === 'plugin:event|listen') { listeners.set(args.handler, { event: args.event, callback: callbacks.get(args.handler) }); return args.handler; }
      if (command === 'plugin:event|unlisten') { listeners.delete(args.eventId); return; }
      if (command === 'bitrate_monitor_environment') return { ...state };
      if (command === 'bitrate_monitor_preferences') return { ...preferences };
      if (command === 'start_bitrate_monitor') {
        window.__bitrateQA.starts += 1;
        window.__bitrateQA.config = args.config;
        return 7;
      }
      if (command === 'stop_bitrate_monitor') { window.__bitrateQA.stops += 1; return; }
      if (command === 'close_bitrate_monitor_window') { window.__bitrateQA.closes += 1; return; }
      if (command === 'save_bitrate_monitor_preferences') { window.__bitrateQA.saved = args.preferences; return; }
      if (command === 'write_bitrate_csv') { window.__bitrateQA.csv = args; return; }
      if (command === 'plugin:dialog|save') return 'C:/tmp/bitrate.csv';
      if (command === 'plugin:dialog|open') return null;
      throw Error('Unexpected bitrate monitor command: ' + command);
    },
  };
}

function nvencSample(time, bytes) {
  return {
    sourceId: 'nvenc:1234:session', monotonicTime: time, totalBytes: bytes, frames: 50,
    kind: 'nvenc', pid: 1234, moduleSha256: 'a'.repeat(64),
    codec: { codec: 'HEVC', label: 'HEVC / H.265', evidence: 'Annex B; VPS/SPS/PPS', ageSeconds: 0.2, frameSha256: 'b'.repeat(64) },
  };
}

function headsetSample() {
  return {
    sourceId: 'wlan_rx:USB123:boot:wlan0', monotonicTime: 100.5, totalBytes: 1_000_000_000,
    frames: null, kind: 'networkRxAllTraffic', serial: 'USB123', interface: 'wlan0',
  };
}

(async () => {
  const server = http.createServer((req, res) => {
    const file = path.resolve(dist, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
    if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' }[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ channel: process.env.COMPANION_BROWSER || 'msedge', headless: true });
    const context = await browser.newContext({ viewport: { width: 1080, height: 840 } });
    await context.addInitScript(fixture);
    for (const locale of ['en-US', 'zh-Hant', 'ja']) {
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(String(error)));
      await page.goto(`http://127.0.0.1:${server.address().port}/${locale}/bitrate.html`);
      await page.waitForFunction(() => window.__bitrateQA.starts === 1);
      const first = nvencSample(100, 9_000_000);
      const second = nvencSample(101, 10_000_000);
      await page.evaluate(sample => {
        window.__bitrateQA.emit({ generation: 7, source: 'nvenc', sample });
      }, first);
      await page.evaluate(sample => {
        window.__bitrateQA.emit({ generation: 7, source: 'nvenc', sample });
      }, second);
      await page.evaluate(sample => {
        window.__bitrateQA.emit({ generation: 7, source: 'headset', sample });
      }, headsetSample());
      // The decoder probe can re-publish the same row between advances; it must
      // not be treated as a zero-elapsed new window or an error.
      await page.evaluate(sample => {
        window.__bitrateQA.emit({ generation: 7, source: 'headset', sample });
      }, headsetSample());
      await page.waitForFunction(() => document.querySelector('app-bitrate-monitor')?.shadowRoot?.querySelector('.card.nvenc .current')?.textContent.trim() === '8.00');
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
      const config = await page.evaluate(() => window.__bitrateQA.config);
      assert.equal(config.infoPath, 'C:/GalaxyXR/CustomHeadset/info.json');
      assert.equal(config.codecInterval, 5);
      const codec = await page.locator('app-bitrate-monitor .card.nvenc .codec').textContent();
      assert.match(codec, /HEVC \/ H\.265/);
      const notes = await page.locator('app-bitrate-monitor .card.headset .status').textContent();
      assert.match(notes, /USB123/);
      assert.doesNotMatch(notes, /Unavailable/);
      if (process.env.BITRATE_QA_SCREENSHOT && locale === 'en-US') {
        await page.screenshot({ path: process.env.BITRATE_QA_SCREENSHOT, fullPage: true });
      }
      await page.locator('app-bitrate-monitor #export').click();
      await page.waitForFunction(() => window.__bitrateQA.csv !== null);
      const csv = await page.evaluate(() => window.__bitrateQA.csv);
      assert.match(csv.path, /bitrate\.csv$/);
      assert.match(csv.content, /current_mbps/);
      assert.match(csv.content, /nvenc/);
      const interval = page.locator('app-bitrate-monitor input[type="number"]');
      await interval.fill('10');
      await page.locator('app-bitrate-monitor #apply-interval').click();
      await page.waitForFunction(() => window.__bitrateQA.starts === 2);
      assert.equal(await page.evaluate(() => window.__bitrateQA.config.codecInterval), 10);
      assert.equal(await page.evaluate(() => window.__bitrateQA.saved.codecInterval), 10);
      // A session restart keeps completed windows; two fresh samples produce
      // another exportable row without reopening the window.
      await page.evaluate(() => { window.__bitrateQA.csv = null; });
      await page.evaluate(sample => {
        window.__bitrateQA.emit({ generation: 7, source: 'nvenc', sample });
      }, nvencSample(200, 20_000_000));
      await page.evaluate(sample => {
        window.__bitrateQA.emit({ generation: 7, source: 'nvenc', sample });
      }, nvencSample(201, 21_000_000));
      await page.locator('app-bitrate-monitor #export').click();
      await page.waitForFunction(() => window.__bitrateQA.csv !== null);
      assert.match(await page.evaluate(() => window.__bitrateQA.csv.content), /nvenc/);
      await page.setViewportSize({ width: 820, height: 640 });
      assert.equal(await page.evaluate(() => getComputedStyle(document.body).overflowY), 'auto');
      await page.locator('app-bitrate-monitor #pause').click();
      await page.waitForFunction(() => document.querySelector('app-bitrate-monitor')?.shadowRoot?.querySelector('.card.nvenc .current')?.textContent.trim() === '—');
      await page.locator('app-bitrate-monitor #reset').click();
      await page.locator('#close').click();
      await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(() => window.__bitrateQA.closes), 2);
      assert.equal(await page.evaluate(() => window.__bitrateQA.starts), 2);
      assert.deepEqual(errors, []);
      await page.close();
      console.log(`PASS ${locale}: packaged monitor, counters, codec/headset labeling, theme, CSV export, interval restart, Pause, Close/Escape`);
    }
    const broken = await context.newPage();
    await broken.route('**/assets/bitrate-monitor-window-*.js', route => route.abort());
    await broken.goto(`http://127.0.0.1:${server.address().port}/en-US/bitrate.html`);
    await broken.locator('#error').waitFor();
    await broken.locator('#close').click(); await broken.keyboard.press('Escape');
    assert.equal(await broken.evaluate(() => window.__bitrateQA.closes), 2);
    console.log('PASS failed monitor-module load still exposes Close, Escape and an error');
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
