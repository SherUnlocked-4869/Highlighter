'use strict'

// B04: the pure half of the pre-take sound check (shared/audio-preflight.js).
//
// The two windows that can reach a capture device (the workbench's microphone
// check and the recording bar's two-lane check) share this module, so the
// behaviour pinned here is the behaviour both surfaces get: when a device may be
// opened, how long a sample may run, what "silent" means and which prompt each
// device error turns into.
//
// Timing is injected (a fake clock), never slept through: every assertion below is
// deterministic and runs in milliseconds.

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  LANES,
  SAMPLE_BUDGET_MS,
  SAMPLE_INTERVAL_MS,
  RELEASE_BUDGET_MS,
  LEVEL_THRESHOLDS,
  clampLevel,
  peakOfFloat,
  peakOfBytes,
  classifyLevel,
  levelPercent,
  createSampleWindow,
  deviceErrorCode,
  preflightActions,
  createPreflight,
  summarizeCapture
} = require('../shared/audio-preflight')

function laneSnapshot(status) {
  return JSON.parse(JSON.stringify(status))
}

// ---------------------------------------------------------------------------
// level rules
// ---------------------------------------------------------------------------

test('clampLevel keeps a meter inside 0..1 and rejects junk', () => {
  assert.equal(clampLevel(0), 0)
  assert.equal(clampLevel(-0.5), 0)
  assert.equal(clampLevel(0.25), 0.25)
  assert.equal(clampLevel(1), 1)
  assert.equal(clampLevel(4), 1)
  for (const junk of [Number.NaN, Number.POSITIVE_INFINITY, 'loud', null, undefined, {}]) {
    assert.equal(clampLevel(junk), 0, `${String(junk)} is not a level`)
  }
})

test('peakOfFloat/peakOfBytes take the loudest sample, not the average', () => {
  assert.equal(peakOfFloat([0, 0, 0]), 0)
  assert.equal(peakOfFloat([0.1, -0.6, 0.2]), 0.6)
  assert.equal(peakOfFloat([2, -3]), 1, 'a sample beyond full scale clamps')
  // A single NaN must not poison the whole buffer (getFloatTimeDomainData on a
  // suspended context can hand one back).
  assert.equal(peakOfFloat([Number.NaN, 0.3, Number.NaN]), 0.3)
  for (const junk of [null, undefined, 42, 'abc', {}]) {
    assert.equal(peakOfFloat(junk), 0)
    assert.equal(peakOfBytes(junk), 0)
  }
  // 8-bit time-domain data is unsigned around 128.
  assert.equal(peakOfBytes(new Uint8Array([128, 128, 128])), 0)
  assert.equal(peakOfBytes(new Uint8Array([128, 192, 64])), 0.5)
  assert.equal(peakOfBytes(new Uint8Array([0, 255])), 1)
})

test('classifyLevel has inclusive thresholds at the documented peaks', () => {
  assert.equal(LEVEL_THRESHOLDS.silent, 0.01)
  assert.equal(LEVEL_THRESHOLDS.low, 0.08)
  assert.equal(classifyLevel(0), 'silent')
  assert.equal(classifyLevel(0.0099), 'silent')
  // Exactly at the boundary counts as audible: a quiet-but-real input must not be
  // reported as "no sound".
  assert.equal(classifyLevel(0.01), 'low')
  assert.equal(classifyLevel(0.0799), 'low')
  assert.equal(classifyLevel(0.08), 'good')
  assert.equal(classifyLevel(0.9), 'good')
})

test('levelPercent is a bounded, monotonic meter width', () => {
  assert.equal(levelPercent(0), 0)
  assert.equal(levelPercent(1), 100)
  assert.equal(levelPercent(-3), 0)
  assert.equal(levelPercent(5), 100)
  let previous = -1
  for (const peak of [0, 0.001, 0.01, 0.05, 0.1, 0.3, 0.6, 1]) {
    const percent = levelPercent(peak)
    assert.ok(Number.isInteger(percent) && percent >= 0 && percent <= 100)
    assert.ok(percent >= previous, 'the meter may not shrink as the peak grows')
    previous = percent
  }
  // The scale is perceptual, not linear: speech-level peaks must not park the bar
  // in the first fifth.
  assert.ok(levelPercent(0.1) > 25)
})

// ---------------------------------------------------------------------------
// the five-second sampling window
// ---------------------------------------------------------------------------

test('the sample window can never exceed the five-second budget', () => {
  assert.equal(SAMPLE_BUDGET_MS, 5000)
  assert.equal(SAMPLE_INTERVAL_MS, 100)
  const window = createSampleWindow({ startedAt: 1000, durationMs: 60_000 })
  assert.equal(window.durationMs, SAMPLE_BUDGET_MS)
  assert.equal(window.deadline, 6000)
  assert.equal(window.expired(5999), false)
  assert.equal(window.expired(6000), true, 'the deadline is inclusive')
  assert.equal(window.expired(9999), true)
  assert.equal(window.remaining(1000), 5000)
  assert.equal(window.remaining(3000), 3000)
  assert.equal(window.remaining(9000), 0)
  assert.equal(window.elapsed(9000), 5000)
  assert.equal(window.progress(3500), 0.5)
})

test('a shorter window is honoured and a junk one falls back to the full budget', () => {
  const short = createSampleWindow({ startedAt: 0, durationMs: 1200 })
  assert.equal(short.durationMs, 1200)
  assert.equal(short.expired(1199), false)
  assert.equal(short.expired(1200), true)
  for (const junk of [0, -5, 'soon', null, undefined, Number.NaN]) {
    const window = createSampleWindow({ startedAt: 0, durationMs: junk })
    assert.equal(window.durationMs, SAMPLE_BUDGET_MS, `${String(junk)} must not shorten the sample`)
  }
  // No clock supplied means "start at 0", never NaN deadlines.
  assert.equal(createSampleWindow().startedAt, 0)
  assert.equal(createSampleWindow().deadline, SAMPLE_BUDGET_MS)
})

test('the next tick never overshoots the deadline', () => {
  const window = createSampleWindow({ startedAt: 0, durationMs: 5000 })
  assert.equal(window.nextDelay(0), SAMPLE_INTERVAL_MS)
  assert.equal(window.nextDelay(4000, 200), 200)
  // 60 ms left: the tick waits 60, not 200, then the window is over.
  assert.equal(window.nextDelay(4940, 200), 60)
  assert.equal(window.nextDelay(6000, 200), 0)
  // Junk intervals fall back to the documented default, and a negative one is
  // floored instead of turning into a busy loop.
  assert.equal(window.nextDelay(0, 0), SAMPLE_INTERVAL_MS)
  assert.equal(window.nextDelay(0, Number.NaN), SAMPLE_INTERVAL_MS)
  assert.equal(window.nextDelay(0, -5), 10)
})

// ---------------------------------------------------------------------------
// device errors -> prompt codes
// ---------------------------------------------------------------------------

test('DOMException names map onto actionable prompt codes per lane', () => {
  assert.equal(deviceErrorCode({ name: 'NotAllowedError' }), 'microphone-denied')
  assert.equal(deviceErrorCode({ name: 'SecurityError' }), 'microphone-denied')
  assert.equal(deviceErrorCode({ name: 'NotFoundError' }), 'microphone-missing')
  assert.equal(deviceErrorCode({ name: 'OverconstrainedError' }), 'microphone-missing')
  assert.equal(deviceErrorCode({ name: 'NotReadableError' }), 'microphone-busy')
  assert.equal(deviceErrorCode({ name: 'AbortError' }), 'microphone-busy')
  assert.equal(deviceErrorCode({ name: 'DeviceLost' }), 'microphone-lost')
  // The system lane has no "missing device": the Windows mix is virtual, so the two
  // "not there" reasons collapse into one prompt.
  assert.equal(deviceErrorCode({ name: 'NotFoundError' }, 'system'), 'system-unavailable')
  assert.equal(deviceErrorCode({ name: 'NotReadableError' }, 'system'), 'system-unavailable')
  assert.equal(deviceErrorCode({ name: 'NotAllowedError' }, 'system'), 'system-denied')
  assert.equal(deviceErrorCode({ name: 'DeviceLost' }, 'system'), 'system-lost')
  // Unknown lanes fall back to the microphone (the stricter prompt).
  assert.equal(deviceErrorCode({ name: 'NotFoundError' }, 'speaker'), 'microphone-missing')
  assert.equal(deviceErrorCode({ name: 'WeirdError' }), 'microphone-failed')
})

test('an error without a known name is classified from its message', () => {
  assert.equal(deviceErrorCode({ message: 'Permission denied by system' }), 'microphone-denied')
  assert.equal(deviceErrorCode({ message: 'Requested device not found' }), 'microphone-missing')
  assert.equal(deviceErrorCode({ message: 'Could not start audio source' }), 'microphone-busy')
  assert.equal(deviceErrorCode({ message: 'bluetooth device disconnected' }), 'microphone-lost')
  assert.equal(deviceErrorCode({ message: 'something else' }), 'microphone-failed')
  assert.equal(deviceErrorCode(null), 'microphone-failed')
  assert.equal(deviceErrorCode('DeviceLost'), 'microphone-lost')
})

// ---------------------------------------------------------------------------
// executable prompt actions
// ---------------------------------------------------------------------------

test('a refused microphone always offers the three executable actions', () => {
  assert.deepEqual(preflightActions('microphone-denied'), [
    'open-microphone-settings',
    'record-system-only',
    'record-silent'
  ])
  // A surface without a shell channel drops only the action it cannot perform.
  assert.deepEqual(preflightActions('microphone-denied', { openSettings: false }), [
    'record-system-only',
    'record-silent'
  ])
  // Silence is a prompt too: "no sound" and "refused" need the same three ways out.
  assert.deepEqual(preflightActions('microphone-silent'), [
    'open-microphone-settings',
    'record-system-only',
    'record-silent'
  ])
  // A system-mix failure offers what a microphone-only recorder can still do.
  assert.deepEqual(preflightActions('system-unavailable'), ['record-microphone-only', 'record-silent'])
  assert.deepEqual(preflightActions('system-silent'), ['record-microphone-only', 'record-silent'])
  assert.deepEqual(preflightActions('system-failed'), ['record-microphone-only', 'record-silent'])
  // An unexplained open failure still needs a way out that works without a mic.
  assert.deepEqual(preflightActions('microphone-failed'), [
    'open-microphone-settings',
    'record-system-only',
    'record-silent'
  ])
  // No prompt, no invented action.
  assert.deepEqual(preflightActions(''), [])
  assert.deepEqual(preflightActions(undefined), [])
  assert.deepEqual(preflightActions('nonsense-code'), [])
})

// ---------------------------------------------------------------------------
// the state machine: "0 device opens before the click"
// ---------------------------------------------------------------------------

function createClock(start = 1000) {
  let now = start
  return {
    now: () => now,
    advance(ms) { now += ms; return now }
  }
}

test('a fresh preflight has opened nothing and cannot open anything', () => {
  const preflight = createPreflight({ now: () => 0 })
  const status = preflight.status()
  assert.equal(status.phase, 'idle')
  assert.equal(status.active, false)
  assert.equal(status.requests, 0)
  assert.equal(status.opens, 0, 'no device may be opened before the user clicks')
  assert.equal(preflight.canOpen('microphone'), false)
  assert.equal(preflight.canOpen('system'), false)
  // Even a stray call is refused and does not count as an open.
  assert.equal(preflight.noteOpen('microphone'), false)
  assert.equal(preflight.noteOpen('system'), false)
  assert.equal(preflight.status().opens, 0)
  // Nothing can be sampled or finished before a run exists either.
  assert.equal(preflight.sample('microphone', 0.5), false)
  assert.equal(preflight.startSampling(), false)
  assert.equal(preflight.finish(), false)
  assert.equal(preflight.cancel(), false)
  assert.equal(preflight.markReleased(), false)
})

test('begin() opens exactly the lanes it was asked for, once each', () => {
  const clock = createClock(2000)
  const preflight = createPreflight({ now: clock.now })
  assert.equal(preflight.begin({}), false, 'a run with no source is not a run')
  assert.equal(preflight.status().requests, 0)

  assert.equal(preflight.begin({ microphone: true }), true)
  let status = preflight.status()
  assert.equal(status.phase, 'requesting')
  assert.equal(status.requests, 1)
  assert.equal(preflight.canOpen('microphone'), true)
  assert.equal(preflight.canOpen('system'), false, 'the system lane was not requested')
  assert.equal(preflight.noteOpen('system'), false)
  assert.equal(preflight.noteOpen('microphone'), true)
  assert.equal(preflight.noteOpen('microphone'), false, 'one device open per lane per run')
  status = preflight.status()
  assert.equal(status.opens, 1)
  assert.equal(status.lanes.microphone.opened, true)
  // A second begin() while the run is live is refused instead of opening more devices.
  assert.equal(preflight.begin({ system: true, microphone: true }), false)
  assert.equal(preflight.status().opens, 1)
  assert.equal(preflight.status().requests, 1)
})

test('both lanes can be opened once, and the run stays cancellable', () => {
  const clock = createClock(0)
  const preflight = createPreflight({ now: clock.now })
  assert.equal(preflight.begin({ system: true, microphone: true }), true)
  assert.equal(preflight.noteOpen('system'), true)
  assert.equal(preflight.noteOpen('microphone'), true)
  assert.equal(preflight.status().opens, 2)
  assert.equal(preflight.isActive(), true)
  assert.equal(preflight.cancel(10), true)
  assert.equal(preflight.isActive(), false)
  assert.equal(preflight.status().phase, 'cancelled')
  assert.equal(preflight.status().opens, 2, 'cancelling never hides the devices that were opened')
  // The released-at bookkeeping only starts once a run has ended.
  assert.equal(preflight.markReleased(20), true)
})

test('sampling records the peak per lane and keeps it monotonic', () => {
  const clock = createClock(0)
  const preflight = createPreflight({ now: clock.now })
  preflight.begin({ system: true, microphone: true })
  preflight.noteOpen('system')
  preflight.noteOpen('microphone')
  assert.equal(preflight.sample('microphone', 0.5), false, 'samples only count after startSampling')
  assert.equal(preflight.startSampling(), true)
  assert.equal(preflight.startSampling(), false)
  assert.equal(preflight.sample('microphone', 0.02), true)
  assert.equal(preflight.sample('microphone', 0.4), true)
  assert.equal(preflight.sample('microphone', 0.05), true)
  // An unrequested lane ignores samples instead of inventing a level.
  assert.equal(preflight.sample('something', 0.9), false)
  const status = preflight.status()
  assert.equal(status.lanes.microphone.peak, 0.4)
  assert.equal(status.lanes.microphone.sampled, 3)
  assert.equal(status.lanes.microphone.level, 'good')
  assert.equal(status.lanes.system.sampled, 0)
  assert.equal(status.lanes.system.level, 'silent')
})

test('a five-second run ends with a silent lane prompt, not a harmless blank', () => {
  const clock = createClock(1000)
  const preflight = createPreflight({ now: clock.now })
  preflight.begin({ microphone: true })
  preflight.noteOpen('microphone')
  preflight.startSampling()
  // Real speech peak: no prompt.
  for (let index = 0; index < 10; index += 1) preflight.sample('microphone', 0.2)
  assert.equal(preflight.status().promptCode, '')
  assert.deepEqual(preflight.status().actions, [])
  assert.equal(preflight.remaining(2000), 4000)
  assert.equal(preflight.expired(5999), false)
  assert.equal(preflight.expired(6000), true, 'the run cannot outlive the budget')

  // A muted microphone: the peak never leaves the noise floor.
  const muted = createPreflight({ now: () => 0 })
  muted.begin({ microphone: true })
  muted.noteOpen('microphone')
  muted.startSampling()
  for (let index = 0; index < 10; index += 1) muted.sample('microphone', 0.0004)
  const status = muted.status()
  assert.equal(status.lanes.microphone.level, 'silent')
  assert.equal(status.promptCode, 'microphone-silent')
  assert.deepEqual(status.actions, ['open-microphone-settings', 'record-system-only', 'record-silent'])
})

test('a device error outranks a silent lane and names the reason', () => {
  const preflight = createPreflight({ now: () => 0 })
  preflight.begin({ system: true, microphone: true })
  assert.equal(preflight.noteOpen('system'), true)
  assert.equal(preflight.failLane('system', { name: 'NotAllowedError' }), 'system-denied')
  // A lane that was never requested never produces a code.
  const idle = createPreflight({ now: () => 0 })
  idle.begin({ microphone: true })
  assert.equal(idle.failLane('system', { name: 'NotAllowedError' }), '')
  assert.equal(preflight.promptCode(), 'system-denied')
  assert.deepEqual(preflight.status().actions, ['record-microphone-only', 'record-silent'])
  // A failed lane is reported as silent (nothing was measured), and the error wins.
  assert.equal(preflight.status().lanes.system.level, 'silent')
  assert.equal(preflight.status().lanes.system.code, 'system-denied')
  // A pre-classified code may be passed through as a string.
  const second = createPreflight({ now: () => 0 })
  second.begin({ microphone: true })
  assert.equal(second.failLane('microphone', 'microphone-busy'), 'microphone-busy')
  assert.equal(second.promptCode(), 'microphone-busy')
})

test('an unplugged device is a lost lane, and the run still finishes', () => {
  const clock = createClock(0)
  const preflight = createPreflight({ now: clock.now })
  preflight.begin({ system: true, microphone: true })
  preflight.noteOpen('system')
  preflight.noteOpen('microphone')
  preflight.startSampling()
  preflight.sample('system', 0.3)
  preflight.sample('microphone', 0.4)
  // Bluetooth headset pulled out mid-check: the track ends, the code says so.
  preflight.failLane('microphone', { name: 'DeviceLost' })
  assert.equal(preflight.promptCode(), 'microphone-lost')
  assert.equal(preflight.finish('done', 5000), true)
  const status = preflight.status()
  assert.equal(status.phase, 'done')
  assert.equal(status.endedAt, 5000)
  assert.equal(status.lanes.microphone.level, 'silent', 'a lost lane measured nothing')
  assert.equal(status.lanes.system.level, 'good', 'the other lane keeps its measurement')
})

// ---------------------------------------------------------------------------
// release budget
// ---------------------------------------------------------------------------

test('releasing the tracks reports the one-second budget honestly', () => {
  assert.equal(RELEASE_BUDGET_MS, 1000)
  const clock = createClock(10_000)
  const preflight = createPreflight({ now: clock.now })
  preflight.begin({ microphone: true })
  preflight.noteOpen('microphone')
  preflight.startSampling()
  preflight.finish('done', 15_000)
  assert.equal(preflight.markReleased(15_400), true, 'released 0.4 s after the sample')
  assert.equal(preflight.status().releasedWithinBudget, true)
  assert.equal(preflight.status().releasedAt, 15_400)

  const slow = createPreflight({ now: () => 0 })
  slow.begin({ microphone: true })
  slow.finish('done', 1000)
  assert.equal(slow.markReleased(2500), false, 'a two-second release is late')
  assert.equal(slow.status().releasedWithinBudget, false)

  const never = createPreflight({ now: () => 0 })
  never.begin({ microphone: true })
  assert.equal(never.markReleased(5), false, 'a release before the run ended does not count')
})

test('status() is a snapshot, not a handle on the live run', () => {
  const preflight = createPreflight({ now: () => 0 })
  preflight.begin({ microphone: true })
  const status = laneSnapshot(preflight.status())
  status.lanes.microphone.peak = 0.9
  status.opens = 99
  assert.equal(preflight.status().opens, 0)
  assert.equal(preflight.status().lanes.microphone.peak, 0)
})

test('a finished run can start again and resets every lane', () => {
  const clock = createClock(0)
  const preflight = createPreflight({ now: clock.now })
  preflight.begin({ system: true, microphone: true })
  preflight.noteOpen('microphone')
  preflight.failLane('microphone', { name: 'NotAllowedError' })
  preflight.finish('done', 1)
  preflight.markReleased(2)
  assert.equal(preflight.begin({ microphone: true }), true)
  const status = preflight.status()
  assert.equal(status.phase, 'requesting')
  assert.equal(status.requests, 2, 'runs are counted over the session')
  assert.equal(status.opens, 1, 'the open counter is cumulative: it is the "no click, no device" counter')
  assert.equal(status.lanes.microphone.opened, false, 'the new run starts with closed lanes')
  assert.equal(status.lanes.microphone.code, '')
  assert.equal(status.lanes.system.requested, false)
  assert.equal(status.releasedAt, 0)
})

// ---------------------------------------------------------------------------
// the capture summary
// ---------------------------------------------------------------------------

test('the summary names the system mix and never pretends window mode is isolated', () => {
  const window = summarizeCapture({ mode: 'window', sourceName: 'Meeting', system: true, microphone: true, microphoneLabel: 'USB mic' })
  assert.equal(window.mode, 'window')
  assert.equal(window.source.name, 'Meeting')
  assert.equal(window.system.enabled, true)
  assert.equal(window.system.scope, 'system-mix')
  assert.equal(window.system.includesOtherApps, true)
  assert.equal(window.system.windowNote, true, 'window mode must warn that other apps are in the mix')
  assert.equal(window.microphone.enabled, true)
  assert.equal(window.microphone.deviceLabel, 'USB mic')

  const display = summarizeCapture({ mode: 'display', system: true, microphone: false })
  assert.equal(display.system.scope, 'system-mix')
  assert.equal(display.system.windowNote, false)
  assert.equal(display.microphone.enabled, false)

  // The whole object is JSON-safe and contains no "window only" claim in any field
  // (a later copy change must not be able to reintroduce one unnoticed).
  const json = JSON.stringify(window).toLowerCase()
  for (const forbidden of ['window-only', 'windowonly', 'only-window', 'this-window']) {
    assert.equal(json.includes(forbidden), false, `the summary must not claim ${forbidden}`)
  }

  const muted = summarizeCapture({ mode: 'region', system: false, microphone: false })
  assert.equal(muted.system.enabled, false)
  assert.equal(muted.microphone.enabled, false)
  assert.equal(muted.mode, 'region')

  // Unknown modes/computed input degrade to a display capture, not to a crash.
  assert.equal(summarizeCapture().mode, 'display')
  assert.equal(summarizeCapture({ mode: 'bogus' }).mode, 'display')
  assert.equal(summarizeCapture({ mode: 'window', system: false }).system.windowNote, false)
  assert.equal(summarizeCapture({ system: true, loopback: false }).system.loopback, false)
})

test('the lane list is frozen and only contains the two real lanes', () => {
  assert.deepEqual(LANES, ['system', 'microphone'])
  assert.equal(Object.isFrozen(LANES), true)
})
