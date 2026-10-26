const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('captureAPI', {
  // P0-1-T2：语言广播（主→渲染；sandbox preload 不能 require 本地文件，故内联）。
  onInterfaceLanguage: (callback) => {
    const handler = (_event, language) => callback(typeof language === 'string' && language.length <= 16 ? language : '')
    ipcRenderer.on('i18n:language', handler)
    return () => ipcRenderer.removeListener('i18n:language', handler)
  },
  ready: () => ipcRenderer.send('capture:ready'),
  onInit: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('capture:init', handler)
    return () => ipcRenderer.removeListener('capture:init', handler)
  },
  onShown: (callback) => {
    const handler = () => callback()
    ipcRenderer.on('capture:shown', handler)
    return () => ipcRenderer.removeListener('capture:shown', handler)
  },
  renderReady: () => ipcRenderer.send('capture:render-ready'),
  renderError: (message) => ipcRenderer.send('capture:render-error', message),
  // serialNumber 只在本次截图落过序号时才有值（0 = 没落过），用于主进程精确接续序号（P0-7-T7）。
  close: (serialNumber) => ipcRenderer.send('capture:close', { serialNumber }),
  // 录制/长截图在渲染层是"提前 return"，拿不到动作 meta，所以序号单独作为第二参带回
  // （P0-7-T7 精确接续的补充：这两个出口同样要"落过就推进"）。
  startLongCapture: (selection, serial) => ipcRenderer.invoke('capture:start-long', { selection, ...serial }),
  smartSelectAt: (point) => ipcRenderer.invoke('capture:smart-select', point),
  copy: (imageBuffer, meta) => ipcRenderer.invoke('capture:copy', { imageBuffer, meta }),
  save: (imageBuffer, meta, fast) => ipcRenderer.send('capture:save', { imageBuffer, meta, fast }),
  pin: (imageBuffer, meta) => ipcRenderer.invoke('capture:pin', { imageBuffer, meta }),
  pinAndReannotate: (imageBuffer, meta, action) => ipcRenderer.invoke('capture:pin-reannotate', { imageBuffer, meta, action }),
  openRecognition: (type, imageBuffer, meta) => ipcRenderer.invoke('capture:open-recognition', { type, imageBuffer, meta }),
  ocr: (imageBuffer, options) => ipcRenderer.invoke('capture:ocr', { imageBuffer, ...options }),
  translate: (imageBuffer, options) => ipcRenderer.invoke('capture:translate', { imageBuffer, ...options }),
  // P1 (2026-10-18 snow migration §6.2②): screenshot -> Markdown/HTML through the
  // vision-capable chat model. The main process owns the save dialog and the file
  // write, so the renderer only sends pixels plus the requested format.
  convertImage: (imageBuffer, options) => ipcRenderer.invoke('capture:convert-image', { imageBuffer, ...options }),
  startRegionRecording: (selectionBounds, serial) => ipcRenderer.invoke('capture:start-region-recording', { selectionBounds, ...serial }),
  recordHistory: (imageBuffer, meta) => ipcRenderer.invoke('capture:record-history', { imageBuffer, meta }),
  exportPdf: (imageBuffer, meta, mode) => ipcRenderer.invoke('capture:export-pdf', { imageBuffer, meta, mode }),
  // 批次 1（docs/plans/2026-10-25-history-reedit-batch0-contracts.md §4）：可编辑文档的统一
  // 提交入口。渲染层只传会话 + 幂等键 + 意图 + 冻结快照/结果图；文档与资源 id、路径、
  // 归属全部由主进程决定。返回值至少区分 committed / unchanged / conflict / failed。
  commitDocument: (payload) => ipcRenderer.invoke('capture:commit-document', payload),
  // 确认丢失后按 requestId 查询回执（过期返回 expired，不会悄悄再执行一次）。
  commitStatus: (payload) => ipcRenderer.invoke('capture:commit-status', payload),
  // 编辑器载入可编辑文档（或在 doc 损坏时拿到明确的降级信号）。
  loadDocument: (payload) => ipcRenderer.invoke('capture:load-document', payload),
  // Feature A（docs/plans/2026-10-25-snow-apps-feature-development-plan.md §4.2）：结果条动作。
  // 只传主进程刚登记的 resultId + 动作名；**不接受路径**，打开/定位/复制地址都在主进程做。
  exportAction: (resultId, action) => ipcRenderer.invoke('export:perform-action', { resultId, action }),
  // Feature B（同文档 §5.2）：尺寸预设与上次区域。渲染层提交的只有模式/预设 id，
  // 桌面坐标一律由主进程按当前屏幕解析后下发（rect 是 DIP，正好是渲染层绘制用的空间）。
  regionGetPreferences: () => ipcRenderer.invoke('region:get-preferences'),
  regionResolve: (payload) => ipcRenderer.invoke('region:resolve', payload),
  regionSavePreset: (payload) => ipcRenderer.invoke('region:save-preset', payload),
  regionDeletePreset: (id) => ipcRenderer.invoke('region:delete-preset', { id }),
  saveWatermarkSettings: (watermark) => ipcRenderer.invoke('settings:update', { screenshot: { watermark } }),
  saveAnnotationWidth: (annotationWidth) => ipcRenderer.invoke('settings:update', { screenshot: { annotationWidth } }),
  // A3: the palette colour rides the same settings:update pipe as the width, so
  // no new IPC channel (and no ipc-security.js entry) is needed.
  saveAnnotationColor: (annotationColor) => ipcRenderer.invoke('settings:update', { screenshot: { annotationColor } }),
  // B4: the whole per-tool style map is submitted at once (settings:update deep-merges,
  // so a partial write could otherwise leave one tool's block stale).
  saveAnnotationStyles: (annotationStyles) => ipcRenderer.invoke('settings:update', { screenshot: { annotationStyles } }),
  // Feature C (docs/plans/2026-10-25-snow-apps-feature-development-plan.md §6.2): ONLY the chosen
  // preset id is persisted. It is a UI preference - the produced pixels are decided by the
  // document's own `outputStyle` - so the manually adjusted padding/radius/shadow deliberately do
  // not follow the user across captures. Same `settings:update` pipe and same validation template
  // as the width/colour/style writes above, so no new channel and no ipc-security entry.
  saveOutputStylePreset: (outputStylePreset) => ipcRenderer.invoke('settings:update', { screenshot: { outputStylePreset } })
})
