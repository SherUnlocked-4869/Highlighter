param(
  [Parameter(Mandatory = $true)]
  [string]$ExecutablePath,
  [int]$TimeoutSeconds = 10
)

$ErrorActionPreference = 'Stop'

$resolved = (Resolve-Path -LiteralPath $ExecutablePath -ErrorAction Stop).Path
$item = Get-Item -LiteralPath $resolved
if (-not $item.PSIsContainer -and $item.Extension -ieq '.exe') {
  $process = Start-Process -FilePath $resolved -ArgumentList '--highlighter-packaged-startup-probe' -WorkingDirectory $item.DirectoryName -PassThru
  try {
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
      throw "Packaged startup probe timed out after $TimeoutSeconds seconds: $resolved"
    }
    if ($process.ExitCode -ne 0) {
      $unsignedExitCode = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int32]$process.ExitCode), 0)
      $hexCode = '0x{0:X8}' -f $unsignedExitCode
      throw "Packaged startup probe failed with exit code $($process.ExitCode) ($hexCode): $resolved"
    }
  } finally {
    $process.Dispose()
  }
} else {
  throw "Packaged startup probe requires an executable file: $resolved"
}

Write-Host "Packaged Electron startup verified: $($item.Name)"
