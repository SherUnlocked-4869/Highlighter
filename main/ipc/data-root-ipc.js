'use strict'

// N06 (docs/reviews/2026-11-26-code-review-and-optimization-report.md section 5.6):
// the two single-file backup-archive channels live on the data-root surface.
//
// The archive itself is built/validated by ../services/encrypted-backup.js; this
// module only owns the two dialogs and the hand-off to the EXISTING data-root
// restore path (controller.backupRestore). Consequences:
//   * the renderer never supplies a path: the save/open dialog runs in main, so
//     the archive file is always the one the user picked in the native dialog;
//   * the export builds its package through controller.backupCreate, i.e. the
//     same writer-quiesce + manifest path the directory backup uses;
//   * the import extracts to a temp directory and then hands it to
//     controller.backupInspect/backupRestore, so the D04 checks and the
//     locator/relaunch flow are reused instead of bypassed.
//
// Registration rule (same pattern as main/services/usage-feature.js): only the
// secure IPC facade (a host that exposes assertComplete()) gets the archive
// channels. Plain ipcMain test doubles keep exactly the legacy data-root
// surface, which is pinned by test/ipc-module-contracts.test.js; the secure
// facade is the only writer that can also enforce the sender policy in
// main/services/ipc-security.js.

const path = require('node:path')
const dataRootBackup = require('../services/data-root-backup')

const ARCHIVE_CHANNELS = Object.freeze([
  'data-root:backup-export-archive',
  'data-root:backup-import-archive'
])

function loadElectron () {
  // Lazy on purpose: this module is loaded by node:test, where no Electron app
  // exists. The archive channels are only registered on the secure facade, and
  // that only exists inside the Electron main process.
  return require('electron')
}

// Only strings that name a known module are forwarded; the service re-validates.
function normalizeModules (value) {
  if (!Array.isArray(value)) return [...dataRootBackup.DEFAULT_MODULES]
  const modules = []
  for (const entry of value.slice(0, dataRootBackup.MODULE_ORDER.length)) {
    const id = typeof entry === 'string' ? entry : entry && typeof entry.id === 'string' ? entry.id : ''
    if (dataRootBackup.MODULE_DEFINITIONS[id] && !modules.includes(id)) modules.push(id)
  }
  return modules.length ? modules : [...dataRootBackup.DEFAULT_MODULES]
}

function normalizePassword (value) {
  return typeof value === 'string' ? value : ''
}

function canceled () {
  return { ok: false, code: 'canceled', canceled: true }
}

function resolveParent (electron, event) {
  const fromWebContents = electron?.BrowserWindow?.fromWebContents
  const sender = event && event.sender
  if (typeof fromWebContents !== 'function' || !sender) return null
  try {
    return fromWebContents(sender) || null
  } catch {
    return null
  }
}

async function showSaveDialog (electron, parent, options) {
  if (parent) return electron.dialog.showSaveDialog(parent, options)
  return electron.dialog.showSaveDialog(options)
}

async function showOpenDialog (electron, parent, options) {
  if (parent) return electron.dialog.showOpenDialog(parent, options)
  return electron.dialog.showOpenDialog(options)
}

function archiveTempRoot (electron) {
  const getPath = electron?.app?.getPath
  const base = typeof getPath === 'function' ? getPath.call(electron.app, 'temp') : ''
  return path.join(typeof base === 'string' && base ? base : path.sep, 'Highlighter', 'backup-archive')
}

function archiveVersion (electron) {
  const getVersion = electron?.app?.getVersion
  if (typeof getVersion !== 'function') return ''
  try {
    return String(getVersion.call(electron.app) || '')
  } catch {
    return ''
  }
}

async function exportArchive ({ event, options, controller, archive, electron }) {
  const request = options && typeof options === 'object' ? options : {}
  let password = normalizePassword(request.password)
  try {
    const electronApi = electron || loadElectron()
    const parent = resolveParent(electronApi, event)
    const version = archiveVersion(electronApi)
    const now = Date.now()
    const defaultName = typeof archive.archiveFileName === 'function'
      ? archive.archiveFileName(version, now)
      : `highlighter-backup-${version || '0'}${archive.ARCHIVE_EXTENSION || '.hlbackup.zip'}`
    const save = await showSaveDialog(electronApi, parent, {
      defaultPath: path.join(safeDocumentsPath(electronApi), defaultName),
      // ASCII-only main-process dialog copy: the settings window carries the
      // localized strings (the main process has no i18n table of its own here).
      filters: [
        { name: 'Highlighter backup archive', extensions: ['hlbackup.zip', 'zip'] }
      ]
    })
    if (!save || save.canceled || typeof save.filePath !== 'string' || !save.filePath) return canceled()
    const result = await archive.exportArchive({
      dataRoot: controller.get().path,
      modules: normalizeModules(request.modules),
      version,
      password,
      outputPath: save.filePath,
      tmpRoot: archiveTempRoot(electronApi),
      createBackup: (backupOptions) => controller.backupCreate(backupOptions)
    })
    return result
  } catch (error) {
    return { ok: false, code: 'archive-failed', message: error && error.message ? error.message : String(error) }
  } finally {
    // Best-effort scrub of the local copy; the renderer clears its input on reply.
    password = ''
  }
}

function safeDocumentsPath (electron) {
  const getPath = electron?.app?.getPath
  if (typeof getPath !== 'function') return ''
  try {
    return String(getPath.call(electron.app, 'documents') || '')
  } catch {
    return ''
  }
}

async function importArchive ({ event, options, controller, archive, electron }) {
  const request = options && typeof options === 'object' ? options : {}
  let password = normalizePassword(request.password)
  let inspected = null
  try {
    const electronApi = electron || loadElectron()
    const parent = resolveParent(electronApi, event)
    const open = await showOpenDialog(electronApi, parent, {
      properties: ['openFile'],
      filters: [
        { name: 'Highlighter backup archive', extensions: ['hlbackup.zip', 'zip'] }
      ]
    })
    if (!open || open.canceled || !Array.isArray(open.filePaths) || !open.filePaths[0]) return canceled()
    inspected = await archive.inspectArchive({
      archivePath: open.filePaths[0],
      password,
      tmpRoot: archiveTempRoot(electronApi),
      inspectBackup: (directory) => controller.backupInspect(directory)
    })
    if (!inspected || inspected.ok !== true) return inspected || { ok: false, code: 'archive-failed', message: 'the backup archive could not be read' }
    // Restoring always targets a NEW root, exactly like the directory restore
    // UI: the main process asks for it, the renderer never names a path.
    const target = await showOpenDialog(electronApi, parent, {
      properties: ['openDirectory', 'createDirectory']
    })
    if (!target || target.canceled || !Array.isArray(target.filePaths) || !target.filePaths[0]) return canceled()
    const restored = await controller.backupRestore({
      backupDirectory: inspected.directory,
      targetRoot: target.filePaths[0]
    })
    return {
      ...(restored && typeof restored === 'object' ? restored : { ok: false, code: 'restore-failed' }),
      archive: {
        encrypted: inspected.encrypted === true,
        formatVersion: inspected.formatVersion,
        createdAt: inspected.createdAt,
        appVersion: inspected.appVersion
      },
      inspection: inspected.inspection
    }
  } catch (error) {
    return { ok: false, code: 'archive-failed', message: error && error.message ? error.message : String(error) }
  } finally {
    password = ''
    // The extracted package is a temp copy of the user's backup; the restore
    // path has already copied everything it needs before returning.
    if (inspected && typeof inspected.cleanup === 'function') await inspected.cleanup()
  }
}

function hasSecureFacade (ipcMain) {
  // main.js hands registerAllIpc() the facade from createSecureIpcMain(); a plain
  // ipcMain test double has no completeness contract. Same discriminator as the
  // usage report exchange channels (main/services/usage-feature.js).
  return typeof ipcMain?.assertComplete === 'function' && typeof ipcMain.handle === 'function'
}

function registerDataRootIpc ({ ipcMain, controller, archive = null, electron = null } = {}) {
  if (!ipcMain || !controller) throw new Error('Data root IPC requires ipcMain and controller')

  ipcMain.handle('data-root:get', () => controller.get())
  ipcMain.handle('data-root:open', () => controller.open())
  ipcMain.handle('data-root:change', () => controller.change())
  // D04: local backups are created/restored inside the data-root domain (it owns the writer
  // quiesce gate and the locator switch), so the IPC layer only forwards the request.
  ipcMain.handle('data-root:backup-create', (_event, options) => controller.backupCreate(options))
  ipcMain.handle('data-root:backup-inspect', (_event, directory) => controller.backupInspect(directory))
  ipcMain.handle('data-root:backup-restore', (_event, options) => controller.backupRestore(options))
  ipcMain.handle('data-root:backup-delete', (_event, directory) => controller.backupDelete(directory))

  if (!hasSecureFacade(ipcMain)) return

  const archiveService = archive || require('../services/encrypted-backup')
  ipcMain.handle('data-root:backup-export-archive', (event, options) => (
    exportArchive({ event, options, controller, archive: archiveService, electron })
  ))
  ipcMain.handle('data-root:backup-import-archive', (event, options) => (
    importArchive({ event, options, controller, archive: archiveService, electron })
  ))
}

module.exports = {
  ARCHIVE_CHANNELS,
  registerDataRootIpc
}
