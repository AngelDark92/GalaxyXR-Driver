[CmdletBinding()]
param([switch]$UseCurrentEnvironment)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if (-not $UseCurrentEnvironment) { . (Join-Path $PSScriptRoot 'Enter-PortableBuildEnvironment.ps1') -DriverOnly }
$build = Join-Path $repo '../builds/GalaxyXR-Driver/build/hybrid-config-test'
New-Item -ItemType Directory -Force -Path $build | Out-Null

# Extract the production parser so the test exercises the real implementation.
$source = [IO.File]::ReadAllText((Join-Path $repo 'GalaxyXRDriver/src/Config/ConfigLoader.cpp'))
$begin = $source.IndexOf('void ConfigLoader::ParseConfig(){')
$end = $source.IndexOf('DistortionProfileConfig ConfigLoader::ParseDistortionConfig(', $begin)
if ($begin -lt 0 -or $end -lt 0) { throw 'Production parser boundaries changed.' }
$body = $source.Substring($begin, $end - $begin).Replace('void ConfigLoader::ParseConfig()', 'void ParseConfig()')
[IO.File]::WriteAllText((Join-Path $build 'ParseConfig.generated.h'), $body, [Text.UTF8Encoding]::new($false))

$exe = Join-Path $build 'HybridConfigTest.exe'
& cl.exe /nologo /EHsc /std:c++17 /O2 /MT /DVENDOR_GALAXYXR "/I$repo/GalaxyXRDriver/src" "/I$repo/ThirdParty/json/include" "/I$build" (Join-Path $repo 'GalaxyXRDriver/tests/HybridConfigTest.cpp') "/Fo$build/HybridConfigTest.obj" "/Fe$exe"
if ($LASTEXITCODE -ne 0) { throw 'Hybrid config test compilation failed.' }

$fixtures = Join-Path $build ([Guid]::NewGuid().ToString('N'))
& $exe $fixtures
if ($LASTEXITCODE -ne 0) { throw "Hybrid config tests failed: $LASTEXITCODE" }

# Test-owned fixture cleanup, bounded to the build directory.
$fixtureFullPath = [IO.Path]::GetFullPath($fixtures)
$buildFullPath = [IO.Path]::GetFullPath($build).TrimEnd('\')
if (-not $fixtureFullPath.StartsWith($buildFullPath + '\', [StringComparison]::OrdinalIgnoreCase) -or
    (Split-Path $fixtureFullPath -Leaf) -notmatch '^[a-f0-9]{32}$' -or
    ((Get-Item -LiteralPath $fixtureFullPath).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'Test fixture cleanup boundary verification failed.'
}
Remove-Item -LiteralPath $fixtureFullPath -Recurse -Force
Write-Host "Artifacts: $build"
