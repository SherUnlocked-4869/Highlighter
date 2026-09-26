# 设计文档：划词结果窗口的多轮对话（追问）

- 日期：2026-09-26
- 基线：`master` @ `5b1ba7d`（v2.2.7）
- 状态：**第一版已实施并通过真机验证**（决策点已确认，见第 1 节；真机验证后的修正见第 16 节）
- 关联：`docs/plans/2026-09-10-mainjs-assert-inventory.md`（第 4 节新增断言规则）、`docs/plans/2026-09-10-v2.3-architecture-roadmap.md`（main.js 瘦身议程）、`docs/superpowers/specs/2026-07-23-selection-toolbar-design.md`
- 结论摘要：在划词结果窗口（`action/`）引入**会话**概念——首轮请求的结果作为对话的第一条助手消息，用户可基于它继续追问；会话状态由新的纯逻辑服务 `main/services/action-conversation.js` 持有，`main.js` 只做装配，渲染层从「单个扁平结果」改为「多轮消息流 + 底部输入区」。

---

## 1. 需求与已确认决策

### 1.1 需求

用户划词后点击翻译/解释，结果窗口给出模型回答。用户希望**就这份结果继续追问**（例如「第二段再展开说说」「这里的术语换成更通俗的说法」），而不是被迫重新划词、重新发起。

### 1.2 已确认决策

| # | 决策点 | 结论 | 理由 |
|---|---|---|---|
| D1 | 适用范围 | 翻译、解释、**自定义动作**（`custom:*`）全部支持 | 三者共用同一个结果窗口、同一条流式链路与同一个 `createExplainStream` 入口，只支持两者反而增加分支 |
| D2 | 仅翻译模型能否追问 | 首轮按原翻译规则执行；追问需要 `chat` 能力，不满足时**禁用输入框并给出提示** | `resolveAiAssignment` 允许把仅翻译模型分配给 `toolbar:translate`（`ai-model-capabilities.js:38 taskForFeature`），此时追问必然失败，必须前置拦截而不是让请求报错 |
| D3 | 上下文策略 | 携带完整历史，但设**上限**：追问轮数上限 10、上下文字符预算 24000，超出时从**最旧**的追问轮开始裁剪 | 长文翻译后追问极易超 token；锚点（原文 + 首轮结果）永不裁剪 |
| D4 | 新划词时的旧会话 | **覆盖丢弃**，沿用现有窗口复用逻辑 | `getOrCreateActionWindow()` 复用未置顶窗口，引入会话列表是另一个量级的工作 |
| D5 | 是否落盘 | 第一版不落盘 | 会话属于瞬时交互，落盘涉及隐私面与清理策略 |
| D6 | 迭代切分 | 第一版只做「多轮可用」，设置开关与复制整段对话放第二版，片段引用追问与会话持久化放第三版 | 见第 13 节 |

---

## 2. 现状与关键约束

### 2.1 现有链路

```
划词 → toolbar/ 浮动工具栏 → 点击 AI 动作
     → main.js:1282 openToolbarAiAction()
     → selectionWindowManager.getOrCreateActionWindow()（复用未置顶窗口）
     → queueActionMessage(win, 'action:start', {...})
     → main.js:1094 streamToWindow()  流式推送 stream:data / stream:reasoning
     → queueActionMessage(win, 'stream:done' | 'stream:error')
     → 渲染层 action/action.js 把增量拼进全局 fullText，渲染到单个 #result
```

**这是一条严格单轮的链路**：消息只装配一次、流通道没有轮次概念、渲染层只有一个累积变量。

### 2.2 关键代码事实

| 事实 | 位置 | 对本次改造的含义 |
|---|---|---|
| 消息只装配一次：`[{system: prompt}, {user: 原文}]` | `main/services/ai/client.js:351 buildToolbarMessages` | 必须引入多轮 `messages`，且追问轮要换系统提示词（见 5.2） |
| 翻译系统提示词要求「只输出译文，不添加解释」 | `ai/client.js:315 composeTranslateSystemPrompt` | **不能**在追问轮沿用该提示词，否则模型拒绝回答追问 |
| 流通道无轮次标识，渲染层靠全局 `fullText` 累积 | `action/action.js:337/355/367` | 渲染层要改为「当前轮」模型；下行通道复用但语义变为「本轮」 |
| 思考过程块用固定 id `reasoningBox` 单例插入 | `action/action.js:265 addReasoning` | 必须改为按轮次挂载 |
| 流会话是全局单槽 + 全局闸门 | `main.js:290-293, 1067-1092` | 同一时刻只有一个在飞的轮次；可用来简化渲染层的流路由（见 8.4） |
| 供应商按动作绑定：`toolbar:translate` / `toolbar:explain` / `custom:<id>` | `ai-providers.js:245 resolveToolbarAiProvider` | 追问必须沿用同一绑定，不能中途换模型 |
| 未置顶窗口失焦会隐藏并**取消**在途流，且不通知渲染层 | `main.js:854 onActionWindowBlur` → `cancelToolbarStream(win,'window-hidden')` | 追问轮被隐藏打断时渲染层会僵在「生成中」，需要恢复路径（见 8.6） |
| 生成期间新的划词被静默丢弃 | `main.js:1036 handleTextSelection` 的 `isProcessing` 闸门 | 追问生成期间划词无效，属已知取舍，见 11 节 |
| 窗口最小高度 300 | `toolbar/toolbar-utils.js:30, 90` | 输入区需要竖向空间，需上调 |
| 渲染进程 `sandbox: true` + CSP `connect-src 'none'` | `action/action.html:6`、`preload-action.js` | 所有 AI 调用必须走 IPC，桥只暴露必要函数 |
| IPC 通道必须在 `IPC_SURFACES` 声明并在所有装配点注册 | `main/services/ipc-security.js:60-65, 278 assertComplete` | 新增通道会连锁影响 `main.js` 与 `scripts/probe-action-security.js` |

### 2.3 硬约束（决定方案形态）

| 约束 | 现状 | 结论 |
|---|---|---|
| `main.js` 行数上限 2100 | 当前 2045（`scripts/check-architecture.js:11`） | **只有 55 行余量**。会话状态机、消息装配、流循环都必须放进服务模块，`main.js` 只留装配 |
| `assertComplete()` 要求所有声明通道都被注册 | `ipc-security.js:278` | 新增 `chat:ask` 后必须同步改 `main.js` 与 `scripts/probe-action-security.js`，否则启动即抛错 |
| 安全探针锁定了 `actionAPI` 的**完整键列表**与 DOM 选择器 | `test/action-security-runtime.test.js:34, 60-70`、`scripts/probe-action-security.js` | 新增桥函数与 DOM 重命名必须在同一次改动内更新探针与其断言 |
| 新增功能禁止对 `main.js` 用源码文本断言 | `docs/plans/2026-09-10-mainjs-assert-inventory.md` 第 4 节 | 新测试必须写在抽出的服务/纯函数上 |
| 结果窗口尺寸钳制被断言为 300 | `test/toolbar-utils.test.js:116-119` | 上调最小高度时该断言需同步更新 |

---

## 3. 总体设计

### 3.1 分层

```
┌─ 渲染层  action/action.js · action.html · action.css
│    会话状态（turns[]）· 多轮消息流渲染 · 底部输入区 · 本轮流式路由
├─ 桥      preload-action.js        +askQuestion / +onChatTurn / onStreamError 增加 cancelled
├─ 策略    main/services/ipc-security.js   action 面新增 chat:ask
├─ 装配    main.js                  只做：建会话、转发、把轮次交给服务层
├─ 会话    main/services/action-conversation.js   ★新增
│    ActionConversation（状态机）· buildFollowUpMessages（纯函数）
│    resolveFollowUpSupport（能力闸门）· streamConversationTurn（流循环）
└─ 模型    main/services/ai/client.js  +createFollowUpStream
          main/services/ai-providers.js（不改）
          main/services/ai-model-capabilities.js（不改）
```

**设计原则**：把「轮次 / 上下文 / 限额 / 能力闸门」全部收敛到 `action-conversation.js`，它是一个不依赖 Electron 的普通模块（流循环通过注入的 `queueMessage` 与 `createStream` 与外界交互），因此可以用 `node:test` 直接覆盖，不需要启动 Electron。

### 3.2 三个必须说清楚的语义

1. **`streamId` 的语义从「一次请求」升级为「一次会话」**。`action:start` 分配一次，整个会话（含所有追问轮）复用同一个 `streamId`。这样 `stream:cancel` / `stream:finish` 的既有陈旧性校验（`main.js:1089 isStaleToolbarStreamSignal`）与 `matchesSender` 语义都不用动。
2. **控制器（`ToolbarStreamSession`）的粒度仍是「一轮」**。每轮新建一个控制器（新的 `AbortController` + 新的空闲计时器），轮流结束后 `currentStreamController = null`、`isProcessing = false`，但会话对象继续存活。这保证「停止本轮」不会摧毁会话，也保证追问之间划词功能恢复可用。
3. **`currentStreamController` 单槽是渲染层流路由的地基**。因为主进程用 `isProcessing` 保证同一时刻只有一个在飞的轮次，渲染层可以安全地把到达的 `stream:data` 一律归到「当前开启的助手轮」，不需要在通道里传轮次 id。

### 3.3 数据流（追问轮）

```
渲染层 askQuestion(streamId, q)
  → IPC chat:ask {streamId, question}
  → main.js 取该窗口的 ActionConversation，校验 streamId
  → conversation.beginTurn(q)      失败 → queueMessage('stream:error', {error, rejected:true})
  → queueMessage('chat:turn', {streamId, question})     ← 渲染层据此落用户气泡 + 开新助手轮
  → streamConversationTurn()  → createFollowUpStream(provider, conversation.buildMessages(), {signal, thinking})
  → queueMessage('stream:data' | 'stream:reasoning')     ← 渲染层追加到当前助手轮
  → queueMessage('stream:done')
  → conversation.commitTurn({content})
```

---

## 4. 会话服务层（新增 `main/services/action-conversation.js`）

### 4.1 常量

```js
const MAX_FOLLOW_UP_TURNS = 10          // 追问轮数上限
const MAX_QUESTION_LENGTH = 2000        // 单次追问字符上限
const MAX_CONTEXT_CHARS = 24000         // 追问上下文字符预算（含系统提示词与锚点）
const FOLLOW_UP_TASK = 'chat'           // 追问所需的模型能力
```

第一版为模块内常量；第二版允许由 `selectionToolbar.conversation` 覆盖（见 13 节）。

### 4.2 纯函数

```js
// 能力闸门：复用 client.js 的归一化，保证与 create*Stream 的判定完全一致
function resolveFollowUpSupport(provider, { translateLanguages } = {})
// → { canFollowUp: boolean, reason: string }
```

实现要点：**不能**直接读 `provider.capabilities`——`resolveAiAssignment` 返回的是 `{...provider, model, apiKey}`（`ai-providers.js:242`），能力挂在 `provider.models[i].capabilities` 上。必须走 `normalizeProviderInput(provider)`（`ai/client.js:573` 已导出）后再用 `modelSupportsTask({capabilities}, 'chat')`（`ai-model-capabilities.js:32`）判定。

```js
// 追问轮的系统提示词
function buildConversationSystemPrompt({ actionId, label, translateLanguages })
// 追问轮的完整 messages
function buildFollowUpMessages({ conversation, question })
// 上下文裁剪（纯函数，便于单测）
function trimHistory(history, budget)
```

### 4.3 追问轮的 messages 装配规则

```
[
  { role: 'system',    content: <会话系统提示词> },
  { role: 'user',      content: <划词原文> },
  { role: 'assistant', content: <首轮结果> },
  ...裁剪后的追问历史（user/assistant 成对，旧 → 新）,
  { role: 'user',      content: <本次追问> }
]
```

**关键取舍：追问轮不复用首轮的系统提示词，而是替换为会话提示词。**
首轮翻译的系统提示词是「你是专业翻译引擎……只输出译文，不添加解释」（`ai/client.js:315`），如果照搬到追问轮，模型会拒绝对话。解释的默认提示词是固定的三段式模板（`toolbar-utils.js:2 DEFAULT_EXPLAIN_PROMPT`），同样会压制追问。因此追问轮改用：

```
你正在「划词助手」的结果窗口中继续对话。
用户此前划选了一段文本并执行了「{label}」操作，你已回答（见上文助手消息）。
现在请直接回答用户的追问：可以引用原文或你此前的回答；不要重复输出此前的完整回答。
使用与用户提问相同的语言回答。

【原始任务】划词翻译（{source} → {target}） | 划词解释 | 自定义指令：{label}
```

- 翻译动作额外拼接「原始任务」里的语言方向，让模型知道译文的目标语言。
- **自定义动作额外拼接其原始提示词全文**（`【原始任务的指令】\n{prompt}`），因为自定义提示词通常承载用户真正的意图，是有效上下文。
- 内置翻译/解释**不**拼接原始提示词，避免与「只输出译文 / 三段式模板」冲突。

### 4.4 `ActionConversation` 状态机

```js
class ActionConversation {
  constructor({
    win, streamId, action,          // action = getToolbarActionDefinition 的结果
    provider, translateLanguages,
    thinking,                       // 沿用 getToolbarActionThinking 的结果
    maxFollowUpTurns = MAX_FOLLOW_UP_TURNS,
    maxQuestionLength = MAX_QUESTION_LENGTH,
    maxContextChars = MAX_CONTEXT_CHARS
  })

  get streamId()
  get firstResult()                 // 首轮助手内容
  get followUpCount()               // 已完成 + 在飞的追问轮数
  get status()                      // → { canFollowUp, disabledReason, followUpCount, maxFollowUpTurns, questionMaxLength }
  get isTurnPending()

  beginTurn(question)               // → { ok: true, question } | { ok: false, reason, rejected: true }
  buildMessages()                   // → 供本轮请求使用的 messages[]
  commitTurn({ content })           // 本轮成功：把 (question, content) 记入历史
  rollbackTurn()                    // 本轮失败/取消：丢弃在飞问题与部分内容，不进历史
}
```

`status.canFollowUp` 为真的四个必要条件（任一不满足都给出对应的中文 `disabledReason`）：

1. 首轮请求成功且首轮结果非空 → 否则「首次请求失败，无法继续追问，请重新划词」
2. `resolveFollowUpSupport` 通过 → 否则「当前模型仅支持翻译，无法追问。请在「模型」设置中为划词功能选择一个支持对话的模型」
3. 追问轮数未达上限 → 否则「已达到最大追问轮数（10），请重新划词开始新会话」
4. 当前没有在飞的轮次（渲染层会禁用，服务端作为安全网）

### 4.5 裁剪规则

`trimHistory(history, budget)`：

1. 计算固定部分的字符数：系统提示词 + 原文 + 首轮结果 + 本次追问。
2. 预算剩余部分，从**最新**的追问对向前装填，直到装不下为止；被丢弃的总是最旧的整对（不保留半对）。
3. 若固定部分本身已超预算，**不做任何裁剪**——原文受 `main.js:1041` 的 10000 字符闸门约束，首轮结果量级有限，强行裁剪锚点会让模型失去上下文，得不偿失。

### 4.6 流循环

```js
async function streamConversationTurn({
  conversation, win, controller, settings,
  queueMessage = () => {},
  createStream = require('./ai/client').createFollowUpStream
}) { /* for await … queueMessage('stream:data' | 'stream:reasoning') … */ }
```

放在服务层的理由：`main.js` 只有 55 行余量，把 `for await` 循环搬进来可以让 `main.js` 的净新增控制在 20 行以内。

与 `main.js:1094 streamToWindow` 的差异只有两点，其余（`controller.cancelled` 检查、`win.isDestroyed()` 检查、每块 `armToolbarStreamTimeout`）保持一致：

- 每块增量重置空闲计时器之外，**不再**发送 `stream:done` 之外的收尾动作；
- 取消时按原因分流：`user-cancelled` → 发 `stream:error {error:'已停止生成', cancelled:true}`；其他原因（`window-hidden` / `window-closed` / `game-mode`）保持现状**不发通知**。

### 4.7 失败轮的回滚语义（显式取舍）

轮次失败或取消时：**部分内容不进上下文**，但**保留在会话记录里**供界面显示（渲染层标为「已停止生成」/ 错误）。

- 好处：上下文不会被半截回答污染，用户重试不会造成历史重复。
- 代价：用户看到的那半截回答在后续追问时模型并不知道。这是有意为之，代价可接受且可预期。
- 渲染层提供「重试」：把该问题原文填回输入框，用户手动再发（服务层无需特殊支持）。

---

## 5. AI 客户端层（`main/services/ai/client.js`）

新增一个函数，形态与 `createExplainStream`（`:532`）对齐：

```js
async function createFollowUpStream(provider, messages, requestOptions = {}) {
  const config = normalizeProviderInput(provider)
  if (!config.enabled) throw new Error('该功能指定的模型供应商已禁用')
  if (!config.baseUrl) throw new Error('该功能未配置可用的模型供应商或 API 地址')
  if (!config.apiKey) throw new Error('请先在“模型”设置中为该功能配置 API 密钥')
  if (!config.model) throw new Error('请先在“模型”设置中为该供应商配置模型')
  if (!modelSupportsTask({ capabilities: config.capabilities }, 'chat')) {
    throw new Error('当前模型不支持对话，无法继续追问')
  }
  const streamOptions = splitStreamRequestOptions(requestOptions, true)
  return withConnectionFallback(config, async (attempt) =>
    createAiProtocolAdapter(attempt, createClient(attempt))
      .stream(messages, { thinking: streamOptions.thinking }, streamOptions.requestOptions))
}
```

要点：

- 复用 `withConnectionFallback`，因此 `/v1` 后缀回退与 `openai-responses` → `openai-chat` 回退对追问自动生效。
- `thinking` 沿用首轮动作的档位（`getToolbarActionThinking(selectionToolbar, toolbarThinking, action.id)`），保证会话内一致。
- `splitStreamRequestOptions` 的兜底值传 `true`（保持思考开启），与 `createExplainStream` 一致。
- 思维链通过既有的 `delta.reasoning_content` 通道回流，无需改动协议适配层。
- 不新增对 `openai-responses` 的特殊处理——`createAiProtocolAdapter` 已统一两条协议。

---

## 6. 主进程装配层（`main.js`）

### 6.1 状态与生命周期

```js
const actionConversations = new Map()   // win → ActionConversation
```

- `action:start` 时创建（覆盖旧条目，落实 D4 覆盖丢弃）。
- `onActionWindowClosed`（`main.js:850`）中删除条目（+2 行）。
- 窗口仅隐藏（失焦）时**保留**会话——窗口对象还活着，重新唤起时对话记录仍在。
- 关闭/隐藏/游戏模式导致在途轮次被取消时，回调里补一次 `conversation.rollbackTurn()`。

### 6.2 `openToolbarAiAction` 的改动（`main.js:1282`）

```
1. 解析 actionDefinition / aiRuntime（不变）
2. 校验 apiKey（不变）
3. resolveFollowUpSupport(aiRuntime, ...) → { canFollowUp, reason }
4. 建 ActionConversation，写入 actionConversations
5. 创建本轮控制器（沿用会话的 streamId）
6. queueActionMessage('action:start', { …, followUp: { enabled, disabledReason, maxTurns, questionMaxLength } })
7. 首轮流循环（不变）
```

`action:start` 载荷扩展（向后兼容，纯新增字段）：

```js
{
  type, label, icon, text, streamId, appearance,     // 既有字段全部不变
  followUp: {
    enabled: boolean,
    disabledReason: string,
    maxTurns: number,
    questionMaxLength: number
  }
}
```

### 6.3 控制器创建

`createToolbarStreamController(win)`（`main.js:1067`）增加可选参数：

```js
function createToolbarStreamController(win, streamId) {
  …
  if (streamId === undefined) { toolbarStreamSeq += 1; controller.streamId = toolbarStreamSeq }
  else controller.streamId = streamId          // 追问轮复用会话 id
  …
}
```

`onFinish` 回调（`main.js:1071-1075`）逻辑不变：只有当前控制器才清空 `currentStreamController` 与 `isProcessing`。这样轮与轮之间闸门自动放开。

### 6.4 `chat:ask` 处理器

```js
secureIpcMain.on('chat:ask', (event, payload) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const conversation = win ? actionConversations.get(win) : null
  if (!conversation) return
  if (Number(payload?.streamId) !== conversation.streamId) return
  const turn = conversation.beginTurn(payload?.question)
  if (!turn.ok) {
    queueActionMessage(win, 'stream:error', { error: turn.reason, rejected: true })
    return
  }
  queueActionMessage(win, 'chat:turn', { streamId: conversation.streamId, question: turn.question })
  const controller = createToolbarStreamController(win, conversation.streamId)
  streamConversationTurn({ conversation, win, controller, settings: getSettings(),
    queueMessage: (channel, data) => queueActionMessage(win, channel, data) })
    .catch((error) => { /* 与 streamToWindow 同样的兜底：非取消则发 stream:error */ })
})
```

注意：`createToolbarStreamController` 会置 `isProcessing = true`，因此**追问流式期间新的划词被丢弃**（既有行为，见 11 节）。这一副作用同时保证了 3.2 中「同一时刻只有一个在飞轮次」的不变量，渲染层的流路由依赖它。

### 6.5 `main.js` 行数预算

| 改动 | 估计 |
|---|---:|
| 引入 require + `actionConversations` 声明 | +3 |
| `createToolbarStreamController` 增加 streamId 参数 | +3 |
| `openToolbarAiAction` 建会话 + 扩展载荷 | +12 |
| `chat:ask` 处理器 | +18 |
| `onActionWindowClosed` 清理 | +2 |
| `streamToWindow` 收窄为「首轮」包装 | -4 |
| **净增** | **≈ +34**（2045 → ≈2079 < 2100） |

行数余量只剩约 20 行，因此**任何**把更多逻辑塞回 `main.js` 的冲动都应当被拒绝——这是本设计把状态机和流循环都放进服务模块的直接原因。若后续余量耗尽，应先推进 `docs/plans/2026-09-10-v2.3-architecture-roadmap.md` 的域迁出，而不是上调 `MAX_MAIN_LINES`。

---

## 7. 预加载桥与 IPC 安全策略

### 7.1 `preload-action.js`

```js
askQuestion: (streamId, question) => {
  if (!Number.isSafeInteger(streamId) || streamId <= 0) return false
  if (typeof question !== 'string') return false
  const value = question.trim().slice(0, MAX_QUESTION_LENGTH)   // 2000
  if (!value) return false
  ipcRenderer.send('chat:ask', { streamId, question: value })
  return true
},
onChatTurn: (callback) => subscribe('chat:turn', callback, (data) => ({
  streamId: Number.isSafeInteger(data?.streamId) ? data.streamId : null,
  question: boundedText(data?.question, MAX_QUESTION_LENGTH)
})),
onStreamError: (callback) => subscribe('stream:error', callback, (data) => ({
  error: boundedText(data?.error, 4096),
  cancelled: data?.cancelled === true,
  rejected: data?.rejected === true
}))
```

- 渲染进程侧做长度与类型钳制，主进程侧再做一次（`beginTurn` 内 `slice`），双向校验。
- `cancelled` / `rejected` 让渲染层区分「用户主动停止」「服务端拒绝」「真实错误」三种收尾。
- 新函数只加在 `preload-action.js`：`test/window-security.test.js:118` 断言通用 `preload.js` 不得包含 action 类通道，新通道不能进通用桥。

### 7.2 `ipc-security.js`

```js
{
  role: 'action',
  page: 'action/action.html',
  handles: ['shell:open-external'],
  listeners: ['stream:cancel', 'stream:finish', 'window:toggle-pin', 'chat:ask']
}
```

连锁影响（必须同批次完成，否则启动即失败）：

| 文件 | 改动 |
|---|---|
| `main.js` | 注册 `chat:ask` 处理器——否则 `assertComplete()`（`ipc-security.js:278`，在 `main.js:1819` 调用）抛错 |
| `scripts/probe-action-security.js` | 注册 `chat:ask` 并记录 `chatAsks`；在 `action:start` 载荷中补 `followUp` |
| `test/action-security-runtime.test.js` | 更新 `actionKeys` 期望（新增 `askQuestion`、`onChatTurn`）与 `streamSignals` 期望 |
| `test/ipc-security.test.js` | **无需改动**——它用 `registerPolicySurface` 动态遍历全部策略（`:69-75`），自动覆盖新通道 |

### 7.3 安全面不变式

- 渲染层 `sandbox: true` + `contextIsolation: true`，追问内容只能经 `chat:ask` 一个通道进入主进程。
- 追问内容（用户输入）在渲染层一律用 `textContent` 注入，绝不进 `innerHTML`。
- 助手输出继续走 `simpleMarkdown` + DOMPurify 白名单（`action/action.js:207 sanitizedMarkdown`），**多轮不改变这条约束**：每一轮助手内容独立走同一条净化路径。

---

## 8. 渲染层（`action/action.js` / `action.html` / `action.css`）

### 8.1 状态模型

```js
const conversation = {
  streamId: null,
  followUp: { enabled: false, disabledReason: '', maxTurns: 10, questionMaxLength: 2000 },
  turns: [],            // [{ role:'user'|'assistant', content, reasoning, status, errorMarkup }]
  activeTurn: -1,       // 正在流式的助手轮下标，-1 表示空闲
  pendingQuestion: ''   // 已发送但尚未收到 chat:turn 回显的问题
}
```

轮的 `status`：`streaming` | `done` | `error` | `cancelled` | `rejected`。

### 8.2 DOM 结构

```html
<div class="header">…（不变）…</div>

<div class="content" id="content">
  <div class="source" id="sourceText"></div>
  <div class="transcript" id="transcript"></div>   <!-- 原 #result 的位置与角色 -->
  <div id="scrollSentinel" class="scroll-sentinel"></div>
  <div class="loading" id="loading">…</div>
</div>

<div class="composer" id="composer">
  <div class="composer-row">
    <textarea id="questionInput" rows="1" maxlength="2000"
              placeholder="就上面的结果继续追问…"></textarea>
    <button class="send-btn" id="btnSend" title="发送"></button>
  </div>
  <div class="composer-hint" id="composerHint"></div>
</div>
```

轮的骨架：

```html
<div class="turn turn-user"><div class="bubble">…问题…</div></div>

<div class="turn turn-assistant">
  <div class="reasoning-box">…（仅该轮有思考内容时挂载）…</div>
  <div class="answer">…sanitized markdown…</div>
  <div class="turn-note">已停止生成 / 错误信息</div>
</div>
```

**容器从 `#result` 更名为 `#transcript`**，含义从「一个结果」变为「整段对话（用户与助手消息）」。这会牵动安全探针的选择器，属必须同步的改动（见 7.2）。

### 8.3 输入区行为

| 场景 | 行为 |
|---|---|
| `followUp.enabled === false` | 禁用 textarea 与发送键，`#composerHint` 显示 `disabledReason`（如仅翻译模型的提示） |
| 追问轮数达到 `maxTurns` | 禁用输入，提示「已达到最大追问轮数（N），请重新划词开始新会话」 |
| 空闲且可用 | 启用；`Enter` 发送，`Shift+Enter` 换行；**必须判 `event.isComposing`**，否则中文输入法选词回车会误发 |
| 有轮次在飞 | textarea 禁用，发送键切换为「停止」，点击 → `cancelStream(streamId)` |
| 点击发送 | 不清空输入框，保留文本直到收到 `chat:turn` 回显后再清空；期间禁用输入 |
| 收到 `chat:turn` | 落用户气泡、开新助手轮、清空输入框、重置 `userScrolled = false`、滚动到底 |
| 收到 `rejected` 的 `stream:error` | 输入框文本原样保留、重新启用，`#composerHint` 显示拒绝原因 |
| 输入框高度 | `textarea` 自增高，上限约 5 行（120px），超出内部滚动 |

### 8.4 流式路由

因为主进程保证同一时刻只有一个在飞轮次（3.2 不变量 3），渲染层不需要轮次 id：

- `onStreamData` → `turns[activeTurn].content += content`，标记 `resultDirty`，按帧渲染。
- `onStreamReasoning` → `turns[activeTurn].reasoning += content`，标记 `reasoningDirty`。
- `onStreamDone` → 该轮 `status = 'done'`；`activeTurn = -1`；启用输入区；`finishStream(streamId)`。
- `onStreamError({ error, cancelled, rejected })` → 该轮 `status = cancelled|error|rejected`；`activeTurn = -1`；按状态渲染轮内注释；启用输入区；`finishStream(streamId)`。

首轮（`activeTurn === 0`）的渲染路径与现状完全一致，包括增量渲染与光标、思考过程折叠块、`userScrolled` 的自动滚动抑制。

**思考过程块按轮挂载**：`addReasoning()` 从「按 id 找全局块」改为「在指定轮的助手容器内创建」，`resetUI()` 不再需要 `document.getElementById('reasoningBox')?.remove()`。

### 8.5 渲染与净化

- 每个助手轮独立调用 `sanitizedMarkdown`，`ALLOWED_MARKDOWN_TAGS` 白名单不变。
- 链接处理从「`el.result` 上的一次性委托」改为在 `#transcript` 上统一委托，并在每轮渲染后复用现有的 `normalizeExternalUrl` 改写逻辑。
- 用户气泡用 `textContent`，绝不过 markdown。

### 8.6 中断恢复（失焦隐藏）

未置顶窗口失焦会被隐藏并取消在途流，主进程**不发通知**（保持现状，避免改变首轮行为）。渲染层用 `visibilitychange` 自愈：

```js
document.addEventListener('visibilitychange', () => {
  if (!document.hidden || conversation.activeTurn < 0) return
  conversation.turns[conversation.activeTurn].status = 'cancelled'
  conversation.turns[conversation.activeTurn].note = '窗口已隐藏，生成已中断'
  conversation.activeTurn = -1
  renderComposer()     // 重新启用输入区，输入框内容保留
})
```

选择渲染层自愈而不是主进程补发通知，是因为后者会同时改变首轮（既有行为）的收尾方式，回归面更大。渲染层方案把改动完全限制在本文件内。

### 8.7 其他必须保持的既有行为

- `applyAppearance` / `action:appearance` 广播、`systemThemeMedia` 监听。
- 置顶按钮与 `window:pin-denied` 提示。
- `#content` 上的 `wheel` → `userScrolled = true`。
- 30 秒空闲超时（`STREAM_IDLE_TIMEOUT_MS`）**按轮次重新计时**：每轮开始时重新 `armStreamTimeout()`，超时只结束当前轮，不摧毁会话。

---

## 9. 样式与窗口尺寸

### 9.1 CSS 增量（`action/action.css`）

```css
/* ---------- transcript ---------- */
.transcript .turn { margin-bottom: 18px; }
.transcript .turn-user { display: flex; justify-content: flex-end; }
.transcript .turn-user .bubble {
  background: var(--primary-soft); color: var(--text);
  border: 1px solid var(--primary-line); border-radius: var(--radius-sm);
  padding: 10px 12px; max-width: 86%; font-size: 13px;
  white-space: pre-wrap; word-break: break-word;
}
.transcript .turn-note { margin-top: 6px; font-size: 12px; color: var(--muted); }
.transcript .turn-note.error { color: var(--danger); }

/* ---------- composer ---------- */
.composer { flex-shrink: 0; border-top: 1px solid var(--line); background: var(--panel); padding: 10px 12px 8px; }
.composer-row { display: flex; align-items: flex-end; gap: 8px; }
.composer textarea {
  flex: 1; resize: none; max-height: 120px; min-height: 34px;
  background: var(--surface-2); color: var(--text);
  border: 1px solid var(--line); border-radius: var(--radius-sm);
  padding: 8px 10px; font: inherit; font-size: 13px; line-height: 1.5; outline: none;
}
.composer textarea:focus { border-color: var(--primary-line); }
.composer textarea:disabled { opacity: .6; cursor: not-allowed; }
.composer .send-btn { /* 圆形主色按钮，流式中切换为停止方块 */ }
.composer-hint { margin-top: 6px; font-size: 11px; color: var(--muted); }
```

配色只允许使用 `shared/tokens.css` 的变量（`action.css` 顶部有明确注释禁止本文件自带调色板），并沿用「每个面只有一个强调色」的既有原则——追问气泡用 `--primary-soft` 作底，助手轮保持无底色。

### 9.2 窗口尺寸

| 常量 | 现值 | 新值 | 理由 |
|---|---:|---:|---|
| `ACTION_WINDOW_MIN_HEIGHT` | 300 | **340** | 头部约 48px + 输入区约 90px，300 只剩约 160px 给内容，无法阅读 |
| `ACTION_WINDOW_DEFAULT_SIZE` | 550×520 | 550×**560** | 新增输入区后的默认可用高度 |
| `ACTION_WINDOW_MIN_WIDTH` | 380 | 380 | 不变 |

**必须同步更新**：`test/toolbar-utils.test.js:116-119` 断言了高度钳制为 300，需改为 340；`test/toolbar-utils.test.js:28` 断言默认尺寸需改为 560。

注意 `resultWindow` 是**已持久化**的用户设置（`selection-window-manager.js:211 persistActionWindowSize`），老用户仍会是 520 高。这是可接受的：`normalizeActionWindowSize` 的钳制会保证不低于新的最小值，且用户可自行拖大。

---

## 10. 关键时序

### 10.1 正常追问

```
用户       渲染层                    主进程                         模型
 │ 输入问题
 │ ────────► askQuestion(7, q)
 │            │ 清空输入框（收到回显后）
 │            │ ──── chat:ask {7,q} ────►
 │            │                          conversation.beginTurn(q) ✓
 │            │ ◄── chat:turn {7,q} ──────
 │            │ 落用户气泡 / 开助手轮 / 滚动到底
 │            │ ◄── stream:data … ──────── createFollowUpStream(messages)
 │            │ ◄── stream:reasoning … ──
 │            │ ◄── stream:done ────────── conversation.commitTurn({content})
 │            │ 启用输入区 / finishStream(7)
```

### 10.2 仅翻译模型：追问被前置禁用

```
action:start { followUp: { enabled:false,
                disabledReason:'当前模型仅支持翻译，无法追问。请…' } }
→ 渲染层：输入框禁用 + 提示常显，用户从不发出 chat:ask
```

### 10.3 用户主动停止本轮

```
点击「停止」→ cancelStream(7)
→ main.js: stream:cancel → controller.cancel('user-cancelled')
→ streamConversationTurn 检测到 cancelled 且原因为 user-cancelled
→ queueMessage('stream:error', { error:'已停止生成', cancelled:true })
→ 渲染层：该轮 status='cancelled'，显示灰色「已停止生成」，启用输入区
→ 服务层：rollbackTurn()，该轮不进上下文
```

### 10.4 追问中窗口失焦被隐藏

```
失焦 → onActionWindowBlur → cancelToolbarStream(win,'window-hidden')（不发通知，保持现状）
渲染层 visibilitychange(hidden) → 该轮标为 cancelled + 注释「窗口已隐藏，生成已中断」→ 启用输入区
重新唤起窗口 → 对话记录完整保留，可继续追问
```

### 10.5 达到轮数上限

```
第 11 次发送 → beginTurn 返回 { ok:false, reason:'已达到最大追问轮数（10）…' }
→ stream:error { error:<reason>, rejected:true }
→ 渲染层：输入框文本保留、显示提示、输入区转为禁用（canFollowUp 已为 false）
```

### 10.6 首轮失败

```
首轮流循环异常 → stream:error
→ 渲染层：显示错误，followUp.enabled 保持 true 但首轮无结果
→ 服务层：firstResult 为空 → status.canFollowUp = false
→ 渲染层输入区禁用，提示「首次请求失败，无法继续追问，请重新划词」
```

---

## 11. 边界与异常处理

| 场景 | 处理 |
|---|---|
| 追问流式期间用户划选新文本 | 被 `isProcessing` 闸门丢弃（`main.js:1036`），日志 `busy`。**保留既有行为**，不引入抢占；若后续反馈强烈，再单独评估「新划词抢占在途轮次」 |
| 追问流式期间用户点另一个划词动作 | 同上被丢弃；窗口内容不被替换，会话保持完整 |
| 追问流式期间用户关闭窗口 | `onActionWindowClosed` → 取消控制器 + 删除 `actionConversations` 条目 |
| 追问流式期间切换游戏模式 | `main.js:1388` 取消控制器；会话条目随窗口关闭清理 |
| 追问内容为空或全空白 | 渲染层不发；服务层 `beginTurn` 二次拦截，返回 `ok:false` |
| 追问内容超长 | 渲染层 `maxlength` + 桥 `slice(2000)` + 服务层 `slice` 三重钳制 |
| `streamId` 不匹配（陈旧回显） | `chat:ask` 处理器直接 `return`，不做任何回应（与 `isStaleToolbarStreamSignal` 的静默语义一致） |
| 收到 `chat:turn` 后模型立即报错 | 该轮标记 `error`，问题已在界面上，历史未提交；用户可直接重发 |
| 上下文被裁剪 | 界面不做任何提示（裁剪是静默的实现细节）；第二版可在输入区提示「超出上下文，已省略早期对话」 |
| 翻译结果追问时模型仍输出「只输出译文」风格 | 由会话系统提示词规避；不做后处理，避免过度工程 |
| 思考档位为 `off` 的翻译动作追问 | 沿用 `off`；追问轮不发 `stream:reasoning`，思考块不挂载 |

---

## 12. 测试计划

### 12.1 新增

| 文件 | 覆盖 |
|---|---|
| `test/action-conversation.test.js` | `buildConversationSystemPrompt` 三种动作形态（翻译含语言方向、自定义含原始指令、解释不含提示词）；`resolveFollowUpSupport` 对仅翻译模型返回 `canFollowUp:false` 且带原因、对普通模型返回 true（**必须用 `resolveAiAssignment` 的真实返回形状构造 provider**，即能力挂在 `models[i].capabilities` 上，防止实现误读 `provider.capabilities`）；`beginTurn` 的空问题/超长/超轮数/在飞拒绝；`trimHistory` 在预算内保留全部、超预算丢最旧整对、锚点超预算时不裁剪；`rollbackTurn` 后历史不含失败轮；`commitTurn` 后 `buildMessages` 顺序正确 |
| `test/ai-client.test.js`（扩展） | `createFollowUpStream`：未配置供应商 / 缺 apiKey / 缺 model 的报错文案；`chat` 能力缺失时抛错；`thinking` 透传；`withConnectionFallback` 在 404 时回退到 `/v1` |
| `test/action-conversation-stream.test.js` | `streamConversationTurn` 的流循环：`stream:data` / `stream:reasoning` 分派；`user-cancelled` 时发带 `cancelled:true` 的 `stream:error`；其他取消原因不发通知；轮次结束调用 `commitTurn`、异常调用 `rollbackTurn`。用注入的假 `createStream` 与假 `queueMessage` 驱动，不启动 Electron |

### 12.2 必须同步修改

| 文件 | 改动 |
|---|---|
| `scripts/probe-action-security.js` | 注册 `chat:ask` 并记录 `chatAsks`；`action:start` 载荷补 `followUp`；DOM 选择器 `#result` → `#transcript`；扩展探针：在首轮 `stream:done` 后调用 `window.actionAPI.askQuestion(7, '追问')`，主进程回 `chat:turn` + 含 `<img onerror>` 与 `javascript:` 链接的 `stream:data`，断言**追问轮同样被净化** |
| `test/action-security-runtime.test.js` | `actionKeys` 期望加入 `askQuestion`、`onChatTurn`；`streamSignals` 期望变为「两次 finish」（首轮与追问轮各一次）；新增追问轮的净化与链接安全断言；建议补 `secureIpcMain.assertComplete()` 调用以锁死通道完整性 |
| `test/toolbar-utils.test.js` | 默认尺寸 520 → 560（`:28`）；高度钳制 300 → 340（`:116-119`） |

### 12.3 不建议新增的类型

按 `docs/plans/2026-09-10-mainjs-assert-inventory.md` 第 4 节的规则，**不得**为本次功能新增 `assert.match(main, …)` 形式的 `main.js` 源码文本断言。行为断言一律落在 `action-conversation.js` 的纯函数/状态机与 `streamConversationTurn` 的注入式测试上。唯一例外是通道存在性类的 `doesNotMatch`（例如断言 action 面不存在 `chat:reset` 之类的越权通道），如确有必要再单独评估。

### 12.4 验收命令

1. `npm test` —— 全量单测，既有 **515 项**不回归（2026-09-26 实测基线：515 通过 / 0 失败），新增用例通过
2. `npm run check` —— 语法检查 + `check-architecture`（关键：`main.js` 行数必须 ≤ 2100）
3. `npm run test:coverage` —— 三级覆盖率门禁；`action-conversation.js` 落入 `main/services/**` 的 85% 聚合桶
4. 手工验收（真机，遵循工作区约定：可见测试窗口置于副屏）：
   - 划词翻译 → 追问「第二段的时态」→ 得到上下文正确的回答
   - 划词解释 → 追问 3 轮 → 每轮思考块与内容正确
   - 自定义动作 → 追问 → 原始自定义指令作为背景生效
   - 仅翻译模型（如 `hunyuan-mt`）→ 输入区禁用 + 提示正确
   - 追问中点击「停止」→ 灰色「已停止生成」，可继续追问
   - 追问中点击别处使窗口隐藏 → 重新唤起后记录完整、输入区可用
   - 连续追问至第 10 轮 → 输入区禁用并提示
   - 追问过程中重新划词 → 窗口内容被新的首轮替换（D4 覆盖丢弃）

---

## 13. 分阶段实施

### 第一版：多轮可用（本次交付范围）

- `main/services/action-conversation.js` 新增（常量 + 纯函数 + 状态机 + 流循环）
- `ai/client.js` 新增 `createFollowUpStream`
- `ipc-security.js` 声明 `chat:ask`
- `main.js` 装配（建会话、载荷扩展、`chat:ask` 处理器、窗口关闭清理）
- `preload-action.js` 新增 `askQuestion` / `onChatTurn`，`onStreamError` 增加 `cancelled` / `rejected`
- `action/` 三件套改造（会话状态、多轮渲染、输入区、停止、失焦恢复）
- 窗口最小高度/默认高度调整
- 测试与探针同步更新

### 第二版：可控与可复制

- `selectionToolbar.conversation = { enabled: true, maxFollowUpTurns: 10 }`，在 `toolbar-utils.js normalizeSelectionToolbar` 中归一化（新增 `CONVERSATION_TURN_LIMITS`），在 `settings-validation.js` 放行，在 `config/config.js:699 renderSelectionToolbar` 的「内置功能设置」区块加开关与轮数选择
- 输入区显示上下文裁剪提示
- 「复制整段对话」按钮
- `resolveFollowUpSupport` 在 `conversation.enabled === false` 时直接返回禁用

### 第三版：更深的追问能力

- 选中首轮结果片段 → 「针对这段追问」，作为引用块进入追问消息
- 会话持久化（复用 `history-service` 的存储习惯，注意隐私面与清理策略）
- 追问轮内的「重新生成」

---

## 14. 风险与回滚

| 风险 | 评估 | 缓解 |
|---|---|---|
| 会话系统提示词替换导致追问质量不如首轮 | 中 | 提示词显式说明「此前执行了 X 操作、你已回答」，并保留自定义动作的原始指令；真机验收覆盖三种动作 |
| 上下文膨胀导致成本/延迟上升 | 中 | 轮数上限 10 + 字符预算 24000 双闸门；锚点不可裁剪但受 10000 字符划词闸门约束 |
| `main.js` 行数超限导致 `check` 失败 | 中 | 状态机与流循环全部外置，净增约 34 行；CI 的 `check-architecture` 就是门禁 |
| 新增 IPC 通道遗漏注册导致启动抛错 | 高（但易发现） | `assertComplete()` 在启动路径上，漏注册立刻崩；探针测试同步补 `assertComplete()` |
| 安全探针断言过期导致测试红 | 高（必然发生） | 已列入 12.2，与实现同批次修改；探针扩展同时提升了对追问轮的净化覆盖 |
| 失焦隐藏打断追问，用户误以为功能坏了 | 中 | 渲染层 `visibilitychange` 自愈 + 「窗口已隐藏，生成已中断」注释；首轮行为保持不变 |
| 追问期间划词被静默丢弃，用户困惑 | 低-中 | 沿用既有行为，不做抢占；列入真机验收观察项，必要时在第二版评估抢占 |

**回滚**：本次改动是**纯增量**——`chat:ask` / `chat:turn` 为新通道，`action:start` 的 `followUp` 为新增字段，`stream:error` 的 `cancelled`/`rejected` 为新增可选字段，旧渲染层遇到这些字段会被忽略。因此回滚只需把 `action/` 三件套与 `preload-action.js` 还原，并移除 `main.js` 的会话装配；服务模块可保留（无引用即无副作用）。唯一需要一并回滚的是窗口尺寸常量，因为它改变了用户可见的默认值。

---

## 15. 附录

### 15.1 新增 IPC 通道契约

| 通道 | 方向 | 载荷 | 注册点 |
|---|---|---|---|
| `chat:ask` | 渲染 → 主（`on`） | `{ streamId: number, question: string }` | `ipc-security.js` action `listeners` |
| `chat:turn` | 主 → 渲染（send） | `{ streamId: number, question: string }` | 无需注册（仅发送） |

### 15.2 既有通道的载荷扩展

| 通道 | 新增字段 | 兼容性 |
|---|---|---|
| `action:start` | `followUp: { enabled, disabledReason, maxTurns, questionMaxLength }` | 纯新增，旧渲染层忽略 |
| `stream:error` | `cancelled?: true`、`rejected?: true`、`interrupted?: true` | 纯新增可选字段 |

`interrupted` 是实施后补的（见第 16.1 节）：本平台不会因 `BrowserWindow.hide()` 触发
`visibilitychange`，所以窗口隐藏导致的追问中断必须由服务层显式通知渲染层。

### 15.3 新增/修改文件清单

| 文件 | 类型 |
|---|---|
| `main/services/action-conversation.js` | 新增 |
| `test/action-conversation.test.js` | 新增 |
| `test/action-conversation-stream.test.js` | 新增 |
| `main/services/ai/client.js` | 修改（+`createFollowUpStream`） |
| `main/services/ipc-security.js` | 修改（+`chat:ask`） |
| `main.js` | 修改（装配，净增约 34 行） |
| `preload-action.js` | 修改（+`askQuestion` / `onChatTurn` / `onStreamError` 扩展） |
| `action/action.js` | 修改（会话状态、多轮渲染、输入区） |
| `action/action.html` | 修改（`#result` → `#transcript`，新增 composer） |
| `action/action.css` | 修改（transcript / composer 样式） |
| `toolbar/toolbar-utils.js` | 修改（最小高度 300→340、默认高度 520→560） |
| `scripts/probe-action-security.js` | 修改（探针扩展） |
| `test/action-security-runtime.test.js` | 修改（期望更新） |
| `test/ai-client.test.js` | 修改（扩展） |
| `test/toolbar-utils.test.js` | 修改（尺寸断言） |

---

## 16. 实施后记（2026-09-26 真机验证后补录）

第一版按本文档实施完毕后做了真机验证，验收项 8/8 通过，同时发现本文档的两个方案在实机上不成立，
已就地修正。完整证据见 `docs/plans/2026-09-26-selection-toolbar-conversation-verification.md`。

### 16.1 §4.6 / §8.6 的渲染层自愈不成立

Electron 在 `BrowserWindow.hide()` 时**不会**把页面标为 hidden：隐藏后
`document.hidden === false`、`visibilityState === "visible"`，`visibilitychange` 从不触发。
因此「其他取消原因不发通知 + 渲染层 visibilitychange 自愈」的组合会让被隐藏打断的追问轮
卡在「生成中」满 30 秒超时，并显示误导性的「请求超时，请检查网络后重试」。

**修正**：`streamConversationTurn` 在 `cancelReason === 'window-hidden'` 时补发
`stream:error { error:'窗口已隐藏，生成已中断', cancelled:true, interrupted:true }`；
`window-closed` / `game-mode` 仍静默。**首轮 `streamToWindow` 完全不改**，§4.6 关于
「不改动首轮收尾方式」的顾虑仍然成立。§15.2 的 `stream:error` 新增可选字段因此再加一个
`interrupted?: true`。

### 16.2 长会话会顶掉底部输入区（本文档未覆盖的 CSS 高度链）

`action.css` 的 `body { min-height: 100vh }` 使列容器高度为 auto，长对话时 `.content`
不再内部滚动，整个文档变高成为滚动容器：实测 `documentElement.scrollHeight=1267` /
`clientHeight=479`、header top = -717，**底部输入区被推到视口外**，多轮追问的核心交互不可达。

**修正**：`body` 改为 `height: 100vh; overflow: hidden`，`.content` 改为
`flex: 1 1 0; min-height: 0`。§9.1 的 `.composer { flex-shrink: 0 }` 只有在这一前提下
才是一个真正贴底的输入区。已补 `test/selection-toolbar-theme.test.js`
「pins the header and composer around a scrolling transcript」回归断言。

### 16.3 首轮中断也由服务层上报（「首轮行为不变」已放宽）

§16.1 的修正最初只覆盖追问路径，首轮 `streamToWindow` 仍保持静默，于是首轮被隐藏打断同样要等满
30 秒并显示「请求超时」。经确认放宽本文档「首轮行为保持不变」的约束后，取消上报收敛成共享函数
`reportCancelledTurn`（`action-conversation.js`），两轮走同一条路径：

- `window-hidden` → `stream:error { error:'窗口已隐藏，生成已中断', cancelled:true, interrupted:true }`
- `user-cancelled` → `stream:error { error:'已停止生成', cancelled:true }`
- `window-closed` / `game-mode` / 空闲超时 → 静默。前两者窗口即将销毁；空闲超时已由
  `controller.cancel(reason, { notify: true })` 自己发过 `stream:error`，重复发会让界面出现两条错误。

§4.6「取消时按原因分流、其他原因不发通知」因此不再成立：分流规则对两轮一致。

### 16.4 隐藏后的会话补上了唤起入口（托盘菜单项）

§10.4 假设「重新唤起窗口 → 对话记录完整保留」可用，但没有指明入口。实际上未置顶的动作窗口失焦即
`hide()`，而唯一能再次显示它的路径是新的划词动作，那条路会重置会话（D4）——被隐藏的会话在界面上
**根本不可达**。补法：

- `SelectionWindowManager` 新增 `getActionWindow()` / `showActionWindow()`，只显示既有窗口、**不新建**；
- 托盘菜单新增「显示划词对话」：仅在有活跃会话时 `visible`，游戏模式下 `enabled: false`
  （与其余召唤类项一致）；
- 托盘菜单在动作窗口 blur / close 时重建（`createTrayIcon()`）。Electron 的菜单是快照，
  不重建的话该项可见性会一直停在启动时的状态，功能等于不存在。

### 16.5 遗留

- `main.js` 现为 2098 行，距 `MAX_MAIN_LINES = 2100` 只剩 **2 行**。下一次需要改动 `main.js` 的功能
  应当先按 `docs/plans/2026-09-10-v2.3-architecture-roadmap.md` 迁出一个域，而不是上调上限。
