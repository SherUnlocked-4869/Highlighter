# 本地搜索（Everything）集成 — 进度文档

> 更新时间：2026-08-31（实施完成）
> 任务：把 ZTools「本地搜索Neo」插件的 Everything 全盘搜索能力原生复刻进 Highlighter
> 设计文档：`docs/superpowers/specs/2026-08-30-local-file-search-design.md`

---

## 一、总体进度

| # | 阶段 | 状态 |
|---|------|------|
| 1 | 前期调研（ztools 插件实现 / Highlighter 架构 / everything-ipc crate） | ✅ 完成 |
| 2 | Rust 侧车 `native/everything-search`（编译 + 实测真实查询通过） | ✅ 完成 |
| 3 | `main/services/everything-service.js` + 单测（15/15） | ✅ 完成 |
| 4 | search 窗口 UI（html/css/js/utils）+ preload-search.js | ✅ 完成 |
| 5 | IPC 安全表 + search-ipc.js + main.js 集成（窗口/快捷键/托盘/退出清理） | ✅ 完成 |
| 6 | config 设置页 + 分类管理 | ✅ 完成 |
| 7 | 内置 Everything 兜底（1.4.1.1028 x64 exe + 干净 ini） | ✅ 完成 |
| 8 | package.json 打包配置 + 测试契约更新 + search-utils 单测 + 设计文档 | ✅ 完成 |
| 9 | 全量测试 + e2e 视觉验收（截图存于 `test-results/local-search/`） | ✅ 完成 |

### 视觉验收结论（e2e 截图人工检查）

- **initial.png**：深色主题正确应用，10 个分类页签渲染，空态文案、状态栏
  「Everything 已就绪 · v1.5.0.1414」、匹配路径开关与排序下拉均正常。
- **results.png**：真实查询「package.json」返回结果行，Shell 文件图标、橙色命中高亮
  （名称+路径）、右对齐大小/本地时间、底部「已加载 600 / 共 8006 条结果」。
- **settings.png**：设置页「本地搜索」路由完整（运行状态/打开窗口/匹配路径/结果上限/
  内置兜底开关/分类编辑器）。

## 二、已批准方案（摘要）

- **通信**：Rust 侧车 CLI（`native/everything-search/`），JSON-lines over stdio（与 OCR 侧车同模式），底层走 Everything 的 WM_COPYDATA 窗口消息 IPC
- **范围**：核心搜索 MVP（搜索框 60ms 防抖、分类页签 ext: 规则、排序、matchPath 双查询合并、键盘导航、打开/定位/复制路径、文件图标、状态栏）；预览面板等二期再做
- **入口**：全局快捷键（默认 `Alt+F`）唤起独立搜索窗（失焦隐藏、再按切换）+ 托盘菜单项
- **Everything 来源**：优先复用已运行的，检测不到时自动启动内置便携版（设置可关）

## 三、已完成的关键调研结论

### 3.1 ztools 插件实现方式（逆向 + 源码）
- 插件 = Vue3 渲染层 + Rust 原生模块 `addon.node`（基于开源 crate `everything-ipc`，MIT）
- `addon.node` 导出：`query(search, maxResults, sortMode, matchPath)`、`isRunning`、`isDbLoaded`、`exit` 等
- 进程策略：先探测运行中的 Everything；没有则 spawn 内置 `Everything.exe -startup -config Everything.ini`；退出时只杀自己启动的（先 IPC exit，再校验 exe 路径后 taskkill）
- 查询逻辑：`分类规则 + 关键词` 拼接（如 `ext:xls;xlsx`、`folder:`）；关键词含 `\` 或 `/` 自动匹配路径；开关开启时普通词做双查询合并去重；60ms 防抖、单次 600 条、每页 30 条增量

### 3.2 Highlighter 架构（集成点）
- 每功能一个窗口目录 + 根级 `preload-*.js`；所有 IPC 频道必须登记在 `main/services/ipc-security.js` 的 `IPC_SURFACES`（否则 `assertComplete()` 抛错）
- 新 IPC 必须走独立模块（`main/ipc/search-ipc.js`），`test/ipc-module-contracts.test.js` 会断言 main.js 不直接注册
- 设置白名单：新设置节必须加入 `main.js` 的 `DEFAULT_SETTINGS`（`settings-validation.js` 按 defaults 模板逐键校验）
- 快捷键：`DEFAULT_SETTINGS.shortcuts` + `executeFunction` case + `config/config.js` 的 `functionGroups` 三处
- 打包白名单：`build.files` 需加入新窗口目录与 preload；侧车走 `extraResources`

### 3.3 everything-ipc crate（0.1.4，MIT）
- 支持 Everything 1.4/1.5；`EverythingClient`（WM 模块）+ `IpcWindow::with_instance`
- `RequestFlags` 原生支持 `HighlightedFileName/HighlightedPath`（高亮可由 IPC 直接返回）
- `SearchFlags::MatchPath`、`Sort` 全量枚举、`EVERYTHING_IPC_IS_DB_LOADED`（WM_USER 命令 401）

## 四、本机实测发现（影响架构的关键事实）

1. **本机 Everything 拓扑**（多实例 + 服务共存）：
   - `Everything` 服务（SYSTEM，无窗口）常驻
   - ztools 插件拉起的 **1.5.0.1414b** 实例（默认实例窗口类 `EVERYTHING_TASKBAR_NOTIFICATION`，非提权）当前在跑
   - 用户自装 **Everything 1.5a**（存在 `%APPDATA%\Everything\Everything-1.5a.ini`），其实例名为 `1.5a`，窗口类名带 `(1.5a)` 后缀；UI 当前未运行
2. **UIPI 限制**：跨完整性级别（非提权 → 提权 Everything）时 `WM_USER` 探测（版本/DB 标志）被拦截，只有 `WM_COPYDATA` 查询放行 → 就绪判断必须以**探测查询**为权威信号，不能只信 dbLoaded 标志
3. **FindWindow 单窗口不可靠**：多个实例可能同时注册同一窗口类，第一个被找到的可能是索引为空的实例 → 必须 `EnumWindows` 枚举全部候选并用探测查询（`*.exe`）选出有真实索引内容的那个
4. **探测查询结果**（修复后实测）：`*.exe` 探测命中 9478 条；`package.json` 查询 total=8006，返回的 `name/path/extension/size/modifiedAt/highlightedName/highlightedPath` 全部正确
5. **高亮格式**：Everything 1.5 返回的 highlighted 字段用 `*` 环绕命中词（如 `*package.json*`），渲染层解析时需同时兼容 `\x1F` 标记

## 五、已产出代码

### 5.1 `native/everything-search/`（Rust 侧车，v2 自研实现）✅
- **v1**（基于 everything-ipc crate）：编译通过但实测暴露两个问题——无法选择多实例窗口（FindWindow 命中空索引实例）、SMTO_BLOCK 收不到回复 → 推倒重写
- **v2**（当前版本，仅依赖 `windows 0.62` + `serde_json`，自研协议实现）：
  - `EnumWindows` 枚举所有 `EVERYTHING_TASKBAR_NOTIFICATION*` 候选窗口
  - 每个候选做三重探测：WM_USER 版本（是否同权限可达）、WM_USER 401（DB 标志）、WM_COPYDATA 探测查询（`*.exe`，是否有真实索引内容）；按"有内容 > 可达且已加载 > 仅可达"打分选优
  - 自建隐藏回复窗口（独立线程 + GetMessageW 泵 + pending 任务槽）；WM_APP 转发 WM_COPYDATA，**不带 SMTO_BLOCK**（关键修复：让线程在等待期间继续处理入站 sent 消息，回文才能被送达），回复可同步（重入）或异步（泵送达）两种路径均覆盖
  - 自解析 QUERY2/LIST2 二进制协议（布局已对照 crate 源码与官方 SDK 头文件核实），输出与 ztools 插件 addon 相同结构：`{total, items:[{name, path, fullPath, extension, size, modifiedAt(epoch ms), highlightedName, highlightedPath}]}`
  - JSON-lines 动作：`status` / `wait-ready`（轮询直至"窗口存在且（dbLoaded 或探测有内容）"）/ `query` / `probe-all`（诊断用）/ `shutdown`
- `build.ps1`：cargo release 构建 → 复制到 `bin/HighlighterEverything.exe`（当前约 360KB）

### 5.2 `main/services/everything-service.js`（代码已写，待补单测）🔶
- 仿 `OcrService`：按需启动侧车、JSON-lines 请求 pending/超时管理、空闲自动停止（120s）、查询 LRU 缓存 + 进行中合并
- Everything 进程管理：`ensureReady` 单飞（检测 → 等索引 → 启动内置兜底 → 30s 超时报错引导）、状态机（idle/checking/waiting/starting/ready/error）+ `onStatusChange` 回调
- 只杀自启进程：spawn 内置 exe 到数据目录 `runtime/everything/`（拷贝 exe+ini），停止时经 PowerShell 校验进程 ExecutablePath 后 taskkill（`processProbe`/`runCommand` 可注入便于测试）
- `spawn`、`processProbe`、`runCommand` 均可注入，单测无需真实进程

## 六、当前状态 / 剩余事项

**已全部实现**（详见设计文档 `docs/superpowers/specs/2026-08-30-local-file-search-design.md`）：
- 侧车 ready 握手消息、status 带 `probeTotal`（索引内容量诊断）
- EverythingService 就绪短路缓存（2s）+ not-running 自愈重检测 + 并发查询合并竞态修复
- search 窗口完整 UI（防抖/分类/双查询/高亮/图标/键盘/增量加载/设置回写）
- main.js 集成（单例窗口、光标屏居中、e2e 副屏定位、blur 隐藏、Alt+F 快捷键、托盘、
  before-quit 清理、文件图标 LRU、路径校验）
- config 设置页（状态/matchPath/上限/内置兜底开关/分类编辑器/打开搜索窗口）
- 打包配置（build:everything 进 build:native 链、files+extraResources 白名单）
- 契约测试更新（ipc-security 106 频道计数、ipc-module-contracts、config-icon-contract 14/22）
- e2e 用例 `e2e/local-search.spec.js`（窗口唤起→查询→分类切换→Esc 隐藏→设置页）

**剩余**：e2e 运行结果确认与截图人工检查（副屏显示，符合 AGENTS.md 要求）。

## 七、风险与待确认项

- **当前运行实例索引波动**：晚上 ~23:30 首测时该实例索引为空（只有卷条目），数十分钟后探测已有 9478 个 exe——1.5b 实例可能在后台重建索引；服务端逻辑不受影响，但验收时若搜不到东西应先排除索引未就绪
- **内置 Everything 分发**：打包 voidtools 的 exe 公开发布前需核对分发条款；设置提供开关，未检测到 Everything 时窗口内显示安装引导
- **Windows-only**：侧车仅 Windows（仓库本就 Windows-only，AGENTS.md 无跨平台要求）
- **测试窗口摆放**：按 AGENTS.md 要求，后续 e2e/人工验收窗口需放到副屏（`positionAutomationWindow` 已有现成机制，search 窗口创建时会接入）

## 八、协议备忘（侧车 ↔ 主进程）

请求：`{"id": "<uuid>", "action": "status|wait-ready|query|probe-all|shutdown", ...params}`
响应：`{"id", "ok", "result", "error"}`；`error = {code, message}`，code ∈ `not-running / send-failed / no-reply / timeout / bad-request / bad-reply / unknown-action`
query 参数：`search`(string), `maxResults`(1..2000, 默认600), `sortMode`(`modified-desc|modified-asc|name-asc|name-desc|path-asc|path-desc|size-asc|size-desc`), `matchPath`(bool), `timeoutMs`(≤15000)
wait-ready 参数：`timeoutMs`(≤120000，默认30000)；返回 `{ready, elapsedMs, status}`
