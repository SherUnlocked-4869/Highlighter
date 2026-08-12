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
  assert.match(script, /长截图匹配超时/)
  assert.match(script, /rejectWorkerRequests/)
})
