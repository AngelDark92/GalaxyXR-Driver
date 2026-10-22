param([switch]$UseCurrentEnvironment)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if (-not $UseCurrentEnvironment) {
    . (Join-Path $PSScriptRoot 'Enter-PortableBuildEnvironment.ps1') -DriverOnly -NoDownload
}
$build = [IO.Path]::GetFullPath((Join-Path $repo '../builds/GalaxyXR-Driver/build/bitrate-monitor/native'))
New-Item -ItemType Directory -Force -Path $build | Out-Null
$exe = Join-Path $build 'NvencFrameProbeTest.exe'
& cl.exe /nologo /std:c++17 /EHsc /W4 /O2 /MT (Join-Path $repo 'GalaxyXRDriver/tests/NvencFrameProbeTest.cpp') "/Fo$build/NvencFrameProbeTest.obj" "/Fe$exe"
if ($LASTEXITCODE -ne 0) { throw 'Frame probe regression compilation failed.' }
& $exe
if ($LASTEXITCODE -ne 0) { throw 'Frame probe regression failed.' }
