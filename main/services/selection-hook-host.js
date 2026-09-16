'use strict'

// Owns the native selection-hook inside a dedicated utility/child process.
// Isolates COM/UIA and WH_*_LL lifetime from the Electron main process so
// a wedged hook can be recovered by killing and forking this process.

const SelectionHook = require('selection-hook')

let hook = null
let disposed = false
const lastInputAt = { value: 0 }

function parentPort() {
  return process.parentPort || null
}

function send(message) {
  if (disposed) return
  try {
    const port = parentPort()
    if (port) port.postMessage(message)
    else if (typeof process.send === 'function') process.send(message)
  } catch {}
}

function markInput() {
  lastInputAt.value = Date.now()
}

function stopHook(reason = 'stop') {
  if (!hook) {
    send({ type: 'status', status: 'stopped', reason, hookRunning: false })
    return true
  }
  try {
    hook.stop()
  } catch (error) {
    send({ type: 'error', message: error?.message || String(error) })
  }
  hook = null
  send({ type: 'status', status: 'stopped', reason, hookRunning: false })
  return true
}

function startHook(options = {}) {
  if (disposed) return false
  try {
    if (hook) {
      try { hook.stop() } catch {}
      try { hook.cleanup() } catch {}
      hook = null
    }
    hook = new SelectionHook()
    hook.on('text-selection', (data) => {
      markInput()
      send({ type: 'event', event: 'text-selection', data })
    })
    hook.on('mouse-down', (data) => {
      markInput()
      send({ type: 'event', event: 'mouse-down', data })
    })
    hook.on('mouse-wheel', (data) => {
      markInput()
      send({ type: 'event', event: 'mouse-wheel', data })
    })
    hook.on('key-down', (data) => {
      markInput()
      send({ type: 'event', event: 'key-down', data })
    })
    hook.on('status', (status) => {
      // startHook() reports started once after a successful start; avoid duplicates.
      if (status === 'started') return
      send({ type: 'status', status, hookRunning: hook ? !!hook.isRunning() : false })
    })
    hook.on('error', (error) => {
      send({ type: 'error', message: error?.message || String(error) })
    })
    const started = hook.start({
      debug: options.debug === true,
      enableClipboard: options.enableClipboard === true
    })
    if (started === false) {
      try { hook.cleanup() } catch {}
      hook = null
      send({ type: 'status', status: 'start-failed', hookRunning: false })
      return false
    }
    send({ type: 'status', status: 'started', hookRunning: true })
    return true
  } catch (error) {
    hook = null
    send({ type: 'error', message: error?.message || String(error) })
    send({ type: 'status', status: 'start-failed', hookRunning: false })
    return false
  }
}

function updateOptions(options = {}) {
  if (!hook) return false
  try {
    if (options.enableClipboard === true) hook.enableClipboard()
    else if (options.enableClipboard === false) hook.disableClipboard()
    return true
  } catch (error) {
    send({ type: 'error', message: error?.message || String(error) })
    return false
  }
}

function handleMessage(raw) {
  const message = raw && typeof raw === 'object' && 'data' in raw && raw.data && typeof raw.data === 'object'
    ? raw.data
    : raw
  if (!message || typeof message !== 'object') return
  switch (message.type) {
    case 'start':
      startHook(message.options || {})
      break
    case 'stop':
      stopHook(message.reason || 'stop')
      break
    case 'update-options':
      updateOptions(message.options || {})
      break
    case 'ping':
      send({
        type: 'pong',
        hookRunning: !!hook && (() => {
          try { return !!hook.isRunning() } catch { return false }
        })(),
        lastInputAt: lastInputAt.value,
        pid: process.pid
      })
      break
    case 'dispose':
      disposed = true
      stopHook('dispose')
      try { hook?.cleanup() } catch {}
      hook = null
      setTimeout(() => process.exit(0), 10)
      break
    default:
      break
  }
}

function bindParent() {
  const port = parentPort()
  if (port) {
    port.on('message', handleMessage)
    return
  }
  process.on('message', handleMessage)
}

bindParent()
send({ type: 'ready', pid: process.pid })
