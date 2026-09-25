[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'Enter-PortableBuildEnvironment.ps1')
$outputDirectory = Join-Path $repoRoot 'build/cas-activation-test'
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null

# The executable tests the real dispatcher. These source contracts additionally
# catch the original defect: placing the dispatcher behind the eye-work gate.
function Get-CodeFunction([string]$source, [string]$signature) {
    $start = $source.IndexOf($signature, [StringComparison]::Ordinal)
    if ($start -lt 0) { throw "Production function missing: $signature" }
    $open = $source.IndexOf('{', $start)
    $depth = 0
    for ($index = $open; $index -lt $source.Length; $index++) {
        if ($source[$index] -eq '{') { $depth++ }
        if ($source[$index] -eq '}') {
            $depth--
            if ($depth -eq 0) { return $source.Substring($open + 1, $index - $open - 1) }
        }
    }
    throw "Unbalanced production function: $signature"
}
function Read-Code([string]$path) {
    $source = Get-Content -Raw -LiteralPath $path
    # Remove comments and quoted strings before checking control-flow tokens.
    return [regex]::Replace($source, '(?s)/\*.*?\*/|//[^\r\n]*|"(?:\\.|[^"\\])*"', ' ')
}
$shim = Read-Code (Join-Path $repoRoot 'GalaxyXRDriver/src/Driver/FrameComponentShim.cpp')
$body = Get-CodeFunction $shim 'bool DirectModeComponentShim::GetActiveSettings('
$callPattern = 'FrameProcessor::UpdateEncoderSettings\s*\(\s*settings\s*\)\s*;'
$calls = [regex]::Matches($body, $callPattern)
if ($calls.Count -ne 1) { throw 'GetActiveSettings must publish encoder settings exactly once.' }
$call = $calls[0].Index
$snapshot = $body.IndexOf('settings.config = driverConfig.streamFrame;')
$policy = $body.IndexOf('settings.policy = gxr::ResolveSdr10Policy(driverConfig);')
$gate = $body.IndexOf('bool colorActive =')
if ($snapshot -gt $body.IndexOf('settings.config.eyeGaze.predictionMs')) {
    throw 'Persisted gaze prediction must be read after taking the settings snapshot.'
}
if ($snapshot -lt 0 -or $policy -lt $snapshot -or $call -lt $policy -or $gate -lt $call) {
    throw 'Encoder settings publication must follow the snapshot/policy and precede the eye activity gate.'
}
$prefix = $body.Substring(0, $call)
if ($prefix -match '\breturn\b') { throw 'GetActiveSettings may not return before publishing encoder settings.' }
$depth = ([regex]::Matches($prefix, '\{').Count - [regex]::Matches($prefix, '\}').Count)
if ($depth -ne 1 -or $prefix -notmatch 'std::lock_guard<std::mutex> configGuard\(driverConfigLock\);') {
    throw 'Encoder settings publication must be unconditional inside the snapshot lock, ordered against provider updates.'
}
$processorPath = Join-Path $repoRoot 'GalaxyXRDriver/src/Driver/FrameProcessor.cpp'
$processor = Read-Code $processorPath
$sceneBody = Get-CodeFunction $processor 'bool FrameProcessor::ProcessSceneLayer('
if ($sceneBody -match 'UpdateEncoderSettings\s*\(|NvencPostPack::SetConfig\s*\(|NvencTap::Get\s*\(\s*\)\s*\.SetConfig\s*\(') {
    throw 'Encoder settings must not be dispatched from the gated eye-processing pass.'
}
Write-Host 'CAS dispatch source contracts passed.'

$provider = Read-Code (Join-Path $repoRoot 'GalaxyXRDriver/src/Driver/DeviceProvider.cpp')
$init = Get-CodeFunction $provider 'vr::EVRInitError GalaxyXRDeviceProvider::Init('
if ($init.IndexOf('FrameProcessor::UpdateEncoderSettings(settings);') -lt $init.IndexOf('driverConfigLoader.Start();') -or
    $init.IndexOf('FrameProcessor::UpdateEncoderSettings(settings);') -gt $init.IndexOf('InjectHooks(this, pDriverContext);')) {
    throw 'Startup must publish loaded encoder settings before injecting frame hooks.'
}
$runFrame = Get-CodeFunction $provider 'void GalaxyXRDeviceProvider::RunFrame('
$runPublish = $runFrame.IndexOf('FrameProcessor::UpdateEncoderSettings(settings);')
if ($runPublish -lt 0 -or $runPublish -lt $runFrame.IndexOf('if(lockedOut)') -or
    $runPublish -lt $runFrame.IndexOf('std::lock_guard<std::mutex> lock(driverConfigLock);')) {
    throw 'Provider must synchronize reloads after the lockout check and under the config lock.'
}
Write-Host 'Encoder startup/reload source contracts passed.'

# Compile the production eye-work decision verbatim, isolated from OpenVR/GPU
# plumbing. This exercises combinations of individual controls and master modes.
$rawBody = Get-CodeFunction (Get-Content -Raw (Join-Path $repoRoot 'GalaxyXRDriver/src/Driver/FrameComponentShim.cpp')) 'bool DirectModeComponentShim::GetActiveSettings('
$gateStart = $rawBody.IndexOf('const StreamFrameConfig &config = settings.config;')
$gateEndMarker = 'return config.enable && (colorActive || remapActive);'
$gateEnd = $rawBody.IndexOf($gateEndMarker, $gateStart)
if ($gateStart -lt 0 -or $gateEnd -lt 0) { throw 'Production eye activity decision missing.' }
$gateSource = Join-Path $outputDirectory 'EyeActivity.cpp'
$gateCode = $rawBody.Substring($gateStart, $gateEnd + $gateEndMarker.Length - $gateStart)
$frameHeader = (Join-Path $repoRoot 'GalaxyXRDriver/src/Driver/FrameProcessor.h').Replace('\', '/')
[IO.File]::WriteAllText($gateSource, "#include `"$frameHeader`"`n#include <cmath>`nbool CasEyeActivityForTest(FrameProcessSettings settings, double dimFactor) {`n$gateCode`n}`n")

$source = Join-Path $repoRoot 'GalaxyXRDriver/tests/CasActivationTest.cpp'
$headers = Join-Path $repoRoot 'ThirdParty/openvr/headers'
$jsonHeaders = Join-Path $repoRoot 'ThirdParty/json/include'
$executable = Join-Path $outputDirectory 'CasActivationTest.exe'
$processorObject = Join-Path $outputDirectory 'FrameProcessor.obj'
$testObject = Join-Path $outputDirectory 'CasActivationTest.obj'
$gateObject = Join-Path $outputDirectory 'EyeActivity.obj'
# Compile the actual production translation unit. /Gy and /OPT:REF discard GPU
# methods; link-time substitutes capture only the dispatcher's external calls.
& cl.exe /nologo /std:c++17 /EHsc /O2 /MT /Gy /c "/I$headers" "/I$jsonHeaders" $processorPath "/Fo$processorObject"
if ($LASTEXITCODE -ne 0) { throw "Production FrameProcessor compilation failed: $LASTEXITCODE" }
& cl.exe /nologo /std:c++17 /EHsc /O2 /MT /Gy /c "/I$headers" "/I$jsonHeaders" $gateSource "/Fo$gateObject"
if ($LASTEXITCODE -ne 0) { throw "Eye activity compilation failed: $LASTEXITCODE" }
& cl.exe /nologo /std:c++17 /EHsc /O2 /MT /Gy "/I$headers" "/I$jsonHeaders" $source $processorObject $gateObject "/Fo$testObject" "/Fe$executable" /link /OPT:REF
if ($LASTEXITCODE -ne 0) { throw "CAS activation test compilation/link failed: $LASTEXITCODE" }
& $executable
if ($LASTEXITCODE -ne 0) { throw "CAS activation tests failed: $LASTEXITCODE" }
Write-Host "Artifacts: $outputDirectory"
