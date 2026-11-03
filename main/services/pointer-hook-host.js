'use strict'

// Owns the native mouse hook inside a dedicated utility process (R5 event track,
// docs/plans/2026-11-03-recording-r5-contracts.md §2.1).
//
// Deliberately independent from main/services/selection-hook-host.js: the recording event track
// must not depend on (or disturb) the text-selection service, and it must never subscribe to text
// selection, clipboard or keyboard events. This host only turns raw global mouse input into
// `{ type: 'pointer', kind, x, y, button, at }` messages:
//
//   * kind 'move' | 'down' | 'up'
//   * x/y are PHYSICAL screen pixels (the service converts them to DIP and then to normalized
//     source-content coordinates)
//   * at is wall-clock `Date.now()`, which the main process later maps to media time
//   * moves are throttled here to 20 Hz and deduped by coordinate so a slow pointer does not fill
//     the bounded buffer. Down/up are never throttled (they drive the click track).

const SelectionHook = require('selection-hook')

const MOVE_INTERVAL_MS = 50
const COORDINATE_LIMIT = 100000

let hook = null
let disposed = false
let lastMove = { x: null, y: null, at: 0 }

function parentPort() {
  return process.parentPort || null
}

function send(message) {
  if (disposed && message?.type !== 'status') return
  try {
    const port = parentPort()
    if (port) port.postMessage(message)
    else if (typeof process.send === 'function') process.send(message)
  } catch {}
}

function normalizePoint(data) {
  const x = Math.round(Number(data?.x))
  const y = Math.round(Number(data?.y))
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  if (Math.abs(x) > COORDINATE_LIMIT || Math.abs(y) > COORDINATE_LIMIT) return null
  return { x, y }
}

function emitPointer(kind, data) {
  const point = normalizePoint(data)
  if (!point) return
  const at = Date.now()
  if (kind === 'move') {
    // Contract §2.1: >= 50 ms AND a coordinate change. A click updates the baseline so the first
    // move after a click is not swallowed by the previous move's timestamp.
    if (point.x === lastMove.x && point.y === lastMove.y) return
    if (at - lastMove.at < MOVE_INTERVAL_MS) return
    lastMove = { x: point.x, y: point.y, at }
    send({ type: 'pointer', kind: 'move', x: point.x, y: point.y, button: -1, at })
    return
  }
  lastMove = { x: point.x, y: point.y, at }
  const rawButton = Number(data?.button)
  const button = Number.isInteger(rawButton) ? rawButton : -1
  send({ type: 'pointer', kind, x: point.x, y: point.y, button, at })
}

function stopHook(reason = 'stop') {
  if (!hook) {
    send({ type: 'status', status: 'stopped', reason, hookRunning: false })
    return true
  }
  try {
    hook.disableMouseMoveEvent?.()
  } catch {}
  try {
    hook.stop()
  } catch (error) {
    send({ type: 'error', message: error?.message || String(error) })
  }
  hook = null
  send({ type: 'status', status: 'stopped', reason, hookRunning: false })
  return true
}

function startHook() {
  if (disposed) return false
  try {
    if (hook) {
      try { hook.stop() } catch {}
      try { hook.cleanup() } catch {}
      hook = null
    }
    lastMove = { x: null, y: null, at: 0 }
    hook = new SelectionHook()
    hook.on('mouse-move', (data) => emitPointer('move', data))
    hook.on('mouse-down', (data) => emitPointer('down', data))
    hook.on('mouse-up', (data) => emitPointer('up', data))
    hook.on('status', (status) => {
      // startHook() reports 'started' once below; do not duplicate it.
      if (status === 'started') return
      send({ type: 'status', status, hookRunning: hook ? !!hook.isRunning() : false })
    })
    hook.on('error', (error) => {
      send({ type: 'error', message: error?.message || String(error) })
    })
    // Clipboard and text-selection subscriptions stay off by contract (§0 principle 5).
    const started = hook.start({ debug: false, enableClipboard: false })
    if (started === false) {
      try { hook.cleanup() } catch {}
      hook = null
      send({ type: 'status', status: 'start-failed', hookRunning: false })
      return false
    }
    try {
      hook.enableMouseMoveEvent()
    } catch (error) {
      send({ type: 'error', message: error?.message || String(error) })
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

function handleMessage(raw) {
  const message = raw && typeof raw === 'object' && 'data' in raw && raw.data && typeof raw.data === 'object'
    ? raw.data
    : raw
  if (!message || typeof message !== 'object') return
  switch (message.type) {
    case 'start':
      startHook()
      break
    case 'stop':
      stopHook(message.reason || 'stop')
      break
    case 'ping':
      send({
        type: 'pong',
        hookRunning: !!hook && (() => {
          try { return !!hook.isRunning() } catch { return false }
        })(),
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
