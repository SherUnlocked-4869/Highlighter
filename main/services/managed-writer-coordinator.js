class ManagedWriterCoordinator {
  constructor() {
    this.blocked = false
    this.inFlight = new Set()
  }

  assertOpen() {
    if (this.blocked) throw new Error('数据目录正在迁移，请稍候')
  }

  track(task, { allowBlocked = false } = {}) {
    if (this.blocked && !allowBlocked) {
      const rejection = Promise.reject(new Error('数据目录正在迁移，请稍候'))
      rejection.catch(() => {})
      return rejection
    }
    const promise = Promise.resolve(typeof task === 'function' ? task() : task)
    this.inFlight.add(promise)
    promise.then(
      () => this.inFlight.delete(promise),
      () => this.inFlight.delete(promise)
    )
    return promise
  }

  block() {
    this.blocked = true
  }

  resume() {
    this.blocked = false
  }

  async waitForIdle() {
    while (this.inFlight.size) {
      await Promise.allSettled([...this.inFlight])
    }
    await Promise.resolve()
    if (this.inFlight.size) await this.waitForIdle()
  }
}

async function quiesceAndMigrate({ coordinator, stopWriters, migrate, relaunch }) {
  coordinator.block()
  try {
    await stopWriters()
    await coordinator.waitForIdle()
    await migrate()
  } catch (error) {
    coordinator.resume()
    throw error
  }
  relaunch()
}

module.exports = { ManagedWriterCoordinator, quiesceAndMigrate }
