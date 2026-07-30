const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const html = fs.readFileSync(path.join(root, 'capture', 'capture.html'), 'utf8')
const script = fs.readFileSync(path.join(root, 'capture', 'capture.js'), 'utf8')
const preload = fs.readFileSync(path.join(root, 'preload-capture.js'), 'utf8')

test('capture toolbar exposes region recording for a selected rectangle', () => {
  assert.match(html, /id="translate"[\s\S]*id="record"[^>]+title="区域录制"[\s\S]*id="pin"/)
  assert.match(script, /performAction\('record'\)/)
  assert.match(script, /captureAPI\.startRegionRecording\(selectionBounds\)/)
  assert.match(preload, /startRegionRecording:[\s\S]*capture:start-region-recording/)
})
