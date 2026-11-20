// Modified for Highlighter: health, bounded lifecycle/drain, coalesced cache rereads, manual read completion and unknown values.
using System.Runtime.InteropServices.WindowsRuntime;
using System.Windows.Threading;
using BrimDeck.Core;
using Windows.Devices.Bluetooth;
using Windows.Devices.Bluetooth.GenericAttributeProfile;
using Windows.Devices.Enumeration;

namespace BrimDeck.Native;

// Paired Bluetooth devices and the battery Windows itself reads for them, as Settings › Bluetooth shows it: the device node's
// DEVPKEY_Bluetooth_Battery ({104EA319-6EE2-4701-BD47-8DDBF425BBE5}, 2), which Windows keeps for hands-free headsets (the
// AT+IPHONEACCEV/+BIEV level on the HFP node) and for Bluetooth LE devices with a battery service (on the BTHLE node). Two
// watchers follow the paired devices (association endpoints, for the name, the kind and whether each is connected) and the
// Bluetooth device nodes (for the level). Windows does not tell when a node's level changes (BlueGauge's notes), so the
// connected devices' levels are read again from its cache every 5 seconds (DevicePolling.Cached), which reaches no device.
// Windows leaves the last level on a node after the device disconnects, so only connected devices are listed. Every connected
// LE device's own battery service (GattBattery) is followed too: its level where Windows has none, and whether it charges where
// the device tells it (Battery Level Status), which Windows never keeps.
internal sealed class BluetoothBatteries(Dispatcher dispatcher, Action<DeviceSource, IReadOnlyList<DeviceBattery>> report) : IDeviceSource
{
    private const string BatteryKey = "{104EA319-6EE2-4701-BD47-8DDBF425BBE5} 2";
    private const string Connected = "System.Devices.Aep.IsConnected", Address = "System.Devices.Aep.DeviceAddress", Category = "System.Devices.Aep.Category",
        Appearance = "System.Devices.Aep.Bluetooth.Le.Appearance";
    private static readonly string[] EndpointProperties = [Connected, Address, Category, Appearance];

    private sealed record Endpoint(string Id, string Name, string? Address, string? Category, int? Appearance, bool Connected, bool LowEnergy);
    private readonly Dictionary<string, Endpoint> _endpoints = [];
    // Device node id → (address, level).
    private readonly Dictionary<string, (string Address, int? Level)> _nodes = [];
    private readonly Dictionary<string, GattBattery> _gatt = [];
    private readonly List<GattBattery> _closing = [];
    private sealed record PropertyRead(long At, Task<bool> Finished);
    private readonly Dictionary<(string Id, bool Node), PropertyRead> _reading = [];
    private readonly HashSet<(string Id, bool Node)> _readFailed = [];
    private readonly TaskCompletionSource<bool> _initialListing = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private bool _watchFailed;
    private readonly List<DeviceWatcher> _watchers = [];
    private readonly List<DispatcherTimer> _followUps = [];
    private DispatcherTimer? _poll;
    private DeviceDemand _demand;
    private bool _nodesListed;
    private int _generation;

    public bool Listed => _listed == 3 && _gatt.Values.All(reader => reader.Done);
    public bool Faulted => _watchFailed || _readFailed.Count > 0 || _reading.Values.Any(read => Environment.TickCount64 - read.At >= 10_000)
        || _gatt.Values.Any(reader => reader.Faulted);
    public bool Drained => _reading.Count == 0 && _closing.All(reader => reader.Drained);
    private int _listed;

    public void Start(DeviceDemand demand)
    {
        bool running = _watchers.Count > 0;
        _demand = demand;
        if (!running)
        {
            int generation = ++_generation;
            Watch(BluetoothDevice.GetDeviceSelectorFromPairingState(true), EndpointProperties, DeviceInformationKind.AssociationEndpoint, generation, lowEnergy: false);
            Watch(BluetoothLEDevice.GetDeviceSelectorFromPairingState(true), EndpointProperties, DeviceInformationKind.AssociationEndpoint, generation, lowEnergy: true);
            Watch("System.Devices.DeviceInstanceId:~<\"BTH\"", [BatteryKey], DeviceInformationKind.Device, generation, lowEnergy: null);
        }
        // The page and the collapsed reading poll the GATT levels.
        if (demand == DeviceDemand.Watch)
        {
            _poll ??= new DispatcherTimer(DispatcherPriority.Background, dispatcher) { Interval = DevicePolling.Cached };
            _poll.Tick -= PollTick; _poll.Tick += PollTick; _poll.Start();
        }
        else _poll?.Stop();
        Publish();
    }

    public void Stop()
    {
        _generation++;
        _demand = DeviceDemand.None;
        foreach (var watcher in _watchers)
        {
            try { if (watcher.Status is DeviceWatcherStatus.Started or DeviceWatcherStatus.EnumerationCompleted) watcher.Stop(); } catch { }
        }
        _watchers.Clear();
        _initialListing.TrySetResult(false);
        _poll?.Stop();
        foreach (var timer in _followUps) timer.Stop();
        _followUps.Clear();
        foreach (var gatt in _gatt.Values) Retire(gatt);
        _gatt.Clear(); _endpoints.Clear(); _nodes.Clear(); _nodesListed = false; _listed = 0;
        report(DeviceSource.Bluetooth, []); report(DeviceSource.Gatt, []);
    }

    public void ReadNow() => ReadAll(force: true);

    public async Task<bool> RefreshNowAsync(CancellationToken cancellation)
    {
        if (_demand != DeviceDemand.Watch || DeviceReadStore.Stopping) return false;
        bool listed = await _initialListing.Task.WaitAsync(cancellation);
        cancellation.ThrowIfCancellationRequested();
        if (_demand != DeviceDemand.Watch || DeviceReadStore.Stopping) return false;
        int generation = _generation;
        // Refresh connection state before selecting nodes: an endpoint may have just reconnected.
        var endpoints = await Task.WhenAll(_endpoints.Keys.ToArray().Select(id => Reread(id, generation, node: false))).WaitAsync(cancellation);
        cancellation.ThrowIfCancellationRequested();
        if (generation != _generation || DeviceReadStore.Stopping) return false;
        var updates = ConnectedNodes().Select(id => Reread(id, generation)).Concat(_gatt.Values.ToArray().Select(reader => reader.RefreshNowAsync()));
        var results = await Task.WhenAll(updates).WaitAsync(cancellation);
        return listed && generation == _generation && endpoints.All(ok => ok) && results.All(ok => ok) && !Faulted;
    }

    // Windows' own levels for the connected devices (a property read from its cache, about half a millisecond each), and the
    // GATT values whose devices send no notices, once a minute or (force) now. Paired endpoints are also read again from Windows'
    // cache: DeviceWatcher does not always raise Updated when IsConnected changes on sleep or reconnect.
    private static bool ShouldRereadNode(KeyValuePair<string, (string Address, int? Level)> node)
        => node.Value.Level is not null || !node.Key.Contains("BTHLEDevice", StringComparison.OrdinalIgnoreCase);

    private void ReadAll(bool force = false)
    {
        if (_demand != DeviceDemand.Watch || DeviceReadStore.Stopping) return;
        int generation = _generation;
        foreach (var id in _endpoints.Keys.ToArray()) _ = Reread(id, generation, node: false);
        foreach (var gatt in _gatt.Values.ToArray()) gatt.Poll(force);
        foreach (var id in ConnectedNodes()) _ = Reread(id, generation);
    }

    private string[] ConnectedNodes()
    {
        var connected = _endpoints.Values.Where(endpoint => endpoint.Connected).Select(endpoint => endpoint.Address).OfType<string>().ToHashSet();
        return _nodes.Where(node => connected.Contains(node.Value.Address) && ShouldRereadNode(node)).Select(node => node.Key).ToArray();
    }

    private void RereadAddressNodes(string address, int generation)
    {
        foreach (var (id, _) in _nodes.Where(node => node.Value.Address == address && ShouldRereadNode(node)).ToArray())
            _ = Reread(id, generation);
    }
    private void ScheduleNodeFollowUp(string address, int generation)
    {
        var timer = new DispatcherTimer(DispatcherPriority.Background, dispatcher) { Interval = TimeSpan.FromSeconds(2) };
        _followUps.Add(timer);
        timer.Tick += (_, _) =>
        {
            timer.Stop();
            _followUps.Remove(timer);
            if (generation != _generation || _demand != DeviceDemand.Watch) return;
            RereadAddressNodes(address, generation);
            if (_gatt.TryGetValue(address, out var reader)) reader.Poll(force: true);
        };
        timer.Start();
    }
    private Task<bool> Reread(string id, int generation, bool node = true)
    {
        if (DeviceReadStore.Stopping) return Task.FromResult(false);
        if (_reading.TryGetValue((id, node), out var running)) return running.Finished;
        var completion = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        _reading[(id, node)] = new(Environment.TickCount64, completion.Task);
        ReadProperties();
        return completion.Task;

        async void ReadProperties()
        {
            bool ok = false;
            try
            {
                var info = await DeviceInformation.CreateFromIdAsync(id, node ? [BatteryKey] : EndpointProperties,
                    node ? DeviceInformationKind.Device : DeviceInformationKind.AssociationEndpoint);
                if (generation != _generation || DeviceReadStore.Stopping) return;
                if (!(node ? _nodes.ContainsKey(id) : _endpoints.ContainsKey(id))) { ok = true; return; }
                if (info is null) { _readFailed.Add((id, node)); return; }
                var properties = Copy(info.Properties);
                if (node) Node(id, properties, update: true); else Update(id, properties);
                _readFailed.Remove((id, node));
                ok = true;
            }
            catch (Exception error) when (error is not OutOfMemoryException)
            {
                if (generation == _generation) _readFailed.Add((id, node));
            }
            finally { _reading.Remove((id, node)); completion.TrySetResult(ok); }
        }
    }
    private void PollTick(object? sender, EventArgs e) => ReadAll();

    private void Watch(string aqs, string[] properties, DeviceInformationKind kind, int generation, bool? lowEnergy)
    {
        DeviceWatcher watcher;
        try { watcher = DeviceInformation.CreateWatcher(aqs, properties, kind); }
        catch { WatcherFailed(); return; }
        void Post(Action action) => dispatcher.BeginInvoke(DispatcherPriority.Background, () => { if (generation == _generation && !DeviceReadStore.Stopping) action(); });
        bool node = lowEnergy is null;
        watcher.Added += (_, info) => { var id = info.Id; var name = info.Name; var props = Copy(info.Properties); Post(() => { if (node) Node(id, props); else Add(id, name, props, lowEnergy == true); }); };
        watcher.Updated += (_, update) => { var id = update.Id; var props = Copy(update.Properties); Post(() => { if (node) Node(id, props, update: true); else Update(id, props); }); };
        watcher.Removed += (_, update) => { var id = update.Id; Post(() => { _readFailed.Remove((id, node)); if (node) _nodes.Remove(id); else _endpoints.Remove(id); Publish(); }); };
        watcher.EnumerationCompleted += (_, _) => Post(() =>
        {
            if (node) _nodesListed = true;
            _listed++;
            Publish();
            if (_listed == 3) _initialListing.TrySetResult(true);
        });
        watcher.Stopped += (_, _) => Post(WatcherFailed);
        try { watcher.Start(); _watchers.Add(watcher); } catch { WatcherFailed(); }
    }

    private void WatcherFailed()
    {
        _watchFailed = true;
        _initialListing.TrySetResult(false);
    }
    // Windows sometimes reports the same property twice (e.g. System.Devices.InterfaceEnabled), and ToDictionary
    // throws on a duplicate key; indexer assignment keeps the last value instead, so callers never crash on it.
    private static Dictionary<string, object?> Copy(IReadOnlyDictionary<string, object> properties)
    {
        var copy = new Dictionary<string, object?>(properties.Count);
        foreach (var pair in properties) copy[pair.Key] = pair.Value;
        return copy;
    }

    private static string? EndpointAddress(string id, Dictionary<string, object?> properties)
        => Devices.AddressIn(Text(properties, Address)) ?? Devices.AddressIn(id);

    private void Add(string id, string name, Dictionary<string, object?> properties, bool lowEnergy)
    {
        _endpoints[id] = new Endpoint(id, name, EndpointAddress(id, properties), Text(properties, Category), properties.TryGetValue(Appearance, out var a) && a is ushort raw ? raw : null,
            properties.TryGetValue(Connected, out var c) && c is true, lowEnergy);
        Publish();
    }
    private void Update(string id, Dictionary<string, object?> properties)
    {
        if (!_endpoints.TryGetValue(id, out var known)) return;
        bool wasConnected = known.Connected;
        var updated = known;
        if (properties.TryGetValue(Connected, out var c)) updated = updated with { Connected = c is true };
        if (properties.TryGetValue(Address, out _)) updated = updated with { Address = EndpointAddress(id, properties) ?? updated.Address };
        if (properties.TryGetValue(Category, out _)) updated = updated with { Category = Text(properties, Category) };
        if (properties.TryGetValue(Appearance, out var a) && a is ushort raw) updated = updated with { Appearance = raw };
        if (updated == known) return;
        _endpoints[id] = updated;
        Publish();
        if (!wasConnected && updated.Connected && updated.Address is { } reconnected)
        {
            RereadAddressNodes(reconnected, _generation);
            ScheduleNodeFollowUp(reconnected, _generation);
        }
    }
    private void Node(string id, Dictionary<string, object?> properties, bool update = false)
    {
        if (Devices.AddressIn(id) is not { } address) return;
        bool has = properties.TryGetValue(BatteryKey, out var value);
        int? level = has && value is byte b && b <= 100 ? b : has && value is int i && i is >= 0 and <= 100 ? i : null;
        // An update that does not carry the level keeps the one known.
        if (update && !has && _nodes.TryGetValue(id, out var known)) level = known.Level;
        if (level is null && !_nodes.ContainsKey(id) && !update) { _nodes[id] = (address, null); return; }
        if (_nodes.TryGetValue(id, out var was) && was == (address, level)) return;
        _nodes[id] = (address, level);
        Publish();
    }
    private static string? Text(Dictionary<string, object?> properties, string key) => properties.TryGetValue(key, out var value) ? value switch
    {
        string text => text,
        string[] list => string.Join(",", list),
        _ => null
    } : null;

    private void Publish()
    {
        if (DeviceReadStore.Stopping) return;
        _closing.RemoveAll(reader => reader.Drained);
        var plain = new List<DeviceBattery>();
        var gatt = new List<DeviceBattery>();
        var wanted = new HashSet<string>();
        foreach (var endpoint in _endpoints.Values)
        {
            if (!endpoint.Connected) continue;
            string? address = endpoint.Address;
            if (address is null) continue;
            int? level = _nodes.Values.Where(node => node.Address == address && node.Level is not null).Select(node => node.Level).FirstOrDefault();
            string? hardware = _nodes.Where(node => node.Value.Address == address).Select(node => Devices.HardwareIn(node.Key)).FirstOrDefault(found => found is not null);
            var kind = Devices.Kind(endpoint.Category, endpoint.Appearance, endpoint.Name);
            // A connected LE device is followed through its own battery service once the nodes are listed: its level where Windows
            // has none, and whether it charges where it tells.
            bool? charging = null;
            if (endpoint.LowEnergy && _nodesListed && _demand == DeviceDemand.Watch)
            {
                wanted.Add(address);
                if (!_gatt.TryGetValue(address, out var reader) || reader.EndpointId != endpoint.Id)
                {
                    if (reader is not null) Retire(reader);
                    reader = new GattBattery(endpoint.Id, ulong.Parse(address, System.Globalization.NumberStyles.HexNumber), dispatcher, () => Publish());
                    _gatt[address] = reader; reader.Open();
                }
                charging = reader.Charging;
                if (level is null)
                {
                    if (reader.Level is { } read)
                    {
                        gatt.Add(new DeviceBattery("bt:" + address, endpoint.Name, kind, DeviceSource.Gatt, Devices.Clamp(read)) { Address = address, Hardware = hardware, Charging = charging == true, ChargingUnknown = charging is null });
                        continue;
                    }
                    if (!reader.Done) continue;
                }
            }
            // A peripheral that reports nothing shows as not available. Anything else (a phone, a computer, a display, a network
            // device) is listed only with a level: without one it is a line that says nothing. The settings can switch each off.
            if (level is null && kind is DeviceKind.Other or DeviceKind.Phone) continue;
            plain.Add(new DeviceBattery("bt:" + address, endpoint.Name, kind, DeviceSource.Bluetooth, level is { } l ? Devices.Clamp(l) : null)
            { Address = address, Hardware = hardware, Charging = charging == true, ChargingUnknown = charging is null });
        }
        foreach (var gone in _gatt.Keys.Where(address => !wanted.Contains(address)).ToList()) { Retire(_gatt[gone]); _gatt.Remove(gone); }
        report(DeviceSource.Bluetooth, plain);
        report(DeviceSource.Gatt, gatt);
    }

    private void Retire(GattBattery reader)
    {
        reader.Dispose();
        if (!reader.Drained) _closing.Add(reader);
    }

    public void Dispose() => Stop();

    // One LE device's battery service: its level (0x2A19) and, where the device has it, its Battery Level Status (Battery Service
    // 1.1, whose power state says whether it charges), each read once and then followed through its notices, as BlueZ, Android
    // and BlueGauge follow the level. Asking for the notices is the one thing written (the characteristics' client configuration,
    // which every Bluetooth host writes; BleBatterySubscribe writes the same so that Windows' own reading stays current). A value
    // whose device cannot send notices is read again once a minute at most (DevicePolling.Gatt): each read reaches the device.
    // Done once the first read has finished, with or without a level.
    private sealed class GattBattery(string endpointId, ulong address, Dispatcher dispatcher, Action changed) : IDisposable
    {
        private static readonly int[] RetryDelaysMs = [1500, 4000, 10000];
        private BluetoothLEDevice? _device;
        private GattDeviceService? _service;
        private GattCharacteristic? _level, _status;
        private bool _levelNotifies, _statusNotifies, _levelReadable, _statusReadable, _busy, _disposed, _sawDisconnect, _reopen;
        private TaskCompletionSource<bool>? _operation;
        private long _readAt;
        private int _retries;
        private DispatcherTimer? _retry;
        public string EndpointId => endpointId;
        public int? Level { get; private set; }
        public bool? Charging { get; private set; }
        public bool Done { get; private set; }
        private bool _faulted;
        public bool Faulted => _faulted || _busy && Environment.TickCount64 - _readAt >= 10_000;
        public bool Drained => !_busy;

        public async void Open()
        {
            if (_busy || _disposed || DeviceReadStore.Stopping) return;
            BeginRead();
            _readAt = Environment.TickCount64;
            try
            {
                _faulted = false;
                _device = await BluetoothLEDevice.FromIdAsync(endpointId);
                if (_device is null && !_disposed && !DeviceReadStore.Stopping) _device = await BluetoothLEDevice.FromBluetoothAddressAsync(address);
                if (_device is not null && !_disposed && !DeviceReadStore.Stopping)
                {
                    _device.ConnectionStatusChanged += ConnectionChanged;
                    var services = await _device.GetGattServicesForUuidAsync(GattServiceUuids.Battery, BluetoothCacheMode.Cached);
                    if ((services.Status != GattCommunicationStatus.Success || services.Services.Count == 0)
                        && !_disposed && !DeviceReadStore.Stopping && _device.ConnectionStatus == BluetoothConnectionStatus.Connected)
                    {
                        foreach (var old in services.Services) old.Dispose();
                        services = await _device.GetGattServicesForUuidAsync(GattServiceUuids.Battery, BluetoothCacheMode.Uncached);
                    }
                    if (services.Status == GattCommunicationStatus.Success && services.Services.Count > 0)
                    {
                        _service = services.Services[0];
                        foreach (var other in services.Services.Skip(1)) other.Dispose();
                        var characteristics = await _service.GetCharacteristicsAsync(BluetoothCacheMode.Cached);
                        if (characteristics.Status != GattCommunicationStatus.Success
                            && !_disposed && !DeviceReadStore.Stopping && _device.ConnectionStatus == BluetoothConnectionStatus.Connected)
                        {
                            characteristics = await _service.GetCharacteristicsAsync(BluetoothCacheMode.Uncached);
                        }
                        if (characteristics.Status == GattCommunicationStatus.Success)
                        {
                            _level = characteristics.Characteristics.FirstOrDefault(c => c.Uuid == GattCharacteristicUuids.BatteryLevel);
                            _status = characteristics.Characteristics.FirstOrDefault(c => c.Uuid == BatteryService.LevelStatus);
                            _levelReadable = CanRead(_level);
                            _statusReadable = CanRead(_status);
                        }
                        else _faulted = true;
                    }
                    else
                    {
                        _faulted = services.Status != GattCommunicationStatus.Success;
                        foreach (var old in services.Services) old.Dispose();
                    }
                }
                else if (_device is null) _faulted = true;
                if (_level is not null && !_disposed && !DeviceReadStore.Stopping) _levelNotifies = await Follow(_level);
                if (_status is not null && !_disposed && !DeviceReadStore.Stopping) _statusNotifies = await Follow(_status);
                await Read(all: true);
            }
            catch { _faulted = true; }
            await dispatcher.InvokeAsync(() => EndRead(opening: true));
        }

        private void BeginRead()
        {
            _busy = true;
            _operation = new(TaskCreationOptions.RunContinuationsAsynchronously);
        }

        private void EndRead(bool opening)
        {
            var operation = _operation;
            _operation = null;
            _busy = false;
            bool success = false;
            try
            {
                if (_disposed || DeviceReadStore.Stopping) { Close(); return; }
                if (_reopen) { _reopen = false; Close(); Done = false; _retries = 0; Open(); return; }
                if (opening) Done = true;
                if (Level is null) ScheduleRetry();
                if (opening) changed(); // Open has accumulated readings; publish once before completing.
                success = !_faulted;
            }
            finally { operation!.TrySetResult(success); }
        }

        private void ConnectionChanged(BluetoothLEDevice sender, object args)
        {
            var status = sender.ConnectionStatus;
            dispatcher.BeginInvoke(DispatcherPriority.Background, () =>
            {
                if (_disposed || !ReferenceEquals(sender, _device)) return;
                if (status == BluetoothConnectionStatus.Disconnected) { _sawDisconnect = true; return; }
                bool reopen = _sawDisconnect;
                _sawDisconnect = false;
                if (!reopen && Level is not null) return;
                if (_busy) { if (reopen) _reopen = true; return; }
                if (reopen || _level is null) { Close(); Done = false; _retries = 0; Open(); }
                else PollAsync(force: false, retry: true);
            });
        }

        private void ScheduleRetry()
        {
            if (_disposed || Level is not null || _retries >= RetryDelaysMs.Length || _retry?.IsEnabled == true) return;
            _retry ??= new DispatcherTimer(DispatcherPriority.Background, dispatcher);
            _retry.Tick -= RetryTick; _retry.Tick += RetryTick;
            _retry.Interval = TimeSpan.FromMilliseconds(RetryDelaysMs[_retries++]);
            _retry.Start();
        }
        private void RetryTick(object? sender, EventArgs e)
        {
            _retry?.Stop();
            if (_disposed || Level is not null) return;
            PollAsync(force: false, retry: true);
        }

        // Notices asked for, where the characteristic sends them; true when the device took the request.
        private async Task<bool> Follow(GattCharacteristic characteristic)
        {
            var properties = characteristic.CharacteristicProperties;
            var mode = properties.HasFlag(GattCharacteristicProperties.Notify) ? GattClientCharacteristicConfigurationDescriptorValue.Notify
                : properties.HasFlag(GattCharacteristicProperties.Indicate) ? GattClientCharacteristicConfigurationDescriptorValue.Indicate
                : GattClientCharacteristicConfigurationDescriptorValue.None;
            if (mode == GattClientCharacteristicConfigurationDescriptorValue.None) return false;
            characteristic.ValueChanged += ValueChanged;
            try { return await characteristic.WriteClientCharacteristicConfigurationDescriptorAsync(mode) == GattCommunicationStatus.Success; }
            catch { return false; }
        }

        private void ValueChanged(GattCharacteristic sender, GattValueChangedEventArgs args)
        {
            var value = args.CharacteristicValue.ToArray();
            bool level = sender.Uuid == GattCharacteristicUuids.BatteryLevel;
            dispatcher.BeginInvoke(DispatcherPriority.Background, () => Take(level, value));
        }

        // The values whose devices send no notices, once a minute or (force) now.
        public void Poll(bool force) => PollAsync(force, retry: false);
        public Task<bool> RefreshNowAsync()
        {
            // Join discovery or a read already in flight. Otherwise, proactively read readable BAS fields even if subscribed.
            if (_operation is null) PollAsync(force: true, retry: false, manual: true);
            return _operation?.Task ?? Task.FromResult(Done && !Faulted);
        }

        private static bool CanRead(GattCharacteristic? characteristic) => characteristic is not null
            && (characteristic.CharacteristicProperties & GattCharacteristicProperties.Read) != 0;

        private async void PollAsync(bool force, bool retry, bool manual = false)
        {
            if (!Done || _busy || _disposed || DeviceReadStore.Stopping) return;
            if (_level is null && !(manual && _statusReadable))
            {
                if (retry || force && Environment.TickCount64 - _readAt >= 5000)
                {
                    Close();
                    Done = false;
                    Open();
                }
                return;
            }
            bool needLevel = _levelReadable && (manual || !_levelNotifies || Level is null);
            bool needStatus = _statusReadable && (manual || !_statusNotifies);
            if (!(needLevel || needStatus)) return;
            if (!force && !retry && Environment.TickCount64 - _readAt < (long)DevicePolling.Gatt.TotalMilliseconds) return;
            BeginRead();
            try { _faulted = false; await Read(all: manual); } catch { _faulted = true; }
            EndRead(opening: false);
        }

        private async Task Read(bool all)
        {
            _readAt = Environment.TickCount64;
            foreach (var (characteristic, need, level) in new[] { (_level, _levelReadable && (all || !_levelNotifies || Level is null), true), (_status, _statusReadable && (all || !_statusNotifies), false) })
            {
                if (characteristic is null || !need || _disposed || DeviceReadStore.Stopping) continue;
                var result = await characteristic.ReadValueAsync(BluetoothCacheMode.Uncached);
                if (result.Status == GattCommunicationStatus.Success && result.Value is { } value)
                {
                    var bytes = value.ToArray();
                    await dispatcher.InvokeAsync(() => Take(level, bytes));
                }
                else if (result.Status != GattCommunicationStatus.Success) _faulted = true;
            }
        }

        private void Take(bool level, byte[] value)
        {
            if (_disposed) return;
            int? newLevel = Level;
            bool? newCharging = Charging;
            if (level) { if (value.Length > 0) newLevel = value[0] <= 100 ? value[0] : null; }
            else newCharging = BatteryService.Charging(value);
            if (newLevel is not null) _retry?.Stop();
            if (newLevel == Level && newCharging == Charging) return;
            Level = newLevel; Charging = newCharging;
            if (Done) changed();
        }

        public void Dispose()
        {
            _disposed = true;
            _retry?.Stop();
            if (!_busy) Close();
        }

        private void Close()
        {
            _retry?.Stop();
            try
            {
                if (_device is not null) _device.ConnectionStatusChanged -= ConnectionChanged;
                if (_level is not null) _level.ValueChanged -= ValueChanged;
                if (_status is not null) _status.ValueChanged -= ValueChanged;
                _service?.Dispose(); _device?.Dispose();
            }
            catch { }
            _level = _status = null; _service = null; _device = null;
            _levelNotifies = _statusNotifies = _levelReadable = _statusReadable = _sawDisconnect = false;
        }
    }
}

