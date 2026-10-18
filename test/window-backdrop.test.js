/*
 * The native window backdrop contract.
 *
 * A frameless window paints its own backgroundColor behind anything the page
 * leaves transparent. `config/config.html` cuts its own rounded corners, so the
 * four cut-outs used to show the pre-Nightshift `#f5f5f5` while the shell itself
 * painted the dark `--bg` — four white arcs around the main window.
 *
 * Two guards keep it fixed: the page paints `--bg` itself (so the cut-outs carry
 * the theme colour even if the native colour is stale), and the native colour is
 * the `--bg` token and is re-applied whenever the resolved theme changes.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  WINDOW_BACKDROP,
  isDarkTheme,
  resolveWindowBackdrop,
  windowBackdropColor,
  trackWindowBackdrop,
  applyWindowBackdrop,
  applyWindowBackdropToTracked,
  trackedWindowCount
} = require('../main/services/window-backdrop')

const root = path.join(__dirname, '..')
const tokens = fs.readFileSync(path.join(root, 'shared/tokens.css'), 'utf8')
const configCss = fs.readFileSync(path.join(root, 'config/config.css'), 'utf8')
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
const settingsEffects = fs.readFileSync(path.join(root, 'main/domains/settings-effects/index.js'), 'utf8')

function tokenBackground(sheet, selector) {
  const block = selector === ':root'
    ? sheet.slice(sheet.indexOf(':root {'), sheet.indexOf('body.dark {'))
    : sheet.slice(sheet.indexOf('body.dark {'))
  const match = block.match(/--bg:\s*(#[0-9a-fA-F]{6})/)
  assert.ok(match, `${selector} declares --bg`)
  return match[1].toLowerCase()
}

test('the native backdrop is the shared --bg token in both themes', () => {
  // A literal here would silently drift from the design system again; the whole
  // point is that the native colour and the CSS surface cannot disagree.
  assert.equal(WINDOW_BACKDROP.light, tokenBackground(tokens, ':root'))
  assert.equal(WINDOW_BACKDROP.dark, tokenBackground(tokens, 'body.dark'))
})

test('the resolved backdrop follows explicit themes and the system setting', () => {
  const dark = { shouldUseDarkColors: true }
  const light = { shouldUseDarkColors: false }

  assert.deepEqual(resolveWindowBackdrop({ theme: 'dark' }, light), { dark: true, color: WINDOW_BACKDROP.dark })
  assert.deepEqual(resolveWindowBackdrop({ theme: 'light' }, dark), { dark: false, color: WINDOW_BACKDROP.light })
  assert.deepEqual(resolveWindowBackdrop({ theme: 'system' }, dark), { dark: true, color: WINDOW_BACKDROP.dark })
  assert.deepEqual(resolveWindowBackdrop({ theme: 'system' }, light), { dark: false, color: WINDOW_BACKDROP.light })
  // An unknown or missing theme is 'system', not 'light' — the app's default.
  assert.deepEqual(resolveWindowBackdrop({}, dark), { dark: true, color: WINDOW_BACKDROP.dark })
  assert.equal(isDarkTheme({ theme: 'bogus' }, dark), true)
})

test('re-applying the backdrop only touches a window whose colour differs', () => {
  const calls = []
  const win = {
    color: WINDOW_BACKDROP.light,
    isDestroyed: () => false,
    getBackgroundColor() { return this.color },
    setBackgroundColor(color) { calls.push(color); this.color = color }
  }

  applyWindowBackdrop(win, { theme: 'light' }, null)
  assert.deepEqual(calls, [], 'no native call when the colour already matches')

  assert.equal(applyWindowBackdrop(win, { theme: 'dark' }, null), WINDOW_BACKDROP.dark)
  assert.deepEqual(calls, [WINDOW_BACKDROP.dark])

  // A window that rejects the call (e.g. it is being torn down) is not fatal.
  const throwing = {
    isDestroyed: () => false,
    getBackgroundColor() { return WINDOW_BACKDROP.light },
    setBackgroundColor() { throw new Error('Object has been destroyed') }
  }
  assert.equal(applyWindowBackdrop(throwing, { theme: 'dark' }, null), null)
  assert.equal(applyWindowBackdrop(null, { theme: 'dark' }, null), null)
  assert.equal(applyWindowBackdrop({ isDestroyed: () => true }, { theme: 'dark' }, null), null)
})

test('a theme change repaints every tracked window and only those', () => {
  // The repaint walks an explicit registry rather than BrowserWindow.getAllWindows():
  // the toolbar, record frame and capture overlays are `transparent:true` and must
  // keep their colour. Electron cannot be used to filter them — getBackgroundColor()
  // drops the alpha channel, so '#00000000', '#00ffffff' and an opaque window all
  // report an opaque-looking RGB value.
  function fakeWindow(startColor) {
    const listeners = new Map()
    return {
      color: startColor,
      painted: [],
      isDestroyed: () => false,
      getBackgroundColor() { return this.color },
      setBackgroundColor(color) { this.painted.push(color); this.color = color },
      on: (event, handler) => { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(handler) },
      once: (event, handler) => { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(handler) },
      emit: (event) => { for (const handler of listeners.get(event) || []) handler() }
    }
  }

  const before = trackedWindowCount()
  const config = trackWindowBackdrop(fakeWindow(WINDOW_BACKDROP.light))
  const action = trackWindowBackdrop(fakeWindow(WINDOW_BACKDROP.light))
  // Not tracked: a transparent overlay would be turned opaque by a repaint.
  const overlay = fakeWindow('#00000000')
  assert.equal(trackedWindowCount(), before + 2)

  const repainted = applyWindowBackdropToTracked({ theme: 'dark' }, null)
  assert.equal(repainted, 2)
  assert.deepEqual(config.painted, [WINDOW_BACKDROP.dark])
  assert.deepEqual(action.painted, [WINDOW_BACKDROP.dark])
  assert.deepEqual(overlay.painted, [], 'an untracked window is never repainted')

  // A second repaint with the same theme writes nothing.
  assert.equal(applyWindowBackdropToTracked({ theme: 'dark' }, null), 0)

  // Closing a window drops it from the registry, so a recreated one (search,
  // recognition) can never grow the set without bound.
  config.emit('closed')
  assert.equal(trackedWindowCount(), before + 1)
  assert.equal(applyWindowBackdropToTracked({ theme: 'light' }, null), 1)
  assert.deepEqual(action.painted, [WINDOW_BACKDROP.dark, WINDOW_BACKDROP.light])
  action.emit('closed')
  assert.equal(trackedWindowCount(), before)
})

test('the main window is created with the resolved backdrop, not a literal', () => {
  assert.match(mainSource, /backgroundColor: windowBackdropColor\(getSettings\(\), nativeTheme\)/)
  assert.doesNotMatch(mainSource, /backgroundColor: '#f5f5f5'/, 'the pre-Nightshift literal must not come back')
})

test('the backdrop is repainted on a settings update, a reset and an OS theme flip', () => {
  // Three paths change the resolved theme: the appearance settings effect (which
  // covers a settings update and a reset through the same broadcast), and the OS
  // flipping while theme === 'system'. Each repaints every live window, because a
  // theme change is global and any window can still be open.
  assert.match(settingsEffects, /id: 'appearance'[\s\S]*broadcastActionAppearance\(settings\)/)
  assert.match(
    mainSource,
    /broadcastActionAppearance: \(settings\) => \{ applyWindowBackdropToTracked\(settings, nativeTheme\)/,
    'the appearance broadcast repaints every tracked backdrop in the same tick as the renderers'
  )
  assert.match(
    mainSource,
    /nativeTheme\.on\('updated',[\s\S]*applyWindowBackdropToTracked\(getSettings\(\), nativeTheme\)/,
    'an OS theme flip repaints every tracked backdrop'
  )
})

test('the config page paints the base surface so the corner cut-outs are opaque', () => {
  // `background:transparent` left the four cut-outs of .window-shell to the
  // native backdrop; the page now paints --bg itself.
  assert.match(configCss, /html,body\{[^}]*background:var\(--bg\)/)
  assert.doesNotMatch(configCss, /html,body\{[^}]*background:transparent/)
  // The shell still owns the rounded card itself.
  assert.match(configCss, /\.window-shell\{[^}]*border-radius:var\(--radius-lg\)/)
})

test('every window that owns a native backdrop takes it from the shared helper', () => {
  // Each of these used to carry its own literal (#f5f5f5, #f5f6f8, #121316,
  // #18181b). A literal is invisible to the design system: it cannot follow the
  // theme and it drifts silently, which is exactly how the four white arcs
  // appeared. Assert the helper is used and the old literals are gone.
  const owners = [
    ['main/domains/search/index.js', /backgroundColor: windowBackdropColor\(getSettings\(\), nativeTheme\)/],
    ['main/domains/recognition/index.js', /backgroundColor: windowBackdropColor\(settings\)/],
    ['main/domains/clipboard/index.js', /backgroundColor: windowBackdropColor\(settings, nativeTheme\)/],
    ['main/services/selection-window-manager.js', /backgroundColor: windowBackdropColor\(this\.getSettings\(\), this\.nativeTheme\)/]
  ]
  for (const [file, expected] of owners) {
    const source = fs.readFileSync(path.join(root, file), 'utf8')
    assert.match(source, /require\(['"][./]*services\/window-backdrop['"]\)|require\(['"]\.\/window-backdrop['"]\)/, `${file} imports the shared helper`)
    assert.match(source, expected, `${file} resolves its backdrop through the helper`)
    assert.match(source, /trackWindowBackdrop\(/, `${file} opts the window into the theme-change repaint`)
    assert.doesNotMatch(source, /backgroundColor:\s*['"]#[0-9a-fA-F]{6}/, `${file} must not hardcode a backdrop colour`)
    assert.doesNotMatch(source, /backgroundColor:\s*[^,\n]*#(?:f5f5f5|f5f6f8|121316|18181b)/i, `${file} must not keep the pre-Nightshift literal`)
  }
  // The main window is created in main.js, which tracks it at the same point.
  assert.match(mainSource, /mainWindow = trackWindowBackdrop\(win\)/)
})

test('the rounded-card windows are registered for the theme-change repaint', () => {
  // Search and the selection result windows both cut their own corners. They do
  // not repaint themselves: they opt into the registry, and the appearance
  // broadcast walks it, so there is exactly one repaint path to reason about.
  const searchDomain = fs.readFileSync(path.join(root, 'main/domains/search/index.js'), 'utf8')
  assert.match(searchDomain, /searchWindow = trackWindowBackdrop\(win\)/, 'the search window is tracked')
  const manager = fs.readFileSync(path.join(root, 'main/services/selection-window-manager.js'), 'utf8')
  assert.match(manager, /trackWindowBackdrop\(win\)/, 'each result window is tracked')
})

test('the recognition window tells its renderer which theme to paint', () => {
  // The page toggles body.dark from the init payload; without `theme` an explicit
  // light/dark setting was ignored and the result page followed the OS instead.
  const domain = fs.readFileSync(path.join(root, 'main/domains/recognition/index.js'), 'utf8')
  assert.match(domain, /win\._recognitionInit = \{[\s\S]*theme: settings\.theme/)
})
