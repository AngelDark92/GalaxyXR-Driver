[CmdletBinding()]
param([switch]$UseCurrentEnvironment)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $UseCurrentEnvironment) { . (Join-Path $PSScriptRoot 'Enter-PortableBuildEnvironment.ps1') }
$outputDirectory = Join-Path $repoRoot '../builds/GalaxyXR-Driver/build/nvenc-post-pack-order-test'
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$source = Join-Path $repoRoot 'GalaxyXRDriver/tests/NvencPostPackOrderTest.cpp'
$headers = Join-Path $repoRoot 'ThirdParty/openvr/headers'
$executable = Join-Path $outputDirectory 'NvencPostPackOrderTest.exe'
$hybrid = Join-Path $repoRoot 'GalaxyXRDriver/src/Hybrid'
# Includes the production shim translation unit with fake GPU/API entry points.
# Discard unused hook installation code; never load NVENC or touch SteamVR. The shims call
# the hybrid fovea producer (inactive here), so its pure sources are linked as-is.
& cl.exe /nologo /std:c++17 /EHsc /O2 /Gy /MT "/I$headers" "/I$hybrid" $source `
    (Join-Path $hybrid 'Gxh1Codec.cpp') (Join-Path $hybrid 'FoveaPlanner.cpp') `
    (Join-Path $hybrid 'AstcSubset.cpp') (Join-Path $hybrid 'PyroWaveCpu.cpp') `
    (Join-Path $hybrid 'HybridProducer.cpp') (Join-Path $hybrid 'AstcBatchEncoder.cpp') `
    "/Fo$outputDirectory/" "/Fe$executable" /link /OPT:REF
if ($LASTEXITCODE -ne 0) { throw "NVENC post-pack ordering test compilation failed: $LASTEXITCODE" }
& $executable
if ($LASTEXITCODE -ne 0) { throw "NVENC post-pack ordering tests failed: $LASTEXITCODE" }
Write-Host "Artifacts: $outputDirectory"
