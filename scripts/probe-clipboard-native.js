'use strict'

const path = require('node:path')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const { encodeFrame, FrameDecoder } = require('./lib/clipboard-protocol')
const { sourceBuildId } = require('./build-clipboard-native')

async function probe({ observe, timeoutMs = 15000 } = {}) {
  const executable = path.resolve(__dirname, '../native/clipboard/bin/HighlighterClipboard.exe')
  const child = spawn(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const closed = once(child, 'close')
  const decoder = new FrameDecoder()
  let pending = null
  let counter = 0
  let epoch
  let failure
  let stderrBytes = 0
  const fail = (error) => { failure = error; pending?.reject(error) }
  child.on('error', fail)
  child.stdin.on('error', fail)
  child.stdout.on('data', (chunk) => {
    try {
      for (const frame of decoder.feed(chunk)) {
        assert.ok(pending, 'Unexpected native response')
        assert.equal(frame.payload.length, 0)
        assert.equal(frame.header.version, 1)
        assert.equal(frame.header.type, 'response')
        assert.equal(frame.header.requestId, pending.id)
        if (epoch) assert.equal(frame.header.sessionEpoch, epoch)
        else epoch = frame.header.sessionEpoch
        assert.equal(typeof epoch, 'string')
        pending.resolve(frame.header)
        pending = null
      }
    } catch (error) { fail(error) }
  })
  child.stderr.on('data', (chunk) => { stderrBytes += chunk.length })
  child.on('close', () => { if (pending) fail(new Error('Native process closed before response')) })
  function request(method, params = {}, sessionEpoch = epoch) {
    if (failure) return Promise.reject(failure)
    assert.equal(pending, null)
    return new Promise((resolve, reject) => {
      const id = String(++counter)
      const timeout = setTimeout(() => reject(new Error('Native request timed out')), 5000)
      pending = { id, resolve: (result) => { clearTimeout(timeout); resolve(result) }, reject: (error) => { clearTimeout(timeout); reject(error) } }
      child.stdin.write(encodeFrame({ version: 1, type: 'request', requestId: id, sessionEpoch, method, params }))
    })
  }
  const watchdog = setTimeout(() => child.kill(), timeoutMs)
  try {
    const initial = await request('initialize')
    assert.equal(initial.ok, true)
    assert.equal(initial.result.enabled, false)
    assert.equal(initial.result.capabilities.history, false)
    assert.equal(initial.result.capabilities.coordination, true)
    assert.equal(initial.result.capabilities.qualified, false)
    assert.equal(initial.result.nativeBuildId, sourceBuildId())
    if (observe) await observe(child.pid, initial.result, request)
    assert.equal((await request('status', {}, 'wrong-epoch')).error.code, 'SESSION_MISMATCH')
    assert.equal((await request('unsupported')).error.code, 'UNSUPPORTED_METHOD')
    assert.equal((await request('configure', { enabled: false })).result.enabled, false)
    assert.equal((await request('status')).result.accepted, 0)
    for (let index = 0; index < 2; index++) assert.equal((await request('quiesce')).result.phase, 'stopped')
    child.stdin.end()
    const [code] = await closed
    assert.equal(code, 0)
    decoder.finish()
    assert.equal(stderrBytes, 0)
    return { buildId: initial.result.nativeBuildId, defaultEnabled: false, exitCode: code }
  } finally {
    clearTimeout(watchdog)
    if (child.exitCode === null) child.kill()
    await closed.catch(() => {})
  }
}

if (require.main === module) {
  probe().then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
module.exports = { probe }
