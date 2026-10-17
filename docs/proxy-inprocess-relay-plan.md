# 代理改造方案：从「外部 Python 脚本」改为「主进程内置中继」

> **文档类型**：改造方案（先方案后编码，**本文不含代码改动**）
> **上游依据**：`F:\workspace\Index-Translate`（commit `9aff74ca`，Apache-2.0，无 NOTICE 文件）
> **前置文档**：`docs/proxy-bridge-tray-integration.md`（托盘集成，已落地并装机）
> **决策依据**：用户已选定「方案 C：Node 主进程内置中继」
> **状态**：待评审；文末 §14 有 7 个决策点待确认

---

## 0. TL;DR

把现在「托盘 → spawn `python call_api.py --serve` → 云端」这条链路，换成「托盘 → **主进程内 `node:http` 中继** → 云端」。

**对外行为零变化**：托盘那个 checkbox、设置页卡片、`function-router` 快捷键、IPC/状态广播、i18n 文案全部不动 —— 只换底层实现。收益：

| 收益 | 说明 |
|---|---|
| **彻底不需要 Python** | 干净机器装完即用。这是本次改造的**唯一硬目标** |
| 消掉一整类故障 | 解释器探测、`PYTHONIOENCODING` 编码坑、`taskkill /T /F`、强杀后的孤儿收养、20s 启动超时、命令行误杀护栏 —— 全部不再需要 |
| 顺带修掉已知坑 | 交接文档 §7.1 的「`/v1/models` 多报 2B/9B」在自研中继里自然消失 |
| 可测性 | 用真实 `http` 服务器（本机临时端口）做端到端断言，不再需要注入假 spawn |
| 装机体积 | +0 字节（脚本模式保留时 +23KB 可选） |

代价：这段中继逻辑由我们自己维护，失去与上游的**字节级一致性**。

**不变量（三处硬约束，见 §10）**：`main.js` 只能再增 7 行；`main/` 下**不能新增任何中文**（i18n 未迁移配额 605/606）；新模块必须自带测试以维持 `main/services/**` 85% 行覆盖。

---

## 1. 为什么改（动机与证据）

1. **Python 是真正的瓶颈，不是仓库路径。** 我在上一轮已实测证明 `call_api.py` 单文件即可运行（复刻到空目录、从 `C:\Windows` 启动、翻译成功），所以「把脚本打进安装包」只解决了**配路径**，没有解决**装解释器**。目标若定为"装完就能用"，就必须去掉 Python。
2. **这一个脚本不值得为它维护子进程生命周期。** 现在 `main/services/translation-proxy-service.js` 里 ~480 行，其中约 2/3 是在处理"它不是我们进程的一部分"：解析解释器、探测就绪、编码、杀进程树、收养孤儿、防误杀。变成进程内代码后这些**全部消失**。
3. **中继逻辑本身极小。** `--serve` 路径的功能清单（§4 逐条列出）只有 4 个路由 + 两处 payload 注入 + 一次流式转发，约 200 行 Node 即可等价实现且更好（CORS 覆盖更全、错误更清楚）。
4. **上游已经给了参考实现并且可再分发**：Apache-2.0、无 NOTICE、来源固定（commit `9aff74ca`），我们的实现是它的派生，需要在文档/关于页注明来源。

---

## 2. 现状盘点：保留什么、替换什么

| 文件 | 现状 | 本次处理 |
|---|---|---|
| `main/services/translation-proxy-service.js`（587 行） | spawn python 的完整实现 + 状态机 | **拆为三件**：公共契约、脚本后端（原样迁移）、**新 facade** |
| `main/services/proxy-bridge-controller.js`（157 行） | 失败弹窗、托盘重建、`proxy:status` 广播 | **不动**（只多认一个错误码） |
| `main/services/tray-menu.js` | checkbox 菜单项 | **不动** |
| `main.js` | 装配 + 启动收养 + `before-quit` dispose | **基本不动**（≤2 行） |
| `main/services/function-router.js` | `toggleTranslationProxy` | **不动** |
| `main/services/settings-defaults.js` / `settings-normalize.js` | `proxy` 组 8 字段 | **加 `mode` 字段**（+ 归一化） |
| `config/routes/settings.js` | 「翻译服务」卡片 | **加一行模式选择**，其余行加"仅外部脚本模式"提示 |
| `shared/locales/{main,config}.js` | 三语 42 键 | **新增约 8 键**（三语） |
| `test/translation-proxy-service.test.js`（29 用例） | 测脚本后端 | **改名**为 `proxy-script-backend.test.js`，只改 require 与工厂名 |
| `test/proxy-bridge-controller.test.js`（16 用例） | 用 stub service | **不动** |

**关键点**：现有 29 个用例的价值不会浪费 —— 它们验证的是"外部脚本模式"这个仍然保留的高级路径（§5.3）。

---

## 3. 目标与非目标

**目标**
- G1 默认零依赖：不需要 Python、不需要仓库、不需要任何人工路径配置
- G2 托盘/设置/快捷键/IPC 的**对外契约与现状完全一致**
- G3 用真实 HTTP 做端到端可测（含流式）
- G4 保留「外部脚本」为可选高级模式（逃生舱，见 D1）

**非目标**
- ❌ 不做模型推理，不做本地 vLLM 集成
- ❌ 不改沉浸式翻译侧的任何配置流程
- ❌ 不做多上游负载均衡/重试队列
- ❌ 不改 `--host 0.0.0.0` 的安全语义（仍默认回环）

---

## 4. 必须先固化的上游行为规格

下表是我逐行读 `call_api.py` 得到的 `--serve` 行为。**左列是上游现状，右列是我们内置中继应取的行为**（差异处都标了理由）。

| # | 上游行为（行号） | 内置中继 | 理由 |
|---|---|---|---|
| 1 | `OPTIONS` → `200` + `ACAO:*` / `ACAM:GET,POST,OPTIONS` / `ACAH:*` / `ACAMax-Age:86400`（303-309） | 同 | 浏览器扩展预检必需 |
| 2 | `GET /v1/models`、`/models` → 三个 id：35B-A3B、2B、9B（311-326） | **只报 `Index-Translate-35B-A3B`** | 交接文档 §7.1：上游实际只有 35B，选 2B/9B 必然 `Model not found`。**这是修坑**（见 D2） |
| 3 | 其它任意 `GET` → `200 text/plain "Index-Translate Proxy Ready"`（327-332） | `GET /` → 同；其余 → `404` + CORS | 就绪探测仍用 `/`（`probeProxy` 不变）；不该把拼错的路径伪装成成功 |
| 4 | `POST` 路径必须以 `/chat/completions`、`/completions`、`/responses` 结尾，否则 `404`（**且不带 CORS 头**，335-338） | 同路径判定，但 **404 也带 CORS** | 跨域下没有 CORS 头，插件读不到错误体，排错困难 |
| 5 | 注入 `chat_template_kwargs.enable_thinking=false`（仅在缺省时），`temperature=0.0`（仅在缺省或 `null` 时）（343-354） | **完全同规则** | 这是代理存在的核心价值：抑制 CoT，实测 `reasoning_tokens=0` |
| 6 | JSON 解析失败则**原样转发**（353-354 `except: pass`） | 同 | 别把非 JSON 请求搞挂 |
| 7 | 转发到 `api_base.rstrip('/') + 同一后缀`（356-366） | 同 | 客户端发 `/v1/completions` 不会被悄悄改写成 chat |
| 8 | 仅带 `Content-Type: application/json` + `User-Agent: Index-Translate-Client/1.0`（367-374） | 同（UA 保持不变） | UA 是上游 WAF 的规避手段，别改 |
| 9 | 不透传 `Authorization`（交接文档 §7.2） | 默认仍不透传；**可选开关**留给自建/付费端点（D5） | 保持现状最安全 |
| 10 | 上游超时 120s（380） | 同 | |
| 11 | 上游 `HTTPError` 也当正常响应转发状态码（381-383） | 同 | 4xx/5xx 原样透传 |
| 12 | 响应头只透传 `content-type`/`cache-control`/`content-encoding`/`retry-after`（391-393） | 同白名单 + **总是加 CORS** | 白名单避免把上游的 `set-cookie`/`server` 泄给页面 |
| 13 | `Connection: close` + `read1(4096)` 循环边读边写（388,397-403） | 用 `pipe()` 做流式回传（带背压） | 等价且更省内存；SSE 逐块到达，插件体验一致 |
| 14 | 上游失败：响应头已发则直接断开；否则 `502 {"error": ...}`（404-418） | 同（502 带 CORS 与 JSON） | |
| 15 | `ThreadingHTTPServer`（420） | `http.createServer`（Node 天然并发） | |
| 16 | `--host`/`--port`：默认 `127.0.0.1:8080`（454-468） | 沿用设置里的 `host`/`port` | |
| 17 | 启动横幅 + 配置指南打到 stdout（423-432） | 改为写 `app.log` 一行（无控制台可言） | |

**额外需要处理的**（上游没有，因为它是独立进程）：
- **绑定失败**（`EADDRINUSE`/`EACCES`）要映射成 `port-in-use` / 新错误码 `listen-failed`；
- **客户端中途断开**要销毁上游请求，避免连接泄漏；
- **`0.0.0.0` 绑定会触发 Windows 防火墙弹窗**（进程内监听比 python 更明显），设置页提示要保留"建议保持 127.0.0.1"。

---

## 5. 目标架构

### 5.1 模块划分

```
main/services/proxy-contract.js           新增 ~90 行   ← 共享词汇：状态、错误码、常量、回环探测
main/services/proxy-relay-backend.js      新增 ~210 行  ← 内置中继（本方案的产物）
main/services/proxy-script-backend.js     迁移 587 行   ← 现有 spawn 实现原样搬家，改名
main/services/translation-proxy-service.js 重写 ~130 行 ← facade：按 mode 选后端，对外 API 不变
```

依赖方向：`facade → backend → contract`；`controller/router/main.js` 只认 facade。

### 5.2 对外契约（必须逐字保持，tray/controller/router 都依赖它）

```js
createTranslationProxyService(deps) -> {
  getStatus(settingsOverride?),   // { state, running, busy, adopted, pid, port, host,
                                  //   endpoint, lastError, lastErrorCode, changedAt, mode }
  start(), stop(), toggle(),      // Promise<status>，幂等，进行中返回同一个 promise
  refresh(),                      // Promise<status>，探测/对账，不 spawn
  dispose()                       // 同步尽力停止，供 before-quit
}
```

`mode` 是**新增状态字段**（`'builtin' | 'script'`），设置页用它显示"内置中继 / 外部脚本"。既有字段语义不变。

### 5.3 两种模式

| | `builtin`（默认） | `script`（可选高级） |
|---|---|---|
| 实现 | `proxy-relay-backend.js` | `proxy-script-backend.js`（现有） |
| 依赖 | 无 | Python 3 + `call_api.py` |
| 需要配置 | 无（可选改端口/上游） | `仓库目录` 或 `脚本路径` |
| 状态机 | `idle → starting → running → stopping → idle`（**没有孤儿，没有收养**） | 现有五态 + 收养 |
| `refresh()` | 对账自身：`server.listening` | 探测端口，收养残留 python |
| `dispose()` | `closeAllConnections()` + `close()` | `taskkill /T /F` |
| 适用 | 99% 用户 | 想用上游新版脚本、自定义中继、或 `--api-base` 指向自建端点 |

> 保留 `script` 的理由：它是**逃生舱**。若上游加了新端点而我们没跟，用户可以切回脚本模式自救，不需要等我们发版。代价是保留约 480 行已验证代码与 29 个测试 —— 而这些成本**已经付过了**。

### 5.4 内置中继状态机与就绪判定

**关键简化**：`server.listen()` 回调即就绪，**取消轮询探测**。这直接删掉了 20s 启动超时、250ms 轮询、`awaitReady()` 一整套逻辑。

```
idle ──start()──► starting ──'listening'──► running
                     │                        │
                     │ EADDRINUSE             │ stop()/dispose()
                     ▼                        ▼
                   error ◄──────            stopping ──► idle
```

`starting` 窗口只有一次事件循环（微秒级），但状态字段照旧提供，保证托盘"进行中禁用"的行为一致。

---

## 6. 内置中继详细设计（伪代码级）

```js
function createProxyRelayBackend({ getSettings, log, onChange, probe }) {
  let server = null
  let state = idle, actualPort = null, lastError = '', lastErrorCode = ''

  async function start() {
    if (state === running) return getStatus()
    if (inFlight) return inFlight                       // 幂等
    const { port, host, apiBase } = resolve()           // 默认 8080 / 127.0.0.1 / 云端
    setState(starting)
    server = http.createServer((req, res) => handle(req, res, { apiBase }))
    try {
      await listen(server, port, host)                  // 失败 → EADDRINUSE/EACCES
      actualPort = server.address().port
      setState(running)                                 // ← 就绪即监听成功
    } catch (error) {
      server = null
      setState(error, error.code === 'EADDRINUSE' ? 'port-in-use' : 'listen-failed', ...)
      throw ...
    }
  }

  function stop() {                            // 同步部分 + 异步收尾
    if (!server) return idle
    setState(stopping)
    server.closeAllConnections?.()             // 掐掉 SSE 长连接，否则 close() 永不回调
    server.close(() => setState(idle))
  }

  function dispose() {                         // before-quit：必须同步
    const s = server; server = null
    if (!s) return false
    try { s.closeAllConnections?.(); s.close() } catch {}
    return true
  }
}
```

### 6.1 请求处理

```
OPTIONS *                  → 200 + CORS 全套
GET  /                     → 200 text/plain  "Index-Translate Proxy Ready"   ← probe 契约
GET  /v1/models | /models  → 200 JSON {object:list,data:[{id:35B,object:model}]} + CORS
POST …/chat/completions    → forward(upstream, '/chat/completions')
POST …/completions         → forward(upstream, '/completions')
POST …/responses           → forward(upstream, '/responses')
其它                       → 404 + CORS（JSON 错误体）
```

### 6.2 `forward()` 的边界条件（逐条对应 §4 的第 5-14 行）

```js
const raw = await readBody(req)                 // 有上限，例如 32MB，超限 413
let body = raw
try {
  const payload = JSON.parse(raw.toString('utf8'))
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    if (!payload.chat_template_kwargs || typeof payload.chat_template_kwargs !== 'object')
      payload.chat_template_kwargs = {}
    if (!('enable_thinking' in payload.chat_template_kwargs))
      payload.chat_template_kwargs.enable_thinking = false
    if (payload.temperature === undefined || payload.temperature === null)
      payload.temperature = 0
    body = Buffer.from(JSON.stringify(payload), 'utf8')
  }
} catch { /* 非 JSON：原样转发 */ }
```

- **不转发**客户端的 `accept-encoding`/`content-length`，自己按重算后的 body 设 `content-length`
- 上游响应：`writeHead(status, whitelist(headers) + CORS)` 后 `upstreamRes.pipe(res)`
- 客户端 `aborted` → `upstreamReq.destroy()`；上游 `error` → 未发头则 502 JSON，已发头则 `res.destroy()`
- 上游 `setTimeout(120_000)` → destroy 并记日志

### 6.3 状态字段

```js
{ state, running, busy, adopted: false, pid: null, mode: 'builtin',
  port: actualPort ?? configuredPort, host,
  endpoint: `http://127.0.0.1:${port}/v1`,
  lastError, lastErrorCode, changedAt }
```

`pid: null`（进程内，没有独立 PID），`adopted` 恒 `false`。

---

## 7. Facade 设计

```js
function createTranslationProxyService(deps) {
  const mode = () => getSettings()?.proxy?.mode === 'script' ? 'script' : 'builtin'
  const backendFor = () => (mode() === 'script' ? scriptBackend : relayBackend)()

  // start/stop/toggle/refresh/dispose 全部转发给当前后端；
  // 跨模式切换时：先 stop 旧后端，再 start 新后端（由 start() 内部处理）。
  // getStatus() 统一补上 mode 字段。
}
```

要点：
- **`main.js` 零改动**（工厂名与导入路径不变）→ 架构门禁不受影响；
- `proxy-bridge-controller.js` 零改动（错误码 → i18n 的映射表只需**新增** `listen-failed` 与 `mode-mismatch`）；
- `refresh()` 需要"当前模式"判断，因此 facade 必须在每次调用时重新读取设置（不能把后端实例固化在闭包里）——**这是实现时最容易写错的地方**，要在测试里固定住。

---

## 8. 设置 / UI / i18n 变更

### 8.1 设置

```js
proxy: {
  mode: 'builtin',        // 新增：'builtin' | 'script'
  autoStart: false,
  port: 8080,
  host: '127.0.0.1',
  apiBase: '',            // 空 = 内置云端 https://index-translate.bilibili.com/v1（builtin 也生效）
  repoDirectory: '',      // ↓ 仅 script 模式使用
  scriptPath: '',
  pythonPath: '',
  keepRunningOnExit: false
}
```

- `settings-normalize.js`：`mode` 白名单化（非法值回 `builtin`）；
- 字段**不删**：删了会让老配置在补丁校验里被拒（`不支持的设置项`），且 script 模式仍要用；
- `apiBase` 语义升级：以前只给 python 用 `--api-base`，现在内置中继也认它 —— 于是**路线 B（本地 vLLM）**变成"填一个 `http://127.0.0.1:8000/v1` 即可"，比原来更简单。

### 8.2 设置页「翻译服务」卡片

新增一行**模式选择**（select：内置中继 / 外部脚本 + 说明），其余行按模式加提示：

| 行 | builtin | script |
|---|---|---|
| 模式 | — | — |
| 端口 / 监听地址 | 生效 | 生效 |
| 上游 API 地址 | 生效（空=云端） | 生效（传给 `--api-base`） |
| 仓库目录 / 脚本路径 / Python 解释器 | 灰显 + "仅外部脚本模式使用" | 生效 |
| 自动启动 / 退出后继续运行 | 生效（后者对 builtin 无意义 → 建议灰显） | 生效 |
| 状态行 | 显示"内置中继" | 显示"外部脚本" |
| 复制配置 | 不变 | 不变 |

### 8.3 i18n（三语，共约 8 键）

`config.settings-system.proxy-mode` / `-mode-builtin` / `-mode-script` / `-mode-hint` / `-script-only-hint`
`main.proxy.listen-failed`（新错误码文案）

> ⚠️ 所有用户可见文案进 `shared/locales/*`；`main/**` 里**一个中文字都不能加**（配额 605/606）。

---

## 9. 测试计划

### 9.1 新测试 `test/proxy-relay-backend.test.js`（真实 HTTP，不联网）

用 `http.createServer` 起一个**假上游**（监听 `127.0.0.1:0` 取临时端口），把 `apiBase` 指过去；被测中继也用 `port: 0` 取临时端口 → 零端口冲突、零外部依赖。

| # | 用例 | 断言要点 |
|---|---|---|
| 1 | 启动即就绪 | `start()` resolve 时 `state=running`，`endpoint` 用**实际端口** |
| 2 | `GET /` 返回 marker | 与 `probeProxy` 契约一致（托盘探测因此不变） |
| 3 | `GET /v1/models` | 只返回 `Index-Translate-35B-A3B` 一个 id |
| 4 | `OPTIONS` 预检 | 4 个 CORS 头齐全 |
| 5 | 注入生效 | 假上游收到的 JSON 里 `chat_template_kwargs.enable_thinking===false` 且 `temperature===0` |
| 6 | 不覆盖用户显式值 | 客户端传 `enable_thinking: true` / `temperature: 0.7` 时**原样保留** |
| 7 | 非 JSON body | 原样转发，不被破坏 |
| 8 | 流式 | 假上游分 3 块带延迟写入 → 客户端按序收到 3 块（证明是 pipe 而非缓冲） |
| 9 | 上游 4xx/5xx | 状态码与 `content-type` 原样透传 |
| 10 | 上游不可达 | 502 + JSON `{error}` + CORS |
| 11 | 未知路径 | 404 **且带 CORS** |
| 12 | `apiBase` 结尾斜杠 | `/v1` 与 `/v1/` 都不产生 `//` |
| 13 | 端口占用 | 先占一个端口再 start → `lastErrorCode='port-in-use'`（不是抛原始 EADDRINUSE） |
| 14 | 幂等 | 并发两次 `start()` 只监听一次 |
| 15 | `stop()` | 端口释放、可再次 `start()` |
| 16 | `dispose()` | 同步关闭；SSE 长连接也会被 `closeAllConnections` 掐断 |
| 17 | 客户端中途断开 | 假上游观察到请求被 destroy（无连接泄漏） |
| 18 | 大 body 上限 | 超限返回 413 |

### 9.2 既有测试的迁移

| 文件 | 处理 |
|---|---|
| `test/translation-proxy-service.test.js`（29） | 改名 `test/proxy-script-backend.test.js`；`createTranslationProxyService` → `createProxyScriptBackend`；`proxySettings` 加 `mode:'script'`。**用例逻辑一律不动** |
| `test/proxy-bridge-controller.test.js`（16） | 不动 |
| `test/shortcut-ui-contract.test.js` | 增加：`proxy.mode` 在默认值里、校验器接受 `{proxy:{mode:'script'}}`、拒绝非法字符串、设置页含模式行 |
| `test/translation-proxy-service.test.js`（**新，facade**） | 默认走 builtin；`mode:'script'` 时走脚本后端；`getStatus().mode` 正确；切换模式时旧后端被 stop |

### 9.3 真机验收（可全自动）

```powershell
# 用真实云端跑内置中继（不再需要 python）
node .tmp/relay-e2e.js
#  1 GET /            → "Index-Translate Proxy Ready"
#  2 GET /v1/models   → 只有 Index-Translate-35B-A3B
#  3 OPTIONS          → CORS 头齐全
#  4 POST 翻译        → "Hello, world. The weather is nice today."（交接文档 §4.2 基线）
#  5 usage            → reasoning_tokens = 0   ← 证明 enable_thinking 注入生效
#  6 停止后端口释放
```

**唯一需要人工的一步**仍是：在浏览器里点一下沉浸式翻译的「测试服务」。

---

## 10. 门禁影响（三处硬约束）

| 门禁 | 现状 | 本方案影响 | 对策 |
|---|---|---|---|
| `check:architecture` | `main.js` 1323 / 上限 1330 | facade 保持同名工厂 → **+0～2 行** | 若超，优先把装配细节挪进 facade，不轻易再抬上限 |
| `check:i18n` 未迁移中文 | **605 / 606** | 新增 `main/**` 代码**必须零中文** | 新文件注释与错误信息全英文；用户文案进 locales |
| `npm run test:coverage:loaded` | 92.8%（门禁 85%） | 新增约 300 行逻辑 | §9.1 的 18 个用例覆盖；facade 也需用例 |

---

## 11. 迁移、兼容与回滚

**升级路径（老用户）**
1. 装新版 → `settings.proxy.mode` 缺省补为 `'builtin'`，旧字段保留（不触发"不支持的设置项"）；
2. 若用户此前手工起过 python 代理且仍在跑，新版第一次勾选会得到 `port-in-use`（文案已提示改端口/关掉占用者）——**可选增强**：探测到 marker 时提示"检测到旧版代理仍占用端口"，见 D3；
3. 已配置 `仓库目录` 的用户若想继续用脚本：把模式切到"外部脚本"即可，**无需重新配置**。

**回滚**
- 轻量：`settings.proxy.mode='script'`（不改代码即回到已验证的 python 路径）；
- 彻底：恢复 5 个文件（facade/三个新模块/默认值），删除中继后端。

---

## 12. 风险与取舍

| 风险 | 等级 | 缓解 |
|---|---|---|
| 我们成为协议实现方，上游新增端点/改语义 | 中 | `script` 模式作逃生舱；中继只做透传，不解释业务 |
| 首次出现进程内监听 → `0.0.0.0` 触发防火墙弹窗 | 中 | 默认回环；设置页保留警告；把该提示写进 D4 |
| SSE/流式边界（半包、客户端提前断开） | 中 | `pipe()` 有背压；专项用例 8/17 |
| `stop()` 因长连接不回调而卡住 | 中 | 必须 `closeAllConnections()`（**易漏**，用例 16 守住） |
| `/v1/models` 由 3 个变 1 个 | 低 | 这是修坑；文档与设置页说明（D2） |
| 上游对 UA/频率有限制 | 低 | 保持原 UA；文档提示频率 3~5（交接文档 §5） |
| 端口 8080 被旧代理占用 | 低 | 可操作错误文案 + 可改端口 |

---

## 13. 分阶段实施（每步都有独立验证点）

| 阶段 | 内容 | 完成判据 |
|---|---|---|
| **P1** | `proxy-contract.js` + `proxy-relay-backend.js` + 18 个用例 | `node --test test/proxy-relay-backend.test.js` 全绿；对真实云端手跑一次翻译成功 |
| **P2** | 迁移脚本后端 + 重写 facade + 既有 29 用例改名通过 | 179 个相关用例全绿；`npm run check` 绿 |
| **P3** | 设置/归一化/设置页/i18n（三语） | 设置页可见模式选择；契约测试通过；CJK 仍 ≤606 |
| **P4** | 全量门禁 + 真实端到端 + 重打包 + 静默安装 | `npm test`/coverage 全绿；装机后**无需 Python** 即可勾选托盘并翻译成功 |

---

## 14. 待确认的决策点

| # | 决策 | 推荐 | 备选 |
|---|---|---|---|
| **D1** | 是否保留「外部脚本」模式 | **保留**（逃生舱，代码已存在，成本已付） | 彻底删除 Python 相关全部代码（少 ~480 行 + 29 用例，但断掉自救路径） |
| **D2** | `/v1/models` 返回几个模型 | **只返回 35B-A3B**（修坑） | 照抄 3 个（与上游观感一致，但继续误导） |
| **D3** | 旧 python 代理占用 8080 时 | **报 `port-in-use` 并提示可改端口** | 额外做"检测到旧代理"识别 + 一键切换/结束（+40 行与新的杀进程逻辑） |
| **D4** | 监听地址默认 | **保持 `127.0.0.1`**，`0.0.0.0` 仅手动开启并警告 | 直接移除 `0.0.0.0` 选项 |
| **D5** | 是否支持向上游透传 `Authorization` | **本阶段不做** | 加一个"上游 API Key"可选字段（指向付费/自建端点时需要） |
| **D6** | 默认端口 | **仍 8080**（与沉浸式翻译既有配置一致） | 换个不冲突的端口（需用户同步改插件地址） |
| **D7** | 脚本模式下无效的字段（`keepRunningOnExit` 等） | **灰显 + 提示** | 直接隐藏 |

---

## 15. 附录

### 15.1 改动文件汇总（预估）

| 文件 | 类型 | 行数 | 备注 |
|---|---|---|---|
| `main/services/proxy-contract.js` | 新增 | ~90 | 常量 + 错误码 + `probeProxy` |
| `main/services/proxy-relay-backend.js` | 新增 | ~210 | 内置中继 |
| `main/services/proxy-script-backend.js` | 迁移 | 587 | 现有实现，仅改工厂名与 require |
| `main/services/translation-proxy-service.js` | 重写 | ~130 | facade |
| `main/services/{settings-defaults,settings-normalize}.js` | 修改 | +15 | `mode` 字段 |
| `config/routes/settings.js` | 修改 | +20 | 模式行 + 提示 |
| `shared/locales/{config,main}.js` | 修改 | +24 | 8 键 × 3 语 |
| `test/proxy-relay-backend.test.js` | 新增 | ~420 | 18 用例 |
| `test/translation-proxy-service.test.js` | 新增（facade） | ~90 | 5 用例 |
| `test/proxy-script-backend.test.js` | 改名 | 0 | 原 29 用例 |
| `test/shortcut-ui-contract.test.js` | 修改 | +15 | 契约断言 |

`main.js` / `tray-menu.js` / `proxy-bridge-controller.js` / `function-router.js` / `preload.js` / `ipc-security.js`：**不改**。

### 15.2 与前置文档的关系

`docs/proxy-bridge-tray-integration.md` 描述的托盘集成（菜单项、控制器、IPC、i18n、装机流程）**依然有效**；本文只替换它的 §4.1（服务实现）与 §15（实施记录）中的**后端**部分。落地后需在该文档加一条指针，说明 `translation-proxy-service.js` 已变为 facade、默认不再需要 Python。

### 15.3 上游来源与许可（重新分发时的义务）

- 项目：`github.com/bilibili/Index-Translate`，commit `9aff74ca50c60873916f99269b10cd0d79237b4a`
- 许可：**Apache-2.0**，仓库内**无 NOTICE 文件**
- 内置中继是该脚本 `run_proxy_server` 的**派生实现**，因此应：
  1. 保留署名（在 `docs/` 或关于页写明"中继逻辑派生自 bilibili/Index-Translate，Apache-2.0"）；
  2. 随包提供一份 Apache-2.0 文本（若同时保留脚本模式，则脚本模式本就需要它）；
  3. 因我们**改写了**该文件，按 4(b) 在派生文件头部注明"派生自 … commit …，已改写"。

> 注意：Highlighter 当前没有第三方声明区（`about.js` 无相关内容，`sbom.cdx.json` 只收 npm 依赖），所以这份署名要**手工安排**，不会自动出现。

---

## 16. 变更记录

| 时间 | 动作 |
|---|---|
| 2026-10-16 | 确认方案 C；完成上游 `--serve` 行为逐行核对、门禁预算核算、模块划分与测试计划，产出本方案；**未写代码** |
