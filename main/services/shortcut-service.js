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
  }

  registerAll(shortcuts = {}) {
    this.globalShortcut.unregisterAll()
    const entries = Object.entries(shortcuts)
      .map(([name, accelerator]) => [name, String(accelerator || '').trim()])
    const ownersByAccelerator = new Map()

    for (const [name, accelerator] of entries) {
      if (!accelerator) continue
      const normalized = normalizeAccelerator(accelerator)
      const owners = ownersByAccelerator.get(normalized) || []
      owners.push(name)
      ownersByAccelerator.set(normalized, owners)
    }

    const statuses = {}
    for (const [name, accelerator] of entries) {
      if (!accelerator) {
        statuses[name] = { accelerator: '', registered: false, reason: 'disabled' }
        continue
      }

      const owners = ownersByAccelerator.get(normalizeAccelerator(accelerator)) || []
      if (owners.length > 1) {
        statuses[name] = {
          accelerator,
          registered: false,
          reason: 'duplicate',
          conflictWith: owners.filter((owner) => owner !== name)
        }
        this.log('Shortcut duplicated:', accelerator, owners.join(', '))
        continue
      }

      try {
        const registered = this.globalShortcut.register(accelerator, () => {
          Promise.resolve()
            .then(() => this.executeFunction(name))
            .catch((error) => this.log('Shortcut error:', name, error?.message || String(error)))
        })
        statuses[name] = {
          accelerator,
          registered,
          reason: registered ? 'registered' : 'unavailable'
        }
        if (!registered) this.log('Shortcut unavailable:', accelerator)
      } catch (error) {
        statuses[name] = {
          accelerator,
          registered: false,
          reason: 'invalid',
          message: error?.message || String(error)
        }
        this.log('Shortcut registration failed:', accelerator, error?.message || String(error))
      }
    }

    this.statuses = statuses
    return this.getStatuses()
  }

  getStatuses() {
    return cloneStatuses(this.statuses)
  }

  dispose() {
    this.globalShortcut.unregisterAll()
    this.statuses = {}
  }
}

module.exports = {
  ShortcutService,
  normalizeAccelerator
}
