const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const electronPath = require('electron')
const resultPrefix = 'HIGHLIGHTER_WINDOW_SECURITY_PROBE='

test('every remaining renderer loads under the locked Electron sandbox', { timeout: 45000 }, (t) => {
  const probeUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'highlighter-window-security-'))
  t.after(() => fs.rmSync(probeUserData, { recursive: true, force: true }))
  const result = spawnSync(electronPath, [path.join(root, 'scripts', 'probe-window-security.js')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 40000,
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      ELECTRON_ENABLE_LOGGING: '0',
      HIGHLIGHTER_WINDOW_SECURITY_USER_DATA: probeUserData
    }
  })

  assert.equal(
    result.status,
    0,
    `Window security probe failed.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  )
  const line = result.stdout.split(/\r?\n/).find((item) => item.startsWith(resultPrefix))
  assert.ok(line, `Window security probe did not return JSON.\nstdout:\n${result.stdout}`)
  const probe = JSON.parse(line.slice(resultPrefix.length))

  assert.deepEqual(probe.windows.map((entry) => entry.name), [
    'config',
    'toolbar',
    'capture',
    'long-overlay',
    'long-capture',
    'pin',
    'recognition',
    'record-frame',
    'record'
  ])
  for (const entry of probe.windows) {
    assert.equal(entry.state.apiType, 'object', `${entry.name} preload bridge`)
    assert.equal(entry.state.requireType, 'undefined', `${entry.name} require isolation`)
    assert.equal(entry.state.processType, 'undefined', `${entry.name} process isolation`)
    assert.equal(entry.state.markerType, 'function', `${entry.name} renderer script`)
    assert.match(entry.state.csp, /default-src 'none'/, `${entry.name} CSP default`)
    assert.match(entry.state.csp, /connect-src 'none'/, `${entry.name} CSP network`)
    assert.equal(entry.state.inlineScriptCount, 0, `${entry.name} inline scripts`)
    assert.ok(entry.state.externalScriptCount >= 1, `${entry.name} external scripts`)
    assert.ok(entry.state.styleSheetCount >= 1, `${entry.name} stylesheet`)
    assert.deepEqual(entry.preferences, {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false
    })
    assert.equal(
      entry.consoleMessages.some((message) => /Refused to|Uncaught|ERR_/i.test(message)),
      false,
      `${entry.name} console errors: ${entry.consoleMessages.join(' | ')}`
    )
    assert.deepEqual(entry.blocked, [])
  }
  assert.deepEqual(
    probe.windows.find((entry) => entry.name === 'long-capture').state.matcherWorker,
    { id: 7, status: 'initialized' }
  )
})
