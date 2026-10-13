#!/usr/bin/env node
'use strict';

// Read-only preflight for the portable release entry points and shared helpers.
// Does not install dependencies, generate files, stage changes, or launch a build.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REQUIRED_BUILD_SOURCES = Object.freeze([
  '.gitignore',
  '.github/workflows/release.yml',
  '.github/workflows/build-tools.yml',
  'tools/tests/workflows.test.cjs',
  'build.js',
  'Directory.Build.props',
  'Directory.Build.targets',
  'bump-version.js',
  'tools/release-policy.cjs',
  'tools/publish-release.cjs',
  'tools/tests/automatic-release.test.cjs',
  'tools/Build-Portable.ps1',
  'tools/Enter-PortableBuildEnvironment.ps1',
  'tools/Setup-PortableBuildTools.ps1',
  'tools/PortableToolchainIO.ps1',
  'tools/Install-MicrosoftBuildTools.ps1',
  'tools/tests/toolchain-download.test.cjs',
  'tools/lib/portable-toolchain.cjs',
  'tools/lib/test-fixtures.cjs',
  'tools/lib/test-fixture-cleanup.ps1',
  'tools/prepare-native-dependencies.cjs',
  'tools/native-dependencies.lock.json',
  'tools/tests/native-dependencies.test.cjs',
  'tools/tests/portable-toolchain.test.cjs',
  'tools/Package-GitHubRelease.ps1',
  'tools/Verify-ReleaseVersion.ps1',
  'tools/verify-release-version.cjs',
  'tools/Test-FluentBuildHooks.cjs',
  'tools/lib/stage-companion.cjs',
  'tools/verify-build-sources.cjs',
  'tools/tests/build-sources.test.cjs',
]);

function git(project, args) {
  const result = spawnSync('git', args, {
    cwd: project,
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  });
  if (result.error) throw new Error(`Cannot run Git: ${result.error.message}`);
  if (result.signal) throw new Error(`Git was interrupted: ${result.signal}`);
  return result;
}

function verifyBuildSources(project, { requireTracked = false } = {}) {
  if (typeof project !== 'string' || !project.trim()) {
    throw new TypeError('A nonempty project directory is required.');
  }
  project = path.resolve(project);
  const problems = [];
  for (const relative of REQUIRED_BUILD_SOURCES) {
    try {
      const stat = fs.statSync(path.join(project, relative));
      if (!stat.isFile() || stat.size === 0) problems.push(`Missing or empty source file: ${relative}`);
    } catch (error) {
      if (error.code !== 'ENOENT') problems.push(`Cannot read ${relative}: ${error.message}`);
      else problems.push(`Missing source file: ${relative}`);
    }
  }
  if (problems.length) {
    throw new Error(`Portable build sources are incomplete:\n- ${problems.join('\n- ')}\nRestore the source files from the update and commit them. They are not npm packages or generated build outputs.`);
  }

  const repository = git(project, ['rev-parse', '--is-inside-work-tree']);
  const inGit = repository.status === 0 && repository.stdout.trim() === 'true';
  if (!inGit) {
    // Only an actual non-repository is allowed here. Do not hide unsafe ownership,
    // corruption, or another Git failure as a successful source snapshot check.
    const notRepository = /not a git repository/i.test(repository.stderr);
    if (!notRepository) throw new Error(`Cannot inspect Git checkout: ${repository.stderr.trim() || 'not a working tree'}`);
    if (requireTracked) throw new Error('Git tracking verification requires a working-tree checkout, not a ZIP-only source directory.');
    return { files: [...REQUIRED_BUILD_SOURCES], gitChecked: false, trackingChecked: false };
  }

  for (const relative of REQUIRED_BUILD_SOURCES) {
    // --no-index deliberately also detects a broken ignore rule when someone
    // previously force-added the helper. A future normal git add must still work.
    const ignored = git(project, ['check-ignore', '--no-index', '--quiet', '--', relative]);
    if (ignored.status === 0) {
      const reason = git(project, ['check-ignore', '--no-index', '--verbose', '--', relative]);
      problems.push(`Source is ignored by Git: ${relative}\n  ${reason.stdout.trim()}`);
    } else if (ignored.status !== 1) {
      throw new Error(`Git ignore check failed for ${relative}: ${ignored.stderr.trim()}`);
    }
    if (requireTracked) {
      const tracked = git(project, ['ls-files', '--error-unmatch', '--', relative]);
      if (tracked.status === 1) problems.push(`Source is not in the Git index: ${relative}`);
      else if (tracked.status !== 0) throw new Error(`Git tracking check failed for ${relative}: ${tracked.stderr.trim()}`);
    }
  }
  if (problems.length) {
    throw new Error(`Portable build sources will not reliably survive a fresh checkout:\n- ${problems.join('\n- ')}\nRe-include /tools/lib/ and its contents in .gitignore, then git add, commit, and push all required helpers. Start a NEW workflow on that commit; npm ci cannot restore a repository-local helper.`);
  }
  return { files: [...REQUIRED_BUILD_SOURCES], gitChecked: true, trackingChecked: requireTracked };
}

module.exports = { verifyBuildSources, REQUIRED_BUILD_SOURCES };

if (require.main === module) {
  try {
    let project = path.resolve(__dirname, '..');
    let requireTracked = false;
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--require-tracked') requireTracked = true;
      else if (args[i] === '--project' && args[i + 1] && !args[i + 1].startsWith('--')) project = args[++i];
      else throw new Error('Usage: node tools/verify-build-sources.cjs [--project <directory>] [--require-tracked]');
    }
    const result = verifyBuildSources(project, { requireTracked });
    const status = result.trackingChecked ? 'present, not ignored, and in the Git index' : result.gitChecked ? 'present and not ignored (tracking not requested)' : 'present (Git tracking not checked: source snapshot)';
    console.log(`[build-sources] ${result.files.length} required build source files are ${status}.`);
  } catch (error) {
    console.error(`[build-sources] ${error.message}`);
    process.exitCode = 1;
  }
}
