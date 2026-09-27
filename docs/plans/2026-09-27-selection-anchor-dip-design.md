# 设计文档：划词锚点坐标系修复（DPI 重复换算）

- 日期：2026-09-27
- 基线：`master` @ `5db4f76`（`package.json` 版本 2.3.0）
- 状态：**M1 + M2 已实施，M3 实机复验部分完成**（分支 `fix/selection-anchor-dip`，见 §9）
- 范围：修复 `getRefPointAndOrientation()` 把 Electron 已经换算好的 DIP 坐标当成物理坐标再换算一次，导致缩放屏（尤其混合 DPI 多屏）上工具栏锚点错位的缺陷

---

## 0. 需求背景与目标

### 0.1 现状缺陷

`main/domains/selection/index.js:260-288`：

```js
function getRefPointAndOrientation(data) {
  const cursor = screen.getCursorScreenPoint()   // 已经是 DIP
  let refX = cursor.x
  let refY = cursor.y
  let orientation = 'bottomMiddle'
  const level = data.posLevel || 0
  if (level === 1) {
    if (validCoord(data.mousePosEnd)) { refX = data.mousePosEnd.x; refY = data.mousePosEnd.y + 16 }
  } else if (level === 2) {
    if (validCoord(data.mousePosEnd)) { refX = data.mousePosEnd.x; refY = data.mousePosEnd.y }
    if (validCoord(data.startBottom) && validCoord(data.endBottom)) { /* orientation */ }
  } else if (level > 2) {
    if (validCoord(data.endBottom)) { refX = data.endBottom.x; refY = data.endBottom.y + 4 }
    else if (validCoord(data.mousePosEnd)) { refX = data.mousePosEnd.x; refY = data.mousePosEnd.y }
    if (validCoord(data.startBottom) && validCoord(data.endBottom)) { /* orientation */ }
  }
  if (isWin) {
    const point = screen.screenToDipPoint({ x: refX, y: refY })   // ← 无条件转换
    refX = point.x
    refY = point.y
  }
  return { refPoint: { x: refX, y: refY }, orientation }
}
```

`refX/refY` 有**两个来源、分属两个坐标空间**，但最后不加区分地统一做了一次「物理 → DIP」转换：

| `posLevel` | 含义（hook 文档） | 取值来源 | 空间 | 再转换是否正确 |
|---|---|---|---|---|
| 0 | `None` | `screen.getCursorScreenPoint()` | **DIP** | ❌ 重复换算 |
| 1 / 2 / 3 / 4 | Mouse / Selection | `mousePosEnd` / `endBottom` | **物理** | ✅ 正确 |
| 1~4 但坐标为无效值（如 `-99999`） | — | 退回光标点 | **DIP** | ❌ 重复换算 |

触发条件：`posLevel: 0` 的唯一来源是 hook 的**剪贴板兜底路径**（`method: 99 = Clipboard`）。它在 Windows 上默认开启，但**只在 UIA 与 IAccessible 都取不到选中文本时才会走到**——也就是说，常见的 UIA 应用（记事本、Windows Terminal、Chrome 等）永远不会触发它（§9.6 实测确认）。真正的触发面是「无 UIA 文本层」的应用：提权进程（UIPI 挡住 UIA）、canvas 渲染的文字、部分 Java/Qt 程序等。

### 0.2 实测动机（2026-09-27 修正）

最初写的动机是：真机上观察到副屏划词时工具栏被挤到**副屏最右边缘**（物理 x 4750–5285），并把它归因于本缺陷。**这个归因是错的**，§9.6 的实机复验推翻了它：

- 修复前的已安装构建与修复后的 dev 构建，工具栏落在**同一个位置**（DIP x = 3288）；
- `Selection anchor:` 日志显示那次划词走的是 `posLevel: 3 / anchorSource: "hook"`，即**本来就没坏的那条分支**；
- 贴边是 `calculateToolbarPosition()` 的正常 clamp：单行选区满足 `endBottom.y === startBottom.y`，朝向判定为 `bottomRight`，于是 `x = refPoint.x`（锚点取选区右端），而锚点已接近纵向副屏的右边界（DIP 3294 + 工具栏 424 > 3712），于是被拉回 3288。

所以本设计的动机是**已确证的坐标系混淆机理**（§2.1–2.3），不是那次观察到的现象。这一点很重要：它意味着「副屏表现异常」的报告不能靠本修复来回答（§8 亦然）。

### 0.3 目标

- 锚点参考点在**所有缩放比例、所有显示器布局**下都落在正确的显示器、正确的 DIP 位置上。
- 把「hook 给的是物理坐标、Electron 给的是 DIP」这一契约写进代码与测试，使同类错误不能再悄悄回来。
- 给锚点决策加一条一次性诊断日志，为仍未闭环的「副屏置顶/置底」报告提供运行时证据。

### 0.4 非目标（本期明确不做）

- 不重新设计工具栏摆放策略（不引入「避让选区」「翻转优先级」等新规则），只修正坐标系。
- 不改结果窗口（划词助手）的定位逻辑与置顶逻辑。
- 不引入 Linux 支持（应用只发 Windows 包，`package.json` 的 `build.win` 只有 nsis/portable）。
- 不改设置 schema、不 bump 版本、无数据迁移。

---

## 1. 已确认的关键决策

| # | 问题 | 决策 |
|---|---|---|
| D1 | 在哪里修 | **在源头区分来源**，不对已经算错的坐标做事后纠偏 |
| D2 | 是否抽模块 | **抽出纯函数**到 `main/domains/selection/anchor.js`，与既有 `main/domains/pin/geometry.js` 同惯例；域内只做接线 |
| D3 | `+16` / `+4` 偏移 | 改为**转换之后按 DIP 施加**（今天加在物理坐标上，间距会随缩放漂移） |
| D4 | `mouseDown` 的命中测试（`index.js:211`） | **不动**，它对 hook 物理坐标做 `screenToDipPoint` 本来就是对的 |
| D5 | 平台判定 | 保留 `isWin` 守卫，不扩展到 Linux |
| D6 | 可观测性 | 锚点决策并入既有的 `logSelectionDiagnosticOnce('shown', ...)`，记录 `posLevel` / `source` / 转换前后坐标 / 命中显示器 |
| D7 | 兼容性 | 纯内部修复：无设置项、无 schema、无 IPC 通道变化 |

---

## 2. 关键事实（已核实，设计的依据）

### 2.1 hook 的坐标是物理坐标

`node_modules/selection-hook/docs/zh-CN/API.md:363-366`：

> **坐标说明：** 所有坐标均以**屏幕坐标**返回 — 即各平台显示系统提供的原始值。要转换为用于 UI 定位的**逻辑坐标（DIP）**：
> - **Windows：** 在 Electron 中使用 `screen.screenToDipPoint(point)`。

### 2.2 Electron 的两个 API 分属两个空间

`node_modules/electron/electron.d.ts:11979`：

> `getCursorScreenPoint(): Point`
> > [!NOTE] The return value is a **DIP** point, not a screen physical point.

`node_modules/electron/electron.d.ts:11997-12003`：

> Converts a screen **physical** point to a screen DIP point. The DPI scale is performed **relative to the display containing the physical point**.
> `@platform win32,linux`

### 2.3 数值后果

`screenToDipPoint` 不是「除以缩放系数」，而是「以包含该**物理点**的显示器为基准做缩放」：

```
dip = D.origin + (p - D.origin) / D.scale
```

把已经是 DIP 的点 `d` 再喂进去，等于以该显示器原点为中心**又缩了一次**：

```
D.origin + (d - D.origin) / D.scale
```

用本次实测的布局（主屏物理 0,0–3840,2160 @1.5 → DIP 0,0–2560,1440；副屏物理 3840,-170–5280,2390 @1.25 → DIP 2560,-136–3712,1912）：

| 场景 | 输入（DIP） | 结果 | 表现 |
|---|---|---|---|
| 单屏 100% | 任意 | 不变（scale=1） | **看不出问题** |
| 单屏 150% | x=1000 | `1000/1.5 = 666` | 工具栏左移约 1/3，再被 clamp 贴左边缘 |
| 混合 DPI，光标在副屏 | x=3200 | 3200 落在**主屏**物理范围（0–3840）→ 按 1.5 缩放 → `2133` | `2133` 在主屏 DIP 范围内 → `getDisplayNearestPoint` 返回**主屏**，工具栏跑到**另一块屏** |

第三行是本缺陷最严重的形态：不是「偏一点」，而是整块屏都错了。

### 2.4 现有可测性（决定了修复形态）

- `createSelectionDomain(deps)` 的 `screen` / `isWin` **是注入的**（`index.js:36-57`），文件头注释明确写了「the whole domain is drivable from node:test」。
- `handleTextSelection` **已从域导出**（`index.js` 返回值列表）。
- `test/selection-domain.test.js` 已具备：假 `screen`（含 `screenToDipPoint`）、`createHarness(overrides)`（`overrides` 会展开进 deps，第 139 行）、假窗口记录 `setPosition`（`win.bounds`）、以及一条现成的 `posLevel: 0` 用例（第 148 行）。
- 覆盖门禁 `test:coverage:loaded` 的 `--include` 列表**不含 `main/domains/**`**，所以新增的纯函数模块不会被覆盖率门禁兜住——单测必须自己写足。

---

## 3. 详细需求点

**FR-1 来源区分**：锚点解析必须显式区分「hook 物理坐标」与「Electron DIP 坐标」，只对前者做 `screenToDipPoint`。

**FR-2 无效坐标回退**：hook 报了 `posLevel` 但对应字段无效（`validCoord` 拒绝）时，回退到光标 DIP 点，且**不得**对其做转换。

**FR-3 偏移量单位为 DIP**：`posLevel === 1` 的 +16、`posLevel > 2` 且取 `endBottom` 的 +4，均在转换**之后**施加。

**FR-4 朝向判定不变**：`posLevel === 2` 用 ±10 死区，`posLevel > 2` 用 ±0 死区，行为与今天一致（含「取不到 startBottom/endBottom 时保持 `bottomMiddle`」）。

**FR-5 显示器归属正确**：给定正确的物理锚点，转换结果必须仍落在**同一块**显示器的 DIP 范围内，从而 `getDisplayNearestPoint(refPoint)` 返回该显示器。

**FR-6 诊断日志**：`shown` 那条一次性日志补充锚点信息，便于在真机上判断某次划词走了哪个分支。

**FR-7 非功能**：零新增依赖；纯同步计算，无性能影响；不改任何对外行为契约（IPC、设置、窗口参数）。

---

## 4. 技术设计

### 4.1 新增纯函数模块 `main/domains/selection/anchor.js`

与 `main/domains/pin/geometry.js` 同惯例：纯计算、无 electron 依赖、依赖全部注入，便于直接单测。

```js
'use strict'

// Hook coordinates arrive in screen (physical) pixels while Electron's screen
// API speaks DIP. The two sources are kept apart here: only the hook's point is
// converted, so a scaled display cannot scale the same value twice.
const HOOK_OFFSETS = { mouseSingle: 16, selectionBottom: 4 }

function validCoord(point) {
  return Boolean(point) && point.x > -90000 && point.x < 90000 && point.y > -90000 && point.y < 90000
}

function orientationFor(startBottom, endBottom, { deadZone = 0 } = {}) {
  if (!validCoord(startBottom) || !validCoord(endBottom)) return ''
  const delta = endBottom.y - startBottom.y
  if (delta > deadZone) return 'bottomLeft'
  if (delta < -deadZone) return 'topRight'
  return 'bottomRight'
}

// Returns the toolbar anchor in DIP space.
// source: 'hook'   -> anchor came from the selection hook (physical, converted)
//         'cursor' -> anchor fell back to the pointer (already DIP, untouched)
function resolveSelectionAnchor(event = {}, { cursorPoint, isWin = false, toDip } = {}) {
  const cursor = { x: Number(cursorPoint?.x) || 0, y: Number(cursorPoint?.y) || 0 }
  const level = Number(event?.posLevel) || 0
  let anchor = null
  let orientation = 'bottomMiddle'
  let offsetDip = 0

  if (level === 1) {
    if (validCoord(event.mousePosEnd)) {
      anchor = event.mousePosEnd
      offsetDip = HOOK_OFFSETS.mouseSingle
    }
  } else if (level === 2) {
    if (validCoord(event.mousePosEnd)) anchor = event.mousePosEnd
    const next = orientationFor(event.startBottom, event.endBottom, { deadZone: 10 })
    if (next) orientation = next
  } else if (level > 2) {
    if (validCoord(event.endBottom)) {
      anchor = event.endBottom
      offsetDip = HOOK_OFFSETS.selectionBottom
    } else if (validCoord(event.mousePosEnd)) {
      anchor = event.mousePosEnd
    }
    const next = orientationFor(event.startBottom, event.endBottom, { deadZone: 0 })
    if (next) orientation = next
  }

  if (!anchor) return { refPoint: cursor, orientation, source: 'cursor' }

  const physical = { x: anchor.x, y: anchor.y }
  const dip = isWin && typeof toDip === 'function' ? toDip(physical) : physical
  return {
    refPoint: { x: Number(dip?.x) || 0, y: (Number(dip?.y) || 0) + offsetDip },
    orientation,
    source: 'hook',
    physical
  }
}

module.exports = { resolveSelectionAnchor, orientationFor, validCoord, HOOK_OFFSETS }
```

要点：

- **`source` 是显式的返回值**，不再靠读者记住来源；`physical` 也一并返回，供日志与断言使用。
- 偏移量在转换后加（FR-3）。
- `validCoord` 从域内搬进来（域内删除本地副本），避免两处判定漂移。
- `toDip` 注入而非直接 require electron，单测可传记录调用的假函数。

### 4.2 域内接线（`main/domains/selection/index.js`）

```js
const { resolveSelectionAnchor } = require('./anchor')

function getRefPointAndOrientation(data) {
  return resolveSelectionAnchor(data, {
    cursorPoint: screen.getCursorScreenPoint(),
    isWin,
    toDip: (point) => screen.screenToDipPoint(point)
  })
}
```

- 删除域内 `validCoord` 与 `getRefPointAndOrientation` 的原实现（约 30 行）。
- `handleTextSelection` 的调用点不变：`const result = getRefPointAndOrientation(data)` → `calculateToolbarPosition(result.refPoint, result.orientation, toolbarWidth)`。
- `calculateToolbarPosition` **不改**：它拿到的已经是 DIP，`getDisplayNearestPoint` 与 `workArea` 也都吃 DIP，语义正确。
- `index.js:211` 的 `mouseDown` 命中测试**不改**（D4）。

### 4.3 诊断日志（D6）

`logSelectionDiagnosticOnce('shown', data)` 目前只记 `programName` / `textLength`。补充锚点字段（仍受「同一 reason 只记一次」约束）：

```js
log('Selection anchor:', {
  posLevel: Number(data.posLevel) || 0,
  source: result.source,
  refPoint: result.refPoint,
  displayId: screen.getDisplayNearestPoint(result.refPoint).id,
  toolbar: position
})
```

这条日志正是 0.2 那次实测缺的东西：它能一次回答「这次划词是 hook 坐标还是光标回退」「最终锚点落在哪块屏」。

### 4.4 文件改动清单（预估）

| 文件 | 改动 |
|---|---|
| `main/domains/selection/anchor.js` | **新增**：`resolveSelectionAnchor` / `orientationFor` / `validCoord` |
| `main/domains/selection/index.js` | `getRefPointAndOrientation`（`:260-288`）改为接线；删除本地 `validCoord`（`:256`）；`shown` 日志（`:324`）补锚点字段 |
| `test/selection-anchor.test.js` | **新增**：纯函数单测（含混合 DPI 的假 `toDip`） |
| `test/selection-domain.test.js` | 扩写：`isWin: true` + 双屏假 `screen`，断言工具栏落在正确显示器 |

---

## 5. 测试计划

### 5.1 纯函数单测（新，`test/selection-anchor.test.js`）

用**忠实实现 `screenToDipPoint` 语义**的假转换器，锁定坐标空间契约：

```js
const DISPLAYS = [
  { origin: { x: 0, y: 0 },       physical: { width: 3840, height: 2160 }, scale: 1.5 },   // 主屏
  { origin: { x: 2560, y: -136 }, physical: { x: 3840, y: -170, width: 1440, height: 2560 }, scale: 1.25 } // 副屏
]
function fakeToDip(point) {           // 「以包含该物理点的显示器为基准缩放」
  const display = DISPLAYS.find((d) => point.x >= d.physical.x && point.x < d.physical.x + d.physical.width
    && point.y >= d.physical.y && point.y < d.physical.y + d.physical.height)
  if (!display) return point
  return {
    x: display.origin.x + (point.x - display.physical.x) / display.scale,
    y: display.origin.y + (point.y - display.physical.y) / display.scale
  }
}
```

断言项：

1. `posLevel: 0` → `source === 'cursor'`，**`toDip` 未被调用**，`refPoint` 恒等于传入的 DIP 光标点。
2. `posLevel: 3` + 副屏物理 `endBottom` → `source === 'hook'`，`toDip` **恰好调用一次**且入参是原始物理点，`refPoint` 落在副屏 DIP 矩形内。
3. `posLevel: 1` → 偏移为 **DIP 的 +16**（转换后加），断言 `refPoint.y === dipY + 16`。
4. `posLevel: 2` → 朝向死区 ±10：`delta = 11` → `bottomLeft`，`delta = -11` → `topRight`，`delta = 5` → `bottomRight`；无偏移。
5. `posLevel: 4` 但 `endBottom = { x: -99999, y: -99999 }` → 回退到光标点，`source === 'cursor'`，`toDip` 未调用。
6. `isWin: false` → 任何分支都不调用 `toDip`。
7. **回归锁**：同一物理锚点在主屏（1.5）与副屏（1.25）上分别转换后，`refPoint` 都必须落在**各自**显示器的 DIP 矩形内（FR-5）。

### 5.2 域级回归（扩写 `test/selection-domain.test.js`）

利用现有 harness（`createHarness(overrides)` 会展开进 deps；假窗口把 `setPosition` 记进 `bounds`）：

8. `isWin: true` + 双屏假 `screen`，`getCursorScreenPoint()` 返回副屏上的 DIP 点，`handleTextSelection({ posLevel: 0, ... })` → 工具栏 `bounds` 落在**副屏**工作区内，且 `screenToDipPoint` 调用次数为 **0**。
9. 同一布局下 `handleTextSelection({ posLevel: 3, endBottom: <副屏物理点>, ... })` → 工具栏落在**副屏**工作区内，`screenToDipPoint` 调用次数为 **1**。

这两条把「工具栏必须出现在划词那块屏」变成可回归的不变量——今天它在混合 DPI 下会失败。

### 5.3 门禁与真机

10. `npm run check`（语法 + 架构门禁，`main.js` 行数上限不受影响）、`npm test` 全绿。
11. **真机复验**（沿用 2026-09-27 那次的 computer-use 流程）：副屏（1152×2048 @1.25 纵向）+ 主屏（2560×1440 @1.5）上各划词一次，读 `Selection anchor:` 日志，确认 `source` 与实际分支一致、`displayId` 与划词所在屏一致、工具栏出现在选区附近而非屏幕边缘。

---

## 6. 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| 修复会**改变** `posLevel: 0` 在缩放屏上的工具栏位置（这正是目的） | 低 | 100% 缩放屏上 scale=1，结果不变；缩放屏上是「从错到对」，不视为行为回归 |
| 误把 hook 坐标当光标点（或反之），引入新的错位 | 中 | `source` 显式返回 + 单测覆盖两种来源与两种回退；域级测试锁「落在划词那块屏」 |
| `posLevel` 出现文档外的取值 | 低 | 判定沿用今天的形状：`0 / 1 / 2 / >2`，未知值按 `>2` 处理 |
| 偏移量改到 DIP 后，某些布局下工具栏贴边行为变化 | 低 | 偏移仅 4–16 DIP，且 `calculateToolbarPosition` 仍做工作区 clamp |
| 覆盖率门禁不覆盖 `main/domains/**`，新模块可能欠测 | 中 | 5.1 的 7 条断言全部针对该模块；`npm test` 是唯一兜底，故断言必须显式 |
| 诊断日志泄露用户内容 | 低 | 只记坐标与 id，不记选中文本（沿用现有日志边界） |

---

## 7. 实施分期

- **M1（修复 + 单测）**：§4.1 纯函数模块 + §4.2 域内接线 + §4.3 偏移与日志 + §5.1 单测。此步完成后 `npm test` 与 `npm run check` 应全绿。
- **M2（域级回归）**：§5.2 两条双屏断言；把「工具栏出现在划词所在屏」固化下来。
- **M3（真机复验）**：§5.3 第 11 项；顺带用 `Selection anchor:` 日志回头查 2026-09-27 那次「副屏置顶/置底」报告里未被解释的钳制现象。

---

## 8. 与「副屏置顶」报告的关系

本设计**不声称**能修掉用户报告的「副屏点击置顶会置底」——2026-09-27 的实机验证表明该现象**未能复现**：在副屏上点击置顶后 `WS_EX_TOPMOST` 由 `False` 变 `True`，且结果窗口在后激活的记事本之上保持可见。

两者是独立问题。本设计交付的是**已确证**的坐标系缺陷修复，外加 §4.3 的诊断日志——后者正是继续追那条报告所缺的运行时证据。

---

## 9. 实施结果与偏差（2026-09-27 补记，分支 `fix/selection-anchor-dip`）

M1 与 M2 已落地并通过全部门禁；M3 实机复验部分完成——hook 分支确认无回归，被修复的 `posLevel: 0` 分支在真机上未能到达（§9.6）。

### 9.1 门禁实况

| 门禁 | 结果 |
|---|---|
| `npm test` | 613 tests / 613 pass（604 → +9） |
| `npm run check` | ok，`main.js` 1298 行 / 上限 1300，语法检查 224 个文件（222 → +2） |
| `npm run test:coverage:loaded` | lines 91.09%（与改动前持平，`main/domains/**` 不在 `--include` 内） |
| `npm run audit:dependencies` | 0 豁免、0 未豁免 |

新增 `test/selection-anchor.test.js` 8 条断言；`test/selection-domain.test.js` 增 1 条混合 DPI 域级回归。

### 9.2 偏差 1：`posLevel === 2` 的朝向判定不能并入 anchor 条件

§4.1 的代码草案原本写的是 `else if (level === 2 && validCoord(event.mousePosEnd)) { … orientation … }`。这会在 `mousePosEnd` 无效时**跳过**朝向计算，而原实现里朝向是**独立于** anchor 字段计算的（`mousePosEnd` 无效时仍会按 `startBottom/endBottom` 更新朝向）。已按原语义改为分支内独立计算，`orientationFor()` 返回空串时保留既有朝向（FR-4）。测试用「`posLevel: 2` + `mousePosEnd: null` + 有效 `startBottom/endBottom`」锁住这一点。

### 9.3 偏差 2：`validCoord` 改为返回严格布尔

原实现是 `return point && …`，入参为 `undefined` 时返回 `undefined`。抽成模块导出后契约应当明确，改为 `Boolean(point) && …`。所有调用点都在 `if` 条件里，行为等价。

### 9.4 回归测试的有效性已实测（变异验证）

为确认 §5.2 那条域级断言不是「恒真」，临时把缺陷注入回去（在 `!anchor` 分支里也对光标点调用 `toDip`），结果 4 条测试失败，且域级断言给出的坐标正是 §2.3 预测的症状：

```
cursor anchor left the secondary: {"x":1879,"y":480,"width":424,"height":40}
```

`(1879, 480)` 落在主屏工作区（0–2560 × 0–1440）内——即参考点被算成 `3136/1.5 = 2091`、`720/1.5 = 480` 后，工具栏整块跳到了**主屏**。随后已还原注入，测试恢复全绿。

### 9.5 仍待办

- 用同一条日志回头查「副屏置顶/置底」报告里未被解释的钳制现象（§8）——但注意 §9.6 已排除「工具栏贴边」与本缺陷的关联。

### 9.6 M3 实机复验（2026-09-27 补记，部分完成）

在混合 DPI 机器（主屏 2560×1440 @1.5 横向；副屏 1152×2048 @1.25 纵向）上以**源码方式**运行修复后的构建（`npx electron .`，日志 `installType: development`），用 computer-use 在**副屏**上做真实划词。两次真实选区的结果：

| 选区来源 | `posLevel` | `anchorSource` | `refPoint`（DIP） | `displayId` | 工具栏 DIP x |
|---|---|---|---|---|---|
| 记事本（UIA 文本） | 3 | `hook` | 3294.4 | `3644723383`（副屏） | 3288（clamp 后） |
| Windows Terminal（UIA 文本） | 3 | `hook` | 2995.2 | `3644723383`（副屏） | 2995 |

**结论一（无回归）**：hook 分支（本来就正确的分支）在修复后行为不变——记事本那次工具栏位置（DIP 3288）与修复前已安装构建实测位置（物理 4750 → DIP 3288）**完全一致**；两次都落在副屏、`displayId` 都是副屏。

**结论二（本缺陷的触发分支在真机上未能到达）**：记事本与 Windows Terminal **都**报 `posLevel: 3`，即两者都通过 UIA 取到了文本，hook 不会走剪贴板兜底。因此 `posLevel: 0` 这条被修复的分支**没有**在真机上复现；它的正确性由 §9.4 的变异验证过的单测保证（§5.1 的 7 条断言 + §5.2 的域级不变量）。要在真机上覆盖它，需要一个没有 UIA 文本层的选区来源（提权进程、canvas 渲染文字、部分 Java/Qt 程序）。

**结论三（推翻 §0.2 的原始归因）**：修复前观察到「工具栏被挤到副屏最右边缘」与修复后的位置相同，且日志显示那次走的是 `posLevel: 3` 的 hook 分支——该现象是本缺陷**无关**的正常 clamp（见 §0.2 的推导）。

**结论四（诊断日志的可用性）**：`Selection anchor:` 确实一次回答了「走了哪个分支、锚点落在哪块屏」。但 `logSelectionDiagnosticOnce` 的**同一 reason 只记一次**语义限制了连续观察：第二次划词的详情不会落盘，需要重启应用才能记录下一条。若要把它当成长期排查手段，应改为按事件记录（或加去重窗口），这属于后续工作。


