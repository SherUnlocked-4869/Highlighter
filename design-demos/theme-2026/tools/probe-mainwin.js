// HISTORICAL (2026-10-24): this probe answered "can the SETTINGS window be
// translucent, with a self-drawn shadow replacing the native one?" during the
// experiment that was rejected twice. The shipped settings window is the `opaque`
// variant below (the only one still current); the transparent/acrylic/mica
// variants are the rejected candidates, kept as the measurement record.
//
// The user HAD asked for the main window to show the desktop through it, not just
// the in-window glass that landed in the previous pass. That is a WINDOW-level
// change with three consequences that had to be measured rather than assumed:
//
//   1. `transparent: true` removes the OS-drawn frame shadow. A frameless window
//      then has no drop shadow at all unless the page draws one, and a page shadow
//      is only visible if the window is bigger than its content — otherwise it is
//      clipped at the window bounds (the exact bug the selection toolbar hit).
//   2. It also removes the native rounded corners: the page must clip itself and
//      the four corner cut-outs become transparent, which changes what
//      main/services/window-backdrop.js exists to guarantee.
//   3. `backgroundMaterial` (mica/acrylic) is a Windows-native material that keeps
//      the OS shadow. It is the lower-risk option IF it renders.
//
// This probe renders the real config.html under each candidate and reports, for
// each: the corner alpha (is the cut-out actually transparent?), the interior
// alpha (is the shell translucent?), and whether an outer shadow survives.
//
// One variant per process: these are constructor options and this repo documents
// that creating a second Electron 43 window and loading a file into it fails.
const path = require('node:path')
const fs = require('node:fs')
const { app, BrowserWindow, nativeTheme } = require('electron')

const ROOT = path.resolve(__dirname, '../../..')
const OUT = path.join(ROOT, 'design-demos', 'theme-2026', 'shots', 'mainwin')
fs.mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const variant = (process.argv.find((a) => a.startsWith('--variant=')) || '').slice('--variant='.length) || 'opaque'
const theme = (process.argv.find((a) => a.startsWith('--theme=')) || '').slice('--theme='.length) || 'light'

// The settings window is 1120x760. Each variant gets extra padding around the
// page so a page-drawn shadow would have room to exist; the padding is reported so
// the difference between "shadow drawn" and "shadow clipped" is measurable.
const VARIANTS = {
  // Today's shipped configuration: opaque, native backdrop colour.
  opaque: { options: { backgroundColor: '#ebe5d8' }, pad: 0, shadow: false },
  // Full transparency, the frame sized exactly to the page (shadow WOULD clip).
  transparent: { options: { transparent: true, backgroundColor: '#00000000' }, pad: 0, shadow: false },
  // Full transparency with 34px of padding so a page-drawn shadow has room.
  'transparent-pad': { options: { transparent: true, backgroundColor: '#00000000' }, pad: 34, shadow: true },
  // Native Windows material: keeps the OS shadow, blurs the desktop behind.
  acrylic: { options: { backgroundMaterial: 'acrylic', backgroundColor: '#00000000' }, pad: 0, shadow: false },
  mica: { options: { backgroundMaterial: 'mica', backgroundColor: '#00000000' }, pad: 0, shadow: false },
}

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const spec = VARIANTS[variant]
  if (!spec) { console.log('unknown variant:', variant); app.quit(); return }
  nativeTheme.themeSource = theme === 'dark' ? 'dark' : 'light'

  const pad = spec.pad
  let win
  try {
    win = new BrowserWindow({
      show: false,
      width: 1120 + pad * 2,
      height: 760 + pad * 2,
      frame: false,
      hasShadow: true,
      ...spec.options,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    })
    win.webContents.setBackgroundThrottling(false)
    const errors = []
    win.webContents.on('console-message', (e) => {
      const m = String((e && e.message) || '')
      if (m.toLowerCase().includes('error')) errors.push(m.slice(0, 120))
    })

    await win.loadFile(path.join(ROOT, 'config', 'config.html'))
    // The real window boots from its preload; without a main process it shows its
    // skeletal shell, which is all this probe needs (backgrounds + corners).
    await sleep(1200)
    await win.webContents.executeJavaScript(`document.body.classList.toggle('dark', ${theme === 'dark'})`)

    // In the padded variants, inset the shell so the page can draw a shadow in the
    // ring around it — this is the layout the shipped CSS would need.
    if (pad > 0) {
      await win.webContents.insertCSS(`
        html,body{background:transparent !important}
        .window-shell{position:absolute !important;inset:${pad}px !important;
          box-shadow:0 8px 18px rgba(52,38,20,.20), 0 40px 80px -24px rgba(52,38,20,.42) !important;
          border-radius:calc(var(--radius-lg) + 4px) !important;
          overflow:hidden !important;
          background:rgba(247,243,234,.72) !important;
          -webkit-backdrop-filter:blur(26px) saturate(1.22);backdrop-filter:blur(26px) saturate(1.22)}
      `)
    } else if (spec.options.transparent || spec.options.backgroundMaterial) {
      // Frame exactly matches the page: make the shell itself the glass.
      // html/body paint --bg themselves (config.css:18), which is what made the
      // interior opaque in the first run even though the window was transparent:
      // the window WAS clear, the page simply painted over it. Both have to go.
      await win.webContents.insertCSS(`
        html,body{background:transparent !important;background-color:transparent !important}
        #view,.workspace{background:transparent !important}
        .window-shell{background:rgba(247,243,234,.72) !important;
          -webkit-backdrop-filter:blur(26px) saturate(1.22);backdrop-filter:blur(26px) saturate(1.22)}
      `)
    }
    const freeze = await win.webContents.insertCSS('*{transition:none !important;animation:none !important}')
    await sleep(700)

    const image = await win.webContents.capturePage()
    const png = image.toPNG()
    const name = `${variant}-${theme}`
    fs.writeFileSync(path.join(OUT, `${name}.png`), png)
    const size = image.getSize()
    const bitmap = image.toBitmap() // BGRA
    const sample = (x, y) => {
      const at = (y * size.width + x) * 4
      return { b: bitmap[at], g: bitmap[at + 1], r: bitmap[at + 2], a: bitmap[at + 3] }
    }
    // Corner (outside the rounded shell), shell interior, and the padding ring
    // where a page-drawn shadow would land.
    const cornerOuter = sample(2, 2)
    const interior = sample(Math.round(size.width / 2), Math.round(size.height / 2))
    const ring = pad > 0 ? sample(6, Math.round(size.height / 2)) : null

    const stack = await win.webContents.executeJavaScript(`(() => {
      const el = document.elementFromPoint(innerWidth/2, innerHeight/2)
      const chain = []
      let cur = el
      while (cur && chain.length < 8) {
        const cs = getComputedStyle(cur)
        chain.push({
          tag: cur.tagName.toLowerCase() + (cur.id ? '#' + cur.id : '') + (typeof cur.className === 'string' && cur.className ? '.' + cur.className.split(' ')[0] : ''),
          bg: cs.backgroundColor,
          img: cs.backgroundImage === 'none' ? '' : 'image',
          alpha: cs.backgroundColor.startsWith('rgba') ? cs.backgroundColor : 'opaque'
        })
        cur = cur.parentElement
      }
      return chain
    })()`)

    const row = {
      variant, theme, size: `${size.width}x${size.height}`, stack,
      cornerAlpha: cornerOuter.a,
      cornerIsClear: cornerOuter.a === 0,
      interior,
      interiorTranslucent: interior.a > 0 && interior.a < 255,
      shadowRing: ring,
      shadowVisible: ring ? ring.a > 2 : false,
      errors,
    }
    console.log(JSON.stringify(row))
    fs.writeFileSync(path.join(OUT, `REPORT-${name}.json`), JSON.stringify(row, null, 2))
  } catch (err) {
    console.log(JSON.stringify({ variant, theme, error: String(err.message).slice(0, 200) }))
  } finally {
    if (win && !win.isDestroyed()) win.destroy()
    app.quit()
  }
})
