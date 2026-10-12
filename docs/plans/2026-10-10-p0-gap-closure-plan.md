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
2. **Wave 0 先冻结共享契约**：`main/services/settings-defaults.js` 必须在任何并行开始前**一次性写全**（§2.1 的 15 个新键），此后只读；`main/services/ipc-security.js` 在 W0-3 冻结的是**登记规则**（§2.2），此后**只由 Lead 在波次边界按 §2.1.1 串行追加通道**，不再"一次性登记通道 + 文件只读"。这是避免 7 路互相踩踏的关键。（2026-10-10 第二轮复核：原"文件只读 + W0-3 一次性登记两条通道"与"通道注册点最早在 W1、`capture:export-pdf` 可能迟至 Wave 3"直接冲突，会让 Wave 0 无法绿着出口，见 §2.2 修正 2。）
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
| C6 | 既有契约测试的**硬编码清单**（图标序列、通道 deepEqual、探针名单）改动需同步 | `test/capture-toolbar-icons.test.js:10-14`、`test/ipc-module-contracts.test.js:86-145`、`scripts/probe-diagnostics-runtime.js:16-21`、`test/pin-domain.test.js:35`（硬断言 `pin:toggle-click-through`，须与 `main/services/ipc-security.js:125` 的条目删除**同 PR** 同步） | 门禁失败 |
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

> **2026-10-10 复核：本节结论已履行，M-1 已结案。** 实际落地路径是**选项 A 的"丢弃在制改动"分支**：文档与 `.gitignore` 的 3 行已在提交 **`07153a6`**（`master`，经 `pull --ff-only` 快进）；`package.json:151` 仍为 `selection-hook: "^2.0.2"`、`node_modules/selection-hook` 实测 **2.0.2**（2.1.1 升级**未保留**，故出口条件 3 的"划词真机验证记录"不适用）；`native/everything-search/bin/HighlighterEverything.exe` 与 HEAD **逐字节一致**（343552 B，无 diff）；`_repo_snow_apps/` **已不在磁盘**；本节提到的两份 `2026-10-08`/`2026-10-09` 文档**从未提交、当前不存在**。**工作区干净**，唯一未跟踪项为工具文件 `.zcodeignore`（经确认保持 untracked）。下表为当时的实测留档，保留以记录依据。
>
> **复核补记（与 M-1 无关但影响开工）**：`npm start` 的 `prestart` 会跑 `npm run build:native`，**会重新生成被跟踪的 `native/everything-search/bin/HighlighterEverything.exe`**、把工作区再次弄脏。该问题按本节末"仓库策略问题"处理，**不塞进 M-1**。

**现状（实测）**：文档基线写的 `master @ b97391e` 指的是 **HEAD**（该值准确），但**工作区并不干净** —— 带着 4 项未提交改动，其中 3 项由本文档之外的在制工作引入：

| 路径 | 差异 | 性质 | 来源 |
|---|---|---|---|
| `package.json` | `selection-hook` `^2.0.2` → **`^2.1.1`** | 依赖升级（在制） | 2026-10-07 依赖升级计划的遗留 |
| `package-lock.json` | 同上（4 增 4 删），且 `resolved` 由 `registry.npmjs.org` 变为 `registry.npmmirror.com` | 依赖升级（在制） | 同上 |
| `native/everything-search/bin/HighlighterEverything.exe` | `Bin 343552 → 343552 bytes`（**同尺寸、内容不同**） | **纯重建噪声**（Rust 边车被重新构建） | 同上 |
| `.gitignore` | +3 行（忽略 `_repo_snow_apps/`） | 本文档配套 | 本次 |

另有两份**未跟踪**的在制规划文档（**2026-10-10 复核：两者均不存在于仓库，也从未提交**）：`docs/plans/2026-10-08-selection-toolbar-app-blacklist-research.md`、`docs/plans/2026-10-09-selection-toolbar-centered-placement-design.md`。

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
| **W0-1 main.js 容量腾挪** | 抽出纯函数以**净腾出 ≥20 行**（2026-10-10 实测可腾出约 25 行，见 §15 第 12 条 (f)）：`normalizeSettings`（`main.js:264-276`）→ `main/services/settings-normalize.js`；`resolveFfmpegPath`（`main.js:242-251`）→ `main/services/ffmpeg-path.js`；`saveImageBuffer` 的对话框分支（`main.js:856-862`）→ `main/services/image-file-save.js`。**必须同时改 4 处指向被抽走的 `main.js` 的源码断言**（见下；第 4 处 `test/recording-ui-contract.test.js:136` 由 2026-10-10 实测补入 —— 原方案只列了 3 处）。**实现约束**：`normalizeSettings` 依赖 `defaultHistoryDirectory`（`main.js:101`，运行时值）与 4 个已 import 的纯函数 → 须以工厂或第二参数注入；`resolveFfmpegPath` 依赖 `log` 与 `app.isPackaged` → 须工厂注入。 | `main.js`、`main/services/settings-normalize.js`（新）、`main/services/ffmpeg-path.js`（新）、`main/services/image-file-save.js`（新）、`test/settings-normalize.test.js`（新）、`test/ffmpeg-path.test.js`（新）、`test/image-file-save.test.js`（新）、`test/design-tokens.test.js`（`:119`，`/resolveMainColor/` 指向 `main.js:273`）、`test/selection-toolbar-settings.test.js`（`:68`，指向 `main.js:266`）、`test/update-ui-contract.test.js`（`:14`，指向 `main.js:271`）、`test/recording-ui-contract.test.js`（`:136`，`/未找到 MP4 编码组件/`；改为断言 `main.js` 的 `createFfmpegPathResolver` + 模块内的错误文案） | `main.js` ≤ **1280** 行（门禁读数）且**净腾出 ≥20 行**；`npm run check` 绿；**上述 4 个源码断言测试 + 3 个新单测全绿**；`npm run test:coverage:loaded` 不下降 |
| **W0-2 设置契约冻结** | 一次性写入**本期全部 15 个**新设置键（见 §2.1），此后本文件只读；同时**固化"契约变更流程"**（加键 / 加通道，见 §2.1.1） | `main/services/settings-defaults.js`、`test/settings-validation.test.js` | `test/settings-validation.test.js` 全绿；每个新键有类型用例 |
| **W0-3 IPC 登记规则冻结** | **冻结"登记时机"规则而非通道清单**：确认 `IPC_SURFACES` 只登记页面→主进程通道，且**每条通道与它的运行时注册点同一个 PR 落地**（修法 ①，见 §2.2）。**W0-3 不新增任何通道** | `main/services/ipc-security.js`（本波次只读核对）、`test/ipc-security.test.js`（基线核对） | `assertComplete()`（`main.js:1173`）通过；`electron .` 可正常启动；**W0-3 前后 `IPC_SURFACES` 通道集合不变** |
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

### 2.1.1 契约变更流程（加键 / 加通道；Wave 0 冻结之后的唯一合法路径）

Wave 0 冻结 `settings-defaults.js` 与 `ipc-security.js` 是为了防止并发写冲突，**不是禁止新增**。冻结后如需新键/新通道（例如某工作流在实施中才发现缺口），按以下流程：

1. **发起**：工作流**停止编码**，向 Lead 提交一条"契约变更请求"，内容为：**（加键）**键名 / 默认值 / 类型 / 用途 / 发起功能 / 为什么不能复用已有键；**（加通道）**通道名 / `handle` 还是 `on` / 角色 / 用途 / 发起功能 / **注册点所在文件与行** / 为什么不能复用已有通道。**加通道时必须与它的运行时注册点同一个 PR 落地**（§2.2 规则 2），不得先登记后落地。
2. **串行执行**：Lead 在**当前波次全部 owner 都处于暂停或已完成**时，以**单一提交**追加键或通道，并同步 `test/settings-validation.test.js` 或 `test/ipc-security.test.js` 的用例。
3. **广播**：Lead 向该波次所有活跃 owner 发一条变更通知（键名 + 默认值）。
4. **禁止**：任何工作流**不得**自行修改这两个文件；发现需要新键时**不得**改用"临时不落盘"等绕过手段（`settings-validation.js:30` 会以"不支持的设置项"直接拒绝）。

> 本流程的存在是 2026-10-10 独立审查的产物：此前 W0-2 宣称"此后只读"，而 §6.1 的 P0-7-T3 与 §5.3 的 P0-6-T4 都必须新增键 —— 形成一个**死锁**。现已把所需键一次性补进 §2.1，并留下这条合法回路。

### 2.2 IPC 通道的登记规则（W0-3 冻结"时机"，不冻结清单）

`main/services/ipc-security.js` 的 `IPC_SURFACES` **只登记"页面→主进程"方向的通道**（每条 surface 只有 `handles`（`invoke`）与 `listeners`（`send`）两个字段）。`main.js:1173` 在**模块顶层**调用 `assertComplete()`，而 `assertComplete()`（`ipc-security.js:279-283`）的语义是：**`IPC_SURFACES` 里的每个通道在运行时都必须已有注册点**。

> **⚠️ 修正 1（2026-10-10 独立审查发现，保留）**：`pin:click-through-changed` 与 `i18n:language` 是**主→渲染广播**（走 `webContents.send`），**不能**登记进 `IPC_SURFACES`：登记后没有对应的注册点，`assertComplete()` 会直接抛错，`electron .` 与 `scripts/probe-diagnostics-runtime.js:95` 的 `require('../main')` 全部挂掉。实测 `pin:init`、`search:status-changed` 等 23 个既有广播通道都**不在** `IPC_SURFACES` 中，与此一致。

> **⚠️ 修正 2（2026-10-10 第二轮复核发现，采纳修法 ①）**：本节的初版让 **W0-3 一次性登记** `capture:export-pdf` 与 `pin:set-click-through`，但这两个通道的运行时注册点分别落在 **S4·W1**（`main/ipc/capture-ipc.js`；且 §4.3 的 P0-4-T5 还要求 `main.js` 注入 dep，实际可能迟至 Wave 3）与 **S3·W1**（`main/domains/pin/index.js`）。于是从 W0-3 到注册点落地之间：`assertComplete()` 必抛、`electron .` 起不来、**`npm test` 也红**（`test/diagnostics-runtime.test.js:19` → `scripts/probe-diagnostics-runtime.js:95` → `require('../main')`）；若 W0-3 同时把旧 `pin:toggle-click-through` 的条目删掉，pin 域注册旧通道时还会直接抛 `IPC channel has no sender policy`。**结论：原 W0-3 的验收在 Wave 0 内不可满足**，并与 §0.2 的"`main.js` 只由 Lead 在收口接线"叠成硬冲突。

**登记规则（W0-3 冻结的唯一内容）：**

1. **只登记页面→主进程通道**；主→渲染广播**一律不进** `IPC_SURFACES`。
2. **每条通道与它的运行时注册点同一个 PR 落地。** W0-3 **不新增任何通道**：`capture:export-pdf` 随 S4·W1 的注册点、`pin:set-click-through` 随 S3·W1 的注册点，按 §2.1.1 的契约变更流程（"加键"已泛化为"加键**或**加通道"）由 Lead 串行登记，并与 `test/ipc-security.test.js` 同步。
3. **派发 S4 时的硬性要求**：`capture:export-pdf` 的注册**不得依赖 Wave 3 的 `main.js` 接线**（依赖注入须能在模块内自解析，或在 W1 内完成最小接线）；做不到就把该通道的登记与 `main.js` 接线一并推到 Wave 3，并相应推迟 P0-4 的验收。
4. **删除旧通道必须同步三处**：S3·W1 删除 `main/domains/pin/index.js:448-453` 的 `pin:toggle-click-through` 时，必须在**同一个 PR** 内改掉 `ipc-security.js:125` 的条目与 `test/pin-domain.test.js:35` 的硬断言。

**待登记的通道清单（登记时机见上方规则 2）：**

| 通道 | 角色 | 用途 | 归属 | 登记波次 |
|---|---|---|---|---|
| `capture:export-pdf` | `capture` | 截图导出 PDF | P0-4 / S4 | 与 S4 注册点同 PR（W1；受规则 3 约束） |
| `pin:set-click-through` | `pin` | 显式设置穿透（替代旧 `pin:toggle-click-through`） | P0-6 / S3 | 与 S3 注册点同 PR（W1） |

**不登记（主→渲染广播，随各波次自行实现，不走 `IPC_SURFACES`）：**

| 通道 | 方向 | 用途 | 归属 |
|---|---|---|---|
| `pin:click-through-changed` | 主→渲染 | 穿透状态回执 | P0-6 |
| `i18n:language` | 主→渲染广播 | 语言切换广播到 11 个窗口 | P0-1 |

> **W0-3 的验收**：`assertComplete()` 通过 且 `electron .` 可正常启动，**且 W0-3 前后 `IPC_SURFACES` 的通道集合不变**（本波次只冻结规则，不登记通道）。初版"未见通道列表为空"的写法对广播通道是伪要求，已作废。

---

## 3. 并行编排总览

### 3.1 独占写作用域表（冲突规则）

> **2026-10-10 重写**。初版按"文件/目录"粗粒度授权，独立审查发现同波次存在 3 组真实重叠（`capture-naming.js`、`function-router.js`、`main/domains/capture/index.js`），且"批次 A 三流零交集"的断言不成立。本节改为**按文件精确授权**，并以 §3.1.1 的注册表作为唯一 owner 来源。

**单写者文件（同一时刻只有一个 owner，须顺序移交）：**

| 文件/目录 | owner 顺序 | 规则 |
|---|---|---|
| `main.js` | Lead（W0-1）→ Lead（各收口波次） | 任何工作流禁止直接写；接线行写入 PR 说明 |
| `main/services/settings-defaults.js` | Lead（W0-2）→ 冻结只读 | 新键走 §2.1.1 加键流程 |
| `main/services/ipc-security.js` | Lead（W0-3 冻结**规则**）→ 之后**只由 Lead 在波次边界按 §2.1.1 串行追加通道** | 修法 ①（§2.2）：文件不再"只读"，但除 Lead 外任何工作流禁写；追加必须与注册点**同 PR** |
| `main/services/settings-normalize.js`、`main/services/ffmpeg-path.js`、`main/services/image-file-save.js` | **Lead**（W0-1 新建、W0-2 扩写归一化）→ 此后如需改动走 §2.1.1 | 2026-10-10 W0-1 抽出的三个模块；§2.1 要求的新设置键归一化统一落在这里，工作流不得自行修改 |
| `package.json` / `package-lock.json` | Lead | 含 c8 `--include` 增改 |
| `main/services/capture-naming.js` | **S7**（批次 A W1） | P0-4-T6 与 P0-7-T1 都要改它 → **统一归 S7**；P0-4 只调用不修改 |
| `main/services/function-router.js` | **S7**（批次 A W1） | P0-6-T4 与 P0-7-T3 都要改它 → **统一归 S7**；P0-6 提供接口约定 |
| `main/services/tray-menu.js` | **S7**（批次 A W1） | **2026-10-10 第二轮复核补入**：P0-6-T4 的托盘兜底出口是它的唯一写点。此前它只出现在 §3.1.1 的 S7 作用域里、**没有任何 S7 任务认领**，而 §5.3 的 T4 却把它派给 S3 → 归属无解；现统一归 S7 |
| `main/domains/capture/index.js` | **S4**（批次 A W1）→ **S9a**（批次 A W2）→ **S6**（批次 B W6）→ **S9b**（批次 B W7） | 四个写点串行，见 §3.1.1 |
| `capture/**`（含 `capture.html/js/css`、`annotation-geometry.js`） | **S9a**（A W2）→ **S6**（B W6）→ **S9b**（B W7） | 批次 A 的所有 `capture/**` 改动**推迟到 W2 的 S9a** |
| `config/**` | **S10a**（A W2）→ **S10b**（B W7.5）→ **S1**（C W9）→ **S14** | 四个写点串行 |
| `shared/i18n.js`、`shared/locales/**` | **S1**（批次 C） | Wave 0 之后归 S1 |
| `record/**` | **S2**（B W4）→ S7? 无 | 批次 B 独占 |
| `pin/**`、`main/domains/pin/**`、`preload-pin.js` | **S3**（批次 A W1） | 批次 A 独占 |
| `native/smart-select/**` | **S5**（批次 B W4） | 批次 B 独占 |
| `main/services/pdf-export.js`、`capture/print.html` | **S4**（批次 A W1） | 新建文件，不与 `capture/**` 冲突（S9a 只读它） |

**关键改动（相对初版）**：

1. `capture-naming.js`、`function-router.js`、`tray-menu.js` 从"多 owner"改为**单 owner（S7）**；P0-4-T6 与 P0-6-T4 相应改为**由 S7 承接**的相邻任务（§4.3 / §5.3 的写作用域列已同步，2026-10-10 第二轮复核）。
2. 批次 A 中所有 `capture/**` 与 `config/**` 的改动**移出 Wave 1**，推入 Wave 2 的 S9a / S10a，消除与 S3/S4/S7 的重叠。
3. §0.1 中"三流零交集"的表述**已删除**，改为"Wave 1 三流写作用域互斥（见 §3.1.1）"。

### 3.1.1 工作流注册表（S 编号的唯一来源）

| S | 波次 | 内容 | 独占写作用域 | 交付物 |
|---|---|---|---|---|
| **S1** | C·W9 | i18n 框架 + `config/` 全量迁移 | `shared/i18n.js`、`shared/locales/**`、`scripts/check-i18n.js`、`config/**`、`test/i18n.test.js`（新）、`test/i18n-contract.test.js`（新） | 框架 + 三语 + config 迁移 + 漏译门禁 |
| **S2** | B·W4 | 录屏音轨 | `record/**`、`main/services/recording-service.js`、`test/recording-utils.test.js`、`test/recording-service.test.js`、`test/audio-mixer.test.js`（新） | 音轨采集与混流 + ffmpeg 参数 + 定向测试 |
| **S3** | A·W1 | 贴图点击穿透接线 | `main/domains/pin/**`（含新 `geometry.js`）、`preload-pin.js`、`pin/**`、`test/pin-geometry.test.js`（新）、`test/pin-domain.test.js`、`test/ipc-security.test.js`、`test/capture-ocr-pin-ui.test.js` | 显式 set + 回执 + 角标 + 纯函数 + 测试；**旧通道三处同步删除**（§2.2 规则 4） |
| **S4** | A·W1 | 打印 / 导出 PDF（主进程） | `main/services/pdf-export.js`（新）、`capture/print.html`（新）、`main/domains/capture/index.js`、`main/ipc/capture-ipc.js`、`preload-capture.js`、`test/pdf-export.test.js`、`test/ipc-module-contracts.test.js` | 导出能力 + IPC + 纯函数 + 接线说明 |
| **S5** | B·W4 | 光标原生采集 | `native/smart-select/**`、`main/services/cursor-provider.js`（新）、`shared/cursor-geometry.js`（新）、`test/cursor-geometry.test.js` | C# `cursor` 命令 + 位置解析 + 纯几何 |
| **S6** | B·W6 | 标注元素二次编辑 | `capture/**`（除 `print.html`）、`main/domains/capture/index.js`、`test/capture-toolbar-icons.test.js` | PR1–PR4 + 快照栈 + `annotation-geometry.js`（c8 `--include` 追加由 Lead 执行） |
| **S7** | A·W1 | 体验细节（主进程部分） | `main/services/capture-naming.js`、`main/services/function-router.js`、`main/services/tray-menu.js`、`main/services/shortcut-*.js`、`shared/shortcut-keys.js`、`scripts/probe-diagnostics-runtime.js`、`test/capture-naming.test.js`（新）、`test/function-router.test.js`、`test/shortcut-ui-contract.test.js` | 命名模板 + 快捷键 handler + 兜底热键（含 P0-6-T4 托盘出口与 P0-4-T6 接口约定）+ 探针名单 |
| **S9a** | A·W2 | 批次 A 的 `capture/**` 接线 | `capture/**`、`assets/shutter.wav`（新）、`main/domains/capture/index.js`、`test/capture-toolbar-icons.test.js` | 打印按钮 + **打印图标与有序清单同步（P0-4-T7②，与 `capture.html` 同 PR）** + 快门音 + Ctrl+A + 序号 + saveMode |
| **S10a** | A·W2 | 批次 A 的 `config/**` 收口 | `config/**` | 快门音/命名模板/两个快捷键（P0-7-T3 的设置页行）/穿透开关的设置项 |
| **S10b** | B·W7.5 | 批次 B 的 `config/**` 收口 | `config/**` | 录屏音频/光标开关的设置项与文案 |
| **S9b** | B·W7 | 批次 B 的 `capture/**` 接线 | `capture/**`、`main/domains/capture/index.js` | 光标合成接线 |
| **S11** | C·W9 | i18n：`capture/` 窗口 | `capture/**` | capture 窗迁移 |
| **S12** | C·W9 | i18n：其余渲染窗 | `record/**`、`long-capture/**`、`action/**`、`search/**`、`recognition/**`、`toolbar/**` | 六窗迁移 |
| **S13** | C·W9 | i18n：主进程文案 | `main/services/tray-menu.js`、`main/services/update-service.js`、`main/services/everything-service.js`、`main/services/ai/client.js`、`main/services/function-router.js` | 托盘/更新/状态/错误文案（不含 `throw`，见 D6） |
| **S14** | A/B 之间·W8.5 | D2 配置页路由拆分 | `config/**`、`test/helpers/config-source.js`（新）、15 个 config 耦合测试的读取行**与 D2-4 的边界断言**（`test/config-model-helpers.test.js:20`、`test/model-config-ui-contract.test.js:72`、`test/design-tokens.test.js:156`） | 路由拆分 + 测试解耦 |

> **S 编号说明**：`S9a/S9b` 是同一个 `capture/**` 写点在**两个不同批次**的两次占用，不是两个并行 owner；`S1α` 已取消，批次 C 拆为 S1/S11/S12/S13 四路。**每个波次内，上表任一文件只能有一个 owner**。
>
> **跨波次交接清单（2026-10-10 第二轮复核补入）**：以下文件在同一波次内唯一，但被**不同波次**先后占用。前一 owner **未收口**（未通过自己的定向测试 + `npm run check`）时，后一 owner **不得开工**（§3.1.2 第 1 条）：`main/domains/capture/index.js`（S4→S9a→S6→S9b）、`capture/**`（S9a→S6→S9b→S11）、`config/**`（S10a→S10b→S1→S14）、`record/**`（S2→S12）、`main/services/function-router.js` 与 `main/services/tray-menu.js`（S7→S13）、`shared/*`（S7、S5→S1）。
>
> **测试文件 owner 补登说明（同上轮复核）**：初版注册表只登记了 `test/pdf-export.test.js`、`test/cursor-geometry.test.js`、`test/capture-naming.test.js`、`test/function-router.test.js`、`test/pin-geometry.test.js`，漏了 §5.3/§6.1/§7.3/§4.3 任务表已经指派的 9 个既有测试文件（`test/pin-domain.test.js`、`test/ipc-security.test.js`、`test/capture-ocr-pin-ui.test.js`、`test/recording-utils.test.js`、`test/recording-service.test.js`、`test/audio-mixer.test.js`、`test/ipc-module-contracts.test.js`、`test/capture-toolbar-icons.test.js`、`test/shortcut-ui-contract.test.js`）。这会让"注册表 = 唯一 owner 来源"失效，现已逐项补入上表。**同一测试文件在不同波次被两个 owner 触碰是允许的（如 `test/capture-toolbar-icons.test.js`：S9a·W2 加 print 图标 → S6·W6 补标注元素），但同一波次内只能有一个 owner。**

### 3.1.2 波次失败处置与回滚纪律

初版未定义，独立审查指出这是缺口。规则：

1. **半成品不得合并**：任何工作流若未通过自己的定向测试与 `npm run check`，其分支不得并入该波次收口。
2. **单流失败不阻塞同波次其他流**：某流失败时，Lead 在收口波次仅合并已通过的流，失败流**退出本波次**并进入下一波次重排；**不得**为凑齐进度而放宽验收。
3. **写作用域污染即回滚**：若发现某流改动了作用域外的文件，Lead 丢弃该流全部改动并重新派发（不尝试局部保留）。
4. **契约冻结后不可回退**：W0-2（设置键）一旦冻结即不撤销；W0-3 冻结的是**登记规则**（§2.2），通道本身按"与注册点同 PR"由 Lead 串行追加 —— 两者确需变更时均走 §2.1.1。
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

> **⚠️ 勘误（2026-10-10 实测，Wave 1 · S4 隐藏窗口探针）**：`printToPDF` 自定义 `pageSize:{width,height}` 的实际单位是**英寸**，**不是本节原写的微米**。同值传微米口径（`{width:158750,height:105833}`）直接 `Failed to generate PDF: Printing failed`；传 `{width:6.25,height:4.166667}` → MediaBox `450 × 300.96pt`（= 6.25in × 4.18in），与期望一致（证据 `.tmp/pdf-export-probe/units-result.json`）。**照原文实现会让"原图尺寸"导出 100% 失败。** 落地方式：模块内部保留"英寸 × 25400 = 微米"的口径与 200 英寸夹取（`pageSizeMicrons` / `requestedPageSizeMicrons` / `clamped` 全部保留且被单测覆盖），**只在交给 Chromium 的边界换算成英寸**（`micronsToInches`，`PAGE_SIZE_UNIT='inches'`）。
>
> **同轮实测的第二处修正**：自定义纸张的**下限是 1 英寸**（0.1 / 0.25 / 0.5 英寸均报 `invalid print parameters: content area is empty`），故取 `MIN_PAGE_INCHES = 1` —— 原文隐含的 0.1 英寸下限会让小尺寸截图失败。上限方面：实测 200 / 201 / 300 英寸均可出纸、1000 英寸失败，**200 英寸作为保守夹取保留**（R8）。另：`mode:'original'` 下必须 `landscape:false`，因为自定义 `Size` 已编码方向，再传 `landscape` 会让 Chromium 二次旋转。

### 4.3 任务拆解

| 任务 | 内容 | 写作用域 | 依赖 | 人日 |
|---|---|---|---|---|
| P0-4-T1 | 新增纯模块 `main/services/pdf-export.js`：`computePaperOptions({pxW,pxH,dpi,mode})`、`exportPdfBuffer(buffer,opts)`、`exportWindowToPdf(win,opts)` | `main/services/pdf-export.js`（新） | W0 | 1.0 |
| P0-4-T2 | 新增离屏页 `capture/print.html`（**只新建，不改 capture 其余文件**） | `capture/print.html`（新） | W0 | 0.25 |
| P0-4-T3 | 纯函数单测：纸张换算（A4/横向/原图/超限夹取）、命名 | `test/pdf-export.test.js`（新） | T1 | 0.5 |
| P0-4-T4 | 域工厂内新增 `exportPdf`（依赖注入 `printToPdf`/`savePdfBuffer`，便于 mock） | `main/domains/capture/index.js` | T1 | 0.5 |
| P0-4-T5 | IPC 接线：`main/ipc/capture-ipc.js` 注册 handler；`preload-capture.js` 暴露 `exportPdf`；**接线说明**：`main.js` 需注入 dep | `main/ipc/capture-ipc.js`、`preload-capture.js` + PR 说明 | W0-3、T4 | 0.5 |
| P0-4-T6 | 文件名复用 `main/services/capture-naming.js:15-19`，扩展 `makeCaptureName(prefix, ext)` | **—（由 S7 承接，见 §3.1）**：本任务只提供接口约定，实际落点归 P0-7-T1 | P0-7-T1 | 0.25 |
| P0-4-T7 | 契约测试更新（**2026-10-10 第二轮复核拆分为两半**）：① `test/ipc-module-contracts.test.js:86-145` 的通道 deepEqual 清单随 T5 留在 **S4·W1**（0.25）；② `test/capture-toolbar-icons.test.js:10-14,19` 的 print 图标 + 有序清单**移入 S9a·W2**（0.25），必须与 `capture/capture.html` **同 PR** | ① `test/ipc-module-contracts.test.js`（S4）；② `test/capture-toolbar-icons.test.js`（S9a） | T5 | 0.5（S4 0.25 + S9a 0.25） |
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
| P0-6-T4 | 兜底出口：全局快捷键 + 托盘"取消全部穿透"（多贴图上限 20，需批量入口） | **由 S7 承接（见 §3.1）**：`main/services/function-router.js`、`main/services/tray-menu.js` + 接线说明；S3 只提供批量退出的接口约定 | T1 | 0.5 |
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

**验收标准**：① 命名模板非空时导出文件名符合模板，且**该文件仍被历史库识别为"本应用所有"**（`OWNED_CAPTURE_FILE` 同源）；非法字符与 Windows 保留名被 sanitize；重名不静默覆盖。② 两个新全局快捷键可在设置页录入并触发"快速保存 / 另存为"；默认留空不抢占系统热键。③ 快速保存记住上次目录（`lastSaveDirectory` **读 + 写闭环**，见 §17.6）。④ 截图窗口打开时按快门音一次，关闭开关后不响。⑤ `Ctrl+A` 选中当前屏幕，且 Enter/Ctrl+S 等既有快捷键不受影响。⑥ 连续两次截图，序号各自从 1 开始。⑦ `test/capture-naming.test.js`（新）、`test/function-router.test.js` 全绿。

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

> **计数口径（2026-10-10 W0-4 实测，务必区分）**：`scripts/check-i18n.js` 统计的是**含 CJK 的行数**，不是可译串数。W0-4 落地骨架后的实测：`config` 299 / `capture` 67 / `record` 50 / `long-capture` 45 / `action` 46 / `search` 34 / `recognition` 29 / `toolbar` 11 / `pin` 0 / `main` 182（另有 **160 行** `main/**` 的 `throw` 按 **D6** 单独计数、不计入强制总数），**强制总数 763 行**。§10.1 的 ≈1000 条是**字符串**口径（config ≈660 等），两者**不可直接比较**；`--max` 的阈值必须以本 checker 的实测行数为基准逐批收紧。checker 还内置两项零容忍检查：三份 locale 的键集合对称差、以及 `data-i18n*` 键在表中缺失。主进程 `throw` 的分账口径与 D6 一致（W0-4 实测 160 行）。

**语言优先级**：`document.documentElement.dataset.language` → `localStorage` → 默认。
**切换生效**（mirror `theme` 的既有做法）：设置 effect 广播 `i18n:language` 到 11 个窗口，渲染层收消息重扫 DOM；`config` 窗靠 `updateSettings` 返回值本地重渲染（`config/config.js:129-136`）。

> **架构决策（2026-10-11，Lead）：locale 表按 domain 分文件。** 上面代码块里的三个语言文件**保留**（承载跨窗口公共键），另增 `shared/locales/<domain>.js`（domain ∈ `capture` / `record` / `long-capture` / `action` / `search` / `recognition` / `toolbar` / `main` / `config`），**每个文件同时注册三种语言**该 domain 的键。
>
> **理由**：Wave 9 声明为"四路并行"，但若全部键都写进同三个文件，S1/S11/S12/S13 会同时写同一文件 → 只能串行。按 domain 分文件后每个流独占自己的文件，四路才真正可并行（也顺带让每个窗口只加载自己需要的字符串）。
> **连带改动**：`scripts/check-i18n.js` 的 `loadLocales()` 由硬编码三文件改为**扫描 `shared/locales/*.js` 并按名排序全部 require**（否则新增 domain 文件不被检查）；`shared/i18n.js` 运行时**无需改动**（`Object.assign` 合并进 `__LOCALES[lang]` 即可）。
> **口径不变**：键名仍 `<domain>.<module>.<semantic>`；三语键集合对称差仍须为空（checker ①）；`--max` 仍以 checker 的实测行数为基准逐批收紧。

> **口径澄清（2026-10-11，Lead，Wave 9 四路并行期间由 S11/S12 上报后裁决）**
>
> 1. **迁移目标是"用户可见 UI 文案"，不是"CJK 行数归零"。** `scripts/check-i18n.js` 统计的是**含 CJK 的行数**，其中包含中文注释、类型校验/状态机的 `throw`、喂给模型的对话文本格式（§10.5-4）、以及存储/API 契约值（§10.5-3 的 `value`）。这些**都不翻**。因此各 area 的计数**不会到 0**（实测基线：config 307 / capture 223 / record 41 / long-capture 45 / action 46 / search 34 / recognition 29 / toolbar 11 / main 278 + 169 throw 出账）。
>    → **§10 验收标准②"未迁移清单逐批收紧到 0"按本条修正为**："收紧到**非 UI 残留**的实测值，并把残留清单显式登记（file:line + 不翻理由）"；Wave 10 收口时由 Lead 给 checker 加**豁免/忽略清单**机制（而不是把注释也翻译掉），`--max` 才随之收紧。
> 2. **`test/i18n.test.js` 的 `localeFiles` 断言采用"端态契约"形态**：断言 checker 报出的文件列表**排序正确**且**包含四路各自应新增的 domain 文件**（`capture.js`/`config.js`/`main.js`/`record.js` + 三个语言文件）。它在四路全部落地后才转绿 —— 这是 Wave 10 的验收点之一；**该文件的最终归一由 Lead 在收口时负责**（避免四路同时改它）。
> 3. **新增 locale 文件与窗口脚本同名会误伤 `indexOf` 断言**：`shared/locales/capture.js` 含子串 `capture.js`，会让 `html.indexOf('capture.js')` 命中语言包而非控制器脚本。**统一修法**：把这类断言改为匹配脚本标签本身（`html.indexOf('src="capture.js"')`）。S12（`record.js`/`action.js`）、S13 同理。
> 4. **纯模块的警告串改吐 i18n key**：`record/audio-mixer.js` 的降级文案改为返回 key（如 `record.audio.warning.*`），由 `record/record.js` 用 `t()` 渲染；`test/audio-mixer.test.js` 的 3 处中文断言随之同步（属"因文案迁移必须同步的测试"）。
> 5. **`--max` 默认不开**：checker 不传 `--max` 时**始终 exit 0**（已实测），所以"有残留 CJK"本身不会让任何测试变红；只有显式 `--max` 才会。
> 6. **窗口脚本不得解构 `window` 上的 i18n 绑定（S12 实测踩到）**：`t`/`setLanguage`/`applyTranslations` 是 `shared/i18n.js` 的**顶层 `const`**（全局词法作用域），窗口脚本写 `const { t } = window` 会抛 `Identifier 't' has already been declared` 并**整脚本不执行**。**用法**：直接 `t(...)`，或用新增的 `window.i18n` 命名空间（`shared/i18n.js` 已加，并附注释说明）。
> 7. **静态 HTML 文本不能传参**：`data-i18n` 只取表里的固定值；带插值的串必须在 JS 里 `t(key, params)` 渲染（`data-i18n-params` 不会被读取）。
> 8. **HTML 里的静态回退文案改为英文（S12 口径，已接受）**：这些窗口（record / long-capture / action / search / recognition）都是 `show:false` 建窗、**脚本执行后**才 `show()`，所以默认语言下不会出现英文闪烁；保留中文回退则那些行会永远计入未迁移数。S1/S11 的窗口（config/capture）保留中文标记不变（它们同样在 show 前完成翻译）。
> 9. **`toolbar/toolbar-action-meta.js` 的 `label`/`description` 键化后，`config/**` 的消费点必须跟着 `t()` 包一层**（S12 上报的 A1 方案）：否则设置页会显示裸键名。`config/**` 已释放，由 Lead 在 Wave 10 收口时改（`info.label` → `t(info.label)`）。

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
| R1 | `main.js` 仅 2 行余量，接线必然撞门禁 | **高** | W0-1 先净腾出 **≥20 行**（目标 `main.js` ≤1280；2026-10-10 复核下调，原"≥60 行 / ≤1240"按三处抽取实测不可达，见 §15 第 12 条 (f)）；`main.js` 由 Lead 独占 |
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
| **D2** | `main.js` 容量策略 | **先腾挪，暂不动 1300 上限**：W0-1 先抽出**净 ≥20 行**余量（目标 ≤1280，2026-10-10 复核下调），再做集成接线 | §2 W0-1、§11 步骤 1、R1 | 未采纳"直接提高上限"：会削弱 v2.3 架构减负（`main.js` 1298/1300）既有纪律的约束力；亦未采纳"削到 ≤1240"：按三处抽取实测不可达，且 `check-architecture.js:8-16` 已把剩余 ~90 行登记为 follow-up 而非本期目标 |
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
| M0 | Wave 0 完成：`main.js` ≤1280（净腾出 ≥20 行）；契约冻结（§2.1 的 15 键 + §2.2 的登记规则）；`npm run check` 绿 | 2–3 人日 |
| M1 | 批次 A 完成并真机验收 → v2.3.2 | +13.5 人日 |
| M2 | 批次 B 完成并真机验收 → v2.4.0 | +18.75 人日 |
| **M2.5** | **前置工程 D2 完成（§3.4）**：`test/helpers/config-source.js` 落地、15 个测试解耦、`config/config.js` 拆为 `config/routes/*.js`、8 个路由页 smoke 绿 → 随 v2.4.x。**这里是批次 C 的硬前置门（D7/D8）** | **+3.75–6.5 人日** |
| M3 | 批次 C 完成（三语言真机切换）→ v2.5.0。**前置门（D7）**：M2.5 已完成 | +16.75 人日 |
| M4 | P1 立项（Auto Filter / MCP） | **License 路线已选定（2026-10-10）：GPL-3.x（路线 A）**；**许可字符串 `or-later` 还是 `only` 待定**（F1-①/§13.2，建议 `-only`），定案前**不得开始任何移植**。路线 A 下 `snow_shot/`（GPL）实现可移植/逐行参照，P1 自研成本下降。**但移植同时触发四项 GPL 义务**（保留原作者版权、被修改文件注明改动与日期、衍生文件同许可、交互界面展示 Appropriate Legal Notices），见分析文档 §5.5.2 的 O1–O4；**落地清单（`LICENSE`/`COPYRIGHT`/`THIRD_PARTY_NOTICES.md`/About 页许可区块等 L1–L10）已规划但未执行**，见分析文档 §5.6 |
| M5 | **补第三方许可合规**（`ffmpeg-static` 为 GPL-3.0，当前零 NOTICE；另需复核 `native/everything/Everything.exe` 再分发条款） | 见分析文档 §5.2 / §5.6 L4+L8，与批次 A 可并行；**未执行** |

---

## 15. 与上游文档的差异记录

撰写本方案时对 `2026-10-10-snow-apps-feature-gap-analysis.md` 与既有假设做了**十二处**修正（第 7–11 项由 2026-10-10 的六路独立审查产出；第 12 项由 2026-10-10 的第二轮复核产出）：

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
12. **第二轮复核（2026-10-10，接续执行者，静态核对、未改业务代码）**：
    - **(a) 总账复现**：按 §4–§10 任务表逐项重算，**七项 = 49.0 人日**（P0-4 4.0 / P0-6 3.0 / P0-7 6.5 / 批次 A 13.5；P0-3 7.0 / P0-5 5.75 / P0-2 6.0 / 批次 B 18.75；P0-1 16.75），含工程开销 **55.25–59.5 人日**，与分析文档 §3 的 P0 表完全一致。**§0.1 无需改动。**
    - **(b) §4–§10 与 §3.1.1 的写作用域不一致（4 处，已修）**：`capture-naming.js`（§4.3 T6 vs S7）、`function-router.js`（§5.3 T4 vs S7）、**`tray-menu.js` 归属无解**（§3.1.1 归 S7 但无 S7 任务认领，§5.3 却派给 S3 → 现补 §3.1 单写者行并统一归 S7）、**P0-4-T7 的跨波次顺序缺陷**（图标清单断言在 W1、`capture/capture.html` 的图标在 W2 才加 → W1 收口必红，违反 §3.1.2 第 1 条；现拆为 S4·W1 的通道 deepEqual + S9a·W2 的图标与清单同 PR）。另补登 9 个已被任务表指派的测试文件 owner（§3.1.1）。
    - **(c) W0-3 时序硬缺陷（本轮最重要的发现，已按修法 ① 修正）**：`assertComplete()`（`ipc-security.js:279-283`）要求 `IPC_SURFACES` 每个通道**运行时已有注册点**，且 `main.js:1173` 在**模块顶层**调用它；`test/diagnostics-runtime.test.js:19` 经 `scripts/probe-diagnostics-runtime.js:95` 的 `require('../main')` 让 **`npm test` 同样受影响**。原 §2.2 让 W0-3 一次性登记 `capture:export-pdf`（注册点在 S4·W1，且可能迟至 Wave 3 的 main.js 依赖注入）与 `pin:set-click-through`（S3·W1）→ **Wave 0 无法绿着出口，`electron .` 起不来**。现 §2.2 改为冻结"**通道与注册点同 PR 落地**"的规则，W0-3 不新增通道；§0.2 第 2 条、§2 的 W0-3 行、§3.1 的 `ipc-security.js` 行、§3.1.2 第 4 条、§2.1.1（泛化为"加键 / 加通道"）已同步。
    - **(d) 开工前提已履行**：M-1 以 `07153a6` 结案（详见 §1.2 顶部复核框）；`_repo_snow_apps/` 已删除、两份 10-08/10-09 文档不存在、`selection-hook` 维持 2.0.2。
    - **(e) 待你拍板项（本轮未动）**：F1-①（许可字符串 `or-later`/`only`）、F1-②/③、L2 版权人署名、真机验证配合 —— 见 §13.2 与分析文档 §5.6。**`main/services/settings-defaults.js` 与 `main/services/ipc-security.js` 未做任何代码改动。**
    - **(f) W0-1 目标下调（2026-10-10 复核实测，已确认）**：原验收"腾出 ≥60 行 / `main.js` ≤1240"**按 W0-1 点名的三处抽取不可达** —— `normalizeSettings` 13 行 + `resolveFfmpegPath` 10 行 + `saveImageBuffer` 对话框分支 7 行 = 30 行代码，扣掉 3 条 `require` 与 2 处调用点改写（`defaultHistoryDirectory` 与 `log`/`isPackaged` 须注入）后**净腾出约 25 行 → `main.js` ≈1273**，距 1240 差约 33 行。且 `scripts/check-architecture.js:8-16` 已把剩余 ~90 行登记为 follow-up 而非本期目标，Wave 3 的真实接线需求约 8–12 行。**现目标改为"净腾出 ≥20 行 / ≤1280"**，同步落点：§2 W0-1 行、§12 R1、§13 D2、§14 M0。同时按复核结论为 3 个新模块补 3 个定向单测（`test/settings-normalize.test.js`、`test/ffmpeg-path.test.js`、`test/image-file-save.test.js`）并登入 W0-1 的写作用域 —— 它们会自动进入 `test:coverage:loaded` 的 `--include=main/services/**` 分母，不补单测会与 §1.1"覆盖率不下降"冲突。
    - **(g) 勘察已核实无误的项**：W0-1 点名的三条源码断言位置准确（`test/design-tokens.test.js:119`、`test/selection-toolbar-settings.test.js:68`、`test/update-ui-contract.test.js:14`）；**无任何测试枚举 `main/services/*` 文件清单**，新增 3 个模块不会误伤其它门禁；`shared/` 已存在、`shared/locales/` 与 `scripts/check-i18n.js` 不存在（W0-4 需新建）；W0-5 确认**无需新增依赖**（`ffmpeg-static`/`sharp`/`onnxruntime-node`/`jsqr` 均在）。
    - **(h) W0-1 实施结果（2026-10-10）**：`main.js` **1298 → 1267**（净 −31 行，满足"净 ≥20 行"目标；上限 1300 下余量 33 行）。新增 3 个模块 + 3 个定向单测（行覆盖均 **100%**）：`main/services/settings-normalize.js`（`createSettingsNormalizer({ defaultHistoryDirectory })`）、`main/services/ffmpeg-path.js`（`createFfmpegPathResolver({ loadCandidate, log, isPackaged })`）、`main/services/image-file-save.js`（`createImageTargetResolver({ dialog, ensureDirectory, getPicturesDirectory })`）。**源码断言实际为 4 处而非 3 处** —— 第 4 处 `test/recording-ui-contract.test.js:136`（`/未找到 MP4 编码组件/`）未被原方案列出，实测补入并同步（改为 `main.js` 断言 `createFfmpegPathResolver` + 模块内断言错误文案）。`check-js` 与 `check:architecture` 绿（Wave 0 收口读数为 244 个文件，见 §16.2）；29 个读取 `main.js` 的测试文件全绿。
    - **(i) W0-2 … W0-5 实施结果（2026-10-10）**：
      - **W0-2**：15 个新键一次性写入 `main/services/settings-defaults.js`（`language`、`pinned.clickThrough`；`screenshot.*` 5 个；`record.*` 5 个；`shortcuts.*` 3 个），并按 §2.1 要求同步进入归一化路径 —— `settings-normalize.js` 新增 `normalizeFrozenSettings`（语言白名单回落 `zh-CN`、7 个布尔 `=== true` 严格化、两个增益非有限数回落 1、字符串 trim、缺失域兜底）。`test/settings-validation.test.js` 新增"15 键逐个接受声明类型 / 逐个拒绝错误类型"两组用例；`test/settings-normalize.test.js` 新增 6 条归一化用例。覆盖率：`settings-normalize.js` 100%、`settings-defaults.js` 100%、`settings-validation.js` 97.0%。
      - **W0-3**：按修法 ① **`main/services/ipc-security.js` 一个字节未改**（`git diff` 为空），**未登记任何新通道**（`pin:set-click-through`/`capture:export-pdf`/`i18n:language`/`pin:click-through-changed` 均不存在）；`assertComplete()` 与 App 启动由 `test/diagnostics-runtime.test.js` 在**真实 Electron**中验证通过。
      - **W0-4**：`shared/i18n.js`（`t()`/`setLanguage`/`applyTranslations`/`observeTranslations` + key 约定 + 全局挂载）、`shared/locales/{zh-CN,en-US,zh-TW}.js`（空表，`globalThis.__LOCALES` 注入，CSP 安全，不 fetch）、`scripts/check-i18n.js`（键对称差 / key 形状 / `data-i18n*` 覆盖 / CJK 未迁移清单；支持 `--list`/`--max`/`--json`/`--area`）全部落地并通过运行验证。计数口径见 §10.3 的注。
      - **W0-5**：确认**无需新增依赖**；`npm run audit:dependencies` 绿（26 个已豁免、0 个未豁免），`package.json`/`package-lock.json` **未改动**。
      - **Wave 0 收口门禁实况**：`npm test`（测试文件 **106 → 109**、用例 **684 / 684 pass**）全绿；`check-js` **244 文件** + `check:architecture` 绿（`main.js` **1267**/1300）；`test:coverage:loaded` 行覆盖 **91.32%**（基线要求 ≥85）；`test:coverage:critical` 三文件 **93.22% / 92.99% / 92.42%**（要求 ≥90）；`audit:dependencies` 绿；Playwright e2e **5 / 5 passed**。
      - **环境注记（重要）**：本会话 shell 预设 `ELECTRON_RUN_AS_NODE=1`，会让所有 spawn Electron 的测试（`test/diagnostics-runtime.test.js`、`npm run test:runtime`、Playwright e2e）在探针 `app.setPath` 处即崩（`TypeError: Cannot read properties of undefined (reading 'setPath')`）。**跑 §1.1 门禁前必须先 `Remove-Item Env:ELECTRON_RUN_AS_NODE`**；清除后全部通过。这是环境事实，不是代码回归。

---

## 16. M0（Wave 0）实施结果（2026-10-10）

> 按 §11 收口：Wave 0 无外部接线（W0-1 直接改 `main.js`）→ 跑 §1.1 全量门禁 → 真实 Electron 启动验证 → 回填本节。写法沿用 `docs/plans/2026-10-06-capture-annotation-width-design.md` §10（改动表 + 门禁实况 + 偏差记录）。

### 16.1 已落地的改动

| 文件 | 改动 |
|---|---|
| `main/services/settings-normalize.js` | **新增**：`createSettingsNormalizer({ defaultHistoryDirectory })`（W0-1 从 `main.js:264-276` 抽出）+ W0-2 的 `normalizeFrozenSettings`（15 个新键：语言白名单、7 个布尔严格化、2 个增益有限数回退、字符串 trim、缺失域兜底） |
| `main/services/ffmpeg-path.js` | **新增**：`createFfmpegPathResolver({ loadCandidate, log, isPackaged })`（从 `main.js:242-251` 抽出；打包态 `app.asar` → `app.asar.unpacked`，失败抛"未找到 MP4 编码组件"） |
| `main/services/image-file-save.js` | **新增**：`createImageTargetResolver({ dialog, ensureDirectory, getPicturesDirectory })`（从 `main.js:848-866` 抽出；快速保存目录分支 + 原生对话框分支 + 取消返回 `null`） |
| `main.js` | **1298 → 1267 行**：删除三个被抽出的函数、迁移 3 条 import；新增 3 条 require + 3 行装配（`normalizeSettings`/`resolveFfmpegPath`/`resolveImageTarget`）；`saveImageBuffer` 改为调用 `resolveImageTarget` |
| `main/services/settings-defaults.js` | W0-2 一次性写入 §2.1 的 **15 个新键**（`language`、`pinned.clickThrough`、`screenshot.*` ×5、`record.*` ×5、`shortcuts.*` ×3），同时充当 `settings:update` 的校验模板 |
| `shared/i18n.js` | **新增**（W0-4 骨架）：`t()` 插值 + 默认语言回退链、`setLanguage`、`applyTranslations`、`observeTranslations`、`data-i18n*` 约定、语言优先级 `<html data-language>` → `localStorage` → 默认 |
| `shared/locales/{zh-CN,en-US,zh-TW}.js` | **新增**（W0-4 空表）：`globalThis.__LOCALES` 注入（CSP 下不可 fetch，必须是 `<script>` 全局） |
| `scripts/check-i18n.js` | **新增**（W0-4）：键集合对称差 / key 形状 / `data-i18n*` 覆盖 / CJK 未迁移清单；支持 `--max`/`--list`/`--json`/`--area` |
| `test/settings-normalize.test.js`（新，14 条）· `test/ffmpeg-path.test.js`（新，7 条）· `test/image-file-save.test.js`（新，7 条） | W0-1 的 3 个模块各带定向单测；3 个模块行覆盖均 **100%** |
| `test/settings-validation.test.js` | 追加 3 条：15 键逐个接受声明类型、逐个拒绝错误类型、validation 保持 type-only（共 11 条） |
| `test/design-tokens.test.js` · `test/selection-toolbar-settings.test.js` · `test/update-ui-contract.test.js` · `test/recording-ui-contract.test.js` | **4 处**指向被抽走代码的源码断言改指新模块（第 4 处为实测补发现，见 §15 第 12 条 (h)） |
| `main/services/ipc-security.js` · `package.json` · `package-lock.json` | **零改动**（W0-3 / W0-5 只做规则冻结与依赖确认） |

### 16.2 门禁实况

| 门禁 | 基线（§1.1） | Wave 0 收口实测 |
|---|---|---|
| `npm test` | 106 个测试文件 | **109 个文件 / 684 用例全绿**（新增 31 条用例：14+7+7+3） |
| `npm run check` | `main.js` 1298 行 | 语法 **244 文件**通过；`main.js` **1267** / 上限 1300（余量 33 行） |
| `npm run test:coverage:loaded` | 行覆盖 ≥85% | **91.32%**（9213/10088），未下降 |
| `npm run test:coverage:critical` | 单文件 ≥90% | **93.22% / 92.99% / 92.42%**（诊断 / 更新 / 窗口安全） |
| `npm run audit:dependencies` | 有白名单门禁 | **26 个已豁免、0 个未豁免**；无新增豁免 |
| Playwright e2e | 2 个 spec | **5 个用例 / 5 passed**（25.9s，副屏 `\\.\DISPLAY2`，`positionAutomationWindow` 生效） |
| 启动验证（W0-3 验收） | —— | `test/diagnostics-runtime.test.js` 在**真实 Electron** 中启动 `main.js`、`assertComplete()` 通过、正常退出 |
| 契约冻结核验 | —— | `ipc-security.js` `git diff` 为空；4 条新通道均**未**登记 |

### 16.3 与方案/设计稿的偏差（5 处）

1. **W0-1 目标下调**：原"腾出 ≥60 行 / ≤1240"按点名的三处抽取不可达（净约 25 行），经确认改为"**净 ≥20 行 / ≤1280**"；实际落地 **净 −31 行 → 1267**，超目标。依据与算术见 §15 第 12 条 (f)。
2. **源码断言是 4 处而非 3 处**：`test/recording-ui-contract.test.js:136` 断言 `main.js` 含 `/未找到 MP4 编码组件/`，方案未列出；已改为"`main.js` 断言 `createFfmpegPathResolver` + 模块内断言错误文案"，语义不变。
3. **W0-3 不再登记通道（修法 ①）**：原 §2.2 的"W0-3 一次性登记 `capture:export-pdf` + `pin:set-click-through`"会让 Wave 0 无法绿着出口（`assertComplete()` 抛错、`npm test` 红）；现改为冻结"**通道与注册点同 PR 落地**"的规则，`ipc-security.js` 本轮零改动。两条通道的登记移到 W1 与 S4/S3 的注册点一起做（§2.2 规则 2）。
4. **`scripts/check-i18n.js` 的计数口径**：统计"**含 CJK 的行数**"（实测 763 行：config 299 / capture 67 / record 50 / long-capture 45 / action 46 / search 34 / recognition 29 / toolbar 11 / pin 0 / main 182，另有 160 行 `main/**` 的 `throw` 按 D6 单独计数），与 §10.1 的"可译串数 ≈1000"不可直接比较；已在 §10.3 加注，`--max` 阈值须以本 checker 实测行数为基准逐批收紧。
5. **环境注记**：本会话 shell 预设 `ELECTRON_RUN_AS_NODE=1`，会让所有 spawn Electron 的测试在探针 `app.setPath` 处崩（`TypeError: Cannot read properties of undefined (reading 'setPath')`）。清掉该变量后全部通过；**这是环境事实，不是代码回归**（清除前 `npm test` 会红，容易被误判为 Wave 0 引入的回归）。

### 16.4 结论与 Wave 1 开工条件

**M0 出口条件全部满足**：`main.js` 1267 ≤ 1280（门禁上限 1300 下余量 33 行）；§2.1 的 15 键与 §2.2 的通道登记规则均已冻结；`npm run check` 绿；§1.1 全量门禁 + e2e 全绿；真实 Electron 启动验证通过。

**Wave 1（S4 / S3 / S7 三流并行）具备开工条件**，派发时每流必须带上：
1. §3.1.1 中分配给自己那一行的**独占写作用域**（含 2026-10-10 补登的测试文件）；
2. §3.1.2 的回滚纪律 + 跨波次交接清单（§3.1.1 表下注）；
3. **§2.2 规则 3（S4 专属）**：`capture:export-pdf` 的注册**不得依赖 Wave 3 的 `main.js` 接线**；做不到就把该通道登记与接线一并推到 Wave 3 并相应推迟 P0-4 验收；
4. **§2.2 规则 4（S3 专属）**：删除 `pin:toggle-click-through` 时三处同 PR 同步（`main/domains/pin/index.js`、`ipc-security.js:125`、`test/pin-domain.test.js:35`）；
5. **§2.2 规则 2（Lead 动作）**：每流落地注册点后，由 Lead 按 §2.1.1 在**同一提交**内登记通道并同步 `test/ipc-security.test.js`；
6. **环境**：派发前提醒 —— 跑 Electron 相关测试需清除 `ELECTRON_RUN_AS_NODE`。

---

## 17. M1（Wave 1 / 批次 A 主进程三流）实施结果（2026-10-10）

> 按 §11 收口：三流子智能体各自交付「代码 + 定向测试 + 门禁证据 + 接线说明 + 验收自证」→ Lead 落**冻结文件契约变更**与 `main.js` 接线 → §1.1 全量门禁 + e2e → 回填本节。写法沿用 §16 与 `2026-10-06-capture-annotation-width-design.md` §10。

### 17.1 已落地的改动（按流）

| 流 | 文件 | 改动 |
|---|---|---|
| **S4**<br>打印 / 导出 PDF | `main/services/pdf-export.js`（新，456 行） | `computePaperOptions`（A4 横竖 / 原图尺寸 / 200 英寸夹取 / **1 英寸下限** / `scale` 向下取 4 位）、`exportPdfBuffer`（离屏 `capture/print.html` + 30s 超时 + `closed` 钩子登记表 + `finally` 销毁）、`exportWindowToPdf`（复用已渲染的贴图/识别窗）、`savePdfBuffer`（保存对话框，取消 → `null`）；Electron 依赖全部可注入，纯 node 可加载 |
| | `capture/print.html`（新） | 单 `<img id="print-image">` + `@page{margin:0}`，CSP 镜像 `capture.html:5`；**并链接 `../shared/tokens.css`**（Lead 收口补入，见偏差 5） |
| | `main/domains/capture/index.js` | `exportPdf`（`:513`）：以 **PNG IHDR 为尺寸真值**（`meta` 兜底）、`dpi = 96 × scaleFactor` 还原 1:1 CSS 尺寸、保存对话框 parent 到截图窗、可选 DI（`deps.printToPdf` / `deps.savePdfBuffer`，缺省回落模块实现） |
| | `main/ipc/capture-ipc.js:17` · `preload-capture.js:24` | `ipcMain.handle('capture:export-pdf', controller.exportPdf)` · `captureAPI.exportPdf(imageBuffer, meta, mode)` |
| | `test/pdf-export.test.js`（新）· `test/ipc-module-contracts.test.js` | 28 条（含**真实 Electron 隐藏窗口**探针）；capture 模块 deepEqual 清单同步 |
| **S3**<br>贴图点击穿透 | `main/domains/pin/index.js` | `setPinClickThrough`（显式布尔；**仅真实跳变才调 OS**；回执无条件回送以便渲染层重同步）、`clearPinClickThrough`、`exitAllClickThrough()`（**无渲染器往返**，返回退出数）、`pin:set-click-through` 注册（旧 `pin:toggle-click-through` 删除）、右键"点击穿透"单选菜单（镜像透明度模板）、穿透态 move/resize/wheel 早退、`pinned.clickThrough` 作为新贴图**预显示前**的初始态 |
| | `main/domains/pin/geometry.js`（**扩展**，非新建） | `normalizePinRotation` / `getRotatedPinSize` / `hitTestPinHotspot` |
| | `preload-pin.js` · `pin/pin.html` · `pin/pin.css` · `pin/pin.js` | `setClickThrough(bool)` / `onClickThroughChanged(cb)`；`#clickThroughTag` 角标（沿用 zoomBadge 样式，`pointer-events:auto`）+ `mouseenter` 原地退出 + 拖动/滚轮守卫 |
| | 4 个测试文件 | `test/pin-geometry.test.js`(+7) · `test/pin-domain.test.js`（重写为记录式 harness，8 例，含无渲染器批量退出） · `test/ipc-security.test.js`(+1 显式契约测试) · `test/capture-ocr-pin-ui.test.js`(+1，且未破坏原"禁止 overlay 滑块"契约) |
| **S7**<br>体验细节 | `main/services/capture-naming.js` | `sanitizeFileName` / `renderNameTemplate` / `ensureUniqueName` / 模板化的 `makeCaptureName`；**所有权正则与生成器同源**（`OWNED_NAME_HEAD` + 有界标签段） |
| | `main/services/function-router.js` | `getPinDomain` dep；`screenshotQuickSave` / `screenshotSaveAs` handler（`autoAction:'save'` + `saveMode` fast/dialog）；`togglePinClickThrough` → `exitAllClickThrough()` 并透传数量、缺接口时降级为 0 + 一行日志 |
| | `main/services/tray-menu.js` | 可选 `exitClickThrough` dep + 常驻"取消全部穿透"托盘项（**游戏模式下仍可用**，是唯一的恢复路径） |
| | `scripts/probe-diagnostics-runtime.js` | 探针名单补 3 个 handler |
| | `test/capture-naming.test.js`（新，14 例）· `test/function-router.test.js`(+38) · `test/shortcut-ui-contract.test.js`(+59，含托盘行为测试) |
| **Lead**<br>（收口） | `main/services/ipc-security.js` | **契约变更（§2.1.1 加通道，与注册点同一提交）**：capture surface +`'capture:export-pdf'`（handle）；pin surface `'pin:toggle-click-through'` → `'pin:set-click-through'`（on） |
| | `main.js` | W1 `getPinDomain: () => pinDomain`（`:714`，否则快捷键路径静默返回 0）；W2 `exitClickThrough`（`:804`，**绕过 router** 以免游戏模式抛错）；W3 `saveImageBuffer` 模板化命名 + 唯一性探针 + `lastSaveDirectory` 记忆（经 `settingsService.updateSettings`，已核对该 API 存在于 `settings-service.js:138`） |
| | `test/shortcut-ui-contract.test.js` | 把 S7 注释掉的 `main.js` 接线断言改为真实测试 |

### 17.2 门禁实况

| 门禁 | Wave 0 收口 | **Wave 1 收口** |
|---|---|---|
| `npm test` | 684 / 684 | **736 / 736 pass**（+52：S4 28 + S3/S7 定向用例） |
| `npm run check` | `main.js` 1267 | 语法 **247 文件**；`main.js` **1294** / 上限 1300（**余量 6**） |
| `test:coverage:loaded` | 91.32% | **91.67%**（9900/10799） |
| `test:coverage:critical` | 93.22 / 92.99 / 92.42 | 93.22 / 92.99 / 92.42（未改动） |
| `audit:dependencies` | 26 / 0 | **26 / 0** |
| Playwright e2e | 5 / 5 | **5 / 5**（25.4s） |
| 启动验证 | ✅ | **✅**（`test/diagnostics-runtime.test.js`：真实 Electron 启动 `main.js`、`assertComplete()` 通过） |

### 17.3 偏差记录（8 处）

1. **§4.2 单位勘误（高）**：自定义 `pageSize` 单位是**英寸**而非微米（详见 §4.2 勘误框）。**照原文实现会让"原图尺寸"导出 100% 失败**；本流已按实测实现并保留微米口径的内部数学与单测。
2. **自定义纸张下限 = 1 英寸**（0.1/0.25/0.5 英寸均 `content area is empty`）；200 英寸上限为保守夹取（实测 300 英寸可用、1000 英寸失败）。
3. **`pin/geometry.js` 与 `test/pin-geometry.test.js` 并非新建**（`de1d3c7` 已存在），且 T5 点名的三个函数此前**不存在**于仓库 → 由"抽取"改为"扩展 + 新增"。**注意：三者当前无生产调用方**（旋转按 D5 延后），`hitTestPinHotspot` 是为后续旋转/方案 A 控制条留的接缝。
4. **`pinned.clickThrough` 此前无读取方**（冻结键缺消费者）→ 由 S3 接为"新贴图预显示前的初始态"，与 §2.1 注释"贴图穿透默认关"一致（解释性判断，已确认）。
5. **`test/design-tokens.test.js:168` 的目录级契约**被新页面 `capture/print.html` 触发（该断言按**目录**判定：capture/ 下任一 .css 使用 token ⇒ 该目录每个 .html 都必须链接 tokens.css）→ Lead 收口补 `tokens.css` 链接；`tokens.css` 只声明自定义属性，对打印页无视觉影响。
6. **`test/ipc-security.test.js` 对两条新通道都不需要改动**：其断言从 `IPC_SURFACES` + 源码扫描派生（`:96` 走 main.js/main\/ipc\/**/main\/domains\/**，`:143` 走 11 个 preload 文件），S3 另加了一条显式契约测试。
7. **`makeCaptureName` 的声明拼写（待你决定）**：`test/history-management-ui.test.js:72-73` 逐字固定**单参**声明，与 §4.3-T6 的 `(prefix, ext)` 矛盾。S7 保持声明逐字节不变、改从 `arguments[1..2]` 读取 ext/options（文件内 JSDoc 已注明）。**更干净的写法**是正常双参声明 + 同步该测试正则（§3.3 规则 9 允许），但会触及一条不在任何流作用域内的测试文件 —— 等你的意思。
8. **`{app}` 模板变量曾不一致（已修）**：原先保存路径注入 `app.getName()`（= `highlighter-snowshot`，因 `package.json` 无根级 `productName`，只有 `build.productName: "Highlighter"`），而历史/长截图路径与单测回落值是 `DEFAULT_APP_LABEL = 'Highlighter'`。**2026-10-10 已统一为 `Highlighter`**（提交 `3fb3d0d`：不再注入 `app`，全路径使用同一回落值）。

### 17.4 结论与 Wave 2 开工条件

**批次 A 的三条主进程流已全部落地**，并通过 §1.1 全量门禁 + e2e + 真实 Electron 启动验证。

> **✅ R1 已缓解（2026-10-10，提交 `3fb3d0d`）**：`main.js` **1294 → 1278**，余量回到 **22 行**。做法：把整个保存流程（模板化命名 + 快速路径唯一性探针 + 目标解析 + 写盘 + 目录记忆）迁入 `main/services/image-file-save.js` 的 `createImageFileSaver`（协作者均有真实缺省，`main.js` 只留一段绑定）。批次 B（Wave 5 的 `setDisplayMediaRequestHandler` + 光标 provider 注入）与批次 C（i18n 语言广播 + 托盘 labels）预计共需 10–15 行，现有余量足够；**Wave 2 本身（S9a/S10a）不需要 `main.js` 行**。

**Wave 2（S9a `capture/**` + S10a `config/**`）具备开工条件**，派发时必须带上：
1. §3.1.1 各自独占作用域 —— S9a 本轮**新增承接** P0-4-T7②："导出 PDF"图标 + `test/capture-toolbar-icons.test.js` 有序清单**同 PR**；
2. S7 交付的 **W6 设置页规格**（3 个快捷键 + `sourceLabels` 的 `quick-save`/`save-as`）与 **W7 capture 侧接线**（`_captureInit.saveMode`、`capture.js` 的 fast/dialog 分支）；
3. S4 交付的 **S9a 钩子**：工具栏"导出 PDF"默认 `mode:'a4'`，需要"原图尺寸"时传 `mode:'original'`；`exportPdf` handler **不关闭**截图窗口，由 S9a 决定；
4. 冻结键（已在 `settings-defaults.js`）：`screenshot.shutterSound` / `nameTemplate` / `captureCursor` / `keepSerialAcrossCaptures` / `lastSaveDirectory`、`pinned.clickThrough`、`shortcuts.screenshotQuickSave` / `screenshotSaveAs` / `togglePinClickThrough`；
5. §3.1.2 回滚纪律与跨波次交接清单（`capture/**`：S9a → S6 → S9b → S11；`config/**`：S10a → S10b → S1 → S14）；
6. 环境：Electron 相关测试前清 `ELECTRON_RUN_AS_NODE`。

### 17.5 命名模板的覆盖边界（2026-10-10 评审决定，提交 `3fb3d0d`）

Wave 1 的模板只覆盖了新保存点；评审旁路观察者指出**历史入库仍走旧格式**。核实后确认该缺口**比观察者描述更大**（共 5 处命名调用点，模板只到 1 处），经确认按**定向覆盖**处理：

| 命名调用点 | 跟随 `screenshot.nameTemplate` |
|---|---|
| 快速保存 / 另存为默认名（`saveImageBuffer`） | ✅ Wave 1 |
| **历史入库**（`HistoryService.historyImagePath`，普通与长截图条目） | ✅ **本轮新增** |
| **长截图保存**（快速路径 + 另存为默认名） | ✅ **本轮新增** |
| 录屏另存为默认名（`.mp4`） | ❌ 有意保持旧格式：`screenshot.*` 是截图键；按路径拆模板（对齐 Snow Shot 的"手动/自动/录屏三套"）属后续立项 |
| PDF 导出默认名（`createDefaultPdfName`） | ✅ **Wave 2 已跟随**（S9a 决定，经 `savePdfBuffer` 的 `makeName`；空模板 = 与旧格式逐字节相同的名字） |

**实现方式**：`main.js` 的 `makeCaptureName` 包装函数改为**透传**（`prefix, ext, nameSettings`），调用方按需传 `{ template }` —— "是否跟随模板"因此是各调用点的**显式选择**，而不是全局副作用（这也让录屏能干净地留在旧格式）。`test/history-management-ui.test.js:79` 的包装函数断言已同步为容忍扩展参数（同 `724be28` 的做法）。

**为什么仓库层面安全**：旧格式名与新模板名**都能被放宽后的 `OWNED_CAPTURE_FILE` 识别**（标签段可选），历史引用、缩略图与 `cleanup()` 的孤儿判定都不受影响；因此本次放宽模板覆盖**不会**产生"历史找不到自己文件"的风险。唯一需要留意的仍是 §17.3 第 2 条：该放宽让 `cleanup()` 的删除面扩到"模仿本应用命名约定"的文件。

### 17.6 P0-7B「记住上次目录」的读取方（2026-10-10 评审补齐）

Wave 1 只做了**写回**；评审旁路观察者指出该键**只写不读**。核实结论：`lastSaveDirectory` 全仓**仅一个写点**（`main.js` 的 `rememberDirectory`）、**零个读点**；而截图域调用 `saveImageBuffer(buffer, { fast })` 时**根本不传 `directory`** —— 因此读点只能落在保存模块，**不需要 S9a 参与**（比"写成 S9a 必交项"少一个跨流依赖）。

**落地方案（`main/services/image-file-save.js`）**：目录解析优先级 = `options.directory`（显式调用方）→ `lastSaveDirectory`（trim 后非空）→ `saveDirectory`（设置页配置的固定目录）；快速保存与另存为两个分支共用该解析；保存后**仅当解析出的目录与记忆值不同**时才回写 —— 比较用 `path.resolve`（Windows 下再折叠大小写），避免用户手输 `E:/shots` 与平台返回的 `E:\shots` 被当成两个目录、导致每次截图都写一次设置并广播。

**产品口径**：`saveDirectory` 从此是"尚未记忆时的默认目录"，记忆值优先 —— 这正是"记住上次目录"的字面含义；用户在设置页改回固定目录后，再保存一次即刷新记忆。附带效果：未配置固定目录的用户，只要经历过一次另存为，快速保存就不再弹对话框（此前 `fast` 因无目录而回落对话框）。

**与本轮同时对齐的"打开目录"两处**：`main.js:1010` 的 `openSaveDirectory`（设置页"打开截图目录"）与 `main/services/function-router.js` 的 `openImageSaveFolder`（托盘/快捷键）原先都按 `saveDirectory` 打开 —— 在保存位置可能落在记忆目录之后，它们会打开错的文件夹。现两者统一调用 `image-file-save.js` 导出的 **`resolveSaveDirectory(settings)`** 单一来源，与保存解析完全同源（"打开截图目录"因此与文件实际落点一致）。

**本轮明确不覆盖的两处（已登记，非遗漏）**：

| 位置 | 现状 | 处置 |
|---|---|---|
| `main/domains/capture/index.js:451`：复制后自动保存的前置条件 `autoSaveOnCopy && saveDirectory` | 仅在配置了固定目录时才自动保存 | ✅ **Wave 2 已修**（S9a 改为 `resolveSaveDirectory(settings)`，与保存解析同源） |
| `main/domains/long-capture/index.js:221`：长截图保存目录 | 只读 `saveDirectory`，且**不写回**记忆 | 长截图本轮已跟随命名模板，但目录记忆未纳入；如需请单独立项 |

---

## 18. M1（Wave 2 / 批次 A 接线与收口）实施结果（2026-10-10）

> 按 §11 收口：S9a / S10a 各自交付五件套 → Lead 落零散接线（本轮 `main.js` **零改动**）→ §1.1 全量门禁 + e2e → 回填本节。

### 18.1 已落地的改动

| 流 | 文件 | 改动 |
|---|---|---|
| **S9a**<br>capture 接线 | `capture/capture.html` | `#exportPdf` 按钮（插在保存与复制之间，`icons/print.svg`）+ `<audio id="shutterSound" src="../assets/shutter.wav" preload="auto">`；**CSP 未改**（见 18.3-7） |
| | `capture/icons/print.svg`（新） | 本地手绘打印机字形，符合 `test/toolbar-icons.test.js:27` 的 mask 资产契约；`capture/icons/LICENSE` 追加"该文件非 Bootstrap 来源"的说明（L4 合规口径） |
| | `capture/capture.js` | `playShutterSound()`（吞掉 play() 拒绝）、`resetSerialNumber()`；`saveMode` 表达式；`action==='pdf'` 分支（重入守卫 + 禁用按钮 + `finally` 复位 + **不关窗**）；`Ctrl+A` 选当前屏（排除 shift/alt，清 OCR 覆盖层）；`onInit` 调序号重置 + 受 `shutterSound` 控制播一次 |
| | `main/domains/capture/index.js` | `autoplayPolicy:'no-user-gesture-required'`；`_captureInit` += `saveMode` + `serialNumber`；复制自动保存前置条件改 `resolveSaveDirectory(settings)`；PDF 默认名经 `makeName` 跟随 `screenshot.nameTemplate` |
| | `assets/shutter.wav`（新） | 本地合成的 130ms 双响快门，PCM 44.1kHz 单声道 16bit（**无第三方权利**；生成脚本留在 `.tmp/` 未入库） |
| | 测试 | `test/capture-export-pdf-ui.test.js`、`test/capture-experience-wiring.test.js`、`test/capture-renderer-runtime.test.js`（真实隐藏 Electron 窗口）（均新）；`test/capture-domain.test.js` +4；`test/capture-toolbar-icons.test.js` 有序清单 + print（**与图标同 PR**，即 §4.3 T7 拆分的初衷） |
| **S10a**<br>config 收口 | `config/config.js` | `functionGroups.other` += 3 个快捷键行（S7 规格）；`sourceLabels` += `quick-save`/`save-as`（**+ Lead 补 `region`**，见 18.3-2）；截图与输出卡片 += 快门音开关、命名模板输入（提示写明旧格式 + 变量 + sanitize/去重）、序号跨截图开关；新增"固定到屏幕"卡片承载 `pinned.clickThrough`；`saveFunctions` 提交 `nameTemplate` |
| | `test/shortcut-ui-contract.test.js`（+76）· `test/config-icon-contract.test.js` | 行/开关/提交-回读断言 + 真实校验器正反用例；图标计数 23 → 26（规则 C6 同步） |
| **Lead** | `test/pdf-export.test.js` | 跨流集成修复：harness 补 `getSettings`（见 18.3-8） |
| | `config/config.js` | 补 `region` 标签（1 行 + 注释） |

### 18.2 门禁实况

| 门禁 | Wave 1 收口 | **Wave 2 收口** |
|---|---|---|
| `npm test` | 736 / 736 | **765 / 765 pass**（114 个测试文件） |
| `npm run check` | `main.js` 1294 | 语法 **250 文件**；`main.js` **1278** / 1300（余量 **22**） |
| `test:coverage:loaded` | 91.67% | **91.84%**（9996/10883） |
| `test:coverage:critical` | 93.22 / 92.99 / 92.42 | 93.22 / 92.99 / 92.42 |
| `audit:dependencies` | 26 / 0 | **26 / 0** |
| Playwright e2e | 5 / 5 | **5 / 5**（25.4s） |

### 18.3 偏差与决定（9 项）

1. **图标计数断言同步**（S10a 的 D1）：`test/config-icon-contract.test.js:35` 硬编码 `functionIcons.length === 23`，三个新快捷键行使之为 26 → 同步为 26（规则 C6）。该文件名不在派发时给 S10a 的字面 glob 内，属合理越界，**已接受**。
2. **`sourceLabels` 缺 `region`**（S10a 的 D2，Lead 补）：`main/domains/capture/index.js:341` 把普通截图存为 `source:'region'`，而 `capture` 只是 `history-service.js:366` 给旧数据的兜底 —— 历史筛选下拉此前把最常见的来源显示成裸 `region`。已补 `'region': '区域截图'`。
3. **派发前提有误**（S10a 的 D3）：我写的"Ctrl+S/Ctrl+Shift+S 常用占用"提示并不存在于 `config.js`；真实机制是通用红片（`shortcutPresentation`）+ 页面描述，未被触碰。三个新键默认 `''` → 渲染"未设置"，不会抢占系统热键。
4. **§6.1-T5 的 CSP 指令不必要**（S9a 实测）：方案要求 `media-src` 补 `file:`，但真实页面在 `media-src 'self' blob:` 下把 `../assets/shutter.wav` 加载到 `readyState 4`、`error 0`、**零** CSP/媒体控制台消息，`play()` 无拒绝 → **CSP 保持不动**（证据 `.tmp/capture-renderer-probe/result.json`）。
5. **S9a 被授权的三项决定**：① **A4 是唯一模式**（未暴露"原图尺寸"，也没有隐藏修饰键）；② **导出后不关闭截图窗口**（主进程 handler 本就不关；取消与成功流程一致，用户仍可复制/保存/贴图）；③ **PDF 默认名跟随 `screenshot.nameTemplate`**（落地 §17.5 的开放项，空模板 = 逐字节相同的旧名字）。
6. **`keepSerialAcrossCaptures` 是粗粒度实现**：启用后按"第 N 次截图从 N 开始"接续（`main/domains/capture/index.js` 的 `captureSerialSeq`）；精确到"上一张实际用掉的最后一个序号"需要渲染层回报 → 新通道/新键 → 属 §2.1.1 契约变更，**本期不做**（已在代码注释与本节登记）。
7. **计划行号在 Wave 1 后偏移 +5**（S10a 的 D4）：派发时给的锚点在 ±1 行内仍有效，各流均以磁盘为准复核。`npm run check` 文件数 250 而非 §17.2 的 247，差额是 S9a 新增的 3 个 JS 文件。
8. **跨流集成缺陷（本波次收口门禁的价值所在）**：S9a 让 `exportPdf` 经 `getSettings()` 取名后，S4 在 Wave 1 写的 `test/pdf-export.test.js` harness **没有注入 `getSettings`** → "the capture domain uses the module save helper when nothing is injected" 抛 `getSettings is not a function`。**两个流各自全绿、合并后才暴露。** 处置：`getSettings` 是域的真实契约（`main.js` 一直注入、其它 handler 无保护调用），因此**修 harness 而不是在生产代码里加防御性回落**（提交 `f8b2109`）。
9. **工具栏宽度观察（未处理）**：`.toolbar` 有 `max-width: calc(100vw - 20px)` 但**没有 flex-wrap**，窄屏下本就可能溢出；新按钮再加宽约 33px。属**既有**条件，非本轮引入；登记待后续（可与 P0-7 的体验项或 v2.4 的工具栏重排一并处理）。

**顺带修复**：`test/capture-domain.test.js` 此前泄漏 8s 渲染超时定时器，S9a 让 fake `close()` 清理后，该文件运行时间 **8.13s → 0.13s**。

### 18.4 批次 A 代码已全部落地 —— 只剩 Wave 3 真机验收

三条主进程流（Wave 1）+ 两条接线流（Wave 2）全部完成并通过 §1.1 全量门禁 + e2e；**`main.js` 未增加任何行**（1278/1300）。批次 A 的剩余唯一事项是 **§11 步骤 4 的真机验收**（副屏 `\\.\DISPLAY2`），验完即可按 §11 步骤 5/6 回填并出 v2.3.2。

> **2026-10-11 补充**：用户决定"测试都先跳过，先进行后续开发，开发完成后统一测试处理"→ 批次 A 剩余真机项**全部挂账**（清单见 `2026-10-10-p0-batch-a-verification.md` §7），批次 A 收口**不再阻塞** Wave 4。另：**§18.3-6 的"粗粒度、本期不做"已被推翻** —— 真机首验抓到序号重复（一张图落 3 个序号后下一张从 3 开始），已修复为精确接续（提交 `c116b58`，详见验收记录 §3.6）：主进程改记"下一个该用的号"，渲染层在导出/编码完成后经**既有通道的 `meta.serialNumber`** 与 `capture:close` 载荷回报，主进程只接受前进。**不新增 IPC 通道、不改 `main.js`、不碰冻结文件**。

---

## 19. M2（Wave 4 / 批次 B 前两流 + Wave 5 接线）实施结果（2026-10-11）

> 按 §11 收口：S2 / S5 各自交付五件套 → Lead 落接线（`main.js` +5 行、`package.json` c8 include）→ §1.1 全量门禁 + e2e → 回填本节。**真机项按用户指示整体挂账**（本批次的 T6/T8）。

### 19.1 已落地的改动

| 流 | 文件 | 改动 |
|---|---|---|
| **S2**<br>录屏音轨 | `record/audio-mixer.js`（新，227 行） | `createGainPlan` 纯函数（非有限→1、负值→0、上限 4、仅两条总线都出声且和>1 时防削波衰减）；`createAudioMix` 注入 `AudioContext`，总线只按**实际存在**的流计算 master；`describeAudioOutcome` 固化降级文案；失败一律 inactive+warning 不抛 |
| | `record/record.js`（594→815） | `prepareSource()` 拆出 `acquireDesktopStream()`：主路径 `getDisplayMedia`（系统声失败先重试 `audio:false`）；`canvas.captureStream()` 后 `addTrack` 混音轨；MediaRecorder 优先 opus mime + `audioBitsPerSecond`；`devicechange` + 轨 `ended` 热切换；降级提示复用 `#statusLabel` 后缀（**不新增 DOM/CSS**） |
| | `record/recording-utils.js`（214→257） | `buildFfmpegArgs(input, output, options?)`：`audio:true → -map 0:v:0 -map 0:a? -c:a aac -b:a 160k -ar 48000 -ac 2`；**两参调用逐 token 不变**（`-an`） |
| | `main/services/recording-service.js` | `transcode(..., options = {})` 原样透传 |
| | 测试 | `test/audio-mixer.test.js`（新，12 用例）· `test/recording-utils.test.js` +3 · `test/recording-service.test.js` +1 |
| **S5**<br>光标采集 | `native/smart-select/Program.cs`（339→553） | 新增 `cursor` 命令：`GetCursorInfo` + `GetIconInfo` + `DrawIconEx` 到 32bpp ARGB + PNG（保 alpha）；两个 GDI 位图在 `finally` 释放；`CURSOR_SHOWING=0 → showing:false`；**既有 `ready` / `id x y` 语义未动** |
| | `native/smart-select/build.ps1` | `/reference:System.Drawing.dll` |
| | `main/services/cursor-provider.js`（新，291 行） | 懒启动、250ms 形状缓存（`fresh:true` 绕过）、缺失/超时/中途退出一律返回 `null` 不抛 |
| | `shared/cursor-geometry.js`（新，206 行） | UMD：`resolveCursorPlacement` + `parseHelperMessage` + `toCursorDataUrl` |
| | `test/cursor-geometry.test.js`（新，602 行） | 29 用例（几何 5 类边界 + 协议解析 + provider 传输/缓存/降级） |
| **Lead**<br>接线 | `main/domains/record/index.js` | `setDisplayMediaRequestHandler`（按 `audioRequested` 决定是否给 `loopback`，按 `display.id` 用 `pickDesktopSource` 选源）；`_recordInit` += 4 个冻结音频键；`saveMp4` 透传 `{ audio }` |
| | `record/record.html` | `<script src="audio-mixer.js">`（渲染层另有懒加载兜底） |
| | `main.js`（1278→**1286**） | `createCursorProvider` require + `let cursorProvider` + 在 `createCaptureDomain` 前构造 + 注入 deps + `will-quit` 释放（**懒启动，未查询不起进程**） |
| | `package.json` | `test:coverage:loaded` 追加 `--include=shared/cursor-geometry.js`（§3.3 第 8 条要求的提请） |
| | `test/record-domain.test.js` | harness 补 `webContents.session.setDisplayMediaRequestHandler`；+2 用例（handler 尊重 `audioRequested`/`videoRequested`、save 路径从冻结键派生 `{ audio }`） |

### 19.2 门禁实况

| 门禁 | Wave 2 收口（§18.2） | **Wave 4/5 收口** |
|---|---|---|
| `npm test` | 765 / 765 | **814 / 814 pass**（+49 用例） |
| `npm run check` | 语法 250 文件；`main.js` 1278 / 1300 | 语法 **255 文件**；`main.js` **1286** / 1300（余量 **14**） |
| `test:coverage:loaded` | 91.84%（9996/10883） | **92.2%（10752/11661）**（新增模块自带测试，分母 +769 而覆盖上升） |
| `test:coverage:critical` | 93.22 / 92.99 / 92.42 | 93.22 / 92.99 / 92.42（不变） |
| `audit:dependencies` | 26 / 0 | **26 / 0** |
| Playwright e2e | 5 / 5 | **5 / 5**（25.8s） |

### 19.3 偏差与决定（6 项）

1. **热点按 1:1 减，而不是 ×scaleFactor（S5 的 D1，已接受）**。方案 §9.3 风险条写的"减去热点 × scale"基于"位图是逻辑像素"的假设，实测推翻：本机 150% 下 DPI-unaware 进程给 32×32 位图/热点 (3,9)，而 helper（PMv2）给 48×48/热点 (5,14) —— **`GetIconInfo` 返回的位图已被系统按 DPI 缩放，热点与它同一像素空间**；本管线把位图按自然尺寸贴到物理像素画布，故热点必须 1:1，再乘 scaleFactor 会在 125% 下多偏 25%（正是该风险条警告的偏移）。已用测试钉死并留反面断言，另留可选 `drawScale`（默认 1）。
2. **provider 独立起一个 helper 进程（S5 的 D3，已接受）**。方案原意是复用 smart-select session，但 `main/domains/capture/smart-select.js` 的解析只认 `rects`，且它是 S4/S9a 作用域 → S5 不改它，改为自带薄会话。代价：冷启动多一次 ~61–73ms（单次查询 1–6ms）；收益：零跨作用域改动。若日后要省这次启动，需 S9b 在 `smart-select.js` 放行 cursor 载荷（3 行）。
3. **识别路径默认不画光标（Lead 决定）**。`includeAnnotations === false` 的 OCR/翻译/表格/二维码路径不贴光标，避免把光标混进识别输入；截图/复制/保存路径正常贴。
4. **光标取"抓屏时刻"（Lead 决定）**。与用户看到的冻结画面一致；若改"动作时刻"需在 `performAction` 前查询，属 S9b 的实现选择。
5. **旧 `getUserMedia({mandatory:{chromeMediaSource:'desktop'}})` 保留为纯视频兜底（S2 的偏差 2，已接受）**。它**绝不请求音频**（规避 electron#42765/#25120），仅在 `setDisplayMediaRequestHandler` 未注册时不至于让录制功能整体不可用；代价是"无声 + UI 明示"。
6. **`long-capture/long-capture.js` 仍用旧写法（纯视频、无音频）**，不属 P0-3，未动（S2 的偏差 6，登记备查）。

### 19.4 结论与 Wave 6 开工条件

批次 B 的两条独立流（录屏音轨 / 光标采集）与 Wave 5 接线全部落地并通过 §1.1 全量门禁 + e2e；`main.js` 净 +8 行（余量 14，仍够 Wave 6/7 的预计接线）。**光标进图的截图侧合成属 Wave 7（S9b）**，标注二次编辑属 Wave 6（S6），两者都在 `capture/**` 上串行 —— 因此 **Wave 6 开工条件是 S6 独占 `capture/**` 并完成 PR1–PR4**。真机项（音轨四组合、光标 100%/125%、副屏负坐标）按用户指示**统一挂账**。

---

## 20. M2（Wave 6 / S6 标注二次编辑 PR1–PR4）实施结果（2026-10-11）

> 按 §8.4「4 个可独立合并的 PR」逐 PR 串行派发：每个 PR 落地后 Lead 复核 `git status` 对照作用域、审关键 diff、跑该 PR 的定向测试 + 真实 Electron 隐藏窗探针，再提交下一个。**`capture/**` 全程单写者**（§3.1.1）。

### 20.1 已落地的改动（4 个提交）

| PR | 提交 | 文件 | 内容 |
|---|---|---|---|
| **PR1**<br>选中+删除+快照栈 | `ba35790` | `capture/annotation-geometry.js`（新，258 行） | `annotationBounds` / `hitTestAnnotation` / `findAnnotationAt`（逆序取最上）/ `translateAnnotation` / `cloneAnnotations`；`MAX_ANNOTATION_HISTORY=60`、`MAX_PEN_POINTS=10000`、`DEFAULT_HIT_TOLERANCE=6`；rect/ellipse 走**环带**命中（空心区不吞拖动） |
| | | `capture/capture.js` | 历史从"数组即栈（pop 末尾）"升级为**深拷贝快照栈**（`annotationHistory`/`historyIndex`）；`commitAnnotation` 补单调 `id`；选中态 + 虚线框 + `#elementBar`；Delete/Esc；§8.4 的 pointerdown 优先级；**D4 落地项**（重划选区先 `confirm`，确认后仍压一帧快照使其可撤销）；`event.buttons===0` 自愈（模态 `confirm()` 会吞掉 pointerup） |
| | | `capture/capture.html` / `capture.css` | `#elementBar`（纯文字按钮）+ 样式；`annotation-geometry.js` 引在 `capture.js` 之前 |
| | | 测试 | `test/capture-annotation-geometry.test.js`（新）+ `test/capture-toolbar-icons.test.js`（元素条不进 `.toolbar`、不引 mask 图标守卫） |
| **PR2**<br>拖动 | `6f1cca4` | `capture/annotation-geometry.js` | `clampAnnotationToStage`（整体包含，元素大于舞台时退化为贴边） |
| | | `capture/capture.js` | 元素体内拖动（只从按下时的 `origin` 生成副本，原对象永不改）；`pointerup` 有位移才压一帧、0 位移不压、`pointercancel` 回滚；方向键 1px / Shift 10px（500ms 静默合并为一次可撤销）；**Alt+拖动 = 移动选区**（见 20.3-1） |
| **PR3**<br>8 手柄缩放 | `c8e245c` | `capture/annotation-geometry.js` | `resizeAnnotationToBox`：rect/ellipse/blur/watermark 采用新 box；line/arrow/highlight **保端点方向**（镜像不翻）；pen 逐轴等比 + 新数组；text 仅移动+字号；serial 仅半径（`number` 不变）；任何一维 <3px 抬到 3px |
| | | `capture/capture.js` | `resizingAnnotation` 态；复用 `selection-utils` 的 `getResizeHandle`/`resizeSelection`，**bounds 传舞台**；`drawSelectedHandles()` 画 8 个圆点（`--primary` 填充 + 白描边，与选区白底橙边方块区分） |
| **PR4**<br>层级+样式 | `3f1dcd0` | `capture/annotation-geometry.js` | `reorderAnnotation`：只移一层；越界/未知目标/零方向/空数组一律返回等价浅拷贝不抛错 |
| | | `capture/capture.js` | 层级 ↑↓（只改数组顺序 → 屏幕与导出层序同时改变，**绘制代码零改动**）；`applyStyleToSelectedAnnotation`（生成副本 → 替换数组项 → 一次快照）；离散样式（线宽按钮）与连续样式（取色器，静默合并 + `change` 立即收口）**分开压帧**，避免两次用户操作挤进同一撤销步 |

**验收自证（§8.4 六条）**：① 任意类型可选（10 种类型逐类型用例 + 真实窗口点选）✅；② 拖动 / 8 手柄缩放 / Delete / 层级上下移 / 改颜色线宽 ✅；③ 每次编辑 `Ctrl+Z` 精确回退（含 pen 点集深拷贝）✅；④ 导出与屏幕逐像素一致（探针像素差 ≤1px，即描边半宽）✅；⑤ `test/capture-annotation-geometry.test.js` 12 条纯函数用例全绿（第 10/11 条分别随 PR3/PR4 落地）✅；⑥ D4 落地项：`confirm` 取消后标注与选区**双双原状**，确认后清空可 `Ctrl+Z` 找回 ✅。

### 20.2 门禁实况（Wave 6 收口）

| 门禁 | Wave 4/5 收口（§19.2） | **Wave 6 收口** |
|---|---|---|
| `npm test` | 814 / 814 | **855 / 855 pass**（+41 用例） |
| `npm run check` | 语法 255 文件；`main.js` 1286 / 1300 | 语法 **257 文件**；`main.js` **1286** / 1300（未变） |
| `test:coverage:loaded` | 92.2%（10752/11661） | **92.62%（11220/12113）** |
| `test:coverage:critical` | 93.22 / 92.99 / 92.42 | 93.22 / 92.99 / 92.42（不变） |
| `audit:dependencies` | 26 / 0 | **26 / 0** |
| Playwright e2e | 5 / 5 | **5 / 5**（25.9s） |

### 20.3 偏差与决定（6 项）

1. **Alt+拖动 = 移动选区（Lead 决定，PR2 落地）**。方案 §8.4 的优先级让"元素命中"先于"拖选区"；而 `watermark` 按设计**铺满整个选区**、大范围 `blur` 也常覆盖选区 —— 此时用户将**无法移动选区**（这是 PR1 引入的真实可用性回归）。选择**显式逃生门**（`Alt`+拖动跳过全部元素分支，落到既有选区拖动路径）+ `#elementBar` 提示，而**不**改动方案既定优先级（改序会让"点选元素"在大元素上失效）。
2. **`text`/`serial` 缩放只能落在 `width` 预设**（2/4/8）：`drawAnnotation` 由 `width` 推字号/半径（`resolveWidth` 会把非预设值打回 4），所以"仅字号/仅半径"换算成最接近的预设。缩放后实际 bbox 可能与虚线框不完全吻合 —— **既有绘制模型的上限**，不是坐标错误（导出走同一套 item 字段）。
3. **元素手柄命中半径 6px < 选区手柄 8px**（元素普遍更小）：某个维度 ≲12px 的元素（单点 pen、极短线）整块落在手柄带上 → **只能缩放不能拖动**；零尺寸元素（w 或 h = 0）按 `getResizeHandle` 自身条件**不给手柄**（仍可拖动/方向键微调）。
4. **元素被甩到选区之外后无法再选/抓手柄**：这是 PR1 既有的分支顺序（`!insideSelection` → 重划选区 在元素分支之前），PR3 按派发要求未移位。若要修，属后续"选区与元素的包含关系"设计问题。
5. **`Esc` 不进快照栈**（只取消选中、不改变标注内容）：压空快照会制造无效 undo 步。Delete / undo / redo / D4 清空 / 每次 commit / 每次拖动·缩放·层级·样式均走快照栈。
6. **`task-4` 的"任务卡不存在"是误报**：S6 的 PR3 报告称全仓找不到 `task-4`。事实是该卡在**团队任务板**上（`team_task_create` 创建），不是仓库文件；派发描述与卡内容一致，无缺口。

### 20.4 结论与 Wave 7 开工条件

S6 的 PR1–PR4 全部落地并通过 §1.1 全量门禁 + e2e，**`capture/**` 自此释放**。Wave 7（S9b 光标合成）与 Wave 7.5（S10b `config/**` 收口，已在并行波次完成，提交 `7991198`）均不再与 S6 争用写点。`main.js` 余量仍为 14 行。真机项（标注二次编辑的真实鼠标操作、光标 100%/125%、音轨四组合）按用户指示**统一挂账**。

---

## 21. M2（Wave 7 / S9b 光标合成 + Wave 8 批次 B 收口）实施结果（2026-10-11）

### 21.1 已落地的改动

| 流 | 文件 | 改动 |
|---|---|---|
| **S9b**<br>光标合成 | `main/domains/capture/index.js`（+43/−2） | 新增 `queryCursorSnapshot()`：门顺序 =「provider 已注入」→「`screenshot.captureCursor === true`」；命中才 `cursorProvider.query({ fresh: true })`（**必须 fresh**，绕过 provider 的 250ms 形状缓存）；`CURSOR_QUERY_BUDGET_MS = 120` 的 `Promise.race` 兜底；任何拒绝/超时 → `null`。`cursorPromise` 与抓屏**并行**启动，`Promise.all([capturePromise, loadPromise, cursorPromise])` 收割，`_captureInit.cursor = {png,dataUrl,width,height,hotspot,physicalPoint} \| null` |
| | `capture/capture.html`（+3） | `../shared/cursor-geometry.js` 引在 `capture.js` 之前（CSP `script-src 'self'` 下实测加载成功） |
| | `capture/capture.js`（+25） | `cursorImage` 预解码（`onInit`，每次 init 重置）；`exportSelectionCanvas` 在**标注之后**贴图，门 = `includeAnnotations && initData.cursor && 已解码 && window.cursorGeometry`；`physicalPoint / scaleFactor` 换回 DIP 后交 `resolveCursorPlacement`，`visible` 才 `drawImage(..., x - source.x, ...)` |
| | 测试 | `test/capture-renderer-runtime.test.js`（真实隐藏窗探针，**注入合成光标**）、`test/capture-domain.test.js`、`test/capture-experience-wiring.test.js` |
| **Wave 8**<br>批次 B 收口 | —— | §1.1 全量门禁 + e2e（见 21.2）；本文件 §19–§21 回填 |

### 21.2 门禁实况（Wave 8 批次 B 收口）

| 门禁 | Wave 6 收口（§20.2） | **批次 B 收口（Wave 8）** |
|---|---|---|
| `npm test` | 855 / 855 | **858 / 858 pass** |
| `npm run check` | 语法 257 文件；`main.js` 1286 / 1300 | 语法 **257 文件**；`main.js` **1286** / 1300（**未变**） |
| `test:coverage:loaded` | 92.62%（11220/12113） | **92.62%（11220/12113）** |
| `test:coverage:critical` | 93.22 / 92.99 / 92.42 | 93.22 / 92.99 / 92.42（不变） |
| `audit:dependencies` | 26 / 0 | **26 / 0** |
| Playwright e2e | 5 / 5 | **5 / 5**（25.4s） |

**批次 B 起点（§18.2 的批次 A 收口）→ 终点对照**：`npm test` 765 → **858**；覆盖率 91.84% → **92.62%**；`main.js` 1278 → **1286**（净 +8，全部来自 Wave 5 的 cursor provider 注入与释放；Wave 6/7 的接线都落在域与渲染层，**未占 `main.js` 行数**）。

### 21.3 偏差与未决（3 项）

1. **⚠️ 首次截图可能抓不到光标（S9b 的偏差 2，未修，登记备查）**。provider 的 helper 是懒启动（`ensureStarted()` 只被 `query()` 调用），冷启动 = spawn + ready（`readyTimeoutMs = 1000`），而域侧预算是 **120ms**。S5 实测冷启动 **61–73ms**、单次查询 1–6ms，**通常落在 120ms 内**；但冷文件缓存/杀软扫描等情况下可能超预算 → 首次 `cursor:null`（第二张起正常）。**修法（若集中测试确认需要）**：在 `main.js` 的 `startApplication()` 里于 `initializeStore()` 之后按开关预热一次 —— `if (getSettings().screenshot.captureCursor === true) cursorProvider?.query({ fresh: true }).catch(() => {})`（约 1–2 行，`main.js` 余量 14 够用）。**本轮不做**：本机 `GetCursorInfo` 恒返回 `flags=0`（无可见光标），无法用真机证据证明预热是否必要，避免加不可验证的推测性代码。
2. **`else cursorImage = null`（S9b 主动加固）**：任务书片段只给了 `if(data.cursor?.dataUrl)` 分支；同一 capture 窗口若收到多次 `capture:init`（探针复用窗口场景），不重置会沿用上一张的光标位图。真实链路每次新窗口，但该加固成本为零且更正确，**已接受**。
3. **本机无法验证 `showing:true` 的真机路径**：`GetCursorInfo` 恒 `flags=0, hCursor=0`（独立 P/Invoke 复核过），所以 ⑥「`CURSOR_SHOWING=0` 不绘制」在本机属**真机验证通过**，而 ①–④ 用**合成载荷**在真实 Electron 渲染层验证（热点对齐、1.25 + 负坐标、选区外、关闭态逐像素一致）。**T6（100%/125% 真机光标）按指示挂账**。

### 21.4 结论：批次 B 代码完成，真机项挂账待集中测试

批次 B 的四条流（S2 录屏音轨 · S5 光标采集 · S6 标注二次编辑 · S10b config 收口）与两波接线（Wave 5 / Wave 7）全部落地，通过 §1.1 全量门禁 + e2e，文档 §19–§21 已回填。**批次 B 的剩余唯一事项是 §11 步骤 4 的真机验收**（音轨四组合、光标 100%/125%、标注编辑的真实鼠标操作），按用户 2026-10-11 指示与批次 A 的挂账项**一并留到"统一测试"阶段**。

**后续路线**：Wave 8.5（S14 / D2 配置页路由拆分，批次 C 硬前置门 D7，3.75–6.5 人日）→ Wave 9（批次 C：S1 i18n 框架+config · S11 capture 窗 · S12 其余渲染窗 · S13 主进程文案，四路并行）→ Wave 10（三语言真机 + v2.5.0）。**P1（Auto Filter / MCP）仍受 F1-① 许可证字符串阻塞**。

---

## 22. M2.5（Wave 8.5 / S14：D2 配置页路由拆分）实施结果（2026-10-11）

> 按 §3.1.2 第 5 条分步推进：**D2-1 测试解耦 → D2-2 路由拆分 → D2-3 巨型路由再分解 → D2-4 边界断言 → D2-5 验收**，每步独立提交、独立跑门禁。`config/**` 全程单写者。

### 22.1 已落地的改动（4 个提交）

| 步骤 | 提交 | 内容 |
|---|---|---|
| **D2-1** 测试解耦 | `f634018` | 新增 `test/helpers/config-source.js`：`readConfigSource()`（主壳 + 全部 `config/routes/*.js`，按名排序拼接）与 `readConfigShell()`（只读主壳，供文件边界断言）。**15 个**读 `config/config.js` 的契约测试改走它 → 搬迁时 ~170 处源码文本断言**零改动**。以一次性 `config/routes/zzz-d2-proof.js` 证明：拼接读取会纳入新路由文件、shell-only 不会 |
| **D2-2/D2-3** 路由拆分 | `f7cb92a` | `config/config.js` **1838 → 109 行**；新增 17 个 `config/routes/*.js`（**最大 246 行**，无一 >300）：`shared`(共享 helper/状态/常量) · `home` · `translation` · `chat` · `history` · `selection-toolbar{,-editor}` · `models-{render,provider,feature,plan,editor}` · `appearance` · `plugins` · `local-search` · `settings` · `about`。主壳 `renderRoute()` 改为按 `window.configRoutes` 的 key 分派，保留拆分前"仅 settings-system/about async + catch"的调用形态。**函数体逐字保留**（经典脚本共享全局作用域，无一处标识符重命名）；`config.html` 顺序 = `shared.js → model-helpers.js → 16 个路由 → config.js`。新增 `test/config-routes.test.js` 锁死"分派 key ↔ 登记 key 对拍 / config.html 挂载完整性 / 主壳零 render 函数 / configShared 精确面" |
| **D2-4** 边界断言 | 同 `f7cb92a` | 仅 4 处**真正的文件边界**断言需改：`config-model-helpers`（"主壳不得重定义 helper"→ 用 `readConfigShell()`；并去掉主壳已不再持有的 `window.modelHelpers` 断言）· `data-root-ui-contract`（原来断言主壳内联 `void renderSystemSettings().catch`，改为断言分派表的 `fallbackMessage` 口径）· `shortcut-ui-contract`（两处切片/边界改到新文件） |
| **D2-5** 验收 | 同 `f7cb92a` | 新增 e2e 用例：逐个打开 **14 个路由**，断言标题 + 可见锚点 + `getUnexpectedErrors()===[]` |

### 22.2 门禁实况（Wave 8.5 收口）

| 门禁 | 批次 B 收口（§21.2） | **Wave 8.5 收口** |
|---|---|---|
| `npm test` | 858 / 858 | **885 / 885 pass** |
| `npm run check` | 语法 257 文件；`main.js` 1286 / 1300 | 语法 **278 文件**；`main.js` **1290** / 1300 |
| Playwright e2e | 5 / 5 | **6 / 6**（连续 3 次复跑均 6/6） |
| `config/config.js` | 1838 行 | **109 行**（验收要求 ≤400） |
| 最大 `config/routes/*.js` | —— | **246 行**（`shared.js`；验收要求无单文件 >300） |

### 22.3 偏差与决定（5 项）

1. **locale 表按 domain 分文件（Lead 决策，已写入 §10.3）**：Wave 9 声称"四路并行"，但若所有键都进同三个语言文件，S1/S11/S12/S13 会写同一文件 → 只能串行。改为三个语言文件承载公共键 + 每个 domain 一个文件（内含三语），checker 改 glob。**这是为并行度付的架构代价，已在 §10.3 记录。**
2. **`window.configShared` 的登记面收窄（S14 实测决定）**：该对象字面量在 `shared.js` 载入时求值，若引用后加载文件里的 `const`（如 `home.js` 的 `functionGroups`）会当场抛 ReferenceError，**连带主壳尾部的 `onNavigate` 接线永不执行 → 设置页整页白屏**。修法：`configShared` 只登记 `shared.js` 自己声明的名字，并由 `test/config-routes.test.js` 锁死清单。
3. **三个"只有真机才暴露"的缺陷（`npm test` 全绿、`check` 语法门禁完全无感）**：① `homeTab`/`modalOverlay` 留在主壳而路由文件引用它们；② 路由文件顶层登记时容器尚不存在（CSP `script-src 'self'` 禁止内联脚本初始化）→ 容器改由 `shared.js` 顶部创建；③ 上述 `configShared` TDZ。**教训与批次 A 的 §6.2 同类：跨文件搬迁必须用真实页面验收，纯 Node 测试与语法门禁都看不见。**
4. **e2e fixture 的"就绪门"（Lead 修复，`b027444`）**：fixture 原先只等 `.window-shell`（静态节点，HTML 一解析完就可见），而导航接线要等最后一个脚本 + `getSettings()` 回来。脚本从 5 个涨到 22 个后，首次导航点击偶发落空（两次全量 e2e 各在不同用例失败，单跑却都过）。改为再等 `#view .function-row`（`renderHome` 的产物）→ **连续 3 次 6/6**，且整体快约 10s（重试消失）。
5. **`scripts/probe-window-security.js` 的 `marker:'renderHome'` 是误报**：S14 报告称该字符串已不在 `config.html`。实测该探针是在页面里求值 `typeof renderHome`（不是搜源码字符串），`home.js` 的顶层 `function` 仍是全局绑定 → `test/window-security-runtime.test.js` 通过，**无需改动**。

### 22.4 结论与 Wave 9 开工条件

D2 的四个步骤全部落地并通过 §1.1 全量门禁 + e2e（连续 3 次稳定）；`config/**` 自此释放，**批次 C 的硬前置门 D7 已兑现**。i18n 框架（S1 第 1 阶段）已在并行波次完成（`2d31a34`：runtime 补全 + 按 domain 的 locale 布局 + checker glob + `i18n:language` 广播与 11 个 preload 订阅）。

**Wave 9 开工条件**：① `config/**` 已释放（D2 完成）✓；② i18n 框架与 locale 布局已就位 ✓；③ 四路写作用域互斥（S1 独占 `config/**` 与 `shared/locales/config.js`；S11 独占 `capture/**`；S12 独占 `record/**`、`long-capture/**`、`action/**`、`search/**`、`recognition/**`、`toolbar/**`；S13 独占托盘/更新/状态/AI 错误文案）—— 各窗口流新建**自己的** `shared/locales/<domain>.js`，互不冲突。

> **事故记录（2026-10-11）**：并行跑 D2-2 与 S1 期间，有外部命令执行了 `git reset --hard HEAD`，一次性清空两个流全部未提交工作（16 个路由文件 + S1 的 locale/checker 改动）。两流均已重做，但这是**真实损失过工作的事故**。纪律已更新到交接文档 §11：派发 prompt 的"禁止 git 写操作"要逐个列出 `reset`/`checkout`/`restore`/`clean`/`stash`/`add`/`commit`；Lead 在并行波次期间用 `git stash create` 周期取恢复点。

---

## 23. M3（Wave 9 / 批次 C i18n 四路并行 + Wave 10 收口）实施结果（2026-10-11）

> 四路并行：**S1 第 2 阶段（`config/**`）· S11（`capture/**`）· S12（六个渲染窗）· S13（主进程文案）**。每路独占自己的 `shared/locales/<domain>.js`，写作用域互斥（§10.3 的分文件决策正是为此）。Lead 负责框架接线、跨流裁决与收口门禁。

### 23.1 已落地的改动

| 流 | 提交 | 内容 |
|---|---|---|
| 框架（S1 阶段 1） | `2d31a34` | `shared/i18n.js` 补全 + 按 domain 的 locale 布局 + checker glob + `i18n:language` 广播 + 11 个 preload 内联订阅 |
| **S1 阶段 2** | `7c02fe4` | `config/**` 全量迁移：**582 个 `config.*` 键 × 三语**；`config.html` 22 处 `data-i18n*` + 6 行 script；路由标题/回退文案键化；`test/helpers/config-source.js` 追加读 `shared/locales/config.js`（那 ~170 处"文案存在性"断言问的是设置页有没有这段文案）；新增 `test/i18n-contract.test.js`。**并修掉一个真机缺陷**：`applyTranslations()` 会把 `#pageTitle` 重置成首页标题 → 热切换后改为 `navigate(currentRoute)` |
| **S11** | `a338bf7` | `capture/**` 迁移：**93 个 `capture.*` 键 × 三语**，120 个串槽（HTML 96 / JS 24，含 6 个插值模板）；GOLDEN 表逐字审计（95 值 0 miss）+ 真机 DOM（30/30 文本标记、66/66 属性标记、0 空值）；`print.html` 零脚本故不动 |
| **S12** | `52e1ae6` | 六窗迁移：**227 键 × 三语**（record 72 / long-capture 51 / action 36 / search 34 / recognition 24 / toolbar 10）；6 个 domain 表；`toolbar-action-meta` 的 label/description 改为键 |
| **S13** | `7c12fad` | 主进程迁移：**48 键 × 三语**（tray 12 / update 17 / everything 11 / ai 7 / dialog 1）+ 新增 `main/services/i18n-bootstrap.js`（主进程 i18n 入口）；`throw`/日志/提示词/契约值按 D6 与 §10.5 不动 |
| Lead 接线与收口 | `7c12fad` · `8509ebd` · `0377ed1` | `main.js` 启动 `setLanguage(getSettings().language)` + 广播内同步主进程；`settings-effects` 新增 `language.tray` effect（托盘 label 构建时求值，必须重建）并在 `resetEffects` 镜像；`window.i18n` 命名空间 + 两条框架陷阱注释；**checker 键名正则放宽到每段都允许连字符**；`config` 解析键化的 toolbar label；工具条宽度按解析后文本估；`check` 追加 `check:i18n --max 607` |

### 23.2 门禁实况（Wave 10 批次 C 收口）

| 门禁 | Wave 8.5 收口（§22.2） | **批次 C 收口** |
|---|---|---|
| `npm test` | 885 / 885 | **904 / 904 pass** |
| `npm run check` | 语法 278 文件 | 语法 **290 文件** + 架构 ok（`main.js` **1297** / 1300）+ **i18n 门禁 `--max 607` 通过** |
| `test:coverage:loaded` | —— | **92.7%（11405/12302）** |
| `test:coverage:critical` | 93.22 / 92.99 / 92.42 | **93.22 / 94.07 / 92.42** |
| `audit:dependencies` | 26 / 0 | **26 / 0** |
| Playwright e2e | 6 / 6 | **6 / 6**（31.7s） |
| `check-i18n` | TOTAL 1237（框架阶段） | **TOTAL 607**，12 个 locale 文件、**三语各 967 键**、对称差/键形/data-i18n 缺失**全 0** |

### 23.3 未迁移残留（606 行）的构成与口径

> **口径**：迁移目标是**用户可见 UI 文案**，不是"CJK 行数归零"（§10.3 澄清 1）。checker 统计的是**含 CJK 的行数**，含注释、纯模块校验 `throw`、提示词与存储契约值。这些**都不翻**。

| area | 残留 | 构成与理由 |
|---|---|---|
| `config` | 82 | 73 行中文注释（18 个路由文件保留 D2 时代注释以缩小 diff）+ 7 行存储/API 契约（翻译语言下拉 `value="中文/日文/…"`、`targetLanguage` 白名单）+ 插件图标字形「译」 |
| `capture` | 223 | 219 行注释 + 4 行数据（`annotation-style.js` 的 3 个**未被任何渲染路径使用**的 `label` + `print.html` 的 `<title>`） |
| `record` | 4 | 1 行注释 + 3 个参数校验 `throw`（纯模块，Node 测试直接 require） |
| `long-capture` | 3 | `matcher.js` 类型校验 `throw` |
| `action` | 8 | `conversation-text.js` 的**剪贴板转录格式 + 回喂模型的上下文标记**（`【划词原文】` 等，属数据格式，同 §10.5-4） |
| `toolbar` | 5 | 默认提示词（§10.5-4）+ `TRANSLATE_*_LANGUAGES` 契约值（§10.5-3） |
| `pin` | 0 | **已迁移（2026-10-11 评审修复）**。原表把这一行记为"注释"是**错的**：它是 `pin/pin.html` 的**可见文案**「穿透中 · 悬停退出」＋ tooltip「鼠标穿透中」。修法：新增 `shared/locales/pin.js`（三语），`pin.html` 载入三语通用表 + 本域表 + `shared/i18n.js`（在 `pin.js` 之前），`pin.js` 在载入时与 `i18n:language` 广播时调用 `applyTranslations()` |
| `main` | 281（另 **169** 行 `throw` 按 D6 出账） | UI 状态已迁；`throw`/updater 日志/release notes/AI 提示词不翻 |
| **TOTAL** | **606** | 相对基线 **1237 降 51%** |

**门禁化**：`npm run check:i18n` = `node scripts/check-i18n.js --max 606`，已并入 `npm run check`。**该上限只能下调，不得上调**；下调前先更新本表。（2026-10-11 评审修复把上限由 607 下调到 606，因为 `pin` 的 1 行可见文案已迁移；§23.2 的 607 读数是 Wave 10 收口当时的历史快照。）

### 23.4 偏差与决定（9 项）

1. **locale 按 domain 分文件**（Lead，§10.3）：为让"四路并行"真的并行；否则四路写同三个文件只能串行。
2. **窗口脚本不得解构 i18n 绑定**（S12 实测踩到，Lead 补 `window.i18n` + 注释）：`t`/`setLanguage`/`applyTranslations` 是顶层 `const`（全局词法作用域），`const { t } = window` 会抛 `Identifier 't' has already been declared` 并**整脚本不执行**（真机探针才看得到，`npm test` 全绿也照样白屏）。
3. **静态 HTML 文本不能传参**：`data-i18n` 只取固定值，带插值的串必须在 JS 里 `t(key, params)` 渲染。
4. **S12 窗口的 HTML 回退文案改为英文（已接受）**：这些窗口 `show:false` 建窗、脚本执行后才 `show()`，默认语言下不会闪烁；保留中文回退会让那些行永远计入未迁移数。
5. **`toolbar-action-meta` 键化后，`config/**` 的消费点必须包 `t()`**（S12 上报的 A1，Lead 落地）：`selectionToolbarActionInfo()` 是唯一访问器，已在其中解析 label/description，否则设置页显示裸键名。
6. **工具条宽度必须按"解析后的文本"估**（S12 上报的诚实缺陷，Lead 修）：`getToolbarWidth` 量的是字符数，键化后每个按钮都命中 126px 上限（4 按钮 359→567，明显偏宽）。修法：`main/domains/selection/index.js` 在测量前用 `t()` 解析 label（保持 `toolbar-utils.js` 纯函数签名不变；用户自定义名不是键，`t()` 原样返回）。
7. **`--max` 默认不开**（实测）：checker 不传 `--max` 时始终 exit 0，所以"有残留 CJK"本身不会让测试变红；Wave 10 才把 `--max 607` 并入门禁。
8. **新增 locale 文件与窗口脚本同名会误伤 `indexOf` 断言**：统一改为匹配脚本标签（`src="capture.js"`）。
9. **同步的既有断言（规则 C6）**：`window-security.test.js` 的 `长截图匹配超时` → 断言键；`selection-toolbar-thinking/settings` 的 `label:'跳转'` / `data.label || '解释'` → 断言键；`audio-mixer` 的警告串改吐 key；`i18n.test.js` 的 localeFiles 改为"包含 + 排序"（端态契约，四路全部落地后转绿）。
10. **2026-10-11 评审修复（批次 C 收口后）**：用 `open-code-review` 对 `f634018..HEAD` 评审得 33 条，逐条核实后 High 全修、Medium 修 5 条，6 个提交：`a5b6e20`（record zh-CN 五条英文）· `599b513`（pin 窗迁移 + 上限降到 606）· `f7fd3b2`（裸键名 + 模板串错误 + 漏 `t()`）· `8a4d3ee`（恢复 `form-action 'none'`）· `8d62dd5`（更新按钮被禁用 + history 4 处 IPC 无 catch）· `8dd5862`（同类第二例 + 按窗口门禁）。最重的一类是**整窗缺 domain 表 → 渲染裸键**：`toolbar.action.*` 与 `search.category.*` 只在各自 domain 文件里，而 config 窗两个都没载；现有 checker 与 data-i18n 测试都**先合并全部表**，所以完全看不见（`check-i18n.js` 的 `localeCoverageProblems()` 又因读累计 bag 而永不触发）。
11. **新增"按窗口"键解析门禁**：`test/i18n-contract.test.js` 加 `every key a window resolves exists in the tables that window loads`。它按窗口合并**该窗口实际载入**的表，并把**键形字面量**也算作使用——`t(category.label)` / `t(action.label)` 这类计算参数用普通 `t('...')` 扫描是抓不到的，而这正是两个真实缺陷的形态。已用「删掉 `config.html` 的 `search.js` 标签」做过反向验证（测试如实变红并指出缺失键）。

### 23.5 结论：批次 C 代码完成，真机项挂账

批次 C 的 i18n 四路 + 框架全部落地，通过 §1.1 全量门禁（含新增 i18n 门禁）+ e2e；**三语 967 键对称、184 个 `data-i18n` 键零缺失**。批次 C 的剩余事项是 **§11 步骤 4 的真机验收**（三语言切换、11 个窗口文案随语言变化、切换不重启生效），按用户指示与批次 A/B 的挂账项**一并留到"统一测试"阶段**（清单见 `2026-10-11-consolidated-verification-checklist.md`，需补三语言一节）。

**发布动作仍未做**：`package.json` 仍是 **2.3.1**，批次 A（v2.3.2）、批次 B（v2.4.0）、批次 C（v2.5.0）三个版本 bump 与 release 记录都未执行（属 Lead，需与用户确认）。

**剩余路线**：`main.js` 余量仅 **3 行**（1297/1300）——任何新接线前必须先腾挪；P1（Auto Filter / MCP）仍受 **F1-① 许可证字符串**阻塞。

---

## 24. 统一测试阶段前的状态核实与门禁复跑（2026-10-12，DSH 会话）

> 本节不是新波次，而是**接手核实的记录**：新会话拿到的指令假设"上一轮只写了文档、未改业务代码、HEAD=b97391e、两份文档 untracked"，实测全部不成立（批次 A/B/C 已落地、HEAD=`b2cf101`、文档已 tracked、`main.js` 1297）。核实与自检结论见本节；**未改动任何业务代码**。

### 24.1 前提核实（与指令的差异）

| 指令描述 | 实测（2026-10-12） |
|---|---|
| 上一轮未改业务代码 | ❌ 批次 A/B/C 全部落地并提交（`pdf-export.js`、`print.html`、`audio-mixer.js`、`annotation-geometry.js`、`cursor-provider.js`、`shared/i18n.js`、`config/routes/*.js` 等均在版本控制内） |
| HEAD = `master @ b97391e` | ❌ `master @ b2cf101`（2026-10-12 09:31） |
| 两份方案文档 untracked | ❌ 均已 tracked；untracked 的是另外两份（`2026-10-08-selection-toolbar-app-blacklist-research.md`、`2026-10-09-selection-toolbar-centered-placement-design.md`） |
| `main.js` 1298/1300（余 2） | ⚠️ **1297/1300（余 3）**，`scripts/check-architecture.js` 实测 ok |
| 3 项在制非文档改动 | ✅ 完全一致（selection-hook `^2.0.2 → ^2.1.1` + 同尺寸重建的 `.exe`） |
| LICENSE / COPYRIGHT / THIRD_PARTY_NOTICES.md 不存在 | ✅ 一致（`package.json` 仍 2.3.1、无 `license`） |
| `_repo_snow_apps/` 只读克隆 | ✅ 存在，`.gitignore:25` 忽略（§1.3 记的"已删除"对该副本不成立） |

**§0.1 总账自检**：按 §4–§10 任务表逐项重算，P0-4=4.0、P0-6=3.0、P0-7=6.5（批次 A **13.5**）；P0-3=7.0、P0-5=5.75、P0-2=6.0（批次 B **18.75**）；P0-1=16.75（批次 C **16.75**）；**七项 49.0**，含工程开销 **55.25–59.5** —— 与 §0.1 一致，无需修订。
**§3.1.1 同波次写作用域自检**：Wave 0/1/2/4/6/7/7.5/8.5 均互斥；仅 **2 处口径错位（不影响人日）**：① `shared/locales/**` 在 §3.1.1 整块归 S1，而 §10.3 的"一 domain 一文件"实际由 S11/S12/S13 各写自己的文件，注册表未同步；② §6.1 的 P0-7-T3 把 `settings-defaults.js` 与 `config/config.js` 列为"关键落点"，但二者属 Lead 冻结文件与 S10a 作用域（实际实现亦由 S10a 落地）。

### 24.2 M-1 二次开案与结案（工作区再次变脏）

`2026-10-11-post-review-handoff.md` 记录的工作区"仅 `.zcodeignore` untracked"已不成立：实测重新出现 §1.2 描述的 3 项改动 + 2 份未跟踪文档，`.zcodeignore` 且已不在磁盘。按用户 2026-10-12 批准（M-1 选项 A 的修订版）处置：

| 动作 | 结果 |
|---|---|
| 丢弃构建产物噪声 | `git checkout -- native/everything-search/bin/HighlighterEverything.exe` |
| `selection-hook` 升级独立提交 | **`ea7ff2f`** `chore(deps): align selection-hook to 2.1.1`（`node_modules` 本就是 2.1.1，属对齐而非半应用） |
| 2 份未跟踪规划文档入库 | **`ba196d4`** `docs(plans): add the selection-toolbar blacklist research and centered placement design` |
| 出口条件 3（划词 hook 真机验证） | 按用户"统一测试"决定**挂账**，已写进 `ea7ff2f` 的提交说明 |

工作区自此**完全干净**（`git status --short` 空）。

### 24.3 门禁复跑（2026-10-12，工作区干净）

| 门禁 | 交接文档 §1 记录 | **本次复跑** | 结论 |
|---|---|---|---|
| `npm test` | 905 / 905 | **905 / 905**（16.5s） | ✅ 复现（须加 24.4 的两条环境绕行） |
| `npm run check` | 291 文件 · `main.js` 1297 · i18n 606 | **291 文件 · 1297/1300 · 606 ≤ 606** | ✅ 一致 |
| `test:coverage:loaded` | 92.7%（11405/12302） | **92.72%（11407/12302）** | ✅（+2 行，来自被绕行救回的两个 Electron 探针） |
| `test:coverage:critical` | 93.22 / 94.07 / 92.42 | **93.46%（21 用例全绿）** | ✅ |
| `audit:dependencies` | 26 豁免 / 0 未豁免 | 配置 registry 下 ❌ **18 个失效豁免项**；显式走官方 registry 则 ✅ **26 豁免 / 0 未豁免（exit 0）** | 红灯**仅由镜像缺少 audit 端点造成**，门禁结论与基线一致，见 24.4-③ |
| `test:e2e` | 6 / 6 | ✅ **6 / 6（34.2s）** | 经用户授权后在**主屏**可见窗运行（无副屏），见 24.4-④ |

### 24.4 环境事实（**均非代码缺陷**，逐条有证据）

1. **Chromium OS 沙箱在本会话无法初始化**：Electron 以 `0x80000003 STATUS_BREAKPOINT` 立即崩溃、stdout/stderr 全空（`electron.exe --version` 亦然）；`--no-sandbox` 或 `$env:ELECTRON_DISABLE_SANDBOX='1'` 后正常（`app ready; displays = 1`）。缺此绕行时 `npm test` 红 **9** 项——全部是真实 Electron 探针。
2. **派生二进制写不了 `%TEMP%`**：`electron.exe` / `ffmpeg.exe` 在 `os.tmpdir()` 下建文件报 `EPERM`（`node` 自己可以写，工作区内也可以）；把 `TEMP`/`TMP` 指到工作区内目录后正常。缺此绕行时 `npm test` 红 **3** 项（两项探针 40s/65s 超时 + `recording-preview-runtime` 的 ffmpeg fixture EACCES）。
3. **`npm audit` 端点在配置 registry 上不可用（门禁本身没坏）**：用户级 `~/.npmrc` 指向 `registry.npmmirror.com`，该镜像对 `POST /-/npm/v1/security/advisories/bulk` 返回 `404 NOT_IMPLEMENTED`，`npm audit --json` 给出 `{"error":{"summary":"","detail":""}}` 且 **0 条漏洞** → 18 条豁免全部被判"失效"。
   **权威复核（显式走官方 registry）**：`$env:npm_config_registry='https://registry.npmjs.org'; node scripts/audit-dependencies.js` → **审计通过：26 个已豁免，0 个未豁免（exit 0）**，与交接文档 §1 的读数一致（`metadata.vulnerabilities` = 1 low / 9 moderate / 5 high，moderate+ 共 26 条全部落在豁免清单内）。**结论：门禁可用，红灯只由镜像端点缺失造成。** 注意 `npm run audit:dependencies --registry=…` **无效**（该参数会进脚本 argv，而不是脚本内部那次 `npm audit`）。
   **附带发现（建议单独立项）**：`scripts/audit-dependencies.js:92-95` 只校验 stdout 是否存在，**不校验 `report.error`**，于是"审计不可用"被误报成"豁免清单腐烂"，门禁信息误导。建议在 `runAudit()` 中检测 `report.error` / `auditReportVersion === undefined` 时直接以"审计不可用"失败。
4. **显示器只有一块**：`\\.\DISPLAY1` 1493×933（主屏），**无副屏**。与交接文档 §2（3840×2160 + 1728×3072）和验收清单 §0（1152×2048 @3072,−136）都不同 → 可见窗/e2e/真机项须按 `AGENTS.md` 先问用户，且**必须在有副屏的环境执行**。

### 24.5 本轮未做（有意留待用户决定的）

- 统一真机测试（需用户 + 副屏）、三个版本 bump、L1–L16 许可落地、P1（仍受 F1-① 阻塞）。
- 验收清单已补 **§3.5 批次 C 三语言**，并修正了过期的副屏读数与环境准备说明。**同日追加**：§3.5 原先按"5 处热切换残留未修"写成预期，该 5 处已在 **§25** 全部修复，清单中的预期已同步改为"应全绿"。

---


## 25. 批次 C 遗留修复：5 处「热切换旧文案残留」实施结果（2026-10-12）

> 来源：`2026-10-11-post-review-handoff.md` §4.5（5 处，已核实、当时未修）。按用户 2026-10-12 指示先修此项，再进统一真机测试。**统一修法**：把"已经翻译好的句子"改成"i18n 键（+ 参数）"存为状态，并在广播处理器里于 `applyTranslations()` **之后**重跑该窗口自己的渲染函数；动态节点保留 `data-i18n` 以便首屏正确（apply 覆盖 → 再渲染回来）。

### 25.1 已落地的改动

| 站点 | 文件 | 改动 |
|---|---|---|
| ① search 状态行 | `search/search.js` | 保留最后一份状态负载（`lastStatus`）；广播处理器在 `applyTranslations()` 后调 `renderStatus()`；负载带 `messageKey` 时优先 `t(messageKey)`，否则保持原逻辑 |
| | `search/search.html` | 新增 `shared/locales/main.js`（`messageKey` 是 `main.everything.*`；该窗此前不载这张表，不加会渲染裸键 —— 即 §6.6 那类缺陷） |
| | `main/services/everything-service.js` | 11 处 `message: t(KEY)` 同时发布 `messageKey: KEY`；`stop()` 置 `messageKey: ''`；`message` 逐字不变，D6 的 `throw`/诊断文本未动 |
| ⑤ long-capture 状态 | `long-capture/long-capture.js` | 新增 `statusState`/`statusConfidence` + `renderStatusText()`；拆出 `setStatusKey(key, params, confidence)`（可译）与 `setStatus(message)`（原始诊断，D6 保持原样）；13 处 `setStatus(t(...))` 全改 `setStatusKey`；广播与首屏各重渲染一次 |
| ② action 表头/加载 | `action/action.js` | `conversation` 改存原始身份（`type`/`labelSource`）；新增顶层 `renderHeader()` 在**渲染期**解析 5 个节点（未开始/翻译/解释/自定义四态，输出与改动前逐字一致）并刷新 `conversation.label`；`onActionStart`、首屏与广播都调它；`action.html` 无需改（`data-i18n` 保留） |
| ③ record 音频提示 | `record/record.js` | 成品句改存 `audioNoticeKey` + `audioNoticeParams`；`renderStatus()` 在渲染期重建整句（`${label} · ${notice}` / `title` 形态不变）；`renderAudioWarning` → `audioWarningKey()` 返回 `{key, params}`；全部调用点传键 |
| ④ recognition 标题/复制 | `recognition/recognition.js` | `renderCurrentView()` 成为 `#title` 的**唯一写者**（error/table/qr/loading 四态）；删掉 `onInit` 里 await 前的两处重复写；复制按钮保留键、在 1 s 计时器**内**才 `t()` 解析 |

**测试**：新增 6 个契约用例（`test/window-security.test.js` ×2、`test/selection-toolbar-settings.test.js` ×1、`test/recording-ui-contract.test.js` ×1、`test/recognition-ui-contract.test.js` ×2）+ `test/everything-service.test.js` 3 个新用例与 6 处追加断言。**仅修改 2 处既有断言**（都是"标签/提示从启动期句子改为渲染期取键"，语义不变；其中一处同时新增反向断言"任何调用点都不得把成品句子塞进 `setAudioNotice()`"）。
**新增真机覆盖（此前这一类完全没有运行时验证）**：`scripts/probe-i18n-hot-switch.js` + `test/i18n-hot-switch-runtime.test.js` —— 真实 Electron 渲染层逐窗做种、发真实 `i18n:language` 广播、比对 DOM（6 用例 zh-CN → en-US）。**修复前该探针如实变红**（`setStatusKey is not defined`），修复后 **2 / 2 通过**。

### 25.2 门禁实况

| 门禁 | §24.3（修复前） | **本轮收口** |
|---|---|---|
| `npm test` | 905 / 905 | **916 / 916 pass**（+11 用例） |
| `npm run check` | 293 文件 · `main.js` 1297 · i18n 606 | **293 文件 · 1297/1300 · 606 ≤ 606**（未变） |
| `test:coverage:loaded` | 92.72%（11407/12302） | **92.78%（11444/12334）** |
| `test:coverage:critical` | 93.22 / 94.07 / 92.42 | 93.22 / 94.07 / 92.42（23 用例全绿） |
| `audit:dependencies` | 26 / 0（官方 registry） | **26 / 0** |
| Playwright e2e | 6 / 6 | **6 / 6（34.1s）** |
| 真机热切换探针 | 红（缺陷在） | **2 / 2 绿** |

### 25.3 偏差与决定（5 项）

1. **搜索窗新增一张 domain 表**（`shared/locales/main.js`）：`t(messageKey)` 必须能解析，做法与 `config.html` 载多张表的先例一致；未新增任何 locale 键。
2. **`messageKey` 是加法**：主进程 `message` 继续是"发布时刻语言的成品句"，其它消费方与既有测试不受影响；D6 的 `throw`/日志文本一字未动。
3. **`recognition.js` 删掉了 `onInit` 里 await 前的两处标题写入**：加载中显示 `recognition.header.title`（规格指定的 loading 文案），最终标题仍由 `renderTable`/`renderQr` 设定。`showError()` 仍只写 badge，故错误态的**首次**绘制与改动前一致，切换后由 `renderCurrentView()` 修正。
4. **`EXPLAIN_LABEL` 变成"仅被测试引用"**：保留声明（有测试逐字固定），但 `renderHeader()` 不再使用它，改在渲染期 `t('action.answer.label.explain')`，否则切语言后兜底标签仍是启动期语言。
5. **探针首个用例的 localStorage 泄漏（Lead 自己的 bug，非产品缺陷）**：所有 `file://` 窗共享同一 localStorage，用例 1 的广播把 `en-US` 持久化，导致后续用例在 en-US 下启动、`zh` 期望不可能满足。已修为每个用例前 `clearStorageData({ storages: ['localstorage'] })`，并新增"boot 语言必须是 zh-CN"断言；**两个子智能体各自独立发现并给出同一证据**。

### 25.4 结论

批次 C 的 5 处遗留**全部修复**；`shared/**`、`main.js`、`settings-defaults.js`、`ipc-security.js` 与 i18n `--max 606` 门槛均未被触碰。验收清单 §3.5 的"已知预期"已同步改为"已修复，真机复核应全绿"。批次 C 至此只剩**统一真机测试（三语言切换）**与**版本 bump**。

---

---


## 26. v2.5.0 构建与打包验收（2026-10-12）

> 用户决定：A/B/C **合并为单次发布 v2.5.0**；本轮做到"本地出安装包 + 打包验收"，**合规随后单独做**。完整记录见 `docs/releases/2026-10-12-v2.5.0-build-acceptance.md`。

| 项 | 结果 |
|---|---|
| 版本 | **`2.5.0`**（`d4d02a5` 单独提交：`package.json` + `package-lock.json`；`node scripts/check-version.js` 通过） |
| 候选代码 | `2c46825`（批次 C 遗留修复） |
| 原生组件 | `npm run build:native` 三件全成功（cargo 命中缓存） |
| 打包 | `electron-builder --config electron-builder.release.cjs --win nsis portable --x64 --publish never --config.forceCodeSigning=false --config.win.signExecutable=false`，约 45 s |
| 产物 | Setup **144,788,573 B** · Portable **144,520,065 B** · blockmap 151,985 B · `latest.yml`（2.5.0）· `sbom.cdx.json`（CycloneDX 1.5 / 378 组件）· `SHA256SUMS.txt` · `win-unpacked/Highlighter.exe` 225,639,936 B |
| `npm run verify:package` | **exit 0**：fuses **8/8**（与 2.2.4 发布记录逐项一致）· `win-unpacked/Highlighter.exe` 与 portable 的启动探针均通过 · 更新清单与校验和已生成 |
| **未做** | 安装/覆盖升级/卸载验收、真机功能验收、**打 tag / 推送 / CI draft Release**、签名（`verify:release`） |
| 合规 | **带着既有缺口外出**：无 `LICENSE`/`COPYRIGHT`/`THIRD_PARTY_NOTICES.md`，`build.files` 白名单不含它们，已分发的 GPL FFmpeg 与 LGPL libvips 零告知（分析文档 §5.6 / M5） |

**为什么不是三次发布**：`2.3.0`/`2.3.1` **从未打 tag**（最新 tag 为 `v2.2.8`），且历史提交缺后续的 D2 拆分、i18n 与两轮修复 → 事后补 tag 得到的发布内容与版本叙事不符。

**环境注记**：本会话的打包与启动探针需要 `ELECTRON_DISABLE_SANDBOX=1` + `TEMP/TMP` 指向工作区内 + `ELECTRON_BUILDER_CACHE` 指向工作区内副本（原因见 §24.4）；CI runner 不需要。

**顺带登记**：`native/everything-search/bin/HighlighterEverything.exe` **构建即变脏**（本次重建 sha256 `AD12472B…` vs 库内 `B77DED4D…`，同尺寸 343,552 B）——已按 M-1 先例丢弃；该被跟踪构建产物的策略仍待单独立项。

---

---

## 27. v2.5.0 安装器修复：替换「应用仍在运行」检查（2026-10-12）

> 用户在本机升级 v2.5.0 时被安装器的「Highlighter 无法关闭（重试/取消）」死循环挡住（见 §26 与 docs/releases/2026-10-12-v2.5.0-build-acceptance.md 的 §8）。本节记录根因、修复与验证状态。

**根因（已用它自己的判据复现）**：electron-builder 的默认检查用**路径前缀**判定应用是否在运行（Path.StartsWith(INSTDIR)），杀不掉就弹「请手动关闭」。实测同一判据：INSTDIR 为空 → 恒判「在运行」；INSTDIR 为 D: → 恒判「在运行」；只有精确到 D:\Program Files\Highlighter 才返回「未找到」。也就是说**空/过宽的安装目录会让对话框永远无法通过**；它还会命中**同目录下的卸载器**与任何残留子进程（OCR 边车、selection-hook host），并且从不告诉你它在等谁（无路径、无 PID）。

**修复**：新增 build/installer.nsh（经 build.nsis.include 接入），定义 customCheckAppRunning 取代默认实现：① 空 INSTDIR 直接放行；② 按**精确路径** INSTDIR\Highlighter.exe（忽略大小写）匹配，绝不用前缀——安装器自身、卸载器与无关进程都不可能命中；③ 辅助逻辑写入 PLUGINSDIR\ccar.ps1 并用 -File 调用（消除 NSIS↔PowerShell 的引号风险），且 nsExec 带**硬超时**——宏不可能把安装器拖死；④ 先礼貌关闭再强杀，最后复核；⑤ 真杀不掉时**打印确切路径与 PID**；静默安装**永不弹框**。

**验证状态（诚实口径）**：
- ✅ **接线已证**：故意在 build/installer.nsh 写一行非法指令 → 构建失败，makensis 报错点名该文件第 2 行 → 该文件确实被编进安装器。
- ✅ **辅助逻辑已证**（独立进程实测）：以目标进程的真实路径查询 → 输出 closed 且进程被杀；用同目录不同名的进程 → 不匹配。
- ✅ **产物已重建并通过仓库自己的打包验收**：npm run verify:package exit 0（fuses 8/8、win-unpacked 与 portable 启动探针通过），dist/SHA256SUMS.txt 已按新产物重算。
- ⚠️ **未完成**：本会话**没能跑通一次完整的可见安装/升级**。静默安装在本环境会卡在安装段之前（PLUGINSDIR 从未创建 → **本宏从未执行**，与本次修复无关），因此静默路径不作为验证手段；可见向导需要用户点击，本轮用户尚未复测。**用户本机的 2.3.1 安装未被改动**（注册表与 exe 均为 10-08 原状）。

**给用户的结论**：修复已落地到新的 dist/Highlighter-Setup-2.5.0.exe（sha256 987CB8CF…，144,868,109 B）。升级前建议**从托盘图标退出**应用（关窗口不等于退出：默认 system.autoStart / enableTray 为 true，且 window-all-closed 是空实现）。若仍有异常，安装器现在会给出被占用程序的**确切路径与 PID**，而不是一个无法通过的循环。
