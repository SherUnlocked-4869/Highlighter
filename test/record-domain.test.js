const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
const recordDomainSource = fs.readFileSync(path.join(root, 'main/domains/record/index.js'), 'utf8')

test('main.js delegates record domain instead of inlining recording windows and IPC', () => {
  assert.match(main, /require\('\.\/main\/domains\/record'\)/)
  assert.match(main, /createRecordDomain\(\{/)
  assert.match(main, /recordDomain\s*=\s*createRecordDomain/)
  assert.doesNotMatch(main, /function createRecordWindow\(/)
  assert.doesNotMatch(main, /function closeRecordFlow\(/)
  assert.doesNotMatch(main, /function requireRecordSender\(/)
  assert.doesNotMatch(main, /const recordingIpcController/)
  assert.doesNotMatch(main, /let recordWindow = null/)
})

test('main.js routes record ownership through the domain', () => {
  assert.match(main, /recordDomain\?\.ownsControlWindow\(win\)/)
  assert.match(main, /recordDomain\?\.ownsFrameWindow\(win\)/)
  assert.match(main, /recordDomain\?\.isTaskActive\(\)/)
  assert.match(main, /recordDomain\.createRecordWindow\(/)
  assert.match(main, /recordDomain\.createRecordingController\(\)/)
  assert.match(main, /recordDomain\.shutdown\(\)/)
})

test('record domain owns window lifecycle, annotation routing, and MP4 save', () => {
  assert.match(recordDomainSource, /function createRecordWindow/)
  assert.match(recordDomainSource, /function createRecordingController/)
  assert.match(recordDomainSource, /function requireRecordSender/)
  assert.match(recordDomainSource, /function requireRecordFrameSender/)
  assert.match(recordDomainSource, /function sendRecordAnnotationCommand/)
  assert.match(recordDomainSource, /saveMp4/)
  assert.match(recordDomainSource, /setContentProtection\(true\)/)
})

// Shared harness: the record domain needs a window whose session can register the
// display-media handler (P0-3-T2) and a settings object carrying the frozen audio keys.
function createRecordHarness() {
  const { createRecordDomain } = require('../main/domains/record')
  const created = []
  const domain = createRecordDomain({
    app: { getPath: () => path.join(root, 'tmp-videos') },
    desktopCapturer: {
      getSources: async () => [{ id: 'screen:1', display_id: '1', thumbnail: { isEmpty: () => false } }]
    },
    path,
    screen: {
      getDisplayMatching: () => ({ id: 1, scaleFactor: 1, bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { x: 0, y: 0, width: 800, height: 600 } }),
      getDisplayNearestPoint: () => ({ id: 1, scaleFactor: 1, bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { x: 0, y: 0, width: 800, height: 600 } })
    },
    dialog: { showSaveDialog: async () => ({ canceled: true }) },
    BrowserWindow: { fromWebContents: () => null },
    rootDirectory: root,
    createLocalWindow: (pagePath) => {
      const win = {
        pagePath,
        isDestroyed: () => false,
        setAlwaysOnTop: () => {},
        setContentProtection: () => {},
        setIgnoreMouseEvents: () => {},
        setBounds: () => {},
        show: () => {},
        showInactive: () => {},
        hide: () => {},
        close: () => {},
        loadFile: () => Promise.resolve(),
        on: (event, cb) => { if (event === 'closed') win._onClosed = cb },
        webContents: {
          send: () => {},
          mainFrame: { id: 'record-main-frame' },
          session: {
            setDisplayMediaRequestHandler: (handler) => {
              win.displayMediaHandler = handler
              win.displayMediaHandlerCalls = (win.displayMediaHandlerCalls || []).concat([handler])
            }
          }
        }
      }
      created.push(win)
      return win
    },
    getSettings: () => ({
      record: {
        frameRate: 24,
        saveDirectory: '',
        audioSystem: true,
        audioMicrophone: false,
        audioSystemGain: 1,
        audioMicrophoneGain: 1
      }
    }),
    log: () => {},
    assertGameModeDisabled: () => {},
    assertManagedDataWritable: () => {},
    getRecordingService: () => ({
      transcode: () => Promise.resolve('out.mp4'),
      cleanupSession: async () => true
    }),
    managedRecordingWriters: {
      track: async (fn) => (typeof fn === 'function' ? fn() : fn),
      assertOpen: () => {}
    },
    makeCaptureName: (prefix) => `${prefix}-test.png`,
    VIDEO_CAPTURE_PREFIX: 'video',
    performanceMonitor: { record: () => {}, snapshot: () => {} }
  })
  return { created, domain }
}

test('record domain factory tracks control and frame window ownership', async () => {
  const { created, domain } = createRecordHarness()

  assert.equal(domain.ownsControlWindow(null), false)
  assert.equal(domain.ownsFrameWindow(null), false)
  assert.equal(domain.isTaskActive(), false)

  const control = await domain.createRecordWindow({
    selectionBounds: { x: 10, y: 10, width: 200, height: 150 }
  })
  assert.ok(control)
  assert.equal(domain.ownsControlWindow(control), true)
  assert.equal(domain.isTaskActive(), true)
  assert.equal(created.length, 2, 'the frame and control windows are both created')
})

test('the record window registers the display-media handler and carries the frozen audio keys (P0-3-T2)', async () => {
  const { created, domain } = createRecordHarness()
  const control = await domain.createRecordWindow({
    selectionBounds: { x: 10, y: 10, width: 200, height: 150 }
  })

  // The handler is registered on the record window's own session, and it must honour the
  // renderer's audioRequested flag: a "system sound off" recording has to stay track-free.
  assert.equal(typeof control.displayMediaHandler, 'function', 'the display-media handler is registered')

  const withAudio = await new Promise((resolve) => {
    control.displayMediaHandler({ videoRequested: true, audioRequested: true }, resolve)
  })
  assert.equal(withAudio.video.id, 'screen:1', 'the display is picked by display id')
  assert.equal(withAudio.audio, process.platform === 'win32' ? 'loopback' : undefined)

  const withoutAudio = await new Promise((resolve) => {
    control.displayMediaHandler({ videoRequested: true, audioRequested: false }, resolve)
  })
  assert.equal(withoutAudio.video.id, 'screen:1')
  assert.equal('audio' in withoutAudio, false, 'no audio track is offered when the renderer did not ask')

  const noVideo = await new Promise((resolve) => {
    control.displayMediaHandler({ videoRequested: false, audioRequested: true }, resolve)
  })
  assert.deepEqual(noVideo, {})

  // The four frozen keys reach the renderer so it stops relying on its own fallbacks.
  assert.deepEqual(
    {
      audioSystem: control._recordInit.audioSystem,
      audioMicrophone: control._recordInit.audioMicrophone,
      audioSystemGain: control._recordInit.audioSystemGain,
      audioMicrophoneGain: control._recordInit.audioMicrophoneGain
    },
    { audioSystem: true, audioMicrophone: false, audioSystemGain: 1, audioMicrophoneGain: 1 }
  )
  assert.equal(created.length, 2)
})

// OCR 评审修复：handler 注册在**共享默认 session** 上，必须校验请求来源帧，否则任何渲染进程
// 调用 getDisplayMedia 都能拿到屏幕 + Windows loopback 音频；且窗口关闭后必须注销，
// 否则它仍存活并指向旧 display。
test('the display-media handler only serves the record window frame and is unregistered on close (P0-3-T2)', async () => {
  const { domain } = createRecordHarness()
  const control = await domain.createRecordWindow({ selectionBounds: { x: 10, y: 10, width: 200, height: 150 } })

  const foreignFrame = await new Promise((resolve) => {
    control.displayMediaHandler({ frame: { id: 'some-other-frame' }, videoRequested: true, audioRequested: true }, resolve)
  })
  assert.deepEqual(foreignFrame, {}, 'a request from another frame must be refused')

  const ownFrame = await new Promise((resolve) => {
    control.displayMediaHandler({
      frame: control.webContents.mainFrame,
      videoRequested: true,
      audioRequested: false
    }, resolve)
  })
  assert.equal(ownFrame.video.id, 'screen:1', 'the record window frame is still served')

  // 窗口关闭 → 共享 session 上的 handler 必须被清掉。
  assert.equal(control.displayMediaHandlerCalls.length, 1)
  control._onClosed()
  assert.equal(control.displayMediaHandlerCalls.length, 2)
  assert.equal(control.displayMediaHandlerCalls[1], null, 'closing the window unregisters the handler')
})

test('saving an MP4 forwards the audio option derived from the frozen record keys (P0-3-T3/T4)', () => {
  // The transcode call itself is exercised end-to-end by test/recording-service.test.js; what
  // this asserts is that the domain derives the option from the frozen keys rather than
  // hard-coding `-an`, which is what would silently export a silent MP4.
  assert.match(
    recordDomainSource,
    /service\.transcode\(sessionId, result\.filePath, \(elapsedMicroseconds\) => \{[\s\S]{0,220}?\}, \{ audio: !!\(settings\.record\.audioSystem \|\| settings\.record\.audioMicrophone\) \}\)/,
    'the save path must forward { audio } built from the frozen record keys'
  )
})


// Feature E (plan §8.3): the regression that motivated the whole session/export split - the old
// save path ran cleanupSession immediately after a successful transcode, deleting the recording
// while the preview stayed open.
test('the legacy MP4 save no longer deletes the recording session (feature E1)', () => {
  const saveMp4 = recordDomainSource.slice(
    recordDomainSource.indexOf('saveMp4: async'),
    recordDomainSource.indexOf('probeSession: async')
  )
  assert.ok(saveMp4.length > 0, 'the saveMp4 handler must still exist')
  assert.doesNotMatch(saveMp4, /cleanupSession/, 'a successful save must not clean the source session')
  assert.doesNotMatch(saveMp4, /_recordSessionId = null/, 'the session handle must survive a save')
  assert.match(saveMp4, /return outputPath/, 'the legacy empty-string|path return type is unchanged')
})

test('the record domain owns probe, export, cancel and close-preview for feature E (plan §8.3)', () => {
  assert.match(recordDomainSource, /probeSession: async/)
  assert.match(recordDomainSource, /exportRecording: async/)
  assert.match(recordDomainSource, /exportStatus:/)
  assert.match(recordDomainSource, /cancelExport: async/)
  assert.match(recordDomainSource, /closePreview: async/)
  // The renderer never supplies the target: the domain asks the main process for it and freezes
  // the answer before submitting the task.
  assert.match(recordDomainSource, /chooseExportTarget\(win,/)
  assert.match(recordDomainSource, /showSaveDialog\(win,[\s\S]{0,600}?setAlwaysOnTop\(true, 'screen-saver'\)/)
  // Shutdown cancels exports BEFORE disposing sessions, because a running encoder holds a source
  // reference and an early directory removal would break it.
  const shutdown = recordDomainSource.slice(recordDomainSource.indexOf('async function shutdown'))
  assert.match(shutdown, /exportService\.dispose\(\)[\s\S]*?activeService\.dispose\(\)/)
})


// Shared harness for the feature-E export channels. The window lookup is by webContents, so the
// domain's own ownership check (recordWindow === win) is really exercised, and the export
// service is a double: this file tests the domain contract, while
// test/recording-export.test.js drives the real encoder against real media.
function createExportHarness({ probeResponse = { ok: true }, submitAnswer = null, cancelAnswer = null, dialogResult = null } = {}) {
  const { createRecordDomain } = require('../main/domains/record')
  const sent = []
  const submitted = []
  const cancelled = []
  const windowsByContents = new Map()
  const exportService = {
    submit: async (input) => {
      submitted.push(input)
      input.onEvent({ taskId: 'task-1', state: 'running', progress: 10 })
      input.onEvent({ taskId: 'task-1', state: 'succeeded', progress: 100, receipt: { status: 'saved', resultId: 'r1' } })
      return submitAnswer || { ok: true, task: { taskId: 'task-1', state: 'queued' } }
    },
    status: () => ({ ok: true, task: { taskId: 'task-1', state: 'running' } }),
    cancel: (query) => {
      cancelled.push(query)
      return cancelAnswer || { ok: true, state: 'cancelling' }
    }
  }
  const settings = {
    record: {
      frameRate: 24,
      saveDirectory: '',
      audioSystem: true,
      audioMicrophone: false,
      audioSystemGain: 1,
      audioMicrophoneGain: 1
    }
  }
  const domain = createRecordDomain({
    app: { getPath: () => path.join(root, 'tmp-videos') },
    desktopCapturer: { getSources: async () => [{ id: 'screen:1', display_id: '1' }] },
    path,
    screen: {
      getDisplayMatching: () => ({ id: 1, scaleFactor: 1, bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { x: 0, y: 0, width: 800, height: 600 } }),
      getDisplayNearestPoint: () => ({ id: 1, scaleFactor: 1, bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { x: 0, y: 0, width: 800, height: 600 } })
    },
    dialog: {
      showSaveDialog: async () => dialogResult || { canceled: true }
    },
    BrowserWindow: { fromWebContents: (contents) => windowsByContents.get(contents) || null },
    rootDirectory: root,
    createLocalWindow: (pagePath) => {
      const win = {
        pagePath,
        isDestroyed: () => false,
        setAlwaysOnTop: () => {},
        setContentProtection: () => {},
        setIgnoreMouseEvents: () => {},
        setBounds: () => {},
        show: () => {},
        showInactive: () => {},
        hide: () => {},
        close: () => {},
        loadFile: () => Promise.resolve(),
        on: () => {},
        webContents: {
          id: 42,
          send: (channel, payload) => sent.push({ channel, payload }),
          mainFrame: { id: 'frame-' + pagePath },
          session: { setDisplayMediaRequestHandler: () => {} }
        }
      }
      windowsByContents.set(win.webContents, win)
      return win
    },
    getSettings: () => settings,
    log: () => {},
    assertGameModeDisabled: () => {},
    assertManagedDataWritable: () => {},
    getRecordingService: () => ({
      cleanupSession: async () => true,
      probeSession: async () => probeResponse
    }),
    getRecordingExportService: () => exportService,
    managedRecordingWriters: { track: async (fn) => (typeof fn === 'function' ? fn() : fn), assertOpen: () => {} },
    makeCaptureName: () => 'Highlighter_Video.png',
    VIDEO_CAPTURE_PREFIX: 'video',
    performanceMonitor: { record: () => {}, snapshot: () => {} }
  })
  return { domain, sent, submitted, cancelled, exportService }
}

test('record:export takes the target from the save dialog and streams progress to that window (feature E2)', async () => {
  const { domain, sent, submitted } = createExportHarness({
    dialogResult: { canceled: false, filePath: path.join(root, 'tmp-videos', 'out.mp4') }
  })
  const control = await domain.createRecordWindow({ selectionBounds: { x: 10, y: 10, width: 200, height: 150 } })
  control._recordSessionId = 'session-1'
  const controller = domain.createRecordingController()
  const answer = await controller.exportRecording(
    { sender: control.webContents },
    { sessionId: 'session-1', requestId: 'req-1', request: { format: 'mp4', range: { startMs: 0, endMs: 1000 } } }
  )
  assert.equal(answer.status, 'accepted')
  assert.equal(submitted.length, 1)
  // The target came from the dialog; the owner id comes from the transport, not the payload.
  assert.match(submitted[0].targetPath, /out\.mp4$/)
  assert.equal(submitted[0].ownerId, 'web-contents:42')
  // The request carries the range/format only - there is no path field to smuggle.
  assert.deepEqual(submitted[0].request, { format: 'mp4', range: { startMs: 0, endMs: 1000 } })
  const progress = sent.filter((entry) => entry.channel === 'record:export-progress')
  assert.equal(progress.length, 2, 'both task events reach the window that started the task')
  assert.equal(progress.at(-1).payload.state, 'succeeded')
  assert.equal(progress.at(-1).payload.receipt.resultId, 'r1')
})

test('a dismissed save dialog creates no export task (feature E2)', async () => {
  const { domain, submitted } = createExportHarness({ dialogResult: { canceled: true } })
  const control = await domain.createRecordWindow({ selectionBounds: { x: 10, y: 10, width: 200, height: 150 } })
  control._recordSessionId = 'session-1'
  const controller = domain.createRecordingController()
  const answer = await controller.exportRecording(
    { sender: control.webContents },
    { sessionId: 'session-1', requestId: 'req-1', request: { format: 'mp4', range: { startMs: 0, endMs: 1000 } } }
  )
  assert.equal(answer.status, 'cancelled')
  assert.equal(submitted.length, 0, 'a cancelled dialog must not register a task (plan §8.3)')
})

test('the export channels refuse a window that does not own the session', async () => {
  const { domain, submitted, cancelled } = createExportHarness({
    dialogResult: { canceled: false, filePath: path.join(root, 'tmp-videos', 'out.mp4') }
  })
  const control = await domain.createRecordWindow({ selectionBounds: { x: 10, y: 10, width: 200, height: 150 } })
  control._recordSessionId = 'session-1'
  const controller = domain.createRecordingController()

  // A session id the window does not own is refused before anything is queued.
  await assert.rejects(
    () => controller.exportRecording(
      { sender: control.webContents },
      { sessionId: 'other-session', requestId: 'req-1', request: { format: 'mp4', range: { startMs: 0, endMs: 1000 } } }
    ),
    /录制会话不匹配/
  )
  assert.equal(submitted.length, 0)

  // Status and cancel are owner-scoped: the owner window is accepted.
  const status = controller.exportStatus({ sender: control.webContents }, { taskId: 'task-1', sessionId: 'session-1' })
  assert.equal(status.ok, true)
  const cancelledAnswer = await controller.cancelExport({ sender: control.webContents }, { taskId: 'task-1', sessionId: 'session-1' })
  assert.equal(cancelledAnswer.ok, true)
  assert.deepEqual(cancelled.at(-1), { taskId: 'task-1', ownerId: 'web-contents:42' })
})

test('probeSession surfaces the probe failure code instead of a guessed duration', async () => {
  const { domain } = createExportHarness({ probeResponse: { ok: false, code: 'renderer-duration-disagrees' } })
  const control = await domain.createRecordWindow({ selectionBounds: { x: 10, y: 10, width: 200, height: 150 } })
  control._recordSessionId = 'session-1'
  const controller = domain.createRecordingController()
  const answer = await controller.probeSession(
    { sender: control.webContents },
    { sessionId: 'session-1', durationMs: 5000 }
  )
  assert.deepEqual(answer, { ok: false, code: 'renderer-duration-disagrees' })
})
