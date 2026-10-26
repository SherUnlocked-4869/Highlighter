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

class RecordingService {
  constructor({ tempRoot, ffmpegPath, spawnProcess = spawn, log = () => {}, probe = null }) {
    if (!tempRoot) throw new Error('录制临时目录不能为空')
    if (!ffmpegPath) throw new Error('FFmpeg 路径不能为空')
    this.tempRoot = path.resolve(tempRoot)
    this.ffmpegPath = ffmpegPath
    this.spawnProcess = spawnProcess
    this.log = typeof log === 'function' ? log : () => {}
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

  async startSession() {
    await fs.mkdir(this.tempRoot, { recursive: true })
    const id = randomUUID()
    const directory = path.join(this.tempRoot, id)
    const inputPath = path.join(directory, 'capture.webm')
    await fs.mkdir(directory, { recursive: false })
    await fs.writeFile(inputPath, Buffer.alloc(0))
    const session = {
      id,
      directory,
      inputPath,
      state: 'capturing',
      writeQueue: Promise.resolve(),
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
    return { id, directory, inputPath }
  }

  // Applies one documented transition, throwing a domain error on an illegal one.
  transitionSession(session, event) {
    const next = sessionTransition(session.state, event)
    if (!next) throw new Error(`录制会话状态不允许该操作：${session.state} -> ${event}`)
    session.state = next
    return next
  }

  async appendChunk(sessionId, value) {
    const session = this.getSession(sessionId)
    if (session.state !== 'capturing') throw new Error('录制会话已经结束')
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value)
    if (!buffer.length) return session.writeQueue
    session.writeQueue = session.writeQueue.then(() => fs.appendFile(session.inputPath, buffer))
    return session.writeQueue
  }

  // capturing -> finalizing -> ready. Returns the preview descriptor the renderer needs.
  // Deliberately does NOT probe and does NOT delete anything: the probe is a separate call
  // (`probeSession`) because it spawns ffmpeg, and deleting the source is `cleanupSession`.
  async finishSession(sessionId) {
    const session = this.getSession(sessionId)
    if (session.state === 'ready') {
      return this.previewDescriptor(session)
    }
    if (session.state !== 'capturing') throw new Error('录制会话已经结束')
    this.transitionSession(session, 'finalize')
    try {
      await session.writeQueue
      const stat = await fs.stat(session.inputPath)
      if (!stat.size) throw new Error('录制内容为空')
    } catch (error) {
      session.lastError = error?.message || String(error)
      try { this.transitionSession(session, 'fail') } catch {}
      throw error
    }
    this.transitionSession(session, 'ready')
    return this.previewDescriptor(session)
  }

  previewDescriptor(session) {
    const stat = { size: 0 }
    return {
      id: session.id,
      state: session.state,
      inputPath: session.inputPath,
      previewUrl: pathToFileURL(session.inputPath).href,
      metadata: session.metadata,
      bytesWritten: session.bytesWritten || stat.size
    }
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
    this.sessions.delete(session.id)
    if (session.process && typeof session.process.kill === 'function') {
      try { session.process.kill() } catch {}
      session.process = null
    }
    await session.writeQueue.catch((error) => this.log('Recording write failed:', error?.message || error))
    await fs.rm(session.directory, { recursive: true, force: true })
    session.state = 'closed'
    return true
  }

  // Closes a session and removes its directory once no export references the source.
  // Returns `true` when the directory is gone, `false` when the removal is deferred (the
  // session stays in `closing` and the last release completes it).
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
  async dispose() {
    const ids = [...this.sessions.keys()]
    await Promise.all(ids.map((sessionId) => this.cleanupSession(sessionId).catch(() => false)))
    // Anything still referenced by a live export stays in `closing`; the last release
    // removes it (see releaseSource).
  }
}

module.exports = { READABLE_STATES, RecordingService }
