# Highlighter 交接文档：批次 C 评审修复完成 → 统一真机测试与发布（2026-10-11）

> **本文件是新会话的入口。** 前一入口 `2026-10-11-batch-c-handoff.md` 记录的是**评审前**的状态（HEAD `780b76c`、残留 607、pin 残留言误记为"注释"）——它的 §1 门禁读数与 §5.1 残留表**已被本文件取代**；`2026-10-10-p0-batch-a-handoff.md` 是更早的历史。**状态口径以本文件为准。**
>
> 读完本文件就能接手：§0 一句话状态 → §1 门禁读数 → §4 剩余工作 → §6 坑 → §9 第一批动作。

---

## 0. 一句话状态

**批次 A/B/C 三个批次的代码全部落地，批次 C 又过了一轮 AI 评审并把 High 全修完（7 个提交），全量门禁通过。唯一剩下的验收仍是"统一真机测试"（用户明确要求挂账到开发完成后集中做）；发布动作（三个版本 bump）一次都没执行。**

| 项 | 值 |
| --- | --- |
| 分支 / HEAD | `master` / **`f4cfda9`**（300 个提交） |
| 工作区 | **干净**（仅 `.zcodeignore` untracked，是有意保留的忽略文件） |
| `package.json` 版本 | **`2.5.0`**（2026-10-12 单次发布 bump，`d4d02a5`；构建与打包验收已通过，见 §4.2） |
| 代码完成度 | 批次 A ✅ · 批次 B ✅ · 批次 C ✅ · **批次 C 评审修复 ✅（§3.3）** |
| 唯一剩余验收 | **统一真机测试**（清单见 `2026-10-11-consolidated-verification-checklist.md`，**仍需补"批次 C 三语言"一节**） |
| ⚠️ 已知未修缺陷 | **5 处"语言热切换后旧文案残留"**（§4.5）——真机测三语言时**会红**，先决定是修还是接受 |
| 下一会话的上下文锚点 | 本文件 + 方案 §22/§23（批次 C 结果）+ §23.4 第 10–11 条（评审修复与按窗口门禁） |

---

## 1. 门禁读数（**全部在 HEAD `f4cfda9` 实测**，2026-10-11）

| 门禁 | 命令 | 读数 |
| --- | --- | --- |
| 单元/契约测试 | `npm test` | **905 / 905 pass**（122 个 `test/*.test.js` + `tests/long-capture.test.js`） |
| 语法 + 架构 + i18n | `npm run check` | 语法 **291 文件** · `main.js` **1297 / 1300**（**余量 3**）· i18n 未迁移 **606 ≤ 606** |
| 覆盖率（载入路径） | `npm run test:coverage:loaded` | **92.7%（11405/12302）**（分支 79.8% · 函数 90.87%） |
| 关键模块覆盖率 | `npm run test:coverage:critical` | **93.22 / 94.07 / 92.42**（`diagnostics-service` / `update-service` / `window-security`，门槛 90） |
| 依赖审计 | `npm run audit:dependencies` | **26 已豁免 / 0 未豁免** |
| 端到端 | `npm run test:e2e` | **6 / 6**（31.6s，Playwright + 真实 Electron） |
| i18n 明细 | `node scripts/check-i18n.js` | 13 个 locale 文件 · **三语各 971 键** · 对称差/键名形状/data-i18n 缺失**全 0** · 残留 606 行 |

**所有门禁命令前必须先清环境变量**（否则 Electron 会被当成 Node 跑，测试成片失败）：

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
```

> ✅ **`npm test` 的 CI 失败已修**：`test/capture-renderer-runtime.test.js` 的 `report.ctrlA.toolbarVisible` 曾在 GitHub Windows runner 上 2/2 稳定失败（本地只是间歇），把固定 `sleep(150)` 换成轮询 + 补诊断后（`9db90bb`）CI 2/2 全绿。教训与细节见 §6.8。

---

## 2. 运行环境

| 项 | 值 |
| --- | --- |
| 平台 | Windows 10/11 + PowerShell（`pwsh`） |
| Node / npm | v24.16.0 / 12.1.0 |
| Electron | 43.2.0 |
| 显示器（**2026-10-11 实测，已修正**） | 主屏 `DISPLAY1` **3840×2160** @0,0；副屏 `DISPLAY2` **1728×3072** @4608,−204 |
| 启动 dev 实例 | `.\node_modules\.bin\electron.cmd .` —— **绝不要用 `npm start`**（它的 `prestart` 会重建一个受版本控制的二进制） |
| 停止 | `npm run stop:app`（会一锅端所有实例，含 E2E 用的独立 userData 实例） |

> **仓库规矩（AGENTS.md）**：任何**可见**的自动化/真机测试窗口一律放**副屏**；没有副屏就先问用户。隐藏窗（`show:false`）不受此限。
>
> **副屏参数会变**：旧文档写的 1152×2048 @3072,−136 是上一台/上一次配置；接手时**先自己量一遍**再决定窗口坐标。E2E 的可见窗由 `main.js:positionAutomationWindow()` 自动居中到副屏，不需要手工摆位。

---

## 3. 本会话做了什么（2026-10-11，评审轮）

### 3.1 先核实状态，结果：三项门禁全中，但有 4 处差异

在 `33f96b2` 实测：`npm test` **904/904**、`npm run check` **290 文件 + main.js 1297/1300 + i18n 607**、`npm run test:e2e` **6/6**——与上一份交接文档逐项一致。核实中发现 4 处与文档不符的地方：

1. **交接文档 §5.1 与方案 §23.3 把 `pin` 的 1 行残留言误记为"注释"。** 实测 `node scripts/check-i18n.js --area pin --list`，那唯一一行是 `pin/pin.html:12`——**可见 UI 文案**（「穿透中 · 悬停退出」＋ tooltip），且 pin 是唯一完全没接 i18n 的窗口（不载语言表、`preload-pin.js` 的订阅无人消费）。record / long-capture 的残留言确实分别是注释与纯校验 `throw`。**两份文档都已改正。**
2. **显示器拓扑与文档不符**（见 §2）：不是故障，是环境变了；副屏存在故未阻塞。
3. **`npm test` 非完全确定性**：一次全量跑出 903/904（`capture-renderer-runtime.test.js` 的 `ctrlA.toolbarVisible`），单跑 3/3 通过、其后本地每次全量都全过。**当时判定为"既有 flake"——这个定性在 2026-10-12 被证伪**：推送到远程后该测试在 CI 上 2/2 稳定失败（见 §6.8），所以它对本项目的门禁来说是**确定性失败**，不只是本地抖动。
4. 尚未发现第 4 项读数错误——残留构成、覆盖率、审计读数均与文档一致。

### 3.2 用 `open-code-review` 评审 `f634018..HEAD`（批次 C 全部改动）

命令（规则文件把四个重点写成 `--rule`：三语对称 / sandbox preload / CSP 内联脚本 / 跨文件全局作用域）：

```powershell
ocr review --audience agent --from f634018 --to HEAD `
  --rule .tmp/ocr-rule.json --timeout 20 --concurrency 6 `
  --background "<批次 C 背景>" > .tmp/ocr-batch-c-review.txt 2>&1
```

**结果：80 个文件、33 条评论、约 18m41s、约 49.4M tokens。** 分级：**1 critical / 5 high / 11 medium / 16 low**。完整原文留在 `.tmp/ocr-batch-c-review.txt`（`.tmp/` 已 gitignore）。

> 注：`ocr` 内部会跑 `git grep` 且不支持 `\uXXXX` 转义，所以开头的 `[ocr] ✘ code_search failed` 是**无害警告**，不是评审失败。

### 3.3 逐条在代码里核实后修的（7 个提交）

| 提交 | 内容 | 关键验证 |
| --- | --- | --- |
| `a5b6e20` | `shared/locales/record.js` 的 **zh-CN 块有 5 条仍是英文**（zh-TW 已翻）；4 条是活调用点（`record/record.js:387,388,540`、`record/recording-utils.js:183`）→ 默认语言显示英文报错 | diff 恰好 5 行；en-US/zh-TW 块未动；残留 607 不变（locale 表不在扫描范围） |
| `599b513` | **pin 窗从未迁移**（§3.1-1）。新增 `shared/locales/pin.js`（三语）+ `pin.html` 载表 + `pin.js` 载入/广播时 `applyTranslations()`；`--max` **607 → 606** | pin 残留言 0、TOTAL **606 ≤ 606**；`window-security` 探针在沙箱下真实加载 `pin.html`（0 内联脚本、console 干净、`applyPinData` 在位） |
| `f7fd3b2` | **裸键名**：`toolbar.action.*` 只定义在 `shared/locales/toolbar.js`，而 config 窗与 action 窗都没载 → 设置页「功能与顺序」与 explain 窗标题显示 `toolbar.action.copy.label` 这类**裸键**；同提交修 `models-render.js:45` 的模板串错误（`' + t(...) + '` 写在反引号内 → 首启「无供应商」空状态渲染字面量）与 `models-plan.js:80` 漏 `t()` | 真机隐藏窗探针（用应用自己的 `settings-defaults`）：5 行标签显示 复制/搜索/翻译/解释/跳转，`rawKeyOccurrences 0`；空状态显示「暂无供应商，请点击"添加供应商"创建。」；explain 窗头显示 **解释** |
| `8a4d3ee` | 恢复 `long-capture.html` / `overlay.html` 被批次 C 改没的 `form-action 'none'`（`form-action` **不吃** `default-src` 回退，另 10 个窗口都还留着） | 12 个产品 HTML 审计：0 条 CSP 问题 |
| `8d62dd5` | `about.js` 主按钮用 `busy`（含 `available`/`downloaded`）禁用，而 `update-service.js` 的 `autoDownload=false` → **应用内更新永远点不动**；`history.js` 4 处 IPC 无 catch（初始加载 reject 会永远停在「加载中」，因为 `renderRoute()` 不管这条路由） | 按钮改用 `primaryBusy`，渠道下拉保留宽 `busy`；新增 2 个键 × 三语 |
| `8dd5862` | **同类第二例**：config 窗还缺 `shared/locales/search.js` → 分类名输入框显示 `search.category.all`（未编辑直接保存会把裸键写进用户配置）。并给 `test/i18n-contract.test.js` 加**按窗口**键解析门禁 | 真机页面 10 个输入框显示 全部/文件夹/…/压缩文件，`rawKeyValues 0`；新门禁**反向验证**（删掉 `search.js` 标签即如实变红） |
| `f4cfda9` | 文档回填：更新本文件的前身、方案 §23.4 第 10–11 条 | 门禁复跑一致 |

**测试数 904 → 905**（新增那条按窗口门禁）；语法文件数 **290 → 291**（新增 `shared/locales/pin.js`）。两者都是**有意增长**，不是回归。

### 3.4 核实为干净的部分（不是假设，都有命令）

- **preload 沙箱**：11 个 preload 只 `require('electron')`，语言订阅全部内联（`sandbox:true` 下不能 require 本地文件）。
- **CSP / 内联脚本**：12/12 产品 HTML —— 零内联 `<script>`、零 `on*=` 内联事件、无 `javascript:`、无 `type=module`、无 `eval`；全部具备 `default-src 'none'` + `script-src 'self'` + `form-action 'none'`。
- **跨文件全局作用域**：生产代码里没有任何 `const { t } = window`；未发现跨文件重复顶层声明。
- **热切换链路**：10 个已接线窗口都在载入时与广播时调用 `applyTranslations()`；主进程广播 + `language.tray` 重建在 update 与 reset 两条路径都注册了。另用隐藏窗探针证明 **`localStorage` 在不同 `file://` 目录之间是共享的**，所以切换后**新开的**窗口能正确解析新语言（这一条此前只是推断，现在有实测）。
- **i18n 整体**：971 键 × 三语、对称差 0、键形合格、186 个 `data-i18n` 键 0 缺失；**所有 JS `t('字面量')` 调用点都能解析**（现有门禁从不检查这一项，本轮用 `.tmp/audit-i18n-usage.js` 补了覆盖）。

---

## 4. 剩余工作

### 4.1 统一真机测试（**唯一剩余验收**，用户要求挂账）

用户 2026-10-11 明确："测试都先跳过，先进行后续开发。开发完成后统一进行测试处理。"

清单：`docs/plans/2026-10-11-consolidated-verification-checklist.md`（已含 §0 环境准备 / §1 优先级 / §2 批次 A 8 项 / §3 批次 B 音轨·光标·标注编辑 / §4 失败处置 / §5 收口动作）。

**该清单还缺一节：批次 C 三语言**（需补：zh-CN/en-US/zh-TW 三语言切换、11 个窗口文案随语言变化、切换不重启生效、`language.tray` 托盘重建、设置页「界面语言」行）。

> ⚠️ **补这一节时请把 §4.5 的 5 处"热切换残留"写进预期**：目前**已知**会在真机上看到旧语言残留，不要当成新发现的偶发 bug。
> 另：**B4 游戏模式托盘兜底**仍是最高风险项（若失效用户会遇到"穿透后无法退出"）。

### 4.2 发布动作（**一次都没做**）

> **2026-10-12 更新（已部分执行）**：用户决定 **A/B/C 合并为单次发布 `v2.5.0`**（`2.3.0`/`2.3.1` 从未打 tag，无法事后拆三次）。已完成：版本 bump（`d4d02a5`，`check:version` 通过）· `npm run build:native` · 本地打包 nsis + portable + SBOM + `latest.yml` · **`npm run verify:package` exit 0（fuses 8/8、两个启动探针通过）**。记录见 `docs/releases/2026-10-12-v2.5.0-build-acceptance.md`。**仍未做**：安装/覆盖升级/卸载验收、真机功能验收（仍挂账）、**打 tag 并推送触发 `release.yml`**（需远程写授权与 required reviewer）、签名（`verify:release`）。**合规缺口按用户决定随后单独做**（发布包当前不含 LICENSE/NOTICE）。

### 4.3 P1（Auto Filter / MCP）：**被阻塞**

受 **F1-① 许可证字符串**（`GPL-3.0-only` vs `GPL-3.0-or-later`）阻塞——任何 `snow_shot/` 移植都取决于此；另有 F1-②/③ 与 L2 署名待用户拍板。

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
| ✅ **已解决**：CI 曾在 `capture-renderer-runtime` 上红 | `9db90bb` 把固定 `sleep(150)` 换成轮询 + 补诊断后，CI 2/2 全绿（`Check and test` success）。见 §6.8 |

### 4.5 批次 C 评审遗留（**已核实、本轮未修**，按等级排列）

> **2026-10-12 更新**：下表的 **5 处热切换残留已全部修复**（方案 §25），并有真实 Electron 渲染层探针覆盖（`test/i18n-hot-switch-runtime.test.js`，修复前红、修复后 2/2 绿）。交接文档 §0 的"⚠️ 已知未修缺陷"随之作废；`check-i18n.js` 的 `localeCoverageProblems()` 与 Low 级清理项**仍未处理**。

| 项 | 位置 | 建议修法 |
| --- | --- | --- |
| **热切换后旧文案残留（5 处）** | ① `search/search.js:378`：`renderStatus` 未被重建 → 切换后仍显示旧语言的状态行与 `title`；② `action/action.js:780`：`applyTranslations()` 会把脚本自己写的头部/loading 打回静态键（explain/custom 动作会变回"翻译中…"）；③ `record/record.js:849`：`audioNotice` 存的是**已翻译的句子**，切换后不重算；④ `recognition/recognition.js:218,238`：`#title` 的 `data-i18n` 与 JS 视图标题双写冲突，另复制按钮的 1s 计时器捕获了旧语言字符串；⑤ `long-capture/long-capture.js:400`：`#status` 同时有 `data-i18n` 与 `setStatus()`，切换后显示静态的"preparing" | 统一模式：**把状态存成「键 + 参数」而不是成品句子**，广播时重跑各自的 render（参照 `record.js:850` 的 `setState(state)` 与 `capture.js:1344` 的做法）。①④⑤ 也可考虑去掉 `data-i18n` 标记、纯由 JS 渲染 |
| **`scripts/check-i18n.js:83-88` 的 `localeCoverageProblems()` 永不触发** | 它读 `globalThis.__LOCALES` 这个**累计** bag（只在循环前重置一次），从 `action.js` 起每个文件都"注册了三语" | 按「require 前后各语言键数差」归因到单文件；**必须同时豁免** `zh-CN.js`/`en-US.js`/`zh-TW.js` 三个单语文件，否则 `:112` 会误报（评审自己也警告了这点）。真正的兜底已由对称差 + §5.4 的按窗口门禁提供 |
| 死键 / 死变量 / 陈旧注释（Low） | `action.pin.window`（三语都在、无调用点）；`record.error.system-audio-capture-failed`（无调用点且与 `record.audio.notice.system-failed` 重复）；`config/routes/models-render.js:7` 的 `codingPlanPresetId`；`config/routes/models-editor.js:12` 解构出的 `modelTaskForFeature`；`main/domains/selection/index.js:13` 未用的 `getVisibleToolbarActions` 导入；`shared/locales/toolbar.js:19` 的孤立 `;`；`shared/locales/long-capture.js:9` 注释里写旧的键形正则；`config/routes/about.js:61` 与 `local-search.js:81` 的嵌套三元 | 纯清理，可合并成一次「review cleanup」提交 |
| `selection/index.js:33-35` 出站 label 未解析 | 生产者侧仍发 `actionDefinition.label`（键） | **症状已随 `action.html` 载入 `toolbar.js` 消失**（消费侧修好了）；是否再改生产者由后续决定 |

---

## 5. i18n 口径与门禁（**新会话必读，别踩反**）

### 5.1 口径：迁移目标是"用户可见 UI 文案"，不是"CJK 行数归零"

`scripts/check-i18n.js` 统计的是**含 CJK 的行数**，其中包含中文注释、纯模块校验 `throw`、喂给模型的转录格式、提示词、存储/API 契约值。**这些都不翻**（依据 D6 与方案 §10.5）。所以残留**永远不为 0**。

### 5.2 残留 606 行的构成（方案 §23.3 有逐 area 表，已同步）

| area | 残留 | 主要构成 |
| --- | --- | --- |
| `config` | 82 | 中文注释 73 + 存储契约 7（翻译语言下拉 `value`、`targetLanguage` 白名单）+ 图标字形「译」 |
| `capture` | 223 | 注释 219 + 4 行未使用数据 / `print.html` 的 `<title>` |
| `main` | 281（另 **169** 行 `throw` 按 D6 单独出账） | UI 已迁；`throw`/日志/release notes/提示词不翻 |
| `action` | 8 | `conversation-text.js` 的剪贴板转录格式 + 回喂模型标记 |
| `toolbar` | 5 | 默认提示词 + `TRANSLATE_*_LANGUAGES` 契约值 |
| `record` / `long-capture` | 4 / 3 | 注释 + 纯模块校验 `throw` |
| `search` / `recognition` / `pin` | 0 / 0 / **0** | pin 已迁移（`599b513`）；原来记为"注释"是错的，那是可见文案 |
| **TOTAL** | **606** | 相对基线 **1237 降 51%** |

### 5.3 门禁只能下调

```jsonc
// package.json
"check": "node scripts/check-js.js && npm run check:architecture && npm run check:i18n",
"check:i18n": "node scripts/check-i18n.js --max 606"
```

**`--max 606` 是硬门禁，只能往下调，不得上调。** 下调前先更新方案 §23.3 的残留表。注意 `--max` **默认不开**：不传时 checker 永远 exit 0，所以"有残留"本身不会让测试变红。（本轮就是按这条规矩把 607 降到 606 的：先在 `599b513` 里改 §23.3 再加门禁。）

### 5.4 键名与文件约定

- 键名 `<domain>.<module>.<semantic>`，**每段都允许连字符**（`long-capture.*` 合法）。
- **一个 domain 一个文件** `shared/locales/<domain>.js`，**每个文件内同时注册三语**。新增 domain 时**新建自己的文件**，不要写进 `zh-CN.js`/`en-US.js`/`zh-TW.js`（那三个只放跨窗口公共键）。
- 三语键集合对称差**必须为空**（零容忍）。
- 每个窗口 HTML 在自身脚本**之前**加：三个语言文件 + `shared/i18n.js` + **它要解析的每一张 domain 表**。
- 🔴 **跨域键必须载表**（本轮两个真实缺陷的根因）：窗口只看得见自己 `<script>` 载入的表。config 窗解析 `toolbar.action.*` 与 `search.category.*`，就必须既载 `toolbar.js` 也载 `search.js`；否则 `t()` 返回键名本身、页面直接显示裸键。
- `test/i18n-contract.test.js` 现在有**按窗口**门禁 `every key a window resolves exists in the tables that window loads`：它按窗口合并**该窗口实际载入**的表，并把**键形字面量**也算作使用——`t(category.label)` / `t(action.label)` 这类**计算参数**用普通 `t('...')` 扫描抓不到，而这正是两个真实缺陷的形态。已用「删掉 `config.html` 的 `search.js` 标签」做过反向验证。

---

## 6. 已知风险与坑（逐条都有代价）

### 6.1 `git reset --hard` 事故（真实损失过工作）

并行跑两个子智能体时，reflog 出现 `05eb03d HEAD@{0}: reset: moving to HEAD`，**一次性清空两个流全部未提交的工作**（16 个路由文件 + locale/checker 改动）。两流都已重做，但这是真实事故。

**纪律**：① 派发子智能体时把"禁止任何 git 写操作"**逐个列出** `reset`/`checkout`/`restore`/`clean`/`stash`/`add`/`commit`；② Lead 在并行波次期间用 **`git stash create`**（非破坏性、不动工作区）周期性取恢复点；③ 收口前不要在共享 worktree 里跑任何回滚命令。本轮全程**未派发任何子智能体/teammate**，所有 git 写操作都是限定路径的 `git add <路径>` + `git commit`（从未 `git add -A`）。

### 6.2 跨文件搬迁必须用**真实页面**验收

D2 拆分后出现过 **3 个白屏级缺陷**，而 `npm test` 全绿、`npm run check` 的语法门禁完全无感。教训：跨文件搬迁/新窗口接线，必须用隐藏 Electron 窗探针或 e2e 打开真实页面看 `console`/`pageerror`。**本轮的所有 i18n 修复都是这么验的**（`.tmp/probe-i18n-keys.js`，`show:false`）。

### 6.3 经典脚本共享全局作用域 —— 能省事，也能埋雷

- 顶层 `function` 成为 `globalThis` 属性；顶层 `let/const` 进**全局词法环境**，对其他脚本在**调用时**可见（TDZ 只在声明脚本执行前生效）。这正是 D2 能逐字搬迁函数体、i18n 能直接用全局 `t()` 的原因。
- **雷**：`shared/i18n.js` 的 `t`/`setLanguage`/`applyTranslations` 是顶层 `const`，窗口脚本写 `const { t } = window` 会抛 `Identifier 't' has already been declared` 并**整脚本不执行**（只有真机探针看得见）。**正确用法**：直接 `t(...)`，或用 `window.i18n` 命名空间。

### 6.4 `sandbox: true` 的 preload **不能 require 本地文件**

`main/services/window-security.js` 锁死 `sandbox: true`。曾把语言订阅抽成共享 helper，**11 个 preload 全废**。修法是**内联**（只能用 `ipcRenderer`）。同类改动前先确认 preload 的沙箱约束。

### 6.5 测试断言的三种"搬家后必红"模式（规则 C6，必须同提交同步）

| 模式 | 症状 | 正确改法 |
| --- | --- | --- |
| 硬编码清单 | `deepEqual` 精确数组（effect id、preload API key、locale 文件清单） | 加进清单，或用"包含 + 排序"的端态契约 |
| `indexOf('x.js')` | 新增 `shared/locales/x.js` 后命中语言包而非控制器脚本 | 改为匹配脚本标签 `indexOf('src="x.js"')` |
| 源码中文字面量 | 文案迁进 locale 表后 `assert.match(script, /中文/)` 红 | 断言键（值在 locale 表里） |

**绝不允许**为了让测试变绿而削弱生产代码。

### 6.6 🔴 **整窗缺 domain 表 → 渲染裸键**（本轮最重要的新坑）

`shared/i18n.js` 的 `t()` 在查不到键时**返回键名本身**（不抛错、不打 console），所以：
- `scripts/check-i18n.js` 与 `test/i18n-contract.test.js` 的 data-i18n 断言**都先合并全部 locale 文件**再解析 → 一个窗口整体缺一张 domain 表时**两个门禁都全绿**；
- 只有"按窗口合并该窗口实际载入的表"才能发现（§5.4 的新门禁）。
- 触发形态往往是**计算参数**：`t(category.label)`（`DEFAULT_CATEGORIES` 里存键）、`t(action.label)`（`TOOLBAR_ACTION_META` 里存键）——普通 `t('字面量')` 扫描看不见。**键化的"数据表"（catalog/defaults/meta）是这类缺陷的高发区**，给某模块的 label 键化时，必须同时确认**所有**消费窗口都载了那张表。

### 6.7 CRLF / 换行陷阱

仓库 `core.autocrlf=true` 且**无 `.gitattributes`**：`write` 工具写出的文件在工作区是 LF，`edit` 过的仍是 CRLF，git 提交时会归一（出现 `LF will be replaced by CRLF` 警告属正常）。

**编辑断言时**：用 `[^\r\n]*` 或 `[\s\S]`，**不要**用 `[^\n]*\n`。`edit` 的 `old_string` 若跨行，CRLF 文件会匹配失败 → 改用**单行替换**或写脚本按行处理（本轮两处多行改动分别用了 `EOL` 感知的临时脚本 `.tmp/fix-record-zhcn.js` / `.tmp/fix-review-history.js`）。

### 6.8 其它

- 🔴 **`test/capture-renderer-runtime.test.js:455` 的 `ctrlA.toolbarVisible` 在 CI 上稳定失败**（本地间歇）。**这是当前 master 必需检查 "Check and test" 变红的原因**，任何推送/发布门禁在修好前都会红。
  - 已确认：本地 905/905 绿；CI（GitHub Windows runner）原始运行 + 重跑 **2/2 失败**，同一断言 `actual:false expected:true`，卡在 "Run tests" 步骤，E2E/覆盖率/long-capture 三步被跳过。
  - 断言读 `#toolbar` 是否去掉 `hidden`。`capture/capture.js:1305` 的 Ctrl+A 处理**是同步的**，`render()` 只在三种情况保持隐藏：`selection.w<2||h<2`、`activeOcrResult` 非空、`selectState` 为 auto/selecting/dragging/resizing。该子用例 `imageBounds=null` → 回退 viewport（本地实测 `displayBounds 800×602`、`selectState "selected"`、`activeOcr false`）。
  - **处置与结果（2026-10-12 当天完成）**：改动只落在测试里——① 探针的 ctrlA 读数补上 `toolbarClass/selectionState/activeOcr/rawSelection/imageLoaded/imageSize/displayBounds`，455 的失败信息打印整个 `report.ctrlA`；② 把 Ctrl+A 后的固定 `sleep(150)` 换成最多 3s 的轮询。提交 `9db90bb` 推送后，**CI 原始运行与随后整轮重跑 2/2 全绿**（`Check and test` 与 `Build hardened unsigned candidate` 均 success）。→ **结论：触发条件是"固定 150ms 在慢 runner 上不够"的调度竞态**，不是产品缺陷；探针仍保留上述诊断字段，日后若再红会自带读数。
  - 本地先看到 903/904 时的处理：**单跑该文件确认**（`node --test test/capture-renderer-runtime.test.js`），不要当成本次改动引入的回归。
- **子智能体（`subagent`）不是 teammate**：`list_agents`/`wait_agent` 看不到，Lead **无法** `send_message`。所有约束必须写进初始 prompt。
- **并行波次必须写作用域互斥**：可行前提是"一路一个 `shared/locales/<domain>.js`"。
- **`npm test` 与 e2e 都必须先清 `ELECTRON_RUN_AS_NODE`**（见 §1）。
- 本机 `read`/`grep` 偶有显示差异，**以磁盘为准**；验证一律用 `node`（PowerShell 的 `-split "\`n"` 曾算出 +9 假差）。另：**PowerShell 里用 `node -e` 写含引号的正则极易被转义搞坏**，直接写临时 `.js` 文件更稳（本轮踩了 3 次）。

---

## 7. 文档地图

| 文档 | 用途 |
| --- | --- |
| **本文件** | **新会话入口**：当前状态、剩余工作、坑 |
| `2026-10-11-batch-c-handoff.md` | 上一入口（**评审前**快照）；§1 读数、§5.1 残留表、§5.2 `--max` 已被本文件取代；其 §3.3 保存了完整的评审修复清单（与本文件 §3.3 同源） |
| `2026-10-10-p0-gap-closure-plan.md` | **主方案（1300+ 行）**。§1 共同约束 · §2 IPC/安全 · §3.1.1 流注册表 · §3.1.2 回滚纪律 · §3.3 子智能体规约 · §10 i18n 全节 · §16–§21 批次 A/B 逐波结果 · §22 Wave 8.5 · §23 Wave 9/10 · **§23.3 残留表** · **§23.4 第 10–11 条：本轮评审修复与按窗口门禁** |
| `2026-10-11-consolidated-verification-checklist.md` | **统一真机测试清单**（仍缺"批次 C 三语言"一节；补写时把 §4.5 的 5 处残留写进预期） |
| `2026-10-10-p0-batch-a-verification.md` | 批次 A 验收记录；**§2 有门禁读数勘误**（旧 91.87% 已证伪为 91.85%） |
| `2026-10-10-p0-batch-a-handoff.md` | 历史交接（批次 A 时代），已过期 |
| `2026-10-10-snow-apps-feature-gap-analysis.md` | P1 分析（F1/L1–L3/L9/L10 前置门） |

**引用任何门禁读数前先看本文件 §1 与验收记录的勘误** —— 旧文档里的覆盖率/测试数已被多次刷新（780b76c 时代是 904/607，现在是 905/606）。

---

## 8. 待用户决策（**不要在没确认前自行拍板**）

1. **F1-① 许可证字符串**：`GPL-3.0-only` 还是 `-or-later`？——**阻塞整个 P1**（任何 `snow_shot/` 移植）。
2. **F1-②/③ 与 L2 署名**：合规文件相关。
3. **三个版本 bump**（v2.3.2 / v2.4.0 / v2.5.0）何时做、是否合并成一次发布。
4. **统一真机测试的时间**（需要用户配合操作；`B4 游戏模式`优先级最高）。
5. **§4.5 的 5 处热切换残留**：真机测三语言**之前**修掉，还是先测出问题再一起修？
6. 是否要**把各域中文注释英文化**（可把残留 606 进一步压低，但纯属体力活、无功能收益 —— 当前口径已接受注释保留中文）。

---

## 9. 新会话建议的第一批动作

```powershell
# 1) 确认状态（应为：HEAD=f4cfda9 **或其后继**——本文件自身的提交会让 HEAD 再往后 1；工作区仅 .zcodeignore）
git log --oneline -5
git status --short

# 2) 复跑门禁（务必先清环境变量）
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
npm test                # 期望 905/905
npm run check           # 期望 291 文件 + main.js 1297/1300 + i18n 606
npm run test:e2e        # 期望 6/6
```

3. 读本文件 §4 的剩余工作 + 方案 §23.3/§23.4。
4. **先补** `2026-10-11-consolidated-verification-checklist.md` 的**批次 C 三语言**一节（把 §4.5 的 5 处残留写成预期）。
5. 与用户约统一真机测试时间（**B4 最高优先**）；同时问清 §8.5。
6. 只有拿到用户确认后才做版本 bump；**不要**在没有新证据的情况下动 i18n 的 `--max`。

> **启动 dev 实例**：`.\node_modules\.bin\electron.cmd .`（**不要 `npm start`**）。可见测试窗口一律副屏（§2 有实测坐标）。
> **本轮评审产物**都在 `.tmp/`（已 gitignore，可直接复用）：`ocr-batch-c-review.txt`（33 条原文）、`audit-i18n-usage.js`、`audit-html.js`、`audit-window-tables.js`（按窗口缺表检查）、`probe-i18n-keys.js`（真机裸键探针）、`probe-i18n-window-language.js`（localStorage 跨窗共享探针）。
