$ErrorActionPreference = 'Stop'

$framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$csc = Join-Path $framework 'csc.exe'
$wpf = Join-Path $framework 'WPF'
$source = Join-Path $PSScriptRoot 'Program.cs'
$output = Join-Path $PSScriptRoot 'SmartSelect.exe'
# P0-2-T1：cursor 命令用 System.Drawing 把光标位图编码成 PNG（DrawIconEx + Bitmap.Save）。
# 该程序集不在 WPF 的三个引用里，必须显式引用。
$drawing = Join-Path $framework 'System.Drawing.dll'

if (-not (Test-Path -LiteralPath $csc)) {
  throw "C# compiler not found: $csc"
}
if (-not (Test-Path -LiteralPath $drawing)) {
  throw "System.Drawing not found: $drawing"
}

& $csc /nologo /target:exe /platform:x64 /optimize+ "/out:$output" "/reference:$(Join-Path $wpf 'UIAutomationClient.dll')" "/reference:$(Join-Path $wpf 'UIAutomationTypes.dll')" "/reference:$(Join-Path $wpf 'WindowsBase.dll')" "/reference:$drawing" $source
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
