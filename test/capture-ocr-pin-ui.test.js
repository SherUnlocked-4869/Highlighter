const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
const captureCss = fs.readFileSync(path.join(root, 'capture', 'capture.css'), 'utf8')
const captureScript = fs.readFileSync(path.join(root, 'capture', 'capture.js'), 'utf8')
const pinMarkup = fs.readFileSync(path.join(root, 'pin', 'pin.html'), 'utf8')
const pinScript = fs.readFileSync(path.join(root, 'pin', 'pin.js'), 'utf8')

test('OCR result actions stay outside the selected image area', () => {
  assert.match(main, /const actionSpace = 62[\s\S]*Math\.max\(420, imageWidth\)/)
  assert.match(main, /windowBounds: editorBounds,[\s\S]*imageBounds: editorImageBounds,[\s\S]*transparent: isOcrEditor/)
  assert.match(main, /const transparent = mode === 'canvas' \|\| !!options\.transparent[\s\S]*hasShadow: !transparent/)
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

test('pinned image opacity is chosen from the context menu instead of an overlay slider', () => {
  assert.doesNotMatch(pinMarkup, /type="range"/)
  assert.doesNotMatch(pinScript, /setOpacity/)
  assert.doesNotMatch(main, /pin:set-opacity/)
  assert.match(main, /label: '透明度',[\s\S]*submenu: \[1, 0\.75, 0\.5, 0\.25\]/)
  assert.match(main, /type: 'radio',[\s\S]*click: \(\) => setPinOpacity\(win, opacity\)/)
})

test('OCR recognition hides the selected image size badge', () => {
  assert.match(captureScript, /const hideSizeBadge=processingAction==='ocr'\|\|!!activeOcrResult\|\|initData\?\.autoAction==='ocr'/)
  assert.match(captureScript, /sizeBadge\.style\.display=hideSizeBadge\?'none':'block'/)
  assert.match(captureScript, /if\(action==='ocr'\)sizeBadge\.style\.display='none'/)
})

test('pinned images align source pixels to the active display DPI', () => {
  assert.match(main, /function getPixelAlignedPinSize\(pixelWidth, pixelHeight, display, preferredSize = null\)/)
  assert.match(main, /Number\(pixelWidth\) \/ scaleFactor/)
  assert.match(main, /getPixelAlignedPinSize\(size\.width, size\.height, display, selectionBounds\)/)
  assert.match(main, /getPixelAlignedPinSize\(size\.width, size\.height, display, meta\.selectionBounds\)/)
  assert.match(main, /function syncPinDisplayScale\(win\)[\s\S]*screen\.getDisplayMatching\(bounds\)/)
  assert.match(main, /pixelWidth: size\.width,[\s\S]*displayScaleFactor: aligned\.scaleFactor/)
  assert.match(main, /const nextZoom = Math\.max\(0\.2, Math\.min\(3,/)
  assert.match(main, /data\.zoom = Math\.max\(0\.2, Math\.min\(3,/)
  assert.match(main, /pin:move-end[\s\S]*syncPinDisplayScale\(win\)/)
  assert.match(pinMarkup, /<canvas id="pixelImage"/)
  assert.match(pinScript, /context\.imageSmoothingEnabled = false/)
  assert.match(pinScript, /pixelImage\.classList\.toggle\('pixel-native'/)
  assert.match(pinScript, /Math\.abs\(Number\(zoom\) - 1\) < 0\.001/)
  assert.match(pinMarkup, /\.pin-surface\.pixel-native\{image-rendering:pixelated\}/)
  assert.match(pinScript, /if \(data\.longCapture\)[\s\S]*showImageSurface\(imageUrl, initial\)[\s\S]*return/)
  assert.match(pinScript, /context\.drawImage\(nextImage, 0, 0\)[\s\S]*showSurface\(pixelImage\)/)
})

test('pinned images reference an on-disk source instead of a resident base64 copy', () => {
  assert.match(main, /function writePinSourceFile\(buffer, meta = \{\}\)/)
  assert.match(main, /imagePath,/)
  assert.doesNotMatch(main, /_pinData\.dataUrl/)
  assert.doesNotMatch(pinScript, /data\.dataUrl/)
})
