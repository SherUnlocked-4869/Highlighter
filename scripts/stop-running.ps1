$ErrorActionPreference = 'Stop'

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$nativeProcessNames = @('Highlighter.exe', 'HighlighterOcrSidecar.exe', 'OcrSidecar.exe', 'SmartSelect.exe')

$targets = @(Get-CimInstance Win32_Process | Where-Object {
  if ($nativeProcessNames -contains $_.Name) {
    return $true
  }

  if ($_.Name -ine 'electron.exe' -or [string]::IsNullOrWhiteSpace($_.CommandLine)) {
    return $false
  }

  return $_.CommandLine.IndexOf($projectRoot, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
})

if ($targets.Count -eq 0) {
  Write-Host 'Highlighter is not running.'
  exit 0
}

foreach ($target in $targets) {
  try {
    Stop-Process -Id $target.ProcessId -Force -ErrorAction Stop
    Write-Host "Stopped $($target.Name) (PID $($target.ProcessId))."
  } catch [Microsoft.PowerShell.Commands.ProcessCommandException] {
    # The process may exit between discovery and termination.
    if (Get-Process -Id $target.ProcessId -ErrorAction SilentlyContinue) {
      throw
    }
  }
}

$deadline = [DateTime]::UtcNow.AddSeconds(5)
do {
  $runningIds = @($targets.ProcessId | Where-Object {
    Get-Process -Id $_ -ErrorAction SilentlyContinue
  })

  if ($runningIds.Count -eq 0) {
    exit 0
  }

  Start-Sleep -Milliseconds 100
} while ([DateTime]::UtcNow -lt $deadline)

throw "Timed out waiting for Highlighter processes to stop: $($runningIds -join ', ')"
