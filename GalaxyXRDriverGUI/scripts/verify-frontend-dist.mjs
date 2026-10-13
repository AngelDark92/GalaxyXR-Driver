#!/usr/bin/env node
// Verify the per-locale release bundles are self-contained and correctly
// rooted, matching the layout the Rust i18n.rs redirect expects
// (/<locale>/index.html with sibling assets + locale.json). Run after
// `npm run build:ui`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const distRoot = path.join(root, '../../builds/GalaxyXR-Driver/gui/dist', 'fluent');
const LOCALES = ['en-US', 'zh-Hant', 'ja'];

let failures = 0;
const fail = (msg) => { console.error(`  ✗ ${msg}`); failures++; };
const ok = (msg) => { console.log(`  ✓ ${msg}`); };

if (!fs.existsSync(distRoot)) {
  console.error(`dist/fluent not found at ${distRoot}`);
  console.error('Run: npm run build:ui');
  process.exit(1);
}

for (const loc of LOCALES) {
  const dir = path.join(distRoot, loc);
  console.log(`\n${loc}:`);
  if (!fs.existsSync(dir)) { fail('directory missing'); continue; }

  const indexHtml = path.join(dir, 'index.html');
  if (!fs.existsSync(indexHtml)) {
    fail('index.html missing');
  } else {
    ok('index.html present');
    const html = fs.readFileSync(indexHtml, 'utf8');
    if (/127\.0\.0\.1:5173/.test(html)) fail('index.html references the dev server');
    if (/["'](\/src-lit|\/assets)/.test(html)) fail('index.html has an absolute (root-relative) asset URL');
  }

  const localeJson = path.join(dir, 'locale.json');
  if (!fs.existsSync(localeJson)) {
    fail('locale.json missing');
  } else {
    let units = -1;
    try {
      units = Object.keys(JSON.parse(fs.readFileSync(localeJson, 'utf8'))).length;
    } catch { fail('locale.json is not valid JSON'); }
    if (units >= 0) {
      ok(`locale.json present (${units} units)`);
      if (loc !== 'en-US' && units === 0) fail('translated locale.json has no units');
    }
  }

  const assetsDir = path.join(dir, 'assets');
  const hasJs = fs.existsSync(assetsDir) && fs.readdirSync(assetsDir).some((f) => f.endsWith('.js'));
  if (hasJs) ok('JS bundle present in assets/');
  else fail('no JS bundle found in assets/');

  // Public assets the about page references must be present (self-contained).
  for (const asset of ['GalaxyXRDriverCropped.png', 'patreon-logo.svg', 'ko-fi-logo.svg',
    'icons/favicon.ico', 'icons/headset_galaxy_xr_ready_2x.png',
    ...fs.readdirSync(path.join(root, 'public', 'icons')).filter(f => /\.(png|gif)$/.test(f)).map(f => `icons/${f}`)]) {
    if (!fs.existsSync(path.join(dir, asset))) fail(`public asset ${asset} missing`);
  }
}

console.log('');
if (failures > 0) {
  console.error(`verify-frontend-dist: ${failures} problem(s) found.`);
  process.exit(1);
}
console.log('verify-frontend-dist: OK — all three locales are self-contained.');
