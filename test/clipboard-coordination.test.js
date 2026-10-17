const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { fork } = require('node:child_process')
const { once } = require('node:events')
const { probe } = require('../scripts/probe-clipboard-native')

function available(t) {
  if (process.platform === 'win32' && fs.existsSync(path.resolve(__dirname, '../native/clipboard/bin/HighlighterClipboard.exe'))) return true
  if (process.env.HIGHLIGHTER_REQUIRE_CLIPBOARD_NATIVE === '1') assert.fail('Build the Windows clipboard native executable first')
  t.skip('Windows clipboard native executable not built')
  return false
}

async function message(child, type) {
  const deadline = AbortSignal.timeout(5000)
  for (;;) {
    const [value] = await once(child, 'message', { signal: deadline })
    if (value.type === 'failed') assert.fail('Synthetic lease client failed')
    if (value.type === type) return
  }
}

test('native addon authenticates leases, finishes 100 rounds and rejects bad credentials', { timeout: 30000 }, async (t) => {
  if (!available(t)) return
  await probe({ timeoutMs: 25000, observe: async (_pid, _initial, request) => {
    const start = await request('coordination.start', { hostPid: process.pid })
    assert.equal(start.ok, true, start.error?.code)
    const endpoint = start.result
    const Hook = require('selection-hook')
    const hook = new Hook()
    try {
      hook.setClipboardCoordinator(endpoint)
      for (let index = 0; index < 100; index++) assert.equal(await hook.checkClipboardCoordinator(), true, `Lease round ${index}`)
      const status = (await request('coordination.status')).result
      assert.equal(status.phase, 'idle')
      assert.equal(status.lastCompletion.outcome, 'interrupted')
      assert.deepEqual(status.lastCompletion.anchors, [0, 0, 0, 0, 0])
      assert.ok(!JSON.stringify(status).includes(endpoint.nonce))
      assert.ok(!JSON.stringify(status).includes(endpoint.hostEpoch))
      assert.ok(!JSON.stringify(status).includes(endpoint.pipeName))
      hook.setClipboardCoordinator({ ...endpoint, nonce: '0'.repeat(64) })
      assert.equal(await hook.checkClipboardCoordinator(), false)
      assert.equal((await request('coordination.status')).result.phase, 'idle')
      hook.setClipboardCoordinator({ ...endpoint, serverPid: endpoint.serverPid + 1 })
      assert.equal(await hook.checkClipboardCoordinator(), false)
      assert.throws(() => hook.setClipboardCoordinator({ ...endpoint, hostPid: process.pid + 1 }), /Invalid private clipboard coordinator/)
      assert.equal(await hook.checkClipboardCoordinator(), false)
      hook.setClipboardCoordinator(endpoint)
      assert.equal(await hook.checkClipboardCoordinator(), true)
      assert.equal((await request('coordination.stop')).ok, true)
      assert.equal(await hook.checkClipboardCoordinator(), false)
    } finally { hook.setClipboardCoordinator(null); hook.cleanup() }
  } })
})

test('lost lease stays orphaned until its registered process actually exits', { timeout: 20000 }, async (t) => {
  if (!available(t)) return
  const child = fork(path.join(__dirname, 'fixtures/clipboard-lease-client.js'), [], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  const exited = once(child, 'exit')
  t.after(async () => { child.kill(); await exited.catch(() => {}) })
  await message(child, 'ready')
  await probe({ observe: async (_pid, _initial, request) => {
    const start = await request('coordination.start', { hostPid: child.pid })
    assert.equal(start.ok, true, start.error?.code)
    const active = message(child, 'active')
    child.send({ type: 'begin', endpoint: start.result })
    await active
    assert.equal((await request('coordination.status')).result.phase, 'active')
    assert.equal((await request('coordination.recover')).error.code, 'HOST_STILL_RUNNING')
    assert.equal((await request('quiesce')).error.code, 'COORDINATION_BUSY')
    const disconnected = message(child, 'disconnected')
    child.send({ type: 'disconnect' })
    await disconnected
    let phase
    for (let count = 0; count < 20; count++) {
      phase = (await request('coordination.status')).result.phase
      if (phase === 'orphaned') break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(phase, 'orphaned')
    assert.equal((await request('coordination.recover')).error.code, 'HOST_STILL_RUNNING')
    child.kill()
    await exited
    assert.equal((await request('coordination.recover')).ok, true)
    assert.equal((await request('quiesce')).ok, true)
  } })
})

test('a different process cannot use the registered hosts correct credentials', { timeout: 20000 }, async (t) => {
  if (!available(t)) return
  const child = fork(path.join(__dirname, 'fixtures/clipboard-lease-client.js'), [], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  const exited = once(child, 'exit')
  t.after(async () => { child.kill(); await exited.catch(() => {}) })
  await message(child, 'ready')
  await probe({ observe: async (_pid, _initial, request) => {
    const start = await request('coordination.start', { hostPid: process.pid })
    assert.equal(start.ok, true, start.error?.code)
    const rejected = message(child, 'rejected')
    child.send({ type: 'begin', endpoint: start.result })
    await rejected
    assert.equal((await request('coordination.status')).result.phase, 'idle')
    assert.equal((await request('coordination.stop')).ok, true)
  } })
})

test('lease expiry blocks capture while the registered host remains alive', { timeout: 20000 }, async (t) => {
  if (!available(t)) return
  const child = fork(path.join(__dirname, 'fixtures/clipboard-lease-client.js'), [], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  const exited = once(child, 'exit')
  t.after(async () => { child.kill(); await exited.catch(() => {}) })
  await message(child, 'ready')
  await probe({ observe: async (_pid, _initial, request) => {
    const start = await request('coordination.start', { hostPid: child.pid })
    assert.equal(start.ok, true, start.error?.code)
    const active = message(child, 'active')
    child.send({ type: 'begin', endpoint: start.result })
    await active
    await new Promise((resolve) => setTimeout(resolve, 2150))
    const status = (await request('coordination.status')).result
    assert.equal(status.phase, 'orphaned')
    assert.equal(status.hostAlive, true)
    assert.equal((await request('coordination.recover')).error.code, 'HOST_STILL_RUNNING')
    child.kill()
    await exited
    assert.equal((await request('coordination.recover')).ok, true)
    assert.equal((await request('quiesce')).ok, true)
  } })
})
