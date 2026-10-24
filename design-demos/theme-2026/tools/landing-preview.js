// Landing preview: does a direction survive contact with the REAL app window?
//
// The three theme-2026 directions were built in their own prototype DOM, with
// their own token names (--s0 / --glass / --enamel). The real product has 12
// window stylesheets that consume a different token set (--bg / --surface /
// --line / --ink / --muted / --primary / --radius / --font-*). A direction that
// only looks right inside its own prototype is a sketch, not a theme.
//
// This harness takes a direction's colour decisions, maps them onto the
// product's token names, injects that mapping into the real renderer through
// webContents.insertCSS (the window CSPs are style-src 'self', so a DOM <style>
// would be dropped), and captures the real config window. Nothing in the repo is
// modified: the overlay exists only for the duration of one capture.
//
// Run with the Electron binary, not node (see AGENTS.md "Running the Electron
// test gates"):
//   env -u ELECTRON_RUN_AS_NODE TMP=<in-repo> TEMP=<in-repo> \
//     ./node_modules/electron/dist/electron.exe --no-sandbox \
//     design-demos/theme-2026/tools/landing-preview.js
const path = require('node:path')
const fs = require('node:fs')
const { app, BrowserWindow } = require('electron')

const ROOT = path.resolve(__dirname, '../../..')
const OUT = path.join(ROOT, 'design-demos', 'theme-2026', 'shots', 'landing')
fs.mkdirSync(OUT, { recursive: true })

// The product token contract these overlays must fill. Taken from
// shared/tokens.css (:root + body.dark) — every name the window stylesheets
// actually consume. A direction may not need all of them, but anything it does
// not set keeps the Nightshift value, which is exactly what a partial landing
// would look like in production.
// NOTE: a bare declaration at the top of a stylesheet is not valid CSS. The
// parser folds it into the NEXT selector and then discards that whole rule as an
// invalid one — which silently swallowed the first token block here and made the
// overlay look like a cascade problem instead of a syntax problem. Every
// declaration below is therefore inside a rule.
const base = (theme) => `
  html, body { color-scheme: ${theme}; }
`

// ── A1 · 哑光器物 ─────────────────────────────────────────────────────────────
// Source of truth: src/dir-1.html [data-theme] blocks (--s0..--s3 surface ladder,
// --bench, --press, --ink1/2, --cut/--lit seams). Mapping rule: the product's
// --bg is the bench, --surface the panel, --surface-2/3 the raised steps; the
// seam pair becomes --line/--line-2. Warm accent stays the one user colour.
// A1 needs one token the product does not have yet: `--chrome`, the side wall.
// config.css paints .sidebar and .card from the SAME --surface, and #view from
// --bg, so "chassis one step darker than the panel" cannot be expressed by
// re-colouring the existing ladder — the first landing attempt put the dark bench
// in the content area and left the sidebar lighter, i.e. the direction's signature
// inverted. `chrome` is passed separately and applied to .sidebar only.
const MATTE = {
  light: {
    bg: '#bfc2c7', surface: '#cfd2d6', surface2: '#c9ccd0', surface3: '#d3d6d9',
    line: '#aeb1b6', line2: '#9a9ea4',
    ink: '#15181b', ink2: '#333940', muted: '#343a42', faint: '#3d434b',
    chrome: '#8a9096',
    radius: '5px',
    // The product's status colours were tuned against a near-white surface
    // (--ok #2e7d51 is 5.00:1 on #fffefb but only 2.82:1 on this bench). A mid-tone
    // surface therefore needs its own status values; dropping the shipped ones on
    // it silently fails AA. These are the same hues, darkened until every A1
    // surface clears 4.6:1 (see the measurement in TOKENS-PLAN.md).
    ok: '#1c4f32', warn: '#5a430d', danger: '#831f18',
    // accent-as-text on a mid-tone bench needs ~L0.35, not the shipped 0.48
    primaryText: '#6b4a12',
  },
  dark: {
    bg: '#15171b', surface: '#1f2227', surface2: '#1d2025', surface3: '#262a2f',
    line: '#2a2e34', line2: '#383d44',
    ink: '#e6e9ec', ink2: '#b6bcc3', muted: '#9aa2aa', faint: '#8f979f',
    chrome: '#0e1013',
    radius: '5px',
    ok: '#63b98a', warn: '#d9a94a', danger: '#e0736a',
  },
}

// ── B1 · 浮层优先 ─────────────────────────────────────────────────────────────
// Source: src/dir-2.html (--canvas, --glass*, --ink, --hair, --sh). Warm neutral
// surfaces; depth is the elevation ladder, hairlines are translucent rather than
// solid. The window itself stays opaque here because the product's main window is
// a normal frame:false window, not a floating panel.
const FILM = {
  light: {
    bg: '#ebe5d8', surface: '#f7f3ea', surface2: '#fbf7ef', surface3: '#fffdf7',
    line: '#e2d9c9', line2: '#cfc4b0',
    ink: '#1d1a16', ink2: '#3c362d', muted: '#4f4839', faint: '#5f5747',
    radius: '13px',
  },
  dark: {
    bg: '#191713', surface: '#24211c', surface2: '#2d2923', surface3: '#38332b',
    line: '#3a352d', line2: '#4b453b',
    ink: '#f4efe4', ink2: '#cfc7b8', muted: '#b3aa96', faint: '#a89f8b',
    radius: '13px',
  },
}

// ── C2 · 珐琅铭牌 ─────────────────────────────────────────────────────────────
// Source: src/dir-3.html (--enamel, --plate-*, --ink, --accent). For the product
// window the enamel becomes the surface ladder and the plate ring becomes the
// hairline; the serif body face is the direction's most opinionated decision, so
// it is previewed too.
const ENAMEL = {
  light: {
    bg: '#efe6d2', surface: '#faf3e2', surface2: '#f4ebd7', surface3: '#e9dfc6',
    line: '#d9c9a8', line2: '#c4b193',
    ink: '#241c12', ink2: '#463a29', muted: '#5a4c37', faint: '#63543e',
    radius: '6px',
  },
  dark: {
    bg: '#171310', surface: '#221d18', surface2: '#2a241e', surface3: '#332b23',
    line: '#4a3d2c', line2: '#5d4c37',
    ink: '#f4e9d2', ink2: '#d8cbb0', muted: '#c0b194', faint: '#b6a78a',
    radius: '6px',
  },
}

const DIRECTIONS = [
  { id: 'matte', name: 'A1 哑光器物', map: MATTE, serif: false, grain: true },
  { id: 'film', name: 'B1 浮层优先', map: FILM, serif: false, grain: false },
  { id: 'enamel', name: 'C2 珐琅铭牌', map: ENAMEL, serif: true, grain: false },
]

// A single 90x90 SVG noise, base64-free (percent-encoded) so it survives a CSS
// string without touching the CSP: the data: scheme is allowed by every window's
// img-src, and the grain is the whole point of the matte direction.
const GRAIN = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='90' height='90'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='90' height='90' filter='url(%23n)' opacity='.055'/%3E%3C/svg%3E\")"

const overlay = (dir, theme) => {
  const t = dir.map[theme]
  const serifStack = '"Noto Serif SC","Songti SC","Microsoft YaHei UI",serif'
  const uiStack = '"Segoe UI Variable Text","Segoe UI","Microsoft YaHei UI","Microsoft YaHei",system-ui,sans-serif'
  return `${base(theme)}
  /* insertCSS lands in the author origin BEFORE the document's own sheets, so a
     plain declaration loses the cascade to tokens.css. !important is the only
     correct way to express "this overlay outranks the shipped tokens" — it is a
     preview harness, not a patch. */
  :root, body.dark {
    --bg:${t.bg} !important; --surface:${t.surface} !important;
    --surface-2:${t.surface2} !important; --surface-3:${t.surface3} !important;
    --line:${t.line} !important; --line-2:${t.line2} !important;
    --ink:${t.ink} !important; --ink-2:${t.ink2} !important;
    --muted:${t.muted} !important; --faint:${t.faint} !important;
    ${t.ok ? `--ok:${t.ok} !important; --warn:${t.warn} !important; --danger:${t.danger} !important;` : ''}
    ${t.primaryText ? `--primary-text:${t.primaryText} !important;` : ''}
    --radius:${t.radius} !important;
    ${dir.serif ? `--font-ui:${serifStack} !important; --font-display:${serifStack} !important;` : ''}
  }
  /* aliases the window stylesheets actually read */
  :root, body.dark {
    --panel:var(--surface) !important; --panel-soft:var(--surface-2) !important;
    --text:var(--ink) !important; --text-dim:var(--muted) !important; --border:var(--line) !important;
    --surface-hover:var(--surface-2) !important; --surface-active:var(--surface-3) !important;
  }
  ${t.chrome ? `
  /* A1: the chassis side wall. One extra token, applied where the product paints
     the sidebar; without it the direction's "body darker than panel" reads
     inverted in the real window. */
  .sidebar{ background: ${t.chrome} !important; }` : ''}
  ${dir.grain ? `
  /* A1: the matte bench. The grain rides on the shell, not on every element, so
     it reads as one material rather than as texture soup. */
  html, body{background-image:${GRAIN} !important;background-repeat:repeat !important}
  .window-shell{background-image:${GRAIN} !important;background-repeat:repeat !important}
  .sidebar,.titlebar,#view,.status-rail{background-image:${GRAIN} !important;background-repeat:repeat !important}` : ''}`
}

const CONTRAST_PROBE = `(() => {
          // Contrast audit in the REAL window: every visible text node with its
          // own background stack, measured with the same WCAG formula the design
          // lint uses. This is the gate that catches "a direction that only works
          // in its own prototype" — e.g. light card faces left over from the
          // shipped stylesheet under a dark token set.
          //
          // Colours MUST go through canvas. getComputedStyle returns
          // color(srgb 0.11 0.1 0.086) for color-mix()/oklch() results, and a
          // naive digit-scrape parse reads those 0..1 floats as 0..255 — which
          // reported the sidebar wordmark at 1.09:1 and every nav item at 2.75:1.
          // Painting one pixel and reading it back normalises every CSS colour
          // function the same way, so the measurement cannot drift from the
          // renderer. (design_lint.py does the same thing for the same reason.)
          const cv = document.createElement('canvas')
          cv.width = cv.height = 1
          const cx = cv.getContext('2d', { willReadFrequently: true })
          const cache = new Map()
          const rgba = (s) => {
            if (!s || s === 'transparent' || s === 'none') return [0, 0, 0, 0]
            if (cache.has(s)) return cache.get(s)
            cx.clearRect(0, 0, 1, 1)
            cx.fillStyle = '#000'
            cx.fillStyle = s
            cx.fillRect(0, 0, 1, 1)
            const d = cx.getImageData(0, 0, 1, 1).data
            // alpha: the trailing component of rgb()/hsl()/color(srgb .../ a)
            let a = 1
            const inner = (/\(([^)]*)\)/.exec(s) || [])[1] || ''
            const parts = inner.split(/[\\s,/]+/).filter(Boolean)
            const tail = inner.includes('/') ? parts[parts.length - 1]
              : (/^(rgba|hsla)\\(/.test(s) && parts.length === 4 ? parts[3] : null)
            if (tail != null) a = String(tail).endsWith('%') ? parseFloat(tail) / 100 : parseFloat(tail)
            const out = [d[0], d[1], d[2], Number.isFinite(a) ? a : 1]
            cache.set(s, out)
            return out
          }
          const lum = (c) => {
            const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
            return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2])
          }
          const opaqueBg = (el) => {
            let cur = el
            while (cur && cur.nodeType === 1) {
              const cs = getComputedStyle(cur)
              // A gradient/image means the flat colour is not the real backdrop;
              // skip it rather than pretend.
              if (cs.backgroundImage && cs.backgroundImage !== 'none') return null
              const c = rgba(cs.backgroundColor)
              if (c[3] > 0.9) return c
              cur = cur.parentElement
            }
            return [255, 255, 255, 1]
          }
          const bad = []
          let checked = 0
          for (const el of document.querySelectorAll('body *')) {
            const own = [...el.childNodes].filter((n) => n.nodeType === 3)
              .map((n) => n.textContent).join('').trim()
            if (own.length < 2) continue
            const r = el.getBoundingClientRect()
            if (r.width < 1 || r.height < 1) continue
            const cs = getComputedStyle(el)
            if (cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.05) continue
            const bg = opaqueBg(el)
            if (!bg) continue
            const fg = rgba(cs.color)
            const fs = parseFloat(cs.fontSize)
            // Composite the text colour over its backdrop when it is translucent.
            const a = fg[3] * (() => { let o = 1; for (let e = el; e && e.nodeType === 1; e = e.parentElement) o *= parseFloat(getComputedStyle(e).opacity) || 1; return o })()
            const solid = [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a))
            const l1 = lum(solid); const l2 = lum(bg)
            const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
            const large = fs >= 24 || (fs >= 18.66 && parseInt(cs.fontWeight, 10) >= 700)
            checked++
            const need = large ? 3 : 4.5
            if (ratio < need) {
              bad.push({ text: own.slice(0, 26), ratio: Math.round(ratio * 100) / 100, px: Math.round(fs), need })
            }
          }
          return {
            bg: getComputedStyle(document.body).backgroundColor,
            ink: getComputedStyle(document.body).color,
            radius: getComputedStyle(document.documentElement).getPropertyValue('--radius').trim(),
            overflowX: document.documentElement.scrollWidth > innerWidth,
            checked, lowContrast: bad.slice(0, 8), lowCount: bad.length,
          }
        })()`

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const report = []
  // One BrowserWindow per preload stub, created ONCE and reused.
  //
  // Two documented Electron 43 traps shape this:
  //   1. creating a window per capture fails on the second loadFile (ERR_FAILED),
  //   2. a hidden window composites lazily, so a frame can lag a style change.
  // The first version destroyed and recreated a window whenever the preload
  // changed and immediately hit (1) — capture.html refused to load. Preload is a
  // constructor-time setting, so windows are keyed by stub and never rebuilt.
  const windows = new Map()
  const getWindow = (stubName, size) => {
    const existing = windows.get(stubName)
    if (existing && !existing.isDestroyed()) {
      existing.setContentSize(size.w, size.h)
      return existing
    }
    const created = new BrowserWindow({
      show: false,
      width: size.w,
      height: size.h,
      webPreferences: {
        // Mirrors main/services/window-security.js LOCKED_WEB_PREFERENCES: the
        // preview must run under the app's real security posture, otherwise it
        // would be proving a renderer that does not exist in production. The
        // stubs therefore use contextBridge (which requires contextIsolation).
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        preload: path.join(__dirname, stubName),
      },
    })
    created.webContents.setBackgroundThrottling(false)
    windows.set(stubName, created)
    return created
  }

  // Every high-frequency surface the user scoped: the settings window plus the
  // three floating windows. The floats are where a re-theme most often breaks,
  // because the product keeps them dark on purpose and their colours are scattered
  // through their own stylesheets rather than the shared ladder.
  const SURFACES = [
    { key: 'win-home', file: path.join(ROOT, 'config', 'config.html'), stub: 'landing-stub.js', w: 1180, h: 760, route: 'home' },
    { key: 'win-general', file: path.join(ROOT, 'config', 'config.html'), stub: 'landing-stub.js', w: 1180, h: 760, route: 'settings-general' },
    { key: 'capture', file: path.join(ROOT, 'capture', 'capture.html'), stub: 'landing-stub-capture.js', w: 900, h: 620, pinnedDark: true }, // always dark: hardcoded overlay values
    { key: 'toolbar', file: path.join(ROOT, 'toolbar', 'toolbar.html'), stub: 'landing-stub-floats.js', w: 640, h: 56 },
    { key: 'clipboard', file: path.join(ROOT, 'clipboard', 'clipboard.html'), stub: 'landing-stub-floats.js', w: 480, h: 640 },
  ]

  // ── Baseline: the SAME surfaces with the shipped Nightshift tokens ──────────
  //
  // The gate must answer "did this direction make anything worse?", not "is every
  // pixel perfect". Several of these surfaces ship deliberately below 4.5:1 —
  // the clipboard's 8.5px LOCAL badge, the capture overlay's translucent hint —
  // because they are overlays over arbitrary screen content. Measuring them
  // against the direction would blame the new theme for the old design. So the
  // shipped look is measured first and each direction is compared to it.
  const baseline = {}
  for (const surface of SURFACES) {
    const w = getWindow(surface.stub, surface)
    w.setContentSize(surface.w, surface.h)
    await w.loadFile(surface.file)
    await new Promise((r) => setTimeout(r, 1000))
    if (surface.route) {
      for (let i = 0; i < 12; i++) {
        const active = await w.webContents.executeJavaScript(
          `[...document.querySelectorAll('.nav-item.active')].map(b=>b.dataset.route)[0]||''`)
        if (active === surface.route) break
        await w.webContents.executeJavaScript(
          `(()=>{const b=document.querySelector('.nav-item[data-route="${surface.route}"]');if(b)b.click()})()`)
        await new Promise((r) => setTimeout(r, 250))
      }
    }
    const freeze = await w.webContents.insertCSS('*{transition:none !important;animation:none !important}')
    await new Promise((r) => setTimeout(r, 250))
    // Keyed exactly like the direction lookup: one key per (surface, app theme)
    // the run will actually measure. Floats are pinned dark, so they only get the
    // dark key.
    for (const appTheme of ['light', 'dark']) {
      if (surface.pinnedDark && appTheme === 'light') continue
      baseline[`${surface.key}-${appTheme}`] = await w.webContents.executeJavaScript(CONTRAST_PROBE)
      console.log(`     baseline ${(surface.key + '-' + appTheme).padEnd(20)} low=${baseline[`${surface.key}-${appTheme}`].lowCount} text=${baseline[`${surface.key}-${appTheme}`].checked}`)
    }
    await w.webContents.removeInsertedCSS(freeze)
    // The shipped look does not change with the theme for a pinned-dark float, so
    // measuring once is enough; alias the other app-theme key onto it.
    if (surface.pinnedDark) baseline[`${surface.key}-light`] = baseline[`${surface.key}-dark`]
  }

  for (const dir of DIRECTIONS) {
    for (const surface of SURFACES) {
      for (const appTheme of ['light', 'dark']) {
        // Only the surfaces whose stylesheets are hardcoded dark are pinned;
        // clipboard and the selection toolbar follow the app theme in the real
        // product, so they must be judged in both themes.
        const theme = surface.pinnedDark ? 'dark' : appTheme
        const w = getWindow(surface.stub, surface)
        w.setContentSize(surface.w, surface.h)
        const route = surface.route || 'home'
        w.setBackgroundColor(dir.map[theme].bg)
        const errors = []
        w.webContents.removeAllListeners('console-message')
        w.webContents.on('console-message', (e, level, message) => {
          const msg = e && typeof e === 'object' ? e.message : message
          if (String(msg || '').toLowerCase().includes('error')) errors.push(String(msg).slice(0, 120))
        })
        await w.loadFile(surface.file)
        await new Promise((r) => setTimeout(r, 900))
        // Route: click the nav item until it sticks (the renderer's init() ends
        // with navigate('home') and can land after our click).
        if (surface.route && route !== 'home') {
          for (let i = 0; i < 12; i++) {
            const active = await w.webContents.executeJavaScript(
              `[...document.querySelectorAll('.nav-item.active')].map(b=>b.dataset.route)[0]||''`)
            if (active === route) break
            await w.webContents.executeJavaScript(
              `(()=>{const b=document.querySelector('.nav-item[data-route="${route}"]');if(b)b.click()})()`)
            await new Promise((r) => setTimeout(r, 250))
          }
        }
        await w.webContents.executeJavaScript(
          `document.body.classList.toggle('dark', ${theme === 'dark'})`)
        // insertCSS, not a <style> element: the window CSP is style-src 'self'.
        const key = await w.webContents.insertCSS(overlay(dir, theme))
        // Freeze transitions BEFORE measuring or capturing.
        //
        // The window stylesheets transition `background` on cards and rows
        // (.function-row{transition:background .15s}). A hidden BrowserWindow
        // produces frames very slowly, so a transition started by the theme change
        // is still mid-flight — or stuck at its START value — when the capture is
        // taken. getComputedStyle then reports the old background while the custom
        // property already holds the new one, which is exactly how the C2 dark
        // preview came out with light cards and light text (invisible labels).
        // This is the same trap design-demos/tools/capture-electron.js documents;
        // freezing makes the preview deterministic instead of racy.
        const freezeKey = await w.webContents.insertCSS(
          '*{transition:none !important;animation:none !important}')
        await w.webContents.executeJavaScript(`new Promise((resolve) => {
          let settled = false
          const finish = () => { if (!settled) { settled = true; resolve('painted') } }
          requestAnimationFrame(() => requestAnimationFrame(finish))
          setTimeout(finish, 1200)
        })`)
        // Throw away one frame: the first capturePage after a style change can
        // still return the pre-change composite.
        await w.webContents.capturePage()
        await new Promise((r) => setTimeout(r, 450))
        const probe = await w.webContents.executeJavaScript(CONTRAST_PROBE)
        const image = await w.webContents.capturePage()
        const file = `${dir.id}-${surface.key}-${appTheme}.png`
        fs.writeFileSync(path.join(OUT, file), image.toPNG())
        await w.webContents.removeInsertedCSS(key)
        await w.webContents.removeInsertedCSS(freezeKey)
        // The verdict is REGRESSION against the shipped look, not an absolute bar.
        //
        // These surfaces legitimately ship some sub-4.5:1 text: the clipboard's
        // 8.5px LOCAL badge (3.3:1), the capture overlay's translucent hint over
        // screen content (1:1 by construction — it floats over an arbitrary image,
        // so its own backdrop cannot be known). Scoring those against a direction
        // would blame the new theme for the old design, and the first run did
        // exactly that: eleven "failures" that were all pre-existing.
        //
        // What a direction must not do is introduce NEW low-contrast text or make
        // the count worse. Anything above the baseline count is a real regression.
        const base = baseline[`${surface.key}-${appTheme}`] || { lowCount: 0 }
        const regression = Math.max(0, probe.lowCount - base.lowCount)
        const failed = errors.length || probe.overflowX || regression > 0
        const line = `${failed ? 'FAIL' : 'ok  '} ${file.padEnd(38)} bg=${probe.bg} ink=${probe.ink} r=${probe.radius} text=${probe.checked} low=${probe.lowCount}/${base.lowCount} errors=${errors.length}${probe.overflowX ? ' OVERFLOW-X' : ''}${regression ? ' REGRESSION+' + regression : ''}`
        report.push({ file, dir: dir.id, surface: surface.key, appTheme, palette: theme, errors, baselineLow: base.lowCount, regression, ...probe, line })
        console.log(line)
        probe.lowContrast.forEach((b) =>
          console.log(`        low ${b.ratio}:1 (need ${b.need}) ${b.px}px "${b.text}"`))
      }
    }
  }
  for (const w of windows.values()) if (!w.isDestroyed()) w.destroy()
  fs.writeFileSync(path.join(OUT, 'REPORT.txt'),
    report.map((r) => r.line).join('\n') + '\n\n' + JSON.stringify(report, null, 1) + '\n')
  const fails = report.filter((r) => r.line.startsWith('FAIL')).length
  // Summary by direction: a direction lands only if none of its surfaces regress.
  const byDir = {}
  for (const r of report) {
    const d = (byDir[r.dir] = byDir[r.dir] || { pass: 0, fail: 0, regression: 0 })
    if (r.line.startsWith('FAIL')) d.fail++; else d.pass++
    d.regression += r.regression
  }
  console.log('\n── landing gate (vs shipped Nightshift baseline) ──')
  for (const [id, d] of Object.entries(byDir)) {
    console.log(`${d.fail ? 'FAIL' : 'ok  '} ${id.padEnd(8)} ${d.pass}/${d.pass + d.fail} surfaces pass, ${d.regression} new low-contrast node(s)`)
  }
  console.log(`${fails ? '\n' + fails + ' surface(s) failed' : '\nall directions land without regressing readability'}`)
  app.quit()
})
