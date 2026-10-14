// B7 契约：画笔端点续画（docs/plans/2026-10-14-capture-interaction-improvement-plan.md §4 B7 / D11）。
//
// 纯函数 penContinuationTarget 用例 + capture.js 的接线契约（抬起原笔迹 → activeAnnotation
// 续写 → pointerup 一帧 → pointercancel 还原）。
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { penContinuationTarget } = require('../capture/annotation-geometry')

const root = path.join(__dirname, '..')
const script = fs.readFileSync(path.join(root, 'capture', 'capture.js'), 'utf8')

function sliceBetween(source, from, to) {
  const start = source.indexOf(from)
  const end = source.indexOf(to)
  assert.ok(start >= 0 && end > start, `could not slice ${from} .. ${to}`)
  return source.slice(start, end)
}

test('B7: a continuation target is the topmost pen within reach of either endpoint', () => {
  const lower = { id: 1, type: 'pen', x: 0, y: 0, color: '#f00', width: 4, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] }
  const rect = { id: 2, type: 'rect', x: 0, y: 0, x2: 50, y2: 50, color: '#f00', width: 4 }
  const upper = { id: 3, type: 'pen', x: 100, y: 100, color: '#f00', width: 4, points: [{ x: 100, y: 100 }, { x: 200, y: 200 }] }
  const annotations = [lower, rect, upper]
  // 末端 12px 内 → 该笔迹本身（不是副本）。
  assert.equal(penContinuationTarget(annotations, { x: 208, y: 208 }, 12), upper)
  // 起点同样可续画（两端都能抓）。
  assert.equal(penContinuationTarget(annotations, { x: 95, y: 95 }, 12), upper)
  // 只看**最后一条** pen：抓不到上层笔迹时不会退回下层（否则续画会画到别的元素上）。
  assert.equal(penContinuationTarget(annotations, { x: 5, y: 0 }, 12), null)
  // 12px 之外不是目标（严格按距离）。
  assert.equal(penContinuationTarget(annotations, { x: 214, y: 214 }, 12), null)
})

test('B7: the tolerance is widened by the stroke width so a thick pen stays grabbable', () => {
  const thick = { id: 1, type: 'pen', x: 0, y: 0, color: '#f00', width: 24, points: [{ x: 0, y: 0 }, { x: 40, y: 0 }] }
  // MAX(width, maxDistance)：24 > 12，于是 24px 外仍然算端点（严格 > 24 才落空）。
  assert.equal(penContinuationTarget([thick], { x: 64, y: 0 }, 12), thick)
  assert.equal(penContinuationTarget([thick], { x: 65, y: 0 }, 12), null)
  const thin = { ...thick, width: 2 }
  assert.equal(penContinuationTarget([thin], { x: 51, y: 0 }, 12), thin)
  assert.equal(penContinuationTarget([thin], { x: 53, y: 0 }, 12), null)
})

test('B7: degenerate input is never a target and nothing is mutated', () => {
  const dot = { id: 1, type: 'pen', x: 5, y: 5, color: '#f00', width: 4, points: [{ x: 5, y: 5 }] }
  assert.equal(penContinuationTarget([dot], { x: 8, y: 8 }, 12), dot)
  assert.equal(penContinuationTarget([dot], { x: 40, y: 40 }, 12), null)
  // 没有点集 / 没有标注 / 非法坐标 / 非法入参一律 null，绝不抛错。
  assert.equal(penContinuationTarget([{ type: 'pen', x: 1, y: 1 }], { x: 1, y: 1 }, 12), null)
  assert.equal(penContinuationTarget([], { x: 1, y: 1 }, 12), null)
  assert.equal(penContinuationTarget(null, { x: 1, y: 1 }, 12), null)
  assert.equal(penContinuationTarget([dot], null, 12), null)
  assert.equal(penContinuationTarget([dot], { x: 'a', y: 0 }, 12), null)
  assert.equal(penContinuationTarget([dot], { x: 5, y: 5 }, Number.NaN), dot, '缺省容差退化为 width')
  const snapshot = JSON.parse(JSON.stringify([dot]))
  penContinuationTarget([dot], { x: 5, y: 5 }, 12)
  assert.deepEqual([dot], snapshot, 'the pure layer never edits the annotation')
})

test('B7: the pen branch continues instead of starting a new stroke, after the region guard', () => {
  assert.match(script, /const PEN_CONTINUATION_DISTANCE = 12/)
  assert.match(
    script,
    /if \(currentTool==='pen'\) \{\s*const target=penContinuationTarget\(annotations,point,PEN_CONTINUATION_DISTANCE\)\s*if\(target&&beginPenContinuation\(target,point,event\)\)return\s*\}/
  )
  // 续画只发生在选区内（与新建同一条守卫），且在建新对象之前。
  const guardIndex = script.indexOf('if (!insideSelection(point)) return')
  const continueIndex = script.indexOf('penContinuationTarget(annotations,point,PEN_CONTINUATION_DISTANCE)')
  const createIndex = script.indexOf('activeAnnotation={type:currentTool,x:point.x,y:point.y')
  assert.ok(guardIndex >= 0 && guardIndex < continueIndex, 'the region guard still runs first')
  assert.ok(continueIndex < createIndex, 'continuation is tried before the new-stroke path')
})

test('B7: the gesture lifts the stroke, keeps its slot and ends in exactly one commit', () => {
  const beginSource = sliceBetween(script, 'function beginPenContinuation(item, point, event)', '// pointercancel: the gesture never happened')
  assert.match(beginSource, /const index = annotations\.indexOf\(item\)\s*if \(index < 0\) return false/)
  assert.match(beginSource, /const fromStart = Math\.hypot\(point\.x-first\.x, point\.y-first\.y\) <= Math\.hypot\(point\.x-last\.x, point\.y-last\.y\)/)
  assert.match(beginSource, /if \(fromStart\) points\.reverse\(\)/)
  assert.match(beginSource, /annotations\.splice\(index, 1\)/)
  assert.match(beginSource, /continuedPen = \{ item, index \}/)
  assert.match(beginSource, /points: points\.concat\(\[\{ x: point\.x, y: point\.y \}\]\)/)
  assert.match(beginSource, /try \{ canvas\.setPointerCapture\(event\.pointerId\) \} catch \{\}/)
  // 一次手势一帧：续写仍走 commitAnnotation（压帧只在它里面发生）。
  assert.equal(beginSource.match(/snapshotAnnotations\(\)/g), null)
  assert.match(script, /function commitAnnotation\(item\) \{[\s\S]{0,260}?continuedPen = null[\s\S]{0,120}?snapshotAnnotations\(\)/)
})

test('B7: pointercancel and a fresh capture put the lifted stroke back', () => {
  assert.match(script, /function restoreContinuedPen\(\) \{[\s\S]{0,420}?annotations\.splice\(Math\.max\(0, Math\.min\(index, annotations\.length\)\), 0, item\)/)
  assert.match(script, /canvas\.addEventListener\('pointercancel',\(\)=>\{[\s\S]{0,260}?restoreContinuedPen\(\)/)
  assert.match(script, /function resetAnnotationState\(\) \{[\s\S]{0,320}?continuedPen = null/)
  // 还原时按 id 去重：已经提交/重新绘制的笔迹不会被插回第二份。
  assert.match(script, /if \(annotations\.some\(\(entry\) => entry\.id === item\.id\)\) return/)
})
