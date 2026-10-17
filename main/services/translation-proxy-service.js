'use strict'

// Owns the Index-Translate local bridge: an in-process OpenAI-compatible relay
// in front of the public cloud endpoint.
//
// Attribution (Apache-2.0, section 4(b)/(c)): the relay protocols here are
// derived from `bilibili/Index-Translate` commit
// 9aff74ca50c60873916f99269b10cd0d79237b4a, file `inference/llm/call_api.py`
// (`run_proxy_server`). This file has been REWRITTEN for this application: it is
// not the upstream source, and the behaviour that must match it is listed in
// docs/proxy-inprocess-relay-plan.md §4. Licence text: docs/third-party/.
//
// History: this module used to spawn `python inference/llm/call_api.py --serve`.
// That required a Python 3 install on the user's machine, plus a whole layer of
// subprocess lifecycle code (interpreter probing, PYTHONIOENCODING, taskkill /T
// /F, orphan adoption). The relay is small enough to live in this process, which
// removes the dependency and every failure mode that came with it.
//
// Contract: `start()` resolves only once the socket is bound, so the tray
// checkbox reflects a listener that really accepts connections. Everything is
// injected so node:test can drive the relay without touching the network.
//
// Copy here is diagnostics only; user-facing text lives in shared/locales/main.js
// (scripts/check-i18n.js counts CJK literals under main/, so this file is
// English on purpose).

const http = require('node:http')
const https = require('node:https')
const { pipeline } = require('node:stream')

const STATE = Object.freeze({
  idle: 'idle',
  starting: 'starting',
  running: 'running',
  stopping: 'stopping',
  error: 'error'
})

// Stable codes the assembly layer maps onto localized copy (see
// proxy-bridge-controller.js). The messages that travel with them stay technical
// and English because they also land in the app log.
const ERROR_CODES = Object.freeze({
  portInUse: 'port-in-use',
  listenFailed: 'listen-failed',
  upstreamInvalid: 'upstream-invalid'
})

// The readiness body. Immersive Translate and the settings card both use
// `GET /` as the cheapest "is the bridge alive" probe.
const PROBE_MARKER = 'Index-Translate Proxy Ready'
const DEFAULT_PORT = 8080
const HOST_LOOPBACK = '127.0.0.1'
const HOST_WILDCARD = '0.0.0.0'
// This is the only model the public endpoint actually serves; the upstream
// script also advertised 2B/9B, which only exist on a self-hosted deployment.
const DEFAULT_MODEL = 'Index-Translate-35B-A3B'
const DEFAULT_API_BASE = 'https://index-translate.bilibili.com/v1'
const CLIENT_USER_AGENT = 'Index-Translate-Client/1.0'

const UPSTREAM_TIMEOUT_MS = 120000
const SERVER_CLOSE_TIMEOUT_MS = 2000
const MAX_BODY_BYTES = 32 * 1024 * 1024

// CORS is mandatory: the extension is a browser context calling loopback.
const CORS_HEADERS = Object.freeze({
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': '*',
  'access-control-max-age': '86400'
})

// Deliberately a whitelist: headers like set-cookie/server must never reach the
// page, and content-encoding has to survive because the body is piped verbatim.
const FORWARDED_RESPONSE_HEADERS = Object.freeze(['content-type', 'cache-control', 'content-encoding', 'retry-after'])

const FORWARDED_ENDPOINTS = Object.freeze([
  ['/chat/completions', '/chat/completions'],
  ['/completions', '/completions'],
  ['/responses', '/responses']
])

function createError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function resolvePathname(rawUrl) {
  try {
    return new URL(rawUrl || '/', 'http://127.0.0.1').pathname
  } catch {
    return '/'
  }
}

// Mirrors the upstream proxy: the client must not have its endpoint silently
// rewritten, so only the suffix is forwarded.
function resolveForwardedEndpoint(rawUrl) {
  const pathname = resolvePathname(rawUrl).replace(/\/+$/, '')
  for (const [suffix, forwarded] of FORWARDED_ENDPOINTS) {
    if (pathname.endsWith(suffix)) return forwarded
  }
  return null
}

// The whole reason this bridge exists: the model can emit chain-of-thought, and
// web-page translation must not spend latency or tokens on it. Only fill in the
// fields the client left open - an explicit choice is never overridden.
function injectTranslationDefaults(body) {
  if (!body || body.length === 0) return body
  let payload
  try {
    payload = JSON.parse(body.toString('utf8'))
  } catch {
    return body
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return body
  if (!payload.chat_template_kwargs || typeof payload.chat_template_kwargs !== 'object' || Array.isArray(payload.chat_template_kwargs)) {
    payload.chat_template_kwargs = {}
  }
  if (!Object.hasOwn(payload.chat_template_kwargs, 'enable_thinking')) {
    payload.chat_template_kwargs.enable_thinking = false
  }
  if (payload.temperature === undefined || payload.temperature === null) {
    payload.temperature = 0
  }
  return Buffer.from(JSON.stringify(payload), 'utf8')
}

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    let done = false
    const fail = (error) => {
      if (done) return
      done = true
      reject(error)
    }
    req.on('data', (chunk) => {
      if (done) return
      total += chunk.length
      if (total > limit) {
        fail(createError('body-too-large', `Request body exceeds ${limit} bytes`))
        // Keep draining without buffering: destroying the request here would also
        // kill the socket the 413 response still has to travel over.
        req.resume()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (done) return
      done = true
      resolve(Buffer.concat(chunks))
    })
    req.on('error', fail)
  })
}

function sendBuffer(res, statusCode, contentType, body) {
  if (res.writableEnded || res.destroyed) return false
  res.writeHead(statusCode, {
    ...CORS_HEADERS,
    'content-type': contentType,
    'content-length': String(body.length)
  })
  res.end(body)
  return true
}

function sendJson(res, statusCode, payload) {
  return sendBuffer(res, statusCode, 'application/json; charset=utf-8', Buffer.from(JSON.stringify(payload), 'utf8'))
}

function sendText(res, statusCode, text) {
  return sendBuffer(res, statusCode, 'text/plain; charset=utf-8', Buffer.from(text, 'utf8'))
}

function buildUpstreamUrl(apiBase, upstreamPath) {
  return new URL(String(apiBase).replace(/\/+$/, '') + upstreamPath)
}

function assertUpstreamBase(apiBase) {
  let parsed
  try {
    parsed = new URL(apiBase)
  } catch {
    throw createError(ERROR_CODES.upstreamInvalid, `Invalid upstream API base: ${apiBase}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw createError(ERROR_CODES.upstreamInvalid, `Unsupported upstream protocol: ${parsed.protocol}`)
  }
  return apiBase
}

function createRelayHandler({ getApiBase, log, maxBodyBytes = MAX_BODY_BYTES }) {
  function handleForward(req, res) {
    return (async () => {
      const upstreamPath = resolveForwardedEndpoint(req.url)
      if (!upstreamPath) {
        sendJson(res, 404, { error: 'unsupported endpoint' })
        return
      }
      let body
      try {
        body = await readBody(req, maxBodyBytes)
      } catch (error) {
        sendJson(res, error.code === 'body-too-large' ? 413 : 400, { error: error.message })
        return
      }
      // The reason this bridge exists: suppress chain-of-thought unless the client
      // asked for it. Applied per request, before anything leaves the machine.
      body = injectTranslationDefaults(body)
      let target
      try {
        target = buildUpstreamUrl(getApiBase(), upstreamPath)
      } catch (error) {
        log('Proxy upstream base invalid:', error.message)
        sendJson(res, 502, { error: 'invalid upstream base' })
        return
      }
      await forwardToUpstream({ req, res, target, body, log })
    })().catch((error) => {
      log('Proxy request failed:', error.message)
      sendJson(res, 500, { error: 'internal relay error' })
    })
  }

  return function handle(req, res) {
    const method = req.method || 'GET'
    if (method === 'OPTIONS') {
      res.writeHead(200, { ...CORS_HEADERS, 'content-length': '0' })
      res.end()
      return
    }
    if (method === 'GET') {
      const pathname = resolvePathname(req.url)
      if (pathname === '/') {
        sendText(res, 200, PROBE_MARKER)
        return
      }
      if (pathname === '/v1/models' || pathname === '/models') {
        sendJson(res, 200, { object: 'list', data: [{ id: DEFAULT_MODEL, object: 'model' }] })
        return
      }
      sendJson(res, 404, { error: 'not found' })
      return
    }
    if (method === 'POST') {
      handleForward(req, res)
      return
    }
    sendJson(res, 405, { error: 'method not allowed' })
  }
}

function forwardToUpstream({ req, res, target, body, log }) {
  return new Promise((resolve) => {
    const client = target.protocol === 'https:' ? https : http
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve()
    }

    const upstreamReq = client.request(target, {
      method: 'POST',
      timeout: UPSTREAM_TIMEOUT_MS,
      headers: {
        'content-type': 'application/json',
        'user-agent': CLIENT_USER_AGENT,
        'content-length': String(body.length)
      }
    }, (upstreamRes) => {
      const responseHeaders = { ...CORS_HEADERS, connection: 'close' }
      for (const name of FORWARDED_RESPONSE_HEADERS) {
        const value = upstreamRes.headers[name]
        if (value !== undefined) responseHeaders[name] = value
      }
      try {
        res.writeHead(upstreamRes.statusCode || 502, responseHeaders)
      } catch (error) {
        log('Proxy response header write failed:', error.message)
        upstreamRes.destroy()
        finish()
        return
      }
      // pipeline carries backpressure through and destroys both sides on error,
      // which matters for SSE: chunks must reach the page as they arrive.
      pipeline(upstreamRes, res, (error) => {
        if (error) log('Proxy stream failed:', error.message)
        finish()
      })
    })

    upstreamReq.on('timeout', () => {
      upstreamReq.destroy(createError('upstream-timeout', 'Upstream request timed out'))
    })
    upstreamReq.on('error', (error) => {
      log('Proxy upstream error:', error.message)
      if (res.headersSent) res.destroy()
      else sendJson(res, 502, { error: error.message || 'upstream request failed' })
      finish()
    })
    // The page closed the tab mid-translation: do not keep the upstream stream alive.
    res.on('close', () => {
      if (!res.writableEnded) upstreamReq.destroy()
    })
    upstreamReq.end(body)
  })
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    let settled = false
    const onError = (error) => {
      if (settled) return
      settled = true
      server.removeListener('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      if (settled) return
      settled = true
      server.removeListener('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

function closeServer(server) {
  return new Promise((resolve) => {
    // Without this an open SSE response keeps the server alive forever and the
    // toggle would hang on "stopping".
    try { server.closeAllConnections?.() } catch {}
    let settled = false
    const settle = () => {
      if (settled) return
      settled = true
      resolve()
    }
    try {
      server.close(settle)
    } catch {
      settle()
    }
    const timer = setTimeout(settle, SERVER_CLOSE_TIMEOUT_MS)
    timer.unref?.()
  })
}

function createTranslationProxyService(deps = {}) {
  const {
    getSettings = () => ({}),
    log = () => {},
    onChange = () => {},
    createServer = (handler) => http.createServer(handler),
    now = () => Date.now(),
    maxBodyBytes = MAX_BODY_BYTES
  } = deps

  let state = STATE.idle
  let server = null
  let inFlight = null
  let boundPort = null
  let lastError = ''
  let lastErrorCode = ''
  let changedAt = now()
  let lastSignature = ''

  function proxySettings(override) {
    const raw = (override || getSettings() || {}).proxy || {}
    // 0 is accepted so tests can bind an ephemeral port; settings normalization
    // never lets a stored value reach 0.
    const port = Number.isInteger(raw.port) && raw.port >= 0 && raw.port < 65536 ? raw.port : DEFAULT_PORT
    const apiBase = typeof raw.apiBase === 'string' && raw.apiBase.trim() ? raw.apiBase.trim() : DEFAULT_API_BASE
    return {
      port,
      host: raw.host === HOST_WILDCARD ? HOST_WILDCARD : HOST_LOOPBACK,
      apiBase
    }
  }

  function getStatus(override) {
    const settings = proxySettings(override)
    const port = boundPort === null ? settings.port : boundPort
    return {
      state,
      running: state === STATE.running,
      busy: state === STATE.starting || state === STATE.stopping,
      adopted: false,
      // The relay lives in this process; there is no child pid to report.
      pid: null,
      port,
      host: settings.host,
      apiBase: settings.apiBase,
      endpoint: `http://127.0.0.1:${port}/v1`,
      lastError,
      lastErrorCode,
      changedAt
    }
  }

  function signature() {
    return [state, boundPort === null ? '' : String(boundPort), lastErrorCode, lastError].join('|')
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
    setState(STATE.starting)
    try {
      const settings = proxySettings()
      assertUpstreamBase(settings.apiBase)
      const instance = createServer(createRelayHandler({
        // Read per request so an edited upstream applies without a restart.
        getApiBase: () => proxySettings().apiBase,
        log,
        maxBodyBytes
      }))
      instance.on('error', (error) => {
        log('Proxy relay server error:', error.message)
        if (instance === server && state === STATE.running) {
          setState(STATE.error, ERROR_CODES.listenFailed, error.message)
        }
      })
      try {
        await listen(instance, settings.port, settings.host)
      } catch (error) {
        const mapped = error.code === 'EADDRINUSE'
          ? createError(ERROR_CODES.portInUse, `Port ${settings.port} is already in use`)
          : createError(ERROR_CODES.listenFailed, `Cannot listen on ${settings.host}:${settings.port} (${error.code || error.message})`)
        try { instance.close() } catch {}
        throw mapped
      }
      server = instance
      boundPort = instance.address()?.port ?? settings.port
      setState(STATE.running)
      return getStatus()
    } catch (error) {
      if (server) { try { server.close() } catch {} }
      server = null
      boundPort = null
      setState(STATE.error, error.code || ERROR_CODES.listenFailed, error.message)
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
    const instance = server
    server = null
    boundPort = null
    setState(STATE.stopping)
    try {
      if (instance) await closeServer(instance)
      setState(STATE.idle)
      return getStatus()
    } catch (error) {
      setState(STATE.error, error.code || '', error.message)
      throw error
    }
  }

  function toggle() {
    return state === STATE.running ? stop() : start()
  }

  // Probe-only reconciliation. There is no external process to adopt any more:
  // the only meaningful question is whether our own listener is still alive.
  async function refresh() {
    if (inFlight) return getStatus()
    if (state === STATE.running && (!server || server.listening === false)) {
      server = null
      boundPort = null
      setState(STATE.error, ERROR_CODES.listenFailed, 'Relay server is no longer listening')
    }
    return getStatus()
  }

  // Written for app 'before-quit', which cannot await: close the socket right now
  // and let the process teardown reclaim the rest.
  function dispose() {
    const instance = server
    server = null
    boundPort = null
    if (!instance) return false
    try { instance.closeAllConnections?.() } catch {}
    try { instance.close() } catch {}
    return true
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
  STATE,
  ERROR_CODES,
  PROBE_MARKER,
  DEFAULT_MODEL,
  DEFAULT_PORT,
  DEFAULT_HOST: HOST_LOOPBACK,
  DEFAULT_API_BASE,
  MAX_BODY_BYTES
}
