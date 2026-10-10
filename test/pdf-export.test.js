const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const {
  DEFAULT_IMAGE_DPI,
  MAX_PAGE_MICRONS,
  MIN_PAGE_MICRONS,
  PAGE_SIZE_UNIT,
  buildPdfFileName,
  computePaperOptions,
  createDefaultPdfName,
  exportPdfBuffer,
  exportWindowToPdf,
  getActivePrintWindowCount,
  savePdfBuffer
} = require('../main/services/pdf-export')
const { readPngSize } = require('../main/services/capture-geometry')
const { makeCaptureName } = require('../main/services/capture-naming')
const { createCaptureDomain } = require('../main/domains/capture')

const ROOT = path.resolve(__dirname, '..')

// readPngSize only reads the 24-byte IHDR prefix, so a signature+IHDR stub is enough
// to exercise the "derive the paper size from the image itself" path.
function makePngHeader(width, height) {
  const buffer = Buffer.alloc(24)
  buffer.writeUInt32BE(0x89504e47, 0)
  buffer.writeUInt32BE(0x0d0a1a0a, 4)
  buffer.writeUInt32BE(13, 8)
  buffer.write('IHDR', 12, 'ascii')
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  return buffer
}

function createFakePrintWindow() {
  const listeners = new Map()
  const win = {
    destroyed: false,
    loadedPages: [],
    scripts: [],
    loadFile: async (pagePath) => { win.loadedPages.push(pagePath) },
    webContents: {
      executeJavaScript: async (script) => { win.scripts.push(script); return { width: 1, height: 1 } }
    },
    once: (event, handler) => { listeners.set(event, handler) },
    isDestroyed: () => win.destroyed,
    destroy: () => {
      win.destroyed = true
      listeners.get('closed')?.()
    }
  }
  return win
}

test('A4 paper: portrait for tall images, landscape for wide ones, square stays portrait', () => {
  const portrait = computePaperOptions({ pxW: 1000, pxH: 2000 })
  assert.equal(portrait.mode, 'a4')
  assert.equal(portrait.pageSize, 'A4')
  assert.equal(portrait.landscape, false)
  assert.equal(portrait.printBackground, true)
  assert.equal(portrait.preferCSSPageSize, false)
  assert.equal(portrait.clamped, false)
  // 可打印区 = A4 短边 210mm → 793.70 CSS px；高 297mm → 1122.52 CSS px。
  // scale = min(1, 793.70/1000, 1122.52/2000)
  assert.equal(portrait.scale, 0.5612)
  assert.deepEqual(portrait.margins, { marginType: 'none', top: 0, bottom: 0, left: 0, right: 0 })

  const landscape = computePaperOptions({ pxW: 1920, pxH: 1080 })
  assert.equal(landscape.pageSize, 'A4')
  assert.equal(landscape.landscape, true)
  // 横向时短边变成页面高度：scale = min(1, 1122.52/1920)
  assert.equal(landscape.scale, 0.5846)

  const square = computePaperOptions({ pxW: 800, pxH: 800 })
  assert.equal(square.landscape, false)
  assert.equal(square.scale, 0.9921)
})

test('A4 paper never upscales a small image', () => {
  const paper = computePaperOptions({ pxW: 100, pxH: 80 })
  assert.equal(paper.landscape, true)
  assert.equal(paper.scale, 1)
})

test('the image dpi corrects physical-pixel screenshots back to 1:1 CSS size', () => {
  // 150% 缩放的屏幕：1920 物理像素 = 1280 CSS px。
  const paper = computePaperOptions({ pxW: 1920, pxH: 1080, dpi: DEFAULT_IMAGE_DPI * 1.5 })
  assert.equal(paper.scale, 0.8769)
  // scaleFactor 不影响横竖方向（dpi 在宽高比里抵消）。
  assert.equal(paper.landscape, true)
})

test('original-size mode converts inches to microns and hands Chromium inches', () => {
  const paper = computePaperOptions({ pxW: 600, pxH: 400, mode: 'original' })
  assert.equal(paper.mode, 'original')
  // 600px @96dpi = 6.25in = 158750 微米；400px = 4.1666535in = 105833 微米（四舍五入）。
  assert.deepEqual(paper.pageSizeMicrons, { width: 158750, height: 105833 })
  // Electron 43 的 printToPDF 只接受英寸（实测，见模块头注释）。
  assert.equal(PAGE_SIZE_UNIT, 'inches')
  assert.deepEqual(paper.pageSize, { width: 6.25, height: 4.166654 })
  // 自定义 Size 已编码方向，不能再让 Chromium 旋转。
  assert.equal(paper.landscape, false)
  assert.equal(paper.clamped, false)
  assert.deepEqual(paper.requestedPageSizeMicrons, { width: 158750, height: 105833 })
  assert.equal(paper.scale, 0.9999)
})

test('original-size mode clamps to the 200-inch ceiling (R8)', () => {
  // 20000px 长截图 @96dpi 请求 208.3 英寸，超过 200 英寸上限。
  const paper = computePaperOptions({ pxW: 2000, pxH: 20000, mode: 'original' })
  assert.equal(MAX_PAGE_MICRONS, 5080000)
  assert.equal(paper.pageSizeMicrons.height, 5080000)
  assert.equal(paper.pageSize.height, 200)
  assert.equal(paper.requestedPageSizeMicrons.height, 5291667)
  assert.equal(paper.clamped, true)
  assert.equal(paper.pageSizeMicrons.width, 529167)
  assert.equal(paper.pageSize.width, 20.833346)
  // 夹取后必须缩小内容，否则长图会被裁掉尾部。
  assert.equal(paper.scale, 0.96)
})

test('original-size mode also clamps the verified 1-inch floor and the print scale floor', () => {
  // 实测 0.1/0.25/0.5 英寸会让 Chromium 报 "content area is empty"，1 英寸可用。
  const tiny = computePaperOptions({ pxW: 1, pxH: 1, mode: 'original' })
  assert.deepEqual(tiny.pageSizeMicrons, { width: MIN_PAGE_MICRONS, height: MIN_PAGE_MICRONS })
  assert.deepEqual(tiny.pageSize, { width: 1, height: 1 })
  assert.equal(MIN_PAGE_MICRONS, 25400)
  assert.equal(tiny.clamped, true)
  assert.equal(tiny.scale, 1)

  // 极长图（2083 英寸）：夹取后仍需小于 Chromium 的 0.1 scale 下限，安全垫生效。
  const extreme = computePaperOptions({ pxW: 100, pxH: 200000, mode: 'original' })
  assert.equal(extreme.pageSizeMicrons.height, 5080000)
  assert.equal(extreme.pageSize.height, 200)
  assert.equal(extreme.scale, 0.1)
})

test('malformed paper inputs fall back to a 1x1 portrait A4 page', () => {
  const empty = computePaperOptions()
  assert.equal(empty.pageSize, 'A4')
  assert.equal(empty.landscape, false)
  assert.equal(empty.scale, 1)

  const junk = computePaperOptions({ pxW: 'abc', pxH: null, dpi: -3, mode: 'a5' })
  assert.equal(junk.pageSize, 'A4')
  assert.equal(junk.scale, 1)
  assert.equal(junk.mode, 'a4')
})

test('PDF names reuse the capture naming generator and normalize the extension', () => {
  assert.equal(buildPdfFileName('Highlighter_2026-10-10_20-40-20-000.png'), 'Highlighter_2026-10-10_20-40-20-000.pdf')
  assert.equal(buildPdfFileName('shot.JPEG'), 'shot.pdf')
  assert.equal(buildPdfFileName('already.pdf'), 'already.pdf')
  assert.equal(buildPdfFileName('   '), 'Highlighter_export.pdf')
  assert.equal(buildPdfFileName(null), 'Highlighter_export.pdf')

  // P0-4-T6 接口约定：S7 落地 makeCaptureName(prefix, ext) 后这里直接拿到 .pdf。
  const calls = []
  const name = createDefaultPdfName((prefix, ext) => {
    calls.push([prefix, ext])
    return 'Highlighter_2026-10-10_20-40-20-000.png'
  })
  assert.equal(name, 'Highlighter_2026-10-10_20-40-20-000.pdf')
  assert.deepEqual(calls, [['Highlighter', 'pdf']])
  assert.match(createDefaultPdfName(), /^Highlighter_\d{4}-\d{2}-\d{2}_[\d-]+\.pdf$/)
  assert.match(createDefaultPdfName(makeCaptureName), /^Highlighter_\d{4}-\d{2}-\d{2}_[\d-]+\.pdf$/)
})

test('savePdfBuffer writes the chosen path and returns null when cancelled', async () => {
  const cancelled = []
  const cancelledPath = await savePdfBuffer(Buffer.from('%PDF-cancel'), {
    showSaveDialog: async (_parent, options) => { cancelled.push(options); return { canceled: true } },
    writeFile: async () => { throw new Error('must not write') }
  })
  assert.equal(cancelledPath, null)
  assert.equal(cancelled[0].title, '导出 PDF')
  assert.deepEqual(cancelled[0].filters, [{ name: 'PDF 文档', extensions: ['pdf'] }])
  assert.match(cancelled[0].defaultPath, /^Highlighter_\d{4}-\d{2}-\d{2}_[\d-]+\.pdf$/)

  const writes = []
  const filePath = await savePdfBuffer(Buffer.from('%PDF-ok'), {
    directory: 'D:/out',
    defaultName: 'Highlighter_2026-10-10_20-40-20-000.pdf',
    showSaveDialog: async (_parent, options) => {
      assert.equal(options.defaultPath, path.join('D:/out', 'Highlighter_2026-10-10_20-40-20-000.pdf'))
      return { canceled: false, filePath: 'D:/out/final.pdf' }
    },
    writeFile: async (target, data) => writes.push({ target, data })
  })
  assert.equal(filePath, 'D:/out/final.pdf')
  assert.equal(writes.length, 1)
  assert.equal(writes[0].target, 'D:/out/final.pdf')
  assert.equal(writes[0].data.toString('utf8'), '%PDF-ok')

  const dismissed = await savePdfBuffer(Buffer.from('%PDF-dismissed'), {
    showSaveDialog: async () => undefined,
    writeFile: async () => { throw new Error('must not write') }
  })
  assert.equal(dismissed, null)

  await assert.rejects(() => savePdfBuffer(Buffer.alloc(0), { showSaveDialog: async () => ({}) }), /PDF 数据为空/)
})

test('exportPdfBuffer renders capture/print.html offscreen and disposes the window', async () => {
  const printWindows = []
  const printCalls = []
  const built = []
  const result = await exportPdfBuffer(makePngHeader(1920, 1080), {
    rootDirectory: ROOT,
    createPrintWindow: (pagePath, options) => {
      const win = createFakePrintWindow()
      printWindows.push({ pagePath, options, win })
      return win
    },
    printToPdf: async (win, options) => {
      printCalls.push({ win, options })
      return Buffer.from('%PDF-fake')
    },
    onClosed: (win) => built.push(win)
  })

  assert.equal(result.toString('utf8'), '%PDF-fake')
  assert.equal(printWindows.length, 1)
  const [{ pagePath, options, win }] = printWindows
  assert.equal(pagePath, path.join(ROOT, 'capture', 'print.html'))
  assert.equal(options.show, false)
  assert.equal(options.frame, false)
  assert.equal(options.skipTaskbar, true)
  assert.equal(options.webPreferences.preload, path.join(ROOT, 'preload-capture.js'))
  assert.equal(options.webPreferences.backgroundThrottling, false)
  assert.deepEqual(win.loadedPages, [path.join(ROOT, 'capture', 'print.html')])
  assert.equal(win.scripts.length, 1)
  assert.match(win.scripts[0], /data:image\/png;base64,/)
  assert.match(win.scripts[0], /"1920px"/)
  assert.match(win.scripts[0], /"1080px"/)

  assert.equal(printCalls.length, 1)
  assert.deepEqual(printCalls[0].options, {
    landscape: true,
    pageSize: 'A4',
    printBackground: true,
    scale: 0.5846,
    margins: { marginType: 'none', top: 0, bottom: 0, left: 0, right: 0 },
    preferCSSPageSize: false
  })

  // closed 钩子 + finally 双保险：登记表清空，窗口已销毁。
  assert.equal(getActivePrintWindowCount(), 0)
  assert.equal(win.destroyed, true)
  assert.deepEqual(built, [win])
})

test('exportPdfBuffer reuses a renderer data url and honours explicit pixel bounds', async () => {
  const scripts = []
  const paperOptions = []
  const dataUrl = 'data:image/png;base64,AAAA'
  await exportPdfBuffer(Buffer.from('not-a-png'), {
    rootDirectory: ROOT,
    pxW: 640,
    pxH: 480,
    dpi: 96,
    mode: 'original',
    dataUrl,
    createPrintWindow: () => {
      const win = createFakePrintWindow()
      win.webContents.executeJavaScript = async (script) => { scripts.push(script) }
      return win
    },
    printToPdf: async (_win, options) => {
      paperOptions.push(options)
      return Buffer.from('%PDF-original')
    }
  })

  assert.match(scripts[0], /data:image\/png;base64,AAAA/)
  // 640×480 @96dpi = 6.666654in × 5in（微米域：169333 × 127000）。
  assert.deepEqual(paperOptions[0].pageSize, { width: 6.666654, height: 5 })
  assert.equal(paperOptions[0].landscape, false)
  assert.equal(getActivePrintWindowCount(), 0)
})

test('exportPdfBuffer rejects empty data, unknown sizes, and nested print options win', async () => {
  await assert.rejects(() => exportPdfBuffer(Buffer.alloc(0), { rootDirectory: ROOT }), /图片数据为空/)
  await assert.rejects(
    () => exportPdfBuffer(Buffer.from('no-size'), { rootDirectory: ROOT, createPrintWindow: () => createFakePrintWindow() }),
    /无法确定导出图片尺寸/
  )

  const seen = []
  await exportPdfBuffer(makePngHeader(100, 50), {
    rootDirectory: ROOT,
    createPrintWindow: () => createFakePrintWindow(),
    printToPdf: async (_win, options) => { seen.push(options); return Buffer.from('%PDF') },
    printOptions: { scale: 1, pageRanges: '1' }
  })
  assert.equal(seen[0].scale, 1)
  assert.equal(seen[0].pageRanges, '1')
})

test('exportPdfBuffer disposes the offscreen window when printing fails or times out', async () => {
  const failing = createFakePrintWindow()
  await assert.rejects(
    () => exportPdfBuffer(makePngHeader(200, 100), {
      rootDirectory: ROOT,
      createPrintWindow: () => failing,
      printToPdf: async () => { throw new Error('printToPDF exploded') }
    }),
    /printToPDF exploded/
  )
  assert.equal(failing.destroyed, true)
  assert.equal(getActivePrintWindowCount(), 0)

  const hanging = createFakePrintWindow()
  await assert.rejects(
    () => exportPdfBuffer(makePngHeader(200, 100), {
      rootDirectory: ROOT,
      timeoutMs: 20,
      createPrintWindow: () => hanging,
      printToPdf: () => new Promise(() => {})
    }),
    /导出 PDF 超时/
  )
  assert.equal(hanging.destroyed, true)
  assert.equal(getActivePrintWindowCount(), 0)
})

test('exportPdfBuffer needs a real print window factory outside Electron', async () => {
  await assert.rejects(
    () => exportPdfBuffer(makePngHeader(10, 10), {}),
    /需要注入 createPrintWindow 或 BrowserWindow/
  )
})

test('exportWindowToPdf prints an already-rendered pin/recognition window', async () => {
  const calls = []
  const win = {
    isDestroyed: () => false,
    webContents: { id: 1 },
    getBounds: () => ({ width: 400, height: 300 })
  }
  const buffer = await exportWindowToPdf(win, {
    pxW: 1920,
    pxH: 1080,
    printToPdf: async (target, options) => {
      calls.push({ target, options })
      return Buffer.from('%PDF-window')
    }
  })
  assert.equal(buffer.toString('utf8'), '%PDF-window')
  assert.equal(calls[0].target, win)
  assert.equal(calls[0].options.pageSize, 'A4')
  assert.equal(calls[0].options.landscape, true)
  assert.equal(calls[0].options.scale, 0.5846)

  await exportWindowToPdf(win, {
    printToPdf: async (_target, options) => { calls.push({ options }); return Buffer.from('%PDF-bounds') }
  })
  // 没有显式像素尺寸时用窗口边界（400×300，同样无需放大）。
  assert.equal(calls[1].options.landscape, true)
  assert.equal(calls[1].options.scale, 1)

  await assert.rejects(() => exportWindowToPdf(null, {}), /窗口不可用/)
  await assert.rejects(() => exportWindowToPdf({ isDestroyed: () => true }, {}), /窗口不可用/)
  await assert.rejects(() => exportWindowToPdf({ isDestroyed: () => false }, {}), /缺少 webContents/)
})

function createCaptureDomainDeps(overrides = {}) {
  const createdWindows = []
  const printCalls = []
  const savedPdfs = []
  const parentWindow = { isDestroyed: () => false }
  const deps = {
    spawn: () => {},
    log: () => {},
    BrowserWindow: { fromWebContents: () => parentWindow },
    imageDataToBuffer: (value) => (Buffer.isBuffer(value) ? value : Buffer.from(value || '')),
    readPngSize,
    rootDirectory: ROOT,
    // exportPdf names the file through screenshot.nameTemplate (P0-7-T1), so the
    // domain needs its real getSettings collaborator even when the save helper is
    // left to the module default.
    getSettings: () => ({ screenshot: { nameTemplate: '' } }),
    dialog: { showSaveDialog: async () => ({ canceled: true }) },
    fs: { promises: { writeFile: async () => {} } },
    createLocalWindow: (pagePath, options) => {
      const win = createFakePrintWindow()
      createdWindows.push({ pagePath, options, win })
      return win
    },
    printToPdf: async (win, options) => {
      printCalls.push({ win, options })
      return Buffer.from('%PDF-domain')
    },
    savePdfBuffer: async (buffer, options) => {
      savedPdfs.push({ buffer, options })
      return 'D:/out/Highlighter.pdf'
    },
    ...overrides
  }
  return { deps, createdWindows, printCalls, savedPdfs, parentWindow }
}

test('the capture domain exportPdf handler resolves printToPDF and the save dialog in-process', async () => {
  const { deps, createdWindows, printCalls, savedPdfs, parentWindow } = createCaptureDomainDeps()
  const domain = createCaptureDomain(deps)
  const controller = domain.createCaptureController()

  const filePath = await controller.exportPdf(
    { sender: { id: 'capture-sender' } },
    { imageBuffer: makePngHeader(1920, 1080), meta: { scaleFactor: 1, width: 1920, height: 1080 } }
  )

  assert.equal(filePath, 'D:/out/Highlighter.pdf')
  assert.equal(createdWindows.length, 1)
  assert.match(createdWindows[0].pagePath, /capture[\\/]print\.html$/)
  assert.equal(createdWindows[0].win.destroyed, true)
  assert.equal(printCalls[0].options.pageSize, 'A4')
  assert.equal(printCalls[0].options.landscape, true)
  assert.equal(printCalls[0].options.scale, 0.5846)
  assert.equal(savedPdfs[0].buffer.toString('utf8'), '%PDF-domain')
  assert.equal(savedPdfs[0].options.parentWindow, parentWindow)
  assert.equal(savedPdfs[0].options.dialog, deps.dialog)
  assert.equal(savedPdfs[0].options.fs, deps.fs)
  assert.equal(getActivePrintWindowCount(), 0)
})

test('the capture domain exportPdf handler applies the display scale factor and rejects junk', async () => {
  const { deps, printCalls } = createCaptureDomainDeps()
  const controller = createCaptureDomain(deps).createCaptureController()

  await controller.exportPdf(
    { sender: {} },
    { dataUrl: 'data:image/png;base64,AAAA', meta: { scaleFactor: 1.5, width: 1920, height: 1080 } }
  )
  const { options } = printCalls[0]
  assert.equal(options.landscape, true)
  // 1920 物理像素 @144dpi → 1280 CSS px：scale = min(1, 1122.52/1280)。
  assert.equal(options.scale, 0.8769)

  await assert.rejects(() => controller.exportPdf({ sender: {} }, {}), /截图图片数据为空/)
  await assert.rejects(
    () => controller.exportPdf({ sender: {} }, { imageBuffer: Buffer.from('no-header'), meta: {} }),
    /需要 PNG 截图数据/
  )
})

test('the capture domain uses the module save helper when nothing is injected', async () => {
  const saves = []
  const { deps } = createCaptureDomainDeps({ savePdfBuffer: undefined })
  deps.fs = { promises: { writeFile: async (target, data) => saves.push({ target, data }) } }
  deps.dialog = { showSaveDialog: async () => ({ canceled: false, filePath: 'D:/out/module-default.pdf' }) }
  const controller = createCaptureDomain(deps).createCaptureController()

  const filePath = await controller.exportPdf({ sender: {} }, { imageBuffer: makePngHeader(300, 200), meta: {} })
  assert.equal(filePath, 'D:/out/module-default.pdf')
  assert.equal(saves.length, 1)
  assert.equal(saves[0].data.toString('utf8'), '%PDF-domain')
})

// Real-Electron end-to-end probe (P0-4-T8 evidence, hidden windows only).
// The probe script and its PDF artifacts live under the gitignored .tmp/; the probe
// runs in a child Electron process so no visible window ever reaches the desktop.
const PROBE_SOURCE = `
'use strict'
const fs = require('fs')
const path = require('path')
const os = require('os')
const { app, BrowserWindow } = require('electron')

const ROOT = process.env.PDF_PROBE_ROOT
const OUT_DIR = process.env.PDF_PROBE_OUT
const RESULT = process.env.PDF_PROBE_RESULT

function pdfFacts(buffer) {
  const latin = buffer.toString('latin1')
  return {
    header: latin.slice(0, 5),
    pageCount: [...latin.matchAll(/\\/Type\\s*\\/Page(?![s])/g)].length,
    boxes: [...latin.matchAll(/\\/MediaBox\\s*\\[\\s*([\\d.\\-\\s]+?)\\s*\\]/g)]
      .map((match) => match[1].trim().split(/\\s+/).map(Number))
  }
}

async function main() {
  const pdfExport = require(path.join(ROOT, 'main', 'services', 'pdf-export'))
  const sharp = require('sharp')
  app.setPath('userData', path.join(os.tmpdir(), 'highlighter-pdf-probe-' + process.pid))
  // Destroying the only (hidden) print window would otherwise hit Electron's default
  // window-all-closed quit; the real app always keeps its main window open.
  app.on('window-all-closed', () => {})
  await app.whenReady()
  fs.mkdirSync(OUT_DIR, { recursive: true })

  const cases = []
  async function runCase(name, pixels, mode) {
    const visibleAtPrint = []
    const buffer = await pdfExport.exportPdfBuffer(pixels.buffer, {
      rootDirectory: ROOT,
      BrowserWindow,
      pxW: pixels.width,
      pxH: pixels.height,
      mode,
      printToPdf: async (win, printOptions) => {
        visibleAtPrint.push(win.isVisible())
        return win.webContents.printToPDF(printOptions)
      }
    })
    const file = path.join(OUT_DIR, name + '.pdf')
    fs.writeFileSync(file, buffer)
    cases.push({ name, mode: mode || 'a4', bytes: buffer.length, visibleAtPrint, file, ...pdfFacts(buffer) })
  }

  const image = (width, height, background) => sharp({
    create: { width, height, channels: 3, background }
  }).png().toBuffer().then((buffer) => ({ buffer, width, height }))

  await runCase('a4-landscape-1920x1080', await image(1920, 1080, '#3366ff'))
  await runCase('original-600x400', await image(600, 400, '#ff6633'), 'original')
  await runCase('original-2000x20000-clamped', await image(2000, 20000, '#22aa66'), 'original')

  fs.writeFileSync(RESULT, JSON.stringify({
    activePrintWindowCount: pdfExport.getActivePrintWindowCount(),
    cases
  }, null, 2))
  app.exit(0)
}

main().catch((error) => {
  try {
    fs.writeFileSync(RESULT, JSON.stringify({ error: String(error && error.stack ? error.stack : error) }))
  } catch {}
  app.exit(1)
})
`

test('real Electron prints capture/print.html in hidden windows (P0-4-T8)', { timeout: 120000 }, () => {
  const probeDir = path.join(ROOT, '.tmp', 'pdf-export-probe')
  const probePath = path.join(probeDir, 'electron-export-probe.js')
  const outDir = path.join(probeDir, 'out')
  const resultPath = path.join(probeDir, 'test-result.json')
  fs.mkdirSync(probeDir, { recursive: true })
  fs.rmSync(resultPath, { force: true })
  fs.writeFileSync(probePath, PROBE_SOURCE)

  // ELECTRON_RUN_AS_NODE must be cleared or Electron starts as plain node and the probe
  // dies at app.setPath (see the P0 plan §16.3 item 5); spawnSync needs its own env copy.
  const env = {
    ...process.env,
    ELECTRON_ENABLE_LOGGING: '0',
    PDF_PROBE_ROOT: ROOT,
    PDF_PROBE_OUT: outDir,
    PDF_PROBE_RESULT: resultPath
  }
  delete env.ELECTRON_RUN_AS_NODE
  const result = spawnSync(require('electron'), [probePath], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 110000,
    windowsHide: true,
    env
  })
  assert.equal(
    result.status,
    0,
    `Electron PDF probe failed.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  )
  assert.equal(fs.existsSync(resultPath), true, 'probe did not write its result file')
  const probe = JSON.parse(fs.readFileSync(resultPath, 'utf8'))
  assert.equal(probe.error, undefined, `probe error: ${probe.error}`)
  assert.equal(probe.activePrintWindowCount, 0, 'offscreen print windows must not leak')
  assert.equal(probe.cases.length, 3)

  const byName = Object.fromEntries(probe.cases.map((entry) => [entry.name, entry]))
  for (const entry of probe.cases) {
    assert.equal(entry.header, '%PDF-', `${entry.name} is not a PDF`)
    assert.equal(entry.pageCount, 1, `${entry.name} must be a single page`)
    assert.deepEqual(entry.visibleAtPrint, [false], `${entry.name} must print from a hidden window`)
    assert.equal(fs.existsSync(entry.file), true)
    assert.ok(entry.bytes > 1000, `${entry.name} looks empty (${entry.bytes} bytes)`)
  }

  // A4 landscape: Chromium's A4 is 11.7067in x 8.2767in.
  const landscape = byName['a4-landscape-1920x1080'].boxes[0]
  assert.ok(Math.abs(landscape[2] - 842.88) < 1, `A4 landscape width ${landscape[2]}`)
  assert.ok(Math.abs(landscape[3] - 595.92) < 1, `A4 landscape height ${landscape[3]}`)

  // Original size: 600px @96dpi must become exactly 6.25in x 4.1667in = 450 x 300pt,
  // which only holds if Electron interprets the custom page size in inches.
  const original = byName['original-600x400'].boxes[0]
  assert.ok(Math.abs(original[2] - 450) < 1, `original width ${original[2]} pt`)
  assert.ok(Math.abs(original[3] - 300) < 1, `original height ${original[3]} pt`)

  // 20000px long screenshot: clamped to the 200-inch ceiling and still one page.
  const clamped = byName['original-2000x20000-clamped'].boxes[0]
  assert.ok(Math.abs(clamped[3] - 14400) < 1, `clamped height ${clamped[3]} pt (expected 200in)`)
  assert.ok(clamped[2] < 1510, `clamped width ${clamped[2]} pt`)
})
