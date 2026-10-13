'use strict';
const { fixtureRoot } = require('../lib/test-fixtures.cjs');
// Network-free tests. The catalog/bytes are real temporary files. Installer and
// OS-signature unit tests never download or execute a Microsoft bootstrapper.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const tools = require('../lib/portable-toolchain.cjs');
const repo = path.resolve(__dirname, '../..');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function temp(t) {
  const dir = fs.mkdtempSync(path.join(fixtureRoot(), 'GalaxyXR downloads [fixture] '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}
function pair(label = 'one', bytes) {
  bytes ??= Buffer.from(JSON.stringify({ info: { productDisplayVersion: '17.14' }, packages: [{ id: label }] }));
  const payload = { url: `https://download.visualstudio.microsoft.com/fixture/${label}/VisualStudio.vsman`, fileName: 'VisualStudio.vsman', sha256: digest(bytes), size: bytes.length };
  const channel = { info: { label }, channelItems: [{ id: 'Microsoft.VisualStudio.Manifests.VisualStudio', payloads: [payload] }] };
  return { bytes, payload, channel };
}
function downloads(dir, versions, behaviors = {}) {
  const calls = [], warnings = [];
  let n = 0;
  return {
    calls, warnings,
    run() {
      return tools.loadMicrosoftCatalog((url, file, sha, size) => {
        calls.push({ url, sha, size });
        if (url === 'https://aka.ms/vs/17/release/channel') {
          n++;
          fs.writeFileSync(file, JSON.stringify(versions[Math.min(n - 1, versions.length - 1)].channel));
        } else {
          if (behaviors.throwError) throw new Error(behaviors.throwError);
          const p = versions[Math.min(n - 1, versions.length - 1)];
          const bytes = behaviors.corruptAlways || (behaviors.corruptFirst && n === 1) ? Buffer.from('untrusted!') : p.bytes;
          fs.writeFileSync(file, bytes);
        }
        return file;
      }, dir, text => warnings.push(text));
    },
  };
}
test('catalog URL, digest and file size come from the same channel payload', t => {
  const p = pair(), d = downloads(temp(t), [p]);
  assert.equal(d.run().manifest.packages[0].id, 'one');
  assert.deepEqual(d.calls[1], { url: p.payload.url, sha: p.payload.sha256, size: p.payload.size });
  assert.equal(d.calls.length, 2);
});
test('an integrity mismatch refreshes the channel, not only the old catalog URL', t => {
  const a = pair('a'), b = pair('b'), d = downloads(temp(t), [a, b], { corruptFirst: true });
  const result = d.run();
  assert.equal(result.channel.info.label, 'b'); assert.equal(result.manifest.packages[0].id, 'b');
  assert.equal(d.calls.length, 4); assert.equal(d.warnings.length, 1);
  assert.equal(d.calls[3].sha, b.payload.sha256); assert.notEqual(a.payload.sha256, b.payload.sha256);
});
test('a persistent mismatch fails closed and gives the explicit signed-installer route', t => {
  const d = downloads(temp(t), [pair()], { corruptAlways: true });
  assert.throws(() => d.run(), /still failed verification[\s\S]*Install-MicrosoftBuildTools\.ps1 -AcceptLicense/);
  // 5 calls: channel, strict manifest, refreshed channel, strict manifest,
  // then the unhashed structural-fallback fetch (which also fails closed here).
  assert.equal(d.calls.length, 5);
});
test('it never blesses the received hash as a replacement expected hash', t => {
  const p = pair(), d = downloads(temp(t), [p], { corruptAlways: true });
  assert.throws(() => d.run(), /integrity mismatch/);
  for (const call of d.calls.filter(c => c.sha)) { assert.equal(call.sha, p.payload.sha256); assert.notEqual(call.sha, digest('untrusted!')); }
});
test('stale channel digest with a valid current catalog is accepted (2026-09-21); garbage still fails closed', t => {
  const channelVersion = '17.14.41+37710.0.-september.2026-';
  const make = servedBytes => {
    const payload = { url: 'https://download.visualstudio.microsoft.com/fixture/fallback/VisualStudio.vsman', fileName: 'VisualStudio.vsman',
      sha256: digest(Buffer.from('stale-publisher-bytes')), size: 20 };
    return { bytes: servedBytes, payload, channel: { info: { productSemanticVersion: channelVersion }, channelItems: [{ id: 'Microsoft.VisualStudio.Manifests.VisualStudio', payloads: [payload] }] } };
  };
  const valid = make(Buffer.from(JSON.stringify({ manifestVersion: '1.1', info: { productSemanticVersion: channelVersion, productDisplayVersion: '17.14.41 (September 2026)' }, packages: [{ id: 'one' }] })));
  const d = downloads(temp(t), [valid]);
  const result = d.run();
  assert.equal(result.manifest.packages[0].id, 'one');
  assert.equal(result.manifestPayload.sha256, digest(valid.bytes));
  assert.ok(d.warnings.some(w => /structural verification/i.test(w)));
  const garbage = make(Buffer.from('untrusted!'));
  const d2 = downloads(temp(t), [garbage]);
  assert.throws(() => d2.run(), /still failed verification[\s\S]*Structural fallback check/);
  const wrongVersion = make(Buffer.from(JSON.stringify({ manifestVersion: '1.1', info: { productSemanticVersion: '16.0.0' }, packages: [{ id: 'one' }] })));
  const d3 = downloads(temp(t), [wrongVersion]);
  assert.throws(() => d3.run(), /still failed verification[\s\S]*does not match the channel/);
});
test('PowerShell integrity failures trigger one channel refresh', t => {
  const d = downloads(temp(t), [pair()], { throwError: 'Download integrity mismatch (SHA-256/size)' });
  assert.throws(() => d.run(), /still failed verification/); assert.equal(d.calls.length, 5);
});
test('network and permission failures are not mislabeled as hash mismatches', t => {
  const d = downloads(temp(t), [pair()], { throwError: 'Access denied to tool cache' });
  assert.throws(() => d.run(), /^Error: Access denied/); assert.equal(d.calls.length, 2);
});
test('a stale declared size with a matching publisher SHA-256 is advisory, not fatal (2026-09-21)', t => {
  const p = pair(); p.payload.size++;
  const d = downloads(temp(t), [p]);
  const result = d.run();
  assert.equal(result.manifest.packages[0].id, 'one');
});
test('catalog checksums cover original bytes before BOM removal for JSON parsing', t => {
  const p = pair('bom', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"packages":[]}')]));
  assert.deepEqual(downloads(temp(t), [p]).run().manifest.packages, []);
});
test('a BOM is not silently removed to make an incorrect publisher checksum pass', t => {
  const p = pair('badbom', Buffer.from('\ufeff{"packages":[]}'));
  p.payload.sha256 = digest(p.bytes.subarray(3));
  assert.throws(() => downloads(temp(t), [p]).run(), /integrity mismatch/);
});
test('validly hashed malformed JSON is rejected, not executed or rewritten', t => {
  const d = downloads(temp(t), [pair('invalid', Buffer.from('<html>proxy error</html>'))]);
  assert.throws(() => d.run(), SyntaxError); assert.equal(d.calls.length, 2);
});
test('missing catalog hashes and unofficial URLs fail before catalog download', t => {
  for (const mutate of [p => delete p.sha256, p => p.url = 'https://untrusted.invalid/catalog']) {
    const p = pair(); mutate(p.payload);
    const d = downloads(temp(t), [p]); assert.throws(() => d.run()); assert.equal(d.calls.length, 1);
  }
});
test('no publisher size is still supported, but invalid sizes are rejected', () => {
  const p = pair().payload; const noSize = { ...p }; delete noSize.size;
  assert.equal(tools.payload(noSize).size, undefined);
  for (const size of [-1, 1.5, '200', null, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => tools.payload({ ...p, size }), /file size/);
});
test('changed downloader retains hash checks, logs identities, and bypasses HTTP caches', () => {
  const s = fs.readFileSync(path.join(repo, 'tools/PortableToolchainIO.ps1'), 'utf8');
  assert.match(s, /AutomaticDecompression = \[Net.DecompressionMethods\]::GZip -bor \[Net.DecompressionMethods\]::Deflate/);
  assert.match(s, /NoCacheNoStore/); assert.match(s, /Assert-ToolDownloadedFile -Path \$partial/);
  assert.match(s, /function Get-ToolFileIdentity/);
  assert.match(s, /\[IO\.File\]::Exists/); assert.match(s, /\[Security\.Cryptography\.SHA256\]::Create\(\)/);
  assert.doesNotMatch(s, /Get-FileHash/); // Hash the byte stream, not a provider-expanded path.
  assert.match(s, /expectedSha256/); assert.match(s, /actualSha256/);
  assert.doesNotMatch(s, /ServerCertificateValidationCallback|SkipCertificateCheck|Invoke-Expression/);
});
test('cache verification catches only invalid data and enforces offline mode before setup', () => {
  const s = fs.readFileSync(path.join(repo, 'tools/PortableToolchainIO.ps1'), 'utf8');
  const download = s.slice(s.indexOf('function Invoke-ToolDownload'), s.indexOf('function Expand-ToolZip'));
  const offline = download.indexOf('if ($NoDownload)');
  assert.ok(offline > 0);
  assert.ok(offline < download.indexOf('[IO.Directory]::CreateDirectory'));
  assert.ok(offline < download.indexOf('New-ToolDownloadRequest $uri'));
  assert.match(download, /catch \[IO\.InvalidDataException\]/);
  assert.match(s, /-NoDownload:\$CacheOnly/);
});
test('local setup automatically provisions signed Microsoft Build Tools instead of scraping vsman', () => {
  const setup = fs.readFileSync(path.join(repo, 'tools/Setup-PortableBuildTools.ps1'), 'utf8');
  assert.match(setup, /Install-MicrosoftBuildTools -AcceptLicense:\$AcceptToolchainLicense -AutoElevate/);
  assert.match(setup, /Find-InstalledNativeBuildTools/);
  const installer = fs.readFileSync(path.join(repo, 'tools/Install-MicrosoftBuildTools.ps1'), 'utf8');
  assert.match(installer, /https:\/\/aka\.ms\/vs\/17\/release\/vs_buildtools\.exe/);
  assert.ok(installer.indexOf('$thumbprint = Assert-MicrosoftBootstrapperSignature') < installer.indexOf('$process = Start-Process -FilePath $bootstrapper'));
  assert.match(installer, /Microsoft\.VisualStudio\.Workload\.VCTools/);
  assert.match(installer, /--includeRecommended/);
  assert.match(installer, /Verb RunAs/);
  assert.doesNotMatch(installer, /Get-MicrosoftBuildToolsDescriptor/);
  assert.match(installer, /Avoid the large VisualStudio\.vsman catalog entirely/);
  // 2026-09-21: sessions without administrator approval fall back to the
  // verified portable download (verified channel+catalog pair, publisher
  // hashes, compile/link probe) instead of failing.
  const portable = fs.readFileSync(path.join(repo, 'tools/lib/portable-toolchain.cjs'), 'utf8');
  assert.match(portable, /loadMicrosoftCatalog\(download, cache\)/);
  assert.match(portable, /downloaded-portable-tools/);
});
test('installed tools discovery enumerates all VS instances instead of only latest', () => {
  const s = fs.readFileSync(path.join(repo, 'tools/lib/portable-toolchain.cjs'), 'utf8');
  assert.doesNotMatch(s, /run\(vswhere, \['-latest'/);
  assert.match(s, /result.stdout.split\(/);
});

const hosts = process.platform === 'win32' ? ['powershell.exe', 'pwsh.exe'] : ['powershell', 'pwsh'];
for (const host of hosts) {
  const probe = spawnSync(host, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8' });
  const available = process.platform === 'win32' && !probe.error && probe.status === 0;
  const skip = available ? false : `${host} unavailable; not a Windows execution`;
  if (!available && process.env.REQUIRE_PORTABLE_POWERSHELL_TESTS === '1') test(`required Windows test host: ${host}`, () => assert.fail(`${host} unavailable`));
  function run(t, body, extra = []) {
    const dir = temp(t), script = path.join(dir, 'fixture.ps1');
    fs.writeFileSync(script, `param([string]$Root,[string]$Work)\n$ErrorActionPreference='Stop'\n. (Join-Path $Root 'tools/PortableToolchainIO.ps1')\n. (Join-Path $Root 'tools/Install-MicrosoftBuildTools.ps1')\n${body}\n`);
    return spawnSync(host, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, repo, dir, ...extra], { encoding: 'utf8', timeout: 60000 });
  }
  function success(r) { assert.ifError(r.error); assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`); }
  test(`${host}: changed scripts parse with the real PowerShell parser`, { skip }, t => success(run(t, `
foreach($name in @('Build-Portable.ps1','PortableToolchainIO.ps1','Install-MicrosoftBuildTools.ps1')) {
 $tokens=$null; $errors=$null
 [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $Root ('tools/'+$name)),[ref]$tokens,[ref]$errors)|Out-Null
 if($errors.Count){throw ($errors|Out-String)}
}`)));
  test(`${host}: HTTP requests preserve TLS restrictions and request gzip/deflate decoding`, { skip }, t => success(run(t, `
$request = New-ToolDownloadRequest ([Uri]'https://download.visualstudio.microsoft.com/fixture/catalog')
try {
 if($request.AllowAutoRedirect){throw 'Unvalidated redirects enabled'}
 if($request.AutomaticDecompression -ne ([Net.DecompressionMethods]::GZip -bor [Net.DecompressionMethods]::Deflate)){throw 'Decompression disabled'}
 if($request.CachePolicy.Level -ne [Net.Cache.RequestCacheLevel]::NoCacheNoStore){throw 'Cache policy incorrect'}
}finally{$request.Abort()}`)));
  test(`${host}: strict file verifier accepts exact UTF8 bytes and size`, { skip }, t => success(run(t, `
$file=Join-Path $Work 'catalog.json'
[IO.File]::WriteAllBytes($file,[byte[]](123,125))
$sha='${digest(Buffer.from([123, 125]))}'
$ok=Assert-ToolDownloadedFile $file -Sha256 $sha -ExpectedSize 2
if($ok.bytes -ne 2 -or $ok.sha256 -ne $sha){throw 'Wrong byte identity'}`)));
  test(`${host}: verifier rejects wrong SHA and empty bodies; a stale declared size is advisory (2026-09-21)`, { skip }, t => success(run(t, `
$file=Join-Path $Work 'payload'
[IO.File]::WriteAllBytes($file,[byte[]](1,2,3))
$sha='${digest(Buffer.from([1, 2, 3]))}'
$rejected=$false
try{Assert-ToolDownloadedFile $file -Sha256 ('a'*64) -ExpectedSize 3|Out-Null}catch{$rejected=$true;if($_.Exception.Message -notmatch 'Actual SHA-256'){throw}}
if(-not $rejected){throw 'Corrupt download accepted'}
$ok=Assert-ToolDownloadedFile $file -Sha256 $sha -ExpectedSize 2
if($ok.bytes -ne 3 -or $ok.sizeMismatch -ne $true){throw 'Stale size must be advisory when the SHA-256 matches'}
[IO.File]::WriteAllBytes($file,[byte[]]@())
$rejected=$false;try{Assert-ToolDownloadedFile $file|Out-Null}catch{$rejected=$true};if(-not $rejected){throw 'Empty body accepted'}`)));
  test(`${host}: wrong cached bytes are never accepted without redownloading`, { skip }, t => success(run(t, `
$file=Join-Path $Work 'cache';[IO.File]::WriteAllText($file,'old bytes')
function New-ToolDownloadRequest { throw 'OFFLINE_TEST: stopped before network' }
function Start-Sleep { }
$rejected=$false
try { Invoke-ToolDownload -Source 'https://download.visualstudio.microsoft.com/fixture' -Destination $file -Sha256 ('a'*64) }
catch {$rejected=$true;if($_.Exception.Message -notmatch 'OFFLINE_TEST'){throw}}
if(-not $rejected){throw 'Invalid cache accepted'}
if([IO.File]::ReadAllText($file) -ne 'old bytes'){throw 'Old cache destroyed'}
if(@(Get-ChildItem -LiteralPath $Work -Filter '*.part').Count){throw 'Partial file leaked'}
if(-not (Test-Path -LiteralPath ($file+'.download.json'))){throw 'No diagnostic report'}`)));
  test(`${host}: verified cache can be reused without network`, { skip }, t => success(run(t, `
$file=Join-Path $Work 'cache';[IO.File]::WriteAllText($file,'verified bytes')
$sha='${digest('verified bytes')}'
function New-ToolDownloadRequest { throw 'Network should not be used' }
Invoke-ToolDownload -Source 'https://download.visualstudio.microsoft.com/fixture' -Destination $file -Sha256 $sha -ExpectedSize 14 -NoDownload`)));
  test(`${host}: dot-sourcing the I/O bridge preserves the caller's offline flag`, { skip }, t => success(run(t, `
$NoDownload=$true
. (Join-Path $Root 'tools/PortableToolchainIO.ps1')
if(-not $NoDownload){throw 'Dot-sourcing reset the caller offline flag'}`)));
  test(`${host}: cache I/O errors retain the original cause instead of triggering a download`, { skip }, t => success(run(t, `
$file=Join-Path $Work 'cache';[IO.File]::WriteAllText($file,'verified bytes')
function Get-ToolFileIdentity { throw 'CACHE_IO_FAILURE: cannot read fixture' }
function New-ToolDownloadRequest { throw 'NETWORK_REACHED: must not happen' }
$rejected=$false
try { Invoke-ToolDownload -Source 'https://nodejs.org/dist/does-not-exist.fixture' -Destination $file -Sha256 ('a'*64) }
catch {$rejected=$true;if($_.Exception.Message -notmatch 'CACHE_IO_FAILURE'){throw}}
if(-not $rejected){throw 'Cache read error was suppressed'}
if(Test-Path -LiteralPath ($file+'.download.json')){throw 'Unexpected network report'}
if([IO.File]::ReadAllText($file) -ne 'verified bytes'){throw 'Cache bytes changed'}`)));
  test(`${host}: official VS2022 Build Tools bootstrapper URL is allowed but unrelated aka.ms URLs are rejected`, { skip }, t => success(run(t, `
$ok=Assert-ToolDownloadUri 'https://aka.ms/vs/17/release/vs_buildtools.exe'
if($ok.AbsolutePath -ne '/vs/17/release/vs_buildtools.exe'){throw 'Bootstrapper URL rejected'}
$rejected=$false
try{Assert-ToolDownloadUri 'https://aka.ms/unrelated/file.exe'|Out-Null}catch{$rejected=$true}
if(-not $rejected){throw 'Unrelated aka.ms URL accepted'}`)));
  test(`${host}: invalid signatures or a different publisher block execution`, { skip }, t => success(run(t, `
$script:status='Valid';$script:publisher='Microsoft Corporation'
$certificate=[pscustomobject]@{Thumbprint='test-only'}
$certificate|Add-Member -MemberType ScriptMethod -Name GetNameInfo -Value {param($type,$issuer);return $script:publisher}
function Get-AuthenticodeSignature {param([string]$LiteralPath);return [pscustomobject]@{Status=$script:status;SignerCertificate=$certificate}}
if((Assert-MicrosoftBootstrapperSignature 'unused') -ne 'test-only'){throw 'Valid signature branch failed'}
foreach($case in @(@{status='NotSigned';publisher='Microsoft Corporation'},@{status='HashMismatch';publisher='Microsoft Corporation'},@{status='Valid';publisher='Someone Else'})) {
 $script:status=$case.status;$script:publisher=$case.publisher;$rejected=$false
 try{Assert-MicrosoftBootstrapperSignature 'unused'|Out-Null}catch{$rejected=$true}
 if(-not $rejected){throw 'Unsafe signer accepted'}
}`)));
  test(`${host}: installer command requests the C++ workload with recommended SDK components`, { skip }, t => success(run(t, `
$argsList=@(Get-BuildToolsInstallArguments 'C:\\Program Files (x86)\\BuildTools-GalaxyXRDriver')
if($argsList -notcontains '--wait' -or $argsList -notcontains '--norestart' -or $argsList -notcontains '--nocache'){throw 'Missing process safety flags'}
if(@($argsList|Where-Object{$_ -eq '--add'}).Count -ne 1){throw 'Wrong workload count'}
if($argsList -notcontains 'Microsoft.VisualStudio.Workload.VCTools' -or $argsList -notcontains '--includeRecommended'){throw 'C++ workload/SDK selection missing'}
if($argsList -contains 'modify'){throw 'Fresh install is modify'}
if(@(Get-BuildToolsInstallArguments 'C:\\Fixture' -Modify)[0] -ne 'modify'){throw 'Modify did not target same instance'}`)));
  test(`${host}: installer failure and reboot codes stop the build`, { skip }, t => success(run(t, `
Assert-BuildToolsInstallerExit -Code 0 -Logs 'fixture'
foreach($code in @(1,1603,3010,1641)) {
 $rejected=$false;try{Assert-BuildToolsInstallerExit -Code $code -Logs 'fixture'}catch{$rejected=$true}
 if(-not $rejected){throw 'Nonzero installer exit accepted'}
}`)));
}
