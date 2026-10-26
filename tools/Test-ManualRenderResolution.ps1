$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'Enter-PortableBuildEnvironment.ps1')
$build = Join-Path $repo '../builds/GalaxyXR-Driver/build/manual-render-resolution-test'
New-Item -ItemType Directory -Force -Path $build | Out-Null
$source = [IO.File]::ReadAllText((Join-Path $repo 'GalaxyXRDriver/src/Config/ConfigLoader.cpp'))
$begin = $source.IndexOf('void ConfigLoader::ParseConfig(){')
$end = $source.IndexOf('DistortionProfileConfig ConfigLoader::ParseDistortionConfig(', $begin)
if ($begin -lt 0 -or $end -lt 0) { throw 'Production parser boundaries changed.' }
$body = $source.Substring($begin, $end-$begin).Replace('void ConfigLoader::ParseConfig()', 'void ParseConfig()')
[IO.File]::WriteAllText((Join-Path $build 'ParseConfig.generated.h'), $body, [Text.UTF8Encoding]::new($false))
$source = [IO.File]::ReadAllText((Join-Path $repo 'GalaxyXRDriver/src/Headsets/GalaxyXR.cpp'))
$begin = $source.IndexOf('static void ApplyNativeResolutionSetting(){')
$end = $source.IndexOf('// ---------------- HMD', $begin)
if ($begin -lt 0 -or $end -lt 0) { throw 'Resolution writer boundaries changed.' }
$body = $source.Substring($begin, $end-$begin).Replace('static void ApplyNativeResolutionSetting()', 'void ApplyResolutionForTest()')
[IO.File]::WriteAllText((Join-Path $build 'ResolutionWriter.generated.h'), $body, [Text.UTF8Encoding]::new($false))
$exe = Join-Path $build 'ManualRenderResolutionTest.exe'
& cl.exe /nologo /EHsc /std:c++17 /O2 /MT /DVENDOR_GALAXYXR "/I$repo/GalaxyXRDriver/src" "/I$repo/ThirdParty/json/include" "/I$build" (Join-Path $repo 'GalaxyXRDriver/tests/ManualRenderResolutionTest.cpp') "/Fo$build/ManualRenderResolutionTest.obj" "/Fe$exe"
if ($LASTEXITCODE -ne 0) { throw 'Manual resolution test compilation failed.' }
$fixture = [IO.Path]::GetFullPath((Join-Path $build ([Guid]::NewGuid().ToString('N'))))
& $exe $fixture
if ($LASTEXITCODE -ne 0) { throw 'Manual resolution tests failed.' }
$boundary = [IO.Path]::GetFullPath($build).TrimEnd('\') + '\'
if (-not $fixture.StartsWith($boundary, [StringComparison]::OrdinalIgnoreCase) -or
    ((Get-Item -LiteralPath $fixture).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe fixture cleanup target.' }
Remove-Item -LiteralPath $fixture -Recurse -Force

# Execute the production post-GetComponent callback, display wrapper constructor,
# wrapper dispatch macro and render recommendation callback with fake display I/O.
function Get-ProductionFunction([string]$text, [string]$signature) {
    $start = $text.IndexOf($signature, [StringComparison]::Ordinal)
    if ($start -lt 0) { throw "Production function missing: $signature" }
    $open = $text.IndexOf('{', $start)
    $depth = 0
    for ($index = $open; $index -lt $text.Length; $index++) {
        if ($text[$index] -eq '{') { $depth++ }
        if ($text[$index] -eq '}') {
            $depth--
            if ($depth -eq 0) { return $text.Substring($start, $index-$start+1) }
        }
    }
    throw "Unbalanced function: $signature"
}
$shimSource = [IO.File]::ReadAllText((Join-Path $repo 'GalaxyXRDriver/src/Driver/DeviceShim.cpp'))
$macroStart = $shimSource.IndexOf('#define SHIM_CALL_RETURNS(')
$macroEnd = $shimSource.IndexOf('SHIM_CALL_RETURNS(ShimTrackedDeviceDriver, Activate', $macroStart)
if ($macroStart -lt 0 -or $macroEnd -lt 0) { throw 'Display dispatch macro boundaries changed.' }
$macro = $shimSource.Substring($macroStart, $macroEnd-$macroStart)
$calls = @($shimSource -split '\r?\n' | Where-Object { $_ -match '^SHIM_CALL_\w+\(ShimDisplayComponent,' })
if ($calls.Count -ne 8) { throw 'Display callback dispatch table changed.' }
$call = $calls -join "`n"
$constructor = Get-ProductionFunction $shimSource 'ShimDisplayComponent::ShimDisplayComponent('
$owner = Get-ProductionFunction $source 'static bool IsComponentOwnedByModule('
$wrap = (Get-ProductionFunction $source 'void GalaxyXRHmdShim::PosTrackedDeviceGetComponent(').Replace('GalaxyXRHmdShim::', 'RenderTargetTestShim::')
$recommend = (Get-ProductionFunction $source 'void GalaxyXRHmdShim::PosDisplayComponentGetRecommendedRenderTargetSize(').Replace('GalaxyXRHmdShim::', 'RenderTargetTestShim::')
$generated = "$constructor`n#define COMMA ,`n$macro`n$call`n$owner`n$wrap`n$recommend`n"
[IO.File]::WriteAllText((Join-Path $build 'RenderRecommendation.generated.h'), $generated, [Text.UTF8Encoding]::new($false))
$exe = Join-Path $build 'RenderRecommendationTest.exe'
& cl.exe /nologo /EHsc /std:c++17 /O2 /MT "/I$repo/GalaxyXRDriver/src" "/I$repo/ThirdParty/openvr/headers" "/I$build" (Join-Path $repo 'GalaxyXRDriver/tests/RenderRecommendationTest.cpp') "/Fo$build/RenderRecommendationTest.obj" "/Fe$exe"
if ($LASTEXITCODE -ne 0) { throw 'Render recommendation test compilation failed.' }
& $exe
if ($LASTEXITCODE -ne 0) { throw 'Render recommendation tests failed.' }
