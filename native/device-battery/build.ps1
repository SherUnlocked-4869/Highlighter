# Publish the pinned Windows x64 sidecar. The package must keep the entire bin directory together.
[CmdletBinding()]
param([switch]$Verify)

$ErrorActionPreference = 'Stop'
$here = (Resolve-Path -LiteralPath $PSScriptRoot).ProviderPath
$project = Join-Path $here 'HighlighterDeviceBattery.csproj'
$expectedSdk = (Get-Content -LiteralPath (Join-Path $here 'global.json') -Raw | ConvertFrom-Json).sdk.version
$localDotnet = Join-Path $here '.tmp-sdk/dotnet.exe'
$dotnet = if ($env:DOTNET_EXE) {
    (Get-Command $env:DOTNET_EXE -CommandType Application -ErrorAction Stop).Source
} elseif (Test-Path -LiteralPath $localDotnet -PathType Leaf) {
    $localDotnet
} else {
    (Get-Command dotnet.exe -CommandType Application -ErrorAction Stop).Source
}
$staging = Join-Path $here ('.tmp-publish-' + [Guid]::NewGuid().ToString('N'))
$scratch = Join-Path $here ('.tmp-verify-' + [Guid]::NewGuid().ToString('N'))
$bin = Join-Path $here 'bin'
$envNames = 'DOTNET_CLI_HOME', 'DOTNET_NOLOGO', 'DOTNET_CLI_TELEMETRY_OPTOUT', 'NUGET_PACKAGES', 'NUGET_HTTP_CACHE_PATH', 'NUGET_SCRATCH', 'NUGET_PLUGINS_CACHE_PATH'
$saved = @{}
foreach ($name in $envNames) { $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }

function Remove-OwnedDirectory([string]$path, [string]$leaf) {
    if (-not (Test-Path -LiteralPath $path)) { return }
    $item = Get-Item -LiteralPath $path -Force
    if ($item.FullName -ne (Join-Path $here $leaf) -or -not $item.PSIsContainer -or $item.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)) {
        throw 'Refusing to remove a redirected or unexpected output directory.'
    }
    Remove-Item -LiteralPath $item.FullName -Recurse -Force
}

function New-CheckStartInfo([string]$exe, [string]$arguments) {
    $psi = [Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $exe
    $psi.Arguments = $arguments
    $psi.WorkingDirectory = Split-Path -Parent $exe
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [Text.Encoding]::UTF8
    return $psi
}

function Invoke-FastCheck([string]$exe, [string]$arguments) {
    $process = [Diagnostics.Process]::Start((New-CheckStartInfo $exe $arguments))
    try {
        $out = $process.StandardOutput.ReadToEndAsync()
        $err = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(15000)) { $process.Kill(); throw 'Sidecar check timed out.' }
        if ($process.ExitCode -ne 0 -or $err.GetAwaiter().GetResult().Length -ne 0) {
            throw ('Sidecar check failed (exit ' + $process.ExitCode + '): ' + $err.GetAwaiter().GetResult())
        }
        return $out.GetAwaiter().GetResult()
    } finally { $process.Dispose() }
}

function Assert-PipeSnapshot($reader, [string]$status, $percent, [int]$refreshId = 0, [string]$result = '') {
    $line = $reader.ReadLineAsync()
    if (-not $line.Wait(5000) -or $null -eq $line.Result) { throw ('Missing synthetic snapshot: ' + $status) }
    $value = $line.Result | ConvertFrom-Json
    if ($value.schemaVersion -ne 1 -or $value.status -cne $status -or $value.system.percent -ne $percent -or $value.devices.Count -ne 0) {
        throw ('Unexpected synthetic snapshot: ' + $status)
    }
    if ($refreshId -gt 0) {
        if ($value.refresh.id -ne $refreshId -or $value.refresh.status -cne $result) { throw ('Unexpected refresh receipt: ' + $refreshId) }
    } elseif ($value.PSObject.Properties['refresh']) { throw 'An ordinary snapshot carried a refresh receipt.' }
}

function Test-PipeWatch([string]$exe, [string]$mode) {
    $psi = New-CheckStartInfo $exe '--smoke-pipe'
    $psi.RedirectStandardInput = $true
    $process = [Diagnostics.Process]::Start($psi)
    try {
        $err = $process.StandardError.ReadToEndAsync()
        if ($mode -eq 'early-eof') {
            $process.StandardInput.Close()
        } else {
            Assert-PipeSnapshot $process.StandardOutput 'loading' $null
            if ($mode -eq 'stop') {
                $process.StandardInput.WriteLine('refresh 1')
                $process.StandardInput.Flush()
                Assert-PipeSnapshot $process.StandardOutput 'ready' 72
                Assert-PipeSnapshot $process.StandardOutput 'ready' 73 1 'complete'
                $process.StandardInput.WriteLine('refresh 2')
                $process.StandardInput.Flush()
                Assert-PipeSnapshot $process.StandardOutput 'ready' 73 2 'complete'
                $process.StandardInput.WriteLine('refresh 3')
                $process.StandardInput.Flush()
                Assert-PipeSnapshot $process.StandardOutput 'ready' 73 3 'partial'
                Assert-PipeSnapshot $process.StandardOutput 'ready' 74 # Late reading, never a second receipt.
                $process.StandardInput.WriteLine('stop')
                $process.StandardInput.Flush() # Don't close stdin until the child exits, to test stop separately from EOF.
            } else {
                Assert-PipeSnapshot $process.StandardOutput 'ready' 72
                $process.StandardInput.Close()
            }
        }
        if (-not $process.WaitForExit(5000)) { throw ('Synthetic ' + $mode + ' timed out.') }
        if ($process.ExitCode -ne 0 -or $err.GetAwaiter().GetResult().Length -ne 0) { throw ('Synthetic ' + $mode + ' failed: ' + $err.GetAwaiter().GetResult()) }
        if ($process.StandardOutput.ReadToEnd().Length -ne 0) { throw ('Unexpected stdout after synthetic ' + $mode) }
    } finally {
        if (-not $process.HasExited) { $process.Kill() }
        $process.Dispose()
    }
}

Push-Location -LiteralPath $here
try {
    $env:DOTNET_CLI_HOME = Join-Path $here '.tmp-dotnet-home'
    $env:DOTNET_NOLOGO = '1'
    $env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
    if (-not $env:NUGET_PACKAGES) { $env:NUGET_PACKAGES = Join-Path $here '.tmp-nuget' }
    $env:NUGET_HTTP_CACHE_PATH = Join-Path $here '.tmp-nuget-http'
    $env:NUGET_SCRATCH = Join-Path $here '.tmp-nuget-scratch'
    $env:NUGET_PLUGINS_CACHE_PATH = Join-Path $here '.tmp-nuget-plugins'
    $sdk = & $dotnet --version
    if ($LASTEXITCODE -ne 0 -or $sdk -cne $expectedSdk) { throw ('Install Windows x64 .NET SDK ' + $expectedSdk + ' or set DOTNET_EXE to it.') }
    & $dotnet restore $project --locked-mode --source https://api.nuget.org/v3/index.json --disable-build-servers
    if ($LASTEXITCODE -ne 0) { throw 'Locked restore failed.' }
    & $dotnet publish $project --configuration Release --no-restore --disable-build-servers --output $staging
    if ($LASTEXITCODE -ne 0) { throw 'Sidecar publish failed.' }

    $licenses = Join-Path $staging 'licenses'
    New-Item -ItemType Directory -Path $licenses | Out-Null
    $thirdParty = Join-Path $here '../../docs/third-party'
    foreach ($file in 'LICENSE-BrimDeck.txt', 'NOTICE-BrimDeck-device-battery.txt') {
        Copy-Item -LiteralPath (Join-Path $thirdParty $file) -Destination $licenses
    }
    $packs = $env:NUGET_PACKAGES
    Copy-Item -LiteralPath (Join-Path $packs 'microsoft.netcore.app.runtime.win-x64/10.0.15/LICENSE.TXT') -Destination (Join-Path $licenses 'LICENSE-dotnet.txt')
    Copy-Item -LiteralPath (Join-Path $packs 'microsoft.netcore.app.runtime.win-x64/10.0.15/THIRD-PARTY-NOTICES.TXT') -Destination (Join-Path $licenses 'NOTICE-dotnet.txt')
    Copy-Item -LiteralPath (Join-Path $packs 'microsoft.windowsdesktop.app.runtime.win-x64/10.0.15/LICENSE') -Destination (Join-Path $licenses 'LICENSE-WindowsDesktop.txt')
    Copy-Item -LiteralPath (Join-Path $packs 'system.io.ports/10.0.0/THIRD-PARTY-NOTICES.TXT') -Destination (Join-Path $licenses 'NOTICE-System.IO.Ports.txt')

    if ($Verify) {
        $exe = Join-Path $staging 'HighlighterDeviceBattery.exe'
        $version = Invoke-FastCheck $exe '--version'
        if ($version -cne ('HighlighterDeviceBattery 1' + [Environment]::NewLine)) { throw 'Unexpected sidecar version output.' }
        Invoke-FastCheck $exe '--smoke' | Out-Null
        $smoke = Invoke-FastCheck $exe ('--smoke --scratch-dir "' + $scratch + '"')
        Write-Output $smoke.Trim()
        foreach ($mode in 'early-eof', 'eof', 'stop') { Test-PipeWatch $exe $mode }
        Write-Output 'Synthetic watch: early EOF, active EOF, refresh and stop passed.'
    }

    Remove-OwnedDirectory $bin 'bin'
    Move-Item -LiteralPath (Get-Item -LiteralPath $staging).FullName -Destination $bin
    Write-Output 'Published native/device-battery/bin/HighlighterDeviceBattery.exe (win-x64 self-contained).'
} finally {
    try {
        Remove-OwnedDirectory $staging (Split-Path -Leaf $staging)
        Remove-OwnedDirectory $scratch (Split-Path -Leaf $scratch)
    } finally {
        foreach ($name in $envNames) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
        Pop-Location
    }
}
