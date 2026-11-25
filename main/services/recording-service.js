'use strict'

// Region-recording source session service.
//
// Feature E1 (plan §8.3, docs/plans/2026-10-25-snow-apps-feature-development-plan.md)
// splits the two things this class used to conflate:
//
//   1. THE SESSION owns the source file. Lifecycle:
//        capturing -> finalizing -> ready -> closing -> closed, plus `failed`.
//      A session directory is deleted only on close, and only once no export still holds
//      a reference. Before E a successful MP4 save called cleanupSession(), which deleted
//      the recording while the preview stayed open - so a second export (or a trim) had
//      nothing left to read. `finishSession()` no longer deletes anything.
//
//   2. THE EXPORT borrows the source. `acquireSource()`/`releaseSource()` are the
//      reference count the export service uses (main/services/recording-export-service.js);
//      `cleanupSession()` while a reference is out moves the session to `closing` and
//      defers the directory removal to the last release, so exit and data-root migration
//      can still wait for or refuse a write instead of racing it.
//
// The legacy `transcode()` (used by `record:save-mp4`) stays, but only as a dumb encoder:
// it never deletes the source and never closes the session. Callers that want the old
// "save and forget" behaviour have to close the session themselves.
//
// R1 recording workbench (docs/plans/2026-11-03-recording-r1-r3-contracts.md §5):
// a session can also write into a PERSISTENT PROJECT directory owned by
// main/services/recording-project-service.js. `startSession({ directory, projectId })`
// and `registerPersistedSession()` create sessions with `ownedDirectory === false`;
// cleanupSession/removeSessionDirectory/dispose then only drop them from the session
// table and NEVER remove the directory - the project service is the only deleter.
// `detachSession()` is the same "release without deleting" move for a session that a
// project has taken over.
//
// `appendChunk(sessionId, buffer, { sequence })` adds replay-idempotent, gap-strict
// chunk numbering for the control bar. Without a sequence the legacy append path is
// unchanged, so existing callers keep working.
//
// Legal transitions are defined once in shared/recording-export-options.js so this
// service, the export queue and the renderer's trim controller share one table.

const { randomUUID } = require('node:crypto')
const { spawn } = require('node:child_process')
const fs = require('node:fs/promises')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { buildFfmpegArgs } = require('../../record/recording-utils')
const { sessionTransition } = require('../../shared/recording-export-options')

// States in which the source may still be read by an export.
const READABLE_STATES = Object.freeze(['ready', 'closing'])
// C01 (docs/reviews/2026-11-24-windows-product-architecture-review.md): one fragment is
// one second of capture. A fragment above this is abnormal; it is refused instead of
// being buffered in the main process.
const MAX_APPEND_BYTES = 32 * 1024 * 1024
// A finish waits at most this long for one in-flight append (the renderer's ACK timeout
// is 30 s; the main process applies its own deadline so a wedged disk cannot hold both
// ends of the IPC and the window forever).
const FINALIZE_TIMEOUT_MS = 30_000

// True when `child` is the same path as `parent` or lies below it. Used to keep a
// registerPersistedSession() inputPath inside its own directory - the service never
// accepts a caller-chosen path outside the directory it was told to own.
function isInsideDirectory(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function sequenceError(code, message, detail = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, detail)
  return error
}

class RecordingService {
  constructor({ tempRoot, ffmpegPath, spawnProcess = spawn, log = () => {}, probe = null, fs: fsImpl = fs, finalizeTimeoutMs = FINALIZE_TIMEOUT_MS }) {
    if (!tempRoot) throw new Error('录制临时目录不能为空')
    if (!ffmpegPath) throw new Error('FFmpeg 路径不能为空')
    this.tempRoot = path.resolve(tempRoot)
    this.ffmpegPath = ffmpegPath
    this.spawnProcess = spawnProcess
    this.log = typeof log === 'function' ? log : () => {}
    // The filesystem seam exists so the disk-full and wedged-write paths can be exercised
    // without a full volume: production always uses node:fs/promises.
    this.fs = fsImpl || fs
    // How long a finish may wait for one in-flight append. Beyond this the capture is
    // declared interrupted and the original file is kept for recovery instead of being
    // truncated under a write that may still complete.
    this.finalizeTimeoutMs = Math.max(0, Number(finalizeTimeoutMs) || 0)
    // `probe` is main/services/recording-probe.js's MediaProbe (or a test double). Optional
    // so a unit test can construct the service without spawning anything; every probe call
    // then reports `probe-unavailable` instead of inventing a duration.
    this.probe = probe
    this.sessions = new Map()
  }

  getSession(sessionId) {
    const session = this.sessions.get(String(sessionId || ''))
    if (!session) throw new Error('录制会话不存在')
    return session
  }

  peekSession(sessionId) {
    return this.sessions.get(String(sessionId || '')) || null
  }

  stateOf(sessionId) {
    return this.peekSession(sessionId)?.state || 'closed'
  }

  // Starts one capture session.
  //
  // Without arguments the legacy behaviour is unchanged: the session owns a fresh
  // directory under `tempRoot` and cleanupSession() deletes it.
  //
  // `{ directory, projectId }` is the workbench path: the caller (record domain) has
  // already created the persistent project and passes its directory, so the session
  // writes `capture.webm` there. Such a session has `ownedDirectory === false` and is
  // never allowed to delete that directory.
  async startSession({ directory = null, projectId = null } = {}) {
    const requestedDirectory = typeof directory === 'string' && directory.trim()
      ? path.resolve(directory)
      : ''
    const id = randomUUID()
    const ownedDirectory = !requestedDirectory
    const sessionDirectory = requestedDirectory || path.join(this.tempRoot, id)
    if (ownedDirectory) {
      await fs.mkdir(this.tempRoot, { recursive: true })
      await fs.mkdir(sessionDirectory, { recursive: false })
    } else {
      // The project service created this directory; mkdir is a no-op that tolerates a
      // caller which only reserved the name.
      await fs.mkdir(sessionDirectory, { recursive: true })
    }
    const inputPath = path.join(sessionDirectory, 'capture.webm')
    await fs.writeFile(inputPath, Buffer.alloc(0))
    const session = {
      id,
      directory: sessionDirectory,
      inputPath,
      // Set for workbench sessions: the persistent project this capture belongs to.
      projectId: projectId ? String(projectId) : null,
      // false when the directory belongs to a recording project (or another owner).
      ownedDirectory,
      state: 'capturing',
      // Serialised source writes. `bytesWritten` counts chunks that actually reached
      // the file, so it can lag an accepted sequence by one in-flight append.
      writeQueue: Promise.resolve(),
      // Number of appends whose promise has not settled yet. A rejected write leaves the
      // queue settled, so this counter - not the queue - is what says a write is still
      // running (and a cleanup therefore has to wait).
      pendingWrites: 0,
      bytesWritten: 0,
      // Highest chunk sequence accepted so far (0 = none). Replays and gaps are
      // judged against this value synchronously, before the write starts.
      lastChunkSequence: 0,
      // C01/02: the highest sequence whose BYTES are fully on disk and the byte offset
      // that follows it. They move together, only after appendFile resolved, so a torn
      // tail can be cut back to exactly the data the ACKs described.
      committedSequence: 0,
      committedBytes: 0,
      // Set when a write fails: a full disk must stop ordering new chunks while the
      // confirmed prefix stays readable.
      writeError: null,
      accepting: true,
      finishPromise: null,
      finishResult: null,
      finishError: null,
      process: null,
      // Number of live exports reading this source (plan §8.3). Closing waits for it.
      references: 0,
      // Probe result, memoised: the file is sealed by the time it is first probed and the
      // metadata never changes, so both the preview and every export reuse one result.
      metadata: null,
      pendingClose: false,
      lastError: ''
    }
    this.sessions.set(id, session)
    return { id, directory: sessionDirectory, inputPath }
  }

  // Re-attaches a persistent project source after an application restart (or when the
  // editor opens a project whose session is gone). The session starts as `ready`
  // because the file already exists, holds no references, and NEVER owns the directory.
  // Idempotent: registering an id that is already attached returns the live session.
  async registerPersistedSession({ id, directory, inputPath = '', metadata = null, projectId = null } = {}) {
    const sessionId = String(id || '')
    if (!sessionId) throw new Error('Persisted recording session needs an id')
    if (typeof directory !== 'string' || !directory.trim()) {
      throw new Error('Persisted recording session needs a directory')
    }
    const sessionDirectory = path.resolve(directory)
    const sourcePath = inputPath ? path.resolve(String(inputPath)) : path.join(sessionDirectory, 'capture.webm')
    if (!isInsideDirectory(sessionDirectory, sourcePath)) {
      throw new Error('Persisted recording source must stay inside its session directory')
    }
    const existing = this.sessions.get(sessionId)
    if (existing) {
      // A restart never re-registers over a live capture; refresh only the optional
      // data that may have been missing when the session was first attached.
      if (metadata) existing.metadata = metadata
      if (projectId) existing.projectId = String(projectId)
      return existing
    }
    const stat = await fs.stat(sourcePath).catch(() => null)
    const session = {
      id: sessionId,
      directory: sessionDirectory,
      inputPath: sourcePath,
      projectId: projectId ? String(projectId) : null,
      ownedDirectory: false,
      state: 'ready',
      writeQueue: Promise.resolve(),
      pendingWrites: 0,
      bytesWritten: stat ? stat.size : 0,
      lastChunkSequence: 0,
      committedSequence: 0,
      committedBytes: stat ? stat.size : 0,
      writeError: null,
      accepting: false,
      finishPromise: null,
      finishResult: null,
      finishError: null,
      process: null,
      references: 0,
      metadata: metadata || null,
      pendingClose: false,
      lastError: ''
    }
    this.sessions.set(sessionId, session)
    return session
  }

  // Releases a session without deleting its directory. Used when a project takes over
  // the source file (the project service then owns lifetime and deletion).
  detachSession(sessionId) {
    const id = String(sessionId || '')
    if (!this.sessions.has(id)) return false
    this.sessions.delete(id)
    return true
  }

  // Applies one documented transition, throwing a domain error on an illegal one.
  transitionSession(session, event) {
    const next = sessionTransition(session.state, event)
    if (!next) throw new Error(`录制会话状态不允许该操作：${session.state} -> ${event}`)
    session.state = next
    return next
  }

  // Appends one MediaRecorder chunk.
  //
  // `{ sequence }` (workbench flow) is 1-based and strictly increasing:
  //   * `sequence <= lastChunkSequence` is a REPLAY (the ACK was lost): the chunk is
  //     not written again and the current ACK is returned;
  //   * `sequence > lastChunkSequence + 1` is a GAP: throws `code='sequence-gap'`
  //     without writing anything, so the caller can stop instead of recording a file
  //     with a hole in it;
  //   * no sequence keeps the legacy "append in call order" behaviour.
  // The returned ACK is `{ committedBytes, sequence, lastChunkSequence }`. It means
  // "this chunk is accepted and ordered", NOT "the manifest checkpoint is durable" -
  // the project service reports durability separately.
  async appendChunk(sessionId, value, { sequence = null } = {}) {
    const session = this.getSession(sessionId)
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value || [])
    if (buffer.length > MAX_APPEND_BYTES) {
      throw sequenceError('chunk-too-large', 'Recording chunk exceeds the append limit', {
        bytes: buffer.length,
        limit: MAX_APPEND_BYTES
      })
    }
    let chunkSequence = null
    if (sequence !== null && sequence !== undefined) {
      chunkSequence = Number(sequence)
      if (!Number.isSafeInteger(chunkSequence) || chunkSequence < 1) {
        throw sequenceError('invalid-sequence', 'Recording chunk sequence must be a positive integer', {
          received: sequence
        })
      }
      if (chunkSequence <= session.lastChunkSequence) {
        // Replay: wait for earlier writes so `committedBytes` is not a stale number,
        // then return the same acceptance the first delivery got. A replay is answered
        // even after a write failure or a seal: the bytes it refers to are the confirmed
        // prefix, and re-writing them would duplicate media.
        if (session.pendingWrites === 0) await session.writeQueue
        return this.appendAck(session, chunkSequence)
      }
      if (chunkSequence > session.lastChunkSequence + 1) {
        throw sequenceError(
          'sequence-gap',
          `Recording chunk sequence gap: expected ${session.lastChunkSequence + 1}, received ${chunkSequence}`,
          { expected: session.lastChunkSequence + 1, received: chunkSequence }
        )
      }
    }
    // C01/02: after a write failure (or once a finish started) no NEW sequence is
    // ordered. Accepting one would describe bytes that can never be written, and would
    // destroy the contiguity the confirmed prefix depends on. The same code answers a
    // chunk that arrives after the seal, so a late tail is never mistaken for a new take.
    if (session.state !== 'capturing' || session.accepting === false) {
      throw sequenceError('append-sealed', 'Recording session stopped accepting chunks', {
        sequence: chunkSequence,
        committedBytes: session.committedBytes,
        lastChunkSequence: session.committedSequence,
        state: session.state
      })
    }
    if (chunkSequence !== null) {
      // Accept the number synchronously, before the write starts: a duplicate that
      // arrives while this chunk is still in flight must be recognised as a replay.
      session.lastChunkSequence = chunkSequence
    }
    if (!buffer.length) {
      await session.writeQueue
      return this.appendAck(session, chunkSequence)
    }
    const write = session.writeQueue.then(async () => {
      await this.fs.appendFile(session.inputPath, buffer)
      // C01/02: the offset and the sequence move TOGETHER, after the append resolved.
      session.bytesWritten += buffer.length
      session.committedBytes = session.bytesWritten
      if (chunkSequence !== null) session.committedSequence = chunkSequence
    })
    session.pendingWrites += 1
    // The stored queue never rejects: a failed write is reported to its own caller and
    // recorded on the session, so a later append/finish must not inherit the rejection.
    session.writeQueue = write.then(() => {}, () => {})
    try {
      await write
    } catch (error) {
      session.writeError = {
        code: error?.code || 'write-failed',
        message: error?.message || String(error),
        sequence: chunkSequence,
        committedBytes: session.committedBytes,
        at: Date.now()
      }
      session.accepting = false
      throw error
    } finally {
      session.pendingWrites -= 1
      this.maybeCompleteDeferredClose(session)
    }
    return this.appendAck(session, chunkSequence)
  }

  // A close that was requested while a write was still running is completed as soon as
  // the last write settles: deleting a file under an in-flight append would leave the
  // volume with orphaned or torn data.
  maybeCompleteDeferredClose(session) {
    if (!session.pendingClose || session.pendingWrites > 0) return
    this.removeSessionDirectory(session).catch((error) => this.log('Recording cleanup failed:', error?.message || error))
  }

  appendAck(session, sequence) {
    return {
      committedBytes: session.bytesWritten,
      sequence: sequence === null || sequence === undefined ? null : sequence,
      lastChunkSequence: session.lastChunkSequence
    }
  }

  // capturing -> finalizing -> ready. Returns the preview descriptor the renderer needs.
  // Deliberately does NOT probe and does NOT delete anything: the probe is a separate call
  // (`probeSession`) because it spawns ffmpeg, and deleting the source is `cleanupSession`.
  //
  // C01/02: this is the single finish entry. A second call (tray + hotkey + window all
  // stopping at once, or the user retrying a failed seal) returns the SAME receipt
  // instead of "the session already ended"; a write that never returns is bounded by
  // `timeoutMs`, and a torn tail is cut back to the confirmed prefix.
  async finishSession(sessionId, { timeoutMs = this.finalizeTimeoutMs } = {}) {
    const session = this.getSession(sessionId)
    if (session.finishPromise) return session.finishPromise
    if (session.finishResult) return { ...session.finishResult }
    if (session.finishError) throw session.finishError
    if (session.state === 'ready') return this.previewDescriptor(session)
    if (session.state !== 'capturing') throw new Error('录制会话已经结束')
    session.finishPromise = this.finalizeSession(session, timeoutMs)
    try {
      const descriptor = await session.finishPromise
      session.finishResult = descriptor
      return { ...descriptor }
    } catch (error) {
      session.finishError = error
      throw error
    } finally {
      session.finishPromise = null
    }
  }

  async finalizeSession(session, timeoutMs) {
    this.transitionSession(session, 'finalize')
    session.accepting = false
    let timedOut = false
    if (session.pendingWrites > 0) {
      const budget = Math.max(0, Number(timeoutMs) || 0)
      const outcome = await Promise.race([
        session.writeQueue.then(() => 'settled'),
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve('timeout'), budget)
          // Never keep the process alive just to time out a finish.
          if (typeof timer.unref === 'function') timer.unref()
        })
      ])
      timedOut = outcome === 'timeout'
    }
    let size = 0
    // Both numbers are captured before a truncation rewinds the accepted sequence: the
    // project needs the received value to describe the missing range.
    const lastReceivedSequence = Math.max(session.lastChunkSequence, session.committedSequence)
    try {
      const stat = await this.fs.stat(session.inputPath)
      size = Number(stat.size) || 0
    } catch {
      size = 0
    }
    const writeError = session.writeError
    if (writeError && !timedOut) {
      // A rejected append leaves the serialised writer settled, so no write is running:
      // cutting the file back to the confirmed offset is safe and keeps the delivered
      // bytes byte-identical to the ACKs the renderer saw.
      if (size > session.committedBytes) {
        try {
          await this.fs.truncate(session.inputPath, session.committedBytes)
          size = session.committedBytes
        } catch (error) {
          // Truncation failing is not a reason to lose the file: report the larger size
          // as unverified and keep everything for the recovery path.
          this.log('Recording tail truncation failed:', session.id, error?.message || error)
          session.tailUnverified = true
        }
      }
      session.lastChunkSequence = session.committedSequence
    }
    session.bytesWritten = size
    const failure = writeError
      ? {
          code: writeError.code,
          message: writeError.message,
          missingSequenceFrom: session.committedSequence + 1,
          missingSequenceTo: Math.max(session.committedSequence, Number(writeError.sequence) || session.lastChunkSequence)
        }
      : (timedOut
          ? {
              code: 'write-timeout',
              message: 'The last append did not finish in time',
              missingSequenceFrom: session.committedSequence + 1,
              missingSequenceTo: session.lastChunkSequence
            }
          : null)
    if (!size) {
      const error = sequenceError('no-confirmed-media', '录制内容为空', {
        committedBytes: 0,
        committedSequence: session.committedSequence,
        lastReceivedSequence: session.lastChunkSequence,
        failure
      })
      try { this.transitionSession(session, 'fail') } catch {}
      throw error
    }
    this.transitionSession(session, 'ready')
    const descriptor = {
      ...this.previewDescriptor(session),
      recovered: Boolean(failure),
      timedOut,
      committedBytes: timedOut ? size : session.committedBytes,
      lastChunkSequence: session.committedSequence,
      lastReceivedSequence,
      failure
    }
    return descriptor
  }

  previewDescriptor(session) {
    return {
      id: session.id,
      state: session.state,
      inputPath: session.inputPath,
      previewUrl: pathToFileURL(session.inputPath).href,
      metadata: session.metadata,
      bytesWritten: Number(session.bytesWritten) || 0,
      projectId: session.projectId || null,
      // C01/02: what the ACKs actually described, apart from what the file holds. A
      // recovered take can have both numbers differ (a torn tail, or a write that landed
      // after the finish deadline).
      recovered: false,
      timedOut: false,
      committedBytes: Number(session.committedBytes) || 0,
      lastChunkSequence: Number(session.committedSequence) || 0,
      lastReceivedSequence: Number(session.lastChunkSequence) || 0,
      failure: null
    }
  }

  // D03: read-only accessor for the media probe. Salvage reuses the same probe instance (and its
  // FFmpeg path/timeouts) instead of constructing a second probing stack.
  getProbe() {
    return this.probe || null
  }

  // E0 integration: probe the sealed source. `crossCheckMs` is the renderer's own duration
  // estimate (a UI initial value only); the probe result is what every range is validated
  // against. Resolves `{ ok: true, metadata }` or `{ ok: false, code }`.
  async probeSession(sessionId, { crossCheckMs = null, force = false } = {}) {
    const session = this.getSession(sessionId)
    if (!READABLE_STATES.includes(session.state)) return { ok: false, code: 'session-not-ready' }
    if (session.metadata && !force) return { ok: true, metadata: session.metadata }
    if (!this.probe || typeof this.probe.probe !== 'function') return { ok: false, code: 'probe-unavailable' }
    const result = await this.probe.probe(session.inputPath, { crossCheckMs })
    if (!result?.ok) return { ok: false, code: result?.code || 'probe-failed', detail: result?.detail }
    session.metadata = result.metadata
    return { ok: true, metadata: session.metadata }
  }

  // An export asks for a readable source. Returns the lease `{ sessionId, inputPath, metadata }`;
  // the caller MUST call releaseSource() in a finally block.
  acquireSource(sessionId) {
    const session = this.getSession(sessionId)
    if (!READABLE_STATES.includes(session.state)) throw new Error('录制会话尚未准备就绪')
    if (!session.metadata) throw new Error('录制文件尚未探测')
    session.references += 1
    let released = false
    return {
      sessionId: session.id,
      inputPath: session.inputPath,
      metadata: session.metadata,
      release: () => {
        if (released) return session.references
        released = true
        return this.releaseSource(session.id)
      }
    }
  }

  releaseSource(sessionId) {
    const session = this.peekSession(sessionId)
    if (!session) return 0
    if (session.references > 0) session.references -= 1
    if (session.references === 0 && session.pendingClose) {
      // The last export let go after a close was requested: finish the removal now.
      this.removeSessionDirectory(session).catch((error) => this.log('Recording cleanup failed:', error?.message || error))
    }
    return session.references
  }

  async removeSessionDirectory(session) {
    if (session.state !== 'closing' && session.state !== 'closed') return false
    if (session.references > 0) {
      session.pendingClose = true
      return false
    }
    // C01: a file that is still being written is not deleted. Its owner asked to close
    // it, so the close is deferred to the moment the last write settles (see
    // maybeCompleteDeferredClose); deleting under an in-flight append would either leave
    // an orphaned torn file or fail halfway through the directory.
    if (session.pendingWrites > 0) {
      session.pendingClose = true
      return false
    }
    this.sessions.delete(session.id)
    if (session.process && typeof session.process.kill === 'function') {
      try { session.process.kill() } catch {}
      session.process = null
    }
    session.pendingClose = false
    // Project-owned directories are released, never removed: recording-project-service
    // owns their lifetime and is the only component allowed to delete them. The
    // session is still fully closed here (it left the table), so callers cannot write
    // into it anymore.
    if (session.ownedDirectory === false) {
      session.state = 'closed'
      await this.runClosedHook(session)
      return true
    }
    await fs.rm(session.directory, { recursive: true, force: true })
    session.state = 'closed'
    await this.runClosedHook(session)
    return true
  }

  // C01: an owner that asked for a deferred close (a project whose directory may only be
  // deleted after the last write settled) is told exactly here.
  async runClosedHook(session) {
    const onClosed = session.onClosed
    session.onClosed = null
    if (typeof onClosed !== 'function') return
    try {
      await onClosed()
    } catch (error) {
      this.log('Recording deferred close failed:', error?.message || error)
    }
  }

  // Closes a session and removes its directory once no export references the source.
  // Returns `true` when the session is fully closed (its directory is gone for a
  // session-owned temp directory, or intentionally left to its owner for a
  // project-owned one), `false` when the removal is deferred (the session stays in
  // `closing` and the last release completes it).
  async cleanupSession(sessionId) {
    const session = this.peekSession(sessionId)
    if (!session) return false
    if (session.state === 'closed') return true
    if (session.state === 'capturing') this.transitionSession(session, 'fail')
    if (session.state === 'failed' || session.state === 'ready') this.transitionSession(session, 'close')
    if (session.state !== 'closing') return false
    return this.removeSessionDirectory(session)
  }

  // Legacy encoder used by `record:save-mp4`. Writes `outputPath` and returns it; on failure
  // only its own partial output is removed. The SOURCE IS NEVER DELETED here (plan §8.3):
  // the caller decides when to close the session.
  //
  // `options` is forwarded to buildFfmpegArgs; `{ audio: true }` muxes the recorded audio
  // track as AAC and `{ audio: false }` (also the legacy three-argument call) keeps `-an`.
  async transcode(sessionId, outputPath, onProgress = () => {}, options = {}) {
    const session = this.getSession(sessionId)
    if (!READABLE_STATES.includes(session.state)) throw new Error('录制会话尚未完成')
    if (session.process) throw new Error('MP4 正在转码')
    const target = path.resolve(String(outputPath || ''))
    if (!target.toLowerCase().endsWith('.mp4')) throw new Error('输出文件必须为 MP4')
    await fs.mkdir(path.dirname(target), { recursive: true })
    const args = buildFfmpegArgs(session.inputPath, target, options)

    return new Promise((resolve, reject) => {
      let stderr = ''
      let settled = false
      let lastProgress = -1
      const child = this.spawnProcess(this.ffmpegPath, args, {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe']
      })
      session.process = child

      const fail = async (error) => {
        if (settled) return
        settled = true
        session.process = null
        await fs.rm(target, { force: true }).catch(() => {})
        reject(error)
      }

      child.stderr?.on('data', (chunk) => {
        const text = String(chunk)
        stderr = `${stderr}${text}`.slice(-4000)
        const values = [...stderr.matchAll(/out_time_ms=(\d+)/g)].map((match) => Number(match[1]))
        for (const match of stderr.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)) {
          const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
          values.push(Math.round(seconds * 1_000_000))
        }
        for (const value of values) {
          if (value <= lastProgress) continue
          lastProgress = value
          onProgress(value)
        }
      })
      child.on('error', (error) => fail(new Error(`无法启动 MP4 编码组件：${error.message}`)))
      child.on('close', (code) => {
        if (settled) return
        if (code !== 0) {
          fail(new Error(`MP4 转码失败${stderr.trim() ? `：${stderr.trim()}` : ''}`))
          return
        }
        settled = true
        session.process = null
        resolve(target)
      })
    })
  }

  // Closes every session. Exports still holding a reference keep their source until they
  // release it, so a shutdown that runs late cannot pull a file out from under ffmpeg.
  // Project-owned sessions are only detached (their directories stay for the project
  // service, which flushes its manifests separately on shutdown).
  async dispose() {
    const ids = [...this.sessions.keys()]
    await Promise.all(ids.map((sessionId) => this.cleanupSession(sessionId).catch(() => false)))
    // Anything still referenced by a live export stays in `closing`; the last release
    // removes it (see releaseSource).
  }
}

module.exports = { MAX_APPEND_BYTES, READABLE_STATES, RecordingService }
