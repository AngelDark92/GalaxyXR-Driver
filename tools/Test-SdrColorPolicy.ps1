[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'Enter-PortableBuildEnvironment.ps1')
$outputDirectory = Join-Path $repoRoot '../builds/GalaxyXR-Driver/build/sdr-color-policy-test'
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$source = Join-Path $repoRoot 'GalaxyXRDriver/tests/SdrColorPolicyTest.cpp'
$configHeaders = Join-Path $repoRoot 'GalaxyXRDriver/src/Config'
$executable = Join-Path $outputDirectory 'SdrColorPolicyTest.exe'
$objectFile = Join-Path $outputDirectory 'SdrColorPolicyTest.obj'
# Pure policy resolver test. No VENDOR_GALAXYXR: no SteamVR/live settings IO
# is compiled, and no json header is needed (Config.h is header-only types).
& cl.exe /nologo /std:c++17 /EHsc /O2 /MT "/I$configHeaders" $source "/Fo$objectFile" "/Fe$executable"
if ($LASTEXITCODE -ne 0) { throw "SdrColorPolicy test compilation failed: $LASTEXITCODE" }
& $executable
if ($LASTEXITCODE -ne 0) { throw "SdrColorPolicy tests failed: $LASTEXITCODE" }
Write-Host "Artifacts: $outputDirectory"
