# Successful checks (2026-10-08): retain logs, remove only the exact owned fixture.
function Remove-TestFixture {
    param([Parameter(Mandatory=$true)][string]$Repository,
          [Parameter(Mandatory=$true)][string]$Fixture)
    $root = [IO.Path]::GetFullPath((Join-Path $Repository '../builds/GalaxyXR-Driver/build')).TrimEnd('\')
    $target = [IO.Path]::GetFullPath($Fixture).TrimEnd('\')
    if (-not [string]::Equals((Split-Path $target -Parent), $root, [StringComparison]::OrdinalIgnoreCase) -or
        (Split-Path $target -Leaf) -notmatch '^(cleanup|lifecycle)-test-[0-9a-f]{32}$') {
        throw "Unsafe test fixture cleanup: $target"
    }
    $ancestor = $target
    while ($ancestor) {
        if ((Test-Path -LiteralPath $ancestor) -and
            ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Linked test fixture ancestor: $ancestor"
        }
        $ancestor = Split-Path $ancestor -Parent
    }
    if (-not (Test-Path -LiteralPath $target -PathType Container)) { return }
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $pending.Push($target)
    while ($pending.Count) {
        foreach ($item in @(Get-ChildItem -LiteralPath $pending.Pop() -Force)) {
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Linked fixture child: $($item.FullName)" }
            if ($item.Name -eq '.git') { throw "Repository inside fixture: $($item.FullName)" }
            if ($item.PSIsContainer) { $pending.Push($item.FullName) }
        }
    }
    Remove-Item -LiteralPath $target -Recurse -Force
}
