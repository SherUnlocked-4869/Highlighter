'use strict'
const { EventEmitter } = require('node:events')
const { spawn } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')
const { FrameDecoder, encodeFrame } = require('../../shared/clipboard-protocol')
const { nativeRules } = require('./clipboard-settings')
const { POLL_REVISION_FRESH_MS, isHealthEvent, pollIsStable, nextPollDelay } = require('./clipboard-poll-policy')
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const failure = (code) => Object.assign(new Error(code), { code })
// B01 (plan item 05): the private publication's own constants. The PNG signature is
// re-checked here so a non-image never reaches the sidecar, and the size ceiling matches
// the sidecar's.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const MAX_PUBLISH_BYTES = 64 * 1024 * 1024
// A busy clipboard or an interrupted publication is worth another attempt; a missing
// writer or a failed marker is not.
const PUBLISH_RETRYABLE = new Set(['CLIPBOARD_BUSY', 'COPY_INTERRUPTED', 'QUIESCING', 'BACKPRESSURE', 'BACKEND_TIMEOUT'])

const outcomeFailure = (method, code) => method === 'copy' ? 'COPY_OUTCOME_UNKNOWN' : ['paste.prepare', 'paste.commit'].includes(method) ? 'PASTE_OUTCOME_UNKNOWN' : code

class ClipboardService extends EventEmitter {
  constructor({ executable, directory, getHook, spawnChild = spawn, now = () => Date.now(), setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout }) {
    super()
    Object.assign(this, { executable, directory, getHook, spawnChild, now, setTimeoutFn, clearTimeoutFn })
    this.child = null; this.epoch = null; this.pending = new Map()
    this.settings = null; this.reasons = new Set(); this.serial = Promise.resolve()
    this.generation = 0; this.coordinatedPid = null; this.disposed = false
    this.status = { enabled: false, userPaused: false, available: false, phase: 'disabled', pausedReasons: [], datasetId: null, revision: null, itemCount: 0, pinnedCount: 0, payloadBytes: 0, actualDiskBytes: 0, pendingGcBytes: 0 }
    this.pollTimer = null; this.retryTimer = null; this.retryCount = 0; this.unsubscribeHook = null
    // C03 scheduler state. panelVisible starts false because the panel is created
    // lazily; run() therefore arms the hidden cadence and the first show() asks
    // for an immediate refresh.
    this.panelVisible = false; this.pollFailed = false; this.gcBacklog = false; this.gcBacklogPending = false
    this.maintenancePending = false; this.maintainedAt = 0; this.gcMaintainedAt = 0
    this.lastRefreshAt = 0; this.lastHealthEvent = null
  }
  snapshot() { return structuredClone(this.status) }
  allowPasteForeground() {
    const child = this.child
    if (process.platform !== 'win32' || !child || this.stopping || this.disposed || !Number.isInteger(child.pid) || child.pid <= 0 || child.pid >= 0xffffffff) return false
    try { return require('selection-hook').allowSetForegroundWindow(child.pid) === true }
    catch { return false }
  }
  publish(patch) {
    this.status = { ...this.status, ...patch, enabled: this.settings?.enabled === true, userPaused: this.settings?.paused === true, pausedReasons: [...this.reasons] }
    this.emit('status', this.snapshot())
  }
  apply(settings) { this.settings = structuredClone(settings); this.retryCount = 0; return this.reconcile() }
  setReason(reason, paused) {
    if (reason === 'migration' && !paused) this.quiescing = false
    if (this.reasons.has(reason) === paused) return this.serial
    if (paused) this.reasons.add(reason); else this.reasons.delete(reason)
    return this.reconcile()
  }
  retry() {
    if (this.retryTimer || !this.settings?.enabled || this.disposed || this.stopping || this.retryCount >= 3) return
    const wait = [1000, 5000, 30000][this.retryCount++]
    this.retryTimer = this.setTimeoutFn(() => { this.retryTimer = null; this.reconcile() }, wait)
    this.retryTimer?.unref?.()
  }
  reconcile() {
    const generation = ++this.generation
    this.clearRetryTimer()
    this.serial = this.serial.catch(() => {}).then(async () => {
      if (generation !== this.generation || this.disposed) return
      try { await this.run(generation) }
      catch (error) {
        await this.terminate().catch(() => {})
        this.publish({ phase: 'error', available: false, messageKey: error.code || 'BACKEND_UNAVAILABLE' })
        if (generation === this.generation) this.retry()
      }
    })
    return this.serial
  }
  bindHook(hook) {
    if (this.boundHook === hook) return
    this.unsubscribeHook?.(); this.boundHook = hook
    this.unsubscribeHook = hook?.onLifecycle((status) => {
      if (!this.quiescing && !this.stopping && !this.disposed && this.settings?.enabled && status.hostPid !== this.coordinatedPid) this.reconcile()
    }) || null
  }
  async run(generation) {
    const hook = this.getHook()
    this.bindHook(hook)
    if (!this.settings?.enabled) {
      await this.stop()
      hook?.setClipboardCoordinationRequired(false)
      this.publish({ phase: 'disabled', available: false, messageKey: null })
      return
    }
    this.publish({ phase: 'starting', messageKey: null })
    hook?.setClipboardCoordinationRequired(true)
    await hook?.waitForRetiredHosts()
    if (generation !== this.generation) return
    if (!this.child) await this.launch()
    await this.request('configure', { enabled: false, rules: nativeRules(this.settings) })
    if (generation !== this.generation) return
    let host = hook?.getDiagnostics()
    if (!host?.running || !host.hostPid) {
      this.publish({ phase: 'paused', available: true, messageKey: 'SELECTION_NOT_READY' })
      this.schedulePoll(); return
    }
    if (this.coordinatedPid !== host.hostPid) {
      if (this.coordinatedPid) {
        const current = await this.request('coordination.status')
        if (current.phase === 'Orphaned') await this.request('coordination.recover')
        await this.request('coordination.stop')
      }
      const endpoint = await this.request('coordination.start', { hostPid: host.hostPid })
      const reply = await hook.configureClipboardCoordinator(endpoint)
      host = hook.getDiagnostics()
      if (!reply.ok || host.hostPid !== endpoint.hostPid || !host.running) throw failure(reply.code || 'HOST_CHANGED')
      this.coordinatedPid = host.hostPid
    }
    if (generation !== this.generation) return
    const capture = !this.settings.paused && this.reasons.size === 0
    await this.request('configure', { enabled: capture })
    this.publish({ phase: capture ? 'running' : 'paused', available: true })
    await this.refresh()
    this.schedulePoll(this.takeBacklogEvent())
  }
  async launch() {
    if (this.retiredExit) await this.waitForExit(this.retiredExit)
    const manifest = JSON.parse(await fs.readFile(path.join(path.dirname(this.executable), 'build-info.json'), 'utf8'))
    if (manifest.protocolVersion !== 1 || !/^hl_[a-f0-9]{64}$/.test(manifest.nativeBuildId || '')) throw failure('INCOMPATIBLE_BACKEND')
    const child = this.spawnChild(this.executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child; this.epoch = null; this.coordinatedPid = null
    this.exited = new Promise((resolve) => child.once('close', resolve))
    const decoder = new FrameDecoder()
    child.stdout.on('data', (chunk) => {
      if (this.child !== child) return
      try {
        for (const { header, payload } of decoder.feed(chunk)) {
          if (header.type !== 'response' || header.version !== 1 || typeof header.sessionEpoch !== 'string' || (this.epoch && header.sessionEpoch !== this.epoch)) throw failure('PROTOCOL_FAILED')
          const pending = this.pending.get(header.requestId)
          if (!pending) continue
          if (!this.epoch && pending.method !== 'initialize') throw failure('PROTOCOL_FAILED')
          this.epoch = header.sessionEpoch
          this.pending.delete(header.requestId); clearTimeout(pending.timer)
          if (header.ok === true) pending.resolve(pending.binary ? { value: header.result, bytes: Buffer.from(payload) } : header.result)
          else pending.reject(failure(/^[A-Z_]{1,64}$/.test(header.error?.code || '') ? header.error.code : 'BACKEND_FAILED'))
        }
      } catch { this.failChild(child, 'PROTOCOL_FAILED') }
    })
    child.stderr.resume() // Drain without logging private data.
    child.stdin.on('error', () => this.failChild(child, 'BACKEND_EXITED'))
    child.once('error', () => this.failChild(child, 'BACKEND_UNAVAILABLE'))
    child.once('exit', () => this.failChild(child, 'BACKEND_EXITED'))
    const initialized = await this.request('initialize', { storageRoot: this.directory })
    if (!initialized.capabilities?.history || initialized.protocolVersion !== 1 || initialized.nativeBuildId !== manifest.nativeBuildId) throw failure('INCOMPATIBLE_BACKEND')
    this.startedAt = Number(this.now())
  }
  failChild(child, code) {
    if (this.child !== child) return
    this.child = null; this.epoch = null; this.coordinatedPid = null; this.retiredExit = this.exited
    this.clearPollTimer()
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(failure(outcomeFailure(pending.method, code))) }
    this.pending.clear()
    try { child.kill() } catch {}
    if (!this.stopping) { this.publish({ phase: 'error', available: false, messageKey: code }); this.retry() }
  }
  request(method, params = {}, binary = false, timeoutMs = 5000) {
    const child = this.child
    if (!child) return Promise.reject(failure('BACKEND_UNAVAILABLE'))
    if (this.pending.size >= 16 || child.stdin.writableLength > 256 * 1024) return Promise.reject(failure('BACKPRESSURE'))
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.failChild(child, 'BACKEND_TIMEOUT'), timeoutMs)
      timer.unref?.()
      this.pending.set(requestId, { method, resolve, reject, timer, binary })
      try { child.stdin.write(encodeFrame({ version: 1, type: 'request', requestId, sessionEpoch: this.epoch, method, params })) }
      catch { this.failChild(child, 'PROTOCOL_FAILED') }
    })
  }
  // B01 (plan item 05): publish one fresh image without creating a history entry. The
  // PNG travels as a temporary file because the framed protocol's chunk limit is 256 KiB
  // and a screenshot can be many megabytes; the sidecar re-validates the bytes and the
  // exclusion markers. Resolves a receipt - it never throws for a refusal.
  async publishImage({ png, private: isPrivate = false } = {}) {
    const bytes = Buffer.isBuffer(png) ? png : Buffer.from(png || [])
    if (!bytes.length) return { ok: false, code: 'IMAGE_EMPTY' }
    if (bytes.length > MAX_PUBLISH_BYTES) return { ok: false, code: 'IMAGE_TOO_LARGE', bytes: bytes.length }
    if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return { ok: false, code: 'INVALID_IMAGE' }
    if (!this.child) return { ok: false, code: 'BACKEND_UNAVAILABLE' }
    const temporaryDirectory = path.join(this.directory, 'publish')
    const file = path.join(temporaryDirectory, randomUUID() + '.png')
    try {
      await fs.mkdir(temporaryDirectory, { recursive: true })
      await fs.writeFile(file, bytes)
    } catch (error) {
      return { ok: false, code: error?.code || 'IMAGE_UNWRITABLE' }
    }
    try {
      const answer = await this.request('publish-image', { path: file, private: isPrivate === true }, false, 8000)
      return {
        ok: true,
        private: isPrivate === true,
        bytes: Number(answer?.bytes) || bytes.length,
        sequence: answer?.sequence
      }
    } catch (error) {
      const code = error?.code || 'PUBLICATION_FAILED'
      // The sidecar reports its own reasons; keep them recognizable for the retry policy.
      return { ok: false, code, retryable: PUBLISH_RETRYABLE.has(code) }
    } finally {
      await fs.rm(file, { force: true }).catch(() => {})
    }
  }

  async refresh() {
    if (!this.child) return this.snapshot()
    const value = await this.request('status')
    this.maintenancePending = value.maintenancePending === true
    // C03: a GC backlog (pending bytes the sidecar could not delete yet) is the
    // one condition that asks for an immediate maintenance pass. It is one-shot:
    // gcBacklogPending only moves on the empty -> non-empty edge, so a backlog
    // that refuses to drain degrades to the 5 s health cadence instead of a loop.
    const gcBacklog = Number.isSafeInteger(value.pendingGcBytes) && value.pendingGcBytes > 0
    this.gcBacklogPending = gcBacklog && this.gcBacklog !== true
    this.gcBacklog = gcBacklog
    if (value.captureBusyMs > 3000) { this.failChild(this.child, 'CAPTURE_BLOCKED'); return this.snapshot() }
    const previous = this.status.revision
    const patch = {}
    for (const key of ['datasetId', 'revision', 'messageKey']) if (value[key] === null || typeof value[key] === 'string') patch[key] = value[key]
    for (const key of ['itemCount', 'pinnedCount', 'payloadBytes', 'actualDiskBytes', 'pendingGcBytes']) if (Number.isSafeInteger(value[key]) && value[key] >= 0) patch[key] = value[key]
    if (value.skipped && typeof value.skipped === 'object') patch.skipped = Object.fromEntries(Object.entries(value.skipped).filter(([key, count]) => /^[a-z_]{1,64}$/.test(key) && Number.isSafeInteger(count) && count >= 0))
    if (value.coordination?.phase === 'Orphaned') this.publish({ phase: 'error', messageKey: 'COORDINATION_ORPHANED' })
    else this.publish(patch)
    if (previous !== this.status.revision) this.emit('history', { datasetId: this.status.datasetId, revision: this.status.revision })
    if (Number(this.now()) - this.startedAt > 60000) this.retryCount = 0
    this.lastRefreshAt = Number(this.now())
    return this.snapshot()
  }
  clearPollTimer() {
    if (this.pollTimer !== null && this.pollTimer !== undefined) this.clearTimeoutFn(this.pollTimer)
    this.pollTimer = null
  }
  clearRetryTimer() {
    if (this.retryTimer !== null && this.retryTimer !== undefined) this.clearTimeoutFn(this.retryTimer)
    this.retryTimer = null
  }
  // C03: the panel tells the service whether it is on screen. Opening always
  // asks for a current revision (unless the cached one is younger than the paint
  // budget); hiding only re-arms the timer, because the way out must not cost a
  // request. This is the only visibility input the scheduler has.
  setPanelVisible(visible) {
    const next = visible === true
    const changed = this.panelVisible !== next
    this.panelVisible = next
    if (!next) { this.schedulePoll(); return Promise.resolve(this.snapshot()) }
    if (!changed && Number(this.now()) - (this.lastRefreshAt || 0) < POLL_REVISION_FRESH_MS) { this.schedulePoll(); return Promise.resolve(this.snapshot()) }
    this.clearPollTimer()
    return this.pollOnce()
  }
  // C03: an out-of-band event the sidecar cannot push. It performs one bounded
  // check right away instead of letting the 30 s hidden backoff defer it. The
  // next delay comes from the state that check observes, so a persistent fault
  // falls to the 5 s cadence rather than firing continuously.
  notifyHealth(reason) {
    if (this.disposed || !isHealthEvent(reason) || !this.child) return Promise.resolve(this.snapshot())
    this.lastHealthEvent = reason
    this.clearPollTimer()
    return this.pollOnce()
  }
  // One-shot edge: the backlog is new (or the panel just went dark with one
  // already recorded), so the next check is immediate exactly once.
  takeBacklogEvent() {
    const event = this.gcBacklogPending && !this.panelVisible ? 'gc-backlog' : null
    this.gcBacklogPending = false
    return event
  }
  pollIsQuiescent() {
    // A backend that is unavailable or already reporting an error is not
    // "stable": the hidden cadence must not defer a fault, so those states keep
    // the bounded health check. A paused-but-alive backend is quiescent.
    return this.status.available === true && this.status.phase !== 'error' &&
      pollIsStable({ maintenancePending: this.maintenancePending, gcBacklog: this.gcBacklog })
  }
  schedulePoll(event = null) {
    this.clearPollTimer()
    if (!this.child || this.disposed || this.stopping) return
    const delay = nextPollDelay({
      visible: this.panelVisible,
      stable: this.pollIsQuiescent(),
      healthy: this.pollFailed !== true,
      event
    })
    this.pollTimer = this.setTimeoutFn(() => { this.pollTimer = null; return this.pollOnce() }, delay)
    this.pollTimer?.unref?.()
  }
  async pollOnce() {
    if (this.disposed) return this.snapshot()
    let event = null
    let fresh = false
    if (this.child) {
      try {
        await this.refresh()
        this.pollFailed = false
        fresh = true
        // Hidden and a backlog just appeared: drain it now. While the panel is
        // visible the 2 s cadence already follows up, so no extra request.
        event = this.takeBacklogEvent()
      } catch (error) {
        this.pollFailed = true
        this.gcBacklogPending = false
        this.reportPollFailure(error)
        this.retry()
      }
      // Maintenance follows a fresh observation only: acting on the state a
      // failed check left behind could spend a request on work already done.
      if (fresh && this.child && !this.disposed) {
        try { await this.maintain() } catch { this.retry() }
      }
    }
    this.schedulePoll(event)
    return this.snapshot()
  }
  async maintain() {
    const now = Number(this.now())
    const periodic = now - (this.maintainedAt || 0) > 600000
    const pending = this.maintenancePending === true
    // A known GC backlog is drained at most once per 30 s even if the bytes stay
    // (a locked file, for example); the poll cadence stays bounded either way.
    const backlog = this.gcBacklog === true && now - (this.gcMaintainedAt || 0) >= 30000
    if (!pending && !periodic && !backlog) return
    this.maintainedAt = now
    if (this.gcBacklog) this.gcMaintainedAt = now
    await this.request('maintenance')
  }
  reportPollFailure(error) {
    const code = /^[A-Z_]{1,64}$/.test(error?.code || '') ? error.code : 'BACKEND_UNAVAILABLE'
    // BACKPRESSURE is a transient queue condition the caller already reports;
    // a dead child has already been published by failChild().
    if (!this.child || code === 'BACKPRESSURE' || this.status.phase === 'error') return
    this.publish({ phase: 'error', available: false, messageKey: code })
  }
  async command(method, args = {}) {
    await this.serial
    if (!this.settings?.enabled) throw failure('FEATURE_DISABLED')
    if (this.reasons.has('migration') || this.disposed) throw failure('QUIESCING')
    if (!this.status.available || !this.child) throw failure('BACKEND_UNAVAILABLE')
    if (['paste.capture', 'paste.prepare', 'paste.commit'].includes(method) && this.reasons.size) throw failure('PASTE_UNAVAILABLE')
    const value = await this.request(method, args, method === 'thumbnail')
    if (['copy', 'paste.commit', 'paste.cancel', 'set-pinned', 'delete', 'clear'].includes(method)) await this.refresh().catch(() => {})
    return value
  }
  async stop() {
    this.clearPollTimer()
    if (!this.child) { if (this.retiredExit) await this.waitForExit(this.retiredExit); return }
    this.stopping = true
    try {
      await this.request('configure', { enabled: false })
      const deadline = Date.now() + 2500
      while (true) {
        const state = await this.request('coordination.status')
        if (['Idle', 'stopped', 'unregistered'].includes(state.phase)) break
        if (state.phase === 'Orphaned') {
          const hook = this.getHook()
          hook?.forceHostRecreate('clipboard-orphan')
          await hook?.waitForRetiredHosts()
          await this.request('coordination.recover'); break
        }
        if (Date.now() >= deadline) throw failure('COORDINATION_BUSY')
        await delay(50)
      }
      await this.request('quiesce')
      const child = this.child
      child.stdin.end()
      await this.waitForExit(this.exited)
      if (this.child === child) { this.child = null; this.epoch = null; this.coordinatedPid = null }
    } finally { this.stopping = false }
  }
  async waitForExit(exited) {
    let timer
    try { await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(failure('NATIVE_EXIT_TIMEOUT')), 5000) })]) }
    finally { clearTimeout(timer) }
  }
  async terminate() {
    const child = this.child
    this.child = null; this.epoch = null; this.coordinatedPid = null
    this.clearPollTimer()
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(failure(outcomeFailure(pending.method, 'BACKEND_EXITED'))) }
    this.pending.clear()
    if (child) { this.retiredExit = this.exited; try { child.kill() } catch {}; await this.waitForExit(this.exited) }
    else if (this.retiredExit) await this.waitForExit(this.retiredExit)
  }
  async quiesce() {
    this.quiescing = true
    this.reasons.add('migration'); ++this.generation
    this.clearRetryTimer()
    await this.serial.catch(() => {})
    await this.stop()
    if (this.child) throw failure('QUIESCE_FAILED')
    this.publish({ phase: 'stopped', available: false })
  }
  async dispose() {
    this.disposed = true; ++this.generation
    this.clearPollTimer(); this.clearRetryTimer(); this.unsubscribeHook?.()
    await this.serial.catch(() => {})
    try { await this.stop() } finally { await this.terminate(); this.removeAllListeners() }
  }
}
module.exports = { ClipboardService }
