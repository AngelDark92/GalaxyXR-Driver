# Portable local Windows x64 build

All generated artifacts use `../builds/GalaxyXR-Driver/` outside the checkout (2026-10-08).
Frontend catalogs/bundles/caches use `gui/`; compiler scratch and tools use `build/`;
packages use `output/` and release archives use `release/` beneath that root.

## One command

From the project root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\Build-Portable.ps1
```

Or, from `tools`:

```powershell
.\Build-Portable.ps1
```

Use a **64-bit Windows PowerShell 5.1 or PowerShell 7** session. The script locates the project relative to its own file, not your current working directory. The source layout must contain `GalaxyXRDriver`, `GalaxyXRDriverGUI`, and `build.js` together.

The build now prepares missing dependencies before compilation. It does not assume that a developer's ignored `../builds/GalaxyXR-Driver/build/toolchains/msvc/VC/Tools/MSVC/14.44.35207` folder exists in your checkout. No Visual Studio IDE installation is performed.

## What setup does

1. Reuse a supported x64 Node.js installation with npm, or download a portable Node 22 ZIP from `nodejs.org`. The first bootstrap does not require Python or Git.
2. Reuse a complete project-local MSVC/Windows SDK cache. Otherwise discover installed Visual Studio C++ Build Tools through the existing developer environment or `vswhere.exe`. If neither is usable, first attempt Microsoft's signed C++ Build Tools installer (one license confirmation and, when required, a UAC approval); if that attempt is declined or fails, fall back to the verified portable download of the MSVC 14.44 family and SDK 26100 family from Microsoft's VS 2022 release catalog. Servicing versions and actual extracted directory names are detected, not hard-coded. The installer attempt is best-effort and never blocks the build: sessions without administrator approval continue to the portable fallback, which needs no elevation (2026-09-21).
3. Check compiler, linker, resource tools, headers, and x64 libraries. Compile and link a small Windows/C++ probe before using a freshly downloaded toolchain. An incomplete or failed extraction cannot replace an existing cache or create a successful environment receipt.
4. For a native build, initialize missing **pinned Git submodules** when the complete checkout contains their gitlinks and Git is available. Existing complete source dependencies are not updated. Source-only ZIPs with no recorded revisions must retain their existing `ThirdParty` directory; no arbitrary upstream branch is selected.
5. For GUI/full builds, reuse working x64 MSVC Rust/Cargo (minimum 1.85 for this build bootstrap), including its existing homes. Otherwise run the official hash-verified `rustup-init.exe` to prepare a project-local stable/minimal toolchain, with `--no-modify-path`. Existing user Rust settings are not rewritten.
6. For GUI/full builds, run `npm ci --no-audit --no-fund --include=dev --include=optional` when dependencies are missing or the combined `package.json`/`package-lock.json` fingerprint changes. This replaces generated `node_modules` when necessary, not source or lockfiles. A successful install is stamped in `node_modules/.galaxyxrdriver-lock.sha256`. A pre-existing manual npm install may be reinstalled once to establish this stamp.
7. Continue the existing native driver build, Tauri build, validated executable staging, BOM-free manifest generation, and portable output layout.

`-DriverOnly` still needs Node for the dependency bootstrap but skips Rust and frontend dependency installation. `-GuiOnly` skips native submodule acquisition and the driver build, but still needs MSVC/SDK for the Rust GUI.

## License and security

For a **new Microsoft toolchain download**, setup displays the license URL from Microsoft's channel manifest and asks for acceptance once. Declining stops setup before compiler/SDK payload extraction. For an unattended run, pass `-AcceptToolchainLicense` only after reviewing and accepting the displayed Microsoft terms:

```powershell
.\tools\Build-Portable.ps1 -AcceptToolchainLicense
```

The acceptance receipt is local to `../builds/GalaxyXR-Driver/build/toolchains/microsoft-license.json`. Existing installed tools or a complete existing portable cache are reused without reinstalling them. This is not a license grant for redistributing Microsoft tools; the release package does **not** include the toolchain.

Tool downloads use HTTPS on an explicit publisher host allowlist, including validated redirect destinations. Executable/archive payloads must match SHA-256 checksums in Microsoft's catalog or the Node/Rust publisher checksum files. TLS certificate validation is not disabled. Interrupted downloads are retried up to three times and corrupt `.part` files are discarded; verified cache entries can be reused on retry. No remote PowerShell/Python script is fetched or executed.

As of 2026-09-21 the publisher's release channel has been observed serving a catalog whose digest no longer matches its own channel entry, and VSIX payloads whose declared sizes are stale while their SHA-256 values are correct. The verification rules are therefore: **SHA-256 is the hard gate; the declared size is advisory** (a mismatch is reported as a WARNING, not an error). If the served channel manifest still fails the catalog digest check after one refresh of the channel/catalog pair, it may be used only if it is structurally a genuine VS installer manifest for the same product version with a non-empty package list, and setup prints a loud WARNING naming both digests; any other mismatch stops setup. The channel and its catalog are always consumed as one verified pair; two different channel snapshots are never mixed.

SDK MSI packages are extracted using Windows Installer's administrative-image operation (`msiexec /a`), not a full Visual Studio installation. A Windows policy, security product, or another active installer can still prevent extraction. Such failures stop the build and point to the MSI log; the script does not request elevation or bypass security policy.

## Storage and repeat builds

Build-only dependencies, download receipts, and setup logs live under the ignored directory:

```text
../builds/GalaxyXR-Driver/build/toolchains/
├── node/               # Only if a local Node runtime was needed
├── msvc/               # Portable compiler/SDK, if no installed tools were usable
├── .msvc-new/          # Interrupted staging copy; may linger if antivirus holds a rename lock
├── cargo/              # Only if project-local Rust was needed
├── rustup/             # Only if project-local Rust was needed
├── downloads/          # Publisher metadata and checksum-verified payloads
├── logs/               # Compiler probe, SDK extraction, npm and rustup logs
├── probe/              # Generated compile/link probe, not part of the application
└── environment.json    # Written only after this setup run succeeds
```

Allow several GB of free disk space for extracted tools, cached downloads, Rust, Cargo crates and normal application build output. Actual download sizes depend on what is already installed and the publishers' servicing packages. No compiler/SDK version is upgraded on a repeat build when the existing toolchain is complete and usable. Exact selected versions are recorded in the receipt.

The normal `Build-Portable.ps1` command restores its changed environment variables when it finishes or fails. It never updates machine/user PATH. To deliberately configure the current session for manual Rust commands, dot-source the environment helper instead:

```powershell
. .\tools\Enter-PortableBuildEnvironment.ps1
cargo test --manifest-path .\GalaxyXRDriverGUI\src-tauri\Cargo.toml --locked --lib
```

## Preparation-only and offline checks

Prepare tools and locked dependencies without building the application:

```powershell
.\tools\Build-Portable.ps1 -SetupOnly
```

After a successful setup, require the cached tools/dependencies instead of downloading them:

```powershell
.\tools\Build-Portable.ps1 -NoDownload
```

`-NoDownload` rejects missing tools, unprepared frontend dependencies, or missing native source dependencies, and sets Cargo's offline mode for the build. A first Rust application build may still need crates not downloaded by `-SetupOnly`: perform an online full build first, or use `cargo fetch --locked` in the prepared environment. No-download mode is not a claim that arbitrary third-party build scripts have no network behavior.

A user-selected output directory must remain inside the project `output` directory. For example:

```powershell
.\tools\Build-Portable.ps1 -OutputDirectory "$PWD\..\builds\GalaxyXR-Driver\output\GalaxyXRDriver-local-check"
```

Do not combine `-DriverOnly` and `-GuiOnly`. Use a full build when deploying application/driver changes together.

## Output remains portable

```text
../builds/GalaxyXR-Driver/output/GalaxyXRDriver-Test-<timestamp>/
├── GalaxyXRDriverGUI/
│   └── Galaxy XR Companion.exe
└── GalaxyXRNative/
    ├── driver.vrdrivermanifest
    ├── bin/win64/driver_GalaxyXRNative.dll
    └── resources/...
```

This local helper produces a portable folder; it does not deploy, register, launch, or reset anything in SteamVR. The separate GitHub release workflow still uses its installed MSBuild toolchain and packages the versioned release ZIP. `node build.js --vendor galaxyxr` remains the MSBuild entry point; downloading the portable compiler does not install MSBuild for that separate command.

## Troubleshooting

- **Partial update:** apply all patch files, including `tools/lib/portable-toolchain.cjs` and both new PowerShell helpers. Do not replace only `Build-Portable.ps1`. Keep the root `.gitignore` exceptions for `tools/lib` when committing.
- **Download/certificate failure:** read the reported URL and error; check proxy/certificate trust or retry. The downloader uses the Windows system proxy. No certificate bypass is offered.
- **Another setup is running:** wait for it to finish. The PowerShell bootstrap uses an OS file lock. A `.setup.lock` left by a forcibly killed Node process may be removed only after verifying no build/setup is active; rerun setup afterward.
- **Interrupted extraction:** retry the same command. A complete `.msvc-new` staging tree from an interrupted run is reused instead of re-downloading, and valid downloads are reused. An old/incomplete replaced toolchain is retained as `msvc.previous`; review this backup rather than deleting it blindly if it blocks a later repair.
- **Leftover `.msvc-new`:** Windows SmartScreen or Defender can hold persistent locks on a freshly written tool tree, so the staging-to-`msvc` rename may fail. Setup then retries the rename, copies the tree into place instead, and may leave the now-redundant `.msvc-new` folder behind. Once `msvc/` is complete and a build succeeded, the leftover staging folder can be deleted manually; repeat builds do not use it.
- **Stale declared size from the catalog:** reported as a WARNING (recorded as `sizeMismatch` in the download receipt). This is expected with Microsoft's current release-channel metadata; the SHA-256 check is what enforces payload integrity.
- **MSI extraction failure:** read `../builds/GalaxyXR-Driver/build/toolchains/logs/<SDK installer>.log`. Close other installers and check enterprise Windows Installer policy. Keep the log when reporting a failure.
- **Compiler/SDK validation failure:** inspect `../builds/GalaxyXR-Driver/build/toolchains/logs/compiler-probe.log`. A `cl.exe` file by itself is not a complete compiler/SDK installation.
- **Missing Git or submodule revisions:** use the complete project checkout with its recorded submodules. The script intentionally does not replace partial/unknown source with an arbitrary upstream release. Git itself is not automatically installed.
- **Frontend dependencies:** inspect `../builds/GalaxyXR-Driver/build/toolchains/logs/npm-ci.log`. An inconsistent lockfile is an error, not a reason to rewrite it with `npm install`.
- **Rust:** inspect `../builds/GalaxyXR-Driver/build/toolchains/logs/rustup-install.log`. Working user Rust is reused; project-local Rust is isolated through its recorded Cargo/Rustup homes.

## Sources and implementation references

The separate Bitrate Curve page is included in every locale's frontend bundle
and in the native Companion executable. See [graph window maintenance](../Docs/CompanionGraphWindow.md)
for production-asset checks, explicit native packaged QA and GitHub bot-PR
approval configuration. A frontend-only check is not a full driver build.

- Microsoft command-line C++ build tools: https://learn.microsoft.com/en-us/cpp/build/building-on-the-command-line?view=msvc-170
- Microsoft administrative MSI images: https://learn.microsoft.com/en-us/windows/win32/msi/administrative-installation
- Microsoft release channel used for publisher URLs and SHA-256 values: https://aka.ms/vs/17/release/channel
- Package layout reference (not downloaded or executed by this bootstrap): https://gist.github.com/mmozeiko/7f3162ec2988e81e56d5c4e22cde9977
- Official Node release checksum index: https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt
- Rust installation and custom Cargo/Rustup homes: https://rust-lang.github.io/rustup/installation/index.html
- Official rustup Windows distribution: https://rust-lang.github.io/rustup/installation/other.html
- Locked npm install behavior: https://docs.npmjs.com/cli/v11/commands/npm-ci/
- Rust MSVC environment discovery implementation: https://docs.rs/find-msvc-tools/latest/src/find_msvc_tools/find_tools.rs.html
