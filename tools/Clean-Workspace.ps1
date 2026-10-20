param(
    [Parameter(Mandatory=$true)][string]$KeepPackage,
    [switch]$Apply
)
# Workspace retention (2026-09-26): explicit package selection, preview first,
# and positive generated-file identification; never use git clean here.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
$repo = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent)).TrimEnd('\', '/')
$artifacts = [IO.Path]::GetFullPath((Join-Path $repo '../builds/GalaxyXR-Driver')).TrimEnd('\', '/')
$packagePattern = '^GalaxyXRDriver-(Neutral-)?Test-\d{8}-\d{6}$'
$comparison = [StringComparison]::OrdinalIgnoreCase

function Test-Within([string]$Path, [string]$Parent) {
    return $Path.Equals($Parent, $comparison) -or $Path.StartsWith($Parent + '\', $comparison)
}
function Assert-Ancestors([string]$Path) {
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse point: $current" }
        }
        $current = Split-Path $current -Parent
    }
}
function Get-SafeTree([string]$Path) {
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    if ((-not (Test-Within $full $repo) -and -not (Test-Within $full $artifacts)) -or
        $full.Equals($repo, $comparison) -or $full.Equals($artifacts, $comparison)) { throw "Path escapes cleanup boundary: $full" }
    Assert-Ancestors $full
    if (-not (Get-Item -LiteralPath $full -Force).PSIsContainer) { throw "Not a directory: $full" }
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $pending.Push($full)
    while ($pending.Count) {
        foreach ($item in @(Get-ChildItem -LiteralPath $pending.Pop() -Force)) {
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse point: $($item.FullName)" }
            if (-not (Test-Within $item.FullName $full)) { throw "Path escapes candidate: $($item.FullName)" }
            $item
            if ($item.PSIsContainer) { $pending.Push($item.FullName) }
        }
    }
}
function Get-Relative([string]$Path, [string]$Parent=$repo) {
    if ($Parent -eq $repo -and (Test-Within $Path $artifacts)) { $Parent = $artifacts }
    return $Path.Substring($Parent.Length + 1).Replace('\', '/')
}
function Get-TrackedPaths {
    $paths = @(& git -C $repo -c core.quotepath=false ls-files)
    if ($LASTEXITCODE -ne 0 -or -not $paths.Count) { throw 'Cannot establish tracked-file protection.' }
    $set = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($path in $paths) { [void]$set.Add($path.Replace('\', '/')) }
    return ,$set
}
function Assert-Untracked([string]$Path) {
    if (Test-Within $Path $artifacts) { return }
    $relative = Get-Relative $Path
    foreach ($tracked in $script:trackedPaths) {
        if ($tracked.Equals($relative, $comparison) -or $tracked.StartsWith($relative + '/', $comparison)) {
            throw "Tracked path protected: $tracked"
        }
    }
}
function Get-PackageFiles([string]$Path, [switch]$ForDeletion) {
    if ((Split-Path $Path -Parent) -notin @((Join-Path $repo 'output'), (Join-Path $artifacts 'output')) -or (Split-Path $Path -Leaf) -notmatch $packagePattern) {
        throw 'Only a recognized direct-child test package is supported.'
    }
    $tree = @(Get-SafeTree $Path)
    $driver = 'GalaxyXRNative'
    if ((Split-Path $Path -Leaf) -like 'GalaxyXRDriver-Neutral-*') { $driver = 'CustomHeadsetOpenVR' }
    $allowed = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($resource in $script:driverResources) { [void]$allowed.Add("$driver/$resource") }
    [void]$allowed.Add("$driver/bin/win64/driver_$driver.dll")
    [void]$allowed.Add('GalaxyXRDriverGUI/Galaxy XR Companion.exe')
    # payload files shipped beside the Companion (W5a)
    [void]$allowed.Add('GalaxyXRDriverGUI/ofxr/XR_APILAYER_XRFrameBridge_diagnostic.dll')
    [void]$allowed.Add('GalaxyXRDriverGUI/ofxr/ofxr_bridge.ini')
    [void]$allowed.Add('GalaxyXRDriverGUI/ofxr/payload.json')
    [void]$allowed.Add('GalaxyXRDriverGUI/ofxr/LICENSE')
    [void]$allowed.Add('GalaxyXRDriverGUI/ofxr/NOTICE')
    foreach ($relative in $allowed) {
        $file = Join-Path $Path $relative
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Incomplete package, missing $relative" }
    }
    foreach ($relative in @("$driver/bin/win64/driver_$driver.dll", 'GalaxyXRDriverGUI/Galaxy XR Companion.exe')) {
        if ((Get-Item -LiteralPath (Join-Path $Path $relative)).Length -le 0) { throw "Empty package binary: $relative" }
    }
    $manifest = Get-Content -LiteralPath (Join-Path $Path "$driver/driver.vrdrivermanifest") -Raw | ConvertFrom-Json
    if ($manifest.name -cne $driver) { throw "Unexpected driver manifest name: $($manifest.name)" }
    if ($ForDeletion) {
        foreach ($item in $tree) {
            $relative = Get-Relative $item.FullName $Path
            if ($item.PSIsContainer) {
                if (-not @($allowed | Where-Object { $_.StartsWith($relative + '/', $comparison) }).Count) { throw "Unknown package directory: $relative" }
            } elseif (-not $allowed.Contains($relative)) { throw "Unknown package file: $relative" }
        }
    }
    return @($tree | Where-Object { -not $_.PSIsContainer })
}
function Get-Hashes([string]$Path) {
    return @(Get-PackageFiles $Path | Sort-Object FullName | ForEach-Object {
        [pscustomobject]@{ path=(Get-Relative $_.FullName $Path); bytes=$_.Length; sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }
    })
}
function Assert-KeptPackage {
    $now = Get-Hashes $script:keep
    if (($now | ConvertTo-Json -Compress) -cne ($script:keepHashes | ConvertTo-Json -Compress)) { throw 'Kept package changed; stopping cleanup.' }
}
function Get-CargoFiles([string]$Path) {
    $tree = @(Get-SafeTree $Path)
    $tag = Join-Path $Path 'CACHEDIR.TAG'
    if (-not (Test-Path -LiteralPath $tag -PathType Leaf) -or
        (Get-Content -LiteralPath $tag -Raw) -notmatch '^Signature: 8a477f597d28d172789f06886806bc55') { throw 'Cargo cache marker missing.' }
    $info = Get-Content -LiteralPath (Join-Path $Path '.rustc_info.json') -Raw | ConvertFrom-Json
    if (-not $info.PSObject.Properties['rustc_fingerprint']) { throw 'Cargo compiler marker missing.' }
    if (-not @($tree | Where-Object { $_.PSIsContainer -and $_.Name -eq '.fingerprint' }).Count) { throw 'Cargo generated layout missing.' }
    foreach ($item in $tree) {
        $p = Get-Relative $item.FullName $Path
        if ($item.PSIsContainer) {
            if ($p -match '^(debug|release)(/(\.fingerprint|build|deps|examples|incremental)(/.*)?)?$') { continue }
        } else {
            if ($p -match '^(CACHEDIR\.TAG|\.rustc_info\.json)$') { continue }
            if ($p -match '^(debug|release)/(\.cargo(-artifact|-build)?-lock|galaxyxrdriver[-_]gui\.(exe|pdb|d))$') { continue }
            if ($p -match '^(debug|release)/(deps|examples)/[^/]+\.(d|dll|exe|exp|lib|pdb|rlib|rmeta)$') { continue }
            if ($p -match '^(debug|release)/\.fingerprint/[^/]+-[0-9a-f]{16}/(invoked\.timestamp|(?:dep-|output-)?(?:lib|bin|test-lib|test-bin|run-build-script|build-script)-[\w-]+(?:\.json)?)$') { continue }
            if ($p -match '^(debug|release)/build/[^/]+-[0-9a-f]{16}/(invoked\.timestamp|output|root-output|stderr|build[-_]script[-_]build(?:-[0-9a-f]{16})?\.(d|exe|pdb))$') { continue }
            if ($p -match '^(debug|release)/build/[^/]+-[0-9a-f]{16}/out/.+\.(a|css|dll|gif|html|ico|js|json|lib|ll|md|o|png|rc|rs|svg|timestamp|toml)$') { continue }
            if ($p -match '^(debug|release)/build/[^/]+-[0-9a-f]{16}/out/(?:.*/)?([0-9a-f]{64}|checked_features|__app__-permission-files|tauri-(core|plugin)(-[\w-]+)?-permission-files)$') { continue }
            if ($p -match '^(debug|release)/incremental/[^/]+/[\w-]+/metadata\.rmeta$' -or
                $p -match '^(debug|release)/incremental/[^/]+/[\w-]+/(dep-graph|query-cache|work-products)\.bin$' -or
                $p -match '^(debug|release)/incremental/[^/]+/[\w-]+/[^/]+\.(o|obj|pre-lto\.bc)$' -or
                $p -match '^(debug|release)/incremental/[^/]+/[\w-]+\.lock$') { continue }
        }
        throw "Unknown Cargo cache entry: $p"
    }
    return @($tree | Where-Object { -not $_.PSIsContainer })
}
function Get-ObjectFiles([string]$Path) {
    $tree = @(Get-SafeTree $Path)
    foreach ($item in $tree) {
        if ($item.PSIsContainer) { throw "Unknown object directory: $($item.Name)" }
        if ($item.Name -in @('driver-build.log','driver-dependencies.txt','driver-exports.txt')) { continue }
        if ($item.Extension -notin @('.obj','.dll','.lib','.exp','.pdb','.ilk')) { throw "Unknown object file: $($item.Name)" }
    }
    return @($tree | Where-Object { $_.Extension -in @('.obj','.dll','.lib','.exp','.pdb','.ilk') })
}
function Get-CandidateFiles($Candidate) {
    Assert-Untracked $Candidate.path
    switch ($Candidate.kind) {
        'package' { return @(Get-PackageFiles $Candidate.path -ForDeletion) }
        'cargo' { return @(Get-CargoFiles $Candidate.path) }
        'objects' { return @(Get-ObjectFiles $Candidate.path) }
        default { throw 'Unknown candidate type.' }
    }
}
function Assert-Idle($Candidates) {
    # This is read-only. Missing process/registration evidence fails closed.
    if ($env:VR_PATHREG_OVERRIDE) { throw 'VR_PATHREG_OVERRIDE is set; preserve caches/packages until the active OpenVR registry is explicitly audited.' }
    $processes = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
    if (-not $processes.Count) { throw 'Process inspection unavailable.' }
    foreach ($process in $processes) {
        if ($process.ProcessId -eq $PID) { continue }
        if ($process.Name -match '^(cl|link|msbuild|rustc|cargo|cmake|ninja)\.exe$') { throw "Build process active: $($process.Name) ($($process.ProcessId))" }
        if ($process.Name -match '^(node|powershell|pwsh)\.exe$' -and -not $process.CommandLine) { throw "Cannot inspect build-capable process $($process.ProcessId)." }
        if ($process.CommandLine -match '(?i)(?:node(?:\.exe)?["'']?\s+["'']?(?:[^\s"'']*[\\/])?(?:build\.js|vite(?:\.js)?)(?:[\s"'']|$)|-File\s+["'']?(?:[^\s"'']*[\\/])?Build-Portable\.ps1(?:[\s"'']|$))') {
            throw "Build command active: process $($process.ProcessId)"
        }
        foreach ($candidate in $Candidates) {
            if (($process.ExecutablePath -and (Test-Within $process.ExecutablePath $candidate.path)) -or
                ($process.CommandLine -and $process.CommandLine.IndexOf($candidate.path, $comparison) -ge 0)) { throw "Candidate is in use by process $($process.ProcessId)." }
        }
    }
    if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA unavailable; cannot inspect SteamVR registration.' }
    $registry = Join-Path $env:LOCALAPPDATA 'openvr/openvrpaths.vrpath'
    Assert-Ancestors $registry
    if (Test-Path -LiteralPath $registry) {
        $config = Get-Content -LiteralPath $registry -Raw | ConvertFrom-Json
        if ($config.PSObject.Properties['external_drivers']) {
            foreach ($registered in @($config.external_drivers)) {
                if (-not $registered -or -not [IO.Path]::IsPathRooted($registered)) { throw 'Invalid registered external driver path.' }
                $full = [IO.Path]::GetFullPath($registered).TrimEnd('\', '/')
                Assert-Ancestors $full
                foreach ($candidate in $Candidates) {
                    if ((Test-Within $full $candidate.path) -or (Test-Within $candidate.path $full)) { throw "Registered SteamVR driver protected: $full" }
                }
            }
        }
    }
}

Assert-Ancestors $repo
Assert-Ancestors $artifacts
if ([IO.Path]::IsPathRooted($KeepPackage) -or $KeepPackage -match '(^|[\\/])\.\.([\\/]|$)') { throw 'KeepPackage must be relative to builds/GalaxyXR-Driver without parent traversal.' }
$keep = [IO.Path]::GetFullPath((Join-Path $artifacts $KeepPackage)).TrimEnd('\', '/')
# Legacy packages remain reviewable during migration; new builds always use artifacts.
if (-not (Test-Path -LiteralPath $keep)) { $keep = [IO.Path]::GetFullPath((Join-Path $repo $KeepPackage)).TrimEnd('\', '/') }
$trackedPaths = Get-TrackedPaths
$driverResources = @($trackedPaths | Where-Object { $_.StartsWith('GalaxyXRDriver/DriverFiles/', $comparison) } | ForEach-Object { $_.Substring('GalaxyXRDriver/DriverFiles/'.Length) })
if ('driver.vrdrivermanifest' -notin $driverResources -or $driverResources.Count -lt 2) { throw 'Tracked driver resource inventory unavailable.' }
$keepHashes = Get-Hashes $keep
$candidates = New-Object 'System.Collections.Generic.List[object]'
$skipped = New-Object 'System.Collections.Generic.List[object]'
$possible = New-Object 'System.Collections.Generic.List[object]'
foreach ($base in @($artifacts, $repo)) {
foreach ($parent in @('output','build')) {
    $directory = Join-Path $base $parent
    Assert-Ancestors $directory
    if (-not (Test-Path -LiteralPath $directory)) { continue }
    foreach ($item in @(Get-ChildItem -LiteralPath $directory -Force)) {
        if ($item.FullName.Equals($keep, $comparison)) { continue }
        $kind = $null
        if ($parent -eq 'output' -and $item.Name -match $packagePattern) { $kind = 'package' }
        if ($parent -eq 'output' -and $item.Name -eq 'GalaxyXRDriverGUI') { $kind = 'cargo' }
        if ($parent -eq 'build' -and $item.Name -match '^portable-objects-\d{8}-\d{6}$') { $kind = 'objects' }
        if ($kind) { $possible.Add([pscustomobject]@{path=$item.FullName; kind=$kind}) }
        elseif ($parent -eq 'output') { $skipped.Add([pscustomobject]@{path=(Get-Relative $item.FullName); reason='Unrecognized output; preserved.'}) }
    }
}
}
$localCargo = Join-Path $repo 'GalaxyXRDriverGUI/src-tauri/target'
if (Test-Path -LiteralPath $localCargo) { $possible.Add([pscustomobject]@{path=$localCargo; kind='cargo'}) }
$movedCargo = Join-Path $artifacts 'gui/target'
if (Test-Path -LiteralPath $movedCargo) { $possible.Add([pscustomobject]@{path=$movedCargo; kind='cargo'}) }
foreach ($candidate in $possible) {
    try {
        $files = @(Get-CandidateFiles $candidate)
        if (-not $files.Count) { continue }
        $bytes = [long]0
        foreach ($file in $files) { $bytes += $file.Length }
        $candidates.Add([pscustomobject]@{path=$candidate.path; kind=$candidate.kind; bytes=$bytes; files=$files.Count})
    } catch { $skipped.Add([pscustomobject]@{path=(Get-Relative $candidate.path); reason=$_.Exception.Message}) }
}
$bytesPlanned = [long]0
foreach ($candidate in $candidates) { $bytesPlanned += $candidate.bytes }
Write-Output "Keep: $(Get-Relative $keep) ($($keepHashes.Count) SHA256 hashes)"
Write-Output "Eligible: $($candidates.Count) locations; $bytesPlanned logical bytes. Apply: $([bool]$Apply)"
foreach ($candidate in $candidates) { Write-Output "DELETE $($candidate.kind): $(Get-Relative $candidate.path) ($($candidate.bytes) bytes)" }
foreach ($entry in $skipped) { Write-Output "KEEP $($entry.path): $($entry.reason)" }
if (-not $Apply) { return }

Assert-Idle $candidates
Assert-KeptPackage
$receiptPath = Join-Path $artifacts 'build/workspace-cleanup-last.json'
Assert-Ancestors $receiptPath
Assert-Untracked $receiptPath
$receipt = [ordered]@{
    startedUtc=[DateTime]::UtcNow.ToString('o'); status='running'; keepPackage=(Get-Relative $keep)
    keptPackageHashesBefore=$keepHashes; keptPackageHashesAfter=@(); logicalBytesRemoved=[long]0
    removed=@(); skipped=@($skipped.ToArray()); protected='Sources, unknown output, partial packages, logs, failed work, diagnostics, dependencies and toolchains.'
}
function Save-Receipt {
    Assert-Ancestors $receiptPath
    [IO.File]::WriteAllText($receiptPath, ($receipt | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding $false))
}
if (-not (Test-Path -LiteralPath (Split-Path $receiptPath -Parent))) { New-Item -ItemType Directory -Path (Split-Path $receiptPath -Parent) | Out-Null }
Save-Receipt
try {
    foreach ($candidate in $candidates) {
        # Recheck live registrations/processes, tracked paths, links and contents
        # immediately before every candidate mutation.
        Assert-Idle @($candidate)
        $trackedPaths = Get-TrackedPaths
        $files = @(Get-CandidateFiles $candidate)
        Assert-KeptPackage
        if ($candidate.kind -eq 'objects') {
            foreach ($file in $files) {
                Assert-Ancestors $file.FullName
                Assert-Untracked $file.FullName
                $length = (Get-Item -LiteralPath $file.FullName -Force).Length
                Remove-Item -LiteralPath $file.FullName -Force
                $receipt.logicalBytesRemoved += $length
                $receipt.removed += Get-Relative $file.FullName
            }
        } else {
            $length = [long]0
            foreach ($file in $files) { $length += $file.Length }
            try { Remove-Item -LiteralPath $candidate.path -Recurse -Force } catch {
                # Recursive removal can succeed for earlier files before a lock
                # fails it. Preserve those facts in the failure receipt.
                foreach ($file in $files) {
                    if (-not (Test-Path -LiteralPath $file.FullName)) {
                        $receipt.logicalBytesRemoved += $file.Length
                        $receipt.removed += Get-Relative $file.FullName
                    }
                }
                $receipt['partiallyRemovedCandidate'] = Get-Relative $candidate.path
                throw
            }
            $receipt.logicalBytesRemoved += $length
            $receipt.removed += Get-Relative $candidate.path
        }
        Save-Receipt
    }
    Assert-KeptPackage
    $receipt.keptPackageHashesAfter = Get-Hashes $keep
    $receipt.status = 'complete'
} catch {
    $receipt.status = 'failed'
    $receipt['error'] = $_.Exception.Message
    throw
} finally {
    $receipt['finishedUtc'] = [DateTime]::UtcNow.ToString('o')
    Save-Receipt
}
Write-Output "Removed $($receipt.logicalBytesRemoved) logical bytes. Receipt: $receiptPath"
