# Highlighter 架构与「用量」页落点分析（task-3）

> 基线：`F:/workspace/Highlighter` @ `master` `a0cdbc2`，版本 4.0.0（`package.json:3`）。本任务只读，未改产品代码。
> **数据口径（2026-10-20 用户修正）**：用量页统计的是**本机 AI 编程 CLI 工具的日志用量**（Claude Code / Codex / Gemini 等，与 TokenTracker 同口径），**不是** Highlighter 自身 AI 调用的 token；后者降级为可选后续功能，见 §6.6。
> 实测口径：`node scripts/check-i18n.js`（TOTAL 585 / 门禁 606）、`node scripts/check-architecture.js`（main.js 1324，ceiling 1330）、`coverage/coverage-summary.json`（行覆盖 91.85%）；Electron/Node 与 `node:sqlite` 用本机 `ELECTRON_RUN_AS_NODE` 探针实测（见 §8.1）。
> 关于截图：仓库与 `docs/plans/usage-migration-analysis/` 内没有用户截图文件；第 11 节的区块映射按任务书描述 + TokenTracker 源码推断，无法逐像素对位处标「未验证」。

## 0. 结论摘要

- **落点推荐 A：在设置窗口（就是主窗口 `config/config.html`）新增 `usage` 路由**，放侧栏「工具设置」组。Highlighter 只有一个设置/主窗口，路由、i18n 热切换、Nightshift token、测试契约全部现成；「用量」是只读数据页，与 `history` 路由同构，实现与导航成本最低。代价：默认内容宽约 846px，TokenTracker 的 4/12+8/12 双栏要改为「单栏 + 宽屏两栏」。
- **数据来源是外部 CLI 日志扫描**（只读）：主进程扫描 `~/.claude/projects/**/*.jsonl`、`~/.codex/sessions/**/rollout-*.jsonl`、`~/.gemini/tmp` 等；**Cursor 不可本地扫描**（TokenTracker 把 cursor 归为账号级云 API 来源，证据见 §6.1），一期应明确标注「未覆盖 Cursor」或砍掉。
- **扫描触发建议**：打开用量页时做**增量扫描**（按文件 offset + mtime/size/inode），首次在后台分批全量回填；**不要放在启动关键路径**（`startApplication` 已有启动预算与 `performanceMonitor` 指标）。主进程先用异步分块扫描，冷扫描实测超预算再考虑 `utilityProcess`/`worker_threads`。
- **持久化建议**：`<dataRoot>/usage/` 下「扫描索引 + 按日聚合 rollup（JSON，atomicWriteJson）」为 MVP；原始逐条事件 JSONL 可选。新增该目录必须改 `createDataPaths` / `MANAGED_DIRECTORIES` / 迁移复制与校验 / 对应测试，否则切换数据目录时丢历史（§7）。
- **存储选型结论**：MVP 用 **JSON 聚合 + 索引（零新依赖）**；查询复杂到会话/项目多维时再升级到 **`node:sqlite`（Electron 43.2.0 内置 Node 24.18.0，已实测可用，零打包成本）**；**不引入 better-sqlite3**（原生 addon，与仓库 `npmRebuild:false` + 预编译 N-API 政策冲突），也不为统计再开 Rust sidecar（§8）。
- **五个最可能让迁移失败的技术约束**（详见 §13）：外部日志格式/路径漂移；扫描性能与主进程阻塞；新数据目录未进 data-root 迁移清单；CSP/无构建/i18n 21 行余量/main.js 6–7 行/IPC 三处登记等既有门禁；日志正文与项目路径的隐私/体积。

## 1. 进程与窗口结构

### 1.1 `main.js` 是装配层（assembly），不是业务层

- `main.js` 只做：准备数据根与 e2e 环境（`main.js:66-68`）、初始化 store/settings/history（`:133-174`）、构造各 domain/service（`:516-770`）、注册 IPC（`:945-1181`）、建主窗口/托盘、启动与退出编排（`:1182-1322`）。
- 业务按 10 个 domain 拆出：`pin / capture / long-capture / record / recognition / search / clipboard / settings-effects / selection / data-root`，架构门禁强制存在且在 `main.js` 被 require（`scripts/check-architecture.js:26-37,90-98`）。domain 内部调用 `main/services/*`。
- `main/services/*` 放逻辑：AI（`ai/client.js`、`ai-protocol-adapters.js`）、持久化（`history-service.js`、`conversation-store.js`、`credential-store.js`）、系统（`app-logger.js`、`data-root*.js`、`diagnostics-service.js`）、安全（`window-security.js`、`ipc-security.js`）。
- `main/ipc/*.js` 是「注册 + 参数形状」薄层（`history-ipc.js:119-173`、`settings-ipc.js:11-30`、`app-ipc.js:4-15`），一律走 `secureIpcMain`（`main.js:463-476`，校验逻辑 `ipc-security.js:230-314`）。
- **硬行数门禁：ceiling 1330（`scripts/check-architecture.js:25`），当前 1324（split 计数）/1323（`wc -l`）→ 只剩 6–7 行装配余量**；源码注释自认「main.js is at a hard line ceiling」（`main.js:484-485`）。

### 1.2 窗口 ↔ 页面 ↔ preload 对照

窗口全部通过 `createLocalWindow()` 创建（`main.js:507-514`）→ `createSecureWindow`（`main/services/window-security.js:102-116`），锁定 `contextIsolation:true / nodeIntegration:false / sandbox:true / webSecurity:true / webviewTag:false`（`window-security.js:4-14`），安装导航白名单并登记窗口所有权；`main.js` 内不允许 `new BrowserWindow(`（`test/window-security.test.js:132-163`）。

| 窗口 | 页面 | preload | IPC role |
|---|---|---|---|
| 主窗口 / 设置页 | `config/config.html`（`main.js:800`） | `preload.js` | `main`（`ipc-security.js:10-58`） |
| 划词工具条 | `toolbar/toolbar.html` | `preload-toolbar.js` | `toolbar` |
| 划词结果窗 | `action/action.html` | `preload-action.js` | `action` |
| 截图覆盖层 | `capture/capture.html` | `preload-capture.js` | `capture` |
| 长截图控制/覆盖 | `long-capture/long-capture.html`、`overlay.html` | `preload-long-capture.js`、`preload-long-overlay.js` | `long-capture` / `long-overlay` |
| 贴图 | `pin/pin.html` | `preload-pin.js` | `pin` |
| 表格/二维码识别 | `recognition/recognition.html` | `preload-recognition.js` | `recognition` |
| 本地搜索 | `search/search.html` | `preload-search.js` | `search` |
| 剪贴板面板 | `clipboard/clipboard.html` | `preload-clipboard.js` | `clipboard` |
| 录屏控制/取景 | `record/record.html`、`frame.html` | `preload-record.js`、`preload-record-frame.js` | `record` / `record-frame` |

来源：`main/services/ipc-security.js:8-200`（surface 清单）、`main.js:447-461`（role→窗口所有权）。

### 1.3 设置窗口怎么创建（关键：没有第二个设置窗口）

设置页就是**主窗口**，`createMainWindow(route='home')`（`main.js:787-830`）：

- 页面 `config/config.html`，`loadFile`（`:800,814`）；`BrowserWindow`：`width:1120, height:760, minWidth:880, minHeight:620, frame:false`，`backgroundColor: windowBackdropColor(...)` 跟随主题，`webPreferences:{preload: path.join(__dirname,'preload.js')}`（`:802-811`）。未显式设 `resizable`，Electron 默认 true（用户 DPI 下实际内容宽度未实测）。
- `ready-to-show` 才 `show()`（`:815-824`）；`did-finish-load` 下发 `app:navigate` 目标路由（`:825-827`）；窗口已存在则 `show()+focus()+send('app:navigate', route)`（`:788-795`）。
- 关闭按钮只是 `win.hide()`（`main.js:1176-1180`）；托盘 `openMainWindow` 重新 `createMainWindow('home')`（`:875-876`）。
- 自绘标题栏：`frame:false` + `.titlebar{-webkit-app-region:drag}`（`config/config.css:39-44`）；最小化/关闭走 preload（`preload.js:60-61`）。
- **CSP 写在 HTML `<meta>`**（`config/config.html:5`）：`default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: file:; media-src 'self' blob:; font-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; worker-src 'none'`。全窗口同口径由 `test/window-security.test.js:132-163` 与运行时测试 `test/window-security-runtime.test.js:56-57` 强制。

## 2. 设置窗口路由体系

### 2.1 外壳与脚本装配（无框架、无构建）

`config/config.html` 是静态外壳：`aside.sidebar`（12 个 `button.nav-item[data-route]`，3 组 + home + about，`:13-31`）、标题栏（`:34-37`）、状态轨 `#statusRail`（`:42`）、`#view`（`:43`）、`#toast`（`:46`）。脚本按固定顺序用普通 `<script src>` 加载（`:53-95`）：语言表 + domain locale 表 → `shared/i18n.js`（`:53-67`）→ 跨窗口工具（`:68-71`）→ `routes/shared.js` → `model-helpers.js` → 各路由文件 → **最后 `config.js`**（`:78-95`）。原因：classic script 共享全局作用域，且 `window.configRoutes` 容器由第一个路由文件 `shared.js` 创建（`config.html:72-77`、`routes/shared.js:7`）。

### 2.2 主壳 `config/config.js`

- 路由表 `routes`：`route id -> {key, fallbackMessage?}`，`key` 是 `window.configRoutes` 上的渲染函数名（`config.js:37-50`）；标题表 `routeTitles`：route → i18n key，缺省 fallback `'Highlighter'`（`:21-30,68-69`）。
- 注册契约：`CONFIG_ROUTE_KEYS = Object.keys(routes)` 导出 `window.configRouteKeys`（`:55-56`）。**路由表 key 与路由文件的 `window.configRoutes['...']=` 必须逐字一致**，否则 `renderRoute()` 静默返回 false、页面空白（`:78-91`；测试 `test/config-routes.test.js:44-59`）。
- 导航：`navigate(route)` 设置 `currentRoute`、刷新标题/高亮、刷新状态轨、`renderRoute()`（`:58-73`）；history observer 清理、models 页签重置等特例在此（`:59-66`）。
- 事件：导航按钮 `onclick`（`:93`）；preload 推送 `onNavigate / onGameModeChanged / onHistoryChanged / onUpdateStatus / onInterfaceLanguage`（`:96-112,125-137`）。
- 语言热切换：`setLanguage()+applyTranslations()+navigate(currentRoute)` 重建当前页（`:125-137`）→ **新页面渲染必须可重复执行、不可重复叠加 document 级监听**。
- 启动：`init()` 取 settings → `applyAppearance()` → 快捷键状态 → `navigate('home')`（`:139-150`）。

### 2.3 路由文件的渲染模式

统一「**innerHTML 模板拼接 + 渲染后按 id 绑定事件**」，无框架、无虚拟 DOM：

- `home.js`：整页 `view.innerHTML`（`:61`）+ `onclick` 绑定（`:62-76`）；
- `history.js`：异步；loading 空态（`:18`）→ `Promise.all` 拉数据（`:23-31`）→ `insertAdjacentHTML` 拼统计/过滤/网格（`:64-68,168-190`）；`onclick/oninput/onchange` 赋值（`:131-162,193-215`）；`historyRenderVersion + currentRoute` 双守卫（`:13-16,36-42,105`）；
- `models-render.js`：子导航 + 三段模板，`view.innerHTML` 后 `bindModelsSubnav()` 等（`:126-137` 附近）；
- `settings.js`：多个 `<section class="section"><div class="card form-card">` 拼页（`:143`），逐控件 `onchange`（`:147-159`），开关统一 `bindSwitches()`（`shared.js:204-211`）；
- `about.js`：async 路由，由 shell 的 `fallbackMessage` 统一 `.catch(toast)`（`config.js:85-88`）；
- 共享 helper `window.configShared`：`escapeHtml/errorMessage/iconMarkup/toast/applyAppearance/updateSettings/pageHeader/switchMarkup/bindSwitches/openModal/formatBytes...`（`shared.js:243-250`），导出清单被测试逐项钉死（`test/config-routes.test.js:87-104`）；
- 文案全部 `t('config.*')`（`shared/i18n.js:77-84`），HTML 静态文案用 `data-i18n`（`:97-112`）；图标走 CSS mask `iconMarkup()`（`shared.js:24-26`，`config.css:394`），禁用 emoji（`test/design-tokens.test.js:165-184`）。

### 2.4 新增一个路由必须改的文件

| # | 文件 | 改什么 | 为什么 |
|---|---|---|---|
| 1 | `config/routes/usage.js`（新建） | `renderUsage()` + `window.configRoutes['renderUsage'] = () => renderUsage()` | 渲染与注册（模板 `config/routes/home.js:131-132`） |
| 2 | `config/config.html` | 侧栏加 `<button data-route="usage">`（建议「工具设置」组，`:25-29`）；加载 `<script src="routes/usage.js">`（`config.js` 之前） | 导航入口；测试要求磁盘路由文件与 HTML 引用集合完全相等（`test/config-routes.test.js:61-76`） |
| 3 | `config/config.js` | `routes` 加 `usage:{key:'renderUsage'}`；`routeTitles` 加 `usage:'config.route.usage'`；如需 observer 清理在 `navigate()` 加分支 | 分派与标题；漏 key 页面空白 |
| 4 | `config/icons/usage.svg`（或复用现有） | 导航图标 | 图标必须存在（`test/config-icon-contract.test.js:13-29`） |
| 5 | `config/config.css` | `.usage-*`：KPI 条、占比条、堆叠柱、热力格、紧凑表格、宽屏两栏断点 | 只消费 token，不硬编码 `--primary/--bg`（`test/design-tokens.test.js:58-75`） |
| 6 | `shared/locales/config.js` | `config.route.usage`、`config.usage.*` 三语同步 | 三语 key 集合必须完全一致（`scripts/check-i18n.js:120-135`） |
| 7 | `test/config-icon-contract.test.js` | 导航图标计数 `12 → 13`（`:27`） | 精确等值，不改必红 |
| 8 | `test/config-routes.test.js` | 自动扫描无需改；若把 helper 加进 `window.configShared`，同步 `:87-104` 清单 | 注册契约自动覆盖；helper 清单硬编码 |
| 9 | `e2e/highlighter.spec.js` | 路由渲染清单（`:110-122`）加 `['usage','用量','.usage-page']` | e2e 是唯一能发现「页面空白」的兜底 |
| 10 | `config/routes/shared.js`（可选） | 新的跨路由 helper 加入 `window.configShared` | 复用 + 测试登记 |

## 3. 渲染层硬约束（决定图表库能不能用）

### 3.1 CSP 的实际效果

| 指令 | 值 | 对 usage 页的后果 |
|---|---|---|
| `default-src` | `'none'` | 未列出的资源类型全禁 |
| `script-src` | `'self'` | 禁内联 `<script>`、禁 `eval/new Function`；只能加载应用目录内 `.js` |
| `connect-src` | `'none'` | 禁 fetch/XHR/WS：不能 CDN 取库、不能从本地 HTTP 拉数据 → **扫描结果必须走 IPC** |
| `img-src` | `'self' data: blob: file:` | 图表若用 `<img>`/data URL 可行，但没必要 |
| `font-src` | `'self' data:` | 无 web 字体（`shared/tokens.css:69-77`） |
| `style-src` | `'self' 'unsafe-inline'` | 允许行内 style（条形宽度/热力色阶），也允许 `<style>`；项目惯例外置 CSS + 行内 style 只做动态量 |
| `worker-src` | `'none'` | config 窗口不能开 worker（long-capture 单独开 `worker-src 'self'`） |

窗口安全第二道锁：`installWindowSecurity` 只允许创建时登记的本地文件 URL，`will-navigate / will-redirect / window.open` 全 deny（`main/services/window-security.js:76-100`）。

### 3.2 无打包构建、无前端依赖（但有 UMD 直载先例）

- 依赖里没有任何前端框架/图表/构建工具（`package.json:164-184`），无 vite/webpack/rollup 配置。
- **本地 npm 包 + UMD 直载有明确先例**：`dompurify` 用 `<script src="../node_modules/dompurify/dist/purify.min.js">`（`action/action.html:59`；测试 `test/window-security.test.js:109-128`）；`jsqr` 用 `<script src="../node_modules/jsqr/dist/jsQR.js">`（`recognition/recognition.html:51`；使用 `recognition/recognition.js:171-187`）。`package.json:126` 的 `"node_modules/**/*"` 会把整个 node_modules 收进安装包，**新增 npm 依赖后直接用相对路径 `<script>` 是能跑通的，不需要 bundler**。
- `vendor/` 只有 native `selection-hook`，无前端 JS；`design-demos/` 是独立 HTML 原型，**不在 `package.json.build.files`，不进安装包**（但其 `NIGHTSHIFT-IMPLEMENTATION.md` 是设计文档）。
- classic script 共享全局作用域；`shared/i18n.js` 顶层 `const t/setLanguage/...`，窗口脚本不能 `const {t}=window`（`shared/i18n.js:157-165`，会抛重复声明导致整窗脚本死掉）。

### 3.3 对「引入图表库」的决定性影响

结论：**技术上可引入（npm 依赖 + UMD 直载），但综合成本/设计一致性建议不引入，用 CSS + 内联 SVG 自绘。**

1. 不能走 CDN/懒加载：`script-src 'self'` + `connect-src 'none'`（`config.html:5`），库必须随包分发、同步加载，体积直接进主窗口首屏。
2. 必须是 UMD/IIFE 产物：没有 bundler；ESM-only 或需要构建步骤的库不可用；`sandbox:true` 渲染进程兼容性需实测。
3. 没有树摇：ECharts 全量约 1MB、Chart.js UMD 约 200KB、D3 约 280KB；主窗口 `ready-to-show` 是启动性能关键路径（`main.js:815-824`）。
4. 设计一致性成本最高：Nightshift 是「表面阶梯 + 单主色 + 状态色 + 发丝线」（`shared/tokens.css:35-115`），库默认主题与之冲突；还需手工接 `body.dark` 与用户主色 `--primary`（`shared.js:55` 运行时内联覆盖）。
5. 维护与门禁：新依赖要过 `scripts/audit-dependencies.js` 与 `test/dependency-security.test.js`；第三方全局注入 classic 作用域有命名冲突风险。

自绘映射：占比条 `<div style="width:x%">`；堆叠柱每日一根竖向 flex 列（段高 `--primary/--primary-soft/--surface-3`）；热力格 CSS Grid + 5 级 `color-mix(in srgb,var(--primary) X%,var(--surface-2))`（tokens.css 已用 color-mix）；环形建议改为分段条（若必须，内联 `<svg stroke-dasharray>`）；大数字用 `--font-mono/--font-display`（参考 `.history-stats b`，`config.css:163`）。

## 4. 设计系统：Nightshift token 语义与用法

### 4.1 `shared/tokens.css` 的语义层

| 类别 | token | 语义 / 用法 | 证据 |
|---|---|---|---|
| 表面阶梯 | `--bg / --surface / --surface-2 / --surface-3` | 由底到抬升，用阶梯而非边框/发光表达层次 | `tokens.css:38-42`；深色 `:121-124` |
| 发丝线 | `--line / --line-2` | 卡片描边/分隔线；层级提升用 `--line-2` | `:44-46` |
| 墨阶 | `--ink / --ink-2 / --muted / --faint` | 主文/次文/弱文/最弱 | `:48-52` |
| 主色 | `--primary` | 仅选中态与主操作；用户可改（运行时内联覆盖 `<html>`） | `:54-55`；`shared.js:55` |
| 派生主色 | `--primary-ink / -text / -soft / -line` | 主色上的文字/主色文字/13–14% 底/40–42% 线 | `:89-92,144-150` |
| 状态 | `--ok / --warn / --danger`（+ `-soft`） | 在线/警告/危险 | `:57-60,93-95` |
| 圆角 | `--radius`（0–20 用户可调）+ `-sm/-lg/-pill` | `shared.js:56` 内联覆盖 | `:66-67,96-98` |
| 字体 | `--font-ui / --font-display / --font-mono` | 无 web 字体；数字用 mono | `:69-77` |
| 高度 | `--shadow-1/2/3` | 抬升阴影；卡片默认 `--shadow-1` | `:79-82` |
| 皮肤 | `--skin / --skin-opacity` | 用户背景图 `.window-shell::after` | `:84-86`；`config.css:21` |

两条规则（`tokens.css:11-21`，测试 `test/design-tokens.test.js:35-56`）：① `--primary` 只在 `:root` 声明，深色模式不得重声明；② 含 `var()` 的派生 token 必须在 `:root` 与 `body.dark` 双份声明。

### 4.2 主题 / 主色 / 圆角 / 紧凑如何生效

- 主题：`applyAppearance()` 读 `settings.theme`（system 取 `matchMedia`），切 `body.dark`、`body.compact`、`body.has-skin`（`shared.js:47-62`）；`prefers-color-scheme` 变化重新应用（`config.js:113`）；深色 token 在 `tokens.css:117-169`。
- 主色：`documentElement.style.setProperty('--primary', settings.mainColor||'#e5a44c')`（`shared.js:55`；默认值 `settings-defaults.js:22`，测试 `design-tokens.test.js:111-114`）。**引用 `var(--primary)` 的图表自动跟随用户主色。**
- 圆角：`--radius = settings.borderRadius px`（`shared.js:56`），派生 `--radius-sm/lg`（`tokens.css:96-97`）；新卡片用 `var(--radius-lg)`。
- 紧凑：`body.compact #view{padding:16px}`、`.function-row{height:52px}`（`config.css:405-406`）。
- 自定义 CSS：注入 `<style id="customStyle">`（`shared.js:59-61`）。
- 设置 UI 在「通用」页（`config/routes/settings.js:123-129`，绑定 `:147-159`）。

### 4.3 `config.css` 的布局惯例与可复用件

| 惯例 | 现成样式 | 证据 |
|---|---|---|
| 外壳 | `.window-shell` 圆角 + 阴影；页面自绘 `--bg` | `config.css:20-22` |
| 侧栏 | 224px（<920px 188px）；`.nav-item` 44px；`.nav-group` 分组 | `:25-35,424-425` |
| 工作区 | `.titlebar` 48px；`#view` padding 24 滚动；`.page` max-width 980 居中 | `:39-46` |
| 页头/页签 | `.page-head`；`.tabs` 胶囊按钮组 | `:63-69` |
| 区块/卡片/空态 | `.section`、`.section-title`、`.card`、`.empty` | `:72-78` |
| KPI 数字条 | `.history-stats`：4 列、1px 间隙、mono 19px 数字、11px 标签 | `:158-165` |
| 进度 | `progress{accent-color:var(--primary)}`；`.update-progress` 8px | `:117,219` |
| 行/表格 | `.form-row` 60px、`.model-field` 150px 标签列、`.model-catalog-row` grid | `:119-128,248-254,262-264` |
| 按钮/表单/开关 | `.button/.primary/.danger/.icon-button`、`.input/.textarea/.switch` | `:102-134` |
| toast/图标 | `#toast.toast.show`；`.svg-icon` mask | `:389-390,394` |
| 响应式 | 980 折叠 models 双栏；920 收窄侧栏；760 单列/2 列统计 | `:411-447` |

**可直接复用**：`.page/.page-head/.section/.card/.tabs/.button/.empty/.toast`、`.history-stats`（改 `.usage-stats`）、`.update-progress`、`.form-row`、`.model-provider-item` 选中态。**需新写**：热力网格、堆叠柱、坐标轴/图例、大数字单位切换、日期范围选择器（history 只有搜索/来源筛选）——约 150–250 行新 CSS。

## 5. 现有数据与 IPC 约定（新功能要遵守的部分）

### 5.1 electron-store 与 settings 链路

- 单一 store：`new Store({defaults:{settings:DEFAULT_SETTINGS, captureHistory:[]}, cwd: activePaths.config})`（`main.js:133-142`）→ `<dataRoot>/config/config.json`。electron-store ^8.2.0（`package.json:167`）底层 conf 10.x 用 `atomically.writeFileSync`（`node_modules/conf/dist/source/index.js:375`），单文件写原子但每次 `set` 重写全文件。
- 读取：`getSettings()` 合并 defaults + 解密 provider key + normalize（`settings-service.js:58-78`）；渲染层拿 `getPublicSettings()`（删 apiKey，`:80-91`）。写入：`updateSettings(patch)` → `assertSettingsPatch`（`:139-150`）→ `persistSettings`（`:107-137`）。
- **settings schema 就是 `DEFAULT_SETTINGS` 字面量**：`settings-validation.js:20-33` 拒绝模板外键；`settings-defaults.js:123-128` 明说该块即校验模板。新增设置项（如「统计开关/保留月数」）必须同步改 `DEFAULT_SETTINGS` 与 normalize（`settings-normalize.js:137-157`）。
- 设置副作用表：`main/domains/settings-effects/index.js:20-114`（快捷键/主题/语言/托盘/搜索等），`main.js:955-960` 接线。

### 5.2 数据目录、写盘、日志

- 布局 `createDataPaths()`（`data-root.js:13-33`）：`config/ logs/ history/ conversations/ clipboard/ cache/ runtime/`；启动 `ensureDataLayout`（`:35-47`）。
- 迁移只搬 `config.json`、`app.log`、`history/**`、`conversations/**`、`clipboard/**`（`data-root-migration.js:405-462`）；**新顶层目录不会自动迁移**。
- 原子写：`atomicWriteJson()`（tmp + rename + backup 回滚，`data-root.js:49-79`）用于 locator/marker；截图直接 `fs.writeFileSync`（`history-service.js:280-286`），索引存 store（`:92-104`）。范例：`ConversationStore` 每会话一个 JSON、`atomicWriteJson` 可注入、schemaVersion、retention、保存失败只记日志不打断界面（`conversation-store.js:1-95`）。
- 日志：`createAppLogger` JSONL 追加 `<dataRoot>/logs/app.log`，2MB×3 轮转，`sanitizeValue` 脱敏 key 名含 token/prompt（`app-logger.js:4-13,42-104`）；受 `system.runLog` 控制（`main.js:287-296`；默认 true `settings-defaults.js:118`）。诊断包只收 `app.log*`（`diagnostics-service.js:326`）并过 sanitizer（`:79-113`）。

### 5.3 IPC 通道、preload 白名单、错误约定

- 命名 `<area>:<action>`（`history:copy-path`、`data-root:get`）。建议：`usage:status / usage:refresh / usage:summary / usage:daily / usage:breakdown / usage:sessions / usage:clear`，推送 `usage:scan-progress`。
- 渲染层只走 `window.electronAPI.*`（`preload.js:3-89`），不能 `require('electron')`（sandbox+contextIsolation）。
- **白名单 ↔ 注册精确一致**：通道必须列进 `IPC_SURFACES`（`ipc-security.js:8-200`，main 清单 `:12-58`），启动 `assertComplete()` 校验（`main.js:1181`），漏一个启动即抛（`ipc-security.js:309-313`）；`test/ipc-security.test.js:96-150` 扫描 `main.js` / `main/ipc/**` / `main/domains/**` 对账。主进程→渲染的进度推送也要登记为 `listeners`（main surface 现有 `window:minimize/window:close`，`:58`）。
- 错误约定：`throw` → invoke reject，`shared.js:19-22` 剥前缀；用户操作返回 `{canceled}` / `{ok:false,error:{code}}`（`history-ipc.js:108,143-144`）。只读查询失败建议 throw → 页面空态 + toast。
- 最适参考：`HistoryService + history-ipc.js`（`main.js:1097-1137`）；只读聚合/导出参考 `diagnostics-ipc.js`（`main.js:1059-1079`）；持久化/原子写参考 `ConversationStore` 与 `data-root.js`。**不建议为统计新建 domain**（domain 面向窗口/任务生命周期），用 `main/services/usage-*.js` + `main/ipc/usage-ipc.js`。

### 5.4 与 task-4 的关系（降级说明）

task-4 分析的是「Highlighter 自身 AI 调用的 usage 可得性」。按用户修正，这不是本页目标；本页需要的是 §6 的 CLI 日志扫描。Highlighter 自身 AI 用量可作为后续可选能力：其链路目前在 `main/services/ai-protocol-adapters.js:155-180` 丢弃 `response.usage`、流式无 `include_usage`（`:38-46`），若将来要做需按 `04-hl-ai-usage.md` 改造，**不影响本页落点**。

## 6. 新数据源：本机 AI CLI 日志扫描工程方案

### 6.1 覆盖范围与「能否本地扫描」判定

TokenTracker 支持很多 CLI/工具（`F:/workspace/TokenTracker/src/lib/*` 下按工具拆 parser，`src/commands/sync.js` 组织发现与解析）。Highlighter 一期只做**可纯本地、只读、无需登录**的子集：

| 工具 | 本地日志位置（Windows） | 一期 | 依据 |
|---|---|---|---|
| Claude Code | `%USERPROFILE%\.claude\projects\<project>\<session>.jsonl`；`CLAUDE_CONFIG_DIR` 可覆盖 | ✅ 首选 | TokenTracker `src/commands/sync.js:707-724`（`path.join(home,'.claude','projects')`）；`src/lib/scan-roots.js:36-39,64-72` |
| Codex | `%USERPROFILE%\.codex\sessions\**\rollout-*.jsonl`（另扫 `archived_sessions`）；`CODEX_HOME` 可覆盖 | ✅ 首选 | `src/commands/sync.js:811-830`；`src/cli.js:107` |
| Gemini CLI | `%USERPROFILE%\.gemini\tmp` 下会话文件；`GEMINI_HOME` 可覆盖 | ✅ 二期/视格式 | `src/commands/sync.js:1246-1260` |
| Cursor | `%APPDATA%\Cursor\User\globalStorage\state.vscdb`（TokenTracker 只从它读登录 token）；用量来自**云端 CSV/API** | ❌ **本地不可得**（按 TokenTracker 口径） | `src/lib/cursor-config.js:12-32`（路径）、`:196-231`（`fetchCursorUsageCsv/Summary`）、`src/lib/rollout.js:7528`（「Cursor's CSV is an account-level API export, not an append-only local log」）、`src/lib/source-metadata.js:1`（`ACCOUNT_LEVEL_SOURCES = ["cursor","trae-cn"]`） |

结论：**一期页面文案必须诚实标注覆盖范围**；Cursor 只能显示「需账号/暂不支持本地统计」，不能假装有数据。WSL（`\\wsl$\...`）与其它 40+ 工具属于后续扩展，TokenTracker 有完整先例但实现量大（`src/commands/sync.js` 数千行）。

### 6.2 路径发现与 Windows 约束

- 根目录 = `app.getPath('home')`（= `%USERPROFILE%`；目前 Highlighter 只在诊断里用过 `app.getPath('home')`，`main.js:409`），**不要硬拼 `C:\Users\...`**；尊重环境变量覆盖（`CODEX_HOME` / `CLAUDE_CONFIG_DIR` / `GEMINI_HOME`，参考 `scan-roots.js:46-57` 的 `expandHome`：`~` 与相对路径都锚定 home，不锚 cwd）。
- 每个根先做「可列目录探测」：`ENOENT/ENOTDIR` → 未安装；`EACCES/EPERM/EIO/ELOOP` → 权限/不可读，**不能混同为空目录**（TokenTracker `scan-roots.js:97-125` 的 `scanRootDirState` 是正确范式）。
- 跳过 symlink/junction（`lstat().isSymbolicLink()`）避免环与重复统计；用 `realpath` 去重同一目录的多个写法（`scan-roots.js` 的 `dedupeDirsByRealpath`）。Highlighter 的 data-root 校验也拒绝符号链接（`data-root.js:107-122`），口径一致。
- Windows 特有：CLI 写日志时文件被占用（共享读写一般允许读取）；杀毒软件可能短暂锁文件 → 单文件失败重试一次后跳过；>260 字符路径依赖 Node/Electron 的 long-path 支持（**未验证**）；OneDrive 重定向 home 时以 `app.getPath('home')` 为准。
- 只读保证：只用 `createReadStream`/`open('r')`，绝不写/删/改 CLI 目录文件，不装文件监控。

### 6.3 解析与增量策略（最关键）

- **增量游标**：`scan-index.json` 记录每个已扫文件的 `{size, mtimeMs, ino(fileId), offset, contribution}`；下次只从 `offset` 读新增字节（日志是 append-only 为主）。若 `size < offset` 或 `ino/mtime` 表明被重写（Codex-Manager 会原子重写 session 文件，TokenTracker `src/commands/sync.js:266-267` 有注释），则**先减去该文件旧 contribution，再整文件重扫**，避免重复计数。
- 逐行 JSON：流式按 `\n` 切分、逐行 `JSON.parse`；坏行/截断尾行跳过并计数；单行大小上限（防止一条超大 tool 结果吃内存）；UTF-8 用 fatal 解码或替换策略。TokenTracker 的 `src/lib/jsonl-lines.js:1-40` 是可直接借鉴的范式（按字节切、maxRecordBytes、oversized 标记）。
- 字段抽取：只取计数器与最小元数据：`timestamp/date`、`sessionId`（可哈希）、`model`、`source`、`input/output/cacheRead/cacheWrite/reasoning tokens`、`messageId/uuid`（用于去重）；**绝不落消息正文、tool 输出、prompt**。各 CLI 字段名与版本差异按 task-2 的解析结论对齐；Claude Code 的 assistant 消息一般带 `message.usage`，Codex rollout 的 token 事件、Gemini 会话文件字段需按实际样本验证（**未验证**）。
- 去重：`(source, sessionId, messageId)` 或 `(source, sessionId, timestamp, model)`；同一物理事件被多个文件/多安装包含时按 sessionId 去重（TokenTracker 也做多安装去重与 cursor 命名空间，`src/lib/multi-install-parser.js`）。
- 容错优先：未知事件类型、缺字段、版本变更 → 跳过该行并计入 `parseErrors`，页面仍可显示已解析数据 + 覆盖状态；解析器按 source 分模块（`main/services/usage-parsers/claude.js` 等），每个 parser 有单元测试 + 样本 fixture。

### 6.4 性能、调度与线程

- **触发**：页面首次打开 `usage:refresh` 触发增量扫描；用户可点「刷新」；可选页面可见时 60s 轮询（不强求）。**不在 `startApplication` 同步扫描**（启动路径有性能监控与首窗预算，`main.js:1182-1255`）。
- **冷启动全量回填**：后台分批进行，单次预算（时间如 1.5–2s / 字节数如 32MB / 文件数如 200），用 `await new Promise(setImmediate)` 在文件/批次间让出事件循环；可随时取消（AbortController），进度通过 `usage:scan-progress` 推送；页面显示「正在扫描 x/y」。
- **线程选择**：MVP 在主进程做异步 I/O + 分块解析（JSON.parse 是主要 CPU，但单行很小）；若实测大目录导致主进程卡顿，再迁到：
  - `utilityProcess.fork`：Highlighter 已有先例（划词 hook 宿主，`main/services/selection-hook-service.js:91-96`，`main.js:20` 引入），隔离性好、可设 `serviceName`；
  - `worker_threads`：仓库 main 侧目前**无先例**（`grep worker_threads main/` 为空），且 asar 内 worker 脚本路径需实测（**未验证**）；如用需把 worker 文件放进 `main/**/*`。
- 文件枚举：`fs.promises.opendir/readdir({withFileTypes:true})` 递归，限制深度与文件数上限（防异常目录树）；按 mtime 从新到旧优先，保证先出「最近 30 天」数据。

### 6.5 隐私与只读边界（必须写进实现）

- CLI 日志包含完整对话正文/代码/路径 → **只在内存中解析并立即丢弃正文**，落盘只有计数与最小维度；项目名建议存 basename 或用户可关（默认只显示「项目 A/B」的哈希标签），避免把敏感路径持久化。
- 提供「清除用量数据」操作（删除 `<dataRoot>/usage/` 内容）；诊断包只含 `app.log*`，默认**不包含** usage 数据（`diagnostics-service.js:326`）。
- 扫描失败/不可读只记英文日志（i18n 门禁），页面展示覆盖状态，不阻塞其它功能。

### 6.6 与 TokenTracker 的差异（范围裁剪）

TokenTracker 有 46 种 CLI parser、hook/notify 集成、云端账号与归属、pricing、项目/会话深度分析；Highlighter 一期只做 **3 个本地日志源 + 总览/模型/每日/会话四类视图**。Highlighter 自身 AI 调用用量（task-4）不属于本页目标，降级为可选后续。

## 7. 扫描结果持久化、迁移与保留

### 7.1 放哪：新增 `<dataRoot>/usage/`（推荐）

- 目录：`usage/scan-index.json`（游标/贡献/覆盖状态）、`usage/daily-YYYY.json`（按月聚合 rollup）、可选 `usage/events-YYYY-MM.jsonl`（原始计数事件，供后续会话/项目明细重算）；`usage/meta.json`（schemaVersion、lastScanAt、per-tool coverage、appVersion）。
- 为什么不是 `logs/`：迁移只复制 `app.log` 本身（`data-root-migration.js:405-412,462`），放 `logs/usage/` 会切数据目录即丢；`runtime/` 更不迁移（`data-root.js:13-33` 的 `runtime` 是运行期）。因此**正确做法是新增 managed 目录**。
- 新增目录必须同步改（缺一即漏迁移/漏清理）：
  1. `data-root.js:13-33` `createDataPaths` 加 `usage`；
  2. `data-root-migration.js:25-30` `MANAGED_DIRECTORIES`（回滚/清理清单）与迁移复制/校验（`:405-462`，尤其 `:462` 的 rename 列表；不加入 `ADDITIONAL_PERSISTENT` 或自定义复制逻辑就会**切目录即丢历史**）；
  3. 测试：`test/data-root.test.js:50-76`（完整路径断言）、`test/data-root-migration.test.js:78-123`（声明顺序的精确清理清单）、`:905` 附近的目录集断言；
  4. 若未来支持恢复默认/重置数据：加入清理动作（参考 `data-root-migration-cleanup` 的边界）。
- 备选（不推荐）：放 `config.json`（electron-store）。优点零迁移改动；缺点每次写重写全 JSON，且事件量大时不适合，只够放一个小 rollup。可作为「先出页面」的临时实现，正式版迁到 `usage/`。

### 7.2 存储形态：聚合优先

- **rollup 行**（建议）：`{date, source, model, project?, input, output, cacheRead, cacheWrite, reasoning, calls}`，按 `date × source × model × project` 聚合；project 维度做 top-N + `other` 截断，避免基数爆炸。会话明细若需要，另存 `sessions-YYYY.json`：`{sessionId, source, startedAt, endedAt, project, models[], tokens}`（sessionId 可用哈希）。
- **索引**：`scan-index.json` 体积与文件数成正比（一个用户可能几千个 jsonl），每文件约 200–300B → 1–2MB 级别，用 `atomicWriteJson` 整体写；或按 source 分文件降低写放大。
- 写盘：rollup/index 用 `atomicWriteJson`（`data-root.js:49-79`）；可选 events 用 `fs.appendFileSync`（与 `app-logger.js:88-92` 同策略）。**写失败不得影响扫描主流程**（吞错 + 一次性告警，范式同 `conversation-store.js:73-93`）。
- schemaVersion 与迁移：`meta.json` 带 `schemaVersion`；升级时旧 rollup 可重算（原始日志仍在用户 home）→ 这是聚合优先的额外好处：**Highlighter 的持久化数据是可再生的**。
- 体积/保留：按聚合计，重度用户每天几百行以内，一年约 1–5MB；事件文件才可能到几十 MB/年。保留策略建议 24 个月 + 目录上限 64MB，超额从最旧月份清理；提供「清除数据」。
- 数据根迁移时：rollup/index 都是普通 JSON，可加入迁移复制清单并做 sha256/计数校验（参考 history 的 manifest 机制 `data-root-migration.js:414-428`）。**注意**：若将来用 SQLite，WAL/SHM 必须整组 checkpoint 后复制（仓库已有同类方案文档 `docs/plans/2026-10-17-clipboard-implementation-plan.md:301-309,648`）。

### 7.3 与现有范式的关系

- `atomicWriteJson`（`data-root.js:49-79`）：rollup/index 的标准写法；
- `ConversationStore`（`conversation-store.js:1-95`）：注入式 `fileSystem/writeJson`、目录校验、retention、失败吞错——usage-store 可直接照此结构写 `main/services/usage-store.js`，纯 Node 可测；
- `HistoryService`：数据页查询 + IPC 的参考，但 usage 不需要 store 数组索引，聚合文件更适合 range 查询。

## 8. 存储技术选型：JSON 聚合 vs node:sqlite vs better-sqlite3

### 8.1 运行时事实（已实测）

- Electron 43.2.0 内置 **Node 24.18.0 / Chrome 150.0.7871.129**（`ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe` 探针）。
- `require('node:sqlite')` **可用**：导出 `DatabaseSync / StatementSync / Session / constants / backup`；实测建表、插入、聚合查询、`PRAGMA journal_mode=WAL` 全部成功，临时库清理正常，无加载警告。即：**若查询需要 SQL，可以不新增任何依赖**。
- 仓库现状：`npmRebuild:false`（`package.json:47`）；Node 侧原生模块只有 sharp/onnxruntime-node/selection-hook 三个**预编译 N-API** 产物（`docs/plans/2026-10-07-dependency-upgrade-plan.md:168`）；需要 SQLite 的既有功能走 **Rust sidecar**（`native/clipboard/Cargo.toml:10` 的 bundled rusqlite；`native/clipboard/src/storage.rs:173,207,860` 的 WAL/checkpoint；`package.json:85-92` 以 `extraResources` 分发二进制）。

### 8.2 三案对比

| 维度 | JSON 聚合 + 索引（MVP 推荐） | `node:sqlite`（升级路径） | better-sqlite3（不推荐） |
|---|---|---|---|
| 新依赖 | 无 | 无（Node 内置） | 原生 addon，需 ABI 匹配 prebuild/rebuild |
| 打包/签名 | 无影响 | 无影响 | 需 `npmRebuild`/rebuild 流程、`asarUnpack` `.node`、签名与杀软复核；与仓库现有政策冲突 |
| 体积 | 数据文件 KB–MB 级 | DB + WAL，同量级 | 二进制额外约 2–5MB（Win x64，估计） |
| 查询能力 | 内存过滤/聚合，10 万行内足够 | SQL/索引/复杂多维查询 | SQL，但同步 API 与包体无必要 |
| 主进程阻塞 | 全在内存（数据量小） | `DatabaseSync` 同步 → 需 worker/utilityProcess 或小查询 | 同步，同样需拆分 |
| 迁移 | JSON 可整组复制/校验；可从原始日志重建 | DB 文件 + WAL/SHM 整组 checkpoint 后复制（有先例文档） | 同左 + 原生模块版本管理 |
| 版本风险 | 自有 schema 可控 | Node API 稳定性随 Electron/Node 升级（`node:sqlite` 仍属实验/演进 API，**未验证**未来兼容承诺） | ABI/Electron 升级需重建 |

**结论**：一期用 JSON 聚合（零依赖、可重建、特性和页面需求匹配）；二期若做「会话/项目多维筛选 + 排序 + 大时间跨度」，直接切 `node:sqlite`（无打包成本，只是在 `main/services/usage-store.js` 内部换实现）；**不要** better-sqlite3，也**不要**为统计再开 Rust sidecar（前者违反 native 依赖政策，后者成本远高于收益）。

## 9. 测试与质量门槛

### 9.1 测试组织

- `npm test` = `node --test test/*.test.js`（`package.json:9`），147 个测试文件、纯 Node；c8 三档：loaded `--lines 85`（含 `main/services/**`、`main/ipc/**`，`package.json:14`）、native per-file 60（`:15`）、critical per-file 90（`:16`）。当前 loaded 行覆盖 91.85%。**新增 `main/services/usage-*.js` / `main/ipc/usage-ipc.js` 会进入统计，必须配单测**；`main/domains/**` 不在 c8 include（放逻辑进 domain 可规避门禁但不合分层）。
- 新测试建议：`test/usage-parsers.test.js`（每个 CLI 一个样本 fixture + 坏行/截断/重写/超大行）、`test/usage-store.test.js`（rollup 合并、增量 offset、文件重写扣减、retention、损坏文件容错）、`test/usage-ipc.test.js`（通道注册/参数形状）、`test/data-root*.test.js` 更新；用临时 home（`test/fixtures/cli-home/...`）注入 `homeDir`，不要在真实 `%USERPROFILE%` 上测。
- e2e：`e2e/highlighter.spec.js` 增加 usage 路由渲染断言；扫描服务需支持 `HIGHLIGHTER_E2E_HOME`（或注入 fake home）避免真实用户目录影响测试。

### 9.2 静态门禁会强制什么

| 门禁 | 命令 | 强制内容 |
|---|---|---|
| 语法 | `npm run check` → `scripts/check-js.js` | 根目录 + 各源码目录所有 `.js` 逐个 `node --check`（`check-js.js:6-21,32-44`）；新扫描器/路由必须是 Node 可解析 classic JS |
| 架构 | `check:architecture` | `main.js` ≤1330 行；10 domain 存在且被 require；禁止被搬走的函数（`check-architecture.js:25-98`） |
| i18n | `check:i18n --max 606` | 三语对称（`:120-135`）、key 形状（`:137-145`）、`data-i18n` key 存在（`:147-161,211-212`）、CJK 总数 ≤606（`:253-257`）。**当前 585，余量 21 行**；扫描器日志/错误文案必须英文，新路由文件不能有中文注释 |
| 安全/契约 | `npm test` | 见 §9.3 |

### 9.3 与「新增路由/扫描 IPC」直接相关的契约测试

- `test/config-routes.test.js`：dispatch key ↔ 注册双向一致（`:44-59`）；磁盘 route 文件 ↔ `config.html` 引用集合完全相等（`:61-76`）；shell 不得自带 render（`:78-85`）；`window.configShared` 精确清单（`:87-104`）。
- `test/config-icon-contract.test.js`：导航图标**精确 = 12**（`:27`），新导航项必改。
- `test/i18n-contract.test.js`：加载 i18n 的窗口必须加载自己的 domain 表（`:87-110`）；data-i18n key 三语齐全（`:67-84`）；三语对称（`:86-97`）。
- `test/design-tokens.test.js`：窗口 CSS 不硬编码 `--primary/--bg`（`:58-75`）；图标文件存在（`:211-257`）；禁 emoji（`:165-184`）。
- `test/window-security.test.js`：每个页面严格 CSP、无内联 script（`:132-163`）。
- `test/ipc-security.test.js`：`IPC_SURFACES` ↔ 全量注册精确对账（`:96-150`）；preload 通道必须有 page policy（`:167-200`）；`assertComplete` 缺注册抛错（`:281-294`）。
- `test/data-root*.test.js`：目录布局/迁移清理清单是 deepEqual（见 §7.1）。
- e2e 覆盖设置窗口：真实 Electron 启动、主窗口 `config.html`、11 条路由逐条渲染、设置持久化、诊断导出（`e2e/electron-app.js:67-96`；`e2e/highlighter.spec.js:9-35,60-103,108-133`）。

## 10. 落点方案对比

事实基线：主窗口 1120×760（`main.js:802-805`），侧栏 224（`config.css:25`），`#view` 左右 24（`:45`），`.page` max-width 980（`:46`）→ 默认内容约 **846px**，最小窗口时约 606px；历史页在此宽度用「4 列 KPI + 卡片网格」已是最高密度（`config.css:152-195`）。TokenTracker 是 12 栅格 4/12 + 8/12（`TokenTracker/dashboard/src/ui/dashboard/views/DashboardView.jsx:490-497`），需 ≥1100px 才舒展。

| 维度 | A. 设置窗口新路由（推荐） | B. 独立 BrowserWindow | C. home 加卡片 |
|---|---|---|---|
| 信息密度 | 默认 846：单栏 + 4 列 KPI；放开 `.page` 上限到 980，宽屏两栏 | 可 1280×860、min 1024，接近 TokenTracker | home 无数据页容器，放不下 |
| 窗口/Chrome | 复用现成 shell/侧栏/主题/标题栏 | 需自绘 titlebar/返回/主题；参考 search 840×620（`main/domains/search/index.js:82-93`）、recognition 820×620（`main/domains/recognition/index.js:109-120`） | 同 A，但污染首页 |
| 导航成本 | 侧栏一次点击 | 需托盘/设置页按钮/快捷键三选一（托盘模板 `main/services/tray-menu.js:63-89`），且 main.js 装配行数紧张 | 一次点击但挤掉快捷功能 |
| 实现风险 | 低：路由/i18n/token/测试全现成；主要工作量在 CSS 与扫描器 | 中高：+1 页面目录/preload/IPC role/打包白名单/locale 表/CSP 清单/e2e，约 +12 文件 | 低但产品价值低 |
| 后续扩展 | 加子 tab/子路由即可；扫描器可复用 | 最灵活（多 tab/并列窗口） | 不可扩展 |

**推荐 A + 分阶段**：一期单栏（KPI→总览大字→模型/来源占比→趋势→每日明细），窗口 ≥1200px 用 `@media` 切两栏；侧栏放「工具设置」组（与截图历史/剪贴板历史同层，`config/config.html:25-29`，符合 `docs/plans/2026-10-17-settings-ia-reorg.md:20-28` 的「同类相邻」原则）。**不急着改主窗口默认尺寸**（影响所有路由与 e2e 截图），宽屏体验交给最大化 + `page-wide`。若产品确定长期承载「用量/会话/模型排行」多页或要逐像素双栏，再把 `config/routes/usage.js` 整体搬到独立窗口（渲染函数可复用，不浪费前期投入）。

**扫描触发与落点的关系**：A 方案下页面打开即触发 `usage:refresh`，扫描/缓存生命周期跟随主窗口进程，最简单；B 方案需要额外处理「窗口关闭时取消扫描」「重复打开复用缓存」，收益不抵成本。

## 11. 与用户截图的信息架构映射建议

TokenTracker 侧栏真实分组（`TokenTracker/dashboard/src/ui/components/Sidebar.jsx:39-73`）：常规（用量/会话/限额/排行榜/成就）、工具（小组件/桌面宠物/技能/IP 检查/服务状态）、账户（云服务/设置）。

| TokenTracker 项 | Highlighter 建议 | 说明 |
|---|---|---|
| 用量（Dashboard） | **保留 → 新路由 `usage`** | 本任务目标 |
| 会话（Sessions） | **二期保留**（扫描数据天然有 sessionId） | Claude/Codex 日志按会话组织，可做「会话数、每会话 tokens、Top 会话」；需按 task-2 对齐 session 字段 |
| 项目用量 | **二期可选** | Claude 的 `projects/<project>` 目录、Codex 的 cwd 可提供项目维度；注意项目名脱敏/top-N 截断 |
| 限额（Limits） | **砍** | 依赖云端订阅/配额；本地无法知道账单上限 |
| 排行榜 / 成就 | **砍** | 需云端多用户 |
| 小组件 / 桌面宠物 / 技能 / IP 检查 / 服务状态 | **砍** | 与 Highlighter 产品定位不符 |
| 云服务 | **砍** | Highlighter 无自有云账号 |
| 设置 | **合并进现有设置组**（最多在「系统与数据」加统计开关/清除数据） | 主题/主色/圆角已在「通用」 |

页面区块（按 task-1 截图映射：左上 KPI 4 卡、模型占比、热力图、趋势柱、性价比卡、右栏大字总览+进度条、provider 占比卡、每日明细/项目表）：

| 截图区块 | 建议 | 实现/落点 |
|---|---|---|
| 左上 4 KPI | **保留**，4 列 `.usage-stats`（复用 `.history-stats`，`config.css:158-165`） | 近 7 天 tokens / 近 30 天 tokens / 日均 / 调用数（或会话数） |
| 模型占比列表 | **保留**：主色占比条 + Top N 模型行 | `--primary/--primary-soft` 分段 |
| 热力图 | **二期**（需按日事件；一期用近 30 天迷你柱替代） | CSS Grid + color-mix；日期边界用本地时区 |
| 趋势柱状图 + 预测 | **保留简化版**：近 14/30 天堆叠柱，不做预测 | 预测需要算法与足够历史，MVP 承诺不了 |
| 性价比/交付成本卡 | **砍** | 依赖 TokenTracker 的 `/outcomes` 等 opt-in 数据，Highlighter 无 |
| 右栏 TOKEN 大字 + 时段切换 | **保留**，作为页面顶部总览 | 大数字 `--font-display/--font-mono`；时段用现成 `.tabs`（`:66-69`） |
| provider 占比卡 | **保留**（按 CLI 来源/模型两组） | 来源 = Claude/Codex/Gemini；可复用 `.model-provider-item` 样式（`:230-239`） |
| 每日明细表 | **保留**（核心价值） | 列：日期、总 tokens、输入、输出、缓存、调用数；行高按 `.form-row` 收紧 |
| 项目用量 tab / 分享 / 云同步 / 设备筛选 / 安装命令卡 / 订阅徽章 | **全部砍**（项目 tab 二期可选） | 依赖云/多设备或与桌面工具无关 |

**布局建议（A 下）**：默认单栏：页头 + 时段 tabs → 4 列 KPI → 大字总览 + 分段占比条 → 来源/模型占比 → 趋势柱 → 每日明细表；≥1200px 切「左 4/12（KPI、热力、趋势）+ 右 8/12（总览、占比、明细）」两栏，对齐 TokenTracker 的栅格意图。**必须显示覆盖状态**：哪些 CLI 已检测到、哪些不可用（尤其 Cursor）、上次扫描时间与错误，避免「页面为空=功能坏了」的误解。

## 12. 改动清单（文件级）

### 12.1 A 方案（推荐）：设置窗口 `usage` 路由 + 本机日志扫描

| 层 | 文件 | 动作 |
|---|---|---|
| 页面 | `config/routes/usage.js`（新建） | `renderUsage()`：子 tab（总览/每日/会话）、日期范围、刷新按钮、扫描进度、覆盖状态；异步用 `currentRoute` + 版本号守卫（照 `history.js:13-42`）；注册 `window.configRoutes['renderUsage']` |
| 页面 | `config/config.html` | 导航按钮 `data-route="usage"`（工具设置组）+ `<script src="routes/usage.js">`（`config.js` 之前） |
| 页面 | `config/config.js` | `routes` / `routeTitles` 各加一行；离开 usage 时清理定时器/observer |
| 样式 | `config/config.css` | `.usage-*`：KPI 条、总览、占比条、堆叠柱、热力/迷你柱、紧凑表、≥1200px 两栏；只消费 token |
| 图标/文案 | `config/icons/usage.svg`（或复用）、`shared/locales/config.js` | 图标存在；`config.route.usage` + `config.usage.*` 三语 |
| 扫描 | `main/services/cli-usage-scanner.js`（新建） | 根发现（home + env 覆盖）、目录状态探测、遍历、增量 offset、重写检测、分块让出、进度回调；纯 Node 可测、可注入 `homeDir/fs` |
| 解析 | `main/services/usage-parsers/{claude,codex,gemini}.js`（新建） | 每个 parser：`parseLine(obj) -> event|null`、`detect(filePath)`；样本 fixture 单测 |
| 聚合/持久化 | `main/services/usage-store.js`（新建） | 读/写 `usage/` 下 index/rollup/meta；`atomicWriteJson`；range 查询；retention/clear；schemaVersion 与重建 |
| IPC | `main/ipc/usage-ipc.js`（新建）+ `main/services/ipc-security.js`（main handles/listeners 加 `usage:*`）+ `preload.js`（`getUsage*` / `onUsageScanProgress`）+ `main.js`（≤3 行装配） | 通道：status/refresh/summary/daily/breakdown/sessions/clear；推送 scan-progress |
| 数据层 | `main/services/data-root.js`、`main/services/data-root-migration.js` | 加 `usage` 目录 + `MANAGED_DIRECTORIES` + 迁移复制/校验（见 §7.1） |
| 设置（可选） | `main/services/settings-defaults.js`、`settings-normalize.js` | 「统计本机 CLI 用量」开关/保留月数（必须进 DEFAULT_SETTINGS 模板 + normalize） |
| 测试 | `test/config-icon-contract.test.js`（12→13）、`test/config-routes.test.js`（helper 清单如需）、`test/usage-parsers.test.js`、`test/usage-store.test.js`、`test/usage-ipc.test.js`、`test/data-root*.test.js`、`e2e/highlighter.spec.js` | 新增/更新 |
| 文档 | `docs/plans/...`（可选） | 与仓库习惯一致，记录 schema/迁移/隐私边界 |

### 12.2 B 方案（若选择独立窗口，额外增加）

`usage/usage.html|js|css` 页面目录（CSP 复制、无内联 script）、`preload-usage.js`、`ipc-security.js` 新 surface `{role:'usage', page:'usage/usage.html'}`、`main.js` 的 `authorizeIpcRole` + `createUsageWindow` + 打开入口（托盘/设置页按钮）、`package.json` 的 `files` 加 `usage/**/*` 与 preload、`shared/locales/usage.js`（三语 + 窗口加载顺序）、`test/window-security.test.js` CSP 清单、`test/i18n-contract.test.js` 的 `WINDOW_AREAS`、`e2e/electron-app.js` 窗口查找；`main.js` 行数需抬 ceiling 或把装配塞进现有 domain。

### 12.3 与 task-4 的边界

task-4 的 Highlighter 自身 AI 用量采集**不在本清单**（可选后续）；本清单只依赖「CLI 日志扫描」这条新数据管道。

## 13. 最可能导致迁移失败的 5 个技术约束

1. **CLI 日志是外部契约，格式/路径随工具版本漂移。** Claude/Codex/Gemini 的日志结构、token 字段名、目录布局都可能变化；Cursor 按 TokenTracker 口径无本地用量日志、只有账号级云 API（`src/lib/cursor-config.js:12-32,196-231`；`src/lib/rollout.js:7528`）。解析器必须容错 + 坏行跳过 + 覆盖状态展示 + 样本 fixture 回归，否则升级一次 CLI 页面就归零；同时用户预期（截图里可能有 Cursor）与实际能力需要产品明确取舍。
2. **扫描性能与主进程阻塞。** 首次全量可能要遍历几千个 JSONL（Claude 单会话文件可达 MB 级），同步遍历/逐行 `JSON.parse` 会卡死主进程与窗口；必须增量游标（offset + contribution 扣减，防重写重复计数）、分批让出、时间/字节预算、可取消、进度推送；否则 e2e 超时、启动/交互卡顿。
3. **新持久化目录不在 data-root 迁移白名单里。** 只加 `createDataPaths` 不改 `MANAGED_DIRECTORIES` / 迁移复制与校验 / `data-root*.test.js`，切换数据目录会**静默丢历史**，回滚还会留脏目录（`data-root-migration.js:25-30,405-462`；`test/data-root-migration.test.js:78-123`）。
4. **既有渲染与门禁约束叠加。** CSP + 无打包决定了图表只能自绘或本地 UMD；i18n CJK 只剩 21 行、`main.js` 只剩 6–7 行、IPC 要三处登记且被精确对账、路由/导航图标计数被测试钉死。漏一处不是报错而是「页面空白 / 启动抛错 / 测试红」。
5. **隐私与数据体积。** CLI 日志含完整对话正文和项目路径；若把原文/原始行落盘或进诊断包，是明确的安全与合规问题；持久化又必须可控（保留月数/上限/清除）。**正确姿势：内存解析、只落计数与最小元数据、项目名脱敏、诊断包排除、提供清除**（诊断包只收 `app.log*`，`diagnostics-service.js:326`）。

## 14. 未验证 / 待确认

- **Cursor**：`cursor-agent` 是否有本地用量日志未验证；TokenTracker 明确把 cursor 视为账号级云 API 来源（`source-metadata.js:1`），因此「本地扫描 Cursor」大概率不可行，需要产品确认是「不支持」还是「接账号」。
- **各 CLI 日志字段**：Claude Code `message.usage` 的版本差异、Codex rollout 的 token 事件字段、Gemini 会话文件格式，均需按真实样本/`02-tt-data.md` 对齐后写 parser；本文只给出扫描架构。
- **`node:sqlite` 长期稳定性**：实测当前 Electron 43.2.0 可用（WAL 正常），但其 API 在 Node 侧仍属演进中能力，跨 Electron 大版本升级的兼容承诺**未验证**；一期 JSON 聚合不受影响。
- **worker_threads/utilityProcess 在 asar 内的脚本路径**：utilityProcess fork 有先例（selection-hook host），worker_threads 无先例；若冷扫描需要拆分进程，需实测打包后路径。
- **Windows 长路径 / OneDrive 重定向 / WSL（`\\wsl$`）**：未实测；一期只保证本机原生 home，WSL 明确列为后续。
- **用户截图**：仓库内无截图文件；第 11 节的区块映射基于任务描述 + TokenTracker 源码，截图版本与当前 checkout 可能不一致（`01-tt-frontend.md:78-82` 已列疑点）。
- **成本/美元估算**：截图可能含美元数字；本地 CLI 日志只有 tokens，没有统一价格与账单，若要做成本需引入版本化 pricing 表（TokenTracker 有，但属于额外数据维护），是否本期做**待产品确认**。
- **「统计开关」默认值**：默认开启（可发现）还是默认关闭（隐私优先）需产品/用户确认；无论哪种都要有清除入口。

## 15. 关键证据索引（复核用）

```bash
# 主窗口/设置窗口与 CSP
sed -n '787,830p' main.js
sed -n '1,10p' config/config.html

# 路由契约与门禁
sed -n '37,91p' config/config.js
node --test test/config-routes.test.js
node scripts/check-architecture.js
node scripts/check-i18n.js --json | head -40

# Electron/Node 与 node:sqlite（探针，不改仓库）
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe -e "console.log(process.versions);console.log(!!require('node:sqlite'))"

# TokenTracker 的 CLI 日志位置与 Cursor 账号级证据
grep -n "claude\|projects" /f/workspace/TokenTracker/src/commands/sync.js | head
grep -n "state.vscdb\|fetchCursorUsage" /f/workspace/TokenTracker/src/lib/cursor-config.js
grep -n "account-level API export" /f/workspace/TokenTracker/src/lib/rollout.js

# 数据目录迁移清单
sed -n '25,66p' main/services/data-root-migration.js
sed -n '78,123p' test/data-root-migration.test.js
```
