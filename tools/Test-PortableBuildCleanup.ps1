$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/portable-build-cleanup.ps1')
$repo = Split-Path $PSScriptRoot -Parent
$fixture = Join-Path $repo ('../builds/GalaxyXR-Driver/build/cleanup-test-' + [guid]::NewGuid().ToString('N') + '/repo')
$name = 'pw-' + (Get-Date -Format 'HHmmss') + [guid]::NewGuid().ToString('N').Substring(0, 6)
$work = Join-Path $fixture "../builds/GalaxyXR-Driver/build/$name"
New-Item -ItemType Directory -Path "$work/native", "$fixture/../builds/GalaxyXR-Driver/build/toolchains", "$fixture/../builds/GalaxyXR-Driver/output", "$fixture/outside" -Force | Out-Null
Set-Content -LiteralPath "$work/native/test.obj" -Value 'generated'
Set-Content -LiteralPath "$fixture/../builds/GalaxyXR-Driver/build/toolchains/keep.txt" -Value 'compiler'
Set-Content -LiteralPath "$fixture/../builds/GalaxyXR-Driver/output/keep.txt" -Value 'package'
Set-Content -LiteralPath "$fixture/outside/keep.txt" -Value 'unrelated'
$checks = 0
function Assert-Rejected([scriptblock]$Action) {
    $rejected = $false
    try { & $Action } catch { $rejected = $true }
    if (-not $rejected) { throw 'Unsafe cleanup was accepted.' }
    $script:checks++
}
Remove-PortableBuildWork -Repository $fixture -WorkDirectory $work
if (Test-Path -LiteralPath $work) { throw 'Owned work directory survived cleanup.' }
$checks++
Remove-PortableBuildWork -Repository $fixture -WorkDirectory $work
$checks++
Assert-Rejected { Remove-PortableBuildWork -Repository $fixture -WorkDirectory "$fixture/outside" }
Assert-Rejected { Remove-PortableBuildWork -Repository $fixture -WorkDirectory "$fixture/../builds/GalaxyXR-Driver/build/toolchains" }
Assert-Rejected { Remove-PortableBuildWork -Repository $fixture -WorkDirectory "$fixture/../builds/GalaxyXR-Driver/output" }
Assert-Rejected { Remove-PortableBuildWork -Repository $fixture -WorkDirectory "$fixture/../builds/GalaxyXR-Driver/build/../outside/$name" }
Assert-Rejected { Remove-PortableBuildWork -Repository $fixture -WorkDirectory "$fixture/../builds/GalaxyXR-Driver/build/$name/child" }
Set-Content -LiteralPath $work -Value 'not a directory'
Assert-Rejected { Remove-PortableBuildWork -Repository $fixture -WorkDirectory $work }
Remove-Item -LiteralPath $work
New-Item -ItemType Directory -Path $work | Out-Null
$link = Join-Path $work 'linked'
New-Item -ItemType Junction -Path $link -Target "$fixture/outside" | Out-Null
Assert-Rejected { Remove-PortableBuildWork -Repository $fixture -WorkDirectory $work }
# Delete only the junction itself; never recursively delete its target.
[IO.Directory]::Delete($link)
Remove-PortableBuildWork -Repository $fixture -WorkDirectory $work
New-Item -ItemType Junction -Path $work -Target "$fixture/outside" | Out-Null
Assert-Rejected { Remove-PortableBuildWork -Repository $fixture -WorkDirectory $work }
[IO.Directory]::Delete($work)
# The pre-2026-10-17 timestamp+guid form must stay cleanable.
$legacy = Join-Path $fixture ('../builds/GalaxyXR-Driver/build/portable-work-20260926-120000-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $legacy -Force | Out-Null
Set-Content -LiteralPath (Join-Path $legacy 'native.obj') -Value 'generated'
Remove-PortableBuildWork -Repository $fixture -WorkDirectory $legacy
if (Test-Path -LiteralPath $legacy) { throw 'Legacy work directory survived cleanup.' }
$checks++
foreach ($file in @('build/toolchains/keep.txt','output/keep.txt','../../repo/outside/keep.txt')) {
    if (-not (Test-Path -LiteralPath (Join-Path $fixture ('../builds/GalaxyXR-Driver/' + $file)))) { throw "Protected file removed: $file" }
    $checks++
}
. (Join-Path $PSScriptRoot 'lib/test-fixture-cleanup.ps1')
Remove-TestFixture -Repository $repo -Fixture (Split-Path $fixture -Parent)
Write-Output "Portable cleanup: $checks checks passed. Owned fixture removed."
