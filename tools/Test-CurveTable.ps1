[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'Enter-PortableBuildEnvironment.ps1')
$outputDirectory = Join-Path $repoRoot '../builds/GalaxyXR-Driver/build/curve-table-test'
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$source = Join-Path $repoRoot 'GalaxyXRDriver/tests/CurveTableTest.cpp'
$driverHeaders = Join-Path $repoRoot 'GalaxyXRDriver/src/Driver'
$executable = Join-Path $outputDirectory 'CurveTableTest.exe'
$objectFile = Join-Path $outputDirectory 'CurveTableTest.obj'
# Pure header test (CurveMath.h): no NVENC, MinHook, json or SteamVR code.
& cl.exe /nologo /std:c++17 /EHsc /O2 /MT "/I$driverHeaders" $source "/Fo$objectFile" "/Fe$executable"
if ($LASTEXITCODE -ne 0) { throw "Curve table test compilation failed: $LASTEXITCODE" }
& $executable
if ($LASTEXITCODE -ne 0) { throw "Curve table tests failed: $LASTEXITCODE" }
Write-Host "Artifacts: $outputDirectory"
