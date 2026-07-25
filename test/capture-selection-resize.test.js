const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const capture = fs.readFileSync(path.join(__dirname, '..', 'capture', 'capture.js'), 'utf8')
const html = fs.readFileSync(path.join(__dirname, '..', 'capture', 'capture.html'), 'utf8')

test('capture page loads selection resize utilities before its controller', () => {
  assert.ok(html.indexOf('selection-utils.js') < html.indexOf('capture.js'))
  assert.match(capture, /const \{\s*getResizeHandle,\s*resizeSelection,\s*selectionCursor\s*\} = window\.selectionUtils/)
})

test('selection pointer flow prioritizes handles over moving or replacing the selection', () => {
  assert.match(capture, /const resizeHandle=currentTool==='select'\?getResizeHandle\(selection,point\):''/)
  assert.match(capture, /if \(resizeHandle\) \{ resizing=\{handle:resizeHandle,initial:\{\.\.\.selection\}\}/)
  assert.match(capture, /selection=resizeSelection\(resizing\.initial,resizing\.handle,point,\{width:innerWidth,height:innerHeight\}\)/)
  assert.match(capture, /if\(resizing\)\{resizing=null;finishSelection\(\);updateSelectionCursor/)
  assert.match(capture, /canvas\.addEventListener\('pointercancel'/)
})
