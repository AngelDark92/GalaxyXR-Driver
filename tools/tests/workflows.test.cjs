'use strict';
// Workflow contracts, not a substitute for an actual Windows build.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const repo = path.resolve(__dirname, '../..');
const read = name => fs.readFileSync(path.join(repo, name), 'utf8');
const release = read('.github/workflows/release.yml');
const developer = read('.github/workflows/build-tools.yml');

function assertReleaseSeparation(workflow) {
  assert.doesNotMatch(workflow, /node --test|REQUIRE_\w*POWERSHELL_TESTS|--require-tracked/);
  assert.doesNotMatch(workflow, /portable-toolchain\.test|toolchain-download\.test|Install-MicrosoftBuildTools/);
  // Build-only release (user policy, 2026-10-12): the unit, Rust, service and
  // NVENC compile suites run locally at the end of a task and in the
  // developer workflow, never in the release pipeline.
  assert.doesNotMatch(workflow, /run: npm test|cargo test --locked|Test-Nvenc/);
  assert.doesNotMatch(workflow, /^\s*(?:needs|workflow_run|continue-on-error):/m);
}

test('release does not depend on portable installer self-tests or tracked-test audits', () => {
  assertReleaseSeparation(release);
});

test('separation guard rejects accidentally reintroduced build-tool gates', () => {
  for (const gate of ['node --test tools/tests/portable-toolchain.test.cjs',
    "REQUIRE_PORTABLE_POWERSHELL_TESTS: '1'", 'needs: build-tools', 'continue-on-error: true',
    'run: npm test', 'cargo test --locked --lib']) {
    assert.throws(() => assertReleaseSeparation(`${release}\n  ${gate}\n`));
  }
});

test('release still prepares pinned sources and builds the driver and GUI', () => {
  const prepare = release.indexOf('node .\\tools\\prepare-native-dependencies.cjs');
  const check = release.indexOf('node .\\tools\\prepare-native-dependencies.cjs --check');
  const build = release.indexOf('node .\\build.js --vendor galaxyxr');
  assert.ok(prepare > 0 && check > prepare && build > check);
  assert.doesNotMatch(release, /--no-driver|--no-gui|--skip|SkipTests/);
  assert.match(release, /uses: microsoft\/setup-msbuild@/);
  assert.match(release, /uses: dtolnay\/rust-toolchain@/);
  assert.match(release, /run: npm ci/);
  assert.match(release, /node \.\\build\.js --vendor neutral/);
});

test('release keeps version, package, and publication validation', () => {
  assert.match(release, /Verify-ReleaseVersion\.ps1 -Tag \$tag -PassThru/);
  assert.match(release, /Package-GitHubRelease\.ps1/);
  assert.match(release, /if-no-files-found: error/);
  assert.match(release, /if: steps\.policy\.outputs\.publish == 'true'/);
  assert.match(release, /node \.\\tools\\release-policy\.cjs/);
  assert.match(release, /node \.\\tools\\publish-release\.cjs/);
  assert.match(release, /if: steps\.persist\.outputs\.publish == 'true'/);
  assert.match(release, /-Commit \$env:RELEASE_COMMIT/);
  assert.ok(release.indexOf('Prepare automatic version and changelog') < release.indexOf('Verify release version'));
  const persist = release.indexOf('node .\\tools\\release-policy.cjs --persist');
  assert.ok(persist > release.indexOf('Create versioned ZIP, checksum, and release notes'));
  assert.ok(persist > release.indexOf('Package-GitHubRelease.ps1'));
  assert.ok(persist < release.indexOf('node .\\tools\\publish-release.cjs'));
  assert.match(read('tools/publish-release.cjs'), /commit: process\.env\.RELEASE_COMMIT \|\| process\.env\.GITHUB_SHA/);
  assert.match(release, /branches: \['\*\*'\]/);
  assert.match(release, /pull_request:/);
  assert.match(release, /\.zip\.sha256/);
  // upload-artifact rejects '../' patterns; deliverables are staged in-workspace.
  assert.doesNotMatch(release, /^\s+\.\.\//m);
  assert.match(release, /path: ci-artifacts\//);
  assert.match(release, /path: ci-diagnostics\/\*\*/);
});

test('packaging uses the changelog once and keeps attribution in the separate credits file', () => {
  const packaging = read('tools/Package-GitHubRelease.ps1');
  assert.doesNotMatch(packaging, /Icon credits|Vilkka|Lux \/ Hekky|commitLines/);
  assert.match(packaging, /Copy-Item.*CREDITS\.md/);
  assert.match(packaging, /\$releaseSection,/);
});

test('developer workflow runs both PowerShell hosts and all tool suites without masking failure', () => {
  assert.match(developer, /branches: \['\*\*'\]/);
  assert.match(developer, /pull_request:/);
  assert.match(developer, /workflow_dispatch:/);
  assert.match(developer, /contents: read/);
  assert.ok(developer.indexOf('run: npm ci') < developer.indexOf('- name: Run service and packaging regressions'));
  assert.match(developer, /working-directory: GalaxyXRDriverGUI\s+run: npm ci/);
  assert.match(developer, /REQUIRE_PORTABLE_POWERSHELL_TESTS: '1'/);
  assert.match(developer, /REQUIRE_POWERSHELL_TESTS: '1'/);
  assert.match(developer, /-Filter '\*\.test\.cjs'/);
  assert.match(developer, /node --test @testFiles/);
  assert.match(developer, /if \(\$LASTEXITCODE -ne 0\) \{ exit \$LASTEXITCODE \}/);
  // The GUI unit suite moved here now that the release build is build-only.
  assert.match(developer, /- name: Run frontend tests\s+if: \$\{\{ !cancelled\(\) \}\}\s+working-directory: GalaxyXRDriverGUI\s+run: npm test/);
  assert.doesNotMatch(developer, /continue-on-error|pull_request_target|workflow_run/);
  for (const suite of ['Test-FluentFixes', 'Test-CompanionModes', 'Test-AboutSetup',
    'Test-SectionCards', 'Test-FluentBuildHooks', 'Test-SourceUpdate']) assert.ok(developer.includes(suite), suite);
});

test('local build retains preparation and has no CI-only testing prerequisite', () => {
  const portable = read('tools/Build-Portable.ps1');
  assert.match(portable, /Enter-PortableBuildEnvironment\.ps1/);
  assert.match(read('tools/Enter-PortableBuildEnvironment.ps1'), /Setup-PortableBuildTools\.ps1/);
  assert.doesNotMatch(portable, /node --test|REQUIRE_\w*POWERSHELL_TESTS/);
  assert.match(read('build.js'), /prepareNativeDependencies\(__dirname\)/);
});
