# TokenTracker「用量」页前端拆解（迁移到 Highlighter 的事实依据）

> 分析对象：`F:/workspace/TokenTracker`（只读），checkout = `v1.4.7-1-g148b758e`，dashboard 包 `@tokentracker/dashboard`。
> 目标：为「把 TT 用量页搬到 Highlighter（Electron、vanilla JS + CSS 变量、无构建）」提供前端侧事实。
> 证据格式为 `文件:行号`，路径相对 TokenTracker 仓库根；行号以本 checkout 为准。无法从代码确认的条目显式标注「未验证」。

---

## 0. 结论摘要（先看这一段）

1. **页面是"一个巨型数据编排容器 + 纯展示卡片"**：`DashboardPage.jsx` 1500 行里塞了 10 个数据 hook、period/时区/排序/分页/设备过滤/刷新编排；`DashboardView.jsx` 只做两栏栅格 + 可拖拽卡片壳 + 门禁/骨架屏。迁移时**必须拆开**：数据逻辑与展示逻辑目前是 React 状态强耦合的（`dashboard/src/pages/DashboardPage.jsx:476-646`）。
2. **没有任何图表库**：热力图（2D/3D）、堆叠柱状图、占比条全部是 DOM/CSS/SVG 手绘，没有 recharts/d3/echarts（`dashboard/package.json:20-45` 无图表依赖；3D 是自写等轴投影 SVG：`dashboard/src/ui/dashboard/components/ActivityHeatmap3D.jsx:41-58,375-462`）。这对 vanilla 迁移是**利好**，但 3D 热力图的交互状态机是最贵的一块。
3. **真正的 React 依赖只有 4 类**：`motion`（动画 + 数字滚动 Counter）、`@dnd-kit`（卡片拖拽排序）、`@base-ui/react`（自定义日期 Popover）、`react-day-picker + date-fns`（日期区间日历）。图表本身零第三方。
4. **数据契约是"服务端聚合、前端轻量再计算"**：前端只做 fleet/all-models 合并、热力图 level 分位、趋势预测插值、排序分页。Electron 版把 fetch 换 IPC 即可复用组件形状，但端点与字段语义要照抄（见 §3）。
5. **设计系统与 Highlighter 正面冲突**：TT 是"绿色品牌 + 绿灰中性 + 白/近黑底 + 1px 边框卡片 + 16px 圆角 + Tailwind 类名"；Nightshift 是"暖炭/沙色 + 单一用户可配置强调色 + elevation 分层、少边框 + 用户可调圆角 + 语义 token"。**不能直接搬 class/token**，必须做映射层（见 §6）。
6. **有大量"上游数据语义"特例**（Devin/Kiro/Trae/Antigravity 定价提示、cache hit rate、unpriced 标注、Context Breakdown）：这些是 TT 解析 46 种 CLI 的产物，Highlighter 只记录自身 AI 调用时**建议整体删除**。
7. 截图中「模型占比条形列表」「蓝色进度条」「UTC 时区切换」在当前 checkout **无法 1:1 对位**（详见 §2.3），需拿目标截图/版本再确认，不要把本文件的组件当成唯一验收标准。

---

## 1. 路由与页面外壳

| 事项 | 事实 | 证据 |
|---|---|---|
| 入口 | `main.jsx` 挂 5 个 Provider（Locale → TokenFormat → Currency → InsforgeAuth → AccountView），再挂 Router | `dashboard/src/main.jsx:32-45` |
| 路由 | `createBrowserRouter([{ path:"*", element:<App/> }])`，`/dashboard` 与 `/` 都映射 `DashboardPage` | `dashboard/src/main.jsx:24-31`、`dashboard/src/App.jsx:262` |
| 侧栏 | `Sidebar` 的 `general` 组第一项 `usage → /dashboard`（图标 BarChart3） | `dashboard/src/ui/components/Sidebar.jsx:39-46` |
| 全局命令面板 | `Cmd/Ctrl+K` 打开，索引页面 + 已安装 skills；仅 `showSidebar` 时挂载 | `dashboard/src/ui/dashboard/components/CommandPalette.jsx:18-40`、`dashboard/src/App.jsx:415` |
| 页面壳 | `Shell bare` 模式（`bare={!screenshotMode}`）：`<main class="flex-1 px-6 py-6">` | `dashboard/src/ui/dashboard/views/DashboardView.jsx:448-454`、`dashboard/src/ui/components/Shell.jsx:40-56` |
| 栅格 | 12 栏：左 4 / 右 8；**移动端顺序反转**：右栏 `order-1`、左栏 `order-2`（先看总览再看细节） | `dashboard/src/ui/dashboard/views/DashboardView.jsx:490-497` |
| 卡片排序 | 左右列各自 DnD 排序，顺序持久化在 `tokentracker.dashboard.{left,right}CardOrder.v1`；默认左列 7 项、右列 2 项 | `dashboard/src/pages/DashboardPage.jsx:70-79`、`dashboard/src/ui/dashboard/views/DashboardView.jsx:387-431`、`dashboard/src/hooks/use-dashboard-card-order.js:4-26` |

---

## 2. 组件树与截图区块映射

### 2.1 实际组件树（本 checkout 真实挂载）

```
main.jsx (Locale/TokenFormat/Currency/InsforgeAuth/AccountView providers)
└─ App.jsx (Sidebar + 可选 CommandPalette + 路由)
   └─ DashboardPage.jsx  ← 全部数据 hook、period/日期/排序/分页/刷新编排
      └─ DashboardView.jsx ← 门禁(auth/expired) / Skeleton / 2 栏 Sortable 列
         ├─ 左列 (lg:col-span-4, mobile order-2)
         │  ├─ StatsPanel            ← 4 KPI + Top3 模型 + 订阅徽章 + 开始使用/活跃天数
         │  ├─ installCopy 内联卡    ← 可选（未安装/无 active device token 时）
         │  ├─ ActivityHeatmap       ← 2D grid / 3D 内嵌；含 3D 全屏 Modal
         │  ├─ DeviceUsageCard       ← 仅 cloud accountView 且 ≥2 设备/来源
         │  ├─ TrendMonitor          ← 堆叠柱状图 + hover tooltip + 放大 Modal
         │  ├─ QualityPerDollarCard  ← Labs opt-in（默认关）
         │  └─ SessionInsightsCard   ← 仅 local 模式 + Labs opt-in
         └─ 右列 (lg:col-span-8, mobile order-1)
            ├─ UsageOverview         ← 日/周/月/总计/自定义 + 大字总数 + 成本 + provider 占比/明细
            └─ DataDetails           ← 每日明细 / 项目用量 tab + ProjectDetailModal
      ＋ CostAnalysisModal（DashboardView 渲染，成本信息按钮打开）
      ＋ ShareModal（DashboardPage 渲染，右上 Share 按钮打开）
```

证据：`dashboard/src/ui/dashboard/views/DashboardView.jsx:204-306`（左列 id→组件）、`:308-385`（右列）、`DashboardView.jsx:502`（CostAnalysisModal）、`dashboard/src/pages/DashboardPage.jsx:1492-1497`（ShareModal）。

### 2.2 截图区块 → 组件/文件映射

| 截图区块 | 对应组件 | 关键渲染位置 | 数据来源 |
|---|---|---|---|
| 左上 4 个 KPI 卡（7 天 / 30 天 / 平均 / 对话） | `StatsPanel` | `StatsPanel.jsx:80-114` | `rolling.last_7d/30d.totals.billable_total_tokens`、`rolling.last_30d.avg_per_active_day`、`summary.conversation_count`（`StatsPanel.jsx:83-113`、`DashboardPage.jsx:1260-1263`） |
| 模型占比（列表/条形） | `StatsPanel` Top3 行 | `StatsPanel.jsx:117-143` | `topModels`（`buildTopModels`，`model-breakdown.ts:355-414`；传入点 `DashboardPage.jsx:1269-1272`） |
| 开始使用 / 活跃天数 | `StatsPanel` footer | `StatsPanel.jsx:161-170` | `identityStartDate`（`DashboardPage.jsx:1070-1098`）、`activeDays`（`:819-850`） |
| 热力图（2D/3D、少→多图例） | `ActivityHeatmap`(+`ActivityHeatmap3D`) | `ActivityHeatmap.jsx:505-590`、`:486-501`、`:593-864` | `heatmap`（`useActivityHeatmap`） |
| 使用趋势堆叠柱状图 + 预测值图例 | `TrendMonitor` | `TrendMonitor.jsx:661-740`；预测图例 `:722-733` | `trendRowsForDisplay`（`DashboardPage.jsx:750-758`） |
| 研发性价比与交付成本（测试版） | `QualityPerDollarCard` | `QualityPerDollarCard.jsx:50-116` | `useQualityPerDollar` → `/functions/tokentracker-outcomes`（opt-in） |
| 日/周/月/总计/自定义切换 | `UsageOverview` tablist | `UsageOverview.jsx:377-471` | `periodsForDisplay`（`DashboardPage.jsx:1209`）；`period` 状态 |
| TOKEN 总数大字 + 美元估算 | `UsageOverview` 主统计区 | `UsageOverview.jsx:474-527` | `summaryValue`/`summaryFullValue`/`summaryCostValue`（`DashboardPage.jsx:1146-1156,1255-1263`）；`Counter` 数字滚动 `:315-332` |
| "蓝色进度条"（图中彩色条） | `UsageOverview` provider 分布条 | `UsageOverview.jsx:536-566` | `fleetData[].totalPercentValue` |
| provider 占比卡（全部/DeepSeek H./CODEX/ZCODE + x 个模型） | `UsageOverview` provider 卡网格 | `UsageOverview.jsx:570-642` | `fleetData`（`model-breakdown.ts:171-270`） |
| 每日明细 tab（日期/总计/输入/输出/缓存/推理/对话数） | `DataDetails` daily 表 | `DataDetails.jsx:211-285` | `dailyBreakdownRows`（独立 `useUsageData`，不含 summary；`DashboardPage.jsx:737-739`） |
| 项目用量 tab | `DataDetails` projects 列表 + 详情 Modal | `DataDetails.jsx:172-201`、`ProjectDetailModal.jsx:449` | `useProjectUsageSummary` → `/functions/tokentracker-project-usage-summary` |

### 2.3 截图元素在当前 checkout 的疑点（务必标注）

- **「模型占比条形列表」**：当前代码里 `StatsPanel` 的 Top3 行只有"排名圆点 + 名称 + 百分数"，**没有条形几何**（`StatsPanel.jsx:126-140`）。唯一的"模型行 + 细条"在右栏 `UsageOverview` 的展开明细（`UsageOverview.jsx:794-852`，3px 进度条）。截图若确把"条形列表"放在左上 KPI 与"开始使用"之间，说明截图来自**不同版本**，本 checkout 无法逐像素对位 → **未验证**。
- **「蓝色进度条」**：TT 品牌色是绿色 `#059669`，代码中没有蓝色主进度条（`tailwind.config.cjs:143-159`）。最可能是 provider 分布条（分段色里 CODEX `#3b82f6`、DeepSeek Harness `#4d6bfe` 呈蓝，`UsageOverview.jsx:74-96`）。**未验证**。
- **「UTC 时区切换」**：热力图只有**静态时区短标签**（`timeZoneShortLabel || "UTC"`，`ActivityHeatmap.jsx:481`），没有切换控件；时区来自浏览器 IANA + 偏移并下发给后端（`DashboardPage.jsx:345-346,443-457`）。若截图确有"UTC/local 切换"，属于新版未合入能力 → **未验证**。

### 2.4 同页存在但截图未出现的元素

`installCopy` 安装命令卡（`DashboardView.jsx:244-268`）、`DeviceUsageCard`（cloud 多设备，`DashboardPage.jsx:428-441`）、`QualityPerDollarCard`/`SessionInsightsCard`（Labs 默认关，`use-quality-per-dollar-pref.js:9-12`、`use-session-efficiency-pref.js:3`）、`TrendMonitorZoomModal` 放大镜（`TrendMonitor.jsx:637-647,889-901`）、Share 按钮/Modal（`UsageOverview.jsx:456-466`）、刷新按钮（`:143-172`）、设备筛选 Select（`:446-455`）、`CostAnalysisModal`（成本数字旁 ⓘ，`:498-511`）、`ProjectDetailModal`、provider 展开明细（模型 token 拆分、cache hit rate、Context Breakdown、Devin/Kiro/Trae/Antigravity 警示，`UsageOverview.jsx:893-978`）、订阅徽章（`StatsPanel.jsx:146-158`）、auth/expired 全屏门禁、`DashboardSkeleton` 初始骨架、`CommandPalette`。

---

## 3. 数据契约

### 3.1 传输通道（重要：不是 Electron IPC）

TT dashboard 是**独立 Web 前端**，数据来自本机 CLI 起的 HTTP 服务：

- 本机：`GET http://<localhost>/functions/tokentracker-usage-*`，相对路径拼 `window.location.origin`（`dashboard/src/lib/api.ts:182-241`）。
- 非 localhost 且有 token：同 slug 映射到云端 `tokentracker-account-*`（`api.ts:166-177,191-214`）；无 localhost 则直接抛 `LOCAL_API_UNAVAILABLE`（`:216-222`）。
- 端点表：`api.ts:141-158`；请求封装 `fetchLocalJson` 支持 `coalesceJsonGet` 合并并发请求 + `cache: "no-store"`（`:182-241`）。

迁移含义：**Highlighter 版必须自建等价端点或改 IPC**；前端组件只认 props，所以形状可保留，成本在数据层（见 task-2）。

### 3.2 页面级 hook 与返回字段

| Hook | 使用的端点 | 返回字段（前端消费的） | 证据 |
|---|---|---|---|
| `useUsageData` | `tokentracker-usage-daily` + `-summary?rolling=1` | `daily[]`、`summary`（totals）、`rolling`、`source`(edge/cache/mock)、`loading`、`error`、`refresh` | `dashboard/src/hooks/use-usage-data.ts:20-50,144-159,217-269,440-449` |
| `useUsageData`（第二实例） | `-daily`（仅 daily，`includeSummary:false`） | `daily`（每日明细卡，固定近 30 天/总计区间） | `DashboardPage.jsx:501-527`、`daily-breakdown.ts:25-53` |
| `useTrendData` | `-hourly` / `-daily` / `-monthly` | `rows`、`from/to`、`loading`、`refresh`；mode 由 period 推导：day→hourly、total→monthly、其余 daily | `dashboard/src/hooks/use-trend-data.ts:68-72,174-278` |
| `useActivityHeatmap` | `-heatmap`（失败/无 level 时回退 `-daily` 前端构建） | `heatmap`（weeks/from/to/active_days/total_cost_usd/week_starts_on）、`daily` | `dashboard/src/hooks/use-activity-heatmap.ts:140-285`、`activity-heatmap.ts:80-171` |
| `useUsageModelBreakdown` | `-model-breakdown` | `breakdown`（sources/models/totals/pricing.status/cost_source） | `dashboard/src/hooks/use-usage-model-breakdown.ts:122-150`、`api.ts:646-661` |
| `useProjectUsageSummary` | `-project-usage-summary?limit=10` | `entries[]`（前端只展示 3/6/10） | `dashboard/src/hooks/use-project-usage-summary.ts:9-20,62-80` |
| `useQualityPerDollar` | `tokentracker-outcomes` | `{available, by_model[], by_tool[], totals}` | `dashboard/src/hooks/use-quality-per-dollar.ts:20-50`、`api.ts:667-679` |
| `getSessionInsights` + `getContextHealth`（组件内直调） | `-session-insights`、`-context-health` | `sessions.summary/by_model/subagents`、`estimated_fixed_tokens` | `SessionInsightsCard.jsx:59-73`、`api.ts:681-715` |
| `useUsageLimits` | `-usage-limits` | 用于向原生壳发布状态（非本页视觉主体） | `DashboardPage.jsx:648-657` |
| `useAccountDevices` | account 设备接口 | `devices`、`accountSources` | `DashboardPage.jsx:378-399` |
| `getUserStatus` | `-user-status` | `subscriptions.items[]`、`install.has_active_device_token` | `DashboardPage.jsx:284-295,1099-1130` |

### 3.3 字段语义表（按响应实体）

**summary.totals（KPI/大字/成本）**

| 字段 | 含义 | 消费点 |
|---|---|---|
| `billable_total_tokens` | 计费总 token（含缓存写入/推理口径后的口径），优先展示 | `model-breakdown.ts:52-58`、`DashboardPage.jsx:1148` |
| `total_tokens` | 原始总 token（无 billable 时兜底） | 同上 |
| `input_tokens` / `output_tokens` | 输入 / 输出 | `DashboardPage.jsx:1219-1228` |
| `cached_input_tokens` | 缓存读取（cache read） | `:1229-1233` |
| `reasoning_output_tokens` | 推理输出 | `:1234-1238` |
| `cache_creation_input_tokens` | 缓存写入（cache write） | `model-breakdown.ts:75-83,235-239` |
| `total_cost_usd` | 成本（字符串/数字都接受，`toFiniteNumber` 归一） | `DashboardPage.jsx:1255-1263`、`format.ts:153-156` |
| `conversation_count` | 对话数 | `DashboardPage.jsx:1260-1263` |
| `rolling.last_7d/30d.totals.billable_total_tokens` | 滚动 7/30 天 | `StatsPanel.jsx:83-97` |
| `rolling.last_30d.avg_per_active_day` | 活跃日均 | `StatsPanel.jsx:101-105` |

**daily/trend 行**：`day` 或 `hour`（`YYYY-MM-DDTHH:MM`）或 `month`（`YYYY-MM`）、`total_tokens`/`billable_total_tokens`、四类拆分字段、`conversation_count`、`total_cost_usd`（zoom tooltip 用）；补洞行由前端生成并打标 `missing`（过去缺口）/`future`（未来桶）——`use-usage-data.ts:481-524`、`use-trend-data.ts:246-269`。**`future` 行就是"预测值"图例的来源**（`TrendMonitor.jsx:722-733`）。

**heatmap 单元**：`day`、`value`（= billable/total）、`total_tokens`、`level`(0-4)、`models`(可选 map)；响应级 `weeks[][7]`、`from/to`、`active_days`、`total_cost_usd`、`week_starts_on`(`sun|mon`)（`ActivityHeatmap.jsx:292-317`、`activity-heatmap.ts:139-171`、`use-activity-heatmap.ts:200-210`）。

**model breakdown**：`sources[] = { source, source_scope, totals{...}, models[]{ model_id, model, totals{...}, pricing{status}, cost_source } }`，另有 `pricing.pricing_mode`（`model-breakdown.ts:171-270`；`pricing.status === "unpriced"` 用于成本 `≥` 前缀 `DashboardPage.jsx:1252-1259`）。

**project entry**：`project_key`（`owner/repo`）、`project_ref`、`billable_total_tokens ?? total_tokens`、`sources[].source`（`DataDetails.jsx:15-28,50-66`）。

**outcomes（性价比卡）**：`available`、`by_model[]{ key, cost_usd, accepted, outcomes, acceptance_rate }`、`totals{ accepted, outcomes, cost_usd, acceptance_rate, effective_tokens }`（`QualityPerDollarCard.jsx:27-41,56-108`）。

### 3.4 日期范围 / period 状态机

| 事实 | 证据 |
|---|---|
| `PERIODS = ["day","week","month","total","custom"]`，默认 `month`；`screenshot` 模式强制 `total` | `DashboardPage.jsx:65,349-353` |
| `custom` 分支用用户选的 `customFrom/customTo`，否则 `getRangeForPeriod` | `DashboardPage.jsx:354-365` |
| `day`=当天、`week`=周一起 7 天、`month`=自然月、`total`=最近 24 个月 | `date-range.ts:49-91` |
| 日期键：day→`hour`、total→`month`、其余→`day`（明细表首列跟随） | `DashboardPage.jsx:659-666` |
| 明细分页：`DETAILS_PAGE_SIZE=12`，仅 `day/total/custom` 分页 | `details.ts:3`、`DashboardPage.jsx:67,712-732` |
| 每日明细卡固定"近 30 天"，`total` 时用所选区间并只保留有观测的 30 行 | `daily-breakdown.ts:25-53` |
| 自定义区间 Popover：`react-day-picker` range 双月；应用/取消 | `DateRangePopover.jsx:41-64,69-123` |
| 未来日期从明细/趋势中剔除或标 future | `DashboardPage.jsx:565-571`、`use-trend-data.ts:246-269`、`use-usage-data.ts:481-524` |

### 3.5 时区处理

- 浏览器 `Intl.DateTimeFormat().resolvedOptions().timeZone` + 当前 `getTimezoneOffset()` 取反（`timezone.ts:1-17`）。
- 每次请求都带 `tz` 与 `tz_offset_minutes` 两个 query 参数（`dashboard/src/lib/api.ts:244-254`；调用点如 `use-usage-data.ts:170-188`）。
- 本地"今天"用 `getLocalDayKey`（优先 IANA 格式化，失败用 offset 平移）（`timezone.ts:46-85`）；`total`/heatmap 的日期网格统一按 **UTC 日历**运算（`activity-heatmap.ts:34-43`、`date-range.ts:9-13`）。
- 展示标签：`Area/City (UTC+08:00)` 与短标签 `UTC+08:00`（`timezone.ts:25-44`）；热力图标签只读（`ActivityHeatmap.jsx:481`、`TrendMonitor` 副标题 `showTimeZoneLabel` 由 DashboardView 关掉，`DashboardView.jsx:283-284`）。
- 周起始：默认 `sun`，heatmap 响应可覆盖为 `mon`（`use-activity-heatmap.ts:23`、`ActivityHeatmap.jsx:292`）。

### 3.6 加载 / 缓存 / 刷新 / 错误

| 机制 | 事实 | 证据 |
|---|---|---|
| localStorage 缓存 key | 每个范围一个 key：`tokentracker.usage.<user>.<scope>.<host>.<from>.<to>.<kind>.<tz>.<device>` | `use-usage-data.ts:52-60` |
| 缓存淘汰 | 索引 key + LRU 上限 24 条 | `use-usage-data.ts:17-18,88-100`、`dashboard/src/lib/local-storage-lru.ts:6-25` |
| 趋势/热力图缓存 | 各自 key 前缀与 24 条 LRU | `use-trend-data.ts:20-22,74-89`、`use-activity-heatmap.ts:80-84` |
| 离线降级 | 请求失败读缓存并把 `source` 标 `cache` | `use-usage-data.ts:273-309`、`use-trend-data.ts:290-347` |
| 请求竞态 | `useLatestRequestGuard` 上下文键校验，过期响应丢弃 | `use-usage-data.ts:120-142`、`use-trend-data.ts:130-156` |
| 聚合刷新 | 6 个 refresh 并发 + 单飞（single-flight）避免重复打端点 | `DashboardPage.jsx:890-952`、`dashboard/src/lib/single-flight.js:9-23` |
| 自动刷新 | 本机模式 30s 轮询，页面不可见跳过，交互后自适应延迟 | `lib/local-usage-auto-refresh.ts:3,18-78`、`DashboardPage.jsx:1000-1008` |
| 可见性刷新 | `focus`/`visibilitychange` 触发，15s 节流 | `use-usage-data.ts:419-436` |
| 初始骨架屏 | 仅 cloud 首次加载/scope 未定：`!dashboardContentShown && (resolving || (accountView && loading && !hasDetails))` | `DashboardPage.jsx:1036-1039`、`dashboard/src/components/DashboardSkeleton.jsx:38-149` |
| 错误态 | 该页**没有显式错误 UI**：`usageError` 从 page 传到 view 后未被解构使用（死 prop），失败时通常渲染空数据/缓存 | `DashboardPage.jsx:482,1451` vs `DashboardView.jsx:106-197`（无 `usageError`） |
| 空态 | 热力图"暂无数据"、趋势"暂无数据"、项目"无项目数据"、每日明细给安装/同步命令提示 | `ActivityHeatmap.jsx:415-421`、`TrendMonitor.jsx:691-697`、`DataDetails.jsx:175-181,214-221` |

### 3.7 数字 / 货币格式化（迁移必须逐条对齐）

| 规则 | 事实 | 证据 |
|---|---|---|
| 紧凑 token：`1.5B`、`195.2M` | K/M/B/T，默认 1 位小数；`toFixed` 后 `Number()` 去尾零；千位进位（999.95K→1M） | `format.ts:53-110` |
| 全量 token：千分位 | `Intl.NumberFormat`；可切 4 位分组（万进制中文习惯） | `format.ts:13-51`；`token-format.js:123-141` |
| 中文单位制 | `万/亿/万亿`，默认 1 位小数 | `format.ts:114-151` |
| 两种模式 | `compact` / `full`，本地持久化 `tt.tokenFormat`；工具栏/大字可点切换 | `token-format.js:7-24,43-61`；`DashboardPage.jsx:1146-1156` |
| tooltip | `紧凑 · 全量` 双写 | `token-format.js:157-165` |
| 货币 | 默认 2 位小数，非 USD 乘汇率；空串→`-`、真 0→`$0.00`；`<$0.01` 显示 `<`；`unpriced` 加 `≥` | `format.ts:174-220`；`UsageOverview.jsx:47-54`；`DashboardPage.jsx:1255-1259` |
| 汇率 | 6 币种（USD/EUR/GBP/CNY/JPY/HKD），内置默认值 + 24h TTL 拉取 `open.er-api.com`，离线降级默认值 | `currency.ts:7,26-33`；`exchange-rate.ts:7-10,33-72` |
| 百分数 | provider 卡 2 位小数（`100.00%`，<0.01% 显示阈值文案）；模型 share 1 位；Top3 percent 1 位 | `UsageOverview.jsx:39-40,118-127`；`model-breakdown.ts:208,213-214`；`model-breakdown.ts:401` |
| 大字动画 | `Counter` 逐位滚动（72px，60-72px 响应式），<640px 时不启用直接渲染文本 | `UsageOverview.jsx:252-268,315-332`；`dashboard/src/ui/components/Counter.jsx:29-48,127-180` |

---

## 4. 图表实现与迁移成本

### 4.1 依赖事实

`dashboard/package.json:20-45` 中与用量页直接相关的：`motion`、`lucide-react`、`@base-ui/react`、`@dnd-kit/*`、`react-day-picker`、`date-fns`、`clsx`、`tailwind-merge`。
**没有** recharts/d3/echarts/chart.js；`three`/`ogl` 仅用于营销页 `TokenGalaxy.jsx`（`dashboard/src/ui/marketing/v3/TokenGalaxy.jsx`），`gsap` 仅营销，`html-to-image` 仅分享卡截图。
`DateRangePopover.jsx:2-4` 是唯一 date-fns 使用点。

### 4.2 各图表的实现方式

| 图表 | 技术 | 关键算法/交互 | 证据 |
|---|---|---|---|
| 2D 热力图 | CSS Grid（7 行 × N 列，单元格 12px） | 单元格 level 由 p50/p75/p90 分位阈值决定（0-4 级）；月份刻度按 12 个月反推列号；右对齐滚动到最新；hover tooltip 用 `createPortal` 到 body + 翻转/平移避让 | `ActivityHeatmap.jsx:13-31,294-317`、`activity-heatmap.ts:117-137`、`ActivityHeatmap.jsx:505-577,866-985` |
| 3D 热力图 | **纯 SVG 手绘等轴投影** | 自写 `rotatePoint(yaw,pitch)` → 8 顶点投影 → 6 面背向剔除 + 漫反射着色 → 画家算法排序；波浪生长动画（1.2s）、拖拽旋转 + 惯性、自动旋转（隐藏页暂停/尊重 reduced-motion）、滚轮/触控板缩放 0.5-3x；全屏 Modal 内叠加统计/调色板/评述 | `ActivityHeatmap3D.jsx:5-27,41-58,160-342,375-467,512-720` |
| 趋势堆叠柱 | flex 逐列 div，无 canvas | 柱高按 `effectiveMax` 百分比；**IQR 剔除离群**（≥4 点、q3+1.5IQR）；分段顺序：优先 `row.models`（大小写合并），否则 4 类 token；预测/缺口用线性插值+均值指数衰减（0.98/步）并 35% 透明；tooltip 依据可视带自动上下翻转，可点击固定、Esc/滚动关闭 | `TrendMonitor.jsx:28-66,137-204,212-318,336-442,661-740,743-887` |
| 分布条 | 单个 `flex` 容器内百分比宽度的 div，`motion.div` 宽度动画 | provider 百分比累加即 100%，全部工具恒显示 `100.00%` | `UsageOverview.jsx:536-566`、`:570-604` |
| 模型行细条 | 3px 高进度条 + `role="progressbar"` | share 截断 0-100 | `UsageOverview.jsx:831-846` |
| 数字滚动 | `motion` + `useMotionValue/useSpring`，逐位 `<span>` 滚动 | 位数由展示字符串推导；小数位单独占位 | `dashboard/src/ui/components/Counter.jsx:29-48,127-180` |

### 4.3 vanilla 迁移成本估算（人日，含自测）

| 区块 | 估算 | 理由 |
|---|---|---|
| 2D 热力图 + tooltip | 1.0-1.5d | Grid DOM + 分位算法可直接搬；tooltip 定位/翻转逻辑可照抄 |
| 3D 热力图（内嵌 + 全屏 Modal） | 3-4d | 投影/排序/裁剪算法可纯函数化照搬；交互（拖拽/惯性/缩放/RAF）需重写为 pointer events；Modal 动效需 CSS |
| 趋势柱状图 + tooltip + zoom modal | 2-3d | 堆叠 DOM 简单；tooltip 带"可固定/自动翻面/边界避让"状态机较繁；zoom 需要独立数据实例 |
| StatsPanel + UsageOverview + DataDetails | 2-3d | 表格/列表为主，主要是状态（period/sort/page/tab/展开行）重写 |
| 数字滚动/入场动画 | 0.5d 或放弃 | Counter 强依赖 motion 的 spring；可用 CSS 或直接舍弃 |
| 图表库 | 0 | 不需要引入任何图表库 |

---

## 5. 设计系统（TT 侧）与视觉特征

- **Tailwind 配置**：`darkMode:"class"`；`oai` 色板（black `#0a0a0a`、white `#fafafa`、gray 50-950、brand 绿系、amber/success/warning/error/info）；`blue` **被映射为绿色**（`tailwind.config.cjs:179-185`）；圆角 `sm4/md8/lg12/xl16`（`:219-224`）；`shadow-oai-sm/md/lg`（`:213-218`）；字体栈 `OpenAI Sans` 优先但**未随包提供**（`:17-37`）。
- **全局字体**：`main.jsx` 只加载了 `@fontsource/geist-mono`（400/500/700/900），正文实际落到系统 sans（`main.jsx:13-16`）。
- **CSS 变量层**：`styles.css` 里 `--oai-*`、`--brand-*`、`--community-*`、`--provider-*`、`--text-*`、`--space-*`、`--radius-*`（`dashboard/src/styles.css:6-140`）；暗色在 `:root`/`.dark` 双份重声明（`:145-183`）；OKLCH 主值 + sRGB fallback + `@supports` 恢复（`:14-31` 注释、文件尾）。
- **组件原子**：`Button/Card/Shell/Badge/Select/SegmentedControl/Counter` 统一由 `ui/components/index.js` 导出（`ui/components/index.js:1-13`）。`Card` = `rounded-xl + 1px border + bg-white/dark:bg-oai-gray-900 + p-5`（`Card.jsx:11-24`）。
- **断点/移动端规则**：Tailwind 默认 `sm640/md768/lg1024` + `tall/xtall` 视口高断点（`tailwind.config.cjs:9-16`）；`DESIGN.md` 明确：tab 条横向滚动不换行、大数字用 clamp/响应式字号、表格在 `sm` 以下折叠次要列、触控目标 ≥40px（`DESIGN.md:Typography / Mobile structural rules` 段）。实现例：UsageOverview tab 条 `overflow-x-auto`（`:378`）、KPI `grid-cols-2 xl:grid-cols-4`（`StatsPanel.jsx:80`）、大数字 `text-5xl sm:text-6xl md:text-7xl`（`UsageOverview.jsx:476`）。
- **暗色模式**：`ThemeProvider` 默认 `system`，`html.dark` class + `prefers-color-scheme` 监听 + localStorage `tokentracker-theme`（`ThemeProvider.jsx:10,24-58,119-170`）。注意设计文档称"dashboard defaults dark"，代码默认是 system（`DESIGN.md` 第一段 vs `ThemeProvider.jsx:24-35`）。

---

## 6. 与 Highlighter Nightshift token 的冲突清单

依据 `F:/workspace/Highlighter/shared/tokens.css`（`:35-105` 亮色、`body.dark` 块暗色）与 `config/config.html:5`（CSP）。

| 维度 | TokenTracker | Highlighter Nightshift | 冲突/处理 |
|---|---|---|---|
| 底色 | 纯白 `#fafafa` / 近黑 `#0a0a0a`，绿灰中性 | 沙色 `--bg:#eeebe4`、`--surface:#fffefb`；暗色暖炭 `#121110/#1c1a18` | **必须换 token**：TT 的白底/黑底会破坏 Nightshift 的暖色层次 |
| 品牌色 | 固定绿 `#059669`（且"蓝"也映射成绿） | `--primary` 用户可配置；派生 `--primary-text/--primary-soft/--primary-line` | **不能搬运**：把 TT 绿写死会忽略用户主色；成本数字、选中态改用 `--primary-text` |
| 中性色阶 | `--oai-gray-50..950` 绿灰 | `--ink/--ink-2/--muted/--faint` + `--line/--line-2` | 需做映射表： `gray-500→--muted`、`gray-300→--line`、`gray-700→--ink-2` 等；不要引入第二套灰阶 |
| 卡片边界 | 1px border + `rounded-xl(16px)` + 无阴影 | elevation ladder（`--shadow-1/2/3`）+ 少边框 + `--radius` 用户可调 | **需重写**：卡片的 `border` 改 `box-shadow: var(--shadow-1)` 或 `--line` 细线；圆角改 `var(--radius)`/`var(--radius-lg)` |
| 字体 | OpenAI Sans 优先（未打包）→ 系统 sans；数字 tabular-nums | `--font-ui` = Segoe UI Variable Text；`--font-mono` = Cascadia Mono | TT 的 `font-oai`/`OpenAI Sans` 不存在于 Highlighter；数字统一 `--font-mono` + `font-variant-numeric: tabular-nums` |
| 主色使用比例 | 品牌绿 ≤10%（DESIGN.md） | 强调色同样克制，但可用于选中/主操作 | 语义一致，可保留"占比条用数据色、UI 不用品牌色"的原则 |
| 多色数据调色板 | `PROVIDER_COLORS` 12+ 硬编码 hex（`UsageOverview.jsx:75-91`）、`STACK_COLORS` 12 色（`TrendMonitor.jsx:68-81`）、`PALETTES` 4 套（`ActivityHeatmap3D.jsx:5-27`） | 无数据可视化色板；只有 `--ok/--warn/--danger` | **需替换**：要么新增一组 `--chart-1..N`（在 `tokens.css` 双声明），要么降饱和并用 `--primary` 派生单色系；硬编码 hex 会破坏主题一致性 |
| 圆角 | 4/8/12/16 固定 | `--radius`（默认 9px）± 派生 | 禁止 `rounded-xl` 等 Tailwind 值；改用 `var(--radius-lg)` |
| 阴影/玻璃 | `backdrop-blur` 玻璃 tooltip、`shadow-xl` | `--shadow-1/2/3`，浮动层用 `--shadow-2` | tooltip/Modal 需改 token，`backdrop-filter` 在 Electron 可用但需确认不干扰窗口透明合成 |
| 暗色机制 | `html.dark` + Tailwind `dark:` + `.dark` 变量覆盖 | `body.dark` + token 双声明（`tokens.css` 顶部规则 2） | **机制不同**：迁移后不能在 `html` 上加 class；组件若用 `dark:` 前缀需全量改写 |
| 字体/网络资源 | `@fontsource` 打包字体、汇率外网请求 | CSP `connect-src 'none'`、`font-src 'self' data:`（`config/config.html:5`） | 汇率外网请求在 Highlighter 渲染进程**会被 CSP 阻断**：要么主进程代理，要么只保留 USD/固定汇率 |
| 图标 | `lucide-react`（60 处）+ 品牌 SVG/img | 无图标库；现有窗口多用内联 SVG | 需挑选/内联必要图标（`RefreshCw/Info/ChevronDown/Maximize2/X/Play/Pause/RotateCcw` + provider 图标），或重画 |

---

## 7. 共享 UI 原子与无障碍/交互细节（可复用清单）

- `Card/Button/Badge/Select/SegmentedControl/Counter`（`ui/components/index.js:1-13`）。
- `UsageOverview` tablist 完整键盘支持：Arrow/Home/End 循环聚焦并点击（`UsageOverview.jsx:296-313`）；provider 卡是 `<button aria-expanded aria-controls>`，展开区是 `role="region"`（`:571-694`）。
- 热力图单元格 hover 有 150ms 防抖与滚动即关（`ActivityHeatmap.jsx:169-174,278-290`）；3D 用 `getScreenCTM` 计算 tooltip 位置（`ActivityHeatmap3D.jsx:590-640`）。
- 趋势柱 `role="button" tabIndex=0`，Enter/Space 打开固定 tooltip（`TrendMonitor.jsx:261-270`）；`prefers-reduced-motion` 在 Counter/Refresh/热度动画/3D 自动旋转中均被尊重（`TrendMonitor.jsx:224,253-256`、`ActivityHeatmap3D.jsx:216-219`）。
- 明细表 `aria-sort`、排序图标 ▲▼、`sticky top-0` 表头（`DataDetails.jsx:225-247`）。
- 项目列表用 `<button>` 打开本地详情 Modal（**刻意不跳转外链**，避免泄露 repo，`DataDetails.jsx:26-33`）。

---

## 8. i18n 组织（迁移时的文案来源）

- 基础英文文案源：`dashboard/src/content/copy.csv`（2104 行，列 `key,module,page,component,slot,text,notes,status`），由 Vite 插件生成 `virtual:tokentracker-copy-registry`（`dashboard/vite.config.js:10,34,113`、`copy.ts:1`）。
- 翻译：`dashboard/src/content/i18n/{zh,zh-TW,ja,ko,de}/{core,dashboard,marketing}.json`（zh dashboard 1037 行、core 855 行）。
- 运行时：`copy(key, params)` + `{{param}}` 插值；缺失回退英文 + DEV 警告（`copy.ts:79-113`）；`getCopyLocale()` 供 date-fns 用（`:89-91`）。
- key 命名：`usage.period.*`、`usage.summary.*`、`usage.overview.*`、`usage.metric.*`、`trend.monitor.*`、`heatmap.*`、`heatmap.3d.modal.*`、`stats.period.*`、`identity_card.*`、`daily.sort.*`、`dashboard.projects.*`、`qpd.card.*`、`sessions.card.*`、`provider.display.*`。
- 迁移含义：Highlighter 用 `shared/locales/*.js` + `shared/i18n.js`（`config/config.html:53-67` 的加载顺序），**只能搬 key 树与中文文案，不能搬 copy 机制**；3D 热力图 Modal 里有 30+ 条文案（`heatmap.3d.modal.*`）与"AI 评述"按总量分档（`ActivityHeatmap.jsx:359-395`），迁移时建议直接砍掉或改静态说明。

---

## 9. 测试与 mock 机制

| 机制 | 事实 | 证据 |
|---|---|---|
| 单测 | Vitest + jsdom；`include: src/**/*.test.{js,jsx,ts,tsx}` | `dashboard/vitest.config.ts:1-12` |
| 纯逻辑测试 | token-format/format/trend-stats/model-breakdown/daily-breakdown 均有测试 | `dashboard/src/lib/token-format.test.js`、`trend-stats.test.js`、`format.test.ts`、`model-breakdown.test.ts`、`daily-breakdown.test.ts` |
| 组件测试 | 8 个 dashboard 组件测试（含 ActivityHeatmap/3D/TrendMonitor/UsageOverview/DataDetailsProjects/StatsPanel） | `dashboard/src/ui/dashboard/components/__tests__/` |
| Mock 数据 | `?mock=1`（URL）或 `VITE_TOKENTRACKER_MOCK=1` 开启；提供 daily/summary/heatmap/model-breakdown/project/outcomes 假数据，支持 mock 时钟 | `dashboard/src/lib/mock-mode.ts:1-15`、`dashboard/src/lib/mock-data.ts:24-100,395-420`、`DashboardPage.jsx:160,347` |
| 截图模式 | `?screenshot=1`：隐藏 share/refresh/periods、强制 total、隐藏热力图图例、跳过 dnd | `DashboardPage.jsx:147-150,353,1209`、`DashboardView.jsx:209-220,411-419` |
| 视觉回归 | Playwright + pixelmatch 脚本（`scripts/capture-dashboard-screenshot.mjs`、`compare-visual-baselines.mjs`） | `dashboard/package.json:13-14,61-62` |

迁移价值：`token-format/format/trend-stats/activity-heatmap/model-breakdown/daily-breakdown/date-range/timezone` 这些纯函数（及其单测）是**最可靠的资产**——可以 1:1 翻译为 Highlighter 的 `IIFE + global` 模块并用 node:test 重写用例。

---

## 10. 可迁移性结论（四类，按区块）

### 【可直接复用（逻辑/算法）】

| 区块 | 可复用内容 | 证据 |
|---|---|---|
| token 格式化 | `formatCompactNumber/formatChineseNumber/formatUsdCurrency/格式切换与 tooltip` | `dashboard/src/lib/format.ts:13-220`、`token-format.js:123-165` |
| 日期/时区 | `getRangeForPeriod`、`getLocalDayKey/getLocalDateParts`、时区标签、UTC 日历工具 | `date-range.ts:49-91`、`timezone.ts:25-154` |
| 热力图模型 | `buildActivityHeatmap`（分位 level + 周对齐 + 月刻度）、`computeActiveStreakDays` | `activity-heatmap.ts:59-196` |
| 趋势统计 | `computeZoomStats`、`formatBucketRange/formatTrendRange/formatTickLabel`、IQR 缩放、插值预测 | `dashboard/src/lib/trend-stats.js:34-79,152-233`、`TrendMonitor.jsx:28-66,137-204,336-402` |
| 聚合归一 | `resolveDisplayTokens`、`buildFleetData`、`buildAllModels`、`buildTopModels`（含大小写/别名合并、cache hit rate） | `dashboard/src/lib/model-breakdown.ts:52-414` |
| 明细数据选择 | `buildDailyBreakdownRange`、`selectDailyBreakdownRows`、`paginateRows`、`trimLeadingZeroMonths`、排序键表 | `dashboard/src/lib/daily-breakdown.ts:25-53`、`dashboard/src/lib/details.ts:3,30-45`、`dashboard/src/lib/daily.ts:6-37` |
| 刷新/缓存策略 | 单飞、可见性节流、30s 轮询、LRU 缓存键设计（迁移到主进程后语义保留） | `dashboard/src/lib/single-flight.js:9-23`、`dashboard/src/lib/local-usage-auto-refresh.ts:3,18-78`、`dashboard/src/lib/adaptive-refresh.ts:17-27`、`dashboard/src/lib/local-storage-lru.ts:6-25`、`use-usage-data.ts:52-60` |
| 图表算法 | 3D 等轴投影/背向剔除/画家排序/着色、热力图分位、预测插值 | `ActivityHeatmap3D.jsx:41-58,369-467`、`TrendMonitor.jsx:343-402` |

### 【需重写为 vanilla JS】

| 区块 | 重写点 | 依据 |
|---|---|---|
| 页面状态编排 | 10 个 hook 的加载/缓存/竞态/刷新 → 一个模块级 store + IPC 数据层；period/排序/分页/展开态改 DOM 状态或轻量 store | `DashboardPage.jsx:476-1008` |
| 拖拽排序卡片 | `@dnd-kit` → pointer 事件 + 顺序持久化（也可以直接删掉，设置页给固定顺序） | `DashboardView.jsx:387-431`、`SortableCard.jsx:23-92` |
| 日期区间 Popover | `react-day-picker + date-fns` → 自绘双月日历或 `<input type=date>`x2（成本最低） | `dashboard/src/ui/dashboard/components/DateRangePopover.jsx:1-125` |
| Popover/Modal 基元 | `@base-ui/react` Popover、自绘 Modal（focus trap/Esc/滚动锁）→ 用原生 `<dialog>` + 少量 JS | `UsageOverview.jsx:24,393-427`、`ActivityHeatmap.jsx:593-864`、`TrendMonitorZoomModal.jsx:101-198` |
| 动画 | `motion` 的入场/宽度/数字滚动 → CSS transition/`animation` + `requestAnimationFrame`（数字滚动可砍） | `UsageOverview.jsx:555-565`、`TrendMonitor.jsx:249-258`、`dashboard/src/ui/components/Counter.jsx:29-48,127-180` |
| 3D 热力图交互 | React 状态 + RAF → 命令式 DOM/SVG 更新；保持同一投影函数 | `ActivityHeatmap3D.jsx:160-342` |
| 趋势 tooltip 状态机 | hover/pin/边界翻转/滚动关闭 → 纯 DOM 事件实现（逻辑不变） | `TrendMonitor.jsx:404-614,743-887` |
| 键盘/ARIA | tablist/provider 卡/柱状图的可访问性属性需手工补回 | `UsageOverview.jsx:296-313`、`TrendMonitor.jsx:261-270` |

### 【需替换为 Highlighter 设计 token】

| 区块 | 替换动作 |
|---|---|
| 所有卡片/chrome | `rounded-xl + 1px border + bg-white/dark:bg-oai-gray-900` → `--surface`、`--line`、`--radius`、`--shadow-1`（`Card.jsx:11-24` vs `tokens.css:38-105`） |
| 文本/次级文本 | `text-oai-gray-500/dark:text-oai-gray-300` → `--muted/--ink-2`；标题 → `--ink` |
| 成本/选中/链接 | `text-oai-brand` → `--primary-text`；选中背景 `bg-oai-gray-100` → `--surface-2/3` |
| 数据可视化色板 | `STACK_COLORS/PROVIDER_COLORS/PALETTES/token 颜色` → 新增 `--chart-1..12`（双声明）或单色系派生（`TrendMonitor.jsx:68-110`、`UsageOverview.jsx:74-96`、`ActivityHeatmap3D.jsx:5-27`） |
| 字体 | `font-oai` → `--font-ui`；token/数字 → `--font-mono` + tabular-nums |
| tooltip/浮层 | `bg-white/95 backdrop-blur shadow-xl` → `--surface` + `--shadow-2`（若玻璃效果保留需实测 Electron 透明合成） |
| 暗色/明暗切换 | 删除 Tailwind `dark:` 前缀体系，改为 `body.dark` + token 双声明（`tokens.css:9-22` 规则） |

### 【建议放弃或简化】

| 项 | 理由 | 证据 |
|---|---|---|
| 3D 热力图全屏 Modal 的"AI 评述/调色板/自动旋转" | 30+ 文案 + 非核心功能，vanilla 迁移性价比最低；可仅保留静态 3D 缩略或直接砍 3D | `ActivityHeatmap.jsx:593-864`、`ActivityHeatmap3D.jsx:65-79` |
| provider 特例提示（Devin/Kiro/Trae/Antigravity/Context Breakdown/unpriced/cache-hit-rate） | 绑定 TT 对 46 种 CLI 的解析与定价数据；Highlighter 只有自身调用，无这些口径 | `UsageOverview.jsx:335-365,871-978` |
| 设备筛选（device filter）与 DeviceUsageCard | 依赖 TT 云账户/多设备同步 | `DashboardPage.jsx:378-441`、`UsageOverview.jsx:446-455` |
| 分享卡/截图模式（ShareModal、html-to-image、screenshot 参数） | 与 Highlighter 产品无关 | `DashboardPage.jsx:147-150,1492`、`package.json:34` |
| 订阅徽章（userStatus.subscriptions） | TT 账户体系 | `StatsPanel.jsx:146-158` |
| 卡片 DnD 排序 + 可见性规则 | 维护成本高；固定布局 + 设置开关更简单 | `dashboard/src/hooks/use-dashboard-card-order.js:4-26`、`DashboardView.jsx:204-223` |
| Labs opt-in 的性价比卡/会话洞察卡 | 依赖 outcomes.jsonl / session insights 端点 | `use-quality-per-dollar-pref.js:9`、`use-session-efficiency-pref.js:3` |
| 多币种汇率（外网请求） | Highlighter CSP `connect-src 'none'`；且多数用户只看 USD/CNY，可内置固定汇率 | `config/config.html:5`、`dashboard/src/lib/exchange-rate.ts:7-10` |
| 周期"自定义"日历（若排期紧） | 首版可只做 日/周/月/总计，自定义用两个 date input | `dashboard/src/ui/dashboard/components/DateRangePopover.jsx:41-125` |

---

## 11. 建议的最小迁移切片（供 Lead 决策）

1. **P0（1-2 天）**：右栏 `UsageOverview` 的"日/周/月/总计 + 大字 + 成本 + provider 占比卡" + `StatsPanel` 4 KPI（依赖 task-2 的聚合端点）。
2. **P1（2-3 天）**：`DataDetails` 每日明细表 + `TrendMonitor`（日均值粒度、预测值可后置）。
3. **P2（2-3 天）**：2D 热力图 + tooltip（分位算法直接复用）。
4. **P3（可选，3-4 天）**：3D 热力图（建议降级为静态/进入即暂停的展示）。
5. 每步都先落 **纯函数模块 + node:test**，再包 UI，避免把 TT 的 React 状态机带进来。

---

## 12. 未验证 / 待确认清单

1. 截图来源版本：本 checkout 为 `v1.4.7-1-g148b758e`，截图中「模型占比条形列表」「蓝色进度条」「UTC 切换」与代码不完全对位（§2.3）。需向用户确认截图版本或提供原图。
2. Highlighter 用量页落点（新设置路由 vs 独立窗口）会影响 DOM 结构与 CSP（task-3 负责），本文件只按"单窗口滚动内容"估算。
3. Highlighter 是否有等价"本地 HTTP 端点"计划，还是直接 IPC；若走 IPC，`fetchLocalJson` 的 cloud/local 双通道逻辑可整体丢弃（§3.1）。
4. `three`/`ogl` 是否会被 Highlighter 打包体积策略禁止——本页不需要，但需确认依赖审计（`package.json` 依赖白名单未知）。
5. 暗色/紧凑模式在 Highlighter 的实际组合（`--radius` 用户值、紧凑模式 token）未在本文档验证视觉效果。
