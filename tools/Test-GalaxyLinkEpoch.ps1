[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'Enter-PortableBuildEnvironment.ps1') -DriverOnly -NoDownload
$outputDirectory = Join-Path $repoRoot '../builds/GalaxyXR-Driver/build/galaxylink-epoch-test'
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$source = Join-Path $repoRoot 'GalaxyXRDriver/tests/GalaxyLinkEpochTest.cpp'
$srcRoot = Join-Path $repoRoot 'GalaxyXRDriver/src'
$executable = Join-Path $outputDirectory 'GalaxyLinkEpochTest.exe'
$objectFile = Join-Path $outputDirectory 'GalaxyLinkEpochTest.obj'
# Pure state machine: no SteamVR, no module APIs (GXR_GALAXYLINK_PURE is set by the test).
& cl.exe /nologo /std:c++17 /EHsc /O2 /MT /permissive- "/I$srcRoot" $source "/Fo$objectFile" "/Fe$executable"
if ($LASTEXITCODE -ne 0) { throw "Galaxy Link epoch test compilation failed: $LASTEXITCODE" }
& $executable
if ($LASTEXITCODE -ne 0) { throw "Galaxy Link epoch tests failed: $LASTEXITCODE" }
Write-Host "Artifacts: $outputDirectory"
