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
// DEV-04: JS-side second line of the keyboard privacy filter. The native addon already drops
// plain typing / IME / repeats / sensitive focus, but events.json is privacy-sensitive and the
// utility process must never forward anything outside the frozen capsule grammar.
const { inspectGlobalKeystroke } = require('../domains/record/keystroke-capture')

const MOVE_INTERVAL_MS = 50
const COORDINATE_LIMIT = 100000

let hook = null
let disposed = false
let lastMove = { x: null, y: null, at: 0 }
// DEV-04: keyboard capture is opt-in per take (config.demoKeystrokes) and only enabled while the
// take is actually recording. 'off' | 'enabled' | 'unsupported' | 'error'.
let keyboardOptIn = false
let keyboardRequested = false
let keyboardMode = 'off'

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
  setKeyboardEventsEnabled(false)
  keyboardMode = 'off'
  keyboardRequested = false
  keyboardOptIn = false
  if (!hook) {
    send({ type: 'status', status: 'stopped', reason, hookRunning: false, keyboard: 'off' })
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
  send({ type: 'status', status: 'stopped', reason, hookRunning: false, keyboard: 'off' })
  return true
}

// DEV-04 native contract: `setKeyboardEventsEnabled(bool)` is opt-in, default off, and cleared by
// stop()/cleanup(). Feature-detected so a stale addon binary simply keeps keyboard capture off
// instead of breaking recording.
function setKeyboardEventsEnabled(enabled) {
  if (!hook) return false
  if (typeof hook.setKeyboardEventsEnabled !== 'function') {
    keyboardMode = enabled ? 'unsupported' : 'off'
    return false
  }
  try {
    const applied = hook.setKeyboardEventsEnabled(enabled === true)
    keyboardMode = enabled === true ? (applied === false ? 'unsupported' : 'enabled') : 'off'
    return applied !== false
  } catch (error) {
    keyboardMode = 'error'
    send({ type: 'error', message: error?.message || String(error) })
    return false
  }
}

// Native `key-combo` payload: { tMs, vkCode, scanCode, modifiers, combo, context }. The native
// hook only emits combos whose event-time focus it positively classified as a safe non-text
// surface (`context: 'safe'`); password/text-input/IME/unknown focus is dropped before
// JavaScript. The filter re-validates the label AND requires that positive context, then returns
// only `{ at, combo }`; nothing else leaves this process.
function forwardKeyCombo(payload) {
  if (disposed || !keyboardRequested) return
  const accepted = inspectGlobalKeystroke(payload)
  if (!accepted.ok) return
  send({ type: 'keystroke', combo: accepted.combo, at: accepted.at })
}

function startHook(startMessage = {}) {
  if (disposed) return false
  keyboardOptIn = startMessage.keystrokes === true
  keyboardRequested = keyboardOptIn
  keyboardMode = 'off'
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
    // DEV-04: subscribe BEFORE the hook starts so the first shortcut of a take is not missed.
    // Unknown event names are harmless on EventEmitter-like addons, and `keyboardRequested`
    // gates forwarding even if a legacy addon happens to emit something.
    if (keyboardRequested && typeof hook.on === 'function') {
      hook.on('key-combo', (data) => forwardKeyCombo(data))
    }
    hook.on('status', (status) => {
      // startHook() reports 'started' once below; do not duplicate it.
      if (status === 'started') return
      send({ type: 'status', status, hookRunning: hook ? !!hook.isRunning() : false, keyboard: keyboardMode })
    })
    hook.on('error', (error) => {
      send({ type: 'error', message: error?.message || String(error) })
    })
    // Clipboard and text-selection subscriptions stay off by contract (§0 principle 5).
    const started = hook.start({ debug: false, enableClipboard: false })
    if (started === false) {
      try { hook.cleanup() } catch {}
      hook = null
      send({ type: 'status', status: 'start-failed', hookRunning: false, keyboard: 'off' })
      return false
    }
    try {
      hook.enableMouseMoveEvent()
    } catch (error) {
      send({ type: 'error', message: error?.message || String(error) })
    }
    if (keyboardRequested) setKeyboardEventsEnabled(true)
    send({ type: 'status', status: 'started', hookRunning: true, keyboard: keyboardMode })
    return true
  } catch (error) {
    hook = null
    keyboardMode = 'off'
    send({ type: 'error', message: error?.message || String(error) })
    send({ type: 'status', status: 'start-failed', hookRunning: false, keyboard: 'off' })
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
      startHook(message)
      break
    case 'stop':
      stopHook(message.reason || 'stop')
      break
    // DEV-04 lifecycle: enable/disable global keyboard capture without tearing down the mouse
    // hook (pause/resume, or a take that opted in/out). A disable message is exact: no
    // `key-combo` is forwarded after it returns. Enabling is only possible for a take that opted
    // in through the start message, so a buggy/late message cannot turn capture on.
    case 'keyboard': {
      keyboardRequested = keyboardOptIn && message.enabled === true
      setKeyboardEventsEnabled(keyboardRequested)
      send({ type: 'status', status: 'keyboard', enabled: keyboardRequested, keyboard: keyboardMode })
      break
    }
    case 'ping':
      send({
        type: 'pong',
        hookRunning: !!hook && (() => {
          try { return !!hook.isRunning() } catch { return false }
        })(),
        keyboard: keyboardMode,
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
