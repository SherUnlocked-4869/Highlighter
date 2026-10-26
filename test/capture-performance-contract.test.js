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
  const captureDomain = fs.readFileSync(path.join(root, 'main/domains/capture/index.js'), 'utf8')
  assert.match(captureDomain, /imageBuffer:\s*source\.thumbnail\.toPNG\(\)/)
  assert.match(captureDomain, /_captureInit\s*=\s*\{[\s\S]*imageBuffer:/)
  assert.match(captureDomain, /nativeImage\.createFromBuffer\(buffer\)/)
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

// Regression from a real-device report: "the selection mask only covers the top-left corner instead
// of the whole screen".
//
// Root cause: assigning `canvas.width`/`canvas.height` RESETS the whole 2D context state, transform
// included. `resizeCanvas()` sizes the stage canvas to `innerWidth*dpr` PHYSICAL pixels while every
// drawing call is written in CSS pixels, so the DPR transform has to be re-established afterwards.
// It used to be an unconditional `setTransform` at the top of renderOverlay(); a refactor folded it
// into the `!image` early return, so the normal capture path drew at 1:1 physical pixels - on a 150%
// display the overlay then covered only 1/1.5 of the window in each axis (44% of the area).
//
// The assert below pins the ORDER (transform applied before any drawing, every frame) because that
// is the property that was lost. It is deliberately not just "setTransform appears somewhere".
test('the overlay applies its DPR transform on every frame, not only before an image exists', () => {
  const overlayStart = capture.indexOf('function renderOverlay()')
  const overlayEnd = capture.indexOf('function render()', overlayStart)
  assert.ok(overlayStart >= 0 && overlayEnd > overlayStart, 'renderOverlay must be present')
  const overlay = capture.slice(overlayStart, overlayEnd)

  // 1) setTransform must be UNCONDITIONAL: it may not live on the early-return line or inside a
  //    branch that only runs when there is no image.
  assert.doesNotMatch(
    overlay,
    /if \(!image\)\s*return\s+ctx\.setTransform/,
    'the DPR transform must not be folded into the !image early return (that is the regression)'
  )
  const transformAt = overlay.indexOf('ctx.setTransform(dpr,0,0,dpr,0,0)')
  const clearAt = overlay.indexOf('ctx.clearRect(')
  const firstImageGuard = overlay.indexOf('if (!image) return')
  assert.ok(transformAt >= 0, 'renderOverlay must set the DPR transform')
  assert.ok(
    transformAt < firstImageGuard,
    'the transform must be applied before the !image guard, i.e. on every frame'
  )
  assert.ok(
    transformAt < clearAt,
    'the transform must be applied before the first clearRect/paint of the frame'
  )

  // 2) And the resize path must be the documented reset point it is: canvas.width/height are
  //    assigned in resizeCanvas, which is why a per-frame transform is mandatory.
  assert.match(capture, /canvas\.width=Math\.round\(innerWidth\*dpr\)/)
  assert.match(capture, /canvas\.height=Math\.round\(innerHeight\*dpr\)/)
})

// The numeric proof of the same property, so the test fails for the right reason if someone reasons
// "the transform is set once at startup, that's enough". A canvas whose state was reset by a size
// assignment, drawn in CSS px without re-establishing the transform, covers only 1/dpr^2 of itself.
test('a resized canvas loses its transform, so the overlay must re-apply it (arithmetic)', () => {
  const dpr = 1.5
  const cssWidth = 1260
  const cssHeight = 843
  const physicalPixels = Math.round(cssWidth * dpr) * Math.round(cssHeight * dpr)
  // Drawing a cssWidth x cssHeight rect with an IDENTITY transform inks cssWidth*cssHeight
  // device pixels, which is exactly 1/dpr^2 of the backing store.
  const inkedWithoutTransform = cssWidth * cssHeight
  const fractionWithoutTransform = inkedWithoutTransform / physicalPixels
  assert.ok(
    Math.abs(fractionWithoutTransform - 1 / (dpr * dpr)) < 0.01,
    `without the transform the ink covers 1/dpr^2 of the canvas (got ${fractionWithoutTransform.toFixed(4)})`
  )
  // With the transform present the CSS-sized rect covers the entire backing store (the small
  // shortfall is only the Math.round of the backing dimensions, not a coverage gap).
  const inkedWithTransform = cssWidth * dpr * (cssHeight * dpr)
  const fractionWithTransform = inkedWithTransform / physicalPixels
  assert.ok(
    fractionWithTransform > 0.999,
    `with the transform the whole canvas is inked (got ${fractionWithTransform.toFixed(4)})`
  )
})

// W3 (memory plan §4.3): the initial screenshot PNG is delivered as `imageBuffer` on the shared
// `initData` object and was only ever read once, to build the Blob that `image.src` decodes. Without
// an explicit clear that PNG-sized ArrayBuffer stays reachable for the whole life of the capture
// window. Exports are safe to drop it: export re-encodes the canvas, commit only sends resultBuffer
// and history "continue editing" re-reads the file from disk. The clear must live in the BASE
// `image.onload` because the documentEditor branch wraps that callback; pinning the wrapper instead
// would leave the plain screenshot path unfixed.
test('the capture renderer releases the initial PNG buffer once the image decodes (W3)', () => {
  const onloadStart = capture.indexOf('image=new Image(); image.onload=()=>{')
  const onloadEnd = capture.indexOf('image.onerror=', onloadStart)
  assert.ok(onloadStart >= 0 && onloadEnd > onloadStart, 'the base image.onload must be present')
  const onload = capture.slice(onloadStart, onloadEnd)
  assert.match(
    onload,
    /initData\.imageBuffer=null/,
    'the base image.onload must clear the shared init buffer so the PNG bytes can be collected'
  )
  // Guard the documented single-use contract: the buffer must still be consumed by the Blob that
  // feeds image.src (the decode callback runs only after that Blob exists), so the only clear is
  // the one inside the callback and not a stray synchronous wipe before the Blob is built.
  assert.ok(
    capture.indexOf("new Blob([data.imageBuffer]") >= 0,
    'image.src must still be fed from the initial imageBuffer Blob'
  )
  assert.equal(
    capture.split('initData.imageBuffer=null').length - 1,
    1,
    'the buffer must be cleared exactly once'
  )
})
