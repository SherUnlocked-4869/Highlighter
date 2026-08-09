[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$DistDir,
  [Parameter(Mandatory = $true)][string]$ExpectedVersion,
  [string]$ExpectedPublisher = '',
  [switch]$SkipSignature
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$distPath = (Resolve-Path -LiteralPath $DistDir).Path

function Require-File {
  param([Parameter(Mandatory = $true)][string]$Name)
  $filePath = Join-Path $distPath $Name
  $item = Get-Item -LiteralPath $filePath -ErrorAction SilentlyContinue
  if ($null -eq $item -or $item.PSIsContainer -or $item.Length -le 0) {
    throw "Release asset is missing or empty: $Name"
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
$blockmapName = "$setupName.blockmap"
$manifestName = if ($ExpectedVersion -match '-alpha(?:\.|$)') {
  'alpha.yml'
} elseif ($ExpectedVersion -match '-beta(?:\.|$)') {
  'beta.yml'
} else {
  'latest.yml'
}
$requiredNames = @($setupName, $portableName, $blockmapName, $manifestName, 'sbom.cdx.json')
$requiredFiles = @{}
foreach ($name in $requiredNames) { $requiredFiles[$name] = Require-File $name }
$checksums = Require-File 'SHA256SUMS.txt'

$manifest = Get-Content -Raw -LiteralPath $requiredFiles[$manifestName].FullName
$escapedVersion = [Regex]::Escape($ExpectedVersion)
$escapedSetup = [Regex]::Escape($setupName)
if ($manifest -notmatch "(?m)^version:\s*$escapedVersion\s*$" -or $manifest -notmatch "(?m)^(path|url):\s*$escapedSetup\s*$") {
  throw "$manifestName does not bind version $ExpectedVersion to $setupName"
}

$sbom = Get-Content -Raw -LiteralPath $requiredFiles['sbom.cdx.json'].FullName | ConvertFrom-Json
if ([string]$sbom.bomFormat -ne 'CycloneDX') { throw 'SBOM is not a CycloneDX document' }
if ([string]$sbom.metadata.component.version -ne $ExpectedVersion) {
  throw "SBOM version $($sbom.metadata.component.version) does not match $ExpectedVersion"
}

$expectedHashes = @{}
foreach ($line in Get-Content -LiteralPath $checksums.FullName) {
  if ($line -notmatch '^([0-9A-Fa-f]{64}) \*([^\\/]+)$') { throw "Invalid SHA256SUMS line: $line" }
  $expectedHashes[$Matches[2]] = $Matches[1].ToUpperInvariant()
}
foreach ($name in $requiredNames) {
  if (-not $expectedHashes.ContainsKey($name)) { throw "SHA256SUMS.txt is missing $name" }
  $actualHash = Get-Sha256Hex $requiredFiles[$name].FullName
  if ($actualHash -cne $expectedHashes[$name]) { throw "SHA-256 mismatch for $name" }
}

if (-not $SkipSignature) {
  if ([string]::IsNullOrWhiteSpace($ExpectedPublisher)) {
    $ExpectedPublisher = [Environment]::GetEnvironmentVariable('WIN_SIGNING_PUBLISHER')
  }
  if ([string]::IsNullOrWhiteSpace($ExpectedPublisher)) { throw 'Expected publisher is required' }
  foreach ($file in @($requiredFiles[$setupName], $requiredFiles[$portableName])) {
    $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
    if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate) {
      throw "Invalid Authenticode signature for $($file.Name): $($signature.Status)"
    }
    if ($null -eq $signature.TimeStamperCertificate) {
      throw "Authenticode timestamp is missing for $($file.Name)"
    }
    $publisher = $signature.SignerCertificate.GetNameInfo(
      [Security.Cryptography.X509Certificates.X509NameType]::SimpleName,
      $false
    )
    if ($publisher -cne $ExpectedPublisher) {
      throw "Publisher mismatch for $($file.Name): $publisher (expected $ExpectedPublisher)"
    }
  }
}

[pscustomobject]@{
  version = $ExpectedVersion
  manifest = $manifestName
  signed = -not $SkipSignature
  assets = $requiredNames
} | ConvertTo-Json -Compress
