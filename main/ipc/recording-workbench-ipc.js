// Recording workbench + editor IPC (R1-R3, docs/plans/2026-11-03-recording-r1-r3-contracts.md
// §8/§9.1/§9.3).
//
// This module is only the REGISTRATION surface; the controller lives in the record domain
// (main/domains/record/index.js) because every one of these channels is window-ownership work
// the domain already does ("is this sender the control window / the editor window that owns this
// project"). Keeping the two registrars here is what lets main.js stay at assembly level and
// test/ipc-security.test.js derive the full channel inventory from source.
//
// Two roles, deliberately separated:
//
//   main          the workbench + records page. May read the workbench state, start a capture
//                 and manage recording records. It may NOT append chunks or write a draft.
//   record-editor the standalone editor for ONE project. Owns draft CAS writes and export
//                 submission. It may NOT start a capture or append chunks.
//
// Push channels (`record:command`, `record:state-changed`, `record-editor:init`,
// `record:export-progress`) are main -> renderer and therefore have NO sender policy - exactly
// like `record:save-progress`. IPC_SURFACES lists what a renderer may SEND.

function registerRecordingWorkbenchIpc({ ipcMain, controller }) {
  if (!ipcMain || !controller) throw new Error('Recording workbench IPC requires ipcMain and controller')

  ipcMain.handle('record:workbench-state', controller.workbenchState)
  ipcMain.handle('record:workbench-start', controller.workbenchStart)
  ipcMain.handle('record:workbench-focus', controller.workbenchFocus)
  // R4 (docs/plans/2026-11-03-recording-r4-contracts.md §2.1): the recordable-window list. The
  // renderer only ever receives opaque single-use tokens, never a desktopCapturer source id.
  ipcMain.handle('record:workbench-windows', controller.workbenchWindows)
  ipcMain.handle('record:project-list', controller.projectList)
  ipcMain.handle('record:project-open', controller.projectOpen)
  ipcMain.handle('record:project-rename', controller.projectRename)
  ipcMain.handle('record:project-delete', controller.projectDelete)
  ipcMain.handle('record:project-reveal', controller.projectReveal)
}

function registerRecordingEditorIpc({ ipcMain, controller }) {
  if (!ipcMain || !controller) throw new Error('Recording editor IPC requires ipcMain and controller')

  ipcMain.on('record-editor:ready', controller.editorReady)
  ipcMain.on('record-editor:close', controller.editorClose)
  ipcMain.on('record-editor:window', controller.editorWindow)
  ipcMain.handle('record-editor:save-draft', controller.editorSaveDraft)
  ipcMain.handle('record-editor:export', controller.editorExport)
  ipcMain.handle('record-editor:export-status', controller.editorExportStatus)
  ipcMain.handle('record-editor:cancel-export', controller.editorCancelExport)
  ipcMain.handle('record-editor:rename', controller.editorRename)
  ipcMain.handle('record-editor:rerecord', controller.editorRerecord)
  ipcMain.handle('record-editor:reveal', controller.editorReveal)
  ipcMain.handle('record-editor:back', controller.editorBack)
  // Additive (approved 2026-11-03): re-probe the source and re-derive the file URL so the
  // recovery banner can retry and a revision-conflict can reload in place.
  ipcMain.handle('record-editor:reload', controller.editorReload)
}

module.exports = {
  registerRecordingWorkbenchIpc,
  registerRecordingEditorIpc
}
