# 真机验证报告：划词结果窗口的多轮对话

- 日期：2026-09-26
- 分支：`feature/selection-toolbar-conversation`
- 设计文档：`docs/plans/2026-09-26-selection-toolbar-conversation-design.md`
- 验证范围：**开发模式（`electron .` + 源码树）**。未构建安装包、未安装、未运行打包件 —— 见第 1、6 节
- 结论：**验收项 8/8 通过，断言 33/33 通过**（最后一轮，含两处修复）；过程中发现并修复 2 个真实缺陷
- 截图目录：`test-results/realdevice/`（已被 `.gitignore` 忽略，仅本地保留）
- 复现脚本：`.tmp/verify-conversation.js`（`node .tmp/verify-conversation.js`），归属说明见第 7 节

---

## 1. 验证方式

## 1. 验证方式

**这是开发模式（源码树）验证，不是打包件验证。** 启动方式是
`electron .`（`package.json.main = main.js`）+ `HIGHLIGHTER_E2E=1`，没有构建 setup/portable 安装包、
没有安装、没有运行 `dist/` 或已安装的 `D:\Program Files\Highlighter`。未覆盖项见第 6 节。

跑的是**真实 Electron 应用**：`main.js` 主进程、`preload-action.js` 桥、`action/` 渲染层、
真实的 `ToolbarStreamSession` / `ActionConversation` / `createFollowUpStream` 链路，
以及**真实的模型供应商**（硅基流动 `deepseek-ai/DeepSeek-V4-Flash`、`tencent/Hunyuan-MT-7B`，
DeepSeek `deepseek-v4-flash`）。

有三处是模拟的：

1. **系统级划词**。原生 selection hook（`SelectionHookService`）在 E2E 模式下本就未启动，被替换为
   向真实工具栏渲染层发送 `selection:text`。之后 `toolbarAPI.action()` → `toolbar:action` →
   `openToolbarAiAction` → 供应商流式 → `chat:ask` → 追问流 全部是生产路径，但
   `handleTextSelection` 的闸门、`calculateToolbarPosition` 与动作窗口的
   `positionActionWindow`（依赖 `lastToolbarPosition`）**未被执行**。
2. **数据目录**。使用真实配置的**临时副本**（`%TEMP%`），避免改动
   `E:\document\highlighter` 下的用户数据。副本里额外补了一份
   `cache/electron/Local State`，否则 Electron 会生成新的 os_crypt 密钥、已加密的
   供应商 API 密钥无法解密（`hasApiKey:false`，动作会被静默改成打开「模型」设置页）。
3. **输入方式**。交互通过渲染层的真实 DOM 事件完成（`input` 事件 + `#btnSend.click()`），与鼠标点击走
   同一批监听器，但不是 OS 级输入；截图用 `webContents.capturePage()` 取窗口内容。

会话上下文没有依赖模型自述，而是直接在主进程钩住 `createToolbarActionStream` /
`createFollowUpStream` 记录**每次请求的完整 messages**，作为「追问确实带上了首轮结果与历史」
的硬证据。

窗口按工作区约定放在副屏（1152×2048 @1.25，主屏 2560×1440 @1.5），尺寸取本变更引入的新默认值
550×560。窗口位置由验证脚本显式摆放，不是应用自身定位的结果。

---

## 2. 验收结果

| # | 验收项 | 结果 | 证据摘要 |
|---|---|---|---|
| S1 | 划词翻译 → 追问「第二段…」→ 上下文正确的回答 | ✅ | 首轮译文 94 字；追问回复「第二段说的是：旧系统虽然能保证语法正确，但常常忽略句子之间的语篇连贯性。」；请求 messages = `system,user,assistant,user`，内嵌的原文与首轮结果就是界面上的那两段，首个 chunk 569 ms |
| S2 | 划词解释 → 追问 3 轮 → 思考块与内容正确 | ✅ | 4 轮全部落盘；4 个思考过程块且均有内容；第三轮请求 8 条消息（锚点 + 2 对历史 + 当前问题） |
| S3 | 自定义动作 → 追问 → 原始指令生效 | ✅ | 系统提示词含「你是术语编辑」与「【原始任务的指令】」；追问「把第一个术语换成更通俗的说法」得到该术语的通俗改写 |
| S4 | 仅翻译模型 → 输入区禁用 + 提示正确 | ✅ | `hunyuan-mt` 首轮翻译成功（18 chunks，280 ms）；输入区禁用，提示「当前模型仅支持翻译，无法追问。请在「模型」设置中为划词功能选择一个支持对话的模型」 |
| S5 | 追问中点「停止」→ 灰色「已停止生成」，可继续追问 | ✅ | 该轮标注「已停止生成」（灰色）；输入区立即恢复可用；该轮模型调用确已发出 |
| S6 | 追问中窗口隐藏 → 重新唤起后记录完整、输入区可用 | ✅ | 窗口 `isVisible()=false`；**2 秒**内标为中断并恢复输入；注释「窗口已隐藏，生成已中断」；首轮+追问记录完整；随后可继续追问 |
| S7 | 连续追问至第 10 轮 → 输入区禁用并提示 | ✅ | 10 轮全部落盘（users=10/assistants=11）；输入区禁用，提示「已达到最大追问轮数（10），请重新划词开始新会话」；第十轮仍带 22 条消息（users=11） |
| S8 | 追问中重新划词 → 会话被新首轮替换（D4） | ✅ | 覆盖前 users=2/assistants=3 → 覆盖后 users=0/assistants=1；原文替换为新选区 |

截图：

- `test-results/realdevice/01-translate-followup.png` — 翻译 + 一轮追问（原文、译文、用户气泡、追问回答、输入区）
- `test-results/realdevice/02-explain-3-rounds.png` — 解释 + 3 轮追问
- `test-results/realdevice/03-custom-followup.png` — 自定义动作「术语」+ 追问
- `test-results/realdevice/04-translation-only-disabled.png` — 仅翻译模型：输入区禁用 + 提示
- `test-results/realdevice/05-stopped.png` — 主动停止后的「已停止生成」
- `test-results/realdevice/06-after-hidden.png` — 失焦隐藏后恢复，「窗口已隐藏，生成已中断」
- `test-results/realdevice/07-turn-limit.png` — 第 10 轮后输入区禁用与上限提示
- `test-results/realdevice/08-override-new-first-turn.png` — 新划词覆盖旧会话

---

## 3. 真机验证发现并修复的缺陷

两处都是设计文档给出的方案在实际平台上**不成立**，单元测试无法覆盖，只有真机才能暴露。

### 3.1 `visibilitychange` 在本平台的 `BrowserWindow.hide()` 下不会触发

- 现象：追问进行中失焦 → 主进程按 `main.js:854 onActionWindowBlur` 取消在途流且**不发通知**
  （设计如此），渲染层只能靠 `visibilitychange` 自愈。实测隐藏后
  `document.hidden === false`、`document.visibilityState === "visible"`、`visibilitychange` 从未触发。
- 后果：该轮卡在「生成中」直到渲染层自己的 30 秒空闲超时，然后显示**误导性的**
  「请求超时，请检查网络后重试」，而不是设计 §10.4 承诺的「窗口已隐藏，生成已中断」。
- 修复：由 `streamConversationTurn` 在取消原因为 `window-hidden` 时补发
  `stream:error { error:'窗口已隐藏，生成已中断', cancelled:true, interrupted:true }`；
  `window-closed` / `game-mode` 仍保持静默（窗口即将消失）。首轮路径（`streamToWindow`）**未改动**，
  仍保持既有行为。
- 验证：修复前恢复耗时 30 s 且文案错误；修复后 2 s、文案正确。
- 与设计的偏差：设计 §4.6 明确要求「其他取消原因保持现状不发通知」，理由是该选择
  「同时改变首轮收尾方式」且渲染层能自愈。真机证明渲染层无法自愈，因此只针对**追问路径**
  补发通知，首轮语义不变——保留设计的顾虑，同时让 §10.4 的承诺成立。

### 3.2 长会话把输入区顶出可视区（CSS 高度链断裂）

- 现象：`action.css` 的 `body { min-height: 100vh }` 让列容器高度保持 auto，长对话时
  `.content` 不再内部滚动，而是整个文档变高、文档成为滚动容器。
- 实测（40 行合成长回答）：`documentElement.scrollHeight=1267` vs `clientHeight=479`，
  `.content` 的 `scrollHeight === clientHeight === 1159`（完全没有内部滚动），
  header 的 `getBoundingClientRect().top = -717`。
- 后果：头部随文档滚走，**底部输入区被推到视口外**——多轮追问的核心交互不可达。
- 修复：`body` 改为 `height: 100vh; overflow: hidden`，`.content` 改为
  `flex: 1 1 0; min-height: 0`。
- 验证：修复后同一场景 `documentElement.scrollHeight === clientHeight === 479`、header 停在 top 0、
  `.content` 内部滚动（scrollHeight 1159 / clientHeight 372 / scrollTop 771），输入区固定在底部。
- 回归测试：`test/selection-toolbar-theme.test.js` 新增
  「selection result window pins the header and composer around a scrolling transcript」。

---

## 4. 门禁

| 命令 | 结果 |
|---|---|
| `npm test` | 532 通过 / 0 失败（基线 515，新增 17：`action-conversation` 7 + `action-conversation-stream` 5 + `ai-client` 2 + 探针通道锁 1 + 布局回归 1 + 既有断言更新） |
| `npm run check` | 语法 202 文件通过；`main.js` 2093 行 ≤ 2100 |
| `npm run test:coverage` | 三级门禁全部通过（`action-conversation.js` 行覆盖 98.7%） |

---

## 5. 遗留观察（未改，超出本次范围）

以下两项**都不是**真机行为观察，标注了各自的证据强度，避免被当成已验证结论：

1. **追问流式期间划选新文本会被 `isProcessing` 闸门静默丢弃。** 证据强度：**仅代码分析**。
   本次真机的 S8 是在**空闲**状态下做的新划词覆盖（D4），流式期间发新划词**没有测**。
2. **追问轮被隐藏打断时，界面上那半截回答不进上下文。** 证据强度：**单元测试**
   （`rollbackTurn` / `buildMessages` 用例）。真机只观察到该轮被标为中断、输入区恢复、
   随后可以继续追问，未断言后续请求的 messages 条数来证明回滚。

> 原先列在这里的「首轮被隐藏打断同样等满 30 秒」已于后续修复：取消上报收敛为共享的
> `reportCancelledTurn`，首轮与追问轮走同一条路径（设计要求「首轮行为不变」的约束经确认放宽）。
> 同一批还补上了隐藏后会话的托盘唤起入口，见设计文档 §16.3、§16.4。

---

## 6. 验证边界：这次没有覆盖什么

| 未覆盖 | 为什么重要 | 打包件验证会不会覆盖 |
|---|---|---|
| **打包入口 `main/packaged-entry.js`** | 发布配置把入口改成它（`extraMetadata.main`），开发模式走的是 `package.json.main = main.js`。它只多一个 `--highlighter-packaged-startup-probe` 开关，14 行 | ✅ 会 |
| **打包/asar 布局** | `asar: true`、`onlyLoadAppFromAsar` + `enableEmbeddedAsarIntegrityValidation`。`build.files` 漏掉某个文件只有打包后才暴露（如 `action/**/*`、`preload-action.js`） | ✅ 会 |
| **fuses** | `runAsNode:false`、`enableNodeOptionsEnvironmentVariable:false`、`enableNodeCliInspectArguments:false` —— 这套 harness 依赖主进程注入，在打包件上**无法复用**，需要通过 OS 级输入或仅渲染层 CDP 驱动 | 需换驱动方式 |
| **`HIGHLIGHTER_E2E=1` 被跳过的一切** | E2E 模式下 `main.js` 不建托盘、不注册全局热键、不启动 selection hook 与电源监听、不注入 OCR 热启动、不 `setLoginItemSettings`，且 `app.disableHardwareAcceleration()` | ✅ 会（打包件里 E2E 模式恒不生效） |
| **原生划词链路** | hook → `handleTextSelection`（`isProcessing`/10000 字/过滤应用等闸门）→ 工具栏在选区旁弹出 → 点击 → `positionActionWindow` 用 `lastToolbarPosition` 定位动作窗口。本次全部绕过，`positionActionWindow` 实际从未生效 | ✅ 会 |
| **真实 OS 输入** | 本次用 DOM 事件驱动，未经过 OS 鼠标/键盘 | ✅ 会 |
| **用户真实数据目录下的行为** | 本次用临时副本；打包非便携版会读 `E:\document\highlighter`（真实设置/密钥）并把窗口尺寸写回去 | 便携版可隔离 |

**结论**：本次验证充分覆盖了「结果窗口内部的多轮对话交互 + 主进程会话装配 + 安全面 + 真实模型链路」，
但不能替代打包件 + 真实划词链路 + OS 级输入的验收。§12.4 的手工验收项若要按最严格口径过一遍，
需要按上表补一轮打包件验证（建议用 portable 构建 + `PORTABLE_EXECUTABLE_DIR` 隔离数据目录，
不碰已安装的 2.2.6 与真实数据根）。

---

## 7. 复现脚本与截图的归属（有意不入库）

`.tmp/verify-conversation.js` 与 `test-results/realdevice/*.png` **有意保持未跟踪**，原因：

1. 脚本里硬编码了开发者本机的真实配置路径（`E:/document/highlighter/config/config.json`
   与 `cache/electron/Local State`），提交进仓库等于把私人环境路径固化进去；
2. 运行它必须解密真实供应商密钥并发起 20+ 次真实模型请求，**不适合放进 `npm test` 或 CI**
   （会在每次 CI 上花掉真实额度）；
3. 它靠主进程注入驱动，而 `package.json` 的 fuses 会把这条路封死，注定只能在开发模式跑。

运行方式：把该目录下的脚本放在仓库的 `.tmp/`（已被忽略），配好真实数据根后执行
`node .tmp/verify-conversation.js`；它会打印逐项 PASS/FAIL 并把截图与 `report.json` 写入
`test-results/realdevice/`。

若要让这条验证变成可复跑的门禁，建议单独排一步：把配置路径与环境依赖参数化，
落成 `scripts/verify-conversation.js`（对齐既有的 `scripts/probe-action-security.js` 惯例），
并在 `docs/` 里写明手工运行前置条件。当前**未**这样做，以免把一次性的排查脚手架
当成长期维护面。

