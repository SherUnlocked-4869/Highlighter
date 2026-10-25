// 浮动落位契约：region 截图与「钉图 → 右键重新标注」必须用同一条规则，且任何情况下
// 都不许被窗口裁掉（真机缺陷：重新标注时工具栏落进截图内侧顶部且右侧被截断）。
//
// 纯函数 resolveFloatingPlacement 在 capture/selection-utils.js（受覆盖率门禁的模块），
// capture.js 的工具栏与元素条避让共用它；主进程侧的"编辑器预留条带"是另一半：
// 没有条带，工具栏就没有"图像下方"这个位置可放。
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { resolveFloatingPlacement, toolbarWidthLimit } = require('../capture/selection-utils')

const root = path.join(__dirname, '..')
const script = fs.readFileSync(path.join(root, 'capture', 'capture.js'), 'utf8')
const css = fs.readFileSync(path.join(root, 'capture', 'capture.css'), 'utf8')
const pinDomain = fs.readFileSync(path.join(root, 'main/domains/pin/index.js'), 'utf8')
// 2026-10-25（history「继续编辑」改造 §5.3 / §8.1）：紧凑编辑器的窗口算式与条带常数从
// pin 域抽到了共用的纯函数模块，pin 与 history 两条重编辑入口都走它。下面的常数读取从
// pin 源码改指向这里 —— 契约（常数与 UI 实测尺寸的关系）完全不变，只是换了归属文件。
const editorLayoutSource = fs.readFileSync(path.join(root, 'shared', 'editor-layout.js'), 'utf8')
const { resolveEditorLayout, EDITOR_LAYOUT_CONSTANTS } = require('../shared/editor-layout')

const STRIP = { width: 880, height: 78 }
const VIEWPORT = { width: 1493, height: 933 }

function place(anchor, size = STRIP, viewport = VIEWPORT) {
  return resolveFloatingPlacement({ anchor, size, viewport, gap: 10, padding: 6 })
}

test('the strip stays below the region whenever that fits (the shipped placement)', () => {
  const placement = place({ x: 100, y: 100, w: 600, h: 400 })
  // 右对齐会越界（100+600-880 < 6）→ 夹到 6；纵向仍在区域下方 10px。
  assert.deepEqual(placement, { left: 6, top: 510, above: false })
  assert.equal(place({ x: 0, y: 0, w: 400, h: 200 }).left, 6)
  // 右对齐到区域右缘；区域右缘太靠右时夹到视图内的最右可用位。
  assert.equal(place({ x: 900, y: 0, w: 500, h: 200 }).left, 520)
  assert.equal(place({ x: 1200, y: 0, w: 500, h: 200 }).left, 1493 - 880 - 6)
})

test('the strip flips above the region only when that is where it fits', () => {
  const placement = place({ x: 100, y: 700, w: 600, h: 200 })
  assert.equal(placement.top, 700 - 10 - 78)
  assert.equal(placement.above, true)
})

test('when the strip cannot right-align it centres on the region instead of the screen edge', () => {
  // 真机缺陷：951px 宽的工具栏 + 200px 的小选区时，右对齐装不下就夹到 left=6 —— 工具组
  // 离选区最远 ~600px。新规则：装不下时居中到选区中心（仍夹在视图内）。
  const strip = { width: 951, height: 78 }
  const viewport = { width: 1493, height: 933 }
  const placeWith = (x1, x2) => {
    const anchor = { x: x1, y: 500, w: x2 - x1, h: 200 }
    return resolveFloatingPlacement({ anchor, size: strip, viewport, gap: 10, padding: 6 })
  }
  // 中间的小选区：中心对齐（不再贴到屏幕最左）。
  assert.equal(placeWith(600, 800).left, Math.round(700 - 951 / 2))
  assert.equal(placeWith(400, 600).left, Math.round(500 - 951 / 2))
  assert.ok(placeWith(600, 800).left > 6, 'not thrown to the viewport edge')
  // 选区贴屏左时居中会算出负值 → 仍然只能贴左（物理上无解，不是回归）。
  assert.equal(placeWith(100, 300).left, 6)
  // 红线：右对齐装得下时逐字不变（宽选区与右半屏选区都不受影响）。
  assert.equal(placeWith(900, 1100).left, 1100 - 951)
  assert.equal(placeWith(100, 1300).left, 1300 - 951)
  // 越到右边界之外时仍然夹到最右可用位（此时居中与右对齐同解）。
  assert.equal(placeWith(1400, 1490).left, 1493 - 951 - 6)
  // 性质断言：居中后的工具栏中心不会比"夹到最左"离选区中心更远。
  for (const [x1, x2] of [[100, 300], [400, 600], [600, 800], [700, 900]]) {
    const placement = placeWith(x1, x2)
    const center = (x1 + x2) / 2
    const centredDistance = Math.abs(placement.left + strip.width / 2 - center)
    const clampedDistance = Math.abs(6 + strip.width / 2 - center)
    assert.ok(centredDistance <= clampedDistance, `region ${x1}..${x2} must not be farther than the old clamp`)
  }
})

test('the placement source keeps both halves of the horizontal rule', () => {
  const utils = fs.readFileSync(path.join(root, 'capture/selection-utils.js'), 'utf8')
  // 右对齐优先、越界改居中 —— 两个分支都必须留在源码里（删掉任一都会踩回真机缺陷）。
  assert.match(utils, /const rightAligned = anchorX \+ anchorW - width/)
  assert.match(utils, /const left = rightAligned >= padding && rightAligned <= maximumLeft\s*\?\s*rightAligned\s*:\s*clamp\(anchorX \+ anchorW \/ 2 - width \/ 2, padding, maximumLeft\)/)
})

test('a region with no room on either side docks the strip inside its bottom, never at the top', () => {
  // 真机现场：钉图重新标注时窗口只比图像大一点点 —— 下方放不下、上方也放不下。
  // 旧实现 Math.max(6, ...) 把工具栏夹到视图顶部（= 落在图像内侧顶部）且右侧越界被裁。
  const anchor = { x: 300, y: 0, w: 300, h: 304 }
  const viewport = { width: 900, height: 304 }
  const placement = resolveFloatingPlacement({ anchor, size: { width: 300, height: 78 }, viewport, gap: 10, padding: 6 })
  // 贴着图像底边、在图像内侧，整体仍在视图内 —— 而不是贴到 y=6 的顶部。
  assert.equal(placement.top, 304 - 10 - 78)
  assert.equal(placement.above, false)
  assert.ok(placement.top + 78 <= viewport.height - 6, 'fully inside the viewport')
  assert.ok(placement.top > 6, 'not clamped to the viewport top')
  assert.equal(placement.left, Math.min(300 + 300 - 300, 900 - 300 - 6))
})

test('a surface larger than the viewport stays flush with the padded origin', () => {
  // 退化兜底：工具栏比窗口还宽/还高时，起点落在 padding 上（贴住可见区），不会出现负坐标。
  const placement = resolveFloatingPlacement({
    anchor: { x: 0, y: 0, w: 200, h: 200 },
    size: { width: 1200, height: 400 },
    viewport: { width: 400, height: 300 },
    gap: 10,
    padding: 6
  })
  assert.deepEqual(placement, { left: 6, top: 6, above: false })
  assert.ok(placement.left >= 6 && placement.top >= 6)
})

test('placement is deterministic, integer and never returns negative coordinates', () => {
  const cases = [
    [{ x: 0, y: 0, w: 1, h: 1 }, { width: 1493, height: 933 }],
    [{ x: 0, y: 900, w: 1493, h: 33 }, { width: 1493, height: 933 }],
    [{ x: 1400, y: 0, w: 93, h: 933 }, { width: 1493, height: 933 }],
    [{ x: 0, y: 0, w: 0, h: 0 }, { width: 1, height: 1 }],
    [{ x: 10, y: 10, w: 40, h: 30 }, { width: 60, height: 50 }]
  ]
  for (const [anchor, viewport] of cases) {
    const first = place(anchor, STRIP, viewport)
    assert.deepEqual(place(anchor, STRIP, viewport), first, 'deterministic')
    assert.equal(Number.isInteger(first.left), true)
    assert.equal(Number.isInteger(first.top), true)
    assert.ok(first.left >= 0 && first.top >= 0, `no negative origin for ${JSON.stringify(anchor)}`)
    // 能放下时必须整体可见（放不下时按 padding 贴边，不产生越界的另一侧）。
    if (first.left + STRIP.width <= viewport.width) assert.ok(first.left + STRIP.width <= viewport.width - 6 + 1)
  }
  // 非法入参不抛错、退化为 padding 起点。
  assert.deepEqual(resolveFloatingPlacement({}), { left: 6, top: 6, above: false })
  assert.deepEqual(resolveFloatingPlacement(), { left: 6, top: 6, above: false })
})

test('capture.js has exactly one placement rule, shared by the strip and the element bar', () => {
  assert.match(script, /function toolbarPlacement\(\) \{[\s\S]{0,520}?resolveFloatingPlacement\(\{\s*anchor: selection,/)
  assert.match(
    script,
    /function updateFloatingUi\(\) \{[\s\S]{0,1400}?const placement=toolbarPlacement\(\)\s*toolbar\.style\.left=`\$\{placement\.left\}px`; toolbar\.style\.top=`\$\{placement\.top\}px`; toolbar\.classList\.toggle\('above',placement\.above\)/
  )
  assert.match(script, /const toolbarPlace = resolveFloatingPlacement\(\{\s*anchor: selection,/)
  // 旧的"夹到视图顶部"回退必须从工具栏/元素条这两处消失（它正是把工具栏塞进图像内侧
  // 顶部的元凶）；positionOcrResultBar 是另一条独立的 OCR 结果条，保持原公式。
  const toolbarSlice = script.slice(
    script.indexOf('function toolbarPlacement()'),
    script.indexOf('function positionOcrResultBar()')
  )
  assert.ok(toolbarSlice.length > 0)
  assert.doesNotMatch(toolbarSlice, /top=selection\.y-rect\.height-10/)
  assert.doesNotMatch(toolbarSlice, /top=Math\.max\(6,top\)|top = Math\.max\(6, top\)/)
})

// ---------- 主进程预留条带：必须容得下"这个窗口宽度下工具栏实际会有多高" ----------

function stripConstants() {
  // The numbers live in shared/editor-layout.js now (pin and history share them), so the
  // source contract is read there. Names are the historical pin ones, upper-cased; the
  // pattern still requires a bare integer literal, which is what keeps a "just tweak it"
  // edit visible as a contract change.
  const read = (name) => {
    const match = editorLayoutSource.match(new RegExp(`const ${name} = (\\d+)`))
    assert.ok(match, `${name} must stay a named integer constant in shared/editor-layout.js`)
    return Number(match[1])
  }
  return {
    rowMinContent: read('ROW_MIN_CONTENT'),
    rowHeight: read('STRIP_ROW_HEIGHT'),
    optionsRow: read('OPTIONS_ROW_HEIGHT'),
    chrome: read('STRIP_CHROME'),
    slack: read('STRIP_SLACK'),
    toolbarSpace: read('TOOLBAR_SPACE')
  }
}

// 从 capture.html/capture.css 现算主行单行最小宽度（不依赖源码里的常数）。
function measureMainRowMinContent() {
  const html = fs.readFileSync(path.join(root, 'capture/capture.html'), 'utf8')
  const css = fs.readFileSync(path.join(root, 'capture/capture.css'), 'utf8')
  const mainRow = html.slice(html.indexOf('<div class="toolbar-row">'), html.indexOf('<div id="toolOptions"'))
  const number = (pattern, source = css) => {
    const match = source.match(pattern)
    assert.ok(match, `could not read ${pattern}`)
    return Number(match[1])
  }
  const iconMinimum = number(/\.toolbar button \{[^}]*min-width:\s*(\d+)px/)
  const iconPadding = number(/\.toolbar button \{[^}]*padding:\s*0 (\d+)px/)
  const iconGlyph = number(/\.toolbar-icon \{[^}]*width:\s*(\d+)px/)
  const iconWidth = Math.max(iconMinimum, iconGlyph + iconPadding * 2)
  // 2026-10-15：线宽组也成了图标按钮 —— 实际宽度由它自己的 min-width/padding 决定（不再按
  // 文字的 min-width 算），而且这三个按钮必须从"动作按钮"里排除。
  const widthMinimum = number(/\.width-group button \{[^}]*min-width:\s*(\d+)px/)
  const widthPadding = number(/\.width-group button \{[^}]*padding:\s*0 (\d+)px/)
  const widthButton = Math.max(widthMinimum, iconGlyph + widthPadding * 2)
  const rowGap = number(/\.toolbar-row \{[^}]*gap:\s*(\d+)px/)
  const toolGap = number(/\.tool-group \{[^}]*gap:\s*(\d+)px/)
  const dividerBreadth = number(/\.divider \{[^}]*width:\s*(\d+)px/) + number(/\.divider \{[^}]*margin:\s*0 (\d+)px/) * 2
  const swatch = number(/\.color-wrap > button \{[^}]*width:\s*(\d+)px/)
  const toolButtons = (mainRow.match(/data-tool="/g) || []).length
  const widthButtons = (mainRow.match(/data-annotation-width="/g) || []).length
  const dividers = (mainRow.match(/class="divider"/g) || []).length
  const widthIcons = (mainRow.match(/data-annotation-width="\d"[^>]*>\s*<span class="toolbar-icon"/g) || []).length
  const iconButtons = (mainRow.match(/<button[^>]*>\s*<span class="toolbar-icon"/g) || []).length - widthIcons
  const actionButtons = iconButtons - toolButtons // undo/redo + the action buttons
  const toolGroup = toolButtons * iconWidth + (toolButtons - 1) * toolGap
  const widthGroup = widthButtons * widthButton + (widthButtons - 1) * toolGap
  // 直接子元素：tool-group、分隔线、色块、宽度组、分隔线、undo/redo、分隔线、其余动作按钮。
  const children = [
    toolGroup,
    ...Array(dividers - 2).fill(dividerBreadth),
    swatch,
    widthGroup,
    ...Array(2).fill(iconWidth),
    ...Array(actionButtons - 2).fill(iconWidth)
  ]
  return children.reduce((sum, width) => sum + width, 0) + Math.max(0, children.length - 1) * rowGap
}

test('the reserved strip is derived from the toolbar the window will actually show', () => {
  const { rowMinContent, rowHeight, optionsRow, chrome, slack, toolbarSpace } = stripConstants()
  const measured = measureMainRowMinContent()

  // 1. 单行最小宽度：源码常数必须 ≥ 从 HTML/CSS 现算的值（漏算新按钮会让这条先红）。
  assert.ok(rowMinContent >= measured, `ROW_MIN_CONTENT ${rowMinContent} must cover the measured ${measured}`)
  // 2. 窗口宽度扣掉工具栏自身内边距/留白后仍然放得下一行 —— 否则主行会折行、条带变矮。
  assert.ok(toolbarSpace - chrome - 20 >= measured, `toolbarSpace ${toolbarSpace} must fit one line (${measured}) after chrome and viewport padding`)

  const stripFor = (rows) => rows * rowHeight + optionsRow + chrome + slack
  const toolbarFor = (rows) => rows * rowHeight + optionsRow + chrome
  // 3. 一行：条带要能容纳两行工具栏（主行 + 选项行）+ 10px 间距 + 6px 边距。
  assert.ok(stripFor(1) >= toolbarFor(1) + 16, `one-line strip ${stripFor(1)} must fit ${toolbarFor(1)} + gap + padding`)
  // 4. 折成两行时同理（真机缺陷：折行后条带不够高，工具栏被推回图像内侧）。
  assert.ok(stripFor(2) >= toolbarFor(2) + 16, `two-line strip ${stripFor(2)} must fit ${toolbarFor(2)} + gap + padding`)
  assert.ok(stripFor(3) >= toolbarFor(3) + 16, `three-line strip ${stripFor(3)} must fit ${toolbarFor(3)} + gap + padding`)
})

test('the compact editor sizes the strip from the width it picks, for both re-edit entries', () => {
  // 归属：算式已抽到 shared/editor-layout.js（history「继续编辑」复用同一份）。pin 只剩
  // 委托，不再自带第二份算式 —— 这条断言钉的正是那个新意图。
  assert.match(pinDomain, /resolveEditorLayout\(/)
  assert.match(pinDomain, /scaleFactorFor\(/)
  assert.doesNotMatch(pinDomain, /const stripRows = Math\.max/)
  assert.doesNotMatch(pinDomain, /const ROW_MIN_CONTENT = \d+/)
  // 常数与公式留在共享模块里，形状照旧可读（值另由 is-equivalent 测试钉死）。
  assert.match(editorLayoutSource, /const TOOLBAR_SPACE = 1088/)
  assert.match(editorLayoutSource, /const stripRows = Math\.max\(1, Math\.ceil\(ROW_MIN_CONTENT \/ Math\.max\(1, width - STRIP_CHROME\)\)\)/)
  assert.match(editorLayoutSource, /const actionSpace = stripRows \* STRIP_ROW_HEIGHT \+ OPTIONS_ROW_HEIGHT \+ STRIP_CHROME \+ STRIP_SLACK/)

  // 原来的"width 必须先于 scale 算出"是一条**源码顺序**断言。顺序本身不是契约，行为才是：
  // 下面四条断言覆盖它想保护的东西，而且不依赖行号/书写顺序。
  const { rowHeight, optionsRow, chrome, slack } = stripConstants()
  const wide = { x: 0, y: 0, width: 1920, height: 1040 }
  const narrow = { x: 0, y: 0, width: 1024, height: 728 }
  const layoutIn = (workArea) => resolveEditorLayout({
    imageWidth: 4000,
    imageHeight: 3000,
    workArea,
    anchor: { x: workArea.x, y: workArea.y }
  })
  const wideLayout = layoutIn(wide)
  const narrowLayout = layoutIn(narrow)

  // ① 窗口宽度由工作区/下限/图片宽度推导，**不由缩放后的 imageWidth 反推**：
  //    超宽图片被缩到多小都不会把窗口宽度带小，图像永远装得下。
  for (const layout of [wideLayout, narrowLayout]) {
    assert.ok(layout.imageBounds.width <= layout.editorBounds.width, 'image never wider than the window')
    assert.equal(
      layout.editorBounds.width,
      Math.min(layout.workArea.width, Math.max(EDITOR_LAYOUT_CONSTANTS.TOOLBAR_SPACE, 4000)),
      'width derives from the source width, not from the fitted image'
    )
  }
  // ② 窄工作区真的把主行折成多行 → 动作区更高（这就是 stripRows 存在的理由）。
  assert.ok(
    narrowLayout.stripRows > wideLayout.stripRows,
    `narrow work area must wrap the strip (${narrowLayout.stripRows} vs ${wideLayout.stripRows})`
  )
  assert.ok(narrowLayout.actionSpace > wideLayout.actionSpace, 'a wrapped strip reserves more height')
  assert.equal(
    narrowLayout.actionSpace,
    narrowLayout.stripRows * rowHeight + optionsRow + chrome + slack,
    'actionSpace = rows * rowHeight + optionsRow + chrome + slack'
  )
  // ③ ④ 缩放永不放大，窗口（含图像与条带）永远装得进工作区。
  for (const layout of [wideLayout, narrowLayout]) {
    assert.ok(layout.scale <= 1, 'scale never magnifies')
    assert.ok(layout.editorBounds.height <= layout.workArea.height, 'height fits the work area')
    assert.ok(layout.editorBounds.x >= layout.workArea.x, 'x inside the work area')
    assert.ok(layout.editorBounds.y >= layout.workArea.y, 'y inside the work area')
    assert.ok(layout.editorBounds.x + layout.editorBounds.width <= layout.workArea.x + layout.workArea.width)
    assert.ok(layout.editorBounds.y + layout.editorBounds.height <= layout.workArea.y + layout.workArea.height)
    assert.ok(layout.editorBounds.height - layout.imageBounds.height >= layout.stripRows * rowHeight + optionsRow + chrome)
  }
  // 两条路径（普通重新标注与 OCR/翻译）共用同一段预留逻辑。
  assert.doesNotMatch(pinDomain, /isRecognitionEditor/)
  assert.match(pinDomain, /transparent: true,/)
})

// ---------- 方案 2（D12）：工具栏宽度跟随选区，窄选区折行成紧凑块 ----------

function limitFor(x1, x2, viewportWidth = 1493) {
  return toolbarWidthLimit({
    anchor: { x: x1, y: 0, w: x2 - x1, h: 200 },
    viewport: { width: viewportWidth, height: 933 },
    minimum: 420,
    slack: 160,
    margin: 20
  })
}

test('the strip width limit follows a narrow region but never drops below its own floor', () => {
  // 小选区：420 的下限接管（选区宽 + 160 够不到下限）—— 一个紧凑块，而不是 ~1000px 的长条。
  assert.equal(limitFor(600, 800), 420)
  assert.equal(limitFor(100, 300), 420)
  // 中等选区：选区宽 + 160 才是指标（400 + 160）。
  assert.equal(limitFor(400, 800), 560)
  // 宽选区：视口上限接管（1493 − 20 = 1473），与它替换掉的 CSS 默认逐字一致。
  assert.equal(limitFor(0, 1400), 1473)
  assert.equal(limitFor(0, 1493), 1473)
})

test('the strip width limit is integral, deterministic and degrades instead of collapsing', () => {
  const anchor = { x: 0, y: 0, w: 333.7, h: 200 }
  const viewport = { width: 1473, height: 933 }
  assert.equal(toolbarWidthLimit({ anchor, viewport }), 494) // round(333.7 + 160)
  assert.deepEqual(toolbarWidthLimit({ anchor, viewport }), toolbarWidthLimit({ anchor, viewport }))
  assert.ok(Number.isInteger(toolbarWidthLimit({ anchor: { w: 42.4 }, viewport: { width: 900 } })))
  // 视口比下限还窄时以视口为准（与 CSS 的 calc(100vw - 20px) 同解），不产生负数。
  assert.equal(toolbarWidthLimit({ anchor: { w: 200 }, viewport: { width: 300 } }), 280)
  // 非有限/缺失视口退化为"选区 + slack"而不是塌成 0；空入参退化为下限。
  assert.equal(toolbarWidthLimit({ anchor: { w: 1000 }, viewport: { width: Number.NaN } }), 1160)
  assert.equal(toolbarWidthLimit({ anchor: { w: 1000 }, viewport: { width: 0 } }), 1160)
  assert.equal(toolbarWidthLimit({}), 420)
  assert.equal(toolbarWidthLimit(), 420)
})

test('the region-following width keeps a small region\u2019s tools next to it', () => {
  const viewport = { width: 1493, height: 933 }
  const height = 145 // 折行后的实测高度
  for (const [x1, x2] of [[100, 300], [400, 600], [600, 800], [900, 1100], [1200, 1400]]) {
    const anchor = { x: x1, y: 500, w: x2 - x1, h: 200 }
    const width = limitFor(x1, x2)
    const placed = resolveFloatingPlacement({ anchor, size: { width, height }, viewport, gap: 10, padding: 6 })
    const rightAligned = x1 + anchor.w - width
    if (rightAligned >= 6 && rightAligned <= 1493 - width - 6) {
      // 落位规则本身没动：宽度变小后"右对齐到选区右缘"这一分支才真的装得下。
      assert.equal(placed.left, rightAligned, `region ${x1}..${x2} must right-align the compact strip`)
    }
    // 条的左缘最多比选区左缘再靠左 (width − 选区宽) —— 被 420 的下限封住，而不是被视口宽封住。
    assert.ok(
      x1 - placed.left <= width - anchor.w || placed.left === 6,
      `region ${x1}..${x2} must keep the strip near the region (left=${placed.left}, width=${width})`
    )
  }
})

test('the width limit has one write point, one call site and an explicit opt-out for the pin editor', () => {
  // 唯一的 inline max-width 写点：跳过时清成空串，回落到 capture.css 的 calc(100vw - 20px)。
  assert.equal((script.match(/toolbar\.style\.maxWidth =/g) || []).length, 1, 'one write point for the inline cap')
  assert.match(
    script,
    /function applyToolbarWidthLimit\(\) \{[\s\S]{0,900}?toolbar\.style\.maxWidth = limit === null \? '' : `\$\{limit\}px`\s*\n\s*invalidateToolbarSize\(\)/
  )
  // 每帧在任何人读缓存 rect 之前应用（renderOverlay -> updateFloatingUi）。
  assert.match(script, /function updateFloatingUi\(\) \{[\s\S]{0,240}?applyToolbarWidthLimit\(\)\s*\n\s*updateElementBar\(\)/)
  // CSS 默认必须留着：opt-out 的路径（钉图重新标注）靠它兜底。
  assert.match(css, /\.toolbar \{[\s\S]{0,240}?max-width: calc\(100vw - 20px\)/)
  // opt-out 条件 = 主进程下发了固定 imageBounds（只有钉图重新标注这一条路径，见 capture/index.js）。
  assert.match(script, /function stripFollowsRegion\(\) \{\s*return !initData\?\.imageBounds\s*\}/)
  assert.match(script, /const limit = stripFollowsRegion\(\) && selection\s*\n\s*\? toolbarWidthLimit\(\{/)
  // 上限不变时不写 DOM、不失效缓存（每帧都会走到这里）。
  assert.match(script, /if \(limit === toolbarMaxWidth\) return/)
})
