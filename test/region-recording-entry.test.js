const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const html = fs.readFileSync(path.join(root, 'capture', 'capture.html'), 'utf8')
const script = fs.readFileSync(path.join(root, 'capture', 'capture.js'), 'utf8')
const preload = fs.readFileSync(path.join(root, 'preload-capture.js'), 'utf8')

test('capture toolbar exposes region recording for a selected rectangle', () => {
  assert.match(html, /id="translate"[\s\S]*id="record"[^>]+data-i18n-title="capture\.toolbar\.record"[\s\S]*id="pin"/)
  assert.match(script, /performAction\('record'\)/)
  // OCR 评审修复：录制入口在渲染层是"提前 return"，序号随第二参单独带回主进程（落过就推进）。
  assert.match(script, /captureAPI\.startRegionRecording\(selectionBounds,serialMeta\(\)\)/)
  assert.match(preload, /startRegionRecording:[\s\S]*capture:start-region-recording/)
  assert.match(preload, /startRegionRecording: \(selectionBounds, serial\)[\s\S]*selectionBounds, \.\.\.serial/)
})
