[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'Enter-PortableBuildEnvironment.ps1')
$outputDirectory = Join-Path $repoRoot 'build/controller-pose-dispatch-test'
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$source = Join-Path $repoRoot 'GalaxyXRDriver/tests/ControllerPoseDispatchTest.cpp'
$headers = Join-Path $repoRoot 'ThirdParty/openvr/headers'
$executable = Join-Path $outputDirectory 'ControllerPoseDispatchTest.exe'
$objectFile = Join-Path $outputDirectory 'ControllerPoseDispatchTest.obj'
# Fake provider and submit callback only; never loads or deploys a SteamVR driver.
& cl.exe /nologo /std:c++17 /EHsc /O2 /MT "/I$headers" $source "/Fo$objectFile" "/Fe$executable"
if ($LASTEXITCODE -ne 0) { throw "Controller pose dispatch test compilation failed: $LASTEXITCODE" }
& $executable
if ($LASTEXITCODE -ne 0) { throw "Controller pose dispatch tests failed: $LASTEXITCODE" }
Write-Host "Artifacts: $outputDirectory"
