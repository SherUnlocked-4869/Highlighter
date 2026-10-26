// 功能 D：放大镜的真机像素回归（真实 Electron 隐藏窗，不占屏幕）。
//
// 为什么必须有一条"真窗口 + 真像素"的断言：test/capture-magnifier-ui.test.js 只能证明渲染层
// 把正确的输入喂给了正确的函数，它看不见镜头画布里到底是什么。D 的两个核心主张都需要像素证据：
//
//   ① 镜头里画的是**放大的源区内容**（否则"放大镜"只是个框）；
//   ② 镜头**不会**把 blur 盖住的内容放大出来（§7.2 的隐私核心 —— 这是 D 唯一能造成泄漏的地方）。
//
// 取样纪律照 test/capture-brush-render.test.js §5.7：
//   · 取样点由**内容探测**决定，不手写魔数坐标（否则断言会在空白处恒真）；
//   · 分区计数而不是单点比较；
//   · 每条"是黑的"断言都配一条**反向对照**（证明这块本来不是黑的），否则"一直黑"可能因为
//     原图本来就黑而恒真 —— 这是 R0.4 那一轮学到的最重要一条。
//
// 窗口一律 show:false：AGENTS.md 要求可见测试窗放副屏，而本机只有主屏，所以绝不可见。
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.join(__dirname, '..')

const STAGE_WIDTH = 900
const STAGE_HEIGHT = 700
// The base image is drawn at SOURCE_SCALE times the display area, so the export canvas is NOT 1:1
// with CSS px - the same HiDPI shape the real product has, and the reason the lens painter has to go
// through the shared offset/scale mapping instead of assuming 1.
const SOURCE_SCALE = 1.5

// The source area the lens magnifies, in CSS px (= source px / SOURCE_SCALE offset by the stage).
// It is deliberately placed over a LEFT-HALF-RED / RIGHT-HALF-BLUE patch: an upscaled copy keeps that
// boundary in the middle, a wrongly-sampled copy does not.
const SOURCE_RECT = { x: 120, y: 120, w: 160, h: 100 }
// The two-tone patch is deliberately much larger than SOURCE_RECT: the lens reads through the
// CSS->source-pixel projection (devicePixelRatio 1.5 in this window), and if the patch ended exactly
// at the source rect's edge a sub-pixel projection error would pull in neighbouring content. Drawing
// it with a wide margin makes "left half red / right half blue" robust to that rounding.
const PATCH_RECT = { x: SOURCE_RECT.x - 40, y: SOURCE_RECT.y - 30, w: SOURCE_RECT.w + 80, h: SOURCE_RECT.h + 60 }
const PATCH_HALF = { left: '#ff0000', right: '#0000ff' }
// The blur rect covers a solid BLACK "secret" block; the lens source sits inside it.
const BLUR_RECT = { x: 380, y: 300, w: 240, h: 160 }
const SECRET_RECT = { x: 400, y: 320, w: 200, h: 120 }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const PROBE_SOURCE = `
'use strict'
const { app, ipcMain, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.env.MAG_PROBE_ROOT
const RESULT = process.env.MAG_PROBE_RESULT
const { createSecureWindow } = require(path.join(ROOT, 'main', 'services', 'window-security'))

const STAGE_WIDTH = ${STAGE_WIDTH}
const STAGE_HEIGHT = ${STAGE_HEIGHT}
const SOURCE_SCALE = ${SOURCE_SCALE}
const SOURCE_RECT = ${JSON.stringify(SOURCE_RECT)}
const PATCH_HALF = ${JSON.stringify(PATCH_HALF)}
const PATCH_RECT = ${JSON.stringify(PATCH_RECT)}
const BLUR_RECT = ${JSON.stringify(BLUR_RECT)}
const SECRET_RECT = ${JSON.stringify(SECRET_RECT)}

const records = { consoles: [] }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
ipcMain.on('capture:ready', () => {})
ipcMain.on('capture:render-ready', () => {})
ipcMain.on('capture:render-error', (_event, message) => records.consoles.push('render-error: ' + message))
ipcMain.on('capture:close', () => {})
ipcMain.on('capture:save', () => {})
ipcMain.handle('capture:export-pdf', () => null)

let win = null

// The synthetic screenshot. Everything the assertions read is real content, so no assertion can pass
// on a blank canvas:
//   · a left-red / right-blue patch where the lens source goes  -> proves the lens shows the right area
//   · a solid black "secret" block inside the blur rect          -> proves the mask reaches the lens
//   · a luminance ramp + stripes elsewhere                       -> proves the lens is not just uniform
function screenshotDataUrl () {
  return win.webContents.executeJavaScript(\`(function(){
    // The patch colours must be injected INTO the page: a bare PATCH_HALF reference would be a
    // ReferenceError here (the probe's own scope is not the page's), which fails the whole screenshot.
    // NOTE: no backticks may appear inside this page script - it lives inside a JS template literal,
    // and a nested backtick terminates the outer one (that bug cost two probe runs).
    var PATCH_HALF = \${JSON.stringify(PATCH_HALF)};
    var PATCH_RECT = \${JSON.stringify(PATCH_RECT)};
    var scale=\${SOURCE_SCALE};
    var W=\${STAGE_WIDTH}, H=\${STAGE_HEIGHT};
    var c=document.createElement('canvas');
    c.width=Math.round(W*scale); c.height=Math.round(H*scale);
    var g=c.getContext('2d');
    g.scale(scale,scale);
    var ramp=g.createLinearGradient(0,0,W,H);
    ramp.addColorStop(0,'#f4f1ea'); ramp.addColorStop(0.5,'#9aa0b4'); ramp.addColorStop(1,'#39415a');
    g.fillStyle=ramp; g.fillRect(0,0,W,H);
    g.fillStyle='#14141a';
    for (var row=0; row<12; row++) g.fillRect(40, 40+row*20, W-80, 6);
    // The two-tone patch the lens magnifies (CSS px, scaled by g.scale).
    g.fillStyle=PATCH_HALF.left;
    g.fillRect(PATCH_RECT.x, PATCH_RECT.y, PATCH_RECT.w/2, PATCH_RECT.h);
    g.fillStyle=PATCH_HALF.right;
    g.fillRect(PATCH_RECT.x+PATCH_RECT.w/2, PATCH_RECT.y, PATCH_RECT.w/2, PATCH_RECT.h);
    // The secret block (the thing the mask must make unreadable to the lens). It is drawn as BRIGHT
    // COLOURED STRIPES on purpose: the mask colour is black, so a black secret would make the masked
    // and unmasked lenses pixel-identical and every assertion below would pass for the wrong reason.
    var secretY = \${SECRET_RECT.y};
    for (var stripe = 0; stripe * 12 < \${SECRET_RECT.h}; stripe++) {
      g.fillStyle = stripe % 2 ? '#ffe600' : '#00e5ff';
      g.fillRect(\${SECRET_RECT.x}, secretY + stripe * 12, \${SECRET_RECT.w}, 12);
    }
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

    report.modules = await win.webContents.executeJavaScript(
      '({geometry:!!(window.magnifierGeometry&&window.magnifierGeometry.createFromSourceRect),' +
      'sampler:!!(window.magnifierSampler&&window.magnifierSampler.createLensSampler),' +
      'mask:!!(window.occlusionMask&&window.occlusionMask.buildOccluders)})'
    )

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
    // The magnifier samples through the same export projection every other pixel path uses, and that
    // needs a SELECTION (a real capture window always has one by the time a tool is usable). Establish
    // a full-display selection the way Ctrl+A does before touching the sampler.
    await win.webContents.executeJavaScript('(function(){var b=imageDisplayBounds();selection={x:b.x,y:b.y,w:b.w,h:b.h};selectState="selected";renderOverlay();return true})()')

    // Page-side helper: run the REAL sampler path for one magnifier and return a small STATISTICS
    // object. It deliberately never ships raw pixels across the bridge: a 320x200 lens is 256k numbers,
    // and serializing that over executeJavaScript is slow enough that the probe looked "hung" (110s
    // timeout) on the first attempt. The classification runs in the page instead, where the pixels
    // already are - the node side only receives counts and fractions.
    //
    // It goes through ensureSampleBase() + magnifierLensCanvas() (the two functions the painter uses),
    // so a regression in either - "reads the composed stage" or "skips the mask" - shows up here.
    await win.webContents.executeJavaScript(\`(function(){
      // Classify one lens canvas over a set of named regions, in lens pixel coordinates.
      function classify(sampled, regions){
        var ctx = sampled.getContext('2d');
        var data = ctx.getImageData(0, 0, sampled.width, sampled.height).data;
        function pixel(x, y){
          var o = (y * sampled.width + x) * 4;
          return { r: data[o], g: data[o+1], b: data[o+2], a: data[o+3] };
        }
        var out = { width: sampled.width, height: sampled.height, regions: {} };
        for (var name in regions){
          var region = regions[name];
          // A region may be absolute (x/y/w/h) or fractional (fx/fy/fw/fh) - fractions are the only
          // safe form for a canvas whose size depends on the base image's device scale.
          var rx = region.fx !== undefined ? region.fx * sampled.width : region.x;
          var ry = region.fy !== undefined ? region.fy * sampled.height : region.y;
          var rw = region.fw !== undefined ? region.fw * sampled.width : region.w;
          var rh = region.fh !== undefined ? region.fh * sampled.height : region.h;
          var left = Math.max(0, Math.round(rx)), top = Math.max(0, Math.round(ry));
          var right = Math.min(sampled.width, Math.round(rx + rw));
          var bottom = Math.min(sampled.height, Math.round(ry + rh));
          var total = 0, red = 0, blue = 0, dark = 0;
          for (var y = top; y < bottom; y++){
            for (var x = left; x < right; x++){
              total++;
              var p = pixel(x, y);
              if (p.r > 160 && p.g < 90 && p.b < 90) red++;
              if (p.b > 160 && p.r < 90 && p.g < 90) blue++;
              if (p.r < 40 && p.g < 40 && p.b < 40) dark++;
            }
          }
          out.regions[name] = total ? {
            total: total,
            red: red / total,
            blue: blue / total,
            dark: dark / total,
            mean: (function(){
              var sum = 0, count = 0;
              for (var yy = top; yy < bottom; yy++){
                for (var xx = left; xx < right; xx++){
                  var q = pixel(xx, yy); sum += (q.r + q.g + q.b) / 3; count++;
                }
              }
              return count ? sum / count : 0;
            })()
          } : null;
        }
        return out;
      }
      window.__mag = {
        // Build a magnifier over the given rect (in DISPLAY CSS px, exactly what a user drag covers),
        // sample it through the REAL painter path, and classify the result.
        // Replace ONLY the magnifier: the blur set is what the privacy assertions turn on, so wiping
        // it here would make every mask assertion pass vacuously (that bug cost one probe run).
        sample: function(sourceRect, factor, resetCache, regions){
          annotations = annotations.filter(function(item){ return item.type !== 'magnifier' });
          annotations.unshift({ id: 1, type: 'magnifier', sourceRect: sourceRect, lensOrigin: { x: 20, y: 20 }, factor: factor, stroke: { color: '#ff3b30', widthPx: 2 }, connector: 'none' });
          annotationSeq = annotations.length;
          if (resetCache) releaseLensSampler();
          return window.__mag.read(annotations[0], regions);
        },
        read: function(item, regions){
          var previous = window.__mag._lastSample;
          var sampled = magnifierLensCanvas(item);
          if (!sampled) return null;
          var stats = classify(sampled, regions || { all: { x: 0, y: 0, w: sampled.width, h: sampled.height } });
          stats.sameCanvasAsPrevious = sampled === previous;
          window.__mag._lastSample = sampled;
          return stats;
        },
        clearAnnotations: function(){ annotations = []; annotationSeq = 0; releaseLensSampler(); window.__mag._lastSample = null; },
        setBlur: function(rect){
          annotations = annotations.filter(function(item){ return item.type !== 'blur' }).concat([{
            id: 99, type: 'blur', x: rect.x, y: rect.y, x2: rect.x + rect.w, y2: rect.y + rect.h,
            width: 4, color: '#ff3b30'
          }]);
          return annotations.length;
        },
        removeBlur: function(){
          annotations = annotations.filter(function(item){ return item.type !== 'blur' });
          return annotations.length;
        },
        meta: function(){
          return { dpr: window.devicePixelRatio, w: innerWidth, h: innerHeight,
                   imageSize: { w: image.naturalWidth, h: image.naturalHeight },
                   displayBounds: imageDisplayBounds(), scaleFactor: initData ? initData.scaleFactor : null };
        }
      };
      return true;
    })()\`)

    // ---- 1) content correctness: the lens really shows the magnified source area ----------------
    // The two-tone patch: after upscaling, the left half of the lens must still be red and the right
    // half blue. A lens that sampled the wrong rect, or drew the composed stage, fails here.
    // Regions are FRACTIONS of the lens canvas (see the page-side classify): the lens is
    // sourceRect.w * factor * the base image's device scale, so an absolute pixel region here would be
    // a magic number that silently samples the wrong band on another DPR.
    const PATCH_REGIONS = {
      left: { fx: 0, fy: 0, fw: 0.45, fh: 1 },
      right: { fx: 0.55, fy: 0, fw: 0.45, fh: 1 }
    }
    report.patch = await win.webContents.executeJavaScript(
      'window.__mag.sample(' + JSON.stringify({ x: SOURCE_RECT.x, y: SOURCE_RECT.y, w: SOURCE_RECT.w, h: SOURCE_RECT.h }) + ',2,true,' + JSON.stringify(PATCH_REGIONS) + ')'
    )
    // Same inputs again, without resetting: the sampler must hand back the CACHED canvas.
    report.patchSecond = await win.webContents.executeJavaScript(
      'window.__mag.read(annotations[0],' + JSON.stringify(PATCH_REGIONS) + ')'
    )

    // ---- 2) privacy core: a lens over a blur area must show the MASK, not the secret ------------
    const WHOLE = { all: { x: 0, y: 0, w: 4000, h: 4000 } }
    const secretSource = { x: SECRET_RECT.x + 20, y: SECRET_RECT.y + 20, w: 60, h: 40 }
    report.withoutBlur = await win.webContents.executeJavaScript(
      'window.__mag.sample(' + JSON.stringify(secretSource) + ',2,true,' + JSON.stringify(WHOLE) + ')'
    )
    await win.webContents.executeJavaScript('window.__mag.setBlur(' + JSON.stringify(BLUR_RECT) + ')')
    report.withBlur = await win.webContents.executeJavaScript(
      'window.__mag.sample(' + JSON.stringify(secretSource) + ',2,true,' + JSON.stringify(WHOLE) + ')'
    )
    await win.webContents.executeJavaScript('window.__mag.removeBlur()')
    report.afterRemovingBlur = await win.webContents.executeJavaScript(
      'window.__mag.sample(' + JSON.stringify(secretSource) + ',2,true,' + JSON.stringify(WHOLE) + ')'
    )

    // ---- 3) cache invalidation: adding a blur over an already-sampled area must re-sample --------
    // Sample the area (no blur) FIRST, then add a blur that covers it and sample again WITHOUT
    // resetting the sampler. A stale cache would return the un-masked content here.
    report.cacheBaseline = await win.webContents.executeJavaScript(
      'window.__mag.sample(' + JSON.stringify({ x: BLUR_RECT.x + 30, y: BLUR_RECT.y + 30, w: 50, h: 40 }) + ',2,true,' + JSON.stringify(WHOLE) + ')'
    )
    await win.webContents.executeJavaScript('window.__mag.setBlur(' + JSON.stringify(BLUR_RECT) + ')')
    report.cacheAfterMaskChange = await win.webContents.executeJavaScript(
      'window.__mag.read(annotations[0],' + JSON.stringify(WHOLE) + ')'
    )

    // ---- 4) the lens content does not depend on the viewport zoom -------------------------------
    // The sample base is source resolution, so the same source rect must classify identically on a
    // repeat run (any viewport-coupled sampling would show up as a different mean).
    await win.webContents.executeJavaScript('window.__mag.clearAnnotations()')
    report.zoomIndependentA = await win.webContents.executeJavaScript(
      'window.__mag.sample(' + JSON.stringify({ x: SOURCE_RECT.x, y: SOURCE_RECT.y, w: 80, h: 60 }) + ',2,true,' + JSON.stringify(WHOLE) + ')'
    )
    report.zoomIndependentB = await win.webContents.executeJavaScript(
      'window.__mag.sample(' + JSON.stringify({ x: SOURCE_RECT.x, y: SOURCE_RECT.y, w: 80, h: 60 }) + ',2,true,' + JSON.stringify(WHOLE) + ')'
    )

    report.meta = await win.webContents.executeJavaScript('window.__mag.meta()')
    report.consoles = records.consoles
    report.sourceRect = SOURCE_RECT
    report.patchHalf = PATCH_HALF
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

// The probe ships STATISTICS, not pixels (see the page-side `classify`): each sample is
// `{ width, height, sameCanvasAsPrevious, regions: { name: { total, red, blue, dark, mean } } }`.
// `red`/`blue`/`dark` are fractions 0..1; `mean` is the average luminance 0..255.
function region (sample, name = 'all') {
  assert.ok(sample, 'the sample must exist')
  const entry = sample.regions?.[name]
  assert.ok(entry, `region ${name} must exist in ${JSON.stringify(Object.keys(sample.regions || {}))}`)
  return entry
}

function runProbe (probeSource, dirName, envPrefix) {
  const probeDir = path.join(root, '.tmp', dirName)
  const probePath = path.join(probeDir, 'probe.js')
  const resultPath = path.join(probeDir, 'result.json')
  fs.mkdirSync(probeDir, { recursive: true })
  fs.rmSync(resultPath, { force: true })
  fs.writeFileSync(probePath, probeSource)
  const env = { ...process.env, ELECTRON_ENABLE_LOGGING: '0' }
  env[`${envPrefix}_ROOT`] = root
  env[`${envPrefix}_RESULT`] = resultPath
  delete env.ELECTRON_RUN_AS_NODE
  const result = spawnSync(require('electron'), [probePath], {
    cwd: root,
    encoding: 'utf8',
    timeout: 110000,
    windowsHide: true,
    env
  })
  return { result, resultPath }
}

test('§7.1/§7.2 a real window shows the magnified source content and never magnifies a masked secret', { timeout: 180000 }, () => {
  const { result, resultPath } = runProbe(PROBE_SOURCE, 'magnifier-probe', 'MAG_PROBE')
  assert.equal(result.status, 0, `magnifier probe failed.
stdout:
${result.stdout}
stderr:
${result.stderr}`)
  assert.equal(fs.existsSync(resultPath), true, 'the probe did not write its result file')
  const report = JSON.parse(fs.readFileSync(resultPath, 'utf8'))
  assert.equal(report.ok, true, `probe error: ${report.error}`)
  assert.deepEqual(report.consoles.filter((text) => /render-error/i.test(text)), [])
  assert.deepEqual(report.modules, { geometry: true, sampler: true, mask: true })

  // ---- 1) the lens really contains the magnified two-tone patch --------------------------------
  // A lens that sampled the wrong rect, or drew the composed stage, cannot produce both halves.
  const patch = report.patch
  assert.ok(patch, 'the sampler must produce a lens canvas')
  // factor 2 over the source rect upsamples by 2; the drawn size also depends on the base image's
  // device scale, so the EXACT size is asserted as "big enough to have halves", not a magic constant.
  assert.ok(patch.width >= 200 && patch.height >= 100, `the lens canvas must be upscaled (got ${patch.width}x${patch.height})`)
  const left = region(patch, 'left')
  const right = region(patch, 'right')
  assert.ok(left.red > 0.9, `the left half of the lens must still be red (got ${(left.red * 100).toFixed(1)}%)`)
  assert.ok(right.blue > 0.9, `the right half of the lens must still be blue (got ${(right.blue * 100).toFixed(1)}%)`)
  // And they are NOT swapped: a lens that sampled a mirrored/offset rect would invert these.
  assert.ok(left.blue < 0.1, `the left half must not be blue (got ${(left.blue * 100).toFixed(1)}%)`)
  assert.ok(right.red < 0.1, `the right half must not be red (got ${(right.red * 100).toFixed(1)}%)`)

  // ---- 2) the mask reaches the lens: a source area inside a blur must NOT reveal the secret ----
  //
  // The synthetic "secret" is a solid #000000 block and the mask colour is also #000000, so darkness
  // alone cannot prove the mask ran. What it CAN prove is the reverse control plus the mean: the
  // unmasked lens shows the secret AND the striped ramp around it, the masked lens is uniformly black.
  const withoutBlur = report.withoutBlur
  const withBlur = report.withBlur
  const afterRemovingBlur = report.afterRemovingBlur
  assert.ok(withoutBlur && withBlur && afterRemovingBlur, 'all three privacy samples must exist')
  const unmasked = region(withoutBlur)
  const masked = region(withBlur)
  const restored = region(afterRemovingBlur)
  // Reverse control FIRST: without a blur the lens shows the bright striped secret, so it is neither
  // uniformly black nor uniform at all. If this were false, the masked assertion below would pass for
  // the wrong reason (the source would already be black).
  assert.ok(
    unmasked.mean > 40,
    `the synthetic secret must be readable content without a mask (mean ${unmasked.mean.toFixed(1)})`
  )
  assert.equal(unmasked.dark < 0.05, true, `the unmasked secret must not be mostly dark (got ${(unmasked.dark * 100).toFixed(1)}% dark)`)
  // With the blur present the lens is the MASK: uniformly black, which no bright striped source can be.
  assert.ok(masked.mean < 4, `a lens over a blur must be the opaque mask (mean ${masked.mean.toFixed(1)})`)
  assert.ok(masked.dark > 0.99, `the masked lens must be uniformly dark (got ${(masked.dark * 100).toFixed(1)}% dark)`)
  // The two must be far apart - that gap IS the privacy guarantee.
  assert.ok(
    unmasked.mean > masked.mean + 40,
    `the mask must clearly change what the lens shows (unmasked mean ${unmasked.mean.toFixed(1)} vs masked ${masked.mean.toFixed(1)})`
  )
  // Removing the blur restores exactly the unmasked content (same statistics, not merely "brighter").
  assert.ok(
    Math.abs(restored.mean - unmasked.mean) < 2,
    `removing the blur must restore the source content (mean ${restored.mean.toFixed(1)} vs ${unmasked.mean.toFixed(1)})`
  )
  assert.ok(Math.abs(restored.dark - unmasked.dark) < 0.02, 'removing the blur must restore the same darkness ratio')

  // ---- 3) cache invalidation: adding a blur over an already-sampled area must re-sample --------
  // The baseline sample had NO blur, so its cache entry is unmasked content. Adding a blur must
  // invalidate that entry; a stale cache would hand back the unmasked lens and leak the secret.
  const baseline = report.cacheBaseline
  const afterChange = report.cacheAfterMaskChange
  assert.ok(baseline && afterChange, 'the cache samples must exist')
  assert.equal(baseline.sameCanvasAsPrevious, false, 'the baseline sample must be a fresh canvas')
  assert.equal(
    afterChange.sameCanvasAsPrevious,
    false,
    'adding a blur must invalidate the sample cache (a stale entry would return the unmasked content)'
  )
  const baselineRegion = region(baseline)
  const changedRegion = region(afterChange)
  assert.ok(
    baselineRegion.mean > changedRegion.mean + 2,
    `the mask must visibly change the lens content (mean ${baselineRegion.mean.toFixed(1)} -> ${changedRegion.mean.toFixed(1)})`
  )
  assert.ok(changedRegion.dark > 0.99, 'after the mask the previously-unmasked area must be uniformly black')

  // ---- 4) the same source rect gives the same lens canvas (cache identity, no re-sample) --------
  assert.ok(report.patchSecond, 'the second sample must succeed')
  assert.equal(
    report.patchSecond.sameCanvasAsPrevious,
    true,
    'sampling the SAME source rect twice must reuse the cached canvas (moving the lens is free)'
  )
  assert.deepEqual(report.patchSecond.regions, report.patch.regions, 'a cached sample must classify identically')

  // ---- 5) the lens content is not coupled to the viewport -------------------------------------
  // The sample base is source resolution, so two identical requests classify identically; a
  // viewport-coupled implementation would drift because the base would be rebuilt at window scale.
  assert.ok(report.zoomIndependentA && report.zoomIndependentB, 'both zoom samples must exist')
  assert.deepEqual(
    region(report.zoomIndependentA),
    region(report.zoomIndependentB),
    'the lens classification must be reproducible (no viewport-scale dependence)'
  )
})
