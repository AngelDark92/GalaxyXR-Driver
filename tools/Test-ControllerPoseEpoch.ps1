[CmdletBinding()]
param([string]$CaptureDirectory, [string]$ReplayOutput, [switch]$UseCurrentEnvironment)
$ErrorActionPreference = 'Stop'
if ([bool]$CaptureDirectory -ne [bool]$ReplayOutput) { throw 'Specify both capture directory and replay output.' }
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $UseCurrentEnvironment) { . (Join-Path $PSScriptRoot 'Enter-PortableBuildEnvironment.ps1') }
$outputDirectory = Join-Path $repoRoot 'build/controller-pose-epoch-test'
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$source = Join-Path $repoRoot 'GalaxyXRDriver/tests/ControllerPoseEpochTest.cpp'
$headers = Join-Path $repoRoot 'ThirdParty/openvr/headers'
$executable = Join-Path $outputDirectory 'ControllerPoseEpochTest.exe'
$objectFile = Join-Path $outputDirectory 'ControllerPoseEpochTest.obj'
& cl.exe /nologo /std:c++17 /EHsc /O2 /W4 /WX /MT "/external:I$headers" /external:W0 $source "/Fo$objectFile" "/Fe$executable"
if ($LASTEXITCODE -ne 0) { throw "Epoch test compilation failed: $LASTEXITCODE" }
if ($CaptureDirectory) { & $executable $CaptureDirectory $ReplayOutput } else { & $executable }
if ($LASTEXITCODE -ne 0) { throw "Epoch tests failed: $LASTEXITCODE" }

# Compile the actual provider methods for both vendor configurations. Replace
# only the clock boundary, leaving routing/config and rebase logic unchanged.
$provider = Get-Content -Raw (Join-Path $repoRoot 'GalaxyXRDriver/src/Driver/DeviceProvider.cpp')
$start = $provider.IndexOf('void GalaxyXRDeviceProvider::ResetControllerPoseEpoch(')
$end = $provider.IndexOf('bool GalaxyXRDeviceProvider::HandleDevicePoseUpdated(', $start)
if ($start -lt 0 -or $end -le $start) { throw 'Production timing method boundaries missing.' }
$methods = $provider.Substring($start, $end - $start).Replace('gxr::PoseCallbackTime()', 'TestPoseClock()')
[IO.File]::WriteAllText((Join-Path $outputDirectory 'EpochMethods.generated.h'), $methods, [Text.UTF8Encoding]::new($false))
foreach ($vendor in @('galaxyxr', 'neutral')) {
    $defines = @(if ($vendor -eq 'galaxyxr') { '/DVENDOR_GALAXYXR' })
    $integration = Join-Path $outputDirectory "EpochIntegration-$vendor.exe"
    & cl.exe /nologo /std:c++17 /EHsc /O2 /MT @defines "/I$headers" "/I$repoRoot/GalaxyXRDriver/src" "/I$outputDirectory" (Join-Path $repoRoot 'GalaxyXRDriver/tests/ControllerPoseEpochIntegrationTest.cpp') "/Fo$outputDirectory/EpochIntegration-$vendor.obj" "/Fe$integration"
    if ($LASTEXITCODE -ne 0) { throw "Production epoch integration compilation failed: $vendor" }
    & $integration
    if ($LASTEXITCODE -ne 0) { throw "Production epoch integration failed: $vendor" }
}
