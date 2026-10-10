# 实施方案：P0 七项「低成本高感知」空白补齐（含子智能体并行编排）

- 日期：2026-10-10
- 基线：`master` @ `b97391e`（`package.json` 版本 **2.3.1**，`main.js` **1298** 行 / 上限 **1300**）
- 状态：**方案已定稿；D1–D8 已确认（2026-10-10）；未开始编码**
- 上游：`docs/plans/2026-10-10-snow-apps-feature-gap-analysis.md`（能力差与优先级依据）
- 范围：P0-1 … P0-7 七项功能的实施路径、任务拆解、写作用域划分、并行编排与验收门禁；**另含批次间前置工程 D2（§3.4）**
- 影响面：`main.js`（仅 Lead 集成）、`shared/`、`main/services/`、`main/domains/`、`main/ipc/`、`config/`、`capture/`、`record/`、`pin/`、`native/smart-select/`、`test/`、`scripts/`

---

## 0. 执行摘要

### 0.1 总工作量与批次切分

**总账以 §4–§10 的任务表为唯一真相源逐项加总**（2026-10-10 经独立审查发现旧值"37–57"无法从任务表复现，此处重算并全文统一）：

| 功能 | 点值（人日） | 加总来源 |
|---|---|---|
| P0-4 打印 / 导出 PDF | 4.0 | §4.3（T1–T8） |
| P0-6 贴图点击穿透接线 | 3.0 | §5.3（T1–T6） |
| P0-7 体验细节包 | 6.5 | §6.1（T1–T8） |
| **批次 A 小计** | **13.5** | |
| P0-3 录屏音轨 | 7.0 | §7.3（T1–T8） |
| P0-5 标注元素二次编辑 | 5.75 | §8.4（PR1–PR4 + D4 落地项） |
| P0-2 光标进图（截图链路） | 6.0 | §9.3（T1–T6） |
| **批次 B 小计** | **18.75** | |
| P0-1 国际化 i18n | 16.75 | §10.4（T1–T8） |
| **批次 C 小计** | **16.75** | |
| **七项合计** | **49.0** | |

加上三处工程开销：

| 工程项 | 人日 | 加总来源 |
|---|---|---|
| Wave 0（M0 契约冻结与 `main.js` 腾挪） | 2–3 | §2 |
| 开工整理 M-1 | 0.5–1 | §1.2 |
| 批次间前置工程 D2（配置页路由拆分） | 3.75–6.5 | §3.4.2 |
| **程序总计** | **55.25–59.5 人日** | 49.0 + 2 + 0.5 + 3.75 = 55.25；49.0 + 3 + 1 + 6.5 = 59.5 |

> **口径说明**：(1) 上表点值为**估算中值**，非承诺工期；不含评审、等待与真机回归的排队时间。(2) 各功能若需**跨批次追加**，必须回到本表重算，不得只改局部数字——这正是旧值失真的原因。(3) 2026-10-10 之前的 `37–57`、`41–63.5`、`41.5–64.5` 三个版本均为**废值**，以本表为准。

交付节奏（三批次 + 一道前置工程）：

| 阶段 | 内容 | 人日 | 并行度 | 建议版本 |
|---|---|---|---|---|
| **M-1 开工整理** | 工作区洁净化：处理在制的 `selection-hook` 升级与构建产物噪声（§1.2） | **0.5–1** | 单流 | 开工前 |
| **Wave 0（M0）** | 契约冻结 + `main.js` 容量腾挪（§2） | **2–3** | 串行 | —— |
| **批次 A** | P0-4 打印/PDF、P0-6 贴图穿透接线、P0-7 体验细节包 | **13.5** | 高（Wave 1 三流写作用域互斥，见 §3.1） | v2.3.2 |
| **批次 B** | P0-3 录屏音轨、P0-2 光标进图（截图链路）、P0-5 标注二次编辑 | **18.75** | 中（`capture/**` 需串行） | v2.4.0 |
| **前置工程 D2** | `config/config.js` 按路由拆分（**D7 的硬前置**，无它则批次 C 要把 `config/` 改两遍） | **3.75–6.5** | 单流（`config/**` 独占） | 随 v2.4.x |
| **批次 C** | P0-1 i18n（α 框架+config+capture，β 其余窗口+主进程文案） | **16.75** | 高（互相独立窗口） | v2.5.0 |

> **两次总账修正**（均由 2026-10-10 旁路观察者指出，核实成立）：
> - **D2 补入**：此前它只在 §13 D7 中被当作"前置门"，**没有任务、没有 owner、没有工日**，而 i18n 的工期并不覆盖它 —— 批次 C 的真实前置成本因此长期不在总账内。核实与拆解见 §3.4。
> - **M-1 补入**：基线记的是 HEAD 提交而非干净工作区，开工前需先处理 3 项无关的在制改动，否则门禁读数不可比。见 §1.2。
>
> **第三次修正（2026-10-10 独立审查）**：上述三项补入之后，总数仍**无法从任务表复现**（旧值 37–57 与实际点值 49.0 相差 12）。根因是历次修正只改局部数字，从未按任务表重算一遍。本次已建立上表的"加总来源"列，任何数字变动都必须回填该列。

### 0.2 编排要点（本方案的核心机制）

1. **`main.js` 是 Lead 独占的集成写作用域**。各功能流**只交付模块**，需要的接线行写进 PR 说明，由 Lead 在收口波次统一接线。理由：`main.js` 仅剩 **2 行**余量（1298/1300，`scripts/check-architecture.js:18`），且 `FORBIDDEN_IN_MAIN` 禁止把域逻辑写回该文件。
2. **Wave 0 先冻结共享契约**：`main/services/settings-defaults.js` 与 `main/services/ipc-security.js` 被几乎所有工作流触碰，必须在任何并行开始前**一次性写全**，之后转为只读。这是避免 7 路互相踩踏的关键。
3. **独占写作用域（single-writer）**：同一时刻一个文件只有一个 owner。冲突面最大的三处——`main.js`、`capture/**`、`config/**`——采用"先后移交"而非"并发共享"。
4. **每个工作流 = 一个子智能体**，交付物统一为「代码 + 定向测试 + 门禁证据 + 接线说明」；全量门禁与真机验收只在波次收口由 Lead 执行。
5. **前置工程单独认领、单独估工**：`config/` 的路由拆分（D2）不是 i18n 的一部分，而是它的前置条件。任何"被某决策依赖但无人认领"的工作，都必须在 §3.4 这类小节里落到任务与工日，否则总账失真（2026-10-10 旁路观察者指出的一次真实缺口）。
6. **开工前工作区必须干净（M-1）**：本方案的基线是 `master @ b97391e`，但当前工作区带着 3 项与本文档无关的在制改动（`selection-hook` 依赖升级 + 一个被跟踪的构建产物二进制）。**不先处理，Wave 0 的第一个 PR 就会混入无关 diff，且所有门禁读数都来自非基线代码。** 执行选项与出口条件见 §1.2。

---

## 1. 共同约束（所有工作流必须遵守）

| # | 约束 | 出处 | 违反后果 |
|---|---|---|---|
| C1 | **不得向 `main.js` 添加业务逻辑** | `scripts/check-architecture.js:18,33-65` | 架构门禁直接失败 |
| C2 | 新增设置键**必须**先进 `main/services/settings-defaults.js` | `main/services/settings-validation.js:30` | 以"不支持的设置项"拒绝写入 |
| C3 | 新增 IPC 通道**必须**登记 `main/services/ipc-security.js` | `main/services/ipc-security.js:257` | 注册时直接抛错 |
| C4 | 自定义宽度/线宽等数值白名单**两端归一**（主进程只校验类型，不校验值域） | `settings-validation.js:33` | 非法值落盘 |
| C5 | 不修改 `capture/capture.js` 的两套坐标系语义（屏幕 CSS 坐标 vs 导出坐标） | 见 §8.3 | 导出与屏幕不一致 |
| C6 | 既有契约测试的**硬编码清单**（图标序列、通道 deepEqual、探针名单）改动需同步 | `test/capture-toolbar-icons.test.js:10-14`、`test/ipc-module-contracts.test.js:86-145`、`scripts/probe-diagnostics-runtime.js:16-21` | 门禁失败 |
| C7 | 可见测试窗口按 `AGENTS.md` 放**副屏**；无副屏先询问 | `AGENTS.md` | 打扰用户 |
| C8 | 全量 `npm test` / `npm run check` 只在波次收口由 Lead 跑；工作流只跑定向测试 | 避免 CPU 争抢与假失败 | —— |

### 1.1 门禁基线（收口时逐条核对）

| 门禁 | 当前基线 | 收口要求 |
|---|---|---|
| `npm test` | 106 个测试文件 | 全绿，新增用例计入 |
| `npm run check` | `main.js` 1298 行 | 语法全绿；`main.js` ≤ 1300 |
| `npm run test:coverage:loaded` | 行覆盖 ≥ 85% | 不下降 |
| `npm run test:coverage:critical` | 单文件 ≥ 90%（更新/诊断/窗口安全） | 不下降 |
| `npm run audit:dependencies` | 有白名单门禁 | 无新增豁免 |
| Playwright e2e | 2 个 spec | 全绿 |

### 1.2 开工前提：干净工作区（M-1，开工前核对）

> §1.1 是**收口**门禁（批次结束时逐条核对），本节是**开工**门禁（M0 开始前必须满足）。2026-10-10 旁路观察者指出，核实成立。**本节结论：M0 不能直接开工，需先插入 M-1。**

**现状（实测）**：文档基线写的 `master @ b97391e` 指的是 **HEAD**（该值准确），但**工作区并不干净** —— 带着 4 项未提交改动，其中 3 项由本文档之外的在制工作引入：

| 路径 | 差异 | 性质 | 来源 |
|---|---|---|---|
| `package.json` | `selection-hook` `^2.0.2` → **`^2.1.1`** | 依赖升级（在制） | 2026-10-07 依赖升级计划的遗留 |
| `package-lock.json` | 同上（4 增 4 删），且 `resolved` 由 `registry.npmjs.org` 变为 `registry.npmmirror.com` | 依赖升级（在制） | 同上 |
| `native/everything-search/bin/HighlighterEverything.exe` | `Bin 343552 → 343552 bytes`（**同尺寸、内容不同**） | **纯重建噪声**（Rust 边车被重新构建） | 同上 |
| `.gitignore` | +3 行（忽略 `_repo_snow_apps/`） | 本文档配套 | 本次 |

另有两份**未跟踪**的在制规划文档：`docs/plans/2026-10-08-selection-toolbar-app-blacklist-research.md`、`docs/plans/2026-10-09-selection-toolbar-centered-placement-design.md`。

**为什么必须先处理**：

1. **第一个 PR 的 diff 会混入无关改动**：Wave 0 的 W0-1 要改 `main.js` 与 `main/services/`；此时提交，diff 里会夹着依赖升级与二进制变更，评审无法聚焦。
2. **门禁读数失去可比性**：§1.1 基线与 §11 收口读数都要求"与文档记录的基线对照"；工作区跑出的 `npm test`、`npm run audit:dependencies`、覆盖率都来自**非基线代码**。
3. **二进制会被永久写进历史**：该 `.exe` 是构建产物（`native/everything-search/build.ps1:5,11,12` 产出），但**已被 git 跟踪**（`git ls-files` 确认），且与仓库对其它原生产物的策略**不一致** —— `.gitignore` 忽略 `native/smart-select/*.exe`、`native/ocr/*.exe`、`native/ocr/*.dll`，却放行 `native/everything-search/bin/`。
4. **依赖升级本身可能未验证**：`docs/plans/2026-10-07-dependency-upgrade-plan.md:168` 明确要求"升级后必须真机确认……划词 hook（selection-hook）仍能加载"。若该验证未做，M0 及批次 A/B 的划词相关测试都跑在**未验证的依赖**上。

**已核对的有利事实**（避免过度报警）：

- `node_modules/selection-hook` 实测已装 **2.1.1**，与 `package-lock.json` 一致 → 这是**已完成但未提交**的升级，**不是半应用状态**；
- `package-lock.json` 中 `registry.npmmirror.com` **早已存在**（8 个包，含 `ffmpeg-static`），新条目只是延续既有模式，**不构成新的问题类别**。

**M-1 执行选项**：

| 选项 | 内容 | 评价 |
|---|---|---|
| **A（推荐）** | 把 `selection-hook` 升级做成**独立提交**：① 按 `2026-10-07` 计划补划词真机验证；② `git checkout -- native/everything-search/bin/HighlighterEverything.exe` 丢弃重建噪声；③ 单独提交 `package.json` + `package-lock.json` | 历史干净、升级可追溯、门禁读数与基线可比 |
| B | `git stash` 暂存这批改动，M0 从 HEAD 干净开跑 | 可行，但升级验证被无限期推迟 |
| C | 保留现状直接开工 | **不推荐**：上述四个后果全部成立 |

**M-1 出口条件**：

1. `git status --porcelain` 中原有的 3 项非文档改动（`package.json`、`package-lock.json`、`*.exe`）**已提交或已丢弃**；
2. 工作区只剩本文档与 `.gitignore` 的改动（或它们也已提交）；
3. 若保留 `selection-hook` 2.1.1，须附**划词功能真机验证记录**。

**顺带记录的仓库策略问题（不在本方案范围，仅登记）**：`native/everything-search/bin/HighlighterEverything.exe` 是构建产物却被跟踪，且与其它原生产物的忽略策略不一致。理论上可 `git rm --cached` + 补 `.gitignore`（`prestart` 会经 `npm run build:everything` 重新产出）。**这属于仓库策略决策，建议单独立项，不要塞进 M-1。**

---

## 2. 前置波次：Wave 0（串行，必须先完成）

> Wave 0 不可并行：它写的是所有工作流都要读的共享文件。由 Lead 执行或指派**单个**子智能体，其余工作流等待。

| 任务 | 内容 | 写作用域 | 验收 |
|---|---|---|---|
| **W0-1 main.js 容量腾挪** | 抽出纯函数以腾出 ≥60 行余量：`normalizeSettings`（`main.js:264-276`）→ `main/services/settings-normalize.js`；`resolveFfmpegPath` → `main/services/ffmpeg-path.js`；`saveImageBuffer` 的对话框分支 → `main/services/image-file-save.js`。**必须同时改 3 处指向被抽走的 `main.js` 的源码断言**（见下） | `main.js`、`main/services/settings-normalize.js`（新）、`main/services/ffmpeg-path.js`（新）、`main/services/image-file-save.js`（新）、`test/design-tokens.test.js`（`:119`，`/resolveMainColor/` 指向 `main.js:273`）、`test/selection-toolbar-settings.test.js`（`:68`，指向 `main.js:266`）、`test/update-ui-contract.test.js`（`:14`，指向 `main.js:271`） | `main.js` ≤ **1240** 行；`npm run check` 绿；**上述 3 个测试文件全绿** |
| **W0-2 设置契约冻结** | 一次性写入**本期全部 15 个**新设置键（见 §2.1），此后本文件只读；同时**固化"加键流程"**（见 §2.1.1） | `main/services/settings-defaults.js` | `test/settings-validation.test.js` 全绿；每个新键有类型用例 |
| **W0-3 IPC 契约冻结** | 一次性登记**页面→主进程**的新通道（见 §2.2）。**主→渲染广播通道不进 `IPC_SURFACES`** | `main/services/ipc-security.js`、`test/ipc-security.test.js` | `assertComplete()`（`main.js:1173`）通过；`electron .` 可正常启动 |
| **W0-4 i18n key 规范** | 定义 key 命名（`<域>.<模块>.<语义>`）、`shared/locales/` 目录骨架与 `scripts/check-i18n.js` 的接口 | `shared/i18n.js`（骨架）、`shared/locales/*.js`（空表）、`scripts/check-i18n.js` | `node scripts/check-i18n.js` 可运行（此时允许报"未迁移"清单） |
| **W0-5 依赖决策** | 确认无需新增 npm 依赖（`ffmpeg-static`、`sharp`、`onnxruntime-node`、`jsqr` 已足够）；如确需新增，由 Lead 单独提交 `package.json` | `package.json`、`package-lock.json` | 若新增依赖须过 `audit:dependencies` |

### 2.1 冻结的设置键（W0-2 一次性写入）

> 键名沿 `main/services/settings-defaults.js` 既有风格：顶层域 + `camelCase`（`shortcuts` 域为扁平键，见 `:85-106`）。

```text
language                            : 'zh-CN'   // P0-1
screenshot.captureCursor            : false     // P0-2 截图带光标
screenshot.shutterSound             : true      // P0-7A 快门音（关掉则可静音）
screenshot.nameTemplate             : ''        // P0-7E 命名模板（空 = 沿用旧格式；见下方警告）
screenshot.lastSaveDirectory        : ''        // P0-7B 快速保存记忆目录
screenshot.keepSerialAcrossCaptures : false     // P0-7C 序号跨截图保留
record.audioSystem                  : true      // P0-3 系统声音
record.audioMicrophone              : false     // P0-3 麦克风（默认关闭，隐私）
record.audioSystemGain              : 1         // P0-3
record.audioMicrophoneGain          : 1         // P0-3
record.captureCursor                : false     // P0-2（录屏光标；本期只占位，见 §9.3 范围说明）
pinned.clickThrough                 : false     // P0-6 贴图穿透默认关
shortcuts.screenshotQuickSave       : ''        // P0-7B 快速保存（默认留空，避免抢占系统热键）
shortcuts.screenshotSaveAs          : ''        // P0-7B 另存为（同上）
shortcuts.togglePinClickThrough     : ''        // P0-6-T4 穿透退出兜底热键（同上）
```

> **⚠️ 关键修正（2026-10-10 独立审查发现）**：`screenshot.nameTemplate` 的默认值原写 `'{date}-{time}'`，与 `main/services/capture-naming.js:12` 的 `OWNED_CAPTURE_FILE` 正则（`^Highlighter(?:_Long)?_\d{4}-…`）**不匹配** —— 非空默认会让每一张新截图都被历史库判定为"非本应用"，进而影响列表、删除与迁移。默认值必须是 `''`（沿用旧格式）；**非空模板必须与所有权正则同源**（见 R9）。
>
> 新增键必须**同时**进设置归一化路径（W0-1 后位于 `main/services/settings-normalize.js`，原 `main.js:264-276`）。

### 2.1.1 加键流程（Wave 0 冻结之后的唯一合法路径）

Wave 0 冻结 `settings-defaults.js` 与 `ipc-security.js` 是为了防止并发写冲突，**不是禁止新增**。冻结后如需新键/新通道（例如某工作流在实施中才发现缺口），按以下流程：

1. **发起**：工作流**停止编码**，向 Lead 提交一条"契约变更请求"，内容为：键名 / 默认值 / 类型 / 用途 / 发起功能 / 为什么不能复用已有键。
2. **串行执行**：Lead 在**当前波次全部 owner 都处于暂停或已完成**时，以**单一提交**追加键或通道，并同步 `test/settings-validation.test.js` 或 `test/ipc-security.test.js` 的用例。
3. **广播**：Lead 向该波次所有活跃 owner 发一条变更通知（键名 + 默认值）。
4. **禁止**：任何工作流**不得**自行修改这两个文件；发现需要新键时**不得**改用"临时不落盘"等绕过手段（`settings-validation.js:30` 会以"不支持的设置项"直接拒绝）。

> 本流程的存在是 2026-10-10 独立审查的产物：此前 W0-2 宣称"此后只读"，而 §6.1 的 P0-7-T3 与 §5.3 的 P0-6-T4 都必须新增键 —— 形成一个**死锁**。现已把所需键一次性补进 §2.1，并留下这条合法回路。

### 2.2 冻结的 IPC 通道（W0-3 一次性登记）

`main/services/ipc-security.js` 的 `IPC_SURFACES` **只登记"页面→主进程"方向的通道**（每条 surface 只有 `handles`（`invoke`）与 `listeners`（`send`）两个字段）。`main.js:1173` 启动即调用 `assertComplete()`。

> **⚠️ 关键修正（2026-10-10 独立审查发现）**：`pin:click-through-changed` 与 `i18n:language` 是**主→渲染广播**（走 `webContents.send`），**不能**登记进 `IPC_SURFACES`：登记后没有对应的注册点，`assertComplete()` 会直接抛错，`electron .` 与 `scripts/probe-diagnostics-runtime.js:95` 的 `require('../main')` 全部挂掉。实测 `pin:init`、`search:status-changed` 等 23 个既有广播通道都**不在** `IPC_SURFACES` 中，与此一致。

**需登记（页面→主进程）：**

| 通道 | 角色 | 用途 | 归属 |
|---|---|---|---|
| `capture:export-pdf` | `capture` | 截图导出 PDF | P0-4 |
| `pin:set-click-through` | `pin` | 显式设置穿透（替代旧 `pin:toggle-click-through`） | P0-6 |

**不登记（主→渲染广播，随各波次自行实现，不走 `IPC_SURFACES`）：**

| 通道 | 方向 | 用途 | 归属 |
|---|---|---|---|
| `pin:click-through-changed` | 主→渲染 | 穿透状态回执 | P0-6 |
| `i18n:language` | 主→渲染广播 | 语言切换广播到 11 个窗口 | P0-1 |

> 旧通道 `pin:toggle-click-through`（`main/domains/pin/index.js:448-453`）在 P0-6 中**删除**，避免双通道共存。
>
> W0-3 的验收从"未见通道列表为空"改为"**`assertComplete()` 通过且 `electron .` 可正常启动**"，因为前者对广播通道是伪要求。

---

## 3. 并行编排总览

### 3.1 独占写作用域表（冲突规则）

> **2026-10-10 重写**。初版按"文件/目录"粗粒度授权，独立审查发现同波次存在 3 组真实重叠（`capture-naming.js`、`function-router.js`、`main/domains/capture/index.js`），且"批次 A 三流零交集"的断言不成立。本节改为**按文件精确授权**，并以 §3.1.1 的注册表作为唯一 owner 来源。

**单写者文件（同一时刻只有一个 owner，须顺序移交）：**

| 文件/目录 | owner 顺序 | 规则 |
|---|---|---|
| `main.js` | Lead（W0-1）→ Lead（各收口波次） | 任何工作流禁止直接写；接线行写入 PR 说明 |
| `main/services/settings-defaults.js` | Lead（W0-2）→ 冻结只读 | 新键走 §2.1.1 加键流程 |
| `main/services/ipc-security.js` | Lead（W0-3）→ 冻结只读 | 同上 |
| `package.json` / `package-lock.json` | Lead | 含 c8 `--include` 增改 |
| `main/services/capture-naming.js` | **S7**（批次 A W1） | P0-4-T6 与 P0-7-T1 都要改它 → **统一归 S7**；P0-4 只调用不修改 |
| `main/services/function-router.js` | **S7**（批次 A W1） | P0-6-T4 与 P0-7-T3 都要改它 → **统一归 S7**；P0-6 提供接口约定 |
| `main/domains/capture/index.js` | **S4**（批次 A W1）→ **S9a**（批次 A W2）→ **S6**（批次 B W6）→ **S9b**（批次 B W7） | 四个写点串行，见 §3.1.1 |
| `capture/**`（含 `capture.html/js/css`、`annotation-geometry.js`） | **S9a**（A W2）→ **S6**（B W6）→ **S9b**（B W7） | 批次 A 的所有 `capture/**` 改动**推迟到 W2 的 S9a** |
| `config/**` | **S10a**（A W2）→ **S10b**（B W7.5）→ **S1**（C W9）→ **S14** | 四个写点串行 |
| `shared/i18n.js`、`shared/locales/**` | **S1**（批次 C） | Wave 0 之后归 S1 |
| `record/**` | **S2**（B W4）→ S7? 无 | 批次 B 独占 |
| `pin/**`、`main/domains/pin/**`、`preload-pin.js` | **S3**（批次 A W1） | 批次 A 独占 |
| `native/smart-select/**` | **S5**（批次 B W4） | 批次 B 独占 |
| `main/services/pdf-export.js`、`capture/print.html` | **S4**（批次 A W1） | 新建文件，不与 `capture/**` 冲突（S9a 只读它） |

**关键改动（相对初版）**：

1. `capture-naming.js`、`function-router.js` 从"多 owner"改为**单 owner（S7）**；P0-4-T6 与 P0-6-T4 相应改为**由 S7 承接**的相邻任务。
2. 批次 A 中所有 `capture/**` 与 `config/**` 的改动**移出 Wave 1**，推入 Wave 2 的 S9a / S10a，消除与 S3/S4/S7 的重叠。
3. §0.1 中"三流零交集"的表述**已删除**，改为"Wave 1 三流写作用域互斥（见 §3.1.1）"。

### 3.1.1 工作流注册表（S 编号的唯一来源）

| S | 波次 | 内容 | 独占写作用域 | 交付物 |
|---|---|---|---|---|
| **S1** | C·W9 | i18n 框架 + `config/` 全量迁移 | `shared/i18n.js`、`shared/locales/**`、`scripts/check-i18n.js`、`config/**` | 框架 + 三语 + config 迁移 + 漏译门禁 |
| **S2** | B·W4 | 录屏音轨 | `record/**`、`main/services/recording-service.js` | 音轨采集与混流 + ffmpeg 参数 + 定向测试 |
| **S3** | A·W1 | 贴图点击穿透接线 | `main/domains/pin/**`、`preload-pin.js`、`pin/**` | 显式 set + 回执 + 角标 + 纯函数 + 测试 |
| **S4** | A·W1 | 打印 / 导出 PDF（主进程） | `main/services/pdf-export.js`（新）、`capture/print.html`（新）、`main/domains/capture/index.js`、`main/ipc/capture-ipc.js`、`preload-capture.js`、`test/pdf-export.test.js` | 导出能力 + IPC + 纯函数 + 接线说明 |
| **S5** | B·W4 | 光标原生采集 | `native/smart-select/**`、`main/services/cursor-provider.js`（新）、`shared/cursor-geometry.js`（新）、`test/cursor-geometry.test.js` | C# `cursor` 命令 + 位置解析 + 纯几何 |
| **S6** | B·W6 | 标注元素二次编辑 | `capture/**`（除 `print.html`）、`main/domains/capture/index.js` | PR1–PR4 + 快照栈 + `annotation-geometry.js` |
| **S7** | A·W1 | 体验细节（主进程部分） | `main/services/capture-naming.js`、`main/services/function-router.js`、`main/services/tray-menu.js`、`main/services/shortcut-*.js`、`shared/shortcut-keys.js`、`scripts/probe-diagnostics-runtime.js`、`test/capture-naming.test.js`（新）、`test/function-router.test.js` | 命名模板 + 快捷键 handler + 兜底热键 + 探针名单 |
| **S9a** | A·W2 | 批次 A 的 `capture/**` 接线 | `capture/**`、`assets/shutter.wav`（新）、`main/domains/capture/index.js` | 打印按钮 + 快门音 + Ctrl+A + 序号 + saveMode |
| **S10a** | A·W2 | 批次 A 的 `config/**` 收口 | `config/**` | 快门音/命名模板/两个快捷键/穿透开关的设置项 |
| **S10b** | B·W7.5 | 批次 B 的 `config/**` 收口 | `config/**` | 录屏音频/光标开关的设置项与文案 |
| **S9b** | B·W7 | 批次 B 的 `capture/**` 接线 | `capture/**`、`main/domains/capture/index.js` | 光标合成接线 |
| **S11** | C·W9 | i18n：`capture/` 窗口 | `capture/**` | capture 窗迁移 |
| **S12** | C·W9 | i18n：其余渲染窗 | `record/**`、`long-capture/**`、`action/**`、`search/**`、`recognition/**`、`toolbar/**` | 六窗迁移 |
| **S13** | C·W9 | i18n：主进程文案 | `main/services/tray-menu.js`、`main/services/update-service.js`、`main/services/everything-service.js`、`main/services/ai/client.js`、`main/services/function-router.js` | 托盘/更新/状态/错误文案（不含 `throw`，见 D6） |
| **S14** | A/B 之间·W8.5 | D2 配置页路由拆分 | `config/**`、`test/helpers/config-source.js`（新）、15 个 config 耦合测试的读取行 | 路由拆分 + 测试解耦 |

> **S 编号说明**：`S9a/S9b` 是同一个 `capture/**` 写点在**两个不同批次**的两次占用，不是两个并行 owner；`S1α` 已取消，批次 C 拆为 S1/S11/S12/S13 四路。**每个波次内，上表任一文件只能有一个 owner**。

### 3.1.2 波次失败处置与回滚纪律

初版未定义，独立审查指出这是缺口。规则：

1. **半成品不得合并**：任何工作流若未通过自己的定向测试与 `npm run check`，其分支不得并入该波次收口。
2. **单流失败不阻塞同波次其他流**：某流失败时，Lead 在收口波次仅合并已通过的流，失败流**退出本波次**并进入下一波次重排；**不得**为凑齐进度而放宽验收。
3. **写作用域污染即回滚**：若发现某流改动了作用域外的文件，Lead 丢弃该流全部改动并重新派发（不尝试局部保留）。
4. **契约冻结后不可回退**：W0-2/W0-3 一旦冻结，本方案周期内不撤销；确需变更走 §2.1.1。
5. **大爆炸搬迁必须可逐步验证**：D2（S14）按 §3.4 的 D2-1→D2-5 顺序，每一步独立提交、独立跑门禁；`config/config.js` 的搬迁**不允许**一个提交改完全部路由。
6. **每波次收口必须重跑 §1.1 全部门禁**，不接受"上一次跑过"。记录基线↔收口的读数差（供 §11 回填）。

### 3.2 波次编排

```text
Wave 0  [串行]  W0-1 → W0-2 → W0-3 → W0-4 → W0-5
                      ↓ 契约冻结
Wave 1  [并行 ×3]  S4 打印/PDF 主进程 | S3 贴图穿透 | S7 体验细节主进程
                      ↓        （三流写作用域互斥，见 §3.1.1）
Wave 2  [并行 ×2]  S9a capture/** 接线（打印按钮、快门音、Ctrl+A、序号、saveMode）
                   S10a config/** 收口（快门音/命名模板/两快捷键/穿透开关）
                      ↓
Wave 3  [Lead]      main.js 集成接线 + §1.1 全量门禁 + 真机验收   →  批次 A 发布 (v2.3.2)

Wave 4  [并行 ×2]  S2 录屏音轨（record/** 独占） | S5 光标原生（native/** 独占）
                      ↓
Wave 5  [Lead]      main.js 接线（setDisplayMediaRequestHandler、光标 provider 注入）
                      ↓
Wave 6  [S6]        标注二次编辑（capture/** 独占，PR1–PR4 串行）
                      ↓
Wave 7  [S9b]       capture/** 光标合成接线（依赖 W6 释放）
                      ↓
Wave 7.5[S10b]      批次 B 的 config/** 收口（录屏音频、光标开关）
                      ↓
Wave 8  [Lead]      §1.1 全量门禁 + 真机验收                     →  批次 B 发布 (v2.4.0)

Wave 8.5 [S14]      D2 配置页路由拆分（§3.4；config/** 独占）     →  随 v2.4.x
                      ↓  ← 批次 C 的硬前置门（D7）
Wave 9  [并行 ×4]  S1 i18n 框架+config | S11 capture 窗 | S12 其余渲染窗 | S13 主进程文案
                      ↓
Wave 10 [Lead]      §1.1 全量门禁 + 真机（三语言切换）             →  批次 C 发布 (v2.5.0)
```

> Wave 1 只放三路而不是五路，是因为 S2（`record/**`）与 S5（`native/**`）属于批次 B，且批次 A 优先交付以尽早产生用户价值。
>
> **Wave 7.5 与 Wave 8.5 是串行插入的小波次**，不与其他流并行——它们的写作用域（`config/**`）在同一时刻必须唯一。
>
> **录屏光标已移出本期**：初版把"录屏光标"（原 S8）列在 Wave 7，但它既无任务表、也无 IPC 通道与 `preload-record.js` 改动，**不可派发**。现已改为 P1 延期项（见 §9.3），批次 B 因此不含它的 3–4 人日。
>
> **Wave 9 的前置门（D7）**：`docs/plans/2026-09-10-v2.3-architecture-roadmap.md` 的 **Phase D2（`config/config.js` 按路由拆为 `config/routes/*.js`）必须已完成**。否则 `config/` 要先后被 D2 与 i18n 改造两遍，返工面 ≈660 条文案。
>
> **该前置门由 Wave 8.5 兑现，工日 3.75–6.5，独立于批次 C 的 16.75 人日**（§3.4）。2026-10-10 前它在本方案中是无主的，属真实缺口。

### 3.3 子智能体工作规约（派发时逐条写入任务描述）

1. **只读勘察先行**：动手前先给出"现状证据（`文件:行`）+ 改造点清单"，与本方案第 §4–§10 的对应小节核对，有偏差先报告再改。
2. **写作用域硬约束**：只允许修改 §3.1.1 注册表中**分配给自己的**路径；发现需要改动作用域外的文件，**停下来上报**，不得自行扩权（处置见 §3.1.2 第 3 条）。
3. **交付物固定五件套**：① 代码；② 新增/修改的定向测试（`test/<feature>.test.js`）；③ 门禁证据（定向测试输出、`npm run check` 输出）；④ **接线说明**（列出需要在 `main.js` 增加的确切行与上下文）；⑤ **验收自证**（逐条对应本节功能小节的 `**验收标准**`，给出可复现的验证命令或截图路径）。
4. **禁止并发写同一文件**；禁止并发跑全量 `npm test`（只跑自己相关的测试文件）；全量门禁只在收口波次由 Lead 执行。
5. **禁止改 `main/services/settings-defaults.js` 与 `main/services/ipc-security.js`**（Wave 0 已冻结）；需要新键/新通道时按 **§2.1.1 加键流程**上报 Lead，**不得**绕过（`settings-validation.js:30` 会以"不支持的设置项"直接拒绝）。
6. 可见窗口一律副屏；无副屏先问。
7. **前置工程优先解耦测试**：任何涉及大规模代码搬迁的工作流（S14/D2），必须**先**建立测试读取层，再搬迁；否则会重演 `main.js` 拆分时"147 处源码文本断言挡路"的老问题。
8. **覆盖率与架构门禁自觉登记**：新增的 `main/services/*` 文件会自动进入 `test:coverage:loaded` 的 `--include=main/services/**` 分母（`package.json:14`），因此**必须自带测试**；`capture/`、`shared/` 下新增的纯函数模块若不在任何 `--include` 中，须在 PR 说明里提请 Lead 追加（`package.json` 为 Lead 独占）。
9. **源码文本断言同步**：改动任何被 `test/*.test.js` 以正则断言的文件（清单见各功能小节的"耦合测试"行）时，**必须同一 PR 内同步改动断言**，不得留待收口。

### 3.4 批次间前置工程：D2 配置页路由拆分（Wave 8.5）

> 本节为 2026-10-10 旁路观察者指出后补入。**核实结论：缺口成立，且实际成本大于观察者描述。**

#### 3.4.1 为什么单独立项

| # | 事实 | 证据 |
|---|---|---|
| 1 | v2.3 路线图把 D2 标为**"部分完成：纯 model helpers 已抽出；整页 render 拆分待后续"** | `docs/plans/2026-09-10-v2.3-architecture-roadmap.md:17` |
| 2 | `config/routes/` 目录**已存在**，但只有 `model-helpers.js`（39 行） | `config/routes/model-helpers.js` |
| 3 | `config/config.js` 实测 **1829 行 / 122.8 KB**，比路线图基线（约 1575 行）**又长了 254 行** | 本次实测 |
| 4 | **本方案的 i18n 工期（16.75 人日）只覆盖 i18n 本身**；D7 所依赖的 D2 此前既无任务、无 owner、也无工日 | 本方案 §0.1 |
| 5 | **额外成本（观察者未提及）**：15 个测试文件用 `fs.readFileSync('config/config.js')` + `assert.match` **对源码文本断言**，这些文件共 **575 处 assert**（其中**约 170 处**指向 config.js 源码）；D2 会让其中指向 config.js 的断言失败 —— 与当年 `main.js` 拆分的耦合问题同类 | 见下表 |

**耦合的 15 个测试文件**（括号内为该文件**全部** assert 数，非全部指向 config.js；按总数降序）：

`data-root-ui-contract`(108，其中 13 指向 config.js) · `recording-ui-contract`(75，2) · `model-config-ui-contract`(69) · `selection-toolbar-settings`(52) · `history-management-ui`(51) · `design-tokens`(46，0) · `selection-toolbar-thinking`(44) · `shortcut-ui-contract`(29) · `config-model-helpers`(18) · `update-ui-contract`(18) · `game-mode-contract`(16，2) · `toolbar-icons`(16，2) · `diagnostics-ui-contract`(15) · `config-icon-contract`(9) · `branding-copy`(9)。

#### 3.4.2 D2 剩余工作量估算

| 子项 | 内容 | 人日 |
|---|---|---|
| **D2-1 测试解耦（必须先做）** | 新增 `test/helpers/config-source.js`，导出 `readConfigSource()`（拼接 `config/config.js` + `config/routes/*.js`）；把 15 个测试文件的读取行改为该 helper。**这一步把"指向 config.js 的 ~170 处断言"的成本压到"15 行改动"** | 0.5–1.0 |
| **D2-2 路由拆分** | 按 `renderRoute()`（`config/config.js:264`）把 10 个 render 函数迁到 `config/routes/*.js`，主壳只留导航与路由分发 | 2.5–4.0 |
| **D2-3 巨型路由再分解** | `renderHistory`（`config/config.js:398-724`，**326 行**）单函数即超 300 行验收线，需进一步分解。**注意**：`renderSelectionToolbarSettings` 实际只有 **144 行**（`:724-867`），初版误记为 459 行（把 `:1183` 的 `renderModelsSubnav` 起点当成了它的末尾）——"按路由拆不足以达标"的结论仍成立，但依据只剩 `renderHistory` 一个 | 含在 D2-2，但列为独立风险 R12 |
| **D2-4 文件边界断言修正** | `test/config-model-helpers.test.js:20`（"config.js delegates pure model helpers"）、`test/model-config-ui-contract.test.js:72`（script 顺序）等描述"谁在哪个文件"的断言需真实修改；另 `test/design-tokens.test.js:156` 的文件清单需同步 | 0.25–0.5 |
| **D2-5 验收** | 8 个设置路由页逐个打开无报错 + `npm test` / `npm run test:e2e` 绿 | 0.5–1.0 |
| **合计** | | **3.75–6.5** |

> **口径修正（2026-10-10 独立审查）**：§3.4.1 第 5 条曾以"**575 处 assert**"描述 D2 的破坏面。575 是那 15 个测试文件的**全部** assert 数（算术无误），但其中**指向 `config/config.js` 源码的只有约 170 处**——其余断言指向 `main.js`、`settings-defaults.js`、`preload.js`、CSS 等。例如 `recording-ui-contract` 75 处中仅 2 处、`data-root-ui-contract` 108 处中仅 13 处、`design-tokens` 46 处中仅 0 处（该文件只有 2 条 emoji 断言读 config.js）指向 config.js。**D2 的真实破坏面是 ~170 处，不是 575 处**；D2-1 的"15 行改动"结论不受影响。

#### 3.4.3 排期结论（**D8 已确认，2026-10-10**）

**建议：D2 作为 Wave 8.5，排在批次 B 收口之后、批次 C 开工之前。**

| 理由 | 说明 |
|---|---|
| 不让批次 A 被架构工作阻塞 | 批次 A（13.5 人日）是三个批次里最快产生用户价值的一批，不值得为 D2 让路 |
| 满足 D7 | D2 仍在 i18n 之前，`config/` 不会被两轮全量改造 |
| 已接受的代价 | S10a（批次 A）与 S10b（批次 B）新增的约 8–10 个设置控件（约 80–120 行）会被 D2 机械搬运一次；可提前要求二者按 route 化写法落位以减少搬运 |
| 收益 | i18n 的 `config/` 迁移（T3，3.5 人日）从 **1829 行单体**变为 **≤300 行/文件的并行改造**，有望回收部分工期 |

**未采纳的备选**：

| 备选 | 代价 | 何时应改选它 |
|---|---|---|
| **D2 紧跟 Wave 0（批次 A 之前）** | 批次 A 延后 3.75–6.5 人日；D2 期间 15 个测试要先改 | 若你把"零返工"看得比"批次 A 早交付"更重要 |
| **取消 D2，i18n 直接改 1829 行单体** | 省下 3.75–6.5 人日；但 D2 是 v2.3 路线图的既定目标，迟早要付；且单体上 i18n 无法并行，`scripts/check-i18n.js` 的逐批收紧更难 | 若 v2.3 路线图本身要被废弃/重写 |

**D2 写作用域（独占）**：`config/**`、`test/helpers/config-source.js`（新）、上述 15 个测试文件的**读取行**。开工时 `config/**` 必须已从 S10a/S10b/S1 手中释放。


---

## 4. P0-4 打印 / 导出 PDF（批次 A）

### 4.1 现状与目标

**源码 grep `打印|printToPDF|window.print` 零命中**（`docs/` 内的规划文档出现过这些词，因此准确说法是"源码零命中"），属全新能力。目标：截图（以及贴图、识别结果窗口）可导出 PDF，并支持系统打印。

### 4.2 技术路径（已核实）

- **主路径 `webContents.printToPDF()`**：静默、无打印机依赖、可注入 mock。**不**建议自写 PDF（依赖里只有 `sharp`，无 PDF 库）。
- **离屏窗口**：新建 `capture/print.html`（单图 `<img>` + `@page` 样式），`show:false`；CSP 需含 `img-src data: blob:`（参照 `capture/capture.html:5`）。
- **复用现有安全窗工厂**：`main/services/window-security.js:18-28` 强制绝对 preload 路径 → 复用 `preload-capture.js` 即可；该页不发 IPC，无需额外授权。
- **复用已渲染窗口**：贴图 `main/domains/pin/index.js:338-340,400`、识别 `main/domains/recognition/index.js:22-51` 可直接 `win.webContents.printToPDF()`，无需临时窗口。
- **页码参数**：`pageSize:'A4'`、`landscape = w > h`、`printBackground:true`、`scale = min(1, 可打印区/固有尺寸)`；"原图尺寸"用 `pageSize:{width,height}`（单位**微米** = 英寸 × 25400），并夹到 Chromium 200 英寸上限。

### 4.3 任务拆解

| 任务 | 内容 | 写作用域 | 依赖 | 人日 |
|---|---|---|---|---|
| P0-4-T1 | 新增纯模块 `main/services/pdf-export.js`：`computePaperOptions({pxW,pxH,dpi,mode})`、`exportPdfBuffer(buffer,opts)`、`exportWindowToPdf(win,opts)` | `main/services/pdf-export.js`（新） | W0 | 1.0 |
| P0-4-T2 | 新增离屏页 `capture/print.html`（**只新建，不改 capture 其余文件**） | `capture/print.html`（新） | W0 | 0.25 |
| P0-4-T3 | 纯函数单测：纸张换算（A4/横向/原图/超限夹取）、命名 | `test/pdf-export.test.js`（新） | T1 | 0.5 |
| P0-4-T4 | 域工厂内新增 `exportPdf`（依赖注入 `printToPdf`/`savePdfBuffer`，便于 mock） | `main/domains/capture/index.js` | T1 | 0.5 |
| P0-4-T5 | IPC 接线：`main/ipc/capture-ipc.js` 注册 handler；`preload-capture.js` 暴露 `exportPdf`；**接线说明**：`main.js` 需注入 dep | `main/ipc/capture-ipc.js`、`preload-capture.js` + PR 说明 | W0-3、T4 | 0.5 |
| P0-4-T6 | 文件名复用 `main/services/capture-naming.js:15-19`，扩展 `makeCaptureName(prefix, ext)` | `main/services/capture-naming.js` | P0-7-T1 | 0.25 |
| P0-4-T7 | 契约测试更新：`test/capture-toolbar-icons.test.js:10-14,19`（新增 print 图标）、`test/ipc-module-contracts.test.js:86-145` | 上述测试文件 | T5 | 0.5 |
| P0-4-T8 | 真机验证：隐藏窗口 `printToPDF` 产物可打开、尺寸正确；可见窗口按 AGENTS.md | 验收记录 | 全部 | 0.5 |

**验收标准**：截图工具栏出现"导出 PDF"图标 → 点击后弹出保存对话框 → 产物 PDF 尺寸/方向与图片宽高比一致；贴图与识别结果窗口可复用同一函数；`npm run check` 绿。

**风险**：① 超长图（长截图可达 20000px）触发 200 英寸上限 → 需缩放或分页，T1 必须夹取并单测；② DPI 导致尺寸偏差 → 用 `scaleFactor` 校正；③ 离屏窗口未销毁泄漏 → `closed` 钩子兜底。

---

## 5. P0-6 贴图点击穿透接线（批次 A）

### 5.1 现状：三件套齐备，只差渲染层

| 环节 | 位置 | 状态 |
|---|---|---|
| 主进程 | `main/domains/pin/index.js:448-453` `ipcMain.on('pin:toggle-click-through')` | ✅ 翻转 `_pinData.clickThrough` + `setIgnoreMouseEvents(bool,{forward:true})`，**无回执** |
| preload | `preload-pin.js:29` `toggleClickThrough` | ✅ |
| 策略 | `main/services/ipc-security.js:112-126`（role `pin`） | ✅ |
| 初值 | `main/domains/pin/index.js:138` `clickThrough:false` | ✅ |
| **渲染层** | `pin/pin.js`（133 行）、`pin/pin.html`（14 行） | ❌ **零引用** |

### 5.2 退出穿透的方案（这是本项的真正难点）

穿透后窗口收不到鼠标事件，**必须有可靠退出路径**：

- **方案 B（主）hover 自解锁**：`forward:true` 只转发 mousemove、不转发点击/滚轮；窗口无法只挖一个小洞，只能"mousemove 命中预留角标 → `setClickThrough(false)`"。风险：透明无边框窗在部分数位板驱动下会丢 mousemove（[electron#40213](https://github.com/electron/electron/issues/40213)）。
- **方案 C（必做兜底）**：全局快捷键 + 托盘菜单，复用 `main/services/shortcut-service.js:86` 与 `main/services/function-router.js:72-75` 的现成范式、`main/services/tray-menu.js:26`。穿透态无键盘焦点，Esc 不可靠，故 C 不可省。
- **方案 A（后续）**：独立控制条窗口（Snow Shot 同构：`screenshotpinnedwindow.cpp:7302-7368` 的 exit/move/opacity 三控件），需新页面 + 新 IPC 角色，成本 1.5–2.5 人日，本期不做。

### 5.3 任务拆解

| 任务 | 内容 | 写作用域 | 依赖 | 人日 |
|---|---|---|---|---|
| P0-6-T1 | 主进程：`pin:set-click-through`（**显式布尔** + 回执 `pin:click-through-changed`）；穿透时 move/resize 早退；**删除**旧 `toggle` 通道 | `main/domains/pin/index.js` | W0-3 | 0.5 |
| P0-6-T2 | preload：换 `setClickThrough(bool)` / `onClickThroughChanged(cb)`，删旧 `toggleClickThrough` | `preload-pin.js` | T1 | 0.25 |
| P0-6-T3 | 渲染层：右键菜单项（模板取透明度 radio `main/domains/pin/index.js:389-397`）+ 穿透态 `#clickThroughTag` 角标（样式复用 `pin/pin.css:11` 的 zoomBadge） | `pin/pin.js`、`pin/pin.html`、`pin/pin.css` | T2 | 0.75 |
| P0-6-T4 | 兜底出口：全局快捷键 + 托盘"取消全部穿透"（多贴图上限 20，需批量入口） | `main/services/function-router.js`、`main/services/tray-menu.js` + 接线说明 | T1 | 0.5 |
| P0-6-T5 | 纯函数抽取与单测：`getRotatedPinSize`、`normalizePinRotation`、`hitTestPinHotspot` | `main/domains/pin/geometry.js`、`test/pin-geometry.test.js` | —— | 0.5 |
| P0-6-T6 | 契约测试：`test/pin-domain.test.js:35`、`test/ipc-security.test.js:143-175`、`test/capture-ocr-pin-ui.test.js:28-42` 同步 | 上述测试文件 | T1–T4 | 0.5 |

**验收标准**：开启穿透后底层应用能收到点击；角标或快捷键/托盘**必定**能退出；穿透态下拖动/缩放被禁用；`test/capture-ocr-pin-ui.test.js:35-42`（禁止 overlay 滑块）**不被破坏**。

**风险**：hover 退出不可靠 → C 方案必须落地；多贴图需批量入口；既有测试刻意禁止 overlay 滑块，新增 UI 不得违反。

**后续（批次 B/C）**：旋转/翻转（1.5–3 人日，渲染层 CSS transform + 窗口尺寸纯函数换算）、锁定（0.5–1）。**D5 已确认**：旋转先做 **仅预览**，不重编码回写 `_pinData.dataUrl`（回写会干扰 `getPixelAlignedPinSize` / `syncPinDisplayScale`，`main/domains/pin/index.js:66-87`）。

---

## 6. P0-7 体验细节包（批次 A）

五项互相独立，可并行到人，但共享同一批文件，故由**一个**子智能体串行完成（PR1–PR3）。

### 6.1 任务拆解

| 任务 | 内容 | 关键落点 | 人日 |
|---|---|---|---|
| **P0-7-T1 命名模板** | 纯函数 `renderNameTemplate` / `sanitizeFileName` / `ensureUniqueName`；`makeCaptureName` 接模板参数，**老设置回退旧格式** | `main/services/capture-naming.js:15-19` | 2.0 |
| P0-7-T2 | **关键约束**：`OWNED_CAPTURE_FILE`（`capture-naming.js:12`）被 `history-service.js:49-52` 用于判定文件所有权；模板必须与所有权正则**同源**，否则历史文件被判为"非本应用" | 同上 | （含在 T1） |
| P0-7-T3 快捷键模板 | 通用改动 9 步（见 §6.3）；新增 `screenshotQuickSave` / `screenshotSaveAs` 两个 handler | `main/services/function-router.js:32`、`settings-defaults.js:85-106`、`config/config.js:41-77` | 1.5 |
| P0-7-T4 保存模式贯通 | `_captureInit` 增 `saveMode`；`capture.js:621` 改为 `saveMode ? saveMode==='fast' : !!settings.screenshot.fastSave`；保存成功后回写 `lastSaveDirectory` | `main/domains/capture/index.js:316-332`、`capture/capture.js:621` | 0.5 |
| P0-7-T5 快门音 | `<audio id="shutterSound">` + `onInit` 播放；**CSP `media-src` 补 `file:`**（`capture.html:5` 现为 `'self' blob:`）；`webPreferences` 加 `autoplayPolicy:'no-user-gesture-required'` | `capture/capture.html:5`、`capture/capture.js:700-709`、`main/domains/capture/index.js:266-269`、`assets/shutter.wav`（新） | 0.75 |
| P0-7-T6 Ctrl+A 选当前屏 | 键盘分支加 `Ctrl+A` → `selection={...imageDisplayBounds()}`；`displayBounds`/`captureBounds` 已由 `main/domains/capture/index.js:216-219,321-322` 下发 | `capture/capture.js:688-698` | 0.5 |
| P0-7-T7 序号重置 | 显式重置写入 `onInit`（现 `capture.js:58` 为模块级 `let serialNumber = 1`；因每次截图新建窗口**本就不会累积**，此项是"显式化 + 可选跨截图保留"） | `capture/capture.js:58,701` | 0.25 |
| P0-7-T8 | 测试：新增 `test/capture-naming.test.js`（该文件**当前无测试**）；`test/function-router.test.js:100-115` 旁加用例；`scripts/probe-diagnostics-runtime.js:16-21` 名单补新 handler | 上述文件 | 1.0 |

**合计 = 6.5 人日**（2.0 + 1.5 + 0.5 + 0.75 + 0.5 + 0.25 + 1.0；P0-7-T2 已含在 T1）。

**验收标准**：① 命名模板非空时导出文件名符合模板，且**该文件仍被历史库识别为"本应用所有"**（`OWNED_CAPTURE_FILE` 同源）；非法字符与 Windows 保留名被 sanitize；重名不静默覆盖。② 两个新全局快捷键可在设置页录入并触发"快速保存 / 另存为"；默认留空不抢占系统热键。③ 快速保存记住上次目录（`lastSaveDirectory` 落盘）。④ 截图窗口打开时按快门音一次，关闭开关后不响。⑤ `Ctrl+A` 选中当前屏幕，且 Enter/Ctrl+S 等既有快捷键不受影响。⑥ 连续两次截图，序号各自从 1 开始。⑦ `test/capture-naming.test.js`（新）、`test/function-router.test.js` 全绿。

### 6.2 命名模板的已知坑

现状**零处理**：不 sanitize（`\/:*?"<>|`、Windows 保留名 CON/PRN…）、不查重，`main.js:852-854/864` 会静默覆盖同名文件。T1 必须一并解决。`{app}` 可用 `app.getName()`；活动窗口标题项目内无原生能力，需降级为不提供该变量。

### 6.3 新增全局快捷键的通用改动模板（复用于 P0-7-T3）

1. 默认值：`main/services/settings-defaults.js:85-106`（惯例：新键默认**留空**）。
2. 行为：`main/services/function-router.js:32` 的 `handlers` 表加同名函数（派发用 `Object.hasOwn`，`:121`）。
3. 设置页行：`config/config.js:41-77` 的 `functionGroups` 加 `[name,label,icon,desc]`；`renderHotkeySettings`（`:1617-1621`）据此渲染。
4. 冲突/注册：`main/services/shortcut-service.js:41-49,58-68,74-96`（无需逐项注册表）。
5. 迁移：`main/services/shortcut-migration.js:29-51` 自动遍历新键。
6. 校验：`main/services/settings-validation.js:43-45` + `shared/shortcut-keys.js:110-114,232-238`（**裸可打印键被拒**，拒绝文案 `:249-250`）。
7. 生效：`main.js:914-918` 的 `registerShortcuts`，由 `main/domains/settings-effects/index.js:19-24` 驱动；回读 `config/config.js:130-131,138-140`。
8. 别漏：`scripts/probe-diagnostics-runtime.js:16-21` 名单、`main/services/ipc-security.js` 白名单、`test/shortcut-ui-contract.test.js` 正则契约。
9. **陷阱**：新设置键不入 `settings-defaults.js` 会被 `settings-validation.js:30` 以"不支持的设置项"直接拒绝。

**默认键建议留空**：Ctrl+S / Ctrl+Shift+S 被浏览器、IDE、Office 高频占用，注册是 best-effort（失败即 `unavailable`，`shortcut-service.js:85-96`），设置页已有红字提示（`config/config.js:151-171`）。

---

## 7. P0-3 录屏音轨（批次 B）

### 7.1 现状与实测结论

- 链路：`record/record.js:278-288` `getUserMedia` 抓屏 → canvas 裁剪（`:301-309`）→ `canvas.captureStream(frameRate)`（`:309`）→ `MediaRecorder`（`:316-323`，**仅视频轨**）→ `main/services/recording-service.js:29-51` 分片落盘 `capture.webm` → `:66-119` ffmpeg 转 MP4。
- `-an` 与 crf/preset 硬编码在 `record/recording-utils.js:183-196`。
- **ffmpeg 实测**（`ffmpeg-static` = `6.1.1-essentials_build-www.gyan.dev`）：`-devices` 仅 `dshow / gdigrab / lavfi / vfwcap`；**`-f wasapi` 不支持**；`dshow` 只能枚举到麦克风，**无 loopback/立体声混音设备** → **ffmpeg 路径抓系统声音不可行**。

### 7.2 推荐方案

- **主方案**：Electron `session.setDisplayMediaRequestHandler(cb)` 回调 `callback({video:source, audio:'loopback'})` + 渲染层 `getDisplayMedia({audio:true})` 取**系统声**；麦克风走 `getUserMedia` → `AudioContext` + `GainNode` + `MediaStreamAudioDestinationNode` 混音后合入 `canvasStream`。**同属 Chromium 媒体时钟，音画偏差通常 < 20ms，无需补偿。**
- **已知缺陷**：现有 `getUserMedia({mandatory:{chromeMediaSource:'desktop'}})` 旧写法在 Windows 取音轨是 Electron 已知 bug（[electron#42765](https://github.com/electron/electron/issues/42765)、[#25120](https://github.com/electron/electron/issues/25120)），**必须迁移到 `getDisplayMedia`**；`getDisplayMedia` 不能用 deviceId 选源（[desktopCapturer 文档](https://www.electronjs.org/docs/latest/api/desktop-capturer)），须保留 `record/recording-utils.js:163-166` 的 `pickDesktopSource`。
- **降级**：麦克风采集失败 → 仅系统声；系统声不可用 → 仅麦克风；都失败 → 纯默片 + UI 明示。
- **D3 已确认的默认值**：系统声**默认开**（`record.audioSystem:true`）、麦克风**默认关**（`record.audioMicrophone:false`，隐私优先）。"录制中切换音源"不在本期范围。

### 7.3 任务拆解

| 任务 | 内容 | 写作用域 | 依赖 | 人日 |
|---|---|---|---|---|
| P0-3-T1 | 新增 `record/audio-mixer.js`：`createGainPlan({systemGain,micGain})` 纯函数 + 可注入 `AudioContext` 的混音装配 | `record/audio-mixer.js`（新） | W0 | 1.0 |
| P0-3-T2 | `record/record.js:278` 迁移到 `getDisplayMedia` + `setDisplayMediaRequestHandler`；`:316-323` 合入音轨与 `audioBitsPerSecond` | `record/record.js` + 接线说明（`main.js` 注册 handler） | T1 | 1.5 |
| P0-3-T3 | `buildFfmpegArgs` 增音频选项：`-an` → `-map 0:v:0 -map 0:a? -c:a aac -b:a 160k -ar 48000 -ac 2`；`{audio:false}` 时保留 `-an` | `record/recording-utils.js:183-196` | W0 | 0.5 |
| P0-3-T4 | `recording-service.js:73` 透传音频选项 | `main/services/recording-service.js` | T3 | 0.25 |
| P0-3-T5 | 设备热切换健壮性：监听 `devicechange`，给出提示或自动降级 | `record/record.js` | T2 | 1.0 |
| P0-3-T6 | 设置页与文案：`config/config.js:1589`（校验）、`:1593`（"录制仅包含画面"**必须改**）、`:1614`（提交） | `config/config.js` | **S10b**（批次 B·W7.5） | 0.75 |
| P0-3-T7 | 测试：`test/recording-utils.test.js` 锁死三种参数形态；`test/recording-service.test.js:31-41,56-66` 假 spawn 断言透传；新增 `test/audio-mixer.test.js` | 上述文件 | T1–T4 | 1.0 |
| P0-3-T8 | 真机回归：系统声/麦克风/两者/无音轨四种组合各录 10s，核对 MP4 有音轨且音画同步 | 验收记录 | 全部 | 1.0 |

**合计 = 7.0 人日**（1.0 + 1.5 + 0.5 + 0.25 + 1.0 + 0.75 + 1.0 + 1.0）。

**验收标准**：① 系统声默认开启、麦克风默认关闭；录制产物 MP4 **含音轨**且音画偏差可接受（真机 10s 内 ≤100ms）；② 关闭全部音源时导出仍为无音轨 MP4（`-an` 路径保留）；③ `record.audio-mixer.js` 的增益计划可单测（注入 `AudioContext`）；④ `test/recording-utils.test.js` 锁死"有音轨含 `-c:a aac` 且无 `-an`"与"无音轨含 `-an`"两种参数形态；⑤ 无麦克风/静音设备时降级不崩溃；⑥ 设置页文案不再写"仅包含画面"。

**风险**：① 隐私——**麦克风默认关闭**且录制中有明确指示，不可静默开麦；② 蓝牙/耳机热切换可能数秒静音；③ 静音设备需 try/catch 降级；④ AAC 160kbps ≈ 1.2MB/分钟，占视频（≈60MB/分钟）的 2%，可忽略。

---

## 8. P0-5 标注元素二次编辑（批次 B，`capture/` 独占）

### 8.1 现状

- `annotations` 是纯对象数组、**无 id**（`capture/capture.js:56`），下标即 z 序（`:241` 顺序绘制）。
- 字段：通用 `{type,x,y,x2,y2,color,width}`（`:415`）；`pen` 追加 `points[]`（`:416,430`）；`text` **无 x2**（`:413`，绘制回落 `:209`）；`serial` `{x,y,number}`（`:414`）；`watermark` `{x,y,w,h,content,opacity,color,spacing,fontSize,rotation,dateSuffix}`（`:336,664`）。
- 历史是**元素级栈**：`annotations` 即栈，undo=`pop`（`:669`）、redo 反向（`:670`）、`commit` 清 redo（`:311`）、Delete=`pop` 末尾（`:697`）。

### 8.2 必须升级为快照栈

编辑已有元素（改位置/样式/层级）无法用"pop 末尾"表达。**必须**把历史升级为**深拷贝快照栈**（提交时深拷贝 `annotations`，上限 60，`pen` 点集 cap 10000）。命令式成本更高（每种操作都要写逆操作）。

### 8.3 坐标系（最易出错，必须明确）

| 坐标系 | 来源 | 用途 |
|---|---|---|
| ① 屏幕 CSS 坐标 | `capture.js:232` 的 dpr 变换 | **命中测试、手柄、拖动一律用这套** |
| ② 导出坐标 | `capture.js:467` `(item.x-selection.x)*scaleX` | 仅导出时换算 |

**现状行为（D4 已确认：保持）**：标注是**屏幕绝对坐标、不跟随选区**；拖动/缩放选区只改 `selection`（`:428-429`），标注原地不动；**替换选区会直接清空全部标注**（`:407,423`）——该清空行为按 D4 改为**先确认**。

### 8.4 任务拆解（4 个可独立合并的 PR）

| PR | 内容 | 写作用域 | 验收 | 人日 |
|---|---|---|---|---|
| **PR1** 选中 + 删除 | 新增 `capture/annotation-geometry.js`（`annotationBounds` / `findAnnotationAt` / `translateAnnotation`）；`commitAnnotation` 补单调 `id`；选中虚线框（插在 `:241` 与 `:242` 之间）；浮动 `#elementBar`（`capture.html:68` 之后）；Delete/Esc；**快照栈** | `capture/annotation-geometry.js`（新）、`capture/capture.js`、`capture/capture.html`、`capture/capture.css` | 任意类型可选、重叠取最上、删除可撤销 | 1.5 |
| **PR2** 拖动 | `translateAnnotation` + move 态 + 边界 clamp + 方向键微调 | 同上 | 导出位置与屏幕一致；Ctrl+Z 回原位 | 1.0 |
| **PR3** 缩放 | 8 手柄（复用 `capture/selection-utils.js` 的 `getResizeHandle`/`resizeSelection`，**bounds 传舞台而非选区**）；`resizeAnnotationToBox`；`pen` 等比点集、`text` 仅移动+字号、`serial` 仅半径 | 同上 | 镜像不崩、最小 3px | 1.5 |
| **PR4** 层级 + 样式 | `reorderAnnotation`；颜色/线宽作用于选中项（`:298,657`）；层级 ↑↓ | 同上 | 层序进入导出、undo/redo 不串 | 1.5 |

**合计 = 5.75 人日**（PR1 1.5 + PR2 1.0 + PR3 1.5 + PR4 1.5 + D4 落地项 0.25；不含评审与真机）。

**验收标准**：① 任意类型的已提交标注可被点选，重叠时取最上层；② 支持拖动、8 手柄缩放、Delete 删除、层级上下移、改颜色/线宽；③ 每次编辑可被 `Ctrl+Z` 精确回退（含 pen 点集深拷贝）；④ 导出图与屏幕位置逐像素一致（两套坐标系不串）；⑤ `capture/annotation-geometry.js` 的 12 条纯函数用例全绿；⑥ **D4 落地项**：已有标注时重划选区先弹确认，取消后标注与选区均保持原状。

**D4 落地项（已确认，并入 PR1，+0.25 人日）**：`capture.js:407,423` 的"替换选区直接清空全部标注"改为**先弹确认**（或在无历史可回退时仅清未提交内容）。改动仍限 `capture/**`，验收：在已有标注的情况下重划选区不会静默丢失标注；取消确认后标注与选区均保持原状。

**pointerdown 优先级**（插在 `capture.js:406-411`）：OCR/auto 保持原样 → 选区手柄 > 选中元素手柄 > 元素体内 > 元素命中（逆序） > `insideSelection` 拖选区 > 新建选区。`setTool`（`:288`）清选中；仅 `editDirty` 在 pointerup 提交历史（`:434`）。

**测试**（12 条纯函数用例 + 契约）：反向端点 bbox 规范化、pen 点集/单点退化、text 无 x2 不抛错、serial 2×radius 方框、watermark bbox、描边容差（边 1px 命中/中心 20px 不中）、ellipse 环带命中、重叠取末位、`translateAnnotation` 不改原对象、`resizeAnnotationToBox` 保方向+最小 3px、`reorderAnnotation` 边界 no-op、快照 undo 精确还原（pen 深拷贝）。契约：Delete 不再 `annotations.pop()`、`test/capture-toolbar-icons.test.js:10-14` 有序清单同步、`package.json` 的 c8 `--include` 补 `capture/annotation-geometry.js`。

**风险**：① 历史升级连带 undo/redo/Delete/Esc 与既有契约测试；② 两套坐标 + DPR；③ text/serial 缩放语义与绘制模型不符，必须限范围；④ "不随选区缩放"易被当 bug；⑤ 替换选区清空标注（`:407`）与"编辑后保留"冲突；⑥ 序列号删除留空洞（**不建议重编号**）；⑦ 工具栏已近满宽（866px/900px 窗口），元素操作必须走独立浮动条；⑧ `capture-toolbar-icons` 有序清单与 c8 门槛会因新文件失败。

---

## 9. P0-2 光标进图（批次 B，先做截图链路）

### 9.1 方案选型（已排除两项）

| 方案 | 结论 |
|---|---|
| (a) `desktopCapturer` | ❌ **不可行**：`electron.d.ts:23623-23642` 的 `SourcesOptions` 无光标选项；`screenshot-desktop` win32 后端是 GDI 位图脚本，无光标参数 |
| (b) 新 Node 原生 addon | ❌ 成本过高（node-gyp + electron-rebuild + 签名） |
| **(c) 扩展现有 `SmartSelect.exe`** | ✅ **推荐**：已 per-monitor DPI aware（`native/smart-select/Program.cs:52-62`）、已有 line-JSON 协议（`smart-select.js:98`）与 350ms 超时（`:86-95`）、已进打包 `extraResources`，**零新增构建与签名成本** |
| (d) `screen.getCursorScreenPoint()` + 内置图集 | ✅ 作为**(c) 的定位补充**：形状恒为箭头但零成本 |

**推荐 (c) 取形 + (d) 取位**：新增 `cursor` 命令返回 `{x,y,hotspotX,hotspotY,png}`（物理像素）；录屏用 ~10Hz 轮询形状 + 每帧 `getCursorScreenPoint()` 定位（每帧走 pipe 不可行：350ms 超时 + JSON 开销）。

### 9.2 合成落点

- **截图**：`capture/capture.js:461-469` 的 `exportSelectionCanvas`，**画在裁剪后的 output 上**（复用 `:467` 的 `scaleX/scaleY`，减去热点 × scale），天然被选区内裁剪，避免第二套换算。
- **录屏**：`record/record.js:185-195` 的 `renderCompositeFrame` 合成 canvas（**不是** ffmpeg 滤镜——`buildFfmpegArgs` 无任何 filter，且预览会不一致）。

### 9.3 任务拆解

| 任务 | 内容 | 写作用域 | 依赖 | 人日 |
|---|---|---|---|---|
| P0-2-T1 | C# 新增 `cursor` 命令：`GetCursorInfo` + `GetIconInfo` + 位图导出 + 热点 | `native/smart-select/Program.cs` | W0 | 1.5 |
| P0-2-T2 | 主进程封装 `main/services/cursor-provider.js`（解析、缓存、`CURSOR_SHOWING=0` 时不画） | `main/services/cursor-provider.js`（新） | T1 | 1.0 |
| P0-2-T3 | 纯几何函数 `resolveCursorPlacement({cursorScreenPoint,captureBounds,imageSize,hotspot,scaleFactor})` | `shared/cursor-geometry.js`（新） | W0 | 0.5 |
| P0-2-T4 | 截图合成接线（在 `exportSelectionCanvas` 内） | `capture/capture.js`、接线说明（`main.js` 注入 provider） | T2、P0-5 | 1.0 |
| P0-2-T5 | 测试：混合 DPI、负坐标副屏、选区外可见性、热点偏移、`scaleFactor≠1` | `test/cursor-geometry.test.js`（新） | T3 | 1.0 |
| P0-2-T6 | 真机验证：100%/125% DPI、副屏负坐标截图 | 验收记录 | 全部 | 1.0 |

**合计 = 6.0 人日**（1.5 + 1.0 + 0.5 + 1.0 + 1.0 + 1.0，仅截图链路）。

> **范围变更（2026-10-10 独立审查）**：**录屏光标（原 P0-2 延伸 / 波次图中的 S8）已移出本期**。原计划把它放在批次 B 的 Wave 7，但它既无任务表、也无 IPC 通道与 `preload-record.js` 改动，**按现状不可派发**；且把它的 3–4 人日计入批次 B 会使该批次超出当时声明的上界。现改列为 **P1 延期项**，届时另立任务表。`record.captureCursor` 键在 §2.1 中保留占位，默认 `false`，不影响本期。

**验收标准**：① 开启"截图带光标"后，导出图在光标位置出现光标图像，热点对齐（不是左上角对齐）；② 关闭开关后与现状逐像素一致；③ 混合 DPI（100%/125%）、副屏负坐标下位置正确；④ 光标在选区外时不绘制；⑤ `test/cursor-geometry.test.js`（新）覆盖 `resolveCursorPlacement` 的 5 类边界；⑥ `CURSOR_SHOWING=0`（游戏/未聚焦）时不绘制。

**风险**：`getCursorScreenPoint` 是 DIP 且可为负，位图是物理像素，**勿与 `convertSmartSelectRects` 的物理→逻辑换算混线**；热点不修正必偏移；光标跨选区边缘需定义裁剪/丢弃。

---

## 10. P0-1 国际化 i18n（批次 C）

### 10.1 规模（已实测）

| 区域 | 可译串量级 |
|---|---|
| `config/` | **≈660**（config.js 645、config.html 22） |
| `capture/` | ≈105 |
| `long-capture/` + `record/` | ≈64 + 62 |
| `action/` `search/` `recognition/` `toolbar/` `pin/` | 58 / 36 / 32 / 20 / 0 |
| `main/`（35 文件 357 串，其中 ≈185 是 `throw new Error`） | ≈350 |

渲染层合计 **≈1000 条**，UI 文案占 ≈95%。

### 10.2 硬约束

- **所有窗口 CSP 均为** `default-src 'none'; script-src 'self'; connect-src 'none'`（`config/config.html:5`、`capture/capture.html:5`、`action/action.html:6`）→ **不能 fetch JSON，语言包必须是 `<script>` 注入的 `.js`**。
- 现成"前脚本"模式：`config/config.html:49-54`、`capture/capture.html:83-85`、`toolbar/toolbar.html:68`。
- `config/config.js:31-77` 的 `routeTitles` / `functionGroups` 已是**集中表**，是 i18n 化的最佳切入点。

### 10.3 架构

```text
shared/i18n.js           t(key, params) + MutationObserver 扫 [data-i18n] / [data-i18n-title|placeholder]
shared/locales/zh-CN.js  window.__LOCALES['zh-CN'] = {...}
shared/locales/en-US.js
shared/locales/zh-TW.js
scripts/check-i18n.js    ① 三份 locale 键集合对称差必空
                         ② 扫仓库 [\u4e00-\u9fff] 输出未迁移清单（--max 逐批收紧）
                         ③ 断言 data-i18n 键都在表内
```

**免爆炸改造**：每个 HTML 只加 **1 行** `<script src="../shared/i18n.js">` + 给元素加 `data-i18n` 属性；JS 侧直接用全局 `t()`。**不动 CommonJS、不引打包器。**

**语言优先级**：`document.documentElement.dataset.language` → `localStorage` → 默认。
**切换生效**（mirror `theme` 的既有做法）：设置 effect 广播 `i18n:language` 到 11 个窗口，渲染层收消息重扫 DOM；`config` 窗靠 `updateSettings` 返回值本地重渲染（`config/config.js:129-136`）。

### 10.4 任务拆解

| 任务 | 内容 | 写作用域 | 人日 |
|---|---|---|---|
| P0-1-T1 | 框架：`shared/i18n.js` + 三份 locale 骨架 + `scripts/check-i18n.js`（W0-4 已起骨架，此处补全） | `shared/i18n.js`、`shared/locales/**`、`scripts/check-i18n.js` | 2.0 |
| P0-1-T2 | 设置 effect：`language` 广播（mirror `main/domains/settings-effects/index.js:63-66` 的 appearance）；`resetEffects`（`:89-100`）同步 | `main/domains/settings-effects/index.js`、接线说明 | 1.0 |
| P0-1-T3 | `config/` 全量迁移（**≈660 条，最大单块**）：先生成 `routeTitles`/`functionGroups` 结构表，再逐路由迁移 | `config/**` | 3.5 |
| P0-1-T4 | `capture/` 迁移（≈105 条） | `capture/**` | 1.75 |
| P0-1-T5 | 其余渲染窗：`record` / `long-capture` / `action` / `search` / `recognition` / `toolbar` | 各自目录 | 3.5 |
| P0-1-T6 | 主进程文案：托盘 14 条（`tray-menu.js:23-44`，改为收 labels 参数）、启动错误框（`main.js:1206,1276`）、更新文案（`update-service.js:73-98`）、Everything 状态（`everything-service.js:341-389`）、AI 连接错误（`ai/client.js:127-131`）、对话框过滤器（`function-router.js:58`）。**不含 `throw`（D6 已确认本期不翻）** | 上述文件 + 接线说明 | 2.0 |
| P0-1-T7 | 测试：`test/i18n.test.js`（键对称差、`t()` 插值、回退）、`test/i18n-contract.test.js`（11 个窗口均引 `i18n.js`、无裸中文） | `test/**` | 2.0 |
| P0-1-T8 | 三语言真机切换验证 + `electronLanguages` 分工说明 | 验收记录 + `package.json` 决策 | 1.0 |

**合计 = 16.75 人日**（§10.4 逐项加总：2.0 + 1.0 + 3.5 + 1.75 + 3.5 + 2.0 + 2.0 + 1.0）。

**验收标准**：① 设置页可在 `zh-CN / en-US / zh-TW` 间切换并**不重启生效**；② 11 个窗口的 UI 文案随语言切换，无残留中文（`scripts/check-i18n.js` 的未迁移清单逐批收紧到 0）；③ 三份 locale 的键集合对称差为空；④ 每个 `data-i18n` 键都能在三份表中找到；⑤ `config/` 与 `capture/` 的迁移不改变任何交互行为（迁移前后 E2E/smoke 一致）；⑥ 主进程的托盘/更新/状态文案已迁移，`main/` 的 `throw` 按 D6 **不在本期**；⑦ `test/i18n.test.js`、`test/i18n-contract.test.js` 全绿。

### 10.5 风险与产品决策

1. `package.json:137-140` 的 `electronLanguages` 仅 `zh-CN/en-US` —— **D6 已确认分工**：自研 i18n 负责**全部应用 UI 文案**；`electronLanguages` 只负责 Chromium 内置 UI（右键菜单、拼写检查等），保持 `zh-CN/en-US` 不动，zh-TW 用户在该处回落 en-US（可接受，不需要为此改 `package.json`）。
2. `main/` 有 ≈185 处中文 `throw`，不翻则英文用户看到中文错误；`test/` 有 430 行中文断言（如 `test/settings-validation.test.js:29` 的 `/不支持的设置项/`），翻译将连带改测试，**回归面显著放大** —— **D6 已确认：本期不翻**，下个版本单独立项（届时 T6 只做托盘/对话框/更新等用户可见文案）。
3. `config/config.js:356-357,739-740` 的翻译语言下拉以"中文"等汉字作 **value**，是存储/API 契约，**只能翻 label**。
4. AI 提示词（`main/services/action-conversation.js:34-55`）与 `ai.targetLanguage:'中文'`（`settings-defaults.js:75`）**建议不随 UI 语言联动**。
5. 繁体标识符用 **`zh-TW`**（D6 已确认；非 `zh-Hant`）；是否需台湾用词表留待翻译阶段决定；日志/诊断**只翻 UI、不翻日志**。

---

## 11. 收口波次（Lead 专属）

每个批次结束时，Lead 执行：

| 步骤 | 内容 |
|---|---|
| 1 | **`main.js` 集成接线**：按各工作流 PR 说明汇总接线行（`setDisplayMediaRequestHandler`、光标 provider 注入、打印 dep 注入、`saveImageBuffer` 目录记忆） |
| 2 | `npm test` 全量 + `npm run check`（含 `main.js` 行数）+ `npm run test:coverage:loaded` + `npm run test:coverage:critical` + `npm run audit:dependencies` |
| 3 | Playwright e2e 全绿 |
| 4 | **真机验收**（副屏；无副屏先询问）：批次 A 验打印/穿透/快捷键/命名；批次 B 验音轨/光标/标注编辑；批次 C 验三语言切换 |
| 5 | 回填本文档"实施结果"章节（沿用 `docs/plans/2026-10-06-capture-annotation-width-design.md` §10 的写法：改动表 + 门禁实况 + 偏差记录） |
| 6 | 更新 `README.md` 功能概览；按 `docs/releases/` 惯例出验收记录 |

---

## 12. 风险登记册

| # | 风险 | 等级 | 缓解 |
|---|---|---|---|
| R1 | `main.js` 仅 2 行余量，接线必然撞门禁 | **高** | W0-1 先腾出 ≥60 行；`main.js` 由 Lead 独占 |
| R2 | 7 路并发抢 `settings-defaults.js` / `ipc-security.js` → 反复冲突 | **高** | W0-2/W0-3 一次性冻结，此后只读 |
| R3 | `capture/**` 被打印、标注编辑、体验细节三方争抢 | **高** | **已修**：批次 A 的 `capture/**` 改动全部推入 W2 的 S9a；owner 链 S9a(A) → S6(B) → S9b(B)。`config/**` 同理 S10a → S10b → S1 → S14（§3.1） |
| R4 | i18n 连带改 430 行中文测试断言，回归面失控 | 中 | **D6：本期不翻 `main/` 的 185 处 `throw`**；`scripts/check-i18n.js` 的 `--max` 逐批收紧 |
| R5 | 录屏音频迁移 `getDisplayMedia` 触发 Electron 已知缺陷 | 中 | 保留 `pickDesktopSource`；先做降级路径；真机四组合回归 |
| R6 | 贴图穿透 hover 退出在部分驱动失效 | 中 | 快捷键 + 托盘兜底**必须**先落地 |
| R7 | 标注历史升级破坏既有 undo/redo 契约 | 中 | PR1 单独合并并跑既有 capture 测试 |
| R8 | 打印超长图超 Chromium 200 英寸上限 | 中 | `computePaperOptions` 夹取 + 单测 |
| R9 | 命名模板与 `OWNED_CAPTURE_FILE` 失配，历史文件被判"非本应用" | 中 | 模板与所有权正则同源 |
| R10 | 光标 DIP/物理像素混线导致偏移 | 中 | 纯函数 `resolveCursorPlacement` + 混合 DPI 单测 |
| **R11** | **前置工程 D2 无主、无工日，批次 C 的真实成本不在总账内** | **高** | 已补 §3.4：独立估工 3.75–6.5 人日、独立 Wave 8.5、独立 owner S14；总账已按任务表重算为 **七项 49.0 + 工程开销 = 55.25–59.5 人日**（§0.1） |
| **R12** | D2 的"每路由文件 ≤300 行"验收标准**按路由直拆可能达不到**：`renderHistory` 单函数 **326 行**（`config/config.js:398-724`）即超线 | 中 | D2-3 需对该路由再做二级分解；验收标准以"主壳 ≤400 行 + 无单文件 >300 行"为准，必要时与路线图作者对齐口径。**修正**：初版还列了 `renderSelectionToolbarSettings`（称 459 行），实测仅 **144 行**（`:724-867`），已从依据中移除 |
| **R13** | D2 搬迁触发 15 个测试文件的源码文本断言（575 处 assert）集体失败 | 中 | **D2-1 先行**：`test/helpers/config-source.js` 拼接读取，把成本压到 15 行改动；边界类断言（D2-4）单独修 |

---

## 13. 决策记录（2026-10-10）

下表是**已确认**的口径，实施时逐条对照；确认过程见 §13.1。

| # | 决策点 | **已确认的结论** | 落点 | 未采纳的备选 / 代价 |
|---|---|---|---|---|
| **D1** | 批次节奏 | **接受 A/B/C 三段交付**：A 打印PDF + 贴图穿透 + 体验细节 → B 录屏音轨 + 光标 + 标注编辑 → C i18n | §0.1、§3.2、§14 | 未采纳"一版做全"：**55.25–59.5 人日**不可控，且批次 A 的低成本价值要等最久才可见 |
| **D2** | `main.js` 容量策略 | **先腾挪，暂不动 1300 上限**：W0-1 先抽出 ≥60 行余量，再做集成接线 | §2 W0-1、§11 步骤 1、R1 | 未采纳"直接提高上限"：会削弱 v2.3 架构减负（`main.js` 1298/1300）既有纪律的约束力 |
| **D3** | 录屏默认音源 | **系统声默认开；麦克风默认关**（隐私优先） | §2.1（`record.audioSystem:true` / `record.audioMicrophone:false`）、§7.2 | 未采纳"麦克风默认开"：静默开麦不可接受；未采纳"系统声默认关"：会让该功能默认不可见，等于没做 |
| **D4** | 标注与选区的关系 | **保持"锚定屏幕、不随选区缩放"**；并把"替换选区清空全部标注"改为**先确认** | §8.3、§8.4 "D4 落地项" | 未采纳"标注随选区缩放"：与现有绘制/导出模型冲突，需重写 `:467` 换算；未采纳"维持静默清空"：数据丢失无提示 |
| **D5** | 贴图旋转语义 | **先做"仅预览"**（渲染层 CSS transform + 窗口尺寸换算），重编码回写延后 | §5 后续 | 未采纳"直接回写 `_pinData.dataUrl`"：会干扰 `getPixelAlignedPinSize` / `syncPinDisplayScale`（`main/domains/pin/index.js:66-87`），且"导出像素是否含旋转"要重新定义 |
| **D6** | i18n 语言标识与主进程文案 | 繁体用 **`zh-TW`**；`main/` 的 ≈185 处中文 `throw` **本期不翻**，下个版本单独立项；`electronLanguages` 保持 `zh-CN/en-US` 不动 | §10.5 第 1 / 2 / 5 条、§2.1（`language:'zh-CN'`） | 未采纳 `zh-Hant`：与仓库既有语言标识习惯不一致；未采纳"本期一并翻 `throw`"：连带 430 行中文测试断言，回归面失控 |
| **D7** | i18n 与 Phase D2 的先后 | **Phase D2（`config/config.js` 拆为 `config/routes/*.js`）先于 i18n**；D2 完成是批次 C 的**开工前置门** | §3.2（Wave 9 前置门）、§3.4、§14（M3） | 未采纳"i18n 先行"：`config/` 会被 D2 与 i18n 连续改造两遍，返工 ≈660 条文案 |
| **D8** | **D2 的排期与人日归属**（2026-10-10 新增） | **D2 独立立项为 Wave 8.5**（批次 B 之后、批次 C 之前），**独立估工 3.75–6.5 人日**，不计入批次 C 的 16.75 人日 | §3.4 全节、§0.1 批次表、§3.2、§14（M2.5） | 未采纳"D2 紧跟 Wave 0"（批次 A 延后 3.75–6.5 人日）；未采纳"取消 D2、i18n 直改 1829 行单体"（D2 是 v2.3 路线图既定目标，迟早要付，且单体上 i18n 无法并行） |

> **D1–D7 已于 2026-10-10 按原推荐确认并闭环。** D8 是同日由旁路观察者指出后新增的：D7 把 D2 定为硬前置，但 D2 在本方案里没有任务、owner 与工日，i18n 的 16.75 人日也不含它。核实后确认缺口成立，且真实成本大于观察者描述（见 §3.4.1 第 5 条）。**D8 已确认，批次 C 自此具备开工条件。**

### 13.1 确认记录（2026-10-10）

| # | 你的答复 | 落点 |
|---|---|---|
| 1 | "接受你给出的建议，更新文档"（2026-10-10） | **D1–D7 全部按原推荐采纳**，逐条落点见上表 |
| 2 | 旁路观察者指出"D2 仍为部分完成、本方案未排期未估工"（2026-10-10） | 缺口成立，补 §3.4 + D8 |
| 3 | "按你的建议来，更新文档"（2026-10-10） | **D8 按原推荐确认**：D2 独立立项为 Wave 8.5、独立估工 3.75–6.5 人日；批次 C 具备开工条件 |
| 4 | "按 F2–F7 执行修复，给出 F1 建议"（2026-10-10） | **F2–F7 已执行**：§0.1 总账重算（49.0 + 工程开销 = 55.25–59.5）、§1.2 开工前提、§2.1 补 3 键 + §2.1.1 加键流程、§2.2 IPC 广播通道修正、§3.1/§3.1.1/§3.1.2 重切写作用域与注册表、§4–§10 事实与验收修正、§12 R11–R13、§15；F1 建议见 §13.2 |

**状态**：方案已定稿；**D1–D8 决策全部闭环**；**F2–F7 修复已执行（2026-10-10）**；**F1 三项建议待你确认**（§13.2）；**未开始编码**。等开工指令后按 M-1 → M0（Wave 0）→ M1 → M2 → M2.5（D2）→ M3 推进，每批次收口按 §11 回填实施结果。

### 13.2 F1 三项建议（许可证相关，**待你拍板**）

> 由 2026-10-10 的许可证独立审查产出。三项都**不阻塞批次 A/B/C**（只影响 P1 与合规），但**第 ① 项必须在任何移植动作之前定案**。

#### F1-① 许可证字符串：建议改用 **`GPL-3.0-only`**

| | 说明 |
|---|---|
| **问题** | `snow_shot/rust/snow-shot-mcp/Cargo.toml` 与 `snow-shot-updater/Cargo.toml` 自述 **`GPL-3.0-only`**，`LICENSE.md:7` 允许文件级例外。而 `snow-shot-mcp` **正是 P1-2 最想移植的 MCP 服务端**。若 Highlighter 声明 `GPL-3.0-or-later` 并纳入这两处代码，接收者无法对整体行使"或更高版本"的选择权 → **越权声明** |
| **建议** | `package.json` 写 **`"license": "GPL-3.0-only"`**；`COPYRIGHT` 与之对齐（去掉 "any later version" 字样）；`LICENSE` 仍是 GPLv3 全文（文本相同，差异只在授权声明段） |
| **代价** | 放弃向下游提供"或更高版本"的选项。对个人开源项目而言**实际影响极小**（无下游再许可需求） |
| **收益** | 与最想移植的 MCP 模块**许可一致**，消除混合授权口径；L14 的权利链核对结论不再影响 L3 |
| **备选** | 保持 `or-later`，但**绕开** `rust/snow-shot-mcp/` 与 `rust/snow-shot-updater/`：MCP 服务端改为**自研**（协议公开，Node 侧 `@modelcontextprotocol/sdk` 成本可控，见分析文档 §3 P1-2），仅**借鉴**其工具设计与安全模型。此路可行，但会显著增加 P1-2 的工作量 |
| **定性** | 建议 **A（改 `-only`）**；备选 B 适合"想保留 or-later 的许可弹性、且愿意自研 MCP"的情形。**口径需法务确认** |

#### F1-② `sharp` 的 LGPL-3.0：建议**接受并落实专项**，不替换

| | 说明 |
|---|---|
| **问题** | `@img/sharp-win32-x64`（libvips）为 **`Apache-2.0 AND LGPL-3.0-or-later`**，随 `sharp` 进入安装包；当前零 NOTICE，LGPL 的告知、源码提供、**可替换重链接**三项义务均未落实 |
| **建议** | **接受现状**，落实 L15：随附 LGPL 文本 + 源码获取方式 + 说明"`sharp` 以独立 npm 包形式动态加载，用户可在 `node_modules` 中替换" |
| **理由** | ① LGPL 不要求 Highlighter 整体开源，与路线 A 不冲突；② `sharp` 被 `main/services/long-capture-session.js:3` 使用（长截图缩略图），替换成本高；③ "可替换重链接"对 Node 生态的独立 npm 包天然成立，落实成本低 |
| **代价** | L15 约 0.5–1 人日（写清单 + 说明） |
| **备选** | 移除 `sharp` 改用其他缩略图方案 —— 需重写长截图缩略图链路，**不推荐** |

#### F1-③ 历史 release 的追溯合规：建议**轻量盘点 + 只补最新版**

| | 说明 |
|---|---|
| **问题** | 此前已发布的版本（含 GPL 的 FFmpeg）在**当时的分发节点上**已产生告知义务；补 LICENSE **不溯及既往** |
| **建议** | ① 盘点历史 release 清单，确认哪些包含 `ffmpeg-static`/`sharp`；② **只对最新版**补齐完整告知与源码说明；③ 对旧版本在发布页加一条**说明性公告**（不重发旧包、不撤包）；④ 记入 `docs/releases/` |
| **理由** | 存量版本的分发量极小、且属个人自持项目；重发全部历史包的成本与风险都不成比例 |
| **代价** | L13 约 0.5 人日 |
| **时机** | 可与批次 A 并行，不必阻塞 |

**三项建议汇总**：

| # | 建议 | 阻塞什么 | 落地项 |
|---|---|---|---|
| F1-① | 改用 `GPL-3.0-only` | **阻塞任何 `snow_shot/` 代码移植**（P1-1/P1-2） | L3（改字符串）、L14（权利链核对随之简化） |
| F1-② | 接受 LGPL，落实 L15 | 不阻塞 | L15 |
| F1-③ | 轻量盘点 + 只补最新版 | 不阻塞 | L13 |

---

## 14. 里程碑

| 里程碑 | 出口条件 | 预估 |
|---|---|---|
| **M-1** | **工作区整理（§1.2，M0 的前置）**：3 项非文档改动已提交或已丢弃；若保留 `selection-hook` 2.1.1 须附划词真机验证记录 | 0.5–1 人日 |
| M0 | Wave 0 完成：`main.js` ≤1240；契约冻结；`npm run check` 绿 | 2–3 人日 |
| M1 | 批次 A 完成并真机验收 → v2.3.2 | +13.5 人日 |
| M2 | 批次 B 完成并真机验收 → v2.4.0 | +18.75 人日 |
| **M2.5** | **前置工程 D2 完成（§3.4）**：`test/helpers/config-source.js` 落地、15 个测试解耦、`config/config.js` 拆为 `config/routes/*.js`、8 个路由页 smoke 绿 → 随 v2.4.x。**这里是批次 C 的硬前置门（D7/D8）** | **+3.75–6.5 人日** |
| M3 | 批次 C 完成（三语言真机切换）→ v2.5.0。**前置门（D7）**：M2.5 已完成 | +16.75 人日 |
| M4 | P1 立项（Auto Filter / MCP） | **License 已选定（2026-10-10）：`GPL-3.0-or-later`（路线 A）**，`snow_shot/`（GPL）实现自此可移植/逐行参照，P1 自研成本下降。**但移植同时触发四项 GPL 义务**（保留原作者版权、被修改文件注明改动与日期、衍生文件同许可、交互界面展示 Appropriate Legal Notices），见分析文档 §5.5.2 的 O1–O4；**落地清单（`LICENSE`/`COPYRIGHT`/`THIRD_PARTY_NOTICES.md`/About 页许可区块等 L1–L10）已规划但未执行**，见分析文档 §5.6 |
| M5 | **补第三方许可合规**（`ffmpeg-static` 为 GPL-3.0，当前零 NOTICE；另需复核 `native/everything/Everything.exe` 再分发条款） | 见分析文档 §5.2 / §5.6 L4+L8，与批次 A 可并行；**未执行** |

---

## 15. 与上游文档的差异记录

撰写本方案时对 `2026-10-10-snow-apps-feature-gap-analysis.md` 与既有假设做了**十一处**修正（第 7–11 项由 2026-10-10 的六路独立审查产出）：

1. **`main/domains/<域>/` 不是四文件模板**：实际布局是 `main/domains/<域>/index.js` 单文件工厂 + `main/ipc/<域>-ipc.js`（对照 `scripts/check-architecture.js:73-85` 只要求 `index.js` 存在）。任务拆解已按真实布局编写。
2. **`main.js` 行数以门禁读数 = 1298 为准**（`npm run check:architecture` 实测；`(Get-Content main.js).Count` 因换行计数差异给出 1297，两者差 1 属正常）。任何工作流若引用不同数字（如 1219），一律以 1298 与 `scripts/check-architecture.js:18` 的 1300 上限为准。
3. **"序号跨截图累积"实为伪需求**：每次截图新建窗口并重新 `loadFile`（`main/domains/capture/index.js:247-250`），渲染进程随之重建，`capture.js:58` 的 `serialNumber` 本就是 1 起。P0-7-T7 因此降级为"显式化 + 可选跨截图保留"，工作量 0.25 人日。
4. **v2.3 路线图的 D2 是"部分完成"，但本方案此前把它只当门、未当任务**（2026-10-10 旁路观察者指出，核实成立）：`config/routes/` 只有 `model-helpers.js`（39 行），`config/config.js` 实为 **1829 行**（比路线图基线长约 254 行）；且 D2 会触发 **15 个测试文件、约 170 处指向 config.js 的源码文本断言**。已补 §3.4 独立立项（3.75–6.5 人日）与 D8。
5. **批次 C 的真实前置成本此前不在总账内**：i18n 的 16.75 人日只覆盖 i18n 本身，D7 依赖的 D2 无 owner、无工日。修正后 M2.5 为独立里程碑。
6. **基线是"HEAD"而非"干净工作区"**（2026-10-10 旁路观察者指出，核实成立）：文档写的 `master @ b97391e` 指引用的提交，但工作区当时带着 3 项非文档改动 —— `package.json`/`package-lock.json` 的 `selection-hook` `2.0.2 → 2.1.1` 升级，以及被 git 跟踪的构建产物 `native/everything-search/bin/HighlighterEverything.exe` 的重建噪声（`Bin 343552 → 343552`，同尺寸）。已补 §1.2（M-1 开工前提）与 M-1 里程碑。核对确认：`node_modules` 已装 2.1.1，属**已完成未提交**而非半应用状态；lockfile 中 `registry.npmmirror.com` 早已存在 8 个包，本次新增不构成新问题类别。
7. **总账不可复现**（独立审查指出，核实成立）：旧值 37–57 既非任务表逐项加总（**49.0**），也非批次区间和；D2 人日一物两值（3.75–6.5 vs 4–6.5）；总账存在三个版本（41.5–64.5 / 41–63.5 / 43.5–64.5）。已按 §0.1 的"加总来源"表重算为 **七项 49.0，含工程开销 55.25–59.5 人日**。
8. **写作用域存在真实重叠**（独立审查指出，核实成立）：`capture-naming.js`（P0-4-T6 ∩ P0-7-T1）、`function-router.js`（P0-6-T4 ∩ P0-7-T3）、`main/domains/capture/index.js`（S4 ∩ S7）三组同波次双写，"批次 A 三流零交集"不成立。已按 §3.1 重切为单写者，并新增 §3.1.1 工作流注册表。
9. **两个硬死锁**（独立审查指出，核实成立）：① `IPC_SURFACES` 只登记"页面→主进程"通道（每条 surface 只有 `handles`/`listeners`），而 §2.2 把两个**主→渲染广播**登记进去 → `assertComplete()`（`main.js:1173`）抛错、`electron .` 与 `scripts/probe-diagnostics-runtime.js:95` 全挂；② `settings-defaults.js` 冻结只读，但 P0-7-T3 与 P0-6-T4 必须新增键，且 §2.1 清单里没有。已修（§2.2 区分登记/不登记、§2.1 补齐 15 键、新增 §2.1.1 加键流程）。
10. **`nameTemplate` 默认值与所有权正则冲突**（独立审查指出，核实成立）：原默认 `'{date}-{time}'` 与 `capture-naming.js:12` 的 `OWNED_CAPTURE_FILE`（`^Highlighter(?:_Long)?_\d{4}-…`）不匹配，会让每张新截图被历史库判为"非本应用"。默认已改为 `''`。
11. **若干可核实的事实失真**（独立审查指出，已逐条修正）：`renderSelectionToolbarSettings` 实为 **144 行**（`:724-867`，非 459）；"575 处 assert"是 15 文件总数、**指向 config.js 的约 170 处**；`screenshotclipboardplacement.cpp` 路径缺一层 `services/`；Snow Shot 测试文件实为 **211 个**（非"约 190"）；`codec.rs:340-371` 不含 GIF/APNG/WebP；Highlighter 保存实际**只写 PNG**；"全仓 grep 零命中"应为"**源码** grep 零命中"；`long-capture` 失败提示在 `:242`；函数名是 `getPixelAlignedPinSize`。
