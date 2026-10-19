const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
const pinDomainSource = fs.readFileSync(path.join(root, 'main/domains/pin/index.js'), 'utf8')
const captureCss = fs.readFileSync(path.join(root, 'capture', 'capture.css'), 'utf8')
const captureScript = fs.readFileSync(path.join(root, 'capture', 'capture.js'), 'utf8')
const pinMarkup = fs.readFileSync(path.join(root, 'pin', 'pin.html'), 'utf8')
const pinCss = fs.readFileSync(path.join(root, 'pin', 'pin.css'), 'utf8')
const pinScript = fs.readFileSync(path.join(root, 'pin', 'pin.js'), 'utf8')

test('OCR result actions stay outside the selected image area', () => {
  const captureDomain = fs.readFileSync(path.join(root, 'main/domains/capture/index.js'), 'utf8')
  // 重新标注编辑器（普通右键重新标注与 OCR/翻译两条路径）统一在图像下方预留工具栏条带，
  // 且条带高度由"这个宽度下主行会折几行"推导（不是拍常数）。
  assert.match(pinDomainSource, /const stripRows = Math\.max\(1, Math\.ceil\(ROW_MIN_CONTENT[\s\S]*const actionSpace = stripRows \* STRIP_ROW_HEIGHT \+ OPTIONS_ROW_HEIGHT \+ STRIP_CHROME \+ STRIP_SLACK/)
  assert.match(pinDomainSource, /const editorImageBounds = \{[\s\S]{0,160}?y: 0,/)
  assert.match(pinDomainSource, /windowBounds: editorBounds,[\s\S]*imageBounds: editorImageBounds,[\s\S]*transparent: true,/)
  assert.match(captureDomain, /const transparent = mode === 'canvas' \|\| !!options\.transparent[\s\S]*hasShadow: !transparent/)
  assert.match(captureScript, /function imageDisplayBounds\(\)[\s\S]*initData\?\.imageBounds/)
  assert.match(captureScript, /function positionOcrResultBar\(\)[\s\S]*selection\.y\+selection\.h\+10/)
  assert.match(captureScript, /top\+rect\.height>innerHeight-8\)top=selection\.y-rect\.height-10/)
  assert.match(captureScript, /ocrResultBar\.classList\.remove\('hidden'\)[\s\S]*positionOcrResultBar\(\)/)
  assert.doesNotMatch(captureCss, /\.ocr-result-bar\s*\{[^}]*bottom:/)
})

test('pinned images omit the top-right copy save and close overlay', () => {
  assert.doesNotMatch(pinMarkup, /class="controls"/)
  assert.doesNotMatch(pinMarkup, /<button id="(?:copy|save|close)"/)
  assert.doesNotMatch(pinMarkup, /\.controls/)
  assert.match(pinScript, /addEventListener\('contextmenu'/)
})

test('pinned image opacity keeps the context-menu presets and adds ctrl+wheel without an overlay slider', () => {
  // No overlay control ever comes back: the window has no slider and the renderer
  // never calls a setOpacity API of its own (the main process owns the value).
  assert.doesNotMatch(pinMarkup, /type="range"/)
  assert.doesNotMatch(pinScript, /setOpacity/)
  // main.js only wires the policy; the channel lives in the pin domain.
  assert.doesNotMatch(main, /pin:set-opacity/)
  // The P0 feature (2026-10-18 snow migration §9.2-②): the domain registers the
  // Ctrl+wheel listener and the renderer's wheel handler sends a direction to it.
  assert.match(pinDomainSource, /ipcMain\.on\('pin:set-opacity'/)
  assert.match(pinDomainSource, /function setPinOpacity\(/)
  assert.match(pinDomainSource, /nextPinOpacity\(win\._pinData\.opacity, direction\)/)
  assert.match(pinScript, /addEventListener\('wheel'/)
  assert.match(pinScript, /if \(event\.ctrlKey\)[\s\S]*window\.pinAPI\.adjustOpacity/)
  assert.match(pinScript, /onOpacityChanged/)
  // The menu presets stay: Ctrl+wheel is additive, not a replacement.
  assert.match(pinDomainSource, /label: '透明度',[\s\S]*submenu: \[1, 0\.75, 0\.5, 0\.25\]/)
  assert.match(pinDomainSource, /type: 'radio',[\s\S]*click: \(\) => setPinOpacity\(win, opacity\)/)
})

test('pinned image click-through adds a corner badge and a context-menu radio, never an overlay control', () => {
  assert.match(pinDomainSource, /label: '点击穿透',[\s\S]*type: 'radio'[\s\S]*click: \(\) => setPinClickThrough\(win, enabled\)/)
  assert.match(pinMarkup, /<div id="clickThroughTag"/)
  // The badge is the only pointer target a click-through pin keeps, and it stays
  // hidden while the pin still accepts the mouse.
  assert.match(pinCss, /#clickThroughTag\{[^}]*pointer-events:auto[^}]*display:none\}/)
  assert.match(pinCss, /#clickThroughTag\.show\{display:block\}/)
  assert.match(pinScript, /onClickThroughChanged/)
  assert.match(pinScript, /clickThroughTag\.addEventListener\('mouseenter'/)
  assert.match(pinScript, /window\.pinAPI\.setClickThrough\(false\)/)
  // Must not reintroduce the overlay controls the pin window deliberately dropped.
  assert.doesNotMatch(pinMarkup, /type="range"/)
  assert.doesNotMatch(pinMarkup, /<button id="(?:copy|save|close|clickThrough)"/)
  assert.doesNotMatch(pinScript, /setOpacity/)
})

test('OCR recognition hides the selected image size badge', () => {
  assert.match(captureScript, /const hideSizeBadge=\['ocr','translate'\]\.includes\(processingAction\)\|\|!!activeOcrResult\|\|\['ocr','translate'\]\.includes\(initData\?\.autoAction\)/)
  assert.match(captureScript, /sizeBadge\.style\.display=hideSizeBadge\?'none':'block'/)
  assert.match(captureScript, /if\(\['ocr','translate'\]\.includes\(action\)\)sizeBadge\.style\.display='none'/)
})

test('OCR translation uses the same positioned overlay interaction as OCR text extraction', () => {
  const captureDomain = fs.readFileSync(path.join(root, 'main/domains/capture/index.js'), 'utf8')
  const ocrIpc = fs.readFileSync(path.join(root, 'main/ipc/ocr-ipc.js'), 'utf8')
  assert.match(ocrIpc, /translateOcrTextBlocks\([\s\S]*textBlocks\.map/)
  assert.match(ocrIpc, /translationResult: \{[\s\S]*textBlocks: translatedBlocks/)
  assert.match(captureDomain, /_pendingReannotateAction = \['ocr', 'translate'\]\.includes\(action\)/)
  assert.match(captureScript, /\['ocr','translate'\]\.includes\(action\)&&!initData\.editPin/)
  assert.match(captureScript, /showOcrOverlay\(result\.translationResult,\{mode:'translate'/)
  assert.doesNotMatch(captureScript, /resultPanel\.classList\.remove\('hidden'\); resultSource\.classList\.toggle\('hidden',type!=='translate'/)
  assert.match(captureCss, /\.ocr-text-block\.translation/)
})

test('pinned images align source pixels to the active display DPI', () => {
  const pinDomain = fs.readFileSync(path.join(root, 'main/domains/pin/index.js'), 'utf8')
  // Pure geometry lives in main/domains/pin/geometry.js (see test/pin-geometry.test.js).
  assert.match(main, /require\('\.\/main\/domains\/pin'\)/)
  assert.match(pinDomain, /getPixelAlignedPinSize\(size\.width, size\.height, display, selectionBounds\)/)
  assert.match(pinDomain, /getPixelAlignedPinSize\(size\.width, size\.height, display, meta\.selectionBounds\)/)
  assert.match(pinDomain, /function syncPinDisplayScale\(win\)[\s\S]*screen\.getDisplayMatching\(bounds\)/)
  assert.match(pinDomain, /pixelWidth: size\.width,[\s\S]*displayScaleFactor: aligned\.scaleFactor/)
  assert.match(pinDomain, /pin:move-end[\s\S]*syncPinDisplayScale\(win\)/)
  assert.match(pinMarkup, /<canvas id="pixelImage"/)
  assert.match(pinScript, /context\.imageSmoothingEnabled = false/)
  assert.match(pinScript, /pixelImage\.classList\.toggle\('pixel-native'/)
  assert.match(pinScript, /Math\.abs\(Number\(zoom\) - 1\) < 0\.001/)
  assert.match(pinCss, /\.pin-surface\.pixel-native\{image-rendering:pixelated\}/)
  assert.match(pinScript, /if \(data\.longCapture\)[\s\S]*showImageSurface\(data\.dataUrl, initial\)[\s\S]*return/)
  assert.match(pinScript, /context\.drawImage\(nextImage, 0, 0\)[\s\S]*showSurface\(pixelImage\)/)
})
