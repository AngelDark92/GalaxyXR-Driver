param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
$repo = Split-Path $PSScriptRoot -Parent
$fixtureParent = [IO.Path]::GetFullPath((Join-Path $repo '../builds/GalaxyXR-Driver/build/test-fixtures'))
$fixture = Join-Path $fixtureParent ('galaxyxr-workspace-cleanup-test-' + [Guid]::NewGuid().ToString('N'))
$sandbox = $fixture
$fixture = Join-Path $sandbox 'repo'
$originalLocalAppData = $env:LOCALAPPDATA
$originalRegistryOverride = $env:VR_PATHREG_OVERRIDE
$passed = $false
$checks = 0
$busy = $null
$junction = $null
$lockedFile = $null
function Assert([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
    $script:checks++
}
function Put([string]$Relative, [string]$Text='generated fixture') {
    $path = Join-Path $fixture $Relative
    $parent = Split-Path $path -Parent
    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    [IO.File]::WriteAllText($path, $Text)
}
function Package([string]$Name) {
    Put "output/$Name/GalaxyXRNative/driver.vrdrivermanifest" '{"name":"GalaxyXRNative"}'
    Put "output/$Name/GalaxyXRNative/resources/settings/default.vrsettings" '{}'
    Put "output/$Name/GalaxyXRNative/bin/win64/driver_GalaxyXRNative.dll"
    Put "output/$Name/GalaxyXRDriverGUI/Galaxy XR Companion.exe"
}
function Run-Cleanup([switch]$Apply, [string]$Keep=$script:keep) {
    return @(& (Join-Path $fixture 'tools/Clean-Workspace.ps1') -KeepPackage $Keep -Apply:$Apply)
}
function Expect-Failure([scriptblock]$Action, [string]$Message) {
    $failed = $false
    try { & $Action | Out-Null } catch { $failed = $true }
    Assert $failed $Message
}
try {
    New-Item -ItemType Directory -Path (Join-Path $fixture 'tools') -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Clean-Workspace.ps1') -Destination (Join-Path $fixture 'tools/Clean-Workspace.ps1')
    # A real isolated Git repository exercises tracked-file protection. Only the
    # test process uses fake OpenVR registration, restored in finally.
    & git init --quiet $fixture
    if ($LASTEXITCODE -ne 0) { throw 'Cannot initialize fixture repository.' }
    Put 'GalaxyXRDriver/DriverFiles/driver.vrdrivermanifest' '{"name":"GalaxyXRNative"}'
    Put 'GalaxyXRDriver/DriverFiles/resources/settings/default.vrsettings' '{}'
    Put 'source.txt' 'preserve tracked source'
    Put '.gitignore' "/output/`n/build/"
    & git -C $fixture add -- GalaxyXRDriver source.txt .gitignore
    if ($LASTEXITCODE -ne 0) { throw 'Cannot index fixture source.' }
    $keep = 'output/GalaxyXRDriver-Test-20260101-000001'
    $old = 'output/GalaxyXRDriver-Test-20260101-000002'
    $unknown = 'output/GalaxyXRDriver-Test-20260101-000003'
    $partial = 'output/GalaxyXRDriver-Test-20260101-000004'
    $tracked = 'output/GalaxyXRDriver-Test-20260101-000005'
    $linked = 'output/GalaxyXRDriver-Test-20260101-000006'
    foreach ($name in @($keep,$old,$unknown,$tracked,$linked)) { Package (Split-Path $name -Leaf) }
    Put "$unknown/personal-note.txt" 'user data'
    Put "$partial/GalaxyXRNative/driver.vrdrivermanifest" '{"name":"GalaxyXRNative"}'
    & git -C $fixture add --force -- "$tracked/GalaxyXRNative/bin/win64/driver_GalaxyXRNative.dll"
    if ($LASTEXITCODE -ne 0) { throw 'Cannot index generated-looking fixture file.' }
    Put 'output/user-backup/important.txt' 'user backup'
    Put 'build/portable-objects-20260101-000001/unit.obj'
    Put 'build/portable-objects-20260101-000001/driver-build.log' 'preserve build evidence'
    Put 'build/portable-objects-20260101-000002/unit.obj'
    Put 'build/portable-objects-20260101-000002/personal.txt' 'reject this entire object directory'
    Put 'build/portable-work-20260101-000001-failed/failure.obj' 'preserve failed work'
    Put 'build/toolchains/compiler.exe' 'preserve toolchain'
    Put 'GalaxyXRDriverGUI/node_modules/package/source.js' 'preserve dependency'
    Put 'ThirdParty/source.h' 'preserve vendored source'
    foreach ($cache in @('output/GalaxyXRDriverGUI','GalaxyXRDriverGUI/src-tauri/target')) {
        Put "$cache/CACHEDIR.TAG" 'Signature: 8a477f597d28d172789f06886806bc55'
        Put "$cache/.rustc_info.json" '{"rustc_fingerprint":123}'
        Put "$cache/debug/.fingerprint/pkg-1234567890abcdef/lib-pkg.json" '{}'
        Put "$cache/debug/deps/pkg-1234567890abcdef.rlib"
    }
    Put 'outside-junction/sentinel.txt' 'must survive'
    $junction = Join-Path $fixture "$linked/linked-user-folder"
    New-Item -ItemType Junction -Path $junction -Target (Join-Path $fixture 'outside-junction') | Out-Null
    $env:LOCALAPPDATA = Join-Path $fixture 'fake-localappdata'
    $env:VR_PATHREG_OVERRIDE = $null
    Put 'fake-localappdata/openvr/openvrpaths.vrpath' '{"external_drivers":[]}'
    $receipt = Join-Path $fixture '../builds/GalaxyXR-Driver/build/workspace-cleanup-last.json'
    $preview = Run-Cleanup
    Assert (Test-Path -LiteralPath (Join-Path $fixture $old)) 'Preview deleted a package.'
    Assert (-not (Test-Path -LiteralPath $receipt)) 'Preview wrote a receipt.'
    Assert ([bool]($preview -match 'Reparse point')) 'Junction was not rejected.'
    Assert ([bool]($preview -match 'Tracked path protected')) 'Tracked package file was not protected.'
    Assert ([bool]($preview -match 'Unknown package file')) 'Unknown package addition was not protected.'
    Assert ([bool]($preview -match 'Incomplete package')) 'Partial package was not protected.'
    Expect-Failure { Run-Cleanup -Apply -Keep '../escape' } 'Parent traversal accepted.'
    Expect-Failure { Run-Cleanup -Apply -Keep (Join-Path $fixture $keep) } 'Absolute keep path accepted.'
    Expect-Failure { Run-Cleanup -Apply -Keep $partial } 'Incomplete keep package accepted.'
    $env:VR_PATHREG_OVERRIDE = Join-Path $fixture 'custom-openvr-registry.json'
    Expect-Failure { Run-Cleanup -Apply } 'OpenVR registry override was ignored.'
    $env:VR_PATHREG_OVERRIDE = $null
    Put 'fake-localappdata/openvr/openvrpaths.vrpath' ((@{external_drivers=@((Join-Path $fixture "$old/GalaxyXRNative"))} | ConvertTo-Json -Compress))
    Expect-Failure { Run-Cleanup -Apply } 'Registered external driver was deleted.'
    Assert (Test-Path -LiteralPath (Join-Path $fixture $old)) 'Registration failure mutated package.'
    $registrationAlias = Join-Path $fixture 'registered-driver-alias'
    New-Item -ItemType Junction -Path $registrationAlias -Target (Join-Path $fixture "$old/GalaxyXRNative") | Out-Null
    Put 'fake-localappdata/openvr/openvrpaths.vrpath' ((@{external_drivers=@($registrationAlias)} | ConvertTo-Json -Compress))
    Expect-Failure { Run-Cleanup -Apply } 'Registered driver junction alias was ignored.'
    Assert (Test-Path -LiteralPath (Join-Path $fixture $old)) 'Registration alias failure mutated package.'
    [IO.Directory]::Delete($registrationAlias)
    Put 'fake-localappdata/openvr/openvrpaths.vrpath' '{"external_drivers":[]}'
    $processArgs = '-NoProfile -Command "Start-Sleep -Seconds 60 # ' + (Join-Path $fixture $old) + '"'
    $busy = Start-Process -FilePath 'powershell.exe' -ArgumentList $processArgs -WindowStyle Hidden -PassThru
    Expect-Failure { Run-Cleanup -Apply } 'Active process using candidate was ignored.'
    Stop-Process -Id $busy.Id -Force
    $busy.WaitForExit()
    $busy = $null
    Run-Cleanup -Apply | Out-Null
    Assert (-not (Test-Path -LiteralPath (Join-Path $fixture $old))) 'Old package remained.'
    Assert (-not (Test-Path -LiteralPath (Join-Path $fixture 'output/GalaxyXRDriverGUI'))) 'Cargo output cache remained.'
    Assert (-not (Test-Path -LiteralPath (Join-Path $fixture 'GalaxyXRDriverGUI/src-tauri/target'))) 'Local Cargo cache remained.'
    Assert (-not (Test-Path -LiteralPath (Join-Path $fixture 'build/portable-objects-20260101-000001/unit.obj'))) 'Object remained.'
    foreach ($preserved in @($keep,$unknown,$partial,$tracked,$linked,'outside-junction/sentinel.txt',
        'source.txt','output/user-backup/important.txt','build/portable-objects-20260101-000001/driver-build.log',
        'build/portable-objects-20260101-000002/unit.obj','build/portable-work-20260101-000001-failed/failure.obj',
        'build/toolchains/compiler.exe','GalaxyXRDriverGUI/node_modules/package/source.js','ThirdParty/source.h')) {
        Assert (Test-Path -LiteralPath (Join-Path $fixture $preserved)) "Protected content removed: $preserved"
    }
    $first = Get-Content -LiteralPath $receipt -Raw | ConvertFrom-Json
    Assert ($first.status -eq 'complete' -and $first.logicalBytesRemoved -gt 0) 'Apply receipt incomplete.'
    Assert (($first.keptPackageHashesBefore | ConvertTo-Json -Compress) -ceq ($first.keptPackageHashesAfter | ConvertTo-Json -Compress)) 'Kept package hashes changed.'
    $receiptHash = (Get-FileHash -LiteralPath $receipt).Hash
    Run-Cleanup | Out-Null
    Assert ((Get-FileHash -LiteralPath $receipt).Hash -eq $receiptHash) 'Preview replaced existing receipt.'
    Run-Cleanup -Apply | Out-Null
    $second = Get-Content -LiteralPath $receipt -Raw | ConvertFrom-Json
    Assert ($second.logicalBytesRemoved -eq 0 -and $second.status -eq 'complete') 'Repeat cleanup is not idempotent.'
    $lockedPackage = 'output/GalaxyXRDriver-Test-20260101-000007'
    Package (Split-Path $lockedPackage -Leaf)
    $beforeLockFailure = @(Get-ChildItem -LiteralPath (Join-Path $fixture $lockedPackage) -Recurse -File | ForEach-Object {
        [pscustomobject]@{path=$_.FullName; bytes=$_.Length}
    })
    $lockedFile = [IO.File]::Open((Join-Path $fixture "$lockedPackage/GalaxyXRDriverGUI/Galaxy XR Companion.exe"), [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
    Expect-Failure { Run-Cleanup -Apply } 'Locked-file removal did not fail.'
    $lockedFile.Dispose()
    $lockedFile = $null
    $failure = Get-Content -LiteralPath $receipt -Raw | ConvertFrom-Json
    $actuallyRemoved = [long]0
    foreach ($file in $beforeLockFailure) { if (-not (Test-Path -LiteralPath $file.path)) { $actuallyRemoved += $file.bytes } }
    Assert ($failure.status -eq 'failed') 'Locked-file failure receipt is not marked failed.'
    Assert ($failure.logicalBytesRemoved -eq $actuallyRemoved) 'Partial deletion bytes were not recorded accurately.'
    Assert ($failure.partiallyRemovedCandidate -eq $lockedPackage) 'Partial candidate absent from failure receipt.'
    $passed = $true
} finally {
    $env:LOCALAPPDATA = $originalLocalAppData
    $env:VR_PATHREG_OVERRIDE = $originalRegistryOverride
    if ($lockedFile) { $lockedFile.Dispose() }
    if ($busy -and -not $busy.HasExited) { Stop-Process -Id $busy.Id -Force }
    if ($passed) {
        # Remove only this known junction itself, never its target. Then inspect
        # every remaining descendant without following any link before cleanup.
        if ($junction -and (Test-Path -LiteralPath $junction)) { [IO.Directory]::Delete($junction) }
        $full = [IO.Path]::GetFullPath($sandbox).TrimEnd('\')
        $temp = $fixtureParent.TrimEnd('\')
        if ((Split-Path $full -Parent) -ne $temp -or (Split-Path $full -Leaf) -notmatch '^galaxyxr-workspace-cleanup-test-[0-9a-f]{32}$') { throw 'Unsafe fixture cleanup path.' }
        $ancestor = $full
        while ($ancestor) {
            if ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Fixture ancestor is a link: $ancestor" }
            $ancestor = Split-Path $ancestor -Parent
        }
        $pending = New-Object 'System.Collections.Generic.Stack[string]'
        $pending.Push($full)
        while ($pending.Count) {
            foreach ($item in @(Get-ChildItem -LiteralPath $pending.Pop() -Force)) {
                if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Fixture contains unexpected link: $($item.FullName)" }
                if ($item.PSIsContainer) { $pending.Push($item.FullName) }
            }
        }
        Remove-Item -LiteralPath $full -Recurse -Force
    } else { Write-Warning "Failed fixture retained: $fixture" }
}
Write-Output "Workspace cleanup tests passed: $checks assertions; fixture removed."
