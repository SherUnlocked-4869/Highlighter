$ErrorActionPreference = 'Stop'

$manifest = Join-Path $PSScriptRoot 'Cargo.toml'
$targetDir = Join-Path $PSScriptRoot 'target'
$output = Join-Path $PSScriptRoot 'HighlighterOcrSidecar.exe'
$legacyOutput = Join-Path $PSScriptRoot 'OcrSidecar.exe'
$onnxRuntime = Join-Path $PSScriptRoot '..\..\node_modules\onnxruntime-node\bin\napi-v6\win32\x64\onnxruntime.dll'

if (-not (Test-Path -LiteralPath $onnxRuntime)) {
  throw "ONNX Runtime not found. Run npm install first: $onnxRuntime"
}

$env:CARGO_TARGET_DIR = $targetDir
& cargo build --release --manifest-path $manifest
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Copy-Item -LiteralPath (Join-Path $targetDir 'release\highlighter-ocr-sidecar.exe') -Destination $output -Force
Copy-Item -LiteralPath $onnxRuntime -Destination (Join-Path $PSScriptRoot 'onnxruntime.dll') -Force
if (Test-Path -LiteralPath $legacyOutput) {
  Remove-Item -LiteralPath $legacyOutput -Force
}

Write-Host "OCR sidecar built: $output"
