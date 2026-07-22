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
  setOpacity: (opacity) => ipcRenderer.send('pin:set-opacity', opacity),
  resize: (factor) => ipcRenderer.send('pin:resize', { factor }),
  beginMove: () => ipcRenderer.send('pin:move-start'),
  move: () => ipcRenderer.send('pin:move'),
  endMove: () => ipcRenderer.send('pin:move-end'),
  onZoomChanged: (callback) => {
    const handler = (_event, zoom) => callback(zoom)
    ipcRenderer.on('pin:zoom-changed', handler)
    return () => ipcRenderer.removeListener('pin:zoom-changed', handler)
  },
  toggleClickThrough: () => ipcRenderer.send('pin:toggle-click-through')
})
