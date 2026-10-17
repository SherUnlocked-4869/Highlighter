'use strict'

// End-to-end tests for the in-process relay.
//
// No network and no python: the relay binds an ephemeral loopback port and talks
// to a fake upstream that this file starts on another ephemeral port. That makes
// the assertions about bytes on the wire (payload injection, header whitelist,
// streaming) instead of about which helper was called.

const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')

const {
  createTranslationProxyService,
  ERROR_CODES,
  PROBE_MARKER,
  DEFAULT_MODEL,
  DEFAULT_PORT
} = require('../main/services/translation-proxy-service')

function createUpstream(handler) {
  const requests = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const record = { method: req.method, url: req.url, headers: req.headers, body }
      requests.push(record)
      try {
        handler(record, req, res)
      } catch (error) {
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.end(String(error && error.message))
      }
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((done) => {
          server.closeAllConnections?.()
          server.close(done)
        })
      })
    })
  })
}

function request(port, path, { method = 'GET', headers = {}, body = null, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')
    const options = {
      host: '127.0.0.1',
      port,
      path,
      method,
      timeout: timeoutMs,
      headers: payload ? { 'content-type': 'application/json', ...headers } : headers
    }
    const req = http.request(options, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }))
      // A relayed stream can be aborted mid-flight (stop, client cancel); without
      // this the promise would never settle and the test would hang.
      res.on('aborted', () => reject(new Error('response aborted')))
      res.on('error', reject)
      res.on('close', () => {
        if (!res.complete) reject(new Error('response closed before completion'))
      })
    })
    req.on('timeout', () => req.destroy(new Error('client timeout')))
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

function createService(overrides = {}) {
  const transitions = []
  const settings = {
    proxy: {
      port: 0,
      host: '127.0.0.1',
      apiBase: '',
      ...(overrides.proxy || {})
    }
  }
  const service = createTranslationProxyService({
    getSettings: () => settings,
    log: () => {},
    onChange: (status) => transitions.push(status.state),
    ...(overrides.deps || {})
  })
  return { service, settings, transitions }
}

async function startRelay(overrides = {}) {
  const harness = createService(overrides)
  const status = await harness.service.start()
  return { ...harness, status, port: status.port }
}

test('start binds an ephemeral port and reports the address the tray shows', async (t) => {
  const relay = await startRelay()
  t.after(() => relay.service.dispose())

  assert.equal(relay.status.state, 'running')
  assert.equal(relay.status.running, true)
  assert.equal(relay.status.busy, false)
  assert.ok(relay.port > 0, 'the ephemeral port is reported back')
  assert.equal(relay.status.endpoint, `http://127.0.0.1:${relay.port}/v1`)
  // The relay lives in this process: there is no child pid and nothing to adopt.
  assert.equal(relay.status.pid, null)
  assert.equal(relay.status.adopted, false)
  assert.equal(relay.status.lastError, '')
  assert.deepEqual(relay.transitions, ['starting', 'running'])
})

test('GET / answers the readiness marker the probe and the plugin expect', async (t) => {
  const relay = await startRelay()
  t.after(() => relay.service.dispose())

  const response = await request(relay.port, '/')
  assert.equal(response.status, 200)
  assert.equal(response.body, PROBE_MARKER)
  assert.match(response.headers['content-type'], /text\/plain/)
  assert.equal(response.headers['access-control-allow-origin'], '*')
})

test('GET /v1/models advertises only the model the public endpoint serves', async (t) => {
  const relay = await startRelay()
  t.after(() => relay.service.dispose())

  for (const path of ['/v1/models', '/models']) {
    const response = await request(relay.port, path)
    assert.equal(response.status, 200, path)
    const payload = JSON.parse(response.body)
    assert.equal(payload.object, 'list')
    // The upstream script listed 2B/9B as well; those only exist on a self-hosted
    // deployment and picking them used to fail with "model not found".
    assert.deepEqual(payload.data, [{ id: DEFAULT_MODEL, object: 'model' }])
  }
})

test('OPTIONS answers the browser preflight with the full CORS set', async (t) => {
  const relay = await startRelay()
  t.after(() => relay.service.dispose())

  const response = await request(relay.port, '/v1/chat/completions', { method: 'OPTIONS' })
  assert.equal(response.status, 200)
  assert.equal(response.headers['access-control-allow-origin'], '*')
  assert.equal(response.headers['access-control-allow-methods'], 'GET, POST, OPTIONS')
  assert.equal(response.headers['access-control-allow-headers'], '*')
  assert.equal(response.headers['access-control-max-age'], '86400')
})

test('POST forwards the request and injects the translation defaults', async (t) => {
  const upstream = await createUpstream((record, req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: 'Hello, world.' } }] }))
  })
  t.after(() => upstream.close())
  const relay = await startRelay({ proxy: { apiBase: `${upstream.baseUrl}/v1` } })
  t.after(() => relay.service.dispose())

  const response = await request(relay.port, '/v1/chat/completions', {
    method: 'POST',
    body: { model: DEFAULT_MODEL, messages: [{ role: 'user', content: 'hi' }] }
  })

  assert.equal(response.status, 200)
  assert.equal(response.headers['access-control-allow-origin'], '*')
  assert.equal(JSON.parse(response.body).choices[0].message.content, 'Hello, world.')

  assert.equal(upstream.requests.length, 1)
  const forwarded = upstream.requests[0]
  assert.equal(forwarded.method, 'POST')
  assert.equal(forwarded.url, '/v1/chat/completions')
  // Anti-CoT is the reason this bridge exists at all.
  assert.equal(forwarded.headers['user-agent'], 'Index-Translate-Client/1.0')
  const payload = JSON.parse(forwarded.body)
  assert.equal(payload.chat_template_kwargs.enable_thinking, false)
  assert.equal(payload.temperature, 0)
  assert.equal(payload.model, DEFAULT_MODEL)
})

test('an explicit thinking/temperature choice is never overridden', async (t) => {
  const upstream = await createUpstream((record, req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })
  t.after(() => upstream.close())
  const relay = await startRelay({ proxy: { apiBase: `${upstream.baseUrl}/v1` } })
  t.after(() => relay.service.dispose())

  await request(relay.port, '/v1/chat/completions', {
    method: 'POST',
    body: {
      model: DEFAULT_MODEL,
      messages: [],
      temperature: 0.7,
      chat_template_kwargs: { enable_thinking: true, custom: 'kept' }
    }
  })

  const payload = JSON.parse(upstream.requests[0].body)
  assert.equal(payload.temperature, 0.7)
  assert.equal(payload.chat_template_kwargs.enable_thinking, true)
  assert.equal(payload.chat_template_kwargs.custom, 'kept')
})

test('a non-JSON body is forwarded byte for byte', async (t) => {
  const upstream = await createUpstream((record, req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })
  t.after(() => upstream.close())
  const relay = await startRelay({ proxy: { apiBase: `${upstream.baseUrl}/v1` } })
  t.after(() => relay.service.dispose())

  const raw = 'not json at all'
  const response = await request(relay.port, '/v1/completions', {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: raw
  })

  assert.equal(response.status, 200)
  assert.equal(upstream.requests[0].body, raw)
})

test('a streaming upstream reaches the client chunk by chunk', async (t) => {
  const upstream = await createUpstream((record, req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: first\n\n')
    setTimeout(() => {
      res.write('data: second\n\n')
      setTimeout(() => {
        res.write('data: third\n\n')
        res.end()
      }, 120)
    }, 120)
  })
  t.after(() => upstream.close())
  const relay = await startRelay({ proxy: { apiBase: `${upstream.baseUrl}/v1` } })
  t.after(() => relay.service.dispose())

  const arrivals = []
  const body = await new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify({ model: DEFAULT_MODEL, messages: [], stream: true }), 'utf8')
    const req = http.request({
      host: '127.0.0.1',
      port: relay.port,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': payload.length }
    }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        arrivals.push({ at: Date.now(), chunk })
        text += chunk
      })
      res.on('end', () => resolve(text))
    })
    req.on('error', reject)
    req.end(payload)
  })

  assert.match(body, /data: first/)
  assert.match(body, /data: third/)
  // Three separate writes means the first chunk arrived well before the last one;
  // a buffered relay would deliver them together.
  assert.ok(arrivals.length >= 3, `expected >= 3 chunks, saw ${arrivals.length}`)
  assert.ok(arrivals.at(-1).at - arrivals[0].at >= 100, 'the chunks were not streamed')
})

test('the upstream status and whitelisted headers are passed through', async (t) => {
  const upstream = await createUpstream((record, req, res) => {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7', 'set-cookie': 'secret=1' })
    res.end(JSON.stringify({ error: 'rate limited' }))
  })
  t.after(() => upstream.close())
  const relay = await startRelay({ proxy: { apiBase: `${upstream.baseUrl}/v1` } })
  t.after(() => relay.service.dispose())

  const response = await request(relay.port, '/v1/chat/completions', {
    method: 'POST',
    body: { model: DEFAULT_MODEL, messages: [] }
  })

  assert.equal(response.status, 429)
  assert.equal(response.headers['retry-after'], '7')
  assert.equal(response.headers['content-type'], 'application/json')
  assert.equal(response.headers['access-control-allow-origin'], '*')
  // A whitelist, not a passthrough: the upstream must not be able to set cookies
  // for the page through this bridge.
  assert.equal(response.headers['set-cookie'], undefined)
  assert.equal(JSON.parse(response.body).error, 'rate limited')
})

test('an unreachable upstream produces a 502 the page can read', async (t) => {
  // Port 1 on loopback is not listening, so the connect is refused immediately.
  const relay = await startRelay({ proxy: { apiBase: 'http://127.0.0.1:1/v1' } })
  t.after(() => relay.service.dispose())

  const response = await request(relay.port, '/v1/chat/completions', {
    method: 'POST',
    body: { model: DEFAULT_MODEL, messages: [] }
  })

  assert.equal(response.status, 502)
  assert.equal(response.headers['access-control-allow-origin'], '*')
  assert.ok(JSON.parse(response.body).error)
})

test('unknown paths answer 404 with CORS so the page can read the error', async (t) => {
  const relay = await startRelay()
  t.after(() => relay.service.dispose())

  const missing = await request(relay.port, '/v1/nope')
  assert.equal(missing.status, 404)
  assert.equal(missing.headers['access-control-allow-origin'], '*')

  const badPost = await request(relay.port, '/v1/embeddings', { method: 'POST', body: {} })
  assert.equal(badPost.status, 404)
  assert.equal(badPost.headers['access-control-allow-origin'], '*')
})

test('unsupported methods answer 405', async (t) => {
  const relay = await startRelay()
  t.after(() => relay.service.dispose())

  const response = await request(relay.port, '/v1/models', { method: 'DELETE' })
  assert.equal(response.status, 405)
})

test('a trailing slash on the upstream base never produces a double slash', async (t) => {
  const upstream = await createUpstream((record, req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })
  t.after(() => upstream.close())
  const relay = await startRelay({ proxy: { apiBase: `${upstream.baseUrl}/v1/` } })
  t.after(() => relay.service.dispose())

  await request(relay.port, '/v1/chat/completions', { method: 'POST', body: { messages: [] } })
  assert.equal(upstream.requests[0].url, '/v1/chat/completions')
})

test('a port that is already taken reports port-in-use instead of a raw EADDRINUSE', async (t) => {
  const occupied = await createUpstream((record, req, res) => res.end())
  t.after(() => occupied.close())
  const { service } = createService({ proxy: { port: occupied.port } })

  await assert.rejects(service.start(), (error) => error.code === ERROR_CODES.portInUse)
  const status = service.getStatus()
  assert.equal(status.state, 'error')
  assert.equal(status.running, false)
  assert.equal(status.lastErrorCode, ERROR_CODES.portInUse)
  assert.match(status.lastError, new RegExp(String(occupied.port)))
})

test('an invalid upstream address fails at toggle time, not on the first translation', async () => {
  const { service } = createService({ proxy: { apiBase: 'not-a-url' } })

  await assert.rejects(service.start(), (error) => error.code === ERROR_CODES.upstreamInvalid)
  assert.equal(service.getStatus().state, 'error')
  assert.equal(service.getStatus().lastErrorCode, ERROR_CODES.upstreamInvalid)

  const unsupported = createService({ proxy: { apiBase: 'ftp://example.com/v1' } })
  await assert.rejects(unsupported.service.start(), (error) => error.code === ERROR_CODES.upstreamInvalid)
})

test('start is idempotent while the listener is being created', async (t) => {
  const { service } = createService()

  const first = service.start()
  const second = service.start()
  assert.equal(service.getStatus().busy, true)
  const [a, b] = await Promise.all([first, second])
  t.after(() => service.dispose())

  assert.equal(a.port, b.port)
  assert.equal(service.getStatus().running, true)
})

test('stop releases the port and the relay can be started again', async (t) => {
  const { service } = createService()
  const first = await service.start()
  const port = first.port
  t.after(() => service.dispose())

  const stopped = await service.stop()
  assert.equal(stopped.state, 'idle')
  assert.equal(stopped.running, false)
  await assert.rejects(request(port, '/'), /ECONNREFUSED/)

  // Port reuse is the point: a stop/start cycle must not leave the socket behind.
  const restarted = await service.start()
  t.after(() => service.stop().catch(() => {}))
  assert.equal(restarted.running, true)
  const response = await request(restarted.port, '/')
  assert.equal(response.body, PROBE_MARKER)
})

test('stop is a no-op when the relay is idle', async () => {
  const { service } = createService()
  const status = await service.stop()
  assert.equal(status.state, 'idle')
})

test('dispose closes the listener synchronously for app quit', async () => {
  const { service } = createService()
  const status = await service.start()

  assert.equal(service.dispose(), true)
  assert.equal(service.dispose(), false)
  await assert.rejects(request(status.port, '/'), /ECONNREFUSED/)
})

test('an oversized body is rejected with 413', async (t) => {
  const relay = await startRelay({ deps: { maxBodyBytes: 64 } })
  t.after(() => relay.service.dispose())

  const response = await request(relay.port, '/v1/chat/completions', {
    method: 'POST',
    body: { messages: ['x'.repeat(200)] }
  })
  assert.equal(response.status, 413)
})

test('stop is not wedged by an in-flight streaming response', async (t) => {
  const upstream = await createUpstream((record, req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: first\n\n')
    // Never ends on its own: only closeAllConnections can release it.
  })
  t.after(() => upstream.close())
  const relay = await startRelay({ proxy: { apiBase: `${upstream.baseUrl}/v1` } })
  t.after(() => relay.service.dispose())

  const streaming = request(relay.port, '/v1/chat/completions', {
    method: 'POST',
    body: { model: DEFAULT_MODEL, messages: [], stream: true }
  }).catch(() => null)
  await new Promise((resolve) => setTimeout(resolve, 80))

  const startedAt = Date.now()
  const stopped = await relay.service.stop()
  const elapsed = Date.now() - startedAt

  assert.equal(stopped.state, 'idle')
  assert.ok(elapsed < 2000, `stop took ${elapsed}ms, the open stream was not released`)
  await streaming
})

test('getStatus accepts the settings snapshot the tray already read', async (t) => {
  const { service } = createService()
  t.after(() => service.dispose())

  const status = service.getStatus({ proxy: { port: 9123, host: '0.0.0.0', apiBase: 'http://127.0.0.1:8000/v1' } })
  assert.equal(status.port, 9123)
  assert.equal(status.host, '0.0.0.0')
  assert.equal(status.apiBase, 'http://127.0.0.1:8000/v1')
  assert.equal(status.endpoint, 'http://127.0.0.1:9123/v1')
})

test('the settings default port is still 8080', () => {
  assert.equal(DEFAULT_PORT, 8080)
  const { service } = createService({ proxy: { port: 70000 } })
  assert.equal(service.getStatus().port, DEFAULT_PORT)
})
