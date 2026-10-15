# Highlighter 交接文档（2026-10-15）：截图交互 T1/T2/B6 全部落地后的状态与后续

> **本文件是新会话的唯一入口**（取代 `2026-10-14-capture-interaction-handoff.md`；那份仍留在仓库里作为历史记录）。
> 读完本文件就能接手：§0 状态速查 → §1 提交与工作区 → §2 运行环境（**含"中文路径导致 Electron 起不来"这个已根治的大坑**）→ §3 已完成 → §4 剩余工作 → §5 代码地图 → §6 契约钉死点 → §7 坑 → §8 验收命令 → §9 新会话开场文案（可直接复制）。

---

## 0. 一句话状态

**方案 `2026-10-14-capture-interaction-improvement-plan.md` 的 T1（A1–A5）与 T2（B1–B7，含 B6 多选 + mixed 态）已全部开发完成**，三轮真机反馈修复（钉图重新标注工具栏位置、小选区落位）也已落地；**2026-10-15 追加：方案 2「工具栏宽度跟随选区」也已落地**（§4.1）。版本 `3.0.0`。**门禁在"纯 ASCII 工作副本 + 默认环境"下全绿**：`npm test` 1001/1001/0（见 §4.1 的口径说明）、`npm run check` 全绿、`npm run test:e2e` 6/6、覆盖率达标。计划内**已无未开工项**；剩余的是"工具栏宽度优化（**仅剩方案 3b**）"、"3.0.0 发布侧收尾"、"人眼/真机验收"、"B6 的两项有意未做"。

| 项 | 值 |
| --- | --- |
| **工作副本（必须）** | **`D:\workspace\Highlighter`** —— 纯 ASCII 路径。**不要用**任何含中文的路径（见 §2.1） |
| 分支 / HEAD | **`feat/capture-interaction-t1`** —— 代码收尾于 **`d8d46ab`**（B6 wave 2）；本交接文档本身也是一个提交，最新 HEAD 用 `git log --oneline -1` 核对（截至 2026-10-15 共 **17** 个提交） |
| 版本 | `package.json` = **`3.0.0`**（提交 `36a89e9`） |
| 代码完成度 | T1 ✅（A1–A5） · T2 ✅（B1/B2/B3/B4/B5/**B6**/B7） |
| `npm test` | **1012 用例 / 1012 通过 / 0 失败**（旧工作副本口径）。**全新 clone 为 1001 / 1001 / 0**（本 clone 基线 997 + 本次新增 4 条契约）；与 1012 差的 11 条 = 另一条工作线的两个**未跟踪**测试文件（`action-table-runtime` / `markdown-render`，共 15 条）减去本次新增的 4 条 |
| `npm run check` | 语法 **304 文件**（全新 clone **300**，差 4 = 另一条工作线的未跟踪 JS）· `main.js` **1297/1300** · i18n **605 ≤ 606** · locale **1003×3 对称** |
| `npm run test:e2e` | **6 / 6**（34.1s；**会开 app 窗口，跑之前先问用户**，见 §7.6） |
| 覆盖率 | `test:coverage:loaded` 行 **92.9%**（≥85 门槛） · `test:coverage:critical` **93.22 / 94.07 / 92.42**（与方案 §1.1 记录值逐字相同） |
| `npm run audit:dependencies` | **0 个未豁免漏洞、18 个失效豁免项 → exit 1**（**既有状态**，非本分支引入；`package.json`/`package-lock.json` 零改动） |
| 安装包 | `dist/Highlighter-Setup-3.0.0.exe` · 144,882,056 B · SHA256 `5D2C63EEFD8F182D718D5985A8ED47EC932919700CC347568C5B3424C4D3C298`（**未签名**；portable **未构建**） |
| 旧副本 | `D:\workspace\Highlighter - 副本`（含中文，HEAD 停在 `1e349f8`）**只作快照**：不要在其中跑 Electron / 测试 / 打包 |

---

## 1. 提交与工作区

### 1.1 本分支的提交（`git log --oneline master..HEAD`）

> 下面是**代码与既有文档**的 16 个提交；其后还有 1 个"2026-10-15 交接文档"提交（即本文件），最新 HEAD 以 `git log --oneline -1` 为准。

```
b892e42 docs(plans): record the ASCII-path migration and the green gates
1e349f8 docs(plans): correct the "Electron cannot start" misdiagnosis
ea668f6 docs(plans): record the B6 multi-selection landing and refresh the handoff
d8d46ab feat(capture): shift+drag marquee and per-item selection outlines (B6 wave 2)
3effa97 feat(capture): shift multi-select with mixed-state toolbar echo (B6 wave 1)
48f5801 docs(plans): hand off the capture interaction work to a new session
775f5f0 fix(capture): centre the tool strip on a small region instead of the screen edge      ← 方案 1
aa7d3a8 fix(capture): derive the reserved strip from the strip the window will show           ← 真机第 2 轮
ef8ac63 fix(capture): keep the tool strip fully visible when re-annotating a pin              ← 真机第 1 轮
36a89e9 chore(release): bump to 3.0.0
87ded5b fix(capture): step the wheel from the displayed width, not the legacy mirror
5944ba1 docs(plans): record what T1 and T2 actually landed
c0887be feat(capture): remember one style per tool and persist it (B4)
f6dae10 feat(capture): continue a pen stroke from either endpoint (B7)
27e4499 feat(capture): second toolbar row with shape/line/opacity options (B1-B3, B5)
0b90609 feat(capture): land T1 of the capture interaction plan (A1-A5)
```

### 1.2 ⚠️ 工作区里的**另一条工作线**改动（**不要动、不要提交**）

`git status --short` 会看到这 14 项；它们属于并行进行的另一条工作线（选择助手 action 窗 / 表格渲染 / 安装器低完整性检测）：

```
 M action/action.css  action/action.html  action/action.js
 M build/installer.nsh                      ← 注意：见 §4.2，它会被打进安装包
 M test/action-security-runtime.test.js  test/design-tokens.test.js  test/window-security.test.js
?? .codegraph/
?? action/markdown.js  scripts/probe-action-table.js
?? test/action-table-runtime.test.js  test/markdown-render.test.js
?? docs/plans/2026-10-12-low-integrity-installer-brief.md  docs/plans/2026-10-14-answer-table-rendering-design.md
```

**纪律**：本分支的提交一律**按具体路径 `git add <文件>`**，**绝不用 `git add -A`**（历史上发生过并行 `git reset --hard` 清空两条流工作的事故）。

---

## 2. 运行环境（**上一份文档最大的坑，已根治**）

### 2.1 🔴 工作副本路径**必须**是纯 ASCII（2026-10-15 定位）

旧文档写着"本机 Electron 启动即崩、无法修复"——**那是误诊**。真实原因是工作副本路径里的中文目录名 `副本`：

| 试验 | 结果 |
| --- | --- |
| `electron.exe --version`（CJK 路径） | **exit `0x80000003`（STATUS_BREAKPOINT），零输出、无 WER 记录** |
| 同一份 exe 复制到 ASCII 路径 | **exit 0，输出 `v43.2.0`** |
| ASCII dist + 隐藏窗 `app.whenReady()` 冒烟 | **exit 0**：`app ready; displays = 1` |
| 命名管道 + Node 管道 stdio 探测 | 均正常 → **不是** DSH 沙箱限制 |
| `dist\win-unpacked\Highlighter.exe --version`（CJK vs ASCII） | `0x80000003` vs **exit 0** → 打包产物同理 |
| `ffmpeg-static\ffmpeg.exe` 写 `%TEMP%`（CJK 路径下） | EACCES / status -13；换 ASCII 路径后正常 |

机理：Chromium 启动早期从**可执行文件所在目录**读 `icudtl.dat` / `snapshot_blob.bin` / `resources.pak`，非 ASCII 路径解析失败 → fatal CHECK → `__debugbreak`。**原生二进制（Electron、ffmpeg）都吃这条规则。**

**当前工作副本 `D:\workspace\Highlighter` 已是纯 ASCII**，因此在默认环境下**什么都不用设**（除了下面的 `ELECTRON_RUN_AS_NODE`）就能跑真 Electron 与全部测试。

> 兜底（万一必须在含中文的路径下工作）：把 `node_modules\electron\dist` 复制到 ASCII 路径并设 `ELECTRON_OVERRIDE_DIST_PATH`，再把 `TEMP`/`TMP` 指到工作区内（细节见 `2026-10-14-capture-interaction-handoff.md` §2.2）。

### 2.2 `ELECTRON_RUN_AS_NODE`

本机环境把它设成了 `1`。**每个 node/npm 命令前都要清**，否则 Electron 会被当 Node 跑、成片失败：

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
```

### 2.3 其它环境事实

| 项 | 值 |
| --- | --- |
| 平台 / shell | Windows + `pwsh`（PowerShell 7.6） |
| Node / Electron | node **v24.15.0** · Electron **43.2.0**（`node_modules\electron\dist\version`） |
| 显示器 | **单屏 `1493×933`（`\\.\DISPLAY1`，无副屏）** → 可见测试窗按 `AGENTS.md` **先问用户** |
| 网络 | **对 GitHub release 下载不可达**（electron-builder 会在 packaging 阶段 ETIMEDOUT）→ 打包必须带 `--config.electronDist=<repo>\node_modules\electron\dist`（§8.1） |
| 打包缓存 | `%LOCALAPPDATA%\electron-builder\Cache` 已有 `nsis-3.0.4.1` / `nsis-resources-3.4.1` / `7zip` / `icons` |
| 原生件 | `native/smart-select/SmartSelect.exe`、`native/ocr/HighlighterOcrSidecar.exe`、`native/everything-search/bin`、`native/everything/Everything.exe`、`ocr/models` **全部在位**（打包无需重编） |
| i18n 门禁 | `check-i18n --max 606`，当前 **TOTAL 605**（零余量）→ **`config`/`capture`/`record`/`long-capture`/`action`/`search`/`recognition`/`toolbar`/`pin`/`main` 里新增中文注释就会破门禁**，新注释一律英文；`shared/locales/**` 不在扫描范围 |

---

## 3. 已完成的功能（T1 / T2 / B6）

| 梯队 | 内容 | 细节出处 |
| --- | --- | --- |
| T1（A1–A5） | 按键门控（右键=快选+拖动、中键吞掉）· `pendingMove` 3px 点击/拖动阈值 · 滚轮调宽（起点=工具栏显示值、绘制中实时跟随、500ms 尾随去抖落盘）· 色板（7 预设 + 自定义 + ≤3 最近色）与 `screenshot.annotationColor` · 选中回显（UI-only）· 选区外元素可选 | 方案 §10.1 |
| T2（B1–B5、B7） | 第二行选项行（列容器 + `invalidateToolbarSize()` 唯一失效点 + `.above` 行序翻转）· rect/ellipse 填充/线型/圆角 · 箭头起终点 · per-tool 样式记忆（`screenshot.annotationStyles` = 8 工具模板 = 校验白名单）· 高亮浓度 / 文字粗体 · 画笔端点续画 | 方案 §10.1 |
| **T2-B6（新）** | **多选 + mixed 态，拆两波**：wave 1 = `selectedIds: Set` 权威集合 + `selectedAnnotation` 退化为 anchor（**既有 15 个 `selectedAnnotationItem()` 调用点一行不改**）· shift 在「命中 / 已选中体内 / 选区外命中」三处加减选、shift+右键只加 · mixed 三态回显（色块 `.mixed` 分裂色 / 宽度按钮全灭 / 第二行按字段取共同值）· 色/宽/选项一条补丁落到整集且仍**一帧**（按目标工具归属过滤字段）· Delete/方向键覆盖整集 · `#elementBar` 计数 + `elementBarSize` 收敛到唯一失效点 · 每项虚线框（手柄只在 anchor）；wave 2 = shift+空白拖**框选**（只增不减、阈值内 shift 点击**不清空**选中、三处收口、绘制在最后且不进导出） | **方案 §10.8** |

| **方案 2（新，2026-10-15）** | **工具栏宽度跟随选区**：`#toolbar` inline `max-width = min(视口−20, max(420, 选区宽+160))`（上限只收窄）· 唯一写点 `applyToolbarWidthLimit()` + 唯一调用点 `updateFloatingUi()` · 失效走 `invalidateToolbarSize()`（计数 3→4）· **钉图重新标注 `initData.imageBounds` 时跳过**（不碰 `stripRows`/`toolbarSpace`） | **方案 §10.9** |

| **工具栏图标化（新，2026-10-15）** | 截图工具栏里"汉字当图标"的两处全部换成真图标：① 第一行线宽组 `细/中/粗` → `weight-thin/medium/thick.svg`；② 第二行选项行 15 个按钮（`空心/半透明/实心`、`实线/虚线/点线`、`直角/圆角 4/圆角 8`、`起点/终点`、`淡/中/浓`、`粗体`）→ 15 个图标。**文案不丢**：`data-i18n="…"` 改成 `data-i18n-aria-label="…"`（无障碍名 + 键仍被使用，无死键），`data-i18n-title` 工具提示原样保留。图标仍走同一套 mask（`capture/icons/`），新增 18 个：7 个取 Bootstrap Icons v1.13.1 未改动的 path data（`square`/`square-half`/`square-fill`/`droplet`/`droplet-half`/`droplet-fill`/`type-bold`，只是改名），11 个按 `print.svg` 先例在同一 16×16 网格手绘（线宽/线型/圆角/箭头端点，家族里没有）。来历逐条写在 `capture/icons/LICENSE` | **§3 下方说明 + 测试名单** |

真机修复历史（钉图重新标注工具栏位置 ×3 轮、小选区落位）见方案 §10.5–§10.7。

---

## 4. 剩余工作（按建议优先级）

### 4.1 工具栏宽度优化：**方案 2 已落地（2026-10-15）**，方案 3b 待独立立项

- ✅ **方案 2（体验向）已落地**：`#toolbar` 的 inline `max-width = min(视口−20, max(420, 选区宽+160))`；上限只收窄、从不撑宽（宽选区渲染逐字不变）。落地要点：
  - 纯函数 `capture/selection-utils.js: toolbarWidthLimit()`；接线 `capture/capture.js: applyToolbarWidthLimit()`（**唯一写点**，仅在上限变化时写 DOM）+ **唯一调用点** `updateFloatingUi()`（`renderOverlay()` 每帧都走 → 选区变化与窗口 resize 自动跟随）。上限变化 = 折行 = 高度变化 → 走既有唯一失效点 `invalidateToolbarSize()`（调用点计数 3 → **4**，契约测试已同步）。
  - **与钉图条带的协同方式：跳过**。`stripFollowsRegion()` = `!initData.imageBounds`；该流程是唯一由主进程下发固定 `imageBounds`、且按"单行条带"预留 `actionSpace` 的路径（`main/domains/pin/index.js` 的 `stripRows`），折行会顶穿预留条带。跳过时清空 inline 上限，回落 `capture.css` 的 `calc(100vw - 20px)` —— 所以**钉图的 `toolbarSpace = 1088` / `stripRows` 推导一行都不用改**。
  - 实测（1493×933，主行 min-content 937 / 条宽 951）：「画图工具组 ↔ 选区」距离在右半屏小选区上 **384px → 0**，左半屏 **8px → 0**；代价是小选区条高 78 → 144（≤3 行）。完整前后对照表见方案 §10.9。
  - 仍未做的**方案 3b（根治）**：把 11 个识别/导出动作（≈370px）收进「··· 更多」溢出面板 → 主行 ≈ **566px**（38%），小选区也能右对齐/居中；同时可把钉图编辑器 `toolbarSpace` 从 1088 降下来。**代价**：`test/capture-toolbar-icons.test.js` 是**精确图标序列 deepEqual**，加/移图标必须同提交更新；i18n 新键三语；肌肉记忆改变。**建议独立立项。**
  - 方案 1 的剩余局限（选区贴屏左、如 100..300 时只能贴左）仍在，但方案 2 落地后该行的工具组已横向覆盖到选区（距离 0）。

### 4.2 3.0.0 发布侧收尾

| 项 | 状态 |
| --- | --- |
| portable 安装包 | **未构建**（`dist/` 里只有 3.0.0 的 NSIS setup；旧版本的 portable 与本版无关） |
| `npm run verify:package` | **未跑** —— 注意：启动探针**不再必然失败**（`dist\win-unpacked` 现在位于 ASCII 路径下），值得一试 |
| `dist/SHA256SUMS.txt` | **陈旧**（仍是 2026-10-12 的旧清单） |
| 签名 | 未签名（打包命令里 `--config.forceCodeSigning=false --config.win.signExecutable=false`） |
| `docs/releases/` 3.0.0 发布记录 | **未写**（格式照 `docs/releases/2026-10-12-v2.5.0-build-acceptance.md`） |
| 安装/静默安装 | 本机历史上曾被安全软件放进低完整性沙盒导致静默安装失败；**装 3.0.0 请交互双击/以管理员运行**，装完看卸载项 `DisplayVersion` 是否变 3.0.0 |
| tag | 未打 |

### 4.3 人眼 / 真机验收（自动化跑得到的已覆盖，剩下的只有"观感与手感"）

**已由自动化覆盖**：真 Electron 隐藏窗探针全套（`test/*runtime*.test.js`，`show:false`）+ Playwright e2e 6/6 + 覆盖率。

**仍需人眼确认**：右键快选拖动与 <3px 点击阈值 · 中键无效果 · 滚轮调宽（绘制中实时生效 + 去抖落盘）· 色板弹出/点外关闭/自定义色跨会话 · 选中回显（undo/redo 后同步、Esc 恢复）· 选区外元素再选 · 第二行各行控件（填充/线型/圆角/箭头端点/浓度/粗体）· **per-tool 记忆跨重启** · 画笔端点续画（含中断还原）· **B6 全部交互项**（shift 加选/减选、shift+右键只加、mixed 三态、批量改色/宽/选项各一帧且 Ctrl+Z 一步回退、批量 Delete、多选方向键、框选加选、**框选阈值内 shift 点击不清空选中**、框选 pointercancel、"拖动那一项其余不动"）。

### 4.4 B6 有意未做的两项（不是遗漏）

1. **多选整体拖动**：`pendingMove` 的形态被契约测试钉死（`test/capture-annotation-geometry.test.js` 的"唯一创建点 + 精确字段"），扩形态要同步三处收口路径，风险 > 收益。当前语义是"拖哪一项就只动那一项，其余保持选中"。
2. **多选下的层级 ↑↓ 仍只作用于 anchor**（与拖动同源）。
> 两项都建议与 §4.1 的方案 2/3b 一起评估（那时本来就要碰落位与主行结构）。

### 4.5 旧副本处置

`D:\workspace\Highlighter - 副本`（含中文）现在只是快照（HEAD `1e349f8`，14 项另一条工作线的脏改动仍在）。**是否删除由用户决定**；删除前请确认没有别的会话/工具还引用它，并核对绝对路径。

---

## 5. 代码地图（改哪儿先看这里）

### 5.1 纯函数模块（**受覆盖率门禁覆盖**，新算法一律下沉到这里）

| 文件 | 关键导出 |
| --- | --- |
| `capture/selection-utils.js` | `getResizeHandle`(153) · `getSourcePixelRect`(206) · `resizeSelection`(177) · `selectionCursor`(202) · **`resolveFloatingPlacement`(45)（工具栏/元素条唯一落位规则）** · **`toolbarWidthLimit`(98)（方案 2：工具栏宽度上限唯一规则）** · **`revalidateSelection`(116) · `commonSelectionValue`(129) · `rectsIntersect`(139)（B6：按 id 存活 / mixed 判定 / 框选相交）** |
| `capture/annotation-geometry.js` | `annotationBounds`(109) · `hitTestAnnotation`(239) · `findAnnotationAt`(274) · `MOVE_THRESHOLD`(27) + `movedBeyondThreshold`(158) · **`penContinuationTarget`(137)** · `translateAnnotation`(285) · `resizeAnnotationToBox`(363) · `reorderAnnotation`(444) · `clampAnnotationToStage`(474) · `cloneAnnotations`(487) |
| `capture/annotation-style.js` | `WIDTH_PRESETS/WIDTHS/resolveWidth`(78) · `PRESET_COLORS`(23)/`normalizeAnnotationColor`(87) · `nextWidthPreset`(94) · `FILL/DASH/RADIUS/ALPHA_PRESETS` + `resolveFill/resolveDash/resolveRadius/resolveAlpha/dashPattern` · `TOOL_OPTION_FIELDS`(49)/`DEFAULT_TOOL_OPTIONS`(60)/`resolveToolOptions`(167) · `TOOL_STYLE_TOOLS`(71)/`resolveToolStyle`(110)/`resolveToolStyles`(121) |

> ⚠️ `capture/annotation-style.js` **不在** `test:coverage:loaded` 的 include 清单里（`package.json:14` 只含 `selection-utils.js` 与 `annotation-geometry.js`）。

### 5.2 `capture/capture.js`（单写者，最易踩契约）

> 行号基线 HEAD `b892e42`；**方案 2 之后顺移**：`updateElementBar` / `invalidateToolbarSize` **+1**，**`invalidateElementBarSize` 及其后一律 +38**（下表括号内已是本分支实测值）。

| 关注点 | 函数（行号） |
| --- | --- |
| 选中状态 | `selectedAnnotationItem`(921，仍读 anchor) · `selectedAnnotations`(928) · `addSelectedAnnotation`(935) · `toggleSelectedAnnotation`(946) · `reResolveSelectedAnnotation`(962) · `setSelectedAnnotation`(1059) · `syncSelectedAnnotation`(1053) · `selectedIds`(120) |
| 回显 / mixed | `syncToolbarStyleFromSelection`(1033) · `applyToolbarSelection`(778) · `toolbarStyleTool`(852) · `applyToolbarColor/Width`(~749) |
| 样式编辑 | `applyStyleToSelectedAnnotation`(1373) · `ownsAnnotationField`(1386) · `writeAnnotationStyles`(1396，**唯一写回点**) · `commitSelectedStyle`(1415) · `stageSelectedStyle`(1426) · `setAnnotationColor`(866) · `setAnnotationWidth`(877) |
| 第二行 | `TOOL_OPTION_GROUPS`(~588) · `optionRowTool`(594) · `rowToolOptions`(602) · `selectionToolOptions`(612) · `syncToolOptionControls`(622) · `syncToolOptionsRow`(638) · `setAnnotationOption`(665) |
| 落位 | `toolbarPlacement`(719) · `updateFloatingUi`(730) · `updateElementBar`(504) · **`stripFollowsRegion`(586) · `applyToolbarWidthLimit`(590)（方案 2：唯一写点）** · `invalidateToolbarSize`(564) · `invalidateElementBarSize`(608) · `syncElementBarCount`(614) |
| 拖动 / 阈值 | `beginPendingMove`(1165) · `moveAnnotationTo`(1173) · `finishMoveAnnotation`(1235) · `cancelMoveAnnotation`(1246) · `quickSelectAnnotation`(1604，右键) |
| 框选（B6 w2） | `marquee`(123) · `beginMarquee`(977) · `updateMarquee`(983) · `finishMarquee`(993) · `cancelMarquee`(1010) · `drawMarquee`(1016) |
| 绘制 | `drawAnnotation`(368，唯一绘制入口，屏幕与导出同源) · `drawSelectedOutline`(465) · `drawSelectionOutlineBox`(459) |
| 微调 / 删除 / 层级 | `nudgeSelectedAnnotation`(1262) · `deleteSelectedAnnotation`(1112) · `reorderSelectedAnnotation`(1453) |
| 快照 / 重置 | `snapshotAnnotations`(1069) · `resetAnnotationState`(1465) · `commitAnnotation`(1485) |
| 导出 | `exportSelectionCanvas`(1783) |
| 画笔续写 | `beginPenContinuation`(1203) · `restoreContinuedPen`(1224) |

### 5.3 设置与主进程

| 文件 | 内容 |
| --- | --- |
| `main/services/settings-defaults.js` | `screenshot.annotationColor`、**`screenshot.annotationStyles`（8 工具模板 = 校验白名单，字段增删必须改这里）** |
| `main/services/settings-normalize.js` | `annotationColor` 的 `#rrggbb` 归一（`annotationStyles` 由渲染端 `resolveToolStyle` 归一） |
| `preload-capture.js` | `saveAnnotationColor` / `saveAnnotationStyles` / `saveAnnotationWidth`（全走既有 `settings:update`，**零新增 IPC**） |
| `main/domains/pin/index.js` | `startPinReannotation`：**所有重新标注路径**统一预留图像下方条带（`ROW_MIN_CONTENT=1040` / `toolbarSpace=1088` / `stripRows` 推导）。**方案 2 在该流程被跳过**（见 `initData.imageBounds`），所以这三个常数与推导一行都不用改 |
| `shared/locales/capture.js` | A3 色板 10 键 + B2/B3/B5 选项 21 键 + B6 计数 1 键（三语） |

---

## 6. 契约测试钉死点（**改动必同提交更新**，C6 纪律）

| 测试文件 | 钉什么 |
| --- | --- |
| `test/capture-annotation-geometry.test.js` | pointerdown **分支顺序**（选区手柄 > 选中元素手柄 > 选中体内 > 命中；A5 的"选区外命中"在前）· `pendingMove` **只有一个创建点** · 单一写回点与 0 变化不压帧 · `drawSelectedOutline` 后跟手柄 · `#elementBar` 结构 · 导出/绘制顺序 · geometry 解构清单 |
| `test/capture-interaction.test.js` | A1 按键门位置/右键快选形态 · A2 滚轮起点 `displayedToolWidth()` · A4 回显"只改 UI" · A5 选区外命中顺序 |
| **`test/capture-multi-select.test.js`（B6，15 条）** | `selectedIds` 权威集合 + anchor 退化 · 三个 B6 纯函数 · shift 四个落点 · mixed 回显 · 批量编辑仍一帧 · Delete/方向键覆盖整集 · elementBar 计数与 `elementBarSize` 唯一失效点 · marquee 只增不减与三处收口 · 每项虚线框但手柄只在 anchor |
| `test/capture-tool-options.test.js` | B1 结构（`.toolbar-row`/`#toolOptions`/`flex-wrap`/`.above`）· `invalidateToolbarSize()` 唯一写点 + **调用点计数（方案 2 之后 = 4：定义 / resize / 第二行 / 宽度上限）** · 六个选项组与 owner 列表 · **15 个选项按钮各自带 `.toolbar-icon` 且只有 `aria-label` 承载文案（不再有可见文字）** · 绘制分支"缺省逐字节不变" |
| `test/capture-floating-placement.test.js` | 落位两分支都必须在源码里 · 右对齐装得下逐字不变 · 居中兜底 · 内侧贴底 · **从 HTML/CSS 现算主行最小宽度**并断言 `ROW_MIN_CONTENT`/`toolbarSpace` 容得下 · **方案 2：`toolbarWidthLimit` 纯函数三段（下限 / 视口上限 / 退化入参）· 紧凑条的落位性质 · 唯一 `max-width` 写点 + 唯一调用点 + `stripFollowsRegion()` opt-out** |
| `test/capture-renderer-runtime.test.js` | **真 Electron 隐藏窗渲染层探针**：`window.__pr.stripWrap()` 实测条宽/主行高（方案 2：200px 选区 → inline `420px` + 渲染宽 420 + 主行 96px；宽选区 → 视口上限；`initData.imageBounds` 下发 → 无 inline 上限） |
| `test/capture-tool-styles.test.js` | 模板 ≡ `resolveToolStyles()` 规范表 · **整表一次写盘**（`saveAnnotationStyles` 只有一个调用点）· `toolbarStyleTool()` · 迁移铺底 · 旧键双写 |
| `test/capture-pen-continuation.test.js` | 纯函数 + 抬起/还原/一帧语义（**pointercancel 窗口 260 字符**，插代码别插在它前面） |
| `test/capture-color-palette.test.js` | 色板 DOM/CSS/接线 · recents ≤3 · capture 端无颜色白名单 |
| `test/capture-i18n.test.js` | **GOLDEN 表**：每个 `capture.*` 键的 zh-CN 文案逐字 + 双向"无死键/无漏标记"。**新增/改文案必须同步 GOLDEN** |
| `test/capture-selection-resize.test.js` | `window.selectionUtils` 的**解构清单**（加一个导出就要改这里） |
| `test/capture-ocr-pin-ui.test.js` | 钉图编辑器条带推导与 `transparent: true` · OCR 结果条定位公式 |
| `test/capture-toolbar-icons.test.js` | **精确图标序列 deepEqual**（加/移工具栏图标必须同 PR 更新）。2026-10-15 起该序列含 42 项：11 工具 + 3 线宽 + 13 动作 + 15 选项图标 —— 顺序即 DOM 顺序，改 HTML 必须同步 |
| `test/settings-validation.test.js` / `settings-normalize.test.js` | 两个样式键的类型契约与归一 |

---

## 7. 坑（每条都真实踩过）

1. **路径含中文 = 原生二进制全灭**（§2.1）：Electron 静默 `0x80000003`、ffmpeg 写盘 EACCES。**工作副本必须 ASCII。**
2. **i18n 零余量**：扫描区新增中文注释就破门禁（605/606）。新注释一律英文。
3. **`ELECTRON_RUN_AS_NODE`**：本机被设为 `1`，每个命令前都要清。
4. **PowerShell 引号地狱**：给原生程序传含空格/中文的参数时，把整个 `--config.electronDist=<路径>` 作为**一个带引号的字符串**传；不要用 `node -e "…含引号的正则…"`（写成临时 `.js` 文件再跑，`node <文件>`）。
5. **CRLF**：`core.autocrlf=true` 无 `.gitattributes`——`write` 写出 LF、`edit` 过的是 CRLF，提交时归一。跨行断言用 `[^\r\n]*` / `[\s\S]`，不要用 `[^\n]*\n`；`edit` 跨行匹配失败时改用单行替换。
6. **可见窗**：单显示器 1493×933 无副屏 → `AGENTS.md` 要求可见测试窗放副屏，**无副屏先问用户**；`npm run test:e2e` 会开 app 窗口（隐藏窗探针不用问）。
7. **GitHub 下载不可达**：electron-builder 直接打包会 ETIMEDOUT，必须带 `--config.electronDist=<repo>\node_modules\electron\dist`（§8.1）。
8. **`capture.js` 单写者**：新算法下沉到 `selection-utils.js` / `annotation-geometry.js`（覆盖率 include 清单），`capture.js` 只留接线；改动 pointerdown/落位/样式接线时**同提交**更新 §6 的契约测试。
9. **契约窗口是按字符数钉死的**（例如 `[\s\S]{0,360}?`）：往被钉住的函数里加注释/代码很可能**挤爆窗口**。加完先用 `.tmp/gates/` 里的量距脚本或临时 node 脚本量一下，再跑定向测试。
10. **新增图标必须过"规范化 mask 资源"断言**（`test/toolbar-icons.test.js` 的 `MASK_ASSET`）：wrapper 只能是 `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#000">`，内部**只能是自闭合的 `<path …/>`**（不接受 `<circle>`/`<rect>`），且必须单行 + 结尾一个换行。要描边就写在 `<path>` 上（`fill="none" stroke="#000" stroke-width="1"`），**不要写到 `<svg>` 上**。踩过一次：`<circle>` 的点线图标与 wrapper 带 stroke 的三个圆角图标都被这条断言拦下。

---

## 8. 验收命令清单（可直接复制）

```powershell
Set-Location 'D:\workspace\Highlighter'          # 必须是纯 ASCII 路径
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

# 1) 全量门禁（默认环境即可，无需任何 override）
npm test                      # 期望 1012 用例 / 1012 通过 / 0 失败
                              #   注：全新 clone（缺另一条工作线的两个未跟踪测试文件）为 1001/1001/0
npm run check                 # 期望 304 文件 · main.js 1297/1300 · i18n 605（全新 clone 为 300 文件）

# 2) 覆盖率
npm run test:coverage:loaded     # 期望 行 ≥85%（当前 92.9%）
npm run test:coverage:critical   # 期望 93.22 / 94.07 / 92.42

# 3) e2e —— 会开 app 窗口，动手前先问用户
npm run test:e2e                 # 期望 6 / 6

# 4) 依赖审计（既有 exit 1：18 个失效豁免项）
npm run audit:dependencies

# 5) 定向测试（改 capture 时先跑这几个）
node --test test/capture-multi-select.test.js test/capture-annotation-geometry.test.js test/capture-interaction.test.js test/capture-selection-resize.test.js test/capture-tool-options.test.js test/capture-i18n.test.js

# 6) 方案 2 的落位前后对照（改工具栏宽度/落位时跑；一次性脚本，在 .tmp/gates/ 下）
node .tmp/gates/measure-plan2.js   # 期望：175..791px 宽的选区，工具组↔选区距离 → 0
```

### 8.1 打包（唯一可行的一条；本机 GitHub 不可达）

```powershell
Set-Location 'D:\workspace\Highlighter'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$electronDist = (Join-Path (Get-Location).Path 'node_modules\electron\dist')
node node_modules/electron-builder/cli.js --config electron-builder.release.cjs --win nsis --x64 `
  --publish never --config.forceCodeSigning=false --config.win.signExecutable=false `
  "--config.electronDist=$electronDist"
```

- 用 `node <cli.js>` 而不是 `npx`（少一层 cmd shim）。
- `electron-builder.release.cjs` 里 `forceCodeSigning: true`，所以必须用 CLI 覆盖成 false；`asar: true` + `main: main/packaged-entry.js` + fuses。
- `npm run build:win` 会先跑 `prebuild:win → build:native`（要 MSVC）；**原生件已就位，不需要**。
- **portable 未构建**：要它就在 `--win` 里追加 `portable` target。

---

## 9. 新会话开场文案（**直接复制给接手模型**）

```text
接手 Highlighter（Electron 截图/标注工具）的截图交互改进工作。

工作副本：D:\workspace\Highlighter（**必须是这个纯 ASCII 路径**；含中文的 D:\workspace\Highlighter - 副本 只是旧快照，不要在其中跑 Electron/测试/打包）。
分支 feat/capture-interaction-t1（HEAD b892e42 或其后继，版本 3.0.0）。

第一步（按顺序）：
1) 读交接文档 docs/plans/2026-10-15-capture-interaction-handoff.md（全文：状态、环境、代码地图、契约钉死点、坑、剩余工作）。
2) 读方案 docs/plans/2026-10-14-capture-interaction-improvement-plan.md 的 §1（约束 C1–C10）、§2（决策 D1–D12）、§10（实施结果 + 三轮真机修复实录 + §10.8 B6 落地）。
3) 跑状态核对与门禁：
   Set-Location 'D:\workspace\Highlighter'
   Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
   git log --oneline -12 ; git status --short ; git branch --show-current
   npm test        # 期望 1012 / 1012 / 0（全新 clone 为 1001 / 1001 / 0，见 §0）
   npm run check   # 期望 304 文件 + main.js 1297/1300 + i18n 605

先做什么：计划内 T1/T2（含 B6）与**方案 2**均已开发完成，剩余按优先级是
① 工具栏宽度优化的**方案 3b**（方案 2 已落地，见 §4.1；3b 建议独立立项）
② 3.0.0 发布侧收尾（portable + verify:package + 发布记录 + tag）
③ 人眼/真机验收清单（自动化已覆盖隐藏窗探针与 e2e；剩下的只有观感手感）
④ B6 有意未做的两项（多选整体拖动、多选层级，建议与 ①② 合并评估）
**开工前先问用户做哪一个**，不要自行拍板。

硬约束（违反会直接踩坑）：
- 工作副本必须在纯 ASCII 路径（现在是 D:\workspace\Highlighter）。路径含中文会让 Electron 以 0x80000003 静默崩溃、ffmpeg 写盘被拒 —— 这是路径问题，不是机器/沙箱问题（详见交接文档 §2）。
- 任何 node/npm 命令前先 Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue。
- i18n 是硬门禁且零余量：check-i18n --max 606，当前 TOTAL 605。config/capture/record/long-capture/action/search/recognition/toolbar/pin/main 等扫描区里**新增中文注释就会破门禁** → 新注释一律英文；shared/locales/** 不在扫描范围。
- 工作区里 action/**、build/installer.nsh、test/action-*.test.js、test/design-tokens.test.js、test/window-security.test.js 及若干 untracked 文件属于**另一条工作线**，禁止修改/提交；提交只按具体路径 git add，**绝不用 git add -A**。
- 单显示器 1493×933 无副屏：AGENTS.md 要求可见测试窗放副屏，**无副屏先问用户**；npm run test:e2e 会开 app 窗口，跑之前先问。
- 本机对 GitHub release 下载不可达：打包必须用交接文档 §8.1 的命令（带 --config.electronDist=<repo>\node_modules\electron\dist）。

开发纪律：
- capture/capture.js 是单写者；新算法一律下沉到 capture/selection-utils.js 或 capture/annotation-geometry.js（在覆盖率 include 清单里），capture.js 只留接线。
- 改动 capture.js 的 pointerdown/落位/样式接线时，必须**同提交**更新契约测试（交接文档 §6 列了每个测试文件钉死什么）。
- 注意 §6 里的契约窗口是**按字符数**钉死的：往被钉住的函数加代码/注释可能挤爆窗口。
- 每个改动跑定向测试 → npm run check → 收口再跑全量 npm test；只有人眼能判断的部分，明确写"待人工验收"并给出步骤。

完成后请给出：改了哪些文件、门禁读数、哪些行为只能由用户人工验证。
```

---

## 10. 文档地图

| 文档 | 用途 |
| --- | --- |
| **本文件** | **新会话唯一入口**：状态、环境（含中文路径大坑）、代码地图、契约钉死点、坑、剩余工作 |
| `2026-10-14-capture-interaction-improvement-plan.md` | **主方案 + 实施记录**：§1 约束 · §2 决策 D1–D12 · §3 T1 任务表 · §4 T2 任务表 · §6 测试策略 · **§10 实施结果 + §10.5–10.7 三轮真机修复 + §10.8 B6 落地** |
| `2026-10-14-capture-interaction-handoff.md` | 上一版交接文档（历史）：其 §2.2 保留中文路径崩溃的完整证据链与兜底环境变量；§8 有打包/安装/安装器失败的全部记录 |
| `2026-10-14-snow-apps-toolbar-interaction-gap-analysis.md` | 上游六支柱差距分析（本方案的论证来源） |
| `2026-10-11-post-review-handoff.md` | v2.5.0 时代入口（已过期；§6.1 git 事故与 §6.5 契约纪律仍有效） |
| `2026-10-10-p0-gap-closure-plan.md` | 更早的主方案（批次 A/B/C） |
| `docs/releases/2026-10-12-v2.5.0-build-acceptance.md` | v2.5.0 构建/发布/安装记录 —— **3.0.0 的发布记录照它写** |
| `docs/plans/2026-10-11-consolidated-verification-checklist.md` | 更早的统一验收清单（含批次 A/B/C，**未含本次交互项**） |
| `.tmp/gates/`（gitignore） | 现场脚本：`minimal-electron.js`（隐藏窗冒烟）· `electron-diag.js`（命名管道/子进程诊断）· `measure-strip.js`（主行最小宽度 + 落位实测）· `measure-b6.js`（契约窗口字符量距）· `run-silent-upgrade-3.0.0.ps1` |
