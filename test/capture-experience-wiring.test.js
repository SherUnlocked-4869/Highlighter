const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const html = fs.readFileSync(path.join(root, 'capture', 'capture.html'), 'utf8')
const script = fs.readFileSync(path.join(root, 'capture', 'capture.js'), 'utf8')
const captureDomain = fs.readFileSync(path.join(root, 'main', 'domains', 'capture', 'index.js'), 'utf8')

test('save honors the caller saveMode and falls back to the fastSave setting (P0-7-T4)', () => {
  assert.match(
    script,
    /if\(action==='save'\)\{window\.captureAPI\.save\(imageBuffer,meta,initData\.saveMode\?initData\.saveMode==='fast':!!initData\.settings\.screenshot\.fastSave\);return\}/,
    'an explicit saveMode wins, an empty one falls back to screenshot.fastSave'
  )
  assert.match(captureDomain, /saveMode: options\.saveMode \|\| ''/, 'the init payload carries saveMode')
})

test('Ctrl+A selects the current display without breaking the other shortcuts (P0-7-T6)', () => {
  assert.match(
    script,
    /if\(event\.ctrlKey&&event\.key\.toLowerCase\(\)==='a'&&!event\.shiftKey&&!event\.altKey\)\{event\.preventDefault\(\)[\s\S]{0,90}?selection=\{\.\.\.imageDisplayBounds\(\)\}/,
    'Ctrl+A builds the selection from imageDisplayBounds()'
  )
  // The pre-existing shortcuts must survive the insertion.
  assert.match(script, /if\(event\.key==='Enter'&&!event\.ctrlKey[\s\S]{0,200}?performAction\('copy'\)/)
  assert.match(script, /if\(event\.ctrlKey&&event\.key\.toLowerCase\(\)==='s'\)\{event\.preventDefault\(\);performAction\('save'\)\}/)
  assert.match(script, /function imageDisplayBounds\(\)[\s\S]{0,260}?Math\.max\(1,Number\(bounds\.width\)\|\|1\)/)
})

test('the serial counter is reset explicitly on init and continues only when asked (P0-7-T7)', () => {
  assert.match(script, /let serialNumber = 1/)
  assert.match(script, /function resetSerialNumber\(data\) \{[\s\S]{0,160}?serialNumber=Number\.isFinite\(start\)&&start>0\?start:1/)
  assert.match(script, /window\.captureAPI\.onInit\(\(data\)=>\{[\s\S]{0,900}?resetSerialNumber\(data\)/, 'the reset runs inside the init path')
  assert.match(captureDomain, /keepSerialAcrossCaptures === true \? captureSerialSeq : 1/, 'the init payload carries the last used serial, not the capture index')
  assert.match(captureDomain, /serialNumber,/, 'the init payload carries the start value')
  // 精确接续（2026-10-10 真机验收修正）：渲染层回报"下一个该用的号"，主进程只接受前进。
  assert.match(captureDomain, /function reportCaptureSerial\(meta\) \{[\s\S]{0,520}?reported > captureSerialSeq\) captureSerialSeq = reported/)
  // OCR 评审修复：开关关闭时不推进计数，否则"先关后开"时首张启用截图不再从 1 开始。
  assert.match(
    captureDomain,
    /function reportCaptureSerial\(meta\) \{[\s\S]{0,320}?keepSerialAcrossCaptures !== true\) return/,
    'the counter must only advance while keepSerialAcrossCaptures is on'
  )
  assert.match(captureDomain, /close: \(event, payload = \{\}\) => \{[\s\S]{0,160}?reportCaptureSerial\(payload\)/, '✕/Esc 关窗也要推进序号')
  // OCR 评审修复：复制（Enter 走的路径）与录制/长截图出口也必须回报序号。
  assert.match(captureDomain, /copy: \(_event, \{ imageBuffer, dataUrl, meta \} = \{\}\) => \{[\s\S]{0,200}?reportCaptureSerial\(meta\)/)
  assert.match(captureDomain, /startRegionRecording: async \(event, \{ selectionBounds, serialNumber \} = \{\}\) => \{[\s\S]{0,200}?reportCaptureSerial\(\{ serialNumber \}\)/)
  assert.match(captureDomain, /startLong: \(event, payload = \{\}\) => \{[\s\S]{0,160}?reportCaptureSerial\(payload\)/)
  assert.match(script, /startRegionRecording\(selectionBounds,serialMeta\(\)\)/)
  assert.match(script, /startLongCapture\(\{\.\.\.selection\},serialMeta\(\)\)/)
  // 所有关窗出口统一走 closeCaptureWindow()（带序号），不再有裸的 captureAPI.close()。
  assert.doesNotMatch(script, /window\.captureAPI\.close\(\)/)
  assert.match(script, /function serialMeta\(\) \{[\s\S]{0,140}?serialNumber>initialSerialNumber\?\{serialNumber\}:\{\}/)
  assert.match(
    script,
    /const imageBuffer=await canvasPngBuffer\(output\)\s*\/\/[^\r\n]*[\s\S]{0,80}?Object\.assign\(meta,serialMeta\(\)\)/,
    'the serial must be read after the export/encode, not from the stale pre-action count'
  )
  assert.match(script, /function closeCaptureWindow\(\) \{[\s\S]{0,160}?window\.captureAPI\.close\(/)
})

test('the shutter sound is declared, gated on the frozen key and allowed to autoplay (P0-7-T5)', () => {
  assert.match(html, /<audio id="shutterSound" src="\.\.\/assets\/shutter\.wav" preload="auto"><\/audio>/)

  assert.match(script, /const shutterSound = document\.getElementById\('shutterSound'\)/)
  assert.match(script, /function playShutterSound\(\) \{[\s\S]{0,220}?shutterSound\.currentTime=0[\s\S]{0,120}?shutterSound\.play\(\)/)
  assert.match(script, /if\(initData\.settings\?\.screenshot\?\.shutterSound!==false\)playShutterSound\(\)/, 'the frozen key default is true')
  assert.match(script, /window\.captureAPI\.onShown\(\(\) => \{[\s\S]{0,260}?playShutterSound\(\)/, 'played after the main process shows the window')
  assert.doesNotMatch(script.slice(script.indexOf('window.captureAPI.onInit((data)=>{')), /playShutterSound\(\)/, 'init must stay silent')

  assert.match(captureDomain, /autoplayPolicy: 'no-user-gesture-required'/, 'the capture window must allow a gesture-free play()')

  // The page keeps its allow-list CSP; the media source is reachable from it only
  // if media-src allows the scheme the page actually uses (file: under loadFile).
  assert.match(html, /media-src 'self' blob:( file:)?;/)
})

test('assets/shutter.wav is a real PCM wav, not a placeholder', () => {
  const wavPath = path.join(root, 'assets', 'shutter.wav')
  assert.equal(fs.existsSync(wavPath), true, 'assets/shutter.wav must exist')
  const wav = fs.readFileSync(wavPath)
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF')
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE')
  assert.equal(wav.toString('ascii', 12, 16), 'fmt ')
  assert.equal(wav.readUInt32LE(16), 16, 'PCM fmt chunk')
  assert.equal(wav.readUInt16LE(20), 1, 'uncompressed PCM')
  assert.equal(wav.readUInt16LE(22), 1, 'mono')
  assert.equal(wav.readUInt16LE(34), 16, '16-bit samples')
  assert.equal(wav.toString('ascii', 36, 40), 'data')
  assert.equal(wav.readUInt32LE(40), wav.length - 44, 'the data chunk covers the rest of the file')
  const durationMs = (wav.length - 44) / 2 / wav.readUInt32LE(24) * 1000
  assert.ok(durationMs > 40 && durationMs < 400, `shutter click should be short (${Math.round(durationMs)}ms)`)
  // Not silence: a synthesized click has real amplitude.
  let peak = 0
  for (let index = 44; index + 1 < wav.length; index += 2) peak = Math.max(peak, Math.abs(wav.readInt16LE(index)))
  assert.ok(peak > 8000, `peak sample ${peak} looks like silence`)
})

test('the cursor overlay is wired after the annotations and only on the annotated export (P0-2/S9b)', () => {
  // Script order: capture.js reads window.cursorGeometry synchronously at paste time,
  // so the shared UMD module must be loaded first (same pattern as shortcut-keys.js).
  const geometryAt = html.indexOf('../shared/cursor-geometry.js')
  const captureAt = html.indexOf('src="capture.js"')
  assert.ok(geometryAt >= 0, 'capture.html must load ../shared/cursor-geometry.js')
  assert.ok(captureAt >= 0 && geometryAt < captureAt, 'cursor-geometry.js must be loaded before capture.js')

  // The bitmap is pre-decoded on init: exportSelectionCanvas is synchronous and cannot wait.
  assert.match(script, /let cursorImage = null/)
  assert.match(
    script,
    /if\(data\.cursor\?\.dataUrl\)\{cursorImage=new Image\(\);cursorImage\.src=data\.cursor\.dataUrl\}else cursorImage=null/,
    'init decodes the cursor bitmap and resets it when the payload carries none'
  )
  assert.ok(
    script.indexOf('cursorImage=new Image()') > script.indexOf("window.captureAPI.onInit((data)=>{"),
    'the pre-decode lives inside the init handler'
  )

  // The paste only runs on the annotated export, and only after the annotations.
  assert.match(
    script,
    /if\(includeAnnotations&&initData\?\.cursor&&cursorImage&&cursorImage\.complete&&cursorImage\.naturalWidth>0&&window\.cursorGeometry\)\{/
  )
  const annotationsAt = script.indexOf('annotations.forEach((item)=>drawAnnotation(out,item,')
  const placementAt = script.indexOf('resolveCursorPlacement')
  assert.ok(annotationsAt >= 0 && placementAt > annotationsAt, 'the cursor must be pasted after the annotations')

  // DIP contract: provider physicalPoint -> DIP before the pure function sees it; the
  // hotspot stays 1:1 (no scaleFactor multiplication) and the paste subtracts the crop origin.
  assert.match(script, /cursorScreenPoint:\{x:\(Number\(cursor\.physicalPoint\?\.x\)\|\|0\)\/pointScale/)
  assert.match(script, /captureBounds:initData\.captureBounds/)
  assert.match(script, /imageSize:\{width:image\.naturalWidth,height:image\.naturalHeight\}/)
  assert.match(script, /selectionRect:source/)
  assert.match(script, /scaleFactor:initData\.scaleFactor/)
  assert.doesNotMatch(script, /hotspot\.x\*/, 'the hotspot must not be multiplied by the scale factor')
  assert.match(
    script,
    /if\(placement\.visible\)out\.drawImage\(cursorImage,placement\.x-source\.x,placement\.y-source\.y,placement\.width\|\|cursorImage\.naturalWidth,placement\.height\|\|cursorImage\.naturalHeight\)/,
    'paste on the cropped output canvas, at natural size, only when the geometry says visible'
  )

  // The main process ships null when the frozen switch is off, which is the pixel-identical path.
  assert.match(captureDomain, /cursor: cursorSnapshot/)
  assert.match(captureDomain, /\? \{[\s\S]{0,600}?physicalPoint: \{ x: cursorSnapshot\.physicalPoint\.x, y: cursorSnapshot\.physicalPoint\.y \}[\s\S]{0,40}?: null/)
})
