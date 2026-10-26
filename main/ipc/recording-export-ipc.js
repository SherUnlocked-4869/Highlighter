// Recording export IPC (feature E2, plan §8.3:
// docs/plans/2026-10-25-snow-apps-feature-development-plan.md).
//
// Three invoke channels plus one main -> renderer progress push:
//
//   record:export         validate the sender/session, probe the sealed source, validate the
//                         range and the GIF budget, ask the main process for a save target,
//                         freeze it, register one immutable task and return its id.
//                         The renderer NEVER submits a source or target path.
//   record:export-status  re-read a task by taskId or by (sessionId, requestId) so a lost
//                         progress event cannot leave the preview stuck.
//   record:cancel-export  cancel a task; the source file and the trimmed range are kept.
//   record:export-progress (push)  { taskId, state, progress?, error?, receipt? }
//
// The controller lives in the record DOMAIN (main/domains/record/index.js), because "is this
// sender the recording window that owns this session" is window-ownership work the domain
// already does for every other record channel. This module is only the registration surface,
// which is what keeps main.js at assembly level and test/ipc-security.test.js able to derive
// the full channel inventory from source.
//
// `record:export-progress` is a push channel and therefore has no sender policy (exactly like
// `record:save-progress`): IPC_SURFACES lists what a renderer may SEND, not what it receives.

function registerRecordingExportIpc({ ipcMain, controller }) {
  if (!ipcMain || !controller) throw new Error('Recording export IPC requires ipcMain and controller')

  ipcMain.handle('record:export', controller.exportRecording)
  ipcMain.handle('record:export-status', controller.exportStatus)
  ipcMain.handle('record:cancel-export', controller.cancelExport)
}

module.exports = {
  registerRecordingExportIpc
}
