const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

const { createUsageWorkerClient } = require('../main/services/usage-worker-client')

function createFakeChild({ onPostMessage = null } = {}) {
  const child = new EventEmitter()
  child.messages = []
  child.killed = false
  child.postMessage = (message) => {
    child.messages.push(message)
    if (onPostMessage) onPostMessage(message, child)
  }
  child.kill = () => { child.killed = true }
  return child
}

function nextTick(fn) {
  setImmediate(fn)
}

test('worker client sends a scan request and resolves the parsed result', async () => {
  const progress = []
  const child = createFakeChild({
    onPostMessage: (message, fake) => nextTick(() => {
      fake.emit('message', { type: 'progress', id: message.id, progress: { index: 1, total: 2 } })
      fake.emit('message', {
        type: 'result',
        id: message.id,
        result: { upserts: [{ source: 'codex' }], removed: [], cursors: {}, stats: { rows: 1 } }
      })
    })
  })
  const client = createUsageWorkerClient({ fork: () => child, requestTimeoutMs: 1000 })
  const result = await client.scanTool(
    { source: 'codex', files: ['a.jsonl'], cursors: {}, queuePath: 'queue.jsonl' },
    { onProgress: (value) => progress.push(value) }
  )
  assert.equal(child.messages.length, 1)
  assert.equal(child.messages[0].type, 'scan')
  assert.equal(child.messages[0].request.source, 'codex')
  assert.equal(child.messages[0].request.files[0], 'a.jsonl')
  assert.deepEqual(result, { upserts: [{ source: 'codex' }], removed: [], cursors: {}, stats: { rows: 1 } })
  assert.deepEqual(progress, [{ index: 1, total: 2 }])
  client.dispose()
})

test('worker client records fork cold start from the ready message', async () => {
  const child = createFakeChild()
  const client = createUsageWorkerClient({ fork: () => child, requestTimeoutMs: 1000 })
  client.ensureChild()
  child.emit('message', { type: 'ready', pid: 123, startedAt: Date.now() })
  const diagnostics = client.getDiagnostics()
  assert.equal(diagnostics.forkCount, 1)
  assert.equal(typeof diagnostics.lastColdStartMs, 'number')
  assert.ok(diagnostics.lastColdStartMs >= 0)
  assert.equal(client.isRunning(), true)
  client.dispose()
  assert.equal(child.killed, true)
})

test('worker client reuses one worker for sequential scans', async () => {
  let forkCalls = 0
  const child = createFakeChild({
    onPostMessage: (message, fake) => nextTick(() => {
      fake.emit('message', { type: 'result', id: message.id, result: { upserts: [], removed: [], cursors: {}, stats: {} } })
    })
  })
  const client = createUsageWorkerClient({
    fork: () => { forkCalls += 1; return child },
    requestTimeoutMs: 1000
  })
  await client.scanTool({ source: 'codex', files: [], cursors: {}, queuePath: 'q' })
  await client.scanTool({ source: 'codex', files: [], cursors: {}, queuePath: 'q' })
  assert.equal(forkCalls, 1)
  assert.equal(child.messages.length, 2)
  client.dispose()
})

test('worker client rejects on a worker error message', async () => {
  const child = createFakeChild({
    onPostMessage: (message, fake) => nextTick(() => {
      fake.emit('message', { type: 'error', id: message.id, message: 'parse exploded' })
    })
  })
  const client = createUsageWorkerClient({ fork: () => child, requestTimeoutMs: 1000 })
  await assert.rejects(
    client.scanTool({ source: 'codex', files: [], cursors: {}, queuePath: 'q' }),
    /parse exploded/
  )
  client.dispose()
})

test('worker client times out an unresponsive request and rejects the next on exit', async () => {
  const silent = createFakeChild()
  const client = createUsageWorkerClient({ fork: () => silent, requestTimeoutMs: 20 })
  await assert.rejects(
    client.scanTool({ source: 'codex', files: [], cursors: {}, queuePath: 'q' }),
    /timed out/
  )
  assert.deepEqual(client.getDiagnostics().pending, 0)
  client.dispose()
})

test('worker client rejects a pending request when the worker exits', async () => {
  const child = createFakeChild()
  const client = createUsageWorkerClient({ fork: () => child, requestTimeoutMs: 5000 })
  const pending = client.scanTool({ source: 'codex', files: [], cursors: {}, queuePath: 'q' })
  await new Promise((resolve) => nextTick(resolve))
  child.emit('exit', 7, 'crash')
  await assert.rejects(pending, /exited \(code 7\)/)
  assert.equal(client.isRunning(), false)
  assert.equal(client.getDiagnostics().lastExit.code, 7)
  // A later scan forks a fresh worker instead of reusing the dead one.
  const replacement = createFakeChild({
    onPostMessage: (message, fake) => nextTick(() => {
      fake.emit('message', { type: 'result', id: message.id, result: { upserts: [], removed: [], cursors: {}, stats: {} } })
    })
  })
  let replacements = 0
  const recovering = createUsageWorkerClient({ fork: () => { replacements += 1; return replacement }, requestTimeoutMs: 1000 })
  await recovering.scanTool({ source: 'codex', files: [], cursors: {}, queuePath: 'q' })
  assert.equal(replacements, 1)
  recovering.dispose()
  client.dispose()
})

test('worker client rejects malformed forks and disposed calls', async () => {
  const client = createUsageWorkerClient({ fork: () => ({}), requestTimeoutMs: 50 })
  await assert.rejects(
    client.scanTool({ source: 'codex', files: [], cursors: {}, queuePath: 'q' }),
    /invalid child process/
  )
  client.dispose()
  await assert.rejects(
    client.scanTool({ source: 'codex', files: [], cursors: {}, queuePath: 'q' }),
    /disposed/
  )
})

test('worker client rejects in-flight requests on dispose', async () => {
  const child = createFakeChild()
  const client = createUsageWorkerClient({ fork: () => child, requestTimeoutMs: 5000 })
  const pending = client.scanTool({ source: 'codex', files: [], cursors: {}, queuePath: 'q' })
  await new Promise((resolve) => nextTick(resolve))
  client.dispose()
  await assert.rejects(pending, /disposed/)
  assert.equal(child.killed, true)
})

const SCAN_REQUEST = { source: 'codex', files: [], cursors: {}, queuePath: 'q' }
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function createResultChild() {
  return createFakeChild({
    onPostMessage: (message, fake) => nextTick(() => {
      fake.emit('message', {
        type: 'result',
        id: message.id,
        result: { upserts: [], removed: [], cursors: {}, stats: {} }
      })
    })
  })
}

test('worker client exits an idle worker and reports the idle exit', async () => {
  const child = createResultChild()
  const logs = []
  const client = createUsageWorkerClient({
    fork: () => child,
    requestTimeoutMs: 1000,
    idleTimeoutMs: 15,
    log: (line) => logs.push(line)
  })
  await client.scanTool(SCAN_REQUEST)
  assert.equal(client.getDiagnostics().idleTimerArmed, true)
  await delay(60)
  assert.equal(child.killed, true)
  assert.equal(client.isRunning(), false)
  const diagnostics = client.getDiagnostics()
  assert.equal(diagnostics.idleTimeoutMs, 15)
  assert.equal(typeof diagnostics.lastIdleExitAt, 'number')
  assert.equal(diagnostics.idleTimerArmed, false)
  assert.equal(logs.some((line) => /idle/i.test(line)), true)
  client.dispose()
})

test('worker client keeps an in-flight worker alive past the idle timeout', async () => {
  const child = createFakeChild()
  const client = createUsageWorkerClient({ fork: () => child, requestTimeoutMs: 5000, idleTimeoutMs: 15 })
  const pending = client.scanTool(SCAN_REQUEST)
  await delay(60)
  assert.equal(child.killed, false)
  assert.equal(client.isRunning(), true)
  const diagnostics = client.getDiagnostics()
  assert.equal(diagnostics.pending, 1)
  assert.equal(diagnostics.idleTimerArmed, false)
  client.dispose()
  await assert.rejects(pending, /disposed/)
})

test('worker client cancels the idle timer when a new scan starts', async () => {
  let silent = false
  const child = createFakeChild({
    onPostMessage: (message, fake) => {
      if (silent) return
      nextTick(() => {
        fake.emit('message', {
          type: 'result',
          id: message.id,
          result: { upserts: [], removed: [], cursors: {}, stats: {} }
        })
      })
    }
  })
  const client = createUsageWorkerClient({ fork: () => child, requestTimeoutMs: 5000, idleTimeoutMs: 20 })
  await client.scanTool(SCAN_REQUEST)
  assert.equal(client.getDiagnostics().idleTimerArmed, true)
  silent = true
  const second = client.scanTool(SCAN_REQUEST)
  assert.equal(client.getDiagnostics().idleTimerArmed, false)
  await delay(60)
  assert.equal(child.killed, false)
  assert.equal(client.getDiagnostics().lastIdleExitAt, null)
  client.dispose()
  await assert.rejects(second, /disposed/)
})

test('worker client dispose cancels the pending idle timer', async () => {
  const child = createResultChild()
  const client = createUsageWorkerClient({ fork: () => child, requestTimeoutMs: 1000, idleTimeoutMs: 10 })
  await client.scanTool(SCAN_REQUEST)
  assert.equal(client.getDiagnostics().idleTimerArmed, true)
  client.dispose()
  await delay(40)
  assert.equal(client.getDiagnostics().lastIdleExitAt, null)
  assert.equal(client.getDiagnostics().idleTimerArmed, false)
  // dispose kills the worker itself, not through the idle path.
  assert.equal(child.killed, true)
})

test('worker client forks a fresh worker after an idle exit', async () => {
  const children = [createResultChild(), createResultChild()]
  let forks = 0
  const client = createUsageWorkerClient({
    fork: () => children[forks++],
    requestTimeoutMs: 1000,
    idleTimeoutMs: 15
  })
  await client.scanTool(SCAN_REQUEST)
  assert.equal(forks, 1)
  await delay(60)
  assert.equal(client.isRunning(), false)
  const result = await client.scanTool(SCAN_REQUEST)
  assert.equal(forks, 2)
  assert.equal(client.isRunning(), true)
  assert.deepEqual(result, { upserts: [], removed: [], cursors: {}, stats: {} })
  client.dispose()
})

test('worker client keeps the worker warm when the idle timeout is disabled', async () => {
  const child = createResultChild()
  const client = createUsageWorkerClient({ fork: () => child, requestTimeoutMs: 1000 })
  await client.scanTool(SCAN_REQUEST)
  await delay(40)
  assert.equal(child.killed, false)
  assert.equal(client.isRunning(), true)
  const diagnostics = client.getDiagnostics()
  assert.equal(diagnostics.idleTimeoutMs, 0)
  assert.equal(diagnostics.idleTimerArmed, false)
  assert.equal(diagnostics.lastIdleExitAt, null)
  client.dispose()
})

test('worker client ignores a late exit from an idle-killed worker', async () => {
  const first = createResultChild()
  const second = createResultChild()
  const children = [first, second]
  let forks = 0
  const client = createUsageWorkerClient({
    fork: () => children[forks++],
    requestTimeoutMs: 1000,
    idleTimeoutMs: 10
  })
  await client.scanTool(SCAN_REQUEST)
  await delay(40)
  assert.equal(client.isRunning(), false)
  const pending = client.scanTool(SCAN_REQUEST)
  // The killed worker's exit event arrives after the replacement was forked.
  first.emit('exit', 0, 'killed')
  assert.equal(client.isRunning(), true)
  assert.equal(client.getDiagnostics().lastExit.code, 0)
  await pending
  assert.equal(forks, 2)
  client.dispose()
})
