const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.join(__dirname, '..')

// P0-1-T4 / S11: the marked-element counts the live DOM must end up with, straight from the
// markup, so the runtime check is an exact equality instead of a magic minimum.
const captureMarkup = fs.readFileSync(path.join(root, 'capture', 'capture.html'), 'utf8')
const expectedTextMarkers = (captureMarkup.match(/data-i18n="/g) || []).length
const expectedAttributeMarkers = (captureMarkup.match(/data-i18n-(?:title|aria-label|placeholder)="/g) || []).length

// A real capture.html in a real (hidden) Electron window, driven through the same
// preload the production capture window uses. The init payload is produced by the
// real main-process domain shape, so this covers P0-4-T7② (export PDF), P0-7-T4
// (saveMode), T5 (shutter sound + autoplay + CSP), T6 (Ctrl+A) and T7 (serial).
const PROBE_SOURCE = `
'use strict'
const { app, ipcMain, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.env.W2_PROBE_ROOT
const RESULT = process.env.W2_PROBE_RESULT
const { createSecureWindow } = require(path.join(ROOT, 'main', 'services', 'window-security'))
const { readPngSize } = require(path.join(ROOT, 'main', 'services', 'capture-geometry'))

const records = { saves: [], pdfs: [], consoles: [], renders: 0, closeRequests: 0, closes: [] }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

ipcMain.on('capture:ready', () => {})
ipcMain.on('capture:render-ready', () => { records.renders++ })
ipcMain.on('capture:render-error', (_event, message) => records.consoles.push('render-error: ' + message))
ipcMain.on('capture:close', (_event, payload) => {
  records.closeRequests++
  records.closes.push(payload || null)
})
ipcMain.on('capture:save', (_event, payload) => {
  const buffer = payload && payload.imageBuffer
  records.saves.push({ fast: payload ? payload.fast : null, bytes: buffer ? buffer.byteLength : 0, meta: payload ? payload.meta : null })
})
ipcMain.handle('capture:export-pdf', (_event, payload) => {
  const buffer = payload && payload.imageBuffer
  records.pdfs.push({ mode: payload ? payload.mode : null, bytes: buffer ? buffer.byteLength : 0, meta: payload ? payload.meta : null })
  return null
})

const png = fs.readFileSync(path.join(ROOT, 'assets', 'icon.png'))
const pngSize = readPngSize(png)

function makeInit (options) {
  const opts = options || {}
  const screenshot = Object.assign({
    shutterSound: true,
    fastSave: false,
    annotationWidth: 4,
    watermark: {}
  }, opts.screenshot || {})
  return {
    imageBuffer: png,
    mode: 'region',
    autoAction: '',
    source: 'region',
    displayBounds: opts.displayBounds || { x: 0, y: 0, width: 800, height: 600 },
    captureBounds: opts.captureBounds || { x: 0, y: 0, width: 800, height: 600 },
    imageBounds: null,
    scaleFactor: opts.scaleFactor === undefined ? 1 : opts.scaleFactor,
    editPin: false,
    smartSelect: false,
    cursorPosition: { x: 0, y: 0 },
    saveMode: opts.saveMode || '',
    // P0-2 (S9b): the real domain always ships the key; the switch off value is null.
    cursor: opts.cursor || null,
    serialNumber: opts.serialNumber === undefined ? 1 : opts.serialNumber,
    settings: { mainColor: '#e5a44c', screenshot: screenshot, ocr: {} }
  }
}

async function sendInit (win, payload) {
  // Wait for BOTH the renderer's own onInit to run and its new image to decode;
  // checking image.complete alone would race with the previous init's image.
  const previousInits = await win.webContents.executeJavaScript('window.__probe.inits')
  const previousSrc = await win.webContents.executeJavaScript('(image&&image.src)||""')
  win.webContents.send('capture:init', payload)
  for (let attempt = 0; attempt < 80; attempt++) {
    const state = await win.webContents.executeJavaScript(
      '({inits:window.__probe.inits,src:(image&&image.src)||"",loaded:!!(image&&image.complete&&image.naturalWidth>0)})'
    )
    if (state.inits > previousInits && state.loaded && state.src && state.src !== previousSrc) return
    await sleep(50)
  }
  throw new Error('the renderer never observed the capture:init payload')
}

// P0-2 (S9b) helper: export the current selection and hand back raw pixels so the
// node side can do the arithmetic (hotspot alignment, cropping, diff) itself.
const PAGE_HELPERS = [
  '(function(){',
  'function sourceRect(){return getSourcePixelRect(selection,imageDisplayBounds(),{width:image.naturalWidth,height:image.naturalHeight})}',
  'function pixels(includeAnnotations){var out=exportSelectionCanvas(includeAnnotations!==false);var ctx=out.getContext("2d");var data=ctx.getImageData(0,0,out.width,out.height);return {width:out.width,height:out.height,data:Array.prototype.slice.call(data.data)}}',
  'window.__s9b={',
  'setSelection:function(x,y,w,h){selection={x:x,y:y,w:w,h:h};return sourceRect()},',
  'sourceRect:sourceRect,',
  'pixels:pixels,',
  'withCursor:function(value,includeAnnotations){var saved=initData?initData.cursor:null;if(initData)initData.cursor=value;var result=pixels(includeAnnotations);if(initData)initData.cursor=saved;return result},',
  'state:function(){return {cursorImage:!!cursorImage,decoded:!!(cursorImage&&cursorImage.complete&&cursorImage.naturalWidth>0),initCursor:initData?initData.cursor:null,scaleFactor:initData?initData.scaleFactor:null,captureBounds:initData?initData.captureBounds:null,imageSize:{width:image.naturalWidth,height:image.naturalHeight},displayBounds:imageDisplayBounds(),selection:selection,source:sourceRect()}}',
  '};',
  // P0-1-T4 / S11: read the rendered zh-CN wording out of the real DOM, then drive the
  // same hot switch the settings effect broadcasts, then restore zh-CN so the probe leaves
  // the profile (and localStorage) where it found it.
  'window.__s9b.i18n=function(){',
  'setLanguage("zh-CN");applyTranslations();',
  'var markers=document.querySelectorAll("[data-i18n]");var emptyText=0;',
  'for(var i=0;i<markers.length;i++)if(!markers[i].textContent)emptyText++;',
  'function countMarked(selector,attribute){var list=document.querySelectorAll(selector);var empty=0;',
  'for(var k=0;k<list.length;k++)if(!list[k].getAttribute(attribute))empty++;return {total:list.length,empty:empty};}',
  'var byTitle=countMarked("[data-i18n-title]","title"),byAria=countMarked("[data-i18n-aria-label]","aria-label"),byPlaceholder=countMarked("[data-i18n-placeholder]","placeholder");',
  'var attrMarkers=byTitle.total+byAria.total+byPlaceholder.total;var emptyAttr=byTitle.empty+byAria.empty+byPlaceholder.empty;',
  'var zh={title:document.title,recordTitle:document.getElementById("record").getAttribute("title"),exportTitle:document.getElementById("exportPdf").getAttribute("title"),frontAria:document.getElementById("elementFront").getAttribute("aria-label"),watermarkPlaceholder:document.getElementById("watermarkContent").getAttribute("placeholder"),thin:document.querySelectorAll("[data-annotation-width]")[0].textContent,markers:markers.length,emptyText:emptyText,attrMarkers:attrMarkers,emptyAttr:emptyAttr};',
  'setLanguage("en-US");applyTranslations();',
  'var en={title:document.title,recordTitle:document.getElementById("record").getAttribute("title"),thin:document.querySelectorAll("[data-annotation-width]")[0].textContent};',
  'setLanguage("zh-CN");applyTranslations();',
  'return {before:zh,after:en};',
  '};',
  'return true})()'
].join('')

// OCR 评审修复（High）的两条渲染层回归：都在真实窗口里跑真实交互路径。
const PR_HELPERS = [
  '(function(){',
  'window.__pr={',
  // G1：待提交的方向键微调必须先在 Ctrl+Z 之前独立成帧 —— 否则一次撤销会同时丢掉微调
  // 并回退上一个已提交操作（标注整个消失）。
  'nudgeUndo:function(){',
  'annotations=[{type:"rect",id:1,x:200,y:200,x2:260,y2:240,color:"#f00",width:4}];',
  'annotationSeq=1;annotationHistory=[[]];historyIndex=0;snapshotAnnotations();',
  'setSelectedAnnotation(annotations[0]);',
  'nudgeSelectedAnnotation({key:"ArrowRight",preventDefault:function(){},shiftKey:false});',
  'var afterNudge=annotations.length?annotations[0].x:null;',
  'document.dispatchEvent(new KeyboardEvent("keydown",{key:"z",ctrlKey:true,bubbles:true}));',
  'return {afterNudge:afterNudge,count:annotations.length,x:annotations.length?annotations[0].x:null};',
  '},',
  // G2：水印的 bounds 按设计等于选区，浮动条不得压在工具栏上（z-index 更高会挡住按钮）。
  'elementBarOverlap:function(){',
  'selection={x:100,y:100,w:300,h:200};',
  'annotations=[{type:"watermark",id:2,x:100,y:100,w:300,h:200,content:"w",opacity:10,color:"#fff",spacing:15,fontSize:24,rotation:30,dateSuffix:false}];',
  'setSelectedAnnotation(annotations[0]);renderOverlay();',
  'var bar=document.getElementById("elementBar").getBoundingClientRect();',
  'var tb=document.getElementById("toolbar").getBoundingClientRect();',
  'return {overlap:(bar.left<tb.right&&bar.right>tb.left&&bar.top<tb.bottom&&bar.bottom>tb.top),',
  'bar:{left:bar.left,top:bar.top,right:bar.right,bottom:bar.bottom},',
  'toolbar:{left:tb.left,top:tb.top,right:tb.right,bottom:tb.bottom}};',
  '}',
  '};return true})()'
].join('')

async function waitForCursorDecode (win) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const decoded = await win.webContents.executeJavaScript('!!(cursorImage&&cursorImage.complete&&cursorImage.naturalWidth>0)')
    if (decoded) return true
    await sleep(25)
  }
  return false
}

async function readProbe (win) {
  return win.webContents.executeJavaScript(
    '(function(){var a=document.getElementById("shutterSound");var p=window.__probe||{plays:0,errors:[]};' +
    'return {plays:p.plays,errors:p.errors,readyState:a.readyState,networkState:a.networkState,' +
    'error:a.error?a.error.code:0,duration:a.duration,muted:a.muted}})()'
  )
}

async function readSerial (win) {
  try {
    return await win.webContents.executeJavaScript('serialNumber')
  } catch (error) {
    return 'unreadable: ' + String(error && error.message)
  }
}

async function waitFor (check, message) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return
    await sleep(25)
  }
  throw new Error(message)
}

// performAction() awaits the PNG encode before it reads initData, so the next
// capture:init must not be sent until the previous payload reached the main process.
async function clickSave (win) {
  const before = records.saves.length
  await win.webContents.executeJavaScript('document.getElementById("save").click()')
  await waitFor(() => records.saves.length > before, 'the save payload never reached the main process')
}

async function clickExportPdf (win) {
  const before = records.pdfs.length
  await win.webContents.executeJavaScript('document.getElementById("exportPdf").click()')
  await waitFor(() => records.pdfs.length > before, 'the export-pdf payload never reached the main process')
}

// 真机验收抓到的缺陷（2026-10-10）：一张图里落 3 个序号后，保存载荷必须带上"下一个该用的号"
// （4），否则主进程只会按"第几次截图"接续，下一张会从 3 重复开始。
async function placeThreeSerials (win) {
  await win.webContents.executeJavaScript(
    '(function(){document.dispatchEvent(new KeyboardEvent("keydown",{key:"a",ctrlKey:true,bubbles:true}));' +
    'document.querySelector("[data-tool=serial]").click();' +
    'var c=document.getElementById("stage");' +
    '[[120,120],[240,160],[360,200]].forEach(function(p){c.dispatchEvent(new PointerEvent("pointerdown",' +
    '{clientX:p[0],clientY:p[1],bubbles:true,cancelable:true,pointerId:1,isPrimary:true}))});return true})()'
  )
  await sleep(60)
  return win.webContents.executeJavaScript('serialNumber')
}

async function main () {
  const report = { ok: false }
  let win = null
  try {
    const pagePath = path.join(ROOT, 'capture', 'capture.html')
    win = createSecureWindow({
      BrowserWindow: BrowserWindow,
      pagePath: pagePath,
      options: {
        show: false,
        width: 800,
        height: 600,
        frame: false,
        resizable: false,
        webPreferences: {
          preload: path.join(ROOT, 'preload-capture.js'),
          backgroundThrottling: false,
          autoplayPolicy: 'no-user-gesture-required'
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
    // Keep the synthesized click silent without touching the load/play path.
    await win.webContents.executeJavaScript('document.getElementById("shutterSound").muted=true')
    await win.webContents.executeJavaScript(
      '(function(){var el=document.getElementById("shutterSound");window.__probe={plays:0,errors:[],inits:0};' +
      'window.captureAPI.onInit(function(){window.__probe.inits++});' +
      'var original=el.play.bind(el);el.play=function(){window.__probe.plays++;var p=original();' +
      'if(p&&p.catch)p.catch(function(e){window.__probe.errors.push(String((e&&e.name)||e)+":"+String((e&&e.message)||""))});' +
      'return p};return true})()'
    )
    await win.webContents.executeJavaScript(PAGE_HELPERS)
    await win.webContents.executeJavaScript(PR_HELPERS)

    // --- A: stock payload, no saveMode -------------------------------------------------
    await sendInit(win, makeInit({}))
    await sleep(220)
    report.audio = await readProbe(win)
    await win.webContents.executeJavaScript('document.dispatchEvent(new KeyboardEvent("keydown",{key:"a",ctrlKey:true,bubbles:true}))')
    // Ctrl+A's handler is synchronous (capture.js:1305 -> render()), but whether the
    // toolbar ends up visible still depends on renderer state. Poll for it instead of
    // trusting one fixed sleep, so a slow runner is not failed by scheduling alone; if
    // it genuinely never becomes visible the read below still records why.
    for (let attempt = 0; attempt < 60; attempt++) {
      const revealed = await win.webContents.executeJavaScript(
        '!document.getElementById("toolbar").classList.contains("hidden")'
      )
      if (revealed) break
      await sleep(50)
    }
    report.ctrlA = await win.webContents.executeJavaScript(
      '(function(){return {toolbarVisible:!document.getElementById("toolbar").classList.contains("hidden"),' +
      'badge:document.getElementById("sizeBadge").textContent,innerWidth:innerWidth,innerHeight:innerHeight,' +
      'ruleDisappeared:document.getElementById("tip").style.display,' +
      // Diagnostics (2026-10-12): this assertion failed deterministically on the GitHub
      // Windows runner while passing locally, and the old message carried no state, so the
      // runner gave us nothing to reason about. Capture every input that can keep
      // #toolbar hidden (capture.js render(): degenerate selection, an active OCR result,
      // or a non-idle selectState) plus the viewport, so a failure names its own cause.
      'toolbarClass:document.getElementById("toolbar").className,' +
      'selectionState:typeof selectState==="undefined"?null:selectState,' +
      'activeOcr:typeof activeOcrResult!=="undefined"&&!!activeOcrResult,' +
      'rawSelection:typeof selection==="undefined"||!selection?null:selection,' +
      'imageLoaded:!!(image&&image.complete&&image.naturalWidth>0),' +
      'imageSize:{w:image?image.naturalWidth:0,h:image?image.naturalHeight:0},' +
      'displayBounds:imageDisplayBounds()}})()'
    )
    await clickExportPdf(win)
    report.windowOpenAfterExport = !win.isDestroyed()
    report.exportButtonReenabled = await win.webContents.executeJavaScript('!document.getElementById("exportPdf").disabled')
    await clickSave(win)

    // --- B: saveMode fast while the setting says dialog ---------------------------------
    await sendInit(win, makeInit({ saveMode: 'fast', screenshot: { fastSave: false } }))
    const modeBeforeFastSave = await win.webContents.executeJavaScript('initData.saveMode')
    await clickSave(win)

    // --- C: saveMode dialog while the setting says fast ---------------------------------
    await sendInit(win, makeInit({ saveMode: 'dialog', screenshot: { fastSave: true } }))
    const modeBeforeDialogSave = await win.webContents.executeJavaScript('initData.saveMode')
    await clickSave(win)

    // --- D: serial start value ----------------------------------------------------------
    await sendInit(win, makeInit({ serialNumber: 7 }))
    const serialFromPayload = await readSerial(win)
    await sendInit(win, makeInit({}))
    const serialReset = await readSerial(win)

    // --- D2: placed serials must ride out on the save payload (P0-7-T7 exact continuation) --
    await sendInit(win, makeInit({}))
    const serialAfterThree = await placeThreeSerials(win)
    const savesBeforeSerials = records.saves.length
    await clickSave(win)
    const serialReported = records.saves[savesBeforeSerials].meta && records.saves[savesBeforeSerials].meta.serialNumber

    // --- D3: closing without saving must report too, and an untouched capture must not ------
    await sendInit(win, makeInit({}))
    await win.webContents.executeJavaScript('document.getElementById("close").click()')
    await waitFor(() => records.closes.length > 0, 'the close payload never reached the main process')
    const closeReported = records.closes[records.closes.length - 1]

    // --- E: shutterSound false must not play --------------------------------------------
    const playsBeforeMute = (await readProbe(win)).plays
    await sendInit(win, makeInit({ screenshot: { shutterSound: false } }))
    await sleep(180)
    const playsAfterMute = (await readProbe(win)).plays

    // --- F: cursor compositing (P0-2 / S9b) ---------------------------------------------
    // This host has no visible cursor (GetCursorInfo always reports flags=0), so the real
    // path can only ever yield cursor:null. The synthetic payload below keeps the geometry
    // and the compositing itself under test: 4x4 magenta, hotspot (3,2), physical (64,64).
    const cursorDataUrl = await win.webContents.executeJavaScript(
      '(function(){var c=document.createElement("canvas");c.width=4;c.height=4;' +
      'var g=c.getContext("2d");g.fillStyle="#ff00ff";g.fillRect(0,0,4,4);return c.toDataURL("image/png")})()'
    )
    const cursorPng = cursorDataUrl.indexOf(',') >= 0 ? cursorDataUrl.slice(cursorDataUrl.indexOf(',') + 1) : ''
    const syntheticCursor = {
      png: cursorPng,
      dataUrl: cursorDataUrl,
      width: 4,
      height: 4,
      hotspot: { x: 3, y: 2 },
      physicalPoint: { x: 64, y: 64 }
    }
    const outsideCursor = Object.assign({}, syntheticCursor, { physicalPoint: { x: 9000, y: 9000 } })

    await sendInit(win, makeInit({ cursor: syntheticCursor }))
    const cursorDecoded = await waitForCursorDecode(win)
    const cursorSource = await win.webContents.executeJavaScript('window.__s9b.setSelection(100,100,200,200)')
    const cursorOn = await win.webContents.executeJavaScript('window.__s9b.pixels(true)')
    // Same init, same image: nulling initData.cursor is exactly what the main process ships
    // when the "screenshot with cursor" switch is off.
    const cursorOff = await win.webContents.executeJavaScript('window.__s9b.withCursor(null,true)')
    // Recognition paths pass includeAnnotations=false and must not get the cursor.
    const cursorRecognition = await win.webContents.executeJavaScript(
      'window.__s9b.withCursor(' + JSON.stringify(syntheticCursor) + ',false)'
    )
    // The cursor point outside the selection must not be drawn at all.
    const cursorOutside = await win.webContents.executeJavaScript(
      'window.__s9b.withCursor(' + JSON.stringify(outsideCursor) + ',true)'
    )
    const cursorState = await win.webContents.executeJavaScript('window.__s9b.state()')

    // F2: mixed DPI + a negative-coordinate secondary display. scaleFactor 1.25 and
    // captureBounds at (-1000,-500) make "physicalPoint used raw as DIP" land far outside
    // the crop, so this scenario only passes if the renderer really divides by scaleFactor.
    const scaledCursor = Object.assign({}, syntheticCursor, { physicalPoint: { x: -1200, y: -565 } })
    await sendInit(win, makeInit({
      cursor: scaledCursor,
      scaleFactor: 1.25,
      captureBounds: { x: -1000, y: -500, width: 800, height: 600 }
    }))
    const scaledDecoded = await waitForCursorDecode(win)
    await win.webContents.executeJavaScript('window.__s9b.setSelection(100,100,200,200)')
    const scaledOn = await win.webContents.executeJavaScript('window.__s9b.pixels(true)')
    const scaledOff = await win.webContents.executeJavaScript('window.__s9b.withCursor(null,true)')
    const scaledState = await win.webContents.executeJavaScript('window.__s9b.state()')

    report.saves = records.saves
    // --- G: annotation-editing regressions (OCR review fixes) ---------------------------
    await sendInit(win, makeInit({}))
    report.nudgeUndo = await win.webContents.executeJavaScript('window.__pr.nudgeUndo()')
    report.elementBarOverlap = await win.webContents.executeJavaScript('window.__pr.elementBarOverlap()')
    // P0-1-T4 / S11: the last section, because the hot-switch helper deliberately rewrites the
    // whole overlay's wording twice (and restores it) before the probe reports.
    report.i18n = await win.webContents.executeJavaScript('window.__s9b.i18n()')

    report.saveModes = { fast: modeBeforeFastSave, dialog: modeBeforeDialogSave }
    report.pdfs = records.pdfs
    report.serial = { fromPayload: serialFromPayload, reset: serialReset }
    report.serialReport = { afterThree: serialAfterThree, inSaveMeta: serialReported, onClose: closeReported }
    report.shutterGate = { playsBeforeMute: playsBeforeMute, playsAfterMute: playsAfterMute }
    report.cursor = {
      decoded: cursorDecoded,
      state: cursorState,
      source: cursorSource,
      on: cursorOn,
      off: cursorOff,
      recognition: cursorRecognition,
      outside: cursorOutside,
      scaled: {
        decoded: scaledDecoded,
        state: scaledState,
        on: scaledOn,
        off: scaledOff,
        physicalPoint: scaledCursor.physicalPoint,
        hotspot: scaledCursor.hotspot
      }
    }
    report.consoleMedia = records.consoles.filter((text) => /Content Security Policy|media-src|shutter|Refused to load/i.test(text))
    report.renders = records.renders
    report.closeRequests = records.closeRequests
    report.pngSize = pngSize
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

test('capture renderer honors saveMode, Ctrl+A, the serial reset, the shutter gate and export-PDF (P0-4-T7②, P0-7-T4/T5/T6/T7)', { timeout: 120000 }, () => {
  const probeDir = path.join(root, '.tmp', 'capture-renderer-probe')
  const probePath = path.join(probeDir, 'probe.js')
  const resultPath = path.join(probeDir, 'result.json')
  fs.mkdirSync(probeDir, { recursive: true })
  fs.rmSync(resultPath, { force: true })
  fs.writeFileSync(probePath, PROBE_SOURCE)

  // ELECTRON_RUN_AS_NODE would start Electron as plain node (see AGENTS/plan §16.3).
  const env = {
    ...process.env,
    ELECTRON_ENABLE_LOGGING: '0',
    W2_PROBE_ROOT: root,
    W2_PROBE_RESULT: resultPath
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
    `capture renderer probe failed.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  )
  assert.equal(fs.existsSync(resultPath), true, 'the probe did not write its result file')
  const report = JSON.parse(fs.readFileSync(resultPath, 'utf8'))
  assert.equal(report.ok, true, `probe error: ${report.error}`)

  // P0-7-T5: the media file must actually load in the capture page (this is what
  // pins the CSP media-src decision) and the play() must be allowed without a gesture.
  assert.ok(report.audio.readyState >= 1, `shutter.wav did not load (readyState ${report.audio.readyState}, error ${report.audio.error}, networkState ${report.audio.networkState})`)
  assert.ok(report.audio.duration > 0.05, `shutter.wav duration looks wrong (${report.audio.duration})`)
  assert.ok(report.audio.plays >= 1, 'the page must play the shutter sound once on init')
  assert.deepEqual(report.audio.errors, [], 'play() must not be rejected (autoplay policy + CSP)')
  assert.deepEqual(report.consoleMedia, [], `the page must not log media/CSP violations: ${JSON.stringify(report.consoleMedia)}`)

  // P0-7-T6: Ctrl+A selects the whole display (imageDisplayBounds() with no imageBounds
  // falls back to the viewport) and reveals the toolbar.
  assert.equal(report.ctrlA.toolbarVisible, true, `Ctrl+A must reveal #toolbar; ctrlA=${JSON.stringify(report.ctrlA)}`)
  assert.equal(report.ctrlA.badge, `${report.ctrlA.innerWidth} × ${report.ctrlA.innerHeight}`)
  assert.ok(report.ctrlA.innerWidth >= 700 && report.ctrlA.innerHeight >= 500, 'the probe window is roughly display sized')
  assert.equal(report.ctrlA.ruleDisappeared, 'none')

  // P0-4-T7②: the button exports the rendered PNG as A4 and leaves the window open.
  assert.equal(report.pdfs.length, 1)
  assert.equal(report.pdfs[0].mode, 'a4')
  assert.ok(report.pdfs[0].bytes > 1000, `export buffer looks empty (${report.pdfs[0].bytes} bytes)`)
  assert.equal(report.pdfs[0].meta.width, report.pngSize.width)
  assert.equal(report.pdfs[0].meta.height, report.pngSize.height)
  assert.equal(report.windowOpenAfterExport, true, 'the export must not close the capture window')
  assert.equal(report.exportButtonReenabled, true)
  assert.equal(report.closeRequests, 1, 'only the deliberate ✕ in section D3 reports a close')

  // P0-7-T4: an explicit saveMode wins over screenshot.fastSave in both directions.
  assert.deepEqual(report.saves.map((entry) => entry.fast), [false, true, false, false])
  for (const entry of report.saves) assert.ok(entry.bytes > 1000, 'every save must ship real PNG bytes')

  // P0-7-T7: the payload value is consumed, and an absent value resets to 1.
  assert.equal(report.serial.fromPayload, 7)
  assert.equal(report.serial.reset, 1)

  // P0-7-T7 精确接续：落 3 个序号 → 计数走到 4 → 必须随保存载荷与关窗载荷回报；
  // 没落过序号的截图关窗时报 0（主进程据此不推进）。
  assert.equal(report.serialReport.afterThree, 4, 'three placed serials must advance the renderer counter to 4')
  assert.equal(report.serialReport.inSaveMeta, 4, 'the save payload must carry the next serial, not the stale pre-action count')
  assert.deepEqual(report.serialReport.onClose, { serialNumber: 0 }, 'an untouched capture must not consume a serial')

  // P0-7-T5 gate: shutterSound false means no second play().
  assert.equal(report.shutterGate.playsAfterMute, report.shutterGate.playsBeforeMute)

  // OCR 评审修复（High）：方向键微调与 Ctrl+Z 的交互 —— 微调必须先独立成帧，
  // 否则一次撤销会同时丢掉微调并回退上一步，标注整个消失。
  assert.equal(report.nudgeUndo.afterNudge, 201, 'the nudge moved the annotation by 1px')
  assert.equal(report.nudgeUndo.count, 1, 'Ctrl+Z after a nudge must keep the annotation')
  assert.equal(report.nudgeUndo.x, 200, 'and must only undo the nudge itself')

  // OCR 评审修复（High）：水印（bounds == 选区）选中时，浮动条不得压在工具栏上。
  assert.equal(report.elementBarOverlap.overlap, false, 'the element bar must not cover the toolbar')

  // P0-1-T4 / S11：迁移后 zh-CN 文案必须与迁移前逐字一致，且 i18n:language 热切换能在不重载的
  // 前提下改写同一批 DOM（data-i18n* 标记与 t() 动态文案共用同一套表）。
  assert.equal(report.i18n.before.markers, expectedTextMarkers, 'every marked element is in the live DOM')
  assert.equal(report.i18n.before.attrMarkers, expectedAttributeMarkers, 'every marked attribute is in the live DOM')
  assert.equal(report.i18n.before.emptyText, 0, 'every data-i18n marker must be filled')
  assert.equal(report.i18n.before.emptyAttr, 0, 'every data-i18n-* attribute must be filled')
  assert.equal(report.i18n.before.title, 'Highlighter 截图')
  assert.equal(report.i18n.before.recordTitle, '区域录制')
  assert.equal(report.i18n.before.exportTitle, '导出 PDF')
  assert.equal(report.i18n.before.frontAria, '上移一层')
  assert.equal(report.i18n.before.watermarkPlaceholder, '输入水印文字')
  assert.equal(report.i18n.before.thin, '细')
  assert.equal(report.i18n.after.title, 'Highlighter capture', 'the hot switch rewrites the document title')
  assert.equal(report.i18n.after.recordTitle, 'Record region')
  assert.equal(report.i18n.after.thin, 'Thin')

  // P0-2 / S9b: the cursor is composited where the pure geometry says, and nowhere else.
  // The host has no visible cursor, so this is driven by a synthetic payload; the expected
  // position below is plain arithmetic (not a call back into shared/cursor-geometry.js).
  const cursor = report.cursor
  assert.equal(cursor.decoded, true, 'the renderer must decode the cursor bitmap carried by the init payload')
  assert.ok(cursor.state.initCursor, 'the init payload cursor must reach the renderer')
  assert.equal(cursor.state.initCursor.width, 4)
  assert.deepEqual(cursor.state.initCursor.hotspot, { x: 3, y: 2 })
  // The 200x200 CSS selection maps onto the image through getSourcePixelRect(); the exact
  // crop depends on the viewport, so only its non-emptiness is pinned here.
  assert.ok(
    cursor.state.source.width > 0 && cursor.state.source.height > 0,
    `the selection must map to a non-empty crop (${JSON.stringify(cursor.state.source)})`
  )
  assert.equal(cursor.on.data.length, cursor.on.width * cursor.on.height * 4)

  const cursorScale = cursor.state.scaleFactor
  const cursorBounds = cursor.state.captureBounds
  const dipX = 64 / cursorScale
  const dipY = 64 / cursorScale
  const expectedX = Math.round((dipX - cursorBounds.x) * cursorScale - 3) - cursor.state.source.x
  const expectedY = Math.round((dipY - cursorBounds.y) * cursorScale - 2) - cursor.state.source.y
  assert.ok(
    expectedX >= 0 && expectedY >= 0 && expectedX + 3 < cursor.on.width && expectedY + 3 < cursor.on.height,
    `the synthetic cursor should land inside the export (${expectedX},${expectedY})`
  )

  const emptyBox = { count: 0, minX: Infinity, minY: Infinity, maxX: -1, maxY: -1 }
  assert.deepEqual(magentaBox(cursor.off), emptyBox, 'a null cursor must not put any cursor pixel in the export')
  assert.deepEqual(
    magentaBox(cursor.on),
    { count: 16, minX: expectedX, minY: expectedY, maxX: expectedX + 3, maxY: expectedY + 3 },
    'the 4x4 bitmap must be pasted at the hotspot-corrected position'
  )
  assert.deepEqual(
    pixelDiffBox(cursor.on.data, cursor.off.data, cursor.on.width),
    { count: 16, minX: expectedX, minY: expectedY, maxX: expectedX + 3, maxY: expectedY + 3 },
    'the only pixels a cursor may change are its own 4x4 block (switch off = pixel identical)'
  )

  // F2: scaleFactor 1.25 on a negative-coordinate display. The renderer must turn the
  // provider's physical point back into DIP before the geometry runs; using it raw would
  // put the cursor far outside the crop and this block would be empty.
  const scaled = cursor.scaled
  assert.equal(scaled.decoded, true)
  assert.equal(scaled.state.scaleFactor, 1.25)
  assert.deepEqual(scaled.state.captureBounds, { x: -1000, y: -500, width: 800, height: 600 })
  const scaledExpectedX = Math.round((scaled.physicalPoint.x / 1.25 - scaled.state.captureBounds.x) * 1.25 - scaled.hotspot.x) - scaled.state.source.x
  const scaledExpectedY = Math.round((scaled.physicalPoint.y / 1.25 - scaled.state.captureBounds.y) * 1.25 - scaled.hotspot.y) - scaled.state.source.y
  assert.ok(
    scaledExpectedX >= 0 && scaledExpectedY >= 0 &&
    scaledExpectedX + 3 < scaled.on.width && scaledExpectedY + 3 < scaled.on.height,
    `the mixed-DPI cursor should land inside the export (${scaledExpectedX},${scaledExpectedY})`
  )
  assert.deepEqual(magentaBox(scaled.off), emptyBox, 'the mixed-DPI baseline must carry no cursor')
  assert.deepEqual(
    magentaBox(scaled.on),
    { count: 16, minX: scaledExpectedX, minY: scaledExpectedY, maxX: scaledExpectedX + 3, maxY: scaledExpectedY + 3 },
    'the 1.25x / negative-origin payload must still land hotspot-aligned'
  )
  assert.deepEqual(
    pixelDiffBox(scaled.on.data, scaled.off.data, scaled.on.width),
    { count: 16, minX: scaledExpectedX, minY: scaledExpectedY, maxX: scaledExpectedX + 3, maxY: scaledExpectedY + 3 },
    'the mixed-DPI paste may only change its own 4x4 block'
  )

  assert.equal(
    pixelDiffBox(cursor.recognition.data, cursor.off.data, cursor.on.width).count,
    0,
    'includeAnnotations=false (OCR/translate/table/QR) must never get the cursor'
  )
  assert.equal(
    pixelDiffBox(cursor.outside.data, cursor.off.data, cursor.on.width).count,
    0,
    'a cursor point outside the selection must not be drawn'
  )
})

function magentaBox (frame) {
  const box = { count: 0, minX: Infinity, minY: Infinity, maxX: -1, maxY: -1 }
  for (let offset = 0; offset + 3 < frame.data.length; offset += 4) {
    if (!(frame.data[offset] >= 240 && frame.data[offset + 1] <= 15 && frame.data[offset + 2] >= 240)) continue
    const pixel = offset / 4
    const x = pixel % frame.width
    const y = Math.floor(pixel / frame.width)
    box.count++
    box.minX = Math.min(box.minX, x)
    box.maxX = Math.max(box.maxX, x)
    box.minY = Math.min(box.minY, y)
    box.maxY = Math.max(box.maxY, y)
  }
  return box
}

function pixelDiffBox (before, after, width) {
  const box = { count: 0, minX: Infinity, minY: Infinity, maxX: -1, maxY: -1 }
  for (let offset = 0; offset + 3 < before.length; offset += 4) {
    if (
      before[offset] === after[offset] &&
      before[offset + 1] === after[offset + 1] &&
      before[offset + 2] === after[offset + 2] &&
      before[offset + 3] === after[offset + 3]
    ) continue
    const pixel = offset / 4
    const x = pixel % width
    const y = Math.floor(pixel / width)
    box.count++
    box.minX = Math.min(box.minX, x)
    box.maxX = Math.max(box.maxX, x)
    box.minY = Math.min(box.minY, y)
    box.maxY = Math.max(box.maxY, y)
  }
  return box
}
