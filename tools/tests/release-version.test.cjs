'use strict';
const { fixtureRoot } = require('../lib/test-fixtures.cjs');

// node --test tools/tests/release-version.test.cjs
// No npm install required. PowerShell integration cases run when that host is
// available; the Windows workflow requires both pwsh and Windows PowerShell.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { verifyReleaseVersion } = require('../verify-release-version.cjs');
const project = path.resolve(__dirname, '../..');
const cli = path.join(project, 'tools/verify-release-version.cjs');
const wrapper = path.join(project, 'tools/Verify-ReleaseVersion.ps1');

function write(repo, file, value) {
  const target = path.join(repo, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value);
}
function seed(repo, legacy = false) {
  const gui = legacy ? 'CustomHeadsetGUI' : 'GalaxyXRDriverGUI';
  const driver = legacy ? 'CustomHeadsetOpenVR' : 'GalaxyXRDriver';
  const crate = legacy ? 'custom-headset-gui' : 'galaxyxrdriver-gui';
  const files = {
    config: `${driver}/src/Config/Config.cpp`,
    manifest: `${driver}/DriverFiles/driver.vrdrivermanifest`,
    package: `${gui}/package.json`,
    lock: `${gui}/package-lock.json`,
    tauri: `${gui}/src-tauri/tauri.conf.json`,
    cargo: `${gui}/src-tauri/Cargo.toml`,
    cargoLock: `${gui}/src-tauri/Cargo.lock`,
  };
  write(repo, files.config, 'std::string driverVersion = "1.2.0";\n');
  write(repo, files.manifest, JSON.stringify({ name: 'GalaxyXRNative', version: '1.2.0' }));
  write(repo, files.package, JSON.stringify({ name: crate, version: '1.2.0' }));
  write(repo, files.lock, JSON.stringify({ name: crate, version: '1.2.0', lockfileVersion: 3, packages: {
    '': { name: crate, version: '1.2.0' },
    'node_modules/example': { version: '9.8.7' },
  } }));
  write(repo, files.tauri, JSON.stringify({ productName: 'Galaxy XR Companion', version: '1.2.0' }));
  write(repo, files.cargo, `[package]\nname = "${crate}"\nversion = "1.2.0"\n\n[dependencies]\nexample = "9.8.7"\n`);
  write(repo, files.cargoLock, `version = 4\n\n[[package]]\nname = "example"\nversion = "9.8.7"\nsource = "registry+https://example.invalid"\n\n[[package]]\nname = "${crate}"\nversion = "1.2.0"\ndependencies = [\n "example",\n]\n`);
  return { repo, gui, driver, crate, files };
}
function fixture(t, legacy = false) {
  const repo = fs.mkdtempSync(path.join(fixtureRoot(), 'GalaxyXRDriver release [fixture] '));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  return seed(repo, legacy);
}
function editJson(f, field, modify) {
  const value = JSON.parse(fs.readFileSync(path.join(f.repo, f.files[field]), 'utf8'));
  modify(value);
  write(f.repo, f.files[field], JSON.stringify(value));
}
function run(f, ...args) {
  return spawnSync(process.execPath, [cli, '--repo', f.repo, ...args], { encoding: 'utf8', timeout: 15000 });
}

for (const legacy of [false, true]) {
  test(`valid ${legacy ? 'legacy' : 'renamed'} source validates all eight embedded version fields`, t => {
    const f = fixture(t, legacy);
    const result = verifyReleaseVersion(f.repo, { tag: 'v1.2.0', expectedVersion: '1.2.0' });
    assert.equal(result.version, '1.2.0');
    assert.deepEqual(result.layout, { gui: f.gui, driver: f.driver });
    for (const label of ['C++ driver', 'OpenVR manifest', 'npm package', 'npm lockfile root', 'npm lockfile package', 'Tauri configuration', 'Cargo.toml', 'Cargo.lock']) {
      assert.ok(result.messages.includes(`[version] ${label} = 1.2.0`));
    }
  });
}
test('actual shipped source and full npm lockfile validate', () => {
  const gui = fs.existsSync(path.join(project, 'GalaxyXRDriverGUI')) ? 'GalaxyXRDriverGUI' : 'CustomHeadsetGUI';
  const version = JSON.parse(fs.readFileSync(path.join(project, gui, 'package.json'), 'utf8').replace(/^\uFEFF/, '')).version;
  assert.equal(verifyReleaseVersion(project, { tag: `v${version}` }).version, version);
});
test('normal npm empty root key is preserved; dependency versions are unrelated', t => {
  const f = fixture(t);
  editJson(f, 'lock', x => { x.packages['node_modules/Another'] = { version: '99.1.2' }; x.packages['node_modules/another'] = { version: '98.1.2' }; });
  assert.equal(verifyReleaseVersion(f.repo).version, '1.2.0');
});
test('npm lockfile v2 with the root entry also validates', t => {
  const f = fixture(t); editJson(f, 'lock', x => { x.lockfileVersion = 2; });
  assert.equal(verifyReleaseVersion(f.repo).version, '1.2.0');
});
test('UTF-8 BOM and CRLF inputs validate without being rewritten', t => {
  const f = fixture(t);
  const originals = new Map();
  for (const relative of Object.values(f.files)) {
    const value = '\uFEFF' + fs.readFileSync(path.join(f.repo, relative), 'utf8').replace(/\n/g, '\r\n');
    write(f.repo, relative, value); originals.set(relative, value);
  }
  assert.equal(verifyReleaseVersion(f.repo).version, '1.2.0');
  for (const [relative, value] of originals) assert.equal(fs.readFileSync(path.join(f.repo, relative), 'utf8'), value);
});
test('tag mismatch remains a hard failure', t => {
  const f = fixture(t); assert.throws(() => verifyReleaseVersion(f.repo, { tag: 'v1.2.1' }), /Git tag.*does not match/);
});
test('requested-version mismatch remains a hard failure', t => {
  const f = fixture(t); assert.throws(() => verifyReleaseVersion(f.repo, { expectedVersion: '1.2.1' }), /Requested release version mismatch/);
});
for (const [field, label] of [['manifest', 'OpenVR manifest'], ['package', 'npm package'], ['lock', 'npm lockfile root'], ['tauri', 'Tauri configuration']]) {
  test(`${label} mismatch is rejected`, t => {
    const f = fixture(t); editJson(f, field, x => { x.version = '1.2.1'; });
    assert.throws(() => verifyReleaseVersion(f.repo), new RegExp(`${label} version mismatch`));
  });
}
test('the npm packages[""] version is independently checked', t => {
  const f = fixture(t); editJson(f, 'lock', x => { x.packages[''].version = '1.2.1'; });
  assert.throws(() => verifyReleaseVersion(f.repo), /npm lockfile package version mismatch/);
});
for (const field of ['cargo', 'cargoLock']) {
  test(`${field} mismatch is rejected`, t => {
    const f = fixture(t); const p = path.join(f.repo, f.files[field]);
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('version = "1.2.0"', 'version = "1.2.1"'));
    assert.throws(() => verifyReleaseVersion(f.repo), /Cargo\.(toml|lock) version mismatch/);
  });
}
test('changing only the C++ version cannot publish other old versions', t => {
  const f = fixture(t); write(f.repo, f.files.config, 'std::string driverVersion = "1.2.1";\n');
  assert.throws(() => verifyReleaseVersion(f.repo), /OpenVR manifest version mismatch/);
});
for (const broken of ['missing', 'null', 'array']) {
  test(`invalid ${broken} npm root package is rejected`, t => {
    const f = fixture(t); editJson(f, 'lock', x => { if (broken === 'missing') delete x.packages['']; else x.packages[''] = broken === 'null' ? null : []; });
    assert.throws(() => verifyReleaseVersion(f.repo), /root package entry/);
  });
}
test('a missing npm packages object is rejected', t => {
  const f = fixture(t); editJson(f, 'lock', x => { delete x.packages; });
  assert.throws(() => verifyReleaseVersion(f.repo), /root package entry/);
});
for (const version of [null, 120, '', ['1.2.0']]) {
  test(`invalid version value ${JSON.stringify(version)} is rejected`, t => {
    const f = fixture(t); editJson(f, 'lock', x => { x.packages[''].version = version; });
    assert.throws(() => verifyReleaseVersion(f.repo), /Missing or invalid npm lockfile package version/);
  });
}
test('invalid JSON reports the affected file', t => {
  const f = fixture(t); write(f.repo, f.files.lock, '{broken');
  assert.throws(() => verifyReleaseVersion(f.repo), /Cannot parse release JSON .*package-lock.json/);
});
test('a missing release input is not silently skipped', t => {
  const f = fixture(t); fs.unlinkSync(path.join(f.repo, f.files.tauri));
  assert.throws(() => verifyReleaseVersion(f.repo), /Cannot read release input .*tauri.conf.json/);
});
test('renamed folders take priority over stale legacy copies', t => {
  const f = fixture(t); const old = seed(f.repo, true); editJson(old, 'package', x => { x.version = '0.1.0'; });
  assert.equal(verifyReleaseVersion(f.repo).layout.gui, 'GalaxyXRDriverGUI');
});
test('partially renamed layouts fail instead of mixing source generations', t => {
  const f = fixture(t, true); fs.mkdirSync(path.join(f.repo, 'GalaxyXRDriverGUI'));
  assert.throws(() => verifyReleaseVersion(f.repo), /Incomplete source layout/);
});
test('missing source layout is reported clearly', t => {
  const f = fixture(t); fs.rmSync(path.join(f.repo, f.gui), { recursive: true }); fs.rmSync(path.join(f.repo, f.driver), { recursive: true });
  assert.throws(() => verifyReleaseVersion(f.repo), /Could not locate/);
});
test('Cargo package version cannot come from another section', t => {
  const f = fixture(t); write(f.repo, f.files.cargo, `[package]\nname = "${f.crate}"\n\n[dependencies.fake]\nversion = "1.2.0"\n`);
  assert.throws(() => verifyReleaseVersion(f.repo), /package version from Cargo.toml/);
});
test('Cargo lockfield order and comments do not affect validation', t => {
  const f = fixture(t); write(f.repo, f.files.cargoLock, `version = 4\n[[package]] # local application\nversion = "1.2.0" # release\nname = "${f.crate}"\n`);
  assert.equal(verifyReleaseVersion(f.repo).version, '1.2.0');
});
test('Cargo name is read from its package rather than hardcoded', t => {
  const f = fixture(t);
  for (const field of ['cargo', 'cargoLock']) {
    const p = path.join(f.repo, f.files[field]); fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replaceAll(f.crate, 'fixture-app'));
  }
  assert.equal(verifyReleaseVersion(f.repo).version, '1.2.0');
});
test('a registry crate cannot masquerade as the local Cargo package', t => {
  const f = fixture(t); write(f.repo, f.files.cargoLock, `version = 4\n[[package]]\nname = "${f.crate}"\nversion = "1.2.0"\nsource = "registry+https://example.invalid"\n`);
  assert.throws(() => verifyReleaseVersion(f.repo), /exactly one local/);
});
test('duplicate local Cargo entries fail explicitly', t => {
  const f = fixture(t); fs.appendFileSync(path.join(f.repo, f.files.cargoLock), `\n[[package]]\nname = "${f.crate}"\nversion = "1.2.0"\n`);
  assert.throws(() => verifyReleaseVersion(f.repo), /exactly one local/);
});
test('machine output has one safe JSON envelope and no native stderr', t => {
  const f = fixture(t); const p = run(f, '--json', '--tag', 'v1.2.0');
  assert.equal(p.status, 0, p.stderr); assert.equal(p.stderr, '');
  const response = JSON.parse(p.stdout); assert.equal(response.ok, true); assert.equal(response.version, '1.2.0');
  function inspect(value) { if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) { assert.notEqual(key, ''); inspect(child); } }
  inspect(response);
});
test('machine failure is nonzero with a safe error envelope', t => {
  const f = fixture(t); const p = run(f, '--json', '--tag', 'v9.9.9');
  assert.equal(p.status, 1); assert.equal(p.stderr, '');
  const response = JSON.parse(p.stdout); assert.equal(response.ok, false); assert.match(response.error, /Git tag/); assert.equal(response.version, undefined);
});
test('version-only output is exactly one line', t => {
  const f = fixture(t); const p = run(f, '--version-only');
  assert.equal(p.status, 0); assert.equal(p.stdout, '1.2.0\n'); assert.equal(p.stderr, '');
});
test('malformed CLI options fail rather than skipping checks', t => {
  const f = fixture(t);
  for (const args of [['--tag'], ['--unknown'], ['--json', '--version-only']]) assert.equal(run(f, ...args).status, 1);
});
test('running validation leaves all release input bytes unchanged', t => {
  const f = fixture(t);
  const hash = () => Object.fromEntries(Object.values(f.files).map(relative => [relative, createHash('sha256').update(fs.readFileSync(path.join(f.repo, relative))).digest('hex')]));
  const before = hash(); assert.equal(run(f, '--json').status, 0); assert.deepEqual(hash(), before);
});

// Exercise the actual .ps1 wrapper under both hosts on Windows CI. Locally the
// tests report SKIP, not PASS, when a PowerShell executable is unavailable.
for (const host of ['pwsh', 'powershell']) {
  const detected = spawnSync(host, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8', timeout: 15000 });
  const available = detected.status === 0;
  if (process.env.REQUIRE_POWERSHELL_TESTS === '1') {
    test(`${host} must be available on Windows release CI`, () => assert.ok(available, `${host} is required for wrapper integration tests`));
  }
  for (const mode of ['passthru', 'no-passthru', 'legacy', 'wrong-tag', 'wrong-expected', 'missing-root', 'missing-helper']) {
    test(`${host} wrapper: ${mode}`, { skip: available ? false : `${host} is not installed in this environment` }, t => {
      const f = fixture(t, mode === 'legacy');
      const relativeWrapper = 'tools/Verify-ReleaseVersion.ps1';
      write(f.repo, relativeWrapper, fs.readFileSync(wrapper));
      if (mode !== 'missing-helper') write(f.repo, 'tools/verify-release-version.cjs', fs.readFileSync(cli));
      if (mode === 'missing-root') editJson(f, 'lock', x => { delete x.packages['']; });
      const psQuote = x => `'${x.replaceAll("'", "''")}'`;
      const fail = ['wrong-tag', 'wrong-expected', 'missing-root', 'missing-helper'].includes(mode);
      const args = mode === 'wrong-expected' ? '-ExpectedVersion 9.9.9 -PassThru' : `-Tag ${mode === 'wrong-tag' ? 'v9.9.9' : 'v1.2.0'} ${mode === 'no-passthru' ? '' : '-PassThru'}`;
      const body = `$ErrorActionPreference = 'Stop'\n$values = @(& ${psQuote(path.join(f.repo, relativeWrapper))} ${args} 6>$null)\n` +
        (mode === 'no-passthru' ? "if ($values.Count -ne 0) { throw 'Unexpected pipeline output' }\n" : "if ($values.Count -ne 1 -or $values[0] -cne '1.2.0') { throw 'PassThru must emit exactly one version' }\n") +
        "Write-Output 'WRAPPER_OK'\nexit 0\n";
      const harness = path.join(f.repo, 'invoke-wrapper.ps1'); fs.writeFileSync(harness, body);
      const p = spawnSync(host, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness], { encoding: 'utf8', timeout: 30000 });
      if (fail) { assert.notEqual(p.status, 0, p.stdout); assert.doesNotMatch(p.stdout, /WRAPPER_OK/); }
      else { assert.equal(p.status, 0, p.stderr); assert.equal(p.stdout.trim(), 'WRAPPER_OK'); }
    });
  }
}
