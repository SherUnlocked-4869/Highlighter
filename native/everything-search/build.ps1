$ErrorActionPreference = 'Stop'

$manifest = Join-Path $PSScriptRoot 'Cargo.toml'
$targetDir = Join-Path $PSScriptRoot 'target'
$output = Join-Path $PSScriptRoot 'bin\HighlighterEverything.exe'

$env:CARGO_TARGET_DIR = $targetDir
& cargo build --release --manifest-path $manifest
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

New-Item -ItemType Directory -Force -Path (Join-Path $PSScriptRoot 'bin') | Out-Null
Copy-Item -LiteralPath (Join-Path $targetDir 'release\highlighter-everything.exe') -Destination $output -Force

Write-Host "Everything sidecar built: $output"
