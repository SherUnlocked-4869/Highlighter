'use strict'

// C04 (2026-11-24 Windows product/architecture review) + plan item 16.
//
// Pinned pixels live in the main-process heap only up to `memoryBudget`; anything larger
// spills to an unlinked temporary file. The review's finding was that a QUEUED spill job
// closed over its Buffer: releasing the pin cleared `entry.bytes`, but the queue still held
// the pixels until the job ran, so 100 closed pins could keep ~100 buffers alive (the
// diagnostic counters reported zero because they only looked at resident entries).
//
// The rules this file now enforces:
//   * a job is cancellable by asset id: the last reference release removes it from the queue,
//     drops the Buffer reference and settles its waiter - immediately, not when the two
//     in-flight operations finish;
//   * only the two in-flight operations may keep their pixels, and their bytes count until
//     the I/O settles (a late handle can only be closed);
//   * resident / queued / in-flight / failed-fallback bytes are reported separately and one
//     underlying buffer is counted exactly once;
//   * the resident set is LRU (P1 §6.5, 2026-11-26 review): once the 32 MiB target is exceeded,
//     the LEAST RECENTLY USED resident pin is spilled - not the newest one, which is what the
//     old FIFO behaviour did (the first pins stayed resident forever and every new pin paid for
//     the disk round trip). `read()` and `retain()` mark a pin used; an image larger than the
//     whole target can never be resident and spills immediately, as before;
//   * the resident target (32 MiB) and concurrency (2) are unchanged, and a byte-based hard
//     cap is applied to the queue and to in-flight payloads BEFORE a new buffer is accepted.
//     A full queue answers a retryable error.
//
// Budget arithmetic: a 4K screenshot PNG is typically 8-25 MiB. `SINGLE_ASSET_QUOTA_BYTES`
// (64 MiB) admits the largest image this product supports even though it exceeds the resident
// target; `QUEUED_BYTES_LIMIT` (128 MiB) holds at least five such images while the two
// in-flight slots drain; `INFLIGHT_BYTES_LIMIT` (64 MiB) bounds the bytes actually being
// written or read at any instant.

const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const DEFAULT_MEMORY_BUDGET = 32 * 1024 * 1024
const DEFAULT_IO_CONCURRENCY = 2
const DEFAULT_SINGLE_ASSET_QUOTA = 64 * 1024 * 1024
const DEFAULT_QUEUED_BYTES_LIMIT = 128 * 1024 * 1024
const DEFAULT_INFLIGHT_BYTES_LIMIT = 64 * 1024 * 1024

const RELEASED_ERROR = '贴图资源已释放'
const CLOSED_ERROR = '贴图资源存储已关闭'
const CANCELLED_ERROR = '贴图资源任务已取消'
const INCOMPLETE_READ_ERROR = '贴图资源读取不完整'
const INCOMPLETE_WRITE_ERROR = '贴图资源写入不完整'
const STORE_FULL_ERROR = '贴图资源队列已满'

const SPILL_DIRECTORY_PREFIX = 'highlighter-pin-'
const SPILL_FILE_NAME = 'image'

function codedError(message, code, extra = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, extra)
  return error
}

// The async-fs surface the store uses. It is a tiny, explicit seam instead of
// requiring all of node:fs/promises, so tests can inject ENOSPC/EROFS/EIO and
// slow operations without touching the real disk policy.
function createFileIo() {
  return {
    mkdtemp: (prefix) => fsp.mkdtemp(prefix),
    open: (file, flags, mode) => fsp.open(file, flags, mode),
    unlink: (file) => fsp.unlink(file),
    rmdir: (directory) => fsp.rmdir(directory),
    write: (handle, buffer, offset, length, position) => handle.write(buffer, offset, length, position),
    read: (handle, buffer, offset, length, position) => handle.read(buffer, offset, length, position),
    close: (handle) => handle.close()
  }
}

// FIFO with a hard concurrency floor of one. close() rejects everything still
// queued (so dispose is immediate) while already-started fs calls are allowed to
// settle; drain() resolves once none are running. cancel() is what lets a
// released asset drop its queued payload without waiting for the active two.
function createIoQueue({ concurrency = DEFAULT_IO_CONCURRENCY } = {}) {
  const limit = Math.max(1, Math.floor(Number(concurrency) || 1))
  const waiting = []
  const idleWaiters = []
  let active = 0
  let closed = false

  function settleIdle() {
    if (active > 0 || waiting.length > 0) return
    const waiters = idleWaiters.splice(0)
    for (const resolve of waiters) resolve()
  }

  function pump() {
    while (!closed && active < limit && waiting.length > 0) {
      const job = waiting.shift()
      if (job.cancelled) continue
      active += 1
      job.started = true
      let result
      try {
        result = job.task()
      } catch (error) {
        active -= 1
        job.reject(error)
        continue
      }
      Promise.resolve(result).then(
        (value) => {
          active -= 1
          job.resolve(value)
          pump()
        },
        (error) => {
          active -= 1
          job.reject(error)
          pump()
        }
      )
    }
    settleIdle()
  }

  function run(task, key = null) {
    if (closed) return Promise.reject(codedError(CLOSED_ERROR, 'image-store-closed'))
    return new Promise((resolve, reject) => {
      waiting.push({ task, resolve, reject, key, cancelled: false, started: false })
      pump()
    })
  }

  // Removes the queued jobs whose key matches. A job that already started is left alone
  // (its I/O must settle); its caller sees the cancel through the store's own state.
  function cancel(match) {
    if (typeof match !== 'function') return 0
    const removed = []
    for (let index = waiting.length - 1; index >= 0; index -= 1) {
      const job = waiting[index]
      if (job.started || !match(job)) continue
      waiting.splice(index, 1)
      job.cancelled = true
      job.reject(codedError(CANCELLED_ERROR, 'image-store-cancelled'))
      removed.push(job)
    }
    settleIdle()
    return removed.length
  }

  function close() {
    if (closed) return false
    closed = true
    const pending = waiting.splice(0)
    for (const job of pending) {
      job.cancelled = true
      job.reject(codedError(CLOSED_ERROR, 'image-store-closed'))
    }
    settleIdle()
    return true
  }

  function drain() {
    if (active === 0 && waiting.length === 0) return Promise.resolve()
    return new Promise((resolve) => idleWaiters.push(resolve))
  }

  return {
    run,
    cancel,
    close,
    drain,
    get limit() { return limit },
    get active() { return active },
    get queued() { return waiting.length },
    get closed() { return closed }
  }
}

function createPinImageStore({
  memoryBudget = DEFAULT_MEMORY_BUDGET,
  concurrency = DEFAULT_IO_CONCURRENCY,
  singleAssetQuota = DEFAULT_SINGLE_ASSET_QUOTA,
  queuedBytesLimit = DEFAULT_QUEUED_BYTES_LIMIT,
  inFlightBytesLimit = DEFAULT_INFLIGHT_BYTES_LIMIT,
  tmpdir = os.tmpdir(),
  io = createFileIo(),
  onError = null
} = {}) {
  const queue = createIoQueue({ concurrency })
  const assets = new Map()
  const closing = new Set()
  // Diagnostics callbacks are optional and must never turn a handled disk error
  // into an unhandled rejection.
  const reportError = (error, info) => {
    if (typeof onError !== 'function') return
    try {
      onError(error, info)
    } catch {}
  }
  let sequence = 0
  // Monotonic recency stamp for the LRU resident set. Only relative order matters.
  let accessClock = 0
  let openHandles = 0
  let spillFailures = 0
  let closed = false
  // Byte accounting. One buffer is in exactly one bucket: resident, queued, in flight, or
  // failed-fallback (kept resident because the disk refused it).
  let queuedBytes = 0
  let inFlightBytes = 0
  let failedFallbackBytes = 0

  function residentUsage() {
    let total = 0
    for (const entry of assets.values()) {
      if (entry.bytes) total += entry.bytes.length
    }
    return total
  }

  function closeHandle(handle) {
    const promise = Promise.resolve()
      .then(() => io.close(handle))
      .catch((error) => reportError(error, { phase: 'close' }))
    closing.add(promise)
    promise.then(() => closing.delete(promise))
    return promise
  }

  function closeEntryHandle(entry) {
    const handle = entry.handle
    entry.handle = null
    if (!handle) return Promise.resolve()
    openHandles -= 1
    return closeHandle(handle)
  }

  // mkdtemp -> open('wx+') -> unlink -> rmdir -> write, in that order. The empty
  // file is unlinked *before* the pixels land in it, so the image never exists
  // under a name another process could open; the descriptor keeps it alive for
  // this process and Windows reclaims it after a crash. This is the same
  // security/cleanup property the synchronous implementation had.
  async function writeSpill(entry, bytes) {
    const directory = await io.mkdtemp(path.join(tmpdir, SPILL_DIRECTORY_PREFIX))
    const file = path.join(directory, SPILL_FILE_NAME)
    let handle = null
    let directoryRemoved = false
    try {
      handle = await io.open(file, 'wx+', 0o600)
      try {
        await io.unlink(file)
      } finally {
        await io.rmdir(directory)
        directoryRemoved = true
      }
      let offset = 0
      while (offset < bytes.length) {
        const { bytesWritten } = await io.write(handle, bytes, offset, bytes.length - offset, offset)
        if (!bytesWritten) throw new Error(INCOMPLETE_WRITE_ERROR)
        offset += bytesWritten
      }
      return handle
    } catch (error) {
      if (handle) {
        await io.close(handle).catch(() => {})
      } else if (!directoryRemoved) {
        await io.rmdir(directory).catch(() => {})
      }
      throw error
    }
  }

  function startSpill(entry) {
    entry.state = 'writing'
    const key = entry.id
    // The QUEUED job does NOT close over the pixels: it reads entry.pendingBytes when it
    // starts. That is what makes release() able to drop the buffer immediately (the queue
    // closure only holds the entry, never the image).
    entry.ready = queue.run(() => {
      if (entry.disposed || closed) throw codedError(RELEASED_ERROR, 'image-store-released')
      const payload = entry.pendingBytes
      if (!payload) throw codedError(RELEASED_ERROR, 'image-store-released')
      // The buffer moves from the queue bucket to the in-flight bucket exactly once.
      queuedBytes -= payload.length
      inFlightBytes += payload.length
      return writeSpill(entry, payload).then((handle) => {
        inFlightBytes -= payload.length
        return handle
      }, (error) => {
        inFlightBytes -= payload.length
        throw error
      })
    }, key).then(
      (handle) => {
        // The window may have closed (or the store may have been disposed) while the write
        // was in flight: the late result can only be closed, never attached.
        if (entry.disposed || closed) {
          entry.pendingBytes = null
          void closeHandle(handle)
          return
        }
        entry.pendingBytes = null
        entry.handle = handle
        entry.state = 'ready'
        openHandles += 1
      },
      (error) => {
        // On a cancelled job release() already dropped the payload; on a real disk failure
        // the ORIGINAL buffer is still here and becomes the resident fallback.
        const payload = entry.pendingBytes
        entry.pendingBytes = null
        if (entry.disposed || closed || !payload) return
        const size = Number(payload.length) || 0
        // Disk full/read-only: keep the pin usable by falling back to the resident path
        // instead of losing the image. Never silently drop an open pin.
        entry.state = 'resident'
        entry.bytes = payload
        spillFailures += 1
        failedFallbackBytes += size
        reportError(error, { phase: 'spill-write', id: entry.id })
      }
    )
  }

  function touch(entry) {
    entry.lastUsed = ++accessClock
  }

  // Moves one resident buffer into the spill queue. The bytes leave the resident set
  // synchronously, so the budget is correct before the disk work starts.
  function spillResident(entry) {
    const payload = entry.bytes
    entry.bytes = null
    entry.pendingBytes = payload
    queuedBytes += payload.length
    startSpill(entry)
  }

  // Brings the resident set back under the target after `entry` was inserted as resident.
  // When the new pin fits the target, the least recently used OLDER pins are spilled and the
  // new one stays in memory (LRU); the new pin itself is the victim only when it can never fit,
  // and each victim is selected in recency order. Every victim is chosen and the queue byte cap
  // is checked BEFORE any buffer is dropped, so a refusal leaves the store exactly as it was
  // and the caller may retry.
  function evictResidentsFor(entry) {
    const size = entry.bytes.length
    const victims = []
    if (size > memoryBudget) {
      victims.push(entry)
    } else {
      let usage = residentUsage()
      const candidates = []
      for (const asset of assets.values()) {
        if (asset.bytes && asset !== entry) candidates.push(asset)
      }
      candidates.sort((left, right) => left.lastUsed - right.lastUsed)
      for (const candidate of candidates) {
        if (usage <= memoryBudget) break
        victims.push(candidate)
        usage -= candidate.bytes.length
      }
      if (usage > memoryBudget) victims.push(entry)
    }
    let victimBytes = 0
    for (const victim of victims) victimBytes += victim.bytes.length
    if (queuedBytes + victimBytes > queuedBytesLimit) {
      throw codedError(STORE_FULL_ERROR, 'image-store-full', {
        retryable: true,
        bytes: queuedBytes + victimBytes,
        limit: queuedBytesLimit
      })
    }
    for (const victim of victims) spillResident(victim)
  }

  // `add` answers an id. When the queue cannot take another buffer it throws a RETRYABLE
  // error instead of accepting work the disk cannot start; an image beyond the single-asset
  // quota is refused as unsupported (non-retryable).
  function add({ bytes, mime }) {
    if (closed) throw codedError(CLOSED_ERROR, 'image-store-closed')
    const size = bytes.length
    if (size > singleAssetQuota) {
      throw codedError('贴图图片超出单张额度', 'image-too-large', { retryable: false, bytes: size, limit: singleAssetQuota })
    }
    const id = ++sequence
    const entry = {
      id,
      mime,
      length: size,
      refs: 1,
      state: 'resident',
      bytes,
      pendingBytes: null,
      handle: null,
      ready: null,
      disposed: false,
      inflight: 0,
      lastUsed: ++accessClock
    }
    assets.set(id, entry)
    if (residentUsage() <= memoryBudget) return id
    try {
      evictResidentsFor(entry)
    } catch (error) {
      // The queue refused the work before any buffer moved: undo the insertion so the
      // caller's retry sees the same state a refused `add` always left behind.
      assets.delete(id)
      entry.disposed = true
      entry.bytes = null
      throw error
    }
    return id
  }

  async function readSpill(entry, target) {
    entry.inflight += 1
    try {
      if (entry.disposed || !entry.handle) throw codedError(RELEASED_ERROR, 'image-store-released')
      let offset = 0
      while (offset < target.length) {
        const { bytesRead } = await io.read(entry.handle, target, offset, target.length - offset, offset)
        if (!bytesRead) throw new Error(INCOMPLETE_READ_ERROR)
        offset += bytesRead
      }
      // Release may win the race with a slow read; never hand pixels back for a slot that
      // no longer exists.
      if (entry.disposed) throw codedError(RELEASED_ERROR, 'image-store-released')
      return target
    } finally {
      entry.inflight -= 1
      inFlightBytes -= target.length
      if (entry.disposed && entry.inflight === 0) void closeEntryHandle(entry)
    }
  }

  async function read(id) {
    const entry = assets.get(id)
    if (!entry || closed) throw codedError(RELEASED_ERROR, 'image-store-released')
    // A read is the strongest "still in use" signal, so it refreshes the pin's LRU position
    // before the (possibly spilled) pixels are served.
    touch(entry)
    if (entry.state === 'resident') return { bytes: entry.bytes, mime: entry.mime }
    if (entry.ready) await entry.ready
    if (entry.disposed || !assets.has(id) || closed) throw codedError(RELEASED_ERROR, 'image-store-released')
    if (entry.state === 'resident') return { bytes: entry.bytes, mime: entry.mime }
    // The read buffer is charged as in-flight work before it is allocated.
    if (inFlightBytes + entry.length > inFlightBytesLimit) {
      throw codedError('贴图资源读取等待中', 'image-store-busy', {
        retryable: true,
        bytes: inFlightBytes + entry.length,
        limit: inFlightBytesLimit
      })
    }
    const target = Buffer.allocUnsafe(entry.length)
    inFlightBytes += target.length
    try {
      return { bytes: await queue.run(() => readSpill(entry, target), 'read:' + id), mime: entry.mime }
    } catch (error) {
      if (error?.code !== 'image-store-cancelled') throw error
      // The store cancelled this read (dispose/release): report it as a release.
      throw codedError(RELEASED_ERROR, 'image-store-released')
    }
  }

  function retain(id) {
    const entry = assets.get(id)
    if (!entry || entry.disposed) return false
    entry.refs += 1
    // A retained pin (crash recovery rebuild, for example) is about to be used again.
    touch(entry)
    return true
  }

  function release(id) {
    const entry = assets.get(id)
    if (!entry) return
    entry.refs -= 1
    if (entry.refs > 0) return
    assets.delete(id)
    entry.disposed = true
    entry.refs = 0
    // Drop the queued payload and remove its job NOW: the pixels must not stay reachable
    // through a queued closure after the last reference is gone.
    if (entry.pendingBytes) {
      queuedBytes = Math.max(0, queuedBytes - entry.pendingBytes.length)
      entry.pendingBytes = null
    }
    queue.cancel((job) => job.key === id)
    if (entry.bytes) {
      entry.bytes = null
      return
    }
    // A write still in flight owns the handle: its completion closes it. A read still in
    // flight owns it too; its finally block closes it.
    if (entry.state === 'writing' || entry.inflight > 0) return
    void closeEntryHandle(entry)
  }

  function dispose() {
    if (closed) return false
    closed = true
    queue.close()
    queuedBytes = 0
    for (const entry of [...assets.values()]) {
      entry.disposed = true
      entry.refs = 0
      entry.pendingBytes = null
      if (entry.bytes) {
        entry.bytes = null
        continue
      }
      if (entry.state === 'writing' || entry.inflight > 0) continue
      void closeEntryHandle(entry)
    }
    assets.clear()
    return true
  }

  async function whenIdle() {
    for (;;) {
      await queue.drain()
      if (closing.size === 0 && queue.active === 0 && queue.queued === 0) return
      if (closing.size > 0) await Promise.allSettled([...closing])
    }
  }

  function stats() {
    let resident = 0
    let spilled = 0
    for (const entry of assets.values()) {
      if (entry.bytes) resident += entry.bytes.length
      if (entry.state !== 'resident') spilled += 1
    }
    return {
      assets: assets.size,
      // Each bucket reports its own bytes and task count; one buffer is counted once.
      residentBytes: resident,
      queuedBytes,
      queuedTasks: queue.queued,
      inFlightBytes,
      inFlightTasks: queue.active,
      failedFallbackBytes,
      spilled,
      handles: openHandles,
      spillFailures,
      closed,
      limits: { memoryBudget, queuedBytesLimit, inFlightBytesLimit, singleAssetQuota, concurrency: queue.limit },
      // The pre-C04 names stay as aliases so existing diagnostics keep reading them.
      resident,
      queued: queue.queued,
      inFlight: queue.active
    }
  }

  return { add, read, retain, release, dispose, whenIdle, stats }
}

module.exports = {
  DEFAULT_INFLIGHT_BYTES_LIMIT,
  DEFAULT_IO_CONCURRENCY,
  DEFAULT_MEMORY_BUDGET,
  DEFAULT_QUEUED_BYTES_LIMIT,
  DEFAULT_SINGLE_ASSET_QUOTA,
  createFileIo,
  createIoQueue,
  createPinImageStore
}
