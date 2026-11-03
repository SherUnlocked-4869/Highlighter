const test = require('node:test')
const assert = require('node:assert/strict')
const {
  PointerTrackService,
  POINTER_LIMIT,
  CLICK_LIMIT,
  SAMPLED_AT_HZ,
  createPointerTrackService,
  createPointerUtilityProcessHostFactory,
  defaultPointerHostPath
} = require('../main/services/pointer-track-service')

// Fake utility-process host (contract §2.1): records messages, can answer `stopped`, and can be
// made silent to exercise the stop timeout. No native hook is involved.
function createFakeHost({ answerStop = true, onKill = null } = {}) {
  const messageListeners = new Set()
  const exitListeners = new Set()
  const host = {
    sent: [],
    killed: 0,
    disposed: 0,
    postMessage(message) {
      host.sent.push(message)
      if (message.type === 'stop' && answerStop) {
        setImmediate(() => {
          for (const listener of [...messageListeners]) listener({ type: 'status', status: 'stopped' })
        })
      }
      if (message.type === 'dispose') host.disposed += 1
    },
    onMessage(listener) {
      messageListeners.add(listener)
      return () => messageListeners.delete(listener)
    },
    onExit(listener) {
      exitListeners.add(listener)
      return () => exitListeners.delete(listener)
    },
    kill() {
      host.killed += 1
      if (typeof onKill === 'function') onKill()
    },
    emitMessage(message) {
      for (const listener of [...messageListeners]) listener(message)
    },
    emitExit(payload = { code: 0 }) {
      for (const listener of [...exitListeners]) listener(payload)
    },
    get messageListenerCount() { return messageListeners.size },
    get exitListenerCount() { return exitListeners.size }
  }
  return host
}

function createService(options = {}) {
  const hosts = []
  const service = createPointerTrackService({
    createHost: () => {
      const host = createFakeHost(options.hostOptions)
      if (typeof options.onCreateHost === 'function') options.onCreateHost(host)
      hosts.push(host)
      return host
    },
    log: () => {},
    ...(options.serviceOptions || {})
  })
  return { service, hosts }
}

function pointer(kind, x, y, at, button = -1) {
  return { type: 'pointer', kind, x, y, button, at }
}

test('the pointer track service starts one host, collects moves/clicks and reports hz', () => {
  const { service, hosts } = createService()
  assert.equal(service.isRunning(), false)
  assert.equal(service.start(), true)
  assert.equal(service.isRunning(), true)
  assert.equal(hosts.length, 1)
  assert.deepEqual(hosts[0].sent[0], { type: 'start' })

  hosts[0].emitMessage(pointer('move', 100, 200, 1000))
  hosts[0].emitMessage(pointer('move', 110, 210, 1050))
  hosts[0].emitMessage(pointer('down', 110, 210, 1060, 0))
  hosts[0].emitMessage(pointer('up', 110, 210, 1090, 0))
  hosts[0].emitMessage(pointer('down', 120, 220, 1100, 2))

  const results = service.results()
  assert.equal(results.sampledAtHz, SAMPLED_AT_HZ)
  assert.deepEqual(results.pointer, [
    { x: 100, y: 200, at: 1000 },
    { x: 110, y: 210, at: 1050 }
  ])
  assert.deepEqual(results.clicks, [
    { x: 110, y: 210, button: 0, at: 1060 },
    { x: 120, y: 220, button: 2, at: 1100 }
  ])
  assert.equal(results.truncated, false)
})

test('malformed pointer messages are dropped without touching the buffers', () => {
  const { service, hosts } = createService()
  service.start()
  const host = hosts[0]
  for (const message of [
    null,
    'pointer',
    { type: 'pointer', kind: 'hover', x: 1, y: 2, at: 3 },
    { type: 'pointer', kind: 'move', x: 'nope', y: 2, at: 3 },
    { type: 'pointer', kind: 'move', x: 1, y: 2, at: NaN },
    { type: 'other', x: 1, y: 2, at: 3 }
  ]) {
    host.emitMessage(message)
  }
  host.emitMessage(pointer('down', 5, 6, 7, 9))
  const results = service.results()
  assert.deepEqual(results.pointer, [])
  assert.deepEqual(results.clicks, [{ x: 5, y: 6, button: 9, at: 7 }])
})

test('buffers are bounded: oldest entries drop and `truncated` is set (contract §2.1)', () => {
  const { service, hosts } = createService({
    serviceOptions: { pointerLimit: 3, clickLimit: 2 }
  })
  service.start()
  const host = hosts[0]
  for (let index = 0; index < 5; index += 1) host.emitMessage(pointer('move', index, index, 100 + index))
  for (let index = 0; index < 3; index += 1) host.emitMessage(pointer('down', index, index, 200 + index, 0))

  const results = service.results()
  assert.deepEqual(results.pointer.map((entry) => entry.x), [2, 3, 4], 'oldest moves were dropped')
  assert.deepEqual(results.clicks.map((entry) => entry.x), [1, 2], 'oldest clicks were dropped')
  assert.equal(results.truncated, true)
})

test('stop asks the host to stop, disposes it and stops collecting', async () => {
  const { service, hosts } = createService()
  service.start()
  const host = hosts[0]
  host.emitMessage(pointer('move', 10, 20, 100))
  const results = await service.stop()
  assert.deepEqual(host.sent.map((message) => message.type), ['start', 'stop', 'dispose'])
  assert.equal(host.killed, 1)
  assert.equal(service.isRunning(), false)
  assert.deepEqual(results.pointer, [{ x: 10, y: 20, at: 100 }])
  // A late event after stop cannot reach the buffers.
  host.emitMessage(pointer('move', 30, 40, 200))
  assert.equal(service.results().pointer.length, 1)
  assert.equal(host.messageListenerCount, 0, 'no listener leaks after stop')
  assert.equal(host.exitListenerCount, 0)
})

test('a host that never answers is killed after the stop timeout and the buffers are kept', async () => {
  const { service, hosts } = createService({ hostOptions: { answerStop: false }, serviceOptions: { stopTimeoutMs: 20 } })
  service.start()
  const host = hosts[0]
  host.emitMessage(pointer('move', 5, 6, 100))
  const startedAt = Date.now()
  const results = await service.stop()
  assert.ok(Date.now() - startedAt < 500, 'the timeout resolves the stop')
  assert.ok(host.killed >= 1, 'the wedged host is killed')
  assert.deepEqual(results.pointer, [{ x: 5, y: 6, at: 100 }])
  assert.equal(service.isRunning(), false)
})

test('starting again resets the buffers and creates a fresh host', async () => {
  const { service, hosts } = createService()
  service.start()
  hosts[0].emitMessage(pointer('move', 1, 2, 100))
  await service.stop()
  service.start()
  assert.equal(hosts.length, 2, 'a new session gets a new host')
  assert.deepEqual(service.results().pointer, [], 'the previous session buffer is gone')
  assert.deepEqual(hosts[1].sent[0], { type: 'start' })
  service.dispose()
})

test('an unexpected host exit stops collection and settles a pending stop', async () => {
  const { service, hosts } = createService({ hostOptions: { answerStop: false }, serviceOptions: { stopTimeoutMs: 5000 } })
  service.start()
  const host = hosts[0]
  const stopping = service.stop()
  host.emitExit({ code: 1 })
  const results = await stopping
  assert.equal(service.isRunning(), false)
  // The host exited on its own, so there is nothing left to dispose; stop() still settles.
  assert.deepEqual(host.sent.map((message) => message.type), ['start', 'stop'])
  assert.deepEqual(results.pointer, [])
})

test('a host factory failure degrades to a stopped service instead of throwing', () => {
  const service = new PointerTrackService({ createHost: () => { throw new Error('no hook') }, log: () => {} })
  assert.equal(service.start(), false)
  assert.equal(service.isRunning(), false)
  assert.throws(() => new PointerTrackService({}), /createHost/)
})

test('results() returns copies so a caller cannot mutate the live buffers', () => {
  const { service, hosts } = createService()
  service.start()
  hosts[0].emitMessage(pointer('move', 1, 2, 100))
  const first = service.results()
  first.pointer[0].x = 999
  first.pointer.push({ x: 0, y: 0, at: 0 })
  assert.deepEqual(service.results().pointer, [{ x: 1, y: 2, at: 100 }])
})

test('dispose kills the host even without a stop handshake', () => {
  const { service, hosts } = createService()
  service.start()
  service.dispose()
  assert.equal(hosts[0].killed, 1)
  assert.equal(service.isRunning(), false)
})

test('limits and hz are the frozen R5 values', () => {
  assert.equal(POINTER_LIMIT, 20000)
  assert.equal(CLICK_LIMIT, 2000)
  assert.equal(SAMPLED_AT_HZ, 20)
  assert.match(defaultPointerHostPath(), /pointer-hook-host\.js$/)
})

test('the utility-process host factory forwards messages, exits and kill to the child', () => {
  const messageListeners = new Set()
  const exitListeners = new Set()
  const child = {
    posted: [],
    killed: 0,
    postMessage(message) { child.posted.push(message) },
    on(event, listener) {
      if (event === 'message') messageListeners.add(listener)
      if (event === 'exit') exitListeners.add(listener)
    },
    removeListener(event, listener) {
      if (event === 'message') messageListeners.delete(listener)
      if (event === 'exit') exitListeners.delete(listener)
    },
    once(event, listener) {
      if (event === 'exit') child._onceExit = listener
    },
    kill() { child.killed += 1 }
  }
  const forked = []
  const factory = createPointerUtilityProcessHostFactory({
    utilityProcess: { fork: (hostPath, args, options) => { forked.push({ hostPath, args, options }); return child } },
    hostPath: '/app/main/services/pointer-hook-host.js'
  })
  const host = factory()
  assert.equal(forked.length, 1)
  assert.equal(forked[0].hostPath, '/app/main/services/pointer-hook-host.js')
  assert.equal(forked[0].options.serviceName, 'highlighter-pointer-hook')

  const received = []
  const unsubscribe = host.onMessage((data) => received.push(data))
  host.postMessage({ type: 'start' })
  assert.deepEqual(child.posted, [{ type: 'start' }])
  for (const listener of [...messageListeners]) listener({ type: 'pointer', kind: 'move' })
  assert.deepEqual(received, [{ type: 'pointer', kind: 'move' }])
  unsubscribe()
  assert.equal(messageListeners.size, 0)

  const exits = []
  host.onExit((payload) => exits.push(payload))
  for (const listener of [...exitListeners]) listener(7, 'killed')
  assert.deepEqual(exits, [{ code: 7, reason: 'killed' }])
  host.kill()
  assert.equal(child.killed, 1)
  assert.throws(() => createPointerUtilityProcessHostFactory({ utilityProcess: null, hostPath: '/x' })(), /utilityProcess\.fork/)
})
