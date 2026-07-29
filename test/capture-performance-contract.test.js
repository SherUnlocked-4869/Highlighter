const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
const preload = fs.readFileSync(path.join(root, 'preload-capture.js'), 'utf8')
const capture = fs.readFileSync(path.join(root, 'capture', 'capture.js'), 'utf8')
const markup = fs.readFileSync(path.join(root, 'capture', 'capture.html'), 'utf8')

test('capture input and output use PNG binary buffers across IPC', () => {
  assert.match(main, /imageBuffer:\s*source\.thumbnail\.toPNG\(\)/)
  assert.match(main, /_captureInit\s*=\s*\{[\s\S]*imageBuffer:/)
  assert.match(main, /nativeImage\.createFromBuffer\(buffer\)/)
  assert.match(preload, /copy:\s*\(imageBuffer, meta\)[\s\S]*\{ imageBuffer, meta \}/)
  assert.match(capture, /sourceCanvas\.toBlob\(/)
  assert.match(capture, /new Blob\(\[data\.imageBuffer\],\{type:'image\/png'\}\)/)
  assert.doesNotMatch(capture, /output\.toDataURL\('image\/png'\)/)
})

test('capture rendering separates the static background and coalesces overlay frames', () => {
  assert.match(markup, /id="backgroundStage"[\s\S]*id="stage"/)
  assert.match(capture, /function drawBackground\(\)[\s\S]*backgroundCtx\.drawImage\(image/)
  assert.match(capture, /function renderOverlay\(\)[\s\S]*ctx\.clearRect/)
  assert.match(capture, /function render\(\)\s*\{\s*if \(renderRequest\) return\s*renderRequest = requestAnimationFrame/)
})

test('capture preview keeps the desktop image in its native pixel buffer', () => {
  assert.match(capture, /function usesNativeBackgroundPixels\(\)/)
  assert.match(capture, /backgroundCanvas\.width=nativeBackground\?image\.naturalWidth:Math\.round\(innerWidth\*dpr\)/)
  assert.match(capture, /backgroundCanvas\.height=nativeBackground\?image\.naturalHeight:Math\.round\(innerHeight\*dpr\)/)
  assert.match(capture, /backgroundCtx\.imageSmoothingEnabled=false;backgroundCtx\.drawImage\(image,0,0\)/)
  assert.match(capture, /backgroundCanvas\.classList\.toggle\('native-pixels',nativeBackground\)/)
})
