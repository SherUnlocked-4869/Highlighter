'use strict'

// Behaviour-level contract for the standalone recording editor (R1-R3 contract §9.3/§11,
// R3 plan §4.3). Three layers are pinned here:
//   1. record/editor-timeline.js pure math (pointer -> ms, handle clamping, range validation);
//   2. record/trim-controller.js project mode (draft revision CAS, export freeze/retry,
//      recovery gate) - the state decisions, with no DOM;
//   3. record/editor.js over a fake DOM: init rendering, handle drag (and "moving the
//      playhead never edits the trim points"), export/cancel/result-bar flow, draft autosave
//      + revision-conflict reload, recovery banner, and visible degradation without a bridge.
//
// The old preview tests covered the same interaction intents; this file keeps that coverage
// for the window that now owns the preview.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8')

const timeline = require('../record/editor-timeline')
const trimController = require('../record/trim-controller')
const editorModule = require('../record/editor')
const { EXPORT_ERROR_CODES } = require('../main/services/recording-export-service')

// ---------------------------------------------------------------------------
// 1. pure timeline math
// ---------------------------------------------------------------------------

test('the timeline maps pointer positions to integer media milliseconds and back', () => {
  const rect = { left: 100, width: 800 }
  assert.equal(timeline.pointerToMs(100, rect, 4000), 0)
  assert.equal(timeline.pointerToMs(500, rect, 4000), 2000)
  assert.equal(timeline.pointerToMs(900, rect, 4000), 4000)
  // Out-of-track pointers clamp instead of producing a negative/oversized point.
  assert.equal(timeline.pointerToMs(40, rect, 4000), 0)
  assert.equal(timeline.pointerToMs(1200, rect, 4000), 4000)
  // Degenerate geometry resolves to 0 rather than NaN.
  assert.equal(timeline.pointerToMs(500, { left: 100, width: 0 }, 4000), 0)
  assert.equal(timeline.pointerToMs(500, rect, 0), 0)
  assert.equal(timeline.pointerToMs('x', rect, 4000), 0)
  assert.equal(timeline.msToPercent(2000, 4000), 50)
  assert.equal(timeline.msToPercent(-5, 4000), 0)
  assert.equal(timeline.msToPercent(5000, 4000), 100)
})

test('moving one handle never crosses the other and never makes the range too short', () => {
  const range = { startMs: 1000, endMs: 3000 }
  // The start handle cannot pass the end by more than the exporter's minimum span.
  const startAtEnd = timeline.moveHandle(range, 'start', 3500, 4000)
  assert.deepEqual(startAtEnd, { startMs: 2900, endMs: 3000 })
  assert.equal(startAtEnd.endMs - startAtEnd.startMs, timeline.MIN_RANGE_MS)
  // The end handle cannot pass the start either.
  const endAtStart = timeline.moveHandle(range, 'end', 900, 4000)
  assert.deepEqual(endAtStart, { startMs: 1000, endMs: 1100 })
  // Targets outside the media clamp to the boundary; the other handle is preserved.
  assert.deepEqual(timeline.moveHandle(range, 'start', -50, 4000), { startMs: 0, endMs: 3000 })
  assert.deepEqual(timeline.moveHandle(range, 'end', 9999, 4000), { startMs: 1000, endMs: 4000 })
  // Unknown handles are rejected rather than silently mutating the range.
  assert.equal(timeline.moveHandle(range, 'middle', 2000, 4000), null)
  assert.equal(timeline.nudgeHandle(range, 'middle', 100, 4000), null)
  // Arrow steps: 100 ms normal, 1 s with Shift.
  assert.deepEqual(timeline.nudgeHandle(range, 'end', timeline.ARROW_STEP_MS, 4000), { startMs: 1000, endMs: 3100 })
  assert.equal(timeline.keyboardStep({ shiftKey: true }), timeline.SHIFT_STEP_MS)
  assert.equal(timeline.keyboardStep({}), timeline.ARROW_STEP_MS)
  // A very short recording still yields a legal state instead of a negative span.
  assert.deepEqual(timeline.moveHandle({ startMs: 0, endMs: 60 }, 'start', 50, 60), { startMs: 0, endMs: 60 })
})

test('the timeline validates ranges with the exact exporter rules (normalizeRange reuse)', () => {
  // The same shared validator the main process applies: the UI cannot offer a range the
  // exporter will reject, and MIN_RANGE_MS comes from the shared LIMITS.
  assert.equal(timeline.MIN_RANGE_MS, require('../shared/recording-export-options').LIMITS.MIN_RANGE_MS)
  assert.equal(timeline.validateRange({ startMs: 0, endMs: 4000 }, 4000).ok, true)
  assert.equal(timeline.validateRange({ startMs: 4000, endMs: 0 }, 4000).code, 'invalid-range')
  assert.equal(timeline.validateRange({ startMs: 0, endMs: 4000 }, 0).code, 'duration-unavailable')
  assert.equal(timeline.validateRange({ startMs: 0, endMs: 50 }, 4000).code, 'range-too-short')
  assert.equal(timeline.validateRange({ startMs: -5, endMs: 4000 }, 4000).code, 'range-out-of-bounds')
  const geometry = timeline.rangeGeometry({ startMs: 1000, endMs: 3000 }, 4000)
  assert.deepEqual(
    { startPercent: geometry.startPercent, endPercent: geometry.endPercent, widthPercent: geometry.widthPercent },
    { startPercent: 25, endPercent: 75, widthPercent: 50 }
  )
  // Clock/input round-trip: the precise inputs show and accept the same millisecond basis.
  assert.equal(timeline.formatClock(1234), '00:01.2')
  assert.equal(timeline.parseTimeInput('00:01.2'), 1200)
  assert.equal(timeline.parseTimeInput('1:02'), 62000)
  assert.equal(timeline.parseTimeInput('nonsense'), null)
  assert.equal(timeline.parseTimeInput(''), null)
})

test('R4 multi-segment helpers normalise, split, delete and map source<->edited time', () => {
  const duration = 10000
  // Sort, drop invalid/short/overlapping, allow adjacency, cap at 20 segments.
  assert.deepEqual(
    timeline.normalizeSegments([
      { startMs: 5000, endMs: 7000 },
      { startMs: 1000, endMs: 3000 },
      { startMs: 2000, endMs: 4000 },
      { startMs: 3000, endMs: 3100 },
      { startMs: 100, endMs: 150 },
      { startMs: -1, endMs: 500 },
      { startMs: 9000, endMs: 12000 }
    ], duration),
    [{ startMs: 1000, endMs: 3000 }, { startMs: 3000, endMs: 3100 }, { startMs: 5000, endMs: 7000 }]
  )
  const many = Array.from({ length: 25 }, (_value, index) => ({ startMs: index * 300, endMs: index * 300 + 200 }))
  assert.equal(timeline.normalizeSegments(many, duration).length, timeline.MAX_SEGMENTS)
  // Whole-recording equivalence: [] and a single covering range are both "full".
  assert.equal(timeline.isFullRange([], duration), true)
  assert.equal(timeline.isFullRange([{ startMs: 0, endMs: duration }], duration), true)
  assert.equal(timeline.isFullRange([{ startMs: 1000, endMs: 3000 }], duration), false)
  // Split only strictly inside a kept segment, with both halves >= MIN_RANGE_MS.
  assert.deepEqual(
    timeline.splitAt([], 4000, duration),
    [{ startMs: 0, endMs: 4000 }, { startMs: 4000, endMs: duration }]
  )
  assert.equal(timeline.splitAt([], 0, duration).length, 1, 'the media start is not a split point')
  assert.equal(timeline.splitAt([{ startMs: 1000, endMs: 3000 }], 1050, duration).length, 1)
  // The 20-segment schema limit is enforced by the split helper itself.
  const atCap = Array.from({ length: timeline.MAX_SEGMENTS }, (_v, index) => ({ startMs: index * 300, endMs: index * 300 + 200 }))
  assert.equal(timeline.splitAt(atCap, 100, duration).length, timeline.MAX_SEGMENTS)
  // Delete the containing segment; deleting the only segment is the explicit "no content" state.
  assert.deepEqual(
    timeline.deleteSegmentAt([{ startMs: 0, endMs: 4000 }, { startMs: 6000, endMs: 10000 }], 1000, duration),
    [{ startMs: 6000, endMs: 10000 }]
  )
  assert.deepEqual(timeline.deleteSegmentAt([{ startMs: 0, endMs: 4000 }], 1000, duration), [])
  const segments = [{ startMs: 1000, endMs: 3000 }, { startMs: 5000, endMs: 7000 }]
  // Source -> edited mapping; deleted gaps return null (the playback skip signal).
  assert.equal(timeline.sourceToEdited(segments, 1500, duration), 500)
  assert.equal(timeline.sourceToEdited(segments, 5500, duration), 2500)
  assert.equal(timeline.sourceToEdited(segments, 4000, duration), null)
  assert.equal(timeline.sourceToEdited(segments, 8000, duration), null)
  assert.equal(timeline.editedToSource(segments, 500, duration), 1500)
  assert.equal(timeline.editedToSource(segments, 2500, duration), 5500)
  assert.equal(timeline.editedToSource(segments, 4000, duration), 7000)
  assert.equal(timeline.totalKeptMs(segments, duration), 4000)
  assert.equal(timeline.totalKeptMs([], duration), duration)
  assert.equal(timeline.segmentAt(segments, 2000, duration), 0)
  assert.equal(timeline.segmentAt(segments, 6500, duration), 1)
  assert.equal(timeline.segmentAt(segments, 4000, duration), -1)
  assert.equal(timeline.nextKeptStart(segments, 1500, duration), 5000)
  assert.equal(timeline.nextKeptStart(segments, 7000, duration), null)
})

test('R4 boundary and junction drags are neighbour-aware and never create overlaps', () => {
  const duration = 10000
  const segments = [{ startMs: 1000, endMs: 3000 }, { startMs: 5000, endMs: 7000 }]
  assert.deepEqual(timeline.moveBoundary(segments, 0, 'start', 0, duration), [{ startMs: 0, endMs: 3000 }, { startMs: 5000, endMs: 7000 }])
  assert.deepEqual(timeline.moveBoundary(segments, 0, 'start', 9000, duration), [{ startMs: 2900, endMs: 3000 }, { startMs: 5000, endMs: 7000 }])
  assert.deepEqual(timeline.moveBoundary(segments, 0, 'end', 9000, duration), [{ startMs: 1000, endMs: 5000 }, { startMs: 5000, endMs: 7000 }])
  assert.deepEqual(timeline.moveBoundary(segments, 1, 'start', 2000, duration), [{ startMs: 1000, endMs: 3000 }, { startMs: 3000, endMs: 7000 }])
  assert.deepEqual(timeline.moveBoundary(segments, 1, 'start', 3500, duration), [{ startMs: 1000, endMs: 3000 }, { startMs: 3500, endMs: 7000 }])
  assert.deepEqual(timeline.moveBoundary(segments, 1, 'end', 12000, duration), [{ startMs: 1000, endMs: 3000 }, { startMs: 5000, endMs: duration }])
  assert.deepEqual(timeline.moveBoundary(segments, 7, 'end', 9000, duration), segments, 'an unknown index is ignored')
  // A junction moves both adjacent edges: the cut stays a cut.
  const adjacent = [{ startMs: 0, endMs: 4000 }, { startMs: 4000, endMs: 8000 }]
  assert.deepEqual(timeline.moveJunction(adjacent, 1, 5000, duration), [{ startMs: 0, endMs: 5000 }, { startMs: 5000, endMs: 8000 }])
  assert.deepEqual(timeline.moveJunction(adjacent, 1, 100, duration), [{ startMs: 0, endMs: 100 }, { startMs: 100, endMs: 8000 }])
  assert.deepEqual(timeline.moveJunction(adjacent, 1, 7900, duration), [{ startMs: 0, endMs: 7900 }, { startMs: 7900, endMs: 8000 }])
  // Non-adjacent segments have no junction to drag.
  assert.deepEqual(timeline.moveJunction(segments, 1, 4000, duration), segments)
})

test('R4 video export options never upscale and never offer a frame rate above the source', () => {
  // Resolution presets are long-edge caps: hide a preset when its cap exceeds the source edge.
  assert.deepEqual(timeline.availableResolutions(1920, 1080), ['source', '1080p', '720p', '480p'])
  assert.deepEqual(timeline.availableResolutions(1280, 720), ['source', '720p', '480p'])
  assert.deepEqual(timeline.availableResolutions(640, 480), ['source'])
  assert.deepEqual(timeline.availableResolutions(0, 0), ['source'])
  // Frame rates: unknown only source; 24 only source; 30 offers 30; 60 offers both.
  assert.deepEqual(timeline.availableFrameRates(0), ['source'])
  assert.deepEqual(timeline.availableFrameRates(undefined), ['source'])
  assert.deepEqual(timeline.availableFrameRates(24), ['source'])
  assert.deepEqual(timeline.availableFrameRates(30), ['source', '30'])
  assert.deepEqual(timeline.availableFrameRates(60), ['source', '30', '60'])
  // Output size mirrors the exporter: even dimensions, aspect preserved, never upscaled.
  assert.deepEqual(timeline.computeVideoOutput({ sourceWidth: 1920, sourceHeight: 1080, resolution: '1080p' }).value.width, 1920)
  const hd = timeline.computeVideoOutput({ sourceWidth: 1920, sourceHeight: 1080, resolution: '720p' }).value
  assert.deepEqual([hd.width, hd.height], [1280, 720])
  const sd = timeline.computeVideoOutput({ sourceWidth: 1280, sourceHeight: 720, resolution: '480p' }).value
  assert.deepEqual([sd.width, sd.height], [854, 480])
  const source = timeline.computeVideoOutput({ sourceWidth: 640, sourceHeight: 480, resolution: '1080p' }).value
  assert.deepEqual([source.width, source.height], [640, 480], 'a preset above the source does not upscale')
  // Request-level normalisation: defaults, and fps-above-source is rejected.
  const defaults = timeline.normalizeVideoOptions({}, { sourceWidth: 1280, sourceHeight: 720, sourceFrameRate: 30 })
  assert.equal(defaults.ok, true)
  assert.deepEqual(
    { resolution: defaults.value.resolution, quality: defaults.value.quality, fps: defaults.value.fps, fpsValue: defaults.value.fpsValue, width: defaults.value.width, height: defaults.value.height },
    { resolution: 'source', quality: 'standard', fps: 'source', fpsValue: 30, width: 1280, height: 720 }
  )
  assert.equal(timeline.normalizeVideoOptions({ fps: 60 }, { sourceWidth: 1280, sourceHeight: 720, sourceFrameRate: 30 }).code, 'fps-above-source')
  assert.equal(timeline.normalizeVideoOptions({ fps: 30 }, { sourceWidth: 1280, sourceHeight: 720, sourceFrameRate: 24 }).code, 'fps-above-source')
  assert.equal(timeline.normalizeVideoOptions({ resolution: '4k' }, { sourceWidth: 1280, sourceHeight: 720 }).code, 'invalid-video-option')
  assert.equal(timeline.normalizeVideoOptions({ quality: 'best' }, { sourceWidth: 1280, sourceHeight: 720 }).code, 'invalid-video-option')
})

// ---------------------------------------------------------------------------
// 2. project-mode controller: draft CAS + export freeze/retry + recovery gate
// ---------------------------------------------------------------------------

function projectEdit(overrides = {}) {
  return {
    id: 'project-1',
    name: 'ScreenRecording_2026-11-03',
    mode: 'display',
    state: 'ready',
    createdAt: 0,
    updatedAt: 0,
    media: { durationMs: 4000, video: { width: 1280, height: 720 }, audio: { tracks: 0 } },
    edit: { revision: 3, keepRanges: [{ id: 'keep-1', startMs: 1000, endMs: 3000 }], format: 'gif', gif: { edge: 960, fps: 10 } },
    exports: [],
    recovery: { cleanStop: true, errorCode: '' },
    ...overrides
  }
}

function projectController(project, options = {}) {
  return trimController.createRecordTrimController({
    projectId: project.id,
    project,
    metadata: options.metadata || { durationMs: project.media.durationMs, video: project.media.video, audio: { tracks: 0 } },
    translate: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key),
    available: options.available === undefined ? true : options.available,
    log: options.log
  })
}

test('a project-addressed controller loads the persisted draft, saves it with revision CAS', async () => {
  const project = projectEdit()
  const controller = projectController(project)
  const state = controller.state()
  assert.equal(state.projectId, 'project-1')
  assert.equal(state.revision, 3)
  assert.deepEqual(state.range, { startMs: 1000, endMs: 3000 })
  assert.equal(state.format, 'gif')
  assert.equal(state.gif.maxEdgePx, 960)
  assert.equal(state.gif.fps, 10)
  assert.equal(state.canExport, true)

  // A user edit marks the draft dirty; playback does not.
  assert.equal(controller.setStart(2000), true)
  assert.equal(controller.state().draft.dirty, true)
  const edit = controller.buildDraftEdit()
  assert.deepEqual(edit, {
    revision: 3,
    keepRanges: [{ id: 'keep-1', startMs: 2000, endMs: 3000 }],
    format: 'gif',
    gif: { edge: 960, fps: 10 },
    style: { enabled: false, background: '#0f1115', padding: 0.08, radius: 12, shadow: true, ripples: false },
    zoomSegments: []
  })

  const saved = []
  const answer = await controller.saveDraft({
    save: async (payload) => {
      saved.push(payload)
      return { ok: true, revision: 4 }
    }
  })
  assert.equal(answer.ok, true)
  assert.equal(saved.length, 1)
  // The CAS precondition is the revision the UI last loaded, not a locally incremented one.
  assert.equal(saved[0].projectId, 'project-1')
  assert.equal(saved[0].expectedRevision, 3)
  assert.deepEqual(saved[0].edit, edit)
  assert.equal(controller.state().revision, 4)
  assert.equal(controller.state().draft.dirty, false)

  // Saving a clean state sends nothing.
  const again = await controller.saveDraft({ save: async () => { throw new Error('must not be called') } })
  assert.deepEqual(again, { ok: true, skipped: true, revision: 4 })
  // Reset restores the persisted shape: full range is stored as [] ("whole recording").
  controller.resetRange()
  assert.deepEqual(controller.buildDraftEdit().keepRanges, [])
})

test('a revision conflict is surfaced as state and reloading the project clears it', async () => {
  const controller = projectController(projectEdit())
  controller.setEnd(3500)
  let conflict = null
  const answer = await controller.saveDraft({
    save: async (payload) => {
      conflict = payload
      return { ok: false, code: 'revision-conflict', revision: 9 }
    }
  })
  assert.equal(answer.code, 'revision-conflict')
  assert.equal(controller.state().draft.conflict, true)
  assert.equal(controller.state().draft.dirty, true, 'the unsaved edit must stay dirty after a conflict')
  assert.equal(conflict.expectedRevision, 3)

  // The page reloads the fresh project and applies it; the conflict flag and dirty state clear.
  controller.applyProject(projectEdit({ edit: { revision: 9, keepRanges: [{ id: 'keep-1', startMs: 500, endMs: 2500 }], format: 'mp4', gif: { edge: 1280, fps: 15 } } }), {
    metadata: { durationMs: 4000, video: { width: 1280, height: 720 }, audio: { tracks: 0 } },
    available: true
  })
  assert.equal(controller.state().revision, 9)
  assert.deepEqual(controller.state().range, { startMs: 500, endMs: 2500 })
  assert.equal(controller.state().draft.conflict, false)
  assert.equal(controller.state().draft.dirty, false)
})

test('export freezes the controls, retries with a new request, and only success yields a receipt', async () => {
  const controller = projectController(projectEdit({ edit: { revision: 1, keepRanges: [], format: 'mp4', gif: { edge: 1280, fps: 15 } } }))
  const requests = []
  const accepted = await controller.startExport({
    submit: async ({ requestId, request }) => {
      requests.push({ requestId, request })
      return { status: 'accepted', task: { taskId: 'task-1', state: 'running' } }
    }
  })
  assert.equal(accepted.status, 'accepted')
  assert.equal(requests.length, 1)
  // R4 contract §4.1: a whole-recording selection OMITS segments and sends video options for
  // mp4/webm; only ids/ranges/options cross IPC, never a path or argv.
  assert.deepEqual(Object.keys(requests[0].request).sort(), ['format', 'video'])
  assert.deepEqual(requests[0].request.video, { resolution: 'source', quality: 'standard', fps: 'source' })
  assert.equal(requests[0].request.range, undefined)
  assert.equal(requests[0].request.segments, undefined)
  // Frozen: no range/format edits while the task runs.
  assert.equal(controller.setStart(500), false)
  assert.equal(controller.setFormat('gif'), false)
  assert.equal(controller.state().canCancel, true)

  // Progress push, publish point (cancel closes), then success with the feature-A receipt.
  controller.applyTask({ taskId: 'task-1', state: 'running', progress: 40 })
  controller.applyTask({ taskId: 'task-1', state: 'publishing', progress: 99 })
  assert.equal(controller.state().task.state, 'publishing')
  assert.equal(controller.state().canCancel, false)
  controller.applyTask({
    taskId: 'task-1',
    state: 'succeeded',
    progress: 100,
    receipt: { status: 'saved', resultId: 'result-7', fileName: 'clip.mp4', kind: 'mp4' }
  })
  assert.equal(controller.state().phase, 'succeeded')
  assert.deepEqual(controller.state().receipt, { status: 'saved', resultId: 'result-7', fileName: 'clip.mp4', kind: 'mp4' })
  assert.equal(controller.state().frozen, null)

  // Retry after failure is a NEW attempt (new requestId) with the controls as they now are.
  controller.prepareRetry()
  controller.setStart(1000)
  const retry = await controller.startExport({
    submit: async ({ requestId, request }) => {
      requests.push({ requestId, request })
      return { status: 'failed', code: 'encode-failed' }
    }
  })
  assert.equal(retry.status, 'failed')
  assert.equal(requests.length, 2)
  assert.notEqual(requests[1].requestId, requests[0].requestId)
  assert.deepEqual(requests[1].request.segments, [{ startMs: 1000, endMs: 4000 }])
})

test('a recoverable project disables export instead of offering a fake duration', async () => {
  const controller = trimController.createRecordTrimController({
    projectId: 'project-recover',
    metadata: { durationMs: 0, video: { width: 0, height: 0 }, audio: { tracks: 0 } },
    available: false,
    translate: (key) => key
  })
  assert.equal(controller.state().available, false)
  assert.equal(controller.state().durationMs, 0)
  assert.equal(controller.state().canExport, false)
  let submitted = 0
  const answer = await controller.startExport({ submit: async () => { submitted += 1; return { status: 'accepted', task: { taskId: 't', state: 'running' } } } })
  assert.equal(submitted, 0, 'a blocked controller must not submit an export')
  assert.equal(answer.status, 'failed')
  // A later successful reload (recovery retry) re-opens the gate without inventing data.
  controller.applyProject(projectEdit(), {
    metadata: { durationMs: 4000, video: { width: 1280, height: 720 }, audio: { tracks: 0 } },
    available: true
  })
  assert.equal(controller.state().canExport, true)
  assert.equal(controller.state().range.endMs, 3000)
})

test('a project controller edits a segment list with undo/redo, boundaries and an empty state', async () => {
  const project = projectEdit({
    edit: {
      revision: 2,
      keepRanges: [{ id: 'keep-1', startMs: 1000, endMs: 3000 }, { id: 'keep-2', startMs: 5000, endMs: 7000 }],
      format: 'mp4',
      gif: { edge: 1280, fps: 15 }
    }
  })
  const metadata = { durationMs: 10000, video: { width: 1280, height: 720, frameRate: 30 }, audio: { tracks: 1 } }
  const controller = projectController(project, { metadata })
  const initial = controller.state()
  assert.deepEqual(initial.segments, [{ startMs: 1000, endMs: 3000 }, { startMs: 5000, endMs: 7000 }])
  assert.equal(initial.keptMs, 4000)
  assert.equal(initial.edited, true)
  assert.equal(initial.undo, false)
  assert.deepEqual(initial.videoOptions.resolutions, ['source', '720p', '480p'])
  assert.deepEqual(initial.videoOptions.frameRates, ['source', '30'])
  // Split a kept segment, then undo/redo the edit.
  assert.equal(controller.splitAt(2000), true)
  assert.equal(controller.state().segments.length, 3)
  assert.equal(controller.state().undo, true)
  assert.equal(controller.undoEdit(), true)
  assert.equal(controller.state().segments.length, 2)
  assert.equal(controller.state().redo, true)
  assert.equal(controller.redoEdit(), true)
  assert.equal(controller.state().segments.length, 3)
  // Delete the segment under the playhead; an empty selection is explicit and unexportable.
  assert.equal(controller.deleteSegmentAt(5500), true)
  assert.equal(controller.state().segments.length, 2)
  assert.equal(controller.canDeleteAt(4000), false, 'a removed gap has no segment to delete')
  // Boundary drag grouped by beginEdit/commitEdit is ONE undo entry.
  const beforeDrag = controller.state().segments
  const dirtyBeforeDrag = controller.state().draft.dirty
  assert.equal(controller.beginEdit(), true)
  assert.equal(controller.moveBoundary(0, 'start', 500), true)
  assert.equal(controller.moveBoundary(0, 'start', 200), true)
  assert.equal(controller.state().draft.dirty, dirtyBeforeDrag, 'transient drag moves do not dirty the draft')
  assert.equal(controller.commitEdit(), true)
  assert.equal(controller.state().draft.dirty, true)
  assert.equal(controller.undoEdit(), true)
  assert.deepEqual(controller.state().segments, beforeDrag)
  // Deleting every segment leaves [] (no content) and closes the export gate.
  const single = projectController(projectEdit({ edit: { revision: 1, keepRanges: [], format: 'mp4', gif: { edge: 1280, fps: 15 } } }), { metadata })
  assert.deepEqual(single.state().segments, [{ startMs: 0, endMs: 10000 }])
  assert.equal(single.deleteSegmentAt(5000), true)
  assert.deepEqual(single.state().segments, [])
  assert.equal(single.state().emptySelection, true)
  assert.equal(single.state().canExport, false)
  let submitted = 0
  const answer = await single.startExport({ submit: async () => { submitted += 1; return { status: 'accepted', task: { taskId: 't', state: 'running' } } } })
  assert.equal(submitted, 0, 'an empty selection never reaches IPC')
  assert.equal(answer.code, 'empty-selection')
  assert.deepEqual(single.buildDraftEdit().keepRanges, [], 'the schema cannot persist an empty selection; the session still refuses to export')
})

function finishFakeExport(controller, taskId, fileName, kind) {
  controller.applyTask({ taskId, state: 'succeeded', progress: 100, receipt: { status: 'saved', resultId: 'result-' + kind, fileName, kind } })
  return controller.resetAfterExport()
}

test('a multi-segment export request follows R4 contract §4.1 (segments/video/gif shapes)', async () => {
  const project = projectEdit({
    edit: {
      revision: 2,
      keepRanges: [{ id: 'keep-1', startMs: 1000, endMs: 3000 }, { id: 'keep-2', startMs: 5000, endMs: 7000 }],
      format: 'mp4',
      gif: { edge: 1280, fps: 15 }
    }
  })
  const metadata = { durationMs: 10000, video: { width: 1920, height: 1080, frameRate: 60 }, audio: { tracks: 1 } }
  const controller = projectController(project, { metadata })
  const requests = []
  const submit = async ({ requestId, request }) => {
    requests.push({ requestId, request })
    return { status: 'accepted', task: { taskId: 'task-1', state: 'running' } }
  }
  // MP4 with explicit segments + video options the user picked in the panel.
  assert.equal(controller.setVideoResolution('720p'), true)
  assert.equal(controller.setVideoQuality('high'), true)
  assert.equal(controller.setVideoFps(60), true)
  await controller.startExport({ submit })
  const mp4 = requests[0].request
  assert.deepEqual(Object.keys(mp4).sort(), ['format', 'segments', 'video'])
  assert.deepEqual(mp4.segments, [{ startMs: 1000, endMs: 3000 }, { startMs: 5000, endMs: 7000 }])
  assert.deepEqual(mp4.video, { resolution: '720p', quality: 'high', fps: 60 })
  finishFakeExport(controller, 'task-1', 'clip.mp4', 'mp4')

  // WebM keeps the same video option shape (the copy fast-path is decided main-side).
  assert.equal(controller.setFormat('webm'), true)
  await controller.startExport({ submit })
  const webm = requests[1].request
  assert.equal(webm.format, 'webm')
  assert.deepEqual(Object.keys(webm).sort(), ['format', 'segments', 'video'])
  finishFakeExport(controller, 'task-1', 'clip.webm', 'webm')

  // GIF ignores "video" and uses the frozen {edge,fps} budget.
  assert.equal(controller.setFormat('gif'), true)
  assert.equal(controller.setGifMaxEdge(960), true)
  await controller.startExport({ submit })
  const gif = requests[2].request
  assert.deepEqual(Object.keys(gif).sort(), ['format', 'gif', 'segments'])
  assert.deepEqual(gif.gif, { edge: 960, fps: 15 })
  finishFakeExport(controller, 'task-1', 'clip.gif', 'gif')

  // Whole recording: segments are omitted (= full), and mp4/webm still carry video options.
  const whole = projectController(projectEdit({ edit: { revision: 1, keepRanges: [], format: 'mp4', gif: { edge: 1280, fps: 15 } } }), { metadata })
  const wholeRequests = []
  await whole.startExport({ submit: async ({ requestId, request }) => { wholeRequests.push(request); return { status: 'accepted', task: { taskId: 't2', state: 'running' } } } })
  assert.deepEqual(Object.keys(wholeRequests[0]).sort(), ['format', 'video'])
  assert.equal(wholeRequests[0].segments, undefined)
  assert.equal(whole.buildDraftEdit().keepRanges.length, 0)
})

// ---------------------------------------------------------------------------
// 3. editor view over a fake DOM
// ---------------------------------------------------------------------------

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase()
    this.id = ''
    this.hidden = false
    this.disabled = false
    this.value = ''
    this.textContent = ''
    this.title = ''
    this.src = ''
    this.currentTime = 0
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
    for (const handler of this.listeners.get(type) || []) handler({ type, target: this, ...event })
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

  get options() {
    return this.children
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value))
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null
  }

  getBoundingClientRect() {
    return this.rect
  }

  focus() {
    this.focused = true
  }

  select() {
    this.selected = true
  }

  load() {
    this.readyState = 1
  }

  play() {
    this.played = (this.played || 0) + 1
    return Promise.resolve()
  }

  pause() {
    this.paused = (this.paused || 0) + 1
  }
}

class FakeWindow {
  constructor() {
    this.listeners = new Map()
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
    for (const handler of [...(this.listeners.get(type) || [])]) handler(event)
  }
}

function installFakeDom() {
  const elements = new Map()
  for (const id of editorModule.ELEMENT_IDS) {
    const tag = id === 'preview-video'
      ? 'video'
      : (id.endsWith('-input')
        ? 'input'
        : (id === 'export-format' || id === 'gif-edge' || id === 'gif-fps' || id === 'export-resolution' || id === 'export-quality' || id === 'export-fps'
          ? 'select'
          : 'div'))
    const element = new FakeElement(tag)
    element.id = id
    elements.set(id, element)
  }
  // The timeline track is laid out from x=100 to x=900 so pointer math is deterministic.
  elements.get('timeline-track').rect = { left: 100, top: 20, right: 900, bottom: 32, width: 800, height: 12 }
  const body = new FakeElement('body')
  const documentRef = {
    body,
    documentElement: new FakeElement('html'),
    activeElement: null,
    getElementById: (id) => elements.get(id) || null,
    createElement: (tagName) => new FakeElement(tagName)
  }
  const windowRef = new FakeWindow()
  return { elements, document: documentRef, window: windowRef }
}

function initPayload(overrides = {}) {
  const project = overrides.project || projectEdit()
  const metadata = overrides.metadata || {
    durationMs: project.media.durationMs,
    video: project.media.video,
    audio: { tracks: project.media.audio.tracks }
  }
  return {
    project,
    sourceUrl: 'file:///recordings/project-1/capture.webm',
    metadata,
    recovery: overrides.recovery || { state: 'ready', errorCode: '' }
  }
}

function createFakeApi(options = {}) {
  const calls = { ready: 0, saveDraft: [], export: [], status: [], cancel: [], action: [], reload: [], rename: [], reveal: [], rerecord: [], back: [], window: [], events: [] }
  const initHandlers = []
  const progressHandlers = []
  const languageHandlers = []
  const api = {
    ready: () => { calls.ready += 1 },
    onInit: (callback) => { initHandlers.push(callback); return () => {} },
    onExportProgress: (callback) => { progressHandlers.push(callback); return () => {} },
    onInterfaceLanguage: (callback) => { languageHandlers.push(callback); return () => {} },
    saveDraft: async (projectId, expectedRevision, edit) => {
      calls.saveDraft.push({ projectId, expectedRevision, edit })
      if (options.saveDraft) return options.saveDraft({ projectId, expectedRevision, edit })
      return { ok: true, revision: expectedRevision + 1 }
    },
    exportProject: async (projectId, requestId, request) => {
      calls.export.push({ projectId, requestId, request })
      if (options.exportAnswer) return options.exportAnswer({ projectId, requestId, request })
      return { status: 'accepted', task: { taskId: 'task-1', state: 'running' } }
    },
    exportStatus: async (query) => {
      calls.status.push(query)
      if (options.statusAnswer) return options.statusAnswer(query)
      return { ok: true, task: { taskId: 'task-1', state: 'running', progress: 10 } }
    },
    cancelExport: async (query) => {
      calls.cancel.push(query)
      if (options.cancelAnswer) return options.cancelAnswer(query)
      return { ok: true, task: { taskId: 'task-1', state: 'cancelling' } }
    },
    exportAction: async (resultId, action) => {
      calls.action.push({ resultId, action })
      if (options.actionAnswer) return options.actionAnswer(resultId, action)
      return { status: 'done' }
    },
    reload: async (projectId) => {
      calls.reload.push(projectId)
      if (options.reloadAnswer) return options.reloadAnswer(projectId)
      return { ok: true, project: projectEdit(), metadata: { durationMs: 4000, video: { width: 1280, height: 720 }, audio: { tracks: 0 } }, recovery: { state: 'ready', errorCode: '' } }
    },
    renameProject: async (projectId, name) => {
      calls.rename.push({ projectId, name })
      return { ok: true, project: { ...projectEdit(), name } }
    },
    reveal: async (projectId) => { calls.reveal.push(projectId); return { ok: true } },
    rerecord: async (projectId) => { calls.rerecord.push(projectId); return { ok: true } },
    back: async () => { calls.back.push(true); return { ok: true } },
    windowAction: (action) => { calls.window.push(action) }
  }
  // record-editor:events (p2). `options.events === false` simulates a bridge that has not
  // landed yet; a function lets a test inject a custom channel.
  if (options.events !== false) {
    api.events = typeof options.events === 'function'
      ? options.events
      : async (projectId) => {
        calls.events.push(projectId)
        if (options.eventsAnswer) return options.eventsAnswer(projectId)
        return { ok: true, track: null }
      }
  }
  return {
    api,
    calls,
    emitInit: (data) => { for (const handler of initHandlers) handler(data) },
    emitProgress: (task) => { for (const handler of progressHandlers) handler(task) },
    emitLanguage: (language) => { for (const handler of languageHandlers) handler(language) }
  }
}

function bootView({ api = null, translate = (key) => key } = {}) {
  const harness = installFakeDom()
  const view = editorModule.createEditorView({ api, document: harness.document, window: harness.window, translate })
  view.boot()
  return { view, harness }
}

function exportRequestKeys(request) {
  return Object.keys(request || {}).sort()
}

test('the editor renders init data: kept blocks, duration statistic, export options and autosave status', (t) => {
  const fake = createFakeApi()
  // Params-aware translator so the rendered numbers are inspectable.
  const harness = installFakeDom()
  const view = editorModule.createEditorView({
    api: fake.api,
    document: harness.document,
    window: harness.window,
    translate: (key, params) => (params ? key + ':' + JSON.stringify(params) : key)
  })
  view.boot()
  t.after(() => view.destroy())
  assert.equal(fake.calls.ready, 1, 'the window announces ready once')
  assert.equal(view.applyInit(initPayload()), true)

  const elements = harness.elements
  assert.equal(elements.get('source-name').textContent, 'ScreenRecording_2026-11-03')
  assert.match(elements.get('timeline-duration').textContent, /^recording.editor.timeline.duration:/)
  assert.match(elements.get('range-selection').textContent, /^recording.editor.timeline.kept:/)
  assert.match(elements.get('range-selection').textContent, /"kept":"00:02.0"/)
  assert.equal(elements.get('range-start-input').value, '00:01.0')
  assert.equal(elements.get('range-end-input').value, '00:03.0')
  // The persisted edit is a multi-capable segment list; the one saved range renders as one
  // kept block plus the two outer handles.
  assert.equal(elements.get('timeline-segments').children.filter((node) => node.className === 'timeline-segment').length, 1)
  assert.match(elements.get('handle-start').style.left, /^25/)
  assert.match(elements.get('handle-end').style.left, /^75/)
  // The controller's persisted format/GIF cap drive the panel.
  assert.equal(elements.get('export-format').value, 'gif')
  assert.equal(elements.get('gif-edge').value, '960')
  assert.equal(elements.get('gif-fps').value, '10')
  assert.match(elements.get('gif-budget').textContent, /recording.editor.gif-frames/)
  assert.match(elements.get('export-output-size').textContent, /^recording.editor.output-value:/)
  assert.ok(elements.get('export-output-size').textContent.includes('"size":"960 × 540"'))
  assert.equal(elements.get('export-button').disabled, false)
  assert.equal(elements.get('cancel-export').hidden, true)
  assert.equal(elements.get('recovery-banner').hidden, true)
  assert.equal(elements.get('empty-selection-hint').hidden, true)
  assert.equal(elements.get('result-bar').hidden, true)
  assert.equal(elements.get('save-state').dataset.state, 'saved')
  // The preview source is the file URL the main process derived; no path is fabricated here.
  assert.equal(elements.get('preview-video').src, 'file:///recordings/project-1/capture.webm')
})

test('boot translates the static markup through the shared i18n pipeline before it announces ready', (t) => {
  // Regression for a real E2E screenshot: editor.js rendered its dynamic labels through t()
  // but never applied i18n to the static data-i18n markup, so the first paint mixed Chinese
  // dynamic text with the English HTML fallbacks ("Export settings", "Start time", ...).
  // This proves the behaviour, not a source string: boot must call the runtime exactly once
  // and must do it BEFORE the window tells main it is ready.
  const calls = []
  const harness = installFakeDom()
  const fake = createFakeApi()
  const priorRestore = globalThis.restoreStoredLanguage
  const priorApply = globalThis.applyTranslations
  const priorReady = fake.api.ready
  fake.api.ready = () => {
    calls.push('ready')
    priorReady()
  }
  globalThis.restoreStoredLanguage = () => calls.push('restore-language')
  globalThis.applyTranslations = (documentArgument) => {
    calls.push('apply-translations')
    assert.equal(documentArgument, harness.document)
  }
  t.after(() => {
    globalThis.restoreStoredLanguage = priorRestore
    globalThis.applyTranslations = priorApply
  })
  const view = editorModule.createEditorView({
    api: fake.api,
    document: harness.document,
    window: harness.window,
    translate: (key) => key
  })
  t.after(() => view.destroy())
  view.boot()
  assert.deepEqual(
    calls,
    ['restore-language', 'apply-translations', 'ready'],
    'static copy is translated before the render/ready handshake'
  )
  // A language broadcast applies the same pipeline again to the static markup, then re-renders
  // the dynamic labels; the two halves cannot drift apart.
  fake.emitLanguage('en-US')
  assert.deepEqual(calls.slice(3), ['apply-translations'])
})

test('handle drag and keyboard edits the range; clicking the track only moves the playhead', (t) => {
  const fake = createFakeApi()
  const { view, harness } = bootView({ api: fake.api })
  t.after(() => view.destroy())
  view.applyInit(initPayload())
  const controller = view.getController()
  assert.deepEqual(controller.state().range, { startMs: 1000, endMs: 3000 })

  // Drag the start handle to 25% of the track: the end handle must NOT follow.
  const startHandle = harness.elements.get('handle-start')
  startHandle.dispatch('pointerdown', { button: 0, pointerId: 1, preventDefault() {}, stopPropagation() {} })
  harness.window.dispatch('pointermove', { clientX: 300 })
  assert.deepEqual(controller.state().range, { startMs: 1000, endMs: 3000 }, 'the first move keeps the end handle')
  harness.window.dispatch('pointermove', { clientX: 700 })
  harness.window.dispatch('pointerup', {})
  // The start handle landed at 3000 ms but was clamped against the end handle to keep the
  // exporter's minimum span: the end handle never follows a start drag.
  assert.deepEqual(controller.state().range, { startMs: 2900, endMs: 3000 })
  assert.equal(controller.state().draft.dirty, true)

  // Keyboard nudge on the end handle then clamps inside the media duration.
  const endHandle = harness.elements.get('handle-end')
  endHandle.dispatch('keydown', { key: 'End', preventDefault() {} })
  assert.deepEqual(controller.state().range, { startMs: 2900, endMs: 4000 })
  endHandle.dispatch('keydown', { key: 'ArrowLeft', preventDefault() {} })
  assert.deepEqual(controller.state().range, { startMs: 2900, endMs: 3900 })

  // A track click moves the playhead to 2 s and leaves the trim points alone.
  harness.elements.get('timeline-track').dispatch('pointerdown', { clientX: 500, preventDefault() {} })
  assert.equal(harness.elements.get('preview-video').currentTime, 2)
  assert.deepEqual(controller.state().range, { startMs: 2900, endMs: 3900 })
  assert.match(harness.elements.get('timeline-playhead').style.left, /^50/)
  // Dragging on the track moves the playhead (75% here) and still leaves the segments alone.
  harness.elements.get('timeline-track').dispatch('pointerdown', { clientX: 500, preventDefault() {} })
  harness.window.dispatch('pointermove', { clientX: 700 })
  harness.window.dispatch('pointerup', {})
  assert.equal(harness.elements.get('preview-video').currentTime, 3)
  assert.deepEqual(controller.state().range, { startMs: 2900, endMs: 3900 })
  assert.match(harness.elements.get('timeline-playhead').style.left, /^75/)
})

test('export submits one frozen project request, shows progress, and only a receipt fills the result bar', async (t) => {
  const fake = createFakeApi()
  const { view, harness } = bootView({ api: fake.api })
  t.after(() => view.destroy())
  // MP4 project: the request must carry the format/range only (a GIF request adds its budget,
  // still never a path or argv).
  view.applyInit(initPayload({ project: projectEdit({ edit: { revision: 1, keepRanges: [], format: 'mp4', gif: { edge: 1280, fps: 15 } } }) }))
  const elements = harness.elements

  elements.get('export-button').dispatch('click')
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(fake.calls.export.length, 1)
  assert.equal(fake.calls.export[0].projectId, 'project-1')
  assert.equal(fake.calls.export[0].requestId.length > 0, true)
  // Only the frozen request shape crosses IPC: no path, no argv.
  assert.deepEqual(exportRequestKeys(fake.calls.export[0].request), ['format', 'video'])
  assert.equal(elements.get('result-bar').hidden, true, 'no result bar before a receipt')

  // Progress arrives; before publish nothing claims 100%.
  view.handleTask({ taskId: 'task-1', state: 'running', progress: 42 })
  assert.equal(elements.get('export-progress').hidden, false)
  assert.equal(elements.get('export-progress-bar').style.width, '42%')
  assert.equal(elements.get('cancel-export').hidden, false)
  assert.equal(elements.get('export-button').textContent, 'recording.editor.exporting')

  // Publishing: the button says finishing and the cancel path closes.
  view.handleTask({ taskId: 'task-1', state: 'publishing', progress: 99 })
  assert.equal(elements.get('export-button').textContent, 'recording.editor.finishing')
  assert.equal(elements.get('cancel-export').hidden, true)

  // Succeeded: exactly the feature-A receipt appears, addressed by resultId.
  view.handleTask({
    taskId: 'task-1',
    state: 'succeeded',
    progress: 100,
    receipt: { status: 'saved', resultId: 'result-7', fileName: 'clip.mp4', kind: 'mp4' }
  })
  assert.equal(elements.get('result-bar').hidden, false)
  assert.deepEqual(view.getReceipt(), { status: 'saved', resultId: 'result-7', fileName: 'clip.mp4', kind: 'mp4' })
  await view.runResultAction('copy-path')
  assert.deepEqual(fake.calls.action.at(-1), { resultId: 'result-7', action: 'copy-path' })
  assert.match(elements.get('result-status').textContent, /capture\.export-result\.copied/)
})

test('a cancelled or failed export never shows a result bar', async (t) => {
  const cancelled = bootView({ api: createFakeApi({ exportAnswer: () => ({ status: 'cancelled' }) }).api })
  t.after(() => cancelled.view.destroy())
  cancelled.view.applyInit(initPayload())
  await cancelled.view.exportSelection()
  assert.equal(cancelled.view.getReceipt(), null)
  assert.equal(cancelled.harness.elements.get('result-bar').hidden, true)
  assert.equal(cancelled.view.getController().state().phase, 'idle', 'dismissing the save dialog is not a failure')

  const failedFake = createFakeApi({ exportAnswer: () => ({ status: 'failed', code: 'encode-failed' }) })
  const failed = bootView({ api: failedFake.api })
  t.after(() => failed.view.destroy())
  failed.view.applyInit(initPayload())
  await failed.view.exportSelection()
  assert.equal(failed.view.getReceipt(), null)
  assert.equal(failed.harness.elements.get('result-bar').hidden, true)
  assert.equal(failed.view.getController().state().phase, 'failed')
})

test('a running export can be cancelled from either visible control', async (t) => {
  const fake = createFakeApi()
  const { view, harness } = bootView({ api: fake.api })
  t.after(() => view.destroy())
  view.applyInit(initPayload())
  await view.exportSelection()
  const state = view.getController().state()
  assert.equal(state.busy, true)
  assert.equal(state.canCancel, true)
  assert.equal(state.canExport, false)
  // The secondary cancel button is a real, enabled control while the task runs.
  const cancelButton = harness.elements.get('cancel-export')
  assert.equal(cancelButton.hidden, false)
  assert.equal(cancelButton.disabled, false)
  cancelButton.dispatch('click')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(fake.calls.cancel.length, 1)
  assert.equal(fake.calls.cancel[0].taskId, 'task-1')
  // …and the single Export button doubles as cancel too, as the old preview view established.
  const exportButton = harness.elements.get('export-button')
  assert.equal(exportButton.disabled, false)
  assert.equal(exportButton.dataset.action, 'cancel')
})

test('draft autosave is debounced, uses the loaded revision, and a conflict reloads the project', async (t) => {
  let conflictProject = projectEdit({ edit: { revision: 8, keepRanges: [{ id: 'keep-1', startMs: 500, endMs: 2000 }], format: 'mp4', gif: { edge: 1280, fps: 15 } } })
  const fake = createFakeApi({
    saveDraft: ({ expectedRevision }) => {
      if (expectedRevision === 4) return { ok: false, code: 'revision-conflict', revision: 8, project: conflictProject }
      return { ok: true, revision: expectedRevision + 1 }
    },
    reloadAnswer: () => ({
      ok: true,
      project: conflictProject,
      metadata: { durationMs: 4000, video: { width: 1280, height: 720 }, audio: { tracks: 0 } },
      recovery: { state: 'ready', errorCode: '' }
    })
  })
  const { view, harness } = bootView({ api: fake.api })
  t.after(() => view.destroy())
  view.applyInit(initPayload())
  const controller = view.getController()

  // One edit schedules a debounced save; it is not sent synchronously.
  controller.setStart(2000)
  assert.equal(harness.elements.get('save-state').dataset.state, 'unsaved')
  assert.equal(fake.calls.saveDraft.length, 0)
  await new Promise((resolve) => setTimeout(resolve, editorModule.SAVE_DEBOUNCE_MS + 80))
  assert.equal(fake.calls.saveDraft.length, 1)
  const firstSave = fake.calls.saveDraft[0]
  assert.equal(firstSave.projectId, 'project-1')
  assert.equal(firstSave.expectedRevision, 3)
  assert.deepEqual(firstSave.edit.keepRanges, [{ id: 'keep-1', startMs: 2000, endMs: 3000 }])
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(harness.elements.get('save-state').dataset.state, 'saved')
  assert.equal(controller.state().revision, 4)

  // Next save conflicts: the view reloads the fresh project (via record-editor:reload) and
  // tells the user instead of overwriting the other window's draft.
  controller.setEnd(3900)
  await view.saveNow()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(fake.calls.saveDraft.length, 2)
  assert.equal(fake.calls.saveDraft[1].expectedRevision, 4)
  assert.equal(fake.calls.reload.length, 1)
  assert.equal(controller.state().revision, 8)
  assert.deepEqual(controller.state().range, { startMs: 500, endMs: 2000 })
  assert.equal(view.isDraftConflictVisible(), true)
  assert.equal(harness.elements.get('save-state').dataset.state, 'saved')
})

test('recovery mode shows the explanation, hides a fake duration, disables export, and retry reloads the source', async (t) => {
  const fake = createFakeApi({
    reloadAnswer: () => ({
      ok: true,
      project: projectEdit(),
      metadata: { durationMs: 4000, video: { width: 1280, height: 720 }, audio: { tracks: 0 } },
      recovery: { state: 'ready', errorCode: '' }
    })
  })
  const { view, harness } = bootView({ api: fake.api })
  t.after(() => view.destroy())
  view.applyInit(initPayload({
    metadata: { durationMs: 0, video: { width: 0, height: 0 }, audio: { tracks: 0 } },
    recovery: { state: 'recoverable', errorCode: 'probe-failed' }
  }))
  const elements = harness.elements
  assert.equal(view.isRecoveryVisible(), true)
  // No fake duration is rendered where the length is unknown, and export is disabled.
  assert.equal(elements.get('timeline-duration').textContent, '')
  assert.equal(elements.get('export-button').disabled, true)
  assert.equal(elements.get('export-format').disabled, true)
  assert.match(elements.get('recovery-message').textContent, /recording\.editor\.recovery\.probe-failed/)
  elements.get('export-button').dispatch('click')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(fake.calls.export.length, 0, 'a recoverable project must not submit an export')
  // Retry asks main to re-probe the source (record-editor:reload) and unblocks the window.
  elements.get('recovery-retry').dispatch('click')
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(fake.calls.reload.length, 1)
  assert.equal(view.isRecoveryVisible(), false)
  assert.equal(elements.get('timeline-duration').textContent, 'recording.editor.timeline.duration')
  assert.equal(elements.get('export-button').disabled, false)
  // The banner's reveal action addresses the project, never a renderer-supplied path.
  await view.revealSource()
  assert.deepEqual(fake.calls.reveal, ['project-1'])
})

test('without the preload bridge the window degrades visibly instead of crashing', (t) => {
  const { view, harness } = bootView({ api: null })
  t.after(() => view.destroy())
  assert.equal(view.getFatalCode(), 'recording.editor.error.bridge-missing')
  assert.match(harness.elements.get('error-text').textContent, /recording\.editor\.error\.bridge-missing/)
  assert.equal(harness.elements.get('export-button').disabled, true)
  assert.equal(harness.elements.get('handle-start').disabled, true)
  // Actions still dispatch but report the missing bridge rather than throwing.
  harness.elements.get('export-button').dispatch('click')
  assert.equal(view.getController(), null)
})

test('the editor renders kept blocks and wires split/delete/undo/redo/reset over the fake DOM', (t) => {
  const fake = createFakeApi()
  const { view, harness } = bootView({ api: fake.api })
  t.after(() => view.destroy())
  view.applyInit(initPayload({
    project: projectEdit({ edit: { revision: 1, keepRanges: [], format: 'mp4', gif: { edge: 1280, fps: 15 } } }),
    metadata: { durationMs: 4000, video: { width: 1280, height: 720, frameRate: 30 }, audio: { tracks: 0 } }
  }))
  const elements = harness.elements
  const blocks = () => elements.get('timeline-segments').children.filter((node) => node.className === 'timeline-segment')

  assert.equal(blocks().length, 1, 'a whole-recording edit renders one kept block')
  assert.equal(elements.get('timeline-segments').children.filter((node) => node.className === 'timeline-boundary').length, 0)
  // Split at the playhead (2 s) -> two kept blocks joined by one junction grip.
  elements.get('preview-video').currentTime = 2
  elements.get('split-at-playhead').dispatch('click')
  assert.equal(blocks().length, 2)
  assert.equal(elements.get('timeline-segments').children.filter((node) => node.className === 'timeline-boundary').length, 1)
  assert.equal(elements.get('split-at-playhead').disabled, true, 'a boundary is not splittable')
  // Delete the segment under the playhead -> one block remains.
  elements.get('preview-video').currentTime = 2.5
  elements.get('delete-segment').dispatch('click')
  assert.equal(blocks().length, 1)
  assert.deepEqual(view.getController().state().segments, [{ startMs: 0, endMs: 2000 }])
  // Undo / redo the delete.
  elements.get('undo-edit').dispatch('click')
  assert.equal(blocks().length, 2)
  elements.get('redo-edit').dispatch('click')
  assert.equal(blocks().length, 1)
  // Restore the full range.
  elements.get('reset-edits').dispatch('click')
  assert.equal(blocks().length, 1)
  assert.deepEqual(view.getController().state().segments, [{ startMs: 0, endMs: 4000 }])
  assert.equal(view.getController().state().edited, false)
  // The kept statistic reports kept vs source length.
  assert.match(elements.get('range-selection').textContent, /recording\.editor\.timeline\.kept/)
})

test('Ctrl+Z / Ctrl+Y undo and redo edits, but never while a text field is focused', (t) => {
  const fake = createFakeApi()
  const { view, harness } = bootView({ api: fake.api })
  t.after(() => view.destroy())
  view.applyInit(initPayload({
    project: projectEdit({ edit: { revision: 1, keepRanges: [], format: 'mp4', gif: { edge: 1280, fps: 15 } } }),
    metadata: { durationMs: 4000, video: { width: 1280, height: 720, frameRate: 30 }, audio: { tracks: 0 } }
  }))
  const controller = view.getController()
  const blocks = () => harness.elements.get('timeline-segments').children.filter((node) => node.className === 'timeline-segment')
  controller.splitAt(2000)
  view.render()
  assert.equal(blocks().length, 2)
  harness.window.dispatch('keydown', { key: 'z', ctrlKey: true })
  assert.equal(controller.state().segments.length, 1, 'Ctrl+Z undoes the split')
  harness.window.dispatch('keydown', { key: 'y', ctrlKey: true })
  assert.equal(controller.state().segments.length, 2, 'Ctrl+Y redoes it')
  // While typing (input focused) the shortcut belongs to the field, not the timeline.
  harness.document.activeElement = harness.elements.get('range-start-input')
  const before = controller.state().segments.length
  harness.window.dispatch('keydown', { key: 'z', ctrlKey: true, target: harness.elements.get('range-start-input') })
  assert.equal(controller.state().segments.length, before, 'typing undo is not intercepted')
  harness.document.activeElement = null
})

test('kept playback skips removed gaps and pauses at the last kept end', (t) => {
  const fake = createFakeApi()
  const { view } = bootView({ api: fake.api })
  t.after(() => view.destroy())
  view.applyInit(initPayload({
    project: projectEdit({
      edit: {
        revision: 1,
        keepRanges: [{ id: 'keep-1', startMs: 0, endMs: 2000 }, { id: 'keep-2', startMs: 3000, endMs: 4000 }],
        format: 'mp4',
        gif: { edge: 1280, fps: 15 }
      }
    }),
    metadata: { durationMs: 4000, video: { width: 1280, height: 720, frameRate: 30 }, audio: { tracks: 0 } }
  }))
  const controller = view.getController()
  // Starting inside the removed gap jumps forward to the next kept start.
  const started = controller.startKeptPlayback(2500)
  assert.deepEqual({ startMs: started.startMs, endMs: started.endMs }, { startMs: 3000, endMs: 4000 })
  assert.equal(controller.reportTime(3500).action, 'none')
  // A clock that lands in the gap asks the video element to seek over it.
  assert.deepEqual(controller.reportTime(2500), { action: 'seek', toMs: 3000 })
  // The last kept end pauses playback there (never on deleted tail content).
  assert.deepEqual(controller.reportTime(4000), { action: 'pause', toMs: 4000 })
  assert.equal(controller.state().playing, null)
  // Unplayable when everything is deleted.
  // A playhead after the last kept end has nothing to play.
  assert.equal(controller.startKeptPlayback(5000), null)
  controller.deleteSegmentAt(100)
  controller.deleteSegmentAt(3500)
  assert.equal(controller.state().segments.length, 0)
  assert.equal(controller.startKeptPlayback(0), null)
})

test('the R4 export panel hides unsupported resolutions/frame rates and shows the shared output size', (t) => {
  const fake = createFakeApi()
  const harness = installFakeDom()
  const view = editorModule.createEditorView({
    api: fake.api,
    document: harness.document,
    window: harness.window,
    translate: (key, params) => (params ? key + ':' + JSON.stringify(params) : key)
  })
  view.boot()
  t.after(() => view.destroy())
  view.applyInit(initPayload({
    project: projectEdit({ edit: { revision: 1, keepRanges: [], format: 'mp4', gif: { edge: 1280, fps: 15 } } }),
    metadata: { durationMs: 4000, video: { width: 1280, height: 720, frameRate: 30 }, audio: { tracks: 0 } }
  }))
  const elements = harness.elements
  const optionValues = (id) => elements.get(id).children.map((option) => option.value)
  // 1280x720 source: 1080p (cap 1920) would upscale, so it is not offered; 30 fps source
  // offers exactly source + 30 (never 60).
  assert.deepEqual(optionValues('export-resolution'), ['source', '720p', '480p'])
  assert.deepEqual(optionValues('export-quality'), ['standard', 'high', 'ultra'])
  assert.deepEqual(optionValues('export-fps'), ['source', '30'])
  assert.ok(elements.get('export-output-size').textContent.includes('"size":"1280 × 720"'))
  // Choosing 480p updates the same shared computation to the capped size (and kept duration).
  elements.get('export-resolution').value = '480p'
  elements.get('export-resolution').dispatch('change')
  assert.equal(view.getController().state().video.resolution, '480p')
  assert.ok(elements.get('export-output-size').textContent.includes('"size":"854 × 480"'))
  assert.ok(elements.get('export-output-size').textContent.includes('"duration":"00:04.0"'))
  // Switching to GIF hides the video rows and shows the GIF budget; WebM keeps video options.
  elements.get('export-format').value = 'webm'
  elements.get('export-format').dispatch('change')
  assert.equal(view.getController().state().format, 'webm')
  assert.equal(harness.document.body.dataset.format, 'webm')
  elements.get('export-format').value = 'gif'
  elements.get('export-format').dispatch('change')
  assert.equal(harness.document.body.dataset.format, 'gif')
  // The demo engine renders mp4/webm only; GIF disables the presentation panel instead of
  // silently dropping the settings.
  assert.equal(elements.get('demo-enabled').disabled, true)
  assert.equal(elements.get('demo-padding').disabled, true)
  assert.equal(elements.get('zoom-add').disabled, true)
  assert.equal(elements.get('export-resolution').disabled, true)
  assert.ok(elements.get('export-output-size').textContent.includes('"size":"1280 × 720"'))
})

test('deleting every segment disables export and shows the empty-selection hint', (t) => {
  const fake = createFakeApi()
  const { view, harness } = bootView({ api: fake.api })
  t.after(() => view.destroy())
  view.applyInit(initPayload({
    project: projectEdit({ edit: { revision: 1, keepRanges: [], format: 'mp4', gif: { edge: 1280, fps: 15 } } }),
    metadata: { durationMs: 4000, video: { width: 1280, height: 720, frameRate: 30 }, audio: { tracks: 0 } }
  }))
  const elements = harness.elements
  elements.get('preview-video').currentTime = 1
  elements.get('delete-segment').dispatch('click')
  assert.equal(view.getController().state().segments.length, 0)
  assert.equal(elements.get('empty-selection-hint').hidden, false)
  assert.equal(elements.get('export-button').disabled, true)
  assert.equal(elements.get('play-range').disabled, true)
  // Clicking Export must not reach IPC with an empty selection.
  elements.get('export-button').dispatch('click')
  assert.equal(fake.calls.export.length, 0)
  assert.match(elements.get('error-text').textContent, /recording\.editor\.(timeline\.empty|error\.)/)
})

function demoProject(overrides = {}) {
  return projectEdit({
    edit: {
      revision: 2,
      keepRanges: [],
      format: 'mp4',
      gif: { edge: 1280, fps: 15 },
      ...overrides
    }
  })
}

function demoMetadata(overrides = {}) {
  return {
    durationMs: 4000,
    video: { width: 1280, height: 720, frameRate: 30 },
    audio: { tracks: 0 },
    ...overrides
  }
}

async function settleEvents() {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

test('the controller normalises demo style and round-trips source-time zooms through the draft', async () => {
  const controller = projectController(demoProject({
    style: { enabled: true, background: '#ABCDEF', padding: 0.3, radius: 99, shadow: false, ripples: false },
    zoomSegments: [{ id: 'z1', startMs: 500, endMs: 1700, scale: 5, focusX: 1.4, focusY: -0.2, easing: 'bogus' }]
  }), { metadata: demoMetadata() })
  const state = controller.state()
  assert.deepEqual(state.demo.style, {
    enabled: true,
    background: '#abcdef',
    padding: 0.2,
    radius: 24,
    shadow: false,
    ripples: false
  })
  assert.equal(state.demo.zooms.length, 1)
  assert.deepEqual(
    { id: state.demo.zooms[0].id, scale: state.demo.zooms[0].scale, focusX: state.demo.zooms[0].focusX, focusY: state.demo.zooms[0].focusY, easing: state.demo.zooms[0].easing },
    { id: 'z1', scale: 3, focusX: 1, focusY: 0, easing: 'ease-in-out' }
  )
  // Draft persists edit.style + source-time edit.zoomSegments (R5 contract §4.1).
  const draft = controller.buildDraftEdit()
  assert.equal(draft.style.enabled, true)
  assert.equal(draft.style.padding, 0.2)
  assert.deepEqual(draft.zoomSegments[0], state.demo.zooms[0])

  // Style setters go through the shared normaliser and mark the draft dirty.
  assert.equal(controller.setDemoPaddingPercent(5), true)
  assert.equal(controller.state().demo.style.padding, 0.05)
  assert.equal(controller.setDemoRadius(18), true)
  assert.equal(controller.state().demo.style.radius, 18)
  assert.equal(controller.setDemoRadius(40), true)
  assert.equal(controller.state().demo.style.radius, 24)
  assert.equal(controller.setDemoBackground('#123456'), true)
  assert.equal(controller.state().demo.style.background, '#123456')
  assert.equal(controller.setDemoShadow(true), true)
  assert.equal(controller.state().draft.dirty, true)
  // Reset returns every demo parameter to the defaults.
  assert.equal(controller.resetDemo(), true)
  assert.deepEqual(controller.state().demo.style, {
    enabled: false,
    background: '#0f1115',
    padding: 0.08,
    radius: 12,
    shadow: true,
    ripples: false
  })
  assert.deepEqual(controller.state().demo.zooms, [])
})

test('zoom add/scale/focus/delete obey the media bounds and the 8-segment limit', () => {
  const controller = projectController(demoProject(), { metadata: demoMetadata({ durationMs: 20000 }) })
  // Adding near the media end clamps the segment inside the recording (>= 1.2 s).
  assert.equal(controller.addZoomAt(19900), true)
  const nearEnd = controller.state().demo.zooms[0]
  assert.ok(nearEnd.endMs <= 20000)
  assert.ok(nearEnd.startMs >= 20000 - 1200)
  assert.ok(nearEnd.endMs - nearEnd.startMs >= 1200)
  assert.equal(nearEnd.scale, 2)
  assert.deepEqual([nearEnd.focusX, nearEnd.focusY], [0.5, 0.5])
  controller.deleteZoom(0)
  // Fill the stack, then refuse the ninth segment.
  for (let index = 0; index < 8; index += 1) {
    assert.equal(controller.addZoomAt(index * 1200), true, 'zoom ' + index)
  }
  assert.equal(controller.state().demo.zooms.length, 8)
  assert.equal(controller.state().demo.canAddZoom, false)
  assert.equal(controller.addZoomAt(0), false)
  // Scale and focus clamp to the contract limits.
  assert.equal(controller.updateZoomScale(0, 9), true)
  assert.equal(controller.state().demo.zooms[0].scale, 3)
  assert.equal(controller.updateZoomFocus(0, 0.25, 0.75), true)
  assert.deepEqual([controller.state().demo.zooms[0].focusX, controller.state().demo.zooms[0].focusY], [0.25, 0.75])
  assert.equal(controller.deleteZoom(0), true)
  assert.equal(controller.state().demo.zooms.length, 7)
  assert.equal(controller.deleteZoom(99), false)
})

test('preview zoom maps source time to output time and never renders over deleted content', () => {
  const controller = projectController(projectEdit({
    edit: {
      revision: 2,
      keepRanges: [{ id: 'keep-1', startMs: 0, endMs: 2000 }, { id: 'keep-2', startMs: 3000, endMs: 4000 }],
      format: 'mp4',
      gif: { edge: 1280, fps: 15 },
      style: { enabled: false },
      zoomSegments: [{ id: 'z1', startMs: 800, endMs: 1800, scale: 2, focusX: 0.4, focusY: 0.6, easing: 'linear' }]
    }
  }), { metadata: demoMetadata() })
  // The source zoom lives inside the first kept piece [0,2000] -> output [800,1800].
  const mapped = controller.mappedZoomsOutput()
  assert.deepEqual(mapped.map((zoom) => ({ startMs: zoom.startMs, endMs: zoom.endMs })), [{ startMs: 800, endMs: 1800 }])
  // Ramp-in means a partial scale just after the zoom starts; a deleted position renders 1x.
  const inside = controller.previewZoomAt(900)
  assert.ok(inside.scale > 1 && inside.scale < 2)
  assert.deepEqual([inside.focusX, inside.focusY], [0.4, 0.6])
  const deletedGap = controller.previewZoomAt(2000)
  assert.equal(deletedGap.scale, 1)
  assert.equal(controller.outputTimeFor(2000), null)
  assert.equal(controller.outputTimeFor(3500), 2500)
})

test('an event track enables ripples and deterministic zoom suggestions, and degrades visibly without one', async (t) => {
  const track = {
    schemaVersion: 1,
    durationMs: 4000,
    sampledAtHz: 20,
    pointer: [
      { tMs: 0, x: 0.5, y: 0.5 },
      { tMs: 500, x: 0.5, y: 0.5 },
      { tMs: 1400, x: 0.5, y: 0.5 },
      { tMs: 2000, x: 0.5, y: 0.5 }
    ],
    clicks: [
      { tMs: 1000, x: 0.5, y: 0.5, button: 0 },
      { tMs: 1500, x: 0.52, y: 0.5, button: 0 }
    ],
    truncated: false
  }
  const fake = createFakeApi({ eventsAnswer: () => ({ ok: true, track }) })
  const { view, harness } = bootView({ api: fake.api })
  view.applyInit(initPayload({
    project: demoProject({ style: { enabled: true } }),
    metadata: demoMetadata()
  }))
  await settleEvents()
  const controller = view.getController()
  assert.equal(fake.calls.events.length, 1)
  assert.equal(fake.calls.events[0], 'project-1')
  assert.equal(controller.state().demo.events.clickCount, 2)
  assert.equal(controller.state().demo.canAddZoom, true)
  assert.ok(controller.state().demo.suggestions.length >= 1, 'clicks/dwell produce suggestions')
  assert.equal(harness.elements.get('demo-ripples').disabled, false)
  assert.match(harness.elements.get('events-status').textContent, /recording\.editor\.events-status\.track/)
  // The suggestion list is rendered with add/ignore controls; adding creates a zoom.
  const suggestions = harness.elements.get('zoom-suggestions').children
  assert.ok(suggestions.length >= 1)
  const addButton = suggestions[0].children[0].children[1].children[0]
  const before = controller.state().demo.zooms.length
  addButton.dispatch('click')
  assert.equal(controller.state().demo.zooms.length, before + 1)
  // Ripples can only be switched on with a click track.
  assert.equal(controller.setDemoRipples(true), true)
  assert.equal(controller.state().demo.style.ripples, true)

  // Degradation: no bridge method at all -> visible warning, ripples disabled, manual zooms.
  const missing = createFakeApi({ events: false })
  const degraded = bootView({ api: missing.api })
  degraded.view.applyInit(initPayload({ project: demoProject(), metadata: demoMetadata() }))
  await settleEvents()
  assert.match(degraded.harness.elements.get('events-status').textContent, /recording\.editor\.events-status\.degraded/)
  assert.equal(degraded.harness.elements.get('demo-ripples').disabled, true)
  assert.equal(degraded.view.getController().state().demo.events.available, false)
  assert.equal(degraded.view.getController().addZoomAt(1000), true, 'manual zoom works without events')
})

test('the export request carries source-time demo data only when active, for mp4/webm only', async () => {
  const controller = projectController(demoProject({
    style: { enabled: true, background: '#1e1e1e', padding: 0.1, radius: 10, shadow: true, ripples: false },
    zoomSegments: [{ id: 'z1', startMs: 1000, endMs: 2400, scale: 2, focusX: 0.4, focusY: 0.6, easing: 'ease-in-out' }]
  }), { metadata: demoMetadata() })
  controller.applyEventTrack({
    durationMs: 4000,
    sampledAtHz: 20,
    pointer: [],
    clicks: [{ tMs: 1200, x: 0.51, y: 0.33, button: 0 }, { tMs: 2600, x: 0.2, y: 0.2, button: 0 }],
    truncated: false
  })
  assert.equal(controller.setDemoRipples(true), true)
  const requests = []
  await controller.startExport({ submit: async ({ request, requestId }) => { requests.push(request); return { status: 'accepted', task: { taskId: 't1', state: 'running' } } } })
  const demo = requests[0].demo
  assert.ok(demo, 'demo payload present')
  assert.equal(demo.style.ripples, true)
  assert.deepEqual(demo.zooms, [{ id: 'z1', startMs: 1000, endMs: 2400, scale: 2, focusX: 0.4, focusY: 0.6, easing: 'ease-in-out' }])
  assert.deepEqual(demo.clicks.map((click) => click.tMs), [1200, 2600])
  assert.equal(demo.rendered, undefined, 'the renderer never sends rendered/canvas fields')
  controller.applyTask({ taskId: 't1', state: 'cancelled' })
  controller.resetAfterExport()

  // Ripples off -> no clicks; style/zooms still present.
  assert.equal(controller.setDemoRipples(false), true)
  await controller.startExport({ submit: async ({ request }) => { requests.push(request); return { status: 'accepted', task: { taskId: 't2', state: 'running' } } } })
  assert.deepEqual(requests[1].demo.clicks, [])
  controller.applyTask({ taskId: 't2', state: 'cancelled' })
  controller.resetAfterExport()

  // GIF ignores demo: the UI disables the panel and the request stays R4-shaped.
  assert.equal(controller.setFormat('gif'), true)
  await controller.startExport({ submit: async ({ request }) => { requests.push(request); return { status: 'accepted', task: { taskId: 't3', state: 'running' } } } })
  assert.equal(requests[2].demo, undefined)
  controller.applyTask({ taskId: 't3', state: 'cancelled' })

  // Defaults (frame off, no zooms, no clicks) also omit demo entirely.
  const bare = projectController(demoProject(), { metadata: demoMetadata() })
  const bareRequests = []
  await bare.startExport({ submit: async ({ request }) => { bareRequests.push(request); return { status: 'accepted', task: { taskId: 't4', state: 'running' } } } })
  assert.equal(bareRequests[0].demo, undefined)
})

test('the preview frame mirrors the resolved canvas and applies the mapped zoom transform', (t) => {
  const fake = createFakeApi()
  const { view, harness } = bootView({ api: fake.api })
  t.after(() => view.destroy())
  view.applyInit(initPayload({
    project: demoProject({
      style: { enabled: true, background: '#123456', padding: 0.1, radius: 10, shadow: true },
      zoomSegments: [{ id: 'z1', startMs: 1000, endMs: 2200, scale: 2, focusX: 0.4, focusY: 0.6, easing: 'lineardummy' }]
    }),
    metadata: demoMetadata()
  }))
  const elements = harness.elements
  const frame = elements.get('demo-preview-frame')
  // style.radius 10, padding 10%: 1280x720 content -> 1600x900 canvas.
  assert.equal(frame.dataset.demo, 'on')
  assert.equal(frame.style.aspectRatio, '1600 / 900')
  assert.equal(frame.style.background, '#123456')
  assert.equal(frame.style.padding, '10.000%')
  assert.equal(elements.get('demo-canvas').style.borderRadius, '10px')
  // No zoom before the segment; 2x with the segment's focus origin inside it.
  assert.equal(elements.get('preview-video').style.transform, 'none')
  elements.get('preview-video').currentTime = 1.5
  view.render()
  assert.match(elements.get('preview-video').style.transform, /^scale\(2/)
  assert.equal(elements.get('preview-video').style.transformOrigin, '40.00% 60.00%')
  elements.get('preview-video').currentTime = 3
  view.render()
  assert.equal(elements.get('preview-video').style.transform, 'none')
  // Disabling the style collapses the frame back to the source aspect, no background/padding.
  elements.get('demo-enabled').checked = false
  elements.get('demo-enabled').dispatch('change')
  assert.equal(frame.dataset.demo, 'off')
  assert.equal(frame.style.padding, '0')
  assert.equal(frame.style.background, 'transparent')
})

test('focus picking writes normalised preview coordinates and Escape cancels', (t) => {
  const fake = createFakeApi()
  const { view, harness } = bootView({ api: fake.api })
  t.after(() => view.destroy())
  view.applyInit(initPayload({
    project: demoProject({
      style: { enabled: true },
      zoomSegments: [{ id: 'z1', startMs: 1000, endMs: 2200, scale: 2, focusX: 0.5, focusY: 0.5, easing: 'ease-in-out' }]
    }),
    metadata: demoMetadata()
  }))
  const player = harness.elements.get('preview-video')
  player.rect = { left: 100, top: 50, right: 900, bottom: 500, width: 800, height: 450 }
  assert.equal(view.startPickingZoom(0), true)
  assert.equal(view.getPickingZoomIndex(), 0)
  player.dispatch('click', { clientX: 300, clientY: 275 })
  const zoom = view.getController().state().demo.zooms[0]
  assert.equal(zoom.focusX, 0.25)
  assert.equal(zoom.focusY, 0.5)
  assert.equal(view.getPickingZoomIndex(), null)
  // Escape cancels an active pick.
  view.startPickingZoom(0)
  harness.window.dispatch('keydown', { key: 'Escape' })
  assert.equal(view.getPickingZoomIndex(), null)
})

test('demo controls freeze while an export runs and re-enable after it ends', async (t) => {
  const fake = createFakeApi()
  const { view, harness } = bootView({ api: fake.api })
  t.after(() => view.destroy())
  view.applyInit(initPayload({
    project: demoProject({ style: { enabled: true } }),
    metadata: demoMetadata()
  }))
  await settleEvents()
  await view.exportSelection()
  const elements = harness.elements
  assert.equal(view.getController().state().busy, true)
  assert.equal(elements.get('demo-enabled').disabled, true)
  assert.equal(elements.get('demo-padding').disabled, true)
  assert.equal(elements.get('demo-radius').disabled, true)
  assert.equal(elements.get('demo-shadow').disabled, true)
  assert.equal(elements.get('demo-ripples').disabled, true)
  assert.equal(elements.get('zoom-add').disabled, true)
  assert.equal(elements.get('demo-reset').disabled, true)
  view.handleTask({ taskId: 'task-1', state: 'cancelled' })
  assert.equal(elements.get('demo-enabled').disabled, false)
  assert.equal(elements.get('demo-padding').disabled, false)
})

test('click ripples animate at their output time during playback', async (t) => {
  const fake = createFakeApi({
    eventsAnswer: () => ({
      ok: true,
      track: {
        durationMs: 4000,
        sampledAtHz: 20,
        pointer: [],
        clicks: [{ tMs: 150, x: 0.5, y: 0.5, button: 0 }],
        truncated: false
      }
    })
  })
  const { view, harness } = bootView({ api: fake.api })
  t.after(() => view.destroy())
  view.applyInit(initPayload({
    project: demoProject({ style: { enabled: true } }),
    metadata: demoMetadata()
  }))
  await settleEvents()
  const controller = view.getController()
  assert.equal(controller.setDemoRipples(true), true)
  view.render()
  const player = harness.elements.get('preview-video')
  assert.equal(view.startRangePlayback(), true)
  player.currentTime = 0.3
  await new Promise((resolve) => setTimeout(resolve, 160))
  assert.ok(harness.elements.get('ripple-layer').children.length >= 1, 'a ripple animates after the click time')
  view.stopRangePlayback()
})

// ---------------------------------------------------------------------------
// 4. markup, IPC surface and i18n contract
// ---------------------------------------------------------------------------

test('editor.html exposes the stable E2E ids plus the R4 segment and export controls', () => {
  const html = read('record/editor.html')
  for (const id of [
    // Window + header
    'editor-root', 'window-minimize', 'window-close', 'source-name', 'save-state',
    'back-to-records', 'export-button',
    // Preview + recovery
    'preview-video', 'recovery-banner', 'recovery-retry', 'error-text',
    // Multi-segment timeline: kept blocks, two outer handles, precise inputs, kept playback
    'timeline', 'timeline-track', 'timeline-segments', 'timeline-playhead',
    'handle-start', 'handle-end', 'empty-selection-hint',
    'range-start-input', 'range-end-input', 'play-range', 'range-selection',
    // R4 edit operations (real <button>s; stable data-testid values)
    'split-at-playhead', 'delete-segment', 'reset-edits', 'undo-edit', 'redo-edit',
    // Export panel + progress + result bar (feature-A receipt)
    'export-format', 'gif-edge', 'gif-fps', 'gif-budget',
    'export-resolution', 'export-quality', 'export-fps', 'export-output-size',
    // R5 presentation preview + controls (W13).
    'video-stage', 'demo-preview-frame', 'demo-canvas', 'ripple-layer',
    'demo-enabled', 'demo-background', 'demo-background-custom', 'demo-padding',
    'demo-radius', 'demo-shadow', 'demo-ripples', 'demo-reset', 'events-status',
    'zoom-add', 'zoom-list', 'zoom-suggestions',
    'export-progress', 'cancel-export', 'result-bar', 'result-open', 'result-reveal'
  ]) {
    assert.match(html, new RegExp('id="' + id + '"'), 'editor.html exposes #' + id)
  }
  for (const testid of ['split-at-playhead', 'delete-segment', 'reset-edits', 'undo-edit', 'redo-edit']) {
    assert.match(html, new RegExp('data-testid="' + testid + '"'), 'editor.html exposes data-testid=' + testid)
  }
  // Both precise inputs are real text fields; the outer handles are keyboard-focusable controls.
  assert.match(html, /id="range-start-input"[^>]*type="text"/)
  assert.match(html, /id="range-end-input"[^>]*type="text"/)
  assert.match(html, /id="handle-start"[^>]*type="button"[^>]*role="slider"/)
  assert.match(html, /id="handle-end"[^>]*type="button"[^>]*role="slider"/)
  // R4 formats: mp4/gif/webm in one single export action; the old Save MP4 entry is gone.
  assert.match(html, /<option value="mp4"/)
  assert.match(html, /<option value="gif"/)
  assert.match(html, /<option value="webm"/)
  for (const fps of timeline.GIF_FRAME_RATES) assert.match(html, new RegExp('<option value="' + fps + '"'))
  assert.doesNotMatch(html, /id="saveMp4"/)
  assert.equal((html.match(/id="rerecord"/g) || []).length, 1, 'there is exactly one rerecord control')
  // Frameless window: the titlebar is the drag region and its controls opt out.
  const editorCss = read('record/editor.css')
  assert.ok(editorCss.includes('.titlebar {'), 'the titlebar is styled')
  assert.ok(editorCss.includes('-webkit-app-region: drag'), 'the titlebar is the window drag region')
  // The page CSP allows same-origin file: media for the persistent source, mirroring record.html.
  assert.match(html, /media-src 'self' blob: file:/)
  assert.doesNotMatch(html, /style="[^"]*"/, 'no inline style attributes in the editor markup')
  // Script order: shared options -> timeline math -> controller -> editor view.
  assert.match(html, /shared\/recording-export-options.js[\s\S]*editor-timeline.js[\s\S]*trim-controller.js[\s\S]*editor.js/)
  assert.doesNotMatch(html, /src="record.js"/, 'the editor does not load the recorder script')
})

test('editor.css lays out the stage/panel/timeline and adapts below 980px without inline styles', () => {
  const css = read('record/editor.css')
  for (const selector of [
    '.editor-root', '.titlebar', '.editor-body', '.video-stage', '.timeline-panel',
    '.timeline-track', '.timeline-selection', '.timeline-handle', '.export-panel',
    '.result-bar', '.recovery-banner'
  ]) {
    assert.ok(css.includes(selector), `editor.css defines ${selector}`)
  }
  // GIF-only rows are hidden by a data attribute the script sets (CSP-safe, no inline style).
  assert.ok(css.includes('body[data-format="mp4"] .gif-fields'))
  assert.ok(css.includes('body[data-format="mp4"] .gif-meta'))
  // Narrow screens stack the panel under the stage instead of squeezing columns.
  assert.ok(css.includes('@media (max-width: 980px)'), 'the editor has a narrow-screen breakpoint')
  // The video can shrink: it must never force the timeline out of the window.
  assert.ok(css.includes('#preview-video {'))
  assert.ok(css.includes('max-width: 100%') && css.includes('max-height: 100%'))
})

test('the editor consumer never sends a path over IPC (owner check stays in the main process)', () => {
  const script = read('record/editor.js')
  // The renderer addresses the project/source by id or resultId only.
  assert.doesNotMatch(script, /\btargetPath\b/)
  assert.doesNotMatch(script, /\boutputPath\b/)
  assert.doesNotMatch(script, /\bsourcePath\b/)
  assert.doesNotMatch(script, /ipcRenderer/)
  // The bridge surface the contract frozen in §9.3 (plus the approved reload) is what we call.
  for (const method of [
    'api.ready', 'api.onInit', 'api.saveDraft', 'api.exportProject', 'api.exportStatus',
    'api.cancelExport', 'api.renameProject', 'api.rerecord', 'api.reveal', 'api.back',
    'api.windowAction', 'api.exportAction', 'api.reload', 'api.onExportProgress'
  ]) {
    assert.match(script, new RegExp(`${method.replace('.', '\\.')}`), `editor.js calls ${method}`)
  }
})

test('when preload-record-editor.js has landed it exposes the frozen surface and no paths', (t) => {
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
  assert.ok(preload.includes("'record-editor:init'"), 'preload subscribes to record-editor:init')
  assert.ok(preload.includes("'record:export-progress'"), 'preload subscribes to record:export-progress')
  // No command channel may carry a path: the main process owns every filesystem decision.
  assert.doesNotMatch(preload, /targetPath/)
  assert.doesNotMatch(preload, /outputPath/)
  assert.doesNotMatch(preload, /sourcePath/)
})

test('every export error code maps to a locale key defined for all three languages', () => {
  // Fresh bag: load both domain tables that the editor window loads.
  globalThis.__LOCALES = {}
  require('../shared/locales/record.js')
  require('../shared/locales/recording-editor.js')
  const tables = globalThis.__LOCALES
  for (const code of EXPORT_ERROR_CODES) {
    const key = trimController.errorKey(code)
    assert.match(key, /^(record|recording)\.(error|editor)\./, `${code} must map to a locale key`)
    for (const language of ['zh-CN', 'en-US', 'zh-TW']) {
      assert.equal(typeof tables[language][key], 'string', `${language} is missing ${key} (code ${code})`)
    }
  }
  assert.equal(trimController.errorKey('not-a-real-code'), 'record.error.export-failed')
  // And the editor's own dynamic keys resolve too.
  const tablesAfter = tables
  const script = read('record/editor.js')
  const dynamicKeys = new Set([...script.matchAll(/'recording\.editor\.[a-z0-9.-]+'/g)].map((match) => match[0].slice(1, -1)))
  for (const key of dynamicKeys) {
    for (const language of ['zh-CN', 'en-US', 'zh-TW']) {
      assert.equal(typeof tablesAfter[language][key], 'string', `${language} is missing the dynamic key ${key}`)
    }
  }
})

test('all data-i18n copy in editor.html exists in all three language tables', () => {
  globalThis.__LOCALES = {}
  for (const name of fs.readdirSync(path.join(root, 'shared', 'locales')).filter((entry) => entry.endsWith('.js'))) {
    delete require.cache[require.resolve(path.join(root, 'shared', 'locales', name))]
    require(path.join(root, 'shared', 'locales', name))
  }
  const tables = globalThis.__LOCALES
  const html = read('record/editor.html')
  const used = new Set()
  for (const match of html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) used.add(match[1])
  assert.ok(used.size > 20, 'the editor markup is translated through locale keys')
  for (const key of used) {
    for (const language of ['zh-CN', 'en-US', 'zh-TW']) {
      assert.equal(typeof tables[language][key], 'string', `${language} is missing ${key}`)
    }
  }
})

test('the editor files add no untranslated Chinese copy (i18n gate stays clear)', () => {
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

