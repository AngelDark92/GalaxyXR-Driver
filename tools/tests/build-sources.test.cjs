'use strict';
const { fixtureRoot } = require('../lib/test-fixtures.cjs');

// Real Git fixtures: exercise normal git add and a fresh local clone. No network,
// npm installation, native compilation, or changes to the user's checkout.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { verifyBuildSources, REQUIRED_BUILD_SOURCES } = require('../verify-build-sources.cjs');

const project = path.resolve(__dirname, '../..');
const helper = 'tools/lib/stage-companion.cjs';
const cli = path.join(project, 'tools/verify-build-sources.cjs');

function run(cwd, command, args) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8', timeout: 60000, windowsHide: true,
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  return result;
}
function git(cwd, ...args) { return run(cwd, 'git', args); }
function mustPass(result) {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
function write(root, relative, text) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
function copy(root, relative) {
  const destination = path.join(root, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(path.join(project, relative), destination, { recursive: true });
}
function fixture(t, initGit = true) {
  const root = fs.mkdtempSync(path.join(fixtureRoot(), 'GalaxyXR build sources [fixture] '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  for (const relative of REQUIRED_BUILD_SOURCES) copy(root, relative);
  if (initGit) {
    mustPass(git(root, 'init', '--quiet'));
    // Do not inherit user hooks, CRLF conversion, signing, or global excludes.
    const hooks = path.join(root, '.git/empty-hooks');
    fs.mkdirSync(hooks);
    for (const [key, value] of Object.entries({
      'user.name': 'Local fixture', 'user.email': 'fixture@example.invalid',
      'commit.gpgsign': 'false', 'core.autocrlf': 'false',
      'core.hooksPath': hooks, 'core.excludesFile': path.join(root, '.git/no-global-excludes'),
    })) mustPass(git(root, 'config', key, value));
    fs.writeFileSync(path.join(root, '.git/no-global-excludes'), '');
  }
  return root;
}
function ignored(root, file) { return git(root, 'check-ignore', '--no-index', '--quiet', '--', file).status; }
function stage(root) { mustPass(git(root, 'add', '--all')); }
function clone(t, root) {
  mustPass(git(root, 'commit', '--quiet', '-m', 'Fixture sources'));
  const parent = fs.mkdtempSync(path.join(fixtureRoot(), 'GalaxyXR clone [fixture] '));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const destination = path.join(parent, 'fresh checkout');
  // No submodule or remote fetches. Clone only our own temporary fixture repo.
  mustPass(git(parent, 'clone', '--quiet', '--no-hardlinks', '--config', 'core.autocrlf=false', '--', root, destination));
  return destination;
}

test('original lib ignore rule reproduces the missing helper in a real fresh clone', t => {
  const root = fixture(t);
  write(root, '.gitignore', 'lib\noutput\nnode_modules/\n');
  assert.equal(fs.existsSync(path.join(root, helper)), true);
  assert.equal(ignored(root, helper), 0);
  stage(root);
  assert.notEqual(git(root, 'ls-files', '--error-unmatch', '--', helper).status, 0);
  const fresh = clone(t, root);
  assert.equal(fs.existsSync(path.join(fresh, helper)), false);
  const result = run(fresh, process.execPath, ['-e', `require('./${helper}')`]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /MODULE_NOT_FOUND/);
});

test('shipped ignore rules allow the helper directory and every source below it', t => {
  const root = fixture(t);
  write(root, 'tools/lib/nested/future-helper.cjs', '// fixture\n');
  assert.equal(ignored(root, helper), 1);
  assert.equal(ignored(root, 'tools/lib/nested/future-helper.cjs'), 1);
  stage(root);
  mustPass(git(root, 'ls-files', '--error-unmatch', '--', helper, 'tools/lib/nested/future-helper.cjs'));
});

test('a file-only negation is insufficient when its parent lib directory is ignored', t => {
  const root = fixture(t);
  write(root, '.gitignore', `lib\n!/${helper}\n`);
  assert.equal(ignored(root, helper), 0);
  assert.throws(() => verifyBuildSources(root), /Source is ignored by Git: tools\/lib\/stage-companion.cjs/);
});

test('generated libraries and build outputs remain ignored after the exception', t => {
  const root = fixture(t);
  for (const relative of ['lib/native.lib', 'GalaxyXRDriver/lib/native.lib', 'output/package/file.exe',
    'build/temporary.obj', 'GalaxyXRDriverGUI/node_modules/dependency/index.js',
    'GalaxyXRDriverGUI/src-tauri/target/release/gui.exe', '.source-backups/old/file.cjs']) {
    // The Tauri-specific rule is nested; copy it as in the actual source tree.
    if (relative.includes('/target/')) copy(root, 'GalaxyXRDriverGUI/src-tauri/.gitignore');
    write(root, relative, 'fixture');
    assert.equal(ignored(root, relative), 0, relative);
  }
});

test('missing helper fails with an actionable source-restoration error', t => {
  const root = fixture(t); fs.unlinkSync(path.join(root, helper));
  assert.throws(() => verifyBuildSources(root), /Missing source file: tools\/lib\/stage-companion.cjs/);
});

test('empty helper and directory in place of a helper both fail', t => {
  const root = fixture(t); write(root, helper, '');
  assert.throws(() => verifyBuildSources(root), /Missing or empty source file/);
  fs.unlinkSync(path.join(root, helper)); fs.mkdirSync(path.join(root, helper));
  assert.throws(() => verifyBuildSources(root), /Missing or empty source file/);
});

test('Git checkout with untracked helpers does not pass required tracking verification', t => {
  const root = fixture(t);
  assert.throws(() => verifyBuildSources(root, { requireTracked: true }), /Source is not in the Git index/);
});

test('normally staged required sources pass without forcing ignored files', t => {
  const root = fixture(t); stage(root);
  const result = verifyBuildSources(root, { requireTracked: true });
  assert.equal(result.trackingChecked, true);
  assert.equal(result.files.length, REQUIRED_BUILD_SOURCES.length);
});

test('force-adding a helper does not conceal a broken ignore rule', t => {
  const root = fixture(t); write(root, '.gitignore', 'lib\n');
  stage(root); mustPass(git(root, 'add', '--force', '--', helper));
  mustPass(git(root, 'ls-files', '--error-unmatch', '--', helper));
  assert.throws(() => verifyBuildSources(root, { requireTracked: true }), /Source is ignored by Git/);
});

test('existing repo-local exclude cannot hide the helper behind a successful preflight', t => {
  const root = fixture(t);
  write(root, '.git/info/exclude', 'tools/verify-release-version.cjs\n');
  assert.throws(() => verifyBuildSources(root), /Source is ignored by Git: tools\/verify-release-version.cjs/);
});

test('source ZIP without Git can check file presence but cannot claim tracking verification', t => {
  const root = fixture(t, false);
  const result = verifyBuildSources(root);
  assert.equal(result.gitChecked, false);
  assert.equal(result.trackingChecked, false);
  assert.throws(() => verifyBuildSources(root, { requireTracked: true }), /requires a working-tree checkout/);
});

test('CLI supports a project path with spaces and fails nonzero on untracked files', t => {
  const root = fixture(t);
  const failed = run(root, process.execPath, [cli, '--project', root, '--require-tracked']);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /Source is not in the Git index/);
  stage(root);
  const passed = run(root, process.execPath, [cli, '--project', root, '--require-tracked']);
  assert.match(mustPass(passed), /present, not ignored, and in the Git index/);
});

test('CLI rejects unknown arguments and a missing project argument', t => {
  const root = fixture(t);
  for (const args of [['--skip-errors'], ['--project'], ['--project', '--require-tracked']]) {
    const result = run(root, process.execPath, [cli, ...args]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Usage:/);
  }
});

test('invalid project and incomplete source snapshot never pass', t => {
  assert.throws(() => verifyBuildSources(''), /nonempty project/);
  const root = fixture(t); fs.unlinkSync(path.join(root, 'tools/Build-Portable.ps1'));
  assert.throws(() => verifyBuildSources(root), /Missing source file: tools\/Build-Portable.ps1/);
});

test('preflight is read-only and does not repair, stage, or generate files', t => {
  const root = fixture(t); stage(root);
  const before = git(root, 'status', '--porcelain=v1', '--untracked-files=all').stdout;
  const content = new Map(REQUIRED_BUILD_SOURCES.map(file => [file, fs.readFileSync(path.join(root, file))]));
  verifyBuildSources(root, { requireTracked: true });
  assert.equal(git(root, 'status', '--porcelain=v1', '--untracked-files=all').stdout, before);
  for (const [file, bytes] of content) assert.deepEqual(fs.readFileSync(path.join(root, file)), bytes);
});

test('actual delivered build sources pass file/ignore checks without requiring an existing commit', () => {
  assert.equal(verifyBuildSources(project).files.length, REQUIRED_BUILD_SOURCES.length);
});

test('developer workflow audits tracked helpers without blocking the release build', () => {
  const developer = fs.readFileSync(path.join(project, '.github/workflows/build-tools.yml'), 'utf8');
  const release = fs.readFileSync(path.join(project, '.github/workflows/release.yml'), 'utf8');
  assert.match(developer, /verify-build-sources\.cjs --require-tracked/);
  assert.match(developer, /node --test @testFiles/);
  assert.doesNotMatch(release, /--require-tracked|node --test/);
});

test('a fresh clone of normally committed sources passes the real build-hook fixture suite', t => {
  const root = fixture(t);
  for (const relative of [
    'GalaxyXRDriverGUI/scripts/configure-tauri.mjs', 'GalaxyXRDriverGUI/generate-env.js',
    'GalaxyXRDriverGUI/package.json', 'GalaxyXRDriverGUI/package-lock.json',
    'GalaxyXRDriverGUI/scripts/verify-frontend-dist.mjs', 'GalaxyXRDriverGUI/public',
    'GalaxyXRDriver/GalaxyXRDriver.vcxproj',
  ]) copy(root, relative);
  stage(root);
  const fresh = clone(t, root);
  assert.equal(fs.existsSync(path.join(fresh, helper)), true);
  assert.deepEqual(fs.readFileSync(path.join(fresh, helper)), fs.readFileSync(path.join(project, helper)));
  const preflight = run(fresh, process.execPath, ['tools/verify-build-sources.cjs', '--require-tracked']);
  assert.match(mustPass(preflight), /in the Git index/);
  const result = run(fresh, process.execPath, ['tools/Test-FluentBuildHooks.cjs']);
  const summary = mustPass(result).match(/(\d+) build fixture checks passed/);
  assert.ok(summary && Number(summary[1]) >= 20, 'Expected the complete portable build-hook suite.');
});
