'use strict'

// Unit tests for the Index-Translate proxy bridge lifecycle.
//
// Everything the service touches (spawn, execFile, the loopback probe, the clock)
// is injected, so no test here starts python or binds a port. The probe is the
// service's source of truth, which is why most cases are expressed as "what does
// the port answer" rather than "which function was called". The fake port is
// modelled by the harness: it comes up when a child spawns, goes down when the
// tree is killed, and can be pinned up to exercise the failure paths.

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

const {
  createTranslationProxyService,
  ERROR_CODES,
  DEFAULT_PORT
} = require('../main/services/translation-proxy-service')

// This test file is an absolute path to an existing regular file, which is all
// assertScriptExists() asks for.
const SCRIPT_PATH = __filename

const NOT_LISTENING = { answering: false, isProxy: false }
const PROXY_READY = { answering: true, isProxy: true }
const OTHER_SERVER = { answering: true, isProxy: false }

function createFakeChild({ pid = 4242 } = {}) {
  const child = new EventEmitter()
  child.pid = pid
  child.killed = false
  child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} })
  child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} })
  child.kill = () => {
    child.killed = true
    return true
  }
  return child
}

function createService(overrides = {}) {
  const calls = { attempts: [], spawn: [], exec: [], execSync: [], signals: [], states: [] }
  const children = []
  let nowMs = 1000
  // The fake port. `listening` starts as configured, comes up when a child really
  // spawns, and goes down when the tree is killed - unless the test pins it up.
  let listening = overrides.listening === true
  let spawned = false
  let otherServer = overrides.otherServer === true

  const autoProbe = async () => {
    if (!listening || (overrides.neverReady === true && spawned)) return NOT_LISTENING
    return otherServer ? OTHER_SERVER : PROXY_READY
  }
  let probeImpl = overrides.probe || autoProbe

  const proxySettings = {
    port: DEFAULT_PORT,
    host: '127.0.0.1',
    scriptPath: SCRIPT_PATH,
    ...(overrides.proxy || {})
  }

  function releasePort() {
    if (overrides.stubborn !== true) listening = false
  }

  const service = createTranslationProxyService({
    getSettings: () => ({ proxy: proxySettings }),
    log: () => {},
    onChange: (status) => calls.states.push(status.state),
    spawnFn: (command, args, options) => {
      calls.attempts.push(command)
      const forcedCode = (overrides.spawnFailures || {})[command]
      if (forcedCode) {
        const failed = new EventEmitter()
        failed.pid = undefined
        setImmediate(() => {
          const error = new Error(`${command}: spawn failed`)
          error.code = forcedCode
          failed.emit('error', error)
        })
        return failed
      }
      const child = createFakeChild({ pid: overrides.pid })
      calls.spawn.push({ command, args, options })
      children.push(child)
      spawned = true
      listening = true
      setImmediate(() => child.emit('spawn'))
      return child
    },
    execFileFn: (command, args, options, callback) => {
      calls.exec.push({ command, args: [...args] })
      if (command === 'taskkill') releasePort()
      if ((overrides.execFailures || []).includes(command)) {
        setImmediate(() => callback(new Error(`${command}: exec failed`), ''))
        return
      }
      const script = String(args[args.length - 1] || '')
      let stdout = ''
      if (script.includes('Get-NetTCPConnection')) stdout = String(overrides.listenerPid ?? '')
      else if (script.includes('Get-CimInstance')) stdout = overrides.commandLine ?? 'python call_api.py --serve'
      setImmediate(() => callback(null, stdout))
    },
    execFileSyncFn: (command, args, options) => {
      calls.execSync.push({ command, args: [...args], options })
      if (command === 'taskkill') releasePort()
      return ''
    },
    probe: async (input) => probeImpl(input),
    platform: overrides.platform || 'win32',
    env: {},
    killProcess: (pid) => {
      calls.signals.push(pid)
      releasePort()
    },
    delay: async (ms) => { nowMs += ms },
    now: () => nowMs
  })

  return {
    service,
    calls,
    children,
    proxySettings,
    setProbe(fn) { probeImpl = fn },
    setListening(value) { listening = value },
    setOtherServer(value) { otherServer = value },
    setSetting(patch) { Object.assign(proxySettings, patch) },
    child: () => children[children.length - 1]
  }
}

test('start launches python with the proxy arguments and reports running once the probe answers', async () => {
  const h = createService()

  const status = await h.service.start()

  assert.equal(status.state, 'running')
  assert.equal(status.running, true)
  assert.equal(status.busy, false)
  assert.equal(status.pid, 4242)
  assert.equal(status.endpoint, 'http://127.0.0.1:8080/v1')
  assert.equal(status.lastError, '')

  assert.equal(h.calls.spawn.length, 1)
  const [attempt] = h.calls.spawn
  assert.equal(attempt.command, 'py')
  // The candidate contributes its own prefix, so py -3 really is "-3 <script>".
  assert.deepEqual(attempt.args, ['-3', SCRIPT_PATH, '--serve', '8080', '--host', '127.0.0.1'])
  assert.deepEqual(attempt.options.stdio, ['ignore', 'pipe', 'pipe'])
  assert.equal(attempt.options.windowsHide, true)
  // The banner is UTF-8 but a Windows pipe defaults to the ANSI code page, so
  // without this every logged line is mojibake.
  assert.equal(attempt.options.env.PYTHONIOENCODING, 'utf-8')
  assert.equal(attempt.options.env.PYTHONUNBUFFERED, '1')
  assert.deepEqual(h.calls.states, ['starting', 'running'])
})

test('start falls back to the next interpreter when the launcher is missing', async () => {
  const h = createService({ spawnFailures: { py: 'ENOENT' } })

  await h.service.start()

  assert.deepEqual(h.calls.attempts, ['py', 'python'])
  assert.equal(h.calls.spawn.length, 1)
  assert.equal(h.calls.spawn[0].command, 'python')
  assert.deepEqual(h.calls.spawn[0].args, [SCRIPT_PATH, '--serve', '8080', '--host', '127.0.0.1'])
})

test('start reports python-missing when no candidate interpreter exists', async () => {
  const h = createService({ spawnFailures: { py: 'ENOENT', python: 'ENOENT' } })

  await assert.rejects(h.service.start(), (error) => error.code === ERROR_CODES.pythonMissing)
  assert.equal(h.service.getStatus().state, 'error')
  assert.deepEqual(h.calls.attempts, ['py', 'python'])
})

test('start without a configured repository fails before spawning anything', async () => {
  const h = createService({ proxy: { scriptPath: '', repoDirectory: '' } })

  await assert.rejects(h.service.start(), (error) => error.code === ERROR_CODES.scriptMissing)
  assert.match(h.service.getStatus().lastError, /repoDirectory/)
  assert.equal(h.service.getStatus().state, 'error')
  assert.deepEqual(h.calls.spawn, [])
  assert.deepEqual(h.calls.attempts, [])
})

test('start rejects a relative script path instead of resolving it against the app cwd', async () => {
  const h = createService({ proxy: { scriptPath: 'inference\\llm\\call_api.py' } })

  await assert.rejects(h.service.start(), (error) => error.code === ERROR_CODES.scriptMissing)
  assert.match(h.service.getStatus().lastError, /absolute/)
})

test('start reports a missing script with the path it actually checked', async () => {
  const h = createService({ proxy: { scriptPath: 'F:\\nope\\call_api.py' } })

  await assert.rejects(h.service.start(), (error) => error.code === ERROR_CODES.scriptMissing)
  assert.match(h.service.getStatus().lastError, /F:\\nope\\call_api\.py/)
})

test('start resolves the script from the configured repository directory', async () => {
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'highlighter-proxy-repo-'))
  const scriptDirectory = path.join(repository, 'inference', 'llm')
  fs.mkdirSync(scriptDirectory, { recursive: true })
  fs.writeFileSync(path.join(scriptDirectory, 'call_api.py'), '# placeholder\n')
  try {
    const h = createService({ proxy: { scriptPath: '', repoDirectory: repository } })

    await h.service.start()

    assert.equal(h.service.getStatus().running, true)
    assert.equal(h.calls.spawn[0].args[1], path.join(scriptDirectory, 'call_api.py'))
    // The probe runs from the repository root so the user can debug from the log.
    assert.equal(h.calls.spawn[0].options.cwd, repository)
  } finally {
    fs.rmSync(repository, { recursive: true, force: true })
  }
})

test('start refuses a port that another program already answers', async () => {
  const h = createService({ listening: true, otherServer: true })

  await assert.rejects(h.service.start(), (error) => error.code === ERROR_CODES.portInUse)
  assert.equal(h.service.getStatus().state, 'error')
  // Probing first is what keeps a second proxy instance from ever being spawned.
  assert.deepEqual(h.calls.spawn, [])
})

test('start adopts a proxy that is already listening instead of spawning a duplicate', async () => {
  const h = createService({ listening: true, listenerPid: 777 })

  const status = await h.service.start()

  assert.equal(status.state, 'running')
  assert.equal(status.adopted, true)
  assert.equal(status.pid, 777)
  assert.deepEqual(h.calls.spawn, [])
})

test('start fails when the child exits before the port answers, keeping the python output', async () => {
  const h = createService({ neverReady: true })
  h.setProbe(async () => {
    const child = h.child()
    if (child && !child.exited) {
      child.exited = true
      child.stderr.emit('data', 'Address already in use\n')
      child.emit('exit', 1)
    }
    return NOT_LISTENING
  })

  await assert.rejects(h.service.start(), (error) => {
    assert.equal(error.code, ERROR_CODES.childExited)
    assert.match(error.message, /Address already in use/)
    return true
  })
  assert.equal(h.service.getStatus().state, 'error')
})

test('start times out, kills the tree it started and reports the failure', async () => {
  const h = createService({ neverReady: true })

  await assert.rejects(h.service.start(), (error) => error.code === ERROR_CODES.startTimeout)

  assert.equal(h.service.getStatus().state, 'error')
  const taskkill = h.calls.exec.find((call) => call.command === 'taskkill')
  assert.ok(taskkill, 'the half-started process is cleaned up')
  assert.deepEqual(taskkill.args, ['/PID', '4242', '/T', '/F'])
})

test('start is idempotent while a transition is in flight', async () => {
  const h = createService()

  const first = h.service.start()
  const second = h.service.start()
  assert.equal(h.service.getStatus().busy, true)
  await Promise.all([first, second])

  assert.equal(h.calls.spawn.length, 1)
  assert.equal(h.service.getStatus().running, true)
})

test('stop kills the whole process tree and returns to idle once the port is free', async () => {
  const h = createService()

  await h.service.start()
  const status = await h.service.stop()

  assert.equal(status.state, 'idle')
  assert.equal(status.running, false)
  assert.deepEqual(h.calls.states, ['starting', 'running', 'stopping', 'idle'])

  const taskkill = h.calls.exec.filter((call) => call.command === 'taskkill')
  assert.equal(taskkill.length, 1)
  // /T is what stops the python process behind a py.exe launcher.
  assert.deepEqual(taskkill[0].args, ['/PID', '4242', '/T', '/F'])
})

test('stop refuses to kill an adopted process that is not the proxy', async () => {
  const h = createService({ listening: true, listenerPid: 999, commandLine: 'node unrelated-service.js' })

  await h.service.refresh()
  assert.equal(h.service.getStatus().adopted, true)

  await assert.rejects(h.service.stop(), (error) => error.code === ERROR_CODES.killRefused)
  assert.equal(h.calls.exec.some((call) => call.command === 'taskkill'), false)
  // The port still answers, so the checkbox must stay honest about it.
  assert.equal(h.service.getStatus().running, true)
  assert.equal(h.service.getStatus().lastErrorCode, ERROR_CODES.killRefused)
})

test('stop refuses an adopted process whose command line cannot be read', async () => {
  const h = createService({ listening: true, listenerPid: 999, commandLine: '' })

  await h.service.refresh()
  await assert.rejects(h.service.stop(), (error) => error.code === ERROR_CODES.killRefused)
  assert.equal(h.calls.exec.some((call) => call.command === 'taskkill'), false)
})

test('stop reports stop-timeout and keeps running when the port keeps answering', async () => {
  const h = createService({ stubborn: true, listenerPid: 4242 })

  await h.service.start()
  await assert.rejects(h.service.stop(), (error) => error.code === ERROR_CODES.stopTimeout)

  const status = h.service.getStatus()
  assert.equal(status.running, true)
  assert.equal(status.lastErrorCode, ERROR_CODES.stopTimeout)
  assert.equal(status.pid, 4242)
})

test('stop is a no-op when nothing is tracked and nothing listens', async () => {
  const h = createService()

  const status = await h.service.stop()

  assert.equal(status.state, 'idle')
  assert.deepEqual(h.calls.exec, [])
  assert.deepEqual(h.calls.signals, [])
})

test('stop discovers and stops a proxy when no pid was tracked', async () => {
  // Reached from the error state: an earlier start refused the port because
  // another program held it, so nothing is tracked but the bridge is not idle.
  const h = createService({ listening: true, otherServer: true, listenerPid: 616 })
  await assert.rejects(h.service.start(), (error) => error.code === ERROR_CODES.portInUse)

  // The port is now backed by something the guard accepts as the proxy.
  h.setOtherServer(false)
  await h.service.stop()

  const taskkill = h.calls.exec.filter((call) => call.command === 'taskkill')
  assert.deepEqual(taskkill[0].args, ['/PID', '616', '/T', '/F'])
  assert.equal(h.service.getStatus().state, 'idle')
})

test('refresh adopts a leftover proxy and releases it when it disappears', async () => {
  const h = createService({ listening: true, listenerPid: 555 })

  await h.service.refresh()
  assert.equal(h.service.getStatus().state, 'running')
  assert.equal(h.service.getStatus().adopted, true)
  assert.equal(h.service.getStatus().pid, 555)
  assert.deepEqual(h.calls.states, ['running'])

  h.setListening(false)
  await h.service.refresh()
  assert.equal(h.service.getStatus().state, 'idle')
  assert.deepEqual(h.calls.states, ['running', 'idle'])
})

test('refresh leaves a running transition alone', async () => {
  const h = createService()
  const starting = h.service.start()
  await h.service.refresh()
  await starting
  assert.equal(h.service.getStatus().running, true)
})

test('a proxy that dies while running flips the status instead of staying checked', async () => {
  const h = createService()

  await h.service.start()
  h.setListening(false)
  h.child().emit('exit', 2)

  const status = h.service.getStatus()
  assert.equal(status.state, 'error')
  assert.equal(status.running, false)
  assert.equal(status.lastErrorCode, ERROR_CODES.childExited)
})

test('toggle starts when idle and stops when running', async () => {
  const h = createService()

  assert.equal((await h.service.toggle()).running, true)
  assert.equal((await h.service.toggle()).running, false)
})

test('dispose kills synchronously so quitting the app cannot leave an orphan', async () => {
  const h = createService()
  await h.service.start()

  assert.equal(h.service.dispose(), true)
  assert.equal(h.calls.execSync.length, 1)
  assert.equal(h.calls.execSync[0].command, 'taskkill')
  assert.deepEqual(h.calls.execSync[0].args, ['/PID', '4242', '/T', '/F'])
  // Second call has nothing left to kill.
  assert.equal(h.service.dispose(), false)
})

test('a non-Windows host stops with a signal instead of taskkill', async () => {
  const h = createService({ platform: 'linux' })

  await h.service.start()
  await h.service.stop()

  assert.deepEqual(h.calls.signals, [4242])
  assert.equal(h.calls.exec.some((call) => call.command === 'taskkill'), false)
})

test('the apiBase and host settings reach the command line', async () => {
  const h = createService({ proxy: { port: 8088, host: '0.0.0.0', apiBase: 'http://127.0.0.1:8000/v1' } })

  await h.service.start()

  assert.deepEqual(h.calls.spawn[0].args, [
    '-3',
    SCRIPT_PATH,
    '--serve',
    '8088',
    '--host',
    '0.0.0.0',
    '--api-base',
    'http://127.0.0.1:8000/v1'
  ])
  assert.equal(h.service.getStatus().endpoint, 'http://127.0.0.1:8088/v1')
  assert.equal(h.service.getStatus().host, '0.0.0.0')
})

test('an invalid stored port falls back to the default instead of failing to bind', async () => {
  const h = createService({ proxy: { port: 70000 } })

  await h.service.start()

  assert.equal(h.service.getStatus().port, DEFAULT_PORT)
  assert.equal(h.calls.spawn[0].args.includes(String(DEFAULT_PORT)), true)
})

test('unexpected spawn failures are reported without trying another interpreter', async () => {
  const h = createService({ spawnFailures: { py: 'EACCES' } })

  await assert.rejects(h.service.start(), (error) => error.code === ERROR_CODES.spawnFailed)
  assert.deepEqual(h.calls.attempts, ['py'])
})

test('the change listener fires for every observable transition and stays quiet otherwise', async () => {
  const h = createService()

  await h.service.start()
  await h.service.stop()
  assert.deepEqual(h.calls.states, ['starting', 'running', 'stopping', 'idle'])

  // No state change, no rebuild: the tray is only rebuilt when it can differ.
  await h.service.refresh()
  assert.deepEqual(h.calls.states, ['starting', 'running', 'stopping', 'idle'])
})

test('a throwing change listener cannot break the state machine', async () => {
  let clock = 1000
  const service = createTranslationProxyService({
    getSettings: () => ({ proxy: { scriptPath: SCRIPT_PATH } }),
    log: () => {},
    onChange: () => { throw new Error('listener exploded') },
    spawnFn: () => {
      const child = createFakeChild()
      setImmediate(() => child.emit('spawn'))
      return child
    },
    probe: async () => NOT_LISTENING,
    platform: 'linux',
    delay: async (ms) => { clock += ms },
    now: () => clock
  })

  assert.equal(service.getStatus().state, 'idle')
  await assert.rejects(service.start(), (error) => error.code === ERROR_CODES.startTimeout)
  assert.equal(service.getStatus().state, 'error')
})
