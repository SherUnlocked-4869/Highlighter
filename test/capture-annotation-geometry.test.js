// P0-5 PR1 —— capture/annotation-geometry.js 的纯函数用例（方案 §8.4「测试」行）
// + capture.js / capture.html / capture.css 的 PR1 接线契约（Delete 不再 pop、快照栈、
// pointerdown 优先级、D4 先确认、浮动 #elementBar）。
//
// 坐标系：本文件里所有坐标都是**屏幕 CSS 坐标**（方案 §8.3）；导出坐标只出现在
// exportSelectionCanvas() 内部，不在纯函数层出现。
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  MAX_ANNOTATION_HISTORY,
  MAX_PEN_POINTS,
  DEFAULT_HIT_TOLERANCE,
  MIN_RESIZE_SIZE,
  MOVE_THRESHOLD,
  annotationBounds,
  hitTestAnnotation,
  findAnnotationAt,
  movedBeyondThreshold,
  translateAnnotation,
  resizeAnnotationToBox,
  reorderAnnotation,
  clampAnnotationToStage,
  cloneAnnotations
} = require('../capture/annotation-geometry')
const { textFontSize, serialRadius, highlightWidth } = require('../capture/annotation-style')

const root = path.join(__dirname, '..')
const script = fs.readFileSync(path.join(root, 'capture', 'capture.js'), 'utf8')
const html = fs.readFileSync(path.join(root, 'capture', 'capture.html'), 'utf8')
const css = fs.readFileSync(path.join(root, 'capture', 'capture.css'), 'utf8')

function sliceBetween(source, from, to) {
  const start = source.indexOf(from)
  const end = source.indexOf(to)
  assert.ok(start >= 0 && end > start, `could not slice ${from} .. ${to}`)
  return source.slice(start, end)
}

const pointerdownSource = sliceBetween(script, "canvas.addEventListener('pointerdown'", "canvas.addEventListener('pointermove'")
const pointermoveSource = sliceBetween(script, "canvas.addEventListener('pointermove'", "canvas.addEventListener('pointerup'")
const pointerupSource = sliceBetween(script, "canvas.addEventListener('pointerup'", "canvas.addEventListener('pointercancel'")

test('annotationBounds normalizes reversed endpoints instead of trusting the drag direction', () => {
  assert.deepEqual(
    annotationBounds({ type: 'rect', x: 100, y: 80, x2: 10, y2: 20, color: '#f00', width: 4 }),
    { x: 10, y: 20, w: 90, h: 60 }
  )
  assert.deepEqual(
    annotationBounds({ type: 'arrow', x: 40, y: 5, x2: 10, y2: 5, color: '#f00', width: 2 }),
    { x: 10, y: 5, w: 30, h: 0 }
  )
  assert.deepEqual(
    annotationBounds({ type: 'ellipse', x: 30, y: 30, x2: 30, y2: 10, color: '#f00', width: 8 }),
    { x: 30, y: 10, w: 0, h: 20 }
  )
  assert.equal(annotationBounds(null), null)
})

test('annotationBounds degrades a pen point set and a single point to a zero-size box', () => {
  assert.deepEqual(
    annotationBounds({ type: 'pen', x: 0, y: 0, points: [{ x: 30, y: 10 }, { x: 10, y: 40 }, { x: 20, y: 20 }] }),
    { x: 10, y: 10, w: 20, h: 30 }
  )
  assert.deepEqual(annotationBounds({ type: 'pen', x: 5, y: 5, points: [{ x: 5, y: 5 }] }), { x: 5, y: 5, w: 0, h: 0 })
  // 点集缺失/含非法点：退化为 x/y 的单点，不产生 NaN
  assert.deepEqual(annotationBounds({ type: 'pen', x: 5, y: 5 }), { x: 5, y: 5, w: 0, h: 0 })
  assert.deepEqual(
    annotationBounds({ type: 'pen', x: 0, y: 0, points: [{ x: 1, y: 1 }, { x: Number.NaN, y: 9 }] }),
    { x: 1, y: 1, w: 0, h: 0 }
  )
})

test('annotationBounds sizes text without an x2 and never throws', () => {
  const size = textFontSize(4)
  assert.deepEqual(
    annotationBounds({ type: 'text', x: 12, y: 30, text: 'abc', color: '#f00', width: 4 }),
    { x: 12, y: 30, w: Math.max(size, 3 * size * 0.6), h: size }
  )
  assert.deepEqual(
    annotationBounds({ type: 'text', x: 1, y: 2, color: '#f00', width: 4 }),
    { x: 1, y: 2, w: size, h: size }
  )
})

test('annotationBounds frames a serial with 2×radius and a watermark with its own w/h', () => {
  const radius = serialRadius(4)
  assert.deepEqual(
    annotationBounds({ type: 'serial', x: 100, y: 120, number: 3, color: '#f00', width: 4 }),
    { x: 100 - radius, y: 120 - radius, w: radius * 2, h: radius * 2 }
  )
  assert.deepEqual(
    annotationBounds({ type: 'watermark', x: 4, y: 8, w: 300, h: 200, content: '知何似' }),
    { x: 4, y: 8, w: 300, h: 200 }
  )
  assert.deepEqual(annotationBounds({ type: 'watermark', x: 4, y: 8 }), { x: 4, y: 8, w: 0, h: 0 })
})

test('findAnnotationAt hits a rect edge inside the stroke tolerance and never its interior', () => {
  const rect = { type: 'rect', x: 0, y: 0, x2: 100, y2: 100, color: '#f00', width: 4 }
  assert.equal(findAnnotationAt([rect], { x: 100, y: 50 }), rect, 'on the edge')
  assert.equal(findAnnotationAt([rect], { x: 101, y: 50 }), rect, '1px outside the edge')
  assert.equal(findAnnotationAt([rect], { x: 50, y: 50 }), null, 'the centre must stay free for dragging the selection')
  assert.equal(findAnnotationAt([rect], { x: 20, y: 50 }), null, '20px inside the edge')
  assert.equal(findAnnotationAt([rect], { x: 140, y: 50 }), null)
  assert.equal(hitTestAnnotation(rect, { x: 20, y: 50 }), false)
  assert.equal(hitTestAnnotation(rect, { x: 20, y: 50 }, 40), true, 'an explicit tolerance overrides the default')
  assert.equal(findAnnotationAt([rect], { x: Number.NaN, y: 0 }), null)
})

// OCR 评审修复：highlight 是"粗线段"，必须与 line/arrow 同走 pointToSegmentDistance；
// 若落进 insideBox，斜向高亮的整个 bbox 都会可点 —— 既吞掉其下元素的选中，
// 又因 pointerdown 的"元素命中 > 拖选区"挡住拖选区（rect/ellipse 用环带刻意规避的同一失效模式）。
test('a diagonal highlight is hit along its stroke, not across its whole bounding box', () => {
  const highlight = { type: 'highlight', x: 0, y: 0, x2: 100, y2: 100, color: '#ff0', width: 4 }
  const onStroke = { x: 50, y: 50 }
  assert.equal(hitTestAnnotation(highlight, onStroke), true, 'the stroke itself is hittable')
  // bbox 内的对角空白处：离线段约 35px，远大于默认容差 → 必须不命中。
  const offStroke = { x: 90, y: 10 }
  assert.equal(hitTestAnnotation(highlight, offStroke), false, 'the empty corner of the bbox must stay free')
  assert.equal(findAnnotationAt([highlight], offStroke), null)
  // 与 line/arrow 同口径：沿线段的近旁仍可命中。
  assert.equal(hitTestAnnotation(highlight, { x: 52, y: 48 }), true)
})

test('findAnnotationAt follows the ellipse ring, not the disc, and survives a zero radius', () => {
  const ellipse = { type: 'ellipse', x: 0, y: 0, x2: 100, y2: 100, color: '#f00', width: 4 }
  assert.equal(findAnnotationAt([ellipse], { x: 100, y: 50 }), ellipse)
  assert.equal(findAnnotationAt([ellipse], { x: 50, y: 100 }), ellipse)
  assert.equal(findAnnotationAt([ellipse], { x: 50, y: 50 }), null)
  assert.equal(findAnnotationAt([ellipse], { x: 10, y: 50 }), null)
  assert.equal(findAnnotationAt([ellipse], { x: 140, y: 50 }), null)
  const degenerate = { type: 'ellipse', x: 10, y: 10, x2: 10, y2: 10, color: '#f00', width: 4 }
  assert.equal(hitTestAnnotation(degenerate, { x: 10, y: 10 }), true)
  assert.equal(hitTestAnnotation(degenerate, { x: 90, y: 90 }), false)
})

// ---------- B2：实心形状的内部命中（方案 D9） ----------

test('B2: a filled rect is hit through its interior, an outline-only one is not', () => {
  const outline = { type: 'rect', x: 0, y: 0, x2: 100, y2: 60, color: '#f00', width: 4 }
  const translucent = { ...outline, fill: 'translucent' }
  const solid = { ...outline, fill: 'solid' }
  // 改造前的语义（环带命中）必须逐字保持：空心矩形的中心仍然落空，否则它会吃掉拖选区。
  assert.equal(hitTestAnnotation(outline, { x: 50, y: 30 }), false)
  assert.equal(hitTestAnnotation(outline, { x: 0, y: 30 }), true)
  assert.equal(hitTestAnnotation(outline, { x: 2, y: 30 }), true)
  for (const filled of [translucent, solid]) {
    assert.equal(hitTestAnnotation(filled, { x: 50, y: 30 }), true, 'the interior belongs to a filled shape')
    assert.equal(hitTestAnnotation(filled, { x: 0, y: 30 }), true, 'the ring still hits')
    assert.equal(hitTestAnnotation(filled, { x: 140, y: 30 }), false, 'outside stays outside')
  }
  // 未知/脏 fill 一律按空心处理（resolveFill 的兜底 == D9 缺省）。
  assert.equal(hitTestAnnotation({ ...outline, fill: 'filled' }, { x: 50, y: 30 }), false)
  assert.equal(hitTestAnnotation({ ...outline, fill: null }, { x: 50, y: 30 }), false)
})

test('B2: a filled ellipse is hit through its interior, an outline-only one is not', () => {
  const outline = { type: 'ellipse', x: 0, y: 0, x2: 100, y2: 100, color: '#f00', width: 4 }
  const solid = { ...outline, fill: 'solid' }
  assert.equal(hitTestAnnotation(outline, { x: 50, y: 50 }), false)
  assert.equal(hitTestAnnotation(solid, { x: 50, y: 50 }), true)
  // 椭圆内部判定按半轴归一：角落（圆心到角点的归一距离 > 1）仍然不算命中。
  assert.equal(hitTestAnnotation(solid, { x: 4, y: 4 }), false)
  assert.equal(hitTestAnnotation(solid, { x: 100, y: 50 }), true, 'the ring still hits')
  // 退化椭圆（零半轴）不会被内部判定命中，也不会抛错。
  const degenerate = { type: 'ellipse', x: 10, y: 10, x2: 10, y2: 10, color: '#f00', width: 4, fill: 'solid' }
  assert.doesNotThrow(() => hitTestAnnotation(degenerate, { x: 10, y: 10 }))
  assert.equal(hitTestAnnotation(degenerate, { x: 10, y: 10 }), true)
  assert.equal(hitTestAnnotation(degenerate, { x: 60, y: 60 }), false)
})

test('B2: fill-aware hit testing still returns the topmost annotation (array end wins)', () => {
  const filled = { type: 'rect', x: 0, y: 0, x2: 100, y2: 100, color: '#f00', width: 4, fill: 'solid' }
  const text = { type: 'text', x: 30, y: 30, text: 'hi', color: '#0f0', width: 4 }
  assert.equal(findAnnotationAt([filled, text], { x: 50, y: 50 }), text)
  assert.equal(findAnnotationAt([text, filled], { x: 50, y: 50 }), filled)
})

test('findAnnotationAt uses the real segment for line and arrow, not the bbox corners', () => {
  const line = { type: 'line', x: 100, y: 100, x2: 0, y2: 0, color: '#f00', width: 4 }
  assert.deepEqual(annotationBounds(line), { x: 0, y: 0, w: 100, h: 100 })
  assert.equal(findAnnotationAt([line], { x: 50, y: 50 }), line)
  assert.equal(findAnnotationAt([line], { x: 100, y: 0 }), null, 'a bbox corner is not on the segment')
  const arrow = { type: 'arrow', x: 0, y: 0, x2: 100, y2: 0, color: '#f00', width: 4 }
  assert.equal(findAnnotationAt([arrow], { x: 50, y: 4 }), arrow)
  assert.equal(findAnnotationAt([arrow], { x: 50, y: 40 }), null)
})

test('findAnnotationAt walks a pen polyline and a single dot', () => {
  const pen = { type: 'pen', x: 0, y: 0, x2: 10, y2: 10, color: '#f00', width: 4, points: [{ x: 0, y: 0 }, { x: 10, y: 10 }] }
  assert.equal(findAnnotationAt([pen], { x: 5, y: 5 }), pen)
  assert.equal(findAnnotationAt([pen], { x: 5, y: 20 }), null)
  const dot = { type: 'pen', x: 5, y: 5, color: '#f00', width: 4, points: [{ x: 5, y: 5 }] }
  assert.equal(findAnnotationAt([dot], { x: 6, y: 6 }), dot)
  assert.equal(findAnnotationAt([dot], { x: 20, y: 20 }), null)
})

test('findAnnotationAt treats text, serial, watermark, blur and highlight as solid targets', () => {
  const text = { type: 'text', x: 10, y: 10, text: 'abc', color: '#f00', width: 4 }
  assert.equal(findAnnotationAt([text], { x: 12, y: 20 }), text)
  assert.equal(findAnnotationAt([text], { x: 500, y: 500 }), null)

  const serial = { type: 'serial', x: 100, y: 100, number: 1, color: '#f00', width: 4 }
  assert.equal(findAnnotationAt([serial], { x: 100 + serialRadius(4), y: 100 }), serial)
  assert.equal(findAnnotationAt([serial], { x: 100 + serialRadius(4) + 20, y: 100 }), null)

  const watermark = { type: 'watermark', x: 0, y: 0, w: 200, h: 100, content: 'w' }
  assert.equal(findAnnotationAt([watermark], { x: 100, y: 50 }), watermark)
  assert.equal(findAnnotationAt([watermark], { x: 400, y: 50 }), null)

  const blur = { type: 'blur', x: 0, y: 0, x2: 40, y2: 40, color: '#f00', width: 4 }
  assert.equal(findAnnotationAt([blur], { x: 20, y: 20 }), blur)

  // 高亮更宽：容差取 highlightWidth(width)/2
  const marker = { type: 'highlight', x: 0, y: 50, x2: 100, y2: 50, color: '#f00', width: 8 }
  assert.equal(highlightWidth(8) / 2, 16)
  assert.equal(findAnnotationAt([marker], { x: 50, y: 64 }), marker)
  assert.equal(findAnnotationAt([marker], { x: 50, y: 80 }), null)
})

test('findAnnotationAt returns the topmost of overlapping annotations (array end wins)', () => {
  const bottom = { type: 'rect', x: 0, y: 0, x2: 100, y2: 100, color: '#f00', width: 4 }
  const top = { type: 'rect', x: 0, y: 0, x2: 100, y2: 100, color: '#0f0', width: 4 }
  assert.equal(findAnnotationAt([bottom, top], { x: 50, y: 0 }), top)
  assert.equal(findAnnotationAt([top, bottom], { x: 50, y: 0 }), bottom)
  assert.equal(findAnnotationAt([], { x: 0, y: 0 }), null)
  assert.equal(findAnnotationAt(null, { x: 0, y: 0 }), null)
  assert.equal(findAnnotationAt([top], null), null)
})

test('translateAnnotation returns a moved copy and never mutates the original', () => {
  const source = {
    id: 7,
    type: 'pen',
    x: 10,
    y: 20,
    x2: 30,
    y2: 40,
    color: '#f00',
    width: 4,
    points: [{ x: 10, y: 20 }, { x: 30, y: 40 }]
  }
  const moved = translateAnnotation(source, 5, -5)
  assert.notEqual(moved, source)
  assert.notEqual(moved.points, source.points)
  assert.deepEqual(moved, {
    id: 7,
    type: 'pen',
    x: 15,
    y: 15,
    x2: 35,
    y2: 35,
    color: '#f00',
    width: 4,
    points: [{ x: 15, y: 15 }, { x: 35, y: 35 }]
  })
  assert.equal(source.x, 10)
  assert.deepEqual(source.points, [{ x: 10, y: 20 }, { x: 30, y: 40 }])

  // text 没有 x2：平移后也不能凭空长出 x2
  const text = translateAnnotation({ type: 'text', x: 1, y: 2, text: 'a', color: '#f00', width: 4 }, 3, 4)
  assert.deepEqual(text, { type: 'text', x: 4, y: 6, text: 'a', color: '#f00', width: 4 })
  assert.equal('x2' in text, false)
  assert.equal(translateAnnotation(null, 1, 1), null)
})

test('clampAnnotationToStage keeps the whole box inside the stage without touching the original (PR2)', () => {
  const rect = { type: 'rect', x: 700, y: 550, x2: 900, y2: 800, color: '#f00', width: 4 }
  const clamped = clampAnnotationToStage(rect, { w: 800, h: 600 })
  assert.notEqual(clamped, rect)
  assert.deepEqual(annotationBounds(clamped), { x: 600, y: 350, w: 200, h: 250 })
  // 原对象必须原地不动：拖动/微调走的一直是副本。
  assert.deepEqual([rect.x, rect.y, rect.x2, rect.y2], [700, 550, 900, 800])

  // 已经在舞台内也要返回副本（浅拷贝语义，不是同一个引用）。
  const serial = { type: 'serial', x: 100, y: 100, number: 1, color: '#f00', width: 4 }
  const untouched = clampAnnotationToStage(serial, { w: 800, h: 600 })
  assert.notEqual(untouched, serial)
  assert.deepEqual(untouched, serial)

  // 舞台参数接受 { width, height } 别名，结果一致。
  assert.deepEqual(
    clampAnnotationToStage(rect, { width: 800, height: 600 }),
    clampAnnotationToStage(rect, { w: 800, h: 600 })
  )
  assert.equal(clampAnnotationToStage(null, { w: 1, h: 1 }), null)
})

test('clampAnnotationToStage pins an oversized box to the stage edge instead of pushing it fully out (PR2)', () => {
  // 水印本身比舞台大：两个方向都退化为 [limit-size, 0]，起点被夹到 -200 / -300（右侧贴边）。
  const oversized = { type: 'watermark', x: -500, y: -500, w: 1000, h: 900, content: 'w' }
  assert.deepEqual(annotationBounds(clampAnnotationToStage(oversized, { w: 800, h: 600 })), { x: -200, y: -300, w: 1000, h: 900 })
  assert.deepEqual(
    annotationBounds(clampAnnotationToStage({ type: 'watermark', x: 400, y: 300, w: 1000, h: 900, content: 'w' }, { w: 800, h: 600 })),
    { x: 0, y: 0, w: 1000, h: 900 }
  )
})

test('clampAnnotationToStage moves a pen point set as one rigid body and rewrites its points (PR2)', () => {
  const pen = { type: 'pen', x: 780, y: 10, x2: 820, y2: 50, color: '#f00', width: 4, points: [{ x: 780, y: 10 }, { x: 820, y: 50 }] }
  const clamped = clampAnnotationToStage(pen, { w: 800, h: 600 })
  assert.deepEqual(clamped.points, [{ x: 760, y: 10 }, { x: 800, y: 50 }])
  assert.equal(clamped.x, 760)
  assert.notEqual(clamped.points, pen.points)
  assert.deepEqual(pen.points, [{ x: 780, y: 10 }, { x: 820, y: 50 }], 'the source point set stays untouched')
})

test('cloneAnnotations deep-copies pen points, caps them and isolates the snapshot (undo 精确还原)', () => {
  const annotations = [{
    id: 1,
    type: 'pen',
    x: 0,
    y: 0,
    x2: 10,
    y2: 10,
    color: '#f00',
    width: 4,
    points: [{ x: 0, y: 0 }, { x: 10, y: 10 }]
  }]
  const snapshot = cloneAnnotations(annotations)
  assert.deepEqual(snapshot, annotations)
  assert.notEqual(snapshot[0], annotations[0])
  assert.notEqual(snapshot[0].points, annotations[0].points)

  // 快照之后再编辑原对象，快照必须原地不动 —— 这就是"Ctrl+Z 精确回退"的前提。
  annotations[0].x = 500
  annotations[0].points.push({ x: 99, y: 99 })
  assert.equal(snapshot[0].x, 0)
  assert.equal(snapshot[0].points.length, 2)

  const big = {
    type: 'pen',
    x: 0,
    y: 0,
    color: '#f00',
    width: 4,
    points: Array.from({ length: MAX_PEN_POINTS + 25 }, (_value, index) => ({ x: index, y: index }))
  }
  assert.equal(cloneAnnotations([big])[0].points.length, MAX_PEN_POINTS)
  assert.deepEqual(cloneAnnotations(null), [])
  assert.deepEqual([MAX_ANNOTATION_HISTORY, MAX_PEN_POINTS, DEFAULT_HIT_TOLERANCE], [60, 10000, 6])
})

// ---------- PR3 纯函数：resizeAnnotationToBox（方案 §8.4 PR3，12 条用例的第 10 条） ----------
// 第 10 条 =「保方向 + 最小 3px」：下面第 1 个用例覆盖"保方向（含镜像不崩）"，第 3 个覆盖
// "最小 3px"；其余用例覆盖方案 §8.4 PR3 逐类型语义（rect/ellipse/blur/watermark、pen 等比、
// text 仅移动+字号、serial 仅半径）与"永远返回新对象"契约。

test('resizeAnnotationToBox adopts the new box for rect/ellipse/blur/watermark without touching the original (PR3)', () => {
  const rect = { type: 'rect', x: 100, y: 100, x2: 300, y2: 250, color: '#f00', width: 4 }
  const target = { x: 50, y: 60, w: 250, h: 190 }
  const resized = resizeAnnotationToBox(rect, target)
  assert.notEqual(resized, rect)
  assert.deepEqual(resized, { type: 'rect', x: 50, y: 60, x2: 300, y2: 250, color: '#f00', width: 4 })
  // 原对象原地不动：缩放走的始终是副本。
  assert.deepEqual([rect.x, rect.y, rect.x2, rect.y2], [100, 100, 300, 250])

  assert.deepEqual(
    resizeAnnotationToBox({ type: 'ellipse', x: 0, y: 0, x2: 40, y2: 20, color: '#f00', width: 2 }, { x: 10, y: 10, w: 80, h: 40 }),
    { type: 'ellipse', x: 10, y: 10, x2: 90, y2: 50, color: '#f00', width: 2 }
  )
  assert.deepEqual(
    resizeAnnotationToBox({ type: 'blur', x: 5, y: 5, x2: 15, y2: 25, color: '#f00', width: 4 }, { x: 0, y: 0, w: 30, h: 60 }),
    { type: 'blur', x: 0, y: 0, x2: 30, y2: 60, color: '#f00', width: 4 }
  )
  // watermark 用 x/y/w/h，没有 x2/y2 —— 四个字段同步跟到新 box。
  const watermark = { type: 'watermark', x: 4, y: 8, w: 300, h: 200, content: '知何似' }
  const scaled = resizeAnnotationToBox(watermark, { x: 20, y: 30, w: 150, h: 90 })
  assert.deepEqual(scaled, { type: 'watermark', x: 20, y: 30, w: 150, h: 90, content: '知何似' })
  assert.equal('x2' in scaled, false)
  assert.deepEqual([watermark.x, watermark.w], [4, 300])

  // 空输入/空 box 一律 null，绝不抛错。
  assert.equal(resizeAnnotationToBox(null, target), null)
  assert.equal(resizeAnnotationToBox(rect, null), null)
})

test('resizeAnnotationToBox keeps the endpoint direction of line/arrow so a reversed drag cannot flip it (PR3)', () => {
  // 旧 bbox 是 (0,0)-(100,100)，端点 1 在右下、端点 2 在左上；映射到新 box 后方向必须保持。
  const line = { type: 'line', x: 100, y: 100, x2: 0, y2: 0, color: '#f00', width: 4 }
  assert.deepEqual(
    resizeAnnotationToBox(line, { x: 200, y: 200, w: 100, h: 100 }),
    { type: 'line', x: 300, y: 300, x2: 200, y2: 200, color: '#f00', width: 4 }
  )
  assert.deepEqual([line.x, line.y, line.x2, line.y2], [100, 100, 0, 0], 'the source line stays untouched')

  // 箭头：水平段在新 box 里仍是同向水平段（高度退化时按中线映射，不塌到角上）。
  const arrow = { type: 'arrow', x: 0, y: 0, x2: 100, y2: 0, color: '#f00', width: 4 }
  assert.deepEqual(
    resizeAnnotationToBox(arrow, { x: 50, y: 50, w: 200, h: 100 }),
    { type: 'arrow', x: 50, y: 100, x2: 250, y2: 100, color: '#f00', width: 4 }
  )
  // 反向（镜像）拖拽：新 box 的宽高为负也不能让端点掉头，取绝对值后方向不变。
  const mirrored = resizeAnnotationToBox(line, { x: 10, y: 10, w: -90, h: -90 })
  assert.deepEqual(mirrored, { type: 'line', x: 100, y: 100, x2: 10, y2: 10, color: '#f00', width: 4 })
  assert.ok(mirrored.x2 < mirrored.x && mirrored.y2 < mirrored.y, 'the mirrored line still runs from its old start corner to its old end corner')

  // 垂直退化线（旧 w=0）：横向按中线映射，仍然是一条居中的竖线。
  const vertical = { type: 'line', x: 50, y: 0, x2: 50, y2: 100, color: '#f00', width: 2 }
  assert.deepEqual(
    resizeAnnotationToBox(vertical, { x: 0, y: 0, w: 100, h: 100 }),
    { type: 'line', x: 50, y: 0, x2: 50, y2: 100, color: '#f00', width: 2 }
  )
})

test('resizeAnnotationToBox floors every axis at 3px so a degenerate or mirrored box cannot produce a negative size (PR3)', () => {
  assert.equal(MIN_RESIZE_SIZE, 3)
  const rect = { type: 'rect', x: 100, y: 100, x2: 300, y2: 250, color: '#f00', width: 4 }
  const zero = resizeAnnotationToBox(rect, { x: 10, y: 10, w: 0, h: 0 })
  assert.deepEqual([zero.x2 - zero.x, zero.y2 - zero.y], [3, 3])
  const negative = resizeAnnotationToBox(rect, { x: 10, y: 10, w: -40, h: -60 })
  assert.deepEqual([negative.x, negative.y, negative.x2 - negative.x, negative.y2 - negative.y], [10, 10, 40, 60])
  // 舞台外的极端值也不崩：NaN/缺失一律按 0 处理后再抬到下限。
  const nan = resizeAnnotationToBox(rect, { x: Number.NaN, y: undefined, w: Number.NaN, h: 'x' })
  assert.deepEqual([nan.x, nan.y, nan.x2 - nan.x, nan.y2 - nan.y], [0, 0, 3, 3])
  assert.ok(Number.isFinite(nan.x2) && Number.isFinite(nan.y2))
})

test('resizeAnnotationToBox scales a pen point set proportionally into a brand-new array (PR3)', () => {
  const pen = {
    id: 3,
    type: 'pen',
    x: 10,
    y: 10,
    x2: 30,
    y2: 40,
    color: '#f00',
    width: 4,
    points: [{ x: 10, y: 10 }, { x: 20, y: 25 }, { x: 30, y: 40 }]
  }
  const resized = resizeAnnotationToBox(pen, { x: 10, y: 10, w: 40, h: 60 })
  assert.deepEqual(resized.points, [{ x: 10, y: 10 }, { x: 30, y: 40 }, { x: 50, y: 70 }])
  assert.notEqual(resized.points, pen.points)
  assert.deepEqual([resized.x, resized.y, resized.x2, resized.y2], [10, 10, 50, 70])
  assert.equal(resized.id, 3, 'the stable id rides along so the selection survives the resize')
  assert.deepEqual(pen.points, [{ x: 10, y: 10 }, { x: 20, y: 25 }, { x: 30, y: 40 }])

  // 退化（单点）pen：两维都为 0 时按中点映射，不产生 NaN/Infinity。
  const dot = { type: 'pen', x: 5, y: 5, color: '#f00', width: 4, points: [{ x: 5, y: 5 }] }
  const scaledDot = resizeAnnotationToBox(dot, { x: 0, y: 0, w: 10, h: 10 })
  assert.deepEqual(scaledDot.points, [{ x: 5, y: 5 }])
  assert.deepEqual([scaledDot.x, scaledDot.y], [5, 5])
})

test('resizeAnnotationToBox only moves text and re-picks its font size, never stretching the glyph box (PR3)', () => {
  const text = { type: 'text', x: 10, y: 10, text: 'abc', color: '#f00', width: 4 }
  const source = annotationBounds(text)
  // 2× 放大：字号按 width 预设从 4 跳到 8（drawAnnotation 的字号由 width 推出）。
  const bigger = resizeAnnotationToBox(text, { x: 10, y: 10, w: source.w * 2, h: source.h * 2 })
  assert.equal(bigger.width, 8)
  assert.equal(textFontSize(bigger.width), textFontSize(4) * 2)
  assert.deepEqual([bigger.x, bigger.y], [10, 10])
  assert.equal('x2' in bigger, false, 'text must not grow an x2 — that would look like a stretched glyph box')
  assert.equal(bigger.text, 'abc')

  // 只拖动（盒子尺寸不变）不改字号：不制造无效编辑步。
  const dragged = resizeAnnotationToBox(text, { x: 40, y: 50, w: source.w, h: source.h })
  assert.equal(dragged.width, 4)
  assert.deepEqual([dragged.x, dragged.y], [40, 50])

  // 缩小到下限：字号回到最小预设，仍然不写 x2/y2、不产生负尺寸。
  const smaller = resizeAnnotationToBox(text, { x: 5, y: 5, w: 3, h: 3 })
  assert.ok([2, 4, 8].includes(smaller.width))
  assert.equal('x2' in smaller, false)
})

test('resizeAnnotationToBox only changes a serial radius and keeps its number (PR3)', () => {
  const serial = { type: 'serial', x: 100, y: 100, number: 3, color: '#f00', width: 4 }
  const resized = resizeAnnotationToBox(serial, { x: 0, y: 0, w: 48, h: 48 })
  assert.equal(resized.number, 3, 'serials are never renumbered')
  assert.equal(resized.width, 8)
  // 2×radius 的圆心方框：新 box 48×48 恰好等于新半径（24）的方框。
  assert.deepEqual(annotationBounds(resized), { x: 0, y: 0, w: 48, h: 48 })
  assert.ok(serialRadius(resized.width) > serialRadius(serial.width))
  assert.deepEqual([serial.x, serial.width], [100, 4])

  // 圆心跟着新 box 的中心走；半径只能落在 width 预设上（drawAnnotation 由 width 推半径）。
  const moved = resizeAnnotationToBox(serial, { x: 10, y: 20, w: 48, h: 48 })
  assert.deepEqual([moved.x, moved.y], [34, 44])
  assert.equal(moved.number, 3)
})

test('resizeAnnotationToBox always returns a fresh copy, even when the box equals the current bounds (PR3)', () => {
  const rect = { type: 'rect', x: 10, y: 10, x2: 60, y2: 40, color: '#f00', width: 4 }
  const same = resizeAnnotationToBox(rect, annotationBounds(rect))
  assert.notEqual(same, rect)
  assert.deepEqual(same, rect)
  const pen = { type: 'pen', x: 0, y: 0, x2: 10, y2: 10, color: '#f00', width: 4, points: [{ x: 0, y: 0 }, { x: 10, y: 10 }] }
  const penSame = resizeAnnotationToBox(pen, annotationBounds(pen))
  assert.deepEqual(penSame, pen)
  assert.notEqual(penSame.points, pen.points)
})

// ---------- PR4 纯函数：reorderAnnotation（方案 §8.4「测试」行第 11 条：边界 no-op） ----------
// 第 11 条 =「reorderAnnotation 边界 no-op」：下面第 2 个用例是它的主体；第 1 个覆盖"上移/下移
// 一层 + 永远返回新数组 + 只搬引用"，第 3 个覆盖"越界/非法入参一律不抛错"。

test('reorderAnnotation moves an item exactly one layer up or down and returns a fresh array (PR4)', () => {
  const bottom = { id: 1, type: 'rect', color: '#f00', width: 4 }
  const middle = { id: 2, type: 'rect', color: '#0f0', width: 4 }
  const top = { id: 3, type: 'rect', color: '#00f', width: 4 }
  const annotations = [bottom, middle, top]

  // direction > 0 = 上移一层（朝数组末尾 = 更靠前）；< 0 = 下移一层。
  const up = reorderAnnotation(annotations, middle, 1)
  assert.deepEqual(up, [bottom, top, middle])
  assert.notEqual(up, annotations, '必须返回新数组，调用方直接替换 annotations')
  // 只搬引用、不复制元素：同一个对象还是同一个对象（快照与选中都按引用/id 解析）。
  assert.equal(up[2], middle)
  assert.equal(up[0], bottom)
  assert.equal(up[1], top)
  assert.deepEqual(annotations, [bottom, middle, top], '源数组的顺序原地不动')

  const down = reorderAnnotation(annotations, middle, -1)
  assert.deepEqual(down, [middle, bottom, top])

  // target 也接受下标：与传引用等价。
  assert.deepEqual(reorderAnnotation(annotations, 0, 1), [middle, bottom, top])
  assert.deepEqual(reorderAnnotation(annotations, 2, -1), [bottom, top, middle])

  // 只移一层：|direction| > 1 也不会跨过多个邻居（更不会越界）。
  assert.deepEqual(reorderAnnotation(annotations, middle, 5), [bottom, top, middle])
  assert.deepEqual(reorderAnnotation(annotations, middle, -9), [middle, bottom, top])

  // 返回的新数组可以随意改写，源数组不受影响。
  up.length = 1
  assert.equal(annotations.length, 3)
})

test('reorderAnnotation is a boundary no-op: already top/bottom, out of range, missing target, no direction (PR4)', () => {
  const a = { id: 1 }
  const b = { id: 2 }
  const c = { id: 3 }
  const annotations = [a, b, c]

  // 已在最上层再上移 / 已在最下层再下移：原顺序的**等价浅拷贝**（新数组、内容不变、不抛错）。
  for (const [target, direction] of [[c, 1], [a, -1]]) {
    const result = reorderAnnotation(annotations, target, direction)
    assert.notEqual(result, annotations)
    assert.deepEqual(result, [a, b, c])
  }

  // 下标越界 / 非法下标 / target 不在数组里：一律 no-op（绝不抛错）。
  for (const target of [3, 99, -1, Number.NaN, Number.POSITIVE_INFINITY, { id: 9 }, 'nope', null, undefined]) {
    assert.deepEqual(reorderAnnotation(annotations, target, 1), [a, b, c], `target ${String(target)}`)
    assert.deepEqual(reorderAnnotation(annotations, target, -1), [a, b, c], `target ${String(target)}`)
  }

  // 方向缺失 / 为 0 / 非法：no-op。
  for (const direction of [0, -0, undefined, null, Number.NaN, 'up', {}]) {
    assert.deepEqual(reorderAnnotation(annotations, b, direction), [a, b, c], `direction ${String(direction)}`)
  }

  // 空数组 / 单元素数组 / 非数组入参：返回空数组或等价浅拷贝，绝不抛错。
  assert.deepEqual(reorderAnnotation([], a, 1), [])
  assert.deepEqual(reorderAnnotation([a], a, 1), [a], '单元素数组无从移动')
  assert.deepEqual(reorderAnnotation(null, a, 1), [])
  assert.deepEqual(reorderAnnotation(undefined, a, 1), [])
  assert.deepEqual(reorderAnnotation('nope', a, 1), [])
})

test('reorderAnnotation never throws for out-of-range indices and never touches the originals (PR4)', () => {
  const items = [{ id: 1 }, { id: 2 }]
  assert.doesNotThrow(() => reorderAnnotation(items, 1, 1))
  assert.doesNotThrow(() => reorderAnnotation(items, 0, -1))
  assert.doesNotThrow(() => reorderAnnotation(items, 2, 1))
  assert.doesNotThrow(() => reorderAnnotation(items, -7, -1))
  assert.doesNotThrow(() => reorderAnnotation(items, 1.7, 1))
  // 越界不改变内容，也不修改原对象（"绝不就地改原对象"是 PR1–PR4 的一致契约）。
  assert.deepEqual(reorderAnnotation(items, 5, 1), [{ id: 1 }, { id: 2 }])
  assert.deepEqual(reorderAnnotation(items, 1.7, 1), [{ id: 1 }, { id: 2 }])
  assert.deepEqual(items, [{ id: 1 }, { id: 2 }])
})

// ---------- PR1 接线契约 ----------

test('capture.js gives every committed annotation a monotonic id and undoes through a snapshot stack', () => {
  assert.match(script, /let annotationHistory = \[\[\]\]/)
  assert.match(script, /let historyIndex = 0/)
  assert.match(script, /let annotationSeq = 0/)
  assert.match(script, /function snapshotAnnotations\(\) \{[\s\S]{0,400}?annotationHistory\.push\(cloneAnnotations\(annotations\)\)/)
  assert.match(script, /annotationHistory\.length > MAX_ANNOTATION_HISTORY[\s\S]{0,140}?annotationHistory\.splice\(0,/)
  assert.match(script, /function commitAnnotation\(item\) \{\s*if \(!item\) return\s*item\.id = \+\+annotationSeq/)
  assert.match(script, /function undoAnnotations\(\) \{[\s\S]{0,420}?flushCoalescedEdits\(\)[\s\S]{0,160}?restoreAnnotations\(historyIndex - 1\)/)
  assert.match(script, /function redoAnnotations\(\) \{[\s\S]{0,420}?flushCoalescedEdits\(\)[\s\S]{0,160}?restoreAnnotations\(historyIndex \+ 1\)/)
  assert.match(script, /document\.getElementById\('undo'\)\.onclick=\(\)=>undoAnnotations\(\)/)
  assert.match(script, /document\.getElementById\('redo'\)\.onclick=\(\)=>redoAnnotations\(\)/)
  // 契约（方案 §8.4）：Delete 不再 pop 末尾；redoStack 随快照栈一起消失
  assert.doesNotMatch(script, /annotations\.pop\(\)/)
  assert.doesNotMatch(script, /redoStack/)
  assert.match(script, /function deleteSelectedAnnotation\(\) \{[\s\S]{0,320}?annotations\.splice\(annotations\.indexOf\(item\), 1\)/)
  assert.match(script, /if\(event\.key==='Delete'\)\{event\.preventDefault\(\);deleteSelectedAnnotation\(\)\}/)
})

test('pointerdown keeps the handles first and selects the topmost annotation before moving the selection', () => {
  assert.match(pointerdownSource, /if \(resizeHandle\) \{ resizing=\{handle:resizeHandle,initial:\{\.\.\.selection\}\}/)
  assert.match(pointerdownSource, /const hit=findAnnotationAt\(annotations,point\)/)
  assert.match(pointerdownSource, /if\(hit\)\{setSelectedAnnotation\(hit\);updateSelectionCursor\(point\);return\}/)
  // A5（D10）后 pointerdown 里有两处命中测试：选区外那一处在前（元素被拖出选区仍可选），
  // 选区内的既有优先级不动 —— 所以下面的顺序断言一律对准**选区内**那一处。
  const inRegionHit = 'const hit=findAnnotationAt(annotations,point)'
  assert.match(pointerdownSource, /const outsideHit=findAnnotationAt\(annotations,point\)/)
  const outsideHitIndex = pointerdownSource.indexOf('const outsideHit=findAnnotationAt(annotations,point)')
  const inRegionHitIndex = pointerdownSource.indexOf(inRegionHit)
  assert.ok(outsideHitIndex >= 0 && outsideHitIndex < inRegionHitIndex, 'the out-of-region hit test runs before the in-region one')
  assert.ok(
    pointerdownSource.indexOf('if (resizeHandle)') < inRegionHitIndex,
    'the selection handle keeps priority over an element hit'
  )
  assert.ok(
    pointerdownSource.indexOf('!resizeHandle&&!insideSelection(point)') < outsideHitIndex,
    'the out-of-region hit test is gated on "no selection handle" (the handle keeps priority)'
  )
  assert.ok(
    pointerdownSource.indexOf(inRegionHit) < pointerdownSource.lastIndexOf('dragging=true'),
    'the element hit precedes moving/replacing the selection'
  )
  // PR2：Alt 逃生门在那之前就把指针引到选区拖动路径，所以这里取最后一个 dragging=true
  // （= 非 Alt 的回退分支），顺序断言的原意（命中优先于回退拖选区）保持不变。
  assert.ok(
    pointerdownSource.indexOf('if(event.altKey)') < inRegionHitIndex,
    'Alt+drag bypasses the element hit test and falls through to moving the selection'
  )
  // setTool 清选中（方案 §8.4）
  assert.match(script, /function setTool\(tool\) \{[\s\S]{0,200}?setSelectedAnnotation\(null\)[\s\S]{0,60}?currentTool=tool/)
  // Esc 取消选中先于关窗；删除走选中项
  assert.match(script, /else if\(selectedAnnotationItem\(\)\)setSelectedAnnotation\(null\);else closeCaptureWindow\(\)/)
})

test('D4: replacing the selection confirms first and keeps both untouched when cancelled', () => {
  assert.match(script, /function confirmDiscardAnnotations\(\) \{\s*if \(!annotations\.length\) return true\s*return confirm\(t\('capture\.confirm\.reset-selection'\)\)/)
  assert.match(pointerdownSource, /if\(!confirmDiscardAnnotations\(\)\)return/)
  assert.match(pointermoveSource, /if\(!confirmDiscardAnnotations\(\)\)\{pointerDownPoint=null;return\}/)
  assert.ok(
    pointerdownSource.indexOf('if(!confirmDiscardAnnotations())return') < pointerdownSource.indexOf('selection={x:point.x,y:point.y,w:0,h:0}'),
    'the confirmation runs before the selection is replaced'
  )
  assert.ok(
    pointermoveSource.indexOf('if(!confirmDiscardAnnotations())') < pointermoveSource.indexOf('selection=normalizeRect(startPoint,point)'),
    'the auto-select fallback also asks before it replaces the selection'
  )
  // 模态框吃掉了那次 pointerup 时，拖拽态必须能自己收尾，否则选区会跟着没按键的鼠标跑。
  assert.match(pointermoveSource, /if \(\(selecting\|\|dragging\|\|resizing\)&&event\.buttons===0\) \{/)
})

test('the element bar is a separate floating surface wired to delete/deselect, with a dashed selected outline', () => {
  assert.match(html, /id="elementBar" class="element-bar hidden"/)
  assert.ok(html.indexOf('id="toolbar"') < html.indexOf('id="elementBar"'), 'the bar is not another button on the tool strip')
  assert.ok(html.indexOf('id="elementBar"') < html.indexOf('id="watermarkPanel"'), 'the bar sits right after the tool strip')
  // PR4：层级 ↑↓ 两个按钮插在删除与取消选中之间（工具栏不塞按钮，见方案 §8 风险⑦）。
  assert.match(html, /id="elementDelete"[\s\S]{0,200}?id="elementFront"[\s\S]{0,200}?id="elementBack"[\s\S]{0,200}?id="elementDeselect"/)
  // 模块加载顺序：style → selection → geometry → capture
  assert.match(html, /annotation-style\.js[\s\S]{0,200}?selection-utils\.js[\s\S]{0,200}?annotation-geometry\.js[\s\S]{0,200}?capture\.js/)
  assert.match(
    script,
    /const \{[\s\S]{0,200}?annotationBounds,\s*findAnnotationAt,\s*translateAnnotation,\s*clampAnnotationToStage,\s*cloneAnnotations,\s*MAX_ANNOTATION_HISTORY,\s*MAX_PEN_POINTS\s*\} = window\.annotationGeometry/
  )
  assert.match(script, /document\.getElementById\('elementDelete'\)\.onclick=\(\)=>deleteSelectedAnnotation\(\)/)
  assert.match(script, /document\.getElementById\('elementDeselect'\)\.onclick=\(\)=>setSelectedAnnotation\(null\)/)
  // 选中虚线框插在标注绘制之后、手柄之前
  assert.match(script, /annotations\.forEach\(\(item\) => drawAnnotation\(ctx,item\)\)[\s\S]{0,140}?drawSelectedOutline\(\)[\s\S]{0,60}?drawHandles\(\)/)
  assert.match(script, /function drawSelectedOutline\(\) \{[\s\S]{0,420}?ctx\.setLineDash\(\[5, 4\]\)/)
  // 浮动条只在有选中项且没有交互中/自动选区/OCR 覆盖时出现
  assert.match(script, /function updateElementBar\(\) \{[\s\S]{0,240}?const visible = !!item && !!selection && !activeOcrResult/)
  assert.match(script, /function updateFloatingUi\(\) \{\s*updateElementBar\(\)/)

  assert.match(css, /\.element-bar \{[\s\S]{0,240}?position: fixed/)
  assert.match(css, /\.element-bar button\.danger \{[^}]*var\(--danger\)/)
})

// ---------- PR2 接线契约（拖动 / 边界 clamp / 方向键微调 / Alt+拖动 移动选区） ----------

test('PR2: pointerdown starts an element-body move inside the selected bounds, before the element hit test', () => {
  // 优先级（方案 §8.4）：选区手柄 → [PR3 选中元素手柄插槽] → 元素体内 → 元素命中 → 拖选区。
  // A5（D10）新增的选区外命中测试在前，所以这些断言都对准选区内那一处 `const hit=...`。
  const altIndex = pointerdownSource.indexOf('if(event.altKey)')
  const bodyIndex = pointerdownSource.indexOf('pointInAnnotationBounds(selected,point)')
  const hitIndex = pointerdownSource.indexOf('const hit=findAnnotationAt(annotations,point)')
  assert.ok(altIndex >= 0 && altIndex < hitIndex, 'Alt+drag bypasses the element hit test')
  assert.ok(bodyIndex >= 0 && bodyIndex < hitIndex, 'the element-body move precedes the element hit test')
  assert.ok(
    pointerdownSource.indexOf('const outsideHit=findAnnotationAt(annotations,point)') < bodyIndex,
    'the out-of-region hit test (A5) precedes the in-region body move, which it cannot shadow'
  )
  assert.match(pointerdownSource, /const selected=selectedAnnotationItem\(\)/)
  assert.ok(
    pointerdownSource.indexOf('if (resizeHandle)') < bodyIndex,
    'the selection handle keeps priority over the element-body move'
  )
  assert.match(script, /function pointInAnnotationBounds\(item, point\) \{[\s\S]{0,260}?point\.x >= bounds\.x && point\.x <= bounds\.x \+ bounds\.w/)
})

test('PR2: a drag produces exactly one snapshot on pointerup, only when it actually moved', () => {
  assert.match(script, /function moveAnnotationTo\(point\) \{[\s\S]{0,520}?translateAnnotation\(state\.origin, point\.x - state\.start\.x, point\.y - state\.start\.y\)/)
  assert.match(script, /function moveAnnotationTo\(point\) \{[\s\S]{0,700}?clampAnnotationToStage\(/)
  assert.match(script, /function finishMoveAnnotation\(\) \{[\s\S]{0,340}?if \(current && annotationWasMoved\(current, state\.origin\)\) \{ flushCoalescedEdits\(\); snapshotAnnotations\(\) \}/)
  assert.match(script, /function cancelMoveAnnotation\(\) \{[\s\S]{0,460}?annotations\[index\] = state\.origin/)
  // pointerup 只有一处收口、pointermove 只有一处位移；其余地方不碰 pendingMove
  assert.match(pointerupSource, /if\(pendingMove\)\{finishMoveAnnotation\(\);updateSelectionCursor\(pointFromEvent\(event\)\);return\}/)
  // 新一次按下先把上一次没收到 pointerup 的拖动收口，避免两个手势叠在一起
  assert.match(pointerdownSource, /if\(pendingMove\)finishMoveAnnotation\(\)/)
  assert.match(pointermoveSource, /if \(pendingMove\) \{ moveAnnotationTo\(point\); return \}/)
  assert.match(pointermoveSource, /if \(pendingMove&&event\.buttons===0\) \{ finishMoveAnnotation\(\); updateSelectionCursor\(point\); return \}/)
  // A1（D2）：拖动交互态只有一个创建点（beginPendingMove），而它被左键体内/右键快选/选区外命中三处复用。
  assert.equal(script.match(/pendingMove = \{/g).length, 1, 'only one arm creates the move state')
  assert.match(script, /function beginPendingMove\(item, point, event\) \{[\s\S]{0,220}?pendingMove = \{ id: item\.id, origin: item, start: \{ x: point\.x, y: point\.y \}, thresholdPassed: false \}/)
})

test('PR2: arrow keys nudge 1px (Shift 10px) and merge into a single undo frame', () => {
  assert.match(script, /const NUDGE_STEP = 1/)
  assert.match(script, /const NUDGE_STEP_FAST = 10/)
  assert.match(script, /const NUDGE_COMMIT_DELAY = 500/)
  assert.match(script, /const NUDGE_DIRECTIONS = \{ ArrowLeft: \[-1, 0\], ArrowRight: \[1, 0\], ArrowUp: \[0, -1\], ArrowDown: \[0, 1\] \}/)
  assert.match(script, /const step = event\.shiftKey \? NUDGE_STEP_FAST : NUDGE_STEP/)
  assert.match(script, /if \(event\.ctrlKey \|\| event\.altKey \|\| event\.metaKey\) return false/)
  assert.match(script, /nudgeTimer = setTimeout\(commitNudge, NUDGE_COMMIT_DELAY\)/)
  assert.match(script, /function commitNudge\(\) \{[\s\S]{0,220}?snapshotAnnotations\(\)/)
  // OCR 评审修复：snapshotAnnotations 不再吞掉待收口的微调/样式帧 —— 那会把两次用户操作
  // 合并进同一个撤销步（Ctrl+Z 一次退两步）。合并型编辑改由 flushCoalescedEdits() 各自独立成帧。
  assert.match(script, /function snapshotAnnotations\(\) \{[\s\S]{0,220}?annotationHistory\.push\(cloneAnnotations\(annotations\)\)/)
  assert.doesNotMatch(script, /function snapshotAnnotations\(\) \{[\s\S]{0,220}?cancelNudge\(\)/)
  assert.doesNotMatch(script, /function snapshotAnnotations\(\) \{[\s\S]{0,220}?cancelStyleCommit\(\)/)
  assert.match(script, /function flushCoalescedEdits\(\) \{[\s\S]{0,160}?if \(nudgeDirty\) commitNudge\(\)[\s\S]{0,80}?if \(styleDirty\) commitStyle\(\)/)
  assert.match(script, /if\(nudgeSelectedAnnotation\(event\)\)return/)
  // 方向键不得吞掉既有快捷键：Ctrl+A/Z/Y/S、Delete、Enter、Esc 全部照旧
  assert.match(script, /if\(event\.key==='Escape'\)/)
  assert.match(script, /if\(event\.ctrlKey&&event\.key\.toLowerCase\(\)==='s'\)\{event\.preventDefault\(\);performAction\('save'\)\}/)
  assert.match(script, /if\(event\.ctrlKey&&event\.key\.toLowerCase\(\)==='z'\)\{event\.preventDefault\(\);document\.getElementById\('undo'\)\.click\(\)\}/)
  assert.match(script, /if\(event\.key==='Delete'\)\{event\.preventDefault\(\);deleteSelectedAnnotation\(\)\}/)
})

test('PR2: Alt+drag on the selection bar hint moves the selection and never the element', () => {
  // 落点：select 分支最前面的 if(event.altKey)，落到既有 dragging=true 选区拖动路径。
  assert.match(pointerdownSource, /if\(event\.altKey\)\{setSelectedAnnotation\(null\);dragging=true;return\}/)
  // #elementBar 上有一行提示文案，且仍然是纯文本、不占工具栏图标清单。
  assert.match(html, /id="elementBar"[\s\S]{0,320}?data-i18n="capture\.element\.move-hint"/)
  const elementBar = html.slice(html.indexOf('<div id="elementBar"'), html.indexOf('id="watermarkPanel"'))
  assert.doesNotMatch(elementBar, /--icon:url\(/)
  assert.match(css, /\.element-bar \.element-hint \{ color: #8a8a92; \}/)
  // 拖动/微调一律走屏幕 CSS 坐标：不出现导出换算的 scaleX/scaleY。
  assert.doesNotMatch(pointermoveSource, /scaleX|scaleY/)
})

// ---------- PR3 接线契约（8 手柄缩放 / 镜像不崩 / 最小 3px / 与 PR2 同一 editDirty 口径） ----------

const resizeToSource = sliceBetween(script, 'function resizeAnnotationTo(point)', 'function annotationWasResized(')
const resizeHandlesSource = sliceBetween(script, 'function drawSelectedHandles(bounds)', 'function updateElementBar')

test('PR3: pointerdown tries the selected-element handles after the selection handle and before the element body', () => {
  // 纯函数进 capture.js 的接线：插在解构清单里，且不打乱既有条目的相对顺序。
  assert.match(script, /resizeAnnotationToBox,\s*annotationBounds,\s*findAnnotationAt,\s*translateAnnotation,/)
  assert.match(script, /const ELEMENT_HANDLE_HIT = 6/)
  assert.match(script, /const SELECTED_OUTLINE_PAD = 5/)
  assert.match(script, /function selectedResizeHandle\(point\) \{[\s\S]{0,340}?getResizeHandle\(bounds, point, ELEMENT_HANDLE_HIT\)/)
  // 零尺寸元素（单点 pen / 退化线）不给手柄：与 getResizeHandle() 的 no-op 条件一致。
  assert.match(script, /function selectedResizeHandle\(point\) \{[\s\S]{0,260}?bounds\.w <= 0 \|\| bounds\.h <= 0\) return ''/)

  const handleIndex = pointerdownSource.indexOf('selectedResizeHandle(point)')
  const bodyIndex = pointerdownSource.indexOf('pointInAnnotationBounds(selected,point)')
  // A5（D10）的选区外命中测试在最前面，这里对准选区内那一处。
  const hitIndex = pointerdownSource.indexOf('const hit=findAnnotationAt(annotations,point)')
  const selectionHandleIndex = pointerdownSource.indexOf('if (resizeHandle)')
  const altIndex = pointerdownSource.indexOf('if(event.altKey)')
  assert.ok(selectionHandleIndex >= 0 && selectionHandleIndex < handleIndex, 'the selection handle keeps priority (选区手柄 > 选中元素手柄)')
  assert.ok(handleIndex >= 0 && handleIndex < bodyIndex, 'an element handle precedes the element-body move (选中元素手柄 > 元素体内)')
  assert.ok(bodyIndex < hitIndex, 'and the body move still precedes the element hit test')
  assert.ok(altIndex >= 0 && altIndex < handleIndex, 'Alt+drag stays the escape hatch in front of every element branch')
  // Alt 逃生门本身没有被改动。
  assert.match(pointerdownSource, /if\(event\.altKey\)\{setSelectedAnnotation\(null\);dragging=true;return\}/)
  // 缩放态的形状：origin 是未被改动的原对象，originBounds 是它的屏幕 CSS 坐标 bbox。
  assert.match(
    pointerdownSource,
    /const elementHandle=selectedResizeHandle\(point\)\s*if\(elementHandle\)\{const target=selectedAnnotationItem\(\);resizingAnnotation=\{id:target\.id,origin:target,originBounds:annotationBounds\(target\),handle:elementHandle\}/
  )
  assert.equal(pointerdownSource.match(/resizingAnnotation=\{/g).length, 1, 'only the pointerdown arm creates the resize state')
  assert.match(pointerdownSource, /if\(resizingAnnotation\)finishResizeAnnotation\(\)/)
})

test('PR3: the resize gesture recomputes the box from the untouched origin, with the stage as bounds', () => {
  // bounds 传**舞台**而不是选区（方案 §8.4 PR3）；每帧都从 origin 重算，绝不就地改原对象。
  assert.match(resizeToSource, /resizeSelection\(state\.originBounds, state\.handle, point, \{ width: innerWidth, height: innerHeight \}\)/)
  assert.match(resizeToSource, /const resized = resizeAnnotationToBox\(state\.origin, box\)/)
  assert.match(resizeToSource, /annotations\[index\] = resized/)
  assert.doesNotMatch(resizeToSource, /scaleX|scaleY/, 'the resize path never touches the export coordinate conversion')
  assert.doesNotMatch(pointermoveSource, /scaleX|scaleY/)

  // pointermove：紧跟元素拖动分支之后；没有按键的 move 也能自愈收口。
  assert.match(pointermoveSource, /if \(pendingMove\) \{ moveAnnotationTo\(point\); return \}[\s\S]{0,200}?if \(resizingAnnotation\) \{ resizeAnnotationTo\(point\); updateSelectionCursor\(point\); return \}/)
  assert.match(pointermoveSource, /if \(resizingAnnotation&&event\.buttons===0\) \{ finishResizeAnnotation\(\); updateSelectionCursor\(point\); return \}/)
  // pointerup / pointercancel：与 PR2 同一套收口口径（有变化才 snapshot；cancel 回滚原对象）。
  assert.match(pointerupSource, /if\(resizingAnnotation\)\{finishResizeAnnotation\(\);updateSelectionCursor\(pointFromEvent\(event\)\);return\}/)
  assert.match(script, /canvas\.addEventListener\('pointercancel',\(\)=>\{[\s\S]{0,200}?cancelResizeAnnotation\(\)/)
  assert.match(script, /function annotationWasResized\(item, origin\) \{\s*return JSON\.stringify\(item\) !== JSON\.stringify\(origin\)/)
  assert.match(script, /function finishResizeAnnotation\(\) \{[\s\S]{0,360}?if \(current && annotationWasResized\(current, state\.origin\)\) \{ flushCoalescedEdits\(\); snapshotAnnotations\(\) \}/)
  assert.match(script, /function cancelResizeAnnotation\(\) \{[\s\S]{0,480}?annotations\[index\] = state\.origin/)
  assert.equal(script.match(/snapshotAnnotations\(\)/g).length >= 5, true)
  // 新一次按下 / 重置时都不会把上一次的缩放态留着。
  assert.match(script, /function resetAnnotationState\(\) \{[\s\S]{0,220}?resizingAnnotation = null/)
  // 交互中浮动条隐藏（和拖动一致），否则它会跟着缩放的元素乱跳。
  assert.match(script, /const visible = !!item && !!selection && !activeOcrResult[\s\S]{0,200}?!resizingAnnotation/)
  // 光标反馈优先级与 pointerdown 一致。
  assert.match(script, /const handle = resizing\?\.handle \|\| getResizeHandle\(selection, point\) \|\| resizingAnnotation\?\.handle \|\| selectedResizeHandle\(point\)/)
})

test('PR3: eight element handles are drawn on the dashed frame in a style distinct from the selection handles', () => {
  // 手柄必须有可见落点（否则用户无从发现缩放），画在选中虚线框的 8 个位置上。
  assert.match(script, /function drawSelectedOutline\(\) \{[\s\S]{0,700}?drawSelectedHandles\(bounds\)/)
  assert.match(resizeHandlesSource, /ctx\.arc\(x, y, 3\.5, 0, Math\.PI \* 2\)/)
  assert.match(resizeHandlesSource, /if \(!bounds \|\| bounds\.w <= 0 \|\| bounds\.h <= 0\) return/)
  assert.equal(resizeHandlesSource.match(/ctx\.arc\(/g).length, 1, 'one arc inside a forEach over the eight positions')
  assert.match(resizeHandlesSource, /\[left, top\], \[midX, top\], \[right, top\], \[left, midY\], \[right, midY\], \[left, bottom\], \[midX, bottom\], \[right, bottom\]/)
  // 与选区手柄刻意区分：选区是白底橙边 8×8 方块（fillRect），元素是实心圆点（arc），不混用。
  assert.doesNotMatch(resizeHandlesSource, /fillRect/)
  assert.match(script, /function drawHandles\(\) \{[\s\S]{0,600}?ctx\.fillRect\(x-4,y-4,8,8\)/)
  // #elementBar 上多一行纯文本提示，不占工具栏图标清单。
  assert.match(html, /data-i18n="capture\.element\.resize-hint"/)
  const elementBar = html.slice(html.indexOf('<div id="elementBar"'), html.indexOf('id="watermarkPanel"'))
  assert.doesNotMatch(elementBar, /--icon:url\(/)
})

// ---------- PR4 接线契约（层级 ↑↓ / 颜色与线宽作用于选中项 / 层序进入导出） ----------

const reorderSource = sliceBetween(script, 'function reorderSelectedAnnotation(direction)', 'function resetAnnotationState()')
const styleSource = sliceBetween(script, 'function applyStyleToSelectedAnnotation(patch)', 'function resetAnnotationState()')

test('PR4: the layer buttons live on #elementBar between delete and deselect and add no toolbar icons', () => {
  assert.match(html, /id="elementDelete"[\s\S]{0,200}?id="elementFront"[\s\S]{0,200}?id="elementBack"[\s\S]{0,200}?id="elementDeselect"/)
  // 工具栏已近满宽（方案 §8 风险⑦）：层级入口只放浮动条，绝不进 .toolbar。
  assert.ok(html.indexOf('id="toolbar"') < html.indexOf('id="elementFront"'), '层级按钮在浮动条里，不在工具栏上')
  assert.ok(html.indexOf('id="elementBar"') < html.indexOf('id="elementFront"'))
  assert.ok(html.indexOf('id="elementBack"') < html.indexOf('id="watermarkPanel"'))
  const elementBar = html.slice(html.indexOf('<div id="elementBar"'), html.indexOf('id="watermarkPanel"'))
  assert.doesNotMatch(elementBar, /--icon:url\(/, 'element actions must not inflate the toolbar icon list')
  assert.match(html, /id="elementFront"[^>]*data-i18n-aria-label="capture\.element\.front-aria"/)
  assert.match(html, /id="elementBack"[^>]*data-i18n-aria-label="capture\.element\.back-aria"/)

  assert.match(script, /const elementFront = document\.getElementById\('elementFront'\)/)
  assert.match(script, /const elementBack = document\.getElementById\('elementBack'\)/)
  assert.match(script, /elementFront\.onclick=\(\)=>reorderSelectedAnnotation\(1\)/)
  assert.match(script, /elementBack\.onclick=\(\)=>reorderSelectedAnnotation\(-1\)/)
  // 禁用态统一在 updateElementBar（与删除/取消选中同一处），已在最上/最下层时置灰。
  assert.match(
    script,
    /function updateElementBar\(\) \{[\s\S]{0,700}?elementFront\.disabled = index < 0 \|\| index >= annotations\.length - 1[\s\S]{0,120}?elementBack\.disabled = index <= 0/
  )
  assert.match(css, /\.element-bar button:disabled \{/)
})

test('PR4: one reorder = exactly one snapshot, and the selection is re-resolved by id (undo/redo 不串)', () => {
  assert.match(reorderSource, /const ordered = reorderAnnotation\(annotations, annotations\.indexOf\(item\), direction\)/)
  // 边界 no-op 在压帧之前返回：不制造无效撤销步。
  assert.match(reorderSource, /if \(ordered\.every\(\(entry, position\) => entry === annotations\[position\]\)\) return/)
  assert.match(reorderSource, /annotations = ordered/)
  assert.equal(reorderSource.match(/snapshotAnnotations\(\)/g).length, 1, '一次操作恰好一帧快照')
  assert.ok(
    reorderSource.indexOf('ordered.every(') < reorderSource.indexOf('snapshotAnnotations()'),
    'the boundary no-op returns before the snapshot'
  )
  assert.match(reorderSource, /syncSelectedAnnotation\(\)/)
  assert.ok(
    reorderSource.indexOf('snapshotAnnotations()') < reorderSource.indexOf('syncSelectedAnnotation()'),
    '层序变化后按 id 重新解析选中项（快照还原会换掉对象身份）'
  )
  // 层级路径不碰导出坐标换算（方案 §8.3）。
  assert.doesNotMatch(reorderSource, /scaleX|scaleY/)
})

test('PR4: the array order is the z-order, so renderOverlay and exportSelectionCanvas iterate without sorting (层序进入导出)', () => {
  const overlaySource = sliceBetween(script, 'function renderOverlay()', 'function render()')
  const exportSource = sliceBetween(script, 'function exportSelectionCanvas(includeAnnotations = true)', 'function canvasPngBuffer(')
  // 两条绘制路径都是**顺序 forEach**：数组顺序就是 z 序（§8.1），所以改数组顺序同时改屏幕与导出层序，
  // 绘制代码一行都不用动 —— 这正是 PR4 的关键简化。
  assert.match(overlaySource, /annotations\.forEach\(\(item\) => drawAnnotation\(ctx,item\)\)/)
  assert.match(exportSource, /annotations\.forEach\(\(item\)=>drawAnnotation\(out,item,scaleX,scaleY,selection\.x,selection\.y,image\)\)/)
  assert.doesNotMatch(overlaySource, /annotations\.(sort|reverse|slice)\(/, '屏幕层序必须直接来自数组顺序')
  assert.doesNotMatch(exportSource, /annotations\.(sort|reverse)\(/, '导出层序必须直接来自数组顺序')
  // 导出坐标换算只活在 exportSelectionCanvas 内部（§8.3）；样式路径也不碰它。
  assert.match(exportSource, /const scaleX=source\.width\/selection\.w,scaleY=source\.height\/selection\.h/)
  assert.doesNotMatch(styleSource, /scaleX|scaleY/)
})

test('PR4: a style change lands on the selected item with a fresh copy, never on "the next new annotation"', () => {
  // 生成新副本 → 替换数组项（绝不就地改原对象，与 PR2/PR3 同一契约）。
  assert.match(styleSource, /const styled = Object\.assign\(\{\}, item, patch\)/)
  assert.match(styleSource, /annotations\[index\] = styled/)
  assert.match(styleSource, /selectedAnnotation = styled/)
  assert.equal(styleSource.match(/annotations\[index\] = /g).length, 1, '只有一处写回，且写的是副本')
  // 0 变化不制造无效撤销步（与 PR2 的 annotationWasMoved / PR3 的 annotationWasResized 同口径）。
  assert.match(styleSource, /if \(!keys\.length \|\| !keys\.some\(\(key\) => item\[key\] !== patch\[key\]\)\) return false/)
  assert.match(styleSource, /function applyStyleToSelectedAnnotation\(patch\) \{\s*const item = selectedAnnotationItem\(\)/)
  // 离散操作（线宽按钮）：先把待收口的合并型编辑各自成帧，再压这次样式帧 ——
  // 两次用户操作不挤进同一个撤销步（OCR 评审修复后由 flushCoalescedEdits 统一承担）。
  assert.match(styleSource, /function commitSelectedStyle\(patch\) \{[\s\S]{0,220}?flushCoalescedEdits\(\)/)
  assert.match(styleSource, /function commitSelectedStyle\(patch\) \{[\s\S]{0,280}?snapshotAnnotations\(\)/)
  // 连续操作（取色器）：input 合帧、change 立刻收口。
  assert.match(styleSource, /function stageSelectedStyle\(patch\) \{[\s\S]{0,200}?styleDirty = true[\s\S]{0,200}?styleTimer = setTimeout\(commitStyle, STYLE_COMMIT_DELAY\)/)
  assert.match(styleSource, /function cancelStyleCommit\(\) \{[\s\S]{0,160}?styleDirty = false/)
  assert.match(styleSource, /function commitStyle\(\) \{[\s\S]{0,200}?if \(!styleDirty\) return false[\s\S]{0,120}?snapshotAnnotations\(\)/)
  assert.match(script, /const STYLE_COMMIT_DELAY = 300/)

  // 落点 1：线宽 —— setAnnotationWidth() 改选中项（B4 之后同时写当前工具的记忆块）。
  assert.match(script, /function setAnnotationWidth\(width, persist = false\) \{[\s\S]{0,460}?commitSelectedStyle\(\{ width: resolved \}\)/)
  // B2-B5/B4 之后 annotationStyle() 读当前工具的记忆样式（resolveToolStyle 只产出该工具自己的字段）。
  assert.match(script, /function annotationStyle\(\) \{\s*return resolveToolStyle\(currentTool, toolStyles\[currentTool\]\)\s*\}/)
  // 落点 2：颜色 —— 预览照旧，同时作用于选中项；change 立刻把这一帧收口。
  // A3 之后 input 还同步全局默认色（回显只写 UI 镜像，不经过这两个 listener）。
  assert.match(script, /colorInput\.addEventListener\('input',\(\)=>\{colorPreview\.style\.background=colorInput\.value;annotationColor=normalizeAnnotationColor\(colorInput\.value\);stageSelectedStyle\(\{color:annotationColor\}\)\}\)/)
  assert.match(script, /colorInput\.addEventListener\('change',\(\)=>\{rememberRecentColor\(colorInput\.value\);setAnnotationColor\(colorInput\.value,true\)\}\)/)

  // 快照栈口径（OCR 评审修复后）：snapshotAnnotations 只负责压帧，不再吞掉待收口的
  // 微调/样式帧；合并型编辑由 flushCoalescedEdits() 在各自的动作路径前独立成帧。
  assert.match(script, /function snapshotAnnotations\(\) \{[\s\S]{0,220}?annotationHistory\.push\(cloneAnnotations\(annotations\)\)/)
  assert.match(script, /function restoreAnnotations\(index\) \{[\s\S]{0,160}?cancelStyleCommit\(\)/)
  // Ctrl+Z：先把未收口的颜色/微调各自压一帧，才是"精确回退一步"（不会连上一个操作一起撤掉）。
  assert.match(script, /function undoAnnotations\(\) \{[\s\S]{0,420}?flushCoalescedEdits\(\)/)
  // 新一次截图不得让上一张的样式计时器落进这一次的历史。
  assert.match(script, /function resetAnnotationState\(\) \{[\s\S]{0,300}?cancelStyleCommit\(\)/)
  // 样式补丁只补 color/width 之类的字段，id 与 serial.number 原样带过（不重编号）。
  assert.doesNotMatch(styleSource, /number\s*[:=]/)
})

// ---------- A1：点击/拖动阈值（方案 D2，纯函数） ----------

test('A1: movedBeyondThreshold is strictly greater than the threshold and never moves on broken input', () => {
  assert.equal(MOVE_THRESHOLD, 3)
  const start = { x: 100, y: 100 }
  // 阈值是"必须超过"：正好 3px 的抖动仍然算点击（不进入 move 态）。
  assert.equal(movedBeyondThreshold(start, { x: 103, y: 100 }, MOVE_THRESHOLD), false)
  assert.equal(movedBeyondThreshold(start, { x: 100, y: 103 }, MOVE_THRESHOLD), false)
  assert.equal(movedBeyondThreshold(start, { x: 104, y: 100 }, MOVE_THRESHOLD), true)
  // 对角线也按欧氏距离判定（3-4-5 三角形：位移 5 > 3）。
  assert.equal(movedBeyondThreshold(start, { x: 103, y: 104 }, MOVE_THRESHOLD), true)
  assert.equal(movedBeyondThreshold(start, { x: 103, y: 102 }, MOVE_THRESHOLD), true)
  assert.equal(movedBeyondThreshold(start, start, MOVE_THRESHOLD), false)
  // 非法输入一律 false：坏事件不得开启元素拖动。
  assert.equal(movedBeyondThreshold(null, { x: 104, y: 100 }, MOVE_THRESHOLD), false)
  assert.equal(movedBeyondThreshold(start, null, MOVE_THRESHOLD), false)
  assert.equal(movedBeyondThreshold(start, { x: 'a', y: 0 }, MOVE_THRESHOLD), false)
  assert.equal(movedBeyondThreshold({ x: 0 }, { x: 10, y: 0 }, MOVE_THRESHOLD), false)
  // 阈值缺省/非法时退化为 0（任何位移都算移动），不会变成 NaN 比较。
  assert.equal(movedBeyondThreshold(start, { x: 100.5, y: 100 }, undefined), true)
  assert.equal(movedBeyondThreshold(start, { x: 100, y: 100 }, Number.NaN), false)
  // 入参绝不被修改。
  assert.deepEqual(start, { x: 100, y: 100 })
})
