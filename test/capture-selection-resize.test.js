const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const capture = fs.readFileSync(path.join(__dirname, '..', 'capture', 'capture.js'), 'utf8')
const html = fs.readFileSync(path.join(__dirname, '..', 'capture', 'capture.html'), 'utf8')
const { getSourcePixelRect } = require('../capture/selection-utils')

test('capture page loads selection resize utilities before its controller', () => {
  assert.ok(html.indexOf('selection-utils.js') < html.indexOf('capture.js'))
  assert.match(capture, /const \{\s*getResizeHandle,\s*getSourcePixelRect,\s*resizeSelection,\s*selectionCursor\s*\} = window\.selectionUtils/)
})

test('selection crops snap every edge to native source pixels at fractional DPI', () => {
  assert.deepEqual(
    getSourcePixelRect(
      { x: 101, y: 51, w: 333, h: 211 },
      { x: 0, y: 0, w: 1494, h: 934 },
      { width: 2240, height: 1400 }
    ),
    { x: 151, y: 76, width: 500, height: 317 }
  )
  assert.deepEqual(
    getSourcePixelRect(
      { x: 0, y: 0, w: 1494, h: 934 },
      { x: 0, y: 0, w: 1494, h: 934 },
      { width: 2240, height: 1400 }
    ),
    { x: 0, y: 0, width: 2240, height: 1400 }
  )
  assert.match(capture, /out\.imageSmoothingEnabled=false/)
  assert.match(capture, /out\.drawImage\(image,source\.x,source\.y,source\.width,source\.height,0,0,source\.width,source\.height\)/)
})

test('selection pointer flow prioritizes handles over moving or replacing the selection', () => {
  assert.match(capture, /const resizeHandle=currentTool==='select'\?getResizeHandle\(selection,point\):''/)
  assert.match(capture, /if \(resizeHandle\) \{ resizing=\{handle:resizeHandle,initial:\{\.\.\.selection\}\}/)
  assert.match(capture, /selection=resizeSelection\(resizing\.initial,resizing\.handle,point,\{width:innerWidth,height:innerHeight\}\)/)
  assert.match(capture, /if\(resizing\)\{resizing=null;finishSelection\(\);updateSelectionCursor/)
  assert.match(capture, /canvas\.addEventListener\('pointercancel'/)
})
