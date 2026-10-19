// History IPC (screenshot history batch actions).
//
// deps signature (stable; main.js wires this object):
//   ipcMain                       the secure ipcMain wrapper (or a plain fake in tests)
//   historyService                { list, getThumbnail, listSources, stats, getItem, delete,
//                                   deleteMany, exportMany, cleanup, clear,
//                                   selectExportItems? }
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

const fs = require('node:fs')

const pdfExportDefault = require('../services/pdf-export')
const { makeCaptureName } = require('../services/capture-naming')
const { t } = require('../services/i18n-bootstrap')

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

  ipcMain.handle('history:list', (_event, filter) => historyService.list(filter))
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
