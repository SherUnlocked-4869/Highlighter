'use strict'

// R0-06：Electron 侧 PDF 打印探针（与 WebView2 PrintToPdfStream 对照）。
//
// 同一份合成 HTML 由 Tauri 原型（WebView2）与 Electron 各打印一次，产物写到
// .tmp-r0-pdf/，再由开头的分析脚本用 pypdf 对比页数/MediaBox/字体/文字抽取。
//
// 运行（仓库根目录，注意 AGENTS.md 的两个 Electron 陷阱）：
//   env -u ELECTRON_RUN_AS_NODE \
//     TMP=$PWD/.tmp-r0-pdf/tmp TEMP=$PWD/.tmp-r0-pdf/tmp \
//     node_modules/electron/dist/electron.exe --no-sandbox scripts/rust/probe-electron-pdf.js
// `--no-sandbox` 必须放在脚本路径之前；ELECTRON_RUN_AS_NODE 必须清除，否则 app 为 undefined。
//
// 参数：
//   --outdir <dir>   产物目录，默认 <repo>/.tmp-r0-pdf
//   --ui-dir <dir>   样例 HTML 目录，默认 rust-app/prototypes/webview-pdf-resource/prototype-ui
//   --cases <list>   逗号分隔 case 名（默认全部）
//   --help
//
// 退出码：0 全部成功；3 有 case 失败；4 超时；2 参数错误。

const fs = require('fs')
const path = require('path')
const { app, BrowserWindow } = require('electron')

const ROOT = path.resolve(__dirname, '..', '..')
const DEFAULT_UI_DIR = path.join(ROOT, 'rust-app', 'prototypes', 'webview-pdf-resource', 'prototype-ui')
const DEFAULT_OUT_DIR = path.join(ROOT, '.tmp-r0-pdf')
const HARD_TIMEOUT_MS = 120000

// 打印配置与 WebView2 侧一一对应（见 docs/plans/rust-migration/r0-pdf-spike.md 的矩阵）。
// pageSize 单位是英寸（基线 main/services/pdf-export.js:22-30 的实测结论）。
const A4_INCHES = { width: 8.267716535, height: 11.692913386 }
const A4_MARGIN_15MM_INCHES = 15 / 25.4
const CASES = [
  {
    name: 'e0-default-options',
    html: 'print-sample.html',
    note: 'Electron printToPDF 默认参数（对照 WebView2 默认 PrintSettings）',
    options: {}
  },
  {
    name: 'e1-a4-margin0-bg',
    html: 'print-sample.html',
    note: 'A4、零边距、打印背景（产品 pdf-export.js 的 A4 档等价参数）',
    options: {
      pageSize: 'A4',
      landscape: false,
      printBackground: true,
      margins: { marginType: 'none', top: 0, bottom: 0, left: 0, right: 0 },
      preferCSSPageSize: false,
      scale: 1
    }
  },
  {
    name: 'e1b-a4-custom-inches',
    html: 'print-sample.html',
    note: 'A4 尺寸用自定义英寸值（595.92×842.88pt 反推）传给 Electron，验证与 WebView2 单位等价',
    options: {
      pageSize: { width: 595.92 / 72, height: 842.88 / 72 },
      landscape: false,
      printBackground: true,
      margins: { marginType: 'none', top: 0, bottom: 0, left: 0, right: 0 },
      preferCSSPageSize: false,
      scale: 1
    }
  },
  {
    name: 'e4-a4-margin0-nobg',
    html: 'print-sample.html',
    note: '同上但 printBackground=false（透明/半透明元素对照）',
    options: {
      pageSize: 'A4',
      landscape: false,
      printBackground: false,
      margins: { marginType: 'none', top: 0, bottom: 0, left: 0, right: 0 },
      preferCSSPageSize: false,
      scale: 1
    }
  },
  {
    name: 'e3-custom-paper-6.25x4.166667in',
    html: 'print-sample.html',
    note: '自定义纸张（基线实测的英寸单位；6.25in × 4.166667in）',
    options: {
      pageSize: { width: 6.25, height: 4.166667 },
      landscape: false,
      printBackground: true,
      margins: { marginType: 'none', top: 0, bottom: 0, left: 0, right: 0 },
      preferCSSPageSize: false,
      scale: 1
    }
  },
  {
    name: 'e5-a4-settings-margins-15mm',
    html: 'print-sample.html',
    note: 'A4 + 四边 15mm 引擎边距（对照 WebView2 PrintSettings.Margin* 语义）',
    options: {
      pageSize: 'A4',
      landscape: false,
      printBackground: true,
      margins: {
        marginType: 'custom',
        top: A4_MARGIN_15MM_INCHES,
        bottom: A4_MARGIN_15MM_INCHES,
        left: A4_MARGIN_15MM_INCHES,
        right: A4_MARGIN_15MM_INCHES
      },
      preferCSSPageSize: false,
      scale: 1
    }
  },
  {
    name: 'e3a-custom-paper-landscape',
    html: 'print-sample.html',
    note: '自定义纸张 + landscape=true（观察是否二次旋转/交换宽高）',
    options: {
      pageSize: { width: 6.25, height: 4.166667 },
      landscape: true,
      printBackground: true,
      margins: { marginType: 'none', top: 0, bottom: 0, left: 0, right: 0 },
      preferCSSPageSize: false,
      scale: 1
    }
  },
  {
    name: 'e3b-custom-paper-swapped',
    html: 'print-sample.html',
    note: '自定义纸张把宽高对调（4.166667in × 6.25in）',
    options: {
      pageSize: { width: 4.166667, height: 6.25 },
      landscape: false,
      printBackground: true,
      margins: { marginType: 'none', top: 0, bottom: 0, left: 0, right: 0 },
      preferCSSPageSize: false,
      scale: 1
    }
  },
  {
    name: 'e3c-microns-page-size',
    html: 'print-sample.html',
    note: '按基线旧口径把微米数值直接当 pageSize 传（预期失败或产生极小纸张）',
    options: {
      pageSize: { width: 158750, height: 105833 },
      landscape: false,
      printBackground: true,
      margins: { marginType: 'none', top: 0, bottom: 0, left: 0, right: 0 },
      preferCSSPageSize: false,
      scale: 1
    }
  },
  {
    name: 'e6-plain-a4-margin0',
    html: 'print-plain.html',
    note: '无 @page 规则的对照 HTML + A4/零边距（隔离 CSS 纸张规则）',
    options: {
      pageSize: 'A4',
      landscape: false,
      printBackground: true,
      margins: { marginType: 'none', top: 0, bottom: 0, left: 0, right: 0 },
      preferCSSPageSize: false,
      scale: 1
    }
  },
  {
    name: 'e7-plain-custom-paper',
    html: 'print-plain.html',
    note: '无 @page 规则的对照 HTML + 自定义纸张（验证分页是否随纸张变化）',
    options: {
      pageSize: { width: 6.25, height: 4.166667 },
      landscape: false,
      printBackground: true,
      margins: { marginType: 'none', top: 0, bottom: 0, left: 0, right: 0 },
      preferCSSPageSize: false,
      scale: 1
    }
  },
  {
    name: 'e8-sample-preferCSSPageSize',
    html: 'print-sample.html',
    note: '@page A4/0 的样例 + preferCSSPageSize=true（让 CSS 决定纸张）',
    options: {
      printBackground: true,
      preferCSSPageSize: true,
      margins: { marginType: 'none', top: 0, bottom: 0, left: 0, right: 0 },
      scale: 1
    }
  },
  {
    name: 'e9-plain-a4-settings-margins-15mm',
    html: 'print-plain.html',
    note: '无 @page 规则 + A4 + 引擎 margins 15mm（验证 margins 参数是否生效）',
    options: {
      pageSize: 'A4',
      landscape: false,
      printBackground: true,
      margins: {
        marginType: 'custom',
        top: A4_MARGIN_15MM_INCHES,
        bottom: A4_MARGIN_15MM_INCHES,
        left: A4_MARGIN_15MM_INCHES,
        right: A4_MARGIN_15MM_INCHES
      },
      preferCSSPageSize: false,
      scale: 1
    }
  },
  {
    name: 'e2a-csspage-preferCSSPageSize',
    html: 'print-sample-csspage.html',
    note: 'HTML 自带 @page A4/15mm；preferCSSPageSize=true（让 CSS 决定纸张/边距）',
    options: {
      printBackground: true,
      preferCSSPageSize: true,
      margins: { marginType: 'none', top: 0, bottom: 0, left: 0, right: 0 },
      scale: 1
    }
  },
  {
    name: 'e2b-csspage-a4-margin0',
    html: 'print-sample-csspage.html',
    note: 'HTML 自带 @page A4/15mm 但 preferCSSPageSize=false + 引擎纸张 A4/零边距',
    options: {
      pageSize: 'A4',
      landscape: false,
      printBackground: true,
      margins: { marginType: 'none', top: 0, bottom: 0, left: 0, right: 0 },
      preferCSSPageSize: false,
      scale: 1
    }
  }
]

function parseArgs(argv) {
  const options = { outDir: DEFAULT_OUT_DIR, uiDir: DEFAULT_UI_DIR, cases: null, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') {
      options.help = true
    } else if (argument === '--outdir') {
      options.outDir = path.resolve(argv[(index += 1)])
    } else if (argument === '--ui-dir') {
      options.uiDir = path.resolve(argv[(index += 1)])
    } else if (argument === '--cases') {
      options.cases = String(argv[(index += 1)] || '')
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean)
    } else {
      throw new Error(`未知参数: ${argument}`)
    }
  }
  return options
}

const USAGE = `R0-06 Electron PDF 打印探针
用法: electron --no-sandbox scripts/rust/probe-electron-pdf.js [--outdir <dir>] [--ui-dir <dir>] [--cases a,b]`

async function waitForPageReady(win) {
  // 页面脚本（print-ready.js）在 load + 字体/图片解码后设置 __PDF_SAMPLE_READY__。
  const payload = await win.webContents.executeJavaScript(
    `new Promise((resolve, reject) => {
      const started = Date.now()
      const poll = () => {
        if (window.__PDF_SAMPLE_READY__) return resolve(window.__PDF_SAMPLE_READY__)
        if (Date.now() - started > 20000) return reject(new Error('page ready timeout 20000 ms'))
        setTimeout(poll, 50)
      }
      poll()
    })`
  )
  return payload
}

// Electron 主进程的 process.argv 里同时有 Chromium 开关（如 --no-sandbox）和脚本路径，
// 不能像纯 node 那样固定 slice(2)：先定位脚本路径，再取它后面的参数。
function userArguments() {
  const argv = process.argv.slice(1)
  const scriptIndex = argv.findIndex((argument) => String(argument).endsWith('.js'))
  return scriptIndex >= 0 ? argv.slice(scriptIndex + 1) : []
}

async function main() {
  const options = parseArgs(userArguments())
  if (options.help) {
    console.log(USAGE)
    app.exit(0)
    return
  }
  const timeout = setTimeout(() => {
    console.error('[FAIL] probe hard timeout')
    app.exit(4)
  }, HARD_TIMEOUT_MS)
  timeout.unref()

  fs.mkdirSync(options.outDir, { recursive: true })
  fs.mkdirSync(path.join(options.outDir, 'tmp'), { recursive: true })
  fs.mkdirSync(path.join(options.outDir, 'electron-user-data'), { recursive: true })
  fs.mkdirSync(path.join(options.outDir, 'electron-session-data'), { recursive: true })

  app.setPath('userData', path.join(options.outDir, 'electron-user-data'))
  app.setPath('sessionData', path.join(options.outDir, 'electron-session-data'))
  app.setPath('logs', path.join(options.outDir, 'electron-logs'))
  app.disableHardwareAcceleration()

  await app.whenReady()

  const report = {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    uiDir: options.uiDir,
    outDir: options.outDir,
    cases: [],
    errors: [],
    startedAt: new Date().toISOString()
  }

  const selected = options.cases ? CASES.filter((item) => options.cases.includes(item.name)) : CASES
  if (selected.length === 0) {
    report.errors.push('没有匹配的 case')
    fs.writeFileSync(path.join(options.outDir, 'electron-report.json'), JSON.stringify(report, null, 2))
    console.error('[FAIL] no case selected')
    app.exit(2)
    return
  }

  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 900,
    backgroundColor: '#ffffff',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      offscreen: false
    }
  })
  win.setMenuBarVisibility(false)

  let currentHtml = null
  try {
    for (const item of selected) {
      const htmlPath = path.join(options.uiDir, item.html)
      const outcome = {
        name: item.name,
        html: item.html,
        note: item.note,
        options: item.options,
        file: null,
        bytes: 0,
        elapsedMs: null,
        ready: null,
        error: null
      }
      try {
        if (currentHtml !== item.html) {
          await win.loadFile(htmlPath)
          currentHtml = item.html
        }
        outcome.ready = await waitForPageReady(win)
        const started = Date.now()
        const pdf = await win.webContents.printToPDF(item.options || {})
        outcome.elapsedMs = Date.now() - started
        outcome.bytes = pdf.length
        const fileName = `electron-${item.name}.pdf`
        const filePath = path.join(options.outDir, fileName)
        fs.writeFileSync(filePath, pdf)
        outcome.file = filePath
        console.log(`[ok] ${item.name}: ${pdf.length} bytes, ${outcome.elapsedMs} ms -> ${path.basename(filePath)}`)
      } catch (error) {
        outcome.error = String((error && error.message) || error)
        report.errors.push(`${item.name}: ${outcome.error}`)
        console.error(`[FAIL] ${item.name}: ${outcome.error}`)
      }
      report.cases.push(outcome)
    }
    report.finishedAt = new Date().toISOString()
    fs.writeFileSync(path.join(options.outDir, 'electron-report.json'), JSON.stringify(report, null, 2))
  } finally {
    try {
      win.destroy()
    } catch {}
  }

  const failures = report.cases.filter((item) => item.error || !item.bytes)
  clearTimeout(timeout)
  console.log(
    failures.length === 0
      ? `[PASS] electron pdf probe: ${report.cases.length} case(s), electron=${report.electron} chrome=${report.chrome}`
      : `[FAIL] electron pdf probe: ${failures.length}/${report.cases.length} case(s) failed`
  )
  app.exit(failures.length === 0 ? 0 : 3)
}

main().catch((error) => {
  console.error(`[FAIL] probe crashed: ${(error && error.stack) || error}`)
  app.exit(5)
})
