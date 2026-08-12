function registerRecordingIpc({ ipcMain, controller }) {
  if (!ipcMain || !controller) throw new Error('Recording IPC requires ipcMain and controller')

  ipcMain.on('record:ready', controller.ready)
  ipcMain.on('record-frame:ready', controller.frameReady)
  ipcMain.on('record-frame:snapshot', controller.frameSnapshot)
  ipcMain.on('record:performance', controller.performance)
  ipcMain.handle('record:set-annotation-command', controller.setAnnotationCommand)
  ipcMain.handle('record:start-session', controller.startSession)
  ipcMain.handle('record:append-chunk', controller.appendChunk)
  ipcMain.handle('record:finish-session', controller.finishSession)
  ipcMain.handle('record:save-mp4', controller.saveMp4)
  ipcMain.handle('record:cancel-session', controller.cancelSession)
  ipcMain.handle('record:set-frame-state', controller.setFrameState)
  ipcMain.handle('record:resize-preview', controller.resizePreview)
  ipcMain.handle('record:restart', controller.restart)
  ipcMain.on('record:close', controller.close)
}

module.exports = {
  registerRecordingIpc
}
