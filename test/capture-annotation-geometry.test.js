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
  annotationBounds,
  hitTestAnnotation,
  findAnnotationAt,
  translateAnnotation,
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
    pointerdownSource.indexOf('findAnnotationAt(annotations,point)') < pointerdownSource.indexOf('dragging=true'),
    'the element hit precedes moving/replacing the selection'
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
    /const \{[\s\S]{0,160}?annotationBounds,\s*findAnnotationAt,\s*cloneAnnotations,\s*MAX_ANNOTATION_HISTORY,\s*MAX_PEN_POINTS\s*\} = window\.annotationGeometry/
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
