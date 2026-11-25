// C04 (docs/reviews/2026-11-24-windows-product-architecture-review.md): spilled pin pixels are
// written and read off the main thread through one bounded queue, and a released window's
// late read must never resurrect its payload.
const test = require('node:test')
const assert = require('node:assert/strict')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const { createFileIo, createPinImageStore } = require('../main/services/pin-image-store')

const MIME = 'image/png'

async function makeRoot(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'highlighter-pin-store-test-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {}))
  return root
}

async function assertEmptyDirectory(directory) {
  assert.deepEqual(await fsp.readdir(directory), [])
}

function bytesOf(length, seed = 0) {
  const bytes = Buffer.allocUnsafe(length)
  for (let index = 0; index < length; index += 1) bytes[index] = (index * 31 + seed) & 0xff
  return bytes
}

function diskError(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code })
}

// Wraps the real async fs so a test can observe operation order, measure the
// maximum number of overlapping operations and inject disk failures. The pixel
// bytes never travel through this wrapper: it only sees the handle, which is the
// property "unlink the name before writing pixels" relies on.
function createTrackedIo({ delayMs = 0, failOpen = null, failWrite = null, failRead = null, blockWrites = 0 } = {}) {
  const real = createFileIo()
  const ops = []
  let active = 0
  let maxActive = 0
  let readCalls = 0
  let writeCalls = 0
  const blocked = []
  const releaseBlocked = () => {
    const pending = blocked.splice(0)
    for (const resolve of pending) resolve()
  }

  async function track(name, detail, run) {
    ops.push({ name, ...detail })
    active += 1
    if (active > maxActive) maxActive = active
    try {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
      return await run()
    } finally {
      active -= 1
    }
  }

  const io = {
    mkdtemp: (prefix) => track('mkdtemp', { prefix }, () => real.mkdtemp(prefix)),
    open: (file, flags, mode) => track('open', { file, flags, mode }, () => {
      if (failOpen) throw failOpen
      return real.open(file, flags, mode)
    }),
    unlink: (file) => track('unlink', { file }, () => real.unlink(file)),
    rmdir: (directory) => track('rmdir', { directory }, () => real.rmdir(directory)),
    write: (handle, buffer, offset, length, position) => track('write', { length, position }, async () => {
      writeCalls += 1
      if (blockWrites > 0 && writeCalls <= blockWrites) {
        // A hung disk: the write stays open until the test releases it.
        await new Promise((resolve) => blocked.push(resolve))
      }
      if (failWrite) throw failWrite
      return real.write(handle, buffer, offset, length, position)
    }),
    read: (handle, buffer, offset, length, position) => track('read', { length, position }, () => {
      readCalls += 1
      const failure = typeof failRead === 'function' ? failRead(readCalls) : null
      if (failure) throw failure
      return real.read(handle, buffer, offset, length, position)
    }),
    close: (handle) => track('close', {}, () => real.close(handle))
  }

  return {
    io,
    ops,
    reset() { maxActive = 0 },
    releaseBlocked,
    get maxActive() { return maxActive },
    get blockedCount() { return blocked.length }
  }
}

test('an over-budget pin spills to an unnamed file and reads back its pixels', async (t) => {
  const root = await makeRoot(t)
  const tracked = createTrackedIo()
  const store = createPinImageStore({ memoryBudget: 1, tmpdir: root, io: tracked.io })
  const payload = bytesOf(64, 7)

  const id = store.add({ bytes: payload, mime: MIME })

  // add() only enqueues the spill: the pixels already left the resident set.
  assert.equal(store.stats().assets, 1)
  assert.equal(store.stats().resident, 0)
  assert.equal(store.stats().spilled, 1)

  await store.whenIdle()
  assert.equal(store.stats().handles, 1)

  const names = tracked.ops.map((operation) => operation.name)
  assert.equal(names.includes('open'), true)
  assert.equal(names.includes('unlink'), true)
  assert.equal(names.includes('write'), true)
  // Empty file unlinked before any pixel is written: the image never exists
  // under a temp name another process could open.
  assert.ok(names.indexOf('unlink') < names.indexOf('write'))

  const opened = tracked.ops.find((operation) => operation.name === 'open')
  assert.equal(opened.flags, 'wx+')
  assert.equal(opened.mode, 0o600)
  const unlinked = tracked.ops.find((operation) => operation.name === 'unlink')
  assert.equal(path.basename(unlinked.file), 'image')
  assert.equal(path.dirname(path.dirname(unlinked.file)), root)
  // write() receives only the descriptor, never a path.
  for (const operation of tracked.ops.filter((entry) => entry.name === 'write')) {
    assert.equal(Object.hasOwn(operation, 'file'), false)
  }
  // The temporary directory is gone even while the descriptor is alive, and the
  // pixels are still readable through that descriptor.
  await assertEmptyDirectory(root)
  assert.deepEqual((await store.read(id)).bytes, payload)
  assert.equal((await store.read(id)).mime, MIME)

  store.release(id)
  await store.whenIdle()
  assert.equal(store.stats().assets, 0)
  assert.equal(store.stats().handles, 0)
  assert.equal(store.stats().spilled, 0)
  await assert.rejects(store.read(id), /已释放/)
})

test('spill writes and reads share one queue with a concurrency of at most two', async (t) => {
  const root = await makeRoot(t)
  const tracked = createTrackedIo({ delayMs: 5 })
  const store = createPinImageStore({ memoryBudget: 0, tmpdir: root, io: tracked.io })
  const payloads = Array.from({ length: 6 }, (_, index) => bytesOf(48, index))
  const ids = payloads.map((bytes) => store.add({ bytes, mime: MIME }))

  await store.whenIdle()
  assert.equal(tracked.maxActive, 2)
  assert.equal(store.stats().handles, 6)

  tracked.reset()
  const results = await Promise.all(ids.map((id) => store.read(id)))
  assert.equal(tracked.maxActive, 2)
  results.forEach((result, index) => assert.deepEqual(result.bytes, payloads[index]))

  for (const id of ids) store.release(id)
  await store.whenIdle()
  assert.equal(store.stats().handles, 0)
  assert.equal(store.stats().assets, 0)
  await assertEmptyDirectory(root)
})

test('releasing a pin while its spill write is in flight leaks neither a handle nor a file', async (t) => {
  const root = await makeRoot(t)
  const tracked = createTrackedIo({ delayMs: 20 })
  const store = createPinImageStore({ memoryBudget: 0, tmpdir: root, io: tracked.io })
  const id = store.add({ bytes: bytesOf(32, 3), mime: MIME })

  // The window closes before the write has completed.
  store.release(id)
  await assert.rejects(store.read(id), /已释放/)

  await store.whenIdle()
  assert.deepEqual(
    { assets: store.stats().assets, handles: store.stats().handles, spilled: store.stats().spilled },
    { assets: 0, handles: 0, spilled: 0 }
  )
  await assertEmptyDirectory(root)
})

test('a write still queued when its pin is released never touches the disk', async (t) => {
  const root = await makeRoot(t)
  const tracked = createTrackedIo({ delayMs: 10 })
  const store = createPinImageStore({ memoryBudget: 0, concurrency: 1, tmpdir: root, io: tracked.io })
  const first = store.add({ bytes: bytesOf(16, 1), mime: MIME })
  const second = store.add({ bytes: bytesOf(16, 2), mime: MIME })

  // The second write is still queued behind the first: releasing its pin drops
  // the queued work instead of writing pixels for a closed window.
  store.release(second)
  await store.whenIdle()
  // Only the first pin ever opened a spill file; the queued one was dropped.
  assert.equal(tracked.ops.filter((operation) => operation.name === 'open').length, 1)
  assert.deepEqual((await store.read(first)).bytes, bytesOf(16, 1))

  store.release(first)
  await store.whenIdle()
  assert.equal(store.stats().handles, 0)
  assert.equal(store.stats().assets, 0)
  await assertEmptyDirectory(root)
})

test('spill I/O yields the main thread and reads resolve to the stored bytes', async (t) => {
  const root = await makeRoot(t)
  const tracked = createTrackedIo({ delayMs: 15 })
  const store = createPinImageStore({ memoryBudget: 0, tmpdir: root, io: tracked.io })
  const payload = bytesOf(40, 11)
  const id = store.add({ bytes: payload, mime: MIME })

  // A tick scheduled right after add() runs while the write is still queued:
  // the caller (and the tray/hotkey loops behind it) is not blocked.
  assert.equal(await new Promise((resolve) => setImmediate(() => resolve('tick'))), 'tick')
  assert.equal(store.stats().spilled, 1)

  const pending = store.read(id)
  assert.equal(typeof pending.then, 'function')
  const { bytes, mime } = await pending
  assert.deepEqual(bytes, payload)
  assert.equal(mime, MIME)

  store.release(id)
  await store.whenIdle()
})

test('an ENOSPC spill write degrades to resident pixels and recovers', async (t) => {
  const root = await makeRoot(t)
  const failures = []
  const tracked = createTrackedIo({ failWrite: diskError('ENOSPC', 'no space left on device') })
  const store = createPinImageStore({
    memoryBudget: 0,
    tmpdir: root,
    io: tracked.io,
    onError: (error, info) => failures.push({ code: error.code, phase: info.phase })
  })
  const payload = bytesOf(64, 5)
  const id = store.add({ bytes: payload, mime: MIME })

  await store.whenIdle()
  assert.equal(store.stats().spillFailures, 1)
  assert.equal(store.stats().handles, 0)
  assert.equal(store.stats().spilled, 0)
  assert.deepEqual(failures, [{ code: 'ENOSPC', phase: 'spill-write' }])
  // The pin still works: the bytes were already in hand.
  assert.deepEqual((await store.read(id)).bytes, payload)
  assert.equal(store.stats().resident, payload.length)

  store.release(id)
  await store.whenIdle()
  assert.equal(store.stats().resident, 0)
  assert.equal(store.stats().assets, 0)
  await assertEmptyDirectory(root)
})

test('a read-only spill target (EROFS) also degrades to resident pixels', async (t) => {
  const root = await makeRoot(t)
  const tracked = createTrackedIo({ failOpen: diskError('EROFS', 'read-only file system') })
  const store = createPinImageStore({ memoryBudget: 0, tmpdir: root, io: tracked.io })
  const payload = bytesOf(32, 13)
  const id = store.add({ bytes: payload, mime: MIME })

  await store.whenIdle()
  assert.equal(store.stats().spillFailures, 1)
  assert.equal(store.stats().handles, 0)
  assert.deepEqual((await store.read(id)).bytes, payload)
  await assertEmptyDirectory(root)
})

test('a failed spill read rejects and the store stays usable', async (t) => {
  const root = await makeRoot(t)
  const tracked = createTrackedIo({ failRead: (call) => (call === 1 ? diskError('EIO', 'i/o error') : null) })
  const store = createPinImageStore({ memoryBudget: 0, tmpdir: root, io: tracked.io })
  const payload = bytesOf(32, 17)
  const id = store.add({ bytes: payload, mime: MIME })

  await store.whenIdle()
  assert.equal(store.stats().handles, 1)
  await assert.rejects(store.read(id), (error) => error.code === 'EIO')
  // The failed read released its slot and a later read is served normally.
  assert.deepEqual((await store.read(id)).bytes, payload)

  store.release(id)
  await store.whenIdle()
  assert.equal(store.stats().handles, 0)
  await assertEmptyDirectory(root)
})

test('dispose cancels queued spill work and closes every descriptor', async (t) => {
  const root = await makeRoot(t)
  const tracked = createTrackedIo({ delayMs: 20 })
  const store = createPinImageStore({ memoryBudget: 0, concurrency: 1, tmpdir: root, io: tracked.io })
  const ids = Array.from({ length: 3 }, (_, index) => store.add({ bytes: bytesOf(24, index), mime: MIME }))

  assert.equal(store.dispose(), true)
  assert.equal(store.dispose(), false)
  assert.equal(store.stats().closed, true)

  await store.whenIdle()
  assert.equal(store.stats().handles, 0)
  assert.equal(store.stats().assets, 0)
  for (const id of ids) await assert.rejects(store.read(id), /已释放/)
  assert.throws(() => store.add({ bytes: Buffer.from([1]), mime: MIME }), /已关闭/)
  await assertEmptyDirectory(root)
})

test('release is reference counted and the last reference closes the spill handle', async (t) => {
  const root = await makeRoot(t)
  const tracked = createTrackedIo()
  const store = createPinImageStore({ memoryBudget: 0, tmpdir: root, io: tracked.io })
  const payload = bytesOf(24, 19)
  const id = store.add({ bytes: payload, mime: MIME })

  assert.equal(store.retain(id), true)
  await store.whenIdle()
  assert.equal(store.stats().handles, 1)

  store.release(id)
  assert.equal(store.stats().assets, 1)
  assert.deepEqual((await store.read(id)).bytes, payload)

  store.release(id)
  await store.whenIdle()
  assert.equal(store.stats().assets, 0)
  assert.equal(store.stats().handles, 0)
  assert.equal(store.retain(id), false)
  await assert.rejects(store.read(id), /已释放/)
  await assertEmptyDirectory(root)
})

test('pins within the memory budget stay resident and release back to the baseline', async (t) => {
  const root = await makeRoot(t)
  const tracked = createTrackedIo()
  const store = createPinImageStore({ memoryBudget: 1024, tmpdir: root, io: tracked.io })
  const payload = bytesOf(256, 23)
  const id = store.add({ bytes: payload, mime: MIME })

  assert.equal(store.stats().resident, payload.length)
  assert.equal(store.stats().spilled, 0)
  assert.equal(store.stats().handles, 0)
  assert.deepEqual(tracked.ops, [])
  assert.deepEqual((await store.read(id)).bytes, payload)

  store.release(id)
  await store.whenIdle()
  assert.equal(store.stats().assets, 0)
  assert.equal(store.stats().resident, 0)
  assert.equal(store.stats().handles, 0)
})

// ---------------------------------------------------------------------------
// C04 (plan item 16): the queue must not keep released pixels alive.
// ---------------------------------------------------------------------------

async function waitFor(predicate, timeoutMs = 5000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((resolve) => setImmediate(resolve))
  }
}

function plainBytes(length, seed = 0) {
  const bytes = Buffer.allocUnsafe(length)
  bytes.fill((seed + 1) & 0xff)
  return bytes
}

test('C04 (16): releasing 100 queued spills drops their pixels and jobs immediately', async (t) => {
  const root = await makeRoot(t)
  const tracked = createTrackedIo({ blockWrites: 2 })
  const store = createPinImageStore({
    memoryBudget: 0,
    concurrency: 2,
    tmpdir: root,
    io: tracked.io
  })
  const size = 1024 * 1024
  const payloads = Array.from({ length: 100 }, (_, index) => plainBytes(size, index))
  const ids = payloads.map((bytes) => store.add({ bytes, mime: MIME }))
  // The queue starts two jobs immediately, but their mkdtemp/open/unlink steps are async:
  // wait until both writes are really open before releasing.
  await waitFor(() => tracked.blockedCount === 2)

  // Two writes are in flight (blocked), 98 are queued and still hold their buffers.
  let stats = store.stats()
  assert.equal(stats.assets, 100)
  assert.equal(stats.residentBytes, 0)
  assert.equal(stats.inFlightTasks, 2)
  assert.equal(stats.queuedTasks, 98)
  assert.equal(stats.inFlightBytes, 2 * size)
  assert.equal(stats.queuedBytes, 98 * size)

  for (const id of ids) store.release(id)

  // IMMEDIATELY: every queued job is gone and its buffer is unreachable; only the two
  // in-flight writes may still hold (and be charged for) their pixels.
  stats = store.stats()
  assert.equal(stats.assets, 0)
  assert.equal(stats.queuedTasks, 0, 'the queued jobs left the queue at release time')
  assert.equal(stats.queuedBytes, 0, 'no released buffer is still counted in the queue')
  assert.equal(stats.inFlightTasks, 2, 'only the two started writes remain')
  assert.equal(stats.inFlightBytes, 2 * size, 'the in-flight pixels are still charged until they finish')

  // Unblock the disk: the late handles can only be closed, never attached.
  tracked.releaseBlocked()
  await store.whenIdle()
  stats = store.stats()
  assert.equal(stats.assets, 0)
  assert.equal(stats.handles, 0)
  assert.equal(stats.inFlightBytes, 0)
  assert.equal(stats.inFlightTasks, 0)
  await assertEmptyDirectory(root)
})

test('C04 (16): the queue has a byte cap and refuses before allocating another buffer', async (t) => {
  const root = await makeRoot(t)
  const tracked = createTrackedIo({ blockWrites: 2 })
  const store = createPinImageStore({
    memoryBudget: 0,
    concurrency: 2,
    queuedBytesLimit: 3 * 1024 * 1024,
    tmpdir: root,
    io: tracked.io
  })
  const size = 1024 * 1024
  const first = store.add({ bytes: plainBytes(size), mime: MIME })
  assert.equal(typeof first, 'number')
  store.add({ bytes: plainBytes(size), mime: MIME })
  await waitFor(() => tracked.blockedCount === 2)
  // Both in-flight slots are taken, so every further add lands in the QUEUE. Keep adding
  // until the byte cap refuses one: the refusal must arrive before the buffer is retained.
  let refused = null
  for (let index = 0; index < 5 && !refused; index += 1) {
    try {
      store.add({ bytes: plainBytes(size), mime: MIME })
    } catch (error) {
      refused = error
    }
  }
  assert.ok(refused, 'the queue cap must refuse before accepting unbounded work')
  assert.equal(refused.code, 'image-store-full')
  assert.equal(refused.retryable, true)
  assert.ok(store.stats().queuedBytes <= store.stats().limits.queuedBytesLimit)
  tracked.releaseBlocked()
  await store.whenIdle()
  store.dispose()
})

test('C04 (16): one 4K-scale image is admitted through the single-asset quota', async (t) => {
  const root = await makeRoot(t)
  const tracked = createTrackedIo()
  const store = createPinImageStore({ memoryBudget: 32 * 1024 * 1024, tmpdir: root, io: tracked.io })
  // 40 MiB is above the resident target but under the documented 64 MiB single quota.
  const big = plainBytes(40 * 1024 * 1024)
  const id = store.add({ bytes: big, mime: MIME })
  assert.equal(typeof id, 'number')
  assert.equal(store.stats().residentBytes, 0, 'it immediately leaves the resident set')
  await store.whenIdle()
  assert.deepEqual((await store.read(id)).bytes, big)
  // Beyond the single-asset quota is refused as unsupported (not retryable).
  assert.throws(
    () => store.add({ bytes: plainBytes(65 * 1024 * 1024), mime: MIME }),
    (error) => error.code === 'image-too-large' && error.retryable === false
  )
  store.dispose()
})

test('C04 (16): a disk-full spill keeps the original pixels and reports the fallback bytes', async (t) => {
  const root = await makeRoot(t)
  const tracked = createTrackedIo({ failWrite: diskError('ENOSPC', 'no space left on device') })
  const store = createPinImageStore({ memoryBudget: 0, tmpdir: root, io: tracked.io })
  const payload = plainBytes(64 * 1024, 9)
  const id = store.add({ bytes: payload, mime: MIME })
  await store.whenIdle()
  const stats = store.stats()
  assert.equal(stats.spillFailures, 1)
  assert.equal(stats.failedFallbackBytes, payload.length)
  assert.equal(stats.residentBytes, payload.length, 'the original buffer became the resident copy')
  assert.deepEqual((await store.read(id)).bytes, payload)
  // The pin was not dropped because the disk refused the spill.
  store.release(id)
  await store.whenIdle()
  assert.equal(store.stats().assets, 0)
})

test('C04 (16): an in-flight spill released before it started never reaches the disk', async (t) => {
  const root = await makeRoot(t)
  const tracked = createTrackedIo({ blockWrites: 1 })
  const store = createPinImageStore({ memoryBudget: 0, concurrency: 1, tmpdir: root, io: tracked.io })
  const blocked = store.add({ bytes: plainBytes(4096, 1), mime: MIME })
  const queued = store.add({ bytes: plainBytes(4096, 2), mime: MIME })
  await waitFor(() => tracked.blockedCount === 1)
  assert.equal(store.stats().queuedTasks, 1)
  // Release the QUEUED one: no write for it may ever be started.
  store.release(queued)
  assert.equal(store.stats().queuedTasks, 0)
  const writesBefore = tracked.ops.filter((operation) => operation.name === 'write').length
  tracked.releaseBlocked()
  await store.whenIdle()
  const writesAfter = tracked.ops.filter((operation) => operation.name === 'write').length
  assert.equal(writesAfter, writesBefore, 'the cancelled job never wrote')
  assert.deepEqual((await store.read(blocked)).bytes, plainBytes(4096, 1))
  store.release(blocked)
  await store.whenIdle()
})

test('C04 (16): a read queued behind a release rejects without handing pixels back', async (t) => {
  const root = await makeRoot(t)
  const tracked = createTrackedIo()
  const store = createPinImageStore({ memoryBudget: 0, tmpdir: root, io: tracked.io })
  const id = store.add({ bytes: plainBytes(8192, 3), mime: MIME })
  await store.whenIdle()
  const pending = store.read(id)
  store.release(id)
  await assert.rejects(pending, /已释放/)
  await store.whenIdle()
  assert.equal(store.stats().handles, 0)
})

test('C04 (16): the report separates resident, queued, in-flight and fallback bytes', async (t) => {
  const root = await makeRoot(t)
  const tracked = createTrackedIo({ blockWrites: 1 })
  const store = createPinImageStore({ memoryBudget: 1024, concurrency: 1, tmpdir: root, io: tracked.io })
  const resident = plainBytes(512, 4)
  const residentId = store.add({ bytes: resident, mime: MIME })
  const spill = plainBytes(2048, 5)
  const spillId = store.add({ bytes: spill, mime: MIME })
  const secondSpill = plainBytes(2048, 6)
  const secondId = store.add({ bytes: secondSpill, mime: MIME })
  await waitFor(() => tracked.blockedCount === 1)
  const stats = store.stats()
  // One buffer in exactly one bucket.
  assert.equal(stats.residentBytes, 512)
  assert.equal(stats.inFlightBytes, 2048)
  assert.equal(stats.queuedBytes, 2048)
  assert.equal(stats.limits.memoryBudget, 1024)
  assert.equal(stats.limits.concurrency, 1)
  tracked.releaseBlocked()
  await store.whenIdle()
  assert.deepEqual((await store.read(residentId)).bytes, resident)
  assert.deepEqual((await store.read(spillId)).bytes, spill)
  assert.deepEqual((await store.read(secondId)).bytes, secondSpill)
  for (const id of [residentId, spillId, secondId]) store.release(id)
  await store.whenIdle()
  const after = store.stats()
  assert.equal(after.residentBytes, 0)
  assert.equal(after.queuedBytes, 0)
  assert.equal(after.inFlightBytes, 0)
})
