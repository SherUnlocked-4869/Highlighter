[CmdletBinding()]
param(
  [string]$OutputPath = "dist/electron-builder.azure.json"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Require-EnvironmentValue {
  param([Parameter(Mandatory = $true)][string]$Name)

  $value = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrWhiteSpace($value)) {
    throw "Required release signing value is missing: $Name"
  }
  return $value.Trim()
}

function Write-ConfigFile {
  param(
    [Parameter(Mandatory = $true)][hashtable]$Config,
    [Parameter(Mandatory = $true)][string]$OutputPath
  )

  $projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
  $resolvedOutput = if ([IO.Path]::IsPathRooted($OutputPath)) {
    [IO.Path]::GetFullPath($OutputPath)
  } else {
    [IO.Path]::GetFullPath((Join-Path $projectRoot $OutputPath))
  }
  $outputDirectory = Split-Path -Parent $resolvedOutput
  [IO.Directory]::CreateDirectory($outputDirectory) | Out-Null
  $json = $Config | ConvertTo-Json -Depth 6
  [IO.File]::WriteAllText($resolvedOutput, $json, [Text.UTF8Encoding]::new($false))
  Write-Output $resolvedOutput
}

$provider = [Environment]::GetEnvironmentVariable('WIN_SIGNING_PROVIDER')
if (-not [string]::IsNullOrWhiteSpace($provider)) {
  $provider = $provider.Trim().ToLowerInvariant()
  $publisher = Require-EnvironmentValue 'WIN_SIGNING_PUBLISHER'

  if ($provider -eq 'pfx') {
    Require-EnvironmentValue 'WIN_CSC_LINK' | Out-Null
    Require-EnvironmentValue 'WIN_CSC_KEY_PASSWORD' | Out-Null
    Write-Output 'electron-builder.release.cjs'
    return
  }

  if ($provider -ne 'azure') {
    throw "Unsupported WIN_SIGNING_PROVIDER: $provider (expected azure or pfx)"
  }

  Require-EnvironmentValue 'AZURE_TENANT_ID' | Out-Null
  Require-EnvironmentValue 'AZURE_CLIENT_ID' | Out-Null
  Require-EnvironmentValue 'AZURE_CLIENT_SECRET' | Out-Null

  $config = [ordered]@{
    extends = 'file:electron-builder.release.cjs'
    win = [ordered]@{
      azureSignOptions = [ordered]@{
        publisherName = $publisher
        endpoint = Require-EnvironmentValue 'WIN_AZURE_ENDPOINT'
        certificateProfileName = Require-EnvironmentValue 'WIN_AZURE_CERTIFICATE_PROFILE'
        codeSigningAccountName = Require-EnvironmentValue 'WIN_AZURE_CODE_SIGNING_ACCOUNT'
        fileDigest = 'SHA256'
        timestampDigest = 'SHA256'
        timestampRfc3161 = 'http://timestamp.acs.microsoft.com'
      }
    }
  }
  Write-ConfigFile -Config $config -OutputPath $OutputPath
  return
}

Write-Host 'WIN_SIGNING_PROVIDER is not configured; producing an unsigned release configuration'
$config = [ordered]@{
  extends = 'file:electron-builder.release.cjs'
  forceCodeSigning = $false
  win = [ordered]@{
    signExecutable = $false
    verifyUpdateCodeSignature = $false
  }
}
Write-ConfigFile -Config $config -OutputPath $OutputPath
