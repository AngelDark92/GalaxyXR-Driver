[CmdletBinding()]
param([switch]$UseCurrentEnvironment)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $UseCurrentEnvironment) { . (Join-Path $PSScriptRoot 'Enter-PortableBuildEnvironment.ps1') }
$outputDirectory = Join-Path $repoRoot '../builds/GalaxyXR-Driver/build/hybrid-core-test'
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$source = Join-Path $repoRoot 'GalaxyXRDriver/tests/HybridCoreTest.cpp'
$hybrid = Join-Path $repoRoot 'GalaxyXRDriver/src/Hybrid'
$executable = Join-Path $outputDirectory 'HybridCoreTest.exe'
$objectDirectory = Join-Path $outputDirectory 'obj'
New-Item -ItemType Directory -Path $objectDirectory -Force | Out-Null

$sources = @(
    $source,
    (Join-Path $hybrid 'AstcSubset.cpp'),
    (Join-Path $hybrid 'FoveaPlanner.cpp'),
    (Join-Path $hybrid 'Gxh1Codec.cpp'),
    (Join-Path $hybrid 'PyroWaveCpu.cpp'),
    (Join-Path $hybrid 'HybridProducer.cpp'),
    (Join-Path $hybrid 'AstcBatchEncoder.cpp')
)
$objects = @()
foreach ($item in $sources) {
    $name = [System.IO.Path]::GetFileNameWithoutExtension($item)
    $object = Join-Path $objectDirectory "$name.obj"
    & cl.exe /nologo /std:c++17 /EHsc /O2 /W4 /WX "/I$hybrid" "/c" $item "/Fo$object"
    if ($LASTEXITCODE -ne 0) { throw "Hybrid core test compilation failed for $item : $LASTEXITCODE" }
    $objects += $object
}
& link.exe /nologo "/OUT:$executable" $objects
if ($LASTEXITCODE -ne 0) { throw "Hybrid core test link failed: $LASTEXITCODE" }
& $executable
if ($LASTEXITCODE -ne 0) { throw "Hybrid core tests failed: $LASTEXITCODE" }
Write-Host "Artifacts: $outputDirectory"
