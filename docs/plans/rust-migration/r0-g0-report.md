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
| R0 三条高风险链路（窗口/钩子/媒体） | 窗口原型与钩子 helper 有实测原型；**钩子真机矩阵 10 行 9 PASS**（Notepad/Chrome/Edge/Word/Excel；资源管理器拖选样本未建立、双击 PASS；管理员窗口 UIPI 负样本；真实 provider 卡死未复现）；**媒体：WGC 在 Medium IL 下实测可用**（ACL 缺陷修复后更正；10s@30fps 采集解码通过）+ 30 分钟 GDI 时钟样例、暂停/继续、双音源成立；仍缺 WGC 打包身份/同意 UI/其它 Windows/HDR/4K/60、双音源时间对齐真机 | [r0-window-prototype.md](r0-window-prototype.md)、[r0-hook-extraction.md](r0-hook-extraction.md)、[r0-media-webview.md](r0-media-webview.md)、[r0-media-native.md](r0-media-native.md) |
| 数据/凭据/PDF/资源通道小样 | 文档/项目夹具、凭据双向、PDF 双后端对照、资源通道 Range/鉴权均完成；**产品真实 `capture/print.html` 单图 A4/长图 200in/批量 50 页双后端复验完成（7 用例 + 2 产品函数对照，语义等价）**；仍缺缺字体机器/旧 Runtime/真实图片视频资源桥/打印内存与超时 | [r0-credential-migration.md](r0-credential-migration.md)、[r0-pdf-spike.md](r0-pdf-spike.md) §8、[r0-resource-channel.md](r0-resource-channel.md) |
| 版本矩阵（Windows/WebView2 有/无/离线） | **部分完成（仅本机）**：三种 NSIS 测试包、WebView2 五种分发模式对照、缺失 Runtime 行为、版本冻结已实测；**手动交互安装→启动→卸载链路已实测通过**；**自动静默安装“不落盘”根因已定位并修复**（工作区 DSH workspace-write 沙箱遗留 Low 完整性标签；2026-11-11 已把 61,767 个文件恢复 Medium，**Medium IL 下工作区原件静默安装 exit 0/770 ms、产物/注册项/快捷方式正确，卸载 exit 0/565 ms 清理干净**）；卸载遗留注册表键待决策；多版本/无 Runtime/离线真实机器矩阵未做 | [r0-installation-matrix.md](r0-installation-matrix.md) §6.2、[r0-baseline.md](r0-baseline.md) §9 |
| 修正估算（R0 后重估） | **未做**（G0 前必须完成）；本轮已补齐大部分输入：R0-05 媒体后端与 WGC 可行性、R0-06 PDF 等价性、R0-04 钩子矩阵、安装/性能重估决策（§8.4）；剩余依赖真实测试机矩阵与 R5 媒体后端工作量重估 | 计划 §11、本报告 §4/§9 |
| 性能/资源对照（计划 §9.2） | **首轮完成（本机，两轮取样）**：Tauri 最小壳对 Electron 最小壳无 Private Bytes 优势（+5.2%，区间重叠）、进程数 4→7、启动 +18.4%；产品托盘空闲基线 131.90 MB；T1～T3 阈值已冻结，T4 未冻结。**2026-11-11 产品决策：撤回 -25% 内存收益目标，T1 改为非回归守卫（候选 ≤145.09 MB），见 §8.4 与 [r0-performance-baseline.md](r0-performance-baseline.md) §10** | [r0-performance-baseline.md](r0-performance-baseline.md) |

## 2. 七项决策登记

| ADR | 主题 | 当前建议（草案） | 状态 | G0 前仍缺 |
|---|---|---|---|---|
| [0001](adr/0001-media-backend.md) | 媒体后端 | 候选 C：原生采集（视频+系统音频）+ WebView UI/合成/编码；WebView2 不能作唯一后端 | **候选，未冻结** | 两路同条件对照（未做）；30 分钟/双音源/暂停续录**已做（单机）**；**WGC 已在本机 Medium IL 实测可用**（原 E_ACCESSDENIED 是 ACL 缺陷）；仍缺 WGC 打包身份/同意 UI/采集指示/其它 Windows/HDR/4K/60/长时、双音源时间对齐真机 |
| [0002](adr/0002-hook-extraction.md) | 钩子提取边界 | 候选 A：提取 C++ 独立 helper（复用 2,590 行；产品化 18–29 人日） | **候选，未冻结** | **真机矩阵 10 行 9 PASS（2026-11-11 Medium IL）**；仍缺真实 provider 卡死（2s 有界停止未真实触发）、管理员窗口正向样本（只有 UIPI 负样本）、资源管理器拖选样本、helper↔native/clipboard lease 联调（仅协议级互通） |
| [0003](adr/0003-pdf-backend.md) | PDF 后端 | 候选 A：WebView2 `PrintToPdfStream`（语义等价；纸张按英寸显式传参） | **候选，未冻结** | **产品真实 `capture/print.html`、单图 A4/长图 200in/批量 50 页已在单机+合成 PNG 下复验（语义等价）**；仍缺缺字体机器、旧/Fixed Runtime 的 `ICoreWebView2_16`、RDP/锁屏、打印峰值内存/超时/取消 |
| [0004](adr/0004-credential-migration.md) | 凭据迁移 | 候选 B（读 Local State DPAPI key + AES-GCM）+ C 强制兜底；A 最后手段 | **候选，未冻结** | 跨版本/多用户/漫游/便携、密钥轮换、迁移中断、安全评审 |
| [0005](adr/0005-binary-resource-transport.md) | 二进制资源传输 | 候选 D：不可猜测 ID + owner 校验；协议 Range 流式 + command 敏感内容 | **候选，未冻结** | 取消/窗口销毁释放、长视频/大文件/并发背压、角色权限映射（R1-04） |
| [0006](adr/0006-desktop-test-driver.md) | 桌面 E2E 驱动 | 候选 A1：`tauri-driver 2.1.0` + 与 WebView2 Runtime 精确同版本 `msedgedriver`（本机 157.0.4341.46）+ 应用侧断言；C（宿主 --self-test 探针）保留为烟测 | **候选，未冻结** | GitHub runner 实测、msedgedriver 版本不匹配行为、无 Runtime 机器、多窗口/托盘、混合 DPI、长时稳定性；`@wdio/tauri-service`（A2）与 CDP 回退（B）未评估 |
| [0007](adr/0007-minimum-windows-runtime.md) | 最低 Windows/Runtime | 候选 A+D：最低 **Windows 10 22H2 x64 / Windows 11 x64**；WebView2 默认 Evergreen（`downloadBootstrapper` + 启动检测），离线渠道另发 Standalone 制品；Fixed Version 不作默认 | **候选，未冻结** | 真实测试机矩阵（Win10 22H2 / Win11、WebView2 无/旧版/离线、portable）、README 收紧到 22H2 的产品决策、消费级 ESU 口径 |

## 3. 未完成 R0 任务

| 任务 | 状态 | 说明 |
|---|---|---|
| R0-03 真机 DPI 矩阵 | 部分 | 窗口原型编译/自检通过、副屏负坐标实测、单屏拒绝路径实测；**ACL 修复后复跑自检 PASS（no-env exit 2 / ALLOW_PRIMARY=1 exit 0）**；仍缺 100%/125%/200% 缩放视觉、白闪、鼠标穿透、真机副屏（需用户参与改显示设置或真实测试机） |
| R0-04 | **真机矩阵收尾（单机）** | 10 行 9 PASS（Notepad/Chrome/Edge/Word/Excel/资源管理器双击）；资源管理器地址栏拖选样本未建立；管理员窗口仅 UIPI 负样本；真实 provider 卡死未复现（2s 有界停止无真实触发）；lease 仅协议级互通、helper↔native/clipboard 未联调 |
| R0-05 | **长时/双音源/暂停/窗口采集收尾（单机）** | 30 分钟 GDI 时钟样例、10 分钟 Medium IL 干净样例、暂停/继续、双音源采集/混音、区域/窗口/源目标变化均有实测；**WGC 更正确认可用（Medium IL，10s@30fps 采集通过）**；仍缺 WGC 打包身份/同意 UI/采集指示/其它 Windows/HDR/4K/60、双音源时间对齐真机、两路同条件对照 |
| R0-06 | **大部分完成 + PDF 产品真实页复验** | 凭据/PDF/资源通道/文档项目夹具完成；**产品真实 `capture/print.html` 单图 A4/长图 200in/批量 50 页双后端语义等价（单机/合成 PNG）**；仍缺图片视频资源桥真实产品链路、缺字体机器、旧/Fixed Runtime、打印峰值/超时 |
| R0-07 | **本机链路全部通过 + 性能重估完成** | 三种 NSIS 测试包/WebView2 五模式/缺失 Runtime 行为；手动与**静默安装→启动→卸载均实测通过（ACL 修复后）**；首轮性能对照完成且产品决策已重估（不承诺内存下降）；仍缺 WebView2 多版本/无 Runtime/离线真实机器矩阵、fixedRuntime 实测、卸载遗留键决策、UAC/SmartScreen 体验 |
| 测试驱动 ADR-0006 | **候选 A1（本机实测通过；ACL 修复后复跑通过）** | 真实 WebDriver 全流程/close/crash/负样本已实测；CI runner、版本不匹配、无 Runtime 机器、多窗口/托盘/混合 DPI、长时稳定性未验证 |
| 最低系统 ADR-0007 | **候选 A+D（调研完成）** | 官方支持矩阵与仓库差异已核查；真机矩阵（Win10 22H2/无 Runtime/离线/旧版）未做；README 收紧需产品决策 |

## 4. 对 R1～R8 排期的影响（初判）

- 媒体后端从"WebView2 复用"改为"原生采集 + WebView 合成/编码"候选，R5 的 8–14 人周需要重估；
  计划 §11 的 38–63 人周总量在 G0 后必须更新，不得沿用。
- **性能预期已修正（产品决策，§8.4）**：首轮性能对照显示同形态最小壳下 Tauri + WebView2 相对 Electron
  **没有 Private Bytes 优势**（+5.2%，区间重叠；进程数 4→7、启动 +18.4%）。计划 §9.2 的“25% 内存下降”目标
  已由产品决策撤回，G0 按架构/维护收益重估（不承诺内存与启动收益）；T1 改为非回归守卫（候选 ≤145.09 MB），
  T2 待 R1 冻结等价里程碑后再判定。计划 §12“换壳后收益不明显”风险行已触发并接受。
- 钩子按"提取"候选，R3 成本区间 18–29 人日（ADR-0002），与计划估算方向一致。
- PDF/凭据/资源通道候选方案均有实测支撑，R2/R4/R5 的实现风险下降，但仍需真实产品用例复验。

## 5. 建议的 G0 收尾清单（放行前必须完成）

> 2026-11-11 续作轮更新：第 1、6 项已在本机推进到“部分完成/候选”，其余项状态不变。逐项状态如下。

1. **R0-07（部分完成）**：三种 NSIS 测试包 + WebView2 五种分发模式对照 + 缺失 Runtime 同栈行为 + 首轮
   Release 性能/进程树对照（固定电源方案、两轮取样）已完成，见 [r0-installation-matrix.md](r0-installation-matrix.md)、
   [r0-performance-baseline.md](r0-performance-baseline.md)；**仍缺**：卸载后 `HKCU\Software\<publisher>\<product>` 遗留键的清理决策、
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
| R0-07 安装/分发 | 三种 NSIS 测试包产出（download 1.92 MiB / embed 3.63 MiB / offline 209.61 MiB，均 NotSigned）；WebView2 五模式语义与体积实测；缺失 Runtime 时加载器弹**阻塞式对话框**（探针 exit 3 / 应用 exit 2）；**手动交互安装→启动链路实测通过**（目录/哈希/HKCU 卸载键/快捷方式/已安装 exe 四场景）；**静默卸载实测通过**（目录/卸载键/快捷方式清理，遗留键已记录）；**自动静默安装在本机受限会话阻塞** | [r0-installation-matrix.md](r0-installation-matrix.md) §6 |
| R0-07 性能/进程树 | 同形态最小壳：Tauri 相对 Electron Private Bytes **+5.2%（区间重叠）**、WS +5.8%、进程 4→7、启动 +18.4%；产品 Electron 托盘空闲 **131.90 MB**（6 次）；T1～T3 阈值冻结、T4 未冻结 | [r0-performance-baseline.md](r0-performance-baseline.md) |
| ADR-0006 桌面 E2E | 候选 A1 本机实测成立：tauri-driver 2.1.0 + msedgedriver 157.0.4341.46 驱动真实 Tauri 进程，new session / handles / execute+IPC / W3C 点击 / ready 握手 / 截图 / close / crash / 负样本全部有真实响应；CI runner 等未验证 | [r0-test-driver.md](r0-test-driver.md)、[adr/0006](adr/0006-desktop-test-driver.md) |
| ADR-0007 最低系统 | 候选 A+D：Win10 22H2 + Win11、Evergreen 默认、离线另发 Standalone；Win10 22H2 上 Edge/WebView2 官方更新至少到 2028-10（OS 已于 2025-10-14 EOL）；README 收紧需产品决策 | [r0-minimum-windows-runtime.md](r0-minimum-windows-runtime.md)、[adr/0007](adr/0007-minimum-windows-runtime.md) |
| R0-03 单屏路径 | 单屏拒绝路径实测：无副屏 → 不建窗、exit 2、无残留；测试开关 `HIGHLIGHTER_R0_ALLOW_PRIMARY=1` 下主屏自检 PASS（日志明示**非**副屏验证） | [r0-window-prototype.md](r0-window-prototype.md) §11 |

### 7.3 仍未关闭的 G0 缺口（未变）

1. 卸载遗留注册表键的清理决策与自动静默安装的环境级根因；真实 Win10/无 Runtime/离线矩阵；
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

## 8. 2026-11-11 收尾轮：用户决策登记与 G0 重估

> 本节记录 2026-11-11 收尾会话中产品负责人（用户）的明确决策与授权；其余未确认项保持“候选/未冻结”，
> 不得因本节改动被理解为已冻结。

### 8.1 已确认决策 / 授权

| # | 事项 | 决策 | 证据/记录 |
|---|---|---|---|
| 1 | 性能收益假设（计划 §9.2 -25% Private Bytes） | **产品决策：撤回收益目标，接受“架构迁移不承诺内存下降”，G0 按其他收益重估**。T1 改非回归守卫（候选 ≤145.09 MB），T2 待 R1 冻结等价里程碑后再判定 | [r0-performance-baseline.md](r0-performance-baseline.md) §10；计划 §12“换壳后收益不明显”风险行已触发并接受 |
| 2 | PR #5 | **本轮不合并**，继续在 `codex/rust-r0-baseline-contracts` 分支收口 | 本文件 §8.3 |
| 3 | 静默安装根因排查 | **授权**用一次性计划任务在交互桌面会话复跑安装器（不绕过安全机制，复跑后清理） | handoff §1.4 第 5 项 / [r0-installation-matrix.md](r0-installation-matrix.md) §6.2 |
| 4 | 可见窗口/屏幕采集 | **授权**本机单屏主屏的可见测试窗口与 30 分钟屏幕采集（证据仅存 gitignore `.tmp*`，用完删除） | AGENTS.md 例外授权；本轮证据文档登记 |
| 5 | 真实测试机/VM | **先按本机推进**，Win10 22H2 / 多 DPI / 双屏 / 独显矩阵稍后安排（未提供资源前不阻塞本机收尾） | 本文件 §8.3 |

### 8.2 仍未决（保持候选，G0 前不冻结）

1. README 最低系统收紧为“Windows 10 22H2 或更新”（ADR-0007 候选 A+D）——需产品批准；
2. 卸载静默 `/S` 是否无条件清理 `HKCU\Software\<publisher>\<product>`（R8-02）；
3. 划词钩子保留 C++ selection helper + 退出计划（ADR-0002 候选 A）；
4. ADR-0006 主路线冻结为 tauri-driver 2.1.0 + 同版本 msedgedriver（候选 A1）；
5. 真实测试机/VM 资源与安排（§8.1 第 5 项）。

### 8.3 G0 重估结论

**G0 仍未通过**，但“性能收益假设不成立”已由产品决策转为**已登记的产品风险接受**，不再作为阻塞 G0 的未决问题；
正式 G0 报告必须原样登记“不承诺内存与启动收益”，并引用 [r0-performance-baseline.md](r0-performance-baseline.md) §10。

G0 放行前仍需闭环（按优先级）：

1. **真实测试机/VM 矩阵**（Win10 22H2、WebView2 无/旧/离线、100/125/150/200% DPI、副屏/负坐标、独显）——待用户资源；
2. **R0-05 长时媒体**：30 分钟时钟样例、暂停/继续、双音源、区域/窗口采集、源目标变化、T4 阈值（本轮进行中）；
3. **R0-04 真机矩阵**：浏览器/Office/资源管理器/管理员窗口、卡死恢复、lease required=true、与 `native/clipboard` 联调（本轮进行中）；
4. **R0-06 收尾**：产品真实 `capture/print.html` 单图/长图/批量 PDF（本轮进行中）、图片视频资源桥真实链路；
5. **安装收尾**：静默安装根因**已定位并修复**（§8.4：工作区 Low 完整性标签；2026-11-11 已恢复 Medium，静默安装链路复跑中）、卸载遗留键决策（§8.2 第 2 项）；
6. **ADR-0006/0007 收尾**：CI runner/版本不匹配/多窗口/托盘/混合 DPI、真机矩阵与 README 决策；
7. **修正估算 + 正式 G0 报告**：按 §8.1 第 1 项重估收益表述，并更新计划 §11 的 38～63 人周（不得沿用）。

失败分支说明：计划 §8“回到 Electron 增量 Rust 化”本轮不采用；若 R1 真实宿主出现 T2 等价口径 >10% 或
T1 >145.09 MB 等不可接受回归，仍须重新提交产品决策。

### 8.4 2026-11-11 晚间追加：工作区完整性标签缺陷修复（环境修复，非产品变更）

**发现**：安装收尾排查（task-5）定位到 `D:\workspace\Highlighter` 根目录带有此前 DSH workspace-write 沙箱
遗留的强制完整性标签 `Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)`（另有 `Everyone:(CI)(DENY)(DC)`
与能力 SID `S-1-4-1070570333-856284178:(OI)(CI)(W,D,DC)`），并继承到整个工作区。Windows 按**镜像文件
完整性标签封顶进程 IL**：工作区内所有 exe（安装包、helper、原型）以 **Low IL** 运行，受 No-Write-Up
限制，不能写 `%LOCALAPPDATA%`/`%TEMP%`/HKCU/`D:\Program Files` 等 Medium 位置。

**影响（已确认）**：

- 静默 `setup.exe /S` exit 0 但不落盘（NSIS 静默吞噬写失败）——与登录会话/计划任务/UAC/Defender 无关；
  同一字节副本复制到工作区外后，当前会话与交互桌面计划任务均静默安装成功（详见
  [r0-installation-matrix.md](r0-installation-matrix.md) §6.2）。
- 很可能同源影响其它此前登记为“受限宿主/环境级”的结论：WGC `E_ACCESSDENIED`、
  真实 SendInput/UIA 选词矩阵失败、spawned Electron 子进程写 `%LOCALAPPDATA%\Temp` EPERM 等。
  **是否同源需修复后复跑才能确认，不得先写成已解决。**

**修复（2026-11-11 19:55–20:00，用户批准后由 Lead 执行）**：

```powershell
icacls "D:\workspace\Highlighter" /setintegritylevel (OI)(CI)M /T /C /Q   # 61,767 files → Medium
icacls "D:\workspace\Highlighter" /remove:d Everyone
icacls "D:\workspace\Highlighter" /remove "*S-1-4-1070570333-856284178"   # icacls 无法解析时用 .NET Set-Acl 移除
```

验证：根 ACL 仅余继承的 Medium 标签；把 `C:\Windows\System32\whoami.exe` 复制进工作区运行显示
`Mandatory Label\Medium Mandatory Level (S-1-16-8192)`；`rust-app/target` 下 exe 标签为 Medium。
修复只影响本机评测环境的 ACL，不改变产品代码/构建产物/发布包。

**修复后复跑（已全部完成，结果回写各证据文档，汇总见 §9.1）**：

1. 静默安装完整链路（工作区原件，Medium IL）——**通过**（安装 exit 0/770 ms、卸载 exit 0/565 ms）；install-probe；
2. WGC 探针 + 窗口/区域采集——**WGC 更正确认可用**（monitor/window 均 OK；10s@30fps 采集解码通过）；media-runner；
3. 选词矩阵（Chrome/Edge/Word/Excel/资源管理器/Notepad）与卡死恢复——**10 行 9 PASS**；管理员 UIPI 负样本；hook-matrix；
4. PDF 产品页双后端确认复跑——**0 差异**（7 用例 + 2 产品函数对照）；pdf-parity；
5. R0-03 窗口自检（Lead 已复跑）：无 env exit 2 不建窗；`ALLOW_PRIMARY=1` exit 0 PASS；ADR-0006 WebDriver 探针 exit 0。

**未完成/风险**：修复后再用 workspace-write 沙箱会话可能重新写入标签；`handoff.md` §7 的“受限宿主”
陷阱条目须按复跑结果更正（不得直接写成已解决）。本修复不改变 G0 结论（G0 仍未通过）。

## 9. 2026-11-11 晚间收尾轮：ACL 修复后的复验结果与最终 G0 缺口

### 9.1 复验结果（全部在 Medium IL、本机单屏环境；证据见各证据文档）

| 工作流 | 结果 | 剩余限制 |
|---|---|---|
| 安装（task-5） | **静默安装问题关闭**：工作区原件 `setup.exe /S` exit **0 / 770 ms**，安装进程 token=Medium；目录 2 文件（exe sha256 `36AE37CC…3ADB` 与包内一致）、HKCU Uninstall、快捷方式正确；已安装 exe 四场景与 §7.2 一致；`uninstall.exe /S` exit **0 / 565 ms** 清理干净。原“受限会话不落盘”结论作废 | UAC/SmartScreen 真实体验未记录；遗留 `HKCU\Software\<publisher>\<product>` 待 R8-02 决策 |
| WGC（R0-05） | **结论更正为可用**：`CreateForMonitor #0` OK 2240×1400、`CreateForWindow(Chrome)` OK 1557×1314；修复原型 `IDirect3DSurface→ID3D11Texture2D` 读取 bug（须经 `IDirect3DDxgiInterfaceAccess`）后，**WGC 10s@30fps 采集成功**（送达 590 / 写入 300 / 复制补齐 0 / 全黑 0 / 全量解码 exit 0 / 有效 30.0000 fps）；`--capture auto` 选 WGC 无回退。**原 `E_ACCESSDENIED` 是 Low IL 环境缺陷，不是系统/未打包身份限制** | 打包身份（MSIX/能力声明）、同意 UI/采集指示/企业策略、Win10 22H2 与其它 build、多显示器/窗口/HDR/4K/60fps/长时 WGC、两路同条件对照 |
| 选词矩阵（R0-04） | **10 行 9 PASS**（真实 SendInput，helper Medium IL）：Notepad 39 字符、Chrome/Edge 默认与 force-a11y 各 15 字符、Word 36 字符、Excel 29 字符（含 `--clipboard`）均 method=1 UIA、0–32 ms；资源管理器地址栏**双击（4 字符）PASS**、拖选校准未能建立选择（测试限制，非 helper 缺陷） | 真实 provider 卡死未复现（2s 有界停止无真实触发）；管理员窗口只有 UIPI 负样本；PDF 阅读器/真实网页/混合 DPI 未覆盖；helper↔native/clipboard 未联调（仅协议级互通 PASS） |
| 卡死恢复 / 管理员窗口 | 进程级 kill helper / kill 目标后均 0 残留、重启 `--self-test` exit 0；管理员目标（High IL）拖选 `mouseEventsQueued=0` → UIPI 负样本符合预期（未绕过 UAC） | 见上 |
| PDF（R0-06） | **产品真实 `capture/print.html` 7 用例 + 2 产品函数对照双后端全部通过**；单图 A4 竖/横、DPR 负对照、20000/30000px→200in 夹取、批量 5/50 页语义等价（MediaBox 差 ≤0.96pt）；ACL 修复后 Medium IL 确认复跑**0 差异** | 缺字体机器、旧/Fixed Runtime、RDP/锁屏、打印峰值内存/超时/取消；真实图片/视频资源桥链路 |
| R0-03 / ADR-0006 | ACL 修复后：窗口自检 no-env exit 2 / `ALLOW_PRIMARY=1` exit 0 PASS；WebDriver 全流程 exit 0（session/handles/execute/actions/screenshot/delete/负样本；browserVersion 157.0.4341.46） | DPI/多屏/白闪/鼠标穿透；CI runner/版本不匹配/多窗口/托盘/长时稳定性 |
| 媒体长时（R0-05） | Medium IL 10 分钟干净样例：18,000 帧/600.000 s/缺槽 0/有效 30 fps、视频 53,712,424 B 解码 0、音频 600.020 s、mux 600.000 s、A/V end_skew **−33.67 ms**；与 Low IL 30 分钟（−32.67 ms）一致 → IL 无影响、无累积漂移；进程树峰值 Private 1,217 MB / WS 991.5 MB / CPU 2.46 核（与 Low IL 差 <2%）；暂停/继续、双音源、窗口/区域采集均有实测。首轮受并行负载扰动的 10 分钟样例已登记为不可用（背压导致时间轴截短，R5 需冻结策略） | 双音源时间对齐受本机无声学路径阻塞（环境）；30 分钟 Medium IL 未跑（以 10 分钟干净样例对照）；T4 候选未冻结 |
| 性能/收益 | 产品决策已重估（§8.4）：撤回 -25% 内存目标，T1 改非回归守卫（候选 ≤145.09 MB），不承诺内存/启动收益；计划 §12“换壳后收益不明显”风险行已接受 | 正式 G0 报告需按此表述；R1 真实宿主仍需验证 T1/T2 |
| 环境（ACL） | 工作区 61,767 文件 Low→Medium；whoami/exe token 验证 Medium；静默安装/WGC/选词矩阵三项“环境级阻塞”均由同一根因解释 | 若再次使用 workspace-write 沙箱会话，标签可能被重写；需复检 |

### 9.2 最终 G0 缺口（放行 R1～R7 前仍需闭环）

1. **真实测试机/VM 矩阵**（最高优先，待用户资源）：Win10 22H2、WebView2 无/旧/离线、100/125/150/200% DPI、
   副屏/负坐标、独显、RDP/锁屏/DWM 差异；GitHub hosted runner 不能替代。
2. **WGC 收尾**：打包身份（MSIX/`uap11:Capability`）、同意 UI/采集指示/企业策略、Win10 22H2 与其它 build、
   多显示器/窗口/HDR/4K/60fps/长时 WGC；WebView2 MediaRecorder 与原生采集的**两路同条件对照**；双音源时间对齐真机。
3. **R0-04 收尾**：真实 provider 卡死（2s 有界停止真实触发）、管理员窗口正向样本、资源管理器拖选样本、
   PDF 阅读器/真实网页、混合 DPI/多屏、前台授权（AllowSetForegroundWindow）、helper↔`native/clipboard` lease 联调。
4. **R0-06 收尾**：图片/视频资源桥真实产品链路；缺字体机器；旧/Fixed Runtime 的 `ICoreWebView2_16`；
   RDP/锁屏；打印峰值内存/30s 超时/取消；凭据跨版本/多用户/漫游。
5. **R0-07/安装收尾**：WebView2 多版本/无 Runtime/离线真实机器矩阵、fixedRuntime 实测、UAC/SmartScreen 体验、
   卸载遗留键决策（R8-02）、代码签名门禁。
6. **ADR-0006/0007 收尾**：CI runner 实测、msedgedriver 版本不匹配/无 Runtime 行为、多窗口/托盘/混合 DPI/长时稳定性；
   README 最低系统产品决策（当前仍“候选”）。
7. **修正估算 + 正式 G0 报告**：按本轮证据重估 R5（WGC 可用后媒体后端成本下降、但打包身份/权限语义待验）、
   R1～R8 总量（计划 §11 的 38～63 人周不得沿用），并按 §8.4 的收益表述出正式 G0 结论。

### 9.3 结论

**G0 仍未通过，R1～R7 不得开始。** 但本轮在单机范围内关闭/更正了多个此前的阻塞项：
静默安装链路（根因+修复+复验）、WGC 可用性（更正）、产品真实打印页 PDF 等价性、钩子真机矩阵主体、
30 分钟/暂停/双音源/窗口采集、性能收益重估的产品决策。正式 G0 仍依赖用户提供真实测试机/VM 矩阵与修正估算。
