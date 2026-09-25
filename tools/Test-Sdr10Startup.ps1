$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
. (Join-Path $repo 'tools/Enter-PortableBuildEnvironment.ps1')
function Get-Function([string]$source, [string]$signature) {
    $start = $source.IndexOf($signature, [StringComparison]::Ordinal)
    if ($start -lt 0) { throw "Production function missing: $signature" }
    $open = $source.IndexOf('{', $start)
    $depth = 0
    for ($i = $open; $i -lt $source.Length; $i++) {
        if ($source[$i] -eq '{') { $depth++ }
        if ($source[$i] -eq '}') {
            $depth--
            if ($depth -eq 0) { return $source.Substring($start, $i - $start + 1) }
        }
    }
    throw "Unbalanced function: $signature"
}
$build = Join-Path $repo 'build/sdr10-startup-test'
New-Item -ItemType Directory -Force -Path $build | Out-Null
$source = Get-Content -Raw -LiteralPath (Join-Path $repo 'GalaxyXRDriver/src/Headsets/GalaxyXR.cpp')
$functions = @(
    'static void RestoreInactiveVrlinkSettings(',
    'static void SetInt32IfDifferent(',
    'static void SetBoolIfDifferent(',
    'static void RemoveBoolIfOurs(',
    'static void RemoveIntIfOursIn(',
    'static void ApplyHeadsetProfileSetting(',
    'static void ApplyVrlinkExtraKeysIn(',
    'static void ApplyVrlinkExtraKeys()',
    'void GalaxyXR_EarlyApplyVrlinkSettings()'
)
$generated = ($functions | ForEach-Object { Get-Function $source $_ }) -join "`n"
# Replace only IO boundaries; preserve all production routing/policy/control flow.
$generated = $generated.Replace('vr::VRSettings()', 'TestSettings()').Replace('gxrsettings::', 'fakejournal::')
[IO.File]::WriteAllText((Join-Path $build 'Startup.generated.h'), $generated, [Text.UTF8Encoding]::new($false))
$exe = Join-Path $build 'Sdr10StartupTest.exe'
$obj = Join-Path $build 'Sdr10StartupTest.obj'
& cl.exe /nologo /std:c++17 /EHsc /O2 /MT "/I$repo/GalaxyXRDriver/src" "/I$repo/ThirdParty/json/include" "/I$repo/ThirdParty/openvr/headers" "/I$build" (Join-Path $repo 'GalaxyXRDriver/tests/Sdr10StartupTest.cpp') "/Fo$obj" "/Fe$exe"
if ($LASTEXITCODE -ne 0) { throw "SDR10 actual startup harness compile failed: $LASTEXITCODE" }
& $exe
if ($LASTEXITCODE -ne 0) { throw "SDR10 actual startup regression failed: $LASTEXITCODE" }
