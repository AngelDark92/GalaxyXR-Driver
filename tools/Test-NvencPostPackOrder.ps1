[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'Enter-PortableBuildEnvironment.ps1')
$outputDirectory = Join-Path $repoRoot 'build/nvenc-post-pack-order-test'
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$source = Join-Path $repoRoot 'GalaxyXRDriver/tests/NvencPostPackOrderTest.cpp'
$headers = Join-Path $repoRoot 'ThirdParty/openvr/headers'
$executable = Join-Path $outputDirectory 'NvencPostPackOrderTest.exe'
$objectFile = Join-Path $outputDirectory 'NvencPostPackOrderTest.obj'
# Includes the production shim translation unit with fake GPU/API entry points.
# Discard unused hook installation code; never load NVENC or touch SteamVR.
& cl.exe /nologo /std:c++17 /EHsc /O2 /Gy /MT "/I$headers" $source "/Fo$objectFile" "/Fe$executable" /link /OPT:REF
if ($LASTEXITCODE -ne 0) { throw "NVENC post-pack ordering test compilation failed: $LASTEXITCODE" }
& $executable
if ($LASTEXITCODE -ne 0) { throw "NVENC post-pack ordering tests failed: $LASTEXITCODE" }
Write-Host "Artifacts: $outputDirectory"
