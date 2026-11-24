(function initChunkBackpressure(globalScope) {
  const DEFAULTS = Object.freeze({
    // Backpressure starts here: either bound is enough (32 MiB or 5 s of unsent fragments).
    highWaterBytes: 32 * 1024 * 1024,
    highWaterAgeMs: 5000,
    // ... and stops here, so a pause/resume flapping around the high mark is impossible.
    lowWaterBytes: 8 * 1024 * 1024,
    lowWaterAgeMs: 1000,
    // Renderer-side ceiling. 48 + 16 = the 64 MiB the app may hold while unconfirmed.
    hardLimitBytes: 48 * 1024 * 1024,
    // One fragment larger than this is abnormal (the recorder slices every second) and is
    // never buffered.
    maxChunkBytes: 16 * 1024 * 1024,
    // An ACK that never arrives means the write side is wedged; the caller seals the
    // confirmed part instead of waiting forever.
    ackTimeoutMs: 30000
  })

  function createChunkBackpressurePolicy(options = {}) {
    const config = { ...DEFAULTS, ...(options || {}) }
    let pending = []
    let paused = false
    let pauseStartedAt = 0
    const pauseSpans = []
    const totals = {
      enqueuedChunks: 0,
      enqueuedBytes: 0,
      settledChunks: 0,
      peakPendingBytes: 0,
      pauseCount: 0,
      overflowCount: 0
    }

    function pendingBytes() {
      let bytes = 0
      for (const item of pending) bytes += item.bytes
      return bytes
    }

    function oldestAge(now) {
      if (!pending.length) return 0
      return Math.max(0, now - pending[0].at)
    }

    function snapshot(now = Date.now()) {
      return {
        pendingBytes: pendingBytes(),
        pendingChunks: pending.length,
        oldestAgeMs: oldestAge(now),
        paused,
        peakPendingBytes: totals.peakPendingBytes,
        enqueuedChunks: totals.enqueuedChunks,
        enqueuedBytes: totals.enqueuedBytes,
        settledChunks: totals.settledChunks,
        pauseCount: totals.pauseCount,
        overflowCount: totals.overflowCount
      }
    }

    // Called once per dataavailable fragment, BEFORE it is added to the queue.
    function enqueue({ sequence, bytes, at = Date.now() } = {}) {
      const size = Math.max(0, Number(bytes) || 0)
      if (size > config.maxChunkBytes) {
        totals.overflowCount += 1
        return { action: 'overflow', reason: 'oversized-chunk', sequence, bytes: size, snapshot: snapshot(at) }
      }
      const nextBytes = pendingBytes() + size
      if (nextBytes > config.hardLimitBytes) {
        // The fragment is intentionally dropped: keeping it would break the hard ceiling,
        // and it was never sent, so the confirmed sequence stays contiguous up to sequence - 1.
        totals.overflowCount += 1
        return { action: 'overflow', reason: 'hard-limit', sequence, bytes: size, snapshot: snapshot(at) }
      }
      pending.push({ sequence, bytes: size, at })
      totals.enqueuedChunks += 1
      totals.enqueuedBytes += size
      const bytesNow = pendingBytes()
      if (bytesNow > totals.peakPendingBytes) totals.peakPendingBytes = bytesNow
      const ageNow = oldestAge(at)
      if (!paused && (bytesNow > config.highWaterBytes || ageNow > config.highWaterAgeMs)) {
        paused = true
        pauseStartedAt = at
        totals.pauseCount += 1
        return {
          action: 'pause',
          reason: bytesNow > config.highWaterBytes ? 'bytes' : 'age',
          pendingBytes: bytesNow,
          ageMs: ageNow,
          snapshot: snapshot(at)
        }
      }
      return { action: 'accept', pendingBytes: bytesNow, ageMs: ageNow, snapshot: snapshot(at) }
    }

    // Called when a fragment's ACK arrived (success OR failure - a failed write ends the
    // take, but the queue still shrinks, so the settlement is idempotent and safe).
    function settle({ sequence, at = Date.now() } = {}) {
      const index = pending.findIndex((item) => item.sequence === sequence)
      if (index !== -1) {
        pending.splice(index, 1)
        totals.settledChunks += 1
      }
      if (!paused) return { action: 'none', snapshot: snapshot(at) }
      const bytesNow = pendingBytes()
      if (bytesNow <= config.lowWaterBytes && oldestAge(at) <= config.lowWaterAgeMs) {
        paused = false
        if (pauseStartedAt) {
          pauseSpans.push({ startWall: pauseStartedAt, endWall: at, reason: 'backpressure' })
          pauseStartedAt = 0
        }
        return { action: 'resume', pendingBytes: bytesNow, snapshot: snapshot(at) }
      }
      return { action: 'none', pendingBytes: bytesNow, snapshot: snapshot(at) }
    }

    // The wall-clock spans MediaRecorder was paused for backpressure. record.js records the
    // same spans on its own media clock so annotations stay mapped to the right frames.
    function getPauseSpans() {
      const spans = pauseSpans.map((span) => ({ ...span }))
      if (pauseStartedAt) spans.push({ startWall: pauseStartedAt, endWall: 0, reason: 'backpressure' })
      return spans
    }

    function reset() {
      pending = []
      paused = false
      pauseStartedAt = 0
      pauseSpans.length = 0
      for (const key of Object.keys(totals)) totals[key] = 0
    }

    return {
      config,
      enqueue,
      settle,
      snapshot,
      getPauseSpans,
      reset,
      get paused() { return paused }
    }
  }


  const chunkBackpressure = { DEFAULTS, createChunkBackpressurePolicy }
  if (typeof module !== 'undefined' && module.exports) module.exports = chunkBackpressure
  if (globalScope) globalScope.chunkBackpressure = chunkBackpressure
})(typeof window !== 'undefined' ? window : null)
