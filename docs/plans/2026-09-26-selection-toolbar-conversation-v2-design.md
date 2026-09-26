# 设计文档：划词追问第二版（可控与可复制）

- 日期：2026-09-26
- 基线：`feature/selection-toolbar-conversation` @ `84f8e30`（第一版 + 第 4/5 步修复 + 打包件验证均已提交）
- 第一版设计：`docs/plans/2026-09-26-selection-toolbar-conversation-design.md`（下称"v1 文档"）
- 真机验证：`docs/plans/2026-09-26-selection-toolbar-conversation-verification.md`（开发模式）、
  `docs/plans/2026-09-26-selection-toolbar-conversation-packaged-verification.md`（打包件）
- 状态：**设计定稿，待实施**（第 1 节决策点需确认）
- 范围：只做 v1 文档 §13「第二版」的三项 —— 设置开关与轮数上限、上下文裁剪提示、复制整段对话，
  外加一项**前置重构**（IPC 注册抽取），因为它决定这一版能否通过 `main.js` 行数门禁

---

## 1. 需求与已确认决策

### 1.1 需求

第一版把追问做通了，但有两处不可控、一处不可带走：

1. **不可控**：轮数上限（10）与上下文预算（24000 字符）是模块内常量，用户无法调整；追问能力也无法关闭。
2. **不透明**：上下文被裁剪时界面没有任何提示，用户不知道模型"看不见"早期轮次了。
3. **不可带走**：一段有价值的问答无法整段复制出去。

### 1.2 决策点（✅ = 本文档已定，待你确认）

| # | 决策点 | 结论 | 理由 |
|---|---|---|---|
| D7 | 设置项形状 | `selectionToolbar.conversation = { enabled: boolean, maxFollowUpTurns: number }` | 与 v1 文档 §13 一致；`translateLanguages` 已是同层的嵌套对象先例 |
| D8 | 轮数档位 | `CONVERSATION_TURN_LIMITS = [3, 5, 10, 20]`，默认 **10** | 3 适合省钱、20 给重度用户；上下文预算仍然兜底，放开轮数不会失控 |
| D9 | 关闭追问的行为 | `conversation.enabled === false` 时**首轮不受影响**，只是输入区禁用 + 固定提示 | 首轮是该功能的全部价值，不能因为"关掉追问"而一起关掉 |
| D10 | 裁剪提示的落点 | 挂在**被裁剪的那一轮**上（轮内独立 notice），不占用输入区提示 | 输入区提示已经被"能力不足/达到上限/发送失败"占用，混在一起会互相覆盖 |
| D11 | 复制用什么通道 | 新增 `chat:copy`（`invoke`，主进程写剪贴板），文本上限 64k 字符 | 渲染进程 sandbox + CSP `default-src 'none'`，走 IPC 是唯一稳妥路径；不新增 CSP 放行 |
| D12 | `main.js` 的写法与抽取 | **行数上限已解除**（2026-09-26），本版按正常写法实现，**不做** `main/ipc/` 抽取；`main.js` 的服务化留给**第四版**（v1 文档 §13） | 解除上限让本版不必再为行数压缩写法或偷做一半重构；代价是"漂移暂时无人拦"，由 v4 重新设立更低上限来收口 |
| D13 | 改设置对已打开会话的影响 | **不追溯**：会话在创建时固化配置，下一个会话生效 | 中途改轮数/开关会让"还能追问几轮"变得不可预测；实现上也不需要额外广播 |

---

## 2. 现状与关键约束

### 2.1 代码事实（本版直接依赖）

| 事实 | 位置 | 含义 |
|---|---|---|
| 设置校验是**模板白名单**：`assertValue(patch, template)` 遇到模板里没有的键直接抛「不支持的设置项：`<path>`」，类型不符抛「类型无效」 | `main/services/settings-validation.js:41,22-39` | 新键**必须先存在于模板**，否则保存即被拒 |
| 校验用的模板就是 `this.defaults`，即 `DEFAULT_SETTINGS` | `main/services/settings-service.js:139` | 校验层不需要改，改默认值即可 |
| 校验模板就是 `DEFAULT_SETTINGS`，而它的 `selectionToolbar` 是 `{ ...DEFAULT_SELECTION_TOOLBAR, order: [...] }` | `main.js:138,148` | **在 `DEFAULT_SELECTION_TOOLBAR` 加字段 = 自动进入校验模板**，无需另改校验层 |
| `normalizeSettings` 会调 `normalizeSelectionToolbar(normalized.selectionToolbar)` | `main.js:366-368` | 归一化只需加在 `toolbar-utils.js` |
| `switchMarkup(value, key, group)` + `bindSwitches()` 只会发 `{ [group]: { [key]: value } }`——**只支持一层**，全文件没有任何 dotted key 先例 | `config/config.js:595-606` | 嵌套的 `conversation.enabled` **不能**用 `switchMarkup`；`data-switch="conversation"` 会发 `{selectionToolbar:{conversation:false}}`，类型不符会被校验拒绝。必须手写 handler |
| 下拉框的既有模式：设 `.value` + `.onchange = () => updateSettings({...}, '<提示>')`，**改即存**，不走保存按钮 | `config/config.js:708-716` | 轮数下拉照抄这个模式 |
| 保存按钮只收集提示词文本框 | `config/config.js:806-816` | 本版不需要动它 |
| action 面已声明：`handles: ['shell:open-external']`、`listeners: [... 'chat:ask']` | `main/services/ipc-security.js` | 加 `chat:copy` 要改这里 |
| `chat:ask` 处理器共 **23 行**，内联在 `main.js:1843-1865` | `main.js` | 抽出后 net **-17 行**（23 行移走，模块注册调用约 6 行） |
| ~~`MAX_MAIN_LINES = 2100`，当前 2098~~ **上限已于 2026-09-26 解除** | `scripts/check-architecture.js`（原 `:11` 的常量与 fail 分支已删，仅保留行数上报） | 本版**不再受行数限制**；但 `check` 输出仍打印行数，第四版会重新设立**更低**的上限 |
| IPC 策略计数被硬编码断言：`policies.size === 107`、`{handle:70, on:37}` | `test/ipc-security.test.js:130-131` | 加 `chat:copy`（handle）→ 108 / `{handle:71, on:37}`，必须同批改 |
| 探针通道锁：断言探针注册了 action 面全部通道（当前 5 个） | `test/action-security-runtime.test.js`「registers every action-surface IPC channel」 | 加 `chat:copy` 后**该测试会红**，提醒探针同步——这是有意设计的护栏 |
| `main/ipc/*.js` 的约定形状是 `register*Ipc({ ipcMain, controller })` | `main/ipc/history-ipc.js` 等，`test/ipc-module-contracts.test.js` 断言通道**顺序** | 新模块照此形状，并纳入该测试 |

### 2.2 第一版留下的可复用件

- `ActionConversation` 已经接受 `maxFollowUpTurns` 参数（默认常量），`followUpConfig()` 已经把 `maxTurns`
  发给渲染层 —— 也就是说**渲染层的轮数上限 UI 已经由配置驱动**，本版只要把值接进去，前端几乎零改动。
- `resolveFollowUpSupport(provider)` 已经返回 `{ canFollowUp, reason }`，`status.disabledReason()` 已经把它
  排进禁用原因链 —— 本版只需多一个入参。
- 渲染层的 `composerState()` 已经能显示任意 `disabledReason` 文本。

### 2.3 `main.js` 行数（本版已解除限制）

`main.js` 当前 **2098 行**。旧的 2100 行上限在 2026-09-26 **被解除**（`scripts/check-architecture.js` 里
的常量与失败分支已删，只保留行数上报），因此本版**不再需要为行数压缩写法**：

| 改动 | 行数（仅供追踪，不再设限） |
|---|---:|
| `openToolbarAiAction` 传 `conversationConfig: toolbarConfig.conversation` | +1 |
| `chat:copy` handler（正常多行写法） | +5 |
| `chat:turn` 载荷追加 `omittedPairs` | 0（同一行） |
| **合计** | **≈ +6 → 约 2104** |

解除的理由与你给的判断一致：真正的问题是文件规模，而**解决它的正确位置是第四版的重构**，
不该让 v2 为它压缩可读性、也不该让 v2 顺带做一半抽取。

**代价要写清楚**：解除期间没有任何机制拦住 `main.js` 继续变大，只有 `check` 输出里的一行数字。
所以第四版的第一件事是把这个数字**重新变成门禁**，并且设得比原来更低。

### 2.4 第二版与第四版的关系

- **第二版（本文档）**：只做三项用户价值（开关与轮数、裁剪提示、复制对话）；`main.js` 按正常写法增约 6 行；
  **不碰结构**。
- **第四版（v1 文档 §13）**：`main.js` 重构 —— 内联 IPC 迁出、划词域抽出、截图域残留清理、启动序列收拢，
  目标 1100–1200 行，并**重新设立上限**（例如 1400）锁住成果。
- 两者互不阻塞：第二版可立即开工；第四版开工时第二版新增的那几行会按同样的方式迁走。

---

## 3. 总体设计

```
┌─ 设置层  toolbar/toolbar-utils.js      + conversation 默认值与归一化（含 CONVERSATION_TURN_LIMITS）
│          main/services/settings-validation.js   无需改动（模板自动继承）
│          config/config.js              划词页新增「追问」开关 + 轮数下拉（手写 handler）
├─ 会话层  main/services/action-conversation.js
│          resolveFollowUpSupport(provider, { conversation })   能力闸门 + 关闭开关
│          beginTurn() 额外回传 { omittedPairs }                裁剪提示的数据来源
│          buildFollowUpMessages() → { messages, omittedPairs }
├─ 装配    main/ipc/action-conversation-ipc.js   ★新增：chat:ask + chat:copy 一并注册
│          main.js                              只留 registerActionConversationIpc(...) 一行调用
├─ 桥      preload-action.js             + copyConversation(text)；onChatTurn 增加 omittedPairs
└─ 渲染层  action/action.js · action.html · action.css
           轮内 notice（裁剪提示）· 输入区「复制对话」按钮
```

数据流（追问 + 裁剪提示）：

```
渲染层 askQuestion(streamId, q)
  → chat:ask
  → conversation.beginTurn(q)        内部算出 messages 与 omittedPairs，随 pending 一起暂存
  → chat:turn { streamId, question, omittedPairs }      ← 渲染层据此开轮并挂「已省略 N 轮」notice
  → streamConversationTurn() → createFollowUpStream(conversation.buildMessages())
  → …stream:data / stream:reasoning / stream:done…
```

数据流（复制）：

```
渲染层 点击「复制对话」→ 拼装纯文本（原文 + 每轮问答，带角色前缀）→ copyConversation(text)
  → chat:copy (invoke)  → 主进程 clipboard.writeText(bounded(text))  → 返回 true/false
```

---

## 4. 设置层

### 4.1 `toolbar/toolbar-utils.js`

```js
const CONVERSATION_TURN_LIMITS = Object.freeze([3, 5, 10, 20])
const DEFAULT_CONVERSATION = Object.freeze({ enabled: true, maxFollowUpTurns: 10 })

function normalizeConversation(value) {
  const config = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const turns = Number(config.maxFollowUpTurns)
  return {
    enabled: config.enabled !== false,
    maxFollowUpTurns: CONVERSATION_TURN_LIMITS.includes(turns) ? turns : DEFAULT_CONVERSATION.maxFollowUpTurns
  }
}

// DEFAULT_SELECTION_TOOLBAR 增加 conversation: DEFAULT_CONVERSATION
// normalizeSelectionToolbar 增加 conversation: normalizeConversation(config.conversation)
```

- `enabled` 用 `!== false`（与 `buttons.*`/`customActions[].enabled` 的既有约定一致）。
- 轮数**只接受枚举档位**，非法值回落到 10；不做区间钳制，避免出现界面上选不到的中间值。
- 导出 `CONVERSATION_TURN_LIMITS`、`DEFAULT_CONVERSATION`、`normalizeConversation`，供设置页渲染下拉框。

> 「新增键进校验模板」这一步**不需要改 `settings-validation.js`**：模板来自
> `DEFAULT_SETTINGS.selectionToolbar = {...DEFAULT_SELECTION_TOOLBAR}`（`main.js:148`）。

### 4.2 设置页（`config/config.js` 的 `renderSelectionToolbarSettings`）

在「内置功能设置」区块加一组：

```
┌ 划词追问 ─────────────────────────────────────────────┐
│ 追问开关   [switch]  「在结果窗口底部显示输入区，可就结果继续提问」
│ 追问轮数   [3 / 5 / 10 / 20]   「单次会话最多追问几轮」
└───────────────────────────────────────────────────────┘
```

- 开关**手写 onclick**（不能用 `switchMarkup`，见 2.1）：
  ```js
  document.getElementById('conversationEnabled').onclick = async () => {
    const value = !document.getElementById('conversationEnabled').classList.contains('on')
    await updateSettings({ selectionToolbar: { conversation: { enabled: value } } }, '追问开关已更新')
    renderSelectionToolbarSettings()
  }
  ```
- 轮数下拉照 2.1 的既有模式：`select.value` 初始化 + `onchange → updateSettings({selectionToolbar:{conversation:{maxFollowUpTurns:Number(value)}}}, '追问轮数已更新')`。
- 轮数下拉在开关关闭时**置灰**（`disabled`），但不隐藏——用户要能看到"关闭时上限仍是 10"。

---

## 5. 会话层与能力闸门（`main/services/action-conversation.js`）

### 5.1 能力闸门加一个入参

```js
function resolveFollowUpSupport(provider, { conversation } = {}) {
  if (conversation?.enabled === false) {
    return { canFollowUp: false, reason: '划词追问已在设置中关闭' }
  }
  …原有检查（provider / enabled / baseUrl / apiKey / model / chat 能力）…
}
```

- 关闭开关排在**最前**：它是用户的显式意图，优先于任何模型能力判断。
- 调用点：`main.js` 的 `openToolbarAiAction` 改为
  `resolveFollowUpSupport(aiRuntime, { conversation: toolbarConfig.conversation })`（同行替换，+0 行）。

### 5.2 轮数来自配置

```js
new ActionConversation({
  …,
  conversationConfig: toolbarConfig.conversation,   // 新增一行（main.js +1）
  support: resolveFollowUpSupport(aiRuntime, { conversation: toolbarConfig.conversation })
})
```

构造函数内：`maxFollowUpTurns = conversationConfig?.maxFollowUpTurns ?? maxFollowUpTurns`。
因为 `normalizeSelectionToolbar` 已经把非法值挡掉，这里不需要二次校验；`followUpConfig()` 的
`maxTurns` 因此自动变成配置值，**渲染层无需任何改动**。

> D13：会话创建时固化，之后改设置不追溯。

---

## 6. 上下文裁剪提示

### 6.1 服务层：把"丢了几对"回传出来

```js
// trimHistory 语义不变；buildFollowUpMessages 改为返回结构体
function buildFollowUpMessages({ conversation, question }) {
  …
  const history = trimHistory(conversation?.history, budget - fixed)
  return {
    messages: [...],
    omittedPairs: (conversation?.history?.length ?? 0) - history.length
  }
}
```

`trimHistory` 的既有契约（预算为非正数时不做裁剪、只丢整对）保持不变，因此
"固定部分本身超预算 → `omittedPairs` 为 0" 这条规则天然成立。

`beginTurn(question)` 里**提前**构建一次并暂存：

```js
beginTurn(question) {
  …
  const built = buildFollowUpMessages({ conversation: this, question: value })
  this.pending = { question: value, content: '', built, omittedPairs: built.omittedPairs }
  return {
    ok: true,
    question: value,
    omittedPairs: built.omittedPairs,
    turnPayload: { streamId: this.streamId, question: value, omittedPairs: built.omittedPairs }
  }
}
buildMessages() { return this.pending.built.messages }
```

为什么提前到 `beginTurn`：`chat:turn` 必须在流开始前发出（渲染层靠它开轮并清空输入框），而
`omittedPairs` 只有构建过 messages 才知道。提前构建一次、`buildMessages()` 复用结果，
既不重复计算，也不必新增通道。

**实施时的改进（与设计稿的差异）**：`chat:turn` 的载荷改为由服务层在 `beginTurn` 里组装成
`turnPayload`，`main.js` 只做 `queueActionMessage(win, 'chat:turn', turn.turnPayload)` 一行转发。
理由是设计稿原本让 `main.js` 用内联对象字面量拼这个载荷，而"新增功能不得为 `main.js` 写源码文本断言"
意味着那行拼接无法被任何测试覆盖；搬进服务层后 `turnPayload` 的形状变成可断言的纯函数输出。

### 6.2 通道与渲染层

- `chat:turn` 载荷增加 `omittedPairs`（纯新增字段，v1 渲染层忽略）：
  `queueActionMessage(win, 'chat:turn', { streamId, question: turn.question, omittedPairs: turn.omittedPairs })`
  —— 在抽出的 IPC 模块里，同一行追加字段。
- `preload-action.js` 的 `onChatTurn` 增加 `omittedPairs: Number.isSafeInteger(data?.omittedPairs) && data.omittedPairs > 0 ? data.omittedPairs : 0`。
- 渲染层：`turn.notice`（与 `turn.note` 分开的字段）→ 独立的 `.turn-notice` 元素挂在助手轮顶部，
  文案「已省略更早的 N 轮对话以控制上下文长度」。用独立字段的原因见 D10：
  轮内 `note` 已经被「已停止生成 / 窗口已隐藏，生成已中断 / 错误: …」占用，覆盖任何一个都是 bug。
- 样式：`.turn-notice` 用 `--muted`，与 `.turn-note` 同字号但**不带** error 变体。

---

## 7. 复制整段对话

### 7.1 通道契约（新增）

| 通道 | 方向 | 载荷 | 注册点 |
|---|---|---|---|
| `chat:copy` | 渲染 → 主（`invoke`） | `text: string`（≤ 65536 字符） | `ipc-security.js` action `handles` |

主进程：

```js
secureIpcMain.handle('chat:copy', (_event, text) => {
  const value = typeof text === 'string' ? text.slice(0, MAX_CONVERSATION_COPY_LENGTH) : ''
  if (!value) return false
  clipboard.writeText(value)
  return true          // 不写日志：内容属于隐私面
})
```

`clipboard` 已在 `main.js` 的 electron 解构里 ✓。

### 7.2 桥与渲染层

- `preload-action.js`：
  ```js
  copyConversation: (text) => {
    if (typeof text !== 'string') return Promise.resolve(false)
    const value = text.slice(0, MAX_CONVERSATION_COPY_LENGTH)   // 65536
    if (!value) return Promise.resolve(false)
    return ipcRenderer.invoke('chat:copy', value)
  }
  ```
  双向钳制（渲染层钳一次、主进程再钳一次），与 `askQuestion` 的既有做法一致。
- 渲染层：输入区右上角一个「复制对话」文本按钮，`turns` 里有内容才启用；
  文本格式（纯文本，便于贴到任何地方）：

  ```
  【划词原文】
  <原文>

  【翻译】
  <首轮回答>

  【追问 1】
  <第 1 轮问题>
  <第 1 轮回答>
  …
  ```
  助手内容取 `turn.content`（**原始文本**，不是净化后的 HTML），问题取用户气泡文本；
  被中断/失败的轮次标注 `（已停止生成）` / `（生成失败）`，不静默混入。
- 复制成功后按钮短暂变「已复制」并复位（不弹 toast——这个窗口没有 toast 体系）。

---

## 8. `chat:copy` 直接注册在 `main.js`（不做抽取）

```js
secureIpcMain.handle('chat:copy', (_event, text) => {
  const value = boundConversationCopyText(text)
  if (!value) return false
  clipboard.writeText(value)
  return true          // 不写日志：复制内容属于隐私面
})
```

- 正常的可读写法（行数上限已解除，不需要单行技巧）。
- 文本钳制抽成纯函数放进 `main/services/action-conversation.js`，**理由是让它能被单测覆盖**：
  `docs/plans/2026-09-10-mainjs-assert-inventory.md` 第 4 节禁止为新增功能写 `main.js` 的源码文本断言，
  所以可测的逻辑不能留在 `main.js` 里。
  ```js
  const MAX_CONVERSATION_COPY_LENGTH = 65536
  function boundConversationCopyText(text) {
    return typeof text === 'string' ? text.slice(0, MAX_CONVERSATION_COPY_LENGTH) : ''
  }
  ```
- 常量与函数名加进 `main.js` 现有那行 destructured require（不新增 require 行）。
- `clipboard` 已在 `main.js` 顶部的 electron 解构里 ✓。

> 本版**不**把 `chat:ask` / `chat:copy` 抽到 `main/ipc/`。那是第四版第一项（v1 文档 §13），
> 届时连同 `chat:ask` 一起迁走，这个 handler 会被整体搬进 `main/ipc/action-conversation-ipc.js`。

---

## 9. 测试计划

### 9.1 新增 / 扩展

| 文件 | 覆盖 |
|---|---|
| `test/toolbar-utils.test.js`（扩展） | `conversation` 默认值；`enabled` 严格布尔（`1`/`'true'` 不算 true）；轮数只接受 3/5/10/20，其余回落 10 |
| `test/settings-validation.test.js`（扩展，若已有则加用例） | 接受 `{selectionToolbar:{conversation:{enabled:false}}}` 与 `{...maxFollowUpTurns:5}`；拒绝 `conversation` 内的未知键、拒绝把布尔写给 `maxFollowUpTurns` |
| `test/action-conversation.test.js`（扩展） | `resolveFollowUpSupport` 在 `conversation.enabled===false` 时返回禁用且原因是"已在设置中关闭"（且**先于**能力判断）；`maxFollowUpTurns` 来自配置；`beginTurn` 回传 `omittedPairs`；裁剪时 `omittedPairs` 等于丢掉的整对数；锚点超预算时 `omittedPairs` 为 0；`boundConversationCopyText` 对非字符串返回空、对超长文本截到 64k |
| `test/ipc-security.test.js` | 计数 107→**108**、`{handle:70,on:37}`→**`{handle:71,on:37}`**（该文件同时校验"声明的通道都真的注册了"，因此 `chat:copy` 漏注册会红） |
| `test/action-security-runtime.test.js` | `actionKeys` 增加 `copyConversation`；探针通道锁列表增加 `chat:copy` |
| `scripts/probe-action-security.js` | 注册 `chat:copy` 并记录 `copiedTexts`；断言渲染层传超长文本时被钳制到 64k；`chat:turn` 载荷带 `omittedPairs` 时渲染层出现轮内 notice |
| `test/selection-toolbar-settings.test.js`（扩展） | 设置页含追问开关与轮数下拉，且**不使用** `switchMarkup` 的 dotted key 写法（防回归） |

### 9.2 必须同步修改

- `main/services/ipc-security.js`：action `handles` 增加 `chat:copy`。
- `docs/plans/2026-09-26-selection-toolbar-conversation-design.md` §15.1/§15.2：补 `chat:copy` 与
  `chat:turn.omittedPairs`。
- v1 文档 §13「第二版」清单：实施后回填状态。

### 9.3 验收命令

1. `npm test`（基线 **536** 通过 / 0 失败）
2. `npm run check`（语法 + 架构门禁。`main.js` 行数上限**已解除**，输出仍打印行数以观察漂移）
3. `npm run test:coverage`（三级门禁；`main/ipc/**` 也在 85% 聚合桶内）
4. 手工验收（真机，可见窗口置副屏）：
   - 设置里关掉追问 → 划词翻译仍正常出结果，输入区禁用并提示「划词追问已在设置中关闭」
   - 轮数改成 3 → 追问 3 轮后输入区禁用并提示「已达到最大追问轮数（3）…」
   - 长文翻译后连续追问到触发裁剪 → 该轮出现「已省略更早的 N 轮对话」notice
   - 点「复制对话」→ 粘贴到记事本，内容含原文 + 每轮问答且顺序正确
   - 改设置后**已打开**的会话不受影响（D13）

---

## 10. 分阶段实施

三个阶段各自可独立发布、独立回滚：

1. **设置与能力闸门（D7–D9、D12、D13）**：`toolbar-utils` 归一化（`CONVERSATION_TURN_LIMITS` +
   `normalizeConversation`）+ `action-conversation` 闸门入参与轮数来源 + `main.js` 传
   `conversationConfig`（+1 行）+ 设置页开关/下拉（**手写 handler**，见 D7 与 §4.2）。
2. **裁剪提示（D10）**：`buildFollowUpMessages` → `{ messages, omittedPairs }`、
   `beginTurn` 提前构建并回传 + `chat:turn` 追加字段（同一行，+0 行）+ 渲染层轮内 notice。
3. **复制整段对话（D11）**：`ipc-security.js` 声明 `chat:copy` + `main.js` handler（+5 行）+
   `boundConversationCopyText` + 桥的 `copyConversation` + 渲染层按钮与文本拼装
   + `test/ipc-security.test.js` 计数同步。

> 每阶段结束跑 §9.3 的三条命令。原来作为"阶段 1"的 IPC 抽取已移到第四版，本版不再有纯搬移阶段。

---

## 11. 风险与回滚

| 风险 | 评估 | 缓解 |
|---|---|---|
| 新设置键漏进模板 → 保存被「不支持的设置项」拒绝 | 中（但立刻可见） | 模板来自 `DEFAULT_SELECTION_TOOLBAR`，加字段即生效；`settings-validation` 用例直接断言可接受 |
| 用 `switchMarkup` 写嵌套开关导致 patch 形状错误 | **高**（易犯且报错信息不直观） | 文档明确禁止 + §9.1 的防回归用例 |
| IPC 计数/探针断言过期导致测试红 | 高（必然发生） | 已列在 §9.2，与实现同批；探针通道锁测试会主动报错 |
| `main.js` 超 2100 导致 `check` 失败 | ~~高~~ **已解除** | 本版不再设行数上限（见 §2.3）；风险转为"漂移无人拦"——缓解：`check` 输出仍打印行数，第四版重新设立**更低**的上限 |
| `main.js` 继续膨胀 | 中（解除上限后的新风险） | 只对**本版新增的这几行**放松；第四版重构的动机会随行数增长而更充分，不要把解除理解为"可以随便塞" |
| 复制文本过大（长会话） | 低 | 双向 64k 钳制；不写日志 |
| 关闭追问后用户以为"划词坏了" | 低-中 | 首轮不受影响；输入区提示写明"已在设置中关闭"并指向设置页 |
| 改设置不追溯造成困惑 | 低 | D13 明示；提示文案用"下一个会话生效"口径 |

**回滚**：四项都是纯增量（新设置键、新通道、新增可选字段）。回滚时先删渲染层入口，再移除
`chat:copy` 声明与注册（否则 `assertComplete()` 在启动路径上会抛），最后移除设置项与归一化。
建议按阶段 4→3→2→1 逆序回滚。

---

## 12. 附录：新增/修改文件清单

| 文件 | 类型 |
|---|---|
| `main/services/action-conversation.js` | 修改（闸门入参、轮数来自配置、`omittedPairs`、`boundConversationCopyText`） |
| `scripts/check-architecture.js` | 修改（**移除** `main.js` 行数上限；行数仍上报） |
| `toolbar/toolbar-utils.js` | 修改（`conversation` 归一化 + `CONVERSATION_TURN_LIMITS`） |
| `config/config.js` | 修改（追问开关 + 轮数下拉） |
| `main/services/ipc-security.js` | 修改（action `handles` +`chat:copy`） |
| `main.js` | 修改（装配 + `chat:copy`，约 **+6 行**，不再设限） |
| `preload-action.js` | 修改（`copyConversation`、`onChatTurn.omittedPairs`） |
| `action/action.js` · `action.html` · `action.css` | 修改（轮内 notice、复制按钮） |
| `scripts/probe-action-security.js` | 修改（`chat:copy`、`omittedPairs`） |
| `test/*`（见 §9.1） | 修改 + 新增 |
| `docs/plans/2026-09-26-selection-toolbar-conversation-design.md` | 修改（通道契约回填） |
