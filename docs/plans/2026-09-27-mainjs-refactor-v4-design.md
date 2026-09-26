# 设计文档：划词追问第四版（`main.js` 重构）

- 日期：2026-09-27
- 基线：`feature/selection-toolbar-conversation` @ `f8b89c6`
- 上游：第一版文档 §13「第四版」、第二版文档 §2.3/§2.4、第三版文档 §11.2
- 状态：**设计定稿，待确认决策点**
- 范围：**只做结构搬移，零行为变化、零新功能**

---

## 1. 需求与决策点

### 1.1 需求

`main.js` 现在 **2173 行 / 158 个顶层声明**。行数上限在第二版时为让路而**解除**（`scripts/check-architecture.js`
只上报、不拦截），解除是权宜——问题没消失，只是拦阻消失了。第三版又往里加了约 70 行持久化装配。

本版把 `main.js` 降回"装配层"应有的体量，并**重新设立上限**锁住成果。

### 1.2 决策点（建议值，待确认）

| # | 决策点 | 建议 | 理由 |
|---|---|---|---|
| D23 | 目标体量与上限 | 降到 **≈1150 行**；上限分两步收紧 **2100 → 1600 → 1200** | 一步到位会让中间态无法回滚；两步走每一步都能单独通过门禁 |
| D24 | 抽取顺序 | **按"独立性 × 产出比"排**：① 内联 IPC 面 → ② OCR 控制器 → ③ 划词域 → ④ 数据根域 → ⑤ 默认设置 → ⑥ 函数路由 | 先搬"只依赖注入、不参与启动时序"的（风险最低），最后碰与启动/数据根相关的 |
| D25 | 划词域的形状 | 新增 `main/domains/selection/index.js`，导出 `createSelectionDomain(deps)`，与既有 7 个域同构 | 划词簇共 **318 行/23 个函数**，是单块最大的业务代码；塞进 `main/ipc/` 会变成"IPC 模块里带业务逻辑" |
| D26 | `window:minimize` / `window:close` 要不要一起搬 | **不搬**。实测这两个通道只由 `preload.js`（主界面）发送；`window:toggle-pin` 只由 `preload-action.js` 发送，**搬它** | 按"谁发送"决定归属，而不是按"名字像" |
| D27 | 防回流门禁 | `REQUIRED_DOMAINS` 增加 `selection`；`FORBIDDEN_IN_MAIN` 增加 `secureIpcMain.on('chat:`、`'stream:`、`'toolbar:`、`handle('chat:`、`function openToolbarAiAction`、`function streamToWindow`、`function handleTextSelection` | 搬出去的东西要"搬不回来"，否则半年后又是 2000 行 |
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

| 阶段 | 搬什么 | 去处 | 估计 | 风险 |
|---|---|---|---:|---|
| 1 | 8 条内联 IPC 注册（其中 `window:minimize/close` 留原地） | `main/ipc/selection-ipc.js` | −84 | 低：纯搬移 + 注入 |
| 2 | `ocrIpcController` + 注册 | `main/ipc/ocr-ipc.js` | −64 | 低 |
| 3 | 划词簇 23 个函数 | `main/domains/selection/` | −318 | **中**：涉及流控制器、窗口生命周期、钩子与电源事件 |
| 4 | `changeDataRoot` / `recoverUnavailableDataRoot` / `chooseInitialDataRoot` | `main/domains/data-root/` | −267 | **中高**：数据根切换牵动迁移、单实例锁与重启路径 |
| 5 | `DEFAULT_SETTINGS` | `main/services/settings-defaults.js` | −92 | 低：纯数据 |
| 6 | `executeFunction` 派发表 | `main/services/function-router.js` | −68 | 低 |
| 7 | 收紧上限 + 门禁防回流（D23/D27/D30） | `scripts/check-architecture.js`、`test/ipc-security.test.js` | ±0 | 低 |

预期落点：2173 − (84+64+318+267+92+68) + 装配新增 ≈ **1300 行左右**，再压缩装配即可到 1150。
若某阶段的估计偏差超过 30%，先停下来重新量，而不是硬凑目标。

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
- **划词链路真机回归**：跑 `.tmp/verify-conversation.js`（33 项断言，覆盖真实划词→工具栏→结果窗口→追问→
  停止→隐藏恢复→覆盖→仅翻译模型）与 `.tmp/verify-v3-retry.js` / `-quote.js` / `-persist.js`。
  阶段 3（划词域）之后必须全绿再继续——这是本次重构最重要的安全网。
- **数据根回归**：阶段 4 之后跑 `test/data-root*.test.js` + 一次真实的数据根切换冒烟（切到临时目录再切回）。

### 5.3 新增（防回流）

| 文件 | 覆盖 |
|---|---|
| `test/ipc-security.test.js`（改） | 计数改为从 `IPC_SURFACES` 推导，新增通道不再需要手改数字 |
| `test/architecture-gate.test.js`（扩展） | 断言 `main.js` 行数 ≤ 上限、`FORBIDDEN_IN_MAIN` 的模式确实不在 `main.js` 里 |
| `test/ipc-module-contracts.test.js`（扩展） | 新增的 `selection-ipc` / `ocr-ipc` 纳入通道顺序契约 |
| `test/selection-domain.test.js`（新增，阶段 3） | 注入假窗口/假设置，断言工具栏动作路由、流控制器生命周期、钩子事件转发 |

---

## 6. 风险与回滚

| 风险 | 评估 | 缓解 |
|---|---|---|
| 搬移改变启动时序（域在监听/托盘/hook 之前或之后初始化） | **高** | 每次搬移保持"同序同调用"；打包件启动核验抓这类回归 |
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
