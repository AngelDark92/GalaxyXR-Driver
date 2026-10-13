#!/usr/bin/env node
'use strict';

/* Restore exact pinned native dependency inputs without overwriting local edits. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const OFFICIAL_REPOSITORIES = Object.freeze({
  openvr: 'https://github.com/ValveSoftware/openvr.git',
  minhook: 'https://github.com/TsudaKageyu/minhook.git',
  json: 'https://github.com/nlohmann/json.git',
  easywsclient: 'https://github.com/dhbaird/easywsclient.git',
  zlib: 'https://github.com/madler/zlib.git',
});
const DEFAULT_LOCK = path.join(__dirname, 'native-dependencies.lock.json');
const nonemptyFile = file => { try { return fs.statSync(file).isFile() && fs.statSync(file).size > 0; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const slash = name => name.replaceAll('\\', '/');

function relativeName(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.startsWith('/') ||
      value.split('/').some(part => !part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/.test(part))) {
    throw new Error(`Unsafe dependency path: ${JSON.stringify(value)}`);
  }
  return value;
}
function loadLock(filename = DEFAULT_LOCK) {
  const lock = JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
  if (lock.schemaVersion !== 1 || !Array.isArray(lock.dependencies)) throw new Error('Invalid native dependency lock.');
  const names = new Set();
  for (const dep of lock.dependencies) {
    if (!OFFICIAL_REPOSITORIES[dep.name] || names.has(dep.name) || dep.repository !== OFFICIAL_REPOSITORIES[dep.name] ||
        dep.directory !== `ThirdParty/${dep.name}` || !/^[a-f0-9]{40}$/.test(dep.revision)) {
      throw new Error(`Invalid or unpinned native dependency: ${dep.name}`);
    }
    names.add(dep.name);
    if (!Array.isArray(dep.required) || !dep.required.length || !Array.isArray(dep.prefixes) || !Array.isArray(dep.files)) throw new Error(`Incomplete dependency lock: ${dep.name}`);
    for (const file of [...dep.required, ...dep.files]) relativeName(file);
    for (const prefix of dep.prefixes) { if (!prefix.endsWith('/')) throw new Error('Dependency prefixes must end in /.'); relativeName(prefix.slice(0, -1)); }
  }
  if (names.size !== Object.keys(OFFICIAL_REPOSITORIES).length) throw new Error('The native dependency lock must contain all five libraries.');
  return lock;
}
function safeTarget(root, relative) {
  relativeName(slash(relative));
  const base = path.resolve(root);
  const target = path.resolve(base, relative);
  if (!target.startsWith(base + path.sep)) throw new Error(`Dependency path escapes project: ${relative}`);
  for (let current = target; current; current = path.dirname(current)) {
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Dependency path uses a symlink/junction: ${current}`); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (current === path.dirname(current)) break;
  }
  return target;
}
function requiredFiles(dep, read) {
  const wanted = new Set(dep.required);
  if (dep.name === 'json') {
    const queue = [...wanted];
    for (let i = 0; i < queue.length; i++) {
      const data = read(queue[i]);
      if (!data) continue;
      const text = data.toString('utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const match of text.matchAll(/^\s*#\s*include\s*[<"](nlohmann\/[^>"\r\n]+)[>"]/gm)) {
        const file = relativeName('include/' + match[1]);
        if (!wanted.has(file)) { wanted.add(file); queue.push(file); }
      }
    }
  }
  return [...wanted].sort();
}
function inspectNativeDependencies(repo, { lock = loadLock() } = {}) {
  repo = path.resolve(repo);
  return lock.dependencies.map(dep => {
    const required = requiredFiles(dep, file => {
      const target = safeTarget(repo, `${dep.directory}/${file}`);
      return nonemptyFile(target) ? fs.readFileSync(target) : null;
    });
    const missing = required.filter(file => !nonemptyFile(safeTarget(repo, `${dep.directory}/${file}`)));
    return { ...dep, required, missing };
  });
}
function missingSummary(entries) {
  return entries.filter(dep => dep.missing.length).map(dep => `- ${dep.directory}: ${dep.missing.join(', ')}`).join('\n');
}
function gitRun(args, { cwd, input, logFile, soft = false, git = 'git', timeout = 300000 } = {}) {
  const result = spawnSync(git, args, { cwd, input, windowsHide: true, timeout, maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', LC_ALL: 'C', LANG: 'C' } });
  if (logFile) {
    fs.appendFileSync(logFile, `$ git ${args.join(' ')}\n`);
    if (result.stderr?.length) fs.appendFileSync(logFile, result.stderr);
  }
  if (result.error) throw new Error(`Cannot run Git (${result.error.message}). Install Git for Windows or restore the exact missing ThirdParty files. No compiler setting can replace missing source files.`);
  if (result.signal) throw new Error(`Native dependency Git operation interrupted: ${result.signal}`);
  if (result.status !== 0 && !soft) throw new Error(`Git failed (${result.status}): ${result.stderr?.toString('utf8').trim() || args[0]}${logFile ? `\nLog: ${logFile}` : ''}`);
  return result;
}
function selectedRevision(repo, dep, git = 'git') {
  const result = gitRun(['-C', repo, 'ls-files', '--stage', '--', dep.directory], { git, soft: true, timeout: 15000 });
  if (result.status !== 0) {
    if (/not a git repository/i.test(result.stderr?.toString('utf8') || '')) return { revision: dep.revision, source: 'source-snapshot lock' };
    throw new Error(`Cannot inspect dependency gitlink: ${result.stderr?.toString('utf8')}`);
  }
  const entries = result.stdout.toString('utf8').trim().split(/\r?\n/);
  for (const line of entries) {
    const match = /^(\d{6}) ([a-f\d]{40}) (\d)\t(.+)$/.exec(line);
    if (match && match[4] === dep.directory) {
      if (match[3] !== '0') throw new Error(`Resolve the Git index conflict for ${dep.directory} before building.`);
      if (match[1] === '160000') return { revision: match[2], source: 'current Git submodule pin' };
    }
  }
  return { revision: dep.revision, source: 'vendored/source-snapshot lock' };
}
function selectedPath(dep, file) {
  return dep.required.includes(file) || dep.files.includes(file) || dep.prefixes.some(prefix => file.startsWith(prefix)) ||
    (dep.rootCAndHeaders === true && /^[^/]+\.(?:c|h)$/.test(file));
}
function parseBatch(buffer, entries) {
  const files = new Map(); let offset = 0;
  for (const entry of entries) {
    const end = buffer.indexOf(10, offset);
    if (end < 0) throw new Error('Truncated Git blob batch header.');
    const header = buffer.subarray(offset, end).toString('ascii');
    const match = /^([a-f\d]{40}) blob (\d+)$/.exec(header);
    if (!match || match[1] !== entry.sha) throw new Error(`Unexpected Git blob response for ${entry.file}.`);
    const size = Number(match[2]); offset = end + 1;
    if (!Number.isSafeInteger(size) || size < 0 || offset + size >= buffer.length || buffer[offset + size] !== 10) throw new Error('Truncated Git blob batch body.');
    const data = buffer.subarray(offset, offset + size); offset += size + 1;
    const digest = crypto.createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
    if (digest !== entry.sha) throw new Error(`Git object checksum mismatch: ${entry.file}`);
    files.set(entry.file, Buffer.from(data));
  }
  if (offset !== buffer.length) throw new Error('Unexpected trailing Git blob data.');
  return files;
}

/**
 * Return the Git object directory only when `directory` has its own Git
 * metadata. An initialized submodule has a `.git` file and a standalone clone
 * has a `.git` directory. A vendored dependency inside the parent repository
 * has neither, so Git is never allowed to walk upward and borrow parent
 * objects.
 *
 * Prefer the filesystem marker over `rev-parse --show-prefix`/toplevel path
 * comparisons. Git for Windows can report the same worktree using a different
 * slash, case, or canonical path spelling, while the `.git` marker has stable
 * semantics on every supported platform.
 */
function existingObjectDirectory(repo, dep, revision, git = 'git') {
  const directory = safeTarget(repo, dep.directory);
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) return null;

  const marker = path.join(directory, '.git');
  let markerStat;
  try { markerStat = fs.lstatSync(marker); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (markerStat.isSymbolicLink() || (!markerStat.isFile() && !markerStat.isDirectory())) return null;

  const found = gitRun(['-C', directory, 'cat-file', '-e', `${revision}^{commit}`], { git, soft: true, timeout: 15000 });
  if (found.status !== 0) return null;

  const gitDir = gitRun(['-C', directory, 'rev-parse', '--absolute-git-dir'], { git, soft: true, timeout: 15000 });
  if (gitDir.status !== 0) return null;
  const value = gitDir.stdout.toString('utf8').trim();
  if (!value) return null;
  // Feed Git's own absolute spelling back to Git; do not reinterpret it with Node.
  return value;
}

function readSnapshot(dep, revision, cache, { noDownload, git = 'git', logFile, transport, existingObjects } = {}) {
  const objectDir = existingObjects || safeTarget(cache, `${dep.name}-${revision}.git`);
  const run = args => gitRun(['--git-dir', objectDir, ...args], { git, logFile });
  let available = false;
  // Existing submodule paths come from Git itself; let Git validate them even
  // when Node and Git for Windows use different canonical path spellings.
  if (existingObjects || fs.existsSync(objectDir)) {
    const check = gitRun(['--git-dir', objectDir, 'cat-file', '-e', `${revision}^{commit}`], { git, soft: true, logFile });
    available = check.status === 0;
  }
  if (!available) {
    if (existingObjects) throw new Error(`Existing submodule objects do not contain ${dep.name}@${revision}.`);
    if (noDownload) throw new Error(`Offline cache is missing ${dep.name}@${revision}; run once without --no-download.`);
    if (!fs.existsSync(objectDir)) gitRun(['init', '--bare', objectDir], { git, logFile });
    const remote = transport || dep.repository;
    if (!transport && remote !== OFFICIAL_REPOSITORIES[dep.name]) throw new Error('Refusing an unapproved native dependency remote.');
    gitRun(['-c', 'fetch.fsckObjects=true', '-c', 'transfer.fsckObjects=true', '--git-dir', objectDir,
      'fetch', '--no-tags', '--depth=1', remote, revision], { git, logFile });
  }
  const actual = run(['rev-parse', '--verify', `${revision}^{commit}`]).stdout.toString('ascii').trim();
  if (actual !== revision) throw new Error(`Native dependency revision mismatch: ${dep.name}`);
  const tree = run(['ls-tree', '-r', '-z', revision]).stdout.toString('utf8').split('\0').filter(Boolean);
  const entries = [];
  for (const row of tree) {
    const match = /^(\d{6}) (\w+) ([a-f\d]{40})\t([\s\S]+)$/.exec(row);
    if (!match) throw new Error('Invalid dependency Git tree.');
    if (!selectedPath(dep, match[4])) continue;
    relativeName(match[4]);
    if (!['100644', '100755'].includes(match[1]) || match[2] !== 'blob') throw new Error(`Non-file in dependency sources: ${match[4]}`);
    entries.push({ file: match[4], sha: match[3] });
  }
  const result = gitRun(['--git-dir', objectDir, 'cat-file', '--batch'], { git,
    input: entries.map(entry => entry.sha).join('\n') + '\n' });
  const files = parseBatch(result.stdout, entries);
  const missing = requiredFiles(dep, file => files.get(file)).filter(file => !files.get(file)?.length);
  if (missing.length) throw new Error(`Pinned ${dep.name}@${revision} does not contain the build inputs: ${missing.join(', ')}. No different upstream version was selected.`);
  return files;
}
function sameSource(file, actual, expected) {
  if (actual.equals(expected)) return true;
  if (/\.(?:c|h|cpp|hpp|in|vcxproj|filters|props|targets|txt|md)$/i.test(file) || /(?:^|\/)(?:LICENSE(?:\.MIT)?|COPYING|README)$/.test(file)) {
    return actual.toString('utf8').replace(/\r\n/g, '\n') === expected.toString('utf8').replace(/\r\n/g, '\n');
  }
  return false;
}
function repairPlan(repo, dep, files) {
  const add = [], conflicts = [];
  for (const [file, data] of files) {
    const relative = `${dep.directory}/${file}`;
    const target = safeTarget(repo, relative);
    if (!fs.existsSync(target)) { add.push({ relative, data }); continue; }
    if (!fs.statSync(target).isFile() || !sameSource(file, fs.readFileSync(target), data)) conflicts.push(relative);
  }
  if (conflicts.length) throw new Error(`Existing dependency files differ from the selected revision; refusing to mix versions or overwrite local edits:\n- ${conflicts.join('\n- ')}\nKeep a backup and use the matching Git submodule pin or deliberately update tools/native-dependencies.lock.json to your source revision.`);
  return add;
}
function applyPlan(repo, plans) {
  const created = [];
  try {
    for (const { relative, data } of plans) {
      const target = safeTarget(repo, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const fd = fs.openSync(target, 'wx'); created.push(target);
      try { fs.writeFileSync(fd, data); } finally { fs.closeSync(fd); }
    }
  } catch (error) {
    for (const file of created.reverse()) fs.unlinkSync(file);
    throw error;
  }
  return created.length;
}
function prepareNativeDependencies(repo, { noDownload = false, check = false, lock = loadLock(),
    git = 'git', log = text => console.log(`[native-deps] ${text}`), transports = {} } = {}) {
  repo = path.resolve(repo);
  const inspection = inspectNativeDependencies(repo, { lock });
  const missing = inspection.filter(dep => dep.missing.length);
  if (!missing.length) { log('All native headers, sources, MinHook VC17 project, and x64 OpenVR library are present.'); return { repaired: [], filesAdded: 0, inspected: inspection.length }; }
  if (check) throw new Error(`Native dependency checkout is incomplete:\n${missingSummary(inspection)}\nRun: node tools/prepare-native-dependencies.cjs`);
  log(`Missing native build inputs:\n${missingSummary(inspection)}`);
  // External artifacts (2026-10-08): keep dependency snapshots and logs out of source.
  const root = safeTarget(path.resolve(repo, '../builds/GalaxyXR-Driver'), 'build/native-dependencies');
  fs.mkdirSync(root, { recursive: true });
  const lockFile = path.join(root, '.prepare.lock');
  let fd;
  try { fd = fs.openSync(lockFile, 'wx'); }
  catch (e) { if (e.code === 'EEXIST') throw new Error(`Another native dependency setup is using this checkout. Wait for it to finish. If an earlier process crashed, confirm it stopped before removing ${lockFile}`); throw e; }
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    const reports = [], plans = [];
    for (const dep of missing) {
      const selected = selectedRevision(repo, dep, git);
      const logFile = safeTarget(root, `${dep.name}-fetch.log`);
      log(`${dep.name}: ${selected.revision} (${selected.source}). Preparing exact sources${noDownload ? ' from cache only' : ''} ...`);
      const existingObjects = existingObjectDirectory(repo, dep, selected.revision, git);
      const snapshot = readSnapshot(dep, selected.revision, root, { noDownload, git, logFile, transport: transports[dep.name], existingObjects });
      const plan = repairPlan(repo, dep, snapshot);
      reports.push({ name: dep.name, revision: selected.revision, source: selected.source,
        repository: dep.repository, added: plan.map(item => item.relative) });
      plans.push(...plan);
    }
    const filesAdded = applyPlan(repo, plans);
    const remaining = inspectNativeDependencies(repo, { lock }).filter(dep => dep.missing.length);
    if (remaining.length) throw new Error(`Dependency restoration is incomplete:\n${missingSummary(remaining)}`);
    const report = { repaired: reports, filesAdded, inspected: inspection.length };
    fs.writeFileSync(safeTarget(root, 'restoration-report.json'), JSON.stringify(report, null, 2) + '\n');
    log(`Restored ${filesAdded} missing files from ${reports.length} pinned dependencies. Existing source files were preserved.`);
    return report;
  } finally { fs.closeSync(fd); fs.unlinkSync(lockFile); }
}

module.exports = { loadLock, inspectNativeDependencies, requiredFiles, selectedRevision, parseBatch,
  existingObjectDirectory, readSnapshot, repairPlan, applyPlan, safeTarget, sameSource, prepareNativeDependencies };
if (require.main === module) {
  try {
    const options = {}; let repo = path.resolve(__dirname, '..');
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--check') options.check = true;
      else if (args[i] === '--no-download') options.noDownload = true;
      else if (args[i] === '--project' && args[i + 1] && !args[i + 1].startsWith('--')) repo = args[++i];
      else throw new Error('Usage: node tools/prepare-native-dependencies.cjs [--project <directory>] [--check] [--no-download]');
    }
    prepareNativeDependencies(repo, options);
  } catch (error) { console.error(`[native-deps] ${error.message}`); process.exitCode = 1; }
}
