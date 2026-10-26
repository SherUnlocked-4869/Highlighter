// 功能 D4：放大镜的「重开 → 选中 → 改倍率 → 保存」全链路真机回归。
//
// 为什么需要真机：test/capture-magnifier-ui.test.js 只能断言源码形状（面板会读选中对象、
// editSelectedMagnifier 会压一帧）。它证明不了：
//   · 载入后的放大镜确实是**可编辑对象**而不是位图；
//   · 改倍率后镜头中心真的没动（withFactor 的锚点语义在真实坐标下成立）；
//   · 提交的 snapshot 里 outputStyle 与 magnifier **同时**存在且都合法；
//   · resultBuffer 的尺寸真的等于 resolveOutputGeometry（v2/v3 的提交硬校验）。
//
// 这条探针直接驱动真实的 capture:load-document / capture:commit-document 通道，并且用主进程
// 自己的 readPngSize + resolveOutputGeometry 校验结果，而不是在渲染层自说自话。
//
// 窗口一律 show:false（AGENTS.md：可见测试窗默认放副屏，本机只有主屏）。
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.join(__dirname, '..')

const STAGE_WIDTH = 900
const STAGE_HEIGHT = 700
const CROP = { x: 100, y: 80, w: 640, h: 420 }

const PROBE_SOURCE = `
'use strict'
const { app, ipcMain, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.env.REEDIT_PROBE_ROOT
const RESULT = process.env.REEDIT_PROBE_RESULT
const { createSecureWindow } = require(path.join(ROOT, 'main', 'services', 'window-security'))
const { readPngSize } = require(path.join(ROOT, 'main', 'services', 'capture-geometry'))
const documentApi = require(path.join(ROOT, 'shared', 'capture-document.js'))
const magnifierApi = require(path.join(ROOT, 'shared', 'magnifier-geometry.js'))

const STAGE_WIDTH = ${STAGE_WIDTH}
const STAGE_HEIGHT = ${STAGE_HEIGHT}
const CROP = ${JSON.stringify(CROP)}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const records = {
  consoles: [],
  documentLoads: [],
  commits: [],
  closes: [],
  resultSize: null,
  expectedGeometry: null,
  committedSnapshot: null
}

ipcMain.on('capture:ready', () => {})
ipcMain.on('capture:render-ready', () => {})
ipcMain.on('capture:render-error', (_event, message) => records.consoles.push('render-error: ' + message))
ipcMain.on('capture:close', () => {})
ipcMain.on('capture:save', () => {})
ipcMain.handle('capture:export-pdf', () => null)
ipcMain.handle('capture:load-document', (_event, payload) => {
  records.documentLoads.push(payload || null)
  return records.loadResponse || { ok: false, code: 'not-configured' }
})
// The real commit handler validates the result PNG against resolveOutputGeometry; this probe does the
// same check with the REAL shared module so the assertion is not the renderer grading itself.
ipcMain.handle('capture:commit-document', (_event, payload) => {
  // Both fields arrive as Buffer over the real IPC channel; normalize defensively so the probe reports
  // the actual reason for a mismatch instead of "false because it is a Uint8Array".
  // The renderer ships a Uint8Array over IPC; Electron's structured clone hands the main process an
  // ArrayBuffer, which has no length property. Normalize to a Node Buffer first, like the service does
  // with its own toBuffer helper - otherwise the probe reports a size mismatch that does not exist.
  const toBuffer = (value) => {
    if (!value) return Buffer.alloc(0)
    if (Buffer.isBuffer(value)) return value
    if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value))
    if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
    if (Array.isArray(value)) return Buffer.from(value)
    return Buffer.alloc(0)
  }
  const snapshotBytes = toBuffer(payload && payload.snapshot)
  const resultBuffer = toBuffer(payload && payload.resultBuffer)
  const entry = {
    intent: payload ? payload.intent : null,
    requestId: payload ? payload.requestId : null,
    hasSnapshot: snapshotBytes.length > 0,
    hasResult: resultBuffer.length > 0,
    resultLength: resultBuffer.length,
    resultSize: null,
    parsed: null,
    geometry: null,
    sizeMatchesGeometry: null
  }
  try {
    const parsed = documentApi.parseDocument(snapshotBytes)
    entry.parsed = parsed.ok ? { ok: true, schemaVersion: parsed.document.schemaVersion } : { ok: false, code: parsed.code }
    if (parsed.ok && resultBuffer && resultBuffer.length) {
      const size = readPngSize(resultBuffer)
      entry.resultSize = size
      const geometry = documentApi.resolveOutputGeometry(parsed.document)
      entry.geometry = geometry
      entry.sizeMatchesGeometry = !!size && size.width === geometry.width && size.height === geometry.height
      entry.magnifiers = parsed.document.annotations.filter((item) => item.type === 'magnifier').length
      entry.magnifier = parsed.document.annotations.find((item) => item.type === 'magnifier') || null
      entry.outputStyleEnabled = parsed.document.outputStyle ? parsed.document.outputStyle.enabled === true : null
      records.committedSnapshot = parsed.document
    }
  } catch (error) {
    entry.error = String(error && error.stack ? error.stack : error)
  }
  records.commits.push(entry)
  return {
    ok: true,
    status: 'committed',
    documentId: 'document-probe',
    headRevisionId: 'revision-probe-2',
    version: 2
  }
})

let win = null

// A synthetic screenshot with real content everywhere (a flat fill would make the geometry assertions
// vacuous): a luminance ramp, dark rows, and a two-tone block.
function screenshotDataUrl () {
  return win.webContents.executeJavaScript(\`(function(){
    var W=${STAGE_WIDTH}, H=${STAGE_HEIGHT};
    var c=document.createElement('canvas'); c.width=W; c.height=H;
    var g=c.getContext('2d');
    var ramp=g.createLinearGradient(0,0,W,H);
    ramp.addColorStop(0,'#f3f0e9'); ramp.addColorStop(0.5,'#a9aeb8'); ramp.addColorStop(1,'#3c4358');
    g.fillStyle=ramp; g.fillRect(0,0,W,H);
    g.fillStyle='#15151b';
    for (var row=0; row<16; row++) g.fillRect(30, 30+row*22, W-60, 7);
    g.fillStyle='#ff0000'; g.fillRect(200,200,120,90);
    g.fillStyle='#0000ff'; g.fillRect(320,200,120,90);
    return c.toDataURL('image/png');
  })()\`)
}

async function main () {
  const report = { ok: false }
  try {
    // ---- build the document the window will reopen -------------------------------------------
    // A crop smaller than the base image, one magnifier inside it, and a card style enabled - so the
    // commit check covers BOTH the v3 magnifier and the v2 outputStyle in one snapshot.
    const magnifier = magnifierApi.createFromSourceRect(
      { x: 220, y: 180, w: 160, h: 100 },
      { factor: 2, crop: CROP, stroke: { color: '#ff3b30', widthPx: 3 }, connector: 'line' }
    )
    const document = documentApi.createInitialDocument({
      assetId: 'base-probe',
      width: STAGE_WIDTH,
      height: STAGE_HEIGHT,
      annotations: [magnifier],
      outputStyle: {
        enabled: true,
        paddingPx: 24,
        background: { color: '#f5f5f7', alpha: 1 },
        cornerRadiusPx: 8,
        border: { widthPx: 1, color: '#d8d8dd' },
        shadow: { enabled: true, blurPx: 12, offsetXPx: 0, offsetYPx: 6, color: '#000000', alpha: 0.2 }
      }
    })
    const normalized = documentApi.normalizeDocument(Object.assign({}, document, { crop: CROP }))
    report.loadedMagnifier = normalized.annotations.find((item) => item.type === 'magnifier') || null
    report.loadedGeometry = documentApi.resolveOutputGeometry(normalized)

    records.loadResponse = {
      ok: true,
      session: { sessionId: 'session-probe' },
      documentId: 'document-probe',
      revisionId: 'revision-probe-1',
      version: 1,
      legacy: false,
      storageFormat: 'editable-v1',
      degraded: false,
      document: normalized,
      crop: CROP
    }

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

    const dataUrl = await screenshotDataUrl()
    const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')
    // The real editor window shape: imageBounds is the crop area, and documentEditor carries the load
    // payload (this is exactly what main/domains/capture/index.js sends).
    const layout = { x: 0, y: 26, width: CROP.w, height: CROP.h }
    win.webContents.send('capture:init', {
      imageBuffer: png,
      mode: 'image',
      autoAction: '',
      source: 'history',
      displayBounds: { x: 0, y: 0, width: STAGE_WIDTH, height: STAGE_HEIGHT },
      captureBounds: { x: 0, y: 0, width: CROP.w, height: CROP.h },
      imageBounds: layout,
      scaleFactor: 1,
      editPin: false,
      smartSelect: false,
      cursorPosition: { x: 0, y: 0 },
      saveMode: '',
      cursor: null,
      serialNumber: 1,
      settings: { mainColor: '#e5a44c', screenshot: { shutterSound: false, fastSave: false, annotationWidth: 4, watermark: {}, outputStylePreset: 'original' }, ocr: {} },
      documentEditor: {
        sessionId: 'session-probe',
        documentId: 'document-probe',
        revisionId: 'revision-probe-1',
        version: 1,
        legacy: false,
        storageFormat: 'editable-v1',
        degraded: false,
        document: normalized,
        crop: CROP,
        infoHeight: 26,
        documentName: 'probe'
      }
    })
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const ready = await win.webContents.executeJavaScript('!!(image&&image.complete&&image.naturalWidth>0&&documentEditor&&annotations.length)')
      if (ready) break
      await sleep(50)
    }
    await sleep(250)

    // ---- 1) the reopened magnifier is an EDITABLE object, with exact geometry ------------------
    report.reopened = await win.webContents.executeJavaScript(\`(function(){
      var item = annotations.filter(function(entry){ return entry.type === 'magnifier' })[0] || null;
      // The live array is in VIEWPORT CSS (that is what drawAnnotation maps from); the document is in
      // SOURCE pixels. Both are asserted below: the viewport value proves the object is addressable by
      // the editor, the document value proves the persisted geometry did not drift.
      var inDocument = annotationsToDocument().filter(function(entry){ return entry.type === 'magnifier' })[0] || null;
      return {
        documentSourceRect: inDocument ? inDocument.sourceRect : null,
        documentLensOrigin: inDocument ? inDocument.lensOrigin : null,
        documentFactor: inDocument ? inDocument.factor : null,
        isObject: !!item,
        // A restored bitmaps-only record would have no annotations at all; a restored magnifier must
        // carry both nested rects, the factor, the connector and the (scaled) stroke width.
        sourceRect: item ? item.sourceRect : null,
        lensOrigin: item ? item.lensOrigin : null,
        factor: item ? item.factor : null,
        connector: item ? item.connector : null,
        strokeWidth: item ? item.stroke.widthPx : null,
        lensRect: item && window.magnifierGeometry ? window.magnifierGeometry.lensRect(item) : null,
        documentLensRect: inDocument && window.magnifierGeometry ? window.magnifierGeometry.lensRect(inDocument) : null,
        historyLength: annotationHistory.length,
        historyIndex: historyIndex,
        dirty: documentEditor ? documentEditor.dirty : null,
        legacy: documentEditor ? documentEditor.legacy : null
      };
    })()\`)

    // ---- 2) select it and change 2x -> 4x through the REAL UI path ------------------------------
    // The panel's factor button is clicked in the page, so this exercises the listener wiring,
    // editSelectedMagnifier(), withFactor()'s centre anchor and the single undo frame together.
    report.beforeEdit = await win.webContents.executeJavaScript(\`(function(){
      var item = annotations.filter(function(entry){ return entry.type === 'magnifier' })[0];
      setSelectedAnnotation(item);
      var api = window.magnifierGeometry;
      return {
        factor: item.factor,
        lensCenter: api.lensCenter(item),
        lensRect: api.lensRect(item),
        historyLength: annotationHistory.length,
        historyIndex: historyIndex
      };
    })()\`)
    report.afterEdit = await win.webContents.executeJavaScript(\`(function(){
      var button = document.querySelector('[data-magnifier-factor="4"]');
      var panelVisible = !document.getElementById('magnifierPanel').classList.contains('hidden');
      button.click();
      var item = annotations.filter(function(entry){ return entry.type === 'magnifier' })[0];
      var api = window.magnifierGeometry;
      return {
        panelWasVisible: panelVisible,
        factor: item.factor,
        lensCenter: api.lensCenter(item),
        lensRect: api.lensRect(item),
        historyLength: annotationHistory.length,
        historyIndex: historyIndex,
        historyDelta: annotationHistory.length
      };
    })()\`)
    // Undo must restore 2x in exactly one step (one gesture = one frame), then redo puts 4x back.
    report.undo = await win.webContents.executeJavaScript(\`(function(){
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true}));
      var item = annotations.filter(function(entry){ return entry.type === 'magnifier' })[0];
      return { factor: item ? item.factor : null, historyIndex: historyIndex };
    })()\`)
    report.redo = await win.webContents.executeJavaScript(\`(function(){
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'y',ctrlKey:true,bubbles:true}));
      var item = annotations.filter(function(entry){ return entry.type === 'magnifier' })[0];
      return { factor: item ? item.factor : null, historyIndex: historyIndex };
    })()\`)

    // ---- 3) Ctrl+S commits: snapshot carries outputStyle + magnifier, result matches geometry ----
    const commitsBefore = records.commits.length
    await win.webContents.executeJavaScript("document.dispatchEvent(new KeyboardEvent('keydown',{key:'s',ctrlKey:true,bubbles:true}))")
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (records.commits.length > commitsBefore) break
      await sleep(50)
    }
    report.commit = records.commits[records.commits.length - 1] || null

    // ---- 4) reopen the COMMITTED document and check the 4x survived ------------------------------
    // Feed the committed snapshot back through the same init path: this is the real "open it again"
    // route (the main process would read the head revision and ship it).
    if (records.committedSnapshot) {
      records.loadResponse = {
        ok: true,
        session: { sessionId: 'session-probe-2' },
        documentId: 'document-probe',
        revisionId: 'revision-probe-2',
        version: 2,
        legacy: false,
        storageFormat: 'editable-v1',
        degraded: false,
        document: records.committedSnapshot,
        crop: records.committedSnapshot.crop
      }
      win.webContents.send('capture:init', {
        imageBuffer: png,
        mode: 'image',
        autoAction: '',
        source: 'history',
        displayBounds: { x: 0, y: 0, width: STAGE_WIDTH, height: STAGE_HEIGHT },
        captureBounds: { x: 0, y: 0, width: CROP.w, height: CROP.h },
        imageBounds: layout,
        scaleFactor: 1,
        editPin: false,
        smartSelect: false,
        cursorPosition: { x: 0, y: 0 },
        saveMode: '',
        cursor: null,
        serialNumber: 1,
        settings: { mainColor: '#e5a44c', screenshot: { shutterSound: false, fastSave: false, annotationWidth: 4, watermark: {}, outputStylePreset: 'original' }, ocr: {} },
        documentEditor: {
          sessionId: 'session-probe-2',
          documentId: 'document-probe',
          revisionId: 'revision-probe-2',
          version: 2,
          legacy: false,
          storageFormat: 'editable-v1',
          degraded: false,
          document: records.committedSnapshot,
          crop: records.committedSnapshot.crop,
          infoHeight: 26,
          documentName: 'probe'
        }
      })
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const ready = await win.webContents.executeJavaScript('!!(image&&image.complete&&image.naturalWidth>0&&documentEditor&&annotations.length)')
        if (ready) break
        await sleep(50)
      }
      await sleep(200)
      report.reopenedAgain = await win.webContents.executeJavaScript(\`(function(){
        var item = annotations.filter(function(entry){ return entry.type === 'magnifier' })[0] || null;
        var inDocument = annotationsToDocument().filter(function(entry){ return entry.type === 'magnifier' })[0] || null;
        return {
          documentSourceRect: inDocument ? inDocument.sourceRect : null,
          isObject: !!item,
          factor: item ? item.factor : null,
          connector: item ? item.connector : null,
          sourceRect: item ? item.sourceRect : null,
          lensOrigin: item ? item.lensOrigin : null,
          outputStyleEnabled: documentEditor && documentEditor.document && documentEditor.document.outputStyle
            ? documentEditor.document.outputStyle.enabled === true : null,
          historyLength: annotationHistory.length,
          historyIndex: historyIndex
        };
      })()\`)
      // The panel must echo the RESTORED object, not the session defaults.
      report.panelEcho = await win.webContents.executeJavaScript(\`(function(){
        var item = annotations.filter(function(entry){ return entry.type === 'magnifier' })[0];
        setSelectedAnnotation(item);
        var visible = !document.getElementById('magnifierPanel').classList.contains('hidden');
        var active = document.querySelector('[data-magnifier-factor].active');
        var connector = document.querySelector('[data-magnifier-connector].active');
        return {
          visible: visible,
          activeFactor: active ? active.dataset.magnifierFactor : null,
          activeConnector: connector ? connector.dataset.magnifierConnector : null
        };
      })()\`)
    }

    report.meta = { dpr: await win.webContents.executeJavaScript('window.devicePixelRatio') }
    report.consoles = records.consoles
    report.crop = CROP
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

test('§7.3 a reopened magnifier stays editable, survives a factor change and commits with a geometry-matching result', { timeout: 180000 }, () => {
  const probeDir = path.join(root, '.tmp', 'magnifier-reedit-probe')
  const probePath = path.join(probeDir, 'probe.js')
  const resultPath = path.join(probeDir, 'result.json')
  fs.mkdirSync(probeDir, { recursive: true })
  fs.rmSync(resultPath, { force: true })
  fs.writeFileSync(probePath, PROBE_SOURCE)
  const env = { ...process.env, ELECTRON_ENABLE_LOGGING: '0', REEDIT_PROBE_ROOT: root, REEDIT_PROBE_RESULT: resultPath }
  delete env.ELECTRON_RUN_AS_NODE
  const result = spawnSync(require('electron'), [probePath], {
    cwd: root,
    encoding: 'utf8',
    timeout: 110000,
    windowsHide: true,
    env
  })
  assert.equal(result.status, 0, `reedit probe failed.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  assert.equal(fs.existsSync(resultPath), true, 'the probe did not write its result file')
  const report = JSON.parse(fs.readFileSync(resultPath, 'utf8'))
  assert.equal(report.ok, true, `probe error: ${report.error}`)
  assert.deepEqual(report.consoles.filter((text) => /render-error/i.test(text)), [])

  // ---- 1) the reopened magnifier is a real editable object with exact geometry -----------------
  const reopened = report.reopened
  assert.equal(reopened.isObject, true, 'a record with a magnifier must reopen it as an editable object')
  assert.equal(reopened.legacy, false)
  assert.equal(reopened.dirty, false, 'opening a record must start clean')
  assert.equal(reopened.historyLength, 1, 'opening starts a one-frame undo stack')
  assert.equal(reopened.historyIndex, 0)
  // Geometry is exact in DOCUMENT space: the nested rects survive serialize + parse untouched because
  // they are source pixels. (The live array holds viewport CSS - asserting that against the document
  // would compare two coordinate spaces, which is the mistake this pair of fields exists to avoid.)
  assert.deepEqual(reopened.documentSourceRect, report.loadedMagnifier.sourceRect)
  assert.deepEqual(reopened.documentLensOrigin, report.loadedMagnifier.lensOrigin)
  assert.equal(reopened.documentFactor, 2)
  assert.equal(reopened.factor, 2)
  assert.equal(reopened.connector, 'line')
  // The lens rect is DERIVED (sourceRect * factor), never persisted. Asserted in DOCUMENT space:
  // comparing a viewport-space lens rect against the loaded source-pixel object would compare two
  // coordinate spaces (the same trap the sourceRect pair above avoids).
  assert.deepEqual(reopened.documentLensRect, {
    x: report.loadedMagnifier.lensOrigin.x,
    y: report.loadedMagnifier.lensOrigin.y,
    w: report.loadedMagnifier.sourceRect.w * 2,
    h: report.loadedMagnifier.sourceRect.h * 2
  })

  // ---- 2) the factor change is one frame, and the lens centre does not move --------------------
  const before = report.beforeEdit
  const after = report.afterEdit
  assert.equal(after.panelWasVisible, true, 'selecting a magnifier must reveal its attribute panel')
  assert.equal(before.factor, 2)
  assert.equal(after.factor, 4, 'the clicked factor must reach the selected object')
  // withFactor's contract: the lens centre is the anchor (§7.1).
  assert.ok(Math.abs(after.lensCenter.x - before.lensCenter.x) < 1e-6, `the lens centre x must not move (${before.lensCenter.x} -> ${after.lensCenter.x})`)
  assert.ok(Math.abs(after.lensCenter.y - before.lensCenter.y) < 1e-6, `the lens centre y must not move (${before.lensCenter.y} -> ${after.lensCenter.y})`)
  // And the lens really doubled in size (the factor is not just stored).
  assert.ok(Math.abs(after.lensRect.w - before.lensRect.w * 2) < 1e-6, `the lens width must double (${before.lensRect.w} -> ${after.lensRect.w})`)
  // Exactly ONE undo frame for the whole gesture.
  assert.equal(after.historyLength, before.historyLength + 1, 'a factor change is one undo frame')

  // Undo restores 2x in one step; redo puts 4x back. That is what "one gesture = one frame" means.
  assert.equal(report.undo.factor, 2, 'one Ctrl+Z must restore the previous factor')
  assert.equal(report.redo.factor, 4, 'one Ctrl+Y must restore the new factor')

  // ---- 3) the commit carries outputStyle AND the magnifier, and the result matches geometry -----
  const commit = report.commit
  assert.ok(commit, 'Ctrl+S must reach capture:commit-document')
  assert.equal(commit.intent, 'update')
  assert.equal(commit.hasSnapshot, true)
  assert.equal(commit.hasResult, true, `the commit must include the result image (length ${commit.resultLength})`)
  assert.equal(commit.parsed.ok, true, `the snapshot must validate (got ${commit.parsed && commit.parsed.code})`)
  assert.equal(commit.parsed.schemaVersion, 3, 'the document is v3')
  assert.equal(commit.outputStyleEnabled, true, 'the enabled card style must be in the committed snapshot')
  assert.equal(commit.magnifiers, 1, 'the magnifier must be in the committed snapshot')
  assert.equal(commit.magnifier.factor, 4, 'the committed factor is the edited one')
  // The result PNG size must equal what resolveOutputGeometry says - this is the v2/v3 hard check the
  // main-process service applies, reproduced with the real shared module.
  assert.ok(commit.geometry, 'the probe must be able to compute the expected geometry')
  assert.deepEqual(
    { width: commit.resultSize.width, height: commit.resultSize.height },
    { width: commit.geometry.width, height: commit.geometry.height },
    'the committed result must be the finished-look size, not the crop size'
  )
  assert.ok(
    commit.resultSize.width > report.crop.w,
    `with the card enabled the result must be larger than the crop (${commit.resultSize.width} vs ${report.crop.w})`
  )
  assert.equal(commit.sizeMatchesGeometry, true)

  // ---- 4) reopening the COMMITTED document keeps the 4x and the panel echoes it ----------------
  const again = report.reopenedAgain
  assert.equal(again.isObject, true, 'the committed record must reopen with its magnifier')
  assert.equal(again.factor, 4, 'the committed factor must survive a second reopen')
  assert.equal(again.connector, 'line')
  assert.deepEqual(again.documentSourceRect, report.loadedMagnifier.sourceRect)
  assert.equal(again.outputStyleEnabled, true, 'the card style must survive a second reopen')
  assert.equal(again.historyLength, 1, 'each open starts a fresh one-frame stack')
  assert.equal(again.historyIndex, 0)
  // The attribute panel shows the restored object's values, not the session defaults.
  assert.equal(report.panelEcho.visible, true)
  assert.equal(report.panelEcho.activeFactor, '4')
  assert.equal(report.panelEcho.activeConnector, 'line')
})
