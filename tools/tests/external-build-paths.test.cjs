'use strict';
const { fixtureRoot } = require('../lib/test-fixtures.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const project = path.resolve(__dirname, '../..');
function fixture(t) {
  const sandbox = fs.mkdtempSync(path.join(fixtureRoot(), 'gxr-external-artifacts-'));
  const repo = path.join(sandbox, 'repo'), artifacts = path.join(sandbox, 'builds/GalaxyXR-Driver');
  fs.mkdirSync(path.join(repo, 'tools'), { recursive: true });
  fs.copyFileSync(path.join(project, 'tools/Move-BuildFolders.ps1'), path.join(repo, 'tools/Move-BuildFolders.ps1'));
  fs.writeFileSync(path.join(repo, 'source.txt'), 'source must survive');
  for (const args of [['init', '-q'], ['add', 'source.txt']]) {
    assert.equal(spawnSync('git', args, { cwd: repo, encoding: 'utf8' }).status, 0);
  }
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const put = (relative, text) => {
    const file = path.join(repo, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
  };
  const run = (apply = false) => {
    const env = { ...process.env, LOCALAPPDATA: path.join(sandbox, 'localappdata') };
    delete env.VR_PATHREG_OVERRIDE;
    // Do not inherit PowerShell 7's module directory into Windows PowerShell.
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
    return spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(repo, 'tools/Move-BuildFolders.ps1'), ...(apply ? ['-Apply'] : [])],
      { encoding: 'utf8', env, windowsHide: true, timeout: 60000 });
  };
  return { sandbox, repo, artifacts, put, run };
}
test('migration previews, preserves bytes, adds disjoint children and empties source folders', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t);
  f.put('build/toolchains/keep.txt', 'offline compiler');
  f.put('build/scratch/unit.obj', 'compiler bytes');
  f.put('release/keep.zip', 'release bytes');
  f.put('GalaxyXRDriverGUI/dist/en-US/index.html', 'frontend bytes');
  fs.mkdirSync(path.join(f.artifacts, 'build'), { recursive: true });
  fs.writeFileSync(path.join(f.artifacts, 'build/other-project.txt'), 'unrelated bytes');
  const preview = f.run(); assert.equal(preview.status, 0, preview.stderr);
  assert.ok(fs.existsSync(path.join(f.repo, 'build/scratch/unit.obj')));
  assert.ok(!fs.existsSync(path.join(f.artifacts, 'build/scratch')));
  const applied = f.run(true); assert.equal(applied.status, 0, applied.stderr);
  for (const [file, expected] of [['build/toolchains/keep.txt', 'offline compiler'],
    ['build/scratch/unit.obj', 'compiler bytes'], ['release/keep.zip', 'release bytes'],
    ['gui/dist/en-US/index.html', 'frontend bytes'], ['build/other-project.txt', 'unrelated bytes']]) {
    assert.equal(fs.readFileSync(path.join(f.artifacts, file), 'utf8'), expected);
  }
  assert.equal(fs.readFileSync(path.join(f.repo, 'source.txt'), 'utf8'), 'source must survive');
  for (const folder of ['build', 'release', 'GalaxyXRDriverGUI/dist']) assert.ok(!fs.existsSync(path.join(f.repo, folder)));
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.artifacts, 'build-folder-migration.json'))).status, 'complete');
});
test('migration rejects a destination collision before moving any source', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t); f.put('build/duplicate/file.obj', 'original'); f.put('release/keep.zip', 'release');
  fs.mkdirSync(path.join(f.artifacts, 'build/duplicate'), { recursive: true });
  fs.writeFileSync(path.join(f.artifacts, 'build/duplicate/file.obj'), 'existing');
  const result = f.run(true); assert.notEqual(result.status, 0); assert.match(result.stderr, /Destination already exists/);
  assert.equal(fs.readFileSync(path.join(f.repo, 'build/duplicate/file.obj'), 'utf8'), 'original');
  assert.equal(fs.readFileSync(path.join(f.artifacts, 'build/duplicate/file.obj'), 'utf8'), 'existing');
  assert.ok(fs.existsSync(path.join(f.repo, 'release/keep.zip')));
});
test('migration protects tracked artifacts', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t); f.put('build/custom-script.ps1', 'tracked source');
  assert.equal(spawnSync('git', ['add', 'build/custom-script.ps1'], { cwd: f.repo }).status, 0);
  const result = f.run(true); assert.notEqual(result.status, 0); assert.match(result.stderr, /Tracked path protected/);
  assert.ok(fs.existsSync(path.join(f.repo, 'build/custom-script.ps1')));
});
test('frontend and Rust consumers resolve the same external dist and Cargo roots', () => {
  const gui = path.join(project, 'GalaxyXRDriverGUI');
  const config = JSON.parse(fs.readFileSync(path.join(gui, 'src-tauri/tauri.conf.json')));
  assert.equal(path.resolve(gui, 'src-tauri', config.build.frontendDist), path.resolve(project, '../builds/GalaxyXR-Driver/gui/dist/fluent'));
  const cargo = fs.readFileSync(path.join(gui, '.cargo/config.toml'), 'utf8');
  const target = cargo.match(/target-dir = "([^"]+)"/)[1];
  assert.equal(path.resolve(gui, target), path.resolve(project, '../builds/GalaxyXR-Driver/output/GalaxyXRDriverGUI'));
});
