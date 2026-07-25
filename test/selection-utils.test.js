const test = require('node:test')
const assert = require('node:assert/strict')
const {
  getResizeHandle,
  resizeSelection,
  selectionCursor
} = require('../capture/selection-utils')

const selection = { x: 100, y: 80, w: 240, h: 160 }

test('detects all corner and edge resize handles', () => {
  assert.equal(getResizeHandle(selection, { x: 100, y: 80 }), 'nw')
  assert.equal(getResizeHandle(selection, { x: 220, y: 80 }), 'n')
  assert.equal(getResizeHandle(selection, { x: 340, y: 80 }), 'ne')
  assert.equal(getResizeHandle(selection, { x: 100, y: 160 }), 'w')
  assert.equal(getResizeHandle(selection, { x: 340, y: 160 }), 'e')
  assert.equal(getResizeHandle(selection, { x: 100, y: 240 }), 'sw')
  assert.equal(getResizeHandle(selection, { x: 220, y: 240 }), 's')
  assert.equal(getResizeHandle(selection, { x: 340, y: 240 }), 'se')
  assert.equal(getResizeHandle(selection, { x: 220, y: 160 }), '')
  assert.equal(getResizeHandle(selection, { x: 50, y: 50 }), '')
})

test('resizes each edge while keeping the opposite edge fixed', () => {
  assert.deepEqual(
    resizeSelection(selection, 'w', { x: 60, y: 0 }, { width: 500, height: 400 }),
    { x: 60, y: 80, w: 280, h: 160 }
  )
  assert.deepEqual(
    resizeSelection(selection, 'e', { x: 420, y: 0 }, { width: 500, height: 400 }),
    { x: 100, y: 80, w: 320, h: 160 }
  )
  assert.deepEqual(
    resizeSelection(selection, 'n', { x: 0, y: 40 }, { width: 500, height: 400 }),
    { x: 100, y: 40, w: 240, h: 200 }
  )
  assert.deepEqual(
    resizeSelection(selection, 's', { x: 0, y: 300 }, { width: 500, height: 400 }),
    { x: 100, y: 80, w: 240, h: 220 }
  )
})

test('resizes corners and clamps them to the canvas', () => {
  assert.deepEqual(
    resizeSelection(selection, 'nw', { x: -50, y: -20 }, { width: 500, height: 400 }),
    { x: 0, y: 0, w: 340, h: 240 }
  )
  assert.deepEqual(
    resizeSelection(selection, 'se', { x: 900, y: 700 }, { width: 500, height: 400 }),
    { x: 100, y: 80, w: 400, h: 320 }
  )
})

test('prevents resize handles from collapsing the selection', () => {
  assert.deepEqual(
    resizeSelection(selection, 'nw', { x: 500, y: 500 }, { width: 500, height: 400 }, 3),
    { x: 337, y: 237, w: 3, h: 3 }
  )
  assert.deepEqual(
    resizeSelection(selection, 'se', { x: 0, y: 0 }, { width: 500, height: 400 }, 3),
    { x: 100, y: 80, w: 3, h: 3 }
  )
})

test('maps resize handles and selection movement to native cursors', () => {
  assert.equal(selectionCursor('nw', false), 'nwse-resize')
  assert.equal(selectionCursor('ne', false), 'nesw-resize')
  assert.equal(selectionCursor('n', false), 'ns-resize')
  assert.equal(selectionCursor('e', false), 'ew-resize')
  assert.equal(selectionCursor('', true), 'move')
  assert.equal(selectionCursor('', false), 'crosshair')
})
