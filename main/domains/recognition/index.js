'use strict'

const { windowBackdropColor, trackWindowBackdrop } = require('../../services/window-backdrop')
const { buildXlsxBuffer } = require('../../services/table-workbook')
const { exportWindowToPdf, savePdfBuffer } = require('../../services/pdf-export')
const { CAPTURE_PREFIX, makeCaptureName } = require('../../services/capture-naming')
const { resolveSaveDirectory } = require('../../services/image-file-save')
const { t } = require('../../services/i18n-bootstrap')

// Electron handles are resolved lazily so this module still loads (and its
// controller can be unit-tested) outside the Electron main process. main.js does
// not have to inject anything: pdf-export defaults printToPdf to
// webContents.printToPDF and resolves the save dialog itself, and the Excel
// dialog below falls back to electron's dialog the same way.
function resolveDialog(deps) {
  if (deps.dialog && typeof deps.dialog.showSaveDialog === 'function') return deps.dialog
  try {
    const electron = require('electron')
    return electron && typeof electron.dialog?.showSaveDialog === 'function' ? electron.dialog : null
  } catch {
    return null
  }
}

function resolveFileSystem(deps) {
  if (deps.fs && typeof deps.fs.promises?.writeFile === 'function') return deps.fs
  return require('node:fs')
}

function createRecognitionDomain(deps) {
  const {
    path,
    rootDirectory,
    BrowserWindow,
    clipboard,
    createLocalWindow,
    getSettings,
    dataUrlToBuffer,
    recognizeWithPerformance,
    buildTableFromOcr,
    // Feature A (plan §4.2/A2): optional resolver for the export-result registry. Injected as a
    // function because the service is created inside initializeStore(), after this domain is
    // constructed. Absent -> the legacy "path or null" return is preserved unchanged.
    getExportResultService = () => null
  } = deps

  const recognitionWindows = new Set()

  function exportResultService() {
    try {
      return typeof getExportResultService === 'function' ? getExportResultService() : null
    } catch {
      return null
    }
  }

  // Registers a file this domain just wrote and returns the plan §4.2 receipt for the renderer.
  // A null path (cancelled dialog) stays null: a cancel must never look like a successful export.
  // When the service is not wired, the raw path is returned so nothing regresses.
  function registerExportResult(event, filePath, kind, source) {
    if (!filePath) return null
    const service = exportResultService()
    if (!service) return filePath
    const sender = event?.sender
    const ownerId = sender && Number.isInteger(Number(sender.id)) ? `web-contents:${Number(sender.id)}` : null
    return service.register({ filePath, kind, source, ownerId }) || filePath
  }

  function ownsWindow(win) {
    return recognitionWindows.has(win)
  }

  // Shared sender check for every result-window channel: the window must be one
  // this domain created. The IPC layer already restricts the page; this also
  // catches a destroyed/stale window and keeps the handlers uniform.
  function requireOwnedWindow(event) {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || !recognitionWindows.has(win)) throw new Error(t('recognition.error.invalid-window'))
    return win
  }

  function settingsSnapshot() {
    try {
      return (typeof getSettings === 'function' && getSettings()) || {}
    } catch {
      return {}
    }
  }

  // Recognition exports land where screenshots go (remembered directory first),
  // so "Export Excel/PDF" does not reopen in an unrelated folder.
  function defaultExportDirectory() {
    try {
      return resolveSaveDirectory(settingsSnapshot())
    } catch {
      return ''
    }
  }

  // Same naming source as the screenshot/PDF paths, so a template configured for
  // captures also labels a recognition export (`Highlighter_....xlsx`).
  function exportName(extension) {
    const template = settingsSnapshot()?.screenshot?.nameTemplate
    return makeCaptureName(CAPTURE_PREFIX, extension, { template })
  }

  async function pickSavePath(win, { title, defaultName, filters }) {
    const dialog = resolveDialog(deps)
    if (!dialog) throw new Error(t('recognition.error.save-unavailable'))
    const directory = defaultExportDirectory()
    const options = {
      title,
      defaultPath: directory ? path.join(directory, defaultName) : defaultName,
      filters
    }
    // The result window is the dialog's parent so the sheet is modal to it; a
    // destroyed window would make showSaveDialog(parent, …) throw.
    const usableParent = win && !(typeof win.isDestroyed === 'function' && win.isDestroyed())
    const result = usableParent
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options)
    if (!result || result.canceled || !result.filePath) return null
    return result.filePath
  }

  function createRecognitionWindow(type, dataUrl, options = {}) {
    if (!['table', 'qr'].includes(type)) throw new Error('不支持的识别类型')
    if (!dataUrl) throw new Error('识别图片数据为空')
    const isTable = type === 'table'
    const settings = getSettings()
    const pagePath = path.join(rootDirectory, 'recognition', 'recognition.html')
    const win = createLocalWindow(pagePath, {
      width: isTable ? 820 : 640,
      height: isTable ? 620 : 420,
      minWidth: isTable ? 600 : 480,
      minHeight: isTable ? 440 : 320,
      frame: false,
      show: false,
      // Painted before the first frame: the shared --bg token, so the window does
      // not flash white and the rounded top bar cannot show a stale colour.
      backgroundColor: windowBackdropColor(settings),
      title: isTable ? 'Highlighter 表格识别' : 'Highlighter 二维码识别',
      webPreferences: {
        preload: path.join(rootDirectory, 'preload-recognition.js')
      }
    })
    trackWindowBackdrop(win)
    recognitionWindows.add(win)
    win._recognitionInit = {
      type,
      dataUrl,
      scaleFactor: Number(options.scaleFactor) || 1,
      mainColor: settings.mainColor || '#e5a44c',
      // The renderer toggles body.dark on this; without it an explicit light/dark
      // setting was ignored and the result page followed the OS instead.
      theme: settings.theme
    }
    win.loadFile(pagePath)
    win.on('closed', () => recognitionWindows.delete(win))
    return win
  }

  function createRecognitionController() {
    return {
      recognitionReady: (event) => {
        const win = BrowserWindow.fromWebContents(event.sender)
        if (!win || !recognitionWindows.has(win) || !win._recognitionInit) return
        event.sender.send('recognition:init', win._recognitionInit)
        win.show()
        win.focus()
      },
      recognitionTable: async (event, payload) => {
        const win = BrowserWindow.fromWebContents(event.sender)
        if (!win || !recognitionWindows.has(win)) throw new Error('无效的表格识别窗口')
        if (!getSettings().plugins.ocr) throw new Error('请先在插件页面启用文本识别')
        const dataUrl = payload?.dataUrl
        if (!dataUrl) throw new Error('表格图片数据为空')
        const settings = getSettings()
        const ocrResult = await recognizeWithPerformance(dataUrlToBuffer(dataUrl), {
          scaleFactor: payload?.scaleFactor,
          detectAngle: settings.ocr.detectAngle,
          minConfidence: settings.ocr.minConfidence
        }, 'table')
        const table = buildTableFromOcr(ocrResult, { minConfidence: settings.ocr.minConfidence })
        if (!table) throw new Error('未识别到稳定的表格结构，请扩大选区并确保至少包含两行两列')
        return table
      },
      recognitionCopy: (event, value) => {
        requireOwnedWindow(event)
        clipboard.writeText(String(value || ''))
        return true
      },
      // Table recognition → real .xlsx (analysis plan §6.2①). The renderer sends
      // back the rows it is displaying, so the exported workbook is exactly the
      // table on screen; the table model comes from buildTableFromOcr
      // ({ rows, rowCount, columnCount }), and `merges` stays optional.
      recognitionExportExcel: async (event, payload = {}) => {
        const win = requireOwnedWindow(event)
        const rows = payload?.rows
        if (!Array.isArray(rows) || !rows.length) throw new Error(t('recognition.error.empty-table'))
        const buffer = buildXlsxBuffer(rows, {
          merges: Array.isArray(payload?.merges) ? payload.merges : undefined,
          sheetName: typeof payload?.sheetName === 'string' ? payload.sheetName : undefined
        })
        const filePath = await pickSavePath(win, {
          title: t('recognition.dialog.export-excel-title'),
          defaultName: exportName('xlsx'),
          filters: [{ name: t('recognition.dialog.excel-filter'), extensions: ['xlsx'] }]
        })
        if (!filePath) return null
        await resolveFileSystem(deps).promises.writeFile(filePath, buffer)
        // Feature A (plan §4.1/§4.2, task A2): hand the written file to the result registry so the
        // result window can show the open / address / open-folder bar. Only `resultId` travels back
        // to the renderer; the path stays here. A cancelled dialog returns early above and
        // registers nothing, so a cancel never produces a bar.
        return registerExportResult(event, filePath, 'xlsx', 'recognition-excel')
      },
      // Result window → PDF (analysis plan §0.3 #4 / §12.1). printToPDF on the
      // already-rendered window, then the shared save-dialog/write helper; the
      // recognition.css print rules hide the action bar so the PDF is content only.
      // Both helpers default to the real Electron dialog/fs, so production needs
      // no extra wiring; `deps.dialog`/`deps.fs`/`deps.printToPdf` are test seams.
      recognitionExportPdf: async (event, payload = {}) => {
        const win = requireOwnedWindow(event)
        const contentSize = typeof win.getContentSize === 'function' ? win.getContentSize() : null
        const pxW = Number(payload?.pxW) || (Array.isArray(contentSize) ? contentSize[0] : 0)
        const pxH = Number(payload?.pxH) || (Array.isArray(contentSize) ? contentSize[1] : 0)
        const pdfBuffer = await exportWindowToPdf(win, {
          pxW,
          pxH,
          ...(typeof deps.printToPdf === 'function' ? { printToPdf: deps.printToPdf } : {})
        })
        if (typeof deps.savePdfBuffer === 'function') {
          const injectedPath = await deps.savePdfBuffer(pdfBuffer, {
            parentWindow: win,
            directory: defaultExportDirectory(),
            title: t('recognition.dialog.export-pdf-title')
          })
          return registerExportResult(event, injectedPath, 'pdf', 'recognition-pdf')
        }
        const dialog = resolveDialog(deps)
        const filePath = await savePdfBuffer(pdfBuffer, {
          parentWindow: win,
          ...(dialog ? { dialog } : {}),
          fs: resolveFileSystem(deps),
          directory: defaultExportDirectory(),
          // §17.5/§12.1: the PDF default name follows the same template source as
          // screenshot saving (empty template = the legacy timestamp format).
          makeName: (prefix, ext) => exportName(ext),
          title: t('recognition.dialog.export-pdf-title')
        })
        return registerExportResult(event, filePath, 'pdf', 'recognition-pdf')
      },
      recognitionClose: (event) => {
        const win = BrowserWindow.fromWebContents(event.sender)
        if (win && recognitionWindows.has(win) && !win.isDestroyed()) win.close()
      }
    }
  }

  return {
    ownsWindow,
    createRecognitionWindow,
    createRecognitionController
  }
}

module.exports = {
  createRecognitionDomain
}
