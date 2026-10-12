# 设计文档：划词工具栏默认改为选区正下方居中

- 日期：2026-10-09
- 基线：`master` @ `b97391e`（`package.json` 版本 2.3.1）
- 状态：**设计已定稿待实施**（Q1/Q3 已于 2026-10-09 由用户确认：以选区包围盒水平中点为基准、不引入设置项；用户要求先 review 本文，**代码未改动**）
- 请求来源：用户报「划词工具默认出现在划词区域的**右下方**，希望改为默认**正下方**」并附现场截图
- 相关代码：[main/domains/selection/index.js](../../main/domains/selection/index.js)、[main/domains/selection/anchor.js](../../main/domains/selection/anchor.js)、[main/services/selection-window-manager.js](../../main/services/selection-window-manager.js)、[toolbar/toolbar-utils.js](../../toolbar/toolbar-utils.js)

---

## 0. 需求背景与目标

### 0.1 现象与现场证据

用户截图（1440×315 裁切）显示：工具栏（翻译 / 解释 / 复制 / 搜索 / 跳转，5 个动作，条宽 444 DIP）出现在**蓝色高亮文本的右下方**——工具栏左边缘与高亮文本右端对齐（≈ x 250），上边缘在高亮行下方约一行以内。

这与代码里的 `bottomRight` 分支完全吻合（§2.2）：单行选区满足 `endBottom.y === startBottom.y`，朝向判为 `bottomRight`，于是 `x = refPoint.x`，而 `refPoint` 取的是**选区右端**（`endBottom`），工具栏就从选区右端向右铺开。

这不是缺陷，是 2026-09-27 锚点设计里有意为之的默认：单行选区把窗口**左**边缘钉在选区右端、跨行向下选区把窗口**右**边缘钉在选区右端（`bottomLeft`，向左铺开），本意是避开选区本体。用户现在要求把这个**默认观感**改成「正下方」。

### 0.2 现状行为矩阵（已核实，`main/domains/selection/index.js:319-329`）

记号：`refPoint` 为锚点（DIP），`W=工具栏宽度`（随可见动作数变化，默认 4 按钮 359 DIP，5 按钮 444 DIP），`H=40`。

| 朝向 | 触发条件（`orientationFor`） | 锚点 `refPoint` | 当前 `x` | 当前 `y` | 观感 |
|---|---|---|---|---|---|
| `bottomMiddle` | 无有效 `startBottom/endBottom`（posLevel 0/1 或几何无效） | 光标 / `mousePosEnd`(+16) | `refPoint.x - W/2` | `refPoint.y` | **正下方居中** ✅ |
| `bottomRight` | `endBottom.y - startBottom.y ≈ 0`（单行选区，deadZone 0/10） | `endBottom`(+4) / `mousePosEnd` | `refPoint.x` | `refPoint.y` | **右下方**（左边缘=选区右端）← 用户报的现象 |
| `bottomLeft` | `endBottom.y - startBottom.y > deadZone`（跨行向下选区） | `endBottom`(+4) | `refPoint.x - W` | `refPoint.y` | **左下方**（右边缘=选区右端） |
| `topRight` | `endBottom.y - startBottom.y < -deadZone`（向上选区） | `endBottom`(+4) | `refPoint.x` | `refPoint.y - H` | 右上方 |

关键事实：**四个朝向里有三个都把窗口的一条边钉在选区的结束端**（对左→右选区即右端），只有「拿不到几何」的兜底分支才居中。也就是说，「正下方」今天只发生在最不该发生的场景（posLevel 0 光标兜底 / 单击）。

### 0.3 目标

- G1：默认摆放从「贴选区右端 / 左端」改为**以选区水平跨度中点为中轴的正下方**，即用户所说的「正下方」。
- G2：规则**统一且可预测**：横向只由选区跨度决定，不再由朝向决定；朝向只决定「在下方还是在上方」。
- G3：不改坐标系契约（DIP），**每个不同的物理点仍然只换算一次**（锚点与跨度共用结果），不引入设置项、schema、IPC 变化。
- G4：把这条摆放规则从域内闭包函数抽成**可单测的纯函数**，用测试锁死（当前 `calculateToolbarPosition` 无任何测试覆盖）。

### 0.4 非目标（本期明确不做）

- N1：不引入**垂直翻转/避让**规则。下方空间不足时仍按今天的方式 clamp 到工作区底边（可能压住末行），另立设计（见 Q2）。
- N2：不引入「正下方 / 右下方 / 跟随光标」等**用户可选设置项**（见 Q1）。
- N3：不改纵向偏移量（`selectionBottom: 4` / `mouseSingle: 16`）、不改 `anchor.js` 的朝向判定与死区。
- N4：不改结果窗口（划词助手）定位；不改工具栏宽度预算（`getToolbarWidth`）；不改上屏校验与窗口回收。
- N5：不处理 Linux（应用只发 Windows 包）。

---

## 1. 已确认的关键决策

| # | 问题 | 决策 | 理由 |
|---|---|---|---|
| D1 | 「正下方」以什么为基准 | **选区水平跨度的中点**（有几何时），无几何时退化为锚点本身 | 「划词区域的正下方」字面语义；对单行选区就是那段文字的中点 |
| D2 | 跨度从哪来 | posLevel ≥ 2 时用 hook 已给的坐标：level ≥ 3 用 `startBottom.x`/`endBottom.x`；level 2 用 `mousePosStart.x`/`mousePosEnd.x` | hook 免费提供，无需新查询；level 1 两个鼠标点恒等，无增量信息 |
| D3 | 方向无关性 | 跨度取 **min/max**，不假设 `start < end` | 从右往左拖选、Shift 扩展选区都会反转两端 |
| D4 | 朝向是否废弃 | **保留**四个朝向值（诊断语义 + 向上选区仍要摆到上方），但横向摆放**不再读朝向** | 改动面最小；`orientationFor` 与其测试零改动 |
| D5 | 向上选区（`topRight`） | 仍摆在上方，但同样按跨度**居中** | 与下方规则镜像，避免留一个「半旧半新」的分支 |
| D6 | 逻辑放哪 | 抽出纯函数 `calculateToolbarPosition()` 放进 `anchor.js`（与 `main/domains/pin/geometry.js` 同惯例），域内只做接线 | 该文件头注释就是「Where the selection toolbar should be anchored」；当前摆放函数不可测 |
| D7 | 坐标换算 | 每个**不同的物理点只换算一次**，锚点与跨度共用结果 | 延续 2026-09-27 设计「每次显示换算必须可数」的约束 |
| D8 | 显示器的选择 | 仍以 `refPoint`（锚点）所在显示器的工作区做钳制，不改为按跨度中点选屏 | 选区跨屏是极小概率场景，改判定会增加不可预测性（§3.5） |
| D9 | 可观测性 | `shown` 诊断日志补 `anchorOrientation` 与 `anchorSpan` | 现场只需一行日志就能区分「居中失败」和「钳制到边」 |
| D10 | 是否提供设置项 | **不提供**，直接改默认行为（2026-10-09 用户确认） | 需求就是「默认改成正下方」，设置项会把改动面扩到 schema + 设置 UI + 校验 + 迁移（见 Q1） |
| D11 | 基准的最终选择 | **整个选区包围盒的水平中点**（2026-10-09 用户确认），不采用「末行右端居中」 | 见 Q3；对单行选区即那段文字的中点，对多行选区即选区块正下方 |

---

## 2. 关键事实（已核实）

### 2.1 hook 给出的几何（`node_modules/selection-hook/docs/zh-CN/API.md:405-412`、`518-528`）

| 字段 | 含义 | 空间 |
|---|---|---|
| `startTop` / `startBottom` | **第一段**的左上角 / 左下角 | 物理像素 |
| `endTop` / `endBottom` | **最后一段**的右上角 / 右下角 | 物理像素 |
| `mousePosStart` / `mousePosEnd` | 按下 / 松开时的鼠标位置 | 物理像素 |
| `posLevel` | 0 NONE、1 MOUSE_SINGLE（两点相等）、2 MOUSE_DUAL（拖拽）、3 SEL_FULL（含段落坐标）、4 SEL_DETAILED（预留） | — |

对单行左→右选区：`startBottom.x ≈ 选区左端`，`endBottom.x ≈ 选区右端`（2026-09-27 文档 §0.2 的实测结论：「锚点取选区右端」）。因此 `[startBottom.x, endBottom.x]` 就是选区的水平包围盒。

**源码核实（2026-10-09，本设计的关键前提）**：

- `startBottom/endBottom` 只在 `node_modules/selection-hook/src/windows/core/engine.cc:607-674` 的 `SetTextRangeCoordinates()` 里被赋值，来源是 `IUIAutomationTextRange::GetBoundingRectangles()`——即**选区文本范围**的逐行矩形：`startBottom.x = rect[first].left`，`endBottom.x = rect[last].left + width`，并在同一处把 `posLevel` 置为 `Full(3)`。所以 `[startBottom.x, endBottom.x]` 是选区自身的水平包围盒，**不是整行、也不是整个控件的宽度**（`engine.cc:655-656` 的注释与实现一致）。
- MSAA/`IAccessible` 路径（`engine.cc:305-354` 的 `ProcessAccessibleSelection()`）**只写文本、从不写坐标**；`posLevel` 只有在 `None` 时才被鼠标位置改写（`src/windows/core/worker.cc:357-383`）。因此：**posLevel 3 ⇒ 坐标一定是真实选区矩形**；posLevel 2 ⇒ 一定没有选区矩形，只有拖拽/Shift 点击的鼠标点。
- 同一处还显示：level 3 时 `mousePosStart/mousePosEnd` **也是被填充的**（`worker.cc:363-380` 对 Drag/DoubleClick/ShiftClick 无条件写入），所以它们在 level 3 是可用的旁证，但精确几何仍以矩形为准。

### 2.2 现状调用链

1. `main/domains/selection/index.js:350-351`
   `const result = getRefPointAndOrientation(data)` → `const position = calculateToolbarPosition(result.refPoint, result.orientation, toolbarWidth)`
2. `getRefPointAndOrientation()`（`index.js:311-317`）→ `resolveSelectionAnchor()`（`main/domains/selection/anchor.js:37-74`），返回 `{ refPoint, orientation, source, physical }`，只对锚点做物理→DIP 换算。
3. `calculateToolbarPosition()`（`index.js:319-329`）内联 `screen.getDisplayNearestPoint(refPoint).workArea` 并 clamp。
4. `windowManager.showToolbarSelection({ text, actions, position, width })`（`main/services/selection-window-manager.js:288-310`）→ `applyToolbarGeometry()`（`:312-316`）：`setSize(width, 40)` → `setPosition(position.x, position.y)` → `showInactive()`。

**这是工具栏横向位置的唯一来源**（全仓 `setPosition` 仅 `selection-window-manager.js:315` 一处作用于工具栏）。

### 2.3 宽度与联动

- `TOOLBAR_W`（`index.js:60`）只是默认值；每次显示用 `getToolbarWidth(actions)`（`toolbar/toolbar-utils.js:239-262`）现算：默认 4 按钮 = **359 DIP**，加「跳转」（open）= **444 DIP**。
- `lastToolbarPosition`（`selection-window-manager.js:314`）记录工具栏位置，结果窗口以它的 `x` 为中轴（`positionActionWindow()`，`:416-428`）。本设计不改这个约定：结果窗口仍以**工具栏左上角 x** 为中轴，语义不变，只是工具栏本身左移了。

---

## 3. 方案设计

### 3.1 新规则（一句话）

> **工具栏横向一律居中于「选区水平跨度的中点」，纵向保持在锚点下方（向上选区则在锚点上方），最后钳制进锚点所在显示器的工作区。**

对照旧行为：

| 场景 | 旧 `x` | 新 `x` |
|---|---|---|
| 单行选区（`bottomRight`） | `refPoint.x`（= 选区右端） | `spanMid - W/2` |
| 跨行向下选区（`bottomLeft`） | `refPoint.x - W`（右边缘 = 选区右端） | `spanMid - W/2` |
| 向上选区（`topRight`） | `refPoint.x` | `spanMid - W/2`（`y` 仍在上方） |
| 无几何兜底（`bottomMiddle`） | `refPoint.x - W/2` | 不变 |

示意（单行选区，`W = 444`）：

```
旧：                                   新：
   ┌──────────────┐                       ┌──────────────┐
   │ 选中的一段文字 │                       │ 选中的一段文字 │
   └──────────────┘                       └──────────────┘
   └──────────────────────────────┐              ┌──────────────────────────────┐
   ↑ 左边缘贴选区右端              │              │← 以选区中点为中轴，两侧各 222 →│
                                  └──            └──
```

### 3.2 数学表达

```
spanMid   = span ? (span.left + span.right) / 2 : refPoint.x
x         = clamp(spanMid - W / 2, workArea.x, workArea.x + workArea.width  - W)
y         = clamp(above ? refPoint.y - H : refPoint.y,
                  workArea.y, workArea.y + workArea.height - H)
above     = (orientation === 'topRight')
```

其中 `span` 是**已经换算成 DIP** 的 `{ left, right }`，`left ≤ right`；无可用几何时为 `null`。

### 3.3 函数契约

**`main/domains/selection/anchor.js`（扩展，纯函数，无 Electron 依赖）**

```js
resolveSelectionAnchor(event, deps)
  -> { refPoint, orientation, source, physical?, span }   // span: { left, right } | null，DIP
calculateToolbarPosition({ refPoint, orientation, span, toolbarWidth, toolbarHeight, workArea })
  -> { x, y }                                             // 已四舍五入并钳制
```

**`main/domains/selection/index.js`（接线）**

```js
const workArea = screen.getDisplayNearestPoint(result.refPoint).workArea
const position = calculateToolbarPosition({
  refPoint: result.refPoint,
  orientation: result.orientation,
  span: result.span,
  toolbarWidth,
  toolbarHeight: TOOLBAR_H,
  workArea
})
```

### 3.4 代码草案

`anchor.js`：

```js
const UNSET = null

// The selection's horizontal extent, kept direction-independent: `startBottom`
// is the first line's left corner and `endBottom` the last line's right corner,
// but a right-to-left drag (or a Shift-extended selection) swaps the two, so the
// span is always min/max.
function horizontalSpan(first, second) {
  if (!validCoord(first) || !validCoord(second)) return UNSET
  const a = Number(first.x)
  const b = Number(second.x)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return UNSET
  return a <= b ? { left: a, right: b } : { left: b, right: a }
}

function resolveSelectionAnchor(event = {}, { cursorPoint, isWin = false, toDip } = {}) {
  const cursor = { x: Number(cursorPoint?.x) || 0, y: Number(cursorPoint?.y) || 0 }
  const level = Number(event?.posLevel) || 0
  let anchor = null
  let orientation = 'bottomMiddle'
  let offsetDip = 0
  // Physical points whose horizontal extent is the selection's own. posLevel 1
  // carries no extent (both mouse points are the same), so it stays null and the
  // anchor point itself is what gets centred - the pre-existing behaviour.
  let spanPoints = UNSET

  if (level === 1) {
    if (validCoord(event.mousePosEnd)) { anchor = event.mousePosEnd; offsetDip = HOOK_OFFSETS.mouseSingle }
  } else if (level === 2) {
    if (validCoord(event.mousePosEnd)) anchor = event.mousePosEnd
    const next = orientationFor(event.startBottom, event.endBottom, { deadZone: 10 })
    if (next) orientation = next
    spanPoints = [event.mousePosStart, event.mousePosEnd]
  } else if (level > 2) {
    if (validCoord(event.endBottom)) { anchor = event.endBottom; offsetDip = HOOK_OFFSETS.selectionBottom }
    else if (validCoord(event.mousePosEnd)) anchor = event.mousePosEnd
    const next = orientationFor(event.startBottom, event.endBottom, { deadZone: 0 })
    if (next) orientation = next
    spanPoints = [event.startBottom, event.endBottom]
  }

  if (!anchor) return { refPoint: cursor, orientation, source: 'cursor', span: UNSET }

  // One conversion per distinct physical point: the anchor and the span share it,
  // so a payload that repeats a point never pays for it twice. Converting the
  // endpoints instead of the midpoint keeps a mixed-DPI span inside the display
  // its own coordinates came from.
  const converted = new Map()
  const toDipPoint = (point) => {
    const key = `${point.x},${point.y}`
    const cached = converted.get(key)
    if (cached) return cached
    const dip = isWin && typeof toDip === 'function' ? toDip(point) : point
    const value = { x: Number(dip?.x) || 0, y: Number(dip?.y) || 0 }
    converted.set(key, value)
    return value
  }

  const physical = { x: anchor.x, y: anchor.y }
  const anchorDip = toDipPoint(physical)
  let span = UNSET
  if (spanPoints) {
    const [first, second] = spanPoints
    if (validCoord(first) && validCoord(second)) {
      const a = toDipPoint(first)
      const b = toDipPoint(second)
      span = horizontalSpan(a, b)   // already DIP: min/max on converted points
    }
  }

  return {
    refPoint: { x: anchorDip.x, y: anchorDip.y + offsetDip },
    orientation,
    source: 'hook',
    physical,
    span
  }
}

/**
 * Places the toolbar relative to the resolved anchor.
 *
 * Horizontal: centred on the selection's own extent (`span`), falling back to the
 * anchor point when the hook reported no extent. It used to be pinned to the
 * selection's end corner instead - the window's left edge there (x = refPoint.x),
 * its right edge for a downward selection (x = refPoint.x - width) - which is what
 * made a single-line selection look "bottom-right" (2026-10-09 request).
 * Vertical: below the anchor, or above it for an upward selection. Both axes are
 * clamped into the work area the caller resolved from the anchor's display.
 */
function calculateToolbarPosition({ refPoint, orientation, span = UNSET, toolbarWidth, toolbarHeight, workArea }) {
  const centerX = span ? (span.left + span.right) / 2 : refPoint.x
  const x = centerX - toolbarWidth / 2
  const y = orientation === 'topRight' ? refPoint.y - toolbarHeight : refPoint.y
  return {
    x: Math.round(Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - toolbarWidth))),
    y: Math.round(Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - toolbarHeight)))
  }
}
```

`index.js`：

```js
const { calculateToolbarPosition, resolveSelectionAnchor } = require('./anchor')
const TOOLBAR_H = 40

function calculatePositionFor(result, toolbarWidth) {
  return calculateToolbarPosition({
    refPoint: result.refPoint,
    orientation: result.orientation,
    span: result.span,
    toolbarWidth,
    toolbarHeight: TOOLBAR_H,
    workArea: screen.getDisplayNearestPoint(result.refPoint).workArea
  })
}

// handleTextSelection 内：
const result = getRefPointAndOrientation(data)
const position = calculatePositionFor(result, toolbarWidth)
```

诊断日志（`index.js:360-373`）追加两个字段：

```js
anchorOrientation: result.orientation,
anchorSpan: result.span
```

### 3.5 边界与钳制行为

| 场景 | 新行为 |
|---|---|
| 选区横跨两台显示器 | 仍以**锚点**所在显示器的工作区钳制；居中值被拉到该工作区边缘（与今天 clamp 的语义一致），不按跨度中点重新选屏 |
| 选区贴近屏幕右/左边缘 | 先按中点居中，再被 clamp 回工作区内（如今天一样「贴边但不越界」） |
| 选区比工具栏窄 | 正常居中，工具栏在选区两侧各伸出 `(W-span)/2` |
| `endBottom` 有效但 `startBottom` 无效 | `span = null` → 以锚点居中（不猜测跨度） |
| 坐标为 `-99999`（INVALID_COORDINATE） | `validCoord` 过滤 → 退回锚点居中 / 光标兜底，行为不变 |
| posLevel 1（双击取词、单击） | 无跨度信息 → 以点击点居中，**与今天完全一致**（诚实的能力边界，不是回归） |
| 选区底边贴近屏幕底边 | 仍 clamp 到工作区底边（可能压住末行）→ N1，见 Q2 |

### 3.6 数值示例（用现有测试的混合 DPI 布局：1.5 主屏 + 右侧 1.25 竖屏）

`startBottom = {x:4400, y:400}`、`endBottom = {x:4560, y:900}`（物理，副屏）→ 换算后 `span = [3008, 3136]`，`spanMid = 3072`，`refPoint = {3136, 724}`，`W = 444`：

| | 旧 | 新 |
|---|---|---|
| `x` | `3136 - 444 = 2692` | `3072 - 222 = 2850` |
| `y` | `724` | `724` |

差 **158 DIP**，方向朝选区中点（`3008..3136` 的中点）。

---

## 4. 被否决的方案

| # | 方案 | 否决理由 |
|---|---|---|
| R1 | 只把 `bottomRight` 分支改成居中 | `bottomLeft`（跨行向下选区）仍把窗口右边缘钉在选区右端（向左铺开），规则仍不统一；用户换一种选法就会再报一次 |
| R2 | 以「最后一行」为基准居中 | hook 只给最后一段的**右**下角（`endBottom`），没有最后一行的左端，无法算末行中点；强行用 `endBottom.x - W/2` 等于「锚点居中」，是本设计 D1 的退化版，对单行选区仍偏右 |
| R3 | 保持「锚点居中」（`refPoint.x - W/2`，即今天的 `bottomMiddle`） | 实现最省，但单行选区时锚点是选区**右端**，工具栏会有半个宽度伸到选区右侧——用户报的「右下方」只解决一半 |
| R4 | 新增设置项（正下方 / 右下方 / 跟随光标） | 需要 settings schema + 设置 UI + 校验 + 迁移，改动面比需求大一个数量级；默认行为本身就是要改的东西（见 Q1） |
| R5 | 依赖原生窗口层的自动居中（如 `setBounds` 配合 `center`） | Electron 的窗口居中只针对显示器，不知道选区；且会破坏 `setPosition` 的唯一来源约定 |
| R6 | 让渲染层（`toolbar.html`）内部偏移补偿 | 窗口是精确尺寸、无额外空间，偏移会裁掉按钮；且把定位逻辑放进渲染层，违反现有职责划分 |

---

## 5. 影响面

| 文件 | 改动 |
|---|---|
| `main/domains/selection/anchor.js` | 新增 `horizontalSpan()`（内部）、`calculateToolbarPosition()`（导出）；`resolveSelectionAnchor()` 增加 `span` 返回、增加「每点只换算一次」的 memo |
| `main/domains/selection/index.js` | 删除内联的 `calculateToolbarPosition()`；改为调用 anchor 的纯函数并传入 `workArea`；`shown` 诊断日志加两个字段 |
| `test/selection-anchor.test.js` | 新增摆放/跨度用例，修订「换算次数」断言 |
| `test/selection-domain.test.js` | 修订混合 DPI 用例的换算次数与工具栏 `x/y` 断言 |
| `docs/plans/2026-10-09-...-verification.md` | 新增（实机复验证据，M4 产出） |

**不受影响**：设置 schema 与迁移、IPC 通道、工具栏宽度预算与按钮布局、`toolbar.html` / `toolbar.js`、窗口创建/回收/上屏校验、结果窗口定位约定、`orientationFor` 语义与其死区、日志通道与格式（仅增字段）。

**需要留意的侧效应（不是缺陷，但会被用户看到）**：结果窗口（划词助手）以 `lastToolbarPosition.x`（**工具栏左上角**）为中轴（`positionActionWindow()`，`selection-window-manager.js:416-428`）。工具栏左移后，结果窗口会以**同一个位移**左移（§3.6 的例子里是 286 DIP）。这个「以左边缘当中心」的既有偏差在新布局下更明显。可选的小幅跟进：`applyToolbarGeometry()` 顺带记住工具栏宽度，让结果窗口以**工具栏中心**对齐；本设计默认不做，列为 Q6。

---

## 6. 测试与验收

### 6.1 单元测试（`test/selection-anchor.test.js`，新增）

沿用文件里既有的 1.5/1.25 混合 DPI 夹具（`createToDip`）。

| # | 用例 | 断言 |
|---|---|---|
| U1 | 单行选区（`posLevel 3`，`startBottom.y === endBottom.y`） | `span = {left:3008,right:3136}`；`calculateToolbarPosition` 的 `x = 2893`（`W=359`）、`y = 724` |
| U2 | 跨行向下选区（`endBottom.y > startBottom.y`） | 与 U1 **同一个 `x`**（证明横向不再随朝向偏移） |
| U3 | 向上选区（`endBottom.y < startBottom.y`） | `y = 284`（在锚点上方 40），`x` 仍居中 |
| U4 | 无跨度（`posLevel 0`） | `span === null`，`x = refPoint.x - W/2`（行为与今天一致） |
| U5 | 反向选区（`startBottom.x > endBottom.x`） | `span` 仍 `left ≤ right`，`x` 与正向一致 |
| U6 | 钳制 | 中点靠近工作区右/左边缘时，`x` 分别等于 `workArea.right - W` / `workArea.x`；`y` 同理 |
| U7 | 换算次数 | 两个不同物理点 → `toDip.calls.length === 2`；两点重合 → `1`；`posLevel 0` → `0` |

### 6.2 域级测试（`test/selection-domain.test.js`，修订 + 新增）

- 修订 `a selection on a mixed-DPI secondary display anchors the toolbar on that display`：
  - `screen.calls.length` 由 `1` 改为 `2`（锚点 + 跨度左端各一次，`calls[0]` 仍是 `endBottom`）；
  - 追加 `assert.equal(fromHook.bounds.x, 2850)`、`assert.equal(fromHook.bounds.y, 724)`（§3.6 的数值）；
  - posLevel 0 分支的断言保持成立（`x = 3136 - 222 = 2914`，`calls.length === 0`）。
- 新增：`a single-line selection centres the toolbar under the selection` —— 造一个 `startBottom.y === endBottom.y` 的 payload，断言 `bounds.x === spanMid - W/2`（而不是 `refPoint.x`）。这条是本次需求的**回归锁**。

### 6.3 运行时 / 实机复验（M4）

1. `npm start`（开发构建；**按 AGENTS.md，可见测试窗口放副屏；无双屏需先询问用户**）。
2. 在副屏的记事本 / Chrome 里分别做：单行拖选、跨行向下拖选、向上拖选、贴近屏幕右边缘拖选。
3. 每次划词后取两路证据：
   - **精确值**：主进程日志 `Selection event diagnostic: shown` 里的 `toolbarPosition` / `anchorSpan` / `anchorOrientation`（这是判定依据，不做像素回归）；
   - **像素旁证**：抓一次全屏像素（`screenshot-desktop`，同 `scripts/probe-electron-runtime.js:45-58` 的用法），确认工具栏**确实画在**该位置、在同一台显示器上、没有被挤到屏幕边缘。
   - 验收：日志 `toolbarPosition.x` 等于 `(anchorSpan.left + anchorSpan.right)/2 - W/2`（钳制前），像素与日志一致（±2 px 内）。注意透明无边框窗口的可见条带内还有 padding，**不要**用像素量出来的「左边缘」当窗口 `x`，量图标中心即可。
4. 若副屏不可用或需要人工目视，先向用户确认再开可见窗口。

### 6.4 门禁命令

```powershell
npm run check          # 语法 + 架构门禁（main.js 行数、域模块、禁用模式）
npm test               # node --test test/*.test.js（含新增/修订用例）
npm run test:coverage  # 覆盖门禁（toolbar/** 在其中；main/domains 不在覆盖白名单内）
```

---

## 7. 实施计划

| 里程碑 | 内容 | 写文件范围 | 完成判据 |
|---|---|---|---|
| M1 | `anchor.js` 纯函数（span + placement）与 U1–U7 | `main/domains/selection/anchor.js`、`test/selection-anchor.test.js` | 新用例全绿；`posLevel 0/1` 行为与旧实现逐字段一致 |
| M2 | 域内接线 + 诊断字段 + 6.2 用例 | `main/domains/selection/index.js`、`test/selection-domain.test.js` | `npm test` 全绿 |
| M3 | 门禁与回归 | 无新增（可能微调注释） | `npm run check`、`npm test`、`npm run test:coverage` 全绿；`git diff` 只含上述 4 个文件 |
| M4 | 实机复验 + 证据文档 | `docs/plans/2026-10-09-selection-toolbar-centered-placement-verification.md` | 6.3 的四项验收有截图/数值证据 |

M1 与 M2 可在同一分支按顺序提交（M2 依赖 M1 的导出签名）。建议提交粒度：`M1`、`M2`、`M4 文档` 三个提交。

---

## 8. 风险与回滚

| 风险 | 等级 | 缓解 |
|---|---|---|
| 观感变化是主观的：习惯了「贴右端」的用户可能觉得新位置「偏了」 | 中 | 这正是需求本身；若需并存则走 Q1 的设置项（本期不做） |
| 跨行选区的包围盒中点可能远离末行（末行很短时），看起来像「在选区块中点下方」而非「在光标下方」 | 低-中 | 这是「选区正下方」的字面语义；若用户更想要「末行下方」，实现上改为以 `endBottom.x` 居中即可（R2 的退化版），属 Q3 |
| level 2 的 `mousePosStart/End` 是**拖拽路径**而非选区几何，键盘扩展选区时会偏小 | 低-中 | 源码核实：level 2 必然没有选区矩形（`worker.cc:357-383`），拖拽时两个鼠标点确实包住选区，普通拖选误差仅几像素；但 **Shift+点击** 的 `mousePosStart` 是上一次鼠标抬起位置，未必是选区起点 → 该手势下中点可能偏。可接受（比今天的「锚点=释放点」仍更接近选区中心），若要更保守，level 2 退回「锚点居中」即可（一行开关，见 Q5） |
| 多一次 `screenToDipPoint` 调用 | 极低 | 纯函数、无 IO；且做过「同点只换算一次」的 memo，测试锁死次数 |
| 与 2026-10-07 上屏校验/窗口回收冲突 | 极低 | 只改 `position` 的数值来源，窗口创建/回收/校验路径零改动 |
| 回滚 | — | 改动集中在 2 个源文件 + 2 个测试文件，`git revert` 单个提交即可完整回退，无数据迁移 |

---

## 9. 待确认问题

| # | 问题 | 状态 / 建议 |
|---|---|---|
| Q1 | 是否需要把摆放方式做成**设置项**（默认正下方，可选右下方 / 跟随光标）？ | ✅ **已确认（2026-10-09）：不做**，直接改默认；设置项会让改动面扩到 schema + 设置 UI + 校验 + 迁移 |
| Q2 | 纵向是否一并做「下方空间不足则翻到选区上方」？ | ⏳ **本期不做**（N1）：与本次横向需求正交，翻转规则涉及避让选区，另立设计 |
| Q3 | 「正下方」的基准：**整个选区包围盒的水平中点**（本设计，推荐）还是**末行右端的正下方**？ | ✅ **已确认（2026-10-09）：选区包围盒的水平中点**；「末行右端」等于「锚点居中」，对单行选区仍偏向右侧 |
| Q4 | 实机复验的可见窗口放在副屏（AGENTS.md），当前机器是否有副屏可用？ | ⏳ 实施（M4）前确认；若无副屏，改用隐藏窗口 + 桌面抓屏的方式验证（不弹可见窗口） |
| Q5 | level 2（无 UIA 矩形、只有鼠标点）是否采用 `mousePosStart..mousePosEnd` 作跨度？ | 🆕 **建议采用**（比今天的「锚点=释放点」更接近选区中心）；代价是 **Shift+点击** 手势下中点可能偏（§8）。保守选项：level 2 退回锚点居中，实现上只差一行 |
| Q6 | 结果窗口是否改为以**工具栏中心**对齐（今天以工具栏左边缘为中轴）？ | 🆕 **建议本次不做**：与本次需求正交，但它是本次位移会放大的既有偏差；可作为独立小改动（`applyToolbarGeometry()` 记住宽度即可） |
| Q7 | 设计是否照此实施（M1–M3）？ | ⏳ **待用户 review**：2026-10-09 用户选择先只保留设计文档，代码改动待批准后再开始 |
