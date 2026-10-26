'use strict'

// M2/W4: task leases for windows that may be reclaimed while hidden.
//
// A lease is a reason string a caller holds while it is doing something the
// window must survive (streaming a response, writing a draft, exporting). The
// reclaimer asks `isIdle()` before destroying anything; a release is the signal
// to re-arm the timer. Leases are plain tokens, not event emitters, so callers
// can hold one across an await without extra cleanup machinery, and releasing
// twice is a no-op.
function createLeaseTracker({ log = () => {} } = {}) {
  const leases = new Map()
  let nextId = 1
  let disposed = false

  function acquire(reason = 'lease') {
    if (disposed) return () => false
    const id = nextId
    nextId += 1
    const label = String(reason || 'lease')
    leases.set(id, label)
    log('lease-acquired', { id, reason: label })
    let released = false
    return function release() {
      if (released) return false
      released = true
      const had = leases.delete(id)
      if (had) log('lease-released', { id, reason: label })
      return had
    }
  }

  function dispose() {
    disposed = true
    leases.clear()
  }

  return {
    acquire,
    dispose,
    isIdle: () => leases.size === 0,
    heldReasons: () => [...leases.values()],
    size: () => leases.size
  }
}

module.exports = { createLeaseTracker }
