[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'Enter-PortableBuildEnvironment.ps1')
$outputDirectory = Join-Path $repoRoot '../builds/GalaxyXR-Driver/build/companion-settings-test'
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$source = Join-Path $repoRoot 'GalaxyXRDriver/tests/CompanionSettingsTest.cpp'
$headers = Join-Path $repoRoot 'ThirdParty/openvr/headers'
$jsonHeaders = Join-Path $repoRoot 'ThirdParty/json/include'
$executable = Join-Path $outputDirectory 'CompanionSettingsTest.exe'
$objectFile = Join-Path $outputDirectory 'CompanionSettingsTest.obj'
# Pure routing, recovery planning and icon-map checks. Do not define
# VENDOR_GALAXYXR here: this Windows test must not compile live settings I/O.
& cl.exe /nologo /std:c++17 /EHsc /O2 /MT "/I$headers" "/I$jsonHeaders" $source "/Fo$objectFile" "/Fe$executable"
if ($LASTEXITCODE -ne 0) { throw "Companion test compilation failed: $LASTEXITCODE" }
& $executable
if ($LASTEXITCODE -ne 0) { throw "Companion tests failed: $LASTEXITCODE" }
Write-Host "Artifacts: $outputDirectory"
