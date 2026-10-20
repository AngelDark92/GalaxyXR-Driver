#!/usr/bin/env node
'use strict';
// Production assets + in-memory IPC. Native lifecycle is checked separately
// with Test-CurvePreviewPackaged.cjs; this never reads/writes user settings.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const dist = path.resolve(__dirname, '../../builds/GalaxyXR-Driver/gui/dist/fluent');

function fixture() {
  const callbacks = new Map(), listeners = new Map(); let id = 0;
  const calls = []; const state = { curve: 1, constancyPct: 35, ceilingMbit: 450, clampMbit: 350 };
  window.__curveQA = { calls, update(next) {
    Object.assign(state, next);
    for (const callback of listeners.values()) callback({ event: 'curve-preview-changed', payload: { ...state } });
  } };
  window.__TAURI_INTERNALS__ = {
    transformCallback(callback) { callbacks.set(++id, callback); return id; },
    unregisterCallback(key) { callbacks.delete(key); },
    async invoke(command, args = {}) {
      calls.push(command);
      if (command === 'plugin:event|listen') { listeners.set(args.handler, callbacks.get(args.handler)); return args.handler; }
      if (command === 'plugin:event|unlisten') { listeners.delete(args.eventId); return; }
      if (command === 'curve_preview_state') return { ...state };
      if (command === 'close_curve_preview') return;
      throw Error('Unexpected graph command: ' + command);
    },
  };
}

(async () => {
  const server = http.createServer((req, res) => {
    const file = path.resolve(dist, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
    if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' }[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ channel: process.env.COMPANION_BROWSER || 'msedge', headless: true });
    const context = await browser.newContext({ viewport: { width: 760, height: 520 } });
    await context.addInitScript(fixture);
    for (const locale of ['en-US', 'zh-Hant', 'ja']) {
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(String(error)));
      await page.goto(`http://127.0.0.1:${server.address().port}/${locale}/curve.html`);
      const canvas = page.locator('app-bitrate-curve canvas'); await canvas.waitFor();
      const before = await canvas.evaluate(el => el.toDataURL());
      await page.evaluate(() => window.__curveQA.update({ curve: 2, constancyPct: 75 }));
      await page.waitForFunction(() => document.querySelector('app-curve-preview')?.shadowRoot?.querySelector('app-bitrate-curve')?.pct === 75);
      await page.waitForFunction(old => document.querySelector('app-curve-preview').shadowRoot.querySelector('app-bitrate-curve').shadowRoot.querySelector('canvas').toDataURL() !== old, before);
      await page.setViewportSize({ width: 480, height: 320 });
      const box = await canvas.boundingBox(); assert.ok(box.width <= 440 && box.width > 300);
      await page.locator('#close').click(); await page.keyboard.press('Escape');
      const calls = await page.evaluate(() => window.__curveQA.calls);
      assert.equal(calls.filter(c => c === 'close_curve_preview').length, 2);
      assert.equal(calls.filter(c => c === 'curve_preview_state').length, 1);
      assert.deepEqual(errors, []);
      await page.evaluate(() => window.__curveQA.update({ clampMbit: 0 }));
      await page.getByRole('alert').filter({ hasText: 'Cannot plot' }).waitFor();
      assert.equal(await canvas.count(), 0, 'invalid values must not be silently substituted');
      await page.close(); console.log(`PASS ${locale}: packaged graph, live pixels, resize, Close/Escape, read-only IPC, invalid values`);
    }
    const broken = await context.newPage();
    await broken.route('**/assets/curve-preview-window-*.js', route => route.abort());
    await broken.goto(`http://127.0.0.1:${server.address().port}/en-US/curve.html`);
    await broken.locator('#error').waitFor();
    await broken.locator('#close').click(); await broken.keyboard.press('Escape');
    assert.equal(await broken.evaluate(() => window.__curveQA.calls.filter(c => c === 'close_curve_preview').length), 2);
    console.log('PASS failed graph-module load still exposes Close, Escape and an error');
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
