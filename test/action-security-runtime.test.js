const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const electronPath = require('electron')
const resultPrefix = 'HIGHLIGHTER_ACTION_SECURITY_PROBE='

test('action security probe registers every action-surface IPC channel', () => {
  const probe = fs.readFileSync(path.join(root, 'scripts', 'probe-action-security.js'), 'utf8')
  // The probe only stands up the action surface, so assertComplete() cannot run
  // there. Lock its channel coverage here instead: a new action channel must be
  // added to the probe in the same change, or the probe silently stops testing it.
  for (const channel of ['shell:open-external', 'stream:cancel', 'stream:finish', 'window:toggle-pin', 'chat:ask', 'chat:copy']) {
    const kind = channel === 'shell:open-external' || channel === 'chat:copy' ? 'handle' : 'on'
    assert.match(probe, new RegExp(`secureIpcMain\\.${kind}\\('${channel}'`), `probe must register ${channel}`)
  }
})

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
    'askQuestion',
    'cancelStream',
    'copyConversation',
    'finishStream',
    'onActionAppearance',
    'onActionStart',
    'onChatTurn',
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
  assert.deepEqual(probe.streamSignals, [
    { channel: 'finish', streamId: 7 },
    { channel: 'finish', streamId: 7 }
  ])
  assert.equal(probe.followUpAsked, true)
  assert.deepEqual(probe.chatAsks, [{ streamId: 7, question: '追问 <b>内容</b>' }])
  // The follow-up round goes through the same sanitizer as the first one.
  assert.equal(probe.followUp.imageCount, 0)
  assert.equal(probe.followUp.scriptCount, 0)
  assert.equal(probe.followUp.xssExecuted, false)
  assert.doesNotMatch(probe.followUp.html, /<img|href=["']javascript:/i)
  assert.match(probe.followUp.text, /bad/)
  assert.equal(probe.followUp.links.length, 1)
  assert.equal(probe.followUp.links[0].href, 'https://example.com/follow?x=1&y=2')
  assert.equal(probe.followUp.links[0].rel, 'noopener noreferrer')
  assert.equal(probe.followUp.links[0].target, '')
  // The user's question is injected with textContent, never as markup.
  assert.equal(probe.followUp.questionText, '追问 <b>内容</b>')
  assert.doesNotMatch(probe.followUp.questionMarkup, /<b>/i)
  // The context-trim notice rides on chat:turn and lands on the round it applies
  // to — the first round must not grow one.
  assert.equal(probe.followUp.noticeText, '已省略更早的 2 轮对话以控制上下文长度')
  assert.equal(probe.followUp.firstRoundNotice, '')
  // Only the bridge's own clamp protects the main process from an oversized
  // transcript, so assert both what arrives and how the edge cases are refused.
  assert.deepEqual(probe.copyRequests, [65536])
  assert.equal(probe.copyOversized, true)
  assert.equal(probe.copyEmpty, false)
  assert.equal(probe.copyNonString, false)
  assert.equal(probe.childWindowResult, true)
  assert.match(probe.finalUrl, /action\/action\.html$/)
  assert.deepEqual(probe.blocked.map((entry) => entry.reason).sort(), [
    'blocked-navigation',
    'blocked-window-open'
  ])
})
