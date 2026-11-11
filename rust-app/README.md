# Highlighter Rust workspace（R0 隔离工程）

这是 Rust 迁移计划 [§3.1](../docs/plans/2026-11-10-rust-migration-development-plan.md)
的**新增独立 workspace**，不是生产宿主，也不是 Electron 构建入口的替代品。现有
`native/*` 工程继续使用各自的 Cargo 工程与锁文件，本 workspace 不建立依赖。

工具链由 `rust-toolchain.toml` 固定为 **1.97.1**（rustfmt/clippy 一并固定）。目标平台
Windows x64；R0 不承诺 macOS/Linux 可编译。

## 成员 crate 与 R0 边界

| crate | R0 交付 | 明确不做（后续批次） |
|---|---|---|
| `contracts` | 计划 §4.2 内部 DTO（`WindowRole`/`HostContext`/`OperationRef`/`ResourceRef`/`OperationError`）；读取仓库合同 `contracts/host/host-contracts.json` 的结构化视图与共享 schema 版本常量 | 运行时校验、权限映射（R1-04）、生产协议冻结（R1） |
| `service-host` | `shared/clipboard-protocol.js` 的编码/流式解码语义移植；夹具对照测试 | SidecarSupervisor、OCR/Everything/剪贴板生命周期与诊断（R2-03） |
| `storage` | 原子 JSON 写入；开发/灰度**隔离**数据根 locator（独立 locator 文件、拒绝嵌套/越界、generation 单调） | 真实数据根迁移、SQLite、设置 normalize、凭据（R2-01/R2-02） |
| `core` | 操作注册表原型（窗口实例 + generation、取消信号、清理、旧 generation 失效） | 用例/状态机、Tauri 命令装配（R1/R4/R5） |
| `media` | 录屏导出限制类型与校验（GIF/多段/编码队列），R5 trait 骨架 | 采集后端、编码、FFmpeg argv、发布（R5） |
| `windows-platform` | 几何/DPI 基础类型与 DIP↔物理像素转换（含负坐标、舍入规则文档） | 真机 DPI/焦点/捕获/快捷键/凭据（R3）；R3 前不宣称与 Electron 完全一致 |
| `src-tauri` | R0-03 原型：Tauri 2 无窗口启动、按需创建透明浮层、副屏/负坐标定位、显示器枚举、ready/init 单次握手、`--self-test` 自检 | 生产宿主、托盘/单实例/主窗口、角色命令权限映射、真实截图/遮罩（R1/R4） |

`src-tauri/` 是计划 §7 R0-03 的**风险原型**，不是生产宿主：`tauri.conf.json` 无窗口启动、
只嵌入受控的 `prototype-ui/` 资源、最小 capability 只授予事件监听；编译/自检结果、WebView2
透明限制与未验证项见
[r0-window-prototype.md](../docs/plans/rust-migration/r0-window-prototype.md)。

## 依赖方向（计划 §3.2）

```text
用例层:  core ──> contracts
协议层:  service-host（R0 不依赖其它 crate；后续经接口接 helper）
存储层:  storage（独立）
平台层:  windows-platform（独立）
媒体层:  media（独立）
宿主:    src-tauri（R0-03 原型）──> tauri + windows-platform
```

硬约束：

- `contracts` 不访问文件/时钟/窗口；除 serde/serde_json 外无依赖，不依赖 tauri、
  windows、rusqlite/sqlx、async runtime。`contracts` 内唯一读盘代码是
  `host_contracts` 模块读取**仓库合同产物**（不是用户数据），并有依赖方向测试兜底。
- 阻塞的 UIA/OCR/图像/编码任务不进窗口事件线程；除 R0-03 窗口原型外，各 crate 均为同步、无 GUI。
- 平台能力集中在 `windows-platform`；`core` 只依赖接口/DTO，不直接调用 Win32。

## 构建与检查

在仓库根目录执行（Windows）：

```powershell
# 门禁：fmt --check -> clippy --workspace --all-targets -D warnings -> test --locked
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/rust/check-rust-app.ps1

# 单独复跑测试（本分支实测 107 passed / 0 failed；依赖已下载后离线可复跑）
cargo test --manifest-path rust-app/Cargo.toml --locked

# R0-03 原型：透明浮层自检（只在副屏显示，约 3~5 秒后自动退出；退出码 0=PASS）
cargo run --manifest-path rust-app/Cargo.toml -p highlighter-r0-window -- --self-test --hold-ms 5000
```

### R0-07 NSIS 测试包（**不是产品构建入口**）

`src-tauri/tauri.conf.json` 为 R0-07 打开了 `bundle.active=true` 与 `targets=["nsis"]`，只用于产出原型测试包，
不改变 `cargo run` 启动方式，也不替代现有 Electron 构建。用 npx 获取 Tauri CLI（不写 `package.json`）：

```powershell
cd rust-app
npx --yes @tauri-apps/cli@2 build --no-bundle --ci        # Release exe（增量约 20~30s）
npx --yes @tauri-apps/cli@2 bundle --bundles nsis --ci   # downloadBootstrapper（默认，需安装时联网）

# 其它 WebView2 模式：用 --config 覆盖（Windows PowerShell 5.1 引号会吃掉 JSON，建议写临时 JSON 文件后用 --config <路径>）
npx --yes @tauri-apps/cli@2 bundle --bundles nsis --ci --config <embedBootstrapper.json>
npx --yes @tauri-apps/cli@2 bundle --bundles nsis --ci --config <offlineInstaller.json>
```

配置覆盖示例（文件内容）：`{"bundle":{"windows":{"webviewInstallMode":{"type":"embedBootstrapper"}}}}`
（offline 模式把 `embedBootstrapper` 换成 `offlineInstaller`）。产物在
`rust-app/target/release/bundle/nsis/`（gitignore）。安装包**未签名**（`Get-AuthenticodeSignature` = `NotSigned`），
只作 R0 测试件；NSIS 配置为 per-user 安装。**手动交互安装已于 2026-11-11 实测通过**（自定义目录、HKCU 卸载键、
开始菜单快捷方式、已安装 exe 启动与缺失 Runtime 行为，见文档 §6.1）；**本机受限会话的静默 `/S` 安装仍不落盘**
（环境级限制，§6.2），**卸载链路待验证**（§6.4）。安装包未签名，不得作为发布件。必须从 `rust-app/` 目录执行 Tauri CLI（在仓库根执行会误把
`prototypes/webview-media` 当成 Tauri 项目并改写其 Cargo.toml）。实测产物哈希、WebView2 模式对照与未验证项见
[r0-installation-matrix.md](../docs/plans/rust-migration/r0-installation-matrix.md)。

脚本依次运行 `cargo fmt --all -- --check`、`cargo clippy --workspace --all-targets -- -D warnings`、
`cargo test --workspace --locked`，任一步非零即失败。除 R0-03 自检需要可见桌面外，其余测试
不需要 GUI、Electron 或网络（首次依赖下载后离线可跑）。

## 外部生成物与夹具对接状态

`contracts/host/host-contracts.json` 与 `test/fixtures/host-parity/` 由
[contract-format.md](../docs/plans/rust-migration/contract-format.md) §3/§4 的 Node 脚本
（`scripts/rust/extract-host-contracts.js`、`scripts/rust/generate-host-fixtures.js`）生成，
由 contract-inventory 任务产出并已收口。Rust 侧**只读取、不复制**，且测试对真实产物做
**严格对照**（产物缺失即失败，不再 skip）：

| Rust 测试 | 对照的真实产物 | 覆盖 |
|---|---|---|
| `crates/contracts/tests/host_contracts_file.rs` | `contracts/host/host-contracts.json` | 13 角色与 `WindowRole` 一一对应、257 个方法的 kind/channel/源码位置可解析且与 `surface.handles/listeners` 一致、10 个 errorCodes 唯一且有源码、8 项 §9.1 resourceLimits（id 集合固定；clipboard.protocol 数值=1 MiB/512 KiB/256 KiB）、6 个 sharedSchemas 版本（capture-document v3、recording-project v1、clipboard-db user_version=2、usage-db user_version=1、data-root-marker v3；settings-normalize 显式 null） |
| `crates/service-host/tests/clipboard_protocol_fixtures.rs` | `test/fixtures/host-parity/clipboard-protocol/` + `manifest.json` | 12 个 case：4 个 valid 逐帧 header/payload 字节相等；8 个 invalid 按 `failAt=feed|finish` 在**同一阶段**失败且错误码为 `invalid-frame`，feed 失败后 decoder 永久失败；manifest 与磁盘 case 双向一致 |
| `crates/media/tests/export_limits_fixtures.rs` | `test/fixtures/host-parity/recording-export-options/` | 5 个 case：`limits` 逐字段对照计划 §9.1（1 编码 + 2 等待、GIF 60 s/1280/1200/10-15-20、20 段/≥100 ms）；GIF `normalize` 对照 edge/fps/width/height/frames 与 `reason`；多段 `normalize` 对照 segments/totalDurationMs。视频分辨率/质量/fps 规范化属于 R5，未移植部分在测试输出中登记，不伪造通过 |

夹具数值/内容不得复制进 Rust 源码作为第二份真相；本仓库只把计划 §5.1/§9.1 已冻结的基线
值作为常量并注明来源。`capture-document`/`recording-project`/`settings` 三个夹具分组属于
R2/R4/R5 的消费方，本 workspace 的 R0 crate 暂不读取。

## 已知限制

- `src-tauri/` 只是 R0-03 原型：无托盘/单实例/主窗口，未做角色命令权限映射（应用
  `invoke_handler` 命令默认不受 capability ACL 约束，见原型文档 §5）；Tauri 全量依赖使
  `rust-app/target` 从 289 MiB 增至约 2.9 GiB，exe 约 13.3 MiB，均为开发机测量值。
- `clipboard-protocol` 只覆盖共享帧编解码，不含 lease/epoch/回贴等剪贴板业务语义（R3）。
- 原子写入依赖 NTFS 上同目录 `File::flush` + `rename`；Windows 没有 std 级目录 fsync，
  断电恢复证据在 R2/R8 用故障注入补齐，R0 不断言崩溃一致性。
- DPI 舍入规则是**候选实现**（半数远离零、饱和到 i32），R3 真机对照后才冻结。
- `media`/`core` 的状态机只做原型级不变量，完整状态机在 R4/R5 逐项移植。

## 相关文档

- [Rust 改造方案与开发计划](../docs/plans/2026-11-10-rust-migration-development-plan.md)
- [R0 实施报告](../docs/plans/rust-migration/r0-report.md)
- [R0 合同与夹具格式（草案 v1）](../docs/plans/rust-migration/contract-format.md)
- [R0-03 透明窗口原型报告](../docs/plans/rust-migration/r0-window-prototype.md)
