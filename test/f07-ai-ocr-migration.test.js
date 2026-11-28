'use strict'

// F07 (part 2) — docs/reviews/2026-11-26-code-review-and-optimization-report.md
// sections 三.7.3-5 (OCR/pipeline, AI client + translation proxy, migration) and
// 四.4.3 (proper-noun echo, private-network CORS/Authorization).
//
// The cases are behaviour-first: the AI client talks to a real loopback
// OpenAI-compatible server, the translation proxy talks to a real keep-alive
// upstream, the data-root migration runs over a temp directory, and the QR
// decoder is loaded into a vm context with a fake BarcodeDetector/jsQR. Only the
// Rust sidecar settings are asserted from source, because that binary cannot run
// under node:test.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')

const {
  buildTranslationOnlyPromptForLanguages,
  createFollowUpStream,
  createTranslateStream,
  resolveTranslateTarget,
  sourceLanguageCodeForText,
  translateOcrTextBlocks
} = require('../deepseek')
const { createTranslationProxyService, PROBE_MARKER } = require('../main/services/translation-proxy-service')
const { createLegacySourcePaths, migrateDataRoot } = require('../main/services/data-root-migration')
const { LOCATOR_NAME, createDataPaths, writeLocator } = require('../main/services/data-root')

const root = path.join(__dirname, '..')

async function temporaryRoot(t) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'highlighter-f07-'))
  t.after(() => fsp.rm(directory, { recursive: true, force: true }))
  return directory
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server.address().port
}

function readJsonBody(request) {
  return new Promise((resolve) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      try {
        resolve({ text: body, json: JSON.parse(body) })
      } catch {
        resolve({ text: body, json: null })
      }
    })
  })
}

function completion(content) {
  return JSON.stringify({
    id: 'f07',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content } }]
  })
}

function streamChunk(content) {
  return `data: ${JSON.stringify({
    id: 'f07',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content } }]
  })}\n\ndata: [DONE]\n\n`
}

async function collectStream(stream) {
  const parts = []
  for await (const part of stream) parts.push(part.choices?.[0]?.delta?.content)
  return parts
}

function providerFor(port, overrides = {}) {
  return {
    id: 'custom',
    name: 'Custom',
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: 'sk-f07',
    model: 'f07-chat-model',
    protocol: 'openai-chat',
    ...overrides
  }
}

// ---------------------------------------------------------------------------
// 三.7.4 (first half): the fallback probe result is cached per endpoint
// ---------------------------------------------------------------------------

test('F07: the probed (baseUrl, protocol) pair is cached and re-probed when the endpoint changes', async (t) => {
  const requests = []
  // 'moved-to-v1' is the normal case (the /v1 candidate works); flipping to
  // 'moved-to-root' simulates the provider moving the route back, which must drop
  // the cached entry instead of surfacing a 404.
  let routeMode = 'moved-to-v1'
  const server = http.createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      requests.push(request.url)
      const pathname = String(request.url || '').split('?')[0]
      if (pathname === '/api/chat/completions' || pathname === '/api/v1/chat/completions') {
        const works = routeMode === 'moved-to-v1'
          ? pathname === '/api/v1/chat/completions'
          : pathname === '/api/chat/completions'
        if (!works) {
          response.writeHead(404, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: { message: 'no route' } }))
          return
        }
      } else if (pathname === '/other/chat/completions') {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'no route' } }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(streamChunk('ok'))
    })
  })
  const port = await listen(server)
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve) }))

  const followUp = async (baseUrl) => {
    const stream = await createFollowUpStream({
      id: 'local',
      name: 'Local',
      baseUrl,
      apiKey: 'sk-f07',
      model: 'f07-chat-model',
      protocol: 'openai-chat'
    }, [{ role: 'user', content: 'hi' }])
    assert.deepEqual(await collectStream(stream), ['ok'])
  }

  // Cold: the first candidate 404s, the /v1 candidate answers.
  await followUp(`http://127.0.0.1:${port}/api`)
  assert.deepEqual(requests, ['/api/chat/completions', '/api/v1/chat/completions'])

  // Warm: the successful candidate is tried first, so no wasted 404.
  await followUp(`http://127.0.0.1:${port}/api`)
  assert.deepEqual(requests.slice(2), ['/api/v1/chat/completions'])

  // The server moved the route: the cached candidate 404s, the entry is dropped
  // and the normal probe finds the new working candidate.
  routeMode = 'moved-to-root'
  await followUp(`http://127.0.0.1:${port}/api`)
  assert.deepEqual(requests.slice(3), ['/api/v1/chat/completions', '/api/chat/completions'])

  // A different endpoint signature (the user edited the base URL) probes again.
  await followUp(`http://127.0.0.1:${port}/other`)
  assert.deepEqual(requests.slice(5), ['/other/chat/completions', '/other/v1/chat/completions'])
})

// ---------------------------------------------------------------------------
// 三.7.4 / 四.4.3: proper-noun translation echo is a normal result
// ---------------------------------------------------------------------------

test('F07: a proper noun echoed by the translation model after one retry is surfaced, not thrown', async (t) => {
  const requests = []
  const server = http.createServer((request, response) => {
    readJsonBody(request).then(() => {
      requests.push(request.url)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(completion('DeepSeek'))
    })
  })
  const port = await listen(server)
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve) }))

  const stream = await createTranslateStream(
    providerFor(port, { model: 'tencent/Hunyuan-MT-7B' }),
    'DeepSeek',
    undefined,
    { source: 'auto', target: '中文' }
  )
  assert.deepEqual(await collectStream(stream), ['DeepSeek'])
  assert.equal(requests.length, 2, 'the echo is retried exactly once, then accepted')
})

test('F07: a real translation is streamed on the first answer without a retry', async (t) => {
  const requests = []
  const server = http.createServer((request, response) => {
    readJsonBody(request).then(() => {
      requests.push(request.url)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(completion('深度求索'))
    })
  })
  const port = await listen(server)
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve) }))

  const stream = await createTranslateStream(
    providerFor(port, { model: 'tencent/Hunyuan-MT-7B' }),
    'DeepSeek',
    undefined,
    { source: 'auto', target: '中文' }
  )
  assert.deepEqual(await collectStream(stream), ['深度求索'])
  assert.equal(requests.length, 1)
})

test('F07: kana-free Japanese text is detected as Japanese and no longer flips a Chinese target to English', () => {
  // 図/picture, 気/spirit, 駅/station only exist as Japanese shinjitai; Chinese
  // writes 图/氣-气/驿-驛, so a kana-free run containing them is Japanese.
  assert.equal(sourceLanguageCodeForText('図書館'), 'ja')
  assert.equal(sourceLanguageCodeForText('気象庁'), 'ja')
  assert.equal(sourceLanguageCodeForText('你好世界'), 'zh')
  assert.equal(sourceLanguageCodeForText('안녕하세요'), 'ko')
  assert.equal(sourceLanguageCodeForText('Hello world'), 'auto')

  assert.equal(resolveTranslateTarget('auto', '中文', '図書館'), '中文')
  assert.equal(resolveTranslateTarget('auto', '中文', '今天天气不错'), '英文')
  assert.match(
    buildTranslationOnlyPromptForLanguages('図書館', 'auto', '英文'),
    /^Translate the given text from ja to en\./
  )
})

// ---------------------------------------------------------------------------
// 三.7.4 (second half): indexed OCR batches + concurrent repair of missing slots
// ---------------------------------------------------------------------------

test('F07: OCR translation keeps indices, repairs only the dropped blocks and does it concurrently', async (t) => {
  const requests = []
  const server = http.createServer((request, response) => {
    readJsonBody(request).then(({ json }) => {
      const messages = Array.isArray(json?.messages) ? json.messages : []
      const userTexts = messages.filter((message) => message.role === 'user').map((message) => String(message.content || ''))
      const userText = userTexts.join('\n')
      const record = { at: Date.now(), userText, userTexts }
      requests.push(record)
      if (/Translate every "t" value/.test(userText)) {
        // The model merges the heading with the next cell: only index 1 survives.
        const answer = '```json\n[{"i":1,"t":"世界"}]\n```'
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(completion(answer))
        return
      }
      const answers = { hello: '你好', 'good night': '晚安' }
      // The two repair requests are independent; a serial fallback would start the
      // second one only after the first response (250 ms later).
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(completion(answers[userTexts[0]] || userTexts[0]))
      }, 250)
    })
  })
  const port = await listen(server)
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve) }))

  const translations = await translateOcrTextBlocks(
    providerFor(port),
    ['hello', 'world', 'good night'],
    'auto',
    '中文'
  )
  assert.deepEqual(translations, ['你好', '世界', '晚安'])

  const batches = requests.filter((entry) => /Translate every "t" value/.test(entry.userText))
  assert.equal(batches.length, 1, 'one indexed batch request replaces the positional-array prompt')
  const inputJson = batches[0].userText.match(/Input JSON: (.*)$/m)?.[1]
  assert.deepEqual(JSON.parse(inputJson), [
    { i: 0, t: 'hello' },
    { i: 1, t: 'world' },
    { i: 2, t: 'good night' }
  ])

  const repairs = requests.filter((entry) => !/Translate every "t" value/.test(entry.userText))
  assert.deepEqual(repairs.map((entry) => entry.userTexts[0]).sort(), ['good night', 'hello'])
  const arrivals = repairs.map((entry) => entry.at).sort((left, right) => left - right)
  assert.ok(arrivals.length === 2)
  assert.ok(
    arrivals[1] - arrivals[0] < 150,
    `repair requests must be concurrent, arrivals were ${arrivals[1] - arrivals[0]}ms apart`
  )
})

// ---------------------------------------------------------------------------
// 三.7.4 / 四.4.3: relay keep-alive, Authorization passthrough, private network
// ---------------------------------------------------------------------------

function relayRequest(port, requestPath, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : Buffer.from(JSON.stringify(body), 'utf8')
    const requestHeaders = payload ? { 'content-type': 'application/json', ...headers } : headers
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: requestPath,
      method,
      timeout: 8000,
      headers: requestHeaders
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }))
      response.on('error', reject)
    })
    request.on('timeout', () => request.destroy(new Error('relay client timeout')))
    request.on('error', reject)
    if (payload) request.write(payload)
    request.end()
  })
}

test('F07: the relay keeps the upstream socket alive, forwards Authorization and advertises private-network access', async (t) => {
  const upstreamRequests = []
  const upstream = http.createServer((request, response) => {
    readJsonBody(request).then(() => {
      upstreamRequests.push({ headers: request.headers, socket: request.socket.remotePort })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true }))
    })
  })
  const upstreamPort = await listen(upstream)
  t.after(() => new Promise((resolve) => { upstream.closeAllConnections?.(); upstream.close(resolve) }))

  const service = createTranslationProxyService({
    getSettings: () => ({ proxy: { port: 0, host: '127.0.0.1', apiBase: `http://127.0.0.1:${upstreamPort}/v1` } }),
    log: () => {}
  })
  const status = await service.start()
  t.after(() => service.dispose())

  const preflight = await relayRequest(status.port, '/v1/chat/completions', { method: 'OPTIONS' })
  assert.equal(preflight.status, 200)
  assert.equal(preflight.headers['access-control-allow-private-network'], 'true')
  assert.equal(preflight.headers['access-control-allow-origin'], '*', 'the allowed origin is not widened')

  const probe = await relayRequest(status.port, '/')
  assert.equal(probe.body, PROBE_MARKER)
  assert.equal(probe.headers['access-control-allow-private-network'], 'true')

  await relayRequest(status.port, '/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer f07-token' },
    body: { model: 'Index-Translate-35B-A3B', messages: [] }
  })
  await relayRequest(status.port, '/v1/chat/completions', {
    method: 'POST',
    body: { model: 'Index-Translate-35B-A3B', messages: [] }
  })

  assert.equal(upstreamRequests.length, 2)
  assert.equal(upstreamRequests[0].headers.authorization, 'Bearer f07-token')
  assert.equal(upstreamRequests[1].headers.authorization, undefined, 'ambient auth is not invented')
  assert.equal(
    upstreamRequests[0].socket,
    upstreamRequests[1].socket,
    'both relayed requests must reuse one keep-alive upstream socket'
  )
})

// ---------------------------------------------------------------------------
// 五.7.5: the staged history manifest is hashed once and reused for the marker
// ---------------------------------------------------------------------------

test('F07: data-root migration hashes each staged history file once and records the same manifest', async (t) => {
  const parent = await temporaryRoot(t)
  const sourceRoot = path.join(parent, 'legacy')
  const targetRoot = path.join(parent, 'managed')
  const portableDirectory = path.join(parent, 'portable')
  const source = createLegacySourcePaths(sourceRoot)
  const target = createDataPaths(targetRoot)
  await fsp.mkdir(source.history, { recursive: true })
  await fsp.writeFile(source.configFile, '{}')
  await fsp.writeFile(source.logFile, 'log')
  const historyFiles = ['one.png', 'two.png', 'three.png', 'four.png']
  for (const name of historyFiles) await fsp.writeFile(path.join(source.history, name), name)
  await fsp.mkdir(portableDirectory, { recursive: true })
  await writeLocator(path.join(portableDirectory, LOCATOR_NAME), sourceRoot)

  const reads = []
  const realCreateReadStream = fs.createReadStream
  fs.createReadStream = function createReadStream(filePath, ...args) {
    reads.push(path.resolve(String(filePath)))
    return realCreateReadStream.call(fs, filePath, ...args)
  }
  try {
    await migrateDataRoot({ source, target, portableDirectory })
  } finally {
    fs.createReadStream = realCreateReadStream
  }

  const sourceReads = reads.filter((filePath) => filePath.startsWith(`${source.history}${path.sep}`))
  const stagingPattern = /[\\/]\.highlighter-migration-[^\\/]+[\\/]history[\\/]/
  const stagedHistoryReads = reads.filter((filePath) => stagingPattern.test(filePath))
  assert.equal(sourceReads.length, historyFiles.length)
  assert.equal(
    stagedHistoryReads.length,
    historyFiles.length,
    'the staged history files were hashed twice again: source + staged + marker recompute'
  )

  const marker = JSON.parse(await fsp.readFile(path.join(targetRoot, '.migration.json'), 'utf8'))
  assert.equal(marker.copiedHistoryCount, historyFiles.length)
  assert.deepEqual(
    marker.historyManifest.map((entry) => entry.path),
    [...historyFiles].sort()
  )
  for (const entry of marker.historyManifest) assert.match(entry.sha256, /^[a-f0-9]{64}$/)
})

// ---------------------------------------------------------------------------
// 三.7.3 / 四.4.3: QR recognition prefers the native BarcodeDetector
// ---------------------------------------------------------------------------

const recognitionSource = fs.readFileSync(path.join(root, 'recognition', 'recognition.js'), 'utf8')

function fakeCanvas(width, height) {
  const context = {
    imageSmoothingEnabled: true,
    drawImage() {},
    getImageData: (x, y, sampleWidth, sampleHeight) => ({
      data: new Uint8ClampedArray(sampleWidth * sampleHeight * 4),
      width: sampleWidth,
      height: sampleHeight
    })
  }
  return { width, height, getContext: () => context }
}

function elementStub() {
  return {
    textContent: '',
    value: '',
    disabled: false,
    onclick: null,
    classList: { contains: () => false, add() {}, remove() {}, toggle() {} },
    appendChild() {},
    replaceChildren() {}
  }
}

// The window script has no module boundary, so it is evaluated in a vm context and
// the decoder under test is exported onto a harness bag appended to the source.
function loadRecognition({ BarcodeDetector, jsQR }) {
  const elements = new Map()
  const out = {}
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (callback) => setTimeout(() => callback(Date.now()), 0),
    URL,
    matchMedia: () => ({ matches: false }),
    addEventListener() {},
    t: (key) => key,
    setLanguage() {},
    applyTranslations() {},
    __out: out,
    window: {
      BarcodeDetector,
      jsQR,
      exportResultBar: null,
      innerWidth: 800,
      innerHeight: 600,
      recognitionAPI: {
        onInit() {},
        onInterfaceLanguage() {},
        ready() {},
        close() {}
      }
    },
    document: {
      documentElement: { clientWidth: 800, clientHeight: 600 },
      body: { classList: { toggle() {} } },
      getElementById: (id) => {
        if (!elements.has(id)) elements.set(id, elementStub())
        return elements.get(id)
      },
      createElement: (tag) => {
        if (tag !== 'canvas') throw new Error(`unexpected createElement(${tag})`)
        return fakeCanvas(0, 0)
      }
    }
  }
  const context = vm.createContext(sandbox)
  vm.runInContext(`${recognitionSource}\n__out.decodeCanvas = decodeCanvas;`, context)
  return out
}

test('F07: QR recognition uses Chromium BarcodeDetector when present and does not need jsQR', async () => {
  const detectorOptions = []
  class FakeBarcodeDetector {
    constructor(options) {
      detectorOptions.push(options)
    }

    async detect() {
      return [{ rawValue: 'https://example.com/f07', format: 'qr_code' }]
    }
  }

  const internals = loadRecognition({ BarcodeDetector: FakeBarcodeDetector, jsQR: undefined })
  const result = await internals.decodeCanvas(fakeCanvas(600, 600))
  // The decoder returns a vm-realm object; compare its shape, not its prototype.
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { data: 'https://example.com/f07' })
  assert.deepEqual(JSON.parse(JSON.stringify(detectorOptions)), [{ formats: ['qr_code'] }])
})

test('F07: QR recognition prefers the native detector over jsQR and falls back when it rejects', async () => {
  let jsqrCalls = 0
  class RejectingBarcodeDetector {
    async detect() {
      throw new Error('unsupported frame')
    }
  }
  const fallback = loadRecognition({
    BarcodeDetector: RejectingBarcodeDetector,
    jsQR: () => {
      jsqrCalls += 1
      return { data: 'jsqr-result' }
    }
  })
  assert.deepEqual(await fallback.decodeCanvas(fakeCanvas(600, 600)), { data: 'jsqr-result' })
  assert.equal(jsqrCalls, 1)

  let preferredJsqrCalls = 0
  class WorkingBarcodeDetector {
    async detect() {
      return [{ rawValue: 'native-result' }]
    }
  }
  const preferred = loadRecognition({
    BarcodeDetector: WorkingBarcodeDetector,
    jsQR: () => {
      preferredJsqrCalls += 1
      return null
    }
  })
  const preferredResult = await preferred.decodeCanvas(fakeCanvas(600, 600))
  assert.equal(preferredResult?.data, 'native-result')
  assert.equal(preferredJsqrCalls, 0, 'jsQR must not run when the native decoder answered')
})

test('F07: the jsQR fallback yields to the main thread between candidate frames', async () => {
  const internals = loadRecognition({ BarcodeDetector: undefined, jsQR: () => null })
  const order = []
  const timer = setTimeout(() => order.push('yielded'), 0)
  try {
    assert.equal(await internals.decodeCanvas(fakeCanvas(600, 600)), null)
  } finally {
    clearTimeout(timer)
  }
  assert.ok(order.includes('yielded'), 'decodeCanvas must await a macrotask while scanning candidates')
})

// ---------------------------------------------------------------------------
// 三.7.3: native sidecar settings (the binary itself cannot run under node:test)
// ---------------------------------------------------------------------------

test('F07: the OCR sidecar uses Catmull-Rom upscaling and level-3 graph optimization', () => {
  const source = fs.readFileSync(path.join(root, 'native', 'ocr', 'src', 'main.rs'), 'utf8')
  assert.match(source, /FilterType::CatmullRom/)
  assert.doesNotMatch(source, /FilterType::Lanczos3/)
  assert.match(source, /GraphOptimizationLevel::Level3/)
  assert.doesNotMatch(source, /GraphOptimizationLevel::Level2/)
})
