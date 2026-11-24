const { isValidAccelerator } = require('../../shared/shortcut-keys')

function normalizeAccelerator(value) {
  return String(value || '').trim().toLocaleLowerCase('en-US')
}

function cloneStatuses(statuses) {
  return Object.fromEntries(
    Object.entries(statuses).map(([name, status]) => [
      name,
      {
        ...status,
        ...(Array.isArray(status.conflictWith) ? { conflictWith: [...status.conflictWith] } : {})
      }
    ])
  )
}

// A03 (docs/reviews/2026-11-24-windows-product-architecture-review.md): rebinding a shortcut
// must not trade a working key for a rejected one. `registerAll` still exists for a cold
// start (nothing is bound yet), but every runtime change goes through `sync`, which
// registers first and only then releases the old combination - and rolls back to exactly
// the previous binding set if the system refuses the new one.
class ShortcutService {
  constructor({
    globalShortcut,
    executeFunction,
    log = () => {}
  }) {
    if (!globalShortcut || typeof globalShortcut.register !== 'function') {
      throw new Error('ShortcutService requires globalShortcut')
    }
    if (typeof executeFunction !== 'function') {
      throw new Error('ShortcutService requires executeFunction')
    }
    this.globalShortcut = globalShortcut
    this.executeFunction = executeFunction
    this.log = log
    this.statuses = {}
    // name -> accelerator actually held by this process right now.
    this.bindings = new Map()
    // The configuration the bindings correspond to (used to rebuild statuses after a
    // failed change without inventing state).
    this.currentShortcuts = {}
  }

  callbackFor(name) {
    return () => {
      Promise.resolve()
        .then(() => this.executeFunction(name))
        .catch((error) => this.log('Shortcut error:', name, error?.message || String(error)))
    }
  }

  registerBinding(name, accelerator) {
    try {
      const registered = this.globalShortcut.register(accelerator, this.callbackFor(name))
      if (registered) {
        this.bindings.set(name, accelerator)
        return true
      }
      this.log('Shortcut unavailable:', accelerator)
      return false
    } catch (error) {
      this.log('Shortcut registration failed:', accelerator, error?.message || String(error))
      return false
    }
  }

  // Frees one accelerator. Electron exposes unregister(accelerator); a minimal test double
  // may not, in which case everything this service holds is re-registered around it.
  unregisterAccelerator(accelerator) {
    if (!accelerator) return
    if (typeof this.globalShortcut.unregister === 'function') {
      try { this.globalShortcut.unregister(accelerator) } catch (error) { this.log('Shortcut unregister failed:', accelerator, error?.message || String(error)) }
      return
    }
    const remaining = [...this.bindings].filter(([, value]) => value !== accelerator)
    this.globalShortcut.unregisterAll()
    this.bindings.clear()
    for (const [name, value] of remaining) this.registerBinding(name, value)
  }

  // Duplicates and invalid accelerators never reach the system registry; they are also
  // never bound, so a name that becomes a duplicate drops its previous binding.
  analyze(shortcuts = {}) {
    const entries = Object.entries(shortcuts).map(([name, accelerator]) => [name, String(accelerator || '').trim()])
    const ownersByAccelerator = new Map()
    for (const [name, accelerator] of entries) {
      if (!accelerator) continue
      const normalized = normalizeAccelerator(accelerator)
      const owners = ownersByAccelerator.get(normalized) || []
      owners.push(name)
      ownersByAccelerator.set(normalized, owners)
    }
    const target = new Map()
    const reasons = new Map()
    for (const [name, accelerator] of entries) {
      if (!accelerator) continue
      const owners = ownersByAccelerator.get(normalizeAccelerator(accelerator)) || []
      if (owners.length > 1) {
        reasons.set(name, { reason: 'duplicate', conflictWith: owners.filter((owner) => owner !== name) })
        this.log('Shortcut duplicated:', accelerator, owners.join(', '))
        continue
      }
      // Validate before touching Electron: a stored accelerator the recorder should have
      // rejected ("Process") is reported as invalid without ever reaching
      // globalShortcut.register, whose failure mode is a thrown conversion error.
      if (!isValidAccelerator(accelerator)) {
        reasons.set(name, { reason: 'invalid', message: `invalid accelerator: ${accelerator}` })
        this.log('Shortcut invalid:', accelerator)
        continue
      }
      target.set(name, accelerator)
    }
    return { entries, target, reasons }
  }

  statusesFor(shortcuts, analysis = this.analyze(shortcuts)) {
    const statuses = {}
    for (const [name, accelerator] of analysis.entries) {
      if (!accelerator) {
        statuses[name] = { accelerator: '', registered: false, reason: 'disabled' }
        continue
      }
      const reason = analysis.reasons.get(name)
      if (reason) {
        statuses[name] = { accelerator, registered: false, ...reason }
        continue
      }
      statuses[name] = this.bindings.get(name) === accelerator
        ? { accelerator, registered: true, reason: 'registered' }
        : { accelerator, registered: false, reason: 'unavailable' }
    }
    return statuses
  }

  applyStatuses(shortcuts, analysis) {
    this.currentShortcuts = { ...(shortcuts || {}) }
    this.statuses = this.statusesFor(shortcuts, analysis)
    return this.getStatuses()
  }

  // Cold start / game-mode exit: nothing reliable is bound, so bind the whole map.
  registerAll(shortcuts = {}) {
    this.globalShortcut.unregisterAll()
    this.bindings.clear()
    const analysis = this.analyze(shortcuts)
    for (const [name, accelerator] of analysis.target) this.registerBinding(name, accelerator)
    return this.applyStatuses(shortcuts, analysis)
  }

  // A03: the runtime rebind transaction.
  //   * unrelated bindings are never touched;
  //   * a new combination is registered BEFORE the old one is released, so a rejection
  //     leaves the working key in place;
  //   * a swap (two names exchanging accelerators) releases both first and rolls the whole
  //     set back if either registration fails.
  // Returns `{ ok, statuses, changed }` or `{ ok:false, failed, blockedRestore, statuses }`.
  sync(shortcuts = {}) {
    const analysis = this.analyze(shortcuts)
    const changed = []
    const allNames = new Set([...analysis.target.keys(), ...this.bindings.keys()])
    for (const name of allNames) {
      if ((analysis.target.get(name) || '') !== (this.bindings.get(name) || '')) changed.push(name)
    }
    if (!changed.length) return { ok: true, statuses: this.applyStatuses(shortcuts, analysis), changed }

    const snapshot = new Map(this.bindings)
    const previousValues = new Map(changed.map((name) => [name, this.bindings.get(name) || '']))
    const targetValues = new Set(changed.map((name) => normalizeAccelerator(analysis.target.get(name) || '')).filter(Boolean))
    // A swap needs the old key released before the new owner can take it.
    const releaseFirst = changed.some((name) => targetValues.has(normalizeAccelerator(previousValues.get(name) || '')))
    let failed = null

    if (releaseFirst) {
      for (const name of changed) {
        const previous = previousValues.get(name)
        if (!previous) continue
        this.unregisterAccelerator(previous)
        this.bindings.delete(name)
      }
      for (const name of changed) {
        const accelerator = analysis.target.get(name)
        if (!accelerator) continue
        if (!this.registerBinding(name, accelerator)) {
          failed = { name, accelerator, reason: 'unavailable' }
          break
        }
      }
    } else {
      for (const name of changed) {
        const accelerator = analysis.target.get(name)
        if (!accelerator) continue
        if (!this.registerBinding(name, accelerator)) {
          failed = { name, accelerator, reason: 'unavailable' }
          break
        }
      }
      if (!failed) {
        for (const name of changed) {
          const previous = previousValues.get(name)
          if (!previous || previous === analysis.target.get(name)) continue
          this.unregisterAccelerator(previous)
        }
      }
    }

    if (failed) {
      // Restore exactly what was bound before the attempt. A key another process grabbed
      // in the meantime cannot come back; that is reported, never hidden.
      const blockedRestore = this.restoreBindings(snapshot)
      this.statuses = this.statusesFor(this.currentShortcuts)
      return { ok: false, failed, blockedRestore, statuses: this.getStatuses() }
    }

    return { ok: true, statuses: this.applyStatuses(shortcuts, analysis), changed }
  }

  restoreBindings(snapshot) {
    for (const [name, accelerator] of [...this.bindings]) {
      if (snapshot.get(name) === accelerator) continue
      this.unregisterAccelerator(accelerator)
      this.bindings.delete(name)
    }
    const blocked = []
    for (const [name, accelerator] of snapshot) {
      if (this.bindings.get(name) === accelerator) continue
      if (!this.registerBinding(name, accelerator)) blocked.push({ name, accelerator })
    }
    return blocked
  }

  suspendAll(shortcuts = {}, reason = 'suspended') {
    this.globalShortcut.unregisterAll()
    this.bindings.clear()
    this.currentShortcuts = { ...(shortcuts || {}) }
    this.statuses = Object.fromEntries(
      Object.entries(shortcuts).map(([name, value]) => {
        const accelerator = String(value || '').trim()
        return [name, accelerator
          ? { accelerator, registered: false, reason }
          : { accelerator: '', registered: false, reason: 'disabled' }]
      })
    )
    return this.getStatuses()
  }

  getStatuses() {
    return cloneStatuses(this.statuses)
  }

  dispose() {
    this.globalShortcut.unregisterAll()
    this.bindings.clear()
    this.statuses = {}
  }
}

module.exports = {
  ShortcutService,
  normalizeAccelerator
}
