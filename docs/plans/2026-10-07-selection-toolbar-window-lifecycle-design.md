# 设计文档：划词工具栏窗口生命周期加固（2026-10-07 现场事故）

- 状态：**待确认**（本文只做设计，不含代码改动）
- 关联事故：2026-10-07 用户报「划词工具没办法呼出」
- 相关代码：[main.js](../../main.js)、[main/domains/selection/index.js](../../main/domains/selection/index.js)、[main/services/selection-window-manager.js](../../main/services/selection-window-manager.js)、[main/services/selection-hook-service.js](../../main/services/selection-hook-service.js)

## 0. 需求背景与目标

### 0.1 事故现象

选词之后什么都不弹。应用侧日志显示划词已识别、工具栏已显示，用户侧却完全看不到工具栏。重启应用后立即恢复正常（2026-10-07 实测）。

### 0.2 现场证据链（已实测，2026-10-07）

| 环节 | 观测 | 结论 |
|---|---|---|
| 划词 hook | 独立探针进程（同一 `selection-hook`、同参数）真实拖选后收到 `text-selection`；应用 hook 宿主进程（pid 36472）在注入 5000 次真实鼠标移动时消耗 CPU，而主进程/explorer 为 0ms | hook 装着、在收事件 |
| 触发链路 | 拖选后应用执行了显示流程：`Selection event diagnostic: shown`、工具栏窗口被 `setSize`/`setPosition` | 触发链路正常 |
| 渲染 | 工具栏窗口的 CDP 截图显示 5 个按钮（翻译/解释/复制/搜索/跳转）全部正确 | renderer 正常 |
| **上屏** | **DXGI 真实桌面抓屏在窗口坐标处看到的是下层窗口像素**；移动窗口、`SW_HIDE`+`SW_SHOWNOACTIVATE`、`RedrawWindow` 均无效 | **窗口从未被合成到屏幕** |
| 窗口原生状态 | 坏实例 `GetWindowRect` = 508×102 DIP（代码每次显示都 `setSize(444, 40)`，从未生效） | 窗口实例已与 Chromium 失同步 |
| 代码路径 | 在全新 Electron 进程里跑仓库真实的 `SelectionWindowManager` + `toolbar-utils` + `window-security` + `toolbar.html`：窗口 444×40 且**正常上屏** | 代码无缺陷 |
| 重启后 | 新实例创建时 = 360×40（≈`TOOLBAR_W`），首次显示后 = 444×40，DXGI 抓屏可见 | 重启即可恢复 |

补充排除项（同样已实测，避免后续重走）：与图标改动（bb39588）无关；与 `transparent:true`/`focusable:false`/`showInactive()` 组合无关（含"创建后隐藏 5 分钟再 show"）；与 `SHQueryUserNotificationState` 无关（当前为 `QUNS_ACCEPTS_NOTIFICATIONS`）；不是被遮挡（TOPMOST、DWM `cloaked=0`）；安装包 `app.asar` 与仓库 HEAD 逐字节一致。

### 0.3 目标

- G1：让"工具栏窗口无法上屏"这一类失效不再需要用户重启应用，能自愈。
- G2：让下一次同类事故**可诊断**：日志能区分"没触发 / 触发了但窗口没上来 / 上来了"。
- G3：不牺牲首次划词的响应速度（预建窗口的初衷），不引入重建风暴。

### 0.4 非目标（本期明确不做）

- N1：不引入原生/驱动层的"检测窗口是否真的被合成"的能力（见 §2.4）。
- N2：不改划词工具的外观、宽度预算、动作集合。
- N3：不改钩子宿主（`SelectionHookService`）的既有行为，只在域层新增窗口回收触发点。
- N4：不处理"UIA 取不到选中文本"（`clipboardFallback=false`）与"键盘划选不触发"两个独立问题（另立设计）。

## 1. 已确认的关键决策

| 编号 | 决策 | 说明 |
|---|---|---|
| C1 | 保留启动预建 | 首次划词零等待是既有体验，不回退为"每次按需创建" |
| C2 | 预建窗口**寿命有界** | 在"可能让合成表面失效"的系统事件上主动销毁缓存窗口，下次划词重建 |
| C3 | 显示时做一次**可观测健康校验** | 校验结果进日志；不通过则销毁并重建一次（带风暴保护） |
| C4 | 诊断改为**分级** | "失败"永远记；"成功"仍保持低频（避免日志洪泛） |
| C5 | 观测先行（M1）再上校验（M2） | 先补字段，再让字段驱动自动重建 |

待确认项见 §8（其中 Q1、Q2 影响 M2 的实现形态）。

## 2. 关键事实（已核实）

### 2.1 窗口的创建与显示路径

- 启动即预建：`main.js:1218-1228` → `selectionDomain.createToolbarWindow()`（e2e 分支同样预建）。
- 创建：`main/services/selection-window-manager.js:97-132`，参数 `width=TOOLBAR_W`、`height=TOOLBAR_H(40)`、`frame:false`、`transparent:true`、`hasShadow:false`、`alwaysOnTop:true`、`skipTaskbar:true`、`focusable:!isWindows`、`show:false`、`resizable:false`，并调用 `setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true})`、`setAlwaysOnTop(true,'screen-saver')`。
- 显示：`selection-window-manager.js:273-281`（`setSize(width, toolbarHeight)` → `setPosition` → `showInactive()` → 队列化 `selection:text`）。
- 域侧入口：`main/domains/selection/index.js:285-306`（`handleTextSelection`）。

### 2.2 现有恢复路径覆盖到哪、覆盖不到哪

| 失效形态 | 现有覆盖 | 代码 |
|---|---|---|
| 窗口被销毁 | 下次创建 | `createToolbarWindow` 的 health 分支 |
| `webContents` 崩溃/销毁 | `isWindowHealthy` → 销毁重建 | `selection-window-manager.js:48-59` |
| renderer 进程崩溃 | `handleRendererGone` → 销毁 | `selection-window-manager.js:86-95` + `main.js:1243-1256` |
| 页面加载失败 | 销毁，允许下次重试 | `loadWindow` + `destroyUnavailableWindow` |
| **窗口存在、Electron 认为健康、但从未上屏** | **无** | 本次事故 |

`isWindowHealthy` 只检查 `isDestroyed()/isCrashed()`，因此"坏实例"永远通过健康检查并被无限复用——这是本次事故长期不被发现的结构性原因。

### 2.3 可观测性现状

- `logSelectionDiagnosticOnce`（`main/domains/selection/index.js:277-283`）每个 reason **每会话只记一次**，`shown` 在 07:09Z 就已被消费，导致之后"没上屏"与"正常显示"在日志上完全无法区分。
- 工具栏窗口相关日志只有生命周期与失败路径，没有任何"这次显示是否成功"的字段。

### 2.4 关键约束：现有 API 无法判定"未上屏"

坏实例同时满足：`IsWindowVisible=true`、`WS_EX_TOPMOST`、DWM `cloaked=0`、renderer 有正确画面（CDP 截图可证）。也就是说 **Electron/Chromium 的公开状态全都"正常"**。本次唯一暴露异常的信号是：

- 窗口实际尺寸（508×102）≠ 代码请求尺寸（444×40）；
- 且该尺寸不随 `setSize` 变化。

**该信号是否稳定可读仍未确认**：无法确定 Electron 的 `win.getSize()` 当时返回的是 OS 的 508×102 还是它自己以为的 444×40（事故实例已被重启销毁）。这正是 M1 观测先行（C5）的原因：先用日志把 `getSize()/isVisible()/isCrashed()` 与实际请求值一起打出来，再决定 M2 的判据。

### 2.5 真机数据（可复现基线）

| 实例 | 创建尺寸 | 首次显示后尺寸 | 上屏 |
|---|---|---|---|
| 坏实例（11:19 启动会话） | 未知 | **508×102**（`setSize` 无效） | ❌ |
| 重启后实例（21:27 启动会话） | 360×40 | **444×40** | ✅ |
| 探针复刻（新进程跑仓库真实代码） | 359×40 | **444×40** | ✅ |

## 3. 详细需求点

| 编号 | 需求 | 验收 |
|---|---|---|
| D1 | 缓存窗口在"系统解锁/唤醒"后销毁，下次划词重建 | 单测：解锁事件后 `toolbarWindow === null`；下次 show 走创建分支 |
| D2 | 缓存窗口在"显示器增删/度量变化"后销毁 | 单测：`display-metrics-changed` 后同样销毁 |
| D3 | 缓存窗口在"GPU 子进程崩溃（`child-process-gone` type=GPU）"后销毁 | 单测 + 契约测试 |
| D4 | 每次显示后做一次健康校验：`isVisible()`、`getSize()` 与请求值一致、`webContents.isCrashed()` | 单测注入"尺寸不一致"的假窗口 → 触发销毁重建一次 |
| D5 | 校验失败的重建必须**有界**：一次显示最多重建 1 次，冷却窗口内不重复重建（防风暴） | 单测：连续两次失败 → 第二次只记日志不再重建 |
| D6 | 日志分级：失败必记（含全部字段）；成功仍按现有低频策略 | 日志断言（契约测试） |
| D7 | 游戏模式/隐藏语义不变：suspend 期间不因回收触发任何显示 | 域级测试回归 |
| D8 | 首次划词延迟不回归：预建仍在启动路径上（`main.js:1220`） | 契约测试：`createToolbarWindow()` 仍与 `initSelectionHook()` 同级调用 |

## 4. 技术设计

### 4.1 窗口生命周期：预建 + 有界寿命

在 `SelectionWindowManager` 上新增一个显式语义：

```js
// 销毁缓存的工具栏窗口；下次 showToolbarSelection 会重建。
// 与 destroyUnavailableWindow 的区别：这是"主动回收健康窗口"，
// 因此不写 "unavailable" 日志，改记 recycle 原因。
recycleToolbarWindow(reason, { keepPosition = true } = {})
```

回收触发点矩阵：

| 触发 | 来源 | 理由 |
|---|---|---|
| `unlock-screen` / `resume` | 已有 powerMonitor 绑定（`main/domains/selection/index.js:231-247`），在恢复钩子之后追加一次回收 | 事故会话在解锁后 74 分钟窗口就已不可用 |
| `display-added` / `display-removed` / `display-metrics-changed` | **新增** `screen` 事件绑定（当前全仓库无任何 `screen.on`） | 合成表面与显示器/DPI 强相关 |
| `child-process-gone` 且 `type === 'GPU'` 或 `reason === 'crashed'` | `main.js:1257` 已有日志位 | GPU 进程重启会让既有窗口的合成路径失效 |
| `render-process-gone` | 已有（renderer 崩溃即销毁） | 保持 |
| 健康校验不通过 | D4 | 兜底 |

不变式：**回收只销毁窗口对象，不改 `lastToolbarPosition`**，保证重建后仍按上次锚点定位；回收发生在 hook 恢复之后，顺序为"先恢复钩子，再回收窗口"（避免"钩子已恢复、窗口却被销毁"的中间态被用户观察到）。

### 4.2 show 时的健康校验与一次性重建

`showToolbarSelection` 末尾追加：

```js
showToolbarSelection({ text, actions, position, width }) {
  const win = this.createToolbarWindow()
  win.setSize(width, this.toolbarHeight)
  this.lastToolbarPosition = position
  win.setPosition(position.x, position.y)
  win.showInactive()
  this.queueToolbarSelection(win, { text, actions, appearance: this.getAppearance() })
  this.verifyToolbarPresentation(win, { width, height: this.toolbarHeight, textLength: ... , actions: actions.length })
  return win
}
```

`verifyToolbarPresentation` 的判据（M1 只记录，M2 才据此重建）：

1. `win.isVisible() === true`；
2. `win.getSize()` 与请求的 `[width, this.toolbarHeight]` 一致（**待 Q1 确认可行性**）；
3. `!win.webContents.isCrashed()`。

不通过时：`destroyUnavailableWindow(win, 'toolbar', 'presentation')` → 重建一次 → 重新 `setSize/setPosition/showInactive/queue` → **不再二次校验**（D5），并记 `toolbar.presentation-failed` 日志（含原因、期望/实际尺寸）。冷却：同一会话内每次显示最多 1 次重建；两次重建之间至少间隔 `recycleCooldownMs`（建议 5s，避免选择抖动导致连环重建）。

### 4.3 事件接线

- 域层新增 `registerSelectionDisplayEvents()` / `disposeSelectionDisplayEvents()`，与现有 `registerSelectionPowerEvents` 对称，使用 `screen.on(...)`；在 `main.js` 启动路径上与 `registerSelectionPowerEvents()` 相邻调用，并在退出路径 dispose。绑定前做 `screen` 能力探测（`typeof screen?.on === 'function'`），保持可测性（测试可注入假 `screen`）。
- `child-process-gone`：在 `main.js:1257` 的回调里追加 `selectionDomain.handleChildProcessGone(details)`；域内只在 `type === 'GPU'` 时回收。
- 全部触发走同一个 `recycleToolbarWindow(reason)`，保证日志里能看到原因分布。

### 4.4 诊断规格

在现有 `Selection event diagnostic` 的 `shown` 分支里**新增字段**（保持 once-per-session）：

| 字段 | 来源 | 用途 |
|---|---|---|
| `toolbarVisible` | `win.isVisible()` | 排除窗口被系统隐藏 |
| `toolbarSize` / `toolbarRequestedSize` | `win.getSize()` vs 请求值 | 本次事故的唯一异常信号 |
| `toolbarAgeMs` | 域内记录窗口创建时间 | 判断"长寿命窗口"相关性 |
| `toolbarRecycled` | 本次显示前是否刚回收过 | 判断回收是否真的发生 |

新增**失败必记**事件（不受 once-per-session 限制，但带 5s 冷却）：`toolbar.presentation-failed`，字段含 `reason`、`expectedSize`、`actualSize`、`visible`、`crashed`、`recycled`。

### 4.5 与游戏模式/隐藏语义的相互作用

- `applyGameMode(true)` 期间：suspend 钩子 + `hideToolbar()`；此时即使收到系统事件也**只标记待回收**（`toolbarRecyclePending = true`），不立即销毁，避免"隐藏中的窗口被销毁"造成状态分叉；退出游戏模式后在下一次 show 前统一回收。
- `hideToolbar()` 只 `hide()`，不销毁，语义不变。

### 4.6 文件改动清单（预估）

| 文件 | 改动 |
|---|---|
| `main/services/selection-window-manager.js` | 新增 `recycleToolbarWindow`、`verifyToolbarPresentation`、尺寸/年龄记录；`showToolbarSelection` 末尾接线 |
| `main/domains/selection/index.js` | 新增 display 事件注册、`handleChildProcessGone`、诊断字段、`toolbar.presentation-failed` 事件 |
| `main.js` | 启动/退出路径注册与 dispose display 事件；`child-process-gone` 转交域层 |
| `test/selection-window-manager.test.js` | 新增 4~6 个用例（见 §5.1） |
| `test/selection-domain.test.js` | 新增 2 个用例（display 事件、GPU 回收） |
| `test/selection-toolbar-resilience.test.js` | 追加源码契约（display 事件存在、预建仍在、失败日志存在） |
| `scripts/probe-selection-toolbar-window.js`（可选新增） | 把本次事故用的真机探针固化为脚本：新进程跑真实 `SelectionWindowManager`，输出窗口尺寸 + 是否上屏（DXGI 抓屏由人工/驱动完成） |

## 5. 测试计划

### 5.1 单测（扩 `test/selection-window-manager.test.js`，复用其假窗口工厂）

1. `recycleToolbarWindow` 销毁窗口且不改 `lastToolbarPosition`；
2. 回收后下一次 `showToolbarSelection` 走创建分支（记录 `createWindow` 调用次数）；
3. 假窗口 `getSize()` 返回不一致尺寸 → 触发一次销毁重建，且重建后不再校验；
4. 连续两次显示都失败 → 只重建一次，第二次只记日志（D5）；
5. 冷却窗口内的事件不产生第二次回收；
6. 游戏模式下事件只置 pending，不销毁（D7）。

### 5.2 域级测试（扩 `test/selection-domain.test.js`）

1. 注入假 `screen`/`powerMonitor`：触发 `display-metrics-changed`、`unlock-screen`、`child-process-gone(GPU)` → 断言 `windowManager.recycleToolbarWindow` 被调用且原因正确；
2. 诊断字段：`shown` 记录里出现 `toolbarSize/requestedSize/toolbarAgeMs`。

### 5.3 契约测试（扩 `test/selection-toolbar-resilience.test.js`）

- `main.js` 仍在启动路径预建工具栏窗口；
- 域层存在 display 事件注册与 dispose；
- `child-process-gone` 转交域层；
- 存在"失败必记"日志分支。

### 5.4 真机验证（必须做，单测覆盖不到合成）

以本次事故的探针为模板（`.tmp` 脚本转正）：
1. 新进程跑真实 `SelectionWindowManager` → 期望 444×40 且 DXGI 抓屏可见；
2. 安装包内跑：启动 → 锁屏 → 解锁 → 划词 → 期望工具栏可见（覆盖 D1 的现场路径）；
3. 故障注入：人为把缓存的窗口 `SetWindowPos` 到异常尺寸，模拟"setSize 无效"，验证 M2 的校验能否触发重建。

### 5.5 验收标准

- 自动化：`npm test` 全绿（新增用例包含在内）、`npm run check` 通过；
- 真机：锁屏/解锁、显示器切换（插拔副屏）、GPU 进程被杀三种场景后，划词工具栏均可见；
- 日志：人为复现"未上屏"时，`toolbar.presentation-failed` 出现且字段足以定位。

## 6. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| M2 的判据（`getSize` 不一致）在实践中不可靠 | 自动重建不生效，退化为"仅可诊断" | M1 观测先行（C5）；判据不可靠时 M2 降级为"仅在显示失败日志出现后提示用户重启/手动重载" |
| 回收过频导致首次划词变慢 | 体验回退 | 只在四类系统事件后回收；回收后仍保持预建的"下一次划词立即创建"，实测创建+加载 < 100ms（启动日志 `main-window.ready` 324ms 内含全部服务） |
| 重建风暴 | CPU/闪烁 | D5 单次上限 + 冷却窗口 |
| display 事件在测试环境缺失 | 测试不稳 | 能力探测 + 注入假 `screen` |
| 与 e2e 路径冲突 | e2e 失败 | e2e 分支（`main.js:1228`）行为保持：预建不变，仅新增 recycle API 不改变默认路径 |

## 7. 实施分期

| 阶段 | 内容 | 出口 |
|---|---|---|
| M1 | 只做观测：诊断字段 + `toolbar.presentation-failed` + 探针脚本转正 | 下一次同类事故可从日志判定；不改任何行为 |
| M2 | 事件回收（D1~D3）+ 健康校验与一次性重建（D4/D5） | 单测/契约测试全绿 + 故障注入复验 |
| M3 | 真机复验（锁屏解锁、显示器插拔、GPU 崩溃）+ 安装包内验收 | 三条真机场景全通过 |

## 8. 待确认清单

- **Q1**：M2 是否采用"`win.getSize()` 与请求尺寸不一致"作为健康判据？（取决于 M1 是否能证明该信号可读；若不可读，改用"仅在失败日志出现后降级提示"）
- **Q2**：回收触发点是否需要"启动后 N 小时内必回收一次"这类时间上限？（当前设计只用系统事件，不加时间维度；若事故在没有任何系统事件的会话里也能发生，则需要补一条）
- **Q3**：是否需要给用户一个手动"重载划词工具栏"的入口（托盘菜单/设置页）作为无力自愈时的兜底？
- **Q4**：预建窗口是否改为"首次 show 前才真正 loadFile"（省一次启动期渲染）？属性能优化，非本事故必需。
- **Q5**：`recycleCooldownMs` 取值（建议 5000ms）与日志采样策略需要你确认后写死。

## 9. 实施结果与偏差（2026-10-07，分支 `feat/toolbar-lifecycle-and-hotkey-keys`）

### 9.1 已落地

- `main/services/selection-window-manager.js`：新增 `recycleToolbarWindow`、`inspectToolbarPresentation`、`logPresentationFailure`、`canRebuildToolbar`、`rebuildToolbarWindow`、`getToolbarPresentationReport`，抽出 `applyToolbarGeometry`；`showToolbarSelection` 显示后记录报告，失败时在冷却窗口内最多重建一次（重建后复用同一几何与 payload）。
- `main/domains/selection/index.js`：新增 `registerSelectionDisplayEvents` / `disposeSelectionDisplayEvents`（`display-added` / `display-removed` / `display-metrics-changed`）、`handleChildProcessGone`（仅 `type === 'GPU'`）、`recycleToolbarWindow`（游戏模式挂起为 pending，下次 show 前执行）；`shown` 诊断新增 6 个字段。
- `main.js`：`child-process-gone` 转交域层；`createAppLogger.isEnabled` 改为读 store（原因见 9.4）。

### 9.2 与设计稿的偏差（3 处，均有实测依据）

1. **display 事件的注册位置**：设计稿写"在 main.js 启动路径上与 `registerSelectionPowerEvents()` 相邻调用"，实现改为在 `initSelectionHook()` 内注册、`disposeSelectionHook()` 内注销。原因：`main.js` 有 1300 行架构门禁，放域内可 0 行接线，且 init/dispose 天然对称。
2. **尺寸判据加 2 DIP 容差**：真机实测**正常**窗口是 `[445,40]`，请求值是 `[444,40]`（Electron/Windows 取整）。若严格相等判定，每次显示都会误判失败并重建窗口——这是本次真机复验最有价值的一条发现。容差只影响判定，不影响日志（日志同时记录请求值与实际值）。
3. **冷却/日志节流的初值为 `null` 而非 0**：语义是"从未重建过 / 从未失败过 → 第一次永远放行"，避免测试注入小步进时钟时把首次机会也挡掉（实现过程中确实踩到过）。

### 9.3 门禁与真机

- `npm test`：**653/653 通过**（基线 629 → 新增 24 个用例）；`npm run check` 通过（233 个 JS 文件语法检查 + 架构门禁 `main.js 1298/1300`）。
- 真机（开发版跑工作区代码）：划选后日志出现
  `toolbarPresentationOk:true, toolbarVisible:true, toolbarSize:[445,40], toolbarRequestedSize:[444,40], toolbarAgeMs:207649, toolbarRecycled:false`，
  DXGI 桌面抓屏可见工具栏本体。
- 未覆盖：显示器插拔、GPU 进程被杀两条真机路径需要人工触发（逻辑分支已由单测覆盖）；锁屏/解锁沿用既有 hook 恢复流程。

### 9.4 实施中暴露并修复的既有缺陷（重要）

第一次真机启动直接失败：`Highlighter 启动失败: Cannot read properties of null (reading 'getSettings')`。

- 原因：迁移在 `SettingsService` **构造期间**运行，而 `createAppLogger` 的 `isEnabled` 依赖 `getSettings()`，此时 `settingsService` 尚未赋值 → 抛错。
- 修复：`isEnabled` 改为直接读 store（`store.get('settings', {}).system?.runLog !== false`）。
- 影响面：任何"初始化期写日志"的迁移都会踩到同一条路径，不只是本次新增的快捷方式迁移。已由真机启动验证（迁移日志正常落盘）。

### 9.5 对 §8 待确认清单的落地选择

- **Q1**：实现为"带容差的健康校验 + 一次性重建"。真机已证实该信号可读（445/444），但必须带容差才可用。
- **Q2**：未加"无条件定期回收"，只保留系统事件 + show 校验；保持最小改动。
- **Q3**：未加手动重载入口（自愈已覆盖事件与显示两条路径）。
- **Q4/Q5**：预建策略不变；冷却取 5000ms（常量，可调）。
