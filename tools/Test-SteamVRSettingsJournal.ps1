[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'Enter-PortableBuildEnvironment.ps1')
$outputDirectory = Join-Path $repoRoot '../builds/GalaxyXR-Driver/build/steamvr-settings-journal-test'
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$headers = Join-Path $repoRoot 'ThirdParty/openvr/headers'
$jsonHeaders = Join-Path $repoRoot 'ThirdParty/json/include'

# 1. Pure RecordChange / lossless JSON tests. No VENDOR_GALAXYXR: live settings IO is not compiled.
$source = Join-Path $repoRoot 'GalaxyXRDriver/tests/SteamVRSettingsJournalTest.cpp'
$executable = Join-Path $outputDirectory 'SteamVRSettingsJournalTest.exe'
$objectFile = Join-Path $outputDirectory 'SteamVRSettingsJournalTest.obj'
& cl.exe /nologo /std:c++17 /EHsc /O2 /MT "/I$headers" "/I$jsonHeaders" $source "/Fo$objectFile" "/Fe$executable"
if ($LASTEXITCODE -ne 0) { throw "Journal test compilation failed: $LASTEXITCODE" }
& $executable
if ($LASTEXITCODE -ne 0) { throw "Journal tests failed: $LASTEXITCODE" }

# 2. Live-IO path (VENDOR_GALAXYXR) against a fake IVRSettings and isolated APPDATA/LOCALAPPDATA
# trees under the external output directory. The executable never touches real SteamVR or user data.
$ioSource = Join-Path $repoRoot 'GalaxyXRDriver/tests/SteamVRSettingsJournalIoTest.cpp'
$ioExecutable = Join-Path $outputDirectory 'SteamVRSettingsJournalIoTest.exe'
$ioObject = Join-Path $outputDirectory 'SteamVRSettingsJournalIoTest.obj'
& cl.exe /nologo /std:c++17 /EHsc /O2 /MT /DVENDOR_GALAXYXR "/I$headers" "/I$jsonHeaders" $ioSource "/Fo$ioObject" "/Fe$ioExecutable"
if ($LASTEXITCODE -ne 0) { throw "Journal IO test compilation failed: $LASTEXITCODE" }
& $ioExecutable $outputDirectory
if ($LASTEXITCODE -ne 0) { throw "Journal IO tests failed: $LASTEXITCODE" }
Write-Host "Artifacts: $outputDirectory"
