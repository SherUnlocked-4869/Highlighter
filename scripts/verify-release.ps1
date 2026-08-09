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

$setupName = "Highlighter-Setup-$ExpectedVersion.exe"
$portableName = "Highlighter-$ExpectedVersion-portable.exe"
$setup = Require-File (Join-Path $distPath $setupName) 'NSIS installer'
$portable = Require-File (Join-Path $distPath $portableName) 'Portable executable'
$blockmap = Require-File (Join-Path $distPath "$setupName.blockmap") 'NSIS blockmap'
$mainExecutable = Require-File (Join-Path $distPath 'win-unpacked/Highlighter.exe') 'Packaged application executable'

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

if (-not $SkipFuseVerification) {
  & node (Join-Path $projectRoot 'scripts/verify-electron-fuses.js') $mainExecutable.FullName
  if ($LASTEXITCODE -ne 0) {
    throw "Electron fuse verification exited with code $LASTEXITCODE"
  }
  & (Join-Path $projectRoot 'scripts/verify-packaged-startup.ps1') -ExecutablePath $mainExecutable.FullName
  & (Join-Path $projectRoot 'scripts/verify-packaged-startup.ps1') -ExecutablePath $portable.FullName -TimeoutSeconds 20
}

if ($RequireSignature) {
  if ([string]::IsNullOrWhiteSpace($ExpectedPublisher)) {
    $ExpectedPublisher = [Environment]::GetEnvironmentVariable('WIN_SIGNING_PUBLISHER')
  }
  if ([string]::IsNullOrWhiteSpace($ExpectedPublisher)) {
    throw 'Expected publisher is required when signature verification is enabled'
  }

  foreach ($artifact in @($setup, $portable, $mainExecutable)) {
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
