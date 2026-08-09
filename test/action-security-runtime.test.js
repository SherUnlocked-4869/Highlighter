const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const electronPath = require('electron')
const resultPrefix = 'HIGHLIGHTER_ACTION_SECURITY_PROBE='

test('action renderer stays sandboxed and sanitizes AI output in Electron', { timeout: 45000 }, (t) => {
  const probeUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'highlighter-action-security-'))
  t.after(() => fs.rmSync(probeUserData, { recursive: true, force: true }))
  const result = spawnSync(electronPath, [path.join(root, 'scripts', 'probe-action-security.js')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 40000,
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_ENABLE_LOGGING: '0',
      HIGHLIGHTER_ACTION_SECURITY_USER_DATA: probeUserData
    }
  })

  assert.equal(
    result.status,
    0,
    `Action security probe failed.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  )
  const line = result.stdout.split(/\r?\n/).find((item) => item.startsWith(resultPrefix))
  assert.ok(line, `Action security probe did not return JSON.\nstdout:\n${result.stdout}`)
  const probe = JSON.parse(line.slice(resultPrefix.length))

  assert.deepEqual(probe.bridge.actionKeys, [
    'cancelStream',
    'finishStream',
    'onActionAppearance',
    'onActionStart',
    'onPinDenied',
    'onStreamData',
    'onStreamDone',
    'onStreamError',
    'onStreamReasoning',
    'openExternal',
    'togglePin'
  ])
  assert.equal(probe.bridge.broadApiType, 'undefined')
  assert.equal(probe.bridge.requireType, 'undefined')
  assert.equal(probe.bridge.domPurifyType, 'function')
  assert.deepEqual(probe.preferences, {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    webviewTag: false
  })
  assert.equal(probe.rendered.imageCount, 0)
  assert.equal(probe.rendered.scriptCount, 0)
  assert.equal(probe.rendered.xssExecuted, false)
  assert.doesNotMatch(probe.rendered.html, /<img|href=["']javascript:/i)
  assert.match(probe.rendered.text, /bad/)
  assert.equal(probe.rendered.links.length, 1)
  assert.equal(probe.rendered.links[0].href, 'https://example.com/safe?q=1&ok=2')
  assert.equal(probe.rendered.links[0].rel, 'noopener noreferrer')
  assert.equal(probe.rendered.links[0].target, '')
  assert.deepEqual(probe.openedUrls, ['https://example.com/safe?q=1&ok=2'])
  assert.deepEqual(probe.streamSignals, [{ channel: 'finish', streamId: 7 }])
  assert.equal(probe.childWindowResult, true)
  assert.match(probe.finalUrl, /action\/action\.html$/)
  assert.deepEqual(probe.blocked.map((entry) => entry.reason).sort(), [
    'blocked-navigation',
    'blocked-window-open'
  ])
})
