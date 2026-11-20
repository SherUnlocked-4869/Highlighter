using System.IO;
using System.Text;
using System.Text.Json;
using BrimDeck.Core;
using BrimDeck.Native;

namespace Highlighter.DeviceBattery;

// Pure recorded/synthetic fixtures; this never creates a Dispatcher or calls a device source.
internal static class Smoke
{
    public static int Run(string? scratch = null)
    {
        int checkedCount = 0;
        void Check(string _, bool ok)
        {
            if (!ok) throw new InvalidOperationException($"smoke-check-{checkedCount + 1}");
            checkedCount++;
        }
        try
        {
            DeviceProtocolTests.Run(Check);
            DeviceReadTests.Run(Check);
            PhoneLinkCardTests.Run(Check);
            PhoneLinkMergeTests.Run(Check);
            Check("Unknown flags never imply no battery", SystemReading.Decode(255, 255, 50) == new SystemReading("ready", 50, null, null));
            Check("Only an explicit absence means no battery", SystemReading.Decode(1, 128, 255) == new SystemReading("no-battery", null, true, null));
            Check("Discharging at zero and AC are distinguishable", SystemReading.Decode(1, 4, 0) == new SystemReading("ready", 0, true, false));
            Check("Charging does not depend on AC availability", SystemReading.Decode(255, 8, 30) == new SystemReading("ready", 30, null, true));
            Check("Unknown flags and level", SystemReading.Decode(0, 255, 255) == new SystemReading("unavailable", null, false, null));

            var device = new BrimDeck.Core.DeviceBattery("bt:102030405060", "测试耳机", DeviceKind.Earbuds, DeviceSource.Bluetooth, 0)
            {
                ChargingUnknown = true, Asleep = true, Coarse = true, Parts = [new(BatteryPart.Left, 0, true), new(BatteryPart.Case, null, false)]
            };
            var json = Protocol.Serialize("partial", SystemReading.Unavailable, [device]);
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            var row = root.GetProperty("devices")[0];
            Check("Typed snapshot envelope", root.GetProperty("schemaVersion").GetInt32() == 1 && root.GetProperty("status").GetString() == "partial");
            Check("Identity never places raw Bluetooth key on stdout", !json.Contains("102030405060", StringComparison.Ordinal) && row.GetProperty("id").GetString()!.Length == 64);
            Check("Nullable and zero readings stay distinct", row.GetProperty("percent").GetInt32() == 0 && row.GetProperty("charging").ValueKind == JsonValueKind.Null
                && row.GetProperty("name").GetString() == device.Name && row.GetProperty("estimated").GetBoolean() && row.GetProperty("stale").GetBoolean());
            var parts = row.GetProperty("parts");
            Check("Parts retain their own readings", parts[0].GetProperty("part").GetString() == "left" && parts[0].GetProperty("percent").GetInt32() == 0
                && parts[0].GetProperty("charging").ValueKind == JsonValueKind.Null && parts[1].GetProperty("percent").ValueKind == JsonValueKind.Null);

            Check("Ordinary snapshots omit refresh metadata", !root.TryGetProperty("refresh", out _));
            using var reply = JsonDocument.Parse(Protocol.Serialize("ready", SystemReading.Unavailable, [device], new(1, "complete")));
            var refresh = reply.RootElement.GetProperty("refresh");
            Check("Reply carries the request's ID and outcome", refresh.GetProperty("id").GetInt32() == 1 && refresh.GetProperty("status").GetString() == "complete");
            var mailbox = new WatchOutput();
            mailbox.Offer("older", false);
            mailbox.Offer("reply", true);
            mailbox.Offer("newer", false);
            Check("A slow writer keeps the reply before later reads", mailbox.Take() == "reply" && mailbox.Take() == "newer");
            mailbox.Stop();
            Check("Stop closes the mailbox", mailbox.Take() is null);

            if (scratch is not null) Guard(Check, scratch);
            // No real state/device access: test the actual input parser with memory streams, including EOF and oversized commands.
            int stops = 0;
            var commands = new WatchCommands(() => stops++);
            using var input = new MemoryStream(Encoding.ASCII.GetBytes("refresh " + new string('9', 400) + "\nrefresh\nrefresh 0\nrefresh -1\nrefresh 2147483648\nrefresh 2147483647\r\nrefresh 2\nstop\nrefresh 3\n"));
            commands.Run(input);
            Check("Accept positive int32 only; first pending request and stop win", commands.TakeRefresh() == int.MaxValue && commands.TakeRefresh() is null && stops == 1);
            var eof = new WatchCommands(() => stops++);
            eof.Run(new MemoryStream("refresh 2"u8.ToArray()));
            Check("EOF without newline does not make a request", eof.TakeRefresh() is null && stops == 2);
            Console.WriteLine($"HighlighterDeviceBattery smoke OK ({checkedCount} checks)");
            return 0;
        }
        catch (InvalidOperationException error) when (error.Message.StartsWith("smoke-check-", StringComparison.Ordinal))
        {
            Console.Error.WriteLine(error.Message);
            return 1;
        }
    }

    private static void Guard(Action<string, bool> check, string scratch)
    {
        // A new, caller-owned test directory only. No production state is opened by smoke mode.
        string folder = Path.Combine(scratch, "guard-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(folder);
        string marker = Path.Combine(folder, "device-probe.json");
        File.WriteAllText(marker, "{\"Device\":\"1234:5678\",\"Way\":\"synthetic\"}");
        check("Recover previous crash", DeviceReadStore.Start(folder) && DeviceReadStore.Book.Entry("1234:5678")!.Bad.SequenceEqual(["synthetic"]) && new FileInfo(marker).Length == 0);
        using var entered = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        var inFlight = Task.Run(() => DeviceReadStore.Probe("1234:5678", "held", () => { entered.Set(); release.Wait(); return 42; }));
        try
        {
            check("Synthetic probe starts with a durable mark", entered.Wait(TimeSpan.FromSeconds(3)) && File.ReadAllText(marker).Contains("held", StringComparison.Ordinal));
            check("Another probe cannot overwrite the active mark", DeviceReadStore.Probe("1234:5678", "other", () => 1) == 0 && File.ReadAllText(marker).Contains("held", StringComparison.Ordinal));
            DeviceReadStore.StopAccepting();
            bool rejected = false;
            try { DeviceReadStore.Finish(); } catch (InvalidOperationException) { rejected = true; }
            check("Shutdown does not erase an unfinished probe", rejected && File.ReadAllText(marker).Contains("held", StringComparison.Ordinal));
        }
        finally { release.Set(); }
        check("Only completed work clears its mark", inFlight.Wait(TimeSpan.FromSeconds(3)) && inFlight.Result == 42 && new FileInfo(marker).Length == 0);
        check("Stop prevents new probes", DeviceReadStore.Probe("1234:5678", "later", () => 1) == 0);
        DeviceReadStore.Finish();

        var malformed = Path.Combine(folder, "malformed");
        Directory.CreateDirectory(malformed);
        File.WriteAllText(Path.Combine(malformed, "device-reads.json"), "[{\"Device\":\"1234:5678\",\"Stopped\":true}]");
        check("A malformed safety book disables HID rather than forgetting blocks", !DeviceReadStore.Start(malformed) && DeviceReadStore.Faulted);
        var oversized = Path.Combine(folder, "oversized");
        Directory.CreateDirectory(oversized);
        var oversizedMark = Path.Combine(oversized, "device-probe.json");
        File.WriteAllText(oversizedMark, new string('x', 1025));
        check("An oversized marker is never cleared before validation", !DeviceReadStore.Start(oversized) && new FileInfo(oversizedMark).Length == 1025);
        var invalid = Path.Combine(folder, "invalid");
        Directory.CreateDirectory(invalid);
        var invalidMark = Path.Combine(invalid, "device-probe.json");
        File.WriteAllText(invalidMark, "{\"Device\":\"1234:5678\",\"Way\":\"test\",\"Way\":\"duplicate\"}");
        check("An ambiguous marker is never accepted or cleared", !DeviceReadStore.Start(invalid) && File.ReadAllText(invalidMark).Contains("duplicate", StringComparison.Ordinal));
    }
}
