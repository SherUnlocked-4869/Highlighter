param(
  [int]$DurationSeconds = 20,
  [int]$PollMilliseconds = 10,
  [int]$TextPreviewLength = 240
)

$nativeSource = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public sealed class ClipboardSnapshot
{
    public uint Sequence { get; set; }
    public uint OwnerPid { get; set; }
    public string Text { get; set; }
    public string AnsiText { get; set; }
    public string AnsiUtf8Text { get; set; }
    public string AnsiHexPrefix { get; set; }
    public string HtmlUtf8Prefix { get; set; }
    public string[] Formats { get; set; }
}

public static class ClipboardTraceNative
{
    [DllImport("user32.dll")]
    private static extern uint GetClipboardSequenceNumber();

    [DllImport("user32.dll")]
    private static extern IntPtr GetClipboardOwner();

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool OpenClipboard(IntPtr hWndNewOwner);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool CloseClipboard();

    [DllImport("user32.dll")]
    private static extern uint EnumClipboardFormats(uint format);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClipboardFormatName(uint format, StringBuilder name, int maxCount);

    [DllImport("user32.dll")]
    private static extern IntPtr GetClipboardData(uint format);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GlobalLock(IntPtr memory);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GlobalUnlock(IntPtr memory);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern UIntPtr GlobalSize(IntPtr memory);

    private const uint CfText = 1;
    private const uint CfUnicodeText = 13;

    private static string FormatName(uint format)
    {
        if (format == CfText) return "CF_TEXT";
        if (format == 2) return "CF_BITMAP";
        if (format == 8) return "CF_DIB";
        if (format == CfUnicodeText) return "CF_UNICODETEXT";
        if (format == 17) return "CF_DIBV5";

        var name = new StringBuilder(256);
        var length = GetClipboardFormatName(format, name, name.Capacity);
        return length > 0 ? name.ToString() : "FORMAT_" + format;
    }

    private static string ReadUnicodeText()
    {
        var handle = GetClipboardData(CfUnicodeText);
        if (handle == IntPtr.Zero) return null;
        var pointer = GlobalLock(handle);
        if (pointer == IntPtr.Zero) return null;
        try
        {
            return Marshal.PtrToStringUni(pointer);
        }
        finally
        {
            GlobalUnlock(handle);
        }
    }

    private static byte[] ReadBytes(uint format, int maxBytes)
    {
        var handle = GetClipboardData(format);
        if (handle == IntPtr.Zero) return null;
        var pointer = GlobalLock(handle);
        if (pointer == IntPtr.Zero) return null;
        try
        {
            var size = (ulong)GlobalSize(handle);
            var length = (int)Math.Min((ulong)maxBytes, size);
            if (length <= 0) return null;
            var bytes = new byte[length];
            Marshal.Copy(pointer, bytes, 0, length);
            return bytes;
        }
        finally
        {
            GlobalUnlock(handle);
        }
    }

    private static string DecodeNullTerminated(byte[] bytes, Encoding encoding)
    {
        if (bytes == null) return null;
        var length = Array.IndexOf(bytes, (byte)0);
        if (length < 0) length = bytes.Length;
        return encoding.GetString(bytes, 0, length);
    }

    public static ClipboardSnapshot Capture()
    {
        var snapshot = new ClipboardSnapshot { Sequence = GetClipboardSequenceNumber() };
        var owner = GetClipboardOwner();
        if (owner != IntPtr.Zero)
        {
            uint pid;
            GetWindowThreadProcessId(owner, out pid);
            snapshot.OwnerPid = pid;
        }

        if (!OpenClipboard(IntPtr.Zero))
        {
            snapshot.Formats = new[] { "<clipboard-busy>" };
            return snapshot;
        }

        try
        {
            var formats = new List<string>();
            uint current = 0;
            while ((current = EnumClipboardFormats(current)) != 0)
            {
                var name = FormatName(current);
                formats.Add(name);
                if (name == "HTML Format")
                {
                    snapshot.HtmlUtf8Prefix = DecodeNullTerminated(ReadBytes(current, 2048), Encoding.UTF8);
                }
            }
            snapshot.Formats = formats.ToArray();
            snapshot.Text = ReadUnicodeText();
            var ansiBytes = ReadBytes(CfText, 4096);
            snapshot.AnsiText = DecodeNullTerminated(ansiBytes, Encoding.Default);
            snapshot.AnsiUtf8Text = DecodeNullTerminated(ansiBytes, Encoding.UTF8);
            if (ansiBytes != null)
            {
                var prefixLength = Math.Min(128, ansiBytes.Length);
                var prefix = new byte[prefixLength];
                Array.Copy(ansiBytes, prefix, prefixLength);
                snapshot.AnsiHexPrefix = BitConverter.ToString(prefix);
            }
            return snapshot;
        }
        finally
        {
            CloseClipboard();
        }
    }
}
'@

Add-Type -TypeDefinition $nativeSource -Language CSharp

$deadline = [DateTime]::UtcNow.AddSeconds($DurationSeconds)
$lastSequence = [uint32]0
$lastBusySequence = [uint32]0
while ([DateTime]::UtcNow -lt $deadline) {
  $snapshot = [ClipboardTraceNative]::Capture()
  $isBusy = $snapshot.Formats -contains '<clipboard-busy>'
  if (($isBusy -and $snapshot.Sequence -ne $lastBusySequence) -or (-not $isBusy -and $snapshot.Sequence -ne $lastSequence)) {
    if ($isBusy) {
      $lastBusySequence = $snapshot.Sequence
    } else {
      $lastSequence = $snapshot.Sequence
      $lastBusySequence = 0
    }
    $ownerName = ''
    if ($snapshot.OwnerPid) {
      try { $ownerName = (Get-Process -Id $snapshot.OwnerPid -ErrorAction Stop).ProcessName } catch {}
    }
    [pscustomobject]@{
      timestamp = [DateTimeOffset]::Now.ToString('o')
      sequence = $snapshot.Sequence
      ownerPid = $snapshot.OwnerPid
      ownerProcess = $ownerName
      textLength = if ($null -eq $snapshot.Text) { $null } else { $snapshot.Text.Length }
      text = if ($null -eq $snapshot.Text -or $snapshot.Text.Length -le $TextPreviewLength) { $snapshot.Text } else { $snapshot.Text.Substring(0, $TextPreviewLength) }
      ansiText = if ($null -eq $snapshot.AnsiText -or $snapshot.AnsiText.Length -le $TextPreviewLength) { $snapshot.AnsiText } else { $snapshot.AnsiText.Substring(0, $TextPreviewLength) }
      ansiUtf8Text = if ($null -eq $snapshot.AnsiUtf8Text -or $snapshot.AnsiUtf8Text.Length -le $TextPreviewLength) { $snapshot.AnsiUtf8Text } else { $snapshot.AnsiUtf8Text.Substring(0, $TextPreviewLength) }
      ansiHexPrefix = $snapshot.AnsiHexPrefix
      htmlUtf8Prefix = if ($null -eq $snapshot.HtmlUtf8Prefix -or $snapshot.HtmlUtf8Prefix.Length -le $TextPreviewLength) { $snapshot.HtmlUtf8Prefix } else { $snapshot.HtmlUtf8Prefix.Substring(0, $TextPreviewLength) }
      formats = $snapshot.Formats
    } | ConvertTo-Json -Compress
  }
  Start-Sleep -Milliseconds $PollMilliseconds
}
