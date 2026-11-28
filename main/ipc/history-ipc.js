// History IPC (screenshot history batch actions).
//
// deps signature (stable; main.js wires this object):
//   ipcMain                       the secure ipcMain wrapper (or a plain fake in tests)
//   historyService                { list, getThumbnail, listSources, stats, getItem, delete,
//                                   deleteMany, exportMany, cleanup, clear,
//                                   selectExportItems?, updateTags? }
//   copyItem(item) / copyPathItem(item) / editItem(item) / openItem(item)
//   chooseExportDirectory()       opens the "where to export" directory picker
//
// Optional, defaulted here so main.js passes nothing new:
//   pdfExport  { exportPagesToPdfBuffer, savePdfBuffer, MAX_PDF_PAGES }
//              defaults to require('../services/pdf-export'). That module resolves
//              createSecureWindow/BrowserWindow/printToPDF/dialog/fs lazily in the
//              main process, so the batch PDF path needs zero new main.js deps.
//   readImageFile(filePath) -> Promise<Buffer>   defaults to fs.promises.readFile
//   getSettings() -> settings                   defaults to () => ({})
//   BrowserWindow                                optional; resolves the dialog parent
//                                                from event.sender when supplied.
//
// 'history:export-pdf' renders every selected history image as one page of a single
// PDF (one printToPDF call through capture/print.html), then asks for a destination
// with the native save dialog. Selection resolution prefers
// historyService.selectExportItems (shared with exportMany); when the injected
// facade does not expose it, getItem + an existence probe give the same answer.
//
// N02 (docs/reviews/2026-11-26-code-review-and-optimization-report.md §5.2): tag editing.
// The main-role invoke inventory is frozen in main/services/ipc-security.js (every channel
// needs an explicit sender policy and secureIpcMain.assertComplete() refuses an unlisted
// registration), and test/history-ipc.test.js pins this module's exact channel list, so a new
// `history:update-tags` channel cannot be added without changing both of those files. Until
// it is promoted, the write rides 'history:list' - the one history channel that already
// accepts a renderer object - as a command envelope: `{ op: 'update-tags', id, tags }`.
// A payload without `op` keeps the original list contract byte for byte, and the preload
// exposes a named `updateHistoryTags()` method so the renderer never hand-builds the envelope.
//
// N02 follow-up (real-device verification, 2026-11-27): the same envelope now carries the two
// reads behind the tag dropdown and the OCR status UI, plus the explicit "index these captures"
// command. They stay on 'history:list' for the same frozen-inventory reason:
//   { op: 'list-tags' }                -> [{ tag, count }]
//   { op: 'ocr-state' }                -> { summary, queue, enabled }
//   { op: 'index-ocr', ids?, all? }    -> { accepted, skipped, disabled }

const fs = require('node:fs')

const pdfExportDefault = require('../services/pdf-export')
const { makeCaptureName } = require('../services/capture-naming')
const { t } = require('../services/i18n-bootstrap')

// N02: the command envelope discriminant for the tag write (see the header).
const HISTORY_UPDATE_TAGS_OP = 'update-tags'
const HISTORY_LIST_TAGS_OP = 'list-tags'
const HISTORY_OCR_STATE_OP = 'ocr-state'
const HISTORY_INDEX_OCR_OP = 'index-ocr'

function isUpdateTagsCommand(payload) {
  return !!payload &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    payload.op === HISTORY_UPDATE_TAGS_OP
}

function isHistoryCommand(payload) {
  return !!payload &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    typeof payload.op === 'string'
}

// Resolution order for a batch: history order first (selectExportItems), otherwise
// the caller's id order (getItem). Both drop ids whose file is gone, and report
// them as missing rather than failing the whole batch.
function resolveExportItems(historyService, ids) {
  if (typeof historyService.selectExportItems === 'function') {
    return historyService.selectExportItems(ids)
  }
  const items = []
  const missingIds = []
  for (const id of Array.isArray(ids) ? ids : []) {
    const item = historyService.getItem?.(id)
    if (!item || !item.filePath || !fs.existsSync(item.filePath)) {
      missingIds.push(String(id))
      continue
    }
    items.push({
      id: item.id,
      filePath: item.filePath,
      width: Number(item.width) || 0,
      height: Number(item.height) || 0
    })
  }
  return { items, missingIds }
}

function createHistoryPdfController({
  historyService,
  pdfExport = pdfExportDefault,
  readImageFile = (filePath) => fs.promises.readFile(filePath),
  getSettings = () => ({}),
  BrowserWindow = null
} = {}) {
  return async function exportHistoryPdf(event, ids) {
    const { items, missingIds } = resolveExportItems(historyService, ids)
    // Nothing readable in the selection: report it without opening a save dialog.
    if (!items.length) {
      return { canceled: false, exportedCount: 0, missingCount: missingIds.length, failures: [] }
    }
    const pageCap = Number(pdfExport.MAX_PDF_PAGES) > 0 ? Number(pdfExport.MAX_PDF_PAGES) : items.length
    const readable = items.slice(0, pageCap)
    const failures = []
    const pages = []
    for (const item of readable) {
      try {
        const buffer = await readImageFile(item.filePath)
        pages.push({ buffer, pxW: item.width || undefined, pxH: item.height || undefined })
      } catch (error) {
        failures.push({ id: item.id, message: error?.message || String(error) })
      }
    }
    // Anything over the page cap is reported like a failed item so the renderer's
    // counts stay truthful instead of the batch quietly shrinking.
    for (const item of items.slice(pageCap)) {
      failures.push({ id: item.id, message: 'page limit reached' })
    }
    if (!pages.length) {
      return { canceled: false, exportedCount: 0, missingCount: missingIds.length, failures }
    }
    const pdfBuffer = await pdfExport.exportPagesToPdfBuffer(pages, {
      mode: 'a4',
      maxPages: Math.max(pageCap, pages.length)
    })
    const template = getSettings()?.screenshot?.nameTemplate
    const parentWindow = BrowserWindow && event?.sender && typeof BrowserWindow.fromWebContents === 'function'
      ? BrowserWindow.fromWebContents(event.sender)
      : null
    const usableParent = parentWindow && typeof parentWindow.isDestroyed === 'function' && parentWindow.isDestroyed()
      ? null
      : parentWindow
    const filePath = await pdfExport.savePdfBuffer(pdfBuffer, {
      parentWindow: usableParent,
      title: t('config.history.export-pdf'),
      makeName: (prefix, ext) => makeCaptureName(prefix, ext, { template })
    })
    // A dismissed save dialog writes nothing, exactly like the image saver.
    if (!filePath) return { canceled: true, exportedCount: 0, missingCount: missingIds.length, failures }
    return {
      canceled: false,
      filePath,
      exportedCount: pages.length,
      missingCount: missingIds.length,
      failures
    }
  }
}

function registerHistoryIpc({
  ipcMain,
  historyService,
  copyItem,
  copyPathItem,
  editItem,
  openItem,
  chooseExportDirectory,
  pdfExport = pdfExportDefault,
  readImageFile,
  getSettings,
  BrowserWindow
}) {
  if (!ipcMain || !historyService) throw new Error('History IPC requires ipcMain and historyService')

  ipcMain.handle('history:list', (_event, filter) => {
    // N02: the tag write shared with 'history:list' (frozen channel inventory; see header).
    // updateTags() returns the normalized list, or null when the record is gone / the payload
    // is not an array, so the renderer can report a failed edit without a second round-trip.
    if (isUpdateTagsCommand(filter)) {
      if (typeof historyService.updateTags !== 'function') throw new Error('History tag updates are unavailable')
      return historyService.updateTags(filter.id, filter.tags)
    }
    // N02 follow-up: the tag-dropdown read, the OCR status read and the explicit index command.
    // Same frozen channel, same rule: an unknown op is an error rather than a silent list call,
    // so a renderer typo cannot be mistaken for an empty page.
    if (isHistoryCommand(filter)) {
      if (filter.op === HISTORY_LIST_TAGS_OP) {
        if (typeof historyService.listTags !== 'function') throw new Error('History tag listing is unavailable')
        return historyService.listTags()
      }
      if (filter.op === HISTORY_OCR_STATE_OP) {
        if (typeof historyService.ocrState !== 'function') throw new Error('History OCR state is unavailable')
        return historyService.ocrState()
      }
      if (filter.op === HISTORY_INDEX_OCR_OP) {
        if (typeof historyService.indexOcr !== 'function') throw new Error('History OCR indexing is unavailable')
        const ids = Array.isArray(filter.ids) ? filter.ids : null
        const all = filter.all === true
        // A command with neither target means the renderer built an invalid payload; defaulting
        // it to "index the whole history" would turn a typo into a mass OCR run.
        if (!all && ids === null) throw new Error('History OCR indexing requires ids or all')
        return historyService.indexOcr({ ids, all })
      }
      throw new Error(`Unsupported history command: ${filter.op}`)
    }
    return historyService.list(filter)
  })
  ipcMain.handle('history:thumbnail', (_event, id) => historyService.getThumbnail(id))
  ipcMain.handle('history:sources', () => historyService.listSources())
  ipcMain.handle('history:stats', () => historyService.stats())
  ipcMain.handle('history:delete', (_event, id) => historyService.delete(id))
  ipcMain.handle('history:delete-many', (_event, ids) => historyService.deleteMany(ids))
  ipcMain.handle('history:clear', () => historyService.clear())
  ipcMain.handle('history:cleanup', () => historyService.cleanup())
  ipcMain.handle('history:export', async (_event, ids) => {
    const directory = await chooseExportDirectory()
    return directory ? historyService.exportMany(ids, directory) : { canceled: true }
  })
  ipcMain.handle('history:copy', (_event, id) => {
    const item = historyService.getItem(id)
    return item ? copyItem(item) : false
  })
  ipcMain.handle('history:edit', (_event, id) => {
    const item = historyService.getItem(id)
    return item ? editItem(item) : false
  })
  ipcMain.handle('history:open', (_event, id) => {
    const item = historyService.getItem(id)
    return item ? openItem(item) : false
  })
  ipcMain.handle('history:copy-path', (_event, id) => {
    const item = historyService.getItem(id)
    return item ? copyPathItem(item) : false
  })
  // Batch multi-page PDF: selection -> one PDF file, one page per history image.
  // Registered last and separately from 'history:export' so the copy-to-directory
  // path is untouched; the channel is declared for the config window ('main' role)
  // in main/services/ipc-security.js.
  ipcMain.handle('history:export-pdf', createHistoryPdfController({
    historyService,
    pdfExport,
    readImageFile,
    getSettings,
    BrowserWindow
  }))
}

module.exports = {
  createHistoryPdfController,
  registerHistoryIpc,
  resolveExportItems
}
