<#
.SYNOPSIS
  Start tauri-driver + matched msedgedriver, run the ADR-0006 minimal WebDriver probe, then clean up.

.DESCRIPTION
  Desktop E2E feasibility probe for the R0-03 prototype (not a product test framework). Steps:
    1. Validate tauri-driver / msedgedriver / application executable.
    2. Point TMP/TEMP at an in-repo scratch dir (confined hosts cannot write %LOCALAPPDATA%Temp).
    3. With -AllowPrimaryScreen set HIGHLIGHTER_R0_ALLOW_PRIMARY=1 (test-only switch, single-screen hosts).
    4. Start tauri-driver in the background (it spawns msedgedriver), wait for 127.0.0.1:<Port>.
    5. Run scripts/rust/probe-tauri-webdriver.js (full W3C WebDriver flow).
    6. Finally stop tauri-driver and its msedgedriver child, print the evidence dir.

  Exit code: the probe script exit code (0 pass; 2 assertion failure; 3 new session failure); 1 on env errors.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/rust/run-tauri-webdriver-probe.ps1 `
    -NativeDriver .tmp-r07\driver\msedgedriver\157.0.4341.46\msedgedriver.exe -AllowPrimaryScreen
#>
[CmdletBinding()]
param(
  [string]$App = '',
  [string]$TauriDriver = 'tauri-driver',
  [string]$NativeDriver = '',
  [int]$Port = 4444,
  [int]$NativePort = 4445,
  [string]$OutDir = '',
  [switch]$AllowPrimaryScreen,
  [int]$StartupTimeoutSec = 30,
  [switch]$KeepDriver
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not $App) { $App = Join-Path $repoRoot 'rust-app\target\debug\highlighter-r0-window.exe' }
if (-not $OutDir) { $OutDir = Join-Path $repoRoot '.tmp-r07\driver\webdriver-ci' }
if (-not $NativeDriver) {
  throw 'Missing -NativeDriver: pass the msedgedriver.exe that exactly matches the WebView2 Runtime version (ADR-0006 freeze requirement).'
}
if (-not (Test-Path $App)) { throw "Application executable not found: $App" }
if (-not (Test-Path $NativeDriver)) { throw "msedgedriver not found: $NativeDriver" }
$tauriDriverCommand = Get-Command $TauriDriver -ErrorAction SilentlyContinue
if (-not $tauriDriverCommand) {
  throw "tauri-driver not found ($TauriDriver). Install with: cargo install tauri-driver --locked (into CARGO_HOME\bin)"
}
$tauriDriverPath = $tauriDriverCommand.Source

$outPath = [System.IO.Path]::GetFullPath($OutDir)
New-Item -ItemType Directory -Force -Path $outPath | Out-Null
$tmpDir = Join-Path $repoRoot '.tmp-r07\driver\tmp-ci'
New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
$stdoutLog = Join-Path $outPath 'tauri-driver.stdout.log'
$stderrLog = Join-Path $outPath 'tauri-driver.stderr.log'

# Save and override environment variables visible to child processes; restore at exit.
$savedEnv = @{
  TMP = $env:TMP
  TEMP = $env:TEMP
  HIGHLIGHTER_R0_ALLOW_PRIMARY = $env:HIGHLIGHTER_R0_ALLOW_PRIMARY
}
$driver = $null
$probeExit = 1
try {
  $env:TMP = $tmpDir
  $env:TEMP = $tmpDir
  if ($AllowPrimaryScreen) { $env:HIGHLIGHTER_R0_ALLOW_PRIMARY = '1' } else { Remove-Item Env:HIGHLIGHTER_R0_ALLOW_PRIMARY -ErrorAction SilentlyContinue }

  Write-Host "[probe] tauri-driver  : $tauriDriverPath"
  Write-Host "[probe] msedgedriver : $NativeDriver"
  Write-Host "[probe] application  : $App"
  Write-Host "[probe] out dir      : $outPath"
  Write-Host "[probe] allow_primary=$($AllowPrimaryScreen.IsPresent)"

  $arguments = @('--port', $Port, '--native-port', $NativePort, '--native-driver', $NativeDriver)
  $driver = Start-Process -FilePath $tauriDriverPath -ArgumentList $arguments -PassThru -NoNewWindow `
    -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog
  Write-Host "[probe] tauri-driver pid=$($driver.Id), waiting for 127.0.0.1:$Port ..."

  $deadline = (Get-Date).AddSeconds($StartupTimeoutSec)
  $ready = $false
  $client = $null
  while ((Get-Date) -lt $deadline) {
    if ($driver.HasExited) { throw "tauri-driver exited early, exit=$($driver.ExitCode); see $stderrLog" }
    try {
      $client = [System.Net.Sockets.TcpClient]::new()
      $client.Connect('127.0.0.1', $Port)
      $client.Close()
      $ready = $true
      break
    } catch {
      Start-Sleep -Milliseconds 250
    }
  }
  if (-not $ready) { throw "tauri-driver did not listen on 127.0.0.1:$Port within $StartupTimeoutSec s" }

  $env:WEBDRIVER_URL = "http://127.0.0.1:$Port"
  $probe = Join-Path $PSScriptRoot 'probe-tauri-webdriver.js'
  & node $probe --app $App --out $outPath
  $probeExit = $LASTEXITCODE
  Write-Host "[probe] node probe exit=$probeExit"
} finally {
  if ($driver -and -not $KeepDriver) {
    # msedgedriver is a child of tauri-driver; tauri-driver uses a Windows Job object
    # (limit_kill_on_job_close) so children die with it. Kill explicit children as a fallback.
    $nativePids = @(Get-CimInstance Win32_Process -Filter "Name='msedgedriver.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.ParentProcessId -eq $driver.Id } | Select-Object -ExpandProperty ProcessId)
    if (-not $driver.HasExited) { Stop-Process -Id $driver.Id -Force -ErrorAction SilentlyContinue }
    foreach ($nativePid in $nativePids) { Stop-Process -Id $nativePid -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 500
    Write-Host "[probe] driver cleaned (tauri-driver pid=$($driver.Id), native pids=$($nativePids -join ','))"
  }
  $env:TMP = $savedEnv.TMP
  $env:TEMP = $savedEnv.TEMP
  if ($null -eq $savedEnv.HIGHLIGHTER_R0_ALLOW_PRIMARY) {
    Remove-Item Env:HIGHLIGHTER_R0_ALLOW_PRIMARY -ErrorAction SilentlyContinue
  } else {
    $env:HIGHLIGHTER_R0_ALLOW_PRIMARY = $savedEnv.HIGHLIGHTER_R0_ALLOW_PRIMARY
  }
  Remove-Item Env:WEBDRIVER_URL -ErrorAction SilentlyContinue
}
Write-Host "[probe] evidence: $outPath"
exit $probeExit
