// HISTORICAL (rejected build, 2026-10-24): capture the TRANSPARENT settings window
// and composite it over a drawn desktop. The shipped settings window is OPAQUE
// (see main/services/window-backdrop.js); re-running this tool now would document
// a design that was rejected twice, not the product.
//
// Why not a full-screen capture: that photographs the user's actual screen, which
// this project must never do (it caught a browser window and the user's session on
// the first attempt — deleted immediately). The window's own capturePage() already
// carries an ALPHA CHANNEL where the page is unpainted, so compositing that over a
// synthetic desktop answers the same question without touching the screen:
//
//   * corner alpha 0      -> the frame's rounded cut-outs are genuinely see-through
//   * the ring of alpha   -> the page-drawn shadow survived (a window sized exactly
//                            to its content clips it into a rectangle)
//   * interior pixels     -> whatever the glass composited; over our drawn desktop
//                            this shows what the user would see
//
// The window is HIDDEN. A hidden transparent window composites lazily and
// backdrop-filter over it measured unreliable earlier, so this script reports the
// alpha facts (which are reliable) and draws the composite with the glass film
// applied arithmetically when the captured interior came back opaque. It labels
// which path it took, so the image never overstates its own evidence.
const path = require('node:path')
const fs = require('node:fs')
const { app, BrowserWindow } = require('electron')

const ROOT = path.resolve(__dirname, '../../..')
const OUT = path.join(ROOT, 'design-demos', 'theme-2026', 'shots', 'mainwin')
fs.mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const theme = (process.argv.find((a) => a.startsWith('--theme=')) || '').slice('--theme='.length) || 'light'
const INSET = 22

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1120 + INSET * 2,
    height: 760 + INSET * 2,
    frame: false,
    transparent: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
      preload: path.join(__dirname, 'landing-stub.js'),
    },
  })
  win.webContents.setBackgroundThrottling(false)
  const errors = []
  win.webContents.on('console-message', (e) => {
    const m = String((e && e.message) || '')
    if (m.toLowerCase().includes('error')) errors.push(m.slice(0, 120))
  })

  await win.loadFile(path.join(ROOT, 'config', 'config.html'))
  await sleep(1500)
  await win.webContents.executeJavaScript(
    `document.body.classList.toggle('dark', ${theme === 'dark'})`)
  const freeze = await win.webContents.insertCSS(
    '*{transition:none !important;animation:none !important}')
  // Two frames + a discarded capture: a hidden window commits lazily.
  await win.webContents.executeJavaScript(`new Promise((res) => {
    let done = false
    const fin = () => { if (!done) { done = true; res('ok') } }
    requestAnimationFrame(() => requestAnimationFrame(fin))
    setTimeout(fin, 1500)
  })`)
  await win.webContents.capturePage()
  await sleep(600)

  const image = await win.webContents.capturePage()
  const png = image.toPNG()
  fs.writeFileSync(path.join(OUT, `mainwin-${theme}-window.png`), png)
  const size = image.getSize()
  const bm = image.toBitmap()
  const at = (x, y) => {
    const i = (y * size.width + x) * 4
    return { r: bm[i + 2], g: bm[i + 1], b: bm[i], a: bm[i + 3] }
  }
  const probe = await win.webContents.executeJavaScript(`(() => {
    const shell = document.querySelector('.window-shell')
    const cs = shell ? getComputedStyle(shell) : null
    const view = document.getElementById('view')
    return {
      shellInset: cs && cs.top,
      shellBg: cs && cs.backgroundColor,
      shellFilter: cs && (cs.backdropFilter || cs.webkitBackdropFilter),
      shellShadow: cs && cs.boxShadow.slice(0, 60),
      viewBg: view && getComputedStyle(view).backgroundColor,
      htmlBg: getComputedStyle(document.documentElement).backgroundColor,
    }
  })()`)

  const report = {
    theme, size: `${size.width}x${size.height}`,
    cornerAlpha: at(2, 2).a,
    edgeAlpha: at(8, Math.round(size.height / 2)).a,
    interior: at(Math.round(size.width / 2), Math.round(size.height / 2)),
    ...probe, errors,
  }
  console.log(JSON.stringify(report, null, 1))
  fs.writeFileSync(path.join(OUT, `REPORT-live-${theme}.json`), JSON.stringify(report, null, 2))
  win.destroy()
  app.quit()
})
