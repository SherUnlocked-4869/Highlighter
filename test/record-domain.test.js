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
  // R1 (plan §5.2 exit safety): main.js awaits a BOUNDED recording shutdown before quitting.
  assert.match(main, /recordDomain\.shutdown\(\{ timeoutMs: 3000 \}\)/)
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
  const shutdown = recordDomainSource.slice(recordDomainSource.indexOf('async function disposeRecordingResources'))
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

// --------------------------------------------------------------------------------------------
// R1-R3: persistent projects, the live control-bar state channel, the workbench and the editor.
//
// These drive the DOMAIN through its controllers with in-memory doubles for the recording service,
// the persistent project service (W1) and the export queue (feature E). They assert behaviour
// (who gets called, with what, and what the renderer receives), not source text.
// --------------------------------------------------------------------------------------------

function makeProject(overrides = {}) {
  return {
    id: overrides.id || 'project-1',
    name: overrides.name || 'Recording',
    mode: overrides.mode || 'display',
    state: overrides.state || 'capturing',
    createdAt: 1,
    updatedAt: 2,
    captureConfig: overrides.captureConfig || {
      target: {
        mode: 'display',
        displayId: '1',
        displayName: 'DISPLAY1',
        boundsDip: { x: 0, y: 0, width: 800, height: 600 },
        pixelSize: { width: 800, height: 600 },
        scaleFactor: 1
      },
      frameRate: 30,
      quality: 'standard',
      countdown: 3,
      audio: { system: true, microphone: false, microphoneDeviceId: '', systemGain: 1, microphoneGain: 1 }
    },
    source: { assetId: 'capture', fileName: 'capture.webm', mediaKind: 'video', mimeType: 'video/webm', bytes: 10 },
    media: overrides.media || {
      durationMs: 5000,
      video: { width: 800, height: 600 },
      audio: { tracks: 1, codec: 'opus' },
      timebase: 1000,
      probedAt: 3
    },
    captureOutcome: { video: true, audio: { system: true, microphone: false }, warnings: [] },
    edit: { revision: 1, keepRanges: [], format: 'mp4', gif: { edge: 1280, fps: 15 } },
    exports: [],
    recovery: { committedByteOffset: 0, lastChunkSequence: 0, cleanStop: true, errorCode: '' },
    ...overrides
  }
}

function createProjectServiceStub(overrides = {}) {
  const projects = new Map()
  const calls = []
  const record = (name, ...args) => { calls.push([name, ...args]) }
  let sequence = 0
  const service = {
    calls,
    projects,
    projectDirectory: (projectId) => path.resolve('recordings', String(projectId || '')),
    sourcePathOf: async (projectId) => (projects.has(String(projectId)) ? path.resolve('recordings', String(projectId), 'capture.webm') : ''),
    createProject: async ({ mode, captureConfig, name } = {}) => {
      record('createProject', { mode, captureConfig, name })
      const id = `project-${++sequence}`
      const project = makeProject({ id, mode, name, captureConfig })
      projects.set(id, project)
      return { project, directory: path.resolve('recordings', id) }
    },
    getProject: async (projectId) => projects.get(String(projectId)) || null,
    readProjectFile: async () => null,
    listProjects: async ({ offset = 0, limit = 20 } = {}) => {
      const items = [...projects.values()].map((project) => ({ id: project.id, name: project.name, state: project.state }))
      return { items: items.slice(offset, offset + limit), total: items.length, offset, limit }
    },
    checkpoint: async (projectId, offsets) => { record('checkpoint', projectId, offsets); return true },
    sealProject: async (projectId, { metadata, captureOutcome } = {}) => {
      record('sealProject', projectId, { metadata, captureOutcome })
      if (overrides.sealAnswer) {
        if (overrides.sealAnswer.project) projects.set(String(projectId), overrides.sealAnswer.project)
        return overrides.sealAnswer
      }
      const project = projects.get(String(projectId))
      const next = {
        ...project,
        state: metadata ? 'ready' : 'recoverable',
        recovery: { ...project.recovery, cleanStop: true, errorCode: metadata ? '' : 'probe-failed' }
      }
      projects.set(String(projectId), next)
      return metadata ? { ok: true, project: next } : { ok: false, code: 'probe-failed', project: next }
    },
    updateDraft: async (projectId, { expectedRevision, edit } = {}) => {
      record('updateDraft', projectId, { expectedRevision, edit })
      if (overrides.updateDraftAnswer) return overrides.updateDraftAnswer
      const project = projects.get(String(projectId))
      if (!project) return { ok: false, code: 'not-found' }
      if (project.edit.revision !== expectedRevision) return { ok: false, code: 'revision-conflict', revision: project.edit.revision }
      const next = { ...project, edit: { ...project.edit, ...edit, revision: project.edit.revision + 1 } }
      projects.set(String(projectId), next)
      return { ok: true, revision: next.edit.revision, project: next }
    },
    renameProject: async (projectId, name) => {
      record('renameProject', projectId, name)
      const project = projects.get(String(projectId))
      if (!project) return { ok: false, code: 'not-found' }
      const next = { ...project, name }
      projects.set(String(projectId), next)
      return { ok: true, project: next }
    },
    appendExport: async (projectId, entry) => { record('appendExport', projectId, entry); return { ok: true } },
    markRecoverable: async (projectId, errorCode) => {
      record('markRecoverable', projectId, errorCode)
      const project = projects.get(String(projectId))
      if (project) projects.set(String(projectId), { ...project, state: 'recoverable', recovery: { ...project.recovery, errorCode } })
      return { ok: true }
    },
    markReady: async (projectId, payload) => {
      record('markReady', projectId, payload)
      if (overrides.markReadyAnswer) return overrides.markReadyAnswer
      const project = projects.get(String(projectId))
      if (!project) return { ok: false, code: 'not-found' }
      const next = { ...project, state: 'ready', recovery: { ...project.recovery, cleanStop: true, errorCode: '' } }
      projects.set(String(projectId), next)
      return { ok: true, project: next }
    },
    deleteProject: async (projectId) => {
      record('deleteProject', projectId)
      if (overrides.deleteAnswer) return overrides.deleteAnswer
      projects.delete(String(projectId))
      return { ok: true }
    },
    summaryOf: (project) => ({ id: project.id, name: project.name, state: project.state }),
    publicProject: (project) => ({
      id: project.id,
      name: project.name,
      state: project.state,
      edit: project.edit,
      media: project.media,
      captureConfig: project.captureConfig,
      captureOutcome: project.captureOutcome,
      exports: project.exports,
      source: { mediaKind: project.source.mediaKind, mimeType: project.source.mimeType, bytes: project.source.bytes },
      recovery: { cleanStop: project.recovery.cleanStop, errorCode: project.recovery.errorCode }
    }),
    dispose: async () => { record('dispose') }
  }
  return service
}

function createRecordingServiceStub(overrides = {}) {
  const sessions = new Map()
  const calls = []
  const record = (name, ...args) => { calls.push([name, ...args]) }
  let sequence = 0
  const probeMetadata = {
    durationMs: 5000,
    startMs: 0,
    durationSource: 'container',
    video: { codec: 'vp9', width: 800, height: 600, frameRate: 30 },
    audio: { exists: true, codec: 'opus', sampleRate: 48000, channels: 1 },
    timebase: 'ms-media-timeline'
  }
  return {
    sessions,
    calls,
    async startSession({ directory = null, projectId = null } = {}) {
      record('startSession', { directory, projectId })
      const id = `session-${++sequence}`
      const sessionDirectory = directory || path.resolve('tmp-recordings', id)
      const session = {
        id,
        directory: sessionDirectory,
        inputPath: path.join(sessionDirectory, 'capture.webm'),
        projectId: projectId ? String(projectId) : null,
        ownedDirectory: !directory,
        state: 'capturing',
        writeQueue: Promise.resolve(),
        bytesWritten: 0,
        lastChunkSequence: 0,
        references: 0,
        metadata: null
      }
      sessions.set(id, session)
      return { id, directory: session.directory, inputPath: session.inputPath }
    },
    async registerPersistedSession({ id, directory, inputPath = '', metadata = null, projectId = null } = {}) {
      record('registerPersistedSession', { id, directory, inputPath, projectId })
      const existing = sessions.get(String(id))
      if (existing) return existing
      const session = {
        id: String(id),
        directory,
        inputPath: inputPath || path.join(directory, 'capture.webm'),
        projectId: projectId ? String(projectId) : null,
        ownedDirectory: false,
        state: 'ready',
        writeQueue: Promise.resolve(),
        bytesWritten: 10,
        lastChunkSequence: 0,
        references: 0,
        metadata
      }
      sessions.set(session.id, session)
      return session
    },
    detachSession(sessionId) {
      record('detachSession', sessionId)
      return sessions.delete(String(sessionId))
    },
    peekSession: (sessionId) => sessions.get(String(sessionId)) || null,
    async appendChunk(sessionId, value, { sequence = null } = {}) {
      record('appendChunk', sessionId, Buffer.isBuffer(value) ? value.length : 0, sequence)
      if (overrides.appendError) throw overrides.appendError
      const session = sessions.get(String(sessionId))
      if (sequence !== null && sequence !== undefined) {
        const sequenceNumber = Number(sequence)
        if (!Number.isSafeInteger(sequenceNumber) || sequenceNumber < 1) {
          const error = new Error('invalid sequence')
          error.code = 'invalid-sequence'
          error.received = sequence
          throw error
        }
        if (sequenceNumber > session.lastChunkSequence + 1) {
          const error = new Error('sequence gap')
          error.code = 'sequence-gap'
          error.expected = session.lastChunkSequence + 1
          error.received = sequenceNumber
          throw error
        }
        session.lastChunkSequence = sequenceNumber
      }
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value || [])
      session.bytesWritten += chunk.length
      return { committedBytes: session.bytesWritten, sequence, lastChunkSequence: session.lastChunkSequence }
    },
    async finishSession(sessionId) {
      record('finishSession', sessionId)
      if (overrides.finishError) throw overrides.finishError
      const session = sessions.get(String(sessionId))
      session.state = 'ready'
      return {
        id: session.id,
        state: 'ready',
        inputPath: session.inputPath,
        previewUrl: `file://${session.inputPath}`,
        bytesWritten: session.bytesWritten,
        projectId: session.projectId
      }
    },
    async probeSession(sessionId, options = {}) {
      record('probeSession', sessionId, options)
      if (overrides.probeError) throw overrides.probeError
      if (overrides.probeAnswer) return overrides.probeAnswer
      return { ok: true, metadata: probeMetadata }
    },
    async cleanupSession(sessionId) {
      record('cleanupSession', sessionId)
      const session = sessions.get(String(sessionId))
      if (!session) return false
      // W1 semantics: a live export lease defers the removal, and a project-owned directory is
      // never deleted (only the table entry goes away).
      if (session.references > 0) {
        session.pendingClose = true
        return false
      }
      sessions.delete(String(sessionId))
      return true
    },
    async transcode() { return 'out.mp4' },
    async dispose() { record('dispose') }
  }
}

function createExportServiceStub() {
  const submitted = []
  const cancelled = []
  const tasks = []
  return {
    submitted,
    cancelled,
    tasks,
    async submit(input) {
      submitted.push(input)
      input.onEvent?.({ taskId: 'task-1', state: 'running', progress: 10 })
      input.onEvent?.({ taskId: 'task-1', state: 'succeeded', progress: 100, receipt: { status: 'saved', resultId: 'result-1', fileName: 'out.mp4' } })
      return {
        ok: true,
        task: { taskId: 'task-1', state: 'queued', requestId: input.requestId, sessionId: input.sessionId, format: input.request?.format }
      }
    },
    status(query) { return { ok: true, task: { taskId: query.taskId || 'task-1', state: 'running' } } },
    cancel(query) { cancelled.push(query); return { ok: true, state: 'cancelling' } },
    list() { return tasks },
    async dispose() {}
  }
}

function createProjectHarness(overrides = {}) {
  const { createRecordDomain } = require('../main/domains/record')
  const windows = []
  const windowsByContents = new Map()
  const sent = []
  const settings = {
    record: {
      frameRate: 24,
      saveDirectory: '',
      audioSystem: true,
      audioMicrophone: false,
      audioSystemGain: 1,
      audioMicrophoneGain: 1,
      quality: 'standard',
      countdown: 3,
      audioMicrophoneDeviceId: '',
      lastMode: 'display',
      lastDisplayId: ''
    }
  }
  const updateSettingsCalls = []
  const regionSelections = []
  const routes = []
  const shellCalls = []
  const trayRefreshes = []
  let contentsId = 0
  const display = { id: 1, label: 'DISPLAY1', scaleFactor: 1, bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { x: 0, y: 0, width: 800, height: 600 } }
  const secondDisplay = { id: 2, label: 'DISPLAY2', scaleFactor: 2, bounds: { x: 800, y: 0, width: 1600, height: 900 }, workArea: { x: 800, y: 0, width: 1600, height: 900 } }
  const projectService = overrides.projectService || createProjectServiceStub(overrides.projectServiceOverrides)
  const recordingService = overrides.recordingService || createRecordingServiceStub(overrides.recordingServiceOverrides)
  const exportService = overrides.exportService || createExportServiceStub()
  let dialogResult = overrides.dialogResult || { canceled: true }

  const domain = createRecordDomain({
    app: { getPath: (name) => path.resolve('tmp', name) },
    desktopCapturer: { getSources: async () => [{ id: 'screen:1', display_id: '1', thumbnail: { isEmpty: () => false } }] },
    path,
    screen: {
      getAllDisplays: () => [display, secondDisplay],
      getPrimaryDisplay: () => display,
      getCursorScreenPoint: () => ({ x: 1, y: 2 }),
      getDisplayNearestPoint: () => display,
      getDisplayMatching: () => display,
      dipToScreenRect: () => ({ x: 0, y: 0, width: 800, height: 600 })
    },
    dialog: { showSaveDialog: async () => dialogResult },
    BrowserWindow: { fromWebContents: (contents) => windowsByContents.get(contents) || null },
    rootDirectory: root,
    createLocalWindow: (pagePath, options = {}) => {
      const closedListeners = []
      const readyListeners = []
      const win = {
        pagePath,
        role: options.role || '',
        options,
        destroyed: false,
        shown: 0,
        focused: 0,
        isDestroyed: () => win.destroyed,
        setAlwaysOnTop: () => {},
        setContentProtection: () => {},
        setIgnoreMouseEvents: () => {},
        setBounds: () => {},
        setPosition: () => {},
        center: () => {},
        minimize: () => {},
        isMinimized: () => false,
        show: () => { win.shown += 1 },
        showInactive: () => {},
        hide: () => {},
        focus: () => { win.focused += 1 },
        loadFile: () => Promise.resolve(),
        on: (event, listener) => { if (event === 'closed') closedListeners.push(listener) },
        once: (event, listener) => { if (event === 'ready-to-show') readyListeners.push(listener) },
        close: () => {
          if (win.destroyed) return
          win.destroyed = true
          for (const listener of closedListeners) listener()
        },
        webContents: {
          id: ++contentsId,
          send: (channel, payload) => sent.push({ channel, payload, window: win }),
          mainFrame: { id: `frame-${pagePath}` },
          session: { setDisplayMediaRequestHandler: (handler) => { win.displayMediaHandler = handler } }
        },
        closedListeners,
        readyListeners
      }
      windows.push(win)
      windowsByContents.set(win.webContents, win)
      return win
    },
    getSettings: () => settings,
    log: () => {},
    assertGameModeDisabled: () => {},
    assertManagedDataWritable: () => {},
    getRecordingService: () => recordingService,
    peekRecordingService: () => recordingService,
    managedRecordingWriters: {
      track: async (task) => (typeof task === 'function' ? task() : task),
      assertOpen: () => {}
    },
    makeCaptureName: () => 'Highlighter_Video_2026-11-03.png',
    VIDEO_CAPTURE_PREFIX: 'Highlighter_Video',
    performanceMonitor: { record: () => {}, snapshot: () => {} },
    getRecordingExportService: () => exportService,
    getExportResultService: () => null,
    getRegionPreferences: () => null,
    getRecordingProjectService: () => projectService,
    getRecordingWorkbench: () => ({
      shell: { showItemInFolder: (target) => shellCalls.push(target) },
      updateSettings: (patch) => {
        updateSettingsCalls.push(patch)
        if (patch?.record) Object.assign(settings.record, patch.record)
      },
      createMainWindow: (route) => routes.push(route),
      backdropColor: () => '#101010',
      createRegionSelection: (options) => { regionSelections.push(options); return Promise.resolve({}) },
      positionAutomationWindow: () => false,
      refreshTray: () => trayRefreshes.push(Date.now())
    })
  })

  const controller = domain.createRecordingController()
  const editorWindow = () => windows.filter((win) => win.role === 'record-editor').at(-1) || null
  const controlWindow = () => windows.filter((win) => win.role === 'record-control').at(-1) || null
  const eventFor = (win) => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame })
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
  return {
    domain,
    controller,
    windows,
    sent,
    settings,
    updateSettingsCalls,
    regionSelections,
    routes,
    shellCalls,
    trayRefreshes,
    projectService,
    recordingService,
    exportService,
    display,
    editorWindow,
    controlWindow,
    eventFor,
    tick,
    setDialogResult: (value) => { dialogResult = value }
  }
}

test('repeat entry focuses the active control bar instead of replacing it (contract §10.1)', async () => {
  const harness = createProjectHarness()
  const first = await harness.domain.createRecordWindow({ mode: 'display' })
  assert.ok(first)
  const second = await harness.domain.createRecordWindow({ mode: 'display' })
  assert.equal(second, first, 'the second entry returns the SAME control window')
  assert.equal(harness.windows.length, 2, 'no extra frame/control windows are created')
  assert.equal(first.focused > 0 || first.shown > 0, true, 'the existing bar is brought forward')
  assert.equal(harness.domain.isTaskActive(), true)
})

test('record:init carries the R2 contract shape, the merged config and the E2E-only flag', async () => {
  const harness = createProjectHarness()
  const previous = process.env.HIGHLIGHTER_E2E_FAKE_CAPTURE
  process.env.HIGHLIGHTER_E2E_FAKE_CAPTURE = '1'
  let control
  try {
    control = await harness.domain.createRecordWindow({
      mode: 'region',
      display: harness.display,
      selectionBounds: { x: 10, y: 20, width: 200, height: 150 },
      capture: { frameRate: 60, quality: 'ultra', countdown: 0, audioSystem: false, audioMicrophone: true, audioMicrophoneDeviceId: 'device-7' }
    })
  } finally {
    if (previous === undefined) delete process.env.HIGHLIGHTER_E2E_FAKE_CAPTURE
    else process.env.HIGHLIGHTER_E2E_FAKE_CAPTURE = previous
  }
  const init = control._recordInit
  assert.equal(init.mode, 'region')
  assert.equal(init.frameRate, 60, 'the workbench override wins over settings')
  assert.equal(init.quality, 'ultra')
  assert.equal(init.countdownSeconds, 0)
  assert.deepEqual(init.audio, { system: false, microphone: true, microphoneDeviceId: 'device-7', systemGain: 1, microphoneGain: 1 })
  assert.equal(init.fakeCapture, true, 'only the main-process environment can enable the E2E source')
  assert.equal(init.sessionId, '')
  assert.equal(init.projectId, '')
  assert.equal(init.display.id, '1')
  assert.equal(init.display.name, 'DISPLAY1')
  assert.equal(init.display.scaleFactor, 1)
  assert.deepEqual(init.selectionBounds, { x: 10, y: 20, width: 200, height: 150 })
  // Legacy flat keys are still present for an older recorder build.
  assert.equal(init.audioSystem, false)
  assert.equal(init.audioMicrophone, true)
  // The project capture target records the SELECTION for region mode.
  assert.equal(control._recordCaptureConfig.target.mode, 'region')
  assert.deepEqual(control._recordCaptureConfig.target.boundsDip, { x: 10, y: 20, width: 200, height: 150 })
  assert.equal(control._recordCaptureConfig.target.displayId, '1')

  // Without the environment flag the init payload says false (default off).
  const plain = await createProjectHarness().domain.createRecordWindow({ mode: 'display' })
  assert.equal(plain._recordInit.fakeCapture, false)
})

test('capture config falls back from settings to shipped defaults and normalizes every axis', async () => {
  const harness = createProjectHarness()
  harness.settings.record.frameRate = 999
  harness.settings.record.quality = 'nonsense'
  harness.settings.record.countdown = 4
  const control = await harness.domain.createRecordWindow({ mode: 'display' })
  assert.equal(control._recordInit.frameRate, 24, 'an unsupported frame rate falls back to the normalized default')
  assert.equal(control._recordInit.quality, 'standard')
  assert.equal(control._recordInit.countdownSeconds, 3)
  assert.deepEqual(control._recordInit.audio, { system: true, microphone: false, microphoneDeviceId: '', systemGain: 1, microphoneGain: 1 })
})

test('record:start-session creates the project first and writes the session into it (contract §10.4)', async () => {
  const harness = createProjectHarness()
  const control = await harness.domain.createRecordWindow({ mode: 'display', capture: { frameRate: 30, quality: 'high' } })
  const answer = await harness.controller.startSession(harness.eventFor(control))
  assert.equal(answer.projectId, 'project-1')
  assert.ok(answer.id)
  assert.equal(harness.windows.length, 2, 'no editor opens on start')
  const createCall = harness.projectService.calls.find(([name]) => name === 'createProject')
  assert.equal(createCall[1].mode, 'display')
  assert.equal(createCall[1].captureConfig.frameRate, 30)
  assert.equal(createCall[1].captureConfig.quality, 'high')
  assert.equal(createCall[1].name, 'Highlighter_Video_2026-11-03', 'the capture-name template names the project')
  const startCall = harness.recordingService.calls.find(([name]) => name === 'startSession')
  assert.equal(startCall[1].projectId, 'project-1')
  assert.match(startCall[1].directory, /project-1$/, 'the session writes straight into the project directory')
  // The last VALID configuration is remembered (contract §4.1) ...
  const persisted = harness.updateSettingsCalls.find((patch) => patch?.record)
  assert.equal(persisted.record.lastMode, 'display')
  assert.equal(persisted.record.lastDisplayId, '1')
  assert.equal(persisted.record.frameRate, 30)
  // ... and the control bar's own state cache starts at `preparing`.
  const state = harness.controller.getState(harness.eventFor(control))
  assert.equal(state.status, 'preparing')
})

test('record:append-chunk acknowledges order and checkpoints the project without blocking (contract §10.5)', async () => {
  const harness = createProjectHarness()
  const control = await harness.domain.createRecordWindow({ mode: 'display' })
  const session = await harness.controller.startSession(harness.eventFor(control))
  const ack = await harness.controller.appendChunk(harness.eventFor(control), {
    sessionId: session.id,
    arrayBuffer: Buffer.from('12345'),
    sequence: 1,
    bytes: 5
  })
  assert.deepEqual(ack, { committedBytes: 5, sequence: 1, lastChunkSequence: 1 })
  await harness.tick()
  const checkpoint = harness.projectService.calls.find(([name]) => name === 'checkpoint')
  assert.ok(checkpoint, 'the manifest checkpoint is driven from the ACK')
  assert.equal(checkpoint[1], 'project-1')
  assert.equal(checkpoint[2].committedByteOffset, 5)
  assert.equal(checkpoint[2].lastChunkSequence, 1)

  // A chunk from another window is refused before the service is touched.
  const other = createProjectHarness()
  await other.domain.createRecordWindow({ mode: 'display' })
  await assert.rejects(
    () => other.controller.appendChunk(other.eventFor(other.controlWindow()), { sessionId: 'nope', arrayBuffer: Buffer.from('x'), sequence: 1 }),
    /录制会话不匹配/
  )
  assert.equal(other.recordingService.calls.some(([name]) => name === 'appendChunk'), false)
})

test('a chunk write failure surfaces instead of being swallowed', async () => {
  const failure = Object.assign(new Error('disk full'), { code: 'write-failed' })
  const harness = createProjectHarness({ recordingServiceOverrides: { appendError: failure } })
  const control = await harness.domain.createRecordWindow({ mode: 'display' })
  const session = await harness.controller.startSession(harness.eventFor(control))
  await assert.rejects(
    () => harness.controller.appendChunk(harness.eventFor(control), { sessionId: session.id, arrayBuffer: Buffer.from('abc'), sequence: 1 }),
    /disk full/
  )
})

test('record:finish-session seals the project, detaches the session and opens the editor (contract §10.6)', async () => {
  const harness = createProjectHarness()
  const control = await harness.domain.createRecordWindow({ mode: 'display' })
  const session = await harness.controller.startSession(harness.eventFor(control))
  await harness.controller.appendChunk(harness.eventFor(control), { sessionId: session.id, arrayBuffer: Buffer.from('abcdef'), sequence: 1 })
  const answer = await harness.controller.finishSession(harness.eventFor(control), { sessionId: session.id })
  assert.equal(answer.ok, true)
  assert.equal(answer.projectId, 'project-1')
  assert.equal(answer.recovered, false, 'a successful probe seals the project as ready')
  const seal = harness.projectService.calls.find(([name]) => name === 'sealProject')
  assert.equal(seal[1], 'project-1')
  assert.equal(seal[2].metadata.durationMs, 5000)
  assert.deepEqual(seal[2].captureOutcome.audio, { system: true, microphone: false }, 'captureOutcome reflects the requested buses and the probed audio track')
  assert.equal(harness.recordingService.calls.some(([name, id]) => name === 'detachSession' && id === session.id), true)
  // The source is NOT deleted: the project owns it now.
  const editor = harness.editorWindow()
  assert.ok(editor, 'the editor window opens on finish')
  assert.equal(editor._recordProjectId, 'project-1')
  await harness.tick()
  assert.equal(control.destroyed, true, 'the control bar closes after the reply is queued')
  assert.equal(harness.projectService.calls.some(([name]) => name === 'deleteProject'), false)
})

test('a probe failure still seals into a recoverable project and opens a read-only editor', async () => {
  const harness = createProjectHarness({ recordingServiceOverrides: { probeAnswer: { ok: false, code: 'no-video-track' } } })
  const control = await harness.domain.createRecordWindow({ mode: 'display' })
  const session = await harness.controller.startSession(harness.eventFor(control))
  const answer = await harness.controller.finishSession(harness.eventFor(control), { sessionId: session.id })
  assert.equal(answer.ok, true)
  assert.equal(answer.recovered, true, 'the caller is told the project is not exportable')
  const seal = harness.projectService.calls.find(([name]) => name === 'sealProject')
  assert.equal(seal[2].metadata, null, 'a failed probe never invents metadata')
  await harness.tick()
  const editor = harness.editorWindow()
  assert.ok(editor, 'a recoverable project still opens, read-only')
  assert.equal(editor._recordEditorInit.recovery.state, 'recoverable')
  assert.equal(editor._recordEditorInit.recovery.errorCode, 'probe-failed')
})

test('finish keeps the control bar usable when the session or the manifest write fails', async () => {
  const finishFailure = createProjectHarness({ recordingServiceOverrides: { finishError: Object.assign(new Error('empty'), { code: 'finish-failed' }) } })
  const firstControl = await finishFailure.domain.createRecordWindow({ mode: 'display' })
  const firstSession = await finishFailure.controller.startSession(finishFailure.eventFor(firstControl))
  const failedFinish = await finishFailure.controller.finishSession(finishFailure.eventFor(firstControl), { sessionId: firstSession.id })
  assert.deepEqual(failedFinish, { ok: false, code: 'finish-failed' })
  assert.equal(firstControl.destroyed, false, 'the bar stays for a retry or an abandon')

  const sealFailure = createProjectHarness({ projectServiceOverrides: { sealAnswer: { ok: false, code: 'write-failed' } } })
  const control = await sealFailure.domain.createRecordWindow({ mode: 'display' })
  const session = await sealFailure.controller.startSession(sealFailure.eventFor(control))
  const failedSeal = await sealFailure.controller.finishSession(sealFailure.eventFor(control), { sessionId: session.id })
  assert.deepEqual(failedSeal, { ok: false, code: 'write-failed' })
  assert.equal(control.destroyed, false)
  assert.equal(sealFailure.recordingService.calls.some(([name]) => name === 'detachSession'), false, 'the source stays owned until a manifest proves durable')
})

test('record:cancel-session abandons the take, deletes its project and answers { ok:true } (contract §9.2/§10.7)', async () => {
  const harness = createProjectHarness()
  const control = await harness.domain.createRecordWindow({ mode: 'display' })
  const session = await harness.controller.startSession(harness.eventFor(control))
  assert.deepEqual(await harness.controller.cancelSession(harness.eventFor(control), { sessionId: session.id }), { ok: true })
  assert.equal(harness.recordingService.calls.some(([name, id]) => name === 'cleanupSession' && id === session.id), true)
  assert.equal(harness.projectService.calls.some(([name, id]) => name === 'deleteProject' && id === 'project-1'), true)
  assert.equal(harness.projectService.projects.has('project-1'), false)
})

test('the control bar reports state and the main process arbitrates tray/shortcut commands (contract §9.2)', async () => {
  const harness = createProjectHarness()
  const control = await harness.domain.createRecordWindow({ mode: 'display' })
  const session = await harness.controller.startSession(harness.eventFor(control))
  assert.equal(harness.domain.pauseResumeActive(), false, 'nothing is recording yet')
  // The renderer reports `recording`, then the tray's pause must dispatch ONE command.
  harness.controller.state(harness.eventFor(control), { sessionId: session.id, status: 'recording', elapsedMs: 1200, microphoneMuted: false, stateVersion: 1 })
  assert.equal(harness.domain.getActiveState().status, 'recording')
  assert.equal(harness.domain.pauseResumeActive(), true)
  const command = harness.sent.filter((entry) => entry.channel === 'record:command').at(-1)
  assert.equal(command.payload.command, 'pause')
  assert.equal(typeof command.payload.requestId, 'string')
  assert.ok(command.payload.requestId.length > 0)
  // R2 (contracts §9.2): issueCommand must NOT echo the PRE-command cached state; the POST-command
  // state is pushed when the renderer reports its command result, so the version guard can adopt it.
  assert.equal(
    harness.sent.filter((entry) => entry.channel === 'record:state-changed').length,
    0,
    'a command push alone does not echo state'
  )
  // The renderer acknowledges; a paused state makes the same entry resume.
  harness.controller.commandResult(harness.eventFor(control), { requestId: command.payload.requestId, ok: true, state: { status: 'paused', stateVersion: 2 } })
  const echo = harness.sent.filter((entry) => entry.channel === 'record:state-changed').at(-1)
  assert.ok(echo, 'the post-command state is echoed')
  assert.equal(echo.payload.status, 'paused', 'the echo carries the POST-command state')
  assert.equal(echo.payload.stateVersion, 2)
  assert.equal(harness.domain.getActiveState().status, 'paused')
  assert.equal(harness.domain.pauseResumeActive(), true)
  assert.equal(harness.sent.filter((entry) => entry.channel === 'record:command').at(-1).payload.command, 'resume')
  // Finish is dispatched from `recording`.
  harness.controller.state(harness.eventFor(control), { sessionId: session.id, status: 'recording', stateVersion: 3 })
  assert.equal(harness.domain.finishActive(), true)
  assert.equal(harness.sent.filter((entry) => entry.channel === 'record:command').at(-1).payload.command, 'stop')
  assert.equal(harness.controller.getState(harness.eventFor(control)).stateVersion, 3)
  // A stale push cannot roll the cache back, and a foreign session id is ignored (not thrown).
  harness.controller.state(harness.eventFor(control), { sessionId: session.id, status: 'countdown', stateVersion: 1 })
  assert.equal(harness.controller.getState(harness.eventFor(control)).status, 'recording')
  const foreign = harness.controller.state(harness.eventFor(control), { sessionId: 'other', status: 'paused', stateVersion: 9 })
  assert.equal(foreign.status, 'recording')
  // The tray template is a snapshot: a live/paused status change must rebuild it so the pause
  // entry flips to resume (and the group disappears once the capture is no longer live).
  assert.ok(harness.trayRefreshes.length >= 2, 'a live and a paused status each refresh the tray')
  const refreshesBefore = harness.trayRefreshes.length
  harness.controller.state(harness.eventFor(control), { sessionId: session.id, status: 'recording', elapsedMs: 1500, stateVersion: 4 })
  assert.equal(harness.trayRefreshes.length, refreshesBefore, 'an elapsed-time tick on the same status does not rebuild')
})

test('the workbench reads config/displays/recent and starts a capture with the workbench override', async () => {
  const harness = createProjectHarness()
  harness.settings.record.lastMode = 'region'
  harness.settings.record.lastDisplayId = '2'
  harness.settings.record.quality = 'high'
  const state = await harness.controller.workbenchState()
  assert.equal(state.config.mode, 'region')
  assert.equal(state.config.quality, 'high')
  assert.equal(state.config.frameRate, 24)
  assert.equal(state.config.audioSystem, true)
  assert.equal(state.displays.length, 2)
  assert.deepEqual(state.displays[0], { id: '1', name: 'DISPLAY1', width: 800, height: 600, scaleFactor: 1, primary: true, label: '1 · 800×600' })
  assert.equal(state.displays[1].primary, false)
  assert.equal(state.active, null)
  assert.deepEqual(state.recent, [])

  // Display start honours the payload config.
  const started = await harness.controller.workbenchStart(null, { mode: 'display', displayId: '1', config: { frameRate: 60, countdown: 0 } })
  assert.deepEqual(started, { ok: true })
  const control = harness.controlWindow()
  assert.equal(control._recordInit.frameRate, 60)
  assert.equal(control._recordInit.countdownSeconds, 0)
  // A second start focuses the running task instead of replacing it.
  const again = await harness.controller.workbenchStart(null, { mode: 'display' })
  assert.deepEqual(again, { ok: true, focused: true })
  assert.equal(harness.windows.length, 2)
  assert.equal(harness.controller.workbenchFocus().ok, true)

  // Region start reuses the capture overlay and carries the workbench's parameters through the
  // one-shot slot the overlay's createRecordWindow() consumes.
  const regionHarness = createProjectHarness()
  await regionHarness.controller.workbenchStart(null, { mode: 'region', config: { quality: 'ultra' } })
  assert.equal(regionHarness.regionSelections.length, 1)
  assert.equal(regionHarness.regionSelections[0].mode, 'region')
  const regionControl = await regionHarness.domain.createRecordWindow({ display: regionHarness.display, selectionBounds: { x: 0, y: 0, width: 100, height: 100 } })
  assert.equal(regionControl._recordMode, 'region')
  assert.equal(regionControl._recordInit.quality, 'ultra')
})

test('the workbench records page: list/open/rename/delete/reveal stay path-free and role-safe', async () => {
  const harness = createProjectHarness()
  harness.projectService.projects.set('project-1', makeProject({ id: 'project-1', state: 'ready' }))
  const listed = await harness.controller.projectList(null, { offset: 0, limit: 10 })
  assert.equal(listed.items.length, 1)
  assert.equal(listed.items[0].id, 'project-1')
  assert.equal(listed.total, 1)

  const renamed = await harness.controller.projectRename(null, { projectId: 'project-1', name: '  Demo  ' })
  assert.equal(renamed.ok, true)
  assert.equal(renamed.project.name, '  Demo  ')

  // Reveal resolves the project id in the main process; the renderer never names a directory.
  const revealed = await harness.controller.projectReveal(null, { projectId: 'project-1' })
  assert.equal(revealed.ok, true)
  assert.match(harness.shellCalls.at(-1), /project-1/)

  // Capturing projects are busy; an open editor is a lease; a running export blocks deletion.
  harness.projectService.projects.set('project-busy', makeProject({ id: 'project-busy', state: 'capturing' }))
  assert.deepEqual(await harness.controller.projectDelete(null, { projectId: 'project-busy' }), { ok: false, code: 'busy' })
  assert.equal((await harness.controller.projectOpen(null, { projectId: 'project-busy' })).code, 'project-busy')

  const opened = await harness.controller.projectOpen(null, { projectId: 'project-1' })
  assert.deepEqual(opened, { ok: true })
  assert.deepEqual(await harness.controller.projectDelete(null, { projectId: 'project-1' }), { ok: false, code: 'busy' })

  const deleted = await harness.controller.projectDelete(null, { projectId: 'project-not-open' })
  assert.equal(deleted.ok, false, 'an unknown project is not silently reported as deleted')
  harness.projectService.projects.set('project-2', makeProject({ id: 'project-2', state: 'ready' }))
  assert.deepEqual(await harness.controller.projectDelete(null, { projectId: 'project-2' }), { ok: true })
  assert.equal(harness.projectService.projects.has('project-2'), false)
})

test('openEditor reuses the window, refuses a capturing project and recovers a recoverable one (contract §10)', async () => {
  const harness = createProjectHarness()
  harness.projectService.projects.set('project-1', makeProject({ id: 'project-1', state: 'ready' }))
  assert.deepEqual(await harness.domain.openEditor('project-1'), { ok: true })
  const first = harness.editorWindow()
  assert.equal(first._recordProjectId, 'project-1')
  assert.equal(first._recordEditorInit.project.id, 'project-1')
  assert.match(first._recordEditorInit.sourceUrl, /^file:\/\//, 'the editor receives a derived file URL, never a raw path')
  assert.equal(first._recordEditorInit.metadata.durationMs, 5000)
  assert.deepEqual(first._recordEditorInit.recovery, { state: 'ready', errorCode: '' })
  // Reuse, not a second window.
  assert.deepEqual(await harness.domain.openEditor('project-1'), { ok: true })
  assert.equal(harness.windows.filter((win) => win.role === 'record-editor').length, 1)
  assert.equal(first.focused > 0 || first.shown > 0, true)

  harness.projectService.projects.set('project-capturing', makeProject({ id: 'project-capturing', state: 'capturing' }))
  assert.deepEqual(await harness.domain.openEditor('project-capturing'), { ok: false, code: 'project-busy' })
  assert.deepEqual(await harness.domain.openEditor('missing'), { ok: false, code: 'not-found' })

  // Recoverable: the probe succeeds -> the project becomes ready before the editor opens.
  harness.projectService.projects.set('project-recoverable', makeProject({ id: 'project-recoverable', state: 'recoverable' }))
  assert.deepEqual(await harness.domain.openEditor('project-recoverable'), { ok: true })
  assert.equal(harness.projectService.calls.some(([name, id]) => name === 'markReady' && id === 'project-recoverable'), true)
  const recovered = harness.windows.filter((win) => win.role === 'record-editor').at(-1)
  assert.equal(recovered._recordEditorInit.recovery.state, 'ready')

  // Recoverable with a failing probe: still opens, read-only, with the reason.
  const failing = createProjectHarness({ recordingServiceOverrides: { probeAnswer: { ok: false, code: 'unreadable-media' } } })
  failing.projectService.projects.set('project-bad', makeProject({ id: 'project-bad', state: 'recoverable' }))
  assert.deepEqual(await failing.domain.openEditor('project-bad'), { ok: true })
  const readOnly = failing.windows.filter((win) => win.role === 'record-editor').at(-1)
  assert.equal(readOnly._recordEditorInit.recovery.state, 'recoverable')
  assert.equal(failing.projectService.calls.some(([name]) => name === 'markRecoverable'), true)
})

test('the editor sends its init on ready and handles window actions', async () => {
  const harness = createProjectHarness()
  harness.projectService.projects.set('project-1', makeProject({ id: 'project-1', state: 'ready' }))
  await harness.domain.openEditor('project-1')
  const editor = harness.editorWindow()
  harness.controller.editorReady(harness.eventFor(editor))
  const init = harness.sent.filter((entry) => entry.channel === 'record-editor:init').at(-1)
  assert.equal(init.payload.project.id, 'project-1')
  assert.equal(harness.controller.editorWindow(harness.eventFor(editor), { action: 'minimize' }), true)
  assert.equal(harness.controller.editorWindow(harness.eventFor(editor), { action: 'bogus' }), true)
  harness.controller.editorClose(harness.eventFor(editor))
  assert.equal(editor.destroyed, true)
  assert.equal(harness.domain.ownsEditorWindow(editor), false)
})

test('draft writes use compare-and-set and a conflict carries the current project (contract §9.3)', async () => {
  const harness = createProjectHarness()
  harness.projectService.projects.set('project-1', makeProject({ id: 'project-1', state: 'ready' }))
  await harness.domain.openEditor('project-1')
  const editor = harness.editorWindow()
  const saved = await harness.controller.editorSaveDraft(harness.eventFor(editor), {
    projectId: 'project-1',
    expectedRevision: 1,
    edit: { keepRanges: [{ id: 'keep-1', startMs: 100, endMs: 900 }], format: 'gif', gif: { edge: 1280, fps: 15 }, revision: 99, extra: 'dropped' }
  })
  assert.deepEqual(saved, { ok: true, revision: 2 })
  // The domain never lets a renderer rewrite `revision`/unknown fields into the manifest.
  const update = harness.projectService.calls.find(([name]) => name === 'updateDraft')
  assert.equal(update[2].edit.revision, undefined)
  assert.equal(update[2].edit.extra, undefined)
  assert.deepEqual(update[2].edit.keepRanges, [{ id: 'keep-1', startMs: 100, endMs: 900 }])

  const conflict = await harness.controller.editorSaveDraft(harness.eventFor(editor), { projectId: 'project-1', expectedRevision: 1, edit: {} })
  assert.equal(conflict.ok, false)
  assert.equal(conflict.code, 'revision-conflict')
  assert.equal(conflict.revision, 2)
  assert.equal(conflict.project.id, 'project-1', 'the editor can reload in place')
})

test('editor export uses the project session, the save dialog and records the finished export', async () => {
  const harness = createProjectHarness()
  harness.projectService.projects.set('project-1', makeProject({ id: 'project-1', state: 'ready', name: 'Demo' }))
  await harness.domain.openEditor('project-1')
  const editor = harness.editorWindow()

  // A dismissed dialog creates no task.
  const cancelled = await harness.controller.editorExport(harness.eventFor(editor), {
    projectId: 'project-1',
    requestId: 'req-1',
    request: { format: 'mp4', range: { startMs: 0, endMs: 5000 } }
  })
  assert.deepEqual(cancelled, { status: 'cancelled' })
  assert.equal(harness.exportService.submitted.length, 0)

  harness.setDialogResult({ canceled: false, filePath: path.resolve('tmp', 'out.mp4') })
  const accepted = await harness.controller.editorExport(harness.eventFor(editor), {
    projectId: 'project-1',
    requestId: 'req-2',
    request: { format: 'mp4', range: { startMs: 0, endMs: 5000 } }
  })
  assert.equal(accepted.status, 'accepted')
  const submitted = harness.exportService.submitted.at(-1)
  assert.equal(submitted.sessionId, 'project-1', 'the export borrows the project session')
  assert.equal(submitted.request.format, 'mp4')
  assert.deepEqual(submitted.request.range, { startMs: 0, endMs: 5000 })
  assert.match(submitted.targetPath, /out\.mp4$/)
  assert.match(submitted.ownerId, /^web-contents:/)
  const progress = harness.sent.filter((entry) => entry.channel === 'record:export-progress')
  assert.equal(progress.at(-1).payload.state, 'succeeded')
  await harness.tick()
  const appended = harness.projectService.calls.find(([name]) => name === 'appendExport')
  assert.ok(appended, 'the finished export is recorded on the project')
  assert.equal(appended[1], 'project-1')
  assert.equal(appended[2].exportId, 'task-1')
  assert.equal(appended[2].fileName, 'out.mp4')
  assert.equal(appended[2].editRevision, 1)

  // A recoverable project has no verified duration, so it must not export. (The probe keeps
  // failing here, which is why the project stays recoverable after openEditor's retry.)
  const failing = createProjectHarness({ recordingServiceOverrides: { probeAnswer: { ok: false, code: 'unreadable-media' } } })
  failing.projectService.projects.set('project-bad', makeProject({ id: 'project-bad', state: 'recoverable' }))
  await failing.domain.openEditor('project-bad')
  const notReady = await failing.controller.editorExport(failing.eventFor(failing.editorWindow()), { projectId: 'project-bad', requestId: 'req-3', request: { format: 'mp4', range: { startMs: 0, endMs: 1000 } } })
  assert.deepEqual(notReady, { status: 'failed', code: 'not-ready' })
})

test('editor reload re-probes the source and rename/reveal/rerecord/back stay project-scoped', async () => {
  const harness = createProjectHarness()
  harness.projectService.projects.set('project-1', makeProject({ id: 'project-1', state: 'ready' }))
  await harness.domain.openEditor('project-1')
  const editor = harness.editorWindow()

  harness.projectService.projects.set('project-1', makeProject({ id: 'project-1', state: 'recoverable' }))
  const reloaded = await harness.controller.editorReload(harness.eventFor(editor), { projectId: 'project-1' })
  assert.equal(reloaded.ok, true)
  assert.equal(reloaded.project.id, 'project-1')
  assert.match(reloaded.sourceUrl, /^file:\/\//)
  assert.equal(harness.projectService.calls.some(([name]) => name === 'markReady'), true)

  const renamed = await harness.controller.editorRename(harness.eventFor(editor), { projectId: 'project-1', name: 'Take 2' })
  assert.equal(renamed.ok, true)
  assert.equal(renamed.project.name, 'Take 2')
  assert.equal((await harness.controller.editorReveal(harness.eventFor(editor), { projectId: 'project-1' })).ok, true)

  // A project that does not belong to this window is refused (per-window ownership).
  await assert.rejects(
    () => harness.controller.editorRename(harness.eventFor(editor), { projectId: 'project-other', name: 'x' }),
    /does not belong/
  )

  // Back closes the editor and returns to the workbench route.
  const backHarness = createProjectHarness()
  backHarness.projectService.projects.set('project-back', makeProject({ id: 'project-back', state: 'ready' }))
  await backHarness.domain.openEditor('project-back')
  const backEditor = backHarness.editorWindow()
  assert.deepEqual(backHarness.controller.editorBack(backHarness.eventFor(backEditor)), { ok: true })
  assert.equal(backEditor.destroyed, true, 'back closes the editor window')
  assert.deepEqual(backHarness.routes.at(-1), 'recording', 'the workbench route comes back in front')

  const rerecorded = await harness.controller.editorRerecord(harness.eventFor(editor), { projectId: 'project-1' })
  assert.deepEqual(rerecorded, { ok: true })
  assert.equal(editor.destroyed, true, 'the old editor closes')
  assert.equal(harness.windows.filter((win) => win.role === 'record-control').length, 1, 'a new capture starts with the same config')
  assert.equal(harness.projectService.calls.some(([name]) => name === 'deleteProject'), false, 'the old project is kept')
})

test('shutdown cancels exports first, flushes projects, then releases sessions (contract §10)', async () => {
  const order = []
  const harness = createProjectHarness({
    projectService: { ...createProjectServiceStub(), dispose: async () => { order.push('project') } },
    recordingService: { ...createRecordingServiceStub(), dispose: async () => { order.push('recording') } },
    exportService: { ...createExportServiceStub(), dispose: async () => { order.push('export') } }
  })
  await harness.domain.createRecordWindow({ mode: 'display' })
  await harness.domain.shutdown()
  assert.deepEqual(order, ['export', 'project', 'recording'])
  assert.equal(harness.controlWindow()?.destroyed, true)
})

test('the project service being unavailable degrades to codes instead of throwing', async () => {
  const harness = createProjectHarness()
  const { createRecordDomain } = require('../main/domains/record')
  const broken = createRecordDomain({
    app: { getPath: () => path.resolve('tmp') },
    desktopCapturer: { getSources: async () => [{ id: 'screen:1', display_id: '1' }] },
    path,
    screen: {
      getAllDisplays: () => [],
      getPrimaryDisplay: () => ({ id: 1, bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { x: 0, y: 0, width: 800, height: 600 } }),
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      getDisplayNearestPoint: () => ({ id: 1, bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { x: 0, y: 0, width: 800, height: 600 } }),
      getDisplayMatching: () => ({ id: 1, bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { x: 0, y: 0, width: 800, height: 600 } })
    },
    dialog: { showSaveDialog: async () => ({ canceled: true }) },
    BrowserWindow: { fromWebContents: () => null },
    rootDirectory: root,
    createLocalWindow: () => { throw new Error('not used') },
    getSettings: () => harness.settings,
    log: () => {},
    assertGameModeDisabled: () => {},
    assertManagedDataWritable: () => {},
    getRecordingService: () => harness.recordingService,
    peekRecordingService: () => harness.recordingService,
    managedRecordingWriters: { track: async (task) => (typeof task === 'function' ? task() : task), assertOpen: () => {} },
    makeCaptureName: () => 'Recording',
    VIDEO_CAPTURE_PREFIX: 'Recording',
    performanceMonitor: { record: () => {}, snapshot: () => {} },
    getRecordingProjectService: () => { throw new Error('missing persistence module') }
  })
  const controller = broken.createRecordingController()
  assert.equal((await controller.projectList(null, {})).code, 'project-service-unavailable')
  assert.equal((await controller.projectReveal(null, { projectId: 'p' })).code, 'project-service-unavailable')
  assert.equal((await controller.projectDelete(null, { projectId: 'p' })).code, 'project-service-unavailable')
  assert.equal((await controller.projectOpen(null, { projectId: 'p' })).code, 'not-found')
  assert.deepEqual((await controller.workbenchState()).recent, [])
})

test('createRecordingProjectRef constructs the service lazily and resets on demand', () => {
  const { createRecordingProjectRef } = require('../main/domains/record')
  const ref = createRecordingProjectRef({ root: path.resolve('recordings-root'), log: () => {} })
  assert.equal(ref.root, path.resolve('recordings-root'))
  assert.equal(ref.peek(), null, 'nothing is constructed until the first recording action')
  const service = ref.get()
  assert.equal(typeof service.createProject, 'function')
  assert.equal(ref.get(), service, 'the instance is reused')
  ref.reset()
  assert.equal(ref.peek(), null)
  assert.notEqual(ref.get(), service, 'reset rebuilds it (data-root migration)')
  assert.throws(() => createRecordingProjectRef({ root: '', log: () => {} }).get(), /data directory/)
})

// --------------------------------------------------------------------------------------------
// W2b fix round (task-7): p1's contract-review findings, asserted as behaviour.
// --------------------------------------------------------------------------------------------

test('D1: closing the editor detaches its project session and never deletes the project', async () => {
  const harness = createProjectHarness()
  harness.projectService.projects.set('project-1', makeProject({ id: 'project-1', state: 'ready' }))
  await harness.domain.openEditor('project-1')
  const editor = harness.editorWindow()
  assert.equal(harness.recordingService.sessions.has('project-1'), true, 'opening the editor attaches the project session')
  assert.equal(harness.recordingService.calls.some(([name]) => name === 'registerPersistedSession'), true)

  editor.close()
  assert.equal(harness.domain.ownsEditorWindow(editor), false)
  assert.equal(harness.recordingService.sessions.has('project-1'), false, 'closing releases the session handle')
  assert.equal(
    harness.recordingService.calls.some(([name, id]) => name === 'detachSession' && id === 'project-1'),
    true,
    'the release is a detach, not a directory delete'
  )
  // The project (its manifest and capture.webm) is untouched: only the editor lease went away.
  assert.equal(harness.projectService.calls.some(([name]) => name === 'deleteProject'), false)
  assert.equal(harness.projectService.projects.has('project-1'), true)

  // Records can be reopened afterwards; the session is re-attached for the new window and released
  // again on the back path.
  assert.deepEqual(await harness.domain.openEditor('project-1'), { ok: true })
  assert.equal(harness.recordingService.sessions.has('project-1'), true)
  const reopened = harness.editorWindow()
  assert.deepEqual(harness.controller.editorBack(harness.eventFor(reopened)), { ok: true })
  assert.equal(harness.recordingService.sessions.has('project-1'), false, 'editorBack releases the session too')
  assert.equal(harness.projectService.projects.has('project-1'), true)
})

test('D1: a live export lease defers the session release instead of detaching under ffmpeg', async () => {
  const harness = createProjectHarness()
  harness.projectService.projects.set('project-1', makeProject({ id: 'project-1', state: 'ready' }))
  await harness.domain.openEditor('project-1')
  const session = harness.recordingService.sessions.get('project-1')
  session.references = 1
  harness.editorWindow().close()
  assert.equal(
    harness.recordingService.calls.some(([name, id]) => name === 'detachSession' && id === 'project-1'),
    false,
    'a referenced session is never detached mid-export'
  )
  assert.equal(
    harness.recordingService.calls.some(([name, id]) => name === 'cleanupSession' && id === 'project-1'),
    true,
    'the release goes through cleanupSession, which defers removal to the last release'
  )
  assert.equal(session.pendingClose, true)
  assert.equal(harness.recordingService.sessions.has('project-1'), true, 'the table entry stays while the lease is out')

  // A QUEUED (not yet started) export must not be broken by detaching the handle it is about to
  // acquire: the entry stays until that task reaches a terminal state.
  const queued = createProjectHarness()
  queued.projectService.projects.set('project-1', makeProject({ id: 'project-1', state: 'ready' }))
  queued.exportService.tasks.push({ taskId: 'task-queued', sessionId: 'project-1', state: 'queued' })
  await queued.domain.openEditor('project-1')
  queued.editorWindow().close()
  assert.equal(queued.recordingService.sessions.has('project-1'), true, 'a queued export keeps its session handle')
  assert.equal(
    queued.recordingService.calls.some(([name, id]) => name === 'detachSession' && id === 'project-1'),
    false
  )
  // Once the task is gone the release returns to a plain detach (reopen + close proves the path).
  queued.exportService.tasks.splice(0, queued.exportService.tasks.length)
  await queued.domain.openEditor('project-1')
  queued.editorWindow().close()
  assert.equal(queued.recordingService.sessions.has('project-1'), false, 'with no task left the release returns to a detach')
})

test('D2: a chunk sequence gap resolves an ordering ACK instead of rejecting the invoke', async () => {
  const harness = createProjectHarness()
  const control = await harness.domain.createRecordWindow({ mode: 'display' })
  const session = await harness.controller.startSession(harness.eventFor(control))
  const first = await harness.controller.appendChunk(harness.eventFor(control), { sessionId: session.id, arrayBuffer: Buffer.from('aa'), sequence: 1 })
  assert.equal(first.code, undefined)
  assert.equal(first.lastChunkSequence, 1)

  // Skip 2 -> 3: an ordering failure the renderer must be able to localize, so it RESOLVES.
  const gap = await harness.controller.appendChunk(harness.eventFor(control), { sessionId: session.id, arrayBuffer: Buffer.from('bb'), sequence: 3 })
  assert.equal(gap.code, 'sequence-gap')
  assert.equal(gap.expected, 2)
  assert.equal(gap.received, 3)
  assert.equal(gap.lastChunkSequence, 1, 'the ACK carries the last ACCEPTED sequence so classifyChunkAck yields gap')
  assert.equal(gap.committedBytes, 2)
  assert.equal(harness.recordingService.sessions.get(session.id).bytesWritten, 2, 'the gapped chunk is not written')

  // Replaying an accepted sequence stays idempotent (still no error, same ACK).
  const replay = await harness.controller.appendChunk(harness.eventFor(control), { sessionId: session.id, arrayBuffer: Buffer.from('aa'), sequence: 1 })
  assert.equal(replay.code, undefined)
  assert.equal(replay.lastChunkSequence, 1)
})

test('D3: an invalid or missing chunk sequence is surfaced, never downgraded to a legacy append', async () => {
  const harness = createProjectHarness()
  const control = await harness.domain.createRecordWindow({ mode: 'display' })
  const session = await harness.controller.startSession(harness.eventFor(control))

  const invalid = await harness.controller.appendChunk(harness.eventFor(control), { sessionId: session.id, arrayBuffer: Buffer.from('aa'), sequence: 0 })
  assert.equal(invalid.code, 'invalid-sequence')
  assert.equal(invalid.received, 0)
  assert.equal(invalid.expected, 1)
  assert.equal(harness.recordingService.sessions.get(session.id).bytesWritten, 0, 'nothing was appended')

  const callsBefore = harness.recordingService.calls.filter(([name]) => name === 'appendChunk').length
  const missing = await harness.controller.appendChunk(harness.eventFor(control), { sessionId: session.id, arrayBuffer: Buffer.from('aa') })
  assert.equal(missing.code, 'invalid-sequence')
  assert.equal(missing.received, null)
  assert.equal(missing.sequence, null)
  assert.equal(
    harness.recordingService.calls.filter(([name]) => name === 'appendChunk').length,
    callsBefore,
    'a sequence-less chunk never reaches the service (it would disable gap detection)'
  )
})

test('R3: the region quick entry focuses an active capture instead of opening a discarded selection', async () => {
  const harness = createProjectHarness()
  const inactive = await harness.domain.startRegionRecording()
  assert.deepEqual(inactive, { ok: true })
  assert.equal(harness.regionSelections.length, 1, 'no capture yet: the selection overlay opens')

  const control = await harness.domain.createRecordWindow({ mode: 'display' })
  control.focused = 0
  const active = await harness.domain.startRegionRecording()
  assert.deepEqual(active, { ok: true, focused: true })
  assert.equal(harness.regionSelections.length, 1, 'a running capture must not open a selection whose rectangle would be discarded')
  assert.ok(control.focused > 0, 'the running control bar is brought forward')
})

test('R1: shutdown accepts a bounded timeout for the app-exit path and still orders a normal cleanup', async () => {
  const hanging = createProjectHarness({
    projectService: { ...createProjectServiceStub(), dispose: () => new Promise(() => {}) },
    recordingService: createRecordingServiceStub(),
    exportService: createExportServiceStub()
  })
  const startedAt = Date.now()
  const bounded = await hanging.domain.shutdown({ timeoutMs: 30 })
  assert.deepEqual(bounded, { ok: false, timedOut: true })
  assert.ok(Date.now() - startedAt < 2000, 'a wedged child cannot hang quit')

  const order = []
  const normal = createProjectHarness({
    projectService: { ...createProjectServiceStub(), dispose: async () => { order.push('project') } },
    recordingService: { ...createRecordingServiceStub(), dispose: async () => { order.push('recording') } },
    exportService: { ...createExportServiceStub(), dispose: async () => { order.push('export') } }
  })
  assert.deepEqual(await normal.domain.shutdown({ timeoutMs: 3000 }), { ok: true, timedOut: false })
  assert.deepEqual(order, ['export', 'project', 'recording'])
})
