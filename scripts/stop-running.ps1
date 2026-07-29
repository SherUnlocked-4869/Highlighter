$ErrorActionPreference = 'Stop'

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$nativeProcessNames = @('Highlighter', 'HighlighterOcrSidecar', 'OcrSidecar', 'SmartSelect')
$projectElectron = [System.IO.Path]::GetFullPath(
  (Join-Path $projectRoot 'node_modules\electron\dist\electron.exe')
)

$targets = @(
  foreach ($name in $nativeProcessNames) {
    @(Get-Process -Name $name -ErrorAction SilentlyContinue)
  }

  foreach ($process in @(Get-Process -Name 'electron' -ErrorAction SilentlyContinue)) {
    try {
      if ([System.IO.Path]::GetFullPath($process.Path).Equals(
        $projectElectron,
        [System.StringComparison]::OrdinalIgnoreCase
      )) {
        $process
      }
    } catch {
      # A process can exit or deny path access while it is being inspected.
    }
  }
) | Sort-Object Id -Unique

if ($targets.Count -eq 0) {
  Write-Host 'Highlighter is not running.'
  exit 0
}

foreach ($target in $targets) {
  try {
    Stop-Process -Id $target.Id -Force -ErrorAction Stop
    Write-Host "Stopped $($target.ProcessName) (PID $($target.Id))."
  } catch [Microsoft.PowerShell.Commands.ProcessCommandException] {
    # Sandboxed Electron children can deny direct termination but exit after
    # their main process. The bounded wait below remains the source of truth.
  }
}

$deadline = [DateTime]::UtcNow.AddSeconds(5)
do {
  $runningIds = @($targets.Id | Where-Object {
    Get-Process -Id $_ -ErrorAction SilentlyContinue
  })

  if ($runningIds.Count -eq 0) {
    exit 0
  }

  Start-Sleep -Milliseconds 100
} while ([DateTime]::UtcNow -lt $deadline)

throw "Timed out waiting for Highlighter processes to stop: $($runningIds -join ', ')"
