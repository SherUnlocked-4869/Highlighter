# 02 · TokenTracker 本机 AI CLI 日志用量管道拆解（迁移到 Highlighter 数据层）

> **任务口径（2026-10-20 修正）**：用量页统计的是**本机 AI 编程 CLI 工具的日志用量**，与 TokenTracker 完全同口径；**不是** Highlighter 自身 AI 调用的托管用量。本文据此以「日志发现 → 解析 → 统一事件 → 本地聚合 → 指标口径」为主线，并给出可移植模块、依赖评估与 Highlighter 主进程 + 本地 SQLite 的最小数据模型。
> 引用约定：`T/` = `F:/workspace/TokenTracker/`，`H/` = `F:/workspace/Highlighter/`；行号为本次阅读行号。TokenTracker 为 **MIT**（`T/LICENSE:1-2`、`T/package.json:98`），可复用但必须署名。
> 证据等级：源码/命令行实测可直接核对；无法确认的标「未验证」。

---

## 0. 结论速览

1. **TokenTracker 没有本地用量数据库**：本地历史是 `~/.tokentracker/tracker/queue.jsonl`（append-only JSONL，半小时 UTC 桶的累计快照）+ `cursors.json`（扫描进度/去重状态）+ `project.queue.jsonl`。SQLite 只用来**只读**打开被监控工具的库（`T/src/lib/sqlite-reader.js:81-146`；`T/CLAUDE.md:66-80`）。
2. **46 个解析器全部在 `T/src/lib/rollout.js`**（25,966 行），命名 `parse*Incremental`；实测 `grep -c "function parse[A-Za-z0-9]*Incremental"` = **46**。同步编排在 `T/src/commands/sync.js:532`（`cmdSync`）。
3. **统一事件模型**：`{source, model, hour_start, input/output/cached_input/cache_creation/reasoning/total/billable_total_tokens, conversation_count}`；读取端取每个 `(source,model,hour_start)` 的**最新一行**（`T/CLAUDE.md:66-80`；`T/src/lib/local-api.js:206-217`）。
4. **增量靠文件游标**（inode/offset/size/mtime/hashes）与各 provider 的 id 游标；游标超 16 MB 自动升级到 `cursor-store-v2/`（manifest + generations 分片），提交受 `sync.lock` 保护（`T/src/lib/cursor-store.js:13-21,27-90`；`T/src/commands/sync.js:444-475`）。
5. **压缩日志**：Codex `rollout-*.jsonl.zst/.zstd`、DeepSeek Harness `session[.vN].jsonl[.zstd]`、Zed SQLite 的 zstd BLOB；Node 24 内置 zstd（实测可用），`@mongodb-js/zstd` 只是 Node 20 回退（`T/src/lib/rollout.js:91-99,193-197,23894,13142-13161`）。
6. **pricing 三层**：curated 覆盖 → LiteLLM 在线（24h 缓存）→ 内置 seed；成本是**读取时**用 5 个基础 token 列现算，`reasoning` 对 Codex/OMO/Cline 等不二次计费（`T/src/lib/pricing/index.js:9-41,227-353`）。
7. **路径体系**：Windows 上几乎都是 `%USERPROFILE%\.<tool>` 或 `%APPDATA%` / `%LOCALAPPDATA%`；OpenCode 系（opencode/mimo/kilo）在 Windows 也遵循 XDG → `%USERPROFILE%\.local\share\...`（`T/src/lib/install-resolver.js:85-113`）。
8. **可移植性极好**：`rollout.js` 的内部依赖图只有 **20 个文件 / 29,690 行**，外部依赖仅 `@mongodb-js/zstd`（可删）+ Node 内置模块（本机用 node 脚本实测）。Highlighter 是 Electron **43.2.0 / Node 24.18.0**，`node:sqlite` 与 `zlib.zstdDecompressSync` 均实测可用（§6.1）。
9. **必须重新做的**：本地存储从「JSONL 全量重放」改为「SQLite 桶表 + 索引」；多设备/账户/排行榜/云同步**不迁移**。单机仍需保留「多来源互镜像去重」（Mimo 镜像 Claude、OMP/OMO、Cursor 账户级等）。
10. **依赖结论**：v1 可做到**零新增 npm 依赖**（纯内置模块 + vendored MIT 解析器）；`undici`、`yauzl`、`smol-toml`、`@mongodb-js/zstd`、`wa-sqlite` 都不是必需（wa-sqlite 仅 TRAE SQLCipher，可延后/替代）。

---

## 1. 采集层

### 1.1 数据流与入口

```
AI CLI 运行 → 产生本地日志/DB（见 1.2）
  → [hook 触发 / 应用壳定时器] → sync.js:cmdSync()
  → rollout.js:parse*Incremental() 增量读取 + 差量累加
  → cursors.json（提交游标/去重状态）
  → queue.jsonl / project.queue.jsonl（append-only 桶快照）
  → local-api.js 全量重放聚合 → dashboard
  →（可选）queue.state.json 字节偏移 → 云端 ingest
```
证据：`T/CLAUDE.md:5-14`；`T/src/commands/sync.js:532-760`；`T/src/lib/rollout.js:3513-3888`；`T/src/lib/local-api.js:84-88,2403-2468`。

- Hook 型只负责「触发 sync」，真正数据仍来自日志（`T/README.md:291`）；`init` 会把 SessionEnd hook / TOML notify / 插件写入工具配置（`T/src/commands/init.js`）。**Highlighter 迁移时不需要 hook，只做被动读取。**
- 后台 sync：Windows 应用壳下 `serve` 每 60s 起一个子进程兜底 sync（`T/src/commands/serve.js:35,297-330`）；Windows 托盘宿主另有自己的 5 分钟定时器（`:305-310` 注释），macOS/其他场景由 App 或 hook 驱动。

### 1.2 46 个工具：解析器 + 默认日志路径（Windows 优先）

> 说明：路径为**默认值**；环境变量覆盖见 §1.3。macOS/Linux 差异在表内注明；标「网」的 source 需要联网/本机凭据（默认不启用）。`T/README.md:242-298` 是官方路径清单，行号为本表核对点；解析器列省略了 `T/src/lib/rollout.js` 前缀。

| # | source / 工具 | 解析器（rollout.js 除非注明） | 默认位置（Windows） | 格式与要点 |
|---|---|---|---|---|
| 1 | claude（Claude Code） | `:1052` | `%USERPROFILE%\.claude\projects\<slug>\**\*.jsonl`；native+WSL 合并 | JSONL 的 `message.usage`；`msgId(+reqId)` 去重（`:5258`） |
| 2 | codex（Codex CLI） | `:322` | `%USERPROFILE%\.codex\sessions\YYYY\MM\DD\rollout-*.jsonl[.zst/.zstd]` + `archived_sessions` | 累计快照取差量；input 含 cache 需减 |
| 3 | acode（AStudio） | `:322`（source=acode） | `%USERPROFILE%\.acode\sessions` + `archived_sessions` | Codex fork；DeepSeek 峰谷价另算 |
| 4 | cursor（Cursor） | `:7516`；`cursor-config.js:10-31` | 无本地用量日志；`%APPDATA%\Cursor\User\globalStorage\state.vscdb` 取 accessToken | 网：Cursor API CSV（账户级，非增量日志） |
| 5 | gemini（Gemini CLI） | `:1340` | `%USERPROFILE%\.gemini\tmp\<project>\chats\session-*.json` | 逐消息 JSON |
| 6 | antigravity | `:21827` | `%USERPROFILE%\.gemini\{antigravity,antigravity-ide,antigravity-cli}\brain\**\transcript.jsonl`；同级 `conversations\<id>.db` | 有 sqlite 元数据则精确，否则文本估算（CJK 1/其它 4 字符） |
| 7 | kiro（IDE+CLI） | IDE `:7816`；CLI `:9230` | IDE：`%APPDATA%\Kiro\User\globalStorage\kiro.kiroagent\dev_data\{devdata.sqlite,tokens_generated.jsonl}`；CLI：`%LOCALAPPDATA%\kiro-cli\data.sqlite3` + `%USERPROFILE%\.kiro\sessions\...` | IDE 真实 token（JSONL 用 mtime）；CLI 无真实 token → 4 chars/token（`:8451-8462`） |
| 8 | opencode | `:1510`；DB `:6105` | `%USERPROFILE%\.local\share\opencode\{storage\message\**,opencode.db}`（Windows 也走 XDG） | 消息 JSON + OpenCode SQLite |
| 9 | openclaw | `:1752` | `%USERPROFILE%\.openclaw\agents\<agent>\{sessions,session-sqlite-import-archive}\*.jsonl` + `openclaw-agent.sqlite` | 插件会话 JSONL |
| 10 | every-code（Every Code） | `:322` | `%USERPROFILE%\.code\sessions`（`CODE_HOME`） | Codex fork |
| 11 | hermes（Hermes Agent） | `:8244` | `%USERPROFILE%\.hermes\state.db`（+ `profiles\*\state.db`） | SQLite `sessions` 表 |
| 12 | copilot（GitHub Copilot） | `:18905`（OTEL）/`:19606`（session-store）/`:20408`（data.db） | `%USERPROFILE%\.copilot\session-store.db`（canonical）；`data.db` 仅 legacy；OTEL `%USERPROFILE%\.copilot\otel\*.jsonl` 或 `COPILOT_OTEL_FILE_EXPORTER_PATH` | 逐请求 SQLite；OTEL 文件 |
| 13 | kimi（旧版 Kimi） | `:9872` | `%USERPROFILE%\.kimi\sessions\<ws>\<sess>\wire.jsonl`（`KIMI_HOME`） | wire JSONL |
| 14 | kimi-code | `:10067` | `%USERPROFILE%\.kimi-code\sessions\**\wire.jsonl`（`KIMI_CODE_HOME`） | 递归 wire |
| 15 | codebuddy（CodeBuddy） | `:10510` | `%USERPROFILE%\.codebuddy\settings.json`（hook）+ `projects\**\*.jsonl` | Claude fork |
| 16 | workbuddy / workbuddy-ai | `:11235` | `%USERPROFILE%\.workbuddy`；AI 版 `%USERPROFILE%\.workbuddy-ai`（`WORKBUDDY_AI_HOME`） | Claude fork + JSONL |
| 17 | grok（Grok Build） | `:21111` | `%USERPROFILE%\.grok\sessions\<cwd>\<sid>\{updates.jsonl,signals.json}`（`TOKENTRACKER_GROK_HOME`/`GROK_HOME`） | 累计 `totalTokens`；无 prompt/output 拆分 → 估算 |
| 18 | kilo-cli（Kilo CLI） | `:6105`（OpenCode DB 解析器） | `%APPDATA%\kilo\kilo.db`；回退 `%USERPROFILE%\.local\share\kilo\kilo.db`（`sync.js:1697`） | OpenCode fork |
| 19 | kilocode（Kilo Code 扩展） | `:16173`；roots `:12275` | `%APPDATA%\{Code,Code - Insiders,Cursor,CodeBuddy,Windsurf,VSCodium,Trae,Trae CN}\User\globalStorage\kilocode.kilo-code\...` | VS Code globalStorage `ui_messages.json` |
| 20 | roocode（Roo Code） | `:12452`；roots `:12275` | 同上 `...\rooveterinaryinc.roo-cline\tasks\<uuid>\ui_messages.json` | VS Code 扩展 |
| 21 | zed（Zed Agent） | `:13278`；DB `:13118` | `%LOCALAPPDATA%\Zed\threads\threads.db`；mac `~/Library/Application Support/Zed/...`；Linux `~/.local/share/zed/...` | SQLite BLOB（json 或 zstd） |
| 22 | goose（Goose） | `:15232`；DB `:15117` | `%APPDATA%\goose\sessions\sessions.db`；mac Application Support；Linux XDG | SQLite 累计差量 |
| 23 | droid（Factory Droid） | `:15765`；dirs `:15425` | `%USERPROFILE%\.factory\sessions\**\settings.json` | 累计差量 |
| 24 | mimo（Mimo Code） | `sync.js:1746`；`install-resolver.js:91` | `%USERPROFILE%\.local\share\mimocode\mimocode.db`（`MIMO_HOME` 覆盖） | OpenCode fork；只算 mimo/providerID |
| 25 | dumate（DuMate） | `dumate.js:7` | `%APPDATA%\qianfan-desktop-app\qianfan_desk_xdg\*\data\opencode\opencode.db` | OpenCode fork；重装拷贝去重 |
| 26 | zcode（ZCode） | `sync.js:1810`；`install-resolver.js:58` | `%USERPROFILE%\.zcode\cli\db\db.sqlite`；Win 回退 `%APPDATA%\.zcode\...` | 只算 Z.ai/GLM 回合 |
| 27 | qoder（Qoder） | `:6562/6896`；DB `:6396` | DB：`%APPDATA%\Qoder\SharedClientCache\cache\db\local.db`；新 JSONL：`%USERPROFILE%\.qoder\projects` | SQLite `chat_turn` + JSONL |
| 28 | qoder-cn | `:6896`；DB `:6464` | DB：`%APPDATA%\QoderCN\SharedClientCache\cache\db\local.db`；`%USERPROFILE%\.qoder-cn\projects` | 独立 source |
| 29 | lmstudio | `:13895` | `%USERPROFILE%\.lmstudio\server-logs\**\*.log` | 日志文本里的 `usage`；本地推理 $0 |
| 30 | unsloth（Unsloth Studio） | `:14319` | `%USERPROFILE%\.unsloth\studio\studio.db`（`UNSLOTH_STUDIO_HOME`/`TOKENTRACKER_UNSLOTH_DB`） | SQLite |
| 31 | anythingllm（AnythingLLM Desktop） | `:14566` | `%APPDATA%\anythingllm-desktop\storage\anythingllm.db`；mac Application Support；Linux XDG config | SQLite 逐消息 |
| 32 | devin（Devin CLI） | `:14835` | 无原生 Win 目录；WSL `~/.local/share/devin/cli/sessions.db` | SQLite 逐请求；模型无价 → 只算 token |
| 33 | cline（Cline CLI/desktop） | `:12828`；dir `:12652` | `%USERPROFILE%\.cline\data\sessions\<id>\*.messages.json` | 逐轮 metrics 差量；input 含 cache+reasoning |
| 34 | minimax-code | `:17403`；home `:17355` | `%USERPROFILE%\.minimax\v2\sessions\YYYY\MM\DD\<sess>\messages.jsonl` | `message_id` 去重 |
| 35 | command-code（Command Code） | `:25485`；home `:25112` | `%USERPROFILE%\.commandcode\projects\<cwd-slug>\<session>.jsonl` | 跳过 checkpoints/prompts 旁文件 |
| 36 | claude-science | `:7395`；DB `:7258` | `%USERPROFILE%\.claude-science\operon-cli.db`；Win 仅 WSL | SQLite `frames` |
| 37 | dsh（DeepSeek Harness） | `:24705`；files `:23908` | `%USERPROFILE%\.dsh\sessions\<proj>\<sess>\session[.v3].jsonl[.zstd]` | 多帧 zstd |
| 38 | trae（TRAE / TRAE SOLO） | `:23060`；`trae-db.js:13` | `%APPDATA%\Trae\ModularData\{ai-agent,ai-chat}\database.db`；`%APPDATA%\TRAE SOLO\...` | SQLCipher 页解密 + wa-sqlite（`:23208` 候选目录） |
| 39 | trae-cn（TRAE Work CN） | `:23625` | 本机登录态 → TRAE 内部 API；**显式 opt-in** `TOKENTRACKER_TRAE_CN_USAGE=1` | 网：账户级，非日志 |
| 40 | prime-agent（Prime Agent） | `:17327` | `%USERPROFILE%\.prime\agent\sessions\*.jsonl` | metadata-only |
| 41 | craft（Craft Agents） | `:18107`；dirs `:17458` | `%USERPROFILE%\.craft-agent\workspaces\<ws>\sessions\<id>\session.jsonl` | JSONL |
| 42 | reasonix | `:17678`；files `:17569` | `%USERPROFILE%\.reasonix\**\*.jsonl.telemetry.json` | telemetry JSONL |
| 43 | muse（Muse Code） | `:17873`；home `:17732` | `%USERPROFILE%\.local\share\muse\sessions\**\session.jsonl`（`TOKENTRACKER_MUSE_HOME`） | JSONL |
| 44 | omp（oh-my-pi） | `:16715`；home `:11980` | `%USERPROFILE%\.omp\agent\sessions\**\*.jsonl` | JSONL；notify 扩展（不迁移） |
| 45 | omo（OmO） | `:16728`；home `:12210` | `%USERPROFILE%\.omo\agent\sessions\**\*.jsonl` | JSONL；reasoning 是 output 子集 |
| 46 | pi（+Dots） | `:16947`；home `:16757` | `%USERPROFILE%\.pi\agent\sessions\**\*.jsonl` | JSONL；Dots 走 `pi-dots` 来源拆分 |

> 另有 5 个历史/别名 source：`github-copilot-legacy`（App DB 一次性基线）、`trae-cn` 的 session-state 修正流、`every-code`/`acode`（Codex fork）、`droid` 的 dup-session 修复；见 `T/src/lib/source-metadata.js:1-3` 与 `T/src/commands/sync.js:328-390` 的来源别名表。

### 1.3 路径发现、权限与 Windows 特有约束

- **发现顺序**（`T/src/lib/scan-roots.js:163-210`）：① 代码内 native 默认目录；② 进程环境 `CODEX_HOME` / `CLAUDE_CONFIG_DIR`；③ `~/.tokentracker/tracker/config.json` 的 `scanRoots.<provider>[]`。三者按 realpath 去重；「存在但不可读」与「不存在」被区分开（`:99-125`），不可读必须报错而不是静默跳过。
- **Windows 路径要点**：
  - 点目录 = `%USERPROFILE%\.xxx`；Roaming 应用 = `%APPDATA%\<App>`；Local 应用 = `%LOCALAPPDATA%\<App>`。Qoder/Cursor/AnythingLLM/Goose/Zed/Trae 都按此分流（`rollout.js:6396-6418,13118-13140,14436-14455,15117-15135,20580-20592`；`cursor-config.js:10-31`）。
  - OpenCode/Mimo/Kilo 等 Node CLI 在 Windows 也遵循 XDG：`%USERPROFILE%\.local\share\<tool>`（`T/src/lib/install-resolver.js:85-113` 注释明确 `%APPDATA%` 不是它们的路径）。
  - VS Code 系扩展：`%APPDATA%\<IDE>\User\globalStorage\<extension>`，IDE 候选含 Code / Code - Insiders / Cursor / CodeBuddy / Windsurf / VSCodium / Trae / Trae CN（`rollout.js:12275-12340`）。
  - Kiro IDE：`%APPDATA%\Kiro\...`（`rollout.js:7624-7640`）；Kiro CLI 的 Windows 路径在源码中标注 **speculative**（`rollout.js:8465-8480`，产物是 `%LOCALAPPDATA%\kiro-cli\data.sqlite3`）。
  - WSL：`\\wsl$\<distro>\...` / `\\wsl.localhost\...`；SQLite 在 UNC 上易锁，TT 会先**复制 DB+sidecar 快照**再读（`rollout.js:7655-7658,8045`；`wsl-probe.js`）。
  - macOS/Linux 通用差异：CLI 工具用点目录（`~/.claude`、`~/.codex`、`~/.kimi` 等，与 Windows 的 `%USERPROFILE%\.xxx` 一一对应）；GUI 应用用 macOS `~/Library/Application Support/<App>`、Linux `$XDG_CONFIG_HOME`/`$XDG_DATA_HOME`（默认 `~/.config`、`~/.local/share`）。Cursor/Qoder/AnythingLLM/Goose/Zed/TRAE 在 `rollout.js` 内均按 `process.platform` 显式分支（如 `:6396-6418,13118-13140`）。
- **权限/只读**：
  - 所有日志读取均为只读：SQLite 用 `new DatabaseSync(path,{ readOnly:true })` 或 `sqlite3 -readonly`（`T/src/lib/sqlite-reader.js:41-58,67-79`；本机实测 readOnly 拒绝写入，§6.1）。
  - 需写明「禁止写工具目录」：TT 的写操作只发生在自己的 `~/.tokentracker` 与 hook 安装（`init.js`），迁移版**只保留读**。
  - 正在运行的工具会持有 SQLite WAL；读取策略：只读打开 → `SQLITE_BUSY` 时重试/稍后；UNC 先快照；Antigravity 会连同 `-wal/-shm` 复制读取视图（`rollout.js:22585-22620`）。
  - 读不到（EACCES/EPERM）与不存在（ENOENT）必须区分上报，用于设置页「检测状态」（`scan-roots.js:99-125`）。
- **环境变量覆盖（可用于 Highlighter 设置页的“自定义路径”）**：`CODEX_HOME`、`CLAUDE_CONFIG_DIR`、`GEMINI_HOME`、`TOKENTRACKER_ACODE_HOME`、`CODE_HOME`、`KIMI_HOME` / `KIMI_CODE_HOME`、`TOKENTRACKER_GROK_HOME`/`GROK_HOME`、`TOKENTRACKER_LMSTUDIO_HOME`、`TOKENTRACKER_MUSE_HOME`、`TOKENTRACKER_CLINE_*`、`TOKENTRACKER_MINIMAX_HOME`、`TOKENTRACKER_COMMANDCODE_HOME`、`TOKENTRACKER_DSH_HOME`/`DSH_HOME`、`TOKENTRACKER_TRAE_HOME`/`TOKENTRACKER_TRAE_DB`、`QODER_HOME`/`QODER_DB_PATH`、`TOKENTRACKER_ZED_DB`、`TOKENTRACKER_DEVIN_DB`、`TOKENTRACKER_OMP_HOME`/`OM`、`TOKENTRACKER_OMO_HOME`、`MIMO_HOME`、`ZCODE_HOME`、`UNSLOTH_STUDIO_HOME`（`T/README.md:374-400`；各 resolver 内同名变量）。

### 1.4 统一事件模型

队列行（`T/CLAUDE.md:66-80`；`rollout.js:3630-3687` 写入处）：

```json
{"source":"claude","model":"claude-opus-4-6","hour_start":"2026-04-05T14:00:00Z",
 "input_tokens":0,"cached_input_tokens":0,"cache_creation_input_tokens":0,
 "output_tokens":0,"reasoning_output_tokens":0,"total_tokens":0,
 "billable_total_tokens":0,"total_cost_usd":0,"conversation_count":1,
 "usage_precision":"estimated","priority_*_tokens":[],"long_context_*_tokens":[]}
```

| 字段 | 语义 | 证据 |
|---|---|---|
| `hour_start` | UTC 半小时桶起点（`:00/:30`） | `rollout.js:4517-4535` |
| `source` | 工具标识（上表 46 类） | `source-metadata.js:1-3` |
| `model` | 模型 id，未知写 `unknown` | `rollout.js:4566-4570` |
| `input_tokens` | **非缓存**输入（Codex 类需减 cache） | `T/CLAUDE.md:54-61` |
| `cached_input_tokens` / `cache_creation_input_tokens` | 缓存读 / 缓存写 | 同上 |
| `output_tokens` | 输出（Claude 已扣除 reasoning） | `rollout.js:5270-5288` |
| `reasoning_output_tokens` | Codex/OMO/Cline 等为 output 子集，不二次计费 | `pricing/index.js:248-258` |
| `billable_total_tokens` | 计入“总用量”的数 | `local-api.js:277-289` |
| `total_cost_usd` | Grok/Cline 的权威成本（正数优先） | `pricing/index.js:32,238-241` |
| `conversation_count` | **事件/回合数**，非去重会话 | `rollout.js:2204,4278,9952` 等 |
| `usage_precision` | `estimated` 表示文本估算（Antigravity / Kiro CLI / Grok） | `rollout.js:23052,23184` |

### 1.5 增量扫描、去重与状态文件

**增量机制（必须迁移的核心）**
- 文件游标：`cursors.files[path] = { inode, offset, size, mtimeMs, hashes }`，每个文件只读新追加的字节；容量超 16 MB 后迁移到 `cursor-store-v2/`（manifest + generations + `core-v3.json` 分片），逐代切换、原子提交（`T/src/lib/cursor-store.js:13-21,27-190`）。
- 各 provider 专属游标：Codex `codexHashes` / per-day inventory cache（`rollout.js:91-160`）；Kiro `lastDbId` + JSONL `lastLine`（`:7816-7890`）；Kimi `seenIds`；Copilot DB 行指纹；Hermes `lastCompletedEpoch` + 未完成 session id（`:8088-8105`）；Unsloth `created_at+id` 位置；Zed 线程行位置等（以 parser 内 SQL 为准）。
- 大文件/大目录：`readline` 流式（Kiro CLI 字符统计 `:8575-8590` 注释 TASK-005）、`physicalJsonlRecords` 只按 LF 切分并限制单行字节/非法 UTF-8（`T/src/lib/jsonl-lines.js:1-80`）、目录并发 32（`rollout.js:70-88`）、Codex 按天 inventory 缓存避免重复 stat。
- 提交：所有 parser 在 `sync.lock` 下修改游标，结束统一 `cursorStore.commit()`；上传偏移 `queue.state.json` 按字节推进（`sync.js:444-475,4400-4490`）。

**去重层次**
1. 文件级：同一文件在 native/WSL 双路径出现 → 内容 hash 跳过整份（`rollout.js:1119-1130` 注释）。
2. 消息级：Claude `msgId:reqId`（`:5258-5263`）；Claude hash 上限 100k 条，超出淘汰最旧（`:1334-1335`）。
3. 会话快照级：保存 `sessionTotals` 只取增量；累计型日志（Codex）单独处理（`:3380-3520`）。
4. 副本级：OpenCode fork 复制父会话 → fingerprint 标记 `dedupedForkCopy`（`:3426-3459`）。
5. 来源级：Mimo 镜像 Claude、CodeBuddy/WorkBuddy fork、OMP/OMO 同构 → 按 providerID/来源标签剔除（`T/CLAUDE.md:196-203`）。
6. 桶级：队列 append-only，一个 `(source,model,hour)` 多次重发累计值，读取取最新；上传批次内按 key 取 `total_tokens` 最大（`tokentracker-ingest.ts:196-210`）。

**压缩与编码**
- Codex：`rollout-*.jsonl.zst/.zstd`；解压支持多帧（`rollout.js:91-99,193-197`；`codex-rollout-parser.js:48,1209,1349`）。
- DeepSeek Harness：`session[.vN].jsonl[.zstd]`，多帧 zstd（`rollout.js:23825-23860,23894`）。
- Zed：SQLite BLOB `data_type="zstd"` 用 `zlib.zstdDecompressSync`，Node 20 回退 `@mongodb-js/zstd`，并限制解压体积（`rollout.js:13142-13168`）。
- 无 zip/tar 日志；`yauzl` 只用于宠物包导入（`pet-packages.js:5,192`），与用量无关。

### 1.6 SQLite 源库读取

- `sqlite-reader.js` 统一两种后端：外部 `sqlite3` CLI（`-readonly -json`）优先，失败回退 `node:sqlite DatabaseSync({readOnly:true})`（`:41-146`）；超时 30s、maxBuffer 50MB。
- 目标库 schema **不在 TT 内定义**，而是运行期探测：如 Kiro `SELECT id,model,provider,tokens_prompt,tokens_generated,timestamp FROM tokens_generated`（`rollout.js:7650-7656`）；Hermes `sessions(...)`（`:8088-8105`）；Qoder `chat_turn` + `PRAGMA table_info`（`trae-db.js:60-80`）；Zed `threads.db`；Goose/Devin/AnythingLLM/Unsloth/Copilot/Mimo/ZCode/Kilo 均为 OpenCode 系或自家 schema，由 parser 内 SQL 决定。
- 因只读且不建索引，查询依赖工具自身主键/rowid 与时间列；大数据量时按 id/时间做增量条件（避免全表扫）。
- SQLCipher：TRAE 的库需要页级 AES-256-CBC 解密（`trae-snapshot.js:1-80`），再用 wa-sqlite 的只读 VFS 在内存中打开（`trae-sqlite.js:1-80`）。

---

## 2. 本地“存储层”的真实形态（TT 现状）

| 项 | 事实 | 证据 |
|---|---|---|
| 用量历史 | `~/.tokentracker/tracker/queue.jsonl` | `local-api.js:84-88` |
| 项目历史 | `project.queue.jsonl` | `rollout.js:3833-3888` |
| 扫描状态 | `cursors.json` 或 `cursor-store-v2/` | `cursor-store.js` |
| 上传偏移 | `queue.state.json` | `sync.js:4400-4490` |
| 会话 sidecar | `session.queue.jsonl`（metadata-only） | `session-analytics.js:117` |
| 本机实测体积 | queue 252 KB / 796 行 ≈ **316 B/行**；`cursors.json` 7.9 MB；project queue 138 KB | 本机 `~/.tokentracker/tracker/` 目录实测 |
| 本地查询方式 | **无 SQL**；每次请求把整个 JSONL 读进内存聚合并按 pricing 现算 | `local-api.js:228-350,2403-2468` |
| 云端库 | Postgres `tokentracker_hourly` PK `(user_id,device_id,hour_start,source,model)` | `T/scripts/self-host/baseline.sql:38-57` |

> 结论：迁移到 Highlighter 时应**用 SQLite 替换 JSONL 全量重放**，但保留“半小时桶 + 读取取最新”的数据语义。

---

## 3. 服务层与 dashboard 取数（迁移只参考、不复用）

- `serve` 监听 `127.0.0.1:7680`（WSL 7681），本地端点 `/functions/tokentracker-*`，dashboard 同源 `fetch`（无 SSE、无 BOOTSTRAP），30s 自适应轮询（`T/src/commands/serve.js:16-23,148-190`；`T/dashboard/src/lib/api.ts:184-243`；`T/dashboard/src/lib/local-usage-auto-refresh.ts:3-8`）。
- 请求参数：`from/to` + `tz`（IANA）+ `tz_offset_minutes`；服务端用 `Intl.DateTimeFormat` 落本地日，非法 tz 回退固定偏移/UTC（`local-api.js:513-599`；`api.ts:245-252`）。
- 云端 account-* 与 local 端点 schema 对齐，但走 Postgres RPC + JWT（`dashboard/edge-patches/tokentracker-account-summary.ts:1-30`）。
- **Highlighter 不需要 HTTP 层**：IPC 直接调用主进程聚合函数即可（见 §6.2）。保留上述时区/范围参数语义即可。

---

## 4. 指标口径（迁移必须复述准确的清单）

1. **周期**：日=当天；周=周一 00:00 起 7 天；月=自然月；总计=最近 24 个月；自定义=任选（`T/dashboard/src/lib/date-range.ts:49-89`）。
2. **总 TOKEN**：显示 `billable_total_tokens`（缺省回退 `total_tokens`），不是 `total_tokens`（`DashboardPage.jsx:101-109,1146-1149`；`local-api.js:277-289`）。
3. **美元**：`Σ computeRowCost(row)`，公式 = `(input×p_in + output×p_out + cache_read×p_cache_read + cache_write×p_cache_write + reasoningCost)/1e6`；成本**绝不用 total_tokens 推**（`pricing/index.js:227-353`；`CLAUDE.md:63-64`）。
4. **缓存**：cache read 与 cache write 分别按各自单价计费；某来源无单价则 $0。**reasoning**：Claude 单列计费（output 已扣），Codex/OMO/Cline/Muse 是 output 子集不重复计（`pricing/index.js:248-258`）。
5. **成本时点**：TT 在**读取时**用当前价格重算 → pricing 更新会改变历史金额（`local-api.js:121-124`）。这是迁移时必须显式决策的口径。
6. **每日明细列**：日期、total（显示 billable）、input、output、cached input、reasoning、conversations；**不含 cache write 与成本**（`T/dashboard/src/lib/daily.ts:6-34`；`DashboardPage.jsx:760-770`）。
7. **会话数**：`conversation_count` = 解析事件数（每条消息/回合/请求 +1），不是去重会话（`rollout.js:2204,4278,9952`）。
8. **项目用量**：独立 `project.queue.jsonl`，`project_key`=GitHub owner/repo（GitLab 保留完整组路径），Top 10 按 billable 降序；无数据降级为按 source 聚合（`rollout.js:4773-4786`；`local-api.js:2776-2873`）。
9. **热力图**：52 周 × 7 天，cell 值=billable；level 为**区间最大值相对四档**（≤25/50/75% →1/2/3，>75%→4），0 无活动；2D 颜色 light `#ebedf0/#a7f3d0/#6ee7b7/#34d399/#10b981`（`local-api.js:2586-2600`；`ActivityHeatmap.jsx:17-30`）。
10. **趋势“预测值”**：只是缺失/未来桶的视觉插值——有两侧观测→线性插值，只有单侧→观测均值 × 每步 **0.98** 衰减，半透明显示（`TrendMonitor.jsx:336-400`）；不是历史预测模型。
11. **滚动 7/30 天**：按今天往前 7/30 个自然日，`active_days`=有量天数（`local-api.js:2451-2468`）。
12. **性价比卡（可选）**：`accepted / cost_usd`，卡片展示 `cost/accepted`，依赖 `outcomes.jsonl` sidecar（`outcomes-engine.js:1-18,160-200`；`QualityPerDollarCard.jsx:18-27`）。迁移时可延后（需 git 归因）。

---

## 5. 数据质量与已知坑

| 问题 | 说明/证据 |
|---|---|
| Codex input 含 cache | 旧行按 `total==input+output` 启发式修复（`local-api.js:156-170`） |
| Cursor/Antigravity billable=0 | 读取时上调为 total（`:184-205`） |
| 去重键缺陷 | 只判 `msgId&&reqId` 会漏 DeepSeek/Kimi 等，过计 1.6–3.7×（`T/CLAUDE.md:192-194`） |
| hash 上限 | `claudeHashes` >100k 丢最旧 → 重扫重复计数（`rollout.js:1334-1335`） |
| 镜像源重复 | Mimo>99% 是 Claude 镜像；必须按 providerID 过滤（`T/CLAUDE.md:196-203`） |
| 多 device_id 漂移 | 云端同一机器多 id → 2×；靠 machine cluster 内 max 修复（`account-usage-grouped-rpc.sql:150-183`）——单机不需要 |
| 修复式重扫丢数据 | 0.26.3 原子删除+重扫曾抹掉 2.17B tokens（`sync.js:241-248` 注释） |
| 估算 token | Kiro CLI/Antigravity/Grok 无真实拆分，误差大，必须标 `estimated`（`rollout.js:8451-8462,22998-23016`） |
| 审计脚本 | 校验 `total = input+output+cache_read+cache_write(+reasoning 视来源)`、重复 key、malformed 行（`T/scripts/audit-token-correctness.cjs:52-172`） |

---

## 6. 迁移到 Highlighter 主进程 + 本地 SQLite

### 6.1 可复用模块与依赖评估（含本机实测）

**可直接搬（MIT，署名即可）**
- `T/src/lib/rollout.js`（25,966 行，46 解析器 + 桶累加/去重核心）。
- 其内部依赖图共 **20 个文件 / 29,690 行**（node 脚本实测）：`claude-user-identity, codex-model-attribution, codex-service-tier, codex-token-usage, codex-usage-record, cursor-config, devin-usage, fs, grok-usage, install-resolver, jsonl-lines, rollout, scan-roots, sqlite-reader, tracker-paths, trae-db, trae-snapshot, trae-sqlite, trae-usage, wsl-probe`。
- pricing：`T/src/lib/pricing/{index,matcher,litellm-fetcher}.js` + `curated-overrides.json` + `seed-snapshot.json`（2,200+ 模型离线兜底）。
- 状态/路径：`cursor-store.js`（或简化为 SQLite 状态表）、`scan-roots.js`、`install-resolver.js`、`wsl-probe.js`。
- 可选：`claude-categorizer.js`（Claude 七分类）、`session-analytics.js`、`outcomes-engine.js` + `git-outcomes.js`（性价比卡，二期）。

**不搬**：`local-api.js` / `serve.js`（HTTP 层）、`sync.js` 的云上传/修复迁移/telemetry/sentry、hook 安装（`init.js`/`uninstall.js`）、dashboard、桌宠/排行榜/成就。

**依赖评估**

| 依赖 | TT 用途 | 迁移结论 |
|---|---|---|
| `@mongodb-js/zstd` | Node 20 的 zstd 回退 | **去掉**：Electron 43.2.0 内置 Node 24.18，实测 `zlib.zstdDecompressSync` 存在且 `zstdCompressSync` 往返成功 |
| `node:sqlite` | 源库与 TRAE 快照读取 | **直接用**：实测 `DatabaseSync`、WAL、事务、`readOnly:true` 全部可用，SQLite **3.53.1**（在 Electron 运行时执行脚本验证） |
| `wa-sqlite` | 仅 TRAE：解密页快照的内存 VFS | **v2 可选**。TRAE 的 SQLCipher 解密在 `trae-snapshot.js`（纯 crypto），可改为「解密 → 临时明文 db → node:sqlite」以避免 WASM 依赖（**未验证**）；v1 不做 TRAE 即可零依赖 |
| `undici` | 代理/云上传/fetch 兼容 | **不需要**：只读采集不联网；可选价格刷新用全局 `fetch` |
| `smol-toml` | Kimi `config.toml` 默认模型、hook 安装 | **可去掉**：仅影响 Kimi 默认模型兜底，可硬编码或极简解析（**未验证** Kimi 是否必须） |
| `yauzl` | 宠物包 zip | **不需要** |
| `@sentry/node` | 错误上报 | **不需要**（Highlighter 有自家 diagnostics） |
| 外部 `sqlite3` CLI | 源库读取首选 | **不需要**：强制走 `node:sqlite` 分支即可 |

> 结论：**v1 零新增 npm 依赖**，只需把 TT 的 MIT 文件 vendored 到 `H/main/vendor/tokentracker/`，并在 `H/docs/third-party/README.md` 增加 MIT 版权声明与完整许可文本（Highlighter 已有该目录与 Apache-2.0 先例）。

### 6.2 集成架构（Highlighter 侧）

```
main/vendor/tokentracker/            ← 原样 vendor（rollout.js + 19 helpers + pricing/）
main/services/usage-store.js         ← node:sqlite 打开/迁移/upsert/查询（唯一 writer）
main/services/usage-collector.js     ← 扫描编排：发现根→逐个 parser→enqueue→写库；单飞锁 + 5min 定时 + 窗口聚焦触发
main/ipc/usage-ipc.js                ← secureIpcMain.handle('usage:summary'|'usage:daily'|'usage:models'|'usage:heatmap'|'usage:refresh'|'usage:status')
main.js                              ← 仅 assembly：require collector/store + registerUsageIpc + startApplication 内启动（受 1330 行架构上限约束）
```
证据：Highlighter 现有装配模式 `H/main.js:24-90,463,945,1182`；IPC 注册范式 `H/main/ipc/settings-ipc.js:1-30`；架构门禁 `H/scripts/check-architecture.js:25`；语法检查 `H/scripts/check-js.js`（`node --check`）。

- **只读原则**：不安装 hook、不写任何工具目录；扫描失败只更新 `source_status`。
- **调度**：启动后延迟 5–10s 首扫（避开启动高峰）；之后每 5 分钟 + 设置窗口打开时触发；单飞（同一时刻仅一个 scan），增量游标使单次扫描很快。
- **WSL**：v1 关闭（可选设置项），避免 `wsl.exe` 探测阻塞/弹窗；v2 再移植 `wsl-probe.js`。
- **网络**：默认全离线；Cursor / TRAE Work CN / Grok 配额等联网来源默认关闭，需用户显式 opt-in（与 TT 的隐私策略一致，`T/docs/PRIVACY.md`）。
- **数据目录**：新增 `usage/usage.db` 到数据根；必须同步修改 `H/main/services/data-root.js:13-34`（createDataPaths）与 `H/main/services/data-root-migration.js:29`（MANAGED_DIRECTORIES），否则换目录迁移会漏掉用量库。

### 6.3 SQLite DDL 草案（本机日志用量）

```sql
PRAGMA journal_mode = WAL;        -- 实测可用
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 3000;
PRAGMA user_version = 1;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL, note TEXT
);

-- 与 TT queue.jsonl 同语义：半小时桶累计快照，主键即 LWW 键
CREATE TABLE IF NOT EXISTS usage_bucket (
  source                 TEXT NOT NULL,
  model                  TEXT NOT NULL,
  hour_start             TEXT NOT NULL,              -- ISO UTC 'YYYY-MM-DDTHH:MM:00Z'
  input_tokens           INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens    INTEGER NOT NULL DEFAULT 0, -- cache read
  cache_creation_tokens  INTEGER NOT NULL DEFAULT 0, -- cache write
  output_tokens          INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens       INTEGER NOT NULL DEFAULT 0,
  total_tokens           INTEGER NOT NULL DEFAULT 0,
  billable_total_tokens  INTEGER NOT NULL DEFAULT 0,
  conversation_count     INTEGER NOT NULL DEFAULT 0,
  total_cost_usd         REAL NOT NULL DEFAULT 0,
  usage_precision        TEXT,                       -- NULL | 'estimated'
  updated_at             TEXT NOT NULL,
  PRIMARY KEY (source, model, hour_start)
);
CREATE INDEX IF NOT EXISTS idx_usage_hour        ON usage_bucket(hour_start);
CREATE INDEX IF NOT EXISTS idx_usage_source_hour ON usage_bucket(source, hour_start);
CREATE INDEX IF NOT EXISTS idx_usage_model_hour  ON usage_bucket(model, hour_start);

-- 项目维度（TT project.queue.jsonl 的等价物；不需要项目卡可暂不建）
CREATE TABLE IF NOT EXISTS project_bucket (
  project_key TEXT NOT NULL, project_ref TEXT,
  source TEXT NOT NULL, hour_start TEXT NOT NULL,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  billable_total_tokens INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  conversation_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_key, source, hour_start)
);

-- 扫描状态：每个文件/DB 的 inode+offset+size+mtime+hash，或 provider 自定义 id
CREATE TABLE IF NOT EXISTS scan_state (
  key   TEXT PRIMARY KEY,        -- 'file:<path>' | 'kiro:lastDbId' | 'codex:hashes' ...
  value TEXT NOT NULL            -- JSON
);

CREATE TABLE IF NOT EXISTS source_status (
  source          TEXT PRIMARY KEY,
  detected        INTEGER NOT NULL DEFAULT 0,
  last_scan_at    TEXT, last_error TEXT, detail TEXT
);

CREATE TABLE IF NOT EXISTS model_price (
  model TEXT PRIMARY KEY,
  input REAL DEFAULT 0, output REAL DEFAULT 0,
  cache_read REAL DEFAULT 0, cache_write REAL DEFAULT 0,
  source TEXT, updated_at TEXT
);

CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

> 成本策略二选一：A）写入时用当前价格算好 `total_cost_usd`（简单，价格更新后历史不变）；B）保存 token 桶、查询时用 `model_price` 现算（TT 现状，价格更新会改历史金额）。建议 A + 后台「价格刷新后重算」按钮（口径可解释）。

### 6.4 核心聚合查询（伪 SQL，SQLite 方言）

```sql
-- Q1 区间总览（映射 usage-summary.totals）
SELECT COUNT(*) rows, SUM(billable_total_tokens) billable_total_tokens,
       SUM(total_tokens) total_tokens, SUM(input_tokens) input_tokens,
       SUM(output_tokens) output_tokens, SUM(cached_input_tokens) cached_input_tokens,
       SUM(cache_creation_tokens) cache_creation_input_tokens,
       SUM(reasoning_tokens) reasoning_output_tokens, SUM(total_cost_usd) total_cost_usd,
       SUM(conversation_count) conversation_count
FROM usage_bucket WHERE hour_start >= :from_bucket AND hour_start < :to_bucket;

-- Q2 日序列（本地时区；:tz_offset_minutes 由主进程按用户时区/DST 计算传入）
SELECT date((julianday(hour_start) - 0.5 + :tz_offset_minutes/1440.0)) AS day,
       SUM(billable_total_tokens) billable_total_tokens, SUM(total_tokens) total_tokens,
       SUM(input_tokens) input_tokens, SUM(output_tokens) output_tokens,
       SUM(cached_input_tokens) cached_input_tokens,
       SUM(cache_creation_tokens) cache_creation_input_tokens,
       SUM(reasoning_tokens) reasoning_output_tokens,
       SUM(total_cost_usd) total_cost_usd, SUM(conversation_count) conversation_count
FROM usage_bucket WHERE hour_start >= :from_bucket AND hour_start < :to_bucket
GROUP BY day ORDER BY day;

-- Q3 模型/provider 占比（映射 usage-model-breakdown）
SELECT source, model, SUM(billable_total_tokens) billable_total_tokens,
       SUM(total_cost_usd) usd, SUM(conversation_count) events
FROM usage_bucket WHERE hour_start >= :from_bucket AND hour_start < :to_bucket
GROUP BY source, model ORDER BY billable_total_tokens DESC;

-- Q4 来源占比（用量页 provider 卡）
SELECT source, SUM(billable_total_tokens) tokens, SUM(total_cost_usd) usd,
       ROUND(100.0*SUM(billable_total_tokens) /
             (SELECT SUM(billable_total_tokens) FROM usage_bucket
              WHERE hour_start >= :from_bucket AND hour_start < :to_bucket), 2) share_pct
FROM usage_bucket WHERE hour_start >= :from_bucket AND hour_start < :to_bucket
GROUP BY source ORDER BY tokens DESC;

-- Q5 52 周热力图 + 相对四档 level
WITH daily AS (
  SELECT date(julianday(hour_start) - 0.5 + :tz_offset_minutes/1440.0) AS day,
         SUM(billable_total_tokens) v
  FROM usage_bucket WHERE hour_start >= :from52w_bucket GROUP BY day),
mx AS (SELECT MAX(v) m FROM daily WHERE v > 0)
SELECT d.day, d.v,
       CASE WHEN d.v<=0 THEN 0
            WHEN (SELECT m FROM mx)=0 THEN 1
            WHEN 1.0*d.v/(SELECT m FROM mx) <= 0.25 THEN 1
            WHEN 1.0*d.v/(SELECT m FROM mx) <= 0.50 THEN 2
            WHEN 1.0*d.v/(SELECT m FROM mx) <= 0.75 THEN 3
            ELSE 4 END AS level
FROM daily d ORDER BY d.day;

-- Q6 滚动 7/30 天（active_days / 日均）
SELECT COUNT(DISTINCT day) active_days, SUM(v) billable_total_tokens,
       CAST(ROUND(1.0*SUM(v)/NULLIF(COUNT(DISTINCT day),0)) AS INTEGER) avg_per_active_day
FROM (SELECT date(julianday(hour_start) - 0.5 + :tz_offset_minutes/1440.0) day,
             SUM(billable_total_tokens) v
      FROM usage_bucket WHERE hour_start >= :from_bucket GROUP BY day);

-- Q7 日视图小时序列（半小时桶 → 本地小时）
SELECT substr(hour_start,1,10)||'T'||printf('%02d',
         (CAST(substr(hour_start,12,2) AS INTEGER) + :tz_offset_minutes/60 + 24) % 24)||':00:00' AS hour,
       SUM(billable_total_tokens) billable_total_tokens, SUM(total_cost_usd) total_cost_usd,
       SUM(conversation_count) conversation_count
FROM usage_bucket WHERE hour_start >= :day_from AND hour_start < :day_to
GROUP BY hour ORDER BY hour;

-- Q8 项目 Top10（可选；无项目数据时按 source 降级）
SELECT project_key, SUM(billable_total_tokens) billable_total_tokens,
       SUM(total_cost_usd) usd, SUM(conversation_count) events
FROM project_bucket WHERE hour_start >= :from_bucket AND hour_start < :to_bucket
GROUP BY project_key ORDER BY billable_total_tokens DESC LIMIT 10;

-- Q9 写入（LWW upsert，语义同 TT“读取最新一行”）
INSERT INTO usage_bucket (source,model,hour_start,input_tokens,cached_input_tokens,
  cache_creation_tokens,output_tokens,reasoning_tokens,total_tokens,billable_total_tokens,
  conversation_count,total_cost_usd,usage_precision,updated_at)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(source,model,hour_start) DO UPDATE SET
  input_tokens=excluded.input_tokens, cached_input_tokens=excluded.cached_input_tokens,
  cache_creation_tokens=excluded.cache_creation_tokens, output_tokens=excluded.output_tokens,
  reasoning_tokens=excluded.reasoning_tokens, total_tokens=excluded.total_tokens,
  billable_total_tokens=excluded.billable_total_tokens,
  conversation_count=excluded.conversation_count, total_cost_usd=excluded.total_cost_usd,
  usage_precision=excluded.usage_precision, updated_at=excluded.updated_at;
```

### 6.5 迁移、版本化与数据目录

- 迁移器：启动时读 `PRAGMA user_version`/`schema_migrations`，逐版本执行幂等 DDL（事务内），完成后写版本；参考 TT `cursor-store` 的“原子代切换”思路，但 SQLite 单库事务足够。
- 首次初始化：建库 + 导入内置 `seed-snapshot.json` 到 `model_price`（或在查询时读 JS 内存表，减少一张表）；扫描状态为空 → 首扫全量（大用户可能几分钟，放后台低优先级）。
- 数据目录：`usage/usage.db`（WAL）→ 必须在 `data-root.js`/`data-root-migration.js` 两处登记；写库仅主进程，渲染层经 IPC 读；退出时 `db.close()`。
- 测试：把解析/聚合做成纯函数（`rows → daily/summary`）注入 fixture 目录（TT 已有大量 `test/*` 用例与 `test/fixtures` 可作为移植基准）；Highlighter 覆盖率门槛 85%（`H/package.json:13-17`）。

### 6.6 单机体积与留存估算

- 已知换算：TT JSONL ≈ **316 B/行**（实测）；SQLite 桶行（含索引）估计 200–350 B/行。桶行数 ≈ 工具数×模型数×每天 48 桶（实际远小：每天活跃 hour 通常 <20）。
- 典型重度单机（10 工具/20 模型/每天 15 个活跃半小时桶 ≈ 300 行/天）→ **约 10 万行/年、30–50 MB/年**；轻度 ≈ 3–8 MB/年。
- 建议：桶表永久保留（体积可控）；`scan_state` 每文件一条（几万文件也只是几 MB）；`project_bucket` 可选；每月 `PRAGMA optimize`/季度 `VACUUM`；日志文件本身不复制、不缓存原始行（只存解析后的数字）。

---

## 7. 可直接照搬 vs 必须调整

| 项 | 结论 |
|---|---|
| 46 工具解析器 + 路径发现 + 文件游标/去重 | **直接移植**（MIT，需署名；去掉 hook/上传） |
| token 字段语义、半小时 UTC 桶、`(source,model,hour)` LWW | **直接照搬** |
| pricing 三层 + `computeRowCost` 公式 + DeepSeek 峰谷 | **直接照搬**（建议冻结成本，见 6.3） |
| 时区/范围/周期/明细列/会话数/热力图 level/滚动 7/30 | **直接照搬** |
| 项目用量 | **可选照搬**（`project.queue` 解析依赖 git remote，需确认 Highlighter 隐私策略） |
| 会话效率卡、性价比卡、成就/热力 3D | **不迁移 v1**（依赖额外 sidecar/git，非核心 KPI） |
| 多设备合并（machine cluster）、账户级去重、云同步、排行榜、原生 widget/menu-bar | **不迁移**（单机无此问题） |
| 联网来源（Cursor API、TRAE Work CN、Grok 配额） | **默认关闭**，用户显式 opt-in；OAuth/凭据读取不迁移 |
| 估算口径（Kiro CLI 4 chars/token、Antigravity 文本估算） | **保留并标注 `estimated`**，UI 显示“估算”提示 |
| 存储实现 | **必须重写**：JSONL 全量重放 → SQLite 桶表 + 索引 + IPC |

---

## 8. 云端 / 账户 / 排行榜（只说明不迁移）

- 云端是 InsForge Edge + Postgres：`tokentracker_hourly` 按 `(user,device,hour,source,model)` 存桶，`account_usage_grouped()` 做跨设备/账户级去重（`T/scripts/self-host/baseline.sql:38-57`；`T/scripts/ops/account-usage-grouped-rpc.sql:1-245`）。
- 上传链路：`queue.state.json` 字节偏移 → `tokentracker-ingest`（批内按 key 去重、整行 upsert、幂等重放）→ 可选排行榜/社区统计（`T/src/commands/sync.js:4380-4600`；`tokentracker-ingest.ts:196-230`）。
- **Highlighter 不实现**：无账号体系、无跨设备、无排行榜、无遥测；隐私面因此更小（TT 的隐私底线是“只存 token 数字，不存 prompt/回复”，`T/CLAUDE.md:87`、`T/docs/PRIVACY.md:26,91`）。

---

## 9. 未验证 / 风险

1. **打包后** `node:sqlite` 在 Electron 43 是否仍可用（开发运行时已实测；asar 对内置模块通常无影响，但未做打包验收）。
2. `node:sqlite` 在 Node 24.18 仍属实验性 API（版本行为可能变化），需锁 Electron 版本并做启动冒烟测试。
3. TRAE SQLCipher 的“解密到临时明文 db + node:sqlite”方案未实现/未验证；wa-sqlite 仅在需要 TRAE 时引入。
4. Windows 长路径（>260 字符）与权限（受控文件夹/杀软）对大目录扫描的影响未实测。
5. Kimi 默认模型是否必须读 `config.toml`（去 `smol-toml` 的风险点）未验证。
6. 部分工具 schema 会随版本变化（Copilot/OpenCode 系/ZCode/Qoder/Antigravity），TT 靠动态 SQL/`PRAGMA table_info` 容错；移植后需保留同等级防御并补充真实样本测试。
7. WSL 探测（`wsl.exe`）在 Highlighter 中是否会卡顿/弹窗未验证，建议 v1 关闭。

---

## 10. 关键文件索引

| 文件 | 作用 |
|---|---|
| `T/src/lib/rollout.js` | 46 解析器 + 桶累加/去重（采集层单点，25,966 行） |
| `T/src/commands/sync.js` | 扫描编排/游标提交/来源清单（`:328-390` 别名，`:532` 入口） |
| `T/src/lib/cursor-store.js` | 增量状态 v2（manifest/generations/原子切换） |
| `T/src/lib/sqlite-reader.js` | 源 SQLite 只读读取（sqlite3 CLI / node:sqlite） |
| `T/src/lib/jsonl-lines.js` | 大 JSONL 物理行读取（LF/字节上限/UTF-8 策略） |
| `T/src/lib/pricing/*` | 价格匹配 + 成本公式 + seed/curated |
| `T/src/lib/trae-snapshot.js` + `trae-sqlite.js` | SQLCipher 解密 + 只读 SQL（TRAE，二期） |
| `T/scripts/audit-token-correctness.cjs` | token 不变量审计（可直接移植成测试） |
| `T/CLAUDE.md` | 数据流、token 归一化、队列契约 |
| `T/README.md:242-298,374-400` | 工具路径/接入方式/环境变量（权威清单） |
| `H/main.js:24-90,463,945,1182` | 主进程装配点（新增 collector/IPC 的落点） |
| `H/main/services/data-root.js:13-34` / `data-root-migration.js:29` | 数据目录与迁移登记（新增 usage 目录必须同步） |
| `H/scripts/check-architecture.js:25` / `check-js.js` | main.js 行数门禁 / 语法检查 |
| `H/package.json:47,167-192` | Electron 43.2.0、npmRebuild/allowScripts 依赖约束 |
