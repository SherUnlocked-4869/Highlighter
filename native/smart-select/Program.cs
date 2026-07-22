using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows;
using System.Windows.Automation;

internal static class Program
{
    private const int DwmwaExtendedFrameBounds = 9;
    private const int DwmwaCloaked = 14;
    private const long WsExTransparent = 0x00000020L;
    private const long WsExToolWindow = 0x00000080L;
    private const long WsExNoActivate = 0x08000000L;
    private static readonly List<WindowEntry> Windows = new List<WindowEntry>();
    private static readonly TreeWalker Walker = TreeWalker.ContentViewWalker;
    private static StreamWriter output;

    [STAThread]
    private static void Main()
    {
        EnablePerMonitorDpiAwareness();
        output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
        output.AutoFlush = true;
        LoadWindows();
        WriteReady();

        string line;
        while ((line = Console.ReadLine()) != null)
        {
            string[] parts = line.Trim().Split(new[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length == 1 && parts[0] == "quit") break;
            if (parts.Length != 3) continue;

            int id;
            int x;
            int y;
            if (!int.TryParse(parts[0], NumberStyles.Integer, CultureInfo.InvariantCulture, out id) ||
                !int.TryParse(parts[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out x) ||
                !int.TryParse(parts[2], NumberStyles.Integer, CultureInfo.InvariantCulture, out y))
            {
                continue;
            }

            WriteResult(id, HitTest(x, y));
        }
    }

    private static void EnablePerMonitorDpiAwareness()
    {
        try
        {
            if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return;
        }
        catch (EntryPointNotFoundException) {}
        catch (DllNotFoundException) {}

        try { SetProcessDPIAware(); } catch {}
    }

    private static void LoadWindows()
    {
        int ownProcessId = Process.GetCurrentProcess().Id;
        EnumWindows(delegate(IntPtr handle, IntPtr state)
        {
            if (!IsWindowVisible(handle) || IsIconic(handle)) return true;
            int titleLength = GetWindowTextLength(handle);
            if (titleLength <= 0) return true;
            StringBuilder titleBuilder = new StringBuilder(titleLength + 1);
            GetWindowText(handle, titleBuilder, titleBuilder.Capacity);
            string title = titleBuilder.ToString();
            if (title == "Program Manager" || title == "Windows Input Experience" || title == "Windows 输入体验") return true;

            long extendedStyle = GetWindowLongPtr(handle, -20).ToInt64();
            if ((extendedStyle & (WsExTransparent | WsExToolWindow | WsExNoActivate)) != 0) return true;

            uint processId;
            GetWindowThreadProcessId(handle, out processId);
            if (processId == ownProcessId) return true;

            int cloaked = 0;
            if (DwmGetWindowAttribute(handle, DwmwaCloaked, out cloaked, Marshal.SizeOf(typeof(int))) == 0 && cloaked != 0)
            {
                return true;
            }

            RectData frame = GetFrameRect(handle);
            if (!frame.IsValid) return true;
            RectData client = GetClientRectOnScreen(handle);
            Windows.Add(new WindowEntry(handle, frame, client.IsValid ? client : frame));
            return true;
        }, IntPtr.Zero);
    }

    private static List<RectData> HitTest(int x, int y)
    {
        WindowEntry window = null;
        for (int index = 0; index < Windows.Count; index++)
        {
            if (Windows[index].Frame.Contains(x, y))
            {
                window = Windows[index];
                break;
            }
        }

        if (window == null) return new List<RectData>();

        List<RectData> path = new List<RectData>();
        AddDistinct(path, window.Frame);
        if (window.Client.Contains(x, y)) AddDistinct(path, window.Client);

        try
        {
            AutomationElement current = AutomationElement.FromHandle(window.Handle);
            for (int depth = 0; current != null && depth < 32; depth++)
            {
                AutomationElement child = FindContainingChild(current, x, y, window.Frame);
                if (child == null) break;
                RectData rect = GetElementRect(child).Intersect(window.Frame);
                if (!rect.IsValid || !rect.Contains(x, y)) break;
                AddDistinct(path, rect);
                current = child;
            }
        }
        catch {}

        path.Reverse();
        return path;
    }

    private static AutomationElement FindContainingChild(AutomationElement parent, int x, int y, RectData windowRect)
    {
        AutomationElement child;
        try { child = Walker.GetFirstChild(parent); }
        catch { return null; }

        AutomationElement best = null;
        long bestArea = long.MaxValue;
        int visited = 0;
        while (child != null && visited++ < 1024)
        {
            try
            {
                bool offscreen = false;
                try { offscreen = child.Current.IsOffscreen; } catch {}
                if (!offscreen)
                {
                    RectData rect = GetElementRect(child).Intersect(windowRect);
                    if (rect.IsValid && rect.Contains(x, y) && rect.Area < bestArea)
                    {
                        best = child;
                        bestArea = rect.Area;
                    }
                }
            }
            catch {}

            try { child = Walker.GetNextSibling(child); }
            catch { child = null; }
        }
        return best;
    }

    private static RectData GetElementRect(AutomationElement element)
    {
        try
        {
            Rect rect = element.Current.BoundingRectangle;
            return new RectData(
                (int)Math.Floor(rect.Left),
                (int)Math.Floor(rect.Top),
                (int)Math.Ceiling(rect.Right),
                (int)Math.Ceiling(rect.Bottom));
        }
        catch { return RectData.Empty; }
    }

    private static RectData GetFrameRect(IntPtr handle)
    {
        NativeRect rect;
        if (DwmGetWindowAttribute(handle, DwmwaExtendedFrameBounds, out rect, Marshal.SizeOf(typeof(NativeRect))) != 0)
        {
            if (!GetWindowRect(handle, out rect)) return RectData.Empty;
        }
        return new RectData(rect.Left, rect.Top, rect.Right, rect.Bottom);
    }

    private static RectData GetClientRectOnScreen(IntPtr handle)
    {
        NativeRect rect;
        NativePoint point = new NativePoint();
        if (!GetClientRect(handle, out rect) || !ClientToScreen(handle, ref point)) return RectData.Empty;
        return new RectData(point.X, point.Y, point.X + rect.Right - rect.Left, point.Y + rect.Bottom - rect.Top);
    }

    private static void AddDistinct(List<RectData> rects, RectData rect)
    {
        if (!rect.IsValid) return;
        for (int index = 0; index < rects.Count; index++)
        {
            if (rects[index].Equals(rect)) return;
        }
        rects.Add(rect);
    }

    private static void WriteReady()
    {
        StringBuilder json = new StringBuilder();
        json.Append("{\"ready\":true,\"windows\":[");
        for (int index = 0; index < Windows.Count; index++)
        {
            if (index > 0) json.Append(',');
            AppendRect(json, Windows[index].Frame);
        }
        json.Append("]}");
        output.WriteLine(json.ToString());
    }

    private static void WriteResult(int id, List<RectData> rects)
    {
        StringBuilder json = new StringBuilder();
        json.Append("{\"id\":").Append(id).Append(",\"rects\":[");
        for (int index = 0; index < rects.Count; index++)
        {
            if (index > 0) json.Append(',');
            AppendRect(json, rects[index]);
        }
        json.Append("]}");
        output.WriteLine(json.ToString());
    }

    private static void AppendRect(StringBuilder json, RectData rect)
    {
        json.Append("{\"left\":").Append(rect.Left)
            .Append(",\"top\":").Append(rect.Top)
            .Append(",\"right\":").Append(rect.Right)
            .Append(",\"bottom\":").Append(rect.Bottom).Append('}');
    }

    private sealed class WindowEntry
    {
        internal readonly IntPtr Handle;
        internal readonly RectData Frame;
        internal readonly RectData Client;

        internal WindowEntry(IntPtr handle, RectData frame, RectData client)
        {
            Handle = handle;
            Frame = frame;
            Client = client;
        }
    }

    private struct RectData
    {
        internal static readonly RectData Empty = new RectData(0, 0, 0, 0);
        internal readonly int Left;
        internal readonly int Top;
        internal readonly int Right;
        internal readonly int Bottom;
        internal bool IsValid { get { return Right - Left > 2 && Bottom - Top > 2; } }
        internal long Area { get { return (long)(Right - Left) * (Bottom - Top); } }

        internal RectData(int left, int top, int right, int bottom)
        {
            Left = Math.Min(left, right);
            Top = Math.Min(top, bottom);
            Right = Math.Max(left, right);
            Bottom = Math.Max(top, bottom);
        }

        internal bool Contains(int x, int y)
        {
            return x >= Left && x <= Right && y >= Top && y <= Bottom;
        }

        internal RectData Intersect(RectData other)
        {
            int left = Math.Max(Left, other.Left);
            int top = Math.Max(Top, other.Top);
            int right = Math.Min(Right, other.Right);
            int bottom = Math.Min(Bottom, other.Bottom);
            return right > left && bottom > top ? new RectData(left, top, right, bottom) : Empty;
        }

        public override bool Equals(object value)
        {
            if (!(value is RectData)) return false;
            RectData other = (RectData)value;
            return Left == other.Left && Top == other.Top && Right == other.Right && Bottom == other.Bottom;
        }

        public override int GetHashCode()
        {
            return Left ^ (Top << 7) ^ (Right << 13) ^ (Bottom << 19);
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeRect { internal int Left; internal int Top; internal int Right; internal int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    private struct NativePoint { internal int X; internal int Y; }

    private delegate bool EnumWindowsCallback(IntPtr handle, IntPtr state);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr state);
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr handle);
    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr handle, out NativeRect rect);
    [DllImport("user32.dll")]
    private static extern bool GetClientRect(IntPtr handle, out NativeRect rect);
    [DllImport("user32.dll")]
    private static extern bool ClientToScreen(IntPtr handle, ref NativePoint point);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextLength(IntPtr handle);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr handle, StringBuilder text, int count);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    private static extern IntPtr GetWindowLongPtr(IntPtr handle, int index);
    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("dwmapi.dll")]
    private static extern int DwmGetWindowAttribute(IntPtr handle, int attribute, out NativeRect value, int size);
    [DllImport("dwmapi.dll")]
    private static extern int DwmGetWindowAttribute(IntPtr handle, int attribute, out int value, int size);
}
