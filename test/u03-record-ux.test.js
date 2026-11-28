'use strict'

// U03 regression tests (2026-11-26 code review §4.3, recording & editor UX).
//
// Five defects, each asserted through behaviour rather than source text:
//   1. "Record again" on a WINDOW project re-binds the saved target window (it used to fall
//      through to a silent full-display take) and returns an explicit workbench fallback when
//      the target window no longer exists.
//   2. A project opened after an app restart keeps the frame rate recorded in its capture
//      configuration (it used to be 0, so the editor could not offer 30/60 FPS export).
//   3. The frozen window output canvas follows the real first-frame source size instead of the
//      desktopCapturer thumbnail measurement clamped to 1920x1080, and own windows are filtered
//      by their native media source id as well as by the frozen exact title.
//   4. The mixer no longer statically halves a dual-bus take (-6 dB); it sums at unity gain and
//      protects the encoder input with a DynamicsCompressorNode soft limiter.
//   5. A Direct-Track take disables the annotation entrance and shows a localized reason before
//      the take starts, instead of letting the first stroke interrupt the recording.

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const { createRecordDomain } = require('../main/domains/record')
const { createRecordWindowHarness } = require('./helpers/record-window-harness')
const audioMixer = require('../record/audio-mixer')
const { LIMITER_SETTINGS, createAudioMix, createGainPlan } = audioMixer

const root = path.join(__dirname, '..')

// --------------------------------------------------------------------------------------------
// Fixtures: a real domain instance wired to in-memory doubles, mirroring test/record-domain.test.js
// but limited to the project/editor paths this ticket touches.
// --------------------------------------------------------------------------------------------

function makeCaptureConfig(overrides = {}) {
  return {
    target: {
      mode: 'display',
      displayId: '1',
      displayName: 'DISPLAY1',
      boundsDip: { x: 0, y: 0, width: 1920, height: 1080 },
      pixelSize: { width: 1920, height: 1080 },
      scaleFactor: 1
    },
    frameRate: 30,
    quality: 'standard',
    countdown: 3,
    audio: { system: true, microphone: false, microphoneDeviceId: '', systemGain: 1, microphoneGain: 1 },
    ...overrides
  }
}

function makeProject(overrides = {}) {
  const id = overrides.id || 'project-1'
  return {
    id,
    name: overrides.name || 'Recording',
    mode: overrides.mode || 'display',
    state: overrides.state || 'ready',
    createdAt: 1,
    updatedAt: 2,
    captureConfig: overrides.captureConfig || makeCaptureConfig(),
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
    recovery: { committedByteOffset: 0, lastChunkSequence: 0, cleanStop: true, errorCode: '' }
  }
}

function makeWindowProject(id, title, overrides = {}) {
  return makeProject({
    id,
    mode: 'window',
    captureConfig: makeCaptureConfig({
      target: {
        mode: 'window',
        displayId: '',
        displayName: title,
        boundsDip: { x: 0, y: 0, width: 1600, height: 900 },
        pixelSize: { width: 1600, height: 900 },
        scaleFactor: 1
      },
      ...overrides
    })
  })
}

function createProjectServiceStub() {
  const projects = new Map()
  const calls = []
  return {
    projects,
    calls,
    projectDirectory: (projectId) => path.resolve('recordings', String(projectId || '')),
    sourcePathOf: async (projectId) => (projects.has(String(projectId)) ? path.resolve('recordings', String(projectId), 'capture.webm') : ''),
    getProject: async (projectId) => projects.get(String(projectId)) || null,
    listProjects: async ({ offset = 0, limit = 20 } = {}) => {
      const items = [...projects.values()].map((project) => ({ id: project.id, name: project.name, state: project.state }))
      return { items: items.slice(offset, offset + limit), total: items.length, offset, limit }
    },
    createProject: async ({ mode, captureConfig, name } = {}) => {
      const id = `project-${projects.size + 1}`
      const project = makeProject({ id, mode, name, captureConfig })
      projects.set(id, project)
      return { project, directory: path.resolve('recordings', id) }
    },
    appendExport: async (projectId, entry) => { calls.push(['appendExport', projectId, entry]); return { ok: true } },
    markRecoverable: async (projectId, errorCode) => {
      calls.push(['markRecoverable', projectId, errorCode])
      const project = projects.get(String(projectId))
      if (project) projects.set(String(projectId), { ...project, state: 'recoverable' })
      return { ok: true }
    },
    renameProject: async (projectId, name) => {
      const project = projects.get(String(projectId))
      if (!project) return { ok: false, code: 'not-found' }
      return { ok: true, project: { ...project, name } }
    },
    summaryOf: (project) => ({ id: project.id, name: project.name, state: project.state }),
    publicProject: (project) => project,
    dispose: async () => {}
  }
}

function createRecordingServiceStub() {
  const sessions = new Map()
  return {
    sessions,
    async registerPersistedSession({ id, directory, inputPath = '', metadata = null, projectId = null } = {}) {
      const existing = sessions.get(String(id))
      if (existing) return existing
      const session = {
        id: String(id),
        directory,
        inputPath: inputPath || path.join(directory, 'capture.webm'),
        projectId: projectId ? String(projectId) : null,
        state: 'ready',
        references: 0,
        metadata
      }
      sessions.set(session.id, session)
      return session
    },
    detachSession(sessionId) { return sessions.delete(String(sessionId)) },
    peekSession: (sessionId) => sessions.get(String(sessionId)) || null,
    async cleanupSession(sessionId) { return sessions.delete(String(sessionId)) },
    async dispose() {}
  }
}

function createDomainHarness(overrides = {}) {
  const projects = createProjectServiceStub()
  const recordingService = createRecordingServiceStub()
  const routes = []
  const windows = []
  const windowsByContents = new Map()
  const sent = []
  const desktopCalls = []
  const windowSources = Array.isArray(overrides.windowSources) ? overrides.windowSources : []
  const ownWindows = Array.isArray(overrides.ownWindows) ? overrides.ownWindows : []
  const settings = {
    record: {
      frameRate: 24,
      quality: 'standard',
      countdown: 3,
      lastMode: 'display',
      lastDisplayId: '',
      saveDirectory: '',
      audioSystem: true,
      audioMicrophone: false,
      audioSystemGain: 1,
      audioMicrophoneGain: 1,
      audioMicrophoneDeviceId: ''
    }
  }
  const display = {
    id: 1,
    label: 'DISPLAY1',
    scaleFactor: 1,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1080 }
  }
  let contentsId = 0

  const domain = createRecordDomain({
    app: { getPath: (name) => path.resolve('tmp', name) },
    desktopCapturer: {
      getSources: async (request = {}) => {
        const types = Array.isArray(request.types) ? request.types : []
        desktopCalls.push({ types: [...types], thumbnailSize: request.thumbnailSize || null })
        if (types.includes('window')) {
          return windowSources.map((entry) => ({
            id: entry.id,
            name: entry.name,
            appName: entry.appName || '',
            thumbnail: { isEmpty: () => false, getSize: () => ({ width: entry.width || 0, height: entry.height || 0 }) }
          }))
        }
        return [{ id: 'screen:1', display_id: '1', thumbnail: { isEmpty: () => false } }]
      }
    },
    path,
    screen: {
      getAllDisplays: () => [display],
      getPrimaryDisplay: () => display,
      getCursorScreenPoint: () => ({ x: 1, y: 2 }),
      getDisplayNearestPoint: () => display,
      getDisplayMatching: () => display,
      dipToScreenRect: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
      screenToDipPoint: (point) => ({ x: point.x, y: point.y })
    },
    dialog: { showSaveDialog: async () => ({ canceled: true }) },
    BrowserWindow: {
      fromWebContents: (contents) => windowsByContents.get(contents) || null,
      getAllWindows: () => ownWindows
    },
    rootDirectory: root,
    createLocalWindow: (pagePath, options = {}) => {
      const closedListeners = []
      const readyListeners = []
      const win = {
        pagePath,
        role: options.role || '',
        options,
        destroyed: false,
        isDestroyed: () => win.destroyed,
        setAlwaysOnTop: () => {},
        setContentProtection: () => {},
        setIgnoreMouseEvents: () => {},
        setBounds: () => {},
        setPosition: () => {},
        center: () => {},
        minimize: () => {},
        isMinimized: () => false,
        show: () => {},
        showInactive: () => {},
        hide: () => {},
        focus: () => {},
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
          session: { setDisplayMediaRequestHandler: () => {} }
        },
        closedListeners,
        readyListeners
      }
      windows.push(win)
      windowsByContents.set(win.webContents, win)
      return win
    },
    getSettings: () => settings,
    log: (...args) => { if (process.env.U03_DEBUG) console.log('[u03]', ...args) },
    assertGameModeDisabled: () => {},
    assertManagedDataWritable: () => {},
    getRecordingService: () => recordingService,
    peekRecordingService: () => recordingService,
    managedRecordingWriters: {
      track: async (task) => (typeof task === 'function' ? task() : task),
      assertOpen: () => {}
    },
    makeCaptureName: () => 'Highlighter_Video_2026-11-26.webm',
    VIDEO_CAPTURE_PREFIX: 'Highlighter_Video',
    performanceMonitor: { record: () => {}, snapshot: () => {} },
    getRecordingExportService: () => null,
    getExportResultService: () => null,
    getRegionPreferences: () => null,
    getRecordingProjectService: () => projects,
    getPointerTrackService: () => null,
    getRecordingWorkbench: () => ({
      shell: { showItemInFolder: () => {} },
      updateSettings: (patch) => { if (patch?.record) Object.assign(settings.record, patch.record) },
      createMainWindow: (route) => { routes.push(route) },
      backdropColor: () => '#101010',
      createRegionSelection: async () => ({}),
      positionAutomationWindow: () => false,
      refreshTray: () => {}
    })
  })

  const controller = domain.createRecordingController()
  const editorWindow = () => windows.filter((win) => win.role === 'record-editor').at(-1) || null
  const controlWindow = () => windows.filter((win) => win.role === 'record-control').at(-1) || null
  return {
    domain,
    controller,
    projects,
    recordingService,
    routes,
    windows,
    sent,
    desktopCalls,
    windowSources,
    ownWindows,
    settings,
    editorWindow,
    controlWindow,
    eventFor: (win) => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame })
  }
}

function windowSource(id, name, width, height, appName = '') {
  return { id, name, width, height, appName }
}

function ownWindow(title, mediaSourceId = '') {
  const win = { getTitle: () => title, isDestroyed: () => false }
  if (mediaSourceId) win.getMediaSourceId = () => mediaSourceId
  return win
}

// --------------------------------------------------------------------------------------------
// §4.3.1 Re-record must keep the window target (or return to the workbench explicitly)
// --------------------------------------------------------------------------------------------

test('U03 §4.3.1: re-record of a window project re-binds the saved target window', async () => {
  const harness = createDomainHarness({
    windowSources: [windowSource('window:701:0', 'Target window', 1600, 900)]
  })
  harness.projects.projects.set('project-window', makeWindowProject('project-window', 'Target window'))
  assert.deepEqual(await harness.domain.openEditor('project-window'), { ok: true })

  const editor = harness.editorWindow()
  assert.ok(editor)
  const result = await harness.controller.editorRerecord(harness.eventFor(editor), { projectId: 'project-window' })

  assert.deepEqual(result, { ok: true, mode: 'window' }, 'the success result names the re-recorded mode')
  assert.equal(editor.destroyed, true, 'the old editor closes')
  assert.deepEqual(harness.routes, [], 'the workbench is not needed while the target still exists')
  const control = harness.controlWindow()
  assert.ok(control, 'a new capture window starts')
  assert.equal(control._recordInit.mode, 'window', 'the new take records the same window, not the full display')
  assert.equal(control._recordInit.window.title, 'Target window')
  assert.equal(control._recordWindowBinding.sourceId, 'window:701:0', 'the binding is the saved target window')
  assert.equal(control._recordCaptureConfig.frameRate, 30, 'the saved capture configuration is reused')
  assert.equal(harness.windows.filter((win) => win.role === 'record-frame').length, 0, 'window takes still create no frame overlay')
})

test('U03 §4.3.1: re-record of a vanished window target returns to the workbench instead of degrading to full display', async () => {
  const harness = createDomainHarness({ windowSources: [] })
  harness.projects.projects.set('project-gone', makeWindowProject('project-gone', 'Gone window'))
  assert.deepEqual(await harness.domain.openEditor('project-gone'), { ok: true })

  const editor = harness.editorWindow()
  const result = await harness.controller.editorRerecord(harness.eventFor(editor), { projectId: 'project-gone' })

  assert.deepEqual(result, { ok: true, mode: 'workbench', fallback: 'window-unavailable' })
  assert.equal(editor.destroyed, true, 'the old editor closes')
  assert.equal(harness.controlWindow(), null, 'no full-display take is silently started')
  assert.deepEqual(harness.routes, ['recording'], 'the workbench route is opened so the user can pick a window')
})

test('U03 §4.3.1: re-record of a region project keeps the saved rectangle', async () => {
  const harness = createDomainHarness()
  const regionConfig = makeCaptureConfig({
    target: {
      mode: 'region',
      displayId: '1',
      displayName: 'DISPLAY1',
      boundsDip: { x: 10, y: 20, width: 200, height: 150 },
      pixelSize: { width: 200, height: 150 },
      scaleFactor: 1
    }
  })
  harness.projects.projects.set('project-region', makeProject({ id: 'project-region', mode: 'region', captureConfig: regionConfig }))
  await harness.domain.openEditor('project-region')
  const editor = harness.editorWindow()

  const result = await harness.controller.editorRerecord(harness.eventFor(editor), { projectId: 'project-region' })
  assert.deepEqual(result, { ok: true })
  const control = harness.controlWindow()
  assert.equal(control._recordInit.mode, 'region')
  assert.deepEqual(control._recordInit.selectionBounds, { x: 10, y: 20, width: 200, height: 150 })
})

test('U03 §4.3.1: re-record of a display project stays a display take with the legacy result shape', async () => {
  const harness = createDomainHarness()
  harness.projects.projects.set('project-display', makeProject({ id: 'project-display' }))
  await harness.domain.openEditor('project-display')
  const editor = harness.editorWindow()

  assert.deepEqual(await harness.controller.editorRerecord(harness.eventFor(editor), { projectId: 'project-display' }), { ok: true })
  assert.equal(harness.controlWindow()._recordInit.mode, 'display')
})

// --------------------------------------------------------------------------------------------
// §4.3.2 The editor keeps the frame rate after a restart
// --------------------------------------------------------------------------------------------

test('U03 §4.3.2: a project opened after a restart keeps its frame rate from the capture configuration', async () => {
  const harness = createDomainHarness()
  // No probe stash exists in a fresh process; the manifest's captureConfig is the only source.
  harness.projects.projects.set('project-restart', makeProject({ id: 'project-restart' }))
  assert.deepEqual(await harness.domain.openEditor('project-restart'), { ok: true })

  const editor = harness.editorWindow()
  assert.equal(editor._recordEditorInit.metadata.video.frameRate, 30, 'the editor can offer 30/60 FPS again')
  assert.equal(editor._recordEditorInit.metadata.video.width, 800)
  assert.equal(editor._recordEditorInit.project.captureConfig.frameRate, 30)
})

test('U03 §4.3.2: an unknown frame rate still reports 0 instead of inventing one', async () => {
  const harness = createDomainHarness()
  const captureConfig = makeCaptureConfig()
  delete captureConfig.frameRate
  captureConfig.target = makeCaptureConfig().target
  harness.projects.projects.set('project-unknown', makeProject({ id: 'project-unknown', captureConfig }))
  assert.deepEqual(await harness.domain.openEditor('project-unknown'), { ok: true })

  const editor = harness.editorWindow()
  assert.equal(editor._recordEditorInit.metadata.video.frameRate, 0)
})

// --------------------------------------------------------------------------------------------
// §4.3.3 Own-window filtering by native handle + frozen canvas following the real source size
// --------------------------------------------------------------------------------------------

test('U03 §4.3.3: own windows are filtered by getMediaSourceId so a same-titled foreign window stays recordable', async () => {
  const harness = createDomainHarness({
    windowSources: [
      windowSource('window:900:0', 'Highlighter', 1440, 900),
      windowSource('window:901:0', 'Highlighter', 1280, 720)
    ],
    ownWindows: [ownWindow('Highlighter', 'window:900:0')]
  })
  const listed = await harness.controller.workbenchWindows()
  assert.equal(listed.ok, true)
  assert.deepEqual(listed.windows.map((entry) => entry.token.length > 0), [true])
  assert.deepEqual(listed.windows.map((entry) => entry.title), ['Highlighter'])
  assert.deepEqual(listed.windows.map((entry) => entry.width), [1280], 'the exact-handle match removed only our own window')

  // The listed token still binds the recordable foreign window.
  const started = await harness.controller.workbenchStart(null, { mode: 'window', windowToken: listed.windows[0].token })
  assert.deepEqual(started, { ok: true })
  assert.equal(harness.controlWindow()._recordWindowBinding.sourceId, 'window:901:0')
})

test('U03 §4.3.3: the frozen exact-title filter remains the fallback when the native handle is unavailable', async () => {
  const harness = createDomainHarness({
    windowSources: [
      windowSource('window:910:0', 'Highlighter', 1440, 900),
      windowSource('window:911:0', 'Docs', 1280, 720)
    ],
    ownWindows: [ownWindow('Highlighter')]
  })
  const listed = await harness.controller.workbenchWindows()
  assert.deepEqual(listed.windows.map((entry) => entry.title), ['Docs'])
})

test('U03 §4.3.3: the window output canvas follows the real source frame size instead of the clamped 1920x1080 measurement', () => {
  const harness = createRecordWindowHarness()
  const large = harness.run(`(() => {
    initData = { window: { pixelSize: { width: 1920, height: 1080 } }, display: { pixelSize: { width: 1920, height: 1080 } } }
    captureMode = 'window'
    windowPixelSize = { width: 1920, height: 1080 }
    sourceVideo = { videoWidth: 3840, videoHeight: 2160 }
    const output = buildOutputCanvas()
    return output.width + 'x' + output.height
  })()`)
  assert.equal(large, '3840x2160', 'a 4K window is not downsampled to the 1080p measure box')

  const odd = harness.run(`(() => {
    sourceVideo = { videoWidth: 2561, videoHeight: 1441 }
    const output = buildOutputCanvas()
    const fit = output._recordFit
    return output.width + 'x' + output.height + '|' + fit.width + 'x' + fit.height
  })()`)
  assert.match(odd, /^2560x1440\|/, 'odd source dimensions stay encoder-safe')

  const fallback = harness.run(`(() => {
    sourceVideo = { videoWidth: 0, videoHeight: 0 }
    const output = buildOutputCanvas()
    return output.width + 'x' + output.height
  })()`)
  assert.equal(fallback, '1920x1080', 'the measured size stays the fallback before the first frame is known')
})

// --------------------------------------------------------------------------------------------
// §4.3.4 Unity summing bus with a soft limiter instead of the static -6 dB attenuation
// --------------------------------------------------------------------------------------------

function createAudioStream(tracks = [{ id: 'audio-1', kind: 'audio', readyState: 'live' }]) {
  return { getAudioTracks: () => tracks, getTracks: () => tracks }
}

function audioParam(value) { return { value } }

function createLimiterAudioContext() {
  const created = { gains: [], sources: [], destinations: [], limiters: [], analysers: [] }
  const context = {
    state: 'running',
    createGain() {
      const node = { gain: audioParam(1), connections: [], connect(target) { node.connections.push(target) }, disconnect() {} }
      created.gains.push(node)
      return node
    },
    createAnalyser() {
      const analyser = {
        fftSize: 1024,
        connections: [],
        connect(target) { analyser.connections.push(target) },
        getFloatTimeDomainData(samples) { samples.fill(0.25) },
        disconnect() {}
      }
      created.analysers.push(analyser)
      return analyser
    },
    createMediaStreamSource(stream) {
      const node = { stream, connections: [], connect(target) { node.connections.push(target) }, disconnect() {} }
      created.sources.push(node)
      return node
    },
    createMediaStreamDestination() {
      const destination = { stream: createAudioStream(), connections: [], connect() {}, disconnect() {} }
      created.destinations.push(destination)
      return destination
    },
    createDynamicsCompressor() {
      const limiter = {
        threshold: audioParam(-24),
        knee: audioParam(30),
        ratio: audioParam(12),
        attack: audioParam(0.01),
        release: audioParam(0.25),
        connections: [],
        connect(target) { limiter.connections.push(target) },
        disconnect() {}
      }
      created.limiters.push(limiter)
      return limiter
    }
  }
  return { created, AudioContextClass: function FakeAudioContext() { return context } }
}

test('U03 §4.3.4: the dual-bus mix sums at unity gain and soft-limits between master and destination', () => {
  const fake = createLimiterAudioContext()
  const mix = createAudioMix({
    AudioContextClass: fake.AudioContextClass,
    systemStream: createAudioStream(),
    micStream: createAudioStream([{ id: 'mic-1', kind: 'audio', readyState: 'live' }]),
    plan: createGainPlan({ systemGain: 1, micGain: 1 })
  })

  assert.equal(mix.active, true)
  assert.equal(fake.created.limiters.length, 1, 'one compressor/limiter node is inserted')
  const limiter = fake.created.limiters[0]
  assert.equal(limiter.threshold.value, LIMITER_SETTINGS.threshold)
  assert.equal(limiter.knee.value, LIMITER_SETTINGS.knee)
  assert.equal(limiter.ratio.value, LIMITER_SETTINGS.ratio)
  assert.equal(limiter.attack.value, LIMITER_SETTINGS.attack)
  assert.equal(limiter.release.value, LIMITER_SETTINGS.release)

  const [master, systemGain, micGain] = fake.created.gains
  // U03: the old plan attenuated the sum by 1 / total (-6 dB for two unity buses). The live graph
  // must never do that: each bus keeps its own gain and the master stays at 1.0.
  assert.equal(createGainPlan({ systemGain: 1, micGain: 1 }).masterGain, 0.5, 'the legacy plan value is unchanged')
  assert.equal(master.gain.value, 1, 'the live master gain is unity')
  assert.equal(mix.masterGain, 1)
  assert.deepEqual(mix.limiter, { ...LIMITER_SETTINGS })
  assert.equal(systemGain.gain.value, 1, 'a single bus keeps 100% of its loudness')
  assert.equal(micGain.gain.value, 1)
  assert.equal(systemGain.connections[0], master)
  assert.equal(micGain.connections[0], master)
  assert.equal(master.connections[0], limiter, 'master feeds the limiter')
  assert.equal(limiter.connections[0], fake.created.destinations[0], 'the limiter feeds the recorder destination')
})

test('U03 §4.3.4: a lone bus also reaches the limiter at unity gain (no static -6 dB anywhere)', () => {
  const fake = createLimiterAudioContext()
  const mix = createAudioMix({
    AudioContextClass: fake.AudioContextClass,
    systemStream: createAudioStream(),
    plan: createGainPlan({ systemGain: 1, micGain: 0.5 })
  })
  const [master, systemGain] = fake.created.gains
  assert.equal(master.gain.value, 1)
  assert.equal(mix.masterGain, 1)
  assert.equal(systemGain.gain.value, 1)
  assert.equal(fake.created.limiters.length, 1)
  assert.equal(master.connections[0], fake.created.limiters[0])
})

test('U03 §4.3.4: limiter settings are a sane soft limiter, not a colouring compressor', () => {
  assert.ok(LIMITER_SETTINGS.threshold < 0 && LIMITER_SETTINGS.threshold > -24)
  assert.ok(LIMITER_SETTINGS.ratio >= 10, 'a high ratio catches the summed peaks')
  assert.ok(LIMITER_SETTINGS.attack > 0 && LIMITER_SETTINGS.attack <= 0.01)
  assert.ok(LIMITER_SETTINGS.release >= 0.1 && LIMITER_SETTINGS.release <= 1)
  assert.equal(LIMITER_SETTINGS.knee, 0)
})

test('U03 §4.3.4: a context without DynamicsCompressorNode keeps the legacy static attenuation as the fallback', () => {
  const created = { gains: [], destinations: [] }
  const AudioContextClass = function LegacyAudioContext() {
    return {
      state: 'running',
      createGain() {
        const node = { gain: audioParam(1), connections: [], connect(target) { node.connections.push(target) }, disconnect() {} }
        created.gains.push(node)
        return node
      },
      createMediaStreamSource(stream) {
        return { stream, connect() {}, disconnect() {} }
      },
      createMediaStreamDestination() {
        const destination = { stream: createAudioStream(), connect() {}, disconnect() {} }
        created.destinations.push(destination)
        return destination
      }
    }
  }
  const plan = createGainPlan({ systemGain: 1, micGain: 1 })
  const mix = createAudioMix({
    AudioContextClass,
    systemStream: createAudioStream(),
    micStream: createAudioStream([{ id: 'mic-1', kind: 'audio', readyState: 'live' }]),
    plan
  })
  assert.equal(mix.active, true)
  assert.equal(mix.limiter, null)
  assert.equal(mix.masterGain, plan.masterGain)
  assert.equal(created.gains[0].gain.value, plan.masterGain)
  assert.equal(created.gains[0].connections[0], created.destinations[0])
})

// --------------------------------------------------------------------------------------------
// §4.3.5 Direct-Track disables the annotation entrance before the take starts
// --------------------------------------------------------------------------------------------

test('U03 §4.3.5: a Direct-Track take disables the annotation entrance and shows a localized reason', async () => {
  const harness = createRecordWindowHarness()
  await harness.init({ mode: 'display', annotation: true })
  harness.run(`
    window.__annotationCommands = []
    window.recordAPI.setAnnotationCommand = (payload) => {
      window.__annotationCommands.push(payload)
      return Promise.resolve(true)
    }
    setState('recording')
    moreOpen = true
    renderControls()
  `)

  const before = harness.run(`({
    tools: annotationToolButtons.map((button) => button.disabled).join(','),
    style: annotationStyleButton.disabled
  })`)
  assert.equal(before.tools, 'false,false,false,false,false', 'the entrance is usable on the composited path')
  assert.equal(before.style, false)

  // The one-time direct-track decision is taken during preparation: from now on nothing may draw.
  const locked = harness.run(`(() => {
    directTrackDecision = { bypass: true, reason: 'eligible' }
    const applied = applyDirectTrackAnnotationLock()
    return {
      applied,
      tools: annotationToolButtons.map((button) => button.disabled).join(','),
      style: annotationStyleButton.disabled,
      tool: annotationTool,
      aria: annotationToolsElement.getAttribute('aria-disabled'),
      toolAria: annotationToolButtons.map((button) => button.getAttribute('aria-disabled')).join(','),
      hintHidden: annotationDirectTrackHint.hidden,
      hintText: annotationDirectTrackHint.textContent,
      pushes: window.__annotationCommands.map((payload) => payload.tool + ':' + payload.action).join(',')
    }
  })()`)
  assert.equal(locked.applied, true)
  assert.equal(locked.tools, 'true,true,true,true,true', 'every annotation tool button is disabled')
  assert.equal(locked.style, true)
  assert.equal(locked.tool, 'pointer', 'the overlay is pushed back to pointer/passthrough')
  assert.equal(locked.aria, 'true')
  assert.equal(locked.toolAria, 'true,true,true,true,true')
  assert.equal(locked.hintHidden, false, 'the reason is visible')
  assert.equal(locked.hintText, harness.run(`t('record.annotation.direct-track-disabled')`), 'the hint is an i18n key, not a hard-coded sentence')
  assert.equal(locked.pushes, 'pointer:', 'exactly one pointer/passthrough command reaches the overlay')

  const clicked = harness.run(`(() => {
    annotationToolButtons[1].click()
    return { tool: annotationTool, pushes: window.__annotationCommands.length }
  })()`)
  assert.equal(clicked.tool, 'pointer', 'clicking pen no longer enters annotation mode')
  assert.equal(clicked.pushes, 1, 'a locked click sends no command to the overlay')

  const unlocked = harness.run(`(() => {
    directTrackDecision = null
    renderControls()
    return {
      tools: annotationToolButtons.map((button) => button.disabled).join(','),
      style: annotationStyleButton.disabled,
      aria: annotationToolsElement.getAttribute('aria-disabled'),
      hintHidden: annotationDirectTrackHint.hidden
    }
  })()`)
  assert.equal(unlocked.tools, 'false,false,false,false,false', 'the next composited take gets the entrance back')
  assert.equal(unlocked.style, false)
  assert.equal(unlocked.aria, null)
  assert.equal(unlocked.hintHidden, true)
})
