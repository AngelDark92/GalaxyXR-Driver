# Only per-invocation scratch directories belong to the portable build's cleanup.
# Historical packages, shared caches and toolchains are deliberately not candidates.
function Remove-PortableBuildWork {
    param(
        [Parameter(Mandatory=$true)][string]$Repository,
        [Parameter(Mandatory=$true)][string]$WorkDirectory
    )
    $root = [IO.Path]::GetFullPath($Repository).TrimEnd('\', '/')
    $build = Join-Path $root 'build'
    $target = [IO.Path]::GetFullPath($WorkDirectory).TrimEnd('\', '/')
    if (-not [string]::Equals((Split-Path $target -Parent), $build, [StringComparison]::OrdinalIgnoreCase) -or
        (Split-Path $target -Leaf) -notmatch '^portable-work-\d{8}-\d{6}-[0-9a-f]{32}$') {
        throw "Refusing cleanup outside a portable build work directory: $target"
    }

    # Check every existing ancestor before enumerating anything beneath it.
    # Lexical containment alone is insufficient when a junction redirects build/.
    $ancestor = $target
    while ($ancestor) {
        if (Test-Path -LiteralPath $ancestor) {
            $item = Get-Item -LiteralPath $ancestor -Force -ErrorAction Stop
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Refusing cleanup through a reparse point: $ancestor"
            }
            if (-not $item.PSIsContainer) { throw "Cleanup path is not a directory: $ancestor" }
        }
        $ancestor = Split-Path $ancestor -Parent
    }
    if (-not (Test-Path -LiteralPath $target)) { return }

    # Inspect each level explicitly; never recurse into a junction or symlink.
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $pending.Push($target)
    while ($pending.Count -gt 0) {
        foreach ($item in (Get-ChildItem -LiteralPath $pending.Pop() -Force -ErrorAction Stop)) {
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Refusing cleanup containing a reparse point: $($item.FullName)"
            }
            if ($item.PSIsContainer) { $pending.Push($item.FullName) }
        }
    }
    Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop
}
