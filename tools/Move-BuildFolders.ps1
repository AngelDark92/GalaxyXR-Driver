param([switch]$Apply)
# External artifacts (2026-10-08): preserve packages, caches and evidence by
# moving exact known directories, never by deleting a generic folder name.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
$repo = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent)).TrimEnd('\')
$destinationRoot = [IO.Path]::GetFullPath((Join-Path $repo '../builds/GalaxyXR-Driver')).TrimEnd('\')
$comparison = [StringComparison]::OrdinalIgnoreCase
function Within([string]$Path, [string]$Parent) {
    return $Path.StartsWith($Parent + '\', $comparison)
}
function Assert-Ancestors([string]$Path) {
    while ($Path) {
        if (Test-Path -LiteralPath $Path) {
            $item = Get-Item -LiteralPath $Path -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Linked path protected: $Path" }
        }
        $Path = Split-Path $Path -Parent
    }
}
function Inventory([string]$Path) {
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        return @([pscustomobject]@{path=''; bytes=(Get-Item -LiteralPath $Path).Length})
    }
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $pending.Push($Path)
    $files = New-Object 'System.Collections.Generic.List[object]'
    while ($pending.Count) {
        foreach ($item in @(Get-ChildItem -LiteralPath $pending.Pop() -Force)) {
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Linked descendant protected: $($item.FullName)" }
            if ($item.Name -eq '.git') { throw "Nested repository protected: $($item.FullName)" }
            if ($item.PSIsContainer) { $pending.Push($item.FullName) }
            else { $files.Add([pscustomobject]@{path=$item.FullName.Substring($Path.Length + 1); bytes=$item.Length}) }
        }
    }
    return @($files.ToArray() | Sort-Object path)
}
Assert-Ancestors $repo
Assert-Ancestors $destinationRoot
$tracked = @(& git -C $repo -c core.quotepath=false ls-files)
if ($LASTEXITCODE -ne 0 -or -not $tracked.Count) { throw 'Tracked-file inventory unavailable.' }
$mappings = @(
    @('build','build'), @('output','output'), @('release','release'),
    @('GalaxyXRDriverGUI/build','gui/build'), @('GalaxyXRDriverGUI/dist','gui/dist'),
    @('GalaxyXRDriverGUI/src-tauri/target','gui/target'),
    @('GalaxyXRDriverGUI/src-tauri/gen/schemas','gui/legacy-schemas'),
    @('GalaxyXRDriverGUI/node_modules/.vite','gui/cache/vite'),
    @('GalaxyXRDriverGUI/node_modules/.vite-temp','gui/cache/legacy-config-loader'),
    @('GalaxyXRDriver/x64','build/legacy-native/x64'),
    @('GalaxyXRDriver/Win32','build/legacy-native/Win32'),
    @('x64','build/legacy-solution/x64'), @('Win32','build/legacy-solution/Win32'),
    @('lib','build/legacy-solution/lib')
)
$plan = New-Object 'System.Collections.Generic.List[object]'
$emptyParents = New-Object 'System.Collections.Generic.List[string]'
$expanded = New-Object 'System.Collections.Generic.List[object]'
foreach ($mapping in $mappings) {
    $source = Join-Path $repo $mapping[0]
    $destination = Join-Path $destinationRoot $mapping[1]
    Assert-Ancestors $source
    Assert-Ancestors $destination
    if (-not (Test-Path -LiteralPath $source -PathType Container)) { continue }
    if ($mapping[0] -in @('GalaxyXRDriverGUI/build','GalaxyXRDriverGUI/dist') -and (Test-Path -LiteralPath $destination)) {
        # A focused frontend check may already have generated the new layout.
        # Preserve the original directory separately instead of overwriting it.
        $mapping = @($mapping[0], ('gui/migration-original/' + (Split-Path $source -Leaf)))
        $destination = Join-Path $destinationRoot $mapping[1]
        Assert-Ancestors $destination
    }
    if (Test-Path -LiteralPath $destination -PathType Container) {
        # Other projects already use this explicit root. Add disjoint children;
        # a name collision still fails before any move, without overwriting.
        $emptyParents.Add([IO.Path]::GetFullPath($source))
        foreach ($child in @(Get-ChildItem -LiteralPath $source -Force)) {
            $expanded.Add(@(($mapping[0] + '/' + $child.Name), ($mapping[1] + '/' + $child.Name)))
        }
    } else { $expanded.Add($mapping) }
}
foreach ($mapping in $expanded) {
    $source = [IO.Path]::GetFullPath((Join-Path $repo $mapping[0]))
    $destination = [IO.Path]::GetFullPath((Join-Path $destinationRoot $mapping[1]))
    if (-not (Within $source $repo) -or -not (Within $destination $destinationRoot)) { throw 'Move escapes the explicit boundary.' }
    Assert-Ancestors $source
    Assert-Ancestors $destination
    if (-not (Test-Path -LiteralPath $source)) { continue }
    if (Test-Path -LiteralPath $destination) { throw "Destination already exists; no merge or overwrite: $destination" }
    foreach ($file in $tracked) {
        if ($file -eq $mapping[0] -or $file.StartsWith($mapping[0] + '/', $comparison)) { throw "Tracked path protected: $file" }
    }
    $files = @(Inventory $source)
    $bytes = [long]0
    foreach ($file in $files) { $bytes += $file.bytes }
    $plan.Add([pscustomobject]@{source=$source; destination=$destination; bytes=$bytes; files=$files})
    Write-Output "MOVE $source -> $destination ($($files.Count) files, $bytes bytes)"
}
function Assert-Idle($Candidates=$plan) {
    if ($env:VR_PATHREG_OVERRIDE) { throw 'Audit the overridden OpenVR registry before moving artifacts.' }
    foreach ($process in @(Get-CimInstance Win32_Process)) {
        if ($process.ProcessId -eq $PID) { continue }
        if ($process.Name -match '^(cl|link|msbuild|rustc|cargo|cmake|ninja)\.exe$') { throw "Build process active: $($process.ProcessId)" }
        if ($process.CommandLine -match '(?i)(?:node(?:\.exe)?["'']?\s+["'']?(?:[^\s"'']*[\\/])?(?:build\.js|vite(?:\.js)?)(?:[\s"'']|$)|-File\s+["'']?(?:[^\s"'']*[\\/])?Build-Portable\.ps1(?:[\s"'']|$))') { throw "Build command active: $($process.ProcessId)" }
        foreach ($entry in $Candidates) {
            if (($process.ExecutablePath -and (Within $process.ExecutablePath $entry.source)) -or
                ($process.CommandLine -and $process.CommandLine.IndexOf($entry.source, $comparison) -ge 0)) { throw "Artifact in use: process $($process.ProcessId)" }
        }
    }
    if (-not $env:LOCALAPPDATA) { throw 'OpenVR registry location unavailable.' }
    $registry = Join-Path $env:LOCALAPPDATA 'openvr/openvrpaths.vrpath'
    Assert-Ancestors $registry
    if (Test-Path -LiteralPath $registry) {
        $config = Get-Content -Raw -LiteralPath $registry | ConvertFrom-Json
        if ($config.PSObject.Properties['external_drivers']) {
            foreach ($registered in @($config.external_drivers)) {
                if (-not $registered -or -not [IO.Path]::IsPathRooted($registered)) { throw 'Invalid OpenVR registration.' }
                $full = [IO.Path]::GetFullPath($registered).TrimEnd('\')
                Assert-Ancestors $full
                foreach ($entry in $Candidates) {
                    if ($full.Equals($entry.source,$comparison) -or (Within $full $entry.source) -or (Within $entry.source $full)) { throw "Registered driver protected: $full" }
                }
            }
        }
    }
}
Assert-Idle
if (-not $Apply) { return }
$receipt = [ordered]@{startedUtc=[DateTime]::UtcNow.ToString('o'); logicalBytesMoved=[long]0; moved=@(); status='running'}
New-Item -ItemType Directory -Force -Path $destinationRoot | Out-Null
$receiptPath = Join-Path $destinationRoot 'build-folder-migration.json'
try {
    foreach ($entry in $plan) {
        Assert-Idle @($entry)
        Assert-Ancestors $entry.source
        Assert-Ancestors $entry.destination
        if (Test-Path -LiteralPath $entry.destination) { throw "Destination appeared: $($entry.destination)" }
        $before = @(Inventory $entry.source)
        if (($before | ConvertTo-Json -Compress) -cne ($entry.files | ConvertTo-Json -Compress)) { throw 'Source changed after preview.' }
        New-Item -ItemType Directory -Force -Path (Split-Path $entry.destination -Parent) | Out-Null
        Move-Item -LiteralPath $entry.source -Destination $entry.destination
        $after = @(Inventory $entry.destination)
        if (($before | ConvertTo-Json -Compress) -cne ($after | ConvertTo-Json -Compress)) { throw "Moved file inventory differs: $($entry.destination)" }
        $receipt.logicalBytesMoved += $entry.bytes
        $receipt.moved += [pscustomobject]@{source=$entry.source; destination=$entry.destination; bytes=$entry.bytes; files=$before.Count}
        Write-Output "Moved and verified: $($entry.destination)"
    }
    foreach ($parent in $emptyParents) {
        Assert-Ancestors $parent
        if (-not (Within $parent $repo) -or @(Get-ChildItem -LiteralPath $parent -Force).Count) { throw "Source parent is not safely empty: $parent" }
        [IO.Directory]::Delete($parent)
    }
    $receipt.status = 'complete'
} catch { $receipt.status = 'failed'; $receipt['error'] = $_.Exception.Message; throw }
finally {
    $receipt['finishedUtc'] = [DateTime]::UtcNow.ToString('o')
    [IO.File]::WriteAllText($receiptPath, ($receipt | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
}
Write-Output "Moved $($receipt.logicalBytesMoved) logical bytes. Receipt: $receiptPath"
