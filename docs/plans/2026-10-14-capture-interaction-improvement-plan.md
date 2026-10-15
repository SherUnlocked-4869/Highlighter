# 实施方案：截图标注交互改进（对标 Snow Shot 工具栏体验，三梯队落地）

- 日期：2026-10-14
- 基线：工作副本 `D:\workspace\Highlighter - 副本`，`package.json` 版本 **2.5.0**（批次 C 已收口，最后记录的门禁读数：`npm test` 916/916、覆盖率 92.78%、`main.js` 1297/1300、i18n `--max 606`，见 p0-gap-closure-plan.md §25.2）
- 状态：**T1（A1–A5）与 T2 除 B6 外（B1/B2/B3/B4/B5/B7）已实施，见 §10 实施结果；B6 未开工**
- 上游依据：`docs/plans/2026-10-14-snow-apps-toolbar-interaction-gap-analysis.md`（六支柱差距分析与三梯队建议，本文不重复论证，只做落地设计）
- 关联文档：`docs/plans/2026-10-10-snow-apps-feature-gap-analysis.md`（全仓对标）、`docs/plans/2026-10-10-p0-gap-closure-plan.md` §20（P0-5 实施记录与 §20.3 遗留短板）
- **新会话入口**：`docs/plans/2026-10-14-capture-interaction-handoff.md`（状态/代码地图/契约钉死点/环境坑/开场文案）
- 范围：`capture/**` 交互层（右键快选、滚轮调宽、色板与颜色持久化、选中回显、第二行工具栏、多选）、`main/services/settings-defaults.js`、`main/services/settings-normalize.js`、`preload-capture.js`、`shared/locales/capture.js`、`test/**`
- 明确不在范围：自研渲染引擎 / FFI 架构（旧文档已定论不跟）、工具栏手动拖动（分析 §6 已列"不建议跟"）

---

## 0. 执行摘要

### 0.1 落地内容与工作量

上游分析 §6 给出三梯队 12 项建议；本方案全部纳入排期（第 12 项降为跟随项），并补入 2 项分析 §2.2 已点名但未入梯队的 P0-5 遗留短板修复（点击/拖动阈值即建议 8，选区外元素可选为新补项）。

| 梯队 | 项 | 内容 | 人日（估） | 版本目标 |
|---|---|---|---|---|
| **T1** 零切换操作 | A1 | 按键门控 + 右键快选拖动 + 点击/拖动阈值 | 1.0–1.5 | v2.5.x |
| | A2 | 滚轮调笔画粗细（含活动笔迹实时生效） | 0.5 | v2.5.x |
| | A3 | 预设色板 + 颜色持久化 + 自定义色入口 | 1.0–1.5 | v2.5.x |
| | A4 | 选中项样式回显（含撤销/重做后再同步） | 0.5–1.0 | v2.5.x |
| | A5 | 选区外元素可选（P0-5 遗留 ④ 修复） | 0.5 | v2.5.x |
| **T1 小计** | | | **3.5–5.0** | |
| **T2** 第二行体验 | B1 | 工具栏容器重构 + 内容变化重摆位 + 行序翻转 | 1.5–2.0 | v2.6.0 |
| | B2 | 矩形/椭圆：填充/线型/圆角（模型+绘制+命中） | 1.5–2.0 | v2.6.0 |
| | B3 | 箭头起终点样式 + 直线线型 | 1.0 | v2.6.0 |
| | B4 | per-tool 样式记忆（annotationStyles 结构化键） | 1.0 | v2.6.0 |
| | B5 | 高亮浓度 + 文字粗体（第二行轻量选项） | 0.5–1.0 | v2.6.0 |
| | B6 | 多选（shift 加选 + 框选）+ mixed 态 | 2.0–3.0 | v2.6.0 |
| | B7 | 画笔端点续画 | 0.5–1.0 | v2.6.0 |
| **T2 小计** | | | **8.0–11.0** | |
| **T3** 长线 | C1 | 旋转支持（rotation 字段 + 手柄 + 反向命中） | 2.0–3.0 | v2.7+ |
| | C2 | 统一标注引擎 annotation-core（capture/record 共用） | 5.0–8.0 | v2.7+ |
| | C3 | 文字原地编辑（替掉 window.prompt） | 1.5–2.0 | v2.7+ |
| | C4 | 对齐分布/透明度/复制/Alt+拖复制 | 跟随 | v2.7+ |
| **T3 小计** | | | **8.5–13.0** | |

> 口径：T1/T2 为可排期估算中值；不含评审与真机回归排队。真机验证窗口一律放**副屏**（`AGENTS.md`），无副屏先询问。

### 0.2 核心编排事实（决定实施顺序）

1. **T1 五项全部落在 `capture/capture.js` 的 pointerdown/wheel 主干**（:920-962、:1016-1023）——单写者，必须串行成 5 个 PR 依次落地，不可并行。
2. **零新增 IPC 通道**：颜色持久化复用 `preload-capture.js:35` 的 `settings:update` 管道（`saveAnnotationWidth` 同款），`main/ipc/capture-ipc.js` 与 `ipc-security.js` **一行不改**，C1/C3 约束自动满足。
3. **新增设置键只有 2 个**（`screenshot.annotationColor`、`screenshot.annotationStyles`），先写进 `settings-defaults.js`（C2），类型校验走既有 `settings-validation.js`（只校验类型，白名单在渲染端，C4 口径不变）。
4. **纯逻辑下沉模块保覆盖率**：`test:coverage:loaded` 只覆盖 `capture/selection-utils.js` 与 `capture/annotation-geometry.js`（package.json:14），不含 `capture.js`。所有新算法（宽度步进、填充/线型预设、颜色归一）一律写成这两个模块 + `annotation-style.js` 的纯函数；`capture.js` 的改动用**源码契约测试**钉死（`test/capture-annotation-geometry.test.js:560-639` 的既有做法）。
5. **契约测试是最大的隐性改造成本**：pointerdown 分支顺序被 `test/capture-annotation-geometry.test.js` 逐字钉死（:622-634），右键/阈值分支插入必须**同 PR** 更新断言（C6 同款纪律）。

---

## 1. 共同约束（继承 P0 方案 §1，按本方案修订）

| # | 约束 | 出处 | 本方案适用点 |
|---|---|---|---|
| C1 | 不得向 `main.js` 添加业务逻辑 | `scripts/check-architecture.js:18,33-65` | 本方案**零 `main.js` 改动**，天然满足 |
| C2 | 新增设置键先写 `main/services/settings-defaults.js` | `settings-validation.js:30` | A3 的 `annotationColor`、B4 的 `annotationStyles` |
| C3 | 新增 IPC 通道须登记 `ipc-security.js` | `ipc-security.js:257` | 复用 `settings:update`，不触发 |
| C4 | 数值白名单两端归一（主进程只校验类型） | `settings-validation.js:33` | 颜色白名单留在渲染端 `annotation-style.js` |
| C5 | 不改 `capture.js` 的两套坐标系语义（屏幕 CSS vs 导出） | P0 方案 §8.3 | B2/B3 的绘制改动沿用同一 `drawAnnotation` 双坐标换算 |
| C6 | 契约测试硬编码清单改动需同 PR 同步 | P0 方案 §1 C6 | `test/capture-annotation-geometry.test.js:622-634`（pointerdown 分支序）、`test/capture-annotation-width.test.js:39-51`（宽度控件契约）、`test/capture-toolbar-icons.test.js`（主行图标序，第二行不动主行即不触发） |
| C7 | 可见测试窗口放副屏；无副屏先询问 | `AGENTS.md` | 真机验证（右键/滚轮/色板/第二行） |
| C8 | 全量门禁只在收口由 Lead 跑 | P0 方案 §1 C8 | 不变 |
| C9（新） | 新 UI 文案一律 i18n 键（三语言同步登记 `shared/locales/capture.js`），不得新增硬编码行 | `scripts/check-i18n.js --max 606` | 色板/第二行全部新控件 |
| C10（新） | `capture.js` 新逻辑可测部分必须下沉纯函数模块（`annotation-style.js`/`annotation-geometry.js`），`capture.js` 只留接线 | 覆盖率口径（package.json:14） | 见 §0.2 第 4 条 |

### 1.1 门禁基线（开工时核对一次，收口逐条对照）

| 门禁 | 最后记录值（p0-gap-closure-plan.md §25.2） | 收口要求 |
|---|---|---|
| `npm test` | 916 / 916 | 全绿，新增用例计入 |
| `npm run check` | 293 文件；`main.js` 1297/1300；i18n ≤ 606 | 不变（本方案不动 `main.js`；i18n 只加键不加未迁移行） |
| `test:coverage:loaded` | 92.78% | 不下降 |
| `test:coverage:critical` | 93.22 / 94.07 / 92.42 | 不下降 |
| `audit:dependencies` | 26 / 0 | 无新增豁免 |
| Playwright e2e | 6 / 6 | 全绿 |

---

## 2. 关键设计决策（D1–D12）

> 每条决策给出依据与被否方案。这些决策是任务拆分（§3/§4）的前提。

**D1（A1）：pointerdown 增加按键门控，右键收编为"快选 + 拖动"，中键直接忽略。**
现状：`capture.js:920-962` 的 pointerdown **不检查 `event.button`**——右键或中键按下拖动同样会创建标注（隐性缺陷：右键拖一下画出一根线）。Electron 未注册 `context-menu`，右键无可见菜单，所以用户从未察觉，但语义是错的。
设计：

```
pointerdown 顶部（point 计算之后、自愈收口之前）：
  event.button === 2  → 右键分支（见下）后 return
  event.button !== 0  → return（中键等无语义）
右键分支语义（对标 quick_selection.rs:42-105）：
  任意工具下，findAnnotationAt(annotations, point) 命中
    → setSelectedAnnotation(hit) + 进入 pendingMove（与左键体内拖动同构，见 D2）
  未命中：
    select 工具 → setSelectedAnnotation(null)（与左键空白一致）
    绘图工具 → no-op（绝不因右键起绘、绝不重划选区）
  另注册 canvas 'contextmenu' → preventDefault()（防御未来注册菜单时的语义冲突）
```

被否方案：右键打开"元素操作菜单"（删除/层级）——功能与 `#elementBar` 重复，且菜单式交互比"直接拖"多一步，与上游分析"零切换"的定位相反。

**D2（A1）：点击/拖动 3px 阈值（pendingMove），左键体内拖动与右键快选共用。**
现状：`capture.js:948` 命中"当前选中元素的 bounds"立即进入 `movingAnnotation`，微移虽不压 undo 帧（0 位移不压，:639 附近），但**点击即进入 move 态**（视觉抖动 + 依赖自愈路径）。
设计：`movingAnnotation` 升级为 `pendingMove = { id, origin, start, thresholdPassed }`；pointermove 中位移 > **3px** 才置 `thresholdPassed` 并首次调用 `moveAnnotationTo`；pointerup 时未过阈值 = 纯点击（选中已生效，无移动帧）。对标 `state.rs:270-280` 的 Pending→Editing 阈值升级。`finishMoveAnnotation`/`cancelMoveAnnotation`/自愈分支（:983）同步适配：未过阈值的收口等价于取消。
成本控制：不新增交互态变量种类，复用 `movingAnnotation` 的字段加一个布尔，避免 pointercancel 分支膨胀。

**D3（A3）：色板 = record 端同款 7 色预设 + 「自定义」入口 + 会话级最近自定义色；颜色持久化为任意 `#rrggbb`。**
依据：上游分析 §6 第一梯队第 3 条点名复用 `record.html:31-57` 的 7 色板；`record/annotation-utils.js:3` 的 `ANNOTATION_COLORS` 是唯一既有的预设色事实源。
设计：

- `capture.html` 主行的 `.color-wrap`（:32）改为「色块按钮 + 弹出面板」结构（record 端 `annotationStyle` 按钮同款交互：点击弹出、点外部关闭，`record.js:809-831` 的既有模式）。
- 面板内容：7 个预设色块（`--swatch` CSS 变量驱动，与 record 完全同色值）+ 1 个「自定义」按钮（内嵌现有 `input[type=color]` 作为触发器，原生取色器仅在显式点击自定义时弹出）+ 最近自定义色槽位（**≤3 个，仅会话内存，不持久化**——避免设置 schema 再膨胀）。
- 选中态：命中预设时该色块 `active`（record 端 `renderAnnotationControls:149` 同款 toggle）；自定义色时所有预设块灭活、触发器色块显示当前色。
- 持久化：`screenshot.annotationColor`（string，默认 `'#ff3b30'`）。capture 端**不设颜色白名单**（与 record 端 `cleanStyle` 白名单的差异是刻意的：record 走 IPC 边界需要消毒，capture 是本地绘制，自定义色必须能存）。归一化在 `settings-normalize.js` 的 `normalizeFrozenSettings`（:30-49）加一行：非 `#rrggbb` 落回默认。
- 顺带修复上游分析点名的 `capture.css:98`「hover 与 active 共用样式」：色板块 hover 用 `.13` 白、active 用 `.18` 白 + 描边，与 `.width-group button.active`（:109）对齐。

被否方案：把 7 色直接平铺进主行——主行已 866px/900px 满宽（分析 §1.2），加 7 个色块必然折行；popover 是唯一省空间形态。

**D4（A4）：选中回显走「UI-only 同步」，不经过 `commitSelectedStyle`；取消选中/换工具时恢复**工具记忆样式**（T1 阶段 = 全局默认色 + 宽度）。**
依据：上游分析 §4.2——`setSelectedAnnotation`（:501-504）只置变量 + render，选中红色矩形时工具栏仍显示全局色。
设计：

- 新增 `syncToolbarStyleFromSelection(item)`：直接写 `colorInput.value`、色板 active 态、宽度按钮 active 态（**只改 UI，不调 `setAnnotationWidth`/`commitSelectedStyle`**——后者会尝试压快照；虽然 `applyStyleToSelectedAnnotation` 的 0 变化守卫（:748）使同值补丁返回 false 不压帧，但显式分离「回显」与「编辑」两个意图更可审计）。
- 调用点：`setSelectedAnnotation(item)`（非 null 分支）、`syncSelectedAnnotation`（:496，undo/redo 还原后按 id 重解析处）、`deleteSelectedAnnotation`/`setTool`（:463）等置 null 的路径走「恢复默认」分支。
- 恢复默认的数据源：T1 = 全局 `annotationColor`/`annotationWidth` 变量；T2 B4 落地后切换为当前工具的 per-tool 记忆（D7），接口不变、只换数据源。
- 颜色编辑仍是双目标：选中时改色 → `stageSelectedStyle({color})`（:771 既有路径）作用于选中项 + 写全局色（A3 的色板点击 handler 同时更新 `annotationColor` 变量并持久化）。这与 Snow Shot `applyScreenshotCanvasToolStyles` 的"所见即所改"（分析 §4.1）同语义。

**D5（B1）：第二行只装「新选项」，主行结构不动（宽度/颜色留在主行）。**
依据与取舍：Snow Shot 把全部样式编辑器放进第二行（分析 §1.1）；Highlighter 主行已承载宽度/颜色且被 `test/capture-annotation-width.test.js:39-51`、`test/capture-toolbar-icons.test.js` 钉死。搬迁的收益（主行变短）小于代价（契约测试全改 + 用户肌肉记忆重置 + 回归面扩大）。渐进迁移留给未来版本。
结构：

```
#toolbar（保持 id/class，外层改为 column flex 容器）
  ├── .toolbar-row（原单行全部内容，DOM 原样包一层）
  └── #toolOptions.toolbar-row.hidden（第二行，按工具切换内容）
```

`.toolbar { flex-direction: column }`；两行各自 `display:flex`。`test/capture-annotation-geometry.test.js:595` 钉的是 `id="toolbar" class="toolbar hidden"` ——外层 id/class 不变即不触发。

**D6（B1）：第二行出现/消失 = 「内容变化重摆位」，必须失效 `toolbarSize` 缓存；工具栏翻上方时行序倒置。**
依据：分析 §3.3——Highlighter 的避让是单公式静态避让（`updateFloatingUi` :435-449，`toolbarSize` 缓存 :126/:444），第二行展开导致高度变化时**不会自动重算**，可能整条出屏。
设计：

- `toolbarSize` 失效点从目前唯一一处（`resizeCanvas` :206）扩为三处：resize、**第二行可见性切换**、**第二行内容换族**（高度可能不同）。
- `updateFloatingUi` 的占位判定改用**容器整体 rect**（含第二行），等价于 Snow Shot 的 `occupiedContentRect` 含次级行（分析 §3.1）。
- 行序翻转：`top` 落到选区上方时（:445 的分支）给容器加 `.above` class → `flex-direction: column-reverse`，让第二行（样式行）贴近选区边缘，对标 `setStyleToolbarAboveMain`（分析 §1.1）。
- `updateElementBar` 的工具栏避让（:416-429）读同一个 `toolbarSize` 缓存，失效机制共享，无需单独处理。

**D7（B4）：per-tool 样式记忆 = `screenshot.annotationStyles` 一个结构化键，模板枚举全部工具；旧键 `annotationWidth` 保留为迁移源。**
依据：Snow Shot 17 个 per-tool 键（分析 §4.1）；Highlighter 已有 `annotationWidth` 单键（`settings-defaults.js:41`）。
设计：

```js
// settings-defaults.js screenshot 块新增：
annotationStyles: {
  rect:     { color: '#ff3b30', width: 4 },
  ellipse:  { color: '#ff3b30', width: 4 },
  arrow:    { color: '#ff3b30', width: 4 },
  line:     { color: '#ff3b30', width: 4 },
  pen:      { color: '#ff3b30', width: 4 },
  highlight:{ color: '#ffcc00', width: 4 },
  text:     { color: '#ff3b30', width: 4 },
  serial:   { color: '#ff3b30', width: 4 }
  // B2/B3 落地后各工具追加专属字段：rect 的 fill/dash/radius、arrow 的 startHead/endHead……
}
```

- `settings-validation.js` 沿模板递归（:20-33），模板枚举键即天然白名单；渲染端 `annotation-style.js` 新增 `resolveToolStyle(tool, stored)` 纯函数做字段级归一（width 走既有 `resolveWidth` 白名单）。
- 迁移：首次读不到 `annotationStyles` 时，用 `annotationWidth`/`annotationColor` 的值铺底（一次性，渲染端 init 处理，不写回）。
- 旧键**不删**（`saveAnnotationWidth` 管道 :486 继续工作），避免破坏既有用户配置与 `test/capture-annotation-width.test.js:49-50` 契约；B4 落地后 `setAnnotationWidth` 的持久化目标切到 `annotationStyles[tool]`，旧键转为兼容读取。
- 写入防陈旧：每次写 `annotationStyles` 都从**当前 settings 合并**后整对象提交（`settings:update` 是 merge 语义，`mergeSettings` :11-21 深合并），对标 Snow Shot 的"总是与最新存储合并"（分析 §4.1）。

**D8（B6）：多选第一阶段 = shift+左键加选 + shift+空白拖框选（marquee）；mixed 态只做显示。**
依据：分析 §2.3「多选 + mixed」中成本项；对齐分布/透明度/复制按上游建议留 T3。
设计要点：`selectedAnnotation`（单引用，:87）升级为 `selectedIds: Set`，`selectedAnnotationItem()` 变 `selectedAnnotations()`；单选路径全部走 `size===1` 的退化分支以保 A1–A5 行为不变。框选只在 **shift 按下**时接管空白拖动（现有空白拖动 = 移动选区 :991，不冲突）。mixed 显示：宽度/颜色控件进入 indeterminate 态（分段色块 + "—"），编辑 mixed 控件 = 对全部选中项写入该值（对标分析 §4.1 mixed 位掩码的简化版）。
**前置**：B6 必须排在 A1/A4 之后——右键快选与回显的接口都按"单选中"写，多选改造要把它们升级为"主选中项 + 集合"。

**D9（B2/B3）：新样式字段全部可选、缺省 = 既有渲染逐字节不变；命中测试对实心形状开放内部命中。**
依据：C5 坐标系约束 + 存量标注兼容（旧截图会话内没有这些字段）。
字段与绘制（`drawAnnotation` :297-318 内按类型补分支）：

| 字段 | 类型/取值 | 绘制 | 缺省 |
|---|---|---|---|
| `fill` | `'none' \| 'translucent' \| 'solid'`（rect/ellipse） | translucent = `globalAlpha .28` + `fill()`；solid = 原色填充 | `'none'`（现状环带描边） |
| `dash` | `'solid' \| 'dashed' \| 'dotted'`（rect/ellipse/line/arrow 杆） | `setLineDash([width*3, width*2])` / `[width, width*1.5]`，导出坐标同步缩放 | `'solid'` |
| `radius` | `0 \| 4 \| 8`（rect） | `ctx.roundRect`（Electron 43/Chromium ≥ 99 支持） | `0` |
| `startHead`/`endHead` | `boolean`（arrow） | `drawArrow`（:253-258）按端点各画/不画头 | `endHead:true, startHead:false`（现状） |
| `alpha` | `'light' \| 'medium' \| 'strong'`（highlight） | 映射 `.18/.28/.45`（现值 .28 = medium，:309） | `'medium'` |
| `bold` | `boolean`（text） | font 前缀 `bold`（:310） | `false` |

命中（`annotation-geometry.js:184-209`）：`fill !== 'none'` 的 rect/ellipse 由环带命中（`nearBoxRing`/`nearEllipseRing`）升级为**环带 ∪ 内部盒**——实心块可点内部，与 text/serial 的 `insideBox` 兜底（:208）同语义；描边样式仍是实心环带（虚线不改变命中带宽，避免点不中虚线段）。预设枚举与归一函数全部放 `annotation-style.js`（`FILL_PRESETS/DASH_PRESETS/...` + `resolveFill/resolveDash/...`，照 `WIDTH_PRESETS/resolveWidth` :11-25 的既有写法）。

**D10（A5）：选区外元素可选 = select 工具下，元素命中分支提到「重划选区」判定之前。**
依据：P0 方案 §20.3-4——元素被拖出选区后再也选不中（分支顺序：`!insideSelection` → 重划选区在元素分支之前，:931）。拖动把元素甩出选区后，下一次点击它反而触发 D4 重划确认（要丢弃全部标注），是当前交互的硬伤。
设计：pointerdown 在 select 工具下先做一次 `findAnnotationAt`（在 `!selection || !insideSelection` 的重划分支**之前**）；命中即选中 + pendingMove，**不再**触发重划路径。选区内的既有优先级（选区手柄 :930 → Alt :941 → 元素手柄 :944 → 体内 :948 → 命中 :950）不动。注意与 D4 重划确认的交互：元素命中优先意味着「点在元素上」永远不会重划选区——这正是期望语义（对标 Snow Shot paint_order 命中先于空白分支，分析 §2.1）。
契约影响：`test/capture-annotation-geometry.test.js:562-570` 钉的「元素命中先于 `dragging=true`」断言方向不变，但索引重算，同 PR 更新。

**D11（B7）：画笔续画 = pointerdown 落在「最后一条 pen 的任一端点」12px 内即续写该笔迹。**
对标 `resolve_free_draw_endpoint`（分析 §2.3）。实现：绘图工具 pen 的 pointerdown 分支里，取 `annotations` 中最后一条 `type==='pen'`（数组末尾 = 最上层，§8.1 口径），端点距离 ≤ 12px（`MAX(width, 12)`）则把该笔迹置为活动对象（生成副本追加 points，**一次手势一帧快照**，与 `commitAnnotation` :823 同口径），否则照旧新建。undo 语义：续画手势独立成帧（可单独撤销这次续写）。

**D12：不跟清单（与上游分析 §6 一致，此处登记理由防翻案）。**

| 不跟项 | 理由 |
|---|---|
| Qt 级瓦片渲染/FFI 引擎 | 旧文档已定论（Canvas + 原生边车路线）；当前规模（手工标注十几个元素）整帧重绘够用 |
| 工具栏手动拖动 + 停用自动换位 | Electron 无边框窗拖动可用性一般；自动避让已覆盖主场景 |
| 弹窗期工具栏存活（popupInteractionBegan 类） | 本方案色板是页内 popover（DOM 层），不跨窗口，不触发该问题；将来若做独立取色窗再评估 |
| text/serial 缩放落点预设（P0-5 遗留 ①） | 绘制模型上限（width 派生字号/半径，`resolveWidth` 白名单），修它等于重做文字模型，归入 C2 统一引擎的范畴 |

---

## 3. 第一梯队任务拆解（T1：零切换操作，v2.5.x）

> 单写者串行：`capture/**` 全程一个 owner；PR 依次落地，每个 PR 自带定向测试 + 契约测试同步。全量门禁只在 T1 收口跑一次。

### A1 按键门控 + 右键快选 + 点击/拖动阈值（1.0–1.5 人日）

| 任务 | 文件 | 内容 |
|---|---|---|
| A1-T1 | `capture/capture.js` | pointerdown 顶部加 `event.button` 门（D1）；右键分支：命中 → 选中 + pendingMove；未命中 → select 工具取消选中 / 绘图工具 no-op；注册 `contextmenu` preventDefault |
| A1-T2 | `capture/capture.js` | `movingAnnotation` → `pendingMove`（加 `thresholdPassed`，阈值 3px，D2）；`moveAnnotationTo`/`finishMoveAnnotation`/`cancelMoveAnnotation`/pointermove 自愈（:983）/pointerup（:1000）适配；左键体内拖动路径（:948）同样走阈值 |
| A1-T3 | `capture/capture.js` | `#elementBar` 提示文案补右键语义（`capture.element.move-hint` 增改：右键任意工具可拖动） |
| A1-T4 | `shared/locales/capture.js` | 新增/更新 `capture.element.*` 键 ×3 语言 |
| A1-T5 | `test/capture-annotation-geometry.test.js` | **同 PR 更新**：右键分支在绘图分支（:955-961）之前、button 门在自愈收口（:926-928）之后的顺序断言；新增"右键命中→pendingMove、右键空白→不起绘"源码契约 |
| A1-T6 | `capture/annotation-geometry.js`（可选） | 若阈值判定需要纯函数（`movedBeyondThreshold(start, point, 3px)`），下沉并加单测 |

验收：① 任意绘图工具下右键点标注即选中、按住直接拖、松手一帧 undo；② 右键空白处绝不创建标注、绝不弹重划确认；③ 中键拖动无任何效果；④ 单击已选中元素（<3px 位移）不进入 move 态、无 undo 帧增加；⑤ e2e/契约全绿。

### A2 滚轮调笔画粗细（0.5 人日）

| 任务 | 文件 | 内容 |
|---|---|---|
| A2-T1 | `capture/annotation-style.js` | 新增 `nextWidthPreset(current, delta)`：在 `WIDTH_PRESETS`（2/4/8）上步进，**两端钳制不环绕**；单测 |
| A2-T2 | `capture/capture.js` | 现有 wheel 监听（:1016-1023）扩展：auto 智能选区分支保持最优先；其后若「当前工具支持宽度（rect/ellipse/arrow/line/pen/highlight/text/serial）或存在支持宽度的选中项」且无进行中的选区交互 → `preventDefault` + `nextWidthPreset` 步进（`deltaY<0` 加粗，与智能选区步进方向一致）+ `setAnnotationWidth(w, true)` 同步按钮；**正在绘制的 `activeAnnotation` 同步改 width 实时生效**（一行赋值 + render） |
| A2-T3 | `capture/capture.js` | 持久化尾随去抖 500ms（滚轮爆发不逐格写盘），复用 `NUDGE_COMMIT_DELAY` 形态的计时器模式 |
| A2-T4 | `test/capture-annotation-width.test.js` | 追加 wheel 接线契约（listener 内 `nextWidthPreset` 调用 + `passive:false` 已有） |

验收：① 矩形工具下滚轮 2→4→8→8（钳制）；② 有选中红色箭头时滚轮同时改选中项（一帧）与全局预设；③ 绘制中滚轮笔迹粗细即时变化；④ 智能选区（auto 态）滚轮行为不变。

### A3 预设色板 + 颜色持久化（1.0–1.5 人日）

| 任务 | 文件 | 内容 |
|---|---|---|
| A3-T1 | `main/services/settings-defaults.js` | `screenshot.annotationColor: '#ff3b30'`（C2 前置） |
| A3-T2 | `main/services/settings-normalize.js` | `normalizeFrozenSettings` 加 `settings.screenshot.annotationColor` 归一（`/^#[0-9a-f]{6}$/i` 小写化，不匹配落默认） |
| A3-T3 | `preload-capture.js` | `saveAnnotationColor: (color) => ipcRenderer.invoke('settings:update', { screenshot: { annotationColor: color } })`（:35 同款） |
| A3-T4 | `capture/capture.html` | `.color-wrap`（:32）改造为「色块按钮 + `#colorPalette` 弹出面板」：7 预设色块（`--swatch`）+ 自定义按钮（内包现有 `input[type=color]`）+ 最近色槽（`#recentColors`） |
| A3-T5 | `capture/capture.css` | 面板样式（record.css 的 `.annotation-palette/.color-options` 形态移植到 capture 的暗色工具栏语境）；修 :98 的 hover/active 同色问题（D3） |
| A3-T6 | `capture/capture.js` | 色板点击 → 设 `annotationColor` + 持久化 + 双目标写入（选中项走 `commitSelectedStyle({color})` 离散帧；无选中只改全局）；自定义路径沿用 `stageSelectedStyle` 合帧（:771）+ change 收口（:1257）；`onInit` 读 `data.settings?.screenshot?.annotationColor` 回填（:1317 同位） |
| A3-T7 | `capture/annotation-style.js` | `normalizeAnnotationColor(value)` 纯函数（预设表 + hex 校验）；`PRESET_COLORS` 从 record 端色值复制为本模块常量（不 import record——两模块加载环境不同，复制是刻意的，注释互相指认） |
| A3-T8 | `shared/locales/capture.js` | 色板 aria/title 键（红/橙/黄/绿/蓝/黑/白/自定义/最近）×3 语言（C9） |
| A3-T9 | `test/` | 新增 `test/capture-color-palette.test.js`（HTML 结构/键位/CSS 契约，照 `capture-annotation-width.test.js` 写法）+ `capture-annotation-style.test.js` 追加 `normalizeAnnotationColor` 单测 + `settings-validation.test.js` 追加键契约 |

验收：① 选蓝色画矩形→复制新图→矩形默认蓝色（持久化）；② 自定义 `#123456` 可存可回显；③ 选中红色箭头点绿色 → 箭头变绿（一帧 undo）+ 下一笔绿色；④ 色板弹出/点外关闭；⑤ `npm run check:i18n` 不涨。

### A4 选中项样式回显（0.5–1.0 人日）

| 任务 | 文件 | 内容 |
|---|---|---|
| A4-T1 | `capture/capture.js` | `syncToolbarStyleFromSelection(item)`（UI-only，D4）；`setSelectedAnnotation` 非空分支、`syncSelectedAnnotation`（:496）、undo/redo 还原路径接入；置 null 的路径恢复全局默认 |
| A4-T2 | `capture/capture.js` | 回显与 A3 色板联动：选中项色 = 预设色 → 对应块 active；非预设 → 触发器色块显示该色 |
| A4-T3 | `test/` | 契约：`setSelectedAnnotation` 源码含回显调用且**不含** `commitSelectedStyle`（防快照递归回归）；undo 后回显重同步 |

验收：① 画红(4)→画蓝(8)→点红 → 色板红、宽度 4；② undo/redo 后回显跟随当前选中；③ Esc 取消选中恢复默认色；④ 回显本身不产生 undo 帧（帧数不变）。

### A5 选区外元素可选（0.5 人日）

| 任务 | 文件 | 内容 |
|---|---|---|
| A5-T1 | `capture/capture.js` | D10 分支前移 + `confirmDiscardAnnotations` 语义核对（元素命中不再触发重划确认路径） |
| A5-T2 | `test/capture-annotation-geometry.test.js` | 顺序断言更新（D10 契约影响）+ 新用例：源码中元素命中分支先于 `clearAnnotationsForNewSelection` 调用点 |

验收：① 拖元素出选区 → 点它仍可选中/再拖；② 点真空白仍走 D4 重划确认（行为不回退）；③ `test/capture-annotation-geometry.test.js:562-570` 既有断言语义保持。

### T1 收口（Lead，0.5 人日）

1. `npm test` / `npm run check` / 覆盖率 / audit / e2e 全量（§1.1 基线对照）。
2. 真机验证（副屏）：右键拖动、滚轮调宽（三种工具）、色板+自定义色跨会话、回显、选区外再选。
3. 回填本文档「实施结果」章节（改动表 + 门禁实况 + 偏差记录，沿用 p0 方案 §20 写法）。

---

## 4. 第二梯队任务拆解（T2：「第二行」体验，v2.6.0）

> 仍为 `capture/**` 单写者串行；B2/B3 的纯函数部分（预设/归一/命中）可由第二人并行落在 `annotation-style.js`/`annotation-geometry.js`（写作用域与 `capture.js` 不相交，但需先冻结 D9 的字段表）。

### B1 容器重构 + 重摆位 + 行序翻转（1.5–2.0 人日）

- `capture.html`：`#toolbar` 内包 `.toolbar-row`（原行）+ `#toolOptions.toolbar-row.hidden`（D5 结构）。
- `capture.css`：`.toolbar` 转 column flex；`.toolbar.above { flex-direction: column-reverse }`（D6 行序翻转）。
- `capture/capture.js`：
  - `toolbarSize` 三处失效（D6：resize / 二行可见性切换 / 二行换族）；
  - `updateFloatingUi`（:435-449）与 `updateElementBar`（:416-429）改读容器整体 rect；
  - `setTool`（:463）挂接 `syncToolOptionsRow(tool)`：按工具切换第二行内容（首版内容 = B2/B3/B5 的控件；B2 未落地前第二行恒 hidden，**重构先合、内容后到**，避免空行闪现）。
- 契约：`test/capture-annotation-geometry.test.js:595`（`id="toolbar"` 外层不变）+ 新增第二行结构/翻转 class 契约。
- 验收：切到矩形工具第二行出现且**工具栏整体重摆位不出屏**（含贴底翻上方 + 行序倒置）；贴顶选区不出屏；换 select 工具第二行收起并重摆位。

### B2 矩形/椭圆：填充/线型/圆角（1.5–2.0 人日）

- `capture/annotation-style.js`：`FILL_PRESETS/DASH_PRESETS/RADIUS_PRESETS` + `resolveFill/resolveDash/resolveRadius`（D9 表）+ 单测。
- `capture/annotation-geometry.js`：`hitTestAnnotation`（:193-194）按 `fill` 升级命中（D9）；单测（实心内部命中 / 虚线仍环带）。
- `capture/capture.js`：`drawAnnotation`（:304-305）补 fill/dash/radius 分支（屏幕 + 导出双坐标一致，C5）；第二行 rect 行 = [填充 | 线型 | 圆角]、ellipse 行 = [填充 | 线型]；双目标写入（离散值走 `commitSelectedStyle`）。
- `capture.html`/`capture.css`/locales：三组单选控件（aria-pressed 组）+ i18n 键。
- 验收：实心半透明矩形可点内部拖动；虚线矩形导出 PDF 后仍是虚线；旧会话无字段标注渲染逐字节不变（回归用例）。

### B3 箭头起终点 + 直线线型（1.0 人日）

- `drawArrow`（:253-258）参数化 `startHead/endHead`；line/arrow 杆接 `dash`；第二行 arrow = [起点 | 终点 | 线型]、line = [线型]；其余同 B2 模式。

### B4 per-tool 样式记忆（1.0 人日）

- D7 全量落地：defaults/normalize/`resolveToolStyle`/迁移铺底/`setAnnotationWidth` 持久化目标切换 + 契约测试。
- 验收：红粗画笔 → 切矩形画蓝细 → 切回画笔仍是红粗；重启会话保持。

### B5 高亮浓度 + 文字粗体（0.5–1.0 人日）

- D9 表的 `alpha`/`bold`；第二行 highlight = [浓度]、text = [粗体]；`drawAnnotation` :309/:310 两处分支。

### B6 多选 + mixed 态（2.0–3.0 人日，**排在 A1/A4 之后**）

- D8 全量：`selectedIds: Set`、shift 加选/减选、shift+空白拖 marquee 框选、mixed 显示（宽度按钮 indeterminate、色板分段）、mixed 编辑 = 批量写入一帧、`#elementBar` 多选态（显示计数；层级/删除作用于集合）、右键快选升级（shift+右键加选，对标分析 §2.1）。
- 风险最大项：所有单选中路径（A1/A4/A5、elementBar、nudge、Delete）要系统性过一遍 `size===1` 退化。测试以契约 + `annotation-geometry` 纯函数（marquee 相交判定 `rectsIntersect`）为主。

### B7 画笔端点续画（0.5–1.0 人日）

- D11；单测下沉 `penContinuationTarget(annotations, point, maxDistance)` 到 `annotation-geometry.js`。

### T2 收口（Lead）

同 T1 口径 + 真机第二行重摆位专项（贴底/贴顶/窄选区三形态）。

---

## 5. 第三梯队路线图（T3，v2.7+，只定方向不定任务表）

| 项 | 方向 | 依据 |
|---|---|---|
| C1 旋转 | 标注模型加 `rotation` + 顶部 Rotate 手柄 + 命中测试反旋转（点按 -rotation 变换回局部系） | 分析 §2.3（对标 `SelectionEditMode::Rotate` + 旋转感知命中） |
| C2 统一标注引擎 | 抽 `annotation-core.js`（几何/命中/样式/undo/绘制纯函数），capture 与 record 薄壳共用；先统一线宽口径（2/4/8 vs 2/4/7 的分裂在 core 的预设表里消解），录屏端顺带获得二次编辑能力 | 分析 §5.3「高价值中成本」；C10 的模块化纪律是它的前置 |
| C3 文字原地编辑 | contenteditable 覆盖层替代 `window.prompt`（capture.js:958），字号 = `textFontSize` 同源 | 分析 §6 第 11 条 |
| C4 对齐分布/透明度/Alt+拖复制 | 跟随 B6 多选之后，逐项小 PR | 分析 §2.3 低优先级行 |

---

## 6. 测试与门禁策略

1. **契约测试更新纪律（C6/C10）**：凡改 `capture.js` pointerdown/wheel 主干的 PR，必须同 PR 更新 `test/capture-annotation-geometry.test.js` 的分支顺序断言（:562-570、:622-634 是已知的钉死点）；主行结构不动则 `test/capture-toolbar-icons.test.js` 与 `capture-annotation-width.test.js:39-51` 不应被触碰（B1 的外层包装若触发即说明改错了层级）。
2. **纯函数下沉清单**（进 loaded 覆盖率）：`nextWidthPreset`、`normalizeAnnotationColor`、`resolveToolStyle`、`resolveFill/Dash/Radius`、`movedBeyondThreshold`、`rectsIntersect`、`penContinuationTarget` —— 全部带单测。
3. **渲染回归**：B2/B3 的「缺省字段 = 逐字节不变」用既有 `scripts/probe-capture-width.js` 形态的隐藏窗探针做像素对比（新增/无字段两份标注同图对比）；真机窗口按 C7 放副屏。
4. **i18n**：所有新键先落 `shared/locales/capture.js` 三语言（C9），`check-i18n --max 606` 读数不得上涨。
5. **设置契约**：`test/settings-validation.test.js` 追加 `annotationColor`/`annotationStyles` 键存在性与类型断言（沿 :61 注释的"类型在主进程、白名单在渲染端"口径）。

---

## 7. 风险与回退

| # | 风险 | 概率/影响 | 缓解 |
|---|---|---|---|
| R1 | pointerdown 主干连锁改动引入回归（右键门/阈值/分支前移三处叠加） | 中/高 | A1/A5 拆两个 PR；每个 PR 附「既有断言语义不变」的核对说明；A1 先合 button 门再合右键分支 |
| R2 | 第二行展开把工具栏顶出屏幕（无重摆位） | 高/高 | B1 的三处缓存失效 + 整体 rect 是**硬前置**（D6），B2-B5 不得先于 B1 合入 |
| R3 | `toolbarSize` 缓存失效遗漏导致 elementBar 避让错位 | 中/中 | 失效逻辑收敛为一个 `invalidateToolbarSize()` 函数，三处调用；契约测试钉住调用点数量 |
| R4 | 新样式字段污染导出/长截图/贴图链路 | 低/高 | `drawAnnotation` 是唯一绘制入口（renderOverlay :331 与 export :1033 同源），双坐标换算保持 C5；回归探针覆盖导出 |
| R5 | 多选改造（B6）波及面失控 | 中/中 | D8 的「单选 = size===1 退化」设计 + 排序在 A1/A4 后；必要时 B6 可拆两波（先 shift 加选后 marquee） |
| R6 | 设置 schema 膨胀（annotationStyles 8 工具 × 字段） | 低/低 | `settings-validation` 模板递归天然白名单；`MAX_PATCH_BYTES` 256KB 上限远未触及 |
| R7 | 色板 popover 在 900px 窄视口溢出 | 低/中 | popover 锚定主行色块、宽度 ~120px，`max-width: calc(100vw - 20px)`（:72 既有）；真机验证覆盖 |

回退策略：全部改动集中在 `capture/**` + 3 个设置文件 + locales + tests，无数据迁移、无 IPC 变更、无 `main.js` 变更——任一 PR 可独立 revert；`annotationStyles` 不写回旧键，revert 后旧配置完好。

---

## 8. 交付节奏

| 波次 | 内容 | 并行度 | 版本 |
|---|---|---|---|
| W0 | 工作区洁净核对 + 基线门禁读数（§1.1 开工门） | 单流 | —— |
| W1 | A1→A2→A3→A4→A5 五个 PR 串行 + T1 收口 | 单写者 | **v2.5.x** |
| W2 | B1（前置）→ B2/B3/B4/B5 串行；B2/B3 纯函数部分可并行 | 单写者 + 模块第二人 | **v2.6.0** |
| W3 | B6 → B7 + T2 收口 | 单写者 | v2.6.0 |
| W4+ | C1–C4 按路线图逐项立项（每项单独方案文档） | 视项 | v2.7+ |

---

## 9. 附录：本方案引用的证据基础（Lead 2026-10-14 全量核查）

- `capture/capture.js`（1352 行）：pointerdown/pointermove/pointerup/pointercancel/wheel 事件主干（:920-1023，**无 `event.button` 门控**——右/中键同样起绘，D1 依据）；`updateFloatingUi`（:435-449）与 `toolbarSize` 缓存（:126/:206/:417/:444，仅 resize 一处失效，D6 依据）；`setAnnotationWidth`（:475-487，宽度双目标 + 持久化管道）；`setSelectedAnnotation`（:501-504，无回显，D4 依据）；`applyStyleToSelectedAnnotation`/`commitSelectedStyle`/`stageSelectedStyle`（:744-777）；`drawAnnotation` 全类型绘制分支（:297-318，D9 改造点）；`drawArrow`（:253-258）；`annotationStyle()`（:167）；`onInit` 恢复链（:1311-1326）；text 工具 `window.prompt`（:958）。
- `capture/capture.html`：单行工具栏结构（:17-53）、`.color-wrap` 原生色输入（:32）、`#widthGroup`（:33-37）、`#elementBar`（:54-62）。
- `capture/capture.css`：`.toolbar`（:66-79）、hover/active 同样式（:98，D3 顺带修）、`.color-wrap`（:111-113）。
- `capture/annotation-style.js`：`WIDTH_PRESETS`/`resolveWidth`（:11-25，C4/预设表范式）。
- `capture/annotation-geometry.js`：`hitTestAnnotation` 分类型命中（:184-209，环带 vs 内部盒，D9 命中升级点）、`findAnnotationAt`（:212-220）。
- `record/record.html`（:31-57）与 `record/record.js`（:809-831）：7 色板 + 复合按钮 + 点外关闭的既有实现（A3 移植源）；`record/annotation-utils.js:3` `ANNOTATION_COLORS`。
- `main/services/settings-defaults.js`（:30-49 screenshot 块）、`settings-validation.js`（:20-49 类型校验/模板白名单）、`settings-normalize.js`（:30-49 `normalizeFrozenSettings`）、`preload-capture.js`（:34-35 `settings:update` 复用管道，零 IPC 增量的依据）。
- 门禁：`scripts/check-architecture.js:18`（`main.js` ≤ 1300）、`package.json:14,31`（覆盖率 include 清单与 i18n `--max 606`）。
- 测试钉死点：`test/capture-annotation-geometry.test.js:560-639`（pointerdown 分支序/模块加载序/elementBar 结构）、`test/capture-annotation-width.test.js:39-51`（宽度控件与持久化契约）、`test/settings-validation.test.js:61`。
- 遗留短板出处：p0-gap-closure-plan.md §20.3（:1169-1176，A5 对应 ④、D12 登记的 ①②③）。
- 上游分析：`docs/plans/2026-10-14-snow-apps-toolbar-interaction-gap-analysis.md` 全文（六支柱、三梯队建议、Snow Shot 侧全部 文件:行 引用）。

---

## 10. 实施结果（2026-10-14，分支 `feat/capture-interaction-t1`）

> 状态（2026-10-15 更新）：**T1 全部落地（A1–A5）+ T2 全部落地（B1/B2/B3/B4/B5/B6/B7）** —— B6 于 2026-10-15 拆两波补齐，见 **§10.8**。
> 提交：`0b90609`（T1 A1–A5）→ `27e4499`（B1+B2/B3/B5）→ `f6dae10`（B7）→ `c0887be`（B4）→ `87ded5b`/`36a89e9`/`ef8ac63`/`aa7d3a8`/`775f5f0`（三轮真机修复 + 版本）→ `3effa97` + `d8d46ab`（B6 两波）。
> ⚠️ 阅读提示：§10.2–§10.7 与 §10.4 偏差 7 里"本机无法启动 Electron"的记述是 **2026-10-14 当时的记录**（§10.2 已附更正块）；**该结论已于 2026-10-15 推翻为"仓库路径含中文导致"**，请以 §10.2 的更正段与 §10.8 的门禁读数为准。

### 10.1 改动表（按项）

| 项 | 主要文件 | 落地内容 |
|---|---|---|
| A1 | `capture/capture.js`、`capture/annotation-geometry.js`、`shared/locales/capture.js` | pointerdown 顶部 `event.button` 门（右键=快选+拖动、其余按键吞掉）+ `contextmenu` preventDefault；`movingAnnotation` → `pendingMove`（`thresholdPassed` + `MOVE_THRESHOLD=3` + `movedBeyondThreshold`）；#elementBar 提示补右键语义（三语） |
| A2 | `capture/annotation-style.js`、`capture/capture.js` | `nextWidthPreset`（两端钳制）；wheel 在智能选区分支之后步进宽度、活动笔迹实时跟随、持久化 500ms 尾随去抖（`cancelAnnotationWidthPersist` 随 init 复位） |
| A3 | `capture/capture.html`/`.css`、`capture/annotation-style.js`、`capture/capture.js`、`main/services/settings-defaults.js`、`settings-normalize.js`、`preload-capture.js`、locales | `.color-wrap` 改为色块按钮 + `#colorPalette` 弹出面板（7 预设 `PRESET_COLORS` + 自定义原生取色器 + ≤3 最近色、会话内存）；`screenshot.annotationColor` 持久化（复用 `settings:update`，零新增 IPC）；`normalizeAnnotationColor`/主进程 `#rrggbb` 归一；顺带拆开 hover/active 共用样式 |
| A4 | `capture/capture.js` | `syncToolbarStyleFromSelection`（仅 UI：色/宽度/第二行选项）+ `applyToolbarColor`/`applyToolbarWidth`；接入 `setSelectedAnnotation`/`syncSelectedAnnotation`/`deleteSelectedAnnotation`/`clearAnnotationsForNewSelection`；`annotationStyle()` 读记忆样式而非工具栏镜像 |
| A5 | `capture/capture.js` | select 工具下 `outsideSelection` 命中测试前移到"重划选区"之前（`!resizeHandle` 守卫保手柄优先），命中即选中 + `beginPendingMove` |
| B1 | `capture/capture.html`/`.css`、`capture/capture.js` | `#toolbar` 转 column 容器 + `.toolbar-row` + `#toolOptions`；`invalidateToolbarSize()` 唯一失效点（resize + 第二行可见性/换族）；`updateFloatingUi` 用容器整体 rect 并 latch `.above`（行序翻转） |
| B2 | `annotation-style.js`、`annotation-geometry.js`、`capture.js`、html/css/locales | `FILL/DASH/RADIUS_PRESETS` + `resolveFill/Dash/Radius` + `dashPattern`；rect/ellipse 填充/线型、rect 圆角（`roundRect`）；命中升级为"环带 ∪ 内部" |
| B3 | 同上 | `drawArrow(startHead,endHead)`（缺省=只画终点）；line/arrow 杆接 `dash` |
| B4 | `settings-defaults.js`、`preload-capture.js`、`annotation-style.js`、`capture.js` | `screenshot.annotationStyles`（8 工具模板=校验白名单）+ `resolveToolStyle`/`resolveToolStyles` 字段级归一 + `toolStyles` 状态 + 旧键一次性迁移 + 整表合并写盘 + 工具栏编辑目标切到 per-tool |
| B5 | 同 B2 | 高亮浓度 `light/medium/strong`（.18/.28/.45，medium=原值）；文字 `bold` |
| B7 | `annotation-geometry.js`、`capture.js` | `penContinuationTarget`（仅最上层笔迹、任一端点、容差 `MAX(width,12)`）+ 抬起原笔迹续写（一帧）+ `pointercancel` 还原 |

新增测试文件：`test/capture-interaction.test.js`（A1/A2/A4/A5 接线）、`test/capture-color-palette.test.js`（A3）、`test/capture-tool-options.test.js`（B1/B2/B3/B5）、`test/capture-pen-continuation.test.js`（B7）、`test/capture-tool-styles.test.js`（B4）；纯函数用例补进 `capture-annotation-style.test.js` / `capture-annotation-geometry.test.js`；设置契约补进 `settings-validation.test.js` / `settings-normalize.test.js`；`capture-i18n.test.js` 的 GOLDEN 追加 31 个新键并更新 `capture.element.move-hint*` 文案。

### 10.2 门禁实况（本机 2026-10-14）

| 门禁 | 基线（开工实测） | 收口实测 | 说明 |
|---|---|---|---|
| `npm test` | 931 / 919 通过 / 12 失败 | **987 / 975 通过 / 12 失败** | 新增 56 条用例全绿；**失败集合与基线逐字相同** |
| `npm run check` | 293 文件；`main.js` 1297/1300；i18n 606 | **302 文件；`main.js` 1297/1300；i18n 605** | 只加键不加未迁移行（TOTAL 反而 -1） |
| locale 键 | 971×3 对称 | **1002×3 对称**，`data-i18n` 217 used / 0 missing | 新键三语齐备 |
| `test:coverage:loaded` | 本机基线未取到（见下） | 92.49% 行（≥85 门槛通过） | 计划记录的 92.78% 来自 Electron 探针可用的环境 |
| 触达模块单文件覆盖率 | — | `annotation-geometry.js` 99.8% / `annotation-style.js` 99.56% / `settings-defaults.js` 100% / `settings-normalize.js` 100%（行） | 新增逻辑全部有单测 |
| `audit:dependencies` | 18 个失效豁免项（既有） | 同 | 本分支 `package.json`/`package-lock.json` 零改动 |
| Playwright e2e | 6/6（计划记录） | **不可执行** | 见 §10.3 |

**环境限制（2026-10-15 更正 → 不成立，已根治）**：原记录称"本会话无法启动 Electron——最小 `app.whenReady()` 冒烟也以 `0x80000003`（STATUS_BREAKPOINT）崩溃，因此 12 个 runtime 探针全是环境性失败"。**2026-10-15 复测证明这是路径误诊**：崩溃源于工作副本路径含中文目录名 `副本`；把 Electron dist 复制到 ASCII 路径（`ELECTRON_OVERRIDE_DIST_PATH`）就 **exit 0**，隐藏窗冒烟 `app ready; displays = 1`，全量 `npm test` **1012 / 1012 / 0**。**随后把整个工作副本迁到纯 ASCII 的 `D:\workspace\Highlighter`，问题彻底消失**（默认环境即全绿）。详见交接文档 **§2.2**（含证据链）。因此：

- 12 个"环境性失败"**不再是既成事实**，而是"工作副本路径含中文"的后果；
- `test:coverage:loaded` 已复现并**超过**计划记录值：**行 92.9%**（计划记 92.78%）；`test:coverage:critical` **93.22 / 94.07 / 92.42** 与 §1.1 记录值逐字相同；
- Playwright e2e **已执行：6 / 6 通过**（已获用户同意，因为会开 app 窗口）。

### 10.3 真机可见窗验收（仍受另一条约束限制，未执行）

`AGENTS.md` 要求可见测试窗放副屏、**无副屏先询问**。本机只有单显示器 1493×933，所以仍未把交互项交给**人眼**验证。注意区分三件事：

- **已做的**：真 Electron 的**隐藏窗**探针（`test/*runtime*.test.js`，全部 `show:false`）—— 2026-10-15 全绿，覆盖捕获渲染层、窗口安全、i18n 热切换、更新演练、打印导出等；Playwright e2e **6 / 6** 也已跑通（会短暂开 app 窗口，用户同意后执行）；
- **仍没做的**：把交互项交给**人眼**验收（右键拖动、滚轮调宽、色板、第二行重摆位、续画、B6 多选/框选的手感与观感）。

T1/T2/B6 的真机验收清单见 §3/§4 各"验收"行与 §10.8 末尾。

### 10.4 偏差记录

1. **B1 与 B2/B3/B5 合并为一个提交**（`27e4499`）：第二行的模型/DOM 管线是共享的，先合 B1 会交付一个可证明为空的行；提交正文按项分述。计划 §8 的"四个 PR 串行"因此打折。
2. **R3 的"三处失效调用点"落地为两处**：`resizeCanvas` + `syncToolOptionsRow`（后者同时覆盖"可见性切换"与"换族"）。契约测试钉住"`toolbarSize = null` 全仓只有一个写点"与调用点计数（定义+2）。
3. **A4 回显范围扩大**：除计划点名的 `setSelectedAnnotation`/`syncSelectedAnnotation` 外，直接置 null 的 `deleteSelectedAnnotation`/`clearAnnotationsForNewSelection` 也补了回显，否则删除后工具栏会停在已删元素的样式上。
4. **B4 旧键双写**：`annotationWidth`/`annotationColor` 继续写（旧构建/回滚仍能恢复最后一次颜色与线宽），`annotationStyles` 为权威结构；init 的逐键回填改为 `applyAnnotationStyles` 整块加载 + 一次性迁移（不写回）。
5. **数据源切换带来的契约更新（C6 同 PR）**：`annotationStyle()`、`setAnnotationWidth`/`setAnnotationColor`、init 断言在 4 个测试文件里同步改写；`capture-annotation-geometry.test.js` 的 pointerdown 顺序断言按 A5 重算索引（对准选区内那一处 `const hit=...`）。
6. **i18n 口径**：新增 31 个键属于"迁移后新增"，GOLDEN 表按此注明；`capture/**` 新增注释一律英文——开工时未迁移 CJK 计数正好卡在 606/606，零余量。
7. **B6 未开工**（多选 + mixed）——**2026-10-15 已由 §10.8 拆两波补齐**，本条保留为当时的偏差记录：计划自己把它标为"风险最大项"，要求对全部单选中路径做 `size===1` 退化改造；其验收（shift 加选、shift 框选、mixed 显示）以交互为主。当时以为"本机无法启动 Electron"（已证为路径误诊，见 §10.2 更正段），故未给真机/e2e 证据；B6 的前置（A1/A4）当时已满足。
8. **未纳入本波的两处顺手项**：`updateElementBar` 的 `elementBarSize` 缓存仍只在 resize 失效（B6 的多选计数会改内容，届时需要同样收敛）；`test/capture-performance-contract.test.js` 等既有契约未受影响，未做"顺带重构"。

### 10.5 真机缺陷修复（2026-10-14 晚，用户实测报告）

**现象**：标注完成 → 钉图 → 右键「重新标注」后，工具栏出现在**截图内侧顶部**、右侧被窗口**截断显示不全**，与首次截图的工具栏位置不一致。

**根因（两处叠加，前者为既有缺陷）**：

1. `main/domains/pin/index.js` 的 `startPinReannotation` 只在 `isRecognitionEditor`（OCR/翻译）分支里给图像下方预留 `actionSpace = 62` 的条带；**普通右键重新标注走的是"窗口 = 钉图本身"**，图像外没有任何空间。
2. 渲染层 `updateFloatingUi` 的落位只有两个候选（区域下方 → 区域上方），都放不下时 `top = Math.max(6, top)` 兜底 —— 于是工具栏被夹到视图 `(6,6)`：纵向落进图像内侧顶部，横向（钉图比工具栏窄时）右侧越界被 `body{overflow:hidden}` 裁掉。B1 的两行工具栏（78px vs 单行 44px）让 62px 的预留条带也不再够用，缺陷因此更容易触发。

**修复**：

1. 落位规则下沉为纯函数 `capture/selection-utils.js: resolveFloatingPlacement`（区域下方 → 上方 → **贴着区域底边停靠在区域内侧**，绝不夹到视图顶部；横向右对齐并夹进视图，超宽时靠 `.toolbar-row { flex-wrap: wrap }` 换行而不是被裁）。`updateFloatingUi` 与 `updateElementBar` 的避让改用同一函数，两条浮层不再各算一套。
2. `main/domains/pin/index.js` 把"预留条带"提到所有重新标注路径（普通右键与 OCR/翻译共用一段逻辑）：`actionSpace = 100`（两行工具栏 78px + 10px 间距 + 6px 边距）、`toolbarSpace = 900`，窗口按工作区缩放图像并居中，`imageBounds` 指向图像矩形、窗口 `transparent: true`，工具栏因此落在**图像下方**，与首次截图同一相对位置。

**验证**：`test/capture-floating-placement.test.js`（新增，含"无空间时停靠内侧底边而不是视图顶部"的回归用例）+ `capture-ocr-pin-ui` / `capture-tool-options` / `capture-selection-resize` 契约同步。全量 994 用例 / 982 通过 / 12 失败（与基线逐字相同，全部是本机无法启动 Electron 的 runtime 探针）；`npm run check` 全绿（303 文件、`main.js` 1297/1300、i18n 605）。**该修复仍未在真机上复核**（本机无法启动 Electron），需用户实测确认。

### 10.6 真机复测第二轮：折行导致条带不够高（2026-10-14 晚）

**复测结论**：§10.5 的修复通过 —— 工具栏出现在图像下方且完整可见。

**新现象**：在重新标注窗口里点击**矩形**工具后，工具栏整体上移、遮住图片下半部分。

**根因（上一轮修复引入的副作用）**：`§10.5` 为"窄窗口不被裁"加了 `.toolbar-row { flex-wrap: wrap }`，而重标注窗口宽度取 `toolbarSpace = 900`；主行单行最小宽度实测约 **1019px**（11 个工具按钮 + 色块 + 3 个宽度按钮 + 13 个动作按钮 + 3 条分隔线，逐个按 `min-width/padding` 累加），因此 900px 窗口下主行**折成两行**。矩形工具再让第二行（选项行）出现后，工具栏高 44px → **112px**，超过预留的 100px 条带 → 渲染层按"下方放不下、上方也放不下"进入**内侧停靠**兜底，表现为整体上移盖住图片。

**修复**：把条带高度从"拍一个常数"改为**按窗口宽度推导**：
- `main/domains/pin/index.js`：`ROW_MIN_CONTENT = 1040`、`STRIP_ROW_HEIGHT = 34`、`OPTIONS_ROW_HEIGHT = 30`、`STRIP_CHROME = 14`、`STRIP_SLACK = 22`；`width` 先算（非循环依赖），`stripRows = ceil(ROW_MIN_CONTENT / (width - STRIP_CHROME))`，`actionSpace = stripRows * STRIP_ROW_HEIGHT + OPTIONS_ROW_HEIGHT + STRIP_CHROME + STRIP_SLACK`。`toolbarSpace` 提到 **1088**，让主行在工作区允许时保持**单行**（条带只需 100px；折成两行时自动变成 134px）。
- `test/capture-floating-placement.test.js`：新增不变量测试 —— **从 `capture.html` / `capture.css` 现算主行单行最小宽度**，断言 `ROW_MIN_CONTENT` ≥ 实测值、`toolbarSpace - STRIP_CHROME - 20` ≥ 实测值、以及一行/两行/三行三种折行下条带都容得下工具栏 + 16px。以后任何人往主行加按钮（或改按钮尺寸）而忘了同步常数，这条会先红。

**状态**：待真机复测（本机仍无法启动 Electron；`npm test` 191/192，唯一失败是本机 Electron 探针）。

### 10.7 小选区工具栏"过于靠左"：方案 1 落地（2026-10-14 晚）

**复测结论**：§10.6 的修复通过（点矩形工具后工具栏原地不动）。

**新现象**：截图区域较小时工具栏过于靠左、操作不便。**实测根因**（一次性脚本 `.tmp/gates/measure-strip.js` 现算）：主行单行最小宽度 **937px**、工具栏元素宽 **951px**（占 1493px 显示器的 64%）；横向规则是"右缘对齐选区右缘，越界夹进视图"，因此**只要选区右缘 < 957px，`left` 就被夹到 6**（屏幕最左边），而选区正下方只剩动作按钮，画图工具最远离选区 ~600px。旧代码同一公式 —— 属既有体验缺陷，非本次改动引入。

**采纳方案 1**：右对齐装得下时**逐字不变**；装不下时改为**居中到选区中心**（`clamp(anchorX + anchorW/2 − width/2, padding, maximumLeft)`），不再夹到屏幕左缘。改动仅在 `capture/selection-utils.js: resolveFloatingPlacement`（两个分支），工具栏与元素条共用，故小元素条同样受益。右越界情形不受影响（居中的结果与原来的右夹紧同解）。

**实测前后（200×200 选区，显示器 1493）**：

| 选区 x | 改前 left | 改后 left | 选区中心 ↔ 工具栏中心（改前 → 改后） |
|---|---|---|---|
| 100..300 | 6 | 6 | 282px → 282px（贴屏左，物理无解） |
| 400..600 | 6 | **25** | 19px → **1px** |
| 600..800 | 6 | **225** | 219px → **1px** |
| 900..1100 | 149 | 149 | 376px（右对齐，未受影响） |
| 100..1300（宽选区） | 349 | 349 | 125px（未受影响） |

**测试**：`test/capture-floating-placement.test.js` 新增"装不下时居中、贴屏左仍为 6、右对齐装得下逐字不变、越右边界仍夹最右、居中不比夹最左更远（性质断言）"以及"源码必须同时保留右对齐与居中两个分支"。全量 997 用例 / 985 通过 / 12 失败（失败集合与基线逐字相同）；`npm run check` 全绿（303 文件、`main.js` 1297/1300、i18n 605）。

**未做（待定）**：方案 3b（11 个动作收进溢出面板、主行降到 ~566px）是根治但属独立立项。（**方案 2 已于 2026-10-15 落地**：采用"`initData.imageBounds` 时跳过本方案"的协同方式，见 §10.9。）方案 1 的剩余局限：选区落在屏幕左侧约 2/3 以内且工具栏仍无法居中时（上表第一行）只能贴左，需方案 2/3b 才能进一步改善 —— 方案 2 落地后该行的工具组已横向覆盖到选区（见 §10.9 实测表）。**待真机复测**。

### 10.8 B6 多选 + mixed 态落地（2026-10-15，按 §10.4-7 的缓解措施拆两波）

> 状态：**B6 已开发完成**（wave 1 + wave 2 两个提交），计划内已无未开工项。交互语义仍**待真机复测**（本机 Electron 起不来，见 §10.2）。

**为什么拆两波**：§10.4 偏差 7 记录 B6 是"风险最大项"（单选中路径要系统性过 `size===1` 退化），且验收以交互为主。故 wave 1 = shift 加选/减选 + mixed 显示 + 批量编辑，wave 2 = shift+空白拖框选。

**状态模型（保住单选中路径的关键取舍）**：`selectedIds: Set<number>` 是**权威集合**，`selectedAnnotation` 退化为"主选中项/anchor"。于是既有 **15 个** `selectedAnnotationItem()` 调用点（`optionRowTool` / `rowToolOptions` / `toolbarStyleTool` / `displayedToolWidth` / `canStepAnnotationWidth` / `optionRowTool` / 8 手柄缩放 / 层级 / Esc …）全部**一行不改**地保持 B6 之前的语义；多选能力只在新路径上叠加。

| 波次 | 交付 |
|---|---|
| wave 1（提交 `3effa97`） | ① `selection-utils.js` 新增纯函数 `revalidateSelection`（快照还原后按 id 存活）与 `commonSelectionValue`（共同值 / mixed 为 `null`）；② shift+左键在**命中 / 已选中体内 / 选区外命中**三处加减选，shift+右键**只加选**（右键是拿起即拖的手势）；③ mixed 回显：`applyToolbarSelection` —— 色分岔时色块加 `.mixed`（对角分裂色）并清空全部预设 active，宽度分岔时 3 个宽度按钮全灭活，第二行按字段取共同值（`String(null)` 匹配不上任何按钮 = 无 active）；④ 批量编辑：色/宽/选项一条补丁落到**整个选中集**且仍是**一帧**，并按目标工具归属过滤字段（`ownsAnnotationField`，混合类型不会给 pen 塞 fill）；⑤ Delete / 方向键覆盖整个选中集（仍一帧）；⑥ `#elementBar` 计数（`capture.element.selected-count`，三语）+ `elementBarSize` 收敛到唯一失效点 `invalidateElementBarSize()`（resize 也改走它）；⑦ 每个选中项都画虚线框（`drawSelectionOutlineBox`），**8 个缩放手柄仍只在 anchor** 上 |
| wave 2（提交 `d8d46ab`） | ① `selection-utils.js` 新增纯函数 `rectsIntersect`（闭区间相交，贴边算命中；退化盒 h=0 / w=0 仍可被框到）；② shift+空白拖 marquee：**只增不减**（手势要求 shift）、阈值内视为纯 shift 点击**保留原选中集**（避免误清空）、pointerup/pointercancel/无按键 move 自愈三处收口、绘制在最后且**不进入导出** |

**明确未做（留给后续立项，不是遗漏）**：
1. **多选整体拖动**（拖一个动整组）：`pendingMove` 的形态被 `test/capture-annotation-geometry.test.js:709` 钉死（`{ id, origin, start, thresholdPassed }` + 唯一创建点），整组拖动要扩形态并同步三处收口路径，风险高于收益；当前语义是"拖动命中的那一项，其余保持选中"。
2. **层级 ↑↓ 在多选下仍只作用于 anchor**（与拖动同源）。
> 两项都建议与 §4.2 的方案 2/3b 一起评估（那时会碰落位与主行结构，回归面本来就大）。

**门禁实况（2026-10-15，工作副本 `D:\workspace\Highlighter`，默认环境只需清 `ELECTRON_RUN_AS_NODE`）**：`npm test` → **1012 用例 / 1012 通过 / 0 失败**；`npm run check` → 全绿（**304 文件** · `main.js` 1297/1300 · i18n **605 ≤ 606** · locale **1003 × 3 对称**）；`npm run test:e2e` → **6 / 6**（34.1s）；`test:coverage:loaded` → **行 92.9%**（≥85）；`test:coverage:critical` → 93.22 / 94.07 / 92.42。其中 **`capture-renderer-runtime` 等真 Electron 渲染层探针真的跑了**，也就是说 B6 的接线（选中集合、mixed 回显、`elementBarOverlap`、方向键微调）拿到了**真渲染层证据**，不再只有源码契约。旧的中文路径副本下同样代码是 1012 / 1000 / 12（12 个假失败全部由路径导致，见交接文档 §2.2）。新增 `test/capture-multi-select.test.js`（纯函数 + 接线契约），并同步更新了 5 个契约测试文件（pointerdown 分支形态、单一写回点、`syncSelectedAnnotation`/`deleteSelectedAnnotation` 窗口、解构清单、GOLDEN 表）。

**待真机复测（人眼，本机单显示器无副屏 → 需用户配合或先征得同意再开可见窗）**：shift 加选/减选（含右键只加）、mixed 三态（色分裂 / 宽度全灭 / 第二行字段无 active）、批量改色改宽改选项各一帧且 Ctrl+Z 一步回退、批量 Delete、多选方向键、框选加选、**框选阈值内 shift 点击不清空选中**、框选期间 pointercancel 与"拖动那一项其余不动"。

### 10.9 方案 2 落地：工具栏宽度跟随选区（2026-10-15）

> 状态：**已开发完成**，纯函数 + 真渲染层探针都有断言；观感/手感仍待真机复测（见文末）。用户在本会话选定"只做方案 2"，方案 3b 仍待独立立项。

**做了什么**：`#toolbar` 不再只用"视口 − 20px"这一个上限。渲染层每帧按选区算一个更紧的上限，落到元素的 inline `max-width`：

- 新纯函数 `capture/selection-utils.js: toolbarWidthLimit({ anchor, viewport, minimum, slack, margin })`
  = `min(视口宽 − margin, max(minimum, 选区宽 + slack))`，默认 `420 / 160 / 20`。**上限只收窄、从不撑宽**：宽选区与全屏选区算出的上限大于条的 max-content（实测 951），因此**渲染逐字不变**。
- `capture/capture.js`：唯一写点 `applyToolbarWidthLimit()`（写 `toolbar.style.maxWidth`，且仅在上限变化时才写 DOM），调用点只有 `updateFloatingUi()` 一处 —— 而 `renderOverlay()` 每帧都走它，所以**选区变化与窗口 resize 都自动跟随**，不需要额外的 resize 钩子。
- 上限变化 = 高度变化（折行）→ 必须走既有唯一失效点 `invalidateToolbarSize()`；`updateElementBar()` 在同一帧里读同一份缓存 rect，元素条避让不落后。
- **钉图重新标注跳过本方案**：`stripFollowsRegion()` = `!initData.imageBounds`。该流程是唯一由主进程下发固定 `imageBounds`、并按"单行条带"预留 `actionSpace` 的路径（`main/domains/pin/index.js` 的 `stripRows`），折行会顶穿预留条带把工具栏推回图像上；跳过时清空 inline `max-width`，回落 `capture.css` 的 `calc(100vw - 20px)`。

**实测前后（`.tmp/gates/measure-plan2.js` 现算；1493×933 下主行 min-content **937**、条宽 **951**，与 §10.7 逐字一致）**：

| 选区（y=500..700） | 改前 left | 改前 工具组↔选区 | 改后上限 | 改后 left | 改后 工具组↔选区 |
| --- | --- | --- | --- | --- | --- |
| 100..300（200） | 6 | 0 | 420 | 6 | 0 |
| 400..600（200） | 25 | 8 | 420 | **180** | **0** |
| 600..800（200） | 225 | 8 | 420 | **380** | **0** |
| 900..1100（200） | 149 | **384** | 420 | **680** | **0** |
| 1200..1400（200） | 449 | **384** | 420 | **980** | **0** |
| 100..1300（1200，宽） | 349 | 0 | 1360（> 951，不生效） | 349 | 0 |

即"画图工具组离选区最远 ~600px"的既有缺陷，在右半屏选区上从 **384px → 0**（工具组横向覆盖到选区），左半屏小选区也从 8px → 0。代价：选区窄于 ~791px 时条会从 1 行折成最多 3 行（高度 78 → **144**），落位按实测 rect 计算，仍整体在视口内（不够下方时按既定规则翻到上方/内侧贴底）。

**测试（同提交）**：
- `test/capture-floating-placement.test.js` 新增 4 条：纯函数（下限/视口上限/整数与退化入参）、落位性质（上限变小后"右对齐到选区右缘"这一分支才真的装得下）、单一写点 + 唯一调用点 + 钉图 opt-out 的源码契约。
- 同步更新 3 个既有契约：`test/capture-tool-options.test.js`（失效点计数 3 → 4）、`test/capture-selection-resize.test.js`（`window.selectionUtils` 解构清单）、`test/capture-annotation-geometry.test.js`（`updateFloatingUi` 的 pinned 窗口）。
- `test/capture-renderer-runtime.test.js` 新增 `window.__pr.stripWrap()` **真渲染层测量**（隐藏窗）：200px 选区 → inline `420px`、**渲染宽度 420px**、主行实测 96px（真的折行）；宽选区仍是视口上限 `780px`（800px 探针窗）；同一选区在 `initData.imageBounds` 下发时 **无 inline 上限**、渲染 438px（opt-out 在渲染层真实生效）。

**门禁实况（2026-10-15，纯 ASCII 工作副本，默认环境只需清 `ELECTRON_RUN_AS_NODE`）**：`npm test` → **1001 用例 / 1001 通过 / 0 失败**（本 clone 基线 997，+4 = 本次新增契约；文档他处记的 1012 含另一条工作线的两个**未跟踪**测试文件，本 clone 没有）；`npm run check` → **全绿**（`main.js` 1297/1300 · i18n **605 ≤ 606** · locale 1003×3 对称）；`test:coverage:loaded` → **行 92.9%**（≥85，与基线逐字相同）；`capture-renderer-runtime` 真 Electron 探针真的跑了。

**踩到的坑（新增一条给后续会话）**：i18n 门禁**零余量**（605/606），本次在 `capture/` 的新注释里写了"方案 2"三个中文字 → TOTAL 立刻 608 > 606 exit 1。**`capture/`、`main/` 等扫描区里的新注释一律英文**（写成 `Plan 2 (D12)` 即可）。

**待真机复测（人眼）**：小选区（≤420px 宽、以及 420~791px 的中等选区）下条的折行观感与贴选区手感；选区拖拽过程中上限实时跟随（不跳变）；工具栏折到 3 行时下方放不下会翻到选区上方/内侧贴底；钉图编辑器里条宽与以前逐字一致（opt-out 生效）。





