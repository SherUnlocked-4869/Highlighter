'use strict'

// D05 (2026-11-24 Windows product/architecture review): when a pin's renderer
// process disappears the pin window is destroyed and the closed path releases its
// image immediately, so a reference image the user has not saved yet is gone.
//
// This module is the policy + tiny state machine behind the one-shot recovery:
//
//   abnormal renderer exit -> retain that image (TTL + attempt cap + the existing
//   20 pin / 32 MiB envelope) -> offer ONE rebuild; a normal close releases at once.
//
// It is deliberately Electron-free. The pin domain injects the clock, the timer
// functions, the store's retain/release calls and a budget probe; a unit test
// drives the whole lifecycle with a fake clock. Nothing here creates a window or
// a tray item: the domain exposes the recoverable list, and the tray wiring that
// consumes it is the next round (D05 does not touch main.js).

// These mirror main/domains/pin/index.js (MAX_PINNED = 20) and
// main/services/pin-image-store.js (DEFAULT_MEMORY_BUDGET = 32 MiB). The recovery
// buffer is NOT a second budget: retained references have to fit inside the same
// envelope live pins already use, otherwise a crash loop could hold pixels the
// store had already accounted for.
const DEFAULT_POLICY = Object.freeze({
  // Long enough for the user to notice the tray entry, short enough that an
  // unattended crash does not keep pixels for the rest of the session.
  ttlMs: 5 * 60 * 1000,
  // Three consecutive failed rebuilds stop the automatic path. Manual save /
  // discard stay available until the TTL expires.
  maxAttempts: 3,
  maxRetained: 20,
  maxRetainedBytes: 32 * 1024 * 1024
})

const RELEASE_CODES = Object.freeze({
  TTL_EXPIRED: 'TTL_EXPIRED',
  CLOSED: 'CLOSED',
  SAVED: 'SAVED',
  DISCARDED: 'DISCARDED',
  RECOVERED: 'RECOVERED',
  DISPOSED: 'DISPOSED'
})

const RESULT_CODES = Object.freeze({
  // A rebuild failed: the caller shows "save or discard" and stops auto-retrying
  // once `exhausted` is true.
  SAVE_OR_DISCARD: 'SAVE_OR_DISCARD',
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  ATTEMPTS_EXHAUSTED: 'ATTEMPTS_EXHAUSTED',
  DUPLICATE: 'DUPLICATE',
  RESOURCE_GONE: 'RESOURCE_GONE',
  NOT_FOUND: 'NOT_FOUND',
  BUSY: 'BUSY',
  DISPOSED: 'DISPOSED',
  INVALID_REQUEST: 'INVALID_REQUEST'
})

function normalizePolicy(overrides = {}) {
  const read = (key, fallback, minimum) => {
    const value = Number(overrides[key])
    return Number.isFinite(value) && value >= minimum ? value : fallback
  }
  return {
    ttlMs: read('ttlMs', DEFAULT_POLICY.ttlMs, 1),
    maxAttempts: Math.floor(read('maxAttempts', DEFAULT_POLICY.maxAttempts, 1)),
    maxRetained: Math.floor(read('maxRetained', DEFAULT_POLICY.maxRetained, 1)),
    maxRetainedBytes: read('maxRetainedBytes', DEFAULT_POLICY.maxRetainedBytes, 0)
  }
}

function createWindowResilience({
  policy: policyOverrides = {},
  // Injected so a unit test can advance time without sleeping and without a real
  // 5 minute timer keeping the process alive.
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  // () => ({ pins, bytes }): what the live pin windows currently use. The caller
  // passes the crashing pin as already gone (it is about to be destroyed).
  budget = null,
  // ({ imageId, key, bytes }) => boolean: hold one reference in the image store.
  retainResource = null,
  // (entry, info) => void: drop that reference.
  releaseResource = null,
  onRetain = null,
  onRelease = null
} = {}) {
  const policy = normalizePolicy(policyOverrides)
  const entries = new Map()
  const windowKeys = new Map()
  let sequence = 0
  let disposed = false

  function clockNow() {
    const value = Number(now())
    return Number.isFinite(value) ? value : 0
  }

  function report(callback, entry, info) {
    if (typeof callback !== 'function') return
    try {
      callback(entry, info)
    } catch {}
  }

  function snapshot(entry) {
    return {
      id: entry.id,
      key: entry.key,
      imageId: entry.imageId,
      bytes: entry.bytes,
      reason: entry.reason,
      meta: entry.meta ? { ...entry.meta } : null,
      placement: entry.placement ? { ...entry.placement } : null,
      attempts: entry.attempts,
      exhausted: entry.exhausted,
      state: entry.state,
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
      lastCode: entry.lastCode
    }
  }

  function retainedBytes() {
    let total = 0
    for (const entry of entries.values()) total += entry.bytes
    return total
  }

  function liveBudget() {
    if (typeof budget !== 'function') return { pins: 0, bytes: 0 }
    try {
      const value = budget() || {}
      return { pins: Math.max(0, Math.floor(Number(value.pins) || 0)), bytes: Math.max(0, Number(value.bytes) || 0) }
    } catch {
      return { pins: 0, bytes: 0 }
    }
  }

  function cancel(entry) {
    if (entry.timer == null) return
    try {
      clearTimer(entry.timer)
    } catch {}
    entry.timer = null
  }

  function arm(entry) {
    cancel(entry)
    const remaining = Math.max(0, entry.expiresAt - clockNow())
    try {
      const timer = setTimer(() => onTimer(entry.id), remaining)
      // Node timers hold the event loop open. A retained pin must not keep the app
      // (or the test runner) alive for five minutes after the last window closed.
      if (timer && typeof timer.unref === 'function') timer.unref()
      entry.timer = timer
    } catch {
      entry.timer = null
    }
  }

  function releaseEntry(entry, info = {}) {
    if (!entries.has(entry.id)) return false
    cancel(entry)
    entries.delete(entry.id)
    if (entry.key && windowKeys.get(entry.key) === entry.id) windowKeys.delete(entry.key)
    entry.state = 'released'
    entry.lastCode = info.code || 'RELEASED'
    if (typeof releaseResource === 'function') {
      try {
        releaseResource(entry, info)
      } catch {}
    }
    report(onRelease, snapshot(entry), { code: entry.lastCode, reason: info.reason || '' })
    return true
  }

  function onTimer(id) {
    const entry = entries.get(id)
    if (!entry) return
    const remaining = entry.expiresAt - clockNow()
    if (remaining > 0) {
      arm(entry)
      return
    }
    const result = release(id, { code: RELEASE_CODES.TTL_EXPIRED, reason: 'ttl' })
    // A recovery read may still own the reference; try again shortly instead of
    // dropping the TTL guarantee.
    if (!result.ok && result.code === RESULT_CODES.BUSY) {
      try {
        const retry = setTimer(() => onTimer(id), Math.min(1000, policy.ttlMs))
        if (retry && typeof retry.unref === 'function') retry.unref()
      } catch {}
    }
  }

  // A timer is not a guarantee: the process can be busy, a fake clock can jump,
  // and a suspended machine resumes with every interval overdue. Every public
  // read therefore prunes first.
  function prune() {
    let released = 0
    const current = clockNow()
    for (const entry of [...entries.values()]) {
      if (entry.state === 'recovering') continue
      if (entry.expiresAt > current) continue
      if (releaseEntry(entry, { code: RELEASE_CODES.TTL_EXPIRED, reason: 'ttl' })) released += 1
    }
    return released
  }

  function retain(request = {}) {
    if (disposed) return { ok: false, code: RESULT_CODES.DISPOSED }
    prune()
    if (request.imageId == null) return { ok: false, code: RESULT_CODES.INVALID_REQUEST }
    const key = typeof request.key === 'string' && request.key ? request.key : null
    if (key && windowKeys.has(key)) return { ok: false, code: RESULT_CODES.DUPLICATE }
    if (entries.size >= policy.maxRetained) {
      return {
        ok: false,
        code: RESULT_CODES.BUDGET_EXCEEDED,
        detail: { limit: 'retained', max: policy.maxRetained }
      }
    }
    const bytes = Number(request.bytes)
    const weight = Number.isFinite(bytes) && bytes > 0 ? bytes : 0
    if (weight > 0 && retainedBytes() + weight > policy.maxRetainedBytes) {
      return {
        ok: false,
        code: RESULT_CODES.BUDGET_EXCEEDED,
        detail: { limit: 'bytes', max: policy.maxRetainedBytes, used: retainedBytes(), requested: weight }
      }
    }
    const live = liveBudget()
    const livePins = Number(request.livePins)
    const occupied = Number.isFinite(livePins) ? Math.max(0, Math.floor(livePins)) : live.pins
    if (occupied + entries.size + 1 > policy.maxRetained) {
      return {
        ok: false,
        code: RESULT_CODES.BUDGET_EXCEEDED,
        detail: { limit: 'pins', max: policy.maxRetained, live: occupied, retained: entries.size }
      }
    }
    if (typeof retainResource === 'function') {
      let retained = false
      try {
        retained = retainResource({ imageId: request.imageId, key, bytes: weight }) !== false
      } catch {
        retained = false
      }
      if (!retained) return { ok: false, code: RESULT_CODES.RESOURCE_GONE }
    }
    const id = `pin-recovery-${++sequence}`
    const entry = {
      id,
      key,
      imageId: request.imageId,
      bytes: weight,
      reason: typeof request.reason === 'string' && request.reason ? request.reason : 'render-process-gone',
      meta: request.meta && typeof request.meta === 'object' ? { ...request.meta } : null,
      placement: request.placement && typeof request.placement === 'object' ? { ...request.placement } : null,
      attempts: 0,
      exhausted: false,
      state: 'retained',
      createdAt: clockNow(),
      expiresAt: clockNow() + policy.ttlMs,
      lastCode: '',
      timer: null
    }
    entries.set(id, entry)
    if (key) windowKeys.set(key, id)
    arm(entry)
    report(onRetain, snapshot(entry), { code: 'RETAINED' })
    return { ok: true, entry: snapshot(entry) }
  }

  function get(id) {
    if (entries.size) prune()
    const entry = id == null ? null : entries.get(id)
    return entry ? snapshot(entry) : null
  }

  function has(id) {
    if (id == null) return false
    if (entries.size) prune()
    return entries.has(id)
  }

  function list() {
    if (entries.size) prune()
    return [...entries.values()].map(snapshot)
  }

  // One recovery attempt at a time per ticket: a double click on the tray entry
  // must not build two windows from the same image.
  function claim(id) {
    if (disposed) return { ok: false, code: RESULT_CODES.DISPOSED }
    const entry = entries.get(id)
    if (!entry) return { ok: false, code: RESULT_CODES.NOT_FOUND }
    if (entry.state === 'recovering') return { ok: false, code: RESULT_CODES.BUSY }
    if (entry.exhausted || entry.attempts >= policy.maxAttempts) {
      entry.exhausted = true
      return { ok: false, code: RESULT_CODES.ATTEMPTS_EXHAUSTED, entry: snapshot(entry) }
    }
    if (entry.expiresAt <= clockNow()) {
      releaseEntry(entry, { code: RELEASE_CODES.TTL_EXPIRED, reason: 'ttl' })
      return { ok: false, code: RESULT_CODES.NOT_FOUND }
    }
    entry.state = 'recovering'
    return { ok: true, entry: snapshot(entry) }
  }

  function fail(id, info = {}) {
    const entry = entries.get(id)
    if (!entry) return { ok: false, code: RESULT_CODES.NOT_FOUND, attempts: 0, exhausted: true }
    entry.attempts += 1
    entry.state = 'retained'
    entry.lastCode = typeof info.code === 'string' && info.code ? info.code : 'RECOVERY_FAILED'
    if (entry.attempts >= policy.maxAttempts) entry.exhausted = true
    return { ok: true, attempts: entry.attempts, exhausted: entry.exhausted, entry: snapshot(entry) }
  }

  function succeed(id) {
    const entry = entries.get(id)
    if (!entry) return { ok: false, code: RESULT_CODES.NOT_FOUND }
    const before = snapshot(entry)
    entry.state = 'recovered'
    releaseEntry(entry, { code: RELEASE_CODES.RECOVERED, reason: 'recovered' })
    return { ok: true, entry: before }
  }

  function release(id, info = {}) {
    const entry = entries.get(id)
    if (!entry) return { ok: false, code: RESULT_CODES.NOT_FOUND }
    if (entry.state === 'recovering' && info.force !== true) return { ok: false, code: RESULT_CODES.BUSY }
    const before = snapshot(entry)
    releaseEntry(entry, info)
    return { ok: true, released: true, entry: before }
  }

  function releaseAll(info = {}) {
    let released = 0
    for (const entry of [...entries.values()]) {
      if (releaseEntry(entry, info)) released += 1
    }
    return { released }
  }

  function dispose() {
    if (disposed) return { released: 0 }
    const result = releaseAll({ code: RELEASE_CODES.DISPOSED, reason: 'dispose', force: true })
    disposed = true
    return result
  }

  function stats() {
    let exhausted = 0
    for (const entry of entries.values()) if (entry.exhausted) exhausted += 1
    return {
      retained: entries.size,
      bytes: retainedBytes(),
      exhausted,
      attemptsMax: policy.maxAttempts,
      ttlMs: policy.ttlMs,
      maxRetained: policy.maxRetained,
      maxRetainedBytes: policy.maxRetainedBytes,
      disposed
    }
  }

  return {
    retain,
    claim,
    fail,
    succeed,
    release,
    releaseAll,
    dispose,
    list,
    get,
    has,
    prune,
    stats,
    policy
  }
}

module.exports = {
  DEFAULT_POLICY,
  RELEASE_CODES,
  RESULT_CODES,
  createWindowResilience
}
