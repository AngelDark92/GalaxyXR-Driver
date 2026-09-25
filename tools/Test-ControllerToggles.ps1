[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
. (Join-Path $repo 'tools/Enter-PortableBuildEnvironment.ps1')
$build = Join-Path $repo 'build/controller-toggle-test'
New-Item -ItemType Directory -Force -Path $build | Out-Null

function Get-CodeBlock([string]$source, [string]$signature) {
    $start = $source.IndexOf($signature, [StringComparison]::Ordinal)
    if ($start -lt 0) { throw "Production block missing: $signature" }
    $open = $source.IndexOf('{', $start)
    $depth = 0
    for ($index = $open; $index -lt $source.Length; $index++) {
        if ($source[$index] -eq '{') { $depth++ }
        if ($source[$index] -eq '}') {
            $depth--
            if ($depth -eq 0) { return $source.Substring($start, $index - $start + 1) }
        }
    }
    throw "Unbalanced production block: $signature"
}
$provider = Get-Content -Raw -LiteralPath (Join-Path $repo 'GalaxyXRDriver/src/Driver/DeviceProvider.cpp')
$header = Get-Content -Raw -LiteralPath (Join-Path $repo 'GalaxyXRDriver/src/Driver/DeviceProvider.h')
$state = @('InputComponentInfo', 'MotionSnapshot', 'KalState', 'DeriveFilterState', 'VelFixState') | ForEach-Object {
    (Get-CodeBlock $header "struct $_ {") + ';'
}
[IO.File]::WriteAllText((Join-Path $build 'ControllerState.generated.h'), ($state -join "`n"), [Text.UTF8Encoding]::new($false))
$functions = @(
    'static bool InputPathInteresting(',
    'static bool NativeHandDiagnosticPath(',
    'static int TunerRoleForPath(',
    'static bool GripTouchSynthesisEnabled(',
    'void GalaxyXRDeviceProvider::OnInputComponentCreated(',
    'void GalaxyXRDeviceProvider::OnScalarComponentCreated(',
    'void GalaxyXRDeviceProvider::UpdateGripTouch(',
    'void GalaxyXRDeviceProvider::RefreshGripTouch(',
    'void GalaxyXRDeviceProvider::OnScalarComponentUpdated(',
    'void GalaxyXRDeviceProvider::OnBooleanComponentUpdated(',
    'void GalaxyXRDeviceProvider::HandleInputRelease(',
    'void GalaxyXRDeviceProvider::LogReleaseSnapshot(',
    'void GalaxyXRDeviceProvider::AnchorReleaseGesture(',
    'void GalaxyXRDeviceProvider::OnSkeletonComponentCreated(',
    'bool GalaxyXRDeviceProvider::HandleSkeletonUpdate('
)
$code = ($functions | ForEach-Object { Get-CodeBlock $provider $_ }) -join "`n"
# Replace only the OpenVR API and clock boundaries. All predicates, transitions,
# source classification, arming, logging guards, and state layouts are production.
$code = $code.Replace('vr::VRDriverInput()', 'TestDriverInput()')
$clock = 'std::chrono::duration_cast<std::chrono::microseconds>\(\s*std::chrono::steady_clock::now\(\)\.time_since_epoch\(\)\)\.count\(\) / 1000000\.0'
$code = [regex]::Replace($code, $clock, 'TestNow()')
if ($code.Contains('std::chrono::')) { throw 'Unexpected clock expression: update the explicit test-clock boundary.' }
[IO.File]::WriteAllText((Join-Path $build 'ControllerMethods.generated.h'), $code, [Text.UTF8Encoding]::new($false))

# The real provider frame loop has unrelated graphics/runtime dependencies. This
# narrow integration contract pins its unconditional OFF-release polling hook.
$plain = [regex]::Replace($provider, '(?s)/\*.*?\*/|//[^\r\n]*|"(?:\\.|[^"\\])*"', ' ')
$frame = Get-CodeBlock $plain 'void GalaxyXRDeviceProvider::RunFrame('
$poll = $frame.IndexOf('RefreshGripTouch();')
$lock = $frame.IndexOf('std::lock_guard<std::mutex> lock(driverConfigLock);')
if ($poll -lt $lock -or $lock -lt 0) { throw 'RunFrame must refresh grip touch under the current settings lock.' }
$prefix = $frame.Substring($frame.IndexOf('{') + 1, $poll - $frame.IndexOf('{') - 1)
if (([regex]::Matches($prefix, '\{').Count - [regex]::Matches($prefix, '\}').Count) -ne 0) {
    throw 'RunFrame grip-touch refresh must not depend on another feature gate.'
}

$exe = Join-Path $build 'ControllerToggleTest.exe'
$obj = Join-Path $build 'ControllerToggleTest.obj'
& cl.exe /nologo /std:c++17 /EHsc /O2 /MT "/I$repo/GalaxyXRDriver/src" "/I$repo/ThirdParty/openvr/headers" "/I$build" (Join-Path $repo 'GalaxyXRDriver/tests/ControllerToggleTest.cpp') "/Fo$obj" "/Fe$exe"
if ($LASTEXITCODE -ne 0) { throw "Controller toggle test compilation failed: $LASTEXITCODE" }
& $exe
if ($LASTEXITCODE -ne 0) { throw "Controller toggle tests failed: $LASTEXITCODE" }
Write-Host "Artifacts: $build"
