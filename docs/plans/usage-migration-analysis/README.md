# TokenTracker「用量」页迁移分析 · 配套底稿

本目录是 [../2026-10-21-tokentracker-usage-page-migration-analysis.md](../2026-10-21-tokentracker-usage-page-migration-analysis.md)
（主分析文档）的事实依据与拆解底稿。修改主文档结论前，请先核对对应底稿。

| 文件 | 内容 | 对应主文档章节 |
|---|---|---|
| `01-tt-frontend.md` | TokenTracker 用量页前端拆解：组件树、区块映射、数据契约、图表实现、设计 token 差异、可迁移性四分类 | §2.6、§2.7、附录 B |
| `02-tt-data.md` | TokenTracker 数据管道：46 工具解析器/路径、统一事件模型、增量与去重、指标口径、SQLite DDL 与聚合 SQL | §1.2、§2.2–§2.5、§6.4 |
| `03-hl-arch.md` | Highlighter 架构与落点：主窗口/路由/CSP/i18n/门禁、CLI 日志扫描工程方案、存储选型、页面 IA 映射、文件级改动清单 | §3、§4、§5 D4、§6.3、附录 A |
| `04-hl-ai-usage.md` | Highlighter 自身 AI 调用链与 usage 可得性（**本轮非目标**，作为未来「本应用 AI 消耗」扩展参考） | §6.8 |
| `05-parser-portability.md` | 解析闭包移植评估：20 文件 / 29,690 行、依赖矩阵、方案 A/B/C、工作量、MIT 署名要点 | §2.2、§6.2、§7、§9 |

## 复核约定

- 底稿中的 `T/` 指 `F:/workspace/TokenTracker/`，`H/` 指 `F:/workspace/Highlighter/`；行号以各自 checkout 为准。
- 标注【已验证】的结论可直接复核；标注【推测】/「未验证」的条目在实施前需要实测。
- TokenTracker 版本基线：`v1.4.7-1-g148b758e`（MIT）；Highlighter 基线：`master` @ `a0cdbc2`（4.0.0）。
