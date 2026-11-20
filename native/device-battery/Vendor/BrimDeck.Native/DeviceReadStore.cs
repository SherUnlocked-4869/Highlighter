// Modified for Highlighter: isolated state, exclusive lease, fail-closed durable marks, stop without erasing in-flight work.
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using BrimDeck.Core;

namespace BrimDeck.Native;

// The read book and the crash marker for a previously unverified HID read. Only the read that owns a mark clears it,
// after its call returns. At the next launch a surviving mark disables the corresponding read before new reads start.
internal static class DeviceReadStore
{
    private const string BookFile = "device-reads.json", ProbeFile = "device-probe.json", LockFile = "device-state.lock";
    private const int MaxBookBytes = 2 * 1024 * 1024, MaxMarkBytes = 1024;
    private static readonly JsonSerializerOptions StateJson = new()
    {
        AllowDuplicateProperties = false,
        UnmappedMemberHandling = System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow,
        MaxDepth = 8,
    };
    private static readonly object Gate = new();
    private static FileStream? _lease;
    private static string? _folder;
    private static DeviceReadBook _book = new();
    private static string? _savePending;
    private static bool _active;
    private static volatile bool _stopping, _faulted;

    public static DeviceReadBook Book => _book;
    public static bool Stopping => _stopping;
    public static bool Faulted => _faulted;
    public static void Disable() => _faulted = true;
    // Called by the input pump before scheduling Dispatcher teardown, even if the Dispatcher is busy.
    public static void StopAccepting() => _stopping = true;

    // The trusted caller supplies a dedicated local directory. No fallback to a BrimDeck or shared data directory.
    public static bool Start(string folder)
    {
        lock (Gate)
        {
            try
            {
                RejectRedirectedPath(folder);
                Directory.CreateDirectory(folder);
                _folder = folder;
                foreach (string name in new[] { LockFile, BookFile, BookFile + ".tmp", ProbeFile }) RejectRedirectedPath(Path.Combine(folder, name));
                _lease = new FileStream(Path.Combine(folder, LockFile), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
                string? stored = Read(BookFile, MaxBookBytes);
                // The upstream parser tolerates bad JSON. Do not interpret corruption as permission to retry blocked reads.
                if (stored is not null) ValidateBook(stored);
                _book = DeviceReadBook.Parse(stored);
                if (Read(ProbeFile, MaxMarkBytes) is { Length: > 0 } left)
                {
                    var mark = JsonSerializer.Deserialize<Mark>(left, StateJson);
                    if (mark is null || !Hardware(mark.Device) || !Way(mark.Way)) throw new InvalidDataException();
                    _book.Harmed(mark.Device, mark.Way);
                    // Never clear a recovered crash marker before its block is safely recorded in the book.
                    SaveLocked();
                }
                // Verify that this process can persist a new marker. Probe still checks again immediately before sending.
                WriteThrough(ProbeFile, "");
                return true;
            }
            catch (Exception error) when (StateError(error) || error is JsonException or InvalidDataException or DecoderFallbackException)
            {
                _faulted = true;
                _lease?.Dispose(); _lease = null;
                return false;
            }
        }
    }

    private static void RejectRedirectedPath(string path)
    {
        for (string? at = path; at is not null; at = Path.GetDirectoryName(at))
        {
            try
            {
                if (File.GetAttributes(at).HasFlag(FileAttributes.ReparsePoint)) throw new IOException();
            }
            catch (FileNotFoundException) { }
            catch (DirectoryNotFoundException) { }
        }
    }

    public static void Save()
    {
        lock (Gate)
        {
            if (_lease is null) return;
            try { SaveLocked(); }
            catch (Exception error) when (StateError(error)) { _faulted = true; }
        }
    }

    // Only after workers drain. No marker is cleared here, including when the probe's own clear failed.
    public static void Finish()
    {
        StopAccepting();
        lock (Gate)
        {
            if (_active) throw new InvalidOperationException();
            Save();
            _lease?.Dispose(); _lease = null;
        }
    }

    private sealed record Mark(string Device, string Way);

    public static T? Probe<T>(string device, string way, Func<T> ask)
    {
        lock (Gate)
        {
            if (_stopping || _faulted || _lease is null || _active) return default;
            try { WriteThrough(ProbeFile, JsonSerializer.Serialize(new Mark(device, way))); }
            catch (Exception error) when (StateError(error)) { _faulted = true; return default; }
            _active = true;
        }
        try { return _stopping ? default : ask(); }
        finally
        {
            lock (Gate)
            {
                try { WriteThrough(ProbeFile, ""); }
                catch (Exception error) when (StateError(error)) { _faulted = true; }
                finally { _active = false; }
            }
        }
    }

    private static void SaveLocked()
    {
        if (_book.Dirty) _savePending = _book.Serialize();
        if (_savePending is not { } text) return;
        WriteThrough(BookFile + ".tmp", text);
        // On recovery a failed move throws before the marker can be cleared. Commit the rename before clearing the mark.
        if (!MoveFileEx(Path.Combine(_folder!, BookFile + ".tmp"), Path.Combine(_folder!, BookFile), 0x1 | 0x8 /* REPLACE_EXISTING | WRITE_THROUGH */))
            throw new IOException();
        _savePending = null;
    }

    private static bool Hardware(string? id) => id is { Length: 9 } && id[4] == ':'
        && id.Where((_, index) => index != 4).All(char.IsAsciiHexDigit);

    private static bool Way(string? name) => name is { Length: > 0 and <= 128 }
        && name.All(ch => char.IsAsciiLetterOrDigit(ch) || ch is '.' or '_' or '-');

    private static void ValidateBook(string text)
    {
        // Require every entry's safety fields, valid types, unique hardware IDs and no truncation by the upstream parser.
        var entries = JsonSerializer.Deserialize<List<DeviceReadEntry>>(text, StateJson);
        if (entries is null || entries.Count > DeviceReadBook.MaximumEntries) throw new InvalidDataException();
        using var doc = JsonDocument.Parse(text);
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        int index = 0;
        foreach (var item in doc.RootElement.EnumerateArray())
        {
            var entry = entries[index++];
            if (entry is null || !Hardware(entry.Device) || !seen.Add(entry.Device) || !item.TryGetProperty("Stopped", out _)
                || !item.TryGetProperty("Bad", out _) || entry.Bad is null || entry.Bad.Any(way => !Way(way))
                || (!entry.Stopped && entry.Bad.Count >= DeviceReadBook.HarmToStop)
                || (entry.Way is { } kept && (!Way(kept) || entry.Bad.Contains(kept) || string.IsNullOrWhiteSpace(entry.Collection)))
                || entry.Collection is { Length: > 80 }) throw new InvalidDataException();
        }
    }

    private static string? Read(string name, int maxBytes)
    {
        try
        {
            using var stream = new FileStream(Path.Combine(_folder!, name), FileMode.Open, FileAccess.Read, FileShare.Read);
            if (stream.Length > maxBytes) throw new InvalidDataException();
            byte[] contents = new byte[(int)stream.Length];
            stream.ReadExactly(contents);
            if (stream.ReadByte() != -1) throw new InvalidDataException();
            return new UTF8Encoding(false, true).GetString(contents);
        }
        catch (FileNotFoundException) { return null; }
    }

    // Written in place and flushed to disk before the device call. A rename after writing a temp marker would not be durable.
    private static void WriteThrough(string name, string text)
    {
        using var stream = new FileStream(Path.Combine(_folder!, name), FileMode.Create, FileAccess.Write, FileShare.Read, 4096, FileOptions.WriteThrough);
        stream.Write(Encoding.UTF8.GetBytes(text));
        stream.Flush(flushToDisk: true);
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "MoveFileExW")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool MoveFileEx(string existing, string replacement, uint flags);

    private static bool StateError(Exception error) => error is IOException or UnauthorizedAccessException or System.Security.SecurityException;
}
