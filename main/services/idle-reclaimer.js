'use strict'

// M2/W4: the single-shot idle reclaimer shared by the windows that are allowed
// to give their renderer back after being hidden for a while (search window,
// unpinned selection result window, later the main window).
//
// The contract is deliberately small and injectable:
//   - `timeoutMs <= 0` disables reclaiming entirely (the caller keeps today's
//     "hide and keep warm" behaviour);
//   - arming twice REPLACES the previous timer (reopen then hide again);
//   - when the timer fires the predicate is re-checked, so a window that became
//     visible again, or still holds a lease, is never destroyed by a stale
//     timer. A skipped fire is reported as `skipped`, not retried: the caller
//     re-arms when the blocking condition clears (lease release / next hide);
//   - every transition is logged through the injected `log`, so "why did this
//     window disappear?" is answerable from the log alone.
function createIdleReclaimer({
  name = 'idle',
  timeoutMs = 0,
  shouldReclaim = () => true,
  onReclaim = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = () => Date.now(),
  log = () => {}
} = {}) {
  if (typeof name !== 'string' || !name.trim()) throw new TypeError('An idle reclaimer requires a name')
  if (typeof shouldReclaim !== 'function') throw new TypeError('shouldReclaim must be a function')
  if (typeof onReclaim !== 'function') throw new TypeError('onReclaim must be a function')

  const label = name.trim()
  const timeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : 0
  let timer = null
  let armedAt = 0
  let disposed = false
  let generation = 0
  let lastOutcome = null

  function clear() {
    if (!timer) return false
    clearTimer(timer)
    timer = null
    return true
  }

  function arm() {
    if (disposed || timeout <= 0) return false
    clear()
    generation += 1
    const token = generation
    armedAt = now()
    timer = setTimer(() => {
      timer = null
      if (disposed || token !== generation) return
      const idleForMs = Math.max(0, now() - armedAt)
      let reclaim = false
      try {
        reclaim = shouldReclaim() === true
      } catch (error) {
        log('reclaim-predicate-failed', { name: label, error: error?.message || String(error) })
        lastOutcome = 'skipped'
        return
      }
      if (!reclaim) {
        lastOutcome = 'skipped'
        log('reclaim-skipped', { name: label, idleForMs })
        return
      }
      lastOutcome = 'fired'
      log('reclaim-fired', { name: label, idleForMs })
      try {
        onReclaim({ name: label, idleForMs, reason: 'idle' })
      } catch (error) {
        log('reclaim-handler-failed', { name: label, error: error?.message || String(error) })
      }
    }, timeout)
    if (timer && typeof timer.unref === 'function') timer.unref()
    return true
  }

  function disarm(reason = 'manual') {
    if (disposed) return false
    const hadTimer = clear()
    if (!hadTimer) return false
    generation += 1
    lastOutcome = 'disarmed'
    log('reclaim-disarmed', { name: label, reason: String(reason || 'manual') })
    return true
  }

  function dispose() {
    if (disposed) return
    clear()
    generation += 1
    disposed = true
  }

  return {
    arm,
    disarm,
    dispose,
    isArmed: () => Boolean(timer),
    isDisposed: () => disposed,
    getName: () => label,
    getTimeoutMs: () => timeout,
    getLastOutcome: () => lastOutcome
  }
}

module.exports = { createIdleReclaimer }
