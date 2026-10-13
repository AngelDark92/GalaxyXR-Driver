'use strict';
const { fixtureRoot } = require('../lib/test-fixtures.cjs');
// Uses REAL local Git repositories, commits, shallow fetches, and object batches.
// No HTTP, compiler installation, or third-party source download is performed.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const native = require('../prepare-native-dependencies.cjs');
const project = path.resolve(__dirname, '../..');
let upstreamRoot, lock, transports;
const quiet = () => {};
function runGit(root, args) {
  const r = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.longpaths=true', '-c', 'commit.gpgsign=false',
    '-c', 'user.name=Native Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, r.stderr || r.error?.message); return r.stdout.trim();
}
function write(root, file, data = '// test fixture\n') {
  const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, data); return target;
}
function tmp(t) { const root = fs.mkdtempSync(path.join(fixtureRoot(), 'n [x] ')); t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })); const project=path.join(root,'repo');fs.mkdirSync(project);return project; }
function fixture(t, git = false) {
  const root = tmp(t);
  for (const dep of lock.dependencies) {
    fs.cpSync(transports[dep.name], path.join(root, dep.directory), { recursive: true,
      filter: src => path.basename(src) !== '.git' });
  }
  if (git) { runGit(root, ['init', '-q']); runGit(root, ['add', '.']); runGit(root, ['commit', '-qm', 'Vendored fixture']); }
  return root;
}
function erase(root, relative) { fs.rmSync(path.join(root, relative), { recursive: true, force: true }); }
const prepare = (root, extra = {}) => native.prepareNativeDependencies(root, { lock, transports, log: quiet, ...extra });
function missing(root) { return native.inspectNativeDependencies(root, { lock }).filter(dep => dep.missing.length); }
function sourceHash(root) {
  const hash = crypto.createHash('sha256');
  function scan(directory) { if (!fs.existsSync(directory)) return; for (const e of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(directory, e.name); if (e.isDirectory()) scan(p); else { hash.update(path.relative(root, p)); hash.update(fs.readFileSync(p)); }
  } }
  scan(path.join(root, 'ThirdParty')); return hash.digest('hex');
}
before(() => {
  upstreamRoot = fs.mkdtempSync(path.join(fixtureRoot(), 'up-'));
  lock = structuredClone(native.loadLock()); transports = {};
  for (const dep of lock.dependencies) {
    const directory = path.join(upstreamRoot, dep.name); fs.mkdirSync(directory); transports[dep.name] = directory;
    for (const file of dep.required) write(directory, file, file.endsWith('.lib') ? Buffer.from([0, 9, 255, 10, 13]) : `// ${dep.name}/${file} fixture\n`);
    for (const license of dep.files.filter(f => /(?:LICENSE|COPYING)/.test(f))) write(directory, license, 'Fixture license\n');
    if (dep.name === 'json') {
      write(directory, 'include/nlohmann/json.hpp', '#include <nlohmann/detail/output/binary_writer.hpp>\n');
      write(directory, 'include/nlohmann/detail/output/binary_writer.hpp', '#include <nlohmann/detail/deeper/value.hpp>\n');
      write(directory, 'include/nlohmann/detail/deeper/value.hpp', '#pragma once\n');
    }
    runGit(directory, ['init', '-q']); runGit(directory, ['add', '.']); runGit(directory, ['commit', '-qm', `Pinned ${dep.name}`]);
    dep.revision = runGit(directory, ['rev-parse', 'HEAD']);
  }
});
after(() => { if (upstreamRoot) fs.rmSync(upstreamRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

test('Fallback lock records all five original supplied Git revisions, not branches', () => {
  const l = native.loadLock(); assert.equal(l.dependencies.length, 5);
  assert.equal(l.dependencies.find(d => d.name === 'minhook').revision, '2b003bb063d66f016cc1aef7d63951350ce60f35');
  assert.equal(l.dependencies.find(d => d.name === 'json').revision, '55f93686c01528224f448c19128836e7df245f72');
  assert.equal(l.dependencies.find(d => d.name === 'zlib').revision, 'da607da739fa6047df13e66a2af6b8bec7c2a498');
  assert.ok(l.dependencies.every(d => /^[a-f0-9]{40}$/.test(d.revision)));
});
for (const [name, change] of [
  ['branch revisions', l => { l.dependencies[0].revision = 'main'; }],
  ['nonofficial remotes', l => { l.dependencies[0].repository = 'https://example.invalid/payload.git'; }],
  ['directory traversal', l => { l.dependencies[0].required.push('../outside.h'); }],
  ['missing libraries', l => { l.dependencies.pop(); }],
]) test(`Lock rejects ${name}`, t => { const l = native.loadLock(); change(l); const file = write(tmp(t), 'lock.json', JSON.stringify(l)); assert.throws(() => native.loadLock(file)); });

test('Detects all five entirely absent dependencies', t => { assert.equal(missing(tmp(t)).length, 5); });
test('Finds the three concrete CI errors together', t => {
  const root = fixture(t); erase(root, 'ThirdParty/minhook/build'); erase(root, 'ThirdParty/json/include/nlohmann/detail/output'); erase(root, 'ThirdParty/zlib/zconf.h');
  const found = missing(root); assert.deepEqual(found.map(d => d.name), ['minhook', 'json', 'zlib']);
  assert.ok(found[0].missing.includes('build/VC17/libMinHook.vcxproj')); assert.ok(found[1].missing.includes('include/nlohmann/detail/output/binary_writer.hpp')); assert.ok(found[2].missing.includes('zconf.h'));
});
test('JSON validation follows transitive headers, not just json.hpp', t => {
  const root = fixture(t); erase(root, 'ThirdParty/json/include/nlohmann/detail/deeper/value.hpp');
  assert.deepEqual(missing(root)[0].missing, ['include/nlohmann/detail/deeper/value.hpp']);
});
test('Read-only --check reports every missing input without creating cache or source', t => {
  const root = tmp(t); assert.throws(() => prepare(root, { check: true }), /Native dependency checkout is incomplete/);
  assert.equal(fs.existsSync(path.join(root, 'build')), false); assert.equal(fs.existsSync(path.join(root, 'ThirdParty')), false);
});
test('Complete source works offline without invoking Git at all', t => {
  const root = fixture(t); const report = prepare(root, { noDownload: true, git: 'this-command-must-not-run' });
  assert.equal(report.filesAdded, 0); assert.equal(fs.existsSync(path.join(root, 'build')), false);
});
test('Real Git fetch restores all three CI omissions in a vendored checkout', t => {
  const root = fixture(t, true); const before = sourceHash(root);
  erase(root, 'ThirdParty/minhook/build'); erase(root, 'ThirdParty/json/include/nlohmann/detail/output'); erase(root, 'ThirdParty/zlib/zconf.h');
  const report = prepare(root); assert.equal(report.repaired.length, 3); assert.equal(missing(root).length, 0); assert.equal(sourceHash(root), before);
  assert.ok(report.repaired.every(d => /vendored/.test(d.source)));
});
test('ZIP-only snapshot restores all five dependencies and their included license files', t => {
  const root = tmp(t); const report = prepare(root); assert.equal(report.repaired.length, 5); assert.equal(missing(root).length, 0);
  assert.equal(fs.readFileSync(path.join(root, 'ThirdParty/minhook/LICENSE.txt'), 'utf8'), 'Fixture license\n');
});
test('Second preparation does not touch files or require the remote/cache', t => {
  const root = fixture(t); erase(root, 'ThirdParty/zlib/zconf.h'); prepare(root); erase(root, 'build');
  const before = sourceHash(root); assert.equal(prepare(root, { noDownload: true, git: 'must-not-run' }).filesAdded, 0); assert.equal(sourceHash(root), before);
});
test('Offline cache repairs newly missing headers without refetching', t => {
  const root = fixture(t); erase(root, 'ThirdParty/zlib/zconf.h'); prepare(root); erase(root, 'ThirdParty/zlib/gzguts.h');
  const report = prepare(root, { noDownload: true, transports: { zlib: '/nonexistent/remote' } }); assert.equal(report.filesAdded, 1); assert.equal(missing(root).length, 0);
});
test('Offline missing cache stops without changing ThirdParty', t => {
  const root = fixture(t); erase(root, 'ThirdParty/zlib/zconf.h'); const before = sourceHash(root);
  assert.throws(() => prepare(root, { noDownload: true }), /Offline cache is missing/); assert.equal(sourceHash(root), before);
});
test('Existing local edits stop repair before any dependency is written', t => {
  const root = fixture(t); erase(root, 'ThirdParty/minhook/build'); erase(root, 'ThirdParty/json/include/nlohmann/detail/output');
  write(root, 'ThirdParty/json/include/nlohmann/json.hpp', '// Deliberate local customization\n');
  const before = sourceHash(root); assert.throws(() => prepare(root), /refusing to mix versions or overwrite local edits/);
  assert.equal(sourceHash(root), before); assert.equal(fs.existsSync(path.join(root, 'ThirdParty/minhook/build')), false);
});
test('Existing empty files are not silently overwritten as missing files', t => {
  const root = fixture(t); write(root, 'ThirdParty/zlib/zconf.h', ''); const before = sourceHash(root);
  assert.throws(() => prepare(root), /Existing dependency files differ/); assert.equal(sourceHash(root), before);
});
test('Windows CRLF sources compare correctly and retain their original bytes', t => {
  const root = fixture(t); const file = path.join(root, 'ThirdParty/zlib/zlib.h'); const original = fs.readFileSync(file, 'utf8').replaceAll('\n', '\r\n'); fs.writeFileSync(file, original);
  erase(root, 'ThirdParty/zlib/zconf.h'); prepare(root); assert.equal(fs.readFileSync(file, 'utf8'), original);
});
test('Binary libraries are never text-normalized during compatibility checks', () => {
  assert.equal(native.sameSource('x.lib', Buffer.from('one\r\n'), Buffer.from('one\n')), false);
});
test('Vendored dependency directories never borrow parent repository objects', t => {
  const root = fixture(t, true), dep = lock.dependencies.find(d => d.name === 'zlib');
  assert.equal(fs.existsSync(path.join(root, dep.directory, '.git')), false);
  assert.equal(native.existingObjectDirectory(root, dep, runGit(root, ['rev-parse', 'HEAD'])), null);
});
test('A real gitlink overrides the snapshot fallback without updating the Git index', t => {
  const root = fixture(t, true); const dep = lock.dependencies.find(d => d.name === 'zlib');
  runGit(root, ['rm', '-qr', '--cached', dep.directory]); runGit(root, ['update-index', '--add', '--cacheinfo', '160000', dep.revision, dep.directory]);
  const before = runGit(root, ['ls-files', '--stage']); const selected = native.selectedRevision(root, { ...dep, revision: 'a'.repeat(40) });
  assert.equal(selected.revision, dep.revision); assert.match(selected.source, /current Git submodule pin/);
  erase(root, 'ThirdParty/zlib/zconf.h'); prepare(root); assert.equal(runGit(root, ['ls-files', '--stage']), before);
});
test('Nested dependency clone objects repair deleted tracked headers without network/cache', t => {
  const root = fixture(t, true), dep = lock.dependencies.find(d => d.name === 'zlib');
  erase(root, dep.directory); runGit(root, ['clone', '-q', transports.zlib, dep.directory]);
  runGit(root, ['rm', '-qr', '--cached', dep.directory]); runGit(root, ['update-index', '--add', '--cacheinfo', '160000', dep.revision, dep.directory]);
  assert.equal(fs.lstatSync(path.join(root, dep.directory, '.git')).isDirectory(), true);
  assert.ok(native.existingObjectDirectory(root, dep, dep.revision));
  erase(root, 'ThirdParty/zlib/zconf.h'); const report = prepare(root, { noDownload: true });
  assert.equal(report.filesAdded, 1); assert.equal(missing(root).length, 0);
  assert.equal(fs.existsSync(path.join(root, '../builds/GalaxyXR-Driver/build/native-dependencies', `${dep.name}-${dep.revision}.git`)), false);
});
test('Initialized submodule objects repair deleted tracked headers without network/cache', t => {
  const root = fixture(t, true), dep = lock.dependencies.find(d => d.name === 'zlib');
  runGit(root, ['rm', '-qr', dep.directory]);
  runGit(root, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', transports.zlib, dep.directory]);
  assert.equal(fs.lstatSync(path.join(root, dep.directory, '.git')).isFile(), true);
  assert.ok(native.existingObjectDirectory(root, dep, dep.revision));
  erase(root, 'ThirdParty/zlib/zconf.h'); const report = prepare(root, { noDownload: true });
  assert.equal(report.filesAdded, 1); assert.equal(missing(root).length, 0);
  assert.equal(fs.existsSync(path.join(root, '../builds/GalaxyXR-Driver/build/native-dependencies', `${dep.name}-${dep.revision}.git`)), false);
});
test('Unavailable pinned revision fails without selecting latest or changing files', t => {
  const root = fixture(t); erase(root, 'ThirdParty/zlib/zconf.h'); const before = sourceHash(root); const bad = structuredClone(lock); bad.dependencies.find(d => d.name === 'zlib').revision = 'a'.repeat(40);
  assert.throws(() => prepare(root, { lock: bad }), /Git failed/); assert.equal(sourceHash(root), before);
});
test('Failure releases setup lock and retains actionable Git logs', t => {
  const root = fixture(t); erase(root, 'ThirdParty/zlib/zconf.h'); assert.throws(() => prepare(root, { transports: { zlib: '/missing/fixture/remote' } }), /Git failed/);
  assert.equal(fs.existsSync(path.join(root, '../builds/GalaxyXR-Driver/build/native-dependencies/.prepare.lock')), false);
  assert.match(fs.readFileSync(path.join(root, '../builds/GalaxyXR-Driver/build/native-dependencies/zlib-fetch.log'), 'utf8'), /fetch/);
});
test('A concurrent setup lock prevents conflicting writes', t => {
  const root = fixture(t); erase(root, 'ThirdParty/zlib/zconf.h'); write(root, '../builds/GalaxyXR-Driver/build/native-dependencies/.prepare.lock', 'another process');
  assert.throws(() => prepare(root), /Another native dependency setup/); assert.equal(fs.readFileSync(path.join(root, '../builds/GalaxyXR-Driver/build/native-dependencies/.prepare.lock'), 'utf8'), 'another process');
});
test('Checksum-verified Git batch preserves arbitrary binary bytes', () => {
  const bytes = Buffer.from([0, 10, 13, 255, 0]); const sha = crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  const batch = Buffer.concat([Buffer.from(`${sha} blob ${bytes.length}\n`), bytes, Buffer.from('\n')]);
  assert.deepEqual(native.parseBatch(batch, [{ file: 'lib/example.lib', sha }]).get('lib/example.lib'), bytes);
  batch[batch.length - 2] ^= 1; assert.throws(() => native.parseBatch(batch, [{ file: 'lib/example.lib', sha }]), /checksum mismatch/);
});
test('Truncated Git objects are rejected', () => { assert.throws(() => native.parseBatch(Buffer.from('incomplete'), [{ file: 'x.h', sha: 'a'.repeat(40) }]), /Truncated/); });
test('Unsafe dependency destination is rejected before writing', t => {
  const root = tmp(t); assert.throws(() => native.safeTarget(root, '../outside')); assert.throws(() => native.safeTarget(root, 'ThirdParty/../outside'));
});
test('Write collision rolls back only this repair and preserves the existing file', t => {
  const root = tmp(t); write(root, 'ThirdParty/keep.h', 'preserve');
  assert.throws(() => native.applyPlan(root, [{ relative: 'ThirdParty/new.h', data: Buffer.from('new') }, { relative: 'ThirdParty/keep.h', data: Buffer.from('bad') }]), /EEXIST/);
  assert.equal(fs.existsSync(path.join(root, 'ThirdParty/new.h')), false); assert.equal(fs.readFileSync(path.join(root, 'ThirdParty/keep.h'), 'utf8'), 'preserve');
});
for (const relative of ['ThirdParty', '../builds/GalaxyXR-Driver/build/native-dependencies']) test(`Rejects junction/symlink redirection at ${relative}`, t => {
  const root = tmp(t), outside = tmp(t); fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  // Directory junctions do not require Windows Developer Mode/admin privileges.
  fs.symlinkSync(outside, path.join(root, relative), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => prepare(root), /symlink\/junction/); assert.equal(fs.readdirSync(outside).length, 0);
});
test('Old broad ignore rules reproduce hidden MinHook, JSON output, and OpenVR lib inputs', t => {
  const root = tmp(t); runGit(root, ['init', '-q']); write(root, '.gitignore', 'build\noutput\nlib\n');
  for (const file of ['ThirdParty/minhook/build/VC17/libMinHook.vcxproj', 'ThirdParty/json/include/nlohmann/detail/output/binary_writer.hpp', 'ThirdParty/openvr/lib/win64/openvr_api.lib']) {
    write(root, file); const result = spawnSync('git', ['check-ignore', '--quiet', '--', file], { cwd: root }); assert.equal(result.status, 0);
  }
});
test('Patched ignore rules keep dependency sources trackable and build outputs ignored', t => {
  const root = tmp(t); runGit(root, ['init', '-q']); fs.copyFileSync(path.join(project, '.gitignore'), path.join(root, '.gitignore'));
  for (const file of ['ThirdParty/minhook/build/VC17/libMinHook.vcxproj', 'ThirdParty/json/include/nlohmann/detail/output/binary_writer.hpp', 'ThirdParty/openvr/lib/win64/openvr_api.lib', 'tools/native-dependencies.lock.json']) {
    write(root, file); const result = spawnSync('git', ['check-ignore', '--quiet', '--', file], { cwd: root }); assert.equal(result.status, 1, file);
  }
  for (const file of ['output/driver.dll', 'build/native-dependencies/zlib-cache', 'lib/generated.lib', 'GalaxyXRDriver/lib/generated.lib', 'GalaxyXRDriverGUI/build/locale-json/en-US.json']) {
    write(root, file); assert.equal(spawnSync('git', ['check-ignore', '--quiet', '--', file], { cwd: root }).status, 0, file);
  }
});
test('A fresh Git clone with the old omissions repairs from pinned sources', t => {
  const source = fixture(t); write(source, '.gitignore', 'build\noutput\nlib\n');
  write(source, 'ThirdParty/zlib/.gitignore', '/zconf.h\n'); runGit(source, ['init', '-q']); runGit(source, ['add', '.']); runGit(source, ['commit', '-qm', 'Reproduce omitted source files']);
  const root = tmp(t); runGit(root, ['clone', '-q', source, 'clone']); const clone = path.join(root, 'clone');
  assert.deepEqual(missing(clone).map(d => d.name), ['openvr', 'minhook', 'json', 'zlib']);
  prepare(clone); assert.equal(missing(clone).length, 0);
});
test('MSBuild and direct-cl entry points share preparation instead of bypassing checks', () => {
  const release = fs.readFileSync(path.join(project, 'build.js'), 'utf8'), portable = fs.readFileSync(path.join(project, 'tools/lib/portable-toolchain.cjs'), 'utf8');
  assert.ok(release.indexOf('prepareNativeDependencies(__dirname)') < release.indexOf('removeRecursive(outputDir)'));
  assert.match(portable, /prepareNativeDependencies\(repo, \{ noDownload:/);
  assert.doesNotMatch(portable, /No pinned Git submodule exists/);
});
test('Workflow restores and verifies native inputs before building', () => {
  const workflow = fs.readFileSync(path.join(project, '.github/workflows/release.yml'), 'utf8');
  assert.ok(workflow.indexOf('prepare-native-dependencies.cjs') < workflow.indexOf('node .\\build.js --vendor galaxyxr'));
  assert.match(workflow, /prepare-native-dependencies\.cjs --check/);
});
