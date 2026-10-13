'use strict';
const { fixtureRoot } = require('../lib/test-fixtures.cjs');
// No network or real dependency install. Selection/planning use publisher-shaped
// fixtures; Windows hosts additionally exercise the actual PowerShell I/O bridge.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const tools = require('../lib/portable-toolchain.cjs');
const repo = path.resolve(__dirname, '../..');
const sha = 'a'.repeat(64);
function temp(t) { const root = fs.mkdtempSync(path.join(fixtureRoot(), 'GalaxyXR tools [fixture] ')); t.after(() => fs.rmSync(root, { force: true, recursive: true, maxRetries: 4, retryDelay: 100 })); return root; }
function file(root, relative, text = 'fixture') { const target = path.join(root, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, text); return target; }
function fixturePayload(name, extra = {}) { return { fileName: name, url: 'https://download.visualstudio.microsoft.com/test/' + encodeURIComponent(name), sha256: sha, ...extra }; }
function catalog() {
  const family = '14.44.17.14';
  const channel = { channelItems: [{ id: 'Microsoft.VisualStudio.Product.BuildTools', localizedResources: [{ language: 'en-us', license: 'https://visualstudio.microsoft.com/license-terms/' }] }] };
  const packages = ['tools.hostx64.targetx64.base', 'tools.hostx64.targetx64.res.base', 'crt.headers.base', 'crt.x64.desktop.base', 'crt.source.base']
    .map(suffix => ({ id: `Microsoft.VC.${family}.${suffix}`, version: '14.44.12345', payloads: [fixturePayload(suffix + '.vsix')] }));
  packages.push({ id: 'Microsoft.VisualStudio.Component.Windows11SDK.26100', dependencies: { 'SDK.Redirect': '1' } });
  packages.push({ id: 'SDK.Redirect', dependencies: { 'SDK.Payload': '1' } });
  packages.push({ id: 'SDK.Payload', payloads: ['Windows SDK for Windows Store Apps Tools-x86_en-us.msi', 'Windows SDK for Windows Store Apps Headers-x86_en-us.msi',
    'Windows SDK for Windows Store Apps Libs-x86_en-us.msi', 'Universal CRT Headers Libraries and Sources-x86_en-us.msi',
    'Windows SDK Desktop Headers x64-x86_en-us.msi', 'Windows SDK Desktop Libs x64-x86_en-us.msi', 'a'.repeat(32) + '.cab']
    .map(name => fixturePayload('Installers\\' + name)) });
  return { channel, manifest: { packages } };
}
function layoutFixture(root, vcVersion = '14.44.35207', sdkVersion = '10.0.26100.0') {
  const vcRoot = path.join(root, 'VC/Tools/MSVC'), sdk = path.join(root, 'Windows Kits/10');
  for (const name of ['cl.exe', 'link.exe', 'dumpbin.exe', 'lib.exe', 'c1xx.dll', 'c2.dll']) file(vcRoot, `${vcVersion}/bin/Hostx64/x64/${name}`);
  for (const name of ['include/vector', 'include/vcruntime.h', 'lib/x64/libcmt.lib', 'lib/x64/libcpmt.lib']) file(vcRoot, `${vcVersion}/${name}`);
  for (const name of [`bin/${sdkVersion}/x64/rc.exe`, `bin/${sdkVersion}/x64/mt.exe`, `Include/${sdkVersion}/um/Windows.h`,
    `Include/${sdkVersion}/shared/sdkddkver.h`, `Include/${sdkVersion}/ucrt/stdio.h`, `Lib/${sdkVersion}/um/x64/kernel32.lib`, `Lib/${sdkVersion}/ucrt/x64/ucrt.lib`]) file(sdk, name);
  return { vcRoot, sdk };
}
for (const host of ['download.visualstudio.microsoft.com', 'download.microsoft.com', 'nodejs.org', 'static.rust-lang.org']) {
  test(`Allows official HTTPS downloads from ${host}`, () => assert.equal(new URL(tools.safeUri(`https://${host}/file.zip`)).hostname, host));
}
for (const url of ['http://nodejs.org/file.zip', 'https://nodejs.org.evil.invalid/file.zip', 'https://user:pass@nodejs.org/file.zip',
  'https://nodejs.org:444/file.zip', 'https://aka.ms/unrelated', 'file:///tmp/installer.exe', 'https://nodejs.org/file#fragment']) {
  test(`Rejects unsafe download URL: ${url}`, () => assert.throws(() => tools.safeUri(url)));
}
test('Allows only the reviewed VS 2022 channel redirect endpoint', () => assert.equal(tools.safeUri('https://aka.ms/vs/17/release/channel'), 'https://aka.ms/vs/17/release/channel'));
test('Payloads require a publisher SHA-256 before extraction', () => { assert.throws(() => tools.payload(fixturePayload('x.vsix', { sha256: '' })), /SHA-256/); assert.equal(tools.payload(fixturePayload('Installers\\SDK.msi')).name, 'SDK.msi'); });
test('Rejects unsafe package basenames', () => { for (const name of ['..', '', 'C:payload', 'x\0.exe']) assert.throws(() => tools.safeName(name)); });
test('Finds exact checksum line, not a similar version/platform', () => { const text = `${'b'.repeat(64)}  other.zip\r\n${sha} *node.zip\r\n`; assert.equal(tools.parseShasums(text, 'node.zip'), sha); assert.throws(() => tools.parseShasums(text, 'ode.zip')); });
test('Plans required MSVC and SDK packages including indirect SDK dependency', () => { const c = catalog(); const p = tools.planMicrosoft(c.channel, c.manifest); assert.equal(p.family, '14.44.17.14'); assert.equal(p.vcPayloads.length, 5); assert.equal(p.sdkMsi.length, 6); assert.equal(p.sdkCab.length, 1); });
test('Missing optional MSVC packages do not conceal required packages', () => { const c = catalog(); c.manifest.packages = c.manifest.packages.filter(p => !p.id.includes('crt.source')); assert.equal(tools.planMicrosoft(c.channel, c.manifest).vcPayloads.length, 4); });
test('Missing required compiler payload fails before download', () => { const c = catalog(); c.manifest.packages = c.manifest.packages.filter(p => !p.id.includes('crt.headers')); assert.throws(() => tools.planMicrosoft(c.channel, c.manifest), /required package/); });
test('Does not silently switch to a different MSVC family', () => { const c = catalog(); for (const p of c.manifest.packages) p.id = p.id.replace('14.44', '14.50'); assert.throws(() => tools.planMicrosoft(c.channel, c.manifest), /MSVC 14.44/); });
test('Missing SDK family is a clear setup failure', () => { const c = catalog(); c.manifest.packages = c.manifest.packages.filter(p => !p.id.includes('Windows11SDK')); assert.throws(() => tools.planMicrosoft(c.channel, c.manifest), /SDK 26100/); });
test('SDK missing its x64 libraries is not treated as complete', () => { const c = catalog(); c.manifest.packages.at(-1).payloads = c.manifest.packages.at(-1).payloads.filter(p => !p.fileName.includes('Desktop Libs')); assert.throws(() => tools.planMicrosoft(c.channel, c.manifest), /Required Windows SDK installer/); });
test('Rejects catalog binary entries without a hash', () => { const c = catalog(); c.manifest.packages[0].payloads[0].sha256 = null; assert.throws(() => tools.planMicrosoft(c.channel, c.manifest), /SHA-256/); });
test('License must be provided by channel before a new toolchain is prepared', () => { const c = catalog(); c.channel.channelItems = []; assert.throws(() => tools.planMicrosoft(c.channel, c.manifest), /license/); });
test('Manifest language selection does not accidentally choose a different-language payload', () => { const c = catalog(); c.manifest.packages.unshift({ ...c.manifest.packages[0], language: 'ja-JP', payloads: [fixturePayload('wrong-language.vsix')] }); assert.ok(tools.planMicrosoft(c.channel, c.manifest).vcPayloads.every(p => p.name !== 'wrong-language.vsix')); });
test('SDK dependency cycles do not hang package resolution', () => { const c = catalog(); c.manifest.packages.find(p => p.id === 'SDK.Redirect').dependencies = { 'SDK.Redirect': '1' }; assert.throws(() => tools.planMicrosoft(c.channel, c.manifest), /resolve the Windows SDK/); });
test('Resolves unique CAB names from verified catalog', () => { const c = catalog(); const p = tools.planMicrosoft(c.channel, c.manifest); const name = p.sdkCab[0].name; assert.deepEqual(tools.referencedCabs(Buffer.from(`abc${name}\0${name}`), p.sdkCab), p.sdkCab); });
test('Does not download a CAB that is not referenced by an MSI', () => { const c = catalog(); const p = tools.planMicrosoft(c.channel, c.manifest); assert.deepEqual(tools.referencedCabs(Buffer.from('empty fixture'), p.sdkCab), []); });
test('Rejects an MSI reference absent from the catalog', () => assert.throws(() => tools.referencedCabs(Buffer.from('b'.repeat(32) + '.cab'), []), /not in the verified/));
test('Accepts catalog CAB names stored as UTF-16', () => { const item = { name: 'sdk-data.cab', sha256: sha }; assert.deepEqual(tools.referencedCabs(Buffer.from(item.name, 'utf16le'), [item]), [item]); });
test('Detects the existing portable compiler layout', t => { const root = temp(t); const f = layoutFixture(root); const found = tools.inspectNative(f.vcRoot, f.sdk); assert.equal(found.vcVersion, '14.44.35207'); assert.equal(found.sdkVersion, '10.0.26100.0'); });
test('Discovers servicing versions instead of hard-coding the old patch directory', t => { const root = temp(t); const f = layoutFixture(root, '14.44.99999', '10.0.26100.123'); assert.equal(tools.inspectNative(f.vcRoot, f.sdk).vcVersion, '14.44.99999'); });
test('Selects latest complete compiler numerically, not lexically', t => { const root = temp(t); layoutFixture(root, '14.44.9999'); const f = layoutFixture(root, '14.44.10000'); assert.equal(tools.inspectNative(f.vcRoot, f.sdk).vcVersion, '14.44.10000'); });
test('Missing Windows SDK tools is not a successful compiler-only setup', t => { const root = temp(t); const f = layoutFixture(root); fs.unlinkSync(path.join(f.sdk, 'bin/10.0.26100.0/x64/rc.exe')); assert.equal(tools.inspectNative(f.vcRoot, f.sdk), null); });
test('Missing C++ runtime libraries invalidate a cached toolchain', t => { const root = temp(t); const f = layoutFixture(root); fs.unlinkSync(path.join(f.vcRoot, '14.44.35207/lib/x64/libcmt.lib')); assert.equal(tools.inspectNative(f.vcRoot, f.sdk), null); });
test('Rejects unsupported older installed compilers', t => { const root = temp(t); const f = layoutFixture(root, '14.30.10000'); assert.equal(tools.inspectNative(f.vcRoot, f.sdk), null); });
test('Environment includes SDK paths, resources, and the exact Rust linker', t => { const root = temp(t); const f = layoutFixture(root); const layout = tools.inspectNative(f.vcRoot, f.sdk); const env = tools.nativeEnvironment(layout); assert.match(env.variables.INCLUDE, /ucrt/); assert.match(env.variables.LIB, /um/); assert.equal(env.variables.CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER, path.join(layout.bin, 'link.exe')); assert.equal(env.variables.CARGO_HOME, undefined); });
test('Retains working user Rust homes when selecting only the compiler', () => { const env = tools.toolEnv({ Path: 'original', CARGO_HOME: 'user-cargo', RUSTUP_HOME: 'user-rust' }, { paths: ['compiler', 'compiler'], variables: { INCLUDE: 'headers' } }); assert.equal(env.CARGO_HOME, 'user-cargo'); assert.equal(env.RUSTUP_HOME, 'user-rust'); assert.equal(env.Path, undefined); assert.equal(env.PATH, 'compiler;original'); });
test('Incomplete extraction never replaces the old cache', t => { const root = temp(t); const old = path.join(root, 'msvc'), stage = path.join(root, '.new'); file(old, 'keep'); file(stage, 'partial'); assert.throws(() => tools.promoteDirectory(stage, old, () => false), /incomplete/); assert.ok(fs.existsSync(path.join(old, 'keep'))); });
test('Complete extraction replaces cache with a preserved recovery copy', t => { const root = temp(t); const old = path.join(root, 'msvc'), stage = path.join(root, '.new'); file(old, 'old'); file(stage, 'ready'); tools.promoteDirectory(stage, old, () => true); assert.ok(fs.existsSync(path.join(old, 'ready'))); assert.ok(fs.existsSync(path.join(old + '.previous', 'old'))); });
test('Does not overwrite an earlier recovery copy', t => { const root = temp(t); const old = path.join(root, 'msvc'), stage = path.join(root, '.new'); file(old, 'old'); file(old + '.previous', 'preserve'); file(stage, 'ready'); assert.throws(() => tools.promoteDirectory(stage, old, () => true), /backup already exists/); });
test('Detects all five missing source dependencies', t => { assert.deepEqual(tools.missingSources(temp(t)), ['ThirdParty/openvr', 'ThirdParty/minhook', 'ThirdParty/json', 'ThirdParty/easywsclient', 'ThirdParty/zlib']); });
test('Rust probe requires both compatible version and MSVC host', () => { const run = () => ({ status: 0, stdout: 'host: x86_64-pc-windows-msvc\nrelease: 1.90.0\n' }); assert.equal(tools.probeRust('unused', {}, run), '1.90.0'); assert.equal(tools.probeRust('unused', {}, () => ({ status: 0, stdout: 'host: x86_64-pc-windows-gnu\nrelease: 1.90.0\n' })), null); });
test('Broken rustup proxy and old compiler do not pass readiness', () => { assert.equal(tools.probeRust('unused', {}, () => ({ status: 1, stderr: 'missing toolchain' })), null); assert.equal(tools.probeRust('unused', {}, () => ({ status: 0, stdout: 'host: x86_64-pc-windows-msvc\nrelease: 1.77.2\n' })), null); });
test('Portable builder invokes bootstrap before any application compilation', () => { const s = fs.readFileSync(path.join(repo, 'tools/Build-Portable.ps1'), 'utf8'); assert.ok(s.indexOf('Enter-PortableBuildEnvironment.ps1') < s.indexOf('& cl.exe')); assert.match(s, /-PrepareDependencies/); assert.match(s, /\[switch\]\$SetupOnly/); });
test('Environment helper no longer assumes one specific MSVC patch directory', () => { const s = fs.readFileSync(path.join(repo, 'tools/Enter-PortableBuildEnvironment.ps1'), 'utf8'); assert.doesNotMatch(s, /14\.44\.35207/); assert.match(s, /Setup-PortableBuildTools/); assert.match(s, /EnvironmentVariableTarget\]::Process/); });
test('Bootstrap preserves lockfiles and does not run unpinned remote scripts', () => { const s = fs.readFileSync(path.join(repo, 'tools/lib/portable-toolchain.cjs'), 'utf8'); assert.match(s, /npm\.cmd ci --no-audit --no-fund/); assert.doesNotMatch(s, /npm\.cmd install|git[^\n]*--remote|Invoke-Expression/); assert.match(s, /--no-modify-path/); });
test('Non-Windows CLI fails clearly without network/setup side effects', { skip: process.platform === 'win32' }, () => { const r = spawnSync(process.execPath, [path.join(repo, 'tools/lib/portable-toolchain.cjs'), '--project', repo, '--powershell', 'unused'], { encoding: 'utf8' }); assert.notEqual(r.status, 0); assert.match(r.stderr, /64-bit Windows/); });

// Exercise the actual setup state machine with a fake Windows process boundary.
// Files/receipts are real temp files; HTTP, msiexec, rustup and cl are simulated.
// These are not evidence of a real Windows download/extraction or compilation.
function simulatedWindows(t, flags = {}) {
  const vm = require('node:vm');
  const root = temp(t), project = path.join(root, 'checkout');
  file(project, 'build.js'); file(project, 'GalaxyXRDriver/GalaxyXRDriver.vcxproj');
  file(project, 'GalaxyXRDriverGUI/package.json', '{"name":"fixture"}');
  file(project, 'GalaxyXRDriverGUI/package-lock.json', '{"packages":{"":{}}}');
  const files = new Map(), calls = [], c = catalog();
  const payloadPackage = c.manifest.packages.at(-1);
  const cabName = payloadPackage.payloads.at(-1).fileName.split('\\').at(-1);
  for (const p of c.manifest.packages) for (const item of p.payloads || []) {
    const content = Buffer.from(item.fileName.endsWith('.msi') ? 'msi-fixture\0' + cabName : 'package-fixture-' + item.fileName);
    item.sha256 = crypto.createHash('sha256').update(content).digest('hex');
    files.set(new URL(item.url).href, content);
  }
  const manifestBytes = Buffer.from(JSON.stringify(c.manifest));
  const mp = fixturePayload('catalog.json', { sha256: crypto.createHash('sha256').update(manifestBytes).digest('hex') });
  files.set(new URL(mp.url).href, manifestBytes);
  c.channel.channelItems.push({ id: 'Microsoft.VisualStudio.Manifests.VisualStudio', payloads: [mp] });
  files.set('https://aka.ms/vs/17/release/channel', Buffer.from(JSON.stringify(c.channel)));
  const rustBase = 'https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe';
  const rustBytes = Buffer.from('simulated rustup installer, not executable');
  files.set(rustBase, rustBytes);
  files.set(rustBase + '.sha256', Buffer.from(crypto.createHash('sha256').update(rustBytes).digest('hex')));
  let rustInstalled = false;
  function native(command, args, options) {
    calls.push({ command, args, env: options.env });
    const ok = { status: 0, stdout: '', stderr: '' };
    if (command === 'fixture-powershell') {
      const op = args[args.indexOf('-Operation') + 1];
      const source = args[args.indexOf('-Source') + 1], destination = args[args.indexOf('-Destination') + 1];
      if (op === 'Download') {
        const bytes = files.get(source); assert.ok(bytes, `Unknown fixture URL ${source}`);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, flags.badHash && source.endsWith('.vsix') ? 'corrupted' : bytes);
      } else if (op === 'ExtractZip') {
        layoutFixture(destination);
        // SDK is produced only by the MSI stage, not by VC payloads.
        fs.rmSync(path.join(destination, 'Windows Kits'), { recursive: true, force: true });
      } else assert.fail(`Unexpected operation ${op}`);
      return ok;
    }
    if (command.endsWith('msiexec.exe')) {
      if (flags.msiFailure) return { ...ok, status: 1603, stderr: 'simulated Windows Installer error' };
      const destination = args.find(a => a.startsWith('TARGETDIR=')).slice('TARGETDIR='.length);
      layoutFixture(destination); return ok;
    }
    if (command.endsWith('cl.exe')) return flags.probeFailure ? { ...ok, status: 1, stderr: 'simulated linker error' } : ok;
    if (command.endsWith('rustup-init.exe')) {
      file(options.env.CARGO_HOME, 'bin/rustc.exe'); file(options.env.CARGO_HOME, 'bin/cargo.exe');
      rustInstalled = true; return ok;
    }
    if (command.endsWith('rustc.exe')) return (rustInstalled || flags.userRust) ? { ...ok, stdout: 'host: x86_64-pc-windows-msvc\nrelease: 1.90.0\n' } : { ...ok, status: 1 };
    if (command.endsWith('cargo.exe')) return (rustInstalled || flags.userRust) ? { ...ok, stdout: 'cargo 1.90.0' } : { ...ok, status: 1 };
    if (command.endsWith('cmd.exe')) {
      if (flags.npmFailure) return { ...ok, status: 1, stderr: 'simulated npm ci failure' };
      for (const name of ['tauri.cmd', 'tsc.cmd', 'vite.cmd']) file(project, 'GalaxyXRDriverGUI/node_modules/.bin/' + name);
      return ok;
    }
    assert.fail(`Unexpected simulated process ${command}`);
  }
  const fakeProcess = { platform: 'win32', arch: 'x64', execPath: path.join(root, 'node/node.exe'), stdin: { isTTY: false }, stdout: {},
    env: { SystemRoot: path.join(root, 'Windows'), 'ProgramFiles(x86)': path.join(root, 'Program Files (x86)'),
      ComSpec: path.join(root, 'Windows/System32/cmd.exe'), Path: 'user-path', CARGO_HOME: 'user-cargo', RUSTUP_HOME: 'user-rust' } };
  const output = [], module = { exports: {} };
  const wrappedRequire = name => name === 'node:child_process' ? { spawnSync: native } : require(name);
  const sandbox = { require: wrappedRequire, module, exports: module.exports, process: fakeProcess, Buffer, URL,
    console: { log: line => output.push(line), error: line => output.push(line) } };
  vm.runInNewContext(fs.readFileSync(path.join(repo, 'tools/lib/portable-toolchain.cjs'), 'utf8'), sandbox, { filename: 'portable-toolchain-simulated.cjs' });
  const toolRoot = path.join(project, '../builds/GalaxyXR-Driver/build/toolchains');
  const options = { project, powershell: 'fixture-powershell', acceptLicense: true, driverOnly: true };
  return { project, toolRoot, calls, output, process: fakeProcess, setup: overrides => module.exports.setup({ ...options, ...overrides }) };
}
test('Simulated setup reuses a pre-provisioned portable MSVC/SDK layout', async t => {
  const s = simulatedWindows(t); layoutFixture(path.join(s.toolRoot, 'msvc'));
  const report = await s.setup();
  assert.equal(report.nativeSource, 'portable-cache'); assert.equal(report.msvc, '14.44.35207');
  assert.ok(fs.existsSync(path.join(s.toolRoot, 'environment.json')));
  assert.equal(s.calls.filter(c => c.command === 'fixture-powershell').length, 0);
});
test('Simulated repeat run reuses complete tools with no downloads', async t => {
  const s = simulatedWindows(t); layoutFixture(path.join(s.toolRoot, 'msvc')); await s.setup(); s.calls.length = 0;
  const report = await s.setup({ noDownload: true }); assert.equal(report.nativeSource, 'portable-cache');
  assert.equal(s.calls.filter(c => c.command === 'fixture-powershell').length, 0);
});
test('Simulated offline missing-tool run fails before any network boundary', async t => {
  const s = simulatedWindows(t); await assert.rejects(s.setup({ noDownload: true }), /missing or incomplete/);
  assert.equal(s.calls.length, 0); assert.equal(fs.existsSync(path.join(s.toolRoot, 'environment.json')), false);
});
test('Simulated online missing-tool run downloads and verifies the portable toolchain', async t => {
  const s = simulatedWindows(t); const report = await s.setup();
  assert.equal(report.nativeSource, 'downloaded-portable-tools');
  assert.ok(s.calls.some(c => c.args.includes('Download')));
  assert.ok(fs.existsSync(path.join(s.toolRoot, 'environment.json')));
});
test('Corrupted compiler payload fails verification before any extraction', async t => {
  const s = simulatedWindows(t, { badHash: true }); await assert.rejects(s.setup(), /failed (SHA-256 )?verification/);
  assert.equal(s.calls.filter(c => c.args.includes('ExtractZip')).length, 0);
  assert.equal(fs.existsSync(path.join(s.toolRoot, 'environment.json')), false);
});
test('Simulated compiler probe failure rejects an already prepared tool cache', async t => {
  const s = simulatedWindows(t, { probeFailure: true }); layoutFixture(path.join(s.toolRoot, 'msvc'));
  await assert.rejects(s.setup(), /cl.exe failed/);
  assert.equal(fs.existsSync(path.join(s.toolRoot, 'environment.json')), false);
});
test('Simulated full GUI preparation installs isolated Rust and exact npm dependencies', async t => {
  const s = simulatedWindows(t); layoutFixture(path.join(s.toolRoot, 'msvc'));
  const report = await s.setup({ driverOnly: false, guiOnly: true, prepareDependencies: true });
  const rustup = s.calls.find(c => c.command.endsWith('rustup-init.exe'));
  assert.ok(rustup.args.includes('--no-modify-path')); assert.equal(rustup.env.CARGO_HOME, path.join(s.toolRoot, 'cargo'));
  assert.equal(s.process.env.CARGO_HOME, 'user-cargo'); assert.equal(s.process.env.RUSTUP_HOME, 'user-rust');
  const npm = s.calls.find(c => c.command.endsWith('cmd.exe')); assert.match(npm.args.at(-1), /^npm.cmd ci /);
  assert.equal(report.rustSource, 'portable-rust'); assert.equal(report.rust, '1.90.0');
  assert.ok(fs.existsSync(path.join(s.project, 'GalaxyXRDriverGUI/node_modules/.galaxyxrdriver-lock.sha256')));
  s.calls.length = 0;
  await s.setup({ driverOnly: false, guiOnly: true, prepareDependencies: true, noDownload: true });
  assert.equal(s.calls.filter(c => c.command === 'fixture-powershell' || c.command.endsWith('cmd.exe')).length, 0);
});
test('Simulated existing Rust is reused without overwriting its configured homes', async t => {
  const s = simulatedWindows(t, { userRust: true }); layoutFixture(path.join(s.toolRoot, 'msvc'));
  const report = await s.setup({ driverOnly: false });
  assert.equal(report.rustSource, 'existing-rust'); assert.equal(report.variables.CARGO_HOME, undefined);
  assert.equal(s.calls.filter(c => c.command === 'fixture-powershell').length, 0);
});
test('Simulated npm failure cannot create a success stamp or environment receipt', async t => {
  const s = simulatedWindows(t, { userRust: true, npmFailure: true }); layoutFixture(path.join(s.toolRoot, 'msvc'));
  await assert.rejects(s.setup({ driverOnly: false, guiOnly: true, prepareDependencies: true }), /cmd.exe failed/);
  assert.equal(fs.existsSync(path.join(s.toolRoot, 'environment.json')), false);
  assert.equal(fs.existsSync(path.join(s.project, 'GalaxyXRDriverGUI/node_modules/.galaxyxrdriver-lock.sha256')), false);
});

// The following are actual Windows PowerShell / PowerShell 7 tests, not a parser
// emulation. Missing hosts are skips locally and failures in the build-tool workflow.
const knownHosts = process.platform === 'win32' ? ['powershell.exe', 'pwsh.exe'] : ['powershell', 'pwsh'];
for (const host of knownHosts) {
  const probe = spawnSync(host, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8' });
  const available = !probe.error && probe.status === 0 && process.platform === 'win32';
  if (!available && process.env.REQUIRE_PORTABLE_POWERSHELL_TESTS === '1') test(`Required Windows PowerShell host exists: ${host}`, () => assert.fail(`${host} is unavailable`));
  const skip = available ? false : `${host} is not available on this host`;
  function runPs(script, args = []) { return spawnSync(host, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], { encoding: 'utf8', timeout: 60000 }); }
  test(`${host}: actual parser accepts all portable-build PowerShell scripts`, { skip }, t => {
    const dir = temp(t), script = file(dir, 'parse.ps1', `param([string]$Root)\n$ErrorActionPreference='Stop'\nforeach($name in @('Build-Portable.ps1','Enter-PortableBuildEnvironment.ps1','Setup-PortableBuildTools.ps1','PortableToolchainIO.ps1')) {\n $tokens=$null;$errors=$null\n [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $Root ('tools/'+$name)),[ref]$tokens,[ref]$errors)|Out-Null\n if($errors.Count){throw ($errors|Out-String)}\n}\n`);
    const r = runPs(script, [repo]); assert.equal(r.status, 0, r.stdout + r.stderr);
  });
  test(`${host}: downloader reuses a checksum-verified cache without network`, { skip }, t => {
    const dir = temp(t), cached = file(dir, 'cached.bin', 'unchanged fixture');
    const digest = crypto.createHash('sha256').update('unchanged fixture').digest('hex');
    const r = runPs(path.join(repo, 'tools/PortableToolchainIO.ps1'), ['-Operation', 'Download', '-Source', 'https://nodejs.org/dist/does-not-exist.fixture', '-Destination', cached, '-Sha256', digest, '-CacheOnly']);
    assert.ifError(r.error); assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(fs.readFileSync(cached, 'utf8'), 'unchanged fixture');
    assert.deepEqual(fs.readdirSync(dir), ['cached.bin'], 'Cache reuse must not create download reports or partial files.');
  });
  test(`${host}: literal-path file identity agrees with Node for arbitrary binary bytes`, { skip }, t => {
    const dir = temp(t);
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('line 1\r\nline 2\n'), Buffer.from(Array.from({ length: 256 }, (_, i) => i))]);
    const payload = file(dir, 'literal [binary] file.bin', bytes);
    const script = file(dir, 'identity.ps1', `param([string]$Root,[string]$File)\n$ErrorActionPreference='Stop'\n. (Join-Path $Root 'tools/PortableToolchainIO.ps1')\nGet-ToolFileIdentity -Path $File | ConvertTo-Json -Compress\n`);
    const r = runPs(script, [repo, payload]);
    assert.ifError(r.error); assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
  });
  test(`${host}: offline cache accepts a correct hash despite stale size metadata`, { skip }, t => {
    const dir = temp(t), cached = file(dir, 'cached.bin', 'unchanged fixture');
    const digest = crypto.createHash('sha256').update('unchanged fixture').digest('hex').toUpperCase();
    const r = runPs(path.join(repo, 'tools/PortableToolchainIO.ps1'), ['-Operation', 'Download', '-Source', 'https://nodejs.org/dist/does-not-exist.fixture', '-Destination', cached, '-Sha256', digest, '-ExpectedSize', '999', '-CacheOnly']);
    assert.ifError(r.error); assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /advisory/);
    assert.deepEqual(fs.readdirSync(dir), ['cached.bin']);
  });
  for (const contents of [null, '', 'corrupt fixture']) {
    test(`${host}: offline ${contents === null ? 'missing' : contents === '' ? 'empty' : 'corrupt'} cache fails without network or filesystem changes`, { skip }, t => {
      const dir = temp(t), cached = path.join(dir, 'cache', 'cached.bin');
      if (contents !== null) file(dir, 'cache/cached.bin', contents);
      const digest = crypto.createHash('sha256').update('expected fixture').digest('hex');
      const r = runPs(path.join(repo, 'tools/PortableToolchainIO.ps1'), ['-Operation', 'Download', '-Source', 'https://nodejs.org/dist/does-not-exist.fixture', '-Destination', cached, '-Sha256', digest, '-CacheOnly']);
      assert.ifError(r.error); assert.notEqual(r.status, 0);
      assert.match(r.stderr, /Offline cache unavailable/);
      assert.doesNotMatch(r.stdout + r.stderr, /Download attempt|Download failed after|404/);
      if (contents === null) assert.deepEqual(fs.readdirSync(dir), []);
      else {
        assert.equal(fs.readFileSync(cached, 'utf8'), contents);
        assert.deepEqual(fs.readdirSync(path.dirname(cached)), ['cached.bin']);
        assert.match(r.stderr, /Expected SHA-256:[\s\S]*Actual SHA-256:/);
      }
    });
  }
  test(`${host}: downloader rejects a non-official URL before writing`, { skip }, t => {
    const dir = temp(t), destination = path.join(dir, 'never-created');
    const r = runPs(path.join(repo, 'tools/PortableToolchainIO.ps1'), ['-Operation', 'Download', '-Source', 'https://untrusted.invalid/installer', '-Destination', destination]);
    assert.notEqual(r.status, 0); assert.match(r.stderr, /Refusing/); assert.equal(fs.existsSync(destination), false);
  });
  test(`${host}: rejects invalid digest before making a network request`, { skip }, t => {
    const dir = temp(t), destination = path.join(dir, 'never-created');
    const r = runPs(path.join(repo, 'tools/PortableToolchainIO.ps1'), ['-Operation', 'Download', '-Source', 'https://nodejs.org/dist/no-fixture', '-Destination', destination, '-Sha256', 'bad']);
    assert.notEqual(r.status, 0); assert.match(r.stderr, /SHA-256/); assert.equal(fs.existsSync(destination), false);
  });
  // 2026-09-21: create the fixture archive in Node. Some Windows PowerShell 5.1
  // hosts only expose the .NET 4.0 System.IO.Compression.FileSystem shim (ZipFile
  // without ZipArchive), so a host-side stored-zip writer keeps this test stable.
  function createStoredZip(target, entryName, text) {
    const zlib = require('node:zlib');
    const data = Buffer.from(text, 'utf8'), name = Buffer.from(entryName, 'utf8');
    const crc = zlib.crc32(data) >>> 0, dosTime = 0x6000, dosDate = 0x5a21;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(dosTime, 12); central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(46 + name.length, 12); eocd.writeUInt32LE(30 + name.length + data.length, 16);
    fs.writeFileSync(target, Buffer.concat([local, name, data, central, name, eocd]));
  }
  for (const unsafe of [false, true]) test(`${host}: ZIP extraction ${unsafe ? 'blocks path traversal' : 'strips Contents prefix into a spaced path'}`, { skip }, t => {
    const dir = temp(t), destination = path.join(dir, 'extract here [fixture]'), archive = path.join(dir, 'fixture.vsix');
    createStoredZip(archive, unsafe ? 'Contents/../../escaped.txt' : 'Contents/nested/file.txt', 'fixture bytes');
    const r = runPs(path.join(repo, 'tools/PortableToolchainIO.ps1'), ['-Operation', 'ExtractZip', '-Source', archive, '-Destination', destination, '-Prefix', 'Contents/']);
    if (unsafe) { assert.notEqual(r.status, 0); assert.match(r.stderr, /Unsafe|escapes/); assert.equal(fs.existsSync(path.join(dir, 'escaped.txt')), false); }
    else { assert.equal(r.status, 0, r.stdout + r.stderr); assert.equal(fs.readFileSync(path.join(destination, 'nested/file.txt'), 'utf8'), 'fixture bytes'); }
  });
}
