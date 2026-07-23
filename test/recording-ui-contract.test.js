const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

test('recording runtime packages ffmpeg', () => {
  assert.match(packageJson.dependencies['ffmpeg-static'], /^\^5\./)
  assert.ok(packageJson.build.asarUnpack.includes('node_modules/ffmpeg-static/**/*'))
})

test('main process wires protected region recording windows', () => {
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
  const recordPreload = fs.readFileSync(path.join(root, 'preload-record.js'), 'utf8')
  const framePreload = fs.readFileSync(path.join(root, 'preload-record-frame.js'), 'utf8')
  const frame = fs.readFileSync(path.join(root, 'record', 'frame.html'), 'utf8')

  assert.match(main, /capture:start-region-recording/)
  assert.match(main, /setContentProtection\(true\)/)
  assert.match(main, /record:start-session/)
  assert.match(main, /record:append-chunk/)
  assert.match(main, /record:finish-session/)
  assert.match(main, /record:save-mp4/)
  assert.match(recordPreload, /startSession:/)
  assert.match(recordPreload, /appendChunk:/)
  assert.match(framePreload, /record-frame:state/)
  assert.match(frame, /data-state="idle"/)
})
