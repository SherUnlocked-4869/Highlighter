# R0 G0 决策报告（草案）

日期：2026-11-10。状态：**G0 未通过（草案）**。分支 `codex/rust-r0-baseline-contracts`。
上位文档：[Rust 改造方案与开发计划](../2026-11-10-rust-migration-development-plan.md) §2/§7/§8；
[R0 实施报告](r0-report.md)；[R0 基线](r0-baseline.md)。

本报告按计划 §8 G0 要求汇总七项决策的证据与剩余缺口。**结论是"尚不能放行 R1～R7 全面开发"**；
不写任何"已冻结"。

## 1. G0 放行条件与当前状态

| G0 必备证据（计划 §8） | 当前状态 | 证据 |
|---|---|---|
| R0 三条高风险链路（窗口/钩子/媒体） | 窗口与钩子有实测原型；媒体两路 spike 有证据但未完成同条件对照与长时验证 | [r0-window-prototype.md](r0-window-prototype.md)、[r0-hook-extraction.md](r0-hook-extraction.md)、[r0-media-webview.md](r0-media-webview.md)、[r0-media-native.md](r0-media-native.md) |
| 数据/凭据/PDF/资源通道小样 | 文档/项目夹具、凭据双向、PDF 双后端对照、资源通道 Range/鉴权均完成；真实产品打印页/批量/长图未复验 | [r0-credential-migration.md](r0-credential-migration.md)、[r0-pdf-spike.md](r0-pdf-spike.md)、[r0-resource-channel.md](r0-resource-channel.md) |
| 版本矩阵（Windows/WebView2 有/无/离线） | **未做**（R0-07） | 无证据 |
| 修正估算（R0 后重估） | **未做**（媒体后端重估需要 G0 前结论） | 计划 §11 |
| 性能/资源对照（计划 §9.2） | **未做** | 无证据 |

## 2. 七项决策登记

| ADR | 主题 | 当前建议（草案） | 状态 | G0 前仍缺 |
|---|---|---|---|---|
| [0001](adr/0001-media-backend.md) | 媒体后端 | 候选 C：原生采集（视频+系统音频）+ WebView UI/合成/编码；WebView2 不能作唯一后端 | **候选，未冻结** | 两路同条件对照、30 分钟/双音源/暂停续录、WGC 打包身份实测、Runtime 矩阵 |
| [0002](adr/0002-hook-extraction.md) | 钩子提取边界 | 候选 A：提取 C++ 独立 helper（复用 2,590 行；产品化 18–29 人日） | **候选，未冻结** | 浏览器/Office/资源管理器/管理员窗口矩阵、真实卡死恢复、lease required=true、Rust 剪贴板联调 |
| [0003](adr/0003-pdf-backend.md) | PDF 后端 | 候选 A：WebView2 `PrintToPdfStream`（语义等价；纸张按英寸显式传参） | **候选，未冻结** | 产品真实 `capture/print.html`、批量 50 页、200in 长图、缺字体机器、旧 Runtime |
| [0004](adr/0004-credential-migration.md) | 凭据迁移 | 候选 B（读 Local State DPAPI key + AES-GCM）+ C 强制兜底；A 最后手段 | **候选，未冻结** | 跨版本/多用户/漫游/便携、密钥轮换、迁移中断、安全评审 |
| [0005](adr/0005-binary-resource-transport.md) | 二进制资源传输 | 候选 D：不可猜测 ID + owner 校验；协议 Range 流式 + command 敏感内容 | **候选，未冻结** | 取消/窗口销毁释放、长视频/大文件/并发背压、角色权限映射（R1-04） |
| [0006](adr/0006-desktop-test-driver.md) | 桌面 E2E 驱动 | 未评估（本轮未做） | **待验证** | `tauri-driver`/WebView2 CDP 对照、版本冻结、生产包不含测试端点 |
| [0007](adr/0007-minimum-windows-runtime.md) | 最低 Windows/Runtime | 未评估（本轮未做） | **待验证** | 真实测试机、WebView2 有/无/离线矩阵、README 兼容决策 |

## 3. 未完成 R0 任务

| 任务 | 状态 | 说明 |
|---|---|---|
| R0-03 真机 DPI 矩阵 | 部分 | 窗口原型编译/自检通过、副屏负坐标实测；100%/200% 缩放视觉、白闪、单屏拒绝路径需用户参与改显示设置 |
| R0-04 | 原型完成 | 提取小样与真实选词验证；剩余矩阵见 ADR-0002 |
| R0-05 | 两路 spike 完成 | 后端选型仍待同条件对照与长时验证；WGC 需打包身份 |
| R0-06 | 大部分完成 | 凭据/PDF/资源通道/文档项目夹具完成；图片视频资源桥真实产品链路未接入（原型级）、安装烟测未做 |
| R0-07 | **未开始** | NSIS 测试包、WebView2 环境矩阵、首轮性能对照、硬件证据 |
| 测试驱动 ADR-0006 | **未开始** | 需 R0-07/真机 |
| 最低系统 ADR-0007 | **未开始** | 需真实测试机 |

## 4. 对 R1～R8 排期的影响（初判）

- 媒体后端从"WebView2 复用"改为"原生采集 + WebView 合成/编码"候选，R5 的 8–14 人周需要重估；
  计划 §11 的 38–63 人周总量在 G0 后必须更新，不得沿用。
- 钩子按"提取"候选，R3 成本区间 18–29 人日（ADR-0002），与计划估算方向一致。
- PDF/凭据/资源通道候选方案均有实测支撑，R2/R4/R5 的实现风险下降，但仍需真实产品用例复验。

## 5. 建议的 G0 收尾清单（放行前必须完成）

1. R0-07：NSIS 测试包 + WebView2 有/无/离线矩阵 + 首轮 Release 性能/进程树对照（固定电源方案）。
2. R0-05：两路同条件对照 + 30 分钟双音源/暂停续录 + WGC 打包身份实测。
3. R0-04：浏览器/Office/资源管理器/管理员窗口矩阵 + 真实卡死恢复 + lease required=true + 与
   `native/clipboard` 联调。
4. R0-03：用户参与完成 100/150/200% DPI 与单屏/多屏视觉矩阵（可见窗口放副屏）。
5. R0-06：产品真实 `capture/print.html` 批量/长图 PDF、图片视频资源桥真实链路、安装烟测。
6. 测试驱动 ADR-0006 与最低系统 ADR-0007 的实测与版本冻结。
7. 汇总修正估算与门禁结论，形成正式 G0 报告。

## 6. 声明

- 本报告不改变任何产品行为；所有原型均未接入产品入口。
- 所有"候选"建议均以本分支证据文档为准；文档中的"未验证"项不得在 G0 报告中改写成通过。
- G0 通过前不开始 R1～R7 业务迁移（计划 §7/§8）。
