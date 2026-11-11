'use strict'

// R0-06 产品真实 capture/print.html PDF 对照探针（Electron 后端）。
//
// 与 WebView2 侧共用 .tmp-r0-pdf/product/product-cases.json（由
// scripts/rust/pdf-product-cases.js 调用产品 main/services/pdf-export.js 生成）：
//
//   - 纸张参数：manifest 的 `electronOptions` 就是产品 buildPrintOptions() 的返回值；
//   - DOM 注入：manifest 的 `steps[].script` 就是产品 buildImageInjectionScript() /
//     buildPagesSetupScript() / buildPageAppendScript() 生成的脚本文本 —— 本探针用
//     executeJavaScript 执行它，WebView2 原型用 ExecuteScript 执行同一段文本；
//   - 窗口：逐项复刻产品 openPrintWindow()（隐藏窗口、preload-capture.js、
//     backgroundThrottling:false、paintWhenInitiallyHidden:true、clampWindowSize）；
//   - 就绪：loadFile 完成后逐步执行产品脚本，再用观察脚本轮询 DOM（图片 decode/追加完成），
//     不依赖页面脚本（真实 print.html 没有任何 <script>）；
//   - x1/x2 对照：直接调用产品 exportPdfBuffer() / exportPagesToPdfBuffer() 生成 PDF，
//     用来证明"手工注入流程 == 产品函数路径"。
//
// 运行（仓库根目录；AGENTS.md 的三个 Electron 陷阱）：
//   $env:ELECTRON_RUN_AS_NODE = $null
//   $env:TMP = "$PWD/.tmp-r0-pdf/tmp"; $env:TEMP = $env:TMP
//   node_modules/electron/dist/electron.exe --no-sandbox scripts/rust/probe-electron-product-pdf.js
// `--no-sandbox` 必须在脚本路径之前；ELECTRON_RUN_AS_NODE 必须清除，否则 app 为 undefined。
//
// 参数：
//   --manifest <json>  用例 manifest（默认 .tmp-r0-pdf/product/product-cases.json）
//   --outdir <dir>     产物目录（默认 .tmp-r0-pdf/product）
//   --cases <list>     逗号分隔 case/control 名（默认全部）
//   --help
//
// 退出码：0 全部成功；2 参数错误；3 有 case 失败；4 硬超时；5 崩溃。

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const { app, BrowserWindow } = require('electron')

const ROOT = path.resolve(__dirname, '..', '..')
const DEFAULT_OUTDIR = path.join(ROOT, '.tmp-r0-pdf', 'product')
const DEFAULT_MANIFEST = path.join(DEFAULT_OUTDIR, 'product-cases.json')
const HARD_TIMEOUT_MS = 240000
const DEFAULT_STEP_POLL_TIMEOUT_MS = 30000

const product = require('../../main/services/pdf-export.js')
const { createSecureWindow } = require('../../main/services/window-security.js')

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function messageOf(error) {
  return String((error && error.stack) || (error && error.message) || error)
}

// 进度同步落盘：探针在受限宿主里可能被宿主判为"已返回"（GUI 子进程），事后只能靠
// 这个文件判断卡在哪个 case/步骤。
let progressLogPath = null
function progress(message) {
  const line = `[${new Date().toISOString()}] ${message}`
  console.log(line)
  if (!progressLogPath) return
  try {
    fs.appendFileSync(progressLogPath, `${line}\n`)
  } catch {}
}

function parseArgs(argv) {
  const options = { outDir: DEFAULT_OUTDIR, manifestPath: DEFAULT_MANIFEST, cases: null, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') {
      options.help = true
    } else if (argument === '--outdir') {
      options.outDir = path.resolve(argv[(index += 1)])
    } else if (argument === '--manifest') {
      options.manifestPath = path.resolve(argv[(index += 1)])
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

const USAGE = `R0-06 产品真实 print.html PDF 对照探针（Electron）
用法: electron --no-sandbox scripts/rust/probe-electron-product-pdf.js [--manifest <json>] [--outdir <dir>] [--cases a,b]`

// Electron 主进程 process.argv 里同时有 Chromium 开关与脚本路径，先定位脚本路径再取用户参数。
function userArguments() {
  const argv = process.argv.slice(1)
  const scriptIndex = argv.findIndex((argument) => String(argument).endsWith('.js'))
  return scriptIndex >= 0 ? argv.slice(scriptIndex + 1) : []
}

// 产品 openPrintWindow() 的参数（show:false 隐藏窗口；windowSize 由 clampWindowSize 决定）。
function productWindowOptions(caseItem, manifest) {
  return {
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
    width: caseItem.windowSize.width,
    height: caseItem.windowSize.height,
    webPreferences: {
      preload: manifest.paths.preloadCapture,
      backgroundThrottling: false
    }
  }
}

function createPrintWindow(caseItem, manifest) {
  return createSecureWindow({
    BrowserWindow,
    pagePath: manifest.paths.printPage,
    options: productWindowOptions(caseItem, manifest)
  })
}

async function poll(win, script, timeoutMs) {
  const started = Date.now()
  let last = null
  let lastError = null
  while (Date.now() - started < timeoutMs) {
    try {
      last = await win.webContents.executeJavaScript(script)
      if (last) return { ok: true, value: last, elapsedMs: Date.now() - started }
    } catch (error) {
      lastError = messageOf(error)
    }
    await delay(100)
  }
  return { ok: false, value: last, error: lastError, elapsedMs: Date.now() - started }
}

async function runCase(item, manifest, outDir) {
  const outcome = {
    name: item.name,
    kind: item.kind,
    description: item.description,
    mode: item.mode,
    dpi: item.dpi,
    inject: item.inject,
    paper: item.paper,
    electronOptions: item.electronOptions,
    rustOptions: item.rustOptions,
    windowSize: item.windowSize,
    loadMs: null,
    printMs: null,
    elapsedMs: null,
    bytes: 0,
    file: null,
    domBeforeSteps: null,
    domAfterSteps: null,
    steps: [],
    error: null
  }
  const started = Date.now()
  const win = createPrintWindow(item, manifest)
  try {
    const loadStarted = Date.now()
    progress(`[case] ${item.name}: loadFile ${manifest.paths.printPage}`)
    await win.loadFile(manifest.paths.printPage)
    outcome.loadMs = Date.now() - loadStarted
    progress(`[case] ${item.name}: loaded in ${outcome.loadMs}ms, running ${item.steps.length} step(s)`)
    outcome.domBeforeSteps = await win.webContents.executeJavaScript(item.domProbeScript)
    for (const step of item.steps) {
      const stepStarted = Date.now()
      const record = {
        kind: step.kind,
        index: step.index,
        elapsedMs: null,
        value: null,
        error: null,
        poll: null
      }
      try {
        record.value = await win.webContents.executeJavaScript(step.script)
      } catch (error) {
        record.error = messageOf(error)
      }
      if (!record.error && step.pollScript) {
        record.poll = await poll(win, step.pollScript, step.pollTimeoutMs || DEFAULT_STEP_POLL_TIMEOUT_MS)
      }
      record.elapsedMs = Date.now() - stepStarted
      outcome.steps.push(record)
      progress(
        `[case] ${item.name}: step ${step.kind}#${step.index} ${record.elapsedMs}ms ` +
        `poll=${record.poll ? record.poll.ok : 'n/a'} error=${record.error || '-'}`
      )
      if (record.error || (record.poll && !record.poll.ok)) {
        throw new Error(`步骤失败 ${step.kind}#${step.index}: ${record.error || 'DOM 轮询超时'}`)
      }
    }
    outcome.domAfterSteps = await win.webContents.executeJavaScript(item.domProbeScript)
    const printStarted = Date.now()
    progress(`[case] ${item.name}: printToPDF start (${JSON.stringify(item.electronOptions.pageSize)})`)
    const pdf = await win.webContents.printToPDF(item.electronOptions)
    outcome.printMs = Date.now() - printStarted
    outcome.bytes = pdf.length
    outcome.file = path.join(outDir, `electron-${item.name}.pdf`)
    fs.writeFileSync(outcome.file, pdf)
    progress(`[case] ${item.name}: printToPDF done in ${outcome.printMs}ms, ${outcome.bytes} B`)
  } catch (error) {
    outcome.error = messageOf(error)
    progress(`[case] ${item.name}: FAIL ${outcome.error}`)
  } finally {
    try {
      win.destroy()
    } catch {}
  }
  outcome.elapsedMs = Date.now() - started
  return outcome
}

async function runControl(control, manifest, outDir) {
  const outcome = {
    name: control.name,
    description: control.description,
    function: control.function,
    targetCase: control.targetCase,
    mode: control.mode,
    dpi: control.dpi,
    imageCount: control.images.length,
    printOptionsSeen: [],
    elapsedMs: null,
    bytes: 0,
    file: null,
    error: null
  }
  const started = Date.now()
  const printToPdf = (win, printOptions) => {
    outcome.printOptionsSeen.push({ ...printOptions })
    return win.webContents.printToPDF(printOptions)
  }
  try {
    let pdf = null
    if (control.function === 'exportPdfBuffer') {
      const image = control.images[0]
      pdf = await product.exportPdfBuffer(fs.readFileSync(image.path), {
        pxW: image.pxW,
        pxH: image.pxH,
        dpi: image.dpi,
        mode: control.mode,
        printToPdf,
        log: (...args) => console.log('[product-export]', ...args)
      })
    } else if (control.function === 'exportPagesToPdfBuffer') {
      const pages = control.images.map((image) => ({
        buffer: fs.readFileSync(image.path),
        pxW: image.pxW,
        pxH: image.pxH,
        dpi: image.dpi
      }))
      pdf = await product.exportPagesToPdfBuffer(pages, {
        dpi: control.dpi,
        maxPages: control.maxPages,
        printToPdf,
        log: (...args) => console.log('[product-export]', ...args)
      })
    } else {
      throw new Error(`未知 control.function: ${control.function}`)
    }
    outcome.bytes = pdf.length
    outcome.file = path.join(outDir, `electron-${control.name}.pdf`)
    fs.writeFileSync(outcome.file, pdf)
  } catch (error) {
    outcome.error = messageOf(error)
  }
  outcome.elapsedMs = Date.now() - started
  return outcome
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

  const manifest = JSON.parse(fs.readFileSync(options.manifestPath, 'utf8'))
  fs.mkdirSync(options.outDir, { recursive: true })
  fs.mkdirSync(path.join(options.outDir, 'tmp'), { recursive: true })
  fs.mkdirSync(path.join(options.outDir, 'logs'), { recursive: true })
  fs.mkdirSync(path.join(options.outDir, 'electron-user-data'), { recursive: true })
  fs.mkdirSync(path.join(options.outDir, 'electron-session-data'), { recursive: true })
  progressLogPath = path.join(options.outDir, 'logs', 'electron-probe-progress.log')
  fs.writeFileSync(progressLogPath, '')
  process.on('uncaughtException', (error) => {
    progress(`[FAIL] uncaughtException: ${messageOf(error)}`)
    app.exit(5)
  })
  process.on('unhandledRejection', (error) => {
    progress(`[FAIL] unhandledRejection: ${messageOf(error)}`)
    app.exit(5)
  })

  app.setPath('userData', path.join(options.outDir, 'electron-user-data'))
  app.setPath('sessionData', path.join(options.outDir, 'electron-session-data'))
  app.setPath('logs', path.join(options.outDir, 'electron-logs'))
  app.disableHardwareAcceleration()
  // 每个 case 结束都会销毁隐藏打印窗口（产品语义）；没有这条监听时 Electron 在
  // 第一个 case 后就会因 window-all-closed 默认退出，后面的 case 与报告全部丢失。
  app.on('window-all-closed', () => {})

  await app.whenReady()

  const report = {
    backend: 'electron',
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    manifestPath: options.manifestPath,
    manifestSchema: manifest.schema,
    printPage: manifest.sourceHashes.printPage,
    tokensCss: manifest.sourceHashes.tokensCss,
    preloadCapture: manifest.sourceHashes.preloadCapture,
    outDir: options.outDir,
    startedAt: new Date().toISOString(),
    cases: [],
    controls: [],
    errors: []
  }

  const selectedCases = options.cases
    ? manifest.cases.filter((item) => options.cases.includes(item.name))
    : manifest.cases
  const selectedControls = options.cases
    ? manifest.controls.filter((item) => options.cases.includes(item.name))
    : manifest.controls
  if (selectedCases.length === 0 && selectedControls.length === 0) {
    report.errors.push('没有匹配的 case/control')
    fs.writeFileSync(path.join(options.outDir, 'electron-product-report.json'), JSON.stringify(report, null, 2))
    console.error('[FAIL] no case selected')
    app.exit(2)
    return
  }

  for (const item of selectedCases) {
    progress(`[run] case ${item.name}`)
    const outcome = await runCase(item, manifest, options.outDir)
    report.cases.push(outcome)
    if (outcome.error) {
      report.errors.push(`${outcome.name}: ${outcome.error}`)
      progress(`[FAIL] ${outcome.name}: ${outcome.error}`)
    } else {
      progress(
        `[ok] ${outcome.name}: ${outcome.bytes} B, load=${outcome.loadMs}ms print=${outcome.printMs}ms, ` +
        `steps=${outcome.steps.length} -> ${path.basename(outcome.file)}`
      )
    }
  }
  for (const control of selectedControls) {
    progress(`[run] control ${control.name}`)
    const outcome = await runControl(control, manifest, options.outDir)
    report.controls.push(outcome)
    if (outcome.error) {
      report.errors.push(`${outcome.name}: ${outcome.error}`)
      progress(`[FAIL] ${outcome.name}: ${outcome.error}`)
    } else {
      progress(`[ok] ${outcome.name}: ${outcome.bytes} B, ${outcome.elapsedMs}ms -> ${path.basename(outcome.file)}`)
    }
  }

  report.finishedAt = new Date().toISOString()
  const reportPath = path.join(options.outDir, 'electron-product-report.json')
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
  console.log(`[report] ${reportPath}`)

  const failures = report.errors.length
  clearTimeout(timeout)
  console.log(
    failures === 0
      ? `[PASS] electron product pdf probe: ${report.cases.length} case(s) + ${report.controls.length} control(s), electron=${report.electron} chrome=${report.chrome}`
      : `[FAIL] electron product pdf probe: ${failures} failure(s)`
  )
  app.exit(failures === 0 ? 0 : 3)
}

main().catch((error) => {
  console.error(`[FAIL] probe crashed: ${messageOf(error)}`)
  app.exit(5)
})
