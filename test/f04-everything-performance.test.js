'use strict'

// F04 §三.4 (P1): Everything local search performance.
//
// Reported bottlenecks (reproduced against the current tree):
//   1. Rust: every `query` request ran `resolve_target(&reply)` first — an
//      `EnumWindows` sweep of every top-level window plus five synchronous
//      `SendMessageTimeoutW` probes and one `*.exe` WM_COPYDATA probe per
//      candidate. Typing one character in path-match mode costs two of those.
//   2. JS: the 120 s idle reclaim called `stop()`, which also killed the managed
//      `Everything.exe`; the next search then cold-started the index.
//   3. JS: `probeProcessImagePath` cold-started PowerShell + `Get-CimInstance`
//      Win32_Process (1–3.5 s) to verify the managed pid before killing it.
//
// Rust behaviour cannot be driven from node without a live Everything IPC window
// and a Win32 message pump, so this file combines (a) source-level assertions
// pinned to the F04 implementation and the matching `cargo test` unit tests, with
// (b) behavioural tests of the JS service against an injected fake sidecar.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { setTimeout: delay } = require('node:timers/promises')

const { EverythingService } = require('../main/services/everything-service')

const ROOT = path.join(__dirname, '..')
const RUST_SOURCE = path.join(ROOT, 'native', 'everything-search', 'src', 'main.rs')
const SERVICE_SOURCE = path.join(ROOT, 'main', 'services', 'everything-service.js')

function readSource(file) {
  return fs.readFileSync(file, 'utf8')
}

function rustSource() {
  return readSource(RUST_SOURCE)
}

const tempDirs = []
function makeSidecarFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'highlighter-f04-sidecar-'))
  const file = path.join(dir, 'HighlighterEverything.exe')
  fs.writeFileSync(file, 'sidecar')
  tempDirs.push(dir)
  return file
}
test.after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

// --- fake sidecar -----------------------------------------------------------

function createFakeSidecar(pid = 4242) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stderr.setEncoding = () => {}
  child.pid = pid
  child.killed = false
  child.kill = () => { child.killed = true }
  child.unref = () => {}
  child.exitCount = 0
  child.requests = []
  child.respond = (request, payload) => {
    child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: request.id, ok: true, result: payload })}\n`))
  }
  child.fail = (request, code, message) => {
    child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: request.id, ok: false, error: { code, message } })}\n`))
  }
  return child
}

const DEFAULT_IDLE_TIMEOUT_MS = 120000

// Default fake sidecar protocol. Handlers may be replaced per test; anything a
// handler does not answer keeps the request pending (useful to prove a query is
// still in flight).
function createProtocol(handlers = {}) {
  return (request, child) => {
    switch (request.action) {
      case 'status':
        if (handlers.status) handlers.status(request, child)
        else child.respond(request, { running: true, dbLoaded: true, version: '1.5.0.1414', ipcAvailable: true, probeTotal: 10 })
        break
      case 'wait-ready':
        if (handlers['wait-ready']) handlers['wait-ready'](request, child)
        else child.respond(request, { ready: true, elapsedMs: 1, status: { running: true, dbLoaded: true } })
        break
      case 'query':
        if (handlers.query) handlers.query(request, child)
        else child.respond(request, { total: 1, items: [{ name: request.search, fullPath: `C:\\${request.search}` }] })
        break
      case 'process-path':
        if (handlers['process-path']) handlers['process-path'](request, child)
        else child.respond(request, { path: 'C:\\tools\\Everything.exe' })
        break
      case 'shutdown':
        child.respond(request, { bye: true })
        break
      default:
        break
    }
  }
}

function wireSidecar(child, protocol) {
  child.stdin = {
    write: (line, callback) => {
      const request = JSON.parse(line)
      child.requests.push(request)
      protocol(request, child)
      if (typeof callback === 'function') callback()
    }
  }
  setImmediate(() => child.stdout.emit('data', Buffer.from('{"type":"ready"}\n')))
}

// Creates a service whose spawn returns a fresh fake sidecar per sidecar start,
// so tests can count starts and read back every request the service issued.
function createHarness(options = {}) {
  const sidecarPath = makeSidecarFile()
  const spawnCalls = []
  const children = []
  const protocol = createProtocol(options.handlers)
  const service = new EverythingService({
    sidecarPath,
    bundledEverythingPath: options.bundledEverythingPath || '',
    runtimeEverythingDir: options.runtimeEverythingDir || '',
    getUseBundledEverything: options.getUseBundledEverything || (() => true),
    log: options.log || (() => {}),
    idleTimeoutMs: options.idleTimeoutMs === undefined ? DEFAULT_IDLE_TIMEOUT_MS : options.idleTimeoutMs,
    spawn: (file, args) => {
      spawnCalls.push({ file, args })
      if (file === sidecarPath) {
        const child = createFakeSidecar()
        children.push(child)
        wireSidecar(child, protocol)
        return child
      }
      const managed = createFakeSidecar(9999)
      return managed
    },
    ...options.overrides
  })
  return { service, spawnCalls, children, sidecarPath }
}

async function waitFor(check, message, attempts = 400) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (check()) return
    await delay(5)
  }
  throw new Error(message)
}

// --- 1. Rust: cached target replaces the per-query desktop probe -------------

test('F04/DEV-07 Rust shares one live Everything target across status, wait-ready and query', () => {
  const source = rustSource()
  const mainLoop = source.slice(source.indexOf('let mut target_cache = TargetCache::new();'))
  assert.ok(mainLoop.length > 0, 'main loop must own the shared target cache')

  assert.match(mainLoop, /status_value\(&reply, &mut target_cache\)/, 'status goes through the shared cache')
  assert.match(mainLoop, /wait_ready\(&reply, &mut target_cache, &request\)/, 'wait-ready goes through the shared cache')
  assert.match(mainLoop, /query_with_cache\(&reply, &mut target_cache, &request\)/, 'query goes through the shared cache')

  const queryArmStart = source.indexOf('"query" => {')
  const processPathArm = source.indexOf('"process-path" => {')
  assert.ok(queryArmStart > 0 && processPathArm > queryArmStart, 'query/process-path dispatch arms exist')
  const queryArm = source.slice(queryArmStart, processPathArm)
  assert.doesNotMatch(queryArm, /resolve_target\(/, 'the query request itself must not enumerate the desktop anymore')

  const cacheImpl = source.slice(source.indexOf('struct TargetCache {'), source.indexOf('fn query_with_cache('))
  assert.match(cacheImpl, /fn run<T>/, 'one cache runner serves every consumer')
  assert.match(cacheImpl, /if is_live\(target\)/, 'the cached identity is only reused while live')
  assert.match(cacheImpl, /is_communication_failure\(&error\)/, 'only a communication failure invalidates the identity')
  assert.match(cacheImpl, /self\.target = None;/, 'a dead handle / failed attempt clears the cache')
  assert.match(cacheImpl, /let mut target = match resolve\(\)/, 'a missing cache falls back to the original resolve_target flow')

  const identity = source.slice(source.indexOf('fn is_cached_target_live('), source.indexOf('struct TargetCache {'))
  assert.match(identity, /is_window_live\(target\.hwnd\)/, 'cache validity is checked with IsWindow')
  assert.match(identity, /read_window_class_name/, 'a reused numeric HWND is rejected by the class check')

  const refresh = source.slice(source.indexOf('fn refresh_status('), source.indexOf('fn status_value('))
  assert.match(refresh, /send_ipc_command\(target\.hwnd, IPC_IS_DB_LOADED\)/, 'dbLoaded is re-read on every status call')
  assert.match(refresh, /probe_window\(reply, target\.hwnd\)/, 'the query probe is re-read on every status call')
  assert.match(source, /fn poll_until_ready\(/, 'wait-ready polling is separable from the Win32 plumbing')

  // P2-07: a silent instance is a communication failure with a display snapshot, and
  // re-selection is bounded so a 300 ms wait-ready poll cannot sweep the desktop every
  // call. The status surface keeps the stale snapshot through `status_from_cache`.
  assert.match(source, /fn apply_probe_result\(/, 'the probe decision is the unit-testable seam')
  assert.match(refresh, /apply_probe_result\(target, db_loaded, probe_window\(reply, target\.hwnd\)\)/)
  assert.match(source, /"status": status_snapshot\(target\)/, 'the silent snapshot rides the failure')
  assert.match(source, /fn status_from_cache\(/, 'status reports the stale running snapshot while re-selecting')
  assert.match(source, /SILENT_RESELECTION_SKIP_MAX/, 're-selection is bounded')
  assert.match(cacheImpl, /last_communication_error/, 'the throttle returns the last status error')
})

test('F04/DEV-07 Rust unit tests cover cache reuse, invalidation, polling and safe degradation', () => {
  const source = rustSource()
  for (const name of [
    'f04_query_reuses_live_cached_target_without_resolving',
    'f04_query_reresolves_when_cached_window_is_gone',
    'f04_query_reresolves_once_after_communication_failure',
    'f04_query_keeps_cache_after_non_communication_error',
    'f04_query_reports_not_running_when_resolve_finds_nothing',
    'f04_window_liveness_accepts_real_windows_and_rejects_stale_handles',
    'f04_process_path_resolves_the_current_process',
    'f04_process_path_rejects_unresolvable_pids',
    'dev07_wait_ready_polling_resolves_the_target_once',
    'dev07_cached_identity_is_invalidated_when_the_window_is_gone_or_reused',
    'dev07_status_snapshot_reports_volatile_fields_from_the_refreshed_target',
    // P2-07: silent-instance status/re-selection regressions.
    'p2_07_a_silent_probe_is_a_communication_failure_with_its_status_snapshot',
    'p2_07_a_silent_cached_target_switches_to_a_responsive_instance',
    'p2_07_silent_only_status_stays_running_and_bounds_resolution',
    'p2_07_wait_ready_recovers_when_a_new_instance_answers'
  ]) {
    assert.match(source, new RegExp(`fn ${name}\\(\\)`), `${name} must exist (cargo test runs it)`)
  }
})

test('F04 the second query rides one sidecar and does not re-run readiness probes', async () => {
  let queryCount = 0
  let statusCount = 0
  let waitReadyCount = 0
  const { service, spawnCalls, children } = createHarness({
    handlers: {
      status: (request, child) => {
        statusCount += 1
        child.respond(request, { running: true, dbLoaded: true, version: '1.5.0.1414' })
      },
      'wait-ready': (request, child) => {
        waitReadyCount += 1
        child.respond(request, { ready: true, elapsedMs: 1, status: { running: true, dbLoaded: true } })
      },
      query: (request, child) => {
        queryCount += 1
        child.respond(request, { total: 1, items: [{ name: request.search, fullPath: `C:\\${request.search}` }] })
      }
    }
  })
  const first = await service.query({ search: 'report', matchPath: true })
  const second = await service.query({ search: 'report2', matchPath: true })
  assert.equal(first.items[0].name, 'report')
  assert.equal(second.items[0].name, 'report2')
  assert.equal(spawnCalls.length, 1, 'the sidecar process is shared across queries')
  assert.equal(statusCount, 1, 'readiness is not re-probed for every keystroke')
  assert.equal(waitReadyCount, 0, 'wait-ready is not part of the per-query path')
  assert.equal(queryCount, 2)
  assert.deepEqual(
    children[0].requests.filter((request) => request.action === 'query').map((request) => request.search),
    ['report', 'report2']
  )
  // Only the first query pays for resolving the target; the Rust cache keeps the
  // HWND for the second one (asserted source-level above).
  assert.doesNotMatch(JSON.stringify(children[0].requests), /"resolve-target"|"probe-all"/)
})

// --- 2. JS: idle reclaim keeps the managed Everything index -----------------

test('F04 the 120 s idle reclaim stops only the sidecar and keeps the managed Everything process', async () => {
  const runCommands = []
  const { service, spawnCalls, children } = createHarness({
    overrides: { runCommand: async (file, args) => { runCommands.push([file, args]) } }
  })
  assert.equal(service.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS, 'the production idle budget stays 120 s')
  await service.ensureReady()
  service.managedEverything = { pid: 9999, exePath: 'C:\\runtime\\Everything.exe' }
  service.idleTimeoutMs = 20
  service.scheduleIdleStop()
  await waitFor(() => children[0].requests.some((request) => request.action === 'shutdown'), 'idle reclaim never shut the sidecar down')

  assert.equal(spawnCalls.length, 1)
  assert.ok(children[0].requests.some((request) => request.action === 'shutdown'), 'only the sidecar is asked to stop')
  assert.notEqual(service.managedEverything, null, 'the managed Everything.exe survives an idle reclaim')
  assert.deepEqual(runCommands, [], 'no taskkill on idle reclaim')
  assert.equal(service.status.phase, 'idle')
  assert.equal(service.status.managedByHighlighter, true, 'ownership of the surviving index process is reported')
  assert.equal(service.ready, false)

  // The next search starts a fresh sidecar and finds the retained index process
  // already running, so it does not spawn a second Everything.exe.
  await service.ensureReady()
  assert.equal(spawnCalls.length, 2, 'the sidecar restarts on demand')
  assert.equal(spawnCalls.filter((call) => call.args.length > 0).length, 0, 'no bundled Everything cold start after idle')
  assert.equal(service.status.phase, 'ready')
  service.stopSidecar()
})

test('F04 scheduleIdleStop routes through stopSidecar rather than the full dispose', () => {
  const source = readSource(SERVICE_SOURCE)
  const schedule = source.slice(source.indexOf('scheduleIdleStop() {'), source.indexOf('async ensureStarted()'))
  assert.match(schedule, /this\.stopSidecar\(\)/, 'the idle timer calls stopSidecar()')
  assert.doesNotMatch(schedule, /this\.stop\(\)/, 'the idle timer no longer calls the full stop()')

  const sidecarStop = source.slice(source.indexOf('stopSidecar() {'), source.indexOf('stop(options = {}) {'))
  assert.match(sidecarStop, /this\.stop\(\{ sidecarOnly: true \}\)/, 'stopSidecar is the sidecar-only mode')
  const dispose = source.slice(source.indexOf('async dispose() {'), source.indexOf('async probeProcessImagePath(pid) {'))
  assert.match(dispose, /stopManagedEverything\(\)/, 'dispose tears the managed Everything process down')
  assert.match(dispose, /shutdownSidecar\(\)/, 'dispose also tears the sidecar down')
})

// --- 3. JS: dispose is the only full teardown --------------------------------

test('F04 dispose tears down both the sidecar and the managed Everything process', async () => {
  const runCommands = []
  const { service, spawnCalls, children } = createHarness({
    handlers: {
      'process-path': (request, child) => {
        assert.equal(request.pid, 4321)
        child.respond(request, { path: 'c:\\tools\\everything.exe' })
      }
    },
    overrides: { runCommand: async (file, args) => { runCommands.push([file, args]) } }
  })
  await service.ensureReady()
  service.managedEverything = { pid: 4321, exePath: 'C:\\tools\\Everything.exe' }

  const stopped = await service.dispose()
  assert.equal(stopped, true)
  assert.deepEqual(runCommands, [['taskkill', ['/PID', '4321', '/T', '/F']]], 'dispose kills the verified managed process')
  assert.equal(service.managedEverything, null)
  assert.equal(service.status.phase, 'idle')
  assert.equal(service.status.managedByHighlighter, false)
  assert.equal(spawnCalls.length, 1)
  assert.ok(children[0].requests.some((request) => request.action === 'shutdown'), 'dispose stops the sidecar too')
  assert.equal(service.pending.size, 0)
})

test('F04 dispose refuses to kill a process whose image path cannot be verified', async () => {
  const runCommands = []
  const { service } = createHarness({
    handlers: {
      'process-path': (request, child) => child.fail(request, 'process-open-failed', 'cannot open pid')
    },
    overrides: { runCommand: async (file, args) => { runCommands.push([file, args]) } }
  })
  await service.ensureReady()
  service.managedEverything = { pid: 4321, exePath: 'C:\\tools\\Everything.exe' }
  const stopped = await service.dispose()
  assert.equal(stopped, false)
  assert.deepEqual(runCommands, [], 'an unverifiable pid is never taskkilled')
})

test('F04 dispose refuses a mismatched image path instead of killing a reused pid', async () => {
  const runCommands = []
  const { service } = createHarness({
    handlers: {
      'process-path': (request, child) => child.respond(request, { path: 'C:\\unrelated\\Everything.exe' })
    },
    overrides: { runCommand: async (file, args) => { runCommands.push([file, args]) } }
  })
  await service.ensureReady()
  service.managedEverything = { pid: 4321, exePath: 'C:\\tools\\Everything.exe' }
  assert.equal(await service.dispose(), false)
  assert.deepEqual(runCommands, [])
})

test('F04 dispose after an idle reclaim restarts the sidecar once to verify the retained pid', async () => {
  const runCommands = []
  const { service, spawnCalls } = createHarness({
    handlers: {
      'process-path': (request, child) => child.respond(request, { path: 'C:\\runtime\\Everything.exe' })
    },
    overrides: { runCommand: async (file, args) => { runCommands.push([file, args]) } }
  })
  await service.ensureReady()
  service.managedEverything = { pid: 9999, exePath: 'C:\\runtime\\Everything.exe' }
  service.idleTimeoutMs = 10
  service.scheduleIdleStop()
  await waitFor(() => service.process === null && service.ready === false, 'idle reclaim never stopped the sidecar')
  assert.equal(spawnCalls.length, 1)
  assert.notEqual(service.managedEverything, null, 'the idle reclaim kept the managed process')

  assert.equal(await service.dispose(), true)
  assert.deepEqual(runCommands, [['taskkill', ['/PID', '9999', '/T', '/F']]], 'quit still reaps the retained process')
  assert.equal(spawnCalls.length, 2, 'dispose briefly restarts the sidecar to verify the pid')
  assert.equal(service.managedEverything, null)
})

// --- 4. JS: PowerShell/WMI probe is gone; the sidecar resolves the path -----

test('F04 process image paths come from the sidecar, not a PowerShell WMI cold start', () => {
  const serviceSource = readSource(SERVICE_SOURCE)
  assert.doesNotMatch(serviceSource, /Get-CimInstance/i, 'the WMI query is removed')
  assert.doesNotMatch(serviceSource, /powershell\.exe/i, 'no PowerShell cold start remains')
  assert.match(serviceSource, /async probeProcessImagePath\(pid\)/, 'the service asks the sidecar for the image path')
  assert.match(serviceSource, /action: 'process-path', pid: processId/, 'the new sidecar action is wired')

  const source = rustSource()
  assert.match(source, /QueryFullProcessImageNameW/, 'Rust uses the Win32 API')
  assert.match(source, /fn query_process_image_path\(pid: u32\)/, 'the Rust resolver is a plain function')
  assert.match(source, /"process-path" => \{/, 'the sidecar exposes the process-path action')
})

test('F04 the default process probe resolves through the sidecar process-path action', async () => {
  const probed = []
  const { service } = createHarness({
    handlers: {
      'process-path': (request, child) => {
        probed.push(request.pid)
        child.respond(request, { path: 'C:\\runtime\\Everything.exe' })
      }
    }
  })
  await service.ensureReady()
  assert.equal(await service.probeProcessImagePath(4321), 'C:\\runtime\\Everything.exe')
  assert.deepEqual(probed, [4321])
  assert.equal(await service.probeProcessImagePath(0), '', 'an invalid pid never reaches the sidecar')
  assert.equal(await service.probeProcessImagePath(Number.NaN), '')
})

// --- 5. getStatus / query error semantics must not regress -------------------

test('F04 getStatus and query failure semantics are unchanged after the split', async () => {
  const { service, children } = createHarness({
    handlers: {
      status: (request, child) => child.respond(request, { running: true, dbLoaded: true, version: '1.5.0.1414' }),
      query: (request, child) => child.fail(request, 'not-running', 'IPC window not found')
    }
  })
  await service.ensureReady()
  const ready = service.getStatus()
  assert.equal(ready.phase, 'ready')
  assert.equal(ready.running, true)
  assert.equal(ready.messageKey, 'main.everything.ready')
  assert.equal(ready.available, true)

  await assert.rejects(
    service.query({ search: 'x' }),
    (error) => error.code === 'not-running' && /IPC window not found/.test(error.message)
  )
  assert.equal(service.lastReadyAt, 0, 'a dead IPC target still invalidates the readiness cache')
  assert.equal(service.status.phase, 'checking')
  assert.equal(service.status.messageKey, 'main.everything.rechecking')

  service.stopSidecar()
  const idle = service.getStatus()
  assert.equal(idle.phase, 'idle')
  assert.equal(idle.running, false)
  assert.equal(idle.messageKey, '', 'the retained UI-copy key is cleared with the message')
  assert.ok(children[0].requests.some((request) => request.action === 'shutdown'))
})
