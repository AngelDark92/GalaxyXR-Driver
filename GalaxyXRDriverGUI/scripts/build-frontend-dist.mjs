#!/usr/bin/env node
// Build all three per-locale release bundles into self-contained
// dist/fluent/<locale>/ directories and place the generated locale.json into
// each (mirroring the old Angular localize dist layout the Rust i18n.rs
// redirect expects). Invoked by `npm run build:ui`.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const LOCALES = ['en-US', 'zh-Hant', 'ja'];

for (const loc of LOCALES) {
  console.log(`\n=== building ${loc} ===`);
  execSync('npx vite build --configLoader runner', {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, LOCALE: loc },
  });
  const src = path.join(root, '../../builds/GalaxyXR-Driver/gui/build', 'locale-json', `${loc}.json`);
  const dest = path.join(root, '../../builds/GalaxyXR-Driver/gui/dist', 'fluent', loc, 'locale.json');
  if (!fs.existsSync(src)) {
    console.error(`missing locale catalog: ${src}`);
    console.error('Run first: npm run build:ui');
    process.exit(1);
  }
  fs.copyFileSync(src, dest);
  console.log(`copied ${loc}/locale.json`);
}
console.log('\nAll three locale bundles built.');
