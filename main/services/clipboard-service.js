'use strict'
const { EventEmitter } = require('node:events')
const { spawn } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')
const { FrameDecoder, encodeFrame } = require('../../shared/clipboard-protocol')
const { nativeRules } = require('./clipboard-settings')
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const failure = (code) => Object.assign(new Error(code), { code })
const outcomeFailure = (method, code) => method === 'copy' ? 'COPY_OUTCOME_UNKNOWN' : ['paste.prepare', 'paste.commit'].includes(method) ? 'PASTE_OUTCOME_UNKNOWN' : code

class ClipboardService extends EventEmitter {
  constructor({ executable, directory, getHook, spawnChild = spawn }) {
    super()
    Object.assign(this, { executable, directory, getHook, spawnChild })
    this.child = null; this.epoch = null; this.pending = new Map()
    this.settings = null; this.reasons = new Set(); this.serial = Promise.resolve()
    this.generation = 0; this.coordinatedPid = null; this.disposed = false
    this.status = { enabled: false, userPaused: false, available: false, phase: 'disabled', pausedReasons: [], datasetId: null, revision: null, itemCount: 0, pinnedCount: 0, payloadBytes: 0, actualDiskBytes: 0, pendingGcBytes: 0 }
    this.pollTimer = null; this.retryTimer = null; this.retryCount = 0; this.unsubscribeHook = null
  }
  snapshot() { return structuredClone(this.status) }
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
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.reconcile() }, wait)
    this.retryTimer.unref?.()
  }
  reconcile() {
    const generation = ++this.generation
    clearTimeout(this.retryTimer); this.retryTimer = null
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
    this.schedulePoll()
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
    this.startedAt = Date.now()
  }
  failChild(child, code) {
    if (this.child !== child) return
    this.child = null; this.epoch = null; this.coordinatedPid = null; this.retiredExit = this.exited
    clearTimeout(this.pollTimer); this.pollTimer = null
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
  async refresh() {
    if (!this.child) return this.snapshot()
    const value = await this.request('status')
    this.maintenancePending = value.maintenancePending === true
    if (value.captureBusyMs > 3000) { this.failChild(this.child, 'CAPTURE_BLOCKED'); return this.snapshot() }
    const previous = this.status.revision
    const patch = {}
    for (const key of ['datasetId', 'revision', 'messageKey']) if (value[key] === null || typeof value[key] === 'string') patch[key] = value[key]
    for (const key of ['itemCount', 'pinnedCount', 'payloadBytes', 'actualDiskBytes', 'pendingGcBytes']) if (Number.isSafeInteger(value[key]) && value[key] >= 0) patch[key] = value[key]
    if (value.skipped && typeof value.skipped === 'object') patch.skipped = Object.fromEntries(Object.entries(value.skipped).filter(([key, count]) => /^[a-z_]{1,64}$/.test(key) && Number.isSafeInteger(count) && count >= 0))
    if (value.coordination?.phase === 'Orphaned') this.publish({ phase: 'error', messageKey: 'COORDINATION_ORPHANED' })
    else this.publish(patch)
    if (previous !== this.status.revision) this.emit('history', { datasetId: this.status.datasetId, revision: this.status.revision })
    if (Date.now() - this.startedAt > 60000) this.retryCount = 0
    return this.snapshot()
  }
  schedulePoll() {
    clearTimeout(this.pollTimer)
    if (!this.child || this.disposed) return
    this.pollTimer = setTimeout(async () => {
      this.pollTimer = null
      try { await this.refresh(); if (this.maintenancePending || Date.now() - (this.maintainedAt || 0) > 600000) { this.maintainedAt = Date.now(); await this.request('maintenance') } }
      catch { this.retry() }
      this.schedulePoll()
    }, 2000)
    this.pollTimer.unref?.()
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
    clearTimeout(this.pollTimer); this.pollTimer = null
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
    clearTimeout(this.pollTimer); this.pollTimer = null
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(failure(outcomeFailure(pending.method, 'BACKEND_EXITED'))) }
    this.pending.clear()
    if (child) { this.retiredExit = this.exited; try { child.kill() } catch {}; await this.waitForExit(this.exited) }
    else if (this.retiredExit) await this.waitForExit(this.retiredExit)
  }
  async quiesce() {
    this.quiescing = true
    this.reasons.add('migration'); ++this.generation
    clearTimeout(this.retryTimer); this.retryTimer = null
    await this.serial.catch(() => {})
    await this.stop()
    if (this.child) throw failure('QUIESCE_FAILED')
    this.publish({ phase: 'stopped', available: false })
  }
  async dispose() {
    this.disposed = true; ++this.generation
    clearTimeout(this.retryTimer); this.unsubscribeHook?.()
    await this.serial.catch(() => {})
    try { await this.stop() } finally { await this.terminate(); this.removeAllListeners() }
  }
}
module.exports = { ClipboardService }
