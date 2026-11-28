'use strict'

// U02 / DEV-01 (P1-03): every confirm entry that REPLACES an existing pin's image must
// carry the editable snapshot, not only the two pin buttons.
//
// The shipped bug: Enter, the copy button and double-click-copy all route through
// performAction('copy'); in a pin re-annotation session that action commits back to the
// SAME pin window, but only 'pin'/'pin-copy' built meta.pinEditable. The main process
// releases the old snapshot when it replaces the display image, so the next re-annotation
// opened a flat bitmap whose rectangle could no longer be selected/moved/deleted.
//
// Evidence here:
//   * a real capture.html in a real (hidden) Electron window, driven through the production
//     preload and the production renderer script, exercising each entry end to end and
//     reading the meta.pinEditable that actually reaches `capture:pin`;
//   * static wiring assertions for the single snapshot-construction gate (the entry-level
//     probe is the behavioural proof; these keep a future refactor from re-splitting the
//     entries without a GUI);
//   * the control: a plain copy session (no editPin) must NOT attach a snapshot.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.join(__dirname, '..')
const captureScript = fs.readFileSync(path.join(root, 'capture', 'capture.js'), 'utf8')

const PROBE_SOURCE = `
'use strict'
const { app, ipcMain, BrowserWindow, nativeImage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.env.U02_PROBE_ROOT
const RESULT = process.env.U02_PROBE_RESULT
const { createSecureWindow } = require(path.join(ROOT, 'main', 'services', 'window-security'))
const captureDocument = require(path.join(ROOT, 'shared', 'capture-document'))

const records = { pins: [], copies: [], closes: [], errors: [] }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// A valid tiny PNG: the probe decides the base size, so the snapshot document and the
// decoded renderer image cannot drift.
function makePng (width, height) {
  const pixels = Buffer.alloc(width * height * 4)
  for (let offset = 0; offset < pixels.length; offset += 4) {
    pixels[offset] = 210
    pixels[offset + 1] = 40
    pixels[offset + 2] = 70
    pixels[offset + 3] = 255
  }
  return nativeImage.createFromBitmap(pixels, { width, height }).toPNG()
}

ipcMain.on('capture:ready', () => {})
ipcMain.on('capture:render-ready', () => {})
ipcMain.on('capture:render-error', (_event, message) => records.errors.push(String(message)))
ipcMain.on('capture:close', (_event, payload) => records.closes.push(payload || null))
ipcMain.handle('capture:pin', (_event, payload) => {
  records.pins.push({
    meta: payload && payload.meta ? payload.meta : null,
    copy: payload ? payload.copy === true : false,
    imageBytes: payload && payload.imageBuffer ? payload.imageBuffer.byteLength : 0
  })
  return null
})
ipcMain.handle('capture:copy', (_event, payload) => {
  records.copies.push({
    meta: payload && payload.meta ? payload.meta : null,
    imageBytes: payload && payload.imageBuffer ? payload.imageBuffer.byteLength : 0
  })
  return null
})

const BASE_WIDTH = 120
const BASE_HEIGHT = 80
const png = makePng(BASE_WIDTH, BASE_HEIGHT)

function pinSnapshot () {
  const document = captureDocument.createPinEditableDocument({
    width: BASE_WIDTH,
    height: BASE_HEIGHT,
    annotations: [
      // One rectangle in SOURCE pixels: this is the object that must survive every
      // confirm entry and be re-selectable in the reopened editor.
      { type: 'rect', x: 10, y: 12, x2: 60, y2: 40, color: '#ff3b30', width: 4 }
    ],
    outputStyle: null,
    sourceScaleFactor: 1
  })
  return { schema: 1, document, crop: document.crop, sourceScaleFactor: 1 }
}

function makeInit (options) {
  const settings = Object.assign({
    shutterSound: false,
    fastSave: false,
    annotationWidth: 4,
    watermark: {},
    doubleClickCopy: false
  }, options.settings || {})
  return {
    imageBuffer: png,
    mode: 'image',
    autoAction: '',
    source: 'pin-reannotate',
    displayBounds: { x: 0, y: 0, width: 400, height: 300 },
    captureBounds: { x: 0, y: 0, width: 400, height: 300 },
    imageBounds: { x: 20, y: 20, width: BASE_WIDTH, height: BASE_HEIGHT },
    scaleFactor: 1,
    editPin: options.editPin === true,
    documentEditor: null,
    pinEditable: options.pinEditable === true ? pinSnapshot() : null,
    smartSelect: false,
    cursorPosition: { x: 0, y: 0 },
    saveMode: '',
    cursor: null,
    serialNumber: 1,
    skipHistory: false,
    settings: { mainColor: '#e5a44c', screenshot: settings, ocr: {} }
  }
}

async function sendInit (win, payload) {
  const previousInits = await win.webContents.executeJavaScript('window.__u02Probe.inits')
  const previousSrc = await win.webContents.executeJavaScript('(image&&image.src)||""')
  win.webContents.send('capture:init', payload)
  for (let attempt = 0; attempt < 120; attempt++) {
    const state = await win.webContents.executeJavaScript(
      '({inits:window.__u02Probe.inits,src:(image&&image.src)||"",loaded:!!(image&&image.complete&&image.naturalWidth>0),' +
      'editable:!!(typeof pinEditable!=="undefined"&&pinEditable),selection:!!(typeof selection!=="undefined"&&selection),' +
      'annotations:typeof annotations!=="undefined"?annotations.length:-1})'
    )
    const snapshotReady = payload.pinEditable
      ? state.editable && state.annotations >= 1
      : !state.editable
    if (state.inits > previousInits && state.loaded && state.src && state.src !== previousSrc && state.selection && snapshotReady) return
    await sleep(25)
  }
  throw new Error('the renderer never observed the capture:init payload for editPin=' + String(payload.editPin))
}

async function triggerEntry (win, entry) {
  const pinsBefore = records.pins.length
  const copiesBefore = records.copies.length
  if (entry === 'enter') {
    await win.webContents.executeJavaScript(
      'document.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}))'
    )
  } else if (entry === 'copy-button') {
    await win.webContents.executeJavaScript('document.getElementById("copy").click()')
  } else if (entry === 'double-click') {
    await win.webContents.executeJavaScript(
      'document.getElementById("stage").dispatchEvent(new MouseEvent("dblclick",{bubbles:true,cancelable:true,clientX:5,clientY:5}))'
    )
  } else if (entry === 'pin-button') {
    await win.webContents.executeJavaScript('document.getElementById("pin").click()')
  } else if (entry === 'plain-copy') {
    await win.webContents.executeJavaScript('document.getElementById("copy").click()')
    for (let attempt = 0; attempt < 200; attempt++) {
      if (records.copies.length > copiesBefore) return { copies: records.copies.at(-1), pins: 0 }
      await sleep(25)
    }
    throw new Error('the plain copy entry never reached capture:copy')
  } else {
    throw new Error('unknown entry ' + entry)
  }
  for (let attempt = 0; attempt < 240; attempt++) {
    if (records.pins.length > pinsBefore) {
      return { pin: records.pins.at(-1), copies: records.copies.length - copiesBefore }
    }
    await sleep(25)
  }
  throw new Error('entry ' + entry + ' never reached capture:pin')
}

function snapshotOf (entryResult) {
  const meta = entryResult.pin && entryResult.pin.meta ? entryResult.pin.meta : null
  return meta ? meta.pinEditable : undefined
}

async function run () {
  const report = { ok: false, entries: {} }
  let win = null
  try {
    const pagePath = path.join(ROOT, 'capture', 'capture.html')
    win = createSecureWindow({
      BrowserWindow,
      pagePath,
      options: {
        show: false,
        width: 400,
        height: 300,
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
      if (text && /u02|pin|error/i.test(String(text))) records.errors.push('console: ' + String(text))
    })
    await win.loadFile(pagePath)
    await win.webContents.executeJavaScript(
      '(function(){window.__u02Probe={inits:0};window.captureAPI.onInit(function(){window.__u02Probe.inits++});' +
      'var el=document.getElementById("shutterSound");if(el)el.muted=true;return true})()'
    )

    // --- The four confirm entries of a pin RE-ANNOTATION session ---------------------
    const entries = [
      { name: 'enter', init: { editPin: true, pinEditable: true } },
      { name: 'copy-button', init: { editPin: true, pinEditable: true } },
      { name: 'double-click', init: { editPin: true, pinEditable: true, settings: { doubleClickCopy: true } } },
      { name: 'pin-button', init: { editPin: true, pinEditable: true } }
    ]
    for (const entry of entries) {
      await sendInit(win, makeInit(entry.init))
      const result = await triggerEntry(win, entry.name)
      const snapshot = snapshotOf(result)
      report.entries[entry.name] = {
        snapshot: snapshot
          ? {
              schema: snapshot.schema,
              annotations: snapshot.document && Array.isArray(snapshot.document.annotations)
                ? snapshot.document.annotations.map((item) => ({ type: item.type, x: item.x, y: item.y }))
                : null,
              baseBytes: snapshot.baseImagePng && snapshot.baseImagePng.byteLength ? snapshot.baseImagePng.byteLength : 0
            }
          : null,
        imageBytes: result.pin.imageBytes,
        extraCopies: result.copies
      }
    }

    // --- Control: a plain copy (not an editPin session) must not attach a snapshot ---
    await sendInit(win, makeInit({ editPin: false, pinEditable: false }))
    const plain = await triggerEntry(win, 'plain-copy')
    const plainMeta = plain.copies && plain.copies.meta ? plain.copies.meta : null
    report.entries.plainCopy = {
      sent: !!plainMeta,
      snapshot: plainMeta && Object.prototype.hasOwnProperty.call(plainMeta, 'pinEditable') ? plainMeta.pinEditable : null
    }
    report.errors = records.errors
    report.ok = true
    win.destroy()
  } catch (error) {
    report.error = String(error && error.stack ? error.stack : error)
    if (win && !win.isDestroyed()) win.destroy()
  }
  fs.writeFileSync(RESULT, JSON.stringify(report, null, 2))
  app.exit(report.ok ? 0 : 1)
}

app.whenReady().then(run, (error) => {
  const report = { ok: false, error: String(error && error.stack ? error.stack : error) }
  try { fs.writeFileSync(RESULT, JSON.stringify(report, null, 2)) } catch {}
  app.exit(1)
})
`

function runProbe() {
  const probeDir = path.join(root, '.tmp', 'u02-pin-reedit-entry-probe')
  const probePath = path.join(probeDir, 'probe.js')
  const resultPath = path.join(probeDir, 'result.json')
  fs.mkdirSync(probeDir, { recursive: true })
  fs.rmSync(resultPath, { force: true })
  fs.writeFileSync(probePath, PROBE_SOURCE)

  const env = {
    ...process.env,
    ELECTRON_ENABLE_LOGGING: '0',
    U02_PROBE_ROOT: root,
    U02_PROBE_RESULT: resultPath,
    // AGENTS.md trap 3: spawned Electron children may be denied %LOCALAPPDATA%\Temp on a
    // confined host, so keep every throwaway root inside the gitignored .tmp dir.
    TMP: probeDir,
    TEMP: probeDir,
    HIGHLIGHTER_E2E_DATA_ROOT_BASE: probeDir
  }
  // AGENTS.md trap 1: with this set, electron.exe runs as plain Node and the probe dies.
  delete env.ELECTRON_RUN_AS_NODE
  // AGENTS.md trap 2 + e2e/electron-app.js convention: on a host whose Chromium sandbox
  // cannot start, the flag must come BEFORE the script path.
  const args = process.env.HIGHLIGHTER_E2E_NO_SANDBOX === '1'
    ? ['--no-sandbox', probePath]
    : [probePath]

  const result = spawnSync(require('electron'), args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 110000,
    windowsHide: true,
    env
  })
  assert.equal(
    result.status,
    0,
    `pin re-edit entry probe failed.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  )
  assert.equal(fs.existsSync(resultPath), true, 'the probe did not write its result file')
  const report = JSON.parse(fs.readFileSync(resultPath, 'utf8'))
  assert.equal(report.ok, true, `probe error: ${report.error}`)
  return report
}

test('every pin-replacement confirm entry carries meta.pinEditable for an editPin session (P1-03)', { timeout: 120000 }, () => {
  const report = runProbe()
  for (const entry of ['enter', 'copy-button', 'double-click', 'pin-button']) {
    const result = report.entries[entry]
    assert.ok(result, `${entry} entry missing from the probe report`)
    assert.ok(result.snapshot, `${entry} must attach meta.pinEditable when it replaces the pin image`)
    assert.equal(result.snapshot.schema, 1)
    assert.deepEqual(
      result.snapshot.annotations,
      [{ type: 'rect', x: 10, y: 12 }],
      `${entry}: the editable snapshot must still carry the existing rectangle`
    )
    assert.ok(result.snapshot.baseBytes > 0, `${entry}: the snapshot must carry the base PNG`)
    assert.ok(result.imageBytes > 0, `${entry}: the replacement image must still be exported`)
  }
  // The control: Enter/copy outside an editPin session stays clipboard-only - no snapshot
  // and no pin commit is fabricated for a normal copy.
  assert.equal(report.entries.plainCopy.sent, true)
  assert.equal(report.entries.plainCopy.snapshot, null, 'a plain copy must not attach an editable snapshot')
})

test('wiring: one snapshot gate covers every confirm entry (P1-03)', () => {
  // The single decision point: pin buttons plus `copy` inside an editPin session.
  assert.match(captureScript, /function pinConfirmReplacesPin\(action\) \{/)
  assert.match(captureScript, /if \(action === 'pin' \|\| action === 'pin-copy'\) return true/)
  assert.match(captureScript, /return action === 'copy' && !!initData\?\.editPin/)
  // The snapshot is built exactly once, behind that predicate (no entry-specific copy of
  // the construction logic that could drift).
  assert.match(captureScript, /if\(pinConfirmReplacesPin\(action\)\)\{[\s\S]{0,240}?buildPinEditableSnapshot\(\)/)
  assert.equal(
    (captureScript.match(/meta\.pinEditable=pinEditableSnapshot/g) || []).length,
    1,
    'meta.pinEditable must be assigned from one construction site only'
  )
  // All four confirm entries still funnel through performAction (the probe drives them).
  assert.match(captureScript, /if\(event\.key==='Enter'[^\n]*performAction\('copy'\)/)
  assert.match(captureScript, /document\.getElementById\('copy'\)\.onclick=\(\)=>performAction\('copy'\)/)
  assert.match(captureScript, /doubleClickCopy\) performAction\('copy'\)/)
  assert.match(captureScript, /if\(pinMenu\.classList\.contains\('hidden'\)\)performAction\('pin'\)/)
})
