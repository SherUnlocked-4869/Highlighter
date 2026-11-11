# R0-04 one-command application selection matrix runner.
#
# 1. Rebuilds the standalone C++ selection helper with the build gate
#    (`build.ps1 -Clean -SelfTest`) so the binary picks up the current workspace ACL /
#    mandatory integrity label.
# 2. Runs the lower-level rows through real-selection-matrix.ps1 (one visible window at a
#    time on the primary display, which the user authorized for this evidence run), and
# 3. prints/persists a per-row summary.
#
# IMPORTANT: a helper built inside a workspace whose root carries
# `Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)` runs at Low IL. Under UIPI that makes
# every cross-application row fail for environmental reasons; the matrix script refuses to
# record evidence in that state (exit 7). Fix the workspace ACL, then rerun this script.
#
# Usage (repo root):
#   powershell -NoProfile -ExecutionPolicy Bypass -File native/selection-helper/test/run-selection-matrix.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File native/selection-helper/test/run-selection-matrix.ps1 -Rows Chrome-default,Chrome-force -SkipBuild
#   powershell -NoProfile -ExecutionPolicy Bypass -File native/selection-helper/test/run-selection-matrix.ps1 -Rows Word,Excel-clipboard
#
# Exit codes: 0 all requested rows passed, 1 at least one row failed, 2 build gate failed,
#   3 helper integrity preflight failed (Low IL workspace), 4 runner error.
[CmdletBinding()]
param(
    [string[]]$Rows,
    [switch]$SkipBuild,
    [switch]$SkipPreflight,
    [int]$TimeoutMs = 9000,
    [string]$OutDir
)
$ErrorActionPreference = 'Stop'
$testDir = $PSScriptRoot
$helperRoot = Split-Path -Parent $testDir
$repoRoot = Split-Path -Parent (Split-Path -Parent $helperRoot)
if (-not $OutDir) { $OutDir = Join-Path $repoRoot '.tmp-r0-hook' }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$matrixScript = Join-Path $testDir 'real-selection-matrix.ps1'
$helperExe = Join-Path $helperRoot 'bin\selection-helper.exe'
$summaryPath = Join-Path $OutDir 'matrix-run-summary.json'
$startedAt = Get-Date

# Each row: name -> extra arguments for real-selection-matrix.ps1 (Target/Gesture always set).
$allRows = [ordered]@{
    'Notepad'          = @{ Target = 'Notepad'; Gesture = 'Drag'; Extra = @() }
    'Chrome-default'   = @{ Target = 'Chrome'; Gesture = 'Drag'; Extra = @('-BrowserA11y', 'default') }
    'Chrome-force'     = @{ Target = 'Chrome'; Gesture = 'Drag'; Extra = @('-BrowserA11y', 'force') }
    'Edge-default'     = @{ Target = 'Edge'; Gesture = 'Drag'; Extra = @('-BrowserA11y', 'default') }
    'Edge-force'       = @{ Target = 'Edge'; Gesture = 'Drag'; Extra = @('-BrowserA11y', 'force') }
    'Word'             = @{ Target = 'Word'; Gesture = 'Drag'; Extra = @() }
    'Excel'            = @{ Target = 'Excel'; Gesture = 'Drag'; Extra = @() }
    'Excel-clipboard'  = @{ Target = 'Excel'; Gesture = 'Drag'; Extra = @('-Clipboard') }
    'Explorer'         = @{ Target = 'Explorer'; Gesture = 'Drag'; Extra = @() }
    'Explorer-doubleclick' = @{ Target = 'Explorer'; Gesture = 'DoubleClick'; Extra = @() }
}
if ($Rows) { $expanded = @(); foreach ($entry in $Rows) { foreach ($part in ([string]$entry -split ",")) { if ($part.Trim()) { $expanded += $part.Trim() } } }; $Rows = $expanded }
if (-not $Rows -or $Rows.Count -eq 0) { $Rows = @($allRows.Keys) }
foreach ($row in $Rows) { if (-not $allRows.Contains($row)) { Write-Host ("ERROR: unknown row '{0}'. Known rows: {1}" -f $row, ($allRows.Keys -join ', ')); exit 4 } }

Write-Host '=== R0-04 selection matrix runner ==='
Write-Host ("rows: {0}" -f ($Rows -join ', '))

if (-not $SkipBuild) {
    Write-Host '--- build gate: build.ps1 -Clean -SelfTest ---'
    $buildLog = Join-Path $OutDir 'matrix-run-build.log'
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $helperRoot 'build.ps1') -Clean -SelfTest *>&1 | Tee-Object -FilePath $buildLog | ForEach-Object { $_ }
    $buildExit = $LASTEXITCODE
    Write-Host ("build exit: {0} (log: {1})" -f $buildExit, $buildLog)
    if ($buildExit -ne 0) { Write-Host 'RESULT: build gate FAILED'; exit 2 }
} elseif (-not (Test-Path $helperExe)) {
    Write-Host ("ERROR: -SkipBuild but helper missing: {0}" -f $helperExe); exit 2
}

if (-not $SkipPreflight) {
    Write-Host '--- helper integrity preflight (must be Medium) ---'
    $checkOut = Join-Path $OutDir 'matrix-run-ilcheck.jsonl'
    $checkErr = Join-Path $OutDir 'matrix-run-ilcheck.err.log'
    Remove-Item $checkOut, $checkErr -ErrorAction SilentlyContinue
    $probe = Start-Process -FilePath $helperExe -ArgumentList @('--duration-ms', '600') -PassThru -RedirectStandardOutput $checkOut -RedirectStandardError $checkErr
    Start-Sleep -Milliseconds 350
    $il = $null
    if (-not $probe.HasExited) {
        Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class RunIL {
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr p, uint a, out IntPtr t);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr t, int c, IntPtr i, int l, out int n);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr s, uint i);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr s);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint a, bool i, int p);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  public static string Of(int pid) {
    IntPtr p = OpenProcess(0x1000, false, pid); if (p == IntPtr.Zero) return "unknown";
    IntPtr t; if (!OpenProcessToken(p, 0x0008, out t)) { CloseHandle(p); return "unknown"; }
    int n; GetTokenInformation(t, 25, IntPtr.Zero, 0, out n); IntPtr b = Marshal.AllocHGlobal(n); string r = "unknown";
    if (GetTokenInformation(t, 25, b, n, out n)) { IntPtr s = Marshal.ReadIntPtr(b); byte c = Marshal.ReadByte(GetSidSubAuthorityCount(s)); uint rid = (uint)Marshal.ReadInt32(GetSidSubAuthority(s, (uint)(c - 1)));
      if (rid == 0x1000) r = "Low"; else if (rid == 0x2000) r = "Medium"; else if (rid == 0x3000) r = "High"; else if (rid == 0x4000) r = "System"; else r = "RID=0x" + rid.ToString("x"); }
    Marshal.FreeHGlobal(b); CloseHandle(t); CloseHandle(p); return r; }
}
'@ -ErrorAction SilentlyContinue
        $il = [RunIL]::Of($probe.Id)
    }
    try { $probe.WaitForExit(4000) | Out-Null } catch { }
    Write-Host ("helper integrity: {0}" -f $il)
    if ($il -ne 'Medium') {
        Write-Host 'RESULT: helper is not Medium IL (workspace mandatory label caps the built binary).'
        Write-Host 'Fix the workspace ACL, rebuild the helper, then rerun this script. Not recording matrix evidence.'
        exit 3
    }
}

$results = @()
$allPassed = $true
foreach ($row in $Rows) {
    $cfg = $allRows[$row]
    $rowStart = Get-Date
    Write-Host ''
    Write-Host ("================ ROW {0} ================" -f $row)
    $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $matrixScript,
        '-Target', $cfg.Target, '-Gesture', $cfg.Gesture, '-AllowPrimaryDisplay',
        '-TimeoutMs', "$TimeoutMs", '-Tag', ('run-' + $row)) + $cfg.Extra
    $output = & powershell @arguments 2>&1 | ForEach-Object { $_ }
    $rowExit = $LASTEXITCODE
    $output | ForEach-Object { Write-Host $_ }
    $passed = ($rowExit -eq 0)
    if (-not $passed) { $allPassed = $false }
    $results += [pscustomobject]@{
        row = $row
        target = $cfg.Target
        gesture = $cfg.Gesture
        extra = ($cfg.Extra -join ' ')
        passed = $passed
        exitCode = $rowExit
        seconds = [math]::Round(((Get-Date) - $rowStart).TotalSeconds, 1)
    }
    Write-Host ("ROW {0}: {1} (exit {2})" -f $row, $(if ($passed) { 'PASS' } else { 'FAIL' }), $rowExit)
}

Write-Host ''
Write-Host '=== SUMMARY ==='
$results | Format-Table -AutoSize | Out-String | ForEach-Object { Write-Host $_ }
$summary = [ordered]@{
    timestamp = (Get-Date).ToUniversalTime().ToString('o')
    startedAt = $startedAt.ToUniversalTime().ToString('o')
    buildSkipped = [bool]$SkipBuild
    preflightSkipped = [bool]$SkipPreflight
    results = $results
    allPassed = $allPassed
    evidenceDir = $OutDir
}
[IO.File]::WriteAllText($summaryPath, ($summary | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
Write-Host ("summary: {0}" -f $summaryPath)
Write-Host ("RESULT: {0}" -f $(if ($allPassed) { 'ALL ROWS PASS' } else { 'SOME ROWS FAILED (see per-row evidence)' }))
if (-not $allPassed) { exit 1 }
exit 0
