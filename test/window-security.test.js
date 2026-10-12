const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const {
  LOCKED_WEB_PREFERENCES,
  createSecureWebPreferences,
  createSecureWindow,
  getSecureWindowRegistration,
  installWindowSecurity,
  isAllowedLocalUrl,
  isSafeExternalUrl
} = require('../main/services/window-security')

const root = path.resolve(__dirname, '..')
const actionPage = path.join(root, 'action', 'action.html')

class FakeWebContents extends EventEmitter {
  setWindowOpenHandler(handler) {
    this.windowOpenHandler = handler
  }
}

test('secure web preferences cannot be weakened by callers', () => {
  const preload = path.join(root, 'preload-action.js')
  const preferences = createSecureWebPreferences({
    preload,
    contextIsolation: false,
    nodeIntegration: true,
    sandbox: false,
    webviewTag: true
  })

  assert.equal(preferences.preload, preload)
  for (const [key, value] of Object.entries(LOCKED_WEB_PREFERENCES)) {
    assert.equal(preferences[key], value, `${key} must stay locked`)
  }
  assert.throws(() => createSecureWebPreferences({ preload: 'preload-action.js' }), /absolute preload path/)
})

test('local page allowlists use exact normalized file paths', () => {
  const actionUrl = pathToFileURL(actionPage).toString()
  assert.equal(isAllowedLocalUrl(actionUrl, [actionPage]), true)
  assert.equal(isAllowedLocalUrl(`${actionUrl}?theme=dark#result`, [actionPage]), true)
  assert.equal(isAllowedLocalUrl(pathToFileURL(path.join(root, 'config', 'config.html')), [actionPage]), false)
  assert.equal(isAllowedLocalUrl('https://example.com/action.html', [actionPage]), false)
  assert.equal(isSafeExternalUrl('https://example.com/path'), true)
  assert.equal(isSafeExternalUrl('http://example.com/path'), true)
  assert.equal(isSafeExternalUrl('javascript:alert(1)'), false)
  assert.equal(isSafeExternalUrl('file:///tmp/secret'), false)
})

test('navigation, redirects, webviews, and child windows are denied', () => {
  const webContents = new FakeWebContents()
  const blocked = []
  const win = { webContents }
  installWindowSecurity(win, { allowedFilePaths: [actionPage], onBlocked: (entry) => blocked.push(entry) })

  const allowedEvent = { prevented: false, preventDefault() { this.prevented = true } }
  webContents.emit('will-navigate', allowedEvent, pathToFileURL(actionPage).toString())
  assert.equal(allowedEvent.prevented, false)

  const navigationEvent = { prevented: false, preventDefault() { this.prevented = true } }
  webContents.emit('will-navigate', navigationEvent, 'https://example.com/private?token=secret')
  assert.equal(navigationEvent.prevented, true)

  const redirectEvent = { prevented: false, preventDefault() { this.prevented = true } }
  webContents.emit('will-redirect', redirectEvent, pathToFileURL(path.join(root, 'preload.js')).toString())
  assert.equal(redirectEvent.prevented, true)

  const webviewEvent = { prevented: false, preventDefault() { this.prevented = true } }
  webContents.emit('will-attach-webview', webviewEvent, {}, { src: 'https://example.com/embed' })
  assert.equal(webviewEvent.prevented, true)
  assert.deepEqual(webContents.windowOpenHandler({ url: 'https://example.com/new' }), { action: 'deny' })

  assert.deepEqual(blocked.map((entry) => entry.reason), [
    'blocked-navigation',
    'blocked-navigation',
    'blocked-webview',
    'blocked-window-open'
  ])
  assert.equal(blocked[0].url, 'https://example.com/private')
  assert.equal(blocked[1].url, 'file://<blocked>')
})

test('secure window factory records the exact local page registration', () => {
  let receivedOptions
  class FakeBrowserWindow {
    constructor(options) {
      receivedOptions = options
      this.webContents = new FakeWebContents()
    }
  }

  const win = createSecureWindow({
    BrowserWindow: FakeBrowserWindow,
    pagePath: actionPage,
    options: { show: false, webPreferences: { preload: path.join(root, 'preload-action.js') } }
  })
  assert.equal(receivedOptions.show, false)
  assert.equal(receivedOptions.webPreferences.sandbox, true)
  assert.equal(getSecureWindowRegistration(win.webContents).window, win)
  assert.equal(getSecureWindowRegistration(win.webContents).pagePath, path.normalize(actionPage).toLowerCase())
})

test('action renderer uses a dedicated API, CSP, sanitizer, and packaged preload', () => {
  const manager = fs.readFileSync(path.join(root, 'main', 'services', 'selection-window-manager.js'), 'utf8')
  const commonPreload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8')
  const actionPreload = fs.readFileSync(path.join(root, 'preload-action.js'), 'utf8')
  const actionScript = fs.readFileSync(path.join(root, 'action', 'action.js'), 'utf8')
  const actionHtml = fs.readFileSync(actionPage, 'utf8')
  const packageJson = require('../package.json')

  assert.match(manager, /this\.createWindow\(pagePath, \{[\s\S]*preload: path\.join\(this\.rootDirectory, 'preload-action\.js'\)/)
  assert.doesNotMatch(commonPreload, /showdown|renderMarkdown|action:start|stream:data|window:toggle-pin/)
  assert.match(actionPreload, /exposeInMainWorld\('actionAPI'/)
  assert.doesNotMatch(actionPreload, /config:|settings:|history:|data-root:|ai:/)
  assert.doesNotMatch(actionScript, /window\.electronAPI|target=["']_blank/)
  assert.match(actionScript, /DOMPurify\.sanitize/)
  assert.match(actionScript, /ALLOWED_URI_REGEXP: \/\^https\?:/)
  assert.match(actionHtml, /Content-Security-Policy/)
  assert.match(actionHtml, /default-src 'none'/)
  assert.match(actionHtml, /node_modules\/dompurify\/dist\/purify\.min\.js/)
  assert.ok(packageJson.build.files.includes('preload-action.js'))
  assert.equal(packageJson.dependencies.dompurify, '3.4.13')
  assert.equal(packageJson.dependencies.showdown, undefined)
})

test('all application windows use the locked factory and deny network-capable page defaults', () => {
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
  const service = fs.readFileSync(path.join(root, 'main', 'services', 'window-security.js'), 'utf8')
  const htmlFiles = [
    ['config', 'config.html'],
    ['toolbar', 'toolbar.html'],
    ['action', 'action.html'],
    ['capture', 'capture.html'],
    ['long-capture', 'overlay.html'],
    ['long-capture', 'long-capture.html'],
    ['pin', 'pin.html'],
    ['recognition', 'recognition.html'],
    ['record', 'frame.html'],
    ['record', 'record.html']
  ]

  assert.doesNotMatch(main, /new BrowserWindow\s*\(/)
  assert.equal((service.match(/new BrowserWindow\s*\(/g) || []).length, 1)
  assert.match(main, /function createLocalWindow\(pagePath, options\)[\s\S]*createSecureWindow/)
  for (const segments of htmlFiles) {
    const html = fs.readFileSync(path.join(root, ...segments), 'utf8')
    assert.match(html, /Content-Security-Policy/, `${segments.join('/')} CSP`)
    assert.match(html, /default-src 'none'/, `${segments.join('/')} default-src`)
    assert.match(html, /script-src 'self'/, `${segments.join('/')} script-src`)
    assert.doesNotMatch(html, /script-src[^;]*(?:'unsafe-inline'|'unsafe-eval')/, `${segments.join('/')} executable inline code`)
    assert.match(html, /connect-src 'none'/, `${segments.join('/')} connect-src`)
    assert.match(html, /object-src 'none'/, `${segments.join('/')} object-src`)
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, `${segments.join('/')} inline script`)
  }
  assert.match(fs.readFileSync(path.join(root, 'toolbar', 'toolbar.html'), 'utf8'), /<script src="toolbar\.js"><\/script>/)
  assert.match(fs.readFileSync(path.join(root, 'pin', 'pin.html'), 'utf8'), /<script src="pin\.js"><\/script>/)
})

test('long capture allows only its packaged matcher worker and fails closed', () => {
  const html = fs.readFileSync(path.join(root, 'long-capture', 'long-capture.html'), 'utf8')
  const script = fs.readFileSync(path.join(root, 'long-capture', 'long-capture.js'), 'utf8')

  assert.match(html, /worker-src 'self'/)
  assert.doesNotMatch(html, /worker-src 'none'/)
  assert.match(script, /worker\.onerror/)
  // P0-1-T5：文案已迁到 locale 表，脚本里断言的是键（值在 shared/locales/long-capture.js）。
  assert.match(script, /t\('long-capture\.error\.match-timeout'\)/)
  assert.match(script, /rejectWorkerRequests/)
})

// --- language hot-switch (P0-1-T7) -------------------------------------------

test('the search window re-renders its status line when the language switches', () => {
  // `#statusText` carries a static `data-i18n` marker, so the broadcast's
  // applyTranslations() rewrites it to "detecting" and the status render has to
  // run again afterwards. The retained payload's `messageKey` is what makes that
  // re-render change the language: the main process publishes `message` already
  // resolved, in the language that was active when it published.
  const html = fs.readFileSync(path.join(root, 'search', 'search.html'), 'utf8')
  const script = fs.readFileSync(path.join(root, 'search', 'search.js'), 'utf8')

  assert.match(html, /data-i18n="search\.status\.detecting"/)
  assert.match(script, /let lastStatus = null/)
  assert.match(script, /typeof current\.messageKey === 'string' && current\.messageKey/)
  assert.match(script, /t\(\s*current\.messageKey\s*\)/)
  assert.match(script, /current\.message \|\| t\('search\.status\.detecting'\)/)
  assert.match(
    script,
    /onInterfaceLanguage\(\(language\) => \{[\s\S]*?applyTranslations\(\)\s*\n\s*renderStatus\(\)\s*\n\s*renderTabs\(\)/
  )
  // `t(status.messageKey)` only resolves because the window loads the domain
  // table that owns the Everything status keys (shared/locales/main.js).
  assert.match(html, /shared\/locales\/main\.js/)
})

test('the long-capture status line survives a language switch', () => {
  // The markup keeps the static key on purpose: applyTranslations() restores the
  // static copy first, then renderStatusText() puts the live status back from the
  // stored state (a key + params, or a raw diagnostic).
  const html = fs.readFileSync(path.join(root, 'long-capture', 'long-capture.html'), 'utf8')
  const script = fs.readFileSync(path.join(root, 'long-capture', 'long-capture.js'), 'utf8')

  assert.match(html, /id="status" data-i18n="long-capture\.status\.preparing"/)
  assert.match(script, /let statusState = \{ key: 'long-capture\.status\.preparing' \}/)
  assert.match(script, /function renderStatusText\(\) \{/)
  assert.match(script, /function setStatusKey\(key, params, confidence\) \{/)
  assert.match(script, /Object\.hasOwn\(statusState, 'raw'\)/)
  assert.match(script, /Number\.isFinite\(statusConfidence\)/)
  // Every translatable status stores its key; only raw diagnostics stay sentences.
  assert.doesNotMatch(script, /setStatus\(t\(/)
  assert.match(script, /setStatusKey\('long-capture\.status\.capture-failed', \{ detail: error\.message \}\)/)
  assert.match(script, /setStatus\(error\.message \|\| String\(error\)\)/)
  assert.match(script, /if \(workerError\) setStatus\(workerError\.message\)/)
  // Re-render after applyTranslations() in the broadcast, and once at boot.
  assert.match(script, /^applyTranslations\(\)\r?\nrenderStatusText\(\)/m)
  assert.match(script, /onInterfaceLanguage\(\(language\) => \{[\s\S]*?applyTranslations\(\)\r?\n\s+renderStatusText\(\)/)
})
