# 设计文档：模型配置页 Coding Plan 一键接入

- 日期：2026-09-27
- 基线：`master` @ `f5b2f1b`（`package.json` 版本 2.2.8）
- 状态：**M1 + M2 已实施**（分支 `feat/coding-plan-presets`，见 §8 实施结果与偏差）；M3 真实 key 冒烟待需求方提供测试 key
- 范围：在"模型"设置页内置常见 coding plan 预设，用户选择 plan 后仅需输入 API key 即可完成配置

---

## 0. 需求背景与目标

### 0.1 现状痛点

当前新增一个 AI 供应商，用户需要在"模型 → 供应商"tab 手工填写四项信息（`config/config.js:996` `providerEditorMarkup`）：

1. API 地址（baseUrl，用户需要自己去翻各家文档）
2. API 协议（`openai-chat` / `openai-responses`，普通用户无法判断该选哪个）
3. API 密钥
4. 模型目录（手工逐行填模型 ID + 显示名称，或保存后点"获取可用模型"）

coding plan 类服务（Open Code Go、GLM Coding Plan、MiniMax Coding Plan 等）的用户群体与普通 API 用户重叠度高、但上述信息全部是**套餐方固定公开**的——让用户手填是纯负担，且填错（协议选错、baseUrl 少 `/v1`）是最常见的配置失败原因。

### 0.2 目标

- 用户在模型配置页选择目标 coding plan → 只输入 API key → 保存即完成配置（baseUrl、协议、模型目录全部自动处理）。
- 保存时自动验证连通性并拉取实时模型目录；拉取失败有兜底，不阻断保存。
- 保存成功后引导用户（需确认）把各 AI 功能切换到新 plan。
- **零新增 SDK 依赖**：全部走现有 OpenAI 兼容层。

### 0.3 非目标（本期明确不做）

- Anthropic Messages 协议适配（OpenCode Go 上仅挂在 `/messages` 端点的模型，如 `minimax-m3`、`qwen3.8` 系列，本期不可选；见 §3.2）。
- 引入任何厂商官方 SDK（`@anthropic-ai/sdk` 等）。
- coding plan 额度/限流用量的展示与监控。
- 预设目录的远程更新（内置静态目录，随应用版本发布更新）。
- 用户自定义预设的导出/导入。

---

## 1. 已确认的关键决策（拷问结论）

| # | 问题 | 决策 |
|---|---|---|
| D1 | 首批内置哪些 plan | **Open Code Go**、**GLM Coding Plan（智谱）**、**MiniMax Coding Plan** |
| D2 | 是否为每个 plan 引入官方 SDK | **否**。统一走现有 `openai` SDK + OpenAI 兼容层 + 预设目录，零新增依赖 |
| D3 | 配置自动化程度 | 选 plan → 只填 key → **保存时自动测试连接**；模型目录在保存时**实时拉取 `GET /models`** |
| D4 | 预设目录维护方式 | **内置静态目录**，随应用版本更新 |
| D5 | Anthropic-only 模型（OpenCode Go 的 `/messages` 组） | 本期**过滤掉不可选**；预设中登记已知 Anthropic-only 模型 ID 用于过滤 |
| D6 | OpenCode Go 要求的自定义请求头 | 预设支持声明 `defaultHeaders`，客户端创建时注入；`x-opencode-session` 用每次启动生成的稳定 UUID |
| D7 | 拉取模型失败 | 写入预设内置的**兜底模型清单**并标记"目录未验证"，**不阻断保存** |
| D8 | 功能分配 | 保存并验证成功后**弹引导**，用户确认才切换 assignments，不静默覆盖 |

---

## 2. 关键事实（已核实，设计的依据）

### 2.1 三个 plan 的接入参数

| Plan | OpenAI 兼容 baseUrl | 协议 | 模型 | 认证 | `GET /models` |
|---|---|---|---|---|---|
| Open Code Go | `https://opencode.ai/zen/go/v1` | chat completions 与 responses 双支持 | 见 §3.2，按端点分组 | Bearer key | ✅ 支持 |
| GLM Coding Plan | `https://open.bigmodel.cn/api/coding/paas/v4` | chat completions | GLM-5.3、GLM-5.3-Flash（历史模型 ID 自动迁移到这两个） | Bearer key | 文档未明示，按支持处理，失败走兜底 |
| MiniMax Coding Plan | `https://api.minimax.cn/v1`（国际站 `api.minimaxapi.com/v1`） | chat completions | MiniMax-M3 / M2.7 / M2.5 / M2.1 / M2 / M2-her 等 | Bearer key | 文档未明示，按支持处理，失败走兜底 |

### 2.2 OpenCode Go 的特殊性（必须在设计中覆盖）

- **模型按端点分三组**：`/chat/completions`（glm-5.x、kimi-k3/k2.x、deepseek-v4.x、mimo-v2.x 等）、`/responses`（grok-4.x、gpt-6-luna 等）、`/messages`（minimax-m3/m2.7/m2.5、qwen3.8/3.7/3.6 系列）。第三组本期过滤（D5）。
- **要求自定义请求头**：客户端需发送自有 `User-Agent`，并在 `x-opencode-session` 头中携带稳定会话 ID（用于路由优化与 prompt 缓存）。现有 `createClient()`（`main/services/ai/client.js:71`）不支持注入自定义头，需扩展（D6）。
- **限流模型**：按月美元额度 + 5 小时/周/月三档窗口限流，超限返回错误。本期仅在测试连接失败文案中提示"可能是套餐限流"，不做额度展示。

### 2.3 现有架构的接入点（已核实）

- 客户端工厂：`main/services/ai/client.js:71` `createClient()`，`new OpenAI({ baseURL, apiKey, timeout, maxRetries: 0 })`。
- 协议适配层：`main/services/ai-protocol-adapters.js`，`openai-chat` / `openai-responses` 两种协议已统一为 `{ ping, stream, complete }`。
- 连接测试与模型拉取：`client.js:203` `testProviderConnection()`、`client.js:146` `listProviderModels()`，均可直接复用。
- baseUrl 容错：`client.js:90` `connectionBaseUrls()` 已会自动尝试 `baseUrl` 与 `baseUrl + /v1`，对 GLM 的 `/paas/v4` 类深路径无副作用。
- 保存链路：renderer → `window.electronAPI.updateSettings` → `main/ipc/settings-ipc.js:12` → `SettingsService.updateSettings`（`main/services/settings-service.js`）→ 校验（`settings-validation.js`）→ API key 经 `credential-store.js` 用 safeStorage 加密分离落盘。**本特性必须复用此链路，不另开存储通道**。
- provider schema：`settings-defaults.js:16`，字段 `{ id, name, baseUrl, apiKey, protocol, enabled, builtin, models[] }`，providers 上限 20、models 上限 100/供应商。
- UI 接入点：providers tab 工具栏（`config/config.js:1011` `models-provider-toolbar`，现有"＋ 添加供应商"旁）。
- 已知重复：`defaultModelsForProvider` 在 `config/routes/model-helpers.js:11` 与 `main/services/ai-providers.js:254` 各有一份实现，本特性落地时一并收敛（见 §4.6）。

---

## 3. 详细需求点

### 3.1 功能需求

**FR-1 预设目录**：内置静态 coding plan 预设目录，随应用版本发布。每个预设包含：显示名称、baseUrl、协议、官方文档链接、默认请求头模板、兜底模型清单、已知 Anthropic-only 模型 ID 集合（用于过滤）。

**FR-2 入口**：模型 → 供应商 tab 工具栏新增"⚡ 添加 Coding Plan"按钮（与"＋ 添加供应商"并列）。点击后弹出预设选择器：plan  Logo/名称/一句话说明/文档链接。

**FR-3 简化表单**：选定 plan 后，表单只包含：
- API 密钥（必填，password 输入）
- 显示名称（可选，默认 `预设名`；同一 plan 添加第二次时自动追加序号，如 `Open Code Go 2`）
- baseUrl / 协议 / 模型目录**不展示、不可编辑**（进阶用户仍可通过"＋ 添加供应商"走全手动流程）

**FR-4 保存时验证**：点击保存后，主进程编排（见 §4.3）：
1. 用预设参数 + 用户 key 调 `testProviderConnection()`（5-token ping）。
2. ping 成功则调 `listProviderModels()` 拉取实时模型目录，按 §3.2 过滤后写入 `provider.models`，标记 `modelsVerified: true`。
3. ping 或拉取失败（key 无效、网络抖动、限流、`/models` 不存在）：写入预设兜底模型清单，标记 `modelsVerified: false`，**照常保存**（D7），UI 提示"连接未验证 / 模型目录为内置清单，可稍后点'测试'重试"。
4. key 经现有 credential-store 加密链路落盘。

**FR-5 功能分配引导**：保存成功（含未验证保存）后，弹出引导面板：列出各 AI 功能（chat / translation / ocr-translate / toolbar:translate / toolbar:explain / 自定义划词）的当前 assignment，用户勾选要切换的功能 + 选择新 plan 的模型，确认后才写 `ai.assignments`；可"跳过"。**不静默覆盖任何现有 assignment**（D8）。

**FR-6 预设标识与回显**：通过预设创建的 provider 记录 `presetId`，在供应商列表项上显示 plan 徽标（如 "Coding Plan" 标签）。后续编辑该 provider 时表单为完整版（baseUrl/协议可见可改），与手动 provider 一致——预设只在**创建时**起作用。

**FR-7 请求头注入**：预设声明的 `defaultHeaders` 在该 provider 的所有请求上生效（ping、stream、complete、list models）。`${sessionId}` 占位符在运行时替换为本次启动生成的 UUID；`${appVersion}` 替换为应用版本号（用于 `User-Agent: highlighter/${appVersion}`）。**API key 永远不进入 defaultHeaders**（认证仍走 OpenAI SDK 的 Bearer 机制）。

### 3.2 OpenCode Go 模型过滤规则

预设中登记 `anthropicOnlyModels` 集合（首版内容，依据 2026-09-27 官方文档）：

```
minimax-m3, minimax-m2.7, minimax-m2.5,
qwen3.8-max, qwen3.8-flash, qwen3.7-max, qwen3.7-plus, qwen3.6-plus
```

- 实时拉取 `/models` 后：过滤掉 `anthropicOnlyModels` 中的 ID；**未知的新模型默认保留**（按 chat 协议处理，失败由连接测试兜底暴露）。
- `/responses` 组模型（grok-4.x、gpt-6-luna 等）：provider 的 `protocol` 固定为 `openai-chat`，这组模型在 chat 端点不可用。首版处理：同样在预设中登记 `responsesOnlyModels` 集合（`grok-4.7, grok-4.6, gpt-6-luna, gpt-5.6-luna, muse-spark-1.3-contributor, muse-spark-1.2-contributor`）予以过滤。**后续版本**若需要可再引入"单 provider 双协议"能力，届时另立设计。
- 兜底清单只含 chat 组常用模型（如 `kimi-k3`、`glm-5.3`、`deepseek-v4-flash` 等）。

### 3.3 非功能需求

- **NFR-1 零新增运行时依赖**：不引入任何新 npm 包（D2）。
- **NFR-2 向后兼容**：`settings.providers[]` 新增字段全部为可选，老配置原样加载；不 bump `ai.schemaVersion`。
- **NFR-3 安全**：key 只走 safeStorage 加密链路；预设目录不含任何密钥；defaultHeaders 模板禁止引用 `apiKey`。
- **NFR-4 性能**：预设目录为静态模块，渲染进程加载开销可忽略；保存时验证串行执行，总超时 ≤ 30s（沿用现有 `testProviderConnection` 超时）。
- **NFR-5 可审计**：预设目录改动必须过 `npm run check`（架构检查）与新增的单测。

---

## 4. 技术设计

### 4.1 预设目录模块（新增 `shared/coding-plan-presets.js`）

放在 `shared/`，UMD 包装（同 `config/routes/model-helpers.js` 模式），renderer 与 main 双端共用同一份实现，避免再制造一处重复：

```js
const CODING_PLAN_PRESETS = [
  {
    id: 'opencode-go',
    name: 'Open Code Go',
    tagline: 'opencode 官方聚合套餐，多厂商模型',
    docsUrl: 'https://opencode.ai/v2/docs/console/go/',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    protocol: 'openai-chat',
    defaultHeaders: {
      'User-Agent': 'highlighter/${appVersion}',
      'x-opencode-session': '${sessionId}',
    },
    anthropicOnlyModels: [/* §3.2 */],
    responsesOnlyModels: [/* §3.2 */],
    fallbackModels: [
      { id: 'kimi-k3', name: 'Kimi K3' },
      { id: 'glm-5.3', name: 'GLM 5.3' },
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
      // …首版 5~8 个常用 chat 组模型
    ],
  },
  {
    id: 'glm-coding-plan',
    name: 'GLM Coding Plan',
    tagline: '智谱 coding 订阅，GLM-5.3 系列',
    docsUrl: 'https://docs.bigmodel.cn/cn/coding-plan/overview',
    baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    protocol: 'openai-chat',
    defaultHeaders: {},
    anthropicOnlyModels: [],
    responsesOnlyModels: [],
    fallbackModels: [
      { id: 'glm-5.3', name: 'GLM 5.3' },
      { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash' },
    ],
  },
  {
    id: 'minimax-coding-plan',
    name: 'MiniMax Coding Plan',
    tagline: 'MiniMax coding 订阅，M3/M2.x 系列',
    docsUrl: 'https://platform.minimax.cn/docs/guides/text-generation',
    baseUrl: 'https://api.minimax.cn/v1',
    protocol: 'openai-chat',
    defaultHeaders: {},
    anthropicOnlyModels: [],
    responsesOnlyModels: [],
    fallbackModels: [
      { id: 'MiniMax-M3', name: 'MiniMax M3' },
      { id: 'MiniMax-M2.7', name: 'MiniMax M2.7' },
      { id: 'MiniMax-M2.5', name: 'MiniMax M2.5' },
    ],
  },
];
```

模块导出 `listCodingPlanPresets()`、`getCodingPlanPreset(id)`、`resolvePresetHeaders(preset, { appVersion, sessionId })`。

### 4.2 Provider schema 扩展（`settings-defaults.js` / `settings-validation.js`）

`providers[]` 元素新增三个**可选**字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `presetId` | `string?` | 来源预设 id（如 `opencode-go`）；手动 provider 无此字段 |
| `headers` | `Record<string,string>?` | 保存时已解析模板的请求头（`${...}` 占位符在写入前替换完毕，落盘的是具体值——但 `${sessionId}` 例外：落盘保留占位符，运行时替换，避免换设备/重启后 session 固化） |
| `modelsVerified` | `boolean?` | `false` 表示模型目录为兜底清单；缺省视为 `true`（兼容旧数据） |

校验规则（`settings-validation.js`）：`presetId` 允许 `/^[a-z0-9-]+$/`；`headers` 的 key 限 64 字符、value 限 256 字符、条目 ≤ 10、**禁止 `authorization` 键**（大小写不敏感）。不 bump schemaVersion，无迁移逻辑。

### 4.3 保存编排（新增主进程 IPC）

新增 IPC handler（放 `main/ipc/settings-ipc.js`，或新建 `main/ipc/coding-plan-ipc.js` 按现有 ipc 拆分惯例）：

```
coding-plan:create-provider  (presetId, apiKey, displayName?)
  → Promise<{ ok, provider, verified, warning?, modelsCount }>
```

主进程内编排（新函数 `createCodingPlanProvider`，建议放 `main/services/ai-providers.js` 或新文件 `main/services/coding-plan-service.js`）：

1. 取预设，构造 provider 骨架 `{ id: createModelProviderId(), presetId, name, baseUrl, protocol, enabled: true, builtin: false, models: [] }`。
2. 解析请求头：`resolvePresetHeaders()`，`${appVersion}` → `app.getVersion()`，`${sessionId}` → 主进程启动时生成的模块级 UUID（`crypto.randomUUID()`，放 `main/services/ai/client.js` 或独立 `session-id.js`）；`headers` 落盘时保留 `${sessionId}` 占位符（§4.2）。
3. `testProviderConnection()`：
   - 成功 → `listProviderModels()` → 按 §3.2 过滤 → `models` = 实时清单、`modelsVerified: true`。
   - 抛错（含 ping 失败、models 拉取失败）→ `models` = 预设 `fallbackModels`、`modelsVerified: false`，`warning` 带回错误摘要；**不抛出**（D7）。
4. 把 provider + key 写入设置：复用 `SettingsService.updateSettings()` 现有路径（apiKey 自动被 credential-store 分离加密），**不直接操作 store**。
5. 返回结果给 renderer，由 renderer 决定是否弹出 FR-5 引导。

功能分配引导确认后走现有 `updateSettings({ ai: { assignments } })` 路径，无新 IPC。

### 4.4 客户端请求头注入（`main/services/ai/client.js`）

- `normalizeProviderInput()`（client.js:27）：透传 `provider.headers`。
- `createClient()`（client.js:71）：`new OpenAI({ ..., defaultHeaders: resolvedHeaders })`。注意 `withConnectionFallback()` 内多处建 client 的地方都要带上（client.js:90-201）。
- 运行时把 `headers` 里的 `${sessionId}` 替换为模块级 UUID；其它占位符在写入时已解析，运行时原样使用。
- `listProviderModels()` / `testProviderConnection()` 同样注入（复用同一 `createClient` 路径即可覆盖）。

### 4.5 渲染层 UI（`config/config.js` + `config.css`）

1. **工具栏**：`renderModelsProviderTab`（config.js:1009）的 toolbar 增加 `<button data-add-coding-plan>⚡ 添加 Coding Plan</button>`。
2. **预设选择器**：模态层，列出 `listCodingPlanPresets()`，每项显示名称、tagline、"查看文档"外链（`shell.openExternal`，走 preload 现有暴露或新增）。
3. **简化表单**：选定后显示 key 输入 + 名称输入 + baseUrl/协议的**只读回显**（让用户知道会配什么），保存按钮触发 `coding-plan:create-provider`。
4. **结果反馈**：`verified=false` 时在供应商卡片上显示黄色"目录未验证"标记（依据 `modelsVerified`）；`warning` 文案 toast 展示。
5. **功能分配引导**：保存成功后弹面板，复用 `featureAssignmentMarkup`（config.js:892）的 provider+model 下拉组件，勾选功能 → 确认 → `updateSettings`；提供"跳过"。
6. **徽标**：provider 列表项在 `presetId` 存在时显示 "Coding Plan" 标签。

### 4.6 顺带收敛：`defaultModelsForProvider` 双份实现

`config/routes/model-helpers.js:11` 与 `main/services/ai-providers.js:254` 的重复逻辑迁入 `shared/coding-plan-presets.js` 所在模块（或新建 `shared/model-catalog-defaults.js`），双端引用同一实现。这是本特性"预设数据双端可用"的前提，一并做掉，避免第三份拷贝。

### 4.7 文件改动清单（预估）

| 文件 | 改动 |
|---|---|
| `shared/coding-plan-presets.js` | **新增**：预设目录 + header 模板解析 + 模型默认目录（收敛后） |
| `main/services/coding-plan-service.js` | **新增**：`createCodingPlanProvider` 编排 |
| `main/ipc/settings-ipc.js`（或新 `coding-plan-ipc.js`） | 新增 `coding-plan:create-provider` handler |
| `main/services/settings-defaults.js` / `settings-validation.js` | provider 三个可选字段 + 校验 |
| `main/services/ai/client.js` | headers 透传 + `defaultHeaders` 注入 + 运行时 `${sessionId}` 替换 |
| `main/services/ai-providers.js` / `config/routes/model-helpers.js` | 删除重复的 `defaultModelsForProvider`，改为引用 shared 模块 |
| `config/config.js` / `config.css` | 工具栏按钮、预设选择器、简化表单、引导面板、徽标 |
| `preload.js` | 暴露 `codingPlanCreateProvider`、`openExternal`（如未有） |
| `test/coding-plan-presets.test.js` | **新增**：目录完整性、header 模板、过滤规则 |
| `test/model-config-ui-contract.test.js` / `model-config-runtime.test.js` | 更新契约以覆盖新 UI 与 schema 字段 |

---

## 5. 测试计划

1. **预设目录完整性单测**（新）：id 唯一；baseUrl 全为 https；`fallbackModels` 非空且不含 `anthropicOnlyModels`/`responsesOnlyModels` 成员；`defaultHeaders` 不含 `authorization`；模板占位符均在已知集合 `${appVersion}`/`${sessionId}` 内。
2. **编排单测**（新，mock openai client）：ping 成功 + models 成功 → 实时清单 + `modelsVerified: true`；ping 失败 → 兜底清单 + `modelsVerified: false` + 不抛错；models 拉取失败 → 同上；过滤规则对 OpenCode Go 样本 `/models` 响应正确剔除两组模型。
3. **header 注入单测**（新）：`createClient` 收到的 `defaultHeaders` 含解析后的 UA 与 UUID 形态 session id；重启（重置模块）后 session id 变化。
4. **schema 兼容单测**：旧配置（无三字段）加载/保存不变；`headers` 含 `authorization` 被拒绝。
5. **UI 契约测试更新**：`scripts/probe-model-config-ui.js` + `test/model-config-ui-contract.test.js` 覆盖新按钮、选择器、简化表单字段。
6. **运行时冒烟**：`npm run check`、`npm test`、架构检查全绿；真实 key 手动验证三个 plan 各一次（验收环节，需需求方提供测试 key）。

---

## 6. 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| MiniMax / GLM 的 `GET /models` 行为未在文档确认 | 中 | 兜底清单机制（D7）保证可用；首版发布前用真实 key 验证一次并固化行为 |
| OpenCode Go 模型-端点分组随版本变化，过滤集合过期 | 中 | 未知新模型默认放行（宁可多不可少）；预设随应用版本更新（D4）；`modelsVerified` 标记让问题可见 |
| 用户把功能切到 coding plan 后触发套餐限流，体验受损 | 低 | 保存引导文案注明"coding plan 有额度窗口限制"；测试失败文案提示限流可能 |
| 预设目录双端引用引入新的共享模块边界 | 低 | 沿用现有 `shared/` UMD 惯例；`npm run check:architecture` 会拦截越界引用 |
| `headers` 字段被滥用注入敏感信息 | 低 | 校验禁止 `authorization` 键、限制条目数与长度；key 永远走 credential-store |

---

## 7. 实施分期

- **M1（核心链路）**：§4.1 预设目录 + §4.2 schema + §4.3 编排 + §4.4 header 注入 + §4.6 收敛 + 单测。此步完成后可用 IPC/脚本验证全链路。
- **M2（UI）**：§4.5 全部渲染层工作 + UI 契约测试更新。
- **M3（验收）**：真实 key 三 plan 冒烟、文案打磨、发布说明。OpenCode Go 的 `/messages` 组支持（若要做）另立设计，不在本期。

---

## 8. 实施结果与偏差（2026-09-27 补记，分支 `feat/coding-plan-presets`）

M1 与 M2 已落地并通过全部门禁；M3 的真实 key 冒烟仍需需求方提供测试 key，未做。

### 8.1 门禁实况

| 门禁 | 结果 |
|---|---|
| `npm test` | 604 tests / 604 pass |
| `npm run check`（语法 + 架构） | ok，`main.js` 1298 行 / 上限 1300 |
| `npm run test:coverage:loaded` | lines 91.09%（阈值 85%） |
| `npm run audit:dependencies` | 0 豁免、0 未豁免 |

新增测试 4 个文件：`test/coding-plan-presets.test.js`（目录完整性、占位符、清洗、过滤、默认目录）、`test/coding-plan-service.test.js`（编排三分支 + 上限 + 命名）、`test/coding-plan-headers.test.js`（本地 HTTP 服务验证请求头真的上线 + session 轮换）、`test/ipc-module-contracts.test.js` 增补（新 IPC 面）。既有 `model-config-ui-contract` / `model-config-runtime` 扩写为覆盖完整「选套餐 → 只填 key → 保存 → 功能引导」链路（真实 Electron 渲染进程）。

### 8.2 偏差 1：provider 级校验落在 `normalizeAiProviders`，不在 `settings-validation.js`

§4.2 要求把 `presetId` / `headers` 校验写进 `settings-validation.js`。实际做不到：`assertSettingsPatch` 用 `DEFAULT_SETTINGS` 当模板，而模板里 `providers` 是**数组**，`assertValue` 对数组只检查「是数组 + 条目上限」，不递归元素。因此 provider 字段白名单与 `headers` 清洗放在真正做收敛的 `normalizeAiProviders()`（`main/services/ai-providers.js`），`settings-validation.js` 未改动。

实现要点：`presetProviderFields()` 只在字段真实存在时才挂上键（`presetId` 需过 `/^[a-z0-9-]+$/`；`headers` 走 `sanitizeProviderHeaders`，空对象不落盘；`modelsVerified` 仅接受布尔），所以手工 provider 的既有形状与旧配置完全不变（NFR-2 由 `ai-providers.test.js` 的键集合断言守住）。

### 8.3 偏差 2：入口按钮不用 ⚡，改用 `icons/lightning.svg`

§4.5 写的是「⚡ 添加 Coding Plan」，但 `test/design-tokens.test.js` 明令渲染层不得出现 `Extended_Pictographic`（Windows 会替换为彩色 emoji 字体，跨版本渲染不一致）。改为复用既有 mask 图标集里的 `config/icons/lightning.svg`，与侧边栏「快捷功能」同一套图标语言。

### 8.4 偏差 3：header 解析拆成「写盘」与「运行时」两个函数

§4.1 只列了 `resolvePresetHeaders()`。实际拆成：

- `storageHeadersForPreset(preset, { appVersion })`：写盘用，解析 `${appVersion}`、**保留** `${sessionId}` 字面量；
- `resolveRuntimeHeaders(headers, { sessionId })`：请求时用，只替换 `${sessionId}`。

原因是 §4.2 要求 `${sessionId}` 落盘保留占位符，而单个 `resolvePresetHeaders()` 在没有 sessionId 时会把它替换成空串。`resolvePresetHeaders()` 仍保留，供目录单测与完整解析场景使用。

### 8.5 偏差 4：新增 `main/services/ai/session-id.js`

§4.3 建议 session id 放 `client.js` 或独立模块。选独立模块，导出 `getAiSessionId()` 与 `resetAiSessionIdForTests()`，使「重启后 session id 变化」可在进程内断言（`coding-plan-headers.test.js`），不必真的重启。

### 8.6 偏差 5：`main.js` 行数被 IPC 装配顶到上限，控制器装配下移到 IPC 模块

直接 `registerCodingPlanIpc({ controller: { createProvider: ... } })` 把 main.js 推到 1303 行，超过 1300 上限。改为在 `main/ipc/coding-plan-ipc.js` 导出 `createCodingPlanIpcController({ settingsService, testProviderConnection, appVersion, assertWritable })`（与既有 `createOcrIpcController` 同形），main.js 只传依赖，回到 1298 行。`assertWritable` 由控制器在调用服务前执行，沿用迁移期禁止写入的既有语义。

### 8.7 偏差 6：「目录未验证」只保留一个标记

曾让 `modelProviderStatus()` 在 `modelsVerified === false` 时也返回 warn，结果卡片上同时出现琥珀标签「目录未验证」和琥珀状态文案「模型目录未验证」，同一信息说两遍。最终保留 §4.5.4 要求的琥珀标签作为唯一标记，状态点维持绿色「已启用」——「是否启用」与「目录是否验证过」本就是两个维度。

### 8.8 设计未列、实现补上的：重试路径

§4.5 的「获取可用模型」与「测试」两个既有按钮，在预设 provider 上会重新写入模型目录。补了 `applyFetchedModels(provider, models)`：预设 provider 重拉时套用同一套端点过滤（`filterPresetModels`），拉取成功即把 `modelsVerified` 置回 `true`，让「目录未验证」标签可被用户自己清掉（D7「可稍后点测试重试」的落地）。拉取为空时不再清空目录，改为提示并保留现有模型。

### 8.9 顺带：`shared/` 纳入语法门禁

`scripts/check-js.js` 的 `sourceDirectories` 增加 `shared`。此前 `shared/` 只有 CSS，不在检查范围内；新增 JS 共享模块后必须一起过 `node --check`。

### 8.10 实际文件清单

| 文件 | 改动 |
|---|---|
| `shared/coding-plan-presets.js` | 新增：预设目录、占位符解析（写盘/运行时）、headers 清洗、端点模型过滤、`defaultModelsForProvider` 收敛 |
| `main/services/ai/session-id.js` | 新增：模块级 UUID + 测试重置 |
| `main/services/coding-plan-service.js` | 新增：`createCodingPlanProvider` 编排 |
| `main/ipc/coding-plan-ipc.js` | 新增：`coding-plan:create-provider` + 控制器装配 |
| `main/services/ai-providers.js` | provider 三个可选字段 + 清洗；删除重复的 `getProviderDefaultModels` |
| `config/routes/model-helpers.js` | 删除重复的 `defaultModelsForProvider` |
| `main/services/ai/client.js` | `headers` 透传 + `defaultHeaders` 注入 + 运行时 session 替换 |
| `main.js` / `main/services/ipc-security.js` / `preload.js` | 新 IPC 注册、渠道白名单、`createCodingPlanProvider` 暴露 |
| `config/config.html` / `config.js` / `config.css` | 共享模块加载、工具栏按钮、预设选择器、简化表单、结果反馈、功能引导、徽标、样式 |
| `scripts/check-js.js` | `shared/` 纳入语法检查 |
| `scripts/probe-model-config-ui.js` / `test/model-config-runtime.test.js` | 探针与断言覆盖 coding plan 全链路 |
| `test/coding-plan-presets.test.js`、`test/coding-plan-service.test.js`、`test/coding-plan-headers.test.js` | 新增 |
| `test/ai-providers.test.js`、`test/ipc-module-contracts.test.js`、`test/config-model-helpers.test.js`、`test/model-config-ui-contract.test.js` | 扩写 |

### 8.11 仍待办

- **M3**：三个 plan 各用真实 key 手动冒烟一次，固化 GLM / MiniMax 的 `GET /models` 实际行为（若确认不支持，兜底清单即为长期行为）。
- OpenCode Go `/messages` 组模型支持另立设计（本期按 D5 过滤）。

