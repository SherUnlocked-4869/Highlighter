# Highlighter 交接文档：批次 A+B+C 代码完成 → 统一测试与发布（2026-10-11）

> **本文件是新会话的入口。** 旧入口 `2026-10-10-p0-batch-a-handoff.md` 记录的是"批次 A 刚收口、批次 B 未开工"的历史状态，其 §0/§7 已更新为指向本文件；**状态口径以本文件为准**。
>
> 读完本文件就能接手：§0 一句话状态 → §1 门禁读数 → §3 剩余工作 → §6 坑 → §9 第一批动作。

---

## 0. 一句话状态

**三个批次（A/B/C）的代码全部落地，通过全量门禁。唯一剩下的验收是"统一真机测试"（用户明确要求挂账到开发完成后集中做）；发布动作（三个版本 bump）一次都没执行。**

| 项 | 值 |
| --- | --- |
| 分支 / HEAD | `master` / **`8dd5862`**（299 个提交） |
| 工作区 | **干净**（仅 `.zcodeignore` untracked，是有意保留的忽略文件） |
| `package.json` 版本 | **仍是 `2.3.1`**（批次 A/B/C 的 bump 都未做，见 §5.2） |
| 代码完成度 | 批次 A ✅ · 批次 B ✅ · 批次 C ✅（Wave 8.5 / 9 / 10 全部完成） |
| 唯一剩余验收 | **统一真机测试**（清单见 `2026-10-11-consolidated-verification-checklist.md`，**需补批次 C 三语言一节**） |

---

## 1. 门禁读数（2026-10-11 评审修复后在 HEAD `8dd5862` 实测）

| 门禁 | 命令 | 读数 |
| --- | --- | --- |
| 单元/契约测试 | `npm test` | **905 / 905 pass**（123 个 `test/*.test.js` + `tests/long-capture.test.js`） |
| 语法 + 架构 + i18n | `npm run check` | 语法 **291 文件** · `main.js` **1297 / 1300**（**余量 3**）· i18n 未迁移 **606 ≤ 606** |
| 覆盖率 | `npm run test:coverage:loaded` | **92.7%（11405/12302）** |
| 关键模块覆盖率 | `npm run test:coverage:critical` | **93.22 / 94.07 / 92.42**（门槛 90） |
| 依赖审计 | `npm run audit:dependencies` | **26 已豁免 / 0 未豁免** |
| 端到端 | `npm run test:e2e` | **6 / 6**（约 32s，Playwright + 真实 Electron） |
| i18n 明细 | `node scripts/check-i18n.js` | 13 个 locale 文件 · **三语各 971 键** · 对称差/键名形状/data-i18n 缺失**全 0** · 残留 606 行 |

**所有门禁命令前必须先清环境变量**（否则 Electron 会被当成 Node 跑，测试成片失败）：

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
```

---

## 2. 运行环境

| 项 | 值 |
| --- | --- |
| 平台 | Windows 10/11 + PowerShell（`pwsh`） |
| Node / npm | v24.16.0 / 12.1.0 |
| Electron | 43.2.0 |
| 显示器 | 主屏 2560×1440；**副屏 DISPLAY2 1152×2048 @3072,-136，125% 缩放** |
| 启动 dev 实例 | `.\node_modules\.bin\electron.cmd .` —— **绝不要用 `npm start`**（它的 `prestart` 会重建一个受版本控制的二进制） |
| 停止 | `npm run stop:app`（会一锅端所有实例，含 E2E 用的独立 userData 实例） |

> **仓库规矩（AGENTS.md）**：任何**可见**的自动化/真机测试窗口一律放**副屏**；没有副屏就先问用户。隐藏窗（`show:false`）不受此限。

---

## 3. 三个批次做了什么（提交表）

### 3.1 批次 C（本会话主体，全部已完成）

| 阶段 | 提交 | 内容 |
| --- | --- | --- |
| **Wave 8.5 / D2-1** | `f634018` | 新增 `test/helpers/config-source.js`：`readConfigSource()`（主壳 + 全部 `config/routes/*.js` 拼接）与 `readConfigShell()`（只读主壳，供文件边界断言）。**15 个**契约测试改走它 → 搬迁时 ~170 处源码文本断言**零改动** |
| **D2-2 / D2-3 / D2-4 / D2-5** | `f7cb92a` | `config/config.js` **1838 → 109 行**；新增 17 个 `config/routes/*.js`（**最大 246 行**）；主壳 `renderRoute()` 按 `window.configRoutes` 的 key 分派；仅 4 处真正的文件边界断言需重锚；新增 `test/config-routes.test.js` + e2e 全 14 路由用例 |
| e2e 就绪门 | `b027444` | fixture 原先只等静态 `.window-shell`，脚本从 5 涨到 22 个后首次导航点击偶发落空 → 改为再等 `#view .function-row` |
| i18n 框架 | `2d31a34` | `shared/i18n.js` 补全 + **locale 按 domain 分文件**（12 个文件）+ checker 改 glob + `i18n:language` 广播 + **11 个 preload 内联订阅** |
| 布局决策 | `05eb03d` | 把"locale 按 domain 分文件"写进方案 §10.3（为让四路并行真的并行） |
| Wave 9 裁决 | `f8546c0` | 跨流口径：迁移目标是**用户可见 UI 文案**，不是 CJK 归零 |
| **S1 `config/**`** | `7c02fe4` | **582 键 × 三语**；config 残留 392 → 82；并修掉一个真机缺陷（`applyTranslations()` 会把 `#pageTitle` 重置成首页标题） |
| **S11 `capture/**`** | `a338bf7` | **93 键** / 120 串槽；GOLDEN 表 95 值 0 miss + 真机 DOM 30/30 文本、66/66 属性标记 |
| **S12 六窗** | `52e1ae6` | **227 键**（record 72 / long-capture 51 / action 36 / search 34 / recognition 24 / toolbar 10）；六区残留 238 → 20 |
| **S13 主进程** | `7c12fad` | **48 键** + `main/services/i18n-bootstrap.js`；`main.js` 启动 `setLanguage` + 广播内同步；`settings-effects` 新增 `language.tray` effect（托盘 label 构建时求值，必须重建） |
| 框架陷阱与裁决 | `8509ebd` | 新增 `window.i18n` 命名空间 + 两条陷阱注释；方案补 4 条裁决 |
| Wave 10 收口 | `0377ed1` | config 解析键化的 toolbar label；工具条宽度按**解析后文本**估；`check` 追加 `check:i18n --max 607`；同步 `window-security` 断言 |
| 文档回填 | `1338d12` · `780b76c` | 方案 **§22（Wave 8.5）** 与 **§23（Wave 9/10）** 全量回填 |

### 3.2 批次 A / B（早于本会话，供追溯）

批次 A（Wave 0–3，P0-4 打印/PDF、P0-6 贴图穿透、P0-7 体验）→ 批次 B（Wave 4–8）：

```
eb90eb7 S2 录屏音轨 · 0ceaa3b S5 光标原生采集 · 882b1f0/2ae1042 Wave 5 接线
ba35790/6f1cca4/c8e245c/3f1dcd0 Wave 6 标注二次编辑 PR1–PR4 · 7991198 S10b config 收口
453b027 Wave 7 S9b 光标合成 · d43899e Wave 7 文档 · 15358f8/1237bc4 OCR 评审修复
```

细节见方案 **§16–§21**（批次 A/B 的逐波结果）与 `2026-10-10-p0-batch-a-verification.md`。

### 3.3 评审修复（2026-10-11，批次 C 收口后）

用 `open-code-review`（deepseek 路由）对 `f634018..HEAD` 做了一轮评审：80 个文件、33 条评论、约 18m41s。逐条在代码里核实后，High 全部修掉、Medium 修了 5 条，共 6 个提交：

| 提交 | 内容 |
| --- | --- |
| `a5b6e20` | `shared/locales/record.js` 的 **zh-CN 块有 5 条仍是英文**（zh-TW 已翻）；其中 4 条是活调用点（`record/record.js:387,388,540`、`record/recording-utils.js:183`）→ 默认语言下显示英文报错 |
| `599b513` | **pin 窗从未迁移**：`pin/pin.html` 的可见文案「穿透中 · 悬停退出」＋ tooltip 是硬编码，窗口不载任何语言表，`preload-pin.js` 的订阅无人消费。新增 `shared/locales/pin.js` + pin.html 载表 + pin.js 载入/广播时 `applyTranslations()`；`--max` 607 → **606** |
| `f7fd3b2` | **裸键名**：`toolbar.action.*` 只定义在 `shared/locales/toolbar.js`，而 config 窗与 action 窗都没载它 → 设置页「功能与顺序」与 explain 窗标题显示 `toolbar.action.copy.label` 这类裸键。同提交修 `models-render.js` 的模板串错误（`' + t(...) + '` 写在反引号内，首启「无供应商」空状态渲染出字面量）与 `models-plan.js` 漏 `t()`（编队套餐对话框显示 `config.models.feature-chat`） |
| `8a4d3ee` | 恢复 `long-capture.html` / `overlay.html` 被批次 C 改没的 `form-action 'none'`（`form-action` 不吃 `default-src` 回退，另 10 个窗口都还留着） |
| `8d62dd5` | `about.js` 主按钮用 `busy`（含 `available`/`downloaded`）禁用，而 `update-service.js` 的 `autoDownload=false` → **应用内更新永远点不动**；`history.js` 4 处 IPC 无 catch（初始加载 reject 会永远停在「加载中」，因为 `renderRoute()` 不管这条路由） |
| `8dd5862` | **同类的第二例**：config 窗还缺 `shared/locales/search.js` → 本地搜索分类名输入框显示 `search.category.all`（且未编辑直接保存会把裸键写进用户配置）。并给 `test/i18n-contract.test.js` 加了**按窗口**的键解析门禁——现有 checker 与 data-i18n 测试都**先合并全部表**，所以「整窗缺一张表」能全绿通过 |

**未修的评审项**（都已在代码里核实，见 §4.4）：语言热切换后旧文案残留（`search.js` 状态行、`action.js` 头部/loading、`record.js` 音频提示、`recognition.js` 标题与复制计时器、`long-capture.js` `#status`）；`scripts/check-i18n.js` 的 `localeCoverageProblems()` 因读**累计** bag 而永不触发；死键 `action.pin.window`、死变量 `codingPlanPresetId`/`modelTaskForFeature`、`toolbar.js` 的孤立 `;`、若干嵌套三元与陈旧注释。

---

## 4. 剩余工作

### 4.1 统一真机测试（**唯一剩余验收**，用户要求挂账）

用户 2026-10-11 明确："测试都先跳过，先进行后续开发。开发完成后统一进行测试处理。"

清单：**`docs/plans/2026-10-11-consolidated-verification-checklist.md`**（已含 §0 环境准备 / §1 优先级 / §2 批次 A 8 项 / §3 批次 B 音轨·光标·标注编辑 / §4 失败处置 / §5 收口动作）。

**该清单还缺一节：批次 C 三语言**（需补：zh-CN/en-US/zh-TW 三语言切换、11 个窗口文案随语言变化、切换不重启生效、`language.tray` 托盘重建、设置页"界面语言"行）。**这是新会话最容易漏的一项。**

高风险项（按清单 §1）：**B4 游戏模式托盘兜底**（若失效用户会遇到"穿透后无法退出"）→ 批次 A 的 B3/C2/C3/C4 后半/C5/C7 → 批次 B 音轨四组合/光标 100%+125%/标注编辑 → 批次 C 三语言。

### 4.2 发布动作（**一次都没做**）

`package.json` 仍是 **2.3.1**。三个版本的 bump 与 release 记录都未执行：批次 A → **v2.3.2**、批次 B → **v2.4.0**、批次 C → **v2.5.0**。属 Lead 职责，**需与用户确认**（涉及 `package.json` 与版本号断言，见 §6.6）。

### 4.3 P1（Auto Filter / MCP）：**被阻塞**

受 **F1-① 许可证字符串**阻塞（`GPL-3.0-only` vs `GPL-3.0-or-later`）——任何 `snow_shot/` 移植都取决于此；另有 F1-②/③ 与 L2 署名待用户拍板。

### 4.4 技术债与观察项（已登记，未处理）

| 项 | 说明 |
| --- | --- |
| **`main.js` 余量仅 3 行** | 1297/1300（`scripts/check-architecture.js` 硬上限）。**任何新接线前必须先腾挪** |
| 首次截图光标可能抓不到 | provider 懒启动（冷启动 61–73ms）vs 域侧 120ms 预算；本机 `GetCursorInfo` 恒 `flags=0`，**无真机证据**，故未加推测性预热（方案 §21.3-1） |
| `long-capture/long-capture.js` 仍用旧 `getUserMedia` | 视频专用，不在 P0-3 范围内 |
| 划词工具条 125% 下周期性重建 / `.toolbar` 无 `flex-wrap` | 非本批次引入 |
| `annotation-style.js` 的 3 个 `label` | 未被任何渲染路径使用的死数据，其测试 pin 了这三个值 |
| `capture.js:315` 局部 `const t = tiny.getContext('2d')` | 遮蔽全局 `t()`；该 blur 分支目前无 i18n 调用，**后续谁在该块内加 `t()` 必须先改名** |
| `main.js:1197,1267` 启动错误框 `'Highlighter 启动失败'` | 属 T6 范围但未做（需 `dialog.showErrorBox` 两行接线），需决定是否回收 |
| `main.js:820` 托盘 tooltip `'Highlighter（游戏模式）'` | `main.js` 禁改期未做 |
| **语言热切换后旧文案残留**（5 处，评审已核实） | `search/search.js` 状态行（`renderStatus` 未被重建，切换后仍显示旧语言的「正在检测」）、`action/action.js` 头部/loading（`applyTranslations()` 会把脚本自己写的头部打回静态键）、`record/record.js` 音频提示、`recognition/recognition.js` 标题与复制计时器、`long-capture/long-capture.js` `#status`（`data-i18n` 与 JS 双写冲突） |
| **`scripts/check-i18n.js` 的 `localeCoverageProblems()` 永不触发** | 它读 `globalThis.__LOCALES` 这个**累计** bag（只在循环前重置一次），从 `action.js` 起每个文件都"注册了三语"。修的时候必须同时豁免 `zh-CN.js`/`en-US.js`/`zh-TW.js` 三个单语文件，否则会误报。真正的兜底是 §23.3 的对称差 + 新增的按窗口门禁 |
| 死键 / 死变量 / 陈旧注释（评审 Low） | `action.pin.window`（三语都在、无调用点）、`record.error.system-audio-capture-failed`（无调用点，且与 `record.audio.notice.system-failed` 重复）、`config/routes/models-render.js` 的 `codingPlanPresetId`、`config/routes/models-editor.js` 解构出的 `modelTaskForFeature`、`main/domains/selection/index.js` 未用的 `getVisibleToolbarActions` 导入、`shared/locales/toolbar.js` 的孤立 `;`、`shared/locales/long-capture.js:9` 里写旧的键形正则、`config/routes/about.js` 与 `local-search.js` 的嵌套三元 |

---

## 5. i18n 口径与门禁（**新会话必读，别踩反**）

### 5.1 口径：迁移目标是"用户可见 UI 文案"，不是"CJK 行数归零"

`scripts/check-i18n.js` 统计的是**含 CJK 的行数**，其中包含中文注释、纯模块校验 `throw`、喂给模型的转录格式、提示词、存储/API 契约值。**这些都不翻**（依据 D6 与方案 §10.5）。所以残留**永远不为 0**。

**残留 606 行的构成**（方案 §23.3 有逐 area 表）：

| area | 残留 | 主要构成 |
| --- | --- | --- |
| `config` | 82 | 中文注释 73 + 存储契约 7（翻译语言下拉 `value`、`targetLanguage` 白名单）+ 图标字形「译」 |
| `capture` | 223 | 注释 219 + 4 行未使用数据 / `print.html` 的 `<title>` |
| `main` | 281（另 **169** 行 `throw` 按 D6 单独出账） | UI 已迁；`throw`/日志/release notes/提示词不翻 |
| `action` | 8 | `conversation-text.js` 的剪贴板转录格式 + 回喂模型标记 |
| `toolbar` | 5 | 默认提示词 + `TRANSLATE_*_LANGUAGES` 契约值 |
| `record` | 4 | 注释 + 纯模块校验 `throw` |
| `long-capture` | 3 | `matcher.js` 类型校验 `throw` |
| `pin` | 0 | **已迁移（§3.3 `599b513`）**。原表记成"注释"是错的：它是 `pin/pin.html` 的可见文案。 |
| `search` / `recognition` | 0 / 0 | —— |

### 5.2 门禁只能下调

```jsonc
// package.json
"check": "node scripts/check-js.js && npm run check:architecture && npm run check:i18n",
"check:i18n": "node scripts/check-i18n.js --max 606"
```

**`--max 606` 是硬门禁，只能往下调，不得上调。** 下调前先更新方案 §23.3 的残留表。注意 `--max` **默认不开**：不传时 checker 永远 exit 0，所以"有残留"本身不会让测试变红。

### 5.3 键名与文件约定

- 键名 `<domain>.<module>.<semantic>`，**每段都允许连字符**（`long-capture.*` 合法；checker 的正则原实现只允许第一段无连字符，已在 `0377ed1` 放宽）。
- **一个 domain 一个文件** `shared/locales/<domain>.js`，**每个文件内同时注册三语**。新增 domain 时**新建自己的文件**，不要写进 `zh-CN.js`/`en-US.js`/`zh-TW.js`（那三个只放跨窗口公共键）。
- 三语键集合对称差**必须为空**（零容忍）。
- 每个窗口 HTML 在自身脚本**之前**加：三个语言文件 + `shared/i18n.js` + **它要解析的每一张 domain 表**。
- **跨域键必须载表**（§3.3 两个真实缺陷）：窗口只看得见自己 `<script>` 载入的表。config 窗解析 `toolbar.action.*` 与 `search.category.*`，就必须既载 `shared/locales/toolbar.js` 也载 `shared/locales/search.js`；否则 `t()` 返回键名本身、页面直接显示裸键。`test/i18n-contract.test.js` 的「every key a window resolves exists in the tables that window loads」现在按窗口校验这条（含 `t(category.label)` 这类**计算参数**，靠键形字面量兜住）。

---

## 6. 已知风险与坑（**本会话实际踩过的，逐条都有代价**）

### 6.1 `git reset --hard` 事故（真实损失过工作）

并行跑两个子智能体时，reflog 出现 `05eb03d HEAD@{0}: reset: moving to HEAD`，**一次性清空两个流全部未提交的工作**（16 个路由文件 + locale/checker 改动）。两流都已重做，但这是真实事故。

**纪律**：① 派发子智能体时把"禁止任何 git 写操作"**逐个列出** `reset`/`checkout`/`restore`/`clean`/`stash`/`add`/`commit`；② Lead 在并行波次期间用 **`git stash create`**（非破坏性、不动工作区）周期性取恢复点；③ 收口前不要在共享 worktree 里跑任何回滚命令。

### 6.2 跨文件搬迁必须用**真实页面**验收

D2 拆分后出现过 **3 个白屏级缺陷**，而 `npm test` 全绿、`npm run check` 的语法门禁完全无感：
1. `homeTab`/`modalOverlay` 留在主壳而路由文件引用它们；
2. 路由文件顶层登记时 `window.configRoutes` 容器还不存在（**CSP `script-src 'self'` 禁止内联脚本**初始化）；
3. `window.configShared` 对象字面量引用了后加载文件里的 `const` → 当场 TDZ，**连带主壳尾部接线永不执行**。

**教训**：跨文件搬迁/新窗口接线，必须用隐藏 Electron 窗探针或 e2e 打开真实页面看 `console`/`pageerror`。

### 6.3 经典脚本共享全局作用域 —— 能省事，也能埋雷

- 顶层 `function` 成为 `globalThis` 属性；顶层 `let/const` 进**全局词法环境**，对其他脚本在**调用时**可见（TDZ 只在声明脚本执行前生效）。**这正是 D2 能逐字搬迁函数体、i18n 能直接用全局 `t()` 的原因。**
- **雷**：`shared/i18n.js` 的 `t`/`setLanguage`/`applyTranslations` 是顶层 `const`，窗口脚本写 `const { t } = window` 会抛 `Identifier 't' has already been declared` 并**整脚本不执行**（只有真机探针看得见）。**正确用法**：直接 `t(...)`，或用 `window.i18n` 命名空间。

### 6.4 `sandbox: true` 的 preload **不能 require 本地文件**

`main/services/window-security.js` 锁死 `sandbox: true`。我一度把语言订阅抽成 `preload-i18n.js` 共享 helper，**11 个 preload 全废**（5 个 Electron 测试红）。修法是**内联**（只能用 `ipcRenderer`）。同类改动前先确认 preload 的沙箱约束。

### 6.5 测试断言的三种"搬家后必红"模式（规则 C6，必须同提交同步）

| 模式 | 症状 | 正确改法 |
| --- | --- | --- |
| 硬编码清单 | `deepEqual` 精确数组（effect id、preload API key、locale 文件清单） | 加进清单，或用"包含 + 排序"的端态契约 |
| `indexOf('x.js')` | 新增 `shared/locales/x.js` 后命中语言包而非控制器脚本 | 改为匹配脚本标签 `indexOf('src="x.js"')` |
| 源码中文字面量 | 文案迁进 locale 表后 `assert.match(script, /中文/)` 红 | 断言键（值在 locale 表里） |

**绝不允许**为了让测试变绿而削弱生产代码。

### 6.6 CRLF / 换行陷阱

仓库 `core.autocrlf=true` 且**无 `.gitattributes`**：`write` 工具写出的文件在工作区是 LF，`edit` 过的仍是 CRLF，git 提交时会归一（出现 `LF will be replaced by CRLF` 警告属正常）。

**编辑断言时**：用 `[^\r\n]*` 或 `[\s\S]`，**不要**用 `[^\n]*\n`。`edit` 工具的 `old_string` 若跨行，CRLF 文件会匹配失败 → 改用**单行替换**或写脚本按行处理。

### 6.7 其它

- **子智能体（`subagent`）不是 teammate**：`list_agents`/`wait_agent` 看不到，Lead **无法** `send_message`。所有约束必须写进初始 prompt；它们的产出只能靠**完成通知 + 文件系统**观察。
- **并行波次必须写作用域互斥**：本会话四路并行的可行前提是"一路一个 `shared/locales/<domain>.js`"。派发时把**独占写作用域**与**严禁触碰清单**都列全。
- **`npm test` 与 e2e 都必须先清 `ELECTRON_RUN_AS_NODE`**（见 §1）。
- 本机 `read`/`grep` 偶有显示差异，**以磁盘为准**；验证一律用 `node`（PowerShell 的 `-split "\`n"` 曾算出 +9 假差）。

---

## 7. 文档地图

| 文档 | 用途 |
| --- | --- |
| **本文件** | **新会话入口**：当前状态、剩余工作、坑 |
| `2026-10-10-p0-gap-closure-plan.md` | **主方案（1200+ 行）**。§1 共同约束 · §2 IPC/安全 · §3.1.1 流注册表（owner 的 source of truth）· §3.1.2 回滚纪律 · §3.3 子智能体规约 · §10 i18n 全节 · §16–§21 批次 A/B 逐波结果 · **§22 Wave 8.5** · **§23 Wave 9/10** |
| `2026-10-11-consolidated-verification-checklist.md` | **统一真机测试清单**（缺批次 C 三语言一节） |
| `2026-10-10-p0-batch-a-verification.md` | 批次 A 验收记录；**§2 有门禁读数勘误**（旧 91.87% 已证伪为 91.85%） |
| `2026-10-10-p0-batch-a-handoff.md` | 历史交接（批次 A 时代）；§0/§7 已指向本文件 |
| `2026-10-10-snow-apps-feature-gap-analysis.md` | P1 分析（F1/L1–L3/L9/L10 前置门） |

**引用任何门禁读数前先看 §1 与验收记录的勘误** —— 旧文档里的覆盖率/测试数已被多次刷新。

---

## 8. 待用户决策（**不要在没确认前自行拍板**）

1. **F1-① 许可证字符串**：`GPL-3.0-only` 还是 `-or-later`？——**阻塞整个 P1**（任何 `snow_shot/` 移植）。
2. **F1-②/③ 与 L2 署名**：合规文件相关。
3. **三个版本 bump**（v2.3.2 / v2.4.0 / v2.5.0）何时做、是否合并成一次发布。
4. **统一真机测试的时间**（需要用户配合操作；`B4 游戏模式`优先级最高）。
5. 是否要**把各域中文注释英文化**（可把残留 606 进一步压低，但纯属体力活、无功能收益 —— 当前口径已接受注释保留中文）。

---

## 9. 新会话建议的第一批动作

```powershell
# 1) 确认状态（应为：HEAD=8dd5862、工作区仅 .zcodeignore）
git log --oneline -5
git status --short

# 2) 复跑门禁（务必先清环境变量）
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
npm test                # 期望 905/905
npm run check           # 期望 291 文件 + main.js 1297/1300 + i18n 606
npm run test:e2e        # 期望 6/6
```

3. 读本文件 §4 的剩余工作 + 方案 §22/§23。
4. **先补** `2026-10-11-consolidated-verification-checklist.md` 的**批次 C 三语言**一节。
5. 与用户约统一真机测试时间（**B4 最高优先**）。
6. 只有拿到用户确认后才做版本 bump；**不要**在没有新证据的情况下动 i18n 的 `--max`。

> **启动 dev 实例**：`.\node_modules\.bin\electron.cmd .`（**不要 `npm start`**）。可见测试窗口一律副屏。
