# R0-04 real-application selection matrix driver (prototype evidence; NOT a product test).
#
# Opens ONE controlled target application window, starts the standalone selection-helper,
# performs a real mouse gesture with SendInput so the helper's low-level hook observes a
# genuine input event, then records the helper's JSONL result plus an independent
# driver-side selection readback.
#
# Targets: Chrome, Edge (local HTML file, temp profile), Word (COM-created document),
# Excel (COM-created workbook), Explorer (temp folder + address bar drag), Notepad.
#
# This host has a single display, so the script refuses to open a visible window unless
# -AllowPrimaryDisplay is passed (visible-window authorization for this evidence run was
# granted by the user). Windows are kept small and closed in the finally block; the
# clipboard text is backed up and restored; only processes started by this script are
# closed.
#
# ASCII only on purpose: Windows PowerShell 5.1 decodes BOM-less UTF-8 as GBK, and
# non-ASCII comments have broken scripts on this host before (handoff trap 1).
#
# Usage (repo root, Windows PowerShell):
#   powershell -NoProfile -ExecutionPolicy Bypass -File native/selection-helper/test/real-selection-matrix.ps1 -Target Chrome -Gesture Drag -AllowPrimaryDisplay
#   powershell -NoProfile -ExecutionPolicy Bypass -File native/selection-helper/test/real-selection-matrix.ps1 -Target Chrome -Gesture Drag -BrowserA11y force -AllowPrimaryDisplay
#   powershell -NoProfile -ExecutionPolicy Bypass -File native/selection-helper/test/real-selection-matrix.ps1 -Target Edge -Gesture Drag -AllowPrimaryDisplay
#   powershell -NoProfile -ExecutionPolicy Bypass -File native/selection-helper/test/real-selection-matrix.ps1 -Target Edge -Gesture Drag -BrowserA11y force -AllowPrimaryDisplay
#   powershell -NoProfile -ExecutionPolicy Bypass -File native/selection-helper/test/real-selection-matrix.ps1 -Target Word -Gesture Drag -AllowPrimaryDisplay
#   powershell -NoProfile -ExecutionPolicy Bypass -File native/selection-helper/test/real-selection-matrix.ps1 -Target Excel -Gesture Drag -Clipboard -AllowPrimaryDisplay
#   powershell -NoProfile -ExecutionPolicy Bypass -File native/selection-helper/test/real-selection-matrix.ps1 -Target Explorer -Gesture Drag -AllowPrimaryDisplay
#
# Exit codes: 0 selection observed, 1 helper ran but no selection, 2 no usable display,
#   3 helper failed to start, 4 unexpected script error, 5 target preparation/calibration failed.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Chrome', 'Edge', 'Word', 'Excel', 'Explorer', 'Notepad')]
    [string]$Target,
    [ValidateSet('Drag', 'DoubleClick', 'ShiftClick')]
    [string]$Gesture = 'Drag',
    [switch]$Clipboard,
    [switch]$VerboseEvents,
    # Browsers only: 'default' leaves Chromium accessibility activation to the host (this
    # machine exposes no page tree => MSAA/clipboard paths only); 'force' adds
    # --force-renderer-accessibility so the UIA page tree exists.
    [ValidateSet('default', 'force')]
    [string]$BrowserA11y = 'default',
    [switch]$AllowPrimaryDisplay,
    # Diagnostic: inject the gesture without pre-activating the target first; the mousedown
    # click-through activates it. Needed on this host, where pre-activated targets stop
    # delivering low-level hook events to the helper process.
    [switch]$NoPreActivate,
    [string]$HelperPath,
    [string]$OutDir,
    [int]$TimeoutMs = 9000,
    [string]$Tag
)

$ErrorActionPreference = 'Stop'
$testDir = $PSScriptRoot
$helperRoot = Split-Path -Parent $testDir
$repoRoot = Split-Path -Parent (Split-Path -Parent $helperRoot)
if (-not $HelperPath) { $HelperPath = Join-Path $helperRoot 'bin\selection-helper.exe' }
if (-not $OutDir) { $OutDir = Join-Path $repoRoot '.tmp-r0-hook' }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
if (-not (Test-Path $HelperPath)) { Write-Host ("ERROR: helper binary not found: {0} (run build.ps1 first)" -f $HelperPath); exit 3 }

$runSuffix = if ($Clipboard) { 'clipboard' } else { 'default' }
$tagBase = if ($Tag) { $Tag } else { ('{0}-{1}' -f $Target.ToLower(), $Gesture.ToLower()) }
$tag = '{0}-{1}' -f $tagBase, $runSuffix
$stdoutPath = Join-Path $OutDir ("matrix-{0}.jsonl" -f $tag)
$stderrPath = Join-Path $OutDir ("matrix-{0}.err.log" -f $tag)
$resultPath = Join-Path $OutDir 'matrix-results.jsonl'
Remove-Item $stdoutPath, $stderrPath -ErrorAction SilentlyContinue
$startedAt = Get-Date
$timings = [ordered]@{}
$calibration = $null
$driverSelection = ''
$prepInfo = ''
$helper = $null
$helperExit = $null
$cleanupInfo = ''
$wordApp = $null; $wordDoc = $null; $excelApp = $null; $excelWb = $null
$startedProcs = @()
$targetHwnd = [IntPtr]::Zero
$targetPid = 0
$drag = $null
$doubleClickPoint = $null
$excelEditPoint = $null
$exitCode = 4
$foregroundBefore = [IntPtr]::Zero
$clipboardBefore = $null
$hasClipboardBefore = $false
$browserProfile = $null
$explorerFolder = $null

$nativeSource = @'
using System;
using System.Runtime.InteropServices;
public static class R0Matrix {
    [StructLayout(LayoutKind.Sequential)] public struct R0Rect { public int Left; public int Top; public int Right; public int Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct R0Monitor { public int cbSize; public R0Rect rcMonitor; public R0Rect rcWork; public uint dwFlags; }
    public delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdc, ref R0Rect rect, IntPtr data);
    [DllImport("user32.dll")] public static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc proc, IntPtr data);
    [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr hMonitor, ref R0Monitor info);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hwnd, int x, int y, int width, int height, bool repaint);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out R0Rect rect);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
    public const uint KEYUP = 0x0002;
    public const byte VK_CONTROL = 0x11;
    public const byte VK_SHIFT = 0x10;
    public const byte VK_L = 0x4C;

    public static int[][] Monitors() {
        var list = new System.Collections.Generic.List<int[]>();
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate (IntPtr h, IntPtr hdc, ref R0Rect r, IntPtr d) {
            var info = new R0Monitor(); info.cbSize = Marshal.SizeOf(typeof(R0Monitor));
            if (GetMonitorInfo(h, ref info)) { list.Add(new int[] { info.rcMonitor.Left, info.rcMonitor.Top, info.rcMonitor.Right, info.rcMonitor.Bottom, (int)info.dwFlags }); }
            return true;
        }, IntPtr.Zero);
        return list.ToArray();
    }
    public static int[] RectOf(IntPtr hwnd) {
        R0Rect r; if (!GetWindowRect(hwnd, out r)) return null;
        return new int[] { r.Left, r.Top, r.Right, r.Bottom };
    }
    public static int[] Foreground() {
        IntPtr h = GetForegroundWindow(); uint pid = 0; GetWindowThreadProcessId(h, out pid);
        return new int[] { h.ToInt32(), (int)pid };
    }
    public static int PidOf(IntPtr hwnd) {
        uint pid = 0; GetWindowThreadProcessId(hwnd, out pid); return (int)pid;
    }
    public static void Click(int x, int y, int holdMs) {
        SetCursorPos(x, y); System.Threading.Thread.Sleep(150);
        mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero); System.Threading.Thread.Sleep(holdMs);
        mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
    }
    public static void Drag(int x1, int y1, int x2, int y2, int steps) {
        SetCursorPos(x1, y1); System.Threading.Thread.Sleep(180);
        mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero); System.Threading.Thread.Sleep(90);
        for (int i = 1; i <= steps; i++) { SetCursorPos(x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps); System.Threading.Thread.Sleep(22); }
        System.Threading.Thread.Sleep(90); mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
    }
    public static void DoubleClick(int x, int y) {
        SetCursorPos(x, y); System.Threading.Thread.Sleep(180);
        mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero); mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
        System.Threading.Thread.Sleep(110);
        mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero); mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
    }
    public static void ShiftClick(int x, int y) {
        keybd_event(VK_SHIFT, 0, 0, UIntPtr.Zero); System.Threading.Thread.Sleep(80);
        SetCursorPos(x, y); System.Threading.Thread.Sleep(120);
        mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero); System.Threading.Thread.Sleep(60);
        mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero); System.Threading.Thread.Sleep(80);
        keybd_event(VK_SHIFT, 0, KEYUP, UIntPtr.Zero);
    }
    public static void SendCtrlL() {
        keybd_event(VK_CONTROL, 0, 0, UIntPtr.Zero); System.Threading.Thread.Sleep(40);
        keybd_event(VK_L, 0, 0, UIntPtr.Zero); System.Threading.Thread.Sleep(40);
        keybd_event(VK_L, 0, KEYUP, UIntPtr.Zero); System.Threading.Thread.Sleep(40);
        keybd_event(VK_CONTROL, 0, KEYUP, UIntPtr.Zero);
    }
    // Effective mandatory integrity level of a process token (Windows integrity levels).
    [StructLayout(LayoutKind.Sequential)] public struct SID_AND_ATTRIBUTES2 { public IntPtr Sid; public uint Attributes; }
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int cls, IntPtr info, int len, out int needed);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
    [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
    public static string IntegrityOf(int pid) {
        IntPtr proc = OpenProcess(0x1000, false, pid);
        if (proc == IntPtr.Zero) return "unknown";
        IntPtr token;
        if (!OpenProcessToken(proc, 0x0008, out token)) { CloseHandle(proc); return "unknown"; }
        int len; GetTokenInformation(token, 25, IntPtr.Zero, 0, out len);
        IntPtr info = Marshal.AllocHGlobal(len);
        string name = "unknown";
        if (GetTokenInformation(token, 25, info, len, out len)) {
            IntPtr label = Marshal.ReadIntPtr(info);
            byte count = Marshal.ReadByte(GetSidSubAuthorityCount(label));
            uint rid = (uint)Marshal.ReadInt32(GetSidSubAuthority(label, (uint)(count - 1)));
            if (rid == 0x1000) name = "Low"; else if (rid == 0x2000) name = "Medium"; else if (rid == 0x3000) name = "High"; else if (rid == 0x4000) name = "System"; else name = "RID=0x" + rid.ToString("x");
        }
        Marshal.FreeHGlobal(info); CloseHandle(token); CloseHandle(proc);
        return name;
    }
    public static void SendCtrlC() {
        keybd_event(VK_CONTROL, 0, 0, UIntPtr.Zero); System.Threading.Thread.Sleep(40);
        keybd_event(0x43, 0, 0, UIntPtr.Zero); System.Threading.Thread.Sleep(40);
        keybd_event(0x43, 0, KEYUP, UIntPtr.Zero); System.Threading.Thread.Sleep(40);
        keybd_event(VK_CONTROL, 0, KEYUP, UIntPtr.Zero);
    }
    public static bool CloseWindow(IntPtr hwnd) { return PostMessage(hwnd, 0x0010, IntPtr.Zero, IntPtr.Zero); }
}
'@
Add-Type -TypeDefinition $nativeSource -Language CSharp
try { Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop } catch { }
try { Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop } catch { }
$uiaAvailable = $null -ne ('System.Windows.Automation.AutomationElement' -as [type])
if (-not $uiaAvailable) { Write-Host 'ERROR: UIA assemblies unavailable in this PowerShell host'; exit 4 }
try { [void][R0Matrix]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch { }

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$ctProp = [System.Windows.Automation.AutomationElement]::ControlTypeProperty
$textAvailProp = [System.Windows.Automation.AutomationElement]::IsTextPatternAvailableProperty

function RectStr($r) {
    if ($null -eq $r) { return 'null' }
    return ('({0},{1}) {2}x{3}' -f [int]$r.Left, [int]$r.Top, [int]$r.Width, [int]$r.Height)
}
function IsRectUsable($r, $monitorRect) {
    if ($null -eq $r) { return $false }
    if ($r.Width -lt 20 -or $r.Height -lt 8) { return $false }
    if ($r.Left -lt ($monitorRect[0] - 20) -or $r.Top -lt ($monitorRect[1] - 20)) { return $false }
    if ($r.Right -gt ($monitorRect[2] + 20) -or $r.Bottom -gt ($monitorRect[3] + 20)) { return $false }
    return $true
}
function Get-TextElements($root, [int]$limit = 30) {
    $cond = New-Object System.Windows.Automation.PropertyCondition($textAvailProp, $true)
    $els = $root.FindAll($TS::Descendants, $cond)
    $out = @()
    foreach ($e in $els) {
        if ($out.Count -ge $limit) { break }
        $tp = $null
        try { $tp = $e.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern) } catch { continue }
        if (-not $tp) { continue }
        $name = ''; try { $name = [string]$e.Current.Name } catch { }
        $ctl = ''; try { $ctl = [string]$e.Current.ControlType.ProgrammaticName } catch { }
        $rect = $null; try { $rect = $e.Current.BoundingRectangle } catch { }
        $out += [pscustomobject]@{ Element = $e; Pattern = $tp; Name = $name; Control = $ctl; Rect = $rect }
    }
    return $out
}
function Get-SelectionTextFromPattern($pattern) {
    if (-not $pattern) { return '' }
    try {
        $sel = $pattern.GetSelection()
        if ($sel.Count -ge 1) { return [string]$sel[0].GetText(600) }
    } catch { }
    return ''
}
function Get-FocusedSelectionText {
    try {
        $focused = $AE::FocusedElement
        $tp = $focused.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
        return Get-SelectionTextFromPattern $tp
    } catch { return '' }
}
function Get-FocusedInfo {
    try {
        $f = $AE::FocusedElement
        $name = ''; try { $name = [string]$f.Current.Name } catch { }
        $ctl = ''; try { $ctl = [string]$f.Current.ControlType.ProgrammaticName } catch { }
        $rect = $null; try { $rect = $f.Current.BoundingRectangle } catch { }
        return [pscustomobject]@{ Name = $name; Control = $ctl; Rect = $rect }
    } catch { return [pscustomobject]@{ Name = ''; Control = ''; Rect = $null } }
}
function Find-TopWindowByTitle([string]$needle, [int]$timeoutMs) {
    $deadline = (Get-Date).AddMilliseconds($timeoutMs)
    while ((Get-Date) -lt $deadline) {
        $cond = New-Object System.Windows.Automation.PropertyCondition($ctProp, [System.Windows.Automation.ControlType]::Window)
        $windows = $AE::RootElement.FindAll($TS::Children, $cond)
        foreach ($w in $windows) {
            try { if ($w.Current.Name -like "*$needle*") { return $w } } catch { }
        }
        Start-Sleep -Milliseconds 150
    }
    return $null
}
function Ensure-Foreground([IntPtr]$hwnd, [int]$processId) {
    for ($i = 0; $i -lt 4; $i++) {
        try { [void][R0Matrix]::SetForegroundWindow($hwnd) } catch { }
        Start-Sleep -Milliseconds 120
        $fg = [R0Matrix]::Foreground()
        if ($fg[1] -eq $processId) { return $true }
        $wr = [R0Matrix]::RectOf($hwnd)
        if ($wr) {
            [R0Matrix]::Click([int](($wr[0] + $wr[2]) / 2), [int]($wr[1] + 10), 60)
            Start-Sleep -Milliseconds 350
        }
    }
    $fg = [R0Matrix]::Foreground()
    return ($fg[1] -eq $processId)
}
function Send-PrepGesture($spec) {
    if ($Gesture -eq 'DoubleClick') {
        [R0Matrix]::DoubleClick([int]$spec.X, [int]$spec.Y)
    } elseif ($Gesture -eq 'ShiftClick') {
        [R0Matrix]::ShiftClick([int]$spec.X, [int]$spec.Y)
    } else {
        [R0Matrix]::Drag([int]$spec.X1, [int]$spec.Y1, [int]$spec.X2, [int]$spec.Y2, 12)
    }
}
# Locate selectable text in a browser window without relying on the UIA page tree:
# sweep horizontal drags over the page, copy the selection with a real Ctrl+C, and accept
# when the clipboard contains the scripted probe text. The caller restores the clipboard.
function Invoke-BrowserClipboardCalibration([int]$wLeft, [int]$wTop, [int]$wWidth, [int]$wHeight, [int]$maxAttempts = 14, [int]$startOffset = 150, [string]$matchPattern = 'R0-04|second line') {
    $attempts = @()
    # x offsets are relative to the supplied content rect (callers pass a UIA content rect
    # when one is available, otherwise the whole window rect).
    $xPairs = New-Object System.Collections.ArrayList
    [void]$xPairs.Add([pscustomobject]@{ A = [int]$wLeft + 20; B = [int]($wLeft + [Math]::Max(120, [Math]::Min($wWidth - 30, 340))) })
    [void]$xPairs.Add([pscustomobject]@{ A = [int]$wLeft + 10; B = [int]($wLeft + [Math]::Max(160, [Math]::Min($wWidth - 20, 560))) })
    $n = 0
    for ($y = $wTop + $startOffset; $y -le ($wTop + $wHeight - 60); $y += 44) {
        foreach ($xp in $xPairs) {
            if ($n -ge $maxAttempts) { break }
            $n++
            $spec = [pscustomobject]@{ X1 = $xp.A; Y1 = [int]$y; X2 = $xp.B; Y2 = [int]$y }
            [void](Ensure-Foreground $targetHwnd $targetPid)
            Start-Sleep -Milliseconds 120
            Send-PrepGesture $spec
            Start-Sleep -Milliseconds 180
            [R0Matrix]::SendCtrlC()
            Start-Sleep -Milliseconds 250
            $clip = $null
            try { $clip = Get-Clipboard -Raw -ErrorAction SilentlyContinue } catch { }
            $attempts += ('y={0} clip="{1}"' -f [int]$y, ([string]$clip -replace "`r", '\r' -replace "`n", '\n' -replace '"', "'"))
            if ($clip -and ([string]$clip -match $matchPattern)) {
                return [pscustomobject]@{ Ok = $true; Spec = $spec; Selection = [string]$clip; Attempts = $attempts }
            }
        }
        if ($n -ge $maxAttempts) { break }
    }
    return [pscustomobject]@{ Ok = $false; Spec = $null; Selection = ''; Attempts = $attempts }
}
function Wait-HelperStarted([string]$path, $proc, [int]$timeoutMs) {
    $deadline = (Get-Date).AddMilliseconds($timeoutMs)
    while ((Get-Date) -lt $deadline) {
        if (Test-Path $path) {
            $content = Get-Content -Raw $path -ErrorAction SilentlyContinue
            if ($content -and $content.Contains('"status":"started"')) { return $true }
        }
        if ($proc.HasExited) { return $false }
        Start-Sleep -Milliseconds 100
    }
    return $false
}
function Read-HelperResults([string]$path) {
    $lines = @()
    if (Test-Path $path) { $lines = @(Get-Content $path -ErrorAction SilentlyContinue) }
    $selections = @()
    foreach ($line in $lines) {
        if ($line -match '"type":"text-selection"') {
            try { $selections += ($line | ConvertFrom-Json) } catch { }
        }
    }
    return $selections
}

# --- display selection ---------------------------------------------------------------
$monitorList = [R0Matrix]::Monitors()
$secondary = $null; $primary = $null
foreach ($m in $monitorList) {
    if (($m[4] -band 1) -ne 0) { if (-not $primary) { $primary = $m } } else { if (-not $secondary) { $secondary = $m } }
}
$displayName = ''
if ($secondary) {
    $monitorRect = @($secondary[0], $secondary[1], $secondary[2], $secondary[3])
    $displayName = 'secondary'
} elseif ($primary -and $AllowPrimaryDisplay) {
    $monitorRect = @($primary[0], $primary[1], $primary[2], $primary[3])
    $displayName = 'primary (explicitly allowed by -AllowPrimaryDisplay; user authorized this evidence run)'
} else {
    Write-Host 'SKIP: no secondary monitor and -AllowPrimaryDisplay not passed; refusing to open a visible test window on the primary display.'
    exit 2
}
$monW = $monitorRect[2] - $monitorRect[0]
$monH = $monitorRect[3] - $monitorRect[1]
# The helper console window must stay visible and un-moved (hook delivery on this host), and
# the target must not sit under it: place the target in a bottom strip while the console
# stays in the upper part of the screen.
$winW = [Math]::Min(1200, [Math]::Max(760, $monW - 120))
$winH = [Math]::Min(470, [Math]::Max(360, [int]($monH * 0.34)))
$winX = $monitorRect[0] + 40
$winY = $monitorRect[1] + $monH - $winH - 80
Write-Host ("TARGET={0} GESTURE={1} clipboard={2} display={3} monitor=({4},{5}) {6}x{7} window=({8},{9}) {10}x{11}" -f $Target, $Gesture, $Clipboard, $displayName, $monitorRect[0], $monitorRect[1], $monW, $monH, $winX, $winY, $winW, $winH)

# --- clipboard / foreground backup ---------------------------------------------------
try { $foregroundBefore = [IntPtr][R0Matrix]::Foreground()[0] } catch { }
try {
    $raw = Get-Clipboard -Raw -ErrorAction SilentlyContinue
    if ($null -ne $raw) { $clipboardBefore = [string]$raw; $hasClipboardBefore = $true }
} catch { }
Write-Host ("clipboard before: has={0} len={1}" -f $hasClipboardBefore, $(if ($hasClipboardBefore) { $clipboardBefore.Length } else { 0 }))

$helperStartReady = $false
try {
    # --- target preparation -----------------------------------------------------------
    $prepStart = Get-Date
    $a11yArgs = @()
    if ($BrowserA11y -eq 'force') { $a11yArgs = @('--force-renderer-accessibility') }
    switch ($Target) {
        'Chrome' {
            $exe = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
            if (-not (Test-Path $exe)) { throw "Chrome not found: $exe" }
            $browserProfile = Join-Path $OutDir ('matrix-profile-chrome-' + $tagBase)
            Remove-Item -Recurse -Force $browserProfile -ErrorAction SilentlyContinue
            $htmlPath = Join-Path $OutDir ('matrix-browser-' + $tagBase + '.html')
            $html = @'
<!doctype html><html><head><meta charset="utf-8"><title>R0-04 selection matrix</title></head>
<body style="margin:0;padding:40px 48px;font:44px/1.35 'Segoe UI',sans-serif">
<h1 id="probe" style="margin:0;font-size:44px">R0-04 chrome selection probe line one</h1>
<p style="font-size:32px">second line has several words to choose</p>
</body></html>
'@
            [IO.File]::WriteAllText($htmlPath, $html, (New-Object Text.UTF8Encoding($false)))
            $uri = 'file:///' + ($htmlPath -replace '\\', '/')
            $p = Start-Process -FilePath $exe -ArgumentList (@("--user-data-dir=$browserProfile", '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking') + $a11yArgs + @('--new-window', $uri)) -PassThru
            $startedProcs += $p
            $win = Find-TopWindowByTitle 'R0-04 selection matrix' 15000
            if (-not $win) { throw 'Chrome target window did not appear' }
        }
        'Edge' {
            $exe = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
            if (-not (Test-Path $exe)) { throw "Edge not found: $exe" }
            $browserProfile = Join-Path $OutDir ('matrix-profile-edge-' + $tagBase)
            Remove-Item -Recurse -Force $browserProfile -ErrorAction SilentlyContinue
            $htmlPath = Join-Path $OutDir ('matrix-browser-' + $tagBase + '.html')
            $html = @'
<!doctype html><html><head><meta charset="utf-8"><title>R0-04 selection matrix</title></head>
<body style="margin:0;padding:40px 48px;font:44px/1.35 'Segoe UI',sans-serif">
<h1 id="probe" style="margin:0;font-size:44px">R0-04 edge selection probe line one</h1>
<p style="font-size:32px">second line has several words to choose</p>
</body></html>
'@
            [IO.File]::WriteAllText($htmlPath, $html, (New-Object Text.UTF8Encoding($false)))
            $uri = 'file:///' + ($htmlPath -replace '\\', '/')
            $p = Start-Process -FilePath $exe -ArgumentList (@("--user-data-dir=$browserProfile", '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking') + $a11yArgs + @('--new-window', $uri)) -PassThru
            $startedProcs += $p
            $win = Find-TopWindowByTitle 'R0-04 selection matrix' 15000
            if (-not $win) { throw 'Edge target window did not appear' }
        }
        'Word' {
            $wordApp = New-Object -ComObject Word.Application
            $wordApp.Visible = $true
            $wordDoc = $wordApp.Documents.Add()
            $wordDoc.Content.Text = "R0-04 word selection probe line one`rsecond line has several words to choose`r"
            $wordApp.ActiveWindow.WindowState = 0
            Start-Sleep -Milliseconds 1200
            $targetHwnd = [IntPtr]$wordApp.ActiveWindow.Hwnd
            $win = $AE::FromHandle($targetHwnd)
        }
        'Excel' {
            $excelApp = New-Object -ComObject Excel.Application
            $excelApp.Visible = $true
            $excelApp.DisplayAlerts = $false
            $excelWb = $excelApp.Workbooks.Add()
            $ws = $excelWb.Worksheets.Item(1)
            $ws.Cells.Item(1, 1).Value2 = 'R0-04 excel selection probe cell'
            $ws.Cells.Item(2, 1).Value2 = 'excel second row'
            Start-Sleep -Milliseconds 1200
            $targetHwnd = [IntPtr]$excelApp.Hwnd
            $win = $AE::FromHandle($targetHwnd)
        }
        'Explorer' {
            $explorerFolder = Join-Path $OutDir ('matrix-explorer-' + $tagBase)
            New-Item -ItemType Directory -Force -Path $explorerFolder | Out-Null
            [IO.File]::WriteAllText((Join-Path $explorerFolder 'R0-04 explorer probe file.txt'), "probe`r`n", [Text.Encoding]::ASCII)
            Start-Process -FilePath 'explorer.exe' -ArgumentList ('"{0}"' -f $explorerFolder) | Out-Null
            Start-Sleep -Milliseconds 1200
            $needle = Split-Path -Leaf $explorerFolder
            $win = Find-TopWindowByTitle $needle 12000
            if (-not $win) { throw ("Explorer window did not appear for {0}" -f $needle) }
        }
        'Notepad' {
            $txtPath = Join-Path $OutDir ('matrix-notepad-' + $tagBase + '.txt')
            Set-Content -Path $txtPath -Encoding UTF8 -Value @(
                'R0-04 notepad selection probe line one',
                'second line has several words to choose',
                'third line must stay unselected'
            )
            $p = Start-Process -FilePath 'notepad.exe' -ArgumentList ('"{0}"' -f $txtPath) -PassThru
            $startedProcs += $p
            Start-Sleep -Milliseconds 1000
            $win = Find-TopWindowByTitle (Split-Path -Leaf $txtPath) 12000
            if (-not $win) { throw 'Notepad window did not appear' }
        }
    }
    $targetHwnd = [IntPtr]$win.Current.NativeWindowHandle
    if ($targetHwnd -eq [IntPtr]::Zero) { throw 'target window handle is zero' }
    $targetPid = [R0Matrix]::PidOf($targetHwnd)
    [void][R0Matrix]::MoveWindow($targetHwnd, $winX, $winY, $winW, $winH, $true)
    Start-Sleep -Milliseconds 500
    [void][R0Matrix]::SetForegroundWindow($targetHwnd)
    Start-Sleep -Milliseconds 300
    $win = $AE::FromHandle($targetHwnd)
    [void](Ensure-Foreground $targetHwnd $targetPid)
    Write-Host ("target window: hwnd=0x{0:x} pid={1} name='{2}' rect={3}" -f [int64]$targetHwnd, $targetPid, $win.Current.Name, (RectStr $win.Current.BoundingRectangle))
    $prepInfo = ("window='{0}' rect={1}" -f $win.Current.Name, (RectStr $win.Current.BoundingRectangle))
    $timings.prepareMs = [int]((Get-Date) - $prepStart).TotalMilliseconds

    # --- calibration (find a real text position; helper not running yet) --------------
    $calStart = Get-Date
    switch ($Target) {
        'Chrome' { $isBrowser = $true }
        'Edge' { $isBrowser = $true }
        default { $isBrowser = $false }
    }
    if ($isBrowser) {
        $textEls = @()
        $deadline = (Get-Date).AddSeconds(6)
        while ((Get-Date) -lt $deadline) {
            $textEls = @(Get-TextElements $win | Where-Object {
                    $_.Name.Length -gt 8 -and $_.Rect -and (IsRectUsable $_.Rect $monitorRect) -and $_.Control -notmatch 'Edit'
                })
            if ($textEls.Count -gt 0) { break }
            Start-Sleep -Milliseconds 250
        }
        $textOnly = @($textEls | Where-Object { $_.Control -match 'Text$' })
        if ($textOnly.Count -gt 0) { $textEls = $textOnly }
        # Prefer the scripted probe paragraph so transient browser UI text cannot be picked.
        $preferred = @($textEls | Where-Object { $_.Name -match 'R0-04|second line|probe' })
        if ($preferred.Count -gt 0) { $textEls = $preferred }
        $chosen = $null
        $tried = @()
        foreach ($candidate in @($textEls | Sort-Object { $_.Rect.Top })) {
            $r = $candidate.Rect
            $spec = [pscustomobject]@{
                X1 = [int]$r.Left + 6
                Y1 = [int]($r.Top + $r.Height / 2)
                X2 = [int]($r.Left + [Math]::Min($r.Width - 8, 330))
                Y2 = [int]($r.Top + $r.Height / 2)
            }
            [void](Ensure-Foreground $targetHwnd $targetPid)
            Start-Sleep -Milliseconds 150
            Send-PrepGesture $spec
            Start-Sleep -Milliseconds 400
            $sel = Get-FocusedSelectionText
            $tried += ('name="{0}" rect={1} sel="{2}"' -f $candidate.Name, (RectStr $r), ($sel -replace "`r", '\r' -replace "`n", '\n'))
            if ($sel.Length -gt 0) { $chosen = $candidate; $drag = $spec; $driverSelection = $sel; break }
        }
        if ($chosen) {
            $calibration = ('uia-text-element name="{0}" rect={1}; drag=({2},{3})->({4},{5})' -f $chosen.Name, (RectStr $chosen.Rect), $drag.X1, $drag.Y1, $drag.X2, $drag.Y2)
            Write-Host ("calibration: {0}" -f $calibration)
            Write-Host ("driver UIA selection after calibration drag (len={0}): '{1}'" -f $driverSelection.Length, ($driverSelection -replace "`r", '\r' -replace "`n", '\n'))
        } else {
            # No usable UIA page tree (e.g. Chromium accessibility not activated in this
            # host); fall back to a clipboard-verified drag sweep. Ctrl+C is a real key
            # injection and is also what the helper's clipboard fallback uses later.
            Write-Host ("browser UIA page tree not usable (text elements={0}); falling back to Ctrl+C clipboard sweep" -f $textEls.Count)
            $clipCal = Invoke-BrowserClipboardCalibration $winX $winY $winW $winH
            if (-not $clipCal.Ok) {
                throw ('browser calibration failed; uia tried: ' + ($tried -join ' || ') + ' ; clipboard sweep: ' + ($clipCal.Attempts -join ' | '))
            }
            $drag = $clipCal.Spec
            $driverSelection = $clipCal.Selection
            $calibration = ('clipboard-calibration drag=({0},{1})->({2},{3}); ctrl+C selection="{4}"' -f $drag.X1, $drag.Y1, $drag.X2, $drag.Y2, ($driverSelection -replace "`r", '\r' -replace "`n", '\n'))
            Write-Host ("calibration: {0}" -f $calibration)
            if ($hasClipboardBefore) { Set-Clipboard -Value $clipboardBefore }
        }
    } elseif ($Target -eq 'Word') {
        # The Word document text area is an Edit control tall enough to hold text; the ribbon
        # search box is also an Edit but much shorter. Fall back to the Document element rect.
        $edits = @(Get-TextElements $win | Where-Object { $_.Control -match 'Edit' -and $_.Rect -and (IsRectUsable $_.Rect $monitorRect) -and $_.Rect.Width -gt 120 -and $_.Rect.Height -gt 60 })
        $area = $edits | Sort-Object { $_.Rect.Width * $_.Rect.Height } -Descending | Select-Object -First 1
        if (-not $area) {
            $docEl = $win.FindFirst($TS::Descendants, (New-Object System.Windows.Automation.PropertyCondition($ctProp, [System.Windows.Automation.ControlType]::Document)))
            if ($docEl) {
                try {
                    $docRect = $docEl.Current.BoundingRectangle
                    if ($docRect -and (IsRectUsable $docRect $monitorRect)) { $area = [pscustomobject]@{ Name = 'document'; Rect = $docRect } }
                } catch { }
            }
        }
        $found = $false
        $tried = @()
        if ($area) {
            $ar = $area.Rect
            Write-Host ("word text area: name='{0}' rect={1}" -f $area.Name, (RectStr $ar))
            $yEnd = [int]($ar.Bottom - 20)
            $x1 = [int]$ar.Left + 18
            $x2 = [int]($ar.Left + [Math]::Min($ar.Width - 40, 360))
            for ($y = [int]$ar.Top + 24; $y -le $yEnd; $y += 26) {
                $spec = [pscustomobject]@{ X1 = $x1; Y1 = $y; X2 = $x2; Y2 = $y }
                Send-PrepGesture $spec
                Start-Sleep -Milliseconds 220
                $sel = ''
                try { $sel = [string]$wordApp.Selection.Text } catch { }
                $tried += ('y={0}:"{1}"' -f $y, ($sel -replace "`r", '\r' -replace "`n", '\n'))
                if ($sel -match 'R0-04') {
                    $drag = $spec
                    $found = $true
                    $driverSelection = [string]$wordApp.Selection.Text
                    break
                }
            }
        }
        if ($found) {
            $calibration = ('word UIA text-area drag ({0},{1})->({2},{3}); COM selection="{4}"' -f $drag.X1, $drag.Y1, $drag.X2, $drag.Y2, ($driverSelection -replace "`r", '\r' -replace "`n", '\n'))
        } else {
            Write-Host 'word UIA text-area calibration unavailable; falling back to Ctrl+C clipboard sweep'
            if ($area) {
                $sweep = Invoke-BrowserClipboardCalibration ([int]$ar.Left) ([int]$ar.Top) ([int]$ar.Width) ([int]$ar.Height) 8 8 'R0-04|word'
            } else {
                $sweep = Invoke-BrowserClipboardCalibration $winX $winY $winW $winH 8 120 'R0-04|word'
            }
            if (-not $sweep.Ok) { throw ('Word calibration failed; UIA tried: ' + ($tried -join ' | ') + ' ; sweep: ' + ($sweep.Attempts -join ' | ')) }
            $drag = $sweep.Spec
            $driverSelection = $sweep.Selection
            $calibration = ('word clipboard-calibration drag=({0},{1})->({2},{3}); ctrl+C="{4}"' -f $drag.X1, $drag.Y1, $drag.X2, $drag.Y2, ($driverSelection -replace "`r", '\r' -replace "`n", '\n'))
            if ($hasClipboardBefore) { Set-Clipboard -Value $clipboardBefore }
        }
        try { $wordDoc.Range(0, 0).Select() | Out-Null } catch { }
        Write-Host ("calibration: {0}" -f $calibration)
    } elseif ($Target -eq 'Excel') {
        $drag = $null
        $calibration = ''
        # Prefer the formula bar: an Excel cell selection is reported as a non-text UI-object
        # selection, which the retrieval engine deliberately does not copy via the clipboard.
        # The formula-bar Edit exposes a UIA TextPattern selection instead.
        try { $excelApp.Range('A1').Select() | Out-Null } catch { }
        Start-Sleep -Milliseconds 200
        $edits = @(Get-TextElements $win | Where-Object { $_.Control -match 'Edit' -and $_.Rect -and (IsRectUsable $_.Rect $monitorRect) -and $_.Rect.Width -gt 300 })
        $formulaBar = $edits | Sort-Object { $_.Rect.Width } -Descending | Select-Object -First 1
        if ($formulaBar) {
            $fr = $formulaBar.Rect
            $spec = [pscustomobject]@{
                X1 = [int]$fr.Left + 12
                Y1 = [int]($fr.Top + $fr.Height / 2)
                X2 = [int]($fr.Left + [Math]::Min($fr.Width - 20, 300))
                Y2 = [int]($fr.Top + $fr.Height / 2)
            }
            [void](Ensure-Foreground $targetHwnd $targetPid)
            Start-Sleep -Milliseconds 150
            Send-PrepGesture $spec
            Start-Sleep -Milliseconds 300
            $driverSelection = Get-FocusedSelectionText
            $calibration = ('excel formula-bar name="{0}" rect={1} drag=({2},{3})->({4},{5})' -f $formulaBar.Name, (RectStr $fr), $spec.X1, $spec.Y1, $spec.X2, $spec.Y2)
            if ($driverSelection -match 'R0-04|excel') { $drag = $spec }
            else { $calibration += '; formula-bar drag produced no UIA selection: "' + ($driverSelection -replace "`r", '\r' -replace "`n", '\n') + '"' }
        }
        if (-not $drag) {
            $itemCond = New-Object System.Windows.Automation.PropertyCondition($ctProp, [System.Windows.Automation.ControlType]::DataItem)
            $items = $win.FindAll($TS::Descendants, $itemCond)
            $cell = $null
            foreach ($e in $items) { try { if ([string]$e.Current.Name -eq 'A1') { $cell = $e; break } } catch { } }
            if (-not $cell) { throw 'Excel calibration failed: neither formula bar nor A1 data item found' }
            $r = $cell.Current.BoundingRectangle
            $excelEditPoint = [pscustomobject]@{ X = [int]$r.Left + 12; Y = [int]($r.Top + $r.Height / 2) }
            # Enter in-cell edit mode with a real double-click, then drag-select text inside the
            # cell editor; a grid cell selection is a non-text UI-object selection, but the
            # in-cell editor exposes a UIA TextPattern selection.
            [void](Ensure-Foreground $targetHwnd $targetPid)
            Start-Sleep -Milliseconds 150
            [R0Matrix]::DoubleClick($excelEditPoint.X, $excelEditPoint.Y)
            Start-Sleep -Milliseconds 450
            $spec = [pscustomobject]@{
                X1 = [int]$r.Left + 8
                Y1 = [int]($r.Top + $r.Height / 2)
                X2 = [int]$r.Left + [Math]::Min($r.Width - 8, 80)
                Y2 = [int]($r.Top + $r.Height / 2)
            }
            Send-PrepGesture $spec
            Start-Sleep -Milliseconds 300
            $driverSelection = Get-FocusedSelectionText
            $calibration += ('; A1 edit-mode rect={0} drag=({1},{2})->({3},{4}) sel="{5}"' -f (RectStr $r), $spec.X1, $spec.Y1, $spec.X2, $spec.Y2, ($driverSelection -replace "`r", '\r' -replace "`n", '\n'))
            if ($driverSelection.Length -gt 0) { $drag = $spec }
            else {
                $drag = [pscustomobject]@{
                    X1 = [int]$r.Left + 6
                    Y1 = [int]($r.Top + $r.Height / 2)
                    X2 = [int]$r.Right - 6
                    Y2 = [int]($r.Top + $r.Height / 2)
                }
                Send-PrepGesture $drag
                Start-Sleep -Milliseconds 300
                try { $driverSelection = ('address={0} text="{1}"' -f $excelApp.Selection.Address($false, $false), ($excelApp.Selection.Text -replace "`r", '\r' -replace "`n", '\n')) } catch { }
            }
        }
        Write-Host ("calibration: {0}" -f $calibration)
    } elseif ($Target -eq 'Explorer') {
        $spec = $null
        $addrTexts = @()
        $ok = $false
        for ($attempt = 0; $attempt -lt 4; $attempt++) {
            [void](Ensure-Foreground $targetHwnd $targetPid)
            [R0Matrix]::SendCtrlL()
            Start-Sleep -Milliseconds 600
            $fi = Get-FocusedInfo
            if (-not $fi.Rect -or -not (IsRectUsable $fi.Rect $monitorRect) -or $fi.Rect.Width -lt 200) {
                $addrTexts += ('attempt {0}: focused control={1} name="{2}" rect={3}' -f $attempt, $fi.Control, $fi.Name, (RectStr $fi.Rect))
                Start-Sleep -Milliseconds 400
                continue
            }
            $r = $fi.Rect
            $y = [int]($r.Top + $r.Height / 2) + ($attempt - 1) * 5
            if ($Gesture -eq 'DoubleClick') {
                $spec = [pscustomobject]@{ X = [int]$r.Left + 40 + ($attempt * 70); Y = $y }
            } elseif ($Gesture -eq 'ShiftClick') {
                $spec = [pscustomobject]@{ X = [int]$r.Left + 40; Y = $y }
            } else {
                $spec = [pscustomobject]@{
                    X1 = [int]$r.Left + 20
                    Y1 = $y
                    X2 = [int]($r.Left + [Math]::Min($r.Width - 30, 280))
                    Y2 = $y
                }
            }
            Send-PrepGesture $spec
            Start-Sleep -Milliseconds 400
            $driverSelection = Get-FocusedSelectionText
            if ($driverSelection.Length -le 3) {
                # The address-bar Edit exposes TextPattern but its GetSelection can be empty for
                # the driver; fall back to a real Ctrl+C and clipboard readback.
                [R0Matrix]::SendCtrlC()
                Start-Sleep -Milliseconds 250
                $clip = $null
                try { $clip = Get-Clipboard -Raw -ErrorAction SilentlyContinue } catch { }
                $addrTexts += ('attempt {0}: ctrl+C clipboard="{1}"' -f $attempt, ([string]$clip -replace "`r", '\r' -replace "`n", '\n'))
                if ($clip -and ([string]$clip -match 'Highlighter|matrix-explorer|workspace|\\\\')) { $driverSelection = [string]$clip }
            }
            $fi2 = Get-FocusedInfo
            $addrTexts += ('attempt {0}: focused name="{1}" ctl={2} rect={3} selection="{4}"' -f $attempt, $fi2.Name, $fi2.Control, (RectStr $fi2.Rect), ($driverSelection -replace "`r", '\r' -replace "`n", '\n'))
            if ($driverSelection.Length -gt 3) { $ok = $true; $drag = $spec; break }
        }
        $calibration = ('explorer address bar; ' + ($addrTexts -join ' || '))
        Write-Host ("calibration: {0}" -f $calibration)
        if ($hasClipboardBefore) { Set-Clipboard -Value $clipboardBefore }
        if (-not $ok) { throw 'Explorer calibration failed: no address bar text selection via UIA or Ctrl+C' }
    } elseif ($Target -eq 'Notepad') {
        # Windows 11 Notepad's UIA TextPattern returns no DocumentRange bounding rectangles,
        # so calibrate with the same Ctrl+C clipboard sweep used for browsers.
        $drag = $null
        $driverSelection = ''
        $contentRect = $null
        $doc = $win.FindFirst($TS::Descendants, (New-Object System.Windows.Automation.PropertyCondition($ctProp, [System.Windows.Automation.ControlType]::Document)))
        if ($doc) { try { $contentRect = $doc.Current.BoundingRectangle } catch { } }
        if ($doc) {
            try {
                $tp = $doc.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
                $rb = $tp.DocumentRange.GetBoundingRectangles()
                if ($rb.Count -ge 4) {
                    $r = [pscustomobject]@{ Left = [int]$rb[0]; Top = [int]$rb[1]; Width = [int]$rb[2]; Height = [int]$rb[3] }
                    $drag = [pscustomobject]@{
                        X1 = [int]$r.Left + 6
                        Y1 = [int]($r.Top + $r.Height / 2)
                        X2 = [int]$r.Left + [Math]::Min($r.Width - 8, 330)
                        Y2 = [int]($r.Top + $r.Height / 2)
                    }
                    $calibration = ('notepad UIA first-line rect={0}' -f (RectStr $r))
                    Send-PrepGesture $drag
                    Start-Sleep -Milliseconds 300
                    $driverSelection = Get-FocusedSelectionText
                    if (-not $driverSelection) { $drag = $null }
                }
            } catch { }
        }
        if (-not $drag) {
            Write-Host 'notepad UIA rects unavailable; falling back to Ctrl+C clipboard sweep'
            if ($contentRect -and (IsRectUsable $contentRect $monitorRect)) {
                $sweep = Invoke-BrowserClipboardCalibration ([int]$contentRect.Left) ([int]$contentRect.Top) ([int]$contentRect.Width) ([int]$contentRect.Height) 8 8 'R0-04|notepad'
            } else {
                $sweep = Invoke-BrowserClipboardCalibration $winX $winY $winW $winH 8 110 'R0-04|notepad'
            }
            if (-not $sweep.Ok) { throw ('Notepad calibration failed; sweep: ' + ($sweep.Attempts -join ' | ')) }
            $drag = $sweep.Spec
            $driverSelection = $sweep.Selection
            $calibration = ('notepad clipboard-calibration drag=({0},{1})->({2},{3}); ctrl+C="{4}"' -f $drag.X1, $drag.Y1, $drag.X2, $drag.Y2, ($driverSelection -replace "`r", '\r' -replace "`n", '\n'))
            if ($hasClipboardBefore) { Set-Clipboard -Value $clipboardBefore }
        }
        Write-Host ("calibration: {0}" -f $calibration)
        Write-Host ("driver selection after calibration drag (len={0}): '{1}'" -f $driverSelection.Length, ($driverSelection -replace "`r", '\r' -replace "`n", '\n'))
    }
    $timings.calibrationMs = [int]((Get-Date) - $calStart).TotalMilliseconds
    if (-not $drag) { throw 'no gesture coordinates after calibration' }

    # Clear any calibration selection without touching the mouse gesture state machine.
    try {
        if ($wordApp) { $wordDoc.Range(0, 0).Select() | Out-Null }
        if ($excelApp) { $excelApp.Range('A1').Select() | Out-Null }
    } catch { }
    Start-Sleep -Milliseconds 300

    # --- start helper -----------------------------------------------------------------
    $helperArgs = @('--duration-ms', "$TimeoutMs", '--exit-after-selection')
    if ($Clipboard) { $helperArgs += '--clipboard' }
    if ($VerboseEvents) { $helperArgs += @('--mouse-events', '--keyboard-events') }
    Write-Host ("starting helper: {0} {1}" -f $HelperPath, ($helperArgs -join ' '))
    # The helper must keep a VISIBLE console window: on this host, low-level hook delivery
    # stops (heartbeat mouseEventsQueued stays 0) when the helper is started with
    # -WindowStyle Hidden / -NoNewWindow or its console window is hidden afterwards.
    # Evidence: .tmp-r0-hook/diag-hook*.jsonl and the 3x3 start-style comparison.
    $helper = Start-Process -FilePath $HelperPath -ArgumentList $helperArgs -PassThru `
        -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
    # Do NOT move or hide the helper console window: on this host either action silently
    # stops low-level hook delivery (see the start-style evidence), even though the console
    # stays visible.
    Start-Sleep -Milliseconds 400
    $helperStartReady = Wait-HelperStarted $stdoutPath $helper 10000
    if (-not $helperStartReady) {
        $exited = if ($helper.HasExited) { $helper.ExitCode } else { 'running' }
        throw ("helper did not report status:started (exited={0})" -f $exited)
    }
    $timings.helperReadyMs = [int]((Get-Date) - $startedAt).TotalMilliseconds
    # Environment guard: a helper built inside a workspace with an inherited Low mandatory
    # integrity label runs at Low IL. Under UIPI/No-Write-Up its hooks cannot observe input
    # aimed at Medium-IL applications and its UIA/clipboard access is blocked, so matrix
    # rows would be environment artifacts. Refuse to record evidence in that state.
    $helperIntegrity = [R0Matrix]::IntegrityOf($helper.Id)
    Write-Host ("helper integrity level: {0}" -f $helperIntegrity)
    if ($helperIntegrity -ne 'Medium') {
        throw ("helper integrity level is {0}, not Medium: the workspace mandatory label caps the built exe; rebuild after the ACL fix and rerun" -f $helperIntegrity)
    }

    # --- fire the real gesture --------------------------------------------------------
    $gestureStart = Get-Date
    $fgOk = if ($NoPreActivate -and $Target -ne 'Explorer') { ([R0Matrix]::Foreground()[1] -eq $targetPid) } else { Ensure-Foreground $targetHwnd $targetPid }
    if ($Target -eq 'Explorer') {
        # Ctrl+L is a real keyboard injection that enters address-bar edit mode; do it only
        # while the target is already foreground (a title-bar click afterwards would cancel
        # edit mode and drop the text selection).
        [R0Matrix]::SendCtrlL()
        Start-Sleep -Milliseconds 450
        $fgOk = ([R0Matrix]::Foreground()[1] -eq $targetPid)
    }
    Start-Sleep -Milliseconds 250
    if ($Target -eq 'Excel' -and $excelEditPoint) {
        # Re-enter in-cell edit mode (the calibration phase's edit mode was exited when the
        # selection was reset); the helper may observe this double-click as a first retrieval,
        # which is harmless because --exit-after-selection only exits on found=true.
        [void](Ensure-Foreground $targetHwnd $targetPid)
        Start-Sleep -Milliseconds 120
        [R0Matrix]::DoubleClick($excelEditPoint.X, $excelEditPoint.Y)
        Start-Sleep -Milliseconds 400
    }
    Write-Host ("foreground confirmed={0}; firing {1} gesture" -f $fgOk, $Gesture)
    Send-PrepGesture $drag
    $timings.gestureMs = [int]((Get-Date) - $gestureStart).TotalMilliseconds

    # --- collect results --------------------------------------------------------------
    if (-not $helper.WaitForExit($TimeoutMs + 6000)) {
        Write-Host 'helper did not exit in time; killing for cleanup'
        try { $helper.Kill(); $helper.WaitForExit(3000) | Out-Null } catch { }
    }
    Start-Sleep -Milliseconds 250
    try { $helper.Refresh() } catch { }
    if ($helper.HasExited) { try { $helperExit = $helper.ExitCode } catch { } }
    $selections = @(Read-HelperResults $stdoutPath)
    $found = @($selections | Where-Object { $_.found -eq $true })
    if ($helperExit -eq $null -and (Test-Path $stdoutPath)) {
        $stoppedLine = Get-Content $stdoutPath | Where-Object { $_ -match '"status":"stopped"' } | Select-Object -Last 1
        if ($stoppedLine -and $stoppedLine -match '"exitCode":(-?\d+)') { $helperExit = [int]$Matches[1] }
    }
    $last = if ($found.Count -gt 0) { $found[$found.Count - 1] } else { if ($selections.Count -gt 0) { $selections[$selections.Count - 1] } else { $null } }
    Write-Host ("helper exit={0} selections={1} found={2}" -f $helperExit, $selections.Count, $found.Count)
    foreach ($s in $selections) {
        Write-Host ("  text-selection: detection={0} found={1} method={2}({3}) textLength={4} stage={5} elapsedMs={6} program='{7}'" -f $s.detection, $s.found, $s.method, $s.methodName, $s.textLength, $s.stage, $s.retrievalElapsedMs, $s.program)
        Write-Host ("    text='{0}'" -f ([string]$s.text -replace "`r", '\r' -replace "`n", '\n'))
    }
    if ($last) {
        $driverSelection = if ($driverSelection) { [string]$driverSelection } else { '' }
        $result = [ordered]@{
            timestamp = (Get-Date).ToUniversalTime().ToString('o')
            target = $Target
            gesture = $Gesture
            clipboardFallback = [bool]$Clipboard
            browserA11y = $BrowserA11y
            helperIntegrity = $helperIntegrity
            display = $displayName
            helperExit = $helperExit
            selectionEvents = $selections.Count
            found = ($found.Count -gt 0)
            detection = $last.detection
            method = $last.method
            methodName = $last.methodName
            text = $last.text
            textLength = $last.textLength
            stage = $last.stage
            retrievalElapsedMs = $last.retrievalElapsedMs
            sourcePid = $last.sourcePid
            sourceHwnd = $last.sourceHwnd
            program = $last.program
            positionLevel = $last.positionLevel
            positionLevelName = $last.positionLevelName
            driverSelection = $driverSelection
            calibration = $calibration
            prepareInfo = $prepInfo
            targetPid = $targetPid
            timings = $timings
            helperStdout = (Split-Path -Leaf $stdoutPath)
            helperStderr = (Split-Path -Leaf $stderrPath)
            windowTotalMs = [int]((Get-Date) - $startedAt).TotalMilliseconds
        }
        [IO.File]::AppendAllText($resultPath, (($result | ConvertTo-Json -Compress) + "`n"), (New-Object Text.UTF8Encoding($false)))
    }
    if ($found.Count -gt 0) {
        $exitCode = 0
        Write-Host 'RESULT: PASS (real text selection observed by helper)'
    } else {
        $exitCode = 1
        Write-Host 'RESULT: FAIL (helper ran but no accepted text selection was observed)'
    }
} catch {
    $msg = $_.Exception.Message
    if ($msg -like '*helper did not report status:started*' -or $msg -like '*helper binary not found*') {
        $exitCode = 3
    } elseif ($msg -like '*integrity level is*') {
        $exitCode = 7
    } elseif ($msg -like '*calibration failed*' -or $msg -like '*did not appear*' -or $msg -like '*not found*') {
        $exitCode = 5
    } else {
        $exitCode = 4
    }
    Write-Host ("ERROR: {0}" -f $msg)
    if ($_.ScriptStackTrace) { Write-Host ("stack: {0}" -f $_.ScriptStackTrace) }
} finally {
    # --- cleanup ----------------------------------------------------------------------
    if ($helper -and -not $helper.HasExited) {
        try { $helper.Kill(); $helper.WaitForExit(3000) | Out-Null } catch { }
    }
    if ($wordApp) {
        try { $wordDoc.Close(0) | Out-Null } catch { }
        try { $wordApp.Quit(0) | Out-Null } catch { }
    }
    if ($excelApp) {
        try { $excelWb.Close($false) | Out-Null } catch { }
        try { $excelApp.Quit() | Out-Null } catch { }
    }
    if ($Target -eq 'Explorer' -and $targetHwnd -ne [IntPtr]::Zero) {
        try { [void][R0Matrix]::CloseWindow($targetHwnd) } catch { }
    }
    foreach ($p in $startedProcs) {
        try { if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } } catch { }
    }
    if ($browserProfile) {
        Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -and $_.CommandLine.Contains($browserProfile) } |
            ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch { } }
    }
    [GC]::Collect(); [GC]::WaitForPendingFinalizers()
    Start-Sleep -Milliseconds 300
    try {
        $after = Get-Clipboard -Raw -ErrorAction SilentlyContinue
        if ($hasClipboardBefore -and [string]$after -ne [string]$clipboardBefore) {
            Set-Clipboard -Value $clipboardBefore
            Start-Sleep -Milliseconds 150
        }
        $restored = Get-Clipboard -Raw -ErrorAction SilentlyContinue
        $cleanupInfo = ('clipboardRestored={0}' -f ([string]$restored -eq [string]$clipboardBefore))
    } catch { $cleanupInfo = 'clipboardCheckFailed' }
    if ($foregroundBefore -ne [IntPtr]::Zero) {
        try { [void][R0Matrix]::SetForegroundWindow($foregroundBefore) } catch { }
    }
    Write-Host ("cleanup: {0}" -f $cleanupInfo)
    Write-Host ("evidence: {0} / {1}" -f $stdoutPath, $stderrPath)
    Write-Host ("result appended: {0}" -f $resultPath)
    Write-Host ("window total: {0:n1}s" -f ((Get-Date) - $startedAt).TotalSeconds)
}
exit $exitCode
