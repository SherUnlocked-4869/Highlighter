# R0-07 first-round performance / process-tree comparison runner.
#
# 对比对象（同一台机器、同一电源方案、同一显示状态；Release/生产构建条件）：
#   1. Electron 最小壳（.tmp-r07/perf/electron-minimal/main.js）：单窗口 + 一个渲染进程，空闲
#   2. Tauri R0-03 原型 Release（rust-app/target/release/highlighter-r0-window.exe）：
#      单透明浮层 + WebView2，空闲（单屏主机需 HIGHLIGHTER_R0_ALLOW_PRIMARY=1 测试开关）
#   3. （可选 -IncludeProduct）Electron 产品基线：E2E 隔离数据根 + dev 构建，
#      分别测“主窗口打开”与“关闭主窗口后的托盘空闲”两个状态（计划 §9.2 的目标状态）。
# 每次运行：启动 -> 等到 ready 标记（启动耗时）-> measure-resources.ps1 采样 -> 关闭 -> 残留检查。
#
# 用法（仓库根目录；生成/修改本文件时保持 UTF-8 with BOM，PS 5.1 需要）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/rust/measure-r0-07-performance.ps1 -Runs 3 -IdleSec 30 -IncludeProduct
# 产物：.tmp-r07/perf/results/<kind>-run<N>.sample.json + summary.json（.tmp* 已 gitignore）。
param(
  [int]$Runs = 3,
  [int]$IdleSec = 30,
  [int]$IntervalMs = 2000,
  [string]$OutDir = '.tmp-r07/perf/results',
  [string]$ElectronExe = 'node_modules/electron/dist/electron.exe',
  [string]$ElectronApp = '.tmp-r07/perf/electron-minimal/main.js',
  [string]$TauriExe = 'rust-app/target/release/highlighter-r0-window.exe',
  [switch]$SkipElectron,
  [switch]$SkipTauri,
  [switch]$IncludeProduct,
  [string]$ProductApp = '.',
  [string]$ProductDataRootBase = '.tmp-r07/perf/product-data',
  [string]$UsageHome = 'test/fixtures/usage/home',
  [switch]$NoPowerPlanChange
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $repo
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$scratchTmp = Join-Path $repo '.tmp-r07\perf\tmp'
New-Item -ItemType Directory -Force -Path $scratchTmp | Out-Null

$sampler = Join-Path $PSScriptRoot 'measure-resources.ps1'
$logDir = Join-Path $OutDir 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Get-PowerPlan {
  (powercfg /getactivescheme | Out-String).Trim()
}

function Get-PowerPlanGuid {
  $text = (powercfg /getactivescheme | Out-String)
  if ($text -match '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})') { return $Matches[1] }
  return $null
}

function Set-HighPerformancePlan {
  $high = '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c'
  $prev = Get-PowerPlanGuid
  powercfg /setactive $high | Out-Null
  if ($LASTEXITCODE -ne 0) { Write-Warning 'failed to switch to High performance plan; continuing with current plan' }
  return $prev
}

function Wait-Marker([string]$file, [string]$pattern, [int]$timeoutMs, [System.Diagnostics.Stopwatch]$sw) {
  $deadline = (Get-Date).AddMilliseconds($timeoutMs)
  while ((Get-Date) -lt $deadline) {
    if (Test-Path $file) {
      $text = Get-Content $file -Raw -ErrorAction SilentlyContinue
      if ($text -and $text -match $pattern) { return $sw.ElapsedMilliseconds }
    }
    Start-Sleep -Milliseconds 50
  }
  return -1
}

function Get-ProcessTree([int]$rootPid) {
  $procs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  $tree = New-Object System.Collections.ArrayList
  [void]$tree.Add($rootPid)
  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($proc in $procs) {
      if (($tree -contains [int]$proc.ParentProcessId) -and -not ($tree -contains [int]$proc.ProcessId)) {
        [void]$tree.Add([int]$proc.ProcessId); $changed = $true
      }
    }
  }
  return $tree
}

function Get-Orphans([string]$kind, [string]$marker, $treePids) {
  if ($kind -eq 'electron-product') {
    $alive = @()
    foreach ($id in $treePids) { if (Get-Process -Id $id -ErrorAction SilentlyContinue) { $alive += $id } }
    return $alive
  }
  if ($kind -eq 'electron-minimal') {
    return @(Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -like '*electron-minimal*' } |
      ForEach-Object { $_.ProcessId })
  }
  if ($kind -eq 'tauri-r0-03') {
    $found = @(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -like "*$marker*" } |
      ForEach-Object { $_.ProcessId })
    $found += @(Get-CimInstance Win32_Process -Filter "Name='highlighter-r0-window.exe'" -ErrorAction SilentlyContinue |
      ForEach-Object { $_.ProcessId })
    return $found
  }
  return @()
}

function Stop-Tree([int]$rootPid) {
  $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$rootPid" -ErrorAction SilentlyContinue)
  foreach ($c in $children) { Stop-Tree -rootPid ([int]$c.ProcessId) }
  Stop-Process -Id $rootPid -Force -ErrorAction SilentlyContinue
}

function Read-Sample([string]$jsonPath) {
  if (-not (Test-Path $jsonPath)) { return $null }
  return (Get-Content $jsonPath -Raw | ConvertFrom-Json)
}

function Show-Run([string]$kind, [int]$run, [string]$state, $startupMs, $sample, [int]$orphans) {
  if ($null -eq $sample) {
    Write-Host ("[{0}/{1}] run {2}: startup={3}ms sample=MISSING orphans={4}" -f $kind, $state, $run, $startupMs, $orphans)
    return
  }
  Write-Host ("[{0}/{1}] run {2}: startup={3}ms private_mean={4}MB private_p95={5}MB ws_mean={6}MB procs={7} cpu={8}% orphans={9}" -f $kind, $state, $run, $startupMs,
    [math]::Round($sample.summary.private_bytes_mean / 1MB, 1),
    [math]::Round($sample.summary.private_bytes_p95 / 1MB, 1),
    [math]::Round($sample.summary.working_set_mean / 1MB, 1),
    $sample.summary.process_count_max, $sample.summary.cpu_percent_mean, $orphans)
}

function New-RunRecord([string]$kind, [string]$state, [int]$run, $startupMs, $sample, [int]$orphans, [string]$sampleFile, [string]$logFile) {
  return [pscustomobject]@{
    kind = $kind; state = $state; run = $run
    startup_ms = $startupMs
    sample_file = $sampleFile
    log_file = $logFile
    sample = $sample
    orphans_after_exit = $orphans
  }
}

$results = [pscustomobject]@{
  sampled_at = (Get-Date).ToString('o')
  runs_planned = $Runs
  idle_sec = $IdleSec
  interval_ms = $IntervalMs
  include_product = [bool]$IncludeProduct
  host = [pscustomobject]@{
    computer = $env:COMPUTERNAME
    power_plan_before = Get-PowerPlan
    logical_cores = [Environment]::ProcessorCount
    tauri_exe = $TauriExe
    tauri_exe_sha256 = if (Test-Path $TauriExe) { (Get-FileHash $TauriExe -Algorithm SHA256).Hash.ToLower() } else { $null }
    electron_exe = $ElectronExe
    electron_version = (node -p "require('./node_modules/electron/package.json').version" 2>$null)
    app_version = (node -p "require('./package.json').version" 2>$null)
  }
  runs = @()
}

$prevPlan = $null
if (-not $NoPowerPlanChange) { $prevPlan = Set-HighPerformancePlan }
$results.host | Add-Member -NotePropertyName power_plan_during -NotePropertyValue (Get-PowerPlan) -Force

try {
  for ($i = 1; $i -le $Runs; $i++) {
    if (-not $SkipElectron) {
      $stdout = Join-Path $logDir ("electron-run$i.stdout.txt")
      $stderr = Join-Path $logDir ("electron-run$i.stderr.txt")
      Remove-Item $stdout, $stderr -ErrorAction SilentlyContinue
      $env:ELECTRON_RUN_AS_NODE = $null
      $env:TMP = $scratchTmp
      $env:TEMP = $scratchTmp
      $env:HL_PERF_HOLD_MS = [string](($IdleSec + 20) * 1000)
      $env:HL_PERF_USER_DATA = (Join-Path $scratchTmp "electron-userdata-$i")
      $sw = [System.Diagnostics.Stopwatch]::StartNew()
      $p = Start-Process -FilePath (Join-Path $repo $ElectronExe) -ArgumentList '--no-sandbox', (Join-Path $repo $ElectronApp) -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru -NoNewWindow
      $startupMs = Wait-Marker $stdout 'SHELL_READY' 30000 $sw
      if ($startupMs -lt 0) { $startupMs = Wait-Marker $stdout 'APP_READY' 5000 $sw }
      $sw.Stop()
      $runJson = Join-Path $OutDir ("electron-run$i.sample.json")
      $sample = $null
      if ($startupMs -ge 0 -and -not $p.HasExited) {
        & $sampler -RootPid $p.Id -Label "electron-run$i" -DurationSec $IdleSec -IntervalMs $IntervalMs -OutFile $runJson | Out-Null
        $sample = Read-Sample $runJson
      }
      if (-not $p.HasExited) { $p.WaitForExit(90000) | Out-Null }
      if (-not $p.HasExited) { Stop-Tree -rootPid $p.Id }
      Start-Sleep -Seconds 3
      $orphans = @(Get-Orphans 'electron-minimal' '' $null)
      $results.runs += New-RunRecord 'electron-minimal' 'window-idle' $i $startupMs $sample $orphans.Count (Split-Path -Leaf $runJson) (Split-Path -Leaf $stdout)
      Show-Run 'electron-minimal' $i 'window-idle' $startupMs $sample $orphans.Count
    }

    if (-not $SkipTauri) {
      if (-not (Test-Path (Join-Path $repo $TauriExe))) {
        Write-Warning "tauri release exe missing: $TauriExe (skip)"
      } else {
        $stdout = Join-Path $logDir ("tauri-run$i.stdout.txt")
        $stderr = Join-Path $logDir ("tauri-run$i.stderr.txt")
        Remove-Item $stdout, $stderr -ErrorAction SilentlyContinue
        $env:HIGHLIGHTER_R0_ALLOW_PRIMARY = '1'
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $p = Start-Process -FilePath (Join-Path $repo $TauriExe) -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru -NoNewWindow
        $startupMs = Wait-Marker $stdout 'overlay\] shown' 30000 $sw
        if ($startupMs -lt 0) { $startupMs = Wait-Marker $stdout 'handshake\] ready' 5000 $sw }
        $sw.Stop()
        $runJson = Join-Path $OutDir ("tauri-run$i.sample.json")
        $sample = $null
        if ($startupMs -ge 0 -and -not $p.HasExited) {
          & $sampler -RootPid $p.Id -Label "tauri-run$i" -DurationSec $IdleSec -IntervalMs $IntervalMs -OutFile $runJson | Out-Null
          $sample = Read-Sample $runJson
        }
        if (-not $p.HasExited) { Stop-Tree -rootPid $p.Id }
        Start-Sleep -Seconds 3
        $orphans = @(Get-Orphans 'tauri-r0-03' 'r0-window-webview2-data' $null)
        $results.runs += New-RunRecord 'tauri-r0-03' 'window-idle' $i $startupMs $sample $orphans.Count (Split-Path -Leaf $runJson) (Split-Path -Leaf $stdout)
        Show-Run 'tauri-r0-03' $i 'window-idle' $startupMs $sample $orphans.Count
      }
    }

    if ($IncludeProduct) {
      $dataRoot = Join-Path $repo ("$ProductDataRootBase-run$i")
      New-Item -ItemType Directory -Force -Path $dataRoot | Out-Null
      $stdout = Join-Path $logDir ("product-run$i.stdout.txt")
      $stderr = Join-Path $logDir ("product-run$i.stderr.txt")
      Remove-Item $stdout, $stderr -ErrorAction SilentlyContinue
      $env:ELECTRON_RUN_AS_NODE = $null
      $env:TMP = $scratchTmp
      $env:TEMP = $scratchTmp
      $env:HIGHLIGHTER_E2E = '1'
      $env:HIGHLIGHTER_E2E_DATA_ROOT = $dataRoot
      $env:HIGHLIGHTER_E2E_FAKE_EVERYTHING = '1'
      $env:HIGHLIGHTER_USAGE_HOME = (Join-Path $repo $UsageHome)
      $sw = [System.Diagnostics.Stopwatch]::StartNew()
      $p = Start-Process -FilePath (Join-Path $repo $ElectronExe) -ArgumentList '--no-sandbox', (Join-Path $repo $ProductApp) -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru -NoNewWindow
      $startupMs = Wait-Marker $stdout 'main-window\.ready' 40000 $sw
      $sw.Stop()
      $windowJson = Join-Path $OutDir ("product-run$i.window.sample.json")
      $windowSample = $null
      if ($startupMs -ge 0 -and -not $p.HasExited) {
        Start-Sleep -Seconds 2
        & $sampler -RootPid $p.Id -Label "product-run$i-window" -DurationSec $IdleSec -IntervalMs $IntervalMs -OutFile $windowJson | Out-Null
        $windowSample = Read-Sample $windowJson
        $results.runs += New-RunRecord 'electron-product' 'main-window-open' $i $startupMs $windowSample 0 (Split-Path -Leaf $windowJson) (Split-Path -Leaf $stdout)
        Show-Run 'electron-product' $i 'main-window-open' $startupMs $windowSample 0
        $gp = Get-Process -Id $p.Id -ErrorAction SilentlyContinue
        if ($gp) { [void]$gp.CloseMainWindow() }
        Start-Sleep -Seconds 4
        $gp = Get-Process -Id $p.Id -ErrorAction SilentlyContinue
        if ($gp -and -not $gp.HasExited) {
          $trayJson = Join-Path $OutDir ("product-run$i.tray.sample.json")
          & $sampler -RootPid $p.Id -Label "product-run$i-tray" -DurationSec $IdleSec -IntervalMs $IntervalMs -OutFile $trayJson | Out-Null
          $traySample = Read-Sample $trayJson
          $results.runs += New-RunRecord 'electron-product' 'tray-idle' $i $startupMs $traySample 0 (Split-Path -Leaf $trayJson) (Split-Path -Leaf $stdout)
          Show-Run 'electron-product' $i 'tray-idle' $startupMs $traySample 0
        } else {
          Write-Warning "product run $i exited after closing main window; tray-idle state unavailable"
        }
      } else {
        Write-Warning "product run $i did not reach main-window.ready (startup=$startupMs)"
      }
      $tree = @(Get-ProcessTree -rootPid $p.Id)
      if (-not $p.HasExited) { Stop-Tree -rootPid $p.Id }
      Start-Sleep -Seconds 3
      $orphans = @(Get-Orphans 'electron-product' '' $tree)
      $results.runs += [pscustomobject]@{
        kind = 'electron-product'; state = 'after-exit'; run = $i; startup_ms = $startupMs
        sample_file = $null; log_file = (Split-Path -Leaf $stdout); sample = $null; orphans_after_exit = $orphans.Count
      }
      Write-Host ("[electron-product/after-exit] run {0}: orphans={1}" -f $i, $orphans.Count)
    }
  }
} finally {
  if ($prevPlan) { powercfg /setactive $prevPlan | Out-Null }
  $results | Add-Member -NotePropertyName power_plan_after -NotePropertyValue (Get-PowerPlan) -Force
}

$summaryPath = Join-Path $OutDir 'summary.json'
$results | ConvertTo-Json -Depth 14 | Set-Content -Encoding UTF8 $summaryPath
Write-Host "wrote $summaryPath"
