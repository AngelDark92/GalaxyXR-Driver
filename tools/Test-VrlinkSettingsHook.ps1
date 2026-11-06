[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'Enter-PortableBuildEnvironment.ps1') -DriverOnly -NoDownload
$outputDirectory = Join-Path $repoRoot '../builds/GalaxyXR-Driver/build/vrlink-settings-hook-test'
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$source = Join-Path $repoRoot 'GalaxyXRDriver/tests/VrlinkSettingsHookTest.cpp'
$srcRoot = Join-Path $repoRoot 'GalaxyXRDriver/src'
$headers = Join-Path $repoRoot 'ThirdParty/openvr/headers'
$executable = Join-Path $outputDirectory 'VrlinkSettingsHookTest.exe'
$objectFile = Join-Path $outputDirectory 'VrlinkSettingsHookTest.obj'
# Installs the REAL detours on a fake IVRSettings vtable in this test process only.
# No SteamVR, no live settings and no user files are touched.
& cl.exe /nologo /std:c++17 /EHsc /O2 /MT /permissive- "/I$srcRoot" "/I$headers" $source "/Fo$objectFile" "/Fe$executable"
if ($LASTEXITCODE -ne 0) { throw "VRLink settings hook test compilation failed: $LASTEXITCODE" }
& $executable
if ($LASTEXITCODE -ne 0) { throw "VRLink settings hook tests failed: $LASTEXITCODE" }
Write-Host "Artifacts: $outputDirectory"
