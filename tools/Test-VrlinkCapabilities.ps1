[CmdletBinding()]
param(
    [string]$CompilerPath = '',
    [switch]$SkipX86
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $CompilerPath) {
    $CompilerPath = Join-Path (Split-Path -Parent $repoRoot) 'steamlink-patches/build/tooling/zig/ziglang/zig.exe'
}
if (-not (Test-Path -LiteralPath $CompilerPath -PathType Leaf)) {
    throw "Zig compiler missing: $CompilerPath. Supply -CompilerPath with the path to zig.exe."
}
$CompilerPath = (Resolve-Path -LiteralPath $CompilerPath).Path
$outputDirectory = Join-Path $repoRoot '../builds/GalaxyXR-Driver/build/vrlink-capabilities-test'
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$source = Join-Path $repoRoot 'GalaxyXRDriver/tests/VrlinkCapabilitiesTest.cpp'
$headers = Join-Path $repoRoot 'ThirdParty/openvr/headers'
$executable = Join-Path $outputDirectory 'VrlinkCapabilitiesTest.exe'
$previousCache = $env:ZIG_LOCAL_CACHE_DIR
try {
    $env:ZIG_LOCAL_CACHE_DIR = Join-Path $outputDirectory 'zig-cache'
    & $CompilerPath c++ -std=c++17 -target x86_64-windows-gnu -O0 -g -I $headers $source -o $executable
    if ($LASTEXITCODE -ne 0) { throw "x64 capability test compilation failed: $LASTEXITCODE" }
    & $executable
    if ($LASTEXITCODE -ne 0) { throw "x64 capability behavior tests failed: $LASTEXITCODE" }
    if (-not $SkipX86) {
        $x86Object = Join-Path $outputDirectory 'VrlinkCapabilitiesTest.x86.obj'
        & $CompilerPath c++ -std=c++17 -target x86-windows-gnu -I $headers -c $source -o $x86Object
        if ($LASTEXITCODE -ne 0) { throw "x86 pinned ABI compilation failed: $LASTEXITCODE" }
        Write-Host 'PASS: x86 pinned ABI and behavior-test source compile.'
    }
    Write-Host "Artifacts: $outputDirectory"
} finally {
    $env:ZIG_LOCAL_CACHE_DIR = $previousCache
}
