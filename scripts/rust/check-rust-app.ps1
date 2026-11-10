# R0 Rust workspace 检查入口。
#
# 在 rust-app/ 下依次运行（任一步非零即以该退出码失败，绝不吞错）：
#   1. cargo fmt --all -- --check
#   2. cargo clippy --workspace --all-targets -- -D warnings
#   3. cargo test --workspace --locked
#
# 用法（仓库根目录，Windows PowerShell 5.1 / PowerShell 7 均可）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/rust/check-rust-app.ps1
#
# 说明：
# - 工具链由 rust-app/rust-toolchain.toml 固定；首次运行会由 rustup 自动安装 1.97.1。
# - 测试全部离线可复跑（依赖在首次构建时下载），不需要 GUI/Electron/网络。
# - 不使用 app 入口执行，也不得用 exit 0 掩盖失败。

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$rustApp = Join-Path $repoRoot 'rust-app'

if (-not (Test-Path -LiteralPath $rustApp -PathType Container)) {
    Write-Host "FAILED: rust-app workspace not found at $rustApp" -ForegroundColor Red
    exit 1
}

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    Write-Host 'FAILED: cargo is not on PATH; install the pinned Rust toolchain (see rust-app/rust-toolchain.toml)' -ForegroundColor Red
    exit 1
}

Push-Location -LiteralPath $rustApp
try {
    Write-Host "== workspace: $rustApp"
    Write-Host "== cargo:     $(& cargo --version)"
    Write-Host "== rustc:     $(& rustc --version)"

    $steps = @(
        @{ Name = 'cargo fmt --all -- --check'; Args = @('fmt', '--all', '--', '--check') },
        @{ Name = 'cargo clippy --workspace --all-targets -- -D warnings'; Args = @('clippy', '--workspace', '--all-targets', '--', '-D', 'warnings') },
        @{ Name = 'cargo test --workspace --locked'; Args = @('test', '--workspace', '--locked') }
    )

    foreach ($step in $steps) {
        Write-Host ''
        Write-Host "==> $($step.Name)" -ForegroundColor Cyan
        $cargoArgs = @($step.Args)
        & cargo @cargoArgs
        $exitCode = $LASTEXITCODE
        if ($exitCode -ne 0) {
            Write-Host "FAILED: $($step.Name) exited with code $exitCode" -ForegroundColor Red
            exit $exitCode
        }
    }
} finally {
    Pop-Location
}

Write-Host ''
Write-Host 'check-rust-app: OK (fmt, clippy, test --locked)' -ForegroundColor Green
exit 0
