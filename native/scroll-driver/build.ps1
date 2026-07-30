$ErrorActionPreference = 'Stop'

$framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$csc = Join-Path $framework 'csc.exe'
$source = Join-Path $PSScriptRoot 'Program.cs'
$output = Join-Path $PSScriptRoot 'ScrollDriver.exe'

if (-not (Test-Path -LiteralPath $csc)) {
  throw "C# compiler not found: $csc"
}

& $csc /nologo /target:exe /platform:x64 /optimize+ "/out:$output" $source
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
