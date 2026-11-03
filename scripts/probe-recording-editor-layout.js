// Electron layout probe for the standalone recording editor window (contract §11).
//
// The old probe measured record.html's preview layout. The preview section moved into
// record/editor.html, so this probe measures the editor instead and keeps the assertions
// that mattered: the <video> stays inside its stage at every aspect ratio, and the
// timeline/export actions stay on screen (no body scroll) at the minimum window width.
//
// The window is driven the way the real flow drives it: a synthetic `record-editor:init`
// payload (metadata + file URL) is handed to the renderer through its exported
// `recordingEditor.applyInit`, which is exactly the handler main's push calls. Video URLs
// arrive as file paths in HIGHLIGHTER_RECORDING_EDITOR_VIDEOS; the renderer never sees a
// path in production (the main process sends a file URL).
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { app, BrowserWindow } = require('electron')

const resultPrefix = 'HIGHLIGHTER_RECORDING_EDITOR_LAYOUT_PROBE='
const wide = { width: 1120, height: 760 }
const narrow = { width: 820, height: 600 }

app.commandLine.appendSwitch('force-device-scale-factor', '1.5')
// Keep the probe's own Electron state out of the user profile.
const userDataRoot = path.join(os.tmpdir(), `highlighter-editor-probe-${Date.now()}`)
app.setPath('userData', userDataRoot)

function projectPayload(id, name, width, height, durationMs, frameRate = 30) {
  return {
    project: {
      schemaVersion: 1,
      id,
      name,
      mode: 'display',
      state: 'ready',
      createdAt: 0,
      updatedAt: 0,
      captureConfig: {
        target: { mode: 'display', displayId: 'probe', boundsDip: { x: 0, y: 0, width: 1920, height: 1080 }, pixelSize: { width: 1920, height: 1080 }, scaleFactor: 1 },
        frameRate: 30,
        quality: 'standard',
        countdown: 3,
        audio: { system: false, microphone: false, microphoneDeviceId: '', systemGain: 1, microphoneGain: 1 }
      },
      source: { assetId: 'capture', fileName: 'capture.webm', mediaKind: 'video', mimeType: 'video/webm', bytes: 1024 },
      media: {
        durationMs,
        video: { width, height },
        audio: { tracks: 0, codec: '' },
        timebase: 1000,
        probedAt: 0
      },
      captureOutcome: { video: true, audio: { system: false, microphone: false }, warnings: [] },
      edit: { revision: 1, keepRanges: [], format: 'mp4', gif: { edge: 1280, fps: 15 } },
      exports: [],
      recovery: { committedByteOffset: 0, lastChunkSequence: 0, cleanStop: true, errorCode: '' }
    },
    sourceUrl: '',
    metadata: { durationMs, video: { width, height, frameRate }, audio: { tracks: 0 } },
    recovery: { state: 'ready', errorCode: '' }
  }
}

async function measure(win) {
  return win.webContents.executeJavaScript(`(() => {
    const rect = (selector) => {
      const node = selector.startsWith('#') || selector.startsWith('.')
        ? (selector.startsWith('#') ? document.getElementById(selector.slice(1)) : document.querySelector(selector))
        : document.getElementById(selector)
      if (!node) return null
      const box = node.getBoundingClientRect()
      return { top: box.top, bottom: box.bottom, left: box.left, right: box.right, width: box.width, height: box.height }
    }
    const exportButton = rect('#export-button')
    const hit = exportButton
      ? document.elementFromPoint(exportButton.left + exportButton.width / 2, exportButton.top + exportButton.height / 2)
      : null
    return {
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      bodyScrollHeight: document.body.scrollHeight,
      documentScrollWidth: document.documentElement.scrollWidth,
      stage: rect('.video-stage'),
      video: rect('#preview-video'),
      videoReadyState: document.getElementById('preview-video').readyState,
      panel: rect('.timeline-panel'),
      track: rect('#timeline-track'),
      selection: rect('#timeline-selection'),
      segmentBlocks: [...document.querySelectorAll('.timeline-segment')].map((node) => {
        const box = node.getBoundingClientRect()
        return { left: box.left, width: box.width, index: node.dataset.index || '' }
      }),
      boundaryCount: document.querySelectorAll('.timeline-boundary').length,
      handleStart: rect('#handle-start'),
      handleEnd: rect('#handle-end'),
      timeline: rect('#timeline'),
      exportPanel: rect('.export-panel'),
      exportButton,
      exportHitTarget: hit ? (hit.id || hit.className || '') : '',
      recoveryHidden: document.getElementById('recovery-banner').hidden,
      recoveryVisible: !document.getElementById('recovery-banner').hidden,
      exportOutputSize: document.getElementById('export-output-size').textContent,
      exportResolutionOptions: [...document.getElementById('export-resolution').options].map((option) => option.value),
      exportFpsOptions: [...document.getElementById('export-fps').options].map((option) => option.value),
      editControls: ['split-at-playhead', 'delete-segment', 'undo-edit', 'redo-edit', 'reset-edits'].map((id) => {
        const node = document.getElementById(id)
        return { id, disabled: node ? node.disabled : null }
      }),
      emptyHintHidden: document.getElementById('empty-selection-hint').hidden,
      saveState: document.getElementById('save-state').textContent,
      name: document.getElementById('source-name').textContent,
      errors: document.getElementById('error-text').textContent,
      bodyFormat: document.body.dataset.format || '',
      // First-paint i18n audit: every static data-i18n node must hold the value the shared
      // runtime resolves for the active language. A skipped applyTranslations() leaves the
      // English HTML fallback in place and shows up here as a mismatch (the mixed-language
      // bug found from the E2E screenshot).
      language: document.documentElement.lang,
      i18nChecked: document.querySelectorAll('[data-i18n]').length,
      i18nMismatches: [...document.querySelectorAll('[data-i18n]')]
        .filter((node) => typeof window.t === 'function' && node.textContent !== window.t(node.getAttribute('data-i18n')))
        .map((node) => node.getAttribute('data-i18n'))
    }
  })()`)
}

async function applyProject(win, payload) {
  await win.webContents.executeJavaScript(`(() => {
    const data = ${JSON.stringify(payload)}
    const view = window.recordingEditor && window.recordingEditor.getView ? window.recordingEditor.getView() : null
    const applied = window.recordingEditor.applyInit(data)
    if (!view) return Promise.reject(new Error('The editor view did not boot'))
    const player = document.getElementById('preview-video')
    return new Promise((resolve, reject) => {
      if (!player.src) return resolve(applied)
      if (player.readyState >= 1) return requestAnimationFrame(() => requestAnimationFrame(() => resolve(applied)))
      const timer = setTimeout(() => reject(new Error('Preview metadata failed')), 5000)
      player.addEventListener('loadedmetadata', () => {
        clearTimeout(timer)
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(applied)))
      }, { once: true })
      player.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new Error('Preview metadata failed'))
      }, { once: true })
    })
  })()`)
  return measure(win)
}

async function runProbe() {
  const videoPaths = JSON.parse(process.env.HIGHLIGHTER_RECORDING_EDITOR_LAYOUT_VIDEOS || '[]')
  if (videoPaths.length !== 2) throw new Error('Recording editor layout probe requires two video fixtures')
  const videoUrls = videoPaths.map((value) => pathToFileURL(value).href)
  const preloadPath = path.join(__dirname, '..', 'preload-record-editor.js')
  const preload = fs.existsSync(preloadPath) ? preloadPath : undefined
  const win = new BrowserWindow({
    width: wide.width,
    height: wide.height,
    show: false,
    frame: false,
    resizable: true,
    minWidth: 820,
    minHeight: 600,
    backgroundColor: '#0e1013',
    webPreferences: {
      ...(preload ? { preload } : {}),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })

  await win.loadFile(path.join(__dirname, '..', 'record', 'editor.html'))
  // Boot happens synchronously from the page's own scripts; fail loudly if it did not.
  const booted = await win.webContents.executeJavaScript('!!(window.recordingEditor && window.recordingEditor.getView())')
  if (!booted) throw new Error('Editor view failed to boot')

  const landscape = projectPayload('probe-landscape', 'Landscape probe', 640, 480, 4000)
  landscape.sourceUrl = videoUrls[0]
  const wideLandscape = await applyProject(win, landscape)

  win.setSize(narrow.width, narrow.height)
  await new Promise((resolve) => setTimeout(resolve, 120))
  const narrowLandscape = await measure(win)

  win.setSize(wide.width, wide.height)
  await new Promise((resolve) => setTimeout(resolve, 120))
  const square = projectPayload('probe-square', 'Square probe', 480, 480, 4000)
  square.sourceUrl = videoUrls[1]
  const wideSquare = await applyProject(win, square)

  console.log(`${resultPrefix}${JSON.stringify({ wideLandscape, narrowLandscape, wideSquare })}`)
  win.destroy()
}

app.whenReady()
  .then(runProbe)
  .then(() => app.quit())
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })
  .finally(() => {
    try { fs.rmSync(userDataRoot, { recursive: true, force: true }) } catch { /* best effort */ }
  })
