const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { app, BrowserWindow, ipcMain, screen } = require('electron')
const { buildIpcPolicies, createSecureIpcMain } = require('../main/services/ipc-security')
const { createSecureWebPreferences, createSecureWindow } = require('../main/services/window-security')

const RESULT_PREFIX = 'HIGHLIGHTER_RUNTIME_PROBE='
const projectRoot = path.resolve(__dirname, '..')
const requireNativeRuntime = process.env.HIGHLIGHTER_REQUIRE_NATIVE_RUNTIME === '1'
const probeDataRoot = process.env.HIGHLIGHTER_RUNTIME_PROBE_DATA_ROOT
  ? path.resolve(process.env.HIGHLIGHTER_RUNTIME_PROBE_DATA_ROOT)
  : path.join(os.tmpdir(), `highlighter-runtime-probe-${process.pid}`)

app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})
fs.mkdirSync(probeDataRoot, { recursive: true })
app.setPath('userData', probeDataRoot)

function fileStatus(filePath) {
  const exists = fs.existsSync(filePath)
  return {
    exists,
    name: path.basename(filePath),
    size: exists ? fs.statSync(filePath).size : 0
  }
}

async function probeSandboxPreloads() {
  const contracts = [
    ['preload.js', 'electronAPI'],
    ['preload-action.js', 'electronAPI'],
    ['preload-toolbar.js', 'toolbarAPI'],
    ['preload-capture.js', 'captureAPI'],
    ['preload-long-capture.js', 'longCaptureAPI'],
    ['preload-long-overlay.js', 'longOverlayAPI'],
    ['preload-pin.js', 'pinAPI'],
    ['preload-recognition.js', 'recognitionAPI'],
    ['preload-record.js', 'recordAPI'],
    ['preload-record-frame.js', 'recordFrameAPI']
  ]
  const results = []
  for (const [preloadName, globalName] of contracts) {
    const win = new BrowserWindow({
      show: false,
      webPreferences: createSecureWebPreferences({
        preload: path.join(projectRoot, preloadName)
      })
    })
    try {
      await win.loadURL('data:text/html,<meta charset="utf-8"><title>preload probe</title>')
      const exposedKeys = await win.webContents.executeJavaScript(
        `Object.keys(globalThis[${JSON.stringify(globalName)}] || {})`
      )
      if (!exposedKeys.length) throw new Error(`${preloadName} did not expose ${globalName}`)
      results.push({
        preload: preloadName,
        global: globalName,
        exposedKeys: exposedKeys.length,
        sandboxed: win.webContents.getLastWebPreferences().sandbox === true
      })
    } finally {
      if (!win.isDestroyed()) win.destroy()
    }
  }
  return results
}

async function probeLocalPagePolicies() {
  const contracts = [
    ['action/action.html', 'preload-action.js'],
    ['capture/capture.html', 'preload-capture.js'],
    ['config/config.html', 'preload.js'],
    ['long-capture/long-capture.html', 'preload-long-capture.js'],
    ['long-capture/overlay.html', 'preload-long-overlay.js'],
    ['pin/pin.html', 'preload-pin.js'],
    ['recognition/recognition.html', 'preload-recognition.js'],
    ['record/frame.html', 'preload-record-frame.js'],
    ['record/record.html', 'preload-record.js'],
    ['toolbar/toolbar.html', 'preload-toolbar.js']
  ]
  const results = []
  for (const [pageName, preloadName] of contracts) {
    const consoleMessages = []
    const preloadErrors = []
    const pagePath = path.join(projectRoot, pageName)
    const win = createSecureWindow({
      BrowserWindow,
      pagePath,
      options: {
        show: false,
        webPreferences: {
          preload: path.join(projectRoot, preloadName)
        }
      }
    })
    win.webContents.on('console-message', (_event, details) => {
      const message = typeof details === 'object' ? details.message : String(details || '')
      consoleMessages.push(message)
    })
    win.webContents.on('preload-error', (_event, preloadPath, error) => {
      preloadErrors.push(`${preloadPath}: ${error?.message || String(error)}`)
    })
    try {
      await win.loadFile(pagePath)
      results.push({
        page: pageName,
        preloadErrors,
        cspMessages: consoleMessages.filter((message) => /content security policy/i.test(message))
      })
    } finally {
      if (!win.isDestroyed()) win.destroy()
    }
  }
  return results
}

async function probeActionSecurity() {
  const consoleMessages = []
  const preloadErrors = []
  const pagePath = path.join(projectRoot, 'action', 'action.html')
  const win = createSecureWindow({
    BrowserWindow,
    pagePath,
    options: {
      show: false,
      webPreferences: {
        preload: path.join(projectRoot, 'preload-action.js')
      }
    }
  })
  win.webContents.on('console-message', (_event, details) => {
    const message = typeof details === 'object' ? details.message : String(details || '')
    consoleMessages.push(message)
  })
  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    preloadErrors.push(`${preloadPath}: ${error?.message || String(error)}`)
  })
  try {
    await win.loadFile(pagePath)
    const result = await win.webContents.executeJavaScript(`(() => {
      const payload = '<img src=x onerror="globalThis.__xss=1"> [bad](javascript:alert(1)) [good](https://example.com/docs)'
      renderMarkdownResult(payload)
      const result = document.getElementById('result')
      return {
        csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content || '',
        domPurify: typeof globalThis.DOMPurify?.sanitize === 'function',
        html: result.innerHTML,
        dangerousElements: result.querySelectorAll('img,script,iframe,object,embed,form').length,
        eventAttributes: [...result.querySelectorAll('*')].flatMap((element) => [...element.attributes])
          .filter((attribute) => /^on/i.test(attribute.name)).length,
        dangerousLinks: result.querySelectorAll('a[href^="javascript:"],a[href^="file:"],a[href^="data:"]').length,
        xss: globalThis.__xss || 0
      }
    })()`)
    return {
      ...result,
      preloadErrors,
      cspMessages: consoleMessages.filter((message) => /content security policy/i.test(message))
    }
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

async function probeIpcSecurity() {
  const owners = new Map()
  const blocked = []
  const policies = buildIpcPolicies(projectRoot)
  const secureIpcMain = createSecureIpcMain({
    ipcMain,
    BrowserWindow,
    rootDirectory: projectRoot,
    authorizeRole: (role, win) => owners.get(role) === win,
    onBlocked: (entry) => blocked.push(entry)
  })
  for (const policy of policies.values()) {
    secureIpcMain[policy.kind](policy.channel, () => policy.channel)
  }
  secureIpcMain.assertComplete()

  const mainPagePath = path.join(projectRoot, 'config', 'config.html')
  const mainWindow = createSecureWindow({
    BrowserWindow,
    pagePath: mainPagePath,
    options: {
      show: false,
      webPreferences: {
        preload: path.join(projectRoot, 'preload.js')
      }
    }
  })
  owners.set('main', mainWindow)

  const crossPageWindow = createSecureWindow({
    BrowserWindow,
    pagePath: mainPagePath,
    options: {
      show: false,
      webPreferences: {
        preload: path.join(projectRoot, 'preload-capture.js')
      }
    }
  })

  try {
    await mainWindow.loadFile(mainPagePath)
    const allowedChannel = await mainWindow.webContents.executeJavaScript(
      'globalThis.electronAPI.getSettings()'
    )
    await crossPageWindow.loadFile(mainPagePath)
    const crossPageResult = await crossPageWindow.webContents.executeJavaScript(`(
      async () => {
        try {
          await globalThis.captureAPI.copy(new Uint8Array([1]), {})
          return { blocked: false, error: '' }
        } catch (error) {
          return { blocked: true, error: error.message || String(error) }
        }
      }
    )()`)
    return {
      policyCount: policies.size,
      allowedChannel,
      crossPageResult,
      blockedReasons: blocked.map(({ reason }) => reason)
    }
  } finally {
    owners.clear()
    for (const win of [mainWindow, crossPageWindow]) {
      if (!win.isDestroyed()) win.destroy()
    }
  }
}

async function probeRuntime() {
  const SelectionHook = require('selection-hook')
  const selectionHook = new SelectionHook()
  const selectionHookRunning = selectionHook.isRunning()
  selectionHook.cleanup()

  const sharp = require('sharp')
  const sharpBuffer = await sharp({
    create: {
      width: 2,
      height: 2,
      channels: 4,
      background: { r: 20, g: 40, b: 60, alpha: 1 }
    }
  }).png().toBuffer()

  const smartSelectPath = path.join(projectRoot, 'native', 'smart-select', 'SmartSelect.exe')
  const scrollDriverPath = path.join(projectRoot, 'native', 'scroll-driver', 'ScrollDriver.exe')
  const sidecarPath = path.join(projectRoot, 'native', 'ocr', 'HighlighterOcrSidecar.exe')
  const onnxRuntimePath = path.join(projectRoot, 'native', 'ocr', 'onnxruntime.dll')
  const modelDir = path.join(projectRoot, 'ocr', 'models', 'ppocr-v4-ch')
  const ffmpegPath = require('ffmpeg-static')
  const nativeFiles = {
    smartSelect: fileStatus(smartSelectPath),
    scrollDriver: fileStatus(scrollDriverPath),
    ocrSidecar: fileStatus(sidecarPath),
    onnxRuntime: fileStatus(onnxRuntimePath),
    ffmpeg: fileStatus(ffmpegPath)
  }

  const nativeRuntimeBuilt = nativeFiles.smartSelect.exists
    && nativeFiles.scrollDriver.exists
    && nativeFiles.ocrSidecar.exists
    && nativeFiles.onnxRuntime.exists
  let ocrFilesValidated = false
  if (nativeRuntimeBuilt) {
    const { OcrService } = require('../main/services/ocr-service')
    const service = new OcrService({
      tempDir: path.join(os.tmpdir(), 'highlighter-runtime-probe'),
      sidecarPath,
      modelDir
    })
    service.validateFiles()
    ocrFilesValidated = true
  } else if (requireNativeRuntime) {
    const missing = Object.entries(nativeFiles)
      .filter(([name, status]) => name !== 'ffmpeg' && !status.exists)
      .map(([, status]) => status.name)
    throw new Error(`Native runtime is incomplete: ${missing.join(', ')}`)
  }

  if (!nativeFiles.ffmpeg.exists) throw new Error('FFmpeg runtime is missing')
  const preloads = await probeSandboxPreloads()
  const localPages = await probeLocalPagePolicies()
  const actionSecurity = await probeActionSecurity()
  const ipcSecurity = await probeIpcSecurity()

  return {
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      v8: process.versions.v8
    },
    platform: {
      name: process.platform,
      arch: process.arch
    },
    modules: {
      selectionHook: {
        loaded: true,
        initiallyRunning: selectionHookRunning
      },
      sharp: {
        loaded: true,
        version: sharp.versions.sharp,
        libvipsVersion: sharp.versions.vips,
        pngBytes: sharpBuffer.length
      }
    },
    components: {
      ...nativeFiles,
      nativeRuntimeBuilt,
      ocrFilesValidated
    },
    preloads,
    localPages,
    actionSecurity,
    ipcSecurity,
    displays: screen.getAllDisplays().map((display) => ({
      bounds: display.bounds,
      workArea: display.workArea,
      scaleFactor: display.scaleFactor,
      rotation: display.rotation
    }))
  }
}

let completed = false
const timeout = setTimeout(() => {
  if (completed) return
  completed = true
  console.error('Electron runtime probe timed out')
  app.exit(1)
}, 30000)

app.whenReady()
  .then(probeRuntime)
  .then((result) => {
    if (completed) return
    completed = true
    clearTimeout(timeout)
    process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(result)}\n`)
    app.exit(0)
  })
  .catch((error) => {
    if (completed) return
    completed = true
    clearTimeout(timeout)
    console.error(error.stack || error.message || String(error))
    app.exit(1)
  })
