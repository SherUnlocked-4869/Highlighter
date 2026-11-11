'use strict'

// R0-06 产品真实打印页 PDF 对照：共享用例/参数/脚本生成器。
//
// 背景（docs/plans/rust-migration/r0-pdf-spike.md §7 第 1～2 条）：首轮 12+15 份对照用的是
// 文档型合成样例（print-sample.html），不是产品 `capture/print.html` 的"图片贴页"路径。
// 本生成器把产品真实链路里的**参数与注入脚本**抽出来，供两个后端逐字节复用：
//
//   - 纸张参数：直接调用 `main/services/pdf-export.js` 的 `computePaperOptions()` /
//     `buildPrintOptions()`（只读 require，不修改产品代码），并生成 electron 侧
//     `printToPDF(options)` 对象；
//   - DOM 注入：直接调用产品的 `buildImageInjectionScript()` / `buildPagesSetupScript()` /
//     `buildPageAppendScript()`，脚本文本原样放进 manifest，Electron 的 executeJavaScript
//     与 WebView2 的 ExecuteScript 执行**同一段文本**；
//   - 批量尺寸：`exportPagesToPdfBuffer()` 里的 sheet/fit 计算是模块私有函数，这里按同一
//     公式复刻（见 `buildBatchFrames()`），并额外产出 `x2-product-exportPagesToPdfBuffer-batch-5`
//     对照用例：直接调用产品函数导出 PDF，用 PDF 语义（页数/MediaBox/图片 bbox）反过来校验
//     复刻的 fit 参数没有漂移。
//
// 合成图片：内置确定性 indexed-PNG 编码器（zlib only，无第三方依赖），图案是
// 白底 + 上红下蓝左右黄绿边框 + 每 500px 一条黑色横线；不读取任何真实用户数据。
//
// 用法（仓库根目录）：
//   node scripts/rust/pdf-product-cases.js [--outdir .tmp-r0-pdf/product]
// 产物（gitignore）：
//   <outdir>/fixtures/*.png        合成图片
//   <outdir>/product-cases.json    两后端共享的用例/参数/脚本 manifest
//
// manifest 由：
//   - scripts/rust/probe-electron-product-pdf.js（Electron 后端）
//   - rust-app/prototypes/webview-pdf-resource --pdf-product（WebView2 后端）
// 共同读取，保证两侧纸张参数与注入脚本完全一致。

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const crypto = require('crypto')

const pdfExport = require('../../main/services/pdf-export.js')

// `buildImageInjectionScript()` 是 main/services/pdf-export.js 的模块私有函数（没有 export），
// 但产品单图路径确实用它；这里逐字复刻（pdf-export.js:270-282），并用下面的
// `assertProductReplica()` 在生成 manifest 时检查产品源码仍有该函数与 `#print-image`，
// 产品若改了实现这里会直接失败而不是悄悄漂移。其余注入脚本用产品导出的函数。
function assertProductReplica() {
  const source = fs.readFileSync(PDF_EXPORT_PATH, 'utf8')
  const checks = [
    ["const PRINT_IMAGE_ID = 'print-image'", 'PRINT_IMAGE_ID'],
    ['function buildImageInjectionScript({ dataUrl, width, height })', 'buildImageInjectionScript'],
    ["img.style.width = ${JSON.stringify(`${width}px`)}", 'style.width 注入'],
    ['return decoded.then(() => ({ width: img.naturalWidth || img.width, height: img.naturalHeight || img.height }))', 'decode 返回值']
  ]
  for (const [needle, label] of checks) {
    if (!source.includes(needle)) {
      throw new Error(`产品源码与复刻的 buildImageInjectionScript 不一致（缺少 ${label}）：${PDF_EXPORT_PATH}`)
    }
  }
}

const PRINT_IMAGE_ID = 'print-image'

/** 逐字复刻 main/services/pdf-export.js:270-282 的 buildImageInjectionScript()。 */
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

const ROOT = path.resolve(__dirname, '..', '..')
const PDF_EXPORT_PATH = path.join(ROOT, 'main', 'services', 'pdf-export.js')
const DEFAULT_OUTDIR = path.join(ROOT, '.tmp-r0-pdf', 'product')
const PATHS = {
  printPage: path.join(ROOT, 'capture', 'print.html'),
  tokensCss: path.join(ROOT, 'shared', 'tokens.css'),
  preloadCapture: path.join(ROOT, 'preload-capture.js')
}
const MANIFEST_SCHEMA = 'r0-pdf-product-cases-v1'
const CSS_PX_PER_INCH = 96

// Electron 43 实测 pageSize:'A4' → MediaBox 595.92×842.88pt（r0-pdf-spike §4 e1 / e1b）。
// WebView2 的 PageWidth/PageHeight 没有 'A4' 别名，必须显式传英寸；共享用例把 'A4'
// 归一成这组实测英寸，两侧才可能得到同一 MediaBox（首轮 w1 与 e1 差 0.96pt 的口径问题）。
const A4_ELECTRON_INCHES = Object.freeze({
  width: 595.92 / 72,
  height: 842.88 / 72
})

// ---------------------------------------------------------------------------
// 合成 PNG（indexed color，zlib only）
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData), 0)
  return Buffer.concat([length, typeAndData, crc])
}

// 颜色表：0 白底、1 顶部红条、2 底部蓝条、3 左侧绿条、4 右侧黄条、5 黑色横线。
const PALETTE = [
  [255, 255, 255],
  [220, 38, 38],
  [37, 99, 235],
  [22, 163, 74],
  [250, 204, 21],
  [17, 17, 17]
]
const BORDER_PX = 40
const RULER_STEP_PX = 500

function fixturePaletteIndex(width, height, x, y) {
  if (y < BORDER_PX) return 1
  if (y >= height - BORDER_PX) return 2
  if (x < BORDER_PX) return 3
  if (x >= width - BORDER_PX) return 4
  if (y % RULER_STEP_PX === 0) return 5
  return 0
}

function encodeFixturePng(width, height) {
  const raw = Buffer.alloc(height * (width + 1))
  let offset = 0
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0 // filter type: none
    offset += 1
    for (let x = 0; x < width; x += 1) raw[offset + x] = fixturePaletteIndex(width, height, x, y)
    offset += width
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 3 // color type: indexed
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  const plte = Buffer.from(PALETTE.flat(), 'binary')
  const idat = zlib.deflateSync(raw, { level: 6 })
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('PLTE', plte),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

// 合成图片清单：名称固定 = 用例里引用的 fixture id。
const FIXTURES = Object.freeze([
  { id: 'img-1440x2560', width: 1440, height: 2560 },
  { id: 'img-2560x1440', width: 2560, height: 1440 },
  { id: 'img-1920x1080', width: 1920, height: 1080 },
  { id: 'img-1080x1920', width: 1080, height: 1920 },
  { id: 'img-800x600', width: 800, height: 600 },
  { id: 'img-1920x20000', width: 1920, height: 20000 },
  { id: 'img-1920x30000', width: 1920, height: 30000 }
])

function fixtureById(id) {
  const fixture = FIXTURES.find((item) => item.id === id)
  if (!fixture) throw new Error(`未知 fixture: ${id}`)
  return fixture
}

// ---------------------------------------------------------------------------
// 用例定义（纸张模式/DPI/注入方式全部走产品代码）
// ---------------------------------------------------------------------------

// 批量 50 页的混合尺寸序列：首页 1440×2560（决定 A4 竖版纸张），其余循环混合横/竖/小图。
const BATCH_50_IDS = (() => {
  const cycle = ['img-1920x1080', 'img-1080x1920', 'img-1440x2560', 'img-800x600', 'img-2560x1440']
  const ids = ['img-1440x2560']
  for (let index = 1; index < pdfExport.MAX_PDF_PAGES; index += 1) {
    ids.push(cycle[(index - 1) % cycle.length])
  }
  return ids
})()

const CASE_SPECS = Object.freeze([
  {
    name: 'p1-a4-portrait-intrinsic',
    kind: 'single',
    description: '单图 A4 竖版：dpi=144 模拟 150% 截图，图片按 intrinsicCssPx 注入（产品 exportPdfBuffer 路径）',
    mode: 'a4',
    dpi: 144,
    fixtures: ['img-1440x2560'],
    inject: 'intrinsic',
    expectedPdfPages: 1
  },
  {
    name: 'p2-a4-landscape-intrinsic',
    kind: 'single',
    description: '单图 A4 横版：dpi=144，图片按 intrinsicCssPx 注入，纸张由 computePaperOptions 交换宽高',
    mode: 'a4',
    dpi: 144,
    fixtures: ['img-2560x1440'],
    inject: 'intrinsic',
    expectedPdfPages: 1
  },
  {
    name: 'p3-a4-portrait-natural-px',
    kind: 'single',
    description: '负对照：A4 竖版纸张不变，但图片按 PNG 自然像素注入（不做 DPR 修正）→ 预期被切到 2 页',
    mode: 'a4',
    dpi: 144,
    fixtures: ['img-1440x2560'],
    inject: 'natural',
    expectedPdfPages: 2
  },
  {
    name: 'p4-original-1920x20000-dpi96',
    kind: 'single',
    description: 'original 长图 1920×20000 @96dpi：请求 208.33in 高 > MAX_PAGE_INCHES=200 → 夹取到 20×200in',
    mode: 'original',
    dpi: 96,
    fixtures: ['img-1920x20000'],
    inject: 'intrinsic',
    expectedPdfPages: 1
  },
  {
    name: 'p5-original-1920x30000-dpi144',
    kind: 'single',
    description: 'original 长图 1920×30000 @144dpi：请求 208.33in 高 > 200 → 夹取到 13.333×200in（同一夹取语义的 DPI 口径）',
    mode: 'original',
    dpi: 144,
    fixtures: ['img-1920x30000'],
    inject: 'intrinsic',
    expectedPdfPages: 1
  },
  {
    name: 'p6-batch-5-mixed-a4-first',
    kind: 'batch',
    description: '批量 5 页：首页 1440×2560 → A4 竖版。混合 1920×1080/1080×1920/800×600/2560×1440，验证每页一张、无空白尾页',
    mode: 'a4',
    dpi: 144,
    fixtures: ['img-1440x2560', 'img-1920x1080', 'img-1080x1920', 'img-800x600', 'img-2560x1440'],
    inject: 'intrinsic',
    expectedPdfPages: 5
  },
  {
    name: 'p7-batch-50-mixed-a4-first',
    kind: 'batch',
    description: `批量 ${pdfExport.MAX_PDF_PAGES} 页（产品上限）：首页 A4 竖版 + 49 页混合尺寸，验证页数=50、无空白尾页`,
    mode: 'a4',
    dpi: 144,
    fixtures: BATCH_50_IDS,
    inject: 'intrinsic',
    expectedPdfPages: pdfExport.MAX_PDF_PAGES
  }
])

// Electron 侧的产品函数对照（真正调用 exportPdfBuffer / exportPagesToPdfBuffer，
// 用来校验上面复刻的注入/批量 fit 参数没有偏离产品实现）；WebView2 侧没有对应函数。
const CONTROL_SPECS = Object.freeze([
  {
    name: 'x1-product-exportPdfBuffer-single-a4-portrait',
    description: '产品函数 exportPdfBuffer() 直接导出单图 A4 竖版（对照 p1 的手工注入流程）',
    function: 'exportPdfBuffer',
    targetCase: 'p1-a4-portrait-intrinsic'
  },
  {
    name: 'x2-product-exportPagesToPdfBuffer-batch-5',
    description: '产品函数 exportPagesToPdfBuffer() 直接导出 5 页混合批量（对照 p6 的手工注入流程）',
    function: 'exportPagesToPdfBuffer',
    targetCase: 'p6-batch-5-mixed-a4-first'
  }
])

// ---------------------------------------------------------------------------
// 产品参数 → 两后端参数
// ---------------------------------------------------------------------------

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function round(value, digits = 6) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function clampWindowSize(intrinsicPx) {
  // 与 main/services/pdf-export.js 的 clampWindowSize() 完全一致（模块私有函数，这里复刻）。
  return {
    width: Math.min(4096, Math.max(400, Math.round(intrinsicPx.width))),
    height: Math.min(4096, Math.max(400, Math.round(intrinsicPx.height)))
  }
}

function paperContentBoxCssPx(paper) {
  // 与 main/services/pdf-export.js 的 paperContentBoxCssPx() 一致。
  return {
    width: paper.pageSizeMicrons.width / pdfExport.MICRONS_PER_INCH * CSS_PX_PER_INCH,
    height: paper.pageSizeMicrons.height / pdfExport.MICRONS_PER_INCH * CSS_PX_PER_INCH
  }
}

function batchFrames(pages, paper) {
  // 与 main/services/pdf-export.js exportPagesToPdfBuffer() 的 sheet/fit 计算逐行一致。
  const printableBox = paperContentBoxCssPx(paper)
  const sheetWidth = Math.max(1, Math.floor(printableBox.width) - 1)
  const sheetHeight = Math.max(1, Math.floor(printableBox.height) - 1)
  const frames = pages.map((page) => {
    const intrinsicWidth = page.size.width / page.dpi * CSS_PX_PER_INCH
    const intrinsicHeight = page.size.height / page.dpi * CSS_PX_PER_INCH
    const fit = Math.min(1, sheetWidth / intrinsicWidth, sheetHeight / intrinsicHeight)
    return {
      width: Math.max(1, Math.round(intrinsicWidth * fit)),
      height: Math.max(1, Math.round(intrinsicHeight * fit)),
      intrinsicWidth,
      intrinsicHeight,
      fit
    }
  })
  const widest = frames.reduce((max, frame) => Math.max(max, frame.width), sheetWidth)
  const tallest = frames.reduce((max, frame) => Math.max(max, frame.height), sheetHeight)
  return { sheetWidth, sheetHeight, printableBox, frames, widest, tallest }
}

/** Electron printToPDF 的 'A4' 别名 → 实测 MediaBox 英寸（WebView2 需要显式英寸）。 */
function electronA4Inches(landscape) {
  return landscape
    ? { width: A4_ELECTRON_INCHES.height, height: A4_ELECTRON_INCHES.width }
    : { width: A4_ELECTRON_INCHES.width, height: A4_ELECTRON_INCHES.height }
}

/** 两后端打印设置的归一化表示（WebView2 PrintSettings 只认英寸 + scale）。 */
function rustPrintOptions(paper, scale) {
  let widthInches
  let heightInches
  if (paper.pageSize === 'A4') {
    const inches = electronA4Inches(paper.landscape)
    widthInches = inches.width
    heightInches = inches.height
  } else {
    widthInches = paper.pageSize.width
    heightInches = paper.pageSize.height
  }
  return {
    pageWidthInches: round(widthInches, 9),
    pageHeightInches: round(heightInches, 9),
    marginInches: 0,
    printBackgrounds: paper.printBackground !== false,
    scale,
    // 尺寸已经编码了横竖方向；WebView2 的首轮实测显示 Orientation 不会二次交换宽高
    // （r0-pdf-spike §5 自定义纸张方向），所以这里固定 false，与 Electron 输出对齐。
    landscape: false
  }
}

function expectedMediaBoxPt(paper) {
  if (paper.pageSize === 'A4') {
    const inches = electronA4Inches(paper.landscape)
    return [round(inches.width * 72, 2), round(inches.height * 72, 2)]
  }
  return [round(paper.pageSize.width * 72, 2), round(paper.pageSize.height * 72, 2)]
}

// ---------------------------------------------------------------------------
// DOM 探针（观察脚本，不是产品注入脚本）
// ---------------------------------------------------------------------------

const LOAD_READY_SCRIPT = `(() => {
  const image = document.getElementById('print-image')
  const pages = document.getElementById('print-pages')
  return document.readyState === 'complete' &&
    location.href.indexOf('/capture/print.html') >= 0 &&
    !!image && !!pages
})()`

function singleProbeScript() {
  return `(() => {
    const image = document.getElementById('print-image')
    const pages = document.getElementById('print-pages')
    const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]')
    return {
      readyState: document.readyState,
      href: location.href,
      origin: location.origin,
      csp: meta ? meta.getAttribute('content') : null,
      hasImage: !!image,
      imageComplete: !!(image && image.complete),
      naturalWidth: image ? image.naturalWidth : 0,
      naturalHeight: image ? image.naturalHeight : 0,
      styleWidth: image ? image.style.width : null,
      styleHeight: image ? image.style.height : null,
      imageCount: document.images.length,
      pagesContainerChildren: pages ? pages.children.length : -1,
      htmlMulti: document.documentElement.classList.contains('print-multi'),
      bodyMulti: document.body ? document.body.classList.contains('print-multi') : false,
      styleSheets: Array.from(document.styleSheets || []).map((sheet) => sheet.href || 'inline')
    }
  })()`
}

function batchProbeScript() {
  return `(() => {
    const container = document.getElementById('print-pages')
    const sheets = container ? Array.from(container.children) : []
    const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]')
    return {
      readyState: document.readyState,
      href: location.href,
      origin: location.origin,
      csp: meta ? meta.getAttribute('content') : null,
      sheetCount: sheets.length,
      pageClassCount: container ? container.querySelectorAll('.print-page').length : -1,
      lastHasLastClass: sheets.length
        ? sheets[sheets.length - 1].classList.contains('print-page-last')
        : false,
      htmlMulti: document.documentElement.classList.contains('print-multi'),
      bodyMulti: document.body ? document.body.classList.contains('print-multi') : false,
      containerStyle: container
        ? {
            width: container.style.getPropertyValue('--print-page-width').trim(),
            height: container.style.getPropertyValue('--print-page-height').trim(),
            inlineStyle: container.getAttribute('style')
          }
        : null,
      sheets: sheets.map((sheet) => {
        const image = sheet.querySelector('img')
        return {
          className: sheet.className,
          imageComplete: !!(image && image.complete),
          naturalWidth: image ? image.naturalWidth : 0,
          naturalHeight: image ? image.naturalHeight : 0,
          styleWidth: image ? image.style.width : null,
          styleHeight: image ? image.style.height : null
        }
      }),
      styleSheets: Array.from(document.styleSheets || []).map((sheet) => sheet.href || 'inline')
    }
  })()`
}

function injectPollScript(naturalWidth) {
  return `(() => {
    const image = document.getElementById('print-image')
    return !!(image && image.complete && image.naturalWidth === ${naturalWidth})
  })()`
}

const SETUP_POLL_SCRIPT = `(() => {
  const container = document.getElementById('print-pages')
  return !!(container && document.body.classList.contains('print-multi'))
})()`

function appendPollScript(index, naturalWidth) {
  return `(() => {
    const container = document.getElementById('print-pages')
    if (!container || !container.children[${index}]) return false
    const image = container.children[${index}].querySelector('img')
    return !!(image && image.complete && image.naturalWidth === ${naturalWidth})
  })()`
}

// ---------------------------------------------------------------------------
// manifest 构建
// ---------------------------------------------------------------------------

function hashFile(filePath) {
  const data = fs.readFileSync(filePath)
  return { path: filePath, bytes: data.length, sha256: sha256(data) }
}

function buildCaseFixture(spec, outDir) {
  const first = fixtureById(spec.fixtures[0])
  const paper = pdfExport.computePaperOptions({
    pxW: first.width,
    pxH: first.height,
    dpi: spec.dpi,
    mode: spec.mode
  })
  const images = spec.fixtures.map((id) => {
    const fixture = fixtureById(id)
    const filePath = path.join(outDir, 'fixtures', `${id}.png`)
    const buffer = fs.readFileSync(filePath)
    const dataUrl = `data:image/png;base64,${buffer.toString('base64')}`
    return {
      fixtureId: id,
      path: filePath,
      pxW: fixture.width,
      pxH: fixture.height,
      dpi: spec.dpi,
      sha256: sha256(buffer),
      dataUrl
    }
  })
  const caseManifest = {
    name: spec.name,
    kind: spec.kind,
    description: spec.description,
    mode: spec.mode,
    dpi: spec.dpi,
    inject: spec.inject,
    images: images.map(({ dataUrl, ...rest }) => rest),
    paper,
    electronOptions: null,
    rustOptions: null,
    windowSize: null,
    steps: [],
    domProbeScript: null,
    expected: {
      pdfPages: spec.expectedPdfPages,
      mediaBoxPt: expectedMediaBoxPt(paper),
      imagesPerPage: 1,
      blankPages: 0,
      clamped: paper.clamped === true
    }
  }

  if (spec.kind === 'single') {
    const injectWidth = spec.inject === 'natural' ? first.width : paper.intrinsicCssPx.width
    const injectHeight = spec.inject === 'natural' ? first.height : paper.intrinsicCssPx.height
    caseManifest.electronOptions = pdfExport.buildPrintOptions(paper)
    caseManifest.rustOptions = rustPrintOptions(paper, paper.scale)
    caseManifest.windowSize = clampWindowSize({
      width: first.width / spec.dpi * CSS_PX_PER_INCH,
      height: first.height / spec.dpi * CSS_PX_PER_INCH
    })
    caseManifest.injectCssPx = { width: injectWidth, height: injectHeight }
    caseManifest.steps = [
      {
        kind: 'image-inject',
        index: 0,
        script: buildImageInjectionScript({
          dataUrl: images[0].dataUrl,
          width: injectWidth,
          height: injectHeight
        }),
        pollScript: injectPollScript(first.width),
        pollTimeoutMs: 20000
      }
    ]
    caseManifest.domProbeScript = singleProbeScript()
    caseManifest.expected.imageDrawPt = [
      round(injectWidth * paper.scale * 72 / CSS_PX_PER_INCH, 2),
      round(injectHeight * paper.scale * 72 / CSS_PX_PER_INCH, 2)
    ]
    return caseManifest
  }

  // 批量：纸张/方向取首页，逐页独立 fit 到同一可打印盒（产品 exportPagesToPdfBuffer 语义）。
  const frames = batchFrames(
    images.map((image) => ({ size: { width: image.pxW, height: image.pxH }, dpi: spec.dpi })),
    paper
  )
  caseManifest.electronOptions = pdfExport.buildPrintOptions(paper, {
    printOptions: { scale: 1 }
  })
  caseManifest.rustOptions = rustPrintOptions(paper, 1)
  caseManifest.windowSize = clampWindowSize({ width: frames.widest, height: frames.tallest })
  caseManifest.batchLayout = {
    sheetWidth: frames.sheetWidth,
    sheetHeight: frames.sheetHeight,
    printableBoxCssPx: {
      width: round(frames.printableBox.width, 4),
      height: round(frames.printableBox.height, 4)
    },
    frames: frames.frames.map((frame) => ({
      width: frame.width,
      height: frame.height,
      fit: round(frame.fit, 6)
    }))
  }
  caseManifest.steps = [
    {
      kind: 'pages-setup',
      index: 0,
      script: pdfExport.buildPagesSetupScript({
        pageWidth: frames.sheetWidth,
        pageHeight: frames.sheetHeight
      }),
      pollScript: SETUP_POLL_SCRIPT,
      pollTimeoutMs: 20000
    }
  ]
  frames.frames.forEach((frame, index) => {
    caseManifest.steps.push({
      kind: 'page-append',
      index,
      script: pdfExport.buildPageAppendScript({
        dataUrl: images[index].dataUrl,
        width: frame.width,
        height: frame.height,
        last: index === frames.frames.length - 1
      }),
      pollScript: appendPollScript(index, images[index].pxW),
      pollTimeoutMs: 20000
    })
  })
  caseManifest.domProbeScript = batchProbeScript()
  caseManifest.expected.imageDrawPtPerPage = frames.frames.map((frame) => [
    round(frame.width * 72 / CSS_PX_PER_INCH, 2),
    round(frame.height * 72 / CSS_PX_PER_INCH, 2)
  ])
  return caseManifest
}

function buildControls(cases) {
  return CONTROL_SPECS.map((spec) => {
    const target = cases.find((item) => item.name === spec.targetCase)
    if (!target) throw new Error(`control 的目标用例不存在: ${spec.targetCase}`)
    const images = target.images.map((image) => ({
      fixtureId: image.fixtureId,
      path: image.path,
      pxW: image.pxW,
      pxH: image.pxH,
      dpi: image.dpi
    }))
    return {
      name: spec.name,
      description: spec.description,
      function: spec.function,
      targetCase: spec.targetCase,
      mode: target.mode,
      dpi: target.dpi,
      images,
      maxPages: pdfExport.MAX_PDF_PAGES
    }
  })
}

function buildManifest(outDir) {
  assertProductReplica()
  ensureFixtures(outDir)
  const cases = CASE_SPECS.map((spec) => buildCaseFixture(spec, outDir))
  const manifest = {
    schema: MANIFEST_SCHEMA,
    generatedAt: new Date().toISOString(),
    node: process.version,
    root: ROOT,
    productModule: 'main/services/pdf-export.js',
    productReplica: {
      buildImageInjectionScript:
        'main/services/pdf-export.js:270-282 为模块私有函数（未 export），本生成器逐字复刻并由 assertProductReplica() 校验产品源码；' +
        'buildPagesSetupScript / buildPageAppendScript / buildPrintOptions / computePaperOptions 直接调用产品导出函数。',
      batchFrames:
        'main/services/pdf-export.js exportPagesToPdfBuffer() 内的 sheet/fit 计算为模块私有，按同公式复刻；' +
        'x2-product-exportPagesToPdfBuffer-batch-5 用产品函数导出的 PDF 反证参数没有漂移。'
    },
    sourceHashes: {
      printPage: hashFile(PATHS.printPage),
      tokensCss: hashFile(PATHS.tokensCss),
      preloadCapture: hashFile(PATHS.preloadCapture),
      pdfExportModule: hashFile(require.resolve('../../main/services/pdf-export.js'))
    },
    paths: {
      printPage: PATHS.printPage,
      tokensCss: PATHS.tokensCss,
      preloadCapture: PATHS.preloadCapture,
      outDir
    },
    constants: {
      maxPageInches: pdfExport.MAX_PAGE_INCHES,
      maxPdfPages: pdfExport.MAX_PDF_PAGES,
      micronsPerInch: pdfExport.MICRONS_PER_INCH,
      defaultImageDpi: pdfExport.DEFAULT_IMAGE_DPI
    },
    fixtures: FIXTURES.map((fixture) => {
      const filePath = path.join(outDir, 'fixtures', `${fixture.id}.png`)
      const buffer = fs.readFileSync(filePath)
      return {
        id: fixture.id,
        path: filePath,
        width: fixture.width,
        height: fixture.height,
        bytes: buffer.length,
        sha256: sha256(buffer)
      }
    }),
    cases,
    controls: buildControls(cases)
  }
  return manifest
}

function ensureFixtures(outDir) {
  const fixtureDir = path.join(outDir, 'fixtures')
  fs.mkdirSync(fixtureDir, { recursive: true })
  for (const fixture of FIXTURES) {
    const filePath = path.join(fixtureDir, `${fixture.id}.png`)
    const png = encodeFixturePng(fixture.width, fixture.height)
    fs.writeFileSync(filePath, png)
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { outDir: DEFAULT_OUTDIR }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--outdir') {
      options.outDir = path.resolve(argv[(index += 1)])
    } else if (argument === '--help' || argument === '-h') {
      options.help = true
    } else {
      throw new Error(`未知参数: ${argument}`)
    }
  }
  return options
}

const USAGE = `R0-06 产品真实 print.html PDF 对照用例生成器
用法: node scripts/rust/pdf-product-cases.js [--outdir <dir>]
默认产物目录: .tmp-r0-pdf/product（gitignore）`

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(USAGE)
    return
  }
  const manifest = buildManifest(options.outDir)
  const manifestPath = path.join(options.outDir, 'product-cases.json')
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  console.log(`[ok] manifest: ${manifestPath} (${fs.statSync(manifestPath).size} B)`)
  console.log(`[ok] print.html sha256=${manifest.sourceHashes.printPage.sha256}`)
  console.log(`[ok] tokens.css sha256=${manifest.sourceHashes.tokensCss.sha256}`)
  for (const item of manifest.cases) {
    const paper = item.paper
    const paperText = paper.pageSize === 'A4'
      ? `A4${paper.landscape ? '-landscape' : '-portrait'}`
      : `${paper.pageSize.width}x${paper.pageSize.height}in`
    const clampText = paper.clamped
      ? ` clamped(requested=${paper.requestedPageSizeMicrons.height / manifest.constants.micronsPerInch}in)`
      : ''
    console.log(
      `[case] ${item.name}: ${item.kind} mode=${item.mode} dpi=${item.dpi} paper=${paperText}` +
      ` scale=${paper.scale} inject=${item.inject} window=${item.windowSize.width}x${item.windowSize.height}` +
      ` steps=${item.steps.length} expectedPages=${item.expected.pdfPages}${clampText}`
    )
  }
  for (const control of manifest.controls) {
    console.log(`[control] ${control.name}: ${control.function} -> ${control.targetCase} (${control.images.length} image(s))`)
  }
}

if (require.main === module) {
  main()
}

module.exports = {
  A4_ELECTRON_INCHES,
  CASE_SPECS,
  CONTROL_SPECS,
  DEFAULT_OUTDIR,
  FIXTURES,
  MANIFEST_SCHEMA,
  PATHS,
  buildManifest,
  encodeFixturePng,
  ensureFixtures
}
