function registerCaptureIpc({ ipcMain, controller }) {
  if (!ipcMain || !controller) throw new Error('Capture IPC requires ipcMain and controller')

  ipcMain.on('capture:ready', controller.ready)
  ipcMain.on('capture:render-ready', controller.renderReady)
  ipcMain.on('capture:render-error', controller.renderError)
  ipcMain.on('capture:close', controller.close)
  ipcMain.handle('capture:start-region-recording', controller.startRegionRecording)
  ipcMain.handle('capture:start-long', controller.startLong)
  ipcMain.handle('capture:smart-select', controller.smartSelect)
  ipcMain.handle('capture:copy', controller.copy)
  ipcMain.on('capture:save', controller.save)
  ipcMain.handle('capture:pin', controller.pin)
  ipcMain.handle('capture:pin-reannotate', controller.pinReannotate)
  ipcMain.handle('capture:open-recognition', controller.openRecognition)
  ipcMain.handle('capture:record-history', controller.recordHistory)

  ipcMain.on('long-capture:ready', controller.longReady)
  ipcMain.on('long-overlay:ready', controller.longOverlayReady)
  ipcMain.on('long-capture:overlay-active', controller.longOverlayActive)
  ipcMain.handle('long-capture:add-strip', controller.longAddStrip)
  ipcMain.handle('long-capture:set-trim', controller.longSetTrim)
  ipcMain.handle('long-capture:set-selection-editing', controller.longSetSelectionEditing)
  ipcMain.on('long-overlay:bounds-changed', controller.longOverlayBoundsChanged)
  ipcMain.handle('long-capture:finish', controller.longFinish)
  ipcMain.on('long-capture:close', controller.longClose)

  ipcMain.handle('ocr:status', controller.ocrStatus)
  ipcMain.handle('capture:ocr', controller.ocr)
  ipcMain.handle('capture:translate', controller.translate)
  ipcMain.on('recognition:ready', controller.recognitionReady)
  ipcMain.handle('recognition:table', controller.recognitionTable)
  ipcMain.handle('recognition:copy', controller.recognitionCopy)
  ipcMain.on('recognition:close', controller.recognitionClose)
}

module.exports = {
  registerCaptureIpc
}
