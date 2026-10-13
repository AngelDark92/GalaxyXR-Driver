# Dot-source to configure only the current PowerShell process. Nothing is deployed.
param(
    [switch]$DriverOnly, [switch]$GuiOnly, [switch]$NoDownload,
    [switch]$AcceptToolchainLicense, [switch]$PrepareDependencies
)
$portableRepo = Split-Path $PSScriptRoot -Parent
$portableToolRoot = Join-Path $portableRepo '../builds/GalaxyXR-Driver/build/toolchains'
$setup = @{
    DriverOnly = $DriverOnly; GuiOnly = $GuiOnly; NoDownload = $NoDownload
    AcceptToolchainLicense = $AcceptToolchainLicense; PrepareDependencies = $PrepareDependencies
}
& (Join-Path $PSScriptRoot 'Setup-PortableBuildTools.ps1') @setup
$portableEnvironment = Get-Content -Raw -LiteralPath (Join-Path $portableToolRoot 'environment.json') | ConvertFrom-Json
if ($portableEnvironment.schema -ne 1) { throw 'Unknown portable environment receipt schema.' }
# Deliberately do not overwrite a working user Rust/Cargo home with an empty
# portable directory. The setup receipt only contains homes for portable Rust.
foreach ($property in $portableEnvironment.variables.PSObject.Properties) {
    [Environment]::SetEnvironmentVariable($property.Name, [string]$property.Value, [EnvironmentVariableTarget]::Process)
}
$portablePaths = @($portableEnvironment.paths) + @($env:PATH -split ';' | Where-Object { $_ })
$env:PATH = ($portablePaths | Select-Object -Unique) -join ';'
if ($NoDownload) { $env:CARGO_NET_OFFLINE = 'true' }
$env:VENDOR = 'galaxyxr'
