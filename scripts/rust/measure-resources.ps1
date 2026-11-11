# R0-07 resource sampler: sample a Windows process tree (root PID + descendants).
#
# 用途：计划 §9.2 / R0-07 首轮性能对照。只读取进程计数，不注入、不修改目标进程。
# 输出 JSON（默认 stdout；-OutFile 写文件）：
#   { label, sampled_at, interval_ms, samples: [...], summary: {...} }
#
# 指标口径（与 r0-performance-baseline.md 一致）：
#   private_bytes  = Get-Process PrivateMemorySize64 合计（提交/私有字节，对应计划 §9.2 Private Bytes）
#   working_set    = Get-Process WorkingSet64 合计
#   handles/threads= 合计
#   cpu_percent    = 采样区间内 TotalProcessorTime 增量 / (区间秒 * 逻辑核数) * 100
# 注意：Working Set 合计不等于独占 RAM；不同功能状态不可直接比较（文档说明）。
#
# 编码说明：本文件为 UTF-8 with BOM。Windows PowerShell 5.1 在 GBK 代码页下会把
# 无 BOM 的 UTF-8 中文注释行尾字节与换行拼成非法序列并吞掉换行，导致 param 块解析失败；
# 带 BOM 后 5.1 与 PowerShell 7 均可正确解析（本仓库脚本统一要求两版本可运行）。
param(
  [Parameter(Mandatory = $true)][int]$RootPid,
  [string]$Label = 'sample',
  [int]$DurationSec = 30,
  [int]$IntervalMs = 2000,
  [string]$OutFile = ''
)

$ErrorActionPreference = 'Stop'
$logicalCores = [Environment]::ProcessorCount

function Get-DescendantPids([int]$root, [hashtable]$parentMap) {
  $children = @{}
  foreach ($k in $parentMap.Keys) {
    $p = $parentMap[$k]
    if (-not $children.ContainsKey($p)) { $children[$p] = New-Object System.Collections.ArrayList }
    [void]$children[$p].Add($k)
  }
  $result = New-Object System.Collections.ArrayList
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue($root)
  while ($queue.Count -gt 0) {
    $cur = $queue.Dequeue()
    if ($children.ContainsKey($cur)) {
      foreach ($c in $children[$cur]) {
        if (-not $result.Contains($c)) { [void]$result.Add($c); $queue.Enqueue($c) }
      }
    }
  }
  return $result
}

function Take-Sample {
  $procs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  $parentMap = @{}
  foreach ($p in $procs) { $parentMap[[int]$p.ProcessId] = [int]$p.ParentProcessId }
  $all = @($RootPid) + @(Get-DescendantPids -root $RootPid -parentMap $parentMap)
  $rows = @()
  foreach ($procId in $all) {
    $gp = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if ($null -eq $gp) { continue }
    $rows += [pscustomobject]@{
      pid = $gp.Id
      name = $gp.ProcessName
      private_bytes = [int64]$gp.PrivateMemorySize64
      working_set = [int64]$gp.WorkingSet64
      handles = [int]$gp.HandleCount
      threads = [int]@($gp.Threads).Count
      cpu_seconds = [math]::Round($gp.TotalProcessorTime.TotalSeconds, 3)
    }
  }
  $sumPrivate = ($rows | Measure-Object -Property private_bytes -Sum).Sum
  $sumWorking = ($rows | Measure-Object -Property working_set -Sum).Sum
  $sumHandles = ($rows | Measure-Object -Property handles -Sum).Sum
  $sumThreads = ($rows | Measure-Object -Property threads -Sum).Sum
  $sumCpu = ($rows | Measure-Object -Property cpu_seconds -Sum).Sum
  return [pscustomobject]@{
    timestamp = (Get-Date).ToString('o')
    process_count = $rows.Count
    private_bytes = [int64]$sumPrivate
    working_set = [int64]$sumWorking
    handles = [int]$sumHandles
    threads = [int]$sumThreads
    cpu_seconds_total = [math]::Round([double]$sumCpu, 3)
    cpu_percent = $null
    processes = $rows
  }
}

$samples = New-Object System.Collections.ArrayList
$deadline = (Get-Date).AddSeconds($DurationSec)
$prevCpu = $null
$prevTime = $null
while ((Get-Date) -lt $deadline) {
  if (-not (Get-Process -Id $RootPid -ErrorAction SilentlyContinue)) {
    Write-Warning "root process $RootPid exited before sampling finished"
    break
  }
  $s = Take-Sample
  if ($null -ne $prevCpu) {
    $dt = ((Get-Date) - $prevTime).TotalSeconds
    if ($dt -gt 0) { $s.cpu_percent = [math]::Round((($s.cpu_seconds_total - $prevCpu) / ($dt * $logicalCores)) * 100, 2) }
  } else {
    $s.cpu_percent = $null
  }
  $prevCpu = $s.cpu_seconds_total
  $prevTime = Get-Date
  [void]$samples.Add($s)
  Start-Sleep -Milliseconds $IntervalMs
}

$summary = $null
if ($samples.Count -gt 0) {
  $pcts = @($samples | ForEach-Object { $_.private_bytes } | Sort-Object)
  $ws = @($samples | ForEach-Object { $_.working_set } | Sort-Object)
  $cpu = @($samples | Where-Object { $null -ne $_.cpu_percent } | ForEach-Object { $_.cpu_percent } | Sort-Object)
  function Get-P95($arr) {
    if ($arr.Count -eq 0) { return $null }
    $idx = [math]::Min($arr.Count - 1, [math]::Ceiling(0.95 * $arr.Count) - 1)
    return [int64]$arr[$idx]
  }
  $summary = [pscustomobject]@{
    samples = $samples.Count
    interval_ms = $IntervalMs
    duration_sec = $DurationSec
    private_bytes_mean = [int64](($samples | Measure-Object -Property private_bytes -Average).Average)
    private_bytes_max = [int64](($samples | Measure-Object -Property private_bytes -Maximum).Maximum)
    private_bytes_p95 = Get-P95 $pcts
    working_set_mean = [int64](($samples | Measure-Object -Property working_set -Average).Average)
    working_set_p95 = Get-P95 $ws
    handles_mean = [int](($samples | Measure-Object -Property handles -Average).Average)
    threads_mean = [int](($samples | Measure-Object -Property threads -Average).Average)
    process_count_min = [int](($samples | Measure-Object -Property process_count -Minimum).Minimum)
    process_count_max = [int](($samples | Measure-Object -Property process_count -Maximum).Maximum)
    cpu_percent_mean = if ($cpu.Count -gt 0) { [math]::Round(($cpu | Measure-Object -Average).Average, 2) } else { $null }
  }
}

$payload = [ordered]@{
  label = $Label
  sampled_at = (Get-Date).ToString('o')
  root_pid = $RootPid
  logical_cores = $logicalCores
  samples = $samples
  summary = $summary
}
$json = $payload | ConvertTo-Json -Depth 8
if ($OutFile -ne '') {
  $parent = Split-Path -Parent $OutFile
  if ($parent -and -not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  $json | Set-Content -Encoding UTF8 $OutFile
}
$json
