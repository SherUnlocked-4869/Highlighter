# 设计分析：把 TokenTracker「用量」页迁移到 Highlighter（含实施路线）

- 日期：2026-10-21
- 状态：**分析完成，未实施**（本文只产出分析，不改产品代码）
- 基线：
  - Highlighter `F:/workspace/Highlighter` @ `master` / `a0cdbc2`，版本 4.0.0；Electron 43.2.0 / Node 24.18.0。
  - TokenTracker `F:/workspace/TokenTracker` @ `v1.4.7-1-g148b758e`（MIT，Copyright (c) 2026 xiufengsun）。
- 用户输入：截图（TokenTracker 深色「用量」页，2638×1589）+ 2026-10-20 口径修正——
  **统计对象是「本机 AI 编程 CLI 工具的日志用量」，与 TokenTracker 完全同口径；不是 Highlighter 自身 AI 调用的 token。**
- 事实来源（同目录分析底稿，供复核）：
  - `../../.tmp/usage-migration/01-tt-frontend.md`（TokenTracker 用量页前端/组件/数据契约）
  - `../../.tmp/usage-migration/02-tt-data.md`（采集、统一事件模型、46 工具路径、指标口径、SQLite 模型）
  - `../../.tmp/usage-migration/03-hl-arch.md`（Highlighter 架构、门禁、落点、扫描工程方案）
  - `../../.tmp/usage-migration/04-hl-ai-usage.md`（Highlighter 自身 AI 调用 usage 现状，**本轮非目标**，作为未来扩展参考）
  - `../../.tmp/usage-migration/05-parser-portability.md`（解析层移植规模/依赖/方案 A/B/C/工作量）

---

## 0. 结论摘要（先看这一页）

### 0.1 可行性判断

**可行，但这不是「把页面搬过来」，而是「把 TokenTracker 的数据引擎拆一半搬过来、页面重写」。**

TokenTracker 的「用量」页由三层组成：

| 层 | TokenTracker 现状 | 迁移到 Highlighter 的方式 |
|---|---|---|
| 采集/解析层 | 46 个 `parse*Incremental` 全在 `src/lib/rollout.js`（25,966 行）；解析闭包共 20 文件 / 29,690 行 / 1.13 MB | **可整体 vendor**（MIT、零 npm 依赖增量），仅改根路径/去 Trae/去 zstd fallback |
| 编排层 | `src/commands/sync.js` 7,843 行（扫描编排 + 云上传 + hook 安装 + 历史修复 + 遥测混在一起） | **必须重写**本地部分（表驱动工具注册 + 增量游标 + 调度），云/hook/遥测全部丢弃 |
| 聚合/存储层 | 本地无数据库，`~/.tokentracker/tracker/queue.jsonl` 全量重放（`local-api.js` 3,588 行） | **必须重写**：改成 `<dataRoot>/usage/usage.db`（`node:sqlite`，Electron 43 已实测可用），保留 queue 的「半小时 UTC 桶 + 按 `(source,model,hour)` 取最新」语义 |
| 页面层 | React + Tailwind + motion + @dnd-kit + @base-ui（零图表库，图表全手绘） | **必须重写**为 vanilla JS + CSS：Highlighter 设置窗无构建、CSP `connect-src 'none'`、Nightshift token 体系 |
| 设计语言 | 绿调暗色 + emerald 品牌 + 16px 圆角 + Tailwind 类 | **保留信息架构与数据密度，视觉换 Nightshift**（暖炭表面、用户主色、elevation、可调圆角） |

### 0.2 推荐路线（一句话）

> **路线 A：vendor TokenTracker 解析闭包（MIT，零新增依赖）→ 重写本地编排与 SQLite 聚合 → 在 Highlighter 设置窗口新增「用量」路由 → 用 Nightshift 语言重画用量页。**
>
> 交付节奏：**最小演示（3 工具 + 主视图）≈3 周 → MVP（8 工具 + 主视图）4–6 周 → 完整版（45 工具 + 金额）9–13 周**（单人基准约 **36–54 人日**，含 20% 缓冲约 43–65 人日）。若只做 6–8 个工具且不做成本/热力图/项目，按 MVP 口径即可。

### 0.3 关键数字（全部经源码/运行时核对）

| 事实 | 数值 | 证据 |
|---|---|---|
| TokenTracker 解析器数量 | **46 个** `parse*Incremental` | `TokenTracker/src/lib/rollout.js` |
| 解析闭包规模 | **20 文件 / 29,690 行 / 1.13 MB** | 依赖闭包实测（`05` 文档 §2.1） |
| 编排/聚合需重写规模 | `sync.js` 7,843 + `local-api.js` 3,588 行（与云/账号/HTTP 耦合） | `05` §2.2 |
| 解析层新增 npm 依赖 | **0**（删 `@mongodb-js/zstd` fallback；唯一例外 Trae 的 `wa-sqlite` 建议首版放弃） | `05` §4 |
| Electron 43.2.0 运行时 | **Node 24.18.0 / SQLite 3.53.1 / zstd 1.6.0**；`require('node:sqlite')`、`zlib.zstdDecompressSync` 实测可用 | 本机 `ELECTRON_RUN_AS_NODE` 探针 + `03` §8.1 |
| Highlighter 主窗口 | 1120×760（min 880×620）→ 默认内容宽约 **846px** | `main.js:800-811` |
| 现有硬门禁 | `main.js` 1324 / 上限 1330（余 6 行）；i18n CJK 585 / 上限 606（余 21 行）；c8 行覆盖 91.85% / 门槛 85% | `scripts/check-architecture.js:25`、`scripts/check-i18n.js`、`package.json:14-17` |
| 本机 TokenTracker 数据 | `~/.tokentracker/tracker` 约 **40 MB**（queue 252 KB / 796 行，cursors.json 8.2 MB） | 本机实测 |

### 0.4 必须先拍板的 5 件事（详见 §5 决策表）

1. **工具覆盖范围**：首版 6–8 个（Claude Code / Codex / Gemini / OpenCode / DeepSeek Harness / Kimi Code / Qoder / Copilot）还是 45 个。
2. **页面落点**：设置窗口新增路由（推荐，846px 单栏起步、宽屏两栏）还是独立窗口（可 1280px 双栏）。
3. **金额（美元）做不做**：做需 vendor 定价层（1,833 行 + 约 289 KB 种子），不做可省 3–5 人日。
4. **隐私/开关**：扫描用户 AI CLI 会话日志是敏感能力——默认开启并明示、还是默认关闭需用户显式开启；是否允许写 hook（建议：**只读、首版不写任何工具配置**）。
5. **历史回填范围**：CLI 日志天然有历史，首扫即可回填（这是本方案相对「统计 Highlighter 自身调用」的最大优势）；需定「回填多少个月」。

---

## 1. 需求与「同口径」的精确含义

### 1.1 需求重述

- 在 Highlighter 内新增一个与 TokenTracker「用量」页**信息架构、数据密度、展示形式一致**的页面。
- 数据来源与 TokenTracker 相同：**读取本机 AI 编程 CLI 工具自身产生的日志/数据库**，聚合出 token 用量、模型/来源分布、每日明细、趋势与热力。
- 仅做分析，本轮不写实现代码。

### 1.2 「与 TokenTracker 同口径」= 必须逐条复述以下 12 条

| # | 口径 | 定义 |
|---|---|---|
| 1 | 时间桶 | 写入统一 **UTC 半小时桶**（`:00` / `:30`），展示时按用户 IANA 时区折算本地日 |
| 2 | 总 TOKEN | 显示 **`billable_total_tokens`**（缺省回退 `total_tokens`），不是简单 `input+output` |
| 3 | 输入 | **非缓存输入**（Codex 类日志的 input 含 cache，必须先减掉） |
| 4 | 缓存 | **cache read**（`cached_input_tokens`）与 **cache write**（`cache_creation_input_tokens`）分开存、分开计价 |
| 5 | 推理 | `reasoning_output_tokens`：Claude 单列计费（output 已扣）；Codex/OMO/Cline 等是 output 子集，**不重复计费** |
| 6 | 成本 | `Σ computeRowCost(row)`：用 5 个基础 token 列 × 单价现算，**绝不用 total_tokens 推算**；无价格的模型 token 照记、成本 $0 并标 `unpriced` |
| 7 | 对话数 | `conversation_count` = **解析事件数（消息/回合/请求条数）**，不是去重会话数 |
| 8 | 周期 | 日=当天；周=周一 00:00 起 7 天；月=自然月；总计=最近 24 个月；自定义=任选区间 |
| 9 | 每日明细列 | 日期、总计（billable）、输入、输出、缓存（cache read）、推理、对话数；**不含 cache write 与成本** |
| 10 | 热力图 | 52 周 × 7 天；单元格值 = billable；level 按**区间最大值的相对四档**（≤25% / ≤50% / ≤75% / >75%） |
| 11 | 趋势「预测值」 | 只是缺失/未来桶的**视觉插值**：两侧有观测→线性插值；单侧→均值 × 每步 0.98 衰减；不是预测模型 |
| 12 | 滚动 7/30 天 | 按今天往前 7/30 个自然日；`active_days` = 有量天数 |

> 另：来源（source）维度 = 46 个工具标识；模型维度 = 日志中记录的实际模型 id（未知记 `unknown`）；项目维度 = git `owner/repo`（可选，二期）。

### 1.3 明确的非目标（本轮）

- 云端/账号/多设备/排行榜/成就/社区统计/桌面宠物/小组件/Skills/服务状态页——TokenTracker 的账户体系与 Highlighter 无关，全部不迁移。
- TokenTracker 的 3D 热力图（自绘等轴投影 SVG，约 3–4 人日）——建议砍掉，保留 2D。
- 「研发性价比与交付成本」卡（依赖 `outcomes.jsonl` + git 归因）——不迁移。
- 会话洞察/性能分析卡、分享图、设备筛选、订阅徽章——不迁移。
- **Highlighter 自身 AI 调用的用量统计**——本轮不做，作为可选的后续能力（见 `04-hl-ai-usage.md`，届时需在 `main/services/ai-protocol-adapters.js` 截获 usage）。

---

## 2. 参考实现拆解（TokenTracker 侧）

### 2.1 端到端数据流

```
AI 编程 CLI 运行（Claude Code / Codex / Gemini / Cursor / …）
  → 产生本地日志/DB（JSONL / SQLite / OTEL / 快照 JSON）
  → [SessionEnd hook 或 5 分钟后台 sync 触发]
  → sync.js:cmdSync() 编排：发现根目录 → 每工具 resolver → parse*Incremental()
  → rollout.js 内部：增量读取（inode/offset）→ 去重 → 归一为 UTC 半小时桶
  → ~/.tokentracker/tracker/queue.jsonl（append-only，一行一个 (source,model,hour_start) 桶）
  +  project.queue.jsonl / cursors.json / queue.state.json
  → local-api.js 读 queue 全量重放 → 按 tz 聚合为 summary/daily/heatmap/model-breakdown
  → 本地 HTTP 127.0.0.1:7680 /functions/tokentracker-usage-*
  → dashboard（React）渲染
```

要点：

- **hook 只负责「及时触发 sync」**，真正的数据仍来自日志文件；因此 Highlighter **可以只做被动扫描**，不写任何其它工具的配置（首版强烈建议如此）。
- TokenTracker 本地**没有用量数据库**：历史就是 `queue.jsonl`（append-only + 读取取每个 key 的最新行）；SQLite 只用于**只读**打开被监控工具自己的库。
- 读取端语义：`(source, model, hour_start)` 为逻辑主键，后写的行覆盖先写的行（LWW）。

### 2.2 规模拆解（决定「能搬什么」）

| 模块 | 行数 | 迁移判断 |
|---|---|---|
| `src/lib/rollout.js`（46 解析器 + 桶聚合/去重核心，588 个顶层函数） | 25,966 | **直接 vendor**（去 Trae、去 `@mongodb-js/zstd` fallback、路径参数化） |
| 解析闭包其余 19 个文件（`jsonl-lines`/`sqlite-reader`/`scan-roots`/`install-resolver`/`wsl-probe`/`fs`/`tracker-paths`/`claude-user-identity`/`codex-*`/`devin-usage`/`grok-usage`/`cursor-config`/`trae-*`/`pricing`） | 3,724 | **直接复用或小改**（`trae-*` 首版放弃；`cursor-config` 仅保留路径常量；pricing 仅在写金额时引入） |
| `src/commands/sync.js`（扫描编排 + 云上传 + hook 安装 + 历史修复 + 遥测） | 7,843 | **重写**本地编排部分；云/hook/遥测丢弃 |
| `src/lib/local-api.js`（queue 聚合端点 + 云端账号/认证） | 3,588 | **重写**用量聚合；账号/HTTP 层丢弃 |
| `src/commands/serve.js`（本地 HTTP 服务 + 静态 dashboard） | 793 | 不需要（IPC 直连） |
| `src/lib/pricing/*`（`computeRowCost` + 2,200+ 模型种子 + curated 覆盖） | 1,833 + 约 289 KB JSON | 做金额时 **vendor**；不做金额则跳过 |
| `src/lib/cursor-store.js`（大状态游标 v2 分片） | 1,918 | 可简化：Highlighter 用 SQLite `scan_state` 表 |
| 解析测试资产 | 28 个 parser 测试文件 / 35,948 行；全仓 405 个测试文件 | 随解析层 vendor，作为**上游契约测试** |
| dashboard（React/Vite） | 1,200+ 文件 | **不搬代码**，只搬信息架构与纯函数逻辑 |

> 结论：**解析层约 30k 行可整搬（零依赖），编排 + 聚合约 12k 行必须拆分重写。** 这就是「整体移植不可行、但可拆分移植」的依据，也是工作量估算的主线。

### 2.3 46 个工具的接入方式（决定首版范围）

| 类别 | 数量（约） | 代表 | 迁移策略 |
|---|---|---|---|
| 纯被动只读（JSONL / SQLite / 任务 JSON / OTEL） | 38 | Claude Code、Codex、Gemini、OpenCode、Kimi、Cline、Copilot、Qoder、ZCode、DSH、Zed、Goose、Droid、Pi/OMO、Hermes… | **可直接支持**；首版挑高频子集 |
| 需要写 hook/notify 到用户工具配置 | 6+ | Codex notify、Acode、WorkBuddy、Grok、OMP、OpenClaw | **首版不做**（被动扫描仍可拿到大部分数据，只是延迟） |
| 需要联网 + 用户凭据 | 2 | Cursor（账号级 CSV/API）、TRAE Work CN（内部 API） | **首版不做**，页面诚实标注「不支持本地统计」 |
| 需要 SQLCipher + WASM | 1 | TRAE（`wa-sqlite`） | **首版放弃**（唯一硬依赖例外） |

> **Cursor 的预期管理是产品重点**：TokenTracker 明确把 Cursor 归为「账号级云 API 来源」，本地没有用量日志（`src/lib/cursor-config.js:12-32,196-231`、`rollout.js:7528`、`source-metadata.js:1`）。Highlighter 若照搬截图，用户会问「为什么没有 Cursor」——页面必须显示覆盖状态并解释原因。

### 2.4 统一事件模型（Highlighter 目标 schema 直接对齐）

```json
{"source":"claude","model":"claude-opus-4-6","hour_start":"2026-04-05T14:00:00Z",
 "input_tokens":0,"cached_input_tokens":0,"cache_creation_input_tokens":0,
 "output_tokens":0,"reasoning_output_tokens":0,"total_tokens":0,
 "billable_total_tokens":0,"conversation_count":1,
 "total_cost_usd":0,"usage_precision":"estimated"}
```

| 字段 | 语义 |
|---|---|
| `hour_start` | UTC 半小时桶起点（展示时按 IANA 时区折算本地日） |
| `source` | 工具标识（46 类） |
| `model` | 实际模型 id，未知写 `unknown` |
| `input_tokens` | **非缓存**输入 |
| `cached_input_tokens` / `cache_creation_input_tokens` | cache read / cache write |
| `output_tokens` | 输出（Claude 已扣 reasoning） |
| `reasoning_output_tokens` | 推理；视来源可能是 output 子集 |
| `billable_total_tokens` | 页面「总 TOKEN」用的数 |
| `conversation_count` | 事件数（非去重会话） |
| `usage_precision` | `estimated` 表示文本估算（Antigravity / Kiro CLI / Grok） |

### 2.5 指标与聚合口径

| 指标 | 口径 | 页面位置 |
|---|---|---|
| TOKEN 总数（大字） | 区间内 `Σ billable_total_tokens` | 右栏主统计区 |
| 美元 | `Σ computeRowCost(row)`（5 个基础列 × 单价）| 大字下方 |
| 日/周/月/总计/自定义 | 见 §1.2 第 8 条 | 顶部 tabs |
| KPI：7 天 / 30 天 / 日均 | 滚动窗口 billable / 30 天活跃日均 | 左上 4 卡 |
| 对话数（KPI 第 4 格） | `Σ conversation_count` | 左上 4 卡 |
| 模型占比 | 按模型聚合 billable，Top N + 百分比 | 左上列表 / 右栏展开 |
| 来源（provider）占比 | 按 `source` 聚合，分段条 + 卡片（全部/各工具 + N 个模型） | 右栏 |
| 热力图 | 52×7，level 相对四档 | 左栏 |
| 趋势 | 区间桶（日视图用小时桶）堆叠柱 + 缺失/未来插值 | 左栏 |
| 每日明细 | 日期/总计/输入/输出/缓存/推理/对话数 | 右栏表格 |
| 项目用量（可选二期） | `project.queue`（git owner/repo）Top 10 | 明细 tab |

### 2.6 页面结构与截图区块映射

实际组件树（当前 checkout）：

```
DashboardPage（1500 行，全部数据编排）
└─ DashboardView（12 栅格：左 4 / 右 8；移动端顺序反转）
   ├─ 左列：StatsPanel（4 KPI + Top3 模型 + 开始使用/活跃天数）
   │        ActivityHeatmap（2D/3D 切换、时区标签）
   │        TrendMonitor（堆叠柱 + tooltip + 放大）
   │        QualityPerDollarCard / SessionInsightsCard（Labs，默认关）
   └─ 右列：UsageOverview（日/周/月/总计/自定义 + 大字总数 + 成本 + 来源占比卡）
            DataDetails（每日明细 / 项目用量 tab + 详情 Modal）
   ＋ CostAnalysisModal / ShareModal / CommandPalette
```

截图区块 → 组件 → 迁移结论：

| 截图区块 | TokenTracker 组件 | Highlighter 结论 |
|---|---|---|
| 左上 4 KPI（7 天/30 天/平均/对话） | `StatsPanel` | **保留**，复用 `.history-stats` 的四列 KPI 条 |
| 模型占比列表（条形） | `StatsPanel` Top3（当前 checkout 无条形几何，截图疑似更新版本） | **保留**：主色系占比条 + Top N |
| 开始使用/活跃天数 | `StatsPanel` footer | **改造**为「统计覆盖起点 / 活跃天数」 |
| 热力图（2D/3D、时区、少→多） | `ActivityHeatmap` | 2D **保留**（P2）；3D **砍**；时区改「跟随系统」只读说明 |
| 使用趋势堆叠柱 + 预测值 | `TrendMonitor` | **保留简化版**：近 14/30 天堆叠柱；预测插值可选 |
| 研发性价比与交付成本 | `QualityPerDollarCard` | **砍**（依赖 outcomes/git） |
| 日/周/月/总计/自定义 | `UsageOverview` tabs | **保留**；自定义 P2 用两个原生 date input |
| TOKEN 大字 + 美元 + 区间 | `UsageOverview` 主统计区 | **保留**；金额待决策（§5 D6） |
| 蓝色进度/分布条 | `UsageOverview` provider 分段条 | **保留**为来源占比分段条（用 Nightshift 主色系） |
| 来源占比卡（全部/DeepSeek/CODEX/ZCODE + N 个模型） | `UsageOverview` provider 卡网格 | **保留**：全部 + 各来源卡 + 模型数 |
| 每日明细表（日期/总计/输入/输出/缓存/推理/对话数） | `DataDetails` | **保留**（核心价值） |
| 项目用量 tab / 分享 / 云 / 设备 / 安装卡 / 订阅徽章 | `DataDetails`/`UsageOverview` | **砍**；项目用量二期可选 |

> **截图版本提醒**：本地 checkout 为 `v1.4.7-1-g148b758e`，截图中「模型占比条形列表」「UTC 时区切换」「蓝色主进度条」在当前代码中无法 1:1 对位（`01-tt-frontend.md` §2.3），推测截图来自更新的 TokenTracker 版本。本文按「布局意图」设计，不按像素验收；若要逐像素复刻，需用户提供截图对应版本/commit。

### 2.7 图表与前端实现方式（对 vanilla 迁移是关键利好）

- **零图表库**：没有 recharts/d3/echarts/chart.js。热力图 = CSS Grid + 分位阈值；趋势柱 = flex div 堆叠；分布条 = 百分比宽 div；3D = 自写 SVG 等轴投影（本项目建议砍）。
- 真正的 React 依赖只有 4 类：`motion`（动画/数字滚动）、`@dnd-kit`（卡片拖拽，可砍）、`@base-ui/react`（日期 Popover，可换成原生控件）、`react-day-picker + date-fns`（自定义日历，P2 可换成 `<input type="date">`）。
- 可复用的纯函数资产（有 vitest 用例）：数字格式化、日期区间/时区、热力图分位、趋势插值、模型/来源合并、明细分页。**这些是迁移中最可靠的资产**，建议逐条翻译为 Highlighter 的纯函数 + `node:test`。
- 设计语言冲突：TokenTracker 是「绿品牌 + 绿灰中性 + 近黑底 + 1px 边框 + 16px 圆角 + Tailwind `dark:`」；Nightshift 是「暖炭/沙色 + 用户可配置单主色 + elevation 分层 + 用户可调圆角 + `body.dark`」。**必须做 token 映射，不能搬 class**。

### 2.8 已知数据质量坑（迁移必须继承防御）

| 坑 | 说明 | 影响 |
|---|---|---|
| Codex input 含 cache | 旧行按 `total==input+output` 启发式修复 | 不减 cache 会重复计费/口径错 |
| Cursor/Antigravity billable=0 | 读取时上调为 total | 显示 0 的假象 |
| 去重键缺陷 | 只判 `msgId&&reqId` 会漏部分供应商 | 过计 1.6–3.7× |
| 镜像源重复 | Mimo 大量镜像 Claude、OMP/OMO 同构、fork 副本 | 必须按 providerID/指纹剔除 |
| 估算 token | Kiro CLI/Antigravity/Grok 无真实拆分 | 必须标 `estimated` |
| 成本重算 | TokenTracker 读取时用当前价格重算，历史金额会变 | 口径需显式决定（§5 D6） |
| 日志重写 | Codex 会原子重写 session 文件 | 增量偏移失效时必须「先减旧贡献再重扫」 |
| 大文件 | 单会话 JSONL 可达 MB 级 | 必须流式读取、限制单行大小、跳过坏行 |

---

## 3. Highlighter 现状与硬约束

### 3.1 主窗口 = 设置窗口

- Highlighter 没有第二个设置窗口：`createMainWindow()` 加载 `config/config.html`，`1120×760`、`min 880×620`、`frame:false`（`main.js:787-830`）；侧栏 224px、`#view` 左右 24px、`.page` max-width 980 → **默认内容约 846px，最小窗口约 606px**。
- 关闭按钮只是 `hide()`；再次打开走 `app:navigate`（同一窗口复用）。

### 3.2 路由体系（新增页面的接入点）

- `config/config.js`：`routes` 分派表 + `routeTitles` + `window.configRoutes` 注册契约；所有路由脚本是 classic `<script>`，共享全局作用域，`config.js` 最后加载。
- 新增路由必须同步改：`config/routes/usage.js`（新建）、`config/config.html`（侧栏按钮 + script 引用）、`config/config.js`（routes/routeTitles）、图标文件、locale、`test/config-icon-contract.test.js`（导航图标精确 12→13）、`e2e/highlighter.spec.js` 路由渲染清单。
- 语言热切换会 `navigate(currentRoute)` 重建当前页 → 渲染函数必须可重复执行、不得叠加 document 级监听。
- 渲染模式：`view.innerHTML` 模板拼接 + 逐控件绑定；共享 helper 在 `window.configShared`（`escapeHtml/errorMessage/iconMarkup/toast/applyAppearance/updateSettings/pageHeader/formatBytes/...`），测试逐项钉死。

### 3.3 渲染层硬约束（决定能不能用图表库）

| 约束 | 值 | 后果 |
|---|---|---|
| CSP | `default-src 'none'; script-src 'self'; connect-src 'none'; worker-src 'none'; style-src 'self' 'unsafe-inline'` | 禁 CDN/远程请求；数据必须走 IPC；图表只能自绘或本地 UMD |
| 构建 | 无 bundler（依赖里无 vite/webpack） | 新库必须 UMD/IIFE 且直接 `<script src="../node_modules/...">`（`dompurify`/`jsqr` 有先例） |
| 主窗口首屏 | `ready-to-show` 是启动性能关键路径 | 不建议引入 200KB–1MB 的图表库 |
| 设计系统 | Nightshift token（`--bg/--surface/--line/--ink/--primary/--radius/--font-*`），主色/圆角用户可调 | 图表必须消费 token，不能硬编码 |
| i18n | 三语对称；CJK 未迁移行上限 606（当前 585，余 21） | 新代码零中文（注释/日志）；页面文案全部进 `shared/locales/config.js` |

### 3.4 数据与持久化现状

- 单一 electron-store：`<dataRoot>/config/config.json`（settings + captureHistory），每次写入重写整文件 → **不适合存事件**。
- 运行日志：`<dataRoot>/logs/app.log`（JSONL，2 MB×3 轮转，**键名含 token 会被脱敏**）→ 不可作用量主存储。
- 数据目录：`createDataPaths()` 生成 `config/logs/history/conversations/clipboard/cache/runtime`；数据目录迁移只搬白名单（`config.json`、`app.log*`、`history/**`、`conversations/**`、`clipboard/**`）——**新增顶层目录必须同步改 `createDataPaths` 与 `MANAGED_DIRECTORIES` 及迁移复制/校验/测试，否则切数据目录静默丢历史**。
- 可参考的持久化范式：`ConversationStore`（注入式 fileSystem/writeJson、目录校验、retention、失败吞错、schemaVersion）+ `atomicWriteJson`（tmp+rename+backup）。
- IPC：`ipc-security.js` 的 `IPC_SURFACES` 白名单 ↔ 注册必须完全一致，`assertComplete()` 启动即校验；preload 是唯一暴露面；新增通道要登记 handles/listeners、preload 方法、页面策略三处。

### 3.5 运行时能力（已实测）

| 能力 | 结果 | 用途 |
|---|---|---|
| Electron 43.2.0 内置 Node | **24.18.0**（系统 Node 24.16.0） | 解析层依赖 Node ≥20，满足 |
| `require('node:sqlite')` | **可用**：`DatabaseSync/StatementSync/Session/constants/backup`；WAL/事务/`readOnly` 通过；SQLite 3.53.1 | 本地用量库**零新增依赖** |
| `zlib.zstdDecompressSync` | **可用**（zstd 1.6.0） | 解压 Codex/DSH 的 `.zst` 日志，删 `@mongodb-js/zstd` |
| 既有原生依赖政策 | `npmRebuild:false`，只有 sharp/onnxruntime/selection-hook 三个预编译 N-API；SQLite 类需求历史上走 Rust sidecar | **不要引入 better-sqlite3**；node:sqlite 是唯一零成本选择 |
| 子进程先例 | `utilityProcess.fork`（划词 hook 宿主，`main/services/selection-hook-service.js:91-96`） | 扫描器放 utilityProcess 有先例；worker_threads 无先例 |

### 3.6 门禁清单（新功能必须全部通过）

| 门禁 | 内容 | 余量 |
|---|---|---|
| `main.js` 行数 | ceiling 1330 | 当前 1324，**只剩 6 行** |
| i18n | 三语 key 对称 + CJK 上限 606 | 585，余 21 行 |
| c8 覆盖率 | `main/services/**`、`main/ipc/**` 行覆盖 ≥85%（当前 91.85%） | 新增文件必须有单测 |
| 路由/图标契约 | 路由 key ↔ 注册双向一致；导航图标精确数；磁盘 route 文件 ↔ HTML 引用集合相等 | 新增路由必须同步 |
| IPC 安全 | 白名单 ↔ 注册精确对账；每个 preload 通道有页面策略 | 漏一启动即抛 |
| CSP/窗口安全 | 每页严格 CSP、无内联 script | 页面必须复用现有模式 |
| e2e | 真实 Electron 启动、逐路由渲染 | 新路由要进清单 |

---

## 4. 差距分析（Gap Analysis）

### 4.1 能力差距矩阵

| 能力 | TokenTracker | Highlighter | 差距性质 |
|---|---|---|---|
| 外部 CLI 日志解析 | 46 工具、30k 行、成熟去重/游标 | 0 | **需移植（可 vendor）** |
| 扫描编排/调度 | 7.8k 行（与云/hook 耦合） | 0 | **需重写** |
| 本地用量存储 | queue.jsonl 全量重放 | 无 | **需新建**（建议 SQLite） |
| 聚合/查询 | 3.6k 行 HTTP 端点 | 无 | **需重写**（纯函数 + IPC） |
| 页面与图表 | React + Tailwind + motion | vanilla JS + CSS，无图表库 | **需重写** |
| 数据可视化设计 | 绿调暗色体系 | Nightshift 暖炭体系 | **需重新设计（保留结构，换语言）** |
| 成本/定价 | 三层价格体系 + 2,200 模型 | 无 | 可选移植 |
| 账号/云/多设备 | 完整 | 无（也不应有） | **不迁移** |

### 4.2 为什么不能直接搬 dashboard

1. React 18 + Tailwind + motion + @dnd-kit + @base-ui，需要 Vite 构建；Highlighter 渲染层无构建、classic script、CSP `script-src 'self'`。
2. `connect-src 'none'`：不能 fetch 本地 HTTP API，数据必须走 IPC。
3. Tailwind `dark:` 体系与 Nightshift `body.dark` + token 双声明不同；搬 class 会同时带进第二套色板/圆角/字体。
4. 浏览器端有 localStorage 缓存、30s 轮询、单飞刷新等 Web 专属机制，Electron 版应改为主进程缓存 + IPC。

### 4.3 为什么不能整体搬 TokenTracker `src/`

`src/` 共 114 个 JS / 82,546 行 / 3.45 MB；其中 `sync.js` 与 `local-api.js` 的 require 闭包分别达 88 文件 / 73,335 行与 79 文件 / 63,960 行，混入云上传、账号、遥测、Sentry、hook 安装、历史修复迁移。整体 vendor 会引入 5 个 npm 依赖、后台联网/遥测风险、双写冲突与长期 fork 维护成本——**性价比低于拆分移植**。

### 4.4 可行性结论

- **技术上完全可行**；主要成本在「编排语义吃透 + 页面重写 + 门禁适配」，不在解析器本身。
- 最大不确定性是**产品范围**（工具数量、是否做金额/热力图/项目）与**外部日志契约漂移**，而不是技术障碍。

---

## 5. 关键决策点（建议）

> 每条给出选项、推荐与理由；推荐值可直接作为实施依据，实施中如发现不可行需回到本文档改一行注明原因。

| # | 决策点 | 选项 | 推荐 | 理由 |
|---|---|---|---|---|
| D1 | 工具覆盖 | A 首版 6–8 个；B 首版 20；C 首版 45 | **A → B → C 分期** | 先闭环验证口径与 UI，再扩覆盖；解析器 vendor 后扩工具主要是编排表加行 |
| D2 | 移植策略 | A vendor 解析闭包 + 重写编排/聚合；B 重写 8–12 工具；C sidecar 跑 TokenTracker | **A** | 解析层零依赖可搬、口径最稳；B 口径 bug 风险最高、工期更长；C 只适合做 CI 口径对照 oracle |
| D3 | 存储 | A `node:sqlite` 桶表；B JSON 聚合 rollup；C better-sqlite3 | **A（B 作降级预案）** | 零依赖、语义与 queue 一致、任意区间 SQL 聚合、内存可控；封装在 `usage-store` 接口后，若打包后发现 node:sqlite 问题可换 B |
| D4 | 页面落点 | A 设置窗口新路由；B 独立窗口；C home 加卡片 | **A** | 路由/i18n/主题/测试全现成，实现成本最低；默认 846px 单栏、≥1272px 窗口两栏；B 只在需要默认双栏/长期多页时做（+12 文件） |
| D4a | 默认窗口尺寸 | 保持 1120×760 / 调到 1240×800 | **保持**（本期） | 改默认尺寸影响所有路由与 e2e；宽屏体验交给最大化 + 响应式两栏 |
| D5 | 视觉语言 | A 照搬 TokenTracker 绿暗色；B Nightshift 化（保留信息架构） | **B** | Highlighter 已有主题/主色/圆角/紧凑体系；照搬会与设置窗其余页面割裂，且忽略用户主色 |
| D6 | 金额 | A 不做；B 复用 TokenTracker pricing（离线种子）；C 用户自定义单价 | **B（P2 起）** | 截图含美元且「同口径」包含成本公式；pricing 层 1,833 行 + 289KB 种子可直接 vendor；需注明「估算，非账单」并决定历史重算口径 |
| D7 | 成本时点 | A 扫描时冻结；B 查询时按当前价格重算 | **B（与 TokenTracker 一致）** | 同口径优先；页面标「按当前价格表估算」，提供价格表版本号 |
| D8 | 项目维度 | A 不做；B 存脱敏 basename；C 存完整 owner/repo | **A（二期 B）** | 项目路径敏感；二期再做 top-N + 脱敏，默认不落盘完整路径 |
| D9 | 扫描触发 | A 页面打开时增量 + 后台定时；B 启动时同步扫 | **A** | 不阻塞启动（启动已有性能监控与首窗预算）；增量游标使打开时扫描 <1s |
| D10 | hook 安装 | A 只读被动；B 可选安装 hook | **A** | 不写用户 CLI 配置；被动扫描数据完整、仅延迟；hook 增加冲突/卸载/安全评审成本 |
| D11 | 网络来源 | A 不做；B 显式 opt-in | **A** | Cursor/TRAE CN 需联网+凭据，与本地化定位冲突；页面标注不支持 |
| D12 | 统计开关默认 | A 默认开；B 默认关（首次提示开启） | **B（建议）** | 读取用户 AI 会话日志敏感；首次进入页面说明「只读、只存计数、不存正文」并由用户确认 |
| D13 | 历史回填 | A 首扫全量回填；B 仅最近 N 个月 | **A（默认 24 个月，可配）** | 日志天然可回填，是相对「本机 AI 快照」方案的核心优势；保留策略与 TT 对齐 |
| D14 | 3D 热力图 | A 砍；B 保留 | **A** | 3–4 人日、交互成本高、非核心；2D 已足够 |
| D15 | 图表实现 | A 自绘 CSS/SVG；B 引入 UMD 图表库 | **A** | 无构建 + CSP + 首屏 + Nightshift 主题；现有图表全是手绘，工作量可控 |

---

## 6. 目标架构设计

### 6.1 模块图

```
配置窗口（渲染层，vanilla JS）
  config/routes/usage.js ── 只读查询/刷新/进度 ── window.electronAPI.usage*
        │
        ▼ IPC（ipc-security 白名单 + preload）
主进程
  main/ipc/usage-ipc.js（通道形状 + 参数校验）
  main/services/usage-query.js（聚合：区间/来源/模型/热力/日序列）
  main/services/usage-store.js（node:sqlite：唯一写入者/迁移/保留/清除）
  main/services/usage-collector.js（扫描编排：工具注册表/增量/单飞/调度）
        │  utilityProcess.fork
        ▼
  扫描 worker（main/usage-scan-worker.js）
        ├─ 解析：main/vendor/tokentracker/（rollout.js + 19 helpers + pricing 可选）
        ├─ 游标：文件 inode/offset/contribution、各工具专属游标
        └─ 输出：结构化的 (source, model, hour_start, token 列) 桶
        │
        ▼
  <dataRoot>/usage/usage.db（WAL，SQLite）
```

### 6.2 解析层 vendor 策略

- 源：TokenTracker `src/lib/rollout.js` + 其 19 个直接/间接依赖（清单见 `05-parser-portability.md` §2.1），放进 **`main/vendor/tokentracker/`**。
- 必改点（保持上游 diff 可追踪）：
  1. 删 `trae-db/trae-snapshot/trae-sqlite/trae-usage` 相关分支与 `wa-sqlite` 动态 import（首版放弃 Trae）；
  2. 删 `@mongodb-js/zstd` 回退分支，直接用 `zlib.zstdDecompressSync`（Electron Node 24.18）；
  3. `tracker-paths.js` 指向 Highlighter data root，而不是 `~/.tokentracker`；
  4. `enqueueTouchedBuckets()` 的写队列点（`rollout.js:3513,3827` 附近）**参数化为可注入 sink**：默认仍可写 JSONL（便于对拍/排障），Highlighter 注入 SQLite upsert；
  5. 顶部加 `// Vendored from TokenTracker v1.4.7 (MIT) — see docs/third-party/`。
- **保留上游测试**：`test/*parser*.test.js`（28 文件 / 35,948 行 / 791 tests）作为 `main/vendor/tokentracker/test/` 契约测试，新增 `npm run test:usage-parsers` 单独跑（不并入默认门禁，避免拖慢）。
- 许可：`docs/third-party/LICENSE-TokenTracker.txt` + README 署名段（上游版本/commit、修改点）；另需人工复核 `rollout.js` 中 “tokscale” 启发式注释是否需级联署名（开放问题）。

### 6.3 扫描编排（表驱动）

```js
const TOOLS = [
  { source: 'claude',  resolve: resolveClaudeRoots, list: listClaudeProjectFiles,  parse: parseClaudeIncremental,  mode: 'offset' },
  { source: 'codex',   resolve: resolveCodexHome,   list: listRolloutFiles,        parse: parseRolloutIncremental, mode: 'cumulative' },
  { source: 'gemini',  resolve: resolveGeminiHome,  list: listGeminiSessionFiles,   parse: parseGeminiIncremental,  mode: 'snapshot' },
  // …首版 8 个，后续按 05 文档 §3 的表逐个补
]
```

每个工具的职责：

1. **发现**：默认根（`app.getPath('home')` + `%APPDATA%`/`%LOCALAPPDATA%` 规则）+ 环境变量覆盖（`CLAUDE_CONFIG_DIR`/`CODEX_HOME`/`GEMINI_HOME`…，参考 `scan-roots.js` 的 expandHome/dedupe/可读性区分）。
2. **可读性状态**：`ENOENT` = 未安装；`EACCES/EPERM` = 不可读（页面要区分展示，不能当空）。
3. **增量**：文件 `{inode/offset/size/mtime, contribution}`；文件被重写（size < offset 或 inode 变化）→ **先扣减旧 contribution 再整文件重扫**，防止重复计数。
4. **解析**：调 vendored `parse*Incremental({ home, files, cursors, sink })`；坏行/截断/未知事件跳过并计数 `parseErrors`。
5. **提交**：按工具事务提交游标 + 桶（LWW upsert）；单飞锁（同一时刻只允许一个扫描）。
6. **预算/取消**：单批时间预算（如 250 ms）/字节预算/文件数预算，用 `setImmediate` 让出；`AbortController` 取消；进度通过 `usage:scan-progress` 推送。
7. **调度**：页面打开触发增量；扫描完成后 5 分钟节流可再触发；**不在启动关键路径同步扫描**。
8. **线程**：worker 放 `utilityProcess.fork`（已有先例）；SQLite 写入在 worker 内单连接，主进程只读查询（WAL 支持并发读）。

> 游标存储：TT 的 `cursors.json` 本机已达 8.2 MB，**不建议单 JSON 全量重写**。Highlighter 用 SQLite `scan_state(key TEXT PK, value TEXT)` 按 key 存；扫描开始时加载到内存对象、结束后把变更 key 写回（diff 写入）。

### 6.4 存储设计（SQLite）

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 3000;
PRAGMA user_version = 1;

CREATE TABLE IF NOT EXISTS usage_bucket (
  source                 TEXT NOT NULL,
  model                  TEXT NOT NULL,
  hour_start             TEXT NOT NULL,               -- 'YYYY-MM-DDTHH:MM:00Z'
  input_tokens           INTEGER NOT NULL DEFAULT 0,  -- 非缓存输入
  cached_input_tokens    INTEGER NOT NULL DEFAULT 0,  -- cache read
  cache_creation_tokens  INTEGER NOT NULL DEFAULT 0,  -- cache write
  output_tokens          INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens       INTEGER NOT NULL DEFAULT 0,
  total_tokens           INTEGER NOT NULL DEFAULT 0,
  billable_total_tokens  INTEGER NOT NULL DEFAULT 0,
  conversation_count     INTEGER NOT NULL DEFAULT 0,
  usage_precision        TEXT,                        -- NULL | 'estimated'
  updated_at             TEXT NOT NULL,
  PRIMARY KEY (source, model, hour_start)
);
CREATE INDEX IF NOT EXISTS idx_usage_hour        ON usage_bucket(hour_start);
CREATE INDEX IF NOT EXISTS idx_usage_source_hour ON usage_bucket(source, hour_start);

CREATE TABLE IF NOT EXISTS project_bucket (  -- 二期，可选
  project_key TEXT NOT NULL, source TEXT NOT NULL, hour_start TEXT NOT NULL,
  total_tokens INTEGER NOT NULL DEFAULT 0, billable_total_tokens INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0, cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0, conversation_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL, PRIMARY KEY (project_key, source, hour_start)
);

CREATE TABLE IF NOT EXISTS scan_state   (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS source_status(source TEXT PRIMARY KEY, detected INTEGER NOT NULL DEFAULT 0,
                                         last_scan_at TEXT, last_error TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS app_meta     (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

- 成本：若做金额，`model_price` 表 + 价格种子导入（或查询时读 JS 内存表）。**注意 SQLite 单行/DB 大小**——价格种子约 2–3 MB，放 `app_meta` 之外的表或内存均可。
- 保留：默认 24 个月；超 64 MB 从最旧月份清理；提供「清除用量数据」。
- 迁移：`user_version` 逐版本幂等 DDL；切换数据目录前 `wal_checkpoint(TRUNCATE)` + 关闭连接，再整组复制（Highlighter 已有 WAL 复制先例文档）。
- 查询：聚合放 `usage-query.js` 纯函数（输入行数组/DB 连接，输出页面契约），便于 node:test。
- **时区处理**：SQL 只按 UTC 范围预筛，本地日 key 用 `Intl.DateTimeFormat` 在 JS 侧计算（逐桶），避免固定 offset 在 DST 切换日聚合错位；结果按 `(from,to,tz,scope)` 做小 LRU 缓存。

### 6.5 IPC 契约（对齐 TokenTracker 端点形状，便于前端逻辑复用与对拍）

| 通道 | 参数 | 返回（形状对齐 TT） |
|---|---|---|
| `usage:status` | — | `{ scanning, progress, lastScanAt, sources:[{source,label,detected,readable,lastScanAt,error,coverageStartAt}], priceTableVersion }` |
| `usage:refresh` | `{ reason }` | `{ started:true }`；进度走推送 `usage:scan-progress` |
| `usage:summary` | `{ from, to, tz, tzOffsetMinutes, period }` | `{ totals:{billable_total_tokens,total_tokens,input_tokens,output_tokens,cached_input_tokens,cache_creation_input_tokens,reasoning_output_tokens,conversation_count,total_cost_usd}, rolling:{last_7d,last_30d,avg_per_active_day}, periods, from,to }` |
| `usage:daily` | `{ from, to, tz, tzOffsetMinutes }` | `{ rows:[{day,total_tokens,billable_total_tokens,input_tokens,output_tokens,cached_input_tokens,reasoning_output_tokens,conversation_count}] }` |
| `usage:hourly` | `{ day, tz, tzOffsetMinutes }` | 日视图小时序列（24 点） |
| `usage:breakdown` | `{ from, to, tz, tzOffsetMinutes, scope:'source'|'model' }` | `{ sources:[{source,tokens,usd,models,sharePct}], models:[{model,source,tokens,usd,sharePct,pricing}] }` |
| `usage:heatmap` | `{ from, to, tz, tzOffsetMinutes, weekStartsOn }` | `{ weeks:[[cell]], from,to,active_days,total_cost_usd,week_starts_on }`（cell: `{day,value,level,total_tokens}`） |
| `usage:clear` | — | `{ ok:true }` |

- 渲染层不得发 HTTP（CSP）；主进程不发外部网络（除可选价格刷新）。
- 所有通道必须登记 `IPC_SURFACES.main.handles` + `preload.js`；推送 `usage:scan-progress` 登记为 listeners。
- 错误约定：查询失败 reject（页面显示错误态）；扫描失败只更新 `source_status` 并在页面提示，不阻塞页面。

### 6.6 页面设计规格（Highlighter 版）

**信息架构（路由：侧栏「工具设置」组 → 用量）**

```
AI 用量                                      [覆盖状态] [刷新] [日][周][月][总计][自定义]
────────────────────────────────────────────────────────────────────────────
[7 天 tokens] [30 天 tokens] [日均] [对话数]                ← 4 列 KPI（复用 .history-stats）
────────────────────────────────────────────────────────────────────────────
[TOKEN 大字 + 成本 + 区间]         [全部 | Claude | Codex | Gemini | 其他] 来源卡
[来源分段占比条]                  [模型占比条 Top N]
────────────────────────────────────────────────────────────────────────────
[热力图（P2）]                     [每日明细 | 来源明细] 表格
[趋势堆叠柱（近 30 天）]           [日期 | 总计 | 输入 | 输出 | 缓存 | 推理 | 对话数]
[统计覆盖：已检测 6/8 工具 · 上次扫描 …]
```

- **断点**：默认 846px 单栏（KPI 2×2 → 总览 → 来源卡 → 占比 → 趋势 → 明细 → 覆盖状态）；`@media (min-width:1272px)` 切两栏（左 4/12 KPI+热力+趋势，右 8/12 总览+占比+明细），对齐 TokenTracker 栅格意图。
- **数值排版**：大字用 `--font-display` + `--font-mono` 数字、`tabular-nums`；紧凑格式 `1.5B/195.2M`，tooltip 显示全量；中文环境提供 `万/亿` 单位（i18n 驱动）；点击大字可在 compact/full 间切换（可选）。
- **图表自绘**：
  - 来源分段条：单个 flex 容器 + 百分比宽度 div（用 `color-mix(in srgb, var(--primary) X%, var(--surface-3))` 生成同主色系梯度；来源差异用不同透明度/花纹，避免引入第二套品牌色）。
  - 模型占比：每行名称 + 3px 进度条（`--primary-soft`/`--primary`）。
  - 趋势柱：每日一根竖向 flex 列，堆叠输入/缓存/输出（主色系三档）+ 未来/缺失桶 35% 透明；hover tooltip 用绝对定位，边界翻转。
  - 热力图：CSS Grid 7 行 × N 列，单元格 10–12px，5 级 `color-mix`；月份刻度；hover tooltip。
  - 表格：紧凑行高（36–40px）、数字右对齐 mono；`sticky` 表头；`aria-sort`。
- **状态**：加载骨架、空态（未检测到工具 + 说明路径）、错误态（扫描失败 banner + 重试）、覆盖状态（哪些工具可读/不可读/未安装 + Cursor 不支持说明）、估算标记（`estimated` 角标）。
- **覆盖状态必须常驻**：这是「口径诚实」的关键，避免用户把「页面为空」当成功能坏了。
- **主题**：亮/暗双主题，跟随 `body.dark`；不硬编码颜色；紧凑模式使用 `body.compact` 的 16px 页面内边距；主色/圆角跟随设置。
- **i18n**：新增 `shared/locales/config.js` 中 `config.usage.*`（约 70–100 个 key × 3 语言）；日期/数字用 `Intl`（locale 来自 `getLanguage()`）。
- **CSS 预算**：约 200–280 行新样式（KPI 复用、总览、占比条、堆叠柱、热力格、紧凑表、断点），全部消费 token。

### 6.7 数据目录、隐私与清理

- 目录：`<dataRoot>/usage/usage.db`（+ WAL/SHM）；scan 状态在 DB 内；不需要单独 JSON。
- 必须同步修改：
  1. `main/services/data-root.js` 的 `createDataPaths()` 增加 `usage`；
  2. `main/services/data-root-migration.js` 的 `MANAGED_DIRECTORIES` + 迁移复制/校验清单（含 WAL checkpoint 流程）；
  3. `test/data-root.test.js`、`test/data-root-migration.test.js` 的目录断言；
  4. 清理/恢复默认数据目录时纳入边界（参考现有 cleanup 逻辑）。
- 隐私红线：
  - **只读**：不写、不改、不删任何被扫描工具的目录；不安装 hook/插件。
  - **只存计数**：绝不落盘 prompt/回复/工具输出/代码/会话正文/文件路径全文；项目维度二期仅存脱敏 basename。
  - 日志重定向：扫描器日志只记 source/文件数/错误名（英文），不记路径全文；诊断包默认**不包含** usage 数据。
  - 提供「清除用量数据」；首次开启需用户确认（§5 D12）。
  - API key/凭据一律不读取、不存储（Cursor 方案不做的原因之一）。

### 6.8 与 Highlighter 自身 AI 用量的关系

- 本轮**不做**。若未来要做「本应用 AI 消耗」扩展：现有 AI 调用在 `main/services/ai-protocol-adapters.js` 丢弃 usage（流式未请求 `stream_options.include_usage`、非流只取文本），需按 `04-hl-ai-usage.md` 的 6 步最小改造接入 `usage-store`，事件 schema 与 CLI 用量分开（`source='highlighter'`），不要混入本页口径。
- 两者可以共用本地存储与页面框架，但**数据来源与口径必须分别标注**，避免「TokenTracker 口径」被稀释。

---

## 7. 实施路线（分期、交付物与验收）

> 工期为单人估算（含自测），已按「1 人熟悉仓库」假设；不含等待评审/设计确认。实际可并行：数据引擎与页面可两条线并行（接口契约先定）。

### 7.1 总览

| 阶段 | 目标 | 主要内容 | 工期（人日） | 验收 |
|---|---|---|---|---|
| **P0 基线与 POC** | 证明口径可复现 | ① 用 TokenTracker CLI 对固定 fixture/真实日志生成 `queue.jsonl` oracle；② Electron 内跑通 1 个 parser（Claude）；③ `node:sqlite` 建库/写入/聚合冒烟；④ 页面空白路由 + 一行真实数据 | 3–5 | oracle 与 Highlighter 首版聚合的 total/billable/cost 逐日一致（±0）；`node:sqlite` 打包前冒烟通过 |
| **P1 引擎 MVP** | 8 个主流工具 → SQLite → 聚合 IPC | vendor 解析闭包；表驱动编排（8 工具）；增量游标/重写检测/单飞/utilityProcess；`usage_bucket` + `scan_state`；`usage:status/refresh/summary/daily/breakdown`；data-root 登记 | 11–15 | 首扫可回填 24 个月；二次扫描增量 <1s；8 工具数据与 oracle 对拍一致；扫描失败不阻塞应用 |
| **P2 页面 MVP** | 主视图可用 | 新路由 + 侧栏入口；KPI 4 卡；时段 tabs（日/周/月/总计；自定义先不做）；TOKEN 大字 + 来源占比卡 + 模型列表；每日明细表；趋势柱（近 30 天）；覆盖状态/空态/错误态；i18n/主题/紧凑适配 | 7–10 | 默认窗口单栏可读、宽屏两栏；亮暗主题/主色/圆角全部生效；i18n 门禁通过；e2e 路由渲染通过 |
| **P3 完整与扩展** | 对齐截图完整体验 | 2D 热力图；日视图小时序列；自定义区间；数字格式切换；更多工具（累计 20）；性能优化（首扫分工具预算/进度） | 6–9 | 与 TokenTracker 截图区块 90% 对应（除 3D/性价比/项目）；冷扫描进度可见；查询 P95 <100ms |
| **P4 全量与收尾** | 45 工具 + 成本 + 可发布 | 补齐 45 解析器编排；pricing vendor（若做金额）；项目用量（可选）；全量测试/fixture；许可署名；文档；打包与数据目录迁移验收 | 9–15 | 45 工具覆盖状态正确；金额与 oracle 一致或标 unpriced；`npm test`/`check`/覆盖率全绿；MIT 声明齐全 |

**合计：约 36–54 人日（基准）→ 含 20% 缓冲约 43–65 人日，单人 9–13 周**；MVP（P0+P1+P2，8 工具 + 主视图）约 **21–30 人日（4–6 周）**；最小演示（P0 + 3 工具 + 最简页面）约 **12–16 人日（≈3 周）**。

### 7.2 关键路径与依赖

```
P0 口径基线 ──► P1 引擎（解析/编排/存储） ──► P4 全量覆盖
      │                    │
      └──► 页面契约（IPC 形状） ──► P2 页面 MVP ──► P3 完整图表
```

- 先定 **IPC 契约**（按 §6.5），页面与引擎可并行；页面先用 fixture/mock 数据开发，引擎完成后切换真实 IPC。
- 解析器 vendor 与编排是风险最高的一段，P1 内先做 Claude（JSONL）+ Codex（累计快照+zstd）两个不同范式，验证「文件 offset」与「累计 diff」两条主路径，再扩展到其余工具。

### 7.3 里程碑 Demo（可给用户看的东西）

| 里程碑 | Demo |
|---|---|
| M0（P0 结束） | 命令行脚本输出「Highlighter 聚合 vs TokenTracker 聚合」逐日对照表 |
| M1（P1 结束） | 打开空白页面显示真实 KPI 与明细（无设计） |
| M2（P2 结束） | 完整主视图：KPI + 总览 + 来源/模型 + 趋势 + 明细，亮暗主题 |
| M3（P3 结束） | 热力图 + 日/周/月/自定义 + 覆盖状态 + 多工具 |
| M4（P4 结束） | 45 工具 + 金额 + 全门禁 + 安装包验收 |

---

## 8. 验证与测试策略

### 8.1 口径对拍（最高优先级）

- 用 TokenTracker CLI（npm 包，不 vendor）在开发机对**同一批真实日志**运行，产出 `queue.jsonl` 作为 oracle；Highlighter 的扫描/聚合结果与之逐日对比：
  - 必对项：`total_tokens`、`billable_total_tokens`、`total_cost_usd`、各来源/模型明细；
  - 容差：0（token 整数）；金额浮点允许 ±0.01。
- 固定 fixture 对拍：把上游 `test/fixtures/` 中 6–8 个工具的样本复制为 Highlighter 测试 fixture，CI 跑聚合单测。
- 变更防护：把「oracle 对拍脚本」纳入 `scripts/`（开发/CI 可选，不要求用户安装 TokenTracker）。

### 8.2 解析与增量测试

- 每个工具一个 fixture：正常行、坏行、截断尾行、超大行、被重写文件、空文件、权限错误目录。
- 增量正确性：同一 fixture 扫两次，第二次 0 桶；文件追加后只新增差量；文件重写后不重复计数（贡献扣减）。
- 时区/DST：固定 IANA 时区（`Asia/Shanghai`、`America/New_York`）跨 DST 边界验证「本地日」边界。
- 并发：单飞锁；扫描中打开页面查询不阻塞；取消后状态一致。
- 性能：首扫（真实日志样本）≤ 预算、增量 <1s、查询 P95 <100ms；大文件不占满内存。

### 8.3 页面与集成测试

- `node --test`：`usage-store`（upsert/LWW/迁移/retention/清除）、`usage-query`（各聚合函数）、`usage-ipc`（形状/错误）、`usage-collector`（状态机/单飞/重写检测）。
- 路由契约：`test/config-routes.test.js`、`test/config-icon-contract.test.js`、`test/i18n-contract.test.js`、`test/design-tokens.test.js` 更新。
- e2e：真实 Electron 打开设置窗口 → 点击「用量」→ 断言 KPI/表格渲染（用 fixture home 注入，绝不扫真实 `%USERPROFILE%`）。
- 门禁：`npm test`、`npm run check`、覆盖率 85%、打包后 `node:sqlite` 冒烟、数据目录切换迁移演练。

### 8.4 验收口径清单（发布前逐条打勾）

1. 与 TokenTracker 同批日志的 7 天/30 天/月/总计数值一致（token 完全一致，金额 ±0.01）。
2. 缓存读/写、推理、输入/输出四列拆分正确；reasoning 不重复计费。
3. 时区切换（系统时区变化）后本地日边界正确；周起点为周一。
4. 覆盖状态准确区分「已安装可读 / 已安装不可读 / 未安装 / 不支持（Cursor 等）」。
5. 不写任何被扫描工具目录；无 prompt/正文/路径全文落盘；清除功能生效。
6. 亮/暗主题、用户主色、圆角、紧凑模式全部生效；CSP 无内联脚本；i18n 三语齐全。
7. 首次扫描不阻塞启动；扫描中可继续操作；应用崩溃后恢复不重复计数。
8. 数据目录切换不丢历史（迁移清单 + 校验通过）。
9. 打包安装版可用（node:sqlite / zstd / utilityProcess 路径）。
10. MIT 署名与第三方声明齐全。

---

## 9. 风险登记表

| # | 风险 | 概率/影响 | 缓解 |
|---|---|---|---|
| R1 | **外部日志契约漂移**：各 CLI 日志格式/路径随版本变化；一次升级可能让某工具归零 | 高/高 | 解析器容错（坏行跳过/版本探测/`parseErrors` 计数）；覆盖状态展示；fixture 回归；上游测试作为契约；按季度 diff 上游 |
| R2 | **扫描阻塞主进程/启动** | 中/高 | 扫描放 `utilityProcess`；页面打开时增量；分批预算/可取消/进度；不在启动路径同步扫描 |
| R3 | **node:sqlite 实验性 API 风险**（未来 Electron/Node 升级行为变化） | 中/中 | 封装 `usage-store` 接口，可切 JSON rollup；锁 Electron 版本；启动冒烟测试；打包验收 |
| R4 | **data-root 迁移漏登记** → 切数据目录丢历史 | 中/高 | 两处注册 + 迁移复制/校验 + 三套测试；发布前实测切换目录 |
| R5 | **既有门禁余量不足**：main.js 只剩 6 行、i18n 只剩 21 行、IPC 三处登记 | 高/中 | 新逻辑全部进 `main/services`/`usage-ipc`；main.js 只加 ≤6 行或复用现有装配点；新增代码零中文；通道一次性登记完整 |
| R6 | **解析层 vendor 的长期维护**（30k 行上游持续演进） | 中/高 | 固定上游 tag/commit；只 vendor 解析闭包；文件头标注来源；保留修改点清单；把上游测试纳入契约测试 |
| R7 | **Trae 例外**（SQLCipher + wa-sqlite） | 中/低 | 首版放弃；二期评估「解密到临时明文库 + node:sqlite」并做隐私评审 |
| R8 | **Cursor 缺口造成预期落差** | 高/中 | 页面覆盖状态明确「不支持本地统计」；文档/发布说明标注；后续可评估账号 API（需产品决策） |
| R9 | **隐私与合规**：读取用户 AI 会话日志敏感性 | 中/高 | 只读、只存计数、不落正文、不写工具配置、首次确认、提供清除、诊断包排除、隐私说明 |
| R10 | **口径漂移**（成本重算、去重差异、估算标记） | 中/高 | oracle 对拍；口径表写进文档；估算标 `estimated`；成本标注「估算，非账单」；价格表版本号展示 |
| R11 | **设计冲突**：照搬 TokenTracker 视觉会割裂设置窗 | 中/中 | Nightshift 化；保留信息架构/密度；用主色系数据可视化；亮暗双主题评审 |
| R12 | **页面宽度不足**导致双栏拥挤 | 中/中 | 默认单栏；≥1272px 两栏；必要时独立窗口（方案 B）作为后续升级 |
| R13 | **Windows 长路径 / OneDrive 重定向 / 杀软锁文件 / WSL UNC** | 中/低 | 单文件失败重试后跳过；长路径监测；WSL 一期关闭、二期可选；错误只影响该来源 |
| R14 | **截图版本差异**（本地 checkout 与截图不完全一致） | 高/低 | 以本地 checkout + 截图布局意图为准；逐像素验收需提供截图版本 |

---

## 10. 需要用户确认的问题（实施前）

1. **工具范围**：首版要哪几个？（建议：Claude Code、Codex、Gemini CLI、OpenCode、DeepSeek Harness、Kimi Code、Qoder、Copilot；Copilot/Cursor 需确认是否接受「部分支持/不支持」）
2. **是否做金额（美元）**：做则需接受「按内置价格表估算、非真实账单」，并决定价格表更新方式（内置快照 vs 可选联网刷新）。
3. **页面落点**：设置窗口新路由（推荐，默认 846px 单栏）是否可接受？还是要独立窗口/默认加宽主窗口以获得截图式双栏？
4. **统计开关默认值**：默认开启（发现即用）还是默认关闭（首次进入时说明并确认）？
5. **历史回填**：默认回填 24 个月是否合适？是否需要「只统计最近 N 个月」设置？
6. **是否允许写 hook**：首版建议只读；若需要实时性（SessionEnd 立即可见）需另行产品决策与安全评审。
7. **项目用量/会话维度**：是否纳入首版（涉及项目路径脱敏、隐私策略）？
8. **WSL 支持**：首版关闭、二期可选，是否可接受？
9. **截图基线**：能否提供截图对应的 TokenTracker 版本/commit（本地 checkout v1.4.7 与截图有 3 处对不上）？
10. **许可署名**：接受在 About/第三方声明中加入 TokenTracker（MIT）署名与上游版本号吗？

---

## 11. 参考证据索引

| 主题 | 参考 |
|---|---|
| TokenTracker 本地数据流/token 归一/queue 契约 | `TokenTracker/CLAUDE.md:5-14,54-80,196-203` |
| 46 解析器单点 | `TokenTracker/src/lib/rollout.js`（25,966 行，46 个 `parse*Incremental`） |
| 扫描编排入口 | `TokenTracker/src/commands/sync.js:532`（`cmdSync`） |
| 本地聚合端点 | `TokenTracker/src/lib/local-api.js:2403-2873`（summary/daily/heatmap/model-breakdown/project） |
| 定价与成本公式 | `TokenTracker/src/lib/pricing/index.js:227-353` |
| 前端组件树 | `TokenTracker/dashboard/src/ui/dashboard/views/DashboardView.jsx:204-306,308-385`、`pages/DashboardPage.jsx` |
| Highlighter 主窗口/路由/CSP | `Highlighter/main.js:787-830`、`config/config.html:5`、`config/config.js:37-91` |
| Highlighter 门禁 | `Highlighter/scripts/check-architecture.js:25`、`scripts/check-i18n.js`、`package.json:14-17` |
| Highlighter data-root/迁移 | `Highlighter/main/services/data-root.js:13-34,49-79`、`main/services/data-root-migration.js:25-30,405-462` |
| 运行时能力实测 | `ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe -e "…"`（Node 24.18.0 / node:sqlite / zstd） |
| 完整底稿 | `.tmp/usage-migration/01-…05-*.md`（4 份分析原文） |

---

## 附录 A：文件级改动清单（实施时按此核对）

### A.1 页面（渲染层）

| 文件 | 动作 |
|---|---|
| `config/routes/usage.js` | 新建：`renderUsage()`（异步、`currentRoute`+版本号守卫）、子视图、事件绑定、注册 `window.configRoutes['renderUsage']` |
| `config/config.html` | 侧栏「工具设置」组加 `data-route="usage"`；`<script src="routes/usage.js">`（`config.js` 之前） |
| `config/config.js` | `routes` 加 `usage:{key:'renderUsage'}`；`routeTitles` 加 `usage:'config.route.usage'`；离开路由时清定时器/observer |
| `config/config.css` | `.usage-*`（KPI/总览/占比条/堆叠柱/热力格/紧凑表/两栏断点），约 200–280 行，只消费 token |
| `config/icons/usage.svg` | 新导航图标（或复用 `icons/layout.svg`，但图标契约测试要同步） |
| `shared/locales/config.js` | `config.route.usage` + `config.usage.*`（三语，约 70–100 key） |
| `test/config-icon-contract.test.js` | 导航图标计数 12 → 13 |
| `test/config-routes.test.js` | 路由契约自动覆盖；如新增 `window.configShared` helper 需同步清单 |
| `e2e/highlighter.spec.js` | 路由渲染清单加 `usage` |
| `test/design-tokens.test.js` | 如新增 chart token，补断言 |

### A.2 主进程（数据）

| 文件 | 动作 |
|---|---|
| `main/vendor/tokentracker/*` | 新建：vendor 解析闭包（20 文件）+ 许可头；删 Trae/`@mongodb-js/zstd` fallback；sink 参数化 |
| `main/usage-scan-worker.js` | 新建：utilityProcess 入口（扫描/解析/游标/进度） |
| `main/services/usage-collector.js` | 新建：工具注册表、根发现、调度、单飞、状态机、进度 |
| `main/services/usage-store.js` | 新建：SQLite 打开/迁移/upsert/LWW/保留/清除/只读查询 |
| `main/services/usage-query.js` | 新建：summary/daily/hourly/breakdown/heatmap 聚合纯函数 + 时区换算 + LRU |
| `main/ipc/usage-ipc.js` | 新建：`usage:*` 通道注册 + 参数校验 |
| `main/services/ipc-security.js` | `IPC_SURFACES.main.handles` 加 `usage:*`；listeners 加 `usage:scan-progress` |
| `preload.js` | 暴露 `usageStatus/usageRefresh/usageSummary/usageDaily/usageHourly/usageBreakdown/usageHeatmap/usageClear/onUsageScanProgress` |
| `main.js` | 装配 ≤6 行（require + 构造 + 注册），如需更多则复用现有装配点或按流程申请抬上限 |
| `main/services/data-root.js` | `createDataPaths()` 加 `usage` |
| `main/services/data-root-migration.js` | `MANAGED_DIRECTORIES` + 迁移复制/校验（WAL checkpoint）+ 清理清单 |
| `main/services/settings-defaults.js` | （若做开关）`usage.enabled`/`usage.retentionMonths` 进 DEFAULT_SETTINGS 模板 + normalize |
| `docs/third-party/LICENSE-TokenTracker.txt` + `README.md` | 新增 MIT 全文与署名段 |

### A.3 测试

`test/usage-collector.test.js`、`test/usage-store.test.js`、`test/usage-query.test.js`、`test/usage-ipc.test.js`、`test/usage-parsers/*.fixture`、`test/usage-parsers.test.js`、`test/data-root.test.js`（更新）、`test/data-root-migration.test.js`（更新）、`test/config-icon-contract.test.js`（更新）、`e2e/highlighter.spec.js`（更新）；可选 `scripts/usage-oracle-check.js`（开发期对拍）。

---

## 附录 B：截图区块最终取舍一览

| 截图区块 | 取舍 | 阶段 |
|---|---|---|
| 4 KPI（7 天/30 天/平均/对话） | 保留 | P2 |
| 模型占比列表 | 保留（主色系条） | P2 |
| 开始使用/活跃天数 | 改为「统计覆盖起点/活跃天数」 | P2 |
| 2D 热力图 | 保留 | P3 |
| 3D 热力图 | 砍 | — |
| 使用趋势堆叠柱 + 预测值 | 保留简化版（预测可选） | P2/P3 |
| 日/周/月/总计 | 保留 | P2 |
| 自定义区间 | 保留（原生 date input，先做） | P3 |
| TOKEN 大字 | 保留 | P2 |
| 美元 | 做（pricing vendor，标注估算） | P4 |
| 蓝色分布条 | 改为主色系来源分段条 | P2 |
| 来源占比卡 | 保留（全部 + 各 CLI + 模型数） | P2 |
| 每日明细表 | 保留（核心） | P2 |
| 项目用量 tab | 二期可选 | P4+ |
| 数量为「N 个模型」的展开明细 | 保留（P3 可展开） | P3 |
| 性价比卡/分享/云/设备/订阅/安装卡 | 砍 | — |
| 页面空白时 | 空态 + 覆盖状态说明 | P2 |

---

## 附录 C：分期验收清单（发布门禁）

- [ ] P0：oracle 对拍通过（token 逐日 0 误差；金额 ±0.01）
- [ ] P1：8 工具扫描/增量/重写/坏行/权限/取消/进度全部有测试；`usage.db` 可重建
- [ ] P1：`node:sqlite` 在打包安装版冒烟通过
- [ ] P2：新路由渲染、侧栏入口、i18n 三语、亮暗主题/主色/圆角/紧凑、CSP 无内联脚本
- [ ] P2：空态/错误态/覆盖状态/估算标记/加载骨架齐全
- [ ] P3：热力图/日视图/自定义区间/数字格式切换；查询 P95 <100ms
- [ ] P4：45 工具覆盖状态正确；金额与 oracle 一致或标 unpriced；`npm test` + `npm run check` + 覆盖率全绿
- [ ] P4：数据目录切换演练不丢历史；清除数据生效；诊断包不含用量数据
- [ ] P4：MIT 署名 + 第三方声明 + 上游版本记录
- [ ] 全程：不写任何被扫描工具目录；不读凭据；不联网（除可选价格刷新）；不记录正文/路径全文

---

## 附录 D：分期与工作量明细（供排期）

| 工作项 | 人日 | 阶段 |
|---|---|---|
| oracle 对拍脚本 + POC（1 parser + SQLite 冒烟） | 3–5 | P0 |
| vendor 解析闭包（20 文件）+ 清理 Trae/zstd + 命名空间 + 许可头 | 2–3 | P1 |
| 编排器（8 工具：发现/游标/重写/单飞/utilityProcess/进度） | 4–6 | P1 |
| SQLite store + 迁移/保留/清除/DDL | 2–3 | P1 |
| 聚合查询（summary/daily/breakdown）+ 时区 | 2–3 | P1 |
| IPC + preload + 安全白名单 + data-root 登记 + 设置开关 | 1–2 | P1 |
| 路由/布局/侧栏/i18n/主题/紧凑/CSS 基础 | 2–3 | P2 |
| KPI + 大字总览 + 来源/模型占比 + 明细表 | 3–4 | P2 |
| 趋势堆叠柱 + tooltip + 状态/空态/错误态 | 2–3 | P2 |
| 热力图 + 日视图小时序列 + 自定义区间 + 数字格式化 | 3–4 | P3 |
| 扩展工具 8 → 20（编排表 + fixture + 测试） | 3–4 | P3 |
| 扩展工具 20 → 45（编排表 + 逐工具验证） | 4–5 | P4 |
| pricing vendor + 金额列 + unpriced 标注（若做） | 3–4 | P4 |
| 测试（单元/契约/e2e/性能/打包）与文档 | 2–3 | 全程 |
| **合计（基准）** | **约 36–54 人日**；含 20% 缓冲约 43–65 人日 | — |

> 注：上表为「完整版（45 工具 + 金额）」口径；MVP（P0–P2，8 工具 + 主视图）约 **21–30 人日（4–6 周）**；最小演示（3 工具 + 最简页面）约 **12–16 人日（≈3 周）**。工期按 1 名熟悉本仓库的开发者估算，数据引擎与页面可并行以缩短日历时间。

---

## 附录 E：若选择「快速验证」的替代路线（仅作过渡，不建议作为最终形态）

若希望 **2–3 周内**看到完整 46 工具的真实数据，可先用 **sidecar 方案**做一次验证：

- 把 TokenTracker CLI 作为独立进程运行（`ELECTRON_RUN_AS_NODE` 或打包的 Node 运行时），只监听 `127.0.0.1` 随机端口；
- 用 `TOKENTRACKER_NO_TELEMETRY=1`、不登录、`--no-sync`/`--no-open` 禁止云端与浏览器行为；
- Highlighter 主进程做 HTTP 代理 → IPC → 页面；数据目录与 TokenTracker 隔离（`~/.tokentracker` 或独立目录需验证）；
- 风险：5 个 npm 依赖（zstd/WASM 等）、进程生命周期、端口占用、双写/双数据目录、未来与上游版本绑定、隐私边界扩大。
- 结论：**只建议作为 P0 的「口径 oracle」与最快 demo**；产品化仍走路线 A（vendor 解析闭包 + 重写编排），避免长期 fork 负担。

---

**一句话总结**：把 TokenTracker 的「用量」页迁到 Highlighter，技术上完全可行；真正的分界线是——**解析层（30k 行、零依赖、MIT）可以整搬，编排与聚合（约 12k 行、与云/账号耦合）必须重写，页面与视觉必须按 Nightshift 重画**。建议按「P0 口径对拍 → P1 8 工具引擎 → P2 主视图 → P3 完整图表 → P4 45 工具+金额」推进：最小演示 ≈3 周、MVP 4–6 周、完整版 9–13 周（单人，含缓冲）。
