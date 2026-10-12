# 调研结论：划词工具栏「应用黑名单」（2026-10-08）

- 状态：**调研完成，待确认**（本文只做调研与设计，未改动任何代码）
- 需求：用户手动配置一批应用，在这些应用中不再触发划词工具栏
- 相关代码：[main/domains/selection/index.js](../../main/domains/selection/index.js)、[main.js](../../main.js)、[toolbar/toolbar-utils.js](../../toolbar/toolbar-utils.js)、[main/services/settings-defaults.js](../../main/services/settings-defaults.js)、[main/services/ipc-security.js](../../main/services/ipc-security.js)、[config/config.js](../../config/config.js)、`node_modules/selection-hook`

---

## 0. 结论摘要（TL;DR）

1. **拦截点已经存在，且位置理想。** `handleTextSelection()` 在决定是否显示工具栏之前，已经拿到了 `data.programName`，并已经有一次同类判断（自身进程过滤 `shouldFilterApp`）。黑名单只是在这里再加一个判断，**不需要改钩子、不需要改原生组件、不需要新依赖**。
2. **唯一可用的应用标识是「选择窗口所属进程的 exe 文件名」**，例如 `chrome.exe`、`Code.exe`。这是 `selection-hook` 唯一暴露的身份字段（`TextSelectionData.programName`），既不提供 PID 也不提供 HWND，因此按窗口标题、按 UWP 应用、按浏览器站点做过滤**在当前依赖下都做不到**。
3. **`selection-hook` 自带原生过滤 `setGlobalFilterMode(EXCLUDE_LIST, [...])`**，能在取词之前就把事件掐掉（省 CPU、并避免剪贴板回退的副作用）。但它的匹配语义是**大小写不敏感的子串匹配**（`"vscode.exe".find("code.exe")` 命中），用作面向用户的黑名单会造成误伤，**建议 v1 不用**（见 §3）。
4. **「添加应用」的 UX 不需要枚举进程、不需要新的原生助手**：让用户点「拾取」，然后在目标应用里随便划选一段文字，`text-selection` 事件携带的 `programName` 就是要添加的 exe。**只有当应用本身能触发划词工具时，用户才会想拉黑它**，所以这个「用真实划词事件取身份」的取数方式，与功能的失败面天然重合。同时保留手动输入 exe 名与「最近触发过的应用」列表。
5. **成本与风险都不高，但有一处硬约束**：`main.js` 目前 **1298 行，架构门禁上限 1300 行**（`scripts/check-architecture.js`）。所有新增逻辑必须落在 domain/service 里，`main.js` 只能保持净零增长——新增 IPC 通道注册走已有的 `main/ipc/selection-ipc.js`，可以做到 0 行改动。
6. 需要你拍板的点集中在一处：**黑名单语义（仅 exe 精确匹配）与首期范围（是否同时做 UWP / 白名单模式）**，见 §8。

---

## 1. 现状：划词触发链路与可用的拦截点

### 1.1 链路（已核实）

```
用户拖选文本
  → selection-hook (原生, 独立 utility 进程)
      GetProgramNameFromHwnd()  ← exe 文件名
      [可选] 全局过滤 (globalFilterMode/List)  ← 原生预过滤，当前未启用
      UIA → MSAA → 剪贴板回退 取文本
      emit 'text-selection' { text, programName, 坐标, method, posLevel }
  → selection-hook-host.js 转发 { type:'event', event:'text-selection', data }
  → SelectionHookService.handleHostEvent() → handlers.textSelection(data)
  → main/domains/selection/index.js: handleTextSelection(data)   ← 建议的拦截点
      ├─ isGameModeEnabled()          → return（既有拦截）
      ├─ processing                    → return（既有拦截）
      ├─ !data?.text                   → return
      ├─ shouldFilterApp(programName)  → return（既有拦截：Highlighter 自身）
      ├─ 长度/空白校验、动作集合、定位计算
      └─ windowManager.showToolbarSelection(...)  ← 显示工具栏
```

### 1.2 现有「同一类需求」的先例

| 先例 | 位置 | 粒度 | 复用价值 |
|---|---|---|---|
| 自身进程过滤 `shouldFilterApp` | [main.js:203](../../main.js#L203)，在 [selection/index.js:343](../../main/domains/selection/index.js#L343) 调用 | 进程名子串 | **就是本次要扩展的那一行**，语义、日志、测试范式都可直接照搬 |
| 游戏模式 `applyGameMode` | [selection/index.js:515](../../main/domains/selection/index.js#L515) | 全局开关 | 说明「抑制工具栏」已有 suspend / hide 两条路径，但它是全局的，不适合按应用 |
| 剪贴板兼容模式 `clipboardFallback` | [settings-effects/index.js:73](../../main/domains/settings-effects/index.js#L73) | 全局开关 | 说明「设置变更 → 运行时生效」已有一条成熟的注入通道 |

**结论：本需求落在既有架构的延长线上，属于「新增一个按应用过滤的判断 + 一个设置项 + 一个配置界面」，而不是新机制。**

---

## 2. 应用身份：能拿到什么、拿不到什么

### 2.1 唯一可用的标识

`selection-hook` 的实现（`node_modules/selection-hook/src/windows/lib/utils.cc:58-89`）：

```cpp
GetWindowThreadProcessId(hwnd, &processId);                       // 选区所在窗口
OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, ...);
QueryFullProcessImageNameW(hProcess, 0, path, &size);             // 完整路径
programName = 最后一个 '\' 之后的部分;                             // → 只要 exe 文件名
```

`TextSelectionData` 的全部字段见 `node_modules/selection-hook/index.d.ts:30-53`：

```
text, programName, startTop, startBottom, endTop, endBottom,
mousePosStart, mousePosEnd, method, posLevel, isFullscreen?
```

**没有 PID、没有 HWND、没有窗口标题、没有进程路径、没有 UWP ApplicationUserModelId。**

### 2.2 由此产生的边界（必须在产品文案里说清楚）

| 场景 | `programName` | 影响 |
|---|---|---|
| 普通 Win32 应用（Chrome/Edge/VS Code/Office/记事本） | `chrome.exe`、`Code.exe`… | ✅ 精确可用 |
| Electron 类应用 | 各自 exe | ✅ 可用 |
| **UWP / Store 应用**（设置、计算器、照片、邮件…） | 统一为 `ApplicationFrameHost.exe` | ⚠️ 无法逐个拉黑；拉黑它等于把**所有** UWP 应用一起拉黑 |
| 同 exe 多窗口（浏览器所有标签页） | 同一个 `chrome.exe` | ⚠️ 只能整应用拉黑，不能按站点/窗口 |
| 以管理员身份运行的应用 | 钩子受 UIPI 限制**本来就收不到选区事件** | ℹ️ 工具栏本来就不出现，无需拉黑（`selection-hook/docs/zh-CN/WINDOWS.md:147`） |
| `OpenProcess`/`QueryFullProcessImageNameW` 失败 | 空字符串 | ⚠️ 空值**不得**匹配任何黑名单项（否则会误伤一片） |

---

## 3. 方案对比

| 方案 | 位置 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| **A. 原生全局过滤** `setGlobalFilterMode(EXCLUDE_LIST, list)` | `selection-hook-host.js` → 原生 `IsInFilterList`（`engine.cc:134-149`、`216-231`） | 取词之前就返回：省 UIA/MSAA 开销；`clipboardFallback=true` 时不会为被拉黑的应用合成 Ctrl+C | ① 匹配是**子串**：拉黑 `code.exe` 会连带拉黑 `vscode.exe`、`mycode.exe`；② 需要改宿主协议（`update-options` 目前只处理 `enableClipboard`，见 `selection-hook-host.js:98-108`）；③ 设的是设备全局状态，与「按应用设置」的语义容易脱节；④ 原生二进制无法在 `node:test` 里直接验证 | **首期不用**（可作为后续性能优化项；若采用，必须接受并向用户明示子串语义） |
| **B. 域层过滤（JS）** 在 `handleTextSelection` 加判断 | `main/domains/selection/index.js:343` 附近 | 语义完全可控（可做 exe **精确**匹配）；零原生改动；可被 `node:test` 直接覆盖；日志沿用 `logSelectionDiagnosticOnce` | 取词开销照旧；`clipboardFallback=true` 的用户，被拉黑应用仍会经历一次剪贴板回退（内容会被钩子尝试还原） | ✅ **推荐** |
| **C. 白名单模式**（只在这些应用里生效） | 同 B，仅 `mode` 不同 | 对「只想在少数应用里用划词」的用户更省事 | 首期范围扩大；`INCLUDE_LIST` 语义与现有 `enabled` 开关叠加时概念变多 | 数据模型预留 `mode`，**首期只实现 blacklist** |
| **D. 原生助手枚举窗口/进程做「应用选择器」** | 新 C# 助手（仿 `native/smart-select`）或 PowerShell | 能列出「当前可见窗口 + 图标 + exe」，选择体验最直观 | 新增原生组件（`build.ps1` + `extraResources` + `prestart` + 打包体积 + 新的失败模式）；仍绕不开 §2.2 的 UWP/提升权限问题；`desktopCapturer` 的窗口源只能给出标题与图标，**给不出 exe**，所以纯 JS 方案不成立 | **首期不做**（§4.3 的「拾取」用零成本方式覆盖同样需求） |
| **E. 只让用户手输 exe 名** | 配置页输入框 | 实现最省 | 用户不知道 exe 叫什么；易写错 | 作为**兜底**保留，不作为主路径 |

### 3.1 为什么不用 A 里的原生过滤（补充论证）

`IsInFilterList` 是**同一套实现同时服务剪贴板过滤与全局过滤**的子串匹配（`engine.cc:216-231`）：

```cpp
if (utf8ProgramName.find(filterItem) != std::string::npos) return true;
```

后果举例：用户想拉黑 VS Code，写入 `code.exe`，则 `vscode.exe`、`mycode.exe`、`barcode.exe` 一起失效；而用户如果为了避开这个坑写入更长的串（如 `Code.exe` 带路径）又不可能——`GetProgramNameFromHwnd` 已经去掉了路径。**要让原生层做精确匹配，只能改 `selection-hook` 的原生源码并重新编译三平台预编译产物，成本与风险都远超本需求的价值。**

---

## 4. 推荐方案（B + 零成本拾取）

### 4.1 数据模型

新增设置项放在 `selectionToolbar` 下（与 `clipboardFallback` 同级，语义上就是「划词工具的行为」）：

```js
// DEFAULT_SETTINGS.selectionToolbar 内
appFilter: {
  mode: 'blacklist',                  // 'off' | 'blacklist'（'whitelist' 预留，首期不做）
  apps: [ { exe: 'code.exe', name: 'Visual Studio Code' } ]   // name 仅用于展示
}
```

- `exe` 一律规范化：取 basename、去引号与空白、小写、限长 64；非空且去重。
- 上限 **50 项**（设置校验层另有数组 100 项上限，见 `settings-validation.js:4`）。
- 归一化函数放进 [toolbar/toolbar-utils.js](../../toolbar/toolbar-utils.js) 的 `normalizeSelectionToolbar()`（`toolbar-utils.js:106-142`），与 `conversation` / `resultWindow` 同构。
- **注意**：`DEFAULT_SETTINGS` 的模板决定了 `assertSettingsPatch` 是否接受某个键（`settings-validation.js:30` 对未声明的键直接抛「不支持的设置项」），所以新键必须先出现在默认值里。

### 4.2 匹配语义（判定的唯一实现）

```js
// 建议落在 selection 域（或一个纯函数模块，便于单测）
function isAppBlocked(programName, appFilter) {
  if (appFilter?.mode !== 'blacklist') return false
  const exe = path.basename(String(programName || '')).trim().toLowerCase()
  if (!exe) return false                        // 空身份不参与匹配
  return appFilter.apps.some((item) => item.exe === exe)   // 精确匹配，不是子串
}
```

拦截位置：`main/domains/selection/index.js` 的 `handleTextSelection()` 内，紧跟 `shouldFilterApp` 之后：

```js
if (shouldFilterApp(data.programName)) { logSelectionDiagnosticOnce('filtered-app', data); return }
if (isAppBlocked(data.programName, getSettings().selectionToolbar.appFilter)) {
  logSelectionDiagnosticOnce('blocked-app', data); return      // ← 新增
}
```

沿用 `logSelectionDiagnosticOnce`（`selection/index.js:331`）的「每会话每原因只记一次」范式：既能确诊，又不会日志洪泛；与既有 `filtered-app` / `game-mode` / `shown` 等 reason 并列，排查时一眼可辨。

### 4.3 「添加应用」的 UX（不引入任何原生能力）

配置页 `划词工具`（`config/config.js:724` `renderSelectionToolbarSettings`）新增一节「应用黑名单」：

| 入口 | 实现 | 说明 |
|---|---|---|
| **① 拾取当前应用（主路径）** | 点「拾取」→ 主进程进入 `pickMode`（**60 秒超时**）→ 用户在目标应用里划选任意文字 → 主进程从 `text-selection` 事件取 `programName` → 落库 → 回推给配置页 | 拾取期间**不显示工具栏**（在 `pickMode` 下提前 return）。逻辑上必然成功：能取到事件 = 该应用本来就会弹工具栏 |
| **② 最近触发过的应用** | selection 域内维护一个**内存**环形表（`programName → 最近时间/次数`，上限 ~20），在拦截判断**之前**记录，因此被拉黑的应用也能被看到（标注为「已拦截」） | 从真实划词记录里选，不用记忆 exe 名；只存内存，不落盘，无隐私面 |
| **③ 手动输入 exe 名** | 文本框 + 校验（`^[\w.\- ]+\.exe$`，不区分大小写） | 兜底：给「先配好、以后再用」的场景 |

列表行：图标位（可选，用已有 `app.getFileIcon` 的范式，见 `main.js:902`）＋ exe ＋ 备注名 ＋ 「已拦截」状态 ＋ 删除按钮。排序、启用/停用不在首期。

### 4.4 设置变更的运行时生效

本方案**不需要** `settings-effects` 新增任何 effect：判定函数每次都在 `handleTextSelection` 里实时读 `getSettings()`，保存后立即生效。这是相对方案 A 的一个额外优势（A 必须新增 `updateStartOptions` → `update-options` → `setGlobalFilterMode` 的整条链路，并同步改 `test/settings-effects.test.js:88` 的 effect id 清单）。

若后续要加「启用/停用黑名单」的即时副作用（例如切换时隐藏已显示的工具栏），再按 `clipboardFallback` 的范式补 effect。

### 4.5 IPC 通道（3 个 handle + 1 个推送）

新增通道**必须**同时满足 `IPC_SURFACES` 声明与唯一注册，否则启动时 `secureIpcMain.assertComplete()`（`main.js:1173`）直接抛错：

| 通道 | 类型 | 角色 | 用途 |
|---|---|---|---|
| `selection:apps-recent` | handle | main | 返回最近触发过的应用列表 |
| `selection:app-pick-start` | handle | main | 进入拾取模式 |
| `selection:app-pick-cancel` | handle | main | 取消拾取 |
| `selection:app-picked` | main→renderer push | — | 拾取成功回推（推送不在 `IPC_SURFACES` 管辖内，与 `history:changed` 同类） |

落地方式，全部零 `main.js` 行数：

- 通道声明：[main/services/ipc-security.js](../../main/services/ipc-security.js) 的 `IPC_SURFACES` → `role: 'main'` 的 `handles` 数组（第 12-53 行）。
- 通道注册：[main/ipc/selection-ipc.js](../../main/ipc/selection-ipc.js)（已是 `registerSelectionIpc({ ipcMain, controller })`，由 `main.js:1163` 调用，**签名不变**）。
- 能力注入：`selectionDomain.createIpcController()`（`selection/index.js:525`）增加 `apps: { recent, startPick, cancelPick }`。
- 渲染进程暴露：[preload.js](../../preload.js) 追加 3 个 `invoke` + 1 个 `on`。

### 4.6 需要留意的三处细节

1. **不要动 `shouldFilterApp` 的语义**。它同时服务截图域（`capture/index.js:162` 用窗口标题做 `desktopCapturer` 源筛选），把黑名单混进去会**顺带影响截图**。两者必须保持独立：`shouldFilterApp` = 自身进程；`isAppBlocked` = 用户黑名单。
2. **拾取模式的生命周期**。需要在以下时机清理：超时、用户点取消、配置窗口关闭、应用退出。注意 E2E 分支同样会预建/启动钩子（`main.js` e2e 分支、`test/e2e-contract.test.js:29`）。
3. **`main.js` 行数天花板只有 2 行**。任何新增都不得落在 `main.js`；若确实需要一行装配，应同时删掉等量行数，或把 `shouldFilterApp` 整体搬进新模块由 domain 注入（该改动会触及 `main.js:579`、`main.js:686` 两处注入点，净减行）。

---

## 5. 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| 用户误以为能按站点/窗口/UWP 应用拉黑 | 中 | 配置页明写：**按 exe（应用级）**；UWP 应用统一显示为 `ApplicationFrameHost.exe` 并给出说明 |
| 空 `programName` 导致匹配抖动 | 低 | 匹配函数对空身份直接返回 `false`；单测覆盖 |
| 用户拉黑了「划词工具本来就不工作」的应用，以为功能坏了 | 低 | 拾取路径天然只在能触发划词的应用上成功；UI 文案区分「未触发过」与「已拦截」 |
| 黑名单把用户自己锁在门外（拉黑了配置页所在进程） | 低 | 自身进程过滤优先于黑名单；拾取路径也不可能拾到 Highlighter 自己（`shouldFilterApp` 先返回） |
| 新增 IPC 通道漏注册 → 启动崩 | 中（易发现） | `assertComplete()` 在启动路径上；`test/ipc-security.test.js:100-141` 会扫描全部 `main/ipc`、`main/domains` 源文件做一致性校验 |
| 新增设置键未进默认值 → 保存被拒 | 中（易发现） | `settings-validation.js:30` 直接抛「不支持的设置项」；`test/settings-validation.test.js` 已覆盖该范式 |
| 默认值形状被断言测试锁死 | 低 | `test/toolbar-utils.test.js:17` 对 `DEFAULT_SELECTION_TOOLBAR` 做严格 `deepEqual`，新增字段需同步更新该断言 |

---

## 6. 测试与验收计划

### 6.1 单元/契约测试（`npm test`，node:test）

| 测试 | 断言要点 |
|---|---|
| `isAppBlocked`（新增，纯函数） | 大小写不敏感精确匹配；`code.exe` **不得**命中 `vscode.exe`；空 `programName` 返回 `false`；`mode: 'off'` 返回 `false`；带路径/引号的输入被规范化 |
| `normalizeSelectionToolbar`（扩 `test/toolbar-utils.test.js`） | 非法项被丢弃、去重、小写化、上限 50；`mode` 非法时回落 `'off'`/`'blacklist'`；`deepEqual(DEFAULT_SELECTION_TOOLBAR, {...})` 断言同步更新 |
| selection 域（扩 `test/selection-domain.test.js`） | 黑名单内应用：`handleTextSelection` 不触发 `showToolbarSelection`；黑名单外应用：照常触发；游戏模式 / `filtered-app` 的既有优先级不变 |
| 设置校验（扩 `test/settings-validation.test.js`） | `selectionToolbar.appFilter.apps` 超过 100 项抛「项目过多」；未声明子键抛「不支持的设置项」 |
| IPC 一致性（既有 `test/ipc-security.test.js`） | 3 个新 handle 通道声明与注册一一对应；`test/ipc-module-contracts.test.js` 的 `registerSelectionIpc` 期望通道清单同步更新 |
| 配置页契约（扩 `test/selection-toolbar-settings.test.js`） | 配置页含黑名单区块、拾取按钮与对应文案 |

### 6.2 门禁

- `npm run check`（语法 + `check:architecture`）——**重点看 `main.js` ≤ 1300 行**
- `npm test`
- 可选 `npm run test:coverage:loaded`（selection 域在覆盖范围内）

### 6.3 真机验证（打包前必做）

1. 在 Chrome / VS Code 里划词 → 工具栏正常（基线）。
2. 把 Chrome 加入黑名单 → 在 Chrome 里划词无工具栏；切到 VS Code 划词仍有工具栏（**异应用不误伤**）。
3. 边界：拉黑 `code.exe` 后在 `vscode.exe` 里划词应**仍然有工具栏**（验证精确匹配，这是与方案 A 的关键差异）。
4. 拾取流程：点拾取 → 60 秒内不划选 → 自动超时；点拾取 → 在目标应用划选 → 列表出现该项且能立即生效。
5. UWP 应用（如「设置」）划词 → 记录到 `ApplicationFrameHost.exe`，验证 UI 文案能解释这一现象。
6. 重启应用后黑名单仍生效（持久化）。
7. 按 `AGENTS.md`：可见的测试窗口默认置于副屏；本机当前仅一块显示器（`\\.\DISPLAY1`），开窗验证前需先与用户确认。

---

## 7. 工作量估算

| 工作项 | 规模 |
|---|---|
| 数据模型 + 归一化（`toolbar-utils`、`settings-defaults`） | 小 |
| 判定函数 + 域层拦截 + 诊断日志 | 小 |
| 拾取模式 / 最近应用环形表（selection 域） | 中 |
| IPC 3 通道 + preload | 小 |
| 配置页「应用黑名单」区块（列表 + 拾取 + 手动添加） | 中 |
| 测试（6 项）+ 门禁 + 真机验证 | 中 |
| ~~原生过滤链路（方案 A）~~ | ~~中~~（首期不做） |

**总体：一个常规功能的规模，无架构级改动，无新依赖，无原生编译。**

---

## 8. 待确认的决策

| 编号 | 问题 | 建议 |
|---|---|---|
| Q1 | 黑名单标识用 **exe 精确匹配**（`code.exe` 不会误伤 `vscode.exe`）是否可以接受？代价是 UWP 应用无法逐个区分 | ✅ 建议接受；UWP 在文案中说明 |
| Q2 | 首期是否同时做**白名单模式**（只在指定应用里启用划词）？ | 建议**不做**，数据模型预留 `mode` |
| Q3 | 首期是否投入**原生助手**做可视化「应用选择器」（列窗口+图标+exe）？ | 建议**不做**，用 §4.3 的拾取 + 最近列表覆盖 |
| Q4 | 配置项是否需要**导入/导出**（跨设备同步）？ | 建议不做，设置已有整体重置路径 |
| Q5 | 是否需要「已拦截时给一次性提示」（如托盘气泡），避免用户以为划词坏了？ | 建议不做，配置页状态 + 运行日志足够 |

---

## 9. 一句话回答「该怎么实现」

在 `handleTextSelection` 里、`shouldFilterApp` 旁边，用 `data.programName`（exe 文件名）做一次**大小写不敏感的精确匹配**，命中就 `return`；配置项放 `selectionToolbar.appFilter`，配置界面加在「划词工具」页；「添加应用」靠一次真实划词事件取 exe，不需要任何原生代码或新依赖。原生自带的 `setGlobalFilterMode` 虽然能在取词前拦截，但它是子串匹配、会误伤，首期不建议启用。
