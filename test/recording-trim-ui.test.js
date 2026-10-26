'use strict'

// Feature E3 UI contract (plan §8.2/§8.3:
// docs/plans/2026-10-25-snow-apps-feature-development-plan.md).
//
// Three layers are pinned here, in increasing specificity:
//   1. the markup/CSS wiring the recorder window loads (trim rail, GIF controls, result bar);
//   2. the IPC surface the renderer actually calls (preload channels that must exist and must
//      never carry a path);
//   3. the view's behaviour over a fake DOM, so "render the controller state" and the result-bar
//      contract are exercised for real instead of being matched as source strings.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8')

const {
  GIF_FRAME_RATES,
  LOCALE_KEYS,
  errorKey
} = require('../record/trim-controller')
const { EXPORT_ERROR_CODES } = require('../main/services/recording-export-service')

// ---------------------------------------------------------------------------
// markup + stylesheet
// ---------------------------------------------------------------------------

test('the preview markup carries the trim rail, GIF options and the feature-A result bar', () => {
  const html = read('record/record.html')
  for (const id of [
    'trimPanel', 'trimDuration', 'trimSelection',
    'trimStartRange', 'trimEndRange', 'trimStartInput', 'trimEndInput',
    'trimPlayRange', 'trimReset',
    'trimFormat', 'trimGifEdge', 'trimGifFps', 'trimGifMeta',
    'trimProgress', 'trimProgressBar', 'trimExport',
    'recordResultBar', 'recordResultName', 'recordResultOpen', 'recordResultCopy',
    'recordResultReveal', 'recordResultStatus', 'recordResultClose'
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `record.html exposes #${id}`)
  }
  // Both trim points offer a slider AND a numeric field (plan §8.2: "input a time or drag").
  assert.match(html, /id="trimStartInput"[^>]*type="text"/)
  assert.match(html, /id="trimStartRange"[^>]*type="range"/)
  assert.match(html, /id="trimEndInput"[^>]*type="text"/)
  assert.match(html, /id="trimEndRange"[^>]*type="range"/)
  // GIF is offered with the two size controls and an explicit "no audio" note.
  assert.match(html, /<option value="gif"/)
  assert.match(html, /<option value="mp4"/)
  for (const fps of GIF_FRAME_RATES) assert.match(html, new RegExp(`<option value="${fps}"`))
  assert.match(html, /record\.trim\.gif-no-audio/)
  // The legacy MP4 button survives until every production caller has migrated (plan §8.3).
  assert.match(html, /id="saveMp4"/)
  // The scripts load in dependency order: shared options -> controller -> view -> record.js.
  assert.match(html, /shared\/recording-export-options\.js[\s\S]*trim-controller\.js[\s\S]*trim-view\.js[\s\S]*record\.js/)
})

test('the trim panel styles both formats without inline styles (CSP-safe) and keeps GIF rows hidden for MP4', () => {
  const css = read('record/record.css')
  assert.match(css, /\.trim-panel\{/)
  assert.match(css, /\.trim-rail\{/)
  assert.match(css, /\.trim-slider\{/)
  assert.match(css, /\.trim-time\{/)
  assert.match(css, /\.record-result-bar\{/)
  // The GIF-only rows are hidden by a data-attribute selector, which the view sets; no inline style
  // is written from JavaScript (the window CSP allows style-src 'unsafe-inline' only for the
  // existing token sheet, and feature code must not add another reason).
  assert.match(css, /body\[data-format="mp4"\] \.trim-gif-only\{display:none\}/)
  // The preview grid gained the two feature rows and still reserves the action row.
  assert.match(css, /\.preview-view\{[^}]*grid-template-rows:52px minmax\(0,1fr\) auto auto 28px 58px/)
})

// ---------------------------------------------------------------------------
// preload + IPC surface
// ---------------------------------------------------------------------------

test('preload-record exposes the export channels and never accepts a path', () => {
  const preload = read('preload-record.js')
  for (const channel of [
    'record:probe-session',
    'record:export',
    'record:export-status',
    'record:cancel-export',
    'record:close-preview',
    'export:perform-action'
  ]) {
    assert.match(preload, new RegExp(`ipcRenderer\\.invoke\\('${channel}'`), `preload calls ${channel}`)
  }
  assert.match(preload, /ipcRenderer\.on\('record:export-progress'/)
  assert.match(preload, /onExportProgress:/)
  assert.match(preload, /exportAction:/)
  // Ownership of every filesystem decision stays in the main process: the bridge takes a request
  // object with a range/format, a query object with ids, and a resultId+action pair - never a path.
  assert.doesNotMatch(preload, /targetPath/)
  assert.doesNotMatch(preload, /outputPath/)
  assert.doesNotMatch(preload, /sourcePath/)
})

test('the export channels are declared for the record role only, plus the shared result action', () => {
  const security = read('main/services/ipc-security.js')
  const recordSurface = security.slice(security.indexOf("role: 'record'"), security.indexOf("role: 'record-frame'"))
  for (const channel of ['record:export', 'record:export-status', 'record:cancel-export', 'record:probe-session', 'record:close-preview']) {
    assert.match(recordSurface, new RegExp(`'${channel}'`), `record role owns ${channel}`)
  }
  // Feature A's action channel is shared with the recorder, so its payload contract must not change.
  assert.match(recordSurface, /'export:perform-action'/)
  // The push channel must NOT be in a policy list (there is nothing to send).
  assert.doesNotMatch(security, /'record:export-progress'/)
})

test('record.js opens/closes the trim view without owning the range state', () => {
  const script = read('record/record.js')
  // The view's lifecycle is wired where the recorder already transitions states.
  assert.match(script, /ensureTrimView\(\)/)
  assert.match(script, /view\.attach\(\{ id: sessionId, previewUrl: result\.previewUrl \}, durationMs\)/)
  assert.match(script, /trimView\?\.teardown\(\)/)
  assert.match(script, /trimView\?\.handleTask\(task\)/)
  assert.match(script, /trimView\?\.retranslate\(\)/)
  assert.match(script, /closePreview\(/)
  // The range/format logic stays in the controller: record.js must not compute a GIF budget or
  // call ffmpeg argument builders itself.
  assert.doesNotMatch(script, /estimateGifFrames/)
  assert.doesNotMatch(script, /buildExportArgs/)
  // The legacy save path no longer closes the window, because closing would strand the source.
  const saveMp4 = script.slice(script.indexOf('async function saveMp4'), script.indexOf('async function rerecord'))
  assert.doesNotMatch(saveMp4, /window\.recordAPI\.close\(\)/)
  assert.match(saveMp4, /setBusy\(false\)/)
})

// ---------------------------------------------------------------------------
// the view over a fake DOM
// ---------------------------------------------------------------------------

// Minimal element double: the view only uses the handful of DOM members below, so a full jsdom is
// not needed (and the repo deliberately has no jsdom dependency).
class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase()
    this.id = ''
    this.hidden = false
    this.disabled = false
    this.value = ''
    this.max = ''
    this.step = ''
    this.textContent = ''
    this.title = ''
    this.src = ''
    this.currentTime = 0
    this.dataset = {}
    this.style = {}
    this.className = ''
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
    this.listeners = new Map()
    this.attributes = new Map()
  }

  addEventListener(event, listener) {
    if (!this.listeners.has(event)) this.listeners.set(event, [])
    this.listeners.get(event).push(listener)
  }

  dispatch(event) {
    for (const listener of this.listeners.get(event) || []) listener({ type: event })
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value))
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null
  }

  play() {
    this.played = (this.played || 0) + 1
    return Promise.resolve()
  }

  pause() {
    this.paused = (this.paused || 0) + 1
  }
}

const VIEW_ELEMENT_IDS = [
  'trimPanel', 'trimDuration', 'trimSelection', 'trimStartRange', 'trimEndRange',
  'trimStartInput', 'trimEndInput', 'trimPlayRange', 'trimReset', 'trimFormat',
  'trimGifEdge', 'trimGifFps', 'trimGifMeta', 'trimProgress', 'trimProgressBar',
  'trimExport', 'recordResultBar', 'recordResultName', 'recordResultOpen',
  'recordResultCopy', 'recordResultReveal', 'recordResultStatus', 'recordResultClose',
  'preview'
]

function installFakeDocument() {
  const elements = new Map()
  for (const id of VIEW_ELEMENT_IDS) {
    const element = new FakeElement(id === 'preview' ? 'video' : 'div')
    element.id = id
    elements.set(id, element)
  }
  const body = new FakeElement('body')
  const previous = globalThis.document
  globalThis.document = {
    body,
    getElementById: (id) => elements.get(id) || null
  }
  return {
    elements,
    body,
    restore() {
      globalThis.document = previous
    }
  }
}

// The view module is a classic-script/CommonJS dual module; requiring it in node returns the
// factory and needs `record/trim-controller` resolvable (it is, through the same relative path).
function loadView() {
  return require('../record/trim-view')
}

function makeBridge({ probeResult = null, exportAnswer = null, cancelAnswer = null, actions = [] } = {}) {
  const calls = { probe: [], export: [], cancel: [], action: [] }
  return {
    calls,
    probeSession: async (sessionId, durationMs) => {
      calls.probe.push({ sessionId, durationMs })
      return probeResult || {
        ok: true,
        metadata: {
          durationMs: 10000,
          startMs: 0,
          timebase: 'ms-media-timeline',
          video: { width: 1280, height: 720, frameRate: 30 },
          audio: { exists: true }
        }
      }
    },
    exportRecording: async (sessionId, requestId, request) => {
      calls.export.push({ sessionId, requestId, request })
      return exportAnswer || { status: 'accepted', task: { taskId: 'task-1', state: 'running' } }
    },
    exportStatus: async (query) => ({ ok: true, task: { taskId: 'task-1', state: 'running' } }),
    cancelExport: async (query) => {
      calls.cancel.push(query)
      return cancelAnswer || { ok: true, state: 'cancelling', task: { taskId: 'task-1', state: 'cancelling' } }
    },
    exportAction: async (resultId, action) => {
      calls.action.push({ resultId, action })
      return actions.shift() || { status: 'done' }
    }
  }
}

test('the trim view renders the controller state and shows the real duration from the probe', async (t) => {
  const documentHarness = installFakeDocument()
  t.after(() => documentHarness.restore())
  const { createTrimView } = loadView()
  const api = makeBridge()
  const view = createTrimView({
    api,
    translate: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key)
  })
  const attached = await view.attach({ id: 'session-1' }, 12000)
  assert.equal(attached, true)
  assert.equal(view.isPanelVisible(), true)
  assert.equal(api.calls.probe.length, 1)
  // The renderer's 12 s estimate is only a cross-check; the probed 10 s drives the rail.
  assert.equal(api.calls.probe[0].durationMs, 12000)
  assert.equal(view.displayDuration(12000), '00:10.0')
  assert.equal(documentHarness.elements.get('trimStartRange').max, '10000')
  assert.equal(documentHarness.elements.get('trimEndRange').max, '10000')
  assert.match(documentHarness.elements.get('trimSelection').textContent, /record\.trim\.selection/)

  // Switching to GIF shows the frame estimate and hides nothing by inline style: the CSS rule keys
  // off the body data-format attribute the view sets.
  documentHarness.elements.get('trimFormat').value = 'gif'
  documentHarness.elements.get('trimFormat').dispatch('change')
  assert.equal(documentHarness.body.dataset.format, 'gif')
  assert.match(documentHarness.elements.get('trimGifMeta').textContent, /frames/)
  // The GIF no-audio copy is in the markup (not injected), so it is translated by applyTranslations.
  assert.match(read('record/record.html'), /record\.trim\.gif-no-audio/)
})

test('the trim view drives range playback through the controller and pauses at the end', async (t) => {
  const documentHarness = installFakeDocument()
  t.after(() => documentHarness.restore())
  const { createTrimView } = loadView()
  const view = createTrimView({ api: makeBridge(), translate: (key) => key })
  await view.attach({ id: 'session-1' }, 10000)

  const startRange = documentHarness.elements.get('trimStartRange')
  startRange.value = '2000'
  startRange.dispatch('input')
  const endRange = documentHarness.elements.get('trimEndRange')
  endRange.value = '4000'
  endRange.dispatch('input')
  assert.deepEqual(view.getController().state().range, { startMs: 2000, endMs: 4000 })

  assert.equal(view.startRangePlayback(), true)
  const video = documentHarness.elements.get('preview')
  assert.equal(video.currentTime, 2, 'range playback starts at the trim start')
  assert.equal(view.getController().state().playing.startMs, 2000)

  // Simulate the media clock reaching the end: the view must pause and land on endMs.
  video.currentTime = 4
  const { RANGE_PLAY_POLL_MS } = loadView()
  await new Promise((resolve) => setTimeout(resolve, RANGE_PLAY_POLL_MS * 2))
  assert.ok(video.paused >= 1, 'playback must pause at the end of the selection')
  assert.equal(view.getController().state().playing, null)
  // The trim points are untouched by playback (plan §8.2).
  assert.deepEqual(view.getController().state().range, { startMs: 2000, endMs: 4000 })
  view.teardown()
})

test('the trim view submits the frozen request once and shows the result bar only on success', async (t) => {
  const documentHarness = installFakeDocument()
  t.after(() => documentHarness.restore())
  const { createTrimView } = loadView()
  const api = makeBridge()
  const view = createTrimView({ api, translate: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key) })
  await view.attach({ id: 'session-1' }, 10000)

  const answer = await view.exportSelection()
  assert.equal(answer.status, 'accepted')
  assert.equal(api.calls.export.length, 1)
  assert.equal(api.calls.export[0].sessionId, 'session-1')
  // The request carries the range and the format only: no path, no argv.
  assert.deepEqual(Object.keys(api.calls.export[0].request).sort(), ['format', 'range'])
  assert.equal(documentHarness.elements.get('recordResultBar').hidden, true, 'no bar before a receipt')

  // A progress push drives the bar but never reports 100 before publish.
  view.handleTask({ taskId: 'task-1', state: 'running', progress: 42 })
  assert.equal(documentHarness.elements.get('trimProgress').hidden, false)
  assert.equal(documentHarness.elements.get('trimProgressBar').style.width, '42%')

  // Publishing: the export button says "finishing" and the cancel path is closed.
  view.handleTask({ taskId: 'task-1', state: 'publishing', progress: 99 })
  assert.equal(documentHarness.elements.get('trimExport').textContent, 'record.trim.finishing')
  assert.equal(view.getController().state().canCancel, false)

  // Succeeded: exactly the feature-A receipt appears.
  view.handleTask({
    taskId: 'task-1',
    state: 'succeeded',
    progress: 100,
    receipt: { status: 'saved', resultId: 'result-7', fileName: 'clip.mp4', kind: 'mp4' }
  })
  assert.equal(documentHarness.elements.get('recordResultBar').hidden, false)
  assert.deepEqual(view.getReceipt(), { status: 'saved', resultId: 'result-7', fileName: 'clip.mp4', kind: 'mp4' })
  assert.match(documentHarness.elements.get('recordResultName').textContent, /clip\.mp4/)

  // The bar's actions go to feature A's resultId-addressed channel.
  await view.runResultAction('copy-path')
  assert.deepEqual(api.calls.action.at(-1), { resultId: 'result-7', action: 'copy-path' })
  view.teardown()
})

test('a cancelled or failed export never shows a result bar', async (t) => {
  const documentHarness = installFakeDocument()
  t.after(() => documentHarness.restore())
  const { createTrimView } = loadView()

  const cancelled = createTrimView({
    api: makeBridge({ exportAnswer: { status: 'cancelled' } }),
    translate: (key) => key
  })
  await cancelled.attach({ id: 'session-1' }, 10000)
  await cancelled.exportSelection()
  assert.equal(cancelled.getReceipt(), null)
  assert.equal(documentHarness.elements.get('recordResultBar').hidden, true)
  cancelled.teardown()

  const failed = createTrimView({
    api: makeBridge({ exportAnswer: { status: 'failed', code: 'encode-failed' } }),
    translate: (key) => key,
    reportError: (error) => { failedReported = error }
  })
  let failedReported = null
  await failed.attach({ id: 'session-1' }, 10000)
  await failed.exportSelection()
  assert.equal(failed.getReceipt(), null)
  assert.equal(documentHarness.elements.get('recordResultBar').hidden, true)
  failed.teardown()
})

test('a probe failure disables export and reports why instead of exporting a guess', async (t) => {
  const documentHarness = installFakeDocument()
  t.after(() => documentHarness.restore())
  const { createTrimView } = loadView()
  const reported = []
  const view = createTrimView({
    api: makeBridge({ probeResult: { ok: false, code: 'renderer-duration-disagrees' } }),
    translate: (key) => key,
    reportError: (error) => reported.push(error)
  })
  const attached = await view.attach({ id: 'session-1' }, 12000)
  assert.equal(attached, false)
  assert.equal(view.getController(), null)
  // Every trim control is disabled and the export button cannot submit.
  assert.equal(documentHarness.elements.get('trimExport').disabled, true)
  assert.equal(documentHarness.elements.get('trimStartRange').disabled, true)
  assert.equal(documentHarness.elements.get('trimEndInput').disabled, true)
  assert.deepEqual(reported, [{ i18nKey: 'record.error.export-renderer-duration-disagrees' }])
  // A failed submit is refused rather than producing a request with no range.
  const answer = await view.exportSelection()
  assert.equal(answer.status, 'failed')
  view.teardown()
})

// Regression (E-01, found by adversarial review): the export button doubles as the CANCEL control
// while a task runs, but `render()` disabled it on `!canExport` - and `canExport` is false for
// exactly the `submitting`/`active` phases where `canCancel` becomes true. So the only cancel
// affordance in the UI was permanently greyed out and a running export could not be stopped at all.
//
// This test exists because the shipped harness could not see it: `FakeElement.dispatch` invokes the
// listeners directly, so a `disabled` button still "clicks". A real browser dispatches no click on a
// disabled control, so the assertion here has to model that. `dispatchClick` below refuses to fire
// when `disabled` is true, which is the behaviour difference that hid the bug.
test('a running export can actually be cancelled from the one button the UI offers', async (t) => {
  const documentHarness = installFakeDocument()
  t.after(() => documentHarness.restore())
  const { createTrimView } = loadView()

  const api = makeBridge()
  const view = createTrimView({ api, translate: (key) => key })
  await view.attach({ id: 'session-1' }, 10000)

  // Start an export; the bridge answers `accepted` + a running task, so the view enters `active`.
  await view.exportSelection()
  const controller = view.getController()
  const state = controller.state()
  assert.equal(state.busy, true, 'the export must be running for this test to mean anything')
  assert.equal(state.canCancel, true, 'a running task must offer cancel')
  assert.equal(state.canExport, false, 'a second export must not be allowed while one runs')

  const button = documentHarness.elements.get('trimExport')
  // The button must be CLICKABLE in this phase. `canExport` alone is the wrong predicate: the same
  // control is the cancel action now.
  assert.equal(
    button.disabled,
    false,
    'the cancel control must not be disabled while the task it cancels is running'
  )
  assert.equal(button.dataset.action, 'cancel', 'the button advertises the cancel action')

  // Click it the way a browser would: a disabled control dispatches nothing, so honour that flag
  // rather than calling the listeners directly (the weakness in `FakeElement.dispatch`).
  const cancelsBefore = api.calls.cancel.length
  const dispatchesClick = button.disabled !== true
  if (dispatchesClick) button.dispatch('click')
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(
    dispatchesClick,
    true,
    'the user gesture must reach the handler at all (this is exactly what the bug prevented)'
  )
  assert.equal(
    api.calls.cancel.length,
    cancelsBefore + 1,
    'clicking the button while a task runs must call cancelExport'
  )
  assert.equal(api.calls.cancel[api.calls.cancel.length - 1].taskId, 'task-1', 'it must cancel THIS task')
  view.teardown()
})

test('the cancel control is enabled for every state that has an action', async (t) => {
  const documentHarness = installFakeDocument()
  t.after(() => documentHarness.restore())
  const { createTrimView } = loadView()

  // Idle and exportable: enabled, and it is the export action.
  const idle = createTrimView({ api: makeBridge(), translate: (key) => key })
  await idle.attach({ id: 'session-1' }, 10000)
  const idleButton = documentHarness.elements.get('trimExport')
  assert.equal(idleButton.disabled, false, 'an exportable idle state keeps the button live')
  assert.equal(idleButton.dataset.action, 'export')
  idle.teardown()

  // Running: still enabled, now the cancel action. (The controller clamps its own range, so an
  // idle-but-invalid state is not reachable through the public setters - which is why the bug was
  // specifically about the ACTIVE phase, not about validation.)
  const running = createTrimView({ api: makeBridge(), translate: (key) => key })
  await running.attach({ id: 'session-1' }, 10000)
  await running.exportSelection()
  const runningState = running.getController().state()
  assert.equal(runningState.busy, true)
  assert.equal(runningState.canCancel, true)
  assert.equal(runningState.canExport, false)
  const runningButton = documentHarness.elements.get('trimExport')
  assert.equal(runningButton.disabled, false, 'the cancel affordance must be live while running')
  assert.equal(runningButton.dataset.action, 'cancel')
  running.teardown()
})

test('every export error code maps to a locale key that all three tables define', () => {
  globalThis.__LOCALES = {}
  require('../shared/locales/record.js')
  const tables = globalThis.__LOCALES
  for (const code of EXPORT_ERROR_CODES) {
    const key = errorKey(code)
    assert.match(key, /^record\.error\./, `${code} must map to a locale key`)
    for (const language of ['zh-CN', 'en-US', 'zh-TW']) {
      assert.equal(typeof tables[language][key], 'string', `${language} is missing ${key} (code ${code})`)
    }
  }
  assert.equal(errorKey('not-a-real-code'), 'record.error.export-failed')
  // The controller's advertised key list must be exactly what it resolves.
  for (const key of LOCALE_KEYS) {
    for (const language of ['zh-CN', 'en-US', 'zh-TW']) {
      assert.equal(typeof tables[language][key], 'string', `${language} is missing the advertised key ${key}`)
    }
  }
})

test('record.css and the markup keep no untranslated Chinese copy (i18n gate stays clear)', () => {
  // The record area's pre-existing CJK lines are three `throw` messages in recording-utils.js and
  // ONE reviewer comment in record.js; the feature-E window files add none of their own. Pinning the
  // exact allowance (rather than "zero") keeps the check honest: a new untranslated string fails,
  // and removing the legacy line fails too, so the allowance cannot silently grow.
  const cjk = /[\u4e00-\u9fff]/
  const allowed = new Set([
    'record/record.js: // 系统声也关着时已无任何音轨，不能照抄"仅保留系统声音"（文案必须与文件实际内容一致）。'
  ])
  const offenders = []
  for (const file of ['record/record.html', 'record/record.css', 'record/record.js', 'record/trim-view.js', 'record/trim-controller.js']) {
    const lines = read(file).split(/\r?\n/)
    lines.forEach((line, index) => {
      if (!cjk.test(line)) return
      const entry = `${file}: ${line.trim()}`
      if (allowed.has(entry)) return
      offenders.push(`${file}:${index + 1}: ${line.trim()}`)
    })
  }
  assert.deepEqual(offenders, [], 'feature E UI copy must live in shared/locales/record.js')
  // The allowance itself must still match a real line: a stale entry would hide a new one.
  for (const entry of allowed) {
    const [file] = entry.split(': ')
    assert.ok(read(file).includes(entry.slice(entry.indexOf(': ') + 2)), `stale CJK allowance: ${entry}`)
  }
})
