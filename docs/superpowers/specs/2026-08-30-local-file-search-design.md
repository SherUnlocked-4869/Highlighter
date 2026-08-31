# 本地文件搜索（Everything）设计

- 日期：2026-08-30
- 状态：已实现（MVP）
- 关联：`docs/local-search-integration-progress.md`

## 目标

为 Highlighter 提供启动器式的本地文件搜索能力，复刻 ZTools「本地搜索Neo」插件的核心体验：
全局快捷键唤起、Everything 毫秒级全盘搜索、分类过滤、键盘操作、打开/定位文件。
不搬运插件本体（其运行时依赖 `contextIsolation:false` 等与 Highlighter 安全模型冲突），改为原生复刻通信协议 + 重写 UI。

## 架构

```
search/ 窗口 (vanilla JS)  ⇄  preload-search.js (searchAPI)
        ⇄  secureIpcMain（IPC_SURFACES role: 'search' 白名单）
        ⇄  main/ipc/search-ipc.js
        ⇄  main/services/everything-service.js（进程管理 + 查询缓存 + 状态机）
        ⇄  native/everything-search/HighlighterEverything.exe（Rust 侧车，JSON-lines over stdio）
        ⇄  Everything.exe（复用已运行的；否则启动内置便携版）
```

## Rust 侧车（native/everything-search）

依赖：`windows 0.62` + `serde_json`（Everything IPC 协议自研实现，协议布局对照
everything-ipc crate 源码与 voidtools 官方 `EVERYTHING_IPC` 头文件核实）。

JSON-lines 协议：请求 `{id, action, ...params}` → 响应 `{id, ok, result?, error?}`。

- `status` → `{running, dbLoaded, version, instance, probeTotal}`
- `wait-ready {timeoutMs}` → 内部 300ms 轮询直至就绪
- `query {search, maxResults, sortMode, matchPath, timeoutMs}` → `{total, items:[{name, path, fullPath, extension, size, modifiedAt(epoch ms), highlightedName, highlightedPath}]}`
- `probe-all`（诊断）→ 枚举所有候选窗口与各自的探测结果
- `shutdown` → 侧车退出

### 关键设计决策（由本机实测驱动）

1. **多实例枚举与择优**：多个 Everything 实例可同时注册窗口类
   `EVERYTHING_TASKBAR_NOTIFICATION*`（如用户自装 1.4/1.5a 与其它工具拉起的便携实例）。
   `FindWindow` 只会命中其一，可能是索引为空的实例。侧车用 `EnumWindows` 枚举全部候选，
   对每个候选做三重探测（WM_USER 版本可达性 / WM_USER 401 DB 标志 / WM_COPYDATA 探测查询
   `*.exe`），按「探测有内容 > 可达且已加载 > 仅可达」打分择优。
2. **UIPI 兼容**：Everything 以管理员运行时，非提权进程的 `WM_USER` 探测被 UIPI 拦截，
   而 `WM_COPYDATA` 放行（官方 SDK 生态均如此）。因此就绪判定以探测查询为权威信号：
   `ready = 窗口存在 && (dbLoaded || probeTotal > 0)`。
3. **回复窗口线程**：隐藏回复窗口跑在独立线程（GetMessageW 泵）。转发查询时**不得**使用
   `SMTO_BLOCK`（会阻塞处理入站 sent 消息，同步回文永远收不到）；回复可经重入（同步）或
   消息泵（异步）两条路径送达，等待方以 `recv_timeout` 兜底并支持取消。
4. **高亮**：Everything 1.5 的 highlighted 字段以 `*` 环绕命中词（协议另支持 `\x1F`），
   渲染层同时兼容两种标记；无高亮数据时回退为 JS 关键词朴素高亮。

## EverythingService（main/services/everything-service.js）

- 仿 `OcrService`：按需启动侧车、JSON-lines pending/超时管理、空闲自动停止（120s）、
  查询 LRU 缓存（24 条）与进行中请求合并（`await ensureReady()` 之后二次检查 inFlight，
  规避并发首查竞态）。
- 状态机：`idle → checking → (waiting | starting) → ready | error`，每次变更通过
  `onStatusChange` 推送给搜索窗口。
- Everything 进程管理：
  - 复用优先：侧车 `status` 显示已运行且索引就绪 → 直接使用。
  - 兜底启动：未运行且设置允许时，把 `native/everything/`（Everything.exe + 干净 ini）
    拷贝到数据目录 `runtime/everything/` 后以
    `Everything.exe -startup -config Everything.ini`（detached、windowsHide）启动。
  - 只杀自启：应用退出时先校验进程 `ExecutablePath` 与自启 exe 一致再 `taskkill /T /F`，
    绝不误杀用户自装的 Everything（`processProbe`/`runCommand` 可注入，测试覆盖三种分支）。

## 搜索窗口（search/）

- 无边框、840×620、单例，居中于**光标所在显示器**，失焦自动隐藏，快捷键再按切换显示。
- 初始化握手与 recognition 窗口一致：`search:ready` → 主进程回 `search:init`
  （mainColor/dark/search 设置）→ `show + focus`。
- 查询：60ms 防抖；分类规则拼接（`ext:` / `folder:` 等，裸扩展名列表自动归一化，含空格的
  规则视为自定义语法直通）；matchPath 开启时普通关键词做「文件名 + 路径」双查询合并去重
  （路径分隔符关键词仅查路径）；单次 600 条上限（可设置 100-2000）、每页 30 条滚动增量加载。
- 结果行：主进程 `app.getFileIcon` 按扩展名 LRU 缓存图标（失败回退 CSS 扩展名徽标）；
  名称/路径高亮；大小与本地时间展示；悬停显示「打开所在目录 / 复制路径」。
- 键盘：↑↓ 选择、Enter 打开、Ctrl+Enter 定位、Tab/Shift+Tab 切分类、Esc 关窗；
  任意位置打字自动聚焦输入框。
- 打开/定位仅经主进程 `shell.openPath` / `shell.showItemInFolder`，主进程校验绝对路径与
  空字节；窗口导航已被 `window-security` 全局封禁。

## IPC 面（IPC_SURFACES role 'search'）

- handles：`search:query` `search:status` `search:ensure-ready` `search:open-path`
  `search:reveal-path` `search:copy-path` `search:file-icon` `settings:update`
- listeners：`search:ready` `search:close`
- 主窗口（main role）额外允许 `search:status`（设置页展示 Everything 运行状态）。

## 设置

`DEFAULT_SETTINGS.search`：`matchPath`（默认开）、`maxResults`（600）、`pageSize`（30）、
`sortMode`（modified-desc）、`useBundledEverything`（true）、`categories`（10 个内置分类，
可在设置页增删改，支持自定义规则）。搜索窗口内的 matchPath/排序改动实时回写设置
（经 `settings:update`），设置变更由主进程推送 `search:settings-changed` 同步回窗口。

`DEFAULT_SETTINGS.shortcuts.localSearch` 默认 `Alt+F`，可在热键设置中修改。

## 打包

- `build.files` 增加 `search/**/*`、`preload-search.js`。
- `extraResources`：`native/everything-search/bin → native/everything-search`（侧车）、
  `native/everything → native/everything`（Everything.exe + Everything.ini，约 2.2MB）。
- `build:native` 链增加 `build:everything`（cargo release 构建）。

## 测试

- `test/everything-service.test.js`：注入假侧车/假 spawn，覆盖启动共享、查询归一化与缓存、
  并发合并、就绪状态机、兜底启停、路径校验后杀进程、空闲停止、陈旧退出隔离。
- `test/search-utils.test.js`：分类规则归一化、查询拼接、双查询规划、结果合并去重、
  高亮解析（`*` 与 `\x1F`、奇数标记回退）、朴素高亮、大小/时间格式化。
- `test/ipc-security.test.js` / `test/ipc-module-contracts.test.js`：频道计数与归属更新。

## 风险与后续（二期候选）

- 内置 Everything.exe 的公开发布需核对 voidtools 分发条款；设置可关闭兜底并在窗口内引导安装。
- 文件预览面板（文本/PDF/图片/媒体）、悬浮预览、压缩包目录树、多选批量、右键菜单全量动作、
  拖拽发出、划词工具条集成（选中文本 → 搜文件）。
- 侧车查询串行执行（Everything 单回复窗口限制），60ms 防抖下体验无感知；若未来需要并发，
  可按请求拆分多个回复窗口。
