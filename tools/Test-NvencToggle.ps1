$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'Enter-PortableBuildEnvironment.ps1')
$build = Join-Path $repo 'build/nvenc-toggle-test'
New-Item -ItemType Directory -Force -Path $build | Out-Null
$exe = Join-Path $build 'NvencToggleTest.exe'
& cl.exe /nologo /std:c++17 /EHsc /O2 /MT /Gy "/I$repo/ThirdParty/openvr/headers" "/I$repo/ThirdParty/json/include" (Join-Path $repo 'GalaxyXRDriver/tests/NvencToggleTest.cpp') "/Fo$build/NvencToggleTest.obj" "/Fe$exe" /link /OPT:REF
if ($LASTEXITCODE -ne 0) { throw 'NVENC toggle regression compilation failed.' }
& $exe
if ($LASTEXITCODE -ne 0) { throw 'NVENC toggle regression failed.' }
