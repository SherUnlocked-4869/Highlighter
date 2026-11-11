# R0 决策记录（ADR）索引

日期：2026-11-10（更新 2026-11-11 14:00：0006/0007 由“待验证”推进为候选）。状态：**全部 ADR 均为 R0 草案，G0 未通过前不构成架构冻结**。

规则（计划 §2、§8）：

- 每项记录：备选、实测证据、失败分支、选定理由、未解决限制、责任批次与退出验收。
- 没有实测证据的项必须标 **待验证**；不得只写结论，也不得把"文件存在"当作实测通过。
- 实测证据放在 `.tmp-r0-*/`（gitignore）时，文档必须写清命令、关键输出与证据哈希/路径；正式结论以文档与提交为准。
- 媒体、钩子、PDF、凭据、资源通道、测试驱动、最低系统七项决定 G0；本目录逐项记录，G0 报告见
  [r0-g0-report.md](../r0-g0-report.md)。

| ADR | 主题 | 决定批次 | 状态 | 证据 |
|---|---|---|---|---|
| [0001](0001-media-backend.md) | 录屏媒体后端（WebView2 vs 原生采集） | R0-05 / R5 | **候选 C（原生采集 + WebView 合成/编码），未冻结** | [r0-media-webview.md](../r0-media-webview.md)、[r0-media-native.md](../r0-media-native.md) |
| [0002](0002-hook-extraction.md) | 划词/回贴钩子提取边界 | R0-04 / R3 | **候选 A（提取 C++ helper），未冻结** | [r0-hook-extraction.md](../r0-hook-extraction.md) |
| [0003](0003-pdf-backend.md) | PDF 导出后端 | R0-06 / R4-07 | **候选 A（WebView2 PrintToPdfStream），未冻结** | [r0-pdf-spike.md](../r0-pdf-spike.md) |
| [0004](0004-credential-migration.md) | 凭据迁移格式 | R0-06 / R2/R8 | **候选 B（Local State key + AES-GCM）+ C 兜底，未冻结** | [r0-credential-migration.md](../r0-credential-migration.md) |
| [0005](0005-binary-resource-transport.md) | 图片/视频二进制资源传输 | R0-06 / R1/R4/R5 | **候选 D（协议 Range + command 敏感内容），未冻结** | [r0-resource-channel.md](../r0-resource-channel.md) |
| [0006](0006-desktop-test-driver.md) | 桌面 E2E 测试驱动与版本 | R0 / R1 | **候选 A1（tauri-driver 2.1.0 + 精确匹配 msedgedriver 2.1.0/157.0.4341.46），未冻结** | [r0-test-driver.md](../r0-test-driver.md) |
| [0007](0007-minimum-windows-runtime.md) | 最低 Windows / WebView2 Runtime 下限 | R0-07 / R8 | **候选 A+D（Win10 22H2+Win11、Evergreen 默认 + 离线制品），未冻结** | [r0-minimum-windows-runtime.md](../r0-minimum-windows-runtime.md) |

模板：[0000-template.md](0000-template.md)。每份 ADR 至少包含：背景、备选、实测条件与命令、证据（含失败分支）、结论/建议、未解决限制、责任批次与退出验收、变更记录。

> **2026-11-11 晚间收尾更新（ACL 缺陷修复后复验）**：0001 的 WGC“本机被拒”结论已被更正为
> **本机 Medium IL 实测可用**（原 `E_ACCESSDENIED` 来自工作区 Low 完整性标签环境缺陷，见
> [r0-g0-report.md](../r0-g0-report.md) §8.4/§9.1）；0002 补充真机矩阵 10 行 9 PASS、管理员窗口 UIPI 负样本、
> lease 协议级互通（helper↔native/clipboard 仍未联调）；0003 补充产品真实 `capture/print.html`
> 单图/长图 200in/批量 50 页双后端复验；0006 在 ACL 修复后 WebDriver 探针复跑通过。
> **所有 ADR 状态仍为候选/未冻结，G0 未通过。** 逐项证据以各自 ADR 与证据文档为准。
