# R0-05a unattended evidence: capture the whole virtual desktop in physical pixels.
# Read-only: does not inject into or affect the window under test.
# Sets the calling thread to per-monitor DPI aware v2 so GetSystemMetrics/CopyFromScreen
# use physical pixels (otherwise 125%/150% displays are DPI-virtualized).
#
# Usage (repo root):
#   powershell -NoProfile -ExecutionPolicy Bypass -File rust-app/prototypes/webview-media/tools/capture-screen.ps1 -Out .tmp-r0-media-webview/screenshots/x.png
param(
    [string]$Out = ".tmp-r0-media-webview/screenshots/virtual-screen.png"
)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class R0MediaDpi {
    [DllImport("user32.dll")]
    public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int index);
}
"@ | Out-Null

# DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4
[R0MediaDpi]::SetThreadDpiAwarenessContext([IntPtr](-4)) | Out-Null

$x = [R0MediaDpi]::GetSystemMetrics(76) # SM_XVIRTUALSCREEN
$y = [R0MediaDpi]::GetSystemMetrics(77) # SM_YVIRTUALSCREEN
$w = [R0MediaDpi]::GetSystemMetrics(78) # SM_CXVIRTUALSCREEN
$h = [R0MediaDpi]::GetSystemMetrics(79) # SM_CYVIRTUALSCREEN
Write-Output "virtual-screen physical: x=$x y=$y w=$w h=$h"

Add-Type -AssemblyName System.Drawing
$full = [System.IO.Path]::GetFullPath($Out)
$directory = [System.IO.Path]::GetDirectoryName($full)
if (-not (Test-Path -LiteralPath $directory)) {
    New-Item -ItemType Directory -Path $directory | Out-Null
}

$bitmap = New-Object System.Drawing.Bitmap($w, $h)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
    $graphics.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size($w, $h)), [System.Drawing.CopyPixelOperation]::SourceCopy)
    $bitmap.Save($full, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Output "saved: $full"
} finally {
    $graphics.Dispose()
    $bitmap.Dispose()
}
