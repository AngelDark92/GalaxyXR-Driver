'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

async function publishRelease({ repo, version, commit, directory, api }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^[a-f\d]{40}$/.test(commit) ||
      !/^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/.test(version)) throw new Error('Invalid release identity.');
  const tag = `v${version}`, base = `/repos/${repo}`;
  const prefix = `GalaxyXRDriver-v${version}-Windows-x64`;
  const files = [`${prefix}.zip`, `${prefix}.zip.sha256`].map(name => ({ name, data: fs.readFileSync(path.join(directory, name)) }));
  if (files.some(file => !file.data.length)) throw new Error('Empty release asset.');
  const hash = createHash('sha256').update(files[0].data).digest('hex');
  if (files[1].data.toString('utf8').trim() !== `${hash}  ${files[0].name}`) throw new Error('Release checksum does not match ZIP.');
  const notes = fs.readFileSync(path.join(directory, `${prefix}-release-notes.md`), 'utf8');
  // Pin the tag to the built commit; never move an existing release tag.
  const ref = await api('GET', `${base}/git/ref/tags/${tag}`, null, true);
  if (ref) {
    let object = ref.object;
    while (object.type === 'tag') object = (await api('GET', `${base}/git/tags/${object.sha}`)).object;
    if (object.type !== 'commit' || object.sha !== commit) throw new Error(`${tag} already points to another commit.`);
  } else await api('POST', `${base}/git/refs`, { ref: `refs/tags/${tag}`, sha: commit });

  let release = await api('GET', `${base}/releases/tags/${tag}`, null, true);
  // Tag lookup is documented for published releases. A writer can find an
  // interrupted draft through the paginated release list (2026-09-22).
  if (!release) {
    for (let page = 1; ; page++) {
      const releases = await api('GET', `${base}/releases?per_page=100&page=${page}`);
      release = releases.find(candidate => candidate.tag_name === tag);
      if (release || releases.length < 100) break;
    }
  }
  if (release && !release.draft) {
    if (!files.every(file => release.assets.some(asset => asset.name === file.name && asset.size > 0 && asset.state === 'uploaded'))) {
      throw new Error(`Published ${tag} is missing required assets; refusing to rewrite a published release.`);
    }
    return `Already published: ${release.html_url}`;
  }
  if (!release) release = await api('POST', `${base}/releases`, {
    tag_name: tag, target_commitish: commit, name: `Galaxy XR Companion ${tag}`,
    body: notes, draft: true, prerelease: version.includes('-'),
  });
  const upload = new URL(release.upload_url.split('{')[0]);
  if (upload.protocol !== 'https:' || upload.hostname !== 'uploads.github.com') throw new Error('Unexpected GitHub upload URL.');
  for (const file of files) {
    const old = release.assets.find(asset => asset.name === file.name);
    if (old) await api('DELETE', `${base}/releases/assets/${old.id}`);
    const url = new URL(upload); url.searchParams.set('name', file.name);
    await api('POST', url.href, file.data);
  }
  // Publish only after both uploads have succeeded; a failed attempt stays draft.
  release = await api('PATCH', `${base}/releases/${release.id}`, {
    body: notes, draft: false, prerelease: version.includes('-'),
  });
  return `Published: ${release.html_url}`;
}

function githubApi(token) {
  if (!token) throw new Error('GitHub token is required.');
  return async (method, route, body, missingOK = false) => {
    const binary = Buffer.isBuffer(body);
    const response = await fetch(route.startsWith('/') ? `https://api.github.com${route}` : route, {
      method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
        'Content-Type': binary ? 'application/octet-stream' : 'application/json', 'User-Agent': 'GalaxyXRDriver-release' },
      body: body == null ? undefined : binary ? body : JSON.stringify(body),
    });
    if (response.status === 404 && missingOK) return null;
    if (!response.ok) throw new Error(`GitHub ${method} ${new URL(response.url).pathname} failed (${response.status}).`);
    return response.status === 204 ? null : response.json();
  };
}

module.exports = { publishRelease };
if (require.main === module) {
  (async () => console.log(await publishRelease({ repo: process.env.GITHUB_REPOSITORY,
    version: process.env.RELEASE_VERSION, commit: process.env.RELEASE_COMMIT || process.env.GITHUB_SHA,
    directory: path.resolve(__dirname, '../../builds/GalaxyXR-Driver/release'), api: githubApi(process.env.GH_TOKEN) })))()
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
