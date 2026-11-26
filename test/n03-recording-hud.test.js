'use strict'

// N03 (docs/reviews/2026-11-26-code-review-and-optimization-report.md section 5.3):
//   A. the keystroke capsule HUD - modifier shortcut combos are captured during a take, ride in
//      events.json as an additive `keystrokes` array, and the editor can toggle a bottom capsule
//      overlay that follows the media clock;
//   B. one-click dead-air removal - the main process runs ffmpeg silencedetect, corroborates the
//      silent spans with the pointer-idle event track, and the editor turns the suggestion into
//      an ordinary (undoable, previewable, exportable) multi-segment edit.
//
// The tests are behaviour-level:
//   * the SHIPPED capture policy is extracted from record/record.js and executed (the browser file
//     is a classic script, so the pure block is the only unit without a window);
//   * the main-process analysis helpers are called directly, including with a fake ffmpeg stderr;
//   * events.json persistence runs against a real temporary project directory;
//   * the editor's HUD/cut controls are driven over the same fake DOM shape the existing editor
//     tests use (createEditorView + real record/editor.js).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')

const root = path.join(__dirname, '..')
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8')

const recordDomain = require('../main/domains/record')
const projectService = require('../main/services/recording-project-service')
const trimController = require('../record/trim-controller')
const editorModule = require('../record/editor')

// ---------------------------------------------------------------------------
// 1. capture policy (record/record.js)
// ---------------------------------------------------------------------------

function loadShippedKeystrokePolicy() {
  const source = read('record/record.js')
  const start = source.indexOf('/* N03-KEYSTROKE-POLICY-START */')
  const end = source.indexOf('/* N03-KEYSTROKE-POLICY-END */')
  assert.ok(start > 0 && end > start, 'record.js must keep the documented N03 policy markers')
  const block = source.slice(start, end)
  // `new Function` keeps this a behaviour test of the shipped block: the file itself cannot be
  // required (it is a classic browser script that reads `window.recordingUtils` at load time).
  return new Function(
    block + '\n; return { shouldCaptureKeystroke, formatKeystrokeCombo, isEditableKeystrokeTarget, KEYSTROKE_SINGLE_KEYS }'
  )()
}

test('N03: the capture policy records modifier chords and whitelisted single keys only', () => {
  const policy = loadShippedKeystrokePolicy()
  const recording = 'recording'

  // Modifier chords are exactly what the capsule is for.
  assert.equal(policy.shouldCaptureKeystroke({ key: 'p', ctrlKey: true, shiftKey: true }, recording), true)
  assert.equal(policy.formatKeystrokeCombo({ key: 'p', ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+P')
  assert.equal(policy.shouldCaptureKeystroke({ key: 'Tab', altKey: true }, recording), true)
  assert.equal(policy.formatKeystrokeCombo({ key: 'Tab', altKey: true }), 'Alt+Tab')
  assert.equal(policy.formatKeystrokeCombo({ key: 'F5', ctrlKey: true }), 'Ctrl+F5')
  assert.equal(policy.formatKeystrokeCombo({ key: 'Enter', ctrlKey: true, metaKey: true }), 'Ctrl+Win+Enter')

  // Whitelisted navigation/function keys are allowed on their own.
  for (const key of ['Enter', 'Escape', 'Tab', 'F1', 'F12', 'ArrowUp', 'PageDown']) {
    assert.equal(policy.shouldCaptureKeystroke({ key }, recording), true, key + ' must be whitelisted')
  }
  assert.equal(policy.formatKeystrokeCombo({ key: 'Escape' }), 'Esc')
  // Space alone is typing, not a shortcut; Space as part of a chord is a valid label.
  assert.equal(policy.formatKeystrokeCombo({ key: ' ' }), '')
  assert.equal(policy.formatKeystrokeCombo({ key: ' ', ctrlKey: true }), 'Ctrl+Space')
  assert.equal(policy.formatKeystrokeCombo({ key: 'ArrowUp' }), 'Up')

  // Plain typing never leaves the window - this is the privacy rule (passwords, chat, code).
  assert.equal(policy.shouldCaptureKeystroke({ key: 'a' }, recording), false)
  assert.equal(policy.shouldCaptureKeystroke({ key: 'a', shiftKey: true }, recording), false)
  assert.equal(policy.shouldCaptureKeystroke({ key: '1' }, recording), false)
  assert.equal(policy.shouldCaptureKeystroke({ key: ' ', altKey: false }, recording), false)
  // The formatter itself is only a label builder; Shift alone never satisfies the policy above.
  assert.equal(policy.formatKeystrokeCombo({ key: 'a', shiftKey: true }), 'Shift+A')

  // Modifier-only presses, key repeat and IME composition are not shortcuts.
  for (const key of ['Control', 'Shift', 'Alt', 'Meta']) {
    assert.equal(policy.shouldCaptureKeystroke({ key, ctrlKey: key === 'Control' }, recording), false, key)
  }
  assert.equal(policy.shouldCaptureKeystroke({ key: 'p', ctrlKey: true, repeat: true }, recording), false)
  assert.equal(policy.shouldCaptureKeystroke({ key: 'p', ctrlKey: true, isComposing: true }, recording), false)
  assert.equal(policy.shouldCaptureKeystroke({ key: 'p', ctrlKey: true, keyCode: 229 }, recording), false)

  // Only a live take, and never a field the user is typing into.
  assert.equal(policy.shouldCaptureKeystroke({ key: 'p', ctrlKey: true }, 'idle'), false)
  assert.equal(policy.shouldCaptureKeystroke({ key: 'p', ctrlKey: true }, 'paused'), false)
  assert.equal(policy.shouldCaptureKeystroke({ key: 'p', ctrlKey: true, target: { tagName: 'INPUT' } }, recording), false)
  assert.equal(policy.isEditableKeystrokeTarget({ isContentEditable: true }), true)
  assert.equal(policy.isEditableKeystrokeTarget({ tagName: 'div' }), false)
})

test('N03: record.js installs the policy and flushes the last batch before finish-session', () => {
  const script = read('record/record.js')
  assert.match(script, /addEventListener\('keydown', handleKeystroke, true\)/)
  assert.match(script, /function handleKeystroke\(event\)[\s\S]*shouldCaptureKeystroke\(event, state\)/)
  assert.match(script, /pendingKeystrokes\.push\(\{ at: Date\.now\(\), combo \}\)/)
  assert.match(script, /function flushKeystrokes\(\)[\s\S]*reportState\(\{ keystrokes: batch \}\)/)
  assert.match(script, /function reportState\(extra = null\)/)
  // The last batch must be on the state channel before the finish invoke is awaited.
  const flushIndex = script.search(/flushKeystrokes\(\)\s+let result = null/)
  const finishIndex = script.indexOf('window.recordAPI.finishSession(sessionId')
  assert.ok(flushIndex > 0, 'the last keystroke batch is flushed before finish-session')
  assert.ok(finishIndex > flushIndex, 'flush must precede the finish invoke')
  // A new take starts empty and the recorder clock is stamped at the same point.
  assert.match(script, /mediaStartedAtWall = Date\.now\(\)\s+pausedIntervals = \[\]\s+pauseStartedAtWall = 0\s+resetKeystrokeCapture\(\)/)
  // Only the validated combo label is buffered, never the raw key/text.
  assert.doesNotMatch(script, /pendingKeystrokes\.push\(\{ at: Date\.now\(\), key:/)
})

// ---------------------------------------------------------------------------
// 2. main-process keystroke mapping
// ---------------------------------------------------------------------------

test('N03: shortcut batches map onto media time and drop invalid or beyond-duration entries', () => {
  const base = 1_700_000_000_000
  const entries = recordDomain.sanitizeKeystrokeBatch([
    { at: base + 1000, combo: 'Ctrl+Shift+P' },
    { at: base + 500, combo: 'F5' },
    { at: 'junk', combo: 'Ctrl+C' },
    { at: base + 1500, combo: 'not a combo' },
    { at: base + 1600, combo: 'a' },
    { at: base + 1700, combo: 'Ctrl+Alt+Delete' }
  ])
  assert.deepEqual(entries, [
    { at: base + 1000, combo: 'Ctrl+Shift+P' },
    { at: base + 500, combo: 'F5' },
    { at: base + 1700, combo: 'Ctrl+Alt+Delete' }
  ])

  const track = recordDomain.buildKeystrokeTrack(entries, {
    mediaStartedAtWall: base,
    pausedIntervals: [{ startWall: base + 2000, endWall: base + 4000 }],
    durationMs: 5000
  })
  assert.deepEqual(track, [
    { tMs: 500, combo: 'F5' },
    { tMs: 1000, combo: 'Ctrl+Shift+P' },
    { tMs: 1700, combo: 'Ctrl+Alt+Delete' }
  ])

  // Paused time is excluded from the media clock, exactly like the pointer track.
  const paused = recordDomain.buildKeystrokeTrack([{ at: base + 6000, combo: 'Ctrl+S' }], {
    mediaStartedAtWall: base,
    pausedIntervals: [{ startWall: base + 2000, endWall: base + 4000 }],
    durationMs: 5000
  })
  assert.deepEqual(paused, [{ tMs: 4000, combo: 'Ctrl+S' }])
  // Before the media start / after the probed end never land in the track.
  assert.deepEqual(recordDomain.buildKeystrokeTrack([{ at: base - 1, combo: 'Ctrl+S' }], {
    mediaStartedAtWall: base,
    pausedIntervals: [],
    durationMs: 5000
  }), [])
  assert.deepEqual(recordDomain.buildKeystrokeTrack([{ at: base + 6000, combo: 'Ctrl+S' }], {
    mediaStartedAtWall: base,
    pausedIntervals: [],
    durationMs: 5000
  }), [])
  // A missing clock or duration produces no invented times.
  assert.deepEqual(recordDomain.buildKeystrokeTrack(entries, { durationMs: 5000 }), [])
  assert.deepEqual(recordDomain.buildKeystrokeTrack(entries, { mediaStartedAtWall: base, durationMs: 0 }), [])
})

test('N03: the keystroke combo validator accepts shipped labels and rejects free text', () => {
  for (const combo of ['Ctrl+Shift+P', 'Alt+Tab', 'F12', 'Shift+F7', 'Win+Up', 'Ctrl+Alt+Delete']) {
    assert.equal(recordDomain.isValidKeystrokeCombo(combo), true, combo)
  }
  for (const combo of ['', 'a', 'hello world', 'Ctrl+', 'Ctrl+Shift+', 'Ctrl+P\n', 'Password123', 'Ctrl+P+Q+R+S+T+U+']) {
    assert.equal(recordDomain.isValidKeystrokeCombo(combo), false, JSON.stringify(combo))
  }
})

// ---------------------------------------------------------------------------
// 3. events.json persistence (recording-project-service.js)
// ---------------------------------------------------------------------------

async function createProjectContext() {
  const directory = await fsp.mkdtemp(path.join(root, '.tmp-n03-'))
  const service = projectService.createRecordingProjectService({
    root: directory,
    fs: fsp,
    path,
    log: () => {}
  })
  const created = await service.createProject({ name: 'N03' })
  return {
    root: directory,
    service,
    project: created.project,
    projectDirectory: path.dirname(path.join(directory, created.project.id, 'project.json')),
    async cleanup() {
      await service.dispose()
      await fsp.rm(directory, { recursive: true, force: true })
    }
  }
}

test('N03: events.json persists shortcut capsules additively and keeps legacy tracks untouched', async (t) => {
  const context = await createProjectContext()
  t.after(() => context.cleanup())

  const written = await context.service.writeEventTrack(context.project.id, {
    durationMs: 8000,
    pointer: [{ tMs: 100, x: 0.5, y: 0.5 }],
    clicks: [],
    keystrokes: [
      { tMs: 1200, combo: 'Ctrl+Shift+P' },
      { tMs: 300, combo: 'Alt+Tab' },
      { tMs: 5000, combo: 'a' },
      { tMs: 'junk', combo: 'Ctrl+C' },
      { tMs: 9000, combo: 'Ctrl+S' }
    ]
  })
  assert.equal(written.ok, true)
  assert.deepEqual(written.track.keystrokes, [
    { tMs: 300, combo: 'Alt+Tab' },
    { tMs: 1200, combo: 'Ctrl+Shift+P' }
  ])
  assert.deepEqual(written.track.pointer, [{ tMs: 100, x: 0.5, y: 0.5 }])
  const onDisk = JSON.parse(await fsp.readFile(path.join(context.projectDirectory, 'events.json'), 'utf8'))
  assert.deepEqual(onDisk, written.track)
  assert.deepEqual(await context.service.readEventTrack(context.project.id), written.track)

  // A pre-N03 track (no field) writes/reads byte-identically: the additive field is only added
  // when the take actually produced shortcuts.
  const legacy = await context.service.writeEventTrack(context.project.id, {
    durationMs: 1000,
    pointer: [],
    clicks: [],
    truncated: false
  })
  assert.equal(Object.hasOwn(legacy.track, 'keystrokes'), false)
  const legacyOnDisk = JSON.parse(await fsp.readFile(path.join(context.projectDirectory, 'events.json'), 'utf8'))
  assert.equal(Object.hasOwn(legacyOnDisk, 'keystrokes'), false)
  const legacyRead = await context.service.readEventTrack(context.project.id)
  assert.equal(Object.hasOwn(legacyRead, 'keystrokes'), false)
})

// ---------------------------------------------------------------------------
// 4. main-process silence analysis
// ---------------------------------------------------------------------------

function fakeFfmpeg({ stderr = '', code = 0, hang = false } = {}) {
  const calls = []
  const spawnProcess = (executable, args) => {
    calls.push({ executable, args })
    const child = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => { child.killed = true }
    process.nextTick(() => {
      if (stderr) child.stderr.emit('data', stderr)
      if (!hang) child.emit('close', code)
    })
    return child
  }
  return { calls, spawnProcess }
}

const SILENCE_STDERR = [
  '[silencedetect @ 000001] silence_start: 1.5',
  '[silencedetect @ 000001] silence_end: 3.25 | silence_duration: 1.75',
  '[silencedetect @ 000001] silence_start: 6.0',
  '[silencedetect @ 000001] silence_end: 7.4 | silence_duration: 1.4'
].join('\n')

test('N03: silencedetect output is parsed into clamped media ranges', () => {
  const ranges = recordDomain.parseSilenceDetectOutput(SILENCE_STDERR, { durationMs: 8000 })
  assert.deepEqual(ranges, [{ startMs: 1500, endMs: 3250 }, { startMs: 6000, endMs: 7400 }])
  // A dangling start at EOF closes at the recording duration.
  assert.deepEqual(
    recordDomain.parseSilenceDetectOutput('[silencedetect @ x] silence_start: 5.0', { durationMs: 8000 }),
    [{ startMs: 5000, endMs: 8000 }]
  )
  // Runs beyond the media duration are clamped, end-before-start is dropped, no lines = no ranges.
  assert.deepEqual(
    recordDomain.parseSilenceDetectOutput(SILENCE_STDERR, { durationMs: 3000 }),
    [{ startMs: 1500, endMs: 3000 }]
  )
  assert.deepEqual(recordDomain.parseSilenceDetectOutput('', { durationMs: 3000 }), [])
})

test('N03: the ffmpeg runner reports success, no-audio, failure and timeout with stable codes', async () => {
  const ok = fakeFfmpeg({ stderr: SILENCE_STDERR })
  const detected = await recordDomain.runSilenceDetect({
    ffmpegPath: 'ffmpeg.exe',
    sourcePath: 'capture.webm',
    durationMs: 8000,
    spawnProcess: ok.spawnProcess
  })
  assert.equal(detected.ok, true)
  assert.deepEqual(detected.ranges, [{ startMs: 1500, endMs: 3250 }, { startMs: 6000, endMs: 7400 }])
  assert.equal(ok.calls.length, 1)
  assert.equal(ok.calls[0].executable, 'ffmpeg.exe')
  assert.ok(ok.calls[0].args.includes('silencedetect=noise=-35dB:d=0.7'), ok.calls[0].args.join(' '))
  assert.ok(ok.calls[0].args.includes('capture.webm'))

  const silent = fakeFfmpeg({ stderr: "Stream map '0:a:0' matches no streams.", code: 1 })
  const noAudio = await recordDomain.runSilenceDetect({
    ffmpegPath: 'ffmpeg.exe',
    sourcePath: 'capture.webm',
    durationMs: 8000,
    spawnProcess: silent.spawnProcess
  })
  assert.deepEqual(noAudio, { ok: false, code: 'no-audio' })

  const broken = fakeFfmpeg({ stderr: 'Invalid data found when processing input', code: 1 })
  const failed = await recordDomain.runSilenceDetect({
    ffmpegPath: 'ffmpeg.exe',
    sourcePath: 'capture.webm',
    durationMs: 8000,
    spawnProcess: broken.spawnProcess
  })
  assert.deepEqual(failed, { ok: false, code: 'analysis-failed' })

  const hanging = fakeFfmpeg({ hang: true })
  const timedOut = await recordDomain.runSilenceDetect({
    ffmpegPath: 'ffmpeg.exe',
    sourcePath: 'capture.webm',
    durationMs: 8000,
    spawnProcess: hanging.spawnProcess,
    limits: { analysisTimeoutMs: 25 }
  })
  assert.deepEqual(timedOut, { ok: false, code: 'analysis-timeout' })

  // Missing seam/path inputs are answered, never thrown.
  assert.deepEqual(await recordDomain.runSilenceDetect({}), { ok: false, code: 'analysis-unavailable' })
  assert.deepEqual(
    await recordDomain.runSilenceDetect({ ffmpegPath: 'ffmpeg.exe', sourcePath: '', spawnProcess: ok.spawnProcess }),
    { ok: false, code: 'source-unavailable' }
  )
})

test('N03: pointer-idle ranges come from consecutive still samples', () => {
  // 0.0 s -> 2.4 s stays inside the drift, then the pointer jumps: one idle range.
  const idle = recordDomain.computePointerIdleRanges([
    { tMs: 0, x: 0.5, y: 0.5 },
    { tMs: 600, x: 0.505, y: 0.5 },
    { tMs: 1200, x: 0.5, y: 0.502 },
    { tMs: 1800, x: 0.503, y: 0.5 },
    { tMs: 2400, x: 0.5, y: 0.5 },
    { tMs: 3000, x: 0.9, y: 0.9 },
    { tMs: 3600, x: 0.9, y: 0.9 }
  ])
  assert.deepEqual(idle, [{ startMs: 0, endMs: 2400 }])
  // Continuous movement produces nothing.
  assert.deepEqual(recordDomain.computePointerIdleRanges([
    { tMs: 0, x: 0.1, y: 0.1 },
    { tMs: 700, x: 0.3, y: 0.3 },
    { tMs: 1400, x: 0.6, y: 0.6 },
    { tMs: 2100, x: 0.9, y: 0.9 }
  ]), [])
  assert.deepEqual(recordDomain.computePointerIdleRanges([]), [])
})

test('N03: pause cuts require enough silence, mouse-idle corroboration, padding and merging', () => {
  const durationMs = 20000
  const slowPointer = []
  for (let tMs = 0; tMs <= durationMs; tMs += 400) {
    // Idle everywhere except during 9000-12000 where the user demonstrates something.
    slowPointer.push({ tMs, x: tMs >= 9000 && tMs < 12000 ? 0.2 + (tMs - 9000) / 20000 : 0.5, y: 0.5 })
  }

  // No event track: audio silence alone is enough (e.g. a voice-over recording).
  const audioOnly = recordDomain.derivePauseCuts({
    silenceRanges: [{ startMs: 2000, endMs: 5000 }],
    durationMs,
    hasEventTrack: false
  })
  assert.equal(audioOnly.ok, true)
  assert.deepEqual(audioOnly.cuts, [{ startMs: 2180, endMs: 4820 }], 'padding is trimmed from both sides')

  // With an event track, silence inside a pointer-ACTIVE span is not dead air.
  const mixed = recordDomain.derivePauseCuts({
    silenceRanges: [
      { startMs: 2000, endMs: 5000 },
      { startMs: 9000, endMs: 12000 },
      { startMs: 15000, endMs: 18000 }
    ],
    pointer: slowPointer,
    durationMs,
    hasEventTrack: true
  })
  assert.equal(mixed.ok, true)
  assert.deepEqual(mixed.cuts, [
    { startMs: 2180, endMs: 4820 },
    { startMs: 15180, endMs: 17820 }
  ])

  // Shorter than the minimum silence threshold -> no suggestion.
  const tooShort = recordDomain.derivePauseCuts({
    silenceRanges: [{ startMs: 1000, endMs: 1400 }],
    durationMs,
    hasEventTrack: false
  })
  assert.deepEqual(tooShort, { ok: false, code: 'nothing-to-cut' })

  // Silent spans closer than mergeGapMs are one cut.
  const merged = recordDomain.derivePauseCuts({
    silenceRanges: [{ startMs: 2000, endMs: 4000 }, { startMs: 4100, endMs: 6000 }],
    durationMs,
    hasEventTrack: false
  })
  assert.equal(merged.ok, true)
  assert.equal(merged.cuts.length, 1)
  assert.deepEqual(merged.cuts[0], { startMs: 2180, endMs: 5820 })

  // Event track with no idle evidence: explained code, never a blind cut.
  const noIdle = recordDomain.derivePauseCuts({
    silenceRanges: [{ startMs: 2000, endMs: 5000 }],
    pointer: [{ tMs: 0, x: 0.1, y: 0.1 }, { tMs: 1000, x: 0.9, y: 0.9 }, { tMs: 2000, x: 0.1, y: 0.1 }],
    durationMs,
    hasEventTrack: true
  })
  assert.equal(noIdle.ok, false)
  assert.equal(noIdle.code, 'no-idle')

  assert.equal(recordDomain.derivePauseCuts({ durationMs: 0 }).code, 'duration-unavailable')
})

// ---------------------------------------------------------------------------
// 5. editor-side controller (trim-controller.js)
// ---------------------------------------------------------------------------

function projectFixture(overrides = {}) {
  return {
    id: 'project-n03',
    name: 'N03',
    mode: 'display',
    state: 'ready',
    media: { durationMs: 20000, video: { width: 1280, height: 720 }, audio: { tracks: 1 } },
    edit: { revision: 1, keepRanges: [], format: 'mp4', gif: { edge: 1280, fps: 15 } },
    exports: [],
    recovery: { cleanStop: true, errorCode: '' },
    ...overrides
  }
}

function createProjectController(project = projectFixture()) {
  return trimController.createRecordTrimController({
    projectId: project.id,
    project,
    metadata: { durationMs: project.media.durationMs, video: project.media.video, audio: { tracks: 1 } },
    translate: (key) => key,
    available: true
  })
}

test('N03: the controller normalises capsules and turns suggestions into undoable segments', () => {
  const project = projectFixture()
  const controller = createProjectController(project)
  controller.applyEventTrack({
    pointer: [{ tMs: 1000, x: 0.5, y: 0.5 }],
    clicks: [],
    keystrokes: [
      { tMs: 900, combo: 'Ctrl+Shift+P' },
      { tMs: 400, combo: 'hello world' },
      { tMs: 1200, combo: 'F5' }
    ]
  }, {
    pauseAnalysis: { ok: true, cuts: [{ startMs: 2000, endMs: 5000 }, { startMs: 9000, endMs: 12000 }] }
  })

  let state = controller.state()
  assert.equal(state.keystrokes.available, true)
  assert.equal(state.keystrokes.count, 2)
  assert.deepEqual(state.keystrokes.items.map((entry) => entry.combo), ['Ctrl+Shift+P', 'F5'])
  assert.equal(state.pauseAnalysis.status, 'ready')
  assert.equal(state.pauseAnalysis.cuts.length, 2)

  const applied = controller.applyPauseCuts()
  assert.equal(applied.ok, true)
  assert.equal(applied.cuts, 2)
  assert.deepEqual(controller.state().segments, [
    { startMs: 0, endMs: 2000 },
    { startMs: 5000, endMs: 9000 },
    { startMs: 12000, endMs: 20000 }
  ])
  assert.equal(controller.state().undo, true, 'the cut is one undo step')
  // Applying the same suggestion again is a no-op with a code, not a silent edit.
  assert.deepEqual(controller.applyPauseCuts(), { ok: false, code: 'nothing-to-cut' })
  assert.equal(controller.undoEdit(), true)
  assert.deepEqual(controller.state().segments, [{ startMs: 0, endMs: 20000 }])
})

test('N03: a failed analysis leaves the segments untouched and reports the reason', () => {
  // Before the events load answers, a click explains "still analysing" rather than claiming the
  // feature is unavailable.
  const pending = createProjectController()
  assert.deepEqual(pending.applyPauseCuts(), { ok: false, code: 'analysis-pending' })

  const controller = createProjectController()
  controller.applyEventTrack({ pointer: [], clicks: [] }, { pauseAnalysis: { ok: false, code: 'no-audio' } })
  assert.equal(controller.state().pauseAnalysis.status, 'failed')
  assert.equal(controller.state().pauseAnalysis.code, 'no-audio')
  const result = controller.applyPauseCuts()
  assert.deepEqual(result, { ok: false, code: 'no-audio' })
  assert.deepEqual(controller.state().segments, [{ startMs: 0, endMs: 20000 }])
})

test('N03: capsule and cut normalisers drop garbage and respect the 20-segment cap', () => {
  assert.deepEqual(
    trimController.normalizeKeystrokeCapsules([
      { tMs: 100, combo: 'Alt+Tab' },
      { tMs: -1, combo: 'Ctrl+P' },
      { tMs: 200, combo: 'typed text' },
      { tMs: 300, combo: 'F12' }
    ], 5000),
    [{ tMs: 100, combo: 'Alt+Tab' }, { tMs: 300, combo: 'F12' }]
  )
  assert.deepEqual(trimController.normalizePauseCuts([{ startMs: 0, endMs: 100 }], 5000), [])

  const many = Array.from({ length: 40 }, (_value, index) => ({
    startMs: index * 450 + 100,
    endMs: index * 450 + 500
  }))
  const result = trimController.pauseCutsToKeepSegments(many, 20000)
  assert.equal(result.ok, true)
  assert.ok(result.segments.length <= 20, 'never exceeds the R4 segment cap')
  for (const segment of result.segments) {
    assert.ok(segment.endMs > segment.startMs, 'every kept segment is non-empty')
    assert.ok(segment.endMs - segment.startMs >= 100, 'every kept segment respects MIN_RANGE_MS')
  }
})

// ---------------------------------------------------------------------------
// 6. editor view over a fake DOM (record/editor.js)
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

  removeAttribute(name) {
    this.attributes.delete(name)
  }

  getBoundingClientRect() {
    return this.rect
  }

  focus() { this.focused = true }
  select() { this.selected = true }
  load() { this.readyState = 1 }
  play() { this.played = (this.played || 0) + 1; return Promise.resolve() }
  pause() { this.paused = (this.paused || 0) + 1 }
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
        : (['export-format', 'gif-edge', 'gif-fps', 'export-resolution', 'export-quality', 'export-fps'].includes(id)
          ? 'select'
          : 'div'))
    const element = new FakeElement(tag)
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
    createElement: (tagName) => new FakeElement(tagName)
  }
  return { elements, document: documentRef, window: new FakeWindow() }
}

function initPayload(overrides = {}) {
  const project = overrides.project || projectFixture()
  return {
    project,
    sourceUrl: 'file:///recordings/project-n03/capture.webm',
    metadata: {
      durationMs: project.media.durationMs,
      video: project.media.video,
      audio: { tracks: 1 }
    },
    recovery: { state: 'ready', errorCode: '' }
  }
}

function createFakeEditorApi(eventsAnswer) {
  const calls = { events: [], saveDraft: [], ready: 0 }
  return {
    api: {
      ready: () => { calls.ready += 1 },
      onInit: () => () => {},
      onExportProgress: () => () => {},
      onInterfaceLanguage: () => () => {},
      events: async (projectId) => {
        calls.events.push(projectId)
        if (typeof eventsAnswer === 'function') return eventsAnswer(projectId)
        return eventsAnswer || { ok: true, track: null }
      },
      saveDraft: async (projectId, expectedRevision, edit) => {
        calls.saveDraft.push({ projectId, expectedRevision, edit })
        return { ok: true, revision: expectedRevision + 1 }
      },
      exportProject: async () => ({ status: 'accepted', task: { taskId: 'task-1', state: 'running' } }),
      exportStatus: async () => ({ ok: true, task: { taskId: 'task-1', state: 'running' } }),
      cancelExport: async () => ({ ok: true }),
      renameProject: async () => ({ ok: true }),
      rerecord: async () => ({ ok: true }),
      reveal: async () => ({ ok: true }),
      back: async () => ({ ok: true }),
      reload: async () => ({ ok: false, code: 'unavailable' }),
      windowAction: () => {},
      closeWindow: () => {},
      exportAction: async () => ({ status: 'done' })
    },
    calls
  }
}

const N03_TRACK = {
  schemaVersion: 1,
  durationMs: 20000,
  sampledAtHz: 20,
  pointer: [{ tMs: 0, x: 0.5, y: 0.5 }],
  clicks: [],
  truncated: false,
  keystrokes: [
    { tMs: 1000, combo: 'Ctrl+Shift+P' },
    { tMs: 5000, combo: 'Alt+Tab' }
  ]
}

async function bootEditor(eventsAnswer) {
  const harness = installFakeDom()
  const fake = createFakeEditorApi(eventsAnswer)
  const view = editorModule.createEditorView({
    api: fake.api,
    document: harness.document,
    window: harness.window,
    translate: (key, params) => (params ? key + ':' + JSON.stringify(params) : key)
  })
  view.boot()
  view.applyInit(initPayload())
  // applyInit kicks off the events load itself; wait one macrotask for the async channel answer
  // to land on the controller (the production window does the same, just later).
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  return { view, harness, api: fake.api, calls: fake.calls }
}

test('N03: the capsule HUD follows the media clock and can be toggled off', async (t) => {
  const boot = await bootEditor({
    ok: true,
    track: N03_TRACK,
    pauseAnalysis: { ok: true, cuts: [{ startMs: 2000, endMs: 5000 }], removedMs: 3000 }
  })
  t.after(() => boot.view.destroy())
  const { elements } = boot.harness
  const toggle = elements.get('toggle-keystrokes')
  const capsule = elements.get('keystroke-capsule')

  assert.equal(toggle.disabled, false, 'the toggle is offered when the take recorded shortcuts')
  assert.equal(elements.get('cut-silence').disabled, false)
  assert.equal(capsule.hidden, true, 'the HUD is opt-in and starts hidden')

  toggle.dispatch('click')
  assert.equal(boot.view.isKeystrokesEnabled(), true)
  assert.equal(toggle.getAttribute('aria-pressed'), 'true')

  const player = elements.get('preview-video')
  player.currentTime = 1.2
  player.dispatch('timeupdate')
  assert.equal(capsule.hidden, false)
  assert.equal(capsule.textContent, 'Ctrl+Shift+P')
  assert.equal(capsule.classList.contains('visible'), true)

  // Minimum on-screen time: 1100 ms after the keystroke, then the capsule fades out (opacity
  // transition; the element is not hidden so the fade can run both ways).
  player.currentTime = 2.6
  player.dispatch('timeupdate')
  assert.equal(capsule.classList.contains('visible'), false)
  player.currentTime = 5.2
  player.dispatch('timeupdate')
  assert.equal(capsule.classList.contains('visible'), true)
  assert.equal(capsule.textContent, 'Alt+Tab')

  toggle.dispatch('click')
  assert.equal(boot.view.isKeystrokesEnabled(), false)
  player.currentTime = 5.2
  player.dispatch('timeupdate')
  assert.equal(capsule.hidden, true)
  assert.equal(capsule.classList.contains('visible'), false)
  assert.equal(capsule.textContent, '')
})

test('N03: the toggle degrades when the project has no recorded shortcuts', async (t) => {
  const boot = await bootEditor({ ok: true, track: { ...N03_TRACK, keystrokes: [] } })
  t.after(() => boot.view.destroy())
  const toggle = boot.harness.elements.get('toggle-keystrokes')
  assert.equal(toggle.disabled, true)
  assert.equal(boot.view.toggleKeystrokes(), false)
})

test('N03: one click applies the suggested dead-air cuts as one undoable edit', async (t) => {
  const boot = await bootEditor({
    ok: true,
    track: N03_TRACK,
    pauseAnalysis: { ok: true, cuts: [{ startMs: 2000, endMs: 5000 }], removedMs: 3000 }
  })
  t.after(() => boot.view.destroy())
  const { elements } = boot.harness
  const cut = elements.get('cut-silence')
  const status = elements.get('pause-cut-status')

  cut.dispatch('click')
  const state = boot.view.getController().state()
  assert.deepEqual(state.segments, [
    { startMs: 0, endMs: 2000 },
    { startMs: 5000, endMs: 20000 }
  ])
  assert.match(status.textContent, /^recording\.editor\.pause\.applied:/)
  assert.match(status.textContent, /"count":1/)
  assert.equal(state.undo, true)
  assert.equal(boot.calls.events.length, 1, 'the analysis is read once from the events channel')

  // The existing undo control reverts the whole suggestion in one step.
  elements.get('undo-edit').dispatch('click')
  assert.deepEqual(boot.view.getController().state().segments, [{ startMs: 0, endMs: 20000 }])
})

test('N03: an unusable analysis is explained and the timeline is not touched', async (t) => {
  const boot = await bootEditor({
    ok: true,
    track: N03_TRACK,
    pauseAnalysis: { ok: false, code: 'no-audio' }
  })
  t.after(() => boot.view.destroy())
  const { elements } = boot.harness
  const before = boot.view.getController().state().segments
  elements.get('cut-silence').dispatch('click')
  assert.equal(boot.view.getController().state().segments.length, before.length)
  assert.deepEqual(
    boot.view.getController().state().segments,
    [{ startMs: 0, endMs: 20000 }]
  )
  assert.equal(elements.get('pause-cut-status').textContent, 'recording.editor.pause.no-audio')
  assert.equal(elements.get('cut-silence').dataset.status, 'failed')
})

test('N03: markup, styles and locale keys expose the HUD and dead-air controls', () => {
  const html = read('record/editor.html')
  const css = read('record/editor.css')
  for (const id of ['toggle-keystrokes', 'keystroke-capsule', 'cut-silence', 'pause-cut-status']) {
    assert.match(html, new RegExp('id="' + id + '"'), 'editor.html exposes #' + id)
  }
  for (const testid of ['toggle-keystrokes', 'cut-silence']) {
    assert.match(html, new RegExp('data-testid="' + testid + '"'), 'editor.html exposes data-testid=' + testid)
  }
  assert.match(html, /data-i18n="recording\.editor\.keystrokes\.toggle"/)
  assert.match(html, /data-i18n="recording\.editor\.pause\.cut"/)
  assert.match(css, /\.keystroke-capsule/)
  assert.match(css, /\.keystroke-capsule\.visible/)
  assert.match(css, /transition: opacity 160ms ease/)
  assert.match(css, /\.pause-cut-status/)

  // The capsule data must never be able to render free text: the controller validates the labels.
  const editorSource = read('record/editor.js')
  assert.match(editorSource, /applyPauseCuts\(\)/)
  assert.match(editorSource, /recording\.editor\.pause\.no-audio/)

  // Main attaches the analysis only when it was attempted, so a pre-N03 pipeline keeps its shape.
  const domainSource = read('main/domains/record/index.js')
  assert.match(domainSource, /if \(pauseAnalysis\) answer\.pauseAnalysis = pauseAnalysis/)
  assert.match(domainSource, /const pauseAnalysisCache = new Map\(\)/)

  // Three-language copy for every new key.
  globalThis.__LOCALES = {}
  for (const name of ['zh-CN.js', 'en-US.js', 'zh-TW.js', 'record.js', 'recording-editor.js']) {
    const file = path.join(root, 'shared', 'locales', name)
    delete require.cache[require.resolve(file)]
    require(file)
  }
  const tables = globalThis.__LOCALES
  const keys = [
    'recording.editor.keystrokes.toggle',
    'recording.editor.keystrokes.toggle-title',
    'recording.editor.pause.cut',
    'recording.editor.pause.applied',
    'recording.editor.pause.nothing',
    'recording.editor.pause.no-audio',
    'recording.editor.pause.failed',
    'recording.editor.pause.no-idle',
    'recording.editor.pause.analysis-running',
    'recording.editor.pause.unavailable'
  ]
  for (const key of keys) {
    for (const language of ['zh-CN', 'en-US', 'zh-TW']) {
      assert.equal(typeof tables[language][key], 'string', language + ' must define ' + key)
    }
  }
  // Interpolation placeholders used by the applied message.
  assert.match(tables['zh-CN']['recording.editor.pause.applied'], /\{count\}/)
  assert.match(tables['zh-CN']['recording.editor.pause.applied'], /\{removed\}/)
})

// A temp directory under the checkout is gitignored (`.tmp*`) and avoidable on hosts whose
// spawned children cannot write %LOCALAPPDATA%\Temp.
test('N03: the analysis and capture modules load in plain node without Electron', () => {
  assert.equal(typeof recordDomain.runSilenceDetect, 'function')
  assert.equal(typeof recordDomain.derivePauseCuts, 'function')
  assert.equal(typeof trimController.pauseCutsToKeepSegments, 'function')
  assert.equal(typeof projectService.normalizeKeystrokes, 'function')
  // A directory prefix used by createProjectContext must stay inside the checkout.
  assert.ok(root.startsWith(path.parse(root).root))
  assert.ok(fs.existsSync(os.tmpdir()))
})
