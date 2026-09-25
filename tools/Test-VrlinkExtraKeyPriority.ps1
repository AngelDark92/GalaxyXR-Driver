[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'Enter-PortableBuildEnvironment.ps1')
$outputDirectory = Join-Path $repoRoot 'build/vrlink-extra-key-priority-test'
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null

function Get-FunctionBody([string]$source, [string]$signature) {
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
$source = Get-Content -Raw -LiteralPath (Join-Path $repoRoot 'GalaxyXRDriver/src/Headsets/GalaxyXR.cpp')
$early = Get-FunctionBody $source 'void GalaxyXR_EarlyApplyVrlinkSettings()'
$activation = Get-FunctionBody $source 'void GalaxyXRHmdShim::PosTrackedDeviceActivate('
$activationStart = $activation.IndexOf('RestoreInactiveVrlinkSettings(origModelNumber);')
$activationEnd = [regex]::Match($activation, '(?m)^\t\{\s*\r?\n\t\tstd::lock_guard<std::mutex> lock\(trackingCapabilitiesMutex\);')
if ($activationStart -lt 0 -or !$activationEnd.Success -or $activationEnd.Index -le $activationStart) {
    throw 'Activation settings publication boundaries missing.'
}
$activation = $activation.Substring($activationStart, $activationEnd.Index - $activationStart)
$run = Get-FunctionBody $source 'void GalaxyXRHmdShim::RunFrame()'
$runStart = $run.IndexOf('const bool routeChanged =')
if ($runStart -lt 0) { throw 'RunFrame settings publication boundary missing.' }
$run = $run.Substring($runStart)
$generated = "void EarlySettingsForTest() {`n$early`n}`nvoid PriorityShim::ActivateSettings() {`n$activation`n}`nvoid PriorityShim::RunFrameSettings() {`n$run`n}`n"
[IO.File]::WriteAllText((Join-Path $outputDirectory 'VrlinkExtraKeysControlFlow.generated.h'), $generated, [Text.UTF8Encoding]::new($false))

$testSource = Join-Path $repoRoot 'GalaxyXRDriver/tests/VrlinkExtraKeyPriorityTest.cpp'
$headers = Join-Path $repoRoot 'ThirdParty/openvr/headers'
$exe = Join-Path $outputDirectory 'VrlinkExtraKeyPriorityTest.exe'
$object = Join-Path $outputDirectory 'VrlinkExtraKeyPriorityTest.obj'
& cl.exe /nologo /std:c++17 /EHsc /O2 /MT "/I$headers" "/I$outputDirectory" $testSource "/Fo$object" "/Fe$exe"
if ($LASTEXITCODE -ne 0) { throw "VRLink extra-key priority compilation failed: $LASTEXITCODE" }
& $exe
if ($LASTEXITCODE -ne 0) { throw "VRLink extra-key priority tests failed: $LASTEXITCODE" }
Write-Host "Artifacts: $outputDirectory"
