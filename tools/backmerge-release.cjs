'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { bumpVersion } = require('../bump-version.js');
const { verifyReleaseVersion } = require('./verify-release-version.cjs');

// Builds may modify tracked inputs. Never switch branches in their checkout.
function backmergeRelease(repo, releaseCommit, { env = process.env } = {}) {
  if (typeof releaseCommit !== 'string' || !/^[a-f0-9]{40}$/i.test(releaseCommit)) {
    throw new Error('RELEASE_COMMIT must be a full 40-character Git commit SHA.');
  }
  repo = path.resolve(repo);
  env = { ...process.env, ...env };
  const git = (cwd, args, commandEnv = env) => execFileSync('git', args, {
    cwd, env: commandEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  }).trim();
  const fetchBranches = () => git(repo, ['fetch', 'origin',
    '+refs/heads/main:refs/remotes/origin/main',
    '+refs/heads/dev:refs/remotes/origin/dev']);
  const isAncestor = (older, newer) => {
    try { git(repo, ['merge-base', '--is-ancestor', older, newer]); return true; }
    catch (error) { if (error.status === 1) return false; throw error; }
  };
  const botEnv = {
    ...env,
    GIT_AUTHOR_NAME: 'github-actions[bot]',
    GIT_AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
    GIT_COMMITTER_NAME: 'github-actions[bot]',
    GIT_COMMITTER_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
  };
  let scratch;
  try {
    // Fetch/push from the checkout whose credentials actions/checkout configured.
    fetchBranches();
    git(repo, ['merge-base', '--is-ancestor', releaseCommit, 'refs/remotes/origin/main']);
    // Once synchronized, later intentional dev prereleases must stay untouched.
    if (isAncestor(releaseCommit, 'refs/remotes/origin/dev')) {
      return { releaseCommit, mergedCommit: git(repo, ['rev-parse', 'refs/remotes/origin/dev']) };
    }
    const releaseVersion = JSON.parse(git(repo,
      ['show', `${releaseCommit}:GalaxyXRDriverGUI/package.json`]).replace(/^\uFEFF/, '')).version;
    const buildRoot = path.resolve(repo, '../builds/GalaxyXR-Driver/build');
    for (let ancestor = buildRoot; ; ancestor = path.dirname(ancestor)) {
      try {
        const stat = fs.lstatSync(ancestor);
        if (stat.isSymbolicLink()) throw new Error(`Linked backmerge artifact ancestor: ${ancestor}`);
        if (!stat.isDirectory()) throw new Error(`Backmerge artifact ancestor is not a directory: ${ancestor}`);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (path.dirname(ancestor) === ancestor) break;
    }
    fs.mkdirSync(buildRoot, { recursive: true });
    for (let attempt = 1; attempt <= 3; attempt++) {
      const devTip = git(repo, ['rev-parse', 'refs/remotes/origin/dev']);
      if (isAncestor(releaseCommit, devTip)) return { releaseCommit, mergedCommit: devTip };
      scratch = fs.mkdtempSync(path.join(buildRoot, 'release-backmerge-'));
      const worktree = path.join(scratch, 'worktree');
      git(repo, ['worktree', 'add', '--detach', worktree, devTip]);
      // First sync reconciles version fields only; real source conflicts must fail.
      // A true fast-forward already carries the complete published version chain.
      const devVersion = verifyReleaseVersion(worktree).version;
      if (!isAncestor(devTip, releaseCommit) && devVersion !== releaseVersion) {
        const versionFiles = bumpVersion(worktree, releaseVersion);
        git(worktree, ['add', '--', ...versionFiles]);
        if (git(worktree, ['diff', '--cached', '--name-only']).length) {
          git(worktree, ['-c', 'commit.gpgsign=false', 'commit',
            '-m', `chore(release): v${releaseVersion}`,
            '-m', 'Synchronize version metadata to the published main release before merging into dev.'], botEnv);
        }
      }
      git(worktree, ['-c', 'commit.gpgsign=false', 'merge', '--no-edit',
        '-m', 'chore: backmerge main into dev', releaseCommit], botEnv);
      verifyReleaseVersion(worktree, { expectedVersion: releaseVersion });
      const mergedCommit = git(worktree, ['rev-parse', 'HEAD']);
      try {
        git(repo, ['push', 'origin', `${mergedCommit}:refs/heads/dev`]);
      } catch (error) {
        // Retry only a stale-ref rejection caused by forward dev progress.
        const rejected = /\[(?:remote )?rejected\].*\((?:fetch first|non-fast-forward|incorrect old value provided|failed to update ref)\)/
          .test(error.stderr?.toString() || '');
        if (attempt === 3 || !rejected) throw error;
        fetchBranches();
        const advanced = git(repo, ['rev-parse', 'refs/remotes/origin/dev']);
        if (advanced === devTip || !isAncestor(devTip, advanced)) throw error;
        git(repo, ['merge-base', '--is-ancestor', releaseCommit, 'refs/remotes/origin/main']);
        git(repo, ['worktree', 'remove', worktree]);
        fs.rmdirSync(scratch);
        scratch = undefined;
        continue;
      }
      fetchBranches();
      // dev can advance again immediately after the push; containment is sufficient.
      git(repo, ['merge-base', '--is-ancestor', releaseCommit, 'refs/remotes/origin/dev']);
      git(repo, ['merge-base', '--is-ancestor', mergedCommit, 'refs/remotes/origin/dev']);
      git(repo, ['worktree', 'remove', worktree]);
      fs.rmdirSync(scratch);
      return { releaseCommit, mergedCommit };
    }
  } catch (error) {
    const detail = [error.stderr, error.stdout].map(output => output?.toString().trim()).filter(Boolean).join('\n') || error.message;
    throw new Error(`${detail}${scratch ? `\nBackmerge scratch preserved at: ${scratch}` : ''}`, { cause: error });
  }
}

module.exports = { backmergeRelease };

if (require.main === module) {
  try {
    const result = backmergeRelease(path.resolve(__dirname, '..'), process.env.RELEASE_COMMIT);
    console.log(`Backmerged release ${result.releaseCommit} into dev (${result.mergedCommit}).`);
  } catch (error) {
    console.error(`::error::Backmerge: ${error.message}`);
    process.exitCode = 1;
  }
}
