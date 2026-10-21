# 开发方案：在 Highlighter 内新增「AI 用量」页（TokenTracker 同口径）

- 日期：2026-10-21
- 状态：**开发方案（Q1–Q3 已确认，B0 实施中）**
- 上游分析：[2026-10-21-tokentracker-usage-page-migration-analysis.md](./2026-10-21-tokentracker-usage-page-migration-analysis.md) + 底稿 [usage-migration-analysis/](./usage-migration-analysis/)
- 基线（本机重新核对，路径以本机为准）：
  - Highlighter：`D:\workspace\Highlighter` @ `master` `9af4a31`（4.0.0；Electron 43.2.0 / Node 24.18.0）
  - TokenTracker：`D:\workspace\TokenTracker` @ `v1.4.7-1-g148b758e`（MIT，Copyright (c) 2026 xiufengsun）
- 本文以「把分析转成可执行的开发方案」为目标：**冻结契约、拆任务、定顺序、定验收**。所有关键数字都按 `D:\workspace` 重新核对过；与上游分析不一致处标注「复核」。
- 本文只产出方案，未改任何产品代码。
- **已确认范围（2026-10-21，用户拍板）**：首版工具 = **Codex / DSH / OpenCode**；**不做金额（美元）**；统计开关**默认关闭 + 首次进入页面内联同意**。本文已按此调整范围、任务、工期与验收（见 §0.5、§3、§6）。

---

## 0. 结论摘要（先看这一页）

### 0.1 推荐方案一句话

> **路线 A（vendor TokenTracker 解析闭包 → 重写本地编排/聚合 → 设置窗口新增 `usage` 路由 → Nightshift 重画页面）不变；交付方式改为「垂直切片优先 + 数据/页面双轨并行」：先用 Codex 一个工具打通「日志 → SQLite → IPC → 页面」，再补齐 DSH/OpenCode（已确认的首版 3 工具），然后并行做查询与主视图。**

首版（MVP）已确认范围：**3 个工具（Codex / DSH / OpenCode）、主视图、日/周/月/总计、2D/手绘图表、不做金额、设置窗口新路由、默认关闭+首次同意、回填 24 个月**。工具扩展（20/约 42 个）与金额已移出本次交付，保留为后续批次（见 §0.5）。

### 0.2 里程碑与工期

| 里程碑 | 结束批次 | 可演示内容 | 人日（单人，含自测） |
|---|---|---|---|
| M0 口径基线 | B0 | 命令行输出「Highlighter 聚合 vs TokenTracker queue」逐桶对照表；vendor 解析器在纯 Node 下跑通 | 4.5–5 |
| M1 单工具贯通 | B1 | 打开「用量」页能看到本机 Codex 真实 token（KPI+明细雏形） | 5–6 |
| M2 三工具引擎 | B2 | Codex/DSH/OpenCode 扫描/增量/重写/取消/进度；二次扫描 0 新桶 | 6.5–7.5 |
| M3 MVP 可用 | B3+B4 | 完整主视图（KPI/总览/来源模型/趋势/明细/覆盖状态），全门禁绿 | 11–14 |
| M4 对齐截图 | B5 | 2D 热力图、日视图小时、自定义区间、覆盖细化 | 4.5–5 |
| M5 发布收尾 | B6 | 打包与运行时验收、数据目录演练、许可/文档、全量门禁（不含工具扩展/金额） | 4.5–5 |

- **MVP（B0–B4）：27–32 人日（单人约 5.5–6.5 周；双轨并行约 4–4.5 周）**。
- **本次完整交付（B0–B6）：36–42 人日（单人约 7.5–8.5 周）**。
- 与上游分析的偏差：分析给 MVP 21–30 人日（8 工具）；本次只做 3 工具、砍掉金额与工具扩展，但把 IPC+查询、页面状态、对拍测试单列成显式任务，MVP 27–32 人日。若把首版工具再砍到 2 个，可压到 24–28 人日。

### 0.3 本方案相对分析报告的 6 个细化决策（技术上的主要增量）

| # | 细化点 | 决策 | 理由 |
|---|---|---|---|
| S1 | 交付顺序 | 先垂直切片（1 工具端到端），再扩表；页面线从 B0 契约后即可用 mock 并行 | 分析是「引擎→页面」顺序，存在 2–3 周无可视产出；垂直切片让口径/UI 风险最早暴露 |
| S2 | 扫描进程与写入 | **主进程是 SQLite 唯一写者；`utilityProcess` 只做解析**（分析 §6.1 是 worker 直接写库） | 桶行/游标状态必须与 `scan_state` 同事务提交才能防「桶已写、游标未提交」导致的重复计数；同时去掉跨进程 WAL 风险。备选方案见 §5 R2 |
| S3 | 解析输出通道 | 给 vendored `enqueueTouchedBuckets` 注入 sink（最小 diff），默认仍可写 JSONL 供对拍；**不落 queue.jsonl** | 单一事实源（SQLite），无双写；保留 JSONL 能力便于 oracle/排障。失败时退化为「保留 queue.jsonl 暂存 + 主进程增量摄入」 |
| S4 | `main.js` 组装 | **单行 `install({...})` 组装**（1 行），不采用常规 `registerX` 四行块；数据目录迁移通过 `usage-runtime` 注册表 quiesce | 复核确认门禁只剩 6 行；常规块放不下。常规块是 2 require + 4 行 |
| S5 | 热力图 | 数值与 level 算法按 TT `local-api`（区间最大值相对四档）复刻；但**修正 TT 的周对齐缺陷**（固定周一为列首） | 复核：TT `local-api.js:2585-2631` 列首随“今天”星期漂移，`week_starts_on` 又硬编码 `"sun"`；照抄会得到错误星期对齐。数值对拍不受影响（只比 cell 值） |
| S6 | WSL / sqlite CLI | 首版 stub 掉 `wsl-probe`（禁止 `spawn wsl.exe`）；`sqlite-reader` 强制走 `node:sqlite` 分支；`scan-roots` 去掉 `~/.tokentracker` 配置读取 | 复核发现 TT 会同步 spawn `wsl.exe` 探针（`wsl-probe.js:28`），且 `sqlite-reader.js` 优先外部 `sqlite3` CLI；两者在 Electron 里都是阻塞/环境依赖风险 |

### 0.4 本机环境与数据复核（与分析的差异）

| 事项 | 分析报告 | 本机复核（2026-10-21） | 影响 |
|---|---|---|---|
| 仓库路径 | `F:/workspace/...` | 本机为 `D:\workspace\...`，F: 不存在 | 仅路径；行数/结论一致 |
| 解析闭包 | 20 文件 / 29,690 行 | **20 文件 / 29,670 行**（依赖遍历口径差 20 行） | 无 |
| TT 本机历史数据 | `~/.tokentracker/tracker` 约 40 MB | **不存在**；只有 `~/.tokentracker/cache/pricing.json`（418,523 B） | oracle 必须自己装 TT CLI 生成 queue，不能直接拿现成历史 |
| 本机 AI CLI 日志 | 未列 | `~/.claude` 1.4 MB/8 文件；`~/.codex/sessions` **420 MB/300 文件**（单文件最大 40 MB）；`~/.dsh/sessions` 70 MB/141 个 `.zstd`；OpenCode `opencode.db` **754 MB**；`~/.gemini/tmp` 32 KB 且 0 个 `session-*.json`；`~/.copilot` 无 `session-store.db` | 首次扫描性能是最硬的现实约束；同时提供「已安装无数据/未安装」真实覆盖状态样本 |
| Electron 运行时 | 24.18.0 / node:sqlite / zstd 可用 | 复核一致（`DatabaseSync`、`zstdDecompressSync` 实测通过） | 无 |
| 覆盖率 | 91.85% | 本机无 coverage 产物，**未复核**；门禁为全局行覆盖 85% | 新文件必须带单测 |
| 解析测试资产 | 28 文件 / 35,948 行 / 791 tests | **31 个 parser/rollout 测试文件 / 52,117 行 / 1,013 tests**（范围不同） | vendor 时按文件白名单挑，不必全量 |
| heatmap level | 最大值相对四档（§1.2 #10） | 复核确认 `local-api.js:2598-2605` 为 max-relative；前端 fallback 才是 p50/75/90（`01-tt-frontend.md` 描述的是 fallback） | 服务端口径 = max-relative，作为唯一口径 |
| 周起点 | 未细说 | `local-api.js:2631` 硬编码 `week_starts_on:"sun"`，且网格起点 `today-(weeks*7-1)` 导致首列星期随今天变化 | 见 S5，记录偏差 |
| `main.js` 余量 | ≤6 行可装配 | 复核：常规 `registerX` 块**放不下**（2 require + 4 行）；必须单行 install（S4） | 影响装配方案 |
| TT 解析器外部依赖 | 0（删 zstd fallback） | 复核一致：闭包内唯一 npm 依赖是 `@mongodb-js/zstd`，且仅 lazy fallback（`rollout.js:13159,24098`） | 零新增运行依赖成立 |

### 0.5 已确认范围（2026-10-21）与本次交付边界

| 决策 | 确认值 | 对方案的影响 |
|---|---|---|
| Q1 首版工具 | **Codex / DSH / OpenCode 三个** | 注册表 3 条；B1 垂直切片用 Codex（风险最高：420 MB/累计快照/zstd）；B2 补 DSH（70 MB/zstd 帧）与 OpenCode（754 MB DB）；工具扩展批次移出本次交付 |
| Q2 金额 | **不做** | `total_cost_usd=null`；不 vendor pricing；B6 无金额任务；页面不出现美元行 |
| Q3 统计开关 | **默认关闭 + 首次进入页面内联同意卡** | `DEFAULT_SETTINGS.usage.enabled=false`；首次同意后触发首扫；设置页保留开关 |
| 页面落点 | 设置窗口新路由（默认） | 不变 |
| 历史回填 | 24 个月 | 不变 |
| 扫描方式 | 只读被动，不写 hook | 不变 |

**本次交付 = B0–B6**：3 工具的完整主视图（B0–B4，MVP）+ 热力图/日视图/自定义（B5）+ 发布收尾（B6）。**不在本次交付**：金额、工具扩展（第 4–42 个）、项目/会话/云/3D/分享、WSL。

---

## 1. 目标、范围与完成定义

### 1.1 用户可见目标（MVP）

侧栏「工具设置」组新增「用量」入口；页面自上而下：

1. **覆盖状态条（常驻）**：已检测 X/3、各工具状态（Codex/DSH/OpenCode 的 正常/无数据/不可读/未安装/错误）、上次扫描时间、扫描中进度、清除入口；另固定一行「Cursor 等账号级工具：本机不可统计」。
2. **周期 tabs**：日 / 周 / 月 / 总计（MVP 不含自定义；B5 加）。
3. **4 列 KPI**：近 7 天 token、近 30 天 token、活跃日均、对话数（复用 `.history-stats` 的视觉语言）。
4. **总览大字**：区间内 `billable_total_tokens` 大字 + 全量 tooltip + 区间说明 + 来源分段占比条。
5. **来源/模型占比**：来源卡网格（全部 + 各 CLI + 模型数）+ 模型 Top N 细条列表。
6. **近 30 天趋势**：自绘堆叠柱（输入/缓存/输出），hover tooltip。
7. **每日明细表**：日期 / 总计(billable) / 输入 / 输出 / 缓存读 / 推理 / 对话数；数字右对齐 mono；表头 sticky。
8. **状态**：加载骨架、空态（未检测到工具 + 说明）、错误态（banner + 重试）、未开启态（首次同意卡）、扫描中态（进度 + 可继续浏览已有数据）。

**关键产品原则**：页面永远诚实展示「哪些工具能统计、哪些不能、为什么」；Cursor 明确标注「需账号 API，本机不可统计」。

### 1.2 「同口径」不变式 → 实现与测试映射（验收主线）

| # | 口径（分析 §1.2） | 落库/查询实现 | 页面位置 | 对应测试 |
|---|---|---|---|---|
| 1 | UTC 半小时桶 | vendored parser 产出 `hour_start`（`:00/:30`）；store 原样存 | 全部指标按 tz 折本地日 | `usage-time.test.js` DST 用例；oracle 逐桶 diff |
| 2 | 总 TOKEN = `billable_total_tokens` | 汇总/排序一律用 `billable_total_tokens`；仅在未来引入 Cursor/Antigravity 的读取修复时才回退 `total_tokens`（MVP 3 工具不触发） | KPI/大字/明细「总计」 | store + query 单测；oracle |
| 3 | 输入 = 非缓存输入 | parser 保证；`input_tokens` 列 | 明细「输入」 | 3 工具 fixture 断言 |
| 4 | 缓存读/写分开 | `cached_input_tokens` / `cache_creation_tokens` 两列 | 明细只显示 cache read（同 TT）；区间汇总两列都进 totals | 同上 |
| 5 | 推理单列 | `reasoning_tokens` 列；不重复计费（MVP 无成本） | 明细「推理」 | 同上 |
| 6 | 成本 = 5 列 × 单价 | **已确认不做**；`summary.totals.total_cost_usd=null`，页面无美元行；未来若做需 vendor pricing + 查询时重算并标「估算」 | 总览第二行（未来） | 未来专项 oracle（token 整数一致、金额 ±0.01） |
| 7 | 对话数 = 解析事件数 | `conversation_count` 汇总 | KPI 第 4 格 | fixture 断言事件数 |
| 8 | 周期定义 | `usage-time.resolvePeriodRange()` 逐行复刻 TT `date-range.ts`；周=周一起 7 天；月=自然月；总计=最近 24 个月；自定义=B5 | tabs + 区间文案 | `usage-time.test.js` 边界/跨年/跨 DST |
| 9 | 每日明细列 | `usage:daily` 返回 7 个字段（不含 cache write/cost） | 明细表列定义 | 契约 fixture + e2e 列断言 |
| 10 | 热力图 52×7，level 相对四档 | `usage:heatmap` 做 max-relative 四档（≤25/50/75%）；B5 | 热力图（B5） | `usage-query.test.js` level 用例 |
| 11 | 趋势「预测」仅为视觉插值 | MVP 只画实测柱；B5 加缺失/未来桶的线性插值 + 0.98 衰减并标半透明 | 趋势（B5 细化） | 插值纯函数单测（B5） |
| 12 | 滚动 7/30 天 | `usage:summary` 返回 `rolling.last7d/last30d/avgPerActiveDay/activeDays` | KPI 前三格 | `usage-query.test.js` 滚动窗口用例 |

> 口径唯一权威来源：`TokenTracker/dashboard/src/lib/date-range.ts:49-91`（周期）与 `src/lib/local-api.js:203-261,2403-2469,2578-2639`（聚合/热力/滚动）。B0 里把这些函数逐行翻译成 `usage-time.js` / `usage-query.js` 并写固定用例。

### 1.3 本轮明确不做

- 金额/美元（已确认不做）；工具扩展超过首版 3 个（后续批次）；项目维度、会话洞察、性价比卡、分享/云/多设备/排行榜/成就；3D 热力图。
- Cursor、TRAE（SQLCipher）、TRAE Work CN（账号 API）→ 页面标「不支持」；不读任何凭据、不联网。
- 写 hook / 改任何被扫描工具的配置；WSL（命令行 `\\wsl$`）支持；Highlighter 自身 AI 调用的 token 统计（分析 §6.8，另立需求）。
- 实时（秒级）更新；首版只做「页面打开时增量 + 手动刷新」。

### 1.4 DoD（MVP 放行清单）

1. 3 工具（Codex/DSH/OpenCode）fixture 与 TokenTracker 对拍：每日/每来源/每模型 token **完全一致**（整数 0 误差）；`billable`/`total`/四列拆分一致。
2. 同一 fixture 连续扫两次：第二次新增桶 = 0；文件被重写后不重复计数（贡献扣减）。
3. 页面在默认窗口 1120×760 单栏可读；≥1272px 两栏；亮/暗主题、用户主色、圆角、紧凑模式全部生效。
4. 空/错误/未开启/扫描中/不可读/未安装/不支持 7 种状态齐备；扫描中 UI 不卡、可取消。
5. 启动路径**不做同步扫描**；首扫在 `utilityProcess`，页面打开才触发。
6. 数据目录切换演练不丢 usage 历史；「清除用量数据」生效。
7. 门禁全绿：`npm test`、`npm run check`、覆盖率 ≥85%、路由/图标/i18n/IPC/窗口安全/设计 token 契约测试、e2e 路由渲染。
8. 零新增 npm 运行时依赖；`docs/third-party/` 含 TokenTracker MIT 全文与来源/修改点说明。
9. 隐私验收：只读、只落计数、不落正文/路径全文、日志英文、诊断包不含 usage 数据。

---

## 2. 技术方案

### 2.1 进程与模块架构

```
配置窗口（渲染层，vanilla JS，无构建）
  config/routes/usage.js ── window.electronAPI.usage* ──┐
  shared/usage-format.js（UMD 纯格式化/日期显示）        │
                                                       ▼
IPC（ipc-security 白名单 + preload，main 角色）
  preload.js                             usage:status/refresh/summary/daily/hourly/breakdown/heatmap/clear
  main/ipc/usage-ipc.js                  参数校验 + 错误映射（薄层）
  main/services/usage-feature.js         组装根：惰性打开 store、注册 IPC、进度推送、app 生命周期钩子
        │
        ├── main/services/usage-collector.js   扫描编排：工具序、单飞、调度、进度、取消、提交
        │        │  fork（utilityProcess，参考 selection-hook-service.js:91-117）
        │        ▼
        │   main/usage-scan-worker.js          纯解析：发现文件 → 调 vendored parser → 返回变更
        │        └── main/vendor/tokentracker/（14 文件，MIT，去 Trae/Cursor/WSL/zstd fallback）
        │
        └── main/services/usage-store.js       SQLite 唯一写者：DDL/迁移/LWW/事务/保留/清除
                 │  node:sqlite（Electron 内置，零依赖）
                 ▼
         <dataRoot>/usage/usage.db（WAL）+ scan_state/source_status/app_meta

主进程查询（同步小查询，<50ms）：
  main/services/usage-query.js   summary/daily/hourly/breakdown/heatmap + 时区折算 + 结果 LRU
  main/services/usage-time.js    周期/本地日/DST/周起点（纯函数）
  main/services/usage-state.js   DB ⇄ parser 的 hourly 状态适配 + 变更/删除 diff
```

**职责边界（也是测试边界）**：

| 模块 | 职责 | 可测性 |
|---|---|---|
| `usage-time.js` | 周期→本地日期区间→UTC 边界；本地日/小时折 key；周起点；24 个月窗口 | 纯函数，node:test |
| `usage-store.js` | 打开/迁移/PRAGMA、状态载入、事务提交（桶 upsert + 删除 + 游标 + 状态）、保留/清除/统计 | 临时目录 + 真 SQLite |
| `usage-state.js` | 把 DB 行组装成 parser 需要的 `hourlyState`；`groupQueued` 种子；解析后 diff 删除键 | 纯函数 + fixture |
| `usage-tools.js` | 8 个工具的发现/调用适配器（表驱动 + 每工具薄函数） | 注入 fake home/fs |
| `usage-collector.js` | 单飞、状态机、进度节流、取消、崩溃恢复、调度 | 注入 fake worker/store |
| `usage-worker-client.js` | `utilityProcess.fork`、消息协议、超时/退出处理 | 注入 fake child |
| `usage-query.js` | 5 类聚合 + 缓存失效 | 真 SQLite fixture |
| `usage-ipc.js` | 8 通道参数校验/错误映射 | fake ipcMain（照 `test/history-ipc.test.js`） |
| `config/routes/usage.js` | 渲染/事件/状态/刷新 | 静态契约测试 + e2e（不做 jsdom） |
| `shared/usage-format.js` | 数字格式（1.5B/195.2M/万/亿）、百分比、tooltip 文案 | 纯函数，node:test |

### 2.2 扫描状态机与原子性（防重复计数的关键）

```
[idle] --usage:refresh(页面打开/手动)--> [discovering] -> [parsing tool i] -> [committing tool i] -> ... -> [done]
   ▲                                        │                 │                    │
   └──────────── cancel / worker crash ─────┴─────────────────┴── 当前工具结果丢弃，游标保持旧值
```

**一次工具扫描的提交协议（必须是单事务）**：

1. `usage-collector` 从 store 取该工具涉及的 `sources` 的 **hourly 状态**（`source|model|hour_start → totals`）与**游标 JSON**（`scan_state['cursors:<source>']`）。
2. 通过一条消息把 `{tool, files, cursors, hourly, queuePath, env}` 交给 worker（结构化克隆；若 P0 实测状态克隆 >200 ms/50 MB，改传临时 JSON 文件，见 §2.3 P0 实测）。
3. worker 调 vendored parser：parser 原地改 `cursors`/`hourly`，把变化行交给注入的 sink（内存数组）。
4. worker 回传 `{upserts: rows, removed: [keys], cursors, stats}`（大结果按 ≤2,000 行分片）。
5. 主进程**单事务**：`INSERT ... ON CONFLICT(source,model,hour_start) DO UPDATE`（LWW）+ `DELETE` removed + `INSERT OR REPLACE scan_state('cursors:<source>')` + `UPDATE source_status`；提交后递增 `dbVersion` 并清查询缓存。
6. 提交后才推进到下一个工具；worker 中途崩溃 = 该工具未提交，下次重扫（幂等）。

> 为什么不能「worker 直接写库」：桶行、hourly 状态、游标三者只要有一个先落盘就会在崩溃后重复计数或漏计。单事务提交是这套 parser 语义下唯一稳妥的路径。P0 若实测主进程提交阻塞明显（>50ms/事务），再评估把整个事务搬进 worker（见 §5 R2 备选）。

**触发与调度（MVP）**：页面 `renderUsage()` 且 `settings.usage.enabled` 时调用 `usage:refresh({reason:'page-open'})`；collector 做 5 分钟节流（`lastScanAt` + 文件未变则跳过）。启动路径不扫描。B5 再加「页面可见时 5 分钟定时 + focus 触发」。

### 2.3 解析层 vendor 策略

**vendor 集（B0 落地，约 14 文件 / 约 27.5k 行）**：`rollout.js`（25,966 → 删 Trae/Cursor 分支后约 25.4k）、`jsonl-lines.js`、`sqlite-reader.js`、`install-resolver.js`、`scan-roots.js`、`fs.js`、`claude-user-identity.js`、`codex-token-usage.js`、`codex-usage-record.js`、`codex-model-attribution.js`、`codex-service-tier.js`、`devin-usage.js`、`grok-usage.js` + **`wsl-probe.js` 替换为 stub**。

**改造清单（保持可追踪的最小 diff）**：

| # | 文件/位置 | 改造 | 理由/复核依据 |
|---|---|---|---|
| V1 | `rollout.js` 顶部 | 删 `require("./trae-db")`、`require("./trae-usage")`；删 `parseTraeIncremental`/`parseTraeCnApiIncremental` 及其 resolver/branch；删 `parseCursorApiIncremental` 与 `./cursor-config` 懒加载 | 首版不支持 Trae/Cursor；`cursor-config` 会读凭据/联网（复核：lazy require 于 `rollout.js:7572`） |
| V2 | `rollout.js:13136-13168`、`24087-24110` | 删 `@mongodb-js/zstd` fallback，只留 `zlib.zstdDecompressSync` | 复核：Electron Node 24.18 内置 zstd 实测可用；闭包唯一 npm 依赖 |
| V3 | `rollout.js` sink | `enqueueTouchedBuckets` 内部改：先构造 row 对象数组，再 `if (sink) await sink(rows) else await fs.appendFile(queuePath, JSON.stringify...)`；新增 `setBucketSink()`；`module.exports` 增加 `setBucketSink, bucketKey, groupBucketKey, totalsKey, normalizeHourlyState, toUtcHalfHourStart` | 46 个 parser 的 46 处调用点不变，只改 1 个函数（`:3513-3830`）；`enqueueTouchedProjectBuckets` 同法（MVP 不启用项目维度） |
| V4 | `sqlite-reader.js` | 删除外部 `sqlite3` CLI 分支，固定 `node:sqlite`（`readOnly:true`），保留 busy/超时/快照读取逻辑 | 复核：CLI 优先分支在 Electron 无 PATH 保障（`sqlite-reader.js:35`） |
| V5 | `wsl-probe.js` | 替换为 12 行 stub：`shouldProbeWsl:()=>false`、`shouldProbeNative:()=>true`、`discoverWslHome:()=>null`、`isUncPath:()=>false` 等（B0 用 `grep -o "wsl\\.[A-Za-z]*"` 枚举被调 API） | 复核：真文件会同步 `spawn wsl.exe`（`:28`）；首版明确关闭 WSL |
| V6 | `scan-roots.js` | 删除 `~/.tokentracker/tracker/config.json` 读取；保留 `expandHome`/`scanRootDirState`/`realpath` 去重 | 复核：`:258-259`；Highlighter 首版不提供自定义扫描根 UI |
| V7 | `tracker-paths.js` / `cursor-config.js` / `trae-*` | 不 vendor（已删依赖） | 减少维护面 |
| V8 | 所有 vendored 文件头 | `// Vendored from TokenTracker v1.4.7 (148b758e, MIT) — see docs/third-party/LICENSE-TokenTracker.txt` | MIT 义务 + 上游同步 |
| V9 | `module.exports` | 只保留解析闭包需要的导出；删除未用导出（避免误用） | 缩小 API 面 |

**上游测试资产**：`test/*parser*.test.js` + `rollout-parser.test.js`（共 31 文件 / 52,117 行 / 1,013 tests）不并入默认 `npm test`（太慢且会拉高门禁时长），放 `main/vendor/tokentracker/test/`，用独立脚本 `npm run test:usage-parsers` 跑；CI 可选。**必跑子集**：8 个首版工具的 parser 测试文件 + 自建 fixture 用例。

**P0 实测项（B0-3，决定 S2/S3 是否成立）**：
1. 真实 Electron 下 `utilityProcess.fork` 加载 vendored `rollout.js`（asar 内外路径）并解析一个 fixture；记录冷启动耗时。
2. 主进程 ⇄ worker 一次性下发 3 工具 state 的消息大小/耗时（本机估算 5–15 MB）；若 clone >200 ms 或 >50 MB，改「临时 JSON 文件 + worker 读取」。
3. 主进程 `node:sqlite` 单事务提交 2,000 行耗时；目标 <30 ms。
4. `npm run build:win` 打包后 `node:sqlite` 与 `utilityProcess.fork` 冒烟（只需一次，证明打包路径）。

### 2.4 工具注册表与适配器

注册表 **3 条（已确认首版范围）**；其余工具（Claude/Gemini/Kimi/Qoder/Copilot 等）沿用同一适配器模式，作为后续扩展批次（不在本次交付）：

| source | 发现 | parser 调用 | 备注（复核行号） |
|---|---|---|---|
| `codex` | `listRolloutFiles(~/.codex/sessions)`（`CODEX_HOME` 覆盖） | `parseRolloutIncremental({rolloutFiles, cursors, queuePath, source})` | **B1 垂直切片（风险最高）**：本机 420 MB/300 文件、单文件最大 40 MB；累计快照差量 + 冷扫过滤（`:91-976,322`） |
| `dsh` | `resolveDshSessionFiles(env)` | `parseDshIncremental({sessionFiles, cursors, queuePath})` | 本机 70 MB/141 个 `.zstd`（多帧）；parser 无 env 参数，文件列表必须外部解析（`:23908/24705`） |
| `opencode` | `readOpencodeDbMessagesIncremental(dbPath, prevCursor)` | `parseOpencodeDbIncremental({dbMessages, dbPath, dbCursor, cursors, queuePath, source, cursorKey})` | 本机 `opencode.db` 754 MB；只读打开需处理 WAL/`SQLITE_BUSY`（`:5528/6105`） |

**统一适配器签名**（`usage-tools.js`）：

```js
// 每个工具一条；scan 返回 { files, stats }；解析输出经 sink 已进入 collector
{ source, labelKey, priority, unsupported?, async scan({ homeDir, env, paths, cursors, hourly, queuePath, sink, onProgress, signal }) }
```

**发现/可读性**：每工具根先做 `scanRootDirState` 式探测，`state` 取值 `ok | empty | unreadable | absent | error`；`ENOENT`=未安装、`EACCES/EPERM`=不可读（不能当空）；skip symlink/junction；`realpath` 去重。所有扫描只读（`open('r')`/`readOnly:true`），绝不写用户目录。

**环境**：`env = { ...process.env, TOKENTRACKER_WSL_MODE: 'native-only' }`；`homeDir` 默认 `app.getPath('home')`，测试/e2e 用注入值（`HIGHLIGHTER_USAGE_HOME`，B1 实现）。

### 2.5 存储设计（SQLite，node:sqlite）

`<dataRoot>/usage/usage.db`（WAL；`<dataRoot>/usage/runtime/queue.jsonl` 仅作 parser 的 `queuePath` 占位，不落内容）：

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 3000;
PRAGMA user_version = 1;

CREATE TABLE IF NOT EXISTS usage_bucket (
  source                 TEXT NOT NULL,
  model                  TEXT NOT NULL,
  hour_start             TEXT NOT NULL,               -- 'YYYY-MM-DDTHH:MM:00Z'（半小时桶）
  input_tokens           INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens    INTEGER NOT NULL DEFAULT 0,  -- cache read
  cache_creation_tokens  INTEGER NOT NULL DEFAULT 0,  -- cache write
  output_tokens          INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens       INTEGER NOT NULL DEFAULT 0,
  total_tokens           INTEGER NOT NULL DEFAULT 0,
  billable_total_tokens  INTEGER NOT NULL DEFAULT 0,
  conversation_count     INTEGER NOT NULL DEFAULT 0,
  total_cost_usd         REAL NOT NULL DEFAULT 0,     -- v1 不填充（B6 定价后使用）
  usage_precision        TEXT,                        -- NULL | 'estimated'
  updated_at             TEXT NOT NULL,
  PRIMARY KEY (source, model, hour_start)
);
CREATE INDEX IF NOT EXISTS idx_usage_hour        ON usage_bucket(hour_start);
CREATE INDEX IF NOT EXISTS idx_usage_source_hour ON usage_bucket(source, hour_start);
CREATE INDEX IF NOT EXISTS idx_usage_model_hour  ON usage_bucket(model, hour_start);

CREATE TABLE IF NOT EXISTS scan_state   (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS source_status(source TEXT PRIMARY KEY, state TEXT NOT NULL, detected INTEGER NOT NULL DEFAULT 0,
                                          readable INTEGER NOT NULL DEFAULT 0, last_scan_at TEXT, last_error TEXT,
                                          detail TEXT, coverage_start_at TEXT, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS app_meta     (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

- **LWW**：`INSERT ... ON CONFLICT(source,model,hour_start) DO UPDATE SET <all cols>=excluded.*`；桶行是 parser 给出的**绝对累计快照**，与 TT queue 读取语义一致。
- **单事务提交**：§2.2 第 5 步；`PRAGMA user_version` 逐版本幂等 DDL；升级走事务。
- **保留**：常量 `RETENTION_MONTHS = 24`；每次成功扫描后 `DELETE WHERE hour_start < cutoff`；DB >64 MB 时按月清理最旧；提供 `usage:clear`（停 worker、关连接、删除 `usage/`、重建空库）。
- **查询**：只按 UTC 范围预筛，本地日折算在 JS 侧用 `Intl.DateTimeFormat`（逐小时键），避免固定 offset 在 DST 日错位；结果 LRU（key=`{view,period,tz,from,to,scope}` + `dbVersion`，TTL 60s，提交后清空）。
- **数据目录迁移**：`usage` 目录加入 `MANAGED_DIRECTORIES`；迁移前 `usage-feature.quiesce()`（`wal_checkpoint(TRUNCATE)` + `close()`），迁移后重启由新根打开；不得只复制 `.db` 而漏 `-wal/-shm`（`docs/plans/2026-10-17-clipboard-implementation-plan.md:648` 的既有结论）。
- **为什么不用 JSON rollup**：任意区间/来源/模型的 SQL 聚合 + 24 个月数据量下内存可控；`node:sqlite` 零打包成本（分析 D3 = A）。接口封装在 `usage-store.js` 后，若打包实测有问题可退化为 JSON rollup（D3 = B）。

### 2.6 聚合查询与口径实现

| 函数 | 输入 | 输出（页面契约） | 实现要点 |
|---|---|---|---|
| `resolvePeriodRange({period, now, tz, from, to})` | 周期 + tz + “今天” | `{fromDay, toDay, fromUtcMs, toUtcMs}` | 复刻 TT `date-range.ts:49-91`；周=周一 00:00 起 7 天；总计=最近 24 个月；`zonedDayStartUtcMs` 用两趟 offset 求解（DST 安全） |
| `getSummary` | store + range | `totals` + `rolling` | SQL `SUM(...)` over UTC 区间；rolling 以本地今天为终点独立计算；`activeDays`=有量天数 |
| `getDaily` | store + range | 每日 7 列（含补零日） | SQL `GROUP BY hour_start`（24 个月 ≤17,520 行）→ JS 按本地日聚合 |
| `getHourly` | store + 本地日 | 24 小时序列 | 本地日→UTC 区间（DST 日 23/25h）；fall-back 重复小时求和 |
| `getBreakdown` | store + range + scope | `sources[]` / `models[]` + `sharePct` | SQL `GROUP BY source, model`；模型数/占比；`total_cost_usd=null`（MVP） |
| `getHeatmap` | store + tz + weeks(52) | `weeks[][]` + `activeDays` + `level` | 最大值为基准四档（TT `local-api.js:2598-2605`）；**列首固定周一**（S5，记录与 TT `week_starts_on:"sun"` 的差异） |

**性能预算**：24 个月全区间查询 P95 <100 ms（本机 10 万桶级）；`usage:daily` 24 个月 ≤17,520 行聚合；首页 4 个查询并发 <300 ms。超预算时优先把 `getDaily` 改成 SQL 侧固定 offset 近似 + DST 日回退 JS（不默认启用）。

### 2.7 IPC 契约（B0 冻结，页面/引擎并行开发的依据）

8 个 handle 登记 `IPC_SURFACES.main.handles`，preload 一一对应；`usage:scan-progress` 是主→渲染广播，**不登记 `IPC_SURFACES`、不注册 `ipcMain.on`**（同 `app:navigate`/`history:changed` 惯例）。参数一律在主进程校验（`usage-ipc.js`），且 8 个 `ipcMain.handle('usage:*')` 必须写成字面量（`test/ipc-security.test.js` 用正则扫描注册）。

| 通道 | 参数 | 返回 |
|---|---|---|
| `usage:status` | — | `{enabled, scanning, scan, lastScanAt, lastError, dbBytes, retentionMonths, sources:[{source,label,state,detected,readable,files,lastScanAt,lastError,coverageStartAt,estimated}]}` |
| `usage:refresh` | `{reason?: 'page-open' \| 'manual'}` | `{started:boolean, scanId?:string}`（单飞：已在扫返回 `started:false` + 当前 scanId） |
| `usage:summary` | `{period, tz, from?, to?}` | `{period, from, to, tz, totals:{...}, rolling:{last7d,last30d,avgPerActiveDay,activeDays}, pricing:{mode:'none'\|'seed', version:null\|string}}` |
| `usage:daily` | `{period, tz, from?, to?}` | `{from, to, rows:[{day,total_tokens,billable_total_tokens,input_tokens,output_tokens,cached_input_tokens,reasoning_output_tokens,conversation_count,total_cost_usd}]}` |
| `usage:hourly` | `{day:'YYYY-MM-DD', tz}` | `{day, from, to, rows:[{hour,billable_total_tokens,total_tokens,input_tokens,output_tokens,conversation_count,total_cost_usd}]}` |
| `usage:breakdown` | `{period, tz, from?, to?, scope:'source'\|'model'}` | `{scope, from, to, totals, sources[], models[]}` |
| `usage:heatmap` | `{tz, weeks?:52}` | `{from, to, weekStartsOn:'mon', weeks:[[{day,value,level,total_tokens,conversation_count}\|null]], activeDays, max}` |
| `usage:clear` | — | `{ok:true, clearedAt}` |
| `usage:scan-progress`（推送，主→渲染） | — | `{scanId, phase, tool, toolIndex, toolCount, filesDone, filesTotal, bytesRead, buckets, startedAt, done}`（≤4 次/秒节流）。**不登记 `IPC_SURFACES`、不注册 `ipcMain.on`**：它是 `webContents.send` 广播，和 `app:navigate`/`history:changed` 同惯例；登记进 listeners 会让 `assertComplete()` 启动即抛 |

**参数校验**：`period ∈ {day,week,month,total,custom}`（MVP 不含 custom，通道仍校验）；`tz` 用 `Intl.DateTimeFormat` 探测，非法回落 `UTC`；`from/to` 为 `YYYY-MM-DD` 且 `from<=to`、跨度 ≤800 天；`weeks` 1..52；所有字符串长度受限。**错误约定**：非法参数/查询失败 `throw Error('usage: ...')`（英文）→ invoke reject → 页面错误态 + 重试；扫描失败不 reject，写入 `source_status` 由 `usage:status` 暴露。

**Mock fixture**（B0 定义、B3 落地）：`test/fixtures/usage/ipc/{status,summary,daily,hourly,breakdown,heatmap}.json` —— 同时用于页面开发（B4 无引擎时可跑）、IPC 单测、e2e 断言。

### 2.8 页面方案（Nightshift 语言重画）

**路由**：`usage`，侧栏「工具设置」组（`selection-toolbar` 之后），标题 `config.route.usage`。渲染函数 `renderUsage()` 支持重复执行（语言热切换会重建），异步结果用 `currentRoute === 'usage'` + 渲染版本号双守卫（照 `history.js:13-42`）；不得叠加 document 级监听。

**DOM 结构（单栏；≥1272px 两栏）**：

```html
<div class="page usage-page">
  <div class="page-head">标题 + 副标题 + 刷新按钮</div>
  <div class="usage-coverage" id="usageCoverage">…状态条（常驻）…</div>
  <div class="tabs usage-tabs" role="tablist">日 / 周 / 月 / 总计</div>
  <div class="usage-stats">4 × KPI（7天 / 30天 / 日均 / 对话数）</div>
  <div class="usage-main">
    <section class="card usage-overview">大字 billable + 区间 + 来源分段条</section>
    <section class="card usage-breakdown">来源卡网格 + 模型 Top N 细条</section>
    <section class="card usage-trend">近 30 天堆叠柱 + tooltip</section>
    <section class="card usage-daily">每日明细表</section>
  </div>
</div>
```

**自绘规则（不引图表库）**：
- 来源分段条：单 flex 容器 + 百分比宽度的 `div`，颜色 `color-mix(in srgb, var(--primary) X%, var(--surface-3))` 生成同主色系梯度（不同来源用不同比例/透明度，不引入第二套品牌色）。
- 模型细条：3px 高 `div` + `--primary-soft/--primary`。
- 趋势柱：每日一列竖向 flex，堆叠输入/缓存/输出三档主色（`--primary` / `--primary-soft` / `--surface-3`）；hover 绝对定位 tooltip，边界翻转；`aria-label` 提供完整数字。
- 数字：`--font-mono` + `tabular-nums`；紧凑格式 `1.5B/195.2M`、中文 `万/亿`（由 `getLanguage()` 决定）；tooltip/长按显示全量千分位。
- 表格：行高 36–40px、数字右对齐、`sticky` 表头、`aria-sort`；空列显示 `-`。
- 主题：只消费 token；`body.dark`/`body.compact` 双主题；不硬编码色值（`test/design-tokens.test.js` 约束）。

**CSS 预算**：`config/config.css` 新增 `.usage-*` 约 250–320 行（KPI 复用 `.history-stats` 的视觉参数、tabs 复用 `.tabs`、卡片复用 `.card`、空态复用 `.empty`）；断点：默认单栏，`@media (min-width: 1272px)` 两栏（左 4/12 KPI+趋势，右 8/12 总览+占比+明细）。

**i18n**：`shared/locales/config.js` 新增 `config.route.usage` + `config.usage.*` 约 80–100 key × 3 语言（标题/tabs/KPI/列名/来源名/覆盖状态/空态/错误/未开启/估算角标/清除确认）。日期/数字用 `Intl`（locale 由 `getLanguage()` 提供），不拼中文。

**页面纯函数**：`shared/usage-format.js`（UMD：`formatCompactToken/formatFullToken/formatSharePct/formatRangeLabel/formatTooltip`），`node --test` 直接 require；`config.html` 在 `routes/usage.js` 之前加载。**不加入** `window.configShared`（避免改 `test/config-routes.test.js:96-113` 的精确清单）。

**7 种状态**：未开启（首次同意卡：只读说明 + 「开启统计」按钮 + 隐私一句）、扫描中（顶部细进度条 + 已提交工具数）、空态（未检测到任何工具 + 支持列表 + 路径说明）、错误（banner + 重试）、不可读（状态条单独列出）、未安装、不支持（Cursor/Trae 固定行）。**覆盖状态常驻**，避免「页面为空=功能坏了」。

### 2.9 门禁适配（逐项，实施时按此核对）

| # | 门禁 | 现状/余量 | 本方案动作 |
|---|---|---|---|
| G1 | `main.js` ≤1330 行 | 1324（门禁口径），余 6 | **+1 行**：`require('./main/services/usage-feature').install({ ipcMain: secureIpcMain, app, getPaths: () => activePaths, getMainWindow: () => mainWindow, getSettings, log })`；插在 `secureIpcMain` 创建后、`assertComplete()` 前。若评审坚持常规模块结构可放宽到 2 行（require+call），仍在余量内 |
| G2 | IPC 白名单 ↔ 注册精确对账 | `IPC_SURFACES.main.handles` 102 条 + 2 listeners | `handles` +8、listeners 不变；`preload.js` +8 invoke +1 on（on 仅渲染侧监听）；`main/ipc/usage-ipc.js` 用**字面量** `ipcMain.handle('usage:*')` 写 8 行（policy 测试按正则扫描）；漏一启动即抛（`ipc-security.js:326-331`） |
| G3 | data-root 目录/迁移 | `createDataPaths` 12 键；`MANAGED_DIRECTORIES` 7 项 | `createDataPaths` +`usage`；`MANAGED_DIRECTORIES` +`'usage'`；`test/data-root.test.js:52/114`、`test/data-root-migration.test.js:103-124` 同步；`stopManagedDataWriters()` 里加 `usageRuntime.quiesce()` |
| G4 | 设置模板 | `DEFAULT_SETTINGS` 即校验白名单（`settings-validation.js:23-34`） | 加 `usage: { enabled: false }` + `settings-normalize.js` 布尔归一；不新增 retention 设置（常量 24 个月） |
| G5 | i18n | CJK 未迁移行 585/606（余 21） | 新代码（`main/**`、`config/**`）注释/日志/抛错全英文；文案只进 `shared/locales/config.js`（不计入 CJK 余量） |
| G6 | 覆盖率 | 全局行 85%（`main/services/**`、`main/ipc/**` 自动纳入） | 新增 `main/services/usage-*.js` 全部带单测；`shared/usage-format.js` 加入 `test:coverage:loaded` 的 `--include` 列表，保证被测 |
| G7 | 路由/图标契约 | `routes` 12 条、导航图标精确 12、磁盘 route 文件 ↔ HTML 引用集合相等 | `routes`/`routeTitles` +1；`config.html` 导航 +1 + script +1；`config/icons/usage.svg` 新建；`test/config-icon-contract.test.js:33` 12→13；`test/config-routes.test.js` 自动覆盖 |
| G8 | e2e | `e2e/highlighter.spec.js:108-128` 11 条路由清单 | 追加 `['usage','用量','.usage-page']`；扫描用 fixture home（`HIGHLIGHTER_USAGE_HOME`），不碰真实用户目录 |
| G9 | CSP/窗口安全 | `connect-src 'none'`、无内联 script | 页面只走 IPC；`<script src>` 顺序：locales → `shared/usage-format.js` → `routes/usage.js`（都在 `config.js` 前） |
| G10 | 设计 token | 禁硬编码 `--primary/--bg`、派生 token 双声明 | 新 CSS 只用 `var(--...)`；如需新增 chart token，在 `tokens.css` 的 `:root` 与 `body.dark` 双声明并补 `test/design-tokens.test.js` |

---

## 3. WBS、排期与并行

### 3.1 批次总览

| 批次 | 主题 | 主要产出 | 人日 | 放行 gate |
|---|---|---|---|---|
| B0 | 口径与移植基线 | 契约冻结（§2.5/2.7/2.8）；vendor 闭包 + 许可；oracle 脚本；P0 spike 结论 | 4.5–5 | M0：3 工具 fixture 对拍 0 误差；P0 四项结论记录 |
| B1 | 单工具垂直切片 | store/state/worker/feature/最小 IPC + `codex` 适配 + 最小页面挂载 | 5–6 | M1：本机 `~/.codex` 真实数据出数 |
| B2 | 三工具引擎 | 其余 2 工具（DSH/OpenCode）、注册表、增量/重写/取消/单飞、data-root/设置、进度 | 6.5–7.5 | M2：3 工具状态正确；二次扫描 0 桶；重写不重复；崩溃可恢复 |
| B3 | 查询与 IPC 完整 | `usage-time`/`usage-query`/`usage-ipc` 全通道 + LRU + 性能 | 4–5 | M3a：契约 fixture 全绿；与 oracle 聚合一致；P95 <100ms |
| B4 | 主视图页面 | 路由/导航/i18n/主题/状态 + KPI/总览/占比/趋势/明细 + e2e | 7–9 | M3：MVP 全 DoD |
| B5 | 完整度 | 2D 热力图、日视图小时、自定义区间、覆盖细化、明细展开 | 4.5–5 | M4：对齐截图主体（除 3D/金额/项目） |
| B6 | 发布收尾 | 打包与运行时验收、数据目录演练、性能/体积终验、许可与文档、全量门禁 | 5–5.5 | M5：全量 DoD（3 工具、无金额/工具扩展） |

> 合计：**MVP = B0–B4（27–32 人日）；本次完整交付 = B0–B6（36–42 人日）**。批次人日为单人估算（含自测，不含评审/设计确认等待）。

### 3.2 任务清单（可直接作为 Team Task 看板）

> 写作用域为建议值；同一批次内 `engine` 与 `page` 两条线尽量不重叠。

| ID | 任务 | 写作用域（建议） | 依赖 | 人日 | 验收 |
|---|---|---|---|---|---|
| B0-1 | 冻结契约（本文 §2.5/2.7/2.8）+ fixture JSON 结构 | `docs/plans/` | — | 0.5 | 评审通过；fixture 字段与通道一一对应 |
| B0-2 | vendor 14 文件 + V1–V9 改造 + 许可头 + 依赖审计 | `main/vendor/tokentracker/**`、`docs/third-party/**` | B0-1 | 1.5 | 纯 Node 下 require 不联网/不 spawn；3 工具 parser 冒烟可跑 |
| B0-3 | P0 spike（worker/消息体积/事务耗时/打包冒烟） | `scripts/`（临时探针，不入产品） | B0-2 | 1.0 | 4 项实测数字 + S2/S3 结论；若否，按 §5 R2 切换备选 |
| B0-4 | oracle 基线：TT scratch 安装 + fixture home + 对拍脚本 + golden | `scripts/usage-oracle-check.js`、`test/fixtures/usage/**` | B0-2 | 1.5 | 3 工具逐桶一致；脚本可重复执行 |
| B1-1 | `usage-store`：DDL/迁移/LWW upsert/状态载入/事务/保留/清除/close/checkpoint | `main/services/usage-store.js`、`test/usage-store.test.js` | B0-1 | 1.5 | 临时库用例全绿；事务原子性用例（模拟抛错回滚） |
| B1-2 | `usage-state`：DB 行→parser hourlyState、groupQueued 种子、删除 diff | `main/services/usage-state.js`、`test/usage-state.test.js` | B1-1 | 0.8 | 载入/回写/删除用例；与 TT queue 语义等价 |
| B1-3 | worker + 客户端协议：fork、消息、进度、取消、退出处理 | `main/usage-scan-worker.js`、`main/services/usage-worker-client.js` | B0-3,B1-2 | 1.0 | fake child 单测；真实 Electron 冒烟 |
| B1-4 | `codex` 适配器 + 发现/可读性状态 | `main/services/usage-tools.js` | B1-2 | 0.5 | fixture home 出桶；未安装/不可读状态正确 |
| B1-5 | feature 组装 + 最小 IPC（status/refresh/summary）+ preload + 白名单 + `main.js` 1 行 | `main/services/usage-feature.js`、`main/ipc/usage-ipc.js`、`preload.js`、`main/services/ipc-security.js`、`main.js` | B1-3 | 0.7 | 启动 `assertComplete` 通过；通道可调用 |
| B1-6 | 最小页面挂载：路由/侧栏/图标/script + 数据区（临时样式） | `config/routes/usage.js`、`config/config.html`、`config/config.js`、`config/icons/usage.svg` | B1-5 | 0.5 | e2e 可点开、`#view` 非空；M1 demo |
| B2-1 | 其余 2 工具适配器（dsh/opencode） | `main/services/usage-tools.js`、`test/usage-tools.test.js` | B1-4 | 1.5 | 每工具 fixture 出桶；状态/错误处理正确 |
| B2-2 | 注册表 + 根发现 + 状态汇总（3 工具） | `main/services/usage-tools.js`、`main/services/usage-collector.js` | B2-1 | 1.0 | 状态机单测；`source_status` 形状稳定 |
| B2-3 | 增量正确性：offset/贡献/重写/截断/锁/单飞/取消 | `main/services/usage-collector.js`、`main/services/usage-worker-client.js` | B2-2 | 2.0 | 二次扫描 0 桶；重写不重复；取消后一致 |
| B2-4 | 触发与节流（页面打开/手动；5min 节流） | `main/services/usage-collector.js` | B2-3 | 0.5 | 节流用例；不阻塞页面 |
| B2-5 | data-root/设置/清理：`createDataPaths`、`MANAGED_DIRECTORIES`、quiesce、`usage.enabled` | `main/services/data-root.js`、`main/services/data-root-migration.js`、`main/domains/data-root/index.js`、`main/services/settings-*.js` | B1-5 | 1.0 | 迁移/清理测试；设置 patch 通过校验 |
| B2-6 | 编排测试（状态机/进度/恢复/节流） | `test/usage-collector.test.js` | B2-3 | 1.0 | 覆盖率达标；无真实 home 依赖 |
| B2-7 | 性能首测：本机 3 GB 数据（codex 420 MB + opencode 754 MB + dsh 70 MB）冷扫 + 增量计时 | `scripts/`（报告写入本文附录） | B2-3 | 0.5 | 有基线数字；识别瓶颈 |
| B3-1 | `usage-time`：周期/本地日/DST/周起点/24 个月窗口 | `main/services/usage-time.js`、`test/usage-time.test.js` | B0-1 | 1.0 | Asia/Shanghai + America/New_York DST 用例 |
| B3-2 | `usage-query`：5 类聚合 + 补零 + 占比 + level + LRU | `main/services/usage-query.js`、`test/usage-query.test.js` | B3-1,B1-1 | 2.0 | golden fixture 全绿；与 oracle 一致 |
| B3-3 | `usage-ipc`：8 通道校验/错误映射/注册 | `main/ipc/usage-ipc.js`、`test/usage-ipc.test.js` | B3-2 | 0.8 | 参数矩阵用例；通道顺序断言（照 history-ipc） |
| B3-4 | 查询性能 + 缓存失效测试 | `test/usage-query.test.js` | B3-2 | 0.7 | P95 <100ms（10 万桶）；提交后缓存失效 |
| B4-1 | 路由/导航/i18n/主题/状态框架（骨架/空/错误/未开启/扫描中） | `config/routes/usage.js`、`config/config.css`、`shared/locales/config.js` | B0-1,B1-6 | 1.5 | 7 状态可切换；语言热切换重渲染正常 |
| B4-2 | KPI 4 列 + 总览大字 + 周期 tabs | 同上 | B4-1,B3-3 | 1.5 | 数据与 fixture 一致；tooltip 全量 |
| B4-3 | 来源卡网格 + 分段占比条 + 模型 Top N | 同上 | B4-1,B3-3 | 1.0 | 占比 100% 合计；空来源隐藏 |
| B4-4 | 趋势堆叠柱 + tooltip（近 30 天） | 同上 + `shared/usage-format.js` | B4-1,B3-3 | 1.2 | 柱高与数据一致；边界翻转 |
| B4-5 | 每日明细表（排序/分页/补零） | 同上 | B4-1,B3-3 | 1.0 | 列与 TT 一致；数字右对齐 mono |
| B4-6 | CSS 收口：compact/两栏断点/焦点态/暗色 | `config/config.css`、`test/design-tokens.test.js`（如需） | B4-2..B4-5 | 1.2 | 1120/1272/最小窗口三档截图检查 |
| B4-7 | e2e + 集成 + fixture home | `e2e/highlighter.spec.js`、`test/fixtures/usage/**`、`main/services/e2e-bootstrap.js`（home 注入） | B1-6,B3-3 | 1.0 | e2e 路由渲染 + 周期切换 + 未开启态；不访问真实 home |
| B5-1 | 2D 热力图（CSS grid + 月刻度 + tooltip） | `config/routes/usage.js`、`config/config.css` | B4 | 1.2 | level 与 TT 一致；周一列首 |
| B5-2 | 日视图小时序列（24 点柱） | 同上 | B4,B3-2 | 0.8 | DST 日 23/25h 处理 |
| B5-3 | 自定义区间（两个原生 date input） | 同上 | B4 | 0.8 | 校验/未来日期禁用 |
| B5-4 | 覆盖状态细化 + estimated 角标 | `config/routes/usage.js`、locale | B4 | 0.5 | 3 工具 5 类状态 |
| B5-5 | 模型/来源明细展开 + 空态细节 | `config/routes/usage.js` | B4 | 1.0 | 展开/收起无重复请求 |
| B5-6 | 性能/内存调优（首扫预算、状态载入、查询缓存） | `main/services/usage-*.js` | B5 | 0.7 | 冷扫可取消；增量 <1.5s |
| B6-1 | 后续工具扩展接口预留（README + 适配器模板说明，不实现） | `main/services/usage-tools.js`、`docs/` | B5 | 0.3 | 文档说明新增工具步骤；不改运行行为 |
| B6-2 | 最终性能/体积验收（首扫/查询/DB 体积/内存） | `scripts/`、本文附录 F | B5 | 0.8 | 指标达标并记录 |
| B6-3 | 打包与运行时验证（node:sqlite/utilityProcess/asar） | `scripts/verify-release.ps1`（如需）、e2e | B2 | 1.2 | 安装版冒烟通过 |
| B6-4 | 数据目录迁移演练（含 WAL checkpoint） | 测试/文档 | B2-5 | 0.8 | 切换目录不丢历史；回滚干净 |
| B6-5 | 保留/清除/诊断包排除 | `main/services/usage-store.js`、`main/services/diagnostics-service.js` | B1-1 | 0.5 | 清除生效；诊断包不含 usage |
| B6-6 | 文档/许可/发布说明 | `docs/third-party/**`、`README.md` | B0-2 | 0.7 | MIT 全文 + 上游 commit + 修改点 |
| B6-7 | 最终门禁与发布检查 | — | 全部 | 0.8 | DoD 全绿 |

### 3.3 并行策略与关键路径

```
B0-1 契约 ──┬─► B0-2 vendor ─► B0-3 spike ─► B1(engine) ─► B2 ─► B3 ─┬─► B5 ─► B6
            │                                                         │
            └─► (页面线) B4-1 静态框架 + mock fixture ─► B4-2..B4-7 ───┘（B3 完成后接真实 IPC）

关键路径：B0-2 → B0-3 → B1-3 → B2-3 → B3-2 → B4-2..B4-5 → e2e → 门禁
```

- **单人**：建议顺序 B0→B1→B2→B3→B4→B5→B6（页面在 B4 集中做），MVP 约 6–7 周。
- **双人**：B0 由 Lead/数据负责人收口；B1/B2/B3 与 B4（用 §2.7 mock）并行；B2 结束做首次集成（一天），B3 结束做第二次集成（半天）。日历约 4–4.5 周（与 §0.2 一致）。
- **Agent Teams 映射**：engine 线（B0-2/3/4、B1-1/2/3/4/5、B2、B3、B6-1/2/4）、page 线（B1-6、B4、B5-1..4、B6-6 文案）、QA 线（B0-4、B2-6、B3-4、B4-7、B6-3/5/7）。契约文件（本文 §2.5/2.7）与 `main.js`/`ipc-security.js`/`data-root*`/`preload.js` 等共享文件由 Lead 串行收口。

### 3.4 里程碑 Demo 与放行

| 里程碑 | Demo（给用户看） | 放行标准 |
|---|---|---|
| M0 | 终端里「Highlighter vs TokenTracker」逐桶/逐日对照表 | 3 工具 0 误差；P0 结论写入本文附录 || M1 | 设置窗打开「用量」页，KPI/明细显示真实 Claude Code 数据（样式未收口） | 无崩溃；数据与 TT 一致 |
| M2 | 3 工具（Codex/DSH/OpenCode）覆盖状态 + 扫描进度 + 刷新；第二次打开秒开 | 增量/重写/取消/崩溃测试全绿 |
| M3 | 完整主视图（默认窗口 + 最大化），亮暗主题 | §1.4 DoD 1–9 |
| M4 | 热力图 + 日/周/月/总计/自定义（3 工具） | 与截图区块 90% 对应（除 3D/金额/项目） |
| M5 | 安装包实测 + 3 工具 + 全门禁（无金额/工具扩展） | §1.4 DoD 全量 + 打包验收 |

### 3.5 延期时的降级顺序（从后往前砍）

1. 自定义区间（B5-3）→ 2. 日视图小时序列（B5-2）→ 3. 热力图（B5-1）→ 4. 明细展开（B5-5）→ 5. 模型 Top N 细节。**页面主视图（KPI/总览/来源/趋势/明细）与 3 工具引擎不可砍**。

---

## 4. 测试与验证策略

### 4.1 口径对拍（最高优先级，B0 起持续跑）

三层，从强到弱：

1. **一次性 TT CLI 全量对拍（开发机，人工/脚本）**
   - 用 scratch 安装（不污染产品依赖）：`D:\workspace\_tt-oracle` 下 `npm i tokentracker-cli@1.4.7`（`--ignore-scripts` 也可，解析层只用 `node:zlib`）；或直接在 `TokenTracker` checkout `npm i --ignore-scripts` 后 `node bin/tracker.js sync`。
   - 固定 fixture home：把真实日志的**脱敏子集**（每工具 1–3 个文件）复制到 `test/fixtures/usage/home/**`，用 `USERPROFILE=<fixtureHome>` 跑 TT `sync`，得到 `~/.tokentracker/tracker/queue.jsonl`。
   - Highlighter 用同一 fixture home 跑扫描（`HIGHLIGHTER_USAGE_HOME`），把结果与 queue 逐桶比较：`(source,model,hour_start)` × 9 个 token 列，容差 0；金额（B6）±0.01。
   - 本机无现成 `~/.tokentracker/tracker`（只有 `cache/pricing.json`），所以这一步必须自建。
2. **Golden JSON（CI 默认）**：一次对拍通过后，把「预期桶行 + 预期 summary/daily/breakdown/heatmap」提交为 `test/fixtures/usage/golden/*.json`；CI 不需要 TT。
3. **真实 home 只做计时/冒烟（不进 CI）**：在本机 3 GB 日志上记录冷扫/增量耗时与内存（B2-7），结果写回本文附录。

**Fixture home 与 oracle 隔离要点（B0-4 实测）**：TT CLI 不只看 `~`，还会读 `%APPDATA%`/`%LOCALAPPDATA%`（首轮曾把本机 codebuddy/reasonix 行带进 queue）。因此 oracle harness 在跑 TT `sync` 时必须把 `USERPROFILE`、`HOME`、`APPDATA`、`LOCALAPPDATA` 全部重定向到 fixture home，`TOKENTRACKER_NO_TELEMETRY=1`，且不登录（无 device token → 上传自动跳过）。已落地：`scripts/usage-oracle-check.js --tt-only --sync`；fixture home `test/fixtures/usage/home/`（34 KiB，codex 4 行 / dsh 3 行 / opencode 4 行 = 11 个桶），golden 在 `test/fixtures/usage/golden/`。Highlighter 的 3 个适配器不依赖 `%APPDATA%`（codex=显式 sessions 目录、dsh=`DSH_HOME`/显式路径、opencode=显式 db 路径），fixture 测试应显式传路径，不依赖进程 home。

**已知对拍注意点**：TT 的 heatmap 首列星期依赖运行日（§0.4）；对拍时只比 cell 的 `day/value/level` 集合，忽略网格列对齐。TT 的 `billable` 读取修复（cursor/antigravity）在 MVP 3 工具里不触发。

### 4.2 单测矩阵（`node --test`）

| 模块 | 用例要点 | 数据 |
|---|---|---|
| `usage-time` | 日/周/月/总计/自定义边界；跨年；`Asia/Shanghai`；`America/New_York` 3 月/11 月 DST；周一起点；24 个月窗口 | 纯函数 |
| `usage-store` | DDL 幂等；LWW upsert；事务回滚；删除；保留清理；clear；close/重开；WAL 重开 | 临时目录 + 真 SQLite |
| `usage-state` | 行→hourlyState 形状；`groupQueued` 种子；解析后删除键 diff | fixture 行 |
| `usage-tools` | 每工具：未安装/不可读/空/正常；文件列表注入；env 传递 | fake home/fs |
| `usage-collector` | 单飞；取消；worker 崩溃；提交顺序；节流；禁用 | fake worker/store |
| `usage-query` | totals/rolling/activeDays；每日补零；来源/模型占比；heatmap level（max-relative）；时区折日 | 真 SQLite fixture |
| `usage-ipc` | 8 通道参数矩阵；错误映射；通道顺序与注册形状 | fake ipcMain（照 `test/history-ipc.test.js:5-38`） |
| `shared/usage-format` | 紧凑/全量/中文单位/百分比/边界（999.95K→1M） | 纯函数 |
| 页面格式 | tooltip/区间标签/列文案（可放 usage-format） | 纯函数 |

### 4.3 契约与门禁测试

`test/config-routes.test.js`（自动）、`test/config-icon-contract.test.js`（12→13）、`test/i18n-contract.test.js` + `check:i18n`、`test/design-tokens.test.js`、`test/window-security.test.js`（CSP 无内联）、`test/ipc-security.test.js`（通道对账 + page policy）、`test/data-root.test.js`、`test/data-root-migration.test.js`、`test/architecture-gate.test.js`（main.js 行数）。

### 4.4 e2e 与打包

- e2e：`e2e/highlighter.spec.js` 追加 usage 路由渲染；用 fixture home（`e2e` 启动参数注入或 `HIGHLIGHTER_USAGE_HOME`）避免扫真实 `%USERPROFILE%`；断言：未开启态 → 开启 → 扫描 → KPI/明细出现；周期切换后数值变化；空态/错误态（fixture 变体）各一条。
- 打包：`npm run build:win` 后在安装版里启动 → 开用量页 → 扫描 fixture home → 断言 DB 生成且页面出数；记录 `node:sqlite`/`utilityProcess`/asar 路径结果。可复用 `scripts/probe-electron-runtime.js` 与 `test/electron-runtime.test.js` 的模式做开发期冒烟。
- 数据目录：切到新目录 → 重启 → usage 历史仍在；切回 → 无脏目录（对照 `test/data-root-migration.test.js` 的清理断言）。

### 4.5 性能与资源验收（本机基线，B2-7/ B6-3 记录）

| 指标 | 目标 | 备注 |
|---|---|---|
| 无变化增量扫描（3 工具） | <1.5 s | 只 stat/游标，无 parse 输出 |
| 首次全量扫描（本机 3 GB） | 不阻塞 UI；可分次完成；可取消 | 目标上限 5 min，超时自动停在已提交边界 |
| 查询 P95（24 个月区间） | <100 ms | 10 万桶级 |
| 主进程事务提交 | <30 ms/工具 | 2,000 行/批 |
| worker 峰值内存 | <300 MB | 状态克隆 + 解析 |
| DB 体积 | <50 MB（重用户 2 年） | 超 64 MB 触发清理 |

---

## 5. 风险登记与预案

| # | 风险 | 触发信号 | 预案/回退 |
|---|---|---|---|
| R1 | **vendor 语义偏差**（sink 改造后行内容与 TT queue 不一致） | B0 oracle 对拍有 diff | 先定位到具体工具/字段；若 sink 改造难收敛，**回退到「保留 queue.jsonl 暂存 + 主进程增量摄入」**（改动更小、语义与 TT 完全一致；代价是多一个中转文件） |
| R2 | **主进程写库阻塞**（事务/查询卡 UI） | B0 实测提交 >50 ms 或查询 P95 超预算 | 退化方案 A：查询走 read-only 连接 + worker 写库（WAL 跨进程，P0 已验证可行性再启用）；方案 B：JSON rollup + 内存聚合（D3=B） |
| R3 | **node:sqlite 打包行为变化** | 安装版冒烟失败 | `usage-store` 接口后切 JSON rollup；锁 Electron 版本；把打包冒烟纳入 CI 可选任务 |
| R4 | **首扫 3 GB 太慢/内存高** | 冷扫 >5 min 或 worker OOM | 按工具提交 + 进度 + 可取消；超预算停在工具边界下次续扫；必要时首批只扫最近 6 个月，剩余后台补齐（记录为「部分覆盖」状态） |
| R5 | **OpenCode 754 MB DB 只读打开失败**（WAL/`SQLITE_BUSY`） | 状态显示 unreadable | 重试 + busy_timeout；仍失败则复制 db+wal+shm 到 `usage/cache` 只读快照（读取后删除）；仍失败则该来源标 unreadable |
| R6 | **外部日志契约漂移**（CLI 升级后归零） | 某工具新数据为 0 且文件在 | 坏行跳过 + `parseErrors` 计数 + 覆盖状态展示；上游 fixture 回归；按季度 diff 上游 tag |
| R7 | **data-root 迁移漏登记/WAL 丢失** | 迁移测试红、切目录后为空 | G3 全部改动 + 迁移前 `wal_checkpoint(TRUNCATE)` + close + 整组复制 + 演练；`test/data-root*.test.js` 双断言 |
| R8 | **`main.js` 行数超限** | `check:architecture` 失败 | 保持单行 install；若评审要求常规结构，按既有先例申请 1330→1336（`check-architecture.js:19-24` 有记录），并在同一提交写理由 |
| R9 | **解析状态克隆过大** | B0 实测消息 >50 MB / >200 ms | 改为临时 JSON 文件传给 worker（`<dataRoot>/usage/runtime/state-<tool>.json`），worker 流式读 |
| R10 | **DSH `.zstd` 多帧/损坏** | fixture 解析失败 | 单文件失败跳过并计数；用本机真实 141 个文件做回归（B2-1） |
| R11 | **heatmap 口径/对齐争议** | 用户对比截图质疑星期 | 文档写明：数值/level 同 TT；列首固定周一（TT 自身首列随运行日漂移，属缺陷） |
| R12 | **i18n/CJK 门禁超限** | `check:i18n` 失败 | 新代码全英文；文案只进 locale 表；若超 21 行余量，按既有流程迁移一条 `throw` 行出白名单（D6 规则） |
| R13 | **隐私/合规** | 评审质疑 | 只读、只存计数、不落正文/路径、日志英文、首次同意、清除入口、诊断包排除 |
| R14 | **Cursor 预期落差** | 用户问「为什么没有 Cursor」 | 覆盖状态常驻说明「账号级 API，本机不可统计」；发布说明标注 |
| R15 | **WSL/长路径/杀软锁文件** | 单文件 EACCES/EBUSY | 首版明确不支持 WSL；单文件失败重试一次后跳过并计入状态；不影响其它来源 |
| R16 | **vendor 长期维护** | 上游 tag 演进 | 固定 `148b758e`；文件头标注；维护 `docs/third-party/README.md` 的修改点清单；每季度 diff |
| R17 | **tokscale 启发式注释的许可疑问** | 法务复核 | 复核结论：仅 3 处注释、无代码块、THIRD_PARTY_NOTICES 无此条目；保留注释即可，暂不需级联署名（见 §0.4 与底稿 05 §8） |

---

## 6. 决策记录（Q1–Q3 已确认 / Q4–Q6 默认执行）

| # | 决策 | 默认建议 | 其他选项与影响 |
|---|---|---|---|
| Q1 | **首版工具范围（已确认 2026-10-21）** | **Codex / DSH / OpenCode 三个** | 后续扩展：Claude/Gemini/Kimi/Qoder/Copilot 等按同一适配器模式追加（每工具约 0.4–1 人日 + fixture），不在本次交付 |
| Q2 | **是否做金额（已确认 2026-10-21）** | **不做**（`total_cost_usd=null`，页面无美元行） | 后续若做：+3.5 人日（pricing vendor），查询时按当前价重算并标「估算，非账单」 |
| Q3 | **统计开关默认值（已确认 2026-10-21）** | **默认关闭 + 首次进入页面时内联同意卡**（只读、只存计数说明） | 无 |
| Q4 | 页面落点 | 设置窗口新路由（846px 单栏 → 宽屏两栏） | 独立窗口（+12 文件、main.js 装配与 preload 成本更高，B4 前可改主意） |
| Q5 | 历史回填 | 24 个月（与 TT 总计口径一致），保留 24 个月 | 首扫只回填 12 个月可显著缩短首扫时间（本机 3 GB 场景尤甚）；代价是与 TT「总计」口径不一致，需要在页面标注 |
| Q6 | 截图基线 | 以分析 §2.6 + 本文 §2.8 为准，不逐像素验收 | 若需逐像素复刻，需提供截图对应的 TokenTracker 版本/commit（本地 v1.4.7 与截图有 3 处对不上） |

> Q1–Q3 已确认（2026-10-21）；Q4–Q6 仍为默认值，实施中如无异议按默认执行，变更时回写本表与受影响批次。

---

## 7. 开工前检查清单与第一周

### 7.1 开工前（D0，半天）

1. §6 Q1–Q3 已于 2026-10-21 确认（Codex/DSH/OpenCode、不做金额、默认关闭+首次同意），结论已写回 §0.5/§6；开工前只需确认 Q4–Q6 无异议（默认执行）。
2. 建分支/worktree：`feat/usage-page`（仓库当前干净；数据引擎与页面两条线可各用 worktree，合并前由 Lead 跑全量门禁）。
3. 准备 oracle 环境（**一次性**）：`D:\workspace\_tt-oracle` 安装 `tokentracker-cli@1.4.7`；准备 fixture home（脱敏日志子集）；验证 `USERPROFILE` 覆盖可用、TT `sync` 不联网（无 device token + 无遥测；必要时断网）。
4. 复制许可：`docs/third-party/LICENSE-TokenTracker.txt`（MIT 全文 + 版权行）；记录上游 `v1.4.7 / 148b758e`。
5. 记录基线：本机日志体量（表见 §0.4）、Electron 运行时探针输出，写入本文附录「实测记录」。

### 7.2 第一周（D1–D5，对应 B0 + B1 起步）

| 日 | 任务 | 当日产出/验收 |
|---|---|---|
| D1 | B0-1 契约评审；B0-2 开始：写 vendor 脚本（按 20 文件清单复制、去 Trae/Cursor、zstd fallback、stub WSL、加许可头） | vendor 目录可 `require`；`node -e "require('./main/vendor/tokentracker/rollout')"` 无副作用 |
| D2 | B0-2 完成 V1–V9；`usage-tools` 的 claude 适配先跑通；导出补充 | vendored parser 在纯 Node 下解析 fixture 输出桶行；与 TT 对拍首个工具一致 |
| D3 | B0-3 P0 spike：Electron `utilityProcess` + 消息体积/事务耗时/打包冒烟 | 4 项实测数字；S2/S3 结论（是否启用文件传 state、是否维持主进程写入） |
| D4 | B0-4 oracle 脚本 + golden；B1-1 store DDL/事务 | `node scripts/usage-oracle-check.js` 可重复输出对照表；store 单测通过 |
| D5 | B1-2 state 适配 + B1-3 worker 骨架 | fixture home 下 `claude` 桶行入库；M0 gate 评审 |

**D5 验收命令（示例）**：

```bash
npm test                          # 全部单测（含新 usage 用例）
npm run check                     # check-js + architecture + i18n
node scripts/usage-oracle-check.js --home test/fixtures/usage/home --tools claude,codex,dsh
node --test test/usage-store.test.js test/usage-state.test.js
```

---

## 附录 A：文件级改动清单（实施核对表）

### A.1 渲染层（页面）

| 文件 | 动作 |
|---|---|
| `config/routes/usage.js` | 新建：`renderUsage()`（异步、`currentRoute`+版本守卫、可重复渲染）、子视图、事件绑定、7 种状态、注册 `window.configRoutes['renderUsage']` |
| `shared/usage-format.js` | 新建（UMD）：token 数字格式、百分比、区间标签、tooltip 文案、热力/趋势显示辅助（纯函数，node:test） |
| `config/config.html` | 侧栏「工具设置」组 + `data-route="usage"` 按钮（1 行）；`<script src="../shared/usage-format.js">` 与 `<script src="routes/usage.js">`（`config.js` 之前） |
| `config/config.js` | `routes` + `usage:{key:'renderUsage'}`；`routeTitles` + `usage:'config.route.usage'`；离开路由清理定时器/监听 |
| `config/config.css` | `.usage-*`：KPI 条、总览、分段条、模型细条、堆叠柱、热力格、紧凑表、两栏断点（≈250–320 行，只消费 token） |
| `config/icons/usage.svg` | 新建导航图标（主色 mask，`--icon` 用法一致） |
| `shared/locales/config.js` | `config.route.usage` + `config.usage.*`（约 80–100 key × 3 语言） |
| `test/config-icon-contract.test.js` | 导航图标 12 → 13 |
| `test/config-routes.test.js` | 自动覆盖；**不要**改 `window.configShared` 清单 |
| `test/design-tokens.test.js` | 若新增 chart token 才补断言 |
| `e2e/highlighter.spec.js` | 路由渲染清单 + usage 用例（fixture home） |

### A.2 主进程（数据）

| 文件 | 动作 |
|---|---|
| `main/vendor/tokentracker/*` | 新建：14 文件 + V1–V9 改造 + 许可头 + `test/`（可选子集） |
| `main/vendor/tokentracker/pricing/**` | B6 可选：pricing JS + 种子（冻结网络拉取） |
| `main/usage-scan-worker.js` | 新建：`utilityProcess` 入口（解析循环、进度、取消、错误上报） |
| `main/services/usage-feature.js` | 新建：组装根（惰性 store、IPC 注册、进度推送、app 生命周期、quiesce/resume） |
| `main/services/usage-runtime.js` | 新建：极小注册表（data-root 域 quiesce 用，避免 main.js 参数行） |
| `main/services/usage-store.js` | 新建：node:sqlite 打开/迁移/事务提交/状态载入/保留/清除/checkpoint/close |
| `main/services/usage-state.js` | 新建：DB 行 ⇄ parser hourlyState、groupQueued 种子、变更/删除 diff |
| `main/services/usage-tools.js` | 新建：工具注册表（8 → 约 42）、根发现、状态、适配器 |
| `main/services/usage-collector.js` | 新建：单飞、状态机、调度/节流、进度、取消、崩溃恢复 |
| `main/services/usage-worker-client.js` | 新建：`utilityProcess.fork`、消息协议、超时/退出 |
| `main/services/usage-time.js` | 新建：周期/本地日/DST/周起点（纯函数） |
| `main/services/usage-query.js` | 新建：5 类聚合 + LRU + 缓存失效 |
| `main/ipc/usage-ipc.js` | 新建：8 通道校验/错误映射（deps 签名注释照 `history-ipc.js`） |
| `main/services/ipc-security.js` | `main.handles` +8；**不新增 listeners**（`usage:scan-progress` 是主→渲染广播，不登记 `IPC_SURFACES`，否则 `assertComplete()` 抛错） |
| `preload.js` | +8 个 invoke +1 个 `onUsageScanProgress`（返回取消订阅） |
| `main.js` | **+1 行** install（见 G1）；不加其它行 |
| `main/services/data-root.js` | `createDataPaths` +`usage` |
| `main/services/data-root-migration.js` | `MANAGED_DIRECTORIES` +`'usage'`；WAL checkpoint/整组复制说明 |
| `main/domains/data-root/index.js` | `stopManagedDataWriters()` 调 `usageRuntime.quiesce()` |
| `main/services/settings-defaults.js` | `usage: { enabled: false }` |
| `main/services/settings-normalize.js` | `usage.enabled` 布尔归一 |
| `main/services/diagnostics-service.js` | （B6）确认诊断包不含 usage 数据；可选展示 DB 大小 |
| `docs/third-party/LICENSE-TokenTracker.txt`、`docs/third-party/README.md` | MIT 全文 + 上游版本/commit/修改点清单 |

### A.3 测试与脚本

`test/usage-time.test.js`、`test/usage-store.test.js`、`test/usage-state.test.js`、`test/usage-tools.test.js`、`test/usage-collector.test.js`、`test/usage-query.test.js`、`test/usage-ipc.test.js`、`test/usage-worker-client.test.js`、`test/fixtures/usage/**`（home、golden、ipc mock）、`test/data-root.test.js`/`test/data-root-migration.test.js`（更新）、`test/config-icon-contract.test.js`（更新）、`e2e/highlighter.spec.js`（更新）、`scripts/usage-oracle-check.js`（开发期对拍，不参与默认门禁）、`npm run test:usage-parsers`（vendored 上游解析测试，可选）。

---

## 附录 B：IPC 契约样例（Mock fixture 基准）

`test/fixtures/usage/ipc/status.json`：

```json
{
  "enabled": true,
  "scanning": false,
  "scan": null,
  "lastScanAt": "2026-10-21T03:10:00.000Z",
  "lastError": null,
  "dbBytes": 524288,
  "retentionMonths": 24,
  "sources": [
    {"source":"claude","label":"Claude Code","state":"ok","detected":true,"readable":true,"files":8,"lastScanAt":"2026-10-21T03:10:00.000Z","lastError":null,"coverageStartAt":"2026-06-01T00:00:00Z","estimated":false},
    {"source":"gemini","label":"Gemini CLI","state":"empty","detected":true,"readable":true,"files":0,"lastScanAt":"2026-10-21T03:10:00.000Z","lastError":null,"coverageStartAt":null,"estimated":false},
    {"source":"copilot","label":"GitHub Copilot","state":"absent","detected":false,"readable":false,"files":0,"lastScanAt":null,"lastError":null,"coverageStartAt":null,"estimated":false},
    {"source":"cursor","label":"Cursor","state":"unsupported","detected":false,"readable":false,"files":0,"lastScanAt":null,"lastError":null,"coverageStartAt":null,"estimated":false}
  ]
}
```

`summary.json` 关键字段：

```json
{
  "period": "month", "from": "2026-10-01", "to": "2026-10-21", "tz": "Asia/Shanghai",
  "totals": {"billable_total_tokens": 18422310, "total_tokens": 18422310, "input_tokens": 2094000,
             "output_tokens": 133000, "cached_input_tokens": 16170000, "cache_creation_input_tokens": 0,
             "reasoning_output_tokens": 0, "conversation_count": 412, "total_cost_usd": null, "unpriced_tokens": 0},
  "rolling": {"last7d": {"billable_total_tokens": 5102000, "conversation_count": 120},
              "last30d": {"billable_total_tokens": 18012000, "conversation_count": 400},
              "avgPerActiveDay": 692769, "activeDays": 26},
  "pricing": {"mode": "none", "version": null}
}
```

`daily.json` 行形状（MVP 不含 cache write / 成本列展示）：

```json
{"day":"2026-10-20","total_tokens":184223,"billable_total_tokens":184223,"input_tokens":20940,
 "output_tokens":1330,"cached_input_tokens":161700,"reasoning_output_tokens":0,
 "conversation_count":12,"total_cost_usd":null}
```

`heatmap.json`（B5）：`{"from":"2025-10-27","to":"2026-10-21","weekStartsOn":"mon","activeDays":120,"max":98231,"weeks":[[{"day":"2025-10-27","value":0,"level":0,"total_tokens":0,"conversation_count":0}, ...]]}`（无活动的未来日填 `null`）。

---

## 附录 C：首版 3 工具适配表（B1/B2 实施依据）

| source | 根/发现 | parser | 关键注意 |
|---|---|---|---|
| `codex` | `~/.codex/sessions`（`CODEX_HOME`） | `listRolloutFiles` → `parseRolloutIncremental` | **B1 第一个**；累计快照差量；本机 420 MB/300 文件（单文件最大 40 MB），最重；`stat().ino=0` 时退化 size/mtime |
| `dsh` | `resolveDshSessionFiles(env)` | `parseDshIncremental` | 无 env 参数；`.jsonl.zstd` 多帧；本机 70 MB/141 个 |
| `opencode` | `<XDG_DATA_HOME 或 ~/.local/share>/opencode/opencode.db`（Windows 也遵循 XDG） | `readOpencodeDbMessagesIncremental` → `parseOpencodeDbIncremental` | 754 MB DB；只读 + busy 重试/快照；DB cursor |

扫描顺序（`priority`）：`codex > dsh > opencode`；工具间串行、工具内按上游列表顺序（parser 语义依赖，勿自行重排）。每工具提交后即可被页面查询（首扫期间页面逐步出数）。

> 后续扩展（不在本次交付）：`claude`（需要 `cursors.claudeHashes`）、`gemini`、`kimi-code`、`qoder`、`copilot` 等沿用同一适配器签名与 fixture 流程，新增工具主要是「注册表一行 + 发现函数 + fixture」。

---

## 附录 D：口径对拍注意点与已知坑（实施时对照）

| 坑 | 影响 | 处理 |
|---|---|---|
| heatmap 首列星期随运行日漂移（TT 缺陷） | 网格对齐不同 | 只比 `day/value/level`；本方案固定周一起始 |
| level 有两种算法（服务端 max-relative / 前端 fallback p50/p75/p90） | 颜色不同 | 以 `local-api.js:2598-2605` 为准（max-relative） |
| Codex input 含 cache | 重复计数 | vendored parser 已处理；fixture 断言 `input` 非缓存 |
| Cursor/Antigravity `billable=0` 读取修复 | 显示 0 假象 | MVP 不涉；读取适配层保留 `normalizeQueueRow` 等价逻辑（B6 扩展工具时） |
| 去重键缺陷（只判 msgId&&reqId） | 过计 1.6–3.7× | 使用 vendored parser 自带的 provider 级去重；不自行加“二次聚合” |
| 镜像源（Mimo 等） | 重复计数 | MVP 不含；B6 扩展时保留 `source-metadata`/providerID 过滤 |
| 估算 token（Kiro CLI/Antigravity/Grok） | 误差 | B5 起展示 `estimated` 角标；MVP 3 工具不涉 |
| 成本时点 | 历史金额随价格变 | B6 决策：查询时按当前价重算（与 TT 一致），页面标「估算，非账单」+ 价格表版本 |
| Codex 原子重写 session 文件 | 重复/漏计 | 贡献扣减 + 整文件重扫（B2-3 用例覆盖） |
| 大文件（单文件 40 MB） | 内存/卡顿 | `jsonl-lines.js` 字节迭代 + 单行上限；worker 内解析 |
| Windows `stat().ino=0` | 游标变化检测弱化 | 退化 size/mtime 比较（用上游逻辑，不另写） |
| `parseKimiCodeIncremental` 回落 `process.env` | 结果不可控 | 适配器显式传 `env`/`wireFiles`/`model` |
| `parseDshIncremental` 无 env | 文件列表必须外部解析 | 适配器先 `resolveDshSessionFiles(env)` |
| `queuePath` 占位目录 | parser 会 `ensureDir(dirname)` | 传 `<dataRoot>/usage/runtime/queue.jsonl`，sink 生效时无写入 |

---

## 附录 E：参考索引（本方案引用的关键事实）

| 主题 | 参考 |
|---|---|
| 上游分析 / 底稿 | `docs/plans/2026-10-21-tokentracker-usage-page-migration-analysis.md`、`docs/plans/usage-migration-analysis/01–05` |
| TokenTracker 解析闭包/46 parser | `TokenTracker/src/lib/rollout.js`（25,966 行；46 个 `parse*Incremental`；sink `:3513-3830`） |
| 上游依赖/许可 | `TokenTracker/package.json:54-59`、`LICENSE:3`、`THIRD_PARTY_NOTICES.md` |
| TT 聚合口径 | `TokenTracker/src/lib/local-api.js:203-261,513-646,2403-2479,2578-2711,3191-3236` |
| TT 周期定义 | `TokenTracker/dashboard/src/lib/date-range.ts:49-91` |
| TT 成本公式/种子 | `TokenTracker/src/lib/pricing/index.js:227-365`、`seed-snapshot.json`（2,283 模型） |
| Highlighter 路由/侧栏/CSP | `config/config.js:21-91`、`config/config.html:5,13-32,53-95` |
| Highlighter IPC/白名单 | `main/services/ipc-security.js:8-66,214-331`、`main.js:463-476,945-1181`、`preload.js:3-89` |
| Highlighter data-root/迁移 | `main/services/data-root.js:13-33`、`main/services/data-root-migration.js:25-30,405-424,576-660`、`main/domains/data-root/index.js:40-58` |
| Highlighter 设置模板 | `main/services/settings-defaults.js:17-166`、`settings-validation.js:23-34`、`settings-normalize.js:98` |
| Highlighter utilityProcess 先例 | `main/services/selection-hook-service.js:91-117`、`main/domains/selection/index.js:208-216` |
| 门禁 | `scripts/check-architecture.js:25`、`scripts/check-i18n.js`、`package.json:9-16`、`test/config-routes.test.js`、`test/config-icon-contract.test.js:33`、`test/ipc-security.test.js`、`test/window-security.test.js:132-163` |
| Electron 运行时实测 | `ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe -e "…"`（Node 24.18.0 / node:sqlite / zstd，本机 2026-10-21 复核） |
| 本机日志体量 | `du -sh ~/.claude ~/.codex/sessions ~/.dsh/sessions`、`~/.local/share/opencode/opencode.db`（754 MB） |

---

## 附录 F：实测记录（B0-3 / B2-7 填写，用于回写结论）

> 模板：每项记录「命令 / 环境 / 结果」，结论行只写数字与判定。未填写的项不得进入 B1 以后的批次。

| # | 项 | 命令/方法 | 结果（待填） | 判定 |
|---|---|---|---|---|
| F1 | Electron 运行时 | `ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe -e "…"` | Node v24.18.0；`node:sqlite` 可用；`zlib.zstdDecompressSync` 可用（2026-10-21 已实测） | ✅ 通过 |
| F2 | `utilityProcess.fork` 加载 vendor 解析器 | 真实 Electron 开发运行，解析一个 codex/DSH fixture | fork() 0.21–0.41 ms；fork→worker 首条消息 **median 138 ms**（min 130；首次 spawn 196–596 ms）；worker Node v24.18.0 | ✅ 通过 |
| F3 | 3 工具 state 一次性消息 | 主进程 → worker postMessage，记录 `structuredClone` 大小/耗时（含 ~20k 桶的真实形态） | 20k 行/6.04 MiB：**22.5/23.7 ms**；5/15/30 MB：29/61/121 ms（主→worker）与 26/57/115 ms（worker→主）；最大 31.16 MiB | ✅ 通过（无方向 >200 ms、<50 MB） |
| F4 | 主进程单事务提交 | 2,000 行 upsert + 游标 + 状态 | **5.93 ms**（schema+2,000 行+scan_state 单事务；rows-only 4.53 ms；open+pragmas 11 ms） | ✅ 通过（<30 ms） |
| F5 | 打包冒烟 | `npm run build:win` 后安装版打开用量页扫 fixture home | 页面出数 / DB 生成：是/否 | 待测 |
| F5* | worker 崩溃/取消/重启 | 真实 Electron：uncaught throw / kill / 重新 fork | 崩溃 exit 1 观测 1.46 ms；kill 2.2 ms；重启后首消息 137 ms | ✅ 通过 |
| F6 | 本机冷扫（3 GB 日志） | 扫描 `%USERPROFILE%`，记录总时长/峰值内存/各工具耗时 | 总 __ s；峰值 __ MB；codex __ s / dsh __ s / opencode __ s | 待测（阈值 5 min） |
| F7 | 无变化增量扫描 | 连续两次扫描 | 第二次 __ ms；新增桶 __ 个 | 待测（阈值 1.5 s / 0 桶） |
| F8 | 查询性能（24 个月） | 10 万桶合成数据，summary/daily/breakdown/heatmap 各 100 次 | P95：summary __ ms / daily __ ms / breakdown __ ms / heatmap __ ms | 待测（阈值 100 ms） |
| F9 | **TT oracle 基线** | `node scripts/usage-oracle-check.js --tt-only --sync`（fixture home） | TT 1.4.7 本地跑通：9 文件 → 11 桶（codex 4 / dsh 3 / opencode 4），golden 已提交；两次运行 md5 一致 | ✅ 通过 |
| F10 | **解析层对拍（B0）** | vendored parser 以 sink 模式跑 fixture home，与 TT `queue.jsonl` 逐桶比较 | **11/11 桶一致、0 字段差异**（codex 4 / dsh 3 / opencode 4）；vendor smoke 93 断言通过 | ✅ 通过 |
| F11 | **聚合层对拍（B1/B2）** | `node scripts/usage-oracle-check.js --hl-db <usage.db>`（同一 fixture home，扫完后） | 不一致桶 __ 个；每日/来源/模型 diff __ 处 | 待测（目标 0） |

> **Electron 探针环境备注（B0-3 实测）**：本会话的 DSH 宿主导出了 `ELECTRON_RUN_AS_NODE=1`，直接跑 `electron.exe script.js` 会被当成 Node（`app` undefined）；GUI/e2e/打包探针必须 `env -u ELECTRON_RUN_AS_NODE`。在受限 agent shell 里 Chromium 沙箱起不来，临时探针需 `--no-sandbox`（正常开发/用户环境不需要）；探针在所有情况下都不得创建可见窗口（本次 `browserWindowsCreated:0`）。

---

## 变更记录

| 日期 | 变更 |
|---|---|
| 2026-10-21 | 初版：基于上游分析 + 本机复核，给出 S1–S6 细化决策、B0–B6 批次、41 项任务、8 通道 IPC 契约与验收清单 |
| 2026-10-21 | **范围确认**：首版工具 = Codex/DSH/OpenCode（3 个）、不做金额、统计默认关闭+首次同意；据此重排 B1–B6 任务与工期（MVP 27–32 人日、本次完整交付 36–42 人日），B1 垂直切片工具改为 Codex，工具扩展与 pricing 移出本次交付 |
| 2026-10-21 | **B0 实施记录**：B0-1 契约 mock 已落地（`test/fixtures/usage/ipc/`）；B0-2 vendor 闭包落地（14 文件，75 项 smoke 断言通过）；B0-4 oracle 基线完成（TT 1.4.7 本地跑通，11 桶 golden）；data-root/settings 的 `usage` 登记与开关已合入（见 F9 与 §4.1） |
