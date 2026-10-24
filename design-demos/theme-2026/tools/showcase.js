// Showcase capture: the REAL product windows, rendered with the landing stubs so
// they show populated content (a real selection + toolbar, real clipboard
// records, a real settings page), then composited into one image.
//
// Why not design-demos/tools/capture-electron.js: that harness exists to prove
// every surface renders without console errors, so it captures each window in
// its emptiest valid state (the capture overlay shows only its hint bar because
// a region selection is created by a drag, which it never performs). Those
// screenshots are correct for a regression gate and useless as a showcase.
//
// The palette is the product's own now (shared/tokens.css is B1), so nothing is
// injected: whatever these windows render IS what ships.
//
// Run with the Electron binary:
//   env -u ELECTRON_RUN_AS_NODE TMP=<in-repo> TEMP=<in-repo> \
//     ./node_modules/electron/dist/electron.exe --no-sandbox \
//     design-demos/theme-2026/tools/showcase.js
const path = require('node:path')
const fs = require('node:fs')
const { app, BrowserWindow } = require('electron')

const ROOT = path.resolve(__dirname, '../../..')
const OUT = path.join(ROOT, 'design-demos', 'theme-2026', 'shots', 'showcase')
fs.mkdirSync(OUT, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Hidden windows composite lazily, so a style change (or a drag that triggers a
// canvas repaint) can still be one frame behind when capturePage() runs. Two
// animation frames plus a discarded capture, same as the other harnesses here.
const settle = async (w, ms = 450) => {
  await w.webContents.executeJavaScript(`new Promise((resolve) => {
    let done = false
    const fin = () => { if (!done) { done = true; resolve('painted') } }
    requestAnimationFrame(() => requestAnimationFrame(fin))
    setTimeout(fin, 1200)
  })`)
  await w.webContents.capturePage()
  await sleep(ms)
}

const SURFACES = [
  { key: 'config-home', file: 'config/config.html', stub: 'landing-stub.js', w: 1120, h: 760, route: 'home' },
  { key: 'config-general', file: 'config/config.html', stub: 'landing-stub.js', w: 1120, h: 760, route: 'settings-general' },
  { key: 'config-models', file: 'config/config.html', stub: 'landing-stub.js', w: 1120, h: 760, route: 'models' },
  { key: 'capture', file: 'capture/capture.html', stub: 'landing-stub-capture.js', w: 900, h: 620 },
  { key: 'clipboard', file: 'clipboard/clipboard.html', stub: 'landing-stub-floats.js', w: 480, h: 640 },
  { key: 'toolbar', file: 'toolbar/toolbar.html', stub: 'landing-stub-floats.js', w: 620, h: 56 },
  { key: 'search', file: 'search/search.html', stub: 'landing-stub-search.js', w: 720, h: 520 },
]

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const windows = new Map()
  const getWindow = (stub, size) => {
    const existing = windows.get(stub)
    if (existing && !existing.isDestroyed()) {
      existing.setContentSize(size.w, size.h)
      return existing
    }
    const win = new BrowserWindow({
      show: false,
      width: size.w,
      height: size.h,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        preload: path.join(__dirname, stub),
      },
    })
    win.webContents.setBackgroundThrottling(false)
    windows.set(stub, win)
    return win
  }

  const results = []
  for (const surface of SURFACES) {
    const w = getWindow(surface.stub, surface)
    w.setContentSize(surface.w, surface.h)
    // Transparent for the overlays so the composite can put a desktop behind them.
    w.setBackgroundColor(surface.externalBackground ? '#00000000' : '#ebe5d8')
    try {
      await w.loadFile(path.join(ROOT, surface.file))
    } catch (err) {
      console.log(`FAIL ${surface.key}: ${err.message}`)
      continue
    }
    await sleep(1100)
    if (surface.route) {
      for (let i = 0; i < 14; i++) {
        const active = await w.webContents.executeJavaScript(
          `[...document.querySelectorAll('.nav-item.active')].map(b=>b.dataset.route)[0]||''`)
        if (active === surface.route) break
        await w.webContents.executeJavaScript(
          `(()=>{const b=document.querySelector('.nav-item[data-route="${surface.route}"]');if(b)b.click()})()`)
        await sleep(260)
      }
    }
    await settle(w)
    // Drive the search window from the harness instead of from inside its preload.
    // Timers inside a hidden window's preload are throttled and were unreliable
    // (the capture showed the empty state twice), so the query is typed here where
    // the call is observable, then the result list is polled.
    if (surface.key === 'search') {
      const ready = await w.webContents.executeJavaScript(`(() => {
        const input = document.getElementById('searchInput')
        if (!input) return 'no-input'
        input.focus()
        input.value = 'doc'
        input.dispatchEvent(new Event('input', { bubbles: true }))
        return 'typed'
      })()`)
      console.log(`     search: ${ready}`)
      for (let i = 0; i < 40; i++) {
        const rows = await w.webContents.executeJavaScript(
          `document.querySelectorAll('#resultList > *').length`)
        if (rows > 0) { console.log(`     search: ${rows} rows`); break }
        await sleep(120)
      }
    }

    // Both themes from one load: only the body class changes, exactly as the
    // product's own appearance broadcast does it.
    for (const theme of ['light', 'dark']) {
      await w.webContents.executeJavaScript(
        `document.body.classList.toggle('dark', ${theme === 'dark'})`)
      // Freeze transitions: a hidden window composites lazily, so a background
      // transition started by the class toggle can still be mid-flight at capture.
      const freeze = await w.webContents.insertCSS('*{transition:none !important;animation:none !important}')
      await settle(w)
      const image = await w.webContents.capturePage()
      const file = path.join(OUT, `${surface.key}-${theme}.png`)
      fs.writeFileSync(file, image.toPNG())
      const size = image.getSize()
      console.log(`ok   ${(surface.key + '-' + theme).padEnd(24)} ${size.width}x${size.height}`)
      results.push({ key: surface.key, theme, file, ...size })
      await w.webContents.removeInsertedCSS(freeze)
    }
  }

  for (const w of windows.values()) if (!w.isDestroyed()) w.destroy()
  fs.writeFileSync(path.join(OUT, 'MANIFEST.json'), JSON.stringify(results, null, 2))
  console.log('\ncaptured', results.length, 'surfaces')
  app.quit()
})
