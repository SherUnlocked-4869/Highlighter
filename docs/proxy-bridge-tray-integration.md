# Highlighter 托盘集成 Index-Translate 代理桥接 · 实现方案

> **文档类型**：实现方案（先方案后编码）
> **目标读者**：接手实现的会话 / 人类工程师
> **上游交接文档**：`F:\workspace\dshChat\Index-Translate-代理桥接-交接文档.md`（以下简称「交接文档」）
> **本机实测时间**：2026-10-16（Asia/Hong_Kong）
> **状态**：方案已落定，**尚未写代码**；文中的 6 个决策点待确认（§10）

---

## 0. TL;DR

把「启动 / 停止 Index-Translate 本地代理（`python inference\llm\call_api.py --serve`）」做成 **Highlighter 托盘右键菜单里的一个勾选项**，形态与现有的「游戏模式」一致：

```
截图 / 截取全屏 / 截取焦点窗口 / 固定图片 / 视频录制 / 本地搜索
────────────────────
✓ 翻译代理（Index-Translate）      ← 新增：checkbox，勾上=启动，取消=停止
────────────────────
  游戏模式
────────────────────
  取消全部穿透 / 显示划词对话 / 截图历史 / 显示主界面
────────────────────
  退出
```

实现落点只有 4 处**必改**文件 + 2 处外围，全部是既有扩展点，不需要新架构：

| # | 文件 | 改动 |
|---|---|---|
| 1 | `main/services/translation-proxy-service.js` | **新增**：子进程生命周期 + 就绪探测 + 停止（可注入依赖、可单测） |
| 2 | `main/services/tray-menu.js` | 加一个 `translationProxy` 入参与对应菜单项 |
| 3 | `main.js` | `createTrayIcon()` 注入状态与回调；`before-quit` 补一句 `dispose()` |
| 4 | `main/services/settings-defaults.js` | 新增 `proxy` 设置组（校验模板同步生效） |
| 5 | `shared/locales/main.js` + `config/routes/settings.js` | 文案 3 语言 + 设置页行（阶段 2） |
| 6 | `test/translation-proxy-service.test.js` 等 | 新增/扩展测试 |

**三个必须提前知道的硬约束**（否则返工）：

1. ⚠️ **`main.js` 只剩 3 行余量**：当前 1297（`split(/\r?\n/)` 口径），架构门禁 `scripts/check-architecture.js:18` 硬上限 **1300**。本方案必然要动 `main.js`，所以**必须同时**把常量上调（已落地为 **1330**）并在注释里写明理由，否则 `npm run check` 直接红。
2. ⚠️ **设置项是白名单校验**：`settings-validation.js:26-34` 用 `DEFAULT_SETTINGS` 当模板递归比对，**没写进 `DEFAULT_SETTINGS` 的键一律被拒**（`不支持的设置项`）。所以 `proxy` 组的每一个字段都必须在默认值里列全。
3. ⚠️ **托盘模板不能因为新依赖而抛错**：`tray-menu.js:19-24` 对必填入参是 `throw`。若把 `setTranslationProxyEnabled` 设为必填，`test/tray-menu.test.js`、`test/shortcut-ui-contract.test.js`、`test/i18n-main.test.js` 里的既有 `buildTrayMenuTemplate({...})` 调用会全部挂掉。**必须按可选依赖处理**（照抄 `exitClickThrough` 的 `typeof === 'function'` 降级写法），另加契约测试断言 `main.js` 真的注入了。

---

## 1. 需求与边界

### 1.1 要做的

- 托盘右键菜单出现一个勾选项：勾上 → 启动本地代理；取消 → 停止本地代理。
- 勾选态**反映真实状态**（进程活着 / 端口在应答），不是"我点过一次"的记忆。
- 启动失败（脚本不存在 / Python 不存在 / 端口被占）要给出可行动的错误提示，且菜单不能被卡死。
- 退出 Highlighter 时默认回收代理进程，不制造孤儿。
- 单测可跑（仓库门禁：`main/services/**` 行覆盖 ≥ 85%）。

### 1.2 不做的（本方案范围外）

- ❌ 不去浏览器里配置沉浸式翻译（GUI 人工操作，见交接文档 §5）。
- ❌ 不打包 / 不内嵌 `call_api.py`，不改上游仓库；代理脚本仍从外部路径调用。
- ❌ 不加 `--host 0.0.0.0`（交接文档 §7.3 红线）。设置里**允许**填，但默认关闭且 UI 明确警告。
- ❌ 不做模型质量压测、不做 2B/9B 路由（交接文档 §7.1 红线：模型名只填 `Index-Translate-35B-A3B`）。

---

## 2. 现状勘察（本文所有断言的依据）

### 2.1 Highlighter 侧（已读源码）

| 事实 | 位置 |
|---|---|
| 托盘在 `createTrayIcon()` 里用 `tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate({...})))` 一次性构建 | `main.js:826-851` |
| 模板是**纯函数**，labels 在**构建时**用 `t()` 求值 → 语言/状态一变必须重建托盘 | `main/services/tray-menu.js:5, 39-63` |
| 重建入口统一是 `createTrayIcon()`，已在多处被调用（语言切换、窗口开关、游戏模式） | `main.js:921`、`main/domains/settings-effects/index.js:40,82,113`、`main/domains/selection/index.js:164,168` |
| 已有一个 checkbox 先例：`main.tray.game-mode`（`type:'checkbox'` + `checked` + 直接回调） | `main/services/tray-menu.js:46-51` |
| 已有一个"绕过 router 直接调 domain"的先例：`exitClickThrough`（可选依赖降级） | `main/services/tray-menu.js:34-36`；`main.js:833-837` |
| `function-router.executeFunction()` 开头 `assertGameModeDisabled()` — 游戏模式下 router 拒绝一切 | `main/services/function-router.js:148-155` |
| 子进程管理已有成熟先例 `EverythingService`：注入 `spawn`/`execFile`、`start()` 就绪超时、`taskkill /PID /T /F` 杀树、进程镜像路径比对防误杀 | `main/services/everything-service.js:55,181-234,483-500,523-538` |
| 退出钩子：`will-quit` 放同步 dispose，`before-quit` 放 service.stop() | `main.js:1280-1295` |
| `main.js` 行数上限 1300 | `scripts/check-architecture.js:18`；实测 `split(/\r?\n/).length = 1297` |
| 设置校验：未知键直接抛 `不支持的设置项` | `main/services/settings-validation.js:26-34` |
| i18n：`shared/locales/main.js` 单文件注册 3 语言，键集必须三语对称；`check-i18n` 还会统计 `main/**` 里未迁移的**中文字面量**（当前 `--max 606`） | `shared/locales/main.js:27-33`、`scripts/check-i18n.js:124-145,163-188`、`package.json:31` |
| 覆盖门禁：`c8 --lines 85 --include=main/services/**` | `package.json:14` |
| 测试风格：`node:test` + 直接 require 被测模块 + 依赖注入假实现；契约测试会**读源码正则匹配** main.js | `test/tray-menu.test.js`、`test/shortcut-ui-contract.test.js:211-214` |
| 工作区干净（除未跟踪的 `.zcodeignore`），分支 `master` | `git status`，HEAD `c325246` |

### 2.2 Index-Translate 代理侧（已读 `inference/llm/call_api.py`）

| 事实 | 位置 | 对本方案的意义 |
|---|---|---|
| `--serve [PORT]`，`nargs='?'`、`const=8080`、`type=int`；别名 `--proxy`；`--host` 默认 `127.0.0.1`；`--api-base` 可覆盖上游 | `call_api.py:454-468` | 启动参数就长这样：`python call_api.py --serve 8080 --host 127.0.0.1` |
| **`GET /` 返回纯文本 `Index-Translate Proxy Ready`**（200） | `call_api.py:327-332` | **最佳存活/身份探测端点**：比 `/v1/models` 轻，且能区分"我们的代理"和"别人占了端口" |
| 启动横幅含 `Index-Translate Local Proxy listening on {host}:{port}` | `call_api.py:423-432` | 可做快速就绪信号（但见下条编码坑） |
| 只捕获 `KeyboardInterrupt` 退出；Windows 上 `TerminateProcess` 不会触发它 | `call_api.py:434-438` | **没有优雅停机路径**，只能杀进程；脚本无临时文件/无落盘状态，硬杀安全 |
| 访问日志写 stderr | `call_api.py:300-301` | stderr 收日志即可，不要当错误 |
| **实测：Python 管道 stdout 编码 = `gbk`**（`preferredencoding = cp936`），加 `PYTHONIOENCODING=utf-8` 后变 `utf-8` | 本次实测 | 关键：Node 端若按 utf8 解码，中文横幅会变乱码，`listening on` 行虽仍是 ASCII 但不要依赖 chcp；`run_proxy_windows.bat` 的 `chcp 65001` **对管道无效** |
| `ThreadingHTTPServer`，`allow_reuse_address=1` | `call_api.py:420` | 杀掉后立刻重启不会撞 TIME_WAIT |
| 上游无需鉴权、代理不透传 `Authorization` | 交接文档 §7.2 | 设置里不要提供 API Key 输入框 |

---

## 3. 总体设计

```
                 ┌──────────────────────────── Highlighter (Electron main) ────────────────────────────┐
                 │                                                                                      │
  托盘右键 ──►  tray-menu.js  ──click──►  main.js createTrayIcon() 的闭包                                   │
  （checkbox）      （模板）                 │                                                            │
                                           ├─ setTranslationProxyEnabled(true)  ──► TranslationProxyService.start()
                                           └─ setTranslationProxyEnabled(false) ──► TranslationProxyService.stop()
                                                        │
                                    ┌───────────────────┴────────────────────┐
                                    │  translation-proxy-service.js          │
                                    │  · spawn python call_api.py --serve    │
                                    │  · PYTHONIOENCODING=utf-8 / windowsHide│
                                    │  · 就绪探测 GET / == "…Proxy Ready"    │
                                    │  · 状态机 + onChange  → createTrayIcon()│
                                    │  · taskkill /PID /T /F 杀树            │
                                    │  · 孤儿收养（refresh）                  │
                                    └───────────────────┬────────────────────┘
                                                        │ http://127.0.0.1:8080/
                                                        ▼
                                       python inference\llm\call_api.py --serve
                                                        │ https://index-translate.bilibili.com/v1
                                                        ▼
                                          [沉浸式翻译] → 127.0.0.1:8080/v1 → 云端 35B
```

### 3.1 状态机

| 状态 | 含义 | 托盘勾选 | 菜单项可用 | 备注 |
|---|---|---|---|---|
| `idle` | 未运行 | ☐ | ✅ | 初始态 |
| `starting` | 已 spawn，等就绪 | ☑（乐观勾上） | ❌ | 防连点；最长 20s |
| `running` | 探测通过 | ☑ | ✅ | `adopted=true` 表示是外部残留进程 |
| `stopping` | 已发杀进程，等端口释放 | ☐ | ❌ | 最长 5s |
| `error` | 上一次切换失败 | 按实际存活状态 | ✅ | `lastError` 保留给弹窗 |

- 状态**唯一来源是探测**，不是"点过按钮"。因此 Highlighter 冷启动时先跑一次 `refresh()`：若端口上已有应答且 body 命中 `Index-Translate Proxy Ready`，直接进 `running`（`adopted`），勾选态就是对的。
- 状态每次变化都调 `onChange` → `main.js` 里 `createTrayIcon()`，否则 checkbox 是**上一次构建时的旧值**（`setContextMenu` 不会自动刷新）。

---

## 4. 逐文件改动清单

### 4.1 新增 `main/services/translation-proxy-service.js`（核心，约 220 行）

> ⚠️ **本节已被取代（2026-10-17）**：该服务已改为**进程内 Node 中继**，不再 spawn Python，
> 也不再需要仓库目录/脚本路径/Python 解释器等设置。现行实现、决策与验证结果见
> `docs/proxy-inprocess-relay-plan.md`；本节仅保留为历史设计记录。

工厂函数 + 全依赖注入（照抄 `EverythingService` 的可测结构）。**新代码注释一律用英文**——`check-i18n` 会统计 `main/**` 的中文字面量（当前 606 上限），中文注释会顶到门禁。

```js
'use strict'
// Owns the lifecycle of the Index-Translate local proxy (python call_api.py --serve).
// Everything is injected so node:test can drive it without spawning python.

const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { execFile, spawn } = require('node:child_process')

const READY_TIMEOUT_MS = 20000
const READY_INTERVAL_MS = 250
const STOP_TIMEOUT_MS = 5000
const PROBE_TIMEOUT_MS = 800
// call_api.py:327 answers GET / with this exact body; it is what distinguishes our
// proxy from an unrelated program that happens to hold the port.
const PROBE_MARKER = 'Index-Translate Proxy Ready'
const BANNER = /listening on\s+([\d.]+):(\d{2,5})/i

const STATE = Object.freeze({ idle: 'idle', starting: 'starting', running: 'running', stopping: 'stopping', error: 'error' })

function createTranslationProxyService(deps) {
  const {
    getSettings, log,
    spawnFn = spawn, execFileFn = execFile, probe = probeProxy,
    platform = process.platform,
    env = process.env,
    setTimer = setTimeout, clearTimer = clearTimeout,
    onChange = () => {}
  } = deps
  ...
  return { getStatus, start, stop, toggle, refresh, dispose }
}
```

**API 契约**（tray/IPC/测试都按这个用）：

```js
getStatus()  // { state, running, busy, adopted, pid, port, host, endpoint, lastError, changedAt }
start()      // Promise<status>  幂等：starting/running 时返回同一个 promise
stop()       // Promise<status>  幂等：idle 时直接返回
toggle()     // Promise<status>  running → stop()，其余 → start()
refresh()    // Promise<status>  只探测，不 spawn（冷启动收养 / 外部状态同步）
dispose()    // void             同步尽力杀，供 app 'will-quit' 使用
```

**启动流程（顺序很重要）**：

1. `resolveLaunch()` 解析并校验路径，**任何一项不成立都在 spawn 之前失败**，错误信息带上被检查的绝对路径：
   - `scriptPath`（默认 `<repoDirectory>/inference/llm/call_api.py`）存在且是文件；
   - Python 解析顺序：`settings.proxy.pythonPath` → `py -3`（Windows launcher）→ `python`；全部失败则报「未找到可用的 Python 解释器」。
2. **先探测，再 spawn**：
   - `probe()` 命中 marker → 直接置 `running / adopted`，**不重复 spawn**（避免二次实例撞端口）；
   - `probe()` 表明端口有应答但 body 不匹配（`occupied && !ok`）→ 失败：「端口 8080 已被其它程序占用」，并提示改端口；
   - 无应答 → 继续。
3. spawn：

```js
const child = spawnFn(pythonCommand, [...pythonPrefixArgs, scriptPath, '--serve', String(port), '--host', host, ...apiBaseArgs], {
  cwd: repoDirectory || path.dirname(scriptPath),
  windowsHide: true,                       // 不弹黑窗
  stdio: ['ignore', 'pipe', 'pipe'],        // 不需要 stdin
  env: { ...env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' }  // 关键，见 §2.2
})
```

4. **就绪判定 = 轮询 `GET /` 直到 body 含 marker**（每 250ms，最长 20s），stdout 只用于日志与错误解释：
   - stdout 命中 `BANNER` 只作为快速通道/日志（`PYTHONIOENCODING=utf-8` 已确保不乱码）；
   - 子进程 `exit` 早于就绪 → 立刻失败，并把 stderr 尾部（`ModuleNotFoundError` / `Address already in use` 等）拼进 `lastError`；
   - 超时 → 杀树后失败。
5. 探测成功 → `running`，`pid = child.pid`，`endpoint = http://127.0.0.1:8080/v1`，触发 `onChange`。

**停止流程**：

1. `idle` → 直接返回。
2. 记录目标 pid：自有子进程用 `child.pid`；`adopted` 时先用
   `(Get-NetTCPConnection -LocalPort <port> -State Listen).OwningProcess` 反查。
3. **防误杀护栏**（照抄 `everything-service.js:488-492` 的思路）：用
   `(Get-CimInstance Win32_Process -Filter "ProcessId=<pid>").CommandLine` 校验命令行**必须包含 `call_api.py`**，否则拒绝杀、记日志、返回失败。这一条覆盖"用户自己起的 python 服务占了这个端口"的场景。
4. Windows：`taskkill /PID <pid> /T /F`（`/T` 是必须的——若用户把 `pythonPath` 配成 `py.exe`，`py.exe` 只是父壳，`child.kill()` 会留下孤儿 python）；非 Windows 回退 `process.kill(pid)`。
5. 轮询探测直到**不再应答**（最长 5s）。仍应答 → `error`（"进程已发出终止但端口仍被占用"），勾选保持 ☑，把真相告诉用户。
6. 释放句柄、`idle`、`onChange`。

**`dispose()`（退出路径）**：必须同步完成，只发 `taskkill /T /F`，不等待、不改状态机（`will-quit` 里 await 无意义）。用 `execFileSync` 或 `spawnSync`，超时 3000ms，失败只记日志。

**孤儿收养**：Electron 被任务管理器强杀时子进程必然残留（Windows 不级联）。冷启动时 `refresh()` 会把它认成 `running / adopted`，用户可以直接从托盘关掉——**不需要** Job Object 之类的重型方案。

**注入点小结**（这就是覆盖率的抓手）：`spawnFn`、`execFileFn`、`probe`、`platform`、`env`、`setTimer/clearTimer`、`onChange`、`getSettings`、`log`。

---

### 4.2 改 `main/services/tray-menu.js`（约 +14 行）

入参新增两个**可选**项：

```js
function buildTrayMenuTemplate({
  gameMode = false,
  screenshotAccelerator = '',
  hasConversation = false,
  // { running, busy } | null. Optional on purpose: every existing test builds the
  // template without it, so a required dependency would break them (see the
  // exitClickThrough precedent below).
  translationProxy = null,
  setTranslationProxyEnabled,
  executeFunction, setGameModeEnabled, openHistory, openMainWindow, showConversation, exitClickThrough, quit
} = {}) {
```

模板构造（放在 `本地搜索` 之后、与 `游戏模式` 之间）：

```js
  const proxyEntry = translationProxy && typeof setTranslationProxyEnabled === 'function'
    ? {
        label: t('main.tray.translation-proxy'),
        type: 'checkbox',
        checked: translationProxy.running === true,
        // While a transition is in flight the entry is disabled: a second click
        // cannot be distinguished from the first one, and the menu is stale until
        // the service reports back and main.js rebuilds the tray.
        enabled: translationProxy.busy !== true,
        click: () => setTranslationProxyEnabled(translationProxy.running !== true)
      }
    : null
```

插入（`[...]` 展开，`null` 时整段消失，保持旧行为）：

```js
    { label: t('main.tray.local-search'), enabled: featureEnabled, click: run('localSearch') },
    ...(proxyEntry ? [{ type: 'separator' }, proxyEntry] : []),
    { type: 'separator' },
    { label: t('main.tray.game-mode'), type: 'checkbox', checked: gameMode === true, click: () => setGameModeEnabled(gameMode !== true) },
```

> 分隔符账要算清：现状是 `local-search` → `separator` → `game-mode`。按上面写法插入后变成
> `local-search` → `separator` → `proxy` → `separator` → `game-mode`，**proxy 自带一条前置分隔线，原来那条刚好留给 game-mode**，没有重复、也没有缺失。
> 如果只插入 `proxyEntry` 而忘了那条前置分隔线，代理会跟"截图/搜索"功能组混在一起，语义就错了——这是 review 里最容易被挑出来的细节。

---

### 4.3 改 `main.js`（约 +12 行，必须同时改架构上限）

1. 顶部 require（`main.js:46` 附近）：

```js
const { createTranslationProxyService } = require('./main/services/translation-proxy-service')
```

2. 模块级变量：并入既有 `let` 区（`main.js:119` 附近）：`let translationProxyService = null`。

3. **在 `createMainWindow`/`createTrayIcon` 定义之前**（函数声明提升，位置只要在 `startApplication` 里被调用前即可）创建服务。建议紧跟 `functionRouter = createFunctionRouter({...})`（`main.js:746`）之后，因为需要 `getSettings` / `log` / `createTrayIcon`：

```js
translationProxyService = createTranslationProxyService({
  getSettings,
  log,
  onChange: () => createTrayIcon()
})
```

4. `createTrayIcon()` 的 `buildTrayMenuTemplate({...})` 里补两项（`main.js:848-850` 附近）：

```js
    translationProxy: (() => {
      const status = translationProxyService.getStatus()
      return { running: status.running, busy: status.busy }
    })(),
    setTranslationProxyEnabled: (enabled) => {
      const action = enabled ? translationProxyService.start() : translationProxyService.stop()
      action.catch((error) => {
        log('Translation proxy toggle failed:', error.message)
        dialog.showMessageBox({ type: 'warning', message: t('main.proxy.toggle-failed'), detail: error.message })
      }).finally(() => createTrayIcon())
    },
```

> `dialog` 已在 `main.js:10` 解构；`t` 需要从 `./main/services/i18n-bootstrap` 导入 `t`（现在只导入了 `setLanguage`，`main.js:94`）——**多 1 行**。弹窗文案走 i18n（`main.proxy.*`），因为它是主进程用户可见文案。
> `click` 回调不能 await（Electron 托盘回调没有 Promise 语义），所以是 fire-and-forget + `finally` 重建菜单。

5. 托盘 tooltip 带上状态（`main.js:825`，可选但强烈建议，便于自查）：

```js
  tray.setToolTip(gameMode ? 'Highlighter（游戏模式）' : `Highlighter${running ? '（翻译代理运行中）' : ''}`)
```

6. 退出：

- `before-quit`（`main.js:1286-1295`）加一句，与 `everythingService` 同风格：
  `if (translationProxyService) { translationProxyService.dispose(); translationProxyService = null }`
- `will-quit`（`main.js:1280-1285`）不需要动（dispose 是同步的，放 `before-quit` 更早、更靠前于 tray.destroy）。

7. 开机自启代理（阶段 2，可选）：在 `startApplication` 的 `if (!e2eContext.enabled) { ... }` 块内（`main.js:1221-1230`，注意 `test/e2e-contract.test.js:29` 对这个块有正则断言，别改动已有调用顺序）：

```js
    if (getSettings().proxy.autoStart) {
      translationProxyService.start().catch((error) => log('Translation proxy autostart failed:', error.message))
    }
```

8. 架构门禁（`scripts/check-architecture.js:18`）：把 `MAIN_LINE_CEILING` 从 `1300` 调到 **1330**（已落地），并更新该处注释（说明是"托盘翻译代理装配"带来的合规增量）。`test/architecture-gate.test.js:62` 只断言 `ceiling < 2173`，不会因为这次调整变红。

---

### 4.4 改 `main/services/settings-defaults.js`（新增 `proxy` 组）

放在 `system` 组之后，风格与其它组一致：

```js
  proxy: {
    autoStart: false,          // start with Highlighter; default off so tests/CI never spawn python
    port: 8080,
    host: '127.0.0.1',         // never 0.0.0.0 by default (handoff doc 7.3)
    repoDirectory: '',         // e.g. F:\workspace\Index-Translate
    scriptPath: '',            // '' => <repoDirectory>/inference/llm/call_api.py
    pythonPath: '',            // '' => py -3 -> python
    apiBase: '',               // '' => the script's own default (cloud endpoint)
    keepRunningOnExit: false   // phase 2; false = kill on quit
  },
```

**同时**在 `main/services/settings-normalize.js` 的 `normalizeFrozenSettings()` 里加归一化（这是防手改配置文件的关键）：

```js
  settings.proxy = settings.proxy || {}
  settings.proxy.autoStart = normalizeToggle(settings.proxy.autoStart)
  settings.proxy.keepRunningOnExit = normalizeToggle(settings.proxy.keepRunningOnExit)
  settings.proxy.port = normalizePort(settings.proxy.port)          // 1..65535，非法回 8080
  settings.proxy.host = settings.proxy.host === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1'
  settings.proxy.repoDirectory = normalizeText(settings.proxy.repoDirectory)
  settings.proxy.scriptPath = normalizeText(settings.proxy.scriptPath)
  settings.proxy.pythonPath = normalizeText(settings.proxy.pythonPath)
  settings.proxy.apiBase = normalizeText(settings.proxy.apiBase)
```

服务侧再兜一层：`scriptPath` 必须 `path.isAbsolute` 且 `fs.statSync().isFile()` 才 spawn（拒绝相对路径与目录，避免把用户输入当参数注入）。

---

### 4.5 i18n（`shared/locales/main.js` 一个文件、三种语言）

必须**同时**补全 `zh-CN` / `en-US` / `zh-TW` 三段，否则 `check-i18n` 的键集对称检查会报错：

zh-CN：
```js
    'main.tray.translation-proxy': '翻译代理（Index-Translate）',
```
en-US：
```js
    'main.tray.translation-proxy': 'Translation Proxy (Index-Translate)',
```
zh-TW：
```js
    'main.tray.translation-proxy': '翻譯代理（Index-Translate）',
```

失败弹窗文案（`main.proxy.*`，如果采用 §4.3-4 的弹窗）：

| 键 | zh-CN | en-US | zh-TW |
|---|---|---|---|
| `main.proxy.toggle-failed` | 翻译代理启动/停止失败 | Failed to start or stop the translation proxy | 翻譯代理啟動/停止失敗 |
| `main.proxy.port-in-use` | 端口已被其它程序占用 | The port is already used by another program | 連接埠已被其他程式占用 |
| `main.proxy.python-missing` | 未找到可用的 Python 解释器 | No usable Python interpreter was found | 找不到可用的 Python 解譯器 |
| `main.proxy.script-missing` | 找不到代理脚本 call_api.py | The proxy script call_api.py was not found | 找不到代理腳本 call_api.py |

> 键形状受 `KEY_PATTERN` 约束（`scripts/check-i18n.js:35`）：只允许小写 + 连字符分段，**不能出现大写字母**，所以是 `main.proxy.python-missing` 而不是 `pythonMissing`。

---

### 4.6 设置页（阶段 2，`config/routes/settings.js`）

在 `renderSystemSettings()`（现有 `commonSettings` 里已有 `autoStart` / `enableTray` / `gameMode` / `runLog` 四个 switch 行）下面新增一个小节：

| 行 | 控件 | 提交补丁 |
|---|---|---|
| 随 Highlighter 启动 | switch | `{ proxy: { autoStart: true } }` |
| 端口 | `type=number` | `{ proxy: { port: 8080 } }` |
| 监听地址 | select（`127.0.0.1` / `0.0.0.0`） | `{ proxy: { host: '127.0.0.1' } }` |
| 仓库目录 | 文本 + 「浏览」按钮（复用 `window.electronAPI.chooseDirectory()`，见 `config/routes/settings.js:40-41,132`） | `{ proxy: { repoDirectory: '...' } }` |
| 脚本路径 | 文本（占位提示默认相对路径） | `{ proxy: { scriptPath: '...' } }` |
| Python 路径 | 文本（留空=自动探测） | `{ proxy: { pythonPath: '...' } }` |
| 上游 API Base | 文本（留空=云端默认） | `{ proxy: { apiBase: '...' } }` |

- switch 行**必须**走既有 `switchMarkup(value, 'autoStart', 'proxy')` + `bindSwitches()`（它提交 `{ [group]: { [key]: value } }`，正好一层嵌套）。
- 文本/数字行照抄既有 `nameTemplate` 行的显式绑定写法。
- 文案键 `config.settings-system.proxy-*`，三语补齐。
- `0.0.0.0` 那行要带警告小字（隐私/局域网暴露，交接文档 §7.3）；`apiBase` 行的提示要写明"留空=网页正文经 B 站云端（交接文档 §7.4）"。
- 本机取值（供首次填写，**不要**写死进安装包默认值）：
  `repoDirectory = F:\workspace\Index-Translate`，`scriptPath` 留空，`pythonPath` 留空（PATH 已解析到 `D:\developeTools\Python\Python312\python.exe`）。

---

### 4.7 可选：`function-router` 处理器（阶段 3）

若希望代理开关也能挂全局快捷键 / 被 IPC 调用，加：

```js
    async toggleTranslationProxy() {
      const status = await getTranslationProxyService().toggle()
      createTrayIcon()
      return status.running
    },
```

`executeFunction` 开头的 `assertGameModeDisabled()`（`function-router.js:149`）意味着**游戏模式下这条路径被拒**。托盘那条路径是**直接调服务**的，与 `exitClickThrough` 同理，不受游戏模式影响（见决策 D2）。

---

## 5. 时序图（点一下到底发生了什么）

```
用户点勾选项
  → tray click → setTranslationProxyEnabled(true)
     → service.start()
        ① getStatus() 已在 starting（乐观置位）+ onChange → createTrayIcon()（菜单变灰）
        ② resolveLaunch()：脚本存在？python 可解析？
             ✗ → error + dialog（带绝对路径）→ onChange → 菜单恢复可点
        ③ probe GET / → 命中 marker？
             命中 → running/adopted（不 spawn）→ onChange → ☑
             占但非本代理 → error「端口被占」→ dialog → 菜单恢复
        ④ spawn(python, [script, --serve, 8080, --host, 127.0.0.1], env PYTHONIOENCODING=utf-8)
        ⑤ 每 250ms 探测 GET /，最长 20s（同时监听 exit / stderr）
        ⑥ 命中 → running → onChange → ☑（此时 start() resolve）
```

关闭：

```
取消勾选 → service.stop()
  → stopping + onChange（菜单变灰）
  → 校验 pid 命令行含 call_api.py
  → taskkill /PID <pid> /T /F
  → 探测至无应答（≤5s）→ idle + onChange（菜单 ☐ 且可点）
  → 仍应答 → error「端口仍被占用」+ 保持 ☑

用户直接退出 Highlighter（代理在跑）
  → before-quit → service.dispose() → taskkill /T /F（同步，不等）
Highlighter 被任务管理器强杀
  → python 残留 → 下次启动 refresh() 探测到 → 托盘显示 ☑（adopted），可关闭
```

---

## 6. 实施细节清单（易错点）

1. **管道编码**：不加 `PYTHONIOENCODING=utf-8`，横幅中文 = 乱码（实测 pipe 编码为 `gbk`）。`chcp` 对管道无效，别照抄 `.bat`。
2. **`py.exe` 杀不干净**：`child.kill()` 只杀壳。统一 `taskkill /T /F`。
3. **无优雅停机**：脚本只接 `KeyboardInterrupt`，Windows 无 SIGTERM 语义；脚本无落盘状态，硬杀安全。
4. **探测端点用 `GET /`**，不要用 `/v1/models`：后者要构造 JSON 解析，前者一行字符串即身份指纹。
5. **菜单是快照**：任何状态变化后必须 `createTrayIcon()`，否则 checkbox 显示旧值。
6. **防连点**：`starting/stopping` 时 `enabled:false`，并且 `start()`/`stop()` 自身幂等（复用 in-flight promise）。
7. **失败必须可见**：托盘本身不能弹 toast，用 `dialog.showMessageBox`（非阻塞）或系统通知；**不要**用 `showErrorBox`（阻塞模态，会把托盘体验做烂）。
8. **路径校验在 spawn 之前**：错误信息里带上被检查的绝对路径，这样"脚本没了"和"python 没了"能被一眼区分。
9. **端口占用先探测**：既避免二次实例，也给出比 `EADDRINUSE` 更可读的提示。
10. **不要动 `main.tray.game-mode` 的位置与语义**：`test/tray-menu.test.js` 与 `shortcut-ui-contract.test.js` 都按 label 找 `游戏模式` 项。
11. **`main/**` 新代码不要写中文**：会顶 `check-i18n --max 606`。
12. **模型名不要出现在代码里做默认**：本机不涉及，但别在设置默认值里写 `Index-Translate-2B/9B`（交接文档 §7.1）。

---

## 7. 测试计划

### 7.1 新增 `test/translation-proxy-service.test.js`

全部依赖注入，**不真的起 python**。建议覆盖：

| 用例 | 断言 |
|---|---|
| 启动成功 | argv = `[script, '--serve', '8080', '--host', '127.0.0.1']`；env 含 `PYTHONIOENCODING=utf-8`；`windowsHide:true`；状态 `starting→running`；`endpoint` 正确 |
| 脚本不存在 | 不 spawn；`error`；`lastError` 含绝对路径 |
| Python 解析失败 | 同上，报解释器缺失（`py -3` 与 `python` 都失败） |
| 端口被他人占用 | 探测 `occupied:true` 但 body 不匹配 → `error`，**不 spawn** |
| 冷启动收养 | `refresh()` 命中 marker → `running/adopted`，无 spawn 调用 |
| 早退 | spawn 后立刻 `exit(1)` + stderr `Address already in use` → `error` 且 `lastError` 含 stderr 片段 |
| 就绪超时 | 假计时器推进 20s → 杀树被调用 → `error` |
| 停止成功 | `taskkill /PID <pid> /T /F` 被调用；探测转为无应答 → `idle` |
| 误杀护栏 | 命令行不含 `call_api.py` → 不发 taskkill，返回失败并记日志 |
| 停止超时 | 杀掉后仍应答 → `error`，`running` 保持 true |
| dispose | 同步发杀、无异常；`idle` 时是 no-op |
| 幂等 | 连续两次 `start()` 只 spawn 一次；`busy` 为 true |

覆盖门禁：`npm run test:coverage:loaded`（`main/services/**` ≥85% 行）。新文件是纯逻辑 + 注入，达标不难。

### 7.2 扩展 `test/tray-menu.test.js`

- 注入 `translationProxy:{running:false,busy:false}` → 存在 `翻译代理（Index-Translate）` 项，`type='checkbox'`、`checked=false`、`enabled=true`；点击回调收到 `true`。
- `running:true` → `checked=true`，点击收到 `false`。
- `busy:true` → `enabled=false`。
- **不注入** → 模板里没有该项，且**不抛错**（回归保护，这条是兼容性的守门员）。

### 7.3 扩展契约测试（`test/shortcut-ui-contract.test.js` 风格）

```js
assert.match(main, /buildTrayMenuTemplate\(\{[\s\S]*setTranslationProxyEnabled/, 'the tray entry is wired in main.js')
assert.ok(DEFAULT_SETTINGS.proxy, 'the proxy group is part of the validation template')
assert.doesNotThrow(() => assertSettingsPatch({ proxy: { port: 8088 } }, DEFAULT_SETTINGS))
assert.throws(() => assertSettingsPatch({ proxy: { nope: 1 } }, DEFAULT_SETTINGS), /不支持的设置项/)
assert.throws(() => assertSettingsPatch({ proxy: { port: '8080' } }, DEFAULT_SETTINGS), /类型无效/)
```

### 7.4 必跑门禁

```powershell
cd F:\workspace\Highlighter
npm run check          # check-js + check:architecture + check:i18n
npm test               # node --test test/*.test.js
npm run test:coverage:loaded
```

### 7.5 真机验收（手动，脱离浏览器）

```powershell
# 1. 托盘勾选后
Get-NetTCPConnection -LocalPort 8080 -State Listen | Select-Object OwningProcess
Invoke-RestMethod -Uri 'http://127.0.0.1:8080/' -NoProxy          # → Index-Translate Proxy Ready
Invoke-RestMethod -Uri 'http://127.0.0.1:8080/v1/models' -NoProxy | % data | % id
# 2. 取消勾选后
Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue   # → 空
# 3. 端到端（对接交接文档 §4.2 基线）
$body = @{ model='Index-Translate-35B-A3B'; messages=@(@{role='user';content="请将以下文本翻译为英语，直接输出翻译结果，不要进行任何解释。`n`n你好，世界。今天天气不错。"}); temperature=0.0; max_tokens=256 } | ConvertTo-Json -Depth 6 -Compress
(Invoke-RestMethod -Uri 'http://127.0.0.1:8080/v1/chat/completions' -Method Post -NoProxy -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 120).choices[0].message.content
# 期望：Hello, world. The weather is nice today.   （reasoning_tokens=0）
```

---

## 8. 验收标准（DoD）

1. 托盘右键出现「翻译代理（Index-Translate）」勾选项，勾选态与 `Get-NetTCPConnection` 的真实监听状态一致。
2. 勾上 → 20s 内 `GET http://127.0.0.1:8080/` 返回 `Index-Translate Proxy Ready`；取消 → 5s 内端口释放。
3. §7.5 第 3 步返回交接文档 §4.2 的同一句译文（回归基线不变）。
4. 三类失败（脚本缺失 / Python 缺失 / 端口被占）都能在**不重启 Highlighter**的前提下恢复，并给出带绝对路径的提示。
5. Highlighter 正常退出后 `Get-NetTCPConnection -LocalPort 8080` 为空；被强杀后再启动，托盘能如实显示"仍在运行"并可从托盘关闭。
6. `npm run check`、`npm test`、`npm run test:coverage:loaded` 全绿。
7. `main.js` 行数 ≤ 新上限，且上限调整在 `scripts/check-architecture.js` 注释里有理由说明。
8. 焦点行为：**没有任何控制台黑窗弹出**（`windowsHide:true` 生效）。

---

## 9. 风险与回滚

| 风险 | 影响 | 缓解 |
|---|---|---|
| 8080 被别的程序占用 | 启动失败 | 启动前探测 + 可配置端口（设置页；插件 URL 同步改 `http://127.0.0.1:<port>/v1`） |
| 强杀 Highlighter 留下 python 孤儿 | 端口一直被占、且用户不知情 | 冷启动 `refresh()` 收养 + 托盘可关 |
| 用户把 `pythonPath` 填成 `py.exe` | `child.kill()` 杀不干净 | 统一 `taskkill /T /F` |
| 误杀用户自己的 python 服务 | 数据/任务丢失 | 杀前校验命令行含 `call_api.py` |
| `main.js` 触顶 1300 | `npm run check` 红 | 同批上调到 1320 + 注释 |
| 新增中文字面量进 `main/**` | i18n 门禁红 | 新代码英文注释，文案只进 `shared/locales` |
| 打包后用户机器没有 Python/仓库 | 功能不可用 | 设置页给出路径配置；失败弹窗明确指向缺失项；交接文档 §7.4 的隐私边界写进设置页提示 |
| 隐私误判 | 用户以为"全本地" | 设置页与文档明写：走云端路由时网页正文发往 `index-translate.bilibili.com`（交接文档 §7.4） |

**回滚**：本功能完全可加性（新文件 + 可选入参 + 默认关闭的 `proxy` 设置组 + 默认 `autoStart:false`）。回滚 = 删掉托盘那一段构造、`main.js` 的两处注入、新服务文件，并把上限调回 1300；`proxy` 设置组留着也不会被任何代码读取，无副作用。

---

## 10. 待确认的决策点

| # | 决策 | 推荐 | 备选 |
|---|---|---|---|
| **D1** | 托盘形态 | **单个 checkbox**（与游戏模式一致，最少歧义） | 两条独立项「启动代理」/「停止代理」+ 状态文本 |
| **D2** | 游戏模式下的可用性 | **不联动**（本地 HTTP 服务不干扰游戏，随时可开） | 与其它功能项一致：游戏模式时 `enabled:false` |
| **D3** | 退出 Highlighter 时 | **默认杀掉**（不留孤儿，符合"关闭即停止"的直觉） | 默认保留（`detached` + PID 文件），设置里给开关 |
| **D4** | 脚本/仓库位置 | **设置页配置**（不把开发机路径写死进安装包） | 默认写死 `F:\workspace\Index-Translate`（本机即用，但不可发布） |
| **D5** | 默认端口 | **8080**（与交接文档 §5 的插件配置一致） | 8088（交接文档里的备用口） |
| **D6** | 设置页行 | **阶段 1 就做**（否则 D4 的路径没法填，功能等于半残） | 阶段 1 先只做托盘 + 默认路径，设置页放阶段 2 |

> 如果不特别指示，实现按推荐项执行，并把 D1/D2/D3 写进代码注释。

---

## 11. 分阶段实施建议

**阶段 1（MVP，可独立验收）**
1. `translation-proxy-service.js` + 单测（TDD：先写假 spawn 的用例）
2. `tray-menu.js` 可选入参 + 单测
3. `main.js` 注入 + 架构上限 1300→1320
4. `settings-defaults.js` 的 `proxy` 组 + `settings-normalize.js` 归一化
5. i18n 三语 + 契约测试
6. `npm run check` / `npm test` / 真机 §7.5

**阶段 2（可用性）**
7. 设置页行（D6）+ 路径浏览按钮 + `autoStart`
8. 冷启动 `refresh()` 收养 + 失败弹窗文案完善
9. 主窗口显示代理状态（如走 IPC，需在 `main/services/ipc-security.js` 的 surface 白名单里登记 —— 这一条要先读 `IPC_SURFACES` 的约定再动）

**阶段 3（可选）**
10. `function-router` 的 `toggleTranslationProxy` + 快捷键登记（`settings-defaults.shortcuts`）
11. 设置页/主窗口一个「翻译服务」卡片：实时状态 + 一键复制沉浸式翻译的四项配置（`http://127.0.0.1:8080/v1` / `Index-Translate-35B-A3B` / 任意 Key / 频率 3~5）

---

## 12. 附录 A：文件改动汇总

| 文件 | 类型 | 行数量级 | 说明 |
|---|---|---|---|
| `main/services/translation-proxy-service.js` | 新增 | ~220 | 生命周期 + 探测 + 杀树 + 收养 |
| `main/services/tray-menu.js` | 修改 | +14 | 可选 `translationProxy` / `setTranslationProxyEnabled` |
| `main.js` | 修改 | +12 | require / 建服务 / 注入托盘 / `before-quit` / autoStart |
| `main/services/settings-defaults.js` | 修改 | +10 | `proxy` 组 |
| `main/services/settings-normalize.js` | 修改 | +12 | `proxy` 归一化 |
| `shared/locales/main.js` | 修改 | +15 | 3 语言 × (1 托盘 + ≥1 弹窗) |
| `config/routes/settings.js` | 修改 | +30 | 设置页行（阶段 2） |
| `scripts/check-architecture.js` | 修改 | +1/-1 | `MAIN_LINE_CEILING` 1300 → 1320 |
| `test/translation-proxy-service.test.js` | 新增 | ~260 | 注入式单测 |
| `test/tray-menu.test.js` | 修改 | +30 | 托盘项契约 |
| `test/shortcut-ui-contract.test.js` | 修改 | +10 | main.js 注入 + 设置校验契约 |

## 13. 附录 B：上游事实速查（改代码时会用到）

```powershell
# 启动（交给托盘后就不需要手敲了）
python F:\workspace\Index-Translate\inference\llm\call_api.py --serve 8080 --host 127.0.0.1
# 身份探测（服务模块用的就是它）
Invoke-RestMethod -Uri 'http://127.0.0.1:8080/' -NoProxy        # Index-Translate Proxy Ready
# 端口归属 / 命令行（杀进程护栏用的就是它）
(Get-NetTCPConnection -LocalPort 8080 -State Listen).OwningProcess
(Get-CimInstance Win32_Process -Filter "ProcessId=<pid>").CommandLine
# 手动杀
taskkill /PID <pid> /T /F
```

- 脚本单文件兜底下载：`https://raw.githubusercontent.com/bilibili/Index-Translate/main/inference/llm/call_api.py`
- 沉浸式翻译填法：`http://127.0.0.1:8080/v1` / `Index-Translate-35B-A3B` / 任意 Key / 频率 3~5
- 红线：模型名只填 `Index-Translate-35B-A3B`；不擅自加 `--host 0.0.0.0`；如实说明云端隐私边界（交接文档 §8）

---

## 14. 变更记录

| 时间 | 动作 |
|---|---|
| 2026-10-16 | 勘察 Highlighter 托盘/settings/i18n/门禁实现与本机 Index-Translate 脚本行为（含 Python 管道编码实测），产出本方案；未写代码 |
| 2026-10-16 | 六个决策点按推荐项确认并完成三阶段开发，见 §15 实施记录 |

---

## 15. 实施记录（2026-10-16，代码已落地）

### 15.1 实际改动清单

| 文件 | 类型 | 实际内容 |
|---|---|---|
| `main/services/translation-proxy-service.js` | 新增 约 480 行 | 状态机 / spawn / 就绪探测 / 杀树 / 收养 / dispose；**全英文**（i18n 门禁只剩 1 行余量）；错误带 `code` 供上层映射文案 |
| `main/services/proxy-bridge-controller.js` | 新增 约 152 行 | 失败弹窗策略、托盘重建、`proxy:status` 广播、`autoStart` / `keepRunningOnExit` 策略 |
| `main/services/tray-menu.js` | 修改 | 可选 `translationProxy` / `setTranslationProxyEnabled` + 菜单项 |
| `main.js` | 修改 1320 行（上限 1330） | require、控制器装配、托盘两项、tooltip、`before-quit` dispose、启动收养与 autostart、`app:get-proxy-status` |
| `main/services/function-router.js` | 修改 | `toggleTranslationProxy` 处理器 + `getProxyBridge` 懒取 |
| `main/services/settings-defaults.js` | 修改 | `proxy` 组 8 个字段 + `shortcuts.toggleTranslationProxy` |
| `main/services/settings-normalize.js` | 修改 | `proxy` 归一化（端口/主机白名单/文本）+ 新快捷键键 |
| `main/services/ipc-security.js` | 修改 | `app:get-proxy-status` 登记到 main surface |
| `main/ipc/app-ipc.js` | 修改 | 该通道的 handle |
| `preload.js` | 修改 | `getProxyStatus()` + `onProxyStatus()` |
| `scripts/check-architecture.js` | 修改 | 上限 1300 → 1330 + 理由 |
| `shared/locales/main.js` | 修改 | `main.tray.translation-proxy`、`main.proxy.*`（3 语言 × 11 键） |
| `shared/locales/config.js` | 修改 | `config.function.toggle-translation-proxy*`、`config.settings-system.proxy-*`（3 语言 × 31 键） |
| `config/routes/home.js` | 修改 | `functionGroups.other` 新增代理开关（热键页与快捷功能页自动出现） |
| `config/routes/settings.js` | 修改 | 「翻译服务」卡片：状态 + 启停 + 自动启动 + 端口/地址/路径/上游 + 复制配置 |
| `test/translation-proxy-service.test.js` | 新增 | 29 个用例 |
| `test/proxy-bridge-controller.test.js` | 新增 | 16 个用例 |
| `test/tray-menu.test.js` | 修改 | +5 个代理菜单项用例 |
| `test/shortcut-ui-contract.test.js` | 修改 | +4 组契约断言 |
| `test/ipc-module-contracts.test.js` | 修改 | 新通道纳入既有通道清单 |

### 15.2 与方案的偏差（都是有意的）

1. **多了一个 `proxy-bridge-controller.js`**：`main.js` 只有 3 行余量，把"弹窗 + 托盘重建 + 状态广播"留在装配层会直接顶死上限。拆出后 `main.js` 只增加约 16 行（实测 1320），并且这段 UX 策略变成可单测的纯逻辑。
2. **上限一步到位调到 1330**（方案里写的是 1320）：阶段 2/3 还要加 IPC 访问器与路由注入，一次调够比两次"挤牙膏"更清楚。
3. **错误文案改为"错误码 → i18n 键"映射**：`check-i18n` 的未迁移中文只剩 **1 行**余量（605/606），所以服务层错误信息一律英文 + `code`，用户可见文案由 `proxy-bridge-controller.js` 通过 `main.proxy.*` 键渲染。
4. **`menuState(settings)` 接受设置快照**：`createTrayIcon()` 已经在事件上被调用，而 `SettingsService.getSettings()` 每次都会解密凭据；传快照避免托盘重建时二次读取。
5. **服务层改为探测驱动 + 收养**：`start()` 先探测再 spawn，`refresh()` 在启动时收养上一次强杀残留的代理，`stop()` 失败后重新探测而不是猜测状态。
6. **杀进程护栏**：收养来的 pid 必须先校验命令行包含 `call_api.py`，否则拒绝（照 `everything-service.js` 的镜像比对思路）。

### 15.3 验收命令

```powershell
cd F:\workspace\Highlighter
npm run check                  # check-js + check:architecture + check:i18n
npm test                       # node --test test/*.test.js
npm run test:coverage:loaded   # main/services/** 行覆盖 >= 85%
```

真机验收见 §7.5；托盘行为基线见 §8。

### 15.4 验证结果（2026-10-16 实跑）

| 检查 | 结果 |
|---|---|
| `npm run check` | ✅ 304 个 JS 文件语法通过；`architecture-check: ok (main.js 1323 lines, ceiling 1330)`；i18n 三语 1050 键、键集对称、未迁移中文仍为 **605/606**（新代码零中文） |
| `npm test` | ✅ **1055 / 1055 通过**（新增 45 个用例；`config-icon-contract` 的函数计数 26→27 随新增快捷功能同步） |
| `npm run test:coverage:loaded` | ✅ 行覆盖 **92.8%**（12427/13390，门禁 85%）；两个新模块单文件均 > 90% |
| 真机端到端（真实 python + 真实上游） | ✅ `GET /` → `Index-Translate Proxy Ready`；`/v1/models` → 3 个模型；`/v1/chat/completions` → **`Hello, world. The weather is nice today.`**（与交接文档 §4.2 基线逐字一致），`reasoning_tokens=0`；状态迁移 `idle → starting → running → stopping → idle`，停止后端口立即释放，无残留进程 |
| 中文横幅解码 | ✅ `PYTHONIOENCODING=utf-8` 生效，启动横幅中文不乱码 |
| 真实 Electron 启动（隔离 user-data） | ✅ 主进程无异常；OCR / 划词钩子 / Everything 正常；`Tray.setContextMenu` 未抛错 |
| 真实 `Menu` 渲染 + 点击链路 | ✅ 菜单 17 项（13 标签 + 4 分隔线），`翻译代理（Index-Translate）` 为 `checkbox`/`checked: true`/`enabled: true`，位置在「本地搜索」与「游戏模式」之间；调用渲染后条目的 `click()` → 处理器收到 `false`（由「运行中」推导出的停止指令） |
| 环境说明 | 本机 shell 默认带 `ELECTRON_RUN_AS_NODE=1`，会让所有启动 Electron 的既有探针测试失败；**清除该变量后全绿**，与本次改动无关 |

> 未在本机执行的一步：在真实托盘上右键、用鼠标点一下新条目（需要 GUI 交互且会占用主屏）。托盘模板的构建、渲染与点击回调已在真实 Electron 运行时验证，用户重启 Highlighter 后右键即可确认。

### 15.5 安装包与静默安装记录（2026-10-16）

**构建**

```powershell
cd F:\workspace\Highlighter
# 原生二进制（SmartSelect/OcrSidecar/Everything）均已比其源码新（srcNewer=False），
# 且本次未改任何 native/ 代码，因此跳过 prebuild:win 的原生重编译，直接打包。
npx electron-builder --win nsis --x64 --publish never
```

产物：`dist\Highlighter-Setup-3.0.0.exe`，144 814 369 字节，
SHA256 `DA1DFD29E69BB59B358A6C25C3079F6DB76A56C88B11FAD7403DFE00D05739F6`。

**静默安装（关键坑）**

本机已安装版位于 `D:\Program Files\Highlighter`，但注册表卸载项的 `InstallLocation`
**是空的**，所以 electron-builder 的 NSIS 不会复用它 —— 不传 `/D=` 会静默装到默认目录
`%LOCALAPPDATA%\Programs\Highlighter`，变成**两份安装**。

```powershell
$setup  = (Resolve-Path 'dist\Highlighter-Setup-3.0.0.exe').Path
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $setup
# NSIS 要求 /D= 放在最后且**不能加引号**（即使路径含空格）。
# 用 Start-Process -ArgumentList 数组也可以，但不要自己给参数加引号。
$psi.Arguments = '/S /D=D:\Program Files\Highlighter'
$psi.UseShellExecute = $false
[System.Diagnostics.Process]::Start($psi).WaitForExit()
```

- `build/installer.nsh` 的 `customCheckAppRunning` 会按 `$INSTDIR\Highlighter.exe`
  精确匹配并**先优雅关闭、再强杀**正在运行的旧版，且**静默安装永远不会被对话框卡住**
  —— 但它依赖 `$INSTDIR` 正确，所以 `/D=` 必须传对。
- 该文件的 `customInit` 会先删掉旧的 `UninstallString`，避免旧卸载器把自己判为“正在运行”
  而卡住升级；安装结束会重写卸载项。
- 静默安装不会自动启动应用（`runAfterFinish` 在静默模式下不生效）。

**验证**

| 检查 | 结果 |
|---|---|
| 安装目录 | `Highlighter.exe` / `resources\app.asar` 时间戳更新为构建时刻；`%LOCALAPPDATA%\Programs\Highlighter` **未创建**（无重复安装） |
| 安装后 asar | 含 `translation-proxy-service.js`、`proxy-bridge-controller.js`、`main.proxy.tooltip-running`、`config.settings-system.proxy-port`、`toggleTranslationProxy`、`PYTHONIOENCODING` |
| 卸载项 | `Highlighter 3.0.0` / `UninstallString` 已重写 |
| 启动 | 新会话 `installType: nsis`，OCR / 划词钩子 / Everything / 主窗口全部就绪，无异常 |
| 真实设置库 | `E:\document\highlighter\config\config.json` 出现 `proxy` 组（8 个默认字段），`system` 组未被改动 |

> ⚠️ 本机 shell 默认带 `ELECTRON_RUN_AS_NODE=1`。用它启动 Electron 应用会让 Electron
> 以纯 Node 运行，进程**静默退出且不写日志**（表现为“装了但打不开”）。启动 GUI 前必须
> `Remove-Item Env:ELECTRON_RUN_AS_NODE`。

> ⚠️ 首次使用需在设置里补一项：`设置 → 系统设置 → 翻译服务 → Index-Translate 仓库目录`
> 填 `F:\workspace\Index-Translate`（或用“浏览”选择），否则点击托盘条目会提示
> “找不到代理脚本 call_api.py”。仓库目录留空时服务**不会**猜测路径。
