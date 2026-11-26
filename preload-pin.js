const { contextBridge, ipcRenderer } = require('electron')

// N05: the only commands the workspace surface accepts. Keep the list in sync with
// WORKSPACE_COMMAND_TYPES in main/domains/pin/index.js; an unknown type is dropped
// here so a wedged renderer cannot reach the main process with a made-up action.
const WORKSPACE_COMMAND_TYPES = Object.freeze([
  'workspace-save',
  'workspace-restore',
  'workspace-restore-latest',
  'workspace-delete',
  'workspace-suspend',
  'workspace-resume',
  'workspace-list'
])
const MAX_SNAPSHOT_NAME = 64
const SNAPSHOT_ID = /^[a-z0-9-]{1,64}$/

function normalizeWorkspaceCommand(value) {
  if (!value || typeof value !== 'object') return null
  const type = typeof value.type === 'string' ? value.type : ''
  if (!WORKSPACE_COMMAND_TYPES.includes(type)) return null
  const name = typeof value.name === 'string'
    ? value.name.replace(/\s+/g, ' ').trim().slice(0, MAX_SNAPSHOT_NAME)
    : ''
  const id = typeof value.id === 'string' && SNAPSHOT_ID.test(value.id) ? value.id : ''
  return { type, name, id }
}

contextBridge.exposeInMainWorld('pinAPI', {
  // P0-1-T2：语言广播（主→渲染；sandbox preload 不能 require 本地文件，故内联）。
  onInterfaceLanguage: (callback) => {
    const handler = (_event, language) => callback(typeof language === 'string' && language.length <= 16 ? language : '')
    ipcRenderer.on('i18n:language', handler)
    return () => ipcRenderer.removeListener('i18n:language', handler)
  },
  ready: () => ipcRenderer.send('pin:ready'),
  renderReady: () => ipcRenderer.send('pin:render-ready'),
  onInit: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('pin:init', handler)
    return () => ipcRenderer.removeListener('pin:init', handler)
  },
  onUpdate: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('pin:update', handler)
    return () => ipcRenderer.removeListener('pin:update', handler)
  },
  onRecognition: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('pin:recognition', handler)
    return () => ipcRenderer.removeListener('pin:recognition', handler)
  },
  close: () => ipcRenderer.send('pin:close'),
  copy: () => ipcRenderer.send('pin:copy'),
  save: () => ipcRenderer.send('pin:save'),
  contextMenu: (imageBounds) => ipcRenderer.send('pin:context-menu', imageBounds),
  resize: (factor) => ipcRenderer.send('pin:resize', { factor }),
  // P0 (plan §9.2-②): Ctrl+wheel changes opacity by 0.05 per notch. `direction`
  // is +1 for wheel-up (more opaque) and -1 for wheel-down; the main process
  // clamps to 0.25-1 and answers with the pin:opacity-changed receipt.
  adjustOpacity: (direction) => ipcRenderer.send('pin:set-opacity', Number(direction) < 0 ? -1 : 1),
  // P1 (plan §9.3): quarter-turn rotation. The renderer never applies the angle
  // itself on request - the main process owns _pinData.rotation and resizes the
  // window to the rotated bounding box, then echoes pin:rotation-changed.
  rotate: (delta = 90) => ipcRenderer.send('pin:rotate', delta),
  onRotationChanged: (callback) => {
    const handler = (_event, rotation) => callback(rotation)
    ipcRenderer.on('pin:rotation-changed', handler)
    return () => ipcRenderer.removeListener('pin:rotation-changed', handler)
  },
  // P0 (plan §0.3 #4): export the rendered pin window as a PDF; resolves to the
  // saved path, or null when the save dialog was cancelled.
  exportPdf: () => ipcRenderer.invoke('pin:export-pdf'),
  beginMove: () => ipcRenderer.send('pin:move-start'),
  move: () => ipcRenderer.send('pin:move'),
  // A07: the release point decides whether to snap; Alt bypasses it for this drag.
  endMove: (altKey = false) => ipcRenderer.send('pin:move-end', { altKey: altKey === true }),
  onZoomChanged: (callback) => {
    const handler = (_event, zoom) => callback(zoom)
    ipcRenderer.on('pin:zoom-changed', handler)
    return () => ipcRenderer.removeListener('pin:zoom-changed', handler)
  },
  // Main -> renderer receipt for the opacity (wheel and context-menu radio items).
  onOpacityChanged: (callback) => {
    const handler = (_event, percent) => callback(percent)
    ipcRenderer.on('pin:opacity-changed', handler)
    return () => ipcRenderer.removeListener('pin:opacity-changed', handler)
  },
  // N05 (review section 5.5): workspace snapshots. The pin renderer already owns a
  // single authorized renderer -> main listener (`pin:context-menu`); adding a new
  // channel would require editing the frozen IPC policy table in
  // main/services/ipc-security.js, so the bounded command travels in that channel's
  // optional second argument. No path ever crosses this boundary: the main process
  // only receives a command name, a snapshot name and an opaque snapshot id.
  workspaceCommand: (command) => {
    const normalized = normalizeWorkspaceCommand(command)
    if (!normalized) return false
    ipcRenderer.send('pin:context-menu', null, normalized)
    return true
  },
  // Main -> renderer: a menu item asked this window to open its naming overlay.
  onWorkspaceNameRequest: (callback) => {
    const handler = () => callback()
    ipcRenderer.on('pin:workspace-name-request', handler)
    return () => ipcRenderer.removeListener('pin:workspace-name-request', handler)
  },
  // Main -> renderer receipt for a workspace command (save/delete/list/restore
  // failure). Send-only on the main side, so it needs no sender policy.
  onWorkspaceResult: (callback) => {
    const handler = (_event, result) => callback(result && typeof result === 'object' ? result : null)
    ipcRenderer.on('pin:workspace-result', handler)
    return () => ipcRenderer.removeListener('pin:workspace-result', handler)
  },
  // Explicit boolean, never a toggle: the renderer's corner badge and the main
  // process' batch exit can both fire, and a flip would land on the wrong state.
  setClickThrough: (enabled) => ipcRenderer.send('pin:set-click-through', enabled === true),
  // Main -> renderer receipt. Sent for every applied change, including the ones
  // this renderer did not request (batch exit from the shortcut/tray).
  onClickThroughChanged: (callback) => {
    const handler = (_event, enabled) => callback(enabled === true)
    ipcRenderer.on('pin:click-through-changed', handler)
    return () => ipcRenderer.removeListener('pin:click-through-changed', handler)
  }
})
