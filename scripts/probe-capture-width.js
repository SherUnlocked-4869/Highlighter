// Verifies the screenshot thickness picker end to end in a real Electron
// renderer: the three levels must paint 2/4/8 px strokes on the exported canvas,
// switching levels must not touch annotations that are already committed, the
// tool strip must still fit at small widths, Enter must not fire "copy" while the
// picker has focus, and the choice must be written back to settings.
//
// Windows are created with show:false and observed through capturePage(), so
// nothing is drawn on the user's displays (AGENTS.md keeps the primary display
// free; this workspace is single-display).
//
// Run: node_modules\electron\dist\electron.exe scripts\probe-capture-width.js
// (ELECTRON_RUN_AS_NODE must not be set for that invocation.)
const path = require('node:path')
const fs = require('node:fs')
const { app, BrowserWindow } = require('electron')

const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, '.tmp', 'capture-width-probe')
const IMAGE_WIDTH = 800
const IMAGE_HEIGHT = 600
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Hermetic profile. Sharing the default userData directory with a running
// Highlighter instance makes this probe fail to start (profile lock) and lets a
// persisted page zoom leak between runs.
fs.mkdirSync(OUT, { recursive: true })
app.setPath('userData', path.join(OUT, 'user-data'))
app.commandLine.appendSwitch('force-device-scale-factor', '1')

// Mirrors preload-capture.js for the members capture.js touches, recording calls
// so the probe can assert on `settings:update` and on copy not being triggered.
const STUB = `
  const __calls = []
  window.__calls = __calls
  const __handlers = {}
  const __fire = (name, payload) => { for (const fn of (__handlers[name] || [])) { try { fn(payload) } catch (e) { console.error(e) } } }
  const __on = (name) => function (fn) { (__handlers[name] = __handlers[name] || []).push(fn) }
  const record = (name) => (...args) => { __calls.push({ name, args }); return Promise.resolve(undefined) }
  window.captureAPI = {
    onInit: __on('init'), ready() {}, renderReady() {}, renderError() {},
    close: record('close'), save: record('save'),
    saveWatermarkSettings: record('saveWatermarkSettings'),
    saveAnnotationWidth: record('saveAnnotationWidth'),
    copy: record('copy'), pin: record('pin'), pinAndReannotate: record('pinAndReannotate'),
    openRecognition: record('openRecognition'), ocr: record('ocr'), translate: record('translate'),
    startLongCapture: record('startLongCapture'), smartSelectAt: record('smartSelectAt'),
    startRegionRecording: record('startRegionRecording'), recordHistory: record('recordHistory')
  }
  window.__fire = __fire
`

const notes = []
const failures = []
function check(name, condition, detail = '') {
  const line = `${condition ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`
  ;(condition ? notes : failures).push(line)
}

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const stubPath = path.join(app.getPath('temp'), 'hl-width-probe-stub.js')
  fs.writeFileSync(stubPath, STUB)

  const win = new BrowserWindow({
    show: false,
    width: IMAGE_WIDTH,
    height: IMAGE_HEIGHT,
    useContentSize: true,
    // Mirrors the real capture window (main/domains/capture/index.js): without
    // this a hidden window throttles rAF, the resize handler never repaints and
    // the tool strip keeps its stale position.
    webPreferences: { contextIsolation: false, nodeIntegration: false, sandbox: false, backgroundThrottling: false, preload: stubPath }
  })
  const consoleErrors = []
  win.webContents.on('console-message', (event) => {
    const level = event && typeof event === 'object' ? event.level : ''
    const message = event && typeof event === 'object' ? event.message : ''
    if (level === 'error' || level >= 2) consoleErrors.push(String(message))
  })

  await win.loadFile(path.join(ROOT, 'capture', 'capture.html'))
  win.webContents.setZoomFactor(1)
  await sleep(600)

  // The image is built at the window's *actual* inner size so the exported
  // selection canvas is 1:1 with the source pixels (a 2px offset between the
  // requested and real content size would rescale every stroke).
  const init = async (annotationWidth) => {
    await win.webContents.executeJavaScript(`(async () => {
      const width = innerWidth; const height = innerHeight
      const canvas = document.createElement('canvas')
      canvas.width = width; canvas.height = height
      const context = canvas.getContext('2d')
      context.fillStyle = '#ffffff'; context.fillRect(0, 0, width, height)
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
      const buffer = await blob.arrayBuffer()
      window.__fire('init', {
        mode: 'fullscreen', source: 'probe', scaleFactor: 1, imageBuffer: buffer,
        settings: {
          mainColor: '#e5a44c',
          screenshot: { selectionMask: 'rgba(0,0,0,.46)', annotationWidth: ${JSON.stringify(annotationWidth)} }
        }
      })
    })()`)
    await sleep(900)
  }

  // Draws one horizontal line and reports, for the scanned column, the total ink
  // coverage (sum of alpha-weighted non-white pixels, which equals the painted
  // stroke width) plus every contiguous ink run so later lines cannot be confused
  // with earlier ones.
  const drawLine = (width, y, column = 300) => win.webContents.executeJavaScript(`(() => {
    document.querySelector('[data-annotation-width="${width}"]').click()
    document.querySelector('[data-tool="line"]').click()
    const stage = document.getElementById('stage')
    const send = (type, clientX, clientY) => stage.dispatchEvent(new PointerEvent(type, { clientX, clientY, bubbles: true, cancelable: true, pointerId: 1, isPrimary: true }))
    send('pointerdown', 100, ${y})
    send('pointermove', 700, ${y})
    send('pointerup', 700, ${y})
    const item = annotations[annotations.length - 1]
    try {
      const output = exportSelectionCanvas()
      const data = output.getContext('2d').getImageData(${column}, 0, 1, output.height).data
      const runs = []
      let current = null
      for (let row = 0; row < output.height; row += 1) {
        const offset = row * 4
        const green = data[offset + 1]
        const isInk = data[offset] > 180 && green < 200
        if (isInk && !current) current = { top: row, rows: 0, coverage: 0 }
        if (isInk) {
          current.rows += 1
          current.coverage += (255 - green) / 196
        } else if (current) {
          runs.push({ ...current, coverage: Math.round(current.coverage * 100) / 100 })
          current = null
        }
      }
      if (current) runs.push({ ...current, coverage: Math.round(current.coverage * 100) / 100 })
      return { runs, exported: { width: output.width, height: output.height }, state: annotationWidth, item: { width: item.width, y: item.y } }
    } catch (error) {
      return { error: String(error && error.message ? error.message : error) }
    }
  })()`)

  const inkRun = (result, y) => (result.runs || []).find((run) => Math.abs(run.top + run.rows / 2 - y) <= 6)

  await init(4)

  const layout = await win.webContents.executeJavaScript(`(() => {
    const toolbar = document.getElementById('toolbar').getBoundingClientRect()
    const group = document.getElementById('widthGroup').getBoundingClientRect()
    const buttons = [...document.querySelectorAll('#widthGroup button')].map((button) => {
      const rect = button.getBoundingClientRect()
      return { label: button.textContent, width: Math.round(rect.width), height: Math.round(rect.height), active: button.classList.contains('active'), pressed: button.getAttribute('aria-pressed') }
    })
    return { toolbar: { width: Math.round(toolbar.width), right: Math.round(toolbar.right) }, group: { width: Math.round(group.width) }, buttons, inner: { w: innerWidth, h: innerHeight } }
  })()`)

  check('three thickness buttons render', layout.buttons.length === 3, layout.buttons.map((b) => b.label).join('/'))
  check('default level is medium', layout.buttons[1].active && layout.buttons[1].pressed === 'true')
  check('buttons are not squeezed below the old 30px control', layout.buttons.every((b) => b.width >= 24 && b.height >= 28), `widths ${layout.buttons.map((b) => b.width).join('/')}`)

  const thin = await drawLine(2, 120)
  const medium = await drawLine(4, 240)
  const thick = await drawLine(8, 360)
  if (thin.error || medium.error || thick.error) {
    check('exported canvas is readable', false, thin.error || medium.error || thick.error)
  } else {
    const measured = [[thin, 2, 120], [medium, 4, 240], [thick, 8, 360]]
    for (const [result, width, y] of measured) {
      const run = inkRun(result, y)
      check(`level ${width}px paints ${width}px`, Boolean(run) && Math.abs(run.coverage - width) <= 0.6, `run=${JSON.stringify(run)}`)
    }
    check('each stroke sits on its own line', [thin, medium, thick].every((result, index) => Boolean(inkRun(result, [120, 240, 360][index]))))
    check('exported canvas keeps source pixel scale', thick.exported.width === layout.inner.w && thick.exported.height === layout.inner.h, `${thick.exported.width}x${thick.exported.height} vs viewport ${layout.inner.w}x${layout.inner.h}`)
  }

  // Switching level after committing an annotation must leave it untouched: the
  // thin line at y=120 has to stay 2px after an 8px line is added elsewhere.
  const recheck = await drawLine(8, 480)
  const thinAgain = inkRun(recheck, 120)
  check('existing annotation keeps its own width', thinAgain && Math.abs(thinAgain.rows - 2) <= 1, JSON.stringify({ thin: thinAgain, last: recheck.runs }))

  const persistence = await win.webContents.executeJavaScript(`(() => ({
    written: window.__calls.filter((call) => call.name === 'saveAnnotationWidth').map((call) => call.args[0]),
    pressed: [...document.querySelectorAll('#widthGroup button')].map((button) => button.getAttribute('aria-pressed'))
  }))()`)
  check('level choice is written back to settings', persistence.written.includes(8), JSON.stringify(persistence.written))
  check('only the clicked level is pressed', persistence.pressed.join(',') === 'false,false,true', persistence.pressed.join(','))

  const keyboard = await win.webContents.executeJavaScript(`(() => {
    window.__calls.length = 0
    document.querySelector('[data-annotation-width="8"]').focus()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    return { copies: window.__calls.filter((call) => call.name === 'copy').length }
  })()`)
  check('Enter on the picker does not trigger copy', keyboard.copies === 0, `copy calls=${keyboard.copies}`)

  await init(8)
  const restored = await win.webContents.executeJavaScript(`[...document.querySelectorAll('#widthGroup button')].map((button) => button.getAttribute('aria-pressed'))`)
  check('stored level is restored on init', restored.join(',') === 'false,false,true', restored.join(','))

  await init(9)
  const bogusRestored = await win.webContents.executeJavaScript(`[...document.querySelectorAll('#widthGroup button')].map((button) => button.getAttribute('aria-pressed'))`)
  check('an out-of-range stored level falls back to medium', bogusRestored.join(',') === 'false,true,false', bogusRestored.join(','))

  // Width budget: the old strip was already clamped at 866 px by its
  // max-width (calc(100vw - 20px)) on the reference viewport, so compare the new
  // natural width and the picker's own cost against the old 32 px select.
  const measureAt = async (width) => {
    win.setContentSize(width, IMAGE_HEIGHT)
    await sleep(400)
    await win.webContents.executeJavaScript('render()')
    await sleep(600)
    return win.webContents.executeJavaScript(`(() => {
      const toolbar = document.getElementById('toolbar').getBoundingClientRect()
      const group = document.getElementById('widthGroup').getBoundingClientRect()
      return { toolbar: Math.round(toolbar.width), right: Math.round(toolbar.right), group: Math.round(group.width), inner: innerWidth }
    })()`)
  }
  const wide = await measureAt(1440)
  const narrow = await measureAt(1024)
  check('picker costs no more than the 60px budget', wide.group - 32 <= 60, `picker ${wide.group}px vs old select 32px (+${wide.group - 32})`)
  check('natural strip width is measured', wide.toolbar > 0, `natural=${wide.toolbar} (old natural ≈ ${wide.toolbar - (wide.group - 32)}, old clamped 866)`)
  check('strip fits a 1024px viewport', narrow.right <= narrow.inner, `right=${narrow.right} inner=${narrow.inner}`)

  // Human-readable capture: the old defect was visible to the naked eye, so a
  // machine-readable assertion is not enough on its own.
  win.setContentSize(1440, IMAGE_HEIGHT)
  await sleep(500)
  const crop = await win.webContents.executeJavaScript(`(() => {
    const group = document.getElementById('widthGroup').getBoundingClientRect()
    const color = document.querySelector('.color-wrap').getBoundingClientRect()
    const bar = document.getElementById('toolbar').getBoundingClientRect()
    return { x: Math.max(0, Math.floor(color.x - 8)), y: Math.max(0, Math.floor(bar.y - 4)), width: Math.ceil(group.right + 8 - Math.max(0, Math.floor(color.x - 8))), height: Math.ceil(bar.height + 8) }
  })()`)
  const shot = await win.webContents.capturePage(crop)
  fs.writeFileSync(path.join(OUT, 'width-picker.png'), shot.toPNG())

  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

  win.destroy()
  console.log([...notes, ...failures].join('\n'))
  console.log(`\n${failures.length ? `${failures.length} check(s) failed` : 'all checks passed'} (artifact: ${path.relative(ROOT, path.join(OUT, 'width-picker.png'))})`)
  app.exit(failures.length ? 1 : 0)
})
