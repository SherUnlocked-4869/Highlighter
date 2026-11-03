'use strict'

// Recording export task service (feature E1/E2, plan §8.3/§8.4:
// docs/plans/2026-10-25-snow-apps-feature-development-plan.md).
//
// Responsibility split (this is the core of E1):
//   * main/services/recording-service.js owns the SOURCE recording and its lifecycle;
//   * this service owns EXPORT TASKS: queueing, argv, ffmpeg progress, temp file,
//     verification, atomic publish, cancel arbitration and task status.
// It holds only a reference lease on the source (`recordingService.acquireSource()`), never
// the file itself, so a finished export can no longer delete the recording (the old
// `transcode -> cleanupSession` behaviour was exactly that bug).
//
// Task states (plan §8.3): queued -> running -> publishing -> succeeded; failure -> failed;
// cancel -> cancelling -> cancelled. The legal transitions and the guard rails live in
// shared/recording-export-options.js, which the renderer UI also loads, so the UI cannot
// show a state the service will never produce.
//
// Publish protocol (plan §8.4):
//   1. ffmpeg writes `<target>.<taskId>.part<ext>` in the TARGET'S directory, so the final
//      rename stays on one volume;
//   2. the temp file is verified with the media probe: decodable, right container/codec,
//      right dimensions, the selected span (within the documented tolerance) and the
//      expected audio-track presence;
//   3. only then does the task enter `publishing`, where cancel is refused. The target is
//      re-checked against the frozen snapshot taken when the save dialog closed; a change
//      means `target-changed` and the user's file is left untouched;
//   4. `fs.rename` replaces the target in one step. Any failure deletes ONLY our temp file;
//      the previous user file is never deleted first, and a plain rename is not claimed to
//      be power-loss safe (plan §8.4 says exactly that).
//
// No Electron import: fs/path/spawn are injected so the whole state machine is testable in
// plain node, including a fake ffmpeg that fails, hangs or is cancelled mid-encode.

const { spawn } = require('node:child_process')
const defaultFs = require('node:fs/promises')
const defaultPath = require('node:path')
const crypto = require('node:crypto')
const {
  LIMITS,
  buildExportArgs,
  durationToleranceMs,
  isTerminalTaskState,
  normalizeExportRequest,
  requestSignature,
  taskTransition
} = require('../../shared/recording-export-options')

const DEFAULTS = Object.freeze({
  ENCODE_TIMEOUT_MS: 30 * 60 * 1000,
  CANCEL_KILL_GRACE_MS: 5000
})

// Stable failure vocabulary. The renderer maps each code to a locale key; adding a code
// here without adding the key is caught by the trim-controller contract test.
const EXPORT_ERROR_CODES = Object.freeze([
  'session-not-found',
  'session-not-ready',
  'probe-unavailable',
  'probe-failed',
  'renderer-duration-disagrees',
  'invalid-request',
  'unsupported-format',
  'duration-unavailable',
  'range-out-of-bounds',
  'invalid-range',
  'range-too-short',
  // R4 export v2 (contract §4.1): multi-segment selection + video option validation.
  'ambiguous-selection',
  'too-many-segments',
  'overlapping-segments',
  'invalid-video-option',
  'fps-above-source',
  'empty-selection',
  // R5 demo-rendering validation (contract §3.2).
  'invalid-demo-option',
  'gif-too-long',
  'gif-invalid-fps',
  'gif-invalid-edge',
  'gif-loop-required',
  'gif-too-many-frames',
  'target-unavailable',
  'rate-limited',
  'request-mismatch',
  'task-not-found',
  'invalid-owner',
  'encode-failed',
  'verify-failed',
  'target-changed',
  'publish-failed',
  'publish-in-progress',
  'export-timeout'
])

function randomTaskId() {
  return `record-export-${crypto.randomUUID()}`
}

// '#rrggbb' -> { r, g, b }; the demo style validator already guarantees the format, this only
// converts it for sharp's composite/create inputs.
function hexToRgb(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!/^#[0-9a-f]{6}$/i.test(text)) return { r: 15, g: 17, b: 21 }
  return {
    r: parseInt(text.slice(1, 3), 16),
    g: parseInt(text.slice(3, 5), 16),
    b: parseInt(text.slice(5, 7), 16)
  }
}

class RecordingExportService {
  constructor({
    getRecordingService,
    probe = null,
    registerResult = null,
    writerCoordinator = null,
    spawnProcess = spawn,
    fs: fsImpl = defaultFs,
    path: pathImpl = defaultPath,
    now = Date.now,
    log = () => {},
    createTaskId = randomTaskId,
    limits = LIMITS,
    timeouts = {},
    // R5 demo rendering: sharp is loaded lazily (never for a plain R4 export) and injectable
    // so a unit test can prove the asset pipeline without spawning the native rasteriser.
    sharp: sharpImpl = null
  } = {}) {
    if (typeof getRecordingService !== 'function') {
      throw new TypeError('Recording export service requires a recording service resolver')
    }
    if (!fsImpl || typeof fsImpl.rename !== 'function' || typeof fsImpl.rm !== 'function') {
      throw new TypeError('Recording export service requires a file system')
    }
    if (!pathImpl || typeof pathImpl.dirname !== 'function') {
      throw new TypeError('Recording export service requires a path module')
    }
    this.getRecordingService = getRecordingService
    this.probe = probe
    this.registerResult = registerResult
    this.writerCoordinator = writerCoordinator
    this.spawnProcess = spawnProcess
    this.fs = fsImpl
    this.path = pathImpl
    this.now = now
    this.log = typeof log === 'function' ? log : () => {}
    this.createTaskId = createTaskId
    this.sharp = sharpImpl
    // Merge, never replace: a caller that overrides one limit (tests, a future setting) must not
    // silently disable the others - an undefined MAX_ACTIVE_TASKS would make the queue never run.
    this.limits = { ...LIMITS, ...(limits && typeof limits === 'object' ? limits : {}) }
    this.timeouts = {
      encode: Math.round(Number(timeouts.encode) || DEFAULTS.ENCODE_TIMEOUT_MS),
      cancelKillGrace: Math.round(Number(timeouts.cancelKillGrace) || DEFAULTS.CANCEL_KILL_GRACE_MS)
    }
    // Insertion-ordered: `list()` reads it as the queue order.
    this.tasks = new Map()
    // Replay index: `<owner>\u0000<session>\u0000<requestId>` -> taskId.
    this.requests = new Map()
    this.activeCount = 0
    this.queued = []
    // Admission slots taken by submit() calls that are still doing their pre-flight awaits. Without
    // this, N concurrent callers all pass the limit check before any of them reserves a place.
    this.reservedSlots = 0
    this.shuttingDown = false
  }

  // ---------- public task surface ----------

  // The ONLY shape a renderer ever sees (plan §8.3): no source path, no target path, no
  // argv. `receipt` is present exactly when a file was published.
  toPublicTask(task) {
    const publicTask = {
      taskId: task.taskId,
      state: task.state,
      requestId: task.requestId,
      sessionId: task.sessionId,
      format: task.request.format
    }
    // Plan §8.5: only a published export may report 100%. Every earlier state is capped at
    // 99 so the bar never claims completion before the file is actually in place.
    if (Number.isFinite(task.progress) && task.progress > 0) {
      publicTask.progress = task.state === 'succeeded' ? 100 : Math.min(99, Math.round(task.progress))
    }
    if (task.error) publicTask.error = { code: task.error.code }
    if (task.receipt) publicTask.receipt = task.receipt
    return publicTask
  }

  emit(task) {
    if (typeof task.onEvent !== 'function') return
    try {
      task.onEvent(this.toPublicTask(task))
    } catch (error) {
      this.log('Recording export event delivery failed:', error?.message || error)
    }
  }

  transition(task, event) {
    const next = taskTransition(task.state, event)
    if (!next) return false
    task.state = next
    return true
  }

  fail(task, code, detail) {
    if (isTerminalTaskState(task.state)) return false
    task.error = { code }
    if (detail) this.log('Recording export failed:', task.taskId, code, detail)
    // `publishing` cannot be cancelled but it can fail; every other pre-terminal state can
    // fail directly.
    if (task.state === 'publishing') task.state = 'failed'
    else if (!this.transition(task, 'fail')) task.state = 'failed'
    task.progress = 0
    this.emit(task)
    return true
  }

  // ---------- submit ----------

  // `input` is `{ sessionId, requestId, request, ownerId, targetPath, targetSnapshot, onEvent }`.
  // The path and its snapshot come from the main-process save dialog; NOTHING here accepts a
  // path from the renderer.
  async submit(input = {}) {
    if (this.shuttingDown) return { ok: false, code: 'rate-limited', detail: 'shutting-down' }
    const { sessionId, requestId, request, ownerId = null, targetPath, targetSnapshot = null, onEvent = null } = input
    if (typeof targetPath !== 'string' || !targetPath.trim()) return { ok: false, code: 'target-unavailable' }
    const absoluteTarget = this.path.resolve(targetPath)

    let recordingService
    let session
    try {
      recordingService = this.getRecordingService()
      if (!recordingService) return { ok: false, code: 'session-not-found' }
      session = recordingService.peekSession?.(sessionId) || null
      if (!session) return { ok: false, code: 'session-not-found' }
      if (session.state !== 'ready' && session.state !== 'closing') return { ok: false, code: 'session-not-ready' }
    } catch (error) {
      this.log('Recording export could not resolve its session:', error?.message || error)
      return { ok: false, code: 'session-not-found' }
    }

    // A target that IS the recording's own source would be replaced by the trimmed output: the
    // publish rename sits in the target's directory and happily overwrites it, so a user who picks
    // the `.webm` in the save dialog would lose the only copy of the recording AND get a success
    // toast. Refuse before any temp file exists. (The save dialog is main-process owned, so this is
    // a rare navigation, but the consequence is unrecoverable - and §8.4's promise is that an export
    // never damages the source.)
    const sessionSource = (() => {
      try {
        return session.inputPath ? this.path.resolve(session.inputPath) : ''
      } catch (error) {
        return ''
      }
    })()
    if (sessionSource && this.samePath(absoluteTarget, sessionSource)) {
      return { ok: false, code: 'target-unavailable', detail: 'target-is-source' }
    }

    // The range is validated against the PROBE, never against the renderer's duration
    // (plan §8.1). A session that was never probed is probed now.
    let metadata = session.metadata
    if (!metadata) {
      const probed = await recordingService.probeSession(sessionId)
      if (!probed?.ok) return { ok: false, code: probed?.code === 'probe-unavailable' ? 'probe-unavailable' : 'probe-failed' }
      metadata = probed.metadata
    }
    const normalized = normalizeExportRequest(request, metadata)
    if (!normalized.ok) return { ok: false, code: normalized.code }

    // Replay / mismatch (plan §8.3): same requestId + same parameters returns the same task;
    // different parameters under the same key is a client bug, not a new export.
    const requestKey = this.requestKey(ownerId, sessionId, requestId)
    const signature = requestSignature({ ...normalized.value })
    const replayId = requestKey ? this.requests.get(requestKey) : null
    if (replayId) {
      const existing = this.tasks.get(replayId)
      if (existing && existing.signature === signature) return { ok: true, task: this.toPublicTask(existing), replayed: true }
      return { ok: false, code: 'request-mismatch' }
    }

    // Queue guard rails (plan §3.3): one encoder, at most two waiting.
    //
    // RESERVE-THEN-AWAIT: this check happens BEFORE any await below, so N concurrent submit() calls
    // all observe the same counts and all pass - five double-clicks were admitted where the plan
    // allows three. A synchronous reservation therefore counts as an outstanding admission until it
    // becomes a real queue entry, and the budget is the TOTAL outstanding work: one running plus two
    // waiting. (Checking "active" and "waiting" separately double-counted the reservation, which
    // admitted only two.)
    const outstanding = this.activeCount + this.queued.length + this.reservedSlots
    if (outstanding >= this.limits.MAX_ACTIVE_TASKS + this.limits.MAX_QUEUED_TASKS) {
      return { ok: false, code: 'rate-limited' }
    }
    this.reservedSlots += 1
    const releaseSlot = () => { this.reservedSlots = Math.max(0, this.reservedSlots - 1) }

    const extension = normalized.value.format === 'gif'
      ? '.gif'
      : normalized.value.format === 'webm' ? '.webm' : '.mp4'
    let tempPath
    try {
      tempPath = this.tempPathFor(absoluteTarget, extension)
      // Fail before queueing when the target directory is not writable: a task that dies at
      // encode time would burn a full encode for nothing.
      await this.fs.mkdir(this.path.dirname(absoluteTarget), { recursive: true })
      const handle = await this.fs.open(tempPath, 'wx')
      await handle.close()
      await this.fs.rm(tempPath, { force: true })
    } catch (error) {
      releaseSlot()
      this.log('Recording export target is not writable:', error?.message || error)
      return { ok: false, code: 'target-unavailable' }
    }

    const task = {
      taskId: this.createTaskId(),
      sessionId,
      requestId,
      ownerId: ownerId || '',
      signature,
      request: normalized.value,
      expected: {
        ...normalized.value
      },
      state: 'queued',
      progress: 0,
      error: null,
      receipt: null,
      tempPath,
      targetPath: absoluteTarget,
      // Frozen here, immediately after the save dialog closed (plan §8.4: "accept then
      // freeze the target"). The publish step re-checkes it to detect a competing write.
      targetSnapshot: targetSnapshot || await this.snapshotTarget(absoluteTarget).catch(() => this.snapshotOf(null)),
      createdAt: this.now(),
      child: null,
      onEvent: typeof onEvent === 'function' ? onEvent : null,
      cancelRequested: false,
      lease: null,
      encodeResult: null
    }
    this.tasks.set(task.taskId, task)
    if (requestKey) this.requests.set(requestKey, task.taskId)
    // The reservation has become a real queue entry, so release the placeholder before enqueueing
    // (enqueue -> pump() may start the task synchronously and would otherwise double-count).
    releaseSlot()
    // Emit `queued` BEFORE the queue runs: pump() may start the task synchronously, and a caller
    // that renders from `onEvent` must see the task's first state, not its second one.
    this.emit(task)
    this.enqueue(task)
    return { ok: true, task: this.toPublicTask(task) }
  }

  requestKey(ownerId, sessionId, requestId) {
    if (!requestId) return ''
    return `${ownerId || '-'}\u0000${String(sessionId || '')}\u0000${String(requestId || '')}`
  }

  // Case-insensitive on Windows/macOS, case-sensitive elsewhere: two names that differ only by case
  // are the SAME file on a default NTFS volume, so a plain string compare would miss
  // `capture.webm` vs `Capture.webm` in the "target is the source" guard.
  samePath(left, right) {
    const a = String(left || '')
    const b = String(right || '')
    if (!a || !b) return false
    const caseInsensitive = this.path.sep === '\\' || process.platform === 'darwin'
    return caseInsensitive
      ? a.toLowerCase() === b.toLowerCase()
      : a === b
  }

  // A unique sibling of the target, sharing its extension so ffmpeg picks the right muxer.
  // The task id makes it unique; `crypto.randomUUID` covers two services in one process.
  tempPathFor(targetPath, extension) {
    const directory = this.path.dirname(targetPath)
    const base = this.path.basename(targetPath).replace(/\.[^.]*$/, '') || 'recording'
    const suffix = `${base}.${crypto.randomUUID().slice(0, 8)}.part${extension}`
    return this.path.join(directory, suffix)
  }

  // Snapshot used to detect a competing modification between "user chose this path" and
  // "we are about to replace it" (plan §8.4). A missing target is a valid snapshot.
  snapshotOf(stat) {
    if (!stat) return { exists: false, size: 0, mtimeMs: 0 }
    return {
      exists: true,
      size: Number(stat.size) || 0,
      mtimeMs: Math.round(Number(stat.mtimeMs) || 0)
    }
  }

  async snapshotTarget(targetPath) {
    try {
      return this.snapshotOf(await this.fs.stat(targetPath))
    } catch (error) {
      if (error?.code === 'ENOENT') return this.snapshotOf(null)
      throw error
    }
  }

  // ---------- queue ----------

  enqueue(task) {
    this.queued.push(task.taskId)
    this.pump()
  }

  pump() {
    if (this.shuttingDown) return
    while (this.activeCount < this.limits.MAX_ACTIVE_TASKS && this.queued.length) {      const taskId = this.queued.shift()
      const task = this.tasks.get(taskId)
      if (!task || task.state !== 'queued') continue
      this.activeCount += 1
      // The coordinator tracks the WHOLE run, not just the invoke: data-root migration and
      // app exit must wait for a background encode (plan §8.3).
      const run = this.runTask(task).finally(() => {
        this.activeCount = Math.max(0, this.activeCount - 1)
        this.pump()
      })
      const tracked = this.writerCoordinator?.track
        ? this.writerCoordinator.track(run, { allowBlocked: false })
        : run
      tracked.catch((error) => {
        this.log('Recording export task crashed:', error?.message || error)
        if (!isTerminalTaskState(task.state)) this.fail(task, 'encode-failed', error?.message)
        this.cleanupTemp(task).catch(() => {})
      })
    }
  }

  async runTask(task) {
    if (task.cancelRequested) {
      // Cancelled while queued: nothing was spawned, so this is an immediate transition.
      this.transition(task, 'cancel')
      this.transition(task, 'cancelled')
      this.emit(task)
      return
    }
    if (task.state !== 'queued') return
    this.transition(task, 'run')
    this.emit(task)
    let lease
    try {
      lease = this.getRecordingService().acquireSource(task.sessionId)
    } catch (error) {
      this.fail(task, 'session-not-ready', error?.message)
      return
    }
    task.lease = lease
    try {
      await this.encode(task, lease)
      if (task.state === 'cancelling') return this.finishCancelled(task)
      if (task.cancelRequested) {
        this.transition(task, 'cancel')
        return this.finishCancelled(task)
      }
      const verified = await this.verify(task)
      // Cancel checkpoint BEFORE the failure branch: `verify` is awaited, so a cancel can land
      // inside it (and cancelTask has already answered {ok:true, state:'cancelling'}). Consulting
      // cancelRequested only on the success path meant such a cancel was swallowed and reported as
      // `verify-failed` - a contradictory pair of outcomes for one user action, with the wrong cause.
      if (task.cancelRequested || task.state === 'cancelling') {
        if (task.state !== 'cancelling') this.transition(task, 'cancel')
        return this.finishCancelled(task)
      }
      if (!verified.ok) {
        // Clean up BEFORE reporting the terminal state: a caller that observes `failed` must also
        // observe that our `.part` file is gone, otherwise every failed attempt looks like a leak
        // to an immediate directory listing (plan §8.4: a failure removes only its own temp file).
        await this.cleanupTemp(task)
        this.fail(task, 'verify-failed', verified.code)
        return
      }
      // Cancel checkpoint: verification is done but nothing has been replaced yet, so a
      // cancel that arrived between the check above and here still wins (plan §8.4 "before the
      // publish point"). The check and the transition below are synchronous, so there is no window
      // between them.
      if (task.cancelRequested || task.state === 'cancelling') {
        if (task.state !== 'cancelling') this.transition(task, 'cancel')
        return this.finishCancelled(task)
      }
      if (!this.transition(task, 'publish')) return this.finishCancelled(task)
      this.emit(task)
      await this.publish(task)
    } catch (error) {
      if (task.state === 'cancelling' || task.cancelRequested) {
        if (task.state !== 'cancelling') this.transition(task, 'cancel')
        return this.finishCancelled(task)
      }
      // Any other throw leaves our temp file behind; remove it before reporting failure so the
      // observable end state is "failed and no stray file" (plan §8.4).
      await this.cleanupTemp(task)
      this.fail(task, 'encode-failed', error?.message || String(error))
    } finally {
      task.lease = null
      try { lease.release() } catch (error) { this.log('Recording source release failed:', error?.message || error) }
    }
  }

  // ---------- encode ----------

  async encode(task, lease) {
    // R5 §3.3: the demo look/camera plan needs raster assets (background/mask/ripple) before
    // the graph can name them. They live beside the temp file and are removed by the same
    // cleanup discipline. A plain R4 export never touches sharp.
    let demoAssets = null
    if (task.request.demo && task.request.demo.rendered === true) {
      demoAssets = await this.buildDemoAssets(task)
    }
    // The normalised request is the single source of truth for the assembly (§4.3). Spread
    // it so segments/video/demo/hasAudio reach buildExportArgs exactly as the UI was
    // validated against; only the main-process-owned paths/assets are added here.
    const { args } = buildExportArgs({
      ...task.request,
      inputPath: lease.inputPath,
      outputPath: task.tempPath,
      demoAssets
    })
    const spanMs = Number(task.request.totalDurationMs) || 0

    return new Promise((resolve, reject) => {
      let settled = false
      let stderr = ''
      let lastProgress = 0
      const settle = (error) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        task.encodeResult = { code: error ? 1 : 0, stderr: stderr.slice(-4000) }
        // A failed or timed-out encode cleans up its own temp file here, so a caller that only
        // reports the failure cannot leave a stray `.part` file beside the user's target.
        if (error) void this.cleanupTemp(task)
        if (error) reject(error)
        else resolve()
      }
      const timeout = setTimeout(() => {
        try { task.child?.kill('SIGKILL') } catch {}
        settle(new Error('export-timeout'))
      }, this.timeouts.encode)
      timeout.unref?.()

      let child
      let ffmpegPath = ''
      try {
        ffmpegPath = this.getRecordingService().ffmpegPath
      } catch (error) {
        settle(new Error(`无法解析编码组件：${error?.message || error}`))
        return
      }
      try {
        child = this.spawnProcess(ffmpegPath, args, {
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'pipe']
        })
      } catch (error) {
        settle(new Error(`无法启动编码组件：${error?.message || error}`))
        return
      }
      task.child = child
      child.stderr?.on('data', (chunk) => {
        const text = String(chunk)
        stderr = `${stderr}${text}`.slice(-4000)
        // `-progress pipe:2` writes key=value lines; out_time_us is the reliable field
        // (out_time_ms is microseconds on some ffmpeg builds).
        for (const match of text.matchAll(/out_time_us=(\d+)/g)) {
          const elapsedMs = Number(match[1]) / 1000
          const progress = spanMs > 0 ? Math.max(0, Math.min(99, (elapsedMs / spanMs) * 100)) : 0
          if (progress <= lastProgress) continue
          lastProgress = progress
          task.progress = progress
          this.emit(task)
        }
      })
      child.on('error', (error) => settle(new Error(`无法启动编码组件：${error?.message || error}`)))
      child.on('close', (code) => {
        task.child = null
        if (code === 0) settle(null)
        else settle(new Error(stderr.trim() ? `ffmpeg: ${stderr.trim().split('\n').slice(-1)[0]}` : `ffmpeg exit ${code}`))
      })
    })
  }

  // ---------- verify ----------

  // Decodable + right format + right dimensions + the selected span + the expected audio
  // track. Runs on the temp file BEFORE the target is touched, which is what makes a failed
  // export unable to damage the user's previous file (plan §8.4).
  async verify(task) {
    if (!this.probe || typeof this.probe.probe !== 'function') return { ok: false, code: 'probe-unavailable' }
    let stat
    try {
      stat = await this.fs.stat(task.tempPath)
    } catch {
      return { ok: false, code: 'missing-temp-file' }
    }
    if (!Number.isFinite(stat.size) || stat.size <= 0) return { ok: false, code: 'empty-temp-file' }

    const probed = await this.probe.probe(task.tempPath)
    if (!probed?.ok) return { ok: false, code: probed?.code || 'unreadable-temp-file' }
    const metadata = probed.metadata
    const expected = task.request
    if (!metadata.video) return { ok: false, code: 'no-video-track' }
    // Expected output dimensions: R5 demo films are the resolved CANVAS size; otherwise the
    // video options' computed width/height for mp4/webm (source size on the copy path, never-
    // upscaled preset otherwise), gif dimensions for GIF.
    const demo = expected.demo && expected.demo.rendered === true ? expected.demo : null
    const expectedWidth = expected.format === 'gif'
      ? expected.gif?.width
      : demo ? demo.canvasWidth : expected.video?.width
    const expectedHeight = expected.format === 'gif'
      ? expected.gif?.height
      : demo ? demo.canvasHeight : expected.video?.height
    if (expectedWidth && metadata.video.width !== expectedWidth) {
      return { ok: false, code: `unexpected-width:${metadata.video.width}` }
    }
    if (expectedHeight && metadata.video.height !== expectedHeight) {
      return { ok: false, code: `unexpected-height:${metadata.video.height}` }
    }
    const expectedDurationMs = Number(expected.totalDurationMs) || 0
    const tolerance = durationToleranceMs(expectedDurationMs, {
      isGif: expected.format === 'gif',
      segments: Array.isArray(expected.segments) ? expected.segments.length : 1,
      sourceFps: expected.sourceFrameRate
    })
    if (Math.abs(metadata.durationMs - expectedDurationMs) > tolerance) {
      return { ok: false, code: `unexpected-duration:${metadata.durationMs}` }
    }
    const hasAudio = metadata.audio?.exists === true
    if (hasAudio !== (expected.hasAudio === true)) return { ok: false, code: 'unexpected-audio-track' }
    return { ok: true, metadata }
  }

  // ---------- publish ----------

  async publish(task) {
    // Competing modification check: the snapshot was taken when the save dialog closed.
    let current
    try {
      current = await this.snapshotTarget(task.targetPath)
    } catch (error) {
      this.fail(task, 'publish-failed', error?.message)
      await this.cleanupTemp(task)
      return
    }
    const frozen = task.targetSnapshot
    const unchanged = current.exists === frozen.exists &&
      current.size === frozen.size &&
      current.mtimeMs === frozen.mtimeMs
    if (!unchanged) {
      this.fail(task, 'target-changed', 'the target was modified while the export ran')
      await this.cleanupTemp(task)
      return
    }
    try {
      // One atomic replace on the same volume. Deliberately NOT "delete old, then rename":
      // a failure here must leave the previous file readable (plan §8.4).
      await this.fs.rename(task.tempPath, task.targetPath)
    } catch (error) {
      this.fail(task, 'publish-failed', error?.message)
      await this.cleanupTemp(task)
      return
    }
    this.transition(task, 'succeed')
    task.progress = 100
    task.receipt = this.makeReceipt(task)
    this.emit(task)
    // A published export no longer needs its raster assets; the temp file itself was renamed.
    await this.cleanupDemoAssets(task)
  }

  // The plan §4.2 receipt, reused verbatim so the result bar and the tray work unchanged.
  // A missing registrar (tests, or a host that has not wired feature A) degrades to no
  // receipt rather than to a path: a renderer must never receive one.
  makeReceipt(task) {
    if (typeof this.registerResult !== 'function') return null
    try {
      return this.registerResult({
        filePath: task.targetPath,
        kind: task.request.format,
        source: 'record-export',
        ownerId: task.ownerId || null,
        requestId: task.requestId
      }) || null
    } catch (error) {
      this.log('Recording export receipt registration failed:', error?.message || error)
      return null
    }
  }

  // ---------- cancel ----------

  async cancel({ taskId, ownerId = null } = {}) {
    const task = this.tasks.get(String(taskId || ''))
    if (!task) return { ok: false, code: 'task-not-found' }
    if (!this.ownerMayAct(task, ownerId)) return { ok: false, code: 'invalid-owner' }
    return this.cancelTask(task)
  }

  ownerMayAct(task, ownerId) {
    if (!task.ownerId) return true
    return String(ownerId || '') === task.ownerId
  }

  cancelTask(task) {
    if (task.state === 'succeeded') {
      // Plan §8.4: a late cancel never deletes a published product and never rewrites the
      // outcome to `cancelled`.
      return { ok: true, state: task.state, late: true, task: this.toPublicTask(task) }
    }
    if (task.state === 'publishing') {
      // The publish point has passed: report it as in progress instead of pretending the
      // cancel took effect.
      return { ok: false, code: 'publish-in-progress', state: task.state, task: this.toPublicTask(task) }
    }
    if (task.state === 'failed' || task.state === 'cancelled') {
      return { ok: true, state: task.state, task: this.toPublicTask(task) }
    }
    task.cancelRequested = true
    if (task.state === 'queued') {
      this.transition(task, 'cancel')
      this.transition(task, 'cancelled')
      // Drop the id from the waiting list NOW, not on the next pump(): pump() only runs when a task
      // completes, so a cancelled waiter used to occupy a queue slot for the whole duration of the
      // running encode and made the next legitimate submit fail with a spurious `rate-limited`.
      this.queued = this.queued.filter((id) => id !== task.taskId)
      this.emit(task)
      return { ok: true, state: task.state, task: this.toPublicTask(task) }
    }
    if (task.state === 'running') {
      this.transition(task, 'cancel')
      this.emit(task)
      // The temp file is removed by finishCancelled() only after the child has exited: an
      // ffmpeg writing into a deleted path on Windows would fail confusingly.
      try { task.child?.kill('SIGKILL') } catch (error) { this.log('Recording export kill failed:', error?.message || error) }
      return { ok: true, state: task.state, task: this.toPublicTask(task) }
    }
    return { ok: true, state: task.state, task: this.toPublicTask(task) }
  }

  async finishCancelled(task) {
    if (task.state !== 'cancelling') this.transition(task, 'cancel')
    await this.cleanupTemp(task)
    if (task.state === 'cancelling') this.transition(task, 'cancelled')
    task.progress = 0
    // A cancelled task must not carry the code of whatever was in flight when the user aborted:
    // the terminal outcome is "the user stopped this", not "verification failed". Leaving a stale
    // `error` made the renderer's error path render for a task it had just been told was cancelling.
    task.error = null
    this.emit(task)
    return true
  }

  // Only ever the task's own temp file. The target path is never touched by a cancel or a
  // failure (plan §8.4).
  async cleanupTemp(task) {
    let removed = false
    if (task.tempPath) {
      try {
        await this.fs.rm(task.tempPath, { force: true })
        removed = true
      } catch (error) {
        this.log('Recording export temp cleanup failed:', error?.message || error)
      }
    }
    await this.cleanupDemoAssets(task)
    return removed
  }

  // Removes the raster assets generated for a demo render (background/mask/ripple). Separate
  // from cleanupTemp so the publish success path (temp renamed away) still clears them.
  async cleanupDemoAssets(task) {
    const assets = task?.demoAssets
    if (!assets) return false
    task.demoAssets = null
    const targets = [assets.bgPath, assets.maskPath, assets.ripplePath].filter((target) => typeof target === 'string' && target)
    for (const target of targets) {
      try {
        await this.fs.rm(target, { force: true })
      } catch (error) {
        this.log('Recording demo asset cleanup failed:', error?.message || error)
      }
    }
    return targets.length > 0
  }

  // ---------- R5 demo raster assets ----------

  async loadSharp() {
    if (this.sharp) return this.sharp
    try {
      const sharp = require('sharp')
      this.sharp = sharp
      return sharp
    } catch (error) {
      throw new Error(`demo-renderer-unavailable: ${error?.message || error}`)
    }
  }

  // Builds bg.png / mask.png / ripple.png beside the task's temp file. Asset names are derived
  // from the unique temp basename so two concurrent exports can never collide. Everything is
  // tracked on task.demoAssets so cleanupTemp/publish remove it.
  async buildDemoAssets(task) {
    const demo = task.request.demo
    const sharp = await this.loadSharp()
    const directory = this.path.dirname(task.tempPath)
    const base = this.path.basename(task.tempPath)
    const assets = { bgPath: '', maskPath: '', ripplePath: '' }
    task.demoAssets = assets
    const contentWidth = Math.round(Number(demo.contentWidth) || 0)
    const contentHeight = Math.round(Number(demo.contentHeight) || 0)
    const canvasWidth = Math.round(Number(demo.canvasWidth) || 0)
    const canvasHeight = Math.round(Number(demo.canvasHeight) || 0)
    const radiusPx = Math.max(0, Math.round(Number(demo.radiusPx) || 0))
    const offsetX = Math.max(0, Math.round((canvasWidth - contentWidth) / 2))
    const offsetY = Math.max(0, Math.round((canvasHeight - contentHeight) / 2))
    const needsCanvas = canvasWidth > contentWidth || canvasHeight > contentHeight || radiusPx > 0
    const background = hexToRgb(demo.style?.background)

    if (needsCanvas) {
      const bgPath = this.path.join(directory, `${base}.bg.png`)
      assets.bgPath = bgPath
      const baseImage = sharp({
        create: { width: canvasWidth, height: canvasHeight, channels: 4, background: { ...background, alpha: 1 } }
      })
      const layers = []
      if (demo.style?.shadow === true && (canvasWidth > contentWidth || canvasHeight > contentHeight)) {
        // Soft black rounded rectangle behind the content area. Rasterise the SVG, blur it, and
        // composite slightly offset so the shadow reads as depth instead of a hard frame.
        const shadowSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${contentWidth}" height="${contentHeight}">` +
          `<rect x="0" y="0" width="${contentWidth}" height="${contentHeight}" rx="${radiusPx}" fill="#000000" fill-opacity="0.55"/></svg>`
        const sigma = Math.max(4, Math.round(contentWidth * 0.008))
        const shadow = await sharp(Buffer.from(shadowSvg)).blur(sigma).png().toBuffer()
        const shadowOffset = Math.max(2, Math.round(contentWidth * 0.004))
        layers.push({
          input: shadow,
          left: Math.max(0, Math.min(canvasWidth - 1, offsetX + shadowOffset)),
          top: Math.max(0, Math.min(canvasHeight - 1, offsetY + shadowOffset)),
          blend: 'over'
        })
      }
      let pipeline = baseImage
      if (layers.length) pipeline = sharp(await pipeline.png().toBuffer()).composite(layers)
      await pipeline.png().toFile(bgPath)

      if (radiusPx > 0) {
        const maskPath = this.path.join(directory, `${base}.mask.png`)
        assets.maskPath = maskPath
        // alphamerge reads the second input's GRAYSCALE as alpha: white = opaque content.
        const maskSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${contentWidth}" height="${contentHeight}">` +
          `<rect width="100%" height="100%" fill="#000000"/>` +
          `<rect x="0" y="0" width="${contentWidth}" height="${contentHeight}" rx="${radiusPx}" fill="#ffffff"/></svg>`
        await sharp(Buffer.from(maskSvg)).png().toFile(maskPath)
      }
    }

    if (demo.style?.ripples === true && Array.isArray(demo.clicks) && demo.clicks.length) {
      const ripplePath = this.path.join(directory, `${base}.ripple.png`)
      assets.ripplePath = ripplePath
      // Soft white ring: transparent centre/outer edge, bright band around 0.78 of the radius.
      // The filter graph scales it per frame, so one asset serves every click.
      const size = 56
      const rippleSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
        '<defs><radialGradient id="ring">' +
        '<stop offset="0.55" stop-color="#ffffff" stop-opacity="0"/>' +
        '<stop offset="0.78" stop-color="#ffffff" stop-opacity="0.92"/>' +
        '<stop offset="1" stop-color="#ffffff" stop-opacity="0"/>' +
        '</radialGradient></defs>' +
        `<circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="url(#ring)"/></svg>`
      await sharp(Buffer.from(rippleSvg)).png().toFile(ripplePath)
    }
    return assets
  }

  // ---------- status ----------

  // `{ taskId }` or `{ sessionId, requestId }` (plan §8.3: "query by taskId or by the same
  // session's requestId, to compensate a lost receipt"). Owner-checked in both directions.
  status({ taskId, sessionId, requestId, ownerId = null } = {}) {
    let task = taskId ? this.tasks.get(String(taskId)) : null
    if (!task && requestId) {
      const key = this.requestKey(ownerId, sessionId, requestId)
      const foundId = key ? this.requests.get(key) : null
      if (foundId) task = this.tasks.get(foundId)
      if (!task) {
        // The owner id is part of the replay key, so a status query without one cannot find
        // the task; scan the same owner's tasks for the requestId instead of failing.
        task = [...this.tasks.values()].find((entry) => (
          entry.requestId === String(requestId) && (!ownerId || this.ownerMayAct(entry, ownerId))
        )) || null
      }
    }
    if (!task) return { ok: false, code: 'task-not-found' }
    if (!this.ownerMayAct(task, ownerId)) return { ok: false, code: 'invalid-owner' }
    return { ok: true, task: this.toPublicTask(task) }
  }

  // Newest first; test/debug surface and the shutdown gate.
  list() {
    return [...this.tasks.values()].map((task) => this.toPublicTask(task))
  }

  hasActiveTasks() {
    return this.activeCount > 0 || this.queued.length > 0
  }

  // ---------- shutdown ----------

  // Cancels everything and waits for the children to actually exit. Plan §8.4: the shutdown
  // path must not report an unverified file as success, so running tasks are cancelled rather
  // than allowed to publish.
  async dispose() {
    this.shuttingDown = true
    this.queued = []
    const pending = []
    for (const task of this.tasks.values()) {
      if (task.state === 'queued' || task.state === 'running') {
        pending.push(this.cancelTask(task))
      }
    }
    await Promise.allSettled(pending)
    // Wait (bounded) for every child to be gone before the caller removes directories.
    const deadline = this.now() + this.timeouts.cancelKillGrace
    while (this.activeCount > 0 && this.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
}

function createRecordingExportService(options) {
  return new RecordingExportService(options)
}

module.exports = {
  EXPORT_ERROR_CODES,
  RecordingExportService,
  createRecordingExportService
}
