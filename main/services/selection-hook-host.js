'use strict'

// Owns the native selection-hook inside a dedicated utility/child process.
// Isolates COM/UIA and WH_*_LL lifetime from the Electron main process so
// a wedged hook can be recovered by killing and forking this process.

const SelectionHook = require('selection-hook')

let hook = null
let disposed = false
const lastInputAt = { value: 0 }
// F02 (docs/reviews/2026-11-26-code-review-and-optimization-report.md §3.2): the
// toolbar's visibility is mirrored here so everyday typing and scrolling do not
// wake the Electron main process for nothing. The native layer keeps observing
// input (highlighter::ObserveInput drives the clipboard guardrail/lease logic), so
// only the cross-process forward is gated. A fresh host starts hidden: the first
// selection is what makes the toolbar visible, and that event is always forwarded.
let toolbarVisible = false

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

// Only a visible toolbar has anything to do with these events: key-down and
// mouse-wheel hide it, mouse-down decides whether a click landed outside it.
// Forwarding them while it is hidden bought a cross-process wakeup per keystroke
// and per wheel tick, so the flag gates the forward while markInput() above still
// records that input happened (the pong diagnostic stays truthful).
function forwardInput(event, data) {
  if (!toolbarVisible) return false
  send({ type: 'event', event, data })
  return true
}

function clipboardCoordinatorDiagnostics() {
  try { return hook?.getClipboardCoordinatorDiagnostics?.() || null } catch { return null }
}

// U04 (docs/reviews/2026-11-26-code-review-and-optimization-report.md §4.4): the
// application blacklist is owned by the main process, but the clipboard fallback
// injects Ctrl+C from this process's native hook thread, long after the selection
// event was filtered there. Terminals resolve that shortcut as SIGINT, so a
// blacklisted application (or a terminal) used to have its running command
// interrupted. Mirror the list into the native clipboard filter (EXCLUDE_LIST) over
// the existing host channel; no new native method or ABI change is involved.
const CLIPBOARD_FILTER_EXCLUDE_LIST = 2 // selection-hook FilterMode.EXCLUDE_LIST

// The list is untrusted input from the parent: keep it a bounded array of lowercase
// names. A malformed entry is dropped instead of failing the whole start.
function sanitizeClipboardExcludedApps(value) {
  if (!Array.isArray(value)) return null
  const apps = []
  const seen = new Set()
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const name = entry.trim().toLowerCase().slice(0, 128)
    if (!name || seen.has(name)) continue
    seen.add(name)
    apps.push(name)
    if (apps.length >= 128) break
  }
  return apps
}

function clipboardProtectionConfig(options) {
  const apps = sanitizeClipboardExcludedApps(options.clipboardExcludedApps)
  if (!apps) return {}
  return { clipboardMode: CLIPBOARD_FILTER_EXCLUDE_LIST, clipboardFilterList: apps }
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
    // Replacement hosts cannot use clipboard fallback before registration.
    if (options.clipboardCoordinationRequired === true) {
      try { hook.setClipboardCoordinator({}) } catch {}
    }
    hook.on('text-selection', (data) => {
      markInput()
      // The only event the hidden surface still needs: it is what shows the toolbar.
      send({ type: 'event', event: 'text-selection', data })
    })
    hook.on('mouse-down', (data) => {
      markInput()
      forwardInput('mouse-down', data)
    })
    hook.on('mouse-wheel', (data) => {
      markInput()
      forwardInput('mouse-wheel', data)
    })
    hook.on('key-down', (data) => {
      markInput()
      forwardInput('key-down', data)
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
      enableClipboard: options.enableClipboard === true,
      ...clipboardProtectionConfig(options)
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
    // The parent re-sends the complete option set, so a blacklist change rides along
    // with the existing clipboard-fallback setting update.
    const apps = sanitizeClipboardExcludedApps(options.clipboardExcludedApps)
    if (apps && typeof hook.setClipboardMode === 'function') {
      hook.setClipboardMode(CLIPBOARD_FILTER_EXCLUDE_LIST, apps)
    }
    return true
  } catch (error) {
    send({ type: 'error', message: error?.message || String(error) })
    return false
  }
}

async function configureClipboardCoordinator(message) {
  const current = hook
  const reply = (ok, code) => send({ type: 'clipboard-coordinator-ack', requestId: message.requestId, ok, code })
  if (!current) { reply(false, 'HOST_NOT_RUNNING'); return }
  try {
    current.setClipboardCoordinator(message.endpoint)
    const available = message.endpoint === null || await current.checkClipboardCoordinator()
    reply(current === hook && available, current !== hook ? 'HOST_CHANGED' : available ? 'APPLIED' : 'COORDINATOR_UNAVAILABLE')
  } catch (error) {
    reply(false, error?.message === 'Clipboard coordinator requires idle selection worker' ? 'SELECTION_BUSY' : 'INVALID_COORDINATOR')
  }
}

function handleMessage(raw) {
  const message = raw && typeof raw === 'object' && 'data' in raw && raw.data && typeof raw.data === 'object'
    ? raw.data
    : raw
  if (!message || typeof message !== 'object') return
  switch (message.type) {
    case 'set-clipboard-coordinator':
      void configureClipboardCoordinator(message)
      break
    case 'start':
      startHook(message.options || {})
      break
    case 'stop':
      stopHook(message.reason || 'stop')
      break
    case 'update-options':
      updateOptions(message.options || {})
      break
    case 'toolbar-visibility':
      // The main process owns the toolbar window; this process only mirrors the
      // state. The native hook keeps running and counting input either way.
      toolbarVisible = message.visible === true
      break
    case 'ping':
      send({
        type: 'pong',
        hookRunning: !!hook && (() => {
          try { return !!hook.isRunning() } catch { return false }
        })(),
        lastInputAt: lastInputAt.value,
        clipboardCoordinator: clipboardCoordinatorDiagnostics(),
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
