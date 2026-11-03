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
  // Feature E (plan §8.3): probe the sealed source, trim + export, query and cancel a task,
  // and close the preview (which is what releases the source session).
  ipcMain.handle('record:probe-session', controller.probeSession)
  ipcMain.handle('record:close-preview', controller.closePreview)
  ipcMain.on('record:close', controller.close)
  // R2 (contracts §9.2): the live-control-bar state channel. `record:get-state` is the pull
  // fallback for a lost push, `record:state` is the renderer's authoritative state report and
  // `record:command-result` closes the loop for a tray/shortcut command.
  ipcMain.handle('record:get-state', controller.getState)
  ipcMain.on('record:state', controller.state)
  ipcMain.on('record:command-result', controller.commandResult)
}

module.exports = {
  registerRecordingIpc
}
