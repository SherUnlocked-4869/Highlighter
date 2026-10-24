// Prove the glass is real, not painted.
//
// The product's floating windows are created with `transparent: true`
// (main/services/selection-window-manager.js and the pin/record/long-capture
// domains), so a `backdrop-filter` inside them blurs the actual desktop behind
// the window — that is the material FILM is named for.
//
// A capturePage() of such a window returns the window's own composition with an
// ALPHA CHANNEL where nothing is painted. That is the proof this harness uses:
// if the strip's interior has alpha < 255 the surface really is translucent, and
// the alpha value tells us exactly how much of the desktop shows through. The
// composite that follows then puts a synthetic desktop behind it so a human can
// see what the user sees.
//
// Run with the Electron binary:
//   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe \
//     --no-sandbox design-demos/theme-2026/tools/probe-glass.js --surface=toolbar
const path = require('node:path')
const fs = require('node:fs')
const { app, BrowserWindow } = require('electron')

const ROOT = path.resolve(__dirname, '../../..')
const OUT = path.join(ROOT, 'design-demos', 'theme-2026', 'shots', 'glass')
fs.mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const surface = (process.argv.find((a) => a.startsWith('--surface=')) || '').slice('--surface='.length) || 'toolbar'

const SURFACES = {
  toolbar: {
    file: 'toolbar/toolbar.html',
    stub: 'landing-stub-floats.js',
    w: 620,
    h: 56,
    // The strip is the element itself, so its box is what we sample.
    selector: '.toolbar',
  },
}

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const spec = SURFACES[surface]
  if (!spec) { console.log('unknown surface:', surface); app.quit(); return }

  const win = new BrowserWindow({
    show: false,
    width: spec.w,
    height: spec.h,
    frame: false,
    // The setting under test: a transparent window is what lets backdrop-filter
    // reach the desktop instead of a flat colour.
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
      preload: path.join(__dirname, spec.stub),
    },
  })
  win.webContents.setBackgroundThrottling(false)

  const errors = []
  win.webContents.on('console-message', (e) => {
    const m = String((e && e.message) || '')
    if (m.toLowerCase().includes('error')) errors.push(m.slice(0, 120))
  })

  await win.loadFile(path.join(ROOT, spec.file))
  await sleep(1200)

  for (const theme of ['light', 'dark']) {
    await win.webContents.executeJavaScript(
      `document.body.classList.toggle('dark', ${theme === 'dark'})`)
    const freeze = await win.webContents.insertCSS('*{transition:none !important;animation:none !important}')
    await sleep(500)

    // Geometry of the glass surface inside the page, so the report can name what
    // it sampled instead of guessing coordinates.
    const box = await win.webContents.executeJavaScript(`(() => {
      const el = document.querySelector(${JSON.stringify(spec.selector)})
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
    })()`)

    const image = await win.webContents.capturePage()
    fs.writeFileSync(path.join(OUT, `${surface}-${theme}.png`), image.toPNG())
    const size = image.getSize()
    const bitmap = image.toBitmap() // BGRA
    const sample = (x, y) => {
      const at = (y * size.width + x) * 4
      return { b: bitmap[at], g: bitmap[at + 1], r: bitmap[at + 2], a: bitmap[at + 3] }
    }
    // Centre of the strip: must be translucent (alpha < 255) and not fully clear.
    const cx = box ? box.x + Math.round(box.w / 2) : Math.round(size.width / 2)
    const cy = box ? box.y + Math.round(box.h / 2) : Math.round(size.height / 2)
    const centre = sample(cx, cy)
    const corner = sample(1, 1)

    const row = {
      surface, theme,
      size: `${size.width}x${size.height}`,
      selectorBox: box,
      centre, corner,
      interiorTranslucent: centre.a > 0 && centre.a < 255,
      cornerTransparent: corner.a === 0,
      errors,
    }
    console.log(`${theme.padEnd(5)} ${surface.padEnd(8)} size=${row.size} centre=${JSON.stringify(centre)} ` +
      `translucent=${row.interiorTranslucent} cornerAlpha=${corner.a} errors=${errors.length}`)
    fs.writeFileSync(path.join(OUT, `REPORT-${surface}-${theme}.json`), JSON.stringify(row, null, 2))
    await win.webContents.removeInsertedCSS(freeze)
  }

  if (!win.isDestroyed()) win.destroy()
  app.quit()
})
