# Highlighter 设备电量监控：BrimDeck 调研与开发方案

- 日期：2026-11-20。Highlighter 调研基线：`f7710da`（5.0.1）；BrimDeck 调研基线：[main @ `f1510d0`](https://github.com/MoFeng2223/BrimDeck/tree/f1510d09677492a13a31d26bc37c3509da1b818f)。
- 状态：已按用户反馈实现直接移植。用户在自己的机器确认 BrimDeck 能读到外设电量；Highlighter 的自动化验证与实物覆盖分开记录。
- **实现：主窗口「工具箱 → 设备电量」保留 Highlighter 的界面，直接复用固定版本的 BrimDeck 外设采集器，不再做独立的 Rust / 蓝牙缓存子集。**

## 1. BrimDeck 实际怎么读

[中文 README](https://github.com/MoFeng2223/BrimDeck/blob/f1510d09677492a13a31d26bc37c3509da1b818f/README.zh-CN.md#设备电量) 描述的是显示功能，[《设备电量支持》](https://github.com/MoFeng2223/BrimDeck/blob/f1510d09677492a13a31d26bc37c3509da1b818f/docs/zh-CN/devices.md) 是连接方式/型号清单；实现是 **多路采集 → 合并设备 → 界面消费**，不是一个通用的 Windows 外设电量 API。

| 数据源 | 源码实际行为 | 迁移边界 |
|---|---|---|
| **经典蓝牙 / BLE：Windows 缓存** | [BluetoothBatteries.cs:10–57](https://github.com/MoFeng2223/BrimDeck/blob/f1510d09677492a13a31d26bc37c3509da1b818f/src/BrimDeck/Native/BluetoothBatteries.cs#L10-L57)：WinRT 分别跟踪已配对的经典蓝牙、BLE 的 `AssociationEndpoint`，读取 `System.Devices.Aep.IsConnected` 与地址；再监听 `BTH*` 的 `Device` 节点，从 `{104EA319-6EE2-4701-BD47-8DDBF425BBE5} 2`（`DEVPKEY_Bluetooth_Battery`）取值，以地址关联。经典耳机常由 HFP 上报，BLE 常由系统电池服务上报。[重新读取与合并:83–130、183–242](https://github.com/MoFeng2223/BrimDeck/blob/f1510d09677492a13a31d26bc37c3509da1b818f/src/BrimDeck/Native/BluetoothBatteries.cs#L83-L130)：端点状态和电量属性回读约 5 秒一次，因为 watcher 不能可靠报告变化；断开后 Windows 仍可能保留原值，不能用「属性存在」推断在线。 | **已迁移。** 读取 Windows 缓存不访问设备，也不保证属性一定存在或即时更新；仅列出系统当前判为已连接的端点。 |
| **BLE：设备标准电池服务** | [BluetoothBatteries.cs:251–324](https://github.com/MoFeng2223/BrimDeck/blob/f1510d09677492a13a31d26bc37c3509da1b818f/src/BrimDeck/Native/BluetoothBatteries.cs#L251-L324)：对在线 BLE 设备查 Battery Service `0x180F`，读 `0x2A19`；可选的 `Battery Level Status` [`0x2BED`](https://github.com/MoFeng2223/BrimDeck/blob/f1510d09677492a13a31d26bc37c3509da1b818f/src/BrimDeck.Core/DeviceProtocols.cs#L1921-L1934) 给出充电信息。Windows 缓存有百分比时优先用缓存；GATT 补缺值和充电状态。[订阅、轮询与清理:358–452](https://github.com/MoFeng2223/BrimDeck/blob/f1510d09677492a13a31d26bc37c3509da1b818f/src/BrimDeck/Native/BluetoothBatteries.cs#L358-L452)：可通知则订阅，否则正常轮询约 60 秒，连接恢复、手动强制读和有限重试有例外。 | 通用补充路径，但 **uncached read / discovery 会访问无线设备并可能触发连接**；订阅还会写 CCCD，不等于只读系统缓存。沿用上游方案和节流。 |
| **2.4G 接收器 / USB / 部分控制器：HID** | [Hid.cs:43–176](https://github.com/MoFeng2223/BrimDeck/blob/f1510d09677492a13a31d26bc37c3509da1b818f/src/BrimDeck/Native/Hid.cs#L43-L176) 用 SetupAPI 枚举 HID collection，取 VID/PID、接口号、usage page/usage 及报告长度。设备有标准 HID 电池 usage 就按描述符解析；否则由 [HidBatteries.cs](https://github.com/MoFeng2223/BrimDeck/blob/f1510d09677492a13a31d26bc37c3509da1b818f/src/BrimDeck/Native/HidBatteries.cs) 按型号/接口选 [DeviceProtocols.cs](https://github.com/MoFeng2223/BrimDeck/blob/f1510d09677492a13a31d26bc37c3509da1b818f/src/BrimDeck.Core/DeviceProtocols.cs) 中的协议（如 Logitech HID++、Razer、ATK），有查询-应答、只监听设备主动报告等模式，也有极少数非 HID 例外（如特定 ATK 耳机用 USB 串口）。 | **枚举到接收器 ≠ 知道外设电量或在线状态。** 获取状态的请求也可能发出 HID report；部分协议还要登记通知。保留上游型号/接口匹配和异常记录；上游支持表不是 Highlighter 真机验证清单。 |
| **Windows 游戏控制器 / XInput** | [GamingBatteries.cs:56–91、114–157](https://github.com/MoFeng2223/BrimDeck/blob/f1510d09677492a13a31d26bc37c3509da1b818f/src/BrimDeck/Native/GamingBatteries.cs#L56-L91) 用 `RawGameController.TryGetBatteryReport()` 从 `remaining/full` 换算，并排除无电池及已知占位报告。Xbox 360 无线接收器另走受限 XInput fallback，只有档位，不是精确百分比。 | 标准游戏控制器 Provider 可独立加入；没有报告、占位值或有线供电不能显示成「100%」。档位须标「估算」或展示原档。 |
| **AirPods / Beats：广播** | [AppleBatteries.cs:9–18、40–69](https://github.com/MoFeng2223/BrimDeck/blob/f1510d09677492a13a31d26bc37c3509da1b818f/src/BrimDeck/Native/AppleBatteries.cs#L9-L18) 以已连接的耳机为前提被动监听 Apple 厂商广播；依强信号和名称族匹配，解析左右耳和盒，[约 30 秒过期后回退](https://github.com/MoFeng2223/BrimDeck/blob/f1510d09677492a13a31d26bc37c3509da1b818f/src/BrimDeck/Native/AppleBatteries.cs#L105-L152)。广播地址轮换，不能证明广播来自已连接的那一副。 | 沿用上游门控与分项显示；强信号和设备族不是可靠的身份验证，附近同系列耳机仍可能误匹配。 |
| **手机：Phone Link 本机缓存** | [PhoneLinkBatteries.cs](https://github.com/MoFeng2223/BrimDeck/blob/f1510d09677492a13a31d26bc37c3509da1b818f/src/BrimDeck/Native/PhoneLinkBatteries.cs#L8-L101) 只读 `%LOCALAPPDATA%/Packages/Microsoft.YourPhone_*/LocalState/StartMenu/StartMenuCompanion.json`；[PhoneLinkCard.cs](https://github.com/MoFeng2223/BrimDeck/blob/f1510d09677492a13a31d26bc37c3509da1b818f/src/BrimDeck.Core/PhoneLinkCard.cs#L15-L46) 判为 30 分钟内可用，30 分钟至 2 小时还要求 `PhoneExperienceHost` 运行；断开、过期或没有读数则靠蓝牙。不是联网 API，也不是 Windows 稳定公开的电量 API。 | 保留只读本机卡片路径，仅投影电量、名称与充电状态；不联网、不读消息。 |
| **本机电池（不是 BrimDeck 的外设页）** | [PowerSensors.cs:241–305](https://github.com/MoFeng2223/BrimDeck/blob/f1510d09677492a13a31d26bc37c3509da1b818f/src/BrimDeck/Native/PowerSensors.cs#L241-L305) 的系统监控另用 Win32 `GetSystemPowerStatus` 快速取值，再用 `Windows.Devices.Power.Battery` 做更细的容量/功率报告。 | Highlighter 可以在同一页单列「本机电池」；首版只取系统汇总百分比与供电状态，不做电池健康/功耗/续航预测。 |

**合并与安全。** [DeviceBatteries.cs:27–84、131–184](https://github.com/MoFeng2223/BrimDeck/blob/f1510d09677492a13a31d26bc37c3509da1b818f/src/BrimDeck/Native/DeviceBatteries.cs#L131-L184) 在页面/收起读数有需求时启动来源，离开后按内存模式延迟停止；来源没枚举完不算「无设备」，系统恢复时补读。[DeviceRoster:401–499](https://github.com/MoFeng2223/BrimDeck/blob/f1510d09677492a13a31d26bc37c3509da1b818f/src/BrimDeck.Core/Devices.cs#L401-L499) 以同一 key/蓝牙地址优先合并，控制器 VID/PID 仅在两边各一个候选时兜底；选择有有效读数的较高优先级源，不按最近回包简单覆盖。[DeviceReads.cs](https://github.com/MoFeng2223/BrimDeck/blob/f1510d09677492a13a31d26bc37c3509da1b818f/src/BrimDeck.Core/DeviceReads.cs#L9-L45)、[DeviceReadStore.cs](https://github.com/MoFeng2223/BrimDeck/blob/f1510d09677492a13a31d26bc37c3509da1b818f/src/BrimDeck/Native/DeviceReadStore.cs#L6-L77) 对部分多协议设备最多探三轮、记忆成功读法、对断连或未结束的入盘探测标记停用坏读法。上游所谓「只读取」是不配对、不改用户配置、不给设备发修改设置的操作，并不等于通信层没有写操作。Highlighter 隔离保存 HID 读法和保护状态，不复用 BrimDeck 应用数据。

## 2. Highlighter 实现

### 页面和生命周期

- 「工具箱 → 设备电量」位于「录屏」之后，使用同一个主窗口，不安装 BrimDeck、不导入其界面或配置。显示本机电池、可识别的外设、数据来源、充电／供电状态和上次收到快照的时间。`0%` 是合法读数；未知、休眠旧值、估算及低电量分别标注。有数据但某个来源失败时不把它当成「无设备」。
- [设备电量页](<../../config/routes/device-battery.js>) 订阅由 [preload](<../../preload.js>) 公开的快照，不在渲染进程轮询；视图销毁时取消订阅，按快照 revision 拒绝迟到回复。鼠标、键盘、头戴耳机和耳塞使用对应前置图标，其余及未知类型用笔记本图标。手动刷新期间保留可用列表，在按钮上提示进度，采集结果回到当前页；自动更新不重复打断读屏。
- [功能接线](<../../main/services/device-battery-feature.js>) 只在真实主窗口可见、未最小化、系统未挂起且路由为 `device-battery` 时运行采集器；切出、隐藏、最小化、关闭、renderer 崩溃或系统挂起会停止。关页先关闭命令 pipe，最多约 2.8 秒后主进程终止未退出的子进程；等旧进程退出再打开新会话。系统恢复后约 2 秒才启动，等待外设重连。未进入页面不运行采集器，也没有托盘常驻采样。

### 原生与 IPC

- [采集器源码](<../../native/device-battery/Program.cs>) 为自包含 .NET 10 Windows x64 EXE，API 最低基线为 Windows 10 2004／19041，实际跨版本覆盖待验证。复用上游 C# 的蓝牙缓存、BLE GATT、标准及厂商 HID、Windows 手柄／XInput、AirPods／Beats 广播、Phone Link 缓存和设备合并。本机电池另用 Win32 `GetSystemPowerStatus`，不从是否插电猜充电。USB／接收器仍只支持读法匹配的设备；AirPods、Phone Link 受各自读数来源条件限制。
- [子进程服务](<../../main/services/device-battery-service.js>) 只执行固定路径上的 `--watch --state-dir <应用自己的目录>`，没有 shell。stdin 接受 `refresh <序号>`、`stop` 或 EOF；stdout 为版本化 JSON Lines。手动刷新启动一轮可查询来源的读取，只有匹配序号的快照才完成请求；普通心跳不视为完成。原生等待最多 8 秒，超时带已有的部分结果返回，后续读数仍会推送。主进程合并重复请求，冷却期内的点击排队而不丢弃，并设 17 秒兜底。被动广播、休眠的外设以及 Windows 缓存不保证每次都有新电量。首次枚举约 10 秒仍未完全结束时可返回 `partial`；主进程总启动等待 15 秒，45 秒无快照心跳则报不可用，不无限重启。
- [IPC 注册](<../../main/ipc/device-battery-ipc.js>) 仅接受当前 main 角色的本地顶层 frame：无参快照和无参刷新，另有单向快照通知。[数据协议](<../../main/services/device-battery-protocol.js>) 限制大小、字段和百分比范围，把硬件 key 投影成进程内稳定的不透明 ID；设备名称以纯文本渲染。渲染器拿不到原始蓝牙地址、设备路径、序列号，也不能指定硬件命令。
- [设备探测保护](<../../native/device-battery/Vendor/BrimDeck.Native/DeviceReadStore.cs>) 持有 Highlighter 私有状态目录的独占租约，首次自适应 HID 读法先写透探测标记并保留上次异常的禁用记录，未完成时不清标记；目录不可安全使用时跳过相关采集并报告部分结果。状态目录在 Highlighter 配置定位目录下，独立于可迁移的数据根；不会写入 BrimDeck 的状态。上游 BLE 订阅和厂商协议可能向设备发送用于获取电量的请求／通知登记，不配对、不改固件、不上传数据。

### 构建、许可与验证

- 开发时安装 x64 .NET SDK `10.0.404`（或设置 `DOTNET_EXE` 指向对应 SDK），执行 `npm run build:device-battery -- -Verify`。它验证版本、协议、模拟采集、刷新和 stop／EOF，不接触真实外设。已有依赖的本地开发可只构建此模块，再在清除 `ELECTRON_RUN_AS_NODE` 的开发 shell 启动 Electron，而不必执行带 `stop:app` 的全量原生构建。
- [发布配置](<../../package.json>) 将完整自包含运行时从 `native/device-battery/bin/` 放进 `resources/native/device-battery/`，不进 ASAR；使用者无需安装 .NET。该布局约 158 MiB 未压缩，不能等同于安装包增量。[发行验证](<../../scripts/verify-release.ps1>) 检查 x64、依赖文件、协议版本、无硬件 smoke；签名发行也校验采集器签名。Windows CI 对拉取请求单独构建/自测，正式发行随现有 native 构建执行。
- 保留 [BrimDeck Apache-2.0](<../third-party/LICENSE-BrimDeck.txt>) 及 [第三方设备协议许可和归属](<../third-party/NOTICE-BrimDeck-device-battery.txt>)，随应用及 helper 发布。该模块的来源和改动在 [原生模块说明](<../../native/device-battery/README.md>) 中记录。
- [服务测试](<../../test/device-battery-service.test.js>)、[IPC 测试](<../../test/device-battery-ipc.test.js>)、[页面测试](<../../test/device-battery-page.test.js>) 和 [Electron E2E](<../../e2e/device-battery.spec.js>) 覆盖读数投影、输入边界、状态变化和按需停止。模拟 E2E 只可在隔离的未打包开发环境启用，不能代表具体设备已在 Highlighter 中验证。
- **刷新修正版验证**：229 项原生无硬件检查、59 项定向 Node 测试、2 项 Electron E2E、打包后 sidecar 与主进程的合成管道、未签名便携版启动探针均通过。E2E 在同一页验证一次点击将模拟读数由 0% 更新为 1%，并检查四款前置图标；打包管道也验证读数未变、部分结果和晚到读数。本轮未重跑全量套件或真实外设采集。
- **首次迁移的全量基线**：`npm test` 为 2,209/2,214。3 项界面断言在未修改的 HEAD 上也失败；剪贴板 lease 在全量运行失败但两次单跑通过；截图像素断言在未改源码加上工作区原有的新应用图标时复现，使用 HEAD 图标则通过（测试将该图标用作输入图）；设备电量改动未涉及应用图标或这些断言。
- **实机验收仍需对照用户已测的设备**：退出已在托盘运行的 Highlighter 和正在探测设备的 BrimDeck，再从可写的本地磁盘打开测试版，进入设备电量页。记录设备型号、USB／2.4G／蓝牙等连接方式、读数、断连重连和离页是否停止。上游型号表不是此处的实机覆盖清单；正式签名版及 Windows 10 应分别验收。
