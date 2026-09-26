param(
    [switch]$DriverOnly, [switch]$GuiOnly, [string]$OutputDirectory,
    [switch]$NoDownload, [switch]$AcceptToolchainLicense, [switch]$SetupOnly,
    [switch]$InstallMicrosoftBuildTools, [switch]$KeepBuildArtifacts
)
# Local fallback when the full MSBuild solution is unavailable. Requires the
# MSVC C++ build tools and Windows SDK, prepared automatically when missing. Builds the x64
# Galaxy XR target directly from the vcxproj source list. Never deploys.
$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1's `Set-Content -Encoding utf8` writes a UTF-8 BOM.
# SteamVR manifests/settings and serde_json consumers expect plain UTF-8, so
# all generated JSON used by the portable package must be written BOM-free.
function Write-Utf8NoBom {
    param([Parameter(Mandatory=$true)][string]$Path, [Parameter(Mandatory=$true)][string]$Text)
    [IO.File]::WriteAllText($Path, $Text, [Text.UTF8Encoding]::new($false))
}
# PowerShell 5.1 trap: with $ErrorActionPreference='Stop', a native command
# writing to stderr (cl errors, dumpbin failures, npm/tauri routine status
# lines) becomes a terminating NativeCommandError under the 2>&1 merge,
# before $LASTEXITCODE is ever checked (verified 2026-09-19 on PS 5.1).
# Drop EAP for the duration of the native call; success is still judged by
# $LASTEXITCODE at each call site (existing convention). No-op on PS 7.
function Invoke-NativeLogged {
    param([scriptblock]$Command)
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $Command } finally { $ErrorActionPreference = $prevEap }
}
if ($DriverOnly -and $GuiOnly) { throw 'Choose at most 1 partial-build switch.' }
if ($InstallMicrosoftBuildTools -and $NoDownload) { throw '-InstallMicrosoftBuildTools cannot be combined with -NoDownload.' }
$repo = Split-Path $PSScriptRoot -Parent
$buildRoot = Join-Path $repo 'build'
. (Join-Path $PSScriptRoot 'lib/portable-build-cleanup.ps1')
$workDirectory = $null
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repo ('output/GalaxyXRDriver-Test-' + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
if (-not $OutputDirectory.StartsWith([IO.Path]::GetFullPath((Join-Path $repo 'output')) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Output must be inside repository output directory.' }
# The public build command restores this shell's environment even on failure.
# Dot-sourcing Enter-PortableBuildEnvironment directly remains available for
# developers who deliberately want a persistent current-session tool environment.
$previousPortableEnvironment = @{}
foreach ($name in @('PATH','INCLUDE','LIB','VCToolsInstallDir','VCToolsVersion','VCINSTALLDIR',
    'WindowsSdkDir','WindowsSDKVersion','WindowsSdkBinPath','UniversalCRTSdkDir','UCRTVersion',
    'VSCMD_ARG_HOST_ARCH','VSCMD_ARG_TGT_ARCH','CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER',
    'CARGO_HOME','RUSTUP_HOME','RUSTUP_TOOLCHAIN','CARGO_NET_OFFLINE','CARGO_TARGET_DIR','VENDOR')) {
    $previousPortableEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, [EnvironmentVariableTarget]::Process)
}
try {
# Validate the destination before setup performs network or filesystem work.
# $PSScriptRoot makes this work from the repository root OR the tools directory.
# Explicit opt-in only: this installs system C++ prerequisites, not a driver.
if ($InstallMicrosoftBuildTools) {
    & (Join-Path $PSScriptRoot 'Install-MicrosoftBuildTools.ps1') -AcceptLicense:$AcceptToolchainLicense -AutoElevate
}
. (Join-Path $PSScriptRoot 'Enter-PortableBuildEnvironment.ps1') `
    -DriverOnly:$DriverOnly -GuiOnly:$GuiOnly -NoDownload:$NoDownload `
    -AcceptToolchainLicense:$AcceptToolchainLicense -PrepareDependencies
if ($SetupOnly) { Write-Output 'Portable build prerequisites are ready; no application was built or deployed.'; return }
# Portable build cleanup (2026-09-26): isolate disposable compiler artifacts so
# successful builds can remove only their own work, keeping packages and logs.
$runId = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N')
$workDirectory = Join-Path $buildRoot ('portable-work-' + $runId)
$logDirectory = Join-Path $buildRoot ('portable-logs-' + $runId)
New-Item -ItemType Directory -Path $workDirectory,$logDirectory | Out-Null
Write-Output "Build logs: $logDirectory"
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
if (-not $GuiOnly) {
    $nativeOutput = Join-Path $OutputDirectory 'GalaxyXRNative'
    $objects = Join-Path $workDirectory 'native'
    New-Item -ItemType Directory -Force -Path $objects,$nativeOutput | Out-Null
    $driverProjectDir = Join-Path $repo 'GalaxyXRDriver'
    [xml]$project = Get-Content -Raw -LiteralPath (Join-Path $driverProjectDir 'GalaxyXRDriver.vcxproj')
    $sources = @($project.Project.ItemGroup.ClCompile | Where-Object Include | ForEach-Object { [IO.Path]::GetFullPath((Join-Path $driverProjectDir $_.Include)) })
    $sources += @('buffer.c','hook.c','trampoline.c','hde/hde64.c') | ForEach-Object { Join-Path $repo "ThirdParty/minhook/src/$_" }
    $argsList = @('/nologo','/LD','/O2','/MT','/EHsc','/std:c++17','/permissive-','/MP4','/DNDEBUG','/D_CONSOLE','/D_UNICODE','/DUNICODE','/DWIN32','/DVENDOR_GALAXYXR','/D_CRT_SECURE_NO_WARNINGS','/D_SILENCE_ALL_CXX17_DEPRECATION_WARNINGS',('/I' + (Join-Path $repo 'ThirdParty/openvr/headers')),('/I' + (Join-Path $repo 'ThirdParty/json/include')),('/Fo' + $objects + '\'),('/Fe' + (Join-Path $objects 'driver_GalaxyXRNative.dll')))
    $driverLog = Join-Path $logDirectory 'driver-build.log'
    Invoke-NativeLogged { & cl.exe @argsList @sources /link /MACHINE:X64 /OPT:REF /OPT:ICF kernel32.lib user32.lib gdi32.lib winspool.lib comdlg32.lib advapi32.lib shell32.lib ole32.lib oleaut32.lib uuid.lib odbc32.lib odbccp32.lib ws2_32.lib winmm.lib (Join-Path $repo 'ThirdParty/openvr/lib/win64/openvr_api.lib') 2>&1 | Tee-Object -FilePath $driverLog }
    if ($LASTEXITCODE -ne 0) { throw "Native compilation failed: $driverLog" }
    $exports = Invoke-NativeLogged { & dumpbin.exe /nologo /exports (Join-Path $objects 'driver_GalaxyXRNative.dll') }
    $exports | Set-Content -LiteralPath (Join-Path $logDirectory 'driver-exports.txt')
    if ($LASTEXITCODE -ne 0 -or -not ($exports -match 'HmdDriverFactory')) { throw 'Native driver entry point is missing.' }
    Invoke-NativeLogged { & dumpbin.exe /nologo /dependents (Join-Path $objects 'driver_GalaxyXRNative.dll') | Set-Content -LiteralPath (Join-Path $logDirectory 'driver-dependencies.txt') }
    if ($LASTEXITCODE -ne 0) { throw 'Native driver dependency inspection failed.' }
    $privateAssets = @(Get-ChildItem -LiteralPath (Join-Path $driverProjectDir 'DriverFiles') -Recurse -Force | Where-Object { $_.Name -eq 'NOTFORSHIPPING.txt' -or $_.Name -like 'NOTFORSHIPPING_*' -or $_.Name -like '*_test.hlsl' })
    if ($privateAssets.Count -gt 0) { throw 'Local reference/test assets found in DriverFiles; package requires explicit classification.' }
    Copy-Item -Path (Join-Path $driverProjectDir 'DriverFiles/*') -Destination $nativeOutput -Recurse -Force
    New-Item -ItemType Directory -Force -Path (Join-Path $nativeOutput 'bin/win64') | Out-Null
    Copy-Item -LiteralPath (Join-Path $objects 'driver_GalaxyXRNative.dll') -Destination (Join-Path $nativeOutput 'bin/win64/driver_GalaxyXRNative.dll')
    $manifestFile = Join-Path $nativeOutput 'driver.vrdrivermanifest'
    $manifest = Get-Content -Raw $manifestFile | ConvertFrom-Json
    $manifest.name = 'GalaxyXRNative'
    Write-Utf8NoBom -Path $manifestFile -Text ($manifest | ConvertTo-Json -Depth 50)
    $defaultsFile = Join-Path $nativeOutput 'resources/settings/default.vrsettings'
    # PowerShell 5.1 compatible (no ConvertFrom-Json -AsHashtable): top-level
    # object -> real hashtable so Remove() works on both 5.1 and 7
    $defaults = @{}
    foreach($prop in (Get-Content -Raw $defaultsFile | ConvertFrom-Json).PSObject.Properties){ $defaults[$prop.Name] = $prop.Value }
    $defaults.driver_GalaxyXRNative = $defaults.driver_CustomHeadsetOpenVR
    $defaults.Remove('driver_CustomHeadsetOpenVR') | Out-Null
    $defaults.driver_GalaxyXRNative.Note1 = 'The settings have moved to Appdata/Roaming/GalaxyXR/CustomHeadset/settings.json'
    Write-Utf8NoBom -Path $defaultsFile -Text ($defaults | ConvertTo-Json -Depth 50)
}
if (-not $DriverOnly) {
    $guiLog = Join-Path $logDirectory 'gui-build.log'
    $guiTarget = Join-Path $workDirectory 'gui-target'
    $env:CARGO_TARGET_DIR = $guiTarget
    # This script always compiles the Galaxy XR driver; never pair it with a
    # previously generated neutral GUI. Restore the caller's environment below.
    $previousVendor = $env:VENDOR
    $env:VENDOR = 'galaxyxr'
    Push-Location (Join-Path $repo 'GalaxyXRDriverGUI')
    try {
        # Tauri writes normal status messages (including beforeBuildCommand) to stderr.
        # Windows PowerShell 5.1 turns redirected native stderr into NativeCommandError
        # records when `$ErrorActionPreference = 'Stop'`, which can abort an otherwise
        # successful build. Merge stderr inside cmd.exe instead, so PowerShell receives
        # one ordinary stdout stream. The build result is determined only by cmd.exe's
        # exit code, while the complete Tauri/npm output is still tee'd to the log.
        & $env:ComSpec /D /S /C 'npm.cmd run build 2>&1' | Tee-Object -FilePath $guiLog
        $guiExitCode = $LASTEXITCODE
        if ($guiExitCode -ne 0) { throw "GUI build failed with exit code $guiExitCode. See: $guiLog" }
    } finally {
        Pop-Location
        if ($null -eq $previousVendor) { Remove-Item Env:VENDOR -ErrorAction SilentlyContinue }
        else { $env:VENDOR = $previousVendor }
    }
    $guiOutput = Join-Path $OutputDirectory 'GalaxyXRDriverGUI'
    New-Item -ItemType Directory -Force -Path $guiOutput | Out-Null
    & node (Join-Path $repo 'tools/lib/stage-companion.cjs') (Join-Path $guiTarget 'release') $guiOutput
    if ($LASTEXITCODE -ne 0) { throw 'Galaxy XR Companion executable staging failed.' }
}
if ($KeepBuildArtifacts) {
    Write-Output "Build artifacts retained: $workDirectory"
} else {
    try {
        Remove-PortableBuildWork -Repository $repo -WorkDirectory $workDirectory
        Write-Output "Removed build artifacts: $workDirectory"
    } catch {
        Write-Warning "Package staging succeeded, but build artifact cleanup failed: $($_.Exception.Message). Artifacts: $workDirectory"
    }
}
Write-Output "Built test package: $OutputDirectory"


} catch {
    if ($workDirectory -and (Test-Path -LiteralPath $workDirectory)) {
        Write-Warning "Build failed; artifacts retained for diagnosis: $workDirectory"
    }
    throw
} finally {
    foreach ($entry in $previousPortableEnvironment.GetEnumerator()) {
        [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, [EnvironmentVariableTarget]::Process)
    }
}
