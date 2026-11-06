param([switch]$UseCurrentEnvironment, [ValidateSet('all', 'hook', 'vendor', 'realepoch')][string]$Only = 'all')
# Focused regression for the Galaxy XR vendor NVENC isolation: the header-only
# module-local import hook fixtures and the vendor (VENDOR_GALAXYXR) NvencTap path.
# All outputs go under ../builds/GalaxyXR-Driver/build/nvenc-galaxy-isolation-test.
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if (-not $UseCurrentEnvironment) { . (Join-Path $PSScriptRoot 'Enter-PortableBuildEnvironment.ps1') }
$build = Join-Path $repo '../builds/GalaxyXR-Driver/build/nvenc-galaxy-isolation-test'
New-Item -ItemType Directory -Force -Path $build | Out-Null

if ($Only -in 'all','hook') {
    $hookExe = Join-Path $build 'ModuleImportHookTest.exe'
    & cl.exe /nologo /std:c++17 /EHsc /O2 /MT /Gy (Join-Path $repo 'GalaxyXRDriver/tests/ModuleImportHookTest.cpp') "/Fo$build/ModuleImportHookTest.obj" "/Fe$hookExe" /link /OPT:REF
    if ($LASTEXITCODE -ne 0) { throw 'Module import hook fixture compilation failed.' }
    & $hookExe
    if ($LASTEXITCODE -ne 0) { throw 'Module import hook fixture regression failed.' }
}

if ($Only -in 'all','vendor') {
    $vendorExe = Join-Path $build 'NvencGalaxyIsolationTest.exe'
    & cl.exe /nologo /std:c++17 /EHsc /O2 /MT /Gy /DVENDOR_GALAXYXR "/I$repo/ThirdParty/openvr/headers" "/I$repo/ThirdParty/json/include" (Join-Path $repo 'GalaxyXRDriver/tests/NvencGalaxyIsolationTest.cpp') "/Fo$build/NvencGalaxyIsolationTest.obj" "/Fe$vendorExe" /link /OPT:REF
    if ($LASTEXITCODE -ne 0) { throw 'NVENC Galaxy isolation compilation failed.' }
    & $vendorExe
    if ($LASTEXITCODE -ne 0) { throw 'NVENC Galaxy isolation regression failed.' }
}

if ($Only -in 'all', 'realepoch') {
    # REAL NvencTap.cpp + REAL GalaxyLinkEpoch.h (no epoch mock); module proof via the Tracker's public addressValidator seam.
    $realExe = Join-Path $build 'NvencGalaxyRealEpochTest.exe'
    & cl.exe /nologo /std:c++17 /EHsc /O2 /MT /Gy /DVENDOR_GALAXYXR "/I$repo/ThirdParty/openvr/headers" "/I$repo/ThirdParty/json/include" (Join-Path $repo 'GalaxyXRDriver/tests/NvencGalaxyRealEpochTest.cpp') "/Fo$build/NvencGalaxyRealEpochTest.obj" "/Fe$realExe" /link /OPT:REF
    if ($LASTEXITCODE -ne 0) { throw 'NVENC Galaxy real-epoch compilation failed.' }
    & $realExe
    if ($LASTEXITCODE -ne 0) { throw 'NVENC Galaxy real-epoch integration failed.' }
}