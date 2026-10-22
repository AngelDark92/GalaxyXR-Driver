[CmdletBinding()]
param([switch]$NoDownload)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'Enter-PortableBuildEnvironment.ps1') -DriverOnly -NoDownload:$NoDownload
$build = Join-Path $repo '../builds/GalaxyXR-Driver/build/toggle-migration-test'
New-Item -ItemType Directory -Force -Path $build | Out-Null
$source = [IO.File]::ReadAllText((Join-Path $repo 'GalaxyXRDriver/src/Config/ConfigLoader.cpp'))
$begin = $source.IndexOf('void ConfigLoader::ParseConfig(){')
$end = $source.IndexOf('DistortionProfileConfig ConfigLoader::ParseDistortionConfig(', $begin)
if ($begin -lt 0 -or $end -lt 0) { throw 'Production parser boundaries changed.' }
# Replace only its member qualification and IO dependencies supplied by the test.
$body = $source.Substring($begin, $end-$begin).Replace('void ConfigLoader::ParseConfig()', 'void ParseConfig()')
[IO.File]::WriteAllText((Join-Path $build 'ParseConfig.generated.h'), $body, [Text.UTF8Encoding]::new($false))
$exe = Join-Path $build 'ToggleMigrationTest.exe'
& cl.exe /nologo /EHsc /std:c++17 /O2 /MT /DVENDOR_GALAXYXR "/I$repo/GalaxyXRDriver/src" "/I$repo/ThirdParty/json/include" "/I$build" (Join-Path $repo 'GalaxyXRDriver/tests/ToggleMigrationTest.cpp') "/Fo$build/ToggleMigrationTest.obj" "/Fe$exe"
if ($LASTEXITCODE -ne 0) { throw 'Toggle migration test compilation failed.' }
# Unique test-owned fixtures make the persisted migration marker repeatable.
$fixtures = Join-Path $build ([Guid]::NewGuid().ToString('N'))
foreach ($scenario in 0..28) {
    & $exe (Join-Path $fixtures $scenario) $scenario
    if ($LASTEXITCODE -ne 0) { throw "Toggle migration scenario $scenario failed." }
}
# Successful fixtures are task-owned; keep executables for review until final cleanup.
$fixtureFullPath = [IO.Path]::GetFullPath($fixtures)
$buildFullPath = [IO.Path]::GetFullPath($build).TrimEnd('\')
if (-not $fixtureFullPath.StartsWith($buildFullPath + '\', [StringComparison]::OrdinalIgnoreCase) -or
    (Split-Path $fixtureFullPath -Leaf) -notmatch '^[a-f0-9]{32}$' -or
    ((Get-Item -LiteralPath $fixtureFullPath).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'Test fixture cleanup boundary verification failed.'
}
Remove-Item -LiteralPath $fixtureFullPath -Recurse -Force
