'use strict'

// R2 compact control bar (contract §12): the recording window's markup, the IPC
// surface it drives and the command arbitration that ties buttons, tray and
// shortcuts together. Pure state/sequence helpers are behaviour-tested in
// test/recording-utils.test.js and test/audio-mixer.test.js; this file pins the
// window-level contract that composes them.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const {
  createCommandDispatcher,
  createRequestId,
  localStateForWireStatus,
  shouldAdoptMainState
} = require('../record/recording-utils')

const root = path.join(__dirname, '..')
// Normalise line endings: these contract tests match exact source text, including
// the '\n' inside multi-line patterns. This checkout has core.autocrlf=true and no
// .gitattributes, so a fresh Windows CI checkout hands over CRLF and those patterns
// silently stop matching - which is how the two assertions below stayed red on CI
// after the R5 commit without ever failing locally.
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8').replace(/\r\n/g, '\n')

const html = read('record/record.html')
const css = read('record/record.css')
const script = read('record/record.js')
const preload = read('preload-record.js')

// ---------------------------------------------------------------------------
// markup + stylesheet
// ---------------------------------------------------------------------------

test('the control bar exposes the compact structure and the E2E test hooks', () => {
  for (const id of [
    'controlView', 'time', 'statusLabel', 'windowTitle', 'fps', 'countdown',
    'micMute', 'start', 'pause', 'stop', 'cancel',
    'moreToggle', 'morePanel', 'moreBack', 'abandon',
    'discardConfirm', 'discardConfirmYes', 'discardConfirmNo',
    'annotationTools', 'annotationStyle', 'annotationPalette', 'annotationUndo', 'annotationClear',
    'volumeGroup', 'volumeSystem', 'volumeMic', 'volumeMicRow',
    'recordError', 'saveProgress'
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `record.html exposes #${id}`)
  }
  // Stable Playwright hooks requested for the E2E happy path.
  for (const testId of [
    'control-bar', 'timer', 'status-label', 'start-record', 'pause-resume',
    'finish-record', 'mic-mute', 'more-toggle', 'more-panel', 'abandon-record',
    'annotation-tools', 'countdown', 'error-text', 'window-title'
  ]) {
    assert.match(html, new RegExp(`data-testid="${testId}"`), `record.html exposes data-testid=${testId}`)
  }
  // The actions are real <button> elements, not click-handled divs.
  for (const testId of ['start-record', 'pause-resume', 'finish-record', 'mic-mute', 'more-toggle', 'abandon-record']) {
    assert.match(html, new RegExp(`<button[^>]*data-testid="${testId}"`), `#${testId} must be a real button`)
  }
  // The existing annotation tool set is kept verbatim inside the "more" overflow.
  for (const tool of ['pointer', 'pen', 'rect', 'ellipse', 'arrow']) {
    assert.match(html, new RegExp(`data-annotation-tool="${tool}"`))
  }
  for (const color of ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#1687ff', '#111111', '#ffffff']) {
    assert.match(html, new RegExp(`data-annotation-color="${color}"`))
  }
  for (const width of [2, 4, 7]) assert.match(html, new RegExp(`data-annotation-width="${width}"`))
  // Dependency order: shared quality table and annotation/media helpers first.
  assert.match(html, /shared\/recording-quality\.js[\s\S]*annotation-utils\.js[\s\S]*recording-utils\.js[\s\S]*audio-mixer\.js[\s\S]*record\.js/)
  // Countdown is present but empty/hidden until the state machine shows it.
  assert.match(html, /<strong id="countdown"[^>]*hidden><\/strong>/)
})

test('the preview, trim and save-MP4 surface is gone from the control window', () => {
  for (const id of [
    'previewView', 'preview', 'previewDuration', 'saveMp4', 'rerecord', 'closePreview',
    'trimPanel', 'trimExport', 'trimProgress', 'recordResultBar'
  ]) {
    assert.doesNotMatch(html, new RegExp(`id="${id}"`), `record.html must not expose #${id}`)
  }
  assert.doesNotMatch(html, /trim-controller\.js/)
  assert.doesNotMatch(html, /trim-view\.js/)
  assert.doesNotMatch(html, /shared\/recording-export-options\.js/)
  assert.doesNotMatch(script, /previewView|trimView|saveMp4|rerecord|previewDuration|recordTrimView/)
  assert.doesNotMatch(css, /\.preview-view|\.trim-panel|\.video-stage|\.record-result-bar/)
})

test('the compact bar keeps the responsive/notification styles it needs', () => {
  assert.match(css, /\.control-view\{[^}]*display:flex/)
  assert.match(css, /body\[data-state="recording"\] \.status-dot\{[^}]*animation:pulse/)
  assert.match(css, /body\[data-state="paused"\] \.status-dot\{[^}]*var\(--yellow\)/)
  assert.match(css, /@media\s*\(max-width:699px\)/)
  // The "more" overflow and the discard confirmation are overlays inside the fixed
  // 86px window, so opening them cannot grow outside the capture-protected bounds.
  assert.match(css, /\.more-panel\{[^}]*position:absolute[^}]*inset:0/)
  assert.match(css, /\.discard-confirm\{[^}]*position:absolute[^}]*inset:0/)
  // The annotation palette still opens beside the tools instead of covering them.
  const paletteRule = /\.annotation-palette\{([^}]*)\}/.exec(css)
  assert.ok(paletteRule, 'the .annotation-palette rule must exist')
  assert.match(paletteRule[1], /left:calc\(100% \+ \d+px\)/)
  assert.match(paletteRule[1], /transform:translateY\(-50%\)/)
  assert.match(paletteRule[1], /width:auto/)
  assert.doesNotMatch(paletteRule[1], /left:50%/)
  assert.doesNotMatch(paletteRule[1], /translate\(-50%/)
  const toolsIndex = html.indexOf('data-annotation-tool="arrow"')
  const wrapIndex = html.indexOf('annotation-style-wrap')
  assert.ok(toolsIndex > 0 && wrapIndex > toolsIndex, 'the tools must precede the style wrapper')
})

test('record/** keeps all new copy in shared/locales (only the legacy comment remains)', () => {
  // The pre-existing reviewer comment in record.js is the only CJK line the record
  // area is allowed to keep; every other line must resolve through the locale tables.
  const cjk = /[\u4e00-\u9fff]/
  const legacyComment = '// 系统声也关着时已无任何音轨，不能照抄"仅保留系统声音"（文案必须与文件实际内容一致）。'
  const offenders = []
  for (const file of ['record/record.html', 'record/record.css', 'record/record.js']) {
    read(file).split(/\r?\n/).forEach((line, index) => {
      if (!cjk.test(line)) return
      if (file === 'record/record.js' && line.trim() === legacyComment) return
      offenders.push(`${file}:${index + 1}: ${line.trim()}`)
    })
  }
  assert.deepEqual(offenders, [], 'new record/** copy must live in shared/locales/record.js')
  // The allowance must still point at a real line (a stale entry would hide a new one).
  assert.ok(read('record/record.js').includes(legacyComment), 'stale legacy CJK allowance')
})

test('every string in the control bar resolves through the locale tables', () => {
  require('../shared/locales/record')
  const tables = globalThis.__LOCALES
  const languages = ['zh-CN', 'en-US', 'zh-TW']
  for (const language of languages) assert.ok(tables?.[language], `missing locale table ${language}`)

  const usedKeys = [...html.matchAll(/data-i18n(?:-title|-aria-label|-placeholder)?="([^"]+)"/g)]
    .map((match) => match[1])
  assert.ok(usedKeys.length >= 25, `expected the bar to use i18n keys, found ${usedKeys.length}`)
  for (const key of usedKeys) {
    for (const language of languages) {
      assert.equal(typeof tables[language][key], 'string', `${key} is missing from ${language}`)
    }
  }

  // Dynamic copy (state labels, notices, tooltips) is resolved from t() at render
  // time; the literals in record.js must also exist in all three tables.
  const scriptKeys = new Set(
    [...script.matchAll(/'((?:record)\.[a-z0-9-]+(?:\.[a-z0-9-]+)+)'/g)].map((match) => match[1])
  )
  assert.ok(scriptKeys.size >= 12)
  for (const key of scriptKeys) {
    for (const language of languages) {
      assert.equal(typeof tables[language][key], 'string', `${key} (used by record.js) is missing from ${language}`)
    }
  }
})

// ---------------------------------------------------------------------------
// renderer contract
// ---------------------------------------------------------------------------

test('the renderer keeps the capture/compositing pipeline intact', () => {
  assert.match(script, /canvas\.captureStream\(frameRate\)/)
  assert.match(script, /requestVideoFrameCallback/)
  assert.match(script, /createFramePacer\(frameRate\)/)
  assert.match(script, /video\/webm/)
  assert.match(script, /calculateCropRect\(/)
  assert.match(script, /getDisplayMedia/)
  assert.match(script, /reportPerformance/)
  assert.match(script, /drawAnnotationSnapshot\(context/)
  assert.match(script, /onAnnotationSnapshot/)
  assert.match(script, /setAnnotationCommand/)
})

test('the renderer applies the quality profile and the configured countdown', () => {
  assert.match(script, /window\.recordingQuality/)
  assert.match(script, /qualityBitsPerSecond\(quality\)/)
  assert.match(script, /videoBitsPerSecond/)
  assert.match(script, /normalizeQuality\(/)
  assert.match(script, /normalizeCountdown\(/)
  assert.match(script, /for \(let value = seconds; value >= 1; value--\)/)
  // Countdown 0 must be a real branch, not a 3-second default in disguise.
  assert.match(script, /countdownSeconds/)
  assert.match(script, /setState\(transitionRecordingState\('preparing', 'ready'\)\)/)
})

test('the renderer sequences chunks, checks ACKs and refuses to fake a healthy take', () => {
  assert.match(script, /chunkSequence \+= 1/)
  assert.match(script, /appendChunk\(sessionId, arrayBuffer, chunk\.sequence, chunk\.bytes\)/)
  assert.match(script, /classifyChunkAck\(/)
  assert.match(script, /appendQueue = appendQueue/)
  assert.match(script, /failChunkStream/)
  assert.match(script, /record\.notice\.chunk-failed-retry/)
  assert.match(script, /transitionRecordingState\('recording', 'error'\)/)
  // Stopping waits for every pending chunk before main is asked to seal the project.
  // R5 adds the wall-clock timing payload as the second argument, so match the call
  // prefix rather than the full no-arg form.
  const flushIndex = script.indexOf('await appendQueue.catch')
  const finishIndex = script.indexOf('window.recordAPI.finishSession(sessionId')
  assert.ok(flushIndex > 0, 'finish must await the append queue')
  assert.ok(finishIndex > flushIndex, 'finish-session must run after the append queue flushes')
})

test('the renderer reports state and accepts pushed commands through one path', () => {
  assert.match(script, /createCommandDispatcher\(/)
  assert.match(script, /function applyCommand\(/)
  assert.match(script, /onCommand\(/)
  assert.match(script, /reportCommandResult\(/)
  assert.match(script, /recordAPI\.reportState\(\{[\s\S]*?sessionId,[\s\S]*?status,[\s\S]*?elapsedMs:[\s\S]*?microphoneMuted,[\s\S]*?stateVersion/)
  assert.match(script, /'set-microphone-muted'/)
  assert.match(script, /setMicrophoneMuted\(/)
  assert.match(script, /setBusGain\?\./)
  // A microphone that never captured must not expose a recoverable "muted" state.
  assert.match(script, /micMuteButton\.hidden = !captured/)
})

test('finish shows a finalizing state and discarding is confirmed first', () => {
  assert.match(script, /record\.status\.finalizing/)
  assert.match(script, /transitionRecordingState\('finalizing', 'finished'\)/)
  assert.match(script, /transitionRecordingState\('finalizing', 'failed'\)/)
  // Finishing never navigates: the main process opens the editor and closes this window.
  assert.doesNotMatch(script, /window\.location/)
  assert.match(script, /openDiscardConfirm/)
  assert.match(script, /discardConfirm\.hidden = false/)
  assert.match(script, /cancelSession\(sessionId\)/)
  // Shared settings stay respected while recording: system sound off drops loopback.
  assert.match(script, /!audioRequest\.system && desktopStream/)
})

test('the E2E synthetic capture source is gated, documented and default-off', () => {
  assert.match(script, /E2E-only synthetic capture source/)
  assert.match(script, /initData\.fakeCapture === true/)
  assert.match(script, /fakeCapture \? createFakeDesktopStream\(\) : await acquireDesktopStream\(\)/)
  assert.match(script, /function createFakeDesktopStream\(\)/)
  assert.match(script, /captureStream\(initData\.frameRate\)/)
  assert.match(script, /function createFakeAudioBus\(/)
  // The hook can only arrive through record:init: the renderer has no other input
  // channel (URL, storage, query string) that could switch the real capture off.
  assert.doesNotMatch(script, /location\.search|URLSearchParams|localStorage/)
  assert.match(script, /fakeCapture = initData\.fakeCapture === true/)
})

test('preload exposes the new command/state/chunk channels and keeps the legacy surface', () => {
  for (const channel of [
    'record:command',
    'record:state',
    'record:state-changed',
    'record:command-result',
    'record:get-state',
    'record:source-lost',
    'record:append-chunk',
    'record:finish-session',
    'record:cancel-session',
    'record:start-session'
  ]) {
    assert.match(preload, new RegExp(channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  assert.match(preload, /onCommand: \(callback\) => subscribe\('record:command'/)
  assert.match(preload, /reportState: \(state\)/)
  assert.match(preload, /reportCommandResult: \(result\)/)
  assert.match(preload, /getState: \(\) => ipcRenderer\.invoke\('record:get-state'/)
  assert.match(preload, /onStateChanged: \(callback\) => subscribe\('record:state-changed'/)
  assert.match(preload, /onSourceLost: \(callback\) => subscribe\('record:source-lost'/)
  assert.match(preload, /appendChunk: \(sessionId, arrayBuffer, sequence, bytes\)/)
  assert.match(preload, /finishSession: \(sessionId, timing\) =>/)
  // Retained channels (contract §9.2: keep the old surface; no new UI entry).
  for (const method of ['ready:', 'onInit:', 'setFrameState:', 'setAnnotationCommand:', 'reportPerformance:', 'close:']) {
    assert.match(preload, new RegExp(method))
  }
})

// R5 demo-enhancement timing: preload must forward the control bar's wall-clock capture
// timing on record:finish-session. The bridge is a classic preload (not require-able in
// Node), so extract the shipped arrow and execute it against a fake ipcRenderer.
function extractPreloadFinishSession(ipcRenderer) {
  const marker = 'finishSession: (sessionId, timing) =>'
  const start = preload.indexOf(marker)
  assert.ok(start >= 0, 'preload-record.js must expose finishSession(sessionId, timing)')
  const paramsStart = start + 'finishSession: '.length
  const payloadStart = preload.indexOf('{', paramsStart)
  assert.ok(payloadStart > paramsStart, 'finishSession must build an object payload')
  let depth = 0
  let payloadEnd = -1
  for (let index = payloadStart; index < preload.length; index += 1) {
    if (preload[index] === '{') depth += 1
    else if (preload[index] === '}') {
      depth -= 1
      if (depth === 0) {
        payloadEnd = index + 1
        break
      }
    }
  }
  assert.ok(payloadEnd > payloadStart, 'could not extract the finishSession payload')
  // The invoke call's closing parenthesis follows the payload object.
  const expression = preload.slice(paramsStart, payloadEnd + 1).trim()
  return vm.runInNewContext(`(${expression})`, { ipcRenderer })
}

test('finishSession forwards the R5 wall-clock timing payload verbatim', async () => {
  const calls = []
  const finishSession = extractPreloadFinishSession({
    invoke: (channel, payload) => {
      calls.push({ channel, payload })
      return Promise.resolve({ ok: true, projectId: 'project-1' })
    }
  })
  assert.equal(typeof finishSession, 'function')
  // Objects built inside the vm realm have a different prototype; compare their JSON form.
  const lastCall = () => JSON.parse(JSON.stringify(calls.at(-1)))

  // Pre-R5 call shape stays byte-compatible: no timing means no extra keys at all.
  await finishSession('session-1')
  assert.deepEqual(lastCall(), { channel: 'record:finish-session', payload: { sessionId: 'session-1' } })

  // The frozen R5 shape reaches the domain unchanged, including interval order/values.
  const timing = {
    mediaStartedAtWall: 1_730_000_000_123,
    pausedIntervals: [{ startWall: 1_730_000_001_000, endWall: 1_730_000_002_500 }]
  }
  await finishSession('session-2', timing)
  assert.deepEqual(lastCall(), {
    channel: 'record:finish-session',
    payload: {
      sessionId: 'session-2',
      mediaStartedAtWall: 1_730_000_000_123,
      pausedIntervals: [{ startWall: 1_730_000_001_000, endWall: 1_730_000_002_500 }]
    }
  })

  // Junk timing degrades to a zero start and no pauses instead of crashing the bridge.
  await finishSession('session-3', { mediaStartedAtWall: 'nope', pausedIntervals: 'bad' })
  assert.deepEqual(lastCall(), {
    channel: 'record:finish-session',
    payload: { sessionId: 'session-3', mediaStartedAtWall: 0, pausedIntervals: [] }
  })
  await finishSession('session-4', null)
  assert.deepEqual(lastCall(), { channel: 'record:finish-session', payload: { sessionId: 'session-4' } })
  await finishSession('session-5', 'timing')
  assert.deepEqual(lastCall(), { channel: 'record:finish-session', payload: { sessionId: 'session-5' } })
})

test('the renderer pulls a reconciled state on boot and subscribes to the post-command echo', () => {
  assert.match(script, /shouldAdoptMainState\(/)
  assert.match(script, /localStateForWireStatus\(mainState\.status\)/)
  assert.match(script, /reconcileStateFromMain\(\)\.catch/)
  assert.match(script, /recordAPI\.getState\(\)/)
  assert.match(script, /recordAPI\.onStateChanged\(/)
  // The adopted state is reflected, never echoed back (that would ping-pong versions).
  assert.match(script, /suppressStateReport = true[\s\S]{0,120}setState\(nextState\)/)
  assert.match(script, /if \(!suppressStateReport\) reportState\(\)/)
  // A lost pause/resume command is repaired on the recorder, not just on the label.
  assert.match(script, /recorder\?\.state === 'recording'[\s\S]{0,120}recorder\.pause\(\)/)
  assert.match(script, /recorder\?\.state === 'paused'[\s\S]{0,120}recorder\.resume\(\)/)
})

// ---------------------------------------------------------------------------
// main-process state reconciliation behaviour (§9.2 stateVersion guard)
// ---------------------------------------------------------------------------

test('maps wire statuses onto the bar state machine and rejects unknown ones', () => {
  assert.equal(localStateForWireStatus('preparing'), 'preparing')
  assert.equal(localStateForWireStatus('countdown'), 'countdown')
  assert.equal(localStateForWireStatus('recording'), 'recording')
  assert.equal(localStateForWireStatus('paused'), 'paused')
  assert.equal(localStateForWireStatus('finalizing'), 'finalizing')
  for (const value of ['idle', 'finished', 'stopped', 'bogus', '', undefined, null, 7]) {
    assert.equal(localStateForWireStatus(value), '')
  }
})

test('adopts only a strictly newer main state (never rolls the bar back)', () => {
  const base = { localState: 'recording', localStateVersion: 5, busy: false }
  assert.equal(shouldAdoptMainState({
    ...base,
    mainState: { status: 'paused', stateVersion: 6 }
  }), true, 'a newer pause echo is adopted')
  assert.equal(shouldAdoptMainState({
    ...base,
    mainState: { status: 'recording', stateVersion: 7 }
  }), true, 'a newer recording echo is adopted')
  assert.equal(shouldAdoptMainState({
    ...base,
    mainState: { status: 'paused', stateVersion: 5 }
  }), false, 'an equal version is a stale echo')
  assert.equal(shouldAdoptMainState({
    ...base,
    mainState: { status: 'paused', stateVersion: 4 }
  }), false, 'an older version must not roll the bar back')
  for (const stateVersion of [0, -1, 1.5, Number.NaN, 'nope', undefined]) {
    assert.equal(shouldAdoptMainState({
      ...base,
      localStateVersion: -1,
      mainState: { status: 'paused', stateVersion }
    }), false, `stateVersion ${String(stateVersion)} is not a usable version`)
  }
})

test('never overwrites a busy bar or a locally driven transition', () => {
  const mainState = { status: 'paused', stateVersion: 9 }
  assert.equal(shouldAdoptMainState({
    mainState, localState: 'recording', localStateVersion: 1, busy: true
  }), false)
  for (const localState of ['preparing', 'countdown', 'finalizing']) {
    assert.equal(shouldAdoptMainState({
      mainState, localState, localStateVersion: 1, busy: false
    }), false, `${localState} is driven locally`)
  }
  // The echo path is for the live pause/resume pair only.
  for (const localState of ['idle', 'finished', 'stopped']) {
    assert.equal(shouldAdoptMainState({
      mainState, localState, localStateVersion: 1, busy: false
    }), false, `${localState} has no live capture to pause`)
  }
  assert.equal(shouldAdoptMainState({
    mainState: { status: 'finalizing', stateVersion: 9 },
    localState: 'recording',
    localStateVersion: 1,
    busy: false
  }), false, 'a finalizing echo cannot strand a live recorder')
})

test('boot reconciliation restores a live capture only while the bar is idle', () => {
  assert.equal(shouldAdoptMainState({
    mainState: { status: 'recording', stateVersion: 3 },
    localState: 'idle',
    localStateVersion: 0,
    busy: false,
    reconciliation: true
  }), true)
  assert.equal(shouldAdoptMainState({
    mainState: { status: 'paused', stateVersion: 3 },
    localState: 'idle',
    localStateVersion: 0,
    reconciliation: true
  }), true)
  assert.equal(shouldAdoptMainState({
    mainState: { status: 'finalizing', stateVersion: 3 },
    localState: 'idle',
    localStateVersion: 0,
    reconciliation: true
  }), true)
  // The main process' DEFAULT_STATE is "preparing v0": it means "nothing recorded yet".
  assert.equal(shouldAdoptMainState({
    mainState: { status: 'preparing', stateVersion: 0 },
    localState: 'idle',
    localStateVersion: 0,
    reconciliation: true
  }), false)
  assert.equal(shouldAdoptMainState({
    mainState: { status: 'preparing', stateVersion: 4 },
    localState: 'idle',
    localStateVersion: 0,
    reconciliation: true
  }), false, 'pre-capture states are locally driven')
  assert.equal(shouldAdoptMainState({
    mainState: { status: 'paused', stateVersion: 4 },
    localState: 'idle',
    localStateVersion: 4,
    reconciliation: true
  }), false, 'the version guard also covers the pull')
  assert.equal(shouldAdoptMainState({
    mainState: { status: 'paused', stateVersion: 4 },
    localState: 'recording',
    localStateVersion: 2,
    reconciliation: true
  }), false, 'reconciliation never overwrites a live local flow')
  // Malformed pulls are ignored instead of throwing in the boot path.
  assert.equal(shouldAdoptMainState({ mainState: null, localState: 'idle', reconciliation: true }), false)
  assert.equal(shouldAdoptMainState({ localState: 'idle', reconciliation: true }), false)
})

// ---------------------------------------------------------------------------
// command arbitration behaviour
// ---------------------------------------------------------------------------

test('the command dispatcher runs a duplicate requestId exactly once', async () => {
  const calls = []
  const dispatcher = createCommandDispatcher({
    handlers: {
      pause: async (value, command) => {
        calls.push([command, value])
        return { ok: true, state: { status: 'paused', stateVersion: 1 }, code: '' }
      },
      'set-microphone-muted': (value, command) => {
        calls.push([command, value])
        return { ok: true, state: { status: 'recording', microphoneMuted: value }, code: '' }
      }
    }
  })

  const first = dispatcher.dispatch({ requestId: 'req-1', command: 'pause' })
  const duplicate = dispatcher.dispatch({ requestId: 'req-1', command: 'pause' })
  assert.equal(first, duplicate, 'a repeated requestId must return the same in-flight result')
  const [left, right] = await Promise.all([first, duplicate])
  assert.deepEqual(left, right)
  assert.equal(calls.length, 1, 'the handler must not run twice for one requestId')

  const muted = await dispatcher.dispatch({ requestId: 'req-2', command: 'set-microphone-muted', value: true })
  assert.equal(muted.ok, true)
  assert.equal(muted.state.microphoneMuted, true)
  assert.deepEqual(calls, [['pause', undefined], ['set-microphone-muted', true]])
})

test('the command dispatcher rejects malformed, unsupported and throwing requests', async () => {
  const dispatcher = createCommandDispatcher({
    handlers: {
      explode: () => { throw new Error('boom') },
      rejects: () => Promise.reject(new Error('nope')),
      plain: () => 'not-an-object'
    }
  })
  assert.deepEqual(await dispatcher.dispatch({ command: 'pause' }), { ok: false, code: 'invalid-request' })
  assert.deepEqual(await dispatcher.dispatch({ requestId: 'r-1' }), { ok: false, code: 'unsupported-command' })
  assert.deepEqual(
    await dispatcher.dispatch({ requestId: 'r-2', command: 'explode' }),
    { ok: false, code: 'command-failed', detail: 'boom' }
  )
  assert.deepEqual(
    await dispatcher.dispatch({ requestId: 'r-3', command: 'rejects' }),
    { ok: false, code: 'command-failed' }
  )
  assert.deepEqual(await dispatcher.dispatch({ requestId: 'r-4', command: 'plain' }), { ok: true })
})

test('the command dispatcher keeps its dedupe memory bounded', async () => {
  const dispatcher = createCommandDispatcher({
    maxRemembered: 2,
    handlers: { pause: () => ({ ok: true }) }
  })
  await dispatcher.dispatch({ requestId: 'a', command: 'pause' })
  await dispatcher.dispatch({ requestId: 'b', command: 'pause' })
  assert.equal(dispatcher.size(), 2)
  await dispatcher.dispatch({ requestId: 'c', command: 'pause' })
  assert.equal(dispatcher.size(), 2)
  assert.equal(dispatcher.has('a'), false, 'the oldest request id is evicted')
  assert.equal(dispatcher.has('c'), true)
})

test('local request ids are unique and prefixed for the log trail', () => {
  const ids = new Set(Array.from({ length: 50 }, () => createRequestId('button')))
  assert.equal(ids.size, 50)
  for (const id of ids) assert.match(id, /^button-[a-z0-9]+-[a-z0-9]+$/)
  assert.match(createRequestId(), /^local-/)
})

// ---------------------------------------------------------------------------
// R4 window mode (contract §2.2/§2.4)
// ---------------------------------------------------------------------------

// The module is a classic <script> (not require-able), so the shipped pure helper is
// extracted from its source and executed for real: this tests the implementation that
// ships, not a copy, without touching the W8-owned recording-utils module.
function extractFunction(name) {
  const marker = `function ${name}(`
  const start = script.indexOf(marker)
  assert.ok(start >= 0, `record.js must define ${name}`)
  let depth = 0
  let end = -1
  for (let index = script.indexOf('{', start); index < script.length; index += 1) {
    if (script[index] === '{') depth += 1
    else if (script[index] === '}') {
      depth -= 1
      if (depth === 0) {
        end = index + 1
        break
      }
    }
  }
  assert.ok(end > start, `could not extract ${name}`)
  return script.slice(start, end)
}

const fitContainRect = vm.runInNewContext(`(${extractFunction('fitContainRect')})`)

test('contain-fit maths letterboxes the frozen canvas without changing the aspect ratio', () => {
  const same = fitContainRect(1920, 1080, 1280, 720)
  assert.deepEqual({ x: same.x, y: same.y, width: same.width, height: same.height }, { x: 0, y: 0, width: 1280, height: 720 })
  assert.ok(Math.abs(same.scale - 2 / 3) < 1e-9)

  // 16:9 source in a square canvas -> top/bottom bars.
  const square = fitContainRect(1920, 1080, 640, 640)
  assert.deepEqual({ x: square.x, y: square.y, width: square.width, height: square.height }, { x: 0, y: 140, width: 640, height: 360 })

  // 4:3 source in a 16:9 canvas -> left/right bars.
  const sides = fitContainRect(640, 480, 1280, 720)
  assert.deepEqual({ x: sides.x, y: sides.y, width: sides.width, height: sides.height }, { x: 160, y: 0, width: 960, height: 720 })

  // Tall window into a wide canvas -> centred with bars on both sides.
  const tall = fitContainRect(720, 1600, 1280, 720)
  assert.deepEqual({ x: tall.x, y: tall.y, width: tall.width, height: tall.height }, { x: 478, y: 0, width: 324, height: 720 })

  // Degenerate inputs stay safe (never a zero-size or NaN draw). The helper runs in a
  // separate vm realm, so compare its fields instead of the object identity.
  const plain = (fit) => ({ x: fit.x, y: fit.y, width: fit.width, height: fit.height, scale: fit.scale })
  assert.deepEqual(plain(fitContainRect(0, 0, 0, 0)), { x: 0, y: 0, width: 1, height: 1, scale: 1 })
  // A junk frame size collapses to 1x1, which simply scales up inside the canvas.
  assert.deepEqual(plain(fitContainRect(Number.NaN, 'x', 100, 50)), { x: 25, y: 0, width: 50, height: 50, scale: 50 })

  // Invariants across aspect ratios: one axis fills exactly, the other is centred with
  // integer edges, and the draw never leaves the canvas.
  const cases = [
    [1920, 1080, 1280, 720], [1280, 720, 640, 640], [800, 600, 1920, 1080],
    [100, 100, 1920, 1080], [1366, 768, 1000, 1000], [3840, 2160, 1920, 1080],
    [300, 1000, 900, 300], [1918, 1078, 1280, 720]
  ]
  for (const [frameW, frameH, canvasW, canvasH] of cases) {
    const fit = fitContainRect(frameW, frameH, canvasW, canvasH)
    assert.ok(fit.width >= 1 && fit.height >= 1)
    assert.ok(fit.width <= canvasW && fit.height <= canvasH, `${frameW}x${frameH} into ${canvasW}x${canvasH}`)
    assert.ok(fit.x >= 0 && fit.y >= 0)
    assert.ok(Math.abs(fit.x * 2 + fit.width - canvasW) <= 1, 'horizontal centring')
    assert.ok(Math.abs(fit.y * 2 + fit.height - canvasH) <= 1, 'vertical centring')
    assert.ok(fit.width === canvasW || fit.height === canvasH, 'contain must fill one axis')
    assert.ok(Math.abs((fit.width / fit.height) - (frameW / frameH)) < 0.01, 'aspect ratio preserved')
  }
})

test('window mode has its own acquisition branch and a frozen contain canvas', () => {
  assert.match(script, /let captureMode = 'display'/)
  assert.match(script, /captureMode = initData\.mode === 'window' \? 'window' : 'display'/)
  // Window mode asks the main-process handler for the bound window track only: no
  // display constraints and no legacy desktop-source fallback.
  assert.match(script, /captureMode === 'window'[\s\S]{0,900}getDisplayMedia\(\{ video: true, audio: true \}\)/)
  assert.match(script, /captureMode === 'window'[\s\S]{0,900}getDisplayMedia\(\{ video: true, audio: false \}\)/)
  assert.match(script, /captureMode === 'window'[\s\S]{0,1600}throw failures\[0\]/)
  // Frozen output size from init.window.pixelSize, frames fitted with 'contain'.
  assert.match(script, /normalizeWindowPixelSize\(windowInfo\?\.pixelSize\)/)
  assert.match(script, /canvas\.width = Math\.max\(2, width - \(width % 2\)\)/)
  assert.match(script, /canvas\._recordFit = fitContainRect\(sourceVideo\.videoWidth, sourceVideo\.videoHeight, canvas\.width, canvas\.height\)/)
  assert.match(script, /context\.fillStyle = '#000000'/)
  // Display/region keep the existing crop path untouched.
  assert.match(script, /canvas\._recordCrop = crop/)
  assert.match(script, /calculateCropRect\(/)
})

test('window mode shows the target window title and skips the frame overlay IPC', () => {
  assert.match(html, /id="windowTitle"[^>]*data-testid="window-title"/)
  assert.match(html, /data-mode="display"/)
  assert.match(html, /data-annotation="on"/)
  assert.match(script, /record\.status\.window-idle/)
  assert.match(script, /renderWindowTitle\(\)/)
  assert.match(script, /record\.window\.target-label/)
  assert.match(script, /document\.body\.dataset\.mode = captureMode/)
  // Window captures never create the annotation frame window, so its IPC is skipped.
  assert.match(script, /function setFrameState\(frameState\) \{[\s\S]*?captureMode === 'window'[\s\S]*?Promise\.resolve\(true\)/)
  assert.match(script, /setFrameState\('hidden'\)/)
  assert.match(css, /\.status-copy \.window-title\{[^}]*text-overflow:ellipsis/)
})

test('annotation === false hides the entrance and blocks annotation output', () => {
  assert.match(script, /annotationAllowed = captureMode === 'window' \? data\.annotation === true : data\.annotation !== false/)
  assert.match(script, /annotationToolsElement\.hidden = !annotationAllowed/)
  assert.match(script, /document\.body\.dataset\.annotation = annotationAllowed \? 'on' : 'off'/)
  assert.match(script, /if \(!annotationAllowed\) return Promise\.resolve\(true\)/)
  assert.match(script, /if \(!annotationAllowed\) return\n  await sendAnnotationCommand\('reset'\)/)
  assert.match(script, /if \(annotationAllowed\) drawAnnotationSnapshot\(context/)
  // A snapshot that arrives after the mode is known must not draw or queue a frame.
  assert.match(script, /if \(!initData \|\| !annotationAllowed\) return/)
  assert.match(css, /body\[data-annotation="off"\] #annotationTools\{display:none!important\}/)
})

test('a lost or ended window source keeps the recording and seals it', () => {
  assert.match(script, /function handleSourceLost\(payload = \{\}\)/)
  assert.match(script, /sourceLostHandled/)
  // Live take -> the normal finish path (flush + finish-session) keeps the content.
  assert.match(script, /\['recording', 'paused'\]\.includes\(state\) && sessionId[\s\S]{0,400}finishRecording\(\)\.catch/)
  // Preparation/countdown -> back to ready, nothing to keep.
  assert.match(script, /function abortPreparingSource\(\)/)
  assert.match(script, /\['preparing', 'countdown'\]\.includes\(state\)[\s\S]{0,120}abortPreparingSource\(\)/)
  assert.match(script, /record\.warning\.source-lost/)
  // Renderer-side detection: video track ended is the same invalidation as the push.
  assert.match(script, /function handleVideoTrackEnded\(\) \{\n  handleSourceLost\(\{ reason: 'closed' \}\)/)
  assert.match(script, /addTrackListener\(track, 'ended', handleVideoTrackEnded\)/)
  // Watch/unwatch mirrors the acquisition lifetime.
  assert.match(script, /function watchSourceTracks\(\)/)
  assert.match(script, /function unwatchSourceTracks\(\)/)
  assert.match(script, /function stopSource\(\) \{\n  unwatchSourceTracks\(\)/)
  assert.match(script, /watchSourceTracks\(\)/)
})

test('a muted (hidden/minimized) window pauses the take; unmute only clears the warning', () => {
  assert.match(script, /function handleVideoTrackMute\(\)/)
  assert.match(script, /function handleVideoTrackUnmute\(\)/)
  assert.match(script, /state === 'recording'\) pauseRecording\(\)/)
  assert.match(script, /sourceHiddenWarning = true/)
  assert.match(script, /setFailureNotice\('record\.warning\.source-hidden'\)/)
  assert.match(script, /errorElement\.textContent = t\('record\.warning\.source-hidden'\)/)
  // Unmute only clears the warning; it never resumes on the user's behalf.
  assert.match(script, /function handleVideoTrackUnmute\(\) \{[\s\S]*?sourceHiddenWarning = false[\s\S]*?\}/)
  assert.doesNotMatch(
    script.slice(script.indexOf('function handleVideoTrackUnmute'), script.indexOf('function handleSourceLost')),
    /resumeRecording|recorder\.resume|startCompositeLoop/
  )
  // The warning copy is a locale key in all three languages.
  require('../shared/locales/record')
  for (const language of ['zh-CN', 'en-US', 'zh-TW']) {
    assert.equal(typeof globalThis.__LOCALES[language]['record.warning.source-hidden'], 'string')
    assert.equal(typeof globalThis.__LOCALES[language]['record.warning.source-lost'], 'string')
    assert.equal(typeof globalThis.__LOCALES[language]['record.status.window-idle'], 'string')
    assert.equal(typeof globalThis.__LOCALES[language]['record.window.target-label'], 'string')
  }
})

