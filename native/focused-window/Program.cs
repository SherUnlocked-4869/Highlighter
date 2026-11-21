using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

public static class FocusedWindowCapture
{
    [StructLayout(LayoutKind.Sequential)]
    private struct Rect { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] private static extern bool GetWindowDisplayAffinity(IntPtr window, out uint affinity);
    [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out Rect rect, int size);
    [DllImport("user32.dll")] private static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);

    public static void Main()
    {
        IntPtr window = GetForegroundWindow();
        uint affinity;
        bool affinityKnown = GetWindowDisplayAffinity(window, out affinity);
        bool protectedWindow = affinityKnown && affinity != 0;

        // Flush the identity before asking the target to paint. The caller can
        // still match the same window if PrintWindow stalls or the PNG fails.
        Console.Out.WriteLine("{0} {1}", window.ToInt64(), protectedWindow ? "protected" : "window");
        Console.Out.Flush();
        if (window == IntPtr.Zero || !affinityKnown || protectedWindow ||
            !IsWindowVisible(window) || IsIconic(window)) return;

        IntPtr previousDpi = SetThreadDpiAwarenessContext(new IntPtr(-4));
        if (previousDpi == IntPtr.Zero) return;
        try
        {
            Rect bounds;
            if (!GetWindowRect(window, out bounds)) return;
            int width = bounds.Right - bounds.Left;
            int height = bounds.Bottom - bounds.Top;
            if (width <= 0 || height <= 0 || (long)width * height > 16777216) return;

            Rectangle crop = new Rectangle(0, 0, width, height);
            Rect frame;
            if (DwmGetWindowAttribute(window, 9, out frame, Marshal.SizeOf(typeof(Rect))) == 0)
            {
                Rectangle visible = Rectangle.FromLTRB(
                    frame.Left - bounds.Left, frame.Top - bounds.Top,
                    frame.Right - bounds.Left, frame.Bottom - bounds.Top);
                if (visible.Width > 0 && visible.Height > 0 && crop.Contains(visible)) crop = visible;
            }

            using (Bitmap bitmap = new Bitmap(width, height, PixelFormat.Format32bppRgb))
            {
                using (Graphics graphics = Graphics.FromImage(bitmap))
                {
                    IntPtr dc = graphics.GetHdc();
                    try { if (!PrintWindow(window, dc, 2)) return; }
                    finally { graphics.ReleaseHdc(dc); }
                }
                Rect after;
                if (!GetWindowRect(window, out after) || after.Right - after.Left != width ||
                    after.Bottom - after.Top != height ||
                    !GetWindowDisplayAffinity(window, out affinity) || affinity != 0) return;

                double scale = Math.Min(1, Math.Min(1920.0 / crop.Width, 1080.0 / crop.Height));
                int outputWidth = Math.Max(1, (int)Math.Round(crop.Width * scale));
                int outputHeight = Math.Max(1, (int)Math.Round(crop.Height * scale));
                using (Bitmap output = new Bitmap(outputWidth, outputHeight, PixelFormat.Format32bppRgb))
                {
                    using (Graphics graphics = Graphics.FromImage(output))
                    {
                        graphics.InterpolationMode = scale < 1 ? InterpolationMode.HighQualityBicubic : InterpolationMode.NearestNeighbor;
                        graphics.DrawImage(bitmap, new Rectangle(0, 0, outputWidth, outputHeight), crop, GraphicsUnit.Pixel);
                    }
                    using (MemoryStream encoded = new MemoryStream())
                    {
                        output.Save(encoded, ImageFormat.Png);
                        encoded.Position = 0;
                        Stream stdout = Console.OpenStandardOutput();
                        encoded.CopyTo(stdout);
                        stdout.Flush();
                    }
                }
            }
        }
        finally
        {
            SetThreadDpiAwarenessContext(previousDpi);
        }
    }
}
