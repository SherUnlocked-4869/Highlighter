$ErrorActionPreference = 'Stop'
$clipboardProjectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
& node (Join-Path $clipboardProjectRoot 'scripts/build-clipboard-native.js')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
