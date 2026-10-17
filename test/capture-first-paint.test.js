const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')

// Exercise the real page and preload with animation frames deliberately stalled.
// A source-only assertion cannot catch a missing mask on the timeout path.
const probeSource = String.raw`
const { app, BrowserWindow, ipcMain, nativeImage, screen } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const root = process.env.CAPTURE_PAINT_ROOT
const resultPath = process.env.CAPTURE_PAINT_RESULT
const { createSecureWindow } = require(path.join(root, 'main/services/window-security'))
app.setPath('userData', path.join(__dirname, 'profile'))
app.setPath('sessionData', path.join(__dirname, 'session'))
const report = { samples: [], errors: [] }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let win
ipcMain.on('capture:ready', () => {})
ipcMain.on('capture:render-error', (_event, message) => report.errors.push(message))
ipcMain.on('capture:render-ready', async event => {
  report.samples.push(await event.sender.executeJavaScript('({' +
    'elapsedMs:performance.now()-window.__paintInitAt,' +
    'mask:Array.from(ctx.getImageData(2,2,1,1).data),' +
    'background:Array.from(backgroundCtx.getImageData(2,2,1,1).data),' +
    'width:innerWidth,height:innerHeight,pending:renderReadyPending})'))
})
async function waitFor(predicate, message) {
  const end = Date.now() + 3000
  while (Date.now() < end) {
    if (await predicate()) return
    await sleep(10)
  }
  throw new Error(message)
}
app.whenReady().then(async () => {
  try {
    const display = screen.getAllDisplays().find(item => item.id !== screen.getPrimaryDisplay().id) || screen.getPrimaryDisplay()
    const pagePath = path.join(root, 'capture/capture.html')
    win = createSecureWindow({ BrowserWindow, pagePath, options: {
      show: false, opacity: 0, frame: false, width: 800, height: 600,
      x: display.bounds.x, y: display.bounds.y,
      webPreferences: { preload: path.join(root, 'preload-capture.js'), backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' }
    } })
    win.webContents.on('console-message', (_event, details) => {
      if (details.level === 'error') report.errors.push(details.message)
    })
    win.setBounds({ x: display.bounds.x, y: display.bounds.y, width: 800, height: 600 })
    await win.loadFile(pagePath)
    await win.webContents.executeJavaScript('(() => {' +
      'if(renderRequest){cancelAnimationFrame(renderRequest);renderRequest=0}' +
      'window.requestAnimationFrame=()=>1;window.cancelAnimationFrame=()=>{};' +
      'window.captureAPI.onInit(()=>{window.__paintInitAt=performance.now()})' +
    '})()')
    const png = nativeImage.createFromBitmap(Buffer.alloc(32 * 32 * 4, 255), { width: 32, height: 32 }).toPNG()
    const init = {
      mode: 'region', imageBuffer: png, smartSelect: false, serialNumber: 1,
      displayBounds: { x: display.bounds.x, y: display.bounds.y, width: 800, height: 600 },
      captureBounds: { x: display.bounds.x, y: display.bounds.y, width: 800, height: 600 },
      settings: { screenshot: { shutterSound: false } }
    }
    win.webContents.send('capture:init', init)
    await waitFor(() => report.samples.length === 1, 'stalled animation frames blocked first paint')
    await sleep(160)
    report.afterFirstCount = report.samples.length

    // A fresh init must not inherit the previous timer or bypass the size guard.
    win.webContents.send('capture:init', { ...init, captureBounds: { ...init.captureBounds, width: 900 } })
    await waitFor(() => win.webContents.executeJavaScript('initData.captureBounds.width===900&&!!image?.naturalWidth'), 'second init was not decoded')
    await sleep(180)
    report.beforeResizeCount = report.samples.length
    win.setBounds({ x: display.bounds.x, y: display.bounds.y, width: 900, height: 600 })
    await waitFor(() => report.samples.length === 2, 'matching viewport did not release first paint')
    await sleep(160)
    report.afterResizeCount = report.samples.length
    report.visible = win.isVisible()
    report.ok = true
  } catch (error) {
    report.error = error.stack || String(error)
    if (win && !win.isDestroyed()) report.state = await win.webContents.executeJavaScript('({' +
      'width:innerWidth,height:innerHeight,init:!!initData,image:!!image,' +
      'complete:image?.complete,naturalWidth:image?.naturalWidth,pending:renderReadyPending,sent:renderReadySent})')
  }
  fs.writeFileSync(resultPath, JSON.stringify(report, null, 2))
  app.exit(report.ok ? 0 : 1)
})
`

test('first paint remains bounded with stalled frames and paints the mask before reporting ready', { timeout: 20000 }, () => {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'highlighter-first-paint-'))
  const probePath = path.join(probeDir, 'probe.cjs')
  const resultPath = path.join(probeDir, 'result.json')
  fs.writeFileSync(probePath, probeSource)
  const env = { ...process.env, CAPTURE_PAINT_ROOT: root, CAPTURE_PAINT_RESULT: resultPath }
  delete env.ELECTRON_RUN_AS_NODE
  const result = spawnSync(require('electron'), [probePath], { cwd: root, env, encoding: 'utf8', timeout: 15000, windowsHide: true })
  assert.equal(result.status, 0, `first-paint probe failed:
${result.stdout}
${result.stderr}
${fs.existsSync(resultPath) ? fs.readFileSync(resultPath, 'utf8') : 'no report'}`)
  const report = JSON.parse(fs.readFileSync(resultPath, 'utf8'))
  assert.deepEqual(report.errors, [])
  assert.equal(report.afterFirstCount, 1, 'a slow frame must not emit a second ready event')
  assert.equal(report.beforeResizeCount, 1, 'an incorrectly sized viewport must stay hidden')
  assert.equal(report.afterResizeCount, 2, 'a new init can report ready once its viewport matches')
  assert.equal(report.visible, false)
  for (const sample of report.samples) {
    assert.ok(sample.elapsedMs < 600, `first paint still took ${sample.elapsedMs}ms`)
    assert.deepEqual(sample.background, [255, 255, 255, 255], 'the decoded screenshot must be painted')
    assert.deepEqual(sample.mask.slice(0, 3), [0, 0, 0])
    assert.ok(Math.abs(sample.mask[3] - 117) <= 1, 'the first frame must include the selection mask')
    assert.equal(sample.pending, false)
  }
  assert.equal(report.samples[1].width, 900)
})
