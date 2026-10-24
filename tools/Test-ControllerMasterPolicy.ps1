param([switch]$UseCurrentEnvironment)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if (-not $UseCurrentEnvironment) { . (Join-Path $PSScriptRoot 'Enter-PortableBuildEnvironment.ps1') }
$build = Join-Path $repo '../builds/GalaxyXR-Driver/build/controller-master-policy-test'
New-Item -ItemType Directory -Force -Path $build | Out-Null
$exe = Join-Path $build 'ControllerMasterPolicyTest.exe'
# Runtime preset of the controller master disable (header-only config types); never loads SteamVR.
& cl.exe /nologo /std:c++17 /EHsc /O2 /MT (Join-Path $repo 'GalaxyXRDriver/tests/ControllerMasterPolicyTest.cpp') "/Fo$build/ControllerMasterPolicyTest.obj" "/Fe$exe"
if ($LASTEXITCODE -ne 0) { throw 'Controller master policy test compilation failed.' }
& $exe
if ($LASTEXITCODE -ne 0) { throw 'Controller master policy test failed.' }
