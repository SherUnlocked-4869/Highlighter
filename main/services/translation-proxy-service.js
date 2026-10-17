'use strict'

// Lifecycle owner for the Index-Translate local proxy bridge
// (`python inference/llm/call_api.py --serve`), toggled from the tray menu.
//
// Contract: "toggle, then trust a probe". Every state transition is confirmed by
// asking the loopback port, never by remembering a click, so a proxy left over
// from a previous session (or started by hand) is adopted instead of duplicated.
//
// Everything is injected (spawn / execFile / probe / clock) so node:test can
// drive the whole state machine without starting python. The copy in this file is
// diagnostics only - user-facing text lives in shared/locales/main.js, and
// scripts/check-i18n.js counts CJK literals under main/, so this file stays
// English on purpose.

const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { execFile, execFileSync, spawn } = require('node:child_process')

const STATE = Object.freeze({
  idle: 'idle',
  starting: 'starting',
  running: 'running',
  stopping: 'stopping',
  error: 'error'
})

// Stable codes the assembly layer maps onto localized copy. The messages that
// travel with them stay technical (and English) because they also land in the log.
const ERROR_CODES = Object.freeze({
  scriptMissing: 'script-missing',
  pythonMissing: 'python-missing',
  portInUse: 'port-in-use',
  spawnFailed: 'spawn-failed',
  startTimeout: 'start-timeout',
  childExited: 'child-exited',
  stopTimeout: 'stop-timeout',
  killRefused: 'kill-refused'
})

// call_api.py answers GET / with this exact body. It is the cheapest way to tell
// "our proxy" from "some other program that happens to hold the port", and unlike
// /v1/models it needs no JSON parsing.
const PROBE_MARKER = 'Index-Translate Proxy Ready'
const SCRIPT_RELATIVE_PATH = path.join('inference', 'llm', 'call_api.py')
// The command line a process must carry before an adopted pid may be killed.
const SCRIPT_MARKER = 'call_api.py'

const READY_TIMEOUT_MS = 20000
const STOP_TIMEOUT_MS = 5000
const POLL_INTERVAL_MS = 250
const PROBE_TIMEOUT_MS = 800
const COMMAND_TIMEOUT_MS = 10000
const KILL_TIMEOUT_MS = 3000
const STDERR_TAIL_LIMIT = 600

const DEFAULT_PORT = 8080
const DEFAULT_HOST = '127.0.0.1'

function createError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

// Loopback only: the proxy binds 127.0.0.1 unless the user explicitly asked for
// 0.0.0.0, and 0.0.0.0 is not a valid destination anyway.
function probeProxy({ port, timeoutMs = PROBE_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    const request = http.get({ host: DEFAULT_HOST, port, path: '/', timeout: timeoutMs }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => resolve({
        answering: true,
        isProxy: response.statusCode === 200 && body.includes(PROBE_MARKER)
      }))
    })
    request.on('timeout', () => request.destroy())
    // ECONNREFUSED is the expected "down" answer, not a failure: the only
    // interesting outcome is "something answered and said it is the proxy".
    request.on('error', () => resolve({ answering: false, isProxy: false }))
  })
}

function createTranslationProxyService(deps = {}) {
  const {
    getSettings = () => ({}),
    log = () => {},
    onChange = () => {},
    spawnFn = spawn,
    execFileFn = execFile,
    execFileSyncFn = execFileSync,
    probe = probeProxy,
    platform = process.platform,
    env = process.env,
    killProcess = (pid) => process.kill(pid),
    delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) }),
    now = () => Date.now()
  } = deps

  let state = STATE.idle
  let child = null
  let childExit = null
  let adoptedPid = null
  let inFlight = null
  let stopping = false
  let lastError = ''
  let lastErrorCode = ''
  let stderrTail = ''
  let changedAt = now()
  let lastSignature = ''

  // The override lets a caller that already holds the settings snapshot (the tray
  // rebuilds on every action-window event) avoid a second SettingsService read,
  // which decrypts stored credentials on each call.
  function proxySettings(override) {
    const raw = (override || getSettings() || {}).proxy || {}
    const port = Number.isInteger(raw.port) && raw.port > 0 && raw.port < 65536 ? raw.port : DEFAULT_PORT
    return {
      port,
      host: raw.host === '0.0.0.0' ? '0.0.0.0' : DEFAULT_HOST,
      repoDirectory: typeof raw.repoDirectory === 'string' ? raw.repoDirectory.trim() : '',
      scriptPath: typeof raw.scriptPath === 'string' ? raw.scriptPath.trim() : '',
      pythonPath: typeof raw.pythonPath === 'string' ? raw.pythonPath.trim() : '',
      apiBase: typeof raw.apiBase === 'string' ? raw.apiBase.trim() : ''
    }
  }

  // Absolute paths only: a relative value (hand-edited store, wrong picker) would
  // silently resolve against the app's working directory instead of the repo.
  function resolveScriptPath(settings) {
    if (settings.scriptPath) {
      if (!path.isAbsolute(settings.scriptPath)) {
        throw createError(ERROR_CODES.scriptMissing, `Proxy script path must be absolute: ${settings.scriptPath}`)
      }
      return settings.scriptPath
    }
    if (!settings.repoDirectory || !path.isAbsolute(settings.repoDirectory)) {
      throw createError(ERROR_CODES.scriptMissing, 'Proxy repository directory is not configured (settings.proxy.repoDirectory)')
    }
    return path.join(settings.repoDirectory, SCRIPT_RELATIVE_PATH)
  }

  // Checked before spawning so the failure names the path that was actually
  // looked at - "script gone" and "python gone" must not look alike.
  function assertScriptExists(scriptPath) {
    let stat = null
    try {
      stat = fs.statSync(scriptPath)
    } catch {
      stat = null
    }
    if (!stat || !stat.isFile()) {
      throw createError(ERROR_CODES.scriptMissing, `Proxy script not found: ${scriptPath}`)
    }
    return scriptPath
  }

  function pythonCandidates(settings) {
    if (settings.pythonPath) return [{ command: settings.pythonPath, args: [] }]
    return platform === 'win32'
      ? [{ command: 'py', args: ['-3'] }, { command: 'python', args: [] }]
      : [{ command: 'python3', args: [] }, { command: 'python', args: [] }]
  }

  function runCommand(command, args) {
    return new Promise((resolve, reject) => {
      execFileFn(command, args, { windowsHide: true, timeout: COMMAND_TIMEOUT_MS }, (error, stdout) => {
        if (error) reject(error)
        else resolve(String(stdout || ''))
      })
    })
  }

  // Tries each interpreter until one really spawns. Node emits 'spawn' once the
  // process exists, which is what separates "py -3 is not installed" (ENOENT, try
  // the next candidate) from "the interpreter rejected the launch" (report it).
  function spawnFirstAvailable(candidates, args, options) {
    return new Promise((resolve, reject) => {
      let index = 0
      const attempt = () => {
        if (index >= candidates.length) {
          reject(createError(
            ERROR_CODES.pythonMissing,
            `No usable Python interpreter (tried: ${candidates.map((candidate) => candidate.command).join(', ')})`
          ))
          return
        }
        const candidate = candidates[index]
        index += 1
        let settled = false
        let proc = null
        try {
          proc = spawnFn(candidate.command, [...candidate.args, ...args], options)
        } catch (error) {
          log('Proxy interpreter spawn failed:', candidate.command, error.message)
          attempt()
          return
        }
        proc.once('spawn', () => {
          if (settled) return
          settled = true
          resolve({ proc, candidate })
        })
        proc.once('error', (error) => {
          if (settled) return
          settled = true
          if (error.code === 'ENOENT') {
            attempt()
            return
          }
          reject(createError(ERROR_CODES.spawnFailed, `${candidate.command}: ${error.message}`))
        })
      }
      attempt()
    })
  }

  function attachChildLogging(proc) {
    if (typeof proc.stderr?.setEncoding === 'function') {
      proc.stderr.setEncoding('utf8')
      proc.stderr.on('data', (chunk) => {
        const text = String(chunk)
        stderrTail = (stderrTail + text).slice(-STDERR_TAIL_LIMIT)
        // call_api.py writes its access log to stderr, so this is informational.
        const line = text.trim()
        if (line) log('Translation proxy:', line)
      })
    }
    if (typeof proc.stdout?.setEncoding === 'function') {
      proc.stdout.setEncoding('utf8')
      proc.stdout.on('data', (chunk) => {
        const line = String(chunk).trim()
        if (line) log('Translation proxy:', line)
      })
    }
    proc.once('error', (error) => log('Translation proxy process error:', error.message))
    proc.once('exit', (code, signal) => {
      childExit = { code, signal }
      if (proc !== child) return
      child = null
      // stop() and the readiness loop own their own transitions.
      if (stopping || state === STATE.starting) return
      if (state === STATE.running) {
        setState(
          STATE.error,
          ERROR_CODES.childExited,
          `Proxy process exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`
        )
      }
    })
  }

  async function awaitReady(port) {
    const deadline = now() + READY_TIMEOUT_MS
    for (;;) {
      if (childExit) {
        const tail = stderrTail ? `: ${stderrTail}` : ''
        throw createError(
          ERROR_CODES.childExited,
          `Proxy process exited before becoming ready (code=${childExit.code ?? 'null'})${tail}`
        )
      }
      const result = await probe({ port })
      if (result.isProxy) return true
      if (result.answering) {
        throw createError(ERROR_CODES.portInUse, `Port ${port} is answered by another program, not the Index-Translate proxy`)
      }
      if (now() >= deadline) {
        throw createError(ERROR_CODES.startTimeout, `Proxy did not answer http://127.0.0.1:${port}/ within ${READY_TIMEOUT_MS}ms`)
      }
      await delay(POLL_INTERVAL_MS)
    }
  }

  async function awaitPortReleased(port) {
    const deadline = now() + STOP_TIMEOUT_MS
    for (;;) {
      const result = await probe({ port })
      if (!result.answering) return true
      if (now() >= deadline) return false
      await delay(POLL_INTERVAL_MS)
    }
  }

  async function killTree(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false
    if (platform === 'win32') {
      try {
        // /T is mandatory: with a "py -3" launch the launcher is only the parent
        // shell, and Windows has no process-group kill, so child.kill() would
        // leave the real python process holding the port.
        await runCommand('taskkill', ['/PID', String(pid), '/T', '/F'])
        return true
      } catch (error) {
        log('Proxy taskkill failed, falling back to process.kill:', error.message)
      }
    }
    try {
      killProcess(pid)
      return true
    } catch (error) {
      log('Proxy process.kill failed:', error.message)
      return false
    }
  }

  async function listenerPid(port) {
    if (platform !== 'win32') return null
    const script = `(Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`
    try {
      const output = await runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
      const pid = Number(String(output).trim())
      return Number.isInteger(pid) && pid > 0 ? pid : null
    } catch (error) {
      log('Proxy listener lookup failed:', error.message)
      return null
    }
  }

  async function commandLineOf(pid) {
    if (platform !== 'win32') return ''
    const script = `(Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`
    try {
      return String(await runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])).trim()
    } catch (error) {
      log('Proxy command-line lookup failed:', error.message)
      return ''
    }
  }

  // An adopted process is somebody else's until proven otherwise, so the same
  // guard everything-service.js uses for Everything applies here: only a command
  // line that mentions call_api.py may be killed.
  async function assertKillableAdopted(pid) {
    const commandLine = await commandLineOf(pid)
    if (!commandLine) {
      throw createError(ERROR_CODES.killRefused, `Refusing to stop pid ${pid}: its command line could not be read`)
    }
    if (!commandLine.includes(SCRIPT_MARKER)) {
      throw createError(ERROR_CODES.killRefused, `Refusing to stop pid ${pid}: it is not the Index-Translate proxy`)
    }
    return pid
  }

  async function discardChild() {
    const proc = child
    child = null
    const pid = proc?.pid
    if (Number.isInteger(pid) && pid > 0) {
      await killTree(pid)
      return
    }
    if (proc && typeof proc.kill === 'function') {
      try {
        proc.kill()
      } catch (error) {
        log('Proxy partial-spawn cleanup failed:', error.message)
      }
    }
  }

  function getStatus(override) {
    const settings = proxySettings(override)
    const pid = Number.isInteger(child?.pid) ? child.pid : adoptedPid
    return {
      state,
      running: state === STATE.running,
      busy: state === STATE.starting || state === STATE.stopping,
      adopted: state === STATE.running && child === null && adoptedPid !== null,
      pid: Number.isInteger(pid) && pid > 0 ? pid : null,
      port: settings.port,
      host: settings.host,
      endpoint: `http://127.0.0.1:${settings.port}/v1`,
      lastError,
      lastErrorCode,
      changedAt
    }
  }

  function signature() {
    return [state, child?.pid ?? '', adoptedPid ?? '', lastErrorCode, lastError].join('|')
  }

  // The tray template is a snapshot, so main.js rebuilds it from this callback.
  function publish() {
    changedAt = now()
    const next = signature()
    if (next === lastSignature) return
    lastSignature = next
    try {
      onChange(getStatus())
    } catch (error) {
      log('Proxy status listener failed:', error.message)
    }
  }

  function setState(next, errorCode = '', message = '') {
    state = next
    lastErrorCode = errorCode
    lastError = message
    publish()
  }

  function start() {
    if (state === STATE.running) return Promise.resolve(getStatus())
    if (inFlight) return inFlight
    inFlight = runStart().finally(() => { inFlight = null })
    return inFlight
  }

  async function runStart() {
    const settings = proxySettings()
    childExit = null
    stderrTail = ''
    setState(STATE.starting)
    try {
      const scriptPath = assertScriptExists(resolveScriptPath(settings))
      // Probe first: a proxy already on the port must be adopted rather than
      // duplicated, otherwise the second instance only dies with EADDRINUSE and
      // the toggle looks broken.
      const existing = await probe({ port: settings.port })
      if (existing.isProxy) {
        child = null
        adoptedPid = await listenerPid(settings.port)
        setState(STATE.running)
        return getStatus()
      }
      if (existing.answering) {
        throw createError(ERROR_CODES.portInUse, `Port ${settings.port} is already answered by another program`)
      }

      const args = [scriptPath, '--serve', String(settings.port), '--host', settings.host]
      if (settings.apiBase) args.push('--api-base', settings.apiBase)
      const options = {
        cwd: settings.repoDirectory && path.isAbsolute(settings.repoDirectory) ? settings.repoDirectory : path.dirname(scriptPath),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Without this the banner is encoded with the ANSI code page (measured
        // cp936 here) even though the script itself is UTF-8, and every logged
        // line turns into mojibake. `chcp` does not apply to a pipe.
        env: { ...env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' }
      }
      const { proc } = await spawnFirstAvailable(pythonCandidates(settings), args, options)
      child = proc
      attachChildLogging(proc)
      await awaitReady(settings.port)
      setState(STATE.running)
      return getStatus()
    } catch (error) {
      await discardChild()
      setState(STATE.error, error.code || '', error.message)
      throw error
    }
  }

  function stop() {
    if (state === STATE.idle) return Promise.resolve(getStatus())
    if (inFlight) return inFlight
    inFlight = runStop().finally(() => { inFlight = null })
    return inFlight
  }

  async function runStop() {
    const settings = proxySettings()
    stopping = true
    setState(STATE.stopping)
    try {
      const ownedPid = Number.isInteger(child?.pid) && child.pid > 0 ? child.pid : null
      if (ownedPid !== null) {
        await killTree(ownedPid)
      } else {
        const discovered = Number.isInteger(adoptedPid) && adoptedPid > 0
          ? adoptedPid
          : await listenerPid(settings.port)
        if (discovered === null) {
          child = null
          adoptedPid = null
          setState(STATE.idle)
          return getStatus()
        }
        await assertKillableAdopted(discovered)
        await killTree(discovered)
      }
      if (!await awaitPortReleased(settings.port)) {
        throw createError(ERROR_CODES.stopTimeout, `Port ${settings.port} is still answering after the proxy was stopped`)
      }
      child = null
      adoptedPid = null
      childExit = null
      setState(STATE.idle)
      return getStatus()
    } catch (error) {
      // Re-probe instead of guessing: a refused or failed kill must leave the
      // checkbox showing the truth so the user can simply try again.
      const stillThere = await probe({ port: settings.port })
      child = null
      childExit = null
      if (stillThere.isProxy) {
        adoptedPid = await listenerPid(settings.port)
        setState(STATE.running, error.code || '', error.message)
      } else {
        adoptedPid = null
        setState(STATE.error, error.code || '', error.message)
      }
      throw error
    } finally {
      stopping = false
    }
  }

  function toggle() {
    return state === STATE.running ? stop() : start()
  }

  // Probe-only: called once at startup so a proxy left running by a crashed
  // session shows up as checked instead of being reported as idle.
  async function refresh() {
    const settings = proxySettings()
    if (inFlight || state === STATE.starting || state === STATE.stopping) return getStatus()
    const result = await probe({ port: settings.port })
    if (result.isProxy) {
      if (state !== STATE.running) {
        child = null
        adoptedPid = await listenerPid(settings.port)
        setState(STATE.running)
      }
      return getStatus()
    }
    if (state === STATE.running) {
      child = null
      adoptedPid = null
      setState(STATE.idle)
    }
    return getStatus()
  }

  // Synchronous on purpose: app 'before-quit' cannot await, and a python process
  // that outlives the app would hold the port until the next launch adopts it.
  function dispose() {
    const pid = Number.isInteger(child?.pid) ? child.pid : adoptedPid
    child = null
    adoptedPid = null
    if (!Number.isInteger(pid) || pid <= 0) return false
    if (platform === 'win32') {
      try {
        execFileSyncFn('taskkill', ['/PID', String(pid), '/T', '/F'], {
          windowsHide: true,
          timeout: KILL_TIMEOUT_MS,
          stdio: 'ignore'
        })
        return true
      } catch (error) {
        log('Proxy dispose taskkill failed:', error.message)
      }
    }
    try {
      killProcess(pid)
      return true
    } catch (error) {
      log('Proxy dispose kill failed:', error.message)
      return false
    }
  }

  return {
    getStatus,
    start,
    stop,
    toggle,
    refresh,
    dispose
  }
}

module.exports = {
  createTranslationProxyService,
  probeProxy,
  STATE,
  ERROR_CODES,
  DEFAULT_PORT,
  DEFAULT_HOST,
  PROBE_MARKER,
  SCRIPT_MARKER
}
