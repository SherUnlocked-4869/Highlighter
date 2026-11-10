# R0-04 selection-helper build script (prototype).
#
# Builds native/selection-helper/bin/selection-helper.exe from:
#   - native/selection-helper/src/{main.cc,retrieval_worker.cc}   (prototype adapter)
#   - vendor/selection-hook/src/windows/core/engine.cc            (verbatim vendor)
#   - vendor/selection-hook/src/windows/lib/*.cc                  (verbatim vendor)
#
# The vendor tree is never modified: it is compiled directly from its checked-in path.
# Only one vendor file cannot be reused: core/worker.cc is Node-API bound (TSFN), and is
# replaced by src/retrieval_worker.cc. See docs/plans/rust-migration/r0-hook-extraction.md.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File native/selection-helper/build.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File native/selection-helper/build.ps1 -Clean
#   powershell -NoProfile -ExecutionPolicy Bypass -File native/selection-helper/build.ps1 -SelfTest
#
# Requirements: Visual Studio 2022 Build Tools with the C++ x64 toolset (MSVC v143) and a
# Windows SDK. Toolchain discovery uses vswhere.exe and vcvars64.bat; nothing else is assumed.

[CmdletBinding()]
param(
    [ValidateSet('Release', 'Debug')]
    [string]$Configuration = 'Release',
    [switch]$Clean,
    [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'

$helperRoot = $PSScriptRoot
$srcDir = Join-Path $helperRoot 'src'
$buildDir = Join-Path $helperRoot 'build'
$objDir = Join-Path $buildDir 'obj'
$binDir = Join-Path $helperRoot 'bin'
$exePath = Join-Path $buildDir 'selection-helper.exe'
$binExePath = Join-Path $binDir 'selection-helper.exe'
$repoRoot = Split-Path -Parent (Split-Path -Parent $helperRoot)
$vendorRoot = Join-Path $repoRoot 'vendor/selection-hook/src/windows'

# Native tools write progress/diagnostics on stderr. Run them with a local 'Continue'
# preference and always report the real exit code instead of letting PowerShell's
# NativeCommandError path terminate the script first.
function Invoke-NativeTool {
    param(
        [Parameter(Mandatory = $true)][string]$Tool,
        [Parameter(Mandatory = $true)][string[]]$ToolArguments,
        [switch]$Quiet
    )
    $savedErrorAction = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        if ($Quiet) {
            & $Tool @ToolArguments 2>&1 | Out-Null
        } else {
            & $Tool @ToolArguments 2>&1 | ForEach-Object { Write-Host "    $_" }
        }
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $savedErrorAction
    }
    return $exitCode
}

Write-Host "selection-helper build: configuration=$Configuration"
Write-Host "  repo root : $repoRoot"
Write-Host "  vendor    : $vendorRoot"

if (-not (Test-Path (Join-Path $srcDir 'main.cc'))) { throw "missing source: $srcDir/main.cc" }
if (-not (Test-Path (Join-Path $vendorRoot 'core/engine.cc'))) { throw "missing vendor source: $vendorRoot/core/engine.cc" }
if (-not (Test-Path (Join-Path $vendorRoot 'lib/clipboard.cc'))) { throw "missing vendor source: $vendorRoot/lib" }

if ($Clean -and (Test-Path $buildDir)) {
    Write-Host "  cleaning  : $buildDir"
    Remove-Item -Recurse -Force $buildDir
}
foreach ($dir in @($buildDir, $objDir, $binDir)) {
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
}

# --- Locate the Visual C++ toolset through vswhere --------------------------------------
$vswhereCandidates = @()
if (${env:ProgramFiles(x86)}) {
    $vswhereCandidates += (Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe')
}
$vswhereCandidates += 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
$vswhere = $vswhereCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $vswhere) {
    throw "vswhere.exe not found. Install Visual Studio 2022 Build Tools with 'Desktop development with C++'."
}
$vsInstallPath = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if ($LASTEXITCODE -ne 0 -or -not $vsInstallPath) {
    throw "No Visual Studio installation with the MSVC x64 toolset was found by vswhere."
}
$vsInstallPath = @($vsInstallPath)[0].Trim()
$vcvars = Join-Path $vsInstallPath 'VC\Auxiliary\Build\vcvars64.bat'
if (-not (Test-Path $vcvars)) { throw "vcvars64.bat not found: $vcvars" }
Write-Host "  vswhere   : $vsInstallPath"
Write-Host "  vcvars64  : $vcvars"

# Import the vcvars64 environment (PATH/INCLUDE/LIB) through a temporary .cmd: cmd /c
# quoting around a quoted path with spaces is fragile when passed through an argument array.
$vcvarsImport = Join-Path $objDir 'vcvars-import.cmd'
$vcvarsImportLines = @(
    '@echo off',
    ('call "{0}" >nul 2>&1' -f $vcvars),
    'if errorlevel 1 exit /b 1',
    'set'
)
Set-Content -Path $vcvarsImport -Value $vcvarsImportLines -Encoding Ascii
$savedErrorAction = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$envDump = & cmd.exe /c "`"$vcvarsImport`"" 2>&1
$envDumpExit = $LASTEXITCODE
$ErrorActionPreference = $savedErrorAction
Remove-Item -Force $vcvarsImport -ErrorAction SilentlyContinue
if ($envDumpExit -ne 0) { throw "vcvars64.bat failed with exit code $envDumpExit" }
foreach ($line in $envDump) {
    $separator = $line.IndexOf('=')
    if ($separator -lt 1) { continue }
    $name = $line.Substring(0, $separator)
    $value = $line.Substring($separator + 1)
    [Environment]::SetEnvironmentVariable($name, $value, 'Process')
}
$cl = Get-Command cl.exe -ErrorAction SilentlyContinue
if (-not $cl) { throw "cl.exe is still not on PATH after vcvars64.bat" }
$savedErrorAction = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$clBanner = (& cl.exe 2>&1 | Select-Object -First 1)
$ErrorActionPreference = $savedErrorAction
Write-Host "  compiler  : $clBanner"

# --- Sources: prototype files + verbatim vendor core -----------------------------------
$sources = @(
    (Join-Path $srcDir 'main.cc'),
    (Join-Path $srcDir 'retrieval_worker.cc'),
    (Join-Path $vendorRoot 'core/engine.cc'),
    (Join-Path $vendorRoot 'lib/clipboard.cc'),
    (Join-Path $vendorRoot 'lib/clipboard_transaction.cc'),
    (Join-Path $vendorRoot 'lib/transient.cc'),
    (Join-Path $vendorRoot 'lib/keyboard.cc'),
    (Join-Path $vendorRoot 'lib/string_pool.cc'),
    (Join-Path $vendorRoot 'lib/utils.cc')
)
foreach ($source in $sources) {
    if (-not (Test-Path $source)) { throw "missing source: $source" }
}

# /DNOMINMAX is required but is NOT in vendor/selection-hook/binding.gyp: it comes from
# node-gyp's default Windows defines. Without it engine.cc fails on std::min.
$defines = @('/DNOMINMAX', '/DWIN32_LEAN_AND_MEAN')
$optimization = @('/O2')
$runtime = '/MT'
if ($Configuration -eq 'Release') {
    $defines += '/DNDEBUG'
} else {
    $defines += '/D_DEBUG'
    $optimization = @('/Od')
    $runtime = '/MTd'
}

$commonArgs = @('/nologo', '/std:c++17', '/EHsc', '/utf-8', '/W3') +
    $defines + $optimization + @($runtime, '/c', "/I$vendorRoot", "/I$srcDir")

# Compile one source at a time so a failure names the exact vendor/prototype file.
$objects = @()
foreach ($source in $sources) {
    $object = Join-Path $objDir ((Split-Path -Leaf $source) -replace '\.cc$', '.obj')
    $arguments = $commonArgs + @($source, "/Fo$object")
    Write-Host ("  cl        : {0}" -f (Split-Path -Leaf $source))
    $exitCode = Invoke-NativeTool -Tool 'cl.exe' -ToolArguments $arguments
    if ($exitCode -ne 0) { throw "compile failed ($exitCode): $source" }
    $objects += $object
}

# uiautomationcore: UIA client. user32: low-level hooks/cursors/windows. ole32: COM.
# oleaut32: BSTR/SafeArray. oleacc: IAccessible (MSAA fallback). shell32:
# SHQueryUserNotificationState. gdi32: clipboard metafile backup (also a node-gyp
# default, which is why binding.gyp does not list it). (engine.cc also carries
# #pragma comment(Oleacc.lib).)
$libraries = @(
    'uiautomationcore.lib', 'user32.lib', 'ole32.lib', 'oleaut32.lib','oleacc.lib', 'shell32.lib', 'gdi32.lib'
)
$linkArgs = @('/nologo', "/OUT:$exePath", '/SUBSYSTEM:CONSOLE') + $objects + $libraries
$linkExit = Invoke-NativeTool -Tool 'link.exe' -ToolArguments $linkArgs
if ($linkExit -ne 0) { throw "link failed ($linkExit)" }
if (-not (Test-Path $exePath)) { throw "expected output missing: $exePath" }

Copy-Item -Force $exePath $binExePath
$exeSize = (Get-Item $exePath).Length
Write-Host "  output    : $exePath ($exeSize bytes)"
Write-Host "  output    : $binExePath"

if ($SelfTest) {
    Write-Host '  self-test : running bin/selection-helper.exe --self-test'
    $selfTestExit = Invoke-NativeTool -Tool $binExePath -ToolArguments @('--self-test', '--duration-ms', '1500')
    if ($selfTestExit -ne 0) { throw "self-test failed with exit code $selfTestExit" }
    Write-Host '  self-test : PASS'
}

Write-Host 'selection-helper build: OK'
