# 截图工具栏交互体验对比调研：Highlighter vs Snow Shot

> 调研日期：2026-10-14
> 调研对象：Highlighter v2.5.0（`D:\workspace\Highlighter - 副本`，Electron 43.2.0 + Canvas 2D） vs Snow Shot（`D:\workspace\snow-apps-main`，Qt6/C++ + Rust 自研绘图引擎）
> 方法：双项目源码只读调研（codegraph + 行级精读），不改任何产品代码。所有结论均附 文件:行号 引用。
> 关联文档：`docs/plans/2026-10-10-snow-apps-feature-gap-analysis.md`（全仓功能对标，v2.3.1 基线）、`docs/plans/2026-10-10-p0-gap-closure-plan.md`（P0 落地计划及实施记录）

---

## 0. 结论先行（TL;DR）

用户感知的「Snow Shot 工具栏丝滑」不是单一功能，而是 **6 根支柱的乘积**：

| # | 支柱 | Snow Shot | Highlighter v2.5.0 现状 |
|---|------|-----------|------------------------|
| 1 | 选工具 → 第二行"按需展开"的专属选项 | 有（垂直堆叠多行面板，无闪烁切换） | 无（单行工具栏已近满宽 866px/900px 视口，样式控件常驻一行） |
| 2 | 画完即选中、直接拖动/缩放 | 有（quick selection + Pending→Editing 阈值升级） | **有**（P0-5 已于 2026-10-11 批次 B 落地：选中/拖动/8 手柄缩放/层级/删除/undo） |
| 3 | 右键拖动、滚轮调粗细等零切换操作 | 有 | 无 |
| 4 | 工具栏贴选区智能换位（翻面+行序翻转） | 有（多候选+全行占位判定+手动拖动即停） | 部分（静态避让：右下角优先翻上方，无内容变化重摆位） |
| 5 | 样式"双目标"写入 + per-tool 记忆 + mixed 态 | 有 | 部分（改样式同时作用于选中项与后续创建；但颜色不持久化、无预设色板、无 mixed） |
| 6 | 截图/录屏/贴图共享同一绘图引擎 | 有（4 处共用 SnowCanvasWidget） | 无（capture/** 与 record/** 完全独立，连线宽白名单都不同：2/4/8 vs 2/4/7） |

**关键前提修正**：旧差距文档 `2026-10-10-snow-apps-feature-gap-analysis.md` 判定的「标注元素二次编辑 = 无」是 v2.3.1 基线的过时结论——**P0-5 已在 v2.5.0 落地**（p0-gap-closure-plan.md §20，PR1–PR4，2026-10-11，测试 855/855 通过、覆盖 92.62%）。今天对比的正确基线是：**单元素编辑已齐，差距集中在「工具栏形态」与「操作效率」两层**。

---

## 1. 主题一：工具栏的行形态 —— "第二行"机制

### 1.1 Snow Shot 的实现

**布局结构**（`snow_shot/src/presentation/tools/screenshottoolpalette.cpp`）：
- 根布局 `m_rootLayout` 为垂直堆叠，行序（截图工具栏贴选区下方时）：主工具行 `m_mainPanel` → 裁剪面板 → 动作行 `m_selectActionPanel`（识别类工具）→ **样式行 `m_rectangleStylePanel`**（名字历史遗留，实际是所有样式行堆叠的容器）→ 录屏导出行，全部 `Qt::AlignRight` 右对齐（screenshottoolpalette.cpp:4644/9848/9850、createSecondaryToolbarShell :6841-6869）。
- **选矩形工具 → 第二行瞬间出现**：`setActiveTool(Tool)`（:1906）→ `ensureStyleFamily(tool)`（:9258）**惰性物化**目标家族的行（`MaterializationState{Uninitialized, Constructing, Ready}` 三态守卫，首用才构建，二次进入 0 开销）→ `setStyleControlsActive(tool)`（:10000）按 binding 切换可见性 → `applyActiveToolSecondaryToolbarVisibility`（:10068）→ `commitLayout`（:3390）同步几何提交。**无 QPropertyAnimation——瞬时替换，靠几何同步提交保证即时反馈**。
- 矩形家族的第二行内容（`buildShapeFamily`，screenshottoolpalettestylecontrols.cpp:1593）：`[形状种类单选 矩形/椭圆/菱形] | [描边编辑器=颜色+线型 实线/虚线/点线] | [笔画粗细预设编辑器] | [填充编辑器=颜色+填充样式] | [圆角半径编辑器]`。箭头家族（buildArrowFamily :1796）则是：描边 | 粗细 | 起点箭头 | 杆型 | 终点箭头。**每族一行，族内变体（矩形/椭圆/菱形）是行内单选组（AdRadioButtonGroup），不占新行**。
- **无闪烁的关键——编辑器复用**：每个样式编辑器带 role+signature（kRoleOutlineStroke/kRoleOutlineWidth/kRoleShapeFill…），家族间切换时 `prepareStyleReconcile` 计算**共享角色交集**（stylecontrols.cpp:1166），同角色编辑器（如笔画粗细按钮）通过 `takeReusableEditor` reparent **原地保留、不销毁重建**；未激活家族的编辑器由 `parkStyleEditors`（:947）/`restoreStyleEditors`（:1034）按 (tool, role) 停泊。测试钩子 `m_lastReconcileStats{retained, created, destroyed}` 专门验证复用率。
- **行序翻转**：工具栏翻到选区上方时 `updateToolbarRowGeometry`（:9817）把行序倒置，让样式行始终贴近选区边缘（`setStyleToolbarAboveMain` :1531）。

### 1.2 Highlighter 现状（capture/capture.html + capture.js）

- 工具栏是**单行 flex**（capture.html:28-52）：11 个工具按钮 + 颜色 input[type=color] + 三档粗细按钮（data-annotation-width=2/4/8 **常驻显示**）+ undo/redo + 11 个动作按钮（longCapture/qr/table/ocr/translate/record/pin/save/exportPdf/copy/close），已近满宽（实测 866px/900px 视口）。
- **没有"工具 → 专属选项行"的概念**：颜色/粗细对矩形、椭圆、箭头、画笔、高亮全部生效，无论当前什么工具都显示同一样式控件。好处是简单一致，代价是：
  - 无法提供矩形专属的填充样式、圆角、线型（实/虚/点线）等选项——**不是没实现，是没有地方放**；
  - 900px 视口已满，加任何控件都会折行或溢出。
- 录屏端 record.html:31-57 反而实现了「色块+数字复合按钮+下拉」的省空间模式（7 色预设色板+线宽复合按钮），两端口径不一。

### 1.3 差距与可借鉴度

| 设计点 | Snow Shot | Highlighter | 可借鉴度/成本 |
|---|---|---|---|
| 第二行按工具展开 | 垂直多行面板+惰性物化 | 无 | **高价值低成本**：HTML/CSS 二行 div 按工具切换，比 Qt 的 reparent 机制简单得多 |
| 同角色编辑器原地复用（无闪烁） | role/signature 机制 | 不适用（无行切换） | 若做二行可直接用按 role keyed 的 React/JS 组件保持 DOM 节点 |
| 族内变体=行内单选组 | AdRadioButtonGroup | 无 | 做第二行时顺带获得 |
| 行序翻转（上方放置时倒序） | updateToolbarRowGeometry | 无 | 低成本，跟随第二行实现 |
| 17 个 per-tool 样式键持久化 | screenshotcanvastoolstyles.cpp:52-68 | 线宽有（saveAnnotationWidth），颜色无 | **高价值**：颜色+线宽一起持久化，Electron settings 一行配置 |

---

## 2. 主题二：画完之后的编辑交互

### 2.1 Snow Shot 的实现（Rust 引擎内做）

**状态机** `InteractionState`（snow_draw_engine_qt/crates/snow-draw-engine-editor/src/state.rs:443-458）：Idle | CreatingXxx | MarqueeSelection | **PendingSelectionMove** | EditingSelection | EditingArrow | EditingMagnifier…

**核心机制**：
- **Pending→Editing 阈值升级**（state.rs:270-280）：点选先进入 Pending，**超过拖动阈值才升级为移动**——一次点击绝不产生移动事务，防误移。
- **quick selection**（input/quick_selection.rs:18-40）：当前即使是绘图工具，也可命中已画元素并选中；**右键快速选中**（handle_secondary_selection_pointer_down :42-105）：任何绘图工具下右键点标注 = 选中 + 直接拖动，shift+右键切换选中。**这是"零切换操作"的核心**。
- **空白处按下"先取消选中"**（pointer_idle.rs:301-389，注释 :308-312）：同一按压绝不既取消又创建。
- **EditSelectionState 快照 + 事务提交**（state.rs:227-243）：拖动中编辑的是 preview 快照，pointer-up 才提交 undo 事务，撤销粒度=一次完整手势。
- **缩放模式** `SelectionEditMode::Resize`（state.rs:206-224）支持 8 向手柄 + Alt+拖=从中心缩放 + 旋转（Rotate start_pointer_angle）+ 圆角手柄（CornerRadius{corner}）。
- **命中解析** resolve_canvas_hit（input/hit_resolution.rs:8-267）优先级：单选箭头手柄 > 选择框（padding 按 zoom 缩放）> 放大镜柄 > quick_selection 策略门（AutoFilter 用 quick_selection_disabled_tools u64 位掩码锁死）> paint_order 自顶向下元素 hit-test > 兜底。EditingSelection 期间用 preview 快照命中，拖动中 hover 仍正确。
- **滚轮调笔画粗细**：工具激活时画布滚轮直接调粗细（screenshotoverlayinputhandler.cpp:825-943，wheelAdjustsStrokeWidth :31-45 覆盖 Shape/SpeechBubble/Arrow/Line/FreeDraw/RectangleHighlight/PenHighlight/Distance）。
- **旋转感知命中**：snow_canvas_widget_selection_hit_testing.cpp 把点按 -item.rotation 反旋转回元素局部系再判命中。

### 2.2 Highlighter 现状（P0-5 已落地）

capture/capture.js + annotation-geometry.js（2026-10-11 Wave 6 PR1–PR4 落地）：
- 选中：findAnnotationAt 逆序取最上层 + 分形状命中（rect/ellipse 只认描边环带，空心区不吞拖动；annotation-geometry.js）。
- 拖动：moveAnnotationTo 从 origin 生成新副本（capture.js:594），**0 位移不压 undo 帧**；方向键微调 1px/Shift 10px（nudgeSelectedAnnotation :640），500ms 静默收口合并成帧。
- 缩放：8 向手柄（selectedResizeHandle :686），resizeAnnotationToBox 每帧从 origin/originBounds 重算（:697），JSON.stringify 逐字段比较决定是否压帧（:712）。
- 样式：离散（线宽按钮）立即压帧 vs 连续（取色器 input）300ms 合帧分开（commitSelectedStyle :760 / stageSelectedStyle :771）。
- 层级/删除：reorderSelectedAnnotation（:798）+ deleteSelectedAnnotation（:550，serial 删除不重编号）。
- undo/redo：深拷贝快照栈，上限 60（snapshotAnnotations :509）。
- 选中浮动条 elementBar（capture.html:54-62）：bbox 右下/上方翻转、与主工具栏重叠避让（updateElementBar capture.js:397）。
- 自愈防御：pointerup 被模态框/系统手势吞掉时，无按键的 pointermove 收口（:972-984）；pointercancel 全部复位。

**已知的 P0-5 遗留短板**（p0-gap-closure-plan.md §20.3 偏差记录）：
1. text/serial 缩放只能落 width 预设（2/4/8），bbox 与虚线框可能不吻合（绘制模型上限）；
2. 元素手柄命中 6px < 选区 8px，≲12px 元素只能缩放不能拖动；
3. 元素被甩出选区后无法再选（选区与元素包含关系的分支顺序问题，未修）；
4. Esc 不进快照栈。

### 2.3 差距与可借鉴度

| 设计点 | Snow Shot | Highlighter | 可借鉴度/成本 |
|---|---|---|---|
| 单元素选中/拖动/缩放/undo | 有 | **有（P0-5）** | 已补齐 |
| 点击 vs 拖动阈值区分 | Pending 阈值升级 | 无（点击即可能产生微移帧，但 0 位移不压帧缓解） | 低成本：pointerdown 记原点，移动 <3px 不进入 move 态 |
| 右键快速选中拖动 | 有 | 无（右键无语义） | **高价值低成本**：contextmenu + hit-test 即可 |
| 滚轮调笔画粗细 | 有 | 无 | **高价值低成本**：wheel 事件 + width 预设循环 |
| 旋转 | 有（Rotate 手柄+角度感知命中） | 无 | 中成本：需 rotation 字段 + 命中测试反向旋转 |
| 多选 + mixed 样式 | 有（SelectionState ids+primary，上限 1e6） | 无 | 中成本：选中集合 + 框选 marquee + mixed 显示 |
| 对齐分布/透明度/复制 | alignSelectedElements 等 40+ 命令 | 无 | 低优先级 |
| 画笔端点续画 | resolve_free_draw_endpoint | 无 | 低成本高体验（画笔工具高频用户） |
| Alt+拖=复制 | try_begin_duplicate_drag | 无（Alt 用于移动选区逃生门） | 低成本 |

---

## 3. 主题三：工具栏智能行为（定位/换位/常驻）

### 3.1 Snow Shot

- **贴选区右下、放不下翻上方 + 行序翻转**：`anchoredToolbarPlacement`（screenshotgeometry.cpp:1134-1203）右对齐选区右缘，先试下方 `fullyVisible`（occupiedRect = occupiedContentRect **含次级行整体** ∪ 主行），不行翻上方，再不行钳制在下方保确定性。翻上方时 setStyleToolbarAboveMain(true) 行序倒置。
- **内容变化主动重摆位**：`setActiveToolAndReposition`（screenshottoolbarwindow.cpp:463-473）→ repositionToolbarForContentChange 命令链（screenshotselectioneditworkflow.cpp:168-176）——第二行展开导致工具栏变高时自动重算位置，**保证工具栏永远完整可见**。
- **用户手动拖动后停用自动换位**（`m_manuallyDragged` :470），新截图 resetForNewCapture 重置。
- **弹窗期工具栏存活**：popup 打开时 popupInteractionBegan/Ended（stylecomponents.cpp:207-256）通知服务层保持工具栏存活/置顶；`containsInteractiveGlobalPoint`（floatingtoolpalettewindow.cpp:421）把弹窗打开区域计入工具栏 hover 判定，避免移入弹窗时误收起。
- **置顶抗抢占**：raiseToolbarForCanvasInteraction + QTimer::singleShot(0) 二次 raise（screenshottoolbarpresenter.cpp:129-153）。
- **DPI 稳定**：AdDpiStableWindowController 跨显示器拖动不跳变（floatingtoolpalettewindow.cpp:74-100）。

### 3.2 Highlighter

- updateFloatingUi（capture.js:435）：工具栏 = 选区右下角 +10px，底部放不下翻上方，clamp 6px。**单公式静态避让，无内容变化重摆位**——第二行出现（若实现）导致高度变化时不会自动重算。
- elementBar 有两段式避让（先试选区上方再落工具栏下方，capture.js:397-433）。
- 无手动拖动工具栏能力，自然无"手动后停用自动换位"。

### 3.3 差距与可借鉴度

| 设计点 | Snow Shot | Highlighter | 可借鉴度/成本 |
|---|---|---|---|
| 贴选区+翻面 | 有 | 有（静态公式） | 已有基础 |
| 内容变化重摆位 | 有（命令链） | 无 | **做第二行时必须同步做**，否则第二行展开可能出屏 |
| 全行占位判定 | occupiedRect 含次级行 | 无 | 做第二行时顺带 |
| 手动拖动停用自动换位 | 有 | 无（无手动拖动） | 低优先级 |
| 弹窗期 hover 判定 | 有 | 不适用（无弹窗编辑器） | 若做弹出式颜色面板需考虑 |

---

## 4. 主题四：样式状态与持久化

### 4.1 Snow Shot

- **17 个 per-tool 配置键**（screenshotcanvastoolstyles.cpp:52-68）：drawing/shape_style、drawing/arrow_style、drawing/text_style…每个工具独立记忆颜色/粗细/填充，跨会话持久化。
- **双目标写入**（applyScreenshotCanvasToolStyles :666-707，注释 :669）：修改样式**同时作用于当前选中元素与后续创建**——所见即所改，不需要"先选中再改"还是"先改再画"的心智负担。
- **mixed 态**：多选元素样式不一致时编辑器显示混合态（WidthColorEditor::update 传 mixed 参数，stylecontrols.cpp:1132），而非任选一个值显示。
- **合并防陈旧**：persistScreenshotCanvasStyleEdit（:641-664）**总是与最新存储合并**（:646 注释："Always merge against storage, never an editor's potentially stale snapshot"）。
- **样式状态回推**：canvasStyleToolbarState()（snow_canvas_widget.cpp:1055-1075）经 FFI 从 Rust 引擎拉样式栏状态，textInteraction 活跃时 source=SelectedText——**选中一个元素时第二行自动变成该元素的样式编辑器**（选中矩形 → 显示矩形的填充/描边/圆角），且 mixed 位掩码驱动增量刷新组（screenshottoolpalettestylecontrols.cpp:7180-7243：ShapeModeRefresh/StrokeWidthRefresh/FillRefresh/CornerRefresh 等）。

### 4.2 Highlighter

- setAnnotationWidth（capture.js:475）：有选中项时 commitSelectedStyle({width}) 改选中项，无选中时改全局默认并 saveAnnotationWidth 持久化——**已有"双目标"的雏形**（宽度维度）。
- 颜色：原生 input[type=color]（系统取色器弹窗），**不持久化**、无预设色板；hover 与 active 共用样式（capture.css:98）。
- setSelectedAnnotation（capture.js:501）只置变量+render，**不回显选中项的样式到工具栏**——选中一个红色矩形，工具栏颜色仍显示上次的全局色，改色瞬间矩形变工具栏色。与 Snow Shot 的"选中即回显"相反。
- 录屏端有 7 色预设色板（record.html:31-57），截图端反而没有。

### 4.3 差距与可借鉴度

| 设计点 | Snow Shot | Highlighter | 可借鉴度/成本 |
|---|---|---|---|
| 宽度双目标写入 | 有 | **有**（P0-5 顺带） | 已有 |
| 颜色双目标写入 | 有 | 部分（stageSelectedStyle 有选中路径） | 补齐即得 |
| per-tool 样式记忆 | 17 键 | 无（单一全局色+宽） | 低成本：settings 加结构化键 |
| 颜色持久化+预设色板 | 有 | 无（录屏端有，未复用） | **高价值低成本**：7-10 色预设 + 最近使用 |
| 选中项样式回显 | 有（状态回推） | 无 | **高价值**：选中红色矩形时色板高亮红色 |
| mixed 态 | 有 | 无（无多选） | 随多选一起做 |

---

## 5. 主题五：渲染与架构（为什么 Snow Shot 敢做这么重的交互）

### 5.1 Snow Shot

- **双渲染器分工**：裁剪选区视觉（遮罩/边框/手柄/辅助线）走 Qt ScreenshotCanvasRenderer（3610 行，damage 追踪 addDamage :560，**>64 个脏矩形退化外接矩形**防碎片化）；标注走 Rust 引擎瓦片化渲染 renderSceneItemsTiled（snow_canvas_widget.cpp:3040，scene_revision 比对 + 滤镜瓦片缓存 + exposedRegion 裁剪 + 画笔蒙版图集）。
- **一处引擎四处复用**：SnowCanvasWidget 被截图 overlay（screenshotoverlaycanvaswidget.cpp:23）、**录屏区域窗口（screenrecordingareawindow.cpp:107：`m_canvas(new SnowCanvasWidget(*m_canvasRuntime, this))`）**、贴图（screenshotpinnedwindow.cpp:1062 ScreenshotPinnedCanvasWidget 继承 SnowCanvasWidget）、全局画布（globalcanvascontroller.cpp:79）共用——**同一个标注编辑器、同一套交互、同一份样式记忆出现在四个场景**。
- **交互全在 Rust 引擎内做**（hit-test/选择/命令/undo），Qt 层只做呈现与命令转发（C FFI），保证行为一致性。

### 5.2 Highlighter

- capture/**：Canvas 2D，requestAnimationFrame 节流整帧重绘（render capture.js:338）。标注数据是普通 JS 对象数组，undo=深拷贝快照栈。整帧重绘在元素多时有性能上限，但当前规模（手工标注十几个元素）完全够用。
- record/**：**完全独立**的另一套（IPC 快照烧入视频帧，undo=pop 无 redo、无二次编辑、无选中）。两端的线宽白名单都禁止混用（2/4/8 vs 2/4/7）。
- 架构判定沿用旧文档结论：**Qt 级自研渲染引擎明确不跟**（Canvas+原生边车路线），但"共享一个标注引擎模块"的思路值得跟。

### 5.3 差距与可借鉴度

| 设计点 | Snow Shot | Highlighter | 可借鉴度/成本 |
|---|---|---|---|
| 截图/录屏/贴图共享标注引擎 | 4 处共用 SnowCanvasWidget | 3 处独立实现（capture/record，pin 用 screenshot） | **高价值中成本**：抽 annotation-core.js（几何/命中/样式/undo 纯函数），两端薄壳 |
| 脏矩形重绘 | 有 | 无（整帧重绘） | 暂不需要（规模小）；若做长图拼接标注可参考 |
| scene_revision 比对 | 有 | 无（render 无条件重绘） | 低成本微优化 |

---

## 6. 改进建议（按 用户感知强度 × Electron 实现成本 排序）

### 第一梯队（高感知 × 低成本，立即可做）

1. **右键快速选中+拖动标注**（对标 quick_selection.rs:42-105）
   - capture.js pointerdown 已有完整 hit-test 基建（findAnnotationAt），加 contextmenu/右键分支即可。
   - 语义：绘图工具下右键点标注 = 选中并进入拖动；右键空白 = 现有行为。**这是 Snow Shot"零切换"体验的最大单点**。
2. **滚轮调笔画粗细**（对标 wheelAdjustsStrokeWidth）
   - capture.js 加 wheel 监听：绘图工具激活且指针在画布上时，滚轮在 width 预设（2/4/8）间步进，工具栏按钮同步高亮。配合选中项时 commitSelectedStyle({width})。
3. **颜色持久化 + 预设色板**（对标 17 键 + AdColorPicker 预设）
   - 把录屏端已有的 7 色板组件（record.html:31-57）搬到 capture 端，替换原生 input[type=color] 触发器；saveAnnotationColor 落 settings（已有 saveAnnotationWidth 同款管道）。
   - 顺带修 hover/active 同样式问题（capture.css:98）。
4. **选中项样式回显**（对标 canvasStyleToolbarState 回推）
   - setSelectedAnnotation 时把选中项 color/width 回显到工具栏控件（+色板高亮）。P0-5 已有全部数据，只差回写 UI。

### 第二梯队（高感知 × 中成本，构成"第二行"体验）

5. **工具专属第二行选项栏**
   - 结构：capture.html 工具栏容器加第二行 div，按工具切换内容（矩形 → [填充样式|线型|圆角]；箭头 → [起点样式|终点样式|杆型]；文字 → [字号|粗斜体]）。JS 侧按 role 保持同角色控件 DOM 复用（Snow Shot 的无闪烁机制的 HTML 简化版）。
   - **必须同步做**：第二行出现/消失时 updateFloatingUi 重摆位（对标 repositionToolbarForContentChange）+ 占位矩形按全行计算（对标 occupiedContentRect 含次级行）。
   - 填充样式/线型/圆角需要 annotation 数据模型 + annotation-geometry 命中/绘制扩展，参考 Snow Shot 的 strokePresetWidths/shapeStrokeWidths 预设表（screenshottoolpalettestylepresets.cpp:29-43）。
6. **多选 + mixed 态**（对标 SelectionState + mixed 位掩码）
   - 选中集合 Set + shift 点选/框选 + 样式不一致时控件显示 mixed（"—"或分段色）。
7. **画笔端点续画**（对标 resolve_free_draw_endpoint :516-523）
   - 画笔工具下，pointerdown 落在最后一条笔迹端点 N px 内 = 续画而非新建。
8. **点击/拖动阈值**（对标 PendingSelectionMove）
   - pointerdown 记原点，位移 <3px 内松手视为"点击"（仅选中/取消），不进入 move 态——进一步减少误移 undo 帧。

### 第三梯队（跟随性/架构性，长线）

9. **旋转支持**：标注模型加 rotation 字段 + Rotate 手柄 + 命中测试反向旋转（对标 SelectionEditMode::Rotate + overlayRectLocalViewPoint）。
10. **统一标注引擎**：抽 annotation-core（几何/命中/样式/undo 纯函数模块），capture 与 record 共用，消除 2/4/8 vs 2/4/7 这类口径分裂（对标 Snow Shot 四处共用 SnowCanvasWidget）。录屏端先获得二次编辑能力。
11. **文字原地编辑**：替掉 window.prompt（capture.js:958），做 contenteditable 覆盖层或轻量文本框（对标 active_text_draft）。
12. **对齐分布/透明度/复制/序号转文字**：低优先级，跟随多选之后。

### 不建议跟

- Qt 级瓦片化渲染引擎/FFI 架构：旧文档已定论（Canvas+原生边车路线）。
- 工具栏手动拖动+停用自动换位：Electron 无边框窗口拖动可用性一般，优先级低。

---

## 7. 附录：本报告的证据基础

- Snow Shot 侧：screenshottoolpalette.cpp（10510 行）三面板结构/setActiveTool/ensureStyleFamily/commitLayout 精读；screenshottoolpalettestylecontrols.cpp 编辑器 role/signature 复用与 mixed 增量刷新；screenshotgeometry.cpp anchoredToolbarPlacement 放置算法；snow-draw-engine-editor/src/state.rs 交互状态机与 ToolPolicy；input/quick_selection.rs 右键快选；screenshotoverlayinputhandler.cpp 滚轮分派；screenrecordingareawindow.cpp:107 录屏复用引擎实证。
- Highlighter 侧：capture/capture.js（1352 行）全量符号表与 463-819 编辑核心段、920-1016 事件主干精读；capture.html 工具栏结构；annotation-geometry.js 命中/缩放函数族；record.html 录屏端色板；docs/plans/2026-10-10-p0-gap-closure-plan.md §20 P0-5 实施记录（855/855 测试、92.62% 覆盖）。
- 方法说明：Snow Shot 侧由 codegraph 索引 + 子代理调研 + Lead 抽查验证（palette 行结构/放置算法/命令集/录屏复用四点独立复核）；Highlighter 侧为 Lead 全量精读。两项目均未修改任何文件。
