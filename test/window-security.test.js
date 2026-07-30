const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { pathToFileURL } = require('url')
const {
  createSecureWebPreferences,
  createSecureWindow,
  isAllowedLocalUrl,
  isSafeExternalUrl
} = require('../main/services/window-security')

class FakeWebContents {
  constructor() {
    this.listeners = new Map()
    this.windowOpenHandler = null
  }

  on(event, listener) {
    this.listeners.set(event, listener)
  }

  setWindowOpenHandler(handler) {
    this.windowOpenHandler = handler
  }
}

class FakeBrowserWindow {
  constructor(options) {
    this.options = options
    this.webContents = new FakeWebContents()
  }
}

function createEvent() {
  return {
    prevented: false,
    preventDefault() {
      this.prevented = true
    }
  }
}

test('secure web preferences cannot be weakened by a caller', () => {
  const preload = path.resolve(__dirname, '..', 'preload.js')
  const preferences = createSecureWebPreferences({
    preload,
    backgroundThrottling: false,
    contextIsolation: false,
    nodeIntegration: true,
    sandbox: false,
    webSecurity: false,
    allowRunningInsecureContent: true
  })

  assert.equal(preferences.preload, preload)
  assert.equal(preferences.backgroundThrottling, false)
  assert.equal(preferences.contextIsolation, true)
  assert.equal(preferences.nodeIntegration, false)
  assert.equal(preferences.sandbox, true)
  assert.equal(preferences.webSecurity, true)
  assert.equal(preferences.allowRunningInsecureContent, false)
  assert.throws(() => createSecureWebPreferences({ preload: 'preload.js' }), /absolute preload path/)
})

test('local page allowlists compare exact file targets and safe external protocols', () => {
  const pagePath = path.resolve(__dirname, '..', 'config', 'config.html')
  const otherPath = path.resolve(__dirname, '..', 'action', 'action.html')

  assert.equal(isAllowedLocalUrl(pathToFileURL(pagePath).href, [pagePath]), true)
  assert.equal(isAllowedLocalUrl(`${pathToFileURL(pagePath).href}?route=home#top`, [pagePath]), true)
  assert.equal(isAllowedLocalUrl(pathToFileURL(otherPath).href, [pagePath]), false)
  assert.equal(isAllowedLocalUrl('https://example.com', [pagePath]), false)
  assert.equal(isSafeExternalUrl('https://example.com/path'), true)
  assert.equal(isSafeExternalUrl('http://example.com'), true)
  assert.equal(isSafeExternalUrl('javascript:alert(1)'), false)
  assert.equal(isSafeExternalUrl('file:///tmp/secret'), false)
})

test('secure windows block renderer navigation, webviews, and child windows', async () => {
  const pagePath = path.resolve(__dirname, '..', 'action', 'action.html')
  const preload = path.resolve(__dirname, '..', 'preload-action.js')
  const opened = []
  const blocked = []
  const win = createSecureWindow({
    BrowserWindow: FakeBrowserWindow,
    pagePath,
    options: {
      width: 500,
      webPreferences: { preload, sandbox: false }
    },
    openExternal: (url) => opened.push(url),
    onBlocked: (entry) => blocked.push(entry)
  })

  assert.equal(win.options.width, 500)
  assert.equal(win.options.webPreferences.sandbox, true)

  const allowedEvent = createEvent()
  win.webContents.listeners.get('will-navigate')(allowedEvent, pathToFileURL(pagePath).href)
  assert.equal(allowedEvent.prevented, false)

  const externalEvent = createEvent()
  win.webContents.listeners.get('will-navigate')(externalEvent, 'https://example.com/docs')
  assert.equal(externalEvent.prevented, true)

  const scriptEvent = createEvent()
  win.webContents.listeners.get('will-redirect')(scriptEvent, 'javascript:alert(1)')
  assert.equal(scriptEvent.prevented, true)

  const webviewEvent = createEvent()
  win.webContents.listeners.get('will-attach-webview')(webviewEvent, {}, { src: 'https://example.com/embed' })
  assert.equal(webviewEvent.prevented, true)

  assert.deepEqual(win.webContents.windowOpenHandler({ url: 'https://example.com/result' }), { action: 'deny' })
  assert.deepEqual(win.webContents.windowOpenHandler({ url: 'file:///tmp/secret' }), { action: 'deny' })
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(opened, ['https://example.com/docs', 'https://example.com/result'])
  assert.deepEqual(blocked.map((entry) => entry.reason), [
    'blocked-url',
    'blocked-webview',
    'blocked-url'
  ])
  assert.deepEqual(blocked.map((entry) => entry.url), [
    'javascript:<blocked>',
    'https://example.com/embed',
    'file://<blocked>'
  ])
})

test('all application windows use the centralized security factory and least-privilege action preload', () => {
  const root = path.resolve(__dirname, '..')
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
  const commonPreload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8')
  const actionPreload = fs.readFileSync(path.join(root, 'preload-action.js'), 'utf8')
  const actionScript = fs.readFileSync(path.join(root, 'action', 'action.js'), 'utf8')
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

  assert.doesNotMatch(main, /new BrowserWindow/)
  assert.match(main, /createSecureWindow\(\{/)
  assert.match(main, /preload: path\.join\(__dirname, 'preload-action\.js'\)/)
  assert.doesNotMatch(commonPreload, /require\('showdown'\)/)
  assert.doesNotMatch(commonPreload, /onActionStart|stream:data|window:toggle-pin/)
  assert.match(actionPreload, /onActionStart:[\s\S]*action:start/)
  assert.match(actionPreload, /onStreamData:[\s\S]*stream:data/)
  assert.doesNotMatch(actionPreload, /settings:|history:|config:get-api-key/)
  assert.match(actionScript, /\['http:', 'https:'\]\.includes\(url\.protocol\)/)
  assert.match(actionScript, /rel="noopener noreferrer"/)
  assert.match(actionScript, /\.replace\(\/"\/g, '&quot;'\)/)
  assert.ok(packageJson.build.files.includes('preload-action.js'))
})
