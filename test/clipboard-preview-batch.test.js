'use strict'
// Mock-only regression cases for the batch thumbnail protocol: no native
// process, no Electron, no real windows. The fake service answers `thumbnail`
// with bytes so the pipeline (read -> LRU -> token -> Response) is exercised end
// to end, including the handleResource path the renderer's <img> hits.
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { createClipboardDomain, PREVIEW_CONCURRENCY, PREVIEW_TOKEN_LIMIT, PREVIEW_TTL_MS } = require('../main/domains/clipboard')
const { createThumbnailCache, DEFAULT_MAX_BYTES, DEFAULT_MAX_ENTRIES } = require('../main/services/clipboard-thumbnail-cache')

const PNG = Buffer.from('89504e470d0a1a0a', 'hex')
const uuid = (n) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`
const OPERATION = '22222222-2222-4222-8222-222222222222'
const tick = () => new Promise((resolve) => setImmediate(resolve))
const errorCode = (value) => value?.error?.code

// A tiny fake of ClipboardService: only the members the domain touches. The
// thumbnail answers are keyed by id so a test can make one id fail while its
// neighbours succeed.
function fakeService() {
  const service = new EventEmitter()
  const calls = []
  const answers = new Map()
  service.snapshot = () => ({ datasetId: 'dataset', revision: 1, itemCount: 0, pinnedCount: 0 })
  service.refresh = async () => service.snapshot()
  service.command = async (method, args = {}) => {
    calls.push({ method, args })
    if (method !== 'thumbnail') return {}
    const answer = answers.get(args.id)
    if (typeof answer === 'function') return answer(args)
    if (answer instanceof Error) throw answer
    return answer || { bytes: Buffer.from(`${args.id}:png`), value: { mime: 'image/png', byteLength: Buffer.from(`${args.id}:png`).length } }
  }
  return { service, calls, answers, thumbnails: () => calls.filter((call) => call.method === 'thumbnail') }
}

function harness() {
  const handlers = new Map()
  const listeners = new Map()
  const protocols = new Map()
  const fake = fakeService()
  let win
  const domain = createClipboardDomain({
    app: { isPackaged: false }, rootDirectory: path.resolve(__dirname, '..'), directory: 'unused',
    nativeTheme: {}, getSettings: () => ({ clipboard: { enabled: true, releaseAfterMs: 60000, language: 'en-US', theme: 'dark' } }),
    getHook: () => null, isGameModeEnabled: () => false, isMigrationInProgress: () => false,
    positionAutomationWindow() {}, dialog: {},
    screen: { getCursorScreenPoint: () => ({}), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 900 } }), getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 900 } }) },
    session: { fromPartition: () => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, protocol: { handle: (scheme, fn) => protocols.set(scheme, fn), unhandle: (scheme) => protocols.delete(scheme) } }) },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), on: (name, handler) => listeners.set(name, handler) },
    createLocalWindow: () => {
      win = new EventEmitter(); win.visible = false; win.focused = false; win.destroyed = false
      win.messages = []; win.bounds = { x: 100, y: 100, width: 480, height: 640 }; win.minimum = [380, 420]
      win.getBounds = () => ({ ...win.bounds }); win.setBounds = (value) => { win.bounds = value }
      win.getMinimumSize = () => win.minimum; win.setMinimumSize = (...value) => { win.minimum = value }
      win.setFocusable = () => {}
      win.webContents = new EventEmitter(); win.webContents.id = 1
      win.webContents.send = (channel, data) => win.messages.push({ channel, data }); win.webContents.isDestroyed = () => win.destroyed
      win.isDestroyed = () => win.destroyed; win.isVisible = () => win.visible; win.isFocused = () => win.focused
      win.getNativeWindowHandle = () => Buffer.from('3412000000000000', 'hex')
      win.loadFile = async () => {}
      win.show = () => { win.visible = true }
      win.focus = () => { win.focused = true }
      win.hide = () => { win.visible = false; win.focused = false; win.emit('blur') }
      win.destroy = () => { win.destroyed = true; win.emit('closed') }
      return win
    }
  })
  assert.equal(typeof domain.service, 'object', 'the domain exposes its service for the fakes')
  domain.service.command = fake.service.command
  domain.service.refresh = fake.service.refresh
  domain.service.snapshot = fake.service.snapshot
  const resource = (url, method = 'GET') => protocols.get('highlighter-clipboard')({ url, method })
  return {
    domain, calls: fake.calls, answers: fake.answers, thumbnails: fake.thumbnails,
    get win() { return win }, protocols, listeners,
    resource,
    async open() { domain.show(); listeners.get('clipboard:ready')({ sender: win.webContents }); await tick() },
    previews(ids) { return handlers.get('clipboard:previews')({ sender: win.webContents }, { ids }) },
    raw(channel, args) { return handlers.get(channel)({ sender: win.webContents }, args) },
    emitHistory(value = { datasetId: 'dataset', revision: 2 }) { domain.service.emit('history', value) }
  }
}

function urlOf(entry) { return new URL(entry.url) }

test('clipboard:previews rejects invalid batches with stable error codes', async () => {
  const h = harness(); await h.open()
  const cases = [
    ['non-array', { ids: 'not-an-array' }],
    ['empty', { ids: [] }],
    ['too many', { ids: Array.from({ length: 65 }, (_value, index) => uuid(index)) }],
    ['invalid uuid', { ids: ['not-a-uuid'] }],
    ['mixed valid/invalid', { ids: [uuid(1), 'nope'] }],
    ['extra key', { ids: [uuid(1)], extra: true }],
    ['missing ids', {}]
  ]
  for (const [label, args] of cases) {
    const response = await h.raw('clipboard:previews', args)
    assert.equal(response.ok, false, label)
    assert.match(errorCode(response), /^[A-Z_]{1,64}$/, label)
  }
  assert.equal((await h.raw('clipboard:previews', { ids: [] })).error.code, 'INVALID_IDS')
  assert.equal(h.thumbnails().length, 0, 'validation runs before any native read')
})

test('issued tokens survive later batches (regression lock against re-adding revokePreviews)', async () => {
  const h = harness(); await h.open()
  const first = (await h.previews([uuid(1)])).result
  assert.equal(first.length, 1); assert.ok(first[0].url)
  const second = (await h.previews([uuid(2)])).result
  const third = (await h.previews([uuid(3)])).result
  assert.ok(second[0].url && third[0].url)
  // Three separate previews() calls. The single-token design would leave only
  // the third token alive, so this assertion is what pins the new behaviour.
  const response = await h.resource(first[0].url)
  assert.equal(response.status, 200, 'the first URL still resolves after two more batches')
  assert.equal(response.headers.get('content-type'), 'image/png')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('content-security-policy'), "default-src 'none'")
  const body = Buffer.from(await response.arrayBuffer())
  assert.deepEqual(body, Buffer.from(`${uuid(1)}:png`))
  assert.equal(h.thumbnails().length, 3, 'one native read per distinct id, none at protocol time')
  // Re-reading must be served from the LRU: still three native calls.
  assert.equal((await h.resource(first[0].url)).status, 200)
  assert.equal(h.thumbnails().length, 3)
})

test('the token table is bounded and evicts the oldest token first', async () => {
  const h = harness(); await h.open()
  const urls = []
  for (let index = 1; index <= PREVIEW_TOKEN_LIMIT; index++) {
    const [entry] = (await h.previews([uuid(index)])).result
    urls.push(entry.url)
  }
  assert.equal((await h.resource(urls[0])).status, 200, 'the oldest token is still alive at the limit')
  const [overflow] = (await h.previews([uuid(PREVIEW_TOKEN_LIMIT + 1)])).result
  assert.ok(overflow.url)
  assert.equal((await h.resource(urls[0])).status, 404, 'the oldest token was evicted')
  assert.equal((await h.resource(urls[1])).status, 200, 'the next one is now the oldest and still alive')
  assert.equal((await h.resource(overflow.url)).status, 200, 'the newest token is alive')
})

test('an expired token is a 404', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] })
  const h = harness(); await h.open()
  t.mock.timers.setTime(1_000_000)
  const [entry] = (await h.previews([uuid(1)])).result
  assert.equal((await h.resource(entry.url)).status, 200)
  t.mock.timers.setTime(1_000_000 + PREVIEW_TTL_MS + 1)
  assert.equal((await h.resource(entry.url)).status, 404, 'TTL is enforced')
})

test('one failing id does not fail the batch and keeps input order', async () => {
  const h = harness(); await h.open()
  h.answers.set(uuid(2), Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' }))
  const result = (await h.previews([uuid(1), uuid(2), uuid(3)])).result
  assert.equal(result.length, 3)
  assert.deepEqual(result.map((entry) => entry.id), [uuid(1), uuid(2), uuid(3)])
  assert.ok(result[0].url)
  assert.equal(result[1].error, 'NOT_FOUND')
  assert.ok(result[2].url)
  // The successes are independently usable.
  assert.equal((await h.resource(result[0].url)).status, 200)
  assert.equal((await h.resource(result[2].url)).status, 200)
})

test('unexpected failures and oversized or mistyped payloads become per-item errors', async () => {
  const h = harness(); await h.open()
  h.answers.set(uuid(1), Object.assign(new Error('BACKEND_EXITED'), { code: 'BACKEND_EXITED' }))
  h.answers.set(uuid(2), Object.assign(new Error('BACKPRESSURE'), { code: 'BACKPRESSURE' }))
  h.answers.set(uuid(3), { bytes: Buffer.alloc(256 * 1024 + 1), value: { mime: 'image/png', byteLength: 256 * 1024 + 1 } })
  h.answers.set(uuid(4), { bytes: PNG, value: { mime: 'image/jpeg', byteLength: PNG.length } })
  h.answers.set(uuid(5), { bytes: PNG, value: { mime: 'image/png', byteLength: PNG.length + 1 } })
  const result = (await h.previews([uuid(1), uuid(2), uuid(3), uuid(4), uuid(5)])).result
  assert.deepEqual(result.map((entry) => entry.error), ['UNSUPPORTED', 'BACKPRESSURE', 'UNSUPPORTED', 'UNSUPPORTED', 'UNSUPPORTED'])
  assert.equal(result.every((entry) => entry.url === undefined), true, 'a rejected item never gets a URL')
})

test('a hidden window answers WINDOW_NOT_VISIBLE per item instead of throwing', async () => {
  const h = harness(); await h.open()
  h.win.visible = false
  const response = await h.previews([uuid(1), uuid(2)])
  assert.equal(response.ok, true, 'the batch still succeeds')
  assert.deepEqual(response.result, [
    { id: uuid(1), error: 'WINDOW_NOT_VISIBLE' },
    { id: uuid(2), error: 'WINDOW_NOT_VISIBLE' }
  ])
  assert.equal(h.thumbnails().length, 0, 'a hidden panel does not pay for native reads')
})

test('the concurrency pool stays below the native backpressure limit', () => {
  assert.equal(PREVIEW_CONCURRENCY, 8)
  assert.ok(PREVIEW_CONCURRENCY < 16, 'ClipboardService rejects with BACKPRESSURE at pending.size >= 16')
  assert.ok(PREVIEW_TOKEN_LIMIT >= 16, 'at least one visible screen of tiles must fit')
  assert.equal(PREVIEW_TOKEN_LIMIT, 128)
  assert.equal(PREVIEW_TTL_MS, 300000)
  // Negative control: PREVIEW_CONCURRENCY really is the pool size.
  assert.ok(Number.isInteger(PREVIEW_CONCURRENCY) && PREVIEW_CONCURRENCY > 0)
})

test('the pool never exceeds its limit and coalesces duplicate ids', async () => {
  const h = harness(); await h.open()
  let inFlight = 0; let peak = 0
  const slow = async () => {
    inFlight++; peak = Math.max(peak, inFlight)
    try { await new Promise((resolve) => setImmediate(resolve)); return { bytes: PNG, value: { mime: 'image/png', byteLength: PNG.length } } }
    finally { inFlight-- }
  }
  // Distinct ids: the result is ordered like the (deduplicated) input and the
  // worker pool never runs more than PREVIEW_CONCURRENCY reads at once.
  for (let index = 1; index <= 20; index++) h.answers.set(uuid(index), slow)
  const distinct = (await h.previews(Array.from({ length: 20 }, (_value, index) => uuid(index + 1)))).result
  assert.equal(distinct.length, 20)
  assert.deepEqual(distinct.map((entry) => entry.id), Array.from({ length: 20 }, (_value, index) => uuid(index + 1)))
  assert.equal(distinct.every((entry) => entry.url), true)
  assert.equal(h.thumbnails().length, 20, 'one native read per distinct id')
  assert.ok(peak <= PREVIEW_CONCURRENCY, `peak concurrency ${peak} must not exceed ${PREVIEW_CONCURRENCY}`)
  assert.ok(peak > 1, 'the pool actually runs work in parallel')

  // Duplicate ids collapse to a single native read, but the RESULT stays aligned
  // with the caller's input: the renderer pairs results to mounted tiles by
  // index, so returning the deduplicated list would mis-assign every URL after
  // the first repeat.
  let reads = 0
  h.answers.set(uuid(99), async () => { reads++; await new Promise((resolve) => setImmediate(resolve)); return { bytes: PNG, value: { mime: 'image/png', byteLength: PNG.length } } })
  const repeated = (await h.previews(Array.from({ length: 20 }, () => uuid(99)))).result
  assert.equal(repeated.length, 20, 'one result per requested id, repeats included')
  assert.equal(repeated.every((entry) => entry.id === uuid(99)), true, 'every entry maps back to the repeated id')
  assert.equal(repeated.every((entry) => typeof entry.url === 'string' && entry.url.length > 0), true, 'each repeat still gets a usable URL')
  assert.equal(reads, 1, 'duplicate ids coalesce into one native read')
})

test('history revision changes clear the byte cache but keep issued tokens alive', async () => {
  const h = harness(); await h.open()
  const [entry] = (await h.previews([uuid(1)])).result
  assert.equal(h.thumbnails().length, 1)
  h.emitHistory()
  // The LRU is empty again, so the protocol request has to go back to native.
  // That is exactly what makes a natively-pruned (deleted) id answer NOT_FOUND.
  const response = await h.resource(entry.url)
  assert.equal(response.status, 200)
  assert.equal(h.thumbnails().length, 2, 'a cache miss after history fell through to a native read')
  // The token itself survived: no 404 for a URL that was issued before history
  // changed. Tokens are only revoked by hide/release/delete/commit-clear.
  assert.ok(h.win.messages.some((value) => value.channel === 'clipboard:history-changed'))
})

test('a history-cleared cache turns a natively deleted id into a 404', async () => {
  const h = harness(); await h.open()
  const [entry] = (await h.previews([uuid(1)])).result
  assert.equal((await h.resource(entry.url)).status, 200)
  h.emitHistory()
  // Simulate the native retention pass having removed the record.
  h.answers.set(uuid(1), Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' }))
  assert.equal((await h.resource(entry.url)).status, 404, 'the deleted thumbnail is no longer readable from cache')
  // And the token still exists, so the 404 came from the native read, not from
  // token eviction: a fresh batch for a live id keeps working.
  const [fresh] = (await h.previews([uuid(2)])).result
  assert.equal((await h.resource(fresh.url)).status, 200)
})

test('hide revokes the byte cache and the tokens; delete and commit-clear keep clearing', async () => {
  const h = harness(); await h.open()
  const [entry] = (await h.previews([uuid(1)])).result
  assert.equal((await h.resource(entry.url)).status, 200)
  h.domain.hide()
  assert.equal((await h.resource(entry.url)).status, 404, 'hide still revokes every token')
  assert.deepEqual(h.domain.thumbnails.size(), { entries: 0, bytes: 0 }, 'hide also drops the byte cache')

  // delete and commit-clear still go through revokePreviews(), which now clears
  // both tables. A delete needs no backend round trip for the cache assertion.
  await h.open()
  const [live] = (await h.previews([uuid(2)])).result
  assert.equal((await h.resource(live.url)).status, 200)
  const deleted = await h.raw('clipboard:delete', { ids: [uuid(2)], operationId: OPERATION })
  assert.equal(deleted.ok, true)
  assert.deepEqual(h.domain.thumbnails.size(), { entries: 0, bytes: 0 }, 'delete clears the byte cache')
  assert.equal((await h.resource(live.url)).status, 404, 'delete revokes the tokens too')
})

test('protocol requests keep every pre-existing rejection', async () => {
  const h = harness(); await h.open()
  const [entry] = (await h.previews([uuid(1)])).result
  const base = entry.url
  assert.equal((await h.resource(base, 'POST')).status, 404, 'GET only')
  assert.equal((await h.resource('highlighter-clipboard://other/abc123')).status, 404, 'hostname must be preview')
  assert.equal((await h.resource(`${base}?x=1`)).status, 404, 'no query')
  assert.equal((await h.resource(`${base}#frag`)).status, 404, 'no hash')
  assert.equal((await h.resource('highlighter-clipboard://preview/not-a-token')).status, 404, 'unknown token')
  assert.equal((await h.resource('not a url')).status, 404, 'unparseable url')
  assert.equal((await h.resource(base)).status, 200, 'the untouched URL still works')
})

test('the protocol re-checks visibility after the await (TOCTOU)', async () => {
  const h = harness(); await h.open()
  // Cache the bytes normally first, then force the protocol path to take the
  // cache-miss branch so it has to await a native read: the window hides while
  // that read is in flight, and the post-await re-check must still refuse.
  const [entry] = (await h.previews([uuid(1)])).result
  assert.ok(entry.url)
  h.domain.thumbnails.clear()
  let release; const gate = new Promise((resolve) => { release = resolve })
  h.answers.set(uuid(1), async () => { await gate; return { bytes: PNG, value: { mime: 'image/png', byteLength: PNG.length } } })
  const pending = h.resource(entry.url)
  await tick() // let handleResource reach the awaited native read
  h.win.visible = false
  release()
  assert.equal((await pending).status, 404, 'hiding while the native read is in flight must not leak bytes')
})

test('owner and generation are enforced on the protocol path', async () => {
  const h = harness(); await h.open()
  const [entry] = (await h.previews([uuid(1)])).result
  // A different webContents id is not the owner.
  const originalId = h.win.webContents.id
  h.win.webContents.id = 99
  assert.equal((await h.resource(entry.url)).status, 404)
  h.win.webContents.id = originalId
  assert.equal((await h.resource(entry.url)).status, 200)
  // A hidden window invalidates immediately, without waiting for the TTL.
  h.win.visible = false
  assert.equal((await h.resource(entry.url)).status, 404)
  h.win.visible = true
  h.domain.hide()
  assert.equal((await h.resource(entry.url)).status, 404, 'a new generation revokes old tokens')
})

test('the renderer-facing bridge method is exposed by the dedicated preload', () => {
  const fs = require('node:fs')
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload-clipboard.js'), 'utf8')
  assert.match(preload, /previews:\s*\(ids\)\s*=>\s*ipcRenderer\.invoke\('clipboard:previews',\s*\{\s*ids\s*\}\)/)
  assert.equal(preload.includes('clipboard:preview\''), false, 'the plural channel replaced the singular one')
})

test('thumbnail cache: hit, miss, recency refresh, byte eviction, entry eviction, delete and clear', () => {
  const cache = createThumbnailCache({ maxBytes: 10, maxEntries: 3 })
  assert.deepEqual(cache.size(), { entries: 0, bytes: 0 })
  assert.equal(cache.get('a'), undefined, 'miss')

  const body = (text) => Buffer.from(text)
  cache.set('a', { mime: 'image/png', bytes: body('aa') })
  cache.set('b', { mime: 'image/png', bytes: body('bb') })
  assert.deepEqual(cache.size(), { entries: 2, bytes: 4 })
  assert.equal(cache.get('a').mime, 'image/png', 'hit returns the stored value')
  assert.deepEqual(cache.get('a').bytes, body('aa'))

  // get('a') must refresh recency, so the entry cap evicts 'b' and not 'a'.
  cache.set('c', { mime: 'image/png', bytes: body('cc') })
  cache.set('d', { mime: 'image/png', bytes: body('dd') })
  assert.equal(cache.get('b'), undefined, 'entry cap evicted the least recently used (b, not a)')
  assert.ok(cache.get('a'), 'the recently read entry survived')
  assert.deepEqual(cache.size(), { entries: 3, bytes: 6 })

  // Byte cap: two 4-byte entries fit in 10 bytes, a third pushes the oldest out.
  const bytes = createThumbnailCache({ maxBytes: 10, maxEntries: 100 })
  bytes.set('x', { mime: 'image/png', bytes: body('xxxx') })
  bytes.set('y', { mime: 'image/png', bytes: body('yyyy') })
  bytes.set('z', { mime: 'image/png', bytes: body('zzzz') })
  assert.deepEqual(bytes.size(), { entries: 2, bytes: 8 }, 'byte cap evicted the oldest entry')
  assert.equal(bytes.get('x'), undefined)
  assert.ok(bytes.get('y') && bytes.get('z'))

  // Overwriting an id replaces rather than accumulates.
  bytes.set('y', { mime: 'image/png', bytes: body('y') })
  assert.deepEqual(bytes.size(), { entries: 2, bytes: 5 })

  assert.equal(bytes.delete('y'), true)
  assert.equal(bytes.delete('y'), false, 'deleting twice reports a miss')
  assert.deepEqual(bytes.size(), { entries: 1, bytes: 4 })
  bytes.clear()
  assert.deepEqual(bytes.size(), { entries: 0, bytes: 0 })

  // An entry larger than the whole budget evicts everything, including itself.
  const tiny = createThumbnailCache({ maxBytes: 4, maxEntries: 4 })
  tiny.set('big', { mime: 'image/png', bytes: body('too-big') })
  assert.deepEqual(tiny.size(), { entries: 0, bytes: 0 })

  assert.throws(() => cache.set('x', { mime: 'image/png', bytes: 'not-a-buffer' }), /Buffer/)
  assert.throws(() => cache.set('x', { bytes: body('a') }), /mime/)
  assert.equal(createThumbnailCache().size().entries, 0)
  assert.equal(DEFAULT_MAX_BYTES, 8 * 1024 * 1024)
  assert.equal(DEFAULT_MAX_ENTRIES, 128)
  const defaults = createThumbnailCache()
  assert.ok(defaults.size)
})

test('thumbnail cache defaults bound a full screen of thumbnails', () => {
  const cache = createThumbnailCache()
  // 16 visible tiles of a realistic 60 KiB thumbnail fit comfortably, and 128
  // entries of the worst-case 192 KiB stay under the 8 MiB byte cap.
  const sample = Buffer.alloc(60 * 1024)
  for (let index = 0; index < 16; index++) cache.set(uuid(index), { mime: 'image/png', bytes: sample })
  assert.deepEqual(cache.size(), { entries: 16, bytes: 16 * 60 * 1024 })
  for (let index = 0; index < 112; index++) cache.set(`filler-${index}`, { mime: 'image/png', bytes: sample })
  const size = cache.size()
  assert.ok(size.entries <= DEFAULT_MAX_ENTRIES)
  assert.ok(size.bytes <= DEFAULT_MAX_BYTES)
})

test('a cache invalidation during an in-flight read is not undone by the late response', async () => {
  // A hide/history/delete clears the LRU. If a native read that started before
  // the clear writes its bytes afterwards, the entry the invalidation removed
  // comes back - for a deleted record that means its thumbnail stays readable.
  const h = harness(); await h.open()
  const [entry] = (await h.previews([uuid(1)])).result
  assert.ok(entry.url)
  h.domain.thumbnails.clear()
  let release; const gate = new Promise((resolve) => { release = resolve })
  h.answers.set(uuid(1), async () => { await gate; return { bytes: PNG, value: { mime: 'image/png', byteLength: PNG.length } } })
  const pending = h.resource(entry.url)
  await tick() // the handler is now awaiting the native read
  h.emitHistory() // invalidate the cache while that read is in flight
  const cacheAfterInvalidate = h.domain.thumbnails.size()
  assert.deepEqual(cacheAfterInvalidate, { entries: 0, bytes: 0 }, 'the invalidation emptied the cache')
  release()
  const response = await pending
  assert.equal(response.status, 200, 'the request itself may still serve its own bytes')
  assert.deepEqual(h.domain.thumbnails.size(), { entries: 0, bytes: 0 }, 'the late response must not repopulate the cleared cache')
})

test('a token that expires while the native read is in flight answers 404', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] })
  const h = harness(); await h.open()
  t.mock.timers.setTime(1_000_000)
  const [entry] = (await h.previews([uuid(1)])).result
  assert.ok(entry.url)
  h.domain.thumbnails.clear()
  let release; const gate = new Promise((resolve) => { release = resolve })
  h.answers.set(uuid(1), async () => { await gate; return { bytes: PNG, value: { mime: 'image/png', byteLength: PNG.length } } })
  const pending = h.resource(entry.url)
  await tick()
  // Expire the token while the read is in flight: the post-await re-check has to
  // include the TTL, not just visibility and ownership.
  t.mock.timers.setTime(1_000_000 + PREVIEW_TTL_MS + 1)
  release()
  assert.equal((await pending).status, 404, 'an expired token must not serve bytes read after its TTL')
})
