$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/portable-build-cleanup.ps1')
$repo = Split-Path $PSScriptRoot -Parent
$fixture = Join-Path $repo ('build/cleanup-test-' + [guid]::NewGuid().ToString('N'))
$name = 'portable-work-20260926-120000-' + [guid]::NewGuid().ToString('N')
$work = Join-Path $fixture "build/$name"
New-Item -ItemType Directory -Path "$work/native", "$fixture/build/toolchains", "$fixture/output", "$fixture/outside" -Force | Out-Null
Set-Content -LiteralPath "$work/native/test.obj" -Value 'generated'
Set-Content -LiteralPath "$fixture/build/toolchains/keep.txt" -Value 'compiler'
Set-Content -LiteralPath "$fixture/output/keep.txt" -Value 'package'
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
Assert-Rejected { Remove-PortableBuildWork -Repository $fixture -WorkDirectory "$fixture/build/toolchains" }
Assert-Rejected { Remove-PortableBuildWork -Repository $fixture -WorkDirectory "$fixture/output" }
Assert-Rejected { Remove-PortableBuildWork -Repository $fixture -WorkDirectory "$fixture/build/../outside/$name" }
Assert-Rejected { Remove-PortableBuildWork -Repository $fixture -WorkDirectory "$fixture/build/$name/child" }
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
foreach ($file in @('build/toolchains/keep.txt','output/keep.txt','outside/keep.txt')) {
    if (-not (Test-Path -LiteralPath (Join-Path $fixture $file))) { throw "Protected file removed: $file" }
    $checks++
}
# No recursive fixture deletion: keep the tiny preservation evidence for review.
Write-Output "Portable cleanup: $checks checks passed. Fixture: $fixture"
