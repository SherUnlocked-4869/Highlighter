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

test('recording UI contains control and preview states', () => {
  const html = fs.readFileSync(path.join(root, 'record', 'record.html'), 'utf8')
  const script = fs.readFileSync(path.join(root, 'record', 'record.js'), 'utf8')
  for (const id of ['controlView', 'countdown', 'start', 'pause', 'stop', 'previewView', 'preview', 'saveMp4', 'rerecord']) {
    assert.match(html, new RegExp(`id="${id}"`))
  }
  assert.match(script, /canvas\.captureStream\(frameRate\)/)
  assert.match(script, /video\/webm/)
  assert.match(script, /appendChunk/)
  assert.match(script, /transitionRecordingState/)
  assert.match(script, /primeSeekablePreview\(preview\)/)
})

test('region recording uses supported silent MP4 settings', () => {
  const config = fs.readFileSync(path.join(root, 'config', 'config.js'), 'utf8')
  const recordHtml = fs.readFileSync(path.join(root, 'record', 'record.html'), 'utf8')
  const recordScript = fs.readFileSync(path.join(root, 'record', 'record.js'), 'utf8')
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
  assert.match(config, /5.*16.*24.*30.*60/)
  assert.doesNotMatch(config, /includeMicrophone|录制麦克风/i)
  assert.doesNotMatch(recordHtml, /microphone|麦克风|系统声音/i)
  assert.match(recordHtml, /id="recordError"/)
  assert.match(recordHtml, /id="saveProgress"/)
  assert.match(recordScript, /无法获取桌面录制画面/)
  assert.match(recordScript, /cancelButton\.disabled/)
  assert.match(recordScript, /async function rerecord\(\)[\s\S]*catch \(error\) \{[\s\S]*cancelSession\(sessionId\)/)
  assert.match(main, /未找到 MP4 编码组件/)
})

test('MP4 save dialog is owned and not covered by the topmost preview', () => {
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
  assert.match(main, /record:save-mp4[\s\S]*setAlwaysOnTop\(false\)[\s\S]*showSaveDialog\(win,/)
  assert.match(main, /showSaveDialog\(win,[\s\S]*finally[\s\S]*setAlwaysOnTop\(true, 'screen-saver'\)/)
})
