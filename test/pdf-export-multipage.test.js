// Multi-page PDF (2026-10-18 snow migration §11.4 / §12.3 ①).
//
// `exportPagesToPdfBuffer` turns N images into one printToPDF call. The two things
// that decide whether the result is correct are (a) the injected DOM (one sheet per
// image, last sheet without a forced break so Chromium does not emit a blank page)
// and (b) the print options being DOCUMENT-level: page size and landscape come from
// the first page, while a per-page fit happens in CSS px. Both are asserted here
// against the same fake print window the single-image tests use.
const test = require('node:test')
const assert = require('node:assert/strict')

const {
  MAX_PDF_PAGES,
  buildPageAppendScript,
  buildPagesSetupScript,
  computePaperOptions,
  exportPagesToPdfBuffer
} = require('../main/services/pdf-export')

const PRINT_PAGE_PATH = '/app/capture/print.html'
const ONE_PIXEL_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

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

// The setup script also mentions `print-pages`, so page appends are identified by
// the element they create, not by the id they touch.
function isAppendScript(script) {
  return script.includes("document.createElement('div')")
}
function createHarness({ printPdf } = {}) {
  const windows = []
  const scripts = []
  const printed = []
  const createPrintWindow = () => {
    const win = {
      destroyed: false,
      loadFile: async () => {},
      webContents: {
        executeJavaScript: async (script) => {
          scripts.push(script)
          const width = Number((/img\.style\.width = "(\d+)px"/.exec(script) || [])[1]) || 0
          const height = Number((/img\.style\.height = "(\d+)px"/.exec(script) || [])[1]) || 0
          return { width, height }
        }
      },
      once: () => {},
      isDestroyed: () => win.destroyed,
      destroy: () => { win.destroyed = true }
    }
    windows.push(win)
    return win
  }
  const printToPdf = printPdf || (async (win, options) => { printed.push(options); return Buffer.from('%PDF-1.4') })
  return { windows, scripts, printed, createPrintWindow, printToPdf }
}

function callExport(harness, pages, options = {}) {
  return exportPagesToPdfBuffer(pages, {
    createPrintWindow: harness.createPrintWindow,
    printToPdf: harness.printToPdf,
    printPagePath: PRINT_PAGE_PATH,
    preloadPath: '/app/preload-capture.js',
    ...options
  })
}

test('one image per page, injected as one sheet each, in one print call', async () => {
  const harness = createHarness()
  const pages = [
    { buffer: makePngHeader(1600, 900) },
    { buffer: makePngHeader(800, 600) },
    { buffer: makePngHeader(400, 1200) }
  ]
  const buffer = await callExport(harness, pages)
  assert.ok(Buffer.isBuffer(buffer) && buffer.length > 0)
  // A single printToPDF call for the whole document.
  assert.equal(harness.printed.length, 1, 'N pages must cost ONE printToPDF')
  // One setup script, then one append per page.
  const appends = harness.scripts.filter(isAppendScript)
  assert.equal(appends.length, pages.length)
  // The setup flips the page into multi mode and sizes the printable box in CSS px.
  const setup = harness.scripts[0]
  assert.match(setup, /print-multi/)
  assert.match(setup, /--print-page-width/)
  assert.match(setup, /--print-page-height/)
  // Exactly the last sheet is marked so it does not force a trailing break.
  assert.equal(harness.scripts.filter((script) => script.includes("sheet.classList.add('print-page-last')") && script.includes('if (true)')).length, 1)
  assert.equal(harness.scripts.filter((script) => script.includes('if (false)')).length, pages.length - 1)
  // The window is disposed even though the export succeeded.
  assert.equal(harness.windows.length, 1)
  assert.equal(harness.windows[0].destroyed, true)
})

test('paper, orientation and scale come from the first page; the document prints unaugmented', async () => {
  const harness = createHarness()
  // A wide first page makes the document landscape; the tall second page must be
  // fitted into that same box instead of rotating the document mid-way.
  await callExport(harness, [
    { buffer: makePngHeader(1920, 1080) },
    { buffer: makePngHeader(600, 2000) }
  ])
  const options = harness.printed[0]
  const expected = computePaperOptions({ pxW: 1920, pxH: 1080 })
  assert.equal(options.pageSize, expected.pageSize)
  assert.equal(options.landscape, true)
  assert.equal(options.printBackground, true)
  assert.equal(options.preferCSSPageSize, false)
  // The per-page fit already happened in CSS px, so the document scale is 1:
  // applying the paper scale again would shrink every page a second time.
  assert.equal(options.scale, 1)
  assert.deepEqual(options.margins, { marginType: 'none', top: 0, bottom: 0, left: 0, right: 0 })
})

test('an explicit printOptions.scale still wins (caller override)', async () => {
  const harness = createHarness()
  await callExport(harness, [{ buffer: makePngHeader(800, 600) }], { printOptions: { scale: 0.9 } })
  assert.equal(harness.printed[0].scale, 0.9)
})

test('per-page pixel size honours explicit pxW/pxH and falls back to the PNG header', async () => {
  const harness = createHarness()
  await callExport(harness, [
    { buffer: makePngHeader(1000, 500) },
    { buffer: makePngHeader(10, 10), pxW: 900, pxH: 450 }
  ])
  const appends = harness.scripts.filter(isAppendScript)
  // Each image is laid out at the first page's printable box, scaled to fit.
  assert.match(appends[0], /img\.style\.width = "\d+px"/)
  // The explicitly-sized page is not shrunk by the tiny PNG header it carries.
  const declared = /img\.style\.width = "(\d+)px"/.exec(appends[1])
  assert.ok(Number(declared[1]) > 10, 'explicit pxW must beat the 10px PNG header')
})

test('a data URL page is used verbatim instead of being re-encoded', async () => {
  const harness = createHarness()
  // A data URL carries no readable size, so the caller must supply one - that is the
  // documented contract (`resolveImageSize` only understands PNG buffers).
  await callExport(harness, [{ dataUrl: ONE_PIXEL_PNG, pxW: 640, pxH: 480 }])
  const append = harness.scripts.find(isAppendScript)
  assert.match(append, new RegExp(ONE_PIXEL_PNG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('a data URL page without a size is rejected before any window opens', async () => {
  // resolveImageSize can only read a PNG header; a bare data URL needs pxW/pxH.
  const harness = createHarness()
  await assert.rejects(() => callExport(harness, [{ dataUrl: ONE_PIXEL_PNG }]), /无法确定导出图片尺寸/)
  assert.equal(harness.windows.length, 0)
})

test('empty, oversized and non-array page lists are rejected before any window opens', async () => {
  for (const pages of [[], null, undefined, 'nope']) {
    const harness = createHarness()
    await assert.rejects(() => callExport(harness, pages), /图片数据为空|array/i, String(pages))
    assert.equal(harness.windows.length, 0, 'no print window for a rejected request')
  }
  // The page cap is a hard limit, and it is a real number the UI can read.
  assert.equal(typeof MAX_PDF_PAGES, 'number')
  assert.ok(MAX_PDF_PAGES > 0)
  const harness = createHarness()
  const tooMany = Array.from({ length: MAX_PDF_PAGES + 1 }, () => ({ buffer: makePngHeader(10, 10) }))
  await assert.rejects(() => callExport(harness, tooMany), /最多|page/i)
  assert.equal(harness.windows.length, 0)
})

test('a page that cannot be decoded fails the export and still disposes the window', async () => {
  const harness = createHarness({ printPdf: async () => { throw new Error('printToPDF exploded') } })
  await assert.rejects(() => callExport(harness, [{ buffer: makePngHeader(100, 100) }]), /printToPDF exploded/)
  assert.equal(harness.windows.length, 1)
  assert.equal(harness.windows[0].destroyed, true)
})

test('the setup and append scripts target the documented print-page contract', () => {
  const setup = buildPagesSetupScript({ pageWidth: 793, pageHeight: 1122 })
  assert.match(setup, /getElementById\("print-pages"\)/)
  assert.match(setup, /document\.documentElement\.classList\.add\("print-multi"\)/)
  assert.match(setup, /document\.body\.classList\.add\("print-multi"\)/)
  assert.match(setup, /"793px"/)
  assert.match(setup, /"1122px"/)
  // The last sheet resets the break; every other sheet forces one.
  assert.match(buildPageAppendScript({ dataUrl: ONE_PIXEL_PNG, width: 10, height: 10, last: true }), /if \(true\) sheet\.classList\.add\('print-page-last'\)/)
  assert.match(buildPageAppendScript({ dataUrl: ONE_PIXEL_PNG, width: 10, height: 10, last: false }), /if \(false\)/)
  // Both scripts bail out with a named error if the page markup drifts.
  assert.match(setup, /print\.html is missing #print-pages/)
  assert.match(buildPageAppendScript({ dataUrl: ONE_PIXEL_PNG, width: 1, height: 1 }), /print\.html is missing #print-pages/)
})
