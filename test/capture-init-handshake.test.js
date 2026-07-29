const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
const preload = fs.readFileSync(path.join(root, 'preload-capture.js'), 'utf8')
const renderer = fs.readFileSync(path.join(root, 'capture', 'capture.js'), 'utf8')

test('capture initialization waits for the renderer-ready handshake', () => {
  assert.match(main, /captureWindow\._captureRendererReady = false/)
  assert.match(main, /function sendCaptureInit\(win\)[\s\S]*!win\._captureRendererReady[\s\S]*win\.webContents\.send\('capture:init', win\._captureInit\)/)
  assert.match(main, /ready: \(event\) => \{[\s\S]*win\._captureRendererReady = true[\s\S]*sendCaptureInit\(win\)/)
  assert.doesNotMatch(main, /captureWindow\.setFullScreen\(true\)/)
  assert.match(preload, /ready: \(\) => ipcRenderer\.send\('capture:ready'\)/)
  assert.match(renderer, /window\.captureAPI\.onInit\([\s\S]*window\.captureAPI\.ready\(\)/)
})
