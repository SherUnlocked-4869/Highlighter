const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.join(__dirname, '..')

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
    displayBounds: { x: 0, y: 0, width: 800, height: 600 },
    captureBounds: { x: 0, y: 0, width: 800, height: 600 },
    imageBounds: null,
    scaleFactor: 1,
    editPin: false,
    smartSelect: false,
    cursorPosition: { x: 0, y: 0 },
    saveMode: opts.saveMode || '',
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

    // --- A: stock payload, no saveMode -------------------------------------------------
    await sendInit(win, makeInit({}))
    await sleep(220)
    report.audio = await readProbe(win)
    await win.webContents.executeJavaScript('document.dispatchEvent(new KeyboardEvent("keydown",{key:"a",ctrlKey:true,bubbles:true}))')
    await sleep(150)
    report.ctrlA = await win.webContents.executeJavaScript(
      '(function(){return {toolbarVisible:!document.getElementById("toolbar").classList.contains("hidden"),' +
      'badge:document.getElementById("sizeBadge").textContent,innerWidth:innerWidth,innerHeight:innerHeight,' +
      'ruleDisappeared:document.getElementById("tip").style.display}})()'
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

    report.saves = records.saves
    report.saveModes = { fast: modeBeforeFastSave, dialog: modeBeforeDialogSave }
    report.pdfs = records.pdfs
    report.serial = { fromPayload: serialFromPayload, reset: serialReset }
    report.serialReport = { afterThree: serialAfterThree, inSaveMeta: serialReported, onClose: closeReported }
    report.shutterGate = { playsBeforeMute: playsBeforeMute, playsAfterMute: playsAfterMute }
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
  assert.equal(report.ctrlA.toolbarVisible, true)
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
})
