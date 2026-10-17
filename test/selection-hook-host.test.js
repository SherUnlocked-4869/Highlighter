const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

function fixture() {
  const messages = []
  const instances = []
  class Hook extends EventEmitter {
    constructor() { super(); this.available = Promise.resolve(true); instances.push(this) }
    start() { return true }
    stop() {}
    cleanup() {}
    isRunning() { return true }
    setClipboardCoordinator(endpoint) { this.endpoint = endpoint; if (this.error) throw this.error }
    checkClipboardCoordinator() { return this.available }
  }
  const process = new EventEmitter()
  process.pid = 123
  process.send = (message) => messages.push(message)
  const sandbox = { process, require: (name) => { assert.equal(name, 'selection-hook'); return Hook }, setTimeout }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../main/services/selection-hook-host.js'), 'utf8'), sandbox)
  return { messages, instances, send: (message) => process.emit('message', message) }
}
const flush = async () => { await Promise.resolve(); await Promise.resolve() }

test('host configures the native channel privately and sanitizes failed acknowledgements', async () => {
  const app = fixture()
  app.send({ type: 'set-clipboard-coordinator', requestId: 1, endpoint: null })
  assert.equal(app.messages.at(-1).code, 'HOST_NOT_RUNNING')
  app.send({ type: 'start' })
  const endpoint = { nonce: 'synthetic-private-value' }
  app.send({ type: 'set-clipboard-coordinator', requestId: 2, endpoint })
  await flush()
  assert.equal(app.instances[0].endpoint, endpoint)
  assert.equal(app.messages.at(-1).code, 'APPLIED')
  app.instances[0].error = new Error('Clipboard coordinator requires idle selection worker')
  app.send({ type: 'set-clipboard-coordinator', requestId: 3, endpoint })
  await flush()
  assert.equal(app.messages.at(-1).code, 'SELECTION_BUSY')
  app.instances[0].error = new Error('synthetic-private-value')
  app.send({ type: 'set-clipboard-coordinator', requestId: 4, endpoint })
  await flush()
  assert.equal(app.messages.at(-1).code, 'INVALID_COORDINATOR')
  assert.ok(!JSON.stringify(app.messages).includes(endpoint.nonce))
})

test('health checks from a stopped hook cannot configure its replacement', async () => {
  const app = fixture()
  app.send({ type: 'start' })
  let release
  app.instances[0].available = new Promise((resolve) => { release = resolve })
  app.send({ type: 'set-clipboard-coordinator', requestId: 10, endpoint: {} })
  app.send({ type: 'start' })
  release(true)
  await flush()
  assert.equal(app.messages.at(-1).ok, false)
  assert.equal(app.messages.at(-1).code, 'HOST_CHANGED')
  assert.equal(app.instances[1].endpoint, undefined)
})
