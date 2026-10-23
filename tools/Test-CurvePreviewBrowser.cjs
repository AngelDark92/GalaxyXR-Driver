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
  const calls = []; const edits = [], resets = [];
  const state = {
    curve: 1, constancyPct: 35, ceilingMbit: 450,
    points: [{ x: 0, y: 0 }, { x: 0.2, y: 0.2 }, { x: 0.4, y: 0.4 },
      { x: 0.6, y: 0.6 }, { x: 0.8, y: 0.8 }, { x: 1, y: 1 }, { x: 1, y: 1 }],
    locked: false,
  };
  window.__curveQA = { calls, edits, resets, update(next) {
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
      if (command === 'submit_curve_preview_edit') { edits.push(args.points); return; }
      if (command === 'submit_curve_preview_reset') { resets.push(true); return; }
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
    const context = await browser.newContext({ viewport: { width: 760, height: 640 } });
    await context.addInitScript(fixture);
    for (const locale of ['en-US', 'zh-Hant', 'ja']) {
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(String(error)));
      await page.goto(`http://127.0.0.1:${server.address().port}/${locale}/curve.html`);
      const canvas = page.locator('app-bitrate-curve canvas'); await canvas.waitFor();
      // Default window size: six numeric rows (P7 is the hidden fixed endpoint)
      // must be laid out without any pair overlapping, and every input must
      // stay inside its row.
      const layout = await page.evaluate(() => {
        const root = document.querySelector('app-curve-preview').shadowRoot
          .querySelector('app-bitrate-curve').shadowRoot;
        const rows = [...root.querySelectorAll('.point-row')];
        const rects = rows.map(row => {
          const r = row.getBoundingClientRect();
          return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
        });
        const overlaps = [];
        for (let i = 0; i < rects.length; i++) {
          for (let j = i + 1; j < rects.length; j++) {
            const a = rects[i], b = rects[j];
            if (a.left < b.right - 1 && b.left < a.right - 1
              && a.top < b.bottom - 1 && b.top < a.bottom - 1) overlaps.push([i, j]);
          }
        }
        const escaped = rows.some(row => {
          const outer = row.getBoundingClientRect();
          return [...row.querySelectorAll('input')].some(input => {
            const r = input.getBoundingClientRect();
            return r.left < outer.left - 1 || r.right > outer.right + 1;
          });
        });
        const locks = rows.map(row => [...row.querySelectorAll('input')].map(input => input.disabled));
        return { count: rows.length, overlaps, escaped, locks };
      });
      assert.equal(layout.count, 6);
      assert.deepEqual(layout.overlaps, []);
      assert.equal(layout.escaped, false);
      assert.deepEqual(layout.locks[0], [true, false], 'P1 locks request and edits floor');
      assert.deepEqual(layout.locks[5], [false, true], 'P6 moves request and locks target at max');
      const before = await canvas.evaluate(el => el.toDataURL());
      await page.evaluate(() => window.__curveQA.update({ curve: 2, constancyPct: 75 }));
      await page.waitForFunction(() => document.querySelector('app-curve-preview')?.shadowRoot?.querySelector('app-bitrate-curve')?.pct === 75);
      await page.waitForFunction(old => document.querySelector('app-curve-preview').shadowRoot.querySelector('app-bitrate-curve').shadowRoot.querySelector('canvas').toDataURL() !== old, before);
      // 2026-10-23: drag a middle handle and verify the preview relays a
      // seven-point edit to the main window instead of writing settings itself.
      const dragBox = await canvas.boundingBox();
      const px = dragBox.x + 56 + (dragBox.width - 56 - 16) * 0.4;
      const py = dragBox.y + 16 + (dragBox.height - 16 - 34) * 0.6;
      await page.mouse.move(px, py); await page.mouse.down();
      await page.mouse.move(px - 24, py - 18); await page.mouse.up();
      await page.waitForFunction(() => window.__curveQA.edits.length > 0);
      const edits = await page.evaluate(() => window.__curveQA.edits);
      assert.equal(edits.length, 1);
      assert.equal(edits[0].length, 7);
      assert.ok(edits[0][2].x < 0.4 || edits[0][2].y > 0.4, 'middle point moved');
      // P6 is the plateau knee: its x moves left while its y stays at Max
      // Bitrate. P7 remains anchored at (1,1).
      const p6x = dragBox.x + 56 + (dragBox.width - 56 - 16);
      const p6y = dragBox.y + 16 + 1;
      await page.mouse.move(p6x, p6y); await page.mouse.down();
      await page.mouse.move(p6x - 40, p6y + 8); await page.mouse.up();
      await page.waitForFunction(() => window.__curveQA.edits.length > 1);
      const plateau = await page.evaluate(() => window.__curveQA.edits[1]);
      assert.equal(plateau.length, 7);
      assert.equal(plateau[5].y, 1);
      assert.ok(plateau[5].x < 1 && plateau[5].x > plateau[4].x, 'P6 moved left and stayed ordered');
      assert.deepEqual(plateau[6], { x: 1, y: 1 });
      await page.setViewportSize({ width: 480, height: 320 });
      const box = await canvas.boundingBox(); assert.ok(box.width <= 440 && box.width > 300);
      await page.locator('#close').click(); await page.keyboard.press('Escape');
      const calls = await page.evaluate(() => window.__curveQA.calls);
      assert.equal(calls.filter(c => c === 'close_curve_preview').length, 2);
      assert.equal(calls.filter(c => c === 'curve_preview_state').length, 1);
      assert.deepEqual(errors, []);
      await page.evaluate(() => window.__curveQA.update({ ceilingMbit: 0 }));
      await page.getByRole('alert').filter({ hasText: 'Cannot plot' }).waitFor();
      assert.equal(await canvas.count(), 0, 'invalid values must not be silently substituted');
      await page.close(); console.log(`PASS ${locale}: packaged graph, live pixels, point-drag IPC, resize, Close/Escape, invalid values`);
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
