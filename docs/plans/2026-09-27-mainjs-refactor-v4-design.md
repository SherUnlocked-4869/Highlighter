# 设计文档：划词追问第四版（`main.js` 重构）

- 日期：2026-09-27
- 基线：`feature/selection-toolbar-conversation` @ `f8b89c6`
- 上游：第一版文档 §13「第四版」、第二版文档 §2.3/§2.4、第三版文档 §11.2
- 状态：**已实施（2026-09-27）**，七个阶段各自一个提交（`1c0fc8a` `c791e79` `b59cba9` `a0e7466` `4e57ce8` `8a0a6ef` `89870e0`），全部门禁通过。
  实施结果、两处偏差与一处对本文档事实的更正见 §8——按 §1.2 的约定「回到本表改一行并注明原因」，D23 已就地改写。
- 范围：**只做结构搬移，零行为变化、零新功能**

---

## 1. 需求与决策点

### 1.1 需求

`main.js` 现在 **2173 行 / 158 个顶层声明**。行数上限在第二版时为让路而**解除**（`scripts/check-architecture.js`
只上报、不拦截），解除是权宜——问题没消失，只是拦阻消失了。第三版又往里加了约 70 行持久化装配。

本版把 `main.js` 降回"装配层"应有的体量，并**重新设立上限**锁住成果。

### 1.2 决策点（D23–D31，**已确认**）

> 2026-09-27 确认：**全部按建议值执行，无修改**。下表「建议」列即最终结论，
> 实施时不再逐项复议；如实施中发现某条不可行，回到本表改一行并注明原因，而不是就地绕过。

> 2026-09-27 实施后修订：**D23 已就地改写**（见下表与 §8.1）。其余各条按原结论执行。
> D23 的 1200 上限在本版范围内不可达，原因不是执行偏差，而是设计自身估算即落在 ≈1300，
> 且 §6 把「为凑行数做顺带优化」列为非目标。

| # | 决策点 | 结论 | 理由 |
|---|---|---|---|
| D23 | 目标体量与上限 | ~~降到 **≈1150 行**；上限分两步收紧 **2100 → 1600 → 1200**~~<br>**改写：实测落点 1287 行；上限分两步收紧 `2100 → 1600 → 1300`**（§8.1） | 一步到位会让中间态无法回滚；两步走每一步都能单独通过门禁。1300 而非 1200：剩余大块即本文档自己保留的部分（D28 的编排、§3.1 的装配、§3.2 的控制器接线），继续削只能靠 §6 明令禁止的「顺带优化」 |
| D24 | 抽取顺序 | **按"独立性 × 产出比"排**：① 内联 IPC 面 → ② OCR 控制器 → ③ 划词域 → ④ 数据根域 → ⑤ 默认设置 → ⑥ 函数路由 | 先搬"只依赖注入、不参与启动时序"的（风险最低），最后碰与启动/数据根相关的 |
| D25 | 划词域的形状 | 新增 `main/domains/selection/index.js`，导出 `createSelectionDomain(deps)`，与既有 7 个域同构 | 划词簇共 **318 行/23 个函数**，是单块最大的业务代码；塞进 `main/ipc/` 会变成"IPC 模块里带业务逻辑" |
| D26 | `window:minimize` / `window:close` 要不要一起搬 | **不搬**。实测这两个通道只由 `preload.js`（主界面）发送；`window:toggle-pin` 只由 `preload-action.js` 发送，**搬它** | 按"谁发送"决定归属，而不是按"名字像" |
| D27 | 防回流门禁 | `REQUIRED_DOMAINS` 增加 `selection`；`FORBIDDEN_IN_MAIN` 增加 `secureIpcMain.on('chat:`、`'stream:`、`'toolbar:`、`handle('chat:`、`function openToolbarAiAction`、`function streamToWindow`、`function handleTextSelection`<br>**实施时在本列表之外补齐**：`data-root` 也进 `REQUIRED_DOMAINS`，`'window:toggle-pin'` 与其余搬出项（数据根三函数、`stopManagedDataWriters`、截图链、`DEFAULT_SETTINGS`、`executeFunction`）也进 `FORBIDDEN_IN_MAIN`（§8.2） | 搬出去的东西要"搬不回来"，否则半年后又是 2000 行 |
| D28 | 启动序列搬不搬 | **不搬** `startApplication` / `gotTheLock` 块（71 + 62 行） | 那是应用入口的编排顺序，搬走只会把"谁先谁后"藏进另一个文件；重构的目标是可读，不是行数好看 |
| D29 | `DEFAULT_SETTINGS`（92 行） | 搬到 `main/services/settings-defaults.js`，纯数据、零逻辑 | 它是唯一一个"因体积而碍眼、但搬走零风险"的块；也让设置默认值可被单独引用 |
| D30 | 顺带消除脆弱断言 | 把 `test/ipc-security.test.js` 里硬编码的 `policies.size = 108` / `{handle:71,on:37}` 改为**从 `IPC_SURFACES` 推导** | 第二版为它手改过一次数字；本版会再动通道归属，正是消除它的时机 |
| D31 | 中途允许临时放宽上限吗 | 允许，但**必须在同一个分支内降回去**；每个阶段一个提交、各自跑门禁 | 否则重构本身会把"上限"这条约束彻底作废 |

---

## 2. 现状：实测的体量分布

用脚本（`.tmp/measure-main.js`）按顶层声明切块实测，**最大块并不是划词代码**：

| 块 | 行数 | 位置 | 性质 |
|---|---:|---|---|
| `changeDataRoot` | 175 | L1606 | 业务逻辑（数据根切换 + 迁移 + 回滚） |
| `ocrIpcController`（对象字面量） | 54 | L1781 | IPC 控制器（另有 10 行注册调用） |
| `DEFAULT_SETTINGS` | 92 | L140 | 纯数据 |
| `startApplication` | 71 | L2040 | 启动编排 |
| `executeFunction` | 68 | L1405 | 应用功能路由（已委托给各域） |
| `gotTheLock` 块（含单实例锁与事件注册） | 62 | L2111 | 启动编排 |
| `recoverUnavailableDataRoot` | 58 | L1982 | 业务逻辑 |
| `getDisplayCapture` | 47 | L1239 | 截图域残留 |
| `createMainWindow` | 45 | L852 | 窗口装配 |
| `chooseInitialDataRoot` | 34 | L1948 | 业务逻辑 |
| **内联 `secureIpcMain` 注册（8 条）** | **89** | L1857–1945 | IPC |
| **划词簇（23 个函数）** | **318** | 多处 | 业务逻辑 |

内联注册的逐条行数（用于拆分归属）：

| 通道 | 行数 | 发送方 | 归属 |
|---|---:|---|---|
| `toolbar:action` | 25 | `preload-toolbar.js` | selection IPC |
| `window:toggle-pin` | 18 | `preload-action.js` | selection IPC |
| `chat:ask` | 24 | `preload-action.js` | selection IPC |
| `chat:copy` | 6 | `preload-action.js` | selection IPC |
| `stream:cancel` / `stream:finish` | 5 + 5 | `preload-action.js` | selection IPC |
| `window:minimize` / `window:close` | 1 + 5 | `preload.js` | 留在 main.js（D26） |

划词簇里最大的几个：`openToolbarAiAction` 38、`streamToWindow` 34、`initSelectionHook` 33、
`getRefPointAndOrientation` 30、`restoreConversation` 30、`createToolbarStreamController` 20、
`registerSelectionPowerEvents` 18、`handleTextSelection` 17。

**可搬移量合计约 750–800 行**，因此 D23 的目标（−1000 行左右）是现实可达的，
但需要连 `changeDataRoot` 与截图域残留一起搬，不能只搬划词。

---

## 3. 总体设计

### 3.1 目标结构

```
main.js（≈1150 行：只做装配与启动编排）
├─ main/ipc/selection-ipc.js       ★新增  toolbar:action · stream:* · chat:* · window:toggle-pin（89 行）
├─ main/ipc/ocr-ipc.js             ★新增  ocrIpcController + 其注册（~64 行）
├─ main/domains/selection/index.js ★新增  划词簇 23 个函数（~318 行）
├─ main/domains/data-root/index.js ★新增  changeDataRoot · recoverUnavailableDataRoot · chooseInitialDataRoot（~267 行）
├─ main/services/settings-defaults.js ★新增 DEFAULT_SETTINGS（92 行）
├─ main/services/function-router.js   ★新增 executeFunction 的派发表（68 行）
└─ main/domains/capture（既有）      接收 getDisplayCapture 等残留（~60 行）
```

### 3.2 不变的约定

- **域的形状**：`createXDomain(deps)` 返回 `{ ...方法 }`，与既有 7 个域一致；`main.js` 只做装配。
- **IPC 模块的形状**：`registerX Ipc({ ipcMain, controller })`，与 `main/ipc/history-ipc.js` 一致。
- **依赖注入**：新模块不 `require('electron')` 之外的全局，需要的窗口/设置/日志等一律注入
  （这也是它们能被 `node:test` 直接覆盖的前提，与 `action-conversation.js`/`conversation-store.js` 同法）。
- **调用顺序不变**：搬移是"同序同调用"，不做顺带的行为优化。任何一处想改行为，另开提交。

### 3.3 明确不做

- 不改任何用户可见行为、不加功能、不改 IPC 契约、不改设置形状。
- 不重写 `main.js`（不做"从头写一遍"式的重写）——增量搬移才能让每一步都可回滚、可 review。
- 不动 `startApplication` / `gotTheLock` 的编排（D28）。

---

## 4. 分阶段实施（每阶段一个提交，各自跑门禁）

| 阶段 | 搬什么 | 去处 | 估计 | 实测 | 风险 |
|---|---|---|---:|---:|---|
| 1 | 8 条内联 IPC 注册（其中 `window:minimize/close` 留原地） | `main/ipc/selection-ipc.js` | −84 | −60 | 低：纯搬移 + 注入 |
| 2 | `ocrIpcController` + 注册 | `main/ipc/ocr-ipc.js` | −64 | −42 | 低 |
| 3 | 划词簇 23 个函数 | `main/domains/selection/` | −318 | **−480** | **中**：涉及流控制器、窗口生命周期、钩子与电源事件 |
| 4 | `changeDataRoot` / `recoverUnavailableDataRoot` / `chooseInitialDataRoot` | `main/domains/data-root/` | −267 | −155 | **中高**：数据根切换牵动迁移、单实例锁与重启路径 |
| 5 | `DEFAULT_SETTINGS` | `main/services/settings-defaults.js` | −92 | −101 | 低：纯数据 |
| 6 | `executeFunction` 派发表 | `main/services/function-router.js` | −68 | −47 | 低 |
| 7 | 收紧上限 + 门禁防回流（D23/D27/D30） | `scripts/check-architecture.js`、`test/ipc-security.test.js` | ±0 | ±0 | 低 |

实测口径：本列是各阶段提交后 `wc -l main.js` 的差值，基线 2172、终点 1287（共 −885）。
`check-architecture` 因按 `\r?\n` 切分会把末尾换行计为一行，同一文件报数比 `wc -l` 多 1（终点报 1288）。

两处偏差超过 ±30%，均已按「先停下来重新量」处理：

- **阶段 3 多于估计**（−480 vs −318）：划词簇之外还搬走了 `SelectionWindowManager` 的构造与 5 个转发函数，
  以及 §3.1 要求的截图残留（`isBlankCapture` / `getDesktopCapture` / `getDisplayCapture` / `captureFocusedWindow` / 原生显示器预热）。
- **阶段 4 少于估计**（−155 vs −267）：数据根域直接 `require` 了无状态的 data-root / migration / coordinator / relaunch 四个服务，
  main.js 不再逐项透传这些依赖，因此它在 main.js 一侧的「装配新增」比预估少；估计值按「搬走 267 行」算没有计入这部分回收。

预期落点：2173 − (84+64+318+267+92+68) + 装配新增 ≈ **1300 行左右**，再压缩装配即可到 1150。
**实测落点 1287 行，与本节自己的估算 1300 一致**；到 1150 的差额来自 §1.2 原样保留的编排与装配，见 §8.1。

---

## 5. 测试与验证计划

重构的验证目标不是"新功能对不对"，而是**"行为没变"**，因此靠三张网：

### 5.1 既有网（每阶段必跑）

1. `npm test`（当前 **556** 通过 / 0 失败）
2. `npm run check`（含 `check-architecture`：域存在性、禁止模式、行数上报）
3. `npm run test:coverage`（三级门禁；新模块落在对应聚合桶里）

### 5.2 行为回归网（阶段 3/4 之后各跑一次）

- **打包件启动核验**（已固化）：构建 → 静默安装到临时目录或直接跑 `win-unpacked` →
  读真实数据根日志里的 `session-start` / `Selection hook started` / `OCR ready` / `e2e:false`。
  这一步专门抓"搬移导致启动时序错位"。
  > **实施期更正（2026-09-27）**：`scripts/verify-packaged-startup.ps1` 配的是 `main/packaged-entry.js` 的
  > `--highlighter-packaged-startup-probe` 开关，该开关只做 `app.whenReady()` 然后 `app.quit()`，
  > **根本不加载 `main.js`**。所以它既读不到上面四行日志，也不能抓启动时序回归；上文对它的描述是计划假设，不是事实。
  > 本版真正覆盖"真 Electron + 真 `main.js` + 非 e2e 启动路径"的是 `test/diagnostics-runtime.test.js`
  > （`windowsHide` 启动、临时 userData），它在实施中确实抓到了一个真实缺陷（§8.6）。
- **划词链路真机回归**：跑 `.tmp/verify-conversation.js`（33 项断言，覆盖真实划词→工具栏→结果窗口→追问→
  停止→隐藏恢复→覆盖→仅翻译模型）与 `.tmp/verify-v3-retry.js` / `-quote.js` / `-persist.js`。
  阶段 3（划词域）之后必须全绿再继续——这是本次重构最重要的安全网。
  > 实施结果：33 / 11 / 10 / 12 项全绿（§8.6）。
- **数据根回归**：阶段 4 之后跑 `test/data-root*.test.js` + 一次真实的数据根切换冒烟（切到临时目录再切回）。
  > 实施结果：三个测试文件全绿；**真机切换冒烟未做**——它需要点原生目录选择框并两次重启应用，无法非交互完成（§8.6）。

### 5.3 新增（防回流）

| 文件 | 覆盖 |
|---|---|
| `test/ipc-security.test.js`（改） | 计数改为从 `IPC_SURFACES` 推导，新增通道不再需要手改数字 |
| `test/architecture-gate.test.js`（扩展） | 断言 `main.js` 行数 ≤ 上限、`FORBIDDEN_IN_MAIN` 的模式确实不在 `main.js` 里 |
| `test/ipc-module-contracts.test.js`（扩展） | 新增的 `selection-ipc` / `ocr-ipc` 纳入通道顺序契约 |
| `test/selection-domain.test.js`（新增，阶段 3） | 注入假窗口/假设置，断言工具栏动作路由、流控制器生命周期、钩子事件转发 |
| `test/ocr-ipc.test.js`（新增，阶段 2，**清单外**） | OCR 控制器的开关校验、空数据拒绝、翻译块配对（§8.3） |
| `test/function-router.test.js`（新增，阶段 6，**清单外**） | 派发表逐条路由、`未知功能` 拒绝、`Object.prototype` 同名键不误判（§8.3） |

后两个文件不在原清单里，是被 coverage 门禁逼出来的：`main/ipc/**` 与 `main/services/**` 都在
`test:coverage:loaded` 的 `--include` 内，把控制器与派发表搬进去而不给测试，总行数覆盖率会被拖到 85% 以下。

---

## 6. 风险与回滚

| 风险 | 评估 | 缓解 |
|---|---|---|
| 搬移改变启动时序（域在监听/托盘/hook 之前或之后初始化） | **高** | 每次搬移保持"同序同调用"；由真 Electron 加载 `main.js` 的 `test/diagnostics-runtime.test.js` 抓这类回归（§5.2 已更正：`verify-packaged-startup.ps1` 不加载 `main.js`，抓不到） |
| 划词域搬移打断流控制器与窗口关闭的耦合 | **高** | 阶段 3 之后跑四个真机脚本全量回归，全绿再进阶段 4 |
| 数据根域搬移破坏迁移/回滚 | 中高 | 阶段 4 单独提交；`test/data-root-migration.test.js` 的"回滚后目标为空"等断言是硬网 |
| 新模块悄悄 `require('electron')` 导致不可测 | 中 | 注入式依赖；`selection-domain.test.js` 用假对象驱动即可暴露 |
| 搬出去又被搬回来 | 中 | D27 的 `FORBIDDEN_IN_MAIN` 模式；门禁在 CI 上跑 |
| 为凑行数而做顺带优化 | 中 | 明确非目标：本版零行为变化；发现的问题登记到清单另做 |

**回滚**：每个阶段一个提交，逆序 revert 即可。唯一需要额外注意的是阶段 7（收紧上限）——回滚它要
**先**把上限调回 2100，再 revert 前面的搬移提交，否则 `check` 会先红。

---

## 7. 附录：新增/修改文件清单

| 文件 | 类型 |
|---|---|
| `main/ipc/selection-ipc.js` | **新增** |
| `main/ipc/ocr-ipc.js` | **新增** |
| `main/domains/selection/index.js` | **新增** |
| `main/domains/data-root/index.js` | **新增** |
| `main/services/settings-defaults.js` | **新增** |
| `main/services/function-router.js` | **新增** |
| `main/domains/capture/index.js` | 修改（接收截图域残留） |
| `main.js` | 修改（装配，目标 ≈1150 行） |
| `scripts/check-architecture.js` | 修改（`REQUIRED_DOMAINS` += selection/data-root；`FORBIDDEN_IN_MAIN` 扩列；行数上限分两步收紧） |
| `test/ipc-security.test.js` · `test/architecture-gate.test.js` · `test/ipc-module-contracts.test.js` | 修改 |
| `test/selection-domain.test.js` | **新增** |
| `test/ocr-ipc.test.js` | **新增**（清单外，见 §5.3） |
| `test/function-router.test.js` | **新增**（清单外，见 §5.3） |

实施后的实际改动面（口径：`git diff --stat 2970b2f..HEAD -- . ':!docs'`，30 个文件、+2317/−1171）：

| 文件 | 行数 | 说明 |
|---|---:|---|
| `main.js` | 1287（原 2172） | 装配 + 启动编排 |
| `main/domains/selection/index.js` | 534 | 比 §3.1 的 ~318 大：含 `SelectionWindowManager` 构造与 5 个转发函数、`createIpcController()`、`applyGameMode()` |
| `main/domains/data-root/index.js` | 237 | 比 §3.1 的 ~267 小：四个无状态服务改为域内直接 `require` |
| `main/ipc/selection-ipc.js` | 128 | |
| `main/services/function-router.js` | 133 | 由 68 行 switch 改写为派发表 |
| `main/services/settings-defaults.js` | 111 | |
| `main/ipc/ocr-ipc.js` | 91 | |

另有两处「清单外但为达成 §3.1／§4 目标而修改」的文件：`main/ipc/capture-ipc.js`（移出 OCR 三通道）、
`main/domains/capture/index.js`（接收截图链）。

---

## 8. 实施结果与偏差（2026-09-27 补记）

本节是实施完成后回写的内容，记录计划与实际的差异。原则同 §1.2：偏差就地记在本文档，不另开文件，
也不在代码里悄悄绕过。

### 8.1 D23：上限取 1300，不是 1200

| 项 | 计划 | 实际 |
|---|---|---|
| 目标体量 | ≈1150 行 | **1287 行**（`check-architecture` 口径 1288） |
| 上限两步收紧 | `2100 → 1600 → 1200` | **`2100 → 1600 → 1300`** |

减幅 −885 行（−40.7%）。未达 1200 的原因**不是执行偏差，而是计划本身的算术**：§4 的估计把六项搬移
加总为 893 行，再计入装配新增，设计自己给出的落点就是「≈1300 行左右」；本节实施结果 1287 与该估算一致。
而剩下的约 90 行全部是本文档明确保留的部分：

- `startApplication`（66 行）与 `gotTheLock`（62 行）——D28 要求不搬；
- `createMainWindow`（44）、`createTrayIcon`（37）、各域装配（约 190）、`initializeStore`（41）——§3.1 归入 main.js；
- `registerX Ipc` 的控制器字面量（`registerHistoryIpc` / `registerAppIpc` / `registerSettingsIpc` / `registerDiagnosticsIpc` 等都把控制器写在调用点）——§3.2 的约定就是「控制器由 main.js 组装」；
- 服务工厂（`initializeDiagnostics` / `initializeUpdateService` / `getOcrService` / `getEverythingService` / `saveImageBuffer` 等）。

再削这些只能靠「顺带优化」，而 §6 把它列为非目标（「为凑行数而做顺带优化｜中｜明确非目标」）。
因此本版按 1300 收紧并锁住成果，把「继续降到 1150」登记为后续版本的工作；后续若要动，
应当先改 §3.1／§3.2 的归属约定（把装配或控制器下沉到各自模块），而不是在本版内硬凑。

两步收紧的动作已落地：`1600` 只作为中间态存在过，最终提交进 `check-architecture.js` 的常量是
`MAIN_LINE_CEILING = 1300`，并把「当初为何是 1300 而不是 1200」写进该文件的注释，避免半年后被当成随手定的数。

### 8.2 D27：门禁比原列表更严

`REQUIRED_DOMAINS` 除 `selection` 外也加入了 `data-root`（原列表只写 `selection`，但 §4 阶段 4 明确要抽数据根域，
不锁就会被搬回来）。`FORBIDDEN_IN_MAIN` 在原列表之外补齐了其余搬出项：

- `'window:toggle-pin'`（D26 决定搬它，但原列表为避开 `window:minimize/close` 未列；用精确模式不会误伤）；
- `function changeDataRoot` / `recoverUnavailableDataRoot` / `chooseInitialDataRoot` / `stopManagedDataWriters`；
- `function getDisplayCapture` / `captureFocusedWindow`；
- `const DEFAULT_SETTINGS = {`（精确到赋值，不误伤 `const { DEFAULT_SETTINGS } = require(...)`）；
- `async function executeFunction`；
- 以及 `getRefPointAndOrientation` / `createToolbarStreamController` / `restoreConversation`。

### 8.3 两处清单外的新增（都是被门禁逼出来的）

1. **`test/ocr-ipc.test.js`、`test/function-router.test.js`**：`main/ipc/**` 与 `main/services/**` 都在
   `test:coverage:loaded` 的 `--include` 里，控制器/派发表搬进去后若无测试，总行数覆盖率会跌破 85%。
   这不是「为新功能写测试」，而是维持既有门禁的必然后果。
2. **选择域新增可选注入点 `createHookService`**（默认即真实的 `SelectionHookService`）：
   §3.2 说「注入式依赖……是能被 `node:test` 直接覆盖的前提」，而钩子的构造原本写在域内部，
   测试无法在不 fork utility 进程的前提下观察 `handlers.textSelection` 与电源事件转发。
   该注入点只增加一个可选参数，生产路径行为不变。

### 8.4 `shouldFilterApp` 留在 main.js

§2 把 `shouldFilterApp` 归入「划词簇」，实施时改留在 `main.js` 并注入给两个域。原因：它的两个调用方
分别在划词域（`handleTextSelection`）与截图域（`captureFocusedWindow`），而截图域先于划词域构造；
放进任一侧都会造出「后构造的域被先构造的域依赖」这种反向耦合。它只有 4 行、且确实被两处共用，
放在装配层是这里唯一不引入环的选择。**这是对 §2 分簇的一处修正。**

### 8.5 未搬出但设计未列的块

`positionAutomationWindow`、`createMainWindow`、`getSearchFileIcon`、`saveImageBuffer` / `saveDataUrl`、
`getEverythingService`、`pickDirectory` / `chooseDirectory` 仍在 `main.js`。它们不在 §3.1／§7 的清单里，
按「明确不做：不重写 main.js」的口径原样保留，未借机顺带搬运。

### 8.6 验证实况

| 网 | 结果 |
|---|---|
| `npm test` | **583 通过 / 0 失败**（基线 556，新增 27） |
| `npm run check` | 通过；`architecture-check: ok (main.js 1288 lines, ceiling 1300, domains 9)` |
| `npm run test:coverage` | 三级门禁全过（loaded 行覆盖 90.63%） |
| 真 Electron 启动探针 `test/diagnostics-runtime.test.js` | 通过。**实施期确实靠它抓到一个真实缺陷**：阶段 3 选择域里 `require('../../toolbar/toolbar-utils')` 少一层，`node --check` 与单测都发现不了，只有真 Electron 加载 `main.js` 才报 `Cannot find module` |
| `.tmp/verify-conversation.js` | **33/33** |
| `.tmp/verify-v3-retry.js` | **11/11** |
| `.tmp/verify-v3-quote.js` | **10/10** |
| `.tmp/verify-v3-persist.js` | 首次 **11/12**，重跑 **12/12** |
| `test/data-root*.test.js` | 全绿 |

两点必须如实说明：

- **`verify-v3-persist.js` 的那 1 项失败是脚本自身的竞态，不是本版回归。** 断言「落盘内容含已提交的追问对」
  在追问轮落盘完成前就读文件（脚本只 `waitFor` 文件出现，不 `waitFor` 文件内容更新），重跑即通过。
  本次重构没有改变任何落盘时机：`saveConversation` 仍由同一条流提交路径调用，
  `conversationStore` 的构造参数与调用点（`initializeStore` 内）也未变。
- **真机数据根切换冒烟未做。** 它要点原生目录选择框并两次重启应用，无法非交互完成；
  迁移/回滚逻辑由 `test/data-root-migration.test.js`、`test/data-root.test.js`、`test/data-root-ui-contract.test.js` 覆盖。

打包件核验的更正见 §5.2：`verify-packaged-startup.ps1` 不加载 `main.js`，本版未重建安装包
（重建需 `npm run build:win`，会重编原生模块并覆盖 `dist/`），该步骤留待发布流程执行。

### 8.7 提交清单（一个阶段一个提交，可逆序 revert）

| 提交 | 内容 |
|---|---|
| `1c0fc8a` | `refactor(selection)` 内联 IPC → `selection-ipc.js` |
| `c791e79` | `refactor(ocr)` OCR 控制器 → `ocr-ipc.js` |
| `b59cba9` | `refactor(selection)` 划词域 + 截图残留 |
| `a0e7466` | `refactor(data-root)` 数据根域 |
| `4e57ce8` | `refactor(settings)` `DEFAULT_SETTINGS` |
| `8a0a6ef` | `refactor(functions)` 派发表 |
| `89870e0` | `test(architecture)` 上限 + 防回流门禁 |

回滚注意（同 §6）：要回滚阶段 7 之前的内容，须**先**把 `MAIN_LINE_CEILING` 调回 2100，再 revert 前面的搬移提交，
否则 `npm run check` 会先红。
