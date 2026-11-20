// Modified for Highlighter: one headless watch session, manual read completion, immediate stop and independent source health/drain.
using System.Runtime.InteropServices;
using System.Windows.Threading;
using BrimDeck.Core;

namespace BrimDeck.Native;

internal enum DeviceDemand { None, Watch }

// Owned by the Dispatcher. A source reports its entire list, not deltas.
internal interface IDeviceSource : IDisposable
{
    void Start(DeviceDemand demand);
    void Stop();
    void ReadNow();
    // Synchronous and passive sources finish here; workers override this to wait for their roster update.
    Task<bool> RefreshNowAsync(CancellationToken cancellation)
    {
        cancellation.ThrowIfCancellationRequested();
        ReadNow();
        return Task.FromResult(Listed && !Faulted);
    }
    bool Listed { get; }
    bool Faulted => false;
    bool Drained => true;
}

internal sealed class DeviceBatteries : IDisposable
{
    private readonly DeviceRoster _roster = new();
    private readonly IDeviceSource[] _sources;
    private readonly AppleBatteries _apple;
    private readonly DispatcherTimer _idle;
    private readonly HashSet<IDeviceSource> _faults = [];
    private long _startedAt, _readNowAt;
    private bool _running, _disposed, _away, _settled;

    public DeviceBatteries(Dispatcher dispatcher, bool hidAllowed)
    {
        _idle = new DispatcherTimer(DispatcherPriority.Background, dispatcher) { Interval = TimeSpan.FromSeconds(2) };
        _idle.Tick += (_, _) => Idle();
        _apple = new AppleBatteries(dispatcher, Report);
        // Phone Link first (primary for a phone), Apple last (follows the unmerged Bluetooth list).
        List<IDeviceSource> sources = [new PhoneLinkBatteries(dispatcher, Report), new BluetoothBatteries(dispatcher, Report)];
        if (hidAllowed) sources.Add(new HidBatteries(dispatcher, Report));
        sources.Add(new GamingBatteries(dispatcher, Report));
        sources.Add(_apple);
        _sources = [.. sources];
    }

    private void Report(DeviceSource source, IReadOnlyList<DeviceBattery> devices)
    {
        if (!_running || DeviceReadStore.Stopping) return;
        _roster.Set(source, devices);
        if (source == DeviceSource.Bluetooth) _apple.Consider(_roster.Of(DeviceSource.Bluetooth));
    }

    public IReadOnlyList<DeviceBattery> All => _roster.All;
    public string Status
    {
        get
        {
            bool listed = _sources.All(source => source.Listed);
            if (!_settled && !listed && Environment.TickCount64 - _startedAt < 10_000) return "loading";
            _settled = true;
            return !listed || _faults.Count > 0 || DeviceReadStore.Faulted || _sources.Any(source => source.Faulted) ? "partial" : "ready";
        }
    }
    public bool Drained => _sources.All(source => source.Drained);

    public void Start()
    {
        if (_running || _disposed || DeviceReadStore.Stopping) return;
        _startedAt = Environment.TickCount64;
        _running = true;
        Call(source => source.Start(DeviceDemand.Watch));
        if (!DeviceReadStore.Stopping) _idle.Start();
    }

    // All sources are invoked on the Dispatcher. Completion means their work, including roster publication, was observed.
    // Only waits are cancelled; already submitted I/O can still publish later via its normal source path.
    public async Task<bool> RefreshNowAsync(CancellationToken cancellation)
    {
        if (!_running || DeviceReadStore.Stopping) return false;
        var results = await Task.WhenAll(_sources.Select(Attempt));
        return results.All(ok => ok) && !DeviceReadStore.Faulted;

        async Task<bool> Attempt(IDeviceSource source)
        {
            cancellation.ThrowIfCancellationRequested();
            try
            {
                bool ok = await source.RefreshNowAsync(cancellation);
                cancellation.ThrowIfCancellationRequested();
                if (ok) _faults.Remove(source);
                return ok;
            }
            catch (Exception error) when (error is not OutOfMemoryException && !cancellation.IsCancellationRequested)
            {
                _faults.Add(source);
                return false;
            }
        }
    }

    private void Call(Action<IDeviceSource> action)
    {
        if (!_running) return;
        foreach (var source in _sources)
        {
            if (DeviceReadStore.Stopping) return;
            try { action(source); _faults.Remove(source); }
            catch (Exception error) when (error is not OutOfMemoryException) { _faults.Add(source); }
        }
    }

    // Upstream behavior: read on return from idle, at most once every five seconds.
    // Electron owns suspend/resume and starts a fresh watch on resume; no SystemEvents or WPF Application.
    private void Idle()
    {
        var info = new LASTINPUTINFO { cbSize = (uint)Marshal.SizeOf<LASTINPUTINFO>() };
        if (!GetLastInputInfo(ref info)) return;
        uint idle = unchecked((uint)Environment.TickCount - info.dwTime);
        if (idle >= 20_000) { _away = true; return; }
        if (!_away) return;
        _away = false;
        long now = Environment.TickCount64;
        if (now - _readNowAt < 5_000) return;
        _readNowAt = now;
        Call(source => source.ReadNow());
    }

    [StructLayout(LayoutKind.Sequential)] private struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
    [DllImport("user32.dll")] private static extern bool GetLastInputInfo(ref LASTINPUTINFO info);

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _running = false;
        _idle.Stop();
        foreach (var source in _sources)
            try { source.Dispose(); }
            catch (Exception error) when (error is not OutOfMemoryException) { }
    }
}

// How often the sources without events of their own are read while the page or the collapsed reading shows, as the open-source
// battery tools on Windows have it. Ask: the brands that only answer when asked (vigil-watt's quick round, G-Helper's 20 seconds).
// Logitech: a fallback, its devices sending their own events in between (OpenLogi's 30 seconds). Cached: Windows' own Bluetooth
// levels, read from its cache without reaching the device (BlueGauge). Listen: the PlayStation controllers, which send their
// state all the time and are only listened to. Gatt: a Bluetooth LE level whose device sends no notices (the Battery Service
// specification asks not to poll it often). Slow: the receivers whose answer takes seconds (Corsair's, read on a thread of their
// own). The receivers that send their battery unasked have no interval: they are listened to all the time (PushEvents).
internal static class DevicePolling
{
    public static readonly TimeSpan Ask = TimeSpan.FromSeconds(15), Logitech = TimeSpan.FromSeconds(30), Cached = TimeSpan.FromSeconds(5),
        Listen = TimeSpan.FromSeconds(5), Gatt = TimeSpan.FromSeconds(60), Slow = TimeSpan.FromSeconds(60);
}
