/*
 * Native window backdrop.
 *
 * A frameless window paints its own `backgroundColor` behind everything the page
 * leaves transparent. `config/config.html` cuts its own rounded corners
 * (`.window-shell{border-radius:var(--radius-lg)}` + `overflow:hidden`), so the
 * four corner cut-outs show whatever that native colour is. While it was the
 * pre-Nightshift `#f5f5f5`, the dark shell grew four white arcs.
 *
 * Every opaque window takes its colour from here, so none of them can drift from
 * the design system again:
 *   - config      (main.js)                                 rounded-card shell
 *   - search      (main/domains/search)                     rounded-card shell
 *   - action      (main/services/selection-window-manager)  result window
 *   - clipboard   (main/domains/clipboard)                  first-paint flash
 *   - recognition (main/domains/recognition)                first-paint flash
 *
 * Windows opt in by calling `trackWindowBackdrop` once they are created; the
 * repaint only touches tracked windows. Enumerating `BrowserWindow.getAllWindows()`
 * instead would also hit the toolbar, the record frame and the capture overlays,
 * which are `transparent:true` and must keep their colour — and Electron's
 * `getBackgroundColor()` cannot be used to exclude them, because it drops the
 * alpha channel ("#00000000" and "#00ffffff" both report an opaque-looking RGB).
 *
 * The settings window is opaque too (2026-10-24, second pass). A translucent
 * version was built first and rejected twice — "too clear", then "frosted is still
 * too see-through". The prototype's face is glass over a DRAWN desk; a real window
 * has the user's desktop behind it, and that is what was rejected. So the settings
 * window is back on the contract above: native backdrop colour, OS shadow, page
 * paints `--bg`.
 *
 * Two guards keep it honest: the pages paint `--bg` themselves, so a cut-out
 * carries the theme colour even if the native colour were stale; and the native
 * colour, which does not follow CSS, is re-applied to every tracked window
 * whenever the resolved theme changes (`theme:'system'` can flip at runtime).
 */

// Keep these equal to shared/tokens.css: `--bg` in :root and in body.dark.
// test/window-backdrop.test.js parses the stylesheet and fails on drift.
// Values track the FILM palette (direction B1, chosen 2026-10-24).
const WINDOW_BACKDROP = Object.freeze({
  light: '#ebe5d8',
  dark: '#191713'
})

// Windows whose native backdrop this module owns. A destroyed window is dropped
// on the next repaint, so a window that is recreated between sessions (search) or
// per capture (recognition) cannot grow the set without bound.
const trackedWindows = new Set()

function isDarkTheme(settings, nativeTheme) {
  const theme = settings && ['light', 'dark'].includes(settings.theme) ? settings.theme : 'system'
  if (theme === 'dark') return true
  if (theme === 'light') return false
  return !!(nativeTheme && nativeTheme.shouldUseDarkColors)
}

function resolveWindowBackdrop(settings, nativeTheme) {
  const dark = isDarkTheme(settings, nativeTheme)
  return { dark, color: dark ? WINDOW_BACKDROP.dark : WINDOW_BACKDROP.light }
}

// The colour a window has to be created with, and the argument to
// `BrowserWindow`'s `backgroundColor`. It cannot be applied after creation
// without a flash: the native default is white, which is the corner seam this
// module exists to remove.
function windowBackdropColor(settings, nativeTheme) {
  return resolveWindowBackdrop(settings, nativeTheme).color
}

// Opt a window into the backdrop contract. Call it right after creation, next to
// the `backgroundColor` it was built with.
function trackWindowBackdrop(win) {
  if (win && typeof win.once === 'function' && typeof win.on === 'function') {
    trackedWindows.add(win)
    win.once('closed', () => trackedWindows.delete(win))
    return win
  }
  if (win) trackedWindows.add(win)
  return win
}

// Returns the colour now in effect, or null when there was nothing to do.
// A destroyed window (or a window object without the colour APIs, as in unit
// tests) is tolerated: the theme can flip while the window is closing.
function applyWindowBackdrop(win, settings, nativeTheme) {
  if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return null
  const { color } = resolveWindowBackdrop(settings, nativeTheme)
  if (typeof win.getBackgroundColor === 'function') {
    try {
      if (String(win.getBackgroundColor() || '').toLowerCase() === color.toLowerCase()) return null
    } catch {
      // The window can become unavailable between the two calls; the write below
      // reports that through its own try/catch.
    }
  }
  try {
    win.setBackgroundColor(color)
  } catch {
    return null
  }
  return color
}

// Repaints every tracked window; returns how many actually changed. The
// appearance broadcast uses this so one theme change reaches every window that
// owns a backdrop, and leaves the transparent ones alone.
function applyWindowBackdropToTracked(settings, nativeTheme) {
  let repainted = 0
  for (const win of [...trackedWindows]) {
    if (win && typeof win.isDestroyed === 'function' && win.isDestroyed()) {
      trackedWindows.delete(win)
      continue
    }
    if (applyWindowBackdrop(win, settings, nativeTheme)) repainted++
  }
  return repainted
}

function trackedWindowCount() {
  return trackedWindows.size
}

module.exports = {
  WINDOW_BACKDROP,
  isDarkTheme,
  resolveWindowBackdrop,
  windowBackdropColor,
  trackWindowBackdrop,
  applyWindowBackdrop,
  applyWindowBackdropToTracked,
  trackedWindowCount
}
