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

const { resolveFloatingPlacement } = require('../capture/selection-utils')

const root = path.join(__dirname, '..')
const script = fs.readFileSync(path.join(root, 'capture', 'capture.js'), 'utf8')
const pinDomain = fs.readFileSync(path.join(root, 'main/domains/pin/index.js'), 'utf8')

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

test('the pin re-annotate editor reserves a strip that fits the two-row strip', () => {
  // 预留条带 = 图像高度之外的空间：必须 ≥ 工具栏两行高度 + gap + padding，否则渲染层
  // 只能退到"内侧贴底"，与 region 截图的位置就不一致了。
  const match = pinDomain.match(/const actionSpace = (\d+)/)
  assert.ok(match, 'actionSpace must stay a named constant in the pin editor')
  const actionSpace = Number(match[1])
  const stripHeight = 78 // 2 x 30px rows + 12px padding + 4px gap + 2px borders
  assert.ok(actionSpace >= stripHeight + 10 + 6, `actionSpace ${actionSpace} must fit the two-row strip + gap + padding`)
  assert.match(pinDomain, /const toolbarSpace = 900/)
  // 两条路径（普通重新标注与 OCR/翻译）都走同一段预留逻辑，不再有 if (isRecognitionEditor) 分支。
  assert.doesNotMatch(pinDomain, /isRecognitionEditor/)
  assert.match(pinDomain, /transparent: true,/)
})
