const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')
const { EventEmitter } = require('node:events')

const { EverythingService } = require('../main/services/everything-service')
// The service resolves its status copy through the main-process runtime; the
// tests assert the published pair (message + the key it came from) instead of
// hard-coding one language's sentence.
const { t } = require('../main/services/i18n-bootstrap')

function createFakeSidecar() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stderr.setEncoding = () => {}
  child.pid = 4242
  child.killed = false
  child.kill = () => { child.killed = true }
  child.unref = () => {}
  return child
}

function createRespondingSidecar(handlers = {}) {
  const child = createFakeSidecar()
  child.requests = []
  child.respond = (request, payload) => {
    child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: request.id, ok: true, result: payload })}\n`))
  }
  child.fail = (request, code, message) => {
    child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: request.id, ok: false, error: { code, message } })}\n`))
  }
  child.stdin = {
    write: (line, callback) => {
      const request = JSON.parse(line)
      child.requests.push(request)
      if (request.action === 'status') {
        if (handlers.status) handlers.status(request, child)
        else child.respond(request, { running: true, dbLoaded: true, version: '1.5.0.1414' })
      } else if (request.action === 'wait-ready') {
        if (handlers['wait-ready']) handlers['wait-ready'](request, child)
        else child.respond(request, { ready: true, elapsedMs: 1, status: { running: true, dbLoaded: true } })
      } else if (request.action === 'query') {
        if (handlers.query) handlers.query(request, child)
        else child.respond(request, { total: 1, items: [{ name: request.search, fullPath: 'C:\\' + request.search }] })
      } else if (request.action === 'shutdown') {
        child.respond(request, { bye: true })
      }
      if (typeof callback === 'function') callback()
    }
  }
  return child
}

const tempSidecarDirs = []
function makeSidecarFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'highlighter-everything-sidecar-'))
  const file = path.join(dir, 'sidecar.exe')
  fs.writeFileSync(file, 'sidecar')
  tempSidecarDirs.push(dir)
  return file
}
test.after(() => {
  for (const dir of tempSidecarDirs) fs.rmSync(dir, { recursive: true, force: true })
})

function createService(options = {}, handlers = {}) {
  const child = options.child || createRespondingSidecar(handlers)
  const spawnCalls = []
  const sidecarPath = options.overrides?.sidecarPath || makeSidecarFile()
  const service = new EverythingService({
    sidecarPath,
    bundledEverythingPath: options.bundledEverythingPath || '',
    runtimeEverythingDir: options.runtimeEverythingDir || '',
    getUseBundledEverything: options.getUseBundledEverything || (() => true),
    idleTimeoutMs: 0,
    log: () => {},
    spawn: (file, args) => {
      spawnCalls.push({ file, args })
      if (file === sidecarPath) return child
      const everythingChild = createFakeSidecar()
      everythingChild.pid = 9999
      return everythingChild
    },
    processProbe: options.processProbe || (async () => ''),
    runCommand: options.runCommand || (async () => {}),
    onStatusChange: options.onStatusChange || null,
    ...options.overrides
  })
  service.spawnCalls = spawnCalls
  if (!options.skipStart) {
    setImmediate(() => child.stdout.emit('data', Buffer.from('{"type":"ready"}\n')))
  }
  return { service, child }
}

function deferred() {
  let resolve
  const promise = new Promise((onResolve) => { resolve = onResolve })
  return { promise, resolve }
}

// Poll a condition instead of racing a fixed delay. The query path awaits the
// readiness chain (status + wait-ready round trips) before it registers the shared
// request, and on a loaded CI runner that can outlast a handful of milliseconds:
// CI run 38244060488 (2026-10-12) still observed a query count of 0 after 10 ms,
// which made the merge assertion flake while the code was fine.
async function waitFor(check, message, attempts = 400) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (check()) return
    await delay(5)
  }
  throw new Error(message)
}

test('starts the sidecar once and shares the startup promise', async () => {
  const { service, child } = createService()
  let starts = 0
  const originalStart = service.start.bind(service)
  service.start = () => { starts += 1; return originalStart() }
  const first = service.ensureStarted()
  const second = service.ensureStarted()
  setImmediate(() => child.stdout.emit('data', Buffer.from('{"type":"ready"}\n')))
  await Promise.all([first, second])
  assert.equal(starts, 1)
  assert.equal(service.ready, true)
})

test('runs queries through the sidecar, normalizes parameters, and caches results', async () => {
  let queryCount = 0
  const { service, child } = createService({}, {
    query: (request, sidecar) => {
      queryCount += 1
      sidecar.respond(request, { total: 5, items: [{ name: request.search, fullPath: 'C:\\' + request.search }] })
    }
  })
  const first = await service.query({ search: 'report', maxResults: 9999, sortMode: 'weird', matchPath: 1 })
  assert.deepEqual(first.items, [{ name: 'report', fullPath: 'C:\\report' }])
  const request = child.requests.find((item) => item.action === 'query')
  assert.equal(request.maxResults, 2000, 'maxResults is clamped to 2000')
  assert.equal(request.sortMode, 'modified-desc', 'unknown sortMode falls back to default')
  assert.equal(request.matchPath, true)

  const second = await service.query({ search: 'report', maxResults: 9999, sortMode: 'weird', matchPath: 1 })
  assert.equal(second.cached, true)
  assert.equal(queryCount, 1)
})

test('merges concurrent identical queries into one sidecar request', async () => {
  let queryCount = 0
  const pending = deferred()
  const { service } = createService({}, {
    query: (request, sidecar) => {
      queryCount += 1
      pending.promise.then(() => sidecar.respond(request, { total: 0, items: [] }))
    }
  })
  const first = service.query({ search: 'slow' })
  const second = service.query({ search: 'slow' })
  await waitFor(() => queryCount === 1, 'the coalesced sidecar query was never issued')
  assert.equal(queryCount, 1, 'the two concurrent queries issue one sidecar request')
  pending.resolve()
  await Promise.all([first, second])
  assert.equal(queryCount, 1, 'the coalesced query must not issue a second request')
  assert.equal(service.inFlight.size, 0)
})

test('ensureReady reports ready immediately when Everything is running with a loaded index', async () => {
  const phases = []
  const { service } = createService({ onStatusChange: (status) => phases.push(status.phase) })
  const status = await service.ensureReady()
  assert.equal(status.phase, 'ready')
  assert.equal(status.running, true)
  assert.equal(status.version, '1.5.0.1414')
  assert.equal(phases[0], 'checking')
  assert.equal(phases[phases.length - 1], 'ready')
})

test('ensureReady waits for the index through wait-ready', async () => {
  const { service } = createService({}, {
    status: (request, child) => child.respond(request, { running: true, dbLoaded: false }),
    'wait-ready': (request, child) => {
      assert.equal(request.timeoutMs, 30000)
      child.respond(request, { ready: true, elapsedMs: 12, status: { running: true, dbLoaded: true, version: '1.4.1' } })
    }
  })
  const status = await service.ensureReady()
  assert.equal(status.phase, 'ready')
  assert.equal(status.version, '1.4.1')
  assert.equal(service.status.dbLoaded, true)
})

test('ensureReady times out with a hint when the index never loads', async () => {
  const { service } = createService({}, {
    status: (request, child) => child.respond(request, { running: true, dbLoaded: false }),
    'wait-ready': (request, child) => child.respond(request, { ready: false, elapsedMs: 30000, status: { running: true, dbLoaded: false } })
  })
  await assert.rejects(service.ensureReady(), /初始化超时，索引尚未就绪/)
  assert.equal(service.status.phase, 'error')
  assert.equal(service.status.messageKey, 'main.everything.timeout-index')
})

test('ensureReady spawns the bundled Everything only when allowed and present', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'highlighter-everything-bundle-'))
  const bundleDir = path.join(root, 'bundle')
  const runtimeDir = path.join(root, 'runtime')
  await fsp.mkdir(bundleDir)
  const bundledExe = path.join(bundleDir, 'Everything.exe')
  const bundledIni = path.join(bundleDir, 'Everything.ini')
  await fsp.writeFile(bundledExe, 'fake-exe')
  await fsp.writeFile(bundledIni, 'ipc=1\n')
  const { service } = createService({
    bundledEverythingPath: bundledExe,
    runtimeEverythingDir: runtimeDir
  }, {
    status: (request, child) => child.respond(request, { running: false, dbLoaded: false }),
    'wait-ready': (request, child) => child.respond(request, { ready: true, elapsedMs: 5, status: { running: true, dbLoaded: true, version: '1.4.1' } })
  })
  const status = await service.ensureReady()
  assert.equal(status.phase, 'ready')
  const spawnCall = service.spawnCalls.find((item) => item.args.length > 0)
  assert.ok(spawnCall, 'bundled Everything spawned')
  assert.deepEqual(spawnCall.args, ['-startup', '-config', path.join(runtimeDir, 'Everything.ini')])
  assert.equal(await fsp.readFile(path.join(runtimeDir, 'Everything.exe'), 'utf8'), 'fake-exe', 'exe copied into runtime dir')
  assert.equal(service.managedEverything.pid, 9999)
  assert.equal(service.status.managedByHighlighter, true)
})

test('ensureReady fails with guidance when bundled fallback is disabled', async () => {
  const { service } = createService({
    getUseBundledEverything: () => false
  }, {
    status: (request, child) => child.respond(request, { running: false, dbLoaded: false })
  })
  await assert.rejects(service.ensureReady(), /未检测到 Everything/)
  assert.equal(service.status.phase, 'error')
  assert.equal(service.status.messageKey, 'main.everything.not-installed')
  assert.ok(service.status.downloadUrl)
})

test('ensureReady fails when bundled Everything files are missing', async () => {
  const { service } = createService({
    bundledEverythingPath: path.join(os.tmpdir(), 'missing-everything.exe')
  }, {
    status: (request, child) => child.respond(request, { running: false, dbLoaded: false })
  })
  await assert.rejects(service.ensureReady(), /内置 Everything 不存在/)
})

test('caches readiness briefly and re-checks after a query reports not-running', async () => {
  let statusCount = 0
  let queryFailures = 0
  const { service } = createService({}, {
    status: (request, child) => {
      statusCount += 1
      child.respond(request, { running: true, dbLoaded: true, version: '1.5' })
    },
    query: (request, child) => {
      queryFailures += 1
      child.fail(request, 'not-running', 'IPC window not found')
    }
  })
  await service.ensureReady()
  assert.equal(statusCount, 1)
  await assert.rejects(service.query({ search: 'x' }), /IPC window not found/)
  assert.equal(service.lastReadyAt, 0, 'readiness cache is invalidated')
  await service.ensureReady()
  assert.equal(statusCount, 2, 'next ensureReady re-runs the status check')
})

test('stopManagedEverything only kills the process when the image path matches', async () => {
  const commands = []
  const mkService = (probeResult) => {
    const { service } = createService({
      processProbe: async () => probeResult,
      runCommand: async (file, args) => { commands.push([file, args]) }
    })
    service.managedEverything = { pid: 4321, exePath: 'C:\\tools\\Everything.exe' }
    return service
  }

  assert.equal(await mkService('c:\\tools\\everything.exe').stopManagedEverything(), true)
  assert.deepEqual(commands, [['taskkill', ['/PID', '4321', '/T', '/F']]])

  commands.length = 0
  assert.equal(await mkService('C:\\other\\Everything.exe').stopManagedEverything(), false)
  assert.deepEqual(commands, [])

  commands.length = 0
  assert.equal(await mkService('').stopManagedEverything(), false)
  assert.deepEqual(commands, [])
})

test('stop() shuts the sidecar down, rejects pending requests, and stops managed Everything', async () => {
  const writes = []
  let killed = false
  const killManaged = deferred()
  const { service, child } = createService({
    overrides: {
      runCommand: async () => { killed = true; killManaged.resolve() }
    }
  })
  child.stdin.write = (line, callback) => {
    const request = JSON.parse(line)
    writes.push(request)
    if (request.action === 'status') child.respond(request, { running: true, dbLoaded: true })
    if (typeof callback === 'function') callback()
  }

  const never = service.query({ search: 'never-answered' })
  await delay(30)
  assert.ok(writes.some((request) => request.action === 'query'), 'query request was written')

  service.managedEverything = { pid: 4242, exePath: 'C:\\tools\\Everything.exe' }
  service.processProbe = async () => 'C:\\tools\\Everything.exe'
  service.stop()
  await assert.rejects(never, /组件已停止/)
  await killManaged.promise
  assert.equal(killed, true)
  assert.equal(service.managedEverything, null)
  assert.equal(service.status.phase, 'idle')
  assert.equal(service.status.messageKey, '', 'stop() clears the retained UI-copy key with the message')
  assert.ok(writes.some((request) => request.action === 'shutdown'))
})

test('schedules idle stop when the request queue drains', async () => {
  const { service } = createService()
  let stopCount = 0
  service.stop = () => { stopCount += 1 }
  service.idleTimeoutMs = 10
  service.scheduleIdleStop()
  await delay(30)
  assert.equal(stopCount, 1)
})

test('a stale sidecar exit cannot clear a replacement process', () => {
  const { service } = createService({ skipStart: true })
  const replacement = createFakeSidecar()
  service.process = replacement
  service.ready = true
  service.handleExit(createFakeSidecar(), new Error('old exited'))
  assert.equal(service.process, replacement)
  assert.equal(service.ready, true)
  service.handleExit(replacement, new Error('replacement exited'))
  assert.equal(service.process, null)
  assert.equal(service.ready, false)
})

test('status snapshots report sidecar availability from the filesystem', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'highlighter-everything-status-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const sidecarPath = path.join(root, 'HighlighterEverything.exe')
  const { service } = createService({ overrides: { sidecarPath } })
  assert.equal(service.getStatus().available, false)
  await fsp.writeFile(sidecarPath, 'sidecar')
  assert.equal(service.getStatus().available, true)
})

test('refreshStatus probes the sidecar and surfaces a running Everything', async () => {
  const { service, child } = createService({}, {
    status: (request, child) => child.respond(request, { running: true, dbLoaded: true, version: '1.4.1.1032', ipcAvailable: true })
  })
  const status = await service.refreshStatus()
  assert.equal(status.running, true)
  assert.equal(status.version, '1.4.1.1032')
  assert.equal(status.phase, 'ready')
  assert.ok(child.requests.some((item) => item.action === 'status'))
})

test('refreshStatus marks waiting when Everything runs without a loaded index', async () => {
  const { service } = createService({}, {
    status: (request, child) => child.respond(request, { running: true, dbLoaded: false, ipcAvailable: true, version: '1.4' })
  })
  const status = await service.refreshStatus()
  assert.equal(status.running, true)
  assert.equal(status.phase, 'waiting')
  assert.equal(status.messageKey, 'main.everything.index-pending')
  assert.equal(status.message, t('main.everything.index-pending'))
})

test('refreshStatus reuses the recent probe while the sidecar stays active', async () => {
  let statusCount = 0
  const { service } = createService({}, {
    status: (request, child) => {
      statusCount += 1
      child.respond(request, { running: true, dbLoaded: true, version: '1.4' })
    }
  })
  await service.refreshStatus()
  const second = await service.refreshStatus()
  assert.equal(second.running, true)
  assert.equal(statusCount, 1, 'no duplicate status request while active')
})

test('refreshStatus honors the throttle after the sidecar idles away', async () => {
  let statusCount = 0
  const { service } = createService({}, {
    status: (request, child) => {
      statusCount += 1
      child.respond(request, { running: true, dbLoaded: true })
    }
  })
  await service.refreshStatus()
  service.stop()
  const cached = await service.refreshStatus()
  assert.equal(cached.running, false)
  assert.equal(statusCount, 1, 'throttled within the min interval')
})

test('refreshStatus degrades to the cached status when the sidecar errors', async () => {
  const { service } = createService({}, {
    status: (request, child) => child.fail(request, 'send-failed', 'probe blocked')
  })
  const status = await service.refreshStatus()
  assert.equal(status.running, false)
  assert.equal(status.phase, 'idle')
})

test('refreshStatus never spawns the bundled Everything even when nothing is running', async () => {
  const { service } = createService({
    bundledEverythingPath: path.join(os.tmpdir(), 'missing-everything.exe')
  }, {
    status: (request, child) => child.respond(request, { running: false, dbLoaded: false })
  })
  const status = await service.refreshStatus()
  assert.equal(status.running, false)
  assert.equal(status.phase, 'idle')
  assert.ok(service.spawnCalls.every((call) => call.args.length === 0), 'bundled Everything not spawned')
})

test('ensureReady fails fast when an instance is detected but unreachable', async () => {
  const { service } = createService({
    bundledEverythingPath: path.join(os.tmpdir(), 'missing-everything.exe')
  }, {
    status: (request, child) => child.respond(request, { running: true, dbLoaded: false, ipcAvailable: false })
  })
  await assert.rejects(service.ensureReady(), /无法与之通信/)
  assert.equal(service.status.phase, 'error')
  assert.equal(service.status.messageKey, 'main.everything.ipc-mismatch')
  assert.ok(service.spawnCalls.every((call) => call.args.length === 0), 'bundled Everything not spawned')
})

test('ensureReady still reaches ready when ipcAvailable is false but the probe query answers', async () => {
  const { service } = createService({}, {
    status: (request, child) => child.respond(request, { running: true, dbLoaded: true, ipcAvailable: false, version: '1.5.0.1414' })
  })
  const status = await service.ensureReady()
  assert.equal(status.phase, 'ready')
  assert.equal(status.version, '1.5.0.1414')
})

test('e2eQuery short-circuits the sidecar for query, status, and readiness', async () => {
  const calls = []
  const { service } = createService({
    overrides: {
      e2eQuery: (params) => {
        calls.push(params)
        return { total: 1, items: [{ name: params.search, fullPath: `C:${params.search}` }] }
      }
    }
  })

  const result = await service.query({ search: 'package.json', maxResults: 600 })
  assert.deepEqual(result.items, [{ name: 'package.json', fullPath: 'C:package.json' }])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].search, 'package.json')
  assert.equal(calls[0].maxResults, 600)
  assert.equal(calls[0].sortMode, 'modified-desc')

  const status = await service.refreshStatus()
  assert.equal(status.phase, 'ready')
  assert.equal(status.running, true)
  assert.equal(status.dbLoaded, true)
  assert.equal(status.messageKey, 'main.everything.ready')

  const ready = await service.ensureReady()
  assert.equal(ready.phase, 'ready')

  assert.deepEqual(service.spawnCalls, [], 'the fake path never spawns a sidecar')
})

// --- language hot-switch (P0-1-T7) ------------------------------------------
//
// The search window keeps the last status payload and re-resolves `messageKey`
// after a language switch, because `message` was frozen in the language that was
// active when the status was published. That only works if the service really
// publishes the key next to the sentence, on every path.

test('every published status pairs its message with the key it was resolved from', async () => {
  const published = []
  const run = async (options, handlers) => {
    const { service } = createService({ onStatusChange: (status) => published.push(status), ...options }, handlers)
    await service.ensureReady().catch((error) => error)
    service.stop()
  }

  // ready
  await run({}, {
    status: (request, child) => child.respond(request, { running: true, dbLoaded: true, version: '1.5' })
  })
  // waiting for the index, then ready
  await run({}, {
    status: (request, child) => child.respond(request, { running: true, dbLoaded: false }),
    'wait-ready': (request, child) => child.respond(request, { ready: true, elapsedMs: 1, status: { running: true, dbLoaded: true } })
  })
  // bundled fallback disabled -> not installed
  await run({ getUseBundledEverything: () => false }, {
    status: (request, child) => child.respond(request, { running: false, dbLoaded: false })
  })
  // the status probe never answers -> unavailable
  await run({}, {
    status: (request, child) => child.fail(request, 'send-failed', 'probe blocked')
  })

  assert.ok(published.length >= 6, `expected the status stream to be observable, saw ${published.length}`)
  for (const status of published) {
    if (!status.message) {
      assert.equal(status.messageKey, '', `phase ${status.phase} published no copy but kept a key`)
      continue
    }
    assert.equal(typeof status.messageKey, 'string', `phase ${status.phase} lost its message key`)
    assert.ok(status.messageKey, `phase ${status.phase} published copy without a key`)
    assert.equal(status.message, t(status.messageKey), `phase ${status.phase} message/key mismatch`)
  }
  const keys = new Set(published.map((status) => status.messageKey))
  for (const key of [
    'main.everything.checking',
    'main.everything.ready',
    'main.everything.waiting',
    'main.everything.not-installed',
    'main.everything.unavailable'
  ]) {
    assert.ok(keys.has(key), `no status was published with messageKey ${key}`)
  }
})

test('ensureReady reports the unavailable key when the status probe fails', async () => {
  const { service } = createService({}, {
    status: (request, child) => child.fail(request, 'send-failed', 'probe blocked')
  })
  await assert.rejects(service.ensureReady(), /组件不可用/)
  assert.equal(service.status.phase, 'error')
  assert.equal(service.status.messageKey, 'main.everything.unavailable')
  assert.equal(service.status.message, t('main.everything.unavailable'))
})

test('the service names a key for every copy status it can publish', () => {
  // Source-level companion to the runtime invariant above: the paths this test
  // does not drive (bundled-start timeout, re-check after a dropped sidecar) must
  // still declare their key, otherwise the search window would fall back to the
  // stale sentence of the main-process language.
  const source = fs.readFileSync(path.join(__dirname, '..', 'main', 'services', 'everything-service.js'), 'utf8')
  const declared = new Set()
  for (const match of source.matchAll(/messageKey:[^\n]*/g)) {
    for (const quoted of match[0].matchAll(/'([^']+)'/g)) declared.add(quoted[1])
  }
  for (const key of [
    'main.everything.checking',
    'main.everything.rechecking',
    'main.everything.unavailable',
    'main.everything.ipc-mismatch',
    'main.everything.ready',
    'main.everything.waiting',
    'main.everything.starting',
    'main.everything.not-installed',
    'main.everything.index-pending',
    'main.everything.timeout-index',
    'main.everything.timeout-start'
  ]) {
    assert.ok(declared.has(key), `no status publishes messageKey ${key}`)
  }
  // `message` has to stay populated for the consumers that read the sentence.
  for (const key of declared) {
    assert.match(source, new RegExp(`t\\('${key.replace(/\./g, '\\.')}'\\)`), `message is not rendered from ${key}`)
  }
})
