[CmdletBinding()]
param([string]$ProcessorSource)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'Enter-PortableBuildEnvironment.ps1')
$outputDirectory = Join-Path $repoRoot 'build/hitch-diagnostics-test'
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null

# Exercise production frame-start behavior with real class state and fake
# clocks, stopping before any device/shader/texture operation can execute.
if (-not $ProcessorSource) {
    $ProcessorSource = Join-Path $repoRoot 'GalaxyXRDriver/src/Driver/FrameProcessor.cpp'
}
$source = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $ProcessorSource).Path)
$signature = 'bool FrameProcessor::ProcessSceneLayer('
$boundary = 'if(!EnsureDevice() || !EnsureShaders()){'
if ([regex]::Matches($source, [regex]::Escape($signature)).Count -ne 1 -or
    [regex]::Matches($source, [regex]::Escape($boundary)).Count -ne 1) {
    throw 'Production frame-start extraction boundaries changed or became ambiguous.'
}
$start = $source.IndexOf($signature, [StringComparison]::Ordinal)
$end = $source.IndexOf($boundary, $start, [StringComparison]::Ordinal)
if ($end -le $start) { throw 'Production GPU boundary must follow the scene entry point.' }
$prefix = $source.Substring($start, $end - $start)
# Fail closed if movement/nesting would truncate a block or include GPU work.
$tokens = [regex]::Replace($prefix, '(?s)/\*.*?\*/|//[^\r\n]*|"(?:\\.|[^"\\])*"', ' ')
$depth = 0
foreach ($character in $tokens.ToCharArray()) {
    if ($character -eq '{') { $depth++ }
    if ($character -eq '}') {
        $depth--
        if ($depth -le 0) { throw 'Production scene function ended before the extraction boundary.' }
    }
}
if ($depth -ne 1 -or $tokens -match '\breturn\b|\b(?:EnsureDevice|EnsureShaders|ProcessEye|OpenShared)\s*\(' -or
    $prefix -notmatch 'FrameProcessor: HITCH gap=' -or $prefix -notmatch 'FrameProcessor: HITCHDIAG ') {
    throw 'Production frame-start shape changed; review the isolated execution boundary.'
}
[IO.File]::WriteAllText((Join-Path $outputDirectory 'HitchFrameStart.generated.h'),
    $prefix + "`nreturn false;`n}`n", [Text.UTF8Encoding]::new($false))

$testSource = Join-Path $repoRoot 'GalaxyXRDriver/tests/HitchDiagnosticsTest.cpp'
$headers = Join-Path $repoRoot 'ThirdParty/openvr/headers'
$jsonHeaders = Join-Path $repoRoot 'ThirdParty/json/include'
$executable = Join-Path $outputDirectory 'HitchDiagnosticsTest.exe'
$testObject = Join-Path $outputDirectory 'HitchDiagnosticsTest.obj'
& cl.exe /nologo /std:c++17 /EHsc /O2 /MT "/I$headers" "/I$jsonHeaders" "/I$outputDirectory" $testSource "/Fo$testObject" "/Fe$executable"
if ($LASTEXITCODE -ne 0) { throw "Hitch Diagnostics test compilation failed: $LASTEXITCODE" }
& $executable
if ($LASTEXITCODE -ne 0) { throw "Hitch Diagnostics tests failed: $LASTEXITCODE" }
Write-Host "Artifacts: $outputDirectory"
