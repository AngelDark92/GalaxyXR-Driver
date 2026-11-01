param([switch]$UseCurrentEnvironment)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if (-not $UseCurrentEnvironment) { . (Join-Path $PSScriptRoot 'Enter-PortableBuildEnvironment.ps1') }
$build = Join-Path $repo '../builds/GalaxyXR-Driver/build/spacewarp-toggle-test'
New-Item -ItemType Directory -Force -Path $build | Out-Null
$exe = Join-Path $build 'SpacewarpToggleTest.exe'
# ConfigLoader's hybridStatus reads the (inactive) hybrid producer: link its pure sources.
$hybrid = Join-Path $repo 'GalaxyXRDriver/src/Hybrid'
& cl.exe /nologo /std:c++17 /EHsc /O2 /MT /Gy "/I$repo/ThirdParty/openvr/headers" "/I$repo/ThirdParty/json/include" "/I$hybrid" (Join-Path $repo 'GalaxyXRDriver/tests/SpacewarpToggleTest.cpp') `
    (Join-Path $hybrid 'Gxh1Codec.cpp') (Join-Path $hybrid 'FoveaPlanner.cpp') (Join-Path $hybrid 'AstcSubset.cpp') `
    (Join-Path $hybrid 'PyroWaveCpu.cpp') (Join-Path $hybrid 'HybridProducer.cpp') (Join-Path $hybrid 'AstcBatchEncoder.cpp') `
    "/Fo$build/" "/Fe$exe" /link /OPT:REF
if ($LASTEXITCODE -ne 0) { throw 'Spacewarp toggle regression compilation failed.' }
& $exe
if ($LASTEXITCODE -ne 0) { throw 'Spacewarp toggle regression failed.' }
