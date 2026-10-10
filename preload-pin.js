const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('pinAPI', {
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
  close: () => ipcRenderer.send('pin:close'),
  copy: () => ipcRenderer.send('pin:copy'),
  save: () => ipcRenderer.send('pin:save'),
  contextMenu: (imageBounds) => ipcRenderer.send('pin:context-menu', imageBounds),
  resize: (factor) => ipcRenderer.send('pin:resize', { factor }),
  beginMove: () => ipcRenderer.send('pin:move-start'),
  move: () => ipcRenderer.send('pin:move'),
  endMove: () => ipcRenderer.send('pin:move-end'),
  onZoomChanged: (callback) => {
    const handler = (_event, zoom) => callback(zoom)
    ipcRenderer.on('pin:zoom-changed', handler)
    return () => ipcRenderer.removeListener('pin:zoom-changed', handler)
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
