# R0-05a WebView2 媒体能力原型：一次性构建 + 四模式矩阵 + ffmpeg 校验。
#
# 用法（仓库根）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File rust-app/prototypes/webview-media/run-matrix.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File rust-app/prototypes/webview-media/run-matrix.ps1 -SkipBuild -Modes observe
#
# 约束：
# - 可见窗口只出现在副屏（宿主自己校验，无副屏直接失败退出）；
# - WebView2 数据目录固定 .tmp-r0-media-webview/webview2-data（gitignore）；
# - 每次运行前/后清理本原型遗留的 msedgewebview2 子进程；
# - 日志/报告/录屏/截图全部落在 .tmp-r0-media-webview/。
param(
    # 逗号分隔的运行名过滤（powershell -File 传数组参数会被当成单个字符串，因此用字符串再拆分）。
    [string]$Only = "",
    [switch]$SkipBuild,
    [int]$WatchdogSecs = 180,
    [int]$SnapshotAfterSec = 6,
    [string]$RunTagSuffix = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../../..")).Path
$outDir = Join-Path $repoRoot ".tmp-r0-media-webview"
$logsDir = Join-Path $outDir "logs"
$recordingsDir = Join-Path $outDir "recordings"
$exe = Join-Path $PSScriptRoot "target/debug/highlighter-r0-media-webview.exe"

New-Item -ItemType Directory -Force -Path $outDir, $logsDir, $recordingsDir | Out-Null

function Stop-Leftovers {
    $ours = Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine.Contains(".tmp-r0-media-webview") }
    foreach ($process in $ours) {
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Get-Process -Name "highlighter-r0-media-webview" -ErrorAction SilentlyContinue |
        Stop-Process -Force -ErrorAction SilentlyContinue
    if ($ours) { Start-Sleep -Milliseconds 400 }
}

function Get-WebView2RuntimeVersion {
    $keys = @(
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
        "HKCU:\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
    )
    foreach ($key in $keys) {
        $value = (Get-ItemProperty -Path $key -ErrorAction SilentlyContinue).pv
        if ($value) { return $value }
    }
    return "<not-found>"
}

function Get-RecordingsVerification {
    $ffmpeg = Join-Path $repoRoot "node_modules/ffmpeg-static/ffmpeg.exe"
    if (-not (Test-Path -LiteralPath $ffmpeg)) {
        $ffmpegCmd = Get-Command ffmpeg -ErrorAction SilentlyContinue
        if ($ffmpegCmd) { $ffmpeg = $ffmpegCmd.Source } else { $ffmpeg = $null }
    }
    $ffprobeCmd = Get-Command ffprobe -ErrorAction SilentlyContinue
    if ($ffprobeCmd) { $ffprobe = $ffprobeCmd.Source } else { $ffprobe = $null }
    $results = @()
    foreach ($file in Get-ChildItem -Path $recordingsDir -Filter "*.webm" -ErrorAction SilentlyContinue) {
        $entry = [ordered]@{
            file = $file.FullName
            bytes = $file.Length
            ffmpeg = $ffmpeg
            ffprobe = $ffprobe
        }
        if ($ffprobe) {
            $probeJson = & $ffprobe -v error -show_format -show_streams -of json $file.FullName 2>&1
            $probeText = ($probeJson | Out-String)
            Set-Content -LiteralPath (Join-Path $logsDir ("ffprobe-" + $file.BaseName + ".json")) -Value $probeText -Encoding UTF8
            $parsed = $null
            try { $parsed = $probeText | ConvertFrom-Json } catch { }
            if ($parsed) {
                $entry.format = [ordered]@{
                    formatName = $parsed.format.format_name
                    durationSeconds = $parsed.format.duration
                    size = $parsed.format.size
                    bitRate = $parsed.format.bit_rate
                }
                $entry.streams = @($parsed.streams | ForEach-Object {
                    [ordered]@{
                        index = $_.index
                        codecType = $_.codec_type
                        codecName = $_.codec_name
                        width = $_.width
                        height = $_.height
                        rFrameRate = $_.r_frame_rate
                        sampleRate = $_.sample_rate
                        channels = $_.channels
                        duration = $_.duration
                        nbFrames = $_.nb_frames
                    }
                })
            } else {
                $entry.ffprobeParseError = $probeText
            }
        }
        if ($ffmpeg) {
            $decode = & $ffmpeg -v error -i $file.FullName -f null - 2>&1
            $entry.decodeExitCode = $LASTEXITCODE
            $entry.decodeStderr = ($decode | Out-String).Trim()
        }
        $results += $entry
    }
    return $results
}

Write-Output "[matrix] repoRoot=$repoRoot"
Write-Output "[matrix] webview2Runtime=$(Get-WebView2RuntimeVersion)"
$onlyList = @($Only -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" })
Write-Output "[matrix] only=$($onlyList -join ',')"

Stop-Leftovers

if (-not $SkipBuild) {
    Write-Output "[matrix] cargo build (debug) ..."
    $buildStart = Get-Date
    & cargo build --manifest-path (Join-Path $PSScriptRoot "Cargo.toml")
    if ($LASTEXITCODE -ne 0) { throw "cargo build failed: $LASTEXITCODE" }
    Write-Output "[matrix] cargo build ok in $([int]((Get-Date) - $buildStart).TotalSeconds)s"
}
if (-not (Test-Path -LiteralPath $exe)) { throw "missing executable: $exe" }

# 每次运行 = 一个场景；SCS 模式只对 gesture/overlay 场景有意义。
$captureScript = Join-Path $PSScriptRoot "tools/capture-screen.ps1"
$runs = @(
    [ordered]@{ name = "probe"; scenario = "probe"; mode = "observe" },
    [ordered]@{ name = "nogesture"; scenario = "nogesture"; mode = "observe" },
    [ordered]@{ name = "gesture-none"; scenario = "gesture"; mode = "none" },
    [ordered]@{ name = "gesture-observe"; scenario = "gesture"; mode = "observe" },
    [ordered]@{ name = "gesture-handled-allow"; scenario = "gesture"; mode = "handled-allow" },
    [ordered]@{ name = "gesture-handled-cancel"; scenario = "gesture"; mode = "handled-cancel" },
    [ordered]@{ name = "overlay-observe"; scenario = "overlay"; mode = "observe" }
)
if ($onlyList.Count -gt 0) {
    $runs = @($runs | Where-Object { $onlyList -contains $_.name })
}

$summary = @()
foreach ($run in $runs) {
    Stop-Leftovers
    $tag = if ($RunTagSuffix) { "$($run.name)-$RunTagSuffix" } else { $run.name }
    $logPath = Join-Path $logsDir "run-$tag.log"
    $errPath = Join-Path $logsDir "run-$tag.err.log"
    $shotPath = Join-Path $outDir "screenshots/live-$tag.png"
    $env:R0_SCENARIO = $run.scenario
    $env:R0_SCS_MODE = $run.mode
    $env:R0_RUN_TAG = $tag
    $env:R0_WATCHDOG_SECS = "$WatchdogSecs"
    Remove-Item Env:R0_EXTRA_BROWSER_ARGS -ErrorAction SilentlyContinue
    Remove-Item Env:R0_DATA_DIR_SUFFIX -ErrorAction SilentlyContinue
    Write-Output "[matrix] run name=$($run.name) scenario=$($run.scenario) mode=$($run.mode) log=$logPath"
    # 用 .cmd 包一层以可靠拿到退出码（本机 PowerShell 5.1 的 Start-Process -PassThru
    # 在重定向输出时取不到 ExitCode；cmd 的 %ERRORLEVEL% 可以）。
    $exitFile = Join-Path $logsDir "exit-$tag.txt"
    Remove-Item -LiteralPath $exitFile -ErrorAction SilentlyContinue
    $wrapperPath = Join-Path $logsDir "launch-$tag.cmd"
    $wrapperLines = @(
        '@echo off',
        ('"{0}" > "{1}" 2> "{2}"' -f $exe, $logPath, $errPath),
        ('echo %ERRORLEVEL% > "{0}"' -f $exitFile)
    )
    Set-Content -LiteralPath $wrapperPath -Value $wrapperLines -Encoding ASCII
    $process = Start-Process -FilePath $wrapperPath -PassThru -NoNewWindow -WorkingDirectory $repoRoot
    # 等待窗口进入"等待选源/挂起"窗口期时，从外部抓一张整屏截图（宿主内截图受限时的兜底证据）。
    Start-Sleep -Seconds $SnapshotAfterSec
    if (-not $process.HasExited) {
        & powershell -NoProfile -ExecutionPolicy Bypass -File $captureScript -Out $shotPath | Out-Null
    }
    $exited = $process.WaitForExit([Math]::Max(30, $WatchdogSecs + 30) * 1000)
    if (-not $exited) {
        Write-Output "[matrix] WARN run=$($run.name) 超时，强制结束进程"
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        & taskkill /PID $process.Id /T /F | Out-Null
    }
    $exitCode = $null
    if (Test-Path -LiteralPath $exitFile) {
        $raw = (Get-Content -LiteralPath $exitFile -ErrorAction SilentlyContinue | Select-Object -First 1)
        if ($raw -match '^\s*(-?\d+)\s*$') { $exitCode = [int]$Matches[1] }
    }
    Write-Output "[matrix] run=$($run.name) exitCode=$exitCode"
    Stop-Leftovers
    $reportPath = Join-Path $outDir "report-$tag.json"
    $summary += [ordered]@{
        name = $run.name
        scenario = $run.scenario
        mode = $run.mode
        tag = $tag
        exitCode = $exitCode
        log = $logPath
        errorLog = $errPath
        liveScreenshot = if (Test-Path -LiteralPath $shotPath) { $shotPath } else { $null }
        report = if (Test-Path -LiteralPath $reportPath) { $reportPath } else { $null }
    }
}

$verification = Get-RecordingsVerification
$summaryPath = Join-Path $logsDir "matrix-summary.json"
$payload = [ordered]@{
    generatedAt = (Get-Date).ToString("o")
    webview2Runtime = Get-WebView2RuntimeVersion
    runFilter = $onlyList
    runs = $summary
    recordings = $verification
}
$payload | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $summaryPath -Encoding UTF8
Write-Output "[matrix] summary=$summaryPath"
foreach ($item in $verification) {
    Write-Output ("[matrix] webm {0} bytes={1} decodeExit={2} format={3} streams={4}" -f `
        (Split-Path $item.file -Leaf), $item.bytes, $item.decodeExitCode, $item.format.formatName, $item.streams.Count)
}
