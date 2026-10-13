param(
    [Parameter(Mandatory=$true)][string]$Version,
    [string]$Commit,
    [string]$Tag,
    [string]$StagingDirectory,
    [string]$ReleaseDirectory
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent

& (Join-Path $PSScriptRoot 'Verify-ReleaseVersion.ps1') -ExpectedVersion $Version -Tag $Tag

if (-not $Commit) {
    $Commit = (& git -C $repo rev-parse HEAD).Trim()
}
if (-not $ReleaseDirectory) { $ReleaseDirectory = Join-Path $repo '../builds/GalaxyXR-Driver/release' }
$ReleaseDirectory = [IO.Path]::GetFullPath($ReleaseDirectory)
if (-not $ReleaseDirectory.StartsWith([IO.Path]::GetFullPath((Join-Path $repo '../builds/GalaxyXR-Driver')) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'ReleaseDirectory must be inside builds/GalaxyXR-Driver.'
}
New-Item -ItemType Directory -Force -Path $ReleaseDirectory | Out-Null

if (-not $StagingDirectory) {
    $preferred = Join-Path $repo "../builds/GalaxyXR-Driver/output/GalaxyXRDriver-STAGING-$Version-Galaxyxr-Windows"
    if (Test-Path -LiteralPath $preferred -PathType Container) {
        $StagingDirectory = $preferred
    } else {
        $matches = @(Get-ChildItem -LiteralPath (Join-Path $repo '../builds/GalaxyXR-Driver/output') -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like "GalaxyXRDriver-STAGING-$Version-*-Windows" -and (Test-Path -LiteralPath (Join-Path $_.FullName 'GalaxyXRNative')) })
        if ($matches.Count -ne 1) {
            throw "Could not uniquely locate the Galaxy XR staging directory for version $Version. Pass -StagingDirectory explicitly."
        }
        $StagingDirectory = $matches[0].FullName
    }
}
$StagingDirectory = [IO.Path]::GetFullPath($StagingDirectory)

$required = @(
    'GalaxyXRDriverGUI/Galaxy XR Companion.exe',
    'GalaxyXRNative/driver.vrdrivermanifest',
    'GalaxyXRNative/bin/win64/driver_GalaxyXRNative.dll',
    'GalaxyXRNative/resources/settings/default.vrsettings'
)
foreach ($relative in $required) {
    $path = Join-Path $StagingDirectory $relative
    if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or (Get-Item -LiteralPath $path).Length -eq 0) {
        throw "Release staging is incomplete: $relative"
    }
}

# Parse the two JSON files that are rewritten during staging. This catches BOM/
# truncation mistakes before a release is published.
Get-Content -Raw -LiteralPath (Join-Path $StagingDirectory 'GalaxyXRNative/driver.vrdrivermanifest') | ConvertFrom-Json | Out-Null
Get-Content -Raw -LiteralPath (Join-Path $StagingDirectory 'GalaxyXRNative/resources/settings/default.vrsettings') | ConvertFrom-Json | Out-Null

$packageName = "GalaxyXRDriver-v$Version-Windows-x64"
$workRoot = Join-Path $repo '../builds/GalaxyXR-Driver/build/github-release'
$packageRoot = Join-Path $workRoot $packageName
if (Test-Path -LiteralPath $packageRoot) { Remove-Item -LiteralPath $packageRoot -Recurse -Force }
New-Item -ItemType Directory -Force -Path $packageRoot | Out-Null

Copy-Item -LiteralPath (Join-Path $StagingDirectory 'GalaxyXRDriverGUI') -Destination $packageRoot -Recurse -Force
Copy-Item -LiteralPath (Join-Path $StagingDirectory 'GalaxyXRNative') -Destination $packageRoot -Recurse -Force
Copy-Item -LiteralPath (Join-Path $repo 'CREDITS.md') -Destination $packageRoot -Force
Copy-Item -LiteralPath (Join-Path $repo 'CHANGELOG.md') -Destination $packageRoot -Force

$builtUtc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
@(
    "Galaxy XR Companion $Version",
    "Commit: $Commit",
    "Built UTC: $builtUtc"
) | Set-Content -LiteralPath (Join-Path $packageRoot 'VERSION.txt') -Encoding UTF8

$changelog = Get-Content -Raw -LiteralPath (Join-Path $repo 'CHANGELOG.md')
$escaped = [regex]::Escape($Version)
$releaseSectionMatch = [regex]::Match($changelog, "(?ms)^## \[$escaped\].*?(?=^## \[|\z)")
$releaseSection = if ($releaseSectionMatch.Success) { $releaseSectionMatch.Value.Trim() } else { "## $Version`r`n`r`nSee CHANGELOG.md for release details." }

$notes = @(
    "# Galaxy XR Companion v$Version",
    '',
    $releaseSection,
    '',
    '## Package',
    '',
    "- Windows x64 portable package: ``$packageName.zip``",
    "- Source commit: ``$Commit``",
    '- Keep `GalaxyXRDriverGUI` and `GalaxyXRNative` together after extraction.'
) -join "`r`n"

$notesPath = Join-Path $ReleaseDirectory "$packageName-release-notes.md"
[IO.File]::WriteAllText($notesPath, $notes, [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $packageRoot 'RELEASE-NOTES.md'), $notes, [Text.UTF8Encoding]::new($false))

$zipPath = Join-Path $ReleaseDirectory "$packageName.zip"
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
Compress-Archive -LiteralPath $packageRoot -DestinationPath $zipPath -CompressionLevel Optimal

$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath).Hash.ToLowerInvariant()
$shaPath = "$zipPath.sha256"
[IO.File]::WriteAllText($shaPath, "$hash  $([IO.Path]::GetFileName($zipPath))`r`n", [Text.UTF8Encoding]::new($false))

Write-Host "Release ZIP: $zipPath"
Write-Host "SHA-256: $hash"
Write-Host "Release notes: $notesPath"
