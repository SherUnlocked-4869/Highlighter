const test = require('node:test')
const assert = require('node:assert/strict')
const {
  ANNOTATION_COLORS,
  ANNOTATION_WIDTHS,
  MAX_ANNOTATIONS,
  MAX_PEN_POINTS,
  createAnnotation,
  updateAnnotation,
  sanitizeAnnotationCommand,
  sanitizeAnnotationSnapshot,
  undoAnnotationSnapshot,
  clearAnnotationSnapshot,
  drawAnnotationSnapshot
} = require('../record/annotation-utils')

test('creates and updates the four supported annotation tools', () => {
  const style = { color: '#ff3b30', width: 4 }
  const pen = updateAnnotation(createAnnotation('pen', { x: 2, y: 3 }, style, 1), { x: 8, y: 9 })
  assert.deepEqual(pen.points, [{ x: 2, y: 3 }, { x: 8, y: 9 }])

  for (const type of ['rect', 'ellipse', 'arrow']) {
    const item = updateAnnotation(createAnnotation(type, { x: 20, y: 30 }, style, 2), { x: 5, y: 7 })
    assert.equal(item.type, type)
    assert.deepEqual([item.x, item.y, item.x2, item.y2], [20, 30, 5, 7])
  }
  assert.equal(createAnnotation('pointer', { x: 1, y: 1 }, style, 3), null)
  assert.equal(createAnnotation('text', { x: 1, y: 1 }, style, 3), null)
})

test('deduplicates close pen points and caps the point count', () => {
  let pen = createAnnotation('pen', { x: 1, y: 1 }, { color: '#ff3b30', width: 4 }, 1)
  pen = updateAnnotation(pen, { x: 1.2, y: 1.2 })
  assert.equal(pen.points.length, 1)
  for (let index = 0; index < MAX_PEN_POINTS + 10; index++) {
    pen = updateAnnotation(pen, { x: index + 2, y: index + 2 })
  }
  assert.equal(pen.points.length, MAX_PEN_POINTS)
})

test('sanitizes annotation commands to declared tools, colors, widths, and actions', () => {
  assert.deepEqual(ANNOTATION_WIDTHS, [2, 4, 7])
  assert.deepEqual(ANNOTATION_COLORS, ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#1687ff', '#111111', '#ffffff'])
  assert.deepEqual(sanitizeAnnotationCommand({ tool: 'arrow', color: '#1687ff', width: 7, action: 'undo', resetVersion: 3 }), {
    tool: 'arrow', color: '#1687ff', width: 7, action: 'undo', resetVersion: 3
  })
  assert.deepEqual(sanitizeAnnotationCommand({ tool: 'text', color: 'red', width: 99, action: 'delete', resetVersion: -3 }), {
    tool: 'pointer', color: '#ff3b30', width: 4, action: '', resetVersion: 0
  })
})

test('sanitizes snapshots to selection bounds and declared limits', () => {
  const annotations = Array.from({ length: MAX_ANNOTATIONS + 4 }, (_value, index) => ({
    id: index + 1,
    type: 'rect',
    color: '#ff3b30',
    width: 4,
    x: -20,
    y: 5,
    x2: 500,
    y2: 300
  }))
  const result = sanitizeAnnotationSnapshot({ annotations, active: { ...annotations[0], type: 'text' } }, { width: 200, height: 100 })
  assert.equal(result.annotations.length, MAX_ANNOTATIONS)
  assert.deepEqual([result.annotations[0].x, result.annotations[0].y, result.annotations[0].x2, result.annotations[0].y2], [0, 5, 200, 100])
  assert.equal(result.active, null)
  assert.notEqual(result.annotations[0], annotations[0])
})

test('undoes and clears committed annotations without retaining active work', () => {
  const snapshot = { annotations: [{ id: 1 }, { id: 2 }], active: { id: 3 } }
  assert.deepEqual(undoAnnotationSnapshot(snapshot), { annotations: [{ id: 1 }], active: null })
  assert.deepEqual(clearAnnotationSnapshot(snapshot), { annotations: [], active: null })
})

test('draws all annotation tools at the recording canvas scale', () => {
  const calls = []
  const context = {
    canvas: { width: 400, height: 200 },
    save: () => calls.push(['save']),
    restore: () => calls.push(['restore']),
    beginPath: () => calls.push(['beginPath']),
    moveTo: (...args) => calls.push(['moveTo', ...args]),
    lineTo: (...args) => calls.push(['lineTo', ...args]),
    stroke: () => calls.push(['stroke']),
    fill: () => calls.push(['fill']),
    closePath: () => calls.push(['closePath']),
    strokeRect: (...args) => calls.push(['strokeRect', ...args]),
    ellipse: (...args) => calls.push(['ellipse', ...args])
  }
  const style = { color: '#ff3b30', width: 4 }
  drawAnnotationSnapshot(context, {
    annotations: [
      { id: 1, type: 'pen', ...style, x: 1, y: 2, x2: 5, y2: 6, points: [{ x: 1, y: 2 }, { x: 5, y: 6 }] },
      { id: 2, type: 'rect', ...style, x: 50, y: 40, x2: 10, y2: 10 },
      { id: 3, type: 'ellipse', ...style, x: 20, y: 20, x2: 60, y2: 50 }
    ],
    active: { id: 4, type: 'arrow', ...style, x: 10, y: 10, x2: 80, y2: 60 }
  }, { width: 200, height: 100 })

  assert.ok(calls.some(([name]) => name === 'strokeRect'))
  assert.ok(calls.some(([name]) => name === 'ellipse'))
  assert.ok(calls.some(([name]) => name === 'fill'))
  assert.deepEqual(calls.find(([name]) => name === 'strokeRect').slice(1), [20, 20, 80, 60])
  assert.equal(calls.filter(([name]) => name === 'save').length, 4)
  assert.equal(calls.filter(([name]) => name === 'restore').length, 4)
})
