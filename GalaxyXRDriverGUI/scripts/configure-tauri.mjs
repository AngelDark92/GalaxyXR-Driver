// Patch the EXISTING native project; never replace missing Rust source with an
// older backend. Keep the application identifier, data paths and capabilities.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const filename = path.join(root, 'src-tauri', 'tauri.conf.json');
if (!fs.existsSync(filename)) {
  throw new Error('src-tauri/tauri.conf.json is missing. Apply this overlay to your complete project (including its current Rust backend), not to a new empty directory.');
}
const before = fs.readFileSync(filename, 'utf8');
const config = JSON.parse(before.replace(/^\uFEFF/, ''));
config.productName = 'Galaxy XR Companion';
config.build = { ...config.build,
  frontendDist: '../../../builds/GalaxyXR-Driver/gui/dist/fluent', devUrl: 'http://127.0.0.1:5173',
  beforeDevCommand: 'npm run dev:ui', beforeBuildCommand: 'npm run build:ui',
};
config.app ??= {};
// Do not recreate windows, URLs, dimensions, labels, permissions or security.
// A missing windows array uses Tauri's default window, so name it explicitly.
if (!config.app.windows) config.app.windows = [{ title: 'Galaxy XR Companion' }];
else {
  const mainIndex = config.app.windows.findIndex(window => window.label === 'main');
  const main = config.app.windows[mainIndex < 0 ? 0 : mainIndex];
  if (main) main.title = 'Galaxy XR Companion';
}
config.bundle = { ...config.bundle, icon: [
  'icons/icon.ico', 'icons/32x32.png', 'icons/128x128.png',
  'icons/128x128@2x.png', 'icons/icon.png', 'icons/icon.icns',
] };
// Cargo package/target names are declared separately by the GalaxyXRDriver
// source migration. Portable staging publishes Galaxy XR Companion.exe. This
// branding hook never rewrites the stable application ID or user-data paths.
const after = JSON.stringify(config, null, 2) + '\n';
if (JSON.stringify(JSON.parse(before.replace(/^\uFEFF/, ''))) !== JSON.stringify(config)) {
  const backup = filename + '.before-galaxy-companion.json';
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, before, { flag: 'wx' });
  fs.writeFileSync(filename, after);
  console.log('Updated Galaxy XR Companion branding, icons and frontend hooks; original native configuration backed up.');
}
