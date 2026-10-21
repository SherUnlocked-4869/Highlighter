# 05 TokenTracker 解析层移植 Highlighter 可行性评估

> 分析员：hl-ai-usage（task-5）｜目标仓：`F:/workspace/TokenTracker`（MIT，v1.4.7）｜目标宿：Highlighter（Electron 43 / Node 24.18 / CJS / 无前端构建）
> 口径前提（2026-10-20 修正）：用量页 = 解析本机 AI 编程 CLI 工具日志，与 TokenTracker 完全一致；**不是** Highlighter 自身 AI 调用（后者见 `04-hl-ai-usage.md`，仅作未来扩展参考）。
> 标记：**【已验证】**＝源码/实测可直接核对；**【推测】**＝工作量为估算或依赖未实测。只读分析，未改任何产品代码；TokenTracker checkout 未安装 `node_modules`（磁盘上不存在该目录）。

---

## 0. 结论（给 Lead 的一页纸）

1. **可以移植，但不能“整体搬运”**。TokenTracker 的 `src/` 共 **114 个 JS 文件 / 82,546 行 / 3.45 MB**；真正与“扫描+解析”有关的**解析闭包只有 20 个文件 / 29,690 行 / 1.13 MB**（`node /tmp/tt-closure.js lib/rollout.js` 实测），其中 46 个工具解析器主体合计 **25,646 行**（`rollout.js` 单文件 25,966 行）。
2. **解析闭包几乎是零 npm 依赖**：静态 require 只出现 `@mongodb-js/zstd`（2 处，且是 Node 内置 zstd 不可用时的 fallback）。Highlighter 的 Electron 43.2.0 实测运行 Node **v24.18.0**，`zlib.zstdDecompressSync` 存在（本次实测）→ **zstd 依赖可直接删除**。
3. **唯一“带刺”的工具是 Trae**：SQLCipher 加密库 + 自定义解密页 + `@journeyapps/wa-sqlite`（ESM + WASM，动态 `import()`）。它是解析闭包里唯一无法用 Node 内置替代的部分；建议首版**放弃 Trae**（46 → 45 个解析器），或单独评估 WASM 打包。
4. **真正的成本不在解析器，而在编排与聚合**：`src/commands/sync.js` **7,843 行**（require 闭包 88 文件 / 73,335 行）把本地扫描、增量游标、云上传、历史修复、遥测混在一起；`local-api.js` **3,588 行**（闭包 79 文件 / 63,960 行）把本地聚合与云端账号/认证混在一起。**这两块不能 vendor，必须拆分重写**（只保留本地部分）。
5. **推荐方案 A（vendor 解析闭包 + 重写本地编排/聚合）**：解析器与增量语义原样复用（含 28 个解析测试文件 / 35,948 行作为回归资产），新写编排约 2,500-3,500 行、聚合约 1,000-1,500 行（可用 TokenTracker 自带 pricing 种子保口径）。预计 **3-4 周 / 1 人**（POC 3-5 天 → 12 工具 1 周 → 45 工具 + 测试 1-2 周 → 收尾 3-5 天）。
6. 方案 B（重写 8-12 个工具）：**3-5 周**，代码量约 8-10k 行，风险最高（token 口径细节多，TokenTracker 用 3.6 万行测试才钉住）。方案 C（sidecar 整体跑 TokenTracker）：POC **3-5 天**可通，但产品化需 1-2 周收口，且引入 5 个依赖 + 联网/遥测/双写风险 + 长期 fork 维护；**不建议作为最终方案，只建议作为“口径对照 oracle”在 CI 里使用**。
7. 许可证：TokenTracker 为 **MIT**（`LICENSE:1-3`，Copyright (c) 2026 xiufengsun）。Highlighter 需在 `docs/third-party/` 增加 `LICENSE-TokenTracker.txt` 与 README 署名段（现有惯例见 `docs/third-party/README.md`、`LICENSE-Index-Translate.txt`）；MIT 要求随代码保留版权声明与许可全文。

---

## 1. 方法与可复现证据

- 静态阅读 + 依赖闭包脚本（`require()` 递归，`node:test` 实测）。
- 在只读 checkout 上直接跑测试（未安装依赖）：`node --test test/*parser*.test.js` → **791 tests / 786 pass / 4 fail / 1 skipped**，~1 秒级；实测失败报错均为**缺少第三方模块**（`Cannot find module 'smol-toml'` / `@mongodb-js/zstd`），**没有一个是解析逻辑失败**。
- Electron 侧实测（Highlighter 自带运行时，`ELECTRON_RUN_AS_NODE=1`）：Node **v24.18.0**；`require('node:sqlite')` 可用（`DatabaseSync/StatementSync/Session/constants/backup`）；`zlib.zstdDecompressSync` 为 function。

---

## 2. 解析层规模盘点

### 2.1 核心（解析闭包）— 20 文件 / 29,690 行 / 1,126,203 B

| 文件 | 行数 | 角色 | 移植判断 |
|---|---|---|---|
| `src/lib/rollout.js` | 25,966 | 46 个 `parse*Incremental` + 路径解析 + 桶聚合 + 去重工具（588 个顶层函数） | **直接复用**（改顶部 import/删 Trae/zstd fallback） |
| `src/lib/codex-token-usage.js` | 195 | Codex token 归一（累计→增量、子代理合并） | 直接复用 |
| `src/lib/codex-usage-record.js` | 195 | Codex record-only 文件识别 | 直接复用 |
| `src/lib/codex-model-attribution.js` | 128 | Codex 模型归因 | 直接复用 |
| `src/lib/codex-service-tier.js` | 49 | Codex service tier 字段 | 直接复用 |
| `src/lib/claude-user-identity.js` | 56 | Claude fork 会话身份去重 | 直接复用 |
| `src/lib/cursor-config.js` | 605 | Cursor 凭据/API CSV（**联网**） | 需改造/可放弃 |
| `src/lib/devin-usage.js` | 212 | Devin 行归一 | 直接复用 |
| `src/lib/grok-usage.js` | 95 | Grok token 归一 | 直接复用 |
| `src/lib/trae-db.js` | 127 | Trae SQLCipher DB 读取 | 首版放弃 |
| `src/lib/trae-snapshot.js` | 230 | Trae 页解密 + 快照 | 首版放弃 |
| `src/lib/trae-sqlite.js` | 143 | wa-sqlite WASM 引擎 | 首版放弃 |
| `src/lib/trae-usage.js` | 121 | Trae 行归一 | 随 Trae 放弃 |
| `src/lib/install-resolver.js` | 170 | 多安装/原生 vs WSL 路径仲裁 | 直接复用 |
| `src/lib/jsonl-lines.js` | 134 | 字节精确 JSONL 迭代（只认 LF、限制 record 大小） | 直接复用 |
| `src/lib/sqlite-reader.js` | 215 | `node:sqlite` 优先 + `sqlite3` CLI 兜底 | 直接复用（Electron 已验证 node:sqlite） |
| `src/lib/scan-roots.js` | 277 | 额外扫描根（CODEX_HOME/CLAUDE_CONFIG_DIR/配置） | 直接复用（改为读 Highlighter 自己的配置） |
| `src/lib/tracker-paths.js` | 16 | `~/.tokentracker` 路径 | 需改造（指向 Highlighter data root） |
| `src/lib/wsl-probe.js` | 281 | WSL 发行版/用户探测（spawn `wsl.exe`） | 直接复用（仅 Windows） |
| `src/lib/fs.js` | 455 | 原子写/权限/JSON 读写工具 | 直接复用 |

> 同目录下**不在**解析闭包、无需 vendor 的解析相关文件：`codex-rollout-parser.js`（1,471，sync 专用辅助）、`multi-install-parser.js`（113，sync 用）、`session-analytics.js`（2,972，会话页）、`claude-categorizer.js`（1,343，队列修复）、`async-queue-reader.js`（138，dashboard 队列读取）。

### 2.2 编排与数据通道（不可整体复用）

| 模块 | 行数 | require 闭包 | 说明 |
|---|---|---|---|
| `src/commands/sync.js` | 7,843 | 88 文件 / 73,335 行 | 本地扫描编排 + 云上传（`fetchFunctionResponse` 等）+ 大量历史修复迁移；54 处 `parse*Incremental(` 调用 |
| `src/lib/local-api.js` | 3,588 | 79 文件 / 63,960 行 | 本地 HTTP API（queue 聚合、usage 端点）+ 云端账号/认证/宠物/成就等 |
| `src/commands/serve.js` | 793 | 103 文件 / 79,640 行 | 本地静态服务 + API 分发（dashboard 用） |
| `src/lib/cursor-store.js` | 1,918 | 2 文件 / 2,375 行 | 大状态游标库（v2 分片；legacy `cursors.json` 兼容） |
| `src/lib/pricing/{index,matcher}.js` + 种子 | 379+456 + 256,869 B seed + 31,952 B overrides | 4 文件 / 1,833 行 | 成本计算；`computeRowCost` 口径见 `CLAUDE.md:60-64` |

**结论：解析层 ≈ 30k 行可以整搬；编排+聚合 ≈ 12k 行与外网/账号耦合，只能重写。** 这也是“整体移植不可行、但可拆分移植”的依据。

### 2.3 数据流（与 `CLAUDE.md:9,14` 一致，本次逐点核对）

```
AI CLI 运行（被动日志 / notify hook / OTEL / 本地 DB）
  → 每工具 resolver 定位文件（rollout.js 中 resolve*/list*，90+ 个函数）
  → parse*Incremental({files/records, cursors, queuePath, projectQueuePath})
      · 读新增字节（文件 inode+offset）或整文件快照 diff
      · 去重（消息 hash / 指纹 / 累计值差）
      · 归一到 UTC 半小时桶
  → ~/.tokentracker/tracker/queue.jsonl（追加，一行一个 (source,model,hour_start) 桶）
     + project.queue.jsonl（项目维度）
     + cursors.json / cursor-store-v2/（增量状态）
     + queue.state.json（上传偏移，本地页可忽略）
  → local-api.js 读 queue：按 tz 聚合（日/模型/source/项目/热力/性价比）
  → 本地 `serve` HTTP `/functions/tokentracker-usage-*`（:7680）
  → dashboard 渲染
```

- queue 行 schema（`CLAUDE.md:66-80`）：`hour_start`（UTC 半小时）、`source`、`model`、`input_tokens`、`output_tokens`、`cached_input_tokens`、`cache_creation_input_tokens`、`reasoning_output_tokens`、`total_tokens`、`conversation_count`；**读者按 `(source,model,hour_start)` 取最新一行**（append-only + 后台压缩）。
- token 归一约定（`CLAUDE.md:54-64`）：`input=非缓存输入`；cache read/write 单列；`total` 含 cache；**成本只用五列 token 计算，不用 `total_tokens`**（`src/lib/pricing/index.js` 的 `computeRowCost`）。
- 隐私（`CLAUDE.md:88`）：只存 token 计数，不存 prompt/消息/会话正文 —— 与 Highlighter 的隐私原则一致，迁移无额外合规负担。

---

## 3. 工具清单（46 个解析器 / 约 42 个工具，OMP·Pi 有薄封装重复）

> “解析入口”为 `src/lib/rollout.js` 行号；“结构”指日志形态；路径给出 resolver/默认根证据。带 ⚠ 的工具是移植例外（联网 / hook 安装 / WASM）。

| # | 工具（source） | 日志位置（默认根） | 结构 | 解析入口 | 增量策略 |
|---|---|---|---|---|---|
| 1 | Claude Code / claude | `~/.claude/projects/<project>/*.jsonl`（`listClaudeProjectFiles:290`） | JSONL | `parseClaude:1052` | 文件 inode/offset + 消息 hash（`claudeHashes`） |
| 2 | Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl[.zst]`（`listRolloutFiles:91`） | JSONL + zstd 归档 | `parseRollout:322` | 文件 offset + 累计快照 + 冷扫过滤 |
| 3 | Gemini CLI | `~/.gemini/tmp/<project>/chats/session-*.json`（`listGeminiSessionFiles:297`） | JSON 快照 | `parseGemini:1340` | `sameGeminiTotals/diffGeminiTotals` |
| 4 | OpenCode | `~/.local/share/opencode/` JSON 迁移到 `opencode.db`（`readOpencodeDbMessages:5720`） | JSON→SQLite | `parseOpencode:1510` / `parseOpencodeDb:6105` | 指纹目录 + message cursor |
| 5 | OpenClaw | `~/.openclaw/agents/<id>/...`（`resolveOpenclawHome:1680`） | JSONL/插件 | `parseOpenclaw:1752`（4,353 行，最大） | 自定义 cursor key |
| 6 | Qoder DB | `~/Library|AppData/Roaming/Qoder` local.db（`resolveQoderDbPath:6396`） | SQLite | `parseQoderDb:6562` | message cursor |
| 7 | Qoder New | `~/.qoder/projects/**`（`resolveQoderProjectsDir:6760`） | JSONL | `parseQoderNew:6896` | 文件 offset |
| 8 | Claude Science | `~/.claude-science/operon-cli.db`（`resolveClaudeScienceDbPath:7289`） | SQLite | `parseClaudeScience:7395` | frames 查询游标 |
| 9 | ⚠ Cursor | **Cursor 账号 API CSV**（`fetchCursorUsageCsv`，`src/lib/cursor-config.js:180`；凭据取自 `state.vscdb`） | CSV（联网） | `parseCursorApi:7516` | `lastRecordTimestamp` 权威替换 |
| 10 | Kiro IDE | `%APPDATA%/Kiro/dev_data/devdata.sqlite` + `tokens_generated.jsonl`（`resolveKiroDbPath:7642`/`KiroJsonlPath:7646`） | SQLite+JSONL | `parseKiro:7816` | 文件 offset/DB 游标 |
| 11 | Hermes | `~/.hermes/state.db`（`resolveHermesPath:7948`） | SQLite | `parseHermes:8244` | DB 游标 |
| 12 | Kiro CLI | `~/.kiro/sessions/**` + `Library/Application Support/kiro-cli/data.sqlite3`（`resolveKiroCliDbPath:8465`） | JSONL+SQLite | `parseKiroCli:9230` | 文件 offset |
| 13 | Kimi | `~/.kimi/sessions/**/wire.jsonl`（`resolveKimiWireFiles:9851`） | JSONL | `parseKimi:9872` | 文件 offset |
| 14 | Kimi Code | `~/.kimi-code/sessions/**`（`resolveKimiCodeHome:10013`） | JSONL | `parseKimiCode:10067` | 文件 offset |
| 15 | Codebuddy | `~/.codebuddy/projects/**`（`resolveCodebuddyProjectFiles:10374`） | JSONL | `parseCodebuddy:10510` | 文件 offset |
| 16 | WorkBuddy | `~/.workbuddy*` 变体（`resolveWorkbuddyHome:11008`） | JSONL | `parseWorkbuddy:11235` | 文件 offset + hook 触发 |
| 17 | Roo Code | VS Code globalStorage `rooveterinaryinc.roo-cline/tasks/*/ui_messages.json`（`resolveRoocodeTaskFiles:12395`） | 任务 JSON | `parseRoocode:12452` | 整任务文件 diff |
| 18 | Cline | `~/.cline/data/sessions/<id>/<id>.messages.json`（`resolveClineSessionsDir:12652`） | JSON（AI SDK metrics） | `parseCline:12828` | 任务文件 diff |
| 19 | Zed | `~/Library/Application Support/Zed/threads` 或 `%LOCALAPPDATA%/Zed/threads/threads.db`（`resolveZedDbPath:13118`） | SQLite + zstd/json BLOB | `parseZed:13278` | DB 行游标 |
| 20 | LM Studio | `~/.lmstudio/server-logs/**`（`resolveLmstudioHome:13487`） | 日志文件 | `parseLmstudio:13895` | 文件 offset |
| 21 | Unsloth | `~/.unsloth/studio/studio.db`（`resolveUnslothDbPath:14110`） | SQLite | `parseUnsloth:14319` | DB 游标 |
| 22 | AnythingLLM | `%APPDATA%/anythingllm-desktop/storage/anythingllm.db`（`resolveAnythingllmDbPath:14436`） | SQLite | `parseAnythingllm:14566` | DB 游标 |
| 23 | Devin | `~/.local/share/...`（`resolveDevinDbPath:14734`） | SQLite | `parseDevin:14835` | DB 游标 |
| 24 | Goose | `~/.local/share/goose/sessions/sessions.db`（`resolveGooseDbPath:15117`） | SQLite | `parseGoose:15232` | DB 游标 |
| 25 | Droid | `~/.factory/sessions/**`（`resolveDroidSessionsDirs:15425`） | JSONL/settings | `parseDroid:15765` | 文件 offset |
| 26 | Kilocode | VS Code globalStorage `kilocode.kilo-code/tasks/*/ui_messages.json`（`resolveKilocodeTaskFiles:12334`） | 任务 JSON | `parseKilocode:16173` | 整任务文件 diff |
| 27 | OMP-like | `~/.omp/agent/sessions/**`（`resolveOmpHome:11980`） | JSONL | `parseOmpLike:16381` | 文件 offset |
| 28 | OMP | 同上（薄封装） | JSONL | `parseOmp:16715` | 文件 offset |
| 29 | Omo | `~/.omo/agent/...`（`resolveOmoHome:12210`） | JSONL | `parseOmo:16728` | 文件 offset |
| 30 | Pi-like | `~/.pi/agent/sessions/**`（`resolvePiHome:16757`） | JSONL | `parsePiLike:16947` | 文件 offset |
| 31 | Pi | 同上（薄封装） | JSONL | `parsePi:17317` | 文件 offset |
| 32 | PrimeAgent | `~/.prime/agent/...`（`resolvePrimeAgentHome:16863`） | JSONL | `parsePrimeAgent:17327` | 文件 offset |
| 33 | MiniMax Code | `~/.minimax/v2/sessions/**`（`resolveMinimaxCodeHome:17355`） | JSONL | `parseMinimaxCode:17403` | 文件 offset |
| 34 | Reasonix | `~/.reasonix` / `%APPDATA%/reasonix` telemetry（`resolveReasonixHome:17569`） | JSONL | `parseReasonix:17678` | 文件 offset |
| 35 | Muse | `~/.local/share/muse/sessions/**`（`resolveMuseHome:17732`） | JSONL | `parseMuse:17873` | 文件 offset |
| 36 | Craft | `~/.craft-agent/workspaces/**/sessions/**/session.jsonl`（`resolveCraftConfigDir:17458`） | JSONL | `parseCraft:18107` | 文件 offset |
| 37 | Copilot（OTEL） | `~/.copilot/otel/*.jsonl` / `~/.copilot-otel`（`resolveCopilotOtelPaths:18336`） | OTEL JSONL | `parseCopilot:18905` | 文件 offset + seenIds |
| 38 | Copilot SessionStore | `~/.copilot/session-store.db`（`resolveCopilotSessionStorePaths:19185`） | SQLite | `parseCopilotSessionStore:19606` | DB 指纹 |
| 39 | Copilot App DB | `~/.copilot/history-session-state.db`（`resolveCopilotAppDbPaths:20217`） | SQLite | `parseCopilotAppDb:20408` | DB 指纹 |
| 40 | ⚠ Grok Build | `~/.grok/sessions/**`（`resolveGrokBuildHome:20580`） | JSONL + SessionEnd hook | `parseGrokBuild:21111` | hook + 文件 offset |
| 41 | Antigravity | `~/.antigravity/brain/...` + conversation DB（`resolveAntigravityBrainDirs`/`resolveAntigravityDbPath`） | JSONL+SQLite；含 token 估算 | `parseAntigravity:21827`（1,233 行） | 游标版本 `ANTIGRAVITY_CURSOR_VERSION` |
| 42 | ⚠ Trae | `%APPDATA%/Trae/ModularData/{ai-agent,ai-chat}/database.db`（`src/lib/trae-db.js:15-45`） | **SQLCipher** + WASM | `parseTrae:23060` | 页解密快照 + DB 游标 |
| 43 | ⚠ Trae CN | Trae 国内版账号 API（`fetchTraeCnUsageWithAuth`，`sync.js:2268-2312`） | 网络 API | `parseTraeCnApi:23625`（1,080 行） | 时间戳/快照 |
| 44 | DSH（DeepSeek Harness） | `~/.dsh/**`，`session*.jsonl[.zstd]`（`resolveDshHome:23853`；`DSH_SESSION_LOG_PATTERN:23894`） | JSONL + zstd 帧 | `parseDsh:24705` | 帧流 offset |
| 45 | Command Code | `~/.commandcode` / 多 home 探测（`resolveCommandCodeHome`，`rollout.js` 内） | JSONL | `parseCommandCode:25485` | 文件 offset |
| — | ⚠（附）Hook 依赖面 | Codex notify / Acode(astudio) notify / WorkBuddy hooks / Grok / OMP / OpenClaw | 写用户 CLI 配置 | `src/commands/init.js:177-237,496-620`；`src/lib/{omp,openclaw,grok}-hook.js` 合计 1,884 行 | 首次 `init` 安装，非纯被动 |

要点：
- **纯被动扫描**是绝大多数（JSONL/SQLite/任务 JSON）；⚠ 的 6 类依赖向用户 CLI 写 hook/notify，移植时要么放弃该工具，要么另行实现“温和安装/卸载 + 与 TokenTracker 共存”的产品逻辑（冲突风险高）。
- ⚠ Cursor 与 Trae CN 需要**联网 + 用户凭据**，与 Highlighter 本地化定位冲突，建议首版不做。

---

## 4. 依赖矩阵（能否进 Highlighter）

Highlighter Electron 43.2.0 实测 Node **v24.18.0**（`ELECTRON_RUN_AS_NODE=1`）；系统 Node v24.16.0；TokenTracker 声明 `engines.node >=20`（`package.json:99-101`）。

| 依赖 | TokenTracker 声明 | 实际使用点 | 在解析闭包 | 可否移除/替换 | 结论 |
|---|---|---|---|---|---|
| `@mongodb-js/zstd ^2.0.1` | `package.json:55` | `rollout.js:13159`（Zed zstd BLOB）、`rollout.js:24098`（DSH zstd 帧） | 是（仅 fallback） | **可直接删**：Node ≥22.15 内置 `zlib.zstdDecompressSync`，代码本身就是“内置优先、缺了才 require”（`rollout.js:13136-13142`）。Electron Node 24.18 实测有 `zstdDecompressSync` | ✅ 不引入 |
| `undici 8.11.2` | `package.json:58` | 仅 `src/lib/proxy-env.js:241,304,319`（CLI 出站代理引导，`bin/tracker.js` 调用） | 否 | 解析层不需要；sidecar 方案可绕过 proxy-env | ✅ 不引入 |
| `yauzl ^3.4.0` | `package.json:59` | 仅 `src/lib/pet-packages.js:5`（桌面宠物 zip 导入） | 否 | 与用量无关 | ✅ 不引入 |
| `smol-toml ^1.9.0` | `package.json:57` | 仅 `src/lib/kimi-profile.js:6`（Kimi limits/配置，非解析闭包） | 否 | 解析层不需要；若做 Kimi limits 再评估 | ✅ 不引入 |
| `@journeyapps/wa-sqlite 2.0.7` | `package.json:54` | 仅 `src/lib/trae-sqlite.js:8-13`：动态 ESM `import()` + `wa-sqlite.wasm`，用于 **SQLCipher 解密后的 Trae DB** | 是（Trae 专用） | 不可用 Node 内置替代（node:sqlite 不能读加密库；理论上可“自行解密→临时明文 DB→node:sqlite”，但要重写 230 行解密快照层且落盘明文有隐私风险） | ⚠ 放弃 Trae 或单独立项 |
| Node 内置 `node:sqlite` | 未声明（运行时能力） | `src/lib/sqlite-reader.js:68` 优先 `DatabaseSync`，失败回落 `sqlite3` CLI（`:145+`） | 是 | 不需要安装任何包 | ✅ Electron 已验证可用；CLI 兜底可删 |
| 其他 | — | 传参/日志只用 `node:fs|fs/promises|path|os|readline|crypto|zlib|util|child_process` | — | — | ✅ 零安装 |

**净结论：解析闭包的 npm 依赖增量 = 0**（放弃 Trae 的情况下）。这对 Highlighter 的依赖审计门禁（`scripts/audit-dependencies.js`）、打包（`asarUnpack`、`extraResources`）与体积都最友好。

---

## 5. 增量 / 去重 / 时区 / 大文件 / Windows

| 主题 | TokenTracker 做法（证据） | 移植风险与建议 |
|---|---|---|
| 增量游标 | 每文件 `{inode, offset, size/mtime}`，截断/换 inode 自动回退重扫（`rollout.js:504-690,1808,1918`）；大状态升级到 `cursor-store-v2/` 分片（`cursor-store.js:10-31,1918` 行） | 直接复用；Highlighter 可先用 legacy `cursors.json`（小状态）降低复杂度，状态放 data-root |
| 去重 | Claude 消息 hash（`seenMessageHashes`，`rollout.js:1086-1108`）；Codex 累计快照差；OpenCode 指纹目录；queue 读侧按 `(source,model,hour_start)` 取最新（`CLAUDE.md:80`） | 复用；禁止自行“再聚合一次” |
| 时区 | 写入统一 UTC **半小时**桶（`toUtcHalfHourStart`，`rollout.js:4517`）；展示侧 `tz` + `tz_offset_minutes` 转本地日（`local-api.js:513-520,214-240`） | 直接沿用；Highlighter 渲染层传 `Intl` 时区 |
| 大 JSONL | `jsonl-lines.js` 64KB 级字节迭代、只认 LF、物理/record 双重上限、UTF-8 fatal（`:1-134`）；大文件读流 + `fh.read` 偏移读（`rollout.js:1042-1043`） | 直接复用；禁止用 `readline` 处理 >100MB 文件（会破坏 U+2028 语义/内存） |
| 多安装 / WSL | `install-resolver.js`（native vs WSL 仲裁）、`wsl-probe.js`（spawn `wsl.exe`，`:4`）、`scan-roots.js`（环境变量/配置根） | 复用；Highlighter 是 Windows 应用，WSL 支持是加分项，但 `wsl.exe` 探测要做超时/开关 |
| Windows 路径 | 统一 `path.join` + `env.APPDATA/LOCALAPPDATA/USERPROFILE`，`~` 展开锚定 home 而非 cwd（`scan-roots.js:47-60`） | 无风险（Highlighter 仅 Windows 更好） |
| 写盘 | 原子 JSON（`fs.js`）、queue 追加（各 parse 函数内部 `ensureDir(queue)` 后追加） | queue 路径参数化即可；Highlighter 放 `<dataRoot>/usage/cli/` |
| 性能 | 46 工具全量首扫会很重（TokenTracker 有 cold-scan 审计、并发 `mapConcurrent`）；WSL stat 跨桥很慢（代码注释 `rollout.js:1072-1079`） | 建议：首扫放 `utilityProcess.fork`（Highlighter 已有模式，`main/services/selection-hook-service.js:91-96`）或 worker，页面打开时显示进度；重启后只扫增量 |

---

## 6. 测试覆盖（移植资产）

- 解析相关测试：**28 个 `test/*parser*.test.js`，合计 35,948 行**；另有 63 个测试文件直接 `require('../src/lib/rollout')`（session-analytics、dual-install、dedup、pricing 回归等）。
- 实测（无 `node_modules`，Node 24.16）：`node --test test/*parser*.test.js` → **791 tests，786 pass，4 fail，1 skipped**；失败项均为缺依赖（`smol-toml` ×3、`@mongodb-js/zstd` fallback ×1），说明**解析逻辑本身在纯 Node 环境可独立跑**。
- 测试用 fixture 在 `test/fixtures/`（cline、commandcode、kiro-cli 等）；随解析代码一起 vendor 即可作为 Highlighter 的回归基线。
- 建议：Highlighter 侧新增自己的 `node --test` 用例（编排/聚合/API），同时把 TokenTracker 的解析测试作为 `main/vendor/tokentracker/test/` 的“上游契约测试”保留（可用 tag 跳过过重用例）。

---

## 7. 移植方案 A / B / C

### 7.1 对比

| 维度 | **A. vendor 解析闭包 + 重写本地编排/聚合（推荐）** | B. 重写 8-12 个常用工具 | C. sidecar 整体跑 TokenTracker |
|---|---|---|---|
| 做法 | 拷 20 文件/29,690 行（删 Trae、zstd fallback）；新写编排（discovery→cursor→parse）+ 聚合 + Highlighter IPC/页面 | 只保留 Claude/Codex/Gemini/OpenCode/Copilot/Kimi/Kiro/Cline/Qoder/Codebuddy 等，按本仓代码重写（不 vendor） | 打包 TokenTracker CLI（src 3.45MB + 5 deps + dashboard）或以 `ELECTRON_RUN_AS_NODE`/`utilityProcess.fork` 跑一个 worker，读它的本地 API/queue |
| 覆盖工具 | 45/46（Trae 暂缓） | 8-12 | 46/46（原样） |
| 代码增量 | vendor 29.7k 行（1.13MB）+ 新写 ~3.5-5k 行 | 新写 ~8-10k 行 | 引入 82.5k 行 + 5 npm 依赖（含原生 zstd/WASM）+ 交付体积 |
| 依赖增量 | **0** | 0 | 5 个（undici/smol-toml/yauzl/zstd/wa-sqlite） |
| 口径一致性 | 高（解析器原样 + 上游测试） | 中（易漏 cache/reasoning/去重细节） | 最高（就是原实现） |
| 主要风险 | 30k 行 vendor 的可维护性/上游漂移；编排需吃透 46 套 resolve/list 语义；Trae 例外 | 口径 bug 隐蔽、测试需自建；工期最长 | fork/升级维护、隐藏联网（telemetry/sentry/usage-limits/cloud）、双写/端口冲突、体积、进程生命周期 |
| 工期（1 人） | POC 3-5 天；12 工具 1 周；45 工具+测试 1-2 周；收尾 3-5 天 → **3-4 周** | **3-5 周** | POC 3-5 天；产品化 1-2 周（不含长期维护） |
| 推荐度 | ★★★★★ | ★★☆（仅当只做 8 个工具且拒绝 vendor） | ★★（仅作 CI 口径 oracle，不建议进产品） |

### 7.2 推荐 A 的分阶段计划

| 阶段 | 内容 | 产出 | 工期 |
|---|---|---|---|
| A0 | 口径对照 harness：CI 里用 TokenTracker CLI（npm 包，不 vendor）对固定 fixture 生成 `queue.jsonl` 基准；Highlighter 聚合结果对比 | 口径验收基线 | 2 天 |
| A1 | vendor 17-20 文件（去 Trae/zstd fallback）+ `main/vendor/tokentracker/` 命名空间 + 上游测试可跑 | 解析能力就绪 | 3-5 天 |
| A2 | 编排器（表驱动 46 工具：`{source, resolve*, list*, parse, cursorSchema, hooks?}`）+ 增量状态 + queue 落盘 + utilityProcess 扫描 | 本机可扫出与 TokenTracker 同构的 queue | 1-1.5 周 |
| A3 | 聚合（日/模型/source/项目/成本，复用 pricing 种子 + tz 逻辑）+ IPC 白名单/preload + 页面数据契约 | 用量页后端可查询 | 1 周 |
| A4 | 测试/门禁/许可/打包（i18n、architecture、依赖 0 增量）| 可发布 | 3-5 天 |

### 7.3 Highlighter 侧集成约束（来自 task-3/4 的既有事实，实施时必须遵守）

- `main.js` 当前 1,323 行、门禁上限 1,330（`scripts/check-architecture.js:25`）→ 新服务装配 ≤7 行，或塞进 `initializeStore()`（`main.js:133-174`）。
- 新增 IPC 通道必须登记 `main/services/ipc-security.js:8-58` 白名单，否则 `assertComplete()` 启动即抛（`main.js:1181`）。
- 主进程新增文件禁止中文（`check:i18n --max 606`，`package.json:34`；`throw` 行豁免）。
- 扫描器放 `utilityProcess.fork`（既有模式 `main/services/selection-hook-service.js:91-96`）或 worker，避免阻塞主进程；data root 用 `main/services/data-root.js:13-33` 的布局（建议 `<dataRoot>/usage/cli/`）。
- 不要引入前端构建：页面用现有 `config/routes/* + window.configRoutes` 模式。
- 读取 `~/.codex`、`~/.claude` 等目录属于用户主目录读取，与 Highlighter 现有 `history`/`record` 保存路径同级信任；但仍需“只读、不写用户 CLI 配置”的默认策略（hook 类工具需产品决策）。

---

## 8. 许可证与源码复用边界

- TokenTracker：**MIT**，`LICENSE:1-3`（`Copyright (c) 2026 xiufengsun`）。MIT 义务：**在软件的所有副本或实质性部分中保留版权声明与许可全文**；派生/修改版本无额外“标注修改”义务（但建议标注，便于上游同步）。
- Highlighter 现有第三方声明惯例：`docs/third-party/README.md` + `docs/third-party/LICENSE-<项目>.txt`，并随 `electron-builder` 的 `extraResources` 打包（`package.json:56-97` 已含 `docs/third-party`）。
- 需新增：
  1. `docs/third-party/LICENSE-TokenTracker.txt`（MIT 全文 + 版权行）；
  2. `docs/third-party/README.md` 增加“TokenTracker（MIT, xiufengsun）—— `main/vendor/tokentracker/` 中 vendored 解析器；upstream commit/版本；修改点清单（删 Trae/zstd fallback、路径参数化、命名空间）”；
  3. 每个 vendored 文件头保留 `// Vendored from TokenTracker vX.Y.Z (MIT) — see docs/third-party/`；
  4. 若后续更新上游，记录 `upstream-commit` 与 diff 清单（类似 `docs/third-party/README.md` 里 Index-Translate 的 commit 记录方式）。
- 上游自身的 `THIRD_PARTY_NOTICES.md` 仅覆盖 RunCat 帧/宠物引擎/Devin 图标/React Bits 等**UI 资产**（`:5-127`），不涉及解析代码；但 `rollout.js` 若干注释提到“match tokscale / same heuristic as tokscale”（`:13145,13170,15111`）——**需人工复核这些启发式是否为 tokscale 代码派生**；若是，需级联 tokscale 的许可证署名（toksacle/TokenTracker 关系未在本仓文档中说明，列为开放问题）。
- 测试 fixture（`test/fixtures/`）由 TokenTracker 自建，随 MIT 覆盖；不得带入 dashboard 的 OGL/Commons Clause 资产（本方案不 vendor dashboard）。

---

## 9. 模块四分类清单

### 直接复用（vendor 后仅加命名空间/路径参数）
`rollout.js`（去 Trae/DSH zstd fallback 后）、`jsonl-lines.js`、`sqlite-reader.js`、`scan-roots.js`、`install-resolver.js`、`wsl-probe.js`、`fs.js`、`tracker-paths.js`（改根）、`claude-user-identity.js`、`codex-token-usage.js`、`codex-usage-record.js`、`codex-model-attribution.js`、`codex-service-tier.js`、`devin-usage.js`、`grok-usage.js`、`pricing/index.js`+`matcher.js`+两份 JSON 种子、`cursor-store.js`（可选，首版可退化用 legacy cursors）。

### 需改造
`rollout.js` 顶部 import（去 `trae-db`；`@mongodb-js/zstd` 分支删除）、`sources` 归一与 `queuePath` 参数（本来已参数化，改动小）、`tracker-paths.js`（指向 Highlighter data root）、`cursor-store.js`（目录配置 + legacy 迁移策略）、`pricing`（货币/展示层，价格种子保持只读）、`test/fixtures` 路径。

### 需重写
本地编排（从 `sync.js` 7,843 行中剥离“discovery→parse→queue”部分，不含云上传/修复/遥测/进度条 UI）、聚合与查询 API（从 `local-api.js` 3,588 行中剥离 usage 端点与 `aggregateByDay/modelBreakdown/heatmap/project` 等，重写为纯函数 + IPC）、扫描器进程/调度（Highlighter utilityProcess）、增量状态锁与崩溃恢复（可借鉴 `cursor-store` 语义但用简化实现）。

### 建议放弃
云端/账号/计费/排行榜（`cloud-*`、`subscriptions`、`usage-limits`、`leaderboard`、`billing`）、dashboard（React/Vite，1,200+ 文件）、桌面端（`TokenTrackerBar/Win/Linux`）、宠物/成就/wrapped/skills/pets、hook 安装类工具（Codex notify/Acode/WorkBuddy/Grok/OMP/OpenClaw，除非产品明确要做“安装 hook”）、Cursor 账号 API 与 Trae CN API（联网+凭据）、Trae（SQLCipher/WASM，首版）。

---

## 10. 风险与开放问题

| # | 风险/问题 | 说明 | 建议 |
|---|---|---|---|
| 1 | vendor 30k 行的长期维护 | 上游迭代快（114 文件/8 万行仍在演进） | 固定 upstream commit/版本；只 vendor 解析闭包；每季度 diff 一次；把上游测试当契约 |
| 2 | 编排语义吃透成本 | 46 套 resolve/list + 多安装/WSL/双写仲裁 | A1 先做 6-8 个主流工具，再按使用量扩展；用 TokenTracker CLI 做 oracle 对拍 |
| 3 | Trae 例外 | SQLCipher + WASM | 首版不做；若必须：单独评估“解密到临时明文 DB + node:sqlite”，并做隐私评审 |
| 4 | 联网工具（Cursor/Trae CN） | 与本地化/隐私冲突 | 默认关闭/不做 |
| 5 | hook 类工具 | 需要写用户 CLI 配置（与 TokenTracker 冲突） | 首版只做纯被动扫描；hook 安装另立产品决策 |
| 6 | 扫描性能/首启 | 46 工具全量首扫 + WSL 跨桥 stat 慢 | 后台 utilityProcess、分工具预算、进度 UI、仅 Windows 原生 + 可选 WSL |
| 7 | queue 兼容性 | Highlighter 自建 queue 与 TokenTracker 不同路径，格式可对齐 | 格式完全沿用 `CLAUDE.md:66-80`，便于未来互操作/oracle 对拍 |
| 8 | 许可证链 | tokscale 启发式注释 | 人工复核后决定是否级联署名 |
| 9 | “同口径”验收 | 用户要求与 TokenTracker 一致 | A0 固定 fixture + 真实日志双轨对拍：total/billable/cost 三项必须逐日一致 |

---

## 11. 复现命令（本次核对）

```bash
# 规模
find src -name '*.js' | wc -l && wc -l src/lib/*.js | tail -1
# 解析闭包（20 文件 / 29,690 行 / 1,126,203 B；外部依赖仅 @mongodb-js/zstd）
node /tmp/tt-closure.js lib/rollout.js          # 脚本：递归 require() 闭包统计
# 依赖使用点
grep -rn 'require("@mongodb-js/zstd")\|require("undici")\|require("yauzl")\|require("smol-toml")' src --include='*.js'
grep -rn 'wa-sqlite' src/lib/trae-sqlite.js
# 测试（无需安装依赖）
node --test test/*parser*.test.js               # 791 tests / 786 pass / 4 fail（缺 smol-toml、zstd fallback）
# Highlighter 运行时能力（Electron 43.2.0 = Node 24.18.0）
ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe -e "console.log(process.version, typeof require('node:zlib').zstdDecompressSync, typeof require('node:sqlite').DatabaseSync)"
```

---

**一句话总结**：解析层本身（20 文件 / 29,690 行、零 npm 依赖）**高度可移植**，但 TokenTracker 的“扫描编排 + 本地 API + 聚合”与云/账号强耦合（约 12k 行，闭包 88/79 文件），**必须拆分重写**；推荐方案 A（vendor 解析闭包、重写编排与聚合、放弃 Trae/联网/hook 类、MIT 署名），3-4 周 / 1 人，Plan B 3-5 周但口径风险更大，Plan C 仅适合作 CI oracle。
