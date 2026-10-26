'use strict'

// M2/W6b: `window:renderer-state` lets the main window's renderer report
// `{ route, dirty, dirtyReason }` before it is hidden. It is a one-way send: the
// main process only validates and records it, there is never a reply, so a
// compromised renderer cannot block or spoof a reclaim decision beyond reporting
// itself clean (which is why main-window-reclaimer.js also requires a SAFE route
// and why the sender check below is repeated outside the generic IPC guard).
//
// Lives in main/ipc (not main/services) because the IPC surface inventory test
// scans main/ipc and main/domains for `ipcMain.on(...)` literals: a registration
// hidden in a service module would silently escape the policy-coverage gate.
const { RENDERER_ROUTES } = require('../services/main-window-reclaimer')

const WINDOW_STATE_CHANNEL = 'window:renderer-state'
const MAX_DIRTY_REASON_LENGTH = 120

function registerWindowReclaimIpc({ ipcMain, state, getMainWindow, log = () => {} } = {}) {
  if (!ipcMain || typeof ipcMain.on !== 'function') throw new TypeError('Window reclaim IPC requires ipcMain.on')
  if (!state || typeof state.set !== 'function') throw new TypeError('Window reclaim IPC requires the renderer window state store')
  if (typeof getMainWindow !== 'function') throw new TypeError('Window reclaim IPC requires getMainWindow')

  function listener(event, payload) {
    const win = getMainWindow()
    const sender = event?.sender
    // Only the live main window's own webContents may report; a destroyed window
    // (or a report that arrives after destruction) is dropped.
    if (!win || !sender || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return false
    if (!win.webContents || sender !== win.webContents) {
      log('window-state-rejected', { reason: 'sender-not-main-window' })
      return false
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false
    // Field validation is per-field and silent: an invalid payload keeps the
    // previously recorded (safe) state rather than throwing in the main process.
    const { route, dirty, dirtyReason } = payload
    if (typeof route !== 'string' || !RENDERER_ROUTES.includes(route)) return false
    if (typeof dirty !== 'boolean') return false
    const reason = dirty && typeof dirtyReason === 'string' ? dirtyReason.slice(0, MAX_DIRTY_REASON_LENGTH) : ''
    state.set({ route, dirty, dirtyReason: reason })
    log('window-state-reported', { route, dirty, dirtyReason: reason })
    return true
  }

  // The channel is spelled as a literal on purpose: the IPC surface inventory
  // test scans main/ipc for registration call sites, and a constant here would
  // make this registration invisible to the policy-coverage gate.
  ipcMain.on('window:renderer-state', listener)
  return { channel: WINDOW_STATE_CHANNEL, listener }
}

module.exports = { WINDOW_STATE_CHANNEL, registerWindowReclaimIpc }
