'use strict'

// B08: "pin the current frame" from the recording-editor timeline.
//
// The feature has three parts that can be tested without decoding a real video:
//   1. the pure frame maths (which SOURCE time is current, the <=1-frame acceptance rule,
//      VFR nearest-frame selection, canvas sizing from source pixels);
//   2. the editor view over a fake DOM (pause-then-capture, gap seek, the one-grab guard,
//      cancellation on close, the pin-limit answer and "the project is never modified");
//   3. the contract between the renderer, the preload bridge, the IPC role policy and the
//      main-process handler (channel name, pin budget, no temporary files).
//
// The ticket calls for pure functions + source contracts, so no Electron window or video is
// started here.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8')

const editorModule = require('../record/editor')
const { IPC_SURFACES, buildIpcPolicies } = require('../main/services/ipc-security')
const {
  sanitizeRecordFramePin,
  pinRecordFrame,
  PIN_FRAME_MAX_BYTES
} = require('../main/domains/record')

// ---------------------------------------------------------------------------
// 1. frame maths
// ---------------------------------------------------------------------------

test('locatePinFrame keeps the paused playhead inside kept content, in SOURCE time', () => {
  const segments = [{ startMs: 1000, endMs: 3000 }, { startMs: 5000, endMs: 7000 }]
  const inside = editorModule.locatePinFrame({ currentMs: 1500, segments, durationMs: 10000, frameRate: 30 })
  assert.equal(inside.ok, true)
  assert.equal(inside.sourceMs, 1500, 'source time is used as-is, not the edited timeline')
  assert.equal(inside.adjusted, false)

  // The second kept block is still SOURCE time: 5500, never the concatenated 2500 output time.
  const second = editorModule.locatePinFrame({ currentMs: 5500, segments, durationMs: 10000, frameRate: 30 })
  assert.equal(second.sourceMs, 5500)
  assert.equal(second.adjusted, false)

  // After a fine-trim moved the first kept edge, a playhead before it snaps forward.
  const trimmed = editorModule.locatePinFrame({ currentMs: 200, segments, durationMs: 10000, frameRate: 30 })
  assert.deepEqual(
    { ok: trimmed.ok, sourceMs: trimmed.sourceMs, adjusted: trimmed.adjusted },
    { ok: true, sourceMs: 1000, adjusted: true }
  )
})

test('locatePinFrame never pins a removed gap or a removed tail', () => {
  const segments = [{ startMs: 1000, endMs: 3000 }, { startMs: 5000, endMs: 7000 }]
  // Inside the deleted gap: settle on the NEXT kept start, the frame kept playback shows next.
  const gap = editorModule.locatePinFrame({ currentMs: 4000, segments, durationMs: 10000, frameRate: 30 })
  assert.equal(gap.ok, true)
  assert.equal(gap.sourceMs, 5000)
  assert.equal(gap.code, 'snapped-to-next-kept')
  // Past the last kept edge: one frame INSIDE the last kept segment, never the removed tail.
  const tail = editorModule.locatePinFrame({ currentMs: 9000, segments, durationMs: 10000, frameRate: 30 })
  assert.equal(tail.ok, true)
  assert.equal(tail.sourceMs, 7000 - Math.round(1000 / 30))
  assert.equal(tail.code, 'clamped-to-last-kept-frame')
  assert.ok(tail.sourceMs < 7000)
})

test('locatePinFrame treats [] as the whole recording and refuses a deleted-everything edit', () => {
  const whole = editorModule.locatePinFrame({ currentMs: 4200, segments: [], durationMs: 10000, frameRate: 30 })
  assert.equal(whole.ok, true)
  assert.equal(whole.sourceMs, 4200)
  assert.equal(whole.adjusted, false)
  // The controller's explicit "no content" state is a non-empty array that normalises away.
  const empty = editorModule.locatePinFrame({ currentMs: 4200, segments: [{ startMs: 5000, endMs: 5020 }], durationMs: 10000, frameRate: 30 })
  assert.equal(empty.ok, false)
  assert.equal(empty.code, 'empty-selection')
  assert.equal(editorModule.locatePinFrame({ currentMs: 0, segments: [], durationMs: 0 }).code, 'duration-unavailable')
})

test('the <=1 frame acceptance rule and its frame arithmetic', () => {
  assert.equal(editorModule.frameDurationMs(30), 1000 / 30)
  assert.equal(editorModule.frameDurationMs(0), 1000 / 30, 'unknown rate falls back to 30 fps')
  // One frame is accepted; two are not.
  assert.equal(editorModule.withinOneFrame(1000 + 1000 / 30, 1000, 30), true)
  assert.equal(editorModule.withinOneFrame(1000 - 1000 / 30, 1000, 30), true)
  assert.equal(editorModule.withinOneFrame(1000 + 2 * (1000 / 30), 1000, 30), false)
  assert.equal(editorModule.frameDeviation(1000, 1000, 30), 0)
  assert.equal(Number.isFinite(editorModule.frameDeviation('x', 1000, 30)), false)
  // 60 fps: half a frame at 30 fps is a full frame here, so the same offset must be rejected.
  assert.equal(editorModule.withinOneFrame(1000 + 1000 / 60, 1000, 60), true)
  assert.equal(editorModule.withinOneFrame(1000 + 1000 / 30, 1000, 60), false)
})

test('VFR sources resolve to the nearest OBSERVED presentation time', () => {
  const mediaTimes = [0, 40.2, 83.7, 120.1, 180.4]
  assert.equal(editorModule.nearestFrameTime(121, mediaTimes), 120.1)
  assert.equal(editorModule.nearestFrameTime(0, mediaTimes), 0)
  assert.equal(editorModule.nearestFrameTime(500, mediaTimes), 180.4)
  assert.equal(editorModule.nearestFrameTime(121, []), null)
  assert.equal(editorModule.nearestFrameTime(121, null), null)
  assert.equal(editorModule.nearestFrameTime(121, ['x', -5, 100]), 100)
})

test('frameSeekTarget accepts within one frame and nudges only an early presentation', () => {
  const within = editorModule.frameSeekTarget(1000, 1000 - 1000 / 30, 30)
  assert.equal(within.accept, true)
  assert.equal(within.seekMs, null)
  // Three frames early: ask for one more seek half a frame PAST the request.
  const early = editorModule.frameSeekTarget(1000, 900, 30)
  assert.equal(early.accept, false)
  assert.equal(early.seekMs, Math.round(1000 + 1000 / 60))
  // Later than requested: nudge backwards instead.
  const late = editorModule.frameSeekTarget(1000, 1100, 30)
  assert.equal(late.accept, false)
  assert.equal(late.seekMs, Math.round(1000 - 1000 / 60))
  // A missing mediaTime is not a rejection: draw the frame we have.
  assert.equal(editorModule.frameSeekTarget(1000, null, 30).accept, true)
})

test('the pin canvas is sized from the decoded source pixels, never the preview box', () => {
  // The window is 1120x760 and the stage is CSS-scaled; the element reports 1920x1080.
  const source = editorModule.frameCanvasSize(1920, 1080, { video: { width: 1280, height: 720 } })
  assert.deepEqual(source, { ok: true, width: 1920, height: 1080, intrinsic: true })
  // Before the element reports a size, probed metadata is the fallback (never the window size).
  const fallback = editorModule.frameCanvasSize(0, 0, { video: { width: 1280, height: 720 } })
  assert.deepEqual(fallback, { ok: true, width: 1280, height: 720, intrinsic: false })
  assert.equal(editorModule.frameCanvasSize(0, 0, null).code, 'no-frame')
})

test('pin metadata is data-only and normalised (source tag, timestamp, size, scale, capture time)', () => {
  const meta = editorModule.buildPinFrameMeta({
    projectId: 'project-1', frameMs: 1234.6, width: 1920, height: 1080, scaleFactor: 1.5, nowMs: 99
  })
  assert.deepEqual(meta, {
    source: 'record-frame',
    projectId: 'project-1',
    frameMs: 1235,
    width: 1920,
    height: 1080,
    scaleFactor: 1.5,
    capturedAt: 99
  })
  // No path, no blob, no free-form keys can sneak into the pin meta.
  assert.deepEqual(Object.keys(meta).sort(), ['capturedAt', 'frameMs', 'height', 'projectId', 'scaleFactor', 'source', 'width'])
  const fallback = editorModule.buildPinFrameMeta({ scaleFactor: 0, projectId: 7 })
  assert.equal(fallback.scaleFactor, 1)
  assert.equal(fallback.projectId, '')
  assert.equal(fallback.frameMs, 0)
})

test('pin result codes map to one translated status each (no raw main-process strings)', () => {
  assert.deepEqual(editorModule.pinFrameStatusKey('', true), { key: 'record.pin-frame.succeeded', state: '' })
  assert.deepEqual(editorModule.pinFrameStatusKey('pin-limit'), { key: 'record.pin-frame.limit', state: 'unsaved' })
  assert.deepEqual(editorModule.pinFrameStatusKey('pin-unavailable'), { key: 'record.pin-frame.unavailable', state: 'conflict' })
  assert.deepEqual(editorModule.pinFrameStatusKey('empty-selection'), { key: 'record.pin-frame.empty', state: 'conflict' })
  assert.deepEqual(editorModule.pinFrameStatusKey('cancelled'), { key: 'record.pin-frame.cancelled', state: '' })
  assert.deepEqual(editorModule.pinFrameStatusKey('no-frame'), { key: 'record.pin-frame.no-frame', state: 'conflict' })
  assert.deepEqual(editorModule.pinFrameStatusKey('something-new'), { key: 'record.pin-frame.failed', state: 'conflict' })
})

// ---------------------------------------------------------------------------
// 2. editor view over a fake DOM
// ---------------------------------------------------------------------------

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = String(tagName).toUpperCase()
    this.id = ''
    this.hidden = false
    this.disabled = false
    this.value = ''
    this.textContent = ''
    this.title = ''
    this.src = ''
    this.readyState = 0
    this.dataset = {}
    this.style = {}
    this.rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
    this.listeners = new Map()
    this.attributes = new Map()
    this.children = []
    this.firstChild = null
    this.parentNode = null
    this.classList = {
      _set: new Set(),
      add: (name) => this.classList._set.add(name),
      remove: (name) => this.classList._set.delete(name),
      toggle: (name, force) => {
        const on = force === undefined ? !this.classList._set.has(name) : !!force
        if (on) this.classList._set.add(name)
        else this.classList._set.delete(name)
        return on
      },
      contains: (name) => this.classList._set.has(name)
    }
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(handler)
  }

  removeEventListener(type, handler) {
    const handlers = this.listeners.get(type)
    if (!handlers) return
    this.listeners.set(type, handlers.filter((entry) => entry !== handler))
  }

  dispatch(type, event = {}) {
    for (const handler of [...(this.listeners.get(type) || [])]) handler({ type, target: this, ...event })
  }

  appendChild(child) {
    this.children.push(child)
    child.parentNode = this
    this.firstChild = this.children[0]
    return child
  }

  removeChild(child) {
    const index = this.children.indexOf(child)
    if (index >= 0) this.children.splice(index, 1)
    if (child) child.parentNode = null
    this.firstChild = this.children[0] || null
    return child
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)) }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null }
  removeAttribute(name) { this.attributes.delete(name) }
  getBoundingClientRect() { return this.rect }
  focus() { this.focused = true }
  select() { this.selected = true }
  load() { this.readyState = 1 }
  play() { this.paused = false; return Promise.resolve() }
  pause() { this.paused = true; this.pauseCalls = (this.pauseCalls || 0) + 1 }
}

class FakeVideo extends FakeElement {
  constructor() {
    super('video')
    this.videoWidth = 0
    this.videoHeight = 0
    this._currentTime = 0
    this.paused = true
    this.pauseCalls = 0
    this.frameCallbacks = []
  }

  get currentTime() { return this._currentTime }

  // Setting currentTime is what a seek is: Chromium fires 'seeked' once the frame is ready.
  set currentTime(value) {
    this._currentTime = Number(value) || 0
    this.seekCount = (this.seekCount || 0) + 1
    Promise.resolve().then(() => this.dispatch('seeked'))
  }

  requestVideoFrameCallback(callback) {
    this.frameCallbacks.push(callback)
    return this.frameCallbacks.length
  }

  emitFrame(mediaTimeSeconds) {
    const queue = this.frameCallbacks.splice(0)
    for (const callback of queue) callback(0, { mediaTime: mediaTimeSeconds })
  }
}

class FakeCanvas {
  constructor() {
    this.width = 0
    this.height = 0
    this.draws = []
    this.encoded = 0
  }

  getContext() {
    return { drawImage: (...args) => this.draws.push(args) }
  }

  toBlob(callback) {
    this.encoded += 1
    callback(new Blob([Uint8Array.from([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }))
  }
}

function installFakeDom() {
  const elements = new Map()
  for (const id of editorModule.ELEMENT_IDS) {
    const element = id === 'preview-video'
      ? new FakeVideo()
      : (id.endsWith('-input')
        ? new FakeElement('input')
        : (id === 'export-format' || id === 'gif-edge' || id === 'gif-fps' || id === 'export-resolution' || id === 'export-quality' || id === 'export-fps'
          ? new FakeElement('select')
          : new FakeElement('div')))
    element.id = id
    elements.set(id, element)
  }
  elements.get('timeline-track').rect = { left: 100, top: 20, right: 900, bottom: 32, width: 800, height: 12 }
  const body = new FakeElement('body')
  const documentRef = {
    body,
    documentElement: new FakeElement('html'),
    activeElement: null,
    getElementById: (id) => elements.get(id) || null,
    createElement: (tagName) => (tagName === 'canvas' ? new FakeCanvas() : new FakeElement(tagName))
  }
  return { elements, document: documentRef, window: new FakeElement('window') }
}

function createProject(overrides = {}) {
  return {
    id: 'project-1',
    name: 'ScreenRecording_2026-11-25',
    mode: 'display',
    state: 'ready',
    createdAt: 0,
    updatedAt: 0,
    media: { durationMs: 10000, video: { width: 1920, height: 1080 }, audio: { tracks: 0 } },
    edit: {
      revision: 2,
      keepRanges: [{ id: 'keep-1', startMs: 1000, endMs: 3000 }, { id: 'keep-2', startMs: 5000, endMs: 7000 }],
      format: 'mp4',
      gif: { edge: 1280, fps: 15 }
    },
    exports: [],
    recovery: { cleanStop: true, errorCode: '' },
    ...overrides
  }
}

function createFakeApi(options = {}) {
  const calls = { pin: [], saveDraft: [], ready: 0 }
  const initHandlers = []
  const api = {
    ready: () => { calls.ready += 1 },
    onInit: (callback) => { initHandlers.push(callback); return () => {} },
    onExportProgress: () => () => {},
    onInterfaceLanguage: () => () => {},
    saveDraft: async (projectId, expectedRevision, edit) => {
      calls.saveDraft.push({ projectId, expectedRevision, edit })
      return { ok: true, revision: expectedRevision + 1 }
    },
    exportProject: async () => ({ status: 'accepted', task: { taskId: 'task-1', state: 'running' } }),
    exportStatus: async () => ({ ok: true, task: { taskId: 'task-1', state: 'running', progress: 1 } }),
    cancelExport: async () => ({ ok: true }),
    events: async () => ({ ok: true, track: null })
  }
  if (options.pinFrame !== false) {
    api.pinFrame = async (projectId, png, meta) => {
      calls.pin.push({ projectId, png, meta })
      if (typeof options.pinAnswer === 'function') return options.pinAnswer({ projectId, png, meta })
      return { ok: true, pinId: 'pin-window-1', width: meta.width, height: meta.height }
    }
  }
  return { api, calls, emitInit: (data) => { for (const handler of initHandlers) handler(data) } }
}

function initPayload(project = createProject()) {
  return {
    project,
    sourceUrl: 'file:///recordings/project-1/capture.mp4',
    metadata: {
      durationMs: project.media.durationMs,
      video: { width: project.media.video.width, height: project.media.video.height, frameRate: 30 },
      audio: { tracks: 0 }
    },
    recovery: { state: 'ready', errorCode: '' }
  }
}

function bootPinView({ api = createFakeApi().api, project = createProject() } = {}) {
  const harness = installFakeDom()
  const view = editorModule.createEditorView({
    api,
    document: harness.document,
    window: harness.window,
    translate: (key) => key,
    now: () => 1234
  })
  view.boot()
  view.applyInit(initPayload(project))
  const video = harness.elements.get('preview-video')
  video.videoWidth = 1920
  video.videoHeight = 1080
  video.paused = true
  video.readyState = 4 // HAVE_ENOUGH_DATA: a frame exists to draw
  return { view, harness, video }
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve))
}

test('a paused playhead pins exactly the frame shown, at source pixel size', async (t) => {
  const fake = createFakeApi()
  const { view, harness, video } = bootPinView({ api: fake.api })
  t.after(() => view.destroy())

  video.currentTime = 1.5
  const before = view.getProject()
  const result = await view.pinCurrentFrame()
  assert.equal(result.ok, true)

  assert.equal(fake.calls.pin.length, 1, 'exactly one pin invocation')
  const [call] = fake.calls.pin
  assert.equal(call.projectId, 'project-1')
  assert.equal(call.meta.source, 'record-frame')
  assert.equal(call.meta.frameMs, 1500)
  assert.equal(call.meta.width, 1920)
  assert.equal(call.meta.height, 1080)
  assert.ok(call.png instanceof Uint8Array && call.png.byteLength > 0, 'the PNG crosses IPC as bytes')
  // The pin buffer has no path and no editor geometry; the project is untouched.
  assert.deepEqual(Object.keys(call.meta).sort(), ['capturedAt', 'frameMs', 'height', 'projectId', 'scaleFactor', 'source', 'width'])
  assert.deepEqual(view.getProject(), before)
  assert.equal(fake.calls.saveDraft.length, 0, 'pinning never writes a draft')
  // The status line reports success and the button is no longer busy.
  assert.equal(harness.elements.get('pin-frame-status').textContent, 'record.pin-frame.succeeded')
  assert.equal(harness.elements.get('pin-frame').dataset.busy, 'false')
})

test('the canvas is drawn from the video at intrinsic size - no preview box, no editor chrome', async (t) => {
  const fake = createFakeApi()
  const { view, harness, video } = bootPinView({ api: fake.api })
  t.after(() => view.destroy())
  video.currentTime = 2
  await view.pinCurrentFrame()

  // Boot creates one offscreen canvas for the grab; inspect it through the DOM factory.
  const canvases = []
  const originalCreate = harness.document.createElement
  harness.document.createElement = (tagName) => {
    const node = originalCreate(tagName)
    if (tagName === 'canvas') canvases.push(node)
    return node
  }
  await view.pinCurrentFrame()
  assert.equal(canvases.length, 1)
  const [canvas] = canvases
  assert.equal(canvas.width, 1920, 'canvas width = source pixels')
  assert.equal(canvas.height, 1080, 'canvas height = source pixels')
  assert.equal(canvas.draws.length, 1)
  assert.deepEqual(canvas.draws[0].slice(1), [0, 0, 1920, 1080], 'drawImage covers the whole source frame')
  assert.equal(canvas.draws[0][0], video)
  assert.equal(harness.elements.get('timeline-track').rect.width, 800, 'the preview/timeline geometry is irrelevant')
})

test('playing playback is paused first and the pinned time is the pre-pause position', async (t) => {
  const fake = createFakeApi()
  const { view, video } = bootPinView({ api: fake.api })
  t.after(() => view.destroy())

  assert.equal(view.startRangePlayback(), true)
  video.paused = false
  const shownMs = Math.round(video.currentTime * 1000)
  const result = await view.pinCurrentFrame()
  assert.equal(result.ok, true)
  assert.ok(video.pauseCalls > 0, 'the preview was paused before the grab')
  assert.equal(fake.calls.pin[0].meta.frameMs, shownMs)
})

test('a playhead inside a deleted gap seeks to the next kept frame before capturing', async (t) => {
  const fake = createFakeApi()
  const { view, video } = bootPinView({ api: fake.api })
  t.after(() => view.destroy())

  video.currentTime = 4 // 4000 ms sits in the 3000..5000 removed gap
  // No rVFC here: this test is about the SOURCE position; the VFR test below covers the
  // presented-frame verification and would otherwise wait for a frame event.
  video.requestVideoFrameCallback = undefined
  const seeksBefore = video.seekCount
  const result = await view.pinCurrentFrame()
  assert.equal(result.ok, true)
  assert.equal(fake.calls.pin[0].meta.frameMs, 5000, 'pinned the next kept frame, not the removed one')
  assert.equal(video.seekCount, seeksBefore + 1, 'the preview was positioned exactly once before drawing')
})

test('rVFC on a VFR source accepts the nearest presented frame and re-seeks only when early', async (t) => {
  const fake = createFakeApi()
  const { view, video } = bootPinView({ api: fake.api })
  t.after(() => view.destroy())

  video.currentTime = 4 // gap -> seek to 5000 ms, then verify via rVFC
  const seeksBefore = video.seekCount
  const pending = view.pinCurrentFrame()
  await tick()
  await tick()
  assert.ok(video.frameCallbacks.length > 0, 'rVFC is armed after the seek')
  // 5001 ms is inside the same frame: accepted without another seek.
  video.emitFrame(5.001)
  const result = await pending
  assert.equal(result.ok, true)
  assert.equal(fake.calls.pin[0].meta.frameMs, 5001)
  assert.equal(video.seekCount, seeksBefore + 1, 'no extra seek for a within-one-frame presentation')
})

test('an early VFR presentation triggers exactly one corrective seek inside the frame', async (t) => {
  const fake = createFakeApi()
  const { view, video } = bootPinView({ api: fake.api })
  t.after(() => view.destroy())

  video.currentTime = 4 // gap -> first seek to 5000 ms, rVFC armed before the seek
  const seeksBefore = video.seekCount
  const pending = view.pinCurrentFrame()
  await tick()
  await tick()
  assert.equal(video.frameCallbacks.length, 1)
  // The first presented frame is 100 ms early: three frames at 30 fps, so one nudge seek.
  video.emitFrame(4.9)
  await tick()
  await tick()
  assert.equal(video.frameCallbacks.length, 1, 'the corrective seek re-arms rVFC')
  assert.equal(video.seekCount, seeksBefore + 2, 'the first seek plus one corrective seek')
  // The corrective seek lands inside the requested frame.
  video.emitFrame(5.017)
  const result = await pending
  assert.equal(result.ok, true)
  assert.equal(fake.calls.pin[0].meta.frameMs, 5017)
})

test('one grab at a time: a second activation while the first is pending is ignored', async (t) => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const fake = createFakeApi({ pinAnswer: async () => { await gate; return { ok: true } } })
  const { view, harness, video } = bootPinView({ api: fake.api })
  t.after(() => view.destroy())

  video.currentTime = 2
  const first = view.pinCurrentFrame()
  await tick()
  const second = await view.pinCurrentFrame()
  assert.deepEqual(second, { ok: false, code: 'busy' })
  assert.equal(harness.elements.get('pin-frame').disabled, true, 'the button is disabled while busy')
  release()
  assert.equal((await first).ok, true)
  assert.equal(fake.calls.pin.length, 1, 'a repeated click never produces a second pin')
})

test('the pin budget refusal produces no file, no draft write and an actionable message', async (t) => {
  const fake = createFakeApi({ pinAnswer: () => ({ ok: false, code: 'pin-limit', max: 20 }) })
  const { view, harness, video } = bootPinView({ api: fake.api })
  t.after(() => view.destroy())

  video.currentTime = 2
  const before = view.getProject()
  const result = await view.pinCurrentFrame()
  assert.equal(result.ok, false)
  assert.equal(result.code, 'pin-limit')
  assert.equal(fake.calls.pin.length, 1)
  assert.equal(fake.calls.saveDraft.length, 0, 'the project is not modified')
  assert.deepEqual(view.getProject(), before)
  assert.equal(harness.elements.get('pin-frame-status').textContent, 'record.pin-frame.limit')
  assert.equal(harness.elements.get('pin-frame-status').dataset.state, 'unsaved')
})

test('closing the editor invalidates an in-flight grab: no IPC call reaches main', async (t) => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const fake = createFakeApi({ pinAnswer: async () => { await gate; return { ok: true } } })
  const { view, video } = bootPinView({ api: fake.api })
  t.after(() => view.destroy())

  video.currentTime = 2
  const pending = view.pinCurrentFrame()
  // Destroy while the PNG encode promise is still in flight: the grab must notice the
  // teardown before it reaches IPC.
  view.destroy()
  release()
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.code, 'cancelled')
  assert.equal(fake.calls.pin.length, 0, 'a closed window never invokes the pin channel')
  assert.equal(fake.calls.saveDraft.length, 0)
})

test('a bridge without the pin channel degrades to a translated message instead of throwing', async (t) => {
  const fake = createFakeApi({ pinFrame: false })
  const { view, harness, video } = bootPinView({ api: fake.api })
  t.after(() => view.destroy())

  video.currentTime = 2
  const result = await view.pinCurrentFrame()
  assert.deepEqual(result, { ok: false, code: 'unavailable' })
  assert.equal(harness.elements.get('pin-frame-status').textContent, 'record.pin-frame.unavailable')
})

test('an empty selection or a missing project never reaches the pin channel', async (t) => {
  const fake = createFakeApi()
  const { view, video } = bootPinView({ api: fake.api })
  t.after(() => view.destroy())

  // Delete every segment: the editor has no content left to pin.
  view.getController().deleteSegmentAt(1500)
  view.getController().deleteSegmentAt(5500)
  view.render()
  assert.equal(view.getController().state().emptySelection, true)
  const empty = await view.pinCurrentFrame()
  assert.equal(empty.ok, false)
  assert.equal(empty.code, 'empty-selection')
  assert.equal(fake.calls.pin.length, 0)

  // A project-less view refuses before touching the preview.
  const bare = editorModule.createEditorView({ api: fake.api, document: installFakeDom().document, translate: (key) => key })
  t.after(() => bare.destroy())
  bare.boot()
  const missing = await bare.pinCurrentFrame()
  assert.equal(missing.code, 'project-missing')
  assert.equal(fake.calls.pin.length, 0)
  assert.equal(video.pauseCalls, 0)
})

// ---------------------------------------------------------------------------
// 3. channel, preload, role policy and main-process handler contracts
// ---------------------------------------------------------------------------

test('record:pin-frame is a record-editor-only invoke in the IPC policy', () => {
  const policies = buildIpcPolicies(root)
  const policy = policies.get('record:pin-frame')
  assert.ok(policy, 'record:pin-frame needs a sender policy')
  assert.equal(policy.kind, 'handle')
  assert.deepEqual(policy.pages.map(({ role }) => role), ['record-editor'], 'only the editor may pin a frame')
  const surface = IPC_SURFACES.find((entry) => entry.role === 'record-editor')
  assert.ok(surface.handles.includes('record:pin-frame'))
  // Push channels never get a policy; this one is renderer -> main only.
  assert.equal(IPC_SURFACES.some((entry) => (entry.listeners || []).includes('record:pin-frame')), false)
})

test('the editor preload exposes pinFrame on the record:pin-frame channel and sends no path', () => {
  const preload = read('preload-record-editor.js')
  assert.match(preload, /pinFrame:\s*\(projectId, png, meta\)\s*=>\s*ipcRenderer\.invoke\('record:pin-frame',\s*\{ projectId, png, meta \}\)/)
  // The payload is ids + bytes + metadata; a path or a file object never crosses this bridge.
  assert.doesNotMatch(preload, /pinFrame:[\s\S]{0,200}(filePath|targetPath|sourcePath|writeFile)/)
  const renderer = read('record/editor.js')
  assert.match(renderer, /api\.pinFrame\(project\.id, png, pinMeta\)/)
  assert.doesNotMatch(renderer, /api\.pinFrame\([^)]*(filePath|sourceUrl|targetPath)/)
  // The editor never writes frame files itself.
  assert.doesNotMatch(renderer, /require\('node:fs'\)|writeFile|tmpdir/)
})

test('the record domain handler owner-checks, then forwards to the pin budget helper', () => {
  const source = read('main/domains/record/index.js')
  const start = source.indexOf('editorPinFrame:')
  assert.ok(start > 0, 'the controller exposes editorPinFrame')
  const block = source.slice(start, source.indexOf('}\n    }', start))
  assert.match(block, /requireEditorSender\(event\)/)
  assert.match(block, /requireEditorProject\(win, payload\?\.projectId\)/)
  assert.match(block, /pinRecordFrame\(pinDomain, id, payload\)/)
  const helperStart = source.indexOf('function pinRecordFrame(')
  assert.ok(helperStart > 0)
  const helper = source.slice(helperStart, source.indexOf('function createRecordDomain('))
  assert.match(helper, /sanitizeRecordFramePin\(payload\)/)
  assert.match(helper, /pinDomain\.canPinMore\(\)/)
  assert.match(helper, /pinDomain\.createPinWindow\(pin\.bytes/)
  assert.match(helper, /code: 'pin-limit'/)
  assert.match(helper, /code: 'pin-unavailable'/)
  // No temporary file, no project write: the frame goes straight into the pin window.
  assert.doesNotMatch(helper, /writeFile|mkdtemp|tmpdir|createWriteStream|updateDraft|appendExport|saveDraft/)
  assert.match(source, /pinDomain = null/, 'the pin domain is an injected, optional collaborator')
})

test('pinRecordFrame forwards one frame under the 20-pin budget and writes nothing when refused', () => {
  const png = (width, height) => {
    const buffer = Buffer.alloc(24)
    buffer.writeUInt32BE(0x89504e47, 0)
    buffer.writeUInt32BE(0x0d0a1a0a, 4)
    buffer.writeUInt32BE(13, 8)
    buffer.write('IHDR', 12, 'ascii')
    buffer.writeUInt32BE(width, 16)
    buffer.writeUInt32BE(height, 20)
    return buffer
  }
  const created = []
  const pinDomain = {
    MAX_PINNED: 20,
    canPinMore: () => true,
    createPinWindow: (bytes, meta) => {
      created.push({ bytes, meta })
      return { _pinId: 'pin-window-9' }
    }
  }
  const ok = pinRecordFrame(pinDomain, 'project-1', { png: png(1920, 1080), meta: { frameMs: 1500, scaleFactor: 1.5 } })
  assert.equal(ok.ok, true)
  assert.equal(ok.pinId, 'pin-window-9')
  assert.equal(ok.width, 1920)
  assert.equal(ok.frameMs, 1500)
  assert.equal(created.length, 1)
  assert.ok(Buffer.isBuffer(created[0].bytes), 'the pin pipeline receives bytes, not a path')
  assert.equal(created[0].meta.source, 'record-frame')
  assert.equal(created[0].meta.projectId, 'project-1')

  // At the budget: the pin domain is never asked to create a window (no file, no slot).
  let attempts = 0
  const blocked = {
    MAX_PINNED: 20,
    canPinMore: () => false,
    createPinWindow: () => { attempts += 1; throw new Error('must not be called') }
  }
  assert.deepEqual(pinRecordFrame(blocked, 'project-1', { png: png(10, 10) }), { ok: false, code: 'pin-limit', max: 20 })
  assert.equal(attempts, 0)
  // Missing collaborator degrades to a code instead of throwing.
  assert.equal(pinRecordFrame(null, 'project-1', { png: png(10, 10) }).code, 'pin-unavailable')
  // A race: the budget fills between the probe and createPinWindow.
  let probes = 0
  const racer = {
    MAX_PINNED: 20,
    canPinMore: () => { probes += 1; return probes === 1 },
    createPinWindow: () => { throw new Error('full') }
  }
  assert.equal(pinRecordFrame(racer, 'project-1', { png: png(10, 10) }).code, 'pin-limit')
  assert.equal(pinRecordFrame(racer, 'project-1', { png: png(10, 10) }).code, 'pin-limit')
  // Malformed bytes never reach the pin domain.
  let touched = 0
  const strict = { MAX_PINNED: 20, canPinMore: () => true, createPinWindow: () => { touched += 1; return {} } }
  assert.equal(pinRecordFrame(strict, 'project-1', { png: Buffer.from('nope') }).code, 'invalid-image')
  assert.equal(touched, 0)
})

test('sanitizeRecordFramePin validates the PNG bytes and ignores a lying payload size', () => {
  const png = (width, height) => {
    const buffer = Buffer.alloc(24)
    buffer.writeUInt32BE(0x89504e47, 0)
    buffer.writeUInt32BE(0x0d0a1a0a, 4)
    buffer.writeUInt32BE(13, 8)
    buffer.write('IHDR', 12, 'ascii')
    buffer.writeUInt32BE(width, 16)
    buffer.writeUInt32BE(height, 20)
    return buffer
  }

  const ok = sanitizeRecordFramePin({
    png: png(1920, 1080),
    meta: { width: 99, height: 99, frameMs: 1500.4, scaleFactor: 1.5, capturedAt: 7 }
  })
  assert.equal(ok.ok, true)
  assert.equal(ok.meta.width, 1920, 'the pixel size comes from the PNG header, never the claim')
  assert.equal(ok.meta.height, 1080)
  assert.equal(ok.meta.frameMs, 1500)
  assert.equal(ok.meta.scaleFactor, 1.5)
  assert.equal(ok.meta.capturedAt, 7)
  assert.equal(ok.meta.source, 'record-frame')
  assert.deepEqual(Object.keys(ok.meta).sort(), ['capturedAt', 'frameMs', 'height', 'scaleFactor', 'source', 'width'])

  // Empty / malformed / oversized payloads are refused before the pin domain sees them.
  assert.equal(sanitizeRecordFramePin({}).code, 'invalid-image')
  assert.equal(sanitizeRecordFramePin({ png: Buffer.alloc(0) }).code, 'invalid-image')
  assert.equal(sanitizeRecordFramePin({ png: Buffer.from('not a png at all, not even close') }).code, 'invalid-image')
  assert.equal(sanitizeRecordFramePin({ png: Buffer.alloc(PIN_FRAME_MAX_BYTES + 1) }).code, 'frame-too-large')
  assert.equal(sanitizeRecordFramePin({ png: png(9000, 100) }).code, 'frame-too-large')
  // Uint8Array and ArrayBuffer arrive like that through Electron's structured clone.
  const typed = new Uint8Array(png(640, 480))
  assert.equal(sanitizeRecordFramePin({ png: typed }).meta.width, 640)
  const arrayBuffer = typed.buffer.slice(typed.byteOffset, typed.byteOffset + typed.byteLength)
  assert.equal(sanitizeRecordFramePin({ png: arrayBuffer }).meta.height, 480)
  // An unknown scale falls back to 1 rather than producing a NaN window size.
  assert.equal(sanitizeRecordFramePin({ png: png(640, 480), meta: { scaleFactor: 'x' } }).meta.scaleFactor, 1)
})

test('the timeline, the markup and ELEMENT_IDS agree on the pin controls', () => {
  const html = read('record/editor.html')
  assert.match(html, /id="pin-frame"[^>]*data-testid="pin-frame"/)
  assert.match(html, /data-i18n="record\.pin-frame\.action"/)
  assert.match(html, /data-i18n-title="record\.pin-frame\.title"/)
  assert.match(html, /id="pin-frame-status"[^>]*role="status"/)
  assert.ok(editorModule.ELEMENT_IDS.includes('pin-frame'))
  assert.ok(editorModule.ELEMENT_IDS.includes('pin-frame-status'))
  // The phase-1 scope is stated in the title, not silently promised: source frame only.
  assert.match(html, /record\.pin-frame\.title/)
})

test('the pin copy exists in all three languages and differs per language', () => {
  globalThis.__LOCALES = {}
  for (const name of fs.readdirSync(path.join(root, 'shared', 'locales')).filter((entry) => entry.endsWith('.js'))) {
    delete require.cache[require.resolve(path.join(root, 'shared', 'locales', name))]
    require(path.join(root, 'shared', 'locales', name))
  }
  const tables = globalThis.__LOCALES
  const keys = [
    'record.pin-frame.action',
    'record.pin-frame.title',
    'record.pin-frame.busy',
    'record.pin-frame.succeeded',
    'record.pin-frame.limit',
    'record.pin-frame.empty',
    'record.pin-frame.no-frame',
    'record.pin-frame.failed',
    'record.pin-frame.cancelled',
    'record.pin-frame.unavailable'
  ]
  for (const key of keys) {
    for (const language of ['zh-CN', 'en-US', 'zh-TW']) {
      assert.equal(typeof tables[language][key], 'string', language + ' is missing ' + key)
      assert.ok(tables[language][key].length > 0)
    }
    assert.notEqual(tables['zh-CN'][key], tables['en-US'][key], key + ' must be translated')
    assert.notEqual(tables['zh-CN'][key], tables['zh-TW'][key], key + ' must be translated')
  }
  // The limit message carries the budget number the main process reported.
  assert.match(tables['en-US']['record.pin-frame.limit'], /\{max\}/)
  assert.match(tables['zh-CN']['record.pin-frame.limit'], /\{max\}/)
})

test('the editor sources add no untranslated Chinese copy for the pin feature', () => {
  const cjk = /[\u4e00-\u9fff]/
  for (const file of ['record/editor.js', 'record/editor.html']) {
    const offenders = read(file).split(/\r?\n/).filter((line) => cjk.test(line))
    assert.deepEqual(offenders, [], file + ' must keep its copy in shared/locales/record.js')
  }
})

test('the frame-pin path never needs a temporary file (main handler + renderer source)', () => {
  // The renderer only produces an in-memory Blob -> Uint8Array; main only validates and pins.
  const renderer = read('record/editor.js')
  const pinStart = renderer.indexOf('async function captureCurrentFrame(')
  const pinEnd = renderer.indexOf('async function pinCurrentFrame(')
  assert.ok(pinStart > 0 && pinEnd > pinStart)
  const grab = renderer.slice(pinStart, pinEnd)
  assert.match(grab, /canvasToPngBytes\(canvas\)/)
  assert.doesNotMatch(grab, /fs\.|writeFile|createObjectURL|download/)
  // Main's payload sanitizer is pure (header inspection only, no filesystem access).
  const domain = read('main/domains/record/index.js')
  const sanitizerStart = domain.indexOf('function sanitizeRecordFramePin(')
  const sanitizerEnd = domain.indexOf('function createRecordDomain(')
  const sanitizer = domain.slice(sanitizerStart, sanitizerEnd)
  assert.match(sanitizer, /readPngSize\(bytes\)/)
  assert.doesNotMatch(sanitizer, /fs\.|writeFile|mkdir|tmpdir/)
})
