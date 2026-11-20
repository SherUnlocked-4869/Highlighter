namespace Highlighter.DeviceBattery;

// Keep bounded stdout while a pipe drains slowly. A reply must not be overwritten by an ordinary snapshot.
internal sealed class WatchOutput
{
    private readonly AutoResetEvent _available = new(false);
    private readonly object _gate = new();
    private string? _latest, _reply;
    private bool _stopped;

    public bool Offer(string line, bool reply)
    {
        lock (_gate)
        {
            if (_stopped) return false;
            if (reply)
            {
                if (_reply is not null) return false; // The parent sends only one request until its reply.
                _reply = line;
                _latest = null; // The reply carries a newer snapshot; never publish an older one after it.
            }
            else _latest = line;
        }
        _available.Set();
        return true;
    }

    public string? Take()
    {
        while (true)
        {
            lock (_gate)
            {
                if (_stopped) return null;
                if (_reply is { } reply) { _reply = null; return reply; }
                if (_latest is { } latest) { _latest = null; return latest; }
            }
            _available.WaitOne();
        }
    }

    public void Stop()
    {
        lock (_gate) { _stopped = true; _latest = _reply = null; }
        _available.Set();
    }
}
