using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using BrimDeck.Core;

namespace Highlighter.DeviceBattery;

internal sealed record SystemReading(string State, int? Percent, bool? AcOnline, bool? Charging)
{
    public static readonly SystemReading Unavailable = new("unavailable", null, null, null);

    internal static SystemReading Decode(byte ac, byte flags, byte percent)
    {
        bool? online = ac switch { 0 => false, 1 => true, _ => null };
        if (flags != 255 && (flags & 128) != 0) return new("no-battery", null, online, null);
        if (flags == 255 && percent > 100) return new("unavailable", null, online, null);
        return new("ready", percent <= 100 ? percent : null, online, flags == 255 ? null : (flags & 8) != 0);
    }

    public static SystemReading Read() => GetSystemPowerStatus(out var status)
        ? Decode(status.ACLineStatus, status.BatteryFlag, status.BatteryLifePercent) : Unavailable;

    [StructLayout(LayoutKind.Sequential)]
    private struct SystemPowerStatus
    {
        public byte ACLineStatus, BatteryFlag, BatteryLifePercent, SystemStatusFlag;
        public uint BatteryLifeTime, BatteryFullLifeTime;
    }

    [DllImport("kernel32.dll")] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetSystemPowerStatus(out SystemPowerStatus status);
}

internal static class Protocol
{
    private const int MaxDevices = 128, MaxName = 128;

    public static string Serialize(string status, SystemReading system, IReadOnlyList<BrimDeck.Core.DeviceBattery> readings, RefreshResult? refresh = null)
    {
        if (readings.Count > MaxDevices && status == "ready") status = "partial";
        if (refresh is not null && status != "ready") refresh = refresh with { Status = "partial" };
        return JsonSerializer.Serialize(new Snapshot(1, status, system, readings.Take(MaxDevices).Select(Row).ToArray(), refresh), WireContext.Default.Snapshot);
    }

    private static DeviceRow Row(BrimDeck.Core.DeviceBattery device) => new(
        // Upstream IDs may contain a MAC/serial/device path. Keep the raw identity in native memory and give main a stable digest to HMAC.
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(device.Key))),
        device.Name.Length <= MaxName ? device.Name : device.Name[..MaxName],
        device.Kind switch
        {
            DeviceKind.Mouse => "mouse", DeviceKind.Keyboard => "keyboard", DeviceKind.Headphones => "headphones", DeviceKind.Earbuds => "earbuds",
            DeviceKind.Controller => "controller", DeviceKind.Pen => "pen", DeviceKind.Speaker => "speaker", DeviceKind.Phone => "phone", _ => "other"
        },
        device.Source switch
        {
            DeviceSource.PhoneLink => "phone-link", DeviceSource.Logitech => "logitech", DeviceSource.Razer => "razer",
            DeviceSource.SteelSeries => "steelseries", DeviceSource.HyperX => "hyperx", DeviceSource.Sony => "sony", DeviceSource.Apple => "apple",
            DeviceSource.Gatt => "gatt", DeviceSource.Gaming => "gaming", DeviceSource.Hid => "hid", _ => "bluetooth"
        },
        Percent(device.Percent), Charging(device), device.Coarse, device.Asleep,
        device.Parts.Select(part => new PartRow(part.Part switch { BatteryPart.Left => "left", BatteryPart.Right => "right", _ => "case" },
            Percent(part.Percent), device.Asleep ? null : part.Charging ? true : part.Percent is not null && device.Source == DeviceSource.Apple ? false : null)).ToArray());

    private static bool? Charging(BrimDeck.Core.DeviceBattery device) => device.Asleep ? null : device.Charging ? true
        : !device.ChargingUnknown && device.Source is (DeviceSource.PhoneLink or DeviceSource.Gaming or DeviceSource.Bluetooth or DeviceSource.Gatt)
            ? false : null;

    private static int? Percent(int? value) => value is >= 0 and <= 100 ? value : null;
}

internal sealed record RefreshResult(int Id, string Status);
internal sealed record Snapshot(int SchemaVersion, string Status, SystemReading System, DeviceRow[] Devices,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] RefreshResult? Refresh);
internal sealed record DeviceRow(string Id, string Name, string Kind, string Source, int? Percent, bool? Charging, bool Estimated, bool Stale, PartRow[] Parts);
internal sealed record PartRow(string Part, int? Percent, bool? Charging);

[System.Text.Json.Serialization.JsonSourceGenerationOptions(PropertyNamingPolicy = System.Text.Json.Serialization.JsonKnownNamingPolicy.CamelCase)]
[System.Text.Json.Serialization.JsonSerializable(typeof(Snapshot))]
internal sealed partial class WireContext : System.Text.Json.Serialization.JsonSerializerContext;
