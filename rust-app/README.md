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
| `service-host` | `shared/clipboard-protocol.js` 的编码/流式解码语义移植；夹具对照测试骨架 | SidecarSupervisor、OCR/Everything/剪贴板生命周期与诊断（R2-03） |
| `storage` | 原子 JSON 写入；开发/灰度**隔离**数据根 locator（独立 locator 文件、拒绝嵌套/越界、generation 单调） | 真实数据根迁移、SQLite、设置 normalize、凭据（R2-01/R2-02） |
| `core` | 操作注册表原型（窗口实例 + generation、取消信号、清理、旧 generation 失效） | 用例/状态机、Tauri 命令装配（R1/R4/R5） |
| `media` | 录屏导出限制类型与校验（GIF/多段/编码队列），R5 trait 骨架 | 采集后端、编码、FFmpeg argv、发布（R5） |
| `windows-platform` | 几何/DPI 基础类型与 DIP↔物理像素转换（含负坐标、舍入规则文档） | 真机 DPI/焦点/捕获/快捷键/凭据（R3）；R3 前不宣称与 Electron 完全一致 |

`src-tauri/` 属于后续 R0-03/R1 任务，本分支**故意不存在**。

## 依赖方向（计划 §3.2）

```text
用例层:  core ──> contracts
协议层:  service-host（R0 不依赖其它 crate；后续经接口接 helper）
存储层:  storage（独立）
平台层:  windows-platform（独立）
媒体层:  media（独立）
宿主:    src-tauri（R1）→ core/service-host/storage/media/windows-platform
```

硬约束：

- `contracts` 不访问文件/时钟/窗口；除 serde/serde_json 外无依赖，不依赖 tauri、
  windows、rusqlite/sqlx、async runtime。`contracts` 内唯一读盘代码是
  `host_contracts` 模块读取**仓库合同产物**（不是用户数据），并有依赖方向测试兜底。
- 阻塞的 UIA/OCR/图像/编码任务不进窗口事件线程；R0 各 crate 均为同步、无 GUI。
- 平台能力集中在 `windows-platform`；`core` 只依赖接口/DTO，不直接调用 Win32。

## 构建与检查

在仓库根目录执行（Windows）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/rust/check-rust-app.ps1
cargo test --manifest-path rust-app/Cargo.toml --locked
```

脚本依次运行 `cargo fmt --all -- --check`、`cargo clippy --workspace --all-targets -- -D warnings`、
`cargo test --workspace --locked`，任一步非零即失败。测试全部离线可复跑（依赖下载后），
不需要 GUI、Electron 或网络。

## 外部生成物与夹具对接状态

`contracts/host/host-contracts.json` 与 `test/fixtures/host-parity/` 由
[contract-format.md](../docs/plans/rust-migration/contract-format.md) §3/§4 的 Node 脚本
（`scripts/rust/extract-host-contracts.js`、`scripts/rust/generate-host-fixtures.js`）生成，
属于并行的 contract-inventory 任务。产物已落地，Rust 侧**只读取、不复制**，且测试对真实
产物做**严格对照**（产物缺失即失败，不再 skip）：

| Rust 测试 | 对照的真实产物 | 覆盖 |
|---|---|---|
| `crates/contracts/tests/host_contracts_file.rs` | `contracts/host/host-contracts.json` | 13 角色与 `WindowRole` 一一对应、257 个方法的 kind/channel/源码位置可解析且与 `surface.handles/listeners` 一致、10 个 errorCodes 唯一且有源码、8 项 §9.1 resourceLimits（id 集合固定；clipboard.protocol 数值=1 MiB/512 KiB/256 KiB）、6 个 sharedSchemas 版本（capture-document v3、recording-project v1、clipboard-db user_version=2、usage-db user_version=1、data-root-marker v3；settings-normalize 显式 null） |
| `crates/service-host/tests/clipboard_protocol_fixtures.rs` | `test/fixtures/host-parity/clipboard-protocol/` + `manifest.json` | 12 个 case：4 个 valid 逐帧 header/payload 字节相等；8 个 invalid 按 `failAt=feed|finish` 在**同一阶段**失败且错误码为 `invalid-frame`，feed 失败后 decoder 永久失败；manifest 与磁盘 case 双向一致、sha256 形状校验（逐字节哈希由 Node 测试负责） |
| `crates/media/tests/export_limits_fixtures.rs` | `test/fixtures/host-parity/recording-export-options/` | 5 个 case：`limits` 逐字段对照计划 §9.1（1 编码 + 2 等待、GIF 60 s/1280/1200/10-15-20、20 段/≥100 ms）；GIF `normalize` 对照 edge/fps/width/height/frames 与 `reason`；多段 `normalize` 对照 segments/totalDurationMs。视频分辨率/质量/fps 规范化属于 R5，未移植部分在测试输出中登记，不伪造通过 |

夹具数值/内容不得复制进 Rust 源码作为第二份真相；本仓库只把计划 §5.1/§9.1 已冻结的基线
值作为常量并注明来源。`capture-document`/`recording-project`/`settings` 三个夹具分组属于
R2/R4/R5 的消费方，本 workspace 的 R0 crate 暂不读取。

## 已知限制

- 没有 `src-tauri`、没有 GUI、没有 Electron/Node 调用；不做安装包与真机验收。
- `clipboard-protocol` 只覆盖共享帧编解码，不含 lease/epoch/回贴等剪贴板业务语义（R3）。
- 原子写入依赖 NTFS 上同目录 `File::flush` + `rename`；Windows 没有 std 级目录 fsync，
  断电恢复证据在 R2/R8 用故障注入补齐，R0 不断言崩溃一致性。
- DPI 舍入规则是**候选实现**（半数远离零、饱和到 i32），R3 真机对照后才冻结。
- `media`/`core` 的状态机只做原型级不变量，完整状态机在 R4/R5 逐项移植。

## 相关文档

- [Rust 改造方案与开发计划](../docs/plans/2026-11-10-rust-migration-development-plan.md)
- [R0 合同与夹具格式（草案 v1）](../docs/plans/rust-migration/contract-format.md)
