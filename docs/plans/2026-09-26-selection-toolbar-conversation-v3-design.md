# 设计文档：划词追问第三版（更深的追问能力）

- 日期：2026-09-26
- 基线：`feature/selection-toolbar-conversation` @ `a4cd2ad`（第一版 + 第 4/5 步 + 第二版三阶段）
- 上游文档：`docs/plans/2026-09-26-selection-toolbar-conversation-design.md`（第一版，§13 定义本版范围）、
  `docs/plans/2026-09-26-selection-toolbar-conversation-v2-design.md`（第二版）
- 状态：**设计定稿，待确认决策点**（见 §1.2）
- 范围：v1 文档 §13 的「第三版」三项 —— 选中片段追问、会话持久化、追问轮内「重新生成」

---

## 1. 需求与决策点

### 1.1 需求

| # | 需求 | 现状缺口 |
|---|---|---|
| R1 | 就结果里的**某一段**继续追问 | 只能整轮追问，用户要把片段手动复制进输入框 |
| R2 | 重新生成某轮回答 | 只能重新划词（整段会话丢失），或换个问法再问一次 |
| R3 | 重启应用后仍能回到上一次对话 | 会话只在内存里（v1 的 D5 明确推迟），窗口一关就没了 |

### 1.2 决策点（建议值，待确认）

| # | 决策点 | 建议 | 理由 |
|---|---|---|---|
| D14 | 引用片段以什么形式进入消息 | 在输入框里以 `> 片段` 形式**前置注入**，用户可继续编辑 | 复用现有的唯一入口（问题文本），不新增参数与通道；用户能删改，比隐式携带更可控 |
| D15 | 引用的取用方式 | 选中文本后点输入区旁的**「引用选中片段」按钮** | 不做自动注入/浮动按钮：这个窗口常被快速划词唤起，误触代价高 |
| D16 | 引用长度上限 | 单次引用 **300 字符**（超出截断并在提示里说明） | 与 `MAX_QUESTION_LENGTH`（2000）兼容，且引用挤掉问题本身是本末倒置 |
| D17 | 「重新生成」的作用范围 | **仅最新一轮追问**，语义是**替换**该轮而非追加 | 替换更早的轮次会让它之后的所有回答失去依据；追加则会出现同一个问题两次 |
| D18 | 重新生成是否走新通道 | **不新增**：复用 `chat:ask` 增加可选 `replaceLast` 字段 | 通道面越小越好；`ipc-security` 的策略表、探针、计数断言都不用动 |
| D19 | 会不会把落盘默认打开 | **默认关闭**，`selectionToolbar.conversation.persist` 默认 `false`，用户显式开启 | 划词内容可能是密码、私人邮件、内部材料；v1 的 D5 正是因此推迟落盘。既有先例：`clipboardFallback` 也是 opt-in |
| D20 | 落盘存哪里、留多久 | 独立目录 `<dataRoot>/conversations`，一个会话一份 JSON；**保留最近 20 个**；关闭开关即**删除**已落盘内容 | 与截图历史分开（语义不同：那边是图片、这边是文本），删除路径明确可审计；复用 `atomicWriteJson` |
| D21 | 落盘存哪些内容 | 只存**服务层真相**：锚点（原文+首轮结果）+ 已提交的追问对 | 被停止/失败轮本就"不进上下文"（v1 §4.7），落盘保留它们会与模型实际看到的上下文不一致 |
| D22 | 恢复入口与恢复方式 | 复用第二版的托盘项「显示划词对话」：内存里没有会话时从磁盘恢复最近一次；恢复用**重放既有通道**（`stream:data`/`chat:turn`/`stream:done`）而不是新增「渲染历史会话」契约 | 渲染层无需任何改动就能画出完整会话并允许继续追问；新增契约要多维护一套 |

---

## 2. 现状与关键约束

### 2.1 代码事实（本版直接依赖）

| 事实 | 位置 | 含义 |
|---|---|---|
| 会话状态全在 `ActionConversation`：`action` / `text` / `firstResultContent` / `history` | `main/services/action-conversation.js` | 序列化就是这四样；恢复就是重建它 |
| `beginTurn(question, { replaceLast })` 已有 `turnPayload` 返回形状 | 同上（第二版实现） | 重新生成只需多一个入参 |
| `chat:ask` 载荷 `{ streamId, question }`，处理器内联在 `main.js`，**23 行** | `main.js:1843-1865` | 加一个可选布尔字段不需拆结构（行数上限已解除） |
| `action:start` 由主进程唯一发送，渲染层据此 `resetUI()` 并开首轮 | `action/action.js` | 恢复会话必须走这条或走重放 |
| 截图历史：**索引进 electron-store**（`captureHistory`），**文件落盘**在 `screenshot.historyDirectory`，`trimHistory` 按上限裁剪并删文件 | `main/services/history-service.js:97,244,258` | 这是"存储习惯"的样板；但那是图片，会话是纯文本 |
| `ensureDataLayout(Sync)` 会为 `createDataPaths` 的**每个**非 root 项建目录 | `main/services/data-root.js:29-42` | 新增目录只要加进 `createDataPaths` 就会自动创建 |
| `test/data-root.test.js:112` 断言 `createDataPaths` 的**完整返回对象** | 同上 | 新增一项**必须同步改测试**（这是有意的布局契约） |
| `atomicWriteJson(filePath, value)` 现成可用 | `main/services/data-root.js:44` | 会话文件写入直接复用，不另造原子写 |
| 历史目录的孤儿清扫只处理 `entry.isFile()` 且文件名匹配截图/缩略图模式 | `main/services/history-service.js:49-52,183-205` | 即使把会话放在历史目录下也不会被误删；但仍建议独立目录（语义清晰） |
| 托盘项「显示划词对话」在**有会话时**才 `visible`，点击调用 `showActionWindow()` | 第二版实现，`main/services/tray-menu.js` | 恢复入口要挂在这里，并放宽"有会话"的判定 |
| 渲染层已被设计为「流式增量的最终形态」：`stream:done` 只做收尾 | `action/action.js` | 重放 `stream:data`+`stream:done` 会得到与真实流式完全一致的界面 |
| `MAX_QUESTION_LENGTH = 2000` 在服务层与桥双向钳制 | `main/services/action-conversation.js` / `preload-action.js` | 引用块必须给问题留出空间（故 D16 定 300） |

### 2.2 硬约束

- **隐私面**：落盘内容会留在磁盘上。默认关闭 + 明确删除路径（D19/D20）是这一版能被接受的前提；
  并且**不写日志**（沿用第二版复制功能的做法）。
- **不加通道**：本版的目标是"在既有骨架上加深能力"，除可选字段外不新增 IPC；`ipc-security.js` 的
  策略计数断言（108 / `{handle:71, on:37}`）**应当保持不变**——如果它变了，说明设计跑偏了。
- **不加渲染层新契约**：恢复走重放（D22），引用是纯渲染层行为（D14/D15）。

---

## 3. 总体设计

```
┌─ 渲染层  action/action.js · action.html · action.css
│    ① 选中片段 → 输入框注入 `> 片段`（纯前端，无通道）
│    ② 「重新生成」按钮 → retryLastTurn(streamId, question)
│    ③ 「引用选中片段」按钮（与复制按钮同排）
├─ 桥      preload-action.js     askQuestion(streamId, question, replaceLast?)
│         conversation-text.js   不变（复制功能）
├─ 装配    main.js                chat:ask 多一个字段；托盘项接入恢复；
│                                启动时按设置裁剪一次落盘内容
├─ 会话    main/services/action-conversation.js
│          beginTurn(question, { replaceLast })   ← 替换最新一轮
│          serialize() / static fromSnapshot()    ← 落盘与恢复
└─ 持久化  main/services/conversation-store.js   ★新增
           保存（上限 20）· 读取最近一次 · 清空 · 裁剪
           存储：<dataRoot>/conversations/<id>.json（atomicWriteJson）
```

**数据流（重新生成）**

```
点击「重新生成」→ askQuestion(7, '同一问题', true)
  → chat:ask { streamId: 7, question, replaceLast: true }
  → conversation.beginTurn(q, { replaceLast: true })
       校验：最后一轮的 question 必须与本问题一致，否则拒绝（不误删别人的轮次）
       先 pop 掉旧轮 → 再做轮数上限检查（所以达到上限时仍可重新生成）
  → 渲染层收到 chat:turn 时先移除旧的「用户气泡 + 助手轮」，再按正常流程落新的
```

**数据流（恢复）**

```
托盘「显示划词对话」
  → 内存里没有会话？读磁盘最近一次 → 重建 ActionConversation（按当前设置为该 action 重解析供应商）
  → 发 action:start（带 followUp 能力）→ 开窗
  → 重放：首轮 stream:data + stream:done；每条追问 chat:turn + stream:data + stream:done
  → 界面得到完整会话，输入区可用，可继续追问
```

---

## 4. 追问轮内「重新生成」

### 4.1 服务层

```js
beginTurn(question, { replaceLast = false } = {}) {
  const value = …（原空值检查）
  const last = this.history.at(-1)
  if (replaceLast) {
    // 替换更早的轮次会让它之后的回答全部失去依据，所以只允许最新一轮。
    if (!last || last.question !== value) {
      return { ok: false, reason: '只能重新生成最近一轮追问', rejected: true }
    }
    this.history.pop()
  }
  const reason = this.disabledReason()          // 此时按"替换后"的轮数判断
  if (reason) {
    if (replaceLast) this.history.push(last)    // 拒绝时不留下副作用
    return { ok: false, reason, rejected: true }
  }
  …（原构建与返回）
}
```

要点：

- **先弹再判上限**：达到 `maxFollowUpTurns` 时，重新生成应当仍然允许（它释放了自己的名额）。
- **拒绝不留副作用**：所有校验失败都恢复到调用前的 history。
- **问题必须一致**：渲染层总是带着那一轮的原问题来；不一致说明请求与状态错位，宁可拒绝。
- `DISABLED_REASONS` 增加 `retryNotNewest`，保持禁用原因集中在一处。

### 4.2 桥与装配

- `preload-action.js`：`askQuestion(streamId, question, replaceLast = false)` →
  `ipcRenderer.send('chat:ask', { streamId, question: value, replaceLast: replaceLast === true })`。
- `main.js`：`conversation.beginTurn(payload?.question, { replaceLast: payload?.replaceLast === true })`（同行修改）。

### 4.3 渲染层

- 输入区提示行现在是 `[重新生成] [复制对话]`，两个都是小文本按钮。
- 「重新生成」的可用条件：**最新一条助手轮是追问轮**（即 `followUpCount() > 0`）、该轮已结束、
  且当前没有在飞的轮次。首轮不提供（重新生成首轮 = 重新划词，与 v2 的"新划词覆盖"重复）。
- 点击后：记住"下一次 `chat:turn` 要替换最后一对"，把该轮的问题填回输入框、置为 pending，
  再发请求。**收到 `chat:turn` 才真正移除旧的一对**——这样被拒绝（`rejected`）时旧回答仍在界面上，
  不会出现"点了重新生成，回答却没了"。
- 移除时只需弹出 `turns` 末尾的用户轮与助手轮并删掉对应 DOM 节点（重新生成只作用于最新一轮，
  不存在下标位移问题）。

---

## 5. 选中片段追问

### 5.1 交互

1. 用户在**助手回答区**（`.answer`）里用鼠标选中一段文字。
2. 输入区旁的「引用选中片段」按钮变为可用（监听 `selectionchange`）。
3. 点击后把选中文本以引用块形式插入输入框**开头**：

```
> 旧系统逐句翻译，因此常常丢失句子之间的语篇连贯性。

<光标在此>
```

4. 用户接着写自己的问题，回车发送。

### 5.2 规则

- **只接受落在 `#transcript` 内的选区**：选中原文（`.source`）没有意义，选中别处可能是误触。
- **长度上限 300 字符**（D16）：超出截断，并在输入区提示「引用已截断到 300 字」。
- 插入时若输入框已有内容，**不覆盖**：把引用插到最前，已有内容顺延到光标之后。
- 引用块是**普通文本**，用户可自由编辑或删除；不做任何特殊解析——服务层与模型只看到一段
  以 `> ` 开头的用户消息，符合"作为引用块进入追问消息"的语义。
- 已有的选区在点击后清除（`window.getSelection().removeAllRanges()`），避免重复引用。
- 按钮与「复制对话」同为小文本按钮，选中态才点亮；无选中时禁用。

### 5.3 为什么不用浮动工具条

浮动按钮需要跟随选区定位、处理滚动与窗口缩放、还要和工具栏窗口抢焦点；而这个窗口本身就是
"划词唤起"的产物，误触成本高。固定按钮 + 显式点击是最省事且最不容易误操作的形式。

---

## 6. 会话持久化

### 6.1 存储

```
<dataRoot>/conversations/<id>.json      # id = `${savedAt}-${random}`
{
  "schemaVersion": 1,
  "savedAt": 1790000000000,
  "actionId": "translate",              # custom:* 也在这里，恢复时按它重解析供应商
  "actionLabel": "翻译",
  "source": "<划词原文>",
  "firstResult": "<首轮结果>",
  "history": [{ "question": "…", "answer": "…" }]
}
```

- 独立目录（D20）：`createDataPaths` 新增 `conversations`（`ensureDataLayout` 自动创建；
  `test/data-root.test.js` 的 `expectedDataPaths` 同步加一行）。
- 写入复用 `atomicWriteJson`（`main/services/data-root.js:44`），不另造原子写。
- **不写日志**：会话内容不进 app.log。

### 6.2 新服务 `main/services/conversation-store.js`

```js
class ConversationStore {
  constructor({ directory, getSettings, maxEntries = 20, log = () => {} })
  isEnabled()                       // selectionToolbar.conversation.persist === true
  save(snapshot)                    // 原子写 + 裁剪到 maxEntries
  latest()                          // 读最近一次（按 savedAt）
  clear()                           // 删除目录下所有会话文件（关闭开关时调用）
  trim()                            // 启动时/写入后按 maxEntries 删除最旧的
}
```

- 依赖注入目录与设置读取，**不直接依赖 Electron**（可 `node:test` 直接覆盖，沿用
  `action-conversation.js` 的可测性做法）。
- 只处理 `*.json`，忽略其它文件；删除只删自己写出的文件（命名受控）。

### 6.3 生命周期

| 时机 | 行为 |
|---|---|
| 每轮**成功**提交后（`stream:done` 且 `commitTurn`） | 若开关开启则 `save()`；失败/取消轮不落盘 |
| 应用启动（`initializeStore` 之后） | 若开关开启 → `trim()`；若关闭 → `clear()`（D20：关闭即删除） |
| 设置里把开关从开改到关 | 立刻 `clear()`，并 toast「已删除本地保存的划词对话」 |
| 会话窗口关闭 | **不删**（这正是要持久化的目的） |
| 托盘「显示划词对话」 | 内存无会话时 `latest()` 恢复（D22） |

### 6.4 恢复的实现

`main.js` 里一个新的私有函数（约 20 行）：

```js
function restoreLastConversation(win) {
  const snapshot = conversationStore.latest()
  if (!snapshot) return false
  const settings = getSettings()
  const actionDefinition = getToolbarActionDefinition(settings.selectionToolbar, snapshot.actionId)
  const aiRuntime = resolveToolbarAiProvider(settings, snapshot.actionId)
  if (!actionDefinition || !aiRuntime?.apiKey) return false
  const conversation = new ActionConversation({ …同 openToolbarAiAction，但用快照的 text/firstResult/history… })
  actionConversations.set(win, conversation)
  queueActionMessage(win, 'action:start', { …type/label/icon/text/streamId, followUp: conversation.followUpConfig() })
  replayConversation(win, snapshot)     // 重放既有通道
  return true
}
```

`replayConversation` 用 `queueActionMessage` 依次发 `stream:data`+`stream:done`（首轮）与
`chat:turn`+`stream:data`+`stream:done`（每条追问）。**渲染层零改动**，且恢复后的会话天然处于
"已完成"状态，输入区可用。

### 6.5 明确不保留的东西

- **被停止 / 失败 / 被中断的轮次不落盘**（D21）。重启后这些轮次不再出现，与"它们不进模型上下文"
  的既有取舍一致。界面提示不做特殊说明。
- 会话**不会**自动跨设备同步、不会是"会话列表"：本版只保留最近一次可恢复的会话（上限 20 只是
  为了"回退到上一次之前的那次"这种用法，没有浏览 UI）。

---

## 7. 测试计划

### 7.1 新增 / 扩展

| 文件 | 覆盖 |
|---|---|
| `test/action-conversation.test.js`（扩展） | `replaceLast`：替换成功（history 长度不变、问题被替换）；最后一轮问题不一致时拒绝且**无副作用**；无 history 时拒绝；**达到轮数上限时仍可重新生成**；被拒绝后 `buildMessages` 仍用旧轮 |
| `test/conversation-store.test.js` | **新增**：开关关闭时不写；写入后按上限裁剪（第 21 个把最旧的删掉）；`latest()` 取 savedAt 最大者；`clear()` 只删自己写出的 json；目录不存在时不抛；原子写产物可被 `JSON.parse` |
| `test/settings-validation.test.js`（扩展） | 接受 `{selectionToolbar:{conversation:{persist:true}}}`；拒绝字符串 |
| `test/toolbar-utils.test.js`（扩展） | `persist` 默认 `false`、严格布尔 |
| `test/data-root.test.js`（同步） | `expectedDataPaths` 增加 `conversations` |
| `test/conversation-text.test.js`（扩展） | 引用块（`> ` 前缀）在复制文本里保持原样 |

### 7.2 必须同步修改

- `main.js`：`beginTurn` 传 `replaceLast`；启动时的 trim/clear；托盘项接入恢复。
- `toolbar/toolbar-utils.js`：`DEFAULT_CONVERSATION` 增加 `persist: false` + 归一化。
- `config/config.js`：划词追问区块增加「保存对话到本地」开关（**关闭时即时提交并触发删除**）。
- `preload-action.js`：`askQuestion` 增加可选 `replaceLast`。
- `action/action.js` · `action.html` · `action.css`：两个按钮与引用交互。
- `test/action-security-runtime.test.js`：`chat:ask` 载荷断言加入 `replaceLast`（探针里顺带覆盖一次 `replaceLast: true`）。
- **不变**：`ipc-security.js` 的通道表与 `test/ipc-security.test.js` 的计数（108 / `{handle:71,on:37}`）
  —— 这是本版的自我约束：若它们变了，说明违背了"不加通道"的设计。

### 7.3 验收命令

1. `npm test`（基线 **546** 通过 / 0 失败）
2. `npm run check`（行数只上报不拦截）
3. `npm run test:coverage`（`conversation-store.js` 落入 85% 聚合桶）
4. 真机（沿用二版的三个一次性脚本模式，新增第四个）：
   - 追问一轮 → 点「重新生成」→ 旧回答被替换、问题不变、上下文仍正确
   - 在第 10 轮上限时点「重新生成」→ 成功（上限不阻拦替换）
   - 选中回答里的片段 → 点「引用选中片段」→ 输入框出现 `> 片段` → 追问得到针对该片段的回答
   - 选中超长文本 → 引用被截断到 300 字且提示正确
   - 开启「保存对话到本地」→ 追问一轮 → `conversations/` 出现文件 → **重启应用** → 托盘「显示划词对话」
     恢复出完整会话且可继续追问
   - 关闭开关 → 目录被清空

---

## 8. 分阶段实施

| 阶段 | 内容 | 可独立发布 |
|---|---|---|
| 1 | **重新生成**（服务 `replaceLast` + 桥可选参数 + 渲染层按钮） | ✅ |
| 2 | **选中片段追问**（纯渲染层） | ✅ |
| 3 | **持久化**（`conversation-store.js` + 设置开关 + 启动裁剪 + 托盘恢复） | ✅ |

阶段 3 依赖前两个阶段的成果（恢复出来的会话要能继续追问、能重新生成），所以放最后。

---

## 9. 风险与回滚

| 风险 | 评估 | 缓解 |
|---|---|---|
| 落盘内容泄露隐私 | **高**（这是本版唯一的真风险） | 默认关闭；关闭即删除；不写日志；独立目录便于审计与手工删除；文案明确写"会保存到本地" |
| 恢复出的会话与关闭前的界面不一致（少了被停止/失败的轮次） | 中 | D21 明示取舍；恢复文案不做承诺 |
| 恢复时模型已更换/供应商被删 | 中 | 恢复前重解析供应商，失败就**不恢复**并在托盘提示，而不是抛错 |
| 重放通道被误当成"真的在生成" | 低 | 重放是同步的、无 30s 空闲计时器参与；恢复时不创建 stream controller |
| 「重新生成」误删了不该删的轮次 | 中 | 服务层强制"最后一轮问题必须一致"；界面只在最新追问轮上提供 |
| 引用把问题挤出 2k 上限 | 低 | 引用上限 300 + 插入时提示截断 |
| 关闭开关时正在生成的轮次之后又落盘 | 低 | `save()` 每次读取当前设置；关闭动作先 `clear()` |

**回滚**：三项都是纯增量（`conversation` 设置多一个 `persist` 字段、`chat:ask` 多一个可选字段、
渲染层多两个按钮、一个新服务 + 一个目录）。回滚阶段 3 时注意：**先删启动时的 trim/clear 调用，
再删服务引用**，否则残留的目录不会被任何代码管理。删除目录本身即可清除用户数据。

---

## 10. 附录：新增/修改文件清单

| 文件 | 类型 |
|---|---|
| `main/services/conversation-store.js` | **新增** |
| `main/services/action-conversation.js` | 修改（`replaceLast`、`serialize`/恢复所需字段） |
| `main/services/data-root.js` | 修改（`createDataPaths` 增加 `conversations`） |
| `toolbar/toolbar-utils.js` | 修改（`conversation.persist` 默认值与归一化） |
| `main.js` | 修改（`replaceLast` 透传、启动 trim/clear、托盘恢复、重放） |
| `preload-action.js` | 修改（`askQuestion` 可选 `replaceLast`） |
| `config/config.js` | 修改（「保存对话到本地」开关） |
| `action/action.js` · `action.html` · `action.css` | 修改（重新生成、引用按钮与交互） |
| `test/conversation-store.test.js` | **新增** |
| `test/action-conversation.test.js` · `test/toolbar-utils.test.js` · `test/data-root.test.js` · `test/conversation-text.test.js` · `test/action-security-runtime.test.js` | 修改 |
| `scripts/probe-action-security.js` | 修改（`chat:ask` 带 `replaceLast` 的载荷断言） |

---

## 11. 实施后记（2026-09-26 三阶段完成）

| 阶段 | 提交 | 门禁 |
|---|---|---|
| 1 追问轮内「重新生成」 | `04f7a60` | 547 通过 / 0 失败；三级覆盖率门禁通过 |
| 2 选中片段追问 | `f000e89` | 548 通过 / 0 失败；同上 |
| 3 会话持久化 | `ac2234c` | 556 通过 / 0 失败；同上 |

`main.js` 从 2105 涨到 **2173 行**（上限已解除，只上报）。这一版为持久化加进来的装配（存储实例、保存钩子、
托盘恢复 + 重放）约 70 行，正是第四版要迁走的那类代码。

### 11.1 真机验证（开发模式，真实模型）

| 脚本 | 结果 | 关键证据 |
|---|---|---|
| `.tmp/verify-v3-retry.js` | **11/11** | 首轮没有「重新生成」；追问后可用；点击后仍是 1 问 2 答（**替换**而非追加）、问题不变、回答是重新生成的新内容；换问题的“重新生成”被服务端拒绝并显示「只能重新生成最近一轮追问」，**旧回答仍在** |
| `.tmp/verify-v3-quote.js` | **10/10** | 选中原文不激活按钮、选中回答片段才激活；引用以 `> 片段` 进入输入框且光标在末尾；追问消息里确实带着引用块；355 字被截断到 300 并提示 |
| `.tmp/verify-v3-persist.js` | **12/12** | 默认关闭时不写文件；经真实 IPC 开启后，真实对话落盘且**一次对话只有一份文件**、含锚点与已提交追问对；关闭开关**立刻删除**；重放一份快照后界面得到完整会话（2 问 3 答、输入区/重新生成/复制都可用）——这一段**不需要任何模型调用** |

截图：[01-regenerated.png](F:/workspace/Highlighter/test-results/realdevice-v3/01-regenerated.png) ·
[02-quoted-fragment.png](F:/workspace/Highlighter/test-results/realdevice-v3/02-quoted-fragment.png) ·
[03-restored-conversation.png](F:/workspace/Highlighter/test-results/realdevice-v3/03-restored-conversation.png)

### 11.2 与设计稿的差异（都是实施中改好的）

1. **会话有稳定身份**（`conversationId`，UUID）。设计说「一会话一份 JSON」，但第一版实现是按"每次保存"
   落一份文件——一轮一存就变成一次对话多份版本，`maxEntries = 20` 实际只装得下两次对话。
   现在文件名用会话 id，每轮**改写**同一份；`restoreFrom` 也会沿用快照里的 id，所以恢复后继续追问
   仍然写回同一份文件。
2. **恢复的组装抽成 `prepareRestoredConversation`**（纯函数，可断言）。与第二版把 `turnPayload`
   移进服务层同理：`main.js` 里那 20 行装配无法被任何测试覆盖，抽出来之后"没有 action/provider 时返回
   null""重放顺序"都成了单测用例。
3. **`保存对话到本地` 的开关联动**落在 `main/domains/settings-effects`：关闭开关要**删除**已落盘内容、
   开启要立刻裁剪，这是主进程的活，不是设置页能做的；而本版禁止新增通道，所以走既有的设置副作用机制。
4. **新增受管目录不是"改一行"**：`createDataPaths` 加了 `conversations` 之后，数据根迁移的
   `MANAGED_DIRECTORIES` 回滚清单也必须加上，否则一次失败的数据根迁移会把该目录留在目标根里
   （`data-root-migration.test.js` 的"回滚后目标为空"断言正是这样失败的）。这条值得记进 v4 的清单：
   **新增一个受管目录 = 数据根 + 迁移 + 三个测试**。

### 11.3 遗留

- **托盘点击本身仍未验证**：恢复的触发点是托盘项「显示划词对话」，而这个 CUA 构建枚举不到、也截不了
  系统通知区域（v2 第 5 步就卡在这里）。已覆盖的部分：存储读写/裁剪/删除（单测 + 真机文件）、
  恢复组装与重放顺序（单测）、重放后的界面（真机 DOM）。未覆盖的只有"点托盘 → 调用同一条路径"这一步。
- 被停止/失败的轮次不落盘（D21 明示取舍），重启后不再出现。
- 第 7 步（release 打包线：fuses / `packaged-entry.js` / 签名）仍未做。
