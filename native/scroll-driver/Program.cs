using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

internal static class Program
{
    private const uint WmMouseWheel = 0x020A;
    private const uint SmtoAbortIfHung = 0x0002;
    private const uint CwpSkipInvisible = 0x0001;
    private const uint CwpSkipDisabled = 0x0002;
    private const uint CwpSkipTransparent = 0x0004;
    private const long WsExTransparent = 0x00000020L;
    private static StreamWriter output;

    private static void Main()
    {
        EnablePerMonitorDpiAwareness();
        output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
        output.AutoFlush = true;
        output.WriteLine("{\"ready\":true}");

        string line;
        while ((line = Console.ReadLine()) != null)
        {
            string[] parts = line.Trim().Split(new[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length == 1 && parts[0] == "quit") break;
            if (parts.Length != 7) continue;

            int id;
            int x;
            int y;
            int delta;
            long expectedRoot;
            uint excludedProcessId;
            if (!int.TryParse(parts[0], NumberStyles.Integer, CultureInfo.InvariantCulture, out id) ||
                !int.TryParse(parts[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out x) ||
                !int.TryParse(parts[2], NumberStyles.Integer, CultureInfo.InvariantCulture, out y) ||
                !int.TryParse(parts[3], NumberStyles.Integer, CultureInfo.InvariantCulture, out delta) ||
                !long.TryParse(parts[4], NumberStyles.Integer, CultureInfo.InvariantCulture, out expectedRoot) ||
                !uint.TryParse(parts[5], NumberStyles.Integer, CultureInfo.InvariantCulture, out excludedProcessId))
            {
                continue;
            }

            int timeoutMs;
            if (!int.TryParse(parts[6], NumberStyles.Integer, CultureInfo.InvariantCulture, out timeoutMs))
            {
                timeoutMs = 300;
            }
            WriteResult(id, ScrollAt(x, y, delta, expectedRoot, excludedProcessId, timeoutMs));
        }
    }

    private static ScrollResult ScrollAt(int x, int y, int delta, long expectedRoot, uint excludedProcessId, int timeoutMs)
    {
        IntPtr root = FindTopLevelTarget(x, y, excludedProcessId);
        if (root == IntPtr.Zero) return ScrollResult.Fail("no-target");
        if (!IsWindow(root)) return ScrollResult.Fail("invalid-target");

        uint processId;
        GetWindowThreadProcessId(root, out processId);
        IntPtr target = FindDeepestChild(root, x, y);
        if (target == IntPtr.Zero) return ScrollResult.Fail("no-target");

        long rootValue = root.ToInt64();
        if (expectedRoot != 0 && expectedRoot != rootValue)
        {
            return ScrollResult.Fail("target-changed", rootValue, processId);
        }

        IntPtr wParam = new IntPtr(unchecked(delta << 16));
        int packedPoint = unchecked((y << 16) | (x & 0xffff));
        IntPtr result;
        IntPtr sent = SendMessageTimeout(
            target,
            WmMouseWheel,
            wParam,
            new IntPtr(packedPoint),
            SmtoAbortIfHung,
            (uint)Math.Max(50, Math.Min(2000, timeoutMs)),
            out result);
        if (sent == IntPtr.Zero) return ScrollResult.Fail("send-failed", rootValue, processId);
        return ScrollResult.Success(rootValue, processId);
    }

    private static IntPtr FindTopLevelTarget(int x, int y, uint excludedProcessId)
    {
        IntPtr found = IntPtr.Zero;
        uint ownProcessId = (uint)Process.GetCurrentProcess().Id;
        EnumWindows(delegate(IntPtr window, IntPtr state)
        {
            if (!IsWindowVisible(window) || IsIconic(window)) return true;
            uint processId;
            GetWindowThreadProcessId(window, out processId);
            if (processId == excludedProcessId || processId == ownProcessId) return true;

            long extendedStyle = GetWindowLongPtr(window, -20).ToInt64();
            if ((extendedStyle & WsExTransparent) != 0) return true;

            NativeRect rect;
            if (!GetWindowRect(window, out rect)) return true;
            if (x < rect.Left || x >= rect.Right || y < rect.Top || y >= rect.Bottom) return true;
            found = window;
            return false;
        }, IntPtr.Zero);
        return found;
    }

    private static IntPtr FindDeepestChild(IntPtr root, int screenX, int screenY)
    {
        IntPtr current = root;
        for (int depth = 0; depth < 16; depth++)
        {
            NativePoint point = new NativePoint { X = screenX, Y = screenY };
            if (!ScreenToClient(current, ref point)) break;
            IntPtr child = ChildWindowFromPointEx(
                current,
                point,
                CwpSkipInvisible | CwpSkipDisabled | CwpSkipTransparent);
            if (child == IntPtr.Zero || child == current) break;
            current = child;
        }
        return current;
    }

    private static void WriteResult(int id, ScrollResult result)
    {
        StringBuilder json = new StringBuilder();
        json.Append("{\"id\":").Append(id)
            .Append(",\"ok\":").Append(result.Ok ? "true" : "false")
            .Append(",\"target\":\"").Append(result.Target.ToString(CultureInfo.InvariantCulture)).Append("\"")
            .Append(",\"processId\":").Append(result.ProcessId);
        if (!result.Ok)
        {
            json.Append(",\"reason\":\"").Append(result.Reason).Append("\"");
        }
        json.Append('}');
        output.WriteLine(json.ToString());
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

    private sealed class ScrollResult
    {
        internal bool Ok;
        internal string Reason;
        internal long Target;
        internal uint ProcessId;

        internal static ScrollResult Success(long target, uint processId)
        {
            return new ScrollResult { Ok = true, Reason = "", Target = target, ProcessId = processId };
        }

        internal static ScrollResult Fail(string reason, long target = 0, uint processId = 0)
        {
            return new ScrollResult { Ok = false, Reason = reason, Target = target, ProcessId = processId };
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct NativePoint
    {
        internal int X;
        internal int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeRect
    {
        internal int Left;
        internal int Top;
        internal int Right;
        internal int Bottom;
    }

    private delegate bool EnumWindowsCallback(IntPtr window, IntPtr state);

    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr state);
    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr window, out NativeRect rect);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    private static extern IntPtr GetWindowLongPtr(IntPtr window, int index);
    [DllImport("user32.dll")]
    private static extern bool ScreenToClient(IntPtr window, ref NativePoint point);
    [DllImport("user32.dll")]
    private static extern IntPtr ChildWindowFromPointEx(IntPtr parent, NativePoint point, uint flags);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")]
    private static extern IntPtr SendMessageTimeout(
        IntPtr window,
        uint message,
        IntPtr wParam,
        IntPtr lParam,
        uint flags,
        uint timeout,
        out IntPtr result);
    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr value);
}
