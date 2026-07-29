const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { app, screen } = require('electron')

const RESULT_PREFIX = 'HIGHLIGHTER_RUNTIME_PROBE='
const projectRoot = path.resolve(__dirname, '..')
const requireNativeRuntime = process.env.HIGHLIGHTER_REQUIRE_NATIVE_RUNTIME === '1'
const probeDataRoot = process.env.HIGHLIGHTER_RUNTIME_PROBE_DATA_ROOT
  ? path.resolve(process.env.HIGHLIGHTER_RUNTIME_PROBE_DATA_ROOT)
  : path.join(os.tmpdir(), `highlighter-runtime-probe-${process.pid}`)

app.disableHardwareAcceleration()
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
  const sidecarPath = path.join(projectRoot, 'native', 'ocr', 'HighlighterOcrSidecar.exe')
  const onnxRuntimePath = path.join(projectRoot, 'native', 'ocr', 'onnxruntime.dll')
  const modelDir = path.join(projectRoot, 'ocr', 'models', 'ppocr-v4-ch')
  const ffmpegPath = require('ffmpeg-static')
  const nativeFiles = {
    smartSelect: fileStatus(smartSelectPath),
    ocrSidecar: fileStatus(sidecarPath),
    onnxRuntime: fileStatus(onnxRuntimePath),
    ffmpeg: fileStatus(ffmpegPath)
  }

  const nativeRuntimeBuilt = nativeFiles.smartSelect.exists
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
        pngBytes: sharpBuffer.length
      }
    },
    components: {
      ...nativeFiles,
      nativeRuntimeBuilt,
      ocrFilesValidated
    },
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
