# 划词工具栏不显示问题 — 调研报告

- 日期：2026-08-12
- 版本：2.1.0-beta.0
- 状态：恢复缺陷已修复并通过自动化验证，待长期现场观察

## 1. 问题现象

- 报告时间：本周一（用户发现时电脑已连续运行 ≥ 3 天）。
- 现象：长时间运行后，划词（拖选文本）时工具栏不弹出。
- 关键特征：**重启应用即恢复**，且当前短会话内一切正常。

## 2. 调查结论摘要

**已确认存在“工具栏窗口死亡后永不重建”的状态性缺陷，它是本次问题的高概率根因；由于故障会话缺少事件到达日志，尚不能认定为唯一根因。**

| 检查项 | 结果 |
|---|---|
| 钩子启动 | `Selection hook started: startup` 正常 |
| 配置 | `selectionToolbar.enabled=true`，5 个按钮全开 |
| 动作解析 | 真实配置下 `getVisibleToolbarActionDefinitions()` 返回 5 个动作、宽度 370 |
| 安装产物 | 已装 asar 的 `main.js` 与源码 HEAD **逐字节一致**（不是旧代码） |
| 真实拖选实验 | Notepad / ZCode / Chrome 各拖选一次，工具栏均正常弹出 |
| Electron 运行时探针 | renderer 崩溃后窗口未销毁、`webContents.isCrashed()=true`，旧复用逻辑会继续返回死窗口 |

结论：**正常代码路径是通的，且已证实 renderer 崩溃会造成旧版无法自愈；本次现场问题仍需依靠新增诊断日志完成最终归因。**

## 3. 根因分析

### 3.1 触发链

```
handleTextSelection          main.js:896
  → showToolbarSelection     selection-window-manager.js:189
    → createToolbarWindow()  selection-window-manager.js:48
```

### 3.2 已确认缺陷：死窗口被永久复用

`createToolbarWindow()`（`main/services/selection-window-manager.js:48-49`）的复用判断：

```js
if (this.toolbarWindow && !this.toolbarWindow.isDestroyed()) return this.toolbarWindow
```

Electron 43.2.0 真实运行时探针确认：**渲染进程崩溃不会自动销毁 BrowserWindow**，`BrowserWindow.fromWebContents()` 仍能找到所属窗口，且 `showInactive()` / `webContents.send()` 不抛错。旧版因此发生以下连锁：

1. `main.js:3010` 的 `render-process-gone` 处理器**只 log + 记诊断，不做任何恢复**（全代码库仅此一处崩溃处理，无 `isCrashed()` 检查）；
2. **全代码库无 `did-fail-load` 监听**（grep 结果为零），`toolbar.html` 首次加载失败也完全无日志、无恢复；
3. 之后每次划词都对这个死窗口执行 `showInactive()` —— 它是 `transparent: true`（selection-window-manager.js:55），**视觉上就是"什么都没有"**，而钩子日志却一切正常。

这正好解释全部现象：钩子 started 正常、无任何报错、工具栏就是不出现、重启就好。

### 3.3 日志实锤：这台机器上渲染进程确实崩过

`app.log` 中共 **5 次** `Renderer process exited: {"reason":"crashed","exitCode":-1}`：

- `toolbar.html` 崩溃 **2 次**：7/30 09:39、8/10 00:52
- `config.html` 崩溃 3 次

按照已验证的旧版窗口生命周期，这两次 toolbar 崩溃后，该工具栏窗口无法自行恢复，直到应用重启。该机制与用户观察吻合，但日志尚不足以把其中某次崩溃与本次现场失效严格绑定。

环境相关线索：机器上运行着网易 UU 远程（GameViewer），历史排查曾发现它占用剪贴板并可能与 `selection-hook` 的剪贴板回退竞争。现有材料没有崩溃转储或严格的时间关联，不能据此认定 GameViewer 导致 renderer 崩溃。

### 3.4 残留不确定性（如实说明）

- **今天这单（d7e80687 会话，14:39–15:49）日志中没有渲染崩溃记录**。因此不能排除失效发生在更早的长会话，也不能排除 hook 停止投递、剪贴板回退失败或事件被状态条件过滤。
- renderer 崩溃和 `loadFile` 失败都归于同一个已修复的窗口生命周期缺陷：toolbar/action 窗口不可用后没有重建路径。
- 旧版 `handleTextSelection`（main.js:896-906）对“事件到没到、被哪个条件过滤”零日志；修复后按每种状态每会话一次记录程序名与文本长度，不记录文本内容。

## 4. 已实施修复

契约测试约束（已核查）：`diagnostics-ui-contract.test.js:17` 锁定 `recordProcessExit('renderer'` 调用必须保留；`selection-toolbar-settings.test.js:50` 锁定 `createToolbarWindow()...hasShadow: false`（只加监听、不改 options 即可规避）。

### 改动 1：`main.js` — `render-process-gone` 增加窗口恢复

- **保留**现有 `recordProcessExit('renderer', ...)` 与 `log(...)`（契约测试锁定，不得改动）；
- **新增**：用 `BrowserWindow.fromWebContents(webContents)` 找到所属窗口，交给 `SelectionWindowManager.handleRendererGone()` 判断归属并销毁；
- manager 中已有 `closed` 监听会清空引用，下次划词自然重建；action 窗口关闭时也会取消其活动流。
- 附带修复 action 窗口同类问题（`getOrCreateActionWindow` 同样会复用死窗口）。

### 改动 2：`selection-window-manager.js` — 复用前检查窗口健康

- `BrowserWindow` 未销毁还不够；同时检查 `webContents.isDestroyed()` 与 `webContents.isCrashed()`；
- 健康检查失败时销毁旧窗口并创建新窗口，作为全局崩溃事件恢复之外的第二道防线。

### 改动 3：`selection-window-manager.js` — 处理页面加载失败

- 捕获 `win.loadFile(pagePath)` 返回 Promise 的 rejection，记录错误并销毁失败窗口；
- 下一次调用重新创建窗口，不使用可能被子 frame 事件提前消费的 `once('did-fail-load')` 方案。

### 改动 4：`handleTextSelection` 限流诊断日志

- 记录 shown / busy / 空文本 / 超长文本 / 应用过滤 / 无动作按钮等状态；
- 每种状态每个应用会话最多写一次，只记 `programName` 与文本长度，**不记文本内容**。

## 5. 测试与验证

| 项 | 内容 |
|---|---|
| 单元测试 | 覆盖 toolbar/action 崩溃健康检查、所属窗口 renderer 退出、页面加载失败清理与后续重建 |
| Electron E2E | 使用 `forcefullyCrashRenderer()` 主动崩溃真实 toolbar renderer，确认死 BrowserWindow 被销毁 |
| 完整回归 | `npm test`：330/330；`npm run test:e2e`：4/4；`npm run check`：139 个 JavaScript 文件通过 |
| 长期观测 | 继续观察 `app.log`：确认崩溃/加载失败后下一次划词恢复，并通过限流诊断区分 hook 未投递与窗口失效 |
