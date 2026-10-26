// R0.4 真机像素回归：识别输入真的被遮罩了（真实 Electron 隐藏窗，不占屏幕）。
//
// 为什么必须有这一条：`test/occlusion-recognition-wiring.test.js` 只能证明"渲染层把正确的
// 输入喂给了正确的函数"，它看不见真实画布上到底画了什么。R0.4 是**隐私修复**，判据必须是
// "模型能读到的像素里，被马赛克盖住的那块是不是黑的"，而不是"代码调用了某个函数"。
// 本轮已经有一次教训（feature C 的 `<label data-i18n>` 被 textContent 抹掉）就是纯静态
// 测试看不见、只有真实窗口才抓到的。
//
// 取样纪律（照 capture-brush-render.test.js §5.7）：
//   ① 取样区由"标注几何"决定，不手写魔数坐标；
//   ② 分区计数（遮罩区内 / 区外）而不是单点比较；
//   ③ 断言方向是"遮罩区全黑且区外没有整块黑" —— 一个恒真的断言没有价值；
//   ④ 所有跨坐标系比较先换算回 CSS px。
//
// 窗口一律 show:false：AGENTS.md 要求可见测试窗放副屏，而本机只有主屏，所以绝不可见。
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.join(__dirname, '..')

const STAGE_WIDTH = 800
const STAGE_HEIGHT = 600
// The mosaic rectangle, in CSS px == source px here (scaleFactor 1, image = display size), so the
// mask plan's source-pixel geometry and the exported canvas share one coordinate space.
const BLUR_RECT = { x: 220, y: 160, w: 200, h: 110 }
// A text-like dark block INSIDE the blur rect: this is the content the mask must make unreadable.
const SECRET_RECT = { x: 250, y: 190, w: 140, h: 50 }

const PROBE_SOURCE = `
'use strict'
const { app, ipcMain, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.env.MASK_PROBE_ROOT
const RESULT = process.env.MASK_PROBE_RESULT
const { createSecureWindow } = require(path.join(ROOT, 'main', 'services', 'window-security'))

const STAGE_WIDTH = ${STAGE_WIDTH}
const STAGE_HEIGHT = ${STAGE_HEIGHT}
const BLUR_RECT = ${JSON.stringify(BLUR_RECT)}
const SECRET_RECT = ${JSON.stringify(SECRET_RECT)}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const records = { consoles: [] }

ipcMain.on('capture:ready', () => {})
ipcMain.on('capture:render-ready', () => {})
ipcMain.on('capture:render-error', (_event, message) => records.consoles.push('render-error: ' + message))
ipcMain.on('capture:close', () => {})
ipcMain.on('capture:save', () => {})
ipcMain.handle('capture:export-pdf', () => null)

let win = null

// A synthetic screenshot with real content everywhere: a luminance ramp (so any compositing change
// is visible) plus a dark "text block" inside the mosaic area (the thing that must become unreadable).
function screenshotDataUrl () {
  return win.webContents.executeJavaScript(\`(function(){
    var W=\${STAGE_WIDTH}, H=\${STAGE_HEIGHT};
    var c=document.createElement('canvas');
    c.width=W; c.height=H;
    var g=c.getContext('2d');
    var ramp=g.createLinearGradient(0,0,W,H);
    ramp.addColorStop(0,'#f2efe8'); ramp.addColorStop(0.5,'#a8adb8'); ramp.addColorStop(1,'#3b4359');
    g.fillStyle=ramp; g.fillRect(0,0,W,H);
    // A grid of dark strokes: pixelating or masking it always changes pixels, so the assertions
    // can never pass vacuously on flat colour.
    g.fillStyle='#101014';
    for (var row=0; row<18; row++) {
      var y=60+row*26;
      g.fillRect(40, y, W-80, 9);
    }
    // The "secret" text block inside the mosaic area, drawn solid so a masking bug is obvious.
    g.fillStyle='#000000';
    g.fillRect(\${SECRET_RECT.x}, \${SECRET_RECT.y}, \${SECRET_RECT.w}, \${SECRET_RECT.h});
    return c.toDataURL('image/png');
  })()\`)
}

async function main () {
  const report = { ok: false }
  try {
    const pagePath = path.join(ROOT, 'capture', 'capture.html')
    win = createSecureWindow({
      BrowserWindow: BrowserWindow,
      pagePath: pagePath,
      options: {
        show: false,
        width: STAGE_WIDTH,
        height: STAGE_HEIGHT,
        frame: false,
        resizable: false,
        webPreferences: {
          preload: path.join(ROOT, 'preload-capture.js'),
          backgroundThrottling: false
        }
      }
    })
    win.webContents.on('console-message', function () {
      const args = Array.prototype.slice.call(arguments)
      const details = args[1]
      const text = details && typeof details === 'object' && details.message ? details.message : args[2]
      if (text) records.consoles.push(String(text))
    })
    await win.loadFile(pagePath)

    report.hasMaskModule = await win.webContents.executeJavaScript('!!(window.occlusionMask && window.occlusionMask.buildOcclusionPlan)')
    report.hasCompositor = await win.webContents.executeJavaScript('!!(window.captureOutputCompositor && window.captureOutputCompositor.composeOutputCanvas)')

    const dataUrl = await screenshotDataUrl()
    const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')
    win.webContents.send('capture:init', {
      imageBuffer: png,
      mode: 'region',
      autoAction: '',
      source: 'region',
      displayBounds: { x: 0, y: 0, width: STAGE_WIDTH, height: STAGE_HEIGHT },
      captureBounds: { x: 0, y: 0, width: STAGE_WIDTH, height: STAGE_HEIGHT },
      imageBounds: null,
      scaleFactor: 1,
      editPin: false,
      smartSelect: false,
      cursorPosition: { x: 0, y: 0 },
      saveMode: '',
      cursor: null,
      serialNumber: 1,
      settings: { mainColor: '#e5a44c', screenshot: { shutterSound: false, fastSave: false, annotationWidth: 4, watermark: {} }, ocr: {} }
    })
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const loaded = await win.webContents.executeJavaScript('!!(image&&image.complete&&image.naturalWidth>0)')
      if (loaded) break
      await sleep(50)
    }
    await sleep(200)

    // Page-side helper: build a frame through the REAL export entry point and return raw pixels.
    // Everything goes through exportSelectionCanvasForAction so the test exercises the same switch
    // the recognition entries use, not a hand-rolled copy of it.
    await win.webContents.executeJavaScript(\`(function(){
      window.__mask = {
        // options: { includeAnnotations, compose, mask }
        // The region is the WHOLE display, expressed the way Ctrl+A expresses it (imageDisplayBounds),
        // so the export covers the full base image and its pixels line up with CSS px 1:1 here.
        frame: function(options){
          var b=imageDisplayBounds();
          selection={x:b.x,y:b.y,w:b.w,h:b.h};
          var out=exportSelectionCanvasForAction(!!options.includeAnnotations, selection, {
            compose: options.compose===true,
            mask: options.mask===true
          });
          var ctx=out.getContext('2d');
          var data=ctx.getImageData(0,0,out.width,out.height).data;
          return {width:out.width,height:out.height,data:Array.prototype.slice.call(data)};
        },
        setAnnotations: function(list){ annotations=list; annotationSeq=list.length; },
        plan: function(){
          var mask=window.occlusionMask;
          var occluders=mask.buildOccluders(annotations);
          return {occluders:occluders, plan:mask.planOcclusion({crop:{x:0,y:0,w:image.naturalWidth,h:image.naturalHeight},occluders:occluders})};
        }
      };
      return true;
    })()\`)

    // A rect mosaic over the secret block, plus an arrow that must NOT appear in the recognition
    // input (includeAnnotations=false) but must appear in the ordinary export.
    const annotations = [
      { type: 'blur', id: 1, x: BLUR_RECT.x, y: BLUR_RECT.y, x2: BLUR_RECT.x + BLUR_RECT.w, y2: BLUR_RECT.y + BLUR_RECT.h, width: 4, color: '#ff3b30' },
      { type: 'rect', id: 2, x: 60, y: 480, x2: 300, y2: 560, width: 8, color: '#ff3b30', fill: 'solid' }
    ]
    await win.webContents.executeJavaScript('window.__mask.setAnnotations(' + JSON.stringify(annotations) + ')')
    report.plan = await win.webContents.executeJavaScript('window.__mask.plan()')

    report.recognition = await win.webContents.executeJavaScript(
      'window.__mask.frame({includeAnnotations:false,compose:false,mask:true})'
    )
    report.plain = await win.webContents.executeJavaScript(
      'window.__mask.frame({includeAnnotations:false,compose:false,mask:false})'
    )
    report.userFacing = await win.webContents.executeJavaScript(
      'window.__mask.frame({includeAnnotations:true,compose:false,mask:false})'
    )
    // Decoration must never be applied to a recognition input even when the user has a card preset
    // selected: compose:false is what guarantees it.
    await win.webContents.executeJavaScript(
      'if (outputStyleController) outputStyleController.selectPreset("card-light")'
    )
    report.recognitionWithCardPreset = await win.webContents.executeJavaScript(
      'window.__mask.frame({includeAnnotations:false,compose:false,mask:true})'
    )
    report.userFacingWithCardPreset = await win.webContents.executeJavaScript(
      'window.__mask.frame({includeAnnotations:true,compose:true,mask:false})'
    )
    await win.webContents.executeJavaScript('if (outputStyleController) outputStyleController.selectPreset("original")')

    report.consoles = records.consoles
    report.stage = { width: STAGE_WIDTH, height: STAGE_HEIGHT }
    // The window's real viewport. A frameless 800x600 window still has an innerHeight of 598 on
    // Windows (the frame is not the only thing that can shave a pixel), and the stage is the
    // viewport - asserting against the requested size instead of the real one would make this
    // probe fail for a reason unrelated to masking.
    report.inner = { width: await win.webContents.executeJavaScript('innerWidth'), height: await win.webContents.executeJavaScript('innerHeight') }
    // The base image's own pixel size. The export is a crop of THAT, clamped by getSourcePixelRect,
    // so on a viewport that is a couple of pixels taller than the image the crop is the image size -
    // which is the invariant the assertions below use (never the requested window size).
    report.imageSize = await win.webContents.executeJavaScript('({width:image.naturalWidth,height:image.naturalHeight})')
    report.blurRect = BLUR_RECT
    report.secretRect = SECRET_RECT
    report.ok = true
    win.destroy()
  } catch (error) {
    report.error = String(error && error.stack ? error.stack : error)
  }
  fs.writeFileSync(RESULT, JSON.stringify(report, null, 2))
  app.exit(report.ok ? 0 : 1)
}

app.whenReady().then(main, (error) => {
  fs.writeFileSync(RESULT, JSON.stringify({ ok: false, error: String(error && error.stack ? error.stack : error) }))
  app.exit(1)
})
`

// Pixel helpers on the node side: the probe only ships raw RGBA, the arithmetic lives here.
function pixelAt (frame, x, y) {
  const offset = (y * frame.width + x) * 4
  return {
    r: frame.data[offset],
    g: frame.data[offset + 1],
    b: frame.data[offset + 2],
    a: frame.data[offset + 3]
  }
}

function countWithin (frame, rect, predicate) {
  let count = 0
  const left = Math.max(0, Math.round(rect.x))
  const top = Math.max(0, Math.round(rect.y))
  const right = Math.min(frame.width, Math.round(rect.x + rect.w))
  const bottom = Math.min(frame.height, Math.round(rect.y + rect.h))
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      if (predicate(pixelAt(frame, x, y), x, y)) count += 1
    }
  }
  return count
}

const isOpaqueBlack = (pixel) => pixel.r <= 2 && pixel.g <= 2 && pixel.b <= 2 && pixel.a >= 250

test('R0.4 a real capture window masks blur areas out of the recognition input (pixels, not just wiring)', { timeout: 120000 }, () => {
  const probeDir = path.join(root, '.tmp', 'occlusion-mask-probe')
  const probePath = path.join(probeDir, 'probe.js')
  const resultPath = path.join(probeDir, 'result.json')
  fs.mkdirSync(probeDir, { recursive: true })
  fs.rmSync(resultPath, { force: true })
  fs.writeFileSync(probePath, PROBE_SOURCE)

  // ELECTRON_RUN_AS_NODE would start Electron as plain node (see AGENTS/plan §16.3).
  const env = {
    ...process.env,
    ELECTRON_ENABLE_LOGGING: '0',
    MASK_PROBE_ROOT: root,
    MASK_PROBE_RESULT: resultPath
  }
  delete env.ELECTRON_RUN_AS_NODE

  const result = spawnSync(require('electron'), [probePath], {
    cwd: root,
    encoding: 'utf8',
    timeout: 110000,
    windowsHide: true,
    env
  })
  assert.equal(
    result.status,
    0,
    `occlusion mask probe failed.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  )
  assert.equal(fs.existsSync(resultPath), true, 'the probe did not write its result file')
  const report = JSON.parse(fs.readFileSync(resultPath, 'utf8'))
  assert.equal(report.ok, true, `probe error: ${report.error}`)
  assert.deepEqual(report.consoles.filter((text) => /render-error/i.test(text)), [])

  // The shared modules really loaded in the window (a missing <script> would make every mask a
  // silent no-op - that is the "looks fine, protects nothing" failure mode this guards).
  assert.equal(report.hasMaskModule, true, 'shared/occlusion-mask.js must be loaded by capture.html')
  assert.equal(report.hasCompositor, true, 'capture/output-compositor.js must be loaded by capture.html')

  // The plan the renderer builds for this document covers exactly the mosaic rectangle (plus the
  // conservative margin), and nothing else.
  assert.equal(report.plan.plan.masked, true, 'a blur annotation must produce a mask plan')
  assert.equal(report.plan.occluders.length, 1, 'only the blur object is an occluder')
  const op = report.plan.plan.ops[0]
  assert.equal(op.kind, 'rect')
  const margin = 2 // shared/occlusion-mask.js CONSERVATIVE_MARGIN_PX
  assert.ok(
    Math.abs(op.x - (BLUR_RECT.x - margin)) <= 1 && Math.abs(op.y - (BLUR_RECT.y - margin)) <= 1,
    `the mask op must start at the blur rect minus the conservative margin (got ${op.x},${op.y})`
  )
  assert.ok(
    Math.abs(op.w - (BLUR_RECT.w + margin * 2)) <= 2 && Math.abs(op.h - (BLUR_RECT.h + margin * 2)) <= 2,
    `the mask op must cover the blur rect plus the margin (got ${op.w}x${op.h})`
  )

  const recognition = report.recognition
  const plain = report.plain
  assert.equal(recognition.width, report.imageSize.width, 'the recognition input is the crop, pixel for pixel')
  assert.equal(recognition.height, report.imageSize.height)
  assert.equal(plain.width, report.imageSize.width, 'both frames come from the same selection')
  assert.equal(plain.height, report.imageSize.height)

  // ① THE FIX ITSELF: every pixel of the mosaic area is opaque black in the recognition input.
  // Compare with the same area in the unmasked frame, where the secret block is real content.
  const maskedPixels = countWithin(recognition, BLUR_RECT, isOpaqueBlack)
  const blurArea = BLUR_RECT.w * BLUR_RECT.h
  assert.ok(
    maskedPixels >= blurArea * 0.98,
    `the mosaic area must be opaque black for the model (only ${maskedPixels}/${blurArea} pixels masked)`
  )
  const secretInPlain = countWithin(plain, SECRET_RECT, isOpaqueBlack)
  assert.ok(
    secretInPlain >= SECRET_RECT.w * SECRET_RECT.h * 0.9,
    'the synthetic secret block must really be dark content in the unmasked frame (otherwise the mask assertion is vacuous)'
  )
  // ② The mask is confined to what the document says is covered: outside the mosaic area the
  // recognition input equals the plain crop (no accidental full-image black-out).
  const outsideRect = { x: 0, y: 0, w: report.imageSize.width, h: BLUR_RECT.y - 4 }
  let outsideDiffs = 0
  for (let y = 0; y < outsideRect.h; y += 1) {
    for (let x = 0; x < outsideRect.w; x += 1) {
      const a = pixelAt(recognition, x, y)
      const b = pixelAt(plain, x, y)
      if (a.r !== b.r || a.g !== b.g || a.b !== b.b || a.a !== b.a) outsideDiffs += 1
    }
  }
  assert.equal(outsideDiffs, 0, `the mask must not touch pixels outside the mosaic area (changed ${outsideDiffs})`)

  // ③ includeAnnotations=false still holds on the recognition path: the annotation rect at the
  // bottom of the stage is solid red in the user-facing export and absent from the model's input.
  const annotationRect = { x: 60, y: 480, w: 240, h: 80 }
  const isReddish = (pixel) => pixel.r > 180 && pixel.g < 90 && pixel.b < 90
  assert.ok(
    countWithin(report.userFacing, annotationRect, isReddish) > 4000,
    'the ordinary export must contain the user annotation'
  )
  assert.equal(
    countWithin(recognition, annotationRect, isReddish),
    0,
    'the recognition input must never contain an ordinary user annotation'
  )
  assert.equal(
    countWithin(plain, annotationRect, isReddish),
    0,
    'any recognition-shaped frame (annotations off) must exclude the annotation regardless of masking'
  )

  // ④ A card preset must not decorate a recognition input. The user-facing export with compose:true
  // gains the card (padding + background), the recognition input keeps the crop size and the mask.
  assert.ok(
    report.userFacingWithCardPreset.width > report.userFacing.width,
    `compose:true must produce the card-sized canvas (got ${report.userFacingWithCardPreset.width} vs ${report.userFacing.width})`
  )
  assert.equal(
    report.recognitionWithCardPreset.width,
    report.imageSize.width,
    'the recognition input must keep the crop width even while a card preset is selected'
  )
  const cardMaskedPixels = countWithin(report.recognitionWithCardPreset, BLUR_RECT, isOpaqueBlack)
  assert.ok(
    cardMaskedPixels >= blurArea * 0.98,
    'the mask must still be applied while a card preset is selected'
  )
})
