#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$Output,
    [string]$SevenZipPath,
    [ValidateRange(0, 9)][int]$CompressionLevel = 5,
    [switch]$Force,
    [switch]$NoChecksum
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-Application {
    param([Parameter(Mandatory=$true)][string[]]$Names)
    foreach ($name in $Names) {
        $command = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -ne $command) { return $command.Source }
    }
    return $null
}

$gitPath = Resolve-Application @('git.exe', 'git')
if (-not $gitPath) {
    throw "Git is required so the ZIP uses the repository's actual .gitignore rules."
}

function Resolve-SevenZip {
    param([string]$RequestedPath)

    if ($RequestedPath) {
        $candidate = [IO.Path]::GetFullPath($RequestedPath)
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            throw "7-Zip executable not found: $candidate"
        }
        return $candidate
    }

    $fromPath = Resolve-Application @('7z.exe', '7zz.exe', '7za.exe', '7z', '7zz', '7za')
    if ($fromPath) { return $fromPath }

    $candidates = New-Object 'System.Collections.Generic.List[string]'
    if ($env:ProgramFiles) { $candidates.Add((Join-Path $env:ProgramFiles '7-Zip\7z.exe')) }
    if (${env:ProgramFiles(x86)}) { $candidates.Add((Join-Path ${env:ProgramFiles(x86)} '7-Zip\7z.exe')) }
    if ($env:LOCALAPPDATA) { $candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\7-Zip\7z.exe')) }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return [IO.Path]::GetFullPath($candidate) }
    }

    throw '7-Zip was not found. Install 7-Zip, add 7z.exe to PATH, or pass -SevenZipPath "C:\Program Files\7-Zip\7z.exe".'
}

$sevenZip = Resolve-SevenZip $SevenZipPath

# PowerShell unwraps a one-item pipeline result into a scalar. Every caller
# wraps this function in @(...), because StrictMode makes scalar .Count invalid.
function Invoke-GitLines {
    param(
        [Parameter(Mandatory=$true)][string]$WorkingDirectory,
        [Parameter(Mandatory=$true)][string[]]$Arguments
    )
    $oldPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $lines = @(& $gitPath -C $WorkingDirectory @Arguments 2>$null)
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $oldPreference
    }
    if ($code -ne 0) {
        throw "Git command failed in '$WorkingDirectory': git $($Arguments -join ' ')"
    }
    return @($lines | ForEach-Object { $_.ToString() })
}

function Invoke-SevenZip {
    param(
        [Parameter(Mandatory=$true)][string]$WorkingDirectory,
        [Parameter(Mandatory=$true)][string[]]$Arguments
    )
    $oldPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    Push-Location -LiteralPath $WorkingDirectory
    try {
        & $sevenZip @Arguments
        $code = $LASTEXITCODE
    } finally {
        Pop-Location
        $ErrorActionPreference = $oldPreference
    }
    # Exit code 1 is a warning in 7-Zip, but this script promises all selected
    # files. Treat warnings (locked/skipped files, etc.) as an incomplete ZIP.
    if ($code -ne 0) {
        throw "7-Zip failed with exit code $code. The temporary archive is not published."
    }
}

$rootLines = @(Invoke-GitLines -WorkingDirectory $PSScriptRoot -Arguments @('rev-parse', '--show-toplevel'))
if ($rootLines.Count -ne 1 -or -not $rootLines[0]) {
    throw 'Could not determine the Git repository root.'
}
$root = [IO.Path]::GetFullPath($rootLines[0].Trim()).TrimEnd('\','/')
$rootPrefix = $root + [IO.Path]::DirectorySeparatorChar
$artifactRoot = [IO.Path]::GetFullPath((Join-Path $root '../builds/GalaxyXR-Driver')).TrimEnd('\','/')

if (-not $Output) {
    $projectName = Split-Path $root -Leaf
    $Output = Join-Path $artifactRoot ("release/source/$projectName-source-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.zip')
} elseif (-not [IO.Path]::IsPathRooted($Output)) {
    $Output = Join-Path (Get-Location).Path $Output
}
$outputPath = [IO.Path]::GetFullPath($Output)
if ([IO.Path]::GetExtension($outputPath) -ine '.zip') { $outputPath += '.zip' }
if (-not $outputPath.StartsWith($artifactRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Source archives must stay under $artifactRoot"
}
$ancestor = $outputPath
while ($ancestor) {
    if ((Test-Path -LiteralPath $ancestor) -and ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Linked archive destination: $ancestor"
    }
    $ancestor = Split-Path $ancestor -Parent
}
$checksumPath = $outputPath + '.sha256'

if (Test-Path -LiteralPath $outputPath) {
    if (-not $Force) { throw "Output already exists: $outputPath. Use -Force to replace it." }
    Remove-Item -LiteralPath $outputPath -Force
}
if (-not $NoChecksum -and (Test-Path -LiteralPath $checksumPath)) {
    if (-not $Force) { throw "Checksum already exists: $checksumPath. Use -Force to replace it." }
    Remove-Item -LiteralPath $checksumPath -Force
}
New-Item -ItemType Directory -Force -Path (Split-Path $outputPath -Parent) | Out-Null

function Get-TopRelativePath {
    param([Parameter(Mandatory=$true)][string]$FullPath)
    $full = [IO.Path]::GetFullPath($FullPath)
    if (-not $full.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to archive a path outside the repository: $full"
    }
    return $full.Substring($rootPrefix.Length).Replace('\','/')
}

# Process each initialized Git worktree separately. This keeps an initialized
# submodule/nested repository governed by its own .gitignore rules.
$queue = New-Object 'System.Collections.Generic.Queue[string]'
$queue.Enqueue($root)
$seenWorktrees = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
$archiveFiles = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::Ordinal)
$skippedLinks = New-Object 'System.Collections.Generic.List[string]'

while ($queue.Count -gt 0) {
    $worktree = [IO.Path]::GetFullPath($queue.Dequeue()).TrimEnd('\','/')
    if (-not $seenWorktrees.Add($worktree)) { continue }

    $top = @(Invoke-GitLines -WorkingDirectory $worktree -Arguments @('rev-parse', '--show-toplevel'))
    if ($top.Count -ne 1 -or [IO.Path]::GetFullPath($top[0].Trim()).TrimEnd('\','/') -ine $worktree) {
        throw "Nested Git worktree could not be verified: $worktree"
    }

    # Tracked + untracked files that are NOT ignored.
    $candidates = @(Invoke-GitLines -WorkingDirectory $worktree -Arguments @('-c', 'core.quotePath=false', 'ls-files', '--cached', '--others', '--exclude-standard'))
    # Also remove tracked files that now match ignore rules. This makes the
    # resulting source ZIP obey the current ignore policy even for old commits.
    $ignoredTrackedLines = @(Invoke-GitLines -WorkingDirectory $worktree -Arguments @('-c', 'core.quotePath=false', 'ls-files', '-ci', '--exclude-standard'))
    $ignoredTracked = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
    foreach ($line in $ignoredTrackedLines) {
        if ($line) { [void]$ignoredTracked.Add($line.Replace('\','/')) }
    }

    foreach ($line in $candidates) {
        if (-not $line) { continue }
        $relative = $line.Replace('\','/')
        if ($ignoredTracked.Contains($relative)) { continue }

        $full = [IO.Path]::GetFullPath((Join-Path $worktree $relative))

        # A submodule can have either a .git directory or a .git file.
        if (Test-Path -LiteralPath $full -PathType Container) {
            if (Test-Path -LiteralPath (Join-Path $full '.git')) { $queue.Enqueue($full) }
            continue
        }
        if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { continue }

        # Never follow links/junctions outside the checkout.
        $item = Get-Item -LiteralPath $full -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            $skippedLinks.Add((Get-TopRelativePath $full))
            continue
        }

        if ($full -ieq $outputPath -or $full -ieq $checksumPath) { continue }
        $entry = Get-TopRelativePath $full
        if ($entry -eq '.git' -or $entry.StartsWith('.git/')) { continue }
        $archiveFiles[$entry] = $full
    }
}

if ($archiveFiles.Count -eq 0) { throw 'No non-ignored files were found to archive.' }

# 7-Zip accepts a UTF-8 newline-separated @listfile. Use repository-relative
# names while running 7-Zip from the repository root, so the archive contains
# the project directly rather than absolute drive paths.
$listFile = Join-Path (Split-Path $outputPath -Parent) ('GalaxyXRDriver-7zip-list-' + [Guid]::NewGuid().ToString('N') + '.txt')
$tempZip = $outputPath + '.partial-' + [Guid]::NewGuid().ToString('N')
try {
    $entries = @($archiveFiles.Keys | Sort-Object | ForEach-Object { $_.Replace('/', '\') })
    [IO.File]::WriteAllLines($listFile, $entries, [Text.UTF8Encoding]::new($false))

    Write-Host "Using 7-Zip: $sevenZip"
    Write-Host ("Archiving {0:N0} non-ignored file(s)..." -f $entries.Count)

    Invoke-SevenZip -WorkingDirectory $root -Arguments @(
        'a', '-tzip', "-mx=$CompressionLevel", '-mmt=on', '-scsUTF-8', '-bd', '-y',
        $tempZip, ("@$listFile")
    )

    # Never publish an archive that 7-Zip cannot read back cleanly.
    Invoke-SevenZip -WorkingDirectory $root -Arguments @('t', '-bd', '-y', $tempZip)

    if (-not (Test-Path -LiteralPath $tempZip -PathType Leaf) -or (Get-Item -LiteralPath $tempZip).Length -eq 0) {
        throw '7-Zip returned success but did not create a nonempty archive.'
    }
    Move-Item -LiteralPath $tempZip -Destination $outputPath
} catch {
    if (Test-Path -LiteralPath $tempZip) { Remove-Item -LiteralPath $tempZip -Force }
    throw
} finally {
    if (Test-Path -LiteralPath $listFile) { Remove-Item -LiteralPath $listFile -Force }
}

if (-not $NoChecksum) {
    $hash = (Get-FileHash -LiteralPath $outputPath -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText($checksumPath, "$hash  $([IO.Path]::GetFileName($outputPath))`r`n", [Text.UTF8Encoding]::new($false))
}

$zipSize = (Get-Item -LiteralPath $outputPath).Length
Write-Host "Created: $outputPath"
Write-Host ("Files selected: {0:N0}  ZIP size: {1:N0} bytes  Compression: -mx={2}" -f $archiveFiles.Count, $zipSize, $CompressionLevel)
if (-not $NoChecksum) { Write-Host "SHA-256: $checksumPath" }
if ($skippedLinks.Count -gt 0) {
    Write-Warning ("Skipped {0} reparse-point/symlink path(s) rather than following them outside the checkout:`n  {1}" -f $skippedLinks.Count, ($skippedLinks -join "`n  "))
}
