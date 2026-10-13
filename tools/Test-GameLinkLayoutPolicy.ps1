param([switch]$UseCurrentEnvironment)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if (-not $UseCurrentEnvironment) { . (Join-Path $PSScriptRoot 'Enter-PortableBuildEnvironment.ps1') }
$build = Join-Path $repo 'build/game-link-layout-policy-test'
New-Item -ItemType Directory -Force -Path $build | Out-Null
$exe = Join-Path $build 'GameLinkLayoutPolicyTest.exe'
# Runtime preset of the Game Link layout toggle (header-only config types); never loads SteamVR.
& cl.exe /nologo /std:c++17 /EHsc /O2 /MT (Join-Path $repo 'GalaxyXRDriver/tests/GameLinkLayoutPolicyTest.cpp') "/Fo$build/GameLinkLayoutPolicyTest.obj" "/Fe$exe"
if ($LASTEXITCODE -ne 0) { throw 'Game Link layout policy test compilation failed.' }
& $exe
if ($LASTEXITCODE -ne 0) { throw 'Game Link layout policy test failed.' }
