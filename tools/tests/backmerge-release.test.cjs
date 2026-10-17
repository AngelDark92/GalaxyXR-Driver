'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { fixtureRoot } = require('../lib/test-fixtures.cjs');
const { backmergeRelease } = require('../backmerge-release.cjs');
const { bumpVersion } = require('../../bump-version.js');
const { verifyReleaseVersion } = require('../verify-release-version.cjs');

const cargo = 'GalaxyXRDriverGUI/src-tauri/Cargo.toml';
const versionFiles = [
  'GalaxyXRDriver/src/Config/Config.cpp', 'GalaxyXRDriver/DriverFiles/driver.vrdrivermanifest',
  'GalaxyXRDriverGUI/package.json', 'GalaxyXRDriverGUI/package-lock.json',
  'GalaxyXRDriverGUI/src-tauri/tauri.conf.json', cargo, 'GalaxyXRDriverGUI/src-tauri/Cargo.lock',
];
function fixture() {
  const root = fs.mkdtempSync(path.join(fixtureRoot(), 'release-backmerge-'));
  const repo = path.join(root, 'GalaxyXR-Driver');
  const remote = path.join(root, 'origin.git');
  const env = Object.fromEntries(Object.entries(process.env).map(([key, value]) =>
    [key, key.toUpperCase().startsWith('GIT_') ? undefined : value]));
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'empty-gitconfig'),
    GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'file',
  });
  fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '');
  const git = (args, cwd = repo, identity = false) => execFileSync('git', args, {
    cwd, env: identity ? { ...env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } : env,
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const write = (file, content) => {
    const target = path.join(repo, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  const commit = (file, content, message) => {
    write(file, content);
    git(['add', '--', file]);
    git(['-c', 'commit.gpgsign=false', 'commit', '-m', message], repo, true);
    return git(['rev-parse', 'HEAD']);
  };
  const versionCommit = (version, message) => {
    const files = bumpVersion(repo, version);
    git(['add', '--', ...files]);
    git(['-c', 'commit.gpgsign=false', 'commit', '-m', message], repo, true);
    return git(['rev-parse', 'HEAD']);
  };
  git(['init', '--bare', remote], root);
  git(['init', '-b', 'main', repo], root);
  git(['remote', 'add', 'origin', remote]);
  // Exercise real maintained metadata and both root package-lock version fields.
  for (const file of versionFiles) write(file, fs.readFileSync(path.resolve(__dirname, '../..', file)));
  const base = versionCommit('1.0.10', 'base version');
  commit('tuning.txt', 'bandwidth=100\n', 'base tuning');
  git(['branch', 'dev']);
  git(['push', 'origin', 'main', 'dev']);
  const scratchRoot = path.join(root, 'builds/GalaxyXR-Driver/build');
  return { root, repo, remote, env, git, write, commit, versionCommit, base, scratchRoot,
    sync: release => backmergeRelease(repo, release, { env }),
    remoteDev: () => git(['rev-parse', 'refs/heads/dev'], remote),
  };
}
function fixtureTest(name, run) {
  test(name, t => {
    const f = fixture();
    try {
      run(f);
    } catch (error) {
      t.diagnostic(`Failed fixture preserved at ${f.root}`);
      throw error;
    }
    fs.rmSync(f.root, { recursive: true });
  });
}
function release(f) {
  const sha = f.versionCommit('1.0.11', 'published release');
  f.git(['push', 'origin', 'main']);
  return sha;
}
function assertPublishedVersion(f, commit, expectedVersion = '1.0.11') {
  const snapshot = fs.mkdtempSync(path.join(f.root, 'version-snapshot-'));
  for (const file of versionFiles) {
    const target = path.join(snapshot, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.git(['show', `${commit}:${file}`]));
  }
  assert.equal(verifyReleaseVersion(snapshot, { expectedVersion }).version, expectedVersion);
}
function assertCleanScratch(f) {
  assert.deepEqual(fs.readdirSync(f.scratchRoot), []);
  assert.equal(f.git(['worktree', 'list', '--porcelain']).match(/^worktree /gm).length, 1);
}
function advanceDevBeforePush(f, everyAttempt = false) {
  const quote = value => `'${value.replace(/\\/g, '/').replace(/'/g, `'"'"'`)}'`;
  const attempts = path.join(f.root, 'push-attempts');
  const advanced = path.join(f.root, 'concurrent-dev-sha');
  fs.writeFileSync(path.join(f.repo, '.git/hooks/pre-push'), `#!/bin/sh
attempts=${quote(attempts)}
count=0
if [ -f "$attempts" ]; then count=$(cat "$attempts"); fi
count=$((count + 1))
echo "$count" > "$attempts"
${everyAttempt ? '' : 'if [ "$count" -gt 1 ]; then exit 0; fi'}
unset GIT_DIR GIT_COMMON_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES
export GIT_AUTHOR_NAME=Fixture GIT_AUTHOR_EMAIL=fixture@example.invalid
export GIT_COMMITTER_NAME=Fixture GIT_COMMITTER_EMAIL=fixture@example.invalid
remote=${quote(f.remote)}
old=$(git --git-dir="$remote" rev-parse refs/heads/dev) || exit 1
tree=$(git --git-dir="$remote" rev-parse "$old^{tree}") || exit 1
new=$(echo 'Concurrent dev commit' | git --git-dir="$remote" -c commit.gpgsign=false commit-tree "$tree" -p "$old") || exit 1
git --git-dir="$remote" update-ref refs/heads/dev "$new" "$old" || exit 1
echo "$new" > ${quote(advanced)}
`, { mode: 0o755 });
  return { attempts, advanced };
}

fixtureTest('fast-forward succeeds while build-modified source Cargo.toml and checkout stay untouched', f => {
  const sha = release(f);
  const dirty = Buffer.from('[package]\r\nversion = "1.0.11"\r\n# Tauri modified this input\r\n');
  fs.writeFileSync(path.join(f.repo, cargo), dirty);
  const before = { head: f.git(['rev-parse', 'HEAD']), branch: f.git(['symbolic-ref', 'HEAD']),
    status: f.git(['status', '--porcelain']), config: fs.readFileSync(path.join(f.repo, '.git/config')) };
  assert.equal(f.sync(sha).mergedCommit, sha);
  assert.equal(f.remoteDev(), sha);
  assert.deepEqual(fs.readFileSync(path.join(f.repo, cargo)), dirty);
  assert.equal(f.git(['rev-parse', 'HEAD']), before.head);
  assert.equal(f.git(['symbolic-ref', 'HEAD']), before.branch);
  assert.equal(f.git(['status', '--porcelain']), before.status);
  assert.deepEqual(fs.readFileSync(path.join(f.repo, '.git/config')), before.config);
  assertCleanScratch(f);
});

fixtureTest('diverged dev preserves nonconflicting work and merge works without runner identity', f => {
  f.git(['checkout', 'dev']);
  f.commit('tuning.txt', 'bandwidth=600\n', 'dev tuning');
  f.git(['push', 'origin', 'dev']);
  f.git(['checkout', 'main']);
  f.commit('main-only.txt', 'main changes\n', 'main work');
  const sha = release(f);
  assert.throws(() => f.git(['config', '--get', 'user.name']));
  assert.throws(() => f.git(['config', '--get', 'user.email']));
  const merged = f.sync(sha).mergedCommit;
  assert.equal(f.git(['show', `${merged}:tuning.txt`]), 'bandwidth=600');
  assertPublishedVersion(f, merged);
  assert.equal(f.git(['show', `${merged}:main-only.txt`]), 'main changes');
  assert.equal(f.git(['show', '-s', '--format=%an|%cn', merged]), 'github-actions[bot]|github-actions[bot]');
  assert.equal(f.git(['show', '-s', '--format=%ae|%ce', merged]),
    '41898282+github-actions[bot]@users.noreply.github.com|41898282+github-actions[bot]@users.noreply.github.com');
  assert.equal(f.git(['rev-list', '--parents', '-n', '1', merged]).split(' ').length, 3);
  assert.equal(f.remoteDev(), merged);
  assertCleanScratch(f);
});

fixtureTest('dev prerelease normalizes all eight version fields and preserves nonversion dev metadata', f => {
  f.git(['checkout', 'dev']);
  f.versionCommit('1.0.12-dev.4', 'advance dev prerelease');
  f.commit('dev-only.txt', 'development survives\n', 'dev-only work');
  const pkg = JSON.parse(fs.readFileSync(path.join(f.repo, 'GalaxyXRDriverGUI/package.json'), 'utf8'));
  pkg.fixtureDevSetting = 'preserve this nonversion field';
  f.commit('GalaxyXRDriverGUI/package.json', JSON.stringify(pkg, null, 2) + '\n', 'nonversion dev metadata');
  f.git(['push', 'origin', 'dev']);
  f.git(['checkout', 'main']);
  const sha = release(f);
  const dirty = fs.readFileSync(path.join(f.repo, cargo)).toString() + '\n# Dirty build input stays unchanged\n';
  f.write(cargo, dirty);
  const merged = f.sync(sha).mergedCommit;
  assertPublishedVersion(f, merged);
  assert.equal(f.git(['show', `${merged}:dev-only.txt`]), 'development survives');
  assert.equal(JSON.parse(f.git(['show', `${merged}:GalaxyXRDriverGUI/package.json`])).fixtureDevSetting,
    'preserve this nonversion field');
  assert.equal(fs.readFileSync(path.join(f.repo, cargo), 'utf8'), dirty);
  assert.equal(f.git(['show', '-s', '--format=%s', `${merged}^1`]), 'chore(release): v1.0.11');
  assert.equal(f.git(['show', '-s', '--format=%an|%cn', `${merged}^1`]), 'github-actions[bot]|github-actions[bot]');
  assert.equal(f.remoteDev(), merged);
  assertCleanScratch(f);
});

fixtureTest('real source conflicts fail without silently choosing main or dev', f => {
  f.git(['checkout', 'dev']);
  f.commit('tuning.txt', 'bandwidth=600\n', 'dev tuning');
  f.git(['push', 'origin', 'dev']);
  f.git(['checkout', 'main']);
  f.commit('tuning.txt', 'bandwidth=200\n', 'main tuning');
  const sha = release(f);
  const originalDev = f.remoteDev();
  assert.throws(() => f.sync(sha), error => {
    assert.match(error.message, /CONFLICT.*tuning.txt/);
    assert.match(error.message, /Backmerge scratch preserved at:/);
    return true;
  });
  assert.equal(f.remoteDev(), originalDev);
  const [scratch] = fs.readdirSync(f.scratchRoot);
  const worktree = path.join(f.scratchRoot, scratch, 'worktree');
  assert.match(fs.readFileSync(path.join(worktree, 'tuning.txt'), 'utf8'), /<<<<<<< HEAD[\s\S]*=======/);
  assert.match(f.git(['status', '--porcelain'], worktree), /UU tuning.txt/);
});

fixtureTest('only the exact published commit is merged when main advances again', f => {
  const sha = release(f);
  const future = f.commit('unreleased.txt', 'future work\n', 'later main work');
  f.git(['push', 'origin', 'main']);
  f.sync(sha);
  assert.equal(f.remoteDev(), sha);
  assert.notEqual(f.remoteDev(), future);
  assertCleanScratch(f);
});

fixtureTest('repeated sync preserves a dev tip that already contains the release', f => {
  const sha = release(f);
  f.sync(sha);
  f.git(['checkout', 'dev']);
  f.git(['merge', '--ff-only', 'origin/dev']);
  f.commit('dev-only.txt', 'new dev work\n', 'dev advances');
  const advanced = f.versionCommit('1.0.12-dev.1', 'intentional later prerelease');
  f.git(['push', 'origin', 'dev']);
  f.sync(sha);
  assert.equal(f.remoteDev(), advanced);
  assertPublishedVersion(f, advanced, '1.0.12-dev.1');
  f.sync(sha);
  assert.equal(f.remoteDev(), advanced);
  assertCleanScratch(f);
});

fixtureTest('ordinary push rejection fails visibly and preserves merge scratch', f => {
  const sha = release(f);
  const originalDev = f.remoteDev();
  fs.writeFileSync(path.join(f.remote, 'hooks/pre-receive'), '#!/bin/sh\necho "fixture rejects push" >&2\nexit 1\n', { mode: 0o755 });
  assert.throws(() => f.sync(sha), error => {
    assert.match(error.message, /fixture rejects push/);
    assert.match(error.message, /Backmerge scratch preserved at:/);
    return true;
  });
  assert.equal(f.remoteDev(), originalDev);
  const scratch = fs.readdirSync(f.scratchRoot);
  assert.equal(scratch.length, 1);
  assert.ok(fs.existsSync(path.join(f.scratchRoot, scratch[0], 'worktree/.git')));
});

fixtureTest('non-fast-forward caused by concurrent dev advancement rebuilds and retries safely', f => {
  const sha = release(f);
  const hook = advanceDevBeforePush(f);
  const merged = f.sync(sha).mergedCommit;
  assert.equal(fs.readFileSync(hook.attempts, 'utf8').trim(), '2');
  const concurrent = fs.readFileSync(hook.advanced, 'utf8').trim();
  f.git(['merge-base', '--is-ancestor', concurrent, merged]);
  f.git(['merge-base', '--is-ancestor', sha, merged]);
  assert.equal(f.remoteDev(), merged);
  assertPublishedVersion(f, merged);
  assertCleanScratch(f);
});

fixtureTest('continuous concurrent dev advancement stops after three ordinary push attempts', f => {
  const sha = release(f);
  const hook = advanceDevBeforePush(f, true);
  assert.throws(() => f.sync(sha), /Backmerge scratch preserved at:/);
  assert.equal(fs.readFileSync(hook.attempts, 'utf8').trim(), '3');
  assert.equal(f.remoteDev(), fs.readFileSync(hook.advanced, 'utf8').trim());
  assert.throws(() => f.git(['merge-base', '--is-ancestor', sha, f.remoteDev()]));
  assert.equal(fs.readdirSync(f.scratchRoot).length, 1);
});

fixtureTest('verification accepts dev advancing to a descendant immediately after the push', f => {
  const sha = release(f);
  fs.writeFileSync(path.join(f.remote, 'hooks/post-receive'), `#!/bin/sh
export GIT_AUTHOR_NAME=Fixture GIT_AUTHOR_EMAIL=fixture@example.invalid
export GIT_COMMITTER_NAME=Fixture GIT_COMMITTER_EMAIL=fixture@example.invalid
while read old new ref; do
  if [ "$ref" = refs/heads/dev ]; then
    tree=$(git rev-parse "$new^{tree}") || exit 1
    descendant=$(echo 'Concurrent dev advance' | git -c commit.gpgsign=false commit-tree "$tree" -p "$new") || exit 1
    git update-ref refs/heads/dev "$descendant" "$new" || exit 1
  fi
done
`, { mode: 0o755 });
  assert.equal(f.sync(sha).mergedCommit, sha);
  const advanced = f.remoteDev();
  assert.notEqual(advanced, sha);
  assert.equal(f.git(['rev-parse', `${advanced}^`], f.remote), sha);
  assert.equal(f.git(['rev-parse', 'origin/dev']), advanced);
  assertCleanScratch(f);
});

fixtureTest('a commit not published on main is rejected before creating a worktree or pushing', f => {
  const unpublished = f.commit('unpublished.txt', 'not released\n', 'unpublished');
  const originalDev = f.remoteDev();
  assert.throws(() => f.sync(unpublished));
  assert.equal(f.remoteDev(), originalDev);
  assert.equal(fs.existsSync(f.scratchRoot), false);
});

test('invalid release SHA is rejected before any Git operation', () => {
  for (const value of [undefined, '', 'main', 'a'.repeat(39), 'g'.repeat(40), '--help']) {
    assert.throws(() => backmergeRelease('nonexistent-fixture', value), /full 40-character Git commit SHA/);
  }
});
