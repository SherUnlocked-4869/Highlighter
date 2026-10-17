'use strict'
// Explicit manual-device probe. Electron only; never starts the normal app,
// hooks, user data root, updater, installer, or capture of the old clipboard.
const { app, BrowserWindow, screen, nativeTheme, session, dialog, powerMonitor, ipcMain, globalShortcut } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { spawnSync } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const rootDirectory = path.resolve(__dirname, '..')
if (process.env.HIGHLIGHTER_CLIPBOARD_TEST_INTERACTIVE !== '1') throw new Error('Explicit synthetic paste opt-in required')
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'highlighter-paste-probe-'))
app.setPath('userData', `${directory}-electron`)
const { createClipboardDomain } = require('../main/domains/clipboard')
const { createSecureWindow } = require('../main/services/window-security')
const { createSecureIpcMain } = require('../main/services/ipc-security')
const { DEFAULT_CLIPBOARD } = require('../main/services/clipboard-settings')
const settings = { language: 'zh-CN', theme: 'light', mainColor: '#e5a44c', clipboard: { ...DEFAULT_CLIPBOARD, enabled: true, paused: true } }
let domain; let server; let stopping = false
const token = randomUUID(); const operations = []
app.whenReady().then(async () => {
  const secondary = screen.getAllDisplays().find((display) => display.id !== screen.getPrimaryDisplay().id)
  if (!secondary) throw new Error('Secondary display required before any visible window')
  const seeded = spawnSync('cargo', ['run', '--quiet', '--locked', '--manifest-path', 'native/clipboard/Cargo.toml', '--example', 'seed_paste_probe', '--', directory], { cwd: rootDirectory, windowsHide: true, encoding: 'utf8' })
  if (seeded.status !== 0) throw new Error(seeded.stderr || 'Fixture seeding failed')
  const secureIpc = createSecureIpcMain({ ipcMain, BrowserWindow, rootDirectory })
  domain = createClipboardDomain({ app, BrowserWindow, screen, nativeTheme, session, dialog, powerMonitor, ipcMain: secureIpc, rootDirectory, directory,
    getSettings: () => settings, updateSettings: () => {}, getHook: () => null,
    createLocalWindow: (pagePath, options) => createSecureWindow({ BrowserWindow, pagePath, options }),
    positionAutomationWindow: (win) => { const area = secondary.workArea; win.setPosition(area.x + 40, area.y + 180) },
    isGameModeEnabled: () => false, isMigrationInProgress: () => false })
  const command = domain.service.command.bind(domain.service)
  domain.service.command = async (method, args) => {
    const started = performance.now()
    try {
      const value = await command(method, args)
      if (['paste.prepare', 'paste.commit', 'paste.cancel'].includes(method)) {
        operations.push({ method, millis: performance.now() - started, outcome: value.outcome, reason: value.reason, copied: value.copied })
      }
      return value
    } catch (error) { operations.push({ method, code: error.code }); throw error }
  }
  await domain.service.apply(settings.clipboard); await domain.service.refresh()
  if (!globalShortcut.register('Control+Alt+Shift+F10', () => domain.show())) throw new Error('Probe shortcut unavailable')
  server = http.createServer(async (request, response) => {
    if (request.headers.authorization !== token) { response.writeHead(403).end(); return }
    try {
      let value
      if (request.url === '/state') value = { pid: process.pid, nativePid: domain.service.child?.pid, secondary: secondary.workArea, operations,
        windows: BrowserWindow.getAllWindows().map((win) => ({ visible: win.isVisible(), focused: win.isFocused(), focusable: win.isFocusable(), bounds: win.getBounds() })),
        native: await command('status'), publication: await command('publication.diagnostics') }
      else if (request.url === '/quit') { value = { quitting: true }; setImmediate(() => app.quit()) }
      else { response.writeHead(404).end(); return }
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value))
    } catch (error) { response.writeHead(500).end(JSON.stringify({ error: error.code || error.message })) }
  })
  server.listen(0, '127.0.0.1', () => {
    fs.writeFileSync(path.join(rootDirectory, '.tmp', 'clipboard-paste-probe.json'), JSON.stringify({ port: server.address().port, token, directory, pid: process.pid, fixtures: JSON.parse(seeded.stdout) }))
    console.log('Synthetic paste probe ready; shortcut Ctrl+Alt+Shift+F10; secondary display only')
  })
}).catch((error) => { console.error(error.message); app.exit(1) })
app.on('window-all-closed', () => {})
app.on('before-quit', (event) => {
  if (stopping) return
  event.preventDefault(); stopping = true; globalShortcut.unregisterAll(); server?.close()
  Promise.resolve(domain?.dispose()).finally(() => app.quit())
})
