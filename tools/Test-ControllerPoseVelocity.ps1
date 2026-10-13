[CmdletBinding()]
param([string]$CaptureDirectory, [string]$ReplayOutput, [switch]$UseCurrentEnvironment)
$ErrorActionPreference = 'Stop'
if ([bool]$CaptureDirectory -ne [bool]$ReplayOutput) { throw 'Specify both capture directory and replay output.' }
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $UseCurrentEnvironment) { . (Join-Path $PSScriptRoot 'Enter-PortableBuildEnvironment.ps1') }
$outputDirectory = Join-Path $repoRoot 'build/controller-pose-velocity-test'
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$provider = Get-Content -Raw (Join-Path $repoRoot 'GalaxyXRDriver/src/Driver/DeviceProvider.cpp')
$qStart = $provider.IndexOf('static vr::HmdQuaternion_t QuatMultiply(')
$qEnd = $provider.IndexOf('int GalaxyXRDeviceProvider::GetDeviceClass(', $qStart)
$start = $provider.IndexOf('bool GalaxyXRDeviceProvider::HandleDevicePoseUpdated(')
$end = $provider.IndexOf('// capture the post-offset pose per hand', $start)
if ($qStart -lt 0 -or $qEnd -le $qStart -or $start -lt 0 -or $end -le $start) { throw 'Production layout boundaries missing.' }
$methods = $provider.Substring($qStart, $qEnd-$qStart) + $provider.Substring($start, $end-$start) + "`n(void)rawPoseValid; (void)rawResult; return true; }`n"
[IO.File]::WriteAllText((Join-Path $outputDirectory 'LayoutMethods.generated.h'), $methods, [Text.UTF8Encoding]::new($false))
$headers = Join-Path $repoRoot 'ThirdParty/openvr/headers'
foreach ($vendor in @('galaxyxr', 'neutral')) {
    $defines = @(if ($vendor -eq 'galaxyxr') { '/DVENDOR_GALAXYXR' })
    $exe = Join-Path $outputDirectory "ControllerPoseVelocity-$vendor.exe"
    & cl.exe /nologo /std:c++17 /EHsc /O2 /W4 /WX /MT @defines "/external:I$headers" /external:W0 "/I$repoRoot/GalaxyXRDriver/src" "/I$outputDirectory" (Join-Path $repoRoot 'GalaxyXRDriver/tests/ControllerPoseVelocityTest.cpp') "/Fo$outputDirectory/ControllerPoseVelocity-$vendor.obj" "/Fe$exe"
    if ($LASTEXITCODE -ne 0) { throw "Velocity test compilation failed: $vendor" }
    if ($CaptureDirectory -and $vendor -eq 'galaxyxr') { & $exe $CaptureDirectory $ReplayOutput } else { & $exe }
    if ($LASTEXITCODE -ne 0) { throw "Velocity tests failed: $vendor" }
}
