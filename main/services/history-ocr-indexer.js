'use strict'

// N02 (docs/reviews/2026-11-26-code-review-and-optimization-report.md section 5.2):
// background full-text index for screenshot history.
//
// `HistoryService.matchesHistoryFilter` has always searched `item.ocrText` and `item.tags`,
// but nothing wrote those fields, so "search the text inside my screenshots" was a read
// path with no producer. This module is that producer: after a capture is persisted, the
// capture domain hands the new record over and the text is extracted off the save path.
//
// The contract, in the order the constraints show up:
//   * the save path never waits for OCR. `enqueue()` only appends to a queue and schedules
//     a macrotask; the persistence call has already returned by the time inference starts;
//   * one OCR at a time. The shared OcrService sidecar is also used by capture/translate,
//     so a serial queue keeps background indexing from competing with an explicit request;
//   * one job per record id, a bounded queue, and no retry storm: a failed recognition is
//     retried exactly once and then dropped silently (the next capture re-indexes normally);
//   * the record is re-read at write time. OCR can take seconds and the user can delete the
//     screenshot meanwhile, so a result for a record that no longer exists is discarded
//     instead of resurrecting it (HistoryService.updateOcrText also refuses a missing id);
//   * `dispose()` stops everything: main.js has no quit hook for this service today, so the
//     method exists for tests and for a future explicit shutdown.
//
// Images are downscaled before recognition: the sidecar does not downscale large inputs
// (native/ocr only upscales small ones), so a 4K capture would otherwise pay full detection
// cost. The cap matches the sidecar's default detection `maxSide`, which is also the point
// past which extra pixels stop helping text detection.

const fs = require('node:fs')

const DEFAULT_MAX_QUEUE_SIZE = 40
const MAX_IMAGE_SIDE = 2048
const MAX_OCR_TEXT_LENGTH = 20000
// One initial attempt plus one silent retry: a transient sidecar start or a busy model is
// worth one more try, but a permanently broken image must not keep the queue busy.
const MAX_ATTEMPTS = 2

function normalizeOcrText(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/\r\n?/g, '\n').trim().slice(0, MAX_OCR_TEXT_LENGTH)
}

function createHistoryOcrIndexer(options = {}) {
  const {
    getSettings,
    getOcrService,
    getHistoryService,
    // Electron's nativeImage, used only for the default downscale. A test (or a host
    // without Electron) can pass `prepareImage` instead and skip the decode entirely.
    nativeImage = null,
    prepareImage = null,
    log = () => {},
    schedule = (callback) => setImmediate(callback),
    cancelSchedule = (handle) => clearImmediate(handle),
    maxQueueSize = DEFAULT_MAX_QUEUE_SIZE
  } = options

  if (typeof getSettings !== 'function' || typeof getOcrService !== 'function' || typeof getHistoryService !== 'function') {
    throw new Error('History OCR indexer dependencies are incomplete')
  }

  const queue = []
  const indexedIds = new Set()
  const cancelledIds = new Set()
  const idleWaiters = []
  const queueLimit = Math.max(1, Number(maxQueueSize) || DEFAULT_MAX_QUEUE_SIZE)
  let running = false
  let disposed = false
  let scheduled = null
  let inFlightId = ''
  let processedCount = 0
  let failedCount = 0

  function stateSnapshot() {
    return {
      pending: queue.length,
      running,
      activeId: inFlightId,
      disposed,
      processedCount,
      failedCount,
      indexedCount: indexedIds.size
    }
  }

  // N02 follow-up (real-device verification, 2026-11-27): the history page needs to tell a
  // record that is queued/in-flight apart from one that was never indexed. `isActive()` answers
  // that for HistoryService.ocrStatusOf(), and `has()` answers "does this indexer still own the
  // id". `enabled()` lets the page say why a manual index request did nothing instead of
  // failing silently.
  function has(id) {
    return indexedIds.has(String(id || ''))
  }

  function isActive(id) {
    return isQueuedOrRunning(String(id || ''))
  }

  function enabled() {
    return !disposed && indexingEnabled()
  }

  // The queue state is visible to the page through HistoryService.ocrStatusOf() without a
  // persisted write: "pending" is derived from the in-memory job list, so accepting a job does
  // not rewrite the whole history array on the capture save path. A single broadcast is still
  // emitted so an open history page re-reads the projection and shows "recognizing".
  function notifyQueue() {
    if (disposed) return
    try {
      const historyService = getHistoryService()
      if (historyService && typeof historyService.notifyOcrQueue === 'function') historyService.notifyOcrQueue()
    } catch (error) {
      log('History OCR queue notify failed:', error && error.message ? error.message : String(error))
    }
  }

  // Terminal status writes must never break the queue: a missing/deleted history service or a
  // store failure is logged and the recognition result is dropped exactly as before.
  function markStatus(id, status) {
    if (disposed) return
    try {
      const historyService = getHistoryService()
      if (historyService && typeof historyService.markOcrStatus === 'function') {
        historyService.markOcrStatus(id, status)
      }
    } catch (error) {
      log('History OCR status write failed:', error && error.message ? error.message : String(error))
    }
  }

  function isQueuedOrRunning(id) {
    if (inFlightId === id) return true
    return queue.some((job) => job.id === id)
  }

  // The plugin switch is the product gate: indexing is a background consumer of the same
  // local OCR engine the user can turn off. `historyEnabled` is checked too so a disabled
  // history cannot be re-read through the index path. Settings failures read as "off".
  function indexingEnabled() {
    try {
      const settings = getSettings()
      if (!settings || typeof settings !== 'object') return false
      if (!settings.plugins || settings.plugins.ocr !== true) return false
      if (settings.screenshot && settings.screenshot.historyEnabled === false) return false
      return true
    } catch {
      return false
    }
  }

  function settleIdle() {
    if (!disposed && (running || queue.length)) return
    const waiters = idleWaiters.splice(0)
    const snapshot = stateSnapshot()
    for (const resolve of waiters) resolve(snapshot)
  }

  function scheduleNext() {
    if (disposed || running || scheduled !== null || !queue.length) return
    scheduled = schedule(() => {
      scheduled = null
      void runNext()
    })
  }

  // The default image source: decode with nativeImage, then shrink the longest side to
  // MAX_IMAGE_SIDE and re-encode as PNG. Small images are forwarded untouched (the sidecar
  // upscales them itself when needed).
  async function loadImageBuffer(filePath) {
    if (typeof prepareImage === 'function') return prepareImage(filePath)
    if (nativeImage && typeof nativeImage.createFromPath === 'function') {
      const image = nativeImage.createFromPath(filePath)
      if (!image) return null
      if (typeof image.isEmpty === 'function' && image.isEmpty()) return null
      const size = typeof image.getSize === 'function' ? image.getSize() : null
      const width = Math.max(0, Number(size && size.width) || 0)
      const height = Math.max(0, Number(size && size.height) || 0)
      let target = image
      if (Math.max(width, height) > MAX_IMAGE_SIDE && typeof image.resize === 'function') {
        target = width >= height
          ? image.resize({ width: MAX_IMAGE_SIDE, quality: 'good' })
          : image.resize({ height: MAX_IMAGE_SIDE, quality: 'good' })
      }
      const buffer = typeof target.toPNG === 'function' ? target.toPNG() : null
      if (buffer && buffer.length) return buffer
      // getSize()/toPNG() are missing (or the resize failed): fall back to the raw file so
      // the sidecar still gets a decodable PNG.
      return fs.promises.readFile(filePath)
    }
    return fs.promises.readFile(filePath)
  }

  function dropJob(job) {
    indexedIds.delete(job.id)
    cancelledIds.delete(job.id)
  }

  // Returns `{ ok: true, text }` or `{ ok: false }`. The callers need the distinction: an empty
  // string is a valid recognition result ("no text in this capture") while a thrown/failed
  // attempt is not, and only the latter is a failure the card should report.
  async function recognizeText(imageBuffer) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (disposed) return { ok: false }
      try {
        const service = getOcrService()
        if (!service || typeof service.recognize !== 'function') return { ok: false }
        const result = await service.recognize(imageBuffer, {
          scaleFactor: 1,
          maxSide: MAX_IMAGE_SIDE
        })
        return {
          ok: true,
          text: normalizeOcrText(result && result.text !== undefined ? result.text : result)
        }
      } catch (error) {
        if (attempt >= MAX_ATTEMPTS) {
          failedCount += 1
          log('History OCR failed:', error && error.message ? error.message : String(error))
          return { ok: false }
        }
      }
    }
    return { ok: false }
  }

  async function processJob(job) {
    if (disposed) return
    // The switch may have been turned off while the job sat in the queue. The record keeps an
    // explicit `skipped` status so the card explains why nothing happened instead of showing a
    // stale "in progress".
    if (!indexingEnabled()) {
      dropJob(job)
      markStatus(job.id, 'skipped')
      return
    }
    let imageBuffer = null
    try {
      imageBuffer = await loadImageBuffer(job.filePath)
    } catch (error) {
      failedCount += 1
      log('History OCR image read failed:', error && error.message ? error.message : String(error))
    }
    if (disposed) return
    if (!imageBuffer || !imageBuffer.length) {
      dropJob(job)
      markStatus(job.id, 'failed')
      return
    }
    const recognized = await recognizeText(imageBuffer)
    if (disposed) return
    // The user deleted the record while OCR was running: the in-flight result dies here.
    if (cancelledIds.delete(job.id)) return
    if (!recognized.ok) {
      // A permanent failure is a terminal state for the card. The id stays in `indexedIds`, so
      // an automatic re-save does not re-queue it; only an explicit retry (force) does.
      markStatus(job.id, 'failed')
      return
    }
    if (!recognized.text) {
      // Empty recognition is not an error (a solid-colour capture). The id stays in
      // `indexedIds` so a later save of the same record cannot re-queue it, and the explicit
      // `empty` status tells the page "recognized, nothing to find here".
      processedCount += 1
      markStatus(job.id, 'empty')
      return
    }
    const historyService = getHistoryService()
    if (!historyService || typeof historyService.updateOcrText !== 'function') return
    if (typeof historyService.getItem === 'function' && !historyService.getItem(job.id)) {
      // Deleted between the cancellation check and the write: drop the text.
      indexedIds.delete(job.id)
      return
    }
    try {
      const written = historyService.updateOcrText(job.id, recognized.text)
      if (written) processedCount += 1
      else failedCount += 1
    } catch (error) {
      failedCount += 1
      log('History OCR write failed:', error && error.message ? error.message : String(error))
      markStatus(job.id, 'failed')
    }
  }

  async function runNext() {
    if (disposed || running) return
    const job = queue.shift()
    if (!job) {
      settleIdle()
      return
    }
    running = true
    inFlightId = job.id
    try {
      await processJob(job)
    } finally {
      running = false
      inFlightId = ''
      if (!disposed && queue.length) scheduleNext()
      else settleIdle()
    }
  }

  // `options`:
  //   force         explicit user retry: ignore an existing text/queued-set entry. A job that is
  //                 still queued or running is never duplicated (it answers false).
  //   allowOverflow explicit backfill: a user-triggered "index the missing captures" run may add
  //                 more ids than the automatic queue cap, because one click legitimately covers
  //                 the whole history. Ids are tiny; OCR itself stays serial.
  //   deferNotify   the caller broadcasts the queue change itself, once, right after a backfill
  //                 loop. Only the explicit bulk action uses it; the capture save path keeps the
  //                 single per-record broadcast (no store write either way).
  function enqueue(item, options = {}) {
    if (disposed || !item || typeof item !== 'object') return false
    const force = options.force === true
    const allowOverflow = options.allowOverflow === true
    const id = String(item.id || '').slice(0, 128)
    const filePath = typeof item.filePath === 'string' ? item.filePath : ''
    if (!id || !filePath) return false
    // A record written before this feature (or indexed on an earlier run) already has its
    // text; the list is the search index, so there is nothing left to do for it. An explicit
    // retry may overwrite a previous result, so only the automatic path short-circuits.
    if (!force && typeof item.ocrText === 'string' && item.ocrText) return false
    if (indexedIds.has(id)) {
      if (!force || isQueuedOrRunning(id)) return false
      indexedIds.delete(id)
    }
    if (!allowOverflow && queue.length >= queueLimit) return false
    if (!indexingEnabled()) return false
    indexedIds.add(id)
    queue.push({ id, filePath })
    // N02 follow-up: "pending" is derived from this in-memory set (HistoryService.ocrStatusOf
    // asks isActive()), so accepting a job never rewrites the history store; the broadcast only
    // makes an open page re-read the projection and show "recognizing".
    if (options.deferNotify !== true) notifyQueue()
    scheduleNext()
    return true
  }

  // Drop a queued/in-flight record. Called by HistoryService when a record is deleted so the
  // result of a still-running recognition cannot be written to a record that no longer
  // exists (processJob re-reads the record as well; this saves the work and the race).
  function discard(id) {
    const normalizedId = String(id || '').slice(0, 128)
    if (!normalizedId) return false
    let removed = false
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      if (queue[index].id !== normalizedId) continue
      queue.splice(index, 1)
      removed = true
    }
    indexedIds.delete(normalizedId)
    if (inFlightId === normalizedId) cancelledIds.add(normalizedId)
    settleIdle()
    return removed
  }

  function dispose() {
    if (disposed) return
    disposed = true
    queue.length = 0
    indexedIds.clear()
    cancelledIds.clear()
    if (scheduled !== null) {
      cancelSchedule(scheduled)
      scheduled = null
    }
    settleIdle()
  }

  // Resolves once the queue is drained (and the last job finished). The capture save path
  // never calls it; it exists so a test, a shutdown path or a maintenance script can wait
  // for the index to settle instead of polling.
  function idle() {
    if (!disposed && (running || queue.length)) {
      return new Promise((resolve) => { idleWaiters.push(resolve) })
    }
    return Promise.resolve(stateSnapshot())
  }

  return {
    enqueue,
    discard,
    dispose,
    idle,
    state: stateSnapshot,
    has,
    isActive,
    enabled
  }
}

module.exports = {
  createHistoryOcrIndexer,
  normalizeOcrText,
  MAX_IMAGE_SIDE,
  MAX_OCR_TEXT_LENGTH,
  DEFAULT_MAX_QUEUE_SIZE
}
