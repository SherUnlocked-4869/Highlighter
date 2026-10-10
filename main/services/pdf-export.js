'use strict'

// P0-4 打印 / 导出 PDF（主进程侧）
//
// 三个入口 + 一个落盘助手：
//   computePaperOptions({ pxW, pxH, dpi, mode })  纯函数纸张换算（含 200 英寸夹取，R8）
//   exportPdfBuffer(imageBuffer, options)         离屏 capture/print.html → PDF Buffer
//   exportWindowToPdf(win, options)               已渲染窗口（贴图 / 识别结果）直接导 PDF
//   savePdfBuffer(pdfBuffer, options)             保存对话框 + 落盘
//
// 所有 Electron 依赖都可注入（printToPdf / createPrintWindow / showSaveDialog / writeFile），
// 因此本模块在纯 node 下可加载、可单测；主进程侧不注入时自动回落到 Electron 默认实现。
//
// ⚠️ 纸张单位实测结论（2026-10-10，本机 Electron 43.2.0 / Skia PDF m150）：
//   printToPDF 的 `pageSize: { width, height }` 单位是**英寸**，不是方案 §4.2 写的微米。
//   同样这两个值 { width: 158750, height: 105833 } 传微米口径 → Chromium 直接
//   "Failed to generate PDF: Printing failed"；传 { width: 6.25, height: 4.166667 } 英寸
//   → MediaBox 450 × 300.96 pt（= 6.25in × 4.18in），与主进程期望一致。
//   证据：`.tmp/pdf-export-probe/units-result.json`（S4 探针，非交付物）。
//   因此本模块内部仍按方案口径做“英寸 × 25400 = 微米”的换算与 200 英寸夹取
//   （pageSizeMicrons / requestedPageSizeMicrons / clamped 全部保留且被单测覆盖），
//   只在交给 Chromium 的边界上换算成英寸（pageSize）。

const fs = require('fs')
const path = require('path')
const { createSecureWindow } = require('./window-security')
const { readPngSize } = require('./capture-geometry')
const { CAPTURE_PREFIX, makeCaptureName } = require('./capture-naming')

const ROOT_DIRECTORY = path.resolve(__dirname, '..', '..')

// 1 英寸 = 25400 微米（方案 §4.2 的换算基准）。
const MICRONS_PER_INCH = 25400
// CSS 打印布局的换算基准（96 CSS px = 1 英寸）。
const CSS_PX_PER_INCH = 96
// 自定义纸张的英寸上限（R8：长截图可达 20000px = 208.3 英寸）。
// 实测 Electron 43 在 300 英寸仍可出纸、1000 英寸失败；200 英寸是方案冻结值，
// 也是 Chromium 打印预览的自定义纸张上限，保守夹取不会裁掉内容。
const MAX_PAGE_INCHES = 200
const MAX_PAGE_MICRONS = MAX_PAGE_INCHES * MICRONS_PER_INCH
// 实测下限：0.1 / 0.25 / 0.5 英寸都会 "content area is empty" 直接失败，1 英寸可用。
const MIN_PAGE_INCHES = 1
const MIN_PAGE_MICRONS = MIN_PAGE_INCHES * MICRONS_PER_INCH
const A4_WIDTH_MICRONS = 210 * 1000
const A4_HEIGHT_MICRONS = 297 * 1000
const DEFAULT_IMAGE_DPI = 96
// printToPDF 的 scale 值域是 [0.1, 2]；本模块只用 ≤1 的缩小比例，不上采样。
const MIN_PRINT_SCALE = 0.1
const DEFAULT_EXPORT_TIMEOUT_MS = 30000
const PRINT_IMAGE_ID = 'print-image'
// Electron printToPDF 自定义纸张的单位（实测，见文件头）。
const PAGE_SIZE_UNIT = 'inches'
// 纸张换算以“整页可打印区”为口径，边距必须与之一致（否则 scale 会算大而被裁切）。
const NO_MARGINS = Object.freeze({ marginType: 'none', top: 0, bottom: 0, left: 0, right: 0 })
const PAGE_MODES = Object.freeze(['a4', 'original'])

// 离屏打印窗口登记表：closed 钩子从这里摘除，导出结束也必定销毁（§4.3 泄漏风险）。
const activePrintWindows = new Set()

function finitePositive(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function toPixelSize(value) {
  return Math.max(1, Math.round(finitePositive(value, 1)))
}

function normalizeMode(mode) {
  return mode === 'original' ? 'original' : 'a4'
}

function clampMicrons(microns) {
  return Math.min(MAX_PAGE_MICRONS, Math.max(MIN_PAGE_MICRONS, Math.round(microns)))
}

function micronsToCssPx(microns) {
  return microns / MICRONS_PER_INCH * CSS_PX_PER_INCH
}

// 微米 → 英寸（交给 Chromium 的单位）；保留 6 位小数 = 0.0007mm 精度。
function micronsToInches(microns) {
  return Number((microns / MICRONS_PER_INCH).toFixed(6))
}

// 向下取整到 4 位小数：宁可略小于可打印区，也不让 Chromium 判定超页而多印一页。
function clampScale(scale) {
  const bounded = Math.min(1, finitePositive(scale, 1))
  return Math.max(MIN_PRINT_SCALE, Math.floor(bounded * 10000) / 10000)
}

/**
 * 纸张换算（纯函数）。
 *
 * @param {{ pxW?: number, pxH?: number, dpi?: number, mode?: 'a4'|'original' }} input
 *   pxW/pxH 图片像素尺寸；dpi 图片每英寸像素数（截图链路的物理像素 DPI = 96 × scaleFactor）；
 *   mode 'a4' 铺满 A4（默认），'original' 按原图物理尺寸出纸。
 * @returns 可直接作为 webContents.printToPDF(options) 的参数。pageSize 的单位是英寸
 *   （见文件头的实测结论）；另附 pageSizeMicrons / requestedPageSizeMicrons / clamped / mode
 *   诊断键，微米域换算与 200 英寸夹取都在这里完成。
 */
function computePaperOptions({ pxW, pxH, dpi = DEFAULT_IMAGE_DPI, mode = 'a4' } = {}) {
  const width = toPixelSize(pxW)
  const height = toPixelSize(pxH)
  const imageDpi = finitePositive(dpi, DEFAULT_IMAGE_DPI)
  const resolvedMode = normalizeMode(mode)
  const intrinsicWidth = width / imageDpi * CSS_PX_PER_INCH
  const intrinsicHeight = height / imageDpi * CSS_PX_PER_INCH

  if (resolvedMode === 'original') {
    const requestedWidthMicrons = Math.round(width / imageDpi * MICRONS_PER_INCH)
    const requestedHeightMicrons = Math.round(height / imageDpi * MICRONS_PER_INCH)
    const pageWidthMicrons = clampMicrons(requestedWidthMicrons)
    const pageHeightMicrons = clampMicrons(requestedHeightMicrons)
    // 自定义 Size 已经编码了横竖方向，再传 landscape 会让 Chromium 二次旋转。
    return {
      mode: resolvedMode,
      pageSize: {
        width: micronsToInches(pageWidthMicrons),
        height: micronsToInches(pageHeightMicrons)
      },
      landscape: false,
      printBackground: true,
      scale: clampScale(Math.min(
        1,
        micronsToCssPx(pageWidthMicrons) / intrinsicWidth,
        micronsToCssPx(pageHeightMicrons) / intrinsicHeight
      )),
      margins: { ...NO_MARGINS },
      preferCSSPageSize: false,
      clamped: pageWidthMicrons !== requestedWidthMicrons || pageHeightMicrons !== requestedHeightMicrons,
      // Same reason as the A4 branch: layout must match the DPI-corrected size.
      intrinsicCssPx: { width: Math.round(intrinsicWidth), height: Math.round(intrinsicHeight) },
      pageSizeMicrons: { width: pageWidthMicrons, height: pageHeightMicrons },
      requestedPageSizeMicrons: { width: requestedWidthMicrons, height: requestedHeightMicrons }
    }
  }

  const landscape = width > height
  const pageWidthMicrons = landscape ? A4_HEIGHT_MICRONS : A4_WIDTH_MICRONS
  const pageHeightMicrons = landscape ? A4_WIDTH_MICRONS : A4_HEIGHT_MICRONS
  return {
    mode: resolvedMode,
    pageSize: 'A4',
    landscape,
    printBackground: true,
    scale: clampScale(Math.min(
      1,
      micronsToCssPx(pageWidthMicrons) / intrinsicWidth,
      micronsToCssPx(pageHeightMicrons) / intrinsicHeight
    )),
    margins: { ...NO_MARGINS },
    preferCSSPageSize: false,
    clamped: false,
    // The image must be laid out at the DPI-corrected CSS size the scale above is
    // derived from. Laying it out at its natural pixels instead made a 125%/150%
    // screenshot 1/scaleFactor larger than the page and split it over two pages.
    intrinsicCssPx: { width: Math.round(intrinsicWidth), height: Math.round(intrinsicHeight) },
    pageSizeMicrons: { width: pageWidthMicrons, height: pageHeightMicrons },
    requestedPageSizeMicrons: { width: pageWidthMicrons, height: pageHeightMicrons }
  }
}

/** 把图片基名换成 .pdf（导出命名只依赖 capture-naming 的同一套时间戳）。 */
function buildPdfFileName(baseName, fallbackStem = `${CAPTURE_PREFIX}_export`) {
  const stem = String(baseName || '').trim().replace(/\.(png|jpe?g|webp|bmp|gif|pdf)$/i, '')
  return `${stem || fallbackStem}.pdf`
}

/**
 * 与 P0-4-T6 的接口约定：capture-naming.makeCaptureName(prefix, ext) 落地后
 * 这里自动拿到 .pdf 扩展名；落地前 makeCaptureName 忽略第二个参数并返回 .png，
 * buildPdfFileName 再把它归一成 .pdf —— 两种状态产物同名。
 */
function createDefaultPdfName(makeName = makeCaptureName) {
  if (typeof makeName !== 'function') return buildPdfFileName('')
  return buildPdfFileName(makeName(CAPTURE_PREFIX, 'pdf'))
}

function resolveImageSize(imageBuffer, options = {}) {
  const explicitWidth = Number(options.pxW)
  const explicitHeight = Number(options.pxH)
  if (Number.isFinite(explicitWidth) && explicitWidth > 0 && Number.isFinite(explicitHeight) && explicitHeight > 0) {
    return { width: Math.round(explicitWidth), height: Math.round(explicitHeight) }
  }
  const pngSize = readPngSize(imageBuffer)
  if (pngSize && pngSize.width > 0 && pngSize.height > 0) return pngSize
  throw new Error('无法确定导出图片尺寸：请传入 pxW/pxH，或使用 PNG 图片数据')
}

function defaultPrintToPdf(win, printOptions) {
  return win.webContents.printToPDF(printOptions)
}

function resolveBrowserWindow(BrowserWindow) {
  if (typeof BrowserWindow === 'function') return BrowserWindow
  let electron = null
  try {
    electron = require('electron')
  } catch {
    electron = null
  }
  if (!electron || typeof electron.BrowserWindow !== 'function') {
    throw new Error('导出 PDF 需要注入 createPrintWindow 或 BrowserWindow（当前不在 Electron 主进程）')
  }
  return electron.BrowserWindow
}

function createDefaultPrintWindowFactory({ BrowserWindow, onBlocked } = {}) {
  const resolvedBrowserWindow = resolveBrowserWindow(BrowserWindow)
  return (pagePath, windowOptions) => createSecureWindow({
    BrowserWindow: resolvedBrowserWindow,
    pagePath,
    options: windowOptions,
    onBlocked
  })
}

function registerPrintWindow(win, { onClosed, log } = {}) {
  activePrintWindows.add(win)
  const handleClosed = () => {
    activePrintWindows.delete(win)
    if (typeof onClosed === 'function') {
      try {
        onClosed(win)
      } catch (error) {
        if (typeof log === 'function') log('PDF export window cleanup failed:', error.message)
      }
    }
  }
  if (typeof win?.once === 'function') win.once('closed', handleClosed)
  return handleClosed
}

function disposePrintWindow(win) {
  if (!win) return false
  try {
    if (typeof win.isDestroyed === 'function' && win.isDestroyed()) {
      activePrintWindows.delete(win)
      return false
    }
    // destroy 不走 beforeunload，离屏打印窗口没有需要保存的渲染状态。
    if (typeof win.destroy === 'function') win.destroy()
    else if (typeof win.close === 'function') win.close()
  } catch {
    // 窗口已经消失；登记表在 closed 钩子里已摘除。
  }
  activePrintWindows.delete(win)
  return true
}

function getActivePrintWindowCount() {
  return activePrintWindows.size
}

function buildImageInjectionScript({ dataUrl, width, height }) {
  return `(() => {
    const img = document.getElementById(${JSON.stringify(PRINT_IMAGE_ID)})
    if (!img) return Promise.reject(new Error('print.html 缺少 #${PRINT_IMAGE_ID}'))
    img.style.width = ${JSON.stringify(`${width}px`)}
    img.style.height = ${JSON.stringify(`${height}px`)}
    img.src = ${JSON.stringify(dataUrl)}
    const decoded = typeof img.decode === 'function'
      ? img.decode()
      : new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject })
    return decoded.then(() => ({ width: img.naturalWidth || img.width, height: img.naturalHeight || img.height }))
  })()`
}

function buildPrintOptions(paper, options = {}) {
  return {
    landscape: paper.landscape,
    pageSize: paper.pageSize,
    printBackground: paper.printBackground,
    scale: paper.scale,
    margins: { ...paper.margins },
    preferCSSPageSize: false,
    ...(options.printOptions || {})
  }
}

function withTimeout(promise, timeoutMs, onTimeout) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise
  let timer = null
  const guard = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout()
      } catch {}
      reject(new Error(`导出 PDF 超时（${timeoutMs}ms）`))
    }, timeoutMs)
    // 定时器不得独自撑住事件循环。
    if (typeof timer.unref === 'function') timer.unref()
  })
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer))
}

/**
 * 把图片缓冲区渲染成 PDF Bytes（离屏 capture/print.html + printToPDF）。
 *
 * @param {Buffer|Uint8Array} imageBuffer PNG 图片数据
 * @param {object} options
 *   createPrintWindow(pagePath, windowOptions)  建窗（默认 createSecureWindow + BrowserWindow）
 *   printToPdf(win, printOptions)               默认 win.webContents.printToPDF
 *   rootDirectory / printPagePath / preloadPath 页面与 preload 绝对路径
 *   pxW / pxH / dpi / mode                      纸张参数（见 computePaperOptions）
 *   dataUrl                                     直接复用渲染层已有的 data URL，省一次 base64
 *   timeoutMs / onClosed / log                  超时保护与窗口回收钩子
 * @returns {Promise<Buffer>} PDF 数据
 */
async function exportPdfBuffer(imageBuffer, options = {}) {
  const buffer = Buffer.isBuffer(imageBuffer) ? imageBuffer : Buffer.from(imageBuffer || '')
  if (!buffer.length) throw new Error('导出 PDF 的图片数据为空')

  const rootDirectory = options.rootDirectory || ROOT_DIRECTORY
  const pagePath = options.printPagePath || path.join(rootDirectory, 'capture', 'print.html')
  const preloadPath = options.preloadPath || path.join(rootDirectory, 'preload-capture.js')
  const size = resolveImageSize(buffer, options)
  const paper = computePaperOptions({
    pxW: size.width,
    pxH: size.height,
    dpi: options.dpi,
    mode: options.mode
  })
  const createPrintWindow = typeof options.createPrintWindow === 'function'
    ? options.createPrintWindow
    : createDefaultPrintWindowFactory({ BrowserWindow: options.BrowserWindow, rootDirectory })
  const printToPdf = typeof options.printToPdf === 'function' ? options.printToPdf : defaultPrintToPdf
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_EXPORT_TIMEOUT_MS
  const dataUrl = typeof options.dataUrl === 'string' && options.dataUrl.startsWith('data:')
    ? options.dataUrl
    : `data:image/png;base64,${buffer.toString('base64')}`
  const intrinsicPx = {
    width: Math.round(size.width / finitePositive(options.dpi, DEFAULT_IMAGE_DPI) * CSS_PX_PER_INCH),
    height: Math.round(size.height / finitePositive(options.dpi, DEFAULT_IMAGE_DPI) * CSS_PX_PER_INCH)
  }
  const windowSize = {
    width: Math.min(4096, Math.max(400, intrinsicPx.width)),
    height: Math.min(4096, Math.max(400, intrinsicPx.height))
  }

  const win = createPrintWindow(pagePath, {
    show: false,
    frame: false,
    hasShadow: false,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#ffffff',
    paintWhenInitiallyHidden: true,
    ...windowSize,
    ...(options.windowOptions || {}),
    webPreferences: {
      preload: preloadPath,
      backgroundThrottling: false,
      ...(options.windowOptions?.webPreferences || {})
    }
  })
  registerPrintWindow(win, { onClosed: options.onClosed, log: options.log })

  try {
    await win.loadFile(pagePath)
    await win.webContents.executeJavaScript(buildImageInjectionScript({
      dataUrl,
      // DPI-corrected CSS size, not the PNG's natural pixels: the scale option is
      // derived from this size, so the layout has to agree with it (see
      // computePaperOptions' intrinsicCssPx note).
      width: paper.intrinsicCssPx?.width || size.width,
      height: paper.intrinsicCssPx?.height || size.height
    }))
    return await withTimeout(
      Promise.resolve(printToPdf(win, buildPrintOptions(paper, options))),
      timeoutMs,
      () => disposePrintWindow(win)
    )
  } finally {
    disposePrintWindow(win)
  }
}

/**
 * 已渲染窗口（贴图 main/domains/pin/index.js:338-340,400、识别 main/domains/recognition/index.js:22-51）
 * 直接导 PDF：不需要临时窗口。
 */
async function exportWindowToPdf(win, options = {}) {
  if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) {
    throw new Error('导出 PDF 的窗口不可用')
  }
  if (!win.webContents) throw new Error('导出 PDF 的窗口缺少 webContents')
  const bounds = typeof win.getBounds === 'function' ? win.getBounds() : null
  const width = finitePositive(options.pxW, finitePositive(bounds?.width, 1))
  const height = finitePositive(options.pxH, finitePositive(bounds?.height, 1))
  const paper = computePaperOptions({ pxW: width, pxH: height, dpi: options.dpi, mode: options.mode })
  const printToPdf = typeof options.printToPdf === 'function' ? options.printToPdf : defaultPrintToPdf
  return printToPdf(win, buildPrintOptions(paper, options))
}

function defaultShowSaveDialog(parentWindow, dialogOptions) {
  const electron = require('electron')
  return parentWindow
    ? electron.dialog.showSaveDialog(parentWindow, dialogOptions)
    : electron.dialog.showSaveDialog(dialogOptions)
}

function resolveDialogApi(options) {
  if (options.dialog && typeof options.dialog.showSaveDialog === 'function') return options.dialog
  return null
}

/**
 * 保存对话框 + 落盘；用户取消返回 null。
 *
 * @param {Buffer|Uint8Array} pdfBuffer
 * @param {object} options parentWindow / dialog / fs / directory / defaultName / makeName /
 *                         showSaveDialog(parentWindow, dialogOptions) / writeFile(filePath, buffer)
 * @returns {Promise<string|null>} 落盘路径
 */
async function savePdfBuffer(pdfBuffer, options = {}) {
  const buffer = Buffer.isBuffer(pdfBuffer) ? pdfBuffer : Buffer.from(pdfBuffer || '')
  if (!buffer.length) throw new Error('PDF 数据为空')
  const defaultName = options.defaultName || createDefaultPdfName(options.makeName)
  const directory = options.directory || ''
  const dialogApi = resolveDialogApi(options)
  const showSaveDialog = typeof options.showSaveDialog === 'function'
    ? options.showSaveDialog
    : (parentWindow, dialogOptions) => (dialogApi
        ? (parentWindow ? dialogApi.showSaveDialog(parentWindow, dialogOptions) : dialogApi.showSaveDialog(dialogOptions))
        : defaultShowSaveDialog(parentWindow, dialogOptions))
  const fileSystem = options.fs || fs
  const writeFile = typeof options.writeFile === 'function'
    ? options.writeFile
    : (filePath, data) => fileSystem.promises.writeFile(filePath, data)

  const result = await showSaveDialog(options.parentWindow || null, {
    title: options.title || '导出 PDF',
    defaultPath: directory ? path.join(directory, defaultName) : defaultName,
    filters: [{ name: 'PDF 文档', extensions: ['pdf'] }]
  })
  if (!result || result.canceled || !result.filePath) return null
  await writeFile(result.filePath, buffer)
  return result.filePath
}

module.exports = {
  DEFAULT_IMAGE_DPI,
  MAX_PAGE_INCHES,
  MAX_PAGE_MICRONS,
  MICRONS_PER_INCH,
  MIN_PAGE_INCHES,
  MIN_PAGE_MICRONS,
  PAGE_MODES,
  PAGE_SIZE_UNIT,
  buildPdfFileName,
  buildPrintOptions,
  computePaperOptions,
  createDefaultPdfName,
  exportPdfBuffer,
  exportWindowToPdf,
  getActivePrintWindowCount,
  resolveImageSize,
  savePdfBuffer
}
