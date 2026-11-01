[CmdletBinding()]
param([switch]$UseCurrentEnvironment)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if (-not $UseCurrentEnvironment) { . (Join-Path $PSScriptRoot 'Enter-PortableBuildEnvironment.ps1') }
$build = Join-Path $repo '../builds/GalaxyXR-Driver/build/hybrid-gpu-astc'
New-Item -ItemType Directory -Force -Path $build | Out-Null

# Local diagnostic oracle only: the astcenc clone under builds/ is Apache-2.0 and is never
# linked into the driver. Fail with a clear message when it is absent instead of skipping.
$astcSource = Join-Path $repo '../builds/GalaxyXR-Driver/build/astc-bench/src/Source'
if (-not (Test-Path (Join-Path $astcSource 'astcenc.h'))) {
    throw "Independent ASTC reference decoder source not found at $astcSource. Re-clone astcenc 5.7.0 to run the GPU qualification."
}

$astcObjects = Join-Path $build 'astcenc-obj'
New-Item -ItemType Directory -Force -Path $astcObjects | Out-Null
$astcTus = @(
    'astcenc_entry.cpp',
    'astcenc_block_sizes.cpp',
    'astcenc_partition_tables.cpp',
    'astcenc_percentile_tables.cpp',
    'astcenc_symbolic_physical.cpp',
    'astcenc_integer_sequence.cpp',
    'astcenc_quantization.cpp',
    'astcenc_color_unquantize.cpp',
    'astcenc_decompress_symbolic.cpp',
    'astcenc_image.cpp',
    'astcenc_weight_quant_xfer_tables.cpp',
    'astcenc_mathlib_softfloat.cpp'
)
$defines = @(
    '/D_CRT_SECURE_NO_WARNINGS',
    '/DASTCENC_DECOMPRESS_ONLY',
    '/DASTCENC_NEON=0', '/DASTCENC_SVE=0', '/DASTCENC_SSE=0', '/DASTCENC_AVX=0',
    '/DASTCENC_POPCNT=0', '/DASTCENC_F16C=0'
)
$astcObjectPaths = @()
foreach ($tu in $astcTus) {
    $object = Join-Path $astcObjects ($tu -replace '\.cpp$', '.obj')
    if (-not (Test-Path $object) -or (Get-Item (Join-Path $astcSource $tu)).LastWriteTimeUtc -gt (Get-Item $object).LastWriteTimeUtc) {
        & cl.exe /nologo /c /std:c++14 /EHsc /O2 /fp:precise $defines "/I$astcSource" (Join-Path $astcSource $tu) "/Fo$object"
        if ($LASTEXITCODE -ne 0) { throw "astcenc reference compilation failed for $tu" }
    }
    $astcObjectPaths += $object
}

$hybrid = Join-Path $repo 'GalaxyXRDriver/src/Hybrid'
$driver = Join-Path $repo 'GalaxyXRDriver/src/Driver'
$exe = Join-Path $build 'HybridGpuAstcTest.exe'
& cl.exe /nologo /std:c++17 /EHsc /O2 /MT "/I$hybrid" "/I$driver" "/I$astcSource" "/I$repo/ThirdParty/openvr/headers" `
    (Join-Path $repo 'GalaxyXRDriver/tests/HybridGpuAstcTest.cpp') `
    (Join-Path $hybrid 'AstcSubset.cpp') (Join-Path $hybrid 'FoveaPlanner.cpp') `
    (Join-Path $hybrid 'AstcBatchEncoder.cpp') (Join-Path $driver 'AstcGpuEncoder.cpp') `
    (Join-Path $driver 'HybridCapture.cpp') (Join-Path $hybrid 'HybridProducer.cpp') `
    (Join-Path $hybrid 'Gxh1Codec.cpp') (Join-Path $hybrid 'PyroWaveCpu.cpp') `
    (Join-Path $driver 'NvencPostPack.cpp') `
    $astcObjectPaths "/Fo$build/" "/Fe$exe" /link /OPT:REF
if ($LASTEXITCODE -ne 0) { throw "Hybrid GPU ASTC test compilation failed: $LASTEXITCODE" }
& $exe
if ($LASTEXITCODE -ne 0) { throw "Hybrid GPU ASTC qualification failed: $LASTEXITCODE" }
Write-Host "Artifacts: $build"
