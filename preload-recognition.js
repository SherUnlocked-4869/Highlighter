const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('recognitionAPI', {
  // P0-1-T2：语言广播（主→渲染；sandbox preload 不能 require 本地文件，故内联）。
  onInterfaceLanguage: (callback) => {
    const handler = (_event, language) => callback(typeof language === 'string' && language.length <= 16 ? language : '')
    ipcRenderer.on('i18n:language', handler)
    return () => ipcRenderer.removeListener('i18n:language', handler)
  },
  ready: () => ipcRenderer.send('recognition:ready'),
  onInit: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('recognition:init', handler)
    return () => ipcRenderer.removeListener('recognition:init', handler)
  },
  recognizeTable: (dataUrl, scaleFactor) => ipcRenderer.invoke('recognition:table', { dataUrl, scaleFactor }),
  copyText: (text) => ipcRenderer.invoke('recognition:copy', text),
  // Table recognition → .xlsx (analysis plan §6.2①). The renderer sends the rows
  // it is displaying back; `merges` is optional and only passed when known.
  exportExcel: (rows, merges) => ipcRenderer.invoke('recognition:export-excel', { rows, merges }),
  // Result window → .pdf through the already-rendered window (plan §0.3 #4).
  exportPdf: (options) => ipcRenderer.invoke('recognition:export-pdf', options),
  // Feature A (docs/plans/2026-10-25-snow-apps-feature-development-plan.md §4.1): the result bar's
  // open / copy-address / open-folder actions. Addressed by resultId - never by path.
  exportAction: (resultId, action) => ipcRenderer.invoke('export:perform-action', { resultId, action }),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  close: () => ipcRenderer.send('recognition:close')
})
