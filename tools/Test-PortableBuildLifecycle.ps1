# Exercise the actual build entrypoint with fixture compilers; no real build or deployment.
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$fixture = Join-Path $repo ('build/lifecycle-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
$checks = 0
$originalComSpec = $env:ComSpec
$originalCargoTarget = $env:CARGO_TARGET_DIR
$originalVendor = $env:VENDOR
$originalExitCode = $global:LASTEXITCODE

function Assert-Condition([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
    $script:checks++
}

# These function names shadow only the external processes used by the copied script.
# All directory selection, environment handling, staging order and cleanup are real.
function cl.exe {
    $outputArgument = @($args | Where-Object { "$_" -like '/Fe*' })[0]
    $binary = "$outputArgument".Substring(3)
    Set-Content -LiteralPath $binary -Value 'fixture native DLL'
    Write-Output 'Fixture native compilation'
    $global:LASTEXITCODE = 0
    if ((Split-Path $binary -Leaf) -ne 'driver_GalaxyXRNative.dll') { throw 'Unexpected native output.' }
    if ($env:PORTABLE_LIFECYCLE_FAILURE -eq 'native') { $global:LASTEXITCODE = 7 }
}
function dumpbin.exe {
    if ($args -contains '/exports') { Write-Output 'HmdDriverFactory' }
    else { Write-Output 'KERNEL32.dll' }
    $global:LASTEXITCODE = 0
}
function Invoke-FixtureNpm {
    if ($env:VENDOR -ne 'galaxyxr') { throw 'GUI build did not select Galaxy XR vendor.' }
    if ($env:CARGO_TARGET_DIR -notmatch 'portable-work-\d{8}-\d{6}-[0-9a-f]{32}[\\/]gui-target$') {
        throw "GUI compilation escaped the owned target: $env:CARGO_TARGET_DIR"
    }
    $release = Join-Path $env:CARGO_TARGET_DIR 'release'
    New-Item -ItemType Directory -Path $release -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $release 'galaxyxrdriver-gui.exe') -Value 'fixture GUI executable'
    Write-Output 'Fixture GUI compilation'
    $global:LASTEXITCODE = 0
    if ($env:PORTABLE_LIFECYCLE_FAILURE -eq 'gui') { $global:LASTEXITCODE = 9 }
}
function node {
    if ((Split-Path "$($args[0])" -Leaf) -ne 'stage-companion.cjs') { throw 'Unexpected node invocation.' }
    $global:LASTEXITCODE = 0
    if ($env:PORTABLE_LIFECYCLE_FAILURE -eq 'staging') { $global:LASTEXITCODE = 11; return }
    # Assert staging consumes this run's compilation, including the real executable name.
    if ("$($args[1])" -ne (Join-Path $env:CARGO_TARGET_DIR 'release')) { throw 'Staging used a shared Cargo target.' }
    Copy-Item -LiteralPath (Join-Path "$($args[1])" 'galaxyxrdriver-gui.exe') `
        -Destination (Join-Path "$($args[2])" 'Galaxy XR Companion.exe')
}

$originalFailure = $env:PORTABLE_LIFECYCLE_FAILURE
try {
    $env:ComSpec = 'Invoke-FixtureNpm'
    foreach ($case in @('success','keep','native-failure','gui-failure','staging-failure','setup','driver-only','gui-only')) {
        $caseRoot = Join-Path $fixture $case
        $caseTools = Join-Path $caseRoot 'tools'
        $driverFiles = Join-Path $caseRoot 'GalaxyXRDriver/DriverFiles'
        New-Item -ItemType Directory -Force -Path "$caseTools/lib", "$driverFiles/resources/settings", "$caseRoot/GalaxyXRDriverGUI" | Out-Null
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Build-Portable.ps1') -Destination $caseTools
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'lib/portable-build-cleanup.ps1') -Destination "$caseTools/lib"
        Assert-Condition ((Get-FileHash "$caseTools/Build-Portable.ps1").Hash -eq (Get-FileHash "$PSScriptRoot/Build-Portable.ps1").Hash) 'Build script fixture differs from the real entrypoint.'
        Set-Content -LiteralPath "$caseTools/Enter-PortableBuildEnvironment.ps1" -Value @'
param([switch]$DriverOnly, [switch]$GuiOnly, [switch]$NoDownload, [switch]$AcceptToolchainLicense, [switch]$PrepareDependencies)
$env:CARGO_TARGET_DIR = 'setup-target-must-be-overridden'
'@
        Set-Content -LiteralPath "$caseRoot/GalaxyXRDriver/GalaxyXRDriver.vcxproj" -Value '<Project><ItemGroup><ClCompile Include="fixture.cpp" /></ItemGroup></Project>'
        Set-Content -LiteralPath "$driverFiles/driver.vrdrivermanifest" -Value '{"name":"CustomHeadsetOpenVR"}'
        Set-Content -LiteralPath "$driverFiles/resources/settings/default.vrsettings" -Value '{"driver_CustomHeadsetOpenVR":{"Note1":"fixture"}}'
        $env:CARGO_TARGET_DIR = 'caller-target-must-survive'
        $env:VENDOR = 'neutral'
        $env:PORTABLE_LIFECYCLE_FAILURE = ''
        if ($case.EndsWith('-failure')) { $env:PORTABLE_LIFECYCLE_FAILURE = $case.Replace('-failure','') }
        $parameters = @{ OutputDirectory = "$caseRoot/output/package" }
        if ($case -eq 'keep') { $parameters.KeepBuildArtifacts = $true }
        if ($case -eq 'setup') { $parameters.SetupOnly = $true }
        if ($case -eq 'driver-only') { $parameters.DriverOnly = $true }
        if ($case -eq 'gui-only') { $parameters.GuiOnly = $true }
        $failure = $null
        $messages = @()
        try { $messages = @(& "$caseTools/Build-Portable.ps1" @parameters 3>&1) }
        catch { $failure = $_ }
        Assert-Condition ($env:CARGO_TARGET_DIR -eq 'caller-target-must-survive') "$case failed to restore Cargo target."
        Assert-Condition ($env:VENDOR -eq 'neutral') "$case failed to restore vendor."
        $expectedFailure = $case.EndsWith('-failure')
        Assert-Condition (($null -ne $failure) -eq $expectedFailure) "$case unexpected outcome: $failure"
        $work = @(Get-ChildItem -Path "$caseRoot/build/portable-work-*" -Directory -ErrorAction SilentlyContinue)
        $logs = @(Get-ChildItem -Path "$caseRoot/build/portable-logs-*" -Directory -ErrorAction SilentlyContinue)
        if ($case -eq 'setup') {
            Assert-Condition ($work.Count -eq 0 -and $logs.Count -eq 0) 'Setup-only created run folders.'
            Assert-Condition (-not (Test-Path "$caseRoot/output/package")) 'Setup-only staged a package.'
            continue
        }
        Assert-Condition ($logs.Count -eq 1) "$case lost build logs."
        $expectedWork = 0
        if ($expectedFailure -or $case -eq 'keep') { $expectedWork = 1 }
        Assert-Condition ($work.Count -eq $expectedWork) "$case work retention was incorrect."
        if ($case -ne 'gui-only') {
            Assert-Condition (Test-Path (Join-Path $logs[0].FullName 'driver-build.log')) "$case lost native log."
        }
        if ($case -notin @('driver-only','native-failure')) {
            Assert-Condition (Test-Path (Join-Path $logs[0].FullName 'gui-build.log')) "$case lost GUI log."
        }
        if ($expectedFailure) {
            Assert-Condition ((Get-ChildItem -LiteralPath $work[0].FullName -Recurse -File).Count -gt 0) "$case preserved an empty work directory."
            continue
        }
        Assert-Condition ([bool]($messages -match '^Built test package:')) "$case lacked the success marker."
        Assert-Condition ((Test-Path "$caseRoot/output/package/GalaxyXRNative/bin/win64/driver_GalaxyXRNative.dll") -eq ($case -ne 'gui-only')) "$case driver package mismatch."
        Assert-Condition ((Test-Path "$caseRoot/output/package/GalaxyXRDriverGUI/Galaxy XR Companion.exe") -eq ($case -ne 'driver-only')) "$case GUI package mismatch."
        if ($case -ne 'gui-only') {
            Assert-Condition (Test-Path (Join-Path $logs[0].FullName 'driver-exports.txt')) "$case lost export report."
            Assert-Condition (Test-Path (Join-Path $logs[0].FullName 'driver-dependencies.txt')) "$case lost dependency report."
        }
    }
} finally {
    $env:ComSpec = $originalComSpec
    $env:CARGO_TARGET_DIR = $originalCargoTarget
    $env:VENDOR = $originalVendor
    $env:PORTABLE_LIFECYCLE_FAILURE = $originalFailure
    $global:LASTEXITCODE = $originalExitCode
}
# Leave the tiny fixture packages and failed-build evidence available for inspection.
Write-Output "Portable build lifecycle: $checks checks passed. Fixture: $fixture"
