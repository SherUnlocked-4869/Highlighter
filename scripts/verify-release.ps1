[CmdletBinding()]
param(
  [string]$DistDir = "",
  [string]$ExpectedVersion = "",
  [switch]$RequireSignature,
  [string]$ExpectedPublisher = "",
  [switch]$SkipFuseVerification,
  [switch]$SkipManifest,
  [switch]$SkipSbom
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
if ([string]::IsNullOrWhiteSpace($DistDir)) {
  $DistDir = Join-Path $projectRoot 'dist'
}
$distPath = (Resolve-Path -LiteralPath $DistDir).Path

if ([string]::IsNullOrWhiteSpace($ExpectedVersion)) {
  $package = Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'package.json') | ConvertFrom-Json
  $ExpectedVersion = [string]$package.version
}
if ([string]::IsNullOrWhiteSpace($ExpectedVersion)) {
  throw 'Expected release version is blank'
}

function Require-File {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )

  $item = Get-Item -LiteralPath $Path -ErrorAction SilentlyContinue
  if ($null -eq $item -or $item.PSIsContainer -or $item.Length -le 0) {
    throw "$Label is missing or empty: $Path"
  }
  return $item
}

function Get-Sha256Hex {
  param([Parameter(Mandatory = $true)][string]$Path)

  $stream = [IO.File]::OpenRead($Path)
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '')
  } finally {
    $sha256.Dispose()
    $stream.Dispose()
  }
}

function Assert-DeviceBatteryX64 {
  param([Parameter(Mandatory = $true)][IO.FileInfo]$Executable)

  $reader = [IO.BinaryReader]::new($Executable.OpenRead())
  try {
    $stream = $reader.BaseStream
    if ($stream.Length -ge 0x40 -and $reader.ReadUInt16() -eq 0x5a4d) {
      $stream.Position = 0x3c
      $peOffset = $reader.ReadInt32()
      if ($peOffset -ge 0x40 -and $peOffset -le ($stream.Length - 6)) {
        $stream.Position = $peOffset
        if ($reader.ReadUInt32() -eq 0x4550 -and $reader.ReadUInt16() -eq 0x8664) {
          return
        }
      }
    }
    throw "Device battery sidecar is not an x64 PE executable: $($Executable.FullName)"
  } finally {
    $reader.Dispose()
  }
}

function Invoke-DeviceBatteryProbe {
  param(
    [Parameter(Mandatory = $true)][IO.FileInfo]$Executable,
    [Parameter(Mandatory = $true)][ValidateSet('--version', '--smoke')][string]$Argument
  )

  $startInfo = [Diagnostics.ProcessStartInfo]::new($Executable.FullName, $Argument)
  $startInfo.WorkingDirectory = $Executable.DirectoryName
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $process = [Diagnostics.Process]::Start($startInfo)
  try {
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(15000)) {
      try { $process.Kill() } catch [InvalidOperationException] { }
      throw "Packaged device battery $Argument timed out after 15 seconds"
    }
    if (-not [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($stdout, $stderr), 5000)) {
      throw "Packaged device battery $Argument did not close its output streams"
    }
    if ($process.ExitCode -ne 0) {
      throw "Packaged device battery $Argument failed with exit code $($process.ExitCode): $($stderr.Result.Trim())"
    }
    if ($Argument -eq '--version' -and $stdout.Result -cnotmatch '\AHighlighterDeviceBattery 1(?:\r?\n)?\z') {
      throw 'Packaged device battery --version did not report HighlighterDeviceBattery 1 on stdout'
    }
  } finally {
    $process.Dispose()
  }
}

$setupName = "Highlighter-Setup-$ExpectedVersion.exe"
$portableName = "Highlighter-$ExpectedVersion-portable.exe"
$setup = Require-File (Join-Path $distPath $setupName) 'NSIS installer'
$portable = Require-File (Join-Path $distPath $portableName) 'Portable executable'
$blockmap = Require-File (Join-Path $distPath "$setupName.blockmap") 'NSIS blockmap'
$mainExecutable = Require-File (Join-Path $distPath 'win-unpacked/Highlighter.exe') 'Packaged application executable'
$null = Require-File (Join-Path $distPath 'win-unpacked/resources/native/clipboard/HighlighterClipboard.exe') 'Clipboard sidecar'
$null = Require-File (Join-Path $distPath 'win-unpacked/resources/native/clipboard/build-info.json') 'Clipboard build identity'

# Both x64 targets are built from win-unpacked. Verify this shared payload rather
# than launching the installer or depending on where the portable wrapper extracts.
$batteryDir = Join-Path $distPath 'win-unpacked/resources/native/device-battery'
$batteryExecutable = Require-File (Join-Path $batteryDir 'HighlighterDeviceBattery.exe') 'Device battery sidecar'
Assert-DeviceBatteryX64 $batteryExecutable
foreach ($file in @(
  'HighlighterDeviceBattery.dll',
  'HighlighterDeviceBattery.deps.json',
  'HighlighterDeviceBattery.runtimeconfig.json',
  'hostfxr.dll',
  'hostpolicy.dll',
  'coreclr.dll',
  'WindowsBase.dll',
  'Microsoft.Windows.SDK.NET.dll',
  'WinRT.Runtime.dll'
)) {
  $null = Require-File (Join-Path $batteryDir $file) 'Device battery self-contained runtime file'
}

$manifests = @()
if (-not $SkipManifest) {
  $escapedVersion = [Regex]::Escape($ExpectedVersion)
  $escapedSetup = [Regex]::Escape($setupName)
  $manifests = @(Get-ChildItem -LiteralPath $distPath -File -Filter '*.yml' |
    Where-Object { $_.Name -notlike 'builder-*' } |
    Where-Object {
      $content = Get-Content -Raw -LiteralPath $_.FullName
      $content -match "(?m)^version:\s*$escapedVersion\s*$" -and $content -match $escapedSetup
    })
  if ($manifests.Count -lt 1) {
    throw "No update manifest matches version $ExpectedVersion and installer $setupName"
  }
}

$sbom = $null
if (-not $SkipSbom) {
  $sbom = Require-File (Join-Path $distPath 'sbom.cdx.json') 'CycloneDX SBOM'
  $sbomData = Get-Content -Raw -LiteralPath $sbom.FullName | ConvertFrom-Json
  if ([string]$sbomData.bomFormat -ne 'CycloneDX') {
    throw 'SBOM is not a CycloneDX document'
  }
  if ([string]$sbomData.metadata.component.version -ne $ExpectedVersion) {
    throw "SBOM version $($sbomData.metadata.component.version) does not match $ExpectedVersion"
  }
}

if ($RequireSignature) {
  if ([string]::IsNullOrWhiteSpace($ExpectedPublisher)) {
    $ExpectedPublisher = [Environment]::GetEnvironmentVariable('WIN_SIGNING_PUBLISHER')
  }
  if ([string]::IsNullOrWhiteSpace($ExpectedPublisher)) {
    throw 'Expected publisher is required when signature verification is enabled'
  }

  # electron-builder signs extra-resource EXEs by default. Keep the .NET/WPF
  # DLLs as published; do not opt the whole app into re-signing vendor DLLs.
  foreach ($artifact in @($setup, $portable, $mainExecutable, $batteryExecutable)) {
    $signature = Get-AuthenticodeSignature -LiteralPath $artifact.FullName
    if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate) {
      throw "Invalid Authenticode signature for $($artifact.Name): $($signature.Status) $($signature.StatusMessage)"
    }
    if ($null -eq $signature.TimeStamperCertificate) {
      throw "Authenticode timestamp is missing for $($artifact.Name)"
    }
    $publisher = $signature.SignerCertificate.GetNameInfo(
      [Security.Cryptography.X509Certificates.X509NameType]::SimpleName,
      $false
    )
    if ($publisher -cne $ExpectedPublisher) {
      throw "Publisher mismatch for $($artifact.Name): $publisher (expected $ExpectedPublisher)"
    }
  }
}

# This switch skips execution probes, not payload layout or signature checks.
if (-not $SkipFuseVerification) {
  & node (Join-Path $projectRoot 'scripts/verify-electron-fuses.js') $mainExecutable.FullName
  if ($LASTEXITCODE -ne 0) {
    throw "Electron fuse verification exited with code $LASTEXITCODE"
  }
  Invoke-DeviceBatteryProbe $batteryExecutable '--version'
  Invoke-DeviceBatteryProbe $batteryExecutable '--smoke'
  Write-Host 'Packaged device battery protocol and no-hardware smoke verified'
  & (Join-Path $projectRoot 'scripts/verify-packaged-startup.ps1') -ExecutablePath $mainExecutable.FullName
  # The portable wrapper must extract the larger self-contained payload before startup.
  & (Join-Path $projectRoot 'scripts/verify-packaged-startup.ps1') -ExecutablePath $portable.FullName -TimeoutSeconds 45
}

$hashTargets = @($setup, $portable, $blockmap)
$hashTargets += $manifests
if ($null -ne $sbom) {
  $hashTargets += $sbom
}
$hashLines = @($hashTargets |
  Sort-Object Name -Unique |
  ForEach-Object {
    $hash = Get-Sha256Hex $_.FullName
    "$hash *$($_.Name)"
  })
$hashPath = Join-Path $distPath 'SHA256SUMS.txt'
[IO.File]::WriteAllLines($hashPath, $hashLines, [Text.UTF8Encoding]::new($false))

[pscustomobject]@{
  version = $ExpectedVersion
  signed = [bool]$RequireSignature
  setup = $setup.Name
  portable = $portable.Name
  manifests = @($manifests.Name)
  checksums = (Split-Path -Leaf $hashPath)
} | ConvertTo-Json -Compress
