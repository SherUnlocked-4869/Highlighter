# R0 G0 决策报告（草案）

日期：2026-11-10（2026-11-11 续作轮更新：R0-07 本机部分、ADR-0006/0007、首轮性能基线）。状态：**G0 未通过（草案）**。分支 `codex/rust-r0-baseline-contracts`。

> **2026-11-11 续作轮说明**：本报告在原机证据之外补充了另一台机器（SHERUNLOCK02，见 [r0-baseline.md](r0-baseline.md) §9）
> 的 R0-07 本机证据；机器差异与不可比性已逐项标注。**本轮没有关闭 G0**，只把“未做”项推进为“部分完成/候选”。
上位文档：[Rust 改造方案与开发计划](../2026-11-10-rust-migration-development-plan.md) §2/§7/§8；
[R0 实施报告](r0-report.md)；[R0 基线](r0-baseline.md)。

本报告按计划 §8 G0 要求汇总七项决策的证据与剩余缺口。**结论是"尚不能放行 R1～R7 全面开发"**；
不写任何"已冻结"。

## 1. G0 放行条件与当前状态

| G0 必备证据（计划 §8） | 当前状态 | 证据 |
|---|---|---|
| R0 三条高风险链路（窗口/钩子/媒体） | 窗口与钩子有实测原型；媒体两路 spike 有证据但未完成同条件对照与长时验证 | [r0-window-prototype.md](r0-window-prototype.md)、[r0-hook-extraction.md](r0-hook-extraction.md)、[r0-media-webview.md](r0-media-webview.md)、[r0-media-native.md](r0-media-native.md) |
| 数据/凭据/PDF/资源通道小样 | 文档/项目夹具、凭据双向、PDF 双后端对照、资源通道 Range/鉴权均完成；真实产品打印页/批量/长图未复验 | [r0-credential-migration.md](r0-credential-migration.md)、[r0-pdf-spike.md](r0-pdf-spike.md)、[r0-resource-channel.md](r0-resource-channel.md) |
| 版本矩阵（Windows/WebView2 有/无/离线） | **部分完成（仅本机）**：三种 NSIS 测试包、WebView2 五种分发模式对照、缺失 Runtime 行为、版本冻结已实测；**手动交互安装→启动链路已实测通过**（文件/注册项/快捷方式/已安装 exe 四场景）；**自动静默安装在本机受限会话阻塞、卸载链路待验证**；多版本/无 Runtime/离线真实机器矩阵未做 | [r0-installation-matrix.md](r0-installation-matrix.md) §6、[r0-baseline.md](r0-baseline.md) §9 |
| 修正估算（R0 后重估） | **未做**（媒体后端重估需要 G0 前结论；本轮新增性能/安装证据仍不足以重估 R5） | 计划 §11、本报告 §4 |
| 性能/资源对照（计划 §9.2） | **首轮完成（本机，两轮取样）**：Tauri 最小壳对 Electron 最小壳无 Private Bytes 优势（+5.2%，区间重叠）、进程数 4→7、启动 +18.4%；产品托盘空闲基线 131.90 MB；T1～T3 阈值已冻结，T4 媒体阈值未冻结 | [r0-performance-baseline.md](r0-performance-baseline.md) |

## 2. 七项决策登记

| ADR | 主题 | 当前建议（草案） | 状态 | G0 前仍缺 |
|---|---|---|---|---|
| [0001](adr/0001-media-backend.md) | 媒体后端 | 候选 C：原生采集（视频+系统音频）+ WebView UI/合成/编码；WebView2 不能作唯一后端 | **候选，未冻结** | 两路同条件对照、30 分钟/双音源/暂停续录、WGC 打包身份实测、Runtime 矩阵 |
| [0002](adr/0002-hook-extraction.md) | 钩子提取边界 | 候选 A：提取 C++ 独立 helper（复用 2,590 行；产品化 18–29 人日） | **候选，未冻结** | 浏览器/Office/资源管理器/管理员窗口矩阵、真实卡死恢复、lease required=true、Rust 剪贴板联调 |
| [0003](adr/0003-pdf-backend.md) | PDF 后端 | 候选 A：WebView2 `PrintToPdfStream`（语义等价；纸张按英寸显式传参） | **候选，未冻结** | 产品真实 `capture/print.html`、批量 50 页、200in 长图、缺字体机器、旧 Runtime |
| [0004](adr/0004-credential-migration.md) | 凭据迁移 | 候选 B（读 Local State DPAPI key + AES-GCM）+ C 强制兜底；A 最后手段 | **候选，未冻结** | 跨版本/多用户/漫游/便携、密钥轮换、迁移中断、安全评审 |
| [0005](adr/0005-binary-resource-transport.md) | 二进制资源传输 | 候选 D：不可猜测 ID + owner 校验；协议 Range 流式 + command 敏感内容 | **候选，未冻结** | 取消/窗口销毁释放、长视频/大文件/并发背压、角色权限映射（R1-04） |
| [0006](adr/0006-desktop-test-driver.md) | 桌面 E2E 驱动 | 候选 A1：`tauri-driver 2.1.0` + 与 WebView2 Runtime 精确同版本 `msedgedriver`（本机 157.0.4341.46）+ 应用侧断言；C（宿主 --self-test 探针）保留为烟测 | **候选，未冻结** | GitHub runner 实测、msedgedriver 版本不匹配行为、无 Runtime 机器、多窗口/托盘、混合 DPI、长时稳定性；`@wdio/tauri-service`（A2）与 CDP 回退（B）未评估 |
| [0007](adr/0007-minimum-windows-runtime.md) | 最低 Windows/Runtime | 候选 A+D：最低 **Windows 10 22H2 x64 / Windows 11 x64**；WebView2 默认 Evergreen（`downloadBootstrapper` + 启动检测），离线渠道另发 Standalone 制品；Fixed Version 不作默认 | **候选，未冻结** | 真实测试机矩阵（Win10 22H2 / Win11、WebView2 无/旧版/离线、portable）、README 收紧到 22H2 的产品决策、消费级 ESU 口径 |

## 3. 未完成 R0 任务

| 任务 | 状态 | 说明 |
|---|---|---|
| R0-03 真机 DPI 矩阵 | 部分 | 窗口原型编译/自检通过、副屏负坐标实测；100%/200% 缩放视觉、白闪、单屏拒绝路径需用户参与改显示设置 |
| R0-04 | 原型完成 | 提取小样与真实选词验证；剩余矩阵见 ADR-0002 |
| R0-05 | 两路 spike 完成 | 后端选型仍待同条件对照与长时验证；WGC 需打包身份 |
| R0-06 | 大部分完成 | 凭据/PDF/资源通道/文档项目夹具完成；图片视频资源桥真实产品链路未接入（原型级）、安装烟测未做 |
| R0-07 | **部分完成（仅本机）** | 三种 NSIS 测试包/WebView2 五模式/缺失 Runtime 行为/首轮性能对照已完成；**安装→启动→卸载链路阻塞**（静默安装 exit 0 不落盘）、WebView2 多版本/无 Runtime/离线真实机器矩阵未做、fixedRuntime 仅评估 |
| 测试驱动 ADR-0006 | **候选 A1（本机实测通过）** | 真实 WebDriver 全流程/close/crash/负样本已实测；CI runner、版本不匹配、多窗口/托盘/混合 DPI、长时稳定性未验证 |
| 最低系统 ADR-0007 | **候选 A+D（调研完成）** | 官方支持矩阵与仓库差异已核查；真机矩阵（Win10 22H2/无 Runtime/离线/旧版）未做；README 收紧需产品决策 |

## 4. 对 R1～R8 排期的影响（初判）

- 媒体后端从"WebView2 复用"改为"原生采集 + WebView 合成/编码"候选，R5 的 8–14 人周需要重估；
  计划 §11 的 38–63 人周总量在 G0 后必须更新，不得沿用。
- **性能预期需要修正**：首轮性能对照（[r0-performance-baseline.md](r0-performance-baseline.md)）显示，同形态最小壳下
  Tauri + WebView2 相对 Electron **没有 Private Bytes 优势**（+5.2%，区间重叠；进程数 4→7、启动 +18.4%）。
  计划 §9.2 的“托盘空闲 Private Bytes 下降约 25%”不能靠替换宿主本身达成，必须在 R1 用真实宿主状态验证；
  若仍不达标，应按计划 §8 的失败处理“回到 Electron 增量 Rust 化”或由产品明确接受收益调整。
- 钩子按"提取"候选，R3 成本区间 18–29 人日（ADR-0002），与计划估算方向一致。
- PDF/凭据/资源通道候选方案均有实测支撑，R2/R4/R5 的实现风险下降，但仍需真实产品用例复验。

## 5. 建议的 G0 收尾清单（放行前必须完成）

> 2026-11-11 续作轮更新：第 1、6 项已在本机推进到“部分完成/候选”，其余项状态不变。逐项状态如下。

1. **R0-07（部分完成）**：三种 NSIS 测试包 + WebView2 五种分发模式对照 + 缺失 Runtime 同栈行为 + 首轮
   Release 性能/进程树对照（固定电源方案、两轮取样）已完成，见 [r0-installation-matrix.md](r0-installation-matrix.md)、
   [r0-performance-baseline.md](r0-performance-baseline.md)；**仍缺**：卸载链路验证（用户保留安装，待确认后执行）、
   自动静默安装不落盘的环境级根因（需真实桌面会话）、WebView2 多版本/无 Runtime/离线真实机器矩阵、fixedRuntime 实测、
   **修正估算**（本轮证据不足以重估 R5，见 §4）。**手动交互安装→启动链路已于 2026-11-11 实测通过**（§7.2）。
2. **R0-05（未完成）**：两路同条件对照 + 30 分钟双音源/暂停续录 + WGC 打包身份实测仍缺；本机无独显、
   WGC 在受限宿主被拒，需真实测试机/桌面会话。
3. **R0-04（未完成）**：浏览器/Office/资源管理器/管理员窗口矩阵 + 真实卡死恢复 + lease required=true + 与
   `native/clipboard` 联调仍需真机人工操作。
4. **R0-03（部分完成）**：本机单屏拒绝路径已实测（exit 2、不建窗、无残留）；测试专用开关
   `HIGHLIGHTER_R0_ALLOW_PRIMARY=1` 下的主屏建窗自检 PASS（明确不是副屏验证）；**仍缺**：100/150/200% DPI
   视觉矩阵、副屏/负坐标、首帧白闪、鼠标穿透/焦点，需用户参与改显示设置或真实双屏机器。
5. **R0-06（未完成）**：产品真实 `capture/print.html` 批量/长图 PDF、图片视频资源桥真实链路仍缺；
   安装烟测与第 1 项同为阻塞项。
6. **ADR-0006/0007（候选，未冻结）**：ADR-0006 已用真实 WebDriver session 验证候选 A1（本机），
   见 [r0-test-driver.md](r0-test-driver.md)；ADR-0007 已核查官方支持矩阵并给出候选 A+D，
   见 [r0-minimum-windows-runtime.md](r0-minimum-windows-runtime.md)；两者在 G0 前均不冻结（未验证项见各自 §5/§6）。
7. **修正估算 + 正式 G0 报告**：依赖 1～6 与真机矩阵；另需按 §4 的“性能预期修正”重估收益假设。

## 6. 声明

- 本报告不改变任何产品行为；所有原型均未接入产品入口。
- 所有"候选"建议均以本分支证据文档为准；文档中的"未验证"项不得在 G0 报告中改写成通过。
- G0 通过前不开始 R1～R7 业务迁移（计划 §7/§8）。
## 7. 2026-11-11 续作轮：新增证据、变更与仍未关闭的项

### 7.1 运行主机变更

本轮运行在另一台机器（SHERUNLOCK02：i5-13500H / 15.7 GiB / Intel Iris Xe 无独显 / 单屏 2240×1400@150% /
WebView2 157.0.4341.46）。原机（Ryzen 7 9850X3D / RTX 5070 Ti / 双屏混 DPI / WebView2 157.0.4341.42）的数值
**不可**与本轮混用；用户已确认以当前机器为准。完整环境事实见 [r0-baseline.md](r0-baseline.md) §9。

### 7.2 本轮新增证据

| 证据 | 结论（候选/部分完成） | 文档 |
|---|---|---|
| R0-07 安装/分发 | 三种 NSIS 测试包产出（download 1.92 MiB / embed 3.63 MiB / offline 209.61 MiB，均 NotSigned）；WebView2 五模式语义与体积实测；缺失 Runtime 时加载器弹**阻塞式对话框**（探针 exit 3 / 应用 exit 2）；**手动交互安装→启动链路实测通过**（目录/哈希/HKCU 卸载键/快捷方式/已安装 exe 四场景）；**自动静默安装在本机受限会话阻塞、卸载待验证** | [r0-installation-matrix.md](r0-installation-matrix.md) §6 |
| R0-07 性能/进程树 | 同形态最小壳：Tauri 相对 Electron Private Bytes **+5.2%（区间重叠）**、WS +5.8%、进程 4→7、启动 +18.4%；产品 Electron 托盘空闲 **131.90 MB**（6 次）；T1～T3 阈值冻结、T4 未冻结 | [r0-performance-baseline.md](r0-performance-baseline.md) |
| ADR-0006 桌面 E2E | 候选 A1 本机实测成立：tauri-driver 2.1.0 + msedgedriver 157.0.4341.46 驱动真实 Tauri 进程，new session / handles / execute+IPC / W3C 点击 / ready 握手 / 截图 / close / crash / 负样本全部有真实响应；CI runner 等未验证 | [r0-test-driver.md](r0-test-driver.md)、[adr/0006](adr/0006-desktop-test-driver.md) |
| ADR-0007 最低系统 | 候选 A+D：Win10 22H2 + Win11、Evergreen 默认、离线另发 Standalone；Win10 22H2 上 Edge/WebView2 官方更新至少到 2028-10（OS 已于 2025-10-14 EOL）；README 收紧需产品决策 | [r0-minimum-windows-runtime.md](r0-minimum-windows-runtime.md)、[adr/0007](adr/0007-minimum-windows-runtime.md) |
| R0-03 单屏路径 | 单屏拒绝路径实测：无副屏 → 不建窗、exit 2、无残留；测试开关 `HIGHLIGHTER_R0_ALLOW_PRIMARY=1` 下主屏自检 PASS（日志明示**非**副屏验证） | [r0-window-prototype.md](r0-window-prototype.md) §11 |

### 7.3 仍未关闭的 G0 缺口（未变）

1. 卸载链路（待用户确认执行）与自动静默安装的环境级根因；真实 Win10/无 Runtime/离线矩阵；
2. R0-05 长时/双音源/暂停续录/同条件对照与 WGC 打包身份；
3. R0-04 真实应用/管理员窗口矩阵、卡死恢复、`native/clipboard` 联调；
4. R0-03 100/150/200% DPI、副屏/负坐标、白闪、鼠标穿透（需真机/用户参与）；
5. R0-06 产品真实 print.html 批量/长图 PDF 与图片视频资源桥真实链路；
6. ADR-0006 的 CI runner/版本不匹配/多窗口/混合 DPI/长时稳定性；ADR-0007 的真机矩阵与 README 产品决策；
7. 修正估算与正式 G0 报告；
8. **性能收益假设**：计划 §9.2 的 25% Private Bytes 下降未获证据支持，必须在 G0 决策中显式处理（重估/调整收益目标/失败分支）。

### 7.4 门禁结论

**G0 仍未通过。** 本轮把“版本矩阵/性能对照/测试驱动/最低系统”从“未做/待验证”推进为
“部分完成/候选”，但没有关闭任何一条 G0 必备证据；R1～R7 业务迁移仍不得开始（计划 §7/§8）。
