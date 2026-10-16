'use strict';
const { fixtureRoot } = require('../lib/test-fixtures.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { bumpVersion } = require('../../bump-version.js');
const { verifyReleaseVersion } = require('../verify-release-version.cjs');
const { releasePolicy, planRelease, prepareRelease, persistRelease, nextVersion, changelogEntry, updateChangelog } = require('../release-policy.cjs');
const { publishRelease } = require('../publish-release.cjs');
const project = path.resolve(__dirname, '../..');
const files = ['GalaxyXRDriver/src/Config/Config.cpp', 'GalaxyXRDriver/DriverFiles/driver.vrdrivermanifest',
  ...['package.json', 'package-lock.json', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock'].map(f => `GalaxyXRDriverGUI/${f}`)];
function fixture(t) {
  const sandbox = fs.mkdtempSync(path.join(fixtureRoot(), 'GalaxyXR release '));
  const repo = path.join(sandbox, 'repo');
  fs.mkdirSync(repo);
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  for (const file of files) { fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); fs.copyFileSync(path.join(project, file), path.join(repo, file)); }
  // Fixtures must be version-independent (2026-10-13): the dev branch carries
  // the dev channel's -dev.N version, so pin a known stable baseline.
  bumpVersion(repo, '1.2.4');
  return repo;
}
test('one bump updates all eight version fields without changing dependency versions', t => {
  const repo = fixture(t);
  const lock = JSON.parse(fs.readFileSync(path.join(repo, files[3])));
  const cargo = fs.readFileSync(path.join(repo, files[6]), 'utf8');
  assert.equal(bumpVersion(repo, '9.8.7-beta.1').length, 7);
  assert.equal(verifyReleaseVersion(repo, { tag: 'v9.8.7-beta.1' }).version, '9.8.7-beta.1');
  const after = JSON.parse(fs.readFileSync(path.join(repo, files[3])));
  delete lock.packages['']; delete after.packages[''];
  assert.deepEqual(after.packages, lock.packages);
  const dependencies = text => text.split(/(?=^\[\[package\]\])/m).filter(s => /^source\s*=/m.test(s));
  assert.deepEqual(dependencies(fs.readFileSync(path.join(repo, files[6]), 'utf8')), dependencies(cargo));
});
test('invalid bump and inconsistent inputs leave every file untouched', t => {
  const repo = fixture(t);
  fs.appendFileSync(path.join(repo, files[0]), '\nstd::string driverVersion = "bad";\n');
  const before = files.map(f => fs.readFileSync(path.join(repo, f)));
  assert.throws(() => bumpVersion(repo, '../bad'), /Invalid version/);
  assert.throws(() => bumpVersion(repo, '9.8.7'), /exactly one/);
  files.forEach((f,i) => assert.deepEqual(fs.readFileSync(path.join(repo, f)), before[i]));
});
test('only main version changes, matching tag pushes, and explicit main retries publish', () => {
  const base = { eventName: 'push', ref: 'refs/heads/main', version: '1.2.1', previousVersion: '1.2.0' };
  assert.equal(releasePolicy(base).publish, true);
  assert.equal(releasePolicy({ ...base, previousVersion: '1.2.1' }).publish, false);
  assert.equal(releasePolicy({ ...base, ref: 'refs/heads/feature' }).publish, false);
  assert.equal(releasePolicy({ ...base, eventName: 'pull_request' }).publish, false);
  assert.equal(releasePolicy({ ...base, eventName: 'workflow_dispatch' }).publish, false);
  assert.equal(releasePolicy({ ...base, eventName: 'workflow_dispatch', manualPublish: true }).publish, true);
  assert.equal(releasePolicy({ ...base, ref: 'refs/heads/feature', eventName: 'workflow_dispatch', manualPublish: true }).publish, false);
  assert.equal(releasePolicy({ ...base, ref: 'refs/tags/v1.2.1' }).publish, true);
  assert.throws(() => releasePolicy({ ...base, ref: 'refs/tags/v1.2.0' }), /Tag does not match/);
});
test('main compares against the entire push base, including multi-commit pushes', t => {
  const repo = fixture(t);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '--quiet'); git('add', '.');
  git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','--quiet','-m','Initial');
  const before = git('rev-parse','HEAD');
  const env = { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main' };
  assert.equal(planRelease(repo, env, { before }).publish, false);
  bumpVersion(repo, '9.8.7');
  assert.equal(planRelease(repo, env, { before }).publish, true);
  assert.throws(() => planRelease(repo, env, {}), /Missing release tag or push base/);
});

function history(t, version = '1.2.4', changelog = `# Changelog\n\n## [${version}] - 2026-09-23\n\nExisting authored history.\n`) {
  const repo = fixture(t);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '--quiet', '--initial-branch=main');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  bumpVersion(repo, version);
  if (changelog !== null) fs.writeFileSync(path.join(repo, 'CHANGELOG.md'), changelog);
  let sequence = 0;
  const commit = subject => {
    fs.writeFileSync(path.join(repo, 'source.txt'), String(++sequence));
    git('add', '.'); git('commit', '--quiet', '-m', subject);
    return git('rev-parse', 'HEAD');
  };
  const before = commit('Initial release'); git('tag', `v${version}`);
  return { repo, git, commit, before, env: { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main' } };
}

test('a stale 1.2.13 feature commit advances from published 1.2.14 and restores its missing notes', t => {
  const f = history(t, '1.2.14');
  bumpVersion(f.repo, '1.2.13');
  fs.writeFileSync(path.join(f.repo, 'CHANGELOG.md'), '# Changelog\n\nCurrent introduction.\n\n## [1.2.13] - 2026-09-22\n\nOlder history.\n');
  const source = f.commit('feat: improve settings recovery and refresh Companion UI');
  const plan = prepareRelease(f.repo, f.env, {});
  assert.equal(plan.version, '1.3.0');
  assert.equal(verifyReleaseVersion(f.repo).version, '1.3.0');
  const text = fs.readFileSync(path.join(f.repo, 'CHANGELOG.md'), 'utf8');
  assert.match(text, /Existing authored history/);
  assert.deepEqual([...text.matchAll(/^## \[([^\]]+)\]/gm)].map(m => m[1]), ['1.3.0', '1.2.14', '1.2.13']);
  assert.equal(f.git('rev-parse', 'v1.2.14'), f.before);
  f.git('tag', plan.tag);
  const retry = prepareRelease(f.repo, { ...f.env, GITHUB_EVENT_NAME: 'workflow_dispatch' }, { inputs: { publish: true } });
  assert.equal(retry.commit, plan.commit); assert.equal(retry.generated, false);
  f.git('checkout', '--quiet', '--detach', source);
  const repeated = prepareRelease(f.repo, f.env, {});
  assert.equal(repeated.commit, plan.commit);
  assert.equal(fs.readFileSync(path.join(f.repo, 'CHANGELOG.md'), 'utf8'), text);
});

for (const manual of [false, true]) {
  for (const [type, expected] of [['fix', '1.2.15'], ['feat', '1.3.0'], ['rework', '2.0.0'], ['docs', null]]) {
    test(`stale stable metadata follows the released baseline for ${type} on ${manual ? 'explicit manual retry' : 'push'}`, t => {
      const f = history(t, '1.2.14');
      bumpVersion(f.repo, '1.2.13');
      const source = f.commit(`${type}: changed source with reverted metadata`);
      const env = manual ? { ...f.env, GITHUB_EVENT_NAME: 'workflow_dispatch' } : f.env;
      const event = manual ? { inputs: { publish: true } } : {};
      if (manual && !expected) {
        assert.throws(() => prepareRelease(f.repo, env, event), /No new release version/);
      } else {
        const plan = prepareRelease(f.repo, env, event);
        assert.equal(plan.publish, Boolean(expected));
        assert.equal(plan.generated, Boolean(expected));
        assert.equal(plan.version, expected || '1.2.13');
        if (expected) assert.equal(verifyReleaseVersion(f.repo, { tag: `v${expected}` }).version, expected);
      }
      if (!expected) {
        assert.equal(f.git('rev-parse', 'HEAD'), source);
        assert.equal(verifyReleaseVersion(f.repo).version, '1.2.13');
        assert.equal(fs.readFileSync(path.join(f.repo, 'CHANGELOG.md'), 'utf8'), f.git('show', 'v1.2.14:CHANGELOG.md') + '\n');
      }
      assert.equal(f.git('rev-parse', 'v1.2.14'), f.before);
      assert.equal(f.git('status', '--porcelain'), '');
    });
  }
}

test('stale metadata ignores unrelated higher tags while an explicit higher version remains authoritative', t => {
  const f = history(t, '1.2.14');
  f.git('checkout', '--quiet', '-b', 'unrelated'); f.commit('unreleased branch'); f.git('tag', 'v99.0.0');
  f.git('checkout', '--quiet', 'main');
  bumpVersion(f.repo, '1.2.13'); f.commit('fix: correct reverted source');
  assert.equal(planRelease(f.repo, f.env, {}).version, '1.2.15');
  bumpVersion(f.repo, '1.4.7'); f.commit('rework: deliberately overridden version');
  const plan = prepareRelease(f.repo, f.env, {});
  assert.equal(plan.version, '1.4.7');
  assert.equal(verifyReleaseVersion(f.repo).version, '1.4.7');
});

test('missing published changelog sections merge around authored future and historical entries', t => {
  const published = '# Published introduction.\n\n' +
    '## [1.2.14] - 2026-09-26\n\nPublished newest notes.\n\n' +
    '## [1.2.13] - 2026-09-25\n\nOriginal older notes.\n\n' +
    '## [1.2.12] - 2026-09-24\n\nPublished oldest notes.\n';
  const f = history(t, '1.2.14', published);
  const intro = '# Current introduction.\n\nKeep these custom links and guidance.\n\n';
  const future = '## [1.3.0] - 2026-09-27\n\nHandwritten future release.\n\n';
  const older = '## [1.2.13] - 2026-09-25\n\nCorrected authored older notes.\n\n';
  const oldest = '## [1.2.11] - 2026-09-23\n\nCurrent oldest notes.\n';
  fs.writeFileSync(path.join(f.repo, 'CHANGELOG.md'), intro + future + older + oldest);
  bumpVersion(f.repo, '1.2.13'); f.commit('feat: generate release with restored history');
  const plan = prepareRelease(f.repo, f.env, {});
  const text = fs.readFileSync(path.join(f.repo, 'CHANGELOG.md'), 'utf8');
  assert.equal(plan.version, '1.3.0');
  assert.ok(text.startsWith(intro + future));
  assert.ok(text.includes(older)); assert.ok(text.endsWith(oldest));
  assert.match(text, /Published newest notes/); assert.match(text, /Published oldest notes/);
  assert.doesNotMatch(text, /Published introduction|Original older notes|generate release with restored history/);
  assert.deepEqual([...text.matchAll(/^## \[([^\]]+)\]/gm)].map(m => m[1]), ['1.3.0', '1.2.14', '1.2.13', '1.2.12', '1.2.11']);
});

test('release tags predating CHANGELOG.md preserve current authored history without invented recovery', t => {
  const f = history(t, '1.2.14', null);
  const authored = '# Changelog\n\n## [1.2.13] - 2026-09-25\n\nCurrent authored notes.\n';
  fs.writeFileSync(path.join(f.repo, 'CHANGELOG.md'), authored);
  bumpVersion(f.repo, '1.2.13'); f.commit('fix: add initial changelog');
  const plan = prepareRelease(f.repo, f.env, {});
  const text = fs.readFileSync(path.join(f.repo, 'CHANGELOG.md'), 'utf8');
  assert.equal(plan.version, '1.2.15');
  assert.ok(text.endsWith(authored.slice(authored.indexOf('## ['))));
  assert.deepEqual([...text.matchAll(/^## \[([^\]]+)\]/gm)].map(m => m[1]), ['1.2.15', '1.2.13']);
});

test('stale metadata never absorbs dirty edits while recovering release history', t => {
  const f = history(t, '1.2.14');
  bumpVersion(f.repo, '1.2.13'); f.commit('fix: source metadata was reverted');
  fs.writeFileSync(path.join(f.repo, 'private.txt'), 'Unrelated local edit');
  assert.throws(() => prepareRelease(f.repo, f.env, {}), /clean checkout/);
  assert.equal(verifyReleaseVersion(f.repo).version, '1.2.13');
  assert.equal(fs.readFileSync(path.join(f.repo, 'private.txt'), 'utf8'), 'Unrelated local edit');
});
test('project commit policy uses patch for fixes, minor for features and major for reworks', () => {
  const next = (...subjects) => nextVersion('1.2.4', subjects.map(subject => ({ subject })));
  assert.equal(next('fix: first', 'fix(gui): second'), '1.2.5');
  assert.equal(next('feat: first'), '1.3.0');
  assert.equal(next('fix: first', 'feat(gui)!: second'), '1.3.0');
  assert.equal(next('rework: redesign'), '2.0.0');
  assert.equal(next('fix: first', 'rework(gui): redesign', 'feat: second'), '2.0.0');
  assert.equal(next('rework(gui)!: redesign', 'fix: second'), '2.0.0');
  assert.equal(next('docs: mention feat: here', 'prefix fix: irrelevant', 'chore: cleanup'), '1.2.4');
});
test('main generates synchronized versions and a changelog from all unreleased commits', t => {
  const f = history(t);
  const first = f.commit('fix(gui): collapse on the first click');
  f.commit('docs: explain controls'); f.commit('fix: remove warning');
  const plan = prepareRelease(f.repo, f.env, { before: first });
  assert.equal(plan.version, '1.2.5'); assert.equal(plan.generated, true); assert.equal(plan.publish, true);
  assert.equal(verifyReleaseVersion(f.repo).version, '1.2.5');
  const text = fs.readFileSync(path.join(f.repo, 'CHANGELOG.md'), 'utf8');
  assert.match(text, /## \[1\.2\.5\]/); assert.match(text, /gui: collapse on the first click/);
  assert.match(text, /remove warning/); assert.match(text, /docs: explain controls/);
  assert.match(text, /Existing authored history/); assert.doesNotMatch(text, /Icon credits|Vilkka/);
  assert.equal(f.git('status', '--porcelain'), '');
  assert.deepEqual(f.git('diff-tree', '--no-commit-id', '--name-only', '-r', plan.commit).split('\n').sort(), [...files, 'CHANGELOG.md'].sort());
});
test('a feat wins over fixes and unrelated tags never set the release baseline', t => {
  const f = history(t);
  f.git('checkout', '--quiet', '-b', 'unrelated'); f.commit('unreleased branch'); f.git('tag', 'v99.0.0');
  f.git('checkout', '--quiet', 'main');
  f.commit('feat: add feature'); f.commit('fix: correct it');
  assert.equal(prepareRelease(f.repo, f.env, { before: f.before }).version, '1.3.0');
});
test('a rework wins over features and fixes and gets its own changelog group', t => {
  const f = history(t);
  f.commit('feat: new control'); f.commit('rework(gui): redesign settings'); f.commit('fix: repair validation');
  const plan = prepareRelease(f.repo, f.env, {});
  assert.equal(plan.version, '2.0.0');
  assert.equal(verifyReleaseVersion(f.repo).version, '2.0.0');
  const text = fs.readFileSync(path.join(f.repo, 'CHANGELOG.md'), 'utf8');
  assert.match(text, /### Reworks\n\n- gui: redesign settings/);
  assert.match(text, /### Features\n\n- new control/);
  assert.match(text, /### Fixes\n\n- repair validation/);
});
test('docs-only changes, feature branches, pull requests and default manual runs do not mutate or publish', t => {
  const f = history(t); f.commit('docs: update guide');
  assert.equal(prepareRelease(f.repo, f.env, {}).publish, false);
  f.commit('feat: new control');
  for (const env of [{ ...f.env, GITHUB_REF: 'refs/heads/feature' },
    { ...f.env, GITHUB_EVENT_NAME: 'pull_request' }, { ...f.env, GITHUB_EVENT_NAME: 'workflow_dispatch' }]) {
    const plan = prepareRelease(f.repo, env, {});
    assert.equal(plan.publish, false); assert.equal(plan.generated, false); assert.equal(plan.version, '1.2.4');
  }
  assert.equal(f.git('status', '--porcelain'), '');
});
test('rerunning the source recreates the exact release commit and retrying persisted metadata reuses it', t => {
  const f = history(t); const source = f.commit('fix: repair startup');
  const plan = prepareRelease(f.repo, f.env, {});
  f.git('tag', plan.tag);
  const retryEnv = { ...f.env, GITHUB_EVENT_NAME: 'workflow_dispatch' };
  const persisted = prepareRelease(f.repo, retryEnv, { inputs: { publish: true } });
  assert.equal(persisted.commit, plan.commit); assert.equal(persisted.generated, false);
  f.git('checkout', '--quiet', '--detach', source);
  const again = prepareRelease(f.repo, f.env, {});
  assert.equal(again.commit, plan.commit);
  assert.equal((fs.readFileSync(path.join(f.repo, 'CHANGELOG.md'), 'utf8').match(/## \[1\.2\.5\]/g) || []).length, 1);
});
test('manual version overrides remain usable and authored entries are preserved', t => {
  const f = history(t); bumpVersion(f.repo, '1.2.5');
  f.commit('fix: manual hotfix version');
  const plan = prepareRelease(f.repo, f.env, {});
  assert.equal(plan.version, '1.2.5');
  assert.match(fs.readFileSync(path.join(f.repo, 'CHANGELOG.md'), 'utf8'), /manual hotfix version/);
  const authored = '# Changelog\n\n## [1.2.5] - 2026-09-23\n\nHandwritten release notes.\n';
  assert.equal(updateChangelog(authored, 'replacement', '1.2.5'), authored);
});
test('existing tagged releases retry without creating a different commit for the same version', t => {
  const f = history(t);
  const env = { ...f.env, GITHUB_EVENT_NAME: 'workflow_dispatch' };
  assert.equal(prepareRelease(f.repo, env, { inputs: { publish: true } }).commit, f.before);
  f.commit('docs: only documentation');
  assert.throws(() => prepareRelease(f.repo, env, { inputs: { publish: true } }), /No new release version/);
});
test('dirty worktrees cannot be absorbed into automatic metadata commits', t => {
  const f = history(t); f.commit('fix: startup');
  fs.writeFileSync(path.join(f.repo, 'unrelated.txt'), 'private local edit');
  assert.throws(() => prepareRelease(f.repo, f.env, {}), /clean checkout/);
  assert.equal(verifyReleaseVersion(f.repo).version, '1.2.4');
});
test('manual prereleases can be prepared and retried without moving a published tag', t => {
  const f = history(t); bumpVersion(f.repo, '2.0.0-beta.1'); f.commit('feat: preview feature');
  const plan = prepareRelease(f.repo, f.env, {});
  assert.equal(plan.version, '2.0.0-beta.1');
  f.git('tag', plan.tag);
  const retry = prepareRelease(f.repo, { ...f.env, GITHUB_EVENT_NAME: 'workflow_dispatch' }, { inputs: { publish: true } });
  assert.equal(retry.commit, plan.commit); assert.equal(retry.generated, false);
  f.commit('fix: more preview changes');
  assert.throws(() => prepareRelease(f.repo, f.env, {}), /already tagged prerelease/);
});
test('commit subjects remain literal changelog text', () => {
  const text = changelogEntry('1.3.0', '2026-09-23', [{ hash: 'a'.repeat(40), subject: 'fix: <script> and [link](bad) `code`' }]);
  assert.ok(text.includes('\\<script\\>')); assert.ok(text.includes('\\[link\\]')); assert.ok(text.includes('\\`code\\`'));
});
function remote(t, f, branch = 'main') {
  const directory = fs.mkdtempSync(path.join(fixtureRoot(), 'GalaxyXR release remote '));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  f.git('init', '--quiet', '--bare', directory); f.git('remote', 'add', 'origin', directory);
  f.git('push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`);
  return directory;
}
test('verified metadata fast-forwards main once and persistence is idempotent', t => {
  const f = history(t); f.commit('fix: publish'); remote(t, f);
  const plan = prepareRelease(f.repo, f.env, {});
  assert.equal(persistRelease(f.repo, plan, f.env.GITHUB_REF), true);
  assert.equal(f.git('ls-remote', 'origin', 'refs/heads/main').split(/\s/)[0], plan.commit);
  assert.equal(persistRelease(f.repo, plan, f.env.GITHUB_REF), true);
});
test('a newer main push suppresses stale publication and its next run includes every unreleased change', t => {
  const f = history(t); const source = f.commit('fix: first repair'); remote(t, f);
  const plan = prepareRelease(f.repo, f.env, {});
  f.git('checkout', '--quiet', '--detach', source);
  const newer = f.commit('feat: new feature'); f.git('push', '--quiet', 'origin', 'HEAD:refs/heads/main');
  f.git('checkout', '--quiet', '--detach', plan.commit);
  assert.equal(persistRelease(f.repo, plan, f.env.GITHUB_REF), false);
  assert.equal(f.git('ls-remote', 'origin', 'refs/heads/main').split(/\s/)[0], newer);
  f.git('checkout', '--quiet', '--detach', newer);
  const next = prepareRelease(f.repo, f.env, {});
  assert.equal(next.version, '1.3.0'); assert.equal(next.commits.length, 2);
});
// Dev release channel (2026-10-13): dev publishes X.Y.Z-dev.N prereleases and
// main promotes the merged dev series to the stable X.Y.Z release.
test('dev prepares the first prerelease of a new series and tags it', t => {
  const f = history(t);
  const dev = { ...f.env, GITHUB_REF: 'refs/heads/dev' };
  f.commit('feat: start the dev series');
  const plan = planRelease(f.repo, dev, {});
  assert.equal(plan.version, '1.3.0-dev.1'); assert.equal(plan.tag, 'v1.3.0-dev.1');
  assert.equal(plan.baseTag, 'v1.2.4'); assert.equal(plan.publish, true);
  const released = prepareRelease(f.repo, dev, {});
  assert.equal(released.generated, true); assert.equal(released.publish, true);
  assert.equal(verifyReleaseVersion(f.repo).version, '1.3.0-dev.1');
  assert.match(fs.readFileSync(path.join(f.repo, 'CHANGELOG.md'), 'utf8'), /## \[1\.3\.0-dev\.1\]/);
  assert.deepEqual(f.git('diff-tree', '--no-commit-id', '--name-only', '-r', released.commit).split('\n').sort(),
    [...files, 'CHANGELOG.md'].sort());
  f.git('tag', released.tag);
});
test('dev continuation increments the prerelease counter and skips unreleasable pushes', t => {
  const f = history(t);
  const dev = { ...f.env, GITHUB_REF: 'refs/heads/dev' };
  f.commit('feat: start the dev series');
  let plan = prepareRelease(f.repo, dev, {});
  assert.equal(plan.version, '1.3.0-dev.1'); f.git('tag', plan.tag);
  f.commit('fix: follow-up repair');
  plan = prepareRelease(f.repo, dev, {});
  assert.equal(plan.version, '1.3.0-dev.2'); assert.equal(plan.publish, true); assert.equal(plan.generated, true);
  assert.equal(verifyReleaseVersion(f.repo).version, '1.3.0-dev.2');
  f.git('tag', plan.tag);
  const source = f.commit('docs: notes only');
  const changelog = fs.readFileSync(path.join(f.repo, 'CHANGELOG.md'), 'utf8');
  const skipped = prepareRelease(f.repo, dev, {});
  assert.equal(skipped.publish, false); assert.equal(skipped.generated, false);
  assert.equal(skipped.version, '1.3.0-dev.2');
  assert.equal(f.git('rev-parse', 'HEAD'), source);
  assert.equal(fs.readFileSync(path.join(f.repo, 'CHANGELOG.md'), 'utf8'), changelog);
});
test('a dev push without releasable commits keeps the stable version and files', t => {
  const f = history(t);
  const dev = { ...f.env, GITHUB_REF: 'refs/heads/dev' };
  const source = f.commit('chore: refresh tooling notes');
  const plan = prepareRelease(f.repo, dev, {});
  assert.equal(plan.publish, false); assert.equal(plan.generated, false); assert.equal(plan.version, '1.2.4');
  assert.equal(f.git('rev-parse', 'HEAD'), source);
  assert.equal(verifyReleaseVersion(f.repo).version, '1.2.4');
  assert.equal(f.git('status', '--porcelain'), '');
});
test('main promotes a merged dev series to the stable release and retries it intact', t => {
  const f = history(t);
  const dev = { ...f.env, GITHUB_REF: 'refs/heads/dev' };
  f.commit('feat: start the dev series');
  let plan = prepareRelease(f.repo, dev, {}); f.git('tag', plan.tag);
  f.commit('fix: follow-up repair');
  plan = prepareRelease(f.repo, dev, {}); f.git('tag', plan.tag);
  f.commit('docs: notes only');
  const promotion = planRelease(f.repo, f.env, {});
  assert.equal(promotion.version, '1.3.0'); assert.equal(promotion.tag, 'v1.3.0'); assert.equal(promotion.publish, true);
  const released = prepareRelease(f.repo, f.env, {});
  assert.equal(released.version, '1.3.0'); assert.equal(released.generated, true);
  assert.equal(verifyReleaseVersion(f.repo).version, '1.3.0');
  assert.match(fs.readFileSync(path.join(f.repo, 'CHANGELOG.md'), 'utf8'), /## \[1\.3\.0\]/);
  const retry = prepareRelease(f.repo, { ...f.env, GITHUB_EVENT_NAME: 'workflow_dispatch' }, { inputs: { publish: true } });
  assert.equal(retry.publish, true); assert.equal(retry.generated, false); assert.equal(retry.commit, released.commit);
});
test('advancing the dev series base resets the counter', t => {
  const f = history(t);
  const dev = { ...f.env, GITHUB_REF: 'refs/heads/dev' };
  f.git('checkout', '--quiet', '-b', 'dev');
  f.commit('feat: start the dev series');
  let plan = prepareRelease(f.repo, dev, {}); f.git('tag', plan.tag);
  f.commit('fix: follow-up repair');
  plan = prepareRelease(f.repo, dev, {}); f.git('tag', plan.tag);
  assert.equal(plan.version, '1.3.0-dev.2');
  // main promotes the series and ships v1.3.0, but the backmerge has not
  // reached dev: the stable tag is unreachable from the dev series.
  f.git('checkout', '--quiet', 'main');
  f.git('merge', '--quiet', '--no-ff', '-m', 'Feat: Merge pull request #2 from AngelDark92/dev', 'dev');
  f.git('tag', 'v1.3.0');
  f.git('checkout', '--quiet', 'dev');
  f.commit('feat: a feature after the promotion');
  plan = prepareRelease(f.repo, dev, {});
  assert.equal(plan.version, '1.4.0-dev.1'); assert.equal(plan.tag, 'v1.4.0-dev.1'); assert.equal(plan.publish, true);
  f.git('tag', plan.tag);
  f.commit('fix: another repair in the new series');
  plan = prepareRelease(f.repo, dev, {});
  assert.equal(plan.version, '1.4.0-dev.2');
});
test('a dev series continues past a shipped stable instead of renumbering it', t => {
  const f = history(t);
  const dev = { ...f.env, GITHUB_REF: 'refs/heads/dev' };
  f.git('checkout', '--quiet', '-b', 'dev');
  f.commit('feat: start the dev series');
  const plan = prepareRelease(f.repo, dev, {}); f.git('tag', plan.tag);
  assert.equal(plan.version, '1.3.0-dev.1');
  f.git('checkout', '--quiet', 'main');
  f.git('merge', '--quiet', '--no-ff', '-m', 'Feat: Merge pull request #2 from AngelDark92/dev', 'dev');
  f.git('tag', 'v1.3.0');
  f.git('checkout', '--quiet', 'dev');
  f.commit('fix: repair while main already shipped the base');
  const next = prepareRelease(f.repo, dev, {});
  assert.equal(next.version, '1.3.1-dev.1'); assert.equal(next.tag, 'v1.3.1-dev.1');
  assert.equal(next.baseTag, 'v1.3.0'); assert.equal(next.publish, true);
  assert.equal(verifyReleaseVersion(f.repo).version, '1.3.1-dev.1');
});
test('manual non-dev prereleases still refuse to republish their tagged version', t => {
  const f = history(t); bumpVersion(f.repo, '2.0.0-rc.1'); f.commit('feat: preview feature');
  const plan = prepareRelease(f.repo, f.env, {});
  assert.equal(plan.version, '2.0.0-rc.1');
  f.git('tag', plan.tag);
  f.commit('fix: more preview changes');
  assert.throws(() => prepareRelease(f.repo, f.env, {}), /already tagged prerelease/);
});
test('verified dev metadata fast-forwards the dev branch once and persistence is idempotent', t => {
  const f = history(t); f.commit('fix: publish dev prerelease'); remote(t, f, 'dev');
  const dev = { ...f.env, GITHUB_REF: 'refs/heads/dev' };
  const plan = prepareRelease(f.repo, dev, {});
  assert.equal(plan.version, '1.2.5-dev.1'); assert.equal(plan.publish, true); assert.equal(plan.generated, true);
  assert.equal(persistRelease(f.repo, plan, dev.GITHUB_REF), true);
  assert.equal(f.git('ls-remote', 'origin', 'refs/heads/dev').split(/\s/)[0], plan.commit);
  assert.equal(persistRelease(f.repo, plan, dev.GITHUB_REF), true);
});
test('workflow CLI exports the prepared SHA and persists it through the separate post-build step', t => {
  const f = history(t);
  for (const file of ['tools/release-policy.cjs', 'tools/verify-release-version.cjs', 'bump-version.js']) {
    fs.mkdirSync(path.dirname(path.join(f.repo, file)), { recursive: true });
    fs.copyFileSync(path.join(project, file), path.join(f.repo, file));
  }
  f.commit('fix: exercise workflow environment'); remote(t, f);
  const event = path.join(f.repo, '.git/event.json'), output = path.join(f.repo, '.git/output'), environment = path.join(f.repo, '.git/environment');
  fs.writeFileSync(event, JSON.stringify({ before: f.before }));
  const env = { ...process.env, ...f.env, GITHUB_EVENT_PATH: event, GITHUB_OUTPUT: output, GITHUB_ENV: environment };
  const cli = path.join(f.repo, 'tools/release-policy.cjs');
  execFileSync(process.execPath, [cli], { cwd: f.repo, env, windowsHide: true });
  const exported = Object.fromEntries(fs.readFileSync(environment, 'utf8').trim().split('\n').map(line => line.split('=')));
  assert.equal(exported.RELEASE_VERSION, '1.2.5'); assert.equal(exported.RELEASE_GENERATED, 'true');
  assert.equal(exported.RELEASE_COMMIT, f.git('rev-parse', 'HEAD'));
  execFileSync(process.execPath, [cli, '--persist'], { cwd: f.repo, env: { ...env, ...exported }, windowsHide: true });
  assert.equal(f.git('ls-remote', 'origin', 'refs/heads/main').split(/\s/)[0], exported.RELEASE_COMMIT);
});
test('PowerShell packages the generated changelog once and keeps icon credits in CREDITS.md', { skip: process.platform !== 'win32' }, t => {
  const f = history(t); f.commit('fix: first click collapses');
  const plan = prepareRelease(f.repo, f.env, {});
  for (const file of ['tools/Package-GitHubRelease.ps1', 'tools/Verify-ReleaseVersion.ps1', 'tools/verify-release-version.cjs', 'CREDITS.md']) {
    fs.mkdirSync(path.dirname(path.join(f.repo, file)), { recursive: true });
    fs.copyFileSync(path.join(project, file), path.join(f.repo, file));
  }
  const staging = path.join(f.repo, 'staging');
  for (const [file, content] of [
    ['GalaxyXRDriverGUI/Galaxy XR Companion.exe', 'test fixture, not an executable'],
    ['GalaxyXRNative/bin/win64/driver_GalaxyXRNative.dll', 'test fixture, not a DLL'],
    ['GalaxyXRNative/driver.vrdrivermanifest', JSON.stringify({ name: 'GalaxyXRNative', version: plan.version })],
    ['GalaxyXRNative/resources/settings/default.vrsettings', '{}']]) {
    fs.mkdirSync(path.dirname(path.join(staging, file)), { recursive: true });
    fs.writeFileSync(path.join(staging, file), content);
  }
  // Node does not perform PowerShell's cross-edition environment cleanup.
  // Let each host discover its own standard modules (especially Get-FileHash).
  const packageEnv = { ...process.env };
  for (const key of Object.keys(packageEnv)) if (key.toLowerCase() === 'psmodulepath') delete packageEnv[key];
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(f.repo, 'tools/Package-GitHubRelease.ps1'),
    '-Version', plan.version, '-Commit', plan.commit, '-StagingDirectory', staging], { cwd: f.repo, env: packageEnv, windowsHide: true });
  const prefix = `GalaxyXRDriver-v${plan.version}-Windows-x64`;
  const notes = fs.readFileSync(path.join(f.repo, '../builds/GalaxyXR-Driver/release', `${prefix}-release-notes.md`), 'utf8');
  assert.equal((notes.match(/first click collapses/g) || []).length, 1);
  assert.doesNotMatch(notes, /Icon credits|Vilkka|Existing authored history/);
  assert.match(fs.readFileSync(path.join(f.repo, '../builds/GalaxyXR-Driver/build/github-release', prefix, 'CREDITS.md'), 'utf8'), /Vilkka/);
  const zip = fs.readFileSync(path.join(f.repo, '../builds/GalaxyXR-Driver/release', `${prefix}.zip`));
  assert.equal(fs.readFileSync(path.join(f.repo, '../builds/GalaxyXR-Driver/release', `${prefix}.zip.sha256`), 'utf8').trim(),
    `${createHash('sha256').update(zip).digest('hex')}  ${prefix}.zip`);
});
function publishing(t, options = {}) {
  const directory = fixture(t), version = '1.2.1', commit = 'a'.repeat(40), calls = [];
  const prefix = 'GalaxyXRDriver-v1.2.1-Windows-x64';
  const zip = Buffer.from('test ZIP fixture');
  fs.writeFileSync(path.join(directory, `${prefix}.zip`), zip);
  fs.writeFileSync(path.join(directory, `${prefix}.zip.sha256`), `${createHash('sha256').update(zip).digest('hex')}  ${prefix}.zip\n`);
  fs.writeFileSync(path.join(directory, `${prefix}-release-notes.md`), 'Release fixture');
  const release = { id: 42, tag_name: 'v1.2.1', draft: true, assets: [], html_url: 'https://github.com/owner/repo/releases/tag/v1.2.1',
    upload_url: 'https://uploads.github.com/repos/owner/repo/releases/42/assets{?name,label}', ...options.release };
  const api = async (method, route, body) => {
    calls.push({ method, route, body });
    if (route.includes('/git/ref/')) return options.ref || null;
    if (route.includes('/releases/tags/')) return options.release && !release.draft ? release : null;
    if (route.includes('/releases?')) return options.release ? [release] : [];
    if (route.startsWith('https://uploads.')) { if (options.uploadFails) throw new Error('Upload interrupted'); return {}; }
    if (method === 'PATCH') return { ...release, draft: false };
    return release;
  };
  return { args: { repo: 'owner/repo', version, commit, directory, api }, calls, prefix };
}
test('publication pins the built SHA and publishes only after both assets upload', async t => {
  const f = publishing(t); await publishRelease(f.args);
  assert.deepEqual(f.calls.find(c => c.route.endsWith('/git/refs')).body, { ref: 'refs/tags/v1.2.1', sha: f.args.commit });
  assert.equal(f.calls.find(c => c.method === 'POST' && c.route.endsWith('/releases')).body.draft, true);
  assert.equal(f.calls.filter(c => c.route.startsWith('https://uploads.')).length, 2);
  assert.equal(f.calls.at(-1).method, 'PATCH'); assert.equal(f.calls.at(-1).body.draft, false);
});
test('upload failure leaves a draft and a later retry can finish it', async t => {
  const fail = publishing(t, { uploadFails: true });
  await assert.rejects(publishRelease(fail.args), /Upload interrupted/);
  assert.equal(fail.calls.some(c => c.method === 'PATCH'), false);
  const retry = publishing(t, { ref: { object: { type: 'commit', sha: 'a'.repeat(40) } },
    release: { assets: [{ id: 1, name: 'GalaxyXRDriver-v1.2.1-Windows-x64.zip' }] } });
  await publishRelease(retry.args);
  assert.ok(retry.calls.some(c => c.route.includes('/releases?')));
  assert.equal(retry.calls.some(c => c.method === 'POST' && c.route.endsWith('/releases')), false);
  assert.equal(retry.calls.filter(c => c.method === 'DELETE').length, 1);
  assert.equal(retry.calls.at(-1).body.draft, false);
});
test('reruns preserve published releases and never move a conflicting tag', async t => {
  const assets = ['.zip', '.zip.sha256'].map(ext => ({ name: `GalaxyXRDriver-v1.2.1-Windows-x64${ext}`, size: 12, state: 'uploaded' }));
  const f = publishing(t, { ref: { object: { type: 'commit', sha: 'a'.repeat(40) } }, release: { draft: false, assets } });
  assert.match(await publishRelease(f.args), /Already published/);
  assert.ok(f.calls.every(c => c.method === 'GET'));
  const conflict = publishing(t, { ref: { object: { type: 'commit', sha: 'b'.repeat(40) } } });
  await assert.rejects(publishRelease(conflict.args), /another commit/);
  assert.ok(conflict.calls.every(c => c.method === 'GET'));
});
test('bad checksum is rejected before making any GitHub request', async t => {
  const f = publishing(t); fs.appendFileSync(path.join(f.args.directory, `${f.prefix}.zip`), 'corrupt');
  await assert.rejects(publishRelease(f.args), /checksum/); assert.equal(f.calls.length, 0);
});
