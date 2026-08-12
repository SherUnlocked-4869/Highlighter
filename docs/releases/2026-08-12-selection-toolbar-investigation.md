# 划词工具栏不显示问题 — 调研报告

- 日期：2026-08-12
- 版本：2.1.0-beta.0
- 状态：调研完成，修复方案待实施

## 1. 问题现象

- 报告时间：本周一（用户发现时电脑已连续运行 ≥ 3 天）。
- 现象：长时间运行后，划词（拖选文本）时工具栏不弹出。
- 关键特征：**重启应用即恢复**，且当前短会话内一切正常。

## 2. 调查结论摘要

**划词链路本身没坏（排除逻辑性损坏）；坏的是"工具栏窗口死亡后永不重建"这一状态性缺陷。**

| 检查项 | 结果 |
|---|---|
| 钩子启动 | `Selection hook started: startup` 正常 |
| 配置 | `selectionToolbar.enabled=true`，5 个按钮全开 |
| 动作解析 | 真实配置下 `getVisibleToolbarActionDefinitions()` 返回 5 个动作、宽度 370 |
| 安装产物 | 已装 asar 的 `main.js` 与源码 HEAD **逐字节一致**（不是旧代码） |
| 真实拖选实验 | Notepad / ZCode / Chrome 各拖选一次，工具栏均正常弹出 |

结论：**代码路径是通的，某种运行时状态把它卡死，重启即清空。**

## 3. 根因分析

### 3.1 触发链

```
handleTextSelection          main.js:896
  → showToolbarSelection     selection-window-manager.js:189
    → createToolbarWindow()  selection-window-manager.js:48
```

### 3.2 缺陷点：死窗口被永久复用

`createToolbarWindow()`（`main/services/selection-window-manager.js:48-49`）的复用判断：

```js
if (this.toolbarWindow && !this.toolbarWindow.isDestroyed()) return this.toolbarWindow
```

**渲染进程崩溃不会销毁 BrowserWindow**，于是发生以下连锁：

1. `main.js:3010` 的 `render-process-gone` 处理器**只 log + 记诊断，不做任何恢复**（全代码库仅此一处崩溃处理，无 `isCrashed()` 检查）；
2. **全代码库无 `did-fail-load` 监听**（grep 结果为零），`toolbar.html` 首次加载失败也完全无日志、无恢复；
3. 之后每次划词都对这个死窗口执行 `showInactive()` —— 它是 `transparent: true`（selection-window-manager.js:55），**视觉上就是"什么都没有"**，而钩子日志却一切正常。

这正好解释全部现象：钩子 started 正常、无任何报错、工具栏就是不出现、重启就好。

### 3.3 日志实锤：这台机器上渲染进程确实崩过

`app.log` 中共 **5 次** `Renderer process exited: {"reason":"crashed","exitCode":-1}`：

- `toolbar.html` 崩溃 **2 次**：7/30 09:39、8/10 00:52
- `config.html` 崩溃 3 次

**这两次 toolbar 崩溃之后的会话时段内，划词必然全灭，直到重启。** 与用户观察到的现象精确吻合。

环境线索：机器上运行着网易 UU 远程（GameViewer），远控/显示驱动类软件是 Electron 渲染/GPU 进程崩溃的常见诱因，日志中崩溃集中在带远控使用的时段。

### 3.4 残留不确定性（如实说明）

- **今天这单（d7e80687 会话，14:39–15:49）日志中没有渲染崩溃记录**。因此今天的失效要么是 `toolbar.html` 首次 `loadFile` **静默失败**（无 `did-fail-load` 监听、不留痕），要么失效实际发生在更早的长会话 `ef2c2c54` 里。
- 两者归于**同一个代码缺陷**：toolbar/action 窗口死亡后没有重建路径。
- `handleTextSelection`（main.js:896-906）对"事件到没到、被哪个条件过滤"**零日志**——这是本 bug 能潜伏这么久、日志无法定位今天这单的直接原因。

## 4. 修复方案（3 处小改动）

契约测试约束（已核查）：`diagnostics-ui-contract.test.js:17` 锁定 `recordProcessExit('renderer'` 调用必须保留；`selection-toolbar-settings.test.js:50` 锁定 `createToolbarWindow()...hasShadow: false`（只加监听、不改 options 即可规避）。

### 改动 1：`main.js` — `render-process-gone` 增加窗口恢复（约 3010 行）

- **保留**现有 `recordProcessExit('renderer', ...)` 与 `log(...)`（契约测试锁定，不得改动）；
- **新增**：用仓库既有模式 `BrowserWindow.fromWebContents(webContents)`（main.js:1738 等处已用）找到所属窗口；若 `selectionWindowManager?.ownsToolbarWindow(win)` 或 `ownsActionWindow(win)`，则 `win.destroy()`；
- **无需额外清理**：manager 中已有 `closed` 监听（selection-window-manager.js:72-74、100-107）会自动清空引用，下次划词自然重建。
- 附带修复 action 窗口同类问题（`getOrCreateActionWindow` 同样会复用死窗口）。

### 改动 2：`selection-window-manager.js` — 补 `did-fail-load` 监听

`createToolbarWindow`（`loadFile` 后）与 `createActionWindow`（`loadFile` 后）各加一段，沿用 `did-finish-load` 的 `once` + 身份校验模式：

- 仅 `isMainFrame` 加载失败时 `log()` 后 `win.destroy()`，走 `closed` 清引用；子资源失败不误杀。

### 改动 3：`handleTextSelection`（main.js:896）入口诊断日志

- 各出口分支加 `log()`：**事件到达**（只记 `programName` + 文本长度，**不记文本内容**，防隐私泄漏）、以及被丢弃的原因（busy / 空文本 / 应用过滤 / 无动作按钮）；
- 项目无 debug 级别概念，沿用现有 info 级 `log()` 风格（与 main.js:815 一致）。

## 5. 测试与验证

| 项 | 内容 |
|---|---|
| 单元测试 | `test/selection-window-manager.test.js`：给 `FakeWindow` stub 补 `destroy()`；新增用例——主框架 `did-fail-load` 销毁窗口并清引用、下次 `createToolbarWindow()` 重建；子框架失败不销毁 |
| 契约测试 | 新增 `test/renderer-crash-recovery.test.js`：源码契约断言 render-process-gone 处理器含 `ownsToolbarWindow`/`ownsActionWindow` 归属判断与 `destroy()` 调用 |
| 回归 | `npm test`（60+ 文件）+ `npm run check`，重点确认 `diagnostics-ui-contract`、`selection-toolbar-settings`、`window-security` 契约测试不受影响 |
| 长期观测 | 修复后观察 `app.log`：崩溃/加载失败时应出现重建日志，且划词恢复 |
