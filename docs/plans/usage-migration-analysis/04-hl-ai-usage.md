# 04 Highlighter AI 调用链与 Token 用量可得性

> 分析员：hl-ai-usage（task-4）｜仓库：`F:/workspace/Highlighter`｜性质：只读分析，不改产品代码
> 目标：判断 Highlighter 的 AI 功能能否提供 TokenTracker 式用量统计所需的原始数据，给出最小改造点与事件 schema。
> 证据标注：**【已验证】**＝源码 / `node_modules` 类型定义 / 仓库文档可直接核对；**【推测】**＝依赖供应商运行时行为、未在本机实测。

---

## 0. 结论摘要（TL;DR）

1. **原始 usage 数据当前一处也没取。** 全仓 grep `\.usage|stream_options|include_usage|input_tokens|output_tokens|cached_tokens|reasoning_tokens` 仅命中 `max_output_tokens`（`main/services/ai-protocol-adapters.js:149,159`）与测试，没有任何读取/记录 usage 的代码。【已验证】
2. **chat/completions 流式请求没有带 `stream_options.include_usage`**（`main/services/ai-protocol-adapters.js:38-46`），所以 OpenAI 兼容供应商不会在流里返回 usage（SDK 类型定义 `node_modules/openai/resources/chat/completions/completions.d.ts:319,363-370`）。【已验证】
3. **非流式响应的 usage 被适配器丢弃**：chat 路径 `complete()` 只返回 `choices[0].message.content`（`main/services/ai-protocol-adapters.js:177-180`）；responses 路径只返回 `extractResponsesText()`（`:155-163`）。【已验证】
4. **responses 流式的 usage 被静默跳过**：`normalizeResponsesStream` 只映射文本/推理 delta，`response.completed`（内含整包 `response.usage`）直接落空（`main/services/ai-protocol-adapters.js:111-128`）。【已验证】
5. 结论：**必须改造采集点**，但改造面集中（`ai-protocol-adapters.js` + `ai/client.js` 两个文件为核心），调用点只需补 feature 标签；不需要新增依赖。
6. 推荐方案 **A（client/adapter 层统一采集）**：覆盖全部 8 条应用内 AI 路径；方案 B（IPC 拦截）只能覆盖 2 个非流式入口；方案 C（供应商代理层）不适用——现有代理只服务浏览器扩展的 Index-Translate 流量（`main/services/translation-proxy-service.js:56-80,258-313`），不经过 `settings.ai` 供应商。
7. **历史数据不可回溯**：应用此前既不读 usage，也不在运行日志里记录 AI 请求（grep 无任何 `log()` 落在 AI 调用上）；冷启动基线必须显式声明。
8. 持久化**不要塞进 electron-store / app.log**：前者是单个 JSON 全量重写，后者会被脱敏正则把含 `token` 的键整值替换为 `[REDACTED]`（`main/services/app-logger.js:7,25`）。推荐新增 append-only JSONL + rollup 索引。

---

## 1. 方法与范围

- 阅读：`main/services/ai/{client,index,session-id}.js`、`main/services/ai-{protocol-adapters,providers,model-capabilities,image-conversion,document}.js`、`main.js`、`main/ipc/*`、`main/domains/selection/index.js`、`main/services/{action-conversation,toolbar-stream-session,conversation-store,app-logger,data-root,data-root-migration,diagnostics-service,ipc-security,performance-monitor,settings-service,function-router}.js`、`config/routes/*` 相关入口、`node_modules/openai` 类型定义、`docs/proxy-inprocess-relay-plan.md`。
- 验证手段：源码行号静态核对；跨文件调用链追踪；SDK 类型定义核对；门禁脚本与测试断言核对。**未启动 Electron 实测供应商返回**，因此所有“供应商是否返回 usage / 是否接受 stream_options”都标【推测】。
- 本文不涉及前端页面（task-1）与整体架构落点（task-3），只回答“数据从哪来、怎么记”。

---

## 2. AI 调用链全景

### 2.1 分层

```
渲染层（config/config.html、action.html、capture.html…）
  │  window.electronAPI.requestAi / translateText / capture:convert-image / toolbar:action / chat:ask
  ▼
IPC 层（main/ipc/app-ipc.js、ocr-ipc.js、selection-ipc.js、ipc-security.js 白名单）
  ▼
装配层（main.js: completeAi / translateText / registerOcrIpc / selectionDomain）
  ▼
业务层（main/services/ai-feature-router.js、action-conversation.js、ai-document.js）
  ▼
客户端门面 aiClient = require('./main/services/ai')（main.js:93；index.js 再导出 client.js）
  ▼
统一协议适配层 main/services/ai-protocol-adapters.js（openai-chat / openai-responses）
  ▼
openai SDK ^4.87.3（package.json:171）→ 供应商 baseURL
```

`deepseek.js` 只是兼容 shim（`deepseek.js:1-4` → `main/services/ai/client.js`）；`main/services/ai/index.js` 是门面（`index.js:3-5,24-28`）。【已验证】

### 2.2 main/services/ai/client.js 公开面（672 行）

| 函数/导出 | 行号 | 协议 | 流式 | 备注 |
|---|---|---|---|---|
| `normalizeProviderInput` | 49-92 | — | — | 把 settings 的 provider 对象/字符串归一为 `{id,name,baseUrl,apiKey,model,protocol,capabilities,headers}` |
| `createClient` | 94-106 | — | — | `new OpenAI({baseURL,apiKey,timeout, maxRetries:0, defaultHeaders})`；默认超时 60000ms，**SDK 重试关闭** |
| `validateApiKey` / `pingConnection` / `probeModelsList` / `testProviderConnection` | 108-113 / 167-171 / 186-204 / 243-281 | 双协议 | 非流 | 设置页连接测试；**会真实发请求**（5-token ping / models.list），不是统计对象 |
| `withConnectionFallback` | 228-241 | 双协议 | — | 仅对 404/405（`isNotFoundError`:130-134）做 baseUrl/协议回退重试；其余错误直接抛出 |
| `createTranslateStream` | 415-442 | 双协议 | 流 | 划词翻译；translation-only 模型 + 短文本走 `createShortTranslationStream`（370-389，最多 2 次真实请求） |
| `createExplainStream` | 610-628 | 双协议 | 流 | 划词解释（默认 thinking 开） |
| `createCustomStream` | 630-632 | 双协议 | 流 | 自定义划词指令，直接复用 `createExplainStream` |
| `createFollowUpStream` | 634-647 | 双协议 | 流 | 划词追问（feature 门禁用 `chat` 能力，`action-conversation.js:15,73-87`） |
| `completeChat` | 444-458 | 双协议 | 非流 | 设置页 AI 对话、翻译工具、OCR 批量翻译、短文本翻译重试都走它 |
| `translateText` | 498-514 | 双协议 | 非流 | 设置页翻译工具；translation-only 模型改走用户消息 |
| `translateOcrTextBlocks` | 569-608 | 双协议 | 非流 | 按 24 条/5000 字切批（551-567）；JSON 解析失败时**逐条** `translateText`（597-603）→ 一次用户动作可发 N 次请求 |
| `convertImage` | 467-496 | 双协议 | 非流 | 截图 → Markdown/HTML；超时 120000ms（487）；vision 能力门禁（473-475） |
| `buildToolbarStreamRequest` / `buildOcrTranslationBatchPrompt` / `normalizeProviderInput` 等纯函数 | 400-406 / 516-527 / … | — | — | 供测试与调用方复用 |
| 导出清单 | 649-672 | — | — | 见上；`createShortTranslationStream` 未导出 |

### 2.3 两种协议的请求构造（core：ai-protocol-adapters.js，194 行）

| 维度 | `openai-chat`（默认） | `openai-responses` |
|---|---|---|
| 流式请求 | `buildChatStreamRequest`:38-46 → `{model,messages,stream:true,temperature:0.3}` | `buildResponsesStreamRequest`:130-142 → `{model,input,stream:true}` |
| 非流请求 | `buildChatCompletionRequest`:48-56 → `{model,messages,max_tokens,temperature}` | `complete()` 内联 body：156-161 → `{model,input,max_output_tokens,temperature}` |
| thinking 注入 | `applyChatThinking`:14-36（deepseek 的 `reasoning_effort`+`extra_body.thinking`；siliconflow 的 `enable_thinking`/`thinking_budget`） | `reasoning:{effort}`（137-140） |
| 消息格式 | `{role,content}`，图片用 `image_url` part | `buildResponsesMessages`:82-88，图片转 `input_image` part（65-80） |
| 流式返回 | 原始 SDK 异步迭代器（`chat.completions.create({stream:true})`:174-176） | `client.responses.create()` + `normalizeResponsesStream`（151-154） |
| 非流返回 | 只取文本（177-180） | `extractResponsesText`（90-101,155-163） |
| **usage 采集钩子** | **无** | **无** |

`buildChatStreamRequest` 是唯一构造 chat 流式 body 的地方（另 `createShortTranslationStream` 产出伪 chunk，与网络无关）。**目前没有任何 `stream_options` 字段。**【已验证】

### 2.4 流式消费端（决定 usage 能不能到业务层）

| 消费点 | 行号 | 读取的 chunk 字段 | usage chunk 的处理 |
|---|---|---|---|
| 划词首轮 | `main/domains/selection/index.js:449-458` | 仅 `chunk.choices[0].delta.{content,reasoning_content}` | 带 `choices:[]` 的最终 usage chunk 被忽略（不崩，也不记） |
| 划词追问 | `main/services/action-conversation.js:421-430` | 同上 | 同上 |
| 业务层拿到 usage 的途径 | — | 无 | 无 |

因此：**即使加了 `include_usage`，也只会在适配器层出现；必须在适配器内部截获，不能指望消费端转发。**【已验证】

### 2.5 重试 / 超时 / 中断

- **SDK 层重试关闭**：`maxRetries: 0`（`ai/client.js:103`）。【已验证】
- **应用层回退**：`withConnectionFallback`（`ai/client.js:228-241`）按 `connectionAttempts`（173-184：baseUrl 原样 + `/v1` 后缀 × 协议）逐个试，只在 404/405 时继续；**一次逻辑调用可能发出 2~4 次 HTTP 请求**，成功的 attempt 之后即停止。计数需按 attempt 去重/标注。【已验证，逻辑层面】
- **超时**：客户端默认 60000ms（`ai/client.js:94`）；OCR 批量翻译 30000ms（`:43,577`）；图像转换 120000ms（`:487`）；连接测试 20000ms（`:111,169,190`）。【已验证】
- **流式中断**：划词用 `ToolbarStreamSession`（`main/services/toolbar-stream-session.js:33-53`）30s 空闲超时（`main/domains/selection/index.js:38,404`），取消时 `AbortController.abort`（:50）；追问同样传 `signal`（`action-conversation.js:416-419`）。中断后 OpenAI 明确表示**可能收不到最终 usage chunk**（SDK 注释 `completions.d.ts:367-368`）→ 中断事件的 usage 需估算或标记缺失。【已验证 + 文档】

### 2.6 调用点清单（应用内 8 条真实 AI 路径 + 2 条旁路）

| # | 功能 | 入口（文件:行） | 最终调用 | 流式 | 已有会话 id | 每次动作 HTTP 数 |
|---|---|---|---|---|---|---|
| 1 | 设置页 AI 对话 | `config/routes/chat.js:12` → `preload.js:43` → `main/ipc/app-ipc.js:12` → `main.js:1039-1046` | `completeChat(resolveAiAssignment(settings,'chat'))` | 否 | 无（仅渲染层 `chatMessages` 数组，`chat.js:4`） | 1 |
| 2 | 设置页翻译工具 | `config/routes/translation.js:10` → `preload.js:44` → `main/ipc/app-ipc.js:13-15` → `main.js:1047-1055` | `translateText(resolveAiAssignment(settings,'translation'))` | 否 | 无 | 1（translation-only + 短文本时最多 2，`client.js:370-389`） |
| 3 | 划词翻译 | `main/ipc/selection-ipc.js:36-59`（`toolbar:action`）→ `main/domains/selection/index.js:474-510`→`440-472` → `main/services/ai-feature-router.js:13-15` | `createTranslateStream(provider,...)` | 是 | conversationId（UUID，`action-conversation.js:235-237`）+ streamId（自增序号，`selection/index.js:421-424`）；仅内存，持久化依赖用户开关 | 1（短文本最多 2） |
| 4 | 划词解释 | 同上 → `ai-feature-router.js:17-19` | `createExplainStream` | 是 | 同上 | 1 |
| 5 | 自定义划词指令 | 同上 → `ai-feature-router.js:20` | `createCustomStream`（= explain） | 是 | 同上 | 1 |
| 6 | 划词追问 | `main/ipc/selection-ipc.js:93-116`（`chat:ask`）→ `main/services/action-conversation.js:403-448`（`streamConversationTurn`，:412 取 `createFollowUpStream`） | `createFollowUpStream` | 是 | conversationId + streamId | 1 |
| 7 | 划词解释快捷键（剪贴板） | `main/services/function-router.js:153-163` | 同 #4 | 是 | 同 #4 | 1 |
| 8 | 截图 OCR 翻译 | `main/ipc/ocr-ipc.js:42-78`（`capture:translate`）→ `aiClient.translateOcrTextBlocks(..., 'ocr-translate')` | `translateOcrTextBlocks` | 否 | 无 | 1..N（切批 + 逐条兜底） |
| 9 | 截图 → Markdown/HTML | `preload-capture.js:39`（`capture:convert-image`）→ `main/ipc/ocr-ipc.js:87-97` → `main/services/ai-document.js:53-98`（:57 解析 vision provider，:75-79 调用） | `convertImage` | 否 | 无 | 1 |
| 10 | 连接测试 / 模型探测 | `main.js:961-970`、`main/ipc/settings-ipc.js:24-30`、`main.js:973-981`（coding plan） | `validateApiKey`/`testProviderConnection`/`ping`/`models.list` | 否 | 无 | 1-2（含回退） |
| 旁 A | 浏览器扩展翻译代理 | tray → `main/services/proxy-bridge-controller.js` → `translation-proxy-service.js:258-313` | 直连 Index-Translate 云端点（`:56-57`），**不经过 aiClient / settings.ai** | SSE 透传 | 无 | 应用不感知 |

> 归属提示：#1/#2 走 `resolveAiAssignment(settings, feature)`（`main/services/ai-providers.js:245-260`）；#8 固定 `ocr-translate`（`ocr-ipc.js:57`）；#9 复用 `chat` 槽位（`ai-providers.js:277-283`）；#3-#7 走 `resolveToolbarAiProvider`（`ai-providers.js:262-269`），`custom:<id>` 未单独配置时回退到 `toolbar:explain`。

---

## 3. usage 可得性

### 3.1 现状：0 读取，3 处丢弃

| 丢弃点 | 行号 | 丢弃内容 |
|---|---|---|
| chat 非流 `complete()` | `ai-protocol-adapters.js:177-180` | `response.usage`、`response.id`、`created` |
| responses 非流 `complete()` | `ai-protocol-adapters.js:155-163`（+ `extractResponsesText` 90-101） | `response.usage`、`response.id` |
| responses 流 `normalizeResponsesStream` | `ai-protocol-adapters.js:111-128` | `response.completed` 事件（含 usage/id），只转发 delta |
| chat 流 | `ai-protocol-adapters.js:38-46,174-176` | 请求层面就没要 usage（无 `stream_options`），且适配器不包裹流 |

### 3.2 逐协议细节（含字段名与 SDK 依据）

- **chat/completions 非流式**：标准响应必带 `usage.prompt_tokens/completion_tokens/total_tokens`，以及可选的 `prompt_tokens_details.cached_tokens`、`completion_tokens_details.reasoning_tokens`（SDK 类型 `node_modules/openai/resources/completions.d.ts:83-144`；`ChatCompletion.usage` 见 `.../chat/completions/completions.d.ts:156`）。【已验证：类型层面】
- **chat/completions 流式**：只有请求带 `stream_options:{include_usage:true}` 时，**最后一帧**才带 `usage`（`completions.d.ts:319,363-370`；参数定义 `:1173`）。当前未带（`ai-protocol-adapters.js:38-46`）。【已验证】
- **responses 非流式**：`Response.usage`（`node_modules/openai/resources/responses/responses.d.ts:388`），结构为 `input_tokens / input_tokens_details.cached_tokens / output_tokens / output_tokens_details.reasoning_tokens / total_tokens`（`:3256-3297`）。当前只取文本。【已验证】
- **responses 流式**：流事件 `response.completed`（`:641`）携带完整 `Response`（含 `id`:221、`usage`:388）；**默认就有，无需任何参数**。当前 `normalizeResponsesStream` 未处理 completed。【已验证】
- **responses 失败/未完成**：`response.incomplete`（`ai-protocol-adapters.js:124-125` 直接 throw）事件里同样带 response；若要在失败时也记账（部分供应商对已生成 token 计费，【推测】），需在抛错前截获 usage。

### 3.3 字段矩阵（改造后预期）

| 字段 | chat 非流 | chat 流 | responses 非流 | responses 流 | 现在 | 改造方式 |
|---|---|---|---|---|---|---|
| 输入 tokens | `usage.prompt_tokens` | 同左（需 include_usage） | `usage.input_tokens` | completed.usage.input_tokens | ❌ 丢弃 | 适配器读并回调 |
| 输出 tokens | `usage.completion_tokens` | 同左 | `usage.output_tokens` | completed.usage.output_tokens | ❌ 丢弃 | 同上 |
| 缓存命中 tokens | `prompt_tokens_details.cached_tokens` | 同左 | `input_tokens_details.cached_tokens` | completed 同左 | ❌ 丢弃 | 同上（可选字段，缺失记 0/null） |
| 推理 tokens | `completion_tokens_details.reasoning_tokens` | 同左 | `output_tokens_details.reasoning_tokens` | completed 同左 | ❌ 丢弃 | 同上 |
| 总 tokens | `usage.total_tokens` | 同左 | `usage.total_tokens` | completed 同左 | ❌ 丢弃 | 同上；缺失时 input+output 自算 |
| 请求 id（去重/对账） | `ChatCompletion.id`（`completions.d.ts:104-160`） | 每帧 `chunk.id` | `Response.id`（`responses.d.ts:221`） | completed.response.id | ❌ 丢弃 | 记 `providerRequestId` |
| 创建时间 | `created`（Unix 秒） | `chunk.created` | `created_at`（`responses.d.ts:225`） | completed 同左 | ❌ 丢弃 | 可作对账字段（可选） |

### 3.4 非 OpenAI 兼容供应商 / 自定义 baseURL / 代理的地板值

- 供应商是否返回 usage、是否接受 `stream_options`：**无法静态确定【推测】**。最坏情况：错误响应、usage 缺失、或不支持流式 usage。
- 建议的兜底链（优先级从高到低）：
  1. `usageSource:'provider'` —— 响应/末帧真值；
  2. `usageSource:'estimated'` —— 本地字符估算：`input ≈ ceil(Σ消息字符 / 系数)`、`output ≈ ceil(累计输出字符 / 系数)`。中文/日韩系数与英文不同；**不引入 tiktoken 依赖**（`package.json:164-175` 无 tokenizer；`onnxruntime-node` 只用于 OCR），用 1 字符 ≈ 0.6~1 token 的启发式并标注 `estimated:true`。Web 前端展示时与真值区分（TokenTracker 的数据口径应允许 estimated 标注）【推测/建议】；
  3. `usageSource:'missing'` —— 连字符数都拿不到的失败/中断（如 4xx、abort 前无输出）。
- 自定义 baseURL：`normalizeProviderInput` 允许任意 http(s) 地址（`ai/client.js:64-67`），协议由 `protocol` 字段决定（`ai-providers.js:104`）；**不能假定 OpenAI 语义**。建议增加 per-provider 能力开关（`supportsStreamUsage`，默认按已知域名/协议推断），避免向不兼容供应商发 `stream_options` 导致 400。【建议】

### 3.5 现有 token 计数 / 上下文裁剪逻辑可复用性

- **没有 tokenizer、没有 token 计数**：全仓无 tiktoken/countTokens/estimateTokens（grep 结果）。【已验证】
- 可复用的“输入拼装点”与预算逻辑（只能做字符级估算参照）：
  - `main/services/action-conversation.js:9-11`：`MAX_CONTEXT_CHARS = 24000`，`pairLength`（`:89-91`）按 **字符数** 裁剪历史（`:146-186`），**明确按字符不是 token**；
  - 输出上限：`settings.ai.maxTokens`（`main/services/settings-defaults.js:109-115`，默认 4096；`main.js:1044` 传入 `completeChat`）；
  - OCR 批切：24 条 / 5000 字符（`ai/client.js:551-567`）；
  - `performanceMonitor` 可复用做耗时分段（`main/services/performance-monitor.js:66-115`），但目前 AI 调用没有接。
- 结论：**无法复用 token 计数**；可以把“消息数组/文本长度 + maxTokens”作为估算输入。字符预算是既有产品行为，不要改。

---

## 4. 调用归属维度

### 4.1 每次调用可确定的维度（改造后）

| 维度 | 来源（已验证） | 备注 |
|---|---|---|
| provider id / 显示名 | `providers[].id/name`（`ai-providers.js:93-117`），经 `resolveAiAssignment` 展开（`:245-260`）→ `normalizeProviderInput`（`client.js:49-92`） | 事件只记 id/name/`baseUrl` 的 host，不记完整 baseURL/API key |
| model | 同上（`model` 字段） | 与 provider 一起可算价格 |
| protocol | `provider.protocol`（`openai-chat`/`openai-responses`，`ai-providers.js:11,104`） | 决定 usage 字段语义 |
| 功能槽位 | `AI_FEATURES`（`ai-providers.js:18-24`：chat/translation/ocr-translate/toolbar:translate/toolbar:explain）+ 动态 `custom:<id>`（`config/routes/models-editor.js:30`、`ai-providers.js:265-267`） | `resolveAiAssignment` 命中的 assignment.feature 即槽位 |
| 功能入口 | 本文 §2.6 表；调用点处注入 surface | 建议 `surface` 与 `feature` 分离（见 §7） |
| 会话 id | 见 §4.3 | 仅划词链路有 |
| 请求时间 / 耗时 | 需新增：适配器包装 `performance.now()`/`Date.now()` | 尚无 |
| 成败 / 错误名 / HTTP 状态 | `withConnectionFallback` catch（`client.js:228-241`）+ SDK error `.status`（`:130-134,152-165` 已在用） | 可复用 |
| 流式中断 | `controller.cancelled/cancelReason`（`toolbar-stream-session.js:43-53`；`action-conversation.js:194-205,442-446`） | 中断原因可归因（user-cancelled/window-hidden/timeout） |
| attempt 数 | `withConnectionFallback` 循环计数（`client.js:228-241`）+ `connectionAttempts`（`:173-184`） | 用于解释“重试导致的多请求” |
| 供应商请求 id | 响应 id（§3.3） | 去重与对账 |

### 4.2 settings.ai 结构如何解析出本次实际 provider/model

- 存储结构（`settings-defaults.js:109-115` + `ai-providers.js`）：
  - `settings.providers[]`：`{id,name,baseUrl,apiKey,protocol,enabled,models:[{id,name,capabilities:{tasks,reasoning,vision?}}],presetId?,headers?}`（`:93-146`；模型能力归一 `:58-78`、`ai-model-capabilities.js:31-47`）；
  - `settings.ai = {schemaVersion:2, maxTokens, temperature, targetLanguage, assignments:[{feature,providerId,model}]}`（`:148-182,232-243`）；
  - 槽位：`chat`、`translation`、`ocr-translate`、`toolbar:translate`、`toolbar:explain`、`custom:<actionId>`（自定义动作）；默认填充 `createDefaultAssignments`（`:47-56`）。
- 解析：`resolveAiAssignment(settings, feature, {fallbackFeature})`（`ai-providers.js:245-260`）先 `normalizeAiProviders/Assignments`，再返回 `{...provider, model, apiKey}`；找不到/禁用/能力不匹配返回 `null`。工具条解析 `resolveToolbarAiProvider`（`:262-269`）：`translate`→toolbar:translate、`explain`→toolbar:explain、`custom:*`→同名槽位（回退 toolbar:explain）、其他→chat（回退 toolbar:explain）。视觉转换 `resolveVisionAiProvider`（`:277-283`）复用 chat 槽位 + `vision` 能力门禁。
- 因此**“本次实际使用的 provider/model”在调用点已经全知道**；缺的只是把它带进事件（目前 `createTranslateStream` 等函数内部再调用一次 `normalizeProviderInput`，外部传入的 `provider` 对象就是解析结果）。

### 4.3 现有 id 体系与缺口

| id | 位置 | 生命周期 | 能否用于归属 |
|---|---|---|---|
| `applicationSessionId` | `main.js:113`（`crypto.randomUUID()`），写入每条 app.log（`app-logger.js:78-86`） | 每次启动 | ✅ 作为 `sessionId` |
| `getAiSessionId()` | `main/services/ai/session-id.js:9-13` | 每次启动 | 仅用于 coding-plan 供应商 header 占位（`client.js:98`），可不用 |
| `conversationId` | `main/services/action-conversation.js:235-237`（randomUUID），保存到 `conversations/<id>.json`（`conversation-store.js:75-93`） | 一次划词会话（可恢复） | ✅ 划词/追问链路 |
| `streamId` | `main/domains/selection/index.js:421-424`（窗口内自增） | 一次流 | ✅ 辅助，跨会话不唯一 |
| 设置页对话 id | 无：`chatMessages` 仅渲染层内存数组（`config/routes/chat.js:4`） | 窗口生命周期 | ❌ 需改造时生成 `requestGroupId`（或退化为一次点击一个事件） |
| 设置页翻译 / OCR / 图像转换 | 无 | — | ❌ 同上 |
| 供应商请求 id | 响应里有，现有代码丢弃 | — | ✅ 建议记录，用于去重 |

**最小补齐建议**：在 client 门面函数新增可选的 `meta`（`{feature, surface, conversationId, actionId}`），由调用点传入；未传时用函数自身默认 feature。会话 id 在设置页场景可退化为 `null`（不造假 id）。

---

## 5. 持久化候选

| 候选 | 现状（证据） | 适配性 | 结论 |
|---|---|---|---|
| 应用运行日志 `logs/app.log` | JSONL 追加 + 2MB×3 轮转（`app-logger.js:4-5,42-51,72-99`）；受 `system.runLog` 开关（`main.js:292`，默认 true `settings-defaults.js:118`） | append 友好，但 **`sanitizeValue` 会把键名含 `token` 的值替换为 `[REDACTED]`**（`app-logger.js:7,25`）；日志是排障通道，受用户开关影响，生命周期短（≤4 文件） | ❌ 不作主存储 |
| electron-store（`config/config.json`） | 单 JSON 全量读写（`main.js:133-174`，`electron-store ^8.2.0` package.json:167），settings 与 captureHistory 同库 | 写放大、无历史分片、坏文件风险 | ❌ |
| 运行期 JSON（`runtime/session.json`、`process-exits.json`） | `diagnostics-service.js:207-212,283-300` | 固定上限覆盖写，非追加 | ❌ |
| 会话快照 `conversations/*.json` | 每会话一文件、retention 20（`conversation-store.js:6-10,75-102`） | 用户可选、含正文、非统计用途 | ❌（仅可作为“历史会话存在”信号） |
| 截图历史 `history/` | 图片文件 + store 索引 | 与 AI 无关 | ❌ |
| **新增 usage 存储** | 无 | append-only JSONL 最贴合 | ✅ 推荐 |

**推荐目录与文件命名**（新增 `main/services/usage-store.js`）：

- 主目录二选一：
  - **A（推荐，短期零迁移改动）**：`<dataRoot>/logs/usage/usage-YYYY-MM.jsonl` —— 复用 `logs` 路径（`main/services/data-root.js:18`），但要接受**切换数据目录时丢失**：迁移只复制 `app.log` 本身（`data-root-migration.js:405-412,462`）。
  - **B（长期正确）**：`<dataRoot>/usage/usage-YYYY-MM.jsonl` —— 需在 `createDataPaths`（`data-root.js:13-33`）加一项，并把 `usage` 加入 `MANAGED_DIRECTORIES`/`ADDITIONAL_PERSISTENT`（`data-root-migration.js:29-30`）后随迁移复制；改动量“中”，需同步 `test/data-root.test.js:59-68`、`test/data-root-migration.test.js` 与清理目录清单（`data-root-migration.js:547`）。
- 辅助文件：
  - `<dir>/meta.json`：`{schemaVersion, firstEventAt, appVersion, coverageStartDay, lastRollupDay}`（原子写，复用 `atomicWriteJson`：`data-root.js:49-79`）；
  - `<dir>/rollup-YYYY.json`：按日聚合缓存（可选；每月/每 N 条重算），避免每次查询全量扫 JSONL。
- 滚动 / 保留（单机桌面，避免无限增长）：
  - 单事件约 350-600 B；按 100 次调用/天估算 ≈ **15-22 MB/年**（【推测】量级，取决于使用强度）；
  - 保留策略建议：**保留 24 个月**；更早的月份在启动/月底任务中删除；单文件上限（如 8 MB）触发后切到 `usage-YYYY-MM-part2.jsonl`（或直接按月分片已足够）；
  - 可选压缩：已关闭月份 `.jsonl` → `.jsonl.gz`（Node `zlib`，无新依赖）；读取时按需 gunzip；
  - 上限兜底：总目录 > 64 MB 时从最旧月份清理，并写一条 `maintenance` 事件说明。
- 写盘方式：`fs.appendFileSync(dir, line, 'utf8')`（单行 <1ms，独立于主进程消息循环，量级可接受；与 `app-logger` 同策略，`app-logger.js:88-92`）；聚合 rollup 用 `atomicWriteJson`；退出前 flush（挂 `main.js:1301 will-quit` 或 1307 `before-quit`，但注意 main.js 行数上限，见 §6.4）。
- 并发/损坏：同一行内 JSON；读取时跳过坏行（参照 `conversation-store.js:55-65` 的容错）；本应用只有主进程写，无需文件锁。
- 隐私联动：诊断包只收集 `app.log` 及 `.1-.3`（`diagnostics-service.js:325-336,434-437`），usage 文件默认**不会**进入诊断包；若将来纳入，需过 `createSanitizer`（敏感键含 `token|prompt|messages|content`，`diagnostics-service.js:14,79-114`）。

---

## 6. 最小改造清单

### 6.1 方案对比

| 方案 | 做法 | 覆盖面 | 改动量 | 风险 | 点评 |
|---|---|---|---|---|---|
| **A. client/adapter 层统一采集（推荐）** | 在 `ai-protocol-adapters.js` 截获响应/流 usage；`ai/client.js` 在 9 处 adapter 调用点传 `meta` 与回调；新增 `usage-store` 负责落盘 | 8/8 应用内路径 | 中（核心 2 文件 + 新 2 文件 + 调用点标签） | 中：`stream_options` 兼容性、流包装需保序 | 唯一能全覆盖且不重复造轮子的方案 |
| B. IPC 层拦截 | 包装 `app-ipc.js:12-15` 的 `ai:complete`/`ai:translate`，OCR 在 `ocr-ipc.js` 拦截 | 2/8（非流式聊天、设置页翻译；OCR/划词/追问/图像转换仍不可见，流式 chunk 不经过 IPC） | 小 | 低 | 只适合做 P0 验证，不能作为最终方案 |
| C. 供应商代理层 | 在 `translation-proxy-service.js` 解析 SSE `usage` | 仅浏览器扩展流量；固定 Index-Translate 端点（`translation-proxy-service.js:56-57`），与应用内 `settings.ai` 完全无关 | 中 | 中 | **不适用**于本目标；最多作为“额外计量源”后续讨论 |

**推荐：A 为主**；流式中断/兼容性兜底用本地估算（§3.4）。若想先拿到可验证数据，可先做 A 的非流部分（P0，一天量级），再补流式。

### 6.2 按文件的最小改造清单

| # | 文件 | 新增/修改 | 内容 | 改动量 | 风险 |
|---|---|---|---|---|---|
| 1 | `main/services/ai-protocol-adapters.js` | 修改 | ①`buildChatStreamRequest` 条件加 `stream_options:{include_usage:true}`（按 provider 能力开关）；②`complete()` 读 `response.usage/id` 并回调；③responses `stream()` 包裹 `normalizeResponsesStream`，在 `response.completed` 处取 `response.usage/id`；④responses `complete()` 读 usage；⑤`response.incomplete/response.failed` 抛错前先回调（尽力记部分用量） | 中 | `stream_options` 若供应商不支持会 400（需能力开关/一次降级重试）；流包装要保持背压与 abort 语义 |
| 2 | `main/services/ai/client.js` | 修改 | 9 处 `createAiProtocolAdapter(...).stream/complete` 调用（430,436,440,456,487,622,626,645 及短文本 377）传入可选 `meta`/`onUsage`；`withConnectionFallback`（228-241）记录 attempt 数、耗时、错误名/HTTP 状态；对外函数签名保持向后兼容（新增可选第 N 参数或 options 字段） | 中 | 不能破坏现有导出与测试（`test/ai-client.test.js`、`test/ai-client-boundary.test.js`） |
| 3 | `main/services/usage-store.js`（新） | 新增 | 事件构造、append JSONL、月分片、retention、rollup 聚合、`query(range, groupBy)`；无 Electron 依赖（可 node:test 直测，参照 `conversation-store.js` 的注入风格） | 中 | 磁盘异常必须不影响 AI 调用（吞错 + 一次性告警） |
| 4 | 调用点 feature 标签 | 修改（小） | `main.js:1039,1047`（chat/translation）、`main/ipc/ocr-ipc.js:56`（ocr-translate）、`main/ipc/ocr-ipc.js:87-97`→`ai-document.js:75-79`（image-to-doc，需把 feature 透传）、`main/services/ai-feature-router.js:13-20`（toolbar:translate/explain/custom）、`main/services/action-conversation.js:412-419`（follow-up） | 小（约 8-12 行） | feature 语义需与 `AI_FEATURES` 槽位一致，否则聚合对不上 |
| 5 | `main/ipc/usage-ipc.js`（新）+ `main/services/ipc-security.js` + `preload.js` + `main.js` | 新增/修改 | 聚合查询通道（如 `usage:summary`/`usage:list`/`usage:clear`）；IPC 白名单加到 `IPC_SURFACES.main.handles`（`ipc-security.js:12-58`）；preload 暴露只读接口（参照 `preload.js:43-52`）；main.js 装配 ≤7 行 | 小-中 | `secureIpcMain.assertComplete()`（`main.js:1181`）要求“白名单↔注册”完全一致；漏一处启动即抛 |
| 6 | `main/services/settings-defaults.js`（可选） | 修改 | 若加“用量统计开关/保留月数”，需同时改 patch 校验模板（该块就是模板，`settings-defaults.js:123-138` 注释） | 小 | 新增设置键必须进模板，否则 `assertSettingsPatch` 拒写 |
| 7 | 测试与门禁 | 修改 | `test/ai-protocol-adapters.test.js`（现有断言基于无 usage 事件，需加用例）、`test/ai-client.test.js`、新增 `test/usage-store.test.js`、`test/ipc-module-contracts.test.js`（通道顺序断言）、`test/data-root*.test.js`（若走目录 B）、`package.json`（无新增依赖） | 中 | 覆盖率门槛 85%（`package.json:14`）；`scripts/check-architecture.js:96-98` 行数上限、`check:i18n --max 606`（`package.json:34`） |
| 8 | 前端用量页 | 不在本任务 | 由 task-1/task-3 决定落点；数据契约见 §7 | 大 | — |

### 6.3 关键实现约束（必须写进实施计划）

- **main.js 行数余量只有 7 行**：当前 1323 行，门禁上限 1330（`scripts/check-architecture.js:25`；main.js 实际 1323）。装配新服务/新 IPC 必须 ≤7 行，或把装配塞进现有 `initializeStore()`（`main.js:133-174`，可 +1~2 行）与某个现有 `registerXxxIpc` 的 controller 注入里；**不要轻易再抬上限**（仓库文档 `docs/proxy-inprocess-relay-plan.md:374` 明确这一原则）。
- **新增 `main/**` 代码必须英文**：i18n 门禁当前 605/606 行（`package.json:34`；`docs/proxy-inprocess-relay-plan.md:375`），仅 `throw` 行豁免（`scripts/check-i18n.js:24-26,175-181`）。usage-store 的错误/日志文案用英文；用户可见文案进 `shared/locales/`。
- **单入口约束**：`test/ai-client-boundary.test.js:11-23` 强制 main 进程只通过 `main/services/ai` 使用 AI；采集逻辑应放在 `ai/` 目录内或由它导出，不要在别处直接 require `openai`。
- **IPC 白名单**：所有渲染层可调通道必须登记在 `ipc-security.js` 的 `IPC_SURFACES`（`:8-58`），否则 `assertComplete` 启动失败（`main.js:1181`）。
- **写盘失败不能阻断 AI**：采集必须是 fire-and-forget（参考 `conversation-store.js:73-93` 的“保存失败不打断界面”原则）。

### 6.4 建议的实施顺序

1. **P0（非流式，低风险）**：`ai-protocol-adapters.js` 的 `complete()` 双协议读 usage + `usage-store.js` 落地 + `completeChat/translateText` 调用点 feature。完成即可让“设置页对话/翻译、OCR 翻译、图像转换”产出真值。
2. **P1（流式真值）**：chat 流 `stream_options.include_usage`（带能力开关与 400 降级重试）+ 适配器包裹流；responses 流读 `response.completed`。覆盖划词四类与追问。
3. **P2（兜底与展示）**：中断/失败估算、`usageSource` 标注、聚合 IPC 与前端页面（依赖 task-1/3）。

---

## 7. 事件 schema 草案（v1，JSONL 一行一事件）

### 7.1 字段表

| 字段 | 类型 | 单位/枚举 | 说明 |
|---|---|---|---|
| `schema` | string | `"hl.usage.v1"` | 版本，便于演进 |
| `eventId` | string(uuid) | — | 事件唯一 id（本地生成） |
| `ts` | string | ISO-8601 UTC（毫秒） | 请求开始时间；`2026-10-20T15:37:27.123Z` |
| `tz` | string | IANA 名 | 例如 `Asia/Shanghai`（来自 `Intl.DateTimeFormat().resolvedOptions().timeZone`） |
| `tzOffsetMin` | number | 分钟 | 例如 480；用于还原本地日 |
| `day` | string | `YYYY-MM-DD` | **本地日**（聚合主键；跨时区旅行时以请求发生时的 offset 为准） |
| `sessionId` | string | uuid | 应用启动会话（`main.js:113`） |
| `conversationId` | string\|null | uuid | 仅划词/追问有（`action-conversation.js:235-237`） |
| `requestGroupId` | string\|null | uuid | 一个用户动作可能发 N 次请求（OCR 切批、短文本二次尝试），同组共享 |
| `feature` | string | 槽位 | `chat`/`translation`/`ocr-translate`/`toolbar:translate`/`toolbar:explain`/`custom:<id>`/`image-to-doc` |
| `surface` | string | 入口 | `settings-chat`/`settings-translate`/`selection-toolbar`/`selection-follow-up`/`ocr-translate`/`image-to-doc`/`connection-test` |
| `actionId` | string\|null | 动作 id | 划词动作原始 id（`translate`/`explain`/`custom:polish`…） |
| `provider.id` | string | — | 供应商 id（`ai-providers.js:98-100`） |
| `provider.name` | string | — | 显示名（`ai-providers.js:101`） |
| `provider.host` | string | host | 只记 `new URL(baseUrl).host`，不记完整 URL/密钥 |
| `protocol` | string | `openai-chat`\|`openai-responses` | 决定 usage 字段来源 |
| `model` | string | — | 实际使用的模型 id |
| `stream` | boolean | — | 是否流式 |
| `attempts` | number | 次 | 本次逻辑调用实际 HTTP 次数（回退重试时 >1） |
| `startedAt` / `endedAt` | string | ISO UTC | 结束时间（流式=最后一帧/中断时刻） |
| `durationMs` | number | ms | 整数；流式另可加 `firstByteMs` |
| `outcome` | string | `success`\|`error`\|`cancelled`\|`timeout` | 统一成败口径 |
| `errorName` | string\|null | — | 如 `APIError`/`AbortError`；**不记错误原文**（可能含供应商回显的 prompt 片段） |
| `httpStatus` | number\|null | — | 供应商 HTTP 状态 |
| `providerRequestId` | string\|null | — | 响应 id（去重/对账） |
| `usage.input` | number | tokens | 输入 |
| `usage.output` | number | tokens | 输出（含推理） |
| `usage.cached` | number\|null | tokens | 缓存命中输入 |
| `usage.reasoning` | number\|null | tokens | 推理输出 |
| `usage.total` | number\|null | tokens | 总；缺失时由 input+output 自算 |
| `usageSource` | string | `provider`\|`estimated`\|`missing` | 数据来源等级 |
| `estimate` | object\|null | `{inputChars,outputChars}` | 估算依据（估算时为非 null） |
| `appVersion` | string | — | 便于版本对比 |
| `elapsedSinceRequestMs` | number | ms | 可选：从用户动作到请求发出的排队耗时 |

> 命名注意：**刻意不用 `*_tokens` 这种键名**，因为一旦事件被复制进 `app.log` 或诊断包，`app-logger.js:7` / `diagnostics-service.js:14` 的敏感键正则包含 `token`，整值会被 `[REDACTED]`。

### 7.2 示例（成功、流式）

```json
{"schema":"hl.usage.v1","eventId":"6b0f5a1e-...","ts":"2026-10-20T15:37:27.123Z","tz":"Asia/Shanghai","tzOffsetMin":480,"day":"2026-10-20","sessionId":"9d1f...","conversationId":"2f7c...-...","requestGroupId":null,"feature":"toolbar:explain","surface":"selection-toolbar","actionId":"explain","provider":{"id":"deepseek","name":"DeepSeek","host":"api.deepseek.com"},"protocol":"openai-chat","model":"deepseek-v4-flash","stream":true,"attempts":1,"startedAt":"2026-10-20T15:37:27.123Z","endedAt":"2026-10-20T15:37:29.840Z","durationMs":2717,"firstByteMs":680,"outcome":"success","errorName":null,"httpStatus":200,"providerRequestId":"chatcmpl-...","usage":{"input":412,"output":188,"cached":0,"reasoning":96,"total":600},"usageSource":"provider","estimate":null,"appVersion":"4.0.0"}
```

### 7.3 隐私 / 采样 / 批量 / 时钟

- **绝不记录**：prompt、system prompt、划选文本、模型回复、OCR 结果、图片、API key、完整 baseURL、header；`errorName` 只记错误类名，不记 message（供应商错误常回显请求片段）。
- 允许记录：供应商 id/name/host、模型、协议、计数、耗时、成败、入口标签。
- 采样：**不采样**（桌面应用量级小；统计完整性优先）。可用 `settings.usage.enabled` 做整体开关（默认开），关闭时不写盘。
- 批量：逐事件 append（同步单行）；rollup 索引异步/定时（每 N 条或每 30s，退出前 flush）。禁止每事件重写整个 JSON 文件。
- 时钟：`ts` 用系统墙钟 ISO UTC（与 app.log 一致，`app-logger.js:79`）；`durationMs` 用 `performance.now()` 单调时钟计算，避免系统时间跳变；`day` 由 `ts + tzOffsetMin` 推导，保证按本地日聚合与 TokenTracker 的日期口径一致。

---

## 8. 历史数据与冷启动

- **迁移前的调用不可回溯【已验证】**：
  1. 应用从未读取 usage（§3.1）；
  2. 应用从未把 AI 请求/响应写日志（grep 全仓 `log()` 调用，没有任何一条落在 AI 客户端或流式消费点；`main/domains/selection/index.js:340-346` 的 selection 诊断只记 reason/程序名/文本长度，且每次会话去重一次）；
  3. 运行日志为 2MB×3 轮转（`app-logger.js:4-5`），即使曾经有痕迹也早已覆盖；
  4. 用户可关闭运行日志（`main.js:292`），历史可用性因用户而异。
- **不可反推的“伪历史”**：`conversations/*.json` 只能提供“保存过的划词会话+轮次”（且需用户开启持久化，`conversation-store.js:41-43`），没有 token；`captureHistory`/`history` 与 AI 无关；`diagnostics` 不含 AI 内容（`diagnostics-service.js:368-372` 明确排除 AI content）。
- **冷启动策略（必须写进 UI 与文档）**：
  1. 首次启动新版时创建 `usage/meta.json`，记录 `coverageStartAt`（首条事件时间）、`appVersion`、`installId`（随机，仅本地）；
  2. 用量页显示“统计自 vX（YYYY-MM-DD）起；此前的调用无法回溯/计费”，不显示虚假的 0；
  3. 若用户切换数据目录（B 方案会随迁移复制；A 方案丢失），保留 meta 并提示“统计起点重置”；
  4. 若将来做“导入历史”，只能是外部导入（如供应商账单 CSV），不宣称是应用历史。
- 附注：若产品坚持要“历史感”，可把 `coverageStartAt` 之前显示为“无数据”而不是 0，并给出原因说明（无 usage 采集）。

---

## 9. 风险与开放问题

| # | 风险/问题 | 影响 | 缓解 |
|---|---|---|---|
| 1 | 自定义供应商不支持 `stream_options` 或对未知字段报 400【推测】 | 流式功能可能直接失败 | 能力开关默认保守；或首次 400 检测到相关字样后自动降级重试并记住（内存级） |
| 2 | 流中断/超时收不到最终 usage（SDK 注释 `completions.d.ts:367-368`；`toolbar-stream-session.js:43-53`） | 中断调用缺真值 | `usageSource:'estimated'` 或 `'missing'`，并在 UI 标注 |
| 3 | 一次用户动作多发请求（OCR 切批、回退重试、短文本二次尝试） | 计数翻倍/归属混乱 | `requestGroupId` + `attempts` + 按 `providerRequestId` 去重 |
| 4 | 供应商返回的 usage 与计费口径不同（含 reasoning/cache 的差异）【推测】 | 金额估算偏差 | 记录原始四件套，价格换算放到聚合层；允许人工覆盖价格表 |
| 5 | 估算精度（字符→token） | 非兼容供应商的数字不精确 | 明确 `usageSource`；前端显示估算角标 |
| 6 | 写盘 I/O 在主进程 | 极端情况下卡顿 | 单行 append（同 app.log）、失败吞错；必要时改为队列 + 定时 flush |
| 7 | main.js 行数/I18n/IPC 三门禁 | 改造引不起眼失败 | 实施前先跑 `npm run check`；改动按 §6.3 约束执行 |
| 8 | `settings.ai.maxTokens` 只影响请求上限，不是实际用量 | 不能用它冒充 output | 只作为估算上限，真值以 usage 为准 |

---

## 10. 核对清单（复现本文断言）

```bash
# 1) 全仓无 usage 读取 / 无 include_usage
rg -n "\.usage\b|stream_options|include_usage|input_tokens|output_tokens|cached_tokens|reasoning_tokens" main config shared deepseek.js
# 2) 适配器丢弃 usage
sed -n '90,182p' main/services/ai-protocol-adapters.js
# 3) 流式消费只读 delta
sed -n '440,472p' main/domains/selection/index.js
sed -n '403,448p' main/services/action-conversation.js
# 4) 调用点
rg -n "completeChat|translateText\(|translateOcrTextBlocks|convertImage|createFollowUpStream|createToolbarActionStream" main.js main/ipc main/services main/domains config
# 5) 持久化设施
sed -n '1,112p' main/services/app-logger.js
sed -n '13,33p' main/services/data-root.js
# 6) 门禁
node scripts/check-architecture.js && node scripts/check-i18n.js
```

---

**一句话给 Lead**：Highlighter 的 AI 请求目前**完全没要/没读 usage**（含流式与 responses 双协议），但 provider/model/feature 在调用点已完全已知，改造集中在 `ai-protocol-adapters.js` + `ai/client.js` 两个文件；推荐方案 A（client 层统一采集 + 新增 usage JSONL store + 可选字符估算兜底），历史数据不可回溯，需明确冷启动基线。
