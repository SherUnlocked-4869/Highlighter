[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('nsis', 'portable')]
  [string]$PackageType,

  [Parameter(Mandatory = $true)]
  [string]$Claims,

  [Parameter(Mandatory = $true)]
  [string]$ArtifactPath,

  [ValidateSet('pending', 'pass', 'fail')]
  [string]$Result = 'pending',

  [string]$Reviewer = '',
  [string]$Notes = '',
  [string]$SourceCommit = '',
  [string]$OutputDirectory = '',
  [ValidateSet('', 'P0', 'P1', 'P2')]
  [string]$DefectSeverity = '',
  [string]$IssueUrl = '',
  [string]$Workaround = '',
  [switch]$RunRuntimeProbe
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$package = Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'package.json') | ConvertFrom-Json
$matrix = Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'config/release-hardware-matrix.json') | ConvertFrom-Json

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

$claimList = @($Claims.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ } | Select-Object -Unique)
if ($claimList.Count -eq 0) { throw 'At least one claim is required' }

$requirements = @{}
foreach ($requirement in $matrix.requiredClaims) { $requirements[[string]$requirement.id] = $requirement }
foreach ($claim in $claimList) {
  if (-not $requirements.ContainsKey($claim)) { throw "Unknown hardware claim: $claim" }
  if (@($requirements[$claim].packageTypes) -notcontains $PackageType) {
    throw "Claim $claim does not accept $PackageType evidence"
  }
}

if ($Result -eq 'pass') {
  if ([string]::IsNullOrWhiteSpace($Reviewer)) { throw 'Reviewer is required for passing evidence' }
  if ([string]::IsNullOrWhiteSpace($Notes)) { throw 'Notes are required for passing evidence' }
  if (-not $RunRuntimeProbe) { throw 'Passing evidence must include the runtime probe' }
}
if ($DefectSeverity -eq 'P2' -and ([string]::IsNullOrWhiteSpace($IssueUrl) -or [string]::IsNullOrWhiteSpace($Workaround))) {
  throw 'P2 evidence requires both IssueUrl and Workaround'
}
if ($Result -eq 'fail' -and [string]::IsNullOrWhiteSpace($DefectSeverity)) {
  throw 'Failing evidence requires a defect severity'
}

if ([string]::IsNullOrWhiteSpace($SourceCommit)) {
  $SourceCommit = (& git -C $projectRoot rev-parse HEAD).Trim()
}
if ($LASTEXITCODE -ne 0 -or $SourceCommit -notmatch '^[0-9a-fA-F]{40}$') {
  throw 'SourceCommit must resolve to a full Git commit hash'
}
& git -C $projectRoot cat-file -e "$SourceCommit^{commit}"
if ($LASTEXITCODE -ne 0) { throw "Source commit does not exist: $SourceCommit" }

$resolvedArtifact = (Resolve-Path -LiteralPath $ArtifactPath).Path
$artifact = Get-Item -LiteralPath $resolvedArtifact
if ($artifact.PSIsContainer -or $artifact.Length -le 0) { throw "Artifact is missing or empty: $resolvedArtifact" }
$expectedArtifactName = if ($PackageType -eq 'nsis') {
  "Highlighter-Setup-$($package.version).exe"
} else {
  "Highlighter-$($package.version)-portable.exe"
}
if ($artifact.Name -cne $expectedArtifactName) {
  throw "Artifact name must be $expectedArtifactName"
}
$signature = Get-AuthenticodeSignature -LiteralPath $resolvedArtifact
$publisher = ''
$timestampSubject = ''
if ($null -ne $signature.SignerCertificate) {
  $publisher = $signature.SignerCertificate.GetNameInfo(
    [Security.Cryptography.X509Certificates.X509NameType]::SimpleName,
    $false
  )
}
if ($null -ne $signature.TimeStamperCertificate) {
  $timestampSubject = $signature.TimeStamperCertificate.Subject
}
if ($Result -eq 'pass') {
  if ($signature.Status -ne 'Valid') { throw "Passing evidence requires a valid signature: $($signature.Status)" }
  if ([string]::IsNullOrWhiteSpace($timestampSubject)) { throw 'Passing evidence requires an Authenticode timestamp' }
}

$runtimeProbe = [ordered]@{ status = 'not-run' }
$displays = @()
if ($RunRuntimeProbe) {
  $electronPath = (& node -p "require('electron')").Trim()
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($electronPath)) { throw 'Unable to resolve the Electron executable' }
  $probeRoot = Join-Path ([IO.Path]::GetTempPath()) "highlighter-hardware-probe-$PID"
  $previousNative = $env:HIGHLIGHTER_REQUIRE_NATIVE_RUNTIME
  $previousCapture = $env:HIGHLIGHTER_REQUIRE_CAPTURE_RUNTIME
  $previousRoot = $env:HIGHLIGHTER_RUNTIME_PROBE_DATA_ROOT
  try {
    $env:HIGHLIGHTER_REQUIRE_NATIVE_RUNTIME = '1'
    $env:HIGHLIGHTER_REQUIRE_CAPTURE_RUNTIME = '1'
    $env:HIGHLIGHTER_RUNTIME_PROBE_DATA_ROOT = $probeRoot
    $probeOutput = @(& $electronPath (Join-Path $projectRoot 'scripts/probe-electron-runtime.js') 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "Runtime probe failed:`n$($probeOutput -join [Environment]::NewLine)" }
    $probeLine = $probeOutput | Where-Object { "$_".StartsWith('HIGHLIGHTER_RUNTIME_PROBE=') } | Select-Object -First 1
    if ($null -eq $probeLine) { throw 'Runtime probe did not return evidence JSON' }
    $probeData = "$probeLine".Substring('HIGHLIGHTER_RUNTIME_PROBE='.Length) | ConvertFrom-Json
    $runtimeProbe = [ordered]@{
      status = 'pass'
      electron = [string]$probeData.versions.electron
      nativeRuntimeBuilt = [bool]$probeData.components.nativeRuntimeBuilt
      ocrFilesValidated = [bool]$probeData.components.ocrFilesValidated
      nativeCapture = $probeData.captureRuntime
    }
    $displays = @($probeData.displays)
  } finally {
    $env:HIGHLIGHTER_REQUIRE_NATIVE_RUNTIME = $previousNative
    $env:HIGHLIGHTER_REQUIRE_CAPTURE_RUNTIME = $previousCapture
    $env:HIGHLIGHTER_RUNTIME_PROBE_DATA_ROOT = $previousRoot
    Remove-Item -LiteralPath $probeRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}

$reg = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
$osFamily = if ([int]$reg.CurrentBuild -ge 22000) { 'windows-11' } else { 'windows-10' }
Add-Type -AssemblyName System.Windows.Forms
$sessionType = if ([System.Windows.Forms.SystemInformation]::TerminalServerSession) { 'rdp' } else { 'local' }
$gpus = @(Get-CimInstance Win32_VideoController | ForEach-Object {
  [ordered]@{
    name = [string]$_.Name
    driverVersion = [string]$_.DriverVersion
    driverDate = if ($null -eq $_.DriverDate) { '' } else { ([datetime]$_.DriverDate).ToUniversalTime().ToString('o') }
  }
})

$completedAt = if ($Result -eq 'pending') { $null } else { [DateTimeOffset]::UtcNow.ToString('o') }
$checks = @($claimList | ForEach-Object {
  [ordered]@{
    id = $_
    result = $Result
    notes = $Notes
  }
})
$defects = @()
if (-not [string]::IsNullOrWhiteSpace($DefectSeverity)) {
  $defects = @([ordered]@{
    severity = $DefectSeverity
    issueUrl = $IssueUrl
    workaround = $Workaround
  })
}

$evidence = [ordered]@{
  schemaVersion = 1
  candidate = [ordered]@{
    version = [string]$package.version
    sourceCommit = $SourceCommit.ToLowerInvariant()
  }
  environment = [ordered]@{
    osFamily = $osFamily
    osVersion = [string]$reg.DisplayVersion
    osBuild = "$($reg.CurrentBuild).$($reg.UBR)"
    architecture = [string]$env:PROCESSOR_ARCHITECTURE
    sessionType = $sessionType
    packageType = $PackageType
    gpus = $gpus
    displays = $displays
  }
  artifact = [ordered]@{
    name = $artifact.Name
    size = [long]$artifact.Length
    sha256 = Get-Sha256Hex $resolvedArtifact
    signatureStatus = [string]$signature.Status
    publisher = $publisher
    timestampSubject = $timestampSubject
  }
  probes = [ordered]@{
    runtime = $runtimeProbe
  }
  execution = [ordered]@{
    result = $Result
    completedAt = $completedAt
    claims = $claimList
    checks = $checks
    notes = $Notes
    defects = $defects
  }
  signoff = [ordered]@{
    reviewer = $Reviewer
    reviewedAt = $completedAt
  }
}

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $OutputDirectory = Join-Path $projectRoot "docs/releases/evidence/$($package.version)"
}
[IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null
$stamp = [DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssZ')
$outputPath = Join-Path $OutputDirectory "$stamp-$PackageType-$([Guid]::NewGuid().ToString('N').Substring(0, 8)).json"
[IO.File]::WriteAllText(
  $outputPath,
  ($evidence | ConvertTo-Json -Depth 12),
  [Text.UTF8Encoding]::new($false)
)

[pscustomobject]@{
  output = (Resolve-Path -LiteralPath $outputPath).Path
  version = [string]$package.version
  sourceCommit = $SourceCommit
  result = $Result
  claims = $claimList
  signature = [string]$signature.Status
  runtimeProbe = [string]$runtimeProbe.status
} | ConvertTo-Json -Compress
