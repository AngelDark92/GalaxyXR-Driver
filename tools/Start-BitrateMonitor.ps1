[CmdletBinding()]
param(
    [string]$AdbPath = '',
    [switch]$Console
)
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$python = Get-Command python.exe -ErrorAction SilentlyContinue
if (-not $python) { throw 'Python 3.10+ with Tk is required. Install the standard Windows Python distribution.' }
$exe = $python.Source
if (-not $Console) {
    $windowed = Join-Path (Split-Path -Parent $exe) 'pythonw.exe'
    if (Test-Path -LiteralPath $windowed) { $exe = $windowed }
}
$arguments = @('-B', '-m', 'tools.bitrate_monitor')
if ($AdbPath) {
    if ($AdbPath.Contains('"')) { throw 'ADB path cannot contain a quote.' }
    $arguments += @('--adb', $AdbPath)
}
if ($Console) {
    Push-Location -LiteralPath $repoRoot
    try { & $exe @arguments; exit $LASTEXITCODE } finally { Pop-Location }
} else {
    $quotedArguments = $arguments | ForEach-Object { '"' + $_ + '"' }
    Start-Process -FilePath $exe -ArgumentList $quotedArguments -WorkingDirectory $repoRoot -WindowStyle Hidden
}
