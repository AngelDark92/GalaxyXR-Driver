[CmdletBinding()]
param([switch]$UseCurrentEnvironment)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $UseCurrentEnvironment) { . (Join-Path $PSScriptRoot 'Enter-PortableBuildEnvironment.ps1') }
$outputDirectory = Join-Path $repoRoot '../builds/GalaxyXR-Driver/build/vrlink-fallback-test'
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$source = Join-Path $repoRoot 'GalaxyXRDriver/tests/VrlinkFallbackTest.cpp'
$executable = Join-Path $outputDirectory 'VrlinkFallbackTest.exe'
$objectFile = Join-Path $outputDirectory 'VrlinkFallbackTest.obj'
# Header-only: exercises the pinned anchor/spanned-byte classifier against a
# synthetic image. Never loads driver_vrlink.dll or touches SteamVR.
& cl.exe /nologo /std:c++17 /EHsc /O2 /Gy /MT $source "/Fo$objectFile" "/Fe$executable" /link /OPT:REF
if ($LASTEXITCODE -ne 0) { throw "VRLink fallback test compilation failed: $LASTEXITCODE" }
& $executable
if ($LASTEXITCODE -ne 0) { throw "VRLink fallback tests failed: $LASTEXITCODE" }
Write-Host "Artifacts: $outputDirectory"
