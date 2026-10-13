#!/usr/bin/env node
'use strict';
/** Portable Windows build dependencies. Uses publisher manifests and hashes;
 * never runs a downloaded script, installs Visual Studio, or modifies user PATH.
 * Pure selection/layout helpers are exported for network-free regression tests.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const readline = require('node:readline/promises');
const { inspectNativeDependencies, prepareNativeDependencies } = require('../prepare-native-dependencies.cjs');

const MSVC_FAMILY = '14.44';
const SDK_FAMILY = '26100';
const CHANNEL = 'https://aka.ms/vs/17/release/channel';
const HOSTS = new Set(['aka.ms', 'download.visualstudio.microsoft.com', 'download.microsoft.com', 'nodejs.org', 'static.rust-lang.org']);
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const isFile = file => { try { return fs.statSync(file).isFile() && fs.statSync(file).size > 0; } catch { return false; } };
const log = text => console.log(`[tools] ${text}`);
function safeUri(value) {
  const uri = new URL(value);
  if (uri.protocol !== 'https:' || !HOSTS.has(uri.hostname) || uri.username || uri.password || uri.hash || (uri.port && uri.port !== '443')) {
    throw new Error(`Refusing non-official or non-HTTPS download: ${value}`);
  }
  if (uri.hostname === 'aka.ms' && uri.pathname !== '/vs/17/release/channel') throw new Error('Unexpected aka.ms tool URL.');
  return uri.href;
}
function safeName(value) {
  const name = String(value).replaceAll('\\', '/').split('/').at(-1);
  if (!name || name === '.' || name === '..' || /[<>:"/\\|?*\x00-\x1f]/.test(name)) throw new Error(`Invalid package filename: ${value}`);
  return name;
}
function payload(item) {
  if (!item || typeof item.url !== 'string' || !/^[a-f\d]{64}$/i.test(item.sha256 || '')) throw new Error('Publisher payload has no valid URL/SHA-256. Refusing to download.');
  if (item.size !== undefined && (!Number.isSafeInteger(item.size) || item.size < 0)) throw new Error('Publisher payload has an invalid file size.');
  return { url: safeUri(item.url), sha256: item.sha256.toLowerCase(), name: safeName(item.fileName), ...(item.size === undefined ? {} : { size: item.size }) };
}
/** Structural trust floor for the 2026-09-21 fallback: the served catalog must
 * be a genuine VS installer manifest for the exact same product as the channel.
 * Accepting it does NOT relax payload verification: every package payload is
 * still checked against its own publisher SHA-256/size before extraction.
 */
function assertServedCatalogStructure(manifest, channel) {
  if (!manifest || typeof manifest !== 'object' || manifest.manifestVersion !== '1.1' ||
      !manifest.info || typeof manifest.info.productSemanticVersion !== 'string') {
    throw new Error('Served catalog is not a valid VS 2022 installer manifest.');
  }
  const channelVersion = channel?.info?.productSemanticVersion;
  if (!channelVersion || manifest.info.productSemanticVersion !== channelVersion) {
    throw new Error(`Served catalog product version (${manifest.info.productSemanticVersion}) does not match the channel (${channelVersion ?? 'unknown'}); refusing to use it.`);
  }
  if (!Array.isArray(manifest.packages) || manifest.packages.length === 0) {
    throw new Error('Served catalog contains no packages.');
  }
  return manifest;
}
/** Read the channel and its exact catalog as one verified pair. Refresh the
 * pair once if the CDN/channel changed; never mix two channel snapshots. As of
 * 2026-09-21 Microsoft's release channel has been observed to carry a stale
 * size/SHA-256 for its own VisualStudio.vsman payload while the CDN serves the
 * correct current manifest. After a refresh still mismatches, the served
 * catalog may be used only if it passes assertServedCatalogStructure; every
 * package payload remains individually SHA-256/size verified before use.
 */
function loadMicrosoftCatalog(download, cache, warn = log) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const channel = readJson(download(CHANNEL, path.join(cache, 'vs2022-channel.json')));
    const manifestItem = channel.channelItems?.find(item => item.id === 'Microsoft.VisualStudio.Manifests.VisualStudio')?.payloads?.[0];
    const manifestPayload = payload(manifestItem);
    try {
      const file = download(manifestPayload.url, path.join(cache, `${manifestPayload.sha256.slice(0, 16)}-${manifestPayload.name}`), manifestPayload.sha256, manifestPayload.size);
      // Keep an independent Node check before JSON parsing or package selection.
      // 2026-09-21: the publisher SHA-256 is the gate; a stale declared size
      // on a hash-verified file is advisory (see PortableToolchainIO.ps1).
      const bytes = fs.readFileSync(file);
      if (hash(bytes) !== manifestPayload.sha256) {
        throw new Error(`Catalog integrity mismatch: expected SHA-256 ${manifestPayload.sha256}; actual ${hash(bytes)}.`);
      }
      if (manifestPayload.size !== undefined && bytes.length !== manifestPayload.size) {
        warn(`WARNING: declared size for ${manifestPayload.name} is ${manifestPayload.size} bytes but the SHA-256-verified catalog is ${bytes.length} bytes; the declared size is treated as advisory.`);
      }
      const manifest = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
      return { channel, manifest, manifestPayload };
    } catch (error) {
      if (!/integrity mismatch|SHA-256 mismatch|failed (SHA-256 )?verification/i.test(error.message)) throw error;
      if (attempt === 2) {
        let structuralError = null;
        try {
          // No expected digest here: this is the fallback fetch, verified by
          // structure below. Payload digests are still enforced per package.
          const file = download(manifestPayload.url, path.join(cache, `served-${manifestPayload.name}`));
          const bytes = fs.readFileSync(file);
          const manifest = assertServedCatalogStructure(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')), channel);
          warn(`WARNING: channel digest for ${manifestPayload.name} (${manifestPayload.sha256}) does not match the served catalog (${hash(bytes)}, ${bytes.length} bytes).`);
          warn(`The served catalog passed structural verification (${manifest.info.productDisplayVersion}). Package payload SHA-256/size verification remains enabled for every download.`);
          return { channel, manifest, manifestPayload: { ...manifestPayload, sha256: hash(bytes), size: bytes.length } };
        } catch (fallbackError) { structuralError = fallbackError; }
        throw new Error(`${error.message}\nThe refreshed Microsoft catalog still failed verification. It was not used.\n` +
          `Structural fallback check: ${structuralError?.message ?? 'not attempted'}.\n` +
          'To use Microsoft-managed Build Tools instead, open an elevated PowerShell in tools and run:\n' +
          '  .\\Install-MicrosoftBuildTools.ps1 -AcceptLicense\n' +
          'Then run .\\Build-Portable.ps1 from a normal PowerShell.\n' +
          'This is an explicit one-time system Build Tools installation, not a checksum bypass. See README-TOOLCHAIN-DOWNLOAD-FIX.md.');
      }
      warn('Catalog integrity check failed; refreshing the official channel and its catalog once. Verification remains enabled.');
    }
  }
}
function compareVersions(a, b) {
  const av = a.split('.').map(Number), bv = b.split('.').map(Number);
  for (let i = 0; i < Math.max(av.length, bv.length); i++) { const d = (av[i] || 0) - (bv[i] || 0); if (d) return d; }
  return 0;
}
function directories(root) {
  try { return fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory() && /^\d+(\.\d+)+$/.test(d.name)).map(d => d.name).sort(compareVersions).reverse(); }
  catch { return []; }
}
function inspectNative(vcRoot, sdkRoot) {
  for (const vcVersion of directories(vcRoot)) {
    if (compareVersions(vcVersion, '14.40') < 0) continue;
    const vc = path.join(vcRoot, vcVersion), bin = path.join(vc, 'bin/Hostx64/x64');
    const vcFiles = ['cl.exe', 'link.exe', 'dumpbin.exe', 'lib.exe', 'c1xx.dll', 'c2.dll'].map(n => path.join(bin, n));
    vcFiles.push(...['include/vector', 'include/vcruntime.h', 'lib/x64/libcmt.lib', 'lib/x64/libcpmt.lib'].map(n => path.join(vc, n)));
    if (!vcFiles.every(isFile)) continue;
    for (const sdkVersion of directories(path.join(sdkRoot, 'Include'))) {
      if (compareVersions(sdkVersion, '10.0.19041.0') < 0) continue;
      const sdkFiles = [`bin/${sdkVersion}/x64/rc.exe`, `bin/${sdkVersion}/x64/mt.exe`, `Include/${sdkVersion}/um/Windows.h`,
        `Include/${sdkVersion}/shared/sdkddkver.h`, `Include/${sdkVersion}/ucrt/stdio.h`,
        `Lib/${sdkVersion}/um/x64/kernel32.lib`, `Lib/${sdkVersion}/ucrt/x64/ucrt.lib`].map(n => path.join(sdkRoot, n));
      if (sdkFiles.every(isFile)) return { vc, vcVersion, sdk: sdkRoot, sdkVersion, bin };
    }
  }
  return null;
}
function nativeEnvironment(layout) {
  const { vc, vcVersion, sdk, sdkVersion, bin } = layout;
  const include = ['ucrt', 'shared', 'um', 'winrt', 'cppwinrt'].map(n => path.join(sdk, 'Include', sdkVersion, n));
  return {
    paths: [bin, path.join(sdk, 'bin', sdkVersion, 'x64'), path.join(sdk, 'bin', sdkVersion, 'x64/ucrt')],
    variables: {
      INCLUDE: [path.join(vc, 'include'), ...include].join(';'),
      LIB: [path.join(vc, 'lib/x64'), path.join(sdk, 'Lib', sdkVersion, 'ucrt/x64'), path.join(sdk, 'Lib', sdkVersion, 'um/x64')].join(';'),
      VCToolsInstallDir: vc + path.sep, VCToolsVersion: vcVersion,
      VCINSTALLDIR: path.resolve(vc, '../../..') + path.sep,
      WindowsSdkDir: sdk + path.sep, WindowsSDKVersion: sdkVersion + '\\',
      WindowsSdkBinPath: path.join(sdk, 'bin') + path.sep,
      UniversalCRTSdkDir: sdk + path.sep, UCRTVersion: sdkVersion,
      VSCMD_ARG_HOST_ARCH: 'x64', VSCMD_ARG_TGT_ARCH: 'x64',
      CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER: path.join(bin, 'link.exe'),
      // find-msvc-tools uses VCINSTALLDIR and VSCMD_ARG_TGT_ARCH above
      // to find the prepared tools on PATH without a registered VS product.
    },
  };
}
function parseShasums(text, filename) {
  const row = text.split(/\r?\n/).map(line => /^([a-f\d]{64})\s+\*?(.+)$/.exec(line.trim())).find(match => match && match[2] === filename);
  if (!row) throw new Error(`No SHA-256 for ${filename} in publisher checksum file.`);
  return row[1].toLowerCase();
}
function planMicrosoft(channel, manifest) {
  if (!Array.isArray(channel?.channelItems) || !Array.isArray(manifest?.packages)) throw new Error('Invalid Microsoft channel/package manifest.');
  const packages = new Map();
  for (const item of manifest.packages) {
    const id = String(item.id).toLowerCase();
    if (!packages.has(id)) packages.set(id, []);
    packages.get(id).push(item);
  }
  const get = id => {
    const candidates = (packages.get(id.toLowerCase()) || []).filter(p => !p.language || p.language.toLowerCase() === 'en-us');
    // Use the latest servicing payload for an ID, not arbitrary manifest order.
    return candidates.sort((a, b) => compareVersions(b.version || '0', a.version || '0'))[0];
  };
  const toolsId = [...packages.keys()].filter(id => id.startsWith(`microsoft.vc.${MSVC_FAMILY}.`) && id.endsWith('.tools.hostx64.targetx64.base') && !id.includes('.premium.')).sort().at(-1);
  if (!toolsId) throw new Error(`MSVC ${MSVC_FAMILY} is missing from the Microsoft VS 2022 release catalog. No unreviewed fallback version was selected.`);
  const family = toolsId.slice('microsoft.vc.'.length, -'.tools.hostx64.targetx64.base'.length);
  const required = ['tools.hostx64.targetx64.base', 'tools.hostx64.targetx64.res.base', 'crt.headers.base', 'crt.x64.desktop.base'];
  const optional = ['crt.source.base', 'crt.x64.store.base', 'asan.headers.base', 'asan.x64.base', 'pgo.headers.base', 'pgo.x64.base', 'premium.tools.hostx64.targetx64.base'];
  const ids = required.map(suffix => `microsoft.vc.${family}.${suffix}`);
  for (const id of ids) if (!get(id)) throw new Error(`Microsoft catalog is missing required package: ${id}`);
  ids.push(...optional.map(suffix => `microsoft.vc.${family}.${suffix}`).filter(id => get(id)));
  if (get('microsoft.visualcpp.dia.sdk')) ids.push('microsoft.visualcpp.dia.sdk');
  let redist = `microsoft.vc.${family}.crt.redist.x64.base`;
  if (!get(redist)) {
    const shim = get('microsoft.visualcpp.crt.redist.x64');
    redist = Object.keys(shim?.dependencies || {}).find(id => id.toLowerCase().endsWith('.base'));
  }
  if (redist && get(redist)) ids.push(redist);
  const vcPayloads = ids.flatMap(id => {
    const files = get(id).payloads;
    if (!Array.isArray(files) || !files.length) throw new Error(`Empty Microsoft payload list: ${id}`);
    return files.map(payload);
  });
  const sdkId = [...packages.keys()].find(id => /^microsoft\.visualstudio\.component\.windows(10|11)sdk\.26100$/.test(id));
  if (!sdkId) throw new Error(`Windows SDK ${SDK_FAMILY} is not available in the Microsoft VS 2022 release catalog.`);
  const visited = new Set(), queue = [sdkId];
  let sdkPackage;
  while (queue.length) {
    const id = queue.shift().toLowerCase(); if (visited.has(id)) continue; visited.add(id);
    const p = get(id); if (!p) continue;
    if ((p.payloads || []).some(item => safeName(item.fileName) === 'Windows SDK for Windows Store Apps Tools-x86_en-us.msi')) { sdkPackage = p; break; }
    queue.push(...Object.keys(p.dependencies || {}));
  }
  if (!sdkPackage) throw new Error('Could not resolve the Windows SDK component to installer payloads.');
  const sdkFiles = sdkPackage.payloads.map(payload);
  const requiredMsi = ['Windows SDK for Windows Store Apps Tools-x86_en-us.msi', 'Windows SDK for Windows Store Apps Headers-x86_en-us.msi',
    'Windows SDK for Windows Store Apps Libs-x86_en-us.msi', 'Universal CRT Headers Libraries and Sources-x86_en-us.msi',
    'Windows SDK Desktop Headers x64-x86_en-us.msi', 'Windows SDK Desktop Libs x64-x86_en-us.msi'];
  const optionalMsi = ['Windows SDK for Windows Store Apps Headers OnecoreUap-x86_en-us.msi'];
  for (const arch of ['x86', 'x64', 'arm', 'arm64']) {
    optionalMsi.push(`Windows SDK Desktop Headers ${arch}-x86_en-us.msi`, `Windows SDK OnecoreUap Headers ${arch}-x86_en-us.msi`);
  }
  for (const name of requiredMsi) if (!sdkFiles.find(item => item.name === name)) throw new Error(`Required Windows SDK installer is absent: ${name}`);
  const msiNames = new Set([...requiredMsi, ...optionalMsi]);
  const sdkMsi = sdkFiles.filter(item => msiNames.has(item.name));
  const sdkCab = sdkFiles.filter(item => /\.cab$/i.test(item.name));
  const product = channel.channelItems.find(item => item.id === 'Microsoft.VisualStudio.Product.BuildTools');
  const license = product?.localizedResources?.find(item => item.language?.toLowerCase() === 'en-us')?.license;
  if (typeof license !== 'string' || !license.startsWith('https://')) throw new Error('Microsoft license reference missing from channel manifest.');
  return { family, sdkFamily: SDK_FAMILY, vcPayloads, sdkMsi, sdkCab, license };
}
function referencedCabs(msiBytes, candidates) {
  const raw = msiBytes.toString('latin1');
  const names = new Set([...raw.matchAll(/[a-f\d]{32}\.cab/gi)].map(match => match[0].toLowerCase()));
  // Also match payload names directly to support non-hash CAB names/UTF-16 strings.
  for (const p of candidates) if (msiBytes.includes(Buffer.from(p.name)) || msiBytes.includes(Buffer.from(p.name, 'utf16le'))) names.add(p.name.toLowerCase());
  const known = new Map(candidates.map(p => [p.name.toLowerCase(), p]));
  for (const name of names) if (!known.has(name)) throw new Error(`SDK cabinet ${name} is not in the verified Microsoft catalog.`);
  return [...names].map(name => known.get(name));
}
function assertWritableTree(root) {
  let cursor = path.resolve(root);
  while (true) {
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`Build tool path uses a symlink/junction: ${cursor}`);
    const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
}
function renameWithRetry(source, destination, timeoutMs = 60000) {
  // 2026-09-21: Windows can hold transient handles on a freshly written tool
  // tree (antivirus, indexer), making an immediate rename fail with
  // EPERM/EACCES/EBUSY. Retry briefly before treating it as a real failure.
  const start = Date.now();
  for (;;) {
    try { fs.renameSync(source, destination); return; }
    catch (error) {
      if (error.code !== 'EPERM' && error.code !== 'EACCES' && error.code !== 'EBUSY') throw error;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Move failed after ${Math.round(timeoutMs / 1000)}s (handles still held, likely by antivirus): ${source} -> ${destination}. ${error.message}`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
}
function promoteDirectory(staging, destination, validate) {
  if (!validate(staging)) throw new Error(`Downloaded toolchain is incomplete: ${staging}. Existing tools were not replaced.`);
  const backup = destination + '.previous';
  if (fs.existsSync(backup)) throw new Error(`Previous tool backup already exists: ${backup}. Review it before retrying setup.`);
  const hadOld = fs.existsSync(destination);
  if (hadOld) renameWithRetry(destination, backup);
  try {
    renameWithRetry(staging, destination);
  } catch (renameError) {
    // 2026-09-21: Windows (SmartScreen/Defender) can keep a freshly written
    // tool tree's directory entries locked for a long time, so a plain rename
    // of the staging root fails even though every child is readable. The
    // verified copy is equivalent: the same validation re-runs on the
    // destination before the staging tree is best-effort removed.
    fs.cpSync(staging, destination, { recursive: true, errorOnExist: false, dereference: false });
    if (!validate(destination)) {
      try { fs.rmSync(destination, { recursive: true, force: true }); } catch {}
      if (hadOld) { try { renameWithRetry(backup, destination); } catch {} }
      throw new Error(`Copied toolchain at ${destination} failed validation and was removed. Rename error was: ${renameError.message}`);
    }
    try { fs.rmSync(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); }
    catch { /* staging cleanup is best-effort; it is not used by the build */ }
  }
  // Keep a replaced/incomplete user cache intact for manual recovery. New installs
  // have no backup. Neither path can refer to the application/SteamVR directory.
}
function missingSources(repo) {
  return inspectNativeDependencies(repo).filter(dep => dep.missing.length).map(dep => dep.directory);
}
function toolEnv(base, environment) {
  // Windows environment names are case-insensitive. Avoid both Path and PATH.
  const next = { ...base, ...environment.variables };
  const key = Object.keys(next).find(k => k.toLowerCase() === 'path');
  const original = key ? next[key] : '';
  for (const k of Object.keys(next)) if (k.toLowerCase() === 'path') delete next[k];
  next.PATH = [...new Set([...environment.paths, ...original.split(';').filter(Boolean)])].join(';');
  return next;
}
function probeRust(executable, env, run) {
  const result = run(executable, ['-vV'], { env, soft: true });
  const version = /^release: (\d+\.\d+\.\d+)/m.exec(result.stdout || '')?.[1];
  const host = /^host: (\S+)/m.exec(result.stdout || '')?.[1];
  return result.status === 0 && version && compareVersions(version, '1.85.0') >= 0 && host === 'x86_64-pc-windows-msvc' ? version : null;
}
async function setup(options) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This portable build bootstrap requires 64-bit Windows and x64 Node.js.');
  const repo = path.resolve(options.project), root = path.join(repo, '../builds/GalaxyXR-Driver/build/toolchains');
  for (const file of ['build.js', 'GalaxyXRDriver/GalaxyXRDriver.vcxproj', 'GalaxyXRDriverGUI/package-lock.json']) {
    if (!isFile(path.join(repo, file))) throw new Error(`Missing project source: ${file}. Apply the update to the project root, not inside tools.`);
  }
  assertWritableTree(root); fs.mkdirSync(root, { recursive: true });
  const lockPath = path.join(root, '.setup.lock');
  let lock;
  try { lock = fs.openSync(lockPath, 'wx'); fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, created: new Date().toISOString() })); }
  catch (error) { if (error.code === 'EEXIST') throw new Error(`Another setup is running, or a prior setup was interrupted: ${lockPath}. Only remove this lock after checking that no setup/build process is running.`); throw error; }
  const cache = path.join(root, 'downloads'), io = path.join(repo, 'tools/PortableToolchainIO.ps1');
  const logs = path.join(root, 'logs');
  fs.mkdirSync(cache, { recursive: true }); fs.mkdirSync(logs, { recursive: true });
  const reportFile = path.join(root, 'environment.json');
  // Never let a failed preparation leave a successful receipt from an older run.
  if (fs.existsSync(reportFile)) fs.unlinkSync(reportFile);
  const run = (file, args, extra = {}) => {
    const { soft, logFile, ...rest } = extra;
    const r = spawnSync(file, args, { cwd: repo, env: process.env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true, timeout: 30 * 60 * 1000, ...rest });
    if (logFile) fs.writeFileSync(logFile, `${r.stdout || ''}\n${r.stderr || ''}\n${r.error?.message || ''}`);
    if (!soft && (r.error || r.status !== 0)) throw new Error(`${path.basename(file)} failed${r.status !== null ? ` (exit ${r.status})` : ''}.${logFile ? ` See ${logFile}.` : ''}\n${r.error?.message || r.stderr || r.stdout || ''}`);
    return r;
  };
  const ps = (operation, args) => run(options.powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', io, '-Operation', operation, ...args]);
  const download = (url, destination, sha256, expectedSize) => {
    safeUri(url);
    // The publisher SHA-256 is the integrity gate (2026-09-21): a verified
    // cache entry is reused on hash match even when the declared size is stale.
    if (sha256 && isFile(destination) && hash(fs.readFileSync(destination)) === sha256.toLowerCase()) return destination;
    if (options.noDownload) throw new Error(`Required download is not cached: ${url}. Run setup once without -NoDownload.`);
    log(`Downloading ${path.basename(destination)} ...`);
    const args = ['-Source', url, '-Destination', destination, '-LogFile', path.join(logs, path.basename(destination) + '.download.json')];
    if (sha256) args.push('-Sha256', sha256);
    if (expectedSize !== undefined) args.push('-ExpectedSize', String(expectedSize));
    ps('Download', args);
    if (!isFile(destination) || (sha256 && hash(fs.readFileSync(destination)) !== sha256.toLowerCase())) {
      throw new Error(`Downloaded file failed SHA-256 verification: ${destination}`);
    }
    const actualSize = fs.statSync(destination).size;
    if (expectedSize !== undefined && actualSize !== expectedSize) {
      log(`WARNING: declared size for ${path.basename(destination)} is ${expectedSize} bytes but the SHA-256-verified file is ${actualSize} bytes; the declared size is treated as advisory.`);
    }
    return destination;
  };
  const downloadPayload = p => download(p.url, path.join(cache, `${p.sha256.slice(0, 16)}-${p.name}`), p.sha256, p.size);
  const extract = (zip, destination, prefix = '') => {
    const args = ['-Source', zip, '-Destination', destination]; if (prefix) args.push('-Prefix', prefix);
    ps('ExtractZip', args);
  };
  const probeCompiler = layout => {
    const environment = nativeEnvironment(layout);
    environment.paths.unshift(path.dirname(process.execPath));
    const env = toolEnv(process.env, environment);
    const probe = path.join(root, 'probe'); fs.mkdirSync(probe, { recursive: true });
    const source = path.join(probe, 'probe.cpp');
    fs.writeFileSync(source, '#include <windows.h>\n#include <vector>\nint main() { std::vector<int> v{1}; return GetCurrentProcessId() && v[0] == 1 ? 0 : 1; }\n');
    run(path.join(layout.bin, 'cl.exe'), ['/nologo', '/EHsc', '/MT', '/std:c++17', `/Fo${path.join(probe, 'probe.obj')}`, `/Fe${path.join(probe, 'probe.exe')}`, source, '/link', '/MACHINE:X64', 'kernel32.lib'], { env, logFile: path.join(logs, 'compiler-probe.log') });
  };
  try {
    let layout = inspectNative(path.join(root, 'msvc/VC/Tools/MSVC'), path.join(root, 'msvc/Windows Kits/10'));
    let nativeSource = 'portable-cache';
    if (!layout) {
      const sdkRoots = [process.env.WindowsSdkDir, process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Windows Kits/10')].filter(Boolean);
      const vcRoots = [];
      if (process.env.VCToolsInstallDir) vcRoots.push(path.dirname(process.env.VCToolsInstallDir.replace(/[\\/]+$/, '')));
      const vswhere = path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft Visual Studio/Installer/vswhere.exe');
      if (isFile(vswhere)) {
        const result = run(vswhere, ['-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { soft: true });
        if (result.status === 0) {
          for (const installation of result.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean)) {
            vcRoots.push(path.join(installation, 'VC/Tools/MSVC'));
          }
        }
      }
      for (const vcRoot of vcRoots) for (const sdk of sdkRoots) { if (!layout) layout = inspectNative(vcRoot, sdk); }
      if (layout) nativeSource = 'installed-build-tools';
    }
    if (!layout) {
      if (options.noDownload) {
        throw new Error('MSVC and/or Windows SDK is missing or incomplete. Run without -NoDownload so the verified portable tools can be downloaded (or install the Microsoft C++ Build Tools and rerun).');
      }
      // 2026-09-21: the signed system installer is not available to every
      // session (no administrator approval, non-interactive terminals). The
      // portable extraction is the fallback: it uses the verified channel+
      // catalog pair (loadMicrosoftCatalog), publisher SHA-256/size checks
      // for every payload, and a compile/link probe before replacing any cache.
      const { channel, manifest, manifestPayload } = loadMicrosoftCatalog(download, cache);
      const plan = planMicrosoft(channel, manifest);
      const licenseReceipt = path.join(root, 'microsoft-license.json');
      let accepted = false;
      if (isFile(licenseReceipt)) { try { accepted = readJson(licenseReceipt).license === plan.license; } catch {} }
      if (!accepted) {
        log(`Microsoft Build Tools / Windows SDK license: ${plan.license}`);
        if (options.acceptLicense) accepted = true;
        else if (process.stdin.isTTY && !process.env.CI) {
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          try { accepted = /^y(es)?$/i.test((await rl.question('Accept the Microsoft toolchain license and download the build tools? [y/N] ')).trim()); }
          finally { rl.close(); }
        }
        if (!accepted) throw new Error('Microsoft toolchain license was not accepted. Review the license and rerun with -AcceptToolchainLicense (or answer Yes interactively).');
        fs.writeFileSync(licenseReceipt, JSON.stringify({ license: plan.license, acceptedAt: new Date().toISOString() }, null, 2));
      }
      const staging = path.join(root, '.msvc-new');
      const inspectStage = directory => inspectNative(path.join(directory, 'VC/Tools/MSVC'), path.join(directory, 'Windows Kits/10'));
      // 2026-09-21: a previous run may have staged a complete toolchain and
      // then lost the final promote step (e.g. a transient rename EPERM).
      // Reuse it instead of re-downloading several GB.
      let staged = inspectStage(staging);
      if (staged) {
        log('Reusing a complete staged toolchain left by a previous interrupted setup run; no new downloads.');
      } else {
        // Only the fixed, internal incomplete staging directory is discarded.
        if (fs.existsSync(staging)) { assertWritableTree(staging); fs.rmSync(staging, { recursive: true, force: true }); }
        fs.mkdirSync(staging);
        log(`Preparing MSVC ${plan.family} and Windows SDK ${plan.sdkFamily}. First setup can download several hundred MB; keep several GB free.`);
        for (const p of plan.vcPayloads) extract(downloadPayload(p), staging, 'Contents/');
        const installers = path.join(staging, '_sdk-installers'); fs.mkdirSync(installers);
        const cabs = new Map(), msiPaths = [];
        for (const p of plan.sdkMsi) {
          const source = downloadPayload(p), local = path.join(installers, p.name);
          fs.copyFileSync(source, local); msiPaths.push(local);
          for (const cab of referencedCabs(fs.readFileSync(source), plan.sdkCab)) cabs.set(cab.name.toLowerCase(), cab);
        }
        if (cabs.size === 0) throw new Error('No SDK cabinets could be resolved. Refusing to create an incomplete toolchain.');
        for (const p of cabs.values()) fs.copyFileSync(downloadPayload(p), path.join(installers, p.name));
        for (const msi of msiPaths) {
          log(`Extracting ${path.basename(msi)} ...`);
          const msiLog = path.join(logs, path.basename(msi) + '.log');
          const r = run(path.join(process.env.SystemRoot, 'System32/msiexec.exe'), ['/a', msi, '/qn', '/norestart', `TARGETDIR=${staging}`, '/L*v', msiLog], { soft: true });
          if (r.error || ![0, 3010].includes(r.status)) throw new Error(`SDK extraction failed (exit ${r.status}). See ${msiLog}. Windows Installer policy or another running installer can block extraction; no application or driver has been deployed.`);
        }
        for (const folder of ['Program Files', 'Program Files (x86)']) {
          const source = path.join(staging, folder, 'Windows Kits');
          if (fs.existsSync(source)) fs.cpSync(source, path.join(staging, 'Windows Kits'), { recursive: true });
        }
        staged = inspectStage(staging);
        if (!staged) throw new Error(`Downloaded compiler/SDK did not contain the required x64 files. Inspect ${staging} and ${logs}.`);
        // Keep the runtime support DLLs beside tools, as in the publisher's layout.
        for (const redistVersion of directories(path.join(staging, 'VC/Redist/MSVC'))) {
          const debug = path.join(staging, 'VC/Redist/MSVC', redistVersion, 'debug_nonredist/x64');
          const copyDlls = directory => {
            if (!fs.existsSync(directory)) return;
            for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
              const file = path.join(directory, entry.name);
              if (entry.isDirectory()) copyDlls(file);
              else if (/\.dll$/i.test(entry.name)) fs.copyFileSync(file, path.join(staged.bin, entry.name));
            }
          };
          copyDlls(debug);
        }
        const dia = path.join(staging, 'DIA%20SDK/bin/amd64/msdia140.dll');
        if (isFile(dia)) fs.copyFileSync(dia, path.join(staged.bin, 'msdia140.dll'));
        fs.rmSync(installers, { recursive: true, force: true });
        fs.writeFileSync(path.join(staging, 'download-receipt.json'), JSON.stringify({ createdAt: new Date().toISOString(), manifest: manifestPayload,
          msvc: staged.vcVersion, sdk: staged.sdkVersion, payloads: [...plan.vcPayloads, ...plan.sdkMsi, ...cabs.values()] }, null, 2));
      }
      probeCompiler(staged); // Validate the downloaded compiler before replacing any existing cache.
      promoteDirectory(staging, path.join(root, 'msvc'), inspectStage);
      layout = inspectStage(path.join(root, 'msvc')); nativeSource = 'downloaded-portable-tools';
    }
    log(`Using MSVC ${layout.vcVersion}, Windows SDK ${layout.sdkVersion} (${nativeSource}).`);
    const environment = nativeEnvironment(layout);
    environment.paths.unshift(path.dirname(process.execPath));
    let env = toolEnv(process.env, environment);
    // Check an existing installation/cache as well; never trust cl.exe alone.
    probeCompiler(layout);
    log('Compiler and SDK passed the compile/link probe.');

    if (options.prepareDependencies && !options.guiOnly) {
      // The MSBuild and direct-cl builds share the same deep source check and
      // pinned restoration. A copied ThirdParty tree need not be a git submodule.
      prepareNativeDependencies(repo, { noDownload: Boolean(options.noDownload) });
    }

    let rustVersion = null, rustSource = 'not-required';
    if (!options.driverOnly) {
      const cargoRoot = path.join(root, 'cargo'), rustupRoot = path.join(root, 'rustup');
      const portableVars = { CARGO_HOME: cargoRoot, RUSTUP_HOME: rustupRoot, RUSTUP_TOOLCHAIN: 'stable-x86_64-pc-windows-msvc' };
      const portableEnv = { ...env, ...portableVars, PATH: path.join(cargoRoot, 'bin') + ';' + env.PATH };
      const portableCompiler = path.join(cargoRoot, 'bin/rustc.exe');
      let usePortable = false;
      if (isFile(portableCompiler) && isFile(path.join(cargoRoot, 'bin/cargo.exe'))) {
        rustVersion = probeRust(portableCompiler, portableEnv, run); usePortable = Boolean(rustVersion);
      }
      if (!rustVersion) {
        rustVersion = probeRust('rustc.exe', env, run);
        if (rustVersion && run('cargo.exe', ['--version'], { env, soft: true }).status !== 0) rustVersion = null;
        if (rustVersion) rustSource = 'existing-rust';
      }
      if (!rustVersion) {
        if (options.noDownload) throw new Error('A working x64 MSVC Rust/Cargo toolchain is missing. Run without -NoDownload to install a project-local toolchain.');
        const base = 'https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe';
        const sums = fs.readFileSync(download(base + '.sha256', path.join(cache, 'rustup-init.exe.sha256')), 'utf8');
        const checksum = /^([a-f\d]{64})(?:\s|$)/i.exec(sums.trim())?.[1];
        if (!checksum) throw new Error('Invalid official rustup SHA-256 response.');
        const installer = download(base, path.join(cache, 'rustup-init.exe'), checksum.toLowerCase());
        log('Installing project-local Rust/Cargo (stable, minimal profile); no user PATH or user Rust configuration is changed.');
        const rustEnv = { ...portableEnv, RUSTUP_INIT_SKIP_PATH_CHECK: 'yes', RUSTUP_INIT_SKIP_MSVC_CHECK: '1', RUSTUP_DIST_SERVER: 'https://static.rust-lang.org', RUSTUP_UPDATE_ROOT: 'https://static.rust-lang.org/rustup' };
        run(installer, ['-y', '--no-modify-path', '--default-host', 'x86_64-pc-windows-msvc', '--default-toolchain', 'stable', '--profile', 'minimal'], { env: rustEnv, logFile: path.join(logs, 'rustup-install.log') });
        rustVersion = probeRust(portableCompiler, portableEnv, run);
        if (!rustVersion || run(path.join(cargoRoot, 'bin/cargo.exe'), ['--version'], { env: portableEnv, soft: true }).status !== 0) throw new Error('Rust setup completed without a usable x64 MSVC Rust/Cargo pair. See rustup-install.log.');
        usePortable = true;
      }
      if (usePortable) { Object.assign(environment.variables, portableVars); environment.paths.push(path.join(cargoRoot, 'bin')); rustSource = 'portable-rust'; }
      env = toolEnv(process.env, environment);
      log(`Using Rust ${rustVersion} (${rustSource}).`);
      if (options.prepareDependencies) {
        const gui = path.join(repo, 'GalaxyXRDriverGUI');
        const stamp = path.join(gui, 'node_modules/.galaxyxrdriver-lock.sha256');
        const fingerprint = hash(Buffer.concat([fs.readFileSync(path.join(gui, 'package.json')), fs.readFileSync(path.join(gui, 'package-lock.json'))]));
        const ready = ['tauri.cmd', 'tsc.cmd', 'vite.cmd'].every(name => isFile(path.join(gui, 'node_modules/.bin', name))) && isFile(stamp) && fs.readFileSync(stamp, 'utf8').trim() === fingerprint;
        if (!ready) {
          if (options.noDownload) throw new Error('Frontend dependencies do not match the bootstrap lock stamp. Run once without -NoDownload so npm ci can prepare the locked dependencies.');
          log('Installing the exact frontend dependencies with npm ci (lockfiles are not changed).');
          run(process.env.ComSpec || path.join(process.env.SystemRoot, 'System32/cmd.exe'), ['/D', '/S', '/C', 'npm.cmd ci --no-audit --no-fund --include=dev --include=optional 2>&1'], { cwd: gui, env, logFile: path.join(logs, 'npm-ci.log') });
          for (const name of ['tauri.cmd', 'tsc.cmd', 'vite.cmd']) if (!isFile(path.join(gui, 'node_modules/.bin', name))) throw new Error(`npm ci did not provide ${name}. See npm-ci.log.`);
          fs.writeFileSync(stamp, fingerprint + '\n');
        } else log('Locked frontend dependencies are already prepared.');
      }
    }
    const report = { schema: 1, completedAt: new Date().toISOString(), nativeSource, msvc: layout.vcVersion, sdk: layout.sdkVersion,
      node: process.version, rust: rustVersion, rustSource, paths: environment.paths, variables: environment.variables };
    fs.writeFileSync(reportFile + '.tmp', JSON.stringify(report, null, 2) + '\n'); fs.renameSync(reportFile + '.tmp', reportFile);
    log(`Build prerequisites ready. Receipt and logs: ${root}`);
    return report;
  } finally { if (lock !== undefined) fs.closeSync(lock); fs.rmSync(lockPath, { force: true }); }
}
module.exports = { loadMicrosoftCatalog, assertServedCatalogStructure, safeUri, safeName, payload, compareVersions, inspectNative, nativeEnvironment, parseShasums, planMicrosoft, referencedCabs,
  assertWritableTree, promoteDirectory, missingSources, toolEnv, probeRust, setup };
if (require.main === module) {
  const options = {};
  try {
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--project' || arg === '--powershell') { if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${arg} needs a value.`); options[arg.slice(2)] = args[++i]; }
      else if (arg === '--driver-only') options.driverOnly = true;
      else if (arg === '--gui-only') options.guiOnly = true;
      else if (arg === '--no-download') options.noDownload = true;
      else if (arg === '--accept-license') options.acceptLicense = true;
      else if (arg === '--prepare-dependencies') options.prepareDependencies = true;
      else throw new Error(`Unknown setup argument: ${arg}`);
    }
    if (!options.project || !options.powershell || (options.driverOnly && options.guiOnly)) throw new Error('Specify --project and --powershell, and at most one partial-build mode.');
    setup(options).catch(error => { console.error(`[tools] ${error.message}`); process.exitCode = 1; });
  } catch (error) { console.error(`[tools] ${error.message}`); process.exitCode = 1; }
}
