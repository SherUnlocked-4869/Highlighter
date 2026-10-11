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
  annotationBounds,
  hitTestAnnotation,
  findAnnotationAt,
  translateAnnotation,
  resizeAnnotationToBox,
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

// ---------- PR1 接线契约 ----------

test('capture.js gives every committed annotation a monotonic id and undoes through a snapshot stack', () => {
  assert.match(script, /let annotationHistory = \[\[\]\]/)
  assert.match(script, /let historyIndex = 0/)
  assert.match(script, /let annotationSeq = 0/)
  assert.match(script, /function snapshotAnnotations\(\) \{[\s\S]{0,400}?annotationHistory\.push\(cloneAnnotations\(annotations\)\)/)
  assert.match(script, /annotationHistory\.length > MAX_ANNOTATION_HISTORY[\s\S]{0,140}?annotationHistory\.splice\(0,/)
  assert.match(script, /function commitAnnotation\(item\) \{\s*if \(!item\) return\s*item\.id = \+\+annotationSeq/)
  assert.match(script, /function undoAnnotations\(\) \{[\s\S]{0,160}?restoreAnnotations\(historyIndex - 1\)/)
  assert.match(script, /function redoAnnotations\(\) \{[\s\S]{0,160}?restoreAnnotations\(historyIndex \+ 1\)/)
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
  assert.ok(
    pointerdownSource.indexOf('if (resizeHandle)') < pointerdownSource.indexOf('findAnnotationAt(annotations,point)'),
    'the selection handle keeps priority over an element hit'
  )
  assert.ok(
    pointerdownSource.indexOf('findAnnotationAt(annotations,point)') < pointerdownSource.lastIndexOf('dragging=true'),
    'the element hit precedes moving/replacing the selection'
  )
  // PR2：Alt 逃生门在那之前就把指针引到选区拖动路径，所以这里取最后一个 dragging=true
  // （= 非 Alt 的回退分支），顺序断言的原意（命中优先于回退拖选区）保持不变。
  assert.ok(
    pointerdownSource.indexOf('if(event.altKey)') < pointerdownSource.indexOf('findAnnotationAt(annotations,point)'),
    'Alt+drag bypasses the element hit test and falls through to moving the selection'
  )
  // setTool 清选中（方案 §8.4）
  assert.match(script, /function setTool\(tool\) \{[\s\S]{0,200}?setSelectedAnnotation\(null\)[\s\S]{0,60}?currentTool=tool/)
  // Esc 取消选中先于关窗；删除走选中项
  assert.match(script, /else if\(selectedAnnotationItem\(\)\)setSelectedAnnotation\(null\);else closeCaptureWindow\(\)/)
})

test('D4: replacing the selection confirms first and keeps both untouched when cancelled', () => {
  assert.match(script, /function confirmDiscardAnnotations\(\) \{\s*if \(!annotations\.length\) return true\s*return confirm\('重新划选将清除已添加的标注，是否继续？'\)/)
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
  assert.match(html, /id="elementDelete"[\s\S]{0,160}?id="elementDeselect"/)
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
  const altIndex = pointerdownSource.indexOf('if(event.altKey)')
  const bodyIndex = pointerdownSource.indexOf('pointInAnnotationBounds(selected,point)')
  const hitIndex = pointerdownSource.indexOf('findAnnotationAt(annotations,point)')
  assert.ok(altIndex >= 0 && altIndex < hitIndex, 'Alt+drag bypasses the element hit test')
  assert.ok(bodyIndex >= 0 && bodyIndex < hitIndex, 'the element-body move precedes the element hit test')
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
  assert.match(script, /function finishMoveAnnotation\(\) \{[\s\S]{0,320}?if \(current && annotationWasMoved\(current, state\.origin\)\) snapshotAnnotations\(\)/)
  assert.match(script, /function cancelMoveAnnotation\(\) \{[\s\S]{0,460}?annotations\[index\] = state\.origin/)
  // pointerup 只有一处收口、pointermove 只有一处位移；其余地方不碰 movingAnnotation
  assert.match(pointerupSource, /if\(movingAnnotation\)\{finishMoveAnnotation\(\);updateSelectionCursor\(pointFromEvent\(event\)\);return\}/)
  // 新一次按下先把上一次没收到 pointerup 的拖动收口，避免两个手势叠在一起
  assert.match(pointerdownSource, /if\(movingAnnotation\)finishMoveAnnotation\(\)/)
  assert.match(pointermoveSource, /if \(movingAnnotation\) \{ moveAnnotationTo\(point\); return \}/)
  assert.match(pointermoveSource, /if \(movingAnnotation&&event\.buttons===0\) \{ finishMoveAnnotation\(\); updateSelectionCursor\(point\); return \}/)
  assert.equal(pointerdownSource.match(/movingAnnotation=\{/g).length, 1, 'only the pointerdown arm creates the move state')
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
  assert.match(script, /function snapshotAnnotations\(\) \{[\s\S]{0,120}?cancelNudge\(\)[\s\S]{0,120}?annotationHistory\.push\(cloneAnnotations\(annotations\)\)/)
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
  assert.match(html, /id="elementBar"[\s\S]{0,320}?Alt\+拖动 移动选区/)
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
  const hitIndex = pointerdownSource.indexOf('findAnnotationAt(annotations,point)')
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
  assert.match(pointermoveSource, /if \(movingAnnotation\) \{ moveAnnotationTo\(point\); return \}[\s\S]{0,200}?if \(resizingAnnotation\) \{ resizeAnnotationTo\(point\); updateSelectionCursor\(point\); return \}/)
  assert.match(pointermoveSource, /if \(resizingAnnotation&&event\.buttons===0\) \{ finishResizeAnnotation\(\); updateSelectionCursor\(point\); return \}/)
  // pointerup / pointercancel：与 PR2 同一套收口口径（有变化才 snapshot；cancel 回滚原对象）。
  assert.match(pointerupSource, /if\(resizingAnnotation\)\{finishResizeAnnotation\(\);updateSelectionCursor\(pointFromEvent\(event\)\);return\}/)
  assert.match(script, /canvas\.addEventListener\('pointercancel',\(\)=>\{[\s\S]{0,200}?cancelResizeAnnotation\(\)/)
  assert.match(script, /function annotationWasResized\(item, origin\) \{\s*return JSON\.stringify\(item\) !== JSON\.stringify\(origin\)/)
  assert.match(script, /function finishResizeAnnotation\(\) \{[\s\S]{0,340}?if \(current && annotationWasResized\(current, state\.origin\)\) snapshotAnnotations\(\)/)
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
  assert.match(html, /拖动圆点缩放/)
  const elementBar = html.slice(html.indexOf('<div id="elementBar"'), html.indexOf('id="watermarkPanel"'))
  assert.doesNotMatch(elementBar, /--icon:url\(/)
})
