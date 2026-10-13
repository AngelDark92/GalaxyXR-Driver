[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'Enter-PortableBuildEnvironment.ps1')
$outputDirectory = Join-Path $repoRoot '../builds/GalaxyXR-Driver/build/steamvr-settings-journal-test'
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$source = Join-Path $repoRoot 'GalaxyXRDriver/tests/SteamVRSettingsJournalTest.cpp'
$headers = Join-Path $repoRoot 'ThirdParty/openvr/headers'
$jsonHeaders = Join-Path $repoRoot 'ThirdParty/json/include'
$executable = Join-Path $outputDirectory 'SteamVRSettingsJournalTest.exe'
$objectFile = Join-Path $outputDirectory 'SteamVRSettingsJournalTest.obj'
# RecordChange tests only. No VENDOR_GALAXYXR: live settings IO is not compiled.
& cl.exe /nologo /std:c++17 /EHsc /O2 /MT "/I$headers" "/I$jsonHeaders" $source "/Fo$objectFile" "/Fe$executable"
if ($LASTEXITCODE -ne 0) { throw "Journal test compilation failed: $LASTEXITCODE" }
& $executable
if ($LASTEXITCODE -ne 0) { throw "Journal tests failed: $LASTEXITCODE" }
Write-Host "Artifacts: $outputDirectory"
