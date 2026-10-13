# GitHub Actions release build

The release workflow is `.github/workflows/release.yml`.

## Release version

The workflow verifies that the release version agrees across:

- `GalaxyXRDriver/src/Config/Config.cpp`
- `GalaxyXRDriver/DriverFiles/driver.vrdrivermanifest`
- `GalaxyXRDriverGUI/package.json`
- `GalaxyXRDriverGUI/package-lock.json`
- `GalaxyXRDriverGUI/src-tauri/tauri.conf.json`
- `GalaxyXRDriverGUI/src-tauri/Cargo.toml`
- `GalaxyXRDriverGUI/src-tauri/Cargo.lock`

A tagged release must use exactly `v<version>`.

## Automatic release from main

Commit your changes and push them to `main`. CI chooses the next version from
commit subjects since the latest reachable stable release tag, updates all seven
version files above, and prepends an entry to `CHANGELOG.md`.

The latest reachable stable release tag is the automatic version baseline. If a
merge or stale local checkout restores an older stable version, CI calculates
the next version from that published baseline and synchronizes all version files
through `bump-version.js`. For example, source metadata at `1.2.13` with reachable
`v1.2.14` and an unreleased `feat:` commit produces `1.3.0`. It cannot downgrade or
replace `v1.2.14`. Docs-only changes still do not publish a release.

During release preparation, missing published changelog sections are recovered
from the baseline tag. Existing authored entries and introduction are retained.
Pull the bot's metadata commit before starting new work to avoid carrying stale
versions or dropping release history in the first place.

This project's rules use **patch** for fixes, **minor** for features, and **major** for reworks:

| Commit subject | Version change (starting at 1.2.4) |
| --- | --- |
| `fix: correct an issue` or `fix(gui): correct an issue` | `1.2.5` |
| `feat: add a feature` or `feat(gui): add a feature` | `1.3.0` |
| `rework: redesign a feature` or `rework(gui): redesign a feature` | `2.0.0` |
| Mixed prefixes in the unreleased commits | One bump at the highest level: `rework:` > `feat:` > `fix:` |
| Only `docs:`, `chore:`, or other subjects | Build; no release |

Squash merges use the squash commit's subject, so give it the appropriate prefix.
Normal merges retain the individual commit subjects; merge commits themselves are
excluded. Prefixes must be lowercase and followed by a space and a description.
An optional `!` is accepted but does not change these project-specific rules.

Generated entries group reworks, features, fixes, and other changes, include short commit
IDs, and preserve existing changelog history. Icon attribution stays in `CREDITS.md`
inside the ZIP and in the README; it is not appended to each release's notes.

After both builds, packaging, and artifact upload succeed, CI pushes a
`chore(release): v...` commit containing only the version files and changelog,
then tags **that exact built commit** and publishes. Pull `main` before your next
push to receive this metadata commit. The workflow uses `GITHUB_TOKEN` with
`contents: write`; its push does not start another Actions run
([GitHub's token-trigger rules](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)).
If branch protection prevents the bot from pushing, publication fails rather
than bypassing protection.

If `main` advances while a build runs, that stale run does not overwrite it or
publish its prepared version. The next main run considers all unreleased commits.
Reruns recreate the same metadata commit; interrupted publication can reuse it.

Manual version overrides remain available, including patch and prerelease versions:

```powershell
node bump-version.js 1.2.5
node tools/verify-release-version.cjs
```

Commit all seven version files. CI respects a stable version higher than the
published baseline, or an explicit prerelease version, and
generates its changelog entry if missing. Existing authored entries are retained.
For a repository with no stable release tag, CI uses the push's base commit;
if neither is available, create an initial stable `v<version>` tag first.
Feature branches and pull requests build without changing versions or
publishing. Local builds never generate release commits or push anything.

The Windows workflow:

1. checks out the full repository and recursive submodules;
2. installs Node.js, prepares automatic metadata, installs Rust, restores the Cargo registry cache and locates MSBuild;
3. verifies all release version fields (and the tag on tag-triggered runs);
4. installs the locked frontend dependencies with `npm ci`;
5. runs `node build.js --vendor neutral` and `node build.js --vendor galaxyxr`, each building the native OpenVR driver and Tauri application;
6. validates the staged executable, driver DLL, manifest and default settings;
7. packages the complete Galaxy XR portable pair into `GalaxyXRDriver-v<version>-Windows-x64.zip`;
8. creates a SHA-256 checksum;
9. generates release notes from the version's changelog entry without duplicating its commit list;
10. uploads the ZIP and metadata as Actions artifacts; and
11. saves generated metadata to `main`, pins `v<version>` to the built commit, uploads the ZIP and checksum to a draft, and publishes after both uploads succeed. Prerelease versions are marked as prereleases.

The release workflow builds and packages only. The GUI unit suite (`npm test`),
the Rust library tests (`cargo test --locked --lib`), the service regressions
(`tools/Test-*.cjs`) and the NVENC compile checks (`tools/Test-Nvenc*.ps1`) are
not run there; run the relevant ones locally at the end of every task.

A manual **Run workflow** invocation builds without publishing by default. To retry
a failed publication, select **main** and enable **publish**. Reruns preserve an
already published release and never move an existing tag to a different commit;
after code changes, use a `fix:`/`feat:`/`rework:` commit or an explicit new version.
Explicit `v*` tag pushes remain supported and build the tagged files without rewriting them.

`build-tools.yml` separately installs the locked frontend dependencies and runs
the frontend unit suite (`npm test`), the service regressions and the build-tool
tests under PowerShell 5.1 and 7. It is the CI test workflow; the release
workflow above stays build-only.
Its automatic-release fixtures cover stale version metadata, missing published
changelog history, docs-only changes, authored notes and deterministic retries.
These checks stay independent of the release build's installed compiler path.

The local full build command is unchanged and never publishes or deploys:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/Build-Portable.ps1
```

## Portable ZIP layout

```text
GalaxyXRDriver-v<version>-Windows-x64/
├── GalaxyXRDriverGUI/
│   └── Galaxy XR Companion.exe
├── GalaxyXRNative/
│   ├── driver.vrdrivermanifest
│   ├── bin/win64/driver_GalaxyXRNative.dll
│   └── resources/...
├── VERSION.txt
├── CHANGELOG.md
├── CREDITS.md
└── RELEASE-NOTES.md
```

Keep `GalaxyXRDriverGUI` and `GalaxyXRNative` together after extraction.

See `CREDITS.md` for icon attribution.
