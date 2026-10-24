// HISTORICAL (rejected build, 2026-10-24): can the settings window actually be made
// translucent on this host? The shipped window is OPAQUE again; the probe answers a
// question the product no longer asks, and is kept only as the measurement record.
//
// Can the settings window actually be made translucent on this host?
//
// The 2026 theme's premise is a ladder of floating glass surfaces
// (design-demos/theme-2026/dir-2.html: z1 window / z2 panel / z3 overlay, each
// rgba + backdrop-filter). The first landing dropped the material and shipped
// opaque fills — that is why the delivered screenshots lost the translucency the
// direction was chosen for.
//
// Transparency in Electron is a WINDOW-level property, not a CSS one: a CSS
// backdrop-filter can only blur what is already composited INSIDE the window. To
// see the desktop through it, the native window must be transparent
// (`transparent: true`) or use a Windows background material
// (`backgroundMaterial: 'acrylic' | 'mica'`).
//
// Each variant has to be probed in its OWN process: those are constructor-time
// options, and this repo already documents (design-demos/tools/capture-electron.js)
// that creating a second Electron 43 window and loading a file into it fails with
// ERR_FAILED. So the script takes a variant name and the caller runs it once per
// variant:
//
//   for v in opaque transparent acrylic mica; do
//     ./node_modules/electron/dist/electron.exe --no-sandbox \
//       design-demos/theme-2026/tools/probe-transparency.js --variant=$v
//   done
const path = require('node:path')
const fs = require('node:fs')
const { app, BrowserWindow, nativeTheme } = require('electron')

const ROOT = path.resolve(__dirname, '../../..')
const OUT = path.join(ROOT, 'design-demos', 'theme-2026', 'shots', 'probe')
fs.mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const variant = (process.argv.find((a) => a.startsWith('--variant=')) || '').slice('--variant='.length) || 'opaque'

// A page that paints the REAL config window's background stack (the shipped
// tokens) over a transparent body, so the capture shows whether the desktop or a
// flat colour comes through.
const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="../../shared/tokens.css">
<style>
  html,body{margin:0;height:100%;background:transparent;overflow:hidden;font:14px/1.5 "Segoe UI"}
  .shell{position:absolute;inset:16px;border-radius:var(--radius-lg);overflow:hidden;
    background:rgba(247,243,234,.72);
    -webkit-backdrop-filter:blur(26px) saturate(1.22);
    backdrop-filter:blur(26px) saturate(1.22);
    box-shadow:var(--shadow-3);border:1px solid rgba(207,196,176,.8)}
  .panel{position:absolute;left:24px;top:24px;right:24px;height:120px;border-radius:12px;
    background:rgba(255,255,255,.42);
    -webkit-backdrop-filter:blur(14px) saturate(1.1);
    backdrop-filter:blur(14px) saturate(1.1);
    box-shadow:var(--shadow-1)}
  .row{position:absolute;left:24px;top:170px;right:24px;height:52px;border-radius:10px;
    background:rgba(255,253,247,.62);
    -webkit-backdrop-filter:blur(10px);
    backdrop-filter:blur(10px)}
  h1{position:absolute;left:44px;top:44px;margin:0;font-size:22px;color:var(--ink)}
  p{position:absolute;left:44px;top:84px;margin:0;color:var(--muted)}
  .tag{position:absolute;left:44px;top:196px;color:var(--ink)}
</style></head>
<body>
  <div class="shell"><div class="panel"></div><div class="row"></div>
    <h1>Glass probe · ${variant}</h1>
    <p>If the desktop shows through, the shell is translucent.</p>
    <div class="tag">z1 shell .72 + blur 26 · z2 panel .42 + blur 14 · z3 row .62</div>
  </div>
</body></html>`

const VARIANTS = {
  opaque: { backgroundColor: '#ebe5d8' },
  transparent: { transparent: true, backgroundColor: '#00000000' },
  acrylic: { transparent: true, backgroundColor: '#00000000', backgroundMaterial: 'acrylic' },
  mica: { transparent: true, backgroundColor: '#00000000', backgroundMaterial: 'mica' },
}

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const pagePath = path.join(OUT, 'glass-probe.html')
  fs.writeFileSync(pagePath, PAGE)

  const options = VARIANTS[variant]
  if (!options) {
    console.log('unknown variant:', variant)
    app.quit()
    return
  }

  let win
  try {
    win = new BrowserWindow({
      show: false,
      width: 760,
      height: 460,
      frame: false,
      hasShadow: false,
      ...options,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    })
    const errors = []
    win.webContents.on('console-message', (e) => {
      const m = String((e && e.message) || '')
      if (m.toLowerCase().includes('error')) errors.push(m.slice(0, 100))
    })
    await win.loadFile(pagePath)
    await sleep(1000)
    const image = await win.webContents.capturePage()
    fs.writeFileSync(path.join(OUT, `glass-${variant}.png`), image.toPNG())
    const size = image.getSize()
    const bitmap = image.toBitmap()
    // BGRA, top-left origin.
    const sample = (x, y) => {
      const at = (y * size.width + x) * 4
      return [bitmap[at + 2], bitmap[at + 1], bitmap[at], bitmap[at + 3]]
    }
    const centre = sample(Math.round(size.width / 2), Math.round(size.height / 2))
    const corner = sample(2, 2)          // outside the shell: must be transparent
    const hole = sample(Math.round(size.width / 2), 8)
    const row = { variant, size: `${size.width}x${size.height}`, centre, corner, hole, errors }
    const cornerTransparent = corner[3] === 0
    console.log(`${variant.padEnd(12)} corner=${JSON.stringify(corner)} alpha0=${cornerTransparent} centre=${JSON.stringify(centre)} errors=${errors.length}`)
    fs.writeFileSync(path.join(OUT, `REPORT-${variant}.json`), JSON.stringify(row, null, 2))
  } catch (err) {
    console.log(`${variant.padEnd(12)} FAILED: ${String(err.message).slice(0, 160)}`)
    fs.writeFileSync(path.join(OUT, `REPORT-${variant}.json`), JSON.stringify({ variant, error: String(err.message) }, null, 2))
  } finally {
    if (win && !win.isDestroyed()) win.destroy()
    console.log('platform:', process.platform, '| dark:', nativeTheme.shouldUseDarkColors, '| os:', require('node:os').release())
    app.quit()
  }
})
