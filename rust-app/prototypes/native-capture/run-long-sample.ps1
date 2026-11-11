# R0-05 30 分钟时钟样例 + 进程树资源峰值采样（本机 Release GDI 采集）。
#
# 用法（仓库根目录）：
#   pwsh -NoProfile -File rust-app/prototypes/native-capture/run-long-sample.ps1 `
#     -OutDir .tmp-r0-media-native/long-30min -Seconds 1800
#
# 行为：
#   1. 记录电源方案 → 切高性能 → 结束后恢复；
#   2. 启动 native-capture（默认 --capture gdi --monitor 0 --no-animate --audio --tone）；
#   3. 同时用 scripts/rust/measure-resources.ps1 采样采集进程树（RootPid + ffmpeg 子进程）
#      的 Private Bytes / Working Set / 句柄 / 线程 / 区间 CPU%；
#   4. 结束验证：ffmpeg 全量解码、容器探测、sha256、资源峰值汇总；
#   5. 产物落在 $OutDir（gitignore），脚本本身只写该目录。
#
# 编码说明：本文件为 UTF-8 with BOM（handoff §7 陷阱 1）。
param(
  [string]$Exe = 'rust-app\prototypes\native-capture\target\release\native-capture.exe',
  [string]$OutDir = '.tmp-r0-media-native\long-30min',
  [int]$Seconds = 1800,
  [int]$Fps = 30,
  [int]$Monitor = 0,
  [double]$ToneAmp = 0.0005,
  [int]$SampleIntervalMs = 2000,
  [string]$Ffmpeg = 'node_modules\ffmpeg-static\ffmpeg.exe',
  [switch]$SkipPowerPlan,
  [switch]$DeleteVideo
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptDir '..\..\..')
Set-Location $repoRoot

if (-not (Test-Path $Exe)) { throw "exe not found: $Exe" }
if (-not (Test-Path $Ffmpeg)) { throw "ffmpeg not found: $Ffmpeg" }
$resolvedOut = [System.IO.Path]::GetFullPath((Join-Path $repoRoot $OutDir))
New-Item -ItemType Directory -Force -Path $resolvedOut | Out-Null
$measureScript = Join-Path $repoRoot 'scripts\rust\measure-resources.ps1'
if (-not (Test-Path $measureScript)) { throw "measure-resources.ps1 not found" }

$env:Ffmpeg = $Ffmpeg
$env:OutDirAbs = $resolvedOut

# 1) 电源方案 before/during/after。
$powerBefore = (& powercfg /getactivescheme) -join ' '
$powerDuring = $powerBefore
if (-not $SkipPowerPlan) {
  $highPerf = '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c'
  & powercfg /setactive $highPerf 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) { $powerDuring = (& powercfg /getactivescheme) -join ' ' }
}

$startedAt = (Get-Date).ToString('o')
$args = @(
  '--seconds', $Seconds,
  '--fps', $Fps,
  '--capture', 'gdi',
  '--monitor', $Monitor,
  '--no-animate',
  '--audio',
  '--tone',
  '--tone-amp', $ToneAmp,
  '--out', $resolvedOut
)
$consoleOut = Join-Path $resolvedOut 'console.out.log'
$consoleErr = Join-Path $resolvedOut 'console.err.log'
Write-Host "[long] starting: $Exe $($args -join ' ')"
$proc = Start-Process -FilePath (Join-Path $repoRoot $Exe) -ArgumentList $args -WorkingDirectory $repoRoot -RedirectStandardOutput $consoleOut -RedirectStandardError $consoleErr -PassThru
Write-Host "[long] pid=$($proc.Id) out=$resolvedOut"

# 2) 同步采样进程树，直到采集进程退出（measure 脚本内部按 DurationSec 上限）。
$sampleSeconds = $Seconds + 180
& pwsh -NoProfile -File $measureScript -RootPid $proc.Id -Label "long-$Seconds" -DurationSec $sampleSeconds -IntervalMs $SampleIntervalMs -OutFile (Join-Path $resolvedOut 'resources.json') | Out-Null
$proc.WaitForExit()
$exitCode = $proc.ExitCode
$startedInstant = $startedAt
$finishedAt = (Get-Date).ToString('o')
Write-Host "[long] capture exited code=$exitCode"

# 3) 恢复电源方案。
if (-not $SkipPowerPlan) { & powercfg /setactive ($powerBefore -replace '^.*?([0-9a-fA-F-]{36}).*$', '$1') 2>&1 | Out-Null }
$powerAfter = (& powercfg /getactivescheme) -join ' '

# 4) 产物验证。
$video = Join-Path $resolvedOut 'video.mp4'
$muxed = Join-Path $resolvedOut 'capture.mp4'
function Invoke-Ffmpeg {
  param([string[]]$FfArgs)
  $out = & (Join-Path $repoRoot $Ffmpeg) @FfArgs 2>&1
  return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Text = ($out -join "`n") }
}
$verify = [ordered]@{}
foreach ($pair in @(@('video', $video), @('muxed', $muxed))) {
  $name = $pair[0]; $path = $pair[1]
  if (Test-Path $path) {
    $hash = (Get-FileHash -Algorithm SHA256 -Path $path).Hash
    $size = (Get-Item $path).Length
    $decode = Invoke-Ffmpeg @('-hide_banner', '-v', 'error', '-xerror', '-i', $path, '-f', 'null', '-')
    $probe = Invoke-Ffmpeg @('-hide_banner', '-i', $path)
    Set-Content -Encoding UTF8 -Path (Join-Path $resolvedOut "probe-$name.txt") -Value $probe.Text
    $verify[$name] = [ordered]@{
      path = $path
      size_bytes = $size
      sha256 = $hash
      decode_exit = $decode.ExitCode
      decode_error_tail = if ($decode.ExitCode -ne 0) { $decode.Text.Substring([Math]::Max(0, $decode.Text.Length - 800)) } else { '' }
    }
  } else {
    $verify[$name] = [ordered]@{ path = $path; missing = $true }
  }
}

# 5) 资源峰值汇总（进程树口径）。
$resources = if (Test-Path (Join-Path $resolvedOut 'resources.json')) {
  Get-Content (Join-Path $resolvedOut 'resources.json') -Raw | ConvertFrom-Json
} else { $null }
$peak = [ordered]@{}
if ($null -ne $resources -and $resources.samples.Count -gt 0) {
  $samples = @($resources.samples)
  $cpuVals = @($samples | Where-Object { $null -ne $_.cpu_percent } | ForEach-Object { [double]$_.cpu_percent })
  $peak = [ordered]@{
    samples = $samples.Count
    interval_ms = $SampleIntervalMs
    process_count_max = ($samples | Measure-Object -Property process_count -Maximum).Maximum
    private_bytes_max = ($samples | Measure-Object -Property private_bytes -Maximum).Maximum
    private_bytes_mean = [int64](($samples | Measure-Object -Property private_bytes -Average).Average)
    private_bytes_p95 = ([int64[]]@($samples | ForEach-Object { [int64]$_.private_bytes } | Sort-Object))[[Math]::Min($samples.Count - 1, [Math]::Ceiling(0.95 * $samples.Count) - 1)]
    working_set_max = ($samples | Measure-Object -Property working_set -Maximum).Maximum
    working_set_mean = [int64](($samples | Measure-Object -Property working_set -Average).Average)
    handles_max = ($samples | Measure-Object -Property handles -Maximum).Maximum
    threads_max = ($samples | Measure-Object -Property threads -Maximum).Maximum
    cpu_percent_max = if ($cpuVals.Count -gt 0) { ($cpuVals | Measure-Object -Maximum).Maximum } else { $null }
    cpu_percent_mean = if ($cpuVals.Count -gt 0) { [Math]::Round(($cpuVals | Measure-Object -Average).Average, 2) } else { $null }
    cpu_percent_p95 = if ($cpuVals.Count -gt 0) { ([double[]]@($cpuVals | Sort-Object))[[Math]::Min($cpuVals.Count - 1, [Math]::Ceiling(0.95 * $cpuVals.Count) - 1)] } else { $null }
    logical_cores = $resources.logical_cores
    cpu_peak_cores = if ($cpuVals.Count -gt 0) { [Math]::Round((($cpuVals | Measure-Object -Maximum).Maximum / 100.0) * $resources.logical_cores, 3) } else { $null }
  }
}

$summary = [ordered]@{
  label = "native-capture long sample ${Seconds}s"
  started_at = $startedInstant
  finished_at = $finishedAt
  seconds_requested = $Seconds
  fps = $Fps
  monitor = $Monitor
  tone_amp = $ToneAmp
  exit_code = $exitCode
  power_plan_before = $powerBefore
  power_plan_during = $powerDuring
  power_plan_after = $powerAfter
  command = "$Exe $($args -join ' ')"
  artifacts = $verify
  resources = $peak
}
$summaryPath = Join-Path $resolvedOut 'long-summary.json'
$summary | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 -Path $summaryPath
Write-Host "[long] wrote $summaryPath"

# 6) 可选：记录大小/哈希/解码结论后删除大视频（证据保留在 summary）。
if ($DeleteVideo) {
  foreach ($name in @('video', 'muxed')) {
    $info = $verify[$name]
    if ($info -and -not $info.missing -and (Test-Path $info.path)) {
      Remove-Item -Force $info.path
      Write-Host "[long] deleted $($info.path) after recording size/hash/decode"
    }
  }
}
if ($exitCode -ne 0) { exit 1 }
exit 0
