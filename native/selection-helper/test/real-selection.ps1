# R0-04 real-selection automation driver (prototype evidence; NOT a product test).
#
# Opens a controlled target on the SECONDARY display, starts the standalone
# selection-helper, and performs a real mouse gesture with SendInput so the helper's
# low-level hook observes a genuine input event. The helper then runs the vendor
# UIA -> MSAA -> clipboard pipeline against the real focused control.
#
# Two target modes:
#   WinForms  : RichTextBox/TextBox in this process; mouse input runs on a background
#               thread while this script pumps the WinForms message loop.
#   Notepad   : a real Notepad window opened on a temp .txt; geometry is taken from UIA
#               TextPattern bounding rectangles so the drag lands on the first text line.
#
# The target is always placed on a non-primary monitor; if none exists the script refuses
# to open a visible window. All helper JSON Lines and stderr go to <repo>/.tmp-r0-hook/.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File native/selection-helper/test/real-selection.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File native/selection-helper/test/real-selection.ps1 -Clipboard
#   powershell -NoProfile -ExecutionPolicy Bypass -File native/selection-helper/test/real-selection.ps1 -Target Notepad -Gesture DoubleClick
#
# Exit codes: 0 selection observed, 1 helper ran but no selection, 2 no secondary monitor,
#   3 helper failed to start, 4 unexpected script error.

[CmdletBinding()]
param(
    [string]$HelperPath,
    [ValidateSet('Drag', 'DoubleClick')]
    [string]$Gesture = 'Drag',
    [ValidateSet('WinForms', 'Notepad')]
    [string]$Target = 'WinForms',
    [switch]$Clipboard,
    [switch]$VerboseEvents,
    [int]$TimeoutMs = 15000,
    [string]$OutDir
)

$ErrorActionPreference = 'Stop'

$testDir = $PSScriptRoot
$helperRoot = Split-Path -Parent $testDir
$repoRoot = Split-Path -Parent (Split-Path -Parent $helperRoot)
if (-not $HelperPath) { $HelperPath = Join-Path $helperRoot 'bin\selection-helper.exe' }
if (-not $OutDir) { $OutDir = Join-Path $repoRoot '.tmp-r0-hook' }
if (-not (Test-Path $HelperPath)) { throw "helper binary not found: $HelperPath (run build.ps1 first)" }

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$tag = ('{0}-{1}-{2}' -f $Target.ToLower(), $Gesture.ToLower(), $(if ($Clipboard) { 'clipboard' } else { 'uia' }))
$stdoutPath = Join-Path $OutDir "real-selection-$tag.jsonl"
$stderrPath = Join-Path $OutDir "real-selection-$tag.err.log"
Remove-Item $stdoutPath, $stderrPath -ErrorAction SilentlyContinue

$nativeSource = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class R0Native
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MONITORINFO
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
    }

    public delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdc, ref RECT rect, IntPtr data);

    [DllImport("user32.dll")]
    public static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc proc, IntPtr data);
    [DllImport("user32.dll")]
    public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO info);
    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")]
    public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")]
    public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")]
    public static extern bool MoveWindow(IntPtr hwnd, int x, int y, int width, int height, bool repaint);
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);

    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;

    public static List<MONITORINFO> Monitors()
    {
        var result = new List<MONITORINFO>();
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate (IntPtr h, IntPtr hdc, ref RECT r, IntPtr d)
        {
            var info = new MONITORINFO();
            info.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
            if (GetMonitorInfo(h, ref info)) { result.Add(info); }
            return true;
        }, IntPtr.Zero);
        return result;
    }

    public static void ClickDrag(int x1, int y1, int x2, int y2, int steps)
    {
        SetCursorPos(x1, y1);
        System.Threading.Thread.Sleep(180);
        mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
        System.Threading.Thread.Sleep(100);
        for (int i = 1; i <= steps; i++)
        {
            int x = x1 + (x2 - x1) * i / steps;
            int y = y1 + (y2 - y1) * i / steps;
            SetCursorPos(x, y);
            System.Threading.Thread.Sleep(25);
        }
        System.Threading.Thread.Sleep(100);
        mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
    }

    public static void DoubleClick(int x, int y)
    {
        SetCursorPos(x, y);
        System.Threading.Thread.Sleep(180);
        mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
        mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
        System.Threading.Thread.Sleep(120);
        mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
        mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
    }

    public static System.Threading.Thread StartClickDrag(int x1, int y1, int x2, int y2, int steps)
    {
        var thread = new System.Threading.Thread(delegate () { ClickDrag(x1, y1, x2, y2, steps); });
        thread.IsBackground = true;
        thread.Start();
        return thread;
    }

    public static System.Threading.Thread StartDoubleClick(int x, int y)
    {
        var thread = new System.Threading.Thread(delegate () { DoubleClick(x, y); });
        thread.IsBackground = true;
        thread.Start();
        return thread;
    }
}
'@
Add-Type -TypeDefinition $nativeSource -Language CSharp

try { Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop } catch { }
try { Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop } catch { }
$uiaAvailable = $null -ne ('System.Windows.Automation.AutomationElement' -as [type])

# Per-monitor-v2 awareness so PointToScreen / SetCursorPos use physical pixels on the
# mixed-DPI secondary monitor. Failure is non-fatal (may already be asserted).
try { [void][R0Native]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch { }

function Get-UiaControlsSummary {
    # Best-effort provider capability report for the currently focused element. This is
    # diagnostic only: the helper process uses its own CUIAutomation client.
    if (-not $uiaAvailable) { return 'UIA assemblies unavailable in driver' }
    try {
        $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
        if (-not $focused) { return 'no focused UIA element' }
        $parts = @()
        $parts += ('controlType=' + $focused.Current.ControlType.ProgrammaticName)
        $parts += ('name=' + $focused.Current.Name)
        try {
            $parts += ('textPattern=' + $focused.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::IsTextPatternAvailableProperty))
        } catch { $parts += 'textPattern=unknown' }
        return ($parts -join ' ')
    } catch {
        return ('UIA probe failed: ' + $_.Exception.Message)
    }
}

function Get-UiaDocumentRange {
    param($windowElement)
    $condition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::IsTextPatternAvailableProperty, $true)
    $document = $windowElement.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
    if (-not $document) { return $null }
    $pattern = $document.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
    if (-not $pattern) { return $null }
    return $pattern.DocumentRange
}

$form = $null
$helper = $null
$notepadProcess = $null
$tempFile = $null
$exitCode = 4
try {
    $monitors = [R0Native]::Monitors()
    $secondary = $monitors | Where-Object { ($_.dwFlags -band 1) -eq 0 } | Select-Object -First 1
    if (-not $secondary) {
        Write-Host 'SKIP: no secondary monitor; refusing to open a visible test window on the primary display.'
        exit 2
    }
    $left = $secondary.rcMonitor.Left
    $top = $secondary.rcMonitor.Top
    $width = $secondary.rcMonitor.Right - $left
    $height = $secondary.rcMonitor.Bottom - $top
    Write-Host ("target monitor: ({0},{1}) {2}x{3}" -f $left, $top, $width, $height)

    $windowLeft = $left + 120
    $windowTop = $top + 180
    $gestureX1 = 0; $gestureY1 = 0; $gestureX2 = 0; $gestureY2 = 0
    $targetDescription = ''

    if ($Target -eq 'Notepad') {
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        $tempFile = Join-Path $OutDir 'real-selection-target.txt'
        Set-Content -Path $tempFile -Encoding UTF8 -Value @(
            'R0-04 selection helper probe line one',
            'second line has several words to choose',
            'third line must stay unselected'
        )
        $before = @(Get-Process notepad -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
        $started = Start-Process -FilePath 'notepad.exe' -ArgumentList ('"{0}"' -f $tempFile) -PassThru
        $notepadProcess = $null
        $deadline = (Get-Date).AddSeconds(10)
        while ((Get-Date) -lt $deadline) {
            $candidates = @(Get-Process notepad -ErrorAction SilentlyContinue | Where-Object { $before -notcontains $_.Id -and $_.MainWindowHandle -ne 0 })
            if ($candidates.Count -gt 0) { $notepadProcess = $candidates[0]; break }
            Start-Sleep -Milliseconds 150
        }
        if (-not $notepadProcess) { throw 'Notepad window did not appear' }
        $hwnd = $notepadProcess.MainWindowHandle
        [void][R0Native]::MoveWindow($hwnd, $windowLeft, $windowTop, 900, 620, $true)
        [void][R0Native]::SetForegroundWindow($hwnd)
        Start-Sleep -Milliseconds 800
        $targetDescription = ('notepad pid={0} hwnd=0x{1:x}' -f $notepadProcess.Id, [int64]$hwnd)

        # Derive the first text line from UIA TextPattern bounding rectangles so the drag
        # lands on real text instead of relying on hard-coded Notepad chrome offsets.
        $range = $null
        if ($uiaAvailable) {
            try {
                $windowElement = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
                $range = Get-UiaDocumentRange -windowElement $windowElement
            } catch { Write-Host ("UIA document probe failed: {0}" -f $_.Exception.Message) }
        }
        $rects = $null
        if ($range) { try { $rects = $range.GetBoundingRectangles() } catch { } }
        if ($rects -and $rects.Count -ge 4 -and $rects[2] -gt 20) {
            $rx = [int]$rects[0]; $ry = [int]$rects[1]; $rw = [int]$rects[2]; $rh = [int]$rects[3]
            Write-Host ("UIA first-line rect: ({0},{1}) {2}x{3}" -f $rx, $ry, $rw, $rh)
            $gestureX1 = $rx + 6
            $gestureY1 = $ry + [int]($rh / 2)
            $gestureX2 = $rx + [Math]::Min($rw - 8, 320)
            $gestureY2 = $gestureY1
        } else {
            # Geometry fallback: Notepad edit area near the top-left of the client area.
            Write-Host 'UIA rect unavailable; using fixed offset geometry'
            $gestureX1 = $windowLeft + 40
            $gestureY1 = $windowTop + 110
            $gestureX2 = $windowLeft + 360
            $gestureY2 = $gestureY1
        }
        Write-Host ('UIA focused control before gesture: ' + (Get-UiaControlsSummary))
    } else {
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        [System.Windows.Forms.Application]::EnableVisualStyles()

        $form = New-Object System.Windows.Forms.Form
        $form.Text = 'R0-04 real selection probe'
        $form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::None
        $form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
        $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedSingle
        $form.ClientSize = New-Object System.Drawing.Size(760, 320)
        $form.Location = New-Object System.Drawing.Point($windowLeft, $windowTop)

        if ($Target -eq 'WinForms') { $textBox = New-Object System.Windows.Forms.RichTextBox }
        $textBox.Dock = [System.Windows.Forms.DockStyle]::Fill
        $textBox.Font = New-Object System.Drawing.Font('Consolas', 18)
        $textBox.Text = "R0-04 selection helper probe line one`r`nsecond line has several words to choose`r`nthird line must stay unselected"
        $form.Controls.Add($textBox)

        $form.Add_Shown({
            $form.Activate()
            [void][R0Native]::SetForegroundWindow($form.Handle)
        })
        $form.Show()
        [System.Windows.Forms.Application]::DoEvents()
        Start-Sleep -Milliseconds 500
        if (-not $form.Focused) {
            $form.Activate()
            [void][R0Native]::SetForegroundWindow($form.Handle)
            [System.Windows.Forms.Application]::DoEvents()
            Start-Sleep -Milliseconds 200
        }
        if ($form.Location.X -lt $left) { throw "test window left the secondary monitor: $($form.Location)" }
        $targetDescription = ('winforms richtextbox hwnd=0x{0:x}' -f [int64]$form.Handle)
        $gestureX1 = $textBox.PointToScreen((New-Object System.Drawing.Point(6, 12))).X
        $gestureY1 = $textBox.PointToScreen((New-Object System.Drawing.Point(6, 12))).Y
        $gestureX2 = $textBox.PointToScreen((New-Object System.Drawing.Point(($textBox.ClientSize.Width - 24), 12))).X
        $gestureY2 = $gestureY1
    }

    Write-Host ("target: {0}" -f $targetDescription)

    # Start the helper and wait for its explicit ready beacon in the redirected stdout.
    $arguments = @('--duration-ms', "$TimeoutMs", '--exit-after-selection')
    if ($Clipboard) { $arguments += '--clipboard' }
    if ($VerboseEvents) { $arguments += @('--mouse-events', '--keyboard-events') }
    $helper = Start-Process -FilePath $HelperPath -ArgumentList $arguments -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
    $readyDeadline = (Get-Date).AddSeconds(10)
    $ready = $false
    while ((Get-Date) -lt $readyDeadline) {
        if (Test-Path $stdoutPath) {
            $content = Get-Content -Raw $stdoutPath -ErrorAction SilentlyContinue
            if ($content -and $content.Contains('"status":"started"')) { $ready = $true; break }
        }
        if ($helper.HasExited) { break }
        Start-Sleep -Milliseconds 100
    }
    if (-not $ready) { throw "helper did not report status:started (exited=$($helper.HasExited))" }

    # Real gesture. For the WinForms target the input thread lets this process keep
    # pumping messages; for Notepad the target has its own message loop.
    if ($Gesture -eq 'DoubleClick') {
        $clickX = [int](($gestureX1 + $gestureX2) / 2)
        $clickX = $gestureX1 + 20
        Write-Host ("double-click at ({0},{1})" -f $clickX, $gestureY1)
        $inputThread = [R0Native]::StartDoubleClick($clickX, $gestureY1)
    } else {
        Write-Host ("drag from ({0},{1}) to ({2},{3})" -f $gestureX1, $gestureY1, $gestureX2, $gestureY2)
        $inputThread = [R0Native]::StartClickDrag($gestureX1, $gestureY1, $gestureX2, $gestureY2, 12)
    }
    if ($form) {
        while (-not $inputThread.Join(40)) { [System.Windows.Forms.Application]::DoEvents() }
        $pumpDeadline = (Get-Date).AddMilliseconds(600)
        while ((Get-Date) -lt $pumpDeadline) {
            [System.Windows.Forms.Application]::DoEvents()
            Start-Sleep -Milliseconds 20
        }
        Write-Host ("target control SelectedText: {0} chars" -f ([string]$textBox.SelectedText).Length)
    } else {
        [void]$inputThread.Join(8000)
    }

    Write-Host ('UIA focused control after gesture: ' + (Get-UiaControlsSummary))

    if (-not $helper.WaitForExit($TimeoutMs + 5000)) {
        Write-Host 'helper did not exit in time; killing for cleanup'
        try { $helper.Kill() } catch { }
        $helper.WaitForExit(3000) | Out-Null
    }
    Start-Sleep -Milliseconds 200
    try { $helper.Refresh() } catch { }
    $helperExit = $null
    if ($helper.HasExited) { try { $helperExit = $helper.ExitCode } catch { } }

    $lines = @()
    if (Test-Path $stdoutPath) { $lines = Get-Content $stdoutPath }
    $selectionLines = @($lines | Where-Object { $_ -match '"type":"text-selection"' })
    $foundLines = @($selectionLines | Where-Object { $_ -match '"found":true' })
    if ($null -eq $helperExit) {
        $stoppedLine = $lines | Where-Object { $_ -match '"status":"stopped"' } | Select-Object -Last 1
        if ($stoppedLine -and $stoppedLine -match '"exitCode":(-?\d+)') { $helperExit = [int]$Matches[1] }
    }

    Write-Host ''
    Write-Host '--- helper events ---'
    foreach ($line in $lines) { Write-Host $line }
    Write-Host ''
    Write-Host ("helper exit code: {0}" -f $helperExit)
    Write-Host ("selection events: {0}, found=true: {1}" -f $selectionLines.Count, $foundLines.Count)

    if ($foundLines.Count -gt 0) {
        $exitCode = 0
        Write-Host 'RESULT: PASS (real text selection observed; see evidence files)'
    } else {
        $exitCode = 1
        Write-Host 'RESULT: FAIL (helper ran but no text selection was observed)'
    }
} catch {
    Write-Host ("ERROR: {0}" -f $_.Exception.Message)
    $exitCode = 4
} finally {
    if ($helper -and -not $helper.HasExited) {
        try { $helper.Kill(); $helper.WaitForExit(3000) | Out-Null } catch { }
    }
    if ($form) {
        try { $form.Close(); $form.Dispose() } catch { }
    }
    if ($notepadProcess) {
        try { Stop-Process -Id $notepadProcess.Id -Force -ErrorAction SilentlyContinue } catch { }
    }
    if ($form) { [System.Windows.Forms.Application]::Exit() }
}

Write-Host ("evidence: {0} / {1}" -f $stdoutPath, $stderrPath)
exit $exitCode
