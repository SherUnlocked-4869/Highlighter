const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { registerAppIpc } = require('../main/ipc/app-ipc')
const { registerCaptureIpc } = require('../main/ipc/capture-ipc')
const { registerDataRootIpc } = require('../main/ipc/data-root-ipc')
const { registerDiagnosticsIpc } = require('../main/ipc/diagnostics-ipc')
const { registerRecordingIpc } = require('../main/ipc/recording-ipc')
const { registerSearchIpc } = require('../main/ipc/search-ipc')

function createIpcMain() {
  const handlers = new Map()
  const listeners = new Map()
  return {
    handlers,
    listeners,
    handle: (channel, handler) => handlers.set(channel, handler),
    on: (channel, listener) => listeners.set(channel, listener)
  }
}

function createController(methods) {
  return Object.fromEntries(methods.map((method) => [method, (...args) => ({ method, args })]))
}

test('app and data-root IPC modules own their fixed channel surfaces', () => {
  const ipcMain = createIpcMain()
  registerAppIpc({
    ipcMain,
    controller: createController([
      'openExternal',
      'executeFunction',
      'getInfo',
      'getDisplayDiagnostics',
      'chooseDirectory',
      'openDataDirectory',
      'openSaveDirectory',
      'completeAi',
      'translateText'
    ])
  })
  registerDataRootIpc({
    ipcMain,
    controller: createController(['get', 'open', 'change'])
  })

  assert.deepEqual([...ipcMain.handlers.keys()], [
    'shell:open-external',
    'app:execute-function',
    'app:get-info',
    'app:get-display-diagnostics',
    'dialog:choose-directory',
    'app:open-data-directory',
    'app:open-save-directory',
    'ai:complete',
    'ai:translate',
    'data-root:get',
    'data-root:open',
    'data-root:change'
  ])
  assert.equal(ipcMain.handlers.get('app:execute-function')(null, { name: 'screenshot' }).method, 'executeFunction')
  assert.equal(ipcMain.handlers.get('data-root:change')().method, 'change')
})

test('diagnostics IPC exposes preview and boolean-only crash dump export options', () => {
  const ipcMain = createIpcMain()
  registerDiagnosticsIpc({
    ipcMain,
    controller: createController(['preview', 'export'])
  })

  assert.deepEqual([...ipcMain.handlers.keys()], ['diagnostics:preview', 'diagnostics:export'])
  assert.equal(ipcMain.handlers.get('diagnostics:preview')().method, 'preview')
  assert.deepEqual(ipcMain.handlers.get('diagnostics:export')(null, { includeCrashDumps: 'yes' }).args[0], { includeCrashDumps: false })
  assert.deepEqual(ipcMain.handlers.get('diagnostics:export')(null, { includeCrashDumps: true }).args[0], { includeCrashDumps: true })
})

test('capture IPC module owns capture, long-capture, OCR, and recognition channels', () => {
  const ipcMain = createIpcMain()
  registerCaptureIpc({
    ipcMain,
    controller: createController([
      'ready',
      'renderReady',
      'renderError',
      'close',
      'startRegionRecording',
      'startLong',
      'smartSelect',
      'copy',
      'save',
      'pin',
      'pinReannotate',
      'openRecognition',
      'recordHistory',
      'longReady',
      'longOverlayReady',
      'longOverlayActive',
      'longAddStrip',
      'longSetTrim',
      'longSetSelectionEditing',
      'longOverlayBoundsChanged',
      'longFinish',
      'longClose',
      'ocrStatus',
      'ocr',
      'translate',
      'recognitionReady',
      'recognitionTable',
      'recognitionCopy',
      'recognitionClose'
    ])
  })

  assert.deepEqual([...ipcMain.listeners.keys()], [
    'capture:ready',
    'capture:render-ready',
    'capture:render-error',
    'capture:close',
    'capture:save',
    'long-capture:ready',
    'long-overlay:ready',
    'long-capture:overlay-active',
    'long-overlay:bounds-changed',
    'long-capture:close',
    'recognition:ready',
    'recognition:close'
  ])
  assert.deepEqual([...ipcMain.handlers.keys()], [
    'capture:start-region-recording',
    'capture:start-long',
    'capture:smart-select',
    'capture:copy',
    'capture:pin',
    'capture:pin-reannotate',
    'capture:open-recognition',
    'capture:record-history',
    'long-capture:add-strip',
    'long-capture:set-trim',
    'long-capture:set-selection-editing',
    'long-capture:finish',
    'ocr:status',
    'capture:ocr',
    'capture:translate',
    'recognition:table',
    'recognition:copy'
  ])
})

test('search IPC module owns query, state, and file action channels', () => {
  const ipcMain = createIpcMain()
  registerSearchIpc({
    ipcMain,
    controller: createController([
      'query',
      'getStatus',
      'ensureReady',
      'openPath',
      'revealPath',
      'copyPath',
      'getFileIcon',
      'ready',
      'close'
    ])
  })

  assert.deepEqual([...ipcMain.handlers.keys()], [
    'search:query',
    'search:status',
    'search:ensure-ready',
    'search:open-path',
    'search:reveal-path',
    'search:copy-path',
    'search:file-icon'
  ])
  assert.deepEqual([...ipcMain.listeners.keys()], ['search:ready', 'search:close'])
  assert.equal(ipcMain.handlers.get('search:query')(null, { search: 'a' }).method, 'query')
})

test('recording IPC module owns control and annotation channels', () => {
  const ipcMain = createIpcMain()
  registerRecordingIpc({
    ipcMain,
    controller: createController([
      'ready',
      'frameReady',
      'frameSnapshot',
      'performance',
      'setAnnotationCommand',
      'startSession',
      'appendChunk',
      'finishSession',
      'saveMp4',
      'cancelSession',
      'setFrameState',
      'resizePreview',
      'restart',
      'close'
    ])
  })

  assert.deepEqual([...ipcMain.listeners.keys()], [
    'record:ready',
    'record-frame:ready',
    'record-frame:snapshot',
    'record:performance',
    'record:close'
  ])
  assert.deepEqual([...ipcMain.handlers.keys()], [
    'record:set-annotation-command',
    'record:start-session',
    'record:append-chunk',
    'record:finish-session',
    'record:save-mp4',
    'record:cancel-session',
    'record:set-frame-state',
    'record:resize-preview',
    'record:restart'
  ])
})

test('main process delegates migrated IPC channels without registering them directly', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  for (const prefix of [
    'capture:',
    'long-capture:',
    'long-overlay:',
    'recognition:',
    'record:',
    'record-frame:',
    'search:',
    'data-root:'
  ]) {
    assert.doesNotMatch(main, new RegExp(`ipcMain\\.(?:handle|on)\\('${prefix}`))
  }
  for (const registration of [
    'registerAppIpc',
    'registerDataRootIpc',
    'registerCaptureIpc',
    'registerRecordingIpc',
    'registerSearchIpc'
  ]) {
    assert.match(main, new RegExp(`${registration}\\(\\{`))
  }
})
