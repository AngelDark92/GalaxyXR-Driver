# Automatically installs the Microsoft C++ Build Tools prerequisites when they
# are missing. This installs build prerequisites only; it never installs the
# GalaxyXR driver or edits SteamVR settings.
[CmdletBinding()]
param(
    [switch]$AcceptLicense,
    [switch]$AutoElevate
)

$BuildToolsBootstrapperUrl = 'https://aka.ms/vs/17/release/vs_buildtools.exe'
$BuildToolsLicenseUrl = 'https://visualstudio.microsoft.com/license-terms/'
$script:BuildToolsInstallerScript = $PSCommandPath

function Assert-MicrosoftBootstrapperSignature {
    param([Parameter(Mandatory=$true)][string]$Path)
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    if ($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate -or
        $signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) -ne 'Microsoft Corporation') {
        throw "Refusing to execute an installer without a valid Microsoft Corporation Authenticode signature: $Path (status $($signature.Status))."
    }
    return $signature.SignerCertificate.Thumbprint
}

function Assert-BuildToolsCachePath {
    param([Parameter(Mandatory=$true)][string]$Path)
    $cursor = [IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            if (((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Refusing build-tool writes through a junction/symlink: $cursor"
            }
        }
        $cursor = [IO.Path]::GetDirectoryName($cursor)
    }
}

function Get-BuildToolsInstallArguments {
    param([Parameter(Mandatory=$true)][string]$InstallPath, [switch]$Modify)
    if ($InstallPath.Contains('"') -or $InstallPath -match '[\r\n]') { throw 'Invalid Build Tools install path.' }
    $items = @()
    if ($Modify) { $items += 'modify' }
    $items += @(
        '--installPath', ('"' + $InstallPath + '"'),
        '--add', 'Microsoft.VisualStudio.Workload.VCTools',
        '--includeRecommended',
        '--quiet', '--wait', '--norestart', '--nocache'
    )
    return $items
}

function Assert-BuildToolsInstallerExit {
    param([Parameter(Mandatory=$true)][int]$Code, [string]$Logs)
    if ($Code -eq 3010 -or $Code -eq 1641) {
        throw "Microsoft Build Tools requires a Windows restart (exit $Code). Restart Windows, then rerun Build-Portable.ps1. Compilation has not started. Logs: $Logs"
    }
    if ($Code -ne 0) {
        throw "Microsoft Build Tools failed (exit $Code). No application was built. Logs: $Logs; also check the newest %TEMP%/dd_*.log files."
    }
}

# 2026-09-21: some sessions (sanitized environments, restricted tokens) lack the
# standard ProgramFiles(x86) variable. Resolve it without assuming it is present,
# falling back to the conventional location on the system drive. A null result
# means "cannot locate a 32-bit program files directory"; callers treat that as
# "nothing installed" instead of a parameter binding crash.
function Get-ProgramFilesX86 {
    $fromEnvironment = ${env:ProgramFiles(x86)}
    if ($fromEnvironment) { return $fromEnvironment.TrimEnd('\','/') }
    $root = [IO.Path]::GetPathRoot([Environment]::SystemDirectory)
    if ($root) {
        $conventional = [IO.Path]::Combine($root.TrimEnd('\'), 'Program Files (x86)')
        if (Test-Path -LiteralPath $conventional -PathType Container) { return $conventional }
    }
    return $null
}

function Get-RegisteredVisualStudioPaths {
    $x86 = Get-ProgramFilesX86
    if (-not $x86) { return @() }
    $vswhere = Join-Path $x86 'Microsoft Visual Studio/Installer/vswhere.exe'
    if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) { return @() }
    $prior = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $lines = @(& $vswhere -products '*' -property installationPath 2>$null)
        if ($LASTEXITCODE -ne 0) { throw "vswhere failed (exit $LASTEXITCODE)." }
        return @($lines | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ })
    } finally { $ErrorActionPreference = $prior }
}

function Find-InstalledNativeBuildTools {
    $x86 = Get-ProgramFilesX86
    if (-not $x86) { return $null }
    $sdkRoot = Join-Path $x86 'Windows Kits/10'
    if (-not (Test-Path -LiteralPath (Join-Path $sdkRoot 'Include') -PathType Container)) { return $null }
    foreach ($installation in @(Get-RegisteredVisualStudioPaths)) {
        $vcRoot = Join-Path $installation 'VC/Tools/MSVC'
        if (-not (Test-Path -LiteralPath $vcRoot -PathType Container)) { continue }
        foreach ($vc in @(Get-ChildItem -LiteralPath $vcRoot -Directory | Where-Object { $_.Name -match '^\d+(\.\d+)+$' } | Sort-Object { [version]$_.Name } -Descending)) {
            if ([version]$vc.Name -lt [version]'14.40') { continue }
            $requiredVc = @(
                'bin/Hostx64/x64/cl.exe','bin/Hostx64/x64/link.exe','bin/Hostx64/x64/dumpbin.exe',
                'bin/Hostx64/x64/lib.exe','bin/Hostx64/x64/c1xx.dll','bin/Hostx64/x64/c2.dll',
                'include/vector','include/vcruntime.h','lib/x64/libcmt.lib','lib/x64/libcpmt.lib'
            )
            if (@($requiredVc | Where-Object { -not (Test-Path -LiteralPath (Join-Path $vc.FullName $_) -PathType Leaf) }).Count) { continue }
            foreach ($sdk in @(Get-ChildItem -LiteralPath (Join-Path $sdkRoot 'Include') -Directory | Where-Object { $_.Name -match '^\d+(\.\d+)+$' } | Sort-Object { [version]$_.Name } -Descending)) {
                if ([version]$sdk.Name -lt [version]'10.0.19041.0') { continue }
                $v = $sdk.Name
                $requiredSdk = @(
                    "bin/$v/x64/rc.exe", "bin/$v/x64/mt.exe", "Include/$v/um/Windows.h",
                    "Include/$v/shared/sdkddkver.h", "Include/$v/ucrt/stdio.h",
                    "Lib/$v/um/x64/kernel32.lib", "Lib/$v/ucrt/x64/ucrt.lib"
                )
                if (@($requiredSdk | Where-Object { -not (Test-Path -LiteralPath (Join-Path $sdkRoot $_) -PathType Leaf) }).Count -eq 0) {
                    return $installation
                }
            }
        }
    }
    return $null
}

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    try {
        return ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } finally { $identity.Dispose() }
}

function Confirm-BuildToolsLicense {
    param([switch]$Accepted)
    if ($Accepted) { return $true }
    if ($env:CI) {
        throw "Microsoft C++ Build Tools are missing. The build cannot prompt for the Microsoft license in CI. Preinstall the C++ workload or rerun setup with -AcceptToolchainLicense. License: $BuildToolsLicenseUrl"
    }
    Write-Host ''
    Write-Host '[tools] Microsoft C++ Build Tools and a Windows SDK are required.'
    Write-Host "[tools] Microsoft license terms: $BuildToolsLicenseUrl"
    $answer = Read-Host 'Download and install the required Microsoft build tools now? [Y/n]'
    if ($answer -and $answer -notmatch '^(?i:y|yes)$') {
        throw 'Microsoft build-tool installation was declined. The project was not built.'
    }
    return $true
}

function Invoke-ElevatedBuildToolsInstall {
    param([switch]$AcceptLicense)
    $hostExe = (Get-Process -Id $PID).Path
    if (-not $hostExe -or -not (Test-Path -LiteralPath $hostExe -PathType Leaf)) {
        throw 'Could not determine the current PowerShell executable for administrator elevation.'
    }
    $arguments = @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $script:BuildToolsInstallerScript + '"'))
    if ($AcceptLicense) { $arguments += '-AcceptLicense' }
    Write-Host '[tools] Administrator approval is required once to install the Microsoft C++ build prerequisites.'
    try {
        $process = Start-Process -FilePath $hostExe -ArgumentList $arguments -Verb RunAs -Wait -PassThru
    } catch {
        throw "Administrator approval was cancelled or failed: $($_.Exception.Message)"
    }
    $code = $process.ExitCode
    $process.Dispose()
    if ($code -ne 0) { throw "Elevated Microsoft Build Tools setup failed (exit $code). See build/toolchains/logs/microsoft-buildtools." }
}

function Install-MicrosoftBuildTools {
    param([switch]$AcceptLicense, [switch]$AutoElevate)
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitProcess) {
        throw 'Use 64-bit Windows PowerShell 5.1 or PowerShell 7.'
    }
    $existing = Find-InstalledNativeBuildTools
    if ($existing) {
        Write-Host "[tools] Reusing installed C++ tools and Windows SDK: $existing"
        return
    }

    $null = Confirm-BuildToolsLicense -Accepted:$AcceptLicense
    if (-not (Test-IsAdministrator)) {
        if (-not $AutoElevate) {
            throw 'Microsoft Build Tools require administrator approval. Rerun with -AutoElevate or start PowerShell as Administrator.'
        }
        Invoke-ElevatedBuildToolsInstall -AcceptLicense
        $readyAfterElevation = Find-InstalledNativeBuildTools
        if (-not $readyAfterElevation) {
            throw 'The elevated Build Tools installer returned, but compatible C++ tools/Windows SDK were not detected. See build/toolchains/logs/microsoft-buildtools and %TEMP%/dd_*.log.'
        }
        Write-Host "[tools] Microsoft build prerequisites are ready: $readyAfterElevation"
        return
    }

    $repo = Split-Path $PSScriptRoot -Parent
    $root = Join-Path $repo '../builds/GalaxyXR-Driver/build/toolchains'
    Assert-BuildToolsCachePath $root
    [IO.Directory]::CreateDirectory($root) | Out-Null
    try {
        $lock = [IO.File]::Open((Join-Path $root '.microsoft-buildtools.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    } catch {
        throw 'Another Microsoft Build Tools setup is using this checkout. Wait for it to finish.'
    }
    try {
        $cache = Join-Path $root 'downloads'
        $logs = Join-Path $root 'logs/microsoft-buildtools'
        [IO.Directory]::CreateDirectory($cache) | Out-Null
        [IO.Directory]::CreateDirectory($logs) | Out-Null

        # Avoid the large VisualStudio.vsman catalog entirely. Microsoft publishes
        # this stable VS2022 Build Tools bootstrapper URL specifically for setup.
        # Integrity is enforced with the Windows Authenticode trust chain and an
        # exact Microsoft Corporation signer check before execution.
        $bootstrapper = Join-Path $cache 'vs_BuildTools.exe'
        Invoke-ToolDownload -Source $BuildToolsBootstrapperUrl -Destination $bootstrapper `
            -LogFile (Join-Path $logs 'bootstrapper.download.json')
        $thumbprint = Assert-MicrosoftBootstrapperSignature $bootstrapper
        $bootstrapperSha256 = (Get-FileHash -LiteralPath $bootstrapper -Algorithm SHA256).Hash.ToLowerInvariant()

        # The install destination is the conventional location even when the
        # environment variable is absent; the elevated installer creates it.
        $x86InstallRoot = Get-ProgramFilesX86
        if (-not $x86InstallRoot) {
            $x86InstallRoot = [IO.Path]::Combine(([IO.Path]::GetPathRoot([Environment]::SystemDirectory)).TrimEnd('\'), 'Program Files (x86)')
        }
        $installPath = Join-Path $x86InstallRoot 'Microsoft Visual Studio/2022/BuildTools-GalaxyXRDriver'
        Assert-BuildToolsCachePath $installPath
        $registered = @(Get-RegisteredVisualStudioPaths)
        $modify = $registered -contains $installPath
        if (-not $modify -and (Test-Path -LiteralPath $installPath) -and @(Get-ChildItem -LiteralPath $installPath -Force).Count -gt 0) {
            throw "Unregistered nonempty Build Tools folder: $installPath. Inspect it with Visual Studio Installer; no files were deleted."
        }
        $arguments = @(Get-BuildToolsInstallArguments -InstallPath $installPath -Modify:$modify)
        Write-Host "[tools] Installing Microsoft C++ Build Tools and recommended Windows SDK at $installPath."
        Write-Host '[tools] This can take several minutes and multiple GB. No GalaxyXR driver is installed by this step.'
        $started = [DateTime]::UtcNow
        $process = Start-Process -FilePath $bootstrapper -ArgumentList $arguments -WorkingDirectory $cache -Wait -PassThru `
            -RedirectStandardOutput (Join-Path $logs 'bootstrapper.stdout.log') `
            -RedirectStandardError (Join-Path $logs 'bootstrapper.stderr.log')
        $process.WaitForExit()
        $process.Refresh()
        $exitCode = $process.ExitCode
        $process.Dispose()
        if ($null -eq $exitCode) {
            throw "Microsoft bootstrapper did not return an exit code. Check $logs; the build has not started."
        }
        $receipt = @{
            schema = 2
            startedAt = $started.ToString('o')
            completedAt = [DateTime]::UtcNow.ToString('o')
            bootstrapperUrl = $BuildToolsBootstrapperUrl
            bootstrapperSha256 = $bootstrapperSha256
            signerThumbprint = $thumbprint
            signer = 'Microsoft Corporation'
            license = $BuildToolsLicenseUrl
            workload = 'Microsoft.VisualStudio.Workload.VCTools'
            includeRecommended = $true
            installPath = $installPath
            exitCode = $exitCode
        }
        [IO.File]::WriteAllText((Join-Path $logs 'installer-result.json'), ($receipt | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
        Assert-BuildToolsInstallerExit -Code $exitCode -Logs $logs
        $ready = Find-InstalledNativeBuildTools
        if (-not $ready) {
            throw "Microsoft setup returned success but the x64 compiler/SDK are incomplete. See $logs and %TEMP%/dd_*.log. Compilation has not started."
        }
        Write-Host "[tools] Microsoft-managed build prerequisites found: $ready. The build will still run its compile/link probe."
    } finally {
        $lock.Dispose()
    }
}

# Loading for tests defines functions only and never downloads/installs anything.
if ($MyInvocation.InvocationName -ne '.') {
    $ErrorActionPreference = 'Stop'
    . (Join-Path $PSScriptRoot 'PortableToolchainIO.ps1')
    try {
        Install-MicrosoftBuildTools -AcceptLicense:$AcceptLicense -AutoElevate:$AutoElevate
        exit 0
    } catch {
        [Console]::Error.WriteLine($_.Exception.Message)
        exit 1
    }
}
