#!/usr/bin/env node
'use strict';
// Production assets + in-memory IPC. Native lifecycle is checked separately
// with Test-CurvePreviewPackaged.cjs; this never reads/writes user settings.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { chromium } = require('playwright');
const dist = path.resolve(__dirname, '../../builds/GalaxyXR-Driver/gui/dist/fluent');
const guiRequire = createRequire(path.resolve(__dirname, '../GalaxyXRDriverGUI/package.json'));
const ts = process.env.FLUENT_TEST_TYPESCRIPT ? require(process.env.FLUENT_TEST_TYPESCRIPT) : guiRequire('typescript');
// Use the production analytic helper as the oracle for rendered preset
// samples; no generated modules or duplicate curve implementation.
const curveModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname,
  '../GalaxyXRDriverGUI/src-lit/domain/bitrate-curve.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { module: curveModule, exports: curveModule.exports });
const { bitrateCurveMbit, bitrateCurvePointsForFamily } = curveModule.exports;

function fixture() {
  const callbacks = new Map(), listeners = new Map(); let id = 0;
  const calls = []; const edits = [], resets = [];
  const state = {
    curve: 1, constancyPct: 35, ceilingMbit: 450,
    requestReferenceMbit: 350, forceCbr: false, headroomPct: 0,
    points: [{ x: 0, y: 0 }, { x: 0.2, y: 0.2 }, { x: 0.4, y: 0.4 },
      { x: 0.6, y: 0.6 }, { x: 0.8, y: 0.8 }, { x: 1, y: 1 }, { x: 1, y: 1 }],
    locked: false,
  };
  window.__curveQA = { calls, edits, resets, plot: {}, update(next) {
    Object.assign(state, next);
    for (const callback of listeners.values()) callback({ event: 'curve-preview-changed', payload: { ...state } });
  } };
  // Capture the rendered drawing commands, in CSS pixels, so assertions can
  // distinguish the standard/reference line, base curve and final average.
  // Pixel-change checks below still verify that updates repaint the canvas.
  const prototype = CanvasRenderingContext2D.prototype, paths = new WeakMap();
  for (const method of ['clearRect', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'fillText', 'arc']) {
    const original = prototype[method];
    prototype[method] = function (...args) {
      const qa = window.__curveQA;
      if (method === 'clearRect') qa.plot = { strokes: [], texts: [], arcs: [] };
      else if (method === 'beginPath') paths.set(this, []);
      else if (method === 'moveTo' || method === 'lineTo') paths.get(this)?.push({ op: method, x: args[0], y: args[1] });
      else if (method === 'stroke') qa.plot.strokes?.push({ color: this.strokeStyle, width: this.lineWidth,
        dash: this.getLineDash(), path: [...(paths.get(this) || [])] });
      else if (method === 'fillText') qa.plot.texts?.push({ text: args[0], x: args[1], y: args[2] });
      else if (method === 'arc') qa.plot.arcs?.push({ x: args[0], y: args[1], radius: args[2] });
      return original.apply(this, args);
    };
  }
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

async function updateGraph(page, next) {
  await page.evaluate(value => window.__curveQA.update(value), next);
  await page.waitForFunction(value => {
    const graph = document.querySelector('app-curve-preview')?.shadowRoot?.querySelector('app-bitrate-curve');
    const fields = { curve: 'curve', constancyPct: 'pct', ceilingMbit: 'ceiling',
      requestReferenceMbit: 'requestReference', forceCbr: 'forceCbr', headroomPct: 'headroomPct', locked: 'locked', points: 'points' };
    return graph && Object.entries(value).every(([key, expected]) => !fields[key]
      || JSON.stringify(graph[fields[key]]) === JSON.stringify(expected));
  }, next);
  await page.evaluate(async () => {
    const graph = document.querySelector('app-curve-preview').shadowRoot.querySelector('app-bitrate-curve');
    await graph.updateComplete;
    await new Promise(requestAnimationFrame);
  });
}

async function graphDrawing(page) {
  return page.evaluate(() => {
    const graph = document.querySelector('app-curve-preview').shadowRoot.querySelector('app-bitrate-curve');
    const root = graph.shadowRoot, canvas = root.querySelector('canvas');
    return { width: canvas.clientWidth, height: canvas.clientHeight,
      inputs: [...root.querySelectorAll('.point-row')].map(row => [...row.querySelectorAll('input')]
        .map(input => ({ value: Number(input.value), max: Number(input.max), disabled: input.disabled }))),
      plot: window.__curveQA.plot };
  });
}

function close(actual, expected, message, tolerance = 1e-7) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${message}: ${actual} != ${expected}`);
}

async function checkScaledGraph(page, canvas) {
  const defaults = [{ x: 0, y: 0 }, { x: 0.2, y: 0.2 }, { x: 0.4, y: 0.4 },
    { x: 0.6, y: 0.6 }, { x: 0.8, y: 0.8 }, { x: 1, y: 1 }, { x: 1, y: 1 }];
  for (const max of [280, 350, 500, 800]) {
    const domain = Math.min(max, 350), yRange = Math.max(max, 350);
    await updateGraph(page, { curve: 3, constancyPct: 0, ceilingMbit: max, requestReferenceMbit: 350,
      forceCbr: false, headroomPct: 0, points: defaults, locked: false });
    const drawing = await graphDrawing(page);
    const xAt = value => 56 + (drawing.width - 56 - 16) * value / 350;
    const yAt = value => drawing.height - 34 - (drawing.height - 16 - 34) * value / yRange;
    assert.deepEqual(drawing.inputs[2].map(input => input.value), [Math.round(0.4 * domain), Math.round(0.4 * max)]);
    assert.deepEqual(drawing.inputs[2].map(input => input.max), [domain, max]);
    assert.deepEqual(drawing.inputs[0].map(input => input.disabled), [true, false]);
    assert.deepEqual(drawing.inputs[5].map(input => input.disabled), [false, true]);
    assert.deepEqual(drawing.inputs[5].map(input => input.value), [domain, max]);
    for (const value of new Set([350, max])) {
      assert.ok(drawing.plot.texts.some(label => label.text === String(value)
        && Math.abs(label.y - (yAt(value) + 4)) < 1e-7), `Max ${max}: exact ${value} y tick`);
    }
    assert.ok(drawing.plot.texts.some(label => label.text === '350'
      && Math.abs(label.y - (drawing.height - 20)) < 1e-7), `Max ${max}: reference x tick`);
    const standard = drawing.plot.strokes.find(stroke => stroke.dash.join(',') === '5,4');
    close(standard.path.at(-1).x, xAt(350), `Max ${max}: standard request endpoint`);
    close(standard.path.at(-1).y, yAt(350), `Max ${max}: standard target endpoint`);
    const base = drawing.plot.strokes.find(stroke => stroke.width === 1 && stroke.path.length === 81);
    const applied = drawing.plot.strokes.find(stroke => stroke.width === 2 && stroke.path.length === 81);
    for (const stroke of [base, applied]) {
      close(stroke.path.at(-1).x, xAt(350), `Max ${max}: curve covers full request range`);
      close(stroke.path.at(-1).y, yAt(max), `Max ${max}: curve reaches selected maximum`);
    }
    assert.ok(drawing.plot.strokes.some(stroke => stroke.width === 1.5
      && Math.abs(stroke.path[0]?.x - xAt(domain)) < 1e-7
      && Math.abs(stroke.path[0]?.y - yAt(max)) < 1e-7), `Max ${max}: endpoint uses D / Max`);
    if (max === 280) {
      assert.ok(base.path.filter(point => point.x >= xAt(280)).every(point => Math.abs(point.y - yAt(280)) < 1e-7),
        'Max 280: plateau extends from request 280 through 350');
    }

    // Drag in plotted Mbit/s coordinates, then inspect the normalized IPC
    // edit. Below 350 both canvas axes differ from the editing domain.
    await canvas.scrollIntoViewIfNeeded();
    const box = await canvas.boundingBox();
    const editsBefore = await page.evaluate(() => window.__curveQA.edits.length);
    await page.mouse.move(box.x + xAt(0.4 * domain), box.y + yAt(0.4 * max));
    await page.mouse.down();
    await page.mouse.move(box.x + xAt(0.35 * domain), box.y + yAt(0.45 * max));
    await page.mouse.up();
    await page.waitForFunction(count => window.__curveQA.edits.length === count + 1, editsBefore);
    const moved = await page.evaluate(() => window.__curveQA.edits.at(-1));
    close(moved[2].x, 0.35, `Max ${max}: inverse request projection`, 0.003);
    close(moved[2].y, 0.45, `Max ${max}: inverse target projection`, 0.003);
    assert.deepEqual(moved[0], defaults[0]);
    assert.deepEqual(moved[6], { x: 1, y: 1 });

    // Editing one whole-number field must preserve the other axis's exact
    // dragged value, even when its visible Mbit/s value was rounded.
    const fractional = defaults.map(point => ({ ...point }));
    fractional[2] = { x: 0.371234567, y: 0.432345678 };
    await updateGraph(page, { points: fractional });
    const requestInput = page.locator('app-bitrate-curve .point-row').nth(2).locator('input').nth(0);
    const targetInput = page.locator('app-bitrate-curve .point-row').nth(2).locator('input').nth(1);
    const requestValue = Math.round(domain * 0.36), targetValue = Math.round(max * 0.46);
    await requestInput.fill(String(requestValue)); await requestInput.dispatchEvent('change');
    const requestEdit = await page.evaluate(() => window.__curveQA.edits.at(-1));
    close(requestEdit[2].x, requestValue / domain, `Max ${max}: numeric request uses D`);
    assert.equal(requestEdit[2].y, fractional[2].y, `Max ${max}: request edit preserves target precision`);
    await targetInput.fill(String(targetValue)); await targetInput.dispatchEvent('change');
    const targetEdit = await page.evaluate(() => window.__curveQA.edits.at(-1));
    assert.equal(targetEdit[2].x, requestEdit[2].x, `Max ${max}: target edit preserves request precision`);
    close(targetEdit[2].y, targetValue / max, `Max ${max}: numeric target uses Max`);

    // P1's editable floor and P6's request knee retain their normalized locks.
    const p1Target = page.locator('app-bitrate-curve .point-row').nth(0).locator('input').nth(1);
    await p1Target.fill(String(Math.round(max * 0.1))); await p1Target.dispatchEvent('change');
    const floor = await page.evaluate(() => window.__curveQA.edits.at(-1));
    assert.equal(floor[0].x, 0);
    close(floor[0].y, Math.round(max * 0.1) / max, `Max ${max}: P1 floor`);
    const p6Request = page.locator('app-bitrate-curve .point-row').nth(5).locator('input').nth(0);
    await p6Request.fill(String(Math.round(domain * 0.9))); await p6Request.dispatchEvent('change');
    const plateau = await page.evaluate(() => window.__curveQA.edits.at(-1));
    close(plateau[5].x, Math.round(domain * 0.9) / domain, `Max ${max}: P6 knee`);
    assert.equal(plateau[5].y, 1);
    assert.deepEqual(plateau[6], { x: 1, y: 1 });

    await canvas.focus();
    await page.keyboard.press('Shift+ArrowUp');
    const keyboard = await page.evaluate(() => window.__curveQA.edits.at(-1));
    assert.equal(keyboard[2].x, targetEdit[2].x, `Max ${max}: keyboard keeps request coordinate`);
    close(keyboard[2].y, targetEdit[2].y + 0.05, `Max ${max}: keyboard keeps normalized step`);
  }

  // The final average can sit below the base curve after a VBR headroom
  // reservation. Force CBR is a separate flat Max Bitrate policy.
  await updateGraph(page, { ceilingMbit: 500, constancyPct: 100, headroomPct: 25, points: defaults });
  const reserved = await graphDrawing(page);
  const reservedLine = reserved.plot.strokes.find(stroke => stroke.width === 2 && stroke.path.length === 81);
  const reservedY = reserved.height - 34 - (reserved.height - 16 - 34) * 400 / 500;
  for (const point of reservedLine.path.slice(1)) close(point.y, reservedY, '100% constancy honors headroom');
  await updateGraph(page, { forceCbr: true });
  const cbr = await graphDrawing(page);
  const cbrLine = cbr.plot.strokes.find(stroke => stroke.width === 2 && stroke.path.length === 81);
  for (const point of cbrLine.path) close(point.y, 16, 'Force CBR remains at Max Bitrate');
  await updateGraph(page, { forceCbr: false, headroomPct: 0, constancyPct: 0, requestReferenceMbit: 0 });
  const neutral = await graphDrawing(page);
  assert.deepEqual(neutral.inputs[5].map(input => input.value), [500, 500], 'neutral request domain remains Max Bitrate');

  const editCount = await page.evaluate(() => window.__curveQA.edits.length);
  await updateGraph(page, { locked: true });
  assert.ok((await graphDrawing(page)).inputs.every(row => row.every(input => input.disabled)), 'SteamVR lock disables all numeric edits');
  assert.equal(await canvas.getAttribute('tabindex'), '-1');
  await canvas.scrollIntoViewIfNeeded();
  const lockedBox = await canvas.boundingBox();
  await page.mouse.move(lockedBox.x + 56, lockedBox.y + lockedBox.height - 34);
  await page.mouse.down(); await page.mouse.move(lockedBox.x + 70, lockedBox.y + lockedBox.height - 50); await page.mouse.up();
  await canvas.dispatchEvent('keydown', { key: 'ArrowUp' });
  assert.equal(await page.evaluate(() => window.__curveQA.edits.length), editCount, 'SteamVR lock rejects drag commits');
  await updateGraph(page, { locked: false });
  await page.locator('app-bitrate-curve button.reset').click();
  assert.equal(await page.evaluate(() => window.__curveQA.resets.length), 1, 'reset stays an IPC request');
  console.log('PASS scaled graph: Max 280/350/500/800 axes, standard/base/final lines, drag/numeric precision, keyboard, point locks, headroom/CBR and neutral domain');
}

async function checkPresetAfterEditing(page, canvas) {
  const points = bitrateCurvePointsForFamily(0);
  await updateGraph(page, { curve: 0, constancyPct: 35, ceilingMbit: 500, requestReferenceMbit: 350,
    headroomPct: 0, forceCbr: false, points, locked: false });
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox(), plotW = box.width - 56 - 16, plotH = box.height - 16 - 34;
  const editsBefore = await page.evaluate(() => window.__curveQA.edits.length);
  await page.mouse.move(box.x + 56 + plotW * 0.4, box.y + 16 + plotH * 0.6);
  await page.mouse.down();
  await page.mouse.move(box.x + 56 + plotW * 0.35, box.y + 16 + plotH * 0.55);
  await page.mouse.up();
  await page.waitForFunction(count => window.__curveQA.edits.length === count + 1, editsBefore);
  assert.match(await page.locator('app-bitrate-curve .legend').innerText(), /Custom \(editing\)/,
    'committed drag keeps the pending Custom preview until the main window responds');

  // A click-only or cancelled follow-up gesture must neither discard that
  // pending preview nor accidentally commit another edit.
  const dragEdit = await page.evaluate(() => window.__curveQA.edits.at(-1));
  const handleX = box.x + 56 + plotW * dragEdit[2].x;
  const handleY = box.y + 16 + plotH * (1 - dragEdit[2].y);
  await page.mouse.click(handleX, handleY);
  assert.match(await page.locator('app-bitrate-curve .legend').innerText(), /Custom \(editing\)/);
  const beforeCancel = await graphDrawing(page);
  await page.mouse.move(handleX, handleY); await page.mouse.down();
  await page.mouse.move(handleX - 12, handleY - 8);
  await canvas.dispatchEvent('pointercancel', { pointerId: 1 });
  await page.mouse.up();
  assert.equal(await page.evaluate(() => window.__curveQA.edits.length), editsBefore + 1,
    'pointer cancellation does not commit points');
  assert.match(await page.locator('app-bitrate-curve .legend').innerText(), /Custom \(editing\)/);
  assert.deepEqual((await graphDrawing(page)).inputs, beforeCancel.inputs, 'pointer cancellation restores pre-drag points');

  // The main window may first acknowledge Custom, then publish an analytic
  // preset. Power knee differs from the polyline through its seeded handles
  // between 0.6 and 0.8, so an interior sample catches stale custom state.
  await updateGraph(page, { curve: 3, points: dragEdit });
  for (const family of [1, 0]) {
    if (family === 0) {
      const input = page.locator('app-bitrate-curve .point-row').nth(2).locator('input').nth(1);
      await input.fill('230'); await input.dispatchEvent('change');
      assert.match(await page.locator('app-bitrate-curve .legend').innerText(), /Custom \(editing\)/);
      const resetCount = await page.evaluate(() => window.__curveQA.resets.length);
      await page.locator('app-bitrate-curve button.reset').click();
      assert.equal(await page.evaluate(() => window.__curveQA.resets.length), resetCount + 1);
    }
    const presetPoints = bitrateCurvePointsForFamily(family);
    await updateGraph(page, { curve: family, points: presetPoints });
    const drawing = await graphDrawing(page);
    const applied = drawing.plot.strokes.find(stroke => stroke.width === 2 && stroke.path.length === 81);
    for (const sampleIndex of [17, 52, 57, 63]) {
      const request = 350 * sampleIndex / 80;
      const target = bitrateCurveMbit(request, 500, family, 35, presetPoints, 350, 0, false);
      const expectedY = drawing.height - 34 - (drawing.height - 16 - 34) * target / 500;
      close(applied.path[sampleIndex].y, expectedY, `preset ${family}: analytic sample ${sampleIndex}`);
    }
    assert.doesNotMatch(await page.locator('app-bitrate-curve .legend').innerText(), /Custom \(editing\)/,
      `preset ${family}: authoritative family clears pending Custom state`);
  }

  await canvas.scrollIntoViewIfNeeded();
  const activeBox = await canvas.boundingBox(), supersededCount = await page.evaluate(() => window.__curveQA.edits.length);
  await page.mouse.move(activeBox.x + 56 + plotW * 0.4, activeBox.y + 16 + plotH * 0.6);
  await page.mouse.down();
  await page.mouse.move(activeBox.x + 56 + plotW * 0.35, activeBox.y + 16 + plotH * 0.55);
  const newerPreset = bitrateCurvePointsForFamily(1);
  await updateGraph(page, { curve: 1, points: newerPreset });
  await page.mouse.up();
  assert.equal(await page.evaluate(() => window.__curveQA.edits.length), supersededCount,
    'a newer authoritative snapshot cancels a superseded drag commit');
  assert.doesNotMatch(await page.locator('app-bitrate-curve .legend').innerText(), /Custom \(editing\)/);
  assert.equal((await graphDrawing(page)).inputs[2][1].value, Math.round(newerPreset[2].y * 500));

  const crossed = bitrateCurvePointsForFamily(0);
  crossed[2] = { x: 0.1, y: 0.4 };
  const invalidEditCount = await page.evaluate(() => window.__curveQA.edits.length);
  for (const malformed of [crossed, [null]]) {
    await page.evaluate(next => window.__curveQA.update({ curve: 3, points: next }), malformed);
    await page.getByRole('alert').filter({ hasText: 'Cannot plot' }).waitFor();
    assert.equal(await canvas.count(), 0, 'invalid Custom points show an error without plotting defaults');
    assert.equal(await page.evaluate(() => window.__curveQA.edits.length), invalidEditCount,
      'invalid Custom snapshots never emit a replacement shape');
  }
  await updateGraph(page, { curve: 0, points });
  await canvas.waitFor();
  assert.equal(await page.getByRole('alert').filter({ hasText: 'Cannot plot' }).count(), 0,
    'valid authoritative snapshot recovers from invalid Custom points');
  console.log('PASS graph snapshot authority: pending custom edits, cancellation, analytic presets, Linear reset and invalid Custom visibility/recovery');
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
      if (locale === 'en-US') {
        await checkScaledGraph(page, canvas);
        await checkPresetAfterEditing(page, canvas);
      }
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
