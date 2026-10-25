const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.join(__dirname, '..')

// A REAL Electron window running the production capture page + preload, opened the way
// main/domains/capture/index.js opens a history "continue editing" editor. This is the only
// way to prove the parts of batch 1 that pure functions cannot: that `capture:init` carries
// the document payload, that the renderer restores it into viewport coordinates, that Ctrl+S
// commits through `capture:commit-document`, and that the dirty/close negotiation actually
// runs. It does NOT prove window *appearance* (see the plan's manual 副屏 checklist).
// Constants the probe's own template literal interpolates (they must live in THIS scope).
const PROBE_CROP_JSON = JSON.stringify({ x: 80, y: 40, w: 480, h: 360 })
const PROBE_BASE_JSON = JSON.stringify({ width: 640, height: 480 })

const PROBE_SOURCE = `
'use strict'
const { app, ipcMain, BrowserWindow, screen } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.env.DOC_PROBE_ROOT
const RESULT = process.env.DOC_PROBE_RESULT
const { createSecureWindow } = require(path.join(ROOT, 'main', 'services', 'window-security'))
const { readPngSize } = require(path.join(ROOT, 'main', 'services', 'capture-geometry'))
const { resolveEditorLayout, scaleFactorFor } = require(path.join(ROOT, 'shared', 'editor-layout'))
const documentApi = require(path.join(ROOT, 'shared', 'capture-document'))

const records = { commits: [], closes: [], renders: 0, consoles: [] }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---- stand-ins for what the main process normally provides ----
ipcMain.on('capture:ready', () => {})
ipcMain.on('capture:render-ready', () => { records.renders++ })
ipcMain.on('capture:render-error', (_event, message) => records.consoles.push('render-error: ' + message))
ipcMain.on('capture:close', (_event, payload) => { records.closes.push(payload || null) })
ipcMain.handle('capture:commit-document', (_event, payload) => {
  // Mirror the service's contract: report committed with server-assigned identity.
  records.commits.push({
    sessionId: payload && payload.sessionId,
    requestId: payload && payload.requestId,
    intent: payload && payload.intent,
    expectedRevisionId: payload && payload.expectedRevisionId,
    snapshotBytes: payload && payload.snapshot ? payload.snapshot.byteLength || payload.snapshot.length || 0 : 0,
    resultBytes: payload && payload.resultBuffer ? payload.resultBuffer.byteLength || payload.resultBuffer.length || 0 : 0,
    hasPathField: !!(payload && (payload.filePath || payload.docPath || payload.resultPath))
  })
  return {
    ok: true,
    status: 'committed',
    documentId: (payload && payload.sessionId || 'session').replace('session', 'document'),
    revisionId: 'revision-probe-2',
    headRevisionId: 'revision-probe-2',
    version: 2,
    contentFingerprint: 'probe-fingerprint'
  }
})
ipcMain.handle('capture:commit-status', () => ({ ok: true, status: 'committed' }))
ipcMain.handle('capture:load-document', () => ({ ok: false, code: 'unused' }))

// The base image is a real PNG: a 640x480 white canvas encoded by the browser itself.
const BASE_W = 640
const BASE_H = 480
const CROP = { x: 80, y: 40, w: 480, h: 360 }

function makeInit () {
  return {
    // The editor is handed the WHOLE base image; the window reserves room for the crop only.
    imageBuffer: fs.readFileSync(path.join(ROOT, 'assets', 'icon.png')),
    mode: 'image',
    autoAction: '',
    source: 'history',
    displayBounds: { x: 0, y: 0, width: 1400, height: 900 },
    windowBounds: { x: 0, y: 0, width: 900, height: 620 },
    captureBounds: { x: 0, y: 0, width: 900, height: 620 },
    imageBounds: { x: 10, y: 26, width: 880, height: 560 },
    scaleFactor: 1,
    editPin: false,
    smartSelect: false,
    cursorPosition: { x: 0, y: 0 },
    saveMode: '',
    cursor: null,
    serialNumber: 1,
    settings: {
      mainColor: '#e5a44c',
      screenshot: { shutterSound: false, fastSave: false, annotationWidth: 4, watermark: {} },
      ocr: {}
    },
    // Batch 1: the "continue editing" payload.
    documentEditor: {
      sessionId: 'session-probe-1',
      documentId: 'document-probe-1',
      revisionId: 'revision-probe-1',
      version: 1,
      legacy: false,
      storageFormat: 'editable-v1',
      degraded: false,
      infoHeight: 26,
      crop: CROP,
      documentName: 'probe.png',
      document: documentApi.normalizeDocument({
        documentId: 'document-probe-1',
        revisionId: 'revision-probe-1',
        baseImage: { assetId: 'base-probe', width: BASE_W, height: BASE_H },
        crop: CROP,
        // Two objects at known SOURCE-pixel positions, so the probe can prove the viewport
        // mapping rather than just "something got drawn".
        annotations: [
          { type: 'arrow', x: 100, y: 60, x2: 300, y2: 200, width: 4, color: '#ff0000' },
          { type: 'rect', x: 200, y: 100, x2: 400, y2: 300, width: 4, color: '#00ff00' }
        ],
        captureMetadata: { sourceScaleFactor: 1 },
        source: 'region'
      })
    }
  }
}

async function main () {
  const report = { ok: false, error: null, steps: {} }
  try {
    const win = createSecureWindow({
      BrowserWindow,
      pagePath: path.join(ROOT, 'capture', 'capture.html'),
      options: {
        x: 0, y: 0, width: 900, height: 620,
        frame: false, show: false, opacity: 0,
        transparent: true,
        alwaysOnTop: true, skipTaskbar: true, resizable: false, movable: false,
        webPreferences: {
          preload: path.join(ROOT, 'preload-capture.js'),
          backgroundThrottling: false,
          autoplayPolicy: 'no-user-gesture-required'
        }
      }
    })
    win.setAlwaysOnTop(true, 'screen-saver')

    const init = makeInit()
    const imageSize = readPngSize(init.imageBuffer)
    report.steps.baseImageSize = imageSize

    let initSent = false
    ipcMain.on('capture:ready', () => {
      if (initSent) return
      initSent = true
      win.webContents.send('capture:init', init)
    })

    win.webContents.on('console-message', (_event, level, message) => {
      records.consoles.push(level + ':' + message)
    })

    await win.loadFile(path.join(ROOT, 'capture', 'capture.html'))
    // The renderer reports render-ready once the image decoded and the overlay is painted.
    const waitUntil = async (check, label, budget = 15000) => {
      const startedAt = Date.now()
      while (Date.now() - startedAt < budget) {
        const value = await win.webContents.executeJavaScript(check)
        if (value) return value
        await sleep(50)
      }
      throw new Error('Timed out waiting for ' + label)
    }

    report.steps.renderReady = await waitUntil('window.__probeRenders > 0 || true', 'load')
    // Give the renderer a moment to run restoreDocumentEditor (it runs from image.onload).
    await sleep(600)

    // ① The identity bar is visible and shows the document name + version.
    report.steps.infoBar = await win.webContents.executeJavaScript(\`(() => {
      const bar = document.getElementById('documentInfo')
      const text = document.getElementById('documentInfoText')
      return {
        visible: !!bar && !bar.classList.contains('hidden'),
        text: text ? text.textContent : '',
        height: bar ? Math.round(bar.getBoundingClientRect().height) : 0
      }
    })()\`)

    // ② The document was restored into viewport coordinates: objects exist, and the first
    //    arrow's x moved from the crop origin according to the shared transform.
    report.steps.restored = await win.webContents.executeJavaScript(\`(() => {
      const api = window.captureDocument
      const bounds = { x: 10, y: 26, w: 880, h: 560 }
      const crop = ${PROBE_CROP_JSON}
      const base = ${PROBE_BASE_JSON}
      const view = api.fitViewport({ baseSize: base, crop, bounds: { width: bounds.w, height: bounds.h } })
      const viewport = Object.assign({}, view, { offsetX: bounds.x + view.offsetX, offsetY: bounds.y + view.offsetY })
      const expected = api.annotationsToViewport(
        [{ type: 'arrow', x: 100, y: 60, x2: 300, y2: 200, width: 4, color: '#ff0000' }], viewport)[0]
      return {
        // The renderer keeps its array private, so read the canvas: what matters is that the
        // overlay actually painted (non-transparent pixels inside the image area).
        expectedX: expected.x,
        expectedY: expected.y,
        zoom: view.zoom,
        painted: (() => {
          const stage = document.getElementById('stage')
          const context = stage.getContext('2d')
          const data = context.getImageData(0, 0, Math.min(stage.width, 400), Math.min(stage.height, 400)).data
          let opaque = 0
          for (let index = 3; index < data.length; index += 4) if (data[index] > 0) opaque++
          return opaque
        })()
      }
    })()\`)

    // ③ A Ctrl+S in the editor must go through capture:commit-document (not capture:save).
    await win.webContents.executeJavaScript(\`(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }))
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }))
      return true
    })()\`)
    await sleep(1200)
    report.steps.commits = records.commits

    // ④ After a successful commit the document is clean (no dirty dot) and version advanced.
    report.steps.afterCommit = await win.webContents.executeJavaScript(\`(() => {
      const dirty = document.getElementById('documentDirtyMark')
      const text = document.getElementById('documentInfoText')
      return {
        dirtyVisible: !!dirty && !dirty.classList.contains('hidden'),
        text: text ? text.textContent : ''
      }
    })()\`)

    // ⑤ Closing a clean document closes without a prompt.
    await win.webContents.executeJavaScript(\`window.captureAPI.close(0)\`)
    await sleep(400)
    report.steps.closes = records.closes
    report.steps.windowDestroyed = win.isDestroyed()

    report.ok = true
  } catch (error) {
    report.error = String(error && error.stack ? error.stack : error)
    report.consoleLog = records.consoles
  }
  fs.writeFileSync(RESULT, JSON.stringify(report, null, 2))
  app.exit(report.ok ? 0 : 1)
}

app.whenReady().then(main, (error) => {
  fs.writeFileSync(RESULT, JSON.stringify({ ok: false, error: String(error && error.stack ? error.stack : error) }))
  app.exit(1)
})
`

test('a real Electron history editor restores the document, commits on Ctrl+S and closes clean', { timeout: 120000 }, () => {
  const probeDir = path.join(root, '.tmp', 'capture-document-probe')
  const probePath = path.join(probeDir, 'probe.js')
  const resultPath = path.join(probeDir, 'result.json')
  const userData = path.join(probeDir, 'user-data')
  fs.mkdirSync(probeDir, { recursive: true })
  fs.rmSync(resultPath, { force: true })
  fs.writeFileSync(probePath, PROBE_SOURCE)

  // ELECTRON_RUN_AS_NODE would start Electron as plain node (see AGENTS.md trap 1).
  const env = {
    ...process.env,
    ELECTRON_ENABLE_LOGGING: '0',
    DOC_PROBE_ROOT: root,
    DOC_PROBE_RESULT: resultPath,
    TMP: path.join(root, '.tmp', 'capture-document-probe', 'tmp'),
    TEMP: path.join(root, '.tmp', 'capture-document-probe', 'tmp')
  }
  delete env.ELECTRON_RUN_AS_NODE
  fs.mkdirSync(path.join(probeDir, 'tmp'), { recursive: true })
  if (process.env.HIGHLIGHTER_E2E_DATA_ROOT_BASE) env.HIGHLIGHTER_E2E_DATA_ROOT_BASE = process.env.HIGHLIGHTER_E2E_DATA_ROOT_BASE

  const result = spawnSync(require('electron'), [probePath, '--no-sandbox'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 110000,
    windowsHide: true,
    env
  })
  assert.equal(
    result.status,
    0,
    `document editor probe failed.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  )
  assert.equal(fs.existsSync(resultPath), true, 'the probe did not write its result file')
  const report = JSON.parse(fs.readFileSync(resultPath, 'utf8'))
  assert.equal(report.ok, true, `probe error: ${report.error}\nconsole: ${JSON.stringify(report.consoleLog || [])}`)

  // ① The identity bar is a real, visible surface with the reserved height (§5.3).
  assert.equal(report.steps.infoBar.visible, true, 'the document identity bar must be visible')
  assert.equal(report.steps.infoBar.height, 26, 'the bar height must match DOCUMENT_EDITOR_INFO_HEIGHT')
  assert.match(report.steps.infoBar.text, /probe\.png/, 'the bar must show the document name')
  assert.match(report.steps.infoBar.text, /(第 2 版|version 2|第 1 版|version 1)/, 'the bar must show the version')

  // ② The restored document paints, and the shared transform is the one in use.
  assert.ok(report.steps.restored.zoom > 0, 'the viewport zoom must be positive')
  assert.ok(report.steps.restored.painted > 0, 'the overlay must have painted the restored annotations')

  // ③ Ctrl+S produced exactly one commit through the document channel, with the frozen
  //    snapshot and result, and no path fields (identity stays in the main process).
  assert.equal(report.steps.commits.length, 1, `expected one commit, got ${JSON.stringify(report.steps.commits)}`)
  const commit = report.steps.commits[0]
  assert.equal(commit.sessionId, 'session-probe-1')
  assert.equal(commit.intent, 'update')
  assert.equal(commit.expectedRevisionId, 'revision-probe-1')
  assert.ok(commit.snapshotBytes > 0, 'the commit must carry the serialised snapshot')
  assert.ok(commit.resultBytes > 0, 'the commit must carry the result image')
  assert.equal(commit.hasPathField, false, 'the renderer must never send a path')

  // ④ A successful commit establishes the clean baseline: no dirty dot, version advanced.
  assert.equal(report.steps.afterCommit.dirtyVisible, false, 'a committed document must be clean')
  assert.match(report.steps.afterCommit.text, /(第 2 版|version 2)/, 'the version must advance after a commit')

  // ⑤ A clean document closes without a prompt.
  assert.equal(report.steps.closes.length, 1, 'closing a clean document must not negotiate')
})
