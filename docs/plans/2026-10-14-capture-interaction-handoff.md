# Highlighter 交接文档：截图交互改进（T1+T2）落地与四轮真机修复（2026-10-14）

> 🚫 **本文件已被取代（2026-10-15）**：新会话请读 **`2026-10-15-capture-interaction-handoff.md`**（新入口，含工作副本已迁到 `D:\workspace\Highlighter` 的事实与最新门禁读数）。
> 本文件保留为**历史记录**，仍有两处独有价值：**§2.2** 中文路径崩溃的完整证据链与兜底环境变量、**§8** 打包/安装/安装器失败的全部记录。

> **本文件是新会话的入口。** 前一入口 `2026-10-11-post-review-handoff.md` 记录的是 **v2.5.0 时代**的状态，**其 §1 门禁读数、§5 残留表、§8 待决策已被本文件取代**（版本、测试数、i18n 读数全部变了）。更早的 `2026-10-10-p0-*.md` 属历史。
>
> 读完本文件就能接手：§0 一句话状态 → §1 提交与工作区 → §2 门禁（**含 2026-10-15 更正的"Electron 路径含中文导致启动崩溃"及其绕过办法**）→ §3 已落地 → §4 剩余工作 → §5 代码地图 → §6 契约钉死点 → §7 坑 → §9 第一批动作 → **§11 新会话开场文案（可直接复制）**。

---

## 0. 一句话状态

**方案 `2026-10-14-capture-interaction-improvement-plan.md` 的 T1（A1–A5）与 T2（B1–B7）已全部落地。B6（多选 + mixed 态）于 2026-10-15 按计划自己的缓解措施拆两波补齐（wave 1 `3effa97`：shift 加选/减选 + mixed 回显 + 批量编辑；wave 2 `d8d46ab`：shift+空白拖框选 + 每项虚线框）—— 计划内已无未开工项。此前还按三轮真机反馈修掉了钉图重新标注的工具栏缺陷（§3.3）+ 一轮小选区"过于靠左"的体验修复（方案 1）。版本已 bump 到 `3.0.0`，NSIS 安装包已构建（未签名、未安装成功——安装由用户自理）。**

> ⚠️ **2026-10-15 重要更正**：旧文档里"本机 Electron 无法启动 = 致命环境限制"**是误诊**。崩溃由仓库路径中的中文目录名 `副本` 引起，把 Electron dist 复制到 ASCII 路径并用 `ELECTRON_OVERRIDE_DIST_PATH` 指过去即可正常运行 —— 全量 `npm test` 因此达到 **1012 / 1012 / 0**，也为 B6 提供了**真 Electron 渲染层探针**（`capture-renderer-runtime` 等）的实证。详见 **§2.2**。真机**可见窗**验收仍受"单显示器无副屏、开窗前先问用户"限制。

| 项 | 值 |
| --- | --- |
| 分支 / HEAD | **`feat/capture-interaction-t1`** / **`d8d46ab`**（基于 `master` `e4ce41c`，共 13 个提交） |
| 工作区 | **不干净**：有**另一条工作线**的未提交改动（见 §1.2），**不是本分支的产物，禁止提交/修改** |
| `package.json` 版本 | **`3.0.0`**（提交 `36a89e9`；`package-lock.json` 两处同步） |
| 代码完成度 | T1 ✅ · T2 **B1/B2/B3/B4/B5/B6/B7 全部 ✅** |
| 门禁 | `npm test` **1012 / 1012 通过 / 0 失败**（按 §2.2 的两条环境变量；不设变量时是 1012 / 1000 / 12，那 12 个是"Electron 路径含中文起不来"的探针失败，**2026-10-15 已定位并可绕开**） · `npm run check` **全绿**（304 文件 · `main.js` 1297/1300 · i18n 605/606 · locale 1003×3 对称） |
| 安装包 | `dist/Highlighter-Setup-3.0.0.exe` · 144,882,056 B · SHA256 `5D2C63EEFD8F182D718D5985A8ED47EC932919700CC347568C5B3424C4D3C298` |
| ⚠️ 环境要点（已更正） | Electron **能**跑：必须从 **ASCII 路径**启动（旧文档的"起不来"是仓库中文路径所致）→ 用 §2.2 的 `ELECTRON_OVERRIDE_DIST_PATH` + 工作区 `TEMP`，`npm test` 全绿；**唯一仍不可做的是"真机可见窗"验收**（单显示器无副屏，开窗前先问用户） |
| 下一会话的上下文锚点 | 本文件 + 方案 §10（实施结果与三轮修复实录）+ 方案 §3/§4（验收清单） |

---

## 1. 分支、提交与工作区

### 1.1 本分支的 13 个提交（`git log --oneline master..HEAD`）

```
d8d46ab feat(capture): shift+drag marquee and per-item selection outlines (B6 wave 2)   ← B6 第二波
3effa97 feat(capture): shift multi-select with mixed-state toolbar echo (B6 wave 1)     ← B6 第一波
48f5801 docs(plans): hand off the capture interaction work to a new session
775f5f0 fix(capture): centre the tool strip on a small region instead of the screen edge   ← 方案 1
aa7d3a8 fix(capture): derive the reserved strip from the strip the window will show         ← 真机第 2 轮
ef8ac63 fix(capture): keep the tool strip fully visible when re-annotating a pin            ← 真机第 1 轮
36a89e9 chore(release): bump to 3.0.0
87ded5b fix(capture): step the wheel from the displayed width, not the legacy mirror
5944ba1 docs(plans): record what T1 and T2 actually landed
c0887be feat(capture): remember one style per tool and persist it (B4)
f6dae10 feat(capture): continue a pen stroke from either endpoint (B7)
27e4499 feat(capture): second toolbar row with shape/line/opacity options (B1-B3, B5)
0b90609 feat(capture): land T1 of the capture interaction plan (A1-A5)
```

### 1.2 ⚠️ 工作区里的**其它工作线**改动（**不要动、不要提交**）

`git status --short` 会看到这些；它们属于并行进行的另一条工作线（选择助手 action 窗 / 表格渲染 / 安装器低完整性检测）：

```
 M action/action.css  action/action.html  action/action.js
 M build/installer.nsh                      ← 注意：见 §8.3，它会被打进安装包
 M test/action-security-runtime.test.js  test/design-tokens.test.js  test/window-security.test.js
?? action/markdown.js  scripts/probe-action-table.js  test/action-table-runtime.test.js  test/markdown-render.test.js
?? docs/plans/2026-10-12-low-integrity-installer-brief.md  docs/plans/2026-10-14-answer-table-rendering-design.md
?? .codegraph/
```

**纪律**：本分支的提交一律**按路径 `git add <具体文件>`**，从不用 `git add -A`；上一份交接文档 §6.1 记录过一次并行 `git reset --hard` 清空两个流工作的事故，别重演。

---

## 2. 门禁读数与运行环境

### 2.1 读数（**2026-10-15：工作副本已迁到纯 ASCII 路径 `D:\workspace\Highlighter`，全部门禁在默认环境下实测通过**）

| 门禁 | 命令 | 读数（2026-10-15，新路径，**除 `ELECTRON_RUN_AS_NODE` 外无需任何环境变量**） |
| --- | --- | --- |
| 单元/契约测试 | `npm test` | **1012 用例 / 1012 通过 / 0 失败** |
| 语法+架构+i18n | `npm run check` | 语法 **304 文件** · `main.js` **1297 / 1300** · i18n **605 ≤ 606** · locale **1003×3 对称** |
| 覆盖率（loaded） | `npm run test:coverage:loaded` | **行 92.9%**（11649/12539，门槛 ≥85 通过）；分支 80.13% / 函数 90.86% |
| 覆盖率（critical） | `npm run test:coverage:critical` | `diagnostics-service.js` **93.22** · `update-service.js` **94.07** · `window-security.js` **92.42**（与方案 §1.1 记录值**逐字相同**） |
| Playwright e2e | `npm run test:e2e` | **6 / 6 通过**（34.1s；已获用户同意后执行，会短暂开 app 窗口） |
| 依赖审计 | `npm run audit:dependencies` | **18 个失效豁免项 → exit 1**（**既有状态**：本分支 `package.json`/`package-lock.json` 零依赖改动） |

> 旧路径 `D:\workspace\Highlighter - 副本`（含中文）下的读数曾是 1012 / 1000 / 12，那 12 个失败**全部**由该路径导致（Electron 起不来 + ffmpeg 写盘被拒），不是代码缺陷 —— 见 §2.2。该旧目录作为快照保留，HEAD 停在 `1e349f8`。

**所有 node/npm 命令前先清环境变量**，否则 Electron 会被当 Node 跑、成片失败：

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
```

### 2.2 ✅ 更正（2026-10-15）：旧文档的"致命环境限制"是**路径问题**，已通过迁移解决

> 2026-10-14 的结论"本机 Electron 启动即崩、无法修复"**不成立**。当时的观测（退出码 `0x80000003`）是真的，但归因错了：**崩溃由工作副本路径里的中文目录名 `副本` 触发**，与机器、显卡、沙箱、安全软件都无关。

**当前状态（已根治）**：工作副本迁到 **`D:\workspace\Highlighter`**（纯 ASCII）后，Electron 直接可跑、全部门禁在默认环境全绿：

| 验证（新路径，无 override） | 结果 |
| --- | --- |
| `node_modules\electron\dist\electron.exe --version` | **exit 0，`v43.2.0`** |
| `npm test`（默认 `%TEMP%`，只清 `ELECTRON_RUN_AS_NODE`） | **1012 / 1012 / 0** |
| `npm run check` | 全绿（304 文件 · 1297/1300 · i18n 605） |
| `npm run test:e2e` | **6 / 6** |

**证据链（定位过程，2026-10-15 实测）**：

| 试验 | 结果 |
| --- | --- |
| `electron.exe --version`（旧 CJK 路径） | **exit `0x80000003`（STATUS_BREAKPOINT），零输出** |
| 同一份 dist 复制到 `%LOCALAPPDATA%\Temp\edist-ascii\` 后 `--version` | **exit 0，输出 `v43.2.0`** |
| ASCII dist + `.tmp/gates/minimal-electron.js` | **exit 0**：`app ready; displays = 1`（隐藏窗冒烟，无可见窗） |
| 命名管道创建 + Node `spawnSync` 管道 stdio 探测 | 都 **OK** → 排除"DSH 沙箱禁命名管道"这条猜测 |
| `dist\win-unpacked\Highlighter.exe --version`（CJK）vs 复制到 ASCII 后 | 同样 `0x80000003` vs **exit 0** → **打包产物放在 CJK 路径下也一样起不来** |
| `ffmpeg-static\ffmpeg.exe` 写 `%TEMP%`（旧 CJK 路径下调用） | **EACCES / status -13**；换成新 ASCII 路径后 `recording-preview-runtime` 用默认 `%TEMP%` 直接通过 |

**结论**：工作副本路径含非 ASCII 字符时，**原生二进制（Electron / ffmpeg-static）都会出问题** —— Electron 在启动早期从**可执行文件所在目录**读 `icudtl.dat` / `snapshot_blob.bin` / `resources.pak`，路径解析失败 → 早期 fatal CHECK → `__debugbreak`（= `0x80000003`，所以既没有 stdout 也没有 WER 记录）。**根治办法就是把工作副本放在纯 ASCII 路径**。

**兜底（万一又要在 CJK 路径下工作，才需要这两条环境变量）**：

```powershell
# ① 把 Electron dist 复制到 ASCII 路径，并用 electron npm 包认的变量指过去
$edist = Join-Path $env:LOCALAPPDATA 'Temp\edist-ascii'
if (-not (Test-Path $edist)) {
  New-Item -ItemType Directory -Path $edist | Out-Null
  Copy-Item (Join-Path (Get-Location).Path 'node_modules\electron\dist\*') -Destination $edist -Recurse -Force
}
# ② TEMP 挪进工作区（CJK 路径下 ffmpeg 连写 %TEMP% 都会被拒）
$wsTemp = Join-Path (Get-Location).Path '.tmp\test-temp'
New-Item -ItemType Directory -Force -Path $wsTemp | Out-Null

Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:ELECTRON_OVERRIDE_DIST_PATH = $edist      # node_modules/electron/index.js:30
$env:TEMP = $wsTemp; $env:TMP = $wsTemp
npm test                                       # → 1012 / 1012 / 0
```

**遗留注意事项**：
1. **`dist\win-unpacked\` 现在也在 ASCII 路径下** → `npm run verify:package` 的启动探针**不再必然失败**（仍未跑，见 §4.4）。
2. **真机可见窗验收仍受另一条约束限制**：本机只有 **单显示器 1493×933（无副屏）**，`AGENTS.md` 要求可见测试窗放副屏、**无副屏先问用户**；`npm run test:e2e` 会开 app 窗口，**跑之前先问**（2026-10-15 已问过并得到同意）。

### 2.3 其它环境事实

| 项 | 值 |
| --- | --- |
| 平台 / shell | Windows + `pwsh`（PowerShell 7.6） |
| **工作副本（新）** | **`D:\workspace\Highlighter`**（纯 ASCII —— **必须用它**，Electron/ffmpeg 才不会崩） |
| 旧副本（快照） | `D:\workspace\Highlighter - 副本`（含中文，HEAD `1e349f8`；只作备份，不要在其中跑 Electron/测试） |
| Node / Electron | node v24.15+ · Electron 43.2.0 |
| 显示器 | 单屏 `1493×933 @0,0`（**无副屏**） |
| 打包缓存 | `%LOCALAPPDATA%\electron-builder\Cache` 已有 `nsis-3.0.4.1` / `nsis-resources-3.4.1` / `7zip` / `icons` |
| 原生件 | `native/smart-select/SmartSelect.exe`、`native/ocr/HighlighterOcrSidecar.exe`、`native/everything-search/bin`、`native/everything/Everything.exe`、`ocr/models` **全部在位**（打包无需重编） |

---

## 3. 本会话已落地的内容

### 3.1 T1（A1–A5，提交 `0b90609`）

| 项 | 交付 |
| --- | --- |
| A1 | pointerdown 顶部 `event.button` 门（右键=快选+拖动、中键吞掉）+ `contextmenu` preventDefault；`movingAnnotation` → **`pendingMove`**（`thresholdPassed` + `MOVE_THRESHOLD=3` + `movedBeyondThreshold`）；`#elementBar` 提示补右键语义（三语） |
| A2 | `nextWidthPreset`（两端钳制）+ 滚轮步进（**起点 = `displayedToolWidth()`**：选中项优先，否则当前工具记忆）+ 活动笔迹实时跟随 + 500ms 尾随去抖持久化 |
| A3 | 主行色块按钮 + `#colorPalette` 弹出面板（7 预设 + 自定义取色器 + ≤3 最近色，会话内存）；`screenshot.annotationColor` 持久化（复用 `settings:update`，**零新增 IPC**）；`normalizeAnnotationColor` 两端归一；顺带拆开 hover/active 共用样式 |
| A4 | `syncToolbarStyleFromSelection`（**仅 UI**，绝不压帧）+ `applyToolbarColor/Width`；接入 `setSelectedAnnotation`/`syncSelectedAnnotation`/`deleteSelectedAnnotation`/`clearAnnotationsForNewSelection` |
| A5 | select 工具下"选区外元素命中"前移到"重划选区"之前（`!resizeHandle` 守卫保手柄优先），命中即选中 + `beginPendingMove` |

### 3.2 T2（B1/B2/B3/B4/B5/B7，提交 `27e4499` `f6dae10` `c0887be` `87ded5b`）

| 项 | 交付 |
| --- | --- |
| B1 | `#toolbar` 转 column 容器 + `.toolbar-row` + `#toolOptions`；**`invalidateToolbarSize()` 唯一失效点**；落位走一个纯函数 + `.above` 行序翻转 |
| B2 | rect/ellipse 填充（none/translucent .28/solid）、线型（solid/dashed/dotted）、rect 圆角（roundRect）；**实心形状命中升级为"环带 ∪ 内部"** |
| B3 | `drawArrow(startHead, endHead)`（缺省=只画终点）+ line/arrow 杆接虚线 |
| B4 | `screenshot.annotationStyles`（**8 工具模板 = settings:update 校验白名单**）+ `resolveToolStyle/resolveToolStyles` 字段级归一 + 旧键一次性迁移 + **整表合并写盘** + 工具栏编辑目标切到 per-tool（`toolbarStyleTool()`） |
| B5 | 高亮浓度 light/medium/strong（.18/.28/.45，medium 为原值）+ 文字 `bold` |
| B7 | `penContinuationTarget`（仅最上层笔迹、任一端点、容差 `MAX(width,12)`）+ 续写=一帧 + `pointercancel` 还原 |

### 3.3 四轮真机反馈与修复（方案 §10.5–§10.7 有实录）

| 轮次 | 现象 | 根因 | 修复 |
| --- | --- | --- | --- |
| 1 | 钉图→右键重新标注：工具栏出现在**截图内侧顶部且右侧被截断** | ① 普通重标注路径**没预留**图像下方条带（只有 OCR/翻译预留 62px）；② 落位兜底 `Math.max(6,…)` 把它夹到视图 `(6,6)` | 落位下沉为纯函数 `resolveFloatingPlacement`（下→上→**内侧贴底**，绝不再夹顶部）+ `flex-wrap` 防裁 + 主进程**所有重标注路径统一预留条带** |
| 2 | 通过，但**点矩形工具后工具栏整体上移盖住图片** | `flex-wrap` 让主行在 900px 窗口里**折成两行**（主行单行最小宽度实测 **937px**），工具栏 44→112px 超出预留 100px → 触发内侧停靠 | 条带高度改为**按窗口宽度推导**（`stripRows = ceil(ROW_MIN_CONTENT/(width-STRIP_CHROME))`），`toolbarSpace` 提到 **1088** 让主行保持单行；新增**"从 HTML/CSS 现算主行最小宽度"的不变量测试** |
| 3 | 通过 | — | — |
| 4 | 小选区时工具栏**过于靠左** | 工具条元素宽 **951px**（占本机 1493 的 64%）；右对齐装不下就夹到 `left=6`，工具组离选区最远 ~600px（旧代码同公式，属既有体验缺陷） | **方案 1**：右对齐装得下**逐字不变**，装不下改为**居中到选区中心**（`clamp(中心 − 宽/2)`）；实测 600..800 档 `left 6 → 225`、中心距 219px → **1px** |

---

## 4. 剩余工作（按建议优先级）

### 4.1 B6：多选 + mixed 态（**已于 2026-10-15 开发完成**）

- 依据：方案 §4 **B6** + §2 决策 **D8**；**实施结果见方案 §10.8**（含每个波次改了哪些文件、契约测试同步点、门禁读数）。
- 提交：**`3effa97`（wave 1：shift 加选/减选 + mixed 回显 + 批量编辑）** → **`d8d46ab`（wave 2：shift+空白拖框选 + 每项虚线框）**。
- 关键取舍：`selectedIds: Set` 是权威集合，`selectedAnnotation` 退化为 anchor，因此既有 15 个 `selectedAnnotationItem()` 调用点**一行不改**，单选中行为与 B6 之前逐字等价。
- **明确未做**（不是遗漏，见方案 §10.8 末尾）：① 多选**整体拖动**（`pendingMove` 形态被契约测试钉死为唯一创建点 + 精确字段，扩形态的回归风险高于收益；当前是"拖动命中的那一项，其余保持选中"）；② 层级 ↑↓ 在多选下仍只作用于 anchor。两项都建议与 §4.2 的方案 2/3b 一起评估。
- **仍待真机验收**：shift 加选/减选（含右键只加）、mixed 三态、批量改色/宽/选项各一帧且 Ctrl+Z 一步回退、批量 Delete、多选方向键、框选加选、框选阈值内 shift 点击不清空选中、框选 pointercancel。

### 4.2 工具栏宽度优化：方案 2 / 方案 3b（用户已看过方案，只选了方案 1）

- **方案 2（体验向）**：渲染层给 `#toolbar` 设动态 `max-width = min(视口−20, max(420, 选区宽+160))`，窄选区自动折行成紧凑块、紧贴选区。**必须协同**：钉图编辑器的条带是按"单行条带"推导的，折行后变高 → 要么在 `initData.imageBounds` 时跳过本方案，要么把折行算进 §10.6 的条带推导；另需在选区尺寸变化时失效 `toolbarSize`。
- **方案 3b（根治）**：把 11 个识别/导出动作（≈370px）收进「··· 更多」溢出面板 → 主行 ≈ **566px**（38%），此后小选区也能右对齐/居中且工具就在手边；同时可把钉图编辑器 `toolbarSpace` 从 1088 降下来（更少透明带）。**代价**：`test/capture-toolbar-icons.test.js` 是**精确图标序列 deepEqual**，加/移图标必须同提交更新；i18n 新键三语；肌肉记忆改变。**建议独立立项**。
- 方案 1 的剩余局限：选区落在屏幕左侧约 2/3 以内且居中仍算负值时（如 100..300）只能贴左 —— 需要方案 2/3b 才能继续改善。

### 4.3 真机功能验收（**人眼验证：需用户配合，或先征得同意再开可见窗**）

> 2026-10-15 更正：**隐藏窗的真 Electron 探针已经能跑并且全绿**（§2.2），所以这一节现在只剩"人眼交互验收"。区分：自动化跑得到的（渲染层探针）已覆盖；只有"观感/手感"类需要人看。

已完成（用户口述/复测）：钉图重新标注工具栏位置（3 轮）、小选区落位（第 4 轮）。
**仍未经人眼确认**：右键快选拖动与 <3px 点击阈值 · 中键无效果 · 滚轮调宽（含绘制中实时生效与去抖落盘）· 色板弹出/点外关闭/自定义色跨会话 · 选中回显（含 undo/redo 后同步、Esc 恢复）· 选区外元素再选 · 第二行各行控件（填充/线型/圆角/箭头端点/浓度/粗体）· **per-tool 记忆跨重启** · 画笔端点续画（含中断还原）· **B6 全部交互项**（shift 加选/减选、shift+右键只加、mixed 三态、批量改色/宽/选项一帧、批量 Delete、多选方向键、框选加选、框选阈值内 shift 点击不清空、框选 pointercancel）。
> 验收条目见方案 §3/§4 各项"验收"行；`docs/plans/2026-10-11-consolidated-verification-checklist.md` 是更早的统一清单（含批次 A/B/C，**未含本次交互项**）。

### 4.4 发布/构建侧欠账

| 项 | 状态 |
| --- | --- |
| portable 安装包 | **未构建**（只构建了 NSIS setup） |
| `npm run verify:package` | **未跑**（它要求 nsis + portable + 启动探针）。⚠️ 2026-10-15：启动探针**不再是必然失败** —— 但 `dist\win-unpacked\Highlighter.exe` 位于含中文的仓库路径下、直接启动会 `0x80000003`（§2.2 已证），所以跑它之前要先把打包产物复制到 ASCII 路径（或把仓库挪到 ASCII 路径） |
| `dist/SHA256SUMS.txt` | **陈旧**（仍是 2026-10-12 的旧清单）；本次产物哈希见 §8 |
| 签名 | 未签名（`--config.forceCodeSigning=false --config.win.signExecutable=false`） |
| `docs/releases/` 3.0.0 发布记录 | **未写**（建议补一份，格式照 `docs/releases/2026-10-12-v2.5.0-build-acceptance.md`） |
| 静默安装 | **本机实测失败**（§8.4），需要用户在交互模式复现并看提示 |

---

## 5. 代码地图（改哪儿先看这里）

### 5.1 纯函数模块（**受覆盖率门禁覆盖**，新算法一律下沉到这里）

| 文件 | 关键导出 |
| --- | --- |
| `capture/selection-utils.js` | `getResizeHandle` · `getSourcePixelRect` · `resizeSelection` · `selectionCursor` · **`resolveFloatingPlacement`（工具栏/元素条唯一落位规则）** · **`revalidateSelection` / `commonSelectionValue` / `rectsIntersect`（B6 多选：按 id 存活 / mixed 判定 / 框选相交）** |
| `capture/annotation-geometry.js` | `annotationBounds` · `hitTestAnnotation`（含 B2 实心内部命中）· `findAnnotationAt` · `MOVE_THRESHOLD` + `movedBeyondThreshold` · **`penContinuationTarget`** · `translateAnnotation` · `resizeAnnotationToBox` · `reorderAnnotation` · `clampAnnotationToStage` · `cloneAnnotations` |
| `capture/annotation-style.js` | `WIDTH_PRESETS/WIDTHS/resolveWidth` · `PRESET_COLORS/normalizeAnnotationColor` · `nextWidthPreset` · `FILL/DASH/RADIUS/ALPHA_PRESETS` + `resolveFill/resolveDash/resolveRadius/resolveAlpha/dashPattern` · `TOOL_OPTION_FIELDS/DEFAULT_TOOL_OPTIONS/resolveToolOptions` · `TOOL_STYLE_TOOLS/TOOL_DEFAULT_COLORS/resolveToolStyle/resolveToolStyles` |

> ⚠️ `capture/annotation-style.js` **不在** `test:coverage:loaded` 的 include 清单里（`package.json:14` 只含 `selection-utils.js` 与 `annotation-geometry.js`）；要进覆盖率门槛就得改 include 清单。

### 5.2 `capture/capture.js`（单写者，最易踩契约）

- 落位：**`toolbarPlacement()`**（唯一来源，`updateFloatingUi` 定工具栏位置、`updateElementBar` 读它做避让）· `invalidateToolbarSize()`
- 工具栏画：`applyToolbarWidth/Color` · `syncToolbarStyleFromSelection()`（A4 回显，**只改 UI**）· `syncSelectedAnnotation()`
- 选项行：`TOOL_OPTION_GROUPS` / `toolOptionGroups()` / `optionRowTool()` / `rowToolOptions()` / `syncToolOptionControls()` / **`syncToolOptionsRow()`** / `setAnnotationOption()`
- 样式记忆：`toolStyles` · `writeToolStyle()` · `annotationStylesPayload()` · `persistToolStyles()` · **`toolbarStyleTool()`** · `currentToolStyle()` · `applyAnnotationStyles(settings)`（**init + 旧键一次性迁移**）· `setAnnotationColor/Width` · `scheduleAnnotationWidthPersist()`
- 拖动/阈值：`beginPendingMove()` · `moveAnnotationTo()` · `finishMoveAnnotation()` · `cancelMoveAnnotation()` · `quickSelectAnnotation()`（**右键**）
- 画笔续写：`beginPenContinuation()` · `restoreContinuedPen()`
- 绘制：`drawAnnotation()`（唯一绘制入口，屏幕与导出同源）· `drawArrow()`

### 5.3 设置与主进程

| 文件 | 内容 |
| --- | --- |
| `main/services/settings-defaults.js` | `screenshot.annotationColor`、**`screenshot.annotationStyles`（8 工具模板 = 校验白名单，字段增删必须改这里）** |
| `main/services/settings-normalize.js` | `annotationColor` 的 `#rrggbb` 归一（`annotationStyles` 由渲染端 `resolveToolStyle` 归一） |
| `preload-capture.js` | `saveAnnotationColor` / **`saveAnnotationStyles`** / `saveAnnotationWidth`（全部走既有 `settings:update`，**零新增 IPC 通道**） |
| `main/domains/pin/index.js` | `startPinReannotation`：**所有重新标注路径**统一预留图像下方条带，`ROW_MIN_CONTENT=1040` / `STRIP_ROW_HEIGHT=34` / `OPTIONS_ROW_HEIGHT=30` / `STRIP_CHROME=14` / `STRIP_SLACK=22` / `toolbarSpace=1088` |
| `shared/locales/capture.js` | A3 色板 10 键 + B2/B3/B5 选项 21 键（三语），`capture.element.move-hint*` 文案已改（右键拖动） |

---

## 6. 契约测试钉死点（**改动必同提交更新，方案 C6 纪律**）

| 测试文件 | 钉什么 |
| --- | --- |
| `test/capture-annotation-geometry.test.js` | pointerdown **分支顺序**（选区手柄 > 选中元素手柄 > 体内 > 命中；A5 的"选区外命中"在前，断言对准 `const hit=findAnnotationAt(annotations,point)` 那一处）· `pendingMove` **只有一个创建点** · `annotationStyle()` 形态 · `setAnnotationWidth` 形态 · elementBar 结构与可见条件 · 导出/绘制顺序 |
| `test/capture-annotation-width.test.js` | 三个宽度档位契约 · `annotationStyle()` · init 走 `applyAnnotationStyles(data.settings)` · 旧键 `saveAnnotationWidth` 仍写 |
| `test/capture-interaction.test.js` | A1 按键门位置/右键快选形态（绝不 `activeAnnotation`/绝不重划选区）· A2 滚轮起点 `displayedToolWidth()` · A4 回显"只改 UI" · A5 选区外命中顺序 |
| `test/capture-tool-options.test.js` | B1 结构（`.toolbar-row` / `#toolOptions` / `flex-wrap` / `.above`）· `invalidateToolbarSize()` **唯一写点 + 2 个调用点** · 六个选项组与 owner 列表 · 绘制分支与"缺省逐字节不变" |
| `test/capture-floating-placement.test.js` | 落位规则**两个分支都必须留在源码**· 右对齐装得下逐字不变 · 居中兜底 · 内侧贴底（不夹顶部）· **从 HTML/CSS 现算主行最小宽度**并断言 `ROW_MIN_CONTENT`/`toolbarSpace` 容得下 · 钉图编辑器不再有 `isRecognitionEditor` 分支 |
| `test/capture-tool-styles.test.js` | 模板 ≡ `resolveToolStyles()` 规范表 · **整表一次写盘**（`saveAnnotationStyles` 只有一个调用点）· `toolbarStyleTool()` · 迁移铺底 · 旧键双写 |
| `test/capture-pen-continuation.test.js` | 纯函数 + 抬起/还原/一帧语义 |
| `test/capture-color-palette.test.js` | 色板 DOM/CSS/接线 · recents ≤3 · `PRESET_COLORS.` 只出现在最近色过滤（**capture 端无颜色白名单**） |
| `test/capture-i18n.test.js` | **GOLDEN 表**：每个 `capture.*` 键的 zh-CN 文案逐字 + "表里的键必须都被用到"。**新增/改文案必须同步 GOLDEN**，否则双向清单红 |
| `test/capture-selection-resize.test.js` | `window.selectionUtils` 的**解构清单**（加一个导出就要改这里） |
| `test/capture-ocr-pin-ui.test.js` | 钉图编辑器条带推导与 `transparent: true` · OCR 结果条定位公式 |
| `test/capture-toolbar-icons.test.js` | **精确图标序列 deepEqual**（加/移工具栏图标必须同 PR 更新） |
| `test/settings-validation.test.js` / `settings-normalize.test.js` | 两个新键的类型契约与归一 |
| `test/capture-multi-select.test.js` | **B6（D8）：`selectedIds` 权威集合 + anchor 退化 · `revalidateSelection`/`commonSelectionValue`/`rectsIntersect` 纯函数 · shift 四个落点 · mixed 回显 · 批量编辑仍一帧 · Delete/方向键覆盖整集 · elementBar 计数与 `elementBarSize` 唯一失效点 · marquee 只增不减与三处收口 · 每项虚线框但手柄只在 anchor** |

---

## 7. 坑（每条都真实踩过）

### 7.1 🔴 i18n **零余量**：`capture/**`、`main/**` 等新增中文注释会直接破门禁

`node scripts/check-i18n.js` 统计**含 CJK 的行数**（含中文注释），门禁 `--max 606`，当前 **TOTAL 605**（`capture` 222 / `config` 82 / `main` 281 + 169 条 throw 另计 / `action` 8 / `toolbar` 5 / `record` 4 / `long-capture` 3 / `search`/`recognition`/`pin` 0）。
→ **扫描区（config, capture, record, long-capture, action, search, recognition, toolbar, pin, main）里新写的注释一律英文**；`shared/locales/**` 不在扫描范围内（CJK 文案随便写）。
→ 本轮就出现过一次"加了 3 行中文注释 → 607 超限"，靠把这 2 行改英文 + 复用已有中文行才压回 605。

### 7.2 Electron 起不来 = **误诊**，真正原因是路径含中文（§2.2）

`0x80000003` 不代表"环境不支持 Electron"，而是**可执行文件所在目录名含非 ASCII 字符**（本仓库是 `副本`）时早期 CHECK 失败。判断"是不是我改坏了"的正规做法现在是：**按 §2.2 设好 `ELECTRON_OVERRIDE_DIST_PATH` + 工作区 `TEMP` 跑全量 `npm test`，期望 1012 / 1012 / 0**。旧的"与 `$env:TEMP\hl-baseline-test.log` 失败集合逐字相同"标准只在无法使用 ASCII dist 时作为退路。

### 7.3 `ELECTRON_RUN_AS_NODE`

本机环境里这个变量被设成 `1`。**不删它，`electron` 会当 node 跑**（所有探针/`npm test` 的 Electron 用例成片失败，报错形态是 `Cannot read properties of undefined (reading 'setPath')` 或直接 `2147483651`）。所有命令前先 `Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue`。

### 7.4 PowerShell 引号地狱

- **不要用 `node -e "…正则含引号…"`**：本会话被 PowerShell 转义坑过一次，改成**写临时 `.js` 文件**再 `node <文件>`（`.tmp/gates/measure-strip.js` 就是这么来的）。
- 给原生程序传**含空格的参数**（仓库路径就含空格）时，把整个 `--config.electronDist=<路径>` **作为一个带引号的字符串**传，别用 `key="值"` 形式。

### 7.5 CRLF / 换行

仓库 `core.autocrlf=true` 无 `.gitattributes`：`write` 写出的文件是 LF、`edit` 过的是 CRLF，提交时归一（`LF will be replaced by CRLF` 警告正常）。编辑跨行断言时用 `[^\r\n]*` 或 `[\s\S]`，不要用 `[^\n]*\n`；`edit` 的 `old_string` 跨行匹配失败时改用单行替换。

### 7.6 构建必须绕开 GitHub

`electron-builder` 直接打包会在 `packaging` 阶段 `connect ETIMEDOUT 20.205.243.166:443`（本机对 GitHub release 下载不可达；`Invoke-WebRequest https://github.com` 却能 200，别被误导）。必须用本地 Electron 分发（见 §8.1）。

---

## 8. 版本、安装包与安装

### 8.1 构建命令（**唯一可行的一条**）

```powershell
cd 'D:\workspace\Highlighter'          # 2026-10-15 起的新工作副本（纯 ASCII；旧的中文路径不要用）
$electronDist = (Join-Path (Get-Location).Path 'node_modules\electron\dist')
node node_modules/electron-builder/cli.js --config electron-builder.release.cjs --win nsis --x64 `
  --publish never --config.forceCodeSigning=false --config.win.signExecutable=false `
  "--config.electronDist=$electronDist"
```

- 用 `node <cli.js>` 而不是 `npx`（少一层 cmd shim，避开路径空格引号问题）。
- `electron-builder.release.cjs` 里 `forceCodeSigning: true`，所以必须用 CLI 覆盖成 false；`asar: true` + `main: main/packaged-entry.js` + fuses。
- `npm run build:win` 会先跑 `prebuild:win → build:native`（要 MSVC）；**原生件已就位，不需要**，直接调 electron-builder。
- 只打 `--win nsis`；**portable 未构建**。

### 8.2 产物（HEAD `775f5f0`，2026-10-14 19:25:31）

| 项 | 值 |
| --- | --- |
| 文件 | `dist/Highlighter-Setup-3.0.0.exe` |
| 大小 | **144,882,056 B** |
| SHA-256 | `5D2C63EEFD8F182D718D5985A8ED47EC932919700CC347568C5B3424C4D3C298` |
| 版本元数据 | FileVersion / ProductVersion **3.0.0**（`dist/win-unpacked/Highlighter.exe` 同） |
| 完整性 | `node scripts/verify-electron-fuses.js dist\win-unpacked\Highlighter.exe` → **8/8 通过** |
| 其它 | `dist/Highlighter-Setup-3.0.0.exe.blockmap`、`dist/latest.yml`（version 3.0.0）；**未签名** |
| 复核 | `app.asar` 内已确认含 `resolveFloatingPlacement` / `const stripRows = …` / `toolbarSpace = 1088` 等本次修复 |

### 8.3 ⚠️ 安装包里含**未提交**的 `build/installer.nsh`

该文件有另一条工作线的未提交改动（"低完整性启动检测器"）：非静默安装时会弹框说明"安装器以受限（低完整性）权限运行，无法写入安装目录"。**它只有交互模式才说话**，静默模式下按设计保持安静 —— 这正是 §8.4 失败时看不到任何提示的原因。

### 8.4 安装：**本机未安装成功**（用户自理）

- 我实测的静默安装（`cmd /c "<setup>" /S /D=D:\Program Files\Highlighter`，脚本 `.tmp/gates/run-silent-upgrade-3.0.0.ps1`）**进程跑了 ~78 秒后自行退出，什么都没改**：`D:\Program Files\Highlighter` 仍 22 个文件、`Highlighter.exe` 仍 2.5.0、卸载注册项 `UninstallString` 原封不动（说明连 `customInit` 都没跑到）。
- 已排除：应用在运行（进程 0）、目录权限（`Users` 是 FullControl，我直接写文件成功）、`ELECTRON_RUN_AS_NODE`（只影响 electron 命令行，不影响 setup.exe）。
- 历史线索：上一份交接文档记录过本机安装器曾被安全软件**放进低完整性沙盒**（`%LOCALAPPDATA%\Temp\Low\nsg4A05.tmp\ccar.out`，2026-10-12 的痕迹）→ 低完整性进程**不能写 `D:\Program Files`**（强制完整性控制 no-write-up）。
- **当前状态：本机安装的仍是 `Highlighter 2.5.0`**（`D:\Program Files\Highlighter`，HKCU 卸载项 `513c5e9d-…`）。安装 3.0.0 请**交互双击**、必要时**以管理员身份运行**或把安装包加入安全软件信任区；装完可看卸载项 `DisplayVersion` 是否变 3.0.0。

---

## 9. 新会话建议的第一批动作

```powershell
# 1) 确认状态：HEAD 应为 d8d46ab 或其后继；工作区会有 §1.2 的一堆"别人的"改动（正常）
git log --oneline -12
git status --short
git branch --show-current          # feat/capture-interaction-t1

# 2) 复跑门禁 —— **先按 §2.2 把 Electron dist 指到 ASCII 路径 + TEMP 挪进工作区**
#    （否则本机会出现 12 个"Electron 起不来"的假失败）
$edist = Join-Path $env:LOCALAPPDATA 'Temp\edist-ascii'
if (-not (Test-Path $edist)) { New-Item -ItemType Directory -Path $edist | Out-Null; Copy-Item (Join-Path (Get-Location).Path 'node_modules\electron\dist\*') -Destination $edist -Recurse -Force }
$wsTemp = Join-Path (Get-Location).Path '.tmp\test-temp'; New-Item -ItemType Directory -Force -Path $wsTemp | Out-Null
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:ELECTRON_OVERRIDE_DIST_PATH = $edist
$env:TEMP = $wsTemp; $env:TMP = $wsTemp
npm test                           # 期望 1012 用例 / 1012 通过 / 0 失败
npm run check                      # 期望 304 文件 + main.js 1297/1300 + i18n 605

# 3) 若仍有失败，先判断是不是"Electron 路径/临时目录"这类环境问题（§2.2），再怀疑代码
```

4. 读方案 §10（实施结果 + 三轮修复实录 + §10.8 B6）+ 本文件 §4。
5. **先问用户下一件事做哪个**：方案 2 或 3b（工具栏宽度优化）／补真机验收清单 ／ 3.0.0 发布记录与 portable+`verify:package` ／ B6 剩余两项（多选整体拖动、多选层级）。
6. 需要**真机可见窗**验收或跑 `npm run test:e2e` 之前，先问用户（单显示器无副屏，`AGENTS.md` 要求）。
7. **不要**在没被要求时重新打包、不要动 §1.2 的他人改动、不要在扫描区写中文注释。

---

## 10. 文档地图

| 文档 | 用途 |
| --- | --- |
| **本文件** | **新会话入口**：状态、剩余工作、代码地图、契约点、坑 |
| `2026-10-14-capture-interaction-improvement-plan.md` | **本次主方案**：§0 摘要 · §1 约束（C1–C10）· §2 决策 D1–D12 · §3 T1 任务表 · §4 T2 任务表 · §6 测试策略 · **§10 实施结果 + §10.5/10.6/10.7 三轮真机修复实录** |
| `2026-10-14-snow-apps-toolbar-interaction-gap-analysis.md` | 上游六支柱差距分析（本方案的论证来源，未重复论证） |
| `2026-10-11-post-review-handoff.md` | **v2.5.0 时代的入口**（已过期；§1/§5/§8 被本文件取代，其余坑仍有效，尤其 §6.1 git 事故与 §6.5 契约纪律） |
| `2026-10-10-p0-gap-closure-plan.md` | 更早的主方案（批次 A/B/C），§20.3 有本方案 A5 对应的遗留短板出处 |
| `docs/releases/2026-10-12-v2.5.0-build-acceptance.md` | v2.5.0 构建/发布/安装记录 —— **3.0.0 的发布记录建议照它写** |
| `.tmp/gates/`（gitignore，可直接复用） | `measure-strip.js`（主行最小宽度 + 落位实测）· `minimal-electron.js`（Electron 崩溃复现）· `run-silent-upgrade-3.0.0.ps1`（静默安装尝试） |

---

## 11. 新会话开场文案（**直接复制给接手模型**）

```text
接手 Highlighter（Electron 截图/标注工具）的截图交互改进工作。工作副本：D:\workspace\Highlighter（**纯 ASCII 路径，必须用它**；旧的中文路径 D:\workspace\Highlighter - 副本 只作快照），分支 feat/capture-interaction-t1（HEAD 1e349f8 或其后继，版本 3.0.0）。

第一步（按顺序）：
1) 读交接文档 docs/plans/2026-10-14-capture-interaction-handoff.md（全文，含代码地图/契约钉死点/坑）。
2) 读方案 docs/plans/2026-10-14-capture-interaction-improvement-plan.md 的 §1（约束）、§2（决策 D1–D12）、§10（实施结果与三轮真机修复实录 + §10.8 B6 落地）。
3) 跑状态核对：git log --oneline -12 / git status --short / git branch --show-current。

先做什么：交接文档 §4 列了剩余工作（计划内的 T1/T2 含 B6 已全部开发完成），按优先级是 ① 工具栏宽度优化方案 2 或 3b ② 补真机功能验收清单 ③ 3.0.0 的 portable+verify:package+发布记录 ④ B6 剩余两项（多选整体拖动 / 多选层级，建议与 ①② 合并评估）。**开工前先问用户做哪一个**，不要自行拍板。

硬约束（违反会直接踩坑）：
- **工作副本必须在纯 ASCII 路径**（现在是 D:\workspace\Highlighter）。路径含中文会让原生二进制崩：Electron 启动早期以 0x80000003（STATUS_BREAKPOINT）静默死掉、ffmpeg-static 连写 %TEMP% 都被拒 —— 这是路径问题，不是机器/沙箱问题（详见交接文档 §2.2）。在 ASCII 路径下什么都不用设，`npm test` 即 **1012 / 1012 / 0**、`npm run check` 全绿、`npm run test:e2e` 6/6。**不要**再用"探针失败是环境性的"来给自己开脱。真机**可见窗**验收仍要问用户（单显示器无副屏；`npm run test:e2e` 会开 app 窗口）。
- 任何 node/npm 命令前先 Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue。
- i18n 是硬门禁且零余量：npm run check 的 check-i18n --max 606，当前 TOTAL 605。capture/**、main/**、config/** 等扫描区里**新增中文注释就会破门禁** → 新注释一律英文；shared/locales/** 不在扫描范围。
- 工作区里 action/**、build/installer.nsh、test/action-*.test.js、test/design-tokens.test.js、test/window-security.test.js 以及几个 untracked 文件属于**另一条工作线**，禁止修改/提交；提交只按具体路径 git add，绝不用 git add -A（历史上发生过 git reset --hard 清空两个流工作的事故）。
- 只有单显示器（1493×933，无副屏）：AGENTS.md 要求可见测试窗放副屏，**无副屏先问用户**，不要擅自开可见窗或启动 app。
- 本机对 GitHub release 下载不可达（electron-builder 会在 packaging 阶段 ETIMEDOUT）。要打包就用交接文档 §8.1 的命令（带 --config.electronDist=<repo>\node_modules\electron\dist）。

开发纪律：
- capture/capture.js 是单写者；新算法一律下沉到 capture/selection-utils.js 或 capture/annotation-geometry.js（这两个在覆盖率 include 清单里），capture.js 只留接线。
- 改动 capture.js 的 pointerdown/落位/样式接线时，必须同提交更新契约测试（交接文档 §6 列了每个测试文件钉死什么，例如 pointerdown 分支顺序、pendingMove 唯一创建点、invalidateToolbarSize 唯一写点、GOLDEN 表、图标精确序列）。
- 每个改动跑定向测试 → npm run check → 收口再跑全量 npm test；真机行为无法自测的部分，明确写"待真机复测"并给出复测步骤。

完成后请给出：改了哪些文件、门禁读数、哪些行为只能由用户真机验证。
```

---

## 12. 待用户决策（**不要在没确认前自行拍板**）

1. **下一件事做哪个**：方案 2（工具栏宽度跟随选区）/ 方案 3b（动作收进溢出面板，建议独立立项）/ 真机验收清单 / 3.0.0 发布记录与 portable+`verify:package`。~~B6~~ 已于 2026-10-15 完成（`3effa97` + `d8d46ab`）。
2. ~~B6 是否拆两波~~ —— 已按两波落地（见方案 §10.8）；剩余未做的两项（**多选整体拖动**、多选下的层级 ↑↓）建议与方案 2/3b 一起评估。
3. **方案 3b（动作收进溢出面板）是否立项**：它会改主行结构与图标清单契约、影响肌肉记忆。
4. **3.0.0 是否要出 portable + 跑 `verify:package` + 写发布记录 + 打 tag 发布**（当前只有本机 NSIS setup、未签名）。
5. **安装器静默安装失败的处置**：是否把安装包加入安全软件信任区/以管理员运行后再试（需要用户在本机操作与观察提示）。
6. ~~**（新增，2026-10-15）Electron 路径问题的根治方式**~~ —— **已解决（2026-10-15）**：工作副本已整体复制到纯 ASCII 的 `D:\workspace\Highlighter`，并在那里验证 `npm test` 1012/1012/0（默认环境下、无需任何 override）。旧的中文路径目录保留为快照（HEAD `1e349f8`），**是否删除由用户决定**（删除前请确认没有别的会话/工具还引用它）。
7. ~~**（新增，2026-10-15）要不要跑 `npm run test:e2e`**~~ —— **已跑（2026-10-15，用户同意后）**：**6 / 6 通过**（34.1s）。后续再跑同样需要用户同意（会开 app 窗口）。
