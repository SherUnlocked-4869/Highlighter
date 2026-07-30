param(
  [Parameter(Mandatory = $true)]
  [string]$ProcessName,
  [int]$SettleMilliseconds = 300,
  [string]$PreviousProcessName = '',
  [switch]$RestorePrevious
)

$ErrorActionPreference = 'Stop'

$nativeSource = @'
using System;
using System.Runtime.InteropServices;
using System.Threading;

public static class CopyWindowProbeNative
{
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool ShowWindowAsync(IntPtr window, int command);

    [DllImport("user32.dll")]
    private static extern void keybd_event(byte virtualKey, byte scanCode, uint flags, UIntPtr extraInfo);

    private const uint KeyUp = 0x0002;
    private const ushort VkControl = 0x11;
    private const ushort VkMenu = 0x12;
    private const ushort VkA = 0x41;
    private const ushort VkC = 0x43;
    private const int ShowRestore = 9;

    private static void Chord(ushort key)
    {
        keybd_event((byte)VkControl, 0, 0, UIntPtr.Zero);
        keybd_event((byte)key, 0, 0, UIntPtr.Zero);
        keybd_event((byte)key, 0, KeyUp, UIntPtr.Zero);
        keybd_event((byte)VkControl, 0, KeyUp, UIntPtr.Zero);
    }

    public static IntPtr CopyAll(IntPtr targetWindow, int settleMilliseconds, bool restorePrevious)
    {
        var previousWindow = GetForegroundWindow();
        ShowWindowAsync(targetWindow, ShowRestore);
        if (!SetForegroundWindow(targetWindow))
        {
            throw new InvalidOperationException("Could not activate the target window.");
        }

        try
        {
            Thread.Sleep(settleMilliseconds);
            Chord(VkA);
            Thread.Sleep(100);
            Chord(VkC);
            Thread.Sleep(settleMilliseconds);
        }
        finally
        {
            if (restorePrevious && previousWindow != IntPtr.Zero && previousWindow != targetWindow)
            {
                SetForegroundWindow(previousWindow);
            }
        }
        return previousWindow;
    }

    public static void Activate(IntPtr targetWindow, int settleMilliseconds)
    {
        keybd_event((byte)VkMenu, 0, 0, UIntPtr.Zero);
        keybd_event((byte)VkMenu, 0, KeyUp, UIntPtr.Zero);
        ShowWindowAsync(targetWindow, ShowRestore);
        if (!SetForegroundWindow(targetWindow))
        {
            throw new InvalidOperationException("Could not activate the requested previous window.");
        }
        Thread.Sleep(settleMilliseconds);
    }
}
'@

Add-Type -TypeDefinition $nativeSource -Language CSharp

$targets = @(Get-Process -Name $ProcessName -ErrorAction Stop | Where-Object { $_.MainWindowHandle -ne 0 })
if ($targets.Count -ne 1) {
  throw "Expected exactly one $ProcessName process with a main window, found $($targets.Count)."
}

if ($PreviousProcessName) {
  $previousTargets = @(Get-Process -Name $PreviousProcessName -ErrorAction Stop | Where-Object { $_.MainWindowHandle -ne 0 })
  if ($previousTargets.Count -ne 1) {
    throw "Expected exactly one $PreviousProcessName process with a main window, found $($previousTargets.Count)."
  }
  [CopyWindowProbeNative]::Activate($previousTargets[0].MainWindowHandle, $SettleMilliseconds)
}

$previousWindow = [CopyWindowProbeNative]::CopyAll($targets[0].MainWindowHandle, $SettleMilliseconds, $RestorePrevious.IsPresent)
[pscustomobject]@{
  processName = $targets[0].ProcessName
  processId = $targets[0].Id
  windowTitle = $targets[0].MainWindowTitle
  previousWindow = "0x$($previousWindow.ToInt64().ToString('X'))"
  restoredPrevious = $RestorePrevious.IsPresent
} | ConvertTo-Json -Compress
