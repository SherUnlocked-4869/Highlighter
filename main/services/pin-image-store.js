'use strict'

const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

// C04 (2026-11-24 Windows product/architecture review): pinned pixels stay in the
// main-process heap up to this budget. Anything larger spills to an unlinked
// temporary file so a handful of 4K pins cannot grow private commit without bound.
const DEFAULT_MEMORY_BUDGET = 32 * 1024 * 1024
// C04: one shared queue for spill writes and reads, at most two operations in
// flight. The cap stops a burst of large pins from queueing hundreds of fs
// operations (and descriptors) and is injectable so a test can prove the bound.
const DEFAULT_IO_CONCURRENCY = 2

const RELEASED_ERROR = '贴图资源已释放'
const CLOSED_ERROR = '贴图资源存储已关闭'
const INCOMPLETE_READ_ERROR = '贴图资源读取不完整'
const INCOMPLETE_WRITE_ERROR = '贴图资源写入不完整'

const SPILL_DIRECTORY_PREFIX = 'highlighter-pin-'
const SPILL_FILE_NAME = 'image'

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
// settle; drain() resolves once none are running, which is what lets a caller
// prove that released work cannot come back later.
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
      active += 1
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

  function run(task) {
    if (closed) return Promise.reject(new Error(CLOSED_ERROR))
    return new Promise((resolve, reject) => {
      waiting.push({ task, resolve, reject })
      pump()
    })
  }

  function close() {
    if (closed) return false
    closed = true
    const pending = waiting.splice(0)
    for (const job of pending) job.reject(new Error(CLOSED_ERROR))
    settleIdle()
    return true
  }

  function drain() {
    if (active === 0 && waiting.length === 0) return Promise.resolve()
    return new Promise((resolve) => idleWaiters.push(resolve))
  }

  return {
    run,
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
  let openHandles = 0
  let spillFailures = 0
  let closed = false

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

  function startSpill(entry, bytes) {
    entry.state = 'writing'
    entry.ready = queue.run(() => {
      // A pin released while its write was still queued must not touch the disk
      // at all; the queued slot is simply discarded.
      if (entry.disposed || closed) throw new Error(RELEASED_ERROR)
      return writeSpill(entry, bytes)
    }).then(
      (handle) => {
        // The window may have closed (or the store may have been disposed)
        // while the write was in flight: the late result must be discarded, not
        // attached to an already released slot.
        if (entry.disposed || closed) {
          void closeHandle(handle)
          return
        }
        entry.handle = handle
        entry.state = 'ready'
        openHandles += 1
      },
      (error) => {
        if (entry.disposed || closed) return
        // Disk full/read-only: keep the pin usable by falling back to the
        // resident path instead of losing the image. The bytes were already in
        // hand, so this only bends the budget, it does not leak a descriptor.
        entry.state = 'resident'
        entry.bytes = bytes
        spillFailures += 1
        reportError(error, { phase: 'spill-write', id: entry.id })
      }
    )
  }

  function add({ bytes, mime }) {
    if (closed) throw new Error(CLOSED_ERROR)
    const id = ++sequence
    const entry = {
      id,
      mime,
      length: bytes.length,
      refs: 1,
      state: 'resident',
      bytes,
      handle: null,
      ready: null,
      disposed: false,
      inflight: 0
    }
    assets.set(id, entry)
    if (residentUsage() <= memoryBudget) return id
    // Over budget: move the pixels out of the resident set immediately, then
    // let the shared queue do the disk work asynchronously.
    entry.bytes = null
    startSpill(entry, bytes)
    return id
  }

  async function readSpill(entry) {
    entry.inflight += 1
    try {
      if (entry.disposed || !entry.handle) throw new Error(RELEASED_ERROR)
      const bytes = Buffer.allocUnsafe(entry.length)
      let offset = 0
      while (offset < bytes.length) {
        const { bytesRead } = await io.read(entry.handle, bytes, offset, bytes.length - offset, offset)
        if (!bytesRead) throw new Error(INCOMPLETE_READ_ERROR)
        offset += bytesRead
      }
      // Release may win the race with a slow read; never hand pixels back for a
      // slot that no longer exists.
      if (entry.disposed) throw new Error(RELEASED_ERROR)
      return bytes
    } finally {
      entry.inflight -= 1
      if (entry.disposed && entry.inflight === 0) void closeEntryHandle(entry)
    }
  }

  async function read(id) {
    const entry = assets.get(id)
    if (!entry || closed) throw new Error(RELEASED_ERROR)
    if (entry.state === 'resident') return { bytes: entry.bytes, mime: entry.mime }
    if (entry.ready) await entry.ready
    if (entry.disposed || !assets.has(id) || closed) throw new Error(RELEASED_ERROR)
    if (entry.state === 'resident') return { bytes: entry.bytes, mime: entry.mime }
    return { bytes: await queue.run(() => readSpill(entry)), mime: entry.mime }
  }

  function retain(id) {
    const entry = assets.get(id)
    if (!entry || entry.disposed) return false
    entry.refs += 1
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
    if (entry.bytes) {
      entry.bytes = null
      return
    }
    // A write still in flight owns the handle: its completion closes it. A read
    // still in flight owns it too; its finally block closes it.
    if (entry.state === 'writing' || entry.inflight > 0) return
    void closeEntryHandle(entry)
  }

  function dispose() {
    if (closed) return false
    closed = true
    queue.close()
    for (const entry of [...assets.values()]) {
      entry.disposed = true
      entry.refs = 0
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
      resident,
      spilled,
      handles: openHandles,
      inFlight: queue.active,
      queued: queue.queued,
      spillFailures,
      closed
    }
  }

  return { add, read, retain, release, dispose, whenIdle, stats }
}

module.exports = { createPinImageStore, createFileIo, createIoQueue }
