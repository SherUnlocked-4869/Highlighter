using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Threading;
using BrimDeck.Native;

[assembly: DefaultDllImportSearchPaths(DllImportSearchPath.System32)]

namespace Highlighter.DeviceBattery;

internal static class Program
{
    private const string Version = "HighlighterDeviceBattery 1";

    [STAThread]
    private static int Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        try
        {
            if (args is ["--version"]) { Console.WriteLine(Version); return 0; }
            if (args is ["--smoke"]) return Smoke.Run();
            if (args is ["--smoke", "--scratch-dir", var scratch] && StatePath(scratch) is { } testFolder) return Smoke.Run(testFolder);
            if (args is ["--smoke-pipe"]) return RunPipeWatch(null);  // Uses only synthetic snapshots, never opens hardware or state.
            if (args is ["--watch", "--state-dir", var dir] && StatePath(dir) is { } folder) return RunPipeWatch(folder);
            return Fail("invalid-arguments", 2);
        }
        catch (Exception) { return Fail("watch-failed", 3); }
    }

    private static string? StatePath(string value)
    {
        if (!Path.IsPathFullyQualified(value)) return null;
        var path = Path.TrimEndingDirectorySeparator(Path.GetFullPath(value));
        // Only a local drive path (no shares or Win32 device/extended paths), with no alternate streams or aliases using . / spaces.
        if (path.Length <= 3 || path[1] != ':' || path[2] != '\\' || path.AsSpan(2).Contains(':') ||
            path[3..].Split('\\').Any(component => component.Length == 0 || component.EndsWith('.') || component.EndsWith(' '))) return null;
        string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        string brimDeck = Path.Combine(local, "BrimDeck");
        if (local.Length > 0 && (path.Equals(brimDeck, StringComparison.OrdinalIgnoreCase) || path.StartsWith(brimDeck + '\\', StringComparison.OrdinalIgnoreCase))) return null;
        return path;
    }

    private static int Fail(string code, int exit)
    {
        try { Console.Error.WriteLine(code); } catch (IOException) { }
        return exit;
    }

    // PeekNamedPipe does not consume bytes and succeeds on Electron's anonymous pipe while its writing end is open.
    private static int InputState(out uint queued)
    {
        queued = 0;
        IntPtr handle = GetStdHandle(-10);
        if (GetFileType(handle) != 3 /* FILE_TYPE_PIPE */) return -1;
        if (PeekNamedPipe(handle, IntPtr.Zero, 0, IntPtr.Zero, out queued, IntPtr.Zero)) return 1;
        return Marshal.GetLastWin32Error() is 109 or 232 or 233 ? 0 : -1;
    }

    [DllImport("kernel32.dll")] private static extern IntPtr GetStdHandle(int standardHandle);
    [DllImport("kernel32.dll")] private static extern uint GetFileType(IntPtr file);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool PeekNamedPipe(IntPtr pipe, IntPtr buffer, uint length, IntPtr read, out uint available, IntPtr next);

    private static int RunPipeWatch(string? folder)
    {
        if (!OperatingSystem.IsWindowsVersionAtLeast(10, 0, 19041) || !Environment.Is64BitProcess) return Fail("unsupported-platform", 3);
        // A pipe is the parent lifetime signal. Do not run from a terminal, a file or a closed/invalid pipe.
        int input = InputState(out _);
        if (input < 0) return Fail("stdin-pipe-required", 2);
        if (input == 0) return 0;
        if (!Console.IsOutputRedirected) return Fail("stdout-pipe-required", 2);
        return Watch(folder);
    }

    private static int Watch(string? folder)
    {
        var dispatcher = Dispatcher.CurrentDispatcher;
        SynchronizationContext.SetSynchronizationContext(new DispatcherSynchronizationContext(dispatcher));
        var output = new WatchOutput();
        using var lifetime = new CancellationTokenSource();
        DeviceBatteries? devices = null;
        string? previous = null;
        long sentAt = long.MinValue / 2;
        int exit = 0;
        bool stopStarted = false;
        long powerAt = 0;
        bool refreshing = false, settledByReply = false;
        int fixtureRequests = 0;
        SystemReading power = SystemReading.Unavailable;
        var tick = new DispatcherTimer(DispatcherPriority.Background, dispatcher) { Interval = TimeSpan.FromMilliseconds(250) };
        int inputReady = 0;
        var pump = new WatchCommands(() =>
        {
            // EOF can outlive the parent. Even if a WinRT or driver call blocks the Dispatcher, do not leave an orphan;
            // this watchdog does not touch the probe marker or state lease. Electron also enforces its own cutoff.
            new Thread(() => { Thread.Sleep(2_500); Environment.Exit(4); }) { IsBackground = true, Name = "Battery stop deadline" }.Start();
            dispatcher.BeginInvoke(DispatcherPriority.Send, new Action(BeginStop));
        });
        tick.Tick += (_, _) =>
        {
            if (DeviceReadStore.Stopping) return;
            if (devices is not null && Environment.TickCount64 >= powerAt) ReadPower();
            PublishCurrent();
            if (!refreshing && pump.TakeRefresh() is int id) Refresh(id);
        };

        void ReadPower()
        {
            power = SystemReading.Read();
            powerAt = Environment.TickCount64 + 5_000;
        }

        void PublishCurrent(RefreshResult? refresh = null)
        {
            var status = devices?.Status ?? "ready";
            // An early refresh timeout must not report loading, and no later regular snapshot may regress to loading.
            if (refresh is not null) settledByReply = true;
            if (settledByReply && status == "loading") status = "partial";
            Publish(status, power, devices?.All ?? [], refresh);
        }

        void Publish(string status, SystemReading system, IReadOnlyList<BrimDeck.Core.DeviceBattery> readings, RefreshResult? refresh = null)
        {
            if (DeviceReadStore.Stopping) return;
            string snapshot = Protocol.Serialize(status, system, readings);
            long now = Environment.TickCount64;
            if (refresh is null && snapshot == previous && now - sentAt < 15_000) return;
            previous = snapshot;
            sentAt = now;
            if (!output.Offer(refresh is null ? snapshot : Protocol.Serialize(status, system, readings, refresh), refresh is not null)) pump.Stop();
        }

        async void Refresh(int id)
        {
            refreshing = true;
            using var budget = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
            budget.CancelAfter(devices is null ? TimeSpan.FromMilliseconds(400) : TimeSpan.FromSeconds(8));
            bool complete = false;
            try
            {
                if (devices is not null)
                {
                    ReadPower();
                    complete = await devices.RefreshNowAsync(budget.Token).WaitAsync(budget.Token) && power.State != "unavailable";
                }
                else complete = await RefreshFixture(++fixtureRequests).WaitAsync(budget.Token);
            }
            catch (OperationCanceledException) when (budget.IsCancellationRequested) { }
            finally { refreshing = false; }
            if (!DeviceReadStore.Stopping) PublishCurrent(new RefreshResult(id, complete && !budget.IsCancellationRequested ? "complete" : "partial"));
        }

        async Task<bool> RefreshFixture(int attempt)
        {
            await Task.Delay(attempt == 3 ? 700 : 40);
            if (DeviceReadStore.Stopping) return false;
            if (attempt is 1 or 3) power = power with { Percent = attempt == 1 ? 73 : 74 };
            return true;
        }

        dispatcher.UnhandledException += (_, e) =>
        {
            e.Handled = true;
            exit = 3;
            pump.Stop();
        };

        async void BeginStop()
        {
            if (stopStarted) return;
            stopStarted = true;
            tick.Stop();
            lifetime.Cancel();
            output.Stop();
            try
            {
                devices?.Dispose();
                long until = Environment.TickCount64 + 2_000;
                // Keep the Dispatcher alive while in-flight GATT continuations close handles and HID finishes the mark it owns.
                while (devices is { Drained: false } && Environment.TickCount64 < until) await Task.Delay(25);
                if (devices is not { Drained: false }) DeviceReadStore.Finish();
                else if (exit == 0) exit = 4; // OS reclaims any wedged handles; leave the crash marker and lease untouched until exit.
            }
            catch (Exception) { exit = 3; }
            finally { dispatcher.BeginInvokeShutdown(DispatcherPriority.Send); }
        }

        new Thread(() =>
        {
            try
            {
                using var writer = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false), 8192) { NewLine = "\n", AutoFlush = true };
                while (output.Take() is { } json) writer.WriteLine(json);
            }
            catch (Exception error) when (error is IOException or InvalidOperationException) { pump.Stop(); }
        }) { IsBackground = true, Name = "Battery stdout" }.Start();
        new Thread(() =>
        {
            try
            {
                pump.Run(Console.OpenStandardInput(),
                    () => InputState(out uint queued) == 1 ? (int)Math.Min(256u, queued) : -1,
                    () => Volatile.Write(ref inputReady, 1));
            }
            catch (Exception error) when (error is IOException or InvalidOperationException) { pump.Stop(); }
        }) { IsBackground = true, Name = "Battery stdin" }.Start();

        // Wait for the input thread to drain any buffered stop or EOF before activation. Only that thread touches the pipe.
        var start = new DispatcherTimer(DispatcherPriority.Background, dispatcher) { Interval = TimeSpan.FromMilliseconds(25) };
        start.Tick += (_, _) =>
        {
            if (!DeviceReadStore.Stopping && Volatile.Read(ref inputReady) == 0) return;
            start.Stop();
            if (DeviceReadStore.Stopping) return;

            Publish("loading", SystemReading.Unavailable, []);
            if (folder is null)
            {
                power = new("ready", 72, true, false);
                tick.Start();
                return;
            }
            bool hidAllowed = new DriveInfo(Path.GetPathRoot(folder)!).DriveType == DriveType.Fixed && DeviceReadStore.Start(folder);
            if (!hidAllowed) DeviceReadStore.Disable();
            if (DeviceReadStore.Stopping) return;
            power = SystemReading.Read();
            powerAt = Environment.TickCount64 + 5_000;
            devices = new DeviceBatteries(dispatcher, hidAllowed);
            devices.Start();
            if (!DeviceReadStore.Stopping)
            {
                Publish(devices.Status, power, devices.All);
                tick.Start();
            }
        };
        start.Start();
        Dispatcher.Run();
        return exit switch { 0 => 0, 4 => Fail("drain-timeout", 4), _ => Fail("watch-failed", exit) };
    }
}

internal sealed class WatchCommands(Action stop)
{
    private int _refresh, _stopped;

    public void Stop()
    {
        if (Interlocked.Exchange(ref _stopped, 1) != 0) return;
        DeviceReadStore.StopAccepting();
        stop();
    }

    public int? TakeRefresh() => Interlocked.Exchange(ref _refresh, 0) is > 0 and var id ? id : null;

    private static int? ParseRefresh(ReadOnlySpan<byte> command)
    {
        if (!command.StartsWith("refresh "u8)) return null;
        var digits = command[8..];
        if (digits.IsEmpty) return null;
        int id = 0;
        foreach (int digit in digits)
        {
            int value = digit - '0';
            if (value is < 0 or > 9 || id > (int.MaxValue - value) / 10) return null;
            id = id * 10 + value;
        }
        return id > 0 ? id : null;
    }

    // Fixed memory use even if a writer sends a huge invalid line. Commands are plain ASCII within the UTF-8 stream.
    public void Run(Stream input, Func<int>? queued = null, Action? ready = null)
    {
        Span<byte> chunk = stackalloc byte[256], line = stackalloc byte[19]; // "refresh " + 10 digits + CR
        int length = 0;
        try
        {
            while (true)
            {
                int count = queued?.Invoke() ?? 0;
                if (count < 0) return;
                if (count == 0) { ready?.Invoke(); queued = null; ready = null; count = chunk.Length; }
                int read = input.Read(chunk[..count]);
                if (read == 0) return;
                foreach (byte next in chunk[..read])
                {
                    if (next != (byte)'\n')
                    {
                        if (length < line.Length) line[length] = next;
                        if (length <= line.Length) length++;
                        continue;
                    }
                    if (length <= line.Length)
                    {
                        var command = line[..length];
                        if (command.Length > 0 && command[^1] == (byte)'\r') command = command[..^1];
                        if (command.SequenceEqual("stop"u8)) return;
                        if (ParseRefresh(command) is int id) Interlocked.CompareExchange(ref _refresh, id, 0);
                    }
                    length = 0;
                }
            }
        }
        catch (IOException) { }
        finally { Stop(); }
    }
}
