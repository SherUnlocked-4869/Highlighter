'use strict'

// C05 (docs/reviews/2026-11-24-windows-product-architecture-review.md): the direct-track
// experiment may record the source video track instead of compositing it through a
// canvas. These tests pin (a) the pure eligibility/track-selection decisions and (b) the
// source contract that keeps the DEFAULT take on the existing canvas path.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {
  BYPASS_REASONS,
  DIRECT_TRACK_ENV,
  readDirectTrackExperiment,
  resolveRecordInit,
  selectRecorderTrackPlan,
  shouldBypassComposition
} = require('../record/recording-utils')

const root = path.join(__dirname, '..')
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8').replace(/\r\n/g, '\n')
const script = read('record/record.js')
const html = read('record/record.html')
const utilsScript = read('record/recording-utils.js')

const eligible = {
  experimentEnabled: true,
  mode: 'display',
  annotationCount: 0,
  hasTransform: false,
  outputSize: { width: 1920, height: 1080 },
  sourceSize: { width: 1920, height: 1080 }
}

const videoTrack = { kind: 'video', id: 'canvas-video' }
const audioTrack = { kind: 'audio', id: 'canvas-audio' }
const sourceVideoTrack = { kind: 'video', id: 'source-video' }
const mixedAudioTrack = { kind: 'audio', id: 'mixed-audio' }
const canvasStream = {
  getVideoTracks: () => [videoTrack],
  getAudioTracks: () => [audioTrack]
}
const sourceStream = {
  getVideoTracks: () => [sourceVideoTrack],
  getAudioTracks: () => [{ kind: 'audio', id: 'source-audio' }]
}

// ---------------------------------------------------------------------------
// Decision matrix
// ---------------------------------------------------------------------------

test('the direct-track experiment is refused unless the environment switch is on', () => {
  // The default must never change: experiment disabled always means canvas.
  assert.deepEqual(shouldBypassComposition({
    ...eligible,
    experimentEnabled: false
  }), { bypass: false, reason: BYPASS_REASONS.experimentDisabled })
  assert.deepEqual(shouldBypassComposition({
    ...eligible,
    experimentEnabled: undefined
  }), { bypass: false, reason: BYPASS_REASONS.experimentDisabled })
  // A truthy string is not an opt-in: only the boolean true may enable the experiment.
  assert.deepEqual(shouldBypassComposition({
    ...eligible,
    experimentEnabled: 'true'
  }), { bypass: false, reason: BYPASS_REASONS.experimentDisabled })
  assert.deepEqual(shouldBypassComposition({}), { bypass: false, reason: BYPASS_REASONS.experimentDisabled })
  assert.deepEqual(shouldBypassComposition(), { bypass: false, reason: BYPASS_REASONS.experimentDisabled })
})

test('window mode, region mode and unknown modes keep the compositor', () => {
  assert.deepEqual(shouldBypassComposition({ ...eligible, mode: 'window' }), {
    bypass: false,
    reason: BYPASS_REASONS.modeWindow
  })
  assert.deepEqual(shouldBypassComposition({ ...eligible, mode: 'region' }), {
    bypass: false,
    reason: BYPASS_REASONS.modeRegion
  })
  assert.deepEqual(shouldBypassComposition({ ...eligible, mode: 'fullscreen' }), {
    bypass: false,
    reason: BYPASS_REASONS.modeUnsupported
  })
})

test('annotations, transforms and different output sizes keep the compositor', () => {
  assert.deepEqual(shouldBypassComposition({ ...eligible, annotationCount: 1 }), {
    bypass: false,
    reason: BYPASS_REASONS.annotations
  })
  assert.deepEqual(shouldBypassComposition({ ...eligible, hasTransform: true }), {
    bypass: false,
    reason: BYPASS_REASONS.transform
  })
  assert.deepEqual(shouldBypassComposition({
    ...eligible,
    outputSize: { width: 1280, height: 720 }
  }), { bypass: false, reason: BYPASS_REASONS.sizeMismatch })
  assert.deepEqual(shouldBypassComposition({
    ...eligible,
    outputSize: { width: 1920, height: 1080 },
    sourceSize: { width: 1920, height: 1082 }
  }), { bypass: false, reason: BYPASS_REASONS.sizeMismatch })
})

test('a missing or invalid size keeps the compositor instead of guessing', () => {
  assert.deepEqual(shouldBypassComposition({ ...eligible, sourceSize: null }), {
    bypass: false,
    reason: BYPASS_REASONS.sourceSizeMissing
  })
  assert.deepEqual(shouldBypassComposition({
    ...eligible,
    outputSize: { width: 0, height: 0 }
  }), { bypass: false, reason: BYPASS_REASONS.sourceSizeMissing })
  assert.deepEqual(shouldBypassComposition({
    ...eligible,
    sourceSize: { width: 'nonsense', height: 1080 }
  }), { bypass: false, reason: BYPASS_REASONS.sourceSizeMissing })
})

test('only full-screen, unannotated, untransformed, same-size takes bypass', () => {
  assert.deepEqual(shouldBypassComposition(eligible), {
    bypass: true,
    reason: BYPASS_REASONS.eligible
  })
  // An absent mode means the default display mode; a negative annotation count counts as 0.
  assert.equal(shouldBypassComposition({ ...eligible, mode: undefined, annotationCount: -3 }).bypass, true)
  // The decision always carries exactly the two contract keys.
  assert.deepEqual(Object.keys(shouldBypassComposition(eligible)).sort(), ['bypass', 'reason'])
})

// ---------------------------------------------------------------------------
// Environment switch
// ---------------------------------------------------------------------------

test('the experiment is read from the environment only, exactly "1"', () => {
  assert.equal(DIRECT_TRACK_ENV, 'HIGHLIGHTER_RECORD_DIRECT_TRACK')
  assert.equal(readDirectTrackExperiment({ [DIRECT_TRACK_ENV]: '1' }), true)
  assert.equal(readDirectTrackExperiment({ [DIRECT_TRACK_ENV]: ' 1 ' }), true)
  for (const value of ['0', 'true', 'yes', '', '01', 1, true, null, undefined]) {
    assert.equal(readDirectTrackExperiment({ [DIRECT_TRACK_ENV]: value }), false, String(value))
  }
  assert.equal(readDirectTrackExperiment(), false)
  assert.equal(readDirectTrackExperiment(null), false)
  assert.equal(readDirectTrackExperiment('1'), false)
  // The key is centralised in recording-utils: record.js must not read a second spelling.
  assert.equal(utilsScript.includes(DIRECT_TRACK_ENV), true)
  assert.equal(script.includes(DIRECT_TRACK_ENV), false)
})

test('record:init forwards the switch as a plain boolean (default false)', () => {
  assert.equal(resolveRecordInit({ directTrackExperiment: true }).directTrackExperiment, true)
  assert.equal(resolveRecordInit({ directTrackExperiment: 'true' }).directTrackExperiment, false)
  assert.equal(resolveRecordInit({}).directTrackExperiment, false)
  assert.equal(resolveRecordInit().directTrackExperiment, false)
})

// ---------------------------------------------------------------------------
// Media-track selector
// ---------------------------------------------------------------------------

test('the selector returns the untouched canvas stream for a default take', () => {
  const plan = selectRecorderTrackPlan({
    bypass: false,
    reason: BYPASS_REASONS.experimentDisabled,
    canvasStream,
    createStream: () => {
      throw new Error('the canvas path must not build a new stream')
    }
  })
  assert.equal(plan.bypass, false)
  assert.equal(plan.kind, 'canvas')
  assert.equal(plan.stream, canvasStream)
  assert.deepEqual(plan.videoTracks, [videoTrack])
  assert.deepEqual(plan.audioTracks, [audioTrack])
  assert.equal(plan.reason, BYPASS_REASONS.experimentDisabled)
})

test('the selector builds one direct stream from the source video track plus mixed audio', () => {
  const created = []
  const directStream = { id: 'direct' }
  const plan = selectRecorderTrackPlan({
    bypass: true,
    reason: BYPASS_REASONS.eligible,
    canvasStream: null,
    sourceStream,
    mixedAudioTracks: [mixedAudioTrack, null],
    createStream: (tracks) => {
      created.push(tracks)
      return directStream
    }
  })
  assert.equal(plan.bypass, true)
  assert.equal(plan.kind, 'direct')
  assert.equal(plan.stream, directStream)
  assert.deepEqual(created, [[sourceVideoTrack, mixedAudioTrack]])
  assert.deepEqual(plan.videoTracks, [sourceVideoTrack])
  assert.deepEqual(plan.audioTracks, [mixedAudioTrack])
  assert.equal(plan.reason, BYPASS_REASONS.eligible)
})

test('the selector falls back to the canvas stream with an explicit reason', () => {
  const noVideo = { getVideoTracks: () => [], getAudioTracks: () => [] }
  const noTrackPlan = selectRecorderTrackPlan({
    bypass: true,
    reason: BYPASS_REASONS.eligible,
    canvasStream,
    sourceStream: noVideo,
    createStream: () => ({ id: 'never' })
  })
  assert.equal(noTrackPlan.bypass, false)
  assert.equal(noTrackPlan.stream, canvasStream)
  assert.equal(noTrackPlan.reason, BYPASS_REASONS.sourceTrackMissing)

  const brokenPlan = selectRecorderTrackPlan({
    bypass: true,
    reason: BYPASS_REASONS.eligible,
    canvasStream,
    sourceStream,
    createStream: () => {
      throw new Error('MediaStream unavailable')
    }
  })
  assert.equal(brokenPlan.bypass, false)
  assert.equal(brokenPlan.stream, canvasStream)
  assert.equal(brokenPlan.reason, BYPASS_REASONS.streamFailed)

  const noFactoryPlan = selectRecorderTrackPlan({
    bypass: true,
    canvasStream,
    sourceStream
  })
  assert.equal(noFactoryPlan.bypass, false)
  assert.equal(noFactoryPlan.reason, BYPASS_REASONS.streamFailed)
})

// ---------------------------------------------------------------------------
// record/record.js source contract
// ---------------------------------------------------------------------------

test('record.js decides once, before MediaRecorder exists, and never re-wires mid-take', () => {
  assert.match(script, /function directTrackExperimentEnabled\(\) \{/)
  assert.match(script, /if \(initData && initData\.directTrackExperiment === true\) return true/)
  assert.match(script, /const decision = shouldBypassComposition\(\{[\s\S]{0,400}?experimentEnabled: directTrackExperimentEnabled\(\)/)
  assert.match(script, /directTrackDecision = decideDirectTrackTake\(sourceSize\)/)
  assert.match(script, /canvas = directTrackDecision\.bypass \? null : buildOutputCanvas\(\)/)
  assert.match(script, /recorderStream = createDirectRecorderStream\(mixedAudioTracks\)/)
  // The decision is made in prepareSource, i.e. before createMediaRecorder() runs.
  const prepareIndex = script.indexOf('async function prepareSource()')
  const recorderIndex = script.indexOf('function createMediaRecorder()')
  assert.ok(prepareIndex > 0 && recorderIndex > prepareIndex, 'prepareSource must precede createMediaRecorder')
  const decisionIndex = script.indexOf('directTrackDecision = decideDirectTrackTake(sourceSize)')
  assert.ok(decisionIndex > prepareIndex && decisionIndex < recorderIndex)
  // No track swap after the take started: the only harness is stop-and-report.
  assert.doesNotMatch(script, /recorder\.(?:start|stop)\([\s\S]{0,80}new MediaStream/)
})

test('the default take keeps the canvas capture stream and the compositor loop', () => {
  assert.match(script, /canvasStream = canvas\.captureStream\(frameRate\)/)
  assert.match(script, /function recorderInputStream\(\) \{\n  return recorderStream \|\| canvasStream/)
  assert.match(script, /const stream = recorderInputStream\(\)/)
  assert.match(script, /return new MediaRecorder\(stream, options\)/)
  assert.match(script, /if \(!directTrackTakeActive\(\)\) startCompositeLoop\(\)/)
  // The existing sizing paths are still the ones that build the canvas.
  assert.match(script, /canvas\._recordFit = fitContainRect\(sourceVideo\.videoWidth, sourceVideo\.videoHeight, canvas\.width, canvas\.height\)/)
  assert.match(script, /canvas\._recordCrop = crop/)
  // Audio still goes into the canvas stream whenever that stream exists.
  assert.match(script, /if \(canvasStream\) audioMix\.tracks\.forEach\(\(track\) => canvasStream\.addTrack\(track\)\)/)
  // The control bar still loads the pure helpers before the page script.
  assert.match(html, /recording-utils\.js[\s\S]*record\.js/)
})

test('a composition change mid-take stops the take through the existing error channel', () => {
  assert.match(script, /function handleDirectTrackCompositionChange\(reason\) \{/)
  assert.match(script, /function handleDirectTrackCompositionChange\(reason\) \{[\s\S]{0,400}?setFailureNotice\('record\.error\.record-failed'\)/)
  assert.match(script, /function handleDirectTrackCompositionChange\(reason\) \{[\s\S]{0,500}?finishRecording\(\)\.catch/)
  // An annotation snapshot that actually contains strokes stops the direct take.
  assert.match(script, /if \(directTrackTakeActive\(\) && annotationSnapshot\.annotations\.length > 0\) \{[\s\S]{0,160}?handleDirectTrackCompositionChange\('annotations-present'\)/)
  // A source raster change would change the encoded size, so it is the second trigger.
  assert.match(script, /sourceVideo\.addEventListener\('resize', handleDirectTrackSourceResize\)/)
  assert.match(script, /handleDirectTrackCompositionChange\('output-size-changed'\)/)
  // Teardown releases the direct stream and clears the decision.
  assert.match(script, /recorderStream\?\.getTracks\(\)\.forEach\(\(track\) => track\.stop\(\)\)/)
  assert.match(script, /directTrackDecision = null/)
})
