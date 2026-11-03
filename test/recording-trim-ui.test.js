'use strict'

// Feature-E3 trim/export UI contract, migrated from the recorder window to the standalone
// recording editor (R1-R3 contract §9.3/§11). The old preview surface lived in
// record/record.html; W3 removed it and the window that now owns trim/export is
// record/editor.html. This file keeps the three assertions that always mattered:
//   1. the markup and stylesheet wire the one-track dual-handle timeline, GIF controls and
//      the feature-A result bar (no dead Save MP4 entry);
//   2. the IPC surface the editor actually calls never carries a path, and the preload /
//      ipc-security role owns exactly the frozen editor channels;
//   3. the shared trim controller (DOM-free) still normalises ranges, freezes a submitted
//      export, allows a retry with a new requestId, and refuses a recovery project.
//
// The fake-DOM view behaviour (drag handles, range playback, result-bar rendering) moved to
// test/recording-editor-ui.test.js because the view itself moved to record/editor.js.
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
const timeline = require('../record/editor-timeline')

// ---------------------------------------------------------------------------
// markup + stylesheet
// ---------------------------------------------------------------------------

test('the editor markup carries the one-track timeline, precise inputs, GIF options and the feature-A result bar', () => {
  const html = read('record/editor.html')
  for (const id of [
    // The single-track rail with two draggable handles (replaces the two old sliders).
    'timeline', 'timeline-track', 'timeline-selection', 'timeline-playhead',
    'handle-start', 'handle-end',
    // Precise time inputs and the play-selection / full-range controls.
    'range-start-input', 'range-end-input', 'range-selection',
    'play-range', 'reset-range',
    // Export settings moved into the editor's right panel.
    'export-format', 'gif-edge', 'gif-fps', 'gif-budget', 'export-final-size',
    // One export action, its progress and cancel controls.
    'export-button', 'export-progress', 'export-progress-bar', 'cancel-export',
    // Feature-A result bar: open / address / reveal, dismiss, and a status line.
    'result-bar', 'result-name', 'result-open', 'result-address',
    'result-reveal', 'result-status', 'result-dismiss'
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `editor.html exposes #${id}`)
  }
  // Precise inputs are text fields (not the old range sliders); the handles are keyboard
  // focusable role=slider controls on ONE track.
  assert.match(html, /id="range-start-input"[^>]*type="text"/)
  assert.match(html, /id="range-end-input"[^>]*type="text"/)
  assert.match(html, /id="handle-start"[^>]*type="button"[^>]*role="slider"/)
  assert.match(html, /id="handle-end"[^>]*type="button"[^>]*role="slider"/)
  // GIF is offered with its two budget controls and an explicit "no audio" note.
  assert.match(html, /<option value="gif"/)
  assert.match(html, /<option value="mp4"/)
  for (const fps of GIF_FRAME_RATES) assert.match(html, new RegExp(`<option value="${fps}"`))
  assert.match(html, /recording\.editor\.gif-no-audio/)
  // The legacy MP4 button and the old two-format export entry are gone: Export is the only
  // save action (contract §11 "one primary Export").
  assert.doesNotMatch(html, /id="saveMp4"/)
  assert.doesNotMatch(html, /id="trimStartRange"/)
  assert.doesNotMatch(html, /id="trimEndRange"/)
  // The scripts load in dependency order: shared options -> controller -> timeline -> editor.
  assert.match(html, /shared\/recording-export-options\.js[\s\S]*trim-controller\.js[\s\S]*editor-timeline\.js[\s\S]*editor\.js/)
  // The editor does not load the recorder's script model.
  assert.doesNotMatch(html, /src="record\.js"/)
})

test('the editor panel styles both formats without inline styles and keeps GIF rows hidden for MP4', () => {
  const css = read('record/editor.css')
  assert.match(css, /\.timeline-track/)
  assert.match(css, /\.timeline-selection/)
  assert.match(css, /\.timeline-handle/)
  assert.match(css, /\.export-panel/)
  assert.match(css, /\.result-bar/)
  // The GIF-only rows are hidden by a data-attribute selector the view sets; no inline style
  // is written from JavaScript for static layout (CSP-safe).
  assert.match(css, /body\[data-format="mp4"\] \.gif-fields/)
  // The panel adapts on narrow windows instead of forcing a fixed two-column width.
  assert.match(css, /@media \(max-width: 980px\)/)
  // The markup itself carries no inline styles.
  assert.doesNotMatch(read('record/editor.html'), /style="[^"]*"/)
})

// ---------------------------------------------------------------------------
// preload + IPC surface
// ---------------------------------------------------------------------------

test('preload-record-editor exposes the editor channels and never accepts a path', (t) => {
  const preloadPath = path.join(root, 'preload-record-editor.js')
  if (!fs.existsSync(preloadPath)) {
    t.skip('preload-record-editor.js is owned by W2 and has not landed yet')
    return
  }
  const preload = fs.readFileSync(preloadPath, 'utf8')
  for (const channel of [
    'record-editor:save-draft',
    'record-editor:export',
    'record-editor:export-status',
    'record-editor:cancel-export',
    'record-editor:rename',
    'record-editor:rerecord',
    'record-editor:reveal',
    'record-editor:back',
    'record-editor:reload',
    'export:perform-action'
  ]) {
    assert.ok(preload.includes(`ipcRenderer.invoke('${channel}'`), `preload calls ${channel}`)
  }
  for (const channel of ['record-editor:ready', 'record-editor:window', 'record-editor:close']) {
    assert.ok(preload.includes(`ipcRenderer.send('${channel}'`), `preload sends ${channel}`)
  }
  assert.ok(preload.includes("'record-editor:init'"), 'the editor receives its init payload')
  assert.ok(preload.includes("'record:export-progress'"), 'the editor receives export progress')
  // Ownership of every filesystem decision stays in the main process: the bridge takes ids,
  // ranges and formats - never a path.
  assert.doesNotMatch(preload, /targetPath/)
  assert.doesNotMatch(preload, /outputPath/)
  assert.doesNotMatch(preload, /sourcePath/)
})

test('the export channels are declared for the record-editor role only', (t) => {
  const security = read('main/services/ipc-security.js')
  const roleStart = security.indexOf("role: 'record-editor'")
  if (roleStart < 0) {
    t.skip('the record-editor IPC role is owned by W2 and has not landed yet')
    return
  }
  const roleEnd = security.indexOf("role: '", roleStart + 1)
  const editorSurface = security.slice(roleStart, roleEnd < 0 ? undefined : roleEnd)
  for (const channel of [
    'record-editor:save-draft',
    'record-editor:export',
    'record-editor:export-status',
    'record-editor:cancel-export',
    'record-editor:rename',
    'record-editor:rerecord',
    'record-editor:reveal',
    'record-editor:back',
    'record-editor:reload'
  ]) {
    assert.match(editorSurface, new RegExp(`'${channel}'`), `record-editor role owns ${channel}`)
  }
  // Feature A's result action is shared with every export surface, so its payload contract
  // must not change.
  assert.match(editorSurface, /'export:perform-action'/)
  // The progress push channel must NOT be in a policy list (there is nothing to send).
  assert.doesNotMatch(security, /'record-editor:init'/)
})

test('editor.js uses the project controller instead of owning range/export math itself', () => {
  const script = read('record/editor.js')
  // The view constructs the shared DOM-free controller and forwards pushed tasks into it.
  assert.match(script, /createRecordTrimController/)
  assert.match(script, /handleTask/)
  assert.match(script, /api\.saveDraft/)
  assert.match(script, /api\.exportProject/)
  // The range/format/GIF budget logic stays in the controller: the view must not compute a
  // GIF budget or build ffmpeg arguments itself.
  assert.doesNotMatch(script, /estimateGifFrames/)
  assert.doesNotMatch(script, /buildExportArgs/)
  // The old preview's save path is gone; export is the only write action.
  assert.doesNotMatch(script, /saveMp4/)
  assert.doesNotMatch(script, /closePreview/)
  // The renderer cannot address filesystem paths.
  assert.doesNotMatch(script, /\btargetPath\b/)
  assert.doesNotMatch(script, /\boutputPath\b/)
  assert.doesNotMatch(script, /\bsourcePath\b/)
})

// ---------------------------------------------------------------------------
// shared trim controller (DOM-free state machine)
// ---------------------------------------------------------------------------

function sessionController(overrides = {}) {
  return require('../record/trim-controller').createRecordTrimController({
    sessionId: 'session-1',
    metadata: {
      durationMs: 10000,
      startMs: 0,
      video: { width: 1280, height: 720, frameRate: 30 },
      audio: { exists: true }
    },
    translate: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key),
    ...overrides
  })
}

test('the shared controller still clamps a session range, freezes a submit and retries with a new request', async () => {
  const controller = sessionController()
  const state = controller.state()
  assert.deepEqual(state.range, { startMs: 0, endMs: 10000 })
  assert.equal(state.canExport, true)
  // A start at 9999 ms is clamped to end - MIN_RANGE_MS, never inverted and never shorter
  // than the exporter's minimum span.
  controller.setStart(9999)
  assert.deepEqual(controller.state().range, { startMs: 9900, endMs: 10000 })
  // The precise text input accepts the clock format the editor renders, and the same
  // minimum-span clamp applies at the end side.
  controller.setEnd('00:03.0')
  assert.deepEqual(controller.state().range, { startMs: 9900, endMs: 10000 })
  controller.resetRange()
  controller.setStart(1000)
  controller.setEnd(3000)
  assert.deepEqual(controller.state().range, { startMs: 1000, endMs: 3000 })
  assert.equal(controller.state().selectionMs, 2000)

  const requests = []
  const accepted = await controller.startExport({
    submit: async ({ requestId, request }) => {
      requests.push({ requestId, request })
      return { status: 'accepted', task: { taskId: 'task-1', state: 'running' } }
    }
  })
  assert.equal(accepted.status, 'accepted')
  // The request carries the range/format only: no path, no argv.
  assert.deepEqual(Object.keys(requests[0].request).sort(), ['format', 'range'])
  assert.deepEqual(requests[0].request.range, { startMs: 1000, endMs: 3000 })
  // Frozen while the task runs; the same control is the cancel action in that phase.
  assert.equal(controller.setStart(0), false)
  assert.equal(controller.state().canCancel, true)
  assert.equal(controller.state().frozen.range.endMs, 3000)

  // Cancel round-trips and then a retry after failure mints a NEW requestId.
  const cancelled = await controller.cancelExport({
    cancel: async () => ({ ok: true, task: { taskId: 'task-1', state: 'cancelling' } })
  })
  assert.equal(cancelled.ok, true)
  controller.applyTask({ taskId: 'task-1', state: 'cancelled' })
  assert.equal(controller.state().phase, 'cancelled')
  assert.equal(controller.prepareRetry(), true)
  const retry = await controller.startExport({
    submit: async ({ requestId, request }) => {
      requests.push({ requestId, request })
      return { status: 'failed', code: 'encode-failed' }
    }
  })
  assert.equal(retry.status, 'failed')
  assert.equal(requests.length, 2)
  assert.notEqual(requests[1].requestId, requests[0].requestId)
})

test('a session controller without a trustworthy duration refuses to export a guess', async () => {
  const controller = sessionController({ metadata: { durationMs: 0, video: { width: 0, height: 0 }, audio: { exists: false } } })
  assert.equal(controller.state().canExport, false)
  let submitted = 0
  const answer = await controller.startExport({ submit: async () => { submitted += 1; return { status: 'accepted', task: { taskId: 't', state: 'running' } } } })
  assert.equal(submitted, 0)
  assert.equal(answer.status, 'failed')
  assert.equal(controller.state().error.code, 'duration-unavailable')
})

// ---------------------------------------------------------------------------
// locale contract
// ---------------------------------------------------------------------------

test('every export error code maps to a locale key that all three tables define', () => {
  globalThis.__LOCALES = {}
  // The editor window loads the three cross-window language tables, the legacy record table
  // (export error codes / trim labels) and its own editor table; all must agree.
  for (const name of ['zh-CN.js', 'en-US.js', 'zh-TW.js', 'record.js', 'recording-editor.js']) {
    delete require.cache[require.resolve(path.join(root, 'shared', 'locales', name))]
    require(path.join(root, 'shared', 'locales', name))
  }
  const tables = globalThis.__LOCALES
  for (const code of EXPORT_ERROR_CODES) {
    const key = errorKey(code)
    assert.match(key, /^record\.error\./, `${code} must map to a locale key`)
    for (const language of ['zh-CN', 'en-US', 'zh-TW']) {
      assert.equal(typeof tables[language][key], 'string', `${language} is missing ${key} (code ${code})`)
    }
  }
  assert.equal(errorKey('not-a-real-code'), 'record.error.export-failed')
  // The controller's advertised key list must be exactly what it resolves; the editor reuses
  // those labels in three languages even though its own copy is in recording-editor.js.
  for (const key of LOCALE_KEYS) {
    for (const language of ['zh-CN', 'en-US', 'zh-TW']) {
      assert.equal(typeof tables[language][key], 'string', `${language} is missing the advertised key ${key}`)
    }
  }
  // The export success confirmation (the feature-A receipt) must exist in all three languages
  // and interpolate the file name; this replaces the old "save MP4 succeeded" message.
  for (const language of ['zh-CN', 'en-US', 'zh-TW']) {
    const message = tables[language]['capture.export-result.saved']
    assert.equal(typeof message, 'string', `${language} must define capture.export-result.saved`)
    assert.match(message, /{fileName}/, `${language} must interpolate the file name`)
  }
})

test('the editor files add no untranslated Chinese copy (i18n gate stays clear)', () => {
  // The old recorder files keep their historical allowance (owned by W3); feature copy for
  // the editor window lives in shared/locales/recording-editor.js, so these files add zero.
  const cjk = /[\u4e00-\u9fff]/
  const offenders = []
  for (const file of [
    'record/editor.html',
    'record/editor.css',
    'record/editor.js',
    'record/editor-timeline.js',
    'record/trim-controller.js'
  ]) {
    read(file).split(/\r?\n/).forEach((line, index) => {
      if (cjk.test(line)) offenders.push(`${file}:${index + 1}: ${line.trim()}`)
    })
  }
  assert.deepEqual(offenders, [], 'editor UI copy must live in shared/locales/recording-editor.js')
})

// The timeline module is unit-testable on its own; a quick sanity check here proves the
// repointed markup's gestures can be expressed with it (full coverage in
// test/recording-editor-ui.test.js).
test('the timeline module maps the editor track geometry to the same half-open range', () => {
  const rect = { left: 0, width: 1000 }
  const handle = timeline.moveHandle({ startMs: 1000, endMs: 5000 }, 'end', timeline.pointerToMs(750, rect, 10000), 10000)
  assert.deepEqual(handle, { startMs: 1000, endMs: 7500 })
  assert.equal(timeline.validateRange(handle, 10000).ok, true)
  assert.equal(timeline.validateRange({ startMs: 7450, endMs: 7500 }, 10000).code, 'range-too-short')
})
