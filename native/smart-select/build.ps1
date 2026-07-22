$ErrorActionPreference = 'Stop'

$framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$csc = Join-Path $framework 'csc.exe'
$wpf = Join-Path $framework 'WPF'
$source = Join-Path $PSScriptRoot 'Program.cs'
$output = Join-Path $PSScriptRoot 'SmartSelect.exe'

if (-not (Test-Path -LiteralPath $csc)) {
  throw "C# compiler not found: $csc"
}

& $csc /nologo /target:exe /platform:x64 /optimize+ "/out:$output" "/reference:$(Join-Path $wpf 'UIAutomationClient.dll')" "/reference:$(Join-Path $wpf 'UIAutomationTypes.dll')" "/reference:$(Join-Path $wpf 'WindowsBase.dll')" $source
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
