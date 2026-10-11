using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
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
    // P0-2-T1：光标采集常量。
    private const int CursorShowing = 0x00000001;
    private const int DiNormal = 0x0003;
    private const int SmCxCursor = 13;
    private const int SmCyCursor = 14;
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

            // P0-2-T1：`cursor`（可选带请求 id）与既有的 `id x y` 查询共用同一条行协议。
            // 带 id 时响应回带同一个 id，调用方可以直接复用各自的 pending 分发；
            // 不带 id 时响应省略 id 字段（仍可被 "cursor":true 识别）。
            // 这里**不得**改动 `id x y` 分支与 ready 输出的既有语义。
            if (parts.Length > 0 && parts[0] == "cursor")
            {
                int cursorId = -1;
                if (parts.Length == 2)
                {
                    // 解析失败时 TryParse 会把 out 参数清 0，而 0 是合法 id —— 必须显式回到 -1，
                    // 否则 `cursor abc` 会回一个 "id":0，与"不带 id 则省略该字段"的约定矛盾。
                    if (!int.TryParse(parts[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out cursorId))
                    {
                        cursorId = -1;
                    }
                }
                WriteCursor(cursorId);
                continue;
            }

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

    // ---------------------------------------------------------------------
    // P0-2-T1 光标采集（`cursor` 命令）
    //
    // 坐标系：本进程是 PER_MONITOR_AWARE_V2（见 EnablePerMonitorDpiAwareness），
    // 因此 GetCursorInfo 的 ptScreenPos、GetIconInfo 的热点、以及导出的位图
    // 全部是**物理像素**（虚拟桌面物理坐标，副屏可为负）。
    //
    // 资源所有权：GetCursorInfo 交回的 hCursor 是系统共享句柄，**不可** DestroyIcon；
    // GetIconInfo 产生的 hbmColor / hbmMask 归调用方所有，**必须** DeleteObject，
    // 否则每轮询一次就泄漏 1–2 个 GDI 对象（长时间截图会话会拖垮进程）。
    // ---------------------------------------------------------------------
    private static void WriteCursor(int id)
    {
        CursorSnapshot snapshot = null;
        try
        {
            snapshot = CaptureCursor();
        }
        catch
        {
            snapshot = null;
        }

        StringBuilder json = new StringBuilder();
        json.Append('{');
        if (id >= 0) json.Append("\"id\":").Append(id).Append(',');
        json.Append("\"cursor\":true,\"showing\":").Append(snapshot != null ? "true" : "false");
        if (snapshot != null)
        {
            json.Append(",\"x\":").Append(snapshot.X)
                .Append(",\"y\":").Append(snapshot.Y)
                .Append(",\"hotspotX\":").Append(snapshot.HotspotX)
                .Append(",\"hotspotY\":").Append(snapshot.HotspotY)
                .Append(",\"width\":").Append(snapshot.Width)
                .Append(",\"height\":").Append(snapshot.Height)
                .Append(",\"png\":\"").Append(snapshot.PngBase64).Append('"');
        }
        json.Append('}');
        output.WriteLine(json.ToString());
    }

    private static CursorSnapshot CaptureCursor()
    {
        CursorInfo info = new CursorInfo();
        info.Size = Marshal.SizeOf(typeof(CursorInfo));
        if (!GetCursorInfo(ref info)) return null;
        // CURSOR_SHOWING=0：游戏 / 全屏独占 / 未聚焦时会话根本不画光标，此时不返回光标。
        if ((info.Flags & CursorShowing) == 0) return null;
        if (info.Handle == IntPtr.Zero) return null;

        IconInfo icon = new IconInfo();
        if (!GetIconInfo(info.Handle, out icon)) return null;

        try
        {
            int width = 0;
            int height = 0;
            NativeBitmap bitmap = new NativeBitmap();
            if (icon.Color != IntPtr.Zero &&
                GetObjectW(icon.Color, Marshal.SizeOf(typeof(NativeBitmap)), ref bitmap) != 0)
            {
                width = bitmap.Width;
                height = bitmap.Height;
            }
            // 单色光标没有 color 位图；它的 mask 是 "AND|XOR" 上下叠放，高度要折半。
            if ((width <= 0 || height <= 0) && icon.Mask != IntPtr.Zero)
            {
                NativeBitmap mask = new NativeBitmap();
                if (GetObjectW(icon.Mask, Marshal.SizeOf(typeof(NativeBitmap)), ref mask) != 0)
                {
                    width = mask.Width;
                    height = mask.Height / 2;
                }
            }
            if (width <= 0 || height <= 0)
            {
                width = GetSystemMetrics(SmCxCursor);
                height = GetSystemMetrics(SmCyCursor);
            }
            if (width <= 0) width = 32;
            if (height <= 0) height = 32;

            string png = RenderCursorPng(info.Handle, width, height);
            if (png == null) return null;

            return new CursorSnapshot(info.Position.X, info.Position.Y, icon.HotspotX, icon.HotspotY, width, height, png);
        }
        finally
        {
            // 防泄漏的关键两句：任何提前 return 都会经过这里（hCursor 不在此列）。
            if (icon.Mask != IntPtr.Zero) DeleteObject(icon.Mask);
            if (icon.Color != IntPtr.Zero) DeleteObject(icon.Color);
        }
    }

    private static string RenderCursorPng(IntPtr cursor, int width, int height)
    {
        using (Bitmap bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb))
        {
            using (Graphics graphics = Graphics.FromImage(bitmap))
            {
                graphics.Clear(Color.Transparent);
                IntPtr hdc = graphics.GetHdc();
                try
                {
                    // DI_NORMAL 把光标按 alpha 混合进 32bpp ARGB 的后台缓冲，透明区域保持透明。
                    // （用 Icon.ToBitmap() 会丢掉 alpha，透明处变黑。）
                    // 必须接住返回值：绘制失败时不能产出一张"合法但全空白"的 PNG 并上报 showing:true，
                    // 那会让上层把空白当真实形状缓存、用户"以为抓到光标却什么都没画"。
                    if (!DrawIconEx(hdc, 0, 0, cursor, width, height, 0, IntPtr.Zero, DiNormal))
                    {
                        return null;
                    }
                }
                finally
                {
                    graphics.ReleaseHdc(hdc);
                }
            }

            using (MemoryStream stream = new MemoryStream())
            {
                bitmap.Save(stream, ImageFormat.Png);
                return Convert.ToBase64String(stream.ToArray());
            }
        }
    }

    private sealed class CursorSnapshot
    {
        internal readonly int X;
        internal readonly int Y;
        internal readonly int HotspotX;
        internal readonly int HotspotY;
        internal readonly int Width;
        internal readonly int Height;
        internal readonly string PngBase64;

        internal CursorSnapshot(int x, int y, int hotspotX, int hotspotY, int width, int height, string pngBase64)
        {
            X = x;
            Y = y;
            HotspotX = hotspotX;
            HotspotY = hotspotY;
            Width = width;
            Height = height;
            PngBase64 = pngBase64;
        }
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

    // CURSORINFO：cbSize 必须先赋值，否则 GetCursorInfo 直接失败。
    [StructLayout(LayoutKind.Sequential)]
    private struct CursorInfo
    {
        internal int Size;
        internal int Flags;
        internal IntPtr Handle;
        internal NativePoint Position;
    }

    // ICONINFO：fIcon 是 Win32 BOOL（4 字节），这里用 int 显式固定大小。
    [StructLayout(LayoutKind.Sequential)]
    private struct IconInfo
    {
        internal int IsIcon;
        internal int HotspotX;
        internal int HotspotY;
        internal IntPtr Mask;
        internal IntPtr Color;
    }

    // Win32 BITMAP（x64 下是 32 字节：7 个字段 + 对齐）。
    [StructLayout(LayoutKind.Sequential)]
    private struct NativeBitmap
    {
        internal int Type;
        internal int Width;
        internal int Height;
        internal int WidthBytes;
        internal ushort Planes;
        internal ushort BitsPixel;
        internal IntPtr Bits;
    }

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
    [DllImport("user32.dll")]
    private static extern bool GetCursorInfo(ref CursorInfo info);
    [DllImport("user32.dll")]
    private static extern bool GetIconInfo(IntPtr cursor, out IconInfo info);
    [DllImport("gdi32.dll", EntryPoint = "GetObjectW")]
    private static extern int GetObjectW(IntPtr handle, int size, ref NativeBitmap bitmap);
    [DllImport("gdi32.dll")]
    private static extern bool DeleteObject(IntPtr handle);
    [DllImport("user32.dll")]
    private static extern bool DrawIconEx(IntPtr hdc, int x, int y, IntPtr icon, int width, int height, int step, IntPtr brush, int flags);
    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int index);
}
