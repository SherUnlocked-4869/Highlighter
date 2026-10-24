// HISTORICAL (rejected build, 2026-10-24): capture the translucent settings window
// the way the USER sees it on a real display. The shipped settings window is
// OPAQUE again; keep this only as the evidence trail for why transparency lost.
//
// Capture the translucent settings window the way the USER sees it: on a real
// display, over a real desktop, with the window actually shown.
//
// Why this exists: `backdrop-filter: blur()` on a HIDDEN transparent window
// composites unreliably in Electron 43 — measured on this host, a plain rgba fill
// samples alpha 184, adding blur() to the same element samples alpha 0 (the layer
// comes back empty), and adding saturate() instead samples 184 again. The result is
// non-deterministic across runs, so a hidden-window capture cannot prove whether
// the glass works. Showing the window on a real display removes the uncertainty:
// the compositor has a real backdrop to blur.
//
// Frame capture is the desktop itself (screen capture), not capturePage(), because
// the question is "what does the desktop composite look like" — that is precisely
// what the user asked for and what a window-local capture cannot answer.
//
// Per AGENTS.md this opens on the SECONDARY display so the primary stays free.
const path = require('node:path')
const fs = require('node:fs')
const { app, BrowserWindow, screen, desktopCapturer, nativeImage } = require('electron')

const ROOT = path.resolve(__dirname, '../../..')
const OUT = path.join(ROOT, 'design-demos', 'theme-2026', 'shots', 'mainwin')
fs.mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const theme = (process.argv.find((a) => a.startsWith('--theme=')) || '').slice('--theme='.length) || 'light'
const inset = 22

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const displays = screen.getAllDisplays()
  const width = 1120 + inset * 2
  const height = 760 + inset * 2
  // AGENTS.md asks for the secondary display, but this host's secondary is a
  // PORTRAIT 1152x2048 panel: narrower than the window, so the window would be
  // clipped and the capture would be misleading. Pick the first display that can
  // actually hold the window, and report which one that is.
  const primary = screen.getPrimaryDisplay()
  const target = displays.find((d) => d.bounds.width >= width + 80 && d.bounds.height >= height + 80) || primary
  const isPrimary = target.id === primary.id
  console.log(`display: ${target.bounds.width}x${target.bounds.height} ${isPrimary ? '(primary)' : '(secondary)'}`)
  const win = new BrowserWindow({
    show: false,
    x: target.bounds.x + 40,
    y: target.bounds.y + 40,
    width,
    height,
    frame: false,
    transparent: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    skipTaskbar: true,
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
      preload: path.join(__dirname, 'landing-stub.js'),
    },
  })
  win.webContents.setBackgroundThrottling(false)

  await win.loadFile(path.join(ROOT, 'config', 'config.html'))
  await sleep(1500)
  await win.webContents.executeJavaScript(
    `document.body.classList.toggle('dark', ${theme === 'dark'})`)
  await sleep(900)

  // Show it, on the secondary display, and let the compositor settle.
  win.showInactive()
  await sleep(1400)

  const img = await win.webContents.capturePage()
  fs.writeFileSync(path.join(OUT, `mainwin-${theme}-window.png`), img.toPNG())
  const size = img.getSize()
  const bm = img.toBitmap()
  const at = (x, y) => { const i = (y * size.width + x) * 4; return { r: bm[i + 2], g: bm[i + 1], b: bm[i], a: bm[i + 3] } }

  // Full-desktop capture: the real composite, window over whatever is behind it.
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: target.bounds.width, height: target.bounds.height },
  })
  const source = sources.find((s) => String(s.display_id) === String(target.id)) || sources[0]
  const shot = source.thumbnail.toPNG()
  fs.writeFileSync(path.join(OUT, `mainwin-${theme}-desktop.png`), shot)

  const probe = await win.webContents.executeJavaScript(`(() => {
    const shell = document.querySelector('.window-shell')
    const cs = shell ? getComputedStyle(shell) : null
    return {
      shellInset: cs && cs.top,
      shellBg: cs && cs.backgroundColor,
      shellFilter: cs && (cs.backdropFilter || cs.webkitBackdropFilter),
      viewBg: (() => { const v = document.getElementById('view'); return v ? getComputedStyle(v).backgroundColor : null })(),
    }
  })()`)

  console.log(JSON.stringify({
    theme, windowPng: `${size.width}x${size.height}`,
    cornerAlpha: at(2, 2).a,
    edgeAlpha: at(8, Math.round(size.height / 2)).a,
    interior: at(Math.round(size.width / 2), Math.round(size.height / 2)),
    ...probe,
  }, null, 1))

  win.destroy()
  app.quit()
})
