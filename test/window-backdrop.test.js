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

test('the main window takes the shared opaque backdrop, like the other windows', () => {
  // The settings window is opaque again (2026-10-24, second pass): the translucent
  // version it had for a day was rejected. The original intent of this guard still
  // holds — no literal that drifts from the design system — so it asserts the shared
  // helper and keeps the pre-Nightshift literal banned.
  const createBlock = mainSource.slice(mainSource.indexOf('function createMainWindow'))
  const options = createBlock.slice(0, createBlock.indexOf('webPreferences'))
  assert.match(options, /backgroundColor:\s*windowBackdropColor\(getSettings\(\), nativeTheme\)/,
    'the native backdrop comes from the shared helper')
  assert.doesNotMatch(options, /backgroundColor:\s*'#00000000'/,
    'the settings window is not a transparent window')
  assert.doesNotMatch(options, /transparent:\s*true/, 'the settings window is opaque')
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

test('the config page paints the theme background, so the corner cut-outs match it', () => {
  // This guard used to require the opposite while the window was translucent: a
  // transparent page let the native window colour show through. The window is
  // opaque again (2026-10-24, second pass — the translucent version was rejected
  // twice), so the page paints `--bg` itself and the native backdrop is only ever
  // seen in the four corner cut-outs that `.window-shell`'s border-radius clips.
  // If the page stopped painting, those cut-outs would still resolve correctly but
  // the first frame would flash the native colour before the shell painted.
  const cssCode = configCss.replace(/\/\*[\s\S]*?\*\//g, '')
  assert.match(cssCode, /html,body\{[^}]*background:var\(--bg\)/)
  assert.doesNotMatch(cssCode, /html,body\{[^}]*background:transparent/)
  // The shell still owns the rounded card and fills the whole window: no frame
  // margin, because an opaque window has an OS shadow and needs no inset.
  assert.match(configCss, /\.window-shell\{[^}]*border-radius:var\(--radius-lg\)/)
  assert.match(configCss, /\.window-shell\{[^}]*inset:0\b/)
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
  // main.js is an owner again (2026-10-24): the settings window is opaque after the
  // translucent experiment was rejected twice, so it takes the shared backdrop and
  // opts into the theme-change repaint like every other rounded-card window.
  const mainCreate = mainSource.slice(mainSource.indexOf('function createMainWindow'))
  assert.match(mainCreate.slice(0, mainCreate.indexOf('win.once(')),
    /trackWindowBackdrop\(win\)/, 'the settings window is tracked')
  assert.match(mainCreate, /backgroundColor: windowBackdropColor\(getSettings\(\), nativeTheme\)/)
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

// ── the settings window is opaque (2026-10-24, second pass) ─────────────────
//
// A translucent version was built first (transparent window, page-drawn shadow,
// frame inset) and the user rejected it twice: "too clear, it hurts reading the
// page", then "frosted is still too see-through — remove it, keep the main
// interface consistent with the design draft". The prototype's glass face sits over
// the prototype's DRAWN desk; a real window has the user's desktop behind it. So the
// settings window is back on the same contract as every other opaque window: native
// backdrop colour, OS shadow, page paints --bg and fills the window.
//
// These tests are the inverse of the ones that protected the translucent version.
// They exist so a future edit cannot quietly reintroduce a transparency path — the
// frame inset, the page-drawn window shadow and the "not tracked by the backdrop
// module" exception all have to stay gone. `tokens` and `mainSource` already exist
// at the top of this file; reuse them.
test('the settings window is opaque and sized to its content', () => {
  const createBlock = mainSource.slice(mainSource.indexOf('function createMainWindow'))
  const options = createBlock.slice(0, createBlock.indexOf('webPreferences'))
  assert.doesNotMatch(options, /transparent:\s*true/, 'the settings window is opaque')
  assert.doesNotMatch(options, /hasShadow:\s*false/, 'the OS provides the shadow')
  assert.doesNotMatch(options, /backgroundColor:\s*'#00000000'/, 'the native backdrop is not clear')
  assert.match(options, /backgroundColor:\s*windowBackdropColor\(getSettings\(\), nativeTheme\)/,
    'the native backdrop comes from the shared helper')
  // Sized to its content, not grown by a frame inset for a page-drawn shadow.
  assert.match(options, /width:\s*1120\b/)
  assert.match(options, /height:\s*760\b/)
  assert.match(options, /minWidth:\s*880\b/)
  assert.match(options, /minHeight:\s*620\b/)
})

test('the transparent-window scaffolding is gone', () => {
  // The frame inset, the page-drawn window shadow and the module constant that sized
  // the window for them all belonged to the rejected design. Leaving any of them
  // behind is how the "temporary" frame margin comes back.
  const backdrop = require('../main/services/window-backdrop')
  assert.equal(backdrop.MAIN_WINDOW_FRAME_INSET, undefined,
    'the frame inset constant is gone')
  assert.doesNotMatch(tokens, /--win-frame-inset/)
  assert.doesNotMatch(tokens, /--win-shadow/)
})

test('the shell fills the window and paints --bg, not glass', () => {
  const shellRule = configCss.slice(
    configCss.indexOf('.window-shell{'),
    configCss.indexOf('.window-shell::before'))
  assert.match(shellRule, /inset:0\b/, 'the shell fills the window (no frame margin)')
  assert.match(shellRule, /background:var\(--bg\)/, 'the shell paints the base surface')
  assert.match(shellRule, /box-shadow:var\(--shadow-3\)/, 'depth comes from the shared ladder')
  assert.doesNotMatch(shellRule, /backdrop-filter/, 'the shell is not a glass film')
})

test('the settings window is tracked by the opaque-backdrop module', () => {
  // An opaque window must be in the registry: applyWindowBackdropToTracked is the
  // only path that repaints the native colour on a theme flip, and skipping it is
  // invisible until the user flips the theme and the four corner cut-outs keep the
  // old colour.
  const createBlock = mainSource.slice(mainSource.indexOf('function createMainWindow'))
  const body = createBlock.slice(0, createBlock.indexOf('win.once('))
  assert.match(body, /mainWindow = trackWindowBackdrop\(win\)/,
    'the settings window is tracked by the opaque-backdrop module')
})
