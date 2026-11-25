'use strict'

// A fake window for the recording control bar (record/record.js).
//
// record.js is a classic script: it reads a fixed set of elements, subscribes to the
// preload bridge and then owns the whole take lifecycle. The other record tests can only
// match source text, which cannot prove that a stop actually un-blocks the UI or that a
// tray+button double press finalizes once. This harness runs the REAL file inside a vm
// with a fake DOM, a scriptable IPC bridge and controllable device/timer fakes, so those
// questions are answered by behaviour.
//
// Scope: everything the bar touches at load time and on the paths the C01/B04 tests
// drive (device acquisition, chunk append, finish/abandon, audio preflight). Anything
// outside that (canvas drawing, annotations) is a permissive stub.

const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '..', '..')
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8').replace(/\r\n/g, '\n')

function createElement(id) {
  const listeners = {}
  const children = []
  const classList = {
    add() {},
    remove() {},
    toggle() {},
    contains() { return false }
  }
  const element = {
    id,
    tagName: 'DIV',
    hidden: false,
    disabled: false,
    textContent: '',
    innerHTML: '',
    title: '',
    value: '',
    checked: false,
    className: '',
    style: {},
    dataset: {},
    children,
    classList,
    _attributes: {},
    _listeners: listeners,
    setAttribute(name, value) { element._attributes[name] = String(value) },
    getAttribute(name) { return Object.hasOwn(element._attributes, name) ? element._attributes[name] : null },
    removeAttribute(name) { delete element._attributes[name] },
    hasAttribute(name) { return Object.hasOwn(element._attributes, name) },
    addEventListener(type, handler) { (listeners[type] = listeners[type] || []).push(handler) },
    removeEventListener(type, handler) {
      listeners[type] = (listeners[type] || []).filter((entry) => entry !== handler)
    },
    dispatchEvent(event) { dispatch(event?.type || 'event', event) },
    appendChild(child) { children.push(child); return child },
    removeChild(child) {
      const index = children.indexOf(child)
      if (index >= 0) children.splice(index, 1)
      return child
    },
    contains() { return false },
    closest() { return null },
    focus() {},
    blur() {},
    click() { dispatch('click', { type: 'click', target: element }) },
    getBoundingClientRect() { return { x: 0, y: 0, width: 640, height: 480, top: 0, left: 0, right: 640, bottom: 480 } },
    getContext() { return createCanvasContext() },
    captureStream() { return null },
    toBlob(callback) { if (callback) callback(null) },
    querySelector() { return null },
    querySelectorAll() { return [] },
    setPointerCapture() {},
    releasePointerCapture() {}
  }
  function dispatch(type, event) {
    for (const handler of (listeners[type] || []).slice()) handler(event || { type, target: element })
  }
  return element
}

function createCanvasContext() {
  const state = {}
  return new Proxy(state, {
    get(target, prop) {
      if (prop === 'canvas') return null
      if (prop === 'measureText') return () => ({ width: 10 })
      if (prop === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) })
      if (prop === 'createLinearGradient' || prop === 'createPattern') return () => ({ addColorStop() {} })
      if (prop === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })
      if (Object.hasOwn(target, prop)) return target[prop]
      return () => {}
    },
    set(target, prop, value) { target[prop] = value; return true }
  })
}

function createFakeDom() {
  const elements = new Map()
  const annotationButtons = (kind, values) => values.map((value) => {
    const element = createElement('annotation-' + kind + '-' + value)
    if (kind === 'tool') element.dataset.annotationTool = value
    if (kind === 'color') element.dataset.annotationColor = value
    if (kind === 'width') element.dataset.annotationWidth = String(value)
    return element
  })
  const collections = {
    '[data-annotation-tool]': annotationButtons('tool', ['pointer', 'pen', 'rect', 'ellipse', 'arrow']),
    '[data-annotation-color]': annotationButtons('color', ['#ff3b30', '#ff9500']),
    '[data-annotation-width]': annotationButtons('width', [2, 4, 7])
  }
  const document = {
    documentElement: createElement('html'),
    body: createElement('body'),
    head: createElement('head'),
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, createElement(id))
      return elements.get(id)
    },
    querySelector(selector) {
      return collections[selector]?.[0] || null
    },
    querySelectorAll(selector) {
      return (collections[selector] || []).slice()
    },
    createElement(tag) {
      const element = createElement(tag)
      element.tagName = String(tag).toUpperCase()
      return element
    },
    addEventListener() {},
    removeEventListener() {}
  }
  return { document, elements }
}

// ---------------------------------------------------------------------------
// fake devices
// ---------------------------------------------------------------------------

function createMediaMocks() {
  const state = {
    displayCalls: [],
    microphoneCalls: [],
    stopped: [],
    contexts: 0,
    closed: 0,
    livestreams: []
  }

  function track(kind) {
    const listeners = {}
    return {
      kind,
      readyState: 'live',
      muted: false,
      enabled: true,
      _stops: 0,
      addEventListener(type, handler) { (listeners[type] = listeners[type] || []).push(handler) },
      removeEventListener() {},
      emit(type) { for (const handler of (listeners[type] || []).slice()) handler({ type }) },
      getSettings() { return { width: 1920, height: 1080, frameRate: 30 } },
      stop() {
        if (this.readyState === 'ended') return
        this._stops += 1
        this.readyState = 'ended'
        state.stopped.push(kind)
      }
    }
  }

  function stream({ audio = true, video = true } = {}) {
    const tracks = []
    if (video) tracks.push(track('video'))
    if (audio) tracks.push(track('audio'))
    const value = {
      _tracks: tracks,
      getTracks: () => tracks.slice(),
      getAudioTracks: () => tracks.filter((entry) => entry.kind === 'audio'),
      getVideoTracks: () => tracks.filter((entry) => entry.kind === 'video'),
      addTrack(entry) { tracks.push(entry) },
      removeTrack(entry) {
        const index = tracks.indexOf(entry)
        if (index >= 0) tracks.splice(index, 1)
      }
    }
    state.livestreams.push(value)
    return value
  }

  class FakeAudioContext {
    constructor() { state.contexts += 1 }
    createAnalyser() {
      return {
        fftSize: 0,
        smoothingTimeConstant: 1,
        getFloatTimeDomainData(samples) { samples.fill(0.3) }
      }
    }
    createMediaStreamSource() { return { connect() {} } }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} } }
    createMediaStreamDestination() { return { stream: stream({ audio: true, video: false }), connect() {} } }
    close() { state.closed += 1; return Promise.resolve() }
  }

  return { state, stream, FakeAudioContext, track }
}

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

function createRecordWindowHarness(options = {}) {
  const dom = createFakeDom()
  const media = createMediaMocks()
  const timers = []
  let nextTimerId = 0
  const ipc = {
    calls: [],
    initHandlers: [],
    commandHandlers: [],
    stateHandlers: [],
    append: options.appendChunk || null,
    finish: options.finishSession || null,
    cancel: options.cancelSession || null,
    sessions: 0,
    finishCalls: 0,
    cancelCalls: 0
  }
  const clock = { value: 1_700_000_000_000 }

  const RealDate = Date
  function FakeDate(...args) {
    if (args.length === 0) return new RealDate(clock.value)
    return new RealDate(...args)
  }
  FakeDate.now = () => clock.value
  FakeDate.parse = RealDate.parse
  FakeDate.UTC = RealDate.UTC
  FakeDate.prototype = RealDate.prototype

  class FakeMediaRecorder {
    static isTypeSupported() { return true }
    constructor(streamValue) {
      this.stream = streamValue
      this.state = 'inactive'
      this.listeners = {}
      this.mimeType = 'video/webm'
      FakeMediaRecorder.instances.push(this)
    }
    addEventListener(type, handler) { (this.listeners[type] = this.listeners[type] || []).push(handler) }
    emit(type, event) {
      for (const handler of (this.listeners[type] || []).slice()) handler(event || { type })
    }
    start() { this.state = 'recording' }
    pause() { this.state = 'paused' }
    resume() { this.state = 'recording' }
    stop() {
      if (this.state === 'inactive') return
      this.state = 'inactive'
      this.emit('stop')
    }
  }
  FakeMediaRecorder.instances = []

  const sandbox = {
    console,
    document: dom.document,
    navigator: {
      mediaDevices: {
        getDisplayMedia: async (constraints) => {
          media.state.displayCalls.push(JSON.parse(JSON.stringify(constraints || {})))
          if (options.deferDisplay) return options.deferDisplay(constraints)
          return media.stream({ audio: true, video: true })
        },
        getUserMedia: async (constraints) => {
          media.state.microphoneCalls.push(JSON.parse(JSON.stringify(constraints || {})))
          if (options.deferMicrophone) return options.deferMicrophone(constraints)
          return media.stream({ audio: true, video: false })
        },
        enumerateDevices: async () => options.devices || [{ kind: 'audioinput', deviceId: 'mic-a', label: 'USB Microphone' }],
        addEventListener() {},
        removeEventListener() {}
      }
    },
    MediaRecorder: FakeMediaRecorder,
    AudioContext: media.FakeAudioContext,
    HTMLVideoElement: class {},
    Image: class {},
    Blob: class {},
    URL: { createObjectURL: () => 'blob:fake', revokeObjectURL() {} },
    Date: FakeDate,
    performance: { now: () => clock.value - 1_700_000_000_000 },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    requestVideoFrameCallback: undefined,
    addEventListener(type, handler) {
      if (type === 'beforeunload') sandbox.__beforeUnload = handler
    },
    removeEventListener() {},
    devicePixelRatio: 1,
    innerWidth: 640,
    innerHeight: 480,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout: (fn, ms) => {
      const id = ++nextTimerId
      timers.push({ id, fn, ms: Number(ms) || 0, interval: false, cleared: false })
      return id
    },
    clearTimeout: (id) => {
      const timer = timers.find((entry) => entry.id === id)
      if (timer) timer.cleared = true
    },
    setInterval: (fn, ms) => {
      const id = ++nextTimerId
      timers.push({ id, fn, ms: Number(ms) || 0, interval: true, cleared: false })
      return id
    },
    clearInterval: (id) => {
      const timer = timers.find((entry) => entry.id === id)
      if (timer) timer.cleared = true
    }
  }
  sandbox.window = sandbox
  sandbox.window.recordAPI = {
    ready() {},
    onInit(handler) { ipc.initHandlers.push(handler) },
    onCommand(handler) { ipc.commandHandlers.push(handler) },
    onStateChanged(handler) { ipc.stateHandlers.push(handler) },
    onAnnotationSnapshot() {},
    onInterfaceLanguage() {},
    onSourceLost() {},
    startSession: async () => {
      ipc.sessions += 1
      ipc.calls.push(['startSession'])
      return { id: 'session-' + ipc.sessions }
    },
    appendChunk: async (sessionId, arrayBuffer, sequence, bytes) => {
      ipc.calls.push(['appendChunk', sessionId, sequence, bytes])
      if (ipc.append) return ipc.append(sessionId, arrayBuffer, sequence, bytes)
      return { committedBytes: bytes, sequence, lastChunkSequence: sequence }
    },
    finishSession: async (sessionId, timing) => {
      ipc.finishCalls += 1
      ipc.calls.push(['finishSession', sessionId, timing])
      if (ipc.finish) return ipc.finish(sessionId, timing)
      return { ok: true, projectId: 'project-1' }
    },
    cancelSession: async (sessionId) => {
      ipc.cancelCalls += 1
      ipc.calls.push(['cancelSession', sessionId])
      if (ipc.cancel) return ipc.cancel(sessionId)
      return { ok: true }
    },
    setFrameState: async (value) => {
      ipc.calls.push(['setFrameState', value])
      return true
    },
    reportState() {},
    reportCommandResult() {},
    reportAnnotationSnapshot() {},
    close() { ipc.calls.push(['close']) }
  }

  const context = vm.createContext(sandbox)
  for (const file of [
    'shared/locales/zh-CN.js',
    'shared/locales/en-US.js',
    'shared/locales/zh-TW.js',
    'shared/locales/record.js',
    'shared/i18n.js',
    'shared/recording-quality.js',
    'record/annotation-utils.js',
    'record/recording-utils.js',
    'record/chunk-backpressure.js',
    'record/audio-mixer.js',
    'shared/audio-preflight.js',
    'record/record.js'
  ]) {
    vm.runInContext(read(...file.split('/')), context, { filename: file })
  }

  const harness = {
    dom,
    media,
    ipc,
    timers,
    clock,
    context,
    recorderClass: FakeMediaRecorder,
    run: (code) => vm.runInContext(code, context),
    async settle(rounds = 30) {
      for (let index = 0; index < rounds; index += 1) await new Promise((resolve) => setImmediate(resolve))
    },
    // Runs queued (non-interval) timers in creation order, optionally advancing the
    // fake wall clock by `advanceMs` per timer (so timeouts and Date.now agree).
    runTimers({ count = 1, advanceMs = 0, until = null } = {}) {
      let ran = 0
      const deadline = Math.max(0, Number(count) || 0)
      for (;;) {
        if (ran >= deadline) break
        const timer = timers
          .filter((entry) => !entry.cleared && !entry.interval)
          .sort((a, b) => a.id - b.id)[0]
        if (!timer) break
        if (until && !until(timer)) break
        timer.cleared = true
        harness.clock.value += advanceMs
        timer.fn()
        ran += 1
      }
      return ran
    },
    element: (id) => dom.document.getElementById(id),
    // Awaits a bar operation while pumping the fake timers: the stop/abandon paths arm
    // their own deadline timers, and a manual clock would otherwise never fire them.
    async waitWithTimers(promise, { maxMs = 5000, advanceMs = 50 } = {}) {
      let settled = false
      let value = null
      let failure = null
      promise.then(
        (result) => { settled = true; value = result },
        (error) => { settled = true; failure = error }
      )
      const started = Date.now()
      while (!settled) {
        if (Date.now() - started > maxMs) throw new Error('record window operation did not settle in ' + maxMs + ' ms')
        harness.runTimers({ count: 1, advanceMs })
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
      if (failure) throw failure
      return value
    },
    click(id) {
      const element = dom.document.getElementById(id)
      assertListener(element, id)
      element.click()
      return element
    },
    // Sets up a "take is prepared" state without acquiring real devices, then starts the
    // bar's recorder exactly like the Start button does (startRecorder -> session ->
    // MediaRecorder -> clock). The direct-track branch is used because it needs no
    // canvas/compositor; the chunk queue, finish and abandon paths are identical.
    async startTake(initOverrides = {}) {
      const init = {
        mode: 'display',
        frameRate: 30,
        quality: 'standard',
        countdown: 0,
        annotation: true,
        audio: { system: true, microphone: false, microphoneDeviceId: '', systemGain: 1, microphoneGain: 1 },
        selectionBounds: { x: 0, y: 0, width: 640, height: 480 },
        display: { id: '1', bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
        fakeCapture: true,
        ...initOverrides
      }
      for (const handler of ipc.initHandlers) handler(init)
      await harness.settle()
      sandbox.__takeStream = media.stream({ audio: true, video: true })
      harness.run('desktopStream = __takeStream; recorderStream = __takeStream; canvasStream = null; sourceVideo = null; directTrackDecision = { bypass: true }; setState("preparing")')
      await harness.run('startRecorder("preparing")')
      await harness.settle(4)
      return init
    },
    // Emits one MediaRecorder fragment through the real dataavailable handler.
    emitChunk(bytes = 64, sequenceHint = null) {
      const payload = {
        size: bytes,
        arrayBuffer: async () => new ArrayBuffer(bytes),
        sequenceHint
      }
      harness.run('handleDataAvailable')({ data: payload })
      return payload
    },
    snapshot() {
      return harness.run(`({
        state,
        busy,
        sessionId,
        projectId,
        appendErrorCode: appendError ? appendError.code : '',
        lastAckedSequence,
        lastReceived: chunkSequence,
        committedBytes,
        sequence: chunkSequence,
        chunkFailureAcknowledged
      })`)
    },
    async finish() {
      return harness.run('finishRecording()')
    },
    async discard() {
      return harness.run('confirmDiscard()')
    }
  }
  return harness
}

function assertListener(element, id) {
  if (!element) throw new Error('no element #' + id)
  const hasListener = Object.values(element._listeners).some((list) => list.length > 0)
  if (!hasListener) throw new Error('#' + id + ' has no listeners')
}

module.exports = { createRecordWindowHarness }
